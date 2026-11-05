#!/usr/bin/env bash
# 把某个模型设成「默认模型」——**幂等**：备份 → models.json 里补上条目（缺了才建，已有只补缺项/只改
# 你显式给的字段）→ settings.json 里设 defaultProvider/defaultModel/enabledModels → 打 diff 摘要。
#
# 为什么需要它（坑表「defaultModel 不在 models[] 里 = 静默回落」有完整证据）：
#   pi 的 `findInitialModel`（dist/core/model-resolver.js:502）第 3 步要求
#   `modelRuntime.getModel(defaultProvider, defaultModelId)` **找得到**。找不到就往下走：
#   第 4 步先按 `defaultModelPerProvider[provider]` 找，而那里**没有 litellm 这个键**，
#   于是落到 `availableModels[0]` = **该 provider models[] 里的第一个模型**。
#   ⇒ 只改 settings.json 的 defaultModel、却没在 provider 的 models[] 里登记它时，pi **不报错**、
#     静默用回第一个模型（两台机器上的默认模型不同，例如一台是 …-luna、另一台是 …-sol）。表面完全看不出来 ——
#     只有会话文件里那句 model_change（和 assistant 消息的 model 字段）会露馅。
#   所以「改默认模型」= **两处一起改**，这就是本脚本存在的原因。
#
# 用法（默认就是本机 assistant profile 的 litellm/autorouter）：
#   bash bin/set-default-model.sh                  # 改（幂等，跑多少次都一样）
#   bash bin/set-default-model.sh --dry-run        # 只看会改什么，不落盘
#   bash bin/set-default-model.sh --model deepseek-flash   # 回滚默认模型（只动 settings，不动已有条目）
#   bash bin/set-default-model.sh --cost-input 4 --cost-output 20   # 显式改条目的 cost（其它字段保持不动）
#   bash bin/set-default-model.sh --cost-copy gpt-5.6-sol   # 改成「按 sol 的费率记」（整套照抄，含 tiers）
#   ASSIST_HOME=/other/home bash bin/set-default-model.sh
# 选项：--models PATH · --settings PATH · --provider ID · --model ID · --name NAME
#       --context-window N · --max-tokens N · --cost-input/--cost-output/--cost-cache-read/--cost-cache-write R
#       --cost-copy MODEL_ID（照抄同 provider 另一条条目的**整套** cost，连 tiers 一起；要「按 sol 记」就用它）
#       --no-backup · --dry-run · -h/--help
#
# ⚠️ 落盘 = `JSON.stringify(…, 2)` 重写整个文件：**语义等价**，但手工排版的缩进/数组换行会变成标准形状
#    （第一次跑会看到几处与本次改动无关的 diff —— 是排版，不是内容）。
#
# ⚠️ 配置对**新建会话**生效，**不需要重启 A**：pi 的 runtime 是每个会话建一次
#    （server/base.mjs 的 factory → createAgentSessionServices），每次都重读 models.json / settings.json。
#    已在池里的老会话不受影响（它那个 runtime 早建好了）。
set -euo pipefail

PROVIDER="litellm"
MODEL="autorouter"
MODELS=""
SETTINGS=""
BACKUP=1
DRY=0
# 条目**不存在**时用它建；条目已存在时**一律不动**（除非你在命令行显式给了对应字段）。
NAME_DEFAULT="Auto Router (复杂度路由；cost≈默认层)"
CTX_DEFAULT=922000
MAXTOK_DEFAULT=128000
# cost 是**近似**：autorouter 的真实成本随它路由到哪一层变。见下面 --help 的取舍说明。
COST_IN_DEFAULT=0.3
COST_OUT_DEFAULT=1.2
COST_CCR_DEFAULT=0.006
COST_CCW_DEFAULT=0
# 显式覆盖（空 = 没给，别动）
OV_NAME=""; OV_CTX=""; OV_MAXTOK=""; OV_CI=""; OV_CO=""; OV_CCR=""; OV_CCW=""; OV_COPY=""

