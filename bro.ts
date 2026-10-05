import { spawnSync } from "node:child_process";
import { hasBroCustomUi, broModalRows, canBroInsertIntoEditor, insertBroDesktopText } from "./ui-capabilities.ts";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Container, Editor, Input, Markdown, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type EditorTheme, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { convertToLlm, copyToClipboard, getAgentDir, getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BRO_MODES, DEFAULT_BRO_MODE, MAX_PREFERENCES_CHARS, STARTER_PREFERENCES, buildAdvisorPrompt, buildBtwPrompt, buildDefaultPrompt, buildShowPrompt, nextBroMode, parseBroMode, type BroMode } from "./prompt.ts";
import {
	agyFailureMessage,
	agySelection,
	advisorFlagErrorHint,
	execute as executeBackend,
	parseBtwAgyLine,
	type AgySelection,
	type BackendProgress,
	type BackendSelection,
} from "./backend.ts";
import { isRecord, errorMessage, withDoctor, unquote } from "./util.ts";
import {
	type BackendName,
	type BroSettings,
	type Capability,
	type ModelEffortPair,
	type AgyModelFamily,
	type AgyEffort,
	EFFORTS,
	CAPABILITIES,
	CAPABILITY_LABELS,
	capabilityBackend,
	capabilityOverride,
	capabilityPair,
	ensureSettingsFile,
	isClaudeEffort,
	isGrokEffort,
	isCodexEffort,
	isMuseEffort,
	readSettings,
	resolveCapabilitySettings,
	resolveModelEffort,
	selectionForCapability,
	selectionLabel,
	settingsFile,
	settingsPayload,
	writeSettings,
} from "./settings.ts";
import {
	type BroSource,
	extractDocumentText,
	extractWebPage,
	isWorkspaceFile,
	looksLikeWebUrl,
	MAX_TEXT_LENGTH,
} from "./sources.ts";
import { createConfigModal, type Theme, type TuiLike } from "./config-ui.ts";

export * from "./util.ts";
export * from "./settings.ts";
export * from "./sources.ts";
export * from "./config-ui.ts";
export { agyFailureMessage, agySelection, advisorFlagErrorHint, parseBtwAgyLine };

const PREFERENCES_FILE = join(getAgentDir(), "bro-preferences.md");
// Larger files are rejected before reading, even by the editor; the prompt limit is MAX_PREFERENCES_CHARS.
const MAX_PREFERENCES_FILE_BYTES = 64 * 1024;
const LOADING_TEXT = "Simplifying for my bro…";
const BTW_CONTEXT_TURNS = 8;
const BTW_CONTEXT_MAX = 40_000;
const SHOW_HTML_FILE_PATTERN = /^bro-show-[0-9a-f]{8}\.html$/;

type ModalKind = "loading" | "streaming" | "result" | "help" | "empty" | "error";
// `mode` is the built-in explain mode that produced the text; absent for Show and Doctor.
// `preferences` records whether bro-preferences.md shaped this result; like `mode`, it belongs to the result.
type BroResult = { source: BroSource; text: string; model?: string; mode?: BroMode; preferences?: boolean };
type ModalResult = { source?: BroSource; text: string; htmlPath?: string; model?: string; mode?: BroMode; preferences?: boolean };
type BtwTurn = { question: string; answer: string };
// `context` keeps the main-session seed so a fresh native session can be reseeded with the whole
// thread; `sessionFull` and `sessionPreferences` are the access mode and preferences the native
// session last ran with. `preferences` records whether the latest turn used them (header tag).
type BtwThread = { turns: BtwTurn[]; conversationId?: string; full: boolean; backend?: BackendName; model?: string; preferences?: boolean; context?: string; sessionFull?: boolean; sessionPreferences?: string };
export function wheelDelta(data: string): number {
	const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
	if (!match) return 0;
	const button = Number.parseInt(match[1], 10);
	if ((button & 64) === 0) return 0;
	return (button & 3) === 0 ? -3 : (button & 3) === 1 ? 3 : 0;
}

export function setRegularMouseReporting(tui: Pick<TuiLike, "mode" | "terminal">, enabled: boolean): void {
	if (tui.mode === "regular") tui.terminal?.write?.(`\x1b[?1000${enabled ? "h" : "l"}\x1b[?1006${enabled ? "h" : "l"}`);
}

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
	{ value: "btw", label: "btw", description: "Open a side conversation (starts conversation-only; /mode toggles full permission)" },
	{ value: "config", label: "config", description: "Configure shared defaults and per-capability model/effort overrides" },
	{ value: "advisor", label: "advisor", description: "Check whether the executor's advisor tool is available right now" },
	{ value: "advisor-steer", label: "advisor-steer", description: "View, edit, save, or clear the advisor's persistent steering brief" },
	{ value: "help", label: "help", description: "Learn what Bro does and what it can access" },
];
const KNOWN_ACTIONS = new Set(COMMANDS.map((command) => command.value));


// The steering brief is stored as a session `custom` entry — extension state that never
// participates in LLM context (see docs/plans/2026-09-19-bro-advisor-design.md). Writes go
// through pi.appendEntry(); ctx.sessionManager is read-only and has no append methods.
//
// bro_advisor has no on/off activation state: it is registered once at extension load like any
// other tool and never gated via pi.setActiveTools(). Whether the executor can call it is purely a
// function of this host's own tool restrictions (pi.getAllTools() / pi.getActiveTools()), which
// this code only ever reads, never overrides. A session may still carry historical
// "bro-advisor-active" entries from before this simplification; they are silently ignored.
const ADVISOR_STEERING_ENTRY = "bro-advisor-steering";
export const ADVISOR_TOOL_NAME = "bro_advisor";
// setStatus() key for mirroring live advisor progress to the footer/status bar -- see the execute()
// handler below for why this fallback surface exists alongside onUpdate's tool-card renderResult.
const ADVISOR_STATUS_BAR_KEY = "bro-advisor";
const ADVISOR_COMPATIBILITY = "Pi >=0.84.2; Agy >=1.1.15";

export type AdvisorState = { steering: string };

// getBranch() walks root-to-leaf (see latestAssistant above for the same convention), so a forward
// scan taking the last match of ADVISOR_STEERING_ENTRY resolves "latest wins". Forking clones the
// branch's entries into a new session file, so this same resolution gives fork inheritance and
// independent post-fork edits for free, with no special-case fork logic.
export function resolveAdvisorState(branch: readonly SessionEntry[]): AdvisorState {
	let steering = "";
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== ADVISOR_STEERING_ENTRY) continue;
		if (isRecord(entry.data) && typeof entry.data.text === "string") steering = entry.data.text;
	}
	return { steering };
}


export function formatAgyUsage(value: unknown): string {
	if (!isRecord(value) || value.status !== "SUCCESS" || typeof value.response !== "string") {
		throw new Error("Agy returned invalid usage data.");
	}

	const groups = new Map<string, string[]>();
	for (const line of value.response.trim().split("\n")) {
		const [group, limit, remaining, resetTime] = line.split("\t");
		if (!group || !limit || !remaining) throw new Error("Agy returned invalid usage data.");
		const reset = resetTime ? new Date(resetTime) : undefined;
		const resetText = reset && !Number.isNaN(reset.getTime()) ? ` — resets ${reset.toLocaleString()}` : "";
		const items = groups.get(group) ?? [];
		items.push(`- **${limit}:** ${remaining}${resetText}`);
		groups.set(group, items);
	}
	if (!groups.size) throw new Error("Agy returned no usage information.");

	const sections = [...groups].map(([group, items]) => `## ${group}\n\n${items.join("\n")}`);
	return `# Agy usage\n\n${sections.join("\n\n")}`;
}

export function parseAgyModels(output: string): AgyModelFamily[] {
	// ponytail: Agy 1.1.13 exposes a tab-separated variant list; use structured catalog data when available here.
	const families = new Map<string, AgyModelFamily>();
	for (const line of output.split(/\r?\n/)) {
		const [rawId, ...rawLabel] = line.split("\t");
		if (!rawId?.trim() || !rawLabel.length) continue;
		const id = rawId.trim();
		const label = rawLabel.join(" ").trim();
		const effort = (["low", "medium", "high"] as const).find(
			(value) => id.endsWith(`-${value}`) && label.endsWith(`(${value[0].toUpperCase()}${value.slice(1)})`),
		);
		const familyId = effort ? id.slice(0, -effort.length - 1) : id;
		const family = families.get(familyId) ?? {
			id: familyId,
			label: effort ? label.replace(/\s+\((Low|Medium|High)\)$/, "") : label,
			efforts: [],
			variants: [],
		};
		if (effort && !family.efforts.includes(effort)) family.efforts.push(effort);
		family.variants.push({ id, effort });
		families.set(familyId, family);
	}
	if (!families.size) throw new Error("Agy returned no available models.");
	for (const family of families.values()) {
		family.efforts.sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
	}
	return [...families.values()];
}

async function listAgyModels(pi: ExtensionAPI, signal?: AbortSignal): Promise<AgyModelFamily[]> {
	const runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
	try {
		const result = await pi.exec("agy", ["models"], { cwd: runDirectory, signal, timeout: 30_000 });
		if (signal?.aborted) throw new Error("Canceled.");
		if (result.killed || result.code !== 0) throw new Error(agyFailureMessage("list models", result));
		try {
			return parseAgyModels(result.stdout);
		} catch (error) {
			throw new Error(withDoctor(error));
		}
	} finally {
		await rm(runDirectory, { recursive: true, force: true });
	}
}

async function checkAgyVersion(pi: ExtensionAPI, signal: AbortSignal): Promise<string> {
	const runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
	try {
		const result = await pi.exec("agy", ["--version"], { cwd: runDirectory, signal, timeout: 10_000 });
		if (signal.aborted) throw new Error("Canceled.");
		if (result.killed || result.code !== 0) throw new Error(agyFailureMessage("start", result));
		const version = result.stdout.trim() || result.stderr.trim();
		if (!version) throw new Error("Agy returned no version information. Update Agy, then run `/bro doctor` again.");
		return version;
	} finally {
		await rm(runDirectory, { recursive: true, force: true });
	}
}

