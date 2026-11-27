/** Automatic same-model second look. One actionable alert or silence, with inspectable evidence. */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { matchesKey, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { modalHeight, openBroOverlay, renderFrame, Scroller, formatNotice, type Theme } from "./modal-kit.ts";
import { hasBroCustomUi } from "./ui-capabilities.ts";
import {
  allowBranchAutomaticChecks, buildOverthinkReviewContext, formatOverthinkEvidenceLine,
  formatOverthinkFinding, formatOverthinkPreview, overthinkContextPosition, overthinkIsStale,
  overthinkPrompt, overthinkTurnState, parseOverthinkFinding, readGlobalOverthink,
  readOverthinkUsage, resolveOverthinkSession, saveOverthinkFailure, saveOverthinkNote,
  shouldRunAutomaticOverthink,
  type OverthinkFinding, type OverthinkGlobal, type OverthinkNote, type OverthinkPromptOptions, type OverthinkSession,
} from "./overthink-state.ts";
import { readPreferences } from "./settings.ts";
import { errorMessage } from "./util.ts";

export const MIN_TOOL_RESULTS = 3;
export type OverthinkGate = "all" | "substantive";
// shortcut: pilot checks all normally settled turns; switch to "substantive" if eval rejects broader coverage.
export const PILOT_OVERTHINK_GATE: OverthinkGate = "all";

const WIDGET = "bro-overthink";
const NOTE_TIMEOUT_MS = 90_000;
const MAX_PREVIEW_FINDING_LINES = 6;

type CheckContext = ExtensionContext | ExtensionCommandContext;

export type OverthinkRunEvidence = { toolResults: number; normalFinish: boolean };

/** Collect evidence at each agent_end, but never start a check until agent_settled. */
export function accumulateOverthinkEvidence(
  prior: OverthinkRunEvidence | undefined,
  event: { messages: readonly { role: string; stopReason?: string }[] },
): OverthinkRunEvidence {
  const last = event.messages.at(-1);
  return {
    toolResults: (prior?.toolResults ?? 0) + event.messages.filter(m => m.role === "toolResult").length,
    normalFinish: last?.role === "assistant" && last.stopReason === "stop",
  };
}

export function overthinkReady(
  evidence: OverthinkRunEvidence | undefined,
  aborted: boolean,
  pending: boolean,
  gate: OverthinkGate = PILOT_OVERTHINK_GATE,
): boolean {
  if (aborted || pending || !evidence?.normalFinish) return false;
  return gate === "substantive" ? evidence.toolResults >= MIN_TOOL_RESULTS : true;
}

function wrapPreviewFinding(text: string, width: number): string[] {
  const lines = wrapTextWithAnsi(text.replace(/\s+/g, " ").trim(), width);
  if (lines.length <= MAX_PREVIEW_FINDING_LINES) return lines;
  const kept = lines.slice(0, MAX_PREVIEW_FINDING_LINES);
  const last = kept[kept.length - 1]!;
  kept[kept.length - 1] = last.length > 1 ? last.slice(0, Math.max(1, width - 1)) + "…" : "…";
  return kept;
}

function noteWidget(ctx: CheckContext, finding?: OverthinkFinding, sourcePosition?: string): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setWidget(WIDGET, finding
    ? (_tui, theme) => ({
        invalidate() {},
        render(width: number) {
          // Hide immediately if compaction, context edits, or later messages moved the branch.
          if (sourcePosition && overthinkContextPosition(ctx.sessionManager.getBranch()) !== sourcePosition) {
            return [];
          }
          const { header } = formatOverthinkPreview(finding);
          const bodyWidth = Math.max(12, width - 2);
          const findingLines = wrapPreviewFinding(finding.finding, bodyWidth);
          const nextMoveLines = wrapTextWithAnsi(finding.nextMove.replace(/\s+/g, " ").trim(), bodyWidth);
          return [
            "",
            theme.fg("warning", header),
            ...findingLines.map(line => "  " + theme.fg("muted", line)),
            ...nextMoveLines.map(line => "  " + theme.fg("text", line)),
            theme.fg("dim", "  /bro overthink for evidence"),
          ];
        },
      })
    : undefined);
}

