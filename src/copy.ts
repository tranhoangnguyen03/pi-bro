/**
 * Private, model-free Markdown scratchpad for the last completed Pi answer.
 *
 * One Editor owns the draft. Preview is a rendering of that same draft;
 * clipboard copy never reads terminal output or the Markdown renderer.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Editor, Markdown, matchesKey, wrapTextWithAnsi, type Component, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { broOverlayArea, delegateMouse, formatNotice, modalHeight, openBroOverlay, renderFrame, Scroller, type Area, type Theme, type TuiLike } from "./modal-kit.ts";
import { hasBroCustomUi, type BroMouseEvent, type BroMouseResult } from "./ui-capabilities.ts";
import { errorMessage } from "./util.ts";
import { latestCompletedAssistantText } from "./last-assistant.ts";
import { RawMarkdownDraft } from "./copy-draft.ts";

type CopyText = (markdown: string) => Promise<void>;
type CopyView = "edit" | "preview";

export class CopyModal implements Component {
  readonly editor: Editor;
  private readonly preview: Markdown;
  private readonly scroller: Scroller;
  private readonly original: string;
  private readonly draft: RawMarkdownDraft;
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
      this.draft.update(this.editor.getExpandedText());
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

  /** Copy and Preview use raw source with untouched bytes preserved across edits. */
  private markdown(): string { return this.draft.text; }

  private copy(): void {
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

    const edited = this.markdown() !== this.original;
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
      notice: this.notice,
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
      if (this.markdown() !== this.original && !this.discardArmed) {
        this.discardArmed = true;
        this.noticeOf("Edits will be discarded. Esc again to close, or Ctrl+C to copy.", "warning");
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
    if (matchesKey(data, "enter")) this.editor.insertTextAtCursor("\n");
    else this.editor.handleInput(data);
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
