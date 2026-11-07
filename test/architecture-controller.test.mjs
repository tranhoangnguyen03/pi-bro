/** The real controller/backend/modal path, with a deterministic CLI and no model calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { buildDir, settings } from './test-build.mjs';
import { withFakeExecutable } from './test-fake-exec.ts';

// Mirror the shipped src/ + resources/ layout without changing shared test-build.
const runtime = join(buildDir, 'architecture-runtime');
await fs.mkdir(join(runtime, 'src'), { recursive: true });
await fs.copyFile(join(buildDir, 'architecture.js'), join(runtime, 'src/architecture.js'));
for (const name of ['backend', 'settings', 'explain-modal']) await fs.symlink(join(buildDir, name + '.js'), join(runtime, 'src', name + '.js'));
await fs.symlink(fileURLToPath(new URL('../resources', import.meta.url)), join(runtime, 'resources'), 'dir');
const { generateArchitecture, openArchitectureDocs } = await import(pathToFileURL(join(runtime, 'src/architecture.js')).href);
const { createConfigNavigationModal } = await import(pathToFileURL(join(buildDir, 'config-navigation-ui.js')).href);
const { CONFIG_FEATURES } = await import(pathToFileURL(join(buildDir, 'config-navigation.js')).href);
initTheme();
const doc = { files: { 'README.md': '# Checked architecture\n' }, graph: { project: { name: 'Fixture', summary: 'Runs a command.' }, nodes: [{ id: 'main', label: 'Main', description: 'Runs the command.', sources: ['main.js'] }], edges: [] }, summary: 'Command fixture.', unknowns: [] };
function cli(response) {
  return [
    '#!/usr/bin/env node',
    "const fs=require('node:fs'),path=require('node:path');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>prompt+=x);",
    "process.stdin.on('end',()=>{fs.writeFileSync(path.join(process.env.BIN_DIR,'observed.json'),JSON.stringify({prompt,cwd:process.cwd(),args:process.argv.slice(2)}));",
    'console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,stop_reason:"end_turn",terminal_reason:"completed",result:' + JSON.stringify(response) + '}));});',
  ].join('\n');
}
const config = { backend: 'agy', model: 'unused', effort: 'low', mode: 'balanced', showTurns: 1, overrides: { btw: { backend: 'claude', model: 'architecture-test', effort: 'default' } } };
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(buildDir, 'project-')));
  await fs.writeFile(join(root, 'main.js'), 'export const main=()=>1;');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await settings.writeSettings(config);
  return root;
}

test('controller uses BTW-selected inspection, imports docs and exposes existing browser/preferences controls', async t => {
  const root = await fixture(t);
  await fs.writeFile(settings.PREFERENCES_FILE, 'Use plain language.');
  await withFakeExecutable('claude', cli(JSON.stringify(doc)), async bin => {
    const result = await generateArchitecture({ cwd: root }, '', new AbortController().signal);
    const call = JSON.parse(await fs.readFile(join(bin, 'observed.json'), 'utf8'));
    assert.notEqual(call.cwd, root);
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'architecture-test');
    assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Grep,Glob');
    assert.ok(!call.args.includes('--dangerously-skip-permissions'));
    assert.ok(call.prompt.includes('architecture-docs'));
    assert.equal(result.htmlPath, join(root, 'docs/architecture/architecture.html'));
    assert.equal(result.preferences, true);
    assert.match(await fs.readFile(result.htmlPath, 'utf8'), /graph-data/);
    await assert.rejects(fs.stat(call.cwd), { code: 'ENOENT' }, 'The source copy is cleaned after settlement');
  });
});

test('closing the actual modal after a target replacement waits for rollback and reports no late success', { timeout: 20000 }, async t => {
  const root = await fixture(t), docs = join(root, 'docs/architecture');
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(join(docs, 'README.md'), '# Human guide\n');
  const notices = []; let component, closed = false, interrupted = false;
  const ctx = { cwd: root, mode: 'tui', ui: {
    notify(message) { notices.push(message); },
    custom(factory) { return new Promise(resolve => {
      component = factory({ terminal: { rows: 34, columns: 100, write() {} }, requestRender() {} }, { fg: (_c, text) => text, bold: text => text }, {}, () => { closed = true; resolve(); });
    }); },
  } };
  t.after(() => component?.handleInput('\x1b'));
  t.signal.addEventListener('abort', () => component?.handleInput('\x1b'), { once: true });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to);
    if (!interrupted && to === join(docs, 'README.md')) { interrupted = true; component.handleInput('\x1b'); }
  });
  await withFakeExecutable('claude', cli(JSON.stringify(doc)), async () => { await openArchitectureDocs(ctx, ''); });
  assert.ok(interrupted && closed);
  assert.equal(await fs.readFile(join(docs, 'README.md'), 'utf8'), '# Human guide\n');
  assert.deepEqual(await fs.readdir(docs), ['README.md']);
  assert.deepEqual(notices, []);
});

test('inspection errors name architecture, not Guided Review', async t => {
  const root = await fixture(t);
  await withFakeExecutable('claude', cli(''), async () => {
    await assert.rejects(generateArchitecture({ cwd: root }, '', new AbortController().signal), error => {
      assert.match(error.message, /architecture documentation/);
      assert.doesNotMatch(error.message, /Guided Review|guided review/);
      return true;
    });
  });
});

test('Architecture Docs config leaf explains inheritance and opens the existing BTW settings', () => {
  const state = { screen: 'features' }; let result;
  const component = createConfigNavigationModal(state, config)({ terminal: { rows: 40, columns: 100 }, requestRender() {} }, { fg: (_c, text) => text, bold: text => text }, {}, value => { result = value; });
  for (let i = 0; i < CONFIG_FEATURES.findIndex(x => x.value === 'architecture'); i++) component.handleInput('\x1b[B');
  component.handleInput('\r');
  assert.equal(state.inherited, 'architecture');
  assert.match(component.render(100).join('\n'), /inherits BTW/);
  component.handleInput('\r');
  assert.deepEqual(result, { kind: 'settings', page: 'btw' });
});
