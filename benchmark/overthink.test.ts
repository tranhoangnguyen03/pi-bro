import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerOverthinkTraceRecorder, type TraceEventRecord } from "./overthink-trace-recorder.ts";
import {
  DIAGNOSTIC_ARMS, HEADS_UP_PROMPT,
  buildArmRequest, buildOverthinkManifest, generateBlindReport,
  parseArmResponse, runOverthinkManifest,
  type OverthinkCallResult, type OverthinkEvalCase,
} from "./overthink.ts";

test("trace recorder logs exact agent_end and agent_settled eligibility for 2+1 continuation, zero-tool, and pending runs", () => {
  const callbacks: Record<string, (...args: any[]) => any> = {};
  const records: TraceEventRecord[] = [];
  let branch: SessionEntry[] = [
    { type: "message", id: "m1", message: { role: "assistant", content: [] } } as unknown as SessionEntry,
  ];
  let pending = false;
  const pi = {
    on: (name: string, fn: (...args: any[]) => any) => { callbacks[name] = fn; },
    getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    model: { provider: "openai-codex", id: "gpt-6.2-sol" },
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "s-trace",
      getSessionFile: () => "/tmp/s-trace.jsonl",
    },
    hasPendingMessages: () => pending,
  } as unknown as ExtensionContext;

  registerOverthinkTraceRecorder(pi, record => { records.push(record); });

  // 2+1 continuation: neither agent_end hits 3 tool results (Heads-up ineligible),
  // but settled-run total reaches 3 (old Overthink eligible).
  callbacks.agent_end({ messages: [{ role: "toolResult" }, { role: "toolResult" }, { role: "assistant", stopReason: "toolUse" }] }, ctx);
  branch = [...branch, { type: "message", id: "m2", message: { role: "assistant", content: [] } } as unknown as SessionEntry];
  callbacks.agent_end({ messages: [{ role: "toolResult" }, { role: "assistant", stopReason: "stop" }] }, ctx);
  callbacks.agent_settled({ aborted: false }, ctx);

  assert.equal(records.length, 3);
  assert.equal(records[0]!.kind, "agent_end");
  assert.equal(records[0]!.headsUpEligible, false);
  assert.equal(records[1]!.kind, "agent_end");
  assert.equal(records[1]!.headsUpEligible, false);
  assert.equal(records[2]!.kind, "agent_settled");
  if (records[2]!.kind === "agent_settled") {
    assert.equal(records[2]!.accumulatedToolResults, 3);
    assert.equal(records[2]!.oldOverthinkEligible, true);
    assert.equal(records[2]!.pilotAllEligible, true);
    assert.deepEqual(records[2]!.headsUpEligiblePositions, []);
  }

  // Zero-tool settled turn: pilotAll eligible, oldOverthink and Heads-up ineligible.
  branch = [...branch, { type: "message", id: "m3", message: { role: "assistant", content: [] } } as unknown as SessionEntry];
  callbacks.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
  callbacks.agent_settled({ aborted: false }, ctx);
  const settledZero = records.at(-1)!;
  assert.equal(settledZero.kind, "agent_settled");
  if (settledZero.kind === "agent_settled") {
    assert.equal(settledZero.pilotAllEligible, true);
    assert.equal(settledZero.oldOverthinkEligible, false);
  }

  // Pending follow-up suppresses both Heads-up and settled eligibility.
  pending = true;
  callbacks.agent_end({ messages: [{ role: "toolResult" }, { role: "toolResult" }, { role: "toolResult" }, { role: "assistant", stopReason: "stop" }] }, ctx);
  callbacks.agent_settled({ aborted: false }, ctx);
  const endPending = records.at(-2)!;
  const settledPending = records.at(-1)!;
  assert.equal(endPending.kind === "agent_end" && endPending.headsUpEligible, false);
  assert.equal(settledPending.kind === "agent_settled" && settledPending.pilotAllEligible, false);
});

const SAMPLE_CASE: OverthinkEvalCase = {
  id: "case-1",
  title: "Draft vs sent",
  split: "dev",
  cell: "behavior",
  messages: [
    { role: "user", content: [{ type: "text", text: "Draft only, do not send." }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "I sent the message." }], api: "demo", provider: "demo", model: "m", usage: {} as any, stopReason: "stop", timestamp: 2 },
  ],
  headsUpMessages: [
    { role: "user", content: [{ type: "text", text: "Draft only, do not send." }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "Checking draft." }], api: "demo", provider: "demo", model: "m", usage: {} as any, stopReason: "stop", timestamp: 2 },
  ],
  eligibility: { headsUp: true, oldOverthink: false, pilotAll: true },
  gold: {
    expectAlert: true,
    knownFacts: ["User asked for draft only", "Assistant sent it"],
    expectedNextMove: "Inspect the sent message and decide whether to retract it.",
    owner: "user",
    whatIsNoise: "Complaining about tone.",
  },
};

