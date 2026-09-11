#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pi_bin=${PI_BIN:-"$repo_dir/node_modules/.bin/pi"}
test_dir=$(mktemp -d)
session_file="$test_dir/session.jsonl"
config_dir="$test_dir/config"
prompt_file="$config_dir/bro-prompt.md"
settings_file="$config_dir/bro-settings.json"
settings_snapshot="$test_dir/settings-after-commands.json"
calls_file="$test_dir/agy-calls"
args_file="$test_dir/agy-args"
usage_calls_file="$test_dir/agy-usage-calls"
model_calls_file="$test_dir/agy-model-calls"
version_calls_file="$test_dir/agy-version-calls"
show_prompts_file="$test_dir/agy-show-prompts"
canary_prefix="BRO_ONLY_CANARY_"
usage_canary="USAGE_ONLY_CANARY"
document_canary="DOCUMENT_ONLY_CANARY"
document_file="$repo_dir/.bro-smoke-document-$$.MD"
spaced_file="$repo_dir/.bro smoke notes $$.MD"
trap 'rm -rf -- "$test_dir"; rm -f -- "$document_file" "$spaced_file"' EXIT

if [ ! -x "$pi_bin" ]; then
	printf 'Pi was not found at %s. Run npm install first.\n' "$pi_bin" >&2
	exit 1
fi

wheel_build="$test_dir/wheel-build"
"$repo_dir/node_modules/.bin/tsc" --ignoreConfig "$repo_dir/bro.ts" \
	--target ES2022 --module NodeNext --moduleResolution NodeNext --strict \
	--allowImportingTsExtensions --rewriteRelativeImportExtensions \
	--skipLibCheck --types node --outDir "$wheel_build"
