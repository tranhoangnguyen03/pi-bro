# Human-guided review research

> Historical record. For current behavior, acceptance and scope see [Guided Review](../guided-review.md). Earlier milestones, paused/unqualified statuses and proposed controls below describe their time; they are not current instructions or a future-work commitment.

Date: 2026-10-08. Bounded round: lead + independent Agy and Claude research. No implementation changes. Recommendations, not a replacement specification or implementation approval.

## Later product decision (2026-10-09)

The user superseded the recommendation to omit automated findings: initial preparation must combine the human-reading walkthrough with holistic quality assessment and actionable fix/check suggestions. Questions are optional. Preserve the earlier reading/geometry lessons; separate concise explanation from finding details rather than suppress findings. See [combined-review plan](2026-10-09-guided-review-quality.md). This change is implemented with offline contract checks, not yet qualified for model review quality.

## Evidence and limits

Lead directly operated guidedreview.dev's public preview in the preceding comparison: overview -> Define the retry contract showed options implementation and tests with nearby commentary, persistent units and Previous/Next. This is demo behavior, not qualification of the installed product. Agy inspected documentation and a frontend bundle; bundle/event-handler inspection is source inference, not hands-on interaction despite its report's terminology. Claude's comparisons are documented claims, not product runs. Lead verified the key recommendations against primary pages below.

Agy spent part of its pass on the local repo and reported test activity, which was not needed for this web-research assignment. Do not treat its claims that managed checkouts are a sandbox or immune to mutation as valid. Also reject its recommendation for globally active letter shortcuts: our typing-safety/newcomer contract remains. Its statement that current prompt truncation is silent is inaccurate: omission flags exist, although completeness and usability still need work.

No installed-product trials, paid model sessions, remote publication, or cross-product usability study. Gerrit primary page retrieval failed, so search-summary claims about its reviewed-state behavior are excluded.

## Comparisons

### Guided Review — closest direct reference

Sources:
- https://guidedreview.dev/ (public interactive preview)
- https://guidedreview.dev/docs/how-it-works
- https://guidedreview.dev/docs/reading-the-overlay
- https://guidedreview.dev/docs/leave-comments
- https://guidedreview.dev/docs/cli

Observed preview: narrative units, overview first, actual grouped diffs and nearby explanation, visible unit list and Previous/Next. Documented engine: parse authoritative diff, give hunks IDs, ask model for grouping/order/commentary, validate references, resolve real diff for display. Without a provider it remains a usable file-per-unit diff reader. Large diffs are annotated in file-based chunks; each chunk is a model call, not free capacity.

Important discrepancy: preview groups options implementation and tests together; current engine docs explicitly separate production and tests into adjacent units. Do not turn either into a universal grouping rule. CLI docs describe an explicit Structure With AI action, so our automatic new-review generation is our own proposed choice, not borrowed proof. Agy reports distinct CLI note/export and extension GitHub-review paths; exact persistence/restart behavior was not independently exercised.

Take: review unit is the reading surface; model arranges evidence rather than rewrites it; usable file fallback. Avoid: requiring comment modes/chords, copying browser columns to a narrow terminal, mandatory test-unit taxonomy.

### CodeRabbit Change Stack — close architectural reference

Verified primary docs: https://docs.coderabbit.ai/pr-reviews/coderabbit-review
Related: https://docs.coderabbit.ai/pr-reviews/walkthroughs

Documented: coherent ordered layers containing files and exact source ranges; summaries beside corresponding lines; contract, implementation and tests may belong in one layer. Snapshots remain available; later runs may regroup topics. Reading/asking/acting happen in one workspace. The interface explicitly reports incomplete generation. It is a changing preview, not a stable UX standard. Chat availability is plan-dependent.

Take: organize by behavior/dependency, keep explanation close to its source, preserve snapshot identity and partial-state honesty. Avoid importing automated findings, severity filters, merge controls, diagrams and task systems simply because they are adjacent capabilities. Its snapshot/live action policy is not our policy: user controls stale publication, no new gating requirement.

### CodeTour — strongest simple guided-reading precedent

Verified README: https://github.com/microsoft/codetour/blob/main/README.md
Relevant sections: Navigating Tours, Versioning Tours, Content Steps, Status Bar.

Documented: descriptions attached to files/lines/selections; visible Previous/Next and a synchronized tour tree/status location; introductory content steps; resume-current-step affordances after exploring elsewhere. Tours can bind to commits/tags and export embedded source. Human-authored rather than generated PR review.

Take: narrative and actual code together, stable step identity, direct Return to walkthrough after exploration. Do not infer restart durability from the documented Resume Tour action alone. Do not copy executable tutorial commands or tour-authoring features into review.

### Reviewable — durable private feedback precedent

Verified docs: https://docs.reviewable.io/reviews

