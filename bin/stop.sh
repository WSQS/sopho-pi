#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
BASE="$ROOT/server/base.mjs"
APP="$ROOT/server/app.mjs"
# 默认端口必须与 bin/serve.sh 的默认值成对，否则裸 `npm run stop` 停不到裸 `npm run serve` 起的那一对。
# 本机（arcsopho）线上实例：A=7331、B=7321。显式传入的环境变量优先。
PORT=${SOPHO_PORT:-7331}
APP_PORT=${SOPHO_APP_PORT:-7321}

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

listener_pid() {
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

wait_stopped() {
  local label=$1 selected_port=$2 pid=$3 current
  [[ -n "$pid" ]] || return 0
  for _ in $(seq 1 100); do
    current=$(listener_pid "$selected_port") || return 1
    if [[ -z "$current" ]]; then
      echo "$label stopped pid=$pid port=$selected_port"
      return 0
    fi
    if [[ "$current" != "$pid" ]]; then
      echo "pid $pid stopped, but port $selected_port is now owned by pid $current" >&2
      return 1
    fi
    sleep 0.05
  done
  echo "timed out waiting for pid $pid to release port $selected_port" >&2
  return 1
}

app_pid=$(listener_pid "$APP_PORT") || exit 1
base_pid=$(listener_pid "$PORT") || exit 1

if [[ -n "$app_pid" ]] && ! is_our_process "$app_pid" "$APP"; then
  echo "refusing to stop pid $app_pid: port $APP_PORT owner cmdline is not $APP" >&2
  exit 1
fi
if [[ -n "$base_pid" ]] && ! is_our_process "$base_pid" "$BASE"; then
  echo "refusing to stop pid $base_pid: port $PORT owner cmdline is not $BASE" >&2
  exit 1
fi
if [[ -z "$app_pid" && -z "$base_pid" ]]; then
  echo "nothing listening on ports $PORT and $APP_PORT"
  exit 0
fi

# Identity is verified above, so a failing kill almost certainly means the process already
# exited; ignore that so a race cannot leave one of the two processes running.
[[ -z "$app_pid" ]] || kill -TERM "$app_pid" 2>/dev/null || true
[[ -z "$base_pid" ]] || kill -TERM "$base_pid" 2>/dev/null || true
status=0
wait_stopped B "$APP_PORT" "$app_pid" || status=1
wait_stopped A "$PORT" "$base_pid" || status=1
exit "$status"
