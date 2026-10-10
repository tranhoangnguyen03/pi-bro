# Combined Guided Review Implementation Plan

> Historical record. For current behavior, acceptance and scope see [Guided Review](../guided-review.md). Earlier milestones, paused/unqualified statuses and proposed controls below describe their time; they are not current instructions or a future-work commitment.

**Goal:** Automatically explain and assess the captured PR during initial preparation and regeneration; questions are optional.

**Architecture:** Extend each version's existing Guide with an optional quality assessment and centrally stored findings. One existing backend call investigates the whole change and connected code, then supplies explanation, findings and model-reported coverage. App validates references against captured Git objects and owns identities/navigation/persistence. Legacy guides remain readable and explicitly unassessed. No pipeline, new dependency, code execution enforcement, automatic fixes or publication.

**Tech stack:** Existing TypeScript modules, pinned Pi 0.84.2 TUI/clipboard, Git evidence, Node offline tests.

## 1. Structured assessment and backwards compatibility
- `review.ts`, `review.test.ts`, `review-versions.test.mjs`: write failing tests for assessment parsing, individual bad-item isolation with disclosed warnings, strict saved-state validation, unique finding identities across regeneration, ownership mapping and old-guide loading.
- Assessment: holistic overview, model-reported inspected paths and unexamined areas, findings. Findings: kind, severity, scenario, impact, reasoning, uncertainty, suggested fix/check, evidence and optional owning topic.
- Require assessment for production generation; accepting an old schema for saved history must not imply a new quality assessment succeeded. Invalid overall output is rejected; malformed individual references/findings are disclosed as incomplete, never silently certified or repaired by a paid call.
- Update initial prompt with applicable quality lenses, connected-code investigation and static-only automatic preparation instructions. Do not render per-lens clean verdicts. Same captured revision on regeneration; new IDs do not inherit old discussion.

## 2. Reading and finding workflow
- `review-modal.ts`, `review-modal.test.mjs`: overview risk/priority/coverage, compact topic finding summaries, ranked Findings and Across the change lists, scrollable finding detail with evidence/fix/check, Back/Ask/Copy actions.
- Saved view validation accepts finding screen/identity; question navigation locates original guide version. Preserve geometry and wheel behavior at wide/narrow sizes.
- `review-ui.ts`, `review-session.test.mjs`, `review-regeneration.test.mjs`: hydrate finding evidence through existing cache, require assessment on initial/regenerated calls, reuse Pi clipboard with visible failures, preserve close/resume/cancellation/save-before-open behavior.
- Copy is not publication or insertion into the main editor.

## 3. Verification and documentation
- Red/green targeted tests: `node --test --test-concurrency=1 review.test.ts review-versions.test.mjs review-modal.test.mjs review-session.test.mjs review-regeneration.test.mjs`.
- Run the full package test chain serially (typecheck, release selftest, all test files, smoke), `npm pack --dry-run`, `git diff --check`.
- Update README/changelog/design/research to distinguish combined assessment from legacy walkthroughs and describe instructions versus enforcement.
- No commits, pushes, GitHub writes or live paid calls in this implementation pass.

## Simplification approved after UI review

One current guide replaces version retention. Regeneration installs valid output automatically; failure/cancellation preserves current content. Unique topic/finding IDs remain necessary to prevent attaching earlier questions to new content. Preserve only original target context for questions/nonempty drafts, not whole guide versions. Validate legacy version records before migrating, prefer a saved pending result, retain private drafts/context and avoid rewriting during load. New saves drop legacy version fields. Evidence retry must work from normal reading navigation, not version switching.

## Separate quality qualification gate
Offline mocks demonstrate contracts, not reviewer competence. Before claiming quality qualified, authorize a bounded live set: connected unchanged-caller defect, failure/cancellation defect, risky missing test, clean change, and a larger/truncated change. Measure supported findings, false positives, useful fixes/checks, citation support, latency, and unfamiliar-reader usefulness without Ask. No invented 45-second target or approval verdict.
