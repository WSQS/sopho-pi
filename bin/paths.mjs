/**
 * 路径与资产解析 —— 全仓库唯一的路径来源。
 *
 * 两条设计原则：
 *
 * 1. **代码在外，数据在里。** 代码在这个仓库（可进 git、无凭据）；
 *    数据在 `~/.pi/profiles/assistant/`（有凭据、有私人对话，永不进 git）。
 *    本模块是这条分界线的唯一实现点 —— 别处不许出现硬编码路径。
 *
 * 2. **默认值进仓库，覆盖放数据目录。** criteria.md 和 prompt-*.md 既是"行为定义"
 *    （想要 git 历史和 diff）又是"你会经常改的文本"（放仓库里会脏工作树）。
 *    所以：仓库的 `defaults/` 放版本化默认值，数据目录的 `overrides/` 放你的修改。
 *    查找顺序 overrides → defaults。升级不会覆盖你的修改。
 *
 * 环境变量（全部可选，用于测试或换 profile）：
 *   ASSIST_HOME         数据家目录（默认 ~/.pi/profiles/assistant）
 *   ASSIST_LEDGER       账本 JSONL 路径（默认 $HOME/ledger/items.jsonl）
 *   ASSIST_SPECS        方案目录（默认 $HOME/specs）
 *   ASSIST_SESSIONS     会话根目录（默认 $HOME/sessions；只有一个）
 *   ASSIST_OVERRIDES    覆盖目录（默认 $HOME/overrides）
 *   ASSIST_MODELS_JSON  pi 的 models.json（默认 $HOME/models.json）
 *   ASSIST_TRIAGE_BIN   分诊 worker（默认 仓库 bin/triage.mjs）
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 数据家目录。所有可变状态都在它下面。 */
export const HOME = process.env.ASSIST_HOME ?? path.join(os.homedir(), ".pi/profiles/assistant");

export const LEDGER = process.env.ASSIST_LEDGER ?? path.join(HOME, "ledger", "items.jsonl");
/**
 * 会话根 —— **只有一个**：助手 profile 的 sessions 目录。
 *
 * 曾经我这里写过“自动发现多个根”（把 ~/.pi/agent 和别的 profile 也读进来），
 * 目的是把“我这个开发会话”挂进事项里。**那是错的：**
 *
 *   1. 它只为开发者存在 —— 别人都不需要，于是变成永久特例
 *   2. 它把 allowed() 的防护从“单根”退化成“允许列表”
 *   3. 而且它掩盖了真正的做法：**事项的会话就开在助手 profile 里**
 *
 * 我在 ~/.pi/agent 里写的代码 → 产物是**方案文档 + git 提交**，
 * 不是“一条被系统管理的会话”。开发会话不该出现在系统的会话列表里。
 */
export const SESSIONS = process.env.ASSIST_SESSIONS ?? path.join(HOME, "sessions");
export const SPECS = process.env.ASSIST_SPECS ?? path.join(HOME, "specs");
export const OVERRIDES = process.env.ASSIST_OVERRIDES ?? path.join(HOME, "overrides");
export const MODELS_JSON = process.env.ASSIST_MODELS_JSON ?? path.join(HOME, "models.json");

/**
 * 复盘目录（#19）：每天一份报告（`YYYY-MM-DD.md`）落在这里。属数据，不进 git。
 * 与 `specs/` 分开 —— spec 是「一件事怎么定」，retro 是「流程本身哪里卡」。
 */
export const RETRO = process.env.ASSIST_RETRO ?? path.join(HOME, "retro");
/**
 * 复盘账本：每条「建议」一条记录，供采纳跟踪。
 * **刻意与 items.jsonl 分开**（用户 09-12 拍板）—— 复盘的建议不该混进事项列表，
 * 但它又要能被结掉、能被统计「采纳率」，否则流程会腐烂（见 #19 未决问题 8）。
 */
export const RETRO_LEDGER = process.env.ASSIST_RETRO_LEDGER ?? path.join(RETRO, "suggestions.jsonl");

export const DEFAULTS = path.join(REPO_ROOT, "defaults");
export const BIN = path.join(REPO_ROOT, "bin");
export const TRIAGE_BIN = process.env.ASSIST_TRIAGE_BIN ?? path.join(BIN, "triage.mjs");

/**
 * 解析一个政策/提示词文件：overrides 优先，回落 defaults。
 * 返回 null 表示两处都没有（调用方决定是报错还是降级）。
 */
export function readAsset(name) {
	for (const dir of [OVERRIDES, DEFAULTS]) {
		const p = path.join(dir, name);
		try {
			return { path: p, text: fs.readFileSync(p, "utf8"), from: dir === OVERRIDES ? "override" : "default" };
		} catch (err) {
			if (err.code !== "ENOENT") throw err;
		}
	}
	return null;
}

/** 只想要路径时用（比如在帮助文本里显示"判据文件在哪"）。 */
export function assetPath(name) {
	for (const dir of [OVERRIDES, DEFAULTS]) {
		const p = path.join(dir, name);
		if (fs.existsSync(p)) return p;
	}
	return path.join(DEFAULTS, name);
}
