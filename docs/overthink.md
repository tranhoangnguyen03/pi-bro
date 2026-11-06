# Overthink — private second look

Overthink gives Pi's work a small, skeptical second pass. It checks the direction, the assumptions, the risks and the next move, without making a new agent or interrupting the original conversation. It is inspired by [pi-heads-up](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-heads-up).

## Normal use

After a **substantive completed task** (currently at least three tool results in the completed turn), Overthink sends one extra private assessment to the **same active Pi model, at the same thinking level**. A short note appears above the input only if there is something material to flag. If the reply already covered the issue, or there is nothing important to add, Overthink stays quiet. A question-only turn is not enough to trigger a check.

Run \`/bro overthink\` to **view** the latest assessment. Opening the modal makes **no model request**. The notes never enter Pi's user/assistant conversation and do not direct the agent to perform work.

In the modal:

- **Ctrl+R** — force a fresh assessment (also works for smaller tasks). A check uses the **current** session context.
- **Ctrl+E** — edit the questions for **this Pi session**.
- **Ctrl+K** — show or hide help.
- **Ctrl+C** — copy the latest findings.
- **Esc** — close or leave Help.
- **↑/↓** — scroll.

If the last assessment found nothing, the modal says so. After you edit questions, old findings remain visible but show that the question set has changed.

## Question editor

The same ordered, editable list is used in both places:

- **Global defaults:** \`/bro config → Features → Overthink\`.
- **Session questions:** \`/bro overthink\`, then **Ctrl+E**.

Use **↑/↓** to choose an entry; **Enter** to edit; **Ctrl+N** to add; **Ctrl+X** to delete; **Alt+↑/↓** to reorder; **Ctrl+S** to save; **Esc** to cancel. Saving an empty list disables checks. Unsaved changes are protected by a second-Esc warning.

**Ctrl+D** twice resets the editor draft. In the global editor it restores Bro's factory questions; in the session editor it restores the **current global defaults**. Press Ctrl+S to save that reset. A new session inherits the current global defaults once and can then be edited independently. Existing sessions do not change when the global defaults are updated.

## Model, cache and privacy

Overthink **never** uses the BTW or Bro backend/model setting. It calls Pi's current \`modelRegistry.streamSimple\` using \`buildSessionProjection()\` plus a single appended private review instruction. It uses the active physical session model and reasoning level, makes **one call for all questions**, does not use tools, and does not add the assessment to the main model context. The call sends the session context (including tool evidence exposed by Pi's projection) to that model's provider, under the provider's data policy.

This largely preserves the request prefix and **can** reuse provider prompt-cache input. The benefit varies by provider, model, elapsed time, tool/context changes, and prompt-cache policy. A cached prefix is not free: output and reasoning cost still apply. When the provider reports cache-read tokens, the viewer displays that figure; when it does not, Bro makes no savings claim. Check provider usage for billable cost.

Overthink stores editable global defaults in \`getAgentDir()/bro-overthink-defaults.json\` and session questions plus the **latest** private check in Pi session \`custom\` entries (\`bro-overthink\`). Those entries are outside LLM prompts. Session forks inherit their branch's last state; later edits are independent. The last note is retained for resume, not as an ever-growing list of reviews. It does not write to your project files.

## Limits and verification

- The second look is self-criticism by the **same** model; it is not an independent external review. Use \`bro_advisor\` when a genuinely separate view matters.
- An automatic check can fail without an on-screen error; it must not disturb the main run. Force retry in the modal to see the error.
- A new agent turn, model change or session navigation cancels or invalidates stale checks. A returned note is not proof that every listed concern is true.
- Host events and cache accounting vary. See [manual qualification](TESTING.md) before claiming live TUI, PiG or cache-cost behavior.