export function advisorAgyCompatible(version: string): boolean | undefined {
	const match = /(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(version);
	if (!match) return undefined;
	const installed = match.slice(1, 4).map(Number);
	const minimum = [1, 1, 15];
	for (let index = 0; index < minimum.length; index++) {
		if (installed[index]! !== minimum[index]!) return installed[index]! > minimum[index]!;
	}
	return true;
}

function resolveCatalogSettings(
	settings: BroSettings,
	families: AgyModelFamily[],
): { settings: BroSettings; family?: AgyModelFamily } {
	const resolved = resolveModelEffort({ model: settings.model, effort: settings.effort }, families);
	if (!resolved.family) return { settings };
	return { family: resolved.family, settings: { ...settings, ...resolved.pair } };
}

async function checkCliVersion(pi: ExtensionAPI, binary: string, displayName: string, signal: AbortSignal): Promise<string> {
	const runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
	try {
		const result = await pi.exec(binary, ["--version"], { cwd: runDirectory, signal, timeout: 10_000 });
		if (signal.aborted) throw new Error("Canceled.");
		if (result.killed || result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim();
			throw new Error(
				detail
					? `${displayName} could not start: ${detail}\n\nRun \`/bro doctor\` for setup help.`
					: `${displayName} could not start. Make sure ${displayName} is installed and on PATH, then run \`/bro doctor\`.`,
			);
		}
		const version = result.stdout.trim() || result.stderr.trim();
		if (!version) throw new Error(`${displayName} returned no version information. Update ${displayName}, then run \`/bro doctor\` again.`);
		return version;
	} finally {
		await rm(runDirectory, { recursive: true, force: true });
	}
}

// Auth status only: a version/auth answer without a model request. A passing answer here
// says the CLI starts and reports signed-in state -- it does not imply connectivity.
async function checkClaudeAuth(pi: ExtensionAPI, signal: AbortSignal): Promise<string> {
	const runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
	try {
		const result = await pi.exec("claude", ["auth", "status"], { cwd: runDirectory, signal, timeout: 15_000 });
		if (signal.aborted) throw new Error("Canceled.");
		if (result.killed || result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim();
			throw new Error(detail ? `Claude auth status: ${detail}` : "Claude auth status is unknown. Sign in, then run `/bro doctor`.");
		}
		let status: unknown;
		try { status = JSON.parse(result.stdout); } catch { throw new Error("Claude returned unreadable auth status; sign in and retry /bro doctor."); }
		if (!isRecord(status) || status.loggedIn !== true) throw new Error("Claude is not signed in. Run `claude auth login`.");
		return "authentication configured (not a connectivity test)";
	} finally {
		await rm(runDirectory, { recursive: true, force: true });
	}
}

// Auth status only: a version/auth answer without a model request. A passing answer here
// says the CLI starts and reports signed-in state -- it does not imply connectivity.
async function checkCodexAuth(pi: ExtensionAPI, signal: AbortSignal): Promise<string> {
	const runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
	try {
		const result = await pi.exec("codex", ["login", "status"], { cwd: runDirectory, signal, timeout: 15_000 });
		if (signal.aborted) throw new Error("Canceled.");
		if (result.killed || result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim();
			throw new Error(detail ? `Codex auth status: ${detail}` : "Codex is not logged in. Run `codex login`.");
		}
		const status = result.stdout.trim() || result.stderr.trim();
		if (!status || !/logged in/i.test(status)) throw new Error("Codex is not logged in. Run `codex login`.");
		return "authentication configured (not a connectivity test)";
	} finally {
		await rm(runDirectory, { recursive: true, force: true });
	}
}

async function checkAgyUsage(pi: ExtensionAPI, signal: AbortSignal): Promise<string> {
	const runDirectory = await mkdtemp(join(tmpdir(), "pi-bro-"));
	try {
		const result = await pi.exec(
			"agy",
			["-p", "/usage", "--output-format", "json", "--print-timeout", "30s", "--sandbox"],
			{ cwd: runDirectory, signal, timeout: 35_000 },
		);
		if (signal.aborted) throw new Error("Canceled.");
		if (result.killed || result.code !== 0) throw new Error(agyFailureMessage("check account usage", result));
		try {
			return formatAgyUsage(JSON.parse(result.stdout));
		} catch (error) {
			throw new Error(withDoctor(error instanceof SyntaxError ? "Agy returned invalid usage data." : error));
		}
	} finally {
		await rm(runDirectory, { recursive: true, force: true });
	}
}

async function doctorReport(pi: ExtensionAPI, ctx: ExtensionCommandContext, signal: AbortSignal): Promise<string> {
	const lines: string[] = [];
	let failed = false;
	let settings: BroSettings | undefined;
	let models: AgyModelFamily[] | undefined;
	let agyVersion: string | undefined;
	const pass = (name: string, detail: string) => lines.push(`- ✓ **${name}:** ${detail}`);
	const fail = (name: string, error: unknown) => {
		failed = true;
		lines.push(`- ✗ **${name}:** ${errorMessage(error)}`);
	};

	try {
		settings = await readSettings();
		pass("Settings", `valid · mode: ${settings.mode}`);
	} catch (error) {
		fail("Settings", error);
	}

	try {
		const preferences = await readPreferences();
		pass("Preferences", preferences ? `${preferences.length.toLocaleString("en-US")} characters · used by explain, show, btw` : "none — /bro preferences to add some");
	} catch (error) {
		fail("Preferences", error);
	}

	// Probe only the backends some feature actually selects: a Claude/Grok/Codex/Muse-only setup never
	// requires Agy to be installed, and vice versa.
	const agyInUse = !settings || capabilityBackend(settings, "explain") === "agy" || capabilityBackend(settings, "show") === "agy" || capabilityBackend(settings, "btw") === "agy" || capabilityBackend(settings, "advisor") === "agy" || (settings.backend ?? "agy") === "agy";
	const claudeInUse = !!settings && (capabilityBackend(settings, "explain") === "claude" || capabilityBackend(settings, "show") === "claude" || capabilityBackend(settings, "btw") === "claude" || capabilityBackend(settings, "advisor") === "claude" || settings.backend === "claude");
	const grokInUse = !!settings && (capabilityBackend(settings, "explain") === "grok" || capabilityBackend(settings, "show") === "grok" || capabilityBackend(settings, "btw") === "grok" || capabilityBackend(settings, "advisor") === "grok" || settings.backend === "grok");
	const codexInUse = !!settings && (capabilityBackend(settings, "explain") === "codex" || capabilityBackend(settings, "show") === "codex" || capabilityBackend(settings, "btw") === "codex" || capabilityBackend(settings, "advisor") === "codex" || settings.backend === "codex");
	const museInUse = !!settings && (capabilityBackend(settings, "explain") === "muse" || capabilityBackend(settings, "show") === "muse" || capabilityBackend(settings, "btw") === "muse" || capabilityBackend(settings, "advisor") === "muse" || settings.backend === "muse");

	let agyStarted = false;
	if (agyInUse) {
		try {
			agyVersion = await checkAgyVersion(pi, signal);
			pass("Agy", agyVersion);
			agyStarted = true;
		} catch (error) {
			if (signal.aborted) throw error;
			fail("Agy", error);
		}

		if (agyStarted) {
			try {
				models = await listAgyModels(pi, signal);
				pass("Model catalog", `${models.length} model${models.length === 1 ? "" : "s"} available`);
			} catch (error) {
				if (signal.aborted) throw error;
				fail("Model catalog", error);
			}

			try {
				await checkAgyUsage(pi, signal);
				pass("Account", "connected");
			} catch (error) {
				if (signal.aborted) throw error;
				fail("Account", error);
			}
		}
	} else {
		pass("Agy", "not probed — no feature selects the Agy backend");
	}

	// Version and auth status only, never a model request. A passing answer says the CLI
	// starts and reports signed-in state -- it does not imply connectivity.
	if (claudeInUse) {
		try {
			pass("Claude", await checkCliVersion(pi, "claude", "Claude", signal));
		} catch (error) {
			if (signal.aborted) throw error;
			fail("Claude", error);
		}
		try {
			pass("Claude auth", await checkClaudeAuth(pi, signal));
		} catch (error) {
			if (signal.aborted) throw error;
			fail("Claude auth", error);
		}
	} else {
		pass("Claude", "not probed — no feature selects the Claude backend");
	}

	// Version only, never a model request. No Grok auth probe exists, so a passing
	// version says the CLI starts — it says nothing about auth or connectivity.
	if (grokInUse) {
		try {
			pass("Grok", await checkCliVersion(pi, "grok", "Grok", signal));
		} catch (error) {
			if (signal.aborted) throw error;
			fail("Grok", error);
		}
		pass("Grok auth", "unverified — no auth probe exists (version does not imply auth or connectivity)");
	} else {
		pass("Grok", "not probed — no feature selects the Grok backend");
	}

	// Version and auth status only, never a model request.
	if (codexInUse) {
		try {
			pass("Codex", await checkCliVersion(pi, "codex", "Codex", signal));
		} catch (error) {
			if (signal.aborted) throw error;
			fail("Codex", error);
		}
		try {
			pass("Codex auth", await checkCodexAuth(pi, signal));
		} catch (error) {
			if (signal.aborted) throw error;
			fail("Codex auth", error);
		}
	} else {
		pass("Codex", "not probed — no feature selects the Codex backend");
	}

	// Version only, never a model request. No Muse auth probe exists, so a passing
	// version says the CLI starts — it says nothing about auth or connectivity.
	if (museInUse) {
		try {
			pass("Muse", await checkCliVersion(pi, "muse", "Muse", signal));
		} catch (error) {
			if (signal.aborted) throw error;
			fail("Muse", error);
		}
		pass("Muse auth", "unverified — no auth probe exists (version does not imply auth or connectivity)");
	} else {
		pass("Muse", "not probed — no feature selects the Muse backend");
	}

	if (settings) {
		const defaultBackend = settings.backend ?? "agy";
		if (defaultBackend === "claude") {
			pass("Selected model", `claude \`${settings.model}\``);
			if (!isClaudeEffort(settings.effort)) {
				fail("Reasoning effort", `\`${settings.effort}\` is unsupported. Run \`/bro config\` to choose another.`);
			} else if (settings.effort === "default") {
				pass("Reasoning effort", "built into the selected model");
			} else {
				pass("Reasoning effort", settings.effort);
			}
		} else if (defaultBackend === "grok") {
			pass("Selected model", `grok \`${settings.model}\``);
			if (!isGrokEffort(settings.effort)) {
				fail("Reasoning effort", `\`${settings.effort}\` is unsupported. Run \`/bro config\` to choose another.`);
			} else if (settings.effort === "default") {
				pass("Reasoning effort", "built into the selected model");
			} else {
				pass("Reasoning effort", settings.effort);
			}
		} else if (defaultBackend === "codex") {
			pass("Selected model", `codex \`${settings.model}\``);
			if (!isCodexEffort(settings.effort)) {
				fail("Reasoning effort", `\`${settings.effort}\` is unsupported. Run \`/bro config\` to choose another.`);
			} else if (settings.effort === "default") {
				pass("Reasoning effort", "built into the selected model");
			} else {
				pass("Reasoning effort", settings.effort);
			}
		} else if (defaultBackend === "muse") {
			pass("Selected model", `muse \`${settings.model}\``);
			if (!isMuseEffort(settings.effort)) {
				fail("Reasoning effort", `\`${settings.effort}\` is unsupported. Run \`/bro config\` to choose another.`);
			} else if (settings.effort === "default") {
				pass("Reasoning effort", "built into the selected model");
			} else {
				pass("Reasoning effort", settings.effort);
			}
		} else if (models) {
			const current = resolveCatalogSettings(settings, models);
			if (!current.family) {
				fail("Selected model", `\`${settings.model}\` is unavailable. Run \`/bro config\` to choose another.`);
			} else {
				pass("Selected model", `agy \`${current.family.id}\``);
				const effort = current.settings.effort;
				if (!current.family.efforts.length && effort === "default") {
					pass("Reasoning effort", "built into the selected model");
				} else if (effort !== "default" && current.family.efforts.includes(effort as AgyEffort)) {
					pass("Reasoning effort", effort);
				} else {
					fail("Reasoning effort", `\`${effort}\` is unsupported. Run \`/bro config\` to choose another.`);
				}
			}
		}

		for (const capability of CAPABILITIES) {
			const label = CAPABILITY_LABELS[capability];
			const override = capabilityOverride(settings, capability);
			const backend = capabilityBackend(settings, capability);
			const pair = capabilityPair(settings, capability);
			if (backend === "claude") {
				if (!isClaudeEffort(pair.effort)) {
					fail(label, `\`${pair.effort}\` is unsupported for claude \`${pair.model}\`. Run \`/bro config\` to fix this.`);
					continue;
				}
				pass(
					label,
					override
						? `override claude \`${pair.model}\`${pair.effort === "default" ? "" : ` (${pair.effort})`}`
						: `claude \`${pair.model}\`${pair.effort === "default" ? "" : ` (${pair.effort})`} · using the shared default`,
				);
				continue;
			}
			if (backend === "grok") {
				if (!isGrokEffort(pair.effort)) {
					fail(label, `\`${pair.effort}\` is unsupported for grok \`${pair.model}\`. Run \`/bro config\` to fix this.`);
					continue;
				}
				pass(
					label,
					override
						? `override grok \`${pair.model}\`${pair.effort === "default" ? "" : ` (${pair.effort})`}`
						: `grok \`${pair.model}\`${pair.effort === "default" ? "" : ` (${pair.effort})`} · using the shared default`,
				);
				continue;
			}
			if (backend === "codex") {
				if (!isCodexEffort(pair.effort)) {
					fail(label, `\`${pair.effort}\` is unsupported for codex \`${pair.model}\`. Run \`/bro config\` to fix this.`);
					continue;
				}
				pass(
					label,
					override
						? `override codex \`${pair.model}\`${pair.effort === "default" ? "" : ` (${pair.effort})`}`
						: `codex \`${pair.model}\`${pair.effort === "default" ? "" : ` (${pair.effort})`} · using the shared default`,
				);
				continue;
			}
			if (backend === "muse") {
				if (!isMuseEffort(pair.effort)) {
					fail(label, `\`${pair.effort}\` is unsupported for muse \`${pair.model}\`. Run \`/bro config\` to fix this.`);
					continue;
				}
				pass(
					label,
					override
						? `override muse \`${pair.model}\`${pair.effort === "default" ? "" : ` (${pair.effort})`}`
						: `muse \`${pair.model}\`${pair.effort === "default" ? "" : ` (${pair.effort})`} · using the shared default`,
				);
				continue;
			}
			if (!models) continue;
			const resolved = resolveCapabilitySettings(settings, capability, models);
			if (!resolved.family) {
				fail(label, `\`${resolved.pair.model}\` is unavailable. Run \`/bro config\` to fix this override.`);
				continue;
			}
			const effortOk = !resolved.family.efforts.length
				? resolved.pair.effort === "default"
				: resolved.pair.effort !== "default" && resolved.family.efforts.includes(resolved.pair.effort as AgyEffort);
			if (!effortOk) {
				fail(label, `\`${resolved.pair.effort}\` is unsupported for \`${resolved.family.id}\`. Run \`/bro config\` to fix this.`);
				continue;
			}
			pass(
				label,
				override
					? `override agy \`${resolved.family.id}\`${resolved.pair.effort === "default" ? "" : ` (${resolved.pair.effort})`}`
					: "using the shared default",
			);
		}
	}

	// bro_advisor has no on/off preference to compare against -- it is only ever gated by this
	// host's own tool restrictions, which this reads via pi.getAllTools()/pi.getActiveTools() and
	// never overrides. Exposed-but-inactive is the one genuine anomaly worth failing on.
	const advisorExposed = pi.getAllTools().some((tool) => tool.name === ADVISOR_TOOL_NAME);
	const advisorActive = pi.getActiveTools().includes(ADVISOR_TOOL_NAME);
	if (advisorExposed && !advisorActive) fail("Advisor tool", "bro_advisor is exposed but not active in this session. Run /reload.");
	else pass("Advisor tool", advisorExposed ? "bro_advisor is exposed and active" : "bro_advisor is not exposed by this host (tool restriction, or the extension has not finished loading)");
	pass("Advisor steering", resolveAdvisorState(ctx.sessionManager.getBranch()).steering.trim() ? "present" : "none");
	if (settings && capabilityBackend(settings, "advisor") === "claude") {
		pass("Advisor compatibility", "Claude backend — no Agy version floor applies");
	} else if (settings && capabilityBackend(settings, "advisor") === "grok") {
		pass("Advisor compatibility", "Grok backend — no Agy version floor applies; auth/connectivity unverified (no probe)");
	} else if (settings && capabilityBackend(settings, "advisor") === "codex") {
		pass("Advisor compatibility", "Codex backend — no Agy version floor applies");
	} else if (settings && capabilityBackend(settings, "advisor") === "muse") {
		pass("Advisor compatibility", "Muse backend — no Agy version floor applies; auth/connectivity unverified (no probe)");
	} else if (agyVersion && advisorAgyCompatible(agyVersion)) pass("Advisor compatibility", ADVISOR_COMPATIBILITY);
	else if (agyVersion) fail("Advisor compatibility", `installed \`${agyVersion}\`; requires Agy >=1.1.15. Run \`agy update\`.`);

	return `# Bro doctor\n\n${lines.join("\n")}\n\n**${failed ? "Bro needs attention." : "Bro is ready."}**\n\n${
		failed
			? "Fix the failed items, then press **R** to check again."
			: "No assistant response was sent and no model turn was run. Version/auth checks do not imply connectivity (Grok and Muse auth are unverified — no probe exists)."
	}`;
}

function latestAssistant(ctx: ExtensionCommandContext): BroSource | undefined {
	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason !== "stop") {
			continue;
		}

		const text = entry.message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();

		if (text) return { text };
	}
}