usage() {
	# 打印文件开头那段注释（到 `set -euo pipefail` 为止），不用行号 —— 以后改注释不会漏一段。
	awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
	cat <<'EOF'

cost 的取舍（为什么默认按 deepseek-flash 的费率记）
  据 litellm /model/info：autorouter = 复杂度路由 —— SIMPLE/MEDIUM→deepseek-flash、COMPLEX→gpt-5.6-sol、
  REASONING→gpt-6-astra，默认层 deepseek-flash。
  pi 显示的会话成本 = **这个 cost × 实际 token**（openai-responses 那层算的），所以填谁的费率就是按谁报价。
  同一句话可能被路由到任何一层 ⇒ **没有一个数字是对的**，只能选一个**不误导**的：
    · 默认层 deepseek-flash（本脚本的默认）：多数轮次落在这一层；对 COMPLEX/REASONING 会**低估**
      —— 输入价 sol 13.3×（4 vs 0.3）、astra 33×（10 vs 0.3）；输出价 sol 16.7×（20 vs 1.2）、astra 41.7×（50 vs 1.2）。
    · 按最贵层 astra 记：对多数轮次**高估** 33×。
  两种都错，按默认层记至少不掩盖「简单任务便宜」，也和「默认模型 = 默认层」的直觉一致。
  要知道真实花费只能看 litellm 侧的账。cost 只影响**显示**（与缓存浪费统计），pi 里没有任何按 cost 拦截的闸。

（条目已存在时本脚本**只**补缺项 + 只改你显式给的字段 —— 所以 `--model deepseek-flash` 回滚不会
 把 deepseek-flash 那条现成的定义改花。）
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
	--models) MODELS="${2:?--models 要一个路径}"; shift 2 ;;
	--settings) SETTINGS="${2:?--settings 要一个路径}"; shift 2 ;;
	--provider) PROVIDER="${2:?}"; shift 2 ;;
	--model) MODEL="${2:?}"; shift 2 ;;
	--name) OV_NAME="${2:?}"; shift 2 ;;
	--context-window) OV_CTX="${2:?}"; shift 2 ;;
	--max-tokens) OV_MAXTOK="${2:?}"; shift 2 ;;
	--cost-input) OV_CI="${2:?}"; shift 2 ;;
	--cost-output) OV_CO="${2:?}"; shift 2 ;;
	--cost-cache-read) OV_CCR="${2:?}"; shift 2 ;;
	--cost-cache-write) OV_CCW="${2:?}"; shift 2 ;;
	--cost-copy) OV_COPY="${2:?--cost-copy 要一个同 provider 的模型 id}"; shift 2 ;;
	--no-backup) BACKUP=0; shift ;;
	--dry-run) DRY=1; shift ;;
	-h | --help) usage; exit 0 ;;
	*) echo "✗ 不认识的参数：$1（-h 看用法）" >&2; exit 2 ;;
	esac
done

H="${ASSIST_HOME:-$HOME/.pi/profiles/assistant}"
[ -n "$MODELS" ] || MODELS="$H/models.json"
[ -n "$SETTINGS" ] || SETTINGS="$H/settings.json"

# pi 的 runtime 读的就是这两个文件（server/base.mjs: AGENT_DIR = $SOPHO_AGENT_DIR ?? $ASSIST_HOME）。
[ -f "$MODELS" ] || { echo "✗ 没有这个文件：$MODELS" >&2; exit 1; }
[ -f "$SETTINGS" ] || { echo "✗ 没有这个文件：$SETTINGS" >&2; exit 1; }

