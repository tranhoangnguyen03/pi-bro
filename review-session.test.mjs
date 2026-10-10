import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDir } from './test-build.mjs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdir, writeFile, chmod, readFile, rename, rm } from 'node:fs/promises';
import { initTheme, getAgentDir } from '@earendil-works/pi-coding-agent';
const { openGuidedReview } = await import(pathToFileURL(join(buildDir, 'review-ui.js')).href);
const { saveReview, loadReview } = await import(pathToFileURL(join(buildDir, 'review.js')).href);
initTheme();
test('saved review opens and closes without a backend call and preserves its composer', async () => {
 const id = 'a'.repeat(64);
 const root = join(getAgentDir(), 'bro-reviews');
 const record = {version:1,id,snapshot:{target:{repository:'a/b',number:1,head:'abcdef',base:'base'},mergeBase:'merge',gitDir:root,checkout:root,files:[],diff:''},turns:[],view:'guide',topic:0,offset:0,composer:'saved question',focus:''};
 await saveReview(root,record);
 let component;
 const ctx = {mode:'tui',ui:{ select:async(_title,labels)=>labels[0], custom: async(factory,options)=>new Promise(resolve=>{
   assert.equal(options.overlayOptions.width,'100%');
   component=factory({terminal:{rows:20},requestRender(){}},{fg:(_c,s)=>s,bold:s=>s}, {}, resolve);
   component.handleInput('\x1b');
 }),notify(message){assert.match(message,/Review saved privately/);}}};
 await openGuidedReview(ctx,'resume','');
 assert.equal((await loadReview(root,id)).ui.drafts['whole review'],'saved question');
 component.dispose();
});

test('resume warns about unreadable reviews but still opens a healthy one',async()=>{
 const root=join(getAgentDir(),'bro-reviews'),id='f'.repeat(64),bad=join(root,'0'.repeat(64)+'.json');
 await saveReview(root,{version:1,id,snapshot:{target:{repository:'a/b',number:9,head:'head',base:'base'},mergeBase:'base',gitDir:root,checkout:root,files:[],diff:''},turns:[],view:'guide',topic:0,offset:0,composer:'',focus:''});
 await writeFile(bad,'{bad');const notices=[];let panel;
 try {
  await openGuidedReview({mode:'tui',ui:{notify:(message,kind)=>notices.push({message,kind}),select:async(_title,labels)=>labels.find(label=>label.includes('#9')),custom:factory=>new Promise(resolve=>{panel=factory({terminal:{rows:20},requestRender(){}},{fg:(_c,s)=>s,bold:s=>s},{},resolve);panel.handleInput('\x1b');})}},'resume','');
  panel.dispose();assert.equal(notices.filter(notice=>notice.kind==='warning').length,1);assert.equal(notices[0].kind,'warning');assert.match(notices[0].message,/Original file left untouched/);assert.equal(await readFile(bad,'utf8'),'{bad');
 }finally{await rm(bad,{force:true});}
});

