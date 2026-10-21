import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoDir = dirname(dirname(fileURLToPath(import.meta.url)));
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
	EXTERNAL_BACKENDS,
	helpText,
	piModelValue,
	resolvePiModel,
	selectionForCapability,
	selectionLabel,
	settingsPayload,
	toPiModelChoices,
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
 for (const file of ["README.md", "CHANGELOG.md", "docs/user-guide.md"]) {
  assert.ok(manifest.files.includes(file), `${file} must ship`);
  assert.ok(readFileSync(join(repoDir, file), "utf8").trim());
 }
});

test("host-provided packages are wildcard peers, not runtime dependencies", () => {
	const manifest = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
	// pi-ai is imported directly for clampThinkingLevel, which the pi-coding-agent root does not
	// re-export, so it is a peer too rather than something Bro may bundle its own copy of.
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"]) {
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

test("legacy settings migration, capability override persistence, and model/turn validation", () => {
	const base = { model: "gemini-a", effort: "low" as const, mode: "balanced" as const, showTurns: 1, overrides: {} };
	assert.deepEqual(
		withCapabilityOverride(base, "show", { model: "gemini-a", effort: "low" }).overrides,
		{ show: { model: "gemini-a", effort: "low" } },
		"an override matching the shared default is still stored explicitly -- it is never silently treated as redundant",
	);
	assert.deepEqual(withCapabilityOverride(base, "show", { model: "gemini-b", effort: "default" }).overrides, { show: { model: "gemini-b", effort: "default" } });
	assert.deepEqual(
		withCapabilityOverride({ ...base, overrides: { show: { model: "gemini-b", effort: "default" } } }, "show", undefined).overrides,
		{},
		'clearing an override removes it only via an explicit undefined (the "Default" selection)',
	);
	assert.deepEqual(
		withCapabilityOverride(base, "advisor", { model: "gemini-b", effort: "default" }).overrides,
		{ advisor: { model: "gemini-b", effort: "default" } },
		"withCapabilityOverride also accepts the advisor capability, for the config modal's advisor rows",
	);

	assert.deepEqual(
		settingsPayload({ model: "gemini-a", effort: "low", mode: "balanced", showTurns: 1, overrides: { show: { model: "gemini-a", effort: "low" } } }),
		{ version: 2, default: { backend: "agy", model: "gemini-a", effort: "low" }, mode: "balanced", showTurns: 1, overrides: { show: { backend: "agy", model: "gemini-a", effort: "low" } } },
		"an override identical to the shared default is still written to disk -- settingsPayload does not deduplicate entries",
	);

	assert.deepEqual(parseBroSettings({ model: "m", effort: "low" }).overrides, {});
	assert.deepEqual(
		parseBroSettings({ model: "m", effort: "low", overrides: { explain: { model: "gemini-a", effort: "high" }, somethingUnknown: { model: "x", effort: "low" } } }).overrides,
		{ explain: { model: "gemini-a", effort: "high" } },
	);
	assert.deepEqual(
		parseBroSettings({ model: "m", effort: "low", overrides: { advisor: { model: "gemini-a", effort: "high" } } }).overrides,
		{ advisor: { model: "gemini-a", effort: "high" } },
		"an advisor override is preserved",
	);
	assert.throws(() => parseBroSettings({ model: "m", effort: "low", overrides: { explain: { model: "m" } } }), /overrides\.explain/);
	assert.throws(() => parseBroSettings({ model: "m", effort: "low", overrides: { explain: [] } }), /overrides\.explain/);
	assert.throws(() => parseBroSettings({ model: "m", effort: "low", overrides: "nope" }), /overrides must be an object/);
	assert.throws(() => parseBroSettings({ model: "m", effort: "low", overrides: [] }), /overrides must be an object/);
	assert.throws(() => parseBroSettings({ model: "m", effort: "low", overrides: [{ model: "m", effort: "low" }] }), /overrides must be an object/);

	assert.deepEqual(parseBroSettings({ model: " gemini-one ", effort: "high" }), {
		model: "gemini-one",
		effort: "high",
		mode: "balanced",
		showTurns: 1,
		overrides: {},
	});
	assert.deepEqual(parseBroSettings({ model: "gemini-one", effort: "low", mode: "faithful" }), {
		model: "gemini-one",
		effort: "low",
		mode: "faithful",
		showTurns: 1,
		overrides: {},
	});
	assert.throws(() => parseBroSettings({ model: "gemini-one", effort: "low", mode: "unknown" }), /mode/);
	assert.throws(() => parseBroSettings({ model: "gemini-one", effort: "extreme" }), /Settings must contain/);

	assert.throws(() => parseBroSettings({ model: "m", effort: "low", mode: "brief", showTurns: 0 }), /showTurns/);
	assert.throws(() => parseBroSettings({ model: "m", effort: "low", mode: "brief", showTurns: 2.5 }), /showTurns/);
	assert.equal(parseBroSettings({ model: "m", effort: "low", mode: "brief" }).showTurns, 1);
	assert.equal(parseBroSettings({ model: "m", effort: "low", mode: "brief", showTurns: 9 }).showTurns, 9);
});

test("writeSettings persists valid settings atomically with mode 0o600 and no leftover temp files", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-bro-settings-atomic-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		const target = join(tempDir, "bro-settings.json");
		const initial = parseBroSettings({ version: 2, default: { backend: "agy", model: "test-model-1", effort: "low" } });
		await bro.writeSettings(initial);

		const raw = readFileSync(target, "utf8");
		assert.ok(raw.endsWith("\n"), "persisted settings must end with newline");
		const parsed = JSON.parse(raw);
		assert.equal(parsed.version, 2);
		assert.equal(parsed.default.model, "test-model-1");

		const readBack = await bro.readSettings();
		assert.equal(readBack.model, "test-model-1");

		const files = readdirSync(tempDir);
		assert.deepEqual(files, ["bro-settings.json"], "temporary sibling files must not remain after success");

		if (process.platform !== "win32") {
			const info = statSync(target);
			assert.equal(info.mode & 0o777, 0o600, "settings file must be restricted to 0o600");
		}
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("writeSettings failure during rename preserves original file and cleans up temp files", async (t) => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-bro-settings-rename-fail-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		const target = join(tempDir, "bro-settings.json");
		const initial = parseBroSettings({ version: 2, default: { backend: "agy", model: "initial-model", effort: "low" } });
		await bro.writeSettings(initial);
		const initialRaw = readFileSync(target, "utf8");

		t.mock.method(fsp, "rename", async () => {
			throw Object.assign(new Error("Injected rename failure"), { code: "EIO" });
		});
		syncBuiltinESMExports();

		const mutated = parseBroSettings({ version: 2, default: { backend: "agy", model: "mutated-model", effort: "high" } });
		await assert.rejects(bro.writeSettings(mutated), /Injected rename failure/);

		// Original file remains completely unchanged
		const currentRaw = readFileSync(target, "utf8");
		assert.equal(currentRaw, initialRaw);
		const preserved = await bro.readSettings();
		assert.equal(preserved.model, "initial-model");

		// Temporary sibling files cleaned up
		const files = readdirSync(tempDir);
		assert.deepEqual(files, ["bro-settings.json"]);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("writeSettings failure during write preserves original file and cleans up temp files", async (t) => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-bro-settings-write-fail-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		const target = join(tempDir, "bro-settings.json");
		const initial = parseBroSettings({ version: 2, default: { backend: "agy", model: "initial-model", effort: "low" } });
		await bro.writeSettings(initial);
		const initialRaw = readFileSync(target, "utf8");

		t.mock.method(fsp, "writeFile", async () => {
			throw Object.assign(new Error("Injected write failure (ENOSPC)"), { code: "ENOSPC" });
		});
		syncBuiltinESMExports();

		const mutated = parseBroSettings({ version: 2, default: { backend: "agy", model: "mutated-model", effort: "high" } });
		await assert.rejects(bro.writeSettings(mutated), /Injected write failure/);

		t.mock.restoreAll();
		syncBuiltinESMExports();

		// Original file remains completely unchanged
		const currentRaw = readFileSync(target, "utf8");
		assert.equal(currentRaw, initialRaw);
		const preserved = await bro.readSettings();
		assert.equal(preserved.model, "initial-model");

		// Temporary sibling files cleaned up
		const files = readdirSync(tempDir);
		assert.deepEqual(files, ["bro-settings.json"]);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("writeSettings preserves symlinked settings file and updates target file", async (t) => {
	if (process.platform === "win32") {
		t.skip("Symlink creation requires elevated privileges on Windows");
		return;
	}
	const agentDir = mkdtempSync(join(tmpdir(), "pi-bro-symlink-agent-"));
	const targetDir = mkdtempSync(join(tmpdir(), "pi-bro-symlink-target-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const realTarget = join(targetDir, "dotfiles-bro-settings.json");
		const initial = parseBroSettings({ version: 2, default: { backend: "agy", model: "symlinked-model-v1", effort: "low" } });
		writeFileSync(realTarget, `${JSON.stringify(settingsPayload(initial), null, 2)}\n`, { mode: 0o600 });

		const linkPath = join(agentDir, "bro-settings.json");
		symlinkSync(realTarget, linkPath);

		assert.ok(lstatSync(linkPath).isSymbolicLink(), "precondition: linkPath is a symlink");

		const updated = parseBroSettings({ version: 2, default: { backend: "agy", model: "symlinked-model-v2", effort: "high" } });
		await bro.writeSettings(updated);

		// linkPath must still be a symlink pointing to realTarget
		assert.ok(lstatSync(linkPath).isSymbolicLink(), "linkPath must remain a symlink");
		assert.equal(readlinkSync(linkPath), realTarget, "symlink destination must be preserved");

		// Real target file must be updated
		const readBack = await bro.readSettings();
		assert.equal(readBack.model, "symlinked-model-v2");
		assert.equal(readBack.effort, "high");
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(targetDir, { recursive: true, force: true });
	}
});

test("writeSettings rejects and preserves symlink when symlink target disappears", async (t) => {
	if (process.platform === "win32") {
		t.skip("Symlink creation requires elevated privileges on Windows");
		return;
	}
	const agentDir = mkdtempSync(join(tmpdir(), "pi-bro-broken-link-agent-"));
	const targetDir = mkdtempSync(join(tmpdir(), "pi-bro-broken-link-target-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const realTarget = join(targetDir, "dotfiles-bro-settings.json");
		const initial = parseBroSettings({ version: 2, default: { backend: "agy", model: "valid-initial", effort: "low" } });
		writeFileSync(realTarget, `${JSON.stringify(settingsPayload(initial), null, 2)}\n`, { mode: 0o600 });

		const linkPath = join(agentDir, "bro-settings.json");
		symlinkSync(realTarget, linkPath);

		// 1. Load settings succeeds
		const loaded = await bro.readSettings();
		assert.equal(loaded.model, "valid-initial");

		// 2. Remove symlink target (dotfiles target disappears)
		rmSync(realTarget);

		// 3. Save must reject rather than silently overwriting the symlink with a regular file
		const updated = parseBroSettings({ version: 2, default: { backend: "agy", model: "attempted-mutation", effort: "high" } });
		await assert.rejects(bro.writeSettings(updated));

		// 4. Symlink is preserved
		assert.ok(lstatSync(linkPath).isSymbolicLink(), "linkPath must remain a symlink");
		assert.equal(readlinkSync(linkPath), realTarget, "symlink destination must be intact");

		// 5. No stray temporary files created
		const files = readdirSync(agentDir);
		assert.deepEqual(files, ["bro-settings.json"]);
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(targetDir, { recursive: true, force: true });
	}
});

test("modal rollback on persistence failure agrees with on-disk state", async (t) => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme();
	const tempDir = mkdtempSync(join(tmpdir(), "pi-bro-modal-rollback-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		const initial = parseBroSettings({ version: 2, default: { backend: "agy", model: "gemini-3.7-flash", effort: "low" } });
		await bro.writeSettings(initial);

		// Real writeSettings with injected rename error
		t.mock.method(fsp, "rename", async () => {
			throw Object.assign(new Error("Injected rename disk full"), { code: "ENOSPC" });
		});
		syncBuiltinESMExports();

		const families = [{ id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", efforts: ["low", "high"] as ("low" | "high")[], variants: [] }];
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const modal = bro.createConfigModal(initial, families, bro.writeSettings)({
			requestRender() {},
		}, theme, {}, () => {});

		// Trigger an effort change: model is first row, effort is second row
		modal.handleInput("\u001b[B"); // navigate down to effort
		modal.handleInput("\r");       // change effort
		// The save is queued asynchronously; wait for its outcome rather than a fixed delay.
		for (let i = 0; i < 500 && !modal.render(120).join("\n").includes("Could not save settings"); i++) await new Promise((r) => setTimeout(r, 10));

		// Modal UI reflects failure and rollback
		const rendered = modal.render(120).join("\n");
		assert.match(rendered, /Could not save settings: Injected rename disk full/);
		assert.match(rendered, /Reverted to the last saved settings/);

		t.mock.restoreAll();
		syncBuiltinESMExports();

		// On-disk file strictly matches the rolled-back state
		const onDisk = await bro.readSettings();
		assert.equal(onDisk.effort, "low", "on-disk settings must retain initial effort");
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
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

for (const backend of ["claude", "grok", "codex", "muse", "pi"] as const) {
	test(`${EXTERNAL_BACKENDS[backend].label} custom picker cancels atomically and resets cross-backend effort`, async () => {
		const { initTheme } = await import("@earendil-works/pi-coding-agent");
		initTheme();
		const saved: any[] = [];
		const initialBackend = backend === "claude" ? "agy" : "claude";
		const initialSettings = parseBroSettings(
			initialBackend === "agy"
				? { version: 2, default: { model: "gemini-a", effort: "low" } }
				: { version: 2, default: { backend: "claude", model: "sonnet", effort: "high" } },
		);
		const modal = bro.createConfigModal(
			initialSettings,
			[],
			async (s: unknown) => { saved.push(s); },
		)({ requestRender() {} }, { fg: (_: string, s: string) => s, bold: (s: string) => s }, {}, () => {});

		// Two-step picker: step 1 lists backends (Agy, Claude, Grok, Codex, Muse, Pi); step 2 lists that
		// backend's models with a "custom model ID…" row last. Esc in step 2 returns to step 1 unsaved.
		const BACKEND_ORDER = ["agy", "claude", "grok", "codex", "muse", "pi"] as const;
		const backendIndex = BACKEND_ORDER.indexOf(backend);
		// The step-1 list opens on the initially selected backend (the shared default's backend).
		const startingBackendIndex = BACKEND_ORDER.indexOf(initialBackend);
		const customRowIndex = EXTERNAL_BACKENDS[backend].models.length; // after the seed models
		// Pi addresses models as "<provider>/<id>", so its custom entry must be shaped that way.
		const customModel = backend === "pi" ? "acme/pi-custom" : `${backend}-custom`;

		const openCustom = () => {
			modal.handleInput("\r"); // Open the Default model submenu (step 1: backends).
			const delta = backendIndex - startingBackendIndex;
			for (let i = 0; i < Math.abs(delta); i++) modal.handleInput(delta > 0 ? "\u001b[B" : "\u001b[A");
			modal.handleInput("\r"); // Enter step 2 for the chosen backend.
			for (let i = 0; i < customRowIndex; i++) modal.handleInput("\u001b[B");
			modal.handleInput("\r"); // Select "custom model ID…".
		};

		openCustom();
		modal.handleInput(customModel);
		// Esc walks back: custom → model list → backend list → submenu closed (nothing saved).
		modal.handleInput("\u001b");
		modal.handleInput("\u001b");
		modal.handleInput("\u001b");
		assert.equal(saved.length, 0);

		openCustom();
		modal.handleInput(customModel);
		modal.handleInput("\r");
		await new Promise((r) => setTimeout(r, 0));

		assert.equal(saved.length, 1);
		assert.equal(saved[0].backend, backend);
		assert.equal(saved[0].model, customModel);
		assert.equal(saved[0].effort, "default");
		assert.doesNotMatch(modal.render(120).join("\n"), /unsupported backend/);
	});
}

test("Pi settings round-trip a physical <provider>/<id> model and reject virtual or shapeless ones", () => {
	assert.equal(resolvePiModel("  openai-codex/gpt-5.6-sol  "), "openai-codex/gpt-5.6-sol");
	assert.equal(resolvePiModel("9-router/glm-5.3"), "9-router/glm-5.3");
	// Split on the FIRST slash only: model ids may contain their own slashes.
	assert.equal(resolvePiModel("openrouter/anthropic/claude-sonnet-4-5"), "openrouter/anthropic/claude-sonnet-4-5");
	for (const bad of ["", "   ", "no-slash", "/missing-provider", "missing-model/"]) {
		assert.throws(() => resolvePiModel(bad), /<provider>\/<id>/, `must reject ${JSON.stringify(bad)}`);
	}

	const parsed = parseBroSettings({
		version: 2,
		default: { backend: "pi", model: "openai-codex/gpt-5.6-sol", effort: "high" },
		overrides: { review: { backend: "pi", model: "9-router/glm-5.3", effort: "max" } },
	});
	assert.equal(parsed.backend, "pi");
	assert.deepEqual(selectionForCapability(parsed, "review"), { backend: "pi", model: "9-router/glm-5.3", effort: "max" });
	assert.equal(selectionLabel(parsed), "openai-codex/gpt-5.6-sol · high");

	// Virtual models cannot be produced by the picker helper; physical ones are deduped by value.
	const choices = toPiModelChoices([
		{ model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-responses", name: "GPT-5.6 Sol" } },
		{ model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-responses", name: "duplicate" } },
		{ model: { provider: "pi", id: "virtual-model", api: "pi-virtual", name: "Virtual" } },
	]);
	assert.deepEqual(choices.map((c: any) => c.value), ["openai-codex/gpt-5.6-sol"]);
	assert.equal(piModelValue("openai-codex", "gpt-5.6-sol"), "openai-codex/gpt-5.6-sol");
});

test("BTW backend changes clear native continuation for every backend, same backend preserves them", () => {
	for (const backend of ["agy", "claude", "grok", "codex", "muse", "pi"] as const) {
		const thread = { turns: [{ question: "q", answer: "a" }], conversationId: `${backend}-session`, full: false, backend };
		assert.equal(bro.bindBtwBackend(thread, backend), false);
		assert.equal(thread.conversationId, `${backend}-session`);
		assert.equal(bro.bindBtwBackend(thread, backend === "agy" ? "claude" : "agy"), true);
		assert.equal(thread.conversationId, undefined);
		assert.deepEqual(thread.turns, []);
	}
});

test("BTW /mode keeps the transcript; only Agy and Pi drop their native session on an access change", () => {
 const turns=[{question:"q",answer:"a"}];
 for (const backend of ["claude","grok","codex","muse"]) {
  const thread={turns:[...turns],conversationId:"sess",full:false,backend,sessionFull:false};
  bro.toggleBtwMode(thread); assert.equal(thread.full,true); assert.deepEqual(thread.turns,turns);
  assert.equal(bro.nativeBtwContinuation(thread,backend),"sess",backend);
 }
 for (const backend of ["agy","pi"] as const) {
  const thread={turns:[...turns],conversationId:"conv",full:false,backend,sessionFull:false};
  assert.equal(bro.nativeBtwContinuation(thread,backend),"conv");
  bro.toggleBtwMode(thread); assert.equal(thread.full,true);
  assert.equal(bro.nativeBtwContinuation(thread,backend),undefined); assert.equal(thread.conversationId,undefined); assert.deepEqual(thread.turns,turns);
 }
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

test("help is a concise reference: no removed BTW flags, /mode documented, user guide pointer", () => {
	for (const backend of ["agy", "claude", "grok"] as const) {
		const text = helpText(parseBroSettings({ version: 2, default: { backend, model: "m", effort: "default" } }));
		assert.doesNotMatch(text, /--(full|sandbox|fresh)\b/);
		assert.doesNotMatch(text, /--dangerously|--permission-mode|--resume|--conversation/);
		assert.match(text, /`\/mode`/);
		assert.match(text, /docs\/user-guide\.md/);
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
 // Only newline-terminated lines: polling can catch the fake mid-append, even with an empty file.
 const calls = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(0, -1).map((line) => JSON.parse(line) as string[]) : [];
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

// A broken optional shortcut must never take the working commands with it: /bro is the only way to
// reach every other feature, and shortcuts are optional per Pi version.
test("/bro still registers when the optional Elevate shortcut cannot", async () => {
	let command: any;
	const pi = {
		on() {},
		registerTool() {},
		registerShortcut() { throw new Error("shortcut registration failed"); },
		registerCommand(_name: string, def: any) { command = def; },
	};
	await bro.default(pi as any);
	assert.ok(command, "/bro was not registered");
	let error: unknown;
	try { await command.handler("help", { mode: "tui", hasUI: true, cwd: process.cwd(), sessionManager: { getBranch: () => [] }, ui: { notify() {}, custom: async () => undefined } }); }
	catch (thrown) { error = thrown; }
	assert.equal(error, undefined, "/bro help failed after a shortcut registration error");
});

// Registering a key must not be required for Elevate itself; the command is the supported path.
test("a host without registerShortcut still loads Bro", async () => {
	let command: any;
	await bro.default({ on() {}, registerTool() {}, registerCommand(_name: string, def: any) { command = def; } } as any);
	assert.ok(command, "/bro was not registered on a host without registerShortcut");
});

test("Pi custom model rejects a malformed ID in place instead of throwing out of the modal", async () => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme();
	const saved: any[] = [];
	const modal = bro.createConfigModal(
		parseBroSettings({ version: 2, default: { backend: "pi", model: "acme/ok", effort: "default" } }),
		[],
		async (s: unknown) => { saved.push(s); },
	)({ requestRender() {} }, { fg: (_: string, s: string) => s, bold: (s: string) => s }, {}, () => {});

	// Pi → custom model → a bare id with no "<provider>/" must not escape as an exception.
	modal.handleInput("\r"); // open the Default model picker (step 1: backends, Pi pre-selected)
	modal.handleInput("\r"); // step 2 for Pi
	modal.handleInput("\u001b[B"); // the single "custom model ID…" row (Pi has no seed models)
	modal.handleInput("\r");
	modal.handleInput("noslash");
	modal.handleInput("\r"); // submit: invalid, so it must stay put and report, not throw

	assert.equal(saved.length, 0, "a malformed model must not be saved");
	const text = modal.render(120).join("\n");
	assert.match(text, /<provider>\/<id>/, "the field must still be open and explain the required shape");

	// Correcting the value saves normally.
	modal.handleInput("\u0015"); // clear the input line
	modal.handleInput("acme/fixed");
	modal.handleInput("\r");
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(saved.length, 1);
	assert.equal(saved[0].model, "acme/fixed");
});