# models.json 常常是**符号链接**（本机 assistant profile 链到 ~/.pi/agent/models.json）：
# ① 备份必须**解引用**（cp -a 会把链接本身拷成备份 ⇒ 那种备份毫无意义）；
# ② 写要写**真身**，别在链接路径上做替换。
REAL_MODELS="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$MODELS")"
REAL_SETTINGS="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$SETTINGS")"
# 「是不是符号链接」问 fs.lstat，**别拿字符串比** —— Windows/Git Bash 下 realpath 会把
# `C:\Users\me/.pi/x` 规范化成 `C:\Users\me\.pi\x`，那句提醒会变成假阳性。
IS_LINK() { node -e 'const fs=require("fs");try{process.stdout.write(String(fs.lstatSync(process.argv[1]).isSymbolicLink()))}catch{process.stdout.write("false")}' "$1"; }
printf 'models   : %s%s\n' "$REAL_MODELS" "$([ "$(IS_LINK "$MODELS")" = "true" ] && printf '   （%s 是符号链接 → 真身在上面）' "$MODELS" || true)"
printf 'settings : %s%s\n' "$REAL_SETTINGS" "$([ "$(IS_LINK "$SETTINGS")" = "true" ] && printf '   （%s 是符号链接 → 真身在上面）' "$SETTINGS" || true)"

TS="$(date +%Y%m%d-%H%M%S)"
# 用 node 算 hash（Windows/Git Bash 上 coreutils 不一定齐；node 是 pi 的硬前提，一定有）
HASH() { node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex").slice(0,16))' "$1"; }

# ── 1) 算出「会改成什么」——先看清了再落盘（同一条规则也用在写那一步）────────────────
PLAN="$(SETDM_MODELS="$REAL_MODELS" SETDM_SETTINGS="$REAL_SETTINGS" \
	SETDM_PROVIDER="$PROVIDER" SETDM_MODEL="$MODEL" \
	SETDM_NAME_D="$NAME_DEFAULT" SETDM_CTX_D="$CTX_DEFAULT" SETDM_MAXTOK_D="$MAXTOK_DEFAULT" \
	SETDM_CI_D="$COST_IN_DEFAULT" SETDM_CO_D="$COST_OUT_DEFAULT" \
	SETDM_CCR_D="$COST_CCR_DEFAULT" SETDM_CCW_D="$COST_CCW_DEFAULT" \
	SETDM_OV_NAME="$OV_NAME" SETDM_OV_CTX="$OV_CTX" SETDM_OV_MAXTOK="$OV_MAXTOK" \
	SETDM_OV_CI="$OV_CI" SETDM_OV_CO="$OV_CO" SETDM_OV_CCR="$OV_CCR" SETDM_OV_CCW="$OV_CCW" SETDM_OV_COPY="$OV_COPY" \
	node -e "$(sed -n '/^\/\/ <<<CORE>>>$/,/^\/\/ >>>CORE<<<$/p' "$0" | sed '1d;$d')")"

if [ "$(printf '%s' "$PLAN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){console.log("ERR 计划不是 JSON");return}console.log(j.err?("ERR "+j.err):"OK")})')" != "OK" ]; then
	printf '%s\n' "$PLAN" >&2
	exit 1
fi

CHANGED="$(printf '%s' "$PLAN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.entryChanged||j.settingsChanged?"1":"0")})')"
printf '\n── 计划 ──────────────────────────────────\n'
printf '%s' "$PLAN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
console.log(j.entryExisted?"models[]: 条目已存在（顺序不动）":"models[]: 条目不存在 → 新增到末尾（回落取的是**第一个**，所以别插到前面）");
if(j.entryExisted&&!j.entryChanged)console.log("  条目内容：不动（没缺项，也没给显式字段）");
if(j.entryChanged)console.log("  条目改动："+JSON.stringify(j.changedKeys)+" → "+JSON.stringify(j.wantEntry.cost)+" cost / name="+JSON.stringify(j.wantEntry.name)+" ctx="+j.wantEntry.contextWindow+" maxTokens="+j.wantEntry.maxTokens+" reasoning="+j.wantEntry.reasoning);
if(j.costCopyFrom)console.log("  （cost 整套照抄自 "+j.costCopyFrom+"，含 tiers）");
if(j.tiersDropped)console.log("  （原有 cost.tiers 被删掉：显式给费率 = 按这一套算法，不留抄来的分段）");
console.log("  models[] 顺序："+JSON.stringify(j.idsBefore)+" → "+JSON.stringify(j.idsAfter));
console.log(j.settingsChanged?"settings: defaultProvider/defaultModel/enabledModels → "+JSON.stringify(j.wantSettings):"settings: 已是目标值，不动。");
if(j.entryChanged||j.settingsChanged)console.log("（落盘是 JSON.stringify(…, 2) 重写整个文件 —— 没改的条目也可能被重新排版：缩进、数组换行会变；内容不变）");});'

