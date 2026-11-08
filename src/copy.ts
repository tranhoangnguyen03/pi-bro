/**
 * Private, model-free Markdown scratchpad for the last completed Pi answer.
 *
 * One Editor owns the draft. Preview is a rendering of that same draft;
 * clipboard copy never reads terminal output or the Markdown renderer.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Editor, Markdown, getKeybindings, matchesKey, wrapTextWithAnsi, type Component, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { broOverlayArea, delegateMouse, formatNotice, modalHeight, openBroOverlay, renderFrame, Scroller, type Area, type Theme, type TuiLike } from "./modal-kit.ts";
import { hasBroCustomUi, type BroMouseEvent, type BroMouseResult } from "./ui-capabilities.ts";
import { errorMessage } from "./util.ts";
import { latestCompletedAssistantText } from "./last-assistant.ts";
import { RawMarkdownDraft, type MarkdownEdit, type MarkdownEditKind } from "./copy-draft.ts";

type CopyText = (markdown: string) => Promise<void>;
type CopyView = "edit" | "preview";

function editKind(data: string): MarkdownEditKind {
  const keys = getKeybindings();
  if (keys.matches(data, "tui.editor.undo")) return "undo";
  if ((["tui.editor.deleteCharBackward", "tui.editor.deleteWordBackward", "tui.editor.deleteToLineStart"] as const)
    .some(action => keys.matches(data, action)) || matchesKey(data, "shift+backspace")) return "backward";
  if ((["tui.editor.deleteCharForward", "tui.editor.deleteWordForward", "tui.editor.deleteToLineEnd"] as const)
    .some(action => keys.matches(data, action)) || matchesKey(data, "shift+delete")) return "forward";
  if (keys.matches(data, "tui.editor.yankPop")) return "unknown";
  return "insert";
}

/**
 * Pi Editor exposes cursor positions in DISPLAY text. For ordinary text that
 * equals expanded text. Large bracketed pastes use atomic [paste #] markers:
 * offsets before the first marker or after the last remain unambiguous.
 * A cursor BETWEEN distinct paste markers cannot be mapped through the public
 * API; refuse that edit rather than guess and alter unrelated raw bytes.
 */
function expandedCursorOffset(editor: Editor): number | undefined {
  const lines = editor.getLines();
  const cursor = editor.getCursor();
  if (cursor.line < 0 || cursor.line >= lines.length ||
      cursor.col < 0 || cursor.col > lines[cursor.line]!.length) return undefined;
  let pos = cursor.col;
  for (let i = 0; i < cursor.line; i++) pos += lines[i]!.length + 1;
  const visible = editor.getText();
  const expanded = editor.getExpandedText();
  if (visible === expanded) return pos;
  const markers = [...visible.matchAll(/\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]/g)];
  if (markers.some(m => m.index < pos && pos < m.index + m[0].length)) return undefined;
  if (!markers.some(m => m.index < pos)) return pos;
  if (!markers.some(m => m.index >= pos)) return expanded.length - (visible.length - pos);
  return undefined;
}

export class CopyModal implements Component {
  readonly editor: Editor;
  private readonly preview: Markdown;
  private readonly scroller: Scroller;
  private readonly original: string;
  private readonly draft: RawMarkdownDraft;
  private pendingEdit?: MarkdownEdit;
  private fidelityError?: string;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private readonly copyText: CopyText;

  private view: CopyView = "edit";
  private showingHelp = false;
  private discardArmed = false;
  private canEdit = false;
  private closed = false;
  private notice = "";
  private editorArea: Area = { top: 0, left: 0, width: 0, height: 0 };
  private modalArea: Area | undefined;

