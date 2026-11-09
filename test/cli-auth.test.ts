import "./test-cli-guard.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withFakeExecutables } from "./test-fake-exec.ts";
import { execute, stopActiveBackendExecutions } from "../src/backend.ts";
import { codexSubscriptionRouteProblem, isSubscriptionStatus, resolveCliChildAuth } from "../src/cli-auth.ts";
import { doctorReport } from "../src/doctor.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const request = { feature: "explain" as const, access: "restricted" as const, prompt: "Explain this." };
const claude = { backend: "claude" as const, model: "sonnet" };
const codex = { backend: "codex" as const, model: "gpt-5.5" };

test("source selection is per backend and never mutates the host environment", () => {
  const parent = {
    CLAUDE_CONFIG_DIR: "/homes/a/claude", CODEX_HOME: "/homes/b/codex",
    ANTHROPIC_API_KEY: "anthropic-bill", ANTHROPIC_AUTH_TOKEN: "bearer",
    ANTHROPIC_BASE_URL: "https://api.invalid", CODEX_API_KEY: "codex-bill",
    OPENAI_API_KEY: "openai-bill",
    PI_BRO_CLAUDE_AUTH_SOURCE: "subscription", PI_BRO_CODEX_AUTH_SOURCE: "inherit",
  };
  const saved = JSON.stringify(parent);
  const a = resolveCliChildAuth("claude", parent);
  assert.equal(a.subscription, true);
  assert.equal(a.env.CLAUDE_CONFIG_DIR, "/homes/a/claude");
  assert.equal(a.env.CODEX_API_KEY, "codex-bill");
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) assert.equal(a.env[key], undefined);
  const b = resolveCliChildAuth("codex", parent);
  assert.equal(b.subscription, false);
  assert.equal(b.env.CODEX_HOME, "/homes/b/codex");
  assert.equal(b.env.CODEX_API_KEY, "codex-bill");
  assert.equal(JSON.stringify(parent), saved);
  const homeA = resolveCliChildAuth("codex", { CODEX_HOME: "/a", PI_BRO_CODEX_AUTH_SOURCE: "subscription", CODEX_API_KEY: "x" });
  const homeB = resolveCliChildAuth("codex", { CODEX_HOME: "/b", PI_BRO_CODEX_AUTH_SOURCE: "subscription", CODEX_API_KEY: "y" });
  assert.equal(homeA.env.CODEX_HOME, "/a");
  assert.equal(homeB.env.CODEX_HOME, "/b");
  assert.equal(homeA.env.CODEX_API_KEY, undefined);
  assert.equal(homeB.env.CODEX_API_KEY, undefined);
  assert.throws(() => resolveCliChildAuth("claude", { PI_BRO_CLAUDE_AUTH_SOURCE: "unknown" }), /Invalid PI_BRO_CLAUDE_AUTH_SOURCE/);
});

test("CLI status recognizes subscription but rejects API modes and unverified data", () => {
  assert.equal(isSubscriptionStatus("claude", '{"loggedIn":true,"authMethod":"claude.ai"}'), true);
  for (const method of ["api_key", "third_party", "oauth_token", "none"]) {
    assert.equal(isSubscriptionStatus("claude", JSON.stringify({ loggedIn: true, authMethod: method })), false);
  }
  assert.equal(isSubscriptionStatus("claude", "not JSON"), false);
  assert.equal(isSubscriptionStatus("codex", "Logged in using ChatGPT"), true);
  assert.equal(isSubscriptionStatus("codex", "Logged in using an API key"), false);
});


test("Codex subscription accepts only the built-in OpenAI route in effective config", () => {
  assert.equal(codexSubscriptionRouteProblem({ model_provider: "openai" }), undefined);
  assert.equal(codexSubscriptionRouteProblem({ model_provider: "openai", model_providers: { custom: { env_key: "BRO_FIXTURE_API_KEY" } } }), undefined,
    "an unused custom provider is not an auth escape");
  for (const config of [
    null,
    {},
    { model_provider: "localfixture", model_providers: { localfixture: { env_key: "BRO_FIXTURE_API_KEY" } } },
    { model_provider: "openai", openai_base_url: "http://127.0.0.1:1234" },
    { model_provider: "openai", chatgpt_base_url: "https://other.example.invalid" },
    { model_provider: "openai", model_providers: { openai: { env_key: "MY_API_KEY" } } },
  ]) assert.ok(codexSubscriptionRouteProblem(config), JSON.stringify(config));
});

