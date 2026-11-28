/**
 * Overthink replacement replay & blind-grading harness.
 * Offline `prepare` and `report`; live `run` requires explicit `--approve <fingerprint>`.
 * Never packaged in npm (`package.json` excludes `benchmark/`).
 */
import { createHash, randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext, type ThinkingLevel } from "@earendil-works/pi-ai";
import { convertToLlm, createAgentSession, ModelRuntime, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildOverthinkReviewContext, formatOverthinkFinding, formatOverthinkPreview,
  overthinkPrompt, parseOverthinkFinding, readOverthinkUsage,
  type OverthinkFinding, type OverthinkUsage,
} from "../src/overthink-state.ts";
import { errorMessage, isRecord } from "../src/util.ts";

export type EvalArm =
  | "heads-up"
  | "old-overthink"
  | "work"
  | "co-captain"
  | "co-captain-tki"
  | "pilot-labeled";

export const DIAGNOSTIC_ARMS: readonly EvalArm[] = [
  "heads-up",
  "old-overthink",
  "work",
  "co-captain",
  "co-captain-tki",
] as const;

export type EvalMode = "diagnostic" | "shipping";
export type EligibilityValue = boolean | "unknown";

export type OverthinkEvalCase = {
  id: string;
  title: string;
  split: "dev" | "holdout" | "synthetic";
  cell: "quiet" | "work" | "behavior" | "both";
  /** Sanitized excerpt frozen at the settled reply. */
  messages: AgentMessage[];
  /** Optional earlier prefix if Heads-up fired at an earlier agent_end in shipping mode. */
  headsUpMessages?: AgentMessage[];
  eligibility?: {
    headsUp?: EligibilityValue;
    oldOverthink?: EligibilityValue;
    pilotAll?: EligibilityValue;
    pilotSubstantive?: EligibilityValue;
  };
  gold: {
    expectAlert: boolean;
    knownFacts: string[];
    expectedNextMove: string;
    owner: string;
    acceptableAlternatives?: string[];
    whatIsNoise: string;
  };
};

export type OverthinkManifestRow = {
  callId: string;
  caseId: string;
  arm: EvalArm;
  mode: EvalMode;
  status: "scheduled" | "ineligible" | "unknown";
  model: string;
  effort: string;
  promptSha256: string;
  inputSha256: string;
};

export type OverthinkManifest = {
  version: 1;
  mode: EvalMode;
  model: string;
  effort: string;
  casesPath: string;
  arms: EvalArm[];
  rows: OverthinkManifestRow[];
  scheduledCalls: number;
  fingerprint: string;
};

export type OverthinkCallResult = {
  callId: string;
  caseId: string;
  arm: EvalArm;
  outcome: "finding" | "none" | "error";
  /** The visible short alert compared blind across arms (empty when outcome !== "finding"). */
  visibleAlert: string;
  /** Optional full view Markdown (for citation audit). */
  fullView?: string;
  finding?: OverthinkFinding;
  rawText?: string;
  error?: string;
  elapsedMs: number;
  usage?: OverthinkUsage;
};

// Exact installed pi-heads-up@0.1.4 prompt.
export const HEADS_UP_PROMPT = `[Heads-up mode] Look back at the last task in this conversation. Is there one thing the user should know because it changes what they should do next, and that they could easily have missed? For example a claim in the last reply that wasn't actually checked, a result that looks wrong, a tradeoff made without saying so, or a change beyond what they asked for. Don't flag general caveats or uncertainty that comes with the work, such as small samples, single runs or untested edge cases, unless it makes a stated conclusion unreliable. Leave out anything the last reply already says clearly, and anything minor. Most tasks need no heads-up. If there is such a thing, describe it in one or two plain sentences, at most 40 words, without markdown, in the user's language. Otherwise reply with exactly: NONE`;

// Exact old Overthink 0.38.1 factory questions (no preferences).
const OLD_OVERTHINK_QUESTIONS = [
  "Are we solving the right problem and moving toward the intended outcome?",
  "What important assumptions or conclusions might be wrong or insufficiently verified?",
  "What material risks, unintended changes, or needless complexity have we introduced?",
  "What correction, decision, or next step would most improve the outcome?",
] as const;

