# Command reference

[Docs home](../README.md) · [All commands](commands.md) · [Safety and permissions](data-and-permissions.md)

## What Bro can explain

**Simplify** helps you understand one source in plain words or as a diagram. `/bro` and `/bro simplify` open the last result (or help) without calling a model.

| Source | Inside Simplify | Direct command (also headless) |
| --- | --- | --- |
| Latest completed assistant reply | `/simplify` | `/bro simplify latest` |
| Pasted text | `/text <text>` | `/bro simplify text <text>` |
| Local Markdown, text, PDF, or DOCX file | `/file <path>` | `/bro simplify file <path>` |
| Public webpage | `/url <url>` | `/bro simplify url <url>` |
| Recent user and assistant conversation text only | `/show [n-turns] [query]` | `/bro simplify show [n-turns] [query]` |

A new result replaces the previous one. Headless runs keep the result in private session state rather than sending an assistant reply. RPC clients may still receive the custom session entry event. Use an existing saved session to reopen the result after exit. In a fresh session, Pi keeps the result only in memory until the first user or assistant message creates the session file.

The old top-level shortcuts `/bro show`, `/bro text`, `/bro file`, `/bro url`, and `/bro open` now point to their replacements without running them. `/bro <input>` no longer guesses the source: choose an explicit command.

## Default command suggestions

Typing `/bro ` suggests `simplify`, `btw`, `guided-review`, `architecture`, `elevate`, `grill-me`, `remember-me`, `overthink`, and `config`. Type `/bro simplify ` for the source options, or a prefix such as `/bro doc` for other commands.

## Commands

| Command | Description |
| --- | --- |
| `/bro`, `/bro simplify` | Reopen the last private explanation or diagram on this session branch. No model call. |
| `/bro copy` | Edit and preview the latest completed assistant reply as raw Markdown. Ctrl+D switches views; Ctrl+C copies Markdown; F1 opens Help. No backend call or saved draft. Native Pi `/copy` copies immediately. [Guide](../features/copy.md). |
| `/bro doctor` | Check Bro's settings, preferences, and each selected backend, with the effective backend/model/effort per feature. |
| `/bro mode [brief\|balanced\|faithful]` | View or choose the explanation mode. |
| `/bro preferences` | View or edit what Bro knows about you and how you like answers; see [Preferences](settings.md#preferences). |
| `/bro config` | Open Global (defaults, preferences and Doctor) or Features (per-feature overrides, BTW inheritance, Overthink automatic checks and Advisor steering). |
| `/bro architecture [focus]` | Read the current project and create or refresh `docs/architecture/` with Markdown, an editable graph and offline HTML. Inherits BTW backend settings. [Guide](../features/architecture.md). |
| `/bro guided-review <PR number or URL>` | Automatically explain and assess a captured PR in local Pi, with source evidence and optional private questions. Opening the same PR restores its saved review. |
| `/bro guided-review` | List saved reviews; `resume` is an alias. |
| `/bro guided-review delete [PR number or URL]` | Choose and confirm deletion of a saved review and its captured source. Without a target, opens the saved-review picker. |
| `/bro remember-me [thought]` | Start a private memory-writing conversation, browse and expand memories, and approve saves explicitly. [Guide](../features/remember-me.md). |
| `/bro overthink` | View the latest private second look and evidence, without a model call. Ctrl+R recheck, U usage details, ? help, Ctrl+C copy. [Guide](../features/overthink.md). |
| `/bro grill-me [topic]` | Private one-question-at-a-time decision interview. Supply a topic to start fresh; omit it to resume. `/consolidate` drafts a brief; `/copy` copies the latest reply or brief; Pi's editor stays untouched. `/help` lists modal controls. [Guide](../features/grill-me.md). |
| `/bro elevate [request]` | Improve an assignment before execution. Discover up to five gaps, choose useful findings, and copy the revised request. Pi's editor is never changed. **Ctrl+Shift+E** can use your unsent draft. See [Elevate](../features/elevate.md). |
| `/bro btw [question]` | Open a side conversation in a modal, seeded with recent main-session context. Starts conversation-only; `/mode` toggles full workspace access; `/copy` and `/copy-all` copy the latest answer or full thread. |
| `/bro advisor` | Quick notice of whether the executor's `bro_advisor` tool is available right now, pointing at `/bro config`, `/bro advisor-steer`, and `/bro doctor`. |
| `/bro advisor-steer` | View, edit, save, or clear the one persistent steering brief the advisor always sees. |
| `/bro help` | Open the built-in quick reference. |

## Simplify modal (single-source explanation)

Use `/copy` to copy the current result, `/clear` to forget it, and `/help` for commands. With the composer empty, **R** reruns the captured source, **M** changes the one-off Brief/Balanced/Faithful mode on explanations, and **O** opens a browser diagram when available. **Esc** goes back from help or closes. Only the latest result is saved; this is not a chat. See [plain-language explanations](../features/explain.md) and [conversation diagrams](../features/show.md#bro-show).
