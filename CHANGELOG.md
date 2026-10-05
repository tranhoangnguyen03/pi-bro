# Changelog

All notable changes to pi-bro are documented here.

## [Unreleased]

### Changed

- Separate Bro responsibilities and unify settings and backend-selection policy (#83):
  - Extract `settings.ts` (schema, typed `EXTERNAL_BACKENDS` metadata, selection policy, pure transitions, and file persistence).
  - Extract `sources.ts` (self-contained document text extraction and public web scraping with SSRF protection).
  - Extract `config-ui.ts` (`/bro config` modal, setting items, and async save serialization).
  - Extract `util.ts` (shared leaf utility helpers).
  - Unify legacy flat and v2 settings parsing into one converged validation pipeline in `settings.ts`, eliminating duplicate validation branches.
  - Initialize clean version 2 settings on fresh installations in `ensureSettingsFile()`.
  - Share pure state transitions (`applyModelChange`, `applyEffortChange`) across default and capability override rows.
  - Fix Agy variant model reselection bug where resolved effort from suffixed variants was lost.
  - Consolidate CLI version probes in `/bro doctor` into a single `checkCliVersion` helper.

## [0.21.0] - 2026-10-04

### Added

- `bro-preferences.md`: tell Bro about yourself and how you like answers. Bro adds it, JSON-quoted and labelled, to every explain, `/bro show`, and `/bro btw` prompt alongside its own instructions; the advisor never receives it. Preferences can change wording, tone, technical depth, and the answer language (code, commands, paths, names, and numbers stay verbatim). In Show they change only wording and language. Per-run choices (the mode, **M**, a Show steering query, a BTW question) win over them, and Bro's source rules, Show's hard rules, and BTW access mode always apply. Blank or missing preferences leave every prompt byte-identical to 0.20.0 (#94).
- `/bro preferences` edits the file (**Ctrl+S** save, **Ctrl+K** delete, **Ctrl+C** copy, **Esc** close). Without a file it opens with unsaved starter text that restates the old built-in audience and brief wording. Saves are checked against the 4,000-character limit, and an oversize file still opens so it can be trimmed (#94).
- The modal header shows `· prefs` when preferences shaped an explanation, drawing, or BTW turn; `/bro open` keeps the result's tag (#94).

### Changed

- Modes, **M**, and the source guard now always apply; nothing disables them (#94).
- Preferences over 4,000 characters stop explain, Show, and BTW with an actionable error before any backend call instead of being truncated. `/bro doctor` replaces its Prompt check with a Preferences check, and `/bro help` shows the preferences status (#94).
- When preferences change mid-thread, the next BTW turn starts a fresh native session reseeded with the quoted thread, on every backend, so old preferences don't linger in the backend's history (#94).

### Removed

- **Breaking:** `bro-prompt.md` is no longer read. It was a full replacement template for the explain prompt that disabled modes, **M**, and the source guard and did not affect Show or BTW. Bro does not migrate, rename, or delete it. Move what you want to keep into `/bro preferences`, and use `/bro mode brief` for the original ELI-simpleton instruction (#94).

## [0.20.0] - 2026-10-04

### Added

- Press **M** in an explanation modal to re-simplify the captured source in the next explain mode (brief → balanced → faithful). The switch applies to that explanation only: the saved mode is unchanged, **R** and `/bro open` keep the shown mode, and a second press while Bro is working cancels and skips ahead. The header now names the mode; **M** is hidden for Show, Doctor, and custom prompts.

### Changed

- `/bro btw` now tells the model who it is writing for: a tired reader who needs the point first, in plain words, at a length that fits the question, in the language they asked in. The guidance describes the reader and the goal rather than a fixed template. In full-permission mode, answers say which points were checked in the workspace.

## [0.19.5] - 2026-10-01

### Changed

- Remove the always-true backend-support predicate and unreachable doctor/config branches; retain backend-specific effort and permission validation (#74).
- Move helper, modal, advisor, and Pi SDK regression checks into named Node tests with shared isolated compilation, leaving shell smoke tests focused on host RPC integration and avoiding duplicate helper execution in PiG (#74).
- Consolidate redundant support, prompt, and BTW assertions; replace prose greps with package-documentation checks and document surviving coverage (#74).

### Fixed

- Make the advisor throttle cancellation test actually queue an emission and advance controlled time beyond its deadline; verified by removing cleanup and observing failure (#74).

### Documentation

- Explicitly archive the seven pre-conversation-only decomposition captures as historical semantic examples and record before/after test organization and timings (#74).

## [0.19.4] - 2026-10-01

### Fixed

- Preserve advisor timeout and cancellation status through the consultation wrapper. Host deadlines and cancellation stop after one attempt without backoff; ordinary invocation failures retain the existing three-attempt policy (#72).
- Bound benchmark call and usage-preflight cleanup when descendants retain output pipes, reusing backend process-group termination and escalation. Ignore late output after a stop without adding benchmark retries (#72).

### Documentation

- Distinguish host deadlines from CLI-reported failures and document unverified shutdown/reload cancellation, POSIX process-group cleanup, and Windows direct-child limits (#72).

## [0.19.3] - 2026-09-30

### Fixed

- Send large Agy explain, Show, and BTW prompts over stdin instead of exceeding argument-size limits. Older Agy versions report an upgrade hint rather than silently falling back (#73).
- Retain newest turns and message tails when bounding Show and BTW context, preserving JSON message framing (#73).

## [0.19.2] - 2026-09-30

### Fixed

- Preserve Show's diagram controls, captured source, and steering when reopening and rerunning a result. Recreate missing temporary diagrams without a model call and retain the previous diagram after a failed rerun (#71).

## [0.19.1] - 2026-09-30

### Fixed

- Always enforce Bro's restrictive content policy on generated HTML, including when model output contains a permissive policy or CSP-looking comment (#69).
- Isolate smoke-test temporary artifacts and block real backend CLIs during offline tests. Order settings mutations by RPC acknowledgements instead of fixed sleeps, and support spaces in settings-test checkout paths (#70).

## [0.19.0] - 2026-09-25

### Added

- Support for OpenAI Codex CLI (`codex`) across all features: explain, show, BTW, and advisor. Explain and show run under a read-only sandbox with ephemeral session handling; BTW continues natively via `resume` across both conversation-only and full-permission modes; advisor runs in the workspace with sandbox bypassed. Supports seeded models `gpt-5.5` and `gpt-5.4` plus custom model IDs, and reasoning efforts `low`, `medium`, `high`, `xhigh`.
- Support for Meta Muse Code (`muse`) across all features: explain, show, BTW, and advisor. Explain and show run in a scratch directory with approval, non-shell write, and shell disabled; BTW continues natively via `--session-id` across `/mode` switches; advisor runs in the workspace with `--yolo`. Supports seeded models `muse-spark-1.3-contributor` and `muse-spark-1.3` plus custom model IDs, and reasoning efforts `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (omitted for model default).
- Configuration modal support in `/bro config` for Codex and Muse, including atomic model selection, custom model ID inputs, and dynamic reasoning effort dropdowns.
- Doctor diagnostic checks for Codex (version and `codex login status` authentication probe) and Muse (version probe).

## [0.18.1] - 2026-09-30

### Fixed

- Declare host-provided `typebox` and Pi packages as wildcard peer dependencies, keeping pinned copies only for development. This removes the host-dependency warning added in Pi 0.99.0 and avoids installing a separate runtime TypeBox copy.

## [0.18.0] - 2026-09-24

### Added

- `/mode` inside `/bro btw` toggles conversation-only / full permission without losing the conversation (#62). Threads start conversation-only, and reopening keeps the current mode. The header shows a simple `conversation-only` / `full permission` badge next to the model and effort.
- Claude Code BTW with native multi-turn continuation in both modes (#58): turns run in the workspace with session persistence and `--resume`. Conversation-only turns disable tools, and full permission turns bypass permissions.
- Across a `/mode` switch, Claude and Grok resume the same native session. Agy conversations stay bound to their original workspace, so Agy starts a fresh native session seeded with the main-session context and every earlier turn. The same reseed also covers any thread that has turns but no native session ID.

### Removed

- The `/bro btw --full` and `--sandbox` flags. Both are now rejected with a hint to use `/mode`, and nothing is sent to the model.
- The `/bro btw --fresh` flag. Every new or cleared thread is seeded with main-session context; reopening still continues the thread natively. `--fresh` is rejected with a `/clear` hint and nothing is sent.
- The `/insert!` and `/insert-all!` BTW composer commands. `/insert` and `/insert-all` never replace an existing main-editor draft; they ask you to edit or clear it first. The old force strings only show a notice and are never sent as questions.
- The `/bro model` and `/bro effort` commands. Use `/bro config` for the shared default and per-capability model/effort. Both now show a `/bro config` pointer and never fall through to a text explanation.

### Changed

- Docs: the README is the single backend-neutral user guide (Agy is the default, not a requirement), with one "Backends: access and retention" section. `/bro help` is now a concise reference that points to the README. The advisor prompt no longer names a backend or CLI flags. `docs/DEVELOPMENT.md` replaces `docs/DEV-SNAPSHOT.md`, and `docs/TESTING.md` is the single manual end-to-end checklist.

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
