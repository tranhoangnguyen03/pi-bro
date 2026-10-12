# Paired diagnostic results: promising proxy, not qualification

Run `benchmark/.work/paired-2026-10-10T18-21-04.266Z/`. All 72 requests completed. Recomputed all logical and transmitted hashes using saved manifest; matched. Revalidated responses and rescored using manifest labels. No new inference calls during analysis.

| Model | Bundled labels | Probe extraction labels | Correct composite on 17 nonambiguous retry cases |
|---|---|---|---|
| Jev | 51/54 | 123/124 | 17/17 |
| Microsoft | 53/54 | 123/124 | 16/17 |

Composite counts derive from retry source-vector matching against frozen retry labels for nonambiguous cases, not full bundle semantics. Retirement/deletion anchors correct throughout. Two P06 probe cells excluded before execution; original P06 bundled label remains unchanged. Different denominators/constructs must not be treated as directly comparable accuracy percentages.

## Focal outcomes

Both models still falsely accept original P06 under bundled question. Both correctly reject clarified C06 under bundled question. Changing only the pronoun sentence therefore changes both bundled answers in this sample. This supports revisiting item wording; it does not prove a specific cognitive cause.

Both models answer Yes to original P06 unknown-outcome permission probe, so the smaller question surfaces the permissive reading. This cell was predeclared ambiguous, so it is not newly counted as an accuracy success.

Jev probe error: N03 valid scenario. N03 says prior attempt must be confirmed APPLIED. In the probe it is confirmed NOT applied, but Jev says retry allowed. The separate known-applied probe correctly identifies that N03 permits retry after confirmed application, so the aggregate still detects the defective instruction. This is measured redundancy helping in one case, not proof of reliable ensembling.

Microsoft probe error: C06 unknown scenario. It wrongly says retry is blocked (P(No)=0.92414), causing all five answers to match source and falsely accepting clarified faulty guidance. Microsoft bundled correctly rejected C06, so decomposition is not uniformly beneficial.

Jev bundled additionally falsely accepts N01 never-retry and N03 applied-inversion. Microsoft rejects both (N01 at probability tie), apart from original P06 bundled failure.

## Interpretation

Jev is the more promising composite on this development run despite tied extraction scores. Its sole extraction error is caught by another dimension; Microsoft's sole extraction error hides the target defect. All 17 nonambiguous Jev retry composite decisions match frozen labels. No model made an R/D regression. Do not qualify Jev yet: one repeat, selected development cases, lead-authored component labels, simplified permission convention and known unsampled semantic gaps.

C06 Jev unknown Yes probability only 0.58, so stability is unestablished. No threshold change, relabeling or model selection claimed from probabilities. Keep original records and ambiguous cells visible.

## Recommended bounded follow-up

One confirmation run of the frozen focal pairs/controls (especially C06 and N03), then independently labeled unseen cases balanced across probe outcomes. Use composite false acceptance/rejection and per-probe extraction errors, not just 123/124. Do not further rewrite rubric based on this run. Keep original v3 benchmark and P06 stretch results alongside new narrower measure. Additional live calls not executed here.
