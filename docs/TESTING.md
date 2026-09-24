# Manual end-to-end checklist

`npm test` is fully offline (see [DEVELOPMENT.md](DEVELOPMENT.md)). Run this
checklist before a release that changes backend, BTW, config, or modal
behavior. It uses real CLIs and your real accounts.

## Setup

Back up `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bro-settings.json`, then load
this checkout (not the installed package) in a disposable workspace:

```sh
BRO="/path/to/your/pi-bro/checkout"
TEST="$(mktemp -d /tmp/bro-e2e.XXXXXX)"
printf 'WORKSPACE_CANARY_6248\n' > "$TEST/sample.txt"
cd "$TEST"
pi --no-extensions -e "$BRO/bro.ts" --no-skills --no-prompt-templates --no-context-files --session "$TEST/session.jsonl"
```

Run the shared steps once per backend (Agy, Claude Code, Grok), selecting it
in `/bro config` as the shared default or as the capability under test.

## Shared steps

1. **Config**: `/bro config` — pick the backend+model as one choice for the
   shared default and for one override. Switching backend resets effort to
   that backend's default; Esc in a picker cancels; Esc on the screen keeps
   saved changes. Restart Pi: selections persist. An override stays pinned
   until set back to Default.
2. **Doctor**: `/bro doctor` shows the effective backend/model/effort per
   feature and probes only selected backends (Grok: version only, auth
   unverified). No model turn runs.
3. **Explain**: `/bro text There are two retries, after five and ten seconds.`
   streams and keeps the numbers. **R** reruns, **C** copies, Esc closes,
   `/bro open` reopens without a new request, and the header label shows
   model and effort (`default` when the model's effort applies). Also run
   `/bro file sample.txt`.
4. **Show**: after two parent turns, `/bro show 2` draws the transcript without
   investigating the repository.
5. **BTW context and mode** (start from a new thread, `/clear` first if one is open):
   1. `/bro btw Remember the token KITE_77.` — header badge `conversation-only`; ask for the token.
   2. Esc, then `/bro btw` — thread and badge unchanged; token still known.
   3. `/mode` — badge `full permission`, notice `Mode: full permission`,
      transcript kept. Ask `Read sample.txt and report its contents; do not
      modify files. Also, what was the token?` — expect a real read and `KITE_77`.
   4. `/mode` again — badge `conversation-only`; ask for the token; the answer
      follows conversation-only intent (Claude tools are disabled; Grok's
      instruction is behavioral, so inspect behavior rather than assuming enforcement).
   5. `/clear` — empty thread, same mode; the next question is seeded with
      main-session context again.
6. **BTW composer**: with a draft in the main editor, `/insert` and
   `/insert-all` leave it untouched with an edit/clear notice; after clearing
   it they insert without submitting. `/copy` and `/copy-all` reach the
   system clipboard. Other text such as `/send` is sent as a question.
7. **BTW backend switch**: change the BTW backend mid-thread — notice
   `Backend changed — started a fresh side thread.`
8. **Advisor**: `/bro advisor-steer`, save `Begin with STEER_7391. Do not
   modify files.` Ask the parent agent to call `bro_advisor` to read
   `sample.txt` and report its token. Expect tool activity, the token, the
   steering prefix, and the selected backend in the result header.
9. **Cancel**: press Esc during explain, show, and a BTW turn in each mode, and
   cancel a running advisor call. No late result, no retry after
   cancellation, and the next request works (stubborn processes get five
   seconds).
10. **Help**: `/bro help` and `/bro` autocomplete describe `/mode` and point to
    `/bro config`.

## Backend specifics

- **Agy**: conversation-only BTW runs sandboxed in a temporary directory. After
  `/mode`, Agy starts a fresh native session seeded with the whole thread, so
  earlier answers are still known.
- **Claude Code**: conversation-only BTW turns have tools disabled; one native
  session resumes across `/mode`. Claude aliases and custom model IDs work;
  efforts are default/low/medium/high/xhigh/max, and an unsupported
  combination returns Claude's error with no fallback. Doctor distinguishes
  "installed" and "auth configured" from connectivity.
- **Grok**: conversation-only is a prompt instruction only — tools remain
  available and the answer may still use them. One native session resumes
  across `/mode`. Custom model IDs work; efforts are
  default/low/medium/high/xhigh, and a model-specific rejection surfaces
  without clamping.

Restore the settings backup afterwards if desired.
