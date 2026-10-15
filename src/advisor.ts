import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execute as executeBackend, type BackendSelection } from "./backend.ts";
import { MAX_ADVISOR_STEERING_CHARS, buildAdvisorPrompt } from "./prompt.ts";
import { type BackendName, readSettings, selectionForCapability } from "./settings.ts";
import { errorMessage, isRecord } from "./util.ts";

// The steering brief is stored as a session `custom` entry — extension state that never
// participates in LLM context (see docs/plans/2026-09-19-bro-advisor-design.md). Writes go
// through pi.appendEntry(); ctx.sessionManager is read-only and has no append methods.
//
// bro_advisor has no on/off activation state: it is registered once at extension load like any
// other tool and never gated via pi.setActiveTools(). Whether the executor can call it is purely a
// function of this host's own tool restrictions (pi.getAllTools() / pi.getActiveTools()), which
// this code only ever reads, never overrides. A session may still carry historical
// "bro-advisor-active" entries from before this simplification; they are silently ignored.
export const ADVISOR_STEERING_ENTRY = "bro-advisor-steering";
export const ADVISOR_TOOL_NAME = "bro_advisor";
// setStatus() key for mirroring live advisor progress to the footer/status bar -- see the execute()
// handler below for why this fallback surface exists alongside onUpdate's tool-card renderResult.
export const ADVISOR_STATUS_BAR_KEY = "bro-advisor";
export const ADVISOR_COMPATIBILITY = "Pi >=0.84.2; Agy >=1.1.15";
export const ADVISOR_STEERING_FILE = join(getAgentDir(), "bro-advisor.md");
const MAX_ADVISOR_STEERING_FILE_BYTES = 64 * 1024;

export type AdvisorState = { steering: string };

// getBranch() walks root-to-leaf (see latestAssistant above for the same convention), so a forward
// scan taking the last match of ADVISOR_STEERING_ENTRY resolves "latest wins". Forking clones the
// branch's entries into a new session file, so this same resolution gives fork inheritance and
// independent post-fork edits for free, with no special-case fork logic.
export function resolveAdvisorState(branch: readonly SessionEntry[]): AdvisorState {
	let steering = "";
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== ADVISOR_STEERING_ENTRY) continue;
		if (isRecord(entry.data) && typeof entry.data.text === "string") steering = entry.data.text;
	}
	return { steering };
}

export function advisorAgyCompatible(version: string): boolean | undefined {
	const match = /(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(version);
	if (!match) return undefined;
	const installed = match.slice(1, 4).map(Number);
	const minimum = [1, 1, 15];
	for (let index = 0; index < minimum.length; index++) {
		if (installed[index]! !== minimum[index]!) return installed[index]! > minimum[index]!;
	}
	return true;
}

// Raw durable advisor steering text, undefined when there is no file. Rejects non-regular files and
// files > 64 KB before read.
export async function readAdvisorSteeringRaw(): Promise<string | undefined> {
	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(ADVISOR_STEERING_FILE);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Cannot read ${ADVISOR_STEERING_FILE}: ${errorMessage(error)}`);
	}
	if (!stats.isFile()) {
		throw new Error(`${ADVISOR_STEERING_FILE} is not a regular file. Edit or delete it directly.`);
	}
	if (stats.size > MAX_ADVISOR_STEERING_FILE_BYTES) {
		throw new Error(`${ADVISOR_STEERING_FILE} is larger than 64 KB. Edit or delete it directly.`);
	}
	try {
		const bytes = await readFile(ADVISOR_STEERING_FILE);
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Cannot read ${ADVISOR_STEERING_FILE}: ${errorMessage(error)}`);
	}
}

