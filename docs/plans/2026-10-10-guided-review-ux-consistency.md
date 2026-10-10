# Guided Review UX consistency pass

> Historical record. For current behavior, acceptance and scope see [Guided Review](../guided-review.md). Earlier milestones, paused/unqualified statuses and proposed controls below describe their time; they are not current instructions or a future-work commitment.

## Approved scope

The human approved the reconciled whole-workspace UX inventory before edits. Claude and Agy independently audited read-only, then the lead reproduced the key defects. Discovery inventory and raw probes remain at `/tmp/bro-ux-audit/inventory.md` and `/tmp/bro-ux-audit/`. No new reviewer round, live feature calls, commits, publication, permission framework or deferred #104 features were added.

## Changes

- Enter focuses contextual actions before activation; list Enter opens the selected item. Close's reading preview honors its explicit Enter instruction, without adding a second close button. Empty screens advertise no dead actions.
- Discussion retains one validated return point. Back restores Questions/Across/file/finding origin and selection; offsets remain keyed by their actual screen. Optional topic scope filters related findings and returns to its topic. Replacement clears obsolete route context. Old records remain readable.
- Lists clamp their row after draft removal. Paging uses the focused pane and visible rows with overlap; mouse list scrolling remains selection-neutral. Long paths preserve basenames; selected finding/question previews expand, Contents gains space on wide screens and overflow cues.
- Full-width overlay removes side bleed and supports actual 36×18 terminals. Compact narrow actions/footer retain essential Back/close cues. Active pane headings and quiet inactive selection identify focus. Discussion is conversation → composer → actions; duplicate composer context removed.
- Retry saving is shared across reading/list/discussion screens; full errors are readable at the beginning of content. Save/close still waits for cancellation and successful persistence. Close confirms saving and the resume command.
- Explicit Edit and resend restores a failed/stopped question only into an empty draft; otherwise the newer draft is kept. New request errors use a validated optional error field, not model-answer text. Failed turns are omitted from backend discussion seeds; saved old answer strings are not destructively migrated.
- Preparation/regeneration/answer Stop labels and failure/stopped messages match the operation. Busy reading actions do not offer an unavailable Ask. Follow pauses above bottom and resumes when manually reaching bottom; paused output has a below cue. Wheel over pinned titles scrolls the reading pane without focus changes.
- Full finding title is shown once at the beginning; a compact title pins after scrolling. Evidence has one source-block hierarchy and an explicit uncited state. App-owned uncertainty fallback is labeled Review note. Your questions is distinct from author-question findings.
- Resume labels include saved PR title/readiness with repository/number ordering. Acquisition displays observable elapsed time, readable errors and no retry for already-open records. Help and README use the same terminology.

## Safety decisions retained

Keep visible Back controls, captured-revision/explicit-model-call confirmation, private drafts/earlier contexts, safe failing diff inventory guard, and source-versus-model provenance. Do not replace the diff guard with a naive path regex. No generic render/cache redesign; calculation refresh before key paging is retained for hosts that deliver input before the next render.

## Verification

- Ten initial new regression tests failed before implementation. Two additional route/recovery tests also failed before their corrections. New tests are included in the package test command.
- Targeted suite passed including fake backend failure/edit-resend and fake `gh` acquisition failure, with no network/model calls.
- Full serial suite: **316 pass / 0 fail**; typecheck, release selftest and smoke pass. Final rerun recorded in `/tmp/bro-ux-full-final.log`.
- Package dry-run: 19 published files; no test/temp artifacts included. `git diff --check` clean.
- Real installed Pi/fullscreen/tmux with an isolated copied saved #102 record: 132×38, 110×32, 60×20, 36×18 and tiny. Checked topic-filtered findings, finding reading/paging, composer/draft, Coverage, files/diff, Questions, Back, Close from reading focus, and saved/reopen notification. Captures `/tmp/bro-ux-fixed-*.txt` and `/tmp/bro-ux-final-*.txt`. Final minimum Coverage capture confirms no empty action rail and no resize notice at 36×18.
- Original user record was not edited. Temporary sessions cleaned up. No guide regeneration/model call.

## Remaining qualification

This pass fixes the approved UI consistency defects; it does not qualify model review accuracy, successful live simplified regeneration, physical mouse/tmux handling, unfamiliar-reader comfort, private/fork network acquisition or the five-backend live matrix. Small terminals still necessarily abbreviate PR/status labels; substantive review/diff/context content remains scrollable. Performance refactoring remains deferred unless actual lag is measured. Full #104 is still unfinished.

## Next

Reload the extension and reopen the saved review without regeneration. Human acceptance of the complete reading journey remains the next UX check. Separately authorize bounded live quality/regeneration qualification before any merge-ready claim. Changes remain local and uncommitted.
