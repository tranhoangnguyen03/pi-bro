import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable } from "@earendil-works/pi-tui";
import { execute as executeBackend, type BackendProgress, type BackendSelection } from "./backend.ts";
import type { Theme, TuiLike } from "./config-ui.ts";
import { buildBtwPrompt } from "./prompt.ts";
import {
	type BackendName,
	type BroSettings,
	capabilityBackend,
	readPreferences,
	readSettings,
	selectionForCapability,
	selectionLabel,
} from "./settings.ts";
import { captureShowTranscript } from "./show.ts";
import {
	broModalRows,
	canBroInsertIntoEditor,
	insertBroDesktopText,
	setRegularMouseReporting,
	wheelDelta,
	type BroMouseEvent,
	type BroMouseResult,
} from "./ui-capabilities.ts";
import { errorMessage } from "./util.ts";

export const BTW_CONTEXT_TURNS = 8;
export const BTW_CONTEXT_MAX = 40_000;

export type BtwTurn = { question: string; answer: string };
// `context` keeps the main-session seed so a fresh native session can be reseeded with the whole
// thread; `sessionFull` and `sessionPreferences` are the access mode and preferences the native
// session last ran with. `preferences` records whether the latest turn used them (header tag).
export type BtwThread = {
	turns: BtwTurn[];
	conversationId?: string;
	full: boolean;
	backend?: BackendName;
	model?: string;
	preferences?: boolean;
	context?: string;
	sessionFull?: boolean;
	sessionPreferences?: string;
};

export function parseBtwArguments(value: string): { question: string; invalid?: string } {
	const rest = value.trim();
	if (!rest.startsWith("--")) return { question: rest };
	const token = rest.split(/\s/, 1)[0]!;
	if (token === "--full" || token === "--sandbox") {
		return { question: "", invalid: `${token} was removed. Open /bro btw and type /mode to switch between conversation-only and full permission.` };
	}
	if (token === "--fresh") {
		return { question: "", invalid: "--fresh was removed. Every new thread starts with main-session context; type /clear inside /bro btw to start over." };
	}
	return { question: "", invalid: `Unknown /bro btw flag: ${token}` };
}

// A new thread starts conversation-only; reopening keeps the thread and its mode.
export function resolveBtwThread(existing: BtwThread | undefined): BtwThread {
	return existing ?? { turns: [], full: false };
}

export function bindBtwBackend(thread: BtwThread, backend: BackendName): boolean {
	const changed = thread.backend !== undefined && thread.backend !== backend;
	if (changed) { thread.turns = []; thread.conversationId = undefined; thread.context = undefined; thread.sessionFull = undefined; thread.sessionPreferences = undefined; }
	thread.backend = backend;
	return changed;
}

export function btwModeLabel(full: boolean): string {
	return full ? "full permission" : "conversation-only";
}

// /mode keeps the transcript; whether the native session survives is decided by
// nativeBtwContinuation on the next turn.
export function toggleBtwMode(thread: BtwThread): void {
	thread.full = !thread.full;
}

// Claude, Grok, Codex, and Muse run btw in the workspace for both modes and resume one native session across
// /mode switches. An Agy conversation stays bound to the workspace it started in (a sandbox scratch
// dir vs. the repo), so an access change drops it; the next turn reseeds a fresh native session
// with the main-session context and the whole thread.
// A native session remembers every earlier prompt, including old preferences, so a preferences
// change (or deletion) on any backend starts a fresh session reseeded with the quoted thread.
export function nativeBtwContinuation(thread: BtwThread, backend: BackendName, preferences = ""): string | undefined {
	if (backend === "agy" && thread.conversationId && thread.sessionFull !== undefined && thread.sessionFull !== thread.full) {
		thread.conversationId = undefined;
	}
	if (thread.conversationId && (thread.sessionPreferences ?? "") !== preferences) thread.conversationId = undefined;
	return thread.conversationId;
}

export function btwHeaderLabel(thread: Pick<BtwThread, "model" | "preferences">): string {
	return thread.model ? `${thread.model}${thread.preferences ? " · prefs" : ""}` : "";
}

