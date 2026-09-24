import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Shared internal execution boundary for all four Bro features (explain, show, btw, advisor).
// This is the Agy-only implementation of docs/plans/2026-09-22-shared-backend-design.md: it owns
// Agy CLI selection, process invocation, progress/outcome normalization, continuation, and
// single-attempt cleanup. Feature code (bro.ts) keeps retries, UI, source/session capture and
// settings.

export type BackendFeature = "explain" | "show" | "btw" | "advisor";
export type BackendAccess = "restricted" | "workspace-full";
export type AgySelection = { model: string; effort?: "low" | "medium" | "high" };
export type BackendContinuation = { id: string };
export type BackendProgress = { kind: "text"; text: string } | { kind: "activity"; label: string; timestamp: number };
export type BackendOnProgress = (progress: BackendProgress) => void;

export type BackendRequest = {
	feature: BackendFeature;
	prompt: string;
	access: BackendAccess;
	cwd?: string; // required for workspace-full
	continuation?: BackendContinuation;
};

export type BackendOutcome =
	| { status: "success"; text: string; continuation?: BackendContinuation }
	| { status: "failure" | "cancelled" | "timeout"; message: string; partialText?: string };

export type BackendExecuteOptions = {
	// Injectable for offline tests only -- production always uses the defaults below.
	killEscalationMs?: number;
	deadlineMs?: number;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function withDoctor(message: string): string {
	return message.includes("/bro doctor") ? message : `${message}\n\nRun \`/bro doctor\` for setup help.`;
}

export function agyFailureMessage(action: string, result: { code: number; killed: boolean; stderr: string }): string {
	if (result.killed) return `Agy timed out while trying to ${action}. Run \`/bro doctor\` for setup help.`;
	const detail = result.stderr.trim();
	if (detail) return `Agy could not ${action}: ${detail}\n\nRun \`/bro doctor\` for setup help.`;
	return `Agy could not ${action}. Make sure Agy is installed and signed in, then run \`/bro doctor\`.`;
}

// Strips a "-low/-medium/-high" suffix from a stored model id and separates it back into a plain
// Agy `--model`/`--effort` pair; a "default" effort omits --effort entirely (Agy's own default).
export function agySelection(pair: { model: string; effort: "default" | "low" | "medium" | "high" }): AgySelection {
	if (pair.effort === "default") return { model: pair.model };
	const suffix = (["low", "medium", "high"] as const).find((effort) => pair.model.endsWith(`-${effort}`));
	return {
		model: suffix ? pair.model.slice(0, -suffix.length - 1) : pair.model,
		effort: pair.effort,
	};
}

function processStartMessage(processError: NodeJS.ErrnoException): string {
	return processError.code === "ENOENT"
		? "Agy could not start. Make sure Agy is installed and on PATH, then run `/bro doctor`."
		: `Agy could not start: ${processError.message}\n\nRun \`/bro doctor\` for setup help.`;
}

function unexpectedSignalMessage(exitSignal: NodeJS.Signals | null): string {
	return withDoctor(`Agy exited unexpectedly${exitSignal ? ` (signal ${exitSignal})` : ""}, not from a request Bro made.`);
}

// Sends to the whole POSIX process group when possible so a misbehaving grandchild dies too, not
// just the immediate agy process -- child.kill() alone only ever reaches the immediate child.
function killAgyGroup(child: ChildProcess, signalName: NodeJS.Signals): void {
	if (process.platform !== "win32" && typeof child.pid === "number") {
		try {
			process.kill(-child.pid, signalName);
			return;
		} catch {
			// Group may already be gone (e.g. the child already exited) -- fall through.
		}
	}
	child.kill(signalName);
}

// The three causes that stop an in-flight attempt: user cancellation, the host-imposed deadline,
// and a protocol failure (malformed/inconsistent Agy output). Exactly one is latched -- the first
// to occur -- and it is never relabeled by a later signal (e.g. a cancel arriving after a deadline
// already fired stays a timeout, not a cancellation).
type StopCause = "cancelled" | "timeout" | "protocol";

type Attempt = {
	causeOf: () => StopCause | undefined;
	stop: (cause: StopCause) => void;
	closed: Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>;
	dispose: () => void;
};

const DEFAULT_KILL_ESCALATION_MS = 5_000;

// Begins bounded lifecycle management for one already-spawned child: on cancellation, deadline, or
// protocol failure it signals the whole POSIX process group (SIGTERM, then SIGKILL after
// `killEscalationMs` if the child or a misbehaving grandchild ignores it). Windows only ever
// reaches the immediate child directly -- there is no process-tree guarantee there.
function beginAttempt(child: ChildProcess, signal: AbortSignal, deadlineMs: number, killEscalationMs: number): Attempt {
	let cause: StopCause | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let finishClose: (value: { code: number | null; exitSignal: NodeJS.Signals | null }) => void;
	const closed = new Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>((resolve) => {
		finishClose = resolve;
		child.once("close", (code, exitSignal) => resolve({ code, exitSignal }));
	});

	const stop = (next: StopCause) => {
		if (cause) return; // latched: the first stop cause wins
		cause = next;
		killAgyGroup(child, "SIGTERM");
		killTimer = setTimeout(() => {
			killAgyGroup(child, "SIGKILL");
			// Detached descendants (or Windows grandchildren) may retain inherited pipes.
			// Stop waiting on those pipes after escalation; never promote this stop to success.
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			finishClose({ code: null, exitSignal: "SIGKILL" });
		}, killEscalationMs);
		killTimer.unref?.();
	};

	const onAbort = () => stop("cancelled");
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();

	const deadlineTimer = setTimeout(() => stop("timeout"), deadlineMs);
	deadlineTimer.unref?.();

	const dispose = () => {
		signal.removeEventListener("abort", onAbort);
		clearTimeout(deadlineTimer);
		if (killTimer) clearTimeout(killTimer);
	};

	return { causeOf: () => cause, stop, closed, dispose };
}

type AgyEvent = {
	event?: string;
	conversation_id?: string;
	step_update?: { step_type?: string; text_delta?: unknown };
	result?: { status?: string; response?: unknown; error?: unknown; conversation_id?: string };
};

function parseExplainLine(line: string): { delta?: string; result?: string } {
	let event: AgyEvent;
	try {
		event = JSON.parse(line) as AgyEvent;
	} catch {
		throw new Error("Agy returned invalid streaming data.");
	}
	if (event.event === "step_update" && event.step_update?.step_type === "agent_response" && typeof event.step_update.text_delta === "string") {
		return { delta: event.step_update.text_delta };
	}
	if (event.event === "result") {
		if (event.result?.status !== "SUCCESS" || typeof event.result.response !== "string") {
			throw new Error("Agy did not complete the explanation successfully.");
		}
		return { result: event.result.response };
	}
	return {};
}

export function parseBtwAgyLine(line: string): { delta?: string; result?: string; conversationId?: string; error?: string } {
	let event: AgyEvent;
	try {
		event = JSON.parse(line) as AgyEvent;
	} catch {
		throw new Error("Agy returned invalid streaming data.");
	}
	const conversationId = event.conversation_id ?? event.result?.conversation_id;
	if (event.event === "step_update" && event.step_update?.step_type === "agent_response" && typeof event.step_update.text_delta === "string") {
		return { delta: event.step_update.text_delta, conversationId };
	}
	if (event.event === "result") {
		if (event.result?.status !== "SUCCESS" || typeof event.result.response !== "string") {
			const detail = typeof event.result?.error === "string" ? event.result.error : "Agy did not complete the turn successfully.";
			return { error: detail, conversationId };
		}
		return { result: event.result.response, conversationId };
	}
	return { conversationId };
}

// explain/show and btw all print the prompt as a single --print argv value and read a stream-json
// result off stdout; only sandbox flag, cwd, timeout, and (btw only) --conversation differ.
async function executeArgvPrint(
	request: BackendRequest,
	selection: AgySelection,
	signal: AbortSignal,
	onProgress: BackendOnProgress | undefined,
	killEscalationMs: number,
	deadlineMsOverride: number | undefined,
): Promise<BackendOutcome> {
	const isBtw = request.feature === "btw";
	const full = isBtw && request.access === "workspace-full";
	const deadlineMs = deadlineMsOverride ?? (isBtw ? (full ? 610_000 : 130_000) : 125_000);
	const printTimeout = full ? "10m" : "2m";
	const action = isBtw ? "answer the side question" : "simplify the response";
	const timeoutVerb = isBtw ? "during the side conversation" : "while simplifying the response";
	const emptyTextMessage = isBtw ? "Agy returned no answer for the side question." : "Agy returned no final explanation.";

	if (signal.aborted) return { status: "cancelled", message: "Canceled." };

	const runDirectory = full ? undefined : await mkdtemp(join(tmpdir(), "pi-bro-"));
	if (signal.aborted) {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
		return { status: "cancelled", message: "Canceled." };
	}

	try {
		const child = spawn(
			"agy",
			[
				...(full ? ["--dangerously-skip-permissions"] : ["--sandbox"]),
				"--disable-slash-commands",
				"--output-format",
				"stream-json",
				"--model",
				selection.model,
				...(selection.effort ? ["--effort", selection.effort] : []),
				"--print-timeout",
				printTimeout,
				...(request.continuation ? ["--conversation", request.continuation.id] : []),
				"--print",
				request.prompt,
			],
			{
				cwd: full ? request.cwd : runDirectory,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				detached: process.platform !== "win32",
			},
		);

		const attempt = beginAttempt(child, signal, deadlineMs, killEscalationMs);
		let processError: Error | undefined;
		let stderr = "";
		let partial = "";
		let final = "";
		let conversationId = request.continuation?.id;
		let parseError: string | undefined;

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			processError = error;
		});

		const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
		try {
			for await (const line of lines) {
				if (!line.trim() || attempt.causeOf()) continue;
				try {
					if (isBtw) {
						const parsed = parseBtwAgyLine(line);
						if (parsed.conversationId) conversationId = parsed.conversationId;
						if (parsed.error) {
							parseError = parsed.error;
							attempt.stop("protocol");
							break;
						}
						if (parsed.delta) {
							partial += parsed.delta;
							onProgress?.({ kind: "text", text: partial });
						}
						if (parsed.result !== undefined) final = parsed.result;
					} else {
						const parsed = parseExplainLine(line);
						if (parsed.delta) {
							partial += parsed.delta;
							onProgress?.({ kind: "text", text: partial });
						}
						if (parsed.result !== undefined) final = parsed.result;
					}
				} catch (error) {
					parseError = errorMessage(error);
					attempt.stop("protocol");
					break;
				}
			}
		} finally {
			lines.close();
		}

		const { code, exitSignal } = await attempt.closed;
		attempt.dispose();
		const cause = attempt.causeOf();

		if (cause === "cancelled") return { status: "cancelled", message: "Canceled.", partialText: partial || undefined };
		if (cause === "timeout") {
			return { status: "timeout", message: `Agy timed out ${timeoutVerb}. Run \`/bro doctor\` for setup help.`, partialText: partial || undefined };
		}
		if (parseError) return { status: "failure", message: withDoctor(parseError), partialText: partial || undefined };
		if (processError) return { status: "failure", message: processStartMessage(processError as NodeJS.ErrnoException) };
		if (exitSignal || code === null) {
			return { status: "failure", message: unexpectedSignalMessage(exitSignal), partialText: partial || undefined };
		}
		if (code !== 0) return { status: "failure", message: agyFailureMessage(action, { code, killed: false, stderr }) };

		const text = final.trim();
		if (!text) return { status: "failure", message: withDoctor(stderr.trim() || emptyTextMessage) };
		return { status: "success", text, continuation: isBtw && conversationId ? { id: conversationId } : undefined };
	} finally {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
	}
}

