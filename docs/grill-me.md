# Grill Me (experimental)

[Docs home](README.md) · [Commands](reference/commands.md) · [Safety](reference/data-and-permissions.md)

`/bro grill-me` opens an independent decision interview in Bro's modal, without adding turns to Pi's main conversation.

```text
/bro grill-me Should child agents communicate freely?
/bro grill-me
```

With a topic, start a new interview. Without one, reopen the current interview or enter a topic inside the modal. A proposal prompts scrutiny; an open question prompts discovery. Bro offers reasoned pushback, then one question with lettered choices, including an open-ended alternative. Answer with a letter or your own words. Questions request a horizontal divider, a distinct **Question** heading, and exactly one **(Recommended)** option with a short reason. Recommendations are provisional; model adherence is not guaranteed.

## How Bro works with you

Grill Me is a **context-rich thinking partner**, not a review pipeline. It can help you discover a position from an open question or test a proposal you already have. If you propose a solution before explaining the problem, Bro looks for the goal and constraints that matter; when those are already clear, it uses them rather than repeating an intake checklist.

Bro contributes options and reasons, asks about the most consequential choice still open, and may inspect relevant workspace material when its backend permits it. It should check available facts rather than guessing, ask *you* about preferences and trade-offs, and explain meaningful uncertainty. Good arguments can persuade Bro; it should not invent objections to prolong the interview.

As the discussion develops, Bro treats your **agreed choices and reasons** differently from untested assumptions and Bro's own suggestions. You can correct or change a constraint in normal conversation. Bro should carry that change forward and avoid reopening settled ground without a reason.

`/consolidate` captures the current position for a handoff, at whatever level of detail the topic warrants: goals, key constraints, endorsed decisions and why, material trade-offs, unresolved questions, and a next step. It does not promote Bro's recommendations into decisions you never made. You can consolidate early, then continue and consolidate again.

This takes inspiration from the context-rich **Elephant** in Google's [Elephant–Goldfish Model](https://github.com/google/elephant-goldfish-model). Grill Me does **not** dispatch Goldfish reviewers, require a design document, or impose review/approval stages. It remains one dialogue in Bro's modal.

## Controls

| Command inside the modal | Effect |
| --- | --- |
| `/consolidate` | Generate a current decision brief. Does not end the interview or insert anything. |
| `/insert-last-message` | Insert the latest completed Bro reply, including a consolidated brief, into an empty Pi editor **without sending**. No model call. |
| `/depth light` | Quick, focused questioning |
| `/depth balanced` | Default: material assumptions and trade-offs |
| `/depth exhaustive` | Deeper alternatives, evidence and failure cases |
| `/retry` | Retry the failed/cancelled operation, otherwise regenerate the latest reply. Never repeats insertion. |
| `/new <topic>` | Start over after confirmation. Resets depth to balanced and access to inspection. |
| `/access inspect` | Request inspection tools; enforcement depends on backend |
| `/access full` | Request full permissions; requires typing `yes` after a warning |
| `/help` | Show commands on demand; **Esc returns to the interview** |
| Esc | Close and cancel active work; preserve completed discussion |

Type `/` to see matching commands; keep typing to narrow suggestions and press **Tab** to complete the first match. Completion never submits. From help, Esc returns to the discussion; a second Esc closes the modal.

For confirmation prompts, type `yes` to proceed; anything else cancels. Depth can change between replies without losing the discussion. There are no question quotas or finished/locked states. Consolidate whenever useful, inspect the brief, then explicitly insert it or continue talking. The brief includes the current position, reasons, objections, unresolved questions and next actions. Insertion never overwrites a draft or submits it.

The old `/finish`, `/copy`, `/copy-all`, `/insert`, `/insert-all`, `/clear`, and entry depth flags have been removed from this experimental interface. BTW commands are unchanged.

Grill Me uses the **BTW model/backend/effort** selection from `/bro config`, but has its own independent thread. The header shows depth and effective access; `/help` keeps the footer short. Full access and Agy write risks remain visible in the header even when another notice is shown.

## Access, privacy and limits

- Inspection uses the Guided Review backend path in your current workspace. Claude, Muse and Pi have file-only tools. Codex and Grok have read-only sandboxes with shell access. **Agy inspection can still write project files.** No-edit prompts are not security controls.
- Full access can read, edit and execute commands. Bro instructs the model not to make changes, but cannot enforce that instruction. There is no automatic escalation.
- Each turn makes a fresh backend call replaying the complete interview. Long interviews cost more and may exceed context limits; there is no hidden truncation or fallback.
- The provider receives your topic, interview history, Bro preferences and up to eight recent main-session user/assistant text turns (40,000 characters). Captured context excludes tool calls/results, hidden reasoning and images. Backend tools can inspect additional workspace content.
- Bro keeps the interview in memory, lost on reload, session change or exit. Backend/provider retention is separate; see [backend retention](reference/data-and-permissions.md#backends-access-and-retention).
- Closing discards partial output, preserves completed replies, and restores cancelled input unless a newer draft exists. Retry preserves the previous reply until replacement succeeds. Cancellation cannot undo backend changes; descendant cleanup on Windows and abrupt host shutdown are not guaranteed.

## Comparison

BTW is for side questions. Elevate improves an assignment. Grill Me tests a decision through dialogue. Its advantage over a standalone questioning skill is modal isolation and explicit return to Pi, not a claim of smarter questioning.

See the [evaluation record](plans/grill-me-evaluation.md). Historical live results predate the command redesign and multiple-choice guidance; they do not validate the revised experience.
