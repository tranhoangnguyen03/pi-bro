import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	ADVISOR_COMPATIBILITY,
	ADVISOR_STEERING_FILE,
	ADVISOR_TOOL_NAME,
	advisorAgyCompatible,
	readAdvisorSteering,
	resolveAdvisorState,
} from "./advisor.ts";
import { agyFailureMessage, reviewBackendNotice } from "./backend.ts";
import { createConfigModal } from "./config-ui.ts";
import { openBroOverlay } from "./modal-kit.ts";
import {
	type AgyEffort,
	type AgyModelFamily,
	type BackendName,
	type BroSettings,
	CAPABILITIES,
	CAPABILITY_LABELS,
	EFFORTS,
	capabilityBackend,
	capabilityOverride,
	capabilityPair,
	isClaudeEffort,
	isCodexEffort,
	isGrokEffort,
	isMuseEffort,
	readPreferences,
	readSettings,
	resolveCapabilitySettings,
	resolveModelEffort,
	writeSettings,
} from "./settings.ts";
import { hasBroCustomUi } from "./ui-capabilities.ts";
import { errorMessage, isRecord, withDoctor } from "./util.ts";

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

export async function listAgyModels(pi: ExtensionAPI, signal?: AbortSignal): Promise<AgyModelFamily[]> {
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

export async function doctorReport(pi: ExtensionAPI, ctx: ExtensionCommandContext, signal: AbortSignal): Promise<string> {
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
	const backendInUse = (backend: BackendName) => settings
		? CAPABILITIES.some(capability => capabilityBackend(settings, capability) === backend)
		: backend === "agy";
	const agyInUse = backendInUse("agy");
	const claudeInUse = backendInUse("claude");
	const grokInUse = backendInUse("grok");
	const codexInUse = backendInUse("codex");
	const museInUse = backendInUse("muse");

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
			// Review on a shell-capable sandbox is informational, never a failure: report the capability
			// normally, then append one advisory line. Every branch below goes through here.
			const reviewNotice = capability === "review" ? reviewBackendNotice(backend) : undefined;
			const passCapability = (detail: string) => {
				pass(label, detail);
				if (reviewNotice) lines.push(`- ℹ **${label}:** ${reviewNotice}`);
			};
			if (backend === "claude") {
				if (!isClaudeEffort(pair.effort)) {
					fail(label, `\`${pair.effort}\` is unsupported for claude \`${pair.model}\`. Run \`/bro config\` to fix this.`);
					continue;
				}
				passCapability(
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
				passCapability(
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
				passCapability(
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
				passCapability(
					override
						? `override muse \`${pair.model}\`${pair.effort === "default" ? "" : ` (${pair.effort})`}`
						: `muse \`${pair.model}\`${pair.effort === "default" ? "" : ` (${pair.effort})`} · using the shared default`,
				);
				continue;
			}
			// No Agy catalog available: the Agy branch above is the only one that gets here, so there is
			// nothing to validate, but a shell-capable review override still deserves its advisory.
			if (!models) {
				if (reviewNotice) lines.push(`- ℹ **${label}:** ${reviewNotice}`);
				continue;
			}
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
			passCapability(
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
	const sessionSteering = resolveAdvisorState(ctx.sessionManager.getBranch()).steering.trim();
	pass("Advisor steering (session)", sessionSteering ? `${sessionSteering.length.toLocaleString("en-US")} characters · /bro advisor-steer` : "none — /bro advisor-steer to set for this session");
	try {
		const durable = await readAdvisorSteering();
		pass("Advisor steering (durable)", durable ? `${durable.length.toLocaleString("en-US")} characters · ${ADVISOR_STEERING_FILE}` : `none — ${ADVISOR_STEERING_FILE}`);
	} catch (error) {
		fail("Advisor steering (durable)", error);
	}
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
	} catch {
		families = [];
		ctx.ui.notify("Agy model catalog unavailable — showing other backend settings without Agy choices.", "warning");
	}
	await openBroOverlay<void>(ctx, createConfigModal(settings, families, writeSettings));
}
