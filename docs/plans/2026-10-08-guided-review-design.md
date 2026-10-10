# Guided Review v1: design for issue #104

> Historical record. For current behavior, acceptance and scope see [Guided Review](../guided-review.md). Earlier milestones, paused/unqualified statuses and proposed controls below describe their time; they are not current instructions or a future-work commitment.

Status: product design approved; implementation paused after first manual UI failure. UI and delivery gates are superseded by [UI recalibration and revised delivery plan](2026-10-08-guided-review-ui-recalibration.md), pending approval. The first slice is partial implementation, not an accepted M1 checkpoint.
Source of scope: https://github.com/tranhoangnguyen03/pi-bro/issues/104 (body and updated comments).
Inspected baseline: `dd19bdc`. This document describes proposed behavior, not shipped functionality.

## Outcome and boundaries

Help a human understand a change, inspect its evidence, retain their progress, and deliberately deliver selected feedback without taking over the implementing Pi session. PR review is the primary journey; committed branch-versus-base review is also in v1.

Local Pi TUI only. GitHub access uses the user's authenticated `gh`; Git is required for captured source. Reuse all five existing backend adapters and their existing access behavior. No new permission framework, browser application, IDE navigation engine, automatic review verdict, or collaborative editing. Existing BTW and the main conversation remain intact. The launcher does not wait for the implementing agent to become idle.

Ship the complete loop with modest rendering. Internal milestones are not permission to ship a branch-only or nonpersistent substitute.

## Decisions and alternatives

- **Dedicated review state and UI, shared execution.** Extending BTW's transcript is smaller initially but loses target lifetime, evidence structure, and context separation. A separate package/framework is unnecessary.
- **Bro-owned Git object store and investigation checkout.** Never check out a PR in the user's working tree. A linked worktree is efficient but shares the active repository's metadata and does not solve unrelated repositories; a standalone managed repository supports both journeys consistently. No security guarantee is implied.
- **Captured source plus a small model-generated guide.** Do not render model quotations as authoritative code. Do not parse arbitrary Markdown into a workflow.
- **Original review plus explicit update sections.** Do not blanket-reset progress or infer that old examination applies to new code.
- **Atomic local JSON records.** No database, event-sourcing system, or collaboration protocol. One active opening of a review is the supported workflow.

## Entry and target resolution

Commands:

```
/bro guided-review
/bro guided-review <PR number or URL>
/bro guided-review branch [--base <ref>]
/bro guided-review resume
```

A URL supplies host/repository/number. A number resolves the current GitHub repository through `gh`; ambiguity asks one focused question. Use explicit repository arguments for every subsequent GitHub request, not the active directory's implicit repository. GitHub hosts configured in `gh` use the same path; Enterprise-specific behavior is not claimed qualified without testing. Reject non-GitHub target types rather than scrape their pages.

No target: prefer the current branch's associated PR only if unambiguous; otherwise offer recent local reviews, relevant PRs for the resolved repository, and Compare current branch. An unrelated URL works without a matching local clone. `resume` lists saved reviews with repository, target, last-opened time, and revision; no backend IDs.

Branch review resolves HEAD and selected base to commits and computes their merge base. Prefer an associated PR's base, then a resolved remote default branch; do not mistake a feature branch's own upstream for its comparison base or assume the literal name `main`. If uncertain ask. Show the exact locally resolved commit; do not imply that a local base ref was freshly fetched. Show refs, base tip, merge base, and head. Report staged, unstaged, and untracked work as excluded. Missing history is an actionable error, not a guessed diff. A missing local ref may be fetched deliberately; do not mutate the user's branch to obtain it.

Target keys: GitHub host and numeric repository ID plus PR number for PRs (owner/name is a refreshable display label); canonical Git common-directory identity plus full branch ref and selected base ref for local comparisons. Store human-readable paths/refs separately. Detached HEAD requires an explicit comparison identity rather than pretending it is a branch. Hash keys for storage filenames. Opening a known target resumes its record; source changes do not create an empty duplicate.

