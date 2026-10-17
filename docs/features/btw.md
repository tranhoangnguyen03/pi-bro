# Side questions (BTW)

[Docs home](../README.md) · [All commands](../reference/commands.md) · [Safety and permissions](../reference/data-and-permissions.md)

## Bro btw (side conversation)

`/bro btw` opens a separate multi-turn conversation in a modal, so you can ask
a quick side question while the main agent keeps working. It runs through the
selected backend and never adds anything to Pi's conversation unless you
explicitly insert it into the editor. Bro writes for a tired reader: the point
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
  - `/insert`: inserts the latest answer into the main editor without submitting
  - `/insert-all`: inserts the full thread into the main editor without submitting
  - `/retry`: re-asks the last question (empty Enter does the same)
  - `/clear`: resets the thread

  `/insert` and `/insert-all` never replace an existing main-editor draft:
  edit or clear it first. Any other text, including other slash-prefixed input
  such as `/send`, is sent as a question. Esc closes the modal and stops a
  running turn; the thread is kept. The view follows the newest text while you
  are at the bottom; scroll up to read earlier turns. The header shows the model and reasoning effort the latest
  turn used (`default` when the model's own effort applies) and the current
  mode.
- A turn is capped at 2 minutes in conversation-only mode and 10 minutes in
  full permission mode.
- Bro's thread lives in memory only — it clears when you switch Pi sessions,
  reload extensions, or quit Pi. Changing the BTW backend starts a fresh
  thread; native session IDs never cross backends.
