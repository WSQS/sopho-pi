#!/usr/bin/env bash
# 停 v2 的两个进程。读 pidfile（这个项目里 pkill 不可靠 —— 会连自己一起杀），
# 并**核对 /proc/<pid>/cmdline**：pid 会被系统复用，死 pid 万一被复用了，不核对就会打到无关进程。
# 核对不过 → 一个信号都不发（宁可不停，也不误杀）；pidfile 该清就清（它本来就过期了）。
set -euo pipefail
. "$(dirname "$0")/port-pid.sh" # port_pid / is_our_node（写和停共用同一条核对规则）

AP="${SOPHO_BASE_PORT:-7331}"
BP="${SOPHO_PORT:-7321}"
for pair in "$BP:server/app.mjs" "$AP:server/base.mjs"; do
	port="${pair%%:*}"
	script="${pair##*:}"
	f="/tmp/sopho-pi-$port.pid"
	if [ ! -f "$f" ]; then
		echo "跳过端口 $port：没有 pidfile（$f）"
		continue
	fi
	pid="$(cat "$f" 2>/dev/null || true)"
	if is_our_node "$pid" "$script"; then
		kill "$pid" 2>/dev/null || true
		echo "已停止 pid $pid（端口 $port，$script）"
	elif [ -n "$pid" ]; then
		echo "跳过端口 $port：pidfile 里的 pid $pid 不是我们的 $script（cmdline 对不上，可能已被复用）—— 一个信号都没发"
	else
		echo "跳过端口 $port：pidfile 是空的"
	fi
	rm -f "$f"
done
echo "（pidfile 已清掉。进程真没了没：ss -ltnp | grep -E \":$BP |:$AP \"）"
