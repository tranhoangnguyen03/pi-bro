/**
 * Opt-in Codex app-server protocol and latency qualification, issue #194.
 * This is NOT a production backend. It makes no model calls without --run.
 * It never logs prompts, answers, config values, account details, or stderr.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { codexSubscriptionRouteProblem, resolveCliChildAuth } from "../src/cli-auth.ts";

type Json = Record<string, unknown>;
type PendingRpc = { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type ActiveTurn = {
  threadId: string;
  id?: string;
  firstEventMs?: number;
  firstTextMs?: number;
  finalText?: string;
  startedAt: number;
  completion?: Json;
  resolve: (v: TurnTiming) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};
export type TurnTiming = {
  status: "success";
  preflightMs: number;
  firstEventMs: number | null;
  firstTextMs: number | null;
  turnMs: number;
};

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
function valueOf(root: unknown, ...path: string[]): unknown {
  let current = root;
  for (const key of path) current = object(current)[key];
  return current;
}
function brief(message: string): Error {
  // Never pass raw upstream/server errors or account details into benchmark output.
  return new Error(message);
}
const round = (n: number) => Math.round(n * 10) / 10;
const MAX_LINE = 2_000_000;
const RPC_TIMEOUT_MS = 15_000;
const DEFAULT_TURN_DEADLINE_MS = 130_000;

export class CodexAppServerProbe {
  private readonly child: ChildProcess;
  private readonly closed: Promise<void>;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly subscription: boolean;
  private readonly cwd: string;
  private nextId = 1;
  private active?: ActiveTurn;
  private stopped = false;
  private accountChanged = false;

  constructor(options: { command?: string; cwd: string; env: NodeJS.ProcessEnv; subscription: boolean }) {
    this.cwd = options.cwd;
    this.subscription = options.subscription;
    this.child = spawn(options.command ?? "codex", ["app-server"], {
      cwd: this.cwd, env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true, detached: process.platform !== "win32",
    });
    this.child.stdin?.on("error", () => this.failAll("Codex app-server stdin failed"));
    // Always consume stderr, but never collect or echo data which may include secrets.
    this.child.stderr?.resume();
    this.child.once("error", () => this.failAll("Codex app-server could not start"));
    this.closed = new Promise(done => {
      this.child.once("close", () => {
        this.failAll("Codex app-server stopped before completion");
        done();
      });
    });
    let buffer = "";
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      if (this.stopped) return;
      buffer += chunk;
      if (buffer.length > MAX_LINE * 2) {
        this.failAll("Codex app-server sent an oversized protocol response");
        this.signalProcess("SIGTERM");
        return;
      }
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.length > MAX_LINE) {
          this.failAll("Codex app-server sent an oversized protocol line");
          this.signalProcess("SIGTERM");
          return;
        }
        if (!line.trim()) continue;
        try { this.onMessage(object(JSON.parse(line) as unknown)); }
        catch {
          this.failAll("Codex app-server sent invalid JSON");
          this.signalProcess("SIGTERM");
          return;
        }
      }
    });
  }

  private failAll(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(brief(message));
      this.pending.delete(id);
    }
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(brief(message));
      this.active = undefined;
    }
  }

  private onMessage(msg: Json): void {
    const id = msg.id;
    if (typeof id === "number") {
      const call = this.pending.get(id);
      if (!call) return;
      this.pending.delete(id);
      clearTimeout(call.timer);
      if (msg.error || msg.result === undefined) call.reject(brief("Codex app-server RPC failed"));
      else call.resolve(object(msg.result));
      return;
    }
    const method = msg.method;
    const params = object(msg.params);
    if (method === "account/updated" && this.subscription) {
      const mode = params.authMode;
      if (mode !== "chatgpt") {
        this.accountChanged = true;
        if (this.active) {
          clearTimeout(this.active.timer);
          this.active.reject(brief("Codex subscription account changed during a turn"));
          this.active = undefined;
        }
      }
      return;
    }

    const active = this.active;
    if (!active || params.threadId !== active.threadId) return;
    if (method === "turn/completed") {
      active.completion = object(params.turn);
      this.tryFinishTurn();
      return;
    }
    if (!method || typeof method !== "string" || !method.startsWith("item/")) return;
    active.firstEventMs ??= round(performance.now() - active.startedAt);
    if (method === "item/agentMessage/delta" && typeof params.delta === "string" && params.delta.length) {
      active.firstTextMs ??= round(performance.now() - active.startedAt);
    }
    if (method === "item/completed" && valueOf(params, "item", "type") === "agentMessage") {
      const final = valueOf(params, "item", "text");
      if (typeof final === "string") active.finalText = final;
    }
  }

  private tryFinishTurn(): void {
    const active = this.active;
    if (!active || !active.id || !active.completion) return;
    this.active = undefined;
    clearTimeout(active.timer);
    const result = active.completion;
    if (result.id !== active.id || result.status !== "completed" ||
        !active.finalText?.trim() || this.accountChanged) {
      active.reject(brief("Codex app-server turn failed or omitted its final answer"));
      return;
    }
    active.resolve({
      status: "success", preflightMs: 0,
      firstEventMs: active.firstEventMs ?? null,
      firstTextMs: active.firstTextMs ?? null,
      turnMs: round(performance.now() - active.startedAt),
    });
  }

  private send(payload: Json): void {
    if (this.stopped || !this.child.stdin?.writable) throw brief("Codex app-server is not accepting requests");
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  private rpc(method: string, params: Json, timeoutMs = RPC_TIMEOUT_MS): Promise<Json> {
    if (this.stopped) return Promise.reject(brief("Codex app-server has stopped"));
    const id = this.nextId++;
    return new Promise<Json>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(brief("Codex app-server RPC timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      try { this.send({ id, method, params }); }
      catch {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectCall(brief("Codex app-server could not accept an RPC"));
      }
    });
  }

  async initialize(): Promise<void> {
    const result = await this.rpc("initialize", {
      clientInfo: { name: "pi_bro_latency_probe", title: "Pi Bro latency probe", version: "0.1.0" },
    });
    if (!Object.keys(result).length) throw brief("Codex app-server initialization failed");
    this.send({ method: "initialized", params: {} });
  }

  async validateSubscription(): Promise<number> {
    if (!this.subscription) return 0;
    if (this.accountChanged) throw brief("Codex subscription changed; start a fresh probe");
    const began = performance.now();
    const config = await this.rpc("config/read", { includeLayers: false, cwd: this.cwd });
    const routeIssue = codexSubscriptionRouteProblem(config.config);
    if (routeIssue) throw brief("Codex effective provider is not the selected ChatGPT subscription route");
    const account = await this.rpc("account/read", { refreshToken: false });
    if (valueOf(account, "account", "type") !== "chatgpt") {
      throw brief("Codex app-server did not confirm ChatGPT subscription login");
    }
    return round(performance.now() - began);
  }

  async startThread(model: string): Promise<string> {
    const reply = await this.rpc("thread/start", {
      model, cwd: this.cwd, approvalPolicy: "never", sandbox: "read-only",
      serviceName: "pi_bro_latency_probe",
    });
    const id = valueOf(reply, "thread", "id");
    if (typeof id !== "string" || !id.trim()) throw brief("Codex did not return a thread id");
    if (this.subscription && valueOf(reply, "thread", "modelProvider") !== "openai") {
      throw brief("Codex thread did not confirm the built-in OpenAI provider");
    }
    return id;
  }

  async runTurn(threadId: string, model: string, prompt: string, effort?: string,
    deadlineMs = DEFAULT_TURN_DEADLINE_MS): Promise<TurnTiming> {
    if (this.active) throw brief("A Codex app-server turn is already active");
    const preflightMs = await this.validateSubscription();
    const startedAt = performance.now();
    let active!: ActiveTurn;
    const completion = new Promise<TurnTiming>((resolveTurn, rejectTurn) => {
      const timer = setTimeout(() => {
        if (this.active === active) this.active = undefined;
        rejectTurn(brief("Codex app-server turn timed out"));
      }, deadlineMs);
      active = { threadId, startedAt, resolve: resolveTurn, reject: rejectTurn, timer };
      this.active = active;
    });
    // Attach a handler immediately so a terminal event racing an RPC error
    // cannot create an unhandled promise rejection.
    void completion.catch(() => {});
    try {
      const started = await this.rpc("turn/start", {
        threadId, input: [{ type: "text", text: prompt }],
        cwd: this.cwd, approvalPolicy: "never", sandboxPolicy: { type: "readOnly" },
        model, ...(effort ? { effort } : {}),
      });
      const turnId = valueOf(started, "turn", "id");
      if (typeof turnId !== "string" || !turnId) throw brief("Codex did not acknowledge a turn id");
      active.id = turnId;
      this.tryFinishTurn();
      return { ...(await completion), preflightMs };
    } catch (error) {
      if (this.active === active) this.active = undefined;
      clearTimeout(active.timer);
      throw error;
    }
  }

  private signalProcess(signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && this.child.pid) {
      try { process.kill(-this.child.pid, signal); return; } catch { /* child likely exited */ }
    }
    try { this.child.kill(signal); } catch { /* already closed */ }
  }
  async close(): Promise<void> {
    this.failAll("Codex app-server probe closed");
    this.signalProcess("SIGTERM");
    const finished = await Promise.race([
      this.closed.then(() => true),
      new Promise<boolean>(done => setTimeout(() => done(false), 1500)),
    ]);
    if (!finished) {
      this.signalProcess("SIGKILL");
      await Promise.race([
        this.closed,
        new Promise<void>(done => setTimeout(done, 500)),
      ]);
    }
  }
}

