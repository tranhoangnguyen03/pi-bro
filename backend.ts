import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared internal execution boundary for all four Bro features (explain, show, btw, advisor).
// This implements docs/plans/2026-09-22-shared-backend-design.md for Agy (all features) and the
// Claude Code CLI (all features) and the Grok CLI (all features): it owns CLI selection, process invocation, progress/outcome normalization, continuation, and
// single-attempt cleanup. Feature code (bro.ts) keeps retries, UI, source/session capture and
// settings.

export type BackendFeature = "explain" | "show" | "btw" | "advisor";
export type BackendAccess = "restricted" | "workspace-full";
export type AgySelection = { model: string; effort?: "low" | "medium" | "high" };
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const GROK_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export const MUSE_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type BackendSelection =
	| ({ backend?: "agy" } & AgySelection)
	| { backend: "claude"; model: string; effort?: (typeof CLAUDE_EFFORTS)[number] }
	| { backend: "grok"; model: string; effort?: (typeof GROK_EFFORTS)[number] }
	| { backend: "codex"; model: string; effort?: (typeof CODEX_EFFORTS)[number] }
	| { backend: "muse"; model: string; effort?: (typeof MUSE_EFFORTS)[number] };
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

function processStartMessage(processError: NodeJS.ErrnoException, cli = "Agy"): string {
	if (processError.code === "ENOENT") {
		return cli === "Agy"
			? "Agy could not start. Make sure Agy is installed and on PATH, then run `/bro doctor`."
			: cli === "Grok"
				? "Grok could not start. Make sure `grok` is installed and on PATH, then run `/bro doctor`."
				: cli === "Codex"
					? "Codex could not start. Make sure `codex` is installed and on PATH, then run `/bro doctor`."
					: cli === "Muse"
						? "Muse could not start. Make sure `muse` is installed and on PATH, then run `/bro doctor`."
						: "Claude Code could not start. Make sure `claude` is installed and on PATH, then run `/bro doctor`.";
	}
	return `${cli} could not start: ${processError.message}\n\nRun \`/bro doctor\` for setup help.`;
}

function unexpectedSignalMessage(exitSignal: NodeJS.Signals | null, cli = "Agy"): string {
	return withDoctor(`${cli} exited unexpectedly${exitSignal ? ` (signal ${exitSignal})` : ""}, not from a request Bro made.`);
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
export function beginAttempt(child: ChildProcess, signal: AbortSignal, deadlineMs: number, killEscalationMs: number): Attempt {
	let cause: StopCause | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let isClosed = false;
	let finishClose: (value: { code: number | null; exitSignal: NodeJS.Signals | null }) => void;
	const closed = new Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>((resolve) => {
		finishClose = (val) => {
			isClosed = true;
			resolve(val);
		};
		child.once("close", (code, exitSignal) => finishClose({ code, exitSignal }));
	});

	const stop = (next: StopCause) => {
		if (cause) return; // latched: the first stop cause wins
		cause = next;
		if (isClosed) return;
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

// Explain/show and BTW use argv for small prompts and stdin NDJSON for large
// prompts; sandbox, cwd, timeout, and continuation semantics stay unchanged.
async function executeArgvPrint(
	request: BackendRequest,
	selection: AgySelection,
	signal: AbortSignal,
	onProgress: BackendOnProgress | undefined,
	killEscalationMs: number,
	deadlineMsOverride: number | undefined,
): Promise<BackendOutcome> {
	// Keep legacy CLI compatibility for small prompts; large inputs use the advisor's
	// stdin protocol rather than risking Linux's per-argument byte limit.
	const stdinPrompt = Buffer.byteLength(request.prompt, "utf8") >= 120_000;
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
				...(stdinPrompt ? ["--input-format", "stream-json"] : ["--print", request.prompt]),
			],
			{
				cwd: full ? request.cwd : runDirectory,
				stdio: [stdinPrompt ? "pipe" : "ignore", "pipe", "pipe"],
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

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			processError = error;
		});

		if (stdinPrompt) {
			child.stdin?.on("error", () => { /* Report early exits through the close/error path. */ });
			child.stdin?.end(`${JSON.stringify({ event: "user", message: { content: request.prompt } })}\n`);
		}

		const handleLine = (line: string) => {
			if (!line.trim() || attempt.causeOf()) return;
			if (isBtw) {
				const parsed = parseBtwAgyLine(line);
				if (parsed.conversationId) conversationId = parsed.conversationId;
				if (parsed.error) throw new Error(parsed.error);
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
		};

		const finishFraming = frameStdoutLines(child, attempt, "Agy", handleLine);

		const { code, exitSignal } = await attempt.closed;
		const parseError = finishFraming();
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
		if (code !== 0) return { status: "failure", message: stdinPrompt && advisorFlagErrorHint(stderr)
			? withDoctor("Large prompts require Agy 1.1.15+ with stdin support. Run `agy update`. " + stderr.trim())
			: agyFailureMessage(action, { code, killed: false, stderr }) };

		const text = final.trim();
		if (!text) return { status: "failure", message: withDoctor(stderr.trim() || emptyTextMessage) };
		return { status: "success", text, continuation: isBtw && conversationId ? { id: conversationId } : undefined };
	} finally {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
	}
}

// Guards only against a single runaway line with no newline (a protocol break, not a real
// response size) -- real NDJSON lines across all backends are far smaller than this.
export const MAX_STDOUT_LINE_CHARS = 2_000_000;

export function frameStdoutLines(
	child: ChildProcess,
	attempt: Attempt,
	backendName: string,
	onLine: (line: string) => void,
): () => string | undefined {
	const oversize = `${backendName} emitted a stdout line over ${MAX_STDOUT_LINE_CHARS} characters; the stream is unparseable.`;
	let buffer = "";
	let protocolError: string | undefined;

	const fail = (message: string) => {
		protocolError ??= message;
		buffer = "";
		attempt.stop("protocol");
	};

	child.stdout?.setEncoding("utf8");

	child.stdout?.on("error", (error) => {
		fail(`${backendName} stdout error: ${errorMessage(error)}`);
	});

	child.stdout?.on("data", (chunk: string) => {
		if (attempt.causeOf()) return;
		const parts = (buffer + chunk).split(/\r?\n/);
		buffer = parts.pop() ?? "";

		const pendingLen = buffer.endsWith("\r") ? buffer.length - 1 : buffer.length;
		if (pendingLen > MAX_STDOUT_LINE_CHARS || parts.some((line) => line.length > MAX_STDOUT_LINE_CHARS)) {
			return fail(oversize);
		}

		for (const line of parts) {
			if (attempt.causeOf()) return;
			if (!line.trim()) continue;
			try {
				onLine(line);
			} catch (error) {
				return fail(errorMessage(error));
			}
		}
	});

	return (): string | undefined => {
		if (!attempt.causeOf() && buffer.trim()) {
			const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
			if (line.length > MAX_STDOUT_LINE_CHARS) {
				fail(oversize);
			} else if (line.trim()) {
				try {
					onLine(line);
				} catch (error) {
					fail(errorMessage(error));
				}
			}
		}
		buffer = "";
		return protocolError;
	};
}

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
	let sawTerminal = false;

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

	const finishFraming = frameStdoutLines(child, attempt, "Agy", handleLine);

	const { code, exitSignal } = await attempt.closed;
	const protocolError = finishFraming();
	attempt.dispose();

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


type ClaudeEvent = {
	type?: unknown;
	subtype?: unknown;
	session_id?: unknown;
	is_error?: unknown;
	result?: unknown;
	parent_tool_use_id?: unknown;
	stop_reason?: unknown;
	terminal_reason?: unknown;
	event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } };
	message?: { content?: unknown };
};

