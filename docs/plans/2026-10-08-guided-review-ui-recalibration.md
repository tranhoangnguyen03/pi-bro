# Guided Review: newcomer-first interaction and delivery plan

> Historical record. For current behavior, acceptance and scope see [Guided Review](../guided-review.md). Earlier milestones, paused/unqualified statuses and proposed controls below describe their time; they are not current instructions or a future-work commitment.

Status: revised proposal; runtime implementation paused pending design approval.
Supersedes UI and delivery gates in `2026-10-08-guided-review-design.md` and the earlier recalibration draft.
Authority: issue #104 and the user's requirement that a completely new user needs no extension-specific operating knowledge.

## Why we reset

The rejected implementation concatenated all diffs into a nearly fullscreen unframed text wall, obscured navigation behind a numerical Tab cycle, and budgeted content against terminal height while the overlay clipped at 95%. The screenshot shows the composer/footer missing. Tests checked width and total terminal rows, not the actual overlay rectangle or the user's ability to follow the review. The prior M1 status was premature.

Borders alone would not fix this. A guided reading workspace must explain where to start, what to read, what code supports it, where a question belongs, and how to return. No runtime changes during this design pass; existing uncommitted code is provisional, not accepted.

## Governing rule

A newcomer receives only this task:

> Understand one part of this PR, inspect its code, ask a question, then close and resume your review.

Everything else must be discoverable on the screen. No slash commands inside the panel, key-count instructions, unexplained modes, mandatory line-range entry, or hidden keyboard-only action. Keyboard-only operation is required; mouse support is not a prerequisite. Familiar keyboard hints are visible. Power shortcuts may supplement controls later, never replace them.

Scope is unchanged: local Pi, authenticated gh, PR-first complete review loop, independent of the implementing conversation, existing backend access, saved captured evidence and deliberate handoff. No new permission system. The UI proof precedes further backend feature work.

## Minimal screen structure

Reuse the framed, themed, padded modal conventions of BroModal/BtwModal. Those are internal components, not a generic exported Modal API; share patterns without importing BTW's conversation state or building a UI framework.

Every screen has:
- Compact header: Bro · Review, repository/PR and captured revision. A labelled Review details action opens full scope when needed.
- One reading body: overview, topic list/detail, file list/diff, or discussion. No concatenated repository-wide diff and no accumulating chat under the explanation.
- Visible contextual actions and a stable footer: Back (when applicable), Save and close, status, and keyboard guidance.
- On question/discussion screens, a fixed composer and plain-language question target, always inside the frame.

The composer need not consume rows on every reading screen. Ask a question explicitly opens it, focuses it, and states the target. This replaces mandatory Read/Ask modes and permanent target selectors. A typed draft is saved even when navigating away.

One shared geometry determines overlay bounds and inner row budget. Reserve borders, wrapped header/actions, status and composer before allocating body height. At small sizes reduce optional chrome, not essential controls; if below a usable minimum show resize guidance with close still available. Wide screens retain a readable column and visible margins; a sidebar/expand mode is not needed to prove the basic journey. These can follow after the default layout works, without rebuilding state.

## Entry and return

Expose Guided review in Bro's existing discoverable command completion/help. The bare `/bro guided-review` opens a labelled entry screen: Resume a saved review (first selected when available), Open a GitHub PR (paste URL or number), and eventually Compare current branch. Do not require remembering a `resume` argument. A development fixture substitutes source data only, not the entry/resume interaction.

After closing, show a plain local UI notification: Review saved — reopen with /bro guided-review. It must not enter the implementing model's conversation. The usability task includes following that instruction to return. Terminal command entry remains Pi's platform convention; the user should discover the feature from completion/help and never need memorised Bro-specific syntax. End-to-end discoverability is part of qualification, not assumed from a successful in-panel demo.

## The journey: screens and transitions

### 1. Opening a new review

As soon as known, show PR identity and actual acquisition status. Capture source and automatically start preparing the guide using the selected review backend. Opening a new guided review is the request for that work; do not add a Generate button the user has to discover. No model call on ordinary resume.

Visible actions: Browse changed files (enabled once captured), Stop preparation (while running), Save and close. If files are not ready, say Fetching source rather than expose an inert button. No fabricated percentage. Optional review focus remains available through a labelled Review priorities action in the overview; it is not a startup questionnaire. Editing it does not silently restart preparation or erase a guide; subsequent questions use it, and an interrupted/failed guide retry uses the latest focus.