test("Claude child uses selected profile, drops inherited API auth, and runs only after subscription status", async () => {
  await withFakeExecutables({ claude: `#!/bin/sh
if [ "$1" = "auth" ]; then
  echo '{"loggedIn":true,"authMethod":"claude.ai"}'
  exit 0
fi
[ "$1" = "-p" ] || exit 80
[ -z "$ANTHROPIC_API_KEY" ] && [ -z "$ANTHROPIC_AUTH_TOKEN" ] && [ -z "$ANTHROPIC_BASE_URL" ] || exit 81
printf '%s' "$CLAUDE_CONFIG_DIR" > "$BIN_DIR/selected-profile"
touch "$BIN_DIR/model-ran"
cat >/dev/null
echo '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","result":"Claude answer"}'
` }, async bin => {
    const outcome = await execute(request, claude, new AbortController().signal);
    assert.deepEqual(outcome, { status: "success", text: "Claude answer" });
    assert.equal(await readFile(join(bin, "selected-profile"), "utf8"), "/fixture/claude-profile");
    assert.ok(existsSync(join(bin, "model-ran")));
    assert.equal(process.env.ANTHROPIC_API_KEY, "api-billing-key");
  }, { env: {
    PI_BRO_CLAUDE_AUTH_SOURCE: "subscription",
    CLAUDE_CONFIG_DIR: "/fixture/claude-profile",
    ANTHROPIC_API_KEY: "api-billing-key",
    ANTHROPIC_AUTH_TOKEN: "token",
    ANTHROPIC_BASE_URL: "https://api.example.invalid",
  } });
});

test("Claude rejects a profile using API billing before a model request", async () => {
  await withFakeExecutables({ claude: `#!/bin/sh
if [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"api_key"}'; exit 0; fi
touch "$BIN_DIR/model-ran"
exit 99
` }, async bin => {
    const outcome = await execute(request, claude, new AbortController().signal);
    assert.equal(outcome.status, "failure");
    assert.match(outcome.status === "failure" ? outcome.message : "", /will not switch to API billing/);
    assert.equal(existsSync(join(bin, "model-ran")), false);
  }, { env: { PI_BRO_CLAUDE_AUTH_SOURCE: "subscription" } });
});

test("Codex child uses selected CODEX_HOME, removes API override, and forces ChatGPT login", async () => {
  await withFakeExecutables({ codex: `#!/bin/sh
if [ "$1" = "login" ]; then echo 'Logged in using ChatGPT' >&2; exit 0; fi
if [ "$1" = "app-server" ]; then
  while IFS= read -r line; do
    case "$line" in
      *'"method":"initialize"'*) echo '{"id":0,"result":{"userAgent":"fixture"}}';;
      *'"method":"config/read"'*) echo '{"id":1,"result":{"config":{"model_provider":"openai"}}}';;
    esac
  done
  exit 0
fi
[ "$1" = "exec" ] || exit 80
[ -z "$CODEX_API_KEY" ] && [ -z "$OPENAI_API_KEY" ] || exit 81
printf '%s' "$CODEX_HOME" > "$BIN_DIR/selected-profile"
printf '%s\n' "$@" > "$BIN_DIR/exec-args"
touch "$BIN_DIR/model-ran"
cat >/dev/null
echo '{"type":"thread.started","thread_id":"th-1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Codex answer"}}'
echo '{"type":"turn.completed"}'
` }, async bin => {
    const outcome = await execute(request, codex, new AbortController().signal);
    assert.deepEqual(outcome, { status: "success", text: "Codex answer" });
    assert.equal(await readFile(join(bin, "selected-profile"), "utf8"), "/fixture/codex-profile");
    const args = (await readFile(join(bin, "exec-args"), "utf8")).split("\n");
    assert.ok(args.includes('forced_login_method="chatgpt"'));
    assert.ok(args.includes('model_provider="openai"'), "pin the already validated built-in provider");
    assert.equal(process.env.CODEX_API_KEY, "api-billing-key");
  }, { env: { PI_BRO_CODEX_AUTH_SOURCE: "subscription", CODEX_HOME: "/fixture/codex-profile", CODEX_API_KEY: "api-billing-key", OPENAI_API_KEY: "other-key" } });
});

