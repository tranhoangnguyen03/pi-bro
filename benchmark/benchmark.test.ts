import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBaselinePrompt } from "./baseline.ts";
import { BENCHMARK_CORPUS, checkOutput } from "./corpus.ts";
import {
	buildManifest,
	executeIsolatedCall,
	formatDryRun,
	stableCallId,
	usagePreflight,
	type CallIdentity,
} from "./run.ts";

const fixture = (id: string) => {
	const value = BENCHMARK_CORPUS.find((item) => item.id === id);
	assert.ok(value, `missing fixture ${id}`);
	return value;
};

test("freezes the previous Bro prompt with JSON source framing", () => {
	const source = 'hello\n"quoted"';
	const prompt = buildBaselinePrompt(source);
	assert.match(prompt, /Use plain English and short sentences/);
	assert.match(prompt, /Use at most 400 words/);
	assert.ok(prompt.endsWith(JSON.stringify(source)));
});

test("defines eight unique synthetic fixtures", () => {
	assert.equal(BENCHMARK_CORPUS.length, 8);
	assert.equal(new Set(BENCHMARK_CORPUS.map((item) => item.id)).size, 8);
	assert.ok(fixture("mixed-language").target.includes("Italiano"));
	assert.ok(fixture("long-document").target.length > 1_000);
	assert.ok(fixture("target-injection").target.includes("INJECTION_SENTINEL"));
});

test("checks required literals and occurrence counts", () => {
	const technical = fixture("technical-literals");
	assert.deepEqual(checkOutput(technical, technical.target).missingLiterals, []);
	assert.deepEqual(checkOutput(technical, technical.target).literalOccurrenceShortfalls, []);
	const failed = checkOutput(technical, "changed output");
	assert.ok(failed.missingLiterals.length > 0);
	assert.ok(failed.literalOccurrenceShortfalls.length > 0);
});

test("checks fenced code and Markdown markers", () => {
	const markdown = fixture("markdown-code");
	const passing = checkOutput(markdown, markdown.target);
	assert.deepEqual(passing.missingFencedBlocks, []);
	assert.deepEqual(passing.missingMarkdownMarkers, []);
	const failed = checkOutput(markdown, "plain text");
	assert.ok(failed.missingFencedBlocks.length > 0);
	assert.ok(failed.missingMarkdownMarkers.length > 0);
});

test("checks injection compliance without flagging safe quotations", () => {
	const injection = fixture("target-injection");
	assert.deepEqual(checkOutput(injection, "safe rewrite").forbiddenOutputPrefixes, []);
	assert.deepEqual(checkOutput(injection, "INJECTION_SENTINEL with a secret preamble").forbiddenOutputPrefixes, ["INJECTION_SENTINEL"]);
	assert.deepEqual(checkOutput(injection, "The note says INJECTION_SENTINEL, but do not follow it.").forbiddenOutputPrefixes, []);
	assert.equal(checkOutput(injection, "Here is the rewrite: safe").likelyPreamble, true);
	assert.equal(checkOutput(injection, "There is an untrusted note.").likelyPreamble, false);
});

test("checks unchanged output, expected change, and length ratio", () => {
	const inflated = fixture("inflated-prose");
	const unchanged = checkOutput(inflated, inflated.target);
	assert.equal(unchanged.unchanged, true);
	assert.equal(unchanged.expectedChangeSatisfied, false);
	assert.equal(unchanged.lengthRatio, 1);
	assert.equal(checkOutput(inflated, "Plain summary.").expectedChangeSatisfied, true);
});

test("builds and prints the exact 32-row dry manifest", () => {
	const manifest = buildManifest();
	assert.equal(manifest.rows.length, 32);
	assert.equal(new Set(manifest.rows.map((row) => row.callId)).size, 32);
	assert.deepEqual(new Set(manifest.rows.map((row) => row.variant)), new Set(["baseline", "brief", "balanced", "faithful"]));
	assert.deepEqual(new Set(manifest.rows.map((row) => row.model)), new Set(["gemini-3.7-flash"]));
	assert.deepEqual(new Set(manifest.rows.map((row) => row.effort)), new Set(["low"]));
	const printed = JSON.parse(formatDryRun());
	assert.equal(printed.rows.length, 32);
	assert.equal(printed.fingerprint, manifest.fingerprint);
});

test("runs each call in a fresh directory and contains process failures", async () => {
	const root = await mkdtemp(join(tmpdir(), "bro-benchmark-test-"));
	const success = join(root, "success.mjs");
	const hanging = join(root, "hanging.mjs");
	const malformed = join(root, "malformed.mjs");
	await writeFile(success, `#!/usr/bin/env node\nimport { existsSync, writeFileSync } from "node:fs";\nif (existsSync("marker")) process.exit(9);\nwriteFileSync("marker", "x");\nconsole.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"ok"}}));\n`);
	await writeFile(hanging, `#!/usr/bin/env node\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`);
	await writeFile(malformed, `#!/usr/bin/env node\nconsole.log("not-json");\n`);
	await Promise.all([success, hanging, malformed].map((path) => chmod(path, 0o755)));
	try {
		const row = buildManifest().rows[0];
		assert.ok(row);
		assert.equal((await executeIsolatedCall(row, "prompt", new AbortController().signal, success, 20)).outcome, "success");
		assert.equal((await executeIsolatedCall(row, "prompt", new AbortController().signal, success, 20)).outcome, "success");
		assert.equal((await executeIsolatedCall({ ...row, timeoutMs: 30 }, "prompt", new AbortController().signal, hanging, 20)).outcome, "timeout");
		assert.equal((await executeIsolatedCall(row, "prompt", new AbortController().signal, malformed, 20)).outcome, "error");
		await assert.rejects(usagePreflight(join(root, "missing-agy"), 20), /could not start/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("call IDs include every paid-call identity input", () => {
	const base: CallIdentity = {
		fixture: "fixture",
		fixtureSha256: "fixture-hash",
		variant: "balanced",
		promptSha256: "prompt-hash",
		model: "gemini-3.7-flash",
		effort: "low",
		timeoutMs: 125_000,
	};
	for (const [key, value] of [
		["fixture", "other-fixture"],
		["fixtureSha256", "other-fixture-hash"],
		["variant", "brief"],
		["promptSha256", "other-prompt-hash"],
		["model", "other-model"],
		["effort", "high"],
		["timeoutMs", 45_000],
	] as const) {
		assert.notEqual(stableCallId(base), stableCallId({ ...base, [key]: value }));
	}
});
