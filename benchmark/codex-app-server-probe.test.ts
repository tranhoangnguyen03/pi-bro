import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withFakeExecutables } from "../test/test-fake-exec.ts";
import { runProbe } from "./codex-app-server-probe.ts";

const mock = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const output = process.env.BIN_DIR + "/appserver-requests.log";
fs.appendFileSync(process.env.BIN_DIR + "/appserver-launches.log", "start\n");
if (process.argv.slice(2).join(" ") !== "app-server") process.exit(31);
const rl = readline.createInterface({ input: process.stdin });
let count = 0;
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
rl.on("line", line => {
  const request = JSON.parse(line);
  const method = request.method;
  if (method === "initialized") return;
  fs.appendFileSync(output, method + "\n");
  if (method === "initialize") {
    send({ id: request.id, result: { userAgent: "codex_test" } });
    send({ method: "account/updated", params: { authMode: null } });
    return;
  }
  if (method === "config/read") {
    send({ id: request.id, result: { config: {
      model_provider: process.env.FAKE_CONFIG === "bad" ? "custom-key-provider" : null,
      model_providers: {}, openai_base_url: null, chatgpt_base_url: null,
    } } });
    return;
  }
  if (method === "account/read") {
    send({ id: request.id, result: {
      account: { type: process.env.FAKE_ACCOUNT === "bad" ? "apiKey" : "chatgpt" },
      requiresOpenaiAuth: true,
    } });
    return;
  }
  if (method === "thread/start") {
    send({ id: request.id, result: { thread: { id: "thread-123", modelProvider: "openai" } } });
    return;
  }
  if (method === "turn/start") {
    if (request.params.threadId !== "thread-123" || request.params.sandboxPolicy.type !== "readOnly" ||
        request.params.approvalPolicy !== "never" || request.params.model !== "test") process.exit(32);
    count++;
    const turnId = "turn-" + count;
    send({ id: request.id, result: { turn: { id: turnId, status: "inProgress" } } });
    if (process.env.FAKE_TURN === "hang") return;
    send({ method: "item/agentMessage/delta", params: {
      threadId: "thread-123", turnId, itemId: "i-" + count, delta: "hello",
    } });
    send({ method: "item/completed", params: {
      threadId: "thread-123", turnId, item: { id: "i-" + count, type: "agentMessage", text: "OK" },
    } });
    send({ method: "turn/completed", params: {
      threadId: "thread-123", turn: { id: turnId,
        status: process.env.FAKE_TURN === "failed" ? "failed" : "completed" },
    } });
    if (count === 1 && process.env.FAKE_CHANGE_ACCOUNT === "yes") {
      send({ method: "account/updated", params: { authMode: "apikey" } });
    }
  }
});
`;

async function mockProbe(extra: Record<string, string>,
  run: (cwd: string) => Promise<void>): Promise<void> {
  await withFakeExecutables({ codex: mock }, async cwd => {
    await run(cwd);
  }, { env: extra });
}

async function calls(dir: string): Promise<string[]> {
  return (await readFile(join(dir, "appserver-requests.log"), "utf8")).trim().split("\n");
}

test("Codex app-server probe runs two turns in one process and checks ChatGPT route on every turn", async () => {
  await mockProbe({}, async cwd => {
    const result = await runProbe({
      cwd, model: "test", turns: 2, env: process.env, subscription: true, deadlineMs: 3000,
    });
    assert.equal(result.processReused, true);
    const entries = result.turns as Array<{ status: string; firstTextMs: number; preflightMs: number }>;
    assert.equal(entries.length, 2);
    assert.ok(entries.every(x => x.status === "success" && x.firstTextMs >= 0 && x.preflightMs >= 0));
    assert.equal((await readFile(join(cwd, "appserver-launches.log"), "utf8")).trim().split("\n").length, 1);
    const received = await calls(cwd);
    assert.equal(received.filter(x => x === "initialize").length, 1);
    assert.equal(received.filter(x => x === "thread/start").length, 1);
    assert.equal(received.filter(x => x === "turn/start").length, 2);
    assert.equal(received.filter(x => x === "config/read").length, 3);
    assert.equal(received.filter(x => x === "account/read").length, 3);
  });
});

test("Codex app-server probe rejects a custom provider before starting any model turn", async () => {
  await mockProbe({ FAKE_CONFIG: "bad" }, async cwd => {
    await assert.rejects(runProbe({ cwd, model: "test", turns: 2,
      env: process.env, subscription: true }), /provider/);
    const received = await calls(cwd);
    assert.equal(received.includes("thread/start"), false);
    assert.equal(received.includes("turn/start"), false);
  });
});

test("Codex app-server probe rejects non-ChatGPT login before model execution", async () => {
  await mockProbe({ FAKE_ACCOUNT: "bad" }, async cwd => {
    await assert.rejects(runProbe({ cwd, model: "test", turns: 2,
      env: process.env, subscription: true }), /subscription/);
    const received = await calls(cwd);
    assert.equal(received.includes("turn/start"), false);
  });
});

test("Codex app-server probe never promotes failed terminal output to success", async () => {
  await mockProbe({ FAKE_TURN: "failed" }, async cwd => {
    await assert.rejects(runProbe({ cwd, model: "test", turns: 2,
      env: process.env, subscription: false }), /failed or omitted/);
    const received = await calls(cwd);
    assert.equal(received.filter(x => x === "turn/start").length, 1);
    assert.equal(received.includes("config/read"), false, "inherit must preserve custom providers");
  });
});

test("Codex app-server probe fails visibly when no terminal event arrives", async () => {
  await mockProbe({ FAKE_TURN: "hang" }, async cwd => {
    await assert.rejects(runProbe({ cwd, model: "test", turns: 2,
      env: process.env, subscription: false, deadlineMs: 80 }), /timed out/);
  });
});


test("Codex app-server probe stops before the next paid turn after subscription account changes", async () => {
  await mockProbe({ FAKE_CHANGE_ACCOUNT: "yes" }, async cwd => {
    await assert.rejects(runProbe({ cwd, model: "test", turns: 2,
      env: process.env, subscription: true }), /subscription changed/);
    const received = await calls(cwd);
    assert.equal(received.filter(x => x === "turn/start").length, 1);
  });
});
