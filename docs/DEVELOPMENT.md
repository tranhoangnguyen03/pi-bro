# Developing pi-bro

The user guide is the [README](../README.md). This page is the short map for
changing the code. Read the code before trusting any plan in `docs/plans/`;
those are historical records.

## Files

Production is published as TypeScript source (no build step):

- **`bro.ts`** — the Pi extension entry point and wiring. Owns the `/bro` command and completion,
  `/bro doctor`, `/bro help`, the BTW thread and composer, the `bro_advisor` tool
  (snapshot, retries, progress), and advisor steering state.
- **`review.ts`** — Guided Review schema/validation, atomic records, guide replacement and prompt construction.
- **`review-source.ts`** — explicit GitHub identity through `gh`, managed Git capture and protected blob evidence reads.
- **`review-ui.ts`** — acquisition, backend execution, streaming/cancellation, serialized saves, evidence hydration and host UI lifecycle.
- **`review-modal.ts`** — renderer, focus/navigation, discussion composer, paging/wheel and contextual controls. No Git/model execution.
- Current review scope and user behavior: [guided-review.md](guided-review.md). Historical plans are not implementation instructions.
- **`settings.ts`** — settings schema, validation, backend metadata table,
  selection policy, pure model/effort transitions, and file persistence.
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
- **`ui-capabilities.ts`** — environment UI capability probes (interactive TUI, virtual viewport, Desktop panels).
- **`dev/`** — manual review launcher and recorded #102 source fixture, not shipped or included in the normal typecheck. `review-live.ts` uses the production controller but omits preferences; use `bro.ts` for a production-equivalent journey. The JSON fixture is kept as historical acquisition/rendering source data, not an automated test or generated-answer substitute.

## Settings

Saved settings are version 2: a shared `default` selection plus optional
`overrides` for `explain`, `show`, `btw`, `advisor`, and `review`. Every selection is an
atomic `{ backend, model, effort }` — an override replaces the whole
selection, never merges fields, and stays pinned until reset to Default.
Legacy flat files (root `model`/`effort`, no backend) still parse and mean
Agy; reads never rewrite the file.

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
- Capture resolves GitHub compare merge-base before depth-1 fetch, runs outside the active tree, pins merge-base/head Git objects and reads display evidence from blobs with `GIT_NO_REPLACE_OBJECTS=1`. Diff mapping fails visibly on inventory mismatch. Type-change adjacent sections remain grouped; binary/directory blobs are not displayed as text. Recovery directories are preserved rather than purged. No full-history fallback or lazy blob fetching; model has no Git/shell access. Fetch timeout 600 seconds, other commands 120 seconds.
- One current `guide` has app-generated topic/finding IDs. `replaceGuide` retains compact original context only for sent questions/nonempty drafts. Only the current schema is accepted; prototype guideVersions/missing-ui records fail unchanged. Development records were backed up/normalized once before removal.
- `ReviewView` holds destination, screen, row, drafts and offsets; optional return point/topic scope are validated convenience state. Back preserves the real origin. List rows are clamped after membership changes. Wheel scrolling does not alter keyboard focus or list selection.
- Controller debounce/serial write queue saves atomic snapshots; close aborts/awaits execution and flushes before exiting. Save failures retain the modal/in-memory work. Do not claim Saved on a failed write.
- `execute({feature:'review',access:'restricted',cwd:capturedCheckout,...})` uses Claude/Muse file-only tools; unsupported adapters fail before spawn, rejects native continuation and reconstructs context from records. It disables persistence where supported; it must not change BTW session semantics. Review deadline is 610 seconds. No automatic paid retry/fallback.
- Claude uses restricted Read/Grep/Glob with dontAsk/no MCP; Muse disables write/shell/web without trusting workspace rules. Shell-free means even read-only Codex execution is unavailable. Preserve these restrictions; no bypass fallback. Captured text remains a prompt-injection/model-quality risk. Source ranges are validated, but inspected paths, conclusions, reported access errors and execution remain model-reported.
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
npm test                                   # typecheck, node tests, smoke-test.sh
npm pack --dry-run                         # published file list
node .github/scripts/release-utils.mjs selftest
npm run benchmark:dry-run                  # manual live benchmark: see benchmark/README.md
```

Review tests: `review.test.ts` (capture/schema/prompts), `review-modal.test.mjs` and `review-ux.test.mjs` (rendering/interaction), `review-session.test.mjs` and `review-regeneration.test.mjs` (fake-CLI controller/save/recovery), `review-versions.test.mjs` (single-guide/current validation and rejected prototype schemas), `review-ui.test.mjs` (evidence/save presentation), `review-doctor.test.mjs` (review-only backend selection). Adapter tests keep BTW/native-session behavior separate from stateless review. Add regressions to the existing owner; do not create another generic harness.

`npm test` never calls a real model: `backend.test.ts`, `claude.test.ts`,
`grok.test.ts`, `codex.test.ts`, and `muse.test.ts` run fake CLIs; `settings.test.ts` and `prompt.test.ts` cover
pure helpers; `helpers.test.mjs` contains sequential modal/advisor checks and Pi SDK
integration checks formerly embedded in the shell suite. `test-build.mjs` provides
isolated compilation for these tests, settings, and Show HTML tests.
`smoke-test.sh` drives Pi offline over RPC with a fake `agy`.
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
