# Bro prompt benchmark

This benchmark compares Bro's frozen pre-mode prompt with the `brief`,
`balanced`, and `faithful` built-in prompts across eight synthetic fixtures.
It is maintainer tooling, not part of the npm package.

## Safety

The benchmark is manual and opt-in. `npm test` and CI never make live model
calls. A full new matrix can make up to 32 Agy calls using
`gemini-3.7-flash` at low effort and consumes account quota.

Before live execution, the runner:

- prints the exact manifest and its fingerprint;
- requires that fingerprint through `--approve`;
- shows current Agy usage;
- runs every call in a fresh temporary directory; and
- saves each result before starting the next call.

The runner does not retry failed or paid calls automatically. Re-running the
same manifest skips results whose stable call IDs already exist. Review the
saved failure before deleting any result and trying again.

## Run

First inspect the complete 32-row manifest without calling Agy:

```sh
npm run benchmark:dry-run
```

Copy the printed fingerprint only after checking the fixtures, variants, model,
effort, prompt hashes, and call IDs. Then run:

```sh
npm run benchmark:run -- --approve <fingerprint>
```

Press Ctrl-C to cancel the active call and stop the matrix. Completed results
remain available for a later resume.

Generate mechanical checks and a blind-review worksheet with:

```sh
npm run benchmark:report
```

Local results, the hidden candidate mapping, and review files live under
`benchmark/.work/`, which Git ignores. Do not commit raw outputs without first
checking them for sensitive data.

## Interpretation

Mechanical checks catch missing literals, code blocks, Markdown markers,
compliance-shaped injection output, preambles, and unexpected length changes.
They are review aids, not proof of semantic quality. A single matrix is
directional evidence for one model and effort; it does not validate every Agy
model.

The benchmark covers Bro's built-in prompts only and always runs without
preferences: `run.ts` calls the prompt builders directly and never reads
`bro-preferences.md`.

The bounded release decision and final measurements are in
[`initial-results.md`](initial-results.md). The corpus and several mechanical
checks are adapted from
[`wtfzambo/speak-like-you-eat`](https://github.com/wtfzambo/speak-like-you-eat)
under the MIT license recorded in `THIRD_PARTY_NOTICES.md`.

## Show track

The benchmark has a second, experimental track for the `/bro show` direction
(`docs/plans/2026-09-07-bro-show-visual-design.md`). It runs serialized
transcript fixtures through `SHOW_PROMPT` and grades selection semantics
(traceability of identifiers, fence shape, diff markers) rather than prose
preservation. The corpus carries one fixture per show-me form — call tree,
pseudocode, component tree, file layout, types and signatures, diff, HTML
layout, and prose degradation — plus a state machine, a branching user flow,
and a multi-party sequence, where a rendered Mermaid diagram should beat text. Its manifest, fingerprint, and results are
independent of the modes matrix:

```sh
npm run benchmark:dry-run -- --track show
npm run benchmark:run -- --track show --approve <fingerprint>
npm run benchmark:report -- --track show
```

Show results live in `benchmark/.work/show/`.

## External backend latency baseline (manual)

Track [issue #194](https://github.com/tranhoangnguyen03/pi-bro/issues/194).
This is a separate benchmark from the prompt-quality matrix.

Run an **unpaid** CLI-version startup proxy first:

```sh
node --experimental-transform-types benchmark/backend-latency.ts --backend agy --model gemini-3.7-flash
```

After checking the chosen CLI account and model, deliberately authorize **three real BTW turns**:

```sh
node --experimental-transform-types benchmark/backend-latency.ts --backend agy --model gemini-3.7-flash --turns 3 --run
```

Replace `agy` with `claude` or `codex` and choose a model supported by that CLI. To measure explicit subscriptions, launch the command with the same `PI_BRO_CLAUDE_AUTH_SOURCE=subscription` or `PI_BRO_CODEX_AUTH_SOURCE=subscription` and profile environment variables as the Pi/PiG host. The runner calls the same subscription preflight as Bro, then measures real calls; no credential is printed. Do not include an unrelated profile or working directory in comparisons.

The runner reports:
- `versionStartupProxyMs`: wall time for **`--version` only**, not the full model process or model readiness;
- `preflightMs`: a standalone explicit-subscription check, where selected; execution will run its own check again, just like production;
- `firstEventMs`: first backend progress event (may represent a tool or text);
- `firstTextMs`: first text progress event (some CLIs emit text only at the end);
- `totalMs`: full per-turn invocation time, **including** process startup and per-turn checks;
- `nativeContinuation`: whether each successful turn yielded a native continuation ID.

The benchmark **does not** yet isolate model startup versus provider queue/network latency; claims of seconds saved require a matched before/after comparison. Keep backend, model, effort, auth source, prompt, and cwd identical; compare median first-turn and repeat-turn results over several runs. The runner never auto-retries and stops after a failed turn. Its prompts are fixed synthetic text and outputs are not saved; only timings, model names, and coarse status appear on stdout. Inspect logs before sharing them. Only the explicit `--run` flag can incur model usage; at most ten turns are allowed per run. CI and `npm test` do not execute this live runner.