ln -s "$repo_dir/node_modules" "$wheel_build/node_modules"
node --input-type=module - "$wheel_build/bro.js" <<'JS'
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const {
	agyFailureMessage,
	agySelection,
	captureShowTranscript,
	extractDocumentText,
	extractShowHtml,
	stripShowHtmlFence,
	showEntriesForMessage,
	trimShowResult,
	writeShowHtml,
	extractWebHtml,
	extractWebPage,
	formatAgyUsage,
	isPublicWebAddress,
	looksLikeWebUrl,
	parseAgyModels,
	parseBroSettings,
	parseShowArguments,
	parseWebRedirect,
	parseWebUrl,
	setRegularMouseReporting,
	wheelDelta,
} = await import(pathToFileURL(process.argv[2]));
assert.equal(wheelDelta("\u001b[<64;10;20M"), -3);
assert.equal(wheelDelta("\u001b[<65;10;20M"), 3);
assert.equal(wheelDelta("\u001b[<68;10;20M"), -3);
assert.equal(wheelDelta("\u001b[<0;10;20M"), 0);
assert.equal(wheelDelta("\u001b[A"), 0);
const mouseWrites = [];
const regularTui = { mode: "regular", terminal: { write: (data) => mouseWrites.push(data) } };
setRegularMouseReporting(regularTui, true);
setRegularMouseReporting(regularTui, false);
setRegularMouseReporting({ mode: "fullscreen", terminal: regularTui.terminal }, true);
assert.deepEqual(mouseWrites, ["\u001b[?1000h\u001b[?1006h", "\u001b[?1000l\u001b[?1006l"]);
const usage = formatAgyUsage({
	status: "SUCCESS",
	response: "Gemini Models\tWeekly Limit Remaining\t97%\n",
});
assert.match(usage, /Gemini Models/);
assert.match(usage, /97%/);
assert.throws(() => formatAgyUsage({ status: "SUCCESS" }), /invalid usage data/);
assert.deepEqual(parseAgyModels("gemini-one-high\tGemini One (High)\ngemini-one-low\tGemini One (Low)\nclaude-one\tClaude One\n"), [
	{
		id: "gemini-one",
		label: "Gemini One",
		efforts: ["low", "high"],
		variants: [
			{ id: "gemini-one-high", effort: "high" },
			{ id: "gemini-one-low", effort: "low" },
		],
	},
	{ id: "claude-one", label: "Claude One", efforts: [], variants: [{ id: "claude-one", effort: undefined }] },
]);
assert.throws(() => parseAgyModels("Fetching available models...\n"), /no available models/);
assert.deepEqual(parseBroSettings({ model: " gemini-one ", effort: "high" }), {
	model: "gemini-one",
	effort: "high",
	mode: "balanced",
	showTurns: 1,
});
assert.deepEqual(parseBroSettings({ model: "gemini-one", effort: "low", mode: "faithful" }), {
	model: "gemini-one",
	effort: "low",
	mode: "faithful",
	showTurns: 1,
});
assert.throws(() => parseBroSettings({ model: "gemini-one", effort: "low", mode: "unknown" }), /mode/);
assert.throws(() => parseBroSettings({ model: "gemini-one", effort: "extreme" }), /Settings must contain/);
assert.deepEqual(agySelection({ model: "gemini-one", effort: "low" }), { model: "gemini-one", effort: "low" });
assert.deepEqual(agySelection({ model: "gemini-one-low", effort: "high" }), { model: "gemini-one", effort: "high" });
assert.deepEqual(agySelection({ model: "claude-one", effort: "default" }), { model: "claude-one" });
assert.match(agyFailureMessage("start", { code: 1, killed: false, stderr: "" }), /installed and signed in/);
assert.match(agyFailureMessage("start", { code: 1, killed: true, stderr: "" }), /timed out/);
assert.match(agyFailureMessage("check usage", { code: 1, killed: false, stderr: "Sign in first" }), /Sign in first/);
assert.equal(isPublicWebAddress("93.184.216.34"), true, "public IPv4");
assert.equal(isPublicWebAddress("2606:4700:4700::1111"), true, "public IPv6");
for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "192.0.2.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
	assert.equal(isPublicWebAddress(address), false, address);
}
assert.equal(parseWebUrl("https://example.com/article#section").href, "https://example.com/article");
assert.throws(() => parseWebUrl("file:///etc/passwd"), /HTTP or HTTPS/);
assert.throws(() => parseWebUrl("https://user:secret@example.com"), /usernames or passwords/);
assert.equal(looksLikeWebUrl("https://example.com/article"), true);
assert.equal(looksLikeWebUrl("https://example.com/article#section"), true);
assert.equal(looksLikeWebUrl("https://example.com/page?a=1&b=2"), true);
assert.equal(looksLikeWebUrl("HTTPS://example.com/article"), true);
assert.equal(looksLikeWebUrl("https://[2606:4700:4700::1111]/"), true);
assert.equal(looksLikeWebUrl("https://user:secret@example.com"), true, "routes to the URL reader's rejection");
assert.equal(looksLikeWebUrl("https://example.com is down, why?"), false, "prose stays text");
assert.equal(looksLikeWebUrl("example.com/article"), false);
assert.equal(looksLikeWebUrl("file:///etc/passwd"), false);
assert.equal(looksLikeWebUrl("ftp://example.com/file"), false);
assert.equal(looksLikeWebUrl("mailto:someone@example.com"), false);
assert.equal(looksLikeWebUrl("localhost:3000"), false);
assert.equal(parseWebRedirect(new URL("http://example.com/old"), "/new").href, "http://example.com/new");
assert.throws(() => parseWebRedirect(new URL("https://example.com"), "http://example.com"), /insecure/);
await assert.rejects(extractWebPage("http://127.0.0.1"), /local, private, or reserved/);
const webpage = await extractWebHtml(`<!doctype html><html><head><title>Example\u001b[2J article</title></head><body>
	<nav>Site navigation</nav><main><article><h1>Example article</h1><p>This is the important explanation with enough useful words for extraction.</p><pre><code>npm test</code></pre><div id="comments">Ignore this reply</div><img src="large.jpg" alt="Large image"></article></main>
</body></html>`, "https://example.com/article");
assert.match(webpage.text, /important explanation/);
assert.match(webpage.text, /npm test/);
assert.doesNotMatch(webpage.text, /Site navigation|Ignore this reply|large\.jpg/);
assert.equal(webpage.label, "example.com · Example article");
const originalFetch = globalThis.fetch;
let extractorFetches = 0;
globalThis.fetch = async () => {
	extractorFetches++;
	throw new Error("unexpected extractor network fallback");
};
try {
	await extractWebHtml("<main><p>Public social post shell with enough fallback text.</p></main>", "https://x.com/example/status/123");
} finally {
	globalThis.fetch = originalFetch;
}
assert.equal(extractorFetches, 0, "web extractor called a third-party fallback");
await assert.rejects(extractWebHtml("<p></p>".repeat(100_001), "https://example.com"), /too complex/);

assert.equal(trimShowResult("x".repeat(100)).length, 100);
const elided = trimShowResult(`${"h".repeat(3_000)}MIDDLE${"t".repeat(3_000)}`);
assert.match(elided, /\[… elided 2006 characters …\]/);
assert.ok(elided.startsWith("h".repeat(2_000)) && elided.endsWith("t".repeat(2_000)));