export function formatBtwTranscript(turns: readonly BtwTurn[]): string {
	return turns
		.map((turn) => {
			const question = turn.question.split(/\r?\n/).map((line) => (line ? `> ${line}` : ">")).join("\n");
			// A turn aborted mid-stream can end inside an unclosed code fence, which would swallow the
			// separator and every later turn; close it so each turn renders as its own block.
			const answer = (turn.answer.match(/^```/gm)?.length ?? 0) % 2 === 1 ? `${turn.answer}\n\`\`\`` : turn.answer;
			return `> **You**\n>\n${question}\n\n**Bro**\n\n${answer}`;
		})
		.join("\n\n---\n\n");
}

export type BtwComposerAction =
	| { kind: "clear" }
	| { kind: "mode" }
	| { kind: "retry" }
	| { kind: "clipboard"; all: boolean }
	| { kind: "insert"; all: boolean }
	| { kind: "removed"; command: string }
	| { kind: "question"; text: string };

export function parseBtwComposerCommand(value: string): BtwComposerAction {
	const command = value.trim();
	if (command === "/clear") return { kind: "clear" };
	if (command === "/mode") return { kind: "mode" };
	if (command === "/retry" || command === "") return { kind: "retry" };
	if (command === "/copy" || command === "/copy-all") {
		return { kind: "clipboard", all: command === "/copy-all" };
	}
	if (command === "/insert" || command === "/insert-all") return { kind: "insert", all: command === "/insert-all" };
	if (command === "/insert!" || command === "/insert-all!") return { kind: "removed", command };
	return { kind: "question", text: command };
}

// Thin presentation-boundary wrapper around the shared backend: coalesces raw text progress to the
// existing 75ms cadence and translates the backend's tagged outcome back into this function's
// existing throw-on-failure / { text, conversationId } contract. A conversationId is only ever
// returned on success (see backend.ts's continuation handling), preserving current behavior on
// failed turns.
export async function runBtwTurn(
	prompt: string,
	selection: BackendSelection,
	options: { full: boolean; cwd: string; conversationId?: string },
	signal: AbortSignal,
	onProgress?: (text: string) => void,
): Promise<{ text: string; conversationId?: string }> {
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	let latest: string | undefined;
	const throttledProgress = onProgress
		? (progress: BackendProgress) => {
				if (progress.kind !== "text") return;
				latest = progress.text;
				if (!updateTimer) {
					updateTimer = setTimeout(() => {
						updateTimer = undefined;
						if (!signal.aborted && latest !== undefined) onProgress(latest);
					}, 75);
				}
			}
		: undefined;

	try {
		const outcome = await executeBackend(
			{
				feature: "btw",
				prompt,
				access: options.full ? "workspace-full" : "restricted",
				cwd: options.cwd,
				continuation: options.conversationId ? { id: options.conversationId } : undefined,
			},
			selection,
			signal,
			throttledProgress,
		);
		if (outcome.status === "success") return { text: outcome.text, conversationId: outcome.continuation?.id };
		throw new Error(outcome.message);
	} finally {
		if (updateTimer) clearTimeout(updateTimer);
	}
}

export class BtwModal implements Focusable {
	private _focused = false;
	private readonly markdown = new Markdown("", 0, 0, getMarkdownTheme());
	private readonly input = new Input();
	private notice = "";
	private offset = 0;
	// Pinned to the newest text until the reader scrolls up; scrolling back to the end re-pins.
	private follow = false;
	private maxOffset = 0;
	private bodyHeight = 1;
	private running = false;
	private full = false;
	private model = "";
	private disposed = false;

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
	) {
		setRegularMouseReporting(this.tui, true);
		this.input.onSubmit = (value) => {
			if (!this.running) this.onSubmit(value);
		};
	}

	// Keeps the reader's place; render clamps the offset when the text shrinks (e.g. /clear).
	setText(text: string): void {
		this.markdown.setText(text);
		this.tui.requestRender();
	}

	/** Show the newest text and keep following it while a reply streams. */
	scrollToEnd(): void {
		this.follow = true;
		this.tui.requestRender();
	}

	setNotice(notice: string): void {
		if (this.disposed) return;
		this.notice = notice;
		this.tui.requestRender();
	}

	setRunning(running: boolean): void {
		this.running = running;
		this.tui.requestRender();
	}

	setModel(model: string): void {
		this.model = model;
		this.tui.requestRender();
	}

	setFull(full: boolean): void {
		this.full = full;
		this.tui.requestRender();
	}

	clearComposer(): void {
		this.input.setValue("");
		this.tui.requestRender();
	}

	invalidate(): void {
		this.markdown.invalidate();
		this.input.invalidate();
	}

	// Pi 1.2+ fullscreen delivers the wheel here and no longer forwards raw wheel input to handleInput.
	handleMouse(event: BroMouseEvent): BroMouseResult {
		if (event.type !== "wheel") return;
		const delta = Math.trunc(event.wheelDelta ?? 0);
		if (delta) this.scroll(delta);
		return { handled: true, render: false };
	}

	private scroll(delta: number): void {
		this.offset = Math.max(0, Math.min(this.offset + delta, this.maxOffset));
		this.follow = this.offset >= this.maxOffset;
		this.notice = "";
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onClose();
			return;
		}
		const delta = wheelDelta(data) || (matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0);
		if (delta) {
			this.scroll(delta);
			return;
		}
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	private ruleLine(innerWidth: number): string {
		return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
	}

	render(width: number): string[] {
		const dialogWidth = Math.max(24, width);
		const innerWidth = Math.max(22, dialogWidth - 2);
		const terminalRows = broModalRows(this.tui, process.stdout.rows);
		const dialogHeight = Math.min(34, Math.max(8, Math.floor(terminalRows * 0.82)));
		const footer = [
			...wrapTextWithAnsi(this.theme.fg("accent", this.theme.bold("Your message to Bro")), innerWidth),
			this.input.render(innerWidth)[0] ?? "",
			...wrapTextWithAnsi(this.running ? "Bro is thinking… · Esc: close panel (stops the reply)" : "Enter: send message · Esc: close panel", innerWidth),
			...wrapTextWithAnsi("Commands: /mode · /copy · /copy-all · /insert · /insert-all · /clear · /retry", innerWidth),
			...(this.notice ? wrapTextWithAnsi(this.theme.fg("accent", this.notice), innerWidth) : []),
		];
		this.bodyHeight = Math.max(1, dialogHeight - 5 - footer.length);

		const rendered = this.markdown.render(innerWidth);
		this.maxOffset = Math.max(0, rendered.length - this.bodyHeight);
		if (this.follow) this.offset = this.maxOffset;
		this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));
		const visible = rendered.slice(this.offset, this.offset + this.bodyHeight);
		const hiddenBelow = Math.max(0, this.maxOffset - this.offset);
		const scroll = this.maxOffset > 0 ? ` · ↑${this.offset} ↓${hiddenBelow}` : "";

		const model = this.model ? this.theme.fg("dim", ` · ${this.model}`) : "";
		const mode = this.theme.fg("dim", " · ") + (this.full ? this.theme.fg("accent", this.theme.bold(btwModeLabel(true))) : this.theme.fg("dim", btwModeLabel(false)));
		const header = this.theme.fg("accent", this.theme.bold("Bro · btw")) + model + mode + this.theme.fg("dim", scroll);

		const lines = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(header, innerWidth),
			this.ruleLine(innerWidth),
		];
		for (const line of visible) lines.push(this.frameLine(line, innerWidth));
		for (let i = visible.length; i < this.bodyHeight; i++) lines.push(this.frameLine("", innerWidth));
		lines.push(this.ruleLine(innerWidth));
		for (const line of footer) lines.push(this.frameLine(line, innerWidth));
		lines.push(this.borderLine(innerWidth, "bottom"));
		return lines;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		setRegularMouseReporting(this.tui, false);
		this.onDispose();
	}
}

