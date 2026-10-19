import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ADVISOR_STEERING_FILE, ADVISOR_TOOL_NAME, registerAdvisorTool } from "./advisor.ts";
import {
	type BtwThread,
	bindBtwBackend,
	openBtwModal,
	parseBtwArguments,
	resolveBtwThread,
} from "./btw.ts";
import { doctorReport, showBroConfigModal } from "./doctor.ts";
import { openElevateModal } from "./elevate.ts";
import {
	type BroResult,
	type ModalResult,
	helpText,
	latestAssistant,
	showAdvisorSteerModal,
	showBroModal,
	showPreferencesModal,
	simplify,
} from "./explain-modal.ts";
import { BRO_MODES, type BroMode, parseBroMode } from "./prompt.ts";
import { openGuidedReview, stopGuidedReviews } from "./review-ui.ts";
import {
	type BroSettings,
	capabilityBackend,
	ensureSettingsFile,
	readPreferences,
	readSettings,
	writeSettings,
} from "./settings.ts";
import {
	captureShowTranscript,
	parseShowArguments,
	runShowExplanation,
	showDiagramPath,
} from "./show.ts";
import {
	type BroSource,
	extractDocumentText,
	extractWebPage,
	isWorkspaceFile,
	looksLikeWebUrl,
} from "./sources.ts";
import { hasBroCustomUi } from "./ui-capabilities.ts";
import { errorMessage, unquote, withDoctor } from "./util.ts";

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
export * from "./explain-modal.ts";

const COMMANDS = [
	{ value: "simplify", label: "simplify", description: "Explain the latest completed assistant reply (same as /bro)" },
	{ value: "text", label: "text", description: "Explain pasted text, or the latest reply when text is omitted" },
	{ value: "file", label: "file", description: "Explain a local document" },
	{ value: "url", label: "url", description: "Explain a public webpage" },
	{ value: "open", label: "open", description: "Reopen the last explanation" },
	{ value: "doctor", label: "doctor", description: "Check whether Bro is ready" },
	{ value: "show", label: "show", description: "Draw what happened in recent session turns as shapes" },
	{ value: "mode", label: "mode", description: "View or choose explanation mode (brief, balanced, faithful)" },
	{ value: "preferences", label: "preferences", description: "View or edit what Bro knows about you and how you like answers" },
	{ value: "guided-review", label: "guided-review", description: "Understand and assess a PR with captured code and optional private questions" },
	{ value: "btw", label: "btw", description: "Open a side conversation (starts conversation-only; /mode toggles full permission)" },
	{ value: "elevate", label: "elevate", description: "Discover missing expert considerations, then improve a request" },
	{ value: "config", label: "config", description: "Configure shared defaults and per-capability model/effort overrides" },
	{ value: "advisor", label: "advisor", description: "Check whether the executor's advisor tool is available right now" },
	{ value: "advisor-steer", label: "advisor-steer", description: "View, edit, save, or clear the advisor's persistent steering brief" },
	{ value: "help", label: "help", description: "Learn what Bro does and what it can access" },
];
const KNOWN_ACTIONS = new Set(COMMANDS.map((command) => command.value));