test("Codex refuses an API-key status; model child never starts", async () => {
  await withFakeExecutables({ codex: `#!/bin/sh
if [ "$1" = "login" ]; then echo 'Logged in using an API key'; exit 0; fi
touch "$BIN_DIR/model-ran"
` }, async bin => {
    const outcome = await execute(request, codex, new AbortController().signal);
    assert.equal(outcome.status, "failure");
    assert.match(outcome.status === "failure" ? outcome.message : "", /will not switch to API billing/);
    assert.equal(existsSync(join(bin, "model-ran")), false);
  }, { env: { PI_BRO_CODEX_AUTH_SOURCE: "subscription" } });
});


test("Codex ChatGPT login with a custom env_key provider fails before any request", async () => {
  await withFakeExecutables({ codex: `#!/bin/sh
if [ "$1" = "login" ]; then echo 'Logged in using ChatGPT'; exit 0; fi
if [ "$1" = "app-server" ]; then
  while IFS= read -r line; do
    case "$line" in
      *'"method":"initialize"'*) echo '{"id":0,"result":{"userAgent":"fixture"}}';;
      *'"method":"config/read"'*) echo '{"id":1,"result":{"config":{"model_provider":"localfixture","model_providers":{"localfixture":{"base_url":"http://127.0.0.1:8765/v1","env_key":"BRO_FIXTURE_API_KEY","requires_openai_auth":false}}}}}';;
    esac
  done
  exit 0
fi
touch "$BIN_DIR/model-ran"
exit 93
` }, async bin => {
    const outcome = await execute(request, codex, new AbortController().signal);
    assert.equal(outcome.status, "failure");
    assert.match(outcome.status === "failure" ? outcome.message : "", /model_provider=.*localfixture/);
    assert.equal(existsSync(join(bin, "model-ran")), false, "custom provider's model child never starts");
    assert.equal(process.env.BRO_FIXTURE_API_KEY, "fixture-key", "parent is unchanged");
  }, { env: { PI_BRO_CODEX_AUTH_SOURCE: "subscription", CODEX_HOME: "/fixture/codex-custom",
    BRO_FIXTURE_API_KEY: "fixture-key" } });
});

test("Doctor follows subscription auth method and rejects Codex API-key login", async () => {
  const home = await mkdtemp(join(tmpdir(), "bro-codex-doctor-"));
  try {
  await withFakeExecutables({ codex: `#!/bin/sh
if [ "$1" = "login" ]; then echo 'Logged in using an API key'; exit 0; fi
if [ "$1" = "app-server" ]; then touch "$BIN_DIR/unexpected-app-server"; exit 92; fi
exit 0
` }, async bin => {
    const settings = join(getAgentDir(), "bro-settings.json");
    await writeFile(settings, JSON.stringify({
      version: 2, default: { backend: "codex", model: "gpt-5.5", effort: "default" },
    }));
    try {
      const report = await doctorReport({
        getAllTools: () => [], getActiveTools: () => [],
        exec: async () => ({ code: 0, killed: false, stdout: "codex-cli 0.165.0", stderr: "" }),
      } as never, { cwd: process.cwd(), sessionManager: { getBranch: () => [] } } as never,
      new AbortController().signal);
      assert.match(report, /Bro needs attention/);
      assert.match(report, /did not confirm subscription login/);
      assert.doesNotMatch(report, /Codex auth:\*\* authentication configured/);
      assert.equal(existsSync(join(bin, "unexpected-app-server")), false);
    } finally {
      await writeFile(settings, JSON.stringify({ version: 2,
        default: { backend: "agy", model: "fixture", effort: "default" } }));
    }
  }, { env: { PI_BRO_CODEX_AUTH_SOURCE: "subscription", PI_CODING_AGENT_DIR: home } });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("session shutdown cancels a running CLI child instead of leaving it after exit", async () => {
  await withFakeExecutables({ claude: `#!/bin/sh
touch "$BIN_DIR/started"
cat >/dev/null
sleep 30
` }, async bin => {
    const controller = new AbortController();
    const pending = execute(request, claude, controller.signal, undefined, { killEscalationMs: 120 });
    for (let i = 0; i < 60 && !existsSync(join(bin, "started")); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(existsSync(join(bin, "started")), true, "child must start");
    await stopActiveBackendExecutions();
    const outcome = await pending;
    assert.equal(outcome.status, "cancelled");
  }, { env: { PI_BRO_CLAUDE_AUTH_SOURCE: "inherit" } });
});
