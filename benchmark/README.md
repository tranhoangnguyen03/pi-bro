# Bro prompt benchmark

This benchmark compares Bro's frozen pre-mode prompt with the `brief`,
`balanced`, and `faithful` built-in prompts across eight synthetic fixtures.
It is maintainer tooling, not part of the npm package.

## Safety

The benchmark is manual and opt-in. `npm test` and CI never make live model
calls. A full new matrix can make up to 32 Agy calls using
`gemini-3.7-flash` at low effort and consumes account quota.

Before live execution, the runner:

- prints the exact manifest and its fingerprint;
- requires that fingerprint through `--approve`;
- shows current Agy usage;
- runs every call in a fresh temporary directory; and
- saves each result before starting the next call.

The runner does not retry failed or paid calls automatically. Re-running the
same manifest skips results whose stable call IDs already exist. Review the
saved failure before deleting any result and trying again.

## Run

First inspect the complete 32-row manifest without calling Agy:

```sh
npm run benchmark:dry-run
```

Copy the printed fingerprint only after checking the fixtures, variants, model,
effort, prompt hashes, and call IDs. Then run:

```sh
npm run benchmark:run -- --approve <fingerprint>
```

Press Ctrl-C to cancel the active call and stop the matrix. Completed results
remain available for a later resume.

Generate mechanical checks and a blind-review worksheet with:

```sh
npm run benchmark:report
```

Local results, the hidden candidate mapping, and review files live under
`benchmark/.work/`, which Git ignores. Do not commit raw outputs without first
checking them for sensitive data.

## Interpretation

Mechanical checks catch missing literals, code blocks, Markdown markers,
compliance-shaped injection output, preambles, and unexpected length changes.
They are review aids, not proof of semantic quality. A single matrix is
directional evidence for one model and effort; it does not validate every Agy
model.

The benchmark covers Bro's built-in prompts only. A user-provided
`bro-prompt.md` fully overrides built-in modes and is not evaluated here.

The bounded release decision and final measurements are in
[`initial-results.md`](initial-results.md). The corpus and several mechanical
checks are adapted from
[`wtfzambo/speak-like-you-eat`](https://github.com/wtfzambo/speak-like-you-eat)
under the MIT license recorded in `THIRD_PARTY_NOTICES.md`.

## Show track

The benchmark has a second, experimental track for the `/bro show` direction
(`docs/plans/2026-09-07-bro-show-visual-design.md`). It runs serialized
transcript fixtures through `SHOW_PROMPT` and grades selection semantics
(traceability of identifiers, fence shape, diff markers) rather than prose
preservation. The corpus carries one fixture per show-me form — call stack,
pseudocode, component tree, file layout, types and signatures, diff, HTML
layout, and prose degradation. Its manifest, fingerprint, and results are
independent of the modes matrix:

```sh
npm run benchmark:dry-run -- --track show
npm run benchmark:run -- --track show --approve <fingerprint>
npm run benchmark:report -- --track show
```

Show results live in `benchmark/.work/show/`.
