#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pi_bin=${PI_BIN:-"$repo_dir/node_modules/.bin/pi"}
test_dir=$(mktemp -d)
# All Node tmpdir() consumers, including diagram cleanup, stay inside this run.
export TMPDIR="$test_dir"
# Block every real backend even if routing regresses outside an explicit fake.
mkdir "$test_dir/guard-bin"
for cli in agy claude grok codex muse; do
	printf '#!/bin/sh\necho "Unexpected backend invocation blocked by smoke tests" >&2\nexit 97\n' > "$test_dir/guard-bin/$cli"
	chmod +x "$test_dir/guard-bin/$cli"
done
export PATH="$test_dir/guard-bin:$PATH"
session_file="$test_dir/session.jsonl"
config_dir="$test_dir/config"
preferences_file="$config_dir/bro-preferences.md"
legacy_prompt_file="$config_dir/bro-prompt.md"
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

# Serialize RPC requests by their acknowledgements, not machine-speed-dependent sleeps.
# Keep stdin open until the final response; Pi exits on EOF even with work in flight.
export BRO_SMOKE_PI_BIN="$pi_bin"
export BRO_SMOKE_RPC="$repo_dir/smoke-rpc.mjs"
cat > "$test_dir/pi-rpc" <<'RPC'
#!/bin/sh
exec node "$BRO_SMOKE_RPC" "$@"
RPC
chmod +x "$test_dir/pi-rpc"
pi_bin="$test_dir/pi-rpc"


mkdir "$config_dir"
printf 'PREFERENCES_MARKER\n' > "$preferences_file"
# The legacy template is no longer read; the fake agy fails if its marker ever reaches a prompt.
printf 'LEGACY_MARKER\n\n{{response}}\n' > "$legacy_prompt_file"
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
	'  printf "agy 1.1.15\n"' \
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
	'case "$*" in *"LEGACY_MARKER"*) exit 19;; esac' \
	'case "$*" in *"Quoted session transcript as a JSON string"*)' \
	'  case "$*" in *"PREFERENCES_MARKER"*) ;; *) exit 20;; esac' \
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
	'case "$*" in *"PREFERENCES_MARKER"*) ;; *) exit 12;; esac' \
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
		printf '%s\n' '{"id":"bro-help","type":"prompt","message":"/bro help"}'
		printf '%s\n' '{"id":"bro-doctor","type":"prompt","message":"/bro doctor"}'
		printf '%s\n' '{"id":"bro-default","type":"prompt","message":"/bro"}'
		printf '%s\n' '{"id":"bro-open-first","type":"prompt","message":"/bro open"}'
		printf '{"id":"bro-file","type":"prompt","message":"/bro file %s"}\n' "$document_file"
		printf '%s\n' '{"id":"bro-open-file","type":"prompt","message":"/bro open"}'
		printf '%s\n' '{"id":"bro-url-missing","type":"prompt","message":"/bro url"}'
		printf '%s\n' '{"id":"bro-open-extra","type":"prompt","message":"/bro open the door please"}'
		printf '%s\n' '{"id":"bro-mode-invalid","type":"prompt","message":"/bro mode unknown"}'
		# Shared model/effort now come from /bro config; a config-written file must survive /bro mode.
		node -e 'console.log(JSON.stringify({type:"smoke-write",path:process.argv[1],text:JSON.stringify({version:2,default:{backend:"agy",model:"gemini-test-two",effort:"high"},mode:"balanced",showTurns:1})}))' "$settings_file"
		printf '%s\n' '{"id":"bro-mode","type":"prompt","message":"/bro mode faithful"}'
		printf '%s\n' '{"id":"bro-model-removed","type":"prompt","message":"/bro model"}'
		printf '%s\n' '{"id":"bro-model-removed-id","type":"prompt","message":"/bro model gemini-test-one"}'
		printf '%s\n' '{"id":"bro-effort-removed","type":"prompt","message":"/bro effort"}'
		printf '%s\n' '{"id":"bro-effort-removed-level","type":"prompt","message":"/bro EFFORT low"}'
		node -e 'console.log(JSON.stringify({type:"smoke-copy",from:process.argv[1],to:process.argv[2]})); console.log(JSON.stringify({type:"smoke-write",path:process.argv[1],text:JSON.stringify({model:"gemini-test-one",effort:"low"})}))' "$settings_file" "$settings_snapshot"
		printf '%s\n' '{"id":"bro-text","type":"prompt","message":"/bro text PASTED_TEXT_ONLY_CANARY"}'
		printf '{"id":"bro-route-file","type":"prompt","message":"/bro %s"}\n' "$document_file"
		cat <<-EOF
		{"id":"bro-route-quoted","type":"prompt","message":"/bro \"$spaced_file\""}
		EOF
		printf '%s\n' '{"id":"bro-route-text","type":"prompt","message":"/bro ROUTED_WHOLE_RAW_CANARY trailing words"}'
		printf '%s\n' '{"id":"bro-show","type":"prompt","message":"/bro show"}'
		printf '%s\n' '{"id":"bro-show-count-and-query","type":"prompt","message":"/bro show 2 Trace The Login Flow"}'
		printf '%s\n' '{"id":"bro-show-query-only","type":"prompt","message":"/bro show Explain The Auth Redirect"}'
		printf '%s\n' '{"id":"bro-show-invalid","type":"prompt","message":"/bro show 0"}'
		printf '%s\n' '{"id":"bro-open-second","type":"prompt","message":"/bro open"}'
	} | PATH="$test_dir:$PATH" PI_BRO_MODEL="" PI_CODING_AGENT_DIR="$config_dir" BRO_CANARY_PREFIX="$canary_prefix" BRO_CALLS="$calls_file" BRO_ARGS="$args_file" BRO_USAGE_CALLS="$usage_calls_file" BRO_MODEL_CALLS="$model_calls_file" BRO_VERSION_CALLS="$version_calls_file" BRO_SHOW_PROMPTS="$show_prompts_file" BRO_USAGE_CANARY="$usage_canary" BRO_DOCUMENT_CANARY="$document_canary" "$pi_bin" --offline --mode rpc --session "$session_file" --no-extensions --no-skills --no-prompt-templates --no-context-files -e "$repo_dir/bro.ts"
)

