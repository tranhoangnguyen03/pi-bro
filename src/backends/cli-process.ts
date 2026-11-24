import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { errorMessage, withDoctor } from "../util.ts";
import type { BackendContinuation, BackendOutcome } from "./contract.ts";

export function processStartMessage(processError: NodeJS.ErrnoException, cli = "Agy"): string {
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
// just the immediate child process -- child.kill() alone only ever reaches the immediate child.
function killProcessGroup(child: ChildProcess, signalName: NodeJS.Signals): void {
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
// and a protocol failure (malformed/inconsistent backend output). Exactly one is latched -- the first
// to occur -- and it is never relabeled by a later signal (e.g. a cancel arriving after a deadline
// already fired stays a timeout, not a cancellation).
type StopCause = "cancelled" | "timeout" | "protocol";

type Attempt = {
	causeOf: () => StopCause | undefined;
	stop: (cause: StopCause) => void;
	closed: Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>;
	dispose: () => void;
};

export const DEFAULT_KILL_ESCALATION_MS = 5_000;

// CLI adapters own their protocols; this shared runner owns process setup, diagnostics, and lifecycle.
export function startCliAttempt(
	command: string,
	args: string[],
	options: SpawnOptions,
	signal: AbortSignal,
	deadlineMs: number,
	killEscalationMs: number,
) {
	const child = spawn(command, args, { ...options, windowsHide: true, detached: process.platform !== "win32" });
	const attempt = beginAttempt(child, signal, deadlineMs, killEscalationMs);
	const diagnostics: { stderr: string; processError?: Error } = { stderr: "" };
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => { diagnostics.stderr += chunk; });
	child.once("error", (error) => { diagnostics.processError = error; });
	return { child, attempt, diagnostics };
}

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
		killProcessGroup(child, "SIGTERM");
		killTimer = setTimeout(() => {
			killProcessGroup(child, "SIGKILL");
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

// Every CLI adapter frames stdout immediately, awaits the process, then releases stop timers.
// Keep this lifecycle in one place: adapter-specific parsing and exit rules stay in each adapter.
export async function finishCliAttempt(
	child: ChildProcess,
	attempt: Attempt,
	name: string,
	handleLine: (line: string) => void,
): Promise<{ code: number | null; exitSignal: NodeJS.Signals | null; protocolError?: string }> {
	const finishFraming = frameStdoutLines(child, attempt, name, handleLine);
	try {
		const { code, exitSignal } = await attempt.closed;
		return { code, exitSignal, protocolError: finishFraming() };
	} finally {
		attempt.dispose();
	}
}

/** Common stop/error precedence. Backend adapters only decide terminal protocol and success. */
export function stoppedCliOutcome(
	name: string,
	attempt: Attempt,
	finished: { code: number | null; exitSignal: NodeJS.Signals | null; protocolError?: string },
	diagnostics: { stderr: string; processError?: Error },
	timeoutMessage: string,
	partial?: string,
): BackendOutcome | undefined {
	const partialText = partial ? { partialText: partial } : {};
	if (attempt.causeOf() === "cancelled") return { status: "cancelled", message: "Canceled.", ...partialText };
	if (attempt.causeOf() === "timeout") return { status: "timeout", message: timeoutMessage, ...partialText };
	if (finished.protocolError) return { status: "failure", message: withDoctor(finished.protocolError), ...partialText };
	if (diagnostics.processError) return { status: "failure", message: processStartMessage(diagnostics.processError as NodeJS.ErrnoException, name) };
	if (finished.exitSignal || finished.code === null) {
		return { status: "failure", message: unexpectedSignalMessage(finished.exitSignal, name), ...partialText };
	}
	return undefined;
}

/** Session continuity is a shared BTW promise, even though CLIs report IDs differently. */
export function checkedBtwContinuation(
	name: "Claude" | "Grok" | "Codex" | "Muse",
	requested: BackendContinuation | undefined,
	observed: { id?: string; init?: string; result?: string },
): BackendContinuation | { error: string } {
	const id = observed.id ?? observed.result ?? observed.init;
	if (id && (!observed.init || observed.init === id) && (!requested || requested.id === id)) return { id };
	const details = "id" in observed ? `got ${observed.id ?? "none"}`
		: `init ${observed.init ?? "none"}, result ${observed.result ?? "none"}`;
	return { error: `${name} reported an inconsistent session id (expected ${requested?.id ?? "one id"}, ${details}).` };
}

/** Exit diagnostics share framing, while each backend still owns its prompt and protocol. */
export function cliExitFailure(name: "Claude" | "Grok" | "Codex" | "Muse", action: string, stderr: string): string {
	const detail = stderr.trim();
	if (detail) return `${name} could not ${action}: ${detail}\n\nRun \`/bro doctor\` for setup help.`;
	const installation = {
		Claude: "Claude Code",
		Grok: "`grok`",
		Codex: "`codex`",
		Muse: "`muse`",
	}[name];
	return `${name} could not ${action}. Make sure ${installation} is installed and signed in, then run \`/bro doctor\`.`;
}
