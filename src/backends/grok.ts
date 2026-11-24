import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDoctor } from "../util.ts";
import { checkedBtwContinuation, cliExitFailure, finishCliAttempt, startCliAttempt, stoppedCliOutcome } from "./cli-process.ts";
import { btwToolName, type BackendOnProgress, type BackendOutcome, type BackendRequest } from "./contract.ts";

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

// Grok runs explain, show, btw, and advisor with all capabilities on (--sandbox off,
// bypassPermissions, no tool blacklist); Guided Review (`review`) runs in the caller's workspace
// under Grok's read-only sandbox (--sandbox read-only, --permission-mode dontAsk).
// explain/show run in a fresh mkdtemp scratch cwd removed afterwards (the Agy pattern);
// btw (both accesses) runs in the caller's workspace cwd and continues natively with --resume, whose
// session keeps the cwd it was created in; the advisor and review run fresh in the workspace.
// Restricted requests other than review get GROK_RESTRICTED_PREFIX (review must be allowed to
// inspect the captured checkout). The prompt goes through a private 0600 file in its own mkdtemp
// directory, removed once the attempt ends.
// Only a top-level terminal `result` with success/is_error false/end_turn is authoritative; the
// first failure (a failed result or a top-level `error` event, even after a success) is latched.
// Nested (subagent) frames are ignored. The advisor reports activity labels only; explain/show/btw/review
// report top-level text_delta progress, falling back to an assistant message's text
// blocks only when no delta streamed for it. Thinking is never reported. btw requires init/result
// session ids to agree (and to equal the resumed id) and returns that id as the continuation.
export async function executeGrok(
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
	const action = inspect ? "complete the guided review request" : isAdvisor ? "complete the advisor consultation" : isBtw ? "answer the side question" : "simplify the response";
	const timeoutVerb = inspect ? "during the guided review request" : isAdvisor ? "during the advisor consultation" : isBtw ? "during the side conversation" : "while simplifying the response";
	const emptyTextMessage = inspect ? "Grok returned no response for Guided Review." : isAdvisor ? "Grok returned no advice." : isBtw ? "Grok returned no answer for the side question." : "Grok returned no final explanation.";
	// Review inspects the captured checkout, so it must not carry the "do not inspect" restriction.
	const prompt = request.access === "restricted" && !inspect ? `${GROK_RESTRICTED_PREFIX}\n\n${request.prompt}` : request.prompt;

	if (signal.aborted) return { status: "cancelled", message: "Canceled." };
	const promptDirectory = await mkdtemp(join(tmpdir(), "pi-bro-grok-"));
	let runDirectory: string | undefined;
	try {
		if (signal.aborted) return { status: "cancelled", message: "Canceled." };
		const promptFile = join(promptDirectory, "prompt.txt");
		await writeFile(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
		if (request.access !== "workspace-full" && !isBtw && !inspect) runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
		if (signal.aborted) return { status: "cancelled", message: "Canceled." };

		const { child, attempt, diagnostics } = startCliAttempt("grok",
			[
				// Review never auto-approves: dontAsk denies unpromptable asks instead of bypassing them. Unverified against a local grok CLI; an unsupported flag fails visibly rather than falling back to --sandbox off.
				...(inspect ? ["--sandbox", "read-only", "--permission-mode", "dontAsk"] : ["--sandbox", "off", "--permission-mode", "bypassPermissions"]),
				"--output-format",
				"streaming-messages-json",
				"--include-partial-messages",
				"--model", selection.model,
				...(selection.effort ? ["--reasoning-effort", selection.effort] : []),
				...(isBtw && request.continuation ? ["--resume", request.continuation.id] : []),
				"--prompt-file",
				promptFile,
			],
			{ cwd: runDirectory ?? request.cwd, stdio: ["ignore", "pipe", "pipe"] }, signal, deadlineMs, killEscalationMs);

		let partial = "";
		let streamedSinceAssistant = false;
		let initSessionId: string | undefined;
		let resultSessionId: string | undefined;
		let final: string | undefined;
		let terminalError: string | undefined;

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
				// Review asks for dontAsk, but `--sandbox read-only` in argv is the real boundary: another
				// restricting mode is not a downgrade, and only auto-approval means the request was
				// ignored. Both paths fail closed when the mode is missing, exactly like explain/btw.
				const escalated = event.permissionMode === "bypassPermissions" || event.permissionMode === "always-approve";
				if (inspect ? typeof event.permissionMode !== "string" || escalated : event.permissionMode !== "bypassPermissions") {
					throw new Error(
						`Grok did not apply the required ${inspect ? "restricted" : "bypassPermissions"} mode; check Grok policy/configuration.`,
					);
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
			if ((isAdvisor || isBtw || (inspect && request.reportReviewTools)) && event.type === "assistant" && Array.isArray(message?.content)) {
				for (const block of message.content as Array<{ type?: unknown; name?: unknown; text?: unknown }>) {
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

		const finished = await finishCliAttempt(child, attempt, "Grok", handleLine);
		const code = finished.code!;
		const stopped = stoppedCliOutcome("Grok", attempt, finished, diagnostics,
			`Grok timed out ${timeoutVerb}. Run \`/bro doctor\` for setup help.`, partial);
		if (stopped) return stopped;
		const partialText = partial ? { partialText: partial } : {};
		if (terminalError) return { status: "failure", message: withDoctor(terminalError), ...partialText };
		if (code !== 0) return { status: "failure", message: cliExitFailure("Grok", action, diagnostics.stderr), ...partialText };
		if (final === undefined) {
			return { status: "failure", message: withDoctor(`Grok exited without a terminal result event${diagnostics.stderr.trim() ? `: ${diagnostics.stderr.trim()}` : "."}`), ...partialText };
		}
		const text = final.trim();
		if (!text) return { status: "failure", message: withDoctor(emptyTextMessage), ...partialText };
		if (!isBtw) return { status: "success", text };
		const continuation = checkedBtwContinuation("Grok", request.continuation,
			{ init: initSessionId, result: resultSessionId });
		if ("error" in continuation)
			return { status: "failure", message: withDoctor(continuation.error), ...partialText };
		return { status: "success", text, continuation };
	} finally {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
		await rm(promptDirectory, { recursive: true, force: true });
	}
}