/** A reported zero may mean a miss OR a provider that does not support cache accounting. */
export function usageStatus(note: OverthinkNote | undefined): string[] {
  const u = note?.usage;
  if (!u) return ["Cost/usage: not reported by provider."];
  const totals = [
    u.input !== undefined ? "input " + u.input.toLocaleString("en-US") : undefined,
    u.cacheRead !== undefined ? "cache read " + u.cacheRead.toLocaleString("en-US") : undefined,
    u.cacheWrite !== undefined ? "cache write " + u.cacheWrite.toLocaleString("en-US") : undefined,
    u.output !== undefined ? "output " + u.output.toLocaleString("en-US") : undefined,
    u.reasoning !== undefined ? "reasoning " + u.reasoning.toLocaleString("en-US") : undefined,
  ].filter((value): value is string => value !== undefined);
  const cost = u.costTotal !== undefined ? " · est. cost $" + u.costTotal.toFixed(6) + " (Pi price table; not billed amount)" : "";
  return [
    "Provider-reported tokens: " + (totals.length ? totals.join(" · ") : "token counts unavailable") + cost,
    ...(u.cacheRead === 0 ? ["Cache read 0 can mean no hit or caching unsupported."] : []),
  ];
}

function shortDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function renderFindingSection(
  add: (value: string, color?: "accent" | "muted") => void,
  finding: OverthinkFinding,
): void {
  add(finding.label ?? "Finding", "accent");
  add(finding.finding);
  add("");
  add("Next move", "accent");
  add(finding.nextMove);
  add("");
  add("Situation", "accent");
  add(finding.situation);
  add("");
  add("Evidence", "accent");
  for (const item of finding.evidence) {
    add("• " + formatOverthinkEvidenceLine(item));
  }
  add("");
  add("Why it matters", "accent");
  add(finding.whyItMatters);
}

function renderLegacyNote(
  add: (value: string, color?: "accent" | "muted") => void,
  note: OverthinkNote,
): void {
  if (note.assessment) {
    add("Earlier assessment (legacy)", "accent");
    add(note.assessment.summary);
    note.assessment.questions.forEach((question, i) => {
      add("");
      add((i + 1) + ". " + question, "muted");
      add(note.assessment!.answers[i] ?? "");
    });
  } else if (note.text) {
    add("Earlier assessment (legacy plain text)", "accent");
    note.text.split("\n").forEach(line => add(line));
  } else {
    add("Earlier assessment (legacy — nothing flagged). Ctrl+R checks this turn with the current reviewer.", "muted");
  }
}

function renderPreviousNote(
  add: (value: string, color?: "accent" | "muted") => void,
  note: OverthinkNote,
  position: string | undefined,
): void {
  const staleReason = overthinkIsStale(note, position)
    ? (note.sourcePosition ? "OUTDATED · earlier turn" : "source position not recorded")
    : "earlier check";
  add("");
  add("Earlier check (" + staleReason + " · " + shortDate(note.checkedAt) + " · " + note.model + ")", "muted");
  add("");
  if (note.finding) renderFindingSection(add, note.finding);
  else renderLegacyNote(add, note);
}

export type OverthinkViewerSnapshot = {
  session: OverthinkSession;
  position?: string;
  checking?: boolean;
  globalAutomatic?: boolean;
};

