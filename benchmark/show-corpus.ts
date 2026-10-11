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
import { isRenderableSequence } from "../src/util.ts";

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

const STATE_MACHINE_TRANSCRIPT = serializeTranscript([
	["## user", "Uploads sometimes end up stuck. What states can an upload job be in, and how does it move between them now?"],
	["## assistant", "An upload job starts in queued. A worker moves it to uploading. When the upload finishes it goes to verifying, and a passing checksum moves it to done."],
	["## assistant", "If uploading hits a network error, the job goes to retrying, waits, and goes back to uploading. After 3 failed tries, retrying moves it to failed instead."],
	["## assistant", "The stuck jobs were cancellations: a user cancel from queued or uploading set a flag but never changed the state. Fixed: cancel now moves the job from queued or uploading to cancelled. A cancel during verifying is ignored, as before."],
]);

const USER_FLOW_TRANSCRIPT = serializeTranscript([
	["## user", "Walk me through what a user goes through to sign in now that MFA and lockout are both in."],
	["## assistant", "The user enters an email, then a password. A wrong password shows an error and lets them try again; after 5 wrong passwords the account is locked for 15 minutes."],
	["## assistant", "With a correct password, users without MFA go straight to the dashboard. Users with MFA get a code prompt. A wrong code lets them try again, and a right code takes them to the dashboard."],
	["## assistant", "If the user ticked remember this device on an earlier sign-in, the code prompt is skipped for 30 days on that device."],
]);

const SEQUENCE_TRANSCRIPT = serializeTranscript([
	["## user", "I keep losing track of the OAuth login. Who talks to whom, in what order?"],
	["## assistant", "The browser calls GET /login on the app server. The app server stores a random state value and redirects the browser to the identity provider's /authorize with that state."],
	["## assistant", "After the user consents, the identity provider redirects the browser to /callback with a code and the same state. The app server checks the state; if it does not match, it returns 400 and stops."],
	["## assistant", "On a match, the app server sends the code to the identity provider's /token endpoint and gets tokens back. It then sets a session cookie and redirects the browser to /dashboard."],
]);

const WEBHOOK_TRANSCRIPT = serializeTranscript([
	["## user", "Orders were getting updated twice after payments. What actually happens when a payment event arrives now?"],
	["## assistant", "The payment provider POSTs the event to /webhooks/payments. The endpoint checks the signature; a bad signature gets 401 and nothing is queued."],
	["## assistant", "With a good signature, the endpoint puts the event on the jobs queue and answers 200 right away. The worker takes the job from the queue and updates the order."],
	["## assistant", "The double updates came from the old design: the endpoint updated the order inline and often took longer than 10 seconds, so the provider treated it as failed and retried. The provider retries any non-200 answer up to 5 times."],
]);

const CACHE_FILL_TRANSCRIPT = serializeTranscript([
	["## user", "Product pages hammer the database on a cold cache. Trace a product request through the cache now."],
	["## assistant", "A client calls GET /products/42 on the API. The API looks the product up in Redis; on a hit it returns the cached product."],
	["## assistant", "On a miss, the API reads the product from Postgres, writes it to Redis with a 300-second TTL, and returns it to the client."],
	["## assistant", "Fixed: two misses at once used to both read Postgres. Now the first miss takes a lock key in Redis, and a second request that finds the lock waits up to 50 ms and reads Redis again instead of Postgres."],
]);

