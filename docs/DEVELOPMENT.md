# Developing pi-bro

The user guide is the [README](../README.md). This page is the short map for
changing the code. Read the code before trusting any plan in `docs/plans/`;
those are historical records.

## Files

Production is published as TypeScript source (no build step):

- **`bro.ts`** — the Pi extension. Owns the `/bro` command and completion,
  source capture (latest reply, text, workspace files, public webpages, show
  turns), settings (`bro-settings.json` parse/write, per-capability
  resolution), `/bro config`, `/bro doctor`, `/bro help`, all modals, the BTW
  thread and composer, the `bro_advisor` tool (snapshot, retries, progress),
  and advisor steering state.
- **`backend.ts`** — the shared execution layer. `execute()` runs one request
  on Agy, Claude Code, Grok, Codex, or Muse: argv/stdin construction per backend and
  feature, private temp prompt files, streaming parse, native continuation
  IDs, deadlines, cancellation, and process-group cleanup. Feature behavior
  (retries, UI, settings) stays out of it.
- **`prompt.ts`** — pure prompt builders: explain modes, show, BTW (including access mode and reseeded history), and the
  advisor. Prompts are backend-neutral; backend differences belong in
  `backend.ts`, not in prompt text.

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
- Explain modes and Show are separate; `bro-prompt.md` affects explain only.

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
pure helpers; `smoke-test.sh` drives Pi offline over RPC with a fake `agy`.
The smoke suite isolates its temporary root, including generated diagrams. Backend tests
put fail-closed CLI stubs behind their explicit fakes so validation regressions cannot
reach installed model CLIs. `smoke-rpc.mjs` queues settings writes/copies alongside RPC
requests and applies them only after earlier requests are acknowledged; scenario ordering
does not depend on sleeps. `smoke-rpc.test.ts` checks this with a delayed fake host, and
`show-html.test.ts` checks generated HTML's restrictive content policy.

Config interactions are also exercised with a fake TUI/persistence harness;
that is not live terminal verification. Use [TESTING.md](TESTING.md) for real
modal interaction, including the BTW composer.

## Releases

Changes to `bro.ts`, `prompt.ts`, `backend.ts`, or package files need a version
bump and a matching `CHANGELOG.md` section, or the `release:none` label. See
the PR template and `.github/workflows/`.
