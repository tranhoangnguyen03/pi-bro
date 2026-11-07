# Copy Markdown — /bro copy

When Pi renders a reply, its Markdown tables and formatted text are easy to read but awkward to trim and paste. `/bro copy` opens the **last completed assistant reply** as raw Markdown in a temporary editor. You can edit the text, preview it, and copy your version without leaving Pi.

Pi already has **`/copy`**, which copies the last assistant reply immediately. Use **`/bro copy`** when you want to trim or change it before copying.

## Controls

| Key | Edit view | Preview view |
| --- | --- | --- |
| **Ctrl+D** | Show rendered Markdown preview | Return to raw Markdown editor |
| **Ctrl+C** | Copy the current raw Markdown | Copy the same raw Markdown, never rendered text |
| **Ctrl+G** | Show Help without stealing typed characters | Show Help |
| **?** | Type `?` normally in the draft | Show Help |
| **↑/↓, PgUp/PgDn** | Move in the editor | Scroll preview |
| **Esc** | Close; two presses if you edited the draft | Close; two presses if you edited the draft |

In Help, Esc returns to the previous view. **Enter** adds a newline in Edit; it does not submit a prompt.

## What is preserved

- The source comes from the last normally completed assistant message in the active Pi session, not from the terminal's rendered output. Bro copies **text content**, including Markdown tables, links and code fences; reasoning and nontext parts are excluded.
- Raw Markdown is copied as-is if you **do not edit** it, including original tabs and line endings. Pi's `Editor` displays tabs as spaces and normalizes line endings when editing, so after you change the draft its output follows the editor's text rules.
- Preview uses the **same draft** as Edit. Switching views does not reset the editor or create another copy.
- Large pastes: copy always reads `Editor.getExpandedText()` rather than its shortened on-screen paste markers.

The modal is temporary. Closing it discards the scratch draft; it does not change Pi's conversation, files, saved settings, or agent context. No model request runs. **Ctrl+C writes only to your system clipboard**; other applications with clipboard access may read it.

## When there's no reply or the terminal is too small

If Pi has no completed assistant reply, Bro displays a notice instead of opening an empty modal.

On a very small terminal, the editor refuses blind typing and asks for more space. You can still preview, copy, and close. If clipboard access fails, Bro shows an error rather than claiming a successful copy.

This is deliberately not a file editor, message-history selector, or AI rewriting workflow.