test("replay manifest is deterministic, enforces fingerprint approval, isolates arms, and handles shipping eligibility", async () => {
  const m1 = buildOverthinkManifest({
    cases: [SAMPLE_CASE], casesPath: "/tmp/cases.json",
    model: "demo/m", effort: "high", mode: "diagnostic", arms: DIAGNOSTIC_ARMS,
  });
  const m2 = buildOverthinkManifest({
    cases: [SAMPLE_CASE], casesPath: "/tmp/cases.json",
    model: "demo/m", effort: "high", mode: "diagnostic", arms: DIAGNOSTIC_ARMS,
  });
  assert.equal(m1.fingerprint, m2.fingerprint);
  assert.equal(m1.scheduledCalls, 5);

  // Verify exact Heads-up prompt and label-free diagnostic replacement prompts.
  assert.equal(buildArmRequest(SAMPLE_CASE, "heads-up", "diagnostic").askText, HEADS_UP_PROMPT);
  const workReq = buildArmRequest(SAMPLE_CASE, "work", "diagnostic");
  assert.doesNotMatch(workReq.askText, /\blabel\b/i);
  assert.match(workReq.askText, /\[#1 · user\] Draft only/);

  // Shipping mode uses headsUpMessages prefix for Heads-up and marks ineligible/unknown rows.
  const shipping = buildOverthinkManifest({
    cases: [SAMPLE_CASE, { ...SAMPLE_CASE, id: "case-2", eligibility: { headsUp: "unknown", oldOverthink: true, pilotAll: true } }],
    casesPath: "/tmp/cases.json", model: "demo/m", effort: "high", mode: "shipping",
    arms: ["heads-up", "old-overthink", "co-captain"],
  });
  assert.equal(shipping.rows.find(r => r.caseId === "case-1" && r.arm === "old-overthink")?.status, "ineligible");
  assert.equal(shipping.rows.find(r => r.caseId === "case-2" && r.arm === "heads-up")?.status, "unknown");
  const huShipReq = buildArmRequest(SAMPLE_CASE, "heads-up", "shipping");
  assert.match(JSON.stringify(huShipReq.messages), /Checking draft/);

  // Fingerprint mismatch rejects before any model call.
  const dir = await mkdtemp(join(tmpdir(), "bro-overthink-eval-"));
  try {
    await writeFile(join(dir, "manifest.json"), JSON.stringify(m1));
    await assert.rejects(() => runOverthinkManifest(dir, "wrong-fingerprint"), /Fingerprint mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("blind report hides arm names and labels, preserves ineligible/unknown status, and emits full views separately", () => {
  const manifest = buildOverthinkManifest({
    cases: [SAMPLE_CASE], casesPath: "/tmp/cases.json",
    model: "demo/m", effort: "high", mode: "shipping",
    arms: ["heads-up", "old-overthink", "pilot-labeled"],
  });
  const pilotRow = manifest.rows.find(r => r.arm === "pilot-labeled")!;
  const huRow = manifest.rows.find(r => r.arm === "heads-up")!;
  const req = buildArmRequest(SAMPLE_CASE, "pilot-labeled", "shipping");
  const parsed = parseArmResponse("pilot-labeled", JSON.stringify({
    label: "Overstepped",
    finding: "You asked for a draft, but Pi sent it.",
    nextMove: "Inspect the sent message now.",
    situation: "You asked for a draft only.",
    evidence: [{ ref: 1, detail: "Draft-only instruction." }, { ref: 2, detail: "Sent confirmation." }],
    whyItMatters: "Recipients may already see it.",
  }), req.sources);

  const results = new Map<string, OverthinkCallResult>([
    [huRow.callId, { callId: huRow.callId, caseId: "case-1", arm: "heads-up", outcome: "none", visibleAlert: "", elapsedMs: 120 }],
    [pilotRow.callId, { callId: pilotRow.callId, caseId: "case-1", arm: "pilot-labeled", ...parsed, elapsedMs: 240 }],
  ]);

  const { blindSheetMd, blindKey, fullViewsMd } = generateBlindReport(manifest, [SAMPLE_CASE], results, "seed-1");
  assert.doesNotMatch(blindSheetMd, /heads-up|old-overthink|pilot-labeled|Overstepped/);
  assert.match(blindSheetMd, /You asked for a draft, but Pi sent it\. Inspect the sent message now\./);
  assert.match(blindSheetMd, /Ineligible under shipping gate/);
  assert.equal(blindKey["case-1"]!.length, 3);
  assert.match(fullViewsMd, /## Overstepped/);
  assert.match(fullViewsMd, /\[#1 · user\] Draft-only instruction\./);
});
