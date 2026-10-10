# Reader-visible benchmark using Jev

## Implemented contract (supersedes draft judge architecture)

`reader-corpus.ts`: 12 synthetic Explain cases and six synthetic conversation-only BTW cases. Existing eight Explain sources reused, four added from content spec. BTW contexts are concise synthetic fixtures, not claimed byte-identical to original long draft transcripts. Product-reader preference subset included; two independent generation/judge samples per cell. Italian gets deterministic checks only. Real dense reply E13 absent, explicitly unmeasured.

`reader.ts`: prepare fingerprinted manifest; generate using existing isolated Agy executor; judge saved outputs with pinned Jev; recompute offline report; compare two report directories. No new dependency, no Promptfoo in live process, no changes to product prompt. Shared historical pilot left intact.

Jev is used for source-specific binary application and short coverage questions, not bundled equivalence or the draft's five supposedly qualified predicate classes. Choice pass means Yes, not good; expected Yes/No stays in local manifest and code compares it. Ambiguous P06 stays in historical stretch tests, not the core corpus. New scenario probes are experimentally transferred from the paired design, not individually qualified. See JEV-PROFILE.md.

Per output: exact literals/fences/canaries in code; frozen question answers; descriptive words/characters/unchanged. Compared checks are separately tagged, and faithful excludes them. No word-count optimization gate. A candidate with a required mismatch is never labeled improved. Two repeats reveal disagreement as unstable, not noise averaged away. Reports contain local assertion text, applicable sets and expected answers. Raw responses remain in per-call `.judge.json` files for audit. Mechanical version 2 accepts a small frozen set of numeric spelling alternatives outside faithful mode; format checks are separately reported and compared, not silently discarded. API failures/missing artifacts are incomplete.

### Scope not claimed

No reader-comprehension/tone score, no blanket meaning-preservation guarantee, no exact-span evidence, no calibrated term-definition or condition-localization verdict. Small plain-language coverage questions tagged compared are experimental. Literal/format checks remain conservative, not proof of complete formatting fidelity. No real-dense-reply claim until an authorized E13 is supplied. No automatic shipping recommendation.

## Commands (Node with TypeScript stripping)

From isolated worktree root:

```
node --experimental-strip-types benchmark/reader.ts prepare benchmark/.work/reader-shipped shipped
# Prints generation/judge call counts and fingerprint. Preparation is offline.
node --experimental-strip-types benchmark/reader.ts generate benchmark/.work/reader-shipped FINGERPRINT
# Requires explicit generation authorization and configured Agy.
node --experimental-strip-types benchmark/reader.ts judge benchmark/.work/reader-shipped FINGERPRINT
# Requires TYPESAFE_API_KEY supplied via hidden terminal input, never chat/arguments.
node --experimental-strip-types benchmark/reader.ts report benchmark/.work/reader-shipped
node --experimental-strip-types benchmark/reader.ts compare benchmark/.work/reader-shipped benchmark/.work/reader-candidate
```

To compare a future prompt change: prepare shipped before changing prompt, prepare candidate afterward in a new directory. Both manifests snapshot exact prompts and judge applicability. Compare rejects different corpus/judge/applicability contracts. Existing artifact files are never reattempted automatically, including started/error records. On interruption inspect them; do not delete to trigger blind retries. Prepared directory must be new (exclusive manifest creation).

Never paste keys. With shell tracing off use hidden `read -rs` and unset the variable afterward. Judge uses fixed HTTPS endpoint, rejects redirects, times out, saves raw response with exact key redacted before parsing. This is code-level destination restriction, not OS isolation. No third-party dependency executes in this path.

## Approval and evidence

User authorized the baseline execution, now complete: 96 generation outputs and 90 Jev calls. See READER-BASELINE-RESULTS.md. Later corpus runs require their own prepared fingerprint. Each prepared fingerprint exposes exact call ceiling before execution. Previous no-budget-limit experiment permission is not represented as blanket permission to generate all future corpora. Existing production manifests/dependencies unchanged. Tests are offline, including manifest determinism, frozen cross-arm applicability, polarity, missing responses, mechanical failures and regression classification.
