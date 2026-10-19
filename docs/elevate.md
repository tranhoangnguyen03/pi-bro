# Bro Elevate — improve a request before you send it

**Elevate helps you ask for better work when you may not know what to ask for.** You describe what you want to achieve; Bro suggests a few expert questions, methods, or checks you may have missed. You choose which ones matter. Bro then rewrites **your assignment**, not the answer to it.

Elevate is useful before a design, research task, implementation, plan, or important decision. It is not a way to turn every small request into a large project. Sometimes the best result is: *Your original request is good enough.*

Elevate works inside Pi's **separate Bro modal**. It does not post its discussion to the main agent or execute the revised assignment. You control whether the final text goes into the main editor, and you still press Enter to send it.

## Start here (one minute)

**Option A: Improve a draft already in Pi's editor.** Type your request normally, but **do not submit it**. Invoke the **Ctrl+Shift+E** shortcut, where your terminal sends that key combination to Pi. Elevate opens Compose with your unsent draft; choose a context mode before starting discovery. If the shortcut doesn't work in your terminal, use `/bro elevate <request>` instead.

**Option B: Start with a slash command.**

```text
/bro elevate Design a retrieval system for our company documents.
```

**Option C: Start with no text.**

```text
/bro elevate
```

If the main editor contains a draft, Bro pre-fills the objective with that draft. Elevate always opens Compose first so you can choose context before any model call. Otherwise, it shows a multi-line objective field: type or paste the objective and choose **Ctrl+S** (or `Ctrl+Enter` on terminals that send it, or the `[Discover gaps]` button). `Enter` adds a new line, so a pasted multi-line task keeps its structure.

When both an explicit `/bro elevate <request>` argument and a draft exist, the **explicit argument takes priority**. The main editor is left untouched unless you later choose to insert the revision.

## Conversation context and retry

The **Context: Messages** button toggles to **Context: Full**. Use Tab to focus actions and Left/Right to reach it; Enter activates it. Short labels may show Messages or Full on narrow screens. The header always shows the active mode. While reviewing findings, choose **Edit request** to return to Compose and switch context; keeping the review action row short leaves space for explanations on small terminals.

- **Messages (default):** all user and assistant text from the current conversation branch.
- **Full:** also includes tool-call arguments and text tool results. This may send sensitive file contents, command arguments or tool output to the selected provider. Hidden reasoning, image binaries and provider metadata are excluded in both modes.
- There is **no fixed history cap**. Provider context limits still apply. The separate 12,000-character objective limit remains.
- Changing mode never makes a model call. It returns to Compose and clears old findings, approvals and rewrites. Start discovery again to use the new mode. Each new window defaults to Messages; history is captured when the window opens.
- After an explicit context-overload error, **Retry** removes the oldest half of remaining messages and repeats the failed step. If only one oversized message remains, subsequent retries halve its text, then omit it. The header shows **reduced** and the prompt marks partial history. The objective and approved findings remain intact. There are no automatic retries and ordinary failures do not trim context. Once history is exhausted, shorten the objective or choose a larger-context backend.

## The two questions Elevate asks

1. **Discover:** “Given my objective, what would a skilled expert know, question, investigate, or test that I haven't accounted for?” Bro looks across **altitude** (right problem), **depth** (evidence, methods, tests), and **range** (useful ideas from other fields). It offers up to **five** non-overlapping suggestions, with a reason and an expert action for each. It can also report **zero** suggestions.
2. **Upgrade:** “Rewrite my request using only the insights I approve. Keep my outcome, constraints, and scope. Improve the quality of the work, not the amount of work.” Bro returns the improved assignment for **you to review**.

The flow is **Discover → Select → Upgrade → Insert or Copy**. It typically makes **two model calls** (discovery and rewrite); if Bro finds no useful changes, it makes only the discovery call and keeps the original request.

## Example: before and after

**Your original request**

> Help me design a system that lets AI agents find relevant information in company documents. Keep our current data pipelines.

**Possible discoveries** (illustrative, not a promise of any exact answer):

| Finding | Why an expert would ask about it |
| --- | --- |
| **Depth — Test real questions first** | A plausible demo may still miss facts spread across different documents. Collect sample questions and expected source evidence before choosing a search method. |
| **Range — Link company names and metrics** | Acquired firms may use different names for the same product or metric. Map those links so agents don't mistake them for separate things. |
| **Altitude — Define what a correct answer means** | Retrieving relevant text is not the final goal. The agent must give useful, well-supported answers. |

You might approve the first and third findings and reject the second for now.

**Possible upgraded request**

> Design an approach for helping agents answer real business questions from our existing documents, without replacing our current structured-data pipelines. Start by collecting a small set of representative questions and the evidence needed for correct answers. Compare retrieval approaches against those questions, including how they handle facts spread across documents. Recommend the smallest sound design and specify how we would test answer correctness, coverage, and source support. Flag gaps in access or evidence rather than assuming the answers are known.

Bro has **not designed the system** here. It has improved the assignment you can give to Pi. You can still edit or reject the rewrite.

## Controls in the modal

Every consequential action is a **button** on the action row. `Tab` / `Shift+Tab` move between the text/list area and the buttons, `←`/`→` move between buttons, and `Enter` activates the focused one. The focused button is marked with `›`. Nothing that changes your request or your editor happens on a stray keypress.

