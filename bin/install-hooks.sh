#!/bin/sh
# 安装 sopho-pi 的版本化钩子：把 core.hooksPath 指到仓库内的 bin/hooks。
#
#   bash bin/install-hooks.sh
#   Windows（cmd/PowerShell 里）： "C:\Program Files\Git\bin\bash.exe" bin/install-hooks.sh
#
# 装完的效果：git push 之前自动跑 bin/hooks/pre-push，扫"即将推出去的提交"，
# 命中密钥 / 私钥 / 数据目录快照就中止推送。规则与逃生口见 bin/hooks/pre-push 顶部注释。
# 可重复运行：再跑一遍结果一样（不叠加、不报错）。
#
# v2.2 线：从 v2.1 那条线（tag `v2.1-final`）迁来（docs/feature-parity.md G-06，P0 安全项）。
#   与 v2.1-final 版的差别只有一处方向 —— **不许静默放行**（v2.1-final 版在这三条上都是静默的）：
#     · `git config` 写失败 ⇒ 非 0 退出（v2.1-final 版会照样打印"✔ 已安装"）
#     · 写完读回来的值不是 bin/hooks ⇒ 非 0 退出（同上）
#     · 钩子文件在、却不可执行 ⇒ 明显告警（POSIX 上 git 不会跑不可执行的钩子 = 假闸门）
#   另加两处**提示**（不影响退出码）：
#     · 核一下 git 解析出来的钩子目录里到底有没有 pre-push —— git 对**不存在/空的**
#       hooksPath **静默跳过**，配置看着对、闸却是空的（"假闸门"，见 `v2.1-final:docs/deploy-winbox.md`）
#     · 本仓库有多个 worktree 时说清 core.hooksPath 存在**共享** config 里：每个 worktree
#       各按自己的根解析 bin/hooks，没有那份文件的 worktree 等于没闸
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
	echo "✖ 找不到 $HOOK —— 当前 checkout 里没有这份钩子，本脚本**什么都不改**。" >&2
	echo "   （钩子随 bin/hooks/ 版本化；缺了就是这条分支 / 这个 worktree 还没带上它。" >&2
	echo "     给不存在的钩子设 core.hooksPath 只会得到一道“假闸门”：配置看着对，git 静默跳过。）" >&2
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

# --- 多 worktree 提示（core.hooksPath 是共享 config，各 worktree 各按自己的根解析）---
WT=$(git worktree list --porcelain 2>/dev/null | grep -c '^worktree ')
if [ "${WT:-1}" -gt 1 ]; then
	echo "ℹ️  本仓库有 $WT 个 worktree，而 core.hooksPath 写在**共享** config 里：" >&2
	echo "     每个 worktree 各按自己的根解析 bin/hooks —— 那些 checkout 里没有" >&2
	echo "     bin/hooks/pre-push 的 worktree 就**完全没有闸**（git 对不存在的钩子静默跳过）。" >&2
fi

PREV=$(git config --get core.hooksPath || true)
if [ -n "$PREV" ] && [ "$PREV" != "bin/hooks" ]; then
	echo "ℹ️  core.hooksPath 原为 '$PREV'，现在改成 'bin/hooks'。" >&2
fi

if ! git config core.hooksPath bin/hooks; then
	echo "✖ 写 core.hooksPath 失败（git config 非 0 退出）—— 钩子**没有**装上，不要当成装好了。" >&2
	exit 1
fi

NOW=$(git config --get core.hooksPath || true)
if [ "$NOW" != "bin/hooks" ]; then
	echo "✖ core.hooksPath 写进去后读回来是 '$NOW'（期望 'bin/hooks'）—— 不当作安装成功。" >&2
	exit 1
fi

chmod +x "$HOOK" 2>/dev/null || true
find "$TOP/bin/hooks" -maxdepth 1 -type f -exec chmod +x {} + 2>/dev/null || true
if [ ! -x "$HOOK" ]; then
	echo "⚠️  $HOOK 仍不可执行 —— POSIX 上 git 会**跳过**这个钩子（等于没有闸）。" >&2
	echo "     手工修：chmod +x $HOOK" >&2
fi

# --- 自证：git 解析出来的那个钩子目录里，真有 pre-push 吗 ---
# 用 `git -C "$TOP"` 问：git 在子目录里回的是相对 cwd 的路径（如 ../bin/hooks），
# 那样拼出来的路径是错的（会误报）。从仓库根问，相对路径才就是「相对仓库根」。
RESOLVED=$(git -C "$TOP" rev-parse --git-path hooks 2>/dev/null || true)
case "$RESOLVED" in
"") ;;
/* | [A-Za-z]:*) ;;
*) RESOLVED="$TOP/$RESOLVED" ;;
esac
if [ -n "$RESOLVED" ] && [ ! -f "$RESOLVED/pre-push" ]; then
	echo "⚠️  git 解析出的钩子目录是 $RESOLVED，但那里**没有** pre-push —— 这是“假闸门”：" >&2
	echo "     git 对不存在 / 空的 hooksPath 是**静默跳过**的，push 不会被拦。请核对 core.hooksPath。" >&2
fi

echo "✔ 已安装 pre-push 钩子"
echo "    core.hooksPath = $NOW   （相对路径按 git 规则在仓库根解析）"
echo "    钩子脚本       = $HOOK"
[ -n "$RESOLVED" ] && echo "    git 解析结果   = $RESOLVED   # git 真正会去找 pre-push 的地方"
echo ""
echo "    验证：git config --get core.hooksPath     # 应输出 bin/hooks"
echo "    冒烟：npm run test:prepush                # 临时仓库 + 假远端，不碰真 remote"
echo "    逃生口：git push --no-verify  /  SOPHO_PREPUSH_ALLOW=1 git push"
