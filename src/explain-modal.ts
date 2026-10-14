import { rm, writeFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	Markdown,
	matchesKey,
	wrapTextWithAnsi,
	type Component,
	type EditorTheme,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import { ADVISOR_STEERING_ENTRY, ADVISOR_STEERING_FILE, resolveAdvisorState } from "./advisor.ts";
import { runBackendText } from "./backend.ts";
import type { Theme, TuiLike } from "./config-ui.ts";
import {
	type BroMode,
	MAX_PREFERENCES_CHARS,
	STARTER_PREFERENCES,
	buildDefaultPrompt,
	nextBroMode,
} from "./prompt.ts";
import {
	type BroSettings,
	CAPABILITIES,
	CAPABILITY_LABELS,
	PREFERENCES_FILE,
	capabilityOverride,
	queuePreferencesWrite,
	readPreferences,
	readPreferencesRaw,
	selectionForCapability,
	selectionLabel,
	settingsFile,
} from "./settings.ts";
import { openShowHtml, stripShowDiagramFence } from "./show.ts";
import type { BroSource } from "./sources.ts";
import { BRO_OVERLAY, broOverlayArea, delegateMouse, modalHeight, openBroOverlay, renderFrame, Scroller, type Area } from "./modal-kit.ts";
import { hasBroCustomUi, type BroMouseEvent, type BroMouseResult } from "./ui-capabilities.ts";
import { errorMessage } from "./util.ts";

const LOADING_TEXT = "Simplifying for my bro…";

export type ModalKind = "loading" | "streaming" | "result" | "help" | "empty" | "error";
// `mode` is the built-in explain mode that produced the text; absent for Show and Doctor.
// `preferences` records whether bro-preferences.md shaped this result; like `mode`, it belongs to the result.
export type BroResult = { source: BroSource; text: string; model?: string; mode?: BroMode; preferences?: boolean };
export type ModalResult = { source?: BroSource; text: string; htmlPath?: string; model?: string; mode?: BroMode; preferences?: boolean };

export function latestAssistant(ctx: ExtensionCommandContext): BroSource | undefined {
	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason !== "stop") {
			continue;
		}

		const text = entry.message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();

		if (text) return { text };
	}
}

export async function simplify(
	response: string,
	signal: AbortSignal,
	settings: BroSettings,
	onProgress?: (text: string) => void,
	mode = settings.mode,
): Promise<{ text: string; model: string; mode: BroMode; preferences: boolean }> {
	const selection = selectionForCapability(settings, "explain");
	const preferences = await readPreferences();
	const text = await runBackendText(buildDefaultPrompt(response, mode, preferences), selection, signal, onProgress);
	return { text, model: selectionLabel(selection), mode, preferences: Boolean(preferences) };
}

export type TextEditorModalOptions = {
	title: string;
	subtitle: string;
	initialText: string;
	initialNotice?: string;
	// Returns an error message to refuse the save without calling onSave.
	validate?: (text: string) => string | undefined;
	// Either may be async; the modal then waits, ignores further edits, and reports success only once it settles.
	onSave: (text: string) => void | Promise<void>;
	onClear: () => void | Promise<void>;
	copy?: (text: string) => Promise<void>;
};

