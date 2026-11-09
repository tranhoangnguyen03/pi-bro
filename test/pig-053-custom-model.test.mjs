/** Real PiG 0.5.3 + Bro Pi backend against a local OpenAI-compatible endpoint.
 * No paid account or fake agent session: this runs a real host and actual HTTP requests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pig = process.env.BRO_HOST_TEST_BIN;

function makeService(answer) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ url: req.url, authorization: req.headers.authorization, model: payload.model });
      const frame = (delta, reason) => "data: " + JSON.stringify({
        id: "fixture", object: "chat.completion.chunk", model: "probe",
        choices: [{ index: 0, delta, finish_reason: reason }],
      }) + "\n\n";
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(frame({ role: "assistant", content: answer }, null));
      res.write(frame({}, "stop"));
      res.end("data: [DONE]\n\n");
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  return { server, requests };
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function withDeadline(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message())), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function runHost(agent, workspace, session, expectedText, afterFirstReply) {
  const env = { ...process.env,
    PI_CODING_AGENT_DIR: agent, PIG_CODING_AGENT_DIR: agent,
    PIG_HOME: join(dirname(agent), ".pig"), PIG_USE_PI_DIRS: "1",
    PIG_TS_RUNTIME: "node", PIG_OFFLINE: "1", PI_OFFLINE: "1",
  };
  for (const variable of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY"]) delete env[variable];
  const args = ["--mode", "rpc", "--offline", "--no-extensions",
    "-e", join(root, "src/bro.ts"), "--no-skills", "--no-prompt-templates",
    "--no-context-files", "--no-mcp", "--no-themes",
    "--provider", "study", "--model", "probe", "--session", session];
  const child = spawn(pig, args, { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
  let logs = "", stdout = "", buffer = "";
  const pending = new Map();
  child.stdout.on("data", chunk => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const i = buffer.indexOf("\n");
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        stdout += line + "\n";
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        if (value.type === "response" && pending.has(value.id)) {
          pending.get(value.id)(value);
          pending.delete(value.id);
        }
      }
    });
  child.stderr.on("data", chunk => { logs = (logs + chunk.toString()).slice(-9000); });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    const sendBroRequest = async (id) => {
      const response = new Promise(resolve => pending.set(id, resolve));
      child.stdin.write(JSON.stringify({ id, type: "prompt",
        message: "/bro text Explain the test request from this agent." }) + "\n");
      const result = await withDeadline(response, 25_000,
        () => "RPC timeout: " + logs + "\n" + stdout);
      assert.equal(result.success, true, "RPC command error: " + JSON.stringify(result) + "\n" + logs);
    };
    await sendBroRequest("bro-local-model-1");
    if (afterFirstReply) {
      await afterFirstReply();
      await sendBroRequest("bro-local-model-2");
    }
    child.stdin.end();
    const exit = await withDeadline(closed, 10_000, () => "RPC exit timeout: " + logs);
    assert.equal(exit.code, 0, "host did not exit cleanly: " + logs);
    const sessionText = await readFile(session, "utf8");
    const entries = sessionText.split("\n").filter(Boolean).map(JSON.parse);
    assert.ok(entries.some(e => e.type === "custom" && e.customType === "bro-last-result" &&
      JSON.stringify(e.data).includes(expectedText)),
      "Bro must retain the backend's actual result, not just the original prompt: " +
      sessionText.slice(-2800) + "\n" + logs);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await closed.catch(() => {});
    }
  }
}

test("real PiG 0.5.3 uses the agent-local custom model's endpoint and key, then reloads edits in a fresh host", 
  { timeout: 100_000, skip: !pig }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "bro-pig053-model-"));
    const agent = join(dir, ".pi"), workspace = join(dir, "project");
    const one = makeService("LOCAL_MODEL_FIRST_REPLY");
    const two = makeService("LOCAL_MODEL_EDITED_REPLY");
    try {
      await Promise.all([mkdir(agent), mkdir(workspace)]);
      const p1 = await listen(one.server), p2 = await listen(two.server);
      await writeFile(join(agent, "bro-settings.json"), JSON.stringify({
        version: 2, default: { backend: "pi", model: "study/probe", effort: "default" },
      }));
      const models = (port, key) => ({ providers: { study: {
        api: "openai-completions", baseUrl: "http://127.0.0.1:" + port + "/v1",
        apiKey: key, models: [{ id: "probe", name: "Only-in-agent-home model",
          reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000, maxTokens: 4096 }],
      } } });
      const firstKey = "fixture-only-agent-one";
      await writeFile(join(agent, "models.json"), JSON.stringify(models(p1, firstKey)));
      const session = async name => {
        const file = join(dir, name + ".jsonl");
        await writeFile(file, JSON.stringify({
          type: "session", version: 3, id: randomUUID(),
          timestamp: new Date().toISOString(), cwd: workspace,
        }) + "\n");
        return file;
      };
      const secondKey = "fixture-only-agent-two";
      await runHost(agent, workspace, await session("one"), "LOCAL_MODEL_FIRST_REPLY",
        async () => {
          // Edit the selected model while PiG is still running. The SDK child must
          // use the host-old endpoint A AND its host-old credential A, never A+B.
          assert.equal(one.requests.length, 1);
          await writeFile(join(agent, "models.json"), JSON.stringify(models(p2, secondKey)));
        });
      assert.equal(one.requests.length, 2, "the unchanged host must use endpoint A for both turns");
      assert.equal(two.requests.length, 0, "the unchanged host must not send to endpoint B");
      for (const request of one.requests) {
        assert.deepEqual(request, {
          url: "/v1/chat/completions", authorization: "Bearer " + firstKey, model: "probe",
        }, "the unchanged host must not pair its old endpoint with the new credential");
      }

      // A new PiG host loads the edited model, endpoint and credential as one source.
      await runHost(agent, workspace, await session("two"), "LOCAL_MODEL_EDITED_REPLY");
      assert.equal(one.requests.length, 2, "fresh host must not call stale endpoint");
      assert.equal(two.requests.length, 1, "edited agent-local endpoint must receive one request");
      assert.deepEqual(two.requests[0], {
        url: "/v1/chat/completions", authorization: "Bearer " + secondKey, model: "probe",
      });
    } finally {
      await Promise.allSettled([
        new Promise(resolve => one.server.close(resolve)),
        new Promise(resolve => two.server.close(resolve)),
      ]);
      await rm(dir, { recursive: true, force: true });
    }
  });