assert.deepEqual(showEntriesForMessage({ role: "user", content: "Fix the bug" }), ['## user\n"Fix the bug"']);
assert.deepEqual(showEntriesForMessage({ role: "user", content: [] }), []);
const assistantEntries = showEntriesForMessage({
	role: "assistant",
	content: [
		{ type: "text", text: "Checking." },
		{ type: "toolCall", name: "read", arguments: { path: "src/config/settings.ts" } },
	],
});
assert.equal(assistantEntries.length, 2);
assert.match(assistantEntries[0], /^## assistant\n"Checking\."$/);
assert.match(assistantEntries[1], /^## tool call: read\n/);
assert.ok(assistantEntries[1].includes("src/config/settings.ts"));
assert.deepEqual(showEntriesForMessage({ role: "assistant", content: [{ type: "thinking", thinking: "long reasoning" }] }), [
	'## assistant\n"(reasoning omitted)"',
]);
const imageEntries = showEntriesForMessage({ role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] });
assert.match(imageEntries[0], /\(1 image omitted\)/);
const resultEntry = showEntriesForMessage({
	role: "toolResult",
	toolName: "bash",
	isError: true,
	content: [{ type: "text", text: "boom" }],
});
assert.deepEqual(resultEntry, ['## tool result: bash (error)\n"boom"']);

const seededBranch = (entries) => ({ sessionManager: { getBranch: () => entries } });
const turn = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: `2026-01-01T00:00:0${id[0]}:00.000Z`, message });
const showContext = seededBranch([
	turn("1aaa", null, { role: "user", content: "First", timestamp: 1 }),
	turn("2aaa", "1aaa", { role: "assistant", content: [{ type: "text", text: "Reply one" }], timestamp: 2 }),
	turn("3aaa", "2aaa", { role: "user", content: "Second", timestamp: 3 }),
	turn("4aaa", "3aaa", { role: "assistant", content: [{ type: "text", text: "Reply two" }], timestamp: 4 }),
]);
const oneTurn = captureShowTranscript(showContext, 1);
assert.ok(oneTurn.text.includes("Second") && !oneTurn.text.includes("First"));
assert.equal(oneTurn.label, "last 1 turn");
const twoTurns = captureShowTranscript(showContext, 2);
assert.ok(twoTurns.text.includes("First") && twoTurns.text.includes("Second"));
assert.equal(twoTurns.label, "last 2 turns");
assert.equal(captureShowTranscript(seededBranch([]), 4), undefined);

assert.equal(extractShowHtml("no fences"), undefined);
assert.equal(
	extractShowHtml("```text\nshape\n```\n\n```html\n<div>x</div>\n```"),
	"<div>x</div>",
);
assert.equal(stripShowHtmlFence("```html\n<div>x</div>\n```\n\ntail"), "[HTML diagram saved — press O to open]\n\ntail");
assert.equal(stripShowHtmlFence("```text\nshape\n```\n```html\n<div>x</div>\n```").trim(), "```text\nshape\n```\n[HTML diagram saved — press O to open]".trim());
assert.equal(extractShowHtml("```html  \r\n<div>crlf</div>\r\n```  "), "<div>crlf</div>");

const showHtmlFirst = await writeShowHtml("<div>one</div>");
const showHtmlSecond = await writeShowHtml("<div>two</div>");
assert.notEqual(showHtmlFirst, showHtmlSecond);
const { readdir: showReaddir, readFile: showReadFile } = await import("node:fs/promises");
const showDir = showHtmlSecond.slice(0, showHtmlSecond.lastIndexOf("/"));
assert.ok(/pi-bro-/.test(showDir), "html files live in a per-user directory");
const leftover = (await showReaddir(showDir)).filter((name) => /^bro-show-[0-9a-f]{8}\.html$/.test(name));
assert.deepEqual(leftover, [showHtmlSecond.split("/").pop()]);
const saved = await showReadFile(showHtmlSecond, "utf8");
assert.match(saved, /Content-Security-Policy/);
assert.match(saved, /<div>two<\/div>/);
assert.ok(!(await showReaddir(showHtmlFirst.slice(0, showHtmlFirst.lastIndexOf("/")))).includes(showHtmlFirst.split("/").pop()), "keep-one cleanup");

assert.throws(() => parseBroSettings({ model: "m", effort: "low", mode: "brief", showTurns: 0 }), /showTurns/);
assert.throws(() => parseBroSettings({ model: "m", effort: "low", mode: "brief", showTurns: 2.5 }), /showTurns/);
assert.equal(parseBroSettings({ model: "m", effort: "low", mode: "brief" }).showTurns, 1);
assert.equal(parseBroSettings({ model: "m", effort: "low", mode: "brief", showTurns: 9 }).showTurns, 9);

