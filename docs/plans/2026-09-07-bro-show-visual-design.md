# Bro Show / Visual Mode Design

## Goal

Add `/bro show`: capture the recent session transcript, including tool results,
and return a shape — pseudocode, call tree, file tree, component tree, diff, or
outline — instead of prose, in the existing modal, without weakening context
isolation. Add `visual` as a fourth built-in mode. Adapted from
`humanlayer/skills` `show-me` (MIT; credit in `THIRD_PARTY_NOTICES.md`).

## Lessons taken from show-me

Ported into this design:

- **Smallest view that makes the point.** Minimality is the first rule of the
  visual prompt, before any form choice.
- **Form ↔ topic menu.** Each form is paired with when to use it: pseudocode
  for logic, call tree for runtime control flow, component tree for UI
  structure, file tree for responsibility or broad refactors, diff when the
  point is what changes and the surrounding shape exists.
- **Diff sub-shapes matched to topic.** Component diff, file-layout diff,
  call-tree diff, state diff — the diff grammar mirrors the topic.
- **Whole block vs diff.** Show the whole block when most of it is new, when
  omitted context would hide ownership or order, or when the user needs a
  copyable target shape.
- **HTML is an escalation tier**, not a peer: only for layout, state
  comparison, or concepts too dense for text. One focused file, real labels
  and real data, desktop and mobile.
- **Visuals sit next to short supporting prose**, one line of framing each,
  not alone and not as an essay.
- **Scope discipline.** Keep only the calls, files, states, and boundaries
  needed for the current point. One or a few forms; never all of them.
- **Zero preamble.** Already Bro's rule in every mode.

Deliberately not ported:

- `Bash(open file.html)` — the sandboxed model cannot write or open files;
  Bro extracts the HTML and opens it itself.
- Mermaid in the chat surface — unreadable in a terminal; HTML path only.
- "Match the product's colors" — Bro has no product surface to match.
- Agent-side auto-trigger — Bro runs only when typed.

## Capture

A **turn** is one user message plus every assistant message, tool call, and
tool result after it, up to the next user message.

- `/bro show` captures the last **10 turns** by default.
- New setting `showTurns` (positive integer) overrides the default. Invalid
  explicit values are errors, matching the existing settings policy; missing
  values use the default. Surfaced in `/bro help`, `/bro doctor`, README.
- Compaction and branch-summary entries are skipped; the walk uses
  `sessionManager.getBranch()` exactly as `latestAssistant` does today. No new
  Pi APIs. The sandbox and the empty-workspace promise are unchanged.

## Trimming (v1: one simple rule)

- **Tool results:** keep the first 2,000 and last 2,000 characters; replace the
  middle with `[… elided N chars …]`. One rule for every tool.
- **Tool call arguments:** kept whole up to 500 characters, then head-elided.
- **User and assistant text:** kept whole.
- **Thinking blocks and image content:** dropped, replaced by a one-line
  placeholder.
- **Overall budget:** reuse `MAX_TEXT_LENGTH` (100,000). If the serialized
  window exceeds it, drop the oldest turn and re-serialize until it fits.

Improvement avenues (noted, not built): type-aware trimming (whole diffs,
tail-only for errors), per-tool caps, deduplicating repeated file reads and
identical results, call→result pairing by id, token-based budgeting.

## Serialization (v1: plain structure, quoted payloads)

Linear, oldest → newest, one block per entry:

```text
## user
"<JSON string>"

## tool call: bash
"<JSON string>"

## tool result: read
"<JSON string, trimmed>"
```

The structure is plain so the model reads it cheaply; every payload is
`JSON.stringify`-quoted, so the prompt-injection posture is byte-identical to
today's source quoting. Improvement avenues: pairing call and result into one
section by tool-call id, collapsing repeats, structural exit-code fields.

## Visual prompt

One entry in `MODE_PROMPTS` (`prompt.ts`), reusing the audience prompt and
`SOURCE_GUARD`, plus:

- The show-me form menu (ported, with its diff sub-shapes), adapted to
  terminal-first output: pseudocode, call tree, file tree, component tree,
  diff, or a short whole block in the reply body.
- **Traceability:** every path, function, command, flag, and number in the
  output must appear verbatim in the source. Never invent or complete a name
  from world knowledge.
- **Degradation:** if the source has no code structure (article, document,
  paste), produce a plain outline or say so. Never force a diagram.
- Mermaid and spatial layouts only inside the single HTML fence; never as bare
  mermaid source in the reply body.
- Smallest view that makes the point; one or a few shapes with one framing
  line each; zero preamble; keep the source language.

## HTML contract

