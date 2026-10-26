# Grill Me v0.1 — comparison spike

## Current interface and evidence

`/consolidate` creates a decision brief without ending the interview. `/insert-last-message` is the only export: it inserts the latest completed reply into an empty Pi editor without submitting. `/new <topic>` and `/access full` require confirmation. `/access inspect`, `/help`, `/retry` and `/depth` provide the other controls. Questions request lettered choices, an open-ended alternative and one provisional recommendation. BTW is unchanged.

The PR description and design issue contain historical commands. Use the procedure below, not `/finish`, `/copy`, `/insert`, all-export commands or entry depth flags. Clipboard checks do not apply to the current interface.

Evidence has separate limits:

- Offline prompt tests in `test/grill.test.ts` check instructions and routing, not model quality.
- The successful controller journey in `test/helpers.test.mjs` uses a fake CLI through the real modal/controller/backend path: opening question, letter answer, consolidation, continued free-text discussion and explicit latest-message insertion. It checks history replay, draft protection, no automatic export, no model call on insertion and unchanged main-session messages. Other controller tests cover cancellation, failure, confirmations, depth and access reset. These are not human terminal tests.
- The fresh Claude probe below uses the current prompt and production backend, with scripted replies. It is not an adaptive user interview, terminal test or comparison with another product.
- The user reported local UX acceptance in [the PR comment](https://github.com/tranhoangnguyen03/pi-bro/pull/164#issuecomment-6361291419). That report is not independent verification of all backends or interview quality.

## Decision cases

| Case | User's topic | Expected value from a good interview | Failure to watch |
| --- | --- | --- | --- |
| Challenge a proposal | "I want every child agent to message the others without approval." | Push against interruptions, consent and coordination cost; adjust when the user gives strong reasons | Polite agreement or endless unsupported objections |
| Find a position | "Should room roles come from profiles or external consultant offices?" | Elicit constraints and discover the simplest design without assuming one option is right | Treat an open question as a fixed proposal; force profiles |
| Stress-test a bet | "Should we port more Pi-bro features to Claude-native plugins?" | Examine native vs adapters, support cost, parity and what to test first | Wander into unrelated coding details, offer vague advice |

All three use real decision topics from earlier project design work. Matched comparative runs remain outstanding.

## Current manual A/B/C procedure

Use the same starting topic, backend/model/effort and comparable context for:

1. **Grill Me:** open its modal, use balanced depth first, and answer both with a letter and free text. Use `/consolidate`, check the brief, then answer again to confirm the interview continues. With a draft in the main editor, `/insert-last-message` must refuse to overwrite it. With an empty editor, insert explicitly without submission. After another exchange, insertion must export the latest reply, not the older brief. Repeat one case in light and exhaustive depth.
2. **Elevate:** use the topic as an objective. Capture discovery findings and the rewritten task. It is not a live interview; compare whether interactive questions add useful understanding.
3. **Standalone Grill Me skill:** use it in the main Pi conversation with the closest equivalent depth. Record interaction value and main-session context growth. Record the skill revision used so the comparison can be repeated.

For Grill Me, also check `/help` and Esc return, slash completion, rejected old commands, both confirmation outcomes, retry after failure, and cancellation/reopening with an unsent answer. Confirm that `/new <topic>` resets full access. Check effective access and workspace state before and after calls; do not treat a no-edits prompt as a sandbox.

Record questions that changed your mind, unsupported claims, repeated questions, the usefulness of the brief, calls/turns, rough token cost when available, and whether returning to Pi preserved the main task. Score **1–5** for decision quality, question focus, adaptive pushback and UX, with evidence for each score. Expect the standalone skill to compete well on question quality. Bro's claim is the modal boundary, not a smarter base model.

## Acceptance criteria before production merge

- Resume a separate Grill Me session without touching BTW or main Pi messages.
- Balanced is the default; depth, model and effective access are visible; depth changes preserve discussion.
- Each completed interview reply asks one focused question with lettered choices, an open-ended alternative and one provisional recommended option. Check actual output, not just prompt text.
- `/consolidate` generates a faithful brief, distinguishes recommendations from endorsed decisions, and does not end the interview.
- `/insert-last-message` exports only on request, never submits and never overwrites a draft.
- Access warnings match effective backend permissions; there is no silent escalation.
- Complete manual runs of all three cases and matched comparisons; record specific benefits and failures.
- All CI checks pass. Before shipping, remove `release:none`, bump the package version and add the matching CHANGELOG entry under the repository's release policy.

## Fresh current-prompt probe

Source: `f96c6e9f84d0dbe883011531813e6ff02ac686c3`. The probe called the production backend and current `buildGrillPrompt` directly, using Claude `sonnet` (the CLI alias), medium effort, restricted file-only inspection and balanced depth. No main-session context or preferences were supplied. Raw inputs, outputs and elapsed times are in [grill-me-current-live-results.json](grill-me-current-live-results.json).

Each case had an opening, a scripted counterargument/clarification, `/consolidate`, and a further question that explicitly withheld agreement. **All 12 calls succeeded**, taking about 5–16 seconds each. All nine interview replies displayed a divider, Question heading, bold question, lettered choices, an Other alternative and one recommended option. All three briefs avoided another interview question, identified unresolved decisions and separated the model's recommendation from user endorsement. Discussion resumed after each brief.

Qualitative observations, not comparative scores:

- **Child messaging:** distinguished delivery from authority, explained why caps do not prevent injection, and proposed checking real demand after the user clarified that messages were mostly FYIs. It did not treat the brief as permission to implement messaging.
- **Role sourcing:** identified standalone runtime requirements and the snapshot/live trade-off, then focused on where users would edit roles. **A known weakness persists:** it inferred cheap migration from a population of three users without evidence about role complexity. The current prompt does not eliminate premature design recommendations.
- **Claude plugins:** asked about the purpose of porting rather than assuming plugins would load inside Bro. It accepted the clarification and later proposed a smaller evidence-gathering experiment. However, it first recommended shared-core extraction without inspecting feasibility, and still preferred a coding spike over asking the two users what they need. These are provisional judgments, not established project facts.

The tracked workspace diff was identical before and after the calls, and `git status` showed no new workspace files before the results were copied in. This is a bounded observation, not proof against all possible writes. Tool activity, token usage and the physical model behind the `sonnet` alias were not recorded. No terminal interaction, editor insertion, matched comparison or cross-backend claim follows from this probe.

## Elephant-style interview upgrade — candidate evaluation

The follow-on prompt change is deliberately limited to the continuing interviewer. It borrows the **Elephant** idea (context-rich problem framing, thoughtful trade-offs, and decision transfer) from Google's [Elephant–Goldfish Model](https://github.com/google/elephant-goldfish-model), **not** its Goldfish reviewer swarm or spec approval pipeline. It retains the modal and commands, read-only intent, one-question contract, and user-controlled ending.

The offline checks in `test/grill.test.ts` verify prompt guidance, quoted history/corrections, consolidation rules, and depth behavior. **They cannot establish whether a model asks better questions.** Previous probes in this file tested earlier prompt versions; do not attribute their results to this upgrade.

### Short adaptive interview trials to run

Compare the current prompt with the previous `main` revision using the same backend, model, effort, depth, initial context, and comparable user responses. Record the complete transcript, latency/call count, and source checks made. Score the usefulness of the next question and the faithfulness of the final brief, not the number of objections or questions.

| Case | Conversation turns to try | A useful result | Failure to watch |
| --- | --- | --- | --- |
| **Solution before problem** | "Save every Grill-me conversation." Then clarify "Only resume interrupted interviews." | Identifies the actual need before recommending storage architecture | Prescribes a database or launches a long intake |
| **Important correction** | "Cloud sync sounds useful." Then "Actually, local-only is a hard requirement." | Revises the working design and does not quietly restore cloud sync | Repeats a disallowed option without new grounds |
| **Unendorsed advice** | Bro suggests autosave. Reply "I did not agree; compare explicit save." Then `/consolidate`. | Brief records local resume as the goal, autosave as advice, and retention as unresolved | Converts Bro's suggestion into an agreed decision |
| **Persuasive counterpoint** | Challenge Bro's concern with a strong reason. Then offer an accepted trade-off. | Acknowledges the answer and moves on to a distinct consequential question | Invents another objection or reopens the accepted trade-off |
| **Fact vs preference** | Ask about a repo feature with inspect access. Then supply a preference for low maintenance. | Inspects relevant available files before factual claims; asks the user about their values | Claims source verification it never performed; asks for facts it could inspect |
| **Small decision** | Start a low-risk choice at light depth; consolidate after two exchanges | Concise recommendation and brief without forced extra questions or headings | Treats depth as a turn quota or generates a full spec |

For each trial, check whether the interview preserved the main-session boundary, disclosed inspection limits, and avoided file edits. If a test cannot access a backend with enforced read-only tools, report that rather than treating a no-edit instruction as a sandbox. Test one changed constraint *after* a consolidation, to confirm a brief does not freeze the discussion.

Suggested record: **Baseline observation → changed observation → evidence → residual concern** for each case. A negative result is useful: improve the prompt where it fails, rather than add new modes, stored state, or agent calls by default.

## Historical probe (superseded interface)

The original [grill-me-live-results.json](grill-me-live-results.json) remains unchanged as historical evidence. It used Claude Sonnet, medium effort, restricted inspection, balanced depth, no main-session context or preferences, and the old `/finish` interface: nine successful calls, roughly 7–19 seconds each.

That probe exposed overstated agreement, an irrelevant implementation target in a brief, premature recommendations, compound questions and an incorrect interpretation of Claude plugins. It motivated prompt changes. It must not be used to validate the current commands or presentation.

## Remaining release gates and known limits

Still required: longer adaptive interviews, live light/exhaustive trials, matched Elevate and standalone-skill comparisons, and live coverage beyond Claude. Independent terminal cancellation/reopening and editor-insertion checks remain outside the probes here; the user's reported local UX acceptance is recorded separately above. No comparative quality scores are assigned.

Every backend call replays the full transcript, so long interviews may be expensive or exceed context limits. Full access is explicit; it is not enforced read-only. Agy inspection can also write inside the project. Do not add modes or configuration switches merely to compensate for unmeasured interview-quality problems.