// /bro show: capture only the user- and assistant-visible conversation text of
// recent session turns and let the show prompt draw it as shapes. Tool calls,
// tool results, reasoning, and images never leave the session -- this is a
// structural role/content-type filter, not semantic or keyword-based. See
// docs/plans/2026-09-07-bro-show-visual-design.md (predates this change).
type ShowTurn = { entries: string[]; startsTurn: boolean };

function showTextContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			text += `${(part as { text?: string }).text ?? ""}\n`;
		}
	}
	return text.trim();
}

export function showEntriesForMessage(message: { role?: string; content?: unknown }): string[] {
	if (message.role === "user") {
		const text = showTextContent(message.content);
		return text ? [`## user\n${JSON.stringify(text)}`] : [];
	}
	if (message.role === "assistant") {
		const text = showTextContent(message.content);
		return text ? [`## assistant\n${JSON.stringify(text)}`] : [];
	}
	return [];
}

function serializeShowTurns(turns: readonly ShowTurn[]): string {
	return turns.flatMap((turn) => turn.entries).join("\n\n");
}

export function captureShowTranscript(ctx: ExtensionCommandContext, turnsRequested: number, maxLength = MAX_TEXT_LENGTH): BroSource | undefined {
	if (!Number.isSafeInteger(maxLength) || maxLength < 128) throw new Error("Transcript limit must be an integer of at least 128 characters.");
	const turns: ShowTurn[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; stopReason?: string };
		// Aborted assistant text is a half-written claim, not a report.
		if (message.role === "assistant" && message.stopReason === "abort") continue;
		const entries = showEntriesForMessage(message);
		// A user message always marks a turn boundary even when it has no
		// capturable text (image-only, whitespace-only): the turn must still
		// count, or /bro show 1 would silently over-capture earlier turns.
		if (message.role === "user") turns.push({ entries, startsTurn: true });
		else if (entries.length) turns.push({ entries, startsTurn: false });
	}

	let start = 0;
	let seen = 0;
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		if (!turns[index]!.startsTurn) continue;
		seen += 1;
		if (seen === turnsRequested) {
			start = index;
			break;
		}
	}
	if (seen === 0) return undefined;

	let text = serializeShowTurns(turns.slice(start));
	while (text.length > maxLength && start < turns.length - 1) {
		let next = turns.length;
		for (let index = start + 1; index < turns.length; index += 1) {
			if (turns[index]!.startsTurn) {
				next = index;
				break;
			}
		}
		if (next >= turns.length) break;
		start = next;
		text = serializeShowTurns(turns.slice(start));
	}
	if (text.length > maxLength) {
		// Prefer the newest complete messages even within an oversized single turn.
		const entries = turns.slice(start).flatMap(turn => turn.entries);
		const notice = "[… earlier messages truncated …]\n";
		while (entries.length > 1 && entries.join("\n\n").length + notice.length > maxLength) entries.shift();
		text = entries.join("\n\n");
		if (text.length + notice.length > maxLength) {
			const newline = text.indexOf("\n");
			const header = text.slice(0, newline);
			const content = JSON.parse(text.slice(newline + 1)) as string;
			const marker = "[… earlier text truncated …] ";
			let tail = content.slice(-(maxLength - header.length - marker.length - 8));
			while (`${header}\n${JSON.stringify(marker + tail)}`.length > maxLength) tail = tail.slice(Math.max(1, Math.floor(tail.length / 10)));
			text = `${header}\n${JSON.stringify(marker + tail)}`;
		} else text = notice + text;
	}
	const kept = turns.slice(start).filter((turn) => turn.startsTurn).length;
	return { text: text.trim(), label: `last ${Math.max(1, kept)} turn${kept > 1 ? "s" : ""} · conversation only` };
}

export interface ParsedShowArguments {
	// undefined means "use the configured default"; invalid leading numeric tokens report `invalid` instead.
	requested?: string;
	steering: string;
	invalid: boolean;
}

// A leading token is only ever treated as the turn count, never as the start of the query — so
// "/bro show 1 404 handler" is count 1, query "404 handler", not an ambiguous double-numeric query.
export function parseShowArguments(value: string): ParsedShowArguments {
	const firstSpace = value.search(/\s/);
	const firstToken = firstSpace === -1 ? value : value.slice(0, firstSpace);
	const looksLikeCount = firstToken !== "" && /^-?\d+(?:\.\d+)?$/.test(firstToken);
	if (!looksLikeCount) return { steering: value, invalid: false };

	// Slicing the raw remainder (instead of split(/\s+/).join(" ")) keeps the query's original spacing intact.
	const steering = firstSpace === -1 ? "" : value.slice(firstSpace).replace(/^\s+/, "");
	const valid = /^[1-9]\d*$/.test(firstToken) && Number.isSafeInteger(Number(firstToken));
	return { requested: valid ? firstToken : undefined, steering, invalid: !valid };
}

export function extractShowHtml(text: string): string | undefined {
	const fences = [...text.matchAll(/^```html[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gm)];
	return fences.at(-1)?.[1]?.trim();
}

export function stripShowHtmlFence(text: string): string {
	const matches = [...text.matchAll(/^```html[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gm)];
	const last = matches.at(-1);
	if (!last || last.index === undefined) return text;
	return text.slice(0, last.index) + "[HTML diagram saved — press O to open]" + text.slice(last.index + last[0].length);
}

export function showHtmlDirectory(): string {
	// ponytail: per-uid directory so keep-one cleanup never touches other
	// users' files in a shared /tmp, and readdir stays small.
	return join(tmpdir(), `pi-bro-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
}

function withShowCsp(html: string): string {
	// Defense in depth: the prompt forbids external resources and scripts;
	// a meta CSP blocks them anyway if the model slips. Always inserted: multiple
	// policies are enforced together, so a model-supplied CSP can only tighten it.
	// Skip only simple leading comments: browsers accept comment terminators that
	// a general regex misses. Ambiguous markup gets the policy prepended instead.
	const meta = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:;">';
	return html.replace(/^(\s*(?:<!--[^<>]*-->\s*)*(?:<!doctype[^>]*>\s*)?)/i, `$1\n${meta}\n`);
}

export async function writeShowHtml(html: string): Promise<string> {
	const slug = createHash("sha256").update(html).digest("hex").slice(0, 8);
	const directory = showHtmlDirectory();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	for (const name of await readdir(directory)) {
		if (SHOW_HTML_FILE_PATTERN.test(name)) await rm(join(directory, name), { force: true });
	}
	const path = join(directory, `bro-show-${slug}.html`);
	await writeFile(path, `${withShowCsp(html)}\n`, "utf8");
	return path;
}

function openShowHtml(path: string): boolean {
	if (process.platform === "win32") {
		const result = spawnSync("cmd", ["/c", "start", "", path], { stdio: "ignore", timeout: 5_000 });
		return result.status === 0;
	}
	const opener = process.platform === "darwin" ? "open" : "xdg-open";
	const result = spawnSync(opener, [path], { stdio: "ignore", timeout: 5_000 });
	return result.status === 0;
}

// Raw file text for the editor, undefined when there is no file: never rejects for length, so an
// oversize file can be opened and trimmed.
export async function readPreferencesRaw(): Promise<string | undefined> {
	let size: number;
	try {
		size = (await stat(PREFERENCES_FILE)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Cannot read ${PREFERENCES_FILE}: ${errorMessage(error)}`);
	}
	if (size > MAX_PREFERENCES_FILE_BYTES) throw new Error(`${PREFERENCES_FILE} is larger than 64 KB. Edit or delete it directly.`);
	try {
		return (await readFile(PREFERENCES_FILE, "utf8")).replace(/^\uFEFF/, "");
	} catch (error) {
		throw new Error(`Cannot read ${PREFERENCES_FILE}: ${errorMessage(error)}`);
	}
}

// Preferences for prompts: "" when absent or blank. Re-read on every request. An oversize file stops
// the request before any backend call instead of being silently truncated.
export async function readPreferences(): Promise<string> {
	const text = ((await readPreferencesRaw()) ?? "").trim();
	if (text.length > MAX_PREFERENCES_CHARS) {
		throw new Error(`${PREFERENCES_FILE} is ${text.length.toLocaleString("en-US")} characters; keep it under ${MAX_PREFERENCES_CHARS.toLocaleString("en-US")} (it's sent with every request). Use /bro preferences to trim it.`);
	}
	return text;
}

async function simplify(
	response: string,
	signal: AbortSignal,
	settings: BroSettings,
	onProgress?: (text: string) => void,
	mode = settings.mode,
): Promise<{ text: string; model: string; mode: BroMode; preferences: boolean }> {
	const selection = selectionForCapability(settings, "explain");
	const preferences = await readPreferences();
	const text = await runAgyText(buildDefaultPrompt(response, mode, preferences), selection, signal, onProgress);
	return { text, model: selectionLabel(selection), mode, preferences: Boolean(preferences) };
}

async function runShowExplanation(
	transcript: string,
	steering: string,
	signal: AbortSignal,
	settings: BroSettings,
	onProgress?: (text: string) => void,
): Promise<{ text: string; model: string; preferences: boolean }> {
	const selection = selectionForCapability(settings, "show");
	const preferences = await readPreferences();
	const text = await runAgyText(buildShowPrompt(transcript, steering, preferences), selection, signal, onProgress, "show");
	return { text, model: selectionLabel(selection), preferences: Boolean(preferences) };
}

// Thin presentation-boundary wrapper around the shared backend: coalesces raw text progress to the
// existing 75ms cadence (unchanged from before the backend extraction) and translates the backend's
// tagged outcome back into this function's existing throw-on-failure contract.
async function runAgyText(
	prompt: string,
	selection: BackendSelection,
	signal: AbortSignal,
	onProgress?: (text: string) => void,
	feature: "explain" | "show" = "explain",
): Promise<string> {
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	let latest: string | undefined;
	const throttledProgress = onProgress
		? (progress: BackendProgress) => {
				if (progress.kind !== "text") return;
				latest = progress.text;
				if (!updateTimer) {
					updateTimer = setTimeout(() => {
						updateTimer = undefined;
						if (!signal.aborted && latest !== undefined) onProgress(latest);
					}, 75);
				}
			}
		: undefined;

	try {
		const outcome = await executeBackend({ feature, prompt, access: "restricted" }, selection, signal, throttledProgress);
		if (outcome.status === "success") return outcome.text;
		throw new Error(outcome.message);
	} finally {
		if (updateTimer) clearTimeout(updateTimer);
	}
}

