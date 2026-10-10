# Guided Review documentation consolidation

Historical implementation record; current user instructions live in [Guided Review](../guided-review.md).

## Approved work

Retain automatic persistence and Copy finding; rename Save and close to Close, retain Stop and close. Reopening the same PR is normal return; bare command lists saved reviews and resume remains a supported alias. No data deletion, new workflow features, live calls or publication.

User explicitly requires extensive documentation update and review before PR readiness. The three future slices were a lead proposal, not an approved sequence. Original broader #104 scope remains recorded for reconfirmation; no notes/progress/publication workflow is assumed next.

## Inventory closed

- README discovery/commands, readable journey, review capability/preferences/access table, private data flow, clipboard/storage, troubleshooting and limits.
- Packaged detailed review guide: actual controls, costs, captured freshness vs regeneration, full access vs instructions, persistence/recovery, manual data removal and not-built capabilities.
- Help/completion/preferences editor aligned with guide; automatic Close/reopen and clipboard messages aligned.
- DEVELOPMENT gives actual module ownership, stateless execution/evidence/migration/write invariants and scoped shutdown limitations.
- TESTING has a no-call saved-review UI journey, separate budgeted live checks, observed evidence and correct absolute-path isolation warning.
- dev/PiG docs distinguish launcher omissions, fixture history and unqualified host coverage.
- Docs indexes, package description/files, changelog and PR checklist updated. Eight older review records have historical banners; no history erased or false claims retroactively made.

## Review and disposition

Claude read the complete edits in `run_28a07f36c66a4ddfb2ebe6c8da93e623` for coherence, user-centricity and agent-experience. Confirmed concerns fixed: shipped guide no longer contains transient PR/test/slices status; all request access wording separates automatic-preparation instructions; copied records are not claimed fully source-isolated; source removal identifies hashed record mapping; packaged links no longer target unshipped docs; offline saved-picker fallback documented; dev omissions/index text/tiny Close/help spacing corrected.

Release-format finding is real but requires an explicit delivery choice: manifest/lockfile currently draft 0.22.0 while changelog is Unreleased. Repository release rules require a matching version heading when merging a bump, and merge automates tagging/npm publication. Do not silently convert this preparation into release authorization. The human subsequently authorized release on merge and PR creation. Selected 0.22.0 (minor feature release from published 0.21.0) and added the dated changelog section. Merge triggers repository tagging/npm/GitHub-release automation; PR creation does not authorize this assistant to merge.

## Evidence and remaining limits

Prior full serial suite 316 passed before prompt calibration; focused checks/typecheck afterward, manual UX accepted, bounded live defect/regeneration checks completed. No new feature-model calls in this docs pass. Current checks are recorded in delivery response/logs rather than baked into shipped user instructions. Cross-backend live matrix/private-fork/newcomer/physical-mouse claims remain unmade.
