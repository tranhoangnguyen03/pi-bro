import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {commandFor,canonicalOutput,run} from "../runner/execute.mjs";
const req=(backend,effort="default")=>({backend,model:backend==="pi"?"anthropic/claude-sonnet-4-5":"model-id",effort,prompt:"Quoted source: test"});
test("Agy has a sandbox, model and stream-json",()=>{
  const plan=commandFor(req("agy","low"));
  assert.equal(plan.bin,"agy");
  assert.ok(plan.args.includes("--sandbox"));
  assert.ok(plan.args.includes("stream-json"));
  assert.ok(plan.args.includes("--effort"));
  assert.ok(!plan.args.some(x=>x.includes("dangerously")));
});
test("Codex uses read-only sandbox and ephemeral session",()=>{
  const plan=commandFor(req("codex","medium"));
  assert.equal(plan.bin,"codex");
  assert.ok(plan.args.join(" ").includes("--sandbox read-only"));
  assert.ok(plan.args.includes("--ephemeral"));
  assert.ok(plan.args.includes("--model"));
  assert.equal(plan.stdin,"Quoted source: test");
});
test("Pi CLI has no tools/extensions/context/session and explicit model",()=>{
  const plan=commandFor(req("pi"));
  assert.equal(plan.bin,"pi");
  for(const flag of ["--no-tools","--no-extensions","--no-mcp","--no-session","--no-skills","--no-context-files","--no-approve"])assert.ok(plan.args.includes(flag));
  assert.equal(plan.stdin,"Quoted source: test");
});
test("Agy and Codex accept only canonical successful result",()=>{
  assert.equal(canonicalOutput("agy",JSON.stringify({event:"result",result:{status:"SUCCESS",response:"answer"}})),"answer");
  assert.throws(()=>canonicalOutput("agy",JSON.stringify({event:"result",result:{status:"FAILED",response:"bad"}})),/unsuccessful/);
  assert.equal(canonicalOutput("codex",[
    JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"answer"}}),
    JSON.stringify({type:"turn.completed"})
  ].join("\n")),"answer");
  assert.throws(()=>canonicalOutput("codex",JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"answer"}})),/verified/);
  assert.throws(()=>canonicalOutput("codex",JSON.stringify({type:"turn.failed",error:{message:"failure"}})),/failure/);
});
test("fake Codex run captures result without executing real CLIs",async()=>{
  const tmp=await mkdtemp(join(tmpdir(),"bro-fake-backend-"));
  try {
    const file=join(tmp,"fake.mjs");
    await writeFile(file,'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"from fake"}})+"\\n");process.stdout.write(JSON.stringify({type:"turn.completed"})+"\\n");');
    const result=await run(req("codex"),{commandOverride:process.execPath,argsOverride:[file],deadlineMs:5000});
    assert.equal(result.text,"from fake");
  } finally {await rm(tmp,{recursive:true,force:true});}
});
test("unknown backends and invalid models are refused",()=>{
  assert.throws(()=>commandFor({...req("agy"),backend:"muse"}),/Unsupported/);
  assert.throws(()=>commandFor({...req("pi"),model:"sonnet"}),/provider\/model/);
  assert.throws(()=>commandFor({...req("codex"),effort:"max"}),/Unsupported effort/);
});
