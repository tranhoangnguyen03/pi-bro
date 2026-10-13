# Hero GIF for README.md. Record: DEMO=/tmp/pi-bro-demo vhs docs/tapes/demo.tape
# $DEMO holds agent/bro-settings.json (Agy, balanced, no preferences), agent/models.json
# (a placeholder local model so Pi starts quietly) and session.jsonl (a dense reply,
# the TypeScript example from docs/user-guide.md). Makes two real Agy calls.

Output pi-bro-demo.gif
Set Shell zsh
Set FontSize 16
Set Width 1280
Set Height 720
Set Padding 20
Set Theme "GitHub Dark"
Set TypingSpeed 70ms

Hide
Type "cd $DEMO/work && clear && PI_CODING_AGENT_DIR=$DEMO/agent pi --offline --no-extensions --no-skills --no-prompt-templates --no-context-files --session $DEMO/session.jsonl -e ~/.pi/agent/npm/node_modules/pi-bro/bro.ts" Enter
Sleep 7s
Show
Sleep 3s

Type "/bro" Sleep 600ms Enter
Sleep 2s
Hide
Sleep 22s
Show
Sleep 6s
Escape
Sleep 1s

Type "/bro btw what is the smallest fix?" Sleep 600ms Enter
Sleep 2s
Hide
Sleep 22s
Show
Sleep 5s
Escape
Sleep 1s
Hide
Ctrl+C
Ctrl+C
