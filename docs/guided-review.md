# Guided Review

**Understand and evaluate a PR, without turning your main Pi conversation into a review transcript.**

The normal journey is: **open a PR → read and investigate → leave when satisfied.** Bro automatically prepares both an explanation and a quality assessment. Asking questions is optional. You do not need to copy findings, mark progress or submit feedback to finish.

## Open a review

Requirements: local Pi interactive mode, Git, authenticated GitHub CLI (`gh`), and Claude or Muse configured for review. Run `gh auth status` to check GitHub authentication; `/bro doctor` checks Bro's selected backend setup but does not prove GitHub access or model connectivity.

```text
/bro guided-review https://github.com/OWNER/REPO/pull/123
```

A URL works even when your current workspace belongs to a different repository. A PR number alone uses the current GitHub repository:

```text
/bro guided-review 123
```

A **new** review captures the PR's base/head commits outside your working tree and automatically makes one model request. Subsequent questions each make another request. Calls use your selected backend CLI's account and billing—not Pi's model account. Bro does not automatically retry a failed generation or switch backends.

For fullscreen mouse scrolling, start Pi with:

```sh
pi --tui-mode fullscreen
```

Opening the **same PR again** restores its saved review without another model call. Bare `/bro guided-review` lists saved reviews; `/bro guided-review resume` remains an alias for that list.

**Reopening keeps the captured code.** It does not fetch a new comparison when the author pushes commits. Opening by URL/number checks current metadata and reports newer source, but continues the saved capture. The saved-review picker does not check freshness. Reviewing newer revisions is not implemented.

## Read and investigate

Contents is on the left; reading and contextual actions are on the right. Narrow terminals show one pane at a time. The supported minimum is 36×18; smaller terminals show resize guidance with a working exit.

| Destination | What you get |
| --- | --- |
| Overview | Purpose, main concerns and overall assessment |
| Topics | Short explanations with captured code and related findings |
| Findings | Ranked concerns, author questions, suggested fixes/checks and evidence |
| Across the change | Findings that do not belong to one topic, when present |
| Coverage and limitations | Reported inspection, uncited files, omissions and unverified execution |
| Changed files | The full changed-file list and one actual diff at a time |
| Your questions | Private discussions and unsent drafts, including earlier context |

A finding is a proposal, not a proven defect or an applied patch. **No findings is not approval.** Source blocks and diffs come from captured Git objects, not model quotations. Valid citations establish locations; they do not certify the reasoning or complete inspection. Coverage paths and access explanations are model-reported. Suggested tests have not been independently executed by Bro.

The preparation prompt investigates the whole change and relevant unchanged callers/tests before organizing topics. It supplies the first 100,000 diff characters, with an omission marker for larger changes; the backend can inspect the captured checkout beyond that seed. Follow-up questions include at most the latest 12 relevant turns and disclose older omitted discussion. A saved guide without an assessment is explicitly labelled unassessed. Prototype formats are not supported; unreadable files are left unchanged.

The generation header shows observable application stages and elapsed time—not a percentage or invented model checklist.

### Controls

| Control | Behavior |
| --- | --- |
| ↑ / ↓ | Select entries or scroll the focused reading area |
| Page Up / Page Down | Page the focused pane |
| Enter | Read a destination, open a list item, or focus contextual actions |
| Enter on a highlighted action | Activate it |
| Tab / Shift+Tab | Move focus in screen order |
| Esc | Return to where you came from; from Contents, close |
| Close | Save automatically and leave |
| Stop and close | Stop active work, await cancellation, save partial work, then leave |

In fullscreen mode, the wheel scrolls the pane under the pointer without moving its list selection or keyboard focus. Reading an active answer pauses following; deliberately returning to the bottom resumes it. In regular terminal mode, the wheel belongs to terminal scrollback.

## Ask privately, if needed

Choose Ask from a topic, finding, file or Overview. Type in the composer below the discussion. **Enter in the composer sends the question**; leaving without sending retains the draft. Stop response cancels an answer. Stop preparation/regeneration cancels the corresponding guide request.

Back restores the originating screen. Failed/stopped questions offer Edit and resend; it restores the question only if the current draft is empty. Resending is explicit and makes a new call. Nothing enters the main Pi conversation or is posted to GitHub.

Capture fetches only the head and GitHub-reported merge-base trees (depth 1). Source/diff/evidence remain available offline; ancestry, log and blame history are not captured. Fetch has a ten-minute bound; metadata and other commands have two-minute bounds. Very large trees can still exceed time/output/disk limits; retries reuse the managed store rather than intentionally deleting it.