// Guards only against a single runaway line with no newline (a protocol break, not a real
// response size) -- agy's real NDJSON lines are far smaller than this.
const ADVISOR_MAX_STDOUT_LINE_CHARS = 2_000_000;

type AdvisorAgyEvent = {
	event?: string;
	step_update?: { tool_name?: unknown; step_type?: unknown; text_delta?: unknown };
	result?: { status?: unknown; response?: unknown; error?: unknown };
};

// Only a tool_name or a user-facing agent_response/assistant text_delta becomes an activity label
// -- hidden reasoning/thinking step_types and any other shape stay unreported, never leaked into
// progress.
function advisorActivityFromEvent(event: AdvisorAgyEvent): string | undefined {
	if (event.event !== "step_update" || !event.step_update || typeof event.step_update !== "object") return undefined;
	const update = event.step_update;
	if (typeof update.tool_name === "string" && update.tool_name.trim()) return update.tool_name.trim();
	const isUserFacingText = update.step_type === "agent_response" || update.step_type === "assistant";
	if (isUserFacingText && typeof update.text_delta === "string" && update.text_delta.trim()) {
		return update.text_delta.split("\n").find((line) => line.trim())?.trim();
	}
	return undefined;
}

// Older agy CLIs reject --input-format with Go's flag-package usage dump and exit before running
// the agent at all (no terminal result event). Turn that into an actionable version hint instead
// of a bare "no terminal result" error.
export function advisorFlagErrorHint(stderr: string): string | undefined {
	const match = /flags? provided but not defined: -([a-z0-9-]+)/i.exec(stderr);
	if (!match) return undefined;
	return `flag provided but not defined: -${match[1]} (installed Agy CLI is too old; the advisor needs Agy 1.1.15+ for --input-format stream-json — run \`agy update\`, then \`/bro doctor\`)`;
}

