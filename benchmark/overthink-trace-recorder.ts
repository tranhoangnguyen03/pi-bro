/**
 * Local-only Pi extension for capturing Overthink evaluation traces.
 * Never packaged in npm (`package.json` excludes `benchmark/`).
 *
 * Load in a disposable or pilot Pi session with:
 *   pi -e ./benchmark/overthink-trace-recorder.ts
 *
 * Appends one JSON line per `agent_end` and `agent_settled` event to
 * `OVERTHINK_TRACE_FILE` (default: `benchmark/.work/overthink/traces.jsonl`).
 * Records only lifecycle metadata and entry positions, never full message bodies.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { overthinkContextPosition } from "../src/overthink-state.ts";
import { MIN_TOOL_RESULTS, accumulateOverthinkEvidence, type OverthinkRunEvidence } from "../src/overthink.ts";

const DEFAULT_TRACE_FILE = fileURLToPath(new URL("./.work/overthink/traces.jsonl", import.meta.url));
const HEADS_UP_MIN_TOOL_RESULTS = 3;

export type TraceEventRecord =
  | {
      version: 1;
      kind: "agent_end";
      timestamp: string;
      sessionId: string;
      sessionFile?: string;
      model?: string;
      thinkingLevel: string;
      position?: string;
      stopReason?: string;
      eventToolResults: number;
      accumulatedToolResults: number;
      hasPendingMessages: boolean;
      headsUpEligible: boolean;
    }
  | {
      version: 1;
      kind: "agent_settled";
      timestamp: string;
      sessionId: string;
      sessionFile?: string;
      model?: string;
      thinkingLevel: string;
      position?: string;
      aborted: boolean;
      hasPendingMessages: boolean;
      normalFinish: boolean;
      accumulatedToolResults: number;
      oldOverthinkEligible: boolean;
      pilotAllEligible: boolean;
      /** Any earlier agent_end position in this run where Heads-up was eligible. */
      headsUpEligiblePositions: string[];
    };

export function traceFilePath(): string {
  return process.env.OVERTHINK_TRACE_FILE ? resolve(process.env.OVERTHINK_TRACE_FILE) : DEFAULT_TRACE_FILE;
}

export function registerOverthinkTraceRecorder(
  pi: ExtensionAPI,
  writeRecord?: (record: TraceEventRecord) => Promise<void> | void,
): void {
  let evidence: OverthinkRunEvidence | undefined;
  let headsUpPositions: string[] = [];

  const emit = writeRecord ?? (async (record: TraceEventRecord) => {
    const file = traceFilePath();
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
  });

  const reset = () => {
    evidence = undefined;
    headsUpPositions = [];
  };

  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);

  pi.on("agent_end", (event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    const messages = event.messages as readonly { role: string; stopReason?: string }[];
    const last = messages.at(-1);
    const eventToolResults = messages.filter(m => m.role === "toolResult").length;
    const pending = ctx.hasPendingMessages();
    const stopReason = last?.role === "assistant" ? last.stopReason : undefined;
    const position = overthinkContextPosition(ctx.sessionManager.getBranch());

    evidence = accumulateOverthinkEvidence(evidence, { messages });
    const headsUpEligible = Boolean(
      ctx.model &&
      last?.role === "assistant" &&
      stopReason === "stop" &&
      !pending &&
      eventToolResults >= HEADS_UP_MIN_TOOL_RESULTS,
    );
    if (headsUpEligible && position) headsUpPositions.push(position);

    const record: TraceEventRecord = {
      version: 1,
      kind: "agent_end",
      timestamp: new Date().toISOString(),
      sessionId: ctx.sessionManager.getSessionId(),
      ...(ctx.sessionManager.getSessionFile() ? { sessionFile: ctx.sessionManager.getSessionFile() } : {}),
      ...(ctx.model ? { model: ctx.model.provider + "/" + ctx.model.id } : {}),
      thinkingLevel: pi.getThinkingLevel(),
      ...(position ? { position } : {}),
      ...(stopReason ? { stopReason } : {}),
      eventToolResults,
      accumulatedToolResults: evidence.toolResults,
      hasPendingMessages: pending,
      headsUpEligible,
    };
    void Promise.resolve(emit(record)).catch(() => undefined);
  });

  pi.on("agent_settled", (event, ctx: ExtensionContext) => {
    const completed = evidence;
    const eligiblePositions = [...headsUpPositions];
    reset();
    if (ctx.mode !== "tui") return;
    const pending = ctx.hasPendingMessages();
    const position = overthinkContextPosition(ctx.sessionManager.getBranch());
    const normalFinish = Boolean(completed?.normalFinish);
    const accumulatedToolResults = completed?.toolResults ?? 0;
    const pilotAllEligible = Boolean(ctx.model && !event.aborted && !pending && normalFinish);
    const oldOverthinkEligible = pilotAllEligible && accumulatedToolResults >= MIN_TOOL_RESULTS;

    const record: TraceEventRecord = {
      version: 1,
      kind: "agent_settled",
      timestamp: new Date().toISOString(),
      sessionId: ctx.sessionManager.getSessionId(),
      ...(ctx.sessionManager.getSessionFile() ? { sessionFile: ctx.sessionManager.getSessionFile() } : {}),
      ...(ctx.model ? { model: ctx.model.provider + "/" + ctx.model.id } : {}),
      thinkingLevel: pi.getThinkingLevel(),
      ...(position ? { position } : {}),
      aborted: event.aborted,
      hasPendingMessages: pending,
      normalFinish,
      accumulatedToolResults,
      oldOverthinkEligible,
      pilotAllEligible,
      headsUpEligiblePositions: eligiblePositions,
    };
    void Promise.resolve(emit(record)).catch(() => undefined);
  });
}

export default function (pi: ExtensionAPI): void {
  registerOverthinkTraceRecorder(pi);
}
