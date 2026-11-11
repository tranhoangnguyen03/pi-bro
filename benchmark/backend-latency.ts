/**
 * Manual, opt-in latency baseline for external Bro backends.
 *
 * Prints timing metadata only. No prompt/output, credential, or stderr persistence.
 * CLI --version is a startup proxy, NOT time-to-model-ready.
 * This script never retries paid calls.
 */
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { execute, verifyCliSubscription, type BackendSelection, type BackendContinuation } from "../src/backend.ts";
import { resolveCliChildAuth } from "../src/cli-auth.ts";

type External = "agy" | "claude" | "codex" | "grok" | "muse";
type Trial = {
  turn: number;
  status: "success" | "failure" | "cancelled" | "timeout";
  firstEventMs: number | null;
  firstTextMs: number | null;
  totalMs: number;
  nativeContinuation: boolean;
};
const EXTERNAL = new Set<External>(["agy", "claude", "codex", "grok", "muse"]);
const round = (ms: number) => Math.round(ms * 10) / 10;

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  let run = false;
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--run") { run = true; continue; }
    if (!["--backend", "--model", "--effort", "--turns", "--cwd"].includes(key)) {
      throw Error("Unknown argument " + key);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--") || values.has(key)) throw Error("Missing/duplicate " + key);
    values.set(key, value);
  }
  const backend = values.get("--backend");
  const model = values.get("--model");
  const turns = Number(values.get("--turns") ?? "3");
  if (!backend || !EXTERNAL.has(backend as External)) throw Error("Choose an external --backend");
  if (!model?.trim()) throw Error("Specify --model");
  if (!Number.isInteger(turns) || turns < 2 || turns > 10) throw Error("--turns must be 2..10");
  return { backend: backend as External, model, effort: values.get("--effort"), turns,
    cwd: resolve(values.get("--cwd") ?? process.cwd()), run };
}

/**
 * Best-effort low-cost startup proxy. --version does not load the model or
 * open a conversation, so never interpret this as the full invocation overhead.
 */
function versionStartupMs(command: string): Promise<number | null> {
  return new Promise(resolveMeasure => {
    const start = performance.now();
    const child = spawn(command, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    let settled = false;
    const end = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveMeasure(value);
    };
    const timer = setTimeout(() => { child.kill(); end(null); }, 8_000);
    child.once("error", () => end(null));
    child.once("close", code => end(code === 0 ? round(performance.now() - start) : null));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selection = { backend: args.backend, model: args.model,
    ...(args.effort ? { effort: args.effort } : {}) } as BackendSelection;
  const versionMs = await versionStartupMs(args.backend);
  const auth = args.backend === "claude" || args.backend === "codex"
    ? resolveCliChildAuth(args.backend)
    : undefined;
  const result: {
    schema: 1; backend: External; model: string; effort: string | null;
    turnsRequested: number; authSource: "inherit" | "subscription" | "n/a";
    versionStartupProxyMs: number | null; preflightMs: number | null;
    preflightStatus: string; trials: Trial[];
  } = {
    schema: 1, backend: args.backend, model: args.model, effort: args.effort ?? null,
    turnsRequested: args.turns, authSource: auth?.subscription ? "subscription" : auth ? "inherit" : "n/a",
    versionStartupProxyMs: versionMs, preflightMs: null, preflightStatus: "not_applicable",
    trials: [],
  };
  if (!args.run) {
    process.stdout.write(JSON.stringify({ ...result, note:
      "No model calls. --version is only a startup proxy; add --run to explicitly allow up to 10 paid turns." }, null, 2) + "\n");
    return;
  }

  const stop = new AbortController();
  const onSigint = () => stop.abort();
  process.once("SIGINT", onSigint);
  try {
    if (auth?.subscription && (args.backend === "claude" || args.backend === "codex")) {
      const started = performance.now();
      const probe = await verifyCliSubscription(args.backend, auth.env, stop.signal, 1_000, 30_000, args.cwd);
      result.preflightMs = round(performance.now() - started);
      result.preflightStatus = probe?.status ?? "success";
      if (probe) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        process.exitCode = 1;
        return;
      }
    }

    let continuation: BackendContinuation | undefined;
    for (let turn = 1; turn <= args.turns && !stop.signal.aborted; turn++) {
      const started = performance.now();
      let firstEventMs: number | null = null;
      let firstTextMs: number | null = null;
      // Fixed synthetic text; no project source or user data is sent by this tool.
      const prompt = turn === 1 ? "Reply with exactly OK. Nothing else." : "Reply with exactly OK again. Nothing else.";
      const response = await execute({
        feature: "btw", prompt, cwd: args.cwd, access: "restricted", continuation,
      }, selection, stop.signal, event => {
        const elapsed = round(performance.now() - started);
        firstEventMs ??= elapsed;
        if (event.kind === "text" && event.text.length) firstTextMs ??= elapsed;
      });
      result.trials.push({
        turn, status: response.status, firstEventMs, firstTextMs,
        totalMs: round(performance.now() - started),
        nativeContinuation: response.status === "success" && Boolean(response.continuation?.id),
      });
      if (response.status !== "success") break;
      continuation = response.continuation;
      if (!continuation && turn < args.turns) {
        // Subsequent turns would not be equivalent to the real BTW native path.
        break;
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.trials.length !== args.turns ||
      result.trials.some(trial => trial.status !== "success")) process.exitCode = 1;
}

main().catch(error => {
  // Avoid logging raw CLI stderr, prompts, or credentials into benchmark artifacts.
  process.stderr.write("Latency benchmark stopped: " +
    (error instanceof Error ? error.name : "unknown error") + ". Check configuration and /bro doctor.\n");
  process.exitCode = 1;
});
