// Real released-host checks; no credentials or model calls. Run with PIG_BIN set.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const root = await mkdtemp(join(tmpdir(), 'bro-pig-'));
try {
 const piDir = join(root, 'pi'); const pigDir = join(root, 'pig');
 await mkdir(piDir); await mkdir(pigDir);
 const probe = join(root,'probe.ts'); const result = join(root,'snapshot.json');
 await writeFile(probe, `import {writeFileSync} from 'node:fs';
 import {buildAdvisorSnapshot} from ${JSON.stringify(resolve('bro.ts'))};
 export default function(pi) { pi.registerCommand('snapshot-probe',{handler:(_,ctx)=>writeFileSync(${JSON.stringify(result)},JSON.stringify(buildAdvisorSnapshot(ctx,pi)))}); }`);
 const session = join(root,'session.jsonl');
 const message = (id,parentId,text) => ({type:'message',id,parentId,timestamp:new Date().toISOString(),message:{role:'user',content:text,timestamp:Date.now()}});
 await writeFile(session,[
  {type:'session',version:3,id:'bro-pig-test',timestamp:new Date().toISOString(),cwd:root},
  message('old',null,'OLD_CANARY'),message('kept','old','KEPT_CANARY'),message('sibling','old','SIBLING_CANARY'),
  {type:'compaction',id:'compact',parentId:'kept',timestamp:new Date().toISOString(),summary:'SUMMARY_CANARY',firstKeptEntryId:'kept',tokensBefore:100},
  message('last','compact','LAST_CANARY')
 ].map(x=>JSON.stringify(x)).join('\n')+'\n');
 const child = spawn(process.env.PIG_BIN || 'pig', ['--offline', '--mode', 'rpc', '--session',session, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '-e', resolve('bro.ts'), '-e',probe], {
  env: {...process.env, PIG_HOME:join(root,'home'), PIG_CODING_AGENT_DIR:pigDir, PI_CODING_AGENT_DIR:piDir, PIG_USE_PI_DIRS:'0'}, stdio:['pipe','pipe','pipe']
 });
 let stderr=''; child.stderr.on('data', x => stderr += x);
 const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 const exit = new Promise((res,rej)=>{child.on('error',rej); child.on('close',(code)=>res(code));});
 let success=false;
 createInterface({input:child.stdout}).on('line', line=>{
  const event=JSON.parse(line);
  if(event.type==='response' && event.id==='mode') { success=event.success; child.stdin.write(JSON.stringify({id:'snapshot',type:'prompt',message:'/snapshot-probe'})+'\n'); }
  if(event.type==='response' && event.id==='snapshot') { success &&= event.success; child.stdin.end(); }
 });
 child.stdin.write(JSON.stringify({id:'mode',type:'prompt',message:'/bro mode faithful'})+'\n');
 const code=await exit; clearTimeout(timer);
 assert.equal(code,0,stderr); assert.ok(success,stderr);
 assert.equal(JSON.parse(await readFile(join(pigDir,'bro-settings.json'),'utf8')).mode,'faithful');
 await assert.rejects(readFile(join(piDir,'bro-settings.json')), {code:'ENOENT'});
 const snapshot=JSON.parse(await readFile(result,'utf8'));
 assert.ok(snapshot.hadCompaction);
 for(const text of ['SUMMARY_CANARY','KEPT_CANARY','LAST_CANARY','- read:','Executor\'s system instructions']) assert.ok(snapshot.text.includes(text),text);
 for(const text of ['OLD_CANARY','SIBLING_CANARY']) assert.ok(!snapshot.text.includes(text),text);
 console.log('PASS: real PiG settings isolation and advisor snapshot compaction/branch projection');
} finally {await rm(root,{recursive:true,force:true});}
