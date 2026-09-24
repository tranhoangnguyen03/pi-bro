# pi-bro

Turn a dense AI reply, pasted text, local document, or public webpage into a
plain-language explanation — or open a sandboxed side conversation with
`/bro btw` — without adding anything to your main agent's context.

`pi-bro` is an extension for [Earendil Pi](https://github.com/earendil-works/pi).
It opens explanations in a separate modal and uses the
[Google Antigravity CLI](https://antigravity.google/docs/cli-install) (`agy`)
with your selected model. Claude Code is also supported for explain, show and
advisor; Agy remains the default and is required for BTW.

## Quick start

You need Earendil Pi `>=0.84.2 <1`, Node.js `>=22.19.0`, and `agy >=1.1.15`
installed and available on your `PATH`. Run `agy` once in your terminal to sign
in, then install Bro:

```sh
pi install npm:pi-bro
```

Restart Pi or run `/reload`, then try:

```text
/bro
/bro text Paste text here
/bro file docs/report.pdf
/bro url https://example.com/article
/bro btw "what file defines this route?"
```

Run `/bro doctor` after installation or whenever Bro is not working.

Explain, show, BTW and advisor share an internal execution layer; Agy remains
the default backend. Claude Code can be selected per capability in `/bro config`. Cancellation, host deadlines
and invalid execution streams terminate the subprocess group on POSIX, escalating
after a five-second grace period. Windows cleanup targets the direct child only;
descendant termination is not guaranteed. Unexpected signal exits are reported as
failures, not timeouts.

To install from GitHub instead, use
`pi install git:github.com/tranhoangnguyen03/pi-bro`. To try Bro without
installing it, use `pi -e npm:pi-bro`.

## What Bro can explain

| Source | Command | What Bro does |
| --- | --- | --- |
| Latest assistant reply | `/bro` | Explains the latest completed reply without adding the result to the conversation. |
| Pasted text | `/bro text <text>` | Explains text supplied directly in the command. |
| Local document | `/bro file <path>` | Extracts text from a workspace-local Markdown, text, PDF, or DOCX file. |
| Public webpage | `/bro url <url>` | Fetches one public HTML page and extracts its main readable content. |
| Recent session turns | `/bro show` | Draws the last turns' conversation text as shapes instead of prose (tool calls, tool results, reasoning, and images are omitted). |
| Any of the above, auto-detected | `/bro <input>` | Routes a lone URL to the webpage reader, an existing workspace file with a supported extension to the document reader, and anything else to pasted text. |

Pressing **R** simplifies the captured source again. These commands capture a
new source: `/bro text`, `/bro file`, `/bro url`, and `/bro show`. Giving `/bro` a URL, path, or
text directly captures a new source the same way.

## Commands

| Command | Description |
| --- | --- |
| `/bro` or `/bro text` | Explain the latest completed assistant response. |
| `/bro text <text>` | Explain pasted text. |
| `/bro <input>` | Explain it directly: a lone URL runs the webpage reader, an existing workspace file with a supported extension runs the document reader, and anything else is pasted text. A quoted path with spaces is routed too when the file exists. |
| `/bro file <path>` | Explain a workspace-local `.md`, `.markdown`, `.txt`, `.pdf`, or `.docx` file. |
| `/bro url <url>` | Explain one public, text-based webpage. |
| `/bro open` | Reopen the latest explanation without calling the simplifier again. |
| `/bro show [n-turns] [query]` | Draw recent session turns (default last 1) as shapes instead of prose, from user and assistant conversation text only — tool calls, tool results, reasoning, and images are omitted. An optional query steers what the shapes focus on, with or without a leading turn count. |
| `/bro doctor` | Check Bro's settings, Agy installation, account, model, effort, and mode. |
| `/bro usage [--provider agy]` | Show current Agy resource limits. |
| `/bro model [id]` | View or choose the selected backend’s shared default model. |
| `/bro effort [low\|medium\|high]` | View or choose the shared default reasoning effort. |
| `/bro mode [brief\|balanced\|faithful]` | View or choose the explanation mode. |
| `/bro config` | Open an interactive settings screen for the shared default model/effort, explain mode, show turns, and per-capability (explain/show/btw/advisor) model and effort overrides. |
| `/bro btw [--fresh] [--full] [question]` | Open a side conversation in a modal. Sandboxed (read-only) by default; `--full` lets it read and edit the workspace, `--fresh` skips main-session context. |
| `/bro advisor` | Quick notice of whether the executor's `bro_advisor` tool is available right now, pointing at `/bro config`, `/bro advisor-steer`, and `/bro doctor`. |
| `/bro advisor-steer` | View, edit, save, or clear the one persistent steering brief the advisor always sees. |
| `/bro help` | Open the built-in quick reference. |

Giving `/bro` the input directly works the same way:

```text
/bro https://example.com/article
/bro docs/report.pdf
/bro any other text is explained as pasted text
```

## Explanation modes

Bro treats the source as data, rejects embedded instructions, preserves its
language, and avoids adding facts, advice, or conclusions in every mode. Choose
a persistent mode with `/bro mode`:

- **`brief`**: Uses the original audience-led ELI-simpleton prompt with no fixed
  word target.
- **`balanced`**: The default. Keeps important details, conditions, warnings,
  context, code, and formatting while trimming fluff and repetition.
- **`faithful`**: Simplifies the language while preserving every claim,
  qualification, warning, number, command, code block, and formatting choice.

### Modal controls

- **Mouse wheel / trackpad**: Scroll in regular or fullscreen mode
- **↑ / ↓**: Scroll in any mode
- **C**: Copy the complete explanation
- **R**: Simplify the captured source or run the current Doctor check again
- **O**: Open the HTML diagram when a show reply contains one
- **Esc**: Close the modal, or cancel while Bro is working

Bro temporarily captures mouse input while its modal is open. Native mouse
selection may be unavailable or visually extend outside the modal depending on
your terminal mode; press **C** to copy the complete explanation reliably.

## Bro btw (side conversation)

`/bro btw` opens a separate multi-turn conversation in a modal, so you can ask
a quick side question while the main agent keeps working. It runs through Agy,
the same backend as the rest of Bro, and never adds anything to Pi's
conversation unless you explicitly insert it into the editor.

- **Sandboxed by default**: the side conversation is read-only (no project
  access). Add `--full` to let it read and edit the workspace.
- `/bro btw <question>` asks immediately; `/bro btw` opens an empty thread.
- `--fresh` starts a thread without seeding the main session's recent
  conversation text. Reopening without an access flag preserves the existing
  thread's access mode, including `--full`. Use `--sandbox` to return to sandbox
  mode; changing access mode starts a new thread. `--fresh` alone does not reset
  the access mode.
- The first turn is seeded with up to the last 8 turns of user/assistant
  conversation text (40,000 characters max, with a truncation notice); the
  side agent can also read the repo itself when running in `--full` mode.
- **In the modal**: type a question and press Enter (empty Enter re-asks the
  last question). Composer actions trigger only on these exact commands:
  - `/copy`: copies the latest answer to the system clipboard
  - `/copy-all`: copies the full thread to the system clipboard
  - `/insert`: inserts the latest answer into the main editor without submitting (use `/insert!` to replace an existing editor draft)
  - `/insert-all`: inserts the full thread into the main editor without submitting (use `/insert-all!` to replace an existing editor draft)
  - `/retry`: re-asks the last question (empty Enter does the same)
  - `/clear`: resets the thread
  Any other text or slash-prefixed input (such as `/send` or `/copy!`) is not a composer command and is submitted directly as a question to the side conversation. Esc closes the modal. A visible `full · edits repo` badge shows whenever `--full` mode is active.
- The thread lives in memory only — it clears when you switch Pi sessions,
  reload extensions, or quit Pi.

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
activates `bro_advisor`, its resolved model/effort, steering presence, and
the Agy compatibility floor — it also checks the installed Agy version and
gives an `agy update` action when it is too old.

- **Automatic context, no prep needed**: the executor never assembles a
  summary. Bro captures a harness-neutral snapshot — the executor's system
  instructions, its active tools, and the conversation so far including tool
  calls and results — and sends it, along with an optional `question` the
  executor may pass, to a **fresh, standalone process of the selected backend** for every
  consultation. Nothing is resumed or reused across calls, including retries.
- **Instructed to investigate, not implement**: the advisor process has real
  tool access in the workspace with permissions auto-approved
  (`--dangerously-skip-permissions`) — there is no enforced read-only
  isolation. It is instructed to verify claims itself and return advice,
  leaving edits to the executor, but that boundary is a behavioral prompt
  instruction rather than an enforced sandbox constraint, so treat its
  findings as advice to verify, not a guaranteed hands-off review.
- **Steering**: `/bro advisor-steer` opens an editor for one persistent
  steering brief — e.g. "quick prototype; keep A and B careful, everything
  else minimal" — that the advisor always reads. **Ctrl+S** saves and keeps
  the editor open; **Enter** or **Shift+Enter** inserts a newline; **Ctrl+K**
  clears both the saved brief and draft while staying open; **Ctrl+C** copies
  the entire current draft, including unsaved edits; and **Esc** closes without
  saving unsaved edits. Actions and clipboard errors are reported inline. The
  brief is stored as session-only extension data and is **never added to Pi's
  conversation or sent to the main model** — the advisor is the only thing
  that reads it.
- **Persistence**: the steering brief persists with the Pi session (not
  globally, not per project) as custom extension data in the session file and
  is restored on resume or reload. Forking a session inherits it; edits made
  after the fork are independent of the original branch. The advisor tool has
  no separate activation state persisted or toggled.
- **Retries**: on an invocation failure (not a completed answer — "I need
  more evidence" is a normal result, not a failure), Bro retries with the
  identical snapshot, steering, and question: once after 5 seconds, once more
  after 10 seconds, then returns Agy's own diagnostic — including a
  context-length error, verbatim — as the failure. Cancelling the tool call
  aborts immediately and skips any pending retry wait.
- **Progress and provenance**: while an attempt is running, Bro parses the
  advisor's own stream for the last thing it actually reported — either a
  tool name or a user-facing response line (hidden reasoning is never
  surfaced) — and shows it with how long ago it arrived, e.g. `last reported:
  Read src/app.ts (2s ago)`. Before Agy reports anything, this reads
  explicitly as "awaiting first activity from Agy" rather than guessing at
  what it might be doing. This is what was actually reported, not a live
  claim about Agy's current tool, and silence is never described as
  "stalled". Expanding a running consultation shows up to the last 4 reported
  activity lines. Each retry starts this trail over empty — a failed
  attempt's activity never carries into the next one. Elapsed running time
  still ticks once a second regardless of activity; a retry countdown with
  the last failure is shown the same way as before. The returned answer
  starts with model, effort, actual attempt count, duration, workspace,
  steering presence, snapshot size, no-Bro-truncation status, and known
  omission/compaction notes; the advisor's complete answer follows unchanged.
- **Model/effort**: resolved the same way as explain/show/btw, through
  `/bro model`/`/bro effort` (shared default) or `/bro config` (per-capability
  override).

See [docs/plans/2026-09-19-bro-advisor-design.md](docs/plans/2026-09-19-bro-advisor-design.md)
for the full design.

## Bro show

Where the explanation modes rewrite dense prose in simpler words, `/bro show`
changes the form: it draws what you and the assistant said in the last few
session turns as a shape instead of paragraphs. Capture keeps only user and
assistant conversation text, including every intermediate assistant message in
a turn — tool calls, tool results, reasoning, and images never leave the
session. It runs the same isolated, sandboxed model call and shows the result
in the same modal, never touching your conversation. `/bro show` uses its own
draw prompt; the explanation modes and `bro-prompt.md` do not affect it.

Because the draw model only ever sees conversation text, its shapes reflect
what was *reported* in the conversation — what the assistant said it did or
found — not an independent check against the actual code or system state.

Shapes are terminal-first: pseudocode, call trees, file trees, component
trees, diffs, and types and signatures. Bro picks the shape from what
happened in the session; there is no flag to request a specific one. When the source has no code structure
to draw, Bro falls back to a plain outline instead of forcing a diagram. A
reply that ends in one self-contained HTML block — layout, a state comparison,
anything where position itself carries meaning — is written to a file and
opened with **O**.

Pressing **R** redraws the same captured turns; running `/bro show` again
captures the latest turns afresh. `/bro show <n-turns>` overrides the default turn
count for a single run.

Add a query to steer what the shapes focus on, either after a turn count or on
its own: `/bro show what changed in the auth flow`, or `/bro show 3 what
changed in the auth flow`. The query is used as a lens on the captured turns,
not as additional evidence, and its casing is preserved as typed. Pressing
**R** retries with the same turn count and query.

Any leading whitespace-delimited word that looks like a number is treated as the
requested turn count: for example, `/bro show 3 what changed` captures 3 turns
and steers on "what changed", while `/bro show 404 handler` parses "404" as the
turn count and "handler" as the steering query. To steer on a phrase that starts
with digits while choosing a turn count, specify the turn count explicitly
first: `/bro show 1 404 handler` captures 1 turn and steers on "404 handler".
If the first word is not a number, the whole input is treated as the steering
query using the saved `showTurns` default.

### A slow session-create, traced

The agent followed a two-second delay from the handler down to the worker.
`/bro show` drew the chain:

```text
handleCreateSession(req)
├── validateRequest(req)
├── SessionStore.insert(req.body)
└── publish('session.created')
    └── AgentWorker.run(sessionId)
        ├── loadContext(sessionId)
        ├── callModel(context)
        └── persistResult(sessionId, result)
```

### The shape of code before it exists

A design discussion agreed on the data model ahead of implementation. `/bro
show` kept just the shape:

```typescript
interface Item { id: ItemId; parentId: ItemId | null }
interface Cursor { position: ItemId; direction: 'up' | 'down' }
function resolveTarget(items: Item[], cursor: Cursor): ItemId | null
```

### A layout that collapses at narrow widths

Text can't show a before/after layout change at a glance, so Bro ends with one
self-contained HTML block and **O** opens it (the terminal first shows
`[HTML diagram saved — press O to open]`):

<p align="center">
  <a href="https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-show-layout.png">
    <img alt="A before/after dashboard grid" src="https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-show-layout.png" width="720">
  </a>
</p>

<details>
<summary><strong>More shapes</strong></summary>

**Diff** — what changed in the save handler:

```diff
 on(save)
-  write content
+  if content is unchanged
+    return cached result
+  write new content
+  invalidate cache
```

**File layout** — where everything lives, for a refactor:

```text
src/
├── commands/           # user intents
│   ├── registry.ts
│   └── show-me.ts
├── sessions/           # state and lifecycle
│   ├── events.ts
│   ├── store.ts
│   └── worker.ts
├── transport/          # API
│   ├── client.ts
│   └── stream.ts
└── config.ts           # root config
```

**Component tree** — what the session page renders:

```text
SessionPage (apps/example/src/routes/session.tsx)
├── [hook] useSessionEvents
├── SessionToolbar (packages/ui)
│   └── RunSkillButton
└── SessionTimeline (packages/ui)
    └── SkillResultCard
```

**Pseudocode** — how scroll capture and restore work:

```text
capture(blocks, targetRect, scrollRect) -> Snapshot:
  target = focusedBlock ?? firstBlockIntersectingViewportTop(blocks)
  anchor = wholeBlockAnchor(blocks, target)
  offset = targetRect.top - scrollRect.top
  return { anchor, offset, scrollTop, revision + 1 }

restore(snapshot, blocks) -> number:
  placement = resolveAnchor(blocks, snapshot.anchor)
  if placement: return scrollRect.top + targetRect.top - snapshot.offset
  return snapshot.scrollTop
```

</details>

Prose in, outline out: a purely conversational session with no code to draw
degrades to a plain outline of the discussion — never a forced diagram.

## Bro in action

### Assistant response

**Before `/bro`: the original agent response**

[![A dense assistant response before Bro](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-response-before.png)](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-response-before.png)

**After `/bro`: the plain-language explanation**

[![The assistant response explained in the Bro modal](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-response-after.png)](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-response-after.png)

### Local document

**Before: a complex PDF**

[![A complex PDF before Bro](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-file-before.png)](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-file-before.png)

**After `/bro file <path>`**

[![The PDF explained in the Bro modal](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-file-after.png)](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-file-after.png)

Bro optimizes for understanding, not simply for fewer words. The written
examples below are synthetic and were run through Bro's default prompt. Click
a screenshot to see it at full size.

<details>
<summary><strong>Short:</strong> TypeScript says a value is <code>never</code></summary>

### Before

> The diagnostic is not evidence that `result` is intrinsically uninhabitable; it is an artifact of TypeScript's intraprocedural control-flow graph. Because `result` is initialized to `null` and only assigned inside the `forEach` callback, the outer scope does not model that callback as definitely executing. After `if (!result) return`, the remaining branch therefore collapses to `never`, producing the property-access error. Replace the callback-driven mutation with a control-flow-visible loop: `for (const item of items) { if (matches(item)) { result = item; break; } }`. Alternatively, derive the value expressionally with `const result = items.find(matches);` and guard `if (!result) return;` before dereferencing it. Avoid an `as Result` assertion; it suppresses the symptom while preserving the unsound state transition that caused the narrowing anomaly.

### After `/bro`

#### What happened

TypeScript showed an error saying your variable `result` cannot be used or
accessed.

This happened because `result` was set to `null` outside a `forEach` loop and
then modified inside the loop's helper function (callback). TypeScript tracks
code line by line. It cannot guarantee that code inside a `forEach` callback
will actually run.

#### What it means

Because TypeScript assumes the loop's callback might not run:

1. It believes `result` might still be `null`.
2. When you check `if (!result) return`, TypeScript thinks `result` can never
   hold a valid value after that check.
3. It sets the type of `result` to `never` (a special type meaning "impossible
   value") and blocks you from reading its properties.

The error is a limitation in how TypeScript analyzes loops with callbacks.

#### What you should do next

Choose one of these two fixes:

**Option 1: Use a standard `for...of` loop**

```ts
for (const item of items) {
  if (matches(item)) {
    result = item;
    break;
  }
}
```

**Option 2: Use `Array.prototype.find`**

```ts
const result = items.find(matches);
if (!result) return;
```

Avoid using a type assertion like `as Result`. It only hides the warning
without fixing the underlying tracking issue.

</details>

<details>
<summary><strong>Medium:</strong> Login succeeds, but the user is still logged out</summary>

### Before

> What you're observing is almost certainly not an authentication failure in the credential-validation layer; it is a post-authentication session persistence failure caused by an environment-dependent mismatch between Express's transport-security inference and the TLS termination topology in production.
>
> Locally, Express sees the request as plain HTTP and your development cookie configuration probably permits a non-secure session cookie. In production, however, the browser connects over HTTPS to Nginx, a load balancer, or an ingress controller, which terminates TLS and forwards the request to Node over HTTP. Unless Express trusts that intermediary, `req.secure` remains `false`, even when the proxy sends `X-Forwarded-Proto: https`. With `cookie.secure: true`, `express-session` can consequently decline to emit the cookie because it believes the originating request was insecure. The login route may still return `200`, making the credentials appear accepted, but the next request has no session identifier and is treated as anonymous.
>
> Configure proxy trust before registering session middleware, and make the cookie policy reflect whether the frontend and API are same-site or genuinely cross-site:
>
> ```js
> app.set("trust proxy", 1);
>
> app.use(session({
>   secret: process.env.SESSION_SECRET,
>   resave: false,
>   saveUninitialized: false,
>   proxy: true,
>   cookie: {
>     httpOnly: true,
>     secure: true,
>     sameSite: "lax",
>     maxAge: 1000 * 60 * 60 * 24
>   }
> }));
> ```
>
> Use `sameSite: "none"` instead of `"lax"` only when the browser must send the cookie in a cross-site context, such as a frontend and API on unrelated registrable domains. Browsers require `Secure` when `SameSite=None`, so that combination must remain HTTPS-only. Separate subdomains such as `app.example.com` and `api.example.com` are usually same-site, though they are still cross-origin.
>
> Also verify that the proxy explicitly forwards `X-Forwarded-Proto`, that the browser receives a `Set-Cookie` response header, and that frontend requests use `credentials: "include"` when crossing origins. If CORS is involved, the server must return the exact allowed origin plus `Access-Control-Allow-Credentials: true`; a wildcard origin is incompatible with credentialed requests.
>
> Avoid setting a cookie `domain` unless sharing across subdomains is intentional. A host-only cookie is safer and eliminates another production-only failure mode.

### After `/bro`

#### What happened

Your username and password check succeeded, and the login route returned `200
OK`. However, the browser did not receive or return a usable session cookie in
production.

#### What it means

In production, secure web traffic (HTTPS) hits an intermediary, such as a load
balancer or Nginx, before reaching your Node/Express app as plain HTTP.

Because your session cookie requires HTTPS (`secure: true`), Express may withhold
it when it does not trust the proxy forwarding the request. The exact trust
setting must match your deployment's proxy topology.

#### What you should do next

1. Configure Express to trust only your actual proxy topology. Put this before
   the session setup. For example, use `1` only when there is exactly one trusted
   proxy hop:

   ```js
   app.set("trust proxy", 1);

   app.use(session({
     secret: process.env.SESSION_SECRET,
     resave: false,
     saveUninitialized: false,
     cookie: {
       httpOnly: true,
       secure: true,
       sameSite: "lax",
       maxAge: 1000 * 60 * 60 * 24
     }
   }));
   ```

2. Check your cookie settings:
   - Keep `sameSite: "lax"` if your frontend and backend share the same main
     domain, such as `app.example.com` and `api.example.com`.
   - Use `sameSite: "none"` only when the cookie must be sent cross-site.
     Browsers require `secure: true` with this setting.
   - Avoid defining a custom cookie `domain` unless you deliberately need to
     share cookies across subdomains.

3. Verify the proxy, browser, and CORS settings:
   - Ensure the proxy forwards the `X-Forwarded-Proto` header.
   - Check that the response contains a `Set-Cookie` header.
   - Include `credentials: "include"` in cross-origin frontend requests.
   - Return the exact allowed origin with
     `Access-Control-Allow-Credentials: true`. Do not use a wildcard (`*`) for
     credentialed requests.

</details>

<details>
<summary><strong>Long:</strong> A CI build fails only when its cache is restored</summary>

### Before

> The failure is not a nondeterministic pnpm installation problem, despite the misleading first error being emitted from the test runner immediately after dependency hydration. It is a state-contamination problem at the intersection of the repository cache, the package export map, and an incorrectly scoped cache key. The decisive observation is that the same commit succeeds in a clean checkout and in CI when cache restoration is disabled, but fails when the pre-build workspace cache is restored. That isolates the variable to files materialized outside Git rather than source, Node, or runner image drift.
>
> The affected package, `@acme/config`, was recently migrated from a dual CommonJS/ESM build to an ESM-oriented TypeScript output. Its root `package.json` declares `"type": "module"` and maps the `import` condition to `./dist/index.js`, while the legacy `require` condition still maps to `./dist/index.cjs`. The current compiler emits `index.js` but does not remove the previous build directory first. An older cached `dist` directory therefore contributes two files that no longer belong to the current build graph: `dist/index.cjs` and `dist/package.json`, the latter declaring `"type": "commonjs"`. The new compiler overlays `dist/index.js` but leaves both obsolete files intact. Because nested package boundaries override the root package type, Node interprets the newly emitted ESM `index.js` as CommonJS in that restored workspace and reports `Unexpected token 'export'`. Test processes entering through `require()` instead resolve the obsolete `index.cjs`, which references a removed chunk and can instead produce `MODULE_NOT_FOUND`. These apparently different errors are two projections of the same dirty-output condition.
>
> The cache configuration makes that contaminated state persistent. The workflow computes the key with `hashFiles('packages/**/pnpm-lock.yaml')`, but this workspace has only the root-level `pnpm-lock.yaml`. GitHub Actions consequently evaluates the hash expression to an empty value, yielding a key equivalent to `Linux-node20-workspace-`. A broad restore key then permits an archive produced before the module-format migration to satisfy the lookup. That archive combines the pnpm content-addressable store, Turborepo metadata, and every package's `dist` directory. Those data classes do not share valid invalidation semantics: pnpm store entries are immutable by content, Turborepo artifacts are task-hash addressed, and arbitrary build directories are mutable snapshots whose correctness depends on complete deletion or exact provenance. Treating them as one cache effectively elevates obsolete untracked files into undeclared build inputs.
>
> The evidence is visible by comparing the restored and clean workspaces before compilation. In the failing job, `packages/config/dist/package.json` exists with `"type":"commonjs"` and `packages/config/dist/index.cjs` has a timestamp and checksum predating the current commit. Neither file appears after `git clean -ffdx` followed by installation and build. The Actions cache log also shows the truncated key without a lockfile digest, while `git diff` remains empty because the problematic files are ignored. Finally, deleting only `packages/config/dist` before rerunning the unchanged test command converts the failure to a pass, which excludes dependency resolution and network variability as primary causes.
>
> The minimal durable remediation has three parts. First, stop caching package output directories. Cache the pnpm store separately, using a key that includes the actual root lockfile:
>
> ```yaml
> key: ${{ runner.os }}-node20-pnpm-${{ hashFiles('pnpm-lock.yaml') }}
> restore-keys: |
>   ${{ runner.os }}-node20-pnpm-
> ```
>
> A broad fallback is acceptable for the pnpm store because pnpm validates content-addressed entries; it is not acceptable for mutable `dist` snapshots. If remote or local Turborepo caching is retained, cache only `.turbo` and allow Turbo's task hash to govern artifact reuse rather than wrapping raw workspace outputs in a generic archive.
>
> Second, make every package build replace, rather than merge into, its output directory. `@acme/config` should delete `dist` before invoking `tsc`, `tsup`, or the existing bundler. The CI workflow should also run the repository's recursive clean target before the first build as a defense against future cache or runner reuse. This is not a substitute for fixing cache scope, but it restores the invariant that generated output is a function of the checked-out sources and declared toolchain.
>
> Third, make the export contract agree with emitted files. If `@acme/config` is intentionally ESM-only, remove the `require` condition and the obsolete CommonJS metadata. If CommonJS consumers remain supported, restore an explicit CJS build that deterministically emits `dist/index.cjs`; do not let a historical artifact impersonate that support. In either case, package publication should reject export targets that do not exist.
>
> Verification should exercise both cache states and both module entry paths. Run the full pipeline once with no cache, save only the corrected caches, and rerun the identical commit expecting a cache hit and the same result. Inspect the built package to confirm the nested CommonJS `package.json` and legacy chunks are absent unless intentionally generated. Add a lightweight smoke check using dynamic `import('@acme/config')`; if CommonJS remains supported, add a second check through `createRequire`. Finally, change the root lockfile and confirm the logged cache key changes. That matrix validates clean-build reproducibility, restored-cache reproducibility, export-map coherence, and dependency-cache invalidation independently rather than relying on a single green run.

### After `/bro`

#### What happened

Your build failed because old files were left behind by a broken cache (a saved
snapshot of previous build files).

The package `@acme/config` recently switched its module format to modern
JavaScript (ESM). However, the build process did not delete the old output
folder (`dist`) before creating new files.

Because the GitHub Actions setting searches the wrong path
(`hashFiles('packages/**/pnpm-lock.yaml')`), GitHub could not find the root
`pnpm-lock.yaml`. It restored an outdated cache containing `dist/index.cjs` and
a `dist/package.json` configured for older JavaScript (CommonJS). The new build
wrote some files but left the old ones behind, confusing Node and causing errors
such as `Unexpected token 'export'` and `MODULE_NOT_FOUND`.

A clean checkout without the cache succeeds. This proves the problem is old
cached files, not your source code or dependencies.

#### What it means

- **Cache contamination:** The CI workflow restores mutable `dist` folders
  alongside package-manager files, mixing obsolete files into new builds.
- **Mismatched module settings:** The package says it supports both modern
  (`import`) and legacy (`require`) formats, but it only builds the modern one
  while relying on leftover cached files for the legacy one.

#### What you should do next

1. **Fix the GitHub Actions cache:** Stop caching `dist` folders. Cache only the
   pnpm store, using the root lockfile:

   ```yaml
   key: ${{ runner.os }}-node20-pnpm-${{ hashFiles('pnpm-lock.yaml') }}
   restore-keys: |
     ${{ runner.os }}-node20-pnpm-
   ```

   If you use Turborepo, cache only `.turbo`.

2. **Clean output folders before building:** Make `@acme/config` delete `dist`
   before running `tsc`, `tsup`, or the bundler. Run the repository's recursive
   clean command before CI builds.

3. **Update the package exports:**
   - If `@acme/config` is ESM-only, remove the `require` entry and old CommonJS
     metadata.
   - If CommonJS is still needed, add a real build step for `dist/index.cjs`.

4. **Verify the fix:**
   - Delete the generated `packages/config/dist` folder, then run a clean build.
     Do not use `git clean -ffdx` in a working copy with files you need.
   - Run the workflow without a cache, save the new cache, and rerun the same
     commit to verify that a cache hit also passes.
   - Test `import('@acme/config')`, and test `createRequire` if CommonJS is
     supported.

</details>

## Explain pasted text

Paste text directly after the command:

```text
/bro text OAuth refresh tokens are rotated after every successful use.
```

Bro explains the pasted text instead of the latest assistant reply. With no text
after `/bro text`, it falls back to the latest completed reply. Press **R**
to simplify the same captured text again.

## Explain a document

Use a path relative to Pi's current workspace, or an absolute path inside it:

```text
/bro file "docs/incident review.pdf"
```

Paths may contain spaces; matching single or double quotes are also accepted.
Bro extracts text locally, then sends that text through the same explanation
flow used by `/bro`. Pressing **R** retries the extracted snapshot; running a
new `/bro file <path>` command reads the file again.

Files are limited to 10 MiB and 100,000 extracted characters. Scanned PDFs are
not supported because Bro does not perform OCR.

## Explain a webpage

Pass one public HTTP or HTTPS page:

```text
/bro url https://example.com/complicated-article
```

Bro fetches the page, extracts its main readable text locally, and sends only
that text through the existing explanation flow. The completed modal shows the
final website and page title. Pressing **R** retries the captured page without
fetching again; running a new `/bro url <url>` command fetches a fresh copy.

The first version is intentionally limited to one public, text-based page. It
does not use browser cookies, sign in, run page JavaScript, bypass paywalls or
bot protection, load complete discussion threads, follow pagination, or
understand images and video. Pages that depend on those features may fail.

If Bro cannot read a page, copy its content into a `.txt` or `.md` file, or save
it as a PDF, then use `/bro file <path>`.

## Check your setup

Run `/bro doctor` when Bro is newly installed or something is not working. It
checks Bro's settings and prompt, the installed Agy version, account access,
available models, and the selected reasoning effort. Failed checks explain what
to fix.

Doctor contacts Agy for its model catalog and account usage. It does not send an
assistant response or run a model completion, so it does not consume a model
turn. A successful check confirms the setup, but cannot guarantee that a later
provider request will succeed.

## Settings

Bro creates this user-editable settings file when the extension loads:

```text
~/.pi/agent/bro-settings.json
```

Existing flat model/effort files remain valid and select Agy. Explicit saves use
version 2 with backend-tagged selections:

```json
{
  "version": 2,
  "default": { "backend": "agy", "model": "gemini-3.7-flash", "effort": "low" },
  "mode": "balanced",
  "showTurns": 1,
  "overrides": {
    "explain": { "backend": "claude", "model": "sonnet", "effort": "medium" },
    "advisor": { "backend": "claude", "model": "opus", "effort": "high" }
  }
}
```

Each override is a complete backend/model/effort selection, never a field-by-field
merge. Omitted overrides inherit the shared default. Matching an override to the
default does not unpin it; select Default explicitly to restore inheritance.

### Claude Code

Install and authenticate `claude` independently (tested with Claude Code 2.1.281).
Bro uses its CLI account and billing route, not Pi provider credentials. Choose
Claude in `/bro config`; model aliases such as `sonnet` and `opus`, or explicit
model IDs, are passed to the CLI. Claude efforts are `default` (omit the flag),
`low`, `medium`, `high`, `xhigh`, and `max`; the chosen model/account must support
the requested combination. Runtime rejection is surfaced without fallback.

Explain/show use a scratch directory, safe mode, disabled tools, empty strict MCP
configuration, disabled skills and no session persistence. This is a tool/configuration
restriction, not an OS sandbox; built-in and managed Claude behavior can remain.
Advisor uses safe mode and a fresh workspace process with permissions bypassed;
it can modify files, and instructions to only advise remain behavioral. Running
that mode as root may be rejected by Claude. BTW remains Agy-only: if a Claude
shared default makes BTW unsupported, select an explicit Agy override.

Doctor distinguishes CLI installation and configured authentication from a live
request; it does not run a Claude model turn. `/bro usage` remains Agy-specific.

### Grok Build

Grok is supported for **advisor only**, using the separately authenticated `grok`
CLI (tested with 1.0.41). In `/bro config`, select Grok for the advisor override
and keep Agy or Claude for other capabilities. Seeded model choices are
`grok-4.7` and `grok-4.7-build-fast`; custom IDs are also accepted. Efforts are
`default` (omit the flag), `low`, `medium`, `high`, and `xhigh`; the CLI validates
model-specific support without silently changing the requested effort.

Grok advisor runs fresh in your workspace with `--sandbox off`, permissions
bypassed, with subagent/scheduler/monitor/workflow tools explicitly disabled. It can read and modify files. Existing Grok
configuration, hooks, skills, plugins and MCP servers may load; this is **not**
an isolated or read-only process. The private temporary prompt file is removed
after execution, but Grok may persist sessions and other data under its own
settings. Bro does not copy credentials or change your Grok configuration.
Cancellation terminates the managed process group, not independently detached
shell work or external services. This is not a process-containment guarantee.

Explain/show and BTW are explicitly unsupported on Grok: disabling built-in
tools or using a scratch cwd does not establish isolation from inherited
configuration. A Grok default therefore requires supported overrides for those
capabilities. No automatic fallback or sandbox downgrade occurs. Doctor checks
Grok's version, not authentication or model connectivity. `/bro usage` remains
Agy-specific.

Use `/bro model`, `/bro effort`, and `/bro mode` to update the shared default
and mode from Pi, `/bro config` to review or change the shared default and any
per-capability (explain/show/btw/advisor) overrides interactively, or edit the file
directly. Bro reads the file again before each explanation, so manual changes
apply to the next `/bro`. Use a model ID shown by `/bro model`; `effort` must be
one of the levels shown by `/bro effort`. Models without adjustable effort use
`default`. `mode` must be `brief`, `balanced`, or `faithful`; existing settings
without it use `balanced`. `showTurns` is the default number of turns `/bro
show` draws (default 1); `/bro show <n-turns>` overrides it for a single run. Settings
written before per-capability overrides existed load unchanged, with no overrides. The choices remain
active across Pi restarts until you change them. `/bro help` shows the active
settings, any overrides, and the exact file path.

`/bro config`'s changes save immediately as you make them. Pressing Esc inside
a model or effort picker cancels that pick without changing anything; pressing
Esc on the settings screen itself just closes it, keeping whatever was already
saved. If a save fails (for example, a read-only settings file), the screen
shows the error inline instead of losing the change silently.

If `PI_CODING_AGENT_DIR` is set, the file lives there instead. `PI_BRO_MODEL`
chooses the initial model only when Bro creates a missing settings file:

```sh
PI_BRO_MODEL=gemini-3.7-flash-low pi
```

### Configuration precedence

When resolving model and reasoning effort:
1. **Per-capability override**: If configured under `overrides.<capability>` (`explain`, `show`, `btw`, or `advisor`) in `bro-settings.json`, that capability pins its own complete backend/model/effort selection and ignores the shared default.
2. **Shared default**: If no override is set for that capability, it inherits `default` in version-2 settings (root model/effort in legacy settings).
3. **Catalog normalization**: For Agy selections, Bro normalizes the resolved `{ model, effort }` against Agy's installed model catalog (mapping suffixed variant IDs and handling fixed-effort models).
4. **Initial file creation only**: `PI_BRO_MODEL` selects the initial default model only when Bro creates a missing `bro-settings.json` file. It has no effect once the file exists.

When resolving turn count for `/bro show`:
1. **Command argument**: An explicit count like `/bro show 3` or `/bro show 1 query` overrides for that single execution.
2. **Saved setting**: `showTurns` in `bro-settings.json` (defaults to 1; configurable interactively via `/bro config` or direct file edit).

When resolving explanation prompt (`explain` capability only):
1. **Custom prompt**: `~/.pi/agent/bro-prompt.md` (or `$PI_CODING_AGENT_DIR/bro-prompt.md`), if present and valid (`{{response}}` exactly once), completely overrides all built-in modes.
2. **Saved mode**: `mode` in `bro-settings.json` (`brief`, `balanced`, or `faithful`; defaults to `balanced`).
3. Note: `bro-prompt.md` applies only to `/bro`, `/bro text`, `/bro file`, and `/bro url`; it does not affect `/bro show`, `/bro btw`, or `bro_advisor`.

## Custom prompt

Bro uses a built-in prompt by default. To use your own, create:

```text
~/.pi/agent/bro-prompt.md
```

Your prompt must include `{{response}}` exactly once. For example:

```md
Explain this in plain English in no more than 200 words.
Keep important warnings and next steps.

Text to explain:
{{response}}
```

Bro re-reads this file every time you simplify, so your edits take effect
immediately without reloading Pi. Bro never creates or modifies this file.
Existing valid custom prompts continue working unchanged.

A valid custom prompt fully overrides all built-in mode instructions.
`/bro show` is separate: it always uses its own built-in draw prompt and
ignores `bro-prompt.md`. `/bro
mode` still changes the saved mode, but that mode remains inactive while
`bro-prompt.md` exists. Remove or rename `bro-prompt.md` to use the saved
built-in mode again. If the custom prompt is invalid—for example, it has no
`{{response}}` placeholder or has more than one—Bro blocks the explanation;
run `/bro doctor` for the exact problem.

## Privacy and safety

- **External requests**: Bro sends the latest completed assistant response,
  pasted text, extracted document text, extracted webpage text, or recent
  session conversation text (tool calls, tool results, reasoning, and images
  omitted) to the selected backend and its configured model provider.
- **Side conversation requests**: `/bro btw` sends your side questions and, on
  the first turn, the seeded main-session conversation text to Agy. In `--full`
  mode the side agent additionally reads the workspace.
- **Usage checks**: `/bro usage` checks your authenticated Agy limits without
  sending an assistant response or running a model turn.
- **Setup checks**: `/bro doctor` checks Agy account and model availability
  without sending an assistant response or running a model turn.
- **Context isolation**: Bro does not add explanations to Pi's conversation
  history, session files, or main-agent context.
- **Side conversation (`/bro btw`)**: sandboxed by default — the side agent has
  no project access and runs in a temporary folder. With `--full` it runs in
  your workspace with auto-approved tools, so it can read and edit files while
  the main agent is also working; use `--full` only when you want that. The
  side thread is memory-only and clears when you switch sessions, reload
  extensions, or quit Pi.
- **Memory cache**: The latest explanation is stored only in process memory for
  `/bro open`. It clears when you switch Pi sessions, reload extensions, or quit
  Pi.
- **File safety**: `/bro file` reads only regular files whose resolved path is
  inside Pi's current workspace, including after resolving symlinks. Bro does
  not modify them. It runs Agy in sandbox mode inside a temporary empty folder.
  This reduces project access, but it is not a security boundary. Bro only
  writes its own user settings file described above.
- **Web requests**: `/bro url` connects directly to the target website. The site
  sees your IP address and Bro's user agent. Bro sends no browser cookies,
  authorization, or referrer information, and it refuses local, private, and
  reserved network destinations, including redirects. Avoid private or signed
  URLs whose query string contains secrets.
- **Web extraction**: Bro parses downloaded HTML locally without executing page
  scripts or loading page subresources. It sends the extracted readable text,
  including links preserved in that text, to the selected backend; it does not separately send
  the requested URL or raw page HTML. The URL, captured text, and explanation
  remain in process memory only and clear with the existing `/bro open` cache.
- **Show diagrams**: When a show reply ends in one self-contained HTML block,
  Bro writes it to `/tmp/pi-bro-<uid>/bro-show-<hash>.html` with a restrictive
  Content-Security-Policy, and opens it in your browser only when you press
  **O**. **C** copies the full reply, including the HTML.
- **Provider data**: The selected CLI backend and your model provider may retain logs and request data
  according to their own settings and privacy policies.
- **Clipboard**: Pressing **C** copies the text to your system clipboard, where
  your operating system or clipboard manager may retain it.
- **Advisor requests**: `bro_advisor` sends the executor agent's system
  instructions, active tool list (excluding `bro_advisor`), ordered
  conversation history including tool calls and tool results (unlike Show, which
  omits them), human steering brief, and the executor's optional question to
  the selected backend and its configured model provider. Reasoning and image bodies are
  omitted with explicit markers (`[reasoning omitted]`, `[image omitted]`).
- **Advisor tool execution & safety boundary**: The advisor process runs
  directly in your workspace (`cwd`) with auto-approved permissions
  (Agy/Claude permission bypass; Grok `--sandbox off --permission-mode bypassPermissions`). It has real tool access (file reading,
  search, command execution). The directive to only advise and leave edits to
  the executor is a **behavioral prompt instruction**, not an enforced sandbox
  or security boundary. Treat its findings as advice to verify before applying.
- **Advisor steering persistence**: The steering brief is saved as
  session-scoped custom extension data (`bro-advisor-steering`) in the session
  file. It persists across session resume and reload, and is inherited on
  session fork (post-fork edits on branches remain independent). It is never
  sent to the main model or added to Pi's conversation. The advisor tool has
  no separate activation state.

## Troubleshooting and current limits

If an explanation fails, run `/bro doctor` first. If a webpage cannot be
extracted, copy its content into a supported text file or save it as a PDF and
use `/bro file`. If a PDF contains only scanned images, run OCR with another
tool before giving it to Bro.

- Supports Agy for all capabilities and Claude Code for explain/show/advisor. Claude BTW is not yet supported; unsupported selections fail without fallback.
- Document input supports `.md`, `.markdown`, `.txt`, `.pdf`, and `.docx` only;
  it does not perform OCR.
- Webpage input supports one public HTML page, up to 5 MiB downloaded and
  100,000 extracted characters. JavaScript-only, authenticated, paywalled,
  blocked, paginated, and media-first pages are not supported.
- Direct webpage fetching does not currently use `HTTP_PROXY`, `HTTPS_PROXY`,
  or other proxy environment variables.
- `/bro btw` threads are memory-only and do not survive reloads or restarts.
  The side conversation needs Agy's `--conversation` resume support; sandbox
  mode caps a turn at 2 minutes and full mode at 10 minutes.
- `bro_advisor` requires Agy CLI `>=1.1.15` (for `--input-format stream-json`).
  Consultations run directly in the workspace with auto-approved permissions
  without enforced file-modification isolation; an attempt is capped at 10
  minutes (`--print-timeout 10m`) and retries up to 2 times on invocation
  failure (5-second, then 10-second backoff).
- Show captures only the conversation text of what already happened in the
  current session — the last few turns' user and assistant messages, with
  tool calls, tool results, reasoning, and images always omitted; it cannot
  read the repository or other files on its own, and its shapes reflect what
  was reported in the conversation, not independent verification.
- HTML diagrams open in your default browser; pressing **O** on a remote or
  headless session with no display reports the failure instead of opening
  anything.
- Keeps only the latest explanation in memory.
- Does not store history or export directly to files.
- Bro temporarily captures mouse input while its modal is open so mouse-wheel
  and trackpad scrolling work in regular and fullscreen modes. Native mouse
  selection may be unavailable or visually extend outside the Bro window;
  press **C** to copy the full explanation instead.

## Development

```sh
npm install
npm test
pi --tui-mode fullscreen -e ./bro.ts
```

The smoke test uses a fake `agy`, and Claude adapter tests use a fake `claude`, so automated tests do not call an external model. It
verifies command routing, document and URL safety boundaries, HTML
extraction, show capture (conversation text only, tool calls and results
absent), and HTML-diagram handling, healthy and broken setup handling,
settings, custom prompt handling, and context isolation.

The prompt benchmark is manual and makes live Agy calls. Read
[`benchmark/README.md`](benchmark/README.md) before running it; it is never part
of `npm test`. A separate `--track show` benchmark grades the show prompt
against serialized-transcript fixtures — one per show-me form — and is also
manual and never part of `npm test`.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
