# [experimental] Bro for Claude Code

Tracks [issue #161](https://github.com/tranhoangnguyen03/pi-bro/issues/161) and [draft PR #162](https://github.com/tranhoangnguyen03/pi-bro/pull/162).

An installable Claude Code Mod for vanilla **/bro** and **/bro simplify**. It privately simplifies the latest completed main-agent answer using the same balanced prompt as the Pi extension. The pane has Retry, Copy, Close, and **/bro open**. Nothing enters Claude's main conversation.

## Install from GitHub

While PR #162 is still a draft, pin the **marketplace** to the experimental branch:

~~~text
/plugin marketplace add tranhoangnguyen03/pi-bro@experimental/claude-mod-simplify
/plugin install bro-simplify-experimental@pi-bro
~~~

After the marketplace file reaches the main branch, new users can install with:

~~~text
/plugin marketplace add tranhoangnguyen03/pi-bro
/plugin install bro-simplify-experimental@pi-bro
~~~

**pi-bro** is the marketplace name, not the plugin name. The repository contains the complete plugin under **experiments/claude-mod**, including the Node bridge. No checked-out Pi source tree is required after installation. Restart or reload Claude Code afterward. Only install trusted plugins: Mods and backend CLIs run local code as your user.

## /bro config

Run **/bro config**. Choose a backend, enter a model, choose a supported reasoning effort, then **Save**. The selection survives restarts in Claude's per-plugin store; it never overwrites the original Pi settings file. It applies to **Explain** only for this experimental version. Changes apply on the next request or Retry.

| Backend | Model | Effort | Prerequisite |
| --- | --- | --- | --- |
| Claude Native | current (default) or explicit Claude model ID/alias | default (host-managed) | Signed-in Claude Code |
| Agy | e.g. gemini-3.7-flash | default/low/medium/high | Signed-in agy CLI |
| Codex | e.g. gpt-5.4 | default/low/medium/high/xhigh | Signed-in codex CLI |
| Pi CLI | physical provider/model | default/minimal/low/medium/high/xhigh/max | Signed-in pi CLI |

**Pi CLI** is not the Pi SDK in-process backend from the original pi-bro. It invokes the installed Pi binary with an isolated one-shot session. Claude Native uses the current Claude account and does not accept an effort override.

Unsupported backend/model/effort requests produce an error rather than silently switching backend.

## Permissions and privacy

For external CLI calls the Mod invokes a bundled Node.js 22+ bridge with the selected model and Bro prompt. The bridge runs in a private scratch directory, reads the canonical result and cleans up.

- **Agy:** sandbox flag and scratch directory; Agy sandbox does not make it tool-free, and network/other tooling may still be available.
- **Codex:** read-only sandbox and ephemeral execution. This restricts Codex tool commands, not arbitrary plugins or hooks.
- **Pi:** disables sessions, extensions, MCP, skills, prompt templates, context files, tools, and project trust using Pi CLI flags.

Claude Native uses the tool-free model completion API. Every backend uses its own credentials and billing route. The Mod does not copy credential files. Only the selected answer and Bro's instructions are sent.

**Cancellation limit:** the reviewed Claude Mod API returns whole completions. External backends also currently return their result only after completion. Closing the pane discards late results but may not stop the underlying API call or process.run call. The Node bridge has a deadline and process cleanup on timeout/termination, but do not treat this as full Pi cancellation parity.

## Current scope and testing

Only Explain is available. Show, BTW, Elevate, Advisor, Guided Review and the original in-process Pi SDK path are not ported. The native /bro prototype worked in the user's Claude environment after PR fixes; the new backend choices and /bro config still require live validation.

From the repository root:

~~~sh
node --test experiments/claude-mod/tests/*.test.mjs
claude plugin validate ./experiments/claude-mod
claude --plugin-dir ./experiments/claude-mod
~~~

Try /bro after a completed answer. In /bro config choose each installed backend, test Save/restart, retry, Copy and Close. Check that no simplification enters Claude's main context.

Offline tests use fake CLI responses and cost no model tokens. The existing Pi extension remains unchanged.
