import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Editor, Markdown, matchesKey, wrapTextWithAnsi, type EditorTheme, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { runBackendText } from "./backend.ts";
import {
  buildElevateDiscoveryPrompt, buildElevateUpgradePrompt, parseElevateDiscovery,
  selectedFindings, stripElevateFence, elevateInsertAllowed, type ElevateDiscovery, type ElevateInput,
} from "./elevate-engine.ts";
import { BRO_OVERLAY, broOverlayArea, buttonLabels, delegateMouse, modalHeight, openBroOverlay, renderFrame, Scroller, wrapButtons, type Area, type Theme, type TuiLike } from "./modal-kit.ts";
import { readPreferences, readSettings, selectionForCapability, selectionLabel } from "./settings.ts";
import { captureShowTranscript } from "./show.ts";
import { canBroInsertIntoEditor, insertBroDesktopText, type BroMouseEvent, type BroMouseResult } from "./ui-capabilities.ts";
import { errorMessage } from "./util.ts";

export const ELEVATE_CONTEXT_TURNS = 8;
export const ELEVATE_CONTEXT_MAX = 12_000;

type Stage = "compose" | "discovering" | "review" | "upgrading" | "ready" | "failed";
/** Which zone owns the keyboard. Tab switches; only the focused zone acts on Enter/Space. */
type Zone = "editor" | "list" | "actions";

// The Editor needs room for its own borders and minimum text rows; below that the modal asks for a
// bigger terminal instead of drawing it cut short.
/**
 * The modal never sends messages to, or calls tools on, the main agent. Compose uses the same
 * body Editor as /bro preferences, and every consequential action is a focusable button so a stray
 * keypress cannot toggle a finding, rewrite the request, or replace the editor draft.
 */
