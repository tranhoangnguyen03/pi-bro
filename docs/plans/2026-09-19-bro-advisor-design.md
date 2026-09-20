# `/bro advisor`: an executor-callable tool backed by a fresh Agy consultation

> **Simplified (still pre-release):** the on/off activation state machinery this doc originally
> described (`/bro advisor on|off|status`, a separately registered `bro_advisor_status` tool,
> `pi.setActiveTools()` refreshes on `session_start`/`session_tree`) was removed before this feature
> ever shipped. `bro_advisor` is now registered unconditionally at extension load, exactly like any
> other tool, and is gated only by the host's own tool restrictions — bro.ts never calls
> `pi.setActiveTools()` for it. The sections below describe the current design; historical framing
> that referenced the removed on/off state has been updated in place rather than kept as a
> superseded record, since nothing here ever reached a release.

## Goal

Give the main executor agent a voluntary `bro_advisor` tool: a fresh, standalone Agy process that
investigates the workspace with real tool access and returns advice, informed by an automatically
captured, harness-neutral snapshot of the executor's own context and an optional human-set steering
brief. The advisor is instructed to investigate rather than implement and is never resumed across
calls, but it runs with real, unsandboxed tool access (`--dangerously-skip-permissions`) — "leave
edits to the executor" is a behavioral instruction, not an enforced restriction. The tool has no
on/off state of its own; whether the executor can call it depends entirely on this host's own tool
restrictions. The steering brief is session-scoped, human-controlled via `/bro advisor-steer`, and
never enters the main model's context.

## Roles

