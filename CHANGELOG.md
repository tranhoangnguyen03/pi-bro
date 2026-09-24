# Changelog

All notable changes to pi-bro are documented here.

## [0.18.0] - 2026-09-24

### Added

- `/mode` inside `/bro btw` toggles conversation-only / full permission without losing the conversation (#62). Threads start conversation-only, and reopening (including `--fresh`) keeps the current mode. The header shows a simple `conversation-only` / `full permission` badge next to the model and effort.
- Claude Code BTW with native multi-turn continuation in both modes (#58): turns run in the workspace with session persistence and `--resume`. Conversation-only turns disable tools, and full permission turns bypass permissions.
- Across a `/mode` switch, Claude and Grok resume the same native session. Agy conversations stay bound to their original workspace, so Agy starts a fresh native session seeded with the main-session context and every earlier turn. The same reseed also covers any thread that has turns but no native session ID.

### Removed

- The `/bro btw --full` and `--sandbox` flags. Both are now rejected with a hint to use `/mode`, and nothing is sent to the model. `--fresh` is unchanged.

## [0.17.0] - 2026-09-24

### Added

- Grok Build execution for explain, show, native multi-turn BTW (both modes), and advisor, with per-capability model/effort configuration, custom model IDs, and installation diagnostics. Agy remains the default.
- Capability-first Grok access: conversation-only intent uses prompt instructions when enforcement is unavailable, with truthful UI/docs rather than feature bans or speculative tool blacklists. Native tools remain available.
- Private temporary prompt files, backend-bound continuation, authoritative terminal completion checks and bounded cancellation. Backend/access changes start a fresh BTW thread instead of reusing incompatible native session IDs.
- Explain, show, and BTW modal headers show the model and reasoning effort each request used (`default` when the model's own effort applies); `/bro open` keeps the original label.

### Changed

- The BTW header no longer shows a sandbox/conversation-only access label; the `full · edits repo` badge still marks `--full` threads.

### Removed

- `/bro usage` is removed for now. Doctor still checks Agy account access.

## [0.16.0] - 2026-09-24

### Added

- Claude Code execution for explain, show and advisor, selected independently per capability through `/bro config`. Explain/show disable tools and customizations; advisor runs fresh with workspace tools. Claude-backed BTW is explicitly unsupported in this release.
- Backend-tagged model/effort selections with atomic per-capability overrides. Existing settings remain Agy selections and are migrated to version 2 only when saved; Agy remains the default.

## [0.15.1] - 2026-09-22

### Changed

- Explain, show, BTW and advisor now share an internal Agy execution boundary. Agy remains the only backend; existing settings, prompts, access modes, continuation and advisor retries are unchanged.

### Fixed

- Cancellation, host deadlines and malformed execution streams use bounded subprocess cleanup, with POSIX process-group termination and escalation. Unexpected signal exits are reported as failures rather than mislabeled timeouts. Windows cleanup remains limited to the direct child.
- Offline RPC smoke checks wait for command acknowledgements instead of relying on fixed delays to prevent overlapping requests and premature shutdown.

## [0.15.0] - 2026-09-22

### Changed

- In the `/bro btw` modal, `/copy` and `/copy-all` now copy the latest answer or the full thread to the **system clipboard** instead of the main editor. New `/insert` and `/insert-all` commands (with `/insert!`/`/insert-all!` force variants to replace an existing main-editor draft) insert into the main editor without submitting. Removed the legacy `/send` aliases and the spaced `/copy all`/`/insert all` spellings.

## [0.14.0] - 2026-09-20

### Added

- `bro_advisor` — a tool the **executor agent** (not the human) can voluntarily call mid-task for a second opinion from a fresh, standalone Agy process with real, unsandboxed tool access in the workspace (`--dangerously-skip-permissions`). Bro automatically captures a harness-neutral snapshot of the executor's system instructions, active tools, and conversation so far (including tool calls and results) and sends it, plus an optional executor-supplied question, to the advisor. The advisor is instructed to investigate before advising and to leave edits to the executor, but that boundary is behavioral, not enforced. Invocation failures retry twice (5s, then 10s) with the identical snapshot before surfacing Agy's own diagnostic.
- `/bro advisor-steer` — an editor for one persistent, session-scoped steering brief the advisor always reads (e.g. "quick prototype; keep A and B careful, everything else minimal"). The brief is stored as session-only extension data, is never added to Pi's conversation or sent to the main model, persists across resume/reload, and is inherited by forks.
- `/bro advisor` — a quick notice of whether `bro_advisor` is currently exposed and active, pointing at `/bro config`, `/bro advisor-steer`, and `/bro doctor`. `/bro doctor` carries the full diagnostic, including the Agy 1.1.15+ compatibility check.
- `/bro config` — a production settings screen replacing the earlier configuration-only spike: a shared default model/effort (still owned by `/bro model`/`/bro effort`) plus optional per-capability overrides for `explain`, `show`, `btw`, and `advisor`. An override always pins both model and effort together and is only ever cleared by an explicit "Default" selection. Saves are serialized and coalesced, with in-place revert and an inline error notice on failure.

### Changed

- Requires Earendil Pi `>=0.84.2 <1` and `agy >=1.1.15` (up from `>=0.78.1 <1` and `>=1.1.11`).

## [0.13.2] - 2026-09-19

### Changed

- In the `/bro btw` modal, your questions now render as a quoted **You** block and answers carry an explicit **Bro** label, with a horizontal rule between turns. The old `## you` heading was indistinguishable from headings inside Bro's answers.

## [0.13.1] - 2026-09-17

### Changed

- Renamed `/bro btw` composer commands from `/send` and `/send all` to `/copy` and `/copy-all` (also accepts `/copy all`), with `/copy!` and `/copy-all!` force variants to replace existing main-editor drafts. Legacy `/send` commands remain supported as aliases.

## [0.13.0] - 2026-09-15

### Added

- `/bro btw` — a side conversation in a modal, sandboxed (read-only) by default, with `--full` opting up to workspace access and `--fresh` skipping main-session context. Composer commands: `/send`, `/send all`, `/send!`, `/send all!`, `/retry`, `/clear`; empty Enter re-asks the last question. Runs through Agy, resumed via `--conversation <id>`; the thread is memory-only and clears on session change.

## [0.12.0] - 2026-09-11

### Changed

- `/bro show` now captures only user and assistant conversation text — every intermediate assistant message within a turn is kept, but tool calls, tool results, reasoning, and images are omitted entirely, with no placeholder text standing in for them. This supersedes the 0.10.0 design, which captured tool calls and tool results (trimmed) alongside conversation text; the source label changes from `last N turn(s)` to `last N turn(s) · conversation only` to reflect the narrower capture. Turn counting, the `n-turns` override, steering query, retry-on-**R**, and the 100,000-character transcript limit are unchanged.
- The show prompt now states its outcome hierarchy explicitly — user-visible behavior and outcome first, then system/data/state effects, then component or file relationships — and distinguishes what was explicitly requested, proposed but not done, reported as complete, or left unresolved. It also names that the transcript is the conversation's own account of what happened, not an independent check against the actual code or system, so shapes should say a result was reported or claimed rather than implying verification, without hedging every line.

### Development

- Rewrote `benchmark/show-corpus.ts`'s ten fixtures as conversation-only transcripts (no `## tool call` / `## tool result` sections), matching what `/bro show` now actually sends to the draw model, while keeping every fixture's required-token traceability.
- `benchmark/fixtures/decomposition/` (manual, not part of `npm test`) is annotated as predating conversation-only capture; its mined fixtures still contain tool call/result sections from the old format.
- Added smoke-test coverage asserting that every intermediate assistant message within a turn is retained, that tool calls and tool results never reach the captured transcript even when present in the session branch, and that the empty-session case still returns nothing to show.

## [0.11.0] - 2026-09-09

### Changed

- Rewrote the `/bro show` prompt from single-diagram shrinking to subject-first decomposition: find what the user actually wanted and what is true now, never diagram tool chronology (tool invocations, retries, git/gh commands, test runs) unless the process itself is the subject, and treat fetching, reading, editing, and testing as sub-steps rather than separate concerns. One concern still yields exactly one shape; multiple concerns yield a small overview plus 2–4 focused shapes that each add information instead of restating one another. Read-only pages, reviews, and analyses now keep their substance instead of collapsing to labels, while incidental orientation reads and process noise are omitted. Prose and research subjects degrade to a compact outline or comparison.
- Lowered the default `/bro show` window from the last 10 turns to the last 1, since the decomposed prompt now draws the resulting outcome rather than tool chronology, so a single turn is usually enough context.
- `/bro show` now takes an optional steering query, with or without a leading turn count (`/bro show`, `/bro show 3`, `/bro show what changed in the auth flow`, `/bro show 3 what changed in the auth flow`). The query is passed to the model as a lens on the same transcript, not as additional evidence, and its original casing and internal spacing are preserved. Only the first whitespace-delimited token is ever read as the turn count, so a digit-leading query word never gets mistaken for one: `/bro show 1 404 handler` captures 1 turn and steers on "404 handler", and `/bro show 2FA flow` treats "2FA" as the start of the query since it isn't a bare integer.
- `/bro show`'s prompt now offers a user flow, data flow, or state diagram as first-choice shapes for "what happens" subjects, ahead of code-structure shapes — and these high-level shapes no longer degrade to a plain outline just because the session has no code structure to draw. The prompt also requires naming any evidence missing from the transcript instead of guessing to fill the gap.

### Development

- Added a `/bro show` decomposition validation set under `benchmark/fixtures/decomposition/`: seven serialized-transcript fixtures mined from real pi-bro sessions (one shallow single-concern baseline, four medium multi-concern, one deep, one cross-cutting stretch case), a manifest recording each window's expected concerns and expected shape count, and a 15-check binary rubric (coverage, decomposition, simplicity, coherence, traceability, usefulness) for grading outputs without 1–5 scores. Personal emails in the fixtures are redacted. Grading is manual; nothing here runs in `npm test`.

## [0.10.1] - 2026-09-09

### Development

- Added release automation: merging a PR that bumps the version now tags it, publishes to npm through trusted publishing (OIDC, with provenance), and creates the matching GitHub release. CI validates the bump against npm before merge, and a daily sync check reports any npm/GitHub drift. No packaged files changed in this release.

## [0.10.0] - 2026-09-07

### Added

- Added `/bro show <n-turns>`: draw the last session turns, including tool results, as shapes — pseudocode, call trees, file trees, component trees, types and signatures, or diffs — instead of prose, in the same context-isolated modal. Defaults to the last 10 turns; a new `showTurns` setting (positive integer) changes the default and `/bro show <n-turns>` overrides it for one run. Adapts the `show-me` plugin from humanlayer/skills (MIT; credited in `THIRD_PARTY_NOTICES.md`).
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