// Every Claude run uses --safe-mode, which disables CLAUDE.md, skills, plugins, hooks and MCP
// servers but keeps the user's auth (--bare would break OAuth). The prompt goes over stdin.
// explain/show run fresh and tool-less in a scratch cwd; advisor runs fresh in the caller's
// workspace with tools auto-approved. btw persists its session (so `--resume` can continue it) and
// always runs in the caller's workspace, since Claude stores sessions per cwd: restricted turns are
// tool-less, full turns auto-approve tools, and one session resumes across both. Only the terminal
// `result` event is authoritative; streamed text_delta events are progress only, and thinking is
// dropped. btw requires init/result session ids to agree (and to equal the resumed id).
async function executeClaude(
	request: BackendRequest,
	selection: { model: string; effort?: string },
	signal: AbortSignal,
	onProgress: BackendOnProgress | undefined,
	killEscalationMs: number,
	deadlineMsOverride: number | undefined,
): Promise<BackendOutcome> {
	const isAdvisor = request.feature === "advisor";
	const isBtw = request.feature === "btw";
	const full = request.access === "workspace-full";
	const deadlineMs = deadlineMsOverride ?? (full ? 610_000 : isBtw ? 130_000 : 125_000);
	const action = isAdvisor ? "complete the advisor consultation" : isBtw ? "answer the side question" : "simplify the response";

	if (signal.aborted) return { status: "cancelled", message: "Canceled." };
	const runDirectory = isAdvisor || isBtw ? undefined : await mkdtemp(join(tmpdir(), "pi-bro-"));
	if (signal.aborted) {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
		return { status: "cancelled", message: "Canceled." };
	}

	try {
		const child = spawn(
			"claude",
			[
				"-p",
				"--safe-mode",
				...(isBtw ? [] : ["--no-session-persistence"]),
				"--disable-slash-commands",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				...(full
					? ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--dangerously-skip-permissions"]
					: ["--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "dontAsk"]),
				...(isBtw && request.continuation ? ["--resume", request.continuation.id] : []),
				"--model",
				selection.model,
				...(selection.effort ? ["--effort", selection.effort] : []),
			],
			{
				cwd: runDirectory ?? request.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				detached: process.platform !== "win32",
			},
		);

		const attempt = beginAttempt(child, signal, deadlineMs, killEscalationMs);
		let processError: Error | undefined;
		let stderr = "";
		let partial = "";
		let final: string | undefined;
		let terminalError: string | undefined;
		let initSessionId: string | undefined;
		let resultSessionId: string | undefined;

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			processError = error;
		});
		child.stdin?.on("error", () => {
			// claude exiting before it reads stdin is reported through the close/error path below.
		});
		child.stdin?.end(request.prompt);

		const handleLine = (line: string) => {
			if (!line.trim() || attempt.causeOf()) return;
			let event: ClaudeEvent;
			try {
				event = JSON.parse(line) as ClaudeEvent;
			} catch {
				throw new Error("Claude emitted invalid stream-json output.");
			}
			const topLevel = event.parent_tool_use_id === undefined || event.parent_tool_use_id === null;
			if (topLevel && event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") initSessionId = event.session_id;
			if (!isAdvisor && topLevel && event.type === "stream_event" && event.event?.type === "content_block_delta") {
				const delta = event.event.delta;
				if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
					partial += delta.text;
					onProgress?.({ kind: "text", text: partial });
				}
			}
			if (isAdvisor && topLevel && event.type === "assistant" && Array.isArray(event.message?.content)) {
				for (const block of event.message.content as Array<{ type?: unknown; name?: unknown; text?: unknown }>) {
					if (attempt.causeOf()) break;
					const label =
						block?.type === "tool_use" && typeof block.name === "string"
							? block.name.trim()
							: block?.type === "text" && typeof block.text === "string"
								? block.text.split("\n").find((text) => text.trim())?.trim()
								: undefined;
					if (label) onProgress?.({ kind: "activity", label, timestamp: Date.now() });
				}
			}
			if (event.type !== "result" || !topLevel) return;
			if (typeof event.session_id === "string") resultSessionId = event.session_id;
			if (event.subtype === "success" && event.is_error === false && (event.stop_reason !== "end_turn" || (event.terminal_reason !== undefined && event.terminal_reason !== "completed"))) {
				terminalError ??= `Claude did not complete the answer (stop reason: ${String(event.stop_reason)}, terminal reason: ${String(event.terminal_reason)}).`;
				return;
			}
			// A result ends a model turn, not necessarily the stream; the first failure is latched and
			// otherwise the latest successful result wins once the process exits cleanly.
			if (event.subtype === "success" && event.is_error === false && typeof event.result === "string") {
				final = event.result;
			} else {
				const detail =
					typeof event.subtype === "string" && event.subtype !== "success"
						? event.subtype
						: typeof event.result === "string" && event.result.trim()
							? event.result.trim()
							: "turn failed";
				terminalError ??= `Claude failed: ${detail}`;
			}
		};

		const finishFraming = frameStdoutLines(child, attempt, "Claude", handleLine);

		const { code, exitSignal } = await attempt.closed;
		const protocolError = finishFraming();
		attempt.dispose();

		const partialText = partial || undefined;
		const cause = attempt.causeOf();
		if (cause === "cancelled") return { status: "cancelled", message: "Canceled.", partialText };
		if (cause === "timeout") {
			const during = isAdvisor ? "during the advisor consultation" : isBtw ? "during the side conversation" : "while simplifying the response";
			return { status: "timeout", message: `Claude timed out ${during}. Run \`/bro doctor\` for setup help.`, partialText };
		}
		if (protocolError) return { status: "failure", message: withDoctor(protocolError), partialText };
		if (processError) return { status: "failure", message: processStartMessage(processError as NodeJS.ErrnoException, "Claude") };
		if (exitSignal || code === null) return { status: "failure", message: unexpectedSignalMessage(exitSignal, "Claude"), partialText };
		if (terminalError) return { status: "failure", message: withDoctor(terminalError), partialText };
		if (code !== 0) {
			const detail = stderr.trim();
			return {
				status: "failure",
				message: detail
					? `Claude could not ${action}: ${detail}\n\nRun \`/bro doctor\` for setup help.`
					: `Claude could not ${action}. Make sure Claude Code is installed and signed in, then run \`/bro doctor\`.`,
				partialText,
			};
		}
		if (final === undefined) {
			return { status: "failure", message: withDoctor(`Claude exited without a result event${stderr.trim() ? `: ${stderr.trim()}` : "."}`), partialText };
		}
		const text = final.trim();
		if (!text) return { status: "failure", message: withDoctor(isBtw ? "Claude returned no answer for the side question." : "Claude returned no final answer."), partialText };
		if (!isBtw) return { status: "success", text };
		// btw continuation: the session id must be reported, consistent, and (on resume) unchanged.
		const sessionId = resultSessionId ?? initSessionId;
		if (!sessionId || (initSessionId !== undefined && initSessionId !== sessionId) || (request.continuation && sessionId !== request.continuation.id)) {
			return {
				status: "failure",
				message: withDoctor(`Claude reported an inconsistent session id (expected ${request.continuation?.id ?? "one id"}, init ${initSessionId ?? "none"}, result ${resultSessionId ?? "none"}).`),
				partialText,
			};
		}
		return { status: "success", text, continuation: { id: sessionId } };
	} finally {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
	}
}

