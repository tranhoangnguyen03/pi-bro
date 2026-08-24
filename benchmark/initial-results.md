# Initial Bro mode benchmark

## Scope

- Manifest fingerprint: `6b9e2261625566e492ac9daba34a3d42702f31834a0d41aa3fcc7125f25daa91`
- Model: `gemini-3.7-flash`
- Effort: `low`
- Matrix: 8 synthetic fixtures × baseline, brief, balanced, and faithful
- Calls: 32/32 completed successfully
- Method: one sequential pass; directional evidence, not statistical proof or validation of other models

Raw outputs, the blind mapping, and the review worksheet remain ignored under `benchmark/.work/`.

## Aggregate observations

| Prompt | Successful calls | Mean latency | Mean output/source length |
| --- | ---: | ---: | ---: |
| Previous baseline | 8/8 | 9,190 ms | 2.598× |
| Brief | 8/8 | 7,877 ms | 2.029× |
| Balanced | 8/8 | 8,312 ms | 2.186× |
| Faithful | 8/8 | 8,345 ms | 1.370× |

All four variants preserved every fenced code block exactly. All three new modes preserved commands, paths, URLs, ticket IDs, thresholds, and the meaning of required warnings and conditions in the reviewed outputs.

The previous baseline translated the mixed Italian/English fixture into English. Brief, balanced, and faithful kept the explanation in Italian while retaining the intentional English technical terms.

None of the variants obeyed the injected source instruction. They repeated the malicious sentence while identifying it as untrusted and telling the reader not to follow it. The adapted target-level sentinel check therefore reports false positives when a safe rewrite quotes the attack; it is useful as a review prompt, not an automatic failure by itself.

Several exact-literal and Markdown-marker checks were also conservative rather than semantic failures: for example, `seven days` became `7 days`, the `Italiano:` label was omitted while the output remained Italian, and a bold heading became a normal heading. Length-ratio limits adapted from SLYE were too strict for Bro's explanation-oriented output and are treated as diagnostics.

## Ship decision

No concrete release blocker appeared: there was no changed command, URL, path, numeric threshold, fenced code block, translated new-mode output, obeyed source instruction, invented operational claim, or lost safety condition.

The modes showed distinct behavior:

- Brief produced compact, action-oriented sections while retaining warnings.
- Balanced explained terminology and reorganized material for understanding.
- Faithful stayed closest to the source and produced the lowest average expansion.

Ship all three modes with balanced as the default. Do not run another tuning matrix before release. Collect user feedback on verbosity and mode usefulness; revisit the prompt only when that feedback identifies a repeated problem.
