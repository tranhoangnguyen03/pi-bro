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
canary_prefix="BRO_ONLY_CANARY_"
usage_canary="USAGE_ONLY_CANARY"
trap 'rm -rf -- "$test_dir"' EXIT

if [ ! -x "$pi_bin" ]; then
	printf 'Pi was not found at %s. Run npm install first.\n' "$pi_bin" >&2
	exit 1
fi

wheel_build="$test_dir/wheel-build"
"$repo_dir/node_modules/.bin/tsc" --ignoreConfig "$repo_dir/bro.ts" \
	--target ES2022 --module NodeNext --moduleResolution NodeNext --strict \
	--skipLibCheck --types node --outDir "$wheel_build"
ln -s "$repo_dir/node_modules" "$wheel_build/node_modules"
node --input-type=module - "$wheel_build/bro.js" <<'JS'
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const { agyFailureMessage, agySelection, formatAgyUsage, parseAgyModels, parseBroSettings, wheelDelta } = await import(pathToFileURL(process.argv[2]));
assert.equal(wheelDelta("\u001b[<64;10;20M"), -3);
assert.equal(wheelDelta("\u001b[<65;10;20M"), 3);
assert.equal(wheelDelta("\u001b[<68;10;20M"), -3);
assert.equal(wheelDelta("\u001b[<0;10;20M"), 0);
assert.equal(wheelDelta("\u001b[A"), 0);
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
});
assert.throws(() => parseBroSettings({ model: "gemini-one", effort: "extreme" }), /Settings must contain/);
assert.deepEqual(agySelection({ model: "gemini-one", effort: "low" }), { model: "gemini-one", effort: "low" });
assert.deepEqual(agySelection({ model: "gemini-one-low", effort: "high" }), { model: "gemini-one", effort: "high" });
assert.deepEqual(agySelection({ model: "claude-one", effort: "default" }), { model: "claude-one" });
assert.match(agyFailureMessage("start", { code: 1, killed: false, stderr: "" }), /installed and signed in/);
assert.match(agyFailureMessage("start", { code: 1, killed: true, stderr: "" }), /timed out/);
assert.match(agyFailureMessage("check usage", { code: 1, killed: false, stderr: "Sign in first" }), /Sign in first/);
JS

mkdir "$config_dir"
printf 'CUSTOM_TEMPLATE_MARKER\n\n{{response}}\n' > "$prompt_file"

printf '%s\n' \
	'{"type":"session","version":3,"id":"00000000-0000-7000-8000-000000000000","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}' \
	'{"type":"message","id":"11111111","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"Explain it.","timestamp":1}}' \
	'{"type":"message","id":"22222222","parentId":"11111111","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Original complicated reply."}],"api":"google-generative-ai","provider":"google","model":"gemini-test","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2}}' \
	> "$session_file"

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
	'case "$*" in *"CUSTOM_TEMPLATE_MARKER"*"Original complicated reply."*) ;; *) exit 12;; esac' \
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

touch "$calls_file" "$args_file" "$usage_calls_file" "$model_calls_file" "$version_calls_file"
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
		printf '%s\n' '{"id":"bro-simplify","type":"prompt","message":"/bro simplify"}'
		sleep 1
		printf '%s\n' '{"id":"bro-open-second","type":"prompt","message":"/bro open"}'
		sleep 1
	} | PATH="$test_dir:$PATH" PI_BRO_MODEL="" PI_CODING_AGENT_DIR="$config_dir" BRO_CANARY_PREFIX="$canary_prefix" BRO_CALLS="$calls_file" BRO_ARGS="$args_file" BRO_USAGE_CALLS="$usage_calls_file" BRO_MODEL_CALLS="$model_calls_file" BRO_VERSION_CALLS="$version_calls_file" BRO_USAGE_CANARY="$usage_canary" "$pi_bin" --offline --mode rpc --session "$session_file" --no-extensions --no-skills --no-prompt-templates --no-context-files -e "$repo_dir/bro.ts"
)

success_count=$(printf '%s\n' "$output" | grep -c '"success":true' || true)
if [ "$success_count" -ne 14 ]; then
	printf 'Expected 14 successful /bro commands, got %s\n%s\n' "$success_count" "$output" >&2
	exit 1
fi

expected_args=$(printf 'gemini-3.7-flash\tlow\ngemini-test-one\tlow')
actual_args=$(cat "$args_file")
if [ "$actual_args" != "$expected_args" ]; then
	printf 'Selected model and effort were not applied:\n%s\n' "$actual_args" >&2
	exit 1
fi

node --input-type=module - "$settings_snapshot" "$settings_file" <<'JS'
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

assert.deepEqual(JSON.parse(await readFile(process.argv[2], "utf8")), {
	model: "gemini-test-two",
	effort: "high",
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

expected_calls=$(printf '1\n2')
actual_calls=$(cat "$calls_file")
if [ "$actual_calls" != "$expected_calls" ]; then
	printf 'Expected exactly two numbered AGY calls, got:\n%s\n' "$actual_calls" >&2
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

if grep -q -e "$canary_prefix" -e "$usage_canary" "$session_file"; then
	printf 'Bro output leaked into the session\n' >&2
	exit 1
fi

node --input-type=module - "$session_file" "$canary_prefix" "$usage_canary" <<'JS'
import { readFile } from "node:fs/promises";
import { buildSessionContext, parseSessionEntries } from "@earendil-works/pi-coding-agent";

const entries = parseSessionEntries(await readFile(process.argv[2], "utf8"));
const context = buildSessionContext(entries);
const serialized = JSON.stringify(context);
if (serialized.includes(process.argv[3]) || serialized.includes(process.argv[4])) {
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
		printf '%s\n' '{"id":"missing-simplify","type":"prompt","message":"/bro"}'
		sleep 1
		printf '%s\n' '{"id":"missing-help","type":"prompt","message":"/bro help"}'
		sleep 1
	} | PATH="$test_dir:$PATH" BRO_AGY_FAILURE=1 PI_CODING_AGENT_DIR="$missing_config" "$pi_bin" --offline --mode rpc --session "$missing_session" --no-extensions --no-skills --no-prompt-templates --no-context-files -e "$repo_dir/bro.ts"
)

missing_success_count=$(printf '%s\n' "$missing_output" | grep -c '"success":true' || true)
if [ "$missing_success_count" -ne 6 ]; then
	printf 'Bro did not contain a missing-Agy failure:\n%s\n' "$missing_output" >&2
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
		printf '%s\n' '{"id":"broken-prompt-simplify","type":"prompt","message":"/bro"}'
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

printf 'bro setup failures stayed contained and output stayed out of the session and model context\n'
