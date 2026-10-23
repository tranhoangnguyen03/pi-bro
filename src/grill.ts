import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
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

      const transcript = () => {
        const conversation = formatBtwTranscript(pendingTurn ? [...thread.turns, pendingTurn] : thread.turns);
        const summary = pendingSummary ?? thread.summary;
        const ending = summary ? `## Decision brief\n\n${summary}` : "";
        return [conversation, ending].filter(Boolean).join("\n\n---\n\n")
          || "Tell Bro what you want to be grilled on. It can be a proposal or an open question.";
      };
      const refreshHeader = () => modal.setCustomMode(`${thread.depth} · ${thread.fullAccess ? "FULL (prompt-only no-edits)" : activeBackend === "agy" ? "Agy (writes possible)" : "inspection"}`);
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
        commands: "Commands: /depth light|balanced|exhaustive · /finish · /access full|read-only · /copy · /insert · /clear",
        inputLabel: "Your answer / new topic",
      });
      modal.onInput = () => { composerTouched = true; };
      if (thread.draft && !options.start) modal.setComposerText(thread.draft);

      const permissionNotice = (backend: string) =>
        thread.fullAccess
          ? "FULL PERMISSION: the model can modify your workspace. Bro only instructs it not to."
          : backend === "agy"
            ? "Agy inspection sandbox can still write project files. No-edits is prompt-only on Agy."
            : "Inspection mode: file reads are allowed where supported; see backend limits in the docs.";

      const runTurn = async (reply: string, replaced?: GrillTurn) => {
        if (controller || closed || thread.summary) return;
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

      const finish = async () => {
        if (controller || closed) return;
        if (!thread.turns.length) { modal.setNotice("Answer at least one question before finishing.", "warning"); return; }
        if (thread.summary) { modal.setNotice("Already finished. /copy or /insert the decision brief.", "info"); return; }
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
            history: thread.turns, preferences, finish: true, fullAccess: thread.fullAccess,
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
          thread.summary = outcome.text;
          modal.setNotice("Interview finished. /copy or /insert puts the brief in your hands.", "success");
        } catch (error) {
          if (!closed && !attempt.signal.aborted) modal.setNotice(errorMessage(error), "error");
        } finally {
          pendingSummary = undefined;
          if (controller === attempt) controller = undefined;
          if (!closed) { modal.setRunning(false); modal.setText(transcript()); }
        }
      };

      const exportText = (all: boolean) => all ? transcript() : (thread.summary || thread.turns.at(-1)?.answer || "");
      const copyOut = async (all: boolean) => {
        const text = exportText(all);
        if (!thread.turns.length || !text.trim()) { modal.setNotice("Nothing to copy yet.", "warning"); return; }
        try { await copyToClipboard(text); modal.setNotice(all ? "Copied full interview." : "Copied latest answer or decision brief.", "success"); }
        catch (error) { modal.setNotice(`Copy failed: ${errorMessage(error)}`, "error"); }
      };
      const insert = async (all: boolean) => {
        const text = exportText(all);
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
      const clear = () => {
        thread.topic = "";
        thread.turns = [];
        thread.fullAccess = false; // A new interview must never inherit elevated permissions.
        refreshHeader();
        delete thread.summary;
        delete thread.context;
        delete thread.draft;
        modal.clearComposer();
        modal.setText(transcript());
        modal.setNotice("Cleared. Enter a new topic to begin.", "info");
      };

      function submit(value: string): void {
        if (controller || closed) return;
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
          thread.fullAccess = action.value === "full";
          refreshHeader();
          modal.clearComposer();
          modal.setNotice(thread.fullAccess
            ? "FULL permission enabled. The no-edits rule is only a prompt; the backend can write!"
            : "Read-only inspection requested; enforcement depends on backend.", thread.fullAccess ? "warning" : "info");
          return;
        }
        if (action.kind === "clear") { clear(); return; }
        if (action.kind === "copy") { modal.clearComposer(); void copyOut(action.all); return; }
        if (action.kind === "insert") { modal.clearComposer(); void insert(action.all); return; }
        if (action.kind === "finish") { modal.clearComposer(); void finish(); return; }
        if (action.kind === "retry") {
          modal.clearComposer();
          if (thread.summary) { modal.setNotice("Already finished. /clear to start over.", "warning"); return; }
          const last = thread.turns.at(-1);
          if (!last) { modal.setNotice("Nothing to retry yet.", "warning"); return; }
          void runTurn(last.question, last);
          return;
        }
        if (action.kind !== "message") return;
        if (thread.summary) { modal.setNotice("This interview has ended. /clear to start another.", "warning"); return; }
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
