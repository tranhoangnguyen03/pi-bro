import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bro, doctor } from "./test-build.mjs";

test("doctor probes each backend selected only by the review capability", async () => {
	const directory = process.env.PI_CODING_AGENT_DIR;
	await mkdir(directory, { recursive: true });
	for (const backend of ["agy", "claude", "grok", "codex", "muse"]) {
		const other = backend === "agy" ? "claude" : "agy";
		await writeFile(
			join(directory, "bro-settings.json"),
			JSON.stringify({
				version: 2,
				default: { backend: other, model: "test", effort: "default" },
				overrides: { review: { backend, model: "test", effort: "default" } },
			}),
		);
		const calls = [];
		const pi = {
			getAllTools: () => [],
			getActiveTools: () => [],
			exec: async (command, args) => {
				calls.push({ command, args });
				throw Error("offline probe fixture");
			},
		};
		const ctx = { sessionManager: { getBranch: () => [] } };
		const report = await bro.doctorReport(pi, ctx, new AbortController().signal);
		assert.ok(
			calls.some((call) => call.command === backend),
			`${backend} review override must be probed`,
		);
		assert.doesNotMatch(report, /needs a Claude or Muse override/);
		if (["claude", "muse"].includes(backend)) {
			// File-only backends get no advisory at all: not the shell-sandbox wording, not a review line.
			assert.doesNotMatch(report, /sandboxed shell|Guided Review on (claude|muse)/);
		} else {
			// The advisory names the backend actually selected, so a wrong-backend regression fails here.
			assert.match(report, new RegExp(`Guided Review on ${backend} uses sandboxed shell`));
		}
	}
});

test("sandboxed review backend is informational and does not make a healthy installation fail", async () => {
	const directory = process.env.PI_CODING_AGENT_DIR;
	await mkdir(directory, { recursive: true });
	for (const backend of ["agy", "grok", "codex"]) {
		await writeFile(
			join(directory, "bro-settings.json"),
			JSON.stringify({ version: 2, default: { backend, model: "test", effort: "default" } }),
		);
		const pi = {
			getAllTools: () => [],
			getActiveTools: () => [],
			exec: async (_command, args) => ({
				code: 0,
				killed: false,
				stderr: "",
				stdout:
					args[0] === "models"
						? "test\tTest"
						: args.includes("/usage")
							? JSON.stringify({ status: "SUCCESS", response: "Fixture\tRequests\t100" })
							: args[0] === "login"
								? "Logged in"
								: "1.3.3",
			}),
		};
		const report = await bro.doctorReport(
			pi,
			{ sessionManager: { getBranch: () => [] } },
			new AbortController().signal,
		);
		assert.match(report, /Bro is ready\./, backend);
		assert.doesNotMatch(report, /Bro needs attention|✗/);
		assert.match(
			report,
			new RegExp(`- ℹ \\*\\*Guided review:\\*\\* Guided Review on ${backend} uses sandboxed shell`),
		);
		assert.doesNotMatch(report, /needs a Claude or Muse override/);
	}
});

// Pi is in-process, so its doctor probes never spawn a CLI and never run a model turn. These fakes
// mirror the host registry surface the probes touch: provider registration, model lookup, auth.
const piRegistry = (models) => {
	const byKey = new Map(models.map((m) => [`${m.provider}/${m.id}`, m]));
	return {
		getRegisteredProviderIds: () => [],
		getRegisteredNativeProvider: () => undefined,
		getRegisteredProviderConfig: () => undefined,
		getAll: () => [...byKey.values()],
		getProviderAuthStatus: () => ({ source: "stored" }),
		getApiKeyForProvider: async () => undefined,
		find: (provider, id) => byKey.get(`${provider}/${id}`),
		hasConfiguredAuth: (model) => byKey.get(`${model.provider}/${model.id}`)?.auth !== false && byKey.has(`${model.provider}/${model.id}`),
	};
};

