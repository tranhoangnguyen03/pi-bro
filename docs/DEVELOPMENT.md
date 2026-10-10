# Developing pi-bro

The user guide is the [README](../README.md). This page is the short map for
changing the code. Read the code before trusting any plan in `docs/plans/`;
those are historical records.

## Files

Production is published as TypeScript source (no build step):

- **`bro.ts`** — the Pi extension entry point and wiring. Owns the `/bro` command and completion,
  `/bro doctor`, `/bro help`, the BTW thread and composer, the `bro_advisor` tool
  (snapshot, retries, progress), and advisor steering state.
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

## Settings

Saved settings are version 2: a shared `default` selection plus optional
`overrides` for `explain`, `show`, `btw`, and `advisor`. Every selection is an
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
  explain, Show, and BTW prompts as a JSON-quoted section and never to the
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

## Lifecycle limits

Benchmark calls and usage preflight reuse the backend's bounded process lifecycle:
SIGTERM to the POSIX process group, SIGKILL after the grace period, then pipe
closure and bounded close-wait completion. Windows only guarantees direct-child
termination. Benchmark identity, reporting fields, and no-retry policy are unchanged.

Shutdown/reload with an active detached backend remains **unverified** across Pi
and PiG (#64). Cleanup currently depends on the host aborting the supplied signal;
Bro has no global shutdown registry. Headless command execution without a supplied
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
