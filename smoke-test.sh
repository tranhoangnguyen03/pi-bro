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

const { agySelection, formatAgyUsage, parseAgyModels, parseBroSettings, wheelDelta } = await import(pathToFileURL(process.argv[2]));
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
	'if [ "${1:-}" = "models" ]; then' \
	'  printf "models\n" >> "$BRO_MODEL_CALLS"' \
	'  printf "gemini-test-one-high\tGemini Test One (High)\ngemini-test-one-low\tGemini Test One (Low)\ngemini-test-two-high\tGemini Test Two (High)\ngemini-test-two-low\tGemini Test Two (Low)\n"' \
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

touch "$calls_file" "$args_file" "$usage_calls_file" "$model_calls_file"
output=$(
	{
		printf '%s\n' '{"id":"bro-open-empty","type":"prompt","message":"/bro open"}'
		sleep 1
		printf '%s\n' '{"id":"bro-help","type":"prompt","message":"/bro help"}'
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
	} | PATH="$test_dir:$PATH" PI_BRO_MODEL="" PI_CODING_AGENT_DIR="$config_dir" BRO_CANARY_PREFIX="$canary_prefix" BRO_CALLS="$calls_file" BRO_ARGS="$args_file" BRO_USAGE_CALLS="$usage_calls_file" BRO_MODEL_CALLS="$model_calls_file" BRO_USAGE_CANARY="$usage_canary" "$pi_bin" --offline --mode rpc --session "$session_file" --no-extensions --no-skills --no-prompt-templates --no-context-files -e "$repo_dir/bro.ts"
)

success_count=$(printf '%s\n' "$output" | grep -c '"success":true' || true)
if [ "$success_count" -ne 13 ]; then
	printf 'Expected 13 successful /bro commands, got %s\n%s\n' "$success_count" "$output" >&2
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

expected_model_calls=$(printf 'models\nmodels\nmodels')
actual_model_calls=$(cat "$model_calls_file")
if [ "$actual_model_calls" != "$expected_model_calls" ]; then
	printf 'Expected exactly three Agy model-list calls, got:\n%s\n' "$actual_model_calls" >&2
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

expected_usage_calls=$(printf 'usage\nusage')
actual_usage_calls=$(cat "$usage_calls_file")
if [ "$actual_usage_calls" != "$expected_usage_calls" ]; then
	printf 'Expected exactly two Agy usage calls, got:\n%s\n' "$actual_usage_calls" >&2
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

printf 'bro output stayed out of the session and model context\n'
