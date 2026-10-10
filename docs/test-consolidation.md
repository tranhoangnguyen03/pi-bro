# Issue #74 — test consolidation and coverage ledger

## Organization

The former shell heredoc is now `helpers.test.mjs`: 39 named sequential subtests
plus their parent suite. Existing shared setup/assertions remain in that parent;
modal/settings mutations retain their original execution order. This file also
retains the in-process Pi SDK load/reload/fork/tool-exclusion checks.

`test-build.mjs` centralizes scratch compilation for helpers, settings, and Show
HTML tests, with isolated TMPDIR/agent settings and fail-closed backend guards.
Each test-file process still compiles independently; this is not a global build
cache. `smoke-test.sh` retains real host RPC behavior and context-isolation tests.
PiG reuses that RPC suite without rerunning the Pi-only helper block.

## Deletion / surviving coverage

| Removed or consolidated | Why safe / surviving coverage |
| --- | --- |
| Always-true backendSupports and unreachable doctor branches | Every backend implements every capability; actual execution/permission/protocol suites remain unchanged apart from redundant predicate assertions. Backend effort validation stays. |
| Support predicate assertions in settings/backend suites | Asserted a constant, not execution. Per-backend feature invocation suites survive. |
| Export-existence assertions | Direct execute/agySelection calls already fail if exports disappear. Normalization assertions stay. |
| Repeated prompt assertions | One identical assertion for each required phrase remains. |
| Overlapping BTW switch/mode tests | Unified switch loop includes Agy, Claude, Grok, Codex, Muse. Unified mode loop keeps Claude/Grok/Codex/Muse sessions and separately verifies Agy invalidation. Saved context/session-mode reset test remains. |
| Shell README/changelog prose greps | Prose wording is not a runtime contract. Named manifest/file checks preserve packaged documentation expectations; existing prompt/help/mode/custom-prompt behavior checks remain. Benchmark manifest tests and manual no-retry documentation remain; no explicit no-retry assertion is claimed. |
| Shell helper block | Moved, not deleted; named Node subtests preserve original assertions and order. SDK tests retained as Node integration checks. |

Legacy settings, removed-command regressions, permission/cancellation/protocol/
continuation/context-isolation tests, frozen benchmark comparator, and manual
E2E guidance remain. Seven old decomposition fixtures are explicitly historical
semantic examples; their bytes, manifest, and rubric were not rewritten.

## Throttle regression

Two immediate activity events create one pending throttled emission. Node mock
timers advance Date, setTimeout, and setInterval beyond the 5000ms deadline after
cancellation. Removing both stopActivityThrottle calls makes the test fail:
three progress updates instead of two. Restoring cleanup passes. No real-time
30ms guess or live backend invocation is needed for this assertion.

## Measurements

Same local Node environment, one full run each (not a benchmark claim):
- Before: 182 Node tests + shell suite; 66.91s wall, 50.94s Node runner.
- After initial consolidation: 219 Node tests + RPC shell suite; 48.93s wall,
  40.70s Node runner. Named subtests increase the reported count despite removing
  redundant checks. Final run with the package-documentation check: 220 tests,
  29.58s wall, 22.08s Node runner.

Scheduling and machine load affect these figures. No arbitrary test-count or
line-count reduction target was used. PiG executable qualification is left to CI.

## Issue #89 — test ownership and duplicate scaffolding consolidation

### Organization

A shared fake executable harness (`test-fake-exec.ts`) centralizes temporary
binary creation, `chmod`, and `PATH`/`BIN_DIR` isolation across all backend
offline test suites (`backend.test.ts`, `claude.test.ts`, `codex.test.ts`,
`grok.test.ts`, `muse.test.ts`, `helpers.test.mjs`), while keeping protocol
payloads local and `test-cli-guard.ts` active fail-closed.

Misplaced settings, model resolution, and turn validation assertions are moved
from `helpers.test.mjs` to `settings.test.ts`. Custom model picker tests in
`settings.test.ts` are table-driven across external backends with catalog
offsets calculated dynamically from `EXTERNAL_BACKENDS`, replacing brittle
hardcoded cursor loops (8, 9, 10, 11 down arrows).

In `helpers.test.mjs`, all remaining loose top-level assertions (terminal mouse
reporting, CLI usage, BTW parsing, web address/URL validation, webpage
extraction, show turn extraction, Show HTML sandboxing, show argument parsing,
document extraction symlink containment) are enclosed in named sequential
`await t.test(...)` subtests, and the registered `bro_advisor` tool integration
block is elevated to a top-level subtest.

### Deletion / surviving coverage

| Removed or consolidated | Why safe / surviving coverage |
| --- | --- |
| Duplicate advisor argv/stdin assertions in `helpers.test.mjs` | Authoritatively covered by `feature invocation: argv flags, stdin delivery, cwd, model, effort, continuation` in `backend.test.ts` (flags, `--print` absence, stdin envelope, cwd). Wrapper timeout bridging and registered-tool integration survive in `helpers.test.mjs`. |
| Duplicate old-CLI `-input-format` exit-2 rejection in `helpers.test.mjs` | Authoritatively covered by `missing terminal: handles clean exit without terminal result and old-Agy flag error` in `backend.test.ts`. |
| Weaker single-process SIGKILL escalation in `helpers.test.mjs` | Fully superseded by the strictly stronger `POSIX child/grandchild ignoring TERM escalates to SIGKILL with bounded cleanup` in `backend.test.ts` (POSIX process group with child and grandchild escalation and OS `ps` probe). Bounded SIGTERM exit (well under 8s after 150ms cancellation) is retained in `helpers.test.mjs`. |
| Oversized line test in `helpers.test.mjs` | Transferred to backend ownership: tested for pending-buffer overflow without newline in `frameStdoutLines` unit suite, and tested for `explain` (newline-terminated) and `advisor` (newline-free) in `production Agy framing` in `backend.test.ts`. |
| Overlapping wall-clock heartbeat tests in `helpers.test.mjs` | Merged into a single deterministic subtest using Node mock timers (`t.mock.timers`) and deferred completion. Proves both `lastActivityAt` and `activityCount` stability without real-time delays. |
| Unobserved decoy CLI scripts in `muse.test.ts` and `codex.test.ts` | Dead code creating unasserted `*-ran` markers in temp directories; `test-cli-guard.ts` already guarantees fail-closed isolation across all backends. Active assertions (`agy-ran` in Codex; `agy-ran` and `claude-ran` in Grok; `agy` fallback in Claude) remain intact. |
| Duplicate shallow UI wrapper test in `ui-capabilities.test.ts` | Merged into the main interactive capability withdrawal test. |
| Repetitive custom picker tests in `settings.test.ts` | Table-driven across Claude, Grok, Codex, and Muse with dynamic down-arrow offsets and cross-backend effort reset checks. |
| Standalone loose assertions in `helpers.test.mjs` | Wrapped in domain-scoped subtests to prevent single-assertion failures from aborting subsequent tests. Removed `--fresh` check restored in `BTW argument, composer command, and thread transcript parsing`. |

### Measurements

Same local Node environment, one full run each (not a benchmark claim):
- Before #89: 264 Node tests; 51.27s wall time.
- After #89: 274 Node tests; 20.95s wall time (domain subtest naming increases reported count while removing redundant subprocess invocations and real-time sleeps). The Explain modal M-switch poll limit was extended from 200 to 600 iterations (up to 6s) to ensure resilience against scheduling jitter under concurrent test-runner load.

