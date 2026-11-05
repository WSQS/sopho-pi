#!/usr/bin/env bash
# 重启会话基底 A。
#
# ⚠️ 三条规矩：
#   1. **不要从会话里跑这个** —— 如果发命令的会话自己就住在 A 里，这就是自杀。
#      从终端跑，或先确认 /live 里没有你自己。
#   2. 只想让插件改动生效 → 不用重启：curl -X POST localhost:7331/reload
#   3. 只有改了 server/base.mjs 才需要重启 A。
#
# 有会话正在跑（streaming）时拒绝重启，除非 --force。
set -euo pipefail
. "$(dirname "$0")/port-pid.sh" # pid 怎么取、怎么核对（见那个文件）；在 cd 之前 source
AP="${SOPHO_BASE_PORT:-7331}"
H="${ASSIST_HOME:-$HOME/.pi/profiles/assistant}"
URL="http://127.0.0.1:$AP"

# 只想确认「会干什么」而不真重启：SOPHO_DRY_RUN=1 npm run restart
# （重启 A 是有代价的 —— 会把所有会话的 runtime 重写一遍，所以先能看一眼很值。）
if [ "${SOPHO_DRY_RUN:-0}" = "1" ]; then
	echo "==> [dry-run] 会先查 $URL/live；有会话 streaming 就拒绝（除非 --force）"
	echo "==> [dry-run] 会 kill 监听 $AP 的进程，然后用 ASSIST_HOME=$H 起 node server/base.mjs"
	echo "==> [dry-run] 什么都没动（SOPHO_DRY_RUN=1）"
	exit 0
fi

LIVE="$(curl -s --max-time 3 "$URL/live" || echo '{}')"
RUNNING="$(printf '%s' "$LIVE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.hot??[]).filter(h=>h.streaming).length)}catch{console.log(0)}})')"
if [ "$RUNNING" != "0" ] && [ "${1:-}" != "--force" ]; then
	echo "⚠️ 有 $RUNNING 个会话正在跑（streaming），重启会打断它们。硬来加 --force。" >&2
	exit 1
fi

PID="$(port_pid "$AP")"
if [ -n "${PID:-}" ]; then
	# kill 之前核对 cmdline：端口上坐的**必须**是我们那个 A（pid 会被系统复用，误杀不可逆）
	if is_our_node "$PID" server/base.mjs; then
		kill "$PID" && echo "已停旧 A (pid $PID)"
		sleep 1
	else
		echo "⚠️ 端口 $AP 被 pid $PID 占着，但它不是我们的 A（cmdline 里没有 server/base.mjs）—— 一个信号都没发。" >&2
		echo "   自己处理端口冲突：ss -ltnp | grep :$AP" >&2
		exit 1
	fi
fi

cd "$(dirname "$0")/.."
ASSIST_HOME="$H" SOPHO_AGENT_DIR="${SOPHO_AGENT_DIR:-$H}" SOPHO_BASE_PORT="$AP" \
	setsid node server/base.mjs >/tmp/sopho-base.log 2>&1 &
sleep 2

if curl -s --max-time 3 "$URL/live" >/dev/null; then
	echo "A 已起 → $URL（日志 /tmp/sopho-base.log）"
else
	echo "A 没起来，看 /tmp/sopho-base.log" >&2
	exit 1
fi

# ── pidfile：`npm run stop` 靠它（以前这里**没写** → 新 A 配的还是旧 pidfile 里那个**死 pid**，
#   于是 npm run stop 停不掉 A。pid 取**监听端口的那个人**＋核对 cmdline，不拿 `$!`）──
write_pidfile "$AP" server/base.mjs