const CI_DEPLOY_TRANSCRIPT = serializeTranscript([
	["## user", "A rollback put the broken build back last week. How does a push get to production now?"],
	["## assistant", "A push to main starts CI. CI runs the tests; if a test fails, the pipeline stops and nothing is built."],
	["## assistant", "When the tests pass, CI builds the image and pushes it to the registry tagged with the commit SHA. CI then calls the deploy service with that tag, and the deploy service tells the cluster to roll out the new image."],
	["## assistant", "If the health check fails within 2 minutes, the deploy service rolls the cluster back to the previous tag. The rollback bug: CI used to push only the latest tag, so rolling back redeployed the broken image."],
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
			forbiddenText: ["Sure", "Here is", "I'll explain", "```mermaid"],
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
		id: "show-state-machine",
		description: "State diagram: upload job states with a retry loop and a fixed cancel transition",
		target: STATE_MACHINE_TRANSCRIPT,
		expectations: {
			requiredTokens: ["queued", "uploading", "verifying", "done", "retrying", "failed", "cancelled"],
			forbiddenText: ["Sure", "Here is", "file:///", "```mermaid"],
		},
	},
	{
		id: "show-user-flow",
		description: "User flow: sign-in with lockout, MFA, and remember-this-device branches",
		target: USER_FLOW_TRANSCRIPT,
		expectations: {
			requiredTokens: ["email", "password", "15 minutes", "dashboard", "code", "30 days"],
			forbiddenText: ["Sure", "Here is", "file:///", "```mermaid"],
		},
	},
	{
		id: "show-sequence",
		description: "Sequence: OAuth login across browser, app server, and identity provider",
		target: SEQUENCE_TRANSCRIPT,
		expectations: {
			requiredTokens: ["/login", "/authorize", "/callback", "/token", "/dashboard", "state", "400"],
			forbiddenText: ["Sure", "Here is", "file:///"],
		},
	},
	{
		id: "show-webhook",
		description: "Sequence: payment webhook through endpoint, queue, and worker, with signature and retry rules",
		target: WEBHOOK_TRANSCRIPT,
		expectations: {
			requiredTokens: ["/webhooks/payments", "401", "200", "10 seconds", "5 times"],
			forbiddenText: ["Sure", "Here is", "file:///"],
		},
	},
	{
		id: "show-cache-fill",
		description: "Sequence: product request through API, Redis, and Postgres, with the cold-cache lock",
		target: CACHE_FILL_TRANSCRIPT,
		expectations: {
			requiredTokens: ["/products/42", "Redis", "Postgres", "300-second", "50 ms"],
			forbiddenText: ["Sure", "Here is", "file:///"],
		},
	},
	{
		id: "show-ci-deploy",
		description: "Sequence: push through CI, registry, deploy service, and cluster, with failure and rollback",
		target: CI_DEPLOY_TRANSCRIPT,
		expectations: {
			requiredTokens: ["main", "commit SHA", "2 minutes", "previous tag", "latest"],
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
const MERMAID_STYLING_PATTERN = /(?:^|;)\s*(?:style|classDef|class|click|linkStyle)\b|<[a-z/]/im;
const MERMAID_TYPE_LINE_PATTERN = /^\s*(?:sequenceDiagram|stateDiagram-v2|(?:flowchart|graph)\s+(?:TD|LR|TB|RL|BT))\s*;?\s*$/gm;

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
		// A mermaid fence's diagram type and direction lines are syntax, not identifiers.
		const text = block[1].toLowerCase() === "mermaid" ? block[0].replace(MERMAID_TYPE_LINE_PATTERN, "").replace(/^\s*direction \w+$/gm, "") : block[0];
		for (const match of text.matchAll(IDENTIFIER_TOKEN_PATTERN)) tokens.add(match[0]);
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
	const diagrams = blocks.filter((block) => block.language === "html" || block.language === "mermaid");
	if (diagrams.length > 1) violations.push("more than one diagram fence");
	if (diagrams.length === 1) {
		const language = diagrams[0]!.language;
		if (blocks[blocks.length - 1]!.language !== language) violations.push(`${language} fence is not the last fenced block`);
		if (output.slice(output.lastIndexOf("```") + 3).trim()) violations.push(`trailing content after the ${language} fence`);
	}
	for (const block of blocks) {
		if (block.language === "html" && EXTERNAL_RESOURCE_PATTERN.test(block.text)) violations.push("html fence references external resources");
		if (block.language === "html" && (/<script/i.test(block.text) || UNTAGGED_MERMAID_PATTERN.test(block.text))) violations.push("script or mermaid inside the html fence");
		if (block.language === "mermaid" && !isRenderableSequence(block.text.replace(/^```mermaid[^\n]*\n|```$/g, ""))) violations.push("mermaid is not a sequence with three or more participants");
		if (block.language === "mermaid" && MERMAID_STYLING_PATTERN.test(block.text)) violations.push("mermaid styling, links, or html labels");
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
