import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoDir = dirname(fileURLToPath(import.meta.url));
// @ts-ignore Shared JavaScript test harness; compiled Bro intentionally exposes dynamic test types.
import { bro, backend } from "./test-build.mjs";
test('simplify is discoverable and follows bare Bro without treating the alias as source text', async () => {
 let command: any;
 await bro.default({on() {},registerTool() {},registerCommand(_name: string,def: any){command=def;}});
 assert.ok(command.getArgumentCompletions('simpl').some((item: any)=>item.value==='simplify'));
 for (const args of ['', 'simplify']) {
  let idle=0;const notices: string[]=[];
  await command.handler(args,{mode:'rpc',waitForIdle:async()=>{idle++;},sessionManager:{getBranch:()=>[]},ui:{notify:(message:string)=>notices.push(message)}});
  assert.equal(idle,1);assert.ok(notices.some(message=>message.includes('No completed assistant response')));
 }
 const notices: string[]=[];await command.handler('simplify pasted',{ui:{notify:(message:string)=>notices.push(message)}});assert.match(notices[0],/bro text/);
});

const { CLAUDE_EFFORTS } = backend;
const {
	CLAUDE_MODELS,
	GROK_EFFORTS,
	GROK_MODELS,
	CODEX_EFFORTS,
	CODEX_MODELS,
	MUSE_EFFORTS,
	MUSE_MODELS,
	capabilityBackend,
	parseBroSettings,
	resolveClaudeModel,
	resolveGrokModel,
	resolveCodexModel,
	resolveMuseModel,
	resolveModelEffort,
	applyModelChange,
	applyEffortChange,
	helpText,
	selectionForCapability,
	selectionLabel,
	settingsPayload,
	withCapabilityOverride,
} = bro;

test("bounded transcripts keep newest turns and valid quoted tails", () => {
 const message = (role: string, content: string) => ({type:'message', message:{role,content}});
 const ctx = {sessionManager:{getBranch:()=>[
  message('user','OLD_QUESTION'),message('assistant','x'.repeat(50000)),
  message('user','LATEST_QUESTION'),message('assistant','LATEST_ANSWER'),
 ]}};
 const recent=bro.captureShowTranscript(ctx,8,40000).text;
 assert.match(recent,/LATEST_QUESTION/); assert.match(recent,/LATEST_ANSWER/); assert.doesNotMatch(recent,/OLD_QUESTION/);
 ctx.sessionManager.getBranch=()=>[message('user','question'),message('assistant','x'.repeat(110000)+'LATEST_END')];
 const oversized=bro.captureShowTranscript(ctx,1,40000).text;
 assert.ok(oversized.length<=40000);
 assert.ok(JSON.parse(oversized.slice(oversized.indexOf('\n')+1)).endsWith('LATEST_END'));
 assert.match(oversized,/truncated/);
 for (const content of ['x'.repeat(390)+'END', '\\"\n'.repeat(300)+'END', '😀'.repeat(300)+'END']) {
  ctx.sessionManager.getBranch=()=>[message('user','old'.repeat(300)),message('assistant',content)];
  const text=bro.captureShowTranscript(ctx,1,400).text;
  assert.ok(text.length<=400);
  const entry=text.slice(text.indexOf('## assistant\n'));
  assert.ok(JSON.parse(entry.slice(entry.indexOf('\n')+1)).endsWith('END'));
 }
 assert.throws(()=>bro.captureShowTranscript(ctx,1,0),/at least 128/);
});

test("published manifest includes release and runtime documentation", () => {
 const manifest = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
 for (const file of ["README.md", "CHANGELOG.md"]) {
  assert.ok(manifest.files.includes(file), `${file} must ship`);
  assert.ok(readFileSync(join(repoDir, file), "utf8").trim());
 }
});

test("host-provided packages are wildcard peers, not runtime dependencies", () => {
	const manifest = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
		assert.equal(manifest.dependencies[name], undefined, name);
		assert.equal(manifest.peerDependencies[name], "*", name);
		assert.ok(manifest.devDependencies[name], `${name} remains available for development`);
	}
});

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

test("ensureSettingsFile initializes clean version 2 settings on disk", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-bro-settings-init-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		await bro.ensureSettingsFile();
		const raw = JSON.parse(readFileSync(join(tempDir, "bro-settings.json"), "utf8"));
		assert.equal(raw.version, 2);
		assert.equal(raw.default.backend, "agy");
		assert.equal(raw.default.effort, "low");
		assert.equal(raw.mode, "balanced");
		assert.equal(raw.showTurns, 1);
		assert.deepEqual(raw.overrides, undefined);
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	}
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

