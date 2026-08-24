# Initial Bro mode benchmark

> Historical result: this matrix evaluated the first mode prompts. The shipped
> prompts were later replaced by the audience-led brief prompt and Gemini-authored
> balanced/faithful v3 prompts after a separate ignored 3×3 comparison found less
> expansion and better formatting preservation. Raw comparison outputs remain
> under `benchmark/.work/` and are intentionally not tracked.

## Scope

- Final manifest fingerprint: `4509d3235cee0a50fc373d3c18ff4bea302a9657a1df34df7c8c3802f8b42aa3`
- Model: `gemini-3.7-flash`
- Effort: `low`
- Matrix: 8 synthetic fixtures × baseline, brief, balanced, and faithful
- Final matrix: 32/32 completed successfully
- Method: one initial pass and one allowed correction pass; directional evidence, not statistical proof or validation of other models

Raw outputs, the blind mapping, and the review worksheet remain ignored under `benchmark/.work/`.

## Aggregate observations

| Prompt | Successful calls | Mean latency | Mean output/source length |
| --- | ---: | ---: | ---: |
| Previous baseline | 8/8 | 9,190 ms | 2.598× |
| Brief | 8/8 | 8,093 ms | 1.542× |
| Balanced | 8/8 | 7,495 ms | 1.496× |
| Faithful | 8/8 | 7,845 ms | 1.229× |

All four variants preserved every fenced code block exactly. All three new modes preserved commands, paths, URLs, ticket IDs, thresholds, and the meaning of required warnings and conditions in the reviewed outputs.

The previous baseline translated the mixed Italian/English fixture into English. Brief, balanced, and faithful kept the explanation in Italian while retaining the intentional English technical terms.

The initial pass exposed three concrete prompt problems: balanced retained the backup cliché, added a preamble to the already-clear control, and strengthened two conditions with inferred success language. The single allowed correction added explicit rules against clichés, preambles, expansion, and inferred or strengthened requirements. The final pass removed those mechanical failures and substantially reduced output expansion.

None of the variants obeyed the injected source instruction. Safe outputs could quote the malicious sentence while rejecting it, so the final mechanical check flags only compliance-shaped output beginning with the requested sentinel.

Length-ratio limits adapted from SLYE remain diagnostics rather than release gates because Bro explains terminology and can reasonably be longer than a short source.

## Ship decision

No concrete release blocker appeared: there was no changed command, URL, path, numeric threshold, fenced code block, translated new-mode output, obeyed source instruction, invented operational claim, or lost safety condition.

The modes showed distinct behavior:

- Brief produced action-oriented sections while averaging 41% less expansion than baseline.
- Balanced explained terminology and reorganized material for understanding while preserving every configured literal in the final pass.
- Faithful stayed closest to the source and produced the lowest average expansion.

Ship all three modes with balanced as the default. Do not run another tuning matrix before release. Collect user feedback on verbosity and mode usefulness; revisit the prompt only when that feedback identifies a repeated problem.