If preparation finishes while the user is browsing code, show Guide ready with a visible Open guide action, without switching screens or stealing focus. If it fails, preserve source browsing and offer Try again next to the explanation. Stopped preparation stays stopped on resume with Continue preparing available; no unrequested restart.

### 2. Overview and suggested reading path

After preparation, show a short purpose/scope summary and ordered topic list. Distinguish author intent from observed change and uncertainty in the content, without forcing repetitive labels on trivial changes.

```
This change adds retries for failed jobs.

Suggested reading path
> 1. How failures are recorded
  2. When a retry happens
  3. Whether a job can run twice
  4. What the tests cover

[Browse changed files] [Ask about the whole PR]
[All questions (when present)] [Review priorities]
```

First topic is selected, not automatically opened. Arrows select a topic; Enter opens it. Every topic can be chosen directly. The list is always reachable as Back to overview. Do not infer Reviewed from opening/visiting; explicit examination progress is added in M2 and is separate from this navigation position.

### 3. Topic

One concise explanation plus references. Primary action: Show the code. Other visible actions: Ask a question, Next topic, Back to overview. On the last topic use Back to overview rather than silently wrapping to topic one. If no source is available, show Why code is unavailable and preserve asking/browsing; never offer a dead Show code action.

For multiple references, Show the code opens a labelled source list within the same modal. One reference jumps directly. No nested generic modal required. Explanations retain their position independently from discussion. Existing questions appear as View questions (count); they are not appended indefinitely under the topic.

### 4. Captured code

Show a heading such as Code for: How failures are recorded, path, captured revision, and cited lines. Open the referenced range with visible emphasis and context immediately; no line-number prompt. If the reference is outside a diff hunk, show captured source rather than inventing a patch.

Actions: Ask about this code, Show more context, Back to explanation (or Back to sources if entered through a source list). Every return restores the prior position and selected control. Topic identity remains visible enough to understand the relationship.

### 5. Ask and read the answer

Ask opens a target-specific discussion screen, with the composer focused:

```
Question about: jobs.ts, lines 42–58
> Why is success recorded after the external call?
[Send question]                         [Back to code]
```

Defaults follow the explicit entry action:
- Topic -> that topic.
- File diff -> that file and captured comparison.
- Cited source or selected change -> that precise range/hunk.
- Ask about the whole PR from overview -> whole review.

Do not make the user select a target before an ordinary question. An explicitly labelled Ask about the whole PR action remains available from the overview. No global target dropdown or hidden target shortcut.

Enter sends nonempty input; a visible Send question action provides the same behavior. The answer streams in the bounded discussion body, never displacing the composer. Auto-follow only while the reader is at the bottom; after they scroll away show New answer text below with a jump-to-latest action. Questions and answers stay with their target and are saved. Back restores the exact source/topic position. There is one discussion per captured target; asking again reopens that discussion, not a new isolated thread. Topic View questions includes questions on its cited evidence; file View questions includes its ranges/hunks. References can lead to the same discussion from more than one place; do not duplicate history. Every code/range screen provides View questions when any exist. Overview provides All questions, a flat list labelled by question and target that opens any saved discussion directly, including whole-review questions.

Back remains usable during generation: keep the response running while navigating within the open review, show Answering on its source/discussion entry, and save it without changing the current screen. Only one model request per review at a time; other discussion composers keep drafts and show Answering about [target], with visible View response and Stop response actions beside the explanation. The same active-response status/actions remain available while browsing; no reverse-navigation hunt is needed to stop or find a response. No background generation once the review is closed.

### 6. Browse changed files

A list of file paths with understandable status (Added, Modified, Deleted, Renamed) and explicit unavailable/binary/omitted states. Select one file to open one unified diff. Back to files returns to the selected row and position. The file list always includes Back to overview; Open guide is available when preparation finishes. The complete inventory remains reachable independently from the suggested guide.

Diff presentation has old/new line numbers, +/- markers, change colors, distinct hunk headings, and no distracting raw `diff --git`/`index` preamble. Wrap long lines by default with continuation gutters, including README prose; a labelled No wrap / Wrap action changes only presentation and enables horizontal scrolling when needed. Never wrap by altering source line numbers or question anchors.

Ask about this file is available immediately. An optional Choose a change action opens the file's hunk list (heading plus short preview); selecting a hunk highlights it and enables Ask about this change. No imaginary mouse selection or mandatory manually typed range. Precise custom ranges remain an optional later refinement; existing cited ranges and hunks provide contextual evidence in the first demo.

