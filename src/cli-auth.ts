import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartMessage, startCliAttempt } from "./backends/cli-process.ts";
import type { BackendOutcome } from "./backends/contract.ts";

/** The shell chooses CLI account profiles. Bro only enforces the choice in each child. */
export type CliAuthBackend = "claude" | "codex";
export type CliChildAuth = { env: NodeJS.ProcessEnv; subscription: boolean };

// Launchers select an existing CLI profile via CLAUDE_CONFIG_DIR or CODEX_HOME.
// These source flags carry intent; Bro does not persist accounts or copy tokens.
export function resolveCliChildAuth(backend: CliAuthBackend, parent: NodeJS.ProcessEnv = process.env): CliChildAuth {
  const selector = backend === "claude" ? "PI_BRO_CLAUDE_AUTH_SOURCE" : "PI_BRO_CODEX_AUTH_SOURCE";
  const choice = parent[selector] ?? "inherit";
  if (choice !== "inherit" && choice !== "subscription")
    throw new Error("Invalid " + selector + "=" + JSON.stringify(choice) + "; use inherit or subscription.");
  const env = { ...parent };
  delete env.PI_BRO_CLAUDE_AUTH_SOURCE;
  delete env.PI_BRO_CODEX_AUTH_SOURCE;
  if (choice === "subscription") {
    if (backend === "claude") {
      // Claude -p gives API keys precedence over an authenticated subscription.
      for (const key of [
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
      ]) delete env[key];
    } else {
      // Codex exec has independent, documented API-key overrides.
      delete env.CODEX_API_KEY;
      delete env.OPENAI_API_KEY;
      // A subscription request must not inherit a provider URL redirect.
      delete env.OPENAI_BASE_URL;
      delete env.CHATGPT_BASE_URL;
    }
  }
  return { env, subscription: choice === "subscription" };
}

/** Method-only status check. Does not prove a specific account or successful model request. */
export function isSubscriptionStatus(backend: CliAuthBackend, stdout: string): boolean {
  if (backend === "codex") return /^Logged in using ChatGPT\s*$/im.test(stdout.trim());
  try {
    const status = JSON.parse(stdout) as Record<string, unknown>;
    return status?.loggedIn === true && status.authMethod === "claude.ai";
  } catch { return false; }
}


/**
 * Codex login status describes the account, not the effective request provider.
 * Read Codex's own resolved config via app-server config/read rather than
 * interpreting individual TOML layers in Bro.
 *
 * Only the built-in OpenAI provider with no endpoint override is admitted for
 * explicit ChatGPT subscription intent. Never silently switch the user's
 * configured custom provider to OpenAI. Other providers remain available in
 * ordinary (inherit) mode.
 */
export function codexSubscriptionRouteProblem(config: unknown): string | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config))
    return "Codex did not provide a usable effective configuration";
  const effective = config as Record<string, unknown>;
  // Codex 0.165.0 config/read reports null for an omitted provider.
  // Its own Config::load resolves that implicit default to "openai" *after*
  // managed, CLI and merged file/profile overrides. The app-server query
  // already uses those effective layers for the requested working directory.
  const configured = effective.model_provider;
  const provider = configured === null || configured === undefined ? "openai" : configured;
  if (provider !== "openai")
    return `Codex selected model_provider=${JSON.stringify(provider)}; choose the built-in OpenAI provider in the selected CODEX_HOME profile`;
  if (effective.openai_base_url !== undefined &&
      effective.openai_base_url !== null && effective.openai_base_url !== "")
    return "Codex has a custom openai_base_url; remove this redirect from the selected subscription profile";
  // Codex config/read includes its built-in ChatGPT URL even in an untouched
  // profile. Only an alternate target is a redirect.
  const chatgptUrl = effective.chatgpt_base_url;
  if (chatgptUrl !== undefined && chatgptUrl !== null && chatgptUrl !== "" &&
      (typeof chatgptUrl !== "string" ||
       chatgptUrl.replace(/[/]+$/, "") !== "https://chatgpt.com/backend-api"))
    return "Codex has a custom chatgpt_base_url; remove this redirect from the selected subscription profile";
  const providers = effective.model_providers;
  if (providers !== null && providers !== undefined) {
    if (typeof providers !== "object" || Array.isArray(providers))
      return "Codex returned an unreadable provider table";
    if (Object.prototype.hasOwnProperty.call(providers, "openai"))
      return "Codex overrides the built-in OpenAI provider; use an unmodified subscription provider";
  }
  return undefined;
}

/**
 * Ask the official Codex app-server for the effective provider configuration.
 * This is the same Codex CLI, CODEX_HOME, and working directory used for exec.
 * A login status alone cannot detect custom provider env_key API billing.
 *
 * Inspection never makes a model request. Missing, unreadable or unsupported
 * app-server/config/read support fails closed when subscription is explicit.
 */
// Codex 0.165.0 app-server starts an online catalog refresh on boot,
// even if the only client method is config/read. Supply a disposable static
// catalog for this *inspection process only* so the refresh worker cannot
// contact a configured provider. The override does NOT select a provider,
// change account credentials, or go into the real codex exec arguments.
// The provider is still read from Codex's effective config for the same cwd.
const CODEX_INSPECTION_CATALOG = {
  models: [{
    slug: "bro-config-inspection-only",
    display_name: "Bro configuration inspection only",
    description: "Local offline catalog; never used for inference",
    base_instructions: "Local configuration inspection only; never used for inference.",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
    shell_type: "shell_command",
    visibility: "none",
    supported_in_api: true,
    priority: 0,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: "bytes", limit: 10_000 },
    experimental_supported_tools: [],
  }],
};

