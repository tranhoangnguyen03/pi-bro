import { matchesKey } from "@earendil-works/pi-tui";
import { copyToClipboard, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execute as executeBackend } from "./backend.ts";
import { BtwModal, BTW_CONTEXT_MAX, BTW_CONTEXT_TURNS, formatBtwTranscript } from "./btw.ts";
import {
  buildGrillPrompt, grillExecution, parseGrillCommand, grillCommandSuggestions,
  type GrillThread, type GrillTurn,
} from "./grill-engine.ts";
import { readPreferences, readSettings, selectionForCapability, selectionLabel, capabilityBackend } from "./settings.ts";
import { captureShowTranscript } from "./show.ts";
import { openBroOverlay, startProgressClock } from "./modal-kit.ts";
import { errorMessage } from "./util.ts";

/**
 * Reuses BTW's terminal component and Bro's backend, but not BTW's thread or
 * backend continuation. Restricted interviews run via the review read-only
 * inspection path; every turn is re-seeded from our own private transcript.
 */
export async function openGrillModal(
  ctx: ExtensionCommandContext,
  thread: GrillThread,
  options: { start?: boolean; onChange?: () => void; copy?: (text: string) => Promise<void> } = {},
): Promise<void> {
  const openingBackend = capabilityBackend(await readSettings(), "btw");
  await openBroOverlay<void>(
    ctx,
    (tui, theme, _keys, done) => {
      let closed = false;
      let controller: AbortController | undefined;
      let stopProgress: (() => void) | undefined;
      let composerTouched = false;
      let pendingTurn: GrillTurn | undefined;
      let pendingSummary: string | undefined;
      let pendingReply: string | undefined;
      let activeBackend = openingBackend;
      let showingHelp = false;
      let confirmation: "full" | string | undefined;
      const help = "## Commands\n\n- /consolidate — draft a decision brief; keep talking afterward\n- /copy — copy the latest Bro reply or consolidated brief to the clipboard\n- /depth light|balanced|exhaustive — change depth\n- /retry — retry a failed operation or regenerate the latest reply\n- /new <topic> — start over (confirmation required)\n- /access inspect|full — choose access (full requires confirmation)\n- /help — show this list\n\nAnswer with a letter or your own words. Esc returns to the interview. Type / and use Tab to complete a command.";

      const transcript = () => {
        const conversation = formatBtwTranscript(pendingTurn ? [...thread.turns, pendingTurn] : thread.turns);
        const summary = pendingSummary;
        const ending = summary ? `## Decision brief\n\n${summary}` : "";
        return [conversation, ending].filter(Boolean).join("\n\n---\n\n")
          || "Tell Bro what you want to be grilled on. It can be a proposal or an open question.";
      };
      const refreshHeader = () => modal.setCustomMode(`${thread.depth} · ${thread.fullAccess ? "FULL (prompt-only no-edits)" : activeBackend === "agy" ? "Agy (writes possible)" : ["claude", "muse", "pi"].includes(activeBackend) ? "File-only tools" : "Read-only sandbox"}`);
      const saveDraft = () => {
        const draft = modal.getComposerText();
        if (draft.trim()) thread.draft = draft;
        else if (pendingReply) thread.draft = pendingReply;
        else if (composerTouched) delete thread.draft;
      };
      const close = () => {
        if (closed) return;
        closed = true;
        saveDraft();
        stopProgress?.();
        if (!controller) options.onChange?.();
        controller?.abort();
        done(undefined);
      };
      const modal = new BtwModal(tui, theme, close, submit, () => {
        closed = true;
        saveDraft();
        stopProgress?.();
        if (!controller) options.onChange?.();
        controller?.abort();
      }, {
        title: "Bro · grill-me",
        commands: "",
        inputLabel: "Your answer (letter or your own words)",
        idleHint: "Enter answer · Esc close · /help commands",
      });
      const updateSuggestions = () => {
        const suggestions = controller || confirmation ? [] : grillCommandSuggestions(modal.getComposerText());
        modal.setSuggestions(suggestions.length ? `${suggestions.join(" · ")} · Tab complete` : "");
      };
      modal.onInput = () => { composerTouched = true; updateSuggestions(); };
      modal.onKey = (data) => {
        if (showingHelp && matchesKey(data, "escape")) {
          showingHelp = false;
          modal.setText(transcript());
          modal.scrollToEnd();
          return true;
        }
        if (!controller && !confirmation && matchesKey(data, "tab")) {
          const suggestion = grillCommandSuggestions(modal.getComposerText())[0];
          if (suggestion) {
            modal.setComposerText(suggestion);
            composerTouched = true;
            updateSuggestions();
            return true;
          }
        }
        return false;
      };
      if (thread.draft && !options.start) modal.setComposerText(thread.draft);

      const permissionNotice = (backend: string) =>
        thread.fullAccess
          ? "FULL PERMISSION: the model can modify your workspace. Bro only instructs it not to."
          : backend === "agy"
            ? "Agy inspection sandbox can still write project files. No-edits is prompt-only on Agy."
            : "";

      // Both interview turns and consolidations share a current backend snapshot and disclosure.
      const prepareRun = async (signal: AbortSignal) => {
        const [settings, preferences] = await Promise.all([readSettings(), readPreferences()]);
        if (closed || signal.aborted) return;
        const backend = capabilityBackend(settings, "btw");
        activeBackend = backend;
        refreshHeader();
        modal.setNotice(permissionNotice(backend), thread.fullAccess || backend === "agy" ? "warning" : "info");
        const selection = selectionForCapability(settings, "btw");
        thread.model = selectionLabel(selection);
        thread.preferences = Boolean(preferences);
        modal.setModel(`${thread.model}${thread.preferences ? " · prefs" : ""}`);
        return { backend, selection, preferences };
      };

      // Both operations share one model-call lifecycle. Only their prompts,
      // progress presentation and completed results differ.
      type Operation = { kind: "turn"; reply: string; replace: boolean } | { kind: "consolidate"; replace: boolean };
      const runOperation = async (operation: Operation) => {
        if (controller || closed) return;
        if (operation.kind === "consolidate" && !thread.turns.length) {
          modal.setNotice("Start the interview before consolidating.", "warning");
          return;
        }
        const turn = operation.kind === "turn";
        thread.retry = turn
          ? { reply: operation.reply, replace: operation.replace }
          : { consolidate: true, replace: operation.replace };
        const attempt = new AbortController();
        controller = attempt;
        modal.setRunning(true);
        let phase = turn ? "Preparing next question" : "Preparing decision brief";
        const stop = startProgressClock(attempt.signal, seconds => {
          if (!closed && controller === attempt) modal.setProgress(`${phase} · ${seconds}s`);
        });
        stopProgress = stop;
        if (turn) pendingReply = operation.reply;
        try {
          const prepared = await prepareRun(attempt.signal);
          if (!prepared) return;
          const { backend, selection, preferences } = prepared;
          if (turn && !thread.context && !thread.turns.length)
            thread.context = captureShowTranscript(ctx, BTW_CONTEXT_TURNS, BTW_CONTEXT_MAX)?.text;

          const history = operation.replace ? thread.turns.slice(0, -1) : [...thread.turns];
          const prompt = buildGrillPrompt({
            topic: thread.topic, depth: thread.depth, context: thread.context, history,
            preferences, fullAccess: thread.fullAccess,
            ...(turn ? { reply: operation.reply } : { consolidate: true }),
          });
          if (turn) {
            pendingTurn = { question: operation.reply, answer: "…" };
            modal.setText(transcript());
            modal.scrollToEnd();
          }
          phase = turn ? "Waiting for next question" : "Waiting for decision brief";
          const outcome = await executeBackend(
            { ...grillExecution(thread.fullAccess), ...(thread.fullAccess ? {} : { reportReviewTools: true }), cwd: ctx.cwd, prompt },
            selection, attempt.signal, (event) => {
              if (closed || attempt.signal.aborted) return;
              if (event.kind === "activity") {
                // Advisor activity may be prose; only structured tool events
                // qualify as a tool status. The adapter owns name filtering.
                if (event.tool) phase = `Last tool: ${event.tool}`;
                return;
              }
              phase = turn ? "Receiving next question" : "Receiving decision brief";
              if (turn) pendingTurn!.answer = event.text;
              else pendingSummary = event.text;
              modal.setText(transcript());
              if (!turn) modal.scrollToEnd();
            },
          );
          if (closed || attempt.signal.aborted) return;
          if (outcome.status !== "success") throw new Error(outcome.message);
          if (operation.replace) thread.turns.pop();
          thread.turns.push({ question: turn ? operation.reply : "/consolidate", answer: outcome.text });
          delete thread.retry;
          if (turn) {
            delete thread.draft;
            modal.setNotice(permissionNotice(backend), thread.fullAccess || backend === "agy" ? "warning" : "info");
          } else {
            modal.setNotice("Brief ready. Keep talking or use /copy.", "success");
          }
        } catch (error) {
          if (!closed && !attempt.signal.aborted) {
            modal.setNotice(errorMessage(error), "error");
            if (turn && !modal.getComposerText().trim()) modal.setComposerText(operation.reply);
          }
        } finally {
          stop();
          if (stopProgress === stop) stopProgress = undefined;
          pendingTurn = undefined;
          pendingSummary = undefined;
          pendingReply = undefined;
          if (controller === attempt) controller = undefined;
          if (!closed) { modal.setRunning(false); modal.setText(transcript()); options.onChange?.(); }
        }
      };

      const runTurn = (reply: string, replaced?: GrillTurn) =>
        runOperation({ kind: "turn", reply, replace: Boolean(replaced) });
      const consolidate = (replace = false) => runOperation({ kind: "consolidate", replace });

      const copy = async () => {
        const text = thread.turns.at(-1)?.answer || "";
        if (!text.trim()) { modal.setNotice("Nothing to copy yet.", "warning"); return; }
        try {
          await (options.copy ?? copyToClipboard)(text);
          if (!closed) modal.setNotice("Copied the latest reply to the clipboard.", "success");
        } catch (error) {
          if (!closed) modal.setNotice(`Copy failed: ${errorMessage(error)}`, "error");
        }
      };
      const clear = (topic: string) => {
        thread.topic = topic;
        thread.depth = "balanced";
        thread.turns = [];
        thread.fullAccess = false; // A new interview must never inherit elevated permissions.
        refreshHeader();
        delete thread.retry;
        delete thread.context;
        delete thread.draft;
        modal.clearComposer();
        modal.setText(transcript());
        options.onChange?.();
        void runTurn(topic);
      };

      function submit(value: string): void {
        if (controller || closed) return;
        if (showingHelp) { showingHelp = false; modal.setText(transcript()); modal.scrollToEnd(); }
        modal.setSuggestions("");
        if (confirmation) {
          const pending = confirmation;
          confirmation = undefined;
          modal.clearComposer();
          if (value.trim().toLowerCase() !== "yes") { modal.setNotice("Cancelled."); return; }
          if (pending === "full") {
            thread.fullAccess = true;
            refreshHeader();
            modal.setNotice(permissionNotice(activeBackend), "warning");
            options.onChange?.();
          } else clear(pending.slice(4));
          return;
        }
        const action = parseGrillCommand(value);
        if (action.kind === "empty") return;
        if (action.kind === "invalid") { modal.setNotice(action.message, "warning"); return; }
        if (action.kind === "depth") {
          thread.depth = action.value;
          refreshHeader();
          modal.clearComposer();
          modal.setNotice(`Depth: ${thread.depth}. Applies to the next question.`);
          options.onChange?.();
          return;
        }
        if (action.kind === "access") {
          modal.clearComposer();
          if (action.value === "full" && !thread.fullAccess) {
            confirmation = "full";
            modal.setNotice("Backend can write and execute commands; no-edits is prompt-only. Type yes to allow, anything else to cancel.", "warning");
          } else {
            thread.fullAccess = action.value === "full";
            refreshHeader();
            modal.setNotice(permissionNotice(activeBackend));
            options.onChange?.();
          }
          return;
        }
        if (action.kind === "help") { showingHelp = true; modal.clearComposer(); modal.setText(help); modal.scrollToEnd(); return; }
        if (action.kind === "new") {
          modal.clearComposer();
          if (thread.topic || thread.turns.length) {
            confirmation = `new:${action.topic}`;
            modal.setNotice("Discard this interview? Type yes to start over, anything else to cancel.", "warning");
          } else clear(action.topic);
          return;
        }
        if (action.kind === "copy") { modal.clearComposer(); void copy(); return; }
        if (action.kind === "consolidate") { modal.clearComposer(); void consolidate(); return; }
        if (action.kind === "retry") {
          modal.clearComposer();
          const retry = thread.retry;
          if (retry) {
            if ("consolidate" in retry) void consolidate(retry.replace);
            else void runTurn(retry.reply, retry.replace ? thread.turns.at(-1) : undefined);
            return;
          }
          const last = thread.turns.at(-1);
          if (!last) { modal.setNotice("Nothing to retry yet.", "warning"); return; }
          if (last.question === "/consolidate") void consolidate(true);
          else void runTurn(last.question, last);
          return;
        }
        if (action.kind !== "message") return;
        composerTouched = true;
        delete thread.draft;
        modal.clearComposer();
        if (!thread.topic) thread.topic = action.text; // The user names the subject, not the model.
        void runTurn(action.text);
      }

      refreshHeader();
      modal.setModel(thread.model ? `${thread.model}${thread.preferences ? " · prefs" : ""}` : "");
      modal.setText(transcript());
      modal.scrollToEnd();
      modal.setNotice(permissionNotice(openingBackend), thread.fullAccess || openingBackend === "agy" ? "warning" : "info");
      if (options.start && thread.topic && !thread.turns.length) void runTurn(thread.topic);
      return modal;
    },
    { mouse: true },
  );
}
