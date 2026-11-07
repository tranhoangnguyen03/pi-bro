/** Regressions for actual Pi command wiring, branch changes and cancelled BTW turns. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { withFakeExecutable } from "./test-fake-exec.ts";
import { bro, btw, settings } from "./test-build.mjs";

initTheme();
const theme = { fg: (_color, text) => text, bold: (text) => text };
const makeTui = () => ({ mode: "fullscreen", terminal: { rows: 30, columns: 100 }, requestRender() {} });
const custom = (customType, data) => ({ type: "custom", customType, data });

test("session_tree changes live Bro thread and resets write comparisons", async () => {
  await settings.writeSettings({ backend: "agy", model: "test-model", effort: "low", mode: "balanced", showTurns: 1, overrides: {} });
  const originalBranch = [
    custom(bro.BTW_SESSION_ENTRY, {
      thread: { turns: [{ question: "old question", answer: "OLD_BRANCH_ONLY_77" }], full: false, backend: "agy" },
    }),
  ];
  let branch = originalBranch;
  const appended = [];
  const hooks = new Map();
  let command;
  let view = "";
  let action;
  await bro.default({
    on(name, callback) { const group = hooks.get(name) ?? []; group.push(callback); hooks.set(name, group); },
    registerTool() {},
    registerCommand(name, def) { if (name === "bro") command = def; },
    appendEntry(customType, data) { appended.push({ customType, data }); branch.push(custom(customType, data)); },
  });
  const ctx = {
    mode: "tui", hasUI: true, cwd: process.cwd(),
    sessionManager: { getBranch: () => branch },
    ui: {
      notify() {},
      custom: (factory) => new Promise(resolve => {
        const modal = factory(makeTui(), theme, {}, resolve);
        view = stripVTControlCharacters(modal.render(94).join("\n"));
        if (action) { modal.setComposerText(action); modal.handleInput("\r"); }
        modal.handleInput("\x1b");
      }),
    },
  };
  const activate = async event => {
    assert.ok(hooks.has(event), `Bro must register ${event}`);
    await hooks.get(event)[0]({}, ctx);
  };
  await activate("session_start");
  for (let i = 0; i < 5; i++) {
    await command.handler("btw", ctx);
    assert.match(view, /OLD_BRANCH_ONLY_77/);
  }
  assert.equal(appended.length, 0, "five unchanged opens must not write large snapshots");

  branch = []; // /tree rewinds to before any Bro usage.
  await activate("session_tree");
  await command.handler("btw", ctx);
  assert.doesNotMatch(view, /OLD_BRANCH_ONLY_77/, "old branch contents must disappear in the live modal");
  assert.equal(appended.length, 0, "opening a new empty thread must not write a snapshot");

  action = "/mode";
  await command.handler("btw", ctx);
  action = undefined;
  assert.equal(appended.length, 1, "changing the new branch's mode writes exactly once");
  assert.equal(appended[0].data.thread.turns.length, 0, "old branch's turns must never be saved on the new branch");
  await command.handler("btw", ctx);
  assert.equal(appended.length, 1, "reopening unchanged branch state is a no-op");

  branch = originalBranch; // return to original history: it keeps its own data.
  await activate("session_tree");
  await command.handler("btw", ctx);
  assert.match(view, /OLD_BRANCH_ONLY_77/);
  assert.equal(appended.length, 1, "switching to existing history must not write");
});

test("closing an in-flight BTW reply removes it before reopen and preserves completed history", { timeout: 20000 }, async () => {
  await withFakeExecutable("agy", `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("--print") + 1] || "";
fs.appendFileSync(path.join(process.env.BIN_DIR, "prompts.jsonl"), JSON.stringify(prompt) + "\\n");
if (prompt.includes("NEXT CLEAN QUESTION")) {
  console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"CLEAN ANSWER",conversation_id:"conv-2"}}));
} else {
  console.log(JSON.stringify({event:"init",conversation_id:"conv-1"}));
  setTimeout(() => console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"TOO LATE"}})), 12000);
}
`, async bin => {
    await settings.writeSettings({ backend: "agy", model: "test-model", effort: "low", mode: "balanced", showTurns: 1, overrides: {} });
    const prior = { question: "previous", answer: "completed answer" };
    const thread = { turns: [prior], full: false, backend: "agy" };
    const saved = [];
    const ctx = {
      mode: "tui", cwd: process.cwd(), sessionManager: { getBranch: () => [] },
      ui: { notify() {}, custom(factory) {
        return new Promise(resolve => {
          ctx.modal = factory(makeTui(), theme, {}, resolve);
          ctx.mounted?.(ctx.modal);
        });
      } },
    };
    const open = () => {
      let mounted;
      const ready = new Promise(resolve => { mounted = resolve; });
      ctx.mounted = mounted;
      const finished = btw.openBtwModal(ctx, { thread, onChange: () => saved.push(structuredClone(thread)) });
      return { ready, finished };
    };
    const until = async (check, label) => {
      const deadline = Date.now() + 8000;
      while (!check()) {
        if (Date.now() > deadline) assert.fail(`Timed out: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };

    let run = open();
    let modal = await run.ready;
    modal.setComposerText("SLOWQ side");
    modal.handleInput("\r");
    await until(() => thread.turns.length === 2, "pending placeholder");
    assert.equal(thread.turns[1].answer, "…");
    modal.handleInput("\x1b");
    await run.finished;
    assert.deepEqual(thread.turns, [prior], "aborted placeholder removed synchronously on close");
    assert.ok(saved.every(x => x.turns.every(t => t.answer !== "…" && t.question !== "SLOWQ side")));

    // A cancelled retry must restore the completed reply that /retry replaced.
    run = open();
    modal = await run.ready;
    modal.setComposerText("/retry");
    modal.handleInput("\r");
    await until(() => thread.turns.length === 1 && thread.turns[0].answer === "…", "retry placeholder");
    modal.handleInput("\x1b");
    await run.finished;
    assert.deepEqual(thread.turns, [prior], "cancelled retry must restore its previous completed turn");

    run = open();
    modal = await run.ready;
    assert.doesNotMatch(stripVTControlCharacters(modal.render(94).join("\n")), /SLOWQ side/);
    modal.setComposerText("NEXT CLEAN QUESTION");
    modal.handleInput("\r");
    await until(() => thread.turns.at(-1)?.answer === "CLEAN ANSWER", "completed follow-up");
    modal.handleInput("\x1b");
    await run.finished;
    assert.deepEqual(thread.turns, [prior, { question: "NEXT CLEAN QUESTION", answer: "CLEAN ANSWER" }]);
    const prompts = (await readFile(join(bin, "prompts.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(prompts.some(p => p.includes("NEXT CLEAN QUESTION")));
    const followup = prompts.find(p => p.includes("NEXT CLEAN QUESTION"));
    assert.ok(followup && !followup.includes("SLOWQ side"), "cancelled question must not become later prompt history");
    assert.ok(saved.at(-1).turns.every(t => t.answer !== "…"));
  });
});
