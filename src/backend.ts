import { executeAgy } from "./backends/agy.ts";
import { executeClaude } from "./backends/claude.ts";
import { DEFAULT_KILL_ESCALATION_MS } from "./backends/cli-process.ts";
import { executeCodex } from "./backends/codex.ts";
import {
	CLAUDE_EFFORTS, CODEX_EFFORTS, GROK_EFFORTS, MUSE_EFFORTS, PI_EFFORTS,
	type BackendAccess, type BackendExecuteOptions, type BackendFeature, type BackendOnProgress,
	type BackendOutcome, type BackendProgress, type BackendRequest, type BackendSelection,
} from "./backends/contract.ts";
import { executeGrok } from "./backends/grok.ts";
import { executeMuse } from "./backends/muse.ts";
import { executePi, getPiHostContext, type PiHostContext } from "./backends/pi.ts";

export * from "./backends/contract.ts";
export { agyFailureMessage, agySelection, advisorFlagErrorHint, parseBtwAgyLine } from "./backends/agy.ts";
export { beginAttempt, frameStdoutLines, MAX_STDOUT_LINE_CHARS } from "./backends/cli-process.ts";
export { GROK_RESTRICTED_PREFIX } from "./backends/grok.ts";
export {
	bridgePiRuntimeForCatalog, getPiHostContext, piEffectiveEffort, piPhysicalModel,
	piScopedThinkingLevel, piToolAllowlist, setPiHostContext, splitPiModel,
	type PiHostContext, type PiPhysicalModel,
} from "./backends/pi.ts";
export { verifyCliSubscription } from "./cli-auth.ts";

// Shared internal execution boundary for explain, show, btw, advisor, and review.
// This implements docs/plans/2026-09-22-shared-backend-design.md across all supported backends
// (Agy, Claude Code, Grok, Codex, Muse, and the in-process Pi SDK): it owns model selection, process
// (or session) invocation, progress/outcome normalization, continuation, and single-attempt cleanup.
// Feature code keeps retries, UI, source/session capture and settings.
// For Guided Review (`feature: "review"`), Claude, Muse, and Pi enforce strict file-only inspection;
// Agy, Grok, and Codex run inside their own sandbox with shell available, and the UI owns telling
// the user via `reviewBackendNotice`.

// Per-backend truth, not one shared sentence: Codex and Grok have a read-only sandbox, Agy's
// sandbox only restricts terminal commands and still lets it write inside the project. Kept short
// enough that the whole notice fits the review window's advisory rows on a narrow terminal.
export function reviewBackendNotice(backend: "agy" | "claude" | "grok" | "codex" | "muse" | "pi"): string | undefined {
	if (backend === "claude" || backend === "muse" || backend === "pi") return undefined;
	const sandbox = backend === "agy" ? "sandboxed shell (project writes allowed)" : "sandboxed shell in a read-only sandbox";
	return `Guided Review on ${backend} uses ${sandbox}, not strict file-only inspection. Claude, Muse, or Pi is recommended for untrusted PRs.`;
}
// One default deadline table for every adapter: workspace-full, Guided Review and the advisor get
// the long bound; btw the middle one; explain/show the short one.
export const REVIEW_DEADLINE_MS = 610_000;
export function backendDeadlineMs(feature: BackendFeature, access: BackendAccess): number {
	if (access === "workspace-full" || feature === "review") return REVIEW_DEADLINE_MS;
	return feature === "btw" ? 130_000 : 125_000;
}

/** Validate every backend's model/effort pair before an adapter accesses it. */
function invalidModelEffortSelection(
  pair: { model: unknown; effort?: unknown }, allowedEfforts: readonly string[],
): boolean {
  return typeof pair.model !== "string" || !pair.model.trim() ||
    (pair.effort !== undefined && (typeof pair.effort !== "string" || !allowedEfforts.includes(pair.effort)));
}

