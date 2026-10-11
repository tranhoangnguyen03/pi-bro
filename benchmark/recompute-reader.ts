import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { scoreSaved } from './reader.ts';
const dir=new URL('./evidence/reader-shipped/',import.meta.url);
const load=async(name:string)=>JSON.parse(await readFile(new URL(name,dir),'utf8'));
const manifest=await load('manifest.json');
const {fingerprint,...content}=manifest;
assert.equal(createHash('sha256').update(JSON.stringify(content)).digest('hex'),fingerprint);
const rows: (ReturnType<typeof scoreSaved> & {caseId:string;mode:string;audience:string;repeat:number})[]=[];let tokens=0;
for(const row of manifest.rows){
 const generation=await load(`${row.id}.generate.json`),judge=await load(`${row.id}.judge.json`);
 const evaluation=scoreSaved(row,manifest,generation,judge);
 if(judge.body)tokens+=JSON.parse(judge.body).usage?.input_tokens??0;
 rows.push({caseId:row.caseId,mode:row.mode,audience:row.audience,repeat:row.repeat,...evaluation});
}
const summary={fingerprint,outputs:rows.length,decisions:rows.reduce((n,r)=>n+Object.keys(r.checks).length,0),
 mechanicalMismatchOutputs:rows.filter(r=>Object.values(r.mechanical).includes(false)).length,
 formatDeviationOutputs:rows.filter(r=>Object.values(r.format).includes(false)).length,
 judgeMismatchDecisions:rows.reduce((n,r)=>n+Object.values(r.checks).filter(v=>!v).length,0),inputTokens:tokens,
 meanWords:Object.fromEntries(['brief','balanced','faithful','btw'].map(mode=>{const values=rows.filter(r=>r.mode===mode);return [mode,Number((values.reduce((n,r)=>n+r.descriptive.words,0)/values.length).toFixed(1))];})),rows};
const rendered=JSON.stringify(summary,null,2)+'\n';
if(process.argv.includes('--write'))await writeFile(new URL('summary.json',dir),rendered);
else assert.equal(await readFile(new URL('summary.json',dir),'utf8'),rendered,'Committed summary drift: review, then recompute with --write');
console.log(`${summary.outputs} outputs; ${summary.decisions} decisions; ${summary.judgeMismatchDecisions} judge mismatches; ${summary.formatDeviationOutputs} format deviations`);