export class ElevateModal implements Focusable {
  private _focused = false;
  private readonly editor: Editor;
  private readonly editorViewport = { rows: 24 };
  private readonly markdown = new Markdown("", 0, 0, getMarkdownTheme());
  private readonly scroller = new Scroller(() => this.tui.requestRender());
  private rawArea: Area | undefined;
  private editorArea: Area = { top: 0, left: 0, width: 0, height: 0 };
  private stage: Stage = "compose";
  private zone: Zone = "editor";
  private notice = "";
  private model = "";
  private discovery?: ElevateDiscovery;
  private readonly accepted = new Set<number>();
  private cursor = 0;
  private listOffset = 0;
  private action = 0;
  private original = "";
  private revised = "";
  /** Review pins this checklist above the scrollable explanation. */
  private listText: string[] = [];
  private disposed = false;
  /** The Editor did not render whole at the last layout, so editing could save text the user never saw. */
  private tooSmall = true;
  private findingVisible = false;

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.syncEditorFocus(); }

  /** The Editor shows its cursor only when it actually owns the keyboard, so exactly one thing looks focused. */
  private syncEditorFocus(): void {
    this.editor.focused = this._focused && this.stage === "compose" && this.zone === "editor";
  }

  constructor(
    private readonly tui: TuiLike,
    private readonly theme: Theme,
    private readonly onClose: () => void,
    private readonly onDiscover: (objective: string) => void,
    private readonly onUpgrade: (indexes: ReadonlySet<number>) => void,
    private readonly onInsert: (text: string) => void,
    private readonly onRetry: () => void,
    private readonly onDispose: () => void,
  ) {
    const editorTheme: EditorTheme = { borderColor: (value: string) => this.theme.fg("border", value), selectList: getSelectListTheme() };
    // Editor only needs terminal.rows and requestRender; keep its viewport local to this modal.
    this.editor = new Editor({ terminal: this.editorViewport, requestRender: () => this.tui.requestRender() } as unknown as TUI, editorTheme);
    this.editor.onChange = () => { this.notice = ""; };
    this.draw();
  }

  get currentStage(): Stage { return this.stage; }
  get currentZone(): Zone { return this.zone; }
  get currentDiscovery(): ElevateDiscovery | undefined { return this.discovery; }
  get currentObjective(): string { return this.original; }
  get currentRevised(): string { return this.revised; }
  get currentSelection(): ReadonlySet<number> { return this.accepted; }
  setModel(value: string): void { this.model = value; if (!this.disposed) this.tui.requestRender(); }
  setNotice(value: string): void { if (!this.disposed) { this.notice = value; this.tui.requestRender(); } }

  // Every state setter is inert after disposal: a late backend result must never touch an
  // unmounted component.
  setDiscovering(objective: string): void {
    if (this.disposed) return;
    this.original = objective;
    this.revised = "";
    this.discovery = undefined;
    this.accepted.clear();
    this.stage = "discovering";
    // Waiting stages have no zones; focusing actions keeps Page/wheel scrolling reachable.
    this.zone = "actions";
    this.notice = "";
    this.syncEditorFocus();
    this.drawFromTop();
  }
  setDiscovery(discovery: ElevateDiscovery): void {
    if (this.disposed) return;
    this.discovery = discovery;
    // Nothing is approved by default: accepting model suggestions the user never read is the
    // failure this whole stage exists to prevent.
    this.accepted.clear();
    this.cursor = 0;
    this.listOffset = 0;
    this.action = 0;
    this.zone = discovery.findings.length ? "list" : "actions";
    if (!discovery.findings.length) {
      this.revised = this.original;
      this.stage = "ready";
      this.notice = "No material improvement proposed; the original request is preserved.";
    } else this.stage = "review";
    this.syncEditorFocus();
    this.drawFromTop();
  }
  setUpgrading(): void { if (this.disposed) return; this.stage = "upgrading"; this.zone = "actions"; this.notice = ""; this.syncEditorFocus(); this.drawFromTop(); }
  setReady(value: string): void { if (this.disposed) return; this.stage = "ready"; this.revised = value.trim(); this.notice = ""; this.zone = "actions"; this.action = 0; this.syncEditorFocus(); this.drawFromTop(); }
  setFailed(message: string): void { if (this.disposed) return; this.stage = "failed"; this.notice = message; this.zone = "actions"; this.action = 0; this.syncEditorFocus(); this.drawFromTop(); }
  /** Back to the objective for editing, keeping what the user already wrote. */
  setCompose(objective?: string): void {
    if (this.disposed) return;
    if (objective !== undefined) { this.original = objective; this.editor.setText(objective); }
    this.stage = "compose";
    this.zone = "editor";
    this.notice = "";
    this.syncEditorFocus();
    this.drawFromTop();
  }
  /** Back to the findings without losing the approvals, when a rewrite needs reconsidering. */
  setReview(): void {
    if (this.disposed || !this.discovery) return;
    this.stage = "review";
    this.notice = "";
    this.zone = this.discovery.findings.length ? "list" : "actions";
    this.syncEditorFocus();
    this.drawFromTop();
  }

  private draw(): void {
    let text = "";
    if (this.stage === "compose") text = "";
    else if (this.stage === "discovering") text = `## Discovering gaps\n\n**Original request**\n\n${this.original}\n\nLooking for expert methods, missing evidence and tests. This does not change the main session.`;
    else if (this.stage === "review" && this.discovery) {
      // The checklist stands alone: display order, the cursor, and the tick on each row. No markdown
      // document, so the approval target stays visible while its reason scrolls.
      const list = this.discovery.findings.map((f, i) =>
        `${i === this.cursor && this.zone === "list" ? "›" : " "} ${this.accepted.has(i) ? "[x]" : "[ ]"} ${i + 1}. ${f.title} · ${f.dimension}`);
      this.listText = list;
      // The header already carries the count; keeping the intro to one dim line leaves the rows for
      // the checklist itself, which is the part the user acts on.
      text = this.discovery.assessment;
    } else if (this.stage === "upgrading") text = "## Upgrading your request\n\nPreserving your outcome and constraints. Incorporating only the ideas you approved…";
    else if (this.stage === "ready") text = `## Revised request\n\n${this.revised}\n\n*Review before inserting. Nothing has been submitted to Pi.*`;
    else if (this.stage === "failed") text = "## Elevate stopped\n\nYour original request has not changed. Retry, or close this window.";
    this.markdown.setText(text);
    this.tui.requestRender();
  }

  /** A new stage means new content, so start at the top. */
  private drawFromTop(): void {
    this.draw();
    this.scroller.toStart();
  }

  /** Findings whose box is ticked, in display order. */
  private approved(): ReadonlySet<number> {
    return new Set(this.accepted);
  }

  private zoneIsList(): boolean {
    return this.zone === "list" && !!this.discovery?.findings.length;
  }

  private buttonRow(): { label: string; short: string; run: () => void }[] {
    // `[Edit request]` belongs to screens that already have findings; never to compose, where it
    // would silently reset the text the user is typing.
    const editRequest = this.discovery?.findings.length
      ? [{ label: "Edit request", short: "Edit", run: () => this.setCompose(this.original) }]
      : [];
    if (this.stage === "compose") return [
      { label: "Discover gaps", short: "Discover", run: () => this.discoverFromEditor() },
      { label: "Cancel", short: "Cancel", run: () => this.onClose() },
    ];
    if (this.stage === "review" && this.discovery) {
      const count = this.accepted.size;
      return [
        { label: `Rewrite with ${count} selected`, short: `Rewrite (${count})`, run: () => this.onUpgrade(this.approved()) },
        { label: "Select all", short: "All", run: () => { this.discovery!.findings.forEach((_, i) => this.accepted.add(i)); this.notice = ""; this.draw(); } },
        { label: "Select none", short: "None", run: () => { this.accepted.clear(); this.notice = ""; this.draw(); } },
        ...editRequest,
        { label: "Cancel", short: "Cancel", run: () => this.onClose() },
      ];
    }
    if (this.stage === "ready") return [
      { label: "Insert into editor", short: "Insert", run: () => this.onInsert(this.revised) },
      { label: "Copy", short: "Copy", run: () => void this.copy(this.revised, "Copied revised request.") },
      // Back to the findings with the approvals intact, so a rewrite can be reconsidered without
      // paying for another discovery call.
      ...(this.discovery?.findings.length ? [{ label: "Back", short: "Back", run: () => this.setReview() }] : []),
      ...editRequest,
      { label: "Close", short: "Close", run: () => this.onClose() },
    ];
    if (this.stage === "failed") return [
      { label: "Retry", short: "Retry", run: () => this.onRetry() },
      ...(this.discovery?.findings.length ? [{ label: "Back", short: "Back", run: () => this.setReview() }] : []),
      ...editRequest,
      { label: "Close", short: "Close", run: () => this.onClose() },
    ];
    return [];
  }

  private discoverFromEditor(): void {
    if (this.tooSmall) { this.setNotice("Enlarge the terminal before starting discovery."); return; }
    const objective = this.editor.getExpandedText().trim();
    if (!objective) { this.setNotice("Type what the main agent should achieve first."); return; }
    this.original = objective;
    this.onDiscover(objective);
  }

  private copy(text: string, success: string): Promise<void> {
    return copyToClipboard(text).then(() => this.setNotice(success)).catch((error: unknown) => this.setNotice(`Copy failed: ${errorMessage(error)}`));
  }

  /**
   * The zones a stage actually offers. Ready/failed/waiting have no list, so Tab must not move focus
   * somewhere with no keys: that stranded the user with every key dead.
   */
  private zones(): Zone[] {
    if (this.stage === "compose") return ["editor", "actions"];
    if (this.stage === "review") return this.discovery?.findings.length ? ["list", "actions"] : ["actions"];
    return ["actions"];
  }

  private cycleZone(backwards: boolean): void {
    const zones = this.zones();
    if (zones.length < 2) return;
    const at = zones.indexOf(this.zone);
    const next = ((at === -1 ? 0 : at + (backwards ? -1 : 1)) + zones.length) % zones.length;
    this.zone = zones[next]!;
    if (this.zone === "actions") this.action = 0;
    this.notice = "";
    this.syncEditorFocus();
    // The focus marker is part of the rendered list, so it must be redrawn, not just re-requested.
    this.draw();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, "escape")) { this.onClose(); return; }
    // Ctrl+C rescues the draft in every stage, so closing never loses pasted work. Before a rewrite
    // exists, the objective is the only thing worth copying.
    if (matchesKey(data, "ctrl+c")) {
      const text = (this.revised.trim() || this.editor.getExpandedText().trim() || this.original).trim();
      if (text) void this.copy(text, "Copied.");
      else this.setNotice("Nothing to copy yet.");
      return;
    }
    // PageUp/PageDown and the wheel always scroll the body; Up/Down belong to the list when it has
    // focus, so handleKey is not even called there (it scrolls as a side effect).
    if (this.zone !== "editor" && !this.zoneIsList() && this.scroller.handleKey(data, this.rawArea)) return;

    if (this.stage === "compose") {
      if (this.zone === "editor") {
        // Ctrl+S is the fallback because many terminals never deliver Ctrl+Enter (it needs the kitty
        // keyboard protocol); bare Enter cannot be used, since it must insert a newline here.
        if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+s")) { this.discoverFromEditor(); return; }
        if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) { this.cycleZone(matchesKey(data, "shift+tab")); return; }
        // While the Editor cannot be drawn whole, typing would edit text the user cannot see, and a
        // notice from a previous key must stay clearable.
        if (this.tooSmall) {
          if (this.notice) { this.notice = ""; this.tui.requestRender(); }
          return;
        }
        // Enter is a newline in a multi-line objective, matching /bro preferences.
        if (matchesKey(data, "enter")) { this.editor.insertTextAtCursor("\n"); this.tui.requestRender(); return; }
        this.editor.handleInput(data);
        if (!this.disposed) this.tui.requestRender();
        return;
      }
    } else if (this.stage === "review" && this.discovery) {
      if (this.zone === "list") {
        if (matchesKey(data, "up") || matchesKey(data, "down")) {
          const delta = matchesKey(data, "down") ? 1 : -1;
          this.cursor = Math.max(0, Math.min(this.discovery.findings.length - 1, this.cursor + delta));
          this.notice = "";
          this.scroller.toStart();
          this.draw();
          return;
        }
        // Page keys still scroll, so a long detail stays readable without losing the cursor.
        if (this.scroller.handleKey(data, this.rawArea)) return;
        // Space or Enter toggles the highlighted finding: the target is always on screen, and either
        // key does the same thing so there is no wrong one to press. Tab is what leaves this zone.
        if (matchesKey(data, "space") || matchesKey(data, "enter")) {
          if (!this.findingVisible) { this.setNotice("Enlarge the terminal to review findings."); return; }
          if (this.accepted.has(this.cursor)) this.accepted.delete(this.cursor);
          else this.accepted.add(this.cursor);
          this.notice = "";
          this.draw();
          return;
        }
        if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) { this.cycleZone(matchesKey(data, "shift+tab")); return; }
        return;
      }
    }

    if (this.zone === "actions") {
      const buttons = this.buttonRow();
      if (!buttons.length) return;
      if (matchesKey(data, "left") || matchesKey(data, "right")) {
        const delta = matchesKey(data, "right") ? 1 : -1;
        this.action = (this.action + delta + buttons.length) % buttons.length;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) { this.cycleZone(matchesKey(data, "shift+tab")); return; }
      if (matchesKey(data, "enter") || matchesKey(data, "space")) {
        const button = buttons[this.action];
        if (this.stage === "review" && !this.findingVisible && (this.action === 0 || this.action === 1)) {
          this.setNotice("Enlarge the terminal to review findings.");
          return;
        }
        // [Rewrite with 0 selected] would be a dead end; say why instead of doing nothing.
        if (this.stage === "review" && !this.accepted.size && button?.label.startsWith("Rewrite")) {
          this.setNotice("Choose at least one finding with Space, or press Esc to keep the original.");
          return;
        }
        button?.run();
        if (!this.disposed) this.tui.requestRender();
        return;
      }
    }
    if (!this.disposed) this.tui.requestRender();
  }

  handleMouse(event: BroMouseEvent): BroMouseResult {
    // Clicks reach the Editor so the cursor lands where the user clicked, like the other editor modals.
    if (this.stage === "compose" && this.zone === "editor") return delegateMouse(this.editor, event, this.editorArea);
    return this.scroller.handleMouse(event);
  }

  render(width: number): string[] {
    const height = modalHeight(this.tui, BRO_OVERLAY, 34);
    this.rawArea = broOverlayArea(this.tui, width, height);
    // Reset before layout: a stale area would forward clicks to a rect the Editor no longer occupies.
    this.editorArea = { top: 0, left: 0, width: 0, height: 0 };
    // Assume the Editor does not fit until the body says otherwise: when the frame has no body rows
    // at all the body callback never runs, and a stale `false` would let the user edit blind.
    if (this.stage === "compose") this.tooSmall = true;
    this.findingVisible = false;
    const inner = Math.max(1, width - 2);
    const small = this.theme.fg("warning", "Enlarge the terminal to edit (about 20 rows). Ctrl+C still copies your text.");
    // Switch to short labels when the full set cannot share one line, measuring with the focus marker
    // in place so the row does not change height merely because focus arrived.
    const labels = this.buttonRow();
    const withMarker = labels.map((button, index) => `${index === 0 && this.zone === "actions" ? "›" : ""}[${button.label}]`);
    const narrow = wrapButtons(withMarker, inner).length > 1;
    const buttonRow = () => {
      if (!labels.length) return "";
      const rendered = buttonLabels(this.theme, labels.map((button) => (narrow ? button.short : button.label)), this.zone === "actions" ? this.action : undefined);
      return wrapButtons(rendered, inner).join("\n");
    };
    // On a terminal too small for the guidance line, the guard rides in the hints so it still shows.
    // Constant height on purpose: hints that wrap to a different number of lines when `tooSmall`
    // changes would flip the fit guard on every render (see createTextEditorModal).
    const hints = this.stage === "compose"
      ? "Enter newline · Ctrl+S or Ctrl+Enter discover · Tab actions · Esc cancel"
      : this.stage === "review" ? "↑↓ move · Space/Enter toggle · Tab actions · Ctrl+C copy · Esc cancel"
      : this.stage === "ready" ? "↑↓ scroll · Ctrl+C copy · Esc close"
      : this.stage === "failed" ? "Ctrl+C copy · Esc close"
      : "Thinking… · Esc cancel";
    return renderFrame(this.theme, width, height, {
      header: () => this.theme.fg("accent", this.theme.bold("Bro · elevate"))
        + (this.model ? this.theme.fg("dim", ` · ${this.model}`) : "")
        + (this.stage === "review" && this.discovery?.findings.length ? this.theme.fg("dim", ` · ${this.accepted.size}/${this.discovery.findings.length} selected`) : "")
        + (this.stage !== "compose" && this.scroller.indicator() ? this.theme.fg("dim", ` · ${this.scroller.indicator()}`) : ""),
      body: (rows, innerWidth) => {
        if (this.stage !== "review" || !this.discovery) {
          if (this.stage === "compose") {
            // Compose: the objective is the whole body, and the Editor is never drawn cut short.
            const intro = [
              this.theme.bold("Your objective"),
              this.theme.fg("dim", "What should the main agent achieve? Enter adds a line."),
              "",
            ];
            // shortcut: Editor uses max(5, floor(terminal.rows * 0.3)); use a height API when Pi provides one.
            this.editorViewport.rows = Math.ceil(Math.max(5, rows - intro.length - 2) / 0.3);
            this.tooSmall = rows < intro.length + 7;
            if (this.tooSmall) return wrapTextWithAnsi(small, innerWidth).slice(0, rows);
            const editorLines = this.editor.render(innerWidth);
            // The frame draws a top border, a header and a rule above the body, and one column of
            // left border, so mouse coordinates need that same origin.
            this.editorArea = { top: 3 + intro.length, left: 1, width: innerWidth, height: editorLines.length };
            return [...intro, ...editorLines].slice(0, rows);
          }
          return this.scroller.view(this.markdown.render(innerWidth), rows);
        }
        // Pin the approval target; only its explanation scrolls.
        const current = this.discovery.findings[this.cursor];
        const label = (name: string, value: string) => wrapTextWithAnsi(`${this.theme.fg("dim", `${name}: `)}${value}`, innerWidth);
        const intro = this.markdown.render(innerWidth);
        const detail = current ? [...label("Why", current.why), ...label("Move", current.expertMove)] : [];
        const assessment = intro.length + this.listText.length + detail.length <= rows ? intro : [];
        const listRows = Math.min(this.listText.length, Math.max(1, rows - 2));
        this.listOffset = Math.max(0, Math.min(this.listOffset, this.listText.length - listRows));
        if (this.cursor < this.listOffset) this.listOffset = this.cursor;
        else if (this.cursor >= this.listOffset + listRows) this.listOffset = this.cursor - listRows + 1;
        const list = this.listText.slice(this.listOffset, this.listOffset + listRows);
        this.findingVisible = true;
        const detailRows = rows - assessment.length - list.length;
        const visibleDetail = this.scroller.view(detailRows > 0 ? detail : [], detailRows);
        return [...assessment, ...list, ...visibleDetail];
      },
      footer: [],
      notice: this.notice ? this.theme.fg(this.stage === "failed" ? "warning" : "accent", this.notice) : undefined,
      hints,
      footerAfterHints: buttonRow(),
    });
  }
  invalidate(): void { this.markdown.invalidate(); this.editor.invalidate(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // The host can unmount the overlay without a key press; abort the in-flight call there too,
    // otherwise a background subprocess keeps running with no window left to show its result.
    this.onDispose();
  }
}

