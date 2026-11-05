#!/usr/bin/env bash
# 让「会话基底的逻辑」改动生效 —— 热重载，**不重启 A、不丢任何会话**。
#
# 改 server/base-logic.mjs 之后跑这个。
# 改 server/base.mjs（宿主）才需要 bin/restart-base.sh。
#
# 为什么不直接重启 A：A 是会话的家，重启 = 把所有会话的 runtime 全扔掉
# （文件还在，但正在跑的轮次会断；如果发命令的会话自己住在 A 里，那就是自杀）。
set -euo pipefail
AP="${SOPHO_BASE_PORT:-7331}"
OUT="$(curl -s --max-time 15 -X POST "http://127.0.0.1:$AP/reload-code" -w '\n%{http_code}' || true)"
CODE="$(printf '%s' "$OUT" | tail -1)"
BODY="$(printf '%s' "$OUT" | sed '$d')"

case "$CODE" in
200)
	echo "✓ 逻辑已热重载（会话一个没动）：$BODY"
	;;
404)
	echo "⚠️ 这个 A 还没有热重载能力 —— 它跑的是旧代码，这一次只能重启：" >&2
	echo "     bin/restart-base.sh        # 从终端跑，别在会话里跑" >&2
	echo "   重启之后就再也不用重启了，以后都用本脚本。" >&2
	exit 1
	;;
500)
	echo "✗ 逻辑没重载（写坏了？）：$BODY" >&2
	echo "   修好 server/base-logic.mjs 再跑一次。A 本身没事 —— 它会继续用上一版逻辑。" >&2
	exit 1
	;;
*)
	echo "✗ 连不上会话基底 http://127.0.0.1:$AP （HTTP $CODE）$BODY" >&2
	exit 1
	;;
esac
