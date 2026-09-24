# Grok backend implementation plan

## Superseding direction (user review of #57)

The initial advisor-only scope below is historical, not the final acceptance criteria. User explicitly requires capability-first behavior: enable Grok explain/show/BTW/advisor; unavailable enforcement becomes prompt guidance with accurate access descriptions. Remove speculative tool blacklists. Native BTW uses stable workspace cwd, backend-bound IDs and fresh resets on backend/access changes. Track Claude follow-up in #58, Grok delivery in #59 and remaining limitations in #60. Existing completion/cancellation/input validation stays intact.


**Goal:** Add Grok through the existing execution boundary and per-capability settings, preserving Agy defaults and Claude behavior.

**Architecture:** Reuse backend.ts lifecycle; add a concrete Grok transport and tests, not a backend framework. bro.ts retains feature behavior, retries and atomic settings. Unsupported access/features fail before spawn; never downgrade sandboxing.

**Tech stack:** TypeScript, Node child_process/fs, installed Grok CLI, node:test.

## 1. Verify installed CLI
- Baseline from merged #56: 69 tests + offline smoke pass.
- Installed Grok 1.0.41; `grok models` reports grok-4.7, grok-4.7-build-fast, grok-4.6, grok-4.5.
- Capture one fresh streaming-messages-json terminal response and effort evidence before implementing parser.
- Investigate restricted controls: empty GROK_CONFIG_PATH still discovers 32 user hooks. Scratch cwd/tools-empty alone is insufficient.
- Initial implementation scope: fresh workspace-full advisor. Restriction can be lifted only with verified CLI isolation; no silent fallback. BTW continuation deferred rather than inventing thread compatibility.

## 2. Adapter (backend.ts, grok.test.ts)
- Write fake CLI tests first: unsupported combinations no spawn, prompt file handling/cleanup, argv/cwd, authoritative terminal completion, nested/reasoning isolation, errors after partial, exit errors, cancellation/deadline.
- Reuse beginAttempt group cleanup. Use private temporary prompt file instead of argv for large private advisor context.
- GROK_EFFORTS low/medium/high/xhigh subject to installed evidence; default omits flag. Runtime CLI rejects model-specific unsupported efforts.
- Preserve Agy/Claude tests; reject unknown backend tags rather than falling through to Agy.

## 3. Settings/UI (bro.ts, settings.test.ts)
- Test v2 Grok parse/save/whole overrides; max rejected; default effort omitted.
- Atomic backend/model picker with seeded models + custom IDs; effort reset on backend switches.
- No Agy catalog lookup for Grok model/effort paths; doctor only probes selected backends and accurately labels installed versus auth/connectivity.
- Surface unsupported features in config/doctor/commands and backend boundary.

## 4. Review and delivery
- Independent Agy access audit and Grok protocol/lifecycle review; parent verifies findings.
- Update README, changelog, package version/test command, manual E2E checklist.
- npm test, npm pack --dry-run, release selftest/validate, diff checks; minimal authenticated adapter advisor check in disposable workspace.
- Push reviewable PR under tranhoangnguyen03; await user manual verification, do not merge.