// Harness-neutral advisor context snapshot: plain role/text/tool-name+args/tool-result-text, not
// Pi's internal message objects serialized as-is, so the shape isn't a Pi-specific contract. Every
// piece of free-text message content is JSON-quoted (the same "quote the source as data" convention
// SOURCE_GUARD/buildShowPrompt/buildBtwPrompt already use in prompt.ts) rather than pasted in raw
// after a bare "## role" heading: unquoted text under a heading would let pasted text or tool output
// forge a fake "## user"/"## assistant" section that looks like a real turn boundary. See
// docs/plans/2026-09-19-bro-advisor-design.md, "Context snapshot".
type AdvisorMessageLike = { role?: unknown; content?: unknown; toolName?: unknown; toolCallId?: unknown; isError?: unknown };

// Parameter element type of Pi's own AgentMessage → LLM converter (core/messages.ts), reused below
// instead of redeclaring BashExecutionMessage's shape (it isn't exported from the package root).
type AdvisorAgentMessage = Parameters<typeof convertToLlm>[0][number];

function advisorQuoted(text: string): string {
	return JSON.stringify(text);
}

// `resolvedToolCallIds` lets a still-pending bro_advisor call (the one currently in flight for this
// very consultation, which by definition has no result yet) be dropped instead of rendered as an
// orphaned, unresolved call — a past, completed bro_advisor call is unaffected and renders normally.
function advisorContentText(content: unknown, resolvedToolCallIds: ReadonlySet<string>): string {
	if (typeof content === "string") {
		const text = content.trim();
		return text ? advisorQuoted(text) : "";
	}
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const type = (part as { type?: string }).type;
		if (type === "text" && typeof (part as { text?: unknown }).text === "string") {
			const text = (part as { text: string }).text.trim();
			if (text) parts.push(advisorQuoted(text));
		} else if (type === "image") {
			parts.push("[image omitted]");
		} else if (type === "thinking") {
			parts.push("[reasoning omitted]");
		} else if (type === "toolCall") {
			const call = part as { id?: unknown; name?: unknown; arguments?: unknown };
			const id = typeof call.id === "string" ? call.id : undefined;
			const name = typeof call.name === "string" ? call.name : "(unknown)";
			if (name === ADVISOR_TOOL_NAME && (!id || !resolvedToolCallIds.has(id))) continue;
			parts.push(`[tool call${id ? ` #${id}` : ""}] ${name}(${JSON.stringify(call.arguments ?? {})})`);
		}
	}
	return parts.join("\n").trim();
}

function renderAdvisorMessage(message: AdvisorMessageLike, resolvedToolCallIds: ReadonlySet<string>): string {
	if (message.role === "user") {
		const text = advisorContentText(message.content, resolvedToolCallIds);
		return text ? `## user\n${text}` : "";
	}
	if (message.role === "assistant") {
		const text = advisorContentText(message.content, resolvedToolCallIds);
		return text ? `## assistant\n${text}` : "";
	}
	if (message.role === "toolResult") {
		const name = typeof message.toolName === "string" ? message.toolName : "(unknown)";
		const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
		const header = `## tool result${id ? ` [#${id}]` : ""}: ${name}${message.isError ? " · error" : ""}`;
		const text = advisorContentText(message.content, resolvedToolCallIds);
		return text ? `${header}\n${text}` : header;
	}
	if (message.role === "bashExecution") {
		// Reuse Pi's own AgentMessage -> LLM conversion instead of hand-rolling one: it already
		// drops a command run with the `!!` prefix (excludeFromContext) and formats the rest exactly
		// as Pi's own context builder would, so a `!`-run command an executor can see is not silently
		// missing from what the advisor sees.
		const [converted] = convertToLlm([message as AdvisorAgentMessage]);
		if (!converted) return "";
		const text = advisorContentText(converted.content, resolvedToolCallIds);
		return text ? `## bash execution\n${text}` : "";
	}
	return "";
}

export function buildAdvisorSnapshot(ctx: ExtensionContext, pi: ExtensionAPI): { text: string; hadCompaction: boolean } {
	const systemPrompt = ctx.getSystemPrompt().trim();

	const activeToolNames = new Set(pi.getActiveTools().filter((name) => name !== ADVISOR_TOOL_NAME));
	const tools = pi.getAllTools().filter((tool) => activeToolNames.has(tool.name)).sort((a, b) => a.name.localeCompare(b.name));
	// No truncation of tool descriptions: Bro imposes no size cap on the snapshot (see the design
	// doc) and an arbitrary slice would silently drop part of a tool's actual behavior contract.
	const toolsSection = tools.length
		? tools.map((tool) => `- ${tool.name}: ${tool.description.replace(/\s+/g, " ").trim()}`).join("\n")
		: "(none)";

	const entries = ctx.sessionManager.buildContextEntries();
	const resolvedToolCallIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as AdvisorMessageLike;
		if (message.role === "toolResult" && typeof message.toolCallId === "string") resolvedToolCallIds.add(message.toolCallId);
	}

	const lines: string[] = [];
	// Tracked from the actual entry type, not a substring search over the rendered snapshot text --
	// free-text content (a file the executor read, a pasted paragraph) is JSON-quoted but not
	// stripped of "#", so a substring check could be forged by source data that happens to contain
	// the literal heading text. Only a real `compaction` entry may set this.
	let hadCompaction = false;
	for (const entry of entries) {
		if (entry.type === "message") {
			const rendered = renderAdvisorMessage(entry.message as AdvisorMessageLike, resolvedToolCallIds);
			if (rendered) lines.push(rendered);
		} else if (entry.type === "compaction") {
			// buildContextEntries() already includes every real entry after the compaction point;
			// the summary is all there is to represent for what it replaced.
			hadCompaction = true;
			lines.push(`## compacted earlier context\n${advisorQuoted(entry.summary)}`);
		} else if (entry.type === "branch_summary") {
			lines.push(`## abandoned branch summary\n${advisorQuoted(entry.summary)}`);
		} else if (entry.type === "custom_message") {
			const text = advisorContentText(entry.content, resolvedToolCallIds);
			if (text) lines.push(`## extension message: ${entry.customType}\n${text}`);
		}
		// "custom" entries (including our own advisor activation/steering state) are intentionally
		// skipped — they never participate in LLM context and must not leak into the snapshot either.
	}
	const conversationSection = lines.length ? lines.join("\n\n") : "(no conversation content captured)";

	const text = `## Executor's system instructions\n\n${systemPrompt ? advisorQuoted(systemPrompt) : "(none)"}\n\n## Executor's active tools\n\n${toolsSection}\n\n## Conversation so far (message text is quoted as JSON strings; includes tool calls and results, correlated by call id; image and reasoning content is noted but omitted; the still-pending advisor call for this very consultation is omitted)\n\n${conversationSection}`;
	return { text, hadCompaction };
}

const MAX_ADVISOR_ACTIVITY_LINES = 4;
const ADVISOR_ACTIVITY_PREVIEW_CHARS = 100;

function advisorActivityPreview(label: string): string {
	return label.length > ADVISOR_ACTIVITY_PREVIEW_CHARS ? `${label.slice(0, ADVISOR_ACTIVITY_PREVIEW_CHARS).trimEnd()}…` : label;
}

export type AdvisorActivityCallback = (label: string, timestamp: number) => void;

// Thin wrapper around the shared backend: advisor's stdin/stream-json transport, activity parsing,
// and process lifecycle now live in backend.ts (see docs/plans/2026-09-19-bro-advisor-design.md,
// "Transport" for why stdin rather than --print). This function keeps its exact existing
// signature/throw contract -- it is called directly by tests and by runAdvisorWithRetries below,
// which owns the 3-attempt retry/backoff policy the backend itself never performs.
export class TerminalConsultError extends Error {
	readonly status: "failure" | "cancelled" | "timeout";
	constructor(status: "failure" | "cancelled" | "timeout", message: string) {
		super(message);
		this.status = status;
	}
}

export async function runAdvisorConsultation(
	prompt: string,
	selection: BackendSelection,
	cwd: string,
	signal: AbortSignal,
	killEscalationMs = 5_000,
	onActivity?: AdvisorActivityCallback,
	deadlineMs?: number,
): Promise<string> {
	const outcome = await executeBackend(
		{ feature: "advisor", prompt, access: "workspace-full", cwd },
		selection,
		signal,
		onActivity
			? (progress) => {
					if (progress.kind === "activity") onActivity(progress.label, progress.timestamp);
				}
			: undefined,
		{ killEscalationMs, deadlineMs },
	);
	if (outcome.status === "success") return outcome.text;
	throw new TerminalConsultError(outcome.status, outcome.message);
}

function advisorDelay(ms: number, signal: AbortSignal, onTick?: (remainingMs: number) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Canceled."));
			return;
		}
		const startedAt = Date.now();
		const interval = onTick ? setInterval(() => onTick(Math.max(0, ms - (Date.now() - startedAt))), 1_000) : undefined;
		interval?.unref();
		const cleanup = () => {
			clearTimeout(timer);
			if (interval) clearInterval(interval);
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error("Canceled."));
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export type AdvisorConsult = (
	prompt: string,
	selection: BackendSelection,
	cwd: string,
	signal: AbortSignal,
	killEscalationMs?: number,
	onActivity?: AdvisorActivityCallback,
) => Promise<string>;
export type AdvisorDelayFn = (ms: number, signal: AbortSignal, onTick?: (remainingMs: number) => void) => Promise<void>;
export type AdvisorToolDetails = {
	status: "investigating" | "retrying" | "done";
	attempt: number;
	of: number;
	elapsedMs: number;
	error?: string;
	retryInMs?: number;
	backend?: BackendName;
	model?: string;
	effort?: string;
	durationMs?: number;
	cwd?: string;
	steeringIncluded?: boolean;
	snapshotChars?: number;
	broTruncated?: false;
	omissions?: string;
	// Real Agy-reported activity for the current attempt only -- reset to empty whenever a new
	// attempt (including a retry) starts, never carried over from a prior failed attempt.
	activity?: string[];
	lastActivityAt?: number;
	// Total count of accepted activity events (tool calls AND user-facing text deltas -- "activity"
	// is the honest label, not "tool calls") observed across the whole consultation, including every
	// retry attempt. Unlike `activity` above, this never resets on a retry; the final "done" details
	// carry the same running total.
	activityCount?: number;
};
export type AdvisorProgressCallback = (details: AdvisorToolDetails) => void;
export type AdvisorRunResult = { advice: string; attempts: number; durationMs: number; activityCount: number };

// Bursts of chunked NDJSON activity events are coalesced to this cadence so a fast stream of tool
// calls/text deltas doesn't flood onProgress; the 1s elapsed-time heartbeat below is unaffected and
// keeps ticking independently.
const ADVISOR_ACTIVITY_THROTTLE_MS = 250;

// `consult`/`delayFn` are injectable so tests can swap in a fake agy spawn and a fake clock
// instead of spawning real processes and waiting 15 real seconds. Every attempt sends the
// identical prompt/selection/cwd to a fresh, standalone Agy process — never resumed via
// --conversation, even across retries.
export async function runAdvisorWithRetries(
	prompt: string,
	selection: BackendSelection,
	cwd: string,
	signal: AbortSignal,
	consult: AdvisorConsult = runAdvisorConsultation,
	delayFn: AdvisorDelayFn = advisorDelay,
	onProgress?: AdvisorProgressCallback,
	progressIntervalMs = 1_000,
	activityThrottleMs = ADVISOR_ACTIVITY_THROTTLE_MS,
): Promise<AdvisorRunResult> {
	const delays = [5_000, 10_000];
	const totalAttempts = delays.length + 1;
	const startedAt = Date.now();
	let lastError: unknown;
	// Cumulative across every attempt in this consultation, including retries -- unlike `activity`
	// below, a retry must never reset this back to zero.
	let totalActivityCount = 0;
	for (let attempt = 0; attempt <= delays.length; attempt++) {
		if (signal.aborted) throw new Error("Canceled.");
		// Fresh per attempt: a retry must never show the previous attempt's activity trail.
		const activity: string[] = [];
		let lastActivityAt: number | undefined;
		let lastActivityEmitAt = 0;
		let pendingActivityTimer: ReturnType<typeof setTimeout> | undefined;

		const running = (): AdvisorToolDetails => ({
			status: "investigating",
			attempt: attempt + 1,
			of: totalAttempts,
			elapsedMs: Date.now() - startedAt,
			activity: [...activity],
			lastActivityAt,
			activityCount: totalActivityCount,
		});
		const emitRunning = () => onProgress?.(running());
		emitRunning();
		const progressTimer = onProgress ? setInterval(emitRunning, progressIntervalMs) : undefined;
		progressTimer?.unref();

		const stopActivityThrottle = () => {
			if (pendingActivityTimer) {
				clearTimeout(pendingActivityTimer);
				pendingActivityTimer = undefined;
			}
		};
		const onActivity: AdvisorActivityCallback = (label, timestamp) => {
			const normalized = label.replace(/\s+/g, " ").trim();
			if (!normalized) return;
			activity.push(normalized);
			if (activity.length > MAX_ADVISOR_ACTIVITY_LINES) activity.splice(0, activity.length - MAX_ADVISOR_ACTIVITY_LINES);
			totalActivityCount += 1;
			lastActivityAt = timestamp;
			if (!onProgress) return;
			const elapsed = Date.now() - lastActivityEmitAt;
			if (elapsed >= activityThrottleMs) {
				lastActivityEmitAt = Date.now();
				emitRunning();
				return;
			}
			if (!pendingActivityTimer) {
				pendingActivityTimer = setTimeout(() => {
					pendingActivityTimer = undefined;
					lastActivityEmitAt = Date.now();
					emitRunning();
				}, activityThrottleMs - elapsed);
				pendingActivityTimer.unref?.();
			}
		};

		try {
			const advice = await consult(prompt, selection, cwd, signal, undefined, onActivity);
			// `totalActivityCount` is read directly here rather than from the last onProgress snapshot,
			// which may lag behind by up to `activityThrottleMs` -- the final count must be exact.
			return { advice, attempts: attempt + 1, durationMs: Date.now() - startedAt, activityCount: totalActivityCount };
		} catch (error) {
			if (progressTimer) clearInterval(progressTimer);
			stopActivityThrottle();
			if (signal.aborted || errorMessage(error) === "Canceled." ||
				(error instanceof TerminalConsultError && error.status !== "failure")) throw error;
			lastError = error;
			if (attempt === delays.length) break;
			const delay = delays[attempt]!;
			const retrying = (remainingMs: number): AdvisorToolDetails => ({
				status: "retrying",
				attempt: attempt + 2,
				of: totalAttempts,
				elapsedMs: Date.now() - startedAt,
				error: errorMessage(error),
				retryInMs: remainingMs,
				activityCount: totalActivityCount,
			});
			onProgress?.(retrying(delay));
			await delayFn(delay, signal, (remainingMs) => onProgress?.(retrying(remainingMs)));
		} finally {
			if (progressTimer) clearInterval(progressTimer);
			stopActivityThrottle();
		}
	}
	throw lastError;
}

