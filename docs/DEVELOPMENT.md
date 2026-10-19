# Developing pi-bro

User documentation starts at the [docs home](README.md), with canonical
[commands](reference/commands.md), [settings](reference/settings.md),
[backend access](reference/data-and-permissions.md), and feature guides.
The [README](../README.md) is the short overview. This page is the short map for
changing the code. Read the code before trusting any plan in `docs/plans/`;
those are historical records.

## Files

Production code lives in `src/` and is published as TypeScript source (no build step):

- **`bro.ts`** — the Pi extension entry point, `/bro` command routing and completion, session lifecycle wiring, and barrel re-exports.
- **`doctor.ts`** — `/bro doctor` diagnostics, CLI version/auth probes, Agy model catalog/usage parsing, and `/bro config` modal launch wiring.
- **`show.ts`** — `/bro show` transcript capture, argument parsing, CSP-guarded HTML/Mermaid diagram page generation, and show execution.
- **`advisor.ts`** — the `bro_advisor` tool registration, context snapshot builder, session/durable steering state, and retry/progress orchestration.
- **`btw.ts`** — the `/bro btw` side conversation thread state, native continuation/reseed policy, composer command parsing, and `BtwModal`.
- **`elevate-engine.ts`** — independent discovery and rewrite prompts, strict discovery JSON parser, user selection and scope guards.
- **`elevate.ts`** — `/bro elevate` UI, draft capture, context filtering, backend calls, cancellation and guarded editor insertion.
- **`explain-modal.ts`** — `BroModal` (explain/show/doctor/help result overlay), `simplify`, `createTextEditorModal` (`/bro preferences` and `/bro advisor-steer` editors), and `/bro help` text.
- **`review.ts`** — Guided Review schema/validation, atomic records, guide replacement and prompt construction.
- **`review-source.ts`** — explicit GitHub identity through `gh`, managed Git capture and protected blob evidence reads.
- **`review-ui.ts`** — acquisition, backend execution, streaming/cancellation, serialized saves, evidence hydration and host UI lifecycle.
- **`review-modal.ts`** — renderer, focus/navigation, discussion composer, paging/wheel and contextual controls. No Git/model execution.
- Current review scope and user behavior: [guided-review.md](guided-review.md). Historical plans are not implementation instructions.
- **`settings.ts`** — settings schema, validation, backend metadata table,
  selection policy, pure model/effort transitions, and settings/preferences file persistence.
- **`sources.ts`** — self-contained document text extraction (PDF, DOCX) and public webpage
  scraping with SSRF protection.
- **`config-ui.ts`** — the `/bro config` modal, settings items, model pickers, and
  async save queue.
- **`util.ts`** — shared leaf utility helpers (`isRecord`, `errorMessage`, `withDoctor`, etc.).
- **`backend.ts`** — the shared execution layer. `execute()` runs one request
  on Agy, Claude Code, Grok, Codex, or Muse: argv/stdin construction per backend and
  feature, private temp prompt files, streaming parse, native continuation
  IDs, deadlines, cancellation, and process-group cleanup. Feature behavior
  (retries, UI, settings) stays out of it.
- **`prompt.ts`** — pure prompt builders: explain modes, show, BTW (reader guidance, access mode, and reseeded history), and the
  advisor. Prompts are backend-neutral; backend differences belong in
  `backend.ts`, not in prompt text.
