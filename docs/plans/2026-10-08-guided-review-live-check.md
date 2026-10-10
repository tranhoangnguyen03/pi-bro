# Guided Review — screen revamp and live check

> Historical record. For current behavior, acceptance and scope see [Guided Review](../guided-review.md). Earlier milestones, paused/unqualified statuses and proposed controls below describe their time; they are not current instructions or a future-work commitment.

## Changes from the rejected demo

- Contents owns navigation and the single Save and close / Stop and close action.
- Overview has only contextual Ask / Prepare (when needed) / Stop actions. No Start walkthrough or Browse duplicate.
- Topics have an Ask action, an explanation, and actual cited captured lines. No Previous/Next buttons or repeated whole-file diffs.
- Changed files and Questions are selectable lists in the reading pane, not lists duplicated as bottom buttons.
- File reading has Ask about this file and Back to files. Discussion has Send/Stop and Back; its composer stays in the right column.
- Stable topic/file targets own drafts, discussions and reading offsets. A guide arriving does not change the selected destination.
- New capture prepares automatically; resume does not regenerate. Failed/interrupted preparation has an explicit retry path.
- Esc returns directly from discussion to its source, then to Contents, then closes. Stop is explicit. Closing during work aborts, waits, saves and closes once. Save failure leaves the modal open.
- One production renderer/controller replaces the canned-answer demo path. Existing records migrate their composer without deleting earlier discussion.

Agy and Claude independently reviewed the previous implementation and screen inventory. The lead implemented the changes above and verified them; the agents did not review the final diff.

## Live local-Pi run

Used an isolated profile at `/tmp/pi-bro-live-review-104`, with Claude Sonnet configured as the review backend. No normal user settings were modified. GitHub access used existing authenticated `gh`; no GitHub writes.

PR: `tranhoangnguyen03/pi-bro#102`; captured head `56cdae07cf4bb5c75214c9e7249844375b3893b9`. Six changed files. Initial acquisition used the development entry into the real controller; subsequent reading/question/resume checks used the actual `/bro guided-review` command with `bro.ts` loaded.

Observed interaction:

1. Open PR → captured source → automatic real guide preparation.
2. While preparing, open Changed files → `bro.ts`. Guide completion added five topics with eight valid source references without moving the selected file or reading pane.
3. Close, launch the actual Bro extension, reopen the captured PR. No generation; select the first topic and inspect cited `bro.ts` lines 844–865.
4. Ask: “In two sentences, what happens when the standing-priorities file contains malformed UTF-8? Cite the captured code, and do not run tests or edit files.” Received a real completed answer citing fatal UTF-8 decoding and the existing assertion, explicitly saying the test was not executed.
5. Resize from 110×32 to 60×20 while answering. Composer and footer remained visible. Found that arriving answers could stay below the viewport; fixed with follow-latest until the reader scrolls away and added a regression test.
6. Send a second question, activate Stop response. The real request stopped, retaining an interrupted turn (no answer text had arrived yet).
7. Type `draft kept for resume`; close from Contents, reload and reopen. Both questions and the target-specific draft remained. No guide regeneration. A topic discussion's scroll position was retained.
8. Captured checkout remained clean (`git status --porcelain` returned empty).

Terminal captures: `/tmp/bro-review-live-evidence/01-guide-arrived-without-moving-file.txt` through `04-resumed-draft.txt`. Profile state remains available for inspection. These are terminal transcripts, not an unfamiliar-human usability study.

## Verification scope and remaining limits

Automated checks exercise screen bounds (including narrow/tiny sizes), removed duplicate controls, selectable files, stable targets during guide arrival, captured evidence, drafts/resume, real fake-backend transport, process cancellation, save failure and retry-close, and follow-latest behavior. Full suite results are reported with the delivery message.

The first real guide was too verbose and findings-oriented. The prompt now requests a reading walkthrough, short titles and 2–4 explanation sentences; that revised prompt has **not** been live-qualified. The previously captured guide is deliberately retained.

No unfamiliar newcomer test, private/fork qualification, multi-process editing, publication, or paid backend matrix was attempted. Notes, examination progress, branch discovery, update-review and explicit feedback delivery remain outside this UI/live-test pass. This is not a release or completion claim for all of #104.