test('guide and contextual answer save through a fake backend then reopen without regeneration', async () => {
 const root=join(getAgentDir(),'bro-reviews');
 const id='b'.repeat(64);
 const bin=join(buildDir,'review-bin'); await mkdir(bin,{recursive:true});
 const calls=join(bin,'calls');
 await writeFile(join(bin,'agy'),`#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv.slice(2); const prompt=args[args.indexOf('--print')+1];
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({prompt,cwd:process.cwd()})+'\\n');
const response=prompt.includes('Return only JSON:')?JSON.stringify({summary:'Captured purpose',assessment:{overview:'Quality considered',inspected:[],notExamined:['Tests not run'],warnings:[],findings:[{title:'Failure recovery gap',kind:'test-gap',severity:'medium',topic:0,scenario:'Save fails',impact:'Recovery untested',reasoning:'No test supplied',uncertainty:'Static review',fix:'Add recovery test',check:'Assert state retained',evidence:[]}]},topics:[{title:'Behavior',explanation:'Captured explanation',evidence:[]}]}):'A contextual answer';
console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response,conversation_id:'fake-review'}}));
`); await chmod(join(bin,'agy'),0o755);
 const oldPath=process.env.PATH; process.env.PATH=`${bin}:${oldPath}`;
 await writeFile(join(getAgentDir(),'bro-settings.json'),JSON.stringify({version:2,default:{backend:'agy',model:'test',effort:'default'}}));
 const record={version:1,id,snapshot:{target:{repository:'a/b',number:2,head:'abcdef',base:'base'},mergeBase:'merge',gitDir:root,checkout:bin,files:[],diff:'captured diff'},turns:[],view:'guide',topic:0,offset:0,composer:'Why this behavior?',focus:''};
 await saveReview(root,record);
 let component;
 let resolveClosed;
 let capturedError;
 const waitFor=async predicate=>{for(let i=0;i<1500;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out waiting for saved review');};
 const ctx={mode:'tui',ui:{select:async(_title,labels)=>labels.find(label=>label.includes('#2')),notify(){},custom:async factory=>new Promise(resolve=>{
  resolveClosed=resolve;
  component=factory({terminal:{rows:32},requestRender(){}},{fg:(_c,s)=>s,bold:s=>s},{},resolve);
  void(async()=>{
   component.handleInput('\r'); component.handleInput('\r'); component.handleInput('\r');
   await waitFor(async()=>Boolean((await loadReview(root,id)).guide));
   component.handleInput('\x1b');component.handleInput('\x1b[B');component.handleInput('\x1b[B');component.handleInput('\r');component.handleInput('\r');
   assert.match(component.render(103).join('\n'),/Failure recovery gap/);component.handleInput('\x1b');component.handleInput('\x1b');component.handleInput('\x1b[A');component.handleInput('\r');
   component.handleInput('\r');component.handleInput('\x1b[B');component.handleInput('\r');component.handleInput('Why this behavior?');component.handleInput('\r');
   await waitFor(async()=>(await loadReview(root,id)).turns[0]?.status==='complete');
   component.handleInput('\x1b'); component.handleInput('\x1b'); component.handleInput('\x1b');
  })().catch(error=>{capturedError=error;resolve();});
 })}};
 try {
  await openGuidedReview(ctx,'resume','Reader prefs');
  if(capturedError)throw capturedError;
  component.dispose();
  const saved=await loadReview(root,id);
  assert.equal(saved.guide.summary,'Captured purpose'); assert.equal(saved.turns[0].answer,'A contextual answer');assert.equal(saved.guide.assessment.findings[0].title,'Failure recovery gap');
  const requests=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.length,2); assert.match(requests[1].prompt,/topic-1/); assert.match(requests[1].prompt,/Captured explanation/);
  assert.match(requests[0].prompt,/Reader prefs/);
  saved.ui.selected='findings';saved.ui.screen='finding';saved.ui.target=saved.guide.assessment.findings[0].id;saved.ui.pane='contents';await saveReview(root,saved);
  const reopen={mode:'tui',ui:{...ctx.ui,custom:async factory=>new Promise(resolve=>{
    const restored=factory({terminal:{rows:20},requestRender(){}},{fg:(_c,s)=>s,bold:s=>s},{},resolve);
    assert.ok(restored.render(60).join('\n').includes('Behavior'));
    assert.match(restored.render(103).join('\n'),/Failure recovery gap/);
    restored.handleInput('\x1b');
  })}};
  await openGuidedReview(reopen,'resume','Reader prefs');
  assert.equal((await readFile(calls,'utf8')).trim().split('\n').length,2,'reopen does not invoke backend');
 } finally { process.env.PATH=oldPath; resolveClosed?.(); }
});

test('successful evidence reload clears a previous transient read error',async()=>{
 const root=join(getAgentDir(),'bro-reviews'),id='e'.repeat(64),bin=join(buildDir,'evidence-bin'),counter=join(bin,'reads');
 await mkdir(bin,{recursive:true});await writeFile(join(bin,'git'),`#!/usr/bin/env node
const fs=require('node:fs');const path=${JSON.stringify(counter)};
const count=fs.existsSync(path)?Number(fs.readFileSync(path,'utf8')):0;fs.writeFileSync(path,String(count+1));
if(!count){console.error('transient read error');process.exit(1);}setTimeout(()=>console.log('recovered source'),150);
`);await chmod(join(bin,'git'),0o755);
 await saveReview(root,{version:1,id,snapshot:{target:{repository:'a/b',number:5,head:'head',base:'base'},mergeBase:'base',gitDir:bin,checkout:bin,files:[],diff:''},turns:[],guide:{summary:'Ready',topics:[{id:'topic-1',title:'Behavior',explanation:'Detail',evidence:[]}],assessment:{overview:'Risk',inspected:[],notExamined:[],warnings:[],findings:[{id:'finding-1',title:'Issue',kind:'risk',severity:'low',scenario:'Trigger',impact:'Impact',reasoning:'Reason',uncertainty:'Static',fix:'Fix',check:'Check',evidence:[{path:'file.ts',side:'new',start:1,end:1,valid:true}]}]}},view:'guide',topic:0,offset:0,composer:'',focus:''});
 const oldPath=process.env.PATH;process.env.PATH=`${bin}:${oldPath}`;let component,resolveOpen;
 const ctx={mode:'tui',ui:{notify(){},select:async(_t,labels)=>labels.find(label=>label.includes('#5')),custom:factory=>new Promise(resolve=>{resolveOpen=resolve;component=factory({terminal:{rows:32},requestRender(){}},{fg:(_c,s)=>s,bold:s=>s},{},resolve);})}};
 const waitFor=async fn=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('evidence reload timed out: '+component.render(103).join('\n'));};
 try {
  const opened=openGuidedReview(ctx,'resume','');await waitFor(()=>component);
  component.handleInput('\x1b[B');component.handleInput('\x1b[B');component.handleInput('\r');component.handleInput('\r');component.handleInput('\x1b[6~');component.handleInput('\x1b[6~');await waitFor(()=>component.render(103).join('\n').includes('transient read error'));
  component.handleInput('\r');
  // A second entry while the retry is in flight shares that read.
  component.handleInput('\x1b');component.handleInput('\r');component.handleInput('\x1b[6~');component.handleInput('\x1b[6~');
  await waitFor(()=>component.render(103).join('\n').includes('recovered source'));
  assert.doesNotMatch(component.render(103).join('\n'),/transient read error|Captured code unavailable/);
  component.handleInput('\x1b');component.handleInput('\r');
  await new Promise(resolve=>setTimeout(resolve,250));assert.equal(await readFile(counter,'utf8'),'2','cached or in-flight evidence is not reread');
  component.handleInput('\x1b');component.handleInput('\x1b');component.handleInput('\x1b');await opened;component.dispose();
 }finally{process.env.PATH=oldPath;resolveOpen?.();component?.dispose();}
});

