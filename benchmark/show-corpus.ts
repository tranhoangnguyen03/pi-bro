// Show track: fixtures and mechanical checks for the experimental /bro show
// direction (see docs/plans/2026-09-07-bro-show-visual-design.md). Separate
// from the modes corpus on purpose: expectations here reward *selection*
// (smallest view), not preservation, so they cannot share a schema with the
// brief/balanced/faithful benchmark.
//
// Transcripts are conversation-only (## user / ## assistant text, no tool
// call or tool result sections), matching what /bro show actually captures.
// Facts that used to come from a tool result (a file's contents, a command's
// output) now appear only if the assistant reports them in conversation text.
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
	["## assistant", "Found it: src/sessions/manager.ts calls restoreSession(configPath), which calls loadConfig in src/config/settings.ts. loadConfig reads raw.timeout_ms but returns it as config.timeoutMs, so timeoutMs comes back undefined."],
	["## assistant", "First test run failed with TypeError: config.timeoutMs.toFixed is not a function, because timeoutMs was read from JSON as a string instead of a number."],
	["## assistant", "Fixed: src/config/settings.ts now coerces timeoutMs to a number with Number(raw.timeoutMs) before src/sessions/manager.ts reads config.timeoutMs. All three tests in src/sessions/manager.test.ts pass."],
]);

const REFACTOR_UTILS_TRANSCRIPT = serializeTranscript([
	["## user", "Please refactor src/utils/formatters.ts — split the date formatting helpers into their own file."],
	["## assistant", "src/utils/formatters.ts currently holds formatCurrency, formatDate, and formatRelativeTime, alongside strings.ts and arrays.ts in src/utils/."],
	["## assistant", "formatDate and formatRelativeTime belong together, so I moved them into a new src/utils/dates.ts and left formatCurrency in formatters.ts."],
	["## assistant", "src/utils/index.ts re-exports each file, so I added `export * from \"./dates\";` there too."],
	["## assistant", "Moved formatDate and formatRelativeTime out of src/utils/formatters.ts into a new src/utils/dates.ts, and added the export to src/utils/index.ts. formatCurrency stays in src/utils/formatters.ts; no callers needed changes."],
]);

const CALL_STACK_TRANSCRIPT = serializeTranscript([
	["## user", "Creating a session is taking around two seconds. Trace the full path from the handler down so I can see where the time goes."],
	["## assistant", "The chain is handleCreateSession -> validateRequest -> SessionStore.insert -> publish('session.created'), and the publish triggers AgentWorker.run -> loadContext -> callModel -> persistResult. The model call inside the worker is the slow step."],
]);

const PSEUDOCODE_TRANSCRIPT = serializeTranscript([
	["## user", "How does the editor capture and restore scroll position? Sketch the logic."],
	["## assistant", "capture picks the focused block via focusedBlock, or falls back to the first block at the viewport top, records a whole-block anchor with wholeBlockAnchor plus the signed offset, the current scrollTop, and bumps the revision counter. restore resolves the anchor with resolveAnchor and recomputes the position from there, or falls back to the raw scrollTop if the anchor can't be resolved."],
]);

const COMPONENT_TREE_TRANSCRIPT = serializeTranscript([
	["## user", "What does the session page render? Show the component structure with the state hooks and module boundaries that matter."],
	["## assistant", "SessionPage (in session.tsx) owns the useSessionEvents hook and renders SessionToolbar and SessionTimeline, both from packages/ui. SessionToolbar renders RunSkillButton, and SessionTimeline renders SkillResultCard."],
]);

const FILE_LAYOUT_TRANSCRIPT = serializeTranscript([
	["## user", "Where does everything live in src/? I need the file layout with responsibilities before I scope a refactor."],
	["## assistant", "src/ splits into four areas: commands (registry.ts, show-me.ts) for user intents, sessions (store.ts, worker.ts, events.ts) for state and lifecycle, transport (client.ts, stream.ts) for the API, and a root config.ts."],
]);

const TYPES_SIGNATURES_TRANSCRIPT = serializeTranscript([
	["## user", "Before we write any code: what are the types for an ordered list of items with a cursor that can move up or down? Sketch the interfaces and the resolve signature."],
	["## assistant", "The agreed shape, before implementation: Item is an id plus an optional parentId; Cursor is a position plus a direction of 'up' or 'down'; resolveTarget maps an item list and cursor to the target ItemId or null when there is no move."],
]);

const DIFF_TRANSCRIPT = serializeTranscript([
	["## user", "What changed in the save handler? Show the diff."],
		["## assistant", "The save handler's on(save) diff: the old flow was just write content unconditionally; the new flow checks if content is unchanged, returns the cached result, and otherwise still does write content and invalidate cache afterward."],
]);

const HTML_TRANSCRIPT = serializeTranscript([
	["## user", "The dashboard has four cards: Chart, Alerts, Activity, and Status. On desktop they sit in a 2x2 grid, but at narrow widths they overlap instead of stacking into one column. I need to SEE the before and after layouts side by side — a text list can't show the overlap. Draw both grids."],
	["## assistant", "Found it: the media query at max-width: 640px still sets grid-template-columns to two columns, so chart, alerts, activity, and status squeeze and overlap instead of stacking."],
	["## assistant", "Fixed: below max-width: 640px, grid-template-columns is now a single column with chart, alerts, activity, and status stacked in that order."],
]);

