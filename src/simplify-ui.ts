import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { ComposerModal } from "./composer-modal.ts";
import { latestAssistant, simplify, type BroResult } from "./explain-modal.ts";
import { openBroOverlay, startProgressClock } from "./modal-kit.ts";
import { nextBroMode, type BroMode } from "./prompt.ts";
import { readSettings } from "./settings.ts";
import { extractDocumentText, extractWebPage, type BroSource } from "./sources.ts";
import { captureShowTranscript, openShowHtml, runShowExplanation, showDiagramPath, stripShowDiagramFence } from "./show.ts";
import { hasBroCustomUi } from "./ui-capabilities.ts";
import { errorMessage, unquote } from "./util.ts";
import { parseSimplifyAction, SIMPLIFY_MODAL_HELP, type SimplifyRequest } from "./simplify-engine.ts";

// A blank steering string still marks a Show result. Only captured input and text are persisted.
export type SimplifyResult = BroResult & { showSteering?: string };
export type SimplifyState = {
  result?: SimplifyResult;
  view?: "result" | "help" | "empty";
  draft?: string;
  error?: string;
};

type Attempt = SimplifyRequest | { kind: "retry"; result: SimplifyResult; mode?: BroMode };

async function resolveSource(ctx: ExtensionCommandContext, request: Exclude<SimplifyRequest, { kind: "show" }>, signal: AbortSignal): Promise<BroSource> {
  switch (request.kind) {
    case "latest": {
      await ctx.waitForIdle();
      signal.throwIfAborted();
      const source = latestAssistant(ctx);
      if (!source) throw new Error("No completed assistant reply to simplify.");
      return { text: source.text, label: "Latest assistant reply" };
    }
    case "text": return { text: request.input, label: "Pasted text" };
    case "file": return { text: await extractDocumentText(request.input, ctx.cwd, signal), label: unquote(request.input) };
    case "url": return await extractWebPage(request.input, signal);
  }
}

async function runSimplify(
  ctx: ExtensionCommandContext, request: Attempt, signal: AbortSignal,
  onWaiting?: (show: boolean) => void, onText?: (text: string) => void,
): Promise<SimplifyResult> {
  const saved = request.kind === "retry" ? request.result : undefined;
  const steering = request.kind === "show" ? request.steering : saved?.showSteering;
  const source = saved?.source ?? (request.kind === "show" || request.kind === "retry" ? undefined : await resolveSource(ctx, request, signal));
  signal.throwIfAborted();
  const settings = await readSettings();
  signal.throwIfAborted();
  if (steering !== undefined) {
    const captured = source ?? captureShowTranscript(ctx, (request.kind === "show" ? request.turns : undefined) ?? settings.showTurns);
    if (!captured?.text) throw new Error("Nothing to show yet. Start a conversation, then run /show again.");
    onWaiting?.(true);
    return { source: captured, showSteering: steering, ...await runShowExplanation(captured.text, steering, signal, settings, onText) };
  }
  if (!source) throw new Error("Choose a source first.");
  onWaiting?.(false);
  return { source, ...await simplify(source.text, signal, settings, onText, request.kind === "retry" ? request.mode : undefined) };
}

function showResult(state: SimplifyState, result: SimplifyResult): void {
  state.result = result;
  state.view = "result";
  state.error = undefined;
}

