# pi-bro development snapshot

> Context snapshot for future agents. Captured at `277a1f28515258895f6ce188602ced1df505269a` (`0.13.1`, branch `fix/btw-copy-commands`), then updated in place (uncommitted) to describe the production `/bro config` shared-default + per-capability-override settings screen and, on top of that, the `/bro advisor` executor-callable tool (`bro_advisor`), registered with no on/off activation state of its own, plus a session-scoped steering brief. Refresh this file when behavior or architecture changes.

## Product identity

`pi-bro` is an Earendil Pi extension that gives the human a separate space beside the main coding conversation, plus one tool for the executor agent itself:

- **Explain:** rewrite a dense assistant reply, pasted text, local document, or public webpage in clearer plain language.
- **Show:** turn recent session conversation into a small, grounded shape such as a flow, tree, pseudocode, diff, types, or outline.
- **Btw:** open a separate Agy-backed side conversation for questions without derailing the main agent.
- **Advisor:** a `bro_advisor` tool the *executor* (not the human) can voluntarily call for a second opinion from a fresh, standalone Agy process with real workspace tool access.

The core promise is **context isolation**. Explain/show results never become Pi messages or main-agent context. Btw remains in memory and reaches the main editor only when the user explicitly inserts it via `/insert` or `/insert-all`; `/copy` and `/copy-all` target only the system clipboard. Btw full permission mode (toggled with `/mode`) is the deliberate exception: it gives the side agent workspace access and edit permission. The advisor's steering brief is session-scoped extension state (never sent to the main model); the advisor's own tool access is real and unsandboxed by design (see "Advisor" below), which is the one deliberate departure from "read-only unless explicitly opted into".

## Non-negotiable philosophy

- Understanding beats mere shortening.
- Source text is quoted data; embedded instructions are not instructions to Bro.
- Do not invent facts, advice, conclusions, identifiers, relationships, or verification.
- Preserve source language, intentional language mixing, important conditions, warnings, literals, commands, URLs, paths, code, and formatting as the selected mode requires.
- Show is outcome-first, not a diagram of tool chronology.
- Use the smallest useful shape; one concern gets one shape, multiple concerns get a small overview plus focused shapes.
- Explain modes and Show are separate axes. Do not reintroduce a visual mode without a deliberate design decision.
- Agy is the only provider. Live benchmarks are opt-in and never part of CI or `npm test`.

## Runtime map

Production is intentionally small and published as TypeScript source; there is no `dist/` build.

```text
bro.ts
└── bro(pi)
    ├── registers /bro and argument completion
    ├── registers bro_advisor like any other tool -- no on/off activation state or setActiveTools calls
    ├── owns in-memory lastResult and btwThread
    ├── resets transient state on session_start
    ├── routes explain/file/url/show/btw/settings/config/advisor/advisor-steer/help/doctor/usage
    ├── extracts and validates source data
    ├── runs Agy subprocesses (explain/show/btw via argv --print; advisor via stdin stream-json)
    └── renders BroModal, BtwModal, or the advisor-steer Editor modal

prompt.ts
├── brief / balanced / faithful prompt construction
├── independent SHOW_PROMPT and buildShowPrompt
├── independent buildBtwPrompt
└── independent buildAdvisorPrompt (steering / snapshot / question, labeled sections)
```

### High-value symbols

