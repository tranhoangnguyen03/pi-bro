import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, matchesKey, wrapTextWithAnsi, type Focusable } from "@earendil-works/pi-tui";
import { BRO_OVERLAY, broOverlayArea, formatNotice, modalHeight, renderFrame, runningHint, Scroller, type Area, type NoticeTone, type Theme, type TuiLike } from "./modal-kit.ts";
import type { BroMouseEvent, BroMouseResult } from "./ui-capabilities.ts";

export class ComposerModal implements Focusable {
	private _focused = false;
	private readonly markdown = new Markdown("", 0, 0, getMarkdownTheme());
	private readonly input = new Input();
	private noticeText = "";
	private noticeTone: NoticeTone = "info";
	private rawArea: Area | undefined;
	// Follows the newest text until the reader scrolls up; scrolling back to the end follows again.
	private readonly scroller = new Scroller(
		() => {
			this.noticeText = "";
			this.tui.requestRender();
		},
		{ followEnd: true },
	);
	private running = false;
	private progressText = "";
	private trailingMode?: { label: string; emphasized: boolean };
	private model = "";
	private customMode = "";
	private disposed = false;
	onInput?: () => void;
	onKey?: (data: string) => boolean;
	private suggestions = "";

	setSuggestions(text: string): void {
		this.suggestions = text;
		this.tui.requestRender();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private readonly tui: TuiLike,
		private readonly theme: Theme,
		private readonly onClose: () => void,
		private readonly onSubmit: (value: string) => void,
		private readonly onDispose: () => void,
		private readonly appearance: { title?: string; commands?: string; inputLabel?: string; idleHint?: string | (() => string) } = {},
	) {
		this.input.onSubmit = (value) => {
			if (!this.running) this.onSubmit(value);
		};
	}

	// Keeps the reader's place; the scroller clamps when the text shrinks (e.g. /clear).
	setText(text: string): void {
		this.markdown.setText(text);
		this.tui.requestRender();
	}

	/** Start at the top of a static or single-document view. */
	scrollToStart(): void {
		this.scroller.toStart();
		this.tui.requestRender();
	}

	/** Show the newest text and keep following it while a reply streams. */
	scrollToEnd(): void {
		this.scroller.toEnd();
		this.tui.requestRender();
	}

	get notice(): string {
		return this.noticeText;
	}

	set notice(notice: string) {
		this.setNotice(notice);
	}

	setNotice(notice: string, tone: NoticeTone = "info"): void {
		if (this.disposed) return;
		this.noticeText = notice;
		this.noticeTone = tone;
		this.tui.requestRender();
	}

	setRunning(running: boolean): void {
		this.running = running;
		if (!running) this.progressText = "";
		this.tui.requestRender();
	}

	/** Ephemeral in-flight status; never enters the thread or clipboard. */
	setProgress(text: string): void {
		if (this.disposed || !this.running) return;
		this.progressText = text;
		this.tui.requestRender();
	}

	setModel(model: string): void {
		this.model = model;
		this.tui.requestRender();
	}

	setTrailingMode(label: string, emphasized = false): void {
		this.trailingMode = { label, emphasized };
		this.tui.requestRender();
	}

	setCustomMode(label: string): void {
		this.customMode = label;
		this.tui.requestRender();
	}

	clearComposer(): void {
		this.input.setValue("");
		this.tui.requestRender();
	}

	getComposerText(): string {
		return this.input.getValue();
	}

	setComposerText(text: string): void {
		this.input.setValue(text);
		(this.input as unknown as { cursor: number }).cursor = text.length;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.markdown.invalidate();
		this.input.invalidate();
	}

	handleMouse(event: BroMouseEvent): BroMouseResult {
		return this.scroller.handleMouse(event);
	}

	handleInput(data: string): void {
		if (this.onKey?.(data)) return;
		if (matchesKey(data, "escape")) {
			this.onClose();
			return;
		}
		if (this.scroller.handleKey(data, this.rawArea)) return;
		this.input.handleInput(data);
		this.onInput?.();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const height = modalHeight(this.tui, BRO_OVERLAY, 34);
		this.rawArea = broOverlayArea(this.tui, width, height);
		return renderFrame(this.theme, width, height, {
			header: () => {
				const scroll = this.scroller.indicator();
				const model = this.model ? this.theme.fg("dim", ` · ${this.model}`) : "";
				const mode = this.customMode
					? this.theme.fg("dim", this.customMode)
					: this.trailingMode
						? this.theme.fg("dim", " · ") + (this.trailingMode.emphasized ? this.theme.fg("accent", this.theme.bold(this.trailingMode.label)) : this.theme.fg("dim", this.trailingMode.label))
						: "";
				const title = this.theme.fg("accent", this.theme.bold(this.appearance.title ?? "Bro"));
				// A leading label stays visible when the title and model must be truncated.
				const header = this.customMode ? `${mode} · ${title}${model}` : title + model + mode;
				return header + this.theme.fg("dim", scroll ? ` · ${scroll}` : "");
			},
			body: (rows, innerWidth) => this.scroller.view(this.markdown.render(innerWidth), rows),
			// The frame drops lines from the top when space runs out, so the composer goes last.
			footer: [
				...(this.appearance.commands ? wrapTextWithAnsi(this.appearance.commands, inner) : []),
				...(this.suggestions ? wrapTextWithAnsi(this.theme.fg("accent", this.suggestions), inner) : []),
				this.theme.fg("accent", this.theme.bold(this.appearance.inputLabel ?? "Your message")),
				this.input.render(inner)[0] ?? "",
			],
			notice: this.noticeText ? formatNotice(this.theme, this.noticeText, this.noticeTone) : undefined,
			// A tool label may be long. Preserve the elapsed seconds and Esc
			// on one line; shorten only the stage so transcript height stays put.
			hints: this.running
				? runningHint(this.progressText || "Bro is thinking…", inner, [
					" · Esc close (stops reply)", " · Esc close",
				])
				: (typeof this.appearance.idleHint === "function" ? this.appearance.idleHint() : this.appearance.idleHint ?? "Enter send · Esc close"),
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.onDispose();
	}
}
