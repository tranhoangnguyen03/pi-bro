import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDoctor } from "../util.ts";
import { finishCliAttempt, startCliAttempt, stoppedCliOutcome } from "./cli-process.ts";
import { btwToolName, type AgySelection, type BackendOnProgress, type BackendOutcome, type BackendRequest } from "./contract.ts";

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

type AgyEvent = {
	event?: string;
	conversation_id?: string;
	step_update?: { step_type?: string; text_delta?: unknown; tool_name?: unknown };
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

export function parseBtwAgyLine(line: string): { delta?: string; result?: string; conversationId?: string; error?: string; activity?: string } {
	let event: AgyEvent;
	try {
		event = JSON.parse(line) as AgyEvent;
	} catch {
		throw new Error("Agy returned invalid streaming data.");
	}
	const conversationId = event.conversation_id ?? event.result?.conversation_id;
	const stepType = event.step_update?.step_type;
	const tool = stepType === "agent_response" || stepType === "assistant" ? undefined : btwToolName(event.step_update?.tool_name);
	if (event.event === "step_update" && tool) {
		return { activity: tool, conversationId };
	}
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
	deadlineMs: number,
): Promise<BackendOutcome> {
	// Keep legacy CLI compatibility for small prompts; large inputs use the advisor's
	// stdin protocol rather than risking Linux's per-argument byte limit.
	const stdinPrompt = Buffer.byteLength(request.prompt, "utf8") >= 120_000;
	const isBtw = request.feature === "btw";
	const inspect = request.feature === "review";
	const full = request.access === "workspace-full";
	const printTimeout = full || inspect ? "10m" : "2m";
	const action = inspect ? "complete the guided review request" : isBtw ? "answer the side question" : "simplify the response";
	const timeoutVerb = inspect ? "during the guided review request" : isBtw ? "during the side conversation" : "while simplifying the response";
	const emptyTextMessage = inspect ? "Agy returned no response for Guided Review." : isBtw ? "Agy returned no answer for the side question." : "Agy returned no final explanation.";

	if (signal.aborted) return { status: "cancelled", message: "Canceled." };

	const runDirectory = full || inspect ? undefined : await mkdtemp(join(tmpdir(), "pi-bro-"));
	if (signal.aborted) {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
		return { status: "cancelled", message: "Canceled." };
	}

	try {
		const { child, attempt, diagnostics } = startCliAttempt("agy",
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
				...(isBtw && request.continuation ? ["--conversation", request.continuation.id] : []),
				...(stdinPrompt ? ["--input-format", "stream-json"] : ["--print", request.prompt]),
			],
			{
				cwd: full || inspect ? request.cwd : runDirectory,
				stdio: [stdinPrompt ? "pipe" : "ignore", "pipe", "pipe"] }, signal, deadlineMs, killEscalationMs);

		let partial = "";
		let final = "";
		let conversationId = request.continuation?.id;

		if (stdinPrompt) {
			child.stdin?.on("error", () => { /* Report early exits through the close/error path. */ });
			child.stdin?.end(`${JSON.stringify({ event: "user", message: { content: request.prompt } })}\n`);
		}

		const handleLine = (line: string) => {
			if (!line.trim() || attempt.causeOf()) return;
			if (isBtw) {
				const parsed = parseBtwAgyLine(line);
				if (parsed.conversationId) conversationId = parsed.conversationId;
				if (parsed.activity) onProgress?.({ kind: "activity", label: parsed.activity, timestamp: Date.now(), tool: parsed.activity });
				if (parsed.error) throw new Error(parsed.error);
				if (parsed.delta) {
					partial += parsed.delta;
					onProgress?.({ kind: "text", text: partial });
				}
				if (parsed.result !== undefined) final = parsed.result;
			} else {
				// Review-backed Grill receives tool events without changing review access.
				if (inspect && request.reportReviewTools) {
					const tool = parseBtwAgyLine(line).activity;
					if (tool) onProgress?.({ kind: "activity", label: tool, timestamp: Date.now(), tool });
				}
				const parsed = parseExplainLine(line);
				if (parsed.delta) {
					partial += parsed.delta;
					onProgress?.({ kind: "text", text: partial });
				}
				if (parsed.result !== undefined) final = parsed.result;
			}
		};

		const finished = await finishCliAttempt(child, attempt, "Agy", handleLine);
		const code = finished.code!;
		const stopped = stoppedCliOutcome("Agy", attempt, finished, diagnostics,
			`Agy timed out ${timeoutVerb}. Run \`/bro doctor\` for setup help.`, partial);
		if (stopped) return stopped;
		if (code !== 0) return { status: "failure", message: stdinPrompt && advisorFlagErrorHint(diagnostics.stderr)
			? withDoctor("Large prompts require Agy 1.1.15+ with stdin support. Run `agy update`. " + diagnostics.stderr.trim())
			: agyFailureMessage(action, { code, killed: false, stderr: diagnostics.stderr }) };

		const text = final.trim();
		if (!text) return { status: "failure", message: withDoctor(diagnostics.stderr.trim() || emptyTextMessage) };
		return { status: "success", text, continuation: isBtw && conversationId ? { id: conversationId } : undefined };
	} finally {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
	}
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
	deadlineMs: number,
): Promise<BackendOutcome> {
	if (signal.aborted) return { status: "cancelled", message: "Canceled." };

	const { child, attempt, diagnostics } = startCliAttempt("agy",
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
		{ cwd: request.cwd, stdio: ["pipe", "pipe", "pipe"] }, signal, deadlineMs, killEscalationMs);

	let final: string | undefined;
	let terminalError: string | undefined;
	let sawTerminal = false;

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
		if (activity) {
			const step = event.step_update;
			const tool = step?.step_type === "agent_response" || step?.step_type === "assistant"
				? undefined : btwToolName(step?.tool_name);
			onProgress?.({ kind: "activity", label: activity, timestamp: Date.now(), ...(tool ? { tool } : {}) });
		}
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

	const finished = await finishCliAttempt(child, attempt, "Agy", handleLine);
	const code = finished.code!;
	const stopped = stoppedCliOutcome("Agy", attempt, finished, diagnostics,
		"Agy timed out during the advisor consultation. Run `/bro doctor` for setup help.");
	if (stopped) return stopped;
	if (!sawTerminal) {
		const hint = advisorFlagErrorHint(diagnostics.stderr);
		return {
			status: "failure",
			message: withDoctor(hint ?? (diagnostics.stderr.trim() ? `Agy exited without a terminal result event: ${diagnostics.stderr.trim()}` : "Agy exited without a terminal result event.")),
		};
	}
	if (terminalError) return { status: "failure", message: withDoctor(terminalError) };
	if (code !== 0) return { status: "failure", message: agyFailureMessage("complete the advisor consultation", { code, killed: false, stderr: diagnostics.stderr }) };

	const text = final?.trim();
	if (!text) return { status: "failure", message: withDoctor(diagnostics.stderr.trim() || "Agy returned no advice.") };
	return { status: "success", text };
}

export function executeAgy(
	request: BackendRequest,
	selection: AgySelection,
	signal: AbortSignal,
	onProgress: BackendOnProgress | undefined,
	killEscalationMs: number,
	deadlineMs: number,
): Promise<BackendOutcome> {
	if (request.feature === "advisor") {
		return executeAdvisorStdin(request, selection, signal, onProgress, killEscalationMs, deadlineMs);
	}
	return executeArgvPrint(request, selection, signal, onProgress, killEscalationMs, deadlineMs);
}