test("pure model/effort transitions preserve resolved variant effort and pin family IDs", () => {
	const families = [
		{
			id: "gemini-a",
			label: "Gemini A",
			efforts: ["low", "high"] as ("low" | "high")[],
			variants: [
				{ id: "gemini-a-low", effort: "low" as const },
				{ id: "gemini-a-high", effort: "high" as const },
			],
		},
		{
			id: "gemini-b",
			label: "Gemini B",
			efforts: [] as ("low" | "medium" | "high")[],
			variants: [{ id: "gemini-b" }],
		},
	];

	// P1 Codex regression: {model: "gemini-a-high", effort: "default"} resolves to high;
	// reselecting gemini-a preserves high instead of resetting to low.
	const variantPair = { model: "gemini-a-high", effort: "default" as const };
	const reselected = applyModelChange(variantPair, "gemini-a", families);
	assert.deepEqual(reselected, { model: "gemini-a", effort: "high" });

	// Reselecting a fixed-effort family normalizes to default
	const fixedReselected = applyModelChange(variantPair, "gemini-b", families);
	assert.deepEqual(fixedReselected, { model: "gemini-b", effort: "default" });

	// Switching to external backend with compatible effort keeps effort
	const claudeSwitch = applyModelChange({ backend: "claude", model: "sonnet", effort: "high" }, "claude:opus", families);
	assert.deepEqual(claudeSwitch, { backend: "claude", model: "opus", effort: "high" });

	// Switching across different backends resets effort to default
	const grokSwitch = applyModelChange({ backend: "claude", model: "sonnet", effort: "high" }, "grok:grok-4.7", families);
	assert.deepEqual(grokSwitch, { backend: "grok", model: "grok-4.7", effort: "default" });

	// Effort edit pins resolved family ID
	const effortEdit = applyEffortChange({ model: "gemini-a-low", effort: "default" }, "high", families);
	assert.deepEqual(effortEdit, { model: "gemini-a", effort: "high" });
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
 for (let i = 0; i < 8; i++) component.handleInput("\u001b[B"); component.handleInput("\r");
 component.handleInput("custom-claude-model"); component.handleInput("\u001b");
 assert.equal(saved.length,0);
 component.handleInput("\r"); for (let i = 0; i < 8; i++) component.handleInput("\u001b[B"); component.handleInput("\r");
 component.handleInput("custom-claude-model"); component.handleInput("\r");
 await new Promise(resolve => setTimeout(resolve,0));
 assert.equal(saved.length,1);
 assert.equal(saved[0].backend,"claude"); assert.equal(saved[0].model,"custom-claude-model"); assert.equal(saved[0].effort,"default");
});


test("Grok custom picker cancels atomically and resets cross-backend effort", async () => {
 const { initTheme } = await import("@earendil-works/pi-coding-agent"); initTheme();
 const saved: any[] = [];
 const modal = bro.createConfigModal(parseBroSettings({version:2,default:{backend:"claude",model:"sonnet",effort:"high"}}), [], async (s: unknown) => {saved.push(s);})({requestRender(){}},{fg: (_: string,s: string)=>s,bold:(s:string)=>s},{},()=>{});
 const openCustom = () => {modal.handleInput("\r"); for(let i=0;i<9;i++) modal.handleInput("\u001b[B"); modal.handleInput("\r");};
 openCustom(); modal.handleInput("grok-custom"); modal.handleInput("\u001b"); assert.equal(saved.length,0);
 openCustom(); modal.handleInput("grok-custom"); modal.handleInput("\r"); await new Promise(r=>setTimeout(r,0));
 assert.equal(saved.length,1); assert.equal(saved[0].backend,"grok"); assert.equal(saved[0].model,"grok-custom"); assert.equal(saved[0].effort,"default");
 assert.doesNotMatch(modal.render(120).join("\n"),/unsupported backend/);
});

test("Codex all-feature support: selection, efforts, models", () => {
	assert.deepEqual([...CODEX_EFFORTS], ["low", "medium", "high", "xhigh"]);
	assert.deepEqual(
		CODEX_MODELS.map((model: { id: string }) => model.id).sort(),
		["gpt-5.4", "gpt-5.5"],
	);
	assert.equal(resolveCodexModel("gpt-5.5"), "gpt-5.5");
	assert.equal(resolveCodexModel("  custom-codex-id  "), "custom-codex-id");
	assert.throws(() => resolveCodexModel("   "), /Codex model/);




});