export function advisorAttemptLabel(details: AdvisorToolDetails): string {
	if (details.status === "retrying") {
		return `Bro advisor · retrying in ${Math.ceil((details.retryInMs ?? 0) / 1_000)}s · attempt ${details.attempt}/${details.of}${details.error ? ` — ${details.error}` : ""}`;
	}
	if (details.status === "done") {
		return `Bro advisor · ${details.model ?? "unknown model"} · ${details.attempt} attempt${details.attempt === 1 ? "" : "s"} · ${Math.ceil((details.durationMs ?? details.elapsedMs) / 1_000)}s`;
	}
	const latest = details.activity?.at(-1);
	const backendLabel = details.backend === "claude" ? "Claude" : details.backend === "grok" ? "Grok" : details.backend === "codex" ? "Codex" : details.backend === "muse" ? "Muse" : "Agy";
	// "last reported" + freshness, never a claim about what the backend is doing right now and never
	// "stalled" -- silence since lastActivityAt is not itself evidence of a stuck run.
	const activityLabel = latest
		? `last reported: ${advisorActivityPreview(latest)} (${Math.max(0, Math.floor((Date.now() - (details.lastActivityAt ?? Date.now())) / 1_000))}s ago)`
		: `awaiting first activity from ${backendLabel}`;
	return `Bro advisor · running · ${Math.floor(details.elapsedMs / 1_000)}s · attempt ${details.attempt}/${details.of} · ${activityLabel}`;
}

export async function showBroConfigModal(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	if (!hasBroCustomUi(ctx)) {
		ctx.ui.notify("Use /bro config in Pi's interactive UI.", "warning");
		return;
	}
	let settings: BroSettings;
	try {
		settings = await readSettings();
	} catch (error) {
		ctx.ui.notify(withDoctor(error), "error");
		return;
	}
	// Keep configuration repair accessible even when the Agy catalog is unavailable.
	let families: AgyModelFamily[];
	try {
		families = await listAgyModels(pi);
	} catch (error) {
		families = [];
		ctx.ui.notify("Agy model catalog unavailable — showing other backend settings without Agy choices.", "warning");
	}
	await ctx.ui.custom<void>(createConfigModal(settings, families, writeSettings), {
		overlay: true,
		overlayOptions: {
			width: "78%",
			minWidth: 48,
			maxHeight: "78%",
			anchor: "top-center",
			margin: { top: 1, left: 2, right: 2 },
		},
	});
}

type TextEditorModalOptions = {
	title: string;
	subtitle: string;
	initialText: string;
	initialNotice?: string;
	// Returns an error message to refuse the save without calling onSave.
	validate?: (text: string) => string | undefined;
	// Either may be async; the modal then waits, ignores further edits, and reports success only once it settles.
	onSave: (text: string) => void | Promise<void>;
	onClear: () => void | Promise<void>;
	copy?: (text: string) => Promise<void>;
};

// Testable core shared by /bro advisor-steer and /bro preferences: persistence only happens on
// Ctrl+S/Ctrl+K. Esc leaves the stored text untouched; only the in-memory draft is discarded.
export function createTextEditorModal(
	options: TextEditorModalOptions,
): (tui: TUI, theme: Theme, keybindings: unknown, done: (value?: void) => void) => Component & { dispose?(): void } {
	const { onSave, onClear, validate, copy = copyToClipboard } = options;
	return (tui, theme, _keybindings, done) => {
		const editorTheme: EditorTheme = { borderColor: (s: string) => theme.fg("border", s), selectList: getSelectListTheme() };
		const editor = new Editor(tui, editorTheme);
		editor.focused = true;
		editor.setText(options.initialText);
		let disposed = false;
		let pending = false;
		const notice = new Text(options.initialNotice ? theme.fg("accent", options.initialNotice) : "");
		const showNotice = (message: string, color: "success" | "error") => {
			if (disposed) return;
			notice.setText(theme.fg(color, message));
			tui.requestRender();
		};
		editor.onChange = () => notice.setText("");
		const persist = (action: () => void | Promise<void>, success: string, failure: string, after?: () => void) => {
			const fail = (error: unknown) => showNotice(`${failure}: ${errorMessage(error)}`, "error");
			let result: void | Promise<void>;
			try {
				result = action();
			} catch (error) {
				fail(error);
				return;
			}
			if (!(result instanceof Promise)) {
				after?.();
				showNotice(success, "success");
				return;
			}
			pending = true;
			result.then(
				() => {
					pending = false;
					if (disposed) return;
					after?.();
					showNotice(success, "success");
				},
				(error) => {
					pending = false;
					fail(error);
				},
			);
		};

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(options.title))));
		container.addChild(new Text(theme.fg("dim", options.subtitle)));
		container.addChild(editor);
		container.addChild(notice);
		container.addChild(new Text(theme.fg("dim", "Ctrl+S save · Enter newline · Ctrl+K clear · Ctrl+C copy · Esc close")));

		return {
			render: (w: number) => {
				const inner = Math.max(1, w - 4);
				const border = (left: string, right: string) => theme.fg("border", left + "─".repeat(inner + 2) + right);
				return [border("┌", "┐"), ...container.render(inner).map((line) => {
					const text = truncateToWidth(line, inner, "");
					return theme.fg("border", "│") + " " + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + " " + theme.fg("border", "│");
				}), border("└", "┘")];
			},
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "escape")) {
					disposed = true;
					done(undefined);
					return;
				}
				if (pending) return;
				if (matchesKey(data, "ctrl+s")) {
					const text = editor.getExpandedText();
					const invalid = validate?.(text);
					if (invalid) {
						showNotice(invalid, "error");
						return;
					}
					persist(() => onSave(text), "Saved", "Save failed");
					return;
				}
				if (matchesKey(data, "ctrl+k")) {
					persist(onClear, "Cleared", "Clear failed", () => editor.setText(""));
					return;
				}
				if (matchesKey(data, "ctrl+c")) {
					const text = editor.getExpandedText();
					void Promise.resolve()
						.then(() => copy(text))
						.then(() => showNotice("Copied", "success"))
						.catch((error) => showNotice(`Copy failed: ${errorMessage(error)}`, "error"));
					return;
				}
				if (matchesKey(data, "enter")) {
					editor.insertTextAtCursor("\n");
					tui.requestRender();
					return;
				}
				editor.handleInput(data);
				tui.requestRender();
			},
			dispose: () => { disposed = true; },
		};
	};
}

export function createAdvisorSteerModal(
	initialText: string,
	onSave: (text: string) => void,
	onClear: () => void,
	copy: (text: string) => Promise<void> = copyToClipboard,
): ReturnType<typeof createTextEditorModal> {
	return createTextEditorModal({
		title: "Bro · advisor steer",
		subtitle: "One persistent steering brief the advisor always sees — never sent to the main model.",
		initialText,
		onSave,
		onClear,
		copy,
	});
}

function preferencesTooLong(text: string): string | undefined {
	const length = text.replace(/^\uFEFF/, "").trim().length;
	return length > MAX_PREFERENCES_CHARS
		? `${length.toLocaleString("en-US")}/${MAX_PREFERENCES_CHARS.toLocaleString("en-US")} characters — trim before saving`
		: undefined;
}

// Testable core for /bro preferences. A missing file opens with the unsaved starter text; an
// unreadable or oversize-on-disk file opens empty with the error, and Clear still works.
export function createPreferencesModal(
	loaded: { text?: string; error?: string },
	persist: { save: (text: string) => Promise<void>; clear: () => Promise<void> },
	copy?: (text: string) => Promise<void>,
): ReturnType<typeof createTextEditorModal> {
	const starter = loaded.text === undefined && !loaded.error;
	return createTextEditorModal({
		title: "Bro · preferences",
		subtitle: "About you and how you like answers. Sent to the selected backend with every explain, show, and btw request — never to the advisor or Pi's main model.",
		initialText: starter ? STARTER_PREFERENCES : (loaded.text ?? ""),
		initialNotice: loaded.error ?? (starter ? "Starter text — not saved. Ctrl+S saves it; Esc leaves no file." : undefined),
		validate: preferencesTooLong,
		onSave: persist.save,
		onClear: persist.clear,
		copy,
	});
}

// Saves and deletes run one at a time, even across a closed and reopened editor, so a slow delete
// from an earlier editor can never remove a file saved by a later one.
let preferencesWrites: Promise<void> = Promise.resolve();
export function queuePreferencesWrite(write: () => Promise<void>): Promise<void> {
	const next = preferencesWrites.then(write);
	preferencesWrites = next.catch(() => {});
	return next;
}

export async function showPreferencesModal(ctx: ExtensionCommandContext): Promise<void> {
	if (!hasBroCustomUi(ctx)) {
		ctx.ui.notify(`Edit ${PREFERENCES_FILE} directly.`, "warning");
		return;
	}
	let loaded: { text?: string; error?: string };
	try {
		const text = await readPreferencesRaw();
		loaded = text === undefined ? {} : { text };
	} catch (error) {
		loaded = { error: `${errorMessage(error)} Ctrl+K deletes it.` };
	}
	await ctx.ui.custom<void>(
		createPreferencesModal(loaded, {
			// ponytail: last writer wins against external edits while the editor is open, like writeSettings.
			save: (text) => queuePreferencesWrite(() => writeFile(PREFERENCES_FILE, `${text.trim()}\n`, "utf8")),
			clear: () => queuePreferencesWrite(() => rm(PREFERENCES_FILE, { force: true })),
		}),
		{
			overlay: true,
			overlayOptions: { width: "78%", minWidth: 48, maxHeight: "60%", anchor: "top-center", margin: { top: 1, left: 2, right: 2 } },
		},
	);
}

export async function showAdvisorSteerModal(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	if (!hasBroCustomUi(ctx)) {
		ctx.ui.notify("Use /bro advisor-steer in Pi's interactive UI.", "warning");
		return;
	}
	const { steering } = resolveAdvisorState(ctx.sessionManager.getBranch());
	await ctx.ui.custom<void>(
		createAdvisorSteerModal(
			steering,
			(text) => pi.appendEntry(ADVISOR_STEERING_ENTRY, { text }),
			() => pi.appendEntry(ADVISOR_STEERING_ENTRY, { text: "" }),
		),
		{
			overlay: true,
			overlayOptions: { width: "78%", minWidth: 48, maxHeight: "60%", anchor: "top-center", margin: { top: 1, left: 2, right: 2 } },
		},
	);
}