| Screen | Key | Effect |
| --- | --- | --- |
| Write a request | `Enter` | Start a new line in the objective. |
| Write a request | `Ctrl+S` or `Ctrl+Enter` | Start discovery. The same as the `[Discover gaps]` button. `Ctrl+S` is listed first because many terminals never deliver `Ctrl+Enter`. |
| Review discoveries | `↑` / `↓` | Move the highlight between findings. |
| Review discoveries | `Space` or `Enter` | Tick or untick the **highlighted** finding. Either key works, so there is no wrong one to press. Nothing is selected at first, so you approve only what you read; the reason for the highlighted finding is shown under the list. |
| Review discoveries | `Tab` | Move focus to the buttons. |
| Review discoveries | `[Rewrite with N selected]` | Generate a revised request using only the ticked findings. With nothing ticked it explains why instead of proceeding. |
| Review discoveries | `[Select all]` / `[Select none]` | Change every tick at once. |
| Revised request | `[Insert into editor]` | Insert the revised request into Pi's main editor, **without sending it**. See editor behavior below. |
| Revised request | `[Copy]` | Copy the revised request to the system clipboard. |
| Revised request | `[Back]` | Return to the findings and change your choices. |
| Failed step | `[Retry]` | Repeat **the step that failed**: a failed rewrite retries the rewrite with the same approved findings, so your choices are not lost. |
| Any screen | `Ctrl+C` | Copy the objective or the revised request, so closing never loses pasted work. |
| Any screen | `Esc` | Cancel/close. A running backend request is asked to stop. |
| Read long content | `↑`/`↓`, Page Up/Down, wheel | Scroll. In the findings list, `↑`/`↓` move the highlight and Page Up/Down scroll. |

If there are **no material findings**, the revised-request screen displays your original text unchanged. You may copy, insert, or close it; no rewrite model call is made.

### What happens to the original editor draft?

- **Before you insert:** Opening, selecting, copying, cancelling, or retrying Elevate does **not** change the main editor.
- **In Pi terminal (TUI):** The `[Insert into editor]` button replaces the editor text with the revised request. It only replaces the draft Elevate was opened on, and only if that text has not changed since it opened; if you opened Elevate with an explicit request, the editor must be empty. Otherwise insertion is refused and you can copy instead. There is no built-in undo of this replacement in Elevate—copy the original first if you want to keep both versions.
- **In compatible Pi Desktop/RPC:** The adapter only inserts when the editor is empty and confirms atomic insertion support. If the editor contains a draft or insertion isn't supported, use `[Copy]` and paste manually. It does **not** replace a Desktop draft.
- **After insertion:** The new text remains editable. **Nothing is sent to Pi's main agent** until *you* submit it.

## What Elevate can and cannot do

**Does:** Improve how the assignment is framed, point out missing checks, offer cross-field methods, help you choose, and create a stricter request that preserves the outcome and stated limits.

**Doesn't (MVP):** Solve the task, run real-world experiments, fetch external sources as an explicit research step, implement code, interrupt the agent mid-task, ask the main agent for advice, or save an ongoing Elevate conversation. It cannot confirm its ideas are correct without external evidence. Suggestions are **model-generated hypotheses**, not verified findings. The rewrite may still misread your intent; review it before sending.

**Access and privacy:**

- Bro sends the **request**, conversation history selected by **Messages** or **Full**, saved Bro preferences if any, and later the **approved findings**, to the selected backend/provider. History is initially uncapped; Full includes tool-call arguments and text results. Hidden reasoning and image binaries are never captured. Explicit overload retries can remove older context as described above.
- Elevate uses the **BTW backend/model/effort setting** from `/bro config`, falling back to Bro's shared default. There is **no separate Elevate setting** in this MVP. Each stage makes a **fresh, non-continuing** backend call; your Elevate selections live only in memory and clear on close/reload.
- Requests use Bro's **restricted explain-style execution path**. Restrictions depend on the backend. For example, **Grok's restriction is prompt-only and its sandbox is off**; **Codex and Muse can have read tools**, including tools governed by local configuration. **Do not treat this as a firm sandbox or a guarantee of no file/network access.** Consult [backend access details](reference/data-and-permissions.md#backends-access-and-retention). Elevate itself has no file-read or file-write action.
- Closing or cancelling does not submit anything to the main agent. Your backend and provider may still retain prompts or process data under their own policies. Clipboard copies may remain in clipboard history.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Shortcut doesn't open Elevate | Some terminals don't send `Ctrl+Shift+E` as a distinct key. Use `/bro elevate <request>`; check Pi key bindings. |
| Nothing to work on | Type the objective into the modal and choose `[Discover gaps]`, or pass it with `/bro elevate <request>`. |
| “Invalid discovery JSON” | The model didn't follow the required response format. Choose `[Retry]` to repeat the step; consider a different BTW model in `/bro config`. |
| Backend/model/effort fails | Run `/bro doctor`; Elevate does not silently switch models. |
| If `[Insert into editor]` is refused | Your editor changed while Elevate was open, or Desktop can't safely insert into a non-empty editor. Use `[Copy]`, then paste. |
| The rewrite added unwanted scope | Use `[Back]` to approve fewer findings, or `Esc` to keep your original request. |
| You need source-backed research | Ask the main agent to investigate after you submit the improved request. Elevate's discovery alone does not verify source facts. |

## For maintainers

See [DEVELOPMENT.md](DEVELOPMENT.md) for code boundaries and [TESTING.md](TESTING.md) for terminal/desktop checks. `src/elevate-engine.ts` is a host-free prompt, parser, and selection layer; `src/elevate.ts` owns the Pi modal and backend calls. Future cross-harness work is intentionally out of scope.
