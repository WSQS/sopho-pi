// server/ui-settings.mjs —— 我们**自己的** ui 设置侧车（`$ASSIST_HOME/ui-settings.json`）。
//
// 为什么要有它（`docs/design-settings.md` v1）：业主 2026-09-21 回答 `q-fb54adb7` 选了
// 「服务端权威 + 落盘（跟人走：换浏览器/换机器都在）+ 一个配置页」，第一项是**思考折叠的全局默认**。
// 语义（回答 `q-a19e7379`）：**只控制默认**，默认值必须 = 既有行为 `'expanded'`；
// **优先级：显式点击 > 全局默认**（按会话的手动选择仍走前端 localStorage，不搬到服务端）。
//
// 第二项（2026-09-22，业主拍的 ②）：`annotations.notifySession` —— 卡片级反馈的**维护者会话**
//（「指定一个维护者会话作为通知目标」）。同一条线（同一侧车、同一页、同一套校验），
// 取舍与机制见 `docs/design-annotations.md` §8；**留空 = 不通知**（退回 v1.5 现状）。
//
// 第三项（2026-09-23）：`suggestions.enabled` —— 「对话内的推荐回复」的总开关（默认开）。
// 同一条线（同一侧车、同一页、同一套校验），形状与上面两项一致。
//
// 三条硬约束（都不要改）：
//   · **绝不写 pi 自己的 `settings.json`** ✗ —— 那是 pi 的（`hideThinkingBlock` 等）。这是我们的侧车。
//   · 这是**可变**文件（不是 append-only）⇒ 读改写必须原子（temp + fsync + rename，写者由调用方注入，
//     见 `createUiSettingsStore` 的 `writeJson`）；且只有**当前代** worker 有这条路由 ⇒ 单写。
//   · **服务端权威**：`GET /settings` 回的 `settings` 就是**生效值**（默认 ⊕ 已存），
//     前端**不许自己推算**；`PATCH` 的未知 key / 非法值一律诚实 400，绝不静默忽略。

import { readFile } from 'node:fs/promises';

export const UI_SETTINGS_VERSION = 1;
export const UI_SETTINGS_FILE_NAME = 'ui-settings.json';

// 服务端默认值 = 唯一真源。
//  · `thinking.defaultFold`：思考折叠的**全局默认**。默认必须是 'expanded'：它必须**等于既有行为**
//    （`web/render.js` 的 thinking 一直是默认展开），也必须与 pi TUI 对得上（`hideThinkingBlock`
//    默认 false，见 `docs/design-settings.md` §5-⑦ 的引证）。
//  · `annotations.notifySession`：卡片级反馈（标注）的**维护者会话**（业主 2026-09-22 拍的 ②：
//    「指定一个维护者会话作为通知目标」）——新标注到达时通知它（`docs/design-annotations.md` §8）。
//    初始值是业主点名的那条会话的完整 uuid（他的原话：「初始值请设成我这条会话的完整 uuid」）。
//    **可改**（PATCH 这个键）；**留空（''）＝不通知**，退回 v1.5 的现状：维护者自己读文件/端点。
export const UI_SETTINGS_DEFAULTS = Object.freeze({
  'thinking.defaultFold': 'expanded',
  'annotations.notifySession': '01a09d8a-0379-7464-b71e-1602cde9c742',
  // 「压缩即封存」的自动触发（业主 2026-09-22 批的六处默认 ①）：压缩回合落定之后、
  // 且没有任何 runtime 持有它时，自动把该会话的文件裁成「摘要 + kept + tail」、把被裁掉的那一段
  // 另起一个新 id 归档（形状与判据见 `docs/design-session-seal.md`）。默认**开**；关掉只是不再
  // 自动做（显式 POST /sessions/{id}/seal 仍可用）。
  'seal.autoOnCompaction': true,
  // 「对话内的推荐回复」总开关（业主 2026-09-23 拍的那条线）：一个回合**落定之后**另起一次模型调用，
  // 生成「用户下一句可能说什么」的 ≤3 条候选，落在那条助手消息的可选字段 `suggestions` 上并同时发
  // 一帧 SSE `session.suggestions`。
  // 默认**开**：业主的方向是「这一排要能用」（他要的就是每轮都能看见它），代价是一次**不阻塞回合**的
  // 额外模型调用 —— 失败/超时安静放弃、模型给空数组就一排都不出。关掉是一个开关的距离
  // （`suggestions.enabled=false`），且关掉之后**一次模型调用都不发**（门里钉的就是这条）。
  'suggestions.enabled': true,
});