type GrokEvent = {
	permissionMode?: unknown;
	type?: unknown;
	subtype?: unknown;
	is_error?: unknown;
	result?: unknown;
	errors?: unknown;
	message?: unknown;
	parent_tool_use_id?: unknown;
	stop_reason?: unknown;
	session_id?: unknown;
	event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } };
};

// Grok's "restricted" access is a request in the prompt, NOT technical enforcement: every Grok run
// has all tools on (--sandbox off, bypassPermissions, subagents/web/scheduler available), so the
// model can still read, write or reach out if it ignores this. The parent UI owns telling the user
// that truthfully.
export const GROK_RESTRICTED_PREFIX =
	"Bro restricted mode (a request, not a technical restriction): answer only from the context supplied in this prompt. " +
	"Do not inspect, read, or write workspace files, run commands, or use web or other external tools unless the user explicitly asks you to in this prompt.";

// Grok runs every feature with all capabilities on (--sandbox off, bypassPermissions, no tool
// blacklist). explain/show run in a fresh mkdtemp scratch cwd removed afterwards (the Agy pattern);
// btw (both accesses) runs in the caller's workspace cwd and continues natively with --resume, whose
// session keeps the cwd it was created in; the advisor runs fresh in the workspace. Restricted
// requests get GROK_RESTRICTED_PREFIX. The prompt goes through a private 0600 file in its own
// mkdtemp directory, removed once the attempt ends.
// Only a top-level terminal `result` with success/is_error false/end_turn is authoritative; the
// first failure (a failed result or a top-level `error` event, even after a success) is latched.
// Nested (subagent) frames are ignored. The advisor reports activity labels only; explain/show/btw
// report top-level text_delta progress, falling back to an assistant message's text blocks only when
// no delta streamed for it. Thinking is never reported. btw requires init/result session ids to
// agree (and to equal the resumed id) and returns that id as the continuation.
async function executeGrok(
	request: BackendRequest,
	selection: { model: string; effort?: string },
	signal: AbortSignal,
	onProgress: BackendOnProgress | undefined,
	killEscalationMs: number,
	deadlineMsOverride: number | undefined,
): Promise<BackendOutcome> {
	const isAdvisor = request.feature === "advisor";
	const isBtw = request.feature === "btw";
	const deadlineMs = deadlineMsOverride ?? (isAdvisor || (isBtw && request.access === "workspace-full") ? 610_000 : isBtw ? 130_000 : 125_000);
	const action = isAdvisor ? "complete the advisor consultation" : isBtw ? "answer the side question" : "simplify the response";
	const timeoutVerb = isAdvisor ? "during the advisor consultation" : isBtw ? "during the side conversation" : "while simplifying the response";
	const emptyTextMessage = isAdvisor ? "Grok returned no advice." : isBtw ? "Grok returned no answer for the side question." : "Grok returned no final explanation.";
	const prompt = request.access === "restricted" ? `${GROK_RESTRICTED_PREFIX}\n\n${request.prompt}` : request.prompt;

	if (signal.aborted) return { status: "cancelled", message: "Canceled." };
	const promptDirectory = await mkdtemp(join(tmpdir(), "pi-bro-grok-"));
	let runDirectory: string | undefined;
	try {
		if (signal.aborted) return { status: "cancelled", message: "Canceled." };
		const promptFile = join(promptDirectory, "prompt.txt");
		await writeFile(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
		if (!isAdvisor && !isBtw) runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
		if (signal.aborted) return { status: "cancelled", message: "Canceled." };

		const child = spawn(
			"grok",
			[
				"--sandbox",
				"off",
				"--permission-mode",
				"bypassPermissions",
				"--output-format",
				"streaming-messages-json",
				"--include-partial-messages",
				"--model", selection.model,
				...(selection.effort ? ["--reasoning-effort", selection.effort] : []),
				...(isBtw && request.continuation ? ["--resume", request.continuation.id] : []),
				"--prompt-file",
				promptFile,
			],
			{ cwd: runDirectory ?? request.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" },
		);

		const attempt = beginAttempt(child, signal, deadlineMs, killEscalationMs);
		let processError: Error | undefined;
		let stderr = "";
		let partial = "";
		let streamedSinceAssistant = false;
		let initSessionId: string | undefined;
		let resultSessionId: string | undefined;
		let final: string | undefined;
		let terminalError: string | undefined;

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			processError = error;
		});

		const handleLine = (line: string) => {
			if (!line.trim() || attempt.causeOf()) return;
			let event: GrokEvent;
			try {
				event = JSON.parse(line) as GrokEvent;
			} catch {
				throw new Error("Grok emitted invalid streaming-messages-json output.");
			}
			if (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null) return;
			if (event.type === "system" && event.subtype === "init") {
				if (event.permissionMode !== "bypassPermissions") {
					throw new Error("Grok did not apply the required bypassPermissions mode; check Grok policy/configuration.");
				}
				if (typeof event.session_id === "string") initSessionId = event.session_id;
			}
			if (!isAdvisor && event.type === "stream_event" && event.event?.type === "content_block_delta") {
				const delta = event.event.delta;
				if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
					partial += delta.text;
					streamedSinceAssistant = true;
					onProgress?.({ kind: "text", text: partial });
				}
			}
			if (event.type === "error") {
				terminalError ??= `Grok error: ${typeof event.message === "string" && event.message.trim() ? event.message.trim() : "unknown error"}`;
				return;
			}
			const message = event.message as { content?: unknown } | undefined;
			if (!isAdvisor && event.type === "assistant" && Array.isArray(message?.content)) {
				// Fallback only: an assistant message whose text already streamed as deltas is not re-appended.
				if (!streamedSinceAssistant) {
					const text = (message.content as Array<{ type?: unknown; text?: unknown }>)
						.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
						.join("");
					if (text) {
						partial += text;
						onProgress?.({ kind: "text", text: partial });
					}
				}
				streamedSinceAssistant = false;
			}
			if (isAdvisor && event.type === "assistant" && Array.isArray(message?.content)) {
				for (const block of message.content as Array<{ type?: unknown; name?: unknown; text?: unknown }>) {
					if (attempt.causeOf()) break;
					const label =
						block?.type === "tool_use" && typeof block.name === "string"
							? block.name.trim()
							: block?.type === "text" && typeof block.text === "string"
								? block.text.split("\n").find((text) => text.trim())?.trim()
								: undefined;
					if (label) onProgress?.({ kind: "activity", label, timestamp: Date.now() });
				}
			}
			if (event.type !== "result") return;
			if (typeof event.session_id === "string") resultSessionId = event.session_id;
			if (event.subtype === "success" && event.is_error === false) {
				if (event.stop_reason !== "end_turn") {
					terminalError ??= `Grok did not complete the ${isAdvisor ? "advice" : "answer"} (stop reason: ${String(event.stop_reason)}).`;
				} else if (typeof event.result === "string") {
					final = event.result;
				} else {
					terminalError ??= "Grok reported success without a final result.";
				}
				return;
			}
			const firstError = Array.isArray(event.errors)
				? event.errors.map((item) => (typeof item === "string" ? item : (item as { message?: unknown })?.message)).find((item) => typeof item === "string" && item.trim())
				: undefined;
			const detail =
				typeof firstError === "string"
					? firstError.trim()
					: typeof event.subtype === "string" && event.subtype !== "success"
						? event.subtype
						: typeof event.result === "string" && event.result.trim()
							? event.result.trim()
							: "turn failed";
			terminalError ??= `Grok failed: ${detail}`;
		};

		const finishFraming = frameStdoutLines(child, attempt, "Grok", handleLine);

		const { code, exitSignal } = await attempt.closed;
		const protocolError = finishFraming();
		attempt.dispose();

		const partialText = partial ? { partialText: partial } : {};
		const cause = attempt.causeOf();
		if (cause === "cancelled") return { status: "cancelled", message: "Canceled.", ...partialText };
		if (cause === "timeout") return { status: "timeout", message: `Grok timed out ${timeoutVerb}. Run \`/bro doctor\` for setup help.`, ...partialText };
		if (protocolError) return { status: "failure", message: withDoctor(protocolError), ...partialText };
		if (processError) return { status: "failure", message: processStartMessage(processError as NodeJS.ErrnoException, "Grok") };
		if (exitSignal || code === null) return { status: "failure", message: unexpectedSignalMessage(exitSignal, "Grok"), ...partialText };
		if (terminalError) return { status: "failure", message: withDoctor(terminalError), ...partialText };
		if (code !== 0) {
			const detail = stderr.trim();
			return {
				status: "failure",
				message: detail
					? `Grok could not ${action}: ${detail}\n\nRun \`/bro doctor\` for setup help.`
					: `Grok could not ${action}. Make sure \`grok\` is installed and signed in, then run \`/bro doctor\`.`,
				...partialText,
			};
		}
		if (final === undefined) {
			return { status: "failure", message: withDoctor(`Grok exited without a terminal result event${stderr.trim() ? `: ${stderr.trim()}` : "."}`), ...partialText };
		}
		const text = final.trim();
		if (!text) return { status: "failure", message: withDoctor(emptyTextMessage), ...partialText };
		if (!isBtw) return { status: "success", text };
		// btw continuation: the session id must be reported, consistent, and (on resume) unchanged.
		const sessionId = resultSessionId ?? initSessionId;
		if (!sessionId || (initSessionId !== undefined && initSessionId !== sessionId) || (request.continuation && sessionId !== request.continuation.id)) {
			return {
				status: "failure",
				message: withDoctor(`Grok reported an inconsistent session id (expected ${request.continuation?.id ?? "one id"}, init ${initSessionId ?? "none"}, result ${resultSessionId ?? "none"}).`),
				...partialText,
			};
		}
		return { status: "success", text, continuation: { id: sessionId } };
	} finally {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
		await rm(promptDirectory, { recursive: true, force: true });
	}
}

