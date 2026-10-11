# Remaining scope delivery

Implemented after PR110 foundation:
- Removed prose/snapshot/menu ordering tests; kept safety/structure, including evidence-backed Show relationships and distinct guarded Explain modes.
- Fake Agy identifies mode against current builder outputs, not hardcoded phrases; includes all exercised preferences inputs.
- Deleted unused frozen prompt fixture; testing/development guidance updated.
- Surface counts and per-source deltas: words, characters, sentences, em-dashes, bold spans, ATX headings, bullet lines. Counts are report-only and include syntax as written.
- Committed synthetic baseline manifest/raw generation/raw judge data and summary. Offline recomputation verifies hashes, identities and summary; CI step added.
- Generation uses existing restricted Claude/Codex/Muse adapters, retaining Agy default. Grok deliberately excluded: existing adapter cannot enforce the advertised restriction. Backend/settings identity frozen and validated; legacy Agy manifests remain compatible. Invalid settings rejected before artifacts/calls.

Verification: final full npm test264/264 passed, including setup smoke and typecheck; offline96-output/282-decision recomputation passed; legacy benchmark dry-run passed. Claude reviewed tests; Codex reviewed benchmark. Findings fixed and verified locally; no further review rounds or live calls.

Limits: candidate prompt change/comparison run and real dense fixture remain approved deferrals. Binary term probes replace subjective0–2 criterion; coverage remains experimental. Tone, comprehension and Italian semantics unqualified. New backend live execution not qualified; fake-Claude execution covers success/error/timeout/active cancellation and existing adapter suites cover other protocols. Historical judge-study raw evidence remains local, outside CI reproduction.

Ready to update PR110 after user push approval. No merge authorization.