const DEGRADATION_TRANSCRIPT = serializeTranscript([
	["## user", "Our CTO says we should adopt trunk-based development instead of release branches. What changes day to day, and what risks should we plan for?"],
	["## assistant", "Trunk-based development means merging small changes directly to main several times a day. Day to day, branches live hours not weeks, feature flags hide unfinished work, and CI must pass before every merge, so test speed becomes the first bottleneck. The main risks are integration surprises moving to every day, incomplete features reaching main behind flags that never get cleaned up, and rollback discipline replacing the safety of not merging a bad branch."],
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
			// "dates.ts", not "src/utils/dates.ts": a smallest-view file tree roots
			// at src/utils/ and names the file, so the full path never appears
			// literally.
			requiredTokens: ["src/utils/formatters.ts", "dates.ts", "formatDate", "formatRelativeTime", "formatCurrency"],
			forbiddenText: ["Sure", "Here is", "I'll explain", "file:///"],
		},
	},
	// One fixture per show-me form, seeded from the canonical examples in the
	// show-me skill and blog (https://www.humanlayer.com/blog/show-me-skill),
	// MIT-licensed and credited in THIRD_PARTY_NOTICES.md. Each is a candidate
	// docs showcase pending maintainer approval.
	{
		id: "show-call-stack",
		description: "Runtime control flow: trace a slow session-create through the handler to the worker",
		target: CALL_STACK_TRANSCRIPT,
		expectations: {
			requiredTokens: ["handleCreateSession", "validateRequest", "SessionStore.insert", "publish", "AgentWorker.run", "loadContext", "callModel", "persistResult"],
			forbiddenText: ["Sure", "Here is", "file:///"],
		},
	},
	{
		id: "show-pseudocode",
		description: "Algorithm logic: editor scroll-position capture and restore",
		target: PSEUDOCODE_TRANSCRIPT,
		expectations: {
			requiredTokens: ["capture", "restore", "focusedBlock", "wholeBlockAnchor", "resolveAnchor", "scrollTop", "revision"],
			forbiddenText: ["Sure", "Here is", "file:///"],
		},
	},
	{
		id: "show-component-tree",
		description: "UI structure: session page component tree with state hooks and module boundaries",
		target: COMPONENT_TREE_TRANSCRIPT,
		expectations: {
			requiredTokens: ["SessionPage", "useSessionEvents", "SessionToolbar", "RunSkillButton", "SessionTimeline", "SkillResultCard", "session.tsx", "packages/ui"],
			forbiddenText: ["Sure", "Here is", "file:///"],
		},
	},
	{
		id: "show-file-layout",
		description: "File responsibility: shallow src/ tree for a refactor scope",
		target: FILE_LAYOUT_TRANSCRIPT,
		expectations: {
			requiredTokens: ["commands", "sessions", "transport", "registry.ts", "show-me.ts", "store.ts", "worker.ts", "events.ts", "client.ts", "stream.ts", "config.ts"],
			forbiddenText: ["Sure", "Here is", "file:///"],
		},
	},
	{
		id: "show-types-signatures",
		description: "Program design: interfaces and signatures before code exists",
		target: TYPES_SIGNATURES_TRANSCRIPT,
		expectations: {
			requiredTokens: ["Item", "Cursor", "ItemId", "parentId", "position", "direction", "resolveTarget"],
			forbiddenText: ["Sure", "Here is", "file:///"],
		},
	},
	{
		id: "show-diff",
		description: "State change: the save handler now short-circuits unchanged content",
		target: DIFF_TRANSCRIPT,
		expectations: {
			requiredTokens: ["on(save)", "write content", "cached result", "invalidate cache"],
			forbiddenText: ["Sure", "Here is", "file:///"],
		},
	},
	{
		id: "show-html",
		description: "Spatial layout: dashboard grid before/after at narrow widths",
		target: HTML_TRANSCRIPT,
		expectations: {
			requiredTokens: ["max-width: 640px", "grid-template-columns", "chart", "alerts", "activity", "status"],
			forbiddenText: ["Sure", "Here is", "file:///"],
		},
	},
	{
		id: "show-degradation",
		description: "Prose-only session: must degrade to an outline, never force a diagram",
		target: DEGRADATION_TRANSCRIPT,
		expectations: {
			requiredTokens: [],
			// No fenced block of any kind: prose must degrade to a plain outline.
			forbiddenText: ["Sure", "Here is", "Summary", "file:///", "```"],
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

// ponytail: a diff fence must carry at least one + or - marker line; pure
// addition (new file) and pure deletion layouts are legitimate show-me forms,
// so requiring both would false-positive — only a marker-less "diff" is junk.
function findShowDiffViolations(output: string): string[] {
	return [...output.matchAll(FENCED_BLOCK_PATTERN)]
		.filter((match) => match[1].toLowerCase() === "diff")
		.filter((match) => !/^\+[^+]/m.test(match[0]) && !/^-(?!-)/m.test(match[0]))
		.map(() => "diff fence missing + or - marker lines");
}
