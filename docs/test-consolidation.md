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