success_count=$(printf '%s\n' "$output" | grep -c '"success":true' || true)
if [ "$success_count" -ne 24 ]; then
	printf 'Expected 24 successful /bro commands, got %s\n%s\n' "$success_count" "$output" >&2
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

for removed in model effort; do
	if ! printf '%s\n' "$output" | grep -Fq "/bro $removed was removed. Use /bro config"; then
		printf 'Removed /bro %s did not point to /bro config:\n%s\n' "$removed" "$output" >&2
		exit 1
	fi
done

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
	version: 2,
	default: { backend: "agy", model: "gemini-test-two", effort: "high" },
	mode: "faithful",
	showTurns: 1,
});
assert.deepEqual(JSON.parse(await readFile(process.argv[3], "utf8")), {
	model: "gemini-test-one",
	effort: "low",
});
JS

expected_model_calls=$(printf 'models')
actual_model_calls=$(cat "$model_calls_file")
if [ "$actual_model_calls" != "$expected_model_calls" ]; then
	printf 'Expected exactly one (Doctor) Agy model-list call, got:\n%s\n' "$actual_model_calls" >&2
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

expected_usage_calls=$(printf 'usage')
actual_usage_calls=$(cat "$usage_calls_file")
if [ "$actual_usage_calls" != "$expected_usage_calls" ]; then
	printf 'Expected exactly one Doctor Agy account call, got:\n%s\n' "$actual_usage_calls" >&2
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
		printf '%s\n' '{"id":"missing-model","type":"prompt","message":"/bro model gemini-3.7-flash"}'
		printf '%s\n' '{"id":"missing-effort","type":"prompt","message":"/bro effort low"}'
		printf '%s\n' '{"id":"missing-route-url","type":"prompt","message":"/bro https://user:secret@example.com/doc"}'
		printf '%s\n' '{"id":"missing-latest","type":"prompt","message":"/bro"}'
		printf '%s\n' '{"id":"missing-help","type":"prompt","message":"/bro help"}'
	} | PATH="$test_dir:$PATH" BRO_AGY_FAILURE=1 PI_CODING_AGENT_DIR="$missing_config" "$pi_bin" --offline --mode rpc --session "$missing_session" --no-extensions --no-skills --no-prompt-templates --no-context-files -e "$repo_dir/bro.ts"
)