export function createOverthinkViewer(
  read: () => OverthinkViewerSnapshot,
  retry: () => Promise<OverthinkNote>,
  allowBranch?: () => void,
) {
  return (tui: TUI, theme: Theme, _keys: unknown, done: () => void): Component => {
    let help = false;
    let showUsage = false;
    let busy = false;
    let closed = false;
    let notice = "";
    const scroller = new Scroller(() => tui.requestRender());

    const copyTarget = (): { note?: OverthinkNote; earlier: boolean } => {
      const { session, position } = read();
      const turn = overthinkTurnState(session, position);
      if (turn.state === "finding" || turn.state === "none" || turn.state === "legacy") {
        return { note: turn.note, earlier: false };
      }
      return { note: turn.previousNote, earlier: true };
    };

    const copy = async () => {
      const { note, earlier } = copyTarget();
      if (!note?.text) { notice = formatNotice(theme, "Nothing to copy yet.", "warning"); tui.requestRender(); return; }
      try {
        await copyToClipboard(note.text);
        notice = formatNotice(theme, earlier ? "Earlier assessment copied." : "Assessment copied.", "success");
      }
      catch (error) { notice = formatNotice(theme, "Copy failed: " + errorMessage(error), "error"); }
      tui.requestRender();
    };

    const rerun = async () => {
      if (busy || closed) return;
      busy = true; notice = ""; tui.requestRender();
      try {
        const result = await retry();
        if (!closed) {
          scroller.toStart();
          notice = formatNotice(theme, result.finding ? "Check refreshed." : "Checked — nothing material to flag.", "success");
        }
      } catch (error) {
        if (!closed) notice = formatNotice(theme, "Check failed: " + errorMessage(error), "error");
      } finally { busy = false; if (!closed) tui.requestRender(); }
    };

    const allow = () => {
      const snapshot = read();
      if (!snapshot.session.branchOptOut || !allowBranch) return;
      allowBranch();
      notice = formatNotice(
        theme,
        snapshot.globalAutomatic
          ? "Automatic checks allowed on this branch."
          : "Allowed on this branch (enable global automatic checks in /bro config to run automatically).",
        "success",
      );
      tui.requestRender();
    };

    return {
      render(width: number) {
        const { session, position, checking, globalAutomatic } = read();
        const isChecking = busy || Boolean(checking);
        const turn = overthinkTurnState(session, position, isChecking ? position : undefined);
        const inner = Math.max(1, width - 2);
        const lines: string[] = [];
        const add = (value: string, color?: "accent" | "muted") => {
          const styled = color ? theme.fg(color, color === "accent" ? theme.bold(value) : value) : value;
          lines.push(...wrapTextWithAnsi(styled, inner));
        };

        if (help) {
          [
            "Overthink gives Pi's latest settled turn one private second look using the active Pi model.",
            "Enable automatic checks in /bro config → Features → Overthink. Notes stay out of Pi's conversation.",
            "",
            "Ctrl+R  Recheck the current turn now",
            ...(session.branchOptOut && allowBranch ? ["A       Allow automatic checks on this branch (clears legacy empty-list opt-out)"] : []),
            "U       Show or hide provider-reported token, cache and estimated-cost details",
            "?       Toggle help",
            "Ctrl+C  Copy the displayed finding as Markdown",
            "Esc     Close / back from help",
          ].forEach(value => add(value));
        } else {
          if (turn.state === "checking") {
            add("Checking the current turn…", "muted");
          } else if (turn.state === "failed") {
            add("Check failed · " + shortDate(turn.failure.checkedAt) + " · " + turn.failure.model, "muted");
          } else if (turn.state === "finding" || turn.state === "none") {
            add("Reviewed: current turn · " + shortDate(turn.note.checkedAt) + " · " + turn.note.model, "muted");
          } else if (turn.state === "legacy") {
            add("Earlier assessment (legacy) · " + shortDate(turn.note.checkedAt) + " · " + turn.note.model, "muted");
          } else {
            add("Not checked for this turn.", "muted");
          }

          if (session.branchOptOut && allowBranch) {
            add("");
            add(
              "Automatic checks are off on this branch (legacy empty question list). Press A to allow automatic checks on this branch." +
                (globalAutomatic ? "" : " Global automatic checks are currently off in /bro config."),
              "muted",
            );
          }

          const usageNote = turn.state === "finding" || turn.state === "none" || turn.state === "legacy"
            ? turn.note : turn.previousNote;
          if (showUsage) {
            add("");
            add("Usage details", "accent");
            usageStatus(usageNote).forEach(value => add(value));
          }

          add("");
          if (turn.state === "checking") {
            add("Checking the current turn…");
            if (turn.previousNote) renderPreviousNote(add, turn.previousNote, position);
          } else if (turn.state === "failed") {
            add("Check failed", "accent");
            add(turn.failure.error);
            if (turn.previousNote) renderPreviousNote(add, turn.previousNote, position);
          } else if (turn.state === "finding") {
            renderFindingSection(add, turn.finding);
          } else if (turn.state === "none") {
            add("Checked — nothing material to flag.");
          } else if (turn.state === "legacy") {
            renderLegacyNote(add, turn.note);
          } else {
            add("Not checked for this turn. Ctrl+R checks now.");
            if (turn.previousNote) renderPreviousNote(add, turn.previousNote, position);
          }
        }

        const hints = "↑/↓ scroll · Ctrl+R recheck" +
          (session.branchOptOut && allowBranch ? " · A allow branch" : "") +
          " · U usage · ? help · Ctrl+C copy · Esc close";
        const hintRows = wrapTextWithAnsi(hints, inner).length;
        const noticeRows = notice ? Math.min(3, wrapTextWithAnsi(notice, inner).length) : 0;
        const cap = Math.max(8, lines.length + 5 + hintRows + noticeRows);
        return renderFrame(theme, width, modalHeight(tui, undefined, cap), {
          header: () => theme.fg("accent", theme.bold("Bro · Overthink")) +
            (isChecking ? " · checking" : "") +
            (scroller.indicator() ? " · " + scroller.indicator() : ""),
          body: (rows) => scroller.view(lines, rows),
          notice,
          hints,
          fill: false,
        });
      },
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, "escape")) {
          if (help) { help = false; scroller.toStart(); tui.requestRender(); }
          else { closed = true; done(); }
          return;
        }
        if (matchesKey(data, "?")) { help = !help; scroller.toStart(); tui.requestRender(); return; }
        if (matchesKey(data, "u") || matchesKey(data, "shift+u")) { showUsage = !showUsage; scroller.toStart(); tui.requestRender(); return; }
        if ((matchesKey(data, "a") || matchesKey(data, "shift+a")) && !help) { allow(); return; }
        if (matchesKey(data, "ctrl+r")) { void rerun(); return; }
        if (matchesKey(data, "ctrl+c")) { void copy(); return; }
        scroller.handleKey(data);
      },
    };
  };
}

