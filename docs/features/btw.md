# Side questions (BTW)

[Docs home](../README.md) · [All commands](../reference/commands.md) · [Safety and permissions](../reference/data-and-permissions.md)

## Bro btw (side conversation)

`/bro btw` opens a separate multi-turn conversation in a modal, so you can ask
a quick side question while the main agent keeps working. It runs through the
selected backend and never adds anything to Pi's conversation unless you
copy it, paste it and send it yourself. Bro writes for a tired reader: the point
first, in plain words, at a length that fits the question, in the language you
asked in.

- `/bro btw <question>` asks immediately; `/bro btw` opens an empty thread.
  Reopening keeps the thread and its mode.
- **Two modes, toggled with `/mode`**: a new thread starts
  **conversation-only**; type `/mode` in the modal to switch to **full
  permission** (read and edit the workspace, run commands) and again to switch
  back. The conversation is kept across switches. How conversation-only is
  enforced depends on the backend — see
  [Backends: access and retention](../reference/data-and-permissions.md#backends-access-and-retention).
  **Conversation-only does not mean a hard sandbox on every backend:** Grok
  relies on an instruction; Codex and Muse can retain some read, shell, or
  network abilities under their own restricted settings. Do not send secrets
  on the assumption that the model cannot access anything else.
- Every new or cleared thread is seeded with up to the last 8 turns of
  main-session user/assistant conversation text (40,000 characters max, with a
  truncation notice). Later turns continue the backend's native session; in
  full permission mode the side agent can also read the repo itself.
- **In the modal**: type a question and press Enter (empty Enter re-asks the
  last question). Composer actions trigger only on these exact commands:
  - `/mode`: toggles conversation-only / full permission, keeping the thread
  - `/copy`: copies the latest answer to the system clipboard
  - `/copy-all`: copies the full thread to the system clipboard
  - `/retry`: re-asks the last question (empty Enter does the same)
  - `/help`: shows available controls
  - `/clear`: resets the thread

  `/insert` and `/insert-all` are retired: Bro points you to `/copy` or `/copy-all`
  instead. Any other text, including other slash-prefixed input such as `/send`,
  is sent as a question. Esc closes the modal and stops a
  running turn; the thread is kept. The view follows the newest text while you
  are at the bottom; scroll up to read earlier turns. The header shows the model and reasoning effort the latest
  turn used (`default` when the model's own effort applies) and the current
  mode.
- While a turn runs, the bottom hint shows its current phase and elapsed time, even
  when a backend has not started streaming the answer. When a backend reports tool
  activity, the hint shows the latest tool name/type, not commands or private
  output. Elapsed time means the request is still active, not that a specific
  step is complete. These status hints are temporary: they are not copied or
  stored with the conversation and disappear on completion or cancellation.
- A turn is capped at 2 minutes in conversation-only mode and 10 minutes in
  full permission mode.
- Bro saves its completed thread, mode and draft as private Pi session entries.
  Reloading or continuing the same session restores them. `/tree` restores the selected branch's state, and an aborted reply is discarded rather than saved as `…`. Reopening unchanged state adds no new disk entry. A new session starts fresh;
  a fork initially inherits the shared history then changes independently. Changing the BTW backend starts a fresh
  thread; native session IDs never cross backends.

## Experimental warm Agy BTW worker

Developers can opt in to issue [#194](https://github.com/tranhoangnguyen03/pi-bro/issues/194)'s persistent Agy transport:

```sh
PI_BRO_AGY_WARM_BTW=1 pi
```

Only **Agy BTW** uses the warm process; Explain, Show, Advisor, and Guided Review keep their existing one-shot paths. With the flag on, Bro sends each BTW turn over a single `--input-format stream-json --output-format stream-json` process until the native conversation is cleared, model/access/workspace changes, cancellation, failure, or shutdown. Turn completion follows Agy's `result` event (the process remains running). The process closes after 90 seconds idle and has a 20-minute maximum lifetime; a later turn can resume from its native conversation id in a new process.

The opt-in is **off by default** while we compare timings and test installed Agy versions. If you encounter a protocol issue, launch without the flag to use the existing process-per-turn adapter. No backend or authentication fallback is automatic. Note that Agy's sandbox is not a strict file-only boundary; access behavior is unchanged from the ordinary Agy BTW adapter.

Run the comparison in `benchmark/backend-latency.ts` on the same CLI/model/cwd with and without the flag. Offline tests cover native turn reuse, new-thread isolation, timeout cleanup, and the untouched Explain path. A real installed-CLI check remains required before making this the default.