// Testable core shared by /bro advisor-steer and /bro preferences: persistence only happens on
// Ctrl+S/Ctrl+K. Esc leaves the stored text untouched; only the in-memory draft is discarded.
export function createTextEditorModal(
	options: TextEditorModalOptions,
): (tui: TUI, theme: Theme, keybindings: unknown, done: (value?: void) => void) => Component & { dispose?(): void } {
	const { onSave, onClear, validate, copy = copyToClipboard } = options;
	return (tui, theme, _keybindings, done) => {
		const editorTheme: EditorTheme = { borderColor: (s: string) => theme.fg("border", s), selectList: getSelectListTheme() };
		const editor = new Editor(tui, editorTheme);
		editor.focused = true;
		editor.setText(options.initialText);
		let disposed = false;
		let pending = false;
		let notice = options.initialNotice ? theme.fg("accent", options.initialNotice) : "";
		// Where the editor was last drawn inside the overlay, for click forwarding.
		let editorArea: Area = { top: 0, left: 0, width: 0, height: 0 };
		const showNotice = (message: string, color: "success" | "error") => {
			if (disposed) return;
			notice = theme.fg(color, message);
			tui.requestRender();
		};
		editor.onChange = () => {
			notice = "";
		};
		const persist = (action: () => void | Promise<void>, success: string, failure: string, after?: () => void) => {
			const fail = (error: unknown) => showNotice(`${failure}: ${errorMessage(error)}`, "error");
			let result: void | Promise<void>;
			try {
				result = action();
			} catch (error) {
				fail(error);
				return;
			}
			if (!(result instanceof Promise)) {
				after?.();
				showNotice(success, "success");
				return;
			}
			pending = true;
			result.then(
				() => {
					pending = false;
					if (disposed) return;
					after?.();
					showNotice(success, "success");
				},
				(error) => {
					pending = false;
					fail(error);
				},
			);
		};

		return {
			// shortcut: Editor keeps its own min height (5 lines), so preferences fits from ~22 rows at
			// 80+ columns; the subtitle gives way first. Revisit if users report smaller terminals.
			render: (width: number) =>
				renderFrame(theme, width, modalHeight(tui), {
					header: () => theme.fg("accent", theme.bold(options.title)),
					body: (rows, innerWidth) => {
						const lines = editor.render(innerWidth);
						const subtitle = wrapTextWithAnsi(theme.fg("dim", options.subtitle), innerWidth).slice(0, Math.max(0, rows - lines.length));
						// Body rows start under the top border, header and rule.
						editorArea = { top: 3 + subtitle.length, left: 1, width: innerWidth, height: lines.length };
						return [...subtitle, ...lines];
					},
					notice,
					hints: "Ctrl+S save · Ctrl+K clear · Ctrl+C copy · Esc close",
					fill: false,
				}),
			invalidate: () => editor.invalidate(),
			handleMouse: (event: BroMouseEvent) => delegateMouse(editor, event, editorArea),
			handleInput: (data: string) => {
				if (matchesKey(data, "escape")) {
					disposed = true;
					done(undefined);
					return;
				}
				if (pending) return;
				if (matchesKey(data, "ctrl+s")) {
					const text = editor.getExpandedText();
					const invalid = validate?.(text);
					if (invalid) {
						showNotice(invalid, "error");
						return;
					}
					persist(() => onSave(text), "Saved", "Save failed");
					return;
				}
				if (matchesKey(data, "ctrl+k")) {
					persist(onClear, "Cleared", "Clear failed", () => editor.setText(""));
					return;
				}
				if (matchesKey(data, "ctrl+c")) {
					const text = editor.getExpandedText();
					void Promise.resolve()
						.then(() => copy(text))
						.then(() => showNotice("Copied", "success"))
						.catch((error) => showNotice(`Copy failed: ${errorMessage(error)}`, "error"));
					return;
				}
				if (matchesKey(data, "enter")) {
					editor.insertTextAtCursor("\n");
					tui.requestRender();
					return;
				}
				editor.handleInput(data);
				tui.requestRender();
			},
			dispose: () => { disposed = true; },
		};
	};
}

export function createAdvisorSteerModal(
	initialText: string,
	onSave: (text: string) => void,
	onClear: () => void,
	copy: (text: string) => Promise<void> = copyToClipboard,
): ReturnType<typeof createTextEditorModal> {
	return createTextEditorModal({
		title: "Bro · advisor steer",
		subtitle: `Session-specific steering brief for the advisor (takes precedence over ${ADVISOR_STEERING_FILE}) — never sent to the main model.`,
		initialText,
		onSave,
		onClear,
		copy,
	});
}

function preferencesTooLong(text: string): string | undefined {
	const length = text.replace(/^\uFEFF/, "").trim().length;
	return length > MAX_PREFERENCES_CHARS
		? `${length.toLocaleString("en-US")}/${MAX_PREFERENCES_CHARS.toLocaleString("en-US")} characters — trim before saving`
		: undefined;
}

// Testable core for /bro preferences. A missing file opens with the unsaved starter text; an
// unreadable or oversize-on-disk file opens empty with the error, and Clear still works.
export function createPreferencesModal(
	loaded: { text?: string; error?: string },
	persist: { save: (text: string) => Promise<void>; clear: () => Promise<void> },
	copy?: (text: string) => Promise<void>,
): ReturnType<typeof createTextEditorModal> {
	const starter = loaded.text === undefined && !loaded.error;
	return createTextEditorModal({
		title: "Bro · preferences",
		subtitle: "About you and how you like answers. Sent to the selected backend with every explain, show, btw, and Guided Review request — never to the advisor or Pi's main model.",
		initialText: starter ? STARTER_PREFERENCES : (loaded.text ?? ""),
		initialNotice: loaded.error ?? (starter ? "Starter text — not saved. Ctrl+S saves it; Esc leaves no file." : undefined),
		validate: preferencesTooLong,
		onSave: persist.save,
		onClear: persist.clear,
		copy,
	});
}