test("Codex pairs parse, round-trip, and resolve with no Agy family", () => {
	const settings = parseBroSettings({
		version: 2,
		default: { backend: "codex", model: "gpt-5.5", effort: "xhigh" },
		mode: "balanced",
		showTurns: 1,
		overrides: { advisor: { backend: "codex", model: "gpt-5.4", effort: "medium" } },
	});
	assert.equal(capabilityBackend(settings, "advisor"), "codex");
	assert.equal(capabilityBackend(settings, "explain"), "codex");
	assert.deepEqual(selectionForCapability(settings, "advisor"), {
		backend: "codex",
		model: "gpt-5.4",
		effort: "medium",
	});
	assert.deepEqual(resolveModelEffort({ backend: "codex", model: "gpt-5.5", effort: "medium" }, []), {
		pair: { backend: "codex", model: "gpt-5.5", effort: "medium" },
	});
	const payload = settingsPayload(settings);
	assert.deepEqual(payload.default, { backend: "codex", model: "gpt-5.5", effort: "xhigh" });
	assert.deepEqual(parseBroSettings(payload), settings);
});

test("Codex default effort omits effort; max rejected, backend-less override stays Agy", () => {
	const settings = parseBroSettings({
		version: 2,
		default: { backend: "codex", model: "gpt-5.5", effort: "default" },
	});
	assert.deepEqual(selectionForCapability(settings, "advisor"), { backend: "codex", model: "gpt-5.5" });
	assert.throws(
		() =>
			parseBroSettings({
				version: 2,
				default: { backend: "codex", model: "gpt-5.5", effort: "max" },
			}),
		/must contain a model and effort/,
	);
	const mixed = parseBroSettings({
		version: 2,
		default: { backend: "codex", model: "gpt-5.5", effort: "low" },
		overrides: { show: { model: "gemini-a", effort: "low" } },
	});
	assert.equal(capabilityBackend(mixed, "show"), "agy");
	assert.deepEqual(selectionForCapability(mixed, "show"), { model: "gemini-a", effort: "low" });
	const pinned = withCapabilityOverride(parseBroSettings({ model: "m", effort: "low" }), "advisor", {
		backend: "codex",
		model: "gpt-5.5",
		effort: "high",
	});
	assert.deepEqual(pinned.overrides.advisor, { backend: "codex", model: "gpt-5.5", effort: "high" });
});

test("Codex custom picker cancels atomically and resets cross-backend effort", async () => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent"); initTheme();
	const saved: any[] = [];
	const modal = bro.createConfigModal(parseBroSettings({version:2,default:{backend:"claude",model:"sonnet",effort:"high"}}), [], async (s: unknown) => {saved.push(s);})({requestRender(){}},{fg: (_: string,s: string)=>s,bold:(s:string)=>s},{},()=>{});
	const openCustom = () => {modal.handleInput("\r"); for(let i=0;i<10;i++) modal.handleInput("\u001b[B"); modal.handleInput("\r");};
	openCustom(); modal.handleInput("codex-custom"); modal.handleInput("\u001b"); assert.equal(saved.length,0);
	openCustom(); modal.handleInput("codex-custom"); modal.handleInput("\r"); await new Promise(r=>setTimeout(r,0));
	assert.equal(saved.length,1); assert.equal(saved[0].backend,"codex"); assert.equal(saved[0].model,"codex-custom"); assert.equal(saved[0].effort,"default");
	assert.doesNotMatch(modal.render(120).join("\n"),/unsupported backend/);
});

