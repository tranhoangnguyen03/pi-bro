import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateReader, generatorSettings } from './reader-backend.ts';
import { prepare } from './reader.ts';
test('Claude adapter executes once, maps success/failure, and stops on timeout or active cancellation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reader-fake-'));const old=process.env.PATH;process.env.PATH=dir+':'+old;
 try{
  for(const mode of ['success','error','timeout','cancel']){
   const log=join(dir,'calls');await writeFile(log,'');
   const body=mode==='success'?`printf '%s\\n' '${JSON.stringify({type:'result',subtype:'success',is_error:false,stop_reason:'end_turn',terminal_reason:'completed',result:'answer'})}'`:mode==='error'?'echo failure >&2; exit 1':'sleep 10';
   await writeFile(join(dir,'claude'),`#!/bin/sh\necho call >> '${log}'\n${body}\n`);await chmod(join(dir,'claude'),0o755);
   const c=new AbortController();const pending=generateReader({...row,timeoutMs:mode==='timeout'?100:2000},'hello',c.signal,'claude');
   let timer:ReturnType<typeof setTimeout>|undefined;if(mode==='cancel')timer=setTimeout(()=>c.abort(),100);
   const result=await pending;if(timer)clearTimeout(timer);
   assert.equal(result.outcome,mode==='cancel'?'cancelled':mode);assert.equal(result.backend,'claude');assert.equal(result.callId,row.callId);
   if(mode==='success')assert.equal(result.output,'answer');
   assert.equal((await readFile(log,'utf8')).trim(),'call');
  }
 }finally{process.env.PATH=old;await rm(dir,{recursive:true,force:true});}
});
const row={callId:'test',fixture:'x',fixtureSha256:'x',variant:'brief',promptSha256:'x',model:'test',effort:'low',timeoutMs:50};
test('backend selection is fingerprinted, rejects unknown backends and honors pre-cancellation offline',async()=>{
 const a=prepare(),b=prepare('shipped',{backend:'codex',model:'test',effort:'low',timeoutMs:50});
 assert.notEqual(a.fingerprint,b.fingerprint);
 assert.deepEqual(generatorSettings({model:'test',effort:'low',timeoutMs:50}),generatorSettings({backend:'agy',model:'test',effort:'low',timeoutMs:50}));
 for(const bad of [{timeoutMs:undefined},{timeoutMs:'abc'},{effort:'invalid'},{backend:'grok'}])assert.throws(()=>generatorSettings({backend:'agy',model:'test',effort:'low',timeoutMs:50,...bad}));
 assert.equal('callId' in generatorSettings({...row,callId:'evil'}),false);
 assert.throws(()=>prepare('x',{backend:'typo',model:'test',effort:'low',timeoutMs:50}));
 await assert.rejects(generateReader(row,'hello',new AbortController().signal,'typo'));
 for(const backend of ['agy','claude','codex','muse']){
  const c=new AbortController();c.abort();
  assert.equal((await generateReader(row,'hello',c.signal,backend)).outcome,'cancelled',backend);
 }
});
