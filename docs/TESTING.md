# Manual qualification: what offline tests cannot prove

`npm test` exercises pure helpers, modals with injected events, fake provider CLIs, Pi's in-process SDK, and an RPC host. It does **not** prove that physical keyboard/mouse input, system clipboard, installed provider permissions, model quality, or abrupt host shutdown work as expected. Use this guide **only for boundaries affected by a change**; do not replay every feature/backend combination for each PR. Record the actual backend, Pi version, host mode, outcome, and any unverified behavior.

## Isolated setup

Use a disposable workspace and agent profile. Back up `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bro-settings.json` before testing with a real profile. To load the checkout rather than the installed package:

```sh
BRO="/path/to/pi-bro"
TEST="$(mktemp -d /tmp/bro-e2e.XXXXXX)"
printf 'WORKSPACE_CANARY_6248\n' > "$TEST/sample.txt"
cd "$TEST"
pi --no-extensions -e "$BRO/src/bro.ts" --no-skills --no-prompt-templates --no-context-files --session "$TEST/session.jsonl"
```

Choose a configured backend in `/bro config`. Only run live calls when the changed behavior requires them; state the model and attempt budget first. No automatic paid retry. Do not use real credentials, private files, or an active review record as a destructive test fixture.

## What to check, by change

| Changed area | Smallest useful **manual** check beyond `npm test` |
| --- | --- |
| **Config / Doctor** | Save a default and one feature override; restart Pi and confirm both persist. Doctor must probe only selected backends. An installed/authenticated CLI is not proof of live model access. |
| **Simplify / Show** | Explain a reply, a local file, and a public webpage; confirm source attribution and mode changes. `/bro simplify` reopens state without a new model call. `/bro show 2` draws only recent conversation text, not tool data or hidden reasoning. Check physical copy and `Esc` while streaming. |
| **BTW** | Ask a restricted question, then `/mode` to full permission; verify the visible access label and earlier conversation context. Changing backend starts a new thread; Agy/Pi permission-mode changes reseed native continuation. `/copy` and `/copy-all` must never change the main editor; the retired `/insert` commands must direct users to copy instead. |
| **Advisor** | With a real host, confirm `bro_advisor` is visible only when the host activates it; a consultation returns in the parent tool result, not a stray conversation turn. Test `Esc`/host cancellation during a request and verify no late result. |
| **Grill Me / Remember Me** | Continue a question, consolidate, copy the latest reply without editing Pi's composer, and reopen without duplicating paid calls. For memories, verify that draft review precedes save, stale revision is rejected, and an agent can read approved summaries without exposing unrelated backgrounds by default. |
| **Elevate** | Confirm findings start unticked, only approved findings reach rewrite, and the rewrite is a request rather than the finished work. With any unsent main-editor draft, copy the improved request and close; the draft must remain unchanged. Desktop/RPC copy must not depend on an editor-insertion API. |
| **Architecture Docs** | Run `/bro architecture` in a disposable project. Confirm a source-backed guide, graph JSON, and offline HTML viewer; preservation of human-authored docs; refusal of concurrent source/document edits; cancellation rollback and accurate backend sandbox disclosure. |
| **Overthink** | In a disposable session, check four defaults, Ctrl+↑/↓ reorder, structured summary plus one answer per question, quiet NONE, and U usage toggle. Verify automatic checks run only after `agent_settled`, no call on trivial turns, stale-note handling, no tool execution, and provider cost/cache reports. |
| **Guided Review** | Reopen one **existing** captured review without a backend call. Check evidence versus model inference, scoped findings, unsent draft on close/reopen, retry after a save failure (in a disposable profile), navigation and physical scroll at narrow sizes. Regeneration must require explicit confirmation and preserve prior questions/drafts. |
| **Copy Markdown** | In a disposable Pi session, open `/bro copy` after a Markdown reply with a table, links and a code fence. Trim a line, type `?` in Edit, use Ctrl+D Preview, then Ctrl+C in both views and verify the system clipboard is raw edited Markdown. Test F1, Esc discard confirmation, narrow/long replies, and no model call or saved draft. For tabs and CRLF, confirm unedited copying is exact and an edited copy shows a normalization notice. Check Pi's native `/copy` still works. |
| **Modal / terminal** | Check the affected modal in both regular and fullscreen modes, especially at about 80×24 and 36×18. Keyboard focus, visible actions, wheel target, clipboard and scrollback must recover after close. Injected mouse events in tests are not physical mouse proof. |
| **Backend / lifecycle** | Run a small number of real CLI requests for adapters whose flags or protocol changed. Inspect spawned args, access mode, cwd, cancellation and no-retry behavior. For graceful Pi reload, verify the outstanding CLI stops and a Guided Review draft survives; abrupt host exit and live-provider permissions require separate checks. Distinguish backend failure from our timeout. |