## Source acquisition and evidence

1. Resolve GitHub metadata with `gh api`/`gh pr view`: repository identity, PR description, base/head refs and SHAs, author, and accessible discussion/check information. Record retrieval time and revision association. Paginate discussion; bound model input and disclose omitted context. Follow explicitly linked requirements where accessible, with provenance; do not crawl arbitrary link graphs.
2. In Bro's managed repository, obtain the captured base and PR head (including fork PR heads through the base repository's PR ref where available). Use Git's per-invocation credential helper calling `gh auth git-credential` for HTTPS, without placing tokens in logs or persisted remotes or changing global Git configuration. Validate this with private/fork fixtures and a suitable authorised live target. Fetch first, verify object IDs, and pin captured commits under Bro-owned per-review/per-snapshot refs. Keep fetch destinations disjoint between reviews and report/retry transient Git lock failures without altering captured identities. If the ref moved during acquisition, retry metadata capture once or report the mismatch; never label bytes with a different SHA.
3. Compute the merge base from the captured tips. The initial review is `merge-base(baseTip, head)..head`, not the synthetic merge commit. Show the exact comparison even if GitHub's current presentation differs. For branch review, import the captured local Git objects into managed storage without fetching or checking out in the active tree.
4. Produce complete changed-path metadata from Git with NUL-delimited paths, old/new paths and blob IDs, status, and file mode. Generate unified hunks from the same objects with external diff/text conversion disabled. Escape terminal control characters in rendered source and paths. No shell interpolation of refs, paths, or PR input.
5. Read expanded source using blob/object access, not the mutable investigation directory. Evidence anchors contain snapshot ID, side (old/new), repository-relative path, blob ID, and line range. Renames and deletions retain their old-side anchors. Binaries, submodules, LFS pointers, and size-limited sections remain in the inventory with explicit presentation/inspection status.
6. Materialise a separate investigation checkout per review/snapshot at the captured head outside the active workspace, using linked worktrees of Bro's own object store. Different reviews must never share a mutable checkout. Keep each snapshot's path stable for cwd-bound native sessions. Backend commands run there. Do not install dependencies or run project tests merely to open the review; useful investigation can run commands when needed under existing backend behavior. Distinguish source-inspected tests, GitHub-reported checks, backend-reported activity, and model-reported test execution. Existing activity labels do not independently prove a command's exit status; do not invent verified execution receipts. Supplemental evidence is labelled by its source/revision; immutable Git objects remain the displayed evidence even if investigation changes files.

Git/gh subprocesses use explicit managed cwd/git-dir, argument arrays, bounded cancellation, and noninteractive authentication failures. Remove inherited Git directory/index overrides that could redirect operations. Disable external diff/textconv and automatic submodule/LFS materialisation for acquisition; avoid global hooks during Bro-owned checkout creation. These are source-acquisition correctness rules, not restrictions on the investigation backend.

Provide a Delete saved review action with confirmation that removes only its record, snapshot worktrees and refs; shared objects can remain for ordinary Git cleanup. Retention automation and cache dashboards are deferred. Partial fetch can reduce initial cost, but missing ancestry must be fetched before computing the comparison; no silent shallow merge-base guesses.

Store full Git evidence locally; apply bounded per-file and total prompt budgets without hiding the inventory. A user can inspect an omitted file explicitly. Source unavailability does not fabricate evidence: retain a usable metadata/error screen and a specific retry action. No automatic local-diff substitute for an unavailable PR.

## State and persistence

Storage: `getAgentDir()/bro-reviews/`, with one versioned JSON record per target and managed source directories addressed by repository identity. Keep private file permissions where supported. No settings migration or main-session entries.

Conceptual record (not a public API):

