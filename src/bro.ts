import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ADVISOR_STEERING_FILE, ADVISOR_TOOL_NAME, registerAdvisorTool } from "./advisor.ts";
import {
	type BtwThread,
	bindBtwBackend,
	openBtwModal,
	parseBtwArguments,
	resolveBtwThread,
} from "./btw.ts";
import { doctorReport, showBroConfigModal } from "./doctor.ts";
import { setPiHostContext, stopActiveBackendExecutions } from "./backend.ts";
import { openElevateModal } from "./elevate.ts";
import { openArchitectureDocs } from "./architecture.ts";
import { openGrillModal } from "./grill.ts";
import { openCopyModal } from "./copy.ts";
import { registerOverthink } from "./overthink.ts";
import { openRememberModal } from "./remember.ts";
import { openSimplifyWorkflow, type SimplifyState } from "./simplify-ui.ts";
import { parseSimplifyRequest, SIMPLIFY_INPUTS } from "./simplify-engine.ts";
import { registerAboutUserTool } from "./remember-tool.ts";
import { parseGrillArguments, type GrillThread } from "./grill-engine.ts";
import {
	helpText,
	showAdvisorSteerModal,
	showBroModal,
	showPreferencesModal,
} from "./explain-modal.ts";
import { BRO_MODES, parseBroMode } from "./prompt.ts";
import { openGuidedReview, stopGuidedReviews } from "./review-ui.ts";
import {
	type BroSettings,
	capabilityBackend,
	readPreferences,
	readSettings,
	writeSettings,
} from "./settings.ts";
import { hasBroCustomUi } from "./ui-capabilities.ts";
import { errorMessage, withDoctor } from "./util.ts";
import { BTW_SESSION_ENTRY, GRILL_SESSION_ENTRY, SIMPLIFY_SESSION_ENTRY, restorePrivateBroState } from "./session-state.ts";

export * from "./util.ts";
export * from "./ui-capabilities.ts";
export * from "./settings.ts";
export * from "./sources.ts";
export * from "./config-ui.ts";
export * from "./show.ts";
export * from "./advisor.ts";
export * from "./doctor.ts";
export * from "./btw.ts";
export * from "./elevate.ts";
export * from "./elevate-engine.ts";
export * from "./grill.ts";
export * from "./grill-engine.ts";
export * from "./remember-store.ts";
export * from "./remember-engine.ts";
export * from "./explain-modal.ts";
export * from "./simplify-engine.ts";
export * from "./simplify-ui.ts";
export * from "./overthink-state.ts";
export * from "./overthink.ts";
export * from "./session-state.ts";
export * from "./copy.ts";

const COMMANDS = [
	{ value: "architecture", label: "architecture", description: "Document this repository in docs/architecture/ with diagrams and an offline map" },
	{ value: "simplify", label: "simplify", description: "Understand one source in plain words or as a diagram" },
	{ value: "copy", label: "copy", description: "Edit, preview and copy the last assistant reply as Markdown — no model call" },
	{ value: "doctor", label: "doctor", description: "Check whether Bro is ready" },
	{ value: "mode", label: "mode", description: "View or choose explanation mode (brief, balanced, faithful)" },
	{ value: "preferences", label: "preferences", description: "Want Bro to follow your style? Edit saved response preferences" },
	{ value: "guided-review", label: "guided-review", description: "Need to assess a PR? Get source-backed findings and saved private questions" },
	{ value: "btw", label: "btw", description: "Want to explore a side question? Get a private conversation" },
	{ value: "elevate", label: "elevate", description: "Have an assignment for Pi? Get an improved request to copy and send" },
	{ value: "remember-me", label: "remember-me", description: "Want Pi to remember your preferences? Save approved memories for about_user" },
	{ value: "grill-me", label: "grill-me", description: "Facing a decision? Get focused challenges and an optional decision brief" },
	{ value: "overthink", label: "overthink", description: "Want a quiet second look after big work? Get private notes from the active model" },
	{ value: "config", label: "config", description: "Global defaults, diagnostics and feature settings" },
	{ value: "advisor", label: "advisor", description: "Check whether the executor's advisor tool is available right now" },
	{ value: "advisor-steer", label: "advisor-steer", description: "Want to shape future advice? Save priorities for the advisor" },
	{ value: "help", label: "help", description: "Learn what Bro does and what it can access" },
];
const KNOWN_ACTIONS = new Set(COMMANDS.map((command) => command.value));
/** Top-level discovery lists Simplify once, not each source command. */
export const FEATURED_BRO_COMMANDS = [
	"simplify", "btw", "guided-review", "architecture", "elevate", "grill-me", "remember-me", "overthink", "config",
] as const;
const FEATURED_COMMANDS = new Set<string>(FEATURED_BRO_COMMANDS);

