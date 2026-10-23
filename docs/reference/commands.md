# Command reference

[Docs home](../README.md) · [All commands](commands.md) · [Safety and permissions](data-and-permissions.md)

## What Bro can explain

| Source | Command | What Bro does |
| --- | --- | --- |
| Latest assistant reply | `/bro` | Explains the latest completed reply without adding the result to the conversation. |
| Pasted text | `/bro text <text>` | Explains text supplied directly in the command. |
| Local document | `/bro file <path>` | Extracts text from a workspace-local Markdown, text, PDF, or DOCX file. |
| Public webpage | `/bro url <url>` | Fetches one public HTML page and extracts its main readable content. |
| Recent session turns | `/bro show` | Draws the last turns' conversation text as shapes instead of prose (tool calls, tool results, reasoning, and images are omitted). |
| Any of the above, auto-detected | `/bro <input>` | Routes a lone URL to the webpage reader, an existing workspace file with a supported extension to the document reader, and anything else to pasted text. |

Pressing **R** simplifies the captured source again in the mode shown, and
**M** re-simplifies it in the next mode. These commands capture a
new source: `/bro text`, `/bro file`, `/bro url`, and `/bro show`. Giving `/bro` a URL, path, or
text directly captures a new source the same way.

## Commands

| Command | Description |
| --- | --- |
| `/bro`, `/bro simplify`, or `/bro text` | Explain the latest completed assistant response. |
| `/bro text <text>` | Explain pasted text. |
| `/bro <input>` | Explain it directly: a lone URL runs the webpage reader, an existing workspace file with a supported extension runs the document reader, and anything else is pasted text. A quoted path with spaces is routed too when the file exists. |
| `/bro file <path>` | Explain a workspace-local `.md`, `.markdown`, `.txt`, `.pdf`, or `.docx` file. |
| `/bro url <url>` | Explain one public, text-based webpage. |
| `/bro open` | Reopen the latest explanation without calling the simplifier again. |
| `/bro show [n-turns] [query]` | Draw recent session turns (default last 1) as shapes instead of prose, from user and assistant conversation text only — tool calls, tool results, reasoning, and images are omitted. An optional query steers what the shapes focus on, with or without a leading turn count. |
| `/bro doctor` | Check Bro's settings, preferences, and each selected backend, with the effective backend/model/effort per feature. |
| `/bro mode [brief\|balanced\|faithful]` | View or choose the explanation mode. |
| `/bro preferences` | View or edit what Bro knows about you and how you like answers; see [Preferences](settings.md#preferences). |
| `/bro config` | Open settings for the shared backend/model/effort, explain mode, show turns, and per-capability (explain/show/btw/advisor/review) overrides. |
| `/bro guided-review <PR number or URL>` | Automatically explain and assess a captured PR in local Pi, with source evidence and optional private questions. Opening the same PR restores its saved review. |
| `/bro guided-review` | List saved reviews; `resume` is an alias. |
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