type CodexEvent = {
	type?: unknown;
	thread_id?: unknown;
	item?: {
		id?: unknown;
		type?: unknown;
		text?: unknown;
		message?: unknown;
		content?: unknown;
		command?: unknown;
		cmd?: unknown;
		path?: unknown;
		pattern?: unknown;
		query?: unknown;
	};
	error?: { message?: unknown };
	message?: unknown;
};

function extractCodexItemText(item: CodexEvent["item"]): string | undefined {
	if (!item) return undefined;
	if (typeof item.text === "string") return item.text;
	if (typeof item.message === "string") return item.message;
	if (typeof item.content === "string") return item.content;
	return undefined;
}

function codexActivityFromEvent(event: CodexEvent): string | undefined {
	const item = event.item;
	if (!item || item.type === "reasoning") return undefined;
	if (event.type === "item.started" || event.type === "item.completed") {
		if (item.type !== "agent_message") {
			const itemType = typeof item.type === "string" ? item.type : "item";
			const candidate = [item.command, item.cmd, item.path, item.pattern, item.query]
				.find((v) => typeof v === "string" && v.trim());
			const preview = typeof candidate === "string" ? candidate.replace(/\s+/g, " ").trim() : "";
			return `${itemType}${preview ? ` ${preview}` : ""}`;
		}
		if (item.type === "agent_message") {
			const text = extractCodexItemText(item);
			return text?.split("\n").find((line) => line.trim())?.trim();
		}
	}
	return undefined;
}