// Durable steering for the advisor tool: "" when absent or blank. Re-read on every consultation.
// An oversize or unreadable file throws an actionable message for the executor agent before spawn.
export async function readAdvisorSteering(): Promise<string> {
	const text = ((await readAdvisorSteeringRaw()) ?? "").trim();
	if (text.length > MAX_ADVISOR_STEERING_CHARS) {
		throw new Error(
			`Bro advisor steering file ${ADVISOR_STEERING_FILE} is ${text.length.toLocaleString("en-US")} characters (keep under ${MAX_ADVISOR_STEERING_CHARS.toLocaleString("en-US")}). Tell the human to edit or delete it; retrying won't help.`
		);
	}
	return text;
}

// Harness-neutral advisor context snapshot: plain role/text/tool-name+args/tool-result-text, not
// Pi's internal message objects serialized as-is, so the shape isn't a Pi-specific contract. Every
// piece of free-text message content is JSON-quoted (the same "quote the source as data" convention
// SOURCE_GUARD/buildShowPrompt/buildBtwPrompt already use in prompt.ts) rather than pasted in raw
// after a bare "## role" heading: unquoted text under a heading would let pasted text or tool output
// forge a fake "## user"/"## assistant" section that looks like a real turn boundary. See
// docs/plans/2026-09-19-bro-advisor-design.md, "Context snapshot".
type AdvisorMessageLike = { role?: unknown; content?: unknown; toolName?: unknown; toolCallId?: unknown; isError?: unknown };

// Parameter element type of Pi's own AgentMessage → LLM converter (core/messages.ts), reused below
// instead of redeclaring BashExecutionMessage's shape (it isn't exported from the package root).
type AdvisorAgentMessage = Parameters<typeof convertToLlm>[0][number];

function advisorQuoted(text: string): string {
	return JSON.stringify(text);
}

// `resolvedToolCallIds` lets a still-pending bro_advisor call (the one currently in flight for this
// very consultation, which by definition has no result yet) be dropped instead of rendered as an
// orphaned, unresolved call — a past, completed bro_advisor call is unaffected and renders normally.
function advisorContentText(content: unknown, resolvedToolCallIds: ReadonlySet<string>): string {
	if (typeof content === "string") {
		const text = content.trim();
		return text ? advisorQuoted(text) : "";
	}
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const type = (part as { type?: string }).type;
		if (type === "text" && typeof (part as { text?: unknown }).text === "string") {
			const text = (part as { text: string }).text.trim();
			if (text) parts.push(advisorQuoted(text));
		} else if (type === "image") {
			parts.push("[image omitted]");
		} else if (type === "thinking") {
			parts.push("[reasoning omitted]");
		} else if (type === "toolCall") {
			const call = part as { id?: unknown; name?: unknown; arguments?: unknown };
			const id = typeof call.id === "string" ? call.id : undefined;
			const name = typeof call.name === "string" ? call.name : "(unknown)";
			if (name === ADVISOR_TOOL_NAME && (!id || !resolvedToolCallIds.has(id))) continue;
			parts.push(`[tool call${id ? ` #${id}` : ""}] ${name}(${JSON.stringify(call.arguments ?? {})})`);
		}
	}
	return parts.join("\n").trim();
}

