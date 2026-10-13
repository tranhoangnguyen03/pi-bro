# Issue #101: reader-visible prompt evaluation

Status: proposed design; implementation and live execution are not authorized by this document. Revised 2026-10-09: routine scoring is automated with deterministic checks plus calibrated yes/no LLM judgments; the human blind-review rubric is superseded. Corpus, assertions and judging rules live in `2026-10-09-benchmark-content-specification.md`, which governs where the two differ.

Issue: https://github.com/tranhoangnguyen03/pi-bro/issues/101

## Verdict and verified context

The issue is substantiated by the current repository. It describes a measurement gap, not evidence that the proposed prompt wording improves answers.

Inspected HEAD: `577039aaf856ecf5320a84abe6b2b59e5632b607` (package version 0.21.0). The working tree already contains the SimpleEnglish-inspired prompt changes, removal of six explain wording tests, and replacement of the frozen preferences snapshot test. These are pre-existing changes, not work done for this design. `prompt.fixtures.json` is already staged for deletion. Preserve those changes and unrelated untracked plans.

| Issue claim | Repository evidence |
| --- | --- |
| Wording tests impede prompt iteration | `prompt.test.ts` asserts Show menu phrases and ordering, advisor reply style, audience prose, and starter preference wording. Preferences ordering tests still anchor to audience/mode prose. |
| Fake mode routing depends on prose | The M-key integration test in `helpers.test.mjs` matches `Preserve every single claim` and `ELI-simpleton`, with every other input silently treated as balanced. |
| Old benchmark comparison | `benchmark/run.ts` uses `baseline` plus the three modes, eight fixtures, hardcoded Agy/Gemini selection, and no repeat identity. |
| Limited measurements | `benchmark/corpus.ts` checks literals, fences, markers, injection prefixes, unchanged text, preambles, and character-length ratios. It has no requested reader-visible counters. Thus “preservation only” is directionally right but not literally exhaustive. |
| No BTW evaluation | `Track` contains only `modes` and `show`. |
| No reproducible published evidence | Outputs and blind worksheets are saved, but only under ignored `benchmark/.work/`. `initial-results.md` publishes aggregates without tracked raw results. No offline number-recompute script exists. |
| Existing extension points | `backend.execute` supports all five current backends with single-attempt outcomes. `npm test` already discovers `benchmark/*.test.ts`; CI invokes `npm test`. |

The versioned `prompt.ts` and benchmark at HEAD match `v0.21.0`; the current uncommitted prompts form a natural first candidate. This must be captured explicitly rather than assuming HEAD always means shipped.

Update, 2026-10-09: the branch has moved (HEAD `d78daa3` when checked). Its explain and BTW builders still equal `v0.21.0`; only the advisor builder changed. The SimpleEnglish candidate prompts are no longer in the working tree — they are in `stash@{0}` ("WIP prompt changes"). Preparation must therefore record exactly which candidate is checked out, and must refuse to prepare a comparison in which every explain/BTW candidate prompt is byte-identical to shipped, rather than silently comparing shipped with itself.

### Fresh verification, 2026-10-07

On Node `v24.14.1`:

- `npm test`: exit 0; 248 tests passed, zero failures/skips/cancellations; typecheck, release-utils selftest, and RPC smoke checks also passed. Test-runner duration was about 43.7 seconds, not a performance benchmark.
- `node benchmark/run.ts dry-run`: 32 rows; fingerprint `7b9800c8e941878f8e5766140c988a83045035b6e1e760a94a05d7f625efeb13`.
- `node benchmark/run.ts dry-run --track show`: 10 rows; fingerprint `1afb6b0bc5d1ba9bcf0de0638c9fc0a2e6042d2cfa8fae099f274bde51f96167`.
- No live benchmark calls. No offline recompute could be run because it does not exist yet. Node 22 and actual backend/model behavior were not qualified here.

A single read-only Claude advisor consultation reviewed the design risks. Recommendations below were checked against the repository; this is not a multi-agent implementation plan.

## Approach and boundaries

**Recommend extending the existing benchmark**, with a small pure reporting module and a BTW corpus. Reuse the existing backend boundary rather than growing another collection of CLI adapters.

Alternatives rejected:

