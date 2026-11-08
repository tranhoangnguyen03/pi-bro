/** One question list editor for global defaults and session snapshots. */
import { Input, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { modalHeight, openBroOverlay, renderFrame, Scroller, formatNotice, type Theme } from "./modal-kit.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { checkQuestions, MAX_OVERTHINK_QUESTIONS, MAX_OVERTHINK_QUESTION_CHARS } from "./overthink-state.ts";
import { errorMessage } from "./util.ts";

type EditorOptions = {
  title: string; questions: string[]; reset: () => Promise<string[]>;
  save: (questions: string[]) => Promise<void> | void;
};

export function createOverthinkQuestionEditor(options: EditorOptions) {
  return (tui: TUI, theme: Theme, _keys: unknown, done: (value?: void) => void): Component => {
    let questions = [...options.questions];
    let saved = JSON.stringify(questions);
    let cursor = 0;
    let mode: "list" | "edit" = "list";
    let input = new Input();
    let editingIndex = -1;
    let pending = false;
    let closed = false;
    let resetArmed = false;
    let discardArmed = false;
    let notice = "";
    const scroller = new Scroller(() => tui.requestRender());
    const dirty = () => JSON.stringify(questions) !== saved;
    const warn = (message: string, tone: "info" | "success" | "error" | "warning" = "info") => {
      notice = formatNotice(theme, message, tone); tui.requestRender();
    };
    const beginEdit = (index: number) => {
      mode = "edit"; editingIndex = index;
      input = new Input();
      input.setValue(questions[index] ?? "");
      input.onSubmit = (value: string) => {
        const trimmed = value.trim();
        if (!trimmed || trimmed.length > MAX_OVERTHINK_QUESTION_CHARS || /[\r\n]/.test(trimmed)) {
          warn("Enter one nonempty question (max " + MAX_OVERTHINK_QUESTION_CHARS + " characters).", "warning"); return;
        }
        if (editingIndex === questions.length) questions.push(trimmed);
        else questions[editingIndex] = trimmed;
        mode = "list"; cursor = editingIndex; resetArmed = false;
        discardArmed = false; notice = ""; tui.requestRender();
      };
      tui.requestRender();
    };
    const save = async () => {
      if (pending) return;
      let clean: string[];
      try { clean = checkQuestions(questions); }
      catch (error) { warn(errorMessage(error), "error"); return; }
      pending = true; tui.requestRender();
      try { await options.save(clean); saved = JSON.stringify(clean); questions = clean; warn("Questions saved.", "success"); }
      catch (error) { warn("Save failed: " + errorMessage(error), "error"); }
      finally { pending = false; tui.requestRender(); }
    };
    const reset = async () => {
      pending = true; tui.requestRender();
      try {
        questions = checkQuestions(await options.reset());
        cursor = 0; scroller.toStart(); resetArmed = false; discardArmed = false;
        warn("Reset in editor. Ctrl+S to save.", "warning");
      } catch (error) { warn("Reset failed: " + errorMessage(error), "error"); }
      finally { pending = false; tui.requestRender(); }
    };
    return {
      render(width: number) {
        const height = modalHeight(tui);
        const list = questions.length ? questions.map((question, index) =>
          (index === cursor ? theme.fg("accent", "> ") : "  ") +
          theme.fg(index === cursor ? "accent" : "text", truncateToWidth(String(index + 1) + ". " + question, Math.max(8, width - 6), "…"))
        ) : [theme.fg("muted", "No questions. Add one, or save an empty list to disable checks.")];
        return renderFrame(theme, width, height, {
          header: () => theme.fg("accent", theme.bold(options.title)) + (dirty() ? " *" : ""),
          body: (rows, inner) => mode === "edit"
            ? ["Edit question:", ...input.render(inner)].slice(0, rows)
            : scroller.view(list, rows),
          notice,
          hints: mode === "edit" ? "Enter apply · Esc cancel edit" :
            "↑/↓ select · Enter edit · Ctrl+N add · Ctrl+X delete · Ctrl+↑/↓ move · Ctrl+D reset · Ctrl+S save · Esc close",
          fill: true,
        });
      },
      invalidate() {},
      handleInput(data: string) {
        if (pending || closed) return;
        if (mode === "edit") {
          if (matchesKey(data, "escape")) { mode = "list"; notice = ""; tui.requestRender(); return; }
          input.handleInput(data); tui.requestRender(); return;
        }
        if (matchesKey(data, "escape")) {
          if (resetArmed) { resetArmed = false; warn("Reset cancelled."); return; }
          if (dirty() && !discardArmed) { discardArmed = true; warn("Unsaved questions. Esc again to discard, Ctrl+S to save.", "warning"); return; }
          closed = true; done(); return;
        }
        discardArmed = false;
        if (matchesKey(data, "ctrl+s")) { void save(); return; }
        if (matchesKey(data, "ctrl+n")) {
          if (questions.length >= MAX_OVERTHINK_QUESTIONS) { warn("Maximum " + MAX_OVERTHINK_QUESTIONS + " questions.", "warning"); return; }
          beginEdit(questions.length); return;
        }
        if (matchesKey(data, "ctrl+d")) {
          if (!resetArmed) { resetArmed = true; warn("Ctrl+D again to reset this list, then Ctrl+S to save.", "warning"); return; }
          void reset(); return;
        }
        resetArmed = false;
        if (matchesKey(data, "ctrl+x") && questions.length) {
          questions.splice(cursor, 1); cursor = Math.min(cursor, Math.max(0, questions.length - 1));
          warn("Question removed from draft. Ctrl+S to save."); return;
        }
        if (matchesKey(data, "ctrl+up") && cursor > 0) {
          [questions[cursor - 1], questions[cursor]] = [questions[cursor]!, questions[cursor - 1]!];
          cursor--; tui.requestRender(); return;
        }
        if (matchesKey(data, "ctrl+down") && cursor < questions.length - 1) {
          [questions[cursor + 1], questions[cursor]] = [questions[cursor]!, questions[cursor + 1]!];
          cursor++; tui.requestRender(); return;
        }
        if (matchesKey(data, "up")) { cursor = Math.max(0, cursor - 1); scroller.by(-1); tui.requestRender(); return; }
        if (matchesKey(data, "down")) { cursor = Math.min(questions.length - 1, cursor + 1); scroller.by(1); tui.requestRender(); return; }
        if (matchesKey(data, "return") || matchesKey(data, "enter")) {
          if (questions.length) beginEdit(cursor);
        }
      },
    };
  };
}

export async function openOverthinkQuestionEditor(ctx: ExtensionCommandContext, options: EditorOptions): Promise<void> {
  await openBroOverlay<void>(ctx, createOverthinkQuestionEditor(options));
}
