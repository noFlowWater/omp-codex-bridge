#!/bin/sh
# TEST-ONLY: real OMP with the hub-fixture orchestrator and the fake Codex app-server; no model inference.
# Extra arguments go to omp, e.g. `fixture.sh --mode rpc --no-ui` or no arguments for the TUI.
#
# No real account can be reached: OMP runs under `env -i` with an allowlisted environment (no API keys,
# auth-broker or cloud variables) and HOME/XDG directories that are new and inside the fixture
# directory, so it sees no stored login, settings, profiles or broker configuration. Both fixture
# providers run without inference; `codex` on PATH is the protocol double. Extension and agent
# sources come only from this checkout's native package install, before the switch.
# CODEX_HUB_FIXTURE_OPTIONS replaces the fake server's options.json (default: the first native turn
# shows a command item and stays active until steered or interrupted).
# Cleanup afterwards: the printed fixture directory (it also holds the isolated OMP home).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
OMP=$(command -v omp)
NODE=$(command -v node)
# CODEX_HUB_FIXTURE_DIR (an existing empty directory) replaces the mktemp directory; smoke.mjs uses it.
FIX=${CODEX_HUB_FIXTURE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/codex-hub-fixture.XXXXXX")}
mkdir -p "$FIX/bin" "$FIX/work" "$FIX/home" "$FIX/xdg/config" "$FIX/xdg/data" "$FIX/xdg/state" "$FIX/xdg/cache" "$FIX/tmp"
printf '#!/bin/sh\nexec "%s" "%s" --fake-app-server\n' "$NODE" "$REPO/test/client.test.mjs" > "$FIX/bin/codex"
chmod 755 "$FIX/bin/codex"
DEFAULT_OPTIONS='{"turns":["work"]}'
printf '%s\n' "${CODEX_HUB_FIXTURE_OPTIONS:-$DEFAULT_OPTIONS}" > "$FIX/options.json"
# CODEX_HUB_FIXTURE_MODEL (an exact selector, e.g. codex-bridge/gpt-6-astra) makes the orchestrator
# pass it as the task item's `model`. Only for that run the fixture config turns the per-call gate on
# (OMP default: off) and allowlists exactly that selector. The installed user-scope package supplies the
# agent's model grant; no user agent copy/link is needed. options.json must list the native model too.
PER_CALL_MODEL=""
[ -z "${CODEX_HUB_FIXTURE_MODEL:-}" ] || PER_CALL_MODEL=$(printf '  perCallModel: "on"\n  perCallModelAllow:\n    - "%s"' "$CODEX_HUB_FIXTURE_MODEL")
# Fixture-only settings: no startup dialogs, the shipped default unstructured task results, and no idle
# parking during the smoke. CODEX_HUB_FIXTURE_STRUCTURED=true exercises the yield-tool contract instead.
# providers.openaiLiveSteering (OMP 18.20 default: false) is the opt-in that lets a message typed into a
# running child reach that native turn; the steer smoke modes test that opt-in path.
# CODEX_HUB_FIXTURE_LIVE_STEERING=false runs the shipped default instead.
cat > "$FIX/config.yml" <<EOF
startup:
  showSplash: false
  setupWizard: false
task:
  structured: ${CODEX_HUB_FIXTURE_STRUCTURED:-false}
  agentIdleTtlMs: 0
  enableEffort: ${CODEX_HUB_FIXTURE_ENABLE_EFFORT:-false}
$PER_CALL_MODEL
providers:
  openaiLiveSteering: ${CODEX_HUB_FIXTURE_LIVE_STEERING:-true}
compaction:
  keepRecentTokens: ${CODEX_HUB_FIXTURE_KEEP_RECENT_TOKENS:-20000}
EOF
echo "codex-hub-fixture: $FIX (trace: $FIX/trace.jsonl, isolated home: $FIX/home)" >&2
cd "$FIX/work"
# The orchestrator spawns the single `codex-bridge` agent (workspace-write in the child cwd), or with
# CODEX_HUB_FIXTURE_DIRECT_SANDBOX calls the direct `codex_bridge` tool (then also enabled) with that removed argument.
TOOLS=task
if [ -n "${CODEX_HUB_FIXTURE_DIRECT_SANDBOX:-}${CODEX_HUB_FIXTURE_DIRECT_JSON:-}" ]; then TOOLS=task,codex_bridge; fi
# Test-only root selection uses the ordinary CLI flag, not a model-changing helper command.
ROOT_MODEL=${CODEX_HUB_FIXTURE_ROOT_MODEL:-codex-hub-fixture/orchestrator}
exec env -i \
  HOME="$FIX/home" XDG_CONFIG_HOME="$FIX/xdg/config" XDG_DATA_HOME="$FIX/xdg/data" \
  XDG_STATE_HOME="$FIX/xdg/state" XDG_CACHE_HOME="$FIX/xdg/cache" TMPDIR="$FIX/tmp" \
  PATH="$FIX/bin:$(dirname "$OMP"):/usr/bin:/bin" CODEX_HOME="$FIX" \
  OMP_CODEX_BRIDGE_STATE_DIR="$FIX/codex-bridge-state" \
  CODEX_HUB_FIXTURE_DISPATCH="$FIX/provider-dispatch.jsonl" \
  TERM="${TERM:-xterm-256color}" LANG="${LANG:-C.UTF-8}" ${LC_ALL:+LC_ALL="$LC_ALL"} \
  ${OMP_TUI_DEBUG:+OMP_TUI_DEBUG="$OMP_TUI_DEBUG"} \
  ${CODEX_HUB_FIXTURE_CONTEXT:+CODEX_HUB_FIXTURE_CONTEXT="$CODEX_HUB_FIXTURE_CONTEXT"} \
  ${CODEX_HUB_FIXTURE_MODEL:+CODEX_HUB_FIXTURE_MODEL="$CODEX_HUB_FIXTURE_MODEL"} \
  ${CODEX_HUB_FIXTURE_DIRECT_SANDBOX:+CODEX_HUB_FIXTURE_DIRECT_SANDBOX="$CODEX_HUB_FIXTURE_DIRECT_SANDBOX"} \
  ${CODEX_HUB_FIXTURE_DIRECT_JSON:+CODEX_HUB_FIXTURE_DIRECT_JSON="$CODEX_HUB_FIXTURE_DIRECT_JSON"} \
  ${CODEX_HUB_FIXTURE_SCHEMA:+CODEX_HUB_FIXTURE_SCHEMA="$CODEX_HUB_FIXTURE_SCHEMA"} \
  ${CODEX_HUB_FIXTURE_EFFORT:+CODEX_HUB_FIXTURE_EFFORT="$CODEX_HUB_FIXTURE_EFFORT"} \
  sh -c '
    set -eu
    omp=$1
    repo=$2
    shift 2
    "$omp" plugin install "$repo" >&2
    exec "$omp" "$@"
  ' sh "$OMP" "$REPO" --config "$FIX/config.yml" \
  -e "$HERE/fixture.ts" --model "$ROOT_MODEL" --tools "$TOOLS" --no-title "$@"
