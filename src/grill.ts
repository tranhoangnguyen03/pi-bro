import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execute as executeBackend } from "./backend.ts";
import { BtwModal, BTW_CONTEXT_MAX, BTW_CONTEXT_TURNS, formatBtwTranscript } from "./btw.ts";
import {
  buildGrillPrompt, grillExecution, parseGrillCommand,
  type GrillThread, type GrillTurn,
} from "./grill-engine.ts";
import { readPreferences, readSettings, selectionForCapability, selectionLabel, capabilityBackend } from "./settings.ts";
import { captureShowTranscript } from "./show.ts";
import { openBroOverlay } from "./modal-kit.ts";
import { canBroInsertIntoEditor, insertBroDesktopText } from "./ui-capabilities.ts";
import { errorMessage } from "./util.ts";

/**
 * Reuses BTW's terminal component and Bro's backend, but not BTW's thread or
 * backend continuation. Restricted interviews run via the review read-only
 * inspection path; every turn is re-seeded from our own private transcript.
 */
export async function openGrillModal(
  ctx: ExtensionCommandContext,
  thread: GrillThread,
  options: { start?: boolean } = {},
): Promise<void> {
  const openingBackend = capabilityBackend(await readSettings(), "btw");
  await openBroOverlay<void>(
    ctx,
    (tui, theme, _keys, done) => {
      let closed = false;
      let controller: AbortController | undefined;
      let composerTouched = false;
      let pendingTurn: GrillTurn | undefined;
      let pendingSummary: string | undefined;
      let pendingReply: string | undefined;
      let activeBackend = openingBackend;
      let confirmation: "full" | string | undefined;
      const help = "## Commands\n\n- /consolidate — draft a decision brief; keep talking afterward\n- /insert-last-message — insert the latest Bro reply into an empty Pi editor, without sending\n- /depth light|balanced|exhaustive — change depth\n- /retry — retry a failed operation or regenerate the latest reply\n- /new <topic> — start over (confirmation required)\n- /access inspect|full — choose access (full requires confirmation)\n- /help — show this list\n\nAnswer with a letter or your own words. Esc closes without discarding completed discussion.";

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
        controller?.abort();
        done(undefined);
      };
      const modal = new BtwModal(tui, theme, close, submit, () => {
        closed = true;
        saveDraft();
        controller?.abort();
      }, {
        title: "Bro · grill-me",
        commands: "",
        inputLabel: "Your answer (letter or your own words)",
        idleHint: "Enter answer · Esc close · /help commands",
      });
      modal.onInput = () => { composerTouched = true; };
      if (thread.draft && !options.start) modal.setComposerText(thread.draft);

      const permissionNotice = (backend: string) =>
        thread.fullAccess
          ? "FULL PERMISSION: the model can modify your workspace. Bro only instructs it not to."
          : backend === "agy"
            ? "Agy inspection sandbox can still write project files. No-edits is prompt-only on Agy."
            : "";

      const runTurn = async (reply: string, replaced?: GrillTurn) => {
        if (controller || closed) return;
        thread.retry = { reply, replace: Boolean(replaced) };
        const attempt = new AbortController();
        controller = attempt;
        modal.setRunning(true);
        pendingReply = reply;
        try {
          const [settings, preferences] = await Promise.all([readSettings(), readPreferences()]);
          if (closed || attempt.signal.aborted) return;
          const backend = capabilityBackend(settings, "btw");
          activeBackend = backend;
          refreshHeader();
          modal.setNotice(permissionNotice(backend), thread.fullAccess || backend === "agy" ? "warning" : "info");
          const selection = selectionForCapability(settings, "btw");
          thread.model = selectionLabel(selection);
          thread.preferences = Boolean(preferences);
          modal.setModel(`${thread.model}${thread.preferences ? " · prefs" : ""}`);
          if (!thread.context && !thread.turns.length) {
            thread.context = captureShowTranscript(ctx, BTW_CONTEXT_TURNS, BTW_CONTEXT_MAX)?.text;
          }
          const history = replaced ? thread.turns.slice(0, -1) : [...thread.turns];
          const prompt = buildGrillPrompt({
            topic: thread.topic, reply, depth: thread.depth, context: thread.context,
            history, preferences, fullAccess: thread.fullAccess,
          });
          pendingTurn = { question: reply, answer: "…" };
          modal.setText(transcript());
          modal.scrollToEnd();
          const outcome = await executeBackend({
            ...grillExecution(thread.fullAccess), cwd: ctx.cwd, prompt,
          }, selection, attempt.signal, (event) => {
            if (!closed && !attempt.signal.aborted && event.kind === "text") {
              pendingTurn!.answer = event.text;
              modal.setText(transcript());
            }
          });
          if (closed || attempt.signal.aborted) return;
          if (outcome.status !== "success") throw new Error(outcome.message);
          if (replaced) thread.turns.pop();
          thread.turns.push({ question: reply, answer: outcome.text });
          modal.setNotice(permissionNotice(backend), thread.fullAccess || backend === "agy" ? "warning" : "info");
          delete thread.draft;
          delete thread.retry;
        } catch (error) {
          if (!closed && !attempt.signal.aborted) {
            modal.setNotice(errorMessage(error), "error");
            modal.setComposerText(reply);
          }
        } finally {
          pendingTurn = undefined;
          pendingReply = undefined;
          if (controller === attempt) controller = undefined;
          if (!closed) { modal.setRunning(false); modal.setText(transcript()); }
        }
      };

      const consolidate = async (replace = false) => {
        if (controller || closed) return;
        if (!thread.turns.length) { modal.setNotice("Start the interview before consolidating.", "warning"); return; }
        thread.retry = { consolidate: true, replace };
        const attempt = new AbortController();
        controller = attempt;
        modal.setRunning(true);
        try {
          const [settings, preferences] = await Promise.all([readSettings(), readPreferences()]);
          if (closed || attempt.signal.aborted) return;
          activeBackend = capabilityBackend(settings, "btw");
          refreshHeader();
          modal.setNotice(permissionNotice(activeBackend), thread.fullAccess || activeBackend === "agy" ? "warning" : "info");
          const selection = selectionForCapability(settings, "btw");
          thread.model = selectionLabel(selection);
          thread.preferences = Boolean(preferences);
          modal.setModel(`${thread.model}${thread.preferences ? " · prefs" : ""}`);
          const prompt = buildGrillPrompt({
            topic: thread.topic, depth: thread.depth, context: thread.context,
            history: replace ? thread.turns.slice(0, -1) : thread.turns, preferences, consolidate: true, fullAccess: thread.fullAccess,
          });
          const outcome = await executeBackend({ ...grillExecution(thread.fullAccess), cwd: ctx.cwd, prompt },
            selection, attempt.signal, (event) => {
              if (!closed && !attempt.signal.aborted && event.kind === "text") {
                pendingSummary = event.text;
                modal.setText(transcript());
                modal.scrollToEnd();
              }
            });
          if (closed || attempt.signal.aborted) return;
          if (outcome.status !== "success") throw new Error(outcome.message);
          if (replace) thread.turns.pop();
          thread.turns.push({ question: "/consolidate", answer: outcome.text });
          delete thread.retry;
          modal.setNotice("Brief ready. Keep talking or /insert-last-message.", "success");
        } catch (error) {
          if (!closed && !attempt.signal.aborted) modal.setNotice(errorMessage(error), "error");
        } finally {
          pendingSummary = undefined;
          if (controller === attempt) controller = undefined;
          if (!closed) { modal.setRunning(false); modal.setText(transcript()); }
        }
      };

      const insert = async () => {
        const text = thread.turns.at(-1)?.answer || "";
        if (!thread.turns.length || !text.trim()) { modal.setNotice("Nothing to insert yet.", "warning"); return; }
        if (!canBroInsertIntoEditor(ctx)) {
          const result = await insertBroDesktopText(ctx, text);
          modal.setNotice(result === "inserted" ? "Inserted into main editor without sending." : result === "not_empty"
            ? "Main editor is not empty; clear it first." : "Insertion could not be confirmed.", result === "inserted" ? "success" : "warning");
          return;
        }
        if (ctx.ui.getEditorText().trim()) { modal.setNotice("Main editor has a draft. Clear it first.", "warning"); return; }
        ctx.ui.setEditorText(text);
        modal.setNotice("Inserted into main editor without sending.", "success");
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
        void runTurn(topic);
      };

      function submit(value: string): void {
        if (controller || closed) return;
        if (confirmation) {
          const pending = confirmation;
          confirmation = undefined;
          modal.clearComposer();
          if (value.trim().toLowerCase() !== "yes") { modal.setNotice("Cancelled."); return; }
          if (pending === "full") {
            thread.fullAccess = true;
            refreshHeader();
            modal.setNotice(permissionNotice(activeBackend), "warning");
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
          }
          return;
        }
        if (action.kind === "help") { modal.clearComposer(); modal.setText(help); modal.scrollToEnd(); return; }
        if (action.kind === "new") {
          modal.clearComposer();
          if (thread.topic || thread.turns.length) {
            confirmation = `new:${action.topic}`;
            modal.setNotice("Discard this interview? Type yes to start over, anything else to cancel.", "warning");
          } else clear(action.topic);
          return;
        }
        if (action.kind === "insert") { modal.clearComposer(); void insert(); return; }
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
