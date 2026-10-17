# Visualize a session (Show)

[Docs home](../README.md) · [All commands](../reference/commands.md) · [Safety and permissions](../reference/data-and-permissions.md)

## Bro show

Where the explanation modes rewrite dense prose in simpler words, `/bro show`
changes the form: it draws what you and the assistant said in the last few
session turns as a shape instead of paragraphs. Capture keeps only user and
assistant conversation text, including every intermediate assistant message in
a turn — tool calls, tool results, reasoning, and images never leave the
session. It runs the same backend-specific model call and shows the result
in the same modal, never touching your conversation. `/bro show` uses its own
draw prompt; the explanation modes do not affect it. Your
[preferences](../reference/settings.md#preferences) can change only its wording and language, never
which shapes it draws or its rules.

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

When the turns describe messages passing among three or more participants in
a set order (for example browser → API → database), a reply can instead end in
one Mermaid `sequenceDiagram`. The modal keeps its source visible with
`[Diagram saved — press O to render]`; **O** opens a page that draws it with
the Mermaid copy bundled in Bro. Any other Mermaid stays plain text.

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