1. Only add counts to the old matrix: smaller, but leaves the wrong comparator, no repeats, no BTW coverage, and irreproducible evidence.
2. Human blind review of every output (this document's earlier choice): it keeps a person in every run's critical path, so the benchmark cannot finish unattended or support routine prompt iteration. Replaced by a single calibrated LLM judge answering yes/no assertions; humans author ground truth and calibration and adjudicate exceptions.
3. A general evaluation framework, multi-judge voting, or holistic model scores (1–10, "which is clearer?"): dependencies, cost, and an unvalidated quality number. The judge answers only the five predicate types defined in the content specification.

No new dependencies, prompt redesign, production mode markers, full-permission BTW evaluation, or Show rubric redesign. Preserve `baseline.ts`, `initial-results.md`, Show fixtures, and decomposition history. The historical report remains explicitly historical and non-reproducible unless its actual raw evidence can be recovered; never manufacture replacement data.

## 1. Unit tests: contracts rather than editorial choices

Put this principle in `docs/TESTING.md`: a prompt unit test protects construction, isolation, or a named safety contract. It is not evidence of answer quality. A failure should identify more than a harmless editorial change.

This does **not** mean deleting every text assertion: safety instructions are text, and selected assertions remain deliberate sentinels requiring review when reworded. Explain this exception rather than claiming regexes prove model behavior.

| Area | Keep | Remove or replace |
| --- | --- | --- |
| Explain | Modes/parsing/cycling, guarded JSON source, no invented source facts, preference insertion and precedence | Audience and mode wording snapshots, prose anchors used solely to locate preferences |
| Show | Traceability of identifiers and relationships, missing-evidence honesty, reported vs verified, requested/proposed/reported/unresolved distinction, guarded source, steering separation and blank behavior; HTML/resource restrictions | Menu inventory, preferred shape ordering, persona language, decomposition/style slogans; split mixed tests so safety checks survive |
| BTW | Explicit access contracts, guarded context/history, section separation and ordering, omitted/blank behavior, preference precedence | Answer-style phrasing; correct the test title that says the question is quoted when it is intentionally passed as a direct question |
| Advisor | Advisory-only/no edits, real access described honestly, unverified snapshot framing, backend neutrality, separate sections, missing inputs and whitespace behavior, no preferences | One-line verdict and narration-style instructions; exact missing-input prose where only nonempty labeled sections matter |
| Preferences | Exactly one quoted block, no other changes, blank equivalence, trimming/injection resistance, tone/language exceptions cannot override fidelity/access/evidence rules | Legacy audience wording and brittle audience/mode sentence anchors |
| Starter | Nonempty `## About me` structure and existing length limit | `simpleton`, `overworked`, and final analogy sentence matches |

Prefer assertions on quoted payloads, existing section labels, and insertion boundaries. Do not add labels to production prompts solely to make tests easier. Backend-neutrality checks must cover all current backend names, including Codex and Muse. Advisor preference isolation is ultimately a routing property: retain existing integration coverage instead of relying only on function arity or absence of the word “preferences”.

### Stable fake CLI

Do not export private prompt prose or add a production mode flag for this test.

In the test setup, use the actual prompt builder (from the same built module used by the integration test) to produce a lookup of full-prompt SHA-256 → mode for the known source and preference combinations. A small Node fake CLI hashes the received `--print` payload, looks it up, and fails on unknown or ambiguous input. No fallback to balanced.

This tests that the modal passes the selected mode to the builder; it intentionally does not judge the builder's wording. Rewording a prompt regenerates the lookup automatically. Continue checking M/R/open, cancellation, persisted defaults, preference reloads, and oversize rejection. Keep an explicit unknown-input failure check. If two modes produce identical prompts, setup must reject the ambiguous mapping rather than silently overwrite it.

## 2. Comparison inputs and paid-call identity

Keep `modes` and `show` track names; add `btw`. For modes and BTW, separate **prompt arm** (`shipped`/`candidate`) from **mode**, **preferences**, **backend selection**, and **repeat**.

Proposed command interface:

```sh
npm run benchmark:dry-run -- --track modes --shipped-ref v0.21.0 --repeats 2 --backend agy --model gemini-3.7-flash --effort low
npm run benchmark:run -- --manifest <prepared-manifest.json> --approve <fingerprint>
npm run benchmark:report -- --results <run-directory>
npm run benchmark:recompute -- --check
```

The live command executes the prepared manifest, not newly generated prompts. Dry-run may write a local prepared bundle, but never invokes a backend. Fail closed on invalid tracks/options, missing refs/builders, unsupported backend/effort combinations, and invalid repeat counts. Require at least two repeats for a published comparison.

- Require an explicit shipped ref; resolve it to a commit. For this comparison use `v0.21.0`, not a floating “latest tag”.
- In CLI preparation only, load the trusted repository ref's standalone `prompt.ts` as a temporary `.mts` module; check required exports. Keep manifest construction pure over rendered inputs; its unit tests inject data rather than depending on Git refs. Fail actionably on missing refs or unsupported module imports. Do not fetch or execute arbitrary external candidate code. Candidate builders come from the current checkout.
- Render every prompt once during preparation. Save exact rendered inputs, source inputs, fixture expectations, preferences, prompt-module hashes, resolved shipped commit, and candidate checkout provenance. A dirty candidate is allowed and must be labeled dirty.
- Hash the actual input bytes. A Git SHA alone cannot identify a dirty candidate.
- Manifest v2 call identity includes track/feature, fixture/input hash, arm, explain mode when relevant, preferences hash, backend/model/effort, restricted access, effective timeout, prompt hash, and repeat index. Include execution implementation provenance in the approved bundle so a changed adapter requires renewed preparation/approval.
- Distinguish the builder prompt from the effective submitted instructions, including Grok's restricted prefix. Save both with hashes and record non-prompt execution arguments. Verify the effective payload against a fake CLI in offline adapter tests; do not double-prefix. Before execution, rehash the runner and backend files against approved provenance and refuse mismatches.
- Distinguish logical cell/repeat identity from execution attempt. A successor manifest names its parent fingerprint, carries content-hashed references to successful prior results, and explicitly lists which failed/unattempted calls may execute with new attempt IDs. Those IDs participate in the new approval fingerprint. Preserve all prior outcomes, disclose retry selection, and never silently choose the most favorable attempt.
- The manifest also fixes the judging plan: judge configuration (backend, model, effort, judge prompt template hash, response schema, normalization version), the qualification record it relies on, the frozen assertion set and per-output applicability, and the maximum judge call count (one per planned generation call). Judge inputs cannot be rendered before outputs exist, so approval covers the template and count; each rendered judge input is derived deterministically and saved. One approval fingerprint covers generation and judging. Judge qualification itself is a separate judge-only manifest through the same prepare/approve/run path.
- Hash the complete ordered manifest. Verify all referenced blobs and the fingerprint before any preflight or backend call.
- Keep independent rows for identical shipped/candidate prompts, but mark them explicitly as unchanged controls. They measure run variability, not a prompt change. Do not deduplicate repeats.
- Alternate shipped/candidate order across repeat blocks, deterministically and before approval, to reduce systematic order bias. Do not claim randomized experimental significance.

Results are namespaced by manifest fingerprint; reports read the saved manifest, not today's corpus or prompts. Include CLI version/environment metadata in run provenance. Backend/model/effort changes — for the generator or the judge — require a new approved matrix. Never silently substitute a model due to quota or availability.

## 3. Corpus, BTW, and preferences

Superseded in size and detail by the content specification (13 explain cases, six BTW cases, 180 generation calls per backend plus up to 180 judge calls). The original proposal follows for history.

Retain the eight existing explain fixtures; add:

- `dense-ai-reply`: an actual dense AI answer, not a newly written imitation. Use an owned or public answer with permission/licensing checked, record provenance and any redactions, and inspect it for sensitive content before committing. Selecting the exact source is an implementation prerequisite, not a reason to fabricate a “real” fixture.
- `jargon-dense`: undefined terms such as leader election and idempotent, with expected terms listed for reviewers. Keep operational literals/conditions explicit.
- `trailing-condition`: multiple actions whose conditions occur at sentence ends, including negation and exceptions. Give reviewers the expected action–condition relationships, not just a token list.

Add four initial BTW fixtures: jargon explanation, quick factual question grounded in context, conditional next-step question, and insufficient/untrusted context. Inputs are `{context?, question, expectations}`. Use `buildBtwPrompt(..., {full: false})`, one fresh conversation per call, no continuation/history. Native multi-turn behavior remains integration-test territory.

BTW expectations identify facts relevant to the question, not every literal in its context. Check forbidden canaries and applicable literals mechanically; correctness, unsupported claims, missing conditions, and claimed verification are case-specific yes/no assertions answered by the calibrated judge. Wording heuristics such as “I checked” cannot reliably prove false verification and must not be hard gates.

An optional fixed, tracked preferences text adds a second preferences arm across the selected modes/BTW cells. Use a preference with no language switch initially, so lexical comparisons remain interpretable. Never read the maintainer's personal preferences/settings. Compare preservation within each mode/arm; the measured adaptation is product-reader term explanation, and tone is not scored. Identical counts do not prove the preference had no effect.

For planning, 11 explain fixtures × 3 modes × 2 arms × 2 repeats = **132 calls per backend**. Four BTW fixtures × 2 arms × 2 repeats = **16**. The full initial modes+BTW comparison is **148 calls**; adding a paired preferences arm makes **296**. These are proposed sizes, not approval or a quota estimate. Tracks/backends may be approved separately; dry-run reports exact total, cached, and pending calls.

## 4. Reader-visible counts and automated judging

Add one pure, versioned counter function, used identically on source and output. Document an intentionally bounded Markdown approximation, not a full renderer or reading-grade score.

Initial deterministic definitions:

- Exclude fenced code bodies (backtick and tilde fences) from prose counts; preserve their separate exact-fence checks. Treat inline code as visible text, remove only its delimiters, and include it in word counts.
- Words: Unicode letter/number tokens, allowing internal apostrophes/hyphens. Include heading text and every ordered/unordered list item's text. Non-space-delimited languages are outside this heuristic's validity; label that limitation.
- Before prose counting, strip ordered/unordered list markers; count Markdown link labels but not destinations or reference definitions, a terminal-independent convention. Preserve the original text for evidence and semantic judging.
- Sentences: nonempty prose segments separated by `.`, `?`, or `!` followed by whitespace/end, plus a final unpunctuated segment within each paragraph/list item. Decimal points inside numbers do not split. Abbreviations and URLs remain known heuristic limitations.
- Em-dashes: literal `—` outside fenced code.
- Bold spans: paired `**...**` or `__...__` outside code, with escaped delimiters excluded. Document unsupported nested/HTML emphasis rather than claiming rendered accuracy.
- Headers: ATX and Setext Markdown heading lines outside code.
- Bullet lines: ordered and unordered Markdown list-item lines, including nested items, outside code. A multiline item counts once, not once per wrapped line.

Use fixed regex/line-scanning rules, not ICU-dependent `Intl.Segmenter`; check fixtures for CRLF, fences, escapes, bold/header/list syntax, decimals, and code resembling Markdown. Do not add a word/sentence cap. If a cap is later introduced it must include list text.

For explain, publish source count, output count, and signed delta for every metric. Formatting deltas are descriptive: balanced/faithful deliberately preserve formatting. Keep existing character-length diagnostics separate from word counts. BTW reports context/question counts separately and output counts; output-versus-context deltas, if shown, must be labeled input-size comparisons, never compression/preservation quality.

These counts are descriptive only: they never pass or fail an output and never enter a verdict. Report each sample and each cell's `n`, mean, minimum, and maximum. Compute candidate-minus-shipped differences within fixture/mode/preferences/backend strata. Report success/error/timeout/cancelled/missing totals; never count a failure as a zero-word successful answer. With two repeats, ranges are directional evidence, not confidence intervals. Do not pool unlike backends/modes or hide incomplete cells in a grand average.

### Automated binary judging

This replaces the earlier blind human rubric (clarity, fidelity, safety/preservation, mode adherence, and the issue's requested "terms defined (0–2)"). The full rules, case assertions and calibration protocol are in the content specification; the design-level contract is:

- Every scored criterion is a yes/no assertion compiled from frozen, source-grounded annotations. Required assertions (meaning, forbidden inferences, exact literals, format contract) reject an output on any failure. Compared assertions (answer first, terms explained, conditions attached) are compared between arms. Counts are descriptive.
- Code decides wherever a check is fully mechanical. One LLM judge call per successful output answers the remaining applicable assertions using only five predicate types. "Terms defined (0–2)" becomes `TERM_EXPLAINED` per frozen term plus required avoidance of consequential misconceptions.
- Applicability is fixed per case, mode and audience at preparation; the judge has no N/A. It sees the normalized output as untrusted data and the assertions, not the source, arm, mode, backend or other outputs.
- Responses are schema-validated. Positive evidence must be an exact span of the normalized output; absence verdicts cannot be span-checked and rely on calibration. `cannot_judge`, malformed or unsupported responses are evaluation errors, not a third quality value; the output is unevaluated and its cell incomplete.
- A judge configuration counts only after qualifying on a human-labeled calibration set with near misses and judge-injection items, three runs, no misses. Any change to the configuration requires requalification. Qualification is evidence about those cases, not a reliability guarantee.
- Comparison is per assertion per cell across repeats (fixed / regressed / unchanged / unstable) over fixed denominators. Any new required failure makes the cell worse and cannot be offset. No aggregate quality score or readability percentage. Identical-prompt control cells report variability separately, not as a pooled threshold. A candidate output with any required failure cannot earn a better label. Reports provide per-criterion test outcomes, not an aggregate adoption score.
- One judge model, explicitly selected, preferably from a different family than the generator; that is not proof of independence. No multi-judge voting, no silent judge substitution, no automatic judge retry. A deliberate re-judgment of stored outputs is a new approved judging attempt.

Humans author and review assertions and calibration items, adjudicate disputed or audited verdicts, and make the ship decision. A routine run needs none of that to produce its report.

## 5. Execution, safety, and #91 ownership

Reuse `backend.execute` for the selected feature with `access: restricted`, a fresh temporary directory, no continuation, and no retry wrapper. Map its outcomes into benchmark results and save each before proceeding. Do not use the advisor's retry helper. Keep Agy usage preflight Agy-specific and behind fingerprint approval; other backends must not silently invoke Agy or make a model call to probe quota.

Use the existing effective deadlines (currently 125 seconds explain/Show, 130 seconds restricted BTW), record them, and retain fast deadline overrides only for offline tests. Avoid adding production timeout configurability for this issue.

A fresh directory is context isolation, not an OS sandbox. Claude restricted calls disable tools; restrictions differ elsewhere, especially Grok's behavioral-only restriction. Expose these differences in approval metadata and results. Never promise all backends have identical tool isolation. Start the approved live evidence on explicitly selected available accounts; supporting other backend selections does not authorize using them.

#91 remains open. It owns the orchestration tests for approval rejection before any calls, successful cache skipping, and failure-without-retry. Land those first or coordinate a single shared implementation while changing the executor. Retain descendant-held-pipe timeout coverage when removing the duplicate Agy executor; exercise fake backend executables through guarded PATH. #101 owns repeat/backend/input fingerprint fields and evidence/report correctness, not a duplicate orchestration test suite.

One cache detail needs explicit resolution with #91: current `runMatrix` skips *any* saved outcome and can continue past a previously failed cell on resume. Recommended contract: successful records skip; a cached failure stops and requires a deliberate new approved attempt. Cancellation stops with a non-success exit, even if the active call never began. No automatic retries, fallback backend, or silent overwriting of failed evidence. A deliberate rerun uses a new run identity and approval while keeping old evidence.

#89 owns test relocation/consolidation, not #101. Keep the wording cleanup in existing files and preserve all unique safety assertions. No broad test reorganization.

## 6. Committed evidence and offline recomputation

Use `benchmark/.work/<fingerprint>/` for execution and judging. After the run (and the publication check below), publish a bounded bundle under `benchmark/results/<run-id>/`:

```text
manifest.json         # approved rows, provenance, judge configuration, assertion/metric versions
inputs.json           # exact sources, questions, preferences, prompts, frozen assertions and applicability
results.json          # one record per attempt: unchanged backend-returned text, outcome, timing
judgments.json        # rendered judge inputs, raw judge replies, validated per-assertion verdicts, evaluation errors
qualification.json    # the judge configuration's calibration set hash and qualification results
summary.json          # generated per-assertion transitions and counts
summary.md            # generated tables and bounded interpretation
```

A small run-scoped JSON collection is enough; no database or generic artifact framework. Here “raw output” means the exact reader-facing string returned by `backend.execute`, which already trims provider-final text. Store it unchanged; do not add provider-byte capture or protocol logging. Judge evidence uses exact substrings of this string without further normalization. Record the backend implementation provenance defining this boundary. Validate IDs/hashes, duplicates, missing/unexpected results, result/row consistency, one verdict per applicable assertion, evidence spans, and finite nonnegative timing values before reporting. Incomplete runs are allowed only as visibly incomplete reports with a nonzero exit, not completed comparisons.

Implement reporting/recomputation in a module that does not import live execution. `benchmark:recompute --check` reads only committed bundles, reads the unchanged backend-returned outputs, re-runs deterministic checks, re-validates stored judge replies (schema, assertion coverage, exact spans), recalculates every published table from the saved inputs/results/judgments, and exits nonzero on mismatch. This proves integrity and arithmetic: that the published report follows from the stored evidence. It does not re-ask the judge and does not prove any verdict is semantically right. It must not need Git history, current prompt builders, CLIs, credentials, or today's corpus. Store the frozen expectation data so historical checks do not drift when the corpus changes. Version metric, assertion and predicate behavior and retain old recomputation behavior when it changes, or explicitly republish a versioned recalculation.

Include one `benchmark/*.test.ts` check invoking the same verification function, so existing `npm test` and CI run it offline. Bootstrap it with a tiny clearly labeled fabricated-output and fabricated-judgment fixture, never presented as live evidence; the test must pass from a plain file copy with no Git repository. After approval, replace/add the real measured bundle. Keep old `initial-results.md` outside the new reproducibility claim and label its limitation plainly.

Review even synthetic-output bundles for leaked paths/account details: a model/CLI can emit sensitive data despite synthetic input. Exclude credentials, raw preflight output, and incidental stderr from public artifacts. If a raw result contains sensitive material, do not silently redact it while calling it raw; quarantine it and mark the public comparison incomplete, or obtain an approved safe rerun. The real dense fixture and its outputs also require an explicit publication check. Do not commit private session excerpts by default.

## 7. Implementation sequence and acceptance

1. **Test cleanup:** preserve existing local edits; classify mixed assertions; replace fake mode routing; document test principles. Verify prompt tests and M/R/preferences integration.
2. **Coordinate #91:** establish the runner safety seam/tests once, including cache-failure resume semantics. No ownership moves from #89.
3. **Offline evaluation core:** add counters, BTW/expanded explain fixtures, frozen assertion/applicability schema, deterministic checks, judge response validation, transition reporting, and deterministic recomputation tests.
4. **Runner/comparison:** add explicit shipped ref and prepared manifests, two repeats, fixed optional preferences, backend selections, and single-attempt execution through the existing boundary. Preserve Show behavior and history.
5. **Verification before live work:** run full `npm test`, modes/BTW/preferences dry-runs plus Show regression dry-run, and `benchmark:recompute --check`. Verify IDs differ for repeat/backend/preferences/prompt/judge-configuration changes and unchanged input produces stable manifests. Check that malformed/missing/tampered evidence, invalid judge records, absent spans and `cannot_judge` fail closed. No live calls in these checks.
6. **Judge qualification:** with content gates done, prepare and separately approve the judge-only qualification manifest; record the result. Unqualified required predicates block live comparison.
7. **Separate live approval checkpoint:** present exact rendered-input manifest, fingerprint, generator and judge models/backends/access limitations, total/pending generation and judge calls, and publication scope. Obtain explicit approval. Run only that matrix, stop on failure, judge automatically, produce the report, inspect artifacts for sensitivity, then commit only if committing is authorized.
8. **Final evidence:** report completion counts, per-assertion transitions and spread, deterministic findings, evaluation errors, qualification reference and limitations, and fresh offline recomputation. A better count or communication transition never overrides a required-assertion regression.

Expected implementation files: `prompt.test.ts`, the existing M-key test in `helpers.test.mjs`, `docs/TESTING.md`, benchmark corpus/runner/tests/README, a small BTW corpus, assertion records, calibration set, judge prompt template, and reporting module, `package.json` for the recompute command, and approved evidence bundles. Update related documentation/comments that currently say the benchmark always excludes preferences. Avoid changes to production prompt wording or backend protocol implementations unless a concrete integration need is demonstrated.

The exact public dense reply, the available generator backend/model, and the judge configuration for the first live matrix remain to be selected before preparation/approval. They do not block the offline design or test work. No prompt-quality improvement is claimed until that evidence exists.