async function piDoctor(models, settingsJson, scopedModels = []) {
	const directory = process.env.PI_CODING_AGENT_DIR;
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "bro-settings.json"), JSON.stringify(settingsJson));
	const calls = [];
	const pi = {
		getAllTools: () => [],
		getActiveTools: () => [],
		exec: async (command) => {
			calls.push(command);
			throw Error("Pi must never spawn a CLI");
		},
	};
	const report = await bro.doctorReport(
		pi,
		{ cwd: directory, modelRegistry: piRegistry(models), scopedModels, sessionManager: { getBranch: () => [] } },
		new AbortController().signal,
	);
	return { report, calls };
}

test("Pi doctor validates the selected physical model without spawning a CLI", async () => {
	const { report, calls } = await piDoctor(
		[
			{ provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-responses", reasoning: true },
			{ provider: "pi", id: "router", api: "pi-virtual" },
		],
		{ version: 2, default: { backend: "pi", model: "openai-codex/gpt-5.6-sol", effort: "high" } },
		[{ model: { provider: "openai-codex", id: "gpt-5.6-sol" } }],
	);
	assert.deepEqual(calls, []);
	assert.match(report, /- ✓ \*\*Selected model:\*\* pi `openai-codex\/gpt-5\.6-sol`/);
	assert.match(report, /- ✓ \*\*Reasoning effort:\*\* high/);
	assert.match(report, /- ✓ \*\*Pi model catalog:\*\*/);
	assert.match(report, /- ✓ \*\*Explain:\*\* .*in your scoped models · tools: no tools/);
	assert.match(report, /- ✓ \*\*Btw:\*\* .*tools: none in conversation-only; read\/bash\/edit\/write in the workspace in full permission/);
	// File-only review: Pi gets no sandboxed-shell advisory.
	assert.doesNotMatch(report, /sandboxed shell|Guided Review on pi/);
});

test("Pi doctor fails a virtual model, a shapeless model, and missing auth", async () => {
	for (const [model, want] of [
		["pi/router", /unavailable or virtual/],
		["no-slash", /is not a `<provider>\/<id>`/],
		["openai-codex/gpt-5.6-sol", /has no configured auth/],
	]) {
		const { report } = await piDoctor(
			[
				{ provider: "pi", id: "router", api: "pi-virtual" },
				{ provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-responses", auth: false },
			],
			{ version: 2, default: { backend: "pi", model, effort: "default" } },
		);
		assert.match(report, /Bro needs attention/, model);
		assert.match(report, want, model);
	}
});

test("Pi doctor reports review tools as file-only and the advisor toolset as workspace tools", async () => {
	const { report } = await piDoctor(
		[{ provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages", reasoning: true }],
		{
			version: 2,
			default: { backend: "pi", model: "anthropic/claude-sonnet-4-5", effort: "default" },
			overrides: {
				review: { backend: "pi", model: "anthropic/claude-sonnet-4-5", effort: "default" },
				advisor: { backend: "pi", model: "anthropic/claude-sonnet-4-5", effort: "default" },
			},
		},
	);
	assert.match(report, /- ✓ \*\*Guided review:\*\* override pi .*tools: read\/grep\/find\/ls in the captured checkout, no shell/);
	assert.match(report, /- ✓ \*\*Advisor:\*\* override pi .*tools: read\/bash\/edit\/write in the workspace/);
	assert.match(report, /- ✓ \*\*Advisor compatibility:\*\* Pi backend/);
	assert.doesNotMatch(report, /sandboxed shell/);
});

test("Pi doctor reports the effective effort instead of a blanket clamp claim", async () => {
	// A model that supports every level: the requested effort is reported unchanged.
	const supported = await piDoctor(
		[{ provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages", reasoning: true }],
		{ version: 2, default: { backend: "pi", model: "anthropic/claude-sonnet-4-5", effort: "high" } },
	);
	assert.match(supported.report, /- ✓ \*\*Reasoning effort:\*\* high$/m);
	assert.doesNotMatch(supported.report, /Reasoning effort:\*\* high →/);

	// A model that cannot reason runs at "off", which must be visible rather than hidden.
	const noReasoning = await piDoctor(
		[{ provider: "anthropic", id: "plain", api: "anthropic-messages", reasoning: false }],
		{ version: 2, default: { backend: "pi", model: "anthropic/plain", effort: "high" } },
	);
	assert.match(noReasoning.report, /- ✓ \*\*Reasoning effort:\*\* high → off \(clamped\)/);

	// A model that only offers "low" must show the clamp upward-checked level.
	const lowOnly = await piDoctor(
		[{ provider: "anthropic", id: "low-only", api: "anthropic-messages", reasoning: true, thinkingLevelMap: { medium: null, high: null, xhigh: null, max: null } }],
		{ version: 2, default: { backend: "pi", model: "anthropic/low-only", effort: "high" } },
	);
	assert.match(lowOnly.report, /- ✓ \*\*Reasoning effort:\*\* high → low \(clamped\)/);
});

test("Pi catalog honors workspace trust, including a throwing trust getter", async () => {
	const directory = process.env.PI_CODING_AGENT_DIR;
	const workspace = await mkdtemp(join(directory, "pi-trust-"));
	await mkdir(join(workspace, ".pi"));
	await writeFile(join(workspace, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["repo-controlled/missing"] }));
	const globalSettings = join(directory, "settings.json");
	await writeFile(globalSettings, JSON.stringify({ enabledModels: ["global-only/missing"] }));
	try {
		for (const [isProjectTrusted, expected] of [
			[() => true, "repo-controlled/missing"],
			[() => false, "global-only/missing"],
			[() => { throw Error("stale context"); }, "global-only/missing"],
			[undefined, "repo-controlled/missing"],
		]) {
			const catalog = await doctor.listPiModels({ cwd: workspace, modelRegistry: piRegistry([]), isProjectTrusted });
			assert.equal(catalog.scope, "scoped");
			assert.deepEqual(catalog.models, []);
			assert.ok(catalog.diagnostics.some((message) => message.includes(expected)), JSON.stringify(catalog.diagnostics));
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
		await rm(globalSettings, { force: true });
	}
});

test("Pi doctor uses disk model and auth updates even when the host registry is stale", async () => {
	const directory = process.env.PI_CODING_AGENT_DIR;
	const modelsPath = join(directory, "models.json");
	const authPath = join(directory, "auth.json");
	const settings = { version: 2, default: { backend: "pi", model: "doctor-disk/fresh", effort: "default" } };
	await writeFile(modelsPath, JSON.stringify({ providers: {
		"doctor-disk": { api: "openai-completions", baseUrl: "https://example.invalid/v1", models: [{ id: "fresh" }] },
	} }));
	try {
		const missingAuth = await piDoctor([], settings);
		assert.match(missingAuth.report, /- ✗ \*\*Selected model:\*\* .*has no configured auth/);
		assert.match(missingAuth.report, /- ✗ \*\*Explain:\*\* .*has no configured auth/);

		await writeFile(authPath, JSON.stringify({ "doctor-disk": { type: "api_key", key: "offline-fixture" } }));
		const { report, calls } = await piDoctor([], settings);
		assert.deepEqual(calls, []);
		assert.match(report, /- ✓ \*\*Pi model catalog:\*\* [1-9]/);
		assert.match(report, /- ✓ \*\*Selected model:\*\* pi `doctor-disk\/fresh`/);
		assert.match(report, /- ✓ \*\*Explain:\*\* pi `doctor-disk\/fresh`/);
		assert.match(report, /- ✓ \*\*Guided review:\*\* pi `doctor-disk\/fresh`/);
		assert.doesNotMatch(report, /✗/);
	} finally {
		await rm(modelsPath, { force: true });
		await rm(authPath, { force: true });
	}
});
