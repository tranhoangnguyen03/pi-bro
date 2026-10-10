import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bro } from './test-build.mjs';

test('doctor probes each backend selected only by the review capability',async()=>{
 const directory=process.env.PI_CODING_AGENT_DIR;await mkdir(directory,{recursive:true});
 for(const backend of ['agy','claude','grok','codex','muse']) {
  const other=backend==='agy'?'claude':'agy';
  await writeFile(join(directory,'bro-settings.json'),JSON.stringify({version:2,default:{backend:other,model:'test',effort:'default'},overrides:{review:{backend,model:'test',effort:'default'}}}));
  const calls=[];const pi={getAllTools:()=>[],getActiveTools:()=>[],exec:async(command,args)=>{calls.push({command,args});throw Error('offline probe fixture');}};
  const ctx={sessionManager:{getBranch:()=>[]}};
  await bro.doctorReport(pi,ctx,new AbortController().signal);
  assert.ok(calls.some(call=>call.command===backend),`${backend} review override must be probed`);
 }
});