export async function runProbe(options: {
  command?: string; cwd: string; model: string; effort?: string; turns: number;
  env: NodeJS.ProcessEnv; subscription: boolean;
  deadlineMs?: number;
}): Promise<Json> {
  const start = performance.now();
  const client = new CodexAppServerProbe(options);
  const timings: TurnTiming[] = [];
  try {
    await client.initialize();
    const startedMs = round(performance.now() - start);
    // Preflight before thread creation, then again before every turn.
    if (options.subscription) await client.validateSubscription();
    const threadId = await client.startThread(options.model);
    for (let turn = 0; turn < options.turns; turn++) {
      const prompt = turn ? "Reply with exactly OK again. Nothing else." : "Reply with exactly OK. Nothing else.";
      timings.push(await client.runTurn(threadId, options.model, prompt,
        options.effort, options.deadlineMs));
    }
    return { schema: 1, backend: "codex-app-server", authSource: options.subscription ? "subscription" : "inherit",
      model: options.model, effort: options.effort ?? null, startupAndHandshakeMs: startedMs,
      turns: timings, processReused: timings.length > 1 };
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const values = new Map<string, string>();
  let run = false;
  for (let i = 0; i < process.argv.slice(2).length; i++) {
    const argv = process.argv.slice(2);
    const name = argv[i];
    if (name === "--run") { run = true; continue; }
    if (!["--model", "--effort", "--cwd", "--turns"].includes(name) || values.has(name) ||
        !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw brief("Invalid probe arguments");
    }
    values.set(name, argv[++i]);
  }
  const model = values.get("--model");
  const turns = Number(values.get("--turns") ?? "3");
  if (!model || !Number.isInteger(turns) || turns < 2 || turns > 10) {
    throw brief("Choose --model and --turns 2..10");
  }
  const cwd = resolve(values.get("--cwd") ?? process.cwd());
  const auth = resolveCliChildAuth("codex");
  if (!run) {
    process.stdout.write(JSON.stringify({ backend: "codex-app-server", model, turns, cwd,
      authSource: auth.subscription ? "subscription" : "inherit",
      note: "Dry run. Add --run to permit model calls. No CLI started." }, null, 2) + "\n");
    return;
  }
  const result = await runProbe({ cwd, model, turns, effort: values.get("--effort"),
    env: auth.env, subscription: auth.subscription });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // No raw upstream error text: it may contain config or sensitive details.
    process.stderr.write("Codex app-server probe failed. Inspect CLI auth/version locally; no automatic retries.\n");
    process.exitCode = 1;
  });
}
