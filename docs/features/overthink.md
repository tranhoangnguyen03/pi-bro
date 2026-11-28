# Overthink — private second look

Overthink gives Pi's latest settled turn one private, skeptical second look. It asks one question: **Is there something the reply didn't make clear that should change what you do next?** It checks both the work and how the agent handled your direction, without spawning another agent or changing Pi's conversation. It is inspired by [pi-heads-up](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-heads-up).

## Normal use

Automatic checks are **off by default**. To enable them, go to `/bro config` → Features → Overthink. While the pilot is active and automatic checks are on, after a **normally settled user turn** (including zero-tool decisions), Overthink makes one private background call to the **same active Pi model, at the same thinking level**. If there is one consequential thing that should change your next move, a short preview appears above the input:

```text
◇ Overthink · Stalling
  Pi stopped the local prototype over public traffic, but its listener
  binds only to localhost. Build the local version as agreed.
  /bro overthink for evidence
```

If nothing material merits attention, Overthink stays quiet. The preview clears as soon as you start a new turn or switch branches.

Run `/bro overthink` to **view** the evidence behind that same finding. Opening the modal makes **no model request**. Notes never enter Pi's user/assistant conversation and do not direct the agent to perform work.

## What it checks

Overthink looks for one concrete, evidence-backed gap across the work and the working relationship, then optionally tags it with at most one plain label:

- **Sucking up** — endorsed your preference against known facts or dropped a supported objection without addressing the evidence.
- **Half-done** — agreed work is demonstrably unfinished yet presented as done or handed back early despite an available next step.
- **Overclaimed** — a material claim goes beyond or contradicts what was actually verified.
- **Overstepped** — an action actually crossed an explicit permission limit.
- **Stalling** — stopped authorized work over a concern the evidence shows does not apply or has a concrete authorized way forward.
- **Bloat** — proposed or added avoidable work, components, or decisions when a simpler path delivers the goal.

A wrong-goal finding can appear without a label. Silence after a completed check is not certification.

## Viewer

The full view shows the exact same finding and next move as the preview, plus **Situation**, **Evidence** (citing numbered `[#n]` items from the reviewed context, marking compacted or branch summaries as summaries), and **Why it matters**. It keeps five current-turn states distinct: **Not checked**, **Checking**, **Checked — nothing material to flag**, **Check failed**, and **Finding**. Earlier saved notes stay viewable as **OUTDATED**, and legacy four-question or plain-text notes stay readable as historical assessments without being reinterpreted as new findings.

In the modal:

- **Ctrl+R** — recheck the current turn now (works even when automatic checks are off).
- **A** — allow automatic checks on this branch (shown only on branches with a legacy empty-question-list opt-out).
- **?** — show or hide help.
- **U** — show or hide provider-reported token/cache/estimated-cost details (hidden by default).
- **Ctrl+C** — copy the displayed finding as Markdown.
- **Esc** — close or leave Help.
- **↑/↓** — scroll.

## Legacy opt-outs and settings

Automatic checks are toggled in `/bro config → Features → Overthink`. Editable question lists and forced four-question reports are removed from the new flow. Existing saved files and notes are left untouched:

- A legacy empty global question list in `bro-overthink-defaults.json` keeps automatic checks off until you explicitly toggle **Automatic checks** on in `/bro config`.
- A legacy empty session question list on a branch keeps automatic checks off on that branch even after global automatic checks are turned on; press **A** in `/bro overthink` to allow automatic checks on that branch (this has no effect while global automatic checks are off).
- Manual **Ctrl+R** checks work either way.

## Model, cache and privacy

Overthink **never** uses the BTW or Bro backend/model setting. It calls Pi's current `modelRegistry.streamSimple` using the untouched `buildSessionProjection()` prefix plus one appended private review prompt containing a numbered `[#n]` Source index. Keeping the conversation prefix untouched preserves provider reasoning/tool-call pairing and supports prompt-cache reuse. It uses the active physical session model and reasoning level, **never executes tools**, and does not add results to the main model context. An unexpected `toolUse` response is rejected without executing the tool and recorded as **Check failed**. Saved [preferences](../reference/settings.md#preferences) (`bro-preferences.md`) can adjust tone or answer language without overriding `NONE`, JSON keys, label names, or review rules.

Prompt-cache reuse varies by provider, model, elapsed time, and context changes; measure it with **U** in the viewer rather than assuming a hit. **A cached prefix is not free:** high thinking effort can add reasoning tokens on top of visible output. Press **U** to show *provider-reported* input, cache-read, cache-write, output, reasoning tokens, and Pi-table **estimated cost** (not a provider-billed amount). A reported cache-read of **0** may mean either a miss or unsupported caching.

Overthink stores the global automatic opt-in in `getAgentDir()/bro-overthink-defaults.json` and private checks, failures, and branch opt-out overrides in Pi session `custom` entries (`bro-overthink`). Those entries stay outside LLM prompts. Each completed check or failure appends another session custom entry; keep that storage growth in mind for long sessions.

## Limits and verification

- The second look is self-criticism by the **same** model; it is not an independent external review. Use `bro_advisor` when a genuinely separate view matters.
- Automatic checks run at Pi's `agent_settled` lifecycle event (supported from Pi 1.3), not `agent_end`. Only a normal final settlement with no queued messages may start a check. A new turn, model change, compaction, or branch move cancels or invalidates stale checks.
- Running `pi-heads-up` and Overthink together causes **two extra calls** on overlapping turns. Disable one when evaluating attention cost or billing.
- Host events, provider compatibility with numbered review copies, and cache accounting vary. See [manual qualification](https://github.com/tranhoangnguyen03/pi-bro/blob/main/docs/TESTING.md) and the [pilot evaluation plan](https://github.com/tranhoangnguyen03/pi-bro/blob/main/docs/plans/2026-11-25-overthink-replacement-eval.md).