Offline tests already exercise most malformed JSON, state transitions, stream framing, temporary file cleanup, and recovery states. Do not repeat those manually unless the platform boundary is what changed.

## Private session recovery

Use a disposable Pi session and a fake backend that can pause a response. Test on both
the repository's pinned Pi version and the installed supported Pi version.

1. Complete BTW turns, leave an unsent draft, restart Pi, and check both restore.
   Change access mode and run `/clear`; neither restored mode nor cleared history
   may revert after another restart.
2. Open and close BTW five times without changing anything. The session JSONL must
   not gain duplicate Bro custom snapshots merely because the modal was visited.
3. Start a slow BTW response, close before it finishes, reopen and send another
   question. The second prompt and saved session entries must **not** contain an
   unfinished `…` answer or the cancelled question. Repeat with `/retry`;
   the previous completed answer must survive cancellation.
4. From a session with saved BTW/Grill/Simplify/Show work, use `/tree` to select
   an earlier point before that work. Bro must show the selected branch's state
   immediately, with no data copied from the abandoned branch. Make a new update,
   restart, and verify the abandoned branch's data stays absent. Return to the
   original branch and verify its own history is intact.
5. Check /resume, /reload, forks, supported Desktop/RPC and PiG hosts separately.
   Native Pi-backed BTW continuation IDs may expire on restart and need reseeding.
   Do not claim coverage for paths not actually exercised.
6. Remember: Bro custom entries are **on disk in the Pi session JSONL**. Check how
   the current host exports/shares that file before claiming any export redaction.
   Model-context isolation is not confidentiality of the session file.

### Native Pi RPC lifecycle (offline, no provider credentials)

`node --test test/host-lifecycle.test.mjs` launches the installed Pi 1.3.0 host in RPC mode, loads Bro from this checkout and uses an isolated fake Agy executable. It exercises `ctx.reload()` and stdin-EOF shutdown through the real host, confirms a running CLI receives TERM before reload completes, and proves Bro can run and save a new result in the same session afterward. The same test fails against pre-shutdown-tracking Bro. It is included in `npm test` on Linux and macOS.

This proves host-level lifecycle wiring for **native Pi 1.3.0 with a fake CLI**, not live provider permission enforcement or unexpected SIGKILL. It also checks the Agy restricted `--sandbox` flag without invoking a real provider.

The same two host tests passed three consecutive runs with the native **PiG 0.5.3+1.4.0.74f46864** binary taken from PiG-Agent PR #2's pinned Linux x64 shell build `0.1.0-preview.1-linux-x64-11f3ee0e4dd0accc`. They ran against this PR's Bro source, not the shell's bundled Bro 0.29.0. That qualifies direct PiG host reload/EOF wiring, **not** installation, role integration, provider-enforced permissions, or the entire PiG-Agent shell. The separate default CI check still targets PiG 0.3.0. For a repeatable PiG 0.5.3 check, run `BRO_HOST_TEST_BIN=/absolute/path/to/pig node --test test/host-lifecycle.test.mjs` against an exact locally installed binary.

## Permission and trust truth (do not generalize across backends)