// 每一项的**取值类型**（新增一项就在这里加一行 + 上面的默认值 —— 端点与页面自动跟着走）：
//   · 'enum'       —— 值必须是列出的字符串之一（v1 的思考折叠）；
//   · 'session-id' —— 值必须是**空串**（关掉这条通知）或**完整 uuid**（前缀不收，与 `base-logic.mjs`
//                     的 `requireFullSessionId` 同一条口径）；
//   · 'boolean'    —— 值必须是真布尔（不许拿 'true'/1 冒充：那会让「默认开、可关」变成靠猜）。
// ⚠️ 本模块刻意**不 import 逻辑层**（要能单独测）：那个 uuid 形状在本仓已有三份同形的正则
//（`server/base-logic.mjs` 的 `FULL_UUID`、`server/pool.mjs` 的 `FULL_UUID`），这里第四份的理由就是这条。
const SESSION_ID_VALUE = /^$|^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UI_SETTING_SPECS = Object.freeze({
  'thinking.defaultFold': Object.freeze({ kind: 'enum', values: Object.freeze(['expanded', 'collapsed']) }),
  'annotations.notifySession': Object.freeze({ kind: 'session-id' }),
  'seal.autoOnCompaction': Object.freeze({ kind: 'boolean' }),
  'suggestions.enabled': Object.freeze({ kind: 'boolean' }),
});

/** 一个键的合法取值长什么样（说人话；400 的 message 与页面提示都用它）。 */
function settingValueHint(key) {
  const spec = UI_SETTING_SPECS[key];
  if (!spec) return 'unknown setting';
  if (spec.kind === 'enum') return `one of ${spec.values.join(', ')}`;
  if (spec.kind === 'session-id') return "an empty string (off) or a full session UUID";
  if (spec.kind === 'boolean') return 'a boolean (true or false)';
  return 'unknown value kind';
}

/** 纯函数：校验 + 规整（session id 一律小写存）。不合法 ⇒ `null`（调用方决定说哪种 400）。 */
function normalizeSettingValue(key, value) {
  const spec = UI_SETTING_SPECS[key];
  if (!spec) return null;
  if (spec.kind === 'boolean') return typeof value === 'boolean' ? value : null;
  if (typeof value !== 'string') return null;
  if (spec.kind === 'enum') return spec.values.includes(value) ? value : null;
  if (spec.kind === 'session-id') return SESSION_ID_VALUE.test(value) ? value.toLowerCase() : null;
  return null;
}

export const UI_SETTING_KEYS = Object.freeze(Object.keys(UI_SETTINGS_DEFAULTS));

/** 生效值 = 默认 ⊕ 已存。**只有服务端算这一份**（客户端拿现成的）。 */
export function settingsEffective(stored = {}) {
  return { ...UI_SETTINGS_DEFAULTS, ...stored };
}

/** 端点的响应形状（GET 与 PATCH 回同一形状）：生效值 + 默认值 + 已存值 + 文件出处。 */
export function settingsView({ stored = {}, exists = false, file = null } = {}) {
  return {
    version: UI_SETTINGS_VERSION,
    settings: settingsEffective(stored),
    defaults: { ...UI_SETTINGS_DEFAULTS },
    stored: { ...stored },
    file,
    exists,
  };
}

/** 带 `statusCode` + `toJSON()` 的错误：`server/base-logic.mjs` 的路由末尾 catch 直接照它回执。 */
class UiSettingsError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = 'UiSettingsError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) };
  }
}

/** 客户端给的东西不合法：诚实 400（**在任何写之前**判完 ⇒ 坏输入一个字节都不动文件）。 */
export class UiSettingsPatchError extends UiSettingsError {
  constructor(code, message, details = undefined) {
    super(400, code, message, details);
    this.name = 'UiSettingsPatchError';
  }
}

/** 侧车文件本身坏了 / 版本不认识：诚实 500（不猜、不当作空账 —— 空账会让下一次写把用户的选择抹掉）。 */
export class UiSettingsFileError extends UiSettingsError {
  constructor(file, detail) {
    super(500, 'ui_settings_invalid', `${file} is invalid: ${detail}`, { file, detail });
    this.name = 'UiSettingsFileError';
  }
}