missing_success_count=$(printf '%s\n' "$missing_output" | grep -c '"success":true' || true)
if [ "$missing_success_count" -ne 6 ]; then
	printf 'Bro did not contain a missing-Agy failure:\n%s\n' "$missing_output" >&2
	exit 1
fi
if [ "$(printf '%s\n' "$missing_output" | grep -c 'was removed. Use /bro config' || true)" -ne 2 ]; then
	printf 'Removed /bro model and /bro effort were not rejected before reaching Agy:\n%s\n' "$missing_output" >&2
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
broken_preferences="$broken_config/bro-preferences.md"
broken_session="$test_dir/broken-session.jsonl"
mkdir "$broken_config"
printf '{not json}\n' > "$broken_settings"
printf 'PREFERENCES_MARKER\n' > "$broken_preferences"
cp "$session_file" "$broken_session"
broken_output=$(
	{
		printf '%s\n' '{"id":"broken-help","type":"prompt","message":"/bro help"}'
		printf '%s\n' '{"id":"broken-settings-doctor","type":"prompt","message":"/bro doctor"}'
		node -e 'console.log(JSON.stringify({type:"smoke-write",path:process.argv[1],text:JSON.stringify({model:"gemini-3.7-flash",effort:"low"})})); console.log(JSON.stringify({type:"smoke-write",path:process.argv[2],text:"x".repeat(4001)}))' "$broken_settings" "$broken_preferences"
		printf '%s\n' '{"id":"broken-preferences-doctor","type":"prompt","message":"/bro doctor"}'
		printf '%s\n' '{"id":"broken-preferences-latest","type":"prompt","message":"/bro"}'
	} | PATH="$test_dir:$PATH" PI_CODING_AGENT_DIR="$broken_config" BRO_CANARY_PREFIX="$canary_prefix" BRO_CALLS="$calls_file" BRO_ARGS="$args_file" BRO_USAGE_CALLS="$usage_calls_file" BRO_MODEL_CALLS="$model_calls_file" BRO_VERSION_CALLS="$version_calls_file" BRO_USAGE_CANARY="$usage_canary" "$pi_bin" --offline --mode rpc --session "$broken_session" --no-extensions --no-skills --no-prompt-templates --no-context-files -e "$repo_dir/bro.ts" 2>&1
)

broken_success_count=$(printf '%s\n' "$broken_output" | grep -c '"success":true' || true)
if [ "$broken_success_count" -ne 4 ]; then
	printf 'Bro did not contain broken local configuration:\n%s\n' "$broken_output" >&2
	exit 1
fi
if ! printf '%s\n' "$broken_output" | grep -q 'keep it under 4,000'; then
	printf 'Oversize-preferences errors were not actionable:\n%s\n' "$broken_output" >&2
	exit 1
fi
if ! printf '%s\n' "$broken_output" | grep -q '/bro doctor'; then
	printf 'Oversize-preferences errors did not suggest Doctor:\n%s\n' "$broken_output" >&2
	exit 1
fi