// Advisor speaks stdin NDJSON (never --print argv) and always runs fresh in the workspace with
// tools auto-approved; it never resumes and never passes --conversation.
async function executeAdvisorStdin(
	request: BackendRequest,
	selection: AgySelection,
	signal: AbortSignal,
	onProgress: BackendOnProgress | undefined,
	killEscalationMs: number,
	deadlineMsOverride: number | undefined,
): Promise<BackendOutcome> {
	if (signal.aborted) return { status: "cancelled", message: "Canceled." };

	const deadlineMs = deadlineMsOverride ?? 610_000;
	const child = spawn(
		"agy",
		[
			"--dangerously-skip-permissions",
			"--disable-slash-commands",
			"--output-format",
			"stream-json",
			"--input-format",
			"stream-json",
			"--model",
			selection.model,
			...(selection.effort ? ["--effort", selection.effort] : []),
			"--print-timeout",
			"10m",
		],
		{ cwd: request.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" },
	);

	const attempt = beginAttempt(child, signal, deadlineMs, killEscalationMs);

	let processError: Error | undefined;
	let stderr = "";
	let final: string | undefined;
	let terminalError: string | undefined;
	let protocolError: string | undefined;
	let sawTerminal = false;
	let stdoutBuffer = "";

	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.once("error", (error) => {
		processError = error;
	});
	child.stdin?.on("error", () => {
		// agy exiting before it reads stdin is reported through the close/error path below.
	});
	child.stdin?.end(`${JSON.stringify({ event: "user", message: { content: request.prompt } })}\n`);

	const handleLine = (line: string) => {
		if (!line.trim() || sawTerminal || attempt.causeOf()) return;
		let event: AdvisorAgyEvent;
		try {
			event = JSON.parse(line) as AdvisorAgyEvent;
		} catch {
			throw new Error("Agy emitted invalid stream-json output.");
		}
		const activity = advisorActivityFromEvent(event);
		if (activity) onProgress?.({ kind: "activity", label: activity, timestamp: Date.now() });
		if (event.event !== "result") return;
		sawTerminal = true;
		const result = event.result;
		const status = typeof result?.status === "string" ? result.status.trim().toUpperCase() : undefined;
		if (status === "SUCCESS" && typeof result?.response === "string") {
			final = result.response;
		} else {
			const detail = typeof result?.error === "string" && result.error.trim() ? `: ${result.error.trim()}` : "";
			terminalError = `Agy failed with status ${status ?? "(missing)"}${detail}`;
		}
	};

	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdoutBuffer += chunk;
		const parts = stdoutBuffer.split(/\r?\n/);
		stdoutBuffer = parts.pop() ?? "";
		if (stdoutBuffer.length > ADVISOR_MAX_STDOUT_LINE_CHARS || parts.some((line) => line.length > ADVISOR_MAX_STDOUT_LINE_CHARS)) {
			protocolError ??= `Agy emitted a stdout line over ${ADVISOR_MAX_STDOUT_LINE_CHARS} characters; the stream is unparseable.`;
			stdoutBuffer = "";
			attempt.stop("protocol");
			return;
		}
		for (const line of parts) {
			try {
				handleLine(line);
			} catch (error) {
				protocolError ??= errorMessage(error);
				attempt.stop("protocol");
				return;
			}
		}
	});

	const { code, exitSignal } = await attempt.closed;
	attempt.dispose();
	if (stdoutBuffer.trim() && !sawTerminal) {
		try {
			handleLine(stdoutBuffer);
		} catch (error) {
			protocolError ??= errorMessage(error);
		}
	}

	const cause = attempt.causeOf();
	if (cause === "cancelled") return { status: "cancelled", message: "Canceled." };
	if (cause === "timeout") {
		return { status: "timeout", message: "Agy timed out during the advisor consultation. Run `/bro doctor` for setup help." };
	}
	if (protocolError) return { status: "failure", message: withDoctor(protocolError) };
	if (processError) return { status: "failure", message: processStartMessage(processError as NodeJS.ErrnoException) };
	if (exitSignal || code === null) return { status: "failure", message: unexpectedSignalMessage(exitSignal) };
	if (!sawTerminal) {
		const hint = advisorFlagErrorHint(stderr);
		return {
			status: "failure",
			message: withDoctor(hint ?? (stderr.trim() ? `Agy exited without a terminal result event: ${stderr.trim()}` : "Agy exited without a terminal result event.")),
		};
	}
	if (terminalError) return { status: "failure", message: withDoctor(terminalError) };
	if (code !== 0) return { status: "failure", message: agyFailureMessage("complete the advisor consultation", { code, killed: false, stderr }) };

	const text = final?.trim();
	if (!text) return { status: "failure", message: withDoctor(stderr.trim() || "Agy returned no advice.") };
	return { status: "success", text };
}