- **Human**: writes the steering brief (`/bro advisor-steer`) — the only durable way to inject
  project-specific priorities the executor itself may not know (e.g. "quick prototype; keep A and B
  careful, everything else minimal") — and can check `/bro advisor` for a quick availability notice
  or `/bro doctor` for the full diagnostic.
- **Executor**: calls `bro_advisor({question?})` when it wants a second opinion. It never assembles
  evidence — Bro captures its context automatically — and it remains responsible for implementation;
  the advisor's job is strictly advisory.
- **Advisor**: a fresh Agy process per consultation, with real (unsandboxed, permission-auto-approved)
  tool access to the workspace, instructed to investigate before advising and to return findings, not
  edits.

## Data model: session-scoped steering, never in LLM context

The steering brief is stored as a session `custom` entry — extension state that, per Pi's session
format, never participates in LLM context (only `custom_message` entries do):

```ts
const ADVISOR_STEERING_ENTRY = "bro-advisor-steering"; // data: { text: string }
```

Written via `pi.appendEntry(customType, data)`. `ctx.sessionManager` is **read-only**
(`ReadonlySessionManager`) and has no append methods — a real `SessionManager` instance is only
available inside `setup`/`withSession` callbacks of `newSession`/`fork`/`switchSession`, which bro.ts
does not use here.

`resolveAdvisorState(branch)` walks `ctx.sessionManager.getBranch()` (root-to-leaf order — the same
convention `latestAssistant` already uses) and takes the **last** matching steering entry: "latest
wins". This single rule gives three properties for free, with no fork-specific code:

1. **Persistence across resume/reload**: the entry is just there on the branch every time it's
   walked.
2. **Fork inheritance**: forking (`ctx.fork`) clones the branch's entries into a new session file
   (`createBranchedSession(leafId)` — "a new session file containing only the path from root to the
   specified leaf"). The forked branch's walk sees the same entries as the original, up to the fork
   point.
3. **Independent post-fork edits**: a new entry appended on one branch is only ever on that branch's
   file; the other branch's walk never sees it.

`resolveAdvisorState` is called fresh inside the tool's own `execute()` on every consultation — there
is no `session_start`/`session_tree` refresh to run, because there is no active-tools gate left to
keep in sync (see "Tool activation" below). A session may still carry a historical
`bro-advisor-active` entry from before this simplification (data: `{ active: boolean }`);
`resolveAdvisorState` does not look at that `customType` at all, so it is silently ignored.

## Tool activation: a static registration, gated only by the host

`bro_advisor` is registered once via `pi.registerTool(...)` at extension load, exactly like any other
tool bro.ts registers — there is no on/off preference, and bro.ts never calls
`pi.setActiveTools()` for it. Whether the executor can actually call it is purely a function of this
host's own tool exposure and activation (`pi.getAllTools()` / `pi.getActiveTools()`), which bro.ts
only ever reads:

```
bro_advisor exposed by the host && in pi.getActiveTools()  -> the executor can call it
otherwise                                                   -> it isn't available right now
```

`/bro advisor` (bare, no arguments) reports that observed availability in one line and points at
`/bro config`, `/bro advisor-steer`, and `/bro doctor` — it does not claim success or failure of an
action, since there is no action to take. Any old `on`/`off`/`status` argument gets an actionable
notice that those controls were removed, rather than being silently accepted, misparsed as pasted
text, or ignored. `/bro doctor` carries the full diagnostic: host exposure, actual activation,
resolved model/effort (through the same `CAPABILITIES` loop every other capability uses), steering
presence (never the brief text), and the Pi/Agy compatibility floor. There is no separate
`bro_advisor_status` tool or `/bro advisor status` command anymore — everything they used to report
now lives only in Doctor, which also parses the installed Agy version and fails with an `agy update`
action below 1.1.15.

Note: `pi.setActiveTools()` (and `getActiveTools()`) cannot be called synchronously during extension
load ("Action methods cannot be called during extension loading") — this no longer matters here,
since bro.ts never calls `setActiveTools()` for `bro_advisor` at all; `getActiveTools()`/`getAllTools()`
are only ever read, on demand, from `/bro advisor` and `/bro doctor`.

## Context snapshot: harness-neutral, not a Pi object dump

`buildAdvisorSnapshot(ctx, pi)` renders three sections as plain text:

1. **System instructions** — `ctx.getSystemPrompt()`.
2. **Active tools** — `pi.getAllTools()` filtered by `pi.getActiveTools()` (excluding `bro_advisor`
   itself), as `- name: description`.
3. **Conversation so far** — `ctx.sessionManager.buildContextEntries()` (the branch with compaction
   already resolved to `compaction entry + kept tail`, not yet converted to LLM messages), converted
   entry-by-entry:
   - `message` → `## user` / `## assistant` / `## tool result: <name>`, with assistant `toolCall`
     blocks rendered as `[tool call] name(args)` and image/thinking content noted as
     `[image omitted]` / `[reasoning omitted]` rather than silently dropped.
   - `compaction` → `## compacted earlier context` + the compaction's own summary (real entries after
     the compaction point are already included as their own array entries — nothing else to add;
     the installed SDK version's `CompactionEntry` does not expose `retainedTail` to extensions).
   - `branch_summary` → `## abandoned branch summary` + summary.
   - `custom_message` → `## extension message: <customType>` (another extension's in-context message,
     if any).
   - `custom` → **skipped entirely**. This is the same rule that keeps steering out of LLM context,
     and it means our own `bro-advisor-active`/`bro-advisor-steering` entries can never leak into a
     snapshot even by accident.

Unlike `/bro show` (conversation text only, tool calls/results/reasoning/images always omitted by
design — see `docs/plans/2026-09-07-bro-show-visual-design.md`), the advisor snapshot **includes**
tool calls and results: the advisor needs to see what the executor actually did, not just what it
said, to verify claims rather than rubber-stamp them.

No Bro-imposed size cap, no semantic summarization of the snapshot by Bro. If it doesn't fit in the
model's context, that surfaces as Agy's own error (see Transport/Retries below) — not a silent
truncation invented here.

## Prompt assembly: four labeled, separated sections

`buildAdvisorPrompt(steering, snapshot, question)` (prompt.ts) keeps four things structurally
distinct so the advisor knows exactly what kind of claim each part is:

1. **Human steering brief** — labeled as the human's stated priority, "not something verified against
   the code".
2. **Context snapshot** — labeled as the executor's own account, "not independently verified by you".
3. **Executor's question** — optional; when absent, the advisor is told to use its own judgment.
4. **Role instructions** — real tool access, `--dangerously-skip-permissions`, investigate before
   advising, return findings, never edit files (behavioral, not enforced sandboxing — the advisor
   genuinely can write files; this is an instruction, and the tool's own description says so honestly
   rather than implying isolation that doesn't exist). The final response must begin with a one-line
   answer/verdict and omit investigation narration, waiting updates, and progress reports.

## Transport: `agy --input-format stream-json` over stdin

Confirmed against a real, tested sibling implementation
(`pi-flow-external/src/core/agy.ts`, `pi-flow-external/test/agy-backend.test.ts`) and locally against
`agy --help`, not guessed:

- Args: `--dangerously-skip-permissions --output-format stream-json --input-format stream-json
  --model <model> [--effort <effort>] --print-timeout 10m`. No `--print`/`--sandbox` — the prompt goes
  over stdin instead of argv, which is what avoids an ARG_MAX risk for a large, uncapped snapshot.
- stdin: written once and closed — `{"event":"user","message":{"content":<prompt>}}\n`.
- stdout: NDJSON events. `{event:"result", result:{status, response, error, usage}}` is the only
  terminal event this code reads; `status !== "SUCCESS"` or a missing `response` string is a failure,
  reported with Agy's own `error` text verbatim.
- A clean exit with **no** `result` event is itself an error ("agy exited without a terminal result
  event" + stderr).
- Older `agy` binaries reject `--input-format` with Go's flag-package usage dump
  (`flag provided but not defined: -input-format`) and exit before running anything —
  `advisorFlagErrorHint` turns that into "installed Agy CLI is too old; needs Agy 1.1.15+ ... run
  `agy update`" instead of a bare "no terminal result".
- A single stdout line with no newline is bounded at 2,000,000 characters (a protocol-break guard,
  not a real response-size limit) to avoid unbounded buffering on a runaway stream; exceeding it kills
  the child and fails clearly.
- `cwd` is the real workspace (`ctx.cwd`), not a scratch temp directory — the advisor needs to operate
  on the actual project, unlike `/bro text`/`/bro show`'s sandboxed scratch-dir Agy calls.

## Retries: fixed backoff, no silent fallback

`runAdvisorWithRetries(prompt, selection, cwd, signal, consult?, delayFn?)`: on an invocation failure
(process/protocol error — **not** a successful advisor response that says "I need more evidence",
which is a normal result, not a failure) it retries with the *identical* snapshot/steering/question:
wait 5s, retry; wait 10s, retry; on a third failure, rethrow the last error verbatim (including any
context-length wording from Agy) so the executor sees the real diagnostic. `consult`/`delayFn` are
injectable so tests exercise the sequencing deterministically, without real waits or real Agy
processes. The same loop emits elapsed running status and a retry countdown carrying the last named
failure; every interval/timeout is cleared when its attempt, delay, or cancellation settles.
Cancellation (`AbortSignal`) aborts the in-flight child immediately and — because the delay promise
rejects on abort — propagates straight out of the retry loop instead of being retried as an ordinary
failure. Every attempt, including retries, is a fresh Agy process; `--conversation` (session
resumption) is never used here.

## UI

- **`/bro advisor`**: a single `ctx.ui.notify` reporting whether `bro_advisor` is exposed and active
  right now, pointing at `/bro config`, `/bro advisor-steer`, and `/bro doctor`. No modal, no session
  write. Any argument (an old `on`/`off`/`status`, or anything else) gets a separate actionable notice
  that those controls were removed, instead of a silent no-op or a misparsed pasted-text fallback.
- **`/bro doctor`**: the one place host exposure, actual activation, resolved model/effort, steering
  presence, and Agy compatibility are all reported together for the advisor, alongside the same
  checks for explain/show/btw.
- **`/bro advisor-steer`**: reuses `/bro config`'s framed-box `ctx.ui.custom(...)` shell, but around a
  `pi-tui` `Editor` (the same multi-line component the main prompt composer is built on) instead of
  `SettingsList`/`SelectList`. Unlike `/bro config`'s save-on-every-change model, steering is free
  text, so persistence only happens on an explicit gesture: **Ctrl+S** saves the current draft and
  remains open; **Ctrl+K** saves empty, clears the draft, and remains open; **Esc** closes without
  saving unsaved edits. **Enter** and **Shift+Enter** insert newlines, while **Ctrl+C** copies the
  complete current draft (including unsaved edits) and remains open. Saved/Cleared/Copied and error
  feedback is visible inline; clipboard completion is ignored after disposal. Other keys delegate
  to the native editor. `Editor` only touches `tui.requestRender` and `tui.terminal.rows` on the
  `TUI` object it's given.
- **Tool result rendering**: the registered tool intentionally uses custom `renderCall` and
  `renderResult` hooks. The call/question and elapsed investigation/retry state remain compact and
  visible. A completed consultation collapses to model/attempts/duration; expanded
  content includes executor-visible provenance (model, effort, actual attempts, total duration,
  cwd, steering included, snapshot characters, no Bro truncation, and omission/compaction note),
  followed by the advisor's complete response unchanged.

## Wiring into `/bro config`

`advisor` was already schema-reserved in `BroSettings.overrides` from the prior config slice
(`docs/plans/2026-09-19-bro-config-shared-defaults-and-overrides.md`). This change makes it a real
capability: folded into `CAPABILITIES` (no more separate "configurable" vs. "reserved" split), the
"Configuration only — not implemented yet" notice removed from its config-modal rows, and
`doctorReport`'s per-capability loop now validates its resolved model/effort like explain/show/btw.
`capabilityPair(settings, "advisor")` + `resolveModelEffort` + `agySelection` is the same resolution
path every other capability uses — no parallel model/effort logic for the advisor.

## Testing

- **Pure logic** (`smoke-test.sh`'s wheel-build Node section): `resolveAdvisorState` against
  hand-built branch fixtures (latest-wins, malformed-entry tolerance, a historical
  `bro-advisor-active` entry silently ignored, and a fork-isolation fixture — two arrays sharing a
  prefix, diverging after); `buildAdvisorSnapshot` against a fake `ctx`/`pi` covering every entry
  kind including the "never leaks `custom` entries" guarantee; `advisorFlagErrorHint`;
  `runAdvisorWithRetries` with an injectable fake `consult`/`delayFn` (immediate success,
  retry-then-success, exhausted-after-three, pre-aborted signal, cancellation mid-backoff).
- **Real transport** (`runAdvisorConsultation` against a real, temporary fake `agy` executable on
  `PATH`, no live paid call): success (asserting the exact argv and exact stdin envelope), an `ERROR`
  terminal status, the old-CLI flag-rejection hint, the oversized-line guard, and cancellation
  actually killing the child.
- **Component interaction** (`createAdvisorSteerModal` driven the same way `createConfigModal`
  already is): raw keystrokes cover Ctrl+S save-and-stay-open, Enter/Shift+Enter newlines, Esc
  close-and-discard, Ctrl+K clear-and-stay-open, Ctrl+C full-draft copy, clipboard rejection, and
  clipboard completion after disposal. Clipboard tests inject a fake copy function and never touch
  the real clipboard.
- **Real Pi session, offline RPC harness**: an old `on`/`status`/extra argument to `/bro advisor`
  end to end against a real `pi` process, asserting the actionable removal notice; the bare form
  reporting availability truthfully both with and without a real `--exclude-tools bro_advisor`
  host restriction.
- **Real `AgentSession` lifecycle** (`createAgentSession` directly, not through the RPC layer):
  `bro_advisor` stays exposed and active across load, reload, and a real forked branch (two branches
  sharing a root entry, diverging after it) even when a historical `bro-advisor-active: false` entry
  is present, and a real `excludeTools: ["bro_advisor"]` host restriction is honored throughout.
- **Known gap**: `ctx.ui.custom(...)` modal bodies (help/doctor/config/advisor-steer) are not
  observable through this offline, prompt-only RPC harness — only `notify()` messages and session
  entries are. `bro_advisor` itself is an LLM-callable tool, not a slash command, so a full
  "executor model decides to call the tool" path cannot be driven through this harness either (same
  limitation `/bro btw` already has, documented in the existing config-slice smoke tests). Both gaps
  are covered instead by testing every component `execute()` actually calls
  (`resolveAdvisorState`, `buildAdvisorSnapshot`, `runAdvisorWithRetries`/`runAdvisorConsultation`)
  directly, plus the real `AgentSession` lifecycle coverage above for exposure/activation.