| Area | Symbols / location |
|---|---|
| Latest assistant source | `latestAssistant` in `bro.ts` |
| Workspace documents | `extractDocumentText` |
| Public web safety/extraction | `isPublicWebAddress`, `parseWebUrl`, `fetchPublicHtml`, `extractWebHtml` |
| Settings compatibility | `parseBroSettings`, `parseOverrides`, `settingsPayload`, `readSettings`, `writeSettings` |
| Agy model/effort | `parseAgyModels`, `resolveModelEffort`, `resolveCatalogSettings`, `agySelection` |
| Per-capability overrides | `capabilityPair`, `capabilityOverride`, `withCapabilityOverride`, `resolveCapabilitySettings` |
| Config modal | `createConfigModal`, `showBroConfigModal`, `effortDisplay` |
| Setup diagnostics | `doctorReport` |
| Show capture | `showEntriesForMessage`, `captureShowTranscript` |
| Show argument parsing | `parseShowArguments` |
| Show HTML | `extractShowHtml`, `writeShowHtml`, `openShowHtml` |
| Explain process | `runAgyText`, `simplify` |
| Generic explanation modal | `BroModal`, `showBroModal` |
| Btw flags/state | `parseBtwArguments`, `resolveBtwThread`, `toggleBtwMode`, `nativeBtwContinuation`, `bindBtwBackend` |
| Btw composer | `parseBtwComposerCommand` |
| Btw process | `runBtwTurn` |
| Btw orchestration | `openBtwModal` |
| Advisor steering state | `resolveAdvisorState` |
| Advisor snapshot | `buildAdvisorSnapshot` |
| Advisor transport | `runAdvisorConsultation`, `advisorFlagErrorHint` |
| Advisor retries | `runAdvisorWithRetries`, `advisorDelay` |
| Advisor steering UI | `createAdvisorSteerModal`, `showAdvisorSteerModal` |
| Advisor tool | `pi.registerTool(ADVISOR_TOOL_NAME, ...)` in `bro(pi)` |

## Current behavior

### Explain

Built-in modes are `brief`, `balanced` (default), and `faithful`. Settings live at `~/.pi/agent/bro-settings.json`, or under `PI_CODING_AGENT_DIR`; missing mode/show-turn/overrides fields migrate to defaults. A valid `~/.pi/agent/bro-prompt.md` containing `{{response}}` exactly once fully overrides built-in explanation modes. It does not affect Show or Btw.

Supported documents are workspace-local `.md`, `.markdown`, `.txt`, `.pdf`, and `.docx`; max 10 MiB input and 100,000 extracted characters; no OCR. Web input is one public HTML/XHTML page; max 5 MiB download, 100,000 extracted characters, five redirects, no credentials, private/reserved addresses, scripts, login, paywalls, pagination, or media understanding.

### Config

`model`/`effort` at the settings root are the shared default; `/bro model` and `/bro effort` only ever touch this shared pair. `overrides.<explain|show|btw|advisor>` each hold a full `{ model, effort }` pair, never a partial one — a capability either fully inherits the shared default or fully pins its own model+effort. `withCapabilityOverride` stores exactly the pair it is given and clears one only via an explicit `undefined` (the "Default" selection) — it does **not** drop an override just because it happens to match the shared default: a pin must survive the default later changing. `settingsPayload` omits an empty `overrides` object from disk entirely (so pre-override settings files round-trip byte-for-byte) but never deduplicates individual entries.

`/bro config` (`showBroConfigModal` → `createConfigModal`) is the only place overrides are written; it reuses the same framed `SettingsList`/`SelectList` overlay pattern as the rest of Bro's modals. Persistence is serialized: only one `persistSettings` call is ever in flight, a change made while one is running is coalesced into a single pending slot (never queued more than one deep) and fires the moment the in-flight write settles, so the file always converges on the latest state without ever writing concurrently or out of order. A rejected save reverts the in-memory settings (and every displayed row) to the last state actually confirmed on disk and shows the error inline until the next successful save. A submenu's Esc cancels with no mutation (library-level: `done()` with no argument never calls `onChange`); the settings screen's own Esc defers closing until any in-flight/coalesced save settles, then closes only if that save succeeded (a failure cancels the pending close so the notice stays visible). `resolveModelEffort` is the single place that normalizes a `{model, effort}` pair against the live Agy catalog (handling suffixed variant ids and fixed-effort models) — used for the shared default, every capability's effective settings, and Doctor's per-capability checks. `effortDisplay` turns a resolved pair into `"unavailable"` (no family found), `"fixed"` (family found, no configurable efforts, effort is `"default"`), or `` `${effort} (unsupported)` `` (anything else the resolved family doesn't actually support) — never silently shows an unhealthy state as `"fixed"`. An effort-only edit on an inherited capability always pins `resolveModelEffort(...).family.id`, never the raw `settings.model`/existing override string, so a suffixed shared default (e.g. from `PI_BRO_MODEL=gemini-x-low`, stored as `{ model: "gemini-x-low", effort: "default" }`) can't produce a self-contradictory override. `createConfigModal` takes settings/catalog/persist as plain arguments specifically so it can be driven in tests without a real Agy process or settings file.

