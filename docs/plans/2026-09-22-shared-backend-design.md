# Proposal: shared backend execution for Bro (#52)

Status: draft for owner review; not implemented or posted. Baseline: current checkout b6650b2 (v0.15.0); original audit began at 3f45ec9. The intervening diff was checked: execution transports are unchanged; preserve the new BTW clipboard `/copy` versus editor `/insert` behavior.

## Review status and approval decisions

Revised after the owner's CLI-first steer, with completed contributions from all four requested harnesses. Primary agent synthesized findings and verified relevant source; reviews are inputs, not blanket approvals.

| Reviewer | Completed contribution | Evidence / limitations |
|---|---|---|
| Claude | CLI transport/configuration/rollout design | run_9e4f90ee4f544921b627a6bce3a2fe4c: done; source-backed; wrote an additional plan under ~/.claude/plans, no repository implementation |
| Agy | Lifecycle, continuation, protocol and permission review | run_c920488641eb4bb18212796e11e8ad73: done; source-backed; some observations referred to the previous draft and were checked against the revision |
| Muse | Atomic settings, capability gates and rollout review | Direct CLI with explicit high effort and write/shell disabled; root run.terminal.completed for command 77bebc6c-223f-4eb4-a507-0e33b279a0e3; supplied-context review, not repository investigation |
| Grok | Independent execution-policy/continuation review | Direct prompt-only CLI with tools disabled, sandbox explicitly off; session 01a0c986-2cef-79f0-86e5-5565653e8288 returned end_turn; supplied-context review, not a successful readonly-sandbox test |

Accepted: CLI-first rollout, backend-local effort validation, per-access/continuation capability checks, authoritative terminal outcomes, staged continuation IDs, and previous attempt cleanup before retries. Rejected: copying readonly permission tiers as proof of no-project access; exposing argv/stdin as shared capabilities; requiring Agy NDJSON on every advisor adapter; making advisor wait on BTW; silently converting explicit off to a different reasoning level. Deferred: all-Agy stdin conversion, broad buffer-limit changes, Windows process-tree expansion and unrelated UI polish.

The earlier failed runs and concrete pi-flow-external issue drafts are recorded in `2026-09-22-pi-flow-external-issues.md`. Muse/Grok workarounds bypassed the broken invocation paths explicitly; they do not establish those adapter defects are fixed.

Decisions proposed for owner approval:
1. Route all four features through one execution boundary, preserving feature-owned retries/progress/UI.
2. Agree version-2 atomic selections now; introduce persisted schema/UI migration with the first external CLI adapter, not #44. Retain legacy disk settings in the Agy-only PR.
3. Include the explicitly described bounded-stop correction in the Agy migration, rather than claim the current lifecycle already meets #52's criteria.
4. Agy remains the installation/legacy default. Prioritize Claude, Codex, Grok and Muse after extraction; Pi completion and any Pi agent harness come last. User-selected alternative defaults visibly mark unsupported features rather than silently falling back.

Validation: proposal JSON example parsed successfully, code fences checked, and repository diff whitespace check passed. No implementation or live model validation was performed for this proposal. GitHub has not been updated.

## Scope

