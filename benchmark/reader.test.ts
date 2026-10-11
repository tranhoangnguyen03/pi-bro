import test from 'node:test';
import assert from 'node:assert/strict';
import {prepare,request,evaluate,compare,JUDGE,scoreSaved,validateGeneration} from './reader.ts';
import {READER_CASES} from './reader-corpus.ts';
test('manifest freezes applicability and questions across arms; judge sees no key or source',()=>{
 const a=prepare('a'),b=prepare('b');assert.equal(READER_CASES.length,18);assert.equal(a.rows.length,b.rows.length);assert.notEqual(a.fingerprint,b.fingerprint);
 for(let i=0;i<a.rows.length;i++){assert.deepEqual(a.rows[i].probes,b.rows[i].probes);const r=request('candidate',a.rows[i].probes);assert.deepEqual(r.state,{output:'candidate'});assert.ok(!JSON.stringify(r).includes('"expected"'));}
});
test('polarity, missing answers, code fences, missing cells and regressions',()=>{
 const c=READER_CASES.find(c=>c.id==='trailing-condition')!;const answers=Object.fromEntries(c.probes.map(p=>[p.id,{type:'choice',choice:p.expected?'pass':'fail'}]));
 const e=evaluate(c,'balanced',c.source,c.probes,{model:JUDGE,answers});assert.ok(Object.values(e.checks).every(Boolean));
 assert.throws(()=>evaluate(c,'balanced',c.source,c.probes,{model:JUDGE,answers:{}}));
 const row={repeat:1,caseId:c.id,mode:'balanced',audience:'default',status:'complete',required:['retry_unknown'],evaluation:e};
 const bad=structuredClone(row);bad.evaluation.checks.retry_unknown=false;
 assert.equal(compare([row,{...row,repeat:2}],[bad,{...bad,repeat:2}])[0].status,'candidate-proxy-mismatch');assert.equal(compare([row],[])[0].status,'incomplete');
 const f=READER_CASES.find(c=>c.id==='markdown-code')!;assert.equal(evaluate(f,'brief','',[],null).format.exactFences,false);
});

test('mechanical v2 allows ordinary numeric variants but preserves identifiers and code',()=>{
 const c=READER_CASES.find(c=>c.id==='clear-control')!;
 assert.equal(evaluate(c,'brief',c.source.replace('seven days','7 days'),[],null).mechanical.literals,true);
 assert.equal(evaluate(c,'faithful',c.source.replace('seven days','7 days'),[],null).mechanical.literals,false);
 assert.equal(evaluate(c,'brief',c.source.replace('seven days','six days'),[],null).mechanical.literals,false);
 const f=READER_CASES.find(c=>c.id==='markdown-code')!;
 const indented=f.source.replaceAll('\n','\n   ');
 const e=evaluate(f,'brief',indented,[],null);
 assert.equal(e.mechanical.codeContent1,true);assert.equal(e.format.exactFences,false);
 assert.equal(evaluate(f,'brief',indented.replace('--mode safe','--mode unsafe'),[],null).mechanical.codeContent1,false);
});

test('saved evidence validates identities, hashes, schemas and frozen instructions',()=>{
 const m=prepare();assert.deepEqual(prepare(),m);const row=m.rows[0];
 const g={generator:m.generator,backend:'agy',outcome:'success',output:'text',callId:row.id,fixture:row.caseId,variant:row.mode,model:m.generator.model,effort:m.generator.effort};
 validateGeneration(row,g,m.generator);
 assert.throws(()=>validateGeneration(row,{...g,backend:'claude'},m.generator),/backend/);
 assert.throws(()=>validateGeneration(row,{...g,generator:{...m.generator,timeoutMs:1}},m.generator),/settings/);
 for(const field of ['callId','fixture','variant','model','effort'])assert.throws(()=>validateGeneration(row,{...g,[field]:'wrong'},m.generator));
 assert.throws(()=>validateGeneration(row,{...g,outcome:'started'},m.generator));
 assert.throws(()=>scoreSaved(row,m,g,{outputHash:'bad'}),/hash/);
 const c=READER_CASES[0];const good={model:JUDGE,answers:Object.fromEntries(row.probes.map(p=>[p.id,{type:'choice',choice:p.expected?'pass':'fail'}]))};
 for(const changed of [{...good,model:'wrong'},{...good,answers:{}},{...good,answers:{...good.answers,extra:{type:'choice',choice:'pass'}}}])assert.throws(()=>evaluate(c,row.mode,'text',row.probes,changed));
 const first=row.probes[0].id;
 for(const a of [{type:'other',choice:'pass'},{type:'choice',choice:'maybe'}])assert.throws(()=>evaluate(c,row.mode,'text',row.probes,{...good,answers:{...good.answers,[first]:a}}));
 const negative=row.probes.find(p=>!p.expected)!;assert.equal(evaluate(c,row.mode,'text',row.probes,{...good,answers:{...good.answers,[negative.id]:{type:'choice',choice:'pass'}}}).checks[negative.id],false);
});
test('compare rejects invalid repeats and exposes format regressions, fixed and unstable checks',()=>{
 const r={caseId:'x',mode:'brief',audience:'default',repeat:1,status:'complete',required:[],evaluation:{mechanical:{},format:{fence:true},checks:{term:true}}};
 const pair=(x:any)=>[x,{...x,repeat:2}];const changed=(term:boolean,fence=true)=>({...r,evaluation:{mechanical:{},format:{fence},checks:{term}}});
 assert.equal(compare(pair(r),pair(changed(true,false)))[0].status,'regressed');
 assert.equal(compare(pair(changed(false)),pair(r))[0].status,'improved-on-measured-checks');
 assert.equal(compare(pair(r),[r,{...changed(false),repeat:2}])[0].status,'inconclusive');
 assert.equal(compare([{...r,repeat:3},{...r,repeat:4}],pair(r))[0].status,'incomplete');
 assert.throws(()=>compare(pair(r),pair({...r,required:['term']})),/applicability/);
});