# Capability overrides must actually reach the real Agy invocation, not just resolve correctly in
# pure helper functions: explain and show each get their own model/effort override here, distinct
# from the shared default and from each other, and a dedicated fake agy records exactly what it
# was invoked with. (btw cannot be driven through this offline RPC harness -- it requires
# ctx.mode === "tui" and an interactive composer -- so its wiring is covered at the pure-helper
# level, via the same capabilityPair/agySelection composition used at its real call site.)
override_config="$test_dir/override-config"
override_session="$test_dir/override-session.jsonl"
override_args_file="$test_dir/override-agy-args"
mkdir "$override_config"
cp "$session_file" "$override_session"
cat > "$override_config/bro-settings.json" <<'JSON'
{
  "model": "gemini-3.7-flash",
  "effort": "low",
  "mode": "balanced",
  "showTurns": 1,
  "overrides": {
    "explain": { "model": "gemini-test-one", "effort": "high" },
    "show": { "model": "gemini-test-two", "effort": "medium" }
  }
}
JSON

mkdir "$test_dir/override-bin"
printf '%s\n' \
	'#!/bin/sh' \
	'args="$*"' \
	'model="" effort=""' \
	'while [ "$#" -gt 0 ]; do' \
	'  case "$1" in --model) shift; model=$1;; --effort) shift; effort=$1;; esac' \
	'  shift' \
	'done' \
	'case "$args" in *"Quoted session transcript as a JSON string"*)' \
	'  printf "show\t%s\t%s\n" "$model" "$effort" >> "$OVERRIDE_ARGS"' \
	'  printf "%s\n" "{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"OVERRIDE_SHOW_OUTPUT\"}}"' \
	'  exit 0' \
	'esac' \
	'printf "explain\t%s\t%s\n" "$model" "$effort" >> "$OVERRIDE_ARGS"' \
	'printf "%s\n" "{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"OVERRIDE_EXPLAIN_OUTPUT\"}}"' \
	'exit 0' \
	> "$test_dir/override-bin/agy"
chmod +x "$test_dir/override-bin/agy"
touch "$override_args_file"

override_output=$(
	{
		printf '%s\n' '{"id":"override-explain","type":"prompt","message":"/bro"}'
		printf '%s\n' '{"id":"override-show","type":"prompt","message":"/bro show"}'
	} | PATH="$test_dir/override-bin:$PATH" PI_CODING_AGENT_DIR="$override_config" OVERRIDE_ARGS="$override_args_file" "$pi_bin" --offline --mode rpc --session "$override_session" --no-extensions --no-skills --no-prompt-templates --no-context-files -e "$repo_dir/bro.ts"
)

override_success_count=$(printf '%s\n' "$override_output" | grep -c '"success":true' || true)
if [ "$override_success_count" -ne 2 ]; then
	printf 'Capability-override explain/show commands did not both succeed:\n%s\n' "$override_output" >&2
	exit 1
fi

expected_override_args=$(printf 'explain\tgemini-test-one\thigh\nshow\tgemini-test-two\tmedium')
actual_override_args=$(cat "$override_args_file")
if [ "$actual_override_args" != "$expected_override_args" ]; then
	printf 'Per-capability overrides were not wired into the real Agy invocation:\nexpected:\n%s\ngot:\n%s\n' "$expected_override_args" "$actual_override_args" >&2
	exit 1
fi

# /bro advisor no longer has on/off/status controls: any old argument gets an actionable notice
# instead of a silent no-op, and the bare form reports actual runtime availability. ctx.ui.custom()
# modal bodies (doctor/help/config/advisor-steer) are not observable through this offline
# prompt-only RPC harness -- only notify() messages and session entries are. The LLM-callable
# bro_advisor cannot be driven through this prompt-only RPC harness either, so the wheel-build block
# above captures the actual registered tool from a fake Pi API and runs its execute() callback end
# to end against a fake context and real fake-agy subprocess.
advisor_config="$test_dir/advisor-config"
advisor_session="$test_dir/advisor-session.jsonl"
mkdir "$advisor_config"
# --session only persists to disk when resuming an existing file (see the pre-created
# "$session_file" above); a path with no header line stays in-memory only.
printf '{"type":"session","version":3,"id":"00000000-0000-7000-8000-000000000001","timestamp":"2026-01-01T00:00:00.000Z","cwd":"%s"}\n' "$repo_dir" > "$advisor_session"

