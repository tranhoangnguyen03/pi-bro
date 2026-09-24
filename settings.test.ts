import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

// bro.ts is not importable under node --test directly: it uses TypeScript
// parameter properties, which strip-only mode rejects. The repo's smoke-test.sh
// handles this by compiling with tsc first; this suite does the same into a
// scratch directory so `node --test settings.test.ts` stays self-contained.
const repoDir = dirname(new URL(import.meta.url).pathname);
const buildDir = mkdtempSync(join(tmpdir(), "pi-bro-settings-test-"));
after(() => rmSync(buildDir, { recursive: true, force: true }));
const tscBin = join(repoDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
execFileSync(
	tscBin,
	[
		"--ignoreConfig",
		join(repoDir, "bro.ts"),
		"--target",
		"ES2022",
		"--module",
		"NodeNext",
		"--moduleResolution",
		"NodeNext",
		"--strict",
		"--allowImportingTsExtensions",
		"--rewriteRelativeImportExtensions",
		"--skipLibCheck",
		"--types",
		"node",
		"--outDir",
		buildDir,
	],
	{ stdio: "pipe" },
);
symlinkSync(join(repoDir, "node_modules"), join(buildDir, "node_modules"));

const bro = await import(pathToFileURL(join(buildDir, "bro.js")).href);
const backend = await import(pathToFileURL(join(buildDir, "backend.js")).href);
const { CLAUDE_EFFORTS } = backend;
const {
	CLAUDE_MODELS,
	GROK_EFFORTS,
	GROK_MODELS,
	capabilityBackend,
	parseBroSettings,
	resolveClaudeModel,
	resolveGrokModel,
	resolveModelEffort,
	helpText,
	selectionForCapability,
	selectionLabel,
	settingsPayload,
	supportsBackend,
	withCapabilityOverride,
} = bro;

// v2 settings disk shape: { version: 2, default: { backend, model, effort }, overrides, mode, showTurns }.
// Legacy flat files ({ model, effort, ... }) keep parsing into backend-less (Agy) settings.

test("legacy settings parse with no backend key and stay Agy", () => {
	assert.deepEqual(parseBroSettings({ model: "gemini-a", effort: "low" }), {
		model: "gemini-a",
		effort: "low",
		mode: "balanced",
		showTurns: 1,
		overrides: {},
	});
	const settings = parseBroSettings({ model: "m", effort: "low" });
	assert.equal(capabilityBackend(settings, "explain"), "agy");
	assert.deepEqual(selectionForCapability(settings, "explain"), { model: "m", effort: "low" });
	assert.deepEqual(selectionForCapability(parseBroSettings({ model: "m", effort: "default" }), "explain"), { model: "m" });
});

test("explicit save migrates legacy settings to version 2", () => {
	const settings = parseBroSettings({ model: "gemini-a", effort: "low", mode: "balanced", showTurns: 1, overrides: {} });
	assert.deepEqual(settingsPayload(settings), {
		version: 2,
		default: { backend: "agy", model: "gemini-a", effort: "low" },
		mode: "balanced",
		showTurns: 1,
	});
});

test("v2 settings parse into shared default plus whole overrides", () => {
	const settings = parseBroSettings({
		version: 2,
		default: { backend: "claude", model: "sonnet", effort: "medium" },
		mode: "faithful",
		showTurns: 2,
		overrides: { explain: { backend: "claude", model: "opus", effort: "high" } },
	});
	assert.equal(settings.backend, "claude");
	assert.equal(settings.model, "sonnet");
	assert.equal(settings.effort, "medium");
	assert.equal(settings.mode, "faithful");
	assert.equal(settings.showTurns, 2);
	assert.deepEqual(settings.overrides.explain, { backend: "claude", model: "opus", effort: "high" });
	assert.equal(capabilityBackend(settings, "explain"), "claude");
	assert.equal(capabilityBackend(settings, "show"), "claude");
});

test("v2 Claude settings write v2 and round-trip", () => {
	const settings = parseBroSettings({
		version: 2,
		default: { backend: "claude", model: "sonnet", effort: "medium" },
		mode: "balanced",
		showTurns: 1,
		overrides: {},
	});
	const payload = settingsPayload(settings);
	assert.equal(payload.version, 2);
	assert.deepEqual(payload.default, { backend: "claude", model: "sonnet", effort: "medium" });
	assert.deepEqual(parseBroSettings(payload), settings);
});

test("override backend never field-merges: a backend-less override stays Agy under a Claude default", () => {
	const settings = parseBroSettings({
		version: 2,
		default: { backend: "claude", model: "sonnet", effort: "medium" },
		overrides: { show: { model: "gemini-a", effort: "low" } },
	});
	assert.equal(capabilityBackend(settings, "show"), "agy");
	assert.deepEqual(selectionForCapability(settings, "show"), { model: "gemini-a", effort: "low" });
	assert.equal(capabilityBackend(settings, "advisor"), "claude");
});

test("Agy pairs reject Claude-only efforts, Claude pairs accept xhigh/max", () => {
	assert.throws(() => parseBroSettings({ model: "m", effort: "xhigh" }), /Settings must contain/);
	assert.throws(
		() => parseBroSettings({ model: "m", effort: "low", overrides: { explain: { model: "x", effort: "max" } } }),
		/overrides\.explain/,
	);
	const claude = parseBroSettings({
		version: 2,
		default: { backend: "claude", model: "sonnet", effort: "xhigh" },
		overrides: { advisor: { backend: "claude", model: "opus", effort: "max" } },
	});
	assert.deepEqual(selectionForCapability(claude, "explain"), {
		backend: "claude",
		model: "sonnet",
		effort: "xhigh",
	});
	assert.deepEqual(selectionForCapability(claude, "advisor"), {
		backend: "claude",
		model: "opus",
		effort: "max",
	});
});

test("Claude default effort omits effort from the backend selection", () => {
	const settings = parseBroSettings({
		version: 2,
		default: { backend: "claude", model: "sonnet", effort: "default" },
	});
	assert.deepEqual(selectionForCapability(settings, "explain"), { backend: "claude", model: "sonnet" });
});

test("Claude models support sonnet/opus aliases and arbitrary explicit IDs", () => {
	assert.deepEqual(
		CLAUDE_MODELS.map((model: { id: string }) => model.id).sort(),
		["opus", "sonnet"],
	);
	assert.equal(resolveClaudeModel("sonnet"), "sonnet");
	assert.equal(resolveClaudeModel(" Opus "), "opus");
	assert.equal(resolveClaudeModel("claude-opus-4-6"), "claude-opus-4-6");
	assert.throws(() => resolveClaudeModel("   "), /Claude model/);
});

test("Claude effort levels include xhigh and max", () => {
	assert.deepEqual([...CLAUDE_EFFORTS], ["low", "medium", "high", "xhigh", "max"]);
});

test("withCapabilityOverride stores the whole Claude pair and clears only on explicit undefined", () => {
	const base = parseBroSettings({ model: "m", effort: "low" });
	const pinned = withCapabilityOverride(base, "btw", { backend: "claude", model: "sonnet", effort: "low" });
	assert.deepEqual(pinned.overrides.btw, { backend: "claude", model: "sonnet", effort: "low" });
	assert.deepEqual(withCapabilityOverride(pinned, "btw", undefined).overrides, {});
});

test("Claude pairs resolve with no Agy family so config/doctor flag nothing catalog-based", () => {
	const resolved = resolveModelEffort({ backend: "claude", model: "sonnet", effort: "medium" }, []);
	assert.deepEqual(resolved, { pair: { backend: "claude", model: "sonnet", effort: "medium" } });
});


test("unknown schemas cannot be accepted as legacy and overwritten", () => {
 assert.throws(() => parseBroSettings({version: 99, model: "m", effort: "low"}), /Unsupported settings version/);
 assert.throws(() => parseBroSettings({version: 2, model: "m", effort: "low"}), /requires default/);
});


test("Grok all-feature support: selection, efforts, models", () => {
	assert.deepEqual([...GROK_EFFORTS], ["low", "medium", "high", "xhigh"]);
	assert.deepEqual(
		GROK_MODELS.map((model: { id: string }) => model.id).sort(),
		["grok-4.7", "grok-4.7-build-fast"],
	);
	assert.equal(resolveGrokModel("grok-4.7"), "grok-4.7");
	assert.equal(resolveGrokModel("  custom-grok-id  "), "custom-grok-id");
	assert.throws(() => resolveGrokModel("   "), /Grok model/);
	assert.equal(supportsBackend("grok", "advisor"), true);
	assert.equal(supportsBackend("grok", "explain"), true);
	assert.equal(supportsBackend("grok", "show"), true);
	assert.equal(supportsBackend("grok", "btw"), true);
});

test("Grok pairs parse, round-trip, and resolve with no Agy family", () => {
	const settings = parseBroSettings({
		version: 2,
		default: { backend: "grok", model: "grok-4.7", effort: "xhigh" },
		mode: "balanced",
		showTurns: 1,
		overrides: { advisor: { backend: "grok", model: "grok-4.7-build-fast", effort: "medium" } },
	});
	assert.equal(capabilityBackend(settings, "advisor"), "grok");
	assert.equal(capabilityBackend(settings, "explain"), "grok");
	assert.deepEqual(selectionForCapability(settings, "advisor"), {
		backend: "grok",
		model: "grok-4.7-build-fast",
		effort: "medium",
	});
	assert.deepEqual(resolveModelEffort({ backend: "grok", model: "grok-4.7", effort: "medium" }, []), {
		pair: { backend: "grok", model: "grok-4.7", effort: "medium" },
	});
	const payload = settingsPayload(settings);
	assert.deepEqual(payload.default, { backend: "grok", model: "grok-4.7", effort: "xhigh" });
	assert.deepEqual(parseBroSettings(payload), settings);
});

test("Grok default effort omits effort; max rejected, backend-less override stays Agy", () => {
	const settings = parseBroSettings({
		version: 2,
		default: { backend: "grok", model: "grok-4.7", effort: "default" },
	});
	assert.deepEqual(selectionForCapability(settings, "advisor"), { backend: "grok", model: "grok-4.7" });
	assert.throws(
		() =>
			parseBroSettings({
				version: 2,
				default: { backend: "grok", model: "grok-4.7", effort: "max" },
			}),
		/must contain a model and effort/,
	);
	const mixed = parseBroSettings({
		version: 2,
		default: { backend: "grok", model: "grok-4.7", effort: "low" },
		overrides: { show: { model: "gemini-a", effort: "low" } },
	});
	assert.equal(capabilityBackend(mixed, "show"), "agy");
	assert.deepEqual(selectionForCapability(mixed, "show"), { model: "gemini-a", effort: "low" });
	const pinned = withCapabilityOverride(parseBroSettings({ model: "m", effort: "low" }), "advisor", {
		backend: "grok",
		model: "grok-4.7",
		effort: "high",
	});
	assert.deepEqual(pinned.overrides.advisor, { backend: "grok", model: "grok-4.7", effort: "high" });
});

test("config custom Claude model selection is atomic and cancel preserves settings", async () => {
 const { initTheme } = await import("@earendil-works/pi-coding-agent"); initTheme();
 const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
 const { createConfigModal } = bro;
 const saved: any[] = [];
 const component = createConfigModal(parseBroSettings({model:"m",effort:"low"}), [], async (s: unknown) => { saved.push(s); })({requestRender(){}}, theme, {}, () => {});
 component.handleInput("\r");
 component.handleInput("\u001b[B"); component.handleInput("\u001b[B"); component.handleInput("\u001b[B"); component.handleInput("\u001b[B"); component.handleInput("\r");
 component.handleInput("custom-claude-model"); component.handleInput("\u001b");
 assert.equal(saved.length,0);
 component.handleInput("\r"); component.handleInput("\u001b[B"); component.handleInput("\u001b[B"); component.handleInput("\u001b[B"); component.handleInput("\u001b[B"); component.handleInput("\r");
 component.handleInput("custom-claude-model"); component.handleInput("\r");
 await new Promise(resolve => setTimeout(resolve,0));
 assert.equal(saved.length,1);
 assert.equal(saved[0].backend,"claude"); assert.equal(saved[0].model,"custom-claude-model"); assert.equal(saved[0].effort,"default");
});


test("Grok custom picker cancels atomically and resets cross-backend effort", async () => {
 const { initTheme } = await import("@earendil-works/pi-coding-agent"); initTheme();
 const saved: any[] = [];
 const modal = bro.createConfigModal(parseBroSettings({version:2,default:{backend:"claude",model:"sonnet",effort:"high"}}), [], async (s: unknown) => {saved.push(s);})({requestRender(){}},{fg: (_: string,s: string)=>s,bold:(s:string)=>s},{},()=>{});
 const openCustom = () => {modal.handleInput("\r"); for(let i=0;i<5;i++) modal.handleInput("\u001b[B"); modal.handleInput("\r");};
 openCustom(); modal.handleInput("grok-custom"); modal.handleInput("\u001b"); assert.equal(saved.length,0);
 openCustom(); modal.handleInput("grok-custom"); modal.handleInput("\r"); await new Promise(r=>setTimeout(r,0));
 assert.equal(saved.length,1); assert.equal(saved[0].backend,"grok"); assert.equal(saved[0].model,"grok-custom"); assert.equal(saved[0].effort,"default");
 assert.doesNotMatch(modal.render(120).join("\n"),/unsupported backend/);
});


test("BTW backend changes clear native continuation and transcript, same backend preserves them", () => {
 const thread = {turns:[{question:"q",answer:"a"}],conversationId:"grok-session",full:false,backend:"grok"};
 assert.equal(bro.bindBtwBackend(thread,"grok"),false); assert.equal(thread.conversationId,"grok-session");
 assert.equal(bro.bindBtwBackend(thread,"agy"),true); assert.equal(thread.conversationId,undefined); assert.deepEqual(thread.turns,[]);
});

test("modal model label shows the resolved per-capability model and effort", () => {
	const settings = parseBroSettings({
		version: 2,
		default: { backend: "agy", model: "gemini-a", effort: "default" },
		overrides: {
			explain: { backend: "claude", model: "opus", effort: "max" },
			show: { backend: "grok", model: "grok-4.7", effort: "default" },
			btw: { backend: "grok", model: "grok-4.7-build-fast", effort: "xhigh" },
		},
	});
	assert.equal(selectionLabel(selectionForCapability(settings, "explain")), "opus · max");
	assert.equal(selectionLabel(selectionForCapability(settings, "show")), "grok-4.7 · default");
	assert.equal(selectionLabel(selectionForCapability(settings, "btw")), "grok-4.7-build-fast · xhigh");
	assert.equal(selectionLabel(selectionForCapability(settings, "advisor")), "gemini-a · default");
	assert.equal(selectionLabel(selectionForCapability(parseBroSettings({ model: "gemini-b-low", effort: "low" }), "explain")), "gemini-b · low");
});

test("help no longer lists /bro usage or the conversation-only access label", () => {
	const text = helpText(parseBroSettings({ model: "m", effort: "low" }));
	assert.doesNotMatch(text, /\/bro usage/);
	assert.doesNotMatch(text, /not sandboxed/i);
	assert.doesNotMatch(text, /Usage checks/);
});
