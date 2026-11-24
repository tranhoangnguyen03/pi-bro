import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
// clampThinkingLevel and the Model type are the only things Bro needs from pi-ai, which is the
// lower-level LLM engine pi-coding-agent is built on. Bro imports it directly, so it is declared as
// a peer dependency alongside pi-coding-agent and pi-tui rather than relied on transitively.
import { clampThinkingLevel, type Model as PiAiModel } from "@earendil-works/pi-ai";
import { errorMessage, withDoctor } from "../util.ts";
import { btwToolName, type BackendAccess, type BackendFeature, type BackendOnProgress, type BackendOutcome, type BackendRequest } from "./contract.ts";

// ----------------------------------------------------------------------------
// In-process Pi SDK backend ("pi")
//
// Runs a real AgentSession inside this process instead of spawning a CLI. It is deliberately
// isolated from the host session: its own resource loader (no extensions, skills, prompt
// templates, themes or context files), its own SettingsManager with auto-retry and compaction
// switched off in memory, and an explicit tool allowlist per feature. The host model registry is
// rehydrated into a fresh ModelRuntime so in-memory provider registrations and runtime keys
// (e.g. OAuth shorthand) still resolve, exactly as a spawned subagent would.
// ----------------------------------------------------------------------------

// Host-side dependencies the CLI adapters get for free from their process environment. Optional so
// offline tests (and callers with no registry) still compile; a missing registry fails loudly at
// model-resolution time rather than silently in the registry.
// The host facts the in-process Pi backend needs. `scopedModels` carries a `provider/model:high`
// pattern's thinking level, which createAgentSession cannot recover on its own, and
// `isProjectTrusted` decides whether the workspace's `.pi/settings.json` may apply.
export type PiHostContext = Pick<ExtensionContext, "modelRegistry" | "scopedModels"> & {
	model?: ExtensionContext["model"];
	isProjectTrusted?: () => boolean;
};

// The most recent host context Bro saw (set by /bro commands and the advisor tool). A module-level
// binding, like pi-flow-external's execution context, keeps the host registry reachable from the
// shared feature helpers without threading it through every call site; Bro runs one host session
// at a time.
let currentPiHost: PiHostContext | undefined;

export function setPiHostContext(host: PiHostContext | undefined): void {
	currentPiHost = host;
}

export function getPiHostContext(): PiHostContext | undefined {
	return currentPiHost;
}

const PI_EXCLUDED_TOOLS = ["bro_advisor", "external_delegate", "external_workflow", "mcp__*"];

/** Tools a Pi session may use for a given feature/access pair. Empty means "no tools at all". */
export function piToolAllowlist(feature: BackendFeature, access: BackendAccess): { tools: string[]; excludeTools?: string[] } {
	if (feature === "advisor" || access === "workspace-full") {
		return { tools: ["read", "bash", "edit", "write"], excludeTools: [...PI_EXCLUDED_TOOLS] };
	}
	if (feature === "review") return { tools: ["read", "grep", "find", "ls"] };
	// explain, show, elevate and restricted btw only ever see the prompt.
	return { tools: [] };
}

// The thinking level a scoped model pattern asked for (e.g. "provider/model:high"), if any. Only
// used when the Bro effort is "default": an explicit Bro effort must win, because it is the user's
// current choice. Verified against the SDK: createAgentSession does not derive thinkingLevel from
// scopedModels, so a `:thinking` suffix would otherwise be silently dropped.
export function piScopedThinkingLevel(
	scoped: readonly { model: { provider: string; id: string }; thinkingLevel?: string }[] | undefined,
	providerId: string,
	modelId: string,
): string | undefined {
	return scoped?.find((entry) => entry.model.provider === providerId && entry.model.id === modelId)?.thinkingLevel;
}

