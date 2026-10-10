# Guided Review bounded live qualification

> Historical record. For current behavior, acceptance and scope see [Guided Review](../guided-review.md). Earlier milestones, paused/unqualified statuses and proposed controls below describe their time; they are not current instructions or a future-work commitment.

## Authorization and setup

Human authorized a maximum of three feature-model attempts: known defect, clean change, saved-guide regeneration. No automatic retries, GitHub writes, commits or publication. Used production `openGuidedReview`, capture, prompt, backend execution, parser and persistence, with a headless host wrapper and isolated authored Git fixtures under `/tmp/bro-live-qualification-104`. This is live backend qualification, not another human TUI usability test.

Backend matched the normal Guided Review selection: **Agy / gemini-3.8-flash / high**. No normal settings or saved user reviews were modified. Source came from a local Git repository through production capture, not from GitHub network acquisition. Synthetic PR identities clearly identify `local/qualification-fixture`.

## Results

| Attempt | Result | Time |
| --- | --- | --- |
| Known defect | Found the exact changed-return/unchanged-caller defect, invalid unchanged tests and missing integration coverage; usable fix/check | 71s |
| Clean intended change | Parsed successfully, but two concerns; useful analysis mixed with opinion/test speculation and an unsupported access limitation | 81s |
| Initial regeneration attempt | Prematurely stopped by qualification harness; current guide/private work retained | ~0s |
| Final explicitly authorized regeneration | Successful replacement, original question/draft/context retained, same revision, clean source; production close/resume passed without another call | 77s |

### Known defect: bounded positive result

The changed `reserve()` API returns `{ok, remaining}` instead of boolean. Unchanged `checkout()` still uses `if (!reserve(...))`; failure is truthy, so a sold-out order is charged and returns paid. Unchanged inventory tests use strict boolean assertions.

- Lead independently reproduced sold-out charging before the model call.
- Model inspected/referenced changed `inventory.mjs`, unchanged `checkout.mjs` and unchanged `inventory.test.mjs`.
- High-severity finding correctly explains object truthiness and suggests checking `.ok` in the caller.
- Suggested check explicitly asserts a zero-stock checkout neither charges nor returns paid.
- Another finding correctly identifies invalid strict boolean assertions and proposes object assertions.
- Lead applied those two suggested fixes only in a separate authored-fixture scratch copy and ran two tests: **2 pass / 0 fail**. Captured evidence was not edited.
- All 11 returned source ranges independently resolve, including old-side and unchanged-file references.
- Some duplication: generic public API risk overlaps with concrete internal caller defect. Severity of test failure and external compatibility discussion are somewhat broad for a tiny fixture. This is not evidence of accuracy across large or unfamiliar repositories.

### Clean change: mixed/calibration warning

The intended change adds `Number.isSafeInteger(quantity) && quantity > 0` validation, retains boolean API, and tests reservation plus unchanged checkout behavior. Lead's fixture tests pass. Model returned two findings:

1. Medium risk: invalid quantities become `sold-out` at checkout, potentially misleading users. The source reasoning is accurate; whether it warrants a new `invalid-quantity` status is a product/API judgement. The intended contract deliberately stays boolean/two-status; suggestion would expand it. Treat as a question/trade-off, not a proven defect or acceptance blocker.
2. Low test gap: missing string/null/undefined cases. It explicitly acknowledges current platform validation rejects them correctly, then posits a future loose-comparison regression. This is speculative test advice, not a present bug. It does not establish that the clean fixture is defective.

All 8 returned ranges resolve. Reported inspection includes all four files. Test execution is honestly marked unrun. However the model reports lack of Git history/object access "due to sandbox environment access restrictions". Guided Review uses workspace-full and no enforced sandbox; that claimed cause is unsupported. Valid citations did not prevent an invented coverage explanation.

Verdict: no falsely proven code defect, but false-positive restraint/provenance is not cleanly qualified. One tiny clean fixture cannot measure a false-positive rate.