if [ "$CHANGED" = "0" ]; then
	printf '\n✓ 没有任何要改的（幂等：再跑一次还是这样；连备份都不新建）\n'
	exit 0
fi
if [ "$DRY" = "1" ]; then
	printf '\n（--dry-run：什么也没写）\n'
	exit 0
fi

# ── 2) 备份（**改前**；解引用；备份与改前逐字节核过）────────────────────────────
if [ "$BACKUP" = "1" ]; then
	echo
	echo "── 备份（改前；cp -L 解引用）──────────────────"
	for f in "$REAL_MODELS" "$REAL_SETTINGS"; do
		b="$f.bak-$TS"
		cp -L "$f" "$b"
		if [ "$(HASH "$f")" != "$(HASH "$b")" ]; then
			echo "✗ 备份和改前的文件不一致（$b）—— 什么都不改，先查清为什么" >&2
			exit 1
		fi
		printf '  %s\n    → %s  %s bytes  sha256=%s ✓\n' "$f" "$b" "$(wc -c <"$b" | tr -d ' ')" "$(HASH "$b")"
	done
fi

# ── 3) 落盘（原子写：同目录写临时文件再 rename）──────────────────────────────
SETDM_MODELS="$REAL_MODELS" SETDM_SETTINGS="$REAL_SETTINGS" \
	SETDM_PROVIDER="$PROVIDER" SETDM_MODEL="$MODEL" \
	SETDM_NAME_D="$NAME_DEFAULT" SETDM_CTX_D="$CTX_DEFAULT" SETDM_MAXTOK_D="$MAXTOK_DEFAULT" \
	SETDM_CI_D="$COST_IN_DEFAULT" SETDM_CO_D="$COST_OUT_DEFAULT" \
	SETDM_CCR_D="$COST_CCR_DEFAULT" SETDM_CCW_D="$COST_CCW_DEFAULT" \
	SETDM_OV_NAME="$OV_NAME" SETDM_OV_CTX="$OV_CTX" SETDM_OV_MAXTOK="$OV_MAXTOK" \
	SETDM_OV_CI="$OV_CI" SETDM_OV_CO="$OV_CO" SETDM_OV_CCR="$OV_CCR" SETDM_OV_CCW="$OV_CCW" SETDM_OV_COPY="$OV_COPY" \
	SETDM_WRITE=1 \
	node -e "$(sed -n '/^\/\/ <<<CORE>>>$/,/^\/\/ >>>CORE<<<$/p' "$0" | sed '1d;$d')"

# ── 4) 复读回验（不是「写完了」，是「读回来是不是目标值」）────────────────────────
SETDM_MODELS="$REAL_MODELS" SETDM_SETTINGS="$REAL_SETTINGS" SETDM_PROVIDER="$PROVIDER" SETDM_MODEL="$MODEL" \
	node -e '
