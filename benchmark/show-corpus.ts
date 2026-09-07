// Show track: fixtures and mechanical checks for the experimental /bro show
// direction (see docs/plans/2026-09-07-bro-show-visual-design.md). Separate
// from the modes corpus on purpose: expectations here reward *selection*
// (smallest view), not preservation, so they cannot share a schema with the
// brief/balanced/faithful benchmark.
import { FENCED_BLOCK_PATTERN } from "./corpus.ts";

export type ShowExpectations = {
	requiredTokens: readonly string[];
	forbiddenText: readonly string[];
};

export type ShowFixture = {
	id: string;
	description: string;
	target: string;
	expectations: ShowExpectations;
};

export type ShowChecks = {
	missingTokens: string[];
	forbiddenText: string[];
	likelyPreamble: boolean;
	untraceableTokens: string[];
	fenceViolations: string[];
	diffViolations: string[];
};

function serializeTranscript(entries: readonly (readonly [string, string])[]): string {
	return entries.map(([header, payload]) => `${header}\n${JSON.stringify(payload)}`).join("\n\n");
}

const DEBUG_SESSION_RESTORE_TRANSCRIPT = serializeTranscript([
	["## user", "The session restore is throwing an error on startup. Can you find and fix it?"],
	["## assistant", "I'll open the session manager and its config loader to find the crash."],
	["## tool call: read", "src/sessions/manager.ts"],
	["## tool result: read", "export function restoreSession(configPath: string): Session {\n\tconst config = loadConfig(configPath);\n\treturn new Session(config.sessionId, config.timeoutMs);\n}"],
	["## assistant", "The crash likely comes from loadConfig. Let me check src/config/settings.ts."],
	["## tool call: read", "src/config/settings.ts"],
	["## tool result: read", "export function loadConfig(path: string): Config {\n\tconst raw = JSON.parse(readFileSync(path, \"utf8\"));\n\treturn { sessionId: raw.sessionId, timeoutMs: raw.timeout_ms };\n}"],
	["## assistant", "loadConfig reads raw.timeout_ms but Session expects config.timeoutMs, so timeoutMs comes back undefined. I'll rename the key."],
	["## tool call: edit", "src/config/settings.ts: replace `timeoutMs: raw.timeout_ms` with `timeoutMs: raw.timeoutMs`"],
	["## tool result: edit", "Applied edit to src/config/settings.ts"],
	["## tool call: bash", "npm test -- src/sessions/manager.test.ts"],
	["## tool result: bash", "FAIL src/sessions/manager.test.ts\nrestoreSession > TypeError: config.timeoutMs.toFixed is not a function\n    at Session (src/sessions/manager.ts:14)"],
	["## assistant", "timeoutMs is read from JSON as a string. I'll coerce it with Number() before loadConfig returns it."],
	["## tool call: edit", "src/config/settings.ts: replace `timeoutMs: raw.timeoutMs` with `timeoutMs: Number(raw.timeoutMs)`"],
	["## tool result: edit", "Applied edit to src/config/settings.ts"],
	["## tool call: bash", "npm test -- src/sessions/manager.test.ts"],
	["## tool result: bash", "PASS src/sessions/manager.test.ts (3 tests)"],
	["## assistant", "Fixed: src/config/settings.ts now coerces timeoutMs to a number with Number(raw.timeoutMs) before src/sessions/manager.ts reads config.timeoutMs. All three tests pass."],
]);

const REFACTOR_UTILS_TRANSCRIPT = serializeTranscript([
	["## user", "Please refactor src/utils/formatters.ts — split the date formatting helpers into their own file."],
	["## assistant", "I'll list src/utils first to see what's already there."],
	["## tool call: bash", "ls src/utils"],
	["## tool result: bash", "formatters.ts\nstrings.ts\narrays.ts\nindex.ts"],
	["## assistant", "Let me read formatters.ts and strings.ts before moving anything."],
	["## tool call: read", "src/utils/formatters.ts"],
	["## tool result: read", "export function formatCurrency(cents: number): string {\n\treturn `$${(cents / 100).toFixed(2)}`;\n}\n\nexport function formatDate(date: Date): string {\n\treturn date.toISOString().slice(0, 10);\n}\n\nexport function formatRelativeTime(date: Date, now: Date): string {\n\tconst diffMs = now.getTime() - date.getTime();\n\treturn `${Math.round(diffMs / 60000)}m ago`;\n}"],
	["## tool call: read", "src/utils/strings.ts"],
	["## tool result: read", "export function slugify(value: string): string {\n\treturn value.trim().toLowerCase().replace(/\\s+/g, \"-\");\n}\n\nexport function truncate(value: string, max: number): string {\n\treturn value.length > max ? `${value.slice(0, max)}…` : value;\n}"],
	["## assistant", "formatDate and formatRelativeTime belong together; I'll move them into a new src/utils/dates.ts and leave formatCurrency in formatters.ts."],
	["## tool call: write", "src/utils/dates.ts"],
	["## tool result: write", "Wrote src/utils/dates.ts with formatDate and formatRelativeTime moved from src/utils/formatters.ts."],
	["## tool call: edit", "src/utils/formatters.ts: remove formatDate and formatRelativeTime, keep formatCurrency"],
	["## tool result: edit", "Applied edit to src/utils/formatters.ts"],
	["## tool call: read", "src/utils/index.ts"],
	["## tool result: read", "export * from \"./formatters\";\nexport * from \"./strings\";\nexport * from \"./arrays\";"],
	["## assistant", "src/utils/index.ts re-exports each file, so I'll add dates.ts there too."],
	["## tool call: edit", "src/utils/index.ts: add `export * from \"./dates\";`"],
	["## tool result: edit", "Applied edit to src/utils/index.ts"],
	["## assistant", "Moved formatDate and formatRelativeTime out of src/utils/formatters.ts into a new src/utils/dates.ts, and added the export to src/utils/index.ts. formatCurrency stays in src/utils/formatters.ts; no callers needed changes."],
]);

