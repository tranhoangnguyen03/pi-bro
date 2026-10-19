# Agent second opinions (Advisor)

[Docs home](../README.md) · [All commands](../reference/commands.md) · [Safety and permissions](../reference/data-and-permissions.md)

## Bro advisor

`bro_advisor` is a tool the **executor agent** — not you — can voluntarily
call mid-task for a second opinion. Unlike `/bro btw`, which is a side
conversation for you, `bro_advisor` is a tool for the model you're working
with; it shows up as a normal tool call/result in the transcript, not a
modal. It is registered like any other tool when the extension loads and has
no on/off switch of its own — whether the executor can actually call it
depends entirely on this host's own tool restrictions.

`/bro advisor` is a quick notice of whether `bro_advisor` is available right
now, pointing at `/bro config`, `/bro advisor-steer`, and `/bro doctor`.
`/bro doctor` has the full diagnostic: whether this host exposes and
activates `bro_advisor`, its resolved backend/model/effort, steering
presence, and backend compatibility (for Agy, a minimum CLI version with an
`agy update` action when it is too old).

- **Automatic context, no prep needed**: the executor does not need to assemble
  a summary. Bro captures a harness-neutral snapshot — the executor's system
  instructions, its active tools, and the conversation so far including tool
  calls and results — and sends it, along with an optional `question` the
  executor may pass, to a **fresh, standalone process of the selected
  backend** for every consultation. Nothing is resumed or reused across calls,
  including retries.
- **Instructed to investigate, not implement**: the advisor process has real
  tool access in the workspace with permissions auto-approved — there is no
  enforced read-only isolation. It is instructed to verify claims itself and
  return advice, leaving edits to the executor, but that boundary is a
  behavioral prompt instruction rather than an enforced sandbox constraint, so
  treat its findings as advice to verify, not a guaranteed hands-off review.
- **Steering**: The advisor reads standing priorities from `~/.pi/agent/bro-advisor.md`
  and session-specific priorities from `/bro advisor-steer`.
  `/bro advisor-steer` opens an editor for one session steering brief — e.g. "quick
  prototype; keep A and B careful, everything else minimal". Session steering takes
  precedence over durable standing defaults where they conflict.
  **Ctrl+S** saves and keeps the editor open; **Enter** or **Shift+Enter** inserts
  a newline; **Ctrl+K** clears both the saved session brief and draft while staying open;
  **Ctrl+C** copies the entire current draft, including unsaved edits; and **Esc**
  closes without saving unsaved edits. Neither steering source is **ever added to Pi's
  conversation or sent to the main model** — the advisor is the only thing that reads them.
- **Persistence**: standing defaults persist across all sessions in `~/.pi/agent/bro-advisor.md`.
  The session steering brief persists with the Pi session as custom extension data in the
  session file (`bro-advisor-steering`) and is restored on resume or reload. Forking a
  session inherits session steering; edits made after the fork are independent of the
  original branch. Clearing session steering leaves durable steering intact.
- **Retries**: on an invocation failure (not a completed answer — "I need
  more evidence" is a normal result, not a failure), Bro retries with the
  identical snapshot, steering, and question: once after 5 seconds, once more
  after 10 seconds, then returns the backend's own diagnostic — including a
  context-length error, verbatim — as the failure. Host-imposed deadlines and
  cancellation are terminal: neither starts another attempt or a backoff wait.
  The advisor CLI is asked to stop at 10 minutes; Bro's host deadline is 610
  seconds plus bounded process cleanup. A CLI-reported error before that host
  deadline remains an invocation failure and can be retried.
  Cancelling the tool call skips any pending retry wait.
- **Progress and provenance**: while an attempt is running, Bro shows the last
  thing the advisor actually reported — a tool name or a user-facing response
  line, never hidden reasoning — and how long ago it arrived, e.g. `last
  reported: Read src/app.ts (2s ago)`, or "awaiting first activity" before
  anything arrives. Expanding a running consultation shows up to the last 4
  reported activity lines; each retry starts the trail over. The returned
  answer starts with backend, model, effort, attempt count, duration,
  workspace, steering presence, snapshot size, and known omission/compaction
  notes; the advisor's complete answer follows unchanged.
- **Model/effort**: resolved the same way as explain/show/btw, through
  `/bro config` (shared default or per-capability override).