## Input contract: familiar controls, not extension knowledge

- Tab/Shift-Tab moves focus between visible controls, lists, scrollable reading area, and composer in screen order. Focus has an obvious marker and theme treatment, not color alone.
- Arrows navigate the focused list or scroll a focused reading area. Text input retains normal editing keys. Actions have ordinary labels; no unlabelled focus states.
- Enter activates the focused control/list item, or sends nonempty composer text. Empty input never sends a request or chooses a verdict.
- PageUp/PageDown scroll the active reading/answer area even while composing; preserve the draft/cursor. Wheel support may follow existing Bro behavior but cannot be required.
- On-screen hints explain the current controls, e.g. Arrows choose topic · Enter open · Tab actions. They are short enough to remain visible at 60x20.
- No globally active single-letter navigation shortcuts. Typing n, p, b, q cannot change screens.

Do not promise that every action fits in one row: wrap labelled action rows with measured height. Avoid a generic Actions menu for essential tasks. No hidden dropdown semantics. Prefer lists/drill-down rather than floating selectors and nested modal stacks.

## Leaving, interruption and saving

Provide explicit controls; shortcuts are secondary:
- Stop response / Stop preparation cancels the request and preserves partial output, without closing the review.
- Back navigates without discarding draft or progress.
- Save and close saves and exits. If a request is active, label it Stop and close so the consequence is clear; cancel, retain partial output, then close. No confirmation for ordinary navigation.
- Esc is consistently Back within the review, matching the labelled Back action; it never unexpectedly stops a response on a child screen. From overview it matches Save and close (Stop and close while running), with that consequence stated in the footer. Stop response / Stop preparation are the explicit cancellation controls. This deliberately revises the earlier issue/design's Esc-to-cancel convention: predictable navigation takes priority under the newcomer requirement; reconcile the issue wording after approval rather than claiming both contracts.
- Save failure overrides transient activity text and offers Retry saving and Copy unsaved text; never claim Saved or silently discard work. Normal actions autosave; no save questionnaire.
- Resume restores the last screen, position and draft. Loading saved content does not generate. Interrupted output is visibly partial with a deliberate Continue/Retry action; do not imply the backend will resume the exact interrupted generation.

## Sketch: constrained topic and discussion

Structure only; actual Pi rendering is the acceptance evidence.

```
┌ Bro · Review · owner/repo #142 · a81c9e2 ──────┐
│ How failures are recorded              1 of 4 │
├──────────────────────────────────────────────┤
│ Failed deliveries now leave a retry record.  │
│ The worker uses it to schedule another try.  │
│                                              │
│ Evidence: jobs.ts, lines 42–58                │
│                                              │
│ > Show the code                              │
│   Ask a question                             │
│   Next topic                                │
│   Back to overview                          │
├──────────────────────────────────────────────┤
│ Saved · [Save and close]                      │
│ Tab controls · Enter select · Esc overview    │
└──────────────────────────────────────────────┘
```

```
┌ Bro · Review · #142 · a81c9e2 ────────────────┐
│ Question about: jobs.ts, lines 42–58         │
├─────────────────────────────────────────────┤
│ You: Why record success after delivery?     │
│ Bro: Delivery may succeed before its result │
│ is recorded. A crash here could…            │
│                                             │
├─────────────────────────────────────────────┤
│ >                                           │
│ [Send question] [Back to code]              │
│ Answering… [Stop response] [Stop and close]  │
│ Tab controls · PgUp/PgDn read · Esc back     │
└─────────────────────────────────────────────┘
```

## Full release still includes notes and handoff

M1 must not display fake Notes/Reviewed/Publish controls. M2 adds explicit Mark examined, Skip, and Save private note in topic/discussion context; Next remains navigation only. Saved questions never become concerns automatically. Overview provides private notes and coverage, then Prepare feedback. Selected feedback goes to a distinct preview with target/revision/action before explicit publication, or an unsubmitted Pi draft. Saving privately remains normal. Update review preserves original evidence/progress rather than rewriting it. These remain delivery scope, not prerequisites for the first UI demonstration.

## Revised plan and proof gates

### A. Design acceptance (current)

Agree on the newcomer journey and the controls above. Agy and Claude independently challenge ambiguity, hidden knowledge, excessive choices, and scope drift. One bounded parallel review of this draft is authorised. Lead resolves findings; no implementation during this pass.