function renderAdvisorMessage(message: AdvisorMessageLike, resolvedToolCallIds: ReadonlySet<string>): string {
	if (message.role === "user") {
		const text = advisorContentText(message.content, resolvedToolCallIds);
		return text ? `## user\n${text}` : "";
	}
	if (message.role === "assistant") {
		const text = advisorContentText(message.content, resolvedToolCallIds);
		return text ? `## assistant\n${text}` : "";
	}
	if (message.role === "toolResult") {
		const name = typeof message.toolName === "string" ? message.toolName : "(unknown)";
		const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
		const header = `## tool result${id ? ` [#${id}]` : ""}: ${name}${message.isError ? " · error" : ""}`;
		const text = advisorContentText(message.content, resolvedToolCallIds);
		return text ? `${header}\n${text}` : header;
	}
	if (message.role === "bashExecution") {
		// Reuse Pi's own AgentMessage -> LLM conversion instead of hand-rolling one: it already
		// drops a command run with the `!!` prefix (excludeFromContext) and formats the rest exactly
		// as Pi's own context builder would, so a `!`-run command an executor can see is not silently
		// missing from what the advisor sees.
		const [converted] = convertToLlm([message as AdvisorAgentMessage]);
		if (!converted) return "";
		const text = advisorContentText(converted.content, resolvedToolCallIds);
		return text ? `## bash execution\n${text}` : "";
	}
	return "";
}

export function buildAdvisorSnapshot(ctx: ExtensionContext, pi: ExtensionAPI): { text: string; hadCompaction: boolean } {
	const systemPrompt = ctx.getSystemPrompt().trim();

	const activeToolNames = new Set(pi.getActiveTools().filter((name) => name !== ADVISOR_TOOL_NAME));
	const tools = pi.getAllTools().filter((tool) => activeToolNames.has(tool.name)).sort((a, b) => a.name.localeCompare(b.name));
	// No truncation of tool descriptions: Bro imposes no size cap on the snapshot (see the design
	// doc) and an arbitrary slice would silently drop part of a tool's actual behavior contract.
	const toolsSection = tools.length
		? tools.map((tool) => `- ${tool.name}: ${tool.description.replace(/\s+/g, " ").trim()}`).join("\n")
		: "(none)";

	const entries = ctx.sessionManager.buildContextEntries();
	const resolvedToolCallIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as AdvisorMessageLike;
		if (message.role === "toolResult" && typeof message.toolCallId === "string") resolvedToolCallIds.add(message.toolCallId);
	}

	const lines: string[] = [];
	// Tracked from the actual entry type, not a substring search over the rendered snapshot text --
	// free-text content (a file the executor read, a pasted paragraph) is JSON-quoted but not
	// stripped of "#", so a substring check could be forged by source data that happens to contain
	// the literal heading text. Only a real `compaction` entry may set this.
	let hadCompaction = false;
	for (const entry of entries) {
		if (entry.type === "message") {
			const rendered = renderAdvisorMessage(entry.message as AdvisorMessageLike, resolvedToolCallIds);
			if (rendered) lines.push(rendered);
		} else if (entry.type === "compaction") {
			// buildContextEntries() already includes every real entry after the compaction point;
			// the summary is all there is to represent for what it replaced.
			hadCompaction = true;
			lines.push(`## compacted earlier context\n${advisorQuoted(entry.summary)}`);
		} else if (entry.type === "branch_summary") {
			lines.push(`## abandoned branch summary\n${advisorQuoted(entry.summary)}`);
		} else if (entry.type === "custom_message") {
			const text = advisorContentText(entry.content, resolvedToolCallIds);
			if (text) lines.push(`## extension message: ${entry.customType}\n${text}`);
		}
		// "custom" entries (including our own advisor activation/steering state) are intentionally
		// skipped — they never participate in LLM context and must not leak into the snapshot either.
	}
	const conversationSection = lines.length ? lines.join("\n\n") : "(no conversation content captured)";

	const text = `## Executor's system instructions\n\n${systemPrompt ? advisorQuoted(systemPrompt) : "(none)"}\n\n## Executor's active tools\n\n${toolsSection}\n\n## Conversation so far (message text is quoted as JSON strings; includes tool calls and results, correlated by call id; image and reasoning content is noted but omitted; the still-pending advisor call for this very consultation is omitted)\n\n${conversationSection}`;
	return { text, hadCompaction };
}

const MAX_ADVISOR_ACTIVITY_LINES = 4;
const ADVISOR_ACTIVITY_PREVIEW_CHARS = 100;

function advisorActivityPreview(label: string): string {
	return label.length > ADVISOR_ACTIVITY_PREVIEW_CHARS ? `${label.slice(0, ADVISOR_ACTIVITY_PREVIEW_CHARS).trimEnd()}…` : label;
}

export type AdvisorActivityCallback = (label: string, timestamp: number) => void;

