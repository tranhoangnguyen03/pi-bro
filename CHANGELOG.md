# Changelog

All notable changes to pi-bro are documented here.

## [Unreleased]

### Added

- Added `/bro show [turns]`: draw the last session turns, including tool results, as shapes — pseudocode, call trees, file trees, component trees, types and signatures, or diffs — instead of prose, in the same context-isolated modal. Defaults to the last 4 turns; a new `showTurns` setting (positive integer) changes the default and `/bro show <n>` overrides it for one run. Adapts the `show-me` plugin from humanlayer/skills (MIT; credited in `THIRD_PARTY_NOTICES.md`).
- Added an HTML escalation path for show: when a reply ends with one self-contained ` ```html ` fence, Bro writes it to `/tmp/pi-bro-<uid>/bro-show-<hash>.html` with a restrictive Content-Security-Policy, replaces it in the modal with a placeholder, and offers **O** to open it in the default browser. **C** still copies the complete reply including the fence, and **R** regenerates it.
- Added a separate `show` benchmark track (`--track show`): serialized-transcript fixtures graded by selection semantics — hardened identifier traceability (camelCase, snake_case, and SCREAMING_CASE tokens inside fences, diff-header stripping, backtick tokenization), fence-shape rules (balanced fences, html-last with no trailing prose, no bare or untagged mermaid, no external resources), and diff-marker validation. The corpus carries one fixture per show-me form; the modes benchmark keeps its frozen 32-row baseline and fingerprint.

### Changed

- Show capture and serialization: a turn is one user message plus every assistant message, tool call, and tool result after it; section headers are plain and every payload is JSON-quoted, matching the existing injection posture; tool results are trimmed to the first and last 2,000 characters with an elision marker; tool-call arguments are head-trimmed at 500 characters; thinking and image content become one-line placeholders; oldest turns are dropped whole when the serialized transcript exceeds 100,000 characters, and the source label reports the turns actually kept.
- `/bro show` reuses the captured transcript snapshot on **R** (like `/bro url`), feeds `/bro open` through the same remember path as the other source commands, and shows an in-modal empty state instead of an error when the session has no turns.
- Show bypasses explanation modes and `bro-prompt.md` entirely; it has its own built-in prompt. Modes, settings, and custom-prompt precedence are unchanged.
- Show output never wraps identifiers in Markdown links, and prose-only sessions degrade to a plain outline rather than a diff or a forced diagram.

### Development

- `docs/plans/2026-09-07-bro-show-visual-design.md` records the full design, the decision to separate show from the built-in modes after implementing it as a fourth mode, and the post-review hardening list. An earlier commit on this branch added `visual` as a mode and was superseded before release; no released version ever offered it.
- Smoke tests cover serialization, trimming, capture windows, the HTML contract (per-user directory, keep-one cleanup, CSP injection, CRLF tolerance), routing canaries, `showTurns` validation, and session/model-context leak checks for show output. Live validation: a 132 KB real session captured to a 76,210-character transcript (3 turns, 33 tool calls/results, 7 elided) produced a 3,065-character output; a prose-only session degraded to an outline.

## [0.9.3] - 2026-09-06

### Fixed

- Corrected the built-in help's brief-mode description, which still claimed a fixed word target removed in 0.9.1, and quoted the spaced-path example in the README. The 0.9.2 package on npm was packed before these doc fixes landed.

## [0.9.2] - 2026-09-06

### Changed

- Renamed `/bro simplify` to `/bro text`, matching the `/bro file` and `/bro url` input-source commands. Bare `/bro` (or `/bro text` with no text) still explains the latest completed assistant reply.
- Added context-aware routing: an unknown first word makes the whole input the source — a lone URL runs the webpage reader, an existing workspace file with a supported extension runs the document reader (including quoted paths with spaces), and anything else is explained as pasted text. Explicit subcommands are unchanged; inputs that used to fail as unknown actions are now explained as text, while `/bro open` and `/bro help` with extra words now warn instead of silently explaining the latest reply.

## [0.9.1] - 2026-08-24

### Changed

- Replaced the built-in mode prompts with the original audience-led brief prompt and Gemini-authored balanced and faithful prompts.
- Removed fixed word targets. Balanced trims repetition while preserving important context; faithful preserves every source detail and formatting choice.
- Kept a shared guard that rejects embedded source instructions and unsupported facts, advice, or conclusions.

## [0.9.0] - 2026-08-24

### Added

- Added persistent `/bro mode [brief|balanced|faithful]` selection.
- Added three built-in explanation modes:
  - `brief` focuses on the main point and next action.
  - `balanced` preserves material detail while improving clarity and is the default.
  - `faithful` stays closest to the source and has no fixed word limit.
- Added stronger preservation of source language, commands, URLs, paths, numbers, warnings, conditions, Markdown links, and fenced code.

### Changed

- Existing settings without `mode` now use `balanced` automatically.
- Built-in prompts now reject embedded source instructions, avoid preambles and unsupported inferences, replace clichés with their plain meaning, and avoid unnecessarily expanding already-clear text.
- The balanced mode's 400-word target may be exceeded when preserving important details requires it.

### Compatibility

- Existing valid `bro-prompt.md` files continue working unchanged.
- A custom prompt fully overrides built-in mode instructions. `/bro mode` still saves a selection, but it remains inactive until `bro-prompt.md` is removed or renamed.
- Bro still uses Agy and keeps explanations outside Pi's session and main-agent context.

### Development

- Added a manual, resumable 32-row Agy prompt benchmark with stable hashes, explicit fingerprint approval, process isolation, mechanical checks, and blind-review output.
- Adapted benchmark fixtures and checks from `speak-like-you-eat` under its MIT license.
- Final benchmark results and limitations are recorded in `benchmark/initial-results.md`.
