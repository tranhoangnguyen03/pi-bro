# Guide regeneration

> Historical record. For current behavior, acceptance and scope see [Guided Review](../guided-review.md). Earlier milestones, paused/unqualified statuses and proposed controls below describe their time; they are not current instructions or a future-work commitment.

**Superseded version-retention design:** The user removed guide-version retention on 2026-10-09. Production now keeps one current guide and replaces it automatically on successful generation; failures/cancellation preserve it. Earlier questions/drafts retain only compact target context. Legacy multi-version records are validated, migrated on read without rewriting, then saved without guide-version fields. The rest of this document records the earlier design and historical live check, not current UI behavior.

Approved scope: explain the **same captured source** again with the current generation prompt, preferences and backend. This is not a newer-revision fetch, a review reset, or publication.

## Interaction

Overview offers Regenerate guide when a guide exists. Confirmation states the captured revision, retention of current guide/history and the real model call. The review overlay is temporarily hidden while the host confirmation is visible, then restored. A decline does not run a request.

Regeneration uses the real controller, with a persistent elapsed-time header and Stop response. Existing topics, file browsing, questions and reading positions remain usable. Completion never switches the selected guide or screen. Only after the new version is saved does Open new guide become available on Overview. New versions open at Overview; Guide versions selects any saved version. Questions includes old topics with their version labels and explicitly switches to that version when opened.

## Data and failure behavior

- `guideVersions` stores immutable guide content, creation time and saved view state. `activeGuideId` identifies the displayed version; `pendingGuideId` identifies the latest unopened result.
- `guide` remains the compatibility alias for the active version. Load validation rejects contradictory identities/content, duplicate topic identities and damaged saved views rather than guessing or overwriting the file.
- Existing guides migrate as Guide 1 without rewriting topic IDs. New topic IDs include a unique guide-version namespace. Identical titles/positions cannot inherit earlier topic history.
- Drafts and offsets are retained; previous version views are saved on switching. Whole-review/file discussions remain shared because the captured source is unchanged. Existing unrelated record fields are not deleted.
- Fresh generation excludes the old guide and discussion text from the prompt, avoiding accidental anchoring to the previous grouping. It retains captured source, review focus and preferences.
- Invalid output and cancellation leave all successful versions intact. Cancellation is checked again after asynchronous evidence validation before installing a result.
- A successful but unsaved result remains in memory with a save error. It cannot be opened as a saved version until Retry saving or another successful save completes. Stop and close waits for request cancellation and saves before exiting.
- Notes/examination UI is not implemented; this operation does not imply otherwise. Their future data must follow the same preservation rule.

## Verification

Automated controller tests exercise declined confirmation, generation, explicit activation, old-question routing, malformed output, cancellation during evidence validation, post-generation save failure and retry. Model tests cover migration, distinct identities, preserved drafts/offsets, fresh prompt isolation and damaged version validation. Existing layout/mouse/controller tests cover the additional destination and controls.

One live Claude Sonnet regeneration was run against PR #102 in the isolated profile `/tmp/pi-bro-live-review-104`. The old topic remained readable and selected throughout. The model omitted the required evidence `side` field, so validation correctly rejected the result. The original guide, both questions and the target-specific draft remained intact. Live testing also exposed the host confirmation being covered by the review overlay; hiding/restoring that overlay around confirmation fixed it, with a regression assertion added.

The failed-output diagnostic and prompt requirements were tightened afterward; the complete final model response is now retained on validation failure. A successful live regeneration with the revised wording is **not yet qualified**. Successful generation/version switching/save recovery were verified through the real controller with a fake backend. No further paid retry, GitHub write or publication was performed.
