# Changelog

All notable changes to pi-bro are documented here.

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