/** Explicit sources can run headless; a viewer open never makes a model call. */
export async function openSimplifyWorkflow(ctx: ExtensionCommandContext, state: SimplifyState, initial?: SimplifyRequest, submitted?: string): Promise<void> {
  if (!hasBroCustomUi(ctx)) {
    if (!initial) {
      ctx.ui.notify("Simplify's interactive view requires Pi TUI. Use /bro simplify latest, text, file, url, or show to run without it.", "warning");
      return;
    }
    showResult(state, await runSimplify(ctx, initial, new AbortController().signal));
    return;
  }

  state.view = state.result ? "result" : "help";
  if (!state.draft?.trim()) state.error = undefined;
  // Rebuild from the saved answer, not a stale path from a previous process.
  const prepareDiagram = (result: SimplifyResult | undefined) => result?.showSteering === undefined
    ? undefined
    : showDiagramPath(result.text, message => ctx.ui.notify(message, "warning"));
  const restoredDiagram = prepareDiagram(state.result);
  let htmlPath = restoredDiagram ? await restoredDiagram : undefined;

  await openBroOverlay<void>(ctx, (tui, theme, _keys, done) => {
    let closed = false;
    let controller: AbortController | undefined;
    let stopProgress: (() => void) | undefined;
    const dispose = () => {
      if (closed) return;
      closed = true;
      state.draft = modal.getComposerText();
      if (!state.draft.trim()) state.error = undefined;
      stopProgress?.();
      controller?.abort();
    };
    const readingResult = () => state.view === "result" ? state.result : undefined;
    const idleHint = () => {
      const result = readingResult();
      return `Enter run${result?.mode ? " · M change mode" : ""}${result && htmlPath ? " · O open diagram" : ""}${result ? " · R retry · /copy" : ""} · /help · Esc ${state.view === "help" && state.result ? "back" : "close"}`;
    };
    const modal = new ComposerModal(tui, theme, () => { dispose(); done(undefined); }, submit, dispose, {
      title: "Bro · simplify",
      inputLabel: "Simplify command · /simplify runs again on the latest reply",
      idleHint,
    });
    const display = () => {
      const result = readingResult();
      const label = result?.source.label && stripVTControlCharacters(result.source.label).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
      const mode = result?.mode ?? (result?.showSteering !== undefined ? "diagram" : "one source");
      modal.setCustomMode(mode + (result?.preferences ? " · prefs" : ""));
      modal.setModel(result?.model ?? "");
      modal.setText(result
        ? (label ? `**Source:** ${label}\n\n---\n\n` : "") + (htmlPath ? stripShowDiagramFence(result.text) : result.text)
        : SIMPLIFY_MODAL_HELP);
      modal.setNotice(state.error ?? "", state.error ? "error" : "info");
      modal.scrollToStart();
    };
    const run = async (request: Attempt, command?: string) => {
      if (controller || closed) return;
      const attempt = new AbortController();
      controller = attempt;
      modal.setRunning(true);
      modal.setNotice("");
      let phase = request.kind === "url" ? "Fetching page" : request.kind === "file" ? "Reading file"
        : request.kind === "latest" ? "Getting latest reply" : "Preparing source";
      const stop = startProgressClock(attempt.signal, seconds => {
        if (!closed) modal.setProgress(`${phase} · ${seconds}s`);
      });
      stopProgress = stop;
      try {
        const result = await runSimplify(ctx, request, attempt.signal,
          show => { phase = show ? "Drawing recent turns" : "Waiting for explanation"; },
          text => {
            if (closed) return;
            phase = "Receiving output";
            modal.setText(text);
          });
        if (closed) return;
        const diagram = await prepareDiagram(result);
        if (closed) return;
        htmlPath = diagram;
        showResult(state, result);
        display();
        if (request.kind === "retry" && request.mode !== undefined && request.mode !== request.result.mode) {
          modal.setNotice(`Mode: ${request.mode} (not saved)`);
        }
      } catch (error) {
        if (closed) return;
        state.error = (request.kind === "retry" ? "Retry failed: " : "") + errorMessage(error);
        display();
        // Retain failed input without overwriting a command typed while it ran.
        if (command && !modal.getComposerText().trim()) modal.setComposerText(command);
      } finally {
        stop();
        stopProgress = undefined;
        controller = undefined;
        if (!closed) modal.setRunning(false);
      }
    };
    const retry = (switchMode = false) => {
      const result = state.result;
      if (!result || (switchMode && !result.mode)) return;
      const mode = switchMode && result.mode ? nextBroMode(result.mode) : result.mode;
      void run({ kind: "retry", result, mode });
    };
    const copy = () => {
      if (!state.result?.text) { modal.setNotice("Nothing to copy yet.", "warning"); return; }
      void copyToClipboard(state.result.text)
        .then(() => { if (!closed) modal.setNotice("Result copied.", "success"); })
        .catch(error => { if (!closed) modal.setNotice("Copy failed: " + errorMessage(error), "error"); });
    };
    function submit(raw: string): void {
      if (controller || closed) return;
      const action = parseSimplifyAction(raw);
      if (action.kind === "invalid") { modal.setNotice(action.message, "warning"); return; }
      modal.clearComposer();
      state.draft = undefined;
      switch (action.kind) {
        case "copy": copy(); return;
        case "clear": state.result = undefined; state.view = "empty"; htmlPath = undefined; break;
        case "help": state.view = "help"; break;
        case "retry": retry(); return;
        default: void run(action, raw); return;
      }
      state.error = undefined;
      display();
    }
    modal.onKey = data => {
      if (!controller && state.view === "help" && state.result && matchesKey(data, "escape")) {
        state.view = "result";
        state.error = undefined;
        display();
        return true;
      }
      if (controller || modal.getComposerText().trim()) return false;
      const result = readingResult();
      if (!result) return false;
      const key = data.toLowerCase();
      if (key === "m" && result.mode) { retry(true); return true; }
      if (key === "r") { retry(); return true; }
      if (key === "c") { copy(); return true; }
      if (key === "o" && htmlPath) {
        const opened = openShowHtml(htmlPath);
        modal.setNotice(opened ? "Opening diagram" : `Could not open ${htmlPath}. Reopen Simplify to rebuild it.`, opened ? "info" : "error");
        return true;
      }
      return false;
    };
    display();
    if (state.draft) modal.setComposerText(state.draft);
    if (initial) queueMicrotask(() => { void run(initial, submitted); });
    return modal;
  }, { mouse: true });
}
