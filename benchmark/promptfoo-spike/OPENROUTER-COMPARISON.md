# Decision-model comparison: no qualified winner

Latest run `benchmark/.work/openrouter-2026-10-10T16-57-49.260Z/`: five models, 180 requests complete. Independently rescored all results and recomputed both logical and transmitted payload hashes for every record; all matched. Reported identities match frozen catalog aliases/canonical slugs. Clef comes from first OR run; Jev from v3 direct API run. Same state/questions/labels; routing wrapper differs. No live requests during analysis.

| Model | Correct /108 | False acceptances | False rejections | Distinct failing criterion/cases | Median latency | Reported cost (36 requests) |
| --- | --- | --- | --- | --- | --- | --- |
| Microsoft Decision 1 | 106 | 2 | 0 | P06 retry (2/3) | 1.505s | $0.001526112 |
| PPLX Decider | 105 | 3 | 0 | P06 retry (3/3) | 1.063s | $0.000969840 |
| Liquid D1 | 105 | 3 | 0 | P06 retry (3/3) | 1.143s | $0.001787400 |
| Cloudflare Clef | 105 | 3 | 0 | P06 retry (3/3) | 1.160s | $0.010154880 |
| Jev v3 baseline | 105 | 3 | 0 | P06 retry (3/3) | not compared | $0.002035908 estimated |
| Drex 1.5 | 96 | 12 | 0 | P03/P06/P07/P11 retry | 1.340s | $0.001412880 |
| Solar Decide Flash | 96 | 12 | 0 | P04 retirement, P06/P07 retry, P08 deletion | 2.540s | $0.003750300 |

Clef Omni and GPT-6 Luna Decisions: repeated HTTP404; unscored, not semantic failures. Error bodies from prior runs were discarded; cause not established. Latest transport now preserves redacted bodies but no further probes performed.

## Key findings

Microsoft's apparent lead is not strong success: its sole correct P06 verdict had exactly 0.5 fail / 0.5 pass, confidence 0. The two incorrect verdicts assigned P(pass)=0.5621765009. It is the only latest-run model with unstable binary choices. Do not select it as qualified based on one tie.

All other models consistently misclassified P06. Liquid was particularly confident: P(pass) ~0.999739 twice and 0.992879 once. Confidence cannot be treated as accuracy.

Drex returned pass on every retry criterion, including all four negative retry cases. Its 96/108 headline hides zero detection of retry defects. P11 failure cannot uniquely be attributed to injection, because its injection-free counterpart P03 fails identically.

Solar missed AND-to-OR retirement, unknown/timeout retry errors, and contradictory deletion permission. These are broader failures than the common P06 failure.

No candidate meets unchanged 108/108 gate. Three repeats are correlated measurements, not 108 independent challenges. Latencies are serial observations, not randomized provider benchmarks; costs are response-reported except Jev calculated from token usage.

## Recommended next experiment, not executed

Do not lower labels/thresholds or pick a winner on this development corpus. Investigate whether bundled preservation judgments are the bottleneck with a controlled diagnostic:

1. Same underlying texts, focused binary application questions: for a matching checksum and unknown prior outcome, does the output's endorsed guidance permit retry? Label this separately from overall preservation. Do not remove difficult examples.
2. Separate the checksum requirement, positive confirmation requirement, timeout limitation and contradiction handling into atomic checks; combine deterministically. This aligns with initial bounded-predicate design and tests whether current three questions still bundle too many checks.
3. Pair known-valid, known-invalid and near-identical negation forms, including versions with unambiguous pronoun references. P06's “that confirmation” is ambiguous but both readings fail current contract; keep original as regression and add clearer variants rather than rewriting history.
4. Use a capable general-purpose structured-output judge as a control before deciding the task itself is too difficult. None has been tested here.
5. Only then freeze design and independently label unseen examples for finalists; do not confuse diagnostic development with general qualification.

Scope for the next experiment must be chosen and frozen before calls. User authorized experimentation without budget limit, but no specific additional model/control or multi-agent authoring plan has yet been selected. All current artifacts preserved; no automatic reruns launched.
