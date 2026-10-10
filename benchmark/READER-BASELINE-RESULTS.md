# Reader baseline — first completed run

Artifacts: `benchmark/.work/reader-shipped/`. Offline report recomputed: 96/96 outputs complete, 90 judge calls, 282 binary decisions, two Jev mismatches. No new model calls during analysis. Reader report verifies saved output/request hashes before evaluation. 76,685 reported judge input tokens; estimated Jev charge $0.00322077, not invoice or generation cost.

## Interpretation

Do NOT call 280/282 a general correctness score: mostly positive, selected source-specific checks, unqualified transferred questions, no comprehension/semantic completeness claim. This is a baseline, no candidate arm exists.

Jev flags:
1. jargon-dense/balanced/default/repeat1 `term`: output says “Reads may still be stale” without ordinary-language explanation of stale. This is a plausible missing explanation on an experimental Compared check. Other repeat passes: unstable, not a stable defect across that cell.
2. B05/btw/product/repeat2 `implemented`: Jev says the answer claims an implementation has been chosen. Manual inspection finds a recommendation (“Recommendation: In-process cache”), not an explicit completed choice/implementation. Likely judge false positive / recommendation-vs-decision ambiguity, not confirmed generation defect. Keep raw label unchanged and record adjudication separately.

Manual inspection also found coverage gaps in that B05 answer: it adds high-memory-use as a deciding condition not present in context, and implies workers updating seconds apart stay within the 60-second window without a measured bound. Current questions do not check those additions. Their absence from flags is NOT proof of preservation. Do not tune labels after seeing this output.

## Deterministic flags: 13 outputs

- clear-control brief x2 and balanced repeat2: missing literal “seven days,” replaced with “seven full days” or “7 days.” Meaning appears retained; overly rigid spelling check in brief/balanced.
- long-document brief x2 and balanced x2: “7 days”; one balanced uses “30 min”/“60 min.” Numeric wording variants, not demonstrated lost timing rules.
- mixed-language brief x2/balanced x2: dropped heading-like “Italiano” token, while text remains visibly Italian. Language quality not judged; literal omission is not evidence of language failure.
- markdown-code brief x2: code fence nested/indented inside list; shell command text retained. Violates frozen byte-identical fence requirement, not demonstrated command corruption. Report contract-format deviation separately from functional harm.

Thus 11 of 13 flagged outputs are apparent literal-check false alarms for meaning; two are exact-format deviations. Do not silently erase frozen checks or rewrite existing report. Revise future mechanical applicability/version if authorized, recompute from saved generation without paid calls, and preserve old results.

## Descriptive behavior

Mean words: brief121.0 (28 outputs), balanced82.2 (28), faithful90.1 (24), BTW72.4 (16). Brief/balanced have same case/preference cells, so their contrast is useful descriptively: brief often expands into step-by-step lists and adds a “Here is...” preamble. No word-count gate; fewer words does not prove clearer. Faithful has different applicability/case mix, so not a matched mean comparison.

## Committed reproducibility

The synthetic manifest and all generation/judge records now ship in `benchmark/evidence/reader-shipped/`. `node benchmark/recompute-reader.ts` validates and reproduces the committed summary offline (also run by CI). This covers the current 96-output reader baseline, its 282 decisions, mismatch counts, word means and input-token total. Earlier judge-development experiments remain historical summaries with raw artifacts local; no claim of CI reproduction for those experiments. Original v1 report remains local; current v2 evidence is the published scoring contract.

## Mechanical v2 offline rescore

Completed without new paid calls. Original report preserved locally as `report-v1.json`; current `report.json` records mechanicalVersion 2. All 96 rows still complete. Required mechanical flags: **0**, compared with 13 affected outputs under v1's mixed literal/fence rules. Format deviations: **2** (indented fences); commands remain intact and ordered. Jev mismatches: unchanged at **2**.

Permitted numeric variants are a frozen short list only in brief/balanced; faithful still requires original literals. The language-heading token is not required outside faithful. Format transitions remain visible in cross-arm comparison, separate from command-content checks. This is a scoring-contract revision, not a prompt improvement.

## Next steps

Literal applicability and separate format reporting are now corrected, with historical baseline retained. Add recommendation-vs-implementation calibration and explicit coverage for unsupported additions in future versions; neither currently qualified. Keep human annotations alongside raw Jev decisions. No new paid run is needed to inspect or re-score deterministic checks. No production prompt changes made.