export default async function bro(pi: ExtensionAPI) {
	let lastResult: ModalResult | undefined;
	let lastShowSteering: string | undefined;
	let btwThread: BtwThread | undefined;
	const remember = (result: ModalResult, showSteering?: string) => {
		if (result.source) {
			lastResult = result;
			lastShowSteering = showSteering;
		}
	};

	pi.on("session_shutdown", async () => { stopGuidedReviews(); });

	pi.on("session_start", async (_event, _ctx) => {
		lastResult = undefined;
		btwThread = undefined;
	});

	registerAdvisorTool(pi);

	pi.registerCommand("bro", {
		description: "Explain text, documents, and webpages; draw session turns; open a side conversation; configure Bro and the executor's advisor tool",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = COMMANDS.filter((command) => command.value.startsWith(normalized));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const normalized = raw.toLowerCase();
			const parts = normalized ? normalized.split(/\s+/) : [];
			let action = parts[0] ?? "";
			let value = raw.slice(raw.split(/\s+/, 1)[0]?.length ?? 0).trim();

			if (action === "simplify") {
				if (value) { ctx.ui.notify("Use /bro simplify for the latest reply, or /bro text <text> for pasted text.", "warning"); return; }
				action = "";
			}

			// Removed commands must never fall through to a paid text explanation.
			if (action === "model" || action === "effort") {
				ctx.ui.notify(`/bro ${action} was removed. Use /bro config to choose the shared default and per-capability ${action}; use /bro text <text> to explain text.`, "warning");
				return;
			}

			// An unknown first word means the whole input is the source: route it by shape.
			if (action && !KNOWN_ACTIONS.has(action)) {
				const candidate = unquote(raw);
				const quoted = candidate !== raw;
				action = quoted || !/\s/.test(candidate)
					? looksLikeWebUrl(candidate)
						? "url"
						: (await isWorkspaceFile(candidate, ctx.cwd))
							? "file"
							: "text"
					: "text";
				value = raw;
			}

			if (action === "show") {
				const { requested, steering, invalid } = parseShowArguments(value);
				if (invalid) {
					ctx.ui.notify("Use /bro show [n-turns] [query].", "warning");
					return;
				}
				const runShow = async (
					signal: AbortSignal,
					source?: BroSource,
					onProgress?: (text: string) => void,
				): Promise<ModalResult> => {
					const captured =
						source ?? captureShowTranscript(ctx, requested ? Number(requested) : (await readSettings()).showTurns);
					if (!captured) {
						return { text: "**Nothing to show yet**\n\nThis session has no conversation turns to draw. Run something first, then press **R**." };
					}
					let result: Awaited<ReturnType<typeof runShowExplanation>>;
					try {
						result = await runShowExplanation(captured.text, steering, signal, await readSettings(), onProgress);
					} catch (error) {
						throw new Error(withDoctor(error));
					}
					const htmlPath = await showDiagramPath(result.text, (message) => ctx.ui.notify(message, "warning"));
					return { source: captured, ...result, ...(htmlPath ? { htmlPath } : {}) };
				};
				try {
					await showBroModal(ctx, {
						loadingText: "Drawing what happened…",
						retryLabel: "show again",
						run: runShow,
						onResult: (result) => remember(result, steering),
					});
				} catch (error) {
					ctx.ui.notify(withDoctor(error), "error");
				}
				return;
			}

			if (action === "file" || action === "url") {
				if (!value) {
					ctx.ui.notify(`Use /bro ${action} <${action === "file" ? "path" : "url"}>.`, "warning");
					return;
				}
				const runInput = async (
					signal: AbortSignal,
					source?: BroSource,
					onProgress?: (text: string) => void,
					mode?: BroMode,
				): Promise<BroResult> => {
					const target = source ?? (action === "url"
						? await extractWebPage(value, signal)
						: { text: await extractDocumentText(value, ctx.cwd, signal), label: unquote(value) });
					try {
						return {
							source: target,
							...(await simplify(target.text, signal, await readSettings(), onProgress, mode)),
						};
					} catch (error) {
						throw new Error(withDoctor(error));
					}
				};
				try {
					await showBroModal(ctx, {
						loadingText: action === "url" ? "Fetching and simplifying webpage…" : "Reading and simplifying document…",
						run: runInput,
						onResult: remember,
					});
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
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
					if (bindBtwBackend(thread, btwBackend)) ctx.ui.notify("Backend changed — started a fresh side thread.", "info");
					btwThread = thread;
					await openBtwModal(ctx, { thread, initialQuestion: parsed.question });
				} catch (error) {
					ctx.ui.notify(withDoctor(error), "error");
				}
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

			const run = async (
				signal: AbortSignal,
				source?: BroSource,
				onProgress?: (text: string) => void,
				mode?: BroMode,
			): Promise<BroResult> => {
				let target = source ?? (action === "text" && value ? { text: value } : undefined);
				if (!target) {
					await ctx.waitForIdle();
					target = latestAssistant(ctx);
				}
				if (!target) throw new Error("No completed assistant response found.");
				try {
					const settings = await readSettings();
					return {
						source: target,
						...(await simplify(target.text, signal, settings, onProgress, mode)),
					};
				} catch (error) {
					throw new Error(withDoctor(error));
				}
			};

			if (action === "open") {
				if (parts.length !== 1) {
					ctx.ui.notify("Use /bro open.", "warning");
					return;
				}
				if (!lastResult) {
					await showBroModal(ctx, {
						text: "# Nothing to open yet\n\nUse `/bro text <text>`, run `/bro` after an assistant response, use `/bro file <path>`, use `/bro url <url>`, or run `/bro show` to draw recent turns.",
						kind: "empty",
					});
					return;
				}

				const steering = lastShowSteering;
				if (steering !== undefined) {
					// Temp files may have been cleaned by the OS or another Bro session.
					if (ctx.mode === "tui") lastResult.htmlPath = await showDiagramPath(lastResult.text, (message) => ctx.ui.notify(message, "warning"));
				}
				await showBroModal(ctx, {
					result: lastResult,
					loadingText: steering !== undefined ? "Drawing what happened…" : undefined,
					retryLabel: steering !== undefined ? "show again" : undefined,
					run: steering === undefined ? run : async (signal, source, onProgress) => {
						if (!source) throw new Error("No captured Show source.");
						const result = await runShowExplanation(source.text, steering, signal, await readSettings(), onProgress);
						const htmlPath = await showDiagramPath(result.text, (message) => ctx.ui.notify(message, "warning"));
						return { source, ...result, ...(htmlPath ? { htmlPath } : {}) };
					},
					onResult: (result) => remember(result, steering),
				});
				return;
			}

			try {
				await showBroModal(ctx, {
					run,
					onResult: remember,
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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
				try { await openElevateModal(ctx as import("@earendil-works/pi-coding-agent").ExtensionCommandContext); }
				catch (error) { ctx.ui.notify(withDoctor(error), "error"); }
			},
		});
	} catch { /* /bro still works; the command is the supported path to Elevate */ }

	// Keep the command available even when Bro cannot create its settings file; Doctor can then explain the problem.
	await ensureSettingsFile().catch(() => undefined);
}