const fs = require("fs"); const E = process.env; const fail = [];
const cfg = JSON.parse(fs.readFileSync(E.SETDM_MODELS, "utf8"));
const st = JSON.parse(fs.readFileSync(E.SETDM_SETTINGS, "utf8"));
const prov = cfg.providers?.[E.SETDM_PROVIDER];
const list = prov?.models ?? [];
const hit = list.find((m) => m && m.id === E.SETDM_MODEL);
if (!hit) fail.push(`models.json 里读不到 ${E.SETDM_PROVIDER}/${E.SETDM_MODEL}`);
else {
  for (const k of ["name", "reasoning", "input", "contextWindow", "maxTokens", "cost"]) if (hit[k] === undefined) fail.push(`条目缺 ${k}`);
  if (hit.api !== undefined) fail.push("条目上写了 api —— 应该继承 provider 的 api，别在这里再写一遍");
}
if (st.defaultModel !== E.SETDM_MODEL) fail.push(`settings.defaultModel = ${st.defaultModel}`);
if (st.defaultProvider !== E.SETDM_PROVIDER) fail.push(`settings.defaultProvider = ${st.defaultProvider}`);
if (!Array.isArray(st.enabledModels) || !st.enabledModels.includes(`${E.SETDM_PROVIDER}/*`)) fail.push("settings.enabledModels 里没有该 provider 的 * 通配");
if (fail.length) { console.error("✗ 复读回验没过：" + fail.join("；")); process.exit(1); }
console.log(`✓ 复读回验：${E.SETDM_PROVIDER}/${E.SETDM_MODEL} 在 models[] 里（contextWindow ${hit.contextWindow} / maxTokens ${hit.maxTokens} / reasoning ${hit.reasoning}）；settings.defaultModel=${st.defaultModel}、defaultProvider=${st.defaultProvider}、enabledModels=${JSON.stringify(st.enabledModels)}`);
console.log(`  provider 的 api=${prov.api} → 条目**不写** api，继承它（responses 这条路不改）`);
console.log(`  models[] 顺序 = ${JSON.stringify(list.map((m) => m.id))}  ← 万一 defaultModel 又不在里面，pi 回落到**第一个**`);
'
echo
echo "✓ 完事。配置**对新建会话**生效（不必重启 A）；老会话不受影响。"
echo "  验：建一条真探针会话，看它会话文件里 model_change 的 modelId 是不是 $MODEL。"

