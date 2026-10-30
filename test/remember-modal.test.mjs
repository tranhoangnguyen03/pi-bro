/** Actual Remember Me modal, with deterministic Claude replies and no network calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { withFakeExecutable } from "./test-fake-exec.ts";
import { buildDir, settings } from "./test-build.mjs";

const { openRememberModal } = await import(pathToFileURL(join(buildDir, "remember.js")).href);
const { readMemoryStore } = await import(pathToFileURL(join(buildDir, "remember-store.js")).href);
initTheme();

async function until(condition, label, modal) {
  // Give process startup and CI contention room, but still fail a stuck transition.
  const started = Date.now();
  const budgetMs = 12_000;
  while (Date.now() - started < budgetMs) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(
    "Timed out waiting for " + label + " after " + (Date.now() - started) + "ms. " +
    "Current modal notice: " + JSON.stringify(modal.component.notice),
  );
}

async function mountedModal() {
  const tui = { mode:"regular", terminal:{rows:40,columns:110,write(){}}, requestRender(){} };
  const theme = { fg:(_color,text)=>text, bold:text=>text };
  let component;
  let notifyDone;
  const ready = new Promise(resolve => { notifyDone=resolve; });
  const ctx = {
    mode:"tui", cwd:process.cwd(),
    sessionManager:{getBranch:()=>[]},
    ui:{
      notify(){},
      custom(factory) {
        return new Promise(resolve => {
          const done=value => { resolve(value); component?.dispose?.(); };
          component=factory(tui,theme,{},done);
          notifyDone();
        });
      },
    },
  };
  const running=openRememberModal(ctx);
  await ready;
  return {
    component,
    running,
    submit(text) { component.setComposerText(text); component.handleInput("\r"); },
    async close() { component.handleInput("\x1b"); await running; },
  };
}

test("actual modal blocks /save after disputed proposal and question, then saves only the revised one", async () => {
  const responses = [
    { kind:"proposal",action:"create",draft:{
      title:"Delegation",summary:"Delegate without approval.",background:"Initial, flawed reading."}},
    { kind:"question",message:"Does approval apply to each delegation or to the coordination plan?"},
    { kind:"proposal",action:"create",draft:{
      title:"Delegation",summary:"Delegate only within an approved coordination plan.",
      background:"The user requires prior approval of the coordination plan."}},
  ];
  const script = [
    "#!/usr/bin/env node",
    "const fs=require('node:fs'); const path=require('node:path');",
    "const counter=path.join(process.env.BIN_DIR,'calls');",
    "const n=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;",
    "fs.writeFileSync(counter,String(n+1));",
    "const responses="+JSON.stringify(responses)+";",
    "const item=responses[n]; if(!item)process.exit(3);",
    "process.stdin.resume();",
    "process.stdin.on('end',()=>{",
    "  const event={type:'result',subtype:'success',is_error:false,stop_reason:'end_turn',terminal_reason:'completed',result:JSON.stringify(item)};",
    "  process.stdout.write(JSON.stringify(event)+'\\n');",
    "});",
  ].join("\n");

  await withFakeExecutable("claude",script,async binDir => {
    await settings.writeSettings({backend:"claude",model:"sonnet",effort:"default",mode:"balanced",showTurns:1,overrides:{}});
    const modal=await mountedModal();
    try {
      modal.submit("Remember how delegation should work.");
      await until(()=>modal.component.notice.includes("Review the full proposal"),"first proposal",modal);
      modal.submit("That is wrong: approval is required.");
      await until(()=>modal.component.notice.includes("Answer the question"),"clarifying question",modal);
      modal.submit("/save");
      assert.match(modal.component.notice,/awaiting clarification/i);
      assert.equal((await readMemoryStore()).entries.length,0,"disputed wording must not be persisted");
      modal.submit("/confirm-revision");
      assert.match(modal.component.notice,/awaiting clarification/i);
      assert.equal((await readMemoryStore()).entries.length,0);
      modal.submit("Approval applies to the coordination plan.");
      await until(()=>modal.component.notice.includes("Review the full proposal"),"corrected proposal",modal);
      modal.submit("/save");
      await until(async()=>(await readMemoryStore()).entries.length===1,"corrected save",modal);
      const memory=(await readMemoryStore()).entries[0];
      assert.match(memory.summary,/within an approved coordination plan/);
      assert.doesNotMatch(memory.summary,/without approval/);
      assert.equal((await readFile(join(binDir,"calls"),"utf8")).trim(),"3");
    } finally { await modal.close(); }
  });
});


test("Remember Me honors the default Agy backend in restricted mode without fallback", async () => {
  const proposal = JSON.stringify({kind:"proposal",action:"create",draft:{
    title:"Agy compatibility",summary:"Default backend remains Agy.",background:"Controlled backend test."}});
  const script = [
    "#!/usr/bin/env node",
    "const fs=require('node:fs'); const path=require('node:path');",
    "fs.writeFileSync(path.join(process.env.BIN_DIR,'agy-args.json'),JSON.stringify(process.argv.slice(2)));",
    "fs.writeFileSync(path.join(process.env.BIN_DIR,'agy-cwd'),process.cwd());",
    "process.stdout.write(JSON.stringify({event:'result',result:{status:'SUCCESS',response:"+JSON.stringify(proposal)+"}})+'\\n');"
  ].join("\n");
  await withFakeExecutable("agy",script,async binDir=>{
    await settings.writeSettings({backend:"agy",model:"test-agy-model",effort:"default",mode:"balanced",showTurns:1,overrides:{}});
    const modal=await mountedModal();
    try {
      modal.submit("Save an Agy compatibility statement.");
      await until(()=>modal.component.notice.includes("Review the full proposal"),"Agy proposal",modal);
      const args=JSON.parse(await readFile(join(binDir,"agy-args.json"),"utf8"));
      assert.ok(args.includes("--sandbox"),"existing sandbox flag remains on");
      assert.ok(!args.includes("--dangerously-skip-permissions"));
      assert.equal(args[args.indexOf("--model")+1],"test-agy-model");
      assert.ok(args.includes("--print"));
      assert.notEqual((await readFile(join(binDir,"agy-cwd"),"utf8")).trim(),process.cwd(),"restricted run uses scratch cwd");
      modal.submit("/save");
      await until(async()=> (await readMemoryStore()).entries.some(e=>e.title==="Agy compatibility"),"Agy save",modal);
    } finally { await modal.close(); }
  });
});

test("Remember Me honors the selected Codex backend with read-only sandbox", async () => {
  const proposal=JSON.stringify({kind:"proposal",action:"create",draft:{
    title:"Codex compatibility",summary:"Codex remains available.",background:"Controlled backend test."}});
  const script=[
    "#!/usr/bin/env node",
    "const fs=require('node:fs'); const path=require('node:path');",
    "fs.writeFileSync(path.join(process.env.BIN_DIR,'codex-args.json'),JSON.stringify(process.argv.slice(2)));",
    "fs.writeFileSync(path.join(process.env.BIN_DIR,'codex-cwd'),process.cwd());",
    "process.stdin.resume(); process.stdin.on('end',()=>{",
    "  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:"+JSON.stringify(proposal)+"}})+'\\n');",
    "  process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');",
    "});"
  ].join("\n");
  await withFakeExecutable("codex",script,async binDir=>{
    await settings.writeSettings({backend:"codex",model:"test-codex-model",effort:"default",mode:"balanced",showTurns:1,overrides:{}});
    const modal=await mountedModal();
    try {
      modal.submit("Save a Codex compatibility statement.");
      await until(()=>modal.component.notice.includes("Review the full proposal"),"Codex proposal",modal);
      const args=JSON.parse(await readFile(join(binDir,"codex-args.json"),"utf8"));
      assert.deepEqual(args.slice(0,3),["exec","--sandbox","read-only"]);
      assert.ok(args.includes("read-only"),"sandbox is read-only");
      assert.ok(args.includes("--ephemeral"));
      assert.equal(args[args.indexOf("--model")+1],"test-codex-model");
      assert.notEqual((await readFile(join(binDir,"codex-cwd"),"utf8")).trim(),process.cwd(),"restricted run uses scratch cwd");
      modal.submit("/save");
      await until(async()=> (await readMemoryStore()).entries.some(e=>e.title==="Codex compatibility"),"Codex save",modal);
    } finally { await modal.close(); }
  });
});