- At most one top-level ```` ```html ```` fence, and only as the **last**
  block of the reply. Terminal-renderable shapes come before it.
- Bro extracts the fence, writes `/tmp/bro-show-<slug>.html` (`<slug>` = short
  content hash), deletes any previous `bro-show-*.html` first (keep-one), and
  shows **O** — open diagram — in the modal footer. `O` runs `open` (macOS) or
  `xdg-open` (Linux). `R` regenerates and overwrites.
- The HTML must be self-contained: no network, no CDN, hand-rolled CSS/SVG
  diagrams, real labels from the source, desktop and mobile viewports.
- Improvement avenue: a bundled local Mermaid runtime; user-configurable
  output directory.

## Command and mode semantics

- `show` joins `COMMANDS` (which feeds autocomplete and `KNOWN_ACTIONS`), so
  routing never swallows it as pasted text.
- `/bro show` forces `visual` for that invocation only; it does not persist the
  mode. `/bro mode visual` persists and applies to `text`/`file`/`url`
  sources, subject to the degradation rule.
- `/bro show <n-turns>` optionally overrides the turn count for one run (positive
  integer). No other arguments.
- Settings file gains `"showTurns": 10`; no mode is added.

## Doctor and smoke tests

- Doctor validates `showTurn` settings (positive integer when present) and the
  prompt file as today. No new provider checks: transcript capture needs no
  Agy support.
- Smoke-test canaries: `/bro show` is never routed to text/file/url; pasted
  prose still routes to text; existing routes and actions unchanged; `/bro
  show` output never appears in the session; the HTML write and keep-one
  cleanup; the **O** key path.

## Benchmark additions

- New fixture type: serialized transcripts (with tool results) drawn from
  show-me-style domains — a UI feature, a refactor, a debugging exchange —
  each with expected identifiers and forms.
- Mechanical checks for visual rows: **traceability** (every path-like or
  backticked identifier in the output appears in the input), balanced fences,
  at most one `html` fence and only as the last block, diff blocks contain
  `+`/`-`/context lines, no preamble, source language preserved, no bare
  mermaid outside the HTML fence.
- Blind review adds: smallest-view, correct form choice, accuracy against the
  transcript.
- Same fast release gate as the modes work: block on invented identifiers,
  broken fences, terminal mermaid, or obeyed source instructions. One
  correction pass; if `visual` still fails, omit the mode rather than tune
  indefinitely.

## Out of scope (parked)

Agentic repo reading (breaking the empty-sandbox promise), per-mode effort,
mermaid rendering in the terminal, auto-trigger, session-file writes or
history, `/bro session` as a user-facing prose-summary command.

## Structure

- `prompt.ts`: `visual` mode, prompt construction, validation.
- `bro.ts`: `show` command, turn capture, serialization, trimming, settings,
  HTML extraction/write/cleanup, **O** key.
- `smoke-test.sh` + Node tests: canaries, capture window, trimming, HTML
  contract, isolation.
- `benchmark/corpus.ts`, `benchmark/run.ts`: visual rows and checks.
- `THIRD_PARTY_NOTICES.md`: humanlayer/skills MIT notice.
- `README.md`, `/bro help`, `CHANGELOG.md`: source table row (`show`), mode
  row (`visual`), routing note unchanged, settings example with `showTurns`.

No new dependencies.

## Separation decision (2026-09-07)

After implementing `visual` as a fourth mode and live-testing plus a two-agent
review, `show` is **no longer a mode**. The mode axis was wrong for it:

- Prose modes echo transcript serializations instead of explaining them.
- `visual` on prose sources only ever degrades defensively.
- The shared simpleton persona fights precise technical shapes.
- Preservation-style expectations (requiredLiterals) punish the smallest-view
  selection that show-me demands — the benchmark contradicted the prompt.

`BRO_MODES` stays `brief | balanced | faithful`. The show prompt lives beside
them as `SHOW_PROMPT` / `buildShowPrompt` (own voice, own guard), and the
benchmark gains a separate `show` track (`--track show`, own corpus, own
fingerprint) with selection-semantics checks: hardened traceability (bare
camelCase/snake_case/SCREAMING_CASE identifiers inside fences, diff-header
stripping, backtick tokenization), fence rules (balanced fences, html-last, no
trailing prose, self-contained, no bare or untagged mermaid), and diff marker
validation. The modes benchmark returns to its frozen 32-row baseline, so its
fingerprints stay comparable across releases.

`/bro mode visual` is dead. If the experiment proves out, promotion to a mode
is a later, deliberate decision.

## Hardening after review (2026-09-07)

Post-implementation review fixes: show HTML artifacts moved to a per-uid
directory (`/tmp/pi-bro-<uid>/bro-show-<slug>.html`) so keep-one cleanup never
touches other users' files in a shared /tmp; written HTML gains a meta CSP
(`default-src 'none'`) as defense in depth against model-authored external
references; the fence regexes tolerate CRLF and trailing whitespace; the O key
surfaces open failures and supports Windows (`cmd /c start`); tool names in
section headers are control-character-stripped so a hostile MCP tool name
cannot forge transcript structure; assistant messages with string content are
tolerated; the capture label counts turns actually kept after budget drops;
`/bro show` now feeds `/bro open` via the shared remember callback; the
degradation rule tells the model to head the outline with the topic, not
"Summary".

## Form coverage (2026-09-07)

SHOW_PROMPT gained the types-and-signatures form from the show-me announcement post (it was absent from the skill file). SHOW_CORPUS now carries one serialized-transcript fixture per form — call stack, pseudocode, component tree, file layout, types and signatures, diff, HTML layout, and prose degradation — seeded from the canonical examples in the skill and the blog (MIT). Markdown autolinks are banned in output, and prose-only sessions must degrade to a plain outline (no fenced block, no diff).