One internal execute boundary for explain, show, BTW, and advisor. First merge implements only Agy, which remains the default. Then prioritize Claude Code, Codex, Grok and Muse as external CLI peers. Pi text completion (#44) comes afterward; a tool-enabled Pi agent harness is a distinct, later integration, not implicitly included in #44. No plugin framework, workflow service, credential store, background runs, or new agent loop.

Feature code retains source/session capture, prompt construction, UI, BTW transcript, advisor steering/snapshot and retry decisions. Execution resolves selection, validates support, invokes one backend attempt, normalizes progress/outcomes, and cleans up. Backends never capture the parent session themselves.

## Contract (illustrative)

```ts
type CliBackend = 'agy' | 'claude' | 'codex' | 'grok' | 'muse';
type Selection =
  | { backend: 'agy'; model: string; effort: 'default' | 'low' | 'medium' | 'high' }
  | { backend: Exclude<CliBackend, 'agy'>; model: string; effort?: string }
  | { backend: 'pi-completion'; provider: string; model: string }; // later; pi-agent is separate
// Native effort values are validated by each adapter, not arbitrary pass-through.
// These are target shapes; implementation adds each union member when supported.
type Progress =
  | { kind: 'text'; text: string } // accumulated preview, not terminal evidence
  | { kind: 'activity'; label: string; timestamp: number };
type Continuation = { backend: CliBackend; id: string }; // opaque, only from verified resume support

type Request = {
  feature: 'explain' | 'show' | 'btw' | 'advisor';
  prompt: string;
  access: 'restricted' | 'workspace-full';
  cwd?: string; // required for workspace-full; never passed to Pi completion
  continuation?: Continuation;
};
type Outcome =
  | { status: 'success'; text: string; continuation?: Continuation }
  | { status: 'failure' | 'cancelled' | 'timeout'; message: string; partialText?: string };

resolveExecution(feature, settings): Selection
execute(request, selection, environment, signal, onProgress): Promise<Outcome>
```

`environment` supplies execution dependencies, not parent session/context APIs. Registry/auth access is added only for the later Pi adapter. Settings resolve once per user operation (including all advisor retries). Implement a resolver plus a single-attempt executor; callers use the same resolver for configuration and diagnostics. Expected invocation failures are outcomes; programming errors are not silently converted to success. Existing modal/tool wrappers may translate non-success outcomes into existing error presentation.

Feature/access combinations are validated centrally: explain/show restricted and fresh; BTW restricted or workspace-full with continuation support; advisor workspace-full and always fresh. Restricted means the backend must provide the accepted restricted execution mechanism, not that an empty directory proves isolation. Agy preserves --sandbox plus scratch cwd; document actual enforcement limitations. Pi text completion has no workspace or tools supplied. A simple support check is sufficient; no speculative capability matrix. Adapter declarations distinguish tools disabled, sandboxed tools, and workspace tools, and document which mechanism satisfies the requested restriction. These are not interchangeable guarantees. Pi completion initially accepts explain/show only, rejects BTW/advisor before invoking a provider. A future `pi-agent` identifier cannot inherit completion capability merely by sharing Pi.

Text and activity progress are distinct union variants. Existing text throttling (75ms) and advisor activity/heartbeat logic (250ms/1s) remain at the presentation boundary; no reasoning text becomes progress. Backend completion must report a valid terminal success and nonempty text; CLI success also requires clean exit. EOF, partial text, or a resolved provider promise alone do not establish success. Failure diagnostics remain backend-specific.

## CLI adapter requirements (priority integrations)

All CLIs use the same attempt boundary, but adapters own prompt transport, event parsing, final-answer extraction, permission arguments and continuation IDs. Read-only filesystem access is NOT the same as no project access. Do not map Bro restricted mode wholesale to pi-flow-external's readonly tiers: Claude plan mode, Codex/Grok read-only sandboxes and Muse disable-write/disable-shell may still allow reads or inherited tools/config. Scratch cwd alone is insufficient. Inspect and constrain global/project rules, MCP, hooks, plugins and tools according to each CLI's actual controls; disclose unavoidable inheritance. If Bro's restricted request cannot be met, reject it rather than downgrade the guarantee.

Minimal support predicates must consider feature, access mode and continuation, not just a backend/feature boolean. Avoid a transport-capability matrix: argv/stdin/temp-file are implementation details. Fresh advisor support is independent of BTW support. Workspace-full explicitly permits tools and writes; advisor's instruction to advise rather than edit remains advisory.

| Adapter | Transport/protocol reference to adapt | Evidence required before enabling |
|---|---|---|
| Claude | stdin; stream-json result envelope; session ID | terminal success/error classification, clean exit, tool/access configuration, fresh versus resume behavior |
| Codex | stdin exec; item/turn events; thread ID | final agent text versus intermediate items, turn failure versus completion, sandbox limits, resume argv semantics |
| Grok | prompt file; result envelope; resume session ID | end-turn versus truncated result, temp-file cleanup, restricted sandbox compatibility (currently blocked locally by Docker socket symlink) |
| Muse | prompt file; mandatory workspace; envelope root command/run IDs; session-stream ID | root terminal versus nested task terminals, no partial-as-final text, provider-valid effort, workspace inheritance and resume semantics |

References are pi-flow-external/src/core/{claude,codex,grok,muse,permissions}.ts and #47, not guarantees of current installed CLI behavior. Port the small tested parsers/fixtures where licensing permits; keep policy decisions Bro-owned. CLI prompt transport need only preserve exact constructed text and handle expected sizes: advisor does NOT require every backend to speak Agy's stdin NDJSON. Each adapter documents an explicit final-success predicate and rejects inconsistent terminal evidence rather than simply trusting exit 0.

Host deadlines follow Bro feature budgets; native CLI deadlines are used only where supported, without fabricated common flags. No automatic cross-backend substitution. Administrative usage reporting remains explicitly backend-specific. Disclose that CLI account/subscription routes differ from Pi API-provider billing.

## Configuration

Agree the full schema now, introduce its persisted form with the first alternative backend. Agy-only migration retains current disk format, parsed into internal selections. No second provider/agent settings mechanism.

Future persisted shape:
```json
{
  "version": 2,
  "default": { "backend": "agy", "model": "gemini-3.7-flash", "effort": "default" },
  "overrides": {
    "explain": { "backend": "claude", "model": "<configured-claude-model>" },
    "show": { "backend": "codex", "model": "<configured-codex-model>" }
  },
  "mode": "balanced",
  "showTurns": 1
}
```

Overrides replace the WHOLE selection, never field-merge it. Missing override inherits the default; a pinned selection stays pinned even if equal to the current default. Legacy root model/effort and every override map exactly to Agy selections; preserve existing catalog/suffix normalization and PI_BRO_MODEL first-file behavior. Do not rewrite on read. Validate before saving; no silent fallback, unknown schema versions produce actionable errors rather than overwrite.

The settings screen edits complete selections: backend first, then a model valid for that backend; save only a valid complete choice. Backend switch drops incompatible fields, never carries Agy effort into another CLI or Pi. Omitted CLI effort means that CLI's default; explicit effort must be accepted for that backend/model/version. No universal off-to-none conversion: Muse meta currently rejects none. Backend switching is transactional; individual ordinary settings edits retain immediate-save behavior. Cancel leaves prior selection untouched. Backend-specific remembered selections are deferred; selecting an Agy model again is enough initially. /bro model and /bro effort continue as shared-default shortcuts, dispatching to supported backend controls; Pi effort is initially unsupported and clearly says so. Per-feature selections stay in /bro config.

An alternative shared default is allowed, but inherited features the selected adapter has not verified are explicitly unsupported until given supported overrides. Unsupported feature selections do not prevent other supported Bro commands from initializing. Config shows the effective selection and unsupported status for all four rows; doctor and execution agree. Do not silently pin existing defaults or fall back to Agy. Common recommended setup: retain Agy default, choose verified CLI overrides for desired features (Pi overrides later). Configuration and doctor do not make live model requests; distinguish registered/installed, resolvable model, configured auth, and actually tested execution.

## Continuation

BTW owns transcript, mode, and the opaque backend-tagged handle; execution owns its transport. Commit a newly returned handle only on successful completion, preserving current behavior on failed turns. No backend silently emulates continuation by replaying transcript or opening a fresh session. Store the owning backend on the BTW thread from its first invocation, even when no conversation ID is returned. A different backend selection requires an explicit `/clear` (or `/bro btw --fresh`) before another turn; config changes themselves never discard the transcript. Validate a supplied handle's backend before spawning. Same-backend model/effort changes retain current Agy behavior. A new CLI must verify such changes during resume; otherwise require an explicit reset instead of silently ignoring the selection. Continuation ownership also includes access mode and workspace identity where backend sessions depend on them. Existing access-mode changes still reset the thread as they do today. Explain/show/advisor never resume. Session switch/reload still clears the in-memory thread; steering persistence is unchanged. Advisor output remains a main-conversation tool result, unlike modal explanation/BTW output.

## Agy compatibility and lifecycle

Preserve transport during extraction rather than unifying stdin/argv speculatively:

| Flow | Transport/access | Agy timeout / host timeout | Retry |
|---|---|---|---|
| Explain/show | argv prompt; --sandbox; scratch cwd | 2m / 125s | none |
| BTW restricted | argv prompt; --conversation when supplied; --sandbox; scratch cwd | 2m / 130s | manual only |
| BTW full | argv prompt; continuation; workspace cwd; auto-approved tools | 10m / 610s | manual only |
| Advisor | stdin NDJSON; fresh; workspace cwd; auto-approved tools | 10m / 610s | feature-owned 3 attempts; 5s then 10s |

Source references: bro.ts runAgyText ~1123, runAdvisorConsultation ~1412, runAdvisorWithRetries ~1637, parseBtwAgyLine ~2574/runBtwTurn ~2620; settings ~487-579. Keep current parser-specific behavior where externally observable, actionable old-Agy hints, prompt guards and snapshots, activity aggregation, and main-session boundaries.

Known gap: explain/BTW only terminate the immediate child; advisor abort escalates across POSIX process groups, but protocol failure/host timeout do not use that same escalation. Classifying any signal exit as timeout is also inaccurate. These cannot be called bounded cleanup merely by extracting code.

Recommended explicit exception to behavior-preserving migration: share a stop path for cancellation, host deadline, and protocol failure, using POSIX group SIGTERM then SIGKILL (5s grace) and bounded pipe/listener cleanup. Record the initiating cause so external termination is failure, not an invented timeout. Pre-aborted requests never spawn. Resolve only once; the first stop cause (user cancellation, host deadline, or protocol failure) is latched and cannot be relabeled by later signals. A user abort before success settlement defeats success when no earlier stop cause exists; timeout is distinct from user cancellation. Keep existing deadlines and retry policy. The previous attempt must finish bounded cleanup before advisor launches the next; cancellation never schedules another attempt. Windows preserves direct-child termination and clearly documents descendant cleanup limitation; do not claim process-tree guarantees there. This is an intentional lifecycle correction, separately identified and tested in the migration PR, not permission to change timeouts, prompts, retries or access. Argv-to-stdin conversion and additional parser hardening remain separate follow-ups.

## Pi contract check (last, after CLI integrations)

Resolve provider/model from ctx.modelRegistry, credentials/headers from its auth infrastructure, and stream through the registered provider's streamSimple with an AbortSignal. Check the `getApiKeyAndHeaders()` discriminated `ok` result and preserve resolved headers, baseUrl overrides and environment semantics, not just the API key. A missing key is not intrinsically failure for a valid authless local provider. Never persist or expose resolved secrets in settings or diagnostics. Send only the constructed prompt; no host agent session, tools, additional parent context, or cwd. Consume text progress and verify the terminal message: only `stopReason: "stop"` with nonempty text and no tool-call content counts as success; `pending`, `deferred`, errors/aborts, and length-limited/tool-call endings cannot count as a complete explanation. Preserve error detail after partial output. No custom HTTP/SSE or key file. Explicit host deadline and provider abort cleanup map to the same outcomes. In-process provider cancellation is cooperative: Bro can stop waiting and suppress late progress, but cannot promise to forcibly stop a custom provider that ignores its signal. Do not report such a timeout as confirmed transport termination. Verify against pinned Pi 0.84.2 API, not assumptions from a newer global installation.

## Minimal implementation layout / migration sequence

1. Agree this contract/schema and the explicitly listed lifecycle correction.
2. Agy-only PR: add backend.ts for internal contract/resolution/dispatch and Agy execution; move the three transports behind it, without feature/UI rewrites. Keep feature wrappers if they preserve useful existing signatures/tests. No feature may spawn its own execution child afterward. Agy administrative usage/models/version probes may remain separate. Keep disk settings unchanged. Add targeted offline lifecycle regression tests; update docs/release metadata according to repository policy.
3. Claude adapter PR, including version-2 settings/UI/legacy migration. Add Codex, Grok and Muse in focused sibling PRs against the same foundation; development can proceed in parallel once the contract/configuration is settled. Adapt #47 parsers/fixtures and pi-flow-external's pure protocol logic with required attribution; do not import its whole orchestrator or permission defaults.
4. Each CLI's first PR enables at least one genuinely verified Bro capability, preferably explain/show if its no-project-access policy can be enforced. A blocked restricted mode must not force weakening the policy: a verified fresh workspace advisor can be its first capability instead. Advisor does not require BTW resume. Bring all four CLIs to useful availability before exhausting every feature on one CLI. Add restricted/full BTW only after its policy and continuation combination is proven. Do not claim blanket parity or impose artificial L0-to-L3 dependencies.
5. #44 last: Pi text-completion adapter, offline registry/provider doubles and capability documentation; settings v2 already exists. No BTW/advisor implementation implied. Consider a Pi agent harness afterward as separate scoped work; it is not another name for the completion adapter.

## Acceptance checks

Reuse smoke-test.sh fake-Agy and existing prompt/settings tests. Exercise all four feature routes through the boundary, not just argument builders. Check argv/stdin, cwd/flags, effective model/effort, timeout values, continuation success/failure, no new retries and advisor backoffs. Exercise valid success, terminal failure after partial text, missing terminal, malformed output, nonzero exit after success, pre-abort, abort during streaming/backoff, deadline, SIGTERM-resistant child and grandchild, temp-dir/timer cleanup, and no late progress. POSIX-only process-group tests are explicitly platform-scoped.

Settings tests cover legacy effective values, pinned overrides, first-file env behavior, atomic selection replacement, unsupported effective features, and failed/cancelled edits leaving settings unchanged. Pi milestone tests use an offline registry/provider double including terminal error/abort/length outcomes; no paid credentials needed.

Run npm test and release validation appropriate to the implementation PR. This proposal itself makes no claim of live backend compatibility or tests run on new code.
