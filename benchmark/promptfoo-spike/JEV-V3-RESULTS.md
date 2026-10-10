# Jev v3 development comparison: FAIL, no changed decisions

Run: `benchmark/.work/jev-live-2026-10-10T11-25-21.097Z/`.
Baseline: `benchmark/.work/jev-live-2026-10-09T08-54-48.834Z/`.
Model: `jev-1.13.0`. V3 changed only reviewed retry question and pass/fail rubric; original twelve cases, labels, shared instructions, other questions and source unchanged.

All 36 requests complete. `node score.mjs` validated response schema/model/usage and full case/repeat coverage. Independently recomputed all payload hashes against current v3 renderer/dataset: all matched. Compared every decision against v2: no changes. All choices stable over three repeats.

| Measure | V2 | V3 |
| --- | --- | --- |
| Correct decisions | 105/108 | 105/108 |
| Retirement | 36/36 | 36/36 |
| Deletion | 36/36 | 36/36 |
| Retry | 33/36 | 33/36 |
| False acceptances | 3 | 3 |
| False rejections | 0 | 0 |
| P06 retry | Incorrect pass, 3/3 | Incorrect pass, 3/3 |

## Failure persisted, probability moved

P06 permits retry when the prior attempt is **not confirmed applied**, instead of requiring it to be **confirmed not applied**. Unknown outcomes therefore remain eligible for retry in the faulty guidance. The frozen expected answer is fail.

| Repeat | V2 P(pass) | V3 P(pass) | V3 API confidence |
| --- | --- | --- | --- |
| 1 | 0.91 | 0.68 | 0.36 |
| 2 | 0.87 | 0.60 | 0.20 |
| 3 | 0.87 | 0.70 | 0.40 |

The probability assigned to the wrong answer decreased, but the selected answer remained wrong in every repeat. This is not a passing result. Do not retrofit a confidence threshold after seeing the failure.

V3 reported 48,474 input tokens; estimated charge at published $0.042/M = $0.002035908, not an invoice. Combined v2/v3 estimated input charge: $0.003894912.

## Decision

Stop this Jev configuration's qualification under the previously stated bounded plan. Do not run the held-out stage or additional tuning automatically. Recommend investigating alternative binary judges using the same semantic contract. A future comparison should freeze the rubric, retain this development regression, and use separately labeled unseen cases before claiming generalization.

This result establishes failure of this model/configuration for this gate. It does not establish that all Jev architectures fail or explain the model's internal reasoning. Reviewed wording did not fix the decision in this bounded experiment.

No additional live calls, label changes or threshold changes were made during analysis. Promptfoo replay remains separate/not integrated into this live pilot; scoring is dependency-free and offline.
