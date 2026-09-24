# BTW `/mode` and Claude BTW — manual checklist (0.18.0, #58, #62)

Run in a disposable workspace containing `sample.txt`, with the same Pi launch as
`2026-09-24-claude-e2e.md`. Repeat steps 1–5 with BTW set to Agy, Claude and Grok in `/bro config`.

1. `/bro btw --fresh Remember the token KITE_77.` Header badge reads `conversation-only`; ask for the token.
2. Close with Esc, reopen with `/bro btw`: the thread and badge are unchanged; the token is still known.
3. Type `/mode`: badge reads `full permission` and the notice says `Mode: full permission`; the transcript stays.
   Ask `Read sample.txt and report its contents; do not modify files. Also, what was the token?` Expect a real read and `KITE_77`.
4. `/mode` again, then ask for the token: badge `conversation-only`, the answer comes without workspace tools (Claude: tools disabled; Agy: sandbox; Grok: prompt request only).
5. Esc, then `/bro btw --fresh`: new empty thread, same mode as before.
6. `/bro btw --full hi` and `/bro btw --sandbox hi`: rejected with a `/mode` hint and no model request.
7. Switch the BTW backend mid-thread: notice `Backend changed — started a fresh side thread.`; no ID crosses backends.
8. Cancel a BTW turn with Esc in each mode: no late answer, and the next question works.
9. `/bro doctor` passes Claude for BTW; `/bro help` and the `/bro` autocomplete describe `/mode`.
