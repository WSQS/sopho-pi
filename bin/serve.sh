#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
BASE="$ROOT/server/base.mjs"
APP="$ROOT/server/app.mjs"
# 下面这组默认值 = 本机（arcsopho）的线上实例口径，所以裸 `npm run serve` 起的就应该是线上那套：
#   A = 127.0.0.1:7331（只绑回环）  B = 0.0.0.0:7321（局域网/ZeroTier 上的浏览器打这个）
#   数据目录 = ~/.pi/profiles/assistant（三个 agent 目录变量口径必须一致，见 docs/deploy-winbox.md §2）
# 显式传入的环境变量一律优先 —— 测试 / 沙箱 / 演练都是显式传端口与 profile 的，不受这里影响。
# ⚠️ B 是零认证（server/app.mjs），0.0.0.0 默认意味着能连上它的客户端就能改 page root 里的文件。
AGENT_DIR=${PI_CODING_AGENT_DIR:-${ASSIST_HOME:-${SOPHO_AGENT_DIR:-$HOME/.pi/profiles/assistant}}}
PI_CODING_AGENT_DIR=$AGENT_DIR
ASSIST_HOME=$AGENT_DIR
SOPHO_AGENT_DIR=$AGENT_DIR
export PI_CODING_AGENT_DIR ASSIST_HOME SOPHO_AGENT_DIR
HOST=${SOPHO_HOST:-127.0.0.1}
PORT=${SOPHO_PORT:-7331}
# B 的宿主**不跟 A 走**：没显式给 SOPHO_APP_HOST 时一律对局域网（不继承 SOPHO_HOST），与 Windows 侧同口径。
# 2026-09-23 业主裁定：app 默认对局域网（旧口径会继承 SOPHO_HOST ⇒ 默认回环，导致外部连不上网页）；
# 想让 app 也只回环的沙箱请**显式**给 SOPHO_APP_HOST=127.0.0.1。
APP_HOST=${SOPHO_APP_HOST:-0.0.0.0}
APP_PORT=${SOPHO_APP_PORT:-7321}
WEB_ROOT=${SOPHO_WEB_ROOT:-$ROOT/web}
BASE_LOG=${SOPHO_LOG:-${TMPDIR:-/tmp}/s0b-base-${UID}-${PORT}.log}
APP_LOG=${SOPHO_APP_LOG:-${TMPDIR:-/tmp}/s0b-app-${UID}-${APP_PORT}.log}

validate_port() {
  local name=$1 value=$2
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 || value > 65535 )); then
    echo "invalid $name: $value" >&2
    exit 1
  fi
}
validate_port SOPHO_PORT "$PORT"
validate_port SOPHO_APP_PORT "$APP_PORT"
if [[ "$PORT" == "$APP_PORT" ]]; then
  echo "SOPHO_PORT and SOPHO_APP_PORT must differ: $PORT" >&2
  exit 1
fi

# The port owner is the authority for "who is listening"; the pid we spawned ($!) is only
# used as a cross-check, so two concurrent serve.sh runs cannot claim each other's process.
port_owner() {
  local selected_port=$1 table
  if ! table=$(ss -H -ltnp "sport = :$selected_port"); then
    echo "ss could not list port $selected_port" >&2
    return 1
  fi
  printf '%s\n' "$table" \
    | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' \
    | head -n 1
}

is_our_process() {
  local pid=$1 entry=$2 arg
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  while IFS= read -r -d '' arg; do
    [[ "$arg" == "$entry" ]] && return 0
  done < "/proc/$pid/cmdline"
  return 1
}

await_child_listener() {
  local label=$1 selected_port=$2 child_pid=$3 entry=$4 current
  for _ in $(seq 1 100); do
    current=$(port_owner "$selected_port") || return 1
    if [[ -n "$current" ]]; then
      if [[ "$current" != "$child_pid" ]]; then
        echo "$label start failed: port $selected_port is owned by pid $current, not our child $child_pid (concurrent start?)" >&2
        return 1
      fi
      if ! is_our_process "$child_pid" "$entry"; then
        echo "$label start failed: port $selected_port belongs to pid $child_pid, but its cmdline is not $entry" >&2
        return 1
      fi
      printf '%s' "$child_pid"
      return 0
    fi
    if ! kill -0 "$child_pid" 2>/dev/null; then
      echo "$label start failed: child pid $child_pid exited before it listened on port $selected_port" >&2
      return 1
    fi
    sleep 0.05
  done
  echo "$label start failed: no listener appeared on port $selected_port" >&2
  return 1
}