### B. Actual modal demonstration, using realistic data

After approval build the UI against a captured #102 snapshot and a hand-authored guide in the real review schema. Use the production modal rendering path with a development-only fixture launcher, not a separate polished mock. A second small code fixture supplies additions/deletions, multiple hunks, unchanged caller evidence and one unresolved reference. No model calls or GitHub writes needed. Simulate delayed preparation, streaming, failure and cancellation with the same controller event interface intended for integration; do not create a general simulation framework.

Demonstrate at 110x32 and 60x20:
1. Identity/loading then purpose and selectable reading path; browsing during preparation does not get interrupted.
2. Topic -> cited source -> ask -> streamed answer -> Back to source -> Back to explanation, preserving position/draft.
3. Files -> one long documentation diff -> another code file -> choose a hunk -> targeted question; wrap remains readable and anchors unchanged.
4. Stop, failure, missing evidence and save-failure recovery; no missing footer/input.
5. Resize while scrolled, close, restart/resume without generation.

At least one person who did not participate in the design and has not been taught the screens receives only the task in Governing rule. The demonstrator provides no operating instructions; record where the person hesitates or needs help. The lead, Agy, Claude and an already-briefed owner cannot substitute for this newcomer test. If no such tester is available, report that gate as unverified rather than block all fixture construction or claim success. If the demonstrator must explain a key sequence, where the answer went, or what a control means, the gate fails. Record screenshots plus an interaction trace; static screenshots alone do not prove usable navigation. User accepts the demo before real backend integration proceeds.

### C. Integrate and qualify the actual review journey

Re-examine existing acquisition/state/controller code rather than assuming it is complete. Connect the approved renderer to captured sources and model requests. Verify target correctness, malformed guide recovery, interrupted output, save failures, lifecycle cleanup, no silent context leakage, and source/active-workspace preservation. Real guide quality and backend behavior require separate live checks; fake streams cannot establish them. No M1 acceptance until B and C pass.

### D. Remaining loop

Only after accepted M1 add notes/examination, branch/discovery, explicit update review and publication/Pi handoff. Keep labels and navigation consistent with the demonstrated pattern; avoid growing a universal toolbar. Publication qualification uses an explicitly authorised test target. No release, commit, push or external update is authorised merely by this design pass.

## Regression evidence, not just a visual promise

- Test actual overlay bounds and assert visible frame/header/actions/status/composer in each applicable screen, including wrapped status and tiny viewports.
- Screen fixtures/snapshots at 110x32, 80x24, 60x20 and below-minimum sizes; assert selected file only, correct target, stable gutters and bottom border.
- Drive keyboard events to complete user tasks. Assert visible labels/focus/return location, not private numerical focus state. Do not replace input tests entirely with named internal method calls.
- Simulate streaming while scrolled away and navigating to another screen; no stolen focus, lost drafts, or composer movement.
- Persistence fixtures must round-trip active screen and reading positions; screenshot tests alone do not prove resume.
- Live local-Pi demonstration is a separate requirement. If unavailable, mark the gate unpassed rather than substituting Node rendering tests.

## Current status

The user approved proceeding with the MCP-adapter-style two-column fixture demo. Left contents selection immediately updates saved right-hand content without generation. Topics co-locate explanation and captured code; All changed files and Questions provide alternate access. Enter enters reading/actions, Tab advances focus, and Esc returns toward contents before closing. Narrow layouts use contents → reading. Model/backend integration remains paused until demo acceptance.

Implemented the initial development-only launcher in `dev/review-demo.ts` and renderer in `review-modal.ts`; see `dev/README.md` for launch instructions, recorded source identity, verification and limitations. Claude completed one bounded read-only review. Addressed minimum-height clipping, misleading Tab hints, empty-question focus, save-status recovery and topic scroll keys. Automated checks include discussion bounds, retained drafts, simulated completion/stop, saved-state round-trip and failed saves. Actual Pi was exercised at 110×32 and 60×20.

Subsequent user approval authorised Agy/Claude screen audits, removal of redundant navigation, production integration and a real manual review. The production `/bro guided-review` now uses the two-column renderer and real execution path; the canned demo timer was removed. Topic evidence is displayed as cited captured source ranges, and file/question lists are directly selectable. See `2026-10-08-guided-review-live-check.md` for the screen decisions and actual PR #102 run. Unfamiliar-human testing remains outstanding; the fixture gate is not a substitute for that check. No release, push or GitHub write occurred.
