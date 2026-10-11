# PR: Add a reader-visible benchmark with bounded Jev checks

## Summary
- Add 12 synthetic Explain and 6 BTW cases, two repeats and a product-reader subset.
- Freeze prompts, applicability, source answers, models and request identity in manifests.
- Generate through existing isolated executor; capture Jev judgments; reproduce reports offline and compare per criterion.
- Separate literal/command checks, formatting, experimental semantic proxies and descriptive counts.
- Document Jev capability limits and completed baseline, including likely false-positive and missing-coverage findings.

## Verification
- Full npm test:269 passed,0 failed, plus setup smoke check.
- TypeScript no-emit check passed.
- Saved baseline re-evaluated96/96 with generation identities and output/request hashes verified.
- Mechanical v2:0 required mechanical mismatches,2 format deviations;2 original Jev mismatches retained.
- One independent Claude/Codex review completed; identity/manifest execution, stop-on-invalid, interruption, format comparison, repeat validation and command-order findings addressed locally.

## Limits
Not proof of comprehension or full fidelity. Synthetic only; real dense reply follow-up. Italian semantic evaluation absent. New probes experimental. No automatic adoption decision. No product prompt change. Raw session artifacts and experimental tooling dependencies remain local and excluded from this PR; committed reports summarize evidence.

## Follow-up
Add authorized real fixture and independently labeled calibration if needed. Consider production prompt changes only in separate comparison. No further model sweep.
