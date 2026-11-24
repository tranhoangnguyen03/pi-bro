import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliChildAuth, verifyCliSubscription } from "../cli-auth.ts";
import { errorMessage, withDoctor } from "../util.ts";
import { checkedBtwContinuation, cliExitFailure, finishCliAttempt, startCliAttempt, stoppedCliOutcome } from "./cli-process.ts";
import { btwToolName, type BackendOnProgress, type BackendOutcome, type BackendRequest } from "./contract.ts";

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

export async function executeCodex(
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
	const action = inspect ? "complete the guided review request" : isAdvisor ? "complete the advisor consultation" : isBtw ? "answer the side question" : "simplify the response";
	const timeoutVerb = inspect ? "during the guided review request" : isAdvisor ? "during the advisor consultation" : isBtw ? "during the side conversation" : "while simplifying the response";
	const emptyTextMessage = inspect ? "Codex returned no response for Guided Review." : isAdvisor ? "Codex returned no advice." : isBtw ? "Codex returned no answer for the side question." : "Codex returned no final explanation.";

	if (signal.aborted) return { status: "cancelled", message: "Canceled." };
	const runDirectory = full || isBtw || inspect ? undefined : await mkdtemp(join(tmpdir(), "pi-bro-"));
	if (signal.aborted) {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
		return { status: "cancelled", message: "Canceled." };
	}

	try {
		let auth: ReturnType<typeof resolveCliChildAuth>;
		try { auth = resolveCliChildAuth("codex"); }
		catch (error) { return { status: "failure", message: errorMessage(error) }; }
		if (auth.subscription) {
			const check = await verifyCliSubscription("codex", auth.env, signal, killEscalationMs, deadlineMs, runDirectory ?? request.cwd);
			if (check) return check;
		}
		if (signal.aborted) return { status: "cancelled", message: "Canceled." };
		const permissionArgs = full ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "read-only"];
		const resume = isBtw && request.continuation;
		const args = [
			"exec",
			...(auth.subscription ? ["-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"'] : []),
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

		const { child, attempt, diagnostics } = startCliAttempt("codex", args, {
			cwd: runDirectory ?? request.cwd,
			stdio: ["pipe", "pipe", "pipe"], env: auth.env }, signal, deadlineMs, killEscalationMs);

		let partial = "";
		let threadId: string | undefined;
		let final: string | undefined;
		let sawTerminal = false;
		let terminalError: string | undefined;

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
			if ((isAdvisor || isBtw || (inspect && request.reportReviewTools)) && (event.type === "item.started" || event.type === "item.completed")) {
				const tool = item?.type !== "agent_message" && item?.type !== "reasoning" ? btwToolName(item?.type) : undefined;
				const activity = (isBtw || (inspect && request.reportReviewTools)) ? tool : codexActivityFromEvent(event);
				if (activity) onProgress?.({ kind: "activity", label: activity, timestamp: Date.now(), ...(tool ? { tool } : {}) });
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

		const finished = await finishCliAttempt(child, attempt, "Codex", handleLine);
		const code = finished.code!;
		const stopped = stoppedCliOutcome("Codex", attempt, finished, diagnostics,
			`Codex timed out ${timeoutVerb}. Run \`/bro doctor\` for setup help.`, partial);
		if (stopped) return stopped;
		const partialText = partial ? { partialText: partial } : {};
		if (terminalError) return { status: "failure", message: withDoctor(terminalError), ...partialText };
		if (code !== 0) return { status: "failure", message: cliExitFailure("Codex", action, diagnostics.stderr), ...partialText };
		if (!sawTerminal) {
			return { status: "failure", message: withDoctor(`Codex exited without a terminal result event${diagnostics.stderr.trim() ? `: ${diagnostics.stderr.trim()}` : "."}`), ...partialText };
		}
		const text = final?.trim();
		if (!text) return { status: "failure", message: withDoctor(emptyTextMessage), ...partialText };
		if (!isBtw) return { status: "success", text };
		const continuation = checkedBtwContinuation("Codex", request.continuation, { id: threadId });
		if ("error" in continuation)
			return { status: "failure", message: withDoctor(continuation.error), ...partialText };
		return { status: "success", text, continuation };
	} finally {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
	}
}
