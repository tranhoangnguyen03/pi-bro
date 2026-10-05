import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type BackendSelection,
	agySelection,
	CLAUDE_EFFORTS,
	GROK_EFFORTS,
	CODEX_EFFORTS,
	MUSE_EFFORTS,
} from "./backend.ts";
import { type BroMode, DEFAULT_BRO_MODE, parseBroMode } from "./prompt.ts";
import { isRecord } from "./util.ts";

export const EFFORTS = ["default", "low", "medium", "high"] as const;
export const BACKENDS = ["agy", "claude", "grok", "codex", "muse"] as const;
export type BackendName = (typeof BACKENDS)[number];
export type BroEffort = "default" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgyEffort = Exclude<BroEffort, "default" | "minimal" | "xhigh" | "max">;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
export { GROK_EFFORTS, CODEX_EFFORTS, MUSE_EFFORTS };
export type GrokEffort = (typeof GROK_EFFORTS)[number];
export type CodexEffort = (typeof CODEX_EFFORTS)[number];
export type MuseEffort = (typeof MUSE_EFFORTS)[number];

export const CAPABILITIES = ["explain", "show", "btw", "advisor"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CAPABILITY_LABELS: Record<Capability, string> = {
	explain: "Explain",
	show: "Show",
	btw: "Btw",
	advisor: "Advisor",
};

export type ModelEffortPair = { backend?: BackendName; model: string; effort: BroEffort };
export type BroSettings = {
	backend?: BackendName;
	model: string;
	effort: BroEffort;
	mode: BroMode;
	showTurns: number;
	overrides: Partial<Record<Capability, ModelEffortPair>>;
};

export const CLAUDE_MODELS = [
	{ id: "sonnet", label: "Claude Sonnet (default)" },
	{ id: "opus", label: "Claude Opus" },
] as const;

export const GROK_MODELS = [
	{ id: "grok-4.7", label: "Grok 4.7 (default)" },
	{ id: "grok-4.7-build-fast", label: "Grok 4.7 Build Fast" },
] as const;

export const CODEX_MODELS = [
	{ id: "gpt-5.5", label: "GPT-5.5 (default)" },
	{ id: "gpt-5.4", label: "GPT-5.4" },
] as const;

export const MUSE_MODELS = [
	{ id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor (default)" },
	{ id: "muse-spark-1.3", label: "Muse Spark 1.3" },
] as const;

export type AgyModelFamily = {
	id: string;
	label: string;
	efforts: AgyEffort[];
	variants: Array<{ id: string; effort?: AgyEffort }>;
};

export const DEFAULT_SHOW_TURNS = 1;

export function parseBackend(value: unknown, context: string): BackendName {
	if (typeof value !== "string" || !BACKENDS.some((backend) => backend === value)) {
		throw new Error(`${context} backend must be "agy", "claude", "grok", "codex", or "muse".`);
	}
	return value as BackendName;
}

export function isAgyEffort(effort: unknown): effort is AgyEffort | "default" {
	return EFFORTS.some((item) => item === effort);
}

export function isClaudeEffort(effort: unknown): effort is ClaudeEffort | "default" {
	return effort === "default" || CLAUDE_EFFORTS.some((item) => item === effort);
}

export function isGrokEffort(effort: unknown): effort is GrokEffort | "default" {
	return effort === "default" || GROK_EFFORTS.some((item) => item === effort);
}

export function isCodexEffort(effort: unknown): effort is CodexEffort | "default" {
	return effort === "default" || CODEX_EFFORTS.some((item) => item === effort);
}

export function isMuseEffort(effort: unknown): effort is MuseEffort | "default" {
	return effort === "default" || MUSE_EFFORTS.some((item) => item === effort);
}

// Sonnet/opus aliases resolve case-insensitively; any other non-empty string passes
// through untouched as an explicit user-entered model ID.
export function resolveClaudeModel(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Claude model must be a non-empty model ID (sonnet, opus, or an explicit model ID).");
	const alias = CLAUDE_MODELS.find((model) => model.id === trimmed.toLowerCase());
	return alias ? alias.id : trimmed;
}

// Grok seeds resolve to themselves; any other non-empty string passes through
// untouched as an explicit user-entered model ID (installed `grok models` confirms).
export function resolveGrokModel(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Grok model must be a non-empty model ID (grok-4.7, grok-4.7-build-fast, or an explicit model ID).");
	return trimmed;
}

// Codex seeds resolve to themselves; any other non-empty string passes through
// untouched as an explicit user-entered model ID.
export function resolveCodexModel(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Codex model must be a non-empty model ID (gpt-5.5, gpt-5.4, or an explicit model ID).");
	return trimmed;
}

// Muse seeds resolve to themselves; any other non-empty string passes through
// untouched as an explicit user-entered model ID.
export function resolveMuseModel(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Muse model must be a non-empty model ID (muse-spark-1.3-contributor, muse-spark-1.3, or an explicit model ID).");
	return trimmed;
}

export type ExternalBackend = "claude" | "grok" | "codex" | "muse";

export interface ExternalBackendMeta {
	readonly name: ExternalBackend;
	readonly label: string;
	readonly prefix: string;
	readonly efforts: readonly BroEffort[];
	readonly models: readonly { id: string; label: string }[];
	readonly effortHelp: string;
	isEffort(effort: unknown): effort is BroEffort;
	resolveModel(input: string): string;
}

export const EXTERNAL_BACKENDS: Record<ExternalBackend, ExternalBackendMeta> = {
	claude: {
		name: "claude",
		label: "Claude",
		prefix: "claude:",
		efforts: CLAUDE_EFFORTS,
		models: CLAUDE_MODELS,
		effortHelp: '"default", "low", "medium", "high", "xhigh", or "max"',
		isEffort: isClaudeEffort,
		resolveModel: resolveClaudeModel,
	},
	grok: {
		name: "grok",
		label: "Grok",
		prefix: "grok:",
		efforts: GROK_EFFORTS,
		models: GROK_MODELS,
		effortHelp: '"default", "low", "medium", "high", or "xhigh"',
		isEffort: isGrokEffort,
		resolveModel: resolveGrokModel,
	},
	codex: {
		name: "codex",
		label: "Codex",
		prefix: "codex:",
		efforts: CODEX_EFFORTS,
		models: CODEX_MODELS,
		effortHelp: '"default", "low", "medium", "high", or "xhigh"',
		isEffort: isCodexEffort,
		resolveModel: resolveCodexModel,
	},
	muse: {
		name: "muse",
		label: "Muse",
		prefix: "muse:",
		efforts: MUSE_EFFORTS,
		models: MUSE_MODELS,
		effortHelp: '"default", "minimal", "low", "medium", "high", "xhigh", or "max"',
		isEffort: isMuseEffort,
		resolveModel: resolveMuseModel,
	},
};

export function parseBackendOption(value: string): { backend: ExternalBackend; id: string } | undefined {
	for (const meta of Object.values(EXTERNAL_BACKENDS)) {
		if (value.startsWith(meta.prefix) && value.length > meta.prefix.length) {
			return { backend: meta.name, id: value.slice(meta.prefix.length) };
		}
	}
	return undefined;
}

export function parseModelEffortPair(value: unknown, context: string): ModelEffortPair {
	if (!isRecord(value) || typeof value.model !== "string" || !value.model.trim()) {
		throw new Error(`${context} must contain a model and effort set to "default", "low", "medium", or "high".`);
	}
	const backend = value.backend === undefined ? undefined : parseBackend(value.backend, context);
	if (backend && backend in EXTERNAL_BACKENDS) {
		const meta = EXTERNAL_BACKENDS[backend as ExternalBackend];
		if (!meta.isEffort(value.effort)) {
			throw new Error(`${context} must contain a model and effort set to ${meta.effortHelp}.`);
		}
		return { backend, model: value.model.trim(), effort: value.effort };
	}
	if (!isAgyEffort(value.effort)) {
		throw new Error(`${context} must contain a model and effort set to "default", "low", "medium", or "high".`);
	}
	const pair: ModelEffortPair = { model: value.model.trim(), effort: value.effort };
	if (backend !== undefined) pair.backend = backend;
	return pair;
}

export function parseOverrides(value: unknown): Partial<Record<Capability, ModelEffortPair>> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error("Settings overrides must be an object.");
	const overrides: Partial<Record<Capability, ModelEffortPair>> = {};
	for (const capability of CAPABILITIES) {
		if (value[capability] === undefined) continue;
		overrides[capability] = parseModelEffortPair(value[capability], `Settings overrides.${capability}`);
	}
	return overrides;
}

export function parseBroSettings(value: unknown): BroSettings {
	if (!isRecord(value)) {
		throw new Error('Settings must contain a model and effort set to "default", "low", "medium", or "high".');
	}
	// v2 disk shape: { version: 2, default: { backend, model, effort }, mode, showTurns, overrides }.
	// Reads never rewrite: a legacy flat file keeps parsing into backend-less (Agy) settings.
	if (value.version !== undefined && value.version !== 2) throw new Error(`Unsupported settings version ${JSON.stringify(value.version)}.`);
	if (value.version === 2 && value.default === undefined) throw new Error("Settings version 2 requires default.");

	const isV2 = value.default !== undefined;
	if (isV2 && !isRecord(value.default)) {
		throw new Error("Settings default must contain a model and effort.");
	}
	const pair = parseModelEffortPair(isV2 ? value.default : value, isV2 ? "Settings default" : "Settings");

	const mode = value.mode === undefined ? DEFAULT_BRO_MODE : parseBroMode(value.mode);
	if (!mode) throw new Error('Settings mode must be "brief", "balanced", or "faithful".');

	const showTurns = value.showTurns === undefined ? DEFAULT_SHOW_TURNS : value.showTurns;
	if (typeof showTurns !== "number" || !Number.isInteger(showTurns) || showTurns < 1) {
		throw new Error("Settings showTurns must be a positive whole number of turns.");
	}

	const overrides = parseOverrides(value.overrides);
	const settings: BroSettings = { model: pair.model, effort: pair.effort, mode, showTurns, overrides };
	if (pair.backend !== undefined) settings.backend = pair.backend;
	return settings;
}

export function applyModelChange(
	currentPair: ModelEffortPair,
	newValue: string,
	families: readonly AgyModelFamily[],
): ModelEffortPair | undefined {
	const switched = parseBackendOption(newValue);
	if (switched !== undefined) {
		const meta = EXTERNAL_BACKENDS[switched.backend];
		const isSameBackend = currentPair.backend === switched.backend;
		const effort = isSameBackend && meta.isEffort(currentPair.effort) ? currentPair.effort : "default";
		return { backend: switched.backend, model: meta.resolveModel(switched.id), effort };
	}

	const family = families.find((item) => item.id === newValue || item.variants.some((variant) => variant.id === newValue));
	if (!family) return undefined;

	// Resolve current pair first so variant suffixes (e.g. gemini-a-high) resolve to their canonical effort
	const resolved = resolveModelEffort(currentPair, families as AgyModelFamily[]);
	const isCurrentAgy = (currentPair.backend ?? "agy") === "agy";
	const effectiveEffort = (isCurrentAgy && resolved.family) ? resolved.pair.effort : currentPair.effort;

	const keepCurrent = isCurrentAgy && (
		effectiveEffort === "default"
			? !family.efforts.length
			: family.efforts.includes(effectiveEffort as AgyEffort)
	);

	return {
		model: family.id,
		effort: keepCurrent ? effectiveEffort : preferredEffort(family),
	};
}

export function applyEffortChange(
	currentPair: ModelEffortPair,
	newValue: string,
	families: readonly AgyModelFamily[],
): ModelEffortPair | undefined {
	const backend = currentPair.backend ?? "agy";
	if (backend in EXTERNAL_BACKENDS) {
		const meta = EXTERNAL_BACKENDS[backend as ExternalBackend];
		if (!meta.isEffort(newValue)) return undefined;
		return { backend: meta.name, model: currentPair.model, effort: newValue };
	}

	// Canonicalize Agy model to family ID to prevent detached variant suffixes
	const resolved = resolveModelEffort(currentPair, families as AgyModelFamily[]);
	return {
		model: resolved.family?.id ?? currentPair.model,
		effort: newValue as BroEffort,
	};
}

export function capabilityOverride(settings: BroSettings, capability: Capability): ModelEffortPair | undefined {
	return settings.overrides[capability];
}

export function capabilityPair(settings: BroSettings, capability: Capability): ModelEffortPair {
	return capabilityOverride(settings, capability) ?? { ...(settings.backend ? { backend: settings.backend } : {}), model: settings.model, effort: settings.effort };
}

// An override always pins both model and effort together (never just one), so a capability's
// setting is either fully inherited or fully its own — no partial-inheritance edge cases.
//
// An override is cleared ONLY by an explicit "Default" selection (pair === undefined), never
// automatically because it happens to match the shared default: a user who deliberately pins a
// capability to the same model as the shared default wants it to STAY on that model even if the
// shared default changes later.
export function withCapabilityOverride(
	settings: BroSettings,
	capability: Capability,
	override: ModelEffortPair | undefined,
): BroSettings {
	const nextOverrides = { ...settings.overrides };
	if (override === undefined) {
		delete nextOverrides[capability];
	} else {
		nextOverrides[capability] = override;
	}
	return { ...settings, overrides: nextOverrides };
}

export function resolveModelEffort(
	pair: ModelEffortPair,
	families: AgyModelFamily[],
): { pair: ModelEffortPair; family?: AgyModelFamily } {
	// Claude/Grok/Codex/Muse selections never resolve through the Agy catalog; they pass through untouched.
	if (pair.backend && pair.backend !== "agy") return { pair };
	const family = families.find((item) => item.id === pair.model || item.variants.some((variant) => variant.id === pair.model));
	if (!family) return { pair };
	const variant = family.variants.find((item) => item.id === pair.model);
	const resolved: ModelEffortPair = {
		model: family.id,
		effort: pair.effort === "default" && variant?.effort ? variant.effort : pair.effort,
	};
	if (pair.backend !== undefined) resolved.backend = pair.backend;
	return { family, pair: resolved };
}

// A capability's effective backend: an explicit override is a complete selection, so a
// backend-less override still means Agy (all legacy stays Agy) and never inherits the
// shared default's backend. Only a capability without an override inherits the default.
export function capabilityBackend(settings: BroSettings, capability: Capability): BackendName {
	const override = settings.overrides[capability];
	if (override) return override.backend ?? "agy";
	return settings.backend ?? "agy";
}

// Routes one capability's whole pair to its backend execution selection. Agy keeps the
// existing model/effort split; Claude/Grok/Codex/Muse carry the model plus an optional effort
// ("default" means the CLI's own default and is omitted). Throws for an effort the
// resolved backend does not support instead of silently sending a mismatched pair.
export function selectionForCapability(settings: BroSettings, capability: Capability): BackendSelection {
	const pair = capabilityPair(settings, capability);
	const backend = capabilityBackend(settings, capability);
	if (backend in EXTERNAL_BACKENDS) {
		const meta = EXTERNAL_BACKENDS[backend as ExternalBackend];
		if (!meta.isEffort(pair.effort)) {
			throw new Error(`\`${pair.effort}\` is not supported on the ${meta.label} backend. Run \`/bro config\` to fix this.`);
		}
		return (
			pair.effort === "default"
				? { backend, model: pair.model }
				: { backend, model: pair.model, effort: pair.effort }
		) as BackendSelection;
	}
	if (!isAgyEffort(pair.effort)) {
		throw new Error(`\`${pair.effort}\` is not supported on the Agy backend. Run \`/bro config\` to fix this.`);
	}
	return agySelection({ model: pair.model, effort: pair.effort });
}

// The modal label for the exact selection a request runs with: model plus effort, where an
// omitted effort (the model's own default) reads simply "default".
export function selectionLabel(selection: BackendSelection): string {
	return `${selection.model} · ${selection.effort ?? "default"}`;
}

export function resolveCapabilitySettings(
	settings: BroSettings,
	capability: Capability,
	families: AgyModelFamily[],
): { pair: ModelEffortPair; family?: AgyModelFamily } {
	return resolveModelEffort(capabilityPair(settings, capability), families);
}

export function preferredEffort(family: AgyModelFamily): BroEffort {
	return family.efforts.includes("low") ? "low" : (family.efforts[0] ?? "default");
}

export function effortDisplay(resolved: { pair: ModelEffortPair; family?: AgyModelFamily }, backend: BackendName): string {
	if (backend in EXTERNAL_BACKENDS) {
		const meta = EXTERNAL_BACKENDS[backend as ExternalBackend];
		return meta.isEffort(resolved.pair.effort) ? resolved.pair.effort : `${resolved.pair.effort} (unsupported)`;
	}
	if (!resolved.family) return "unavailable";
	const fixed = !resolved.family.efforts.length;
	const valid = fixed ? resolved.pair.effort === "default" : resolved.family.efforts.includes(resolved.pair.effort as AgyEffort);
	if (!valid) return `${resolved.pair.effort} (unsupported)`;
	return fixed ? "fixed" : resolved.pair.effort;
}

export function settingsFile(): string {
	return join(getAgentDir(), "bro-settings.json");
}

export async function ensureSettingsFile(): Promise<void> {
	await mkdir(getAgentDir(), { recursive: true });
	try {
		const envModel = process.env.PI_BRO_MODEL?.trim();
		const defaultModel = envModel || "gemini-3.7-flash";
		const initial: BroSettings = {
			model: defaultModel,
			effort: envModel ? "default" : "low",
			mode: DEFAULT_BRO_MODE,
			showTurns: DEFAULT_SHOW_TURNS,
			overrides: {},
		};
		await writeFile(
			settingsFile(),
			`${JSON.stringify(settingsPayload(initial), null, 2)}\n`,
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

export async function readSettings(): Promise<BroSettings> {
	await ensureSettingsFile();
	try {
		return parseBroSettings(JSON.parse(await readFile(settingsFile(), "utf8")));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`${settingsFile()} is not valid JSON.`);
		if (error instanceof Error) throw new Error(`${settingsFile()}: ${error.message}`);
		throw error;
	}
}

// Exported so persistence stays testable without touching the filesystem. This only ever omits
// the `overrides` key itself when there are no overrides at all — it does NOT deduplicate or drop
// any individual override that happens to match the shared default; see withCapabilityOverride
// for why an explicit override is always kept until the user clears it back to "Default".
export function settingsPayload(settings: BroSettings): Record<string, unknown> {
	const overrides: Record<string, unknown> = {};
	for (const [capability, pair] of Object.entries(settings.overrides)) {
		if (pair) overrides[capability] = { backend: pair.backend ?? "agy", model: pair.model, effort: pair.effort };
	}
	return {
		version: 2,
		default: { backend: settings.backend ?? "agy", model: settings.model, effort: settings.effort },
		mode: settings.mode,
		showTurns: settings.showTurns,
		...(Object.keys(overrides).length ? { overrides } : {}),
	};
}

export async function writeSettings(settings: BroSettings): Promise<void> {
	// ponytail: last writer wins across concurrent Pi processes; add locking only if that becomes a common workflow.
	await writeFile(settingsFile(), `${JSON.stringify(settingsPayload(settings), null, 2)}\n`, "utf8");
}
