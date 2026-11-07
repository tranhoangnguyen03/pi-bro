import "./test-cli-guard.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withFakeExecutables } from "./test-fake-exec.ts";
import { execute, stopActiveBroBackends } from "../src/backend.ts";
import { isSubscriptionStatus, resolveCliChildAuth } from "../src/cli-auth.ts";

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
if [ "$1" = "login" ]; then echo 'Logged in using ChatGPT'; exit 0; fi
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
    stopActiveBroBackends();
    const outcome = await pending;
    assert.equal(outcome.status, "cancelled");
  }, { env: { PI_BRO_CLAUDE_AUTH_SOURCE: "inherit" } });
});