export async function showPreferencesModal(ctx: ExtensionCommandContext): Promise<void> {
	if (!hasBroCustomUi(ctx)) {
		ctx.ui.notify(`Edit ${PREFERENCES_FILE} directly.`, "warning");
		return;
	}
	let loaded: { text?: string; error?: string };
	try {
		const text = await readPreferencesRaw();
		loaded = text === undefined ? {} : { text };
	} catch (error) {
		loaded = { error: `${errorMessage(error)} Ctrl+K deletes it.` };
	}
	await openBroOverlay<void>(
		ctx,
		createPreferencesModal(loaded, {
			// ponytail: last writer wins against external edits while the editor is open, like writeSettings.
			save: (text) => queuePreferencesWrite(() => writeFile(PREFERENCES_FILE, `${text.trim()}\n`, "utf8")),
			clear: () => queuePreferencesWrite(() => rm(PREFERENCES_FILE, { force: true })),
		}),
	);
}

export async function showAdvisorSteerModal(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	if (!hasBroCustomUi(ctx)) {
		ctx.ui.notify("Use /bro advisor-steer in Pi's interactive UI.", "warning");
		return;
	}
	const { steering } = resolveAdvisorState(ctx.sessionManager.getBranch());
	await openBroOverlay<void>(
		ctx,
		createAdvisorSteerModal(
			steering,
			(text) => pi.appendEntry(ADVISOR_STEERING_ENTRY, { text }),
			() => pi.appendEntry(ADVISOR_STEERING_ENTRY, { text: "" }),
		),
	);
}