// Thin wrapper around the shared backend: advisor's stdin/stream-json transport, activity parsing,
// and process lifecycle now live in backend.ts (see docs/plans/2026-09-19-bro-advisor-design.md,
// "Transport" for why stdin rather than --print). This function keeps its exact existing
// signature/throw contract -- it is called directly by tests and by runAdvisorWithRetries below,
// which owns the 3-attempt retry/backoff policy the backend itself never performs.
export class TerminalConsultError extends Error {
	readonly status: "failure" | "cancelled" | "timeout";
	constructor(status: "failure" | "cancelled" | "timeout", message: string) {
		super(message);
		this.status = status;
	}
}

export async function runAdvisorConsultation(
	prompt: string,
	selection: BackendSelection,
	cwd: string,
	signal: AbortSignal,
	killEscalationMs = 5_000,
	onActivity?: AdvisorActivityCallback,
	deadlineMs?: number,
): Promise<string> {
	const outcome = await executeBackend(
		{ feature: "advisor", prompt, access: "workspace-full", cwd },
		selection,
		signal,
		onActivity
			? (progress) => {
					if (progress.kind === "activity") onActivity(progress.label, progress.timestamp);
				}
			: undefined,
		{ killEscalationMs, deadlineMs },
	);
	if (outcome.status === "success") return outcome.text;
	throw new TerminalConsultError(outcome.status, outcome.message);
}

function advisorDelay(ms: number, signal: AbortSignal, onTick?: (remainingMs: number) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Canceled."));
			return;
		}
		const startedAt = Date.now();
		const interval = onTick ? setInterval(() => onTick(Math.max(0, ms - (Date.now() - startedAt))), 1_000) : undefined;
		interval?.unref();
		const cleanup = () => {
			clearTimeout(timer);
			if (interval) clearInterval(interval);
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error("Canceled."));
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export type AdvisorConsult = (
	prompt: string,
	selection: BackendSelection,
	cwd: string,
	signal: AbortSignal,
	killEscalationMs?: number,
	onActivity?: AdvisorActivityCallback,
) => Promise<string>;
export type AdvisorDelayFn = (ms: number, signal: AbortSignal, onTick?: (remainingMs: number) => void) => Promise<void>;
export type AdvisorToolDetails = {
	status: "investigating" | "retrying" | "done";
	attempt: number;
	of: number;
	elapsedMs: number;
	error?: string;
	retryInMs?: number;
	backend?: BackendName;
	model?: string;
	effort?: string;
	durationMs?: number;
	cwd?: string;
	steeringIncluded?: boolean;
	steeringSources?: { durable: boolean; session: boolean };
	snapshotChars?: number;
	broTruncated?: false;
	omissions?: string;
	// Real backend-reported activity for the current attempt only -- reset to empty whenever a new
	// attempt (including a retry) starts, never carried over from a prior failed attempt.
	activity?: string[];
	lastActivityAt?: number;
	// Total count of accepted activity events (tool calls AND user-facing text deltas -- "activity"
	// is the honest label, not "tool calls") observed across the whole consultation, including every
	// retry attempt. Unlike `activity` above, this never resets on a retry; the final "done" details
	// carry the same running total.
	activityCount?: number;
};
export type AdvisorProgressCallback = (details: AdvisorToolDetails) => void;
export type AdvisorRunResult = { advice: string; attempts: number; durationMs: number; activityCount: number };

// Bursts of chunked NDJSON activity events are coalesced to this cadence so a fast stream of tool
// calls/text deltas doesn't flood onProgress; the 1s elapsed-time heartbeat below is unaffected and
// keeps ticking independently.
const ADVISOR_ACTIVITY_THROTTLE_MS = 250;