/** The physical model a stored `pi` selection names, or undefined when it is unknown/virtual. */
export function piPhysicalModel(
	registry: PiHostContext["modelRegistry"] | ModelRuntime | undefined,
	providerId: string,
	modelId: string,
): PiPhysicalModel | undefined {
	if (!registry || !providerId || !modelId) return undefined;
	const model = "find" in registry ? registry.find(providerId, modelId) : registry.getModel(providerId, modelId);
	if (!model) return undefined;
	// Virtual models route to another model at request time; a spawned-style child needs a physical one.
	if ((model as { api?: string }).api === "pi-virtual") return undefined;
	return model as PiPhysicalModel;
}

/** Splits a stored Pi model string on the FIRST "/" only, so IDs containing slashes survive. */
export function splitPiModel(model: string): { providerId: string; modelId: string } | undefined {
	const separator = model.indexOf("/");
	if (separator <= 0 || separator === model.length - 1) return undefined;
	return { providerId: model.slice(0, separator), modelId: model.slice(separator + 1) };
}

// The shape both a Pi registry entry and a resolved scoped model present for effort clamping.
export type PiPhysicalModel = PiAiModel<string> | { reasoning?: boolean; thinkingLevelMap?: unknown };

// The requested and effective Pi effort for a model. "default" is resolved by the SDK from settings
// (and any scoped `:thinking` suffix), so it is reported as such rather than guessed at. Used by
// `/bro doctor` so its clamp claim is computed rather than assumed.
export function piEffectiveEffort(model: PiPhysicalModel | undefined, effort: string): string {
	if (!model) return effort;
	return piClampEffort(model, effort);
}

// Why a Pi attempt stopped, latched first-wins exactly like beginAttempt's StopCause.
type PiStopCause = "cancelled" | "timeout";

// The terminal stop reasons pi-ai can report. Anything other than "stop" means the turn did not
// finish normally, so it must not be reported as a complete answer. "toolUse" only appears on an
// intermediate turn, so a *final* assistant message carrying it is also incomplete.
const PI_INCOMPLETE_STOP_REASONS = new Set(["length", "pending", "deferred", "toolUse"]);

// Our own levels (plus "default") are a superset of pi-ai's, and "default" is resolved by the SDK
// from settings per model, so it cannot be clamped here.
function piClampEffort(model: PiPhysicalModel | undefined, effort: string): string {
	if (effort === "default" || !model) return effort;
	try {
		return clampThinkingLevel(model as never, effort as never) as string;
	} catch {
		return effort;
	}
}

// In-memory btw sessions, keyed by the session id handed back as a continuation id. Nothing here
// ever reaches the filesystem: btw side conversations must not appear in ~/.pi/agent/sessions.
const piBtwSessions = new Map<string, SessionEntry[]>();
const PI_BTW_SESSIONS_MAX = 20;

function rememberPiBtwSession(sessionId: string, entries: SessionEntry[]): void {
	piBtwSessions.delete(sessionId);
	piBtwSessions.set(sessionId, entries);
	while (piBtwSessions.size > PI_BTW_SESSIONS_MAX) {
		const oldest = piBtwSessions.keys().next().value;
		if (oldest === undefined) break;
		piBtwSessions.delete(oldest);
	}
}

function piErrorMessage(feature: BackendFeature, message: string): string {
	const action =
		feature === "review"
			? "complete the guided review request"
			: feature === "advisor"
				? "complete the advisor consultation"
				: feature === "btw"
					? "answer the side question"
					: "simplify the response";
	return `Pi could not ${action}: ${message}`;
}

function piTimeoutMessage(feature: BackendFeature, seconds: number): string {
	const during =
		feature === "review"
			? "during the guided review request"
			: feature === "advisor"
				? "during the advisor consultation"
				: feature === "btw"
					? "during the side conversation"
					: "while simplifying the response";
	return `Pi timed out ${during} after ${Math.round(seconds / 1000)}s. Run \`/bro doctor\` for setup help.`;
}

function piAssistantText(message: { content?: unknown }): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
		.join("")
		.trim();
}

/**
 * The Pi SDK asks for a ModelRuntime even when its physical model is explicit.
 * Bind every auth/model/stream read to the host's existing registry instead of
 * rebuilding a second provider from models.json. In particular, an on-disk edit
 * must never combine a host-old endpoint with a freshly read API key.
 *
 * The SDK runtime here only supplies agent/session mechanics; it does not own
 * credentials, source selection or refresh. No models.json is read by this child.
 */