async function inspectCodexSubscriptionRoute(
  env: NodeJS.ProcessEnv, cwd: string | undefined, signal: AbortSignal,
  deadlineMs: number, killEscalationMs: number,
): Promise<BackendOutcome | undefined> {
  if (signal.aborted) return { status: "cancelled", message: "Canceled." };
  const probeDir = await mkdtemp(join(tmpdir(), "pi-bro-codex-inspect-"));
  try {
  const catalogPath = join(probeDir, "catalog.json");
  await writeFile(catalogPath, JSON.stringify(CODEX_INSPECTION_CATALOG), { mode: 0o600 });
  if (signal.aborted) return { status: "cancelled", message: "Canceled." };
  const { child, attempt, diagnostics } = startCliAttempt(
    "codex", ["-c", `model_catalog_json=${JSON.stringify(catalogPath)}`, "app-server"],
    { env, cwd, stdio: ["pipe", "pipe", "pipe"] },
    signal, Math.min(deadlineMs, 15_000), killEscalationMs,
  );
  let buffer = "";
  let decided = false;
  let finish: (problem: string | undefined) => void = () => {};
  const decision = new Promise<string | undefined>(resolve => { finish = resolve; });
  const settle = (problem: string | undefined) => {
    if (decided) return;
    decided = true;
    finish(problem);
  };
  const send = (value: object) => {
    if (decided || attempt.causeOf()) return;
    try { child.stdin?.write(JSON.stringify(value) + "\n"); }
    catch { settle("Codex app-server could not accept the configuration query"); }
  };
  // An app-server may close its input pipe while its buffered response is
  // still readable. The close race below decides whether the query succeeded.
  child.stdin?.on("error", () => {});
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (decided || attempt.causeOf()) return;
    buffer += chunk;
    if (buffer.length > 2_000_000) { settle("Codex returned an oversized configuration response"); return; }
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        settle("Codex app-server returned invalid JSON");
        return;
      }
      if (message.id === 0) {
        if (!message.result || message.error) {
          settle("Codex app-server initialization failed");
          return;
        }
        send({ method: "initialized", params: {} });
        send({ method: "config/read", id: 1, params: { includeLayers: false, ...(cwd ? { cwd } : {}) } });
      } else if (message.id === 1) {
        if (message.error || !message.result || typeof message.result !== "object") {
          settle("Codex app-server did not support config/read for this account/profile");
          return;
        }
        const config = (message.result as { config?: unknown }).config;
        settle(codexSubscriptionRouteProblem(config));
        return;
      }
    }
  });
  send({ method: "initialize", id: 0,
    params: { clientInfo: { name: "pi_bro", title: "Pi Bro", version: "0.36.1" } } });
  const result = await Promise.race([
    decision.then(problem => ({ kind: "decision" as const, problem })),
    attempt.closed.then(() => ({ kind: "closed" as const })),
  ]);
  // The probe is not a long-running provider connection.
  if (!attempt.causeOf()) attempt.stop("protocol");
  await attempt.closed;
  attempt.dispose();
  if (signal.aborted || attempt.causeOf() === "cancelled")
    return { status: "cancelled", message: "Canceled." };
  if (attempt.causeOf() === "timeout")
    return { status: "timeout", message: "Codex effective subscription configuration check timed out." };
  const problem = result.kind === "decision"
    ? result.problem
    : diagnostics.processError
      ? "Codex app-server could not start"
      : "Codex app-server closed without returning the effective configuration" +
        (diagnostics.stderr.trim() ? ": " + diagnostics.stderr.trim().slice(0, 700) : "");
  return problem
    ? { status: "failure", message: "Codex subscription selection is not safe: " + problem +
        ". No Codex model execution was started; the inspection uses a temporary local catalog to suppress ordinary model discovery. Use a subscription-compatible CODEX_HOME profile or select inherited/API authentication explicitly." }
    : undefined;
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}

// Only a deliberate subscription choice gets an auth-method preflight.
// CLI status is not proof of account identity or a paid model call.
export async function verifyCliSubscription(
  backend: CliAuthBackend,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  killEscalationMs: number,
  deadlineMs: number,
  cwd?: string,
): Promise<BackendOutcome | undefined> {
  if (signal.aborted) return { status: "cancelled", message: "Canceled." };
  const label = backend === "claude" ? "Claude Code" : "Codex";
  const args = backend === "claude" ? ["auth", "status"] : ["login", "status"];
  const { child, attempt, diagnostics } = startCliAttempt(backend, args,
    { env, stdio: ["ignore", "pipe", "pipe"] },
    signal, Math.min(deadlineMs, 15_000), killEscalationMs);
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(0, 32_768);
  });
  const { code, exitSignal } = await attempt.closed;
  attempt.dispose();
  if (attempt.causeOf() === "cancelled") return { status: "cancelled", message: "Canceled." };
  if (attempt.causeOf() === "timeout") return { status: "timeout", message: label + " subscription login check timed out." };
  if (diagnostics.processError)
    return { status: "failure", message: processStartMessage(diagnostics.processError as NodeJS.ErrnoException, label) };
  const status = backend === "codex" ? stdout + "\n" + diagnostics.stderr : stdout;
  if (code !== 0 || exitSignal || !isSubscriptionStatus(backend, status)) {
    const command = backend === "claude" ? "claude auth status" : "codex login status";
    const profile = backend === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    return { status: "failure", message: label +
      " did not confirm subscription login in the selected profile. Run `" + command +
      "` with that " + profile + " and sign in to the intended subscription; Bro will not switch to API billing." };
  }
  return backend === "codex"
    ? inspectCodexSubscriptionRoute(env, cwd, signal, deadlineMs, killEscalationMs)
    : undefined;
}