advisor_output_1=$(
	{
		printf '%s\n' '{"id":"advisor-old-on","type":"prompt","message":"/bro advisor on"}'
		printf '%s\n' '{"id":"advisor-old-status","type":"prompt","message":"/bro advisor status"}'
		printf '%s\n' '{"id":"advisor-bare","type":"prompt","message":"/bro advisor"}'
	} | PATH="$test_dir:$PATH" PI_CODING_AGENT_DIR="$advisor_config" "$pi_bin" --offline --mode rpc --session "$advisor_session" --no-extensions --no-skills --no-prompt-templates --no-context-files -e "$repo_dir/bro.ts"
)

advisor_success_1=$(printf '%s\n' "$advisor_output_1" | grep -c '"success":true' || true)
if [ "$advisor_success_1" -ne 3 ]; then
	printf 'Advisor command flow did not complete:\n%s\n' "$advisor_output_1" >&2
	exit 1
fi
if [ "$(printf '%s\n' "$advisor_output_1" | grep -c 'no longer has on/off/status controls')" -ne 2 ]; then
	printf 'An old /bro advisor on/off/status argument did not produce an actionable removal notice both times:\n%s\n' "$advisor_output_1" >&2
	exit 1
fi
if ! printf '%s\n' "$advisor_output_1" | grep -Fq 'Bro advisor is available -- the executor agent can call bro_advisor.'; then
	printf 'Bare /bro advisor did not report availability in an unrestricted runtime:\n%s\n' "$advisor_output_1" >&2
	exit 1
fi

# A real host denylist must be reflected truthfully by the bare form -- never a false "available".
advisor_excluded_session="$test_dir/advisor-excluded-session.jsonl"
cp "$session_file" "$advisor_excluded_session"
advisor_excluded_output=$(
	{
		printf '%s\n' '{"id":"advisor-excluded-bare","type":"prompt","message":"/bro advisor"}'
	} | PATH="$test_dir:$PATH" PI_CODING_AGENT_DIR="$advisor_config" "$pi_bin" --offline --mode rpc --session "$advisor_excluded_session" --exclude-tools bro_advisor --no-extensions --no-skills --no-prompt-templates --no-context-files -e "$repo_dir/bro.ts"
)
if [ "${BRO_PIG_RPC_EXCLUSION_XFAIL:-}" = "0.3.0" ]; then
	# PiG 0.3.0 RPC still exposes excluded tools to the provider. Do not hide this
	# by changing Bro's availability logic. An upstream fix must remove this xfail.
	if ! printf '%s\n' "$advisor_excluded_output" | grep -Fq 'Bro advisor is available'; then
		printf 'PiG RPC exclusion behavior changed: remove/review the 0.3.0 expected failure.\n%s\n' "$advisor_excluded_output" >&2
		exit 1
	fi
	printf 'KNOWN FAILURE: PiG 0.3.0 RPC ignores --exclude-tools; use --tools allowlists (see docs/pig-compatibility.md).\n'
elif printf '%s\n' "$advisor_excluded_output" | grep -Fq 'Bro advisor is available'; then
	printf 'Host-excluded advisor falsely reported availability:\n%s\n' "$advisor_excluded_output" >&2
	exit 1
fi
if [ "${BRO_PIG_RPC_EXCLUSION_XFAIL:-}" != "0.3.0" ] && ! printf '%s\n' "$advisor_excluded_output" | grep -Fq 'Bro advisor is unavailable in this runtime.'; then
	printf 'Host-excluded advisor did not report unavailability:\n%s\n' "$advisor_excluded_output" >&2
	exit 1
fi

printf 'bro setup failures stayed contained and output stayed out of the session and model context\n'
