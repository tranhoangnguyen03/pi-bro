import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	copyToClipboard,
	getAgentDir,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { execute, reviewBackendError } from "./backend.ts";
import { readSettings, selectionForCapability } from "./settings.ts";
import {
	replaceGuide,
	guideEvidence,
	buildReviewPrompt,
	listReviews,
	loadReview,
	parseGuide,
	reviewKey,
	saveReview,
	type ReviewRecord,
} from "./review.ts";
import { captureReview, readEvidence, resolveReviewTarget } from "./review-source.ts";
import { ReviewModal, newReviewView, safeReviewText } from "./review-modal.ts";

const activeReviews = new Map<string, AbortController | undefined>();
export function stopGuidedReviews(): void {
	for (const controller of activeReviews.values()) controller?.abort();
}
const overlayOptions = {
	anchor: "center" as const,
	width: "100%" as const,
	maxHeight: "100%" as const,
	margin: { top: 1, bottom: 1 },
};

export async function openGuidedReview(
	ctx: ExtensionCommandContext,
	value: string,
	preferences: string,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Guided Review requires local Pi interactive mode.", "warning");
		return;
	}
	const root = join(getAgentDir(), "bro-reviews");
	let record: ReviewRecord | undefined;
	let fresh = false;
	if (value === "resume" || !value) {
		const records = await listReviews(root, (file, error) =>
			ctx.ui.notify(
				`Cannot load ${file}: ${String(error)}. Original file left untouched.`,
				"warning",
			),
		);
		if (!records.length) {
			ctx.ui.notify("Start with /bro guided-review <PR number or URL>.", "info");
			return;
		}
		records.sort(
			(a, b) =>
				a.snapshot.target.repository.localeCompare(b.snapshot.target.repository) ||
				b.snapshot.target.number - a.snapshot.target.number,
		);
		const labels = records.map(
			(item) =>
				`${item.snapshot.target.repository} #${item.snapshot.target.number} · ${safeReviewText(item.snapshot.target.title ?? "").replace(/[\r\n\t]/g, " ")} · ${item.guide ? (item.guide.assessment ? "review ready" : "guide ready") : "not prepared"} · ${item.snapshot.target.head.slice(0, 8)}`,
		);
		const picked = await ctx.ui.select("Resume guided review", labels);
		if (!picked) return;
		record = records[labels.indexOf(picked)];
	} else {
		record = await ctx.ui.custom<ReviewRecord | undefined>(
			(tui, theme, _keys, done) => {
				let controller = new AbortController();
				let message = "Resolving PR identity…";
				let failed = false;
				let retryable = true;
				let startedAt = Date.now();
				let disposed = false;
				const heartbeat = setInterval(() => {
					if (!disposed && !failed) tui.requestRender();
				}, 200);
				let locked: string | undefined;
				const release = () => {
					if (locked) {
						activeReviews.delete(locked);
						locked = undefined;
					}
				};
				const acquire = async () => {
					failed = false;
					retryable = true;
					startedAt = Date.now();
					controller = new AbortController();
					message = "Resolving PR identity…";
					tui.requestRender();
					try {
						const target = await resolveReviewTarget(value, ctx.cwd, controller.signal);
						if (disposed) return;
						const id = reviewKey(target);
						if (activeReviews.has(id)) {
							retryable = false;
							throw Error(
								"This review is already open in this Pi session. Close its existing workspace first.",
							);
						}
						locked = id;
						activeReviews.set(id, controller);
						const existing = await loadReview(root, id);
						if (existing) {
							if (
								existing.snapshot.target.head !== target.head ||
								existing.snapshot.target.base !== target.base
							)
								ctx.ui.notify(
									"PR has newer source. Continuing your saved captured revision.",
									"info",
								);
							release();
							if (!disposed) done(existing);
							return;
						}
						const selection = selectionForCapability(await readSettings(), "review");
						const backendError = reviewBackendError(selection.backend ?? "agy");
						if (backendError) {
							retryable = false;
							throw Error(backendError);
						}
						message = `${target.repository} #${target.number} · ${target.head.slice(0, 8)}\nFetching captured source…`;
						tui.requestRender();
						const snapshot = await captureReview(target, root, controller.signal);
						if (disposed) return;
						const next: ReviewRecord = { version: 1, id, snapshot, turns: [], ui: newReviewView() };
						await saveReview(root, next);
						fresh = true;
						release();
						if (!disposed) done(next);
					} catch (error) {
						if (!disposed) {
							failed = true;
							message = error instanceof Error ? error.message : String(error);
							tui.requestRender();
						}
					} finally {
						release();
					}
				};
				void acquire();
				return {
					render(width: number) {
						const inner = Math.max(1, width - 2);
						const height = Math.max(1, tui.terminal.rows - 2);
						const border = "─".repeat(inner);
						const row = (text: string) => {
							const line = truncateToWidth(text, inner, "…");
							return `│${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))}│`;
						};
						const body = wrapTextWithAnsi(safeReviewText(message), inner).slice(
							0,
							Math.max(1, height - 4),
						);
						const lines = [
							`╭${border}╮`,
							row(
								`Bro · Review${failed ? "" : ` · ${Math.floor((Date.now() - startedAt) / 1000)}s`}`,
							),
							...body.map(row),
							row(failed ? (retryable ? "Esc close · Enter retry" : "Esc close") : "Esc cancel"),
							`╰${border}╯`,
						];
						return lines
							.slice(0, height)
							.map((line) => theme.fg("accent", truncateToWidth(line, width, "")));
					},
					invalidate() {},
					handleInput(data: string) {
						if (matchesKey(data, "escape")) {
							disposed = true;
							controller.abort();
							release();
							done(undefined);
						} else if (failed && retryable && matchesKey(data, "return")) void acquire();
					},
					dispose() {
						disposed = true;
						clearInterval(heartbeat);
						controller.abort();
						release();
					},
				};
			},
			{ overlay: true, overlayOptions },
		);
	}
	if (!record) return;
	const state = record;
	if (activeReviews.has(state.id)) {
		ctx.ui.notify("This review is already open in this Pi session.", "info");
		return;
	}
	activeReviews.set(state.id, undefined);
	let overlayHandle: { setHidden(hidden: boolean): void } | undefined;
	try {
		await ctx.ui.custom<void>(
			(tui, theme, _keys, done) => {
				let controller: AbortController | undefined;
				let running: Promise<void> | undefined;
				let closed = false;
				let closing = false;
				let confirming = false;
				let saveTimer: ReturnType<typeof setTimeout> | undefined;
				let queue = Promise.resolve();
				const evidenceAbort = new AbortController();
				const persist = () => {
					if (saveTimer) {
						clearTimeout(saveTimer);
						saveTimer = undefined;
					}
					const snapshot = structuredClone(state);
					queue = queue.catch(() => {}).then(() => saveReview(root, snapshot));
					return queue.then(
						() => {
							panel.saveError = "";
							if (!closed) tui.requestRender();
						},
						(error) => {
							panel.saveError = `Not saved: ${error instanceof Error ? error.message : String(error)}. Use Retry saving, or Close to retry.`;
							tui.requestRender();
							throw error;
						},
					);
				};
				const changed = () => {
					if (saveTimer) clearTimeout(saveTimer);
					saveTimer = setTimeout(() => {
						void persist().catch(() => {});
					}, 250);
				};
				const evidenceReads = new Map<string, Promise<void>>();
				const hydrateEvidence = async () => {
					for (const ref of guideEvidence(state.guide)) {
						if (!ref.valid || closed) continue;
						const key = `${ref.path}:${ref.side}:${ref.start}:${ref.end}`;
						if (panel.evidence.has(key)) continue;
						let pending = evidenceReads.get(key);
						if (!pending) {
							pending = (async () => {
								try {
									const source = await readEvidence(
										state.snapshot,
										ref.path,
										ref.side,
										evidenceAbort.signal,
									);
									panel.evidence.set(
										key,
										source
											.split("\n")
											.slice(ref.start - 1, ref.end)
											.join("\n"),
									);
									panel.evidenceErrors.delete(key);
								} catch (error) {
									panel.evidenceErrors.set(key, `Captured code unavailable: ${String(error)}`);
								} finally {
									evidenceReads.delete(key);
								}
								if (!closed) tui.requestRender();
							})();
							evidenceReads.set(key, pending);
						}
						await pending;
					}
				};
				const run = async (target: string, question?: string, regenerate = false) => {
					if (controller || closed || closing) return;
					if (!question && state.guide && !regenerate) return;
					let generated = false;
					const abort = new AbortController();
					controller = abort;
					activeReviews.set(state.id, abort);
					panel.busy = true;
					panel.operation = question ? "answer" : regenerate ? "regenerate" : "guide";
					panel.startedAt = Date.now();
					panel.notice = question
						? "Answering…"
						: regenerate
							? "Regenerating guide…"
							: "Preparing guide…";
					panel.stage = { step: "start", detail: "Starting review" };
					const heartbeat = setInterval(() => {
						if (!closed) tui.requestRender();
					}, 200);
					const prompt = buildReviewPrompt(state, question, target, preferences);
					const turn: ReviewRecord["turns"][number] | undefined = question
						? { question, answer: "", target, status: "partial" }
						: undefined;
					panel.activeTurn = turn;
					if (turn) state.turns.push(turn);
					else state.guideAttempt = { text: "", status: "partial" };
					tui.requestRender();
					try {
						await persist();
						const settings = await readSettings();
						const selection = selectionForCapability(settings, "review");
						panel.notice = `${question ? "Answering" : regenerate ? "Regenerating guide" : "Preparing guide"} · ${selection.backend ?? "agy"}`;
						panel.stage = {
							step: "investigate",
							detail: question ? "Considering your question" : "Inspecting captured changes",
						};
						tui.requestRender();
						const outcome = await execute(
							{ feature: "review", access: "restricted", cwd: state.snapshot.checkout, prompt },
							selection,
							abort.signal,
							(progress) => {
								if (closed || abort.signal.aborted) return;
								if (progress.kind === "text") {
									if (turn) turn.answer = progress.text;
									else state.guideAttempt = { text: progress.text, status: "partial" };
									panel.stage = {
										step: "receive",
										detail: `Receiving response · ${progress.text.length.toLocaleString()} chars`,
									};
								} else panel.notice = progress.label;
								changed();
								tui.requestRender();
							},
						);
						if (outcome.status !== "success") {
							if (outcome.partialText) {
								if (turn) turn.answer = outcome.partialText;
								else state.guideAttempt = { text: outcome.partialText, status: "partial" };
							}
							throw Error(outcome.message);
						}
						if (abort.signal.aborted) throw Error("Cancelled");
						if (turn) {
							turn.answer = outcome.text;
							turn.status = "complete";
						} else {
							state.guideAttempt = { text: outcome.text, status: "partial" };
							let checked = 0;
							panel.stage = { step: "check", detail: "Checking references" };
							tui.requestRender();
							const guide = await parseGuide(
								outcome.text,
								async (path, side) => {
									try {
										return await readEvidence(state.snapshot, path, side, abort.signal);
									} finally {
										panel.stage = {
											step: "check",
											detail: `Checking references · ${++checked} checked`,
										};
										if (!closed) tui.requestRender();
									}
								},
								true,
							);
							if (abort.signal.aborted) throw Error("Cancelled");
							replaceGuide(state, guide);
							panel.syncGuideView();
							generated = true;
							delete state.guideAttempt;
							void hydrateEvidence();
						}
						panel.stage = { step: "save", detail: "Saving review" };
						tui.requestRender();
						await persist();
						panel.notice = "Saved";
					} catch (error) {
						if (turn && !abort.signal.aborted) {
							turn.status = "failed";
							turn.error = error instanceof Error ? error.message : String(error);
						}
						if (!turn && !generated && !abort.signal.aborted)
							state.guideAttempt = {
								text: state.guideAttempt?.text ?? "",
								status: "failed",
								error: String(error),
							};
						panel.notice = abort.signal.aborted ? "Stopped; partial work retained." : String(error);
						try {
							await persist();
						} catch {
							/* saveError stays visible independently of request status. */
						}
					} finally {
						clearInterval(heartbeat);
						controller = undefined;
						if (activeReviews.has(state.id)) activeReviews.set(state.id, undefined);
						panel.activeTurn = undefined;
						panel.stage = undefined;
						panel.busy = false;
						if (!closed) tui.requestRender();
					}
				};
				const close = async () => {
					if (closing || closed) return;
					closing = true;
					controller?.abort();
					try {
						await running;
						await persist();
						closed = true;
						ctx.ui.notify(
							`Review saved privately. Reopen with /bro guided-review ${state.snapshot.target.url ?? `https://${state.snapshot.target.host ?? "github.com"}/${state.snapshot.target.repository}/pull/${state.snapshot.target.number}`}. Use /bro guided-review to list saved reviews.`,
							"info",
						);
						done();
					} catch {
						closing = false;
						tui.requestRender();
					}
				};
				const panel = new ReviewModal(state, tui, theme, {
					ask(target, question) {
						running = run(target, question);
					},
					prepare() {
						running = run("whole review");
					},
					retrySave() {
						void persist().catch(() => {});
					},
					regenerate() {
						if (confirming || controller || closing || closed) return;
						confirming = true;
						overlayHandle?.setHidden(true);
						void ctx.ui
							.confirm(
								"Regenerate guide?",
								`Generate a new guide for captured revision ${state.snapshot.target.head.slice(0, 8)}? The new guide replaces your current guide when generation succeeds. Questions and drafts are kept with their original context. This makes a model call.`,
							)
							.then((approved) => {
								if (approved && !closed && !closing) running = run("whole review", undefined, true);
							})
							.catch((error) => {
								panel.notice = String(error);
							})
							.finally(() => {
								confirming = false;
								if (!closed) overlayHandle?.setHidden(false);
								tui.requestRender();
							});
					},
					stop() {
						controller?.abort();
						panel.notice = "Stopping…";
						tui.requestRender();
					},
					copy(text) {
						void copyToClipboard(text)
							.then(() => {
								panel.notice = "Finding copied to clipboard. Nothing submitted.";
							})
							.catch((error) => {
								panel.notice = `Copy failed: ${String(error)}`;
							})
							.finally(() => {
								if (!closed) tui.requestRender();
							});
					},
					close() {
						void close();
					},
					changed,
				});
				void hydrateEvidence();
				if (fresh)
					queueMicrotask(() => {
						if (!closed && !closing) running = run("whole review");
					});
				return {
					render: (width: number) => panel.render(width),
					invalidate: () => panel.invalidate(),
					handleInput: (data: string) => {
						if (!closing) {
							panel.handleInput(data);
							if (matchesKey(data, "return") && ["reading", "finding"].includes(panel.view.screen))
								void hydrateEvidence();
						}
					},
					handleMouse: (event: Parameters<ReviewModal["handleMouse"]>[0]) =>
						closing ? { handled: true, render: false } : panel.handleMouse(event),
					get focused() {
						return panel.focused;
					},
					set focused(value: boolean) {
						panel.focused = value;
					},
					dispose() {
						closed = true;
						panel.dispose();
						evidenceAbort.abort();
						controller?.abort();
						if (saveTimer) clearTimeout(saveTimer);
						void persist().catch(() => {});
					},
				};
			},
			{
				overlay: true,
				overlayOptions,
				onHandle: (handle) => {
					overlayHandle = handle;
				},
			},
		);
	} finally {
		activeReviews.get(state.id)?.abort();
		activeReviews.delete(state.id);
	}
}