// `preferences` is a ready status ("off", "on (312 characters)", or "error: …") so a preferences
// problem never hides Help or mixes with settings errors.
export function helpText(settings?: BroSettings, settingsError?: string, preferences = "off"): string {
	const overrideLines = settings
		? CAPABILITIES.map((capability) => {
				const override = capabilityOverride(settings, capability);
				return override
					? `- **${CAPABILITY_LABELS[capability]} override:** ${override.backend ?? "agy"} \`${override.model}\`${override.effort === "default" ? "" : ` (${override.effort})`}`
					: undefined;
			}).filter((line): line is string => line !== undefined)
		: [];
	const settingsSummary = settings
		? `- **Backend:** ${settings.backend ?? "agy"}\n- **Model:** \`${settings.model}\`\n- **Reasoning effort:** ${settings.effort === "default" ? "built into the selected model" : settings.effort}\n- **Mode:** ${settings.mode}\n- **Show turns:** ${settings.showTurns}${overrideLines.length ? `\n${overrideLines.join("\n")}` : ""}`
		: `Bro could not read its settings: ${settingsError}\n\nRun \`/bro doctor\` for setup help.`;
	return `# Bro

Quick reference. Full user guide: https://github.com/tranhoangnguyen03/pi-bro/blob/main/docs/user-guide.md

## Explain and show

- \`/bro\` or \`/bro simplify\` — explain the latest completed assistant reply
- \`/bro text [text]\` — explain pasted text, or the latest reply when text is omitted
- \`/bro file <path>\` — explain a workspace \`.md\`, \`.markdown\`, \`.txt\`, \`.pdf\`, or \`.docx\` file
- \`/bro url <url>\` — explain one public webpage
- \`/bro <input>\` — a lone URL, an existing supported file, or anything else as pasted text
- \`/bro open\` — reopen the latest explanation without a new request
- \`/bro show [n-turns] [query]\` — draw recent turns' conversation text as shapes; an optional query steers the focus

## Guided Review

- \`/bro guided-review <PR number or URL>\` — automatically explain and assess a PR with captured code and optional private questions (local Pi interactive only; Git and authenticated gh required).
- Your work is saved automatically. Open the same PR to return without a model call; \`/bro guided-review\` lists saved reviews (\`resume\` is an alias). Reopening keeps the captured revision, not newer commits.
- Enter opens an item or focuses actions; Enter on a highlighted action activates it. Tab changes focus. Esc goes back, then closes from Contents. Close saves automatically; Stop and close stops active work first.
- Copy finding copies to the system clipboard, not GitHub. Regenerate guide is optional and makes a confirmed call about the same captured code. Review generation/questions require Claude or Muse file-only tools: shell, writes and web tools are disabled. Set a review override in /bro config; other backends can still read saved reviews. Repository text can still mislead the model; citations are not proof.

## Side conversation

- \`/bro btw [question]\` — open a side conversation seeded with recent main-session context. It starts conversation-only; reopening keeps the thread and its mode.
- Inside the modal: Enter asks (empty Enter re-asks); \`/mode\` toggles conversation-only / full permission (read and edit the workspace) and keeps the thread; \`/copy\` and \`/copy-all\` copy to the clipboard; \`/insert\` and \`/insert-all\` insert into an empty main editor without submitting; \`/retry\` re-asks; \`/clear\` resets. Any other text is sent as a question. Esc closes.

## Advisor

- \`bro_advisor\` — a tool the executor agent may call for a second opinion from a fresh backend process with real, auto-approved workspace access; it is told to advise, not edit, but that is not enforced
- \`/bro advisor\` — whether \`bro_advisor\` is available right now
- \`/bro advisor-steer\` — edit the session's persistent steering brief (**Ctrl+S** save, **Ctrl+K** clear, **Ctrl+C** copy, **Esc** close)
- Standing advisor steering: \`${ADVISOR_STEERING_FILE}\` sets standing priorities across sessions (session steering takes precedence)

## Configure and check

- \`/bro preferences\` — tell Bro about yourself and how you like answers; added to explain, show, btw, and Guided Review prompts, never the advisor (**Ctrl+S** save, **Ctrl+K** delete, **Ctrl+C** copy, **Esc** close)
- \`/bro config\` — shared default and per-capability (explain/show/btw/advisor/review) backend, model, and effort; explain mode; show turns. Changes save immediately.
- \`/bro mode [brief|balanced|faithful]\` — view or choose the explanation mode
- \`/bro doctor\` — check settings, preferences, and every selected backend without running a model turn

## Current settings

${settingsSummary}
- **Preferences:** ${preferences} — \`/bro preferences\`

Saved in \`${settingsFile()}\`, \`${PREFERENCES_FILE}\`, and \`${ADVISOR_STEERING_FILE}\`.

## Explanation modes

- brief — the main point and next action, with no fixed word target
- balanced — default; material detail with clearer structure
- faithful — closest to the source, with no fixed word limit

Press **M** in an explanation to re-simplify it in the next mode without changing the saved one.

The mode decides how much of the source to keep; your preferences decide who it's written for, its tone, and its language. Neither overrides Bro's source rules.

## Controls

- **Mouse wheel / trackpad**, **↑ / ↓**, **PgUp / PgDn** — scroll
- **C** — copy the full explanation
- **R** — repeat the current action (an explanation keeps its mode)
- **M** — re-simplify in the next mode (brief → balanced → faithful); not saved
- **O** — open the diagram (HTML layout or sequence diagram) when a show reply contains one
- **Esc** — close, or cancel while Bro is working

## Privacy

Bro sends the captured source (or, for the advisor, the executor's instructions, tools, and conversation) to the selected backend and its model provider, which may retain it under their own policies. Your preferences go with every explain, show, btw, and Guided Review request. Guided Review sends PR data/diff and relevant private questions; records/source remain locally under getAgentDir()/bro-reviews. Copy finding goes to the system clipboard, not GitHub. Nothing is added to Pi's conversation unless you insert it, except advisor answers, which return to the agent as tool results. Access controls differ by backend; see the user guide.`;
}

// The overlay framing pattern is adapted from pi-btw (MIT); see THIRD_PARTY_NOTICES.md.
export class BroModal implements Focusable {
	focused = false;
	private readonly markdown = new Markdown("", 0, 0, getMarkdownTheme());
	private kind: ModalKind = "loading";
	private rawText = "";
	private sourceLabel = "";
	private modelLabel = "";
	private notice = "";
	private rawArea: Area | undefined;
	private readonly scroller = new Scroller(() => {
		this.notice = "";
		this.tui.requestRender();
	});
	private copyable = false;
	private retryable = false;
	private disposed = false;
	private htmlPath = "";
	// Survives loading/streaming so the header names the mode being produced; empty disables M.
	private modeLabel = "";
	// Set only with a result, so the tag never claims preferences for work still in flight.
	private preferencesUsed = false;