`advisor` is now a real capability, folded into `CAPABILITIES` alongside explain/show/btw (there is no more separate "configuration-only" tier): its `/bro config` rows use the same mechanics, `doctorReport`'s per-capability loop validates it, and `capabilityPair(settings, "advisor")` feeds the real Agy invocation in `runAdvisorConsultation`. See "Advisor" below.

### Advisor

`bro_advisor` is an LLM-callable tool (`pi.registerTool`), not a slash command — the *executor* calls it, not the human. It is registered once at extension load exactly like any other tool and has **no on/off activation state of its own** — bro.ts never calls `pi.setActiveTools()` for it. Whether the executor can actually call it is purely a function of this host's own tool restrictions (`pi.getAllTools()` / `pi.getActiveTools()`), which bro.ts only ever reads. `/bro advisor` (bare, no arguments) is a one-line notice of that observed availability, pointing at `/bro config`, `/bro advisor-steer`, and `/bro doctor`; any old `on`/`off`/`status` argument gets an actionable removal notice instead of being silently accepted or misparsed. `/bro doctor` carries the full diagnostic — host exposure, actual activation, resolved model/effort (via the shared `CAPABILITIES` loop), steering presence, and the Agy compatibility floor (`advisorAgyCompatible`, `agy update` action below 1.1.15). There is no separate `bro_advisor_status` tool or `/bro advisor status` command anymore — everything it used to report now lives only in Doctor. A session may still carry a historical `bro-advisor-active` custom entry from before this simplification; `resolveAdvisorState` silently ignores it. One free-text steering brief is stored as a session `custom` entry (`bro-advisor-steering`), written via `pi.appendEntry` (never `ctx.sessionManager.appendCustomEntry` — that method doesn't exist on the read-only `ReadonlySessionManager` extensions actually receive). `resolveAdvisorState(branch)` walks `ctx.sessionManager.getBranch()` (root-to-leaf) and takes the *last* matching steering entry — "latest wins" — which gives persistence-across-resume, fork-inheritance, and independent-post-fork-edits all for free, since a fork clones the branch's entries into a new file and any new entry only ever lands on the branch it was appended to. It is re-read inside the tool's own `execute()` on every call; there is no `session_start`/`session_tree` refresh to run anymore, since there is no active-tools gate left to keep in sync.