export type RegisterOverthinkOptions = {
  loadGlobal?: () => Promise<OverthinkGlobal>;
  loadAutomaticChecks?: () => Promise<boolean>;
  gate?: OverthinkGate;
  promptOptions?: Omit<OverthinkPromptOptions, "preferences" | "sourceIndex">;
  timeoutMs?: number;
};

export function registerOverthink(pi: ExtensionAPI, options: RegisterOverthinkOptions = {}): {
  open(ctx: ExtensionCommandContext): Promise<void>;
  recheck(ctx: CheckContext): Promise<OverthinkNote>;
} {
  const loadGlobal: () => Promise<OverthinkGlobal> = options.loadGlobal ?? (options.loadAutomaticChecks
    ? async () => {
        const ok = await options.loadAutomaticChecks!();
        return { automatic: ok, savedAutomatic: ok, legacyEmptyOptOut: false };
      }
    : readGlobalOverthink);
  const gate = options.gate ?? PILOT_OVERTHINK_GATE;
  const promptOptions = options.promptOptions ?? {};
  const timeoutMs = options.timeoutMs ?? NOTE_TIMEOUT_MS;

  let active: AbortController | undefined;
  let checkingPosition: string | undefined;
  let generation = 0;
  let evidence: OverthinkRunEvidence | undefined;

  const invalidate = (_event: unknown, ctx: ExtensionContext) => {
    generation++;
    evidence = undefined;
    checkingPosition = undefined;
    active?.abort(); active = undefined;
    noteWidget(ctx);
  };

  pi.on("session_start", invalidate);
  pi.on("session_tree", invalidate);
  pi.on("agent_start", (_event, ctx) => {
    // A continuation or retry can begin a new agent loop before the overall
    // run settles. Cancel in-flight checks and clear any old preview, but keep
    // tool evidence until agent_settled decides whether the full run qualifies.
    generation++;
    checkingPosition = undefined;
    active?.abort(); active = undefined;
    noteWidget(ctx);
  });
  pi.on("session_shutdown", invalidate);

  type Trigger = { generation: number; sessionId: string; position?: string; toolResults?: number };

  const run = async (ctx: CheckContext, forced: boolean, trigger?: Trigger): Promise<OverthinkNote> => {
    if (!ctx.model) throw new Error("No active Pi model; Overthink cannot choose a different one.");
    const model = ctx.model;
    const name = model.provider + "/" + model.id;
    const marker = trigger?.generation ?? generation;
    const sessionId = trigger?.sessionId ?? ctx.sessionManager.getSessionId();
    const position = trigger?.position ?? overthinkContextPosition(ctx.sessionManager.getBranch());
    const stillCurrent = () => marker === generation &&
      sessionId === ctx.sessionManager.getSessionId() &&
      position === overthinkContextPosition(ctx.sessionManager.getBranch()) &&
      ctx.model?.provider === model.provider &&
      ctx.model?.id === model.id;
    if (!stillCurrent()) throw new Error("Session moved before check could start.");

    active?.abort();
    const controller = new AbortController();
    active = controller;
    checkingPosition = position;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const preferences = await readPreferences();
      if (timedOut) throw new Error("Check timed out.");
      if (controller.signal.aborted || !stillCurrent() || active !== controller) {
        throw new Error("Session changed; check cancelled.");
      }

      const projection = ctx.sessionManager.buildSessionProjection();
      const { messages, sources, sourceIndex } = buildOverthinkReviewContext(projection);
      if (!sources.length) {
        throw new Error(forced ? "Nothing in the current conversation to check." : "No conversation to check.");
      }

      const effort = pi.getThinkingLevel();
      const ask = {
        role: "user" as const,
        content: [{ type: "text" as const, text: overthinkPrompt({ ...promptOptions, preferences, sourceIndex }) }],
        timestamp: Date.now(),
      };
      const answer = await ctx.modelRegistry.streamSimple(
        model,
        normalizeContext({ messages: [...messages, ask] }),
        {
          reasoning: model.reasoning && effort !== "off" ? effort : undefined,
          maxTokens: 8192,
          sessionId: sessionId ?? undefined,
          signal: controller.signal,
        },
      ).result();
      if (timedOut) throw new Error("Check timed out.");
      if (controller.signal.aborted) throw new Error("Check cancelled.");
      if (!stillCurrent() || active !== controller) {
        throw new Error("Session or model changed; stale result discarded.");
      }
      if (answer.stopReason !== "stop") {
        const detail = typeof answer.errorMessage === "string" && answer.errorMessage.trim()
          ? ": " + answer.errorMessage.trim() : "";
        throw new Error("Model did not finish its check (" + answer.stopReason + detail + ").");
      }
      const rawText = answer.content.filter(part => part.type === "text").map(part => part.text).join("");
      const finding = parseOverthinkFinding(rawText, sources, { allowLabel: promptOptions.includeLabels ?? true });
      const text = finding ? formatOverthinkFinding(finding) : "";
      const usage = readOverthinkUsage(answer.usage);
      const note: OverthinkNote = {
        text,
        checkedAt: new Date().toISOString(),
        model: name,
        status: finding ? "finding" : "none",
        ...(position ? { sourcePosition: position } : {}),
        ...(usage ? { usage } : {}),
        ...(finding ? { finding } : {}),
        ...(trigger?.toolResults !== undefined ? { toolResults: trigger.toolResults } : {}),
      };
      saveOverthinkNote(pi, note);
      noteWidget(ctx, finding, position);
      return note;
    } catch (error) {
      const ownedAndCurrent = (!controller.signal.aborted || timedOut) && stillCurrent() && active === controller;
      if (ownedAndCurrent) {
        saveOverthinkFailure(pi, {
          checkedAt: new Date().toISOString(),
          model: name,
          error: timedOut ? "Check timed out." : errorMessage(error),
          ...(position ? { sourcePosition: position } : {}),
        });
        noteWidget(ctx);
      }
      throw timedOut ? new Error("Check timed out.") : error;
    } finally {
      clearTimeout(timer);
      if (active === controller) {
        active = undefined;
        checkingPosition = undefined;
      }
    }
  };

  pi.on("agent_end", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    evidence = accumulateOverthinkEvidence(evidence, event);
  });

  // agent_end is not guaranteed to mean Pi has finished continuation, retry or
  // compaction. agent_settled is available in Pi >=1.3, our supported floor.
  pi.on("agent_settled", (event, ctx) => {
    const completed = evidence;
    evidence = undefined;
    if (ctx.mode !== "tui" || !ctx.model ||
        !overthinkReady(completed, event.aborted, ctx.hasPendingMessages(), gate)) return;
    // Capture BEFORE the asynchronous settings read. A new run, fork or
    // compaction must not turn an older settlement into a request for new work.
    const trigger: Trigger = {
      generation,
      sessionId: ctx.sessionManager.getSessionId(),
      position: overthinkContextPosition(ctx.sessionManager.getBranch()),
      toolResults: completed?.toolResults,
    };
    void (async () => {
      const global = await loadGlobal();
      if (trigger.generation !== generation ||
          trigger.sessionId !== ctx.sessionManager.getSessionId() ||
          trigger.position !== overthinkContextPosition(ctx.sessionManager.getBranch()) ||
          ctx.hasPendingMessages()) return;
      const session = resolveOverthinkSession(ctx.sessionManager.getBranch());
      if (!shouldRunAutomaticOverthink(global, session)) return;
      await run(ctx, false, trigger);
    })().catch(() => undefined); // Optional review must never fail the main task.
  });

  const open = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (!hasBroCustomUi(ctx)) {
      ctx.ui.notify("Use /bro overthink in Pi's interactive UI.", "warning");
      return;
    }
    let globalAutomatic = false;
    try { globalAutomatic = (await loadGlobal()).automatic; }
    catch { globalAutomatic = false; }
    await openBroOverlay<void>(ctx, createOverthinkViewer(
      () => {
        const branch = ctx.sessionManager.getBranch();
        const position = overthinkContextPosition(branch);
        return {
          session: resolveOverthinkSession(branch),
          position,
          checking: Boolean(active && checkingPosition === position),
          globalAutomatic,
        };
      },
      () => run(ctx, true),
      () => allowBranchAutomaticChecks(pi),
    ));
  };

  return { open, recheck: (ctx: CheckContext) => run(ctx, true) };
}