assert.deepEqual(parseShowArguments(""), { steering: "", invalid: false });
assert.deepEqual(parseShowArguments("3"), { requested: "3", steering: "", invalid: false });
assert.deepEqual(parseShowArguments("what changed"), { steering: "what changed", invalid: false });
assert.deepEqual(parseShowArguments("3 what changed"), { requested: "3", steering: "what changed", invalid: false });
// A digit-leading query token (2FA, 404, 3D) never parses as a turn count on its own.
assert.deepEqual(parseShowArguments("2FA the login flow"), { steering: "2FA the login flow", invalid: false });
// A count followed by a digit-leading query word is unambiguous: only the first token is ever a count.
assert.deepEqual(parseShowArguments("1 404 handler"), { requested: "1", steering: "404 handler", invalid: false });
assert.equal(parseShowArguments("0").invalid, true, "zero is not a valid turn count");
assert.equal(parseShowArguments("-1").invalid, true, "negative counts are rejected");
assert.equal(parseShowArguments("1.5").invalid, true, "decimal counts are rejected");
assert.equal(parseShowArguments("99999999999999999999").invalid, true, "unsafe integers are rejected");
assert.equal(parseShowArguments(String(Number.MAX_SAFE_INTEGER)).invalid, false, "the largest safe integer is accepted");
// Internal whitespace in the query survives verbatim; only the count/query separator is consumed.
assert.equal(parseShowArguments("3   what   changed").steering, "what   changed");
assert.equal(parseShowArguments("Focus  on   spacing").steering, "Focus  on   spacing");

