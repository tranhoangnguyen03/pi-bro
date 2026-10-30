import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeMemory, readMemoryStore, renderUserMemory, checkDraft, memoryPage } from "../src/remember-store.ts";
import { buildRememberPrompt, parseRememberResult, makeReviewedProposal, staleProposalReview } from "../src/remember-engine.ts";

test("saved short memory retains condition and unfolds source and exceptions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bro-memory-test-"));
  try {
    const first = await changeMemory({ kind: "save", draft: {
      title: "Delegation",
      summary: "Allow autonomy within an approved coordination plan; ask before major scope changes.",
      background: "User approves the coordination plan first.",
      scope: "Engineering tasks", exceptions: "Consequential scope changes need approval.",
      sourceContext: "User's explicit choice", basis: "user-stated",
    } }, 0, dir);
    const id = first.entries[0]!.id;
    const reread = await readMemoryStore(dir);
    assert.match(renderUserMemory(reread), /within an approved coordination plan/);
    assert.match(renderUserMemory(reread, { expand: [id] }), /Consequential scope changes need approval/);
    assert.match(renderUserMemory(reread, { expand: [id] }), /User's explicit choice/);
    await assert.rejects(changeMemory({kind:"delete",id},0,dir), /changed in another session/);
    const updated = await changeMemory({kind:"save",id,draft:{...reread.entries[0]!, uncertainty:"Potential conflict with earlier advice"}},1,dir);
    assert.match(renderUserMemory(updated), /UNRESOLVED/);
    const deleted = await changeMemory({kind:"delete",id},2,dir);
    assert.equal(deleted.entries.length,0);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("memory parser preserves short/expanded meaning fields and question", () => {
  const result = parseRememberResult(JSON.stringify({kind:"proposal",action:"create", draft:{
    title:"Testing",summary:"Seek sufficient confidence at low maintenance cost.",
    background:"Lean does not mean no tests.",basis:"user-approved-interpretation",
    exceptions:"Protect important behavior."
  },relatedIds:["m-foo"],conflict:"Another entry says maximize coverage."}));
  assert.equal(result.kind,"proposal");
  if(result.kind==="proposal") assert.match(result.draft.background,/does not mean no tests/);
  assert.deepEqual(parseRememberResult('{"kind":"question","message":"Is this a standing preference?"}'),
    {kind:"question",message:"Is this a standing preference?",relatedIds:[]});
  assert.throws(()=>parseRememberResult("not json"),/unreadable/);
  assert.throws(()=>checkDraft({title:"",summary:"",background:""}));
});

test("writing guidance preserves scope, attribution and unresolved conflict", () => {
  const prompt=buildRememberPrompt({statement:"I like lean testing",memories:[],history:[]});
  assert.match(prompt,/into 'dislikes tests'/);
  assert.match(prompt,/within an approved coordination plan/);
  assert.match(prompt,/short statement/);
  assert.match(prompt,/Surface unresolved conflicts/);
});


test("update saves exact reviewed replacement, removing omitted old fields", async () => {
 const dir=await mkdtemp(join(tmpdir(),"bro-replace-"));
 try{
   const first=await changeMemory({kind:"save",draft:{title:"Testing",summary:"Old",background:"Earlier",
     scope:"Projects",exceptions:"High-risk code",uncertainty:"Possible conflict",sourceContext:"Chat"}},0,dir);
   const old=first.entries[0]!;
   const next=await changeMemory({kind:"save",id:old.id,draft:{
     title:"Testing",summary:"Enough confidence at low cost",background:"Revised"}},1,dir);
   assert.equal(next.entries[0]!.id,old.id);
   assert.equal(next.entries[0]!.createdAt,old.createdAt);
   assert.equal(next.entries[0]!.exceptions,undefined);
   assert.equal(next.entries[0]!.uncertainty,undefined);
   assert.equal(next.entries[0]!.scope,undefined);
   assert.equal(next.entries[0]!.sourceContext,undefined);
 } finally{await rm(dir,{recursive:true,force:true});}
});

test("paging and approved-field search discover the 21st entry",()=>{
 const entries=Array.from({length:21},(_,i)=>({
  id:"m-123456-"+i,title:"Topic "+i,summary:"Statement "+i,background:"Reason "+i,
  scope:i===20?"Accessibility":"",createdAt:"2026-10-30",updatedAt:"2026-10-30"
 }));
 const store={version:1 as const,revision:0,entries};
 assert.equal(memoryPage(store).entries.length,20);
 assert.equal(memoryPage(store,{offset:20}).entries[0]?.title,"Topic 20");
 assert.match(renderUserMemory(store),/offset=20/);
 assert.match(renderUserMemory(store,{query:"Accessibility"}),/Topic 20/);
 assert.match(renderUserMemory(store,{offset:20}),/Topic 20/);
 assert.match(renderUserMemory(store),/Topic 0: Statement 0/);
});

test("reviewed proposal retains correction, target and stale target comparison",()=>{
 const original={id:"m-123456",title:"Delegation",summary:"Original rule",background:"Old rationale",
  createdAt:"2026-10-30",updatedAt:"2026-10-30"};
 const parsed=parseRememberResult(JSON.stringify({kind:"proposal",action:"update",targetId:original.id,
  draft:{title:"Delegation",summary:"Autonomy within approved plan",background:"User approves plan first"}}));
 assert.equal(parsed.kind,"proposal");
 if(parsed.kind!=="proposal")return;
 const proposal=makeReviewedProposal(parsed,2,[original]);
 assert.equal(proposal.reviewedRevision,2);
 const prompt=buildRememberPrompt({statement:"Change the second clause",history:[{user:"Save this",bro:JSON.stringify(parsed)}],
  memories:[original],proposal});
 assert.match(prompt,/Autonomy within approved plan/);
 const latest={...original,summary:"Other-session update"};
 const review=staleProposalReview(proposal,{version:1,revision:3,entries:[latest]});
 assert.equal(review?.previousTarget?.summary,"Original rule");
 assert.equal(review?.currentTarget?.summary,"Other-session update");
 assert.equal(proposal.reviewedRevision,2);
 assert.throws(()=>parseRememberResult(JSON.stringify({kind:"proposal",action:"update",
  draft:{title:"X",summary:"Y",background:"Z"}})),/target ID/);
});