// `consult`/`delayFn` are injectable so tests can swap in a fake process spawn and a fake clock
// instead of spawning real processes and waiting 15 real seconds. Every attempt sends the
// identical prompt/selection/cwd to a fresh, standalone backend process — never resumed via
// --conversation, even across retries.
export async function runAdvisorWithRetries(
	prompt: string,
	selection: BackendSelection,
	cwd: string,
	signal: AbortSignal,
	consult: AdvisorConsult = runAdvisorConsultation,
	delayFn: AdvisorDelayFn = advisorDelay,
	onProgress?: AdvisorProgressCallback,
	progressIntervalMs = 1_000,
	activityThrottleMs = ADVISOR_ACTIVITY_THROTTLE_MS,
): Promise<AdvisorRunResult> {
	const delays = [5_000, 10_000];
	const totalAttempts = delays.length + 1;
	const startedAt = Date.now();
	let lastError: unknown;
	// Cumulative across every attempt in this consultation, including retries -- unlike `activity`
	// below, a retry must never reset this back to zero.
	let totalActivityCount = 0;
	for (let attempt = 0; attempt <= delays.length; attempt++) {
		if (signal.aborted) throw new Error("Canceled.");
		// Fresh per attempt: a retry must never show the previous attempt's activity trail.
		const activity: string[] = [];
		let lastActivityAt: number | undefined;
		let lastActivityEmitAt = 0;
		let pendingActivityTimer: ReturnType<typeof setTimeout> | undefined;

		const running = (): AdvisorToolDetails => ({
			status: "investigating",
			attempt: attempt + 1,
			of: totalAttempts,
			elapsedMs: Date.now() - startedAt,
			activity: [...activity],
			lastActivityAt,
			activityCount: totalActivityCount,
		});
		const emitRunning = () => onProgress?.(running());
		emitRunning();
		const progressTimer = onProgress ? setInterval(emitRunning, progressIntervalMs) : undefined;
		progressTimer?.unref();

		const stopActivityThrottle = () => {
			if (pendingActivityTimer) {
				clearTimeout(pendingActivityTimer);
				pendingActivityTimer = undefined;
			}
		};
		const onActivity: AdvisorActivityCallback = (label, timestamp) => {
			const normalized = label.replace(/\s+/g, " ").trim();
			if (!normalized) return;
			activity.push(normalized);
			if (activity.length > MAX_ADVISOR_ACTIVITY_LINES) activity.splice(0, activity.length - MAX_ADVISOR_ACTIVITY_LINES);
			totalActivityCount += 1;
			lastActivityAt = timestamp;
			if (!onProgress) return;
			const elapsed = Date.now() - lastActivityEmitAt;
			if (elapsed >= activityThrottleMs) {
				lastActivityEmitAt = Date.now();
				emitRunning();
				return;
			}
			if (!pendingActivityTimer) {
				pendingActivityTimer = setTimeout(() => {
					pendingActivityTimer = undefined;
					lastActivityEmitAt = Date.now();
					emitRunning();
				}, activityThrottleMs - elapsed);
				pendingActivityTimer.unref?.();
			}
		};

		try {
			const advice = await consult(prompt, selection, cwd, signal, undefined, onActivity);
			// `totalActivityCount` is read directly here rather than from the last onProgress snapshot,
			// which may lag behind by up to `activityThrottleMs` -- the final count must be exact.
			return { advice, attempts: attempt + 1, durationMs: Date.now() - startedAt, activityCount: totalActivityCount };
		} catch (error) {
			if (progressTimer) clearInterval(progressTimer);
			stopActivityThrottle();
			if (signal.aborted || errorMessage(error) === "Canceled." ||
				(error instanceof TerminalConsultError && error.status !== "failure")) throw error;
			lastError = error;
			if (attempt === delays.length) break;
			const delay = delays[attempt]!;
			const retrying = (remainingMs: number): AdvisorToolDetails => ({
				status: "retrying",
				attempt: attempt + 2,
				of: totalAttempts,
				elapsedMs: Date.now() - startedAt,
				error: errorMessage(error),
				retryInMs: remainingMs,
				activityCount: totalActivityCount,
			});
			onProgress?.(retrying(delay));
			await delayFn(delay, signal, (remainingMs) => onProgress?.(retrying(remainingMs)));
		} finally {
			if (progressTimer) clearInterval(progressTimer);
			stopActivityThrottle();
		}
	}
	throw lastError;
}