// Single-attempt executor shared by all four features. Never retries (retries are feature-owned,
// e.g. advisor's 3-attempt backoff in bro.ts); never spawns a pre-aborted request; on cancellation,
// host deadline, or a protocol failure, stops the whole POSIX process group (SIGTERM, then SIGKILL
// after a bounded grace period) before resolving. `options` is for offline tests only -- production
// callers never override the deadline or kill-escalation delay.
export async function execute(
	request: BackendRequest,
	selection: AgySelection,
	signal: AbortSignal,
	onProgress?: BackendOnProgress,
	options?: BackendExecuteOptions,
): Promise<BackendOutcome> {
	if (
		(request.access === "workspace-full" && !request.cwd?.trim()) ||
		(request.feature === "advisor" && request.access !== "workspace-full") ||
		((request.feature === "explain" || request.feature === "show") && request.access !== "restricted") ||
		(request.feature !== "btw" && request.continuation)
	) return { status: "failure", message: "Unsupported execution request: check feature access, workspace cwd and continuation." };
	const killEscalationMs = options?.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;
	if (request.feature === "advisor") {
		return executeAdvisorStdin(request, selection, signal, onProgress, killEscalationMs, options?.deadlineMs);
	}
	return executeArgvPrint(request, selection, signal, onProgress, killEscalationMs, options?.deadlineMs);
}
