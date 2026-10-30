# Remember Me

[Docs home](README.md) · [Commands](reference/commands.md) · [Preferences](reference/settings.md#preferences)

Use `/bro remember-me` to browse your approved personal memories, or `/bro remember-me <thought>` to start drafting from your words and recent Pi conversation.

## Write through conversation

Bro reviews your statement and existing memories. It may ask one material question, flag a competing entry, or propose a short statement with deeper background. **Nothing saves until you type `/save`.** You can reply normally to refine a proposal. When you correct it, the old draft remains visible but cannot be approved until Bro returns a revised proposal. Questions and failed model calls never silently re-enable `/save`.

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
| `/save` | Approve and persist the current proposal |
| `/list [page|all]` | Page through the current search (20 per page), or use `/list all` to return to all memories; preserve the proposal |
| `/search <words>` | Start a filtered search; `/list 2` continues its second page without dropping the proposal |
| `/expand <id>` | Show background, source, scope, exceptions and uncertainty |
| `/edit <id>` | Edit an existing memory while keeping its stable ID |
| `/delete <id>` | Delete after typing yes |
| `/context show|on|off` | See or omit the captured Pi context before transmitting |
| `/confirm-revision` | Approve after comparing a stale proposal with changed memories |
| `/new` | Discard the draft without changing saved memories |
| `/help` | Explain commands and boundaries |

Before the first model call, Bro identifies the selected model/backend, the captured main-session context, and that related saved memories and legacy style preferences will be sent. The initial thought is prefilled but not sent until the user presses Enter. Use `/context show` to inspect what was captured or `/context off` to omit it.

Browsing and failed saves preserve the proposal. If the store changed after the proposal was reviewed, `/save` compares the original and current target (and related entries) and **does not save**. An explicit `/confirm-revision` approves against that exact new revision; if it changes again, another review is required. Durable drafts across restarts are not implemented.

Esc closes the modal and cancels an active model call. The draft conversation is not durable; **approved saved memories are durable**. Saved entries survive Pi restarts and project changes.

## Agent access

The main Pi agent gets a read-only `about_user` tool:

```text
about_user()                         → short statements and IDs
about_user({query:"testing"})        → matching summaries
about_user({offset:20,limit:20})      → next page of memories
about_user({expand:["m-..."]})       → approved background for an ID
```

The agent can scan a summary before deciding what to unfold. The reader performs no new model call. It does not mutate stored entries. The user's current request wins over a standing memory.

## Boundaries

Stored memories live in `~/.pi/agent/bro-memories.json` (or under `$PI_CODING_AGENT_DIR`), not project Git repos. Files are personal: keep private backups and avoid sharing them in logs. Selected model providers receive the words you provide to Remember Me, recent session text captured at opening, and existing memory statements for conflict checking. Read-only `about_user` returns only the requested summaries/expansions to the calling main Pi agent; that agent may send returned content to its model provider.

**Agent access is currently the registered main Pi tool only.** External CLIs and isolated Bro sessions do not receive it automatically. The existing `/bro preferences` file remains unchanged; no automatic migration or conflict reconciliation is claimed.

Remember Me uses **the backend and model selected for BTW**. Every valid BTW backend is supported through Bro's existing restricted **explain** execution path. It never silently changes provider or model. Restricted means different things across backends, not a universal promise of no tools or no side effects:

| Backend | Current restricted drafting behavior |
| --- | --- |
| Agy (default) | `--sandbox`, temporary working directory. Sandbox limits shell actions; it is **not** a no-tools or no-write guarantee. |
| Codex | `--sandbox read-only`, ephemeral execution and temporary working directory; read-only sandbox, **not** no-tools. |
| Claude | CLI tools disabled with `--tools ""`, strict empty MCP config, temporary working directory, no session persistence. |
| Pi | Fresh SDK session with no tools, extensions, skills, or project context files, using the **selected configured physical model**. |
| Muse | Write and shell disabled, approvals disabled, temporary working directory. Do not infer that all other abilities are disabled. |
| Grok | A restricted **prompt request**, but CLI sandbox off and permissions bypassed; it is **not** a technical tool/write boundary. |

The modal shows a backend-specific notice before sending data. Bro's `/save` gate controls **only writes to its approved memory store**. It does not prevent any action that the selected backend's own permissions might allow. See [execution configuration](reference/settings.md) for backend details.

Live model behavior and the actual backend installation are separate from controlled-response tests.

**Coexistence policy:** `/bro preferences` remains active as a legacy *answer-style* file for older Bro features. `about_user` reads only approved Remember Me memories. Current user instructions take precedence. If an approved memory conflicts with legacy preferences, the approved memory is the source for the personal fact or lasting rule; do not treat two conflicting stores as equally authoritative. Bro should surface the disagreement during drafting. There is no silent migration or overwrite; a reviewed migration remains a separate task.

## Examples

**Short:** `Testing: Seek sufficient confidence at the lowest reasonable maintenance cost; do not optimize for raw test count.`

**Expanded:** The user values tests that protect meaningful behavior and rejects needless duplication. This does **not** mean the user dislikes tests. Scope: project test strategy. Source: explicit user preference.

**Short:** `Delegation: Allow agents to act independently within an approved coordination plan; reserve consequential scope changes for human approval.`

**Expanded:** The user wants strong initiative after authorizing the plan, not unrestricted delegation. An agent can coordinate approved subtasks but should return for approval when changing agreed goals or major commitments.

**Short:** `Answer length: Lead with a short answer; give enough detail for consequential design reviews. [Apparent tension: brevity versus depth depends on task.]`

**Expanded:** “Keep answers concise” and “go deep on important trade-offs” are not necessarily conflicting. Their scope differs: routine replies versus material design decisions. Preserve that distinction rather than deciding the user dislikes detailed work.