export function advisorAttemptLabel(details: AdvisorToolDetails): string {
	if (details.status === "retrying") {
		return `Bro advisor · retrying in ${Math.ceil((details.retryInMs ?? 0) / 1_000)}s · attempt ${details.attempt}/${details.of}${details.error ? ` — ${details.error}` : ""}`;
	}
	if (details.status === "done") {
		return `Bro advisor · ${details.model ?? "unknown model"} · ${details.attempt} attempt${details.attempt === 1 ? "" : "s"} · ${Math.ceil((details.durationMs ?? details.elapsedMs) / 1_000)}s`;
	}
	const latest = details.activity?.at(-1);
	const backendLabel = details.backend === "claude" ? "Claude" : details.backend === "grok" ? "Grok" : details.backend === "codex" ? "Codex" : details.backend === "muse" ? "Muse" : "Agy";
	// "last reported" + freshness, never a claim about what the backend is doing right now and never
	// "stalled" -- silence since lastActivityAt is not itself evidence of a stuck run.
	const activityLabel = latest
		? `last reported: ${advisorActivityPreview(latest)} (${Math.max(0, Math.floor((Date.now() - (details.lastActivityAt ?? Date.now())) / 1_000))}s ago)`
		: `awaiting first activity from ${backendLabel}`;
	return `Bro advisor · running · ${Math.floor(details.elapsedMs / 1_000)}s · attempt ${details.attempt}/${details.of} · ${activityLabel}`;
}