// `preferences` is a ready status ("off", "on (312 characters)", or "error: …") so a preferences
// problem never hides Help or mixes with settings errors.
export function helpText(settings?: BroSettings, settingsError?: string, preferences = "off"): string {
	const overrideLines = settings
		? CAPABILITIES.map((capability) => {
				const override = capabilityOverride(settings, capability);
				return override
					? `- **${CAPABILITY_LABELS[capability]} override:** ${override.backend ?? "agy"} \`${override.model}\`${override.effort === "default" ? "" : ` (${override.effort})`}`
					: undefined;
			}).filter((line): line is string => line !== undefined)
		: [];
	const settingsSummary = settings
		? `- **Backend:** ${settings.backend ?? "agy"}\n- **Model:** \`${settings.model}\`\n- **Reasoning effort:** ${settings.effort === "default" ? "built into the selected model" : settings.effort}\n- **Mode:** ${settings.mode}\n- **Show turns:** ${settings.showTurns}${overrideLines.length ? `\n${overrideLines.join("\n")}` : ""}`
		: `Bro could not read its settings: ${settingsError}\n\nRun \`/bro doctor\` for setup help.`;
	return `# Bro

Quick reference. The README is the full user guide: https://github.com/tranhoangnguyen03/pi-bro#readme

## Explain and show

- \`/bro\` or \`/bro simplify\` — explain the latest completed assistant reply
- \`/bro text [text]\` — explain pasted text, or the latest reply when text is omitted
- \`/bro file <path>\` — explain a workspace \`.md\`, \`.markdown\`, \`.txt\`, \`.pdf\`, or \`.docx\` file
- \`/bro url <url>\` — explain one public webpage
- \`/bro <input>\` — a lone URL, an existing supported file, or anything else as pasted text
- \`/bro open\` — reopen the latest explanation without a new request
- \`/bro show [n-turns] [query]\` — draw recent turns' conversation text as shapes; an optional query steers the focus

## Side conversation

- \`/bro btw [question]\` — open a side conversation seeded with recent main-session context. It starts conversation-only; reopening keeps the thread and its mode.
- Inside the modal: Enter asks (empty Enter re-asks); \`/mode\` toggles conversation-only / full permission (read and edit the workspace) and keeps the thread; \`/copy\` and \`/copy-all\` copy to the clipboard; \`/insert\` and \`/insert-all\` insert into an empty main editor without submitting; \`/retry\` re-asks; \`/clear\` resets. Any other text is sent as a question. Esc closes.

## Advisor

- \`bro_advisor\` — a tool the executor agent may call for a second opinion from a fresh backend process with real, auto-approved workspace access; it is told to advise, not edit, but that is not enforced
- \`/bro advisor\` — whether \`bro_advisor\` is available right now
- \`/bro advisor-steer\` — edit the session's persistent steering brief (**Ctrl+S** save, **Ctrl+K** clear, **Ctrl+C** copy, **Esc** close)

## Configure and check

- \`/bro preferences\` — tell Bro about yourself and how you like answers; added to explain, show, and btw prompts, never the advisor (**Ctrl+S** save, **Ctrl+K** delete, **Ctrl+C** copy, **Esc** close)
- \`/bro config\` — shared default and per-capability (explain/show/btw/advisor) backend, model, and effort; explain mode; show turns. Changes save immediately.
- \`/bro mode [brief|balanced|faithful]\` — view or choose the explanation mode
- \`/bro doctor\` — check settings, preferences, and every selected backend without running a model turn

## Current settings

${settingsSummary}
- **Preferences:** ${preferences} — \`/bro preferences\`

Saved in \`${settingsFile()}\` and \`${PREFERENCES_FILE}\`.

## Explanation modes

- brief — the main point and next action, with no fixed word target
- balanced — default; material detail with clearer structure
- faithful — closest to the source, with no fixed word limit

Press **M** in an explanation to re-simplify it in the next mode without changing the saved one.

The mode decides how much of the source to keep; your preferences decide who it's written for, its tone, and its language. Neither overrides Bro's source rules.

## Controls

- **Mouse wheel / trackpad**, **↑ / ↓** — scroll
- **C** — copy the full explanation
- **R** — repeat the current action (an explanation keeps its mode)
- **M** — re-simplify in the next mode (brief → balanced → faithful); not saved
- **O** — open the HTML diagram when a show reply contains one
- **Esc** — close, or cancel while Bro is working

## Privacy

Bro sends the captured source (or, for the advisor, the executor's instructions, tools, and conversation) to the selected backend and its model provider, which may retain it under their own policies. Your preferences go with every explain, show, and btw request. Nothing is added to Pi's conversation unless you insert it. Access controls differ by backend; see the README.`;
}

// The overlay framing pattern is adapted from pi-btw (MIT); see THIRD_PARTY_NOTICES.md.
class BroModal implements Focusable {
	focused = false;
	private readonly markdown = new Markdown("", 0, 0, getMarkdownTheme());
	private kind: ModalKind = "loading";
	private rawText = "";
	private sourceLabel = "";
	private modelLabel = "";
	private notice = "";
	private offset = 0;
	private maxOffset = 0;
	private bodyHeight = 1;
	private copyable = false;
	private retryable = false;
	private disposed = false;
	private htmlPath = "";
	// Survives loading/streaming so the header names the mode being produced; empty disables M.
	private modeLabel = "";
	// Set only with a result, so the tag never claims preferences for work still in flight.
	private preferencesUsed = false;

	constructor(
		private readonly tui: TuiLike,
		private readonly theme: Theme,
		private readonly onClose: () => void,
		private readonly onRetry: () => void,
		private readonly onDispose: () => void,
		private readonly retryLabel: string,
		private readonly onSwitchMode: () => void = () => {},
	) {
		setRegularMouseReporting(this.tui, true);
	}

	setLoading(text = LOADING_TEXT): void {
		this.setContent("loading", `**${text}**`, "", false, false);
	}

	setStreaming(text: string): void {
		this.setContent("streaming", text, "", false, false);
	}

	setResult(text: string, retryable: boolean, notice = "", sourceLabel = "", rawText = text, modelLabel = ""): void {
		this.setContent("result", text, rawText, true, retryable, notice, sourceLabel, modelLabel);
	}

	setHtmlPath(path: string): void {
		this.htmlPath = path;
		this.tui.requestRender();
	}

	setMode(mode: BroMode | undefined): void {
		this.modeLabel = mode ?? "";
		this.tui.requestRender();
	}

	setPreferences(used: boolean): void {
		this.preferencesUsed = used;
		this.tui.requestRender();
	}

	setStatic(kind: "help" | "empty", text: string, copyable: boolean): void {
		this.setContent(kind, text, text, copyable, false);
	}

	setError(message: string): void {
		this.setContent("error", `# Bro ran into a problem\n\n${message}`, "", false, true);
	}

	private setContent(
		kind: ModalKind,
		text: string,
		rawText: string,
		copyable: boolean,
		retryable: boolean,
		notice = "",
		sourceLabel = "",
		modelLabel = "",
	): void {
		this.kind = kind;
		if (kind !== "result") this.htmlPath = "";
		this.rawText = rawText;
		this.copyable = copyable;
		this.retryable = retryable;
		this.notice = notice;
		this.sourceLabel = stripVTControlCharacters(sourceLabel)
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		this.modelLabel = modelLabel;
		if (kind !== "streaming") this.offset = 0;
		this.markdown.setText(text);
		this.tui.requestRender();
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	private ruleLine(innerWidth: number): string {
		return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
	}

	private canSwitchMode(): boolean {
		return Boolean(this.modeLabel) && (this.kind === "loading" || this.kind === "streaming" || this.kind === "result");
	}

	private controls(): string {
		const mode = this.canSwitchMode() ? " · M mode" : "";
		if (this.kind === "loading") return mode ? "M mode · Esc cancel" : "Esc cancel";
		if (this.kind === "streaming") return `Simplifying… · ↑/↓ scroll${mode} · Esc cancel`;
		if (this.kind === "result") {
			return `↑/↓ scroll · C copy${this.htmlPath ? " · O open diagram" : ""}${mode}${this.retryable ? ` · R ${this.retryLabel}` : ""} · Esc close`;
		}
		if (this.kind === "help") return "↑/↓ scroll · C copy · Esc close";
		if (this.kind === "error") return "R try again · Esc close";
		return "Esc close";
	}

	render(width: number): string[] {
		const dialogWidth = Math.max(24, width);
		const innerWidth = Math.max(22, dialogWidth - 2);
		const terminalRows = broModalRows(this.tui, process.stdout.rows);
		const dialogHeight = Math.min(32, Math.max(7, Math.floor(terminalRows * 0.78)));
		this.bodyHeight = Math.max(1, dialogHeight - 6);

		const rendered = this.markdown.render(innerWidth);
		this.maxOffset = Math.max(0, rendered.length - this.bodyHeight);
		this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));
		const visible = rendered.slice(this.offset, this.offset + this.bodyHeight);
		const hiddenBelow = Math.max(0, this.maxOffset - this.offset);
		const scroll = this.maxOffset > 0 ? ` · ↑${this.offset} ↓${hiddenBelow}` : "";
		const controls = this.notice ? `${this.notice} · ${this.controls()}` : this.controls();

		const lines = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(
				this.theme.fg("accent", this.theme.bold(`Bro${this.sourceLabel ? ` · ${this.sourceLabel}` : ""}`)) +
					this.theme.fg("dim", `${this.modelLabel ? ` · ${this.modelLabel}` : ""}${this.modeLabel ? ` · ${this.modeLabel}` : ""}${this.preferencesUsed ? " · prefs" : ""}${scroll}`),
				innerWidth,
			),
			this.ruleLine(innerWidth),
		];

		for (const line of visible) lines.push(this.frameLine(line, innerWidth));
		for (let i = visible.length; i < this.bodyHeight; i++) lines.push(this.frameLine("", innerWidth));

		lines.push(this.ruleLine(innerWidth));
		lines.push(this.frameLine(this.theme.fg("dim", controls), innerWidth));
		lines.push(this.borderLine(innerWidth, "bottom"));
		return lines;
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onClose();
			return;
		}

		const delta = wheelDelta(data) || (matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0);
		if (delta) {
			this.offset = Math.max(0, Math.min(this.offset + delta, this.maxOffset));
			this.notice = "";
			this.tui.requestRender();
			return;
		}

		if ((matchesKey(data, "c") || matchesKey(data, "shift+c")) && this.copyable && this.rawText) {
			void copyToClipboard(this.rawText)
				.then(() => {
					if (!this.disposed) {
						this.notice = "Copied";
						this.tui.requestRender();
					}
				})
				.catch((error) => {
					if (!this.disposed) {
						this.notice = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
						this.tui.requestRender();
					}
				});
			return;
		}

		if (
			(matchesKey(data, "r") || matchesKey(data, "shift+r")) &&
			this.retryable &&
			this.kind !== "loading"
		) {
			this.onRetry();
			return;
		}

		if ((matchesKey(data, "m") || matchesKey(data, "shift+m")) && this.canSwitchMode()) {
			this.onSwitchMode();
			return;
		}

		if ((matchesKey(data, "o") || matchesKey(data, "shift+o")) && this.htmlPath && this.kind === "result") {
			this.notice = openShowHtml(this.htmlPath)
				? "Opening diagram"
				: `Could not open ${this.htmlPath}`;
			this.tui.requestRender();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		setRegularMouseReporting(this.tui, false);
		this.onDispose();
	}
}

interface BroModalOptions {
	text?: string;
	kind?: "help" | "empty";
	copyable?: boolean;
	result?: ModalResult;
	run?: (
		signal: AbortSignal,
		source?: BroSource,
		onProgress?: (text: string) => void,
		mode?: BroMode,
	) => Promise<ModalResult>;
	onResult?: (result: ModalResult) => void;
	loadingText?: string;
	retryable?: boolean;
	retryLabel?: string;
}