// Single-attempt executor shared by all features. Never retries; never spawns a pre-aborted
// request; on cancellation, host deadline, or a protocol failure, stops the whole POSIX process
// group (SIGTERM, then SIGKILL after a bounded grace period) before resolving. `options` is for
// offline tests only -- production callers never override the deadline or kill-escalation delay.
async function executeOnce(
	request: BackendRequest,
	selection: BackendSelection,
	signal: AbortSignal,
	onProgress?: BackendOnProgress,
	options?: BackendExecuteOptions,
	host?: PiHostContext,
): Promise<BackendOutcome> {
	if (
		(request.access === "workspace-full" && !request.cwd?.trim()) ||
		(request.feature === "advisor" && request.access !== "workspace-full") ||
		(request.feature === "review" && (request.access !== "restricted" || !request.cwd?.trim())) ||
		((request.feature === "explain" || request.feature === "show") && request.access !== "restricted") ||
		(request.feature !== "btw" && request.continuation)
	) return { status: "failure", message: "Unsupported execution request: check feature access, workspace cwd and continuation." };
	const backend = (selection as { backend?: unknown }).backend;
	// An explicit tag guard: a stale or corrupt runtime tag must fail, never fall through to Agy.
	if (backend !== undefined && backend !== "agy" && backend !== "claude" && backend !== "grok" && backend !== "codex" && backend !== "muse" && backend !== "pi") {
		return { status: "failure", message: `Unknown backend ${JSON.stringify(backend)}: pick Agy, Claude, Grok, Codex, Muse or Pi in \`/bro config\`.` };
	}
	// Review requires cwd above; restricted BTW also keeps native external sessions in the caller's workspace.
	if (request.feature === "btw" && !request.cwd?.trim() &&
		(backend === "codex" || backend === "muse" || backend === "grok" || backend === "claude")) {
		return { status: "failure", message: "Unsupported execution request: check feature access, workspace cwd and continuation." };
	}
	const killEscalationMs = options?.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;
	const deadlineMs = options?.deadlineMs ?? backendDeadlineMs(request.feature, request.access);
	if (selection.backend === "pi") {
		// Same shape checks every other adapter performs, so a corrupt runtime tag fails as an outcome
		// instead of throwing a TypeError out of execute().
		if (invalidModelEffortSelection(selection, PI_EFFORTS)) {
			return { status: "failure", message: "Unsupported Pi selection: check the model (<provider>/<id>) and effort (minimal, low, medium, high, xhigh or max)." };
		}
		return executePi(request, selection, signal, onProgress, killEscalationMs, deadlineMs, host ?? getPiHostContext(), options?.piCreateSession);
	}
	if (selection.backend === "codex") {
		// Codex btw always runs (and resumes) in the caller's workspace, even restricted.

		if (invalidModelEffortSelection(selection, CODEX_EFFORTS)) {
			return { status: "failure", message: "Unsupported Codex selection: check the model and effort (low, medium, high or xhigh)." };
		}
		return executeCodex(request, selection, signal, onProgress, killEscalationMs, deadlineMs);
	}
	if (selection.backend === "muse") {
		// Muse btw always runs (and resumes) in the caller's workspace, even restricted.

		if (invalidModelEffortSelection(selection, MUSE_EFFORTS)) {
			return { status: "failure", message: "Unsupported Muse selection: check the model and effort (minimal, low, medium, high, xhigh or max)." };
		}
		return executeMuse(request, selection, signal, onProgress, killEscalationMs, deadlineMs);
	}
	if (selection.backend === "grok") {
		// Grok btw always runs (and resumes) in the caller's workspace, even restricted.

		if (invalidModelEffortSelection(selection, GROK_EFFORTS)) {
			return { status: "failure", message: "Unsupported Grok selection: check the model and effort (low, medium, high or xhigh)." };
		}
		return executeGrok(request, selection, signal, onProgress, killEscalationMs, deadlineMs);
	}
	if (selection.backend === "claude") {
		// Claude btw always runs (and resumes) in the caller's workspace, even restricted.

		if (invalidModelEffortSelection(selection, CLAUDE_EFFORTS)) {
			return { status: "failure", message: "Unsupported Claude selection: check the model and effort (low, medium, high, xhigh or max)." };
		}
		return executeClaude(request, selection, signal, onProgress, killEscalationMs, deadlineMs);
	}
	return executeAgy(request, selection, signal, onProgress, killEscalationMs, deadlineMs);
}

// The extension owns only operations that are still running. This covers both
// pre-spawn CLI preparation and in-process Pi sessions without a second process
// registry. Shutdown aborts the request signal and awaits normal adapter cleanup.
const activeBackendExecutions = new Map<AbortController, Promise<BackendOutcome>>();

export async function stopActiveBackendExecutions(): Promise<void> {
	const active = [...activeBackendExecutions];
	for (const [controller] of active) controller.abort();
	const finished = await Promise.allSettled(active.map(([, result]) => result));
	for (const result of finished) if (result.status === "rejected") throw result.reason;
}

export function execute(
	request: BackendRequest,
	selection: BackendSelection,
	signal: AbortSignal,
	onProgress?: BackendOnProgress,
	options?: BackendExecuteOptions,
	host?: PiHostContext,
): Promise<BackendOutcome> {
	const controller = new AbortController();
	const combinedSignal = AbortSignal.any([signal, controller.signal]);
	const pending = executeOnce(request, selection, combinedSignal, onProgress, options, host);
	activeBackendExecutions.set(controller, pending);
	return pending.finally(() => { activeBackendExecutions.delete(controller); });
}

/** Coalesce text-only progress without leaving a timer after cancellation.
 * Shared by Explain/Show and BTW, which expose the same 75 ms UI contract. */
export function textProgressThrottle(signal: AbortSignal, onProgress?: (text: string) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: string | undefined;
  const receive = onProgress ? (progress: BackendProgress) => {
    if (progress.kind !== "text") return;
    latest = progress.text;
    if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        if (!signal.aborted && latest !== undefined) onProgress(latest);
      }, 75);
    }
  } : undefined;
  return { receive, dispose: () => { if (timer) clearTimeout(timer); } };
}

// Thin presentation-boundary wrapper around the shared backend: coalesces raw text progress to the
// existing 75ms cadence and translates the backend's tagged outcome back into this function's
// existing throw-on-failure contract.
export async function runBackendText(
	prompt: string,
	selection: BackendSelection,
	signal: AbortSignal,
	onProgress?: (text: string) => void,
	feature: "explain" | "show" = "explain",
): Promise<string> {
	const progress = textProgressThrottle(signal, onProgress);

	try {
		const outcome = await execute({ feature, prompt, access: "restricted" }, selection, signal, progress.receive);
		if (outcome.status === "success") return outcome.text;
		throw new Error(outcome.message);
	} finally {
		progress.dispose();
	}
}