export async function openBtwModal(
	ctx: ExtensionCommandContext,
	options: { thread: BtwThread; initialQuestion?: string },
): Promise<void> {
	const thread = options.thread;

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let closed = false;
			let controller: AbortController | undefined;

			const transcript = () => formatBtwTranscript(thread.turns);

			const close = () => {
				if (closed) return;
				closed = true;
				controller?.abort();
				done(undefined);
			};

			const modal = new BtwModal(tui, theme, close, submit, () => {
				closed = true;
				controller?.abort();
			});

			// `replaced` is the turn /retry removed; it is put back if the turn never starts.
			const runTurn = async (question: string, replaced?: BtwTurn) => {
				if (controller) return;
				const turnController = new AbortController();
				controller = turnController;
				modal.setRunning(true);
				modal.clearComposer();

				let settings: BroSettings;
				let preferences: string;
				try {
					settings = await readSettings();
					preferences = await readPreferences();
				} catch (error) {
					if (replaced) thread.turns.push(replaced);
					if (controller === turnController) controller = undefined;
					if (!closed) { modal.setRunning(false); modal.setNotice(errorMessage(error)); }
					return;
				}
				// Closing (or reopening) during the reads above must not touch the shared thread.
				if (closed || turnController.signal.aborted) {
					if (replaced) thread.turns.push(replaced);
					if (controller === turnController) controller = undefined;
					return;
				}
				if (bindBtwBackend(thread, capabilityBackend(settings, "btw"))) modal.setNotice("Backend changed — started a fresh side thread.");
				if (thread.turns.length === 0) {
					thread.conversationId = undefined;
					const context = captureShowTranscript(ctx, BTW_CONTEXT_TURNS, BTW_CONTEXT_MAX)?.text;
					thread.context = context;
				}
				// Resume natively when possible; otherwise seed the fresh native session with the main-session
				// context plus every earlier turn so nothing is silently lost.
				const conversationId = nativeBtwContinuation(thread, capabilityBackend(settings, "btw"), preferences);
				const history = !conversationId && thread.turns.length ? formatBtwTranscript(thread.turns) : undefined;
				const context = conversationId ? undefined : thread.context;
				const full = thread.full;

				thread.turns.push({ question, answer: "…" });
				modal.setText(transcript());
				modal.scrollToEnd();

				try {
					const selection = selectionForCapability(settings, "btw");
					thread.model = selectionLabel(selection);
					thread.preferences = Boolean(preferences);
					modal.setModel(btwHeaderLabel(thread));
					const result = await runBtwTurn(
						buildBtwPrompt(context, question, { full, history, preferences }),
						selection,
						{ full, cwd: ctx.cwd, conversationId },
						turnController.signal,
						(partial) => {
							if (closed || turnController.signal.aborted) return;
							thread.turns[thread.turns.length - 1]!.answer = partial;
							modal.setText(transcript());
						},
					);
					if (turnController.signal.aborted) return;
					if (result.conversationId) {
						thread.conversationId = result.conversationId;
						thread.sessionFull = full;
						thread.sessionPreferences = preferences;
					}
					thread.turns[thread.turns.length - 1]!.answer = result.text;
				} catch (error) {
					if (turnController.signal.aborted || closed) return;
					thread.turns[thread.turns.length - 1]!.answer = `_${errorMessage(error)}_`;
					modal.setNotice(errorMessage(error));
				} finally {
					if (controller === turnController) controller = undefined;
					if (!closed) {
						modal.setRunning(false);
						modal.setText(transcript());
					}
				}
			};

			const toggleMode = () => {
				toggleBtwMode(thread);
				modal.setFull(thread.full);
				modal.setNotice(`Mode: ${btwModeLabel(thread.full)}`);
			};

			const clear = () => {
				thread.turns = [];
				thread.conversationId = undefined;
				thread.context = undefined;
				thread.sessionFull = undefined;
				thread.sessionPreferences = undefined;
				modal.clearComposer();
				modal.setNotice("");
				modal.setText("");
			};

			const retry = () => {
				if (controller) return;
				const last = thread.turns.at(-1);
				if (!last) {
					modal.setNotice("Nothing to retry yet.");
					return;
				}
				thread.turns.pop();
				void runTurn(last.question, last);
			};

			const copyOut = async (all: boolean) => {
				const text = all ? transcript() : (thread.turns.at(-1)?.answer ?? "");
				if (!text.trim()) {
					modal.setNotice("Nothing to copy yet.");
					return;
				}
				try {
					await copyToClipboard(text);
					modal.setNotice(all ? "Copied the full thread to the clipboard." : "Copied the latest answer to the clipboard.");
				} catch (error) {
					modal.setNotice(`Copy failed: ${errorMessage(error)}`);
				}
			};

			const insert = async (all: boolean) => {
				const text = all ? transcript() : (thread.turns.at(-1)?.answer ?? "");
				if (!text.trim()) {
					modal.setNotice("Nothing to insert yet.");
					return;
				}
				if (!canBroInsertIntoEditor(ctx)) {
					const result = await insertBroDesktopText(ctx, text);
					modal.setNotice(result === "inserted" ? "Inserted into the main editor. Review it before sending." : result === "not_empty" ? "Main editor has a draft or attachment. Clear it first, then insert again." : "Could not confirm insertion. Check the main editor before trying again.");
					return;
				}
				if (ctx.ui.getEditorText().trim()) {
					modal.setNotice("Main editor has a draft. Edit or clear it first, then insert again.");
					return;
				}
				ctx.ui.setEditorText(text);
				modal.setNotice(all ? "Inserted the full thread into the main editor." : "Inserted the latest answer into the main editor.");
			};

			function submit(value: string): void {
				const action = parseBtwComposerCommand(value);
				if (action.kind === "clear") {
					modal.clearComposer();
					clear();
					return;
				}
				if (action.kind === "mode") {
					modal.clearComposer();
					toggleMode();
					return;
				}
				if (action.kind === "clipboard") {
					modal.clearComposer();
					void copyOut(action.all);
					return;
				}
				if (action.kind === "insert") {
					modal.clearComposer();
					void insert(action.all);
					return;
				}
				if (action.kind === "removed") {
					modal.clearComposer();
					modal.setNotice(`${action.command} was removed. Edit or clear the main editor draft, then use /insert or /insert-all.`);
					return;
				}
				if (action.kind === "retry") {
					modal.clearComposer();
					retry();
					return;
				}
				void runTurn(action.text);
			}

			modal.setFull(thread.full);
			modal.setModel(btwHeaderLabel(thread));
			modal.setText(transcript());
			modal.scrollToEnd();

			if (options.initialQuestion) void runTurn(options.initialQuestion);

			return modal;
		},
		{
			overlay: true,
			overlayOptions: {
				width: "78%",
				minWidth: 48,
				maxHeight: "82%",
				anchor: "top-center",
				margin: { top: 1, left: 2, right: 2 },
			},
		},
	);
}
