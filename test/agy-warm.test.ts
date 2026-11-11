import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { execute, stopActiveBackendExecutions } from "../src/backend.ts";
import { withFakeExecutable } from "./test-fake-exec.ts";

const script = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const file = process.env.BIN_DIR + "/starts.log";
fs.appendFileSync(file, process.pid + "\\n");
const args = process.argv.slice(2);
if (!args.includes("--input-format")) {
 console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"legacy"}}));
 process.exit(0);
}
let turns = 0;
const reader = readline.createInterface({input:process.stdin});
reader.on("line", line => {
 const request = JSON.parse(line);
 if (request.event !== "user") process.exit(3);
 turns++;
 if (request.message.content === "block") return;
 if (turns === 1) console.log(JSON.stringify({event:"init",conversation_id:"warm-c1"}));
 console.log(JSON.stringify({event:"step_update",step_update:{step_type:"agent_response",text_delta:"part-" + turns}}));
 console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"turn " + turns,conversation_id:"warm-c1"}}));
});
`;

async function withWarmFake(run: (cwd: string) => Promise<void>): Promise<void> {
  const original = process.env.PI_BRO_AGY_WARM_BTW;
  await withFakeExecutable("agy", script, async cwd => {
    process.env.PI_BRO_AGY_WARM_BTW = "1";
    try { await run(cwd); }
    finally {
      await stopActiveBackendExecutions();
      if (original === undefined) delete process.env.PI_BRO_AGY_WARM_BTW;
      else process.env.PI_BRO_AGY_WARM_BTW = original;
    }
  });
}

test("opt-in Agy BTW runs two turns in one live process and resets a new thread", async () => {
  await withWarmFake(async cwd => {
    const selection = { model: "test" };
    const request = { feature: "btw" as const, access: "restricted" as const, cwd };
    const events: string[] = [];
    const first = await execute({ ...request, prompt: "first" }, selection,
      new AbortController().signal, event => { if (event.kind === "text") events.push(event.text); });
    assert.equal(first.status, "success");
    if (first.status !== "success") return;
    assert.equal(first.text, "turn 1");
    assert.deepEqual(first.continuation, { id: "warm-c1" });
    assert.deepEqual(events, ["part-1"]);

    const second = await execute({ ...request, prompt: "second", continuation: first.continuation },
      selection, new AbortController().signal);
    assert.equal(second.status, "success");
    if (second.status === "success") assert.equal(second.text, "turn 2");
    assert.equal((await readFile(join(cwd, "starts.log"), "utf8")).trim().split("\n").length, 1,
      "a follow-up must reuse the same live process");

    const fresh = await execute({ ...request, prompt: "new-thread" }, selection, new AbortController().signal);
    assert.equal(fresh.status, "success");
    if (fresh.status === "success") assert.equal(fresh.text, "turn 1");
    assert.equal((await readFile(join(cwd, "starts.log"), "utf8")).trim().split("\n").length, 2,
      "no continuation must create a new isolated process");
  });
});

test("opt-in warm Agy timeout tears down the worker, and legacy explain stays unchanged", async () => {
  await withWarmFake(async cwd => {
    const selection = { model: "test" };
    const failed = await execute({ feature: "btw", access: "restricted", cwd, prompt: "block" },
      selection, new AbortController().signal, undefined, { deadlineMs: 75, killEscalationMs: 75 });
    assert.equal(failed.status, "timeout");
    const next = await execute({ feature: "btw", access: "restricted", cwd, prompt: "after-timeout" },
      selection, new AbortController().signal);
    assert.equal(next.status, "success");
    if (next.status === "success") assert.equal(next.text, "turn 1");

    const explain = await execute({ feature: "explain", access: "restricted", prompt: "short" },
      selection, new AbortController().signal);
    assert.equal(explain.status, "success");
    if (explain.status === "success") assert.equal(explain.text, "legacy");
    assert.equal((await readFile(join(cwd, "starts.log"), "utf8")).trim().split("\n").length, 3);
  });
});


test("aborted warm Agy turn closes its process before another side thread starts", async () => {
  await withWarmFake(async cwd => {
    const selection = { model: "test" };
    const controller = new AbortController();
    const pending = execute({ feature: "btw", access: "restricted", cwd, prompt: "block" },
      selection, controller.signal, undefined, { deadlineMs: 10_000, killEscalationMs: 75 });
    setTimeout(() => controller.abort(), 40);
    const aborted = await pending;
    assert.equal(aborted.status, "cancelled");
    const followUp = await execute({ feature: "btw", access: "restricted", cwd, prompt: "fresh" },
      selection, new AbortController().signal);
    assert.equal(followUp.status, "success");
    if (followUp.status === "success") assert.equal(followUp.text, "turn 1");
    assert.equal((await readFile(join(cwd, "starts.log"), "utf8")).trim().split("\n").length, 2);
  });
});