Documented: drafts autosave privately until Publish; publication preview; discussion index and revision-aware review concepts. Rich workflow includes approval defaults inferred from state, automatic deferrals, participant roles and configurable completion policies.

Take: private work must survive independently of publishing; saved discussions need a discoverable index; a publication preview is useful. Reject inferred approval defaults and complex disposition/completion vocabularies for our newcomer feature. Our examination, concern resolution and publication choice remain distinct.

### GitHub native review — familiar progress vocabulary

Verified docs: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request

Documented: explicit Viewed collapses files and tracks progress; approval/request-changes is a separate submitted review action. Not a guided reading order.

Take: explicit examination progress, familiar file escape hatch and separate verdict. Do not equate visiting or scrolling with review completion.

### Lazygit — terminal mechanics, not the product model

Verified keymap: https://github.com/jesseduffield/lazygit/blob/master/docs/keybindings/Keybindings_en.md

Documented: list-to-diff navigation, hunk/line operations, expand diff context, global PageUp/PageDown reading movement, and Esc return from diff to side panel. Extensive mnemonic shortcuts and destructive Git actions serve expert Git workflows.

Take: bounded diff viewport, inspect context without leaving tool, easy return, scrolling without repeated focus traversal. Do not copy its full keymap, staging/discard actions or hidden modes. Provide visible controls; shortcut knowledge is optional.

### Secondary comparisons (Claude research; lower weight)

- Graphite: https://graphite.com/features/pr-page — marketing describes PR overview/chat, viewed files and stacked PR context. Useful co-location example, not proof of an intra-PR guided reading path.
- Copilot: https://docs.github.com/copilot/code-review and https://docs.github.com/copilot/using-github-copilot/creating-a-pull-request-summary-with-github-copilot — primarily automated findings and summaries. Not a model for our core human-reading loop. No need to imitate findings dashboards to build guided review.

## Consolidated recommendations

1. **The main screen is a review topic containing explanation AND captured code.** Replace explanation -> Show code -> evidence as the mandatory path. More context and unrelated file exploration remain secondary actions.
2. **Visible Previous/Next plus direct topic choice.** Keep where-am-I information persistent. Topic selection must not be confused with examination/approval.
3. **A topic can span files.** Show relevant hunks with clear file headings, not all changes in each file. Keep implementation/tests together when that helps understanding; adjacent topics when it becomes too long. No rigid template. Bound verbosity by usefulness, not a required topic count.
4. **Conversation is attached, not a new navigation hierarchy.** Ask opens an adjacent/replaceable discussion region retaining current topic identity; Back to review restores the exact unit and code position. Unit/file references point to one saved discussion rather than duplicate histories. Private notes and outgoing feedback remain explicit transitions.
5. **The file inventory is the escape hatch, not the guide.** Always accessible, complete about omissions, and usable if guide generation fails. Human can inspect skipped/unmapped code. Invalid references must not cause silently hidden changes.
6. **Resume and private work are foundations, not polish.** Snapshot, location, drafts and questions survive independently of backend sessions. Visible saved/resume cues. Newer code never silently replaces old explanations.
7. **Progress is not approval.** Next/visiting does not mark Reviewed. Finishing the route does not select Approve. Publication is previewed and intentional.
8. **Borrow familiarity, not power-user complexity.** Visible labelled controls, plain-language status, no required modal keymaps, no settings detour, no copied browser dashboard.

## Sketch of the revised core (proposal)

```
Bro · Review · repo #142 · captured revision
Topic 2 of 5: When retries happen         [All topics]

Failures are retried only for transient statuses.
Check how Retry-After changes the scheduled delay.

src/retry-policy.ts · relevant captured hunk
  ... actual diff ...
test/retry-policy.test.ts · related evidence
  ... actual diff ...

[Previous] [Ask about this topic] [Next]
[Browse all files] [Questions] [Save and close]
```

On narrow terminals, explanation and code are stacked in ONE bounded reading surface, not squeezed into browser-style columns. Topic title and actions remain visible. More context expands locally. Conversation opens deliberately without losing the unit. This must not degrade back into a wall of all diffs: include only this topic's relevant sections, permit direct file/section selection when large, and keep the complete inventory elsewhere.

## What research changes in the pending design

The newcomer draft improved discoverability but over-corrected into too many drill-down screens. Revise its primary Topic/Captured code flow into the single-topic reading surface above. Retain entry/resume guidance, clear cancellation/close behavior, private questions, actual modal geometry and the fixture-first gate. Do not expand the release scope or start implementation from this research alone.

The next proof should use real captured code with two contrasting examples: documentation-heavy #102 and a multi-file behavior with its tests. Demonstrate understand -> inspect more context -> ask -> return -> next -> resume in the actual local Pi modal, including a large topic and missing evidence. Research agreement is not newcomer usability evidence.
