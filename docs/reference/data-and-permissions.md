# Backend access, privacy and retention

[Docs home](../README.md) · [All commands](commands.md) · [Safety and permissions](data-and-permissions.md)

## Backends: access and retention

Bro uses each CLI's own account and billing route, never Pi provider
credentials, and does not copy credentials or rewrite backend configuration.
Each backend and your model provider may retain sessions, logs, and request
data under their own settings and policies.

| | Explain / show / Elevate | BTW conversation-only | BTW full permission | Advisor | Guided Review |
| --- | --- | --- | --- | --- | --- |
| **Agy** | Temporary directory, Agy sandbox | Temporary directory, Agy sandbox | Workspace, permissions bypassed | Fresh workspace process, permissions bypassed | Unavailable; choose Claude/Muse |
| **Claude Code** | Scratch directory, tools/MCP/skills disabled, no session persistence | Workspace, tools disabled | Workspace, permissions bypassed | Fresh workspace process, permissions bypassed | Restricted Read/Grep/Glob only; confined checkout, no persistence |
| **Grok** | Temporary directory, **prompt instruction only** | Workspace, **prompt instruction only** | Workspace, permissions bypassed | Fresh workspace process, permissions bypassed | Unavailable; choose Claude/Muse |
| **Codex** | Scratch directory, read-only sandbox, ephemeral session | Workspace, read-only sandbox | Workspace, approvals and sandbox bypassed | Fresh workspace process, approvals and sandbox bypassed | Unavailable; command execution is not allowed for review |
| **Muse** | Scratch directory, approval/write/shell disabled, no session log | Workspace, approval/write/shell disabled | Workspace, permissions bypassed (`--yolo`) | Fresh workspace process, permissions bypassed (`--yolo`) | Captured checkout; writes/shell/web disabled, no session log |

- Grok always runs with its sandbox off and permissions bypassed; its tools,
  hooks, skills, plugins, and MCP may remain available. "Answer only from the
  supplied context" is a request, not an enforced restriction.
- Codex's read-only sandbox is not a tool-free mode: workspace reads and
  sandboxed commands remain available. Bro does not disable configured MCP
  servers or web search; their access is governed by Codex configuration.
- Muse's restricted mode disables write and shell tools and approval prompts,
  not all tools: workspace reads and web tools remain available without approval.
  It is not a tool-free or network-isolated mode.
- Claude's restrictions are tool/configuration settings (with safe mode), not
  an OS sandbox; built-in and managed Claude behavior can remain. Running a
  permission-bypassing mode as root may be rejected by Claude.
- BTW continues natively: Agy by conversation ID, Claude and Grok by
  `--resume`, Codex by `resume`, and Muse by `--session-id` of the same session,
  including across `/mode` switches. An Agy conversation stays bound to the
  workspace it started in, so after a `/mode` switch — or whenever a thread
  has turns but no native session ID — Bro starts a fresh native session
  seeded with the main-session context and every earlier turn.
- Cancellation, deadlines, and invalid output streams stop the backend's
  process group on POSIX, escalating after a five-second grace period. On
  Windows only the direct child is targeted. Detached shell work or external
  services a backend started are not contained. Bro removes its private
  temporary prompt files.

### Configuration precedence

When resolving backend, model, and reasoning effort:
1. **Per-capability override**: `overrides.<capability>` (`explain`, `show`, `btw`, `advisor`, or `review`) pins that capability's complete selection.
2. **Shared default**: otherwise the capability inherits `default` (root `model`/`effort` in older flat files).
3. **Agy catalog normalization**: for Agy selections, Bro maps suffixed variant IDs and handles fixed-effort models.
4. **Initial file creation only**: `PI_BRO_MODEL` has no effect once the settings file exists.

When resolving turn count for `/bro show`:
1. **Command argument**: an explicit count like `/bro show 3` or `/bro show 1 query` overrides for that run.
2. **Saved setting**: `showTurns` (defaults to 1).

When shaping an answer, each part has one owner:

