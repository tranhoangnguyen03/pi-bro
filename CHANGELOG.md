# Changelog

All notable changes to pi-bro are documented here.

## [0.9.2] - 2026-09-06

### Changed

- Renamed `/bro simplify` to `/bro text`, matching the `/bro file` and `/bro url` input-source commands. Bare `/bro` (or `/bro text` with no text) still explains the latest completed assistant reply.
- Added context-aware routing: an unknown first word makes the whole input the source — a lone URL runs the webpage reader, an existing workspace file with a supported extension runs the document reader, and anything else is explained as pasted text. Explicit subcommands are unchanged; inputs that used to fail as unknown actions are now explained as text.

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
