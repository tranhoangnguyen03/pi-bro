import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { listProjectFiles, inventory, localPath } from './inventory.mjs';
import { validateGraph, safeRelative, render } from './render.mjs';
import { check } from './check.mjs';

const exec=promisify(execFile);
const CURRENT=path.dirname(fileURLToPath(import.meta.url));
const RESOURCES=path.resolve(CURRENT,'..');
const MAX_FILE=1024*1024,MAX_TOTAL=80*1024*1024,MAX_FILES=25000;
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const inside=(root,name)=>name===root||name.startsWith(root+path.sep);
const skip=/((^|\/)\.env($|\.)|(^|\/)auth\.json$|(^|\/)credentials(?:\.[^/]*)?$|\.pem$|\.key$|id_rsa$|id_ed25519$)/i;

async function projectRoot(cwd){
  const current=await fs.realpath(path.resolve(cwd));
  try{
    const {stdout}=await exec('git',['-C',current,'rev-parse','--show-toplevel'],{timeout:5000});
    const resolved=await fs.realpath(path.resolve(stdout.trim()));
    if(inside(resolved,current))return resolved;
  }catch{}
  return current;
}
async function describeRevision(root){
  try{const {stdout}=await exec('git',['-C',root,'rev-parse','--short=12','HEAD'],{timeout:5000});
  return 'Commit '+stdout.trim()+' (with working files when present)';}
  catch{return 'Local project snapshot';}
}
function cancelled(signal) { signal?.throwIfAborted(); }
async function hashFile(file, signal) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of createReadStream(file)) { cancelled(signal); hash.update(bytes); }
  return hash.digest('hex');
}
async function stage(cwd, { signal, maxFileBytes = MAX_FILE, maxTotalBytes = MAX_TOTAL } = {}) {
  cancelled(signal);
  const root = await projectRoot(cwd), paths = listProjectFiles(root);
  if (!paths.length) throw new Error('No non-ignored project files were found in ' + root);
  if (paths.length > MAX_FILES) throw new Error('Too many input files (' + paths.length + '); narrow the workspace first');
  // Existing docs get first use of the model budget. Their baseline is independent
  // of that budget, including large generated HTML and binary assets left in place.
  paths.sort((a, b) => Number(b.startsWith('docs/architecture/')) - Number(a.startsWith('docs/architecture/')) || a.localeCompare(b));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-bro-architecture-'));
  const workspace = path.join(dir, 'project'), files = [], omitted = [], documents = [];
  let used = 0;
  try {
    await fs.mkdir(workspace, { recursive: true });
    for (const relative of paths) {
      cancelled(signal);
      if (skip.test(relative) || relative.startsWith('.bro-architecture-support/')) continue;
      const source = localPath(root, relative);
      const stat = await fs.lstat(source);
      if (!stat.isFile()) continue;
      const isDoc = relative.startsWith('docs/architecture/');
      if (isDoc) documents.push({ path: relative, sha: await hashFile(source, signal), mode: stat.mode & 0o777 });
      if (stat.size > maxFileBytes || used + stat.size > maxTotalBytes) { omitted.push(relative + ' (size or snapshot budget)'); continue; }
      const bytes = await fs.readFile(source);
      if (bytes.includes(0)) { omitted.push(relative + ' (binary)'); continue; }
      used += bytes.length;
      const dest = path.join(workspace, relative);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, bytes, { mode: 0o600 });
      files.push({ path: relative, sha: digest(bytes) });
    }
    if (!files.length) throw new Error('No readable source files were found');
    const support = path.join(workspace, '.bro-architecture-support');
    await fs.mkdir(support, { recursive: true });
    await fs.cp(path.join(RESOURCES, 'references'), path.join(support, 'references'), { recursive: true });
    const information = { root, dir, workspace, files, documents, knownFiles: paths, omitted, revision: await describeRevision(root), inventory: inventory(root, files.map(f => f.path)) };
    cancelled(signal);
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(information), { mode: 0o600 });
    cancelled(signal);
    return { root, dir, workspace, inventory: information.inventory, omitted: omitted.slice(0, 40), included: files.length };
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}
function parseProposal(text){
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>2*1024*1024)throw new Error('Model output is missing or too large');
  let source=text.trim();
  if(source.startsWith('```'))source=source.replace(/^```(?:json)?\s*\n?/i,'').replace(/\n?```\s*$/,'');
  let value;try{value=JSON.parse(source);}catch{throw new Error('Architecture model did not return a single valid JSON proposal; re-run to try again');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Architecture proposal must be an object');
  if(!value.files||typeof value.files!=='object'||Array.isArray(value.files)||!Object.hasOwn(value.files,'README.md'))throw new Error('Proposal needs files.README.md');
  if(typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>10000)throw new Error('Proposal needs a short summary');
  if(!Array.isArray(value.unknowns)||value.unknowns.length>100||value.unknowns.some(x=>typeof x!=='string'||x.length>1000))throw new Error('Invalid unknowns');
  validateGraph(value.graph);
  if(Object.keys(value.files).length>80)throw new Error('Too many generated files');
  let bytes=0;
  for(const [relative,content] of Object.entries(value.files)){
    safeRelative(relative,'output');
    if(!(/\.md$|\.mmd$/i.test(relative))||relative.startsWith('diagrams/')&& !relative.endsWith('.mmd')||['architecture.graph.json','architecture.html'].includes(relative))throw new Error('Output must be Markdown or Mermaid: '+relative);
    if(typeof content!=='string'||!content.trim())throw new Error('Empty documentation file: '+relative);
    bytes+=Buffer.byteLength(content);
    if(bytes>1024*1024)throw new Error('Generated documentation exceeds 1 MiB');
  }
  if(!value.files['README.md'].includes('architecture.html'))value.files['README.md']+='\n\n[Explore the architecture map](architecture.html)\n';
  return value;
}
async function stagedInputsAgree(state, signal) {
  for (const original of state.files) {
    cancelled(signal);
    const file = localPath(state.workspace, original.path);
    let hash; try { hash = await hashFile(file, signal); } catch (error) { cancelled(signal); throw new Error('Staged source was removed: ' + original.path); }
    if (hash !== original.sha) throw new Error('Staged source was modified during inspection: ' + original.path);
  }
}
async function originalsAgree(state, signal) {
  const originals = new Map([...state.files, ...(state.documents || [])].map(f => [f.path, f]));
  for (const original of originals.values()) {
    cancelled(signal);
    const file = localPath(state.root, original.path);
    let hash; try { hash = await hashFile(file, signal); } catch (error) { cancelled(signal); throw new Error('Source changed during documentation: ' + original.path); }
    if (hash !== original.sha) throw new Error('Source changed during documentation: ' + original.path + '. Re-run to document the new revision.');
  }
}
async function prepareChanges(state, proposal, signal) {
  const docs = localPath(state.workspace, 'docs/architecture');
  await fs.mkdir(docs, { recursive: true });
  const files = { ...proposal.files };
  const graph = { ...proposal.graph, project: { ...proposal.graph.project, revision: state.revision || 'Local project snapshot' } };
  files['architecture.graph.json'] = JSON.stringify(graph, null, 2) + '\n';
  for (const [relative, text] of Object.entries(files)) {
    cancelled(signal);
    const target = localPath(state.workspace, 'docs/architecture/' + relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text, { mode: 0o600 });
  }
  localPath(state.workspace, 'docs/architecture/architecture.html');
  render(state.workspace);
  files['architecture.html'] = await fs.readFile(path.join(docs, 'architecture.html'), 'utf8');
  check(state.workspace, { repositoryRoot: state.root, knownFiles: state.knownFiles });
  cancelled(signal);
  return files;
}
async function install(state, files, signal) {
  const root = state.root, docs = localPath(root, 'docs/architecture');
  await originalsAgree(state, signal);
  const originals = new Map((state.documents || state.files).map(f => [f.path, f]));
  const previous = new Map(), pending = [];
  for (const [relative, text] of Object.entries(files)) {
    cancelled(signal);
    safeRelative(relative, 'output');
    const target = localPath(root, 'docs/architecture/' + relative);
    let old = null, mode;
    try { old = await fs.readFile(target); mode = (await fs.stat(target)).mode & 0o777; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const original = originals.get('docs/architecture/' + relative);
    if (original) {
      if (!old || digest(old) !== original.sha) throw new Error('Architecture document changed during generation: ' + relative);
    } else if (old) throw new Error('New architecture document appeared during generation: ' + relative);
    previous.set(relative, { bytes: old, mode });
    if (!old || old.toString('utf8') !== text) pending.push({ relative, text, target });
  }
  const completed = [], temporaries = [];
  try {
    for (const item of pending) {
      cancelled(signal);
      localPath(root, 'docs/architecture/' + item.relative);
      await fs.mkdir(path.dirname(item.target), { recursive: true });
      const tmp = item.target + '.bro-' + crypto.randomUUID() + '.tmp';
      temporaries.push(tmp);
      // New public docs use the normal umask; refresh keeps the existing mode.
      await fs.writeFile(tmp, item.text, { flag: 'wx' });
      const before = previous.get(item.relative);
      if (before.mode !== undefined) await fs.chmod(tmp, before.mode);
    }
    for (let i = 0; i < pending.length; i++) {
      cancelled(signal);
      const item = pending[i], before = previous.get(item.relative).bytes;
      localPath(root, 'docs/architecture/' + item.relative);
      let live = null; try { live = await fs.readFile(item.target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if ((before === null) !== (live === null) || (before && live && !before.equals(live))) throw new Error('Architecture docs changed during import: ' + item.relative);
      await fs.rename(temporaries[i], item.target);
      completed.push(item);
      // In-process cancellation throws here, then waits for rollback. It never
      // kills the importer between a rename and recording what must be restored.
      cancelled(signal);
    }
    cancelled(signal);
    return completed.map(item => 'docs/architecture/' + item.relative);
  } catch (error) {
    const failures = [];
    for (const item of completed.reverse()) {
      try {
        localPath(root, 'docs/architecture/' + item.relative);
        const live = await fs.readFile(item.target);
        if (!live.equals(Buffer.from(item.text))) throw new Error('Another writer changed this document');
        const before = previous.get(item.relative);
        if (before.bytes === null) await fs.rm(item.target);
        else {
          const tmp = item.target + '.bro-' + crypto.randomUUID() + '.tmp';
          temporaries.push(tmp);
          await fs.writeFile(tmp, before.bytes, { flag: 'wx' });
          await fs.chmod(tmp, before.mode);
          await fs.rename(tmp, item.target);
        }
      } catch { failures.push(item.relative); }
    }
    if (failures.length) throw new Error(error.message + '; rollback was incomplete for ' + failures.join(', '));
    throw error;
  } finally {
    for (const tmp of temporaries) await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
async function apply(dir, proposalPath, { signal } = {}) {
  cancelled(signal);
  const state = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
  if (state.dir !== path.resolve(dir)) throw new Error('Snapshot identity mismatch');
  const proposal = parseProposal(await fs.readFile(proposalPath, 'utf8'));
  await stagedInputsAgree(state, signal);
  const files = await prepareChanges(state, proposal, signal);
  const updated = await install(state, files, signal);
  return { root: state.root, updated, summary: proposal.summary, unknowns: proposal.unknowns, nodes: proposal.graph.nodes.length };
}
export {stage,parseProposal,apply};
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const command=process.argv[2];
  try{
    if(command==='prepare')console.log(JSON.stringify(await stage(process.argv[3]||'.')));
    else if(command==='apply')console.log(JSON.stringify(await apply(path.resolve(process.argv[3]),path.resolve(process.argv[4]))));
    else throw new Error('Use prepare <repo> or apply <snapshot-dir> <proposal.json>');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