async function executeCodex(
	request: BackendRequest,
	selection: { model: string; effort?: string },
	signal: AbortSignal,
	onProgress: BackendOnProgress | undefined,
	killEscalationMs: number,
	deadlineMsOverride: number | undefined,
): Promise<BackendOutcome> {
	const isAdvisor = request.feature === "advisor";
	const isBtw = request.feature === "btw";
	const full = request.access === "workspace-full";
	const deadlineMs = deadlineMsOverride ?? (full ? 610_000 : isBtw ? 130_000 : 125_000);
	const action = isAdvisor ? "complete the advisor consultation" : isBtw ? "answer the side question" : "simplify the response";
	const timeoutVerb = isAdvisor ? "during the advisor consultation" : isBtw ? "during the side conversation" : "while simplifying the response";
	const emptyTextMessage = isAdvisor ? "Codex returned no advice." : isBtw ? "Codex returned no answer for the side question." : "Codex returned no final explanation.";

	if (signal.aborted) return { status: "cancelled", message: "Canceled." };
	const runDirectory = isAdvisor || isBtw ? undefined : await mkdtemp(join(tmpdir(), "pi-bro-"));
	if (signal.aborted) {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
		return { status: "cancelled", message: "Canceled." };
	}

	try {
		const permissionArgs = full ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "read-only"];
		const resume = isBtw && request.continuation;
		const args = [
			"exec",
			...permissionArgs,
			...(resume ? ["resume"] : []),
			"--json",
			"--skip-git-repo-check",
			...(!isBtw ? ["--ephemeral"] : []),
			"--model",
			selection.model,
			...(selection.effort ? ["-c", `model_reasoning_effort="${selection.effort}"`] : []),
			...(resume ? [request.continuation!.id, "-"] : ["--", "-"]),
		];

		const child = spawn("codex", args, {
			cwd: runDirectory ?? request.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});

		const attempt = beginAttempt(child, signal, deadlineMs, killEscalationMs);
		let processError: Error | undefined;
		let stderr = "";
		let partial = "";
		let threadId: string | undefined;
		let final: string | undefined;
		let sawTerminal = false;
		let terminalError: string | undefined;

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			processError = error;
		});
		child.stdin?.on("error", () => {
			// codex exiting before reading stdin is reported through the close/error path.
		});
		child.stdin?.end(request.prompt);

		const handleLine = (line: string) => {
			if (!line.trim() || attempt.causeOf()) return;
			let event: CodexEvent;
			try {
				event = JSON.parse(line) as CodexEvent;
			} catch {
				throw new Error("Codex emitted invalid JSON output.");
			}
			if (event.type === "thread.started" && typeof event.thread_id === "string") {
				threadId = event.thread_id;
			}
			if (event.type === "error") {
				terminalError ??= `Codex error: ${typeof event.message === "string" && event.message.trim() ? event.message.trim() : "unknown error"}`;
				return;
			}
			if (event.type === "turn.failed") {
				sawTerminal = true;
				const err = event.error as { message?: unknown } | undefined;
				terminalError ??= `Codex failed: ${typeof err?.message === "string" && err.message.trim() ? err.message.trim() : "turn failed"}`;
				return;
			}
			if (event.type === "turn.completed") {
				sawTerminal = true;
				return;
			}
			const item = event.item;
			if (isAdvisor && (event.type === "item.started" || event.type === "item.completed")) {
				const activity = codexActivityFromEvent(event);
				if (activity) onProgress?.({ kind: "activity", label: activity, timestamp: Date.now() });
			}
			if (event.type === "item.completed" && item?.type === "agent_message") {
				const text = extractCodexItemText(item);
				if (text !== undefined) {
					final = text;
					if (!isAdvisor) {
						partial += `${partial ? "\n\n" : ""}${text}`;
						onProgress?.({ kind: "text", text: partial });
					}
				}
			}
		};

		const finishFraming = frameStdoutLines(child, attempt, "Codex", handleLine);

		const { code, exitSignal } = await attempt.closed;
		const protocolError = finishFraming();
		attempt.dispose();

		const partialText = partial ? { partialText: partial } : {};
		const cause = attempt.causeOf();
		if (cause === "cancelled") return { status: "cancelled", message: "Canceled.", ...partialText };
		if (cause === "timeout") return { status: "timeout", message: `Codex timed out ${timeoutVerb}. Run \`/bro doctor\` for setup help.`, ...partialText };
		if (protocolError) return { status: "failure", message: withDoctor(protocolError), ...partialText };
		if (processError) return { status: "failure", message: processStartMessage(processError as NodeJS.ErrnoException, "Codex") };
		if (exitSignal || code === null) return { status: "failure", message: unexpectedSignalMessage(exitSignal, "Codex"), ...partialText };
		if (terminalError) return { status: "failure", message: withDoctor(terminalError), ...partialText };
		if (code !== 0) {
			const detail = stderr.trim();
			return {
				status: "failure",
				message: detail
					? `Codex could not ${action}: ${detail}\n\nRun \`/bro doctor\` for setup help.`
					: `Codex could not ${action}. Make sure \`codex\` is installed and signed in, then run \`/bro doctor\`.`,
				...partialText,
			};
		}
		if (!sawTerminal) {
			return { status: "failure", message: withDoctor(`Codex exited without a terminal result event${stderr.trim() ? `: ${stderr.trim()}` : "."}`), ...partialText };
		}
		const text = final?.trim();
		if (!text) return { status: "failure", message: withDoctor(emptyTextMessage), ...partialText };
		if (!isBtw) return { status: "success", text };
		if (!threadId || (request.continuation && threadId !== request.continuation.id)) {
			return {
				status: "failure",
				message: withDoctor(`Codex reported an inconsistent session id (expected ${request.continuation?.id ?? "one id"}, got ${threadId ?? "none"}).`),
				...partialText,
			};
		}
		return { status: "success", text, continuation: { id: threadId } };
	} finally {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
	}
}

