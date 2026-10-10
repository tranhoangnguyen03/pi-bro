# PR #109 feedback corrections

Historical record; [current guide](../guided-review.md) owns user instructions.

Human requested all four external-review items fixed before merge. No merge or feature-model qualification calls authorized during this correction.

## Changes

- Removed prototype guide-version and composer migration from runtime, requiring current UI/schema. Pre-release records fail unchanged. Existing two development records were backed up under `/tmp/bro-review-pre-release-backup-1vaQPZ` and normalized with the old validator before removal; original turns and drafts were compared (PR #102: two turns, one draft; #106: no private work). No captured source deleted. Interrupted/dirty capture recovery remains, but markerless captures are no longer adopted as complete.
- Split record validation into snapshot, turns, UI, topics/evidence and assessment checks; shared evidence predicate. Formatted new review runtime/tests with tabs and 100-column target; split prompt instructions without a new framework/dependency. UI navigation and existing scope remain unchanged.
- Resolve merge base from GitHub compare API before shallow fetch (local authored fixtures resolve from full fixture history). Fetch only merge-base/head trees at depth 1 with 600-second timeout, other commands 120 seconds. Fail visibly on compare/invalid revision rather than falling back to unbounded history or wrong shallow ancestry. Evidence stays complete/offline; log/blame ancestry absent. Completed Git objects remain on retries. Huge trees/output/disk remain bounded risks, not magically eliminated.
- Review executes `restricted` with captured cwd. Claude: safe-mode/restricted Read,Grep,Glob/dontAsk/no MCP/no persistence. Muse: disable-write/disable-shell/disable-web-tools/no-foreign-personal-context/no-session-log; no yolo/trust. Agy/Grok/Codex fail before spawn; no backend switch. New acquisition checks support before fetching; existing saved reviews still open on any configuration. Doctor/help/docs explain required review override; user's global settings not changed. Other features' permissions are untouched.

## Safety limits

Installed CLI help inspected; one bounded advisor consultation advised on controls. Codex read-only shell still executes code, so it is not accepted for file-only review. Unsupported/older flags must fail without bypass fallback. No new permission system, OS sandbox or generated proxy tools introduced. Tool-level controls depend on CLI implementation/managed host policy; malicious repository text can still distort model reasoning and captured content goes to provider. No claim of universal prompt-injection or confidentiality protection.

Offline red/green tests enforce argv/no bypass/cwd, fail unsupported adapters, preserve current private records/reject obsolete ones unchanged, and prove intermediate commits are absent while both evidence sides remain correct. Existing controller fixtures now use fake Claude rather than full-access Agy. Live qualification records before this pass describe older full-access execution and are not certification of new CLI enforcement. No paid calls or private/fork/large-real-repository tests added. Final npm verification and PR update reported with fresh logs.
