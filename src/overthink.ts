/** Automatic same-model second look. No separate CLI, agent or model override. */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, copyToClipboard } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { matchesKey, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { modalHeight, openBroOverlay, renderFrame, Scroller, formatNotice, type Theme } from "./modal-kit.ts";
import { hasBroCustomUi } from "./ui-capabilities.ts";
import {
  FACTORY_QUESTIONS, FACTORY_LENSES, ensureOverthinkSession, overthinkPrompt,
  parseOverthinkAssessment, formatOverthinkAssessment,
  questionKey, readAutomaticChecks, readGlobalQuestions, readOverthinkUsage, resolveOverthinkSession,
  overthinkContextPosition, overthinkIsStale,
  saveOverthinkNote, saveSessionQuestions, writeGlobalQuestions,
  type OverthinkNote,
} from "./overthink-state.ts";
import { openOverthinkQuestionEditor } from "./overthink-questions-ui.ts";
import { readPreferences } from "./settings.ts";
import { errorMessage } from "./util.ts";

const MIN_TOOL_RESULTS = 3;
const WIDGET = "bro-overthink";
const NOTE_TIMEOUT_MS = 90_000;

type ViewerAction = "close" | "edit";
type CheckResult = OverthinkNote;
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

export function overthinkReady(evidence: OverthinkRunEvidence | undefined, aborted: boolean, pending: boolean): boolean {
  return !aborted && !pending && Boolean(evidence?.normalFinish && evidence.toolResults >= MIN_TOOL_RESULTS);
}


function noteWidget(ctx: CheckContext, note?: string): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setWidget(WIDGET, note
    ? (_tui, theme) => ({
        invalidate() {},
        render(width: number) {
          const label = "◇ Overthink: ";
          const lines = wrapTextWithAnsi(note.replace(/\s+/g, " "), Math.max(12, width - label.length - 2)).slice(0, 3);
          return ["", ...lines.map((line, index) =>
            (index === 0 ? theme.fg("warning", label) : " ".repeat(label.length)) + theme.fg("muted", line)
          ), theme.fg("dim", "  /bro overthink to view the private assessment")];
        },
      })
    : undefined);
}

export function questionStatus(note: OverthinkNote | undefined, questions: string[], position?: string): string {
  if (!note) return "No assessment yet.";
  const changed = note.questionKey !== questionKey(questions) ? " · questions changed" : "";
  const freshness = overthinkIsStale(note, position)
    ? (note.sourcePosition ? " · OUTDATED (later work)" : " · source position not recorded")
    : " · current";
  // The full timestamp and provider usage remain in the saved note; show only
  // what helps orient someone opening the viewer after a long work session.
  return "Checked " + note.checkedAt.slice(0, 16).replace("T", " ") + " · " + note.model + freshness + changed;
}