/** A user-driven two-call workflow with isolated transcript and abort-on-close. */
export async function openElevateModal(ctx: ExtensionCommandContext, request = ""): Promise<void> {
  const initialEditor = ctx.ui.getEditorText();
  const initialObjective = request.trim() || initialEditor.trim();
  // Whether the editor draft is the thing being elevated. Only then may insertion replace it.
  const elevatingEditorDraft = !request.trim() && !!initialEditor.trim();
  const context = captureShowTranscript(ctx, ELEVATE_CONTEXT_TURNS, ELEVATE_CONTEXT_MAX)?.text;
  await openBroOverlay<void>(ctx, (tui, theme, _keybindings, done) => {
    let closed = false;
    let controller: AbortController | undefined;
    let inserting = false;
    let original = initialObjective;
    let input: ElevateInput = { objective: original, context };
    /** Which approvals a retry should reuse, and which call to repeat. */
    let pending: { kind: "discover" } | { kind: "upgrade"; indexes: ReadonlySet<number> } = { kind: "discover" };
    const close = () => {
      if (closed) return;
      closed = true;
      controller?.abort();
      done(undefined);
    };

    const modal = new ElevateModal(tui, theme, close, discover, upgrade, insert, retryStage, close);

    async function discover(objective: string): Promise<void> {
      if (closed || controller) return;
      original = objective.trim();
      input = { objective: original, context };
      const run = new AbortController();
      controller = run;
      pending = { kind: "discover" };
      modal.setDiscovering(original);
      try {
        const [settings, preferences] = await Promise.all([readSettings(), readPreferences()]);
        if (closed || run.signal.aborted) return;
        input.preferences = preferences;
        const selection = selectionForCapability(settings, "btw");
        modal.setModel(selectionLabel(selection));
        const raw = await runBackendText(buildElevateDiscoveryPrompt(input), selection, run.signal);
        if (closed || run.signal.aborted) return;
        modal.setDiscovery(parseElevateDiscovery(raw));
      } catch (error) {
        if (!closed && !run.signal.aborted) modal.setFailed(errorMessage(error));
      } finally { if (controller === run) controller = undefined; }
    }

    async function upgrade(indexes: ReadonlySet<number>): Promise<void> {
      if (closed || controller) return;
      const run = new AbortController();
      controller = run;
      // A failed rewrite retries the rewrite; re-running discovery would discard the user's choices.
      pending = { kind: "upgrade", indexes };
      modal.setUpgrading();
      try {
        const settings = await readSettings();
        if (closed || run.signal.aborted) return;
        // Re-read so an edit between Discovery and Upgrade applies, as settings.md promises.
        input.preferences = await readPreferences();
        if (closed || run.signal.aborted) return;
        // Preserve the selection and avoid accidentally adding rejected ideas.
        const discovery = modal.currentDiscovery;
        if (!discovery) throw new Error("Discovery is missing. Retry.");
        const approved = selectedFindings(discovery, indexes);
        const selection = selectionForCapability(settings, "btw");
        modal.setModel(selectionLabel(selection));
        const revised = await runBackendText(buildElevateUpgradePrompt(input, approved), selection, run.signal);
        if (closed || run.signal.aborted) return;
        if (!revised.trim()) throw new Error("Bro returned an empty request. Retry.");
        // Validate after stripping: a fence containing only whitespace is still empty output, and
        // inserting it would erase the draft.
        const cleaned = stripElevateFence(revised);
        if (!cleaned) throw new Error("Bro returned an empty request. Retry.");
        modal.setReady(cleaned);
      } catch (error) {
        if (!closed && !run.signal.aborted) modal.setFailed(errorMessage(error));
      } finally { if (controller === run) controller = undefined; }
    }

    /** Retry whichever call failed, with the objective and approvals the user already chose. */
    function retryStage(): void {
      if (closed || controller) return;
      if (pending.kind === "upgrade") void upgrade(pending.indexes);
      else void discover(original);
    }

    async function insert(text: string): Promise<void> {
      if (closed || inserting) return;
      if (canBroInsertIntoEditor(ctx)) {
        const current = ctx.ui.getEditorText();
        if (!elevateInsertAllowed(elevatingEditorDraft, initialEditor, current)) {
          modal.setNotice(elevatingEditorDraft
            ? "Main editor changed. Copy instead; your draft was not overwritten."
            : "Main editor has a draft. Clear it first, or press Copy instead.");
          return;
        }
        ctx.ui.setEditorText(text);
        close();
        ctx.ui.notify("Elevate inserted the revised request. Review it before submitting.", "info");
        return;
      }
      // Desktop has an atomic empty-editor insertion API. Never overwrite a draft there.
      inserting = true;
      let result: Awaited<ReturnType<typeof insertBroDesktopText>>;
      try { result = await insertBroDesktopText(ctx, text); }
      finally { inserting = false; }
      if (closed) return;
      modal.setNotice(result === "inserted"
        ? "Inserted into the main editor. Review it before submitting."
        : result === "not_empty"
          ? "Desktop editor has a draft; copy the revised request instead."
          : "Desktop cannot insert here; copy the revised request instead.");
      if (result === "inserted") close();
    }

    if (initialObjective) void Promise.resolve().then(() => discover(initialObjective));
    return modal;
  }, { mouse: true });
}
