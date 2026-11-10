import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable } from "@earendil-works/pi-tui";
import { execute as executeBackend, textProgressThrottle, type BackendProgress, type BackendSelection } from "./backend.ts";
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
import { BRO_OVERLAY, broOverlayArea, formatNotice, modalHeight, openBroOverlay, renderFrame, runningHint, Scroller, startProgressClock, type Area, type NoticeTone, type Theme, type TuiLike } from "./modal-kit.ts";
import { type BroMouseEvent, type BroMouseResult } from "./ui-capabilities.ts";
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
	draft?: string;
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
// with the main-session context and the whole thread. Pi behaves like Agy here: its restricted mode
// exposes no tools at all while full access uses read/bash/edit/write, so an access change must not
// continue a session whose tool loadout is now wrong.
// A native session remembers every earlier prompt, including old preferences, so a preferences
// change (or deletion) on any backend starts a fresh session reseeded with the quoted thread.
export function nativeBtwContinuation(thread: BtwThread, backend: BackendName, preferences = ""): string | undefined {
	if ((backend === "agy" || backend === "pi") && thread.conversationId && thread.sessionFull !== undefined && thread.sessionFull !== thread.full) {
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
	| { kind: "help" }
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
	if (command === "/help") return { kind: "help" };
	if (["/insert", "/insert-all", "/insert!", "/insert-all!"].includes(command)) return { kind: "removed", command };
	return { kind: "question", text: command };
}

// Thin presentation-boundary wrapper around the shared backend: coalesces raw text progress to the
// existing 75ms cadence and translates the backend's tagged outcome back into this function's
// existing throw-on-failure / { text, conversationId } contract. A conversationId is only ever
// returned on success (see backend.ts's continuation handling), preserving current behavior on
// failed turns.
// An expired continuation is reported as `continuationExpired` so the caller can forget the dead id;
// otherwise every later turn would resend it and the thread would stay stuck.
export async function runBtwTurn(
	prompt: string,
	selection: BackendSelection,
	options: { full: boolean; cwd: string; conversationId?: string },
	signal: AbortSignal,
	onProgress?: (event: BackendProgress) => void,
	onRenderedText?: (text: string) => void,
): Promise<{ text: string; conversationId?: string; expiredContinuation?: true }> {
	// Phases use backend event order. Only expensive transcript rendering is delayed.
	// Otherwise an old throttled text update can replace a newer tool status.
	const textProgress = textProgressThrottle(signal, onRenderedText);
	const receive = (event: BackendProgress) => {
		if (signal.aborted) return;
		onProgress?.(event);
		if (event.kind === "text") textProgress.receive?.(event);
	};

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
			receive,
		);
		if (outcome.status === "success") return { text: outcome.text, conversationId: outcome.continuation?.id };
		if (outcome.continuationExpired) return { text: "", expiredContinuation: true };
		throw new Error(outcome.message);
	} finally {
		textProgress.dispose();
	}
}

export class BtwModal implements Focusable {
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
	private full = false;
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
		private readonly appearance: { title?: string; commands?: string; inputLabel?: string; idleHint?: string } = {},
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

	setFull(full: boolean): void {
		this.full = full;
		this.tui.requestRender();
	}

	/** Reuse the BTW modal for independent interview flows without sharing BTW state. */
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
					: this.theme.fg("dim", " · ") + (this.full ? this.theme.fg("accent", this.theme.bold(btwModeLabel(true))) : this.theme.fg("dim", btwModeLabel(false)));
				const title = this.theme.fg("accent", this.theme.bold(this.appearance.title ?? "Bro · btw"));
				// Keep Grill's access warning ahead of text the frame may truncate.
				const header = this.customMode ? `${mode} · ${title}${model}` : title + model + mode;
				return header + this.theme.fg("dim", scroll ? ` · ${scroll}` : "");
			},
			body: (rows, innerWidth) => this.scroller.view(this.markdown.render(innerWidth), rows),
			// The frame drops lines from the top when space runs out, so the composer goes last.
			footer: [
				...(this.appearance.commands === "" ? [] : wrapTextWithAnsi(this.appearance.commands ?? "Commands: /mode · /copy · /copy-all · /clear · /retry · /help", inner)),
				...(this.suggestions ? wrapTextWithAnsi(this.theme.fg("accent", this.suggestions), inner) : []),
				this.theme.fg("accent", this.theme.bold(this.appearance.inputLabel ?? "Your message to Bro")),
				this.input.render(inner)[0] ?? "",
			],
			notice: this.noticeText ? formatNotice(this.theme, this.noticeText, this.noticeTone) : undefined,
			// A tool label may be long. Preserve the elapsed seconds and Esc
			// on one line; shorten only the stage so transcript height stays put.
			hints: this.running
				? runningHint(this.progressText || "Bro is thinking…", inner, [
					" · Esc close (stops reply)", " · Esc close",
				])
				: (this.appearance.idleHint ?? "Enter send · Esc close"),
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.onDispose();
	}
}