- **Agy:** restricted BTW runs sandboxed in a scratch directory; changing BTW access drops native continuation and reseeds the transcript. The shell sandbox is not a universal no-write guarantee.
- **Claude Code:** restricted BTW disables tools; native continuation persists across mode switches. Review uses Read/Grep/Glob only and no shell. Doctor verifies version and auth status, not connectivity.
- **Grok:** restricted BTW is **prompt guidance only**; tools can remain available. Review requests `--sandbox read-only --permission-mode dontAsk`, whose installed-CLI enforcement is not certified by offline tests. Never fall back silently to permissive flags. Auth is unverified by Doctor.
- **Codex:** restricted BTW uses a read-only sandbox; full permission bypasses approval and sandbox checks. Review runs in its read-only sandbox. Doctor probes `codex login status`.
- **Muse:** restricted BTW disables approvals, writes and shell; full permission uses `--yolo`. Review has no shell/write/web. Doctor checks version but not auth.
- **Pi (`>=1.3.0`):** in-process sessions can select only physical `<provider>/<id>` models; virtual models are refused. Restricted BTW has no tools, full BTW has workspace tools, and review has read/grep/find/ls. Project trust must prevent untrusted `.pi` files from changing the model/runtime context. Model abort is cooperative; returning promptly does not prove a hung provider stopped running.

When checking a review with a shell-capable backend, verify its sandbox warning appears on acquisition and on reopening. Findings must cite actual captured evidence; do not treat a model's claim of inspection as independently verified access. Do not run unknown project code or publish findings to GitHub merely to test the UI.

## Guided Review deletion (no model calls)

1. Save two reviews in a disposable Pi profile, with separate captured source.
2. Run `/bro guided-review delete`, choose one, and decline. Both must remain.
3. Reopen the first review in another modal; deletion must be refused while it is active.
4. Close it, delete through the picker and confirm. Only its record, drafts and
   capture disappear. The second review and the main working tree stay unchanged.
   Check that the picker label preserves every letter of the saved title.
5. Repeat direct `/bro guided-review delete <PR number or URL>` while offline or
   logged out of gh. It must match the saved local record, without a network
   request. When two repos share a PR number, bare-number deletion must be
   refused and the full URL must work.
6. Open a saved review and use Overview → Delete review. Decline once (the
   record remains), then accept. Close/dispose must not save the deleted record
   back to disk. The active review remains locked until teardown.
7. An invalid or missing target must not delete anything. No model call or
   GitHub mutation occurs.

### Bounded live checks (not part of npm test)

Current security/capture tests are offline: enforce review sandbox flags/no dangerous bypass, run every review backend in the captured cwd, pin the 610-second review deadline, reconstruct questions, reject prototype formats unchanged, and prove shallow captures omit intermediate commits while old/new evidence remains available. These test adapter contracts, not independently certified CLI enforcement. No additional live calls were authorized for this revision. A manual run with a Codex/Grok/Agy review override must confirm the sandbox flags, no bypass flag in the spawned argv, the advisory visible in acquisition and after reopening a saved review, and findings that cite real captured files. Grok's `--permission-mode dontAsk` in particular is unverified against an installed CLI; treat a Grok review failure as a flag-support question, not a fallback prompt.

With any review backend, new capture/preparation, Send question, Prepare guide, Edit and resend followed by Send, and confirmed Regenerate guide make model calls. Specify backend/model, fixtures and maximum attempts first; never automatically retry. Use isolated source/profile and retain results. Do not post to GitHub or run unknown project code as a test shortcut.

- Known defect: correct scenario, unchanged caller/test investigation when relevant, supported references and useful fix/check—not just valid JSON.
- Clean change: distinguish present defects from intentional contract questions/speculative advice; zero findings is allowed, not required.
- Regeneration: decline first to verify navigation without a call; then approve once. Completion must follow observed running state, not the already-ready header. Verify new identities/current replacement, unchanged captured revision, preserved question/draft/original context, clean source, close/resume without another call.
- Streaming/cancellation and save failures: offline fake-CLI tests cover contracts. Live claims require actual observation; simulate disk errors only in disposable profiles, never by damaging user state.

