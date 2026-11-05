#!/usr/bin/env bash
# reboot.sh — 重启 sopho-pi 服务器
#
# 两种模式：
#   ./reboot.sh            前台：停 → 起（脱离 shell）→ 轮询确认起来。只能在**服务器进程之外**跑。
#   ./reboot.sh --detach [秒]   排定：起一个脱离进程，N 秒（默认 8）后停+起，然后**立刻返回**。
#                               给调用者留出把最后一条消息落盘的时间。
#
# --detach 是给「服务器里托管的会话（总台）」用的（#37）：
#   它自己就住在服务器里，前台重启等于自杀。所以把重启交给一个**活得比它久**的
#   脱离进程（setsid），然后自己这一轮结束；新服务器起来后 Web UI 重连、会话复活。
#
# ⚠️ 调用 --detach 前**必须自己判断**：除了你自己，没有别的会话在 streaming。
#    否则会把别人正在跑的那一轮 abort 掉。脚本不代劳（它不知道"你是谁"）。
#
# 用法：
#   ./reboot.sh                          # LAN 绑定（默认，同 npm run lan）
#   SOPHO_HOST=127.0.0.1 ./reboot.sh     # 只本机
#   SOPHO_PORT=7322 ./reboot.sh          # 换端口
#   ./reboot.sh --detach                 # 排定重启后立刻返回
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
PORT="${SOPHO_PORT:-7321}"
HOST="${SOPHO_HOST:-0.0.0.0}"
LOG="${SOPHO_REBOOT_LOG:-/tmp/sopho-pi.log}"

# 停 → 睡 delay → 起。整个放进 setsid，脱离调用者（否则停服务器会把执行者一起杀掉）。
schedule() {
	setsid bash -c "sleep ${1:-2}; cd '$ROOT'; npm run stop >/dev/null 2>&1 || true; SOPHO_HOST='$HOST' SOPHO_PORT='$PORT' npm start >>'$LOG' 2>&1" >/dev/null 2>&1 &
}

if [[ "${1:-}" == "--detach" ]]; then
	schedule "${2:-8}"
	echo "已排定重启（$(( ${2:-8} )) 秒后执行，日志 $LOG）。"
	echo "本会话这一轮到此为止；Web UI 重连后会话会复活。"
	exit 0
fi

echo "==> 停（读 pidfile，不用 pkill —— 这个项目里 pkill 不可靠）"
npm run stop || true

echo "==> 起（脱离当前 shell，日志写 $LOG）"
SOPHO_HOST="$HOST" SOPHO_PORT="$PORT" setsid npm start >>"$LOG" 2>&1 &

for _ in $(seq 1 40); do
	sleep 0.5
	if curl -sf "http://127.0.0.1:${PORT}/api/live" >/dev/null 2>&1; then
		echo "==> 起来了： http://127.0.0.1:${PORT}/    日志：$LOG"
		exit 0
	fi
done

echo "==> ⚠️ 20 秒内没起来，看 $LOG" >&2
exit 1
