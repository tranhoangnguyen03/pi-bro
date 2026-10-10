import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const modulePath = './review.ts';
const sourcePath = './review-source.ts';

test('explicit PR URL ignores workspace repository and uses authenticated gh identity', async () => {
 const { resolveReviewTarget } = await import(sourcePath);
 const root = await mkdtemp(join(tmpdir(), 'bro-review-gh-')); const previous = process.env.PATH;
 try {
  const script = join(root,'gh');
  await writeFile(script, `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==='repo'){console.log(JSON.stringify({nameWithOwner:'other/repo',url:'https://github.com/other/repo'}));process.exit(0);}
if(JSON.stringify(a)!==JSON.stringify(['api','--hostname','github.com','repos/other/repo/pulls/42'])) process.exit(9);
console.log(JSON.stringify({base:{repo:{id:9,full_name:'other/repo'},sha:'a'.repeat(40),ref:'main'},head:{sha:'b'.repeat(40),ref:'fork-branch'},title:'PR',body:'Intent',html_url:'https://github.com/other/repo/pull/42'}));`);
  await chmod(script,0o755); process.env.PATH=`${root}:${previous}`;
  const target = await resolveReviewTarget('https://github.com/other/repo/pull/42',root,new AbortController().signal);
  assert.equal(target.repository,'other/repo'); assert.equal(target.repositoryId,9); assert.equal(target.number,42);
  assert.deepEqual(await resolveReviewTarget(' 42 ',root,new AbortController().signal),target);
  for (const suffix of ['/files','/commits','?w=1','#pullrequestreview-123','/files?w=1#diff-abc']) {
    const browserTarget = await resolveReviewTarget(`https://github.com/other/repo/pull/42${suffix}`,root,new AbortController().signal);
    assert.deepEqual(browserTarget,target);
  }
  for (const invalid of ['https://github.com/other/repo/pull/42evil','https://github.com/other/repo/pull/42/files/../../issues/42','https://user:password@github.com/other/repo/pull/42']) await assert.rejects(resolveReviewTarget(invalid,root,new AbortController().signal),/PR number/);
  await assert.rejects(resolveReviewTarget('https://evil.invalid/a/b/issues/42',root,new AbortController().signal),/PR number/);
 } finally { process.env.PATH=previous; await rm(root,{recursive:true,force:true}); }
});

test('review implementation is available', async () => {
  const exists = await import(modulePath).catch(() => undefined);
  assert.ok(exists, 'review module must exist');
});

