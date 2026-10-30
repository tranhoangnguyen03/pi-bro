import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execute as executeBackend } from "./backend.ts";
import { BtwModal, formatBtwTranscript } from "./btw.ts";
import { openBroOverlay } from "./modal-kit.ts";
import { captureShowTranscript } from "./show.ts";
import { readPreferences, readSettings, selectionForCapability, selectionLabel } from "./settings.ts";
import { changeMemory, readMemoryStore, renderUserMemory, type MemoryDraft, type MemoryEntry } from "./remember-store.ts";
import { buildRememberPrompt, parseRememberResult, type RememberTurn } from "./remember-engine.ts";
import { errorMessage } from "./util.ts";

const HELP = "## Remember Me\n\nWrite a personal memory in your own words. Bro may ask a focused question, or propose a short memory with unfoldable background. Nothing is saved until /save.\n\n- /save — approve and save the displayed proposal\n- /list — list active short memories\n- /expand <id> — show source, scope, exceptions and background\n- /edit <id> — improve an existing memory through conversation\n- /delete <id> — delete after typing yes\n- /new — clear the current draft\n- /help — show this guide\n\nYour current request always outranks stored preferences. Existing /bro preferences remain unchanged.";

export async function openRememberModal(ctx: ExtensionCommandContext, initial = ""): Promise<void> {
  let store = await readMemoryStore();
  const context = captureShowTranscript(ctx, 8, 12000)?.text ?? "";
  await openBroOverlay<void>(ctx, (tui, theme, _keys, done) => {
    let closed = false;
    let controller: AbortController | undefined;
    let busy = false;
    let proposed: MemoryDraft | undefined;
    let conflict = "";
    let related: string[] = [];
    let editing: MemoryEntry | undefined;
    let confirmingDelete: string | undefined;
    let transcript: RememberTurn[] = [];
    const close = () => { if (closed) return; closed = true; controller?.abort(); done(undefined); };
    const modal = new BtwModal(tui, theme, close, submit, () => { closed = true; controller?.abort(); }, {
      title: "Bro · remember-me", commands: "", inputLabel: "What should Bro remember?",
      idleHint: "Enter to talk · /save to approve · /help",
    });
    const show = (message?: string) => {
      const conversation = transcript.length
        ? formatBtwTranscript(transcript.map(t => ({ question: t.user, answer: t.bro }))) : "";
      const preview = proposed
        ? "## Proposed " + (editing ? "update [" + editing.id + "]" : "memory") +
          "\n\n**" + proposed.title + ": " + proposed.summary + "**" +
          (proposed.uncertainty ? "\n\n**Unresolved:** " + proposed.uncertainty : "") +
          (proposed.scope ? "\n\n**Scope:** " + proposed.scope : "") +
          (proposed.exceptions ? "\n\n**Exceptions:** " + proposed.exceptions : "") +
          "\n\n**Background:** " + proposed.background +
          (proposed.sourceContext ? "\n\n**Source context:** " + proposed.sourceContext : "") +
          "\n\n**Basis:** " + (proposed.basis ?? "user-stated") +
          (related.length ? "\n\n**Related memories:** " + related.join(", ") : "") +
          (conflict ? "\n\n**Potential conflict — review before saving:** " + conflict : "") +
          "\n\nType **/save** to approve, or describe what to change. Saving never happens automatically."
        : "";
      modal.setText([message ?? "", preview, conversation].filter(Boolean).join("\n\n---\n\n") ||
        "Share a lasting fact, goal or preference. Bro will clarify when needed and show a proposal before saving.");
      modal.scrollToEnd();
    };
    const refresh = async () => {
      store = await readMemoryStore();
      proposed = undefined; editing = undefined; conflict = ""; related = [];
      show(renderUserMemory(store));
    };
    const save = async () => {
      if (!proposed || busy) { modal.setNotice("No proposal yet. Describe what you want to remember.", "warning"); return; }
      busy = true; modal.setRunning(true);
      try {
        store = await changeMemory({ kind: "save", draft: proposed, ...(editing ? { id: editing.id } : {}) }, store.revision);
        const id = editing?.id ?? store.entries.at(-1)?.id;
        proposed = undefined; editing = undefined; conflict = ""; related = []; transcript = [];
        modal.setNotice("Saved " + (id ?? "") + ". Agents can read its short statement and unfold its background.", "success");
        show(renderUserMemory(store));
      } catch (e) { modal.setNotice(errorMessage(e), "error"); }
      finally { busy = false; if (!closed) modal.setRunning(false); }
    };
    const ask = async (input: string) => {
      if (busy || closed) return;
      busy = true;
      const attempt = new AbortController();
      controller = attempt;
      modal.setRunning(true);
      const pending = { user: input, bro: "Thinking about the wording…" };
      try {
        const [settings, preferences] = await Promise.all([readSettings(), readPreferences()]);
        const selection = selectionForCapability(settings, "btw");
        modal.setModel(selectionLabel(selection));
        modal.setCustomMode("proposal only · explicit save");
        const prompt = buildRememberPrompt({ statement: input, context, history: transcript,
          memories: store.entries, editing, preferences });
        transcript.push(pending);
        show();
        const result = await executeBackend({
          feature: "btw", access: "restricted", cwd: ctx.cwd, prompt,
        }, selection, attempt.signal);
        if (closed || attempt.signal.aborted) return;
        if (result.status !== "success") throw new Error(result.message);
        const parsed = parseRememberResult(result.text);
        if (parsed.kind === "question") {
          proposed = undefined; conflict = ""; related = parsed.relatedIds ?? [];
          pending.bro = parsed.message;
        } else {
          proposed = parsed.draft; related = parsed.relatedIds ?? []; conflict = parsed.conflict ?? "";
          pending.bro = "Here is a proposed memory. Review the short and expanded text together before /save." +
            (conflict ? "\n\nPotential conflict: " + conflict : "");
        }
        show();
        modal.setNotice(parsed.kind === "question" ? "Answer the question or /list to browse." :
          "Proposal ready. /save approves; reply normally to refine.", "info");
      } catch (e) {
        if (!closed && !attempt.signal.aborted) {
          transcript.pop();
          modal.setNotice(errorMessage(e), "error");
          if (!modal.getComposerText().trim()) modal.setComposerText(input);
          show();
        }
      } finally {
        if (controller === attempt) controller = undefined;
        busy = false; if (!closed) modal.setRunning(false);
      }
    };
    function submit(raw: string): void {
      const value = raw.trim();
      if (!value || closed || busy) return;
      modal.clearComposer();
      if (confirmingDelete) {
        const id = confirmingDelete; confirmingDelete = undefined;
        if (value.toLowerCase() !== "yes") { modal.setNotice("Deletion cancelled."); return; }
        busy = true; modal.setRunning(true);
        void changeMemory({ kind: "delete", id }, store.revision).then(next => {
          store = next; proposed = undefined; editing = undefined;
          show(renderUserMemory(store));
          modal.setNotice("Memory deleted: " + id, "success");
        }).catch(e => modal.setNotice(errorMessage(e), "error")).finally(() => {
          busy = false; if (!closed) modal.setRunning(false);
        });
        return;
      }
      if (value === "/save") { void save(); return; }
      if (value === "/help") { show(HELP); return; }
      if (value === "/list") { void refresh().catch(e => modal.setNotice(errorMessage(e), "error")); return; }
      if (value === "/new") {
        proposed = undefined; editing = undefined; conflict = ""; related = []; transcript = [];
        show(); modal.setNotice("New memory draft. Nothing saved."); return;
      }
      if (value.startsWith("/expand ")) {
        const id = value.slice(8).trim();
        show(renderUserMemory(store, { expand: [id] })); return;
      }
      if (value.startsWith("/edit ")) {
        const id = value.slice(6).trim();
        const entry = store.entries.find(e => e.id === id);
        if (!entry) { modal.setNotice("Unknown ID. Use /list.", "warning"); return; }
        editing = entry; proposed = { title:entry.title, summary:entry.summary, background:entry.background,
          scope:entry.scope, exceptions:entry.exceptions, sourceContext:entry.sourceContext,
          uncertainty:entry.uncertainty, basis:entry.basis };
        transcript = [];
        show("Editing [" + id + "]. Describe the change, or review and /save the current wording.");
        return;
      }
      if (value.startsWith("/delete ")) {
        const id = value.slice(8).trim();
        if (!store.entries.some(e => e.id === id)) { modal.setNotice("Unknown ID. Use /list.", "warning"); return; }
        confirmingDelete = id;
        modal.setNotice("Delete " + id + "? Type yes to confirm; anything else cancels.", "warning");
        return;
      }
      if (value.startsWith("/")) { modal.setNotice("Unknown command. Use /help.", "warning"); return; }
      void ask(value);
    }
    show(renderUserMemory(store));
    if (initial.trim()) void ask(initial.trim());
    return modal;
  }, { mouse: true });
}
