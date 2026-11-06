import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { stage, parseProposal, apply } from '../resources/architecture-docs/scripts/pipeline.mjs';
import { renderGraph, validateGraph } from '../resources/architecture-docs/scripts/render.mjs';

const graph={
  project:{name:'Tiny CLI',summary:'Turns input into a result.'},
  nodes:[
    {id:'cli',label:'Command',description:'Reads input and starts the run.',kind:'entry',sources:['src/main.js']},
    {id:'result',label:'Result',description:'Reports the checked result.',kind:'output',sources:['src/main.js']}
  ],
  edges:[{from:'cli',to:'result',label:'reports output'}],
  flows:[{id:'run',label:'Normal run',steps:['cli','result']}]
};
const proposal=(body='# Tiny CLI\n\n[Map](architecture.html)\n')=>JSON.stringify({
  files:{'README.md':body},
  graph,summary:'This CLI reports a result.',unknowns:[]
});
async function setup(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bro-arch-test-'));
  await fs.mkdir(path.join(root,'src'),{recursive:true});
  await fs.writeFile(path.join(root,'src','main.js'),'export function run() { return "ok"; }\n');
  await fs.writeFile(path.join(root,'README.md'),'# Tiny CLI\n');
  return root;
}
async function cleanup(root,staged){if(staged)await fs.rm(staged.dir,{recursive:true,force:true});await fs.rm(root,{recursive:true,force:true});}

test('creates a validated offline architecture map without touching source',async()=>{
  const root=await setup();let staged;
  try{
    staged=await stage(root);assert.ok(staged.included>0);
    const json=path.join(staged.dir,'answer.json');await fs.writeFile(json,proposal());
    const result=await apply(staged.dir,json);
    assert.ok(result.updated.includes('docs/architecture/README.md'));
    assert.ok(result.updated.includes('docs/architecture/architecture.html'));
    const html=await fs.readFile(path.join(root,'docs/architecture/architecture.html'),'utf8');
    assert.match(html,/id="graph-data"/);assert.match(html,/connect-src 'none'/);
    assert.match(html,/Command/);assert.match(html,/Search components/);
    assert.equal(await fs.readFile(path.join(root,'src/main.js'),'utf8'),'export function run() { return "ok"; }\n');
  }finally{await cleanup(root,staged);}
});

test('refreshes a guide in place and preserves unrelated architecture material',async()=>{
  const root=await setup();let first,second;
  try{
    first=await stage(root);const p=path.join(first.dir,'proposal.json');await fs.writeFile(p,proposal());
    await apply(first.dir,p);
    const docs=path.join(root,'docs','architecture');
    await fs.writeFile(path.join(docs,'decisions.md'),'# Historical decision\n\nKeep this.\n');
    second=await stage(root);
    const p2=path.join(second.dir,'proposal.json');
    await fs.writeFile(p2,proposal('# Tiny CLI\n\nThis is the revised guide.\n'));
    const result=await apply(second.dir,p2);
    assert.ok(result.updated.includes('docs/architecture/README.md'));
    assert.equal(await fs.readFile(path.join(docs,'decisions.md'),'utf8'),'# Historical decision\n\nKeep this.\n');
    assert.match(await fs.readFile(path.join(docs,'README.md'),'utf8'),/architecture\.html/);
  }finally{await cleanup(root,first);if(second)await fs.rm(second.dir,{recursive:true,force:true});}
});

test('refuses concurrent source changes and leaves target docs untouched',async()=>{
  const root=await setup();let staged;
  try{
    staged=await stage(root);
    await fs.writeFile(path.join(root,'src','main.js'),'export function run() { return "changed"; }\n');
    const p=path.join(staged.dir,'proposal.json');await fs.writeFile(p,proposal());
    await assert.rejects(apply(staged.dir,p),/Source changed during documentation/);
    await assert.rejects(fs.stat(path.join(root,'docs','architecture','README.md')),{code:'ENOENT'});
  }finally{await cleanup(root,staged);}
});

test('refuses concurrent doc changes without replacing human edits',async()=>{
  const root=await setup();let staged;
  try{
    await fs.mkdir(path.join(root,'docs','architecture'),{recursive:true});
    await fs.writeFile(path.join(root,'docs','architecture','README.md'),'# Human draft\n');
    staged=await stage(root);
    await fs.writeFile(path.join(root,'docs','architecture','README.md'),'# Human edited while Bro ran\n');
    const p=path.join(staged.dir,'proposal.json');await fs.writeFile(p,proposal());
    await assert.rejects(apply(staged.dir,p),/Source changed during documentation|Architecture document changed/);
    assert.equal(await fs.readFile(path.join(root,'docs','architecture','README.md'),'utf8'),'# Human edited while Bro ran\n');
  }finally{await cleanup(root,staged);}
});

test('rejects output traversal, unsafe links and malformed graph references',()=>{
  assert.throws(()=>parseProposal(JSON.stringify({files:{'README.md':'# fine','../outside.md':'no'},graph,summary:'s',unknowns:[]})),/Unsafe/);
  assert.throws(()=>validateGraph({...graph,edges:[{from:'cli',to:'missing',label:'unknown'}]}),/missing node/);
  const hostile={...graph,project:{name:'</script><script>alert(1)</script>',summary:'Safe'}};
  const html=renderGraph('{}',hostile);
  assert.ok(!html.includes('</script><script>alert(1)</script>'));
  assert.ok(html.includes('\\\\u003c/script'));
});