# 下面这一段是被上面两次 `node -e` 抠出来执行的**同一份**核心逻辑（只算/只写，不打印）——
# 目的：避免「先看计划」与「真落盘」变成两份会漂移的实现（同一条规则必须只写一遍）。
# 用 `: <<'SETDM_CORE_JS'` 把它包成 here-doc：bash **不解析**里面的 JS（`bash -n` 也照样过），
# 只是把它当一段没有用的输入文本。
exit 0
: <<'SETDM_CORE_JS'
// <<<CORE>>>
const fs = require("fs");
const E = process.env;
const num = (s) => Number(s);
const ov = {};
if (E.SETDM_OV_NAME !== "") ov.name = E.SETDM_OV_NAME;
if (E.SETDM_OV_CTX !== "") ov.contextWindow = num(E.SETDM_OV_CTX);
if (E.SETDM_OV_MAXTOK !== "") ov.maxTokens = num(E.SETDM_OV_MAXTOK);
const costOv = {};
if (E.SETDM_OV_CI !== "") costOv.input = num(E.SETDM_OV_CI);
if (E.SETDM_OV_CO !== "") costOv.output = num(E.SETDM_OV_CO);
if (E.SETDM_OV_CCR !== "") costOv.cacheRead = num(E.SETDM_OV_CCR);
if (E.SETDM_OV_CCW !== "") costOv.cacheWrite = num(E.SETDM_OV_CCW);
// --cost-copy：照抄同 provider 另一条条目的**整套** cost（连 tiers 一起）—— 这是「按 sol 记」的正确写法。
const costCopyFrom = E.SETDM_OV_COPY || "";
// 新条目（或已有条目缺 cost）用的默认形状：照现有那批 —— id/name/reasoning/input/contextWindow/maxTokens/cost。
// ⚠️ **不写 api / baseUrl**：provider 上已经写了（api:"openai-responses"），模型条目继承它；
//    在这里再写一遍 = 以后改 provider 会漏改这一处。
const fresh = {
  id: E.SETDM_MODEL,
  name: E.SETDM_NAME_D,
  reasoning: true,
  input: ["text", "image"],
  contextWindow: num(E.SETDM_CTX_D),
  maxTokens: num(E.SETDM_MAXTOK_D),
  cost: { input: num(E.SETDM_CI_D), output: num(E.SETDM_CO_D), cacheRead: num(E.SETDM_CCR_D), cacheWrite: num(E.SETDM_CCW_D) },
};
const cfg = JSON.parse(fs.readFileSync(E.SETDM_MODELS, "utf8"));
const st = JSON.parse(fs.readFileSync(E.SETDM_SETTINGS, "utf8"));
const prov = cfg?.providers?.[E.SETDM_PROVIDER];
if (!prov) {
  console.log(JSON.stringify({ err: `models.json 里没有 provider「${E.SETDM_PROVIDER}」` }));
  process.exit(0);
}
const list = Array.isArray(prov.models) ? prov.models : (prov.models = []);
const idsBefore = list.map((m) => m.id);
const i = list.findIndex((m) => m && m.id === E.SETDM_MODEL);
const before = i >= 0 ? JSON.parse(JSON.stringify(list[i])) : null;
// 已有的条目：**只补缺项 + 只改显式给的字段**（回滚场景不能把现成定义改花）。
let entry = i >= 0 ? { ...list[i] } : { ...fresh };
for (const k of ["name", "reasoning", "input", "contextWindow", "maxTokens"]) if (entry[k] === undefined) entry[k] = fresh[k];
if (entry.cost === undefined) entry.cost = { ...fresh.cost };
Object.assign(entry, ov);
if (costCopyFrom) {
  const src = list.find((m) => m && m.id === costCopyFrom);
  if (!src || !src.cost) {
    console.log(JSON.stringify({ err: `--cost-copy：同 provider 里找不到带 cost 的「${costCopyFrom}」（可选：${list.map((m) => m.id).join(", ")}）` }));
    process.exit(0);
  }
  entry.cost = JSON.parse(JSON.stringify(src.cost));
} else if (Object.keys(costOv).length) {
  // 显式给了费率 = 就按这一套记：**把继承来的 tiers 删掉**（否则会拿别人抄来的分段费率继续算）。
  const base = { ...entry.cost };
  delete base.tiers;
  entry.cost = { ...base, ...costOv };
}
const entryChanged = JSON.stringify(entry) !== JSON.stringify(before);
const changedKeys = [];
if (i >= 0 && before) {
  for (const k of Object.keys(entry)) if (JSON.stringify(entry[k]) !== JSON.stringify(before[k])) changedKeys.push(k);
} else {
  changedKeys.push(...Object.keys(entry));
}
if (entryChanged) { if (i >= 0) list[i] = entry; else list.push(entry); }
const wantSettings = { defaultProvider: E.SETDM_PROVIDER, defaultModel: E.SETDM_MODEL, enabledModels: [`${E.SETDM_PROVIDER}/*`] };
const settingsChanged = Object.keys(wantSettings).some((k) => JSON.stringify(st[k]) !== JSON.stringify(wantSettings[k]));
if (E.SETDM_WRITE === "1") {
  const write = (p, obj) => { const t = p + ".tmp-setdm"; fs.writeFileSync(t, JSON.stringify(obj, null, 2) + "\n"); fs.renameSync(t, p); };
  Object.assign(st, wantSettings);
  write(E.SETDM_MODELS, cfg);
  write(E.SETDM_SETTINGS, st);
  process.exit(0);
}
console.log(JSON.stringify({ entryExisted: i >= 0, entryChanged, changedKeys, settingsChanged, wantSettings, wantEntry: entry, costCopyFrom: costCopyFrom || null, tiersDropped: !costCopyFrom && Object.keys(costOv).length > 0 && !!(before?.cost?.tiers), idsBefore, idsAfter: list.map((m) => m.id) }, null, 1));
// >>>CORE<<<
SETDM_CORE_JS
