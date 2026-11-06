# Overthink — private second look

Overthink gives Pi's work a small, skeptical second pass. It checks the direction, the assumptions, the risks and the next move, without making a new agent or interrupting the original conversation. It is inspired by [pi-heads-up](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-heads-up).

## Normal use

With **automatic checks on** (the factory default), after a **fully settled substantial task** (currently at least three tool results across the run), Overthink sends one extra private assessment to the **same active Pi model, at the same thinking level**. A short note appears above the input only if there is something material to flag. If the reply already covered the issue, or there is nothing important to add, Overthink stays quiet. A question-only turn is not enough to trigger a check.

Run `/bro overthink` to **view** the latest assessment. Opening the modal makes **no model request**. The notes never enter Pi's user/assistant conversation and do not direct the agent to perform work.

In the modal:

- **Ctrl+R** — force a fresh assessment (also works for smaller tasks). A check uses the **current** session context.
- **Ctrl+E** — edit the questions for **this Pi session**.
- **?** — show or hide help.
- **Ctrl+C** — copy the latest findings.
- **Esc** — close or leave Help.
- **↑/↓** — scroll.

If the last assessment found nothing, the modal says so. The note records the model-relevant session entry it assessed. When a later task (even a trivial turn), compaction, context edit, or branch move changes that position, the viewer explicitly marks the old note **OUTDATED**. Older notes without position metadata are marked **source position not recorded**. Editing questions also marks an existing note as using earlier questions.

## Question editor

The same ordered, editable list is used in both places:

- **Global defaults:** `/bro config → Features → Overthink → Default questions`.
- **Automatic checks:** `/bro config → Features → Overthink → Automatic checks` toggles the global on/off switch. It starts **On**. Turning it off does not delete questions or notes; the viewer and manual **Ctrl+R** still work.
- **Session questions:** `/bro overthink`, then **Ctrl+E**.

Use **↑/↓** to choose an entry; **Enter** to edit; **Ctrl+N** to add; **Ctrl+X** to delete; **Alt+↑/↓** to reorder; **Ctrl+S** to save; **Esc** to cancel. Saving an empty list disables checks. Unsaved changes are protected by a second-Esc warning.

**Ctrl+D** twice resets the editor draft. In the global editor it restores Bro's factory questions; in the session editor it restores the **current global defaults**. Press Ctrl+S to save that reset. A new session inherits the current global defaults once and can then be edited independently. Existing sessions do not change when the global defaults are updated.

## Model, cache and privacy

Overthink **never** uses the BTW or Bro backend/model setting. It calls Pi's current `modelRegistry.streamSimple` using `buildSessionProjection()` plus a single appended private review instruction. It uses the active physical session model and reasoning level, makes **one call for all questions**, **never executes tools**, and does not add the assessment to the main model context. The request may still contain Pi's tool descriptions as part of the original context; the prompt tells the model to respond in text and not call tools. An unexpected tool-use response is treated as a failed check, not executed. The call sends the session context (including tool evidence exposed by Pi's projection) to that model's provider, under the provider's data policy.

This largely preserves the request prefix and **can** reuse provider prompt-cache input. The benefit varies by provider, model, elapsed time, tool/context changes, other extensions' context hooks, and prompt-cache policy. It does not replicate every live Pi context modification. In Pi 1.3 and 1.5, `context_with_system` can observe a prepared context just before a provider call, while `before_provider_request` can observe a provider-specific payload; neither provides a portable, complete, settled-session request that can simply be appended and replayed through `streamSimple`. A recorded pre-call context also lacks the final agent response that Overthink needs to review. Bro therefore keeps the explicit projection path until a real provider-side comparison shows a safe improvement. **A cached prefix is not free:** high thinking effort can add substantial reasoning tokens on top of the visible-output limit, and both output and reasoning can cost money. The viewer shows *provider-reported* input, cache-read, cache-write, output and reasoning tokens when available. It labels USD cost separately as **estimated cost** from Pi's model price table, not a provider-billed amount; subscription or OAuth users may pay differently. A reported cache-read value of **0** could mean no hit **or unsupported caching**; it is not proof that caching works. Some providers report no usage fields. Check actual billed cost before treating Overthink as cheap.

Overthink stores editable global defaults in `getAgentDir()/bro-overthink-defaults.json` and session questions plus the **latest** private check in Pi session `custom` entries (`bro-overthink`). Those entries are outside LLM prompts. Session forks inherit their branch's last state; later edits are independent. The viewer resolves only the **latest** note. Pi stores session custom entries by appending, so **each completed check adds another entry to the session file**, even though Bro does not provide a history browser or archive. This is a deliberate reuse of Pi's branch-aware persistence, not a claim that only one physical record exists. Keep this storage growth in mind for long sessions. It does not write to your project files.

## Limits and verification

- The second look is self-criticism by the **same** model; it is not an independent external review. Use `bro_advisor` when a genuinely separate view matters.
- An automatic check can fail without an on-screen error; it must not disturb the main run. Force retry in the modal to see the error.
- Automatic work is triggered at Pi's `agent_settled` lifecycle event (supported from Pi 1.3), not `agent_end`. The earlier event collects tool-use evidence; only a normal final settlement, without queued messages, may start the check. A new agent turn, model change, question edit or session navigation cancels or invalidates stale checks. A returned note is not proof that every listed concern is true.
- Running Heads-up and Overthink together can cause **two extra calls** after a substantive turn. Disable one if that cost is not wanted.
- Host events and cache accounting vary. See [manual qualification](TESTING.md) before claiming live TUI, PiG or cache-cost behavior.