async function bridgePiModelRuntime(host: PiHostContext | undefined, _agentDir: string): Promise<ModelRuntime> {
	const registry = host?.modelRegistry;
	if (!registry) throw new Error("The Pi host model registry is unavailable; reopen Bro from a live Pi session.");
	// The SDK requires a ModelRuntime, but it must not read an independent auth.json
	// or models.json. All real auth and model calls below delegate to the host.
	const credentials = {
		read: async () => undefined,
		list: async () => [],
		modify: async (): Promise<never> => { throw new Error("The Pi host owns credential writes."); },
		delete: async (): Promise<never> => { throw new Error("The Pi host owns credential deletion."); },
	};
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		refreshOnCreate: false,
	});
	const models = (provider?: string) => registry.getAll().filter((m) => !provider || m.provider === provider);
	const available = (provider?: string) => registry.getAvailable().filter((m) => !provider || m.provider === provider);
	// Use the same registry for the SDK's preflight, model lookup and final stream.
	// Resolving auth from provider alone is intentional: ModelRegistry.getProviderAuth()
	// is the public host API, and its underlying runtime still applies model-specific
	// headers and request overrides inside streamSimple().
	Object.assign(runtime, {
		getModel: (provider: string, id: string) => registry.find(provider, id),
		getModels: models,
		getAllModels: models,
		getAvailableSnapshot: () => available(),
		getAvailable: async (provider?: string) => available(provider),
		getProvider: (provider: string) => registry.getProvider(provider),
		getProviderAuthStatus: (provider: string) => registry.getProviderAuthStatus(provider),
		getAuth: async (modelOrProvider: string | { provider: string }) =>
			registry.getProviderAuth(typeof modelOrProvider === "string" ? modelOrProvider : modelOrProvider.provider),
		hasConfiguredAuth: (provider: string) => models(provider).some((model) => registry.hasConfiguredAuth(model)),
		checkAuth: async (provider: string) =>
			(await registry.getProviderAuth(provider)) ? { type: "api_key", source: "host registry" } : undefined,
		isUsingOAuth: (provider: string) => models(provider).some((model) => registry.isUsingOAuth(model)),
		streamSimple: (
			model: Parameters<ModelRuntime["streamSimple"]>[0],
			context: Parameters<ModelRuntime["streamSimple"]>[1],
			options: Parameters<ModelRuntime["streamSimple"]>[2],
		) => {
			// Neither another runtime nor child options may override the host's auth.
			const { apiKey: _key, env: _env, ...rest } = options ?? {};
			return registry.streamSimple(model, context, rest);
		},
	});
	return runtime;
}

/** The picker and the executor use this same host-backed model/auth view. */
export async function bridgePiRuntimeForCatalog(host: PiHostContext | undefined, agentDir: string): Promise<ModelRuntime> {
	return bridgePiModelRuntime(host, agentDir);
}