test("Muse all-feature support: selection, efforts, models", () => {
	assert.deepEqual([...MUSE_EFFORTS], ["minimal", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(
		MUSE_MODELS.map((model: { id: string }) => model.id).sort(),
		["muse-spark-1.3", "muse-spark-1.3-contributor"],
	);
	assert.equal(resolveMuseModel("muse-spark-1.3"), "muse-spark-1.3");
	assert.equal(resolveMuseModel("  custom-muse-id  "), "custom-muse-id");
	assert.throws(() => resolveMuseModel("   "), /Muse model/);




});

test("Muse pairs parse, round-trip, and resolve with no Agy family", () => {
	const settings = parseBroSettings({
		version: 2,
		default: { backend: "muse", model: "muse-spark-1.3", effort: "minimal" },
		mode: "balanced",
		showTurns: 1,
		overrides: { advisor: { backend: "muse", model: "muse-spark-1.3-contributor", effort: "max" } },
	});
	assert.equal(capabilityBackend(settings, "advisor"), "muse");
	assert.equal(capabilityBackend(settings, "explain"), "muse");
	assert.deepEqual(selectionForCapability(settings, "advisor"), {
		backend: "muse",
		model: "muse-spark-1.3-contributor",
		effort: "max",
	});
	assert.deepEqual(resolveModelEffort({ backend: "muse", model: "muse-spark-1.3", effort: "minimal" }, []), {
		pair: { backend: "muse", model: "muse-spark-1.3", effort: "minimal" },
	});
	const payload = settingsPayload(settings);
	assert.deepEqual(payload.default, { backend: "muse", model: "muse-spark-1.3", effort: "minimal" });
	assert.deepEqual(parseBroSettings(payload), settings);
});

test("Muse default effort omits effort; none/off rejected, backend-less override stays Agy", () => {
	const settings = parseBroSettings({
		version: 2,
		default: { backend: "muse", model: "muse-spark-1.3", effort: "default" },
	});
	assert.deepEqual(selectionForCapability(settings, "advisor"), { backend: "muse", model: "muse-spark-1.3" });
	assert.throws(
		() =>
			parseBroSettings({
				version: 2,
				default: { backend: "muse", model: "muse-spark-1.3", effort: "none" },
			}),
		/must contain a model and effort/,
	);
	const mixed = parseBroSettings({
		version: 2,
		default: { backend: "muse", model: "muse-spark-1.3", effort: "low" },
		overrides: { show: { model: "gemini-a", effort: "low" } },
	});
	assert.equal(capabilityBackend(mixed, "show"), "agy");
	assert.deepEqual(selectionForCapability(mixed, "show"), { model: "gemini-a", effort: "low" });
	const pinned = withCapabilityOverride(parseBroSettings({ model: "m", effort: "low" }), "advisor", {
		backend: "muse",
		model: "muse-spark-1.3",
		effort: "high",
	});
	assert.deepEqual(pinned.overrides.advisor, { backend: "muse", model: "muse-spark-1.3", effort: "high" });
});

test("Muse custom picker cancels atomically and resets cross-backend effort", async () => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent"); initTheme();
	const saved: any[] = [];
	const modal = bro.createConfigModal(parseBroSettings({version:2,default:{backend:"claude",model:"sonnet",effort:"high"}}), [], async (s: unknown) => {saved.push(s);})({requestRender(){}},{fg: (_: string,s: string)=>s,bold:(s:string)=>s},{},()=>{});
	const openCustom = () => {modal.handleInput("\r"); for(let i=0;i<11;i++) modal.handleInput("\u001b[B"); modal.handleInput("\r");};
	openCustom(); modal.handleInput("muse-custom"); modal.handleInput("\u001b"); assert.equal(saved.length,0);
	openCustom(); modal.handleInput("muse-custom"); modal.handleInput("\r"); await new Promise(r=>setTimeout(r,0));
	assert.equal(saved.length,1); assert.equal(saved[0].backend,"muse"); assert.equal(saved[0].model,"muse-custom"); assert.equal(saved[0].effort,"default");
	assert.doesNotMatch(modal.render(120).join("\n"),/unsupported backend/);
});

test("BTW backend changes clear native continuation for every backend, same backend preserves them", () => {
	for (const backend of ["agy", "claude", "grok", "codex", "muse"] as const) {
		const thread = { turns: [{ question: "q", answer: "a" }], conversationId: `${backend}-session`, full: false, backend };
		assert.equal(bro.bindBtwBackend(thread, backend), false);
		assert.equal(thread.conversationId, `${backend}-session`);
		assert.equal(bro.bindBtwBackend(thread, backend === "agy" ? "claude" : "agy"), true);
		assert.equal(thread.conversationId, undefined);
		assert.deepEqual(thread.turns, []);
	}
});

test("BTW /mode keeps the transcript; only Agy drops its native session on an access change", () => {
 const turns=[{question:"q",answer:"a"}];
 for (const backend of ["claude","grok","codex","muse"]) {
  const thread={turns:[...turns],conversationId:"sess",full:false,backend,sessionFull:false};
  bro.toggleBtwMode(thread); assert.equal(thread.full,true); assert.deepEqual(thread.turns,turns);
  assert.equal(bro.nativeBtwContinuation(thread,backend),"sess",backend);
 }
 const agy={turns:[...turns],conversationId:"conv",full:false,backend:"agy",sessionFull:false};
 assert.equal(bro.nativeBtwContinuation(agy,"agy"),"conv");
 bro.toggleBtwMode(agy); assert.equal(agy.full,true);
 assert.equal(bro.nativeBtwContinuation(agy,"agy"),undefined); assert.equal(agy.conversationId,undefined); assert.deepEqual(agy.turns,turns);
 assert.equal(bro.btwModeLabel(false),"conversation-only"); assert.equal(bro.btwModeLabel(true),"full permission");
});

test("BTW backend change also clears the saved seed context and session mode", () => {
 const thread={turns:[{question:"q",answer:"a"}],conversationId:"c",full:true,backend:"agy",context:"ctx",sessionFull:true,sessionPreferences:"p"};
 assert.equal(bro.bindBtwBackend(thread,"claude"),true);
 assert.deepEqual(thread,{turns:[],conversationId:undefined,full:true,backend:"claude",context:undefined,sessionFull:undefined,sessionPreferences:undefined});
});

test("BTW drops the native session on any backend when preferences change or are deleted", () => {
 const turns=[{question:"q",answer:"a"}];
 for (const backend of ["agy","claude","grok","codex","muse"]) {
  const thread={turns:[...turns],conversationId:"sess",full:false,backend,sessionFull:false,sessionPreferences:"Answer in Vietnamese."};
  assert.equal(bro.nativeBtwContinuation(thread,backend,"Answer in Vietnamese."),"sess",`${backend}: unchanged preferences resume`);
  assert.equal(bro.nativeBtwContinuation(thread,backend,"Answer in English."),undefined,`${backend}: a change reseeds`);
  assert.deepEqual(thread.turns,turns,"the transcript is kept for the reseed");
  const deleted={turns:[...turns],conversationId:"sess",full:false,backend,sessionFull:false,sessionPreferences:"Be brief."};
  assert.equal(bro.nativeBtwContinuation(deleted,backend),undefined,`${backend}: deleting preferences reseeds`);
  const never={turns:[...turns],conversationId:"sess",full:false,backend,sessionFull:false};
  assert.equal(bro.nativeBtwContinuation(never,backend),"sess",`${backend}: no preferences before or now resumes`);
 }
 assert.equal(bro.btwHeaderLabel({model:"m · low",preferences:true}),"m · low · prefs");
 assert.equal(bro.btwHeaderLabel({model:"m · low",preferences:false}),"m · low");
 assert.equal(bro.btwHeaderLabel({}),"");
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

test("help drops removed /bro model, /bro effort, --fresh, and forced inserts", () => {
	const text = helpText(parseBroSettings({ model: "m", effort: "low" }));
	assert.doesNotMatch(text, /\/bro (model|effort)/);
	assert.doesNotMatch(text, /--fresh/);
	assert.doesNotMatch(text, /\/insert(-all)?!/);
	assert.match(text, /\/bro config/);
});

test("help is a concise reference: no removed BTW flags, /mode documented, README pointer", () => {
	for (const backend of ["agy", "claude", "grok"] as const) {
		const text = helpText(parseBroSettings({ version: 2, default: { backend, model: "m", effort: "default" } }));
		assert.doesNotMatch(text, /--(full|sandbox|fresh)\b/);
		assert.doesNotMatch(text, /--dangerously|--permission-mode|--resume|--conversation/);
		assert.match(text, /`\/mode`/);
		assert.match(text, /README/);
		assert.match(text, /brief —/);
		assert.ok(text.length < 6000, `help is ${text.length} chars`);
	}
});


test("modals use live host terminal rows, not extension stdout", async () => {
 const { initTheme } = await import("@earendil-works/pi-coding-agent"); initTheme();
 let command: any;
 await bro.default({on() {}, registerTool() {}, registerCommand(_name: string, def: any) { command=def; }});
 const tui = {mode: "regular", terminal: {rows: 20}, requestRender() {}};
 const theme = {fg: (_color: string, text: string) => text, bold: (text: string) => text};
 for (const action of ["help", "btw"]) {
  let modal: any;
  await command.handler(action, {mode:"tui", hasUI:true, cwd:process.cwd(), sessionManager:{getBranch:()=>[]}, ui:{notify() {}, custom:async (factory: any)=>{modal=factory(tui,theme,{},()=>{});}}});
  tui.terminal.rows=20; const short=modal.render(80).length;
  tui.terminal.rows=45; const tall=modal.render(80).length;
  assert.ok(tall > short, `${action}: host resize must change modal height (${short} -> ${tall})`);
  modal.dispose?.();
 }
});

test("BTW turns carry preferences and reseed the native session when they change", async () => {
 const { initTheme } = await import("@earendil-works/pi-coding-agent"); initTheme();
 const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const bin = mkdtempSync(join(tmpdir(), "pi-bro-btw-prefs-"));
 const log = join(bin, "argv.jsonl");
 writeFileSync(join(bin, "agy"), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'ANSWER',conversation_id:'conv-1'}}));
`, { mode: 0o755 });
 const agentDir = process.env.PI_CODING_AGENT_DIR!;
 mkdirSync(agentDir, { recursive: true });
 writeFileSync(join(agentDir, "bro-settings.json"), JSON.stringify({ model: "gemini-3.7-flash", effort: "low", mode: "balanced", showTurns: 1, overrides: {} }));
 const preferences = join(agentDir, "bro-preferences.md");
 const originalPath = process.env.PATH;
 process.env.PATH = `${bin}:${originalPath}`;
 let command: any, modal: any;
 const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : [];
 const prompt = (argv: string[]) => argv[argv.indexOf("--print") + 1]!;
 const ask = async (question: string) => {
  const before = calls().length;
  for (const ch of question) modal.handleInput(ch);
  modal.handleInput("\r");
  for (let i = 0; i < 1000 && (calls().length === before || modal.running); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls().length, before + 1);
  return calls().at(-1)!;
 };
 try {
  writeFileSync(preferences, "BTW_PREFS_A");
  await bro.default({ on() {}, registerTool() {}, registerCommand(_name: string, def: any) { command = def; } });
  const ctx = { mode: "tui", hasUI: true, cwd: bin, sessionManager: { getBranch: () => [] }, ui: { notify() {}, custom: async (factory: any) => { modal = factory({ mode: "fullscreen", terminal: { rows: 40 }, requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, () => {}); } } };
  await command.handler("btw", ctx);
  const header = () => modal.render(120)[1] as string;

  let argv = await ask("Q1");
  assert.ok(prompt(argv).includes(JSON.stringify("BTW_PREFS_A")));
  assert.ok(!argv.includes("--conversation"));
  assert.match(header(), / · prefs/);

  argv = await ask("Q2");
  assert.deepEqual(argv.slice(argv.indexOf("--conversation"), argv.indexOf("--conversation") + 2), ["--conversation", "conv-1"], "unchanged preferences resume natively");

  writeFileSync(preferences, "BTW_PREFS_B");
  argv = await ask("Q3");
  assert.ok(!argv.includes("--conversation"), "changed preferences start a fresh native session");
  assert.ok(prompt(argv).includes(JSON.stringify("BTW_PREFS_B")));
  assert.match(prompt(argv), /Earlier turns of this side conversation/, "the fresh session is reseeded with the thread");
  assert.doesNotMatch(prompt(argv).split("Earlier turns")[0]!, /BTW_PREFS_A/, "old preferences are not current instructions");

  rmSync(preferences);
  argv = await ask("Q4");
  assert.ok(!argv.includes("--conversation"), "deleting preferences also reseeds");
  assert.doesNotMatch(prompt(argv), /preferences/);
  assert.doesNotMatch(header(), /prefs/);

  const type = (text: string) => { for (const ch of text) modal.handleInput(ch); modal.handleInput("\r"); };
  const idle = async () => { for (let i = 0; i < 300 && modal.running; i++) await new Promise((resolve) => setTimeout(resolve, 10)); };
  writeFileSync(preferences, "x".repeat(4_001));
  const before = calls().length;
  type("/retry"); await idle();
  assert.equal(calls().length, before, "oversize preferences stop BTW before any backend call");
  assert.match(modal.notice, /4,001 characters; keep it under 4,000/);
  rmSync(preferences);
  argv = await ask("/retry");
  assert.match(prompt(argv), /Question:\nQ4$/, "a /retry that never started kept the turn it replaced");

  const afterRetry = calls().length;
  type("Q5");
  modal.dispose(); // close while settings and preferences are still being read
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls().length, afterRetry, "a closed thread never runs the turn");
  await command.handler("btw", ctx);
  const transcript = modal.markdown.text as string; // the whole thread, not just the visible window
  assert.match(transcript, /Q4/);
  assert.doesNotMatch(transcript, /Q5/, "closing during the reads leaves no phantom turn");
 } finally {
  modal?.dispose?.();
  process.env.PATH = originalPath;
  rmSync(bin, { recursive: true, force: true });
  rmSync(preferences, { force: true });
 }
});