- **`ui-capabilities.ts`** — environment UI capability probes (interactive TUI, virtual viewport, Desktop panels) and terminal mouse-reporting helpers.
- **`modal-kit.ts`** — shared overlay building blocks: the `Theme`/`TuiLike` types, the `BRO_OVERLAY` preset and `modalHeight`, `renderFrame`, `Scroller`, `delegateMouse`, the regular-mode mouse lease and `openBroOverlay`. See [Modals](#modals).
- **`dev/`** — manual review launcher and recorded #102 source fixture, not shipped or included in the normal typecheck. `review-live.ts` uses the production controller but omits preferences; use `bro.ts` for a production-equivalent journey. The JSON fixture is kept as historical acquisition/rendering source data, not an automated test or generated-answer substitute.

## Settings

Saved settings are version 2: a shared `default` selection plus optional
`overrides` for `explain`, `show`, `btw`, `advisor`, and `review`. Every selection is an
atomic `{ backend, model, effort }` — an override replaces the whole
selection, never merges fields, and stays pinned until reset to Default.
Legacy flat files (root `model`/`effort`, no backend) still parse and mean
Agy; reads never rewrite the file.

## Elevate architecture and invariants

- Human-initiated and pre-execution only. The main agent receives nothing until the user submits the rewritten request.
- The engine in `src/elevate-engine.ts` depends on no Pi API or model CLI. Discovery can produce zero findings; the user selects which ones can reach the rewrite. The model can still make mistakes; review its output.
- `src/elevate-engine.ts` captures uncapped current-branch user/assistant text by default; Full additionally allowlists tool calls and text results, never reasoning/images/provider metadata. Compose offers a visible context switch before any call. Changing modes clears discovery/approvals. Only explicit Retry following a recognized context-overload error progressively removes older history; objective and approvals are preserved.
- Each stage makes a fresh restricted backend call through `selectionForCapability(settings, "btw")`. Restrictions are backend-specific; see [data and permissions](reference/data-and-permissions.md#backends-access-and-retention).
- **One visible focus target.** Compose uses the shared body `Editor`; review owns a checklist cursor; every consequential action is a button rendered by `buttonLabels` from `modal-kit.ts`. `Tab`/`Shift+Tab` switch zones, arrows move within a zone, and `Enter` activates only the focused thing. In the checklist, Space or Enter toggles the highlighted finding; Tab moves to the action buttons. Buttons are packed by `wrapButtons` so a label is never split across lines.
- **Nothing is approved by default.** Findings start unticked so the user approves only what they read; the highlighted finding's full title, reason, expert action and assessment are reachable in scrollable detail below the pinned list. A rewrite with nothing ticked is refused with an explanation. A failed step retries that step with the same approvals.
- The original main editor stays unchanged until `[Insert into editor]` (or its Desktop equivalent). Terminal insertion replaces the editor only when Elevate was opened on that draft and the text is still unchanged; with an explicit `/bro elevate <request>`, the editor must be empty first. Desktop/RPC only uses confirmed atomic insert into an empty editor. Neither action submits text.
- Compose reads the objective with `getExpandedText()`, never `getText()`: the `Editor` stores large pastes as `[paste #1 +N lines]` markers, and the marker must never be sent to the backend. When the `Editor` cannot render whole, the modal refuses to edit and says so rather than hiding the cursor.
- Automated unit tests: `test/elevate.test.ts` and `test/elevate-docs.test.mjs`; the modal contract in `test/modal-contract.test.mjs` covers every Elevate stage. Manually test real modal use as described in [TESTING.md](TESTING.md).

## Prompt size and recent context

Agy explain, Show, and BTW retain argv transport below 120,000 UTF-8 bytes.
Larger prompts use stdin NDJSON (Agy 1.1.15+), avoiding Linux's single-argument
limit; an unsupported CLI reports an upgrade hint without retrying another transport.
Show and BTW context budgets retain newest complete turns first, then newest
messages, then a JSON-quoted tail of an oversized final message. Truncation is
marked explicitly when messages or message text are removed within a turn.

## BTW continuation

BTW keeps one in-memory thread bound to a backend and an access mode
(conversation-only / full permission, toggled by `/mode`).

- Claude, Grok, Codex, and Muse resume the same native session across
  `/mode` switches (all run in the workspace).
- Agy conversation-only runs in a temporary directory and full permission in
  the workspace, so an access change drops the Agy conversation ID. The next
  turn starts a fresh native session reseeded with the main-session context
  and every earlier turn. Any thread with turns but no native ID reseeds the
  same way.
- Changing the BTW backend starts a fresh thread; IDs never cross backends.

## Modals

Bro's overlays share `src/modal-kit.ts` so they behave the same on every
supported Pi (0.84.2 and up) in regular and fullscreen mode. Pi clips an overlay
that is taller than its `maxHeight` from the bottom, and Pi 1.2 sends the wheel
only to `handleMouse` (a wheel left unhandled scrolls the chat behind).

- Mount with `openBroOverlay` (preset `BRO_OVERLAY`); pass `mouse: true` for a
  scrolling surface so regular-mode mouse reporting is turned on and always off again.
- Draw with `renderFrame` at `modalHeight(tui, BRO_OVERLAY, cap)`. It never returns
  more lines than that, and drops body rows before hints, notices and borders.
- Scroll with `Scroller`: keys, raw SGR wheel (Pi 0.84 and regular mode) and
  `handleMouse` (Pi 1.x) in one place.
- Write key hints as `Key action` joined by ` · ` (no colons), e.g.
  `↑/↓ scroll · C copy · Esc close`; notices go above the hints, never in front.
- Add a row to `test/modal-contract.test.mjs` for every new surface. It checks
  each surface against pi-tui's own overlay sizing at several terminal sizes.

Every Bro overlay uses the kit; the design and its reviews are in
[plans/modal-consistency.md](plans/modal-consistency.md). The Guided Review workspace
(`ReviewModal`) keeps its specialized full-width multi-pane layout and rounded corners;
acquisition uses `renderFrame` with `REVIEW_ACQUIRE_OVERLAY` (centered 70% width).

## Invariants

- Nothing Bro produces enters Pi's conversation or main-agent context, except
  explicit BTW `/insert`/`/insert-all` into the editor and advisor tool results.
- Source text is quoted data; prompts forbid inventing facts, names, or
  relationships.
- No silent fallback between backends, models, or efforts; surface the
  backend's own error.
- Describe access truthfully per backend. A prompt instruction (Grok) is not
  enforcement, and the advisor's "advise, don't edit" is behavioral.
- Cancellation or a host deadline never produces a late success or a retry.
  CLI-reported errors remain retryable invocation failures; they are not inferred
  to be host timeouts by matching diagnostic text.
- Explain modes and Show are separate. `bro-preferences.md` is added to the
  explain, Show, BTW, and review prompts as a JSON-quoted section and never to the
  advisor. It shapes wording, tone, depth, and answer language and never
  overrides the source rules, Show's hard rules, or BTW access mode. The prompt
  builders in `prompt.ts` stay pure: blank preferences leave output unchanged,
  while nonblank preferences add a guarded block. Benchmark manifests freeze
  the measured prompts; unit tests do not freeze their wording.
- An explanation's mode and preferences tag belong to its result: **M** and
  **R** re-run with the mode and re-read preferences, and `/bro open` restores
  both without a backend call. Only `/bro mode` and `/bro config` write the
  saved mode. A result without a built-in mode (Show, Doctor) offers no **M**.
- A native BTW session remembers earlier prompts, so a change to preferences
  (like an Agy access change) drops it and reseeds a fresh one with the
  quoted thread.
- Guidance prompts such as BTW's describe the reader and the goal and trust
  the model with the form of the answer; prefer that to templates, hard caps,
  or required labels.

## Guided Review implementation rules

Normal journey: open PR → read/investigate → close. Automatic persistence supports this; Copy finding and regeneration are optional. Do not add a mandatory notes/approval/publication lifecycle.

- PR key is host/repository numeric identity/PR number, not head SHA. URL/number opening checks metadata, then restores an existing capture; picker resume does not fetch. Do not silently replace source with a newer revision.
- Capture resolves GitHub compare merge-base before depth-1 fetch, runs outside the active tree, pins merge-base/head Git objects and reads display evidence from blobs with `GIT_NO_REPLACE_OBJECTS=1`. Diff mapping fails visibly on inventory mismatch. Type-change adjacent sections remain grouped; binary/directory blobs are not displayed as text. Recovery directories are preserved rather than purged. No full-history fallback or lazy blob fetching; Claude and Muse get no Git/shell access, while Codex/Grok/Agy review gets sandboxed shell (see the review rule below). Fetch timeout 600 seconds, other commands 120 seconds.
- One current `guide` has app-generated topic/finding IDs. `replaceGuide` retains compact original context only for sent questions/nonempty drafts. Only the current schema is accepted; prototype guideVersions/missing-ui records fail unchanged. Development records were backed up/normalized once before removal.
- `ReviewView` holds destination, screen, row, drafts and offsets; optional return point/topic scope are validated convenience state. Back preserves the real origin. List rows are clamped after membership changes. Wheel scrolling does not alter keyboard focus or list selection.
- Controller debounce/serial write queue saves atomic snapshots; close aborts/awaits execution and flushes before exiting. Save failures retain the modal/in-memory work. Do not claim Saved on a failed write.
- `execute({feature:'review',access:'restricted',cwd:capturedCheckout,...})` runs on every backend but always without bypass flags. Claude uses strict file-only tools (`--restricted` Read/Grep/Glob, dontAsk, no MCP); Muse disables write/shell/web without trusting workspace rules. Codex (`--sandbox read-only --ephemeral`) and Grok (`--sandbox read-only --permission-mode dontAsk`) inspect the captured checkout under a read-only sandbox; Agy's `--sandbox` restricts terminal commands but still permits in-project writes. All three run shell commands, share `backendDeadlineMs` (610 s for review), and are disclosed through `reviewBackendNotice` in the UI and doctor. Displayed evidence comes from pinned Git blobs, not the working tree, so sandboxed writes cannot rewrite it. Review rejects native continuation and reconstructs context from records. It disables persistence where supported; it must not change BTW session semantics. No automatic paid retry/fallback.
- Shell-free means the backend has no shell tool (Claude, Muse); it is not a claim about Codex/Grok/Agy. Never add a bypass flag to review. Captured text remains a prompt-injection/model-quality risk. Source ranges are validated, but inspected paths, conclusions, reported access errors and execution remain model-reported. Preserve the non-fatal advisory in doctor (no `✗`).
- Fresh guide calls omit prior guide/discussion; question calls include current guide, original target context and latest 12 relevant nonfailed turns. First 100,000 diff characters are seeded with disclosure. Preferences are included; main-session context is not.
- Copy delegates to Pi's clipboard helper and reports errors. It does not insert into the editor, mutate code or publish; clipboard retention is outside Bro.
- One active writer per target in-process; no cross-process locking/sync guarantee. Do not delete user review/source data as part of a simplification.

## Lifecycle limits

Benchmark calls and usage preflight reuse the backend's bounded process lifecycle:
SIGTERM to the POSIX process group, SIGKILL after the grace period, then pipe
closure and bounded close-wait completion. Windows only guarantees direct-child
termination. Benchmark identity, reporting fields, and no-retry policy are unchanged.

Shutdown/reload with an active detached backend remains **unverified** across Pi
and PiG (#64). Guided Review registers `session_shutdown` cancellation via `stopGuidedReviews()`; this is abort wiring, not proof of descendant cleanup or a complete save flush on abrupt shutdown. Other execution still depends on the host aborting the supplied signal; there is no universal backend shutdown registry. Headless command execution without a supplied
signal is bounded by its deadline, not a verified shutdown hook. An abrupt host
exit can leave descendants running; do not treat the offline cancellation tests
as shutdown/reload qualification. A follow-up host test should reload/shut down
during a fake in-flight consultation and assert no delayed child activity.

## Tests

```sh
npm test                                   # typecheck, node tests, test/smoke-test.sh
npm pack --dry-run                         # published file list
node .github/scripts/release-utils.mjs selftest
npm run benchmark:dry-run                  # manual live benchmark: see benchmark/README.md
```

Extension tests and their helpers live in `test/`; benchmark tests stay in `benchmark/`. CI runs `npm test` on Linux with Node 24 and Node 22.19.0 (the `engines` floor), and on macOS with Node 24, all with the pinned Pi (1.2.0). The `pi-floor` job reruns it with Pi 0.84.2, the oldest supported version.

Review tests: `review.test.ts` (capture/schema/prompts), `review-modal.test.mjs` and `review-ux.test.mjs` (rendering/interaction), `review-session.test.mjs` and `review-regeneration.test.mjs` (fake-CLI controller/save/recovery), `review-versions.test.mjs` (single-guide/current validation and rejected prototype schemas), `review-ui.test.mjs` (evidence/save presentation), `review-doctor.test.mjs` (review-only backend selection). Adapter tests keep BTW/native-session behavior separate from stateless review. Add regressions to the existing owner; do not create another generic harness.

`npm test` never calls a real model: `backend.test.ts`, `claude.test.ts`,
`grok.test.ts`, `codex.test.ts`, and `muse.test.ts` run fake CLIs; `settings.test.ts` and `prompt.test.ts` cover
pure helpers; `helpers.test.mjs` contains sequential modal/advisor checks and Pi SDK
integration checks formerly embedded in the shell suite. `test-build.mjs` provides
isolated compilation for these tests, settings, and Show HTML tests.
`test/smoke-test.sh` drives Pi offline over RPC with a fake `agy`.
See [test-consolidation.md](test-consolidation.md) for the #74 coverage ledger,
throttle mutation check, and before/after timings.
The smoke suite isolates its temporary root, including generated diagrams. Backend tests
put fail-closed CLI stubs behind their explicit fakes so validation regressions cannot
reach installed model CLIs. `smoke-rpc.mjs` queues settings writes/copies alongside RPC
requests and applies them only after earlier requests are acknowledged; scenario ordering
does not depend on sleeps. `smoke-rpc.test.ts` checks this with a delayed fake host, and
`show-html.test.ts` checks generated HTML's restrictive content policy.

Config interactions are also exercised with a fake TUI/persistence harness, and
the explain modal's **M**/**R**/`/bro open` flow runs through the real `/bro`
command against a fake `agy`; neither is live terminal verification. Use [TESTING.md](TESTING.md) for real
modal interaction, including the BTW composer.

## Releases

Changes to shipped runtime modules (`package.json#files` excluding docs),
`package.json`, or `package-lock.json` need a version bump and a matching
`CHANGELOG.md` section, or the `release:none` label. See the PR template and
`.github/workflows/`.