	constructor(
		private readonly tui: TuiLike,
		private readonly theme: Theme,
		private readonly onClose: () => void,
		private readonly onRetry: () => void,
		private readonly onDispose: () => void,
		private readonly retryLabel: string,
		private readonly onSwitchMode: () => void = () => {},
	) {}

	setLoading(text = LOADING_TEXT): void {
		this.setContent("loading", `**${text}**`, "", false, false);
	}

	setStreaming(text: string): void {
		this.setContent("streaming", text, "", false, false);
	}

	setResult(text: string, retryable: boolean, notice = "", sourceLabel = "", rawText = text, modelLabel = ""): void {
		this.setContent("result", text, rawText, true, retryable, notice, sourceLabel, modelLabel);
	}

	setHtmlPath(path: string): void {
		this.htmlPath = path;
		this.tui.requestRender();
	}

	setMode(mode: BroMode | undefined): void {
		this.modeLabel = mode ?? "";
		this.tui.requestRender();
	}

	setPreferences(used: boolean): void {
		this.preferencesUsed = used;
		this.tui.requestRender();
	}

	setStatic(kind: "help" | "empty", text: string, copyable: boolean): void {
		this.setContent(kind, text, text, copyable, false);
	}

	setError(message: string): void {
		this.setContent("error", `# Bro ran into a problem\n\n${message}`, "", false, true);
	}

	private setContent(
		kind: ModalKind,
		text: string,
		rawText: string,
		copyable: boolean,
		retryable: boolean,
		notice = "",
		sourceLabel = "",
		modelLabel = "",
	): void {
		this.kind = kind;
		if (kind !== "result") this.htmlPath = "";
		this.rawText = rawText;
		this.copyable = copyable;
		this.retryable = retryable;
		this.notice = notice;
		this.sourceLabel = stripVTControlCharacters(sourceLabel)
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		this.modelLabel = modelLabel;
		if (kind !== "streaming") this.scroller.toStart();
		this.markdown.setText(text);
		this.tui.requestRender();
	}

	private canSwitchMode(): boolean {
		return Boolean(this.modeLabel) && (this.kind === "loading" || this.kind === "streaming" || this.kind === "result");
	}

	private controls(): string {
		const mode = this.canSwitchMode() ? " · M mode" : "";
		if (this.kind === "loading") return mode ? "M mode · Esc cancel" : "Esc cancel";
		if (this.kind === "streaming") return `Simplifying… · ↑/↓ scroll${mode} · Esc cancel`;
		if (this.kind === "result") {
			return `↑/↓ scroll · C copy${this.htmlPath ? " · O open diagram" : ""}${mode}${this.retryable ? ` · R ${this.retryLabel}` : ""} · Esc close`;
		}
		if (this.kind === "help") return "↑/↓ scroll · C copy · Esc close";
		if (this.kind === "error") return "R try again · Esc close";
		return "Esc close";
	}