| Part | Decided by |
| --- | --- |
| Bro's source rules: quoted source treated as data, no added facts, Show's traceability rules, BTW access mode | Built in; nothing overrides them |
| How much of the source an explanation keeps | The mode: **M** for one explanation, otherwise the saved `mode` |
| What a Show drawing focuses on | The steering query |
| Who the answer is for: wording, tone, depth, and answer language | Your [preferences](settings.md#preferences), otherwise Bro's built-in defaults |

## Privacy and safety

- **External requests**: Bro sends the latest completed assistant response,
  pasted text, extracted document text, extracted webpage text, or recent
  session conversation text (tool calls, tool results, reasoning, and images
  omitted) to the selected backend and its configured model provider.
- **Elevate requests**: `/bro elevate` sends your objective, preferences, and all user/assistant text on the current branch by default, without a fixed history cap. Its visible Context switch can include tool-call arguments and text results (Full), potentially including sensitive file contents or command output. Both modes exclude hidden reasoning and image binaries. Only explicit Retry after a context-overload error trims older history; the UI discloses reduced context. Its optional rewrite call includes only approved findings. It makes fresh restricted calls through the BTW model setting, but a backend's restricted mode is not a universal file/network sandbox (Grok restrictions are prompt-only). It does not insert or submit anything to Pi unless you approve insertion. In the terminal, insertion can replace the draft Elevate was opened on, if it is unchanged; an explicit `/bro elevate <request>` requires an empty editor. See the [Elevate guide](../elevate.md).
- **Side conversation requests**: `/bro btw` sends your side questions and the
  seeded main-session conversation text (plus earlier turns when a native
  session is reseeded) to the selected backend. In full permission mode the
  side agent can additionally read and edit the workspace.
- **Guided Review requests**: PR identity/description, captured diff, relevant private discussion and preferences go to the selected backend, which can inspect captured files using Claude/Muse read-only tools. Main-session context is not attached. Review shell/write/web tools are disabled; Claude file tools are confined with `--restricted`, Muse uses workspace-scoped inspection. Prompt injection can still corrupt conclusions or reveal captured content to the provider; this is not a general confidentiality guarantee. See [Guided Review access and storage](../guided-review.md#access-privacy-and-storage).
- **Preferences**: `bro-preferences.md` is sent with every explain, Show,
  BTW, Elevate, and Guided Review request to the selected backend. It is never sent to the advisor or
  to Pi's main model.
- **Advisor requests**: `bro_advisor` sends the executor agent's system
  instructions, active tool list (excluding `bro_advisor`), ordered
  conversation history including tool calls and tool results (unlike Show,
  which omits them), your steering brief, and the executor's optional question
  to the selected backend. Reasoning and image bodies are omitted with explicit
  markers (`[reasoning omitted]`, `[image omitted]`). The advisor process runs
  in your workspace with auto-approved permissions; its instruction to only
  advise is behavioral, not an enforced boundary.
- **Access enforcement** differs by backend; see
  [Backends: access and retention](data-and-permissions.md#backends-access-and-retention). Prompt
  instructions are not access enforcement.
- **Context isolation**: Bro does not add explanations, BTW answers, or the
  steering brief to Pi's conversation history or main-agent context. BTW text
  reaches the main editor only through `/insert` or `/insert-all`, and advisor
  results appear as normal tool results in the executor's transcript.
- **Saved reviews**: Guided Review records, questions, drafts and captured Git source persist under the host's `getAgentDir()/bro-reviews/`. No automatic cleanup or sync is provided; see [storage and removal](../guided-review.md#access-privacy-and-storage).
- **Memory**: the latest explanation (for `/bro open`) and the BTW thread live
  only in process memory and clear when you switch Pi sessions, reload
  extensions, or quit Pi. Backend-native sessions can persist independently.
  Standing advisor priorities are stored in `~/.pi/agent/bro-advisor.md`, and
  the session steering brief is stored as session-scoped extension data
  (`bro-advisor-steering`) in the session file.
- **File safety**: `/bro file` reads only regular files whose resolved path is
  inside Pi's current workspace, including after resolving symlinks. Bro's
  extractor does not modify them.
- **Web requests**: `/bro url` connects directly to the target website. The site
  sees your IP address and Bro's user agent. Bro sends no browser cookies,
  authorization, or referrer information, and it refuses local, private, and
  reserved network destinations, including redirects. Avoid private or signed
  URLs whose query string contains secrets.
- **Web extraction**: Bro parses downloaded HTML locally without executing page
  scripts or loading page subresources. It sends the extracted readable text,
  including links preserved in that text, to the selected backend; it does not
  separately send the requested URL or raw page HTML.
- **Show diagrams**: When a show reply ends in one self-contained HTML block
  or one Mermaid sequence diagram, Bro writes a page to
  `pi-bro-<uid>/bro-show-<hash>.html` in your system temp folder with a
  restrictive Content-Security-Policy, and opens it in your browser only when
  you press **O**. HTML pages run no scripts. Sequence-diagram pages run only
  Bro's bundled Mermaid and its fixed setup script; the model's diagram text is
  inserted as escaped text and nothing is loaded from the network. **C**
  copies the full reply, including the diagram source.
- **Clipboard**: **C**, `/copy`, `/copy-all`, and Guided Review's Copy finding copy text to your system
  clipboard, where your operating system or clipboard manager may retain it.