/** A saved question snapshot keeps old notes aligned even after session edits. */
export function overthinkQuestionLabel(question: string, position: number): string {
  const index = (FACTORY_QUESTIONS as readonly string[]).indexOf(question);
  return (position + 1) + ". " + (index < 0 ? "Question" : FACTORY_LENSES[index]);
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

export function createOverthinkViewer(
  read: () => { questions: string[]; note?: OverthinkNote; position?: string },
  retry: () => Promise<CheckResult>,
) {
  return (tui: TUI, theme: Theme, _keys: unknown, done: (action: ViewerAction) => void): Component => {
    let help = false;
    let showUsage = false;
    let busy = false;
    let closed = false;
    let notice = "";
    const scroller = new Scroller(() => tui.requestRender());
    const copy = async () => {
      const note = read().note;
      if (!note?.text) { notice = formatNotice(theme, "Nothing to copy yet.", "warning"); tui.requestRender(); return; }
      try { await copyToClipboard(note.text); notice = formatNotice(theme, "Assessment copied.", "success"); }
      catch (error) { notice = formatNotice(theme, "Copy failed: " + errorMessage(error), "error"); }
      tui.requestRender();
    };
    const rerun = async () => {
      if (busy || closed) return;
      busy = true; notice = ""; tui.requestRender();
      try {
        const result = await retry();
        if (!closed) { scroller.toStart(); notice = formatNotice(theme, result.text ? "Assessment refreshed." : "No material concerns found.", "success"); }
      } catch (error) {
        if (!closed) notice = formatNotice(theme, "Retry failed: " + errorMessage(error), "error");
      } finally { busy = false; if (!closed) tui.requestRender(); }
    };
    return {
      render(width: number) {
        const { questions, note, position } = read();
        const inner = Math.max(1, width - 2);
        const lines: string[] = [];
        const add = (value: string, color?: "accent" | "muted") => {
          const styled = color ? theme.fg(color, color === "accent" ? theme.bold(value) : value) : value;
          lines.push(...wrapTextWithAnsi(styled, inner));
        };
        if (help) {
          [
            "Overthink checks settled substantial work using the same Pi model.",
            "It stays private and only notifies about consequential new concerns.",
            "",
            "Ctrl+R  Retry with the current session",
            "Ctrl+E  Edit session questions",
            "U       Show or hide detailed token/cache/estimated cost usage",
            "?       Toggle help",
            "Ctrl+C  Copy the assessment as Markdown",
            "Esc     Close / back from help",
          ].forEach(value => add(value));
        } else {
          add(questionStatus(note, questions, position), "muted");
          if (showUsage) {
            add("");
            add("Usage details", "accent");
            usageStatus(note).forEach(value => add(value));
          }
          add("");
          if (busy) {
            add("Checking the current Pi session…");
          } else if (!note) {
            add("No assessment yet. Bro checks after substantial work; Ctrl+R checks now.");
          } else if (!note.text) {
            add("No material concerns found in the last check.");
          } else if (note.assessment) {
            add("Summary", "accent");
            add(note.assessment.summary);
            note.assessment.questions.forEach((question, i) => {
              add("");
              add(overthinkQuestionLabel(question, i), "accent");
              add(question, "muted");
              add(note.assessment!.answers[i] ?? "");
            });
          } else {
            // Historical notes were one free-form paragraph; never pretend
            // their text supplies one verified answer per newer question.
            add("Earlier assessment (plain text)", "accent");
            note.text.split("\n").forEach(line => add(line));
          }
        }
        // The prior full-height viewer left a large blank rectangle below short
        // notes. Cap the frame to real content, but preserve scroll for long notes.
        const hints = "↑/↓ scroll · Ctrl+R retry · Ctrl+E questions · U usage · ? help · Ctrl+C copy · Esc close";
        // renderFrame reserves 5 frame rows plus the *wrapped* shortcuts and
        // notices. Count them before capping or short notes lose their last line.
        const hintRows = wrapTextWithAnsi(hints, inner).length;
        const noticeRows = notice ? Math.min(3, wrapTextWithAnsi(notice, inner).length) : 0;
        const cap = Math.max(8, lines.length + 5 + hintRows + noticeRows);
        return renderFrame(theme, width, modalHeight(tui, undefined, cap), {
          header: () => theme.fg("accent", theme.bold("Bro · Overthink")) +
            (busy ? " · running" : "") +
            (!help ? " · " + questions.length + (questions.length === 1 ? " question" : " questions") : "") +
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
          else { closed = true; done("close"); }
          return;
        }
        if (matchesKey(data, "?")) { help = !help; scroller.toStart(); tui.requestRender(); return; }
        if (matchesKey(data, "u") || matchesKey(data, "shift+u")) { showUsage = !showUsage; scroller.toStart(); tui.requestRender(); return; }
        if (matchesKey(data, "ctrl+r")) { void rerun(); return; }
        if (matchesKey(data, "ctrl+c")) { void copy(); return; }
        if (matchesKey(data, "ctrl+e") && !busy) { closed = true; done("edit"); return; }
        scroller.handleKey(data);
      },
    };
  };
}

export async function openOverthinkDefaults(ctx: ExtensionCommandContext): Promise<void> {
  const current = await readGlobalQuestions();
  await openOverthinkQuestionEditor(ctx, {
    title: "Bro · Overthink / Default questions",
    questions: current,
    reset: async () => [...FACTORY_QUESTIONS],
    save: writeGlobalQuestions,
  });
}

export function registerOverthink(pi: ExtensionAPI, loadAutomaticChecks = readAutomaticChecks): {
  open(ctx: ExtensionCommandContext): Promise<void>;
} {
  let active: AbortController | undefined;
  let generation = 0;
  let evidence: OverthinkRunEvidence | undefined;
  const invalidate = (_event: unknown, ctx: ExtensionContext) => {
    generation++;
    evidence = undefined;
    active?.abort(); active = undefined;
    noteWidget(ctx);
  };

  // The first session event locks its question defaults; subsequent branch/fork views
  // inherit the nearest private custom entry rather than sharing a project setting.
  pi.on("session_start", async (_event, ctx) => {
    invalidate(_event, ctx);
    try { await ensureOverthinkSession(pi, ctx.sessionManager.getBranch()); }
    catch (error) { if (ctx.mode === "tui") ctx.ui.notify("Overthink settings: " + errorMessage(error), "warning"); }
  });
  pi.on("session_tree", invalidate);
  pi.on("agent_start", (_event, ctx) => {
    // A continuation or retry can begin a new agent loop before the overall
    // run settles. Cancel in-flight checks and stale scheduling, but keep the
    // tool evidence until agent_settled decides whether the full run qualifies.
    generation++;
    active?.abort(); active = undefined;
    noteWidget(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => { invalidate(_event, ctx); });

  type Trigger = { generation: number; sessionId: string; position?: string };
  const run = async (ctx: CheckContext, forced: boolean, trigger?: Trigger): Promise<CheckResult> => {
    if (!ctx.model) throw new Error("No active Pi model; Overthink cannot choose a different one.");
    const marker = trigger?.generation ?? generation;
    const sessionId = trigger?.sessionId ?? ctx.sessionManager.getSessionId();
    const position = trigger?.position ?? overthinkContextPosition(ctx.sessionManager.getBranch());
    const stillCurrent = () => marker === generation &&
      sessionId === ctx.sessionManager.getSessionId() &&
      position === overthinkContextPosition(ctx.sessionManager.getBranch());
    if (!stillCurrent()) throw new Error("Session moved before assessment could start.");
    const state = await ensureOverthinkSession(pi, ctx.sessionManager.getBranch());
    const questions = state.questions ?? [];
    if (!questions.length) throw new Error("No Overthink questions. Edit session questions to enable checks.");
    const preferences = await readPreferences();
    if (!stillCurrent()) throw new Error("Session changed; assessment cancelled.");

    const projected = ctx.sessionManager.buildSessionProjection().messages;
    if (!projected.length && forced) throw new Error("Nothing in the current conversation to assess.");
    if (!projected.length) throw new Error("No conversation to assess.");

    active?.abort();
    const controller = new AbortController();
    active = controller;
    const model = ctx.model;
    const name = model.provider + "/" + model.id;
    const effort = pi.getThinkingLevel();
    const ask = { role: "user" as const, content: [{ type: "text" as const, text: overthinkPrompt(questions, preferences) }], timestamp: Date.now() };
    const timer = setTimeout(() => controller.abort(), NOTE_TIMEOUT_MS);
    try {
      // The exact projected message prefix is the basis of provider cache reuse.
      // No second agent session, generated summary, extra tools or backend override.
      const answer = await ctx.modelRegistry.streamSimple(
        model,
        normalizeContext({ messages: convertToLlm([...projected, ask]) }),
        {
          reasoning: model.reasoning && effort !== "off" ? effort : undefined,
          maxTokens: 2200,
          sessionId: sessionId ?? undefined,
          signal: controller.signal,
        },
      ).result();
      if (controller.signal.aborted) throw new Error("Assessment cancelled or timed out.");
      if (!stillCurrent() ||
          ctx.model?.provider !== model.provider || ctx.model?.id !== model.id ||
          active !== controller) throw new Error("Session or model changed; stale result discarded.");
      if (answer.stopReason !== "stop") throw new Error("Model did not finish its assessment (" + answer.stopReason + ").");
      const currentQuestions = resolveOverthinkSession(ctx.sessionManager.getBranch()).questions ?? [];
      if (questionKey(currentQuestions) !== questionKey(questions)) throw new Error("Questions changed during check; stale result discarded.");
      const assessment = parseOverthinkAssessment(
        answer.content.filter(part => part.type === "text").map(part => part.text).join(""), questions,
      );
      const text = assessment ? formatOverthinkAssessment(assessment) : "";
      const usage = readOverthinkUsage(answer.usage);
      const note: OverthinkNote = {
        text, checkedAt: new Date().toISOString(), model: name, questionKey: questionKey(questions),
        ...(position ? { sourcePosition: position } : {}),
        ...(usage ? { usage } : {}),
        ...(assessment ? { assessment } : {}),
      };
      saveOverthinkNote(pi, note);
      noteWidget(ctx, assessment?.summary);
      return note;
    } finally {
      clearTimeout(timer);
      if (active === controller) active = undefined;
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
        !overthinkReady(completed, event.aborted, ctx.hasPendingMessages())) return;
    // Capture BEFORE the asynchronous settings read. A new run, fork or
    // compaction must not turn an older settlement into a request for new work.
    const trigger = {
      generation, sessionId: ctx.sessionManager.getSessionId(),
      position: overthinkContextPosition(ctx.sessionManager.getBranch()),
    };
    void (async () => {
      if (!(await loadAutomaticChecks())) return;
      if (trigger.generation !== generation ||
          trigger.sessionId !== ctx.sessionManager.getSessionId() ||
          trigger.position !== overthinkContextPosition(ctx.sessionManager.getBranch()) ||
          ctx.hasPendingMessages()) return;
      await run(ctx, false, trigger);
    })().catch(() => undefined); // Optional review must never fail the main task.
  });

  const open = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (!hasBroCustomUi(ctx)) {
      ctx.ui.notify("Use /bro overthink in Pi's interactive UI.", "warning");
      return;
    }
    await ensureOverthinkSession(pi, ctx.sessionManager.getBranch());
    for (;;) {
      const action = await openBroOverlay<ViewerAction>(ctx, createOverthinkViewer(
        () => {
          const state = resolveOverthinkSession(ctx.sessionManager.getBranch());
          return { questions: state.questions ?? [], note: state.note,
            position: overthinkContextPosition(ctx.sessionManager.getBranch()) };
        },
        () => run(ctx, true),
      ));
      if (action !== "edit") return;
      const state = resolveOverthinkSession(ctx.sessionManager.getBranch());
      await openOverthinkQuestionEditor(ctx, {
        title: "Bro · Overthink / Session questions",
        questions: state.questions ?? [],
        reset: readGlobalQuestions,
        save: (questions) => saveSessionQuestions(pi, questions),
      });
    }
  };
  return { open };
}
