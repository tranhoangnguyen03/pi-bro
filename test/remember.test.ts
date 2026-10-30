import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeMemory, readMemoryStore, renderUserMemory, checkDraft } from "../src/remember-store.ts";
import { buildRememberPrompt, parseRememberResult } from "../src/remember-engine.ts";

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
  const result = parseRememberResult(JSON.stringify({kind:"proposal", draft:{
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
  assert.match(prompt,/must NOT become 'dislikes tests'/);
  assert.match(prompt,/within an approved coordination plan/);
  assert.match(prompt,/short statement/);
  assert.match(prompt,/Do not silently harmonize conflict/);
});
