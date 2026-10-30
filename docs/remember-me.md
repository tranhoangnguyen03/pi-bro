# Remember Me

[Docs home](README.md) · [Commands](reference/commands.md) · [Preferences](reference/settings.md#preferences)

Use \`/bro remember-me\` to browse your approved personal memories, or \`/bro remember-me <thought>\` to start drafting from your words and recent Pi conversation.

## Write through conversation

Bro reviews your statement and existing memories. It may ask one material question, flag a competing entry, or propose a short statement with deeper background. **Nothing saves until you type \`/save\`.** You can reply normally to refine a proposal.

A proposed memory always has:
- **Subject:** a distinct topic, such as Testing or Delegation
- **Short statement:** active, clear and usable on its own; include qualifications that change its meaning
- **Expanded background:** context, explanations and original wording; optional scope, exceptions, source context, uncertainty and whether wording reflects a user statement or user-approved interpretation

Use the same vocabulary across related memories. Put useful distinguishing words first. Never convert “prefers lean tests” into “dislikes tests,” or “autonomy within an approved plan” into “unrestricted autonomy.” Summaries and expanded content must agree.

If the user hasn't resolved a conflict, don't pretend it is settled. Bro shows a potential conflict in the proposal. The user decides whether to revise it, update an existing memory or save a qualified entry.

## Controls

| Input | Action |
| --- | --- |
| Free text | Continue clarifying or refining |
| \`/save\` | Approve and persist the current proposal |
| \`/list\` | Refresh and browse short memories |
| \`/expand <id>\` | Show background, source, scope, exceptions and uncertainty |
| \`/edit <id>\` | Edit an existing memory while keeping its stable ID |
| \`/delete <id>\` | Delete after typing yes |
| \`/new\` | Clear the draft without changing stored memories |
| \`/help\` | Explain commands and boundaries |

Esc closes the modal and cancels an active model call. The draft conversation is not durable; **approved saved memories are durable**. Saved entries survive Pi restarts and project changes.

## Agent access

The main Pi agent gets a read-only \`about_user\` tool:

\`\`\`text
about_user()                         → short statements and IDs
about_user({query:"testing"})        → matching summaries
about_user({expand:["m-..."]})       → approved background for an ID
\`\`\`

The agent can scan a summary before deciding what to unfold. The reader performs no new model call. It does not mutate stored entries. The user's current request wins over a standing memory.

## Boundaries

Stored memories live in \`~/.pi/agent/bro-memories.json\` (or under \`$PI_CODING_AGENT_DIR\`), not project Git repos. Files are personal: keep private backups and avoid sharing them in logs. Selected model providers receive the words you provide to Remember Me, recent session text captured at opening, and existing memory statements for conflict checking. Read-only \`about_user\` returns only the requested summaries/expansions to the calling main Pi agent; that agent may send returned content to its model provider.

**Agent access is currently the registered main Pi tool only.** External CLIs and isolated Bro sessions do not receive it automatically. The existing \`/bro preferences\` file remains unchanged; no automatic migration or conflict reconciliation is claimed.

Bro runs its writing assistant through the configured BTW backend in restricted mode, without asking it to edit files. Enforcement differs by backend; private text still reaches that backend's provider.

## Examples

**Short:** \`Testing: Seek sufficient confidence at the lowest reasonable maintenance cost; do not optimize for raw test count.\`

**Expanded:** The user values tests that protect meaningful behavior and rejects needless duplication. This does **not** mean the user dislikes tests. Scope: project test strategy. Source: explicit user preference.

**Short:** \`Delegation: Allow agents to act independently within an approved coordination plan; reserve consequential scope changes for human approval.\`

**Expanded:** The user wants strong initiative after authorizing the plan, not unrestricted delegation. An agent can coordinate approved subtasks but should return for approval when changing agreed goals or major commitments.

**Short:** \`Answer length: Lead with a short answer; give enough detail for consequential design reviews. [Apparent tension: brevity versus depth depends on task.]\`

**Expanded:** “Keep answers concise” and “go deep on important trade-offs” are not necessarily conflicting. Their scope differs: routine replies versus material design decisions. Preserve that distinction rather than deciding the user dislikes detailed work.
