import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliChildAuth, verifyCliSubscription } from "../cli-auth.ts";
import { errorMessage, withDoctor } from "../util.ts";
import { checkedBtwContinuation, cliExitFailure, finishCliAttempt, startCliAttempt, stoppedCliOutcome } from "./cli-process.ts";
import { btwToolName, type BackendOnProgress, type BackendOutcome, type BackendRequest } from "./contract.ts";

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
export async function executeClaude(
	request: BackendRequest,
	selection: { model: string; effort?: string },
	signal: AbortSignal,
	onProgress: BackendOnProgress | undefined,
	killEscalationMs: number,
	deadlineMs: number,
): Promise<BackendOutcome> {
	const isAdvisor = request.feature === "advisor";
	const isBtw = request.feature === "btw";
	const inspect = request.feature === "review";
	const full = request.access === "workspace-full";
	const action = request.feature === "review" ? "complete the guided review request" : isAdvisor ? "complete the advisor consultation" : isBtw ? "answer the side question" : "simplify the response";

	if (signal.aborted) return { status: "cancelled", message: "Canceled." };
	const runDirectory = full || isBtw || inspect ? undefined : await mkdtemp(join(tmpdir(), "pi-bro-"));
	if (signal.aborted) {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
		return { status: "cancelled", message: "Canceled." };
	}

	try {
		let auth: ReturnType<typeof resolveCliChildAuth>;
		try { auth = resolveCliChildAuth("claude"); }
		catch (error) { return { status: "failure", message: errorMessage(error) }; }
		if (auth.subscription) {
			const check = await verifyCliSubscription("claude", auth.env, signal, killEscalationMs, deadlineMs);
			if (check) return check;
		}
		if (signal.aborted) return { status: "cancelled", message: "Canceled." };
		const { child, attempt, diagnostics } = startCliAttempt("claude",
			[
				"-p",
				"--safe-mode",
				...(isBtw ? [] : ["--no-session-persistence"]),
				"--disable-slash-commands",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				...(inspect
					? ["--restricted", "--tools", "Read,Grep,Glob", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "dontAsk"]
					: full
					? ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--dangerously-skip-permissions"]
					: ["--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "dontAsk"]),
				...(isBtw && request.continuation ? ["--resume", request.continuation.id] : []),
				"--model",
				selection.model,
				...(selection.effort ? ["--effort", selection.effort] : []),
			],
			{
				cwd: runDirectory ?? request.cwd,
				stdio: ["pipe", "pipe", "pipe"], env: auth.env }, signal, deadlineMs, killEscalationMs);

		let partial = "";
		let final: string | undefined;
		let terminalError: string | undefined;
		let initSessionId: string | undefined;
		let resultSessionId: string | undefined;

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
			if ((isAdvisor || isBtw || (inspect && request.reportReviewTools)) && topLevel && event.type === "assistant" && Array.isArray(event.message?.content)) {
				for (const block of event.message.content as Array<{ type?: unknown; name?: unknown; text?: unknown }>) {
					if (attempt.causeOf()) break;
					if ((isBtw || (inspect && request.reportReviewTools)) && block?.type !== "tool_use") continue;
					const tool = block?.type === "tool_use" ? btwToolName(block.name) : undefined;
					const label =
						block?.type === "tool_use" && typeof block.name === "string"
							? ((isBtw || (inspect && request.reportReviewTools)) ? tool : block.name.trim())
							: block?.type === "text" && typeof block.text === "string"
								? block.text.split("\n").find((text) => text.trim())?.trim()
								: undefined;
					if (label) onProgress?.({ kind: "activity", label, timestamp: Date.now(), ...(tool ? { tool } : {}) });
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

		const finished = await finishCliAttempt(child, attempt, "Claude", handleLine);
		const code = finished.code!;
		const stopped = stoppedCliOutcome("Claude", attempt, finished, diagnostics,
			`Claude timed out ${request.feature === "review" ? "during the guided review request" : isAdvisor ? "during the advisor consultation" : isBtw ? "during the side conversation" : "while simplifying the response"}. Run \`/bro doctor\` for setup help.`, partial);
		if (stopped) return stopped;
		const partialText = partial || undefined;
		if (terminalError) return { status: "failure", message: withDoctor(terminalError), partialText };
		if (code !== 0) return { status: "failure", message: cliExitFailure("Claude", action, diagnostics.stderr), partialText };
		if (final === undefined) {
			return { status: "failure", message: withDoctor(`Claude exited without a result event${diagnostics.stderr.trim() ? `: ${diagnostics.stderr.trim()}` : "."}`), partialText };
		}
		const text = final.trim();
		if (!text) return { status: "failure", message: withDoctor(request.feature === "review" ? "Claude returned no response for Guided Review." : isBtw ? "Claude returned no answer for the side question." : "Claude returned no final answer."), partialText };
		if (!isBtw) return { status: "success", text };
		const continuation = checkedBtwContinuation("Claude", request.continuation,
			{ init: initSessionId, result: resultSessionId });
		if ("error" in continuation)
			return { status: "failure", message: withDoctor(continuation.error), partialText };
		return { status: "success", text, continuation };
	} finally {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
	}
}