type MuseEnvelope = {
	schema_version?: unknown;
	payload_type?: unknown;
	stream?: { kind?: unknown; id?: unknown };
	payload?: {
		kind?: unknown;
		command_id?: unknown;
		run_stream?: { kind?: unknown; id?: unknown };
		text?: unknown;
		reason?: unknown;
		correlation_facts?: { tool_name?: unknown };
		event?: { message?: unknown };
		command?: unknown;
		path?: unknown;
		file_path?: unknown;
		query?: unknown;
	};
};

async function executeMuse(
	request: BackendRequest,
	selection: { model: string; effort?: string },
	signal: AbortSignal,
	onProgress: BackendOnProgress | undefined,
	killEscalationMs: number,
	deadlineMsOverride: number | undefined,
): Promise<BackendOutcome> {
	const isAdvisor = request.feature === "advisor";
	const isBtw = request.feature === "btw";
	const full = request.access === "workspace-full";
	const deadlineMs = deadlineMsOverride ?? (full ? 610_000 : isBtw ? 130_000 : 125_000);
	const action = isAdvisor ? "complete the advisor consultation" : isBtw ? "answer the side question" : "simplify the response";
	const timeoutVerb = isAdvisor ? "during the advisor consultation" : isBtw ? "during the side conversation" : "while simplifying the response";
	const emptyTextMessage = isAdvisor ? "Muse returned no advice." : isBtw ? "Muse returned no answer for the side question." : "Muse returned no final explanation.";

	if (signal.aborted) return { status: "cancelled", message: "Canceled." };
	const promptDirectory = await mkdtemp(join(tmpdir(), "pi-bro-muse-"));
	let runDirectory: string | undefined;

	try {
		if (signal.aborted) return { status: "cancelled", message: "Canceled." };
		const promptFile = join(promptDirectory, "prompt.txt");
		await writeFile(promptFile, request.prompt, { encoding: "utf8", mode: 0o600 });
		if (!isAdvisor && !isBtw) runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
		if (signal.aborted) return { status: "cancelled", message: "Canceled." };
		const workspace = runDirectory ?? request.cwd!;

		const args = [
			"exec",
			"--json",
			"--provider", "meta",
			"--workspace", workspace,
			...(!isBtw ? ["--no-session-log"] : []),
			...(full ? ["--yolo"] : ["--disable-approval", "--disable-write", "--disable-shell"]),
			...(isBtw && request.continuation ? ["--session-id", request.continuation.id] : []),
			"--model", selection.model,
			...(selection.effort ? ["--reasoning-effort", selection.effort] : []),
			"--prompt-file", promptFile,
		];

		const child = spawn("muse", args, {
			cwd: workspace,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});

		const attempt = beginAttempt(child, signal, deadlineMs, killEscalationMs);
		let processError: Error | undefined;
		let stderr = "";
		let partial = "";
		let rootCommandId: string | undefined;
		let rootRunId: string | undefined;
		let sessionId: string | undefined;
		let final: string | undefined;
		let sawTerminal = false;
		let terminalError: string | undefined;

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			processError = error;
		});

		const handleLine = (line: string) => {
			if (!line.trim() || attempt.causeOf()) return;
			let envelope: MuseEnvelope;
			try {
				envelope = JSON.parse(line) as MuseEnvelope;
			} catch {
				throw new Error("Muse emitted invalid JSON output.");
			}
			const payload = envelope.payload;
			if (envelope.stream?.kind === "session" && typeof envelope.stream.id === "string") {
				if (!sessionId) sessionId = envelope.stream.id;
			}
			if (envelope.payload_type === "runtime.command.accepted") {
				if (!rootCommandId && typeof payload?.command_id === "string") {
					rootCommandId = payload.command_id;
				}
				return;
			}
			if (!rootRunId && (envelope.payload_type === "session.run.linked" || envelope.payload_type === "run.lifecycle.started")) {
				const runStream = payload?.run_stream;
				if (runStream?.kind === "run" && typeof runStream.id === "string") {
					if (rootCommandId === undefined || payload?.command_id === rootCommandId) {
						rootRunId = runStream.id;
						if (envelope.stream?.kind === "session" && typeof envelope.stream.id === "string") {
							sessionId = envelope.stream.id;
						}
					}
				}
				return;
			}
			const runStream = payload?.run_stream;
			const isRoot = rootRunId !== undefined && runStream?.kind === "run" && runStream.id === rootRunId;

			if (isAdvisor) {
				if (envelope.payload_type === "tool.result") {
					const facts = payload?.correlation_facts as { tool_name?: unknown } | undefined;
					const toolName = typeof facts?.tool_name === "string" && facts.tool_name ? facts.tool_name : "tool";
					const candidate = [payload?.text, payload?.command, payload?.path, payload?.file_path, payload?.query]
						.find((v) => typeof v === "string" && v.trim());
					const preview = typeof candidate === "string" ? candidate.replace(/\s+/g, " ").trim() : "";
					const label = `${toolName}${preview ? ` ${preview}` : ""}`;
					onProgress?.({ kind: "activity", label, timestamp: Date.now() });
				} else if (envelope.payload_type === "task.lifecycle.status") {
					const event = payload?.event as { message?: unknown } | undefined;
					if (typeof event?.message === "string" && event.message.trim()) {
						onProgress?.({ kind: "activity", label: event.message.trim(), timestamp: Date.now() });
					}
				}
			} else if (isRoot && envelope.payload_type === "run.output.delta") {
				if (typeof payload?.text === "string" && payload.text) {
					partial += payload.text;
					onProgress?.({ kind: "text", text: partial });
				}
			}

			if (!isRoot) return;
			if (envelope.payload_type === "run.terminal.completed") {
				sawTerminal = true;
				if (typeof payload?.text === "string") {
					final = payload.text;
				}
			} else if (envelope.payload_type === "run.terminal.failed") {
				sawTerminal = true;
				const reason = typeof payload?.reason === "string" && payload.reason.trim() ? payload.reason.trim() : "run did not complete";
				terminalError ??= `Muse failed: ${reason}`;
			}
		};

		const finishFraming = frameStdoutLines(child, attempt, "Muse", handleLine);

		const { code, exitSignal } = await attempt.closed;
		const protocolError = finishFraming();
		attempt.dispose();

		const partialText = partial ? { partialText: partial } : {};
		const cause = attempt.causeOf();
		if (cause === "cancelled") return { status: "cancelled", message: "Canceled.", ...partialText };
		if (cause === "timeout") return { status: "timeout", message: `Muse timed out ${timeoutVerb}. Run \`/bro doctor\` for setup help.`, ...partialText };
		if (protocolError) return { status: "failure", message: withDoctor(protocolError), ...partialText };
		if (processError) return { status: "failure", message: processStartMessage(processError as NodeJS.ErrnoException, "Muse") };
		if (exitSignal || code === null) return { status: "failure", message: unexpectedSignalMessage(exitSignal, "Muse"), ...partialText };
		if (terminalError) return { status: "failure", message: withDoctor(terminalError), ...partialText };
		if (code !== 0) {
			const detail = stderr.trim();
			return {
				status: "failure",
				message: detail
					? `Muse could not ${action}: ${detail}\n\nRun \`/bro doctor\` for setup help.`
					: `Muse could not ${action}. Make sure \`muse\` is installed and signed in, then run \`/bro doctor\`.`,
				...partialText,
			};
		}
		if (!sawTerminal) {
			return { status: "failure", message: withDoctor(`Muse exited without a terminal result event${stderr.trim() ? `: ${stderr.trim()}` : "."}`), ...partialText };
		}
		const text = final?.trim();
		if (!text) return { status: "failure", message: withDoctor(emptyTextMessage), ...partialText };
		if (!isBtw) return { status: "success", text };
		if (!sessionId || (request.continuation && sessionId !== request.continuation.id)) {
			return {
				status: "failure",
				message: withDoctor(`Muse reported an inconsistent session id (expected ${request.continuation?.id ?? "one id"}, got ${sessionId ?? "none"}).`),
				...partialText,
			};
		}
		return { status: "success", text, continuation: { id: sessionId } };
	} finally {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
		await rm(promptDirectory, { recursive: true, force: true });
	}
}