// Required tokens are the identifiers any smallest-view telling of the story
// must include. Files that were merely inspected (src/sessions/manager.ts,
// src/utils/strings.ts) are deliberately NOT required: show-me's smallest-view
// rule says the shape keeps only what the point needs.
export const SHOW_CORPUS: readonly ShowFixture[] = [
	{
		id: "show-debug-session-restore",
		description: "Debugging exchange: a startup crash traced from the session manager to a config parsing bug",
		target: DEBUG_SESSION_RESTORE_TRANSCRIPT,
		expectations: {
			requiredTokens: ["src/config/settings.ts", "restoreSession", "loadConfig", "timeoutMs"],
			forbiddenText: ["Sure", "Here is", "I'll explain"],
		},
	},
	{
		id: "show-refactor-utils-split",
		description: "Small refactor: splitting date helpers out of a shared utils module",
		target: REFACTOR_UTILS_TRANSCRIPT,
		expectations: {
			requiredTokens: ["src/utils/formatters.ts", "src/utils/dates.ts", "formatDate", "formatRelativeTime", "formatCurrency"],
			forbiddenText: ["Sure", "Here is", "I'll explain"],
		},
	},
] as const;

const SHOW_PREAMBLE_PATTERN = /^(?:here(?:'s| is)|sure|certainly|of course|i'll|i will|let me|below is|summary)\b/i;
const DIFF_HEADER_PATTERN = /^[-+]{3} .*$/gm;
// ponytail: bare lowercase words (and hyphenated flags like --dry-run) are not
// extracted, so file-tree comment prose never false-positives; extend with a
// hyphen/flag alternative if flag hallucinations show up in live runs.
const IDENTIFIER_TOKEN_PATTERN =
	/\b(?:[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+[A-Za-z0-9]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*|[A-Za-z0-9_-]+(?:[.\/][A-Za-z0-9_-]+)+)\b/g;
const BACKTICKED_TOKEN_PATTERN = /`([^`\n]+)`/g;
const EXTERNAL_RESOURCE_PATTERN = /(?:src|href)\s*=\s*["']https?:|@import|url\(\s*["']?https?:/i;
const UNTAGGED_MERMAID_PATTERN = /^(?:sequenceDiagram|graph (?:TD|LR)|flowchart|stateDiagram|erDiagram)/m;

export function checkShowOutput(fixture: ShowFixture, output: string): ShowChecks {
	const lowercase = output.toLowerCase();
	return {
		missingTokens: fixture.expectations.requiredTokens.filter((token) => !output.includes(token)),
		forbiddenText: fixture.expectations.forbiddenText.filter((text) => lowercase.includes(text.toLowerCase())),
		likelyPreamble: SHOW_PREAMBLE_PATTERN.test(output.trimStart()),
		untraceableTokens: extractShowTokens(output).filter((token) => !fixture.target.includes(token)),
		fenceViolations: findShowFenceViolations(output),
		diffViolations: findShowDiffViolations(output),
	};
}

function extractShowTokens(output: string): string[] {
	// Diff headers (--- a/x, +++ b/x) are syntax, not identifiers; strip first.
	const cleaned = output.replace(DIFF_HEADER_PATTERN, "");
	const tokens = new Set<string>();
	for (const block of cleaned.matchAll(FENCED_BLOCK_PATTERN)) {
		for (const match of block[0].matchAll(IDENTIFIER_TOKEN_PATTERN)) tokens.add(match[0]);
	}
	const withoutFences = cleaned.replace(FENCED_BLOCK_PATTERN, "");
	for (const match of withoutFences.matchAll(BACKTICKED_TOKEN_PATTERN)) {
		for (const token of match[1].matchAll(IDENTIFIER_TOKEN_PATTERN)) tokens.add(token[0]);
	}
	return [...tokens];
}

function findShowFenceViolations(output: string): string[] {
	const violations: string[] = [];
	if ((output.match(/^```/gm) ?? []).length % 2 !== 0) violations.push("unbalanced fences");
	const blocks = [...output.matchAll(FENCED_BLOCK_PATTERN)].map((match) => ({ language: match[1].toLowerCase(), text: match[0] }));
	const htmlBlocks = blocks.filter((block) => block.language === "html");
	if (htmlBlocks.length > 1) violations.push("more than one html fence");
	if (htmlBlocks.length === 1) {
		if (blocks[blocks.length - 1]!.language !== "html") violations.push("html fence is not the last fenced block");
		if (output.slice(output.lastIndexOf("```") + 3).trim()) violations.push("trailing content after the html fence");
		if (EXTERNAL_RESOURCE_PATTERN.test(htmlBlocks[0]!.text)) violations.push("html fence references external resources");
	}
	for (const block of blocks) {
		if (block.language === "mermaid") violations.push("bare mermaid fence");
		if (!block.language && UNTAGGED_MERMAID_PATTERN.test(block.text)) violations.push("untagged mermaid-like fence");
	}
	return [...new Set(violations)];
}

// ponytail: a diff fence must carry both + and - marker lines; an all-addition
// "diff" (brand-new file) would false-positive — the prompt steers that case to
// a whole block instead.
function findShowDiffViolations(output: string): string[] {
	return [...output.matchAll(FENCED_BLOCK_PATTERN)]
		.filter((match) => match[1].toLowerCase() === "diff")
		.filter((match) => !/^\+[^+]/m.test(match[0]) || !/^-(?!-)/m.test(match[0]))
		.map(() => "diff fence missing + or - marker lines");
}
