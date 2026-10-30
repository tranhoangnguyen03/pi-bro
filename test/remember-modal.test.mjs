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

async function until(condition, label) {
  for (let n = 0; n < 150; n++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Timed out: " + label);
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
    "const event={type:'result',subtype:'success',is_error:false,stop_reason:'end_turn',terminal_reason:'completed',result:JSON.stringify(item)};",
    "process.stdout.write(JSON.stringify(event)+'\\n');",
  ].join("\n");

  await withFakeExecutable("claude",script,async binDir => {
    await settings.writeSettings({backend:"claude",model:"sonnet",effort:"default",mode:"balanced",showTurns:1,overrides:{}});
    const modal=await mountedModal();
    try {
      modal.submit("Remember how delegation should work.");
      await until(()=>modal.component.notice.includes("Review the full proposal"),"first proposal");
      modal.submit("That is wrong: approval is required.");
      await until(()=>modal.component.notice.includes("Answer the question"),"clarifying question");
      modal.submit("/save");
      assert.match(modal.component.notice,/awaiting clarification/i);
      assert.equal((await readMemoryStore()).entries.length,0,"disputed wording must not be persisted");
      modal.submit("/confirm-revision");
      assert.match(modal.component.notice,/awaiting clarification/i);
      assert.equal((await readMemoryStore()).entries.length,0);
      modal.submit("Approval applies to the coordination plan.");
      await until(()=>modal.component.notice.includes("Review the full proposal"),"corrected proposal");
      modal.submit("/save");
      await until(async()=>(await readMemoryStore()).entries.length===1,"corrected save");
      const memory=(await readMemoryStore()).entries[0];
      assert.match(memory.summary,/within an approved coordination plan/);
      assert.doesNotMatch(memory.summary,/without approval/);
      assert.equal((await readFile(join(binDir,"calls"),"utf8")).trim(),"3");
    } finally { await modal.close(); }
  });
});