/**
 * 校验一个 PATCH body（`{ key: value }`）。**纯函数**：不碰 IO。
 * 未登记的 key ⇒ `unknown_setting_key`；合法 key 配非法值 ⇒ `invalid_setting_value`。
 * 整批**要么全过、要么全拒**（半批落盘会让「400 时文件逐字节未变」这条门失效）。
 */
export function validateSettingsPatch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new UiSettingsPatchError('invalid_settings_body', 'PATCH /settings body must be a JSON object of { key: value }', { known: UI_SETTING_KEYS });
  }
  const keys = Object.keys(body);
  if (keys.length === 0) {
    throw new UiSettingsPatchError('empty_settings_patch', 'PATCH /settings body must set at least one key', { known: UI_SETTING_KEYS });
  }
  const values = {};
  for (const key of keys) {
    if (!Object.hasOwn(UI_SETTINGS_DEFAULTS, key)) {
      throw new UiSettingsPatchError('unknown_setting_key', `unknown ui setting key: ${JSON.stringify(key)}`, { key, known: UI_SETTING_KEYS });
    }
    const normalized = normalizeSettingValue(key, body[key]);
    if (normalized === null) {
      throw new UiSettingsPatchError('invalid_setting_value', `ui setting ${key} must be ${settingValueHint(key)}: ${JSON.stringify(body[key] ?? null)}`, { key, value: body[key] ?? null, expected: settingValueHint(key) });
    }
    values[key] = normalized;
  }
  return values;
}

/**
 * 侧车仓库。`writeJson(file, value)` 由调用方注入（逻辑层给的是 `base-logic.mjs` 的原子写
 * `atomicWriteJson`：temp + fsync + rename + rename 有界重试）—— 这样「怎么原子写」只有一份，
 * 而本模块只负责**形状、校验与读改写语义**（测试可以注入一个更简单的写者，逻辑不变）。
 */
export function createUiSettingsStore({ file, writeJson }) {
  if (typeof file !== 'string' || file === '') throw new Error('createUiSettingsStore needs a file path');
  if (typeof writeJson !== 'function') throw new Error('createUiSettingsStore needs a writeJson(file, value) writer');

  // 本 worker 内串行：两个 PATCH 同时到，后一个不许拿前一个之前的旧账盖回去（写前会重读）。
  let writeQueue = Promise.resolve();
  function queueWrite(operation) {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** 读已存值（**只**返回文件里真的有的那几项）。文件不存在 ⇒ 空账而不是错。 */
  async function readStored() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, stored: {} };
      throw new UiSettingsFileError(file, `cannot read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const jsonText = text.startsWith('\uFEFF') ? text.slice(1) : text;
    let value;
    try {
      value = JSON.parse(jsonText);
    } catch (error) {
      throw new UiSettingsFileError(file, `not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new UiSettingsFileError(file, 'top level must be an object');
    }
    if (value.version !== UI_SETTINGS_VERSION) {
      throw new UiSettingsFileError(file, `version must be ${UI_SETTINGS_VERSION}: ${JSON.stringify(value.version ?? null)}`);
    }
    const stored = value.values;
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
      throw new UiSettingsFileError(file, 'values must be an object');
    }
    for (const [key, item] of Object.entries(stored)) {
      if (!Object.hasOwn(UI_SETTINGS_DEFAULTS, key)) {
        throw new UiSettingsFileError(file, `values has an unknown key: ${JSON.stringify(key)} (known: ${UI_SETTING_KEYS.join(', ')})`);
      }
      if (normalizeSettingValue(key, item) === null) {
        throw new UiSettingsFileError(file, `values.${key} must be ${settingValueHint(key)}: ${JSON.stringify(item)}`);
      }
    }
    return { exists: true, stored };
  }

  /** GET：生效值（默认 ⊕ 已存）+ 默认值 + 已存值 + 出处。 */
  async function read() {
    const current = await readStored();
    return settingsView({ stored: current.stored, exists: current.exists, file });
  }

  /**
   * PATCH：校验 → 写前重读 → 合并 → 原子写 → 回新的生效值。
   * 校验在**入队之前**做完：坏输入一字节不写，也不占写队列。
   */
  function patch(body) {
    const values = validateSettingsPatch(body);
    return queueWrite(async () => {
      const current = await readStored();
      const stored = { ...current.stored, ...values };
      await writeJson(file, { version: UI_SETTINGS_VERSION, values: stored });
      return settingsView({ stored, exists: true, file });
    });
  }

  return { file, read, patch };
}