	render(width: number): string[] {
		const height = modalHeight(this.tui, BRO_OVERLAY, 32);
		this.rawArea = broOverlayArea(this.tui, width, height);
		return renderFrame(this.theme, width, height, {
			header: () => {
				const scroll = this.scroller.indicator();
				return (
					this.theme.fg("accent", this.theme.bold(`Bro${this.sourceLabel ? ` · ${this.sourceLabel}` : ""}`)) +
					this.theme.fg("dim", `${this.modelLabel ? ` · ${this.modelLabel}` : ""}${this.modeLabel ? ` · ${this.modeLabel}` : ""}${this.preferencesUsed ? " · prefs" : ""}${scroll ? ` · ${scroll}` : ""}`)
				);
			},
			body: (rows, innerWidth) => this.scroller.view(this.markdown.render(innerWidth), rows),
			notice: this.notice && this.theme.fg("accent", this.notice),
			hints: this.controls(),
		});
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	handleMouse(event: BroMouseEvent): BroMouseResult {
		return this.scroller.handleMouse(event);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onClose();
			return;
		}

		if (this.scroller.handleKey(data, this.rawArea)) return;

		if ((matchesKey(data, "c") || matchesKey(data, "shift+c")) && this.copyable && this.rawText) {
			void copyToClipboard(this.rawText)
				.then(() => {
					if (!this.disposed) {
						this.notice = "Copied";
						this.tui.requestRender();
					}
				})
				.catch((error) => {
					if (!this.disposed) {
						this.notice = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
						this.tui.requestRender();
					}
				});
			return;
		}

		if (
			(matchesKey(data, "r") || matchesKey(data, "shift+r")) &&
			this.retryable &&
			this.kind !== "loading"
		) {
			this.onRetry();
			return;
		}

		if ((matchesKey(data, "m") || matchesKey(data, "shift+m")) && this.canSwitchMode()) {
			this.onSwitchMode();
			return;
		}

		if ((matchesKey(data, "o") || matchesKey(data, "shift+o")) && this.htmlPath && this.kind === "result") {
			this.notice = openShowHtml(this.htmlPath)
				? "Opening diagram"
				: `Could not open ${this.htmlPath}`;
			this.tui.requestRender();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.onDispose();
	}
}

export interface BroModalOptions {
	text?: string;
	kind?: "help" | "empty";
	copyable?: boolean;
	result?: ModalResult;
	run?: (
		signal: AbortSignal,
		source?: BroSource,
		onProgress?: (text: string) => void,
		mode?: BroMode,
	) => Promise<ModalResult>;
	onResult?: (result: ModalResult) => void;
	loadingText?: string;
	retryable?: boolean;
	retryLabel?: string;
}

export async function showBroModal(ctx: ExtensionCommandContext, options: BroModalOptions): Promise<void> {
	if (!hasBroCustomUi(ctx)) {
		if (options.run && !options.result && options.text === undefined) {
			const result = await options.run(new AbortController().signal);
			options.onResult?.(result);
		}
		return;
	}

	await openBroOverlay<void>(
		ctx,
		(tui, theme, _keybindings, done) => {
			let closed = false;
			let controller: AbortController | undefined;
			let current = options.result;
			let inFlightMode: BroMode | undefined;
			let execute: (source?: BroSource, mode?: BroMode, notice?: string) => void = () => {};

			const close = () => {
				if (closed) return;
				closed = true;
				controller?.abort();
				done(undefined);
			};

			const modal = new BroModal(
				tui,
				theme,
				close,
				() => execute(current?.source, current?.mode),
				() => {
					closed = true;
					controller?.abort();
				},
				options.retryLabel ?? "simplify again",
				// M advances from the mode in flight, so repeated presses cancel and skip ahead; the saved default is untouched.
				() => {
					const from = inFlightMode ?? current?.mode;
					if (!from || !current?.source || closed) return;
					const next = nextBroMode(from);
					controller?.abort();
					controller = undefined;
					execute(current.source, next, `Mode: ${next} (not saved)`);
				},
			);

			const present = (result: ModalResult, notice = "") => {
				const display = result.htmlPath ? stripShowDiagramFence(result.text) : result.text;
				modal.setResult(display, options.retryable ?? Boolean(options.run), notice, result.source?.label, result.text, result.model);
				modal.setHtmlPath(result.htmlPath ?? "");
				modal.setMode(result.mode);
				modal.setPreferences(Boolean(result.preferences));
			};

			execute = (source?: BroSource, mode?: BroMode, notice = "") => {
				if (!options.run || controller || closed) return;
				const previous = current;
				const nextController = new AbortController();
				controller = nextController;
				inFlightMode = mode;
				modal.setLoading(options.loadingText);
				modal.setMode(mode);
				modal.setPreferences(false);

				void options
					.run(nextController.signal, source, (text) => {
						if (closed || nextController.signal.aborted || controller !== nextController) return;
						modal.setStreaming(text);
					}, mode)
					.then((result) => {
						if (closed || nextController.signal.aborted) return;
						current = result;
						options.onResult?.(result);
						present(result, notice);
					})
					.catch((error) => {
						if (closed || nextController.signal.aborted) return;
						const message = error instanceof Error ? error.message : String(error);
						if (previous) {
							current = previous;
							present(previous, `Retry failed: ${message}`);
						} else {
							modal.setMode(undefined);
							modal.setError(message);
						}
					})
					.finally(() => {
						if (controller === nextController) {
							controller = undefined;
							inFlightMode = undefined;
						}
					});
			};

			if (options.text !== undefined) {
				modal.setStatic(options.kind ?? "help", options.text, options.copyable ?? false);
			} else if (current) {
				present(current);
			} else {
				execute();
			}

			return modal;
		},
		{ mouse: true },
	);
}
