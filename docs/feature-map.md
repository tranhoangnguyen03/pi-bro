# Choose Bro by what you need

These are **human intentions**, not modes. Run any feature directly. Bare `/bro` still explains the latest answer.

| I need to… | Feature | What will I get? |
| --- | --- | --- |
| **Understand what already exists:** make sense of an answer or file | Simplify (`/bro`) | A clearer explanation |
| Understand the shape of the discussion | `/bro show` | Diagram, structure, or outline of conversation text |
| Understand a repository | `/bro architecture` | Architecture docs and offline visualization |
| Trim and reuse an assistant reply | `/bro copy` | Editable raw Markdown, rendered preview, and clipboard copy |
| **Explore what could exist:** ask a side question | `/bro btw` | A flexible private conversation |
| Challenge a proposal or form a decision | `/bro grill-me` | Reasoned discussion and optional decision brief |
| **Get advice on existing work:** review a code change | `/bro guided-review` | Saved findings and code evidence |
| Reconsider substantial work automatically | `/bro overthink` | Private notes when material concerns arise |
| Give the agent independent advice | `bro_advisor` (agent tool) | A second opinion returned to the agent |
| **Guide the agent:** improve the next assignment | `/bro elevate` | Revised request to copy, edit, and submit |
| Remember lasting personal facts/preferences | `/bro remember-me` | Approved memory available through the read-only `about_user` agent tool |
| Set the advisor's priorities | `/bro advisor-steer` | Saved session steering |
| Set shared answer style | `/bro preferences` | Persistent style preferences |

`/bro config`, `/bro doctor`, and `/bro help` are support controls, not another intent state. BTW can serve any need; exploration is its primary role. Overthink uses the active Pi model for a second look; Advisor uses an independent backend.

## Shared interactions, distinct workflows

- **Copy** is the only manual text handoff. Native Pi `/copy` copies immediately; `/bro copy` lets users edit and preview the last reply before copying. It never edits Pi's draft, submits a message or writes to GitHub. You decide where to paste and when to submit. BTW supports latest/all; Grill Me copies its latest reply or brief; Elevate copies a revised assignment; Guided Review copies findings. Retired `/insert` commands tell users to copy instead.
- **Resume** restores feature-owned state where needed, not a shared chat engine. Latest Simplify/Show, BTW and Grill Me restore from private Pi session entries on reload, restart, resume and `/tree`; saved Guided Review, approved Remember Me and steering already have durable state.
- **Clear / Reset / Delete** belong to each feature: BTW resets its thread; Grill Me starts a new interview; Guided Review deletes a specific saved review once cleanup ships; Remember Me deletes a named approved memory; Overthink resets its question defaults.
- **Retry / Regenerate** repeats a step without silently losing prior accepted work. Guided Review's regenerate (same captured source) is not update revision (new source).
- **Help / Close** share meanings, but a short viewer needs fewer controls than a review or interview.

Do not standardize away distinctive capabilities: Simplify source and modes, Show diagram opening, BTW permissions, Grill Me depth and consolidation, Elevate discovery/selection/rewrite, Guided Review evidence and revisions, Overthink automatic checks/questions, and Remember Me approval/conflict resolution.

## Trust and acceptance

Private Bro work stays out of Pi's model context unless the human pastes and sends it. `bro_advisor` and `about_user` are intended agent-facing tool result channels, not manual Insert. Use existing Pi session entries or feature-owned stores for persistence. Never claim prompts alone enforce access limits. The human owner judges cohesion by a practical vibe-check, without a new scoring bureaucracy.