## Optional conveniences

### Your work is remembered

There is no separate Save step. Bro saves the guide, questions, drafts and reading position automatically. Close waits for a successful save. If saving fails, the window stays open with a readable error and Retry saving; fix the reported filesystem problem and retry. Do not force-quit if unsaved work matters.

### Copy finding

Copy finding copies a finding's text, evidence references and suggested fix/check to the **system clipboard**. Nothing is submitted, inserted into Pi or applied to source. Your OS or clipboard manager may retain the copied text. Remote clipboard forwarding depends on your host and terminal; a failure is shown in the review.

### Regenerate guide

Use Overview → Regenerate guide only when you want a fresh explanation/assessment. Confirmation identifies the captured revision and the model call. **It reuses the same captured source; it is not an update fetch.** Successful output replaces one current guide. Failure/cancellation keeps the current guide. Questions and nonempty drafts retain their original context under Your questions; there is no guide-version picker. A replacement that fails to save remains in memory with retry controls.

## Access, privacy and storage

Review uses **file-only inspection**, not full-access execution. Claude runs with `--restricted`, Read/Grep/Glob only, `dontAsk`, safe mode and no MCP; Muse disables write, shell and web tools, foreign personal context and native session logs, without trusting repository rules. No model-run project tests, commands, Git or network tools are available. Unsupported/older CLI flags fail visibly; there is no full-access fallback.

Agy, Grok and Codex are not available for review generation/questions: supported controls do not establish equivalent shell-free inspection (Codex read-only sandbox still executes commands). Set the **review** override to Claude or Muse in `/bro config`; shared defaults and other features are unchanged. Saved reviews remain readable without a supported model backend. Doctor shows the review override requirement as information; it does not make an otherwise healthy installation fail.

These controls reduce malicious-code execution/write risk, but repository content can still manipulate the model's conclusions. Captured content, questions and answers go to the provider; do not use review as a secrets boundary or approval certificate. CLI enforcement and managed host policies remain the backend's responsibility.

PR identity/description, diff, relevant saved discussion and your Bro preferences are sent to the selected backend. It can read the captured source. Main-session conversation is not automatically attached. Each request reconstructs context; review does not resume BTW/native sessions. Claude/Muse disable native session persistence where their CLIs support it; backend/provider retention policies still apply.

Records, private text and captured source remain under:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bro-reviews/
```

The implementation uses the host's `getAgentDir()`. Records are `<review-id>.json`; captured source is under `source/<review-id>/`, including preserved `.incomplete-*` recovery directories. Failed/corrupt records are reported without overwriting them. There is no automatic cleanup or cross-machine sync. Source and recovery directories can grow. To remove one review manually, first close it in every Pi process and back up anything needed. Find its JSON record by matching `snapshot.target.repository` and `snapshot.target.number` (for example, search the JSON files for `"repository":"OWNER/REPO"`, then check the PR number). The filename without `.json` is its review ID; its source directory has that same ID under `source/`. Remove only that record and matching source directory. Do not delete the whole `bro-reviews/` directory, `bro-settings.json`, or another review's data. No deletion command is provided.

One open writer per review is supported within a Pi process. Concurrent editing of the same review from separate processes is unsupported.

## If something goes wrong

| Problem | What to do |
| --- | --- |
| GitHub unavailable when reopening | Use bare `/bro guided-review` to choose a saved review; the picker does not fetch |
| Unsupported review backend | Choose Claude or Muse for review in `/bro config`; no automatic switching |
| Git/gh authentication or fetch error | Read the acquisition error; check Git/`gh auth status`; retry explicitly |
| Invalid/failed preparation | Changed files remain available; use Prepare guide to retry when ready for another call |
| Failed regeneration | Current guide is kept; retry only if you want another call |
| Unavailable evidence | Treat it as unavailable; re-enter its topic/finding to retry transient reads |
| Binary/directory evidence | Not presented as source text; inspect the diff/inventory instead |
| Save error | Keep the window open; correct the reported cause and Retry saving or Close |
| Clipboard error | Read the notice; clipboard support depends on the host/platform |
| Author pushed new commits | Saved review remains on the captured revision; newer-revision review is not available |

## Not available yet

Notes, explicit examination tracking, branch/PR discovery, newer-revision review
and feedback delivery into Pi/GitHub are not implemented. These were part of
the original [#104 scope](https://github.com/tranhoangnguyen03/pi-bro/issues/104);
no implementation sequence is agreed. They are not required steps in the
reading experience above.
