#!/bin/sh
# 安装 sopho-pi 的版本化钩子：把 core.hooksPath 指到仓库内的 bin/hooks。
#
#   bash bin/install-hooks.sh
#
# 装完的效果：git push 之前自动跑 bin/hooks/pre-push，扫"即将推出去的提交"，
# 命中密钥 / 私钥 / 数据目录快照就中止推送。逃生口见 bin/hooks/pre-push 顶部注释。
#
# 注意：core.hooksPath 一旦设置，git 会**完全忽略** .git/hooks/ 目录。
#       所以本脚本会先检查 .git/hooks/ 里有没有非 .sample 的钩子 —— 有的话
#       那些钩子会被静默顶掉，脚本会点名警告（请自行迁移进 bin/hooks/）。
set -u

if ! git rev-parse --git-dir >/dev/null 2>&1; then
	echo "✖ 当前目录不在 git 仓库里，无法安装钩子。" >&2
	exit 1
fi

TOP=$(git rev-parse --show-toplevel)
HOOK="$TOP/bin/hooks/pre-push"

if [ ! -f "$HOOK" ]; then
	echo "✖ 找不到 $HOOK —— 请从仓库根目录运行本脚本。" >&2
	exit 1
fi

# --- 会被顶掉的既有钩子？先查清、再动手 ---
GITDIR=$(git rev-parse --absolute-git-dir 2>/dev/null || git rev-parse --git-dir)
EXTRA=""
if [ -d "$GITDIR/hooks" ]; then
	EXTRA=$(find "$GITDIR/hooks" -maxdepth 1 -type f ! -name '*.sample' 2>/dev/null)
fi
if [ -n "$EXTRA" ]; then
	echo "⚠️  $GITDIR/hooks 里有非 .sample 的钩子，设置 core.hooksPath 后会**静默失效**：" >&2
	printf '%s\n' "$EXTRA" | while IFS= read -r h; do
		echo "     - $h" >&2
	done
	echo "    （请把它们迁进 bin/hooks/ 再重装，否则那些检查就没了）" >&2
fi

PREV=$(git config --get core.hooksPath || true)
if [ -n "$PREV" ] && [ "$PREV" != "bin/hooks" ]; then
	echo "ℹ️  core.hooksPath 原为 '$PREV'，现在改成 'bin/hooks'。" >&2
fi

git config core.hooksPath bin/hooks

chmod +x "$HOOK" 2>/dev/null || true
find "$TOP/bin/hooks" -maxdepth 1 -type f -exec chmod +x {} + 2>/dev/null || true

echo "✔ 已安装 pre-push 钩子"
echo "    core.hooksPath = $(git config --get core.hooksPath)"
echo "    钩子脚本       = $HOOK"
echo ""
echo "    验证：git config --get core.hooksPath     # 应输出 bin/hooks"
echo "    逃生口：git push --no-verify  /  SOPHO_PREPUSH_ALLOW=1 git push"
