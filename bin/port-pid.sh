#!/usr/bin/env bash
# 共用小工具：**按端口**找 pid，并核对「这个 pid 确实是我们的那个 node server/…mjs」。
# 被 bin/serve.sh / bin/restart-base.sh（写 pidfile）与 bin/stop.sh（读 pidfile 去 kill）共用。
#
# 为什么值得单独一个文件：pidfile 的价值**全在准确**上（`npm run stop` 靠它，而 kill 不可逆）。
#   · **写**的时候不能拿 `$!` —— 起进程用的是 `setsid node …`，setsid 在当进程组长时会 **fork**，
#     于是 `$!` 可能是那个马上退出的包装进程。**监听这个端口的那个人**才是真的 → 从 `ss` 取。
#     踩过：pidfile 里躺着早退出的死 pid（320849），`npm run stop` 停不掉 A。
#   · **停**的时候 kill 之前必须核对 `/proc/<pid>/cmdline` —— **pid 会被系统复用**，
#     不核对就可能打到无关进程。核对不过就一个信号都不发（宁可不停，也不误杀）。
#
# 用法：`. "$(dirname "$0")/port-pid.sh"` 之后
#   port_pid 7331                        → 监听该端口的 pid（空 = 没人监听）
#   is_our_node 386964 server/base.mjs   → 那个 pid 的 cmdline 里有没有这个脚本
#   write_pidfile 7331 server/base.mjs   → 把监听者写进 /tmp/sopho-pi-7331.pid（核对不过就不写）

port_pid() {
	local port="$1"
	# ss 的输出形如：LISTEN … 127.0.0.1:7331 … users:(("node-MainThread",pid=386964,fd=21))
	ss -ltnp 2>/dev/null | grep ":$port " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true
}

is_our_node() {
	local pid="$1" script="$2"
	[ -n "$pid" ] || return 1
	[ -r "/proc/$pid/cmdline" ] || return 1 # 没有这个进程（死 pid）→ 不是
	tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q -- "$script"
}

write_pidfile() {
	local port="$1" script="$2" f="/tmp/sopho-pi-$1.pid" pid
	pid="$(port_pid "$port")"
	if is_our_node "$pid" "$script"; then
		echo "$pid" >"$f"
		echo "pidfile /tmp/sopho-pi-$port.pid → $pid（$script）"
		return 0
	fi
	# 拿不到就**不写**：宁可没有 pidfile（stop.sh 跳过它），也不写一个错的 pid 进去。
	echo "⚠️ 端口 $port 上没有「$script」的监听进程 → **没写** pidfile /tmp/sopho-pi-$port.pid" >&2
	echo "   手动核对：ss -ltnp | grep :$port" >&2
	return 1
}