- schema version, review ID, target identity, creation/update timestamps, editable focus;
- snapshots: base/head/merge-base IDs, capture provenance, changed-file inventory, metadata/check observations;
- guide: stable app-assigned topic IDs, explanation, validated evidence anchors, unresolved references;
- progress per snapshot/topic and explicitly examined file: Not reviewed / Reviewed / Skipped; marking a topic does not automatically mark every referenced file examined;
- discussion: explicit question target, question/answer, complete/partial/failed status, backend selection;
- notes: editable wording, original snapshot/topic/anchors, open/resolved, selected-for-feedback;
- update sections linking old and new snapshots with their own topics/progress;
- view state: selected view/topic/file/hunk, logical scroll anchors, composer draft;
- optional backend continuation bound to backend/selection/snapshot/context generation;
- handoff drafts, publication attempts and receipts.

Save note/progress/target mutations immediately through a serial write queue and same-directory temporary-file rename. Debounce transient scroll position and streamed partial text; flush on idle close. Do not report Saved if persistence failed; retain in-memory work with a retry/copy path. Abrupt termination may lose the last partial stream chunk, not a previously acknowledged saved note. Unsupported/corrupt record versions produce a recoverable error without overwriting the original.

Within one runtime, reuse an already-open review rather than open another writer. Concurrent writes from separate Pi processes are unsupported; do not build locks or merge UX for v1. Clearly document this limit. Persisted `running` responses become interrupted on load. No model call is needed to reopen saved material. Missing managed source should be re-fetched by exact object identity where possible; unavailable old objects remain explicitly unavailable, not replaced by latest source.

## Combined initial quality review — superseding decision

The user approved automatic quality assessment alongside the first walkthrough and every regeneration; questions are optional, not required to unlock assessment. See [implementation plan and qualification gate](2026-10-09-guided-review-quality.md). This supersedes guide-only output below. One existing backend call investigates the whole change and relevant connected callers/tests before organizing topics. The overview summarizes coherence, prioritized findings and uncertainty. Topics retain short explanations and captured evidence; central version-owned findings carry scenarios, impact, reasoning, uncertainty, suggested fixes/checks and optional topic ownership. Cross-cutting concerns are not forced into a file topic. Findings index/coverage/private copy are application views/actions, not publication.

Legacy guides remain usable and explicitly unassessed. New generation requires an assessment; invalid individual references/findings are disclosed as incomplete, not silently promoted to a clean result. Invalid top-level output still fails. Static preparation is instructed not to install dependencies or execute project scripts/code; this is not enforcement or a sandbox. Cited evidence and model-reported inspection cannot certify conclusions. Quality qualification requires known-defect and clean-change live cases plus a no-questions unfamiliar reader; mocks do not measure competence.

## Model and backend integration

Add `review` to the internal backend feature and settings capability unions. It inherits the existing shared default unless explicitly overridden. Add the label/config/doctor/help coverage using current metadata patterns; existing selections do not change.

Execute review requests with `workspace-full` and managed checkout cwd. Current review requests are stateless at the CLI layer: reconstruct context from durable review data, disable native session persistence where supported, and reserve continuation validation/resume flags for BTW. Update each adapter's handling explicitly: cwd, deadlines, stream parsing, and progress. Do not disguise review as BTW or broaden permissions for other features. Reuse bounded execution and cancellation; no new backend abstraction or automatic backend fallback. Extend review progress with existing advisor activity parsing where applicable while retaining answer text streaming. Persist these as backend-reported labels, not independently verified command/exit records.

The initial prompt instructs the guide to inspect, explain, discuss, and prepare feedback—not implement changes or publish autonomously. Repository/PR content is quoted evidence, not authority to change those instructions. It contains captured identity, author/context provenance, inventory, bounded captured diff with app-assigned hunk IDs, optional user focus, and existing reader preferences. It does not include the main Pi conversation. Attaching main-session context is deferred; no context-attachment UX is needed in v1. Guide instructions ask for meaningful behaviors, evidence, uncertainty, and appropriately short explanations—not a quota of bugs or topics.

