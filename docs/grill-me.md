# Grill Me (experimental)

[Docs home](README.md) · [Commands](reference/commands.md) · [Safety](reference/data-and-permissions.md)

`/bro grill-me` opens an **independent decision interview** in Bro's modal. It challenges your thinking **one question at a time**, without interrupting Pi's main conversation. It is not a spec generator or a fixed checklist.

## Try it

```text
/bro grill-me I think our agents should talk directly to each other.
/bro grill-me --light Should we change the database?
/bro grill-me --exhaustive What should our agent team's message policy be?
/bro grill-me
```

With a topic, Bro opens a *new* interview and asks its first question. Without a topic, it reopens the current interview; if none exists, enter your topic inside the modal. The topic **must come from you**; Bro does not invent one from your draft. A fresh session starts with a fresh Grill Me thread.

A proposal ("I think X") prompts scrutiny; an open question ("What should we do about Y?") prompts discovery. The interviewer adapts instead of making you choose a separate workflow.

## Interview controls

| Command *inside the modal* | Effect |
| --- | --- |
| Type an answer and press Enter | Bro responds and asks exactly one next question |
| `/depth light` | Short and focused, typically a few high-value questions |
| `/depth balanced` | Default; dig into key assumptions and trade-offs |
| `/depth exhaustive` | Probe alternatives, failure cases and consequences in depth |
| `/finish` | Stop asking questions and draft a decision brief; you choose when |
| `/copy` / `/insert` | Copy the latest answer (or finished brief), or insert it into the empty Pi editor **without sending** |
| `/copy-all` / `/insert-all` | Copy or insert the entire interview |
| `/retry` | Re-ask the last user turn |
| `/clear` | Erase this interview and enter a new topic |
| `/access full` | Opt-in full workspace permission when read-only inspection is unsuitable; **not technically read-only** |
| `/access read-only` | Switch back to inspection mode |
| Esc | Close, preserving the thread in memory; abort any running response |

Depth is **guidance**, not a forced question count. You may switch it at any point. You can also finish early, or return after closing. The resulting brief includes the position or decision, reasons, strongest objections, open questions, and next action. You must request `/copy` or `/insert`; Bro does not automatically submit anything to Pi.

Grill Me uses your **BTW model/backend/effort** selection from `/bro config`; it has no separate model setting in v0.1. Its interview state is separate from BTW's conversation, so one never overwrites the other.

## Access, privacy and limits

- By default, Grill Me uses Bro's **Guided Review inspection execution path** in your current workspace. Claude, Muse and Pi have file-only inspection tools; Codex and Grok use a read-only sandbox that can still run shell commands. **Agy's sandbox can still write project files.** Model prompts always prohibit edits, even on Agy, but prompts do not enforce access rights.
- If inspection fails or cannot do what you need, you can explicitly type `/access full`, which uses the BTW full-permission backend path. **The backend can read, edit and execute commands with permissions bypassed.** Bro instructs it never to change files, but that is *only an instruction*. There is no automatic escalation. Use this only with a workspace you trust.
- Each interview turn makes a **fresh backend call**, replaying the interview so far instead of retaining a native backend session. This keeps the prototype isolated but means exhaustive interviews cost more tokens and may eventually hit model context limits. There is no automatic truncation or hidden fallback.
- The topic, your answers, earlier interview turns, optional Bro preferences, and **up to eight recent main-session user/assistant text turns (40,000 characters)** are sent to the selected backend/provider. Tool calls/results, hidden reasoning and images are not included in the captured seed. Additional workspace content may be read through the selected backend tools.
- Interview and decision brief remain **in memory only** and are lost on extension reload, Pi session change or exit. Clipboard copies may outlive the session. Bro doesn't write transcripts to disk.
- Closing cancels the backend attempt. It does not reverse work a full-permission backend may already have performed, and it does not guarantee detached processes stop on Windows.
- Grill Me may challenge a weak idea, but it cannot guarantee a good decision. The summary describes the exchange, not independently verified truth.

## How it differs from other tools

**BTW** answers private side questions. **Elevate** suggests missing expert concerns and offers a task rewrite without an interview. **Grill Me** holds a back-and-forth conversation to test assumptions and clarify a decision. A standalone Grill Me skill can ask similar questions; Bro adds a separate modal and an explicit user-controlled way to return just the result to Pi.

For the experimental evaluation plan and three candidate decisions, see [Grill Me test cases](plans/grill-me-evaluation.md).