kill_our_child() {
  local child_pid=$1 entry=$2
  [[ -n "$child_pid" ]] || return 0
  if is_our_process "$child_pid" "$entry"; then
    kill -TERM "$child_pid" 2>/dev/null || true
  fi
}

for selected_port in "$PORT" "$APP_PORT"; do
  existing_pid=$(port_owner "$selected_port") || exit 1
  if [[ -n "$existing_pid" ]]; then
    echo "refusing to start: port $selected_port is already listened to by pid $existing_pid" >&2
    exit 1
  fi
done

mkdir -p -- "$(dirname -- "$BASE_LOG")" "$(dirname -- "$APP_LOG")"
base_child_pid=''
app_child_pid=''
cleanup_failed_start() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    kill_our_child "$app_child_pid" "$APP"
    kill_our_child "$base_child_pid" "$BASE"
  fi
  exit "$status"
}
trap cleanup_failed_start EXIT

nohup env SOPHO_HOST="$HOST" SOPHO_PORT="$PORT" node "$BASE" >>"$BASE_LOG" 2>&1 </dev/null &
base_child_pid=$!
if ! base_pid=$(await_child_listener A "$PORT" "$base_child_pid" "$BASE"); then
  echo "A log: $BASE_LOG" >&2
  tail -n 30 -- "$BASE_LOG" >&2 || true
  exit 1
fi

nohup env \
  SOPHO_APP_HOST="$APP_HOST" \
  SOPHO_APP_PORT="$APP_PORT" \
  SOPHO_UPSTREAM_HOST="$HOST" \
  SOPHO_UPSTREAM_PORT="$PORT" \
  SOPHO_WEB_ROOT="$WEB_ROOT" \
  node "$APP" >>"$APP_LOG" 2>&1 </dev/null &
app_child_pid=$!
if ! app_pid=$(await_child_listener B "$APP_PORT" "$app_child_pid" "$APP"); then
  echo "B log: $APP_LOG" >&2
  tail -n 30 -- "$APP_LOG" >&2 || true
  exit 1
fi

host_json=$(curl --fail --silent --show-error --max-time 3 "http://$HOST:$PORT/host")
app_json=$(curl --fail --silent --show-error --max-time 3 "http://$APP_HOST:$APP_PORT/app-host")
proxy_json=$(curl --fail --silent --show-error --max-time 3 "http://$APP_HOST:$APP_PORT/api/host")
curl --fail --silent --show-error --max-time 3 --output /dev/null "http://$APP_HOST:$APP_PORT/"
proof=$(HOST_JSON="$host_json" APP_JSON="$app_json" PROXY_JSON="$proxy_json" EXPECTED_PID="$base_pid" EXPECTED_APP_PID="$app_pid" node -e '
const direct = JSON.parse(process.env.HOST_JSON);
const app = JSON.parse(process.env.APP_JSON);
const proxied = JSON.parse(process.env.PROXY_JSON);
if (String(direct.pid) !== process.env.EXPECTED_PID) process.exit(2);
if (String(app.pid) !== process.env.EXPECTED_APP_PID) process.exit(3);
if (typeof app.codeVersion !== "string" || !app.codeVersion) process.exit(4);
if (proxied.pid !== direct.pid || proxied.logicVersion !== direct.logicVersion) process.exit(5);
process.stdout.write(`pid=${direct.pid} logicVersion=${direct.logicVersion} startedAt=${direct.startedAt} appPid=${app.pid} appVersion=${app.codeVersion}`);
')
trap - EXIT
printf 'started %s host=%s port=%s appHost=%s appPort=%s baseLog=%s appLog=%s\n' \
  "$proof" "$HOST" "$PORT" "$APP_HOST" "$APP_PORT" "$BASE_LOG" "$APP_LOG"