export function oldOverthinkPrompt(): string {
  return [
    "[Bro Overthink: private second look]",
    "Review the settled work using the preceding Pi conversation as evidence. The following are the user's questions, in order:",
    ...OLD_OVERTHINK_QUESTIONS.map((q, i) => String(i + 1) + ". " + q),
    "",
    "First decide whether there is a consequential point the user could easily miss that could change their next decision or the quality of the work.",
    "Flag an unchecked conclusion, important assumption, meaningful risk, unintended scope/complexity, or a better next move ONLY when supported by the conversation.",
    "Do not repeat concerns already clearly addressed, raise routine caveats, invent problems or demand tests for hypothetical edge cases. Most checks should produce no notification.",
    "If NOTHING material merits attention, reply with exactly NONE and nothing else.",
    "If something material merits attention, answer EVERY numbered question in order, even if most have no concern. For unaffected questions, write 'No material concern found' in the answer language. Do not manufacture criticism to fill the sections.",
    "Write for a tired reader who needs to understand on the first read: use plain, everyday words and short, direct sentences. Unpack loaded terms instead of compressing jargon, and skip filler or forced analogies.",
    "Reply with exactly one valid JSON object, without Markdown fences or other text:",
    JSON.stringify({
      summary: "Two or three short sentences about the material finding and its consequence.",
      answers: OLD_OVERTHINK_QUESTIONS.map((_q, i) => "Concise answer to question " + (i + 1)),
    }),
    "The answers array must have exactly 4 strings, one per question. Write in the user's language by default.",
    "Keep each answer to one or two brief sentences; name the concrete evidence or next move where relevant. Avoid repeating the summary. No need to force a severity rating.",
    "Respond in plain text only (either NONE or the JSON object above); do not call tools or take actions.",
  ].join("\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + stableJson(v)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function armEligibility(item: OverthinkEvalCase, arm: EvalArm, mode: EvalMode): "scheduled" | "ineligible" | "unknown" {
  if (mode === "diagnostic") return "scheduled";
  const elig = item.eligibility;
  let value: EligibilityValue | undefined;
  if (arm === "heads-up") value = elig?.headsUp;
  else if (arm === "old-overthink") value = elig?.oldOverthink;
  else value = elig?.pilotAll;
  if (value === true) return "scheduled";
  if (value === false) return "ineligible";
  return "unknown";
}

export function buildArmRequest(item: OverthinkEvalCase, arm: EvalArm, mode: EvalMode): {
  messages: ReturnType<typeof convertToLlm>;
  askText: string;
  maxTokens: number;
  sources: ReturnType<typeof buildOverthinkReviewContext>["sources"];
} {
  const rawMessages = arm === "heads-up" && mode === "shipping" && item.headsUpMessages?.length
    ? item.headsUpMessages
    : item.messages;
  const syntheticEntries = rawMessages.map((msg, i) => ({
    sourceEntry: { type: "message", id: item.id + "-m" + (i + 1), parentId: null, timestamp: "" } as unknown as SessionEntry,
    messages: [msg],
  }));

  if (arm === "heads-up") {
    return {
      messages: convertToLlm(rawMessages),
      askText: HEADS_UP_PROMPT,
      maxTokens: 2000,
      sources: [],
    };
  }
  if (arm === "old-overthink") {
    return {
      messages: convertToLlm(rawMessages),
      askText: oldOverthinkPrompt(),
      maxTokens: 2200,
      sources: [],
    };
  }
  const { messages, sources, sourceIndex } = buildOverthinkReviewContext({
    entries: syntheticEntries,
    messages: rawMessages,
  });
  const lens = arm === "work" ? "work" : (arm === "co-captain-tki" || arm === "pilot-labeled") ? "co-captain-tki" : "co-captain";
  const includeLabels = arm === "pilot-labeled";
  return {
    messages,
    askText: overthinkPrompt({ lens, includeLabels, sourceIndex }),
    maxTokens: 8192,
    sources,
  };
}

export function parseArmResponse(
  arm: EvalArm,
  rawText: string,
  sources: ReturnType<typeof buildOverthinkReviewContext>["sources"],
): Pick<OverthinkCallResult, "outcome" | "visibleAlert" | "fullView" | "finding" | "error"> {
  if (arm === "heads-up") {
    const cleaned = rawText.replace(/`/g, "").replace(/\s+/g, " ").trim();
    if (!cleaned || /^none\.?$/i.test(cleaned)) {
      return { outcome: "none", visibleAlert: "" };
    }
    return { outcome: "finding", visibleAlert: cleaned };
  }
  if (arm === "old-overthink") {
    const cleaned = rawText.replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (/^none\.?$/i.test(cleaned)) return { outcome: "none", visibleAlert: "" };
    const json = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```$/, "").trim();
    try {
      const data = JSON.parse(json) as unknown;
      if (!isRecord(data) || typeof data.summary !== "string" || !data.summary.trim() ||
          !Array.isArray(data.answers) || data.answers.length !== OLD_OVERTHINK_QUESTIONS.length) {
        return { outcome: "error", visibleAlert: "", error: "Old Overthink returned incomplete JSON." };
      }
      const summary = data.summary.trim();
      const answers = data.answers;
      const fullView = [
        "## Summary",
        summary,
        ...OLD_OVERTHINK_QUESTIONS.flatMap((q, i) => ["", "### " + (i + 1) + ". " + q, String(answers[i] ?? "")]),
      ].join("\n");
      return { outcome: "finding", visibleAlert: summary, fullView };
    } catch {
      return { outcome: "error", visibleAlert: "", error: "Old Overthink returned invalid JSON." };
    }
  }
  try {
    const allowLabel = arm === "pilot-labeled";
    const finding = parseOverthinkFinding(rawText, sources, { allowLabel });
    if (!finding) return { outcome: "none", visibleAlert: "" };
    return {
      outcome: "finding",
      visibleAlert: formatOverthinkPreview(finding).body,
      fullView: formatOverthinkFinding(finding),
      finding,
    };
  } catch (error) {
    return { outcome: "error", visibleAlert: "", error: errorMessage(error) };
  }
}

export function buildOverthinkManifest(options: {
  cases: readonly OverthinkEvalCase[];
  casesPath: string;
  model: string;
  effort: string;
  mode: EvalMode;
  arms: readonly EvalArm[];
}): OverthinkManifest {
  const rows: OverthinkManifestRow[] = [];
  for (const item of options.cases) {
    for (const arm of options.arms) {
      const status = armEligibility(item, arm, options.mode);
      const req = buildArmRequest(item, arm, options.mode);
      const promptSha256 = sha256(req.askText);
      const inputSha256 = sha256(stableJson(req.messages));
      const callId = sha256(stableJson({
        caseId: item.id, arm, mode: options.mode, model: options.model, effort: options.effort,
        maxTokens: req.maxTokens, promptSha256, inputSha256,
      })).slice(0, 16);
      rows.push({
        callId, caseId: item.id, arm, mode: options.mode, status,
        model: options.model, effort: options.effort, promptSha256, inputSha256,
      });
    }
  }
  const scheduledCalls = rows.filter(r => r.status === "scheduled").length;
  const body = {
    version: 1 as const,
    mode: options.mode,
    model: options.model,
    effort: options.effort,
    casesPath: options.casesPath,
    arms: [...options.arms],
    rows,
    scheduledCalls,
  };
  return { ...body, fingerprint: sha256(stableJson(body)).slice(0, 16) };
}

function deterministicShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const hash = createHash("sha256").update(seed + ":" + i).digest();
    const j = hash.readUInt32BE(0) % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function generateBlindReport(
  manifest: OverthinkManifest,
  cases: readonly OverthinkEvalCase[],
  resultsByCallId: ReadonlyMap<string, OverthinkCallResult>,
  seed?: string,
): {
  blindSheetMd: string;
  blindKey: Record<string, Array<{ option: string; arm: EvalArm; callId: string; outcome: string }>>;
  fullViewsMd: string;
  summary: Record<string, unknown>;
} {
  const caseById = new Map(cases.map(c => [c.id, c]));
  const blindLines: string[] = [
    "# Overthink blind grading sheet",
    "",
    `Mode: \`${manifest.mode}\` · Model: \`${manifest.model}\` · Effort: \`${manifest.effort}\` · Fingerprint: \`${manifest.fingerprint}\``,
    "",
    "Score each visible option blind (tool names and labels are hidden): **Supported?**, **New?**, **Right next move?**, or **Noise / Harmful?**",
    "",
  ];
  const fullLines: string[] = [
    "# Overthink full views (audit after blind grading)",
    "",
  ];
  const blindKey: Record<string, Array<{ option: string; arm: EvalArm; callId: string; outcome: string }>> = {};
  const byArm: Record<string, { finding: number; none: number; error: number; ineligible: number; unknown: number; costTotal: number; elapsedMs: number[] }> = {};

  for (const arm of manifest.arms) {
    byArm[arm] = { finding: 0, none: 0, error: 0, ineligible: 0, unknown: 0, costTotal: 0, elapsedMs: [] };
  }

  for (const item of cases) {
    const rows = manifest.rows.filter(r => r.caseId === item.id);
    const shuffled = seed !== undefined
      ? deterministicShuffle(rows, seed + ":" + item.id)
      : [...rows].sort(() => randomInt(-1, 2));

    blindLines.push(`## ${item.id} — ${item.title} (${item.split} · ${item.cell})`);
    blindLines.push(`- **Expect alert:** ${item.gold.expectAlert ? "Yes" : "No (stay quiet)"}`);
    blindLines.push(`- **Expected next move (${item.gold.owner}):** ${item.gold.expectedNextMove}`);
    blindLines.push(`- **Known facts:** ${item.gold.knownFacts.join(" | ")}`);
    blindLines.push(`- **What is noise:** ${item.gold.whatIsNoise}`);
    blindLines.push("");

    fullLines.push(`## ${item.id} — ${item.title}`);
    fullLines.push("");

    const keyEntries: Array<{ option: string; arm: EvalArm; callId: string; outcome: string }> = [];
    shuffled.forEach((row, idx) => {
      const option = "Option " + String.fromCharCode(65 + idx);
      const stats = byArm[row.arm]!;
      if (row.status === "ineligible") {
        stats.ineligible++;
        keyEntries.push({ option, arm: row.arm, callId: row.callId, outcome: "ineligible" });
        blindLines.push(`### ${option}`);
        blindLines.push("_(Ineligible under shipping gate — no alert)_");
        blindLines.push("");
        return;
      }
      if (row.status === "unknown") {
        stats.unknown++;
        keyEntries.push({ option, arm: row.arm, callId: row.callId, outcome: "unknown" });
        blindLines.push(`### ${option}`);
        blindLines.push("_(Baseline eligibility unknown — not scored as a win)_");
        blindLines.push("");
        return;
      }
      const res = resultsByCallId.get(row.callId);
      if (!res) {
        keyEntries.push({ option, arm: row.arm, callId: row.callId, outcome: "missing" });
        blindLines.push(`### ${option}`);
        blindLines.push("_(Result missing)_");
        blindLines.push("");
        return;
      }
      stats[res.outcome]++;
      if (res.usage?.costTotal !== undefined) stats.costTotal += res.usage.costTotal;
      stats.elapsedMs.push(res.elapsedMs);
      keyEntries.push({ option, arm: row.arm, callId: row.callId, outcome: res.outcome });

      blindLines.push(`### ${option}`);
      if (res.outcome === "none") {
        blindLines.push("_NONE (quiet)_");
      } else if (res.outcome === "error") {
        blindLines.push(`_ERROR: ${res.error ?? "unknown"}_`);
      } else {
        // Never show label badges in the blind alert text.
        blindLines.push("> " + res.visibleAlert);
      }
      blindLines.push("- [ ] Supported  [ ] New  [ ] Right next move  [ ] Noise  [ ] Harmful");
      blindLines.push("");

      if (res.fullView) {
        fullLines.push(`### ${row.arm} (${option})`);
        fullLines.push(res.fullView);
        fullLines.push("");
      }
    });
    blindKey[item.id] = keyEntries;
  }

  // Ensure every case ID in manifest was covered.
  void caseById;
  return {
    blindSheetMd: blindLines.join("\n"),
    blindKey,
    fullViewsMd: fullLines.join("\n"),
    summary: {
      fingerprint: manifest.fingerprint,
      mode: manifest.mode,
      model: manifest.model,
      effort: manifest.effort,
      cases: cases.length,
      byArm,
    },
  };
}

export async function runOverthinkManifest(
  runDir: string,
  approveFingerprint: string,
): Promise<{ completed: number; skipped: number; errors: number }> {
  const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as OverthinkManifest;
  if (manifest.fingerprint !== approveFingerprint) {
    throw new Error(`Fingerprint mismatch: expected ${manifest.fingerprint}, got ${approveFingerprint}.`);
  }
  const cases = JSON.parse(await readFile(manifest.casesPath, "utf8")) as OverthinkEvalCase[];
  const caseById = new Map(cases.map(c => [c.id, c]));
  const [provider, ...idParts] = manifest.model.split("/");
  const modelId = idParts.join("/");
  if (!provider || !modelId) throw new Error(`Model must be <provider>/<modelId>, got ${manifest.model}.`);

  let runtime = await ModelRuntime.create();
  let model = runtime.getModel(provider, modelId);
  let boundSession: { dispose?: () => Promise<void> | void } | undefined;
  if (!model) {
    // Extension-registered providers (e.g. antigravity, claude-code) register during bindExtensions().
    const created = await createAgentSession({ sessionManager: SessionManager.inMemory(), noTools: "all" });
    await created.session.bindExtensions({});
    boundSession = created.session;
    runtime = created.session.modelRuntime;
    model = runtime.getModel(provider, modelId);
  }
  if (!model) throw new Error(`Model not found in Pi ModelRuntime: ${manifest.model}.`);
  if (!runtime.hasConfiguredAuth(model.provider)) {
    throw new Error(`No configured auth for provider ${model.provider}.`);
  }

  const resultsDir = join(runDir, "results");
  await mkdir(resultsDir, { recursive: true });
  let completed = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of manifest.rows) {
    if (row.status !== "scheduled") continue;
    const outPath = join(resultsDir, row.callId + ".json");
    try {
      await readFile(outPath, "utf8");
      skipped++;
      continue;
    } catch { /* Not yet executed. */ }

    const item = caseById.get(row.caseId);
    if (!item) throw new Error(`Missing case ${row.caseId} in ${manifest.casesPath}.`);
    const req = buildArmRequest(item, row.arm, manifest.mode);
    const ask = {
      role: "user" as const,
      content: [{ type: "text" as const, text: req.askText }],
      timestamp: Date.now(),
    };
    const started = Date.now();
    let result: OverthinkCallResult;
    try {
      const effort = manifest.effort as ThinkingLevel | "off";
      const answer = await runtime.streamSimple(
        model,
        normalizeContext({ messages: [...req.messages, ask] }),
        {
          reasoning: model.reasoning && effort !== "off" ? effort : undefined,
          maxTokens: req.maxTokens,
        },
      ).result();
      const elapsedMs = Date.now() - started;
      const usage = readOverthinkUsage(answer.usage);
      if (answer.stopReason !== "stop") {
        const detail = typeof answer.errorMessage === "string" && answer.errorMessage.trim()
          ? ": " + answer.errorMessage.trim() : "";
        result = {
          callId: row.callId, caseId: row.caseId, arm: row.arm,
          outcome: "error", visibleAlert: "",
          error: `Model stopped with ${answer.stopReason}${detail}`,
          elapsedMs, ...(usage ? { usage } : {}),
        };
        errors++;
      } else {
        const rawText = answer.content.filter(p => p.type === "text").map(p => p.text).join("");
        const parsed = parseArmResponse(row.arm, rawText, req.sources);
        if (parsed.outcome === "error") errors++;
        result = {
          callId: row.callId, caseId: row.caseId, arm: row.arm,
          ...parsed, rawText, elapsedMs, ...(usage ? { usage } : {}),
        };
      }
    } catch (error) {
      errors++;
      result = {
        callId: row.callId, caseId: row.caseId, arm: row.arm,
        outcome: "error", visibleAlert: "", error: errorMessage(error),
        elapsedMs: Date.now() - started,
      };
    }
    await writeFile(outPath, JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    completed++;
    process.stdout.write(`[${completed + skipped}/${manifest.scheduledCalls}] ${row.caseId} · ${row.arm} -> ${result.outcome} (${result.elapsedMs}ms)\n`);
  }
  if (boundSession) {
    // Keep extension timers from holding the CLI process open after all results are written.
    process.on("beforeExit", () => { process.exit(0); });
  }
  return { completed, skipped, errors };
}

function parseArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, dirArg, ...rest] = process.argv.slice(2);
  if (!cmd || !dirArg || !["prepare", "run", "report"].includes(cmd)) {
    console.error("Usage:\n  node --experimental-transform-types benchmark/overthink.ts prepare <dir> --cases <file> --model <provider/id> [--effort high] [--mode diagnostic|shipping] [--arms a,b]\n  node --experimental-transform-types benchmark/overthink.ts run <dir> --approve <fingerprint>\n  node --experimental-transform-types benchmark/overthink.ts report <dir>");
    process.exitCode = 1;
    return;
  }
  const runDir = resolve(dirArg);

  if (cmd === "prepare") {
    const casesArg = parseArg(rest, "--cases");
    const model = parseArg(rest, "--model");
    const effort = parseArg(rest, "--effort") ?? "high";
    const mode = (parseArg(rest, "--mode") ?? "diagnostic") as EvalMode;
    const armsRaw = parseArg(rest, "--arms");
    if (!casesArg || !model) throw new Error("--cases and --model are required.");
    const casesPath = resolve(casesArg);
    const cases = JSON.parse(await readFile(casesPath, "utf8")) as OverthinkEvalCase[];
    const arms = armsRaw ? (armsRaw.split(",").map(s => s.trim()) as EvalArm[]) : [...DIAGNOSTIC_ARMS];
    const manifest = buildOverthinkManifest({ cases, casesPath, model, effort, mode, arms });
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    console.log(JSON.stringify({
      runDir, mode, model, effort,
      cases: cases.length,
      arms,
      scheduledCalls: manifest.scheduledCalls,
      fingerprint: manifest.fingerprint,
    }, null, 2));
    return;
  }

  if (cmd === "run") {
    const approve = parseArg(rest, "--approve");
    if (!approve) throw new Error("--approve <fingerprint> is required.");
    const stats = await runOverthinkManifest(runDir, approve);
    console.log("Run finished:", JSON.stringify(stats));
    process.exit(0);
  }

  if (cmd === "report") {
    const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as OverthinkManifest;
    const cases = JSON.parse(await readFile(manifest.casesPath, "utf8")) as OverthinkEvalCase[];
    const results = new Map<string, OverthinkCallResult>();
    for (const row of manifest.rows) {
      if (row.status !== "scheduled") continue;
      try {
        const res = JSON.parse(await readFile(join(runDir, "results", row.callId + ".json"), "utf8")) as OverthinkCallResult;
        results.set(row.callId, res);
      } catch { /* Missing result recorded as missing. */ }
    }
    const { blindSheetMd, blindKey, fullViewsMd, summary } = generateBlindReport(manifest, cases, results, manifest.fingerprint);
    await writeFile(join(runDir, "blind-sheet.md"), blindSheetMd + "\n", { encoding: "utf8", mode: 0o600 });
    await writeFile(join(runDir, "blind-key.json"), JSON.stringify(blindKey, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await writeFile(join(runDir, "full-views.md"), fullViewsMd + "\n", { encoding: "utf8", mode: 0o600 });
    await writeFile(join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    console.log("Wrote blind-sheet.md, blind-key.json, full-views.md, and summary.json in", runDir);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
}