test('stop-and-close waits for real process cancellation; save failure keeps modal open',async()=>{
 const root=join(getAgentDir(),'bro-reviews'),id='c'.repeat(64),bin=join(buildDir,'stop-bin');
 await mkdir(bin,{recursive:true});
 await writeFile(join(bin,'agy'),'#!/usr/bin/env node\nsetInterval(()=>{},1000);\n');await chmod(join(bin,'agy'),0o755);
 const oldPath=process.env.PATH;process.env.PATH=`${bin}:${oldPath}`;
 const record={version:1,id,snapshot:{target:{repository:'a/b',number:3,head:'abc',base:'base'},mergeBase:'merge',gitDir:root,checkout:bin,files:[],diff:''},turns:[],guide:{summary:'Ready',topics:[]},view:'guide',topic:0,offset:0,composer:'',focus:''};
 await saveReview(root,record);
 let panel,closed=false,resolveOpen;
 const ctx={mode:'tui',ui:{select:async(_t,labels)=>labels.find(x=>x.includes('#3')),notify(){},custom:factory=>new Promise(resolve=>{resolveOpen=resolve;panel=factory({terminal:{rows:32},requestRender(){}},{fg:(_c,s)=>s,bold:s=>s},{},()=>{closed=true;resolve();});})}};
 try {
  const opened=openGuidedReview(ctx,'resume','');
  while(!panel)await new Promise(r=>setTimeout(r,10));
  panel.handleInput('\r');panel.handleInput('\r');panel.handleInput('\r');panel.handleInput('Question');panel.handleInput('\r');
  await new Promise(r=>setTimeout(r,100));
  await rename(root,root+'-held');await writeFile(root,'blocks saving');
  panel.handleInput('\t');panel.handleInput('\t');panel.handleInput('\x1b');
  await new Promise(r=>setTimeout(r,300));
  assert.equal(closed,false);assert.match(panel.render(103).join('\n'),/Not saved/);
  await rm(root);await rename(root+'-held',root);
  panel.handleInput('\x1b');await opened;
  const saved=await loadReview(root,id);assert.equal(saved.turns[0].status,'partial');assert.equal(saved.ui.screen,'discussion');panel.dispose();
 } finally {process.env.PATH=oldPath;resolveOpen?.();try{await readFile(root);await rm(root);await rename(root+'-held',root);}catch{}}
});