`buildAdvisorSnapshot(ctx, pi)` captures the executor's system prompt, active tools, and the branch's built context entries (`buildContextEntries()`) into harness-neutral plain text — unlike Show, it *includes* tool calls/results (rendered as `[tool call] name(args)` / `## tool result: name`), and omits image/reasoning content with an explicit `[image omitted]`/`[reasoning omitted]` note rather than silently dropping it. `custom` entries (including the advisor's own steering, and any historical activation entry) are always skipped when building the snapshot — the same rule that keeps them out of LLM context. No Bro-imposed size cap.

`runAdvisorConsultation` spawns `agy --dangerously-skip-permissions --output-format stream-json --input-format stream-json --model <model> [--effort <effort>] --print-timeout 10m` in the **real workspace** (`ctx.cwd`, not a scratch temp dir like explain/show/btw), writing `{"event":"user","message":{"content":<prompt>}}\n` to stdin and reading NDJSON `result` events from stdout — confirmed against a real, tested sibling implementation (`pi-flow-external/src/core/agy.ts`), not guessed. `advisorFlagErrorHint` turns an old-CLI `flag provided but not defined: -input-format` stderr into an actionable "needs Agy 1.1.15+" message. `runAdvisorWithRetries` retries an invocation *failure* (not a completed "needs more evidence" answer) with the identical prompt: wait 5s, retry; wait 10s, retry; then rethrow Agy's own diagnostic verbatim. It emits elapsed running/retry-countdown updates and clears their timers on completion/cancellation. Every attempt is a fresh process — `--conversation` is never used here, unlike `/bro btw`. A completed tool result prepends two executor-visible provenance lines (model/effort, actual attempts, duration, cwd, steering presence, snapshot characters, no Bro truncation, and omission/compaction notes) and preserves the complete advisor answer below them.

`/bro advisor-steer` (`showAdvisorSteerModal` → `createAdvisorSteerModal`) reuses `/bro config`'s framed-box shell around a `pi-tui` `Editor` (the main prompt composer's own multi-line component) instead of `SettingsList`. Unlike `/bro config`'s save-on-every-change, this is free text: Ctrl+S saves the current draft and stays open; Enter and Shift+Enter insert newlines; Ctrl+K clears the saved brief and draft and stays open; Ctrl+C copies the complete current draft, including unsaved edits; Esc closes without saving unsaved edits. Saved/Cleared/Copied and error feedback is inline, and pending clipboard completion cannot update a disposed modal. All other input stays with the native editor.

The advisor tool intentionally supplies `renderCall`/`renderResult`: the call, elapsed progress, retry countdowns, and completed provenance stay compact and visible; expanding a consultation renders the full Markdown response. This is approved transcript rendering, not an advisor modal or a runtime behavior change.

See `docs/plans/2026-09-19-bro-advisor-design.md` for the full design and rationale.

### Show

`/bro show` defaults to one session turn (`showTurns` is editable in settings). It captures only user and assistant text from the current branch. Tool calls, tool results, reasoning, images, aborted assistant messages, and non-message entries are omitted. Every assistant text message in a turn is retained. Payloads are JSON-quoted; oldest whole turns are dropped to stay within the 100,000-character budget.

The prompt is developer-facing and separate from explanation prompts. It prioritizes user-visible outcome, then system/data/state effects, then component/file relationships. It must distinguish reported conversation claims from independent verification. A final self-contained `html` fence is written to a per-user `/tmp/pi-bro-<uid>/` directory with defense-in-depth CSP; **O** opens it. Show results are otherwise terminal Markdown shapes.

### Btw

`/bro btw` starts or resumes an in-memory side thread (Agy `--conversation`, Claude/Grok `--resume`). First-turn context seeds up to eight recent conversation-only turns, capped at 40,000 characters, unless `--fresh` is used; the seed is kept on the thread. A thread starts conversation-only; the exact composer command `/mode` toggles full permission and keeps the transcript (`--full`/`--sandbox` were removed and are rejected with a `/mode` hint). Conversation-only Agy runs sandboxed in an empty temporary directory for two minutes; full permission runs in the workspace with dangerous permission bypass and a ten-minute timeout. Claude/Grok run btw in the workspace for both modes and resume one native session across switches; an Agy conversation stays bound to its original workspace, so `nativeBtwContinuation` drops it on an access change and the next turn reseeds a fresh session with the seed plus the whole transcript (`buildBtwPrompt` `history`). The same reseed applies whenever a thread has turns but no native id. In the composer, `/copy` and `/copy-all` copy the latest answer or full thread to the system clipboard; `/insert` and `/insert-all` write to the main editor without submitting (with force variants `/insert!` and `/insert-all!` replacing a nonempty draft); `/retry` (or empty Enter) re-asks; `/clear` resets the thread. Only these exact commands trigger composer actions; there are no `/send` aliases, and any other slash-prefixed or text input is submitted as a question.