export default async function bro(pi: ExtensionAPI) {
	let simplifyState: SimplifyState = {};
	let btwThread: BtwThread | undefined;
	let grillThread: GrillThread | undefined;
	let savedSnapshots = new Map<string, string>();
	// Pi custom entries are append-only. Save a new snapshot only if its content changed.
	// Reset the comparison on /tree: a new branch must never inherit the old branch's state.
	const appendChanged = (type: string, value: unknown) => {
		const data = structuredClone(value);
		const serialized = JSON.stringify(data);
		if (savedSnapshots.get(type) === serialized) return;
		pi.appendEntry(type, data);
		savedSnapshots.set(type, serialized);
	};
	const saveBtw = () => {
		if (!btwThread) return;
		// Visiting an empty BTW modal does not need a disk entry.
		if (!savedSnapshots.has(BTW_SESSION_ENTRY) &&
			!btwThread.turns.length && !btwThread.draft && !btwThread.full) return;
		appendChanged(BTW_SESSION_ENTRY, { thread: btwThread });
	};
	const saveGrill = () => {
		if (!grillThread) return;
		if (!savedSnapshots.has(GRILL_SESSION_ENTRY) &&
			!grillThread.topic && !grillThread.turns.length && !grillThread.draft) return;
		appendChanged(GRILL_SESSION_ENTRY, { thread: grillThread });
	};
	const restore = (ctx: ExtensionContext) => {
		savedSnapshots = new Map();
		const restored = restorePrivateBroState(ctx.sessionManager.getBranch(), savedSnapshots);
		simplifyState = restored.simplify;
		btwThread = restored.btw;
		grillThread = restored.grill;
	};

	pi.on("session_shutdown", async () => {
		// Both cleanups begin before we await either one.
		const [reviews, backends] = await Promise.allSettled([
			stopGuidedReviews(), stopActiveBackendExecutions(),
		]);
		if (reviews.status === "rejected") throw reviews.reason;
		if (backends.status === "rejected") throw backends.reason;
	});
	pi.on("session_start", async (_event, ctx) => { restore(ctx); });
	pi.on("session_tree", async (_event, ctx) => { restore(ctx); });

	registerAdvisorTool(pi);
	registerAboutUserTool(pi);
	const overthink = registerOverthink(pi);

	pi.registerCommand("bro", {
		description: "Explain text, documents, and webpages; draw session turns; open a side conversation; configure Bro and the executor's advisor tool",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trimStart().toLowerCase();
			const nested = /^simplify\s+(\S*)$/.exec(normalized);
			if (nested) {
				const matches = SIMPLIFY_INPUTS.filter(input => input.startsWith(nested[1]!));
				return matches.length ? matches.map(input => ({ value: `simplify ${input}`, label: input })) : null;
			}
			const matches = COMMANDS.filter(command =>
				normalized.trim() ? command.value.startsWith(normalized.trim()) : FEATURED_COMMANDS.has(command.value));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			// Publish the host registry so the in-process Pi backend can resolve models and runtime keys.
			setPiHostContext(ctx);
			const raw = args.trim();
			const normalized = raw.toLowerCase();
			const parts = normalized ? normalized.split(/\s+/) : [];
			const action = parts[0] ?? "";
			const value = raw.slice(action.length).trim();

			if (action === "model" || action === "effort") {
				ctx.ui.notify(`/bro ${action} was removed. Use /bro config to choose the shared default and per-capability ${action}.`, "warning");
				return;
			}
			if (action && !KNOWN_ACTIONS.has(action)) {
				const replacement = action === "open" ? "/bro simplify"
					: action === "text" && !value ? "/bro simplify latest"
					: action === "text" ? "/bro simplify text <text>"
					: action === "file" ? "/bro simplify file <path>"
					: action === "url" ? "/bro simplify url <url>"
					: action === "show" ? "/bro simplify show [n-turns] [query]" : undefined;
				ctx.ui.notify(replacement ? `/bro ${action} moved. Use ${replacement}.`
					: "Unknown Bro command. Use /bro help, or /bro simplify text <text> to explain pasted text.", "warning");
				return;
			}

			if (!action || action === "simplify") {
				const input = value.split(/\s+/, 1)[0] ?? "";
				const initial = input ? parseSimplifyRequest(input.toLowerCase(), value.slice(input.length).trim()) : undefined;
				if (initial?.kind === "invalid") { ctx.ui.notify(initial.message, "warning"); return; }
				const state = simplifyState;
				const hadResult = Boolean(state.result);
				const headlessRun = initial && !hasBroCustomUi(ctx);
				try {
					await openSimplifyWorkflow(ctx, state, initial, initial ? (initial.kind === "latest" ? "/simplify" : `/${value}`) : undefined);
					if (simplifyState === state && (savedSnapshots.has(SIMPLIFY_SESSION_ENTRY) || hadResult || state.result || state.draft)) {
						appendChanged(SIMPLIFY_SESSION_ENTRY, { state });
						if (headlessRun) {
							const file = ctx.sessionManager.getSessionFile?.();
							if (!file || !existsSync(file)) {
								ctx.ui.notify("Simplify finished, but Pi has no saved session file. The result is only in memory. To keep headless results, reopen a saved Pi session before running Simplify.", "warning");
							}
						}
					}
				} catch (error) { ctx.ui.notify(withDoctor(error), "error"); }
				return;
			}

			if (action === "copy") {
				if (value) { ctx.ui.notify("Use /bro copy without arguments to edit the last reply.", "warning"); return; }
				try { await openCopyModal(ctx); }
				catch (error) { ctx.ui.notify("Bro Copy: " + errorMessage(error), "error"); }
				return;
			}

			if (action === "doctor") {
				if (parts.length !== 1) {
					ctx.ui.notify("Use /bro doctor.", "warning");
					return;
				}
				try {
					await showBroModal(ctx, {
						loadingText: "Checking Bro setup…",
						retryable: true,
						retryLabel: "check again",
						run: async (signal) => ({ text: await doctorReport(pi, ctx, signal) }),
					});
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
				return;
			}

			if (action === "mode") {
				const requested = parts[1];
				if (parts.length > 2 || (requested && !parseBroMode(requested))) {
					ctx.ui.notify("Use /bro mode, or choose brief, balanced, or faithful.", "warning");
					return;
				}
				try {
					const settings = await readSettings();
					let selected = parseBroMode(requested);
					if (!selected) {
						if (!hasBroCustomUi(ctx)) {
							ctx.ui.notify("Use /bro mode <brief|balanced|faithful> outside Pi's interactive UI.", "warning");
							return;
						}
						const modes = [...BRO_MODES].sort((a, b) => Number(b === settings.mode) - Number(a === settings.mode));
						const choices = modes.map((mode) => `${mode}${mode === settings.mode ? " (current)" : ""}`);
						const choice = await ctx.ui.select(`Bro mode (current: ${settings.mode})`, choices);
						if (!choice) return;
						selected = modes[choices.indexOf(choice)];
					}
					if (!selected) return;
					await writeSettings({ ...settings, mode: selected });
					ctx.ui.notify(`Bro mode: ${selected}`, "info");
				} catch (error) {
					ctx.ui.notify(withDoctor(error), "error");
				}
				return;
			}

			if (action === "architecture") {
				try { await openArchitectureDocs(ctx, value); }
				catch (error) { ctx.ui.notify(withDoctor(error), "error"); }
				return;
			}

			if (action === "guided-review") {
				try { await openGuidedReview(ctx, value, await readPreferences()); }
				catch (error) { ctx.ui.notify(errorMessage(error), "error"); }
				return;
			}

			if (action === "btw") {
				if (!hasBroCustomUi(ctx)) {
					ctx.ui.notify("Use /bro btw in Pi's interactive UI.", "warning");
					return;
				}
				const parsed = parseBtwArguments(value);
				if (parsed.invalid) {
					ctx.ui.notify(parsed.invalid, "warning");
					return;
				}
				try {
					const btwBackend = capabilityBackend(await readSettings(), "btw");
					const thread = resolveBtwThread(btwThread);
					const backendChanged = bindBtwBackend(thread, btwBackend);
					if (backendChanged) ctx.ui.notify("Backend changed — started a fresh side thread.", "info");
					btwThread = thread;
					if (backendChanged) saveBtw();
					await openBtwModal(ctx, {
						thread, initialQuestion: parsed.question,
						onChange: () => { if (btwThread === thread) saveBtw(); },
					});
				} catch (error) {
					ctx.ui.notify(withDoctor(error), "error");
				}
				return;
			}

			if (action === "remember-me") {
				if (!hasBroCustomUi(ctx)) { ctx.ui.notify("Use /bro remember-me in Pi interactive UI.", "warning"); return; }
				try { await openRememberModal(ctx, value); }
				catch (error) { ctx.ui.notify(withDoctor(error), "error"); }
				return;
			}

			if (action === "grill-me") {
				if (!hasBroCustomUi(ctx)) { ctx.ui.notify("Use /bro grill-me in Pi's interactive UI.", "warning"); return; }
				const parsed = parseGrillArguments(value);
				if (parsed.invalid) { ctx.ui.notify(parsed.invalid, "warning"); return; }
				const start = Boolean(parsed.topic);
				if (start) grillThread = { topic: parsed.topic, depth: parsed.depth, turns: [], fullAccess: false };
				else grillThread ??= { topic: "", depth: parsed.depth, turns: [], fullAccess: false };
				const thread = grillThread;
				if (start) saveGrill();
				try { await openGrillModal(ctx, thread, { start, onChange: () => { if (grillThread === thread) saveGrill(); } }); }
				catch (error) { ctx.ui.notify(withDoctor(error), "error"); }
				return;
			}

			if (action === "overthink") {
				if (value) { ctx.ui.notify("Use /bro overthink to open private notes; retry inside the modal.", "warning"); return; }
				try { await overthink.open(ctx); }
				catch (error) { ctx.ui.notify("Overthink: " + errorMessage(error), "error"); }
				return;
			}

			if (action === "elevate") {
				if (!hasBroCustomUi(ctx)) { ctx.ui.notify("Use /bro elevate in Pi interactive UI.", "warning"); return; }
				try { await openElevateModal(ctx, value); }
				catch (error) { ctx.ui.notify(withDoctor(error), "error"); }
				return;
			}

			if (action === "config") {
				if (parts.length !== 1) {
					ctx.ui.notify("Use /bro config.", "warning");
					return;
				}
				await showBroConfigModal(ctx, pi);
				return;
			}

			if (action === "advisor") {
				// bro_advisor has no on/off/status controls of its own anymore -- it is always registered
				// and gated only by this host's own tool restrictions. An old on/off/status argument gets
				// an actionable notice pointing at the commands that replaced it, not a silent no-op.
				if (parts.length > 1) {
					ctx.ui.notify(
						"/bro advisor no longer has on/off/status controls -- bro_advisor is always registered and available whenever this host exposes and activates it. Use /bro config for its model/effort, /bro advisor-steer for session steering, or /bro doctor for full diagnostics.",
						"warning",
					);
					return;
				}
				const active = pi.getActiveTools().includes(ADVISOR_TOOL_NAME);
				ctx.ui.notify(
					active
						? `Bro advisor is available -- the executor agent can call bro_advisor. Use /bro config for its model/effort, /bro advisor-steer for session steering, ${ADVISOR_STEERING_FILE} for standing steering, or /bro doctor for full diagnostics.`
						: "Bro advisor is unavailable in this runtime. Use /bro doctor for full diagnostics, /bro config for its model/effort, or /bro advisor-steer for session steering.",
					active ? "info" : "warning",
				);
				return;
			}

			if (action === "advisor-steer") {
				if (parts.length !== 1) {
					ctx.ui.notify("Use /bro advisor-steer.", "warning");
					return;
				}
				await showAdvisorSteerModal(ctx, pi);
				return;
			}

			if (action === "preferences") {
				if (parts.length !== 1) {
					ctx.ui.notify("Use /bro preferences.", "warning");
					return;
				}
				await showPreferencesModal(ctx);
				return;
			}

			if (action === "help") {
				if (parts.length !== 1) {
					ctx.ui.notify("Use /bro help.", "warning");
					return;
				}
				let settings: BroSettings | undefined;
				let settingsError: string | undefined;
				try {
					settings = await readSettings();
				} catch (error) {
					settingsError = errorMessage(error);
				}
				let preferences: string;
				try {
					const text = await readPreferences();
					preferences = text ? `on (${text.length.toLocaleString("en-US")} characters)` : "off";
				} catch (error) {
					preferences = `error: ${errorMessage(error)}`;
				}
				await showBroModal(ctx, { text: helpText(settings, settingsError, preferences), kind: "help", copyable: true });
				return;
			}
		},
	});

	// Registered after /bro and isolated: a shortcut that cannot register must never remove the
	// working commands. The shortcut can read an unsent draft and uses only context and UI methods
	// shared by ExtensionContext and ExtensionCommandContext.
	try {
		if (typeof pi.registerShortcut === "function") pi.registerShortcut("ctrl+shift+e", {
			description: "Bro Elevate: improve the current editor draft",
			handler: async (ctx) => {
				if (!hasBroCustomUi(ctx)) { ctx.ui.notify("Elevate requires Pi interactive UI.", "warning"); return; }
				// The shortcut bypasses the /bro handler, so publish the registry here for the Pi backend.
				setPiHostContext(ctx);
				try { await openElevateModal(ctx as import("@earendil-works/pi-coding-agent").ExtensionCommandContext); }
				catch (error) { ctx.ui.notify(withDoctor(error), "error"); }
			},
		});
	} catch { /* /bro still works; the command is the supported path to Elevate */ }
}
