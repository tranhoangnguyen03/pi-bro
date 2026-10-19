# Set up models and preferences

[Docs home](../README.md) · [All commands](commands.md) · [Safety and permissions](data-and-permissions.md)

## Settings

Use `/bro config` to review or change the shared default backend/model/effort
and any per-capability (explain/show/btw/advisor/review) overrides, the explanation
mode, and the default show turn count. Changes save immediately. Esc inside a
picker cancels that pick; Esc on the settings screen closes it, keeping
whatever was already saved. If the terminal becomes too small, config blocks
hidden actions; Esc closes config even if a picker was open, after pending saves
finish. A failed save cancels that close and shows its error inline; if the error
alone makes config too small, any other key clears it so you can try again. `/bro mode` changes the mode directly (**M** in an explanation
tries another mode without saving it), and `/bro help` shows the active settings
and file path.

Elevate inherits the **BTW** backend/model/effort selection. There is no separate Elevate setting in this release. See the [Elevate guide](../elevate.md).

Settings live in this user-editable file, created when the extension loads
(under `$PI_CODING_AGENT_DIR` instead when that is set):

```text
~/.pi/agent/bro-settings.json
```

```json
{
  "version": 2,
  "default": { "backend": "agy", "model": "gemini-3.7-flash", "effort": "low" },
  "mode": "balanced",
  "showTurns": 1,
  "overrides": {
    "explain": { "backend": "claude", "model": "sonnet", "effort": "medium" },
    "advisor": { "backend": "grok", "model": "grok-4.7", "effort": "high" }
  }
}
```

Bro reads the file again before each request, so manual edits apply next time.

- Each selection is one atomic backend/model/effort choice. An override pins
  its own complete selection and ignores the shared default, even when it
  happens to match it; select **Default** in `/bro config` to inherit again.
  Omitted overrides inherit `default`.
- `effort` must be one the backend offers (`default` omits it and lets the
  model decide). Agy selections are normalized against Agy's installed model
  catalog. Claude, Grok, Codex, and Muse accept seeded or custom model IDs; a model/effort
  combination the account does not support fails with the backend's own error
  instead of silently falling back.
- `mode` is `brief`, `balanced` (the default), or `faithful`. `showTurns` is
  the default number of turns `/bro show` draws (default 1); `/bro show
  <n-turns>` overrides it for one run.
- `PI_BRO_MODEL` picks the initial Agy model only when Bro creates a missing
  settings file, for example `PI_BRO_MODEL=gemini-3.7-flash-low pi`.
- Older flat settings files (root `model`/`effort`) still load and mean Agy.

## Preferences

Tell Bro about yourself and how you like answers. Bro adds what you write to
every explain, `/bro show`, `/bro btw`, `/bro elevate`, and Guided Review prompt as a labelled section,
alongside its own instructions. It never replaces them: modes, **M**, and the
source rules keep working. The advisor never receives your preferences; use
`/bro advisor-steer` for it.

Run `/bro preferences` to edit them: **Ctrl+S** saves, **Ctrl+K** deletes the
file, **Ctrl+C** copies, and **Esc** closes without saving. The first time,
the editor opens with this starter text, which is not saved until you press
**Ctrl+S**:

```md
## About me
I'm an overworked white-collar worker, and so are my colleagues. By the end of a
hard day our brains are fried and we can only handle simple language, no matter
how sharp we are at our best.

## How I like answers
- Explain it like I'm a simpleton: plain, everyday words.
- Go easy on analogies. No forced ones.
```

You can also edit the file directly (under `$PI_CODING_AGENT_DIR` instead when
that is set):

```text
~/.pi/agent/bro-preferences.md
```

- **Free-form**: no placeholder or structure is required. Bro re-reads the
  file on every request, so edits apply next time. A missing or empty file
  means no preferences, and Bro's prompts are then exactly the built-in ones.
- **What preferences can change**: wording, tone, technical depth, length in
  BTW, and the answer language. If you name a language, code, commands, paths,
  names, and numbers still stay exactly as written. In `/bro show`,
  preferences only change wording and language. Guided Review also receives preferences for explanation/answer wording; they do not override its evidence or review rules. A per-run choice (the mode,
  **M**, a Show steering query, or what a BTW/review question asks for) wins over a
  standing preference.
- **Limit**: 4,000 characters, because the text goes with every request. A
  longer file stops explain, Show, BTW, and Guided Review with an error until you trim it;
  Bro never cuts it silently. `/bro doctor` reports the problem, and the
  editor still opens the file so you can fix it.
- **BTW threads**: when your preferences change, the next side question starts
  a fresh backend session that is caught up on the thread, so old preferences
  don't linger.

`bro-prompt.md`, the full prompt template from earlier versions, is no longer
read. Move what you want to keep into `/bro preferences`, and choose
`/bro mode brief` for the original ELI-simpleton instruction.
