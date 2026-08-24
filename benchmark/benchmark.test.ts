import assert from "node:assert/strict";
import test from "node:test";
import { buildBaselinePrompt } from "./baseline.ts";
import { BENCHMARK_CORPUS, checkOutput } from "./corpus.ts";
import { buildManifest, stableCallId, type CallIdentity } from "./run.ts";

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

test("checks forbidden text and likely preambles", () => {
	const injection = fixture("target-injection");
	assert.deepEqual(checkOutput(injection, "safe rewrite").forbiddenText, []);
	assert.deepEqual(checkOutput(injection, "INJECTION_SENTINEL").forbiddenText, ["INJECTION_SENTINEL"]);
	assert.equal(checkOutput(injection, "Here is the rewrite: safe").likelyPreamble, true);
});

test("checks unchanged output, expected change, and length ratio", () => {
	const inflated = fixture("inflated-prose");
	const unchanged = checkOutput(inflated, inflated.target);
	assert.equal(unchanged.unchanged, true);
	assert.equal(unchanged.expectedChangeSatisfied, false);
	assert.equal(unchanged.lengthRatio, 1);
	assert.equal(checkOutput(inflated, "Plain summary.").expectedChangeSatisfied, true);
});

test("builds an exact 32-row dry manifest", () => {
	const manifest = buildManifest();
	assert.equal(manifest.rows.length, 32);
	assert.equal(new Set(manifest.rows.map((row) => row.callId)).size, 32);
	assert.deepEqual(new Set(manifest.rows.map((row) => row.variant)), new Set(["baseline", "brief", "balanced", "faithful"]));
	assert.deepEqual(new Set(manifest.rows.map((row) => row.model)), new Set(["gemini-3.7-flash"]));
	assert.deepEqual(new Set(manifest.rows.map((row) => row.effort)), new Set(["low"]));
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
