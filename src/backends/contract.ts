import { stripVTControlCharacters } from "node:util";
import type { createAgentSession } from "@earendil-works/pi-coding-agent";

export type BackendFeature = "explain" | "show" | "btw" | "advisor" | "review";
export type BackendAccess = "restricted" | "workspace-full";

export type AgySelection = { model: string; effort?: "low" | "medium" | "high" };
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const GROK_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export const MUSE_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const PI_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type BackendSelection =
	| ({ backend?: "agy" } & AgySelection)
	| { backend: "claude"; model: string; effort?: (typeof CLAUDE_EFFORTS)[number] }
	| { backend: "grok"; model: string; effort?: (typeof GROK_EFFORTS)[number] }
	| { backend: "codex"; model: string; effort?: (typeof CODEX_EFFORTS)[number] }
	| { backend: "muse"; model: string; effort?: (typeof MUSE_EFFORTS)[number] }
	| { backend: "pi"; model: string; effort?: (typeof PI_EFFORTS)[number] };
export type BackendContinuation = { id: string };
export type BackendProgress = { kind: "text"; text: string } | { kind: "activity"; label: string; timestamp: number; tool?: string };
export type BackendOnProgress = (progress: BackendProgress) => void;

/** BTW reports a tool name/type, not a command, argument, or assistant message.
 * All six adapters use this extraction before events cross into the UI. */
export function btwToolName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	// Restrict to the initial identifier. Agy may supply "Read /path" (or
	// "Read(/path)"); neither should expose the path in a status hint.
	return /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(
		stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim(),
	)?.[0];
}

export type BackendRequest = {
	feature: BackendFeature;
	prompt: string;
	access: BackendAccess;
	cwd?: string; // required for workspace-full
	continuation?: BackendContinuation;
	/** Opt-in tool-only activity for Grill on the review path; Guided Review stays unchanged. */
	reportReviewTools?: boolean;
};

export type BackendOutcome =
	| { status: "success"; text: string; continuation?: BackendContinuation }
	| { status: "failure" | "cancelled" | "timeout"; message: string; partialText?: string; continuationExpired?: true };

export type BackendExecuteOptions = {
	// Injectable for offline tests only -- production always uses the defaults below.
	killEscalationMs?: number;
	deadlineMs?: number;
	// Injectable for offline tests only: stands in for the SDK's createAgentSession so the Pi adapter's
	// setup, cancellation, timeout and terminal-verification paths can be exercised without a model.
	piCreateSession?: typeof createAgentSession;
};