Historical full-access record (not qualification of the later file-only controls): manual UI accepted; 316 full serial tests passed before final prompt calibration, focused tests/typecheck passed afterward; bounded Agy known-defect and final regeneration checks succeeded. Earlier real PR #102 work also exercised Claude questions/cancellation. This is not an unfamiliar-reader study, private/fork acquisition matrix or live five-backend certification. Live calls are separate from offline documentation/contract checks. See [qualification record](plans/2026-10-10-guided-review-live-qualification.md).

## Live Guided Review: explicit budget and safe records

A fresh capture, preparation, question, resend, and confirmed regeneration can each make a model call. Decide which **one** behavior changed and set a call limit. For source integrity, keep the same captured revision while replacing the guide. Verify old discussion context survives and a clean change may have zero findings. Never test save failure by damaging an existing user review.

Review captures and records retain absolute Git/worktree paths. Copying a saved record alone does **not** isolate the original Git object store. Use a new disposable profile and fresh capture when destructive tests are essential. Historical acceptance records in [the qualification notes](plans/2026-10-10-guided-review-live-qualification.md) are evidence of earlier versions, not proof of today's backend support.

## Documentation and release check

Run `npm run docs:check` after changing commands, guides or access claims. Follow the [getting-started guide](getting-started.md) once in a clean Pi session when changing first-use behavior. `npm pack --dry-run` verifies which files ship. Check changed public links and images in their actual rendered host; the offline checker cannot validate external URLs.

## Prompt quality is a separate question

Unit tests protect prompt construction, quoted/untrusted context, privacy limits, and command behavior. They do not prove the model will follow instructions or write good prose. The reader benchmark lives in [READER-BENCHMARK.md](../benchmark/READER-BENCHMARK.md); `node benchmark/recompute-reader.ts` verifies committed evidence offline. Live generation and judging remain manual, fingerprint-approved, and quota-consuming. Do not equate a fake-provider test with a real-provider result.

## Architecture docs

For a change to architecture output, use a small CLI or mixed app/agent repo and a specification-only repo. Open the generated HTML with network access disabled; check search, keyboard controls, narrow layouts, and actual explanations rather than name lists. Preserve existing decisions; on model failures, invalid JSON, changed source, changed target docs, and cancellation, leave live material untouched or roll back without partial files. Inspect the selected backend's actual sandbox flags. Do not test destructive cases on user documents.

## Overthink structured notes / TUI

1. In a new disposable Pi profile, check the four factory questions. Confirm custom questions can be added, edited, deleted and reordered with **Ctrl+↑/↓** (including extended CSI key sequences). Alt/Option is not required.
2. Complete a substantive task and open the next private note. When there is a material concern, verify a 2–3-sentence Summary and **one concise answer for every saved question**. A question may explicitly say it found no material concern. For `NONE`, no automatic widget should appear.
3. Press **U** to reveal token/cache/estimated cost details and press U again to hide them. Verify the initial view does not begin with a long token line. Check short window height, narrow wrapping, scrolling, and terminal resize; confirm old plain-text notes remain readable and marked stale appropriately.
4. Check that a question-list edit does not change the stored old assessment's displayed questions. Verify only one model call for a multi-question check, and malformed/incomplete structured output does not produce mislabeled findings. Confirm model refusal/tool-use failures are handled safely.
5. If a profile or session already has the former seven-question list, verify it remains unchanged until reset. Global Ctrl+D twice + Ctrl+S adopts four factory questions; the session reset then picks up the current global list. Do not overwrite custom lists.

## Overthink: real-provider limits

Manual qualification is needed only when Overthink logic, Pi lifecycle, or model request context changes. Check that `agent_end` does not trigger the call: only `agent_settled` may start the second request after meaningful tool use. Test a trivial turn, compaction, auto-retry, stale session/branch navigation, changed questions, cancellation and provider failure. Verify that notes remain private and that a toolUse response does not execute tools or save a note. Compare cold/warm cache-read, write, input, output and reasoning tokens and the provider's reported cost; do not assume reused prompt text guarantees a cache hit. Confirm global automatic settings and session questions do not leak across profiles or branches. Check live Ctrl+R/E/C, question editing, and two independent second-call extensions if installed; test PiG separately.
