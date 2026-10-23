# Grill Me v0.1 — comparison spike

This is a **manual model-evaluation plan**, not a claim that model behavior has been validated. Offline tests in `test/grill.test.ts` exercise prompt construction, three example topics and control routing. They cannot establish interview quality. Run all cases in Pi with the same model and similar context before treating this prototype as ready.

## Decision cases

| Case | User's topic | Expected value from a good interview | Failure to watch |
| --- | --- | --- | --- |
| Challenge a proposal | "I want every child agent to message the others without approval." | Push against interruptions, consent and coordination cost; adjust when the user gives strong reasons | Polite agreement or endless unsupported objections |
| Find a position | "Should room roles come from profiles or external consultant offices?" | Elicit constraints and discover the simplest design without assuming one option is right | Treat an open question as a fixed proposal; force profiles |
| Stress-test a bet | "Should we port more Pi-bro features to Claude-native plugins?" | Examine native vs adapters, support cost, parity and what to test first | Wander into unrelated coding details, offer vague advice |

All three use real *decision topics* from earlier project design work. See the live probe below; matched comparative runs remain outstanding.

## A/B/C procedure

Use the *same* starting topic for:

1. **Grill Me** in its own Bro modal; balanced mode first, then repeat one case in light and exhaustive. End with `/finish`. Note whether only the summary needs to be returned to Pi.
2. **Elevate** with the same topic as an objective. Capture discovery findings and any rewritten task. It is **not** a live interview; compare whether interactive questions add useful understanding.
3. **Standalone Grill Me skill** in the main Pi conversation. Use the closest equivalent depth available. Note interaction value and main-session context growth.

Record for each: questions that changed your mind, unsupported claims, repeated questions, usefulness of the final decision brief, number of calls/turns, rough token cost, and whether you could return to Pi cleanly without losing the main task. Score **1–5** for decision quality, question focus, adaptive pushback and UX; include brief evidence for each score. Expect the standalone skill to compete well on question quality. Bro's claim is the *modal boundary*, not a smarter base model.

## Acceptance criteria before merge

- Can resume a separate Grill Me session without touching BTW or main Pi conversation.
- The modal defaults to balanced, clearly shows depth and permissions, and allows changes mid-interview.
- Each completed reply asks no more than one main question; the interview ends only on user request.
- `/finish` generates a usable brief; `/insert` never silently submits or overwrites an existing draft.
- Permission constraints and Agy/full-access risks are visible and tested.
- At least one *manual* run of each case; capture actual outputs and record where Grill Me wins and loses.
- All CI checks pass.

## Live continuation probe

A direct production-backend probe used Claude Sonnet, medium effort, restricted inspection, balanced depth, no main-session context or preferences. Each case had an opening, one scripted counterargument, and `/finish`: **nine successful real model calls**, roughly 7–19 seconds each. These were not interactive terminal sessions or user-authored evolving interviews. Raw replies and timings are recorded in `grill-me-live-results.json`.

- **Child messaging:** explicitly dropped the runaway-loop objection after caps/opt-in, then identified per-recipient overload and blocking-vs-FYI semantics. The brief overstated provisional agreement and added an irrelevant `src/grill.ts` implementation target.
- **Role sourcing:** identified independence from pi-consultants and snapshot-vs-live drift. Prematurely preferred profiles; three users do not establish that migration is cheap. No Pi-room source was supplied.
- **Plugins/adapters:** inspected backend code and revised its adapter-refactor preference after the one-week constraint. It assumed plugin loading *inside* Bro rather than clarifying portability intent, and ended with multiple substantive questions.

These findings motivated small prompt clarifications: clarify materially ambiguous topics, ask one decision rather than compound questions, and separate recommendations from user decisions without invented file targets. **Those changes have not yet been live re-evaluated.** No workspace changes were observed in `git status` during the restricted calls; this is not a general sandbox proof.

Controller regressions now cover cancellation draft recovery, preserving completed turns during retry/reopen, depth changes, non-overwriting explicit insertion, and permission reset. Streaming is modal-local until successful completion, preventing late cancelled attempts from deleting newer thread content. Automated checks are not human terminal UX verification.

Still required before release: longer adaptive interviews, light/exhaustive trials, matched Elevate and standalone-skill comparisons, real terminal cancellation/reopening and clipboard checks, and live backend coverage beyond Claude. No comparative quality scores are assigned from this short probe.

## Known prototype gaps

Every backend call replays the full transcript (no native continuation), so long interviews may be expensive. The only access escalation is explicit `/access full`. Some backends can still write despite a prompt asking them not to. We should not add further modes or config switches until the first real usage feedback.