Initial guide output: JSON with a summary and ordered topics (`title`, `explanation`, evidence references, optional questions). Application validation checks structure, path/side/line bounds against the snapshot's full Git trees (including unchanged callers), and rejects supplied workflow fields. Prefer app-assigned hunk IDs for changed evidence; direct path/range references also work for surrounding and unchanged source. Topic IDs are assigned locally. Invalid references are shown as unresolved and cannot open invented code. A malformed guide keeps captured Changes usable and offers explicit retry; do not publish partial JSON as a finished guide. Show real activity while generating; do not invent percentages.

Follow-up answers are Markdown, attached to an explicit topic/hunk/range or whole review target. Validated structured references may accompany an answer; otherwise prose references are not automatically trusted links. Keep the initial explanation separate from discussion. A question cannot silently regenerate the guide. Regenerating an already valid guide is deferred; explicit retry handles malformed/failed generation. Focus edits shape subsequent discussion and update generation without erasing the initial explanation. Fenced text diagrams are allowed when useful: factual diagrams cite evidence, conceptual sketches are labelled, and code-like diagrams retain horizontal layout rather than prose wrapping.

Navigation, progress, note saving, selection, and publication are application actions. No model-output command interpreter is needed in v1. The user can save a selected answer/observation into an editable note. Plain-language requests receive useful suggestions but do not become hidden state transitions.

Current requests reconstruct context from durable review facts and relevant discussion, so they do not depend on native session identity. Preserve all discussion locally; bound the prompt and disclose omitted older discussion. No silent model/backend changes. Native continuation is deferred until it demonstrably improves this workflow.

## Local Pi interaction

Use one `ctx.ui.custom()` component with an overlay/full-area option, one controller, and explicit focus regions. Guard with `ctx.mode === "tui"`; do not route unsupported hosts into the main conversation. The main agent can continue while the overlay owns keyboard focus. The user cannot type to the main editor while that overlay is focused: Esc cancels active review generation, then idle Esc returns to the main editor with captured work saved. Background generation while the review is closed is deferred. This preserves the issue's explicit cancellation behavior; it does not promise simultaneous keyboard interaction with both sessions. No `waitForIdle`, tool/model changes, or main-conversation messages.

Wide sketch (illustrative 110 x 32):

```
repo · PR #142 · captured a81c9e2       [Scope] [Focus] [Finish]
[Guide] [Changes] [Notes 2]                         [Expand]
Topics                   | Duplicate delivery
  Job records            | Explanation remains here.
  Retry rules            | Evidence: send.ts @ a81c9e2
> Duplicate delivery     | [Show diff] [Reviewed] [Skip] [Add note]
  Tests                  | Discussion (2) [Expand]
-------------------------+-----------------------------------
Ask about: [This topic v]
> Could delivery succeed before this write?
Tab: focus · Enter: activate/send · Esc: close
```

Constrained sketch (illustrative 60 x 20):

```
repo #142 · a81c9e2 [Scope] [Finish]
[Guide] [Changes] [Notes 2]
[Topic: Duplicate delivery v]
Explanation OR selected captured evidence
(scrollable; returning restores position)
[Diff] [Reviewed] [Skip] [Note] [More]
Ask about: [This topic v]
> Could delivery succeed before this write?
Tab: focus · Esc: close
```

Tab/Shift-Tab cycles views/navigation, body/actions, target, composer. Arrows act only on the focused region; composer arrows edit text. Enter activates the focused action or sends nonempty composer text. No global letter shortcuts while typing. Next topic and mark Reviewed are separate. Horizontal movement belongs to code; prose wraps. At smaller sizes collapse optional chrome, not essential actions; below a usable minimum show resize guidance with a working close action.