### Regeneration: harness error, not product failure

The host wrapper marked an existing `Review ready` header as completion before the confirmed regeneration began. It immediately sent close keys after launch. Production cancellation aborted the attempt during startup/investigation; the adapter may have been invoked but no response was received. Count it against the three-attempt authorization conservatively. No replacement/retry was made.

- Existing guide is byte-equivalent to prior saved guide.
- Saved question and unsent draft are retained.
- Captured revision is unchanged.
- No original compact context is expected until actual replacement; the still-current guide continues to own that discussion.
- Raw `03-regeneration` artifacts initially show zero-duration completion and `replaced: false`. They are evidence of aborted qualification, NOT successful regeneration. The harness's in-memory completion predicate was faulty; its source was corrected to require observed running state before terminal readiness, but not rerun.

This initial attempt was superseded by the explicitly authorized final successful regeneration below. No silent extra call was made.

## Integrity and verification

- Both successful generations passed production assessment parsing and citation validation.
- Independently checked all returned old/new blob ranges. Source references establish locations, not correctness of model conclusions.
- All captured checkouts remain clean.
- Workspace status before/after feature runs matches; no active working-tree source changes.
- Backend claimed no project-test execution in both reports; tool/process activity was not independently audited. Do not promote model-reported restraint to enforced safety or verified nonexecution.
- Controlled authored-fixture execution by the lead is distinct from automatic preparation on untrusted repository code.
- No unfamiliar-human journey, physical mouse, broad backend matrix, larger/truncated PR, private/fork acquisition or robust latency benchmark included.

## Artifacts

`/tmp/bro-live-qualification-104/` contains:
- `run.mjs`, `run.log`, fixture Git repository, isolated saved review store and compiled runtime;
- `01-known-defect-record.json`, `02-clean-record.json`, corresponding progress events/screens;
- `03-regeneration-record.json`, events and failed replacement checks (aborted harness run);
- `defect-reproduction.json`, `fixture-ground-truth.txt`, `suggested-fix-check.txt`;
- `results.json`, workspace before/after status.

## Conclusion and next

Manual UX acceptance remains approved. Bounded review capability has positive evidence: it can investigate an unchanged caller, find the known defect, produce supported citations and offer a fix/check that passes controlled validation. Clean-change suggestions remain advisory and human-reviewed. The final authorized call subsequently qualified successful simplified regeneration. The accepted UX, passing automated suite and live core/regeneration checks support first-slice PR readiness; they do not establish complete #104 or model certainty.

Follow-up preparation: Claude independently checked the prompt and regeneration harness (`run_5c7201a63827409f8b7dc8dd5654feb3`). Prompt now separates observed access errors, instruction-excluded work and absent captured material; intentional trade-offs remain questions, while broken unchanged callers/tests remain defects. Hypothetical future regression advice requires a concrete present risk. Red/green prompt regression passed; 12 focused prompt/regeneration/migration tests and typecheck passed. The corrected one-call harness (`regenerate-once.mjs`) gates completion on confirmed observed running→terminal state, preflights cancelled confirmation, and verifies saved replacement/private context/revision. Its offline gate self-check passed. The human explicitly authorized one final replacement call, with no more qualification rounds. It succeeded in 76,539 ms with all replacement/private-work/revision/source-clean checks true. Regenerated output contains two topics, three findings and ten independently resolved source ranges; the actual caller break remains a high-severity defect and the broader compatibility trade-off is now a question. Reported limitations distinguish instruction-excluded execution, absent manifests/configuration, and specific reported Git errors rather than a generic sandbox claim. Those reported tool errors were not independently traced and remain model-reported, not application certification. Production close/resume preserved the generated guide and original question/draft/context with no new preparation request. Artifacts: `04-run.log`, `04-regeneration-checks.json`, `04-regeneration-record.json`, `04-resume.log`. The final qualification budget is closed; no further live calls or reviewer rounds are proposed. The first slice is ready for PR review; full #104 remains unfinished.
