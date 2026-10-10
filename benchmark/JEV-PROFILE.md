# Jev capability profile and benchmark policy

Pinned judge: jev-1.13.0. Evidence remains in promptfoo-spike/ reports and ignored raw run directories. This is empirical development evidence, not broad qualification.

## Demonstrated strengths

- Concrete scenario permission questions, paired with a positive eligible scenario and multiple negative boundaries, were useful in the paired run.
- Combined retry proxy correctly distinguished 17/17 nonambiguous development outputs in one run. Individual extraction 123/124. One misread was caught by another check, showing the benefit of checking multiple boundaries in that example.
- Retirement/deletion anchors, explicit omissions, rejected quotations and the tested injection variants were handled correctly in the paired run.
- Fast, low-cost typed Choice API. No prose parser or evidence-span extraction needed. Binary answers can be compared with frozen expected source behavior in code.

## Demonstrated weaknesses

- Bundled preservation: 105/108 in both original and clarified-rubric runs, consistently missing original P06 negation scope.
- Paired bundled run falsely accepted never-retry and retry-after-confirmed-application as well as original P06 (51/54).
- Paired probes misread one N03 eligibility scenario, despite correct composite result. C06 unknown-outcome answer was only 0.58 Yes; stability is unknown.
- Confidence is not accuracy. Original wrong P06 answers had high pass probability. No fitted thresholds.
- Pronoun ambiguity and necessary-versus-sufficient interpretation complicate the benchmark itself; shared model failure does not prove labels or judge wrong in every formulation.

## What we will build around

Small source-specific questions; positive and negative operational controls; fixed interpretation of complete prerequisites; expected vectors outside inference; explicit warning coverage; deterministic literals/fences/canaries; separate descriptive and experimental communication checks. Missing API evidence is incomplete, not a semantic fail. Mismatches can be rewrite errors OR judge errors.

Do not use Jev as a general proof of equivalence, readability, user comprehension, tone, or safety. No exact evidence-span contract: Choice does not supply it. Keep original P06 as stretch evidence, not core benchmark gate. Never rewrite historical labels/results to improve scores.

## Known gaps

Unsampled conditions (unchecked checksum, weaker evidence, new exceptions), complex negation, Italian, long-context composition, definition quality, localization and first-sentence meaning are not qualified. New corpus probes reuse a promising pattern but are experimental until evaluated; mark reports accordingly. One repeat and hand-selected cases provide no population error bound. Representative real dense AI reply remains absent. Do not claim that gap is filled by synthetic data.

## Selection

User chose Jev as the baseline judge after the comparison. Stop model-selection experiments. The shipped benchmark reports narrow measured profiles, not a universal pass/fail quality score or automatic adoption verdict. Existing alternatives/results remain available for auditing.