Changes shows the entire inventory, then hunks and expandable source. Ask-about supports topic, hunk, explicit old/new line range, or whole review. Notes retains original evidence and editable outgoing wording. Concerns and progress are independent. Coverage labels distinguish included-in-guide, inspected-by-user, skipped, and omitted/unavailable; touring topics does not imply all files examined.

During generation, already-captured Changes and saved topics remain usable. Esc during a response cancels that response and stays in the review; another idle Esc saves/closes. Cancelled output is labelled partial and does not complete a topic. Closing/disposal and `session_shutdown` abort owned subprocesses and flush best-effort persistence idempotently. Late callbacks cannot write into a reopened review instance.

## Updates

Resume/refresh/pre-publication checks compare the captured base and head with current metadata. Failure to check says freshness unknown and does not erase or block the review. Changes are informational, not permission gates.

Continue this review keeps the old evidence. Review newer changes captures a new comparison and appends an updates section. Lead with what changed between the old and new PR comparisons: files entering/leaving the comparison and changes to their old/new patches. Include base/merge-base changes and label rebase/upstream-only effects. Raw old-head to new-head source diff is supplementary, not the sole account of author changes; `git range-diff` can supplement explanation but is not authoritative line evidence. Base-only movement must not appear as “nothing changed” when comparison membership changed. The current full comparison is always inspectable. Explain force-push/rebase effects as such, not necessarily new feature work.

Existing progress remains attached to the old snapshot. New update topics begin Not reviewed. The update prompt includes both captured comparison identities, the comparison-change inventory, relevant old/new evidence, earlier topic summaries, and open notes with their original anchors; disclose any context truncation. Keep notes with original anchors; suggested links to new evidence supplement, never rewrite them. “Appears addressed” is an assessment; only the user resolves the note. No semantic impact-certification algorithm.

## Feedback and publication

Finish is a summary, not automatic approval: examined/skipped material, unresolved questions, selected notes, and private notes excluded. Prepare outgoing text from selected notes; user edits it and explicitly chooses COMMENT, APPROVE, or REQUEST_CHANGES. Do not infer verdict from progress. Branch review offers Pi/private handoff, not a GitHub target guess.

Preview shows repository/PR, captured commit, action, exact outgoing text, and commit-pinned source links (old-side links use the appropriate old commit). GitHub checks/permissions and self-review restrictions may make actions unavailable; explain those without switching action. Publish a summary review through the GitHub reviews API with explicit `commit_id` and event. If GitHub rejects an old commit/action, preserve the draft and explain; never silently substitute the latest commit. Offer an explicit re-preview to submit against the current head while the body still identifies the older reviewed revision. Show both SHAs and require a fresh publish action. GitHub's exact old-commit rejection behavior needs controlled qualification, not an assumed guarantee.

Before sending, persist an attempt ID, exact payload and digest, account identity, and pending state. Add a small hidden marker identifying that attempt to the body. On success store review ID/URL, submitted time and commit. On transport ambiguity or restart with a pending attempt, query paginated reviews for the marker/account/payload before offering a retry. If outcome remains uncertain, say so and offer reconciliation again; do not automatically re-POST on an empty or failed lookup. Disable duplicate clicks while sending. Changing the payload creates a new deliberate attempt, not an accidental retry.

Pi handoff contains selected findings and intended next step, not the transcript. Use the existing TUI editor guard: if empty insert as an unsubmitted draft; if occupied leave it untouched and retain the prepared handoff with copy/later-insert actions. Save privately and close is equally normal.

## Files and integration scope

Proposed focused modules (split only as needed):

- `review.ts`: target-scoped orchestration, state transitions, prompt/context construction.
- `review-store.ts`: record schema validation and atomic persistence.
- `review-source.ts`: Git/GitHub acquisition, captured evidence, publication/reconciliation functions.
- `review-ui.ts`: local TUI rendering and input, no Git/model process ownership.