async function showBroModal(ctx: ExtensionCommandContext, options: BroModalOptions): Promise<void> {
	if (!hasBroCustomUi(ctx)) {
		if (options.run && !options.result && options.text === undefined) {
			const result = await options.run(new AbortController().signal);
			options.onResult?.(result);
		}
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let closed = false;
			let controller: AbortController | undefined;
			let current = options.result;
			let inFlightMode: BroMode | undefined;
			let execute: (source?: BroSource, mode?: BroMode, notice?: string) => void = () => {};

			const close = () => {
				if (closed) return;
				closed = true;
				controller?.abort();
				done(undefined);
			};

			const modal = new BroModal(
				tui,
				theme,
				close,
				() => execute(current?.source, current?.mode),
				() => {
					closed = true;
					controller?.abort();
				},
				options.retryLabel ?? "simplify again",
				// M advances from the mode in flight, so repeated presses cancel and skip ahead; the saved default is untouched.
				() => {
					const from = inFlightMode ?? current?.mode;
					if (!from || !current?.source || closed) return;
					const next = nextBroMode(from);
					controller?.abort();
					controller = undefined;
					execute(current.source, next, `Mode: ${next} (not saved)`);
				},
			);

			const present = (result: ModalResult, notice = "") => {
				const display = result.htmlPath ? stripShowHtmlFence(result.text) : result.text;
				modal.setResult(display, options.retryable ?? Boolean(options.run), notice, result.source?.label, result.text, result.model);
				modal.setHtmlPath(result.htmlPath ?? "");
				modal.setMode(result.mode);
				modal.setPreferences(Boolean(result.preferences));
			};

			execute = (source?: BroSource, mode?: BroMode, notice = "") => {
				if (!options.run || controller || closed) return;
				const previous = current;
				const nextController = new AbortController();
				controller = nextController;
				inFlightMode = mode;
				modal.setLoading(options.loadingText);
				modal.setMode(mode);
				modal.setPreferences(false);

				void options
					.run(nextController.signal, source, (text) => {
						if (closed || nextController.signal.aborted || controller !== nextController) return;
						modal.setStreaming(text);
					}, mode)
					.then((result) => {
						if (closed || nextController.signal.aborted) return;
						current = result;
						options.onResult?.(result);
						present(result, notice);
					})
					.catch((error) => {
						if (closed || nextController.signal.aborted) return;
						const message = error instanceof Error ? error.message : String(error);
						if (previous) {
							current = previous;
							present(previous, `Retry failed: ${message}`);
						} else {
							modal.setMode(undefined);
							modal.setError(message);
						}
					})
					.finally(() => {
						if (controller === nextController) {
							controller = undefined;
							inFlightMode = undefined;
						}
					});
			};

			if (options.text !== undefined) {
				modal.setStatic(options.kind ?? "help", options.text, options.copyable ?? false);
			} else if (current) {
				present(current);
			} else {
				execute();
			}

			return modal;
		},
		{
			overlay: true,
			overlayOptions: {
				width: "78%",
				minWidth: 48,
				maxHeight: "78%",
				anchor: "top-center",
				margin: { top: 1, left: 2, right: 2 },
			},
		},
	);
}

export function parseBtwArguments(value: string): { question: string; invalid?: string } {
	const rest = value.trim();
	if (!rest.startsWith("--")) return { question: rest };
	const token = rest.split(/\s/, 1)[0]!;
	if (token === "--full" || token === "--sandbox") {
		return { question: "", invalid: `${token} was removed. Open /bro btw and type /mode to switch between conversation-only and full permission.` };
	}
	if (token === "--fresh") {
		return { question: "", invalid: "--fresh was removed. Every new thread starts with main-session context; type /clear inside /bro btw to start over." };
	}
	return { question: "", invalid: `Unknown /bro btw flag: ${token}` };
}

// A new thread starts conversation-only; reopening keeps the thread and its mode.
export function resolveBtwThread(existing: BtwThread | undefined): BtwThread {
	return existing ?? { turns: [], full: false };
}

export function bindBtwBackend(thread: BtwThread, backend: BackendName): boolean {
	const changed = thread.backend !== undefined && thread.backend !== backend;
	if (changed) { thread.turns = []; thread.conversationId = undefined; thread.context = undefined; thread.sessionFull = undefined; thread.sessionPreferences = undefined; }
	thread.backend = backend;
	return changed;
}

export function btwModeLabel(full: boolean): string {
	return full ? "full permission" : "conversation-only";
}

// /mode keeps the transcript; whether the native session survives is decided by
// nativeBtwContinuation on the next turn.
export function toggleBtwMode(thread: BtwThread): void {
	thread.full = !thread.full;
}

// Claude, Grok, Codex, and Muse run btw in the workspace for both modes and resume one native session across
// /mode switches. An Agy conversation stays bound to the workspace it started in (a sandbox scratch
// dir vs. the repo), so an access change drops it; the next turn reseeds a fresh native session
// with the main-session context and the whole thread.
// A native session remembers every earlier prompt, including old preferences, so a preferences
// change (or deletion) on any backend starts a fresh session reseeded with the quoted thread.
export function nativeBtwContinuation(thread: BtwThread, backend: BackendName, preferences = ""): string | undefined {
	if (backend === "agy" && thread.conversationId && thread.sessionFull !== undefined && thread.sessionFull !== thread.full) {
		thread.conversationId = undefined;
	}
	if (thread.conversationId && (thread.sessionPreferences ?? "") !== preferences) thread.conversationId = undefined;
	return thread.conversationId;
}

export function btwHeaderLabel(thread: Pick<BtwThread, "model" | "preferences">): string {
	return thread.model ? `${thread.model}${thread.preferences ? " · prefs" : ""}` : "";
}

export function formatBtwTranscript(turns: readonly BtwTurn[]): string {
	return turns
		.map((turn) => {
			const question = turn.question.split(/\r?\n/).map((line) => (line ? `> ${line}` : ">")).join("\n");
			// A turn aborted mid-stream can end inside an unclosed code fence, which would swallow the
			// separator and every later turn; close it so each turn renders as its own block.
			const answer = (turn.answer.match(/^```/gm)?.length ?? 0) % 2 === 1 ? `${turn.answer}\n\`\`\`` : turn.answer;
			return `> **You**\n>\n${question}\n\n**Bro**\n\n${answer}`;
		})
		.join("\n\n---\n\n");
}

export type BtwComposerAction =
	| { kind: "clear" }
	| { kind: "mode" }
	| { kind: "retry" }
	| { kind: "clipboard"; all: boolean }
	| { kind: "insert"; all: boolean }
	| { kind: "removed"; command: string }
	| { kind: "question"; text: string };

export function parseBtwComposerCommand(value: string): BtwComposerAction {
	const command = value.trim();
	if (command === "/clear") return { kind: "clear" };
	if (command === "/mode") return { kind: "mode" };
	if (command === "/retry" || command === "") return { kind: "retry" };
	if (command === "/copy" || command === "/copy-all") {
		return { kind: "clipboard", all: command === "/copy-all" };
	}
	if (command === "/insert" || command === "/insert-all") return { kind: "insert", all: command === "/insert-all" };
	if (command === "/insert!" || command === "/insert-all!") return { kind: "removed", command };
	return { kind: "question", text: command };
}

// Thin presentation-boundary wrapper around the shared backend: coalesces raw text progress to the
// existing 75ms cadence and translates the backend's tagged outcome back into this function's
// existing throw-on-failure / { text, conversationId } contract. A conversationId is only ever
// returned on success (see backend.ts's continuation handling), preserving current behavior on
// failed turns.
async function runBtwTurn(
	prompt: string,
	selection: BackendSelection,
	options: { full: boolean; cwd: string; conversationId?: string },
	signal: AbortSignal,
	onProgress?: (text: string) => void,
): Promise<{ text: string; conversationId?: string }> {
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	let latest: string | undefined;
	const throttledProgress = onProgress
		? (progress: BackendProgress) => {
				if (progress.kind !== "text") return;
				latest = progress.text;
				if (!updateTimer) {
					updateTimer = setTimeout(() => {
						updateTimer = undefined;
						if (!signal.aborted && latest !== undefined) onProgress(latest);
					}, 75);
				}
			}
		: undefined;

	try {
		const outcome = await executeBackend(
			{
				feature: "btw",
				prompt,
				access: options.full ? "workspace-full" : "restricted",
				cwd: options.cwd,
				continuation: options.conversationId ? { id: options.conversationId } : undefined,
			},
			selection,
			signal,
			throttledProgress,
		);
		if (outcome.status === "success") return { text: outcome.text, conversationId: outcome.continuation?.id };
		throw new Error(outcome.message);
	} finally {
		if (updateTimer) clearTimeout(updateTimer);
	}
}

class BtwModal implements Focusable {
	private _focused = false;
	private readonly markdown = new Markdown("", 0, 0, getMarkdownTheme());
	private readonly input = new Input();
	private notice = "";
	private offset = 0;
	private maxOffset = 0;
	private bodyHeight = 1;
	private running = false;
	private full = false;
	private model = "";
	private disposed = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private readonly tui: TuiLike,
		private readonly theme: Theme,
		private readonly onClose: () => void,
		private readonly onSubmit: (value: string) => void,
		private readonly onDispose: () => void,
	) {
		setRegularMouseReporting(this.tui, true);
		this.input.onSubmit = (value) => {
			if (!this.running) this.onSubmit(value);
		};
	}

	setText(text: string): void {
		this.markdown.setText(text);
		if (!this.running) this.offset = 0;
		this.tui.requestRender();
	}

	setNotice(notice: string): void {
		if (this.disposed) return;
		this.notice = notice;
		this.tui.requestRender();
	}

	setRunning(running: boolean): void {
		this.running = running;
		this.tui.requestRender();
	}

	setModel(model: string): void {
		this.model = model;
		this.tui.requestRender();
	}

	setFull(full: boolean): void {
		this.full = full;
		this.tui.requestRender();
	}

	clearComposer(): void {
		this.input.setValue("");
		this.tui.requestRender();
	}

	invalidate(): void {
		this.markdown.invalidate();
		this.input.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onClose();
			return;
		}
		const delta = wheelDelta(data) || (matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0);
		if (delta) {
			this.offset = Math.max(0, Math.min(this.offset + delta, this.maxOffset));
			this.notice = "";
			this.tui.requestRender();
			return;
		}
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	private ruleLine(innerWidth: number): string {
		return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
	}

	render(width: number): string[] {
		const dialogWidth = Math.max(24, width);
		const innerWidth = Math.max(22, dialogWidth - 2);
		const terminalRows = broModalRows(this.tui, process.stdout.rows);
		const dialogHeight = Math.min(34, Math.max(8, Math.floor(terminalRows * 0.82)));
		const footer = [
			...wrapTextWithAnsi(this.theme.fg("accent", this.theme.bold("Your message to Bro")), innerWidth),
			this.input.render(innerWidth)[0] ?? "",
			...wrapTextWithAnsi(this.running ? "Bro is thinking… · Esc: cancel response" : "Enter: send message · Esc: close panel", innerWidth),
			...wrapTextWithAnsi("Commands: /mode · /copy · /copy-all · /insert · /insert-all · /clear · /retry", innerWidth),
			...(this.notice ? wrapTextWithAnsi(this.theme.fg("accent", this.notice), innerWidth) : []),
		];
		this.bodyHeight = Math.max(1, dialogHeight - 5 - footer.length);

		const rendered = this.markdown.render(innerWidth);
		this.maxOffset = Math.max(0, rendered.length - this.bodyHeight);
		this.offset = Math.max(0, Math.min(this.offset, this.maxOffset));
		const visible = rendered.slice(this.offset, this.offset + this.bodyHeight);
		const hiddenBelow = Math.max(0, this.maxOffset - this.offset);
		const scroll = this.maxOffset > 0 ? ` · ↑${this.offset} ↓${hiddenBelow}` : "";

		const model = this.model ? this.theme.fg("dim", ` · ${this.model}`) : "";
		const mode = this.theme.fg("dim", " · ") + (this.full ? this.theme.fg("accent", this.theme.bold(btwModeLabel(true))) : this.theme.fg("dim", btwModeLabel(false)));
		const header = this.theme.fg("accent", this.theme.bold("Bro · btw")) + model + mode + this.theme.fg("dim", scroll);

		const lines = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(header, innerWidth),
			this.ruleLine(innerWidth),
		];
		for (const line of visible) lines.push(this.frameLine(line, innerWidth));
		for (let i = visible.length; i < this.bodyHeight; i++) lines.push(this.frameLine("", innerWidth));
		lines.push(this.ruleLine(innerWidth));
		for (const line of footer) lines.push(this.frameLine(line, innerWidth));
		lines.push(this.borderLine(innerWidth, "bottom"));
		return lines;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		setRegularMouseReporting(this.tui, false);
		this.onDispose();
	}
}

