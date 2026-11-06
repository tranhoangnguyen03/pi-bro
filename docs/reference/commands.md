# Command reference

[Docs home](../README.md) · [All commands](commands.md) · [Safety and permissions](data-and-permissions.md)

## What Bro can explain

| Source | Command | What Bro does |
| --- | --- | --- |
| Latest assistant reply | `/bro` | Opens Simplify and explains the latest completed reply without inserting the result into Pi's conversation. |
| Pasted text | `/bro text <text>` | Explains text supplied directly in the command. |
| Local document | `/bro file <path>` | Extracts text from a workspace-local Markdown, text, PDF, or DOCX file. |
| Public webpage | `/bro url <url>` | Fetches one public HTML page and extracts its main readable content. |
| Recent session turns | `/bro show` | Draws the last turns' conversation text as shapes instead of prose (tool calls, tool results, reasoning, and images are omitted). |
| Any of the above, auto-detected | `/bro <input>` | Routes a lone URL to the webpage reader, an existing workspace file with a supported extension to the document reader, and anything else to pasted text. |

Pressing **R** simplifies the captured source again in the mode shown, and
**M** re-simplifies it in the next mode. These commands capture a
new source: `/bro text`, `/bro file`, `/bro url`, and `/bro show`. Giving `/bro` a URL, path, or
text directly captures a new source the same way.

## Default command suggestions

Typing `/bro ` displays nine task-level suggestions: `simplify`, `show`, `btw`, `guided-review`, `elevate`, `grill-me`, `remember-me`, `overthink`, and `config`. Every other documented command remains callable and discoverable by typing its prefix (e.g., `/bro doc`).

## Commands

| Command | Description |
| --- | --- |
| `/bro` | Open Simplify and explain the latest completed assistant reply. |
| `/bro simplify` | Reopen the last Simplify screen within this Pi session, without a new model call. |
| `/bro text <text>` | Explain pasted text. |
| `/bro <input>` | Explain it directly: a lone URL runs the webpage reader, an existing workspace file with a supported extension runs the document reader, and anything else is pasted text. A quoted path with spaces is routed too when the file exists. |
| `/bro file <path>` | Explain a workspace-local `.md`, `.markdown`, `.txt`, `.pdf`, or `.docx` file. |
| `/bro url <url>` | Explain one public, text-based webpage. |
| `/bro open` | Legacy compatibility shortcut to the last result. No `/open` command inside Simplify. |
| `/bro show [n-turns] [query]` | Draw recent session turns (default last 1) as shapes instead of prose, from user and assistant conversation text only — tool calls, tool results, reasoning, and images are omitted. An optional query steers what the shapes focus on, with or without a leading turn count. |
| `/bro doctor` | Check Bro's settings, preferences, and each selected backend, with the effective backend/model/effort per feature. |
| `/bro mode [brief\|balanced\|faithful]` | View or choose the explanation mode. |
| `/bro preferences` | View or edit what Bro knows about you and how you like answers; see [Preferences](settings.md#preferences). |
| `/bro config` | Open Global (defaults, preferences and Doctor) or Features (per-feature overrides, BTW inheritance, Overthink automatic checks/default questions and Advisor steering). |
| `/bro guided-review <PR number or URL>` | Automatically explain and assess a captured PR in local Pi, with source evidence and optional private questions. Opening the same PR restores its saved review. |
| `/bro guided-review` | List saved reviews; `resume` is an alias. |
| `/bro remember-me [thought]` | Start a private memory-writing conversation, browse and expand memories, and approve saves explicitly. [Guide](../remember-me.md). |
| `/bro overthink` | View the latest private automatic second-look notes, without a model call. Ctrl+R retry, Ctrl+E edit session questions, ? help, Ctrl+C copy. [Guide](../overthink.md). |
| `/bro grill-me [topic]` | Private one-question-at-a-time decision interview. Supply a topic to start fresh; omit it to resume. `/consolidate` drafts a brief; `/insert-last-message` inserts explicitly without sending. `/help` lists modal controls. [Guide](../grill-me.md). |
| `/bro elevate [request]` | Improve an assignment before execution. Discover up to five gaps, choose useful findings, and insert a revised request without submitting it. **Ctrl+Shift+E** can use your unsent draft. See [Elevate](../elevate.md). |
| `/bro btw [question]` | Open a side conversation in a modal, seeded with recent main-session context. Starts conversation-only; type `/mode` inside to toggle full permission (read and edit the workspace) without losing the thread. |
| `/bro advisor` | Quick notice of whether the executor's `bro_advisor` tool is available right now, pointing at `/bro config`, `/bro advisor-steer`, and `/bro doctor`. |
| `/bro advisor-steer` | View, edit, save, or clear the one persistent steering brief the advisor always sees. |
| `/bro help` | Open the built-in quick reference. |

Giving `/bro` the input directly works the same way:

```text
/bro https://example.com/article
/bro docs/report.pdf
/bro any other text is explained as pasted text
```

## Simplify modal (single-source explanation)

Once inside Simplify, use `/simplify` for the latest completed reply; `/text <text>`, `/file <path>`, `/url <url>` for a new source; `/copy` to copy the current explanation; `/clear` to return to the empty screen; and `/help` for controls. **M** changes the one-off Brief/Balanced/Faithful mode and re-explains the captured source; **R** retries the same source. This modal is not a conversation and does not persist history across restarts. Legacy `/bro text|file|url` shortcuts keep working. The global menu consolidation is tracked separately.
