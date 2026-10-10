import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDir } from './test-build.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const review=await import(pathToFileURL(join(buildDir,'review.js')).href);
const ui=await import(pathToFileURL(join(buildDir,'review-modal.js')).href);
const old={summary:'Old',topics:[{id:'topic-1',title:'Same title',explanation:'Old explanation',evidence:[]}]};
test('replacement keeps one guide and private target context without inheriting old identities',()=>{
 const record={guide:structuredClone(old),snapshot:{capturedAt:'then',diff:'captured',files:[],target:{}},turns:[{target:'topic-1',question:'old question'}],ui:ui.newReviewView()};
 record.ui.selected='topic-1';record.ui.screen='discussion';record.ui.target='topic-1';record.ui.drafts['topic-1']='old draft';record.ui.offsets['overview:reading:']=8;
 review.replaceGuide(record,structuredClone(old));const first=record.guide.topics[0].id;
 assert.notEqual(first,'topic-1');assert.equal(record.ui.selected,'questions');assert.equal(record.ui.screen,'discussion');assert.equal(record.ui.offsets['overview:reading:'],0);
 assert.equal(record.ui.drafts['topic-1'],'old draft');assert.match(record.targetContexts['topic-1'].text,/Old explanation/);
 review.replaceGuide(record,structuredClone(old));assert.notEqual(record.guide.topics[0].id,first);assert.equal(record.guideVersions,undefined);assert.equal(record.pendingGuideId,undefined);
 const across={guide:old,turns:[],ui:{...ui.newReviewView(),selected:'across'}};review.replaceGuide(across,old);assert.equal(across.ui.selected,'overview');
 assert.equal(record.turns[0].target,'topic-1');assert.match(review.buildReviewPrompt(record,'Question','topic-1'),/old question|Old explanation/);
});
test('legacy version records migrate to one current guide without rewriting on read',async()=>{
 const root=join(buildDir,'version-records');await mkdir(root);
 const record={version:1,id:'e'.repeat(64),snapshot:{target:{head:'head',base:'base',repository:'a/b'},mergeBase:'base',gitDir:root,checkout:root,files:[],diff:'immutable diff'},guide:old,guideVersions:[{id:'old',createdAt:'before',guide:old},{id:'new',createdAt:'after',guide:{summary:'New',topics:[{id:'new-topic',title:'New title',explanation:'New explanation',evidence:[]}]}}],activeGuideId:'old',pendingGuideId:'new',turns:[{target:'topic-1',question:'secret old question',answer:'answer',status:'complete'}],ui:ui.newReviewView()};
 record.ui.selected='findings';record.ui.screen='finding';record.ui.target='obsolete';record.ui.drafts['whole review']='';record.guideVersions[0].view={...ui.newReviewView(),drafts:{'topic-1':'old draft','whole review':'important draft'}};
 await review.saveReview(root,record);const path=join(root,record.id+'.json'),raw=await readFile(path,'utf8');
 const loaded=await review.loadReview(root,record.id);assert.equal(loaded.guide.summary,'New');assert.equal(loaded.guideVersions,undefined);assert.equal(loaded.activeGuideId,undefined);assert.equal(loaded.ui.selected,'overview');assert.equal(loaded.ui.screen,'reading');assert.equal(loaded.ui.drafts['whole review'],'important draft');assert.equal(loaded.ui.drafts['topic-1'],'old draft');assert.match(loaded.targetContexts['topic-1'].text,/Old explanation/);assert.equal(await readFile(path,'utf8'),raw);
 await review.saveReview(root,loaded);assert.ok(!JSON.parse(await readFile(path,'utf8')).guideVersions);
 for(const mutate of [r=>r.pendingGuideId='missing',r=>r.guide={...r.guide,summary:'inconsistent'},r=>r.guideVersions[0].view={selected:'bad'},r=>r.guideVersions.push({...r.guideVersions[0],id:'different'})]){
  const copy=structuredClone(record);mutate(copy);await writeFile(path,JSON.stringify(copy));await assert.rejects(review.loadReview(root,record.id),/Damaged|Inconsistent/);
 }
 const wrongLegacy={...record,targetContexts:'oops'};await writeFile(path,JSON.stringify(wrongLegacy));await assert.rejects(review.loadReview(root,record.id),/Damaged discussion context/);
 const invalidTopic=structuredClone(loaded);invalidTopic.guide.topics[0].evidence=[{path:'a',side:'new',start:0,end:1,valid:true}];await writeFile(path,JSON.stringify(invalidTopic));await assert.rejects(review.loadReview(root,record.id),/evidence/);
 const corrupt={...loaded,targetContexts:{bad:{title:1,text:'bad'}}};await writeFile(path,JSON.stringify(corrupt));await assert.rejects(review.loadReview(root,record.id),/context/);
});
