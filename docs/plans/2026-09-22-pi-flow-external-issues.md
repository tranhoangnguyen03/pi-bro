# pi-flow-external delegation findings to raise

Reported as `tranhoangnguyen03` and verified open:
- Muse adapter bug: https://github.com/tranhoangnguyen03/pi-flow-external/issues/60
- Grok sandbox compatibility: https://github.com/tranhoangnguyen03/pi-flow-external/issues/61
- Optional-field schema investigation: https://github.com/tranhoangnguyen03/pi-flow-external/issues/62

Observed while preparing pi-bro #52. Existing issues were checked before filing; no matching report was found. Public reports omit prompts, credentials and full session journals. The transient failures in section 4 were not filed as established defects.

## 1. Confirmed adapter bug: Muse off maps to unsupported meta effort none

Suggested title: `Muse: inherited thinking=off emits reasoning-effort none rejected by meta provider`

- Installed CLI: Muse Code 1.3.0 (1.3.0-R3401.1).
- Failed run: run_606013c9026e44e2b6f9d0ee1def33ca (muse-reviewer).
- Exact diagnostic: `--reasoning-effort none is not supported with --provider meta; choose minimal|low|medium|high|xhigh|max|ultra` (exit 2).
- Reference checkout: `src/core/muse.ts`, `normalizeMuseReasoningEffort` maps `off` to `none`; `buildMuseArgs` unconditionally selects `--provider meta`.
- Help lists `none` syntactically but provider-specific validation rejects it. Testing help text alone missed this mismatch.
- Expected: validate effective effort against provider support before launch. Either explicitly reject off with a useful remediation or adopt a documented adapter policy; do not silently describe minimal/default reasoning as off.
- Regression: assert meta argument construction does not produce an unsupported none; cover inherited off and explicitly pinned levels. CLI compatibility probe must exercise provider validation, not only --help.
- Temporary review workaround: direct Muse invocation with explicit `--reasoning-effort high`, preserving disable-approval/write/shell flags. No global profile changes.

## 2. Grok startup compatibility: runtime-socket symlink prevents readonly sandbox

Suggested title: `Grok preflight: surface runtime-socket symlink sandbox failure with actionable diagnostics`

- Installed CLI: grok 1.0.40 (eb1a2256660d), macOS.
- Failed run: run_4c1879d02f8348e1bd1eb5f7840625cd (grok-reviewer).
- Diagnostic: `sandbox could not be applied: socket deny resolution failed: could not resolve runtime-socket deny path /var/run/docker.sock: endpoint is a symlink`; refuses to start with protections missing (exit 1).
- `/var/run/docker.sock` is a symlink to the user's Docker socket. Do not remove or alter it as a runner workaround.
- Adapter requests `--sandbox read-only`; refusing to downgrade is correct. Root cause appears upstream Grok/environment compatibility, not established as a pi-flow-external sandbox implementation bug.
- Ask: document the known incompatibility / preflight installed CLI support and preserve the exact error and requested permission metadata; link upstream Grok fix when available. Never automatically retry with sandbox off.
- Temporary review workaround: explicitly disclosed direct prompt-only invocation, `--sandbox off --tools '' --no-subagents --disable-web-search --permission-mode dontAsk`. This is not an OS-isolated run and is not evidence that readonly Grok delegation works.

## 3. Investigate tool-schema projection losing optionality

Suggested title: `Tool-schema compatibility: optional mutually exclusive fields appear required to calling model`

- In this parent session, exposed external_runs schema required both runId and runIds. Sending both fails `inspect accepts either runId or runIds, not both`; an empty runId did not help.
- Likewise external_help exposed harness as required, but workflow help rejects any harness argument.
- Source inspection shows `Type.Optional` on external_runs runId/runIds. Therefore do NOT claim source schema forgot optionality. Determine whether the provider/harness tool-schema projection changes it.
- Expected: callers can omit optional fields, including mutually exclusive selectors. Test the schema as actually delivered to the model on this provider, not just the TypeBox definition.
- Workaround used: read local persisted run summary journals, accepting a result only with terminal done state. This is inferior to supported supervision and should not be the normal workflow.

## 4. Reliability observations, not yet separate defect reports

- Claude run run_c8410680f212488e82440bf4c4f4c0c7 ended `aborted`, `error: session shutdown` without a final proposal; nested agents and waiting had occurred. Do not attribute the shutdown to a proven runner bug. New tasks prohibit nested agents and require bounded final deliverables.
- Agy draft review run_259b478aa94646968ef43c7fe5b696a3 ended with upstream network ERROR / exit 3. Record as transient provider failure, not evidence of a runner bug. No claim of completed review.

## New CLI-first review outcomes

All four reviewers returned completed contributions. Claude: run_9e4f90ee4f544921b627a6bce3a2fe4c done. Agy: run_c920488641eb4bb18212796e11e8ad73 done. Muse direct workaround returned root run.terminal.completed for command 77bebc6c-223f-4eb4-a507-0e33b279a0e3. Grok direct prompt-only workaround returned stopReason=end_turn in session 01a0c986-2cef-79f0-86e5-5565653e8288. These successes validate participation, not fixes to the failed adapters or restricted policies.

Reference pi-flow-external source checkout: 8c444f6. Primary run evidence remains in local pi-flow-external run journals; direct workaround output remains under /tmp/pi-bro-design-team. Grok JSON includes a separate thought field: only its final text was used for synthesis; do not publish raw output as an issue attachment. Public reports need only the short errors and command/version evidence above.
