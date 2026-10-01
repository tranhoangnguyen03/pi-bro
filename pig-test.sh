#!/bin/sh
set -eu
cd "$(dirname "$0")"
: "${PIG_BIN:?Set PIG_BIN to the PiG 0.3.0 executable}"
PIG_BIN=$(cd "$(dirname "$PIG_BIN")" && pwd)/$(basename "$PIG_BIN")
export PIG_BIN
[ "$("$PIG_BIN" --version)" = '0.3.0+0.87.1' ] || { echo 'Review compatibility checks before changing the pinned PiG version.' >&2; exit 1; }
node pig-test.mjs
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
export PIG_HOME="$root/home" PIG_USE_PI_DIRS=0
# Reuse each smoke scenario's fresh directory, while deliberately poisoning
# the other host's path. Pure helpers run separately under npm test, not here.
cat > "$root/pig-wrapper" <<'WRAPPER'
#!/bin/sh
export PIG_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR"
export PI_CODING_AGENT_DIR="$PIG_HOME/pi-must-not-be-used"
exec "$PIG_BIN" "$@"
WRAPPER
chmod +x "$root/pig-wrapper"
PI_BIN="$root/pig-wrapper" BRO_PIG_RPC_EXCLUSION_XFAIL=0.3.0 sh smoke-test.sh
[ ! -e "$PIG_HOME/pi-must-not-be-used/bro-settings.json" ]