async function openBtwModal(
	ctx: ExtensionCommandContext,
	options: { thread: BtwThread; initialQuestion?: string },
): Promise<void> {
	const thread = options.thread;

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let closed = false;
			let controller: AbortController | undefined;

			const transcript = () => formatBtwTranscript(thread.turns);

			const close = () => {
				if (closed) return;
				closed = true;
				controller?.abort();
				done(undefined);
			};

			const modal = new BtwModal(tui, theme, close, submit, () => {
				closed = true;
				controller?.abort();
			});

			// `replaced` is the turn /retry removed; it is put back if the turn never starts.
			const runTurn = async (question: string, replaced?: BtwTurn) => {
				if (controller) return;
				const turnController = new AbortController();
				controller = turnController;
				modal.setRunning(true);
				modal.clearComposer();

				let settings: BroSettings;
				let preferences: string;
				try {
					settings = await readSettings();
					preferences = await readPreferences();
				} catch (error) {
					if (replaced) thread.turns.push(replaced);
					if (controller === turnController) controller = undefined;
					if (!closed) { modal.setRunning(false); modal.setNotice(errorMessage(error)); }
					return;
				}
				// Closing (or reopening) during the reads above must not touch the shared thread.
				if (closed || turnController.signal.aborted) {
					if (replaced) thread.turns.push(replaced);
					if (controller === turnController) controller = undefined;
					return;
				}
				if (bindBtwBackend(thread, capabilityBackend(settings, "btw"))) modal.setNotice("Backend changed — started a fresh side thread.");
				if (thread.turns.length === 0) {
					thread.conversationId = undefined;
					const context = captureShowTranscript(ctx, BTW_CONTEXT_TURNS, BTW_CONTEXT_MAX)?.text;
					thread.context = context;
				}
				// Resume natively when possible; otherwise seed the fresh native session with the main-session
				// context plus every earlier turn so nothing is silently lost.
				const conversationId = nativeBtwContinuation(thread, capabilityBackend(settings, "btw"), preferences);
				const history = !conversationId && thread.turns.length ? formatBtwTranscript(thread.turns) : undefined;
				const context = conversationId ? undefined : thread.context;
				const full = thread.full;

				thread.turns.push({ question, answer: "…" });
				modal.setText(transcript());

				try {
					const selection = selectionForCapability(settings, "btw");
					thread.model = selectionLabel(selection);
					thread.preferences = Boolean(preferences);
					modal.setModel(btwHeaderLabel(thread));
					const result = await runBtwTurn(
						buildBtwPrompt(context, question, { full, history, preferences }),
						selection,
						{ full, cwd: ctx.cwd, conversationId },
						turnController.signal,
						(partial) => {
							if (closed || turnController.signal.aborted) return;
							thread.turns[thread.turns.length - 1]!.answer = partial;
							modal.setText(transcript());
						},
					);
					if (turnController.signal.aborted) return;
					if (result.conversationId) {
						thread.conversationId = result.conversationId;
						thread.sessionFull = full;
						thread.sessionPreferences = preferences;
					}
					thread.turns[thread.turns.length - 1]!.answer = result.text;
				} catch (error) {
					if (turnController.signal.aborted || closed) return;
					thread.turns[thread.turns.length - 1]!.answer = `_${errorMessage(error)}_`;
					modal.setNotice(errorMessage(error));
				} finally {
					if (controller === turnController) controller = undefined;
					if (!closed) {
						modal.setRunning(false);
						modal.setText(transcript());
					}
				}
			};

			const toggleMode = () => {
				toggleBtwMode(thread);
				modal.setFull(thread.full);
				modal.setNotice(`Mode: ${btwModeLabel(thread.full)}`);
			};

			const clear = () => {
				thread.turns = [];
				thread.conversationId = undefined;
				thread.context = undefined;
				thread.sessionFull = undefined;
				thread.sessionPreferences = undefined;
				modal.clearComposer();
				modal.setNotice("");
				modal.setText("");
			};

			const retry = () => {
				if (controller) return;
				const last = thread.turns.at(-1);
				if (!last) {
					modal.setNotice("Nothing to retry yet.");
					return;
				}
				thread.turns.pop();
				void runTurn(last.question, last);
			};

			const copyOut = async (all: boolean) => {
				const text = all ? transcript() : (thread.turns.at(-1)?.answer ?? "");
				if (!text.trim()) {
					modal.setNotice("Nothing to copy yet.");
					return;
				}
				try {
					await copyToClipboard(text);
					modal.setNotice(all ? "Copied the full thread to the clipboard." : "Copied the latest answer to the clipboard.");
				} catch (error) {
					modal.setNotice(`Copy failed: ${errorMessage(error)}`);
				}
			};

			const insert = async (all: boolean) => {
				const text = all ? transcript() : (thread.turns.at(-1)?.answer ?? "");
				if (!text.trim()) {
					modal.setNotice("Nothing to insert yet.");
					return;
				}
				if (!canBroInsertIntoEditor(ctx)) {
					const result = await insertBroDesktopText(ctx, text);
					modal.setNotice(result === "inserted" ? "Inserted into the main editor. Review it before sending." : result === "not_empty" ? "Main editor has a draft or attachment. Clear it first, then insert again." : "Could not confirm insertion. Check the main editor before trying again.");
					return;
				}
				if (ctx.ui.getEditorText().trim()) {
					modal.setNotice("Main editor has a draft. Edit or clear it first, then insert again.");
					return;
				}
				ctx.ui.setEditorText(text);
				modal.setNotice(all ? "Inserted the full thread into the main editor." : "Inserted the latest answer into the main editor.");
			};

			function submit(value: string): void {
				const action = parseBtwComposerCommand(value);
				if (action.kind === "clear") {
					modal.clearComposer();
					clear();
					return;
				}
				if (action.kind === "mode") {
					modal.clearComposer();
					toggleMode();
					return;
				}
				if (action.kind === "clipboard") {
					modal.clearComposer();
					void copyOut(action.all);
					return;
				}
				if (action.kind === "insert") {
					modal.clearComposer();
					insert(action.all);
					return;
				}
				if (action.kind === "removed") {
					modal.clearComposer();
					modal.setNotice(`${action.command} was removed. Edit or clear the main editor draft, then use /insert or /insert-all.`);
					return;
				}
				if (action.kind === "retry") {
					modal.clearComposer();
					retry();
					return;
				}
				void runTurn(action.text);
			}

			modal.setFull(thread.full);
			modal.setModel(btwHeaderLabel(thread));
			modal.setText(transcript());

			if (options.initialQuestion) void runTurn(options.initialQuestion);

			return modal;
		},
		{
			overlay: true,
			overlayOptions: {
				width: "78%",
				minWidth: 48,
				maxHeight: "82%",
				anchor: "top-center",
				margin: { top: 1, left: 2, right: 2 },
			},
		},
	);
}

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

	pi.on("session_start", async (_event, _ctx) => {
		lastResult = undefined;
		btwThread = undefined;
	});

	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: "Bro advisor",
		description:
			"Consult a fresh, independent process of the configured advisor backend for a second opinion mid-task. It has real, unsandboxed tool access in the current workspace (read files, search, run commands) with permissions auto-approved, and is instructed to investigate before advising and to leave edits to you — that is a behavioral instruction to the advisor, not an enforced restriction, so treat its findings as advice rather than a delegated implementation. You never need to prepare a summary or evidence first: Bro automatically captures your system instructions, active tools, and the conversation so far, plus any human-set steering priorities, and sends them to the advisor.",
		promptSnippet: "Consult a fresh configured-backend process for a second opinion mid-task; it investigates the workspace itself and returns advice",
		promptGuidelines: [
			"Call bro_advisor before or after a non-trivial design or scope decision, or when genuinely uncertain, for a second opinion from a fresh, independent process of the configured advisor backend.",
			"bro_advisor's question parameter is optional — never delay a call to first prepare a summary or evidence; Bro captures context automatically.",
			"Any human-set steering priorities are applied automatically by bro_advisor; you don't need to relay or repeat them.",
			"bro_advisor is instructed to only return advice and leave edits to you — that instruction is not enforced, so verify its findings yourself rather than treating them as a completed implementation.",
		],
		parameters: Type.Object({
			question: Type.Optional(
				Type.String({ description: "Optional question to focus the consultation on. Leave unset to ask for general advice on the current state." }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const state = resolveAdvisorState(ctx.sessionManager.getBranch());
			const settings = await readSettings();
			const selection = selectionForCapability(settings, "advisor");
			const backend = selection.backend ?? "agy";
			const snapshot = buildAdvisorSnapshot(ctx, pi);
			const prompt = buildAdvisorPrompt(state.steering, snapshot.text, params.question);
			let lastAttempt: AdvisorToolDetails = { status: "investigating", attempt: 1, of: 3, elapsedMs: 0, backend };
			try {
				const run = await runAdvisorWithRetries(
					prompt,
					selection,
					ctx.cwd,
					signal ?? new AbortController().signal,
					undefined,
					undefined,
					(details) => {
						lastAttempt = { ...details, backend };
						const label = advisorAttemptLabel(lastAttempt);
						onUpdate?.({
							content: [{ type: "text", text: label }],
							details: lastAttempt,
						});
						// A host's tool-card renderer may replace onUpdate's partial renderResult with its
						// own generic placeholder for the whole run (observed with pi-cc-extensions' default
						// mode, which hardcodes "Pending…" for every isPartial tool result unless the tool
						// is opted into its excludeRenderers list). The footer/status bar is a separate,
						// host-owned surface that no such tool-card override touches, so mirror progress
						// there too as a fallback the user can see regardless of that renderer choice.
						ctx.ui.setStatus(ADVISOR_STATUS_BAR_KEY, label);
					},
				);
				const effort = selection.effort ?? "model default";
				const omissions = `image/reasoning bodies omitted when present; ${snapshot.hadCompaction ? "Pi compaction summaries replace earlier turns" : "no Pi compaction summary present"}`;
				const details: AdvisorToolDetails = {
					...lastAttempt,
					status: "done",
					attempt: run.attempts,
					backend,
					model: selection.model,
					effort,
					durationMs: run.durationMs,
					cwd: ctx.cwd,
					steeringIncluded: Boolean(state.steering.trim()),
					snapshotChars: snapshot.text.length,
					broTruncated: false,
					omissions,
					// run.activityCount is the exact final total; lastAttempt's may lag behind by up to
					// the activity throttle window.
					activityCount: run.activityCount,
				};
				// The backend qualifier appears only off Agy, keeping the Agy header byte-identical.
				const header = `Bro advisor · ${backend === "agy" ? "" : `backend: ${backend} · `}model: ${selection.model} · effort: ${effort} · ${run.attempts} attempt${run.attempts === 1 ? "" : "s"} · ${Math.ceil(run.durationMs / 1_000)}s`;
				const context = `Context · cwd: ${JSON.stringify(ctx.cwd)} · steering: ${details.steeringIncluded ? "included" : "none"} · snapshot: ${snapshot.text.length} chars · Bro truncation: none · omissions: ${omissions}`;
				return { content: [{ type: "text", text: `${header}\n${context}\n\n${run.advice}` }], details };
			} finally {
				ctx.ui.setStatus(ADVISOR_STATUS_BAR_KEY, undefined);
			}
		},
		renderCall(args, theme) {
			const question = args.question?.trim();
			return new Text(theme.fg("dim", question ? `Bro advisor · ${question}` : "Bro advisor · consulting…"));
		},
		renderResult(result, options, theme) {
			const details = result.details as AdvisorToolDetails | undefined;
			if (options.isPartial) {
				const label = new Text(theme.fg("dim", details ? advisorAttemptLabel(details) : "Bro advisor · investigating…"));
				// Expanded + running: the simplest native tail -- one dim line per bounded recent
				// activity label, nothing fancier than the compact renderer above.
				if (!options.expanded || !details?.activity?.length) return label;
				const container = new Container();
				container.addChild(label);
				for (const line of details.activity) {
					container.addChild(new Text(theme.fg("dim", `  ${advisorActivityPreview(line)}`)));
				}
				return container;
			}
			if (!options.expanded && details?.status === "done") return new Text(theme.fg("accent", advisorAttemptLabel(details)));
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (!options.expanded) {
				const firstLine = text.split("\n").find((line) => line.trim()) ?? "(no advice)";
				return new Text(`${theme.fg("accent", "Bro advisor")}${theme.fg("dim", ` · ${firstLine}`)}`);
			}
			return new Markdown(text, 0, 0, getMarkdownTheme());
		},
	});

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
					const html = extractShowHtml(result.text);
					return { source: captured, ...result, ...(html ? { htmlPath: await writeShowHtml(html) } : {}) };
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
						"/bro advisor no longer has on/off/status controls -- bro_advisor is always registered and available whenever this host exposes and activates it. Use /bro config for its model/effort, /bro advisor-steer for its steering brief, or /bro doctor for full diagnostics.",
						"warning",
					);
					return;
				}
				const active = pi.getActiveTools().includes(ADVISOR_TOOL_NAME);
				ctx.ui.notify(
					active
						? "Bro advisor is available -- the executor agent can call bro_advisor. Use /bro config for its model/effort, /bro advisor-steer for its steering brief, or /bro doctor for full diagnostics."
						: "Bro advisor is unavailable in this runtime. Use /bro doctor for full diagnostics, /bro config for its model/effort, or /bro advisor-steer for its steering brief.",
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
					const html = extractShowHtml(lastResult.text);
					// Temp files may have been cleaned by the OS or another Bro session.
					if (html && ctx.mode === "tui") {
						try { lastResult.htmlPath = await writeShowHtml(html); }
						catch (error) {
							lastResult.htmlPath = undefined;
							ctx.ui.notify(`Diagram file unavailable: ${errorMessage(error)}`, "warning");
						}
					}
				}
				await showBroModal(ctx, {
					result: lastResult,
					loadingText: steering !== undefined ? "Drawing what happened…" : undefined,
					retryLabel: steering !== undefined ? "show again" : undefined,
					run: steering === undefined ? run : async (signal, source, onProgress) => {
						if (!source) throw new Error("No captured Show source.");
						const result = await runShowExplanation(source.text, steering, signal, await readSettings(), onProgress);
						const html = extractShowHtml(result.text);
						return { source, ...result, ...(html ? { htmlPath: await writeShowHtml(html) } : {}) };
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

	// Keep the command available even when Bro cannot create its settings file; Doctor can then explain the problem.
	await ensureSettingsFile().catch(() => undefined);
}