// Single-attempt executor shared by all four features. Never retries (retries are feature-owned,
// e.g. advisor's 3-attempt backoff in bro.ts); never spawns a pre-aborted request; on cancellation,
// host deadline, or a protocol failure, stops the whole POSIX process group (SIGTERM, then SIGKILL
// after a bounded grace period) before resolving. `options` is for offline tests only -- production
// callers never override the deadline or kill-escalation delay.
export async function execute(
	request: BackendRequest,
	selection: BackendSelection,
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
	const backend = (selection as { backend?: unknown }).backend;
	// An explicit tag guard: a stale or corrupt runtime tag must fail, never fall through to Agy.
	if (backend !== undefined && backend !== "agy" && backend !== "claude" && backend !== "grok" && backend !== "codex" && backend !== "muse") {
		return { status: "failure", message: `Unknown backend ${JSON.stringify(backend)}: pick Agy, Claude, Grok, Codex or Muse in \`/bro config\`.` };
	}
	const killEscalationMs = options?.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;
	if (selection.backend === "codex") {
		// Codex btw always runs (and resumes) in the caller's workspace, even restricted.
		if (request.feature === "btw" && !request.cwd?.trim()) {
			return { status: "failure", message: "Unsupported execution request: check feature access, workspace cwd and continuation." };
		}
		if (typeof selection.model !== "string" || !selection.model.trim() || (selection.effort !== undefined && !CODEX_EFFORTS.includes(selection.effort))) {
			return { status: "failure", message: "Unsupported Codex selection: check the model and effort (low, medium, high or xhigh)." };
		}
		return executeCodex(request, selection, signal, onProgress, killEscalationMs, options?.deadlineMs);
	}
	if (selection.backend === "muse") {
		// Muse btw always runs (and resumes) in the caller's workspace, even restricted.
		if (request.feature === "btw" && !request.cwd?.trim()) {
			return { status: "failure", message: "Unsupported execution request: check feature access, workspace cwd and continuation." };
		}
		if (typeof selection.model !== "string" || !selection.model.trim() || (selection.effort !== undefined && !MUSE_EFFORTS.includes(selection.effort))) {
			return { status: "failure", message: "Unsupported Muse selection: check the model and effort (minimal, low, medium, high, xhigh or max)." };
		}
		return executeMuse(request, selection, signal, onProgress, killEscalationMs, options?.deadlineMs);
	}
	if (selection.backend === "grok") {
		// Grok btw always runs (and resumes) in the caller's workspace, even restricted.
		if (request.feature === "btw" && !request.cwd?.trim()) {
			return { status: "failure", message: "Unsupported execution request: check feature access, workspace cwd and continuation." };
		}
		if (typeof selection.model !== "string" || !selection.model.trim() || (selection.effort !== undefined && !GROK_EFFORTS.includes(selection.effort))) {
			return { status: "failure", message: "Unsupported Grok selection: check the model and effort (low, medium, high or xhigh)." };
		}
		return executeGrok(request, selection, signal, onProgress, killEscalationMs, options?.deadlineMs);
	}
	if (selection.backend === "claude") {
		// Claude btw always runs (and resumes) in the caller's workspace, even restricted.
		if (request.feature === "btw" && !request.cwd?.trim()) {
			return { status: "failure", message: "Unsupported execution request: check feature access, workspace cwd and continuation." };
		}
		if (!selection.model.trim() || (selection.effort !== undefined && !CLAUDE_EFFORTS.includes(selection.effort))) {
			return { status: "failure", message: "Unsupported Claude selection: check the model and effort (low, medium, high, xhigh or max)." };
		}
		return executeClaude(request, selection, signal, onProgress, killEscalationMs, options?.deadlineMs);
	}
	if (request.feature === "advisor") {
		return executeAdvisorStdin(request, selection, signal, onProgress, killEscalationMs, options?.deadlineMs);
	}
	return executeArgvPrint(request, selection, signal, onProgress, killEscalationMs, options?.deadlineMs);
}