`bro.ts` routes the command and lifecycle only. `backend.ts` adds review conversational semantics. `settings.ts`/`config-ui.ts` expose the capability through existing patterns. `prompt.ts` may host pure review prompt builders rather than duplicating reader preferences. Do not refactor existing unrelated modals.

Tests cover new modules and every changed adapter branch; extend current fake CLIs, settings fixtures, command routing, help/doctor tests as needed. Update explicit build/test input lists (`test-build.mjs`, test scripts), package shipped files, README/help, and development map. Runtime delivery needs the project's release/version policy; this design-only change does not claim a release.

## Delivery checkpoints and verification

### M1: first PR-first vertical slice (internal)

Explicit PR URL -> identity -> managed source -> actual diff -> validated guide -> contextual question -> close/restart/resume. Minimal single-column layout first; demonstrate constrained and wide screens before polish. No publication in this slice.

Acceptance checks:

- Public PR outside current repository opens; fake/private/fork acquisition cases cover identity and missing access. Live private/fork checks require suitable authorised targets.
- Capture active branch, HEAD, status and dirty-file contents before/after; identical after launch and investigation fixture. No main conversation or BTW mutations, no waiting for agent idle.
- Evidence expansion reproduces captured blob bytes (apart from safe terminal presentation); unrelated workspace source is never substituted.
- Topic and hunk questions receive explicit snapshot/target context. Invalid model reference remains unresolved; model prose cannot change progress.
- Close/reopen restores guide, question, position and partial status without a model call; remove continuation ID and demonstrate reconstructable context.
- Two different reviews of the same repository have different checkout paths and cannot replace each other's evidence; no cross-process editing of one review is claimed.
- Cancel during guide generation, close, and reopen: captured Changes and any partial status survive, with an explicit retry rather than a silently completed guide.
- UI tests at 110x32 and 60x20 plus resize, wide characters and composer typing; live local Pi demonstration distinguishes rendering tests from host qualification.

### M2: complete private loop

Discovery, branch comparisons, focus editing, notes/progress, full inventory, durable failure recovery, explicit newer-revision sections. Exercise missing evidence, base-only movement, force-push, lost backend session, interrupted response, occupied editor preparation, and save failure. No global progress reset.

### M3: handoff and release qualification

Preview/publication/reconciliation, Pi insertion, docs/settings/doctor and packaging. Fake GitHub tests cover verdicts, stale commits, rejected requests, accepted-but-response-lost, pending attempt after restart, duplicate clicks and pagination. Live publication only against an explicitly authorised controlled test PR; no production-PR test posts.

Run targeted offline tests during each slice; fresh full `npm test` and `npm pack --dry-run` before completion. Add review fake-CLI cases for all five adapters without paid calls. Live backend smoke checks and local Pi demonstrations are a separate, explicitly reported verification budget; do not label mocks as live qualification. Existing PiG checks remain regression checks for shipped behavior, not a Guided Review host commitment.

## Investigation evidence and remaining qualification

Inspected `backend.ts` (feature/access checks and all adapter continuation branches), `bro.ts` BTW and command routing, `settings.ts`, `ui-capabilities.ts`, package/test configuration, and development docs. Current BTW is memory-only, seeds main-session context, and cannot serve as the review record. Current editor insertion already refuses a nonempty editor.

Read installed Pi extension/TUI documentation and `qna.ts`/`overlay-qa-tests.ts` examples. They support custom overlays, explicit focus routing, width-aware rendering and shutdown cleanup. Installed docs may be newer than repo-pinned Pi 0.84.2: use existing compatible Input/Markdown/custom patterns first and verify exported types before adopting newer layout components; no automatic SDK upgrade.

Read-only GitHub metadata retrieval for pi-bro PR #102 succeeded with authenticated `gh` and yielded explicit base/head SHAs. This does not qualify managed fetching, private/fork authentication, interactive UI, model output quality, or publication. Those are M1/M3 checks, not completed results. This design pass makes no paid model calls beyond the approved independent design review and no GitHub writes.