## Safety and state boundaries

- Explain/show Agy calls use a fresh temporary directory and `--sandbox`.
- File paths are realpath-checked against the current workspace, including symlinks.
- Web DNS results are checked before requests and pinned for the request.
- URLs with credentials and HTTPS-to-HTTP redirects are rejected.
- Results and threads are process memory only; session changes clear them.
- `/bro open` reopens the latest remembered result without a new model call.

## Tests and evaluation

```sh
npm test
npm run typecheck
npm run benchmark:dry-run
npm run benchmark:dry-run -- --track show
npm pack --dry-run --json
node .github/scripts/release-utils.mjs selftest
```

`npm test` runs TypeScript checking, 38 Node tests, and `smoke-test.sh`. The smoke test compiles/imports `bro.ts`, runs Pi offline RPC with a fake Agy, checks routing, extraction boundaries, prompt/settings behavior, Show capture, HTML handling, failure containment, the advisor's real stdin/stream-json transport against a temporary fake `agy` executable, and real Pi load/reload/fork exposing and activating `bro_advisor` (including with a historical, now-ignored `bro-advisor-active` entry present) plus host exclusion without a paid call; it also confirms Bro output — including the advisor's steering brief — never enters session/model context.

The paid benchmark is manual: modes = 8 fixtures × baseline/brief/balanced/faithful = 32 calls; Show = 10 calls. It requires an exact printed fingerprint, performs Agy usage preflight, runs calls in fresh temporary directories, saves atomically, resumes settled results, and never auto-retries paid failures. Raw results are ignored under `benchmark/.work/`.

## Release rules

Runtime/prompt/package changes require a version bump and matching `CHANGELOG.md` section unless explicitly labelled `release:none`. CI validates the bump against npm. Merging to `main` triggers idempotent tag, npm trusted publishing with provenance, and GitHub release creation. See `.github/scripts/release-utils.mjs` and `.github/workflows/`.

## Historical traps

These are superseded and must not be treated as current behavior:

- Show is **not** a fourth `visual` mode.
- Current Show capture does **not** include tool calls or tool results.
- Show defaults to **one** turn, not ten.
- Explanation modes no longer have fixed word targets.
- Btw handoff is insert-to-editor (`/insert`, `/insert-all`), not submit-to-main-agent, while `/copy`/`/copy-all` target the system clipboard.
- `docs/plans/2026-09-07-bro-show-visual-design.md` is historical; its opening note and changelog describe the current conversation-only change.
- Decomposition fixtures under `benchmark/fixtures/decomposition/` mostly predate conversation-only Show capture; use the hand-authored conversation-only fixture as the current-format example.
- `/bro config` (`showConfigSpikeModal`) is **not** a preview/spike anymore: it is production, persists real settings, and drives explain/show/btw/advisor.
- `agySelection` and `resolveCatalogSettings` no longer take a full `BroSettings`; they operate on a plain `{ model, effort }` pair (`ModelEffortPair`), resolved per capability via `capabilityPair`/`resolveModelEffort`.
- `advisor` is **not** configuration-only anymore: it has a real command (`/bro advisor`), a real tool (`bro_advisor`), and a real Doctor check. There is no more separate `CONFIGURABLE_CAPABILITIES` vs. reserved-`advisor` split — `CAPABILITIES` covers all four uniformly.
- `bro_advisor` has **no** on/off activation state, no `/bro advisor on|off|status`, and no separate `bro_advisor_status` tool anymore. It is registered unconditionally at load and gated only by the host's own tool restrictions; a historical `bro-advisor-active` session entry is silently ignored. `/bro doctor` is the one place its exposure/activation/model/effort/steering/compatibility are reported.
- `ctx.sessionManager` is **read-only** (`ReadonlySessionManager`) — it has no `appendCustomEntry`/`appendCustomMessageEntry`. Extension state writes go through `pi.appendEntry`/`pi.sendMessage`.

