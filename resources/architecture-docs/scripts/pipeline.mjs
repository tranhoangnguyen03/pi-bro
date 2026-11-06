import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { listProjectFiles, inventory } from './inventory.mjs';
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
async function safeParents(root,relative){
  let cursor=root;
  for(const part of relative.split('/')){
    cursor=path.join(cursor,part);
    try{const st=await fs.lstat(cursor);if(st.isSymbolicLink())throw new Error('Refusing symlink: '+cursor);}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
}
async function stage(cwd){
  const root=await projectRoot(cwd),paths=listProjectFiles(root);
  if(!paths.length)throw new Error('No non-ignored project files were found in '+root);
  if(paths.length>MAX_FILES)throw new Error('Too many input files ('+paths.length+'); narrow the workspace first');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-bro-architecture-'));
  const workspace=path.join(dir,'project');
  const files=[],omitted=[];
  let used=0;
  try{
    await fs.mkdir(workspace,{recursive:true});
    for(const relative of paths){
      if(skip.test(relative)||relative.startsWith('.bro-architecture-support/'))continue;
      const source=path.join(root,relative);
      let stat;
      try{stat=await fs.lstat(source);}catch{continue;}
      if(!stat.isFile()||stat.size>MAX_FILE){omitted.push(relative+' (not a readable small file)');continue;}
      const physical=await fs.realpath(source);
      if(!inside(root,physical)){omitted.push(relative+' (outside root)');continue;}
      const bytes=await fs.readFile(source);
      if(bytes.includes(0)||used+bytes.length>MAX_TOTAL){omitted.push(relative+' (binary or budget)');continue;}
      used+=bytes.length;
      const dest=path.join(workspace,relative);
      await fs.mkdir(path.dirname(dest),{recursive:true});
      await fs.writeFile(dest,bytes,{mode:0o600});
      files.push({path:relative,sha:digest(bytes)});
    }
    if(!files.length)throw new Error('No readable source files were found');
    const support=path.join(workspace,'.bro-architecture-support');
    await fs.mkdir(support,{recursive:true});
    await fs.cp(path.join(RESOURCES,'references'),path.join(support,'references'),{recursive:true});
    const information={root,dir,workspace,files,omitted,inventory:inventory(root,files.map(f=>f.path))};
    await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(information),{mode:0o600});
    return {root,dir,workspace,inventory:information.inventory,omitted:omitted.slice(0,40),included:files.length};
  }catch(e){await fs.rm(dir,{recursive:true,force:true});throw e;}
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
async function stagedInputsAgree(state){
  for(const original of state.files){
    const file=path.join(state.workspace,original.path);
    let bytes;try{bytes=await fs.readFile(file);}catch{throw new Error('Staged source was removed: '+original.path);}
    if(digest(bytes)!==original.sha)throw new Error('Staged source was modified during inspection: '+original.path);
  }
}
async function originalsAgree(state){
  for(const original of state.files){
    const live=path.join(state.root,original.path);
    let current;try{current=await fs.readFile(live);}catch{throw new Error('Source changed during documentation: '+original.path);}
    if(digest(current)!==original.sha)throw new Error('Source changed during documentation: '+original.path+'. Re-run to document the new revision.');
  }
}
async function prepareChanges(state,proposal){
  const docs=path.join(state.workspace,'docs','architecture');
  await fs.mkdir(docs,{recursive:true});
  const files={...proposal.files};
  const graph={...proposal.graph,project:{...proposal.graph.project,revision:'Snapshot of '+state.root}};
  files['architecture.graph.json']=JSON.stringify(graph,null,2)+'\n';
  for(const [relative,text] of Object.entries(files)){
    const target=path.join(docs,relative);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await safeParents(docs,relative);
    await fs.writeFile(target,text,{mode:0o600});
  }
  render(state.workspace);
  files['architecture.html']=await fs.readFile(path.join(docs,'architecture.html'),'utf8');
  check(state.workspace);
  return files;
}
async function install(state,files){
  const root=state.root,docs=path.join(root,'docs','architecture');
  // Verify every original before making any change; refuse symlinked ancestors and targets.
  await safeParents(root,'docs/architecture');
  await originalsAgree(state);
  const previous=new Map(),pending=[];
  for(const [relative,text] of Object.entries(files)){
    safeRelative(relative,'output');
    await safeParents(root,'docs/architecture/'+relative);
    const target=path.join(docs,relative);
    let old=null;
    try{old=await fs.readFile(target);}catch(e){if(e.code!=='ENOENT')throw e;}
    const snapshotPath=path.join(state.workspace,'docs','architecture',relative);
    let copied=null;
    try{copied=await fs.readFile(snapshotPath);}catch(e){if(e.code!=='ENOENT')throw e;}
    // The stage contains the target as it was when the model started.
    // For newly generated files, the stage may now have generated content: consult the
    // original hashes from state, not the stage's current contents.
    const original=state.files.find(f=>f.path==='docs/architecture/'+relative);
    if(original){
      if(!old||digest(old)!==original.sha)throw new Error('Architecture document changed during generation: '+relative);
    }else if(old)throw new Error('New architecture document appeared during generation: '+relative);
    previous.set(relative,old);
    if(!old||old.toString('utf8')!==text)pending.push({relative,text,target});
  }
  if(!pending.length)return [];
  const completed=[],temporaries=[];
  try{
    for(const item of pending){
      await fs.mkdir(path.dirname(item.target),{recursive:true});
      const tmp=item.target+'.bro-'+crypto.randomUUID()+'.tmp';
      temporaries.push(tmp);
      await fs.writeFile(tmp,item.text,{mode:0o600});
    }
    // All proposed contents now exist in temporary files. Recheck target state
    // immediately before each rename. Never replay a stale proposal.
    for(let i=0;i<pending.length;i++){
      const item=pending[i],before=previous.get(item.relative);
      let live=null;try{live=await fs.readFile(item.target);}catch(e){if(e.code!=='ENOENT')throw e;}
      if((before===null)!==(live===null)||(before&&live&&!before.equals(live)))throw new Error('Architecture docs changed during import: '+item.relative);
      await fs.rename(temporaries[i],item.target);
      completed.push(item);
    }
    return completed.map(item=>'docs/architecture/'+item.relative);
  }catch(e){
    const failures=[];
    for(const item of completed.reverse()){
      try{
        const before=previous.get(item.relative);
        if(before===null)await fs.rm(item.target,{force:true});
        else await fs.writeFile(item.target,before);
      }catch(err){failures.push(item.relative);}
    }
    if(failures.length)throw new Error(e.message+'; rollback was incomplete for '+failures.join(', '));
    throw e;
  }finally{
    for(const tmp of temporaries)await fs.rm(tmp,{force:true}).catch(()=>{});
  }
}
async function apply(dir,proposalPath){
  const state=JSON.parse(await fs.readFile(path.join(dir,'state.json'),'utf8'));
  if(state.dir!==path.resolve(dir))throw new Error('Snapshot identity mismatch');
  const output=await fs.readFile(proposalPath,'utf8');
  const proposal=parseProposal(output);
  await stagedInputsAgree(state);
  const files=await prepareChanges(state,proposal);
  const updated=await install(state,files);
  return {root:state.root,updated,summary:proposal.summary,unknowns:proposal.unknowns,nodes:proposal.graph.nodes.length};
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
