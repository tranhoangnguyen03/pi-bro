import assert from "node:assert/strict";
import test from "node:test";
import { buildManifest, formatDryRun } from "./run.ts";
import { SHOW_CORPUS, checkShowOutput, type ShowFixture } from "./show-corpus.ts";

const fixture = (id: string): ShowFixture => {
	const value = SHOW_CORPUS.find((item) => item.id === id);
	assert.ok(value, `missing show fixture ${id}`);
	return value;
};

const debugging = () => fixture("show-debug-session-restore");

test("defines serialized transcript fixtures with quoted payloads", () => {
	assert.equal(SHOW_CORPUS.length, 10);
	assert.equal(new Set(SHOW_CORPUS.map((item) => item.id)).size, 10);
	for (const item of SHOW_CORPUS) {
		assert.match(item.target, /^## user\n"/);
		assert.ok(JSON.parse(item.target.split("\n")[1]!).length > 0);
	}
	assert.ok(debugging().target.includes("src/config/settings.ts"));
	assert.ok(fixture("show-refactor-utils-split").target.includes("src/utils/dates.ts"));
});

test("required tokens exclude files that were merely inspected", () => {
	const debug = debugging().expectations.requiredTokens;
	assert.ok(!debug.includes("src/sessions/manager.ts"));
	assert.ok(!fixture("show-refactor-utils-split").expectations.requiredTokens.includes("src/utils/strings.ts"));
});

test("the show manifest is a separate ten-row track", () => {
	const manifest = buildManifest("show");
	assert.equal(manifest.rows.length, 10);
	assert.deepEqual(new Set(manifest.rows.map((row) => row.variant)), new Set(["show-v1"]));
	assert.equal(new Set(manifest.rows.map((row) => row.callId)).size, 10);
	const modes = buildManifest("modes");
	assert.equal(modes.rows.length, 32);
	assert.notEqual(manifest.fingerprint, modes.fingerprint);
	assert.equal(JSON.parse(formatDryRun("show")).fingerprint, manifest.fingerprint);
});

test("traceable tokens pass and invented identifiers fail", () => {
	const good = checkShowOutput(
		debugging(),
		"Call tree for `restoreSession`:\n\n```text\nrestoreSession(configPath)\n└── loadConfig(path)\n```\n",
	);
	assert.deepEqual(good.untraceableTokens, []);

	const camel = checkShowOutput(debugging(), "```text\ncalls mockSessionStore()\n```");
	assert.ok(camel.untraceableTokens.includes("mockSessionStore"));
	const snake = checkShowOutput(debugging(), "```text\nreads retry_count\n```");
	assert.ok(snake.untraceableTokens.includes("retry_count"));
	const caps = checkShowOutput(debugging(), "```text\nwrites SESSION_STORE\n```");
	assert.ok(caps.untraceableTokens.includes("SESSION_STORE"));
	const path = checkShowOutput(debugging(), "`src/config/nonexistent.ts` was edited");
	assert.ok(path.untraceableTokens.includes("src/config/nonexistent.ts"));
});

test("diff headers and comment prose do not false-positive", () => {
	const diffHeaders = checkShowOutput(
		debugging(),
		"```diff\n--- a/src/config/settings.ts\n+++ b/src/config/settings.ts\n-  return { timeoutMs: raw.timeout_ms };\n+  return { timeoutMs: Number(raw.timeoutMs) };\n```",
	);
	assert.deepEqual(diffHeaders.untraceableTokens, []);

	const comments = checkShowOutput(
		debugging(),
		"```text\nsrc/\n├── config/       # parses user settings\n└── sessions/     # owns session state\n```\n",
	);
	assert.deepEqual(comments.untraceableTokens, []);
});

test("flags fence violations", () => {
	const ok = checkShowOutput(debugging(), "```text\nshape\n```\n\n```html\n<div></div>\n```");
	assert.deepEqual(ok.fenceViolations, []);

	assert.ok(checkShowOutput(debugging(), "```text\nunclosed").fenceViolations.includes("unbalanced fences"));
	assert.ok(
		checkShowOutput(debugging(), "```html\n<div></div>\n```\n\n```text\nafter\n```").fenceViolations.includes("html fence is not the last fenced block"),
	);
	assert.ok(
		checkShowOutput(debugging(), "```html\n<div></div>\n```\n\nHope this helps!").fenceViolations.includes("trailing content after the html fence"),
	);
	assert.ok(
		checkShowOutput(debugging(), "```mermaid\ngraph TD;\n```").fenceViolations.includes("bare mermaid fence"),
	);
	assert.ok(
		checkShowOutput(debugging(), "```\nsequenceDiagram\n    participant User\n```").fenceViolations.includes("untagged mermaid-like fence"),
	);
	assert.ok(
		checkShowOutput(debugging(), '```html\n<script src="https://cdn.example.com/x.js"></script>\n```').fenceViolations.includes(
			"html fence references external resources",
		),
	);
});

test("flags malformed diff fences", () => {
	const good = checkShowOutput(
		debugging(),
		"```diff\n- timeoutMs: raw.timeout_ms\n+ timeoutMs: Number(raw.timeoutMs)\n```",
	);
	assert.deepEqual(good.diffViolations, []);

	// Additions-only layouts are legitimate show-me file-layout diffs.
	const additionsOnly = checkShowOutput(debugging(), "```diff\n src/utils/\n+├── dates.ts\n├── formatters.ts\n```");
	assert.deepEqual(additionsOnly.diffViolations, []);

	const bad = checkShowOutput(debugging(), "```diff\ncontext only, no markers\n```");
	assert.deepEqual(bad.diffViolations, ["diff fence missing + or - marker lines"]);
});

test("flags preambles, forbidden text, and missing required tokens", () => {
	const preambled = checkShowOutput(debugging(), "Sure, here is what happened:\n\n```text\nrestoreSession()\n```");
	assert.equal(preambled.likelyPreamble, true);
	assert.ok(preambled.forbiddenText.length >= 2);

	const framed = checkShowOutput(debugging(), "Call tree for `restoreSession`:\n\n```text\nrestoreSession()\n```");
	assert.equal(framed.likelyPreamble, false);

	const sparse = checkShowOutput(debugging(), "```text\nloadConfig()\n```");
	assert.deepEqual(sparse.missingTokens, ["src/config/settings.ts", "restoreSession", "timeoutMs"]);
});
