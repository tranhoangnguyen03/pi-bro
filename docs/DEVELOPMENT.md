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
  on Agy, Claude Code, or Grok: argv/stdin construction per backend and
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

## BTW continuation

BTW keeps one in-memory thread bound to a backend and an access mode
(conversation-only / full permission, toggled by `/mode`).

- Claude and Grok resume the same native session with `--resume`, across
  `/mode` switches (both run in the workspace).
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
- Cancellation or a deadline never produces a late success or a retry.
- Explain modes and Show are separate; `bro-prompt.md` affects explain only.

## Tests

```sh
npm test                                   # typecheck, node tests, smoke-test.sh
npm pack --dry-run                         # published file list
node .github/scripts/release-utils.mjs selftest
npm run benchmark:dry-run                  # manual live benchmark: see benchmark/README.md
```

`npm test` never calls a real model: `backend.test.ts`, `claude.test.ts`, and
`grok.test.ts` run fake CLIs; `settings.test.ts` and `prompt.test.ts` cover
pure helpers; `smoke-test.sh` drives Pi offline over RPC with a fake `agy`.
Config interactions are also exercised with a fake TUI/persistence harness;
that is not live terminal verification. Use [TESTING.md](TESTING.md) for real
modal interaction, including the BTW composer.

## Releases

Changes to `bro.ts`, `prompt.ts`, `backend.ts`, or package files need a version
bump and a matching `CHANGELOG.md` section, or the `release:none` label. See
the PR template and `.github/workflows/`.