test('captures immutable source outside a dirty active workspace, preserves old-side evidence and distinct checkouts', async () => {
  const { captureReview, readEvidence } = await import(sourcePath);
  const root = await mkdtemp(join(tmpdir(), 'bro-review-test-'));
  try {
    const repo = join(root, 'author');
    execFileSync('git', ['init', '-q', repo]);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
    await mkdir(join(repo,'dir'));await writeFile(join(repo,'dir','child'),'content');await writeFile(join(repo,'binary'),Buffer.from([0,1,2]));
    await writeFile(join(repo, 'source.ts'), 'old\n');
    git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'source.ts'), 'new\nsecond\n');
    git('commit', '-qam', 'head'); const head = git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'source.ts'), 'uncommitted\n');
    const before = git('status', '--porcelain');
    const target = { host: 'github.com', repository: 'owner/repo', repositoryId: 123, number: 7, title: 'Change', body: '', url: 'https://github.com/owner/repo/pull/7', base, head, baseRef: 'main', headRef: 'feature' };
    const one = await captureReview(target, join(root, 'reviews'), new AbortController().signal, repo);
    const two = await captureReview({ ...target, number: 8 }, join(root, 'reviews'), new AbortController().signal, repo);
    assert.notEqual(one.checkout, two.checkout);
    assert.equal(one.files.length, 1);
    assert.match(one.diff, /\+new/);
    await assert.rejects(readEvidence(one,'dir','new'),/blob|git/);await assert.rejects(readEvidence(one,'binary','new'),/Binary/);
    assert.equal(await readEvidence(one, 'source.ts', 'old'), 'old\n');
    assert.equal(await readEvidence(one, 'source.ts', 'new'), 'new\nsecond\n');
    await writeFile(join(one.checkout, 'source.ts'), 'backend mutation\n');
    assert.equal(await readEvidence(one, 'source.ts', 'new'), 'new\nsecond\n');
    const blob = git('rev-parse', `${head}:source.ts`);
    const forged = execFileSync('git', ['-C', one.checkout, 'hash-object', '-w', '--stdin'], { input: 'forged\n', encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', one.checkout, 'replace', blob, forged]);
    assert.equal(await readEvidence(one, 'source.ts', 'new'), 'new\nsecond\n', 'authoritative evidence ignores replacement refs');
    assert.equal(git('status', '--porcelain'), before);
    assert.equal(await readFile(join(repo, 'source.ts'), 'utf8'), 'uncommitted\n');
    await assert.rejects(readEvidence(one, '../outside', 'new'), /path/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capture retries preserve incomplete directories and recover stale worktree registration', async () => {
  const { captureReview } = await import(sourcePath);
  const { reviewKey } = await import(modulePath);
  const root = await mkdtemp(join(tmpdir(), 'bro-review-recovery-'));
  try {
    const repo = join(root, 'author'); execFileSync('git', ['init', '-q', repo]);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('config','user.email','fixture@invalid');git('config','user.name','Fixture');
    await writeFile(join(repo,'source.ts'),'captured\n');git('add','.');git('commit','-qm','head');const head=git('rev-parse','HEAD');
    const target={host:'github.com',repository:'a/b',repositoryId:1,number:1,base:head,head};
    const store=join(root,'reviews'),directory=join(store,'source',reviewKey(target)),checkout=join(directory,head);
    await mkdir(checkout,{recursive:true});await writeFile(join(checkout,'partial'),'keep me');
    let snapshot=await captureReview(target,store,new AbortController().signal,repo);
    assert.equal(await readFile(join(snapshot.checkout,'source.ts'),'utf8'),'captured\n');
    const recovery=(await readdir(directory)).find(name=>name.startsWith(head+'.incomplete-'));
    assert.ok(recovery);assert.equal(await readFile(join(directory,recovery,'partial'),'utf8'),'keep me');
    // A ready marker cannot authorize reuse of backend edits or extra untracked source.
    await writeFile(join(checkout,'source.ts'),'edited\n');await writeFile(join(checkout,'extra.ts'),'extra\n');
    snapshot=await captureReview(target,store,new AbortController().signal,repo);
    assert.equal(await readFile(join(snapshot.checkout,'source.ts'),'utf8'),'captured\n');
    assert.equal(execFileSync('git',['-C',checkout,'status','--porcelain'],{encoding:'utf8'}),'');
    const preserved = (await readdir(directory)).filter(name=>name.startsWith(head+'.incomplete-'));
    assert.ok(await Promise.all(preserved.map(name=>readFile(join(directory,name,'source.ts'),'utf8').catch(()=>''))).then(contents=>contents.includes('edited\n')));
    assert.ok(await Promise.all(preserved.map(name=>readFile(join(directory,name,'extra.ts'),'utf8').catch(()=>''))).then(contents=>contents.includes('extra\n')));
    // Simulate a killed worktree add: registration and .git exist, but tracked files are missing.
    await rm(checkout+'.ready',{force:true});await rm(join(checkout,'source.ts'));
    snapshot=await captureReview(target,store,new AbortController().signal,repo);
    assert.equal(await readFile(join(snapshot.checkout,'source.ts'),'utf8'),'captured\n');
    // Simulate the checkout directory disappearing but Git registration surviving.
    await rm(checkout,{recursive:true});
    snapshot=await captureReview(target,store,new AbortController().signal,repo);
    assert.equal(git('rev-parse','HEAD'),head);assert.equal(await readFile(join(snapshot.checkout,'source.ts'),'utf8'),'captured\n');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('resume isolates unreadable records without altering their files',async()=>{
 const {saveReview,listReviews,reviewKey}=await import(modulePath);
 const root=await mkdtemp(join(tmpdir(),'bro-review-list-'));
 try {
  const target={host:'github.com',repositoryId:1,number:1,repository:'a/b',head:'head',base:'base'};
  const record={version:1,id:reviewKey(target),snapshot:{target,mergeBase:'base',gitDir:root,checkout:root,files:[],diff:''},turns:[],view:'guide',topic:0,offset:0,composer:'',focus:''};await saveReview(root,record);
  const bad='a'.repeat(64)+'.json',raw='{broken';await writeFile(join(root,bad),raw);
  const errors: {file:string;error:unknown}[]=[];const records=await listReviews(root,(file:string,error:unknown)=>errors.push({file,error}));
  assert.equal(records.length,1);assert.equal(records[0].id,record.id);assert.equal(errors.length,1);assert.equal(errors[0].file,bad);assert.equal(await readFile(join(root,bad),'utf8'),raw);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('empty files have no valid source-line evidence',async()=>{
 const {parseGuide}=await import(modulePath);
 for(const [source,expected] of [['',false],['\n',true],['one',true],['one\n',true]]) {
  const guide=await parseGuide(JSON.stringify({summary:'S',topics:[{title:'T',explanation:'E',evidence:[{path:'file',side:'new',start:1,end:1}]}]}),async()=>source);
  assert.equal(guide.topics[0].evidence[0].valid,expected,JSON.stringify(source));
 }
});

test('discussion omission counts only relevant current-guide and shared turns',async()=>{
 const {buildReviewPrompt}=await import(modulePath);
 const record={snapshot:{target:{},files:[],diff:''},guide:{summary:'S',topics:[{id:'current',title:'T',explanation:'E',evidence:[]}]},turns:Array.from({length:15},()=>({target:'old-topic',question:'old',answer:'old',status:'complete'}))};
 const context=()=>JSON.parse(buildReviewPrompt(record,'Q').split('Quoted review data:\n')[1].split('\n')[0]);
 assert.equal(context().olderDiscussionOmitted,false);assert.deepEqual(context().discussion,[]);
 record.turns.push(...Array.from({length:12},(_,i)=>({target:i%2?'current':'file:file.ts',question:`q${i}`,answer:'a',status:'complete'})));
 assert.equal(context().olderDiscussionOmitted,false);assert.equal(context().discussion.length,12);
 record.turns.push({target:'whole review',question:'latest',answer:'a',status:'complete'});
 assert.equal(context().olderDiscussionOmitted,true);assert.equal(context().discussion.length,12);assert.equal(context().discussion[0].question,'q1');
 record.turns.push({target:'current',question:'failed question',answer:'Request failed: stale backend diagnostic',status:'failed'});
 assert.doesNotMatch(buildReviewPrompt(record,'Retry'),/stale backend diagnostic|failed question/);
});

test('guide validation, atomic persistence and prompt reseeding preserve review facts, not model commands', async () => {
  const { parseGuide, saveReview, loadReview, buildReviewPrompt, reviewKey } = await import(modulePath);
  const root = await mkdtemp(join(tmpdir(), 'bro-review-state-'));
  try {
    const target = { host: 'github.com', repositoryId: 1, repository: 'a/b', number: 2, title: 'PR', body: 'Intent', url: 'https://github.com/a/b/pull/2', base: 'a'.repeat(40), head: 'b'.repeat(40), baseRef: 'main', headRef: 'feature' };
    const snapshot = { target, mergeBase: target.base, gitDir: root, checkout: root, diff: 'diff', files: [{ path: 'a.ts', status: 'M' }], capturedAt: 'now' };
    const guide = await parseGuide(JSON.stringify({ summary: 'Change', topics: [{ title: 'Behavior', explanation: 'Why', evidence: [{ path: 'a.ts', side: 'new', start: 1, end: 1 }, { path: 'missing', side: 'new', start: 99, end: 100 }] }], reviewed: true, publish: true }), async (path: string) => { if (path === 'a.ts') return 'one\n'; throw Error('missing'); });
    assert.equal(guide.topics[0].evidence[0].valid, true);
    assert.equal(guide.topics[0].evidence[1].valid, false);
    assert.equal(guide.reviewed, undefined);
    assert.equal(guide.topics[0].id, 'topic-1');
    const record = { version: 1, id: reviewKey(target), snapshot, guide, turns: [{ question: 'Why?', answer: 'Because', target: 'topic-1', status: 'complete' }], view: 'guide', topic: 0, offset: 3, composer: '', focus: '' };
    await saveReview(root, record);
    const loaded = await loadReview(root, record.id);
    assert.equal(loaded.guide.topics[0].id, 'topic-1');
    assert.deepEqual(loaded, record);
    const prompt = buildReviewPrompt(record, 'Question', 'topic-1', 'Reader preference');
    assert.match(prompt, /Why\?/); assert.match(prompt, /Reader preference/); assert.match(prompt, /do not implement/i);
    await assert.rejects(loadReview(root, '../escape'), /identity/i);
    await writeFile(join(root, record.id + '.json'), JSON.stringify({...record,snapshot:{target:{head:'only-field'}}}));
    await assert.rejects(loadReview(root, record.id), /damaged/);
    await writeFile(join(root, record.id + '.json'), '{broken');
    await assert.rejects(loadReview(root, record.id));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('combined assessment validates findings, isolates bad references and versions their identities', async () => {
 const {parseGuide,replaceGuide,saveReview,loadReview,reviewKey,buildReviewPrompt}=await import(modulePath);
 const finding={title:'Lost update',kind:'defect',severity:'high',topic:0,scenario:'Two writes overlap',impact:'Data loss',reasoning:'Both overwrite the same value',uncertainty:'Timing dependent',fix:'Serialize writes',check:'Assert both writes survive',evidence:[{path:'a.ts',side:'new',start:1,end:1}]};
 const output={summary:'Purpose',topics:[{title:'Writes',explanation:'Stores changes',evidence:[]}],assessment:{overview:'Ordering is the main risk',inspected:['a.ts','caller.ts'],notExamined:['Integration tests not run'],findings:[finding,{...finding,title:'Missing side',evidence:[{path:'a.ts',start:1,end:1}]},{title:'bad'}]}};
 const guide=await parseGuide(JSON.stringify(output),async()=> 'write()\n',true);
 assert.equal(guide.assessment.findings.length,2);assert.equal(guide.assessment.findings[0].topicId,'topic-1');assert.equal(guide.assessment.findings[0].evidence[0].valid,true);
 assert.equal(guide.assessment.findings[1].evidence.length,0);assert.equal(guide.assessment.warnings.length,2);
 const resilient=await parseGuide(JSON.stringify({...output,topics:[{...output.topics[0],evidence:[{path:'a.ts',start:1,end:1}]}]}),async()=>'',true);assert.equal(resilient.topics[0].evidence.length,0);assert.ok(resilient.assessment.warnings.length>2);
 const multiline=await parseGuide(JSON.stringify({...output,assessment:{...output.assessment,findings:[{...finding,evidence:[{path:'a.ts',side:'new',start:2,end:2}]}]}}),async()=>'one\ntwo\n',true);assert.equal(multiline.assessment.findings[0].evidence[0].valid,true);
 await assert.rejects(parseGuide(JSON.stringify({summary:'old',topics:output.topics}),async()=>'',true),/Quality assessment/);
 const target={host:'github.com',repositoryId:1,number:3,repository:'a/b',base:'b',head:'h'};
 const record:any={version:1,id:reviewKey(target),snapshot:{target,mergeBase:'m',gitDir:'g',checkout:'c',diff:'d',files:[{path:'a.ts',status:'M'}]},turns:[],view:'guide',topic:0,offset:0,composer:'',focus:''};
 replaceGuide(record,guide);const first=record.guide.assessment.findings[0];assert.equal(first.topicId,record.guide.topics[0].id);
 replaceGuide(record,guide);assert.notEqual(record.guide.assessment.findings[0].id,first.id);assert.equal(record.guideVersions,undefined);
 const prompt=buildReviewPrompt(record);assert.match(prompt,/Report only observed access failures/);assert.match(prompt,/intentional contract trade-offs as questions/);assert.match(prompt,/hypothetical future regressions/);assert.match(prompt,/correctness|Correctness/);assert.match(prompt,/unchanged callers/);assert.match(prompt,/Do not install dependencies/);assert.doesNotMatch(prompt,/not a findings report/);
 const root=await mkdtemp(join(tmpdir(),'bro-assessment-'));try{await saveReview(root,record);const loaded=await loadReview(root,record.id);assert.deepEqual(loaded.guide.assessment,record.guide.assessment);for(const mutate of [(r:any)=>r.guide.assessment.findings[0].topicId='unknown',(r:any)=>r.guide.assessment.findings[0].evidence[0].valid='yes',(r:any)=>r.guide.assessment.inspected=[1],(r:any)=>r.guide.assessment.findings.push({...r.guide.assessment.findings[0]})]){const bad=structuredClone(record);mutate(bad);await saveReview(root,bad);await assert.rejects(loadReview(root,record.id),/assessment|identity/);}}finally{await rm(root,{recursive:true,force:true});}
});
