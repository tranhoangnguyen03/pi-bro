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

const CALL_STACK_TRANSCRIPT = serializeTranscript([
	["## user", "Creating a session is taking around two seconds. Trace the full path from the handler down so I can see where the time goes."],
	["## assistant", "Let me read the session handler and follow the call chain."],
	["## tool call: read", "src/sessions/handler.ts"],
	["## tool result: read", "export async function handleCreateSession(req: Request) {\n  await validateRequest(req);\n  await SessionStore.insert(req.body);\n  await publish('session.created');\n}"],
	["## tool call: read", "src/sessions/worker.ts"],
	["## tool result: read", "export async function AgentWorker.run(sessionId: string) {\n  const context = await loadContext(sessionId);\n  const result = await callModel(context);\n  await persistResult(sessionId, result);\n}"],
	["## tool call: read", "src/sessions/store.ts"],
	["## tool result: read", "export const SessionStore = {\n  async insert(payload) { /* writes row */ },\n};"],
	["## assistant", "The chain is handleCreateSession -> validateRequest -> SessionStore.insert -> publish(session.created), and the publish triggers AgentWorker.run -> loadContext -> callModel -> persistResult. The model call inside the worker is the slow step."],
]);

const PSEUDOCODE_TRANSCRIPT = serializeTranscript([
	["## user", "How does the editor capture and restore scroll position? Sketch the logic."],
	["## assistant", "Let me read the capture and restore functions."],
	["## tool call: read", "src/editor/scroll.ts"],
	["## tool result: read", "export function capture(blocks: Block[], targetRect: Rect, scrollRect: Rect): Snapshot {\n  const target = focusedBlock ?? firstBlockIntersectingViewportTop(blocks);\n  const anchor = wholeBlockAnchor(blocks, target);\n  const offset = targetRect.top - scrollRect.top;\n  return { anchor, offset, scrollTop: scrollRect.top, revision: revision + 1 };\n}\n\nexport function restore(snapshot: Snapshot, blocks: Block[]): number {\n  const placement = resolveAnchor(blocks, snapshot.anchor);\n  if (placement) return scrollRect.top + targetRect.top - snapshot.offset;\n  return snapshot.scrollTop;\n}"],
	["## assistant", "capture picks the focused block or the first block at the viewport top, records a whole-block anchor plus the signed offset and a revision counter; restore resolves the anchor or falls back to the raw scrollTop."],
]);

const COMPONENT_TREE_TRANSCRIPT = serializeTranscript([
	["## user", "What does the session page render? Show the component structure with the state hooks and module boundaries that matter."],
	["## assistant", "Let me read the session page and its toolbar."],
	["## tool call: read", "apps/example/src/routes/session.tsx"],
	["## tool result: read", "export function SessionPage() {\n  useSessionEvents();\n  return (\n    <>\n      <SessionToolbar />\n      <SessionTimeline />\n    </>\n  );\n}"],
	["## tool call: read", "packages/ui/src/toolbar.tsx"],
	["## tool result: read", "export function SessionToolbar() {\n  return <RunSkillButton />;\n}"],
	["## tool call: read", "packages/ui/src/timeline.tsx"],
	["## tool result: read", "export function SessionTimeline() {\n  return <SkillResultCard />;\n}"],
	["## assistant", "SessionPage owns the event hook and renders the toolbar and timeline; the toolbar and timeline live in packages/ui and render RunSkillButton and SkillResultCard respectively."],
]);

const FILE_LAYOUT_TRANSCRIPT = serializeTranscript([
	["## user", "Where does everything live in src/? I need the file layout with responsibilities before I scope a refactor."],
	["## tool call: bash", "find src -type f | sort"],
	["## tool result: bash", "src/commands/registry.ts\nsrc/commands/show-me.ts\nsrc/sessions/store.ts\nsrc/sessions/worker.ts\nsrc/sessions/events.ts\nsrc/transport/client.ts\nsrc/transport/stream.ts\nsrc/config.ts"],
	["## assistant", "The layout splits into commands (user intents), sessions (state and lifecycle), transport (API), and a root config."],
]);

const TYPES_SIGNATURES_TRANSCRIPT = serializeTranscript([
	["## user", "Before we write any code: what are the types for an ordered list of items with a cursor that can move up or down? Sketch the interfaces and the resolve signature."],
	["## assistant", "Here is the shape we agreed on, before implementation."],
	["## tool call: bash", "cat docs/types.md"],
	["## tool result: bash", "interface Item { id: ItemId; parentId: ItemId | null }\ninterface Cursor { position: ItemId; direction: 'up' | 'down' }\nfunction resolveTarget(items: Item[], cursor: Cursor): ItemId | null"],
	["## assistant", "Item is an id plus an optional parent; Cursor is a position plus a direction; resolveTarget maps an item list and cursor to the target item id or null when there is no move."],
]);

const DIFF_TRANSCRIPT = serializeTranscript([
	["## user", "What changed in the save handler? Show the diff."],
	["## assistant", "Let me read the current and previous save handler."],
	["## tool call: bash", "git diff -- src/save.ts"],
	["## tool result: bash", " on(save)\n-  write content\n+  if content is unchanged\n+    return cached result\n+  write new content\n+  invalidate cache"],
	["## assistant", "The save handler now short-circuits when content is unchanged, returns the cached result, and invalidates the cache after writing."],
]);

const HTML_TRANSCRIPT = serializeTranscript([
	["## user", "The dashboard has four cards: Chart, Alerts, Activity, and Status. On desktop they sit in a 2x2 grid, but at narrow widths they overlap instead of stacking into one column. I need to SEE the before and after layouts side by side — a text list can't show the overlap. Draw both grids."],
	["## assistant", "Let me read the dashboard layout."],
	["## tool call: read", "src/dashboard/Dashboard.css"],
	["## tool result: read", ".dashboard {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  grid-template-areas: \"chart alerts\" \"activity status\";\n  gap: 16px;\n}\n@media (max-width: 640px) { .dashboard { grid-template-columns: 1fr 1fr; } }"],
	["## assistant", "The media query keeps two columns under 640px, so the cards squeeze and overlap. The fix is a single column and stacked areas."],
	["## tool call: edit", "Dashboard.css: one column under 640px with stacked chart/alerts/activity/status"],
	["## tool result: edit", "@media (max-width: 640px) { .dashboard { grid-template-columns: 1fr; grid-template-areas: \"chart\" \"alerts\" \"activity\" \"status\"; } }"],
	["## assistant", "Fixed: at 640px and below the four cards stack in one column in order. A side-by-side visual makes the change obvious."],
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
			forbiddenText: ["Sure", "Here is", "Summary", "file:///"],
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
