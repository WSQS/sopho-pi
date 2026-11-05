#!/usr/bin/env bash
# 起 v2 的两个进程：A（会话基底，默认 7331）+ B（对外 UI，默认 7321）。
#
# 只能在**服务器进程之外**跑（终端）。在会话里跑 = 把自己住的服务器弄乱。
# 停：bash bin/stop.sh（读 pidfile）
set -euo pipefail
. "$(dirname "$0")/port-pid.sh" # pidfile 怎么写才准（见那个文件）；在 cd 之前 source，$0 是相对路径时也找得到
cd "$(dirname "$0")/.." # 仓库根

H="${ASSIST_HOME:-$HOME/.pi/profiles/assistant}"
AP="${SOPHO_BASE_PORT:-7331}"
BP="${SOPHO_PORT:-7321}"
BH="${SOPHO_BASE_URL:-http://127.0.0.1:$AP}"

# 只想确认「会起什么」而不动进程：SOPHO_DRY_RUN=1 npm run serve
#
# 对外绑定地址**默认 0.0.0.0**（面向 LAN：手机 / 别的机器直接就能开）。
# ⚠️ 这个 UI 零认证：谁能连上它，谁就能在这台机器上执行任意命令。
#    只在你能控制的网络里这么用；想只开本机就 SOPHO_HOST=127.0.0.1。
HOST="${SOPHO_HOST:-0.0.0.0}"
if [ "${SOPHO_DRY_RUN:-0}" = "1" ]; then
	echo "==> [dry-run] 会起 A 会话基底  127.0.0.1:$AP  sessions=$H  → pidfile /tmp/sopho-pi-$AP.pid"
	echo "==> [dry-run] 会起 B 应用层    $HOST:$BP  → pidfile /tmp/sopho-pi-$BP.pid"
	echo "==> [dry-run] 什么都没起（SOPHO_DRY_RUN=1）"
	exit 0
fi

mkdir -p "$H/sessions"

# 这两个根可选：调用方设了就显式透传（paths.json 是运行时配置的后备）。
BASE_ENV=("ASSIST_HOME=$H" "SOPHO_AGENT_DIR=${SOPHO_AGENT_DIR:-$H}" "SOPHO_BASE_PORT=$AP")
[[ ${SOPHO_PAGE_ROOT+x} ]] && BASE_ENV+=("SOPHO_PAGE_ROOT=$SOPHO_PAGE_ROOT")
[[ ${SOPHO_EPUB_ROOT+x} ]] && BASE_ENV+=("SOPHO_EPUB_ROOT=$SOPHO_EPUB_ROOT")

echo "==> A 会话基底  127.0.0.1:$AP   sessions=$H/sessions"
env "${BASE_ENV[@]}" setsid node server/base.mjs >/tmp/sopho-base.log 2>&1 &

sleep 2
# pidfile 取**监听端口的那个人**（不是 `$!`：setsid 会 fork，见 bin/port-pid.sh）
write_pidfile "$AP" server/base.mjs

echo "==> B 应用层    $HOST:$BP（零认证：能连上它就能在这台机器上跑任意命令）"
SOPHO_BASE_URL="$BH" SOPHO_PORT="$BP" SOPHO_HOST="$HOST" \
	setsid node server/app.mjs >/tmp/sopho-app.log 2>&1 &

sleep 2
write_pidfile "$BP" server/app.mjs

sleep 2
if curl -sf "http://127.0.0.1:$BP/api/tree" >/dev/null 2>&1; then
	echo "==> 起来了： http://localhost:$BP/    日志：/tmp/sopho-base.log · /tmp/sopho-app.log"
else
	echo "==> ⚠️ 没起来，看 /tmp/sopho-base.log  /tmp/sopho-app.log" >&2
	exit 1
fi
