import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDoctor } from "../util.ts";
import { checkedBtwContinuation, cliExitFailure, finishCliAttempt, startCliAttempt, stoppedCliOutcome } from "./cli-process.ts";
import { btwToolName, type BackendOnProgress, type BackendOutcome, type BackendRequest } from "./contract.ts";

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

export async function executeMuse(
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
	const timeoutVerb = request.feature === "review" ? "during the guided review request" : isAdvisor ? "during the advisor consultation" : isBtw ? "during the side conversation" : "while simplifying the response";
	const emptyTextMessage = request.feature === "review" ? "Muse returned no response for Guided Review." : isAdvisor ? "Muse returned no advice." : isBtw ? "Muse returned no answer for the side question." : "Muse returned no final explanation.";

	if (signal.aborted) return { status: "cancelled", message: "Canceled." };
	const promptDirectory = await mkdtemp(join(tmpdir(), "pi-bro-muse-"));
	let runDirectory: string | undefined;

	try {
		if (signal.aborted) return { status: "cancelled", message: "Canceled." };
		const promptFile = join(promptDirectory, "prompt.txt");
		await writeFile(promptFile, request.prompt, { encoding: "utf8", mode: 0o600 });
		if (!full && !isBtw && !inspect) runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
		if (signal.aborted) return { status: "cancelled", message: "Canceled." };
		const workspace = runDirectory ?? request.cwd!;

		const args = [
			"exec",
			"--json",
			"--provider", "meta",
			"--workspace", workspace,
			...(!isBtw ? ["--no-session-log"] : []),
			...(full ? ["--yolo"] : ["--disable-approval", "--disable-write", "--disable-shell"]),
			...(inspect ? ["--disable-web-tools", "--no-foreign-personal-context"] : []),
			...(isBtw && request.continuation ? ["--session-id", request.continuation.id] : []),
			"--model", selection.model,
			...(selection.effort ? ["--reasoning-effort", selection.effort] : []),
			"--prompt-file", promptFile,
		];

		const { child, attempt, diagnostics } = startCliAttempt("muse", args, {
			cwd: workspace,
			stdio: ["ignore", "pipe", "pipe"] }, signal, deadlineMs, killEscalationMs);

		let partial = "";
		let rootCommandId: string | undefined;
		let rootRunId: string | undefined;
		let sessionId: string | undefined;
		let final: string | undefined;
		let sawTerminal = false;
		let terminalError: string | undefined;

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

			if (isAdvisor || isBtw || (inspect && request.reportReviewTools)) {
				if (envelope.payload_type === "tool.result") {
					const facts = payload?.correlation_facts as { tool_name?: unknown } | undefined;
					const toolName = typeof facts?.tool_name === "string" && facts.tool_name ? facts.tool_name : "tool";
					const candidate = [payload?.text, payload?.command, payload?.path, payload?.file_path, payload?.query]
						.find((v) => typeof v === "string" && v.trim());
					const preview = typeof candidate === "string" ? candidate.replace(/\s+/g, " ").trim() : "";
					const tool = btwToolName(toolName);
					const label = (isBtw || (inspect && request.reportReviewTools)) ? tool : `${toolName}${preview ? ` ${preview}` : ""}`;
					if (label) onProgress?.({ kind: "activity", label, timestamp: Date.now(), ...(tool ? { tool } : {}) });
				} else if (isAdvisor && envelope.payload_type === "task.lifecycle.status") {
					const event = payload?.event as { message?: unknown } | undefined;
					if (typeof event?.message === "string" && event.message.trim()) {
						onProgress?.({ kind: "activity", label: event.message.trim(), timestamp: Date.now() });
					}
				}
			}
			if (!isAdvisor && isRoot && envelope.payload_type === "run.output.delta") {
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

		const finished = await finishCliAttempt(child, attempt, "Muse", handleLine);
		const code = finished.code!;
		const stopped = stoppedCliOutcome("Muse", attempt, finished, diagnostics,
			`Muse timed out ${timeoutVerb}. Run \`/bro doctor\` for setup help.`, partial);
		if (stopped) return stopped;
		const partialText = partial ? { partialText: partial } : {};
		if (terminalError) return { status: "failure", message: withDoctor(terminalError), ...partialText };
		if (code !== 0) return { status: "failure", message: cliExitFailure("Muse", action, diagnostics.stderr), ...partialText };
		if (!sawTerminal) {
			return { status: "failure", message: withDoctor(`Muse exited without a terminal result event${diagnostics.stderr.trim() ? `: ${diagnostics.stderr.trim()}` : "."}`), ...partialText };
		}
		const text = final?.trim();
		if (!text) return { status: "failure", message: withDoctor(emptyTextMessage), ...partialText };
		if (!isBtw) return { status: "success", text };
		const continuation = checkedBtwContinuation("Muse", request.continuation, { id: sessionId });
		if ("error" in continuation)
			return { status: "failure", message: withDoctor(continuation.error), ...partialText };
		return { status: "success", text, continuation };
	} finally {
		if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
		await rm(promptDirectory, { recursive: true, force: true });
	}
}
