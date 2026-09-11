# Decomposition validation set

A manual, non-`npm test` grading set for `/bro show`'s decomposition semantics
(subject-first shape selection), scored against `rubric.json`. See the
[0.11.0 CHANGELOG entry](../../../CHANGELOG.md) for how this set was built.

## Capture-format note

The seven fixtures mined from real pi-bro sessions (`decomp-*.transcript.txt`,
excluding `decomp-conversation-only-config-rename`) were captured **before**
`/bro show` became conversation-only (0.12.0). They still contain `## tool
call: <name>` and `## tool result: <name>` sections, because that is what
`/bro show` sent to the draw model at the time they were mined. They remain
useful for grading decomposition semantics — the concerns and expected shapes
they encode are still valid — but they no longer represent the literal input
`/bro show` produces today. Do not treat their presence of tool call/result
sections as current behavior.

`decomp-conversation-only-config-rename` is hand-authored (not mined from a
real session) to match the current, narrower capture: only `## user` and
`## assistant` conversation text, no tool sections. Prefer this shape for any
new fixture added to this set.