  constructor(tui: TUI, theme: Theme, markdown: string, onClose: () => void, copyText: CopyText = copyToClipboard) {
    this.tui = tui;
    this.theme = theme;
    this.original = markdown;
    this.onClose = onClose;
    this.copyText = copyText;
    const editorTheme: EditorTheme = {
      borderColor: (value: string) => theme.fg("border", value),
      selectList: getSelectListTheme(),
    };
    this.editor = new Editor(tui, editorTheme);
    this.editor.focused = true;
    this.editor.setText(markdown);
    this.draft = new RawMarkdownDraft(markdown, this.editor.getExpandedText());
    this.editor.onChange = () => {
      const next = this.editor.getExpandedText();
      try {
        this.draft.update(next, {
          kind: this.pendingEdit?.kind ?? "unknown",
          beforeCursor: this.pendingEdit?.beforeCursor,
          afterCursor: expandedCursorOffset(this.editor),
        });
        this.fidelityError = undefined;
      } catch (error) {
        this.fidelityError = "Cannot map this edit safely to original Markdown (" +
          errorMessage(error) + "). Undo the edit or reopen Copy.";
      }
      // One input event can generate several changes; each next change starts
      // from the cursor left by the previous change.
      if (this.pendingEdit) this.pendingEdit.beforeCursor = expandedCursorOffset(this.editor);
      this.discardArmed = false;
      this.notice = "";
      this.tui.requestRender();
    };
    this.preview = new Markdown("", 0, 0, getMarkdownTheme());
    this.scroller = new Scroller(() => this.tui.requestRender());
  }

  private noticeOf(message: string, tone: "info" | "success" | "warning" | "error"): void {
    if (this.closed) return;
    this.notice = formatNotice(this.theme, message, tone);
    this.tui.requestRender();
  }

  /** Use one definition of a dirty draft for both rendering and closing.
   * An unmappable edit changes the visible Editor before raw reconciliation can
   * update the draft, so comparing only the raw text can silently discard work.
   */
  private hasUncommittedChanges(): boolean {
    return Boolean(this.fidelityError) ||
      this.editor.getExpandedText() !== this.draft.editorText ||
      this.markdown() !== this.original;
  }

  /** Copy and Preview use raw source with untouched bytes preserved across edits. */
  private markdown(): string { return this.draft.text; }

  private copy(): void {
    // Esc requires two consecutive presses to discard; an intervening copy
    // attempt must never leave an earlier confirmation armed.
    this.discardArmed = false;
    if (this.fidelityError) { this.noticeOf(this.fidelityError + " Copy is blocked.", "error"); return; }
    // Snapshot before the async clipboard operation. Always copy expanded paste
    // content, never editor display markers or rendered ANSI/Markdown.
    const markdown = this.markdown();
    void Promise.resolve()
      .then(() => this.copyText(markdown))
      .then(() => this.noticeOf("Copied edited Markdown.", "success"))
      .catch(error => this.noticeOf("Copy failed: " + errorMessage(error), "error"));
  }

