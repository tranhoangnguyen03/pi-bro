/** Regressions from review of #179. No model, network or repository execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { stage, apply } from '../resources/architecture-docs/scripts/pipeline.mjs';
import { layoutGraph } from '../resources/architecture-docs/scripts/layout.mjs';

const graph = { project: { name: 'Fixture', summary: 'Runs the input.' }, nodes: [{ id: 'main', label: 'Main', description: 'Processes input.', sources: ['main.js'] }], edges: [] };
const proposal = (files = {}, g = graph) => ({ files: { 'README.md': '# Current architecture\n\n[Map](architecture.html)\n', ...files }, graph: g, summary: 'Source-backed fixture.', unknowns: [] });
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bro-architecture-review-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'main.js'), 'export const main = input => input;\n');
  const put = async (relative, text) => { const f = path.join(root, relative); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, text); };
  const capture = async options => { const state = await stage(root, options); t.after(() => fs.rm(state.dir, { recursive: true, force: true })); return state; };
  const run = async (state, doc = proposal(), options) => { const f = path.join(state.dir, 'answer.json'); await fs.writeFile(f, JSON.stringify(doc)); return apply(state.dir, f, options); };
  return { root, put, capture, run };
}

test('refresh resolves omitted images/PDF/large assets without copying them into model context', async t => {
  const f = await fixture(t), png = Buffer.from([137, 80, 78, 71, 0, 1]), pdf = Buffer.from('%PDF-1.7\0binary');
  await f.put('docs/architecture/legacy.md', '# Legacy\n![Design](design.png)\n[Spec](../../spec.pdf)\n[Large](../../large.txt)\n');
  await f.put('docs/architecture/design.png', png); await f.put('spec.pdf', pdf); await f.put('large.txt', 'x'.repeat(2048));
  const state = await f.capture({ maxFileBytes: 1024 });
  await assert.rejects(fs.stat(path.join(state.workspace, 'docs/architecture/design.png')), { code: 'ENOENT' });
  await f.run(state);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'docs/architecture/design.png')), png);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'spec.pdf')), pdf);
  assert.match(await fs.readFile(path.join(f.root, 'docs/architecture/legacy.md'), 'utf8'), /Design/);
});

test('Markdown code spans/fences and Mermaid syntax are not document links', async t => {
  const f = await fixture(t);
  await f.put('docs/architecture/legacy.md', '# Legacy\n`handlers[action](ctx)`\n``table[key](input)``\n```js\nitems[key](fake)\n```\n~~~js\nitems[key](fake2)\n~~~\n');
  await f.put('docs/architecture/old.mmd', 'flowchart TD\n  A["dispatch[cmd](arg)"]\n');
  await f.run(await f.capture());
  assert.match(await fs.readFile(path.join(f.root, 'docs/architecture/legacy.md'), 'utf8'), /handlers/);
});

test('real broken links, staging-only references and symlink escapes still fail', async t => {
  for (const [name, files, g, expected] of [
    ['missing', { 'README.md': '# Map\n[Missing](missing.md)' }, graph, /Broken link/],
    ['helper link', { 'README.md': '# Map\n[Helper](../../.bro-architecture-support/references/project-patterns.md)' }, graph, /temporary architecture support/],
    ['helper source', {}, { ...graph, nodes: [{ ...graph.nodes[0], sources: ['.bro-architecture-support/references/project-patterns.md'] }] }, /temporary architecture support/],
    ['bad URL', { 'README.md': '# Map\n[Bad](bad%xy.md)' }, graph, /Invalid URL.*docs\/architecture\/README.md/],
    ['escape', { 'README.md': '# Map\n[Escape](../../../outside.txt)' }, graph, /Unsafe/],
  ]) {
    await t.test(name, async t => { const f = await fixture(t); await assert.rejects(f.run(await f.capture(), proposal(files, g)), expected); await assert.rejects(fs.stat(path.join(f.root, 'docs/architecture/README.md')), { code: 'ENOENT' }); });
  }
  await t.test('asset symlink', async t => {
    const f = await fixture(t); await f.put('outside.txt', 'not allowed through a link');
    await fs.symlink(path.join(f.root, 'outside.txt'), path.join(f.root, 'alias.txt'));
    await assert.rejects(f.run(await f.capture(), proposal({ 'README.md': '# Map\n[Alias](../../alias.txt)' })), /Broken link|symlink/);
  });
});

test('architecture docs get budget first, and oversized generated HTML keeps its baseline', async t => {
  const f = await fixture(t);
  await f.put('aaa.txt', 'a'.repeat(600));
  await f.put('docs/architecture/README.md', '# Existing useful guide\n');
  await f.put('docs/architecture/architecture.html', 'old HTML'.repeat(200));
  const state = await f.capture({ maxTotalBytes: 128, maxFileBytes: 1024 });
  assert.match(await fs.readFile(path.join(state.workspace, 'docs/architecture/README.md'), 'utf8'), /Existing/);
  await assert.rejects(fs.stat(path.join(state.workspace, 'docs/architecture/architecture.html')), { code: 'ENOENT' });
  const record = JSON.parse(await fs.readFile(path.join(state.dir, 'state.json'), 'utf8'));
  assert.ok(record.documents.some(d => d.path === 'docs/architecture/architecture.html'));
  await f.run(state);
  assert.match(await fs.readFile(path.join(f.root, 'docs/architecture/architecture.html'), 'utf8'), /graph-data/);
});

test('no directory creation through staged or live symlinked output ancestors', async t => {
  for (const which of ['staged', 'live']) await t.test(which, async t => {
    const f = await fixture(t), state = await f.capture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'bro-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    const root = which === 'staged' ? state.workspace : f.root;
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.symlink(outside, path.join(root, 'docs/architecture'), 'dir');
    await assert.rejects(f.run(state, proposal({ 'nested/guide.md': '# Additional guide\n' })), /symlink/);
    assert.deepEqual(await fs.readdir(outside), []);
  });
});

test('new docs respect umask and refresh preserves an existing file mode', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await f.run(await f.capture());
  const file = path.join(f.root, 'docs/architecture/README.md');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o666 & ~process.umask());
  await fs.chmod(file, 0o640);
  await f.run(await f.capture(), proposal({ 'README.md': '# Changed guide\n' }));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
});

test('cancellation before, after first, and after last replacement restores all original docs', async t => {
  for (const at of [0, 1, 3]) await t.test('replacement ' + at, async t => {
    const f = await fixture(t); await f.run(await f.capture());
    const docs = path.join(f.root, 'docs/architecture'), names = await fs.readdir(docs);
    const before = new Map(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(docs, name))])));
    const state = await f.capture(), controller = new AbortController(); let count = 0;
    const rename = fs.rename;
    t.mock.method(fs, 'rename', async (from, to) => {
      await rename(from, to);
      if (to.startsWith(docs + path.sep) && ++count === at) controller.abort();
    });
    if (!at) controller.abort();
    const changed = { ...graph, project: { ...graph.project, summary: 'Changed summary' } };
    await assert.rejects(f.run(state, proposal({ 'README.md': '# Changed guide\n' }, changed), { signal: controller.signal }), { name: 'AbortError' });
    for (const [name, bytes] of before) assert.deepEqual(await fs.readFile(path.join(docs, name)), bytes, name);
    assert.deepEqual((await fs.readdir(docs)).sort(), names.sort(), 'No temp files remain');
  });
});

test('a failed replacement rolls back earlier writes without rewriting unrelated docs', async t => {
  const f = await fixture(t); await f.run(await f.capture());
  const docs = path.join(f.root, 'docs/architecture'), old = await fs.readFile(path.join(docs, 'README.md'));
  const state = await f.capture(), rename = fs.rename; let failed = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!failed && to === path.join(docs, 'architecture.graph.json')) { failed = true; throw new Error('injected import failure'); }
    return rename(from, to);
  });
  const changed = { ...graph, project: { ...graph.project, summary: 'Changed summary' } };
  await assert.rejects(f.run(state, proposal({ 'README.md': '# Changed guide\n' }, changed)), /injected import failure/);
  assert.deepEqual(await fs.readFile(path.join(docs, 'README.md')), old);
});

test('cycles retain downstream ranks, compact columns, and route feedback outside boxes', () => {
  const nodes = ['root', 'a', 'b', 'sink', 'other', 'self'].map(id => ({ id, label: id }));
  const edges = [{ from: 'root', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'b', to: 'sink' }, { from: 'self', to: 'self' }];
  const map = layoutGraph(nodes, edges), p = map.positions;
  assert.equal(p.root.column, 0); assert.equal(p.a.column, 1); assert.equal(p.b.column, 1); assert.equal(p.sink.column, 2); assert.equal(p.self.column, 0);
  assert.deepEqual([...new Set(Object.values(p).map(n => n.column))].sort(), [0, 1, 2]);
  for (const i of [1, 2, 4]) {
    assert.equal(map.routes[i].rotation, -90);
    assert.ok(map.routes[i].labelX > p[edges[i].from].x + map.nodeWidth);
  }
  assert.notEqual(map.routes[1].labelX, map.routes[2].labelX, 'Feedback links get separate lanes');
});

test('inventory CLI runs from a path with spaces without Git stderr in a non-Git project', async t => {
  const f = await fixture(t), spaced = path.join(f.root, 'tool with spaces');
  await fs.mkdir(spaced); const tool = path.join(spaced, 'inventory.mjs');
  await fs.copyFile(new URL('../resources/architecture-docs/scripts/inventory.mjs', import.meta.url), tool);
  const output = spawnSync(process.execPath, [tool, f.root], { encoding: 'utf8' });
  assert.equal(output.status, 0);
  assert.equal(output.stderr, '');
  assert.ok(JSON.parse(output.stdout).files > 0);
});