export function registerAdvisorTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: "Bro advisor",
		description:
			"Consult a fresh, independent process of the configured advisor backend for a second opinion mid-task. It has real, unsandboxed tool access in the current workspace (read files, search, run commands) with permissions auto-approved, and is instructed to investigate before advising and to leave edits to you — that is a behavioral instruction to the advisor, not an enforced restriction, so treat its findings as advice rather than a delegated implementation. No need to prepare a summary or evidence first: Bro automatically captures your system instructions, active tools, and the conversation so far, plus any human-set steering priorities, and sends them to the advisor.",
		promptSnippet: "Consult a fresh configured-backend process for a second opinion mid-task; it investigates the workspace itself and returns advice",
		promptGuidelines: [
			"Use bro_advisor when the user asks for an independent opinion, or when one would likely settle real uncertainty or catch a costly mistake. Routine decisions do not require consultation.",
			"bro_advisor's question parameter is optional — Bro captures context automatically, so you do not need to prepare a summary or evidence before calling.",
			"Any human-set steering priorities are applied automatically by bro_advisor; you don't need to relay or repeat them.",
			"bro_advisor is instructed to only return advice and leave edits to you — that instruction is not enforced, so verify its findings yourself rather than treating them as a completed implementation.",
		],
		parameters: Type.Object({
			question: Type.Optional(
				Type.String({ description: "Optional question to focus the consultation on. Leave unset to ask for general advice on the current state." }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const state = resolveAdvisorState(ctx.sessionManager.getBranch());
			const durableSteering = await readAdvisorSteering();
			const settings = await readSettings();
			const selection = selectionForCapability(settings, "advisor");
			const backend = selection.backend ?? "agy";
			const snapshot = buildAdvisorSnapshot(ctx, pi);
			const prompt = buildAdvisorPrompt({ durable: durableSteering, session: state.steering }, snapshot.text, params?.question);
			const hasDurable = Boolean(durableSteering.trim());
			const hasSession = Boolean(state.steering.trim());
			let lastAttempt: AdvisorToolDetails = { status: "investigating", attempt: 1, of: 3, elapsedMs: 0, backend };
			try {
				const run = await runAdvisorWithRetries(
					prompt,
					selection,
					ctx.cwd,
					signal ?? new AbortController().signal,
					undefined,
					undefined,
					(details) => {
						lastAttempt = { ...details, backend };
						const label = advisorAttemptLabel(lastAttempt);
						onUpdate?.({
							content: [{ type: "text", text: label }],
							details: lastAttempt,
						});
						// A host's tool-card renderer may replace onUpdate's partial renderResult with its
						// own generic placeholder for the whole run (observed with pi-cc-extensions' default
						// mode, which hardcodes "Pending…" for every isPartial tool result unless the tool
						// is opted into its excludeRenderers list). The footer/status bar is a separate,
						// host-owned surface that no such tool-card override touches, so mirror progress
						// there too as a fallback the user can see regardless of that renderer choice.
						ctx.ui.setStatus(ADVISOR_STATUS_BAR_KEY, label);
					},
				);
				const effort = selection.effort ?? "model default";
				const omissions = `image/reasoning bodies omitted when present; ${snapshot.hadCompaction ? "Pi compaction summaries replace earlier turns" : "no Pi compaction summary present"}`;
				const details: AdvisorToolDetails = {
					...lastAttempt,
					status: "done",
					attempt: run.attempts,
					backend,
					model: selection.model,
					effort,
					durationMs: run.durationMs,
					cwd: ctx.cwd,
					steeringIncluded: hasDurable || hasSession,
					steeringSources: { durable: hasDurable, session: hasSession },
					snapshotChars: snapshot.text.length,
					broTruncated: false,
					omissions,
					// run.activityCount is the exact final total; lastAttempt's may lag behind by up to
					// the activity throttle window.
					activityCount: run.activityCount,
				};
				// The backend qualifier appears only off Agy, keeping the Agy header byte-identical.
				const header = `Bro advisor · ${backend === "agy" ? "" : `backend: ${backend} · `}model: ${selection.model} · effort: ${effort} · ${run.attempts} attempt${run.attempts === 1 ? "" : "s"} · ${Math.ceil(run.durationMs / 1_000)}s`;
				const steeringSummary = hasDurable && hasSession
					? "included (durable+session)"
					: hasDurable
						? "included (durable)"
						: hasSession
							? "included"
							: "none";
				const context = `Context · cwd: ${JSON.stringify(ctx.cwd)} · steering: ${steeringSummary} · snapshot: ${snapshot.text.length} chars · Bro truncation: none · omissions: ${omissions}`;
				return { content: [{ type: "text", text: `${header}\n${context}\n\n${run.advice}` }], details };
			} finally {
				ctx.ui.setStatus(ADVISOR_STATUS_BAR_KEY, undefined);
			}
		},
		renderCall(args, theme) {
			const question = args.question?.trim();
			return new Text(theme.fg("dim", question ? `Bro advisor · ${question}` : "Bro advisor · consulting…"));
		},
		renderResult(result, options, theme) {
			const details = result.details as AdvisorToolDetails | undefined;
			if (options.isPartial) {
				const label = new Text(theme.fg("dim", details ? advisorAttemptLabel(details) : "Bro advisor · investigating…"));
				// Expanded + running: the simplest native tail -- one dim line per bounded recent
				// activity label, nothing fancier than the compact renderer above.
				if (!options.expanded || !details?.activity?.length) return label;
				const container = new Container();
				container.addChild(label);
				for (const line of details.activity) {
					container.addChild(new Text(theme.fg("dim", `  ${advisorActivityPreview(line)}`)));
				}
				return container;
			}
			if (!options.expanded && details?.status === "done") return new Text(theme.fg("accent", advisorAttemptLabel(details)));
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (!options.expanded) {
				const firstLine = text.split("\n").find((line) => line.trim()) ?? "(no advice)";
				return new Text(`${theme.fg("accent", "Bro advisor")}${theme.fg("dim", ` · ${firstLine}`)}`);
			}
			return new Markdown(text, 0, 0, getMarkdownTheme());
		},
	});
}