const root = await mkdtemp(join(tmpdir(), "pi-bro-extract-"));
const outside = await mkdtemp(join(tmpdir(), "pi-bro-outside-"));
try {
	await writeFile(join(root, "Complex Notes.MD"), "  readable text  ");
	assert.equal(await extractDocumentText("Complex Notes.MD", root), "readable text");
	await writeFile(join(outside, "secret.txt"), "outside");
	await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));
	await assert.rejects(extractDocumentText("linked.txt", root), /current workspace/);
	await writeFile(join(root, "unsupported.csv"), "a,b");
	await assert.rejects(extractDocumentText("unsupported.csv", root), /Unsupported file type/);
} finally {
	await rm(root, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
}
JS

mkdir "$config_dir"
printf 'CUSTOM_TEMPLATE_MARKER\n\n{{response}}\n' > "$prompt_file"
printf '# Complex notes\n\n%s\n' "$document_canary" > "$document_file"
printf '# Spaced notes\n\n%s\n' "$document_canary" > "$spaced_file"

printf '{"type":"session","version":3,"id":"00000000-0000-7000-8000-000000000000","timestamp":"2026-01-01T00:00:00.000Z","cwd":"%s"}\n' "$repo_dir" > "$session_file"
printf '%s\n' \
	'{"type":"message","id":"11111111","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"Explain it.","timestamp":1}}' \
	'{"type":"message","id":"22222222","parentId":"11111111","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Original complicated reply."}],"api":"google-generative-ai","provider":"google","model":"gemini-test","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2}}' \
	>> "$session_file"

printf '%s\n' \
	'#!/bin/sh' \
	'case "${PWD##*/}" in pi-bro-*) ;; *) exit 13;; esac' \
	'if [ "${BRO_AGY_FAILURE:-}" = "1" ]; then exit 1; fi' \
	'if [ "${1:-}" = "--version" ]; then' \
	'  printf "version\n" >> "$BRO_VERSION_CALLS"' \
	'  printf "agy 1.1.13\n"' \
	'  exit 0' \
	'fi' \
	'if [ "${1:-}" = "models" ]; then' \
	'  printf "models\n" >> "$BRO_MODEL_CALLS"' \
	'  printf "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\ngemini-3.7-flash-low\tGemini 3.7 Flash (Low)\ngemini-test-one-high\tGemini Test One (High)\ngemini-test-one-low\tGemini Test One (Low)\ngemini-test-two-high\tGemini Test Two (High)\ngemini-test-two-low\tGemini Test Two (Low)\n"' \
	'  exit 0' \
	'fi' \
	'if [ "${2:-}" = "/usage" ]; then' \
	'  case " $* " in *" --output-format json "*) ;; *) exit 15;; esac' \
	'  case " $* " in *" --disable-slash-commands"*) exit 16;; esac' \
	'  printf "usage\n" >> "$BRO_USAGE_CALLS"' \
	'  printf "{\"status\":\"SUCCESS\",\"response\":\"Gemini Models %s\\\\tWeekly Limit Remaining\\\\t97%%\\\\n\"}\n" "$BRO_USAGE_CANARY"' \
	'  exit 0' \
	'fi' \
	'case "$*" in *"Quoted session transcript as a JSON string"*)' \
	'  case " $* " in *" --sandbox "*) ;; *) exit 17;; esac' \
	'  case " $* " in *" --output-format stream-json "*) ;; *) exit 14;; esac' \
	'  case "$*" in *"## user"*) ;; *) exit 18;; esac' \
	'  call=$(( $(wc -l < "$BRO_CALLS") + 1 ))' \
	'  printf "%s\n" "$call" >> "$BRO_CALLS"' \
	'  printf "%s\n" "$*" >> "$BRO_SHOW_PROMPTS"' \
	'  model="" effort=""' \
	'  while [ "$#" -gt 0 ]; do' \
	'    case "$1" in --model) shift; model=$1;; --effort) shift; effort=$1;; esac' \
	'    shift' \
	'  done' \
	'  printf "%s\t%s\n" "$model" "$effort" >> "$BRO_ARGS"' \
	'  printf "%s\n" "{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"SHOW_OUTPUT_CANARY\"}}"' \
	'  exit 0' \
	'esac' \
	'case "$*" in *"CUSTOM_TEMPLATE_MARKER"*) ;; *) exit 12;; esac' \
	'case "$*" in *"Original complicated reply."*|*"$BRO_DOCUMENT_CANARY"*|*"PASTED_TEXT_ONLY_CANARY"*|*"ROUTED_WHOLE_RAW_CANARY"*) ;; *) exit 12;; esac' \
	'case " $* " in *" --output-format stream-json "*) ;; *) exit 14;; esac' \
	'call=$(( $(wc -l < "$BRO_CALLS") + 1 ))' \
	'printf "%s\n" "$call" >> "$BRO_CALLS"' \
	'model="" effort=""' \
	'while [ "$#" -gt 0 ]; do' \
	'  case "$1" in --model) shift; model=$1;; --effort) shift; effort=$1;; esac' \
	'  shift' \
	'done' \
	'printf "%s\t%s\n" "$model" "$effort" >> "$BRO_ARGS"' \
	'printf "%s\n" "{\"event\":\"init\"}"' \
	'printf "%s\n" "{\"event\":\"step_update\",\"step_update\":{\"step_type\":\"checkpoint\"}}"' \
	'printf "%s" "{\"event\":\"step_"' \
	'sleep 0.1' \
	'printf "update\",\"step_update\":{\"step_type\":\"agent_response\",\"text_delta\":\"PREVIEW_%s\"}}\n" "$call"' \
	'printf "%s\n" "{\"event\":\"step_update\",\"step_update\":{\"step_type\":\"agent_response\",\"text_delta\":\" continued\"}}"' \
	'printf "{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"%s%s\"}}\n" "$BRO_CANARY_PREFIX" "$call"' \
	> "$test_dir/agy"
chmod +x "$test_dir/agy"

touch "$calls_file" "$args_file" "$usage_calls_file" "$model_calls_file" "$version_calls_file" "$show_prompts_file"
output=$(
	{
		printf '%s\n' '{"id":"bro-open-empty","type":"prompt","message":"/bro open"}'
		sleep 1
		printf '%s\n' '{"id":"bro-help","type":"prompt","message":"/bro help"}'
		sleep 1
		printf '%s\n' '{"id":"bro-doctor","type":"prompt","message":"/bro doctor"}'
		sleep 1
		printf '%s\n' '{"id":"bro-usage","type":"prompt","message":"/bro usage"}'
		sleep 1
		printf '%s\n' '{"id":"bro-usage-explicit","type":"prompt","message":"/bro usage --provider agy"}'
		sleep 1
		printf '%s\n' '{"id":"bro-usage-invalid","type":"prompt","message":"/bro usage --provider unknown"}'
		sleep 1
		printf '%s\n' '{"id":"bro-default","type":"prompt","message":"/bro"}'
		sleep 1
		printf '%s\n' '{"id":"bro-open-first","type":"prompt","message":"/bro open"}'
		sleep 1
		printf '{"id":"bro-file","type":"prompt","message":"/bro file %s"}\n' "$document_file"
		sleep 1
		printf '%s\n' '{"id":"bro-open-file","type":"prompt","message":"/bro open"}'
		sleep 1
		printf '%s\n' '{"id":"bro-url-missing","type":"prompt","message":"/bro url"}'
		sleep 1
		printf '%s\n' '{"id":"bro-open-extra","type":"prompt","message":"/bro open the door please"}'
		sleep 1
		printf '%s\n' '{"id":"bro-mode-invalid","type":"prompt","message":"/bro mode unknown"}'
		sleep 1
		printf '%s\n' '{"id":"bro-mode","type":"prompt","message":"/bro mode faithful"}'
		sleep 1
		printf '%s\n' '{"id":"bro-model-invalid","type":"prompt","message":"/bro model unknown"}'
		sleep 1
		printf '%s\n' '{"id":"bro-model","type":"prompt","message":"/bro model gemini-test-two"}'
		sleep 1
		printf '%s\n' '{"id":"bro-effort-invalid","type":"prompt","message":"/bro effort extreme"}'
		sleep 1
		printf '%s\n' '{"id":"bro-effort","type":"prompt","message":"/bro effort high"}'
		sleep 1
		cp "$settings_file" "$settings_snapshot"
		printf '{"model":"gemini-test-one","effort":"low"}\n' > "$settings_file"
		printf '%s\n' '{"id":"bro-text","type":"prompt","message":"/bro text PASTED_TEXT_ONLY_CANARY"}'
		sleep 1
		printf '{"id":"bro-route-file","type":"prompt","message":"/bro %s"}\n' "$document_file"
		sleep 1
		cat <<-EOF
		{"id":"bro-route-quoted","type":"prompt","message":"/bro \"$spaced_file\""}
		EOF
		sleep 1
		printf '%s\n' '{"id":"bro-route-text","type":"prompt","message":"/bro ROUTED_WHOLE_RAW_CANARY trailing words"}'
		sleep 1
		printf '%s\n' '{"id":"bro-show","type":"prompt","message":"/bro show"}'
		sleep 1
		printf '%s\n' '{"id":"bro-show-count-and-query","type":"prompt","message":"/bro show 2 Trace The Login Flow"}'
		sleep 1
		printf '%s\n' '{"id":"bro-show-query-only","type":"prompt","message":"/bro show Explain The Auth Redirect"}'
		sleep 1
		printf '%s\n' '{"id":"bro-show-invalid","type":"prompt","message":"/bro show 0"}'
		sleep 1
		printf '%s\n' '{"id":"bro-open-second","type":"prompt","message":"/bro open"}'
		sleep 1
	} | PATH="$test_dir:$PATH" PI_BRO_MODEL="" PI_CODING_AGENT_DIR="$config_dir" BRO_CANARY_PREFIX="$canary_prefix" BRO_CALLS="$calls_file" BRO_ARGS="$args_file" BRO_USAGE_CALLS="$usage_calls_file" BRO_MODEL_CALLS="$model_calls_file" BRO_VERSION_CALLS="$version_calls_file" BRO_SHOW_PROMPTS="$show_prompts_file" BRO_USAGE_CANARY="$usage_canary" BRO_DOCUMENT_CANARY="$document_canary" "$pi_bin" --offline --mode rpc --session "$session_file" --no-extensions --no-skills --no-prompt-templates --no-context-files -e "$repo_dir/bro.ts"
)

success_count=$(printf '%s\n' "$output" | grep -c '"success":true' || true)
if [ "$success_count" -ne 27 ]; then
	printf 'Expected 27 successful /bro commands, got %s\n%s\n' "$success_count" "$output" >&2
	exit 1
fi

if ! printf '%s\n' "$output" | grep -Fq 'Use /bro show [n-turns] [query].'; then
	printf 'Invalid show arguments did not produce an actionable warning:\n%s\n' "$output" >&2
	exit 1
fi

if ! printf '%s\n' "$output" | grep -q 'Use /bro url <url>.'; then
	printf 'Missing URL input did not produce an actionable warning:\n%s\n' "$output" >&2
	exit 1
fi

if ! printf '%s\n' "$output" | grep -q 'Use /bro open.'; then
	printf 'Extra open arguments did not produce an actionable warning:\n%s\n' "$output" >&2
	exit 1
fi

expected_args=$(printf 'gemini-3.7-flash\tlow\ngemini-3.7-flash\tlow\ngemini-test-one\tlow\ngemini-test-one\tlow\ngemini-test-one\tlow\ngemini-test-one\tlow\ngemini-test-one\tlow\ngemini-test-one\tlow\ngemini-test-one\tlow')
actual_args=$(cat "$args_file")
if [ "$actual_args" != "$expected_args" ]; then
	printf 'Selected model and effort were not applied:\n%s\n' "$actual_args" >&2
	exit 1
fi

show_call_count=$(grep -c "Quoted session transcript as a JSON string" "$show_prompts_file" || true)
if [ "$show_call_count" -ne 3 ]; then
	printf 'Expected exactly three /bro show Agy calls, got %s:\n%s\n' "$show_call_count" "$(cat "$show_prompts_file")" >&2
	exit 1
fi
if ! grep -Fq '"Trace The Login Flow"' "$show_prompts_file"; then
	printf 'A count+query /bro show call did not reach Agy with the original-case query:\n%s\n' "$(cat "$show_prompts_file")" >&2
	exit 1
fi
if grep -Fq '"trace the login flow"' "$show_prompts_file"; then
	printf 'Show steering was lowercased for a count+query call:\n%s\n' "$(cat "$show_prompts_file")" >&2
	exit 1
fi
if ! grep -Fq '"Explain The Auth Redirect"' "$show_prompts_file"; then
	printf 'A query-only /bro show call did not reach Agy with the original-case query:\n%s\n' "$(cat "$show_prompts_file")" >&2
	exit 1
fi

node --input-type=module - "$settings_snapshot" "$settings_file" <<'JS'
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

assert.deepEqual(JSON.parse(await readFile(process.argv[2], "utf8")), {
	model: "gemini-test-two",
	effort: "high",
	mode: "faithful",
	showTurns: 1,
});
assert.deepEqual(JSON.parse(await readFile(process.argv[3], "utf8")), {
	model: "gemini-test-one",
	effort: "low",
});
JS

expected_model_calls=$(printf 'models\nmodels\nmodels\nmodels')
actual_model_calls=$(cat "$model_calls_file")
if [ "$actual_model_calls" != "$expected_model_calls" ]; then
	printf 'Expected exactly four Agy model-list calls, got:\n%s\n' "$actual_model_calls" >&2
	exit 1
fi

if printf '%s\n' "$output" | grep -q '"method":"notify".*"notifyType":"error"'; then
	printf 'Bro reported an error while parsing the fake Agy stream:\n%s\n' "$output" >&2
	exit 1
fi

expected_calls=$(printf '1\n2\n3\n4\n5\n6\n7\n8\n9')
actual_calls=$(cat "$calls_file")
if [ "$actual_calls" != "$expected_calls" ]; then
	printf 'Expected exactly nine numbered AGY calls, got:\n%s\n' "$actual_calls" >&2
	exit 1
fi

expected_usage_calls=$(printf 'usage\nusage\nusage')
actual_usage_calls=$(cat "$usage_calls_file")
if [ "$actual_usage_calls" != "$expected_usage_calls" ]; then
	printf 'Expected exactly three Agy usage calls, got:\n%s\n' "$actual_usage_calls" >&2
	exit 1
fi

if [ "$(cat "$version_calls_file")" != "version" ]; then
	printf 'Doctor did not check the Agy version\n' >&2
	exit 1
fi

if grep -q -e "$canary_prefix" -e "$usage_canary" -e "$document_canary" -e "SHOW_OUTPUT_CANARY" "$session_file"; then
	printf 'Bro output leaked into the session\n' >&2
	exit 1
fi

node --input-type=module - "$session_file" "$canary_prefix" "$usage_canary" "$document_canary" <<'JS'
import { readFile } from "node:fs/promises";
import { buildSessionContext, parseSessionEntries } from "@earendil-works/pi-coding-agent";

const entries = parseSessionEntries(await readFile(process.argv[2], "utf8"));
const context = buildSessionContext(entries);
const serialized = JSON.stringify(context);
if (
	serialized.includes(process.argv[3]) ||
	serialized.includes(process.argv[4]) ||
	serialized.includes(process.argv[5]) ||
	serialized.includes("SHOW_OUTPUT_CANARY") ||
	serialized.includes("Quoted session transcript")
) {
	throw new Error("Bro output leaked into model context");
}
JS

missing_config="$test_dir/missing-config"
missing_session="$test_dir/missing-session.jsonl"
cp "$session_file" "$missing_session"
missing_output=$(
	{
		printf '%s\n' '{"id":"missing-doctor","type":"prompt","message":"/bro doctor"}'
		sleep 1
		printf '%s\n' '{"id":"missing-usage","type":"prompt","message":"/bro usage"}'
		sleep 1
		printf '%s\n' '{"id":"missing-model","type":"prompt","message":"/bro model gemini-3.7-flash"}'
		sleep 1
		printf '%s\n' '{"id":"missing-effort","type":"prompt","message":"/bro effort low"}'
		sleep 1
		printf '%s\n' '{"id":"missing-route-url","type":"prompt","message":"/bro https://user:secret@example.com/doc"}'
		sleep 1
		printf '%s\n' '{"id":"missing-latest","type":"prompt","message":"/bro"}'
		sleep 1
		printf '%s\n' '{"id":"missing-help","type":"prompt","message":"/bro help"}'
		sleep 1
	} | PATH="$test_dir:$PATH" BRO_AGY_FAILURE=1 PI_CODING_AGENT_DIR="$missing_config" "$pi_bin" --offline --mode rpc --session "$missing_session" --no-extensions --no-skills --no-prompt-templates --no-context-files -e "$repo_dir/bro.ts"
)

missing_success_count=$(printf '%s\n' "$missing_output" | grep -c '"success":true' || true)
if [ "$missing_success_count" -ne 7 ]; then
	printf 'Bro did not contain a missing-Agy failure:\n%s\n' "$missing_output" >&2
	exit 1
fi
if ! printf '%s\n' "$missing_output" | grep -q 'usernames or passwords'; then
	printf 'Credential-bearing routed URL was not rejected by the URL reader:\n%s\n' "$missing_output" >&2
	exit 1
fi
if ! printf '%s\n' "$missing_output" | grep -q '/bro doctor'; then
	printf 'Missing-Agy errors did not suggest Doctor:\n%s\n' "$missing_output" >&2
	exit 1
fi
if printf '%s\n' "$missing_output" | grep -q -e 'ENOENT' -e 'spawn agy'; then
	printf 'Missing-Agy errors exposed raw process details:\n%s\n' "$missing_output" >&2
	exit 1
fi

broken_config="$test_dir/broken-config"
broken_settings="$broken_config/bro-settings.json"
broken_prompt="$broken_config/bro-prompt.md"
broken_session="$test_dir/broken-session.jsonl"
mkdir "$broken_config"
printf '{not json}\n' > "$broken_settings"
printf 'CUSTOM_TEMPLATE_MARKER\n\n{{response}}\n' > "$broken_prompt"
cp "$session_file" "$broken_session"
broken_output=$(
	{
		printf '%s\n' '{"id":"broken-help","type":"prompt","message":"/bro help"}'
		sleep 1
		printf '%s\n' '{"id":"broken-settings-doctor","type":"prompt","message":"/bro doctor"}'
		sleep 1
		printf '{"model":"gemini-3.7-flash","effort":"low"}\n' > "$broken_settings"
		printf 'This prompt has no placeholder.\n' > "$broken_prompt"
		printf '%s\n' '{"id":"broken-prompt-doctor","type":"prompt","message":"/bro doctor"}'
		sleep 1
		printf '%s\n' '{"id":"broken-prompt-latest","type":"prompt","message":"/bro"}'
		sleep 1
	} | PATH="$test_dir:$PATH" PI_CODING_AGENT_DIR="$broken_config" BRO_CANARY_PREFIX="$canary_prefix" BRO_CALLS="$calls_file" BRO_ARGS="$args_file" BRO_USAGE_CALLS="$usage_calls_file" BRO_MODEL_CALLS="$model_calls_file" BRO_VERSION_CALLS="$version_calls_file" BRO_USAGE_CANARY="$usage_canary" "$pi_bin" --offline --mode rpc --session "$broken_session" --no-extensions --no-skills --no-prompt-templates --no-context-files -e "$repo_dir/bro.ts" 2>&1
)

broken_success_count=$(printf '%s\n' "$broken_output" | grep -c '"success":true' || true)
if [ "$broken_success_count" -ne 4 ]; then
	printf 'Bro did not contain broken local configuration:\n%s\n' "$broken_output" >&2
	exit 1
fi
if ! printf '%s\n' "$broken_output" | grep -q 'must contain'; then
	printf 'Broken-prompt errors were not actionable:\n%s\n' "$broken_output" >&2
	exit 1
fi
if ! printf '%s\n' "$broken_output" | grep -q '/bro doctor'; then
	printf 'Broken-prompt errors did not suggest Doctor:\n%s\n' "$broken_output" >&2
	exit 1
fi

if ! grep -q '/bro mode' "$repo_dir/README.md" || ! grep -q 'brief' "$repo_dir/README.md" || ! grep -q 'balanced' "$repo_dir/README.md" || ! grep -q 'faithful' "$repo_dir/README.md"; then
	printf 'README does not document all Bro modes\n' >&2
	exit 1
fi
if ! grep -Eqi 'balanced.*default|default.*balanced' "$repo_dir/README.md"; then
	printf 'README does not identify balanced as the default mode\n' >&2
	exit 1
fi
if ! grep -qi 'custom prompt.*override\|override.*custom prompt' "$repo_dir/README.md" ||
	! grep -qi 'saved mode.*inactive\|mode.*inactive' "$repo_dir/README.md" ||
	! grep -qi 'remov.*bro-prompt\|renam.*bro-prompt' "$repo_dir/README.md"; then
	printf 'README does not fully explain existing custom prompt precedence\n' >&2
	exit 1
fi
if ! grep -q 'brief —' "$repo_dir/bro.ts" || ! grep -q 'balanced —' "$repo_dir/bro.ts" || ! grep -q 'faithful —' "$repo_dir/bro.ts"; then
	printf 'Built-in help does not describe all Bro modes\n' >&2
	exit 1
fi
if [ ! -f "$repo_dir/CHANGELOG.md" ] || ! grep -q '/bro mode' "$repo_dir/CHANGELOG.md" || ! grep -qi 'custom prompt' "$repo_dir/CHANGELOG.md"; then
	printf 'CHANGELOG does not document modes and custom prompt compatibility\n' >&2
	exit 1
fi
if [ ! -f "$repo_dir/benchmark/README.md" ] || ! grep -q 'benchmark:dry-run' "$repo_dir/benchmark/README.md" ||
	! grep -q -- '--approve' "$repo_dir/benchmark/README.md" || ! grep -qi 'manual' "$repo_dir/benchmark/README.md" ||
	! grep -qi 'never retries\|does not retry' "$repo_dir/benchmark/README.md"; then
	printf 'Benchmark documentation is incomplete\n' >&2
	exit 1
fi
if ! grep -q 'CHANGELOG.md' "$repo_dir/package.json"; then
	printf 'CHANGELOG is not included in the npm package\n' >&2
	exit 1
fi

printf 'bro setup failures stayed contained and output stayed out of the session and model context\n'