export async function openBtwModal(
	ctx: ExtensionCommandContext,
	options: { thread: BtwThread; initialQuestion?: string; onChange?: () => void },
): Promise<void> {
	const thread = options.thread;

	await openBroOverlay<void>(
		ctx,
		(tui, theme, _keybindings, done) => {
			let closed = false;
			let controller: AbortController | undefined;
			let stopActiveProgress: (() => void) | undefined;
			let activeTurn: { pending?: BtwTurn; original?: BtwTurn } | undefined;
			// Discard an unfinished reply immediately on close, before another modal can
			// reuse the same thread. A cancelled retry restores the completed old turn.
			const discardUnfinished = () => {
				const work = activeTurn;
				if (!work) return;
				let position = thread.turns.length;
				if (work.pending) {
					const index = thread.turns.indexOf(work.pending);
					if (index >= 0) {
						position = index;
						thread.turns.splice(index, 1);
					}
				}
				if (work.original && !thread.turns.includes(work.original)) {
					thread.turns.splice(position, 0, work.original);
				}
				activeTurn = undefined;
			};

			const transcript = () => formatBtwTranscript(thread.turns);

			let composerTouched = false;
			const saveDraft = () => {
				const draft = modal.getComposerText();
				if (draft.trim()) {
					thread.draft = draft;
				} else if (!options.initialQuestion || composerTouched) {
					delete thread.draft;
				}
			};

			const close = () => {
				if (closed) return;
				closed = true;
				saveDraft();
				stopActiveProgress?.();
				controller?.abort();
				discardUnfinished();
				options.onChange?.();
				done(undefined);
			};

			const modal = new BtwModal(tui, theme, close, submit, () => {
				if (closed) return; // Close already saved and cleaned this thread.
				closed = true;
				saveDraft();
				stopActiveProgress?.();
				controller?.abort();
				discardUnfinished();
				options.onChange?.();
			});
			modal.onInput = () => {
				composerTouched = true;
			};
			if (thread.draft && !options.initialQuestion) modal.setComposerText(thread.draft);

			// `replaced` is the turn /retry removed; it is put back if the turn never starts.
			const runTurn = async (question: string, replaced?: BtwTurn) => {
				if (controller) return;
				const turnController = new AbortController();
				const work: { pending?: BtwTurn; original?: BtwTurn } = { original: replaced };
				activeTurn = work;
				controller = turnController;
				let elapsedSeconds = 0;
				let stage = "Preparing request";
				const updateProgress = () => {
					if (!closed && controller === turnController && !turnController.signal.aborted)
						modal.setProgress(`${stage} · ${elapsedSeconds}s`);
				};
				modal.setRunning(true);
				const stopClock = startProgressClock(turnController.signal, seconds => {
					elapsedSeconds = seconds;
					updateProgress();
				});
				const stopProgress = () => {
					stopClock();
					if (stopActiveProgress === stopProgress) stopActiveProgress = undefined;
				};
				stopActiveProgress = stopProgress;

				let settings: BroSettings;
				let preferences: string;
				try {
					settings = await readSettings();
					preferences = await readPreferences();
				} catch (error) {
					stopProgress();
					if (activeTurn === work) discardUnfinished();
					if (!closed && !replaced && !options.initialQuestion) modal.setComposerText(question);
					if (controller === turnController) controller = undefined;
					if (!closed) { modal.setRunning(false); modal.setNotice(errorMessage(error), "error"); options.onChange?.(); }
					return;
				}
				// Do not restore a cancelled retry twice after close/dispose.
				if (closed || turnController.signal.aborted) {
					stopProgress();
					if (activeTurn === work) discardUnfinished();
					if (controller === turnController) controller = undefined;
					return;
				}
				if (bindBtwBackend(thread, capabilityBackend(settings, "btw"))) {
					work.original = undefined; // An old-backend retry must not recreate discarded history.
					modal.setNotice("Backend changed — started a fresh side thread.", "warning");
				}
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

				const pending = { question, answer: "…" };
				work.pending = pending;
				thread.turns.push(pending);
				modal.setText(transcript());
				modal.scrollToEnd();

				try {
					const selection = selectionForCapability(settings, "btw");
					thread.model = selectionLabel(selection);
					thread.preferences = Boolean(preferences);
					modal.setModel(btwHeaderLabel(thread));
					stage = "Waiting for backend";
					updateProgress();
					const showBackendProgress = (event: BackendProgress) => {
						if (closed || turnController.signal.aborted) return;
						// Activity labels are name/type-only at the backend boundary.
						// Process every phase here, before the 75 ms text render throttle.
						const next = event.kind === "activity" ? `Last tool: ${event.label}` : "Receiving answer";
						if (next !== stage) { stage = next; updateProgress(); }
					};
					const showRenderedText = (partial: string) => {
						if (closed || turnController.signal.aborted) return;
						pending.answer = partial;
						modal.setText(transcript());
					};
					let result = await runBtwTurn(
						buildBtwPrompt(context, question, { full, history, preferences }),
						selection,
						{ full, cwd: ctx.cwd, conversationId },
						turnController.signal,
						showBackendProgress,
						showRenderedText,
					);
					if (closed || turnController.signal.aborted) return;
					if (result.expiredContinuation) {
						// The native session is gone. Drop the dead id, rebuild the prompt from this thread's own
						// transcript AND its captured main-session context (the local `context` is undefined
						// whenever a continuation existed), and run once more so nothing is silently lost.
						thread.conversationId = undefined;
						stage = "Restoring side thread";
						updateProgress();
						modal.setNotice("Side thread expired — reseeded from the transcript and session context.", "warning");
						const reseeded = await runBtwTurn(
							buildBtwPrompt(thread.context, question, { full, history: formatBtwTranscript(thread.turns.slice(0, -1)), preferences }),
							selection,
							{ full, cwd: ctx.cwd },
							turnController.signal,
							showBackendProgress,
							showRenderedText,
						);
						result = reseeded;
					}
					if (result.conversationId) {
						thread.conversationId = result.conversationId;
						thread.sessionFull = full;
						thread.sessionPreferences = preferences;
					}
					pending.answer = result.text;
				} catch (error) {
					if (turnController.signal.aborted || closed) return;
					pending.answer = `_${errorMessage(error)}_`;
					modal.setNotice(errorMessage(error), "error");
				} finally {
					stopProgress();
					if (controller === turnController) controller = undefined;
					if (activeTurn === work) {
						if (closed || turnController.signal.aborted) discardUnfinished();
						else activeTurn = undefined;
					}
					if (!closed) {
						modal.setRunning(false);
						modal.setText(transcript());
						options.onChange?.();
					}
				}
			};

			const toggleMode = () => {
				toggleBtwMode(thread);
				modal.setFull(thread.full);
				modal.setNotice(`Mode: ${btwModeLabel(thread.full)}`, "info");
				options.onChange?.();
			};

			const clear = () => {
				thread.turns = [];
				thread.conversationId = undefined;
				thread.context = undefined;
				thread.sessionFull = undefined;
				thread.sessionPreferences = undefined;
				delete thread.draft;
				modal.clearComposer();
				modal.setNotice("");
				modal.setText("");
				options.onChange?.();
			};

			const retry = () => {
				if (controller) return;
				const last = thread.turns.at(-1);
				if (!last) {
					modal.setNotice("Nothing to retry yet.", "warning");
					return;
				}
				thread.turns.pop();
				void runTurn(last.question, last);
			};

			const copyOut = async (all: boolean) => {
				const text = all ? transcript() : (thread.turns.at(-1)?.answer ?? "");
				if (!text.trim()) {
					modal.setNotice("Nothing to copy yet.", "warning");
					return;
				}
				try {
					await copyToClipboard(text);
					modal.setNotice(all ? "Copied the full thread to the clipboard." : "Copied the latest answer to the clipboard.", "success");
				} catch (error) {
					modal.setNotice(`Copy failed: ${errorMessage(error)}`, "error");
				}
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
				if (action.kind === "removed") {
					modal.clearComposer();
					modal.setNotice(`${action.command} was removed. Use /copy or /copy-all, then paste where you want it.`, "warning");
					return;
				}
				if (action.kind === "help") {
					modal.clearComposer();
					modal.setNotice("Commands: /mode, /copy, /copy-all, /clear, /retry, /help. Esc closes; completed turns stay private.");
					return;
				}
				if (action.kind === "retry") {
					composerTouched = true;
					modal.clearComposer();
					retry();
					return;
				}
				composerTouched = true;
				delete thread.draft;
				modal.clearComposer();
				void runTurn(action.text);
			}

			modal.setFull(thread.full);
			modal.setModel(btwHeaderLabel(thread));
			modal.setText(transcript());
			modal.scrollToEnd();

			if (options.initialQuestion) void runTurn(options.initialQuestion);

			return modal;
		},
		{ mouse: true },
	);
}