export async function executePi(
	request: BackendRequest,
	selection: { model: string; effort?: string },
	signal: AbortSignal,
	onProgress: BackendOnProgress | undefined,
	killEscalationMs: number,
	deadlineMs: number,
	host: PiHostContext | undefined,
	createSession: typeof createAgentSession = createAgentSession,
): Promise<BackendOutcome> {
	void killEscalationMs; // in-process: abort() is cooperative, there is no process group to kill
	const parts = splitPiModel(selection.model);
	if (!parts) return { status: "failure", message: piErrorMessage(request.feature, `\`${selection.model}\` is not a \`<provider>/<id>\` model.`) };

	const agentDir = getAgentDir();
	// Full-access features run in the caller's workspace; restricted explain/show have no workspace at all,
	// and btw runs in the workspace in both modes.
	const cwd = request.cwd ?? process.cwd();

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let unsubscribe: (() => void) | undefined;
	let stopCause: PiStopCause | undefined;
	let sawAgentEnd = false;
	let willRetry = false;
	let partial = "";

	// Settles the moment a stop is latched. Runtime preparation, session construction and the model
	// turn are all raced against it, so a cancellation or deadline is reported at the deadline instead
	// of after an uncooperative provider finally returns.
	let settleStop: (() => void) | undefined;
	const stopped = new Promise<void>((resolve) => {
		settleStop = resolve;
	});

	const stop = (cause: PiStopCause) => {
		if (stopCause) return; // latched: the first cause wins
		stopCause = cause;
		settleStop?.();
		void session?.abort();
	};
	// The stop outcome for the active cause, or undefined when this attempt is still running.
	const stoppedOutcome = (): BackendOutcome | undefined => {
		if (stopCause === "cancelled") return { status: "cancelled", message: "Canceled.", ...(partial ? { partialText: partial } : {}) };
		if (stopCause === "timeout") return { status: "timeout", message: piTimeoutMessage(request.feature, deadlineMs), ...(partial ? { partialText: partial } : {}) };
		return undefined;
	};
	// Same, for the sites that have already established a cause was latched.
	const latchedOutcome = (): BackendOutcome => stoppedOutcome() ?? { status: "failure", message: piErrorMessage(request.feature, "the attempt stopped without a cause.") };
	const onAbort = () => stop("cancelled");
	signal.addEventListener("abort", onAbort, { once: true });
	// An abort signal that is already aborted never fires its listeners, so latch it explicitly.
	if (signal.aborted) onAbort();
	// The deadline covers runtime preparation too: it is real (if small) I/O, and a hanging credential
	// lookup must not hold a cancelled request forever.
	// Deliberately NOT unref'd, unlike the CLI adapters' timers: there the child process keeps the
	// event loop alive, but here an awaited in-process promise is not a handle, so an unref'd timer
	// could let the loop drain and the timeout silently never fire. It is cleared in `finally`, so it
	// cannot outlive the attempt.
	const deadlineTimer = setTimeout(() => stop("timeout"), deadlineMs);

	try {
		if (stopCause) return latchedOutcome();

		// Resolve the physical model before paying for session construction, inside the latch so a slow
		// or throwing host credential lookup becomes an ordinary outcome rather than a rejection.
		const modelRuntime = await Promise.race([bridgePiModelRuntime(host, agentDir), stopped.then(() => undefined)]);
		if (!modelRuntime) return latchedOutcome();
		// Use the effective host model for its exact identity, endpoint and metadata.
		// The SDK child uses the same host model, auth resolver and streaming transport.
		const model = host?.modelRegistry?.find(parts.providerId, parts.modelId);
		if (!model) {
			return { status: "failure", message: piErrorMessage(request.feature, `model \`${selection.model}\` is not in your Pi model catalog. Run \`/bro doctor\`.`) };
		}
		if ((model as { api?: string }).api === "pi-virtual") {
			return { status: "failure", message: piErrorMessage(request.feature, `\`${selection.model}\` is a virtual model; choose a physical model in \`/bro config\`.`) };
		}

		// Guided Review runs on an untrusted PR checkout, so its `.pi/settings.json` must never be merged.
		// Elsewhere the host's own trust decision decides: a repo the user declined to trust must not get
		// to steer thinking levels, budgets, transport or the shell the bash tool runs with.
		// A host that predates isProjectTrusted() (or a test stub) falls back to Pi's own default.
		const hostTrustsProject = (() => {
			try { return host?.isProjectTrusted?.() ?? true; } catch { return false; }
		})();
		// An in-memory manager seeded from the effective on-disk settings, rather than one that keeps
		// reading them. It gives two things a file-backed manager cannot:
		//   - the single-attempt and no-warming overrides cannot be discarded by a later reload(), and
		//   - nothing this child does can write the user's global settings.json.
		// cacheWarming must be set here: getCacheWarmingMode() reads globalSettings directly, so an
		// applyOverrides({cacheWarming}) would be ignored, and the warmer replays the prompt (another
		// paid request) once a prompt-cache TTL is close to expiring.
		const projectTrusted = request.feature !== "review" && hostTrustsProject;
		const baseSettings = SettingsManager.create(cwd, agentDir, { projectTrusted }).getSettings();
		const settingsManager = SettingsManager.inMemory({
			...baseSettings,
			retry: { ...baseSettings.retry, enabled: false, provider: { ...baseSettings.retry?.provider, maxRetries: 0 } },
			compaction: { ...baseSettings.compaction, enabled: false },
			cacheWarming: "off",
		}, { projectTrusted });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			disabledBuiltinExtensions: ["mcp", "codemode"],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});

		// reload() re-reads settings from disk into the resource loader; the in-memory manager above is
		// unaffected, so the overrides survive it.
		// A deadline that fires during reload or session construction must stop the attempt here: the
		// timer has already latched (and abort() was a no-op with no session yet), and a timeout does
		// not set signal.aborted, so checking the latch is the only thing that prevents a paid model
		// request from starting after its deadline.
		await Promise.race([resourceLoader.reload(), stopped]);
		if (stopCause) return latchedOutcome();

		// btw resumes the retained in-memory transcript; every other feature starts fresh. A thread whose
		// retained entries are gone must fail loudly rather than silently answering without its history.
		const continuationId = request.feature === "btw" ? request.continuation?.id : undefined;
		// Bro keeps exactly one side thread, so a btw turn with no continuation id means the previous
		// thread was reset (backend/mode/preferences change or /clear) and its retained transcript is now
		// unreachable. Drop it instead of holding the entries until the cap evicts them.
		if (request.feature === "btw" && !continuationId) piBtwSessions.clear();
		const retained = continuationId ? piBtwSessions.get(continuationId) : undefined;
		if (continuationId && !retained) {
			// Tagged so the caller can drop the dead id: without that, every later turn resends it and
			// the thread stays stuck until the user clears it.
			return { status: "failure", continuationExpired: true, message: piErrorMessage(request.feature, "the side conversation expired before it could be continued; ask the question again to start a fresh thread.") };
		}
		const sessionManager = retained && continuationId
			? SessionManager.inMemory(cwd, { id: continuationId }, retained)
			: SessionManager.inMemory(cwd);
		const allowlist = piToolAllowlist(request.feature, request.access);
		// An explicit Bro effort wins; with "default" the SDK resolves the level from settings, but it
		// cannot see a scoped pattern's `:thinking` suffix, so carry that through ourselves.
		const thinkingLevel = selection.effort && selection.effort !== "default"
			? selection.effort
			: piScopedThinkingLevel(host?.scopedModels, parts.providerId, parts.modelId);

		const sessionPromise = createSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
			...(allowlist.tools.length ? { tools: allowlist.tools } : { noTools: "all" as const }),
			...(allowlist.excludeTools ? { excludeTools: allowlist.excludeTools } : {}),
			...(thinkingLevel ? { thinkingLevel: thinkingLevel as NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"] } : {}),
		});
		const created = await Promise.race([sessionPromise, stopped.then(() => undefined)]);
		if (!created) {
			// The latch won the race, but construction may still resolve afterwards. That session is
			// never prompted and cannot be disposed through `session` below, so tear it down here.
			void sessionPromise.then(
				(late) => { try { late.session.dispose(); } catch { /* best-effort teardown */ } },
				() => { /* construction failed; nothing to dispose */ },
			);
			return latchedOutcome();
		}
		session = created.session;
		if (stopCause) {
			// The attempt was stopped while the session was being built, so abort it directly; the latch
			// already fired its own abort before this session existed.
			void session.abort();
			return latchedOutcome();
		}

		unsubscribe = session.subscribe((event) => {
			if (stopCause) return;
			if (event.type === "agent_end") {
				sawAgentEnd = true;
				// The SDK reports its own retry decision here; a retrying turn must never count as settled.
				willRetry = (event as { willRetry?: boolean }).willRetry === true;
			} else if (event.type === "message_update" && event.message.role === "assistant") {
				const text = piAssistantText(event.message);
				if (text) {
					partial = text;
					onProgress?.({ kind: "text", text });
				}
			} else if (event.type === "tool_execution_start" && onProgress) {
				const tool = btwToolName(event.toolName);
				const label = request.feature === "btw" || (request.feature === "review" && request.reportReviewTools) ? tool : event.toolName;
				if (label) onProgress({ kind: "activity", label, timestamp: Date.now(), ...(tool ? { tool } : {}) });
			}
		});

		// Race the turn against the stop latch so a non-cooperative provider cannot hold the caller.
		//
		// Racing alone is not enough: session.prompt() awaits an auth check before any run exists, and
		// abort() only latches when a run is already active (the SDK's _startRun then clears that flag).
		// A stop latched during that window would otherwise be forgotten and the request would still go
		// out. preflightResult fires once the run is about to start, so re-issuing abort there lands on
		// the SDK's own agent_start cancellation path and stops the first request.
		const prompted = Promise.resolve(
			session.prompt(request.prompt, {
				source: "extension",
				preflightResult: (disposition) => {
					if (disposition === "started" && stopCause) void session?.abort();
				},
			}),
		).then(() => "done" as const);
		await Promise.race([prompted, stopped.then(() => "stopped" as const)]);
		if (stopCause) return latchedOutcome();

		// pi-ai encodes provider failures as a final assistant turn rather than throwing.
		const messages = session.messages;
		const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
		const stopReason = (lastAssistant as { stopReason?: string } | undefined)?.stopReason;
		if (stopReason === "error" || stopReason === "aborted") {
			const detail = (lastAssistant as { errorMessage?: string } | undefined)?.errorMessage ?? `Pi turn did not complete (stopReason: ${stopReason}).`;
			return { status: "failure", message: withDoctor(piErrorMessage(request.feature, detail)), ...(partial ? { partialText: partial } : {}) };
		}
		// A truncated or unfinished turn is not a complete answer; its text is partial at best.
		if (stopReason !== undefined && PI_INCOMPLETE_STOP_REASONS.has(stopReason)) {
			return { status: "failure", message: withDoctor(piErrorMessage(request.feature, `Pi stopped before finishing (stopReason: ${stopReason}).`)), ...(partial ? { partialText: partial } : {}) };
		}
		// Success needs an observed agent_end with no pending retry: without one this code cannot
		// confirm the turn settled, and a retrying turn is still inside Bro's single attempt.
		if (!sawAgentEnd) return { status: "failure", message: withDoctor(piErrorMessage(request.feature, "the turn ended without an agent_end event.")), ...(partial ? { partialText: partial } : {}) };
		if (willRetry) return { status: "failure", message: withDoctor(piErrorMessage(request.feature, "the turn ended but the SDK still intended to retry.")), ...(partial ? { partialText: partial } : {}) };
		const text = lastAssistant ? piAssistantText(lastAssistant) : "";
		if (!text) return { status: "failure", message: withDoctor(piErrorMessage(request.feature, "Pi returned no final explanation.")), ...(partial ? { partialText: partial } : {}) };

		// btw continuation uses the in-memory session id, which never touches disk.
		if (request.feature === "btw") {
			rememberPiBtwSession(session.sessionId, session.sessionManager.getEntries());
			return { status: "success", text, continuation: { id: session.sessionId } };
		}
		return { status: "success", text };
	} catch (error) {
		const stoppedResult = stoppedOutcome();
		if (stoppedResult) return stoppedResult;
		return { status: "failure", message: withDoctor(piErrorMessage(request.feature, errorMessage(error))), ...(partial ? { partialText: partial } : {}) };
	} finally {
		signal.removeEventListener("abort", onAbort);
		clearTimeout(deadlineTimer);
		try {
			unsubscribe?.();
		} catch {
			// A listener that throws during teardown must not mask the real outcome.
		}
		try {
			session?.dispose();
		} catch {
			// dispose() is best-effort; a failure here cannot change the already-decided outcome.
		}
	}
}
