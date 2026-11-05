#!/usr/bin/env bash
# sopho-pi —— **沙箱实例**（起一份绝不可能碰到主实例的 A+B，给以后所有验证用）
#
# 真身是 **bin/dev-serve.ps1**（Windows）。为什么本文件不自己实现一遍，为什么它是 Windows-only：
#
#   · 本仓的 .sh 依赖 `ss`（从端口反查监听者）、`setsid`（fork 出真进程）、
#     `/proc/<pid>/cmdline`（核对 pid 是不是我们那个 node）—— **MSYS / Git Bash 里这三样都没有**。
#     bin/serve-win.ps1 存在的全部理由就是这件事，本脚本照抄那条既定做法，不假装能用。
#   · 「主树 node_modules 那个坑」本身也只有 Windows 语法：`mklink /J` 建 junction、`cmd rmdir` 摘。
#     在 Linux 上对应的是软链接（`ln -s`，删了无害），不构成同一个陷阱。
#   · 所以：**逻辑只写一份（dev-serve.ps1）**，本文件只做两件事 ——
#       在 Windows 上把调用**转交**过去；在别处明确报错 + 指路。
#     写一份在本机跑不起来的 bash 实现 = 半吊子（而且没法验），宁可当指路牌。
#
# 用法（Windows / MSYS 下等价于 npm run serve:dev）：
#   bash bin/dev-serve.sh            # 起沙箱
#   bash bin/dev-serve.sh --stop     # 停沙箱
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PS1="$HERE/dev-serve.ps1"

STOP=""
case "${1:-}" in
--stop | -Stop | -stop | stop) STOP="-Stop" ;;
"") ;;
*)
	echo "dev-serve.sh: 认不得的参数 '$1'（只有 --stop）。参数（端口 / home / host）请用环境变量，见脚本头。" >&2
	exit 2
	;;
esac

# ── Windows（MSYS / Git Bash / Cygwin）→ 转交给 ps1；不在这里假装自己能起 ──
case "$(uname -s 2>/dev/null || echo unknown)" in
MINGW* | MSYS* | CYGWIN*)
	for ps in pwsh powershell; do
		if command -v "$ps" >/dev/null 2>&1; then
			echo "==> 本仓的 .sh 依赖 ss/setsid//proc，MSYS 里没有 → 转交 Windows 实现：bin/dev-serve.ps1 $STOP"
			exec "$ps" -NoProfile -ExecutionPolicy Bypass -File "$PS1" ${STOP:+"$STOP"}
		fi
	done
	echo "✗ 这里看着是 MSYS/Git Bash，但 PATH 里既没有 pwsh 也没有 powershell。" >&2
	echo "  沙箱实例的实现在 bin/dev-serve.ps1（Windows）；请从 Windows 终端跑：" >&2
	echo "      npm run serve:dev     /     npm run stop:dev" >&2
	exit 1
	;;
esac

# ── 真正的 Linux / macOS：明确说「没有这一版」，并给出一条等价的手工路径 ──
if ! command -v ss >/dev/null 2>&1 || ! command -v setsid >/dev/null 2>&1 || [ ! -r /proc/self/cmdline ]; then
	echo "✗ 这台机器上 ss / setsid / /proc 不全 —— bin/serve.sh 那套也跑不起来，先补依赖。" >&2
	exit 1
fi
cat >&2 <<'EOF'
✗ 沙箱实例目前**只有 Windows 版**（bin/dev-serve.ps1）：它编码的两个坑（mklink /J 建 junction、
  cmd rmdir 摘链接，绝不用 rm -rf）是 Windows 特有的，本平台上没有等价物。
  非 Windows 上请直接用 bin/serve.sh 的三件环境变量（这就是沙箱的全部内容），注意别碰主实例端口：

    ASSIST_HOME="$TMPDIR/sopho-dev-$$" \
    SOPHO_BASE_PORT=7433 SOPHO_PORT=7423 SOPHO_HOST=127.0.0.1 \
      bash bin/serve.sh
    # 停：先记下 pidfile，再按 pidfile 精确停 —— 绝不用 pkill
    #   /tmp/sopho-pi-7433.pid · /tmp/sopho-pi-7423.pid
    #   端口 7331（主 A）/ 7321（主 B）/ 7322 一律不许用，也不许让别人"自动换口"

  注意：Linux 版**没有**上面那几条硬护栏（拒绝主实例端口 / 拒绝真 profile），靠你自己守住。
EOF
exit 1