  private toggleView(): void {
    if (this.closed) return;
    if (this.fidelityError) { this.noticeOf(this.fidelityError, "error"); return; }
    this.showingHelp = false;
    this.discardArmed = false;
    this.notice = "";
    this.view = this.view === "edit" ? "preview" : "edit";
    if (this.view === "preview") {
      this.preview.setText(this.markdown());
      this.scroller.toStart();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = modalHeight(this.tui);
    const innerWidth = Math.max(1, width - 2);
    this.modalArea = broOverlayArea(this.tui as TuiLike, width, height);
    this.canEdit = false;
    this.editorArea = { top: 0, left: 0, width: 0, height: 0 };

    const edited = this.hasUncommittedChanges();
    const hint = this.showingHelp
      ? "Esc back · Ctrl+G back · Ctrl+C copy"
      : this.discardArmed
        ? "Esc again discard · Ctrl+C copy · Ctrl+D preview/edit"
        : this.view === "edit"
          ? "Ctrl+D preview · Ctrl+C copy · Ctrl+G help · Esc close"
          : "↑/↓ scroll · Ctrl+D edit · Ctrl+C copy · ? help · Esc close";
    const editorLines = !this.showingHelp && this.view === "edit" ? this.editor.render(innerWidth) : [];
    const help = [
      "Edit the last completed assistant reply as raw Markdown.",
      "The original Pi conversation is never changed.",
      "",
      "Ctrl+D   Switch between Edit and Markdown Preview",
      "Ctrl+C   Copy the current raw Markdown (from either view)",
      "Ctrl+G   Show/hide Help in both views",
      "?        Help in Preview; in Edit, '?' is normal text",
      "Esc      Back from Help; close (confirm if edited)",
      "",
      "No model calls, saved drafts, or workspace changes.",
    ];
    return renderFrame(this.theme, width, height, {
      header: () => this.theme.fg("accent", this.theme.bold("Bro · Copy · " +
        (this.showingHelp ? "Help" : this.view === "edit" ? "Edit" : "Preview"))) +
        (edited ? this.theme.fg("dim", " · edited") : "") +
        (!this.showingHelp && this.view === "preview" && this.scroller.indicator()
          ? this.theme.fg("dim", " · " + this.scroller.indicator()) : ""),
      body: (rows, inner) => {
        if (this.showingHelp) return this.scroller.view(help.flatMap(line => wrapTextWithAnsi(line, inner)), rows);
        if (this.view === "preview") return this.scroller.view(this.preview.render(inner), rows);
        if (rows < editorLines.length) {
          return wrapTextWithAnsi("Enlarge the terminal to edit. Ctrl+D previews; Ctrl+C still copies the full draft.", inner).slice(0, rows);
        }
        this.canEdit = true;
        // The first body row begins immediately below top border, header, and rule.
        this.editorArea = { top: 3, left: 1, width: inner, height: editorLines.length };
        return editorLines;
      },
      notice: this.discardArmed ? this.notice :
        this.fidelityError ? formatNotice(this.theme, this.fidelityError, "error") : this.notice,
      hints: hint,
      minBody: this.showingHelp || this.view === "preview" ? 1 : editorLines.length,
      fill: true,
    });
  }

  invalidate(): void {
    this.editor.invalidate();
    this.preview.invalidate();
  }

  handleMouse(event: BroMouseEvent): BroMouseResult {
    if (this.showingHelp || this.view === "preview") return this.scroller.handleMouse(event);
    return delegateMouse(this.editor, event, this.editorArea);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "ctrl+c")) { this.copy(); return; }
    if (matchesKey(data, "escape")) {
      if (this.showingHelp) {
        this.showingHelp = false;
        this.scroller.toStart();
        this.tui.requestRender();
        return;
      }
      if (this.hasUncommittedChanges() && !this.discardArmed) {
        this.discardArmed = true;
        this.noticeOf(this.fidelityError
          ? "Unmapped edits will be discarded. Esc again to close, or Undo to recover."
          : "Edits will be discarded. Esc again to close, or Ctrl+C to copy.", "warning");
        return;
      }
      this.closed = true;
      this.onClose();
      return;
    }
    if (matchesKey(data, "ctrl+d")) { this.toggleView(); return; }
    if (matchesKey(data, "ctrl+g") || (this.view === "preview" && matchesKey(data, "?"))) {
      this.showingHelp = !this.showingHelp;
      this.scroller.toStart();
      this.notice = "";
      this.discardArmed = false;
      this.tui.requestRender();
      return;
    }

    if (this.showingHelp || this.view === "preview") {
      if (!this.scroller.handleKey(data, this.modalArea)) this.tui.requestRender();
      return;
    }
    // Never pass input to an invisible editor; copy, preview and exit still work.
    if (!this.canEdit) return;
    this.discardArmed = false;
    this.notice = "";
    this.pendingEdit = { kind: matchesKey(data, "enter") ? "insert" : editKind(data),
      beforeCursor: expandedCursorOffset(this.editor) };
    try {
      if (matchesKey(data, "enter")) this.editor.insertTextAtCursor("\n");
      else this.editor.handleInput(data);
    } finally {
      this.pendingEdit = undefined;
    }
    this.tui.requestRender();
  }

  dispose(): void { this.closed = true; }
}

export async function openCopyModal(ctx: ExtensionCommandContext): Promise<void> {
  if (!hasBroCustomUi(ctx)) {
    ctx.ui.notify("Use /bro copy in Pi's interactive terminal.", "warning");
    return;
  }
  const markdown = latestCompletedAssistantText(ctx.sessionManager.getBranch());
  if (!markdown) {
    ctx.ui.notify("No completed assistant reply to copy yet.", "warning");
    return;
  }
  await openBroOverlay<void>(
    ctx,
    (tui, theme, _keys, done) => new CopyModal(tui, theme, markdown, () => done()),
    { mouse: true },
  );
}