## Known seams to check before related work

1. `lastResult` remembers only source/text, so `/bro open` cannot restore Show HTML metadata or the Show-specific retry prompt/steering.
2. `parseShowArguments` treats any whitespace-delimited first token that looks like a number as the requested turn count; README reflects this rule and illustrates passing an explicit turn count (e.g. `/bro show 1 404 handler`) when steering on phrases starting with digits.
3. Btw relies on the backend returning a native session ID; without one, the next turn reseeds a fresh session with the full displayed history.
4. Btw cancellation/retry/clear behavior is mostly helper-tested, not fully exercised through an interactive TUI lifecycle.
5. HTML extraction is more permissive than the prompt contract: runtime takes the last matching HTML fence rather than validating exactly one final fence.
6. A per-capability override always pins both model and effort together (an atomic pair), even when the user only meant to change one of them from `/bro config`, and even when the pair happens to equal the shared default at the moment it's set. Once set, that capability stops tracking future shared-default changes until its override is explicitly cleared back to "Default". This is a deliberate simplification, not a bug — see "Config" above.
7. `/bro config`'s interactive modal is only exercised through a fake-`ctx`/fake-catalog harness in `smoke-test.sh` (mirroring the earlier spike's approach), not through the RPC session harness — RPC prompts cannot drive raw keystrokes into a custom overlay. A separate RPC-based smoke-test block verifies `explain`/`show` overrides reach the real Agy subprocess arguments (not just the pure `capabilityPair`/`agySelection` composition); `btw` can't be driven that way (it requires `ctx.mode === "tui"` plus an interactive composer), so its wiring is covered only at the pure-helper level. Real filesystem persistence of `model`/`effort`/`mode` is covered end-to-end via `/bro model`/`/bro effort`/`/bro mode` in the RPC harness; per-capability `overrides` persistence through the *modal itself* is covered only at the unit level (fake `persistSettings`), not through a real settings file.
8. `bro_advisor` is an LLM-callable tool, not a slash command — there is no way to drive "the executor model decides to call it" through the offline, prompt-only RPC harness (same category of gap as `btw`'s interactive composer). Its `execute()` logic is instead covered by directly invoking the registered tool against a real fake-`agy` subprocess, while real `AgentSession` tests cover load/reload/fork exposure and activation (including a historical false entry and a real host exclusion). `ctx.ui.custom(...)` modal *bodies* (doctor/help/config/advisor-steer) remain invisible to the RPC harness — only `notify()` messages and session entries stream out — so their text is covered through the shared formatting/state helpers.
9. `--session <path>` in the offline RPC harness only persists to disk when resuming an *existing* file (one with at least a valid header line already written) — pointing it at a brand-new path keeps the session in-memory-only for that run, even though `entry_appended` RPC events still stream out normally. Every RPC smoke-test block that later re-reads the session file pre-creates it with a header line first (see the existing `session_file`/`printf '{"type":"session"...}'` pattern, and the advisor block that copies it).
10. `SessionEntry`'s `CompactionEntry` in the currently installed `@earendil-works/pi-coding-agent` does not expose `retainedTail` to extensions (the field is documented in `session-format.md` but absent from the installed `.d.ts`) — `buildAdvisorSnapshot` only renders a compaction entry's `summary`, relying on `buildContextEntries()` to have already included the real entries that came after the compaction point.

## Future-agent starting sequence

1. Read this file, then `README.md` and the latest `CHANGELOG.md` entry.
2. Inspect the relevant symbols in `bro.ts` and `prompt.ts`; do not trust superseded plan text without checking current code.
3. Decide whether the feature is Explain, Show, Btw, or shared infrastructure; preserve their distinct input, state, and prompt semantics.
4. Trace all callers and state lifetimes before editing. Prefer the smallest existing path.
5. Run focused tests first, then `npm test`; use live Agy only when the feature genuinely needs provider validation.