test('failed backend answer keeps model text separate and can be restored for explicit resend',async()=>{
 const root=join(getAgentDir(),'bro-reviews'),id='9'.repeat(64),bin=join(buildDir,'failure-bin');await mkdir(bin,{recursive:true});await writeFile(join(bin,'agy'),'#!/usr/bin/env node\nconsole.error("backend unavailable");process.exit(1);\n');await chmod(join(bin,'agy'),0o755);
 await saveReview(root,{version:1,id,snapshot:{target:{repository:'a/b',number:19,title:'Failure fixture',head:'head',base:'base'},mergeBase:'base',gitDir:bin,checkout:bin,files:[],diff:''},turns:[],guide:{summary:'Ready',topics:[]},ui:{selected:'overview',screen:'reading',file:'',target:'whole review',pane:'contents',row:0,offsets:{},drafts:{}}});
 const oldPath=process.env.PATH;process.env.PATH=`${bin}:${oldPath}`;let component,resolveOpen;const ctx={mode:'tui',ui:{notify(){},select:async(_t,labels)=>{const label=labels.find(l=>l.includes('#19'));assert.match(label,/Failure fixture.*guide ready/);return label;},custom:factory=>new Promise(resolve=>{resolveOpen=resolve;component=factory({terminal:{rows:32},requestRender(){}},{fg:(_c,s)=>s,bold:s=>s},{},resolve);})}};
 const wait=async fn=>{for(let i=0;i<500;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('failed answer timed out');};
 try{const opened=openGuidedReview(ctx,'resume','');await wait(()=>component);component.render(103);component.handleInput('\r');component.handleInput('\r');component.handleInput('\r');component.handleInput('Retry this question');component.handleInput('\r');await wait(async()=>(await loadReview(root,id)).turns[0]?.status==='failed');let saved=await loadReview(root,id);assert.equal(saved.turns[0].answer,'');assert.match(saved.turns[0].error,/backend unavailable/);assert.match(component.render(103).join('\n'),/Edit and resend/);component.handleInput('\t');component.handleInput('\x1b[B');component.handleInput('\r');await new Promise(r=>setTimeout(r,300));saved=await loadReview(root,id);assert.equal(saved.ui.drafts['whole review'],'Retry this question');component.handleInput('\x1b');component.handleInput('\x1b');component.handleInput('\x1b');await opened;component.dispose();}finally{process.env.PATH=oldPath;resolveOpen?.();component?.dispose();}
});

test('acquisition shows observable elapsed progress and readable retry errors without network calls',async()=>{
 const bin=join(buildDir,'acquisition-bin');await mkdir(bin,{recursive:true});await writeFile(join(bin,'gh'),'#!/usr/bin/env node\nsetTimeout(()=>{console.error("fixture permission denied");process.exit(1);},200);\n');await chmod(join(bin,'gh'),0o755);const oldPath=process.env.PATH;process.env.PATH=`${bin}:${oldPath}`;let panel,resolveOpen;
 try{const opened=openGuidedReview({mode:'tui',cwd:bin,ui:{notify(){},custom:(factory,options)=>new Promise(resolve=>{assert.equal(options.overlayOptions.width,'100%');resolveOpen=resolve;panel=factory({terminal:{rows:20},requestRender(){}},{fg:(_c,s)=>s,bold:s=>s},{},resolve);})}},'https://github.com/a/b/pull/99','');assert.match(panel.render(36).join('\n'),/Bro · Review · 0s/);for(let i=0;i<100&&!panel.render(36).join('\n').includes('permission denied');i++)await new Promise(r=>setTimeout(r,10));assert.match(panel.render(36).join('\n'),/permission denied/);assert.match(panel.render(36).join('\n'),/Esc close · Enter retry/);assert.doesNotMatch(panel.render(36).join('\n'),/Error: gh/);panel.handleInput('\x1b');await opened;panel.dispose();}finally{process.env.PATH=oldPath;resolveOpen?.();panel?.dispose();}
});
