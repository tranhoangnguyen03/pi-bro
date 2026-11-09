/** Real Codex CLI 0.165.0 subscription-route regression, with synthetic login and a local-only API endpoint.
 * No paid account or real provider request is used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execute, verifyCliSubscription } from "../src/backend.ts";
import { resolveCliChildAuth } from "../src/cli-auth.ts";
import { doctorReport } from "../src/doctor.ts";

const codex = process.env.BRO_REAL_CODEX_BIN;

test("real Codex 0.165.0 rejects custom env_key API provider despite ChatGPT login status", {
  timeout: 100_000,
  skip: !codex,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "bro-real-codex-subscription-"));
  const profile = join(temp, "codex-home");
  const agentDir = join(temp, ".pi");
  const cwd = join(temp, "workspace");
  const calls = [];
  const server = createServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    for await (const _ of req) { /* drain local-only request */ }
    res.writeHead(500);
    res.end("Fixture must never be called");
  });
  const savedEnv = new Map();
  try {
    await Promise.all([mkdir(profile), mkdir(agentDir), mkdir(cwd)]);
    await new Promise(resolvePort => server.listen(0, "127.0.0.1", resolvePort));
    const port = server.address().port;
    await writeFile(join(profile, "config.toml"), [
      'cli_auth_credentials_store = "file"',
      'model_provider = "localfixture"',
      '[model_providers.localfixture]',
      'name = "Local fixture"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'env_key = "BRO_FIXTURE_API_KEY"',
      'wire_api = "responses"',
      'requires_openai_auth = false',
    ].join("\n") + "\n");
    // Deliberately fake tokens. Codex reads login mode locally, but cannot authenticate
    // remotely. If Bro mistakenly starts the model request, the only configured endpoint
    // is this local server and the test fails.
    await writeFile(join(profile, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "e30.eyJlbWFpbCI6ImZpeHR1cmVAZXhhbXBsZS5pbnZhbGlkIn0.sig",
        access_token: "e30.eyJleHAiOjQxMDAwMDAwMDB9.sig",
        refresh_token: "fixture-refresh-never-use",
        account_id: "fixture-account",
      },
      last_refresh: new Date().toISOString(),
    }));
    await writeFile(join(agentDir, "bro-settings.json"), JSON.stringify({
      version: 2,
      default: { backend: "codex", model: "fixture-model", effort: "default" },
    }));

    const selectedEnv = {
      PATH: dirname(codex) + ":" + (process.env.PATH ?? ""),
      CODEX_HOME: profile,
      PI_CODING_AGENT_DIR: agentDir,
      PI_BRO_CODEX_AUTH_SOURCE: "subscription",
      BRO_FIXTURE_API_KEY: "fixture-secret-local-only",
    };
    for (const [key, value] of Object.entries(selectedEnv)) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }

    const status = spawnSync(codex, ["login", "status"], {
      cwd, env: process.env, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout + status.stderr, /Logged in using ChatGPT/);

    const result = await execute(
      { feature: "explain", access: "restricted", prompt: "Do not reach the fixture" },
      { backend: "codex", model: "fixture-model" }, new AbortController().signal,
      undefined, { deadlineMs: 25_000 }, undefined,
    );
    assert.equal(result.status, "failure");
    assert.match("message" in result ? result.message : "", /model_provider=.*localfixture/);
    assert.deepEqual(calls, [], "explicit subscription must never hit the custom provider");

    const report = await doctorReport({
      getAllTools: () => [], getActiveTools: () => [],
      exec: async () => ({ code: 0, killed: false, stdout: "codex-cli 0.165.0", stderr: "" }),
    }, { cwd, sessionManager: { getBranch: () => [] } }, new AbortController().signal);
    assert.match(report, /Bro needs attention/);
    assert.match(report, /model_provider=.*localfixture/);
    assert.deepEqual(calls, [], "Doctor also must not send any model request");

    // A compatible profile must pass inspection without a model request.
    await writeFile(join(profile, "config.toml"), [
      'cli_auth_credentials_store = "file"',
      'model_provider = "openai"',
    ].join("\n") + "\n");
    const resolved = resolveCliChildAuth("codex");
    const accepted = await verifyCliSubscription("codex", resolved.env,
      new AbortController().signal, 5_000, 15_000, cwd);
    assert.equal(accepted, undefined, JSON.stringify(accepted));
    assert.deepEqual(calls, [], "subscription config inspection cannot make a provider request");

    // Codex's ordinary default does NOT set model_provider at all. On 0.165.0
    // app-server config/read returns model_provider:null and model_providers:{}.
    // This is the common valid ChatGPT subscription profile.
    await writeFile(join(profile, "config.toml"), [
      'cli_auth_credentials_store = "file"',
    ].join("\n") + "\n");
    const implicit = await verifyCliSubscription("codex", resolved.env,
      new AbortController().signal, 5_000, 15_000, cwd);
    assert.equal(implicit, undefined,
      "default Codex profile (no model_provider) must pass: " + JSON.stringify(implicit));
    const defaultReport = await doctorReport({
      getAllTools: () => [], getActiveTools: () => [],
      exec: async () => ({ code: 0, killed: false, stdout: "codex-cli 0.165.0", stderr: "" }),
    }, { cwd, sessionManager: { getBranch: () => [] } }, new AbortController().signal);
    assert.match(defaultReport, /Bro is ready\./,
      "installed Doctor must accept a normal default ChatGPT profile");
    assert.deepEqual(calls, [],
      "default-profile inspection must not issue a model-discovery or inference request");

    // Even the built-in provider may be pointed at a different endpoint.
    await writeFile(join(profile, "config.toml"), [
      'cli_auth_credentials_store = "file"',
      'model_provider = "openai"',
      `openai_base_url = "http://127.0.0.1:${port}/v1"`,
    ].join("\n") + "\n");
    const redirected = await verifyCliSubscription("codex", resolved.env,
      new AbortController().signal, 5_000, 15_000, cwd);
    assert.equal(redirected?.status, "failure");
    assert.match(redirected && "message" in redirected ? redirected.message : "", /openai_base_url/);
    assert.deepEqual(calls, [], "redirected provider cannot receive an explicit subscription request");
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(temp, { recursive: true, force: true });
  }
});
