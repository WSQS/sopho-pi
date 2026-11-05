#!/usr/bin/env node
// check-defs-refs —— 定义/引用差集自查门（业主 2026-09-21 批准的两条「门纪律」之二）。
//
// 为什么要有这道门：两类硬错误**只在跑到那一行时才炸**，`node --check` 只查语法、照样放行 ✗。
//   ① 「定义消失、引用还在」：`NOTIFY_QUIET_MS` 的定义被误删（b7336d8 一起删掉了一整块），
//      而 4 处引用还在 ⇒ 走通知/委派那条路的请求变 500（人肉二分两轮才定位，修复 `0162fca`）。
//   ② 「被调用、但全仓从未声明」：`finishFailedProxy` 的调用点先落地（b7336d8）、声明一直没补
//      ⇒ 兜底 proxy 那条路一撞必 `ReferenceError`（审 diff 时漏掉；修复 `a87eb6b`）。
//
// 两道检查，都**只读**、都按「文件:行 + 标识符名」报出：
//   · 半 1（差集）：同一份文件在 base 与工作树之间，**顶层定义集合**少了哪些名字；
//     少掉的名字若在工作树里**仍有引用** ⇒ 红。
//   · 半 2（调用未定义）：全仓扫「裸标识符调用」`name(`，若这个名字**全仓找不到任何声明**
//     （也不是 import 绑定、不在语言/运行时全局白名单里）⇒ 红。
//
// 为什么它不会天天误报（写在这里，免得后人以为它吵就关掉它）：
//   · 半 1 只看**顶层**定义（第 0 列开始、且不在注释/字符串里的声明）——`if (x) { const y = … }`
//     这类块内绑定不算「定义」，它们的作用域出不了那一块，删掉它们本来就不该跨块引用；
//   · 半 1 只把「base 有、工作树没有、而且工作树里仍有裸引用」判红 —— 正常重命名会把引用一起改掉，
//     于是差集里的名字**不再有引用**，天然放行；
//   · 半 2 的「声明」集合取**全仓最宽口径**（任何位置的 function/class/const/let/var/import 绑定 /
//     形参 / catch 形参 / for-of 绑定）——宁可漏报（某个同名的形参把真错误挡住）也不误报；
//   · 半 2 的排除项**显式列在白名单里**（见 GLOBAL_WHITELIST，每一类写明为什么合法），宁可先窄。
//
// 已知的**不做**（诚实边界，别把它当完整语义分析）：
//   · 模板字符串 `${…}` 内部的代码被整段当作字符串屏蔽 ⇒ 那里的调用/引用看不见（漏报方向，不误报）；
//   · 正则字面量按启发式识别（`/` 前一个有效字符决定除法还是正则），极端写法可能判错；
//   · 只认裸标识符调用：`obj.member(...)` 一律不查（那需要类型推断，本门不做）；
//   · 不做作用域分析（半 2 用全仓并集当声明集），所以「局部变量名恰好全仓别处有定义」会漏报。
//
// 跑法：
//   node bin/check-defs-refs.mjs                     # 工作树 vs 默认 base（见 resolveDefaultBase）
//   node bin/check-defs-refs.mjs --base origin/master
//   node bin/check-defs-refs.mjs --json
//   node test/defs-refs-gate.mjs                     # 门（自证有牙 + 真树必须绿）
//   npm run test:defsrefs                            # =上一条
//
// ⚠️ 校准红态的做法（后人最容易踩的一步）：要把本文件**拷进**那个红态 worktree 再跑，
//   例如 `cp bin/check-defs-refs.mjs /tmp/calib/bin/ && node /tmp/calib/bin/check-defs-refs.mjs`。
//   原因：本文件的仓库根是**按自身文件位置**定的（`defaultRoot = resolve(dirname(thisFile), '..')`），
//   在任意 cwd 里跑它（比如 `cd /tmp/calib && node <主树>/bin/check-defs-refs.mjs`）时，它扫的仍是
//   **它自己那棵树** ⇒ 得到假绿 ✗（本件作者与派单方都踩了一次）。另一条等价办法：设
//   `SOPHO_DEFSREFS_ROOT=/tmp/calib`（CLI 会用它当根），或者直接调 `check({ root })`。
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const defaultRoot = path.resolve(here, '..');

// 只扫本仓自己的 JS/TS 源码。node_modules 与 .git 是外来/元数据，不进检查。
// `web/vendor/` 是第三方发行包（highlight.min.js / marked.min.js 等）：本仓不修它们的内部调用，
// 且压缩产物里的单字母名几乎全是局部函数 —— 扫它们只会把白名单撑成噪声源。
export const SCAN_DIRS = ['server', 'web', 'bin', 'test', 'pi-extensions'];
const SCAN_SKIP = new Set(['web/vendor']);
const SOURCE_EXT = new Set(['.mjs', '.js', '.cjs', '.ts']);

// 半 2 的排除项：**显式列**，每一类写明为什么这一类的裸调用不需要本仓声明。
// ⚠️ 只放「语言内建 / JS 运行时全局 / 本仓测试基座确实提供的全局」，别拿它掩盖真错误。
export const GLOBAL_WHITELIST = new Map(Object.entries({
  // —— ECMAScript 语言内建（值构造/转换，任何 JS 环境里都有）——
  'Array': 'ES 内建构造器', 'Object': 'ES 内建构造器', 'Number': 'ES 内建构造器', 'String': 'ES 内建构造器',
  'Boolean': 'ES 内建构造器', 'BigInt': 'ES 内建构造器', 'Symbol': 'ES 内建构造器', 'Date': 'ES 内建构造器',
  'RegExp': 'ES 内建构造器', 'Promise': 'ES 内建构造器', 'Map': 'ES 内建构造器', 'Set': 'ES 内建构造器',
  'WeakMap': 'ES 内建构造器', 'WeakSet': 'ES 内建构造器', 'Error': 'ES 内建构造器', 'TypeError': 'ES 内建构造器',
  'RangeError': 'ES 内建构造器', 'SyntaxError': 'ES 内建构造器', 'ReferenceError': 'ES 内建构造器',
  'EvalError': 'ES 内建构造器', 'URIError': 'ES 内建构造器', 'AggregateError': 'ES 内建构造器',
  'Uint8Array': 'ES 内建类型化数组', 'Uint16Array': 'ES 内建类型化数组', 'Uint32Array': 'ES 内建类型化数组',
  'Int8Array': 'ES 内建类型化数组', 'Int16Array': 'ES 内建类型化数组', 'Int32Array': 'ES 内建类型化数组',
  'Float32Array': 'ES 内建类型化数组', 'Float64Array': 'ES 内建类型化数组', 'BigInt64Array': 'ES 内建类型化数组',
  'BigUint64Array': 'ES 内建类型化数组', 'ArrayBuffer': 'ES 内建', 'DataView': 'ES 内建', 'Atomics': 'ES 内建',
  'parseInt': 'ES 内建全局函数', 'parseFloat': 'ES 内建全局函数', 'isNaN': 'ES 内建全局函数',
  'isFinite': 'ES 内建全局函数', 'encodeURIComponent': 'ES 内建全局函数', 'decodeURIComponent': 'ES 内建全局函数',
  'encodeURI': 'ES 内建全局函数', 'decodeURI': 'ES 内建全局函数', 'eval': 'ES 内建全局函数',
  // —— Node.js 宿主全局 ——
  'setTimeout': 'Node 全局计时器', 'setInterval': 'Node 全局计时器', 'clearTimeout': 'Node 全局计时器',
  'clearInterval': 'Node 全局计时器', 'setImmediate': 'Node 全局计时器', 'clearImmediate': 'Node 全局计时器',
  'queueMicrotask': 'Node 全局微任务', 'structuredClone': 'Node 全局（v17+）', 'fetch': 'Node 全局（v18+ undici）',
  'require': 'CommonJS 全局（.cjs / conditionally）', 'Buffer': 'Node 全局', 'URL': 'Node/WHATWG 全局',
  'URLSearchParams': 'Node/WHATWG 全局', 'TextEncoder': 'Node/WHATWG 全局', 'TextDecoder': 'Node/WHATWG 全局',
  'AbortController': 'Node/WHATWG 全局', 'AbortSignal': 'Node/WHATWG 全局', 'Event': 'Node/WHATWG 全局',
  'EventTarget': 'Node/WHATWG 全局', 'MessageChannel': 'Node/WHATWG 全局', 'MessagePort': 'Node/WHATWG 全局',
  // —— 浏览器 / DOM 全局（web/ 下的前端脚本与真 Chromium 门里使用）——
  'document': '浏览器全局', 'window': '浏览器全局', 'navigator': '浏览器全局', 'location': '浏览器全局',
  'getComputedStyle': '浏览器全局', 'requestAnimationFrame': '浏览器全局', 'cancelAnimationFrame': '浏览器全局',
  'requestIdleCallback': '浏览器全局', 'cancelIdleCallback': '浏览器全局',
  'HTMLElement': '浏览器全局', 'CustomEvent': '浏览器全局', 'MutationObserver': '浏览器全局',
  'ResizeObserver': '浏览器全局', 'IntersectionObserver': '浏览器全局', 'localStorage': '浏览器全局',
  'matchMedia': '浏览器全局', 'alert': '浏览器全局', 'Image': '浏览器全局', 'Blob': '浏览器全局',
  'FileReader': '浏览器全局', 'DOMParser': '浏览器全局', 'XMLHttpRequest': '浏览器全局',
  'EventSource': '浏览器全局（SSE）', 'WebSocket': '浏览器全局', 'performance': '浏览器/Node 全局',
  'crypto': '浏览器/Node 全局', 'atob': '浏览器/Node 全局', 'btoa': '浏览器/Node 全局',
  // —— 本仓测试基座提供的全局（`pi-extensions/assistant/index.ts` 由 pi 宿主注入 `pi`）——
  'pi': 'pi 扩展宿主注入的全局对象（扩展脚本不在本仓里 import）',
}));

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'delete', 'void',
  'in', 'of', 'do', 'else', 'class', 'await', 'yield', 'case', 'default', 'throw', 'with', 'super',
  'import', 'export', 'try', 'finally', 'break', 'continue', 'const', 'let', 'var', 'instanceof',
  'this', 'get', 'set', 'static', 'async', 'extends', 'null', 'true', 'false', 'undefined',
]);

const CAN_START_REGEX_AFTER = '([{,;:=!&|?+-*%~^<>';
const REGEX_KEYWORDS = /\b(?:return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await|throw)$/;

/**
 * 把源码里「不是代码」的部分（注释 / 字符串 / 模板 / 正则字面量）换成空格，保留换行与长度。
 * 返回与之等长的字符串：行号、列号都还能直接对回原文。
 *
 * 模板字符串要**正确嵌套**：`\`…${ JSON.stringify({ x: \`…\` }) }…\`` 这种内外都有反引号
 * 的写法在真实代码里很常见（首次实现就在 `test/host-session-path-probe.mjs` 上翻车）。
 * 所以用一个 context 栈：template 帧里的文本一律屏蔽，`${` 推入 interp 帧，interp 里按 {} 配平，
 * 配平到 0 的 `}` 回到 template 帧。
 */
export function sanitize(source) {
  const cached = sanitizeCache.get(source);
  if (cached !== undefined) return cached;
  const result = sanitizeUncached(source);
  if (sanitizeCache.size >= SANITIZE_CACHE_MAX) sanitizeCache.delete(sanitizeCache.keys().next().value);
  sanitizeCache.set(source, result);
  return result;
}

// 同一份源码在一次 check() 里会被 sanitize 好几遗（定义集 / 声明集 / 调用 / 引用 / import）——
// 不缓存的话大文件上会是几秒级。键是源码字符串，命中靠 V8 已缓存的字符串 hash。
const sanitizeCache = new Map();
const SANITIZE_CACHE_MAX = 512;

function sanitizeUncached(source) {
  const size = source.length;
  const out = source.split('');
  const blank = (from, to) => { for (let k = from; k < to && k < size; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  let index = 0;
  let previous = '';
  let previousWord = '';
  const regexAllowed = () => {
    if (previous === '') return true;
    if (CAN_START_REGEX_AFTER.includes(previous)) return true;
    return REGEX_KEYWORDS.test(previousWord);
  };
  const noteCode = (char) => {
    if (/\s/.test(char)) return;
    previous = char;
    if (/[A-Za-z_$]/.test(char)) previousWord = `${previousWord}${char}`.slice(-16);
    else previousWord = '';
  };
  const stack = [{ kind: 'code', brace: 0 }];
  const top = () => stack[stack.length - 1];
  while (index < size) {
    const char = source[index];
    if (top().kind === 'template') {
      if (char === '\\') { blank(index, index + 2); index += 2; continue; }
      if (char === '`') { blank(index, index + 1); stack.pop(); index += 1; previous = '`'; previousWord = ''; continue; }
      if (char === '$' && source[index + 1] === '{') { blank(index, index + 2); stack.push({ kind: 'interp', brace: 0 }); index += 2; previous = '{'; previousWord = ''; continue; }
      blank(index, index + 1); index += 1; continue;
    }
    // code / interp context
    if (char === '}') {
      const frame = top();
      if (frame.kind === 'interp' && frame.brace === 0) {
        blank(index, index + 1); stack.pop(); index += 1; previous = '}'; previousWord = ''; continue;
      }
      if (frame.kind === 'interp') frame.brace -= 1;
      noteCode(char); index += 1; continue;
    }
    if (char === '{') {
      const frame = top();
      if (frame.kind === 'interp') frame.brace += 1;
      noteCode(char); index += 1; continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      let end = index; while (end < size && source[end] !== '\n') end += 1;
      blank(index, end); index = end; continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      let end = index + 2; while (end < size && !(source[end] === '*' && source[end + 1] === '/')) end += 1;
      end = Math.min(size, end + 2); blank(index, end); index = end; continue;
    }
    if (char === '/' && regexAllowed()) {
      let end = index + 1; let inClass = false;
      while (end < size) {
        const inner = source[end];
        if (inner === '\\') { end += 2; continue; }
        if (inner === '\n') break;
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) { end += 1; break; }
        end += 1;
      }
      blank(index, end); index = end; previous = ')'; previousWord = ''; continue;
    }
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < size) {
        const inner = source[end];
        if (inner === '\\') { end += 2; continue; }
        if (inner === char) { end += 1; break; }
        if (inner === '\n') break;
        end += 1;
      }
      blank(index, end); index = end; previous = '"'; previousWord = ''; continue;
    }
    if (char === '`') { stack.push({ kind: 'template' }); blank(index, index + 1); index += 1; previous = '`'; previousWord = ''; continue; }
    noteCode(char);
    index += 1;
  }
  return out.join('');
}

/** 行号表：offset → 1 起的行号。 */
function lineOf(source, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) if (source[index] === '\n') line += 1;
  return line;
}

const DECLARATION_PATTERNS = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
];

/** 按顶层分隔符切开（跳过 ()[]{} 嵌套；输入已 sanitize 过，字符串/注释已是空格）。 */
function splitTopLevel(text, separator = ',') {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === separator && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/** 去掉绑定模式里的默认值（顶层 `=`；不把 `==`/`=>`/`>=` 当赋值）。 */
function stripDefault(text) {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === '=' && depth === 0) {
      const before = text[index - 1] ?? '';
      const after = text[index + 1] ?? '';
      if (!'=!<>'.includes(before) && after !== '>' && after !== '=') return text.slice(0, index);
    }
  }
  return text;
}

/** 把一个绑定模式（标识符 / `{a, b: c, ...d}` / `[a, b]` / 带默认值 / TS 类型注解）里的本地名收集出来。 */
function parsePattern(text, names) {
  let pattern = stripDefault(text).trim();
  if (pattern.startsWith('...')) pattern = pattern.slice(3).trim();
  if (!pattern) return;
  if (pattern.startsWith('{') || pattern.startsWith('[')) {
    const inner = pattern.slice(1, pattern.endsWith('}') || pattern.endsWith(']') ? -1 : undefined);
    for (const part of splitTopLevel(inner)) {
      if (!part.trim()) continue;
      const colon = splitRename(part);
      parsePattern(colon.value ?? colon.key, names);
    }
    return;
  }
  const match = pattern.match(/^([A-Za-z_$][\w$]*)/);
  if (match && !KEYWORDS.has(match[1])) names.push(match[1]);
}

/** `a: b`（对象解构重命名 / TS 类型注解）→ `{ key:'a', value:'b' }`；没有冒号时 value 为 null。 */
function splitRename(part) {
  const chunks = splitTopLevel(part, ':');
  if (chunks.length < 2) return { key: part, value: null };
  let depth = 0;
  for (let index = 0; index < part.length; index += 1) {
    const char = part[index];
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ':' && depth === 0) return { key: part.slice(0, index), value: part.slice(index + 1) };
  }
  return { key: part, value: null };
}

/** 一条声明 / 形参列表里的多个绑定名（顶层逗号分隔；解构与重命名都算）。 */
function bindingNames(text) {
  const names = [];
  for (const part of splitTopLevel(text)) parsePattern(part, names);
  return names;
}

/** 顶层（第 0 列、代码区）定义集合：name → 行号。 */
export function topLevelDefs(source) {
  const clean = sanitize(source);
  const lines = clean.split('\n');
  const defs = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || /\s/.test(line[0])) continue; // 只认第 0 列的声明
    const importMatch = line.match(/^import\s+(.+?)\s+from\s|^import\s+([\w$]+)\s*=/);
    if (importMatch) {
      const clause = importMatch[1] ?? importMatch[2] ?? '';
      const asMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (asMatch) defs.set(asMatch[1], index + 1);
      const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)/);
      if (defaultMatch) defs.set(defaultMatch[1], index + 1);
      const named = clause.match(/\{([^}]*)\}/);
      if (named) {
        for (const part of named[1].split(',')) {
          const piece = part.trim();
          if (!piece) continue;
          const pair = piece.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
          if (pair) defs.set(pair[2] ?? pair[1], index + 1);
        }
      }
      continue;
    }
    for (const pattern of DECLARATION_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;
      defs.set(match[1], index + 1);
      break;
    }
    // `const { a, b } = …` / `const [a, b] = …` / `const a = 1, b = 2`
    const declarator = line.match(/^(?:export\s+)?(?:const|let|var)\s+(.+)$/);
    if (declarator && /[{}[],]/.test(declarator[1])) {
      const head = declarator[1].replace(/\s*=\s*[\s\S]*$/, '');
      for (const name of bindingNames(head)) if (/^[A-Za-z_$][\w$]*$/.test(name)) defs.set(name, index + 1);
    }
  }
  return defs;
}

/** 平衡扫描：返回所有「后面紧跟 `=>` 或 `{` 的括号组」的内容（形参列表）。 */
function paramLists(code) {
  const lists = [];
  const CONTROL = new Set(['if', 'for', 'while', 'switch', 'with']);
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] !== '(') continue;
    // ⚠️ 只看前面一小段（不能 `code.slice(0, index)`：那在 base-logic.mjs 这种大文件上是 O(n²)，
    // 实测把一次扫描拖到 49 s）。
    const before = code.slice(Math.max(0, index - 32), index);
    const lastWord = (before.match(/([A-Za-z_$][\w$]*)\s*$/) ?? [])[1];
    if (CONTROL.has(lastWord)) continue;
    let depth = 0;
    let close = -1;
    for (let cursor = index; cursor < code.length; cursor += 1) {
      if (code[cursor] === '(') depth += 1;
      else if (code[cursor] === ')') { depth -= 1; if (depth === 0) { close = cursor; break; } }
    }
    if (close === -1) continue;
    const after = code.slice(close + 1).match(/^\s*(=>|\{)/);
    if (!after) continue;
    lists.push(code.slice(index + 1, close));
    index = close;
  }
  return lists;
}

/** 从 `const`/`let`/`var` 关键字后扫出一个声明的头部（到 `;` / 行尾 / 不配平的右括号为止）。 */
function declarationHead(code, start) {
  let depth = 0;
  let end = start;
  for (; end < code.length; end += 1) {
    const char = code[end];
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) {
      if (depth === 0) break; // 不配平的右括号：`for (const x of y)` 这种
      depth -= 1;
    } else if (depth === 0 && (char === ';' || char === '\n')) break;
  }
  return code.slice(start, end);
}

/** 全仓最宽口径的「已声明名字」集合（半 2 用它，宁可漏报也不误报）。 */
export function declaredNames(source) {
  const clean = sanitize(source);
  const names = new Set();
  const add = (name) => { if (name && !KEYWORDS.has(name)) names.add(name); };
  for (const match of clean.matchAll(/(?<![\w$.])function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) add(match[1]);
  for (const match of clean.matchAll(/(?<![\w$.])class\s+([A-Za-z_$][\w$]*)/g)) add(match[1]);
  for (const match of clean.matchAll(/(?<![\w$.])(?:const|let|var)\s+/g)) {
    for (const name of bindingNames(declarationHead(clean, match.index + match[0].length))) add(name);
  }
  // 形参：平衡扫描每个 `( … )`，后面紧跟 `=>` 或 `{` 的当作函数/方法/箭头/catch 的形参列表。
  // （不能用 `\(([^()]*)\)`：真实签名里嵌套括号很常见，例如 `{ onChoose = () => {} } = {}`。）
  for (const params of paramLists(clean)) for (const name of bindingNames(params)) add(name);
  // 不带括号的箭头形参：`x => …`
  for (const match of clean.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) add(match[1]);
  // import 绑定
  for (const match of clean.matchAll(/(?<![\w$])import\s+([\s\S]*?)\s+from\s/g)) {
    const clause = match[1];
    const asMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (asMatch) add(asMatch[1]);
    const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (defaultMatch) add(defaultMatch[1]);
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const pair = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (pair) add(pair[2] ?? pair[1]);
      }
    }
  }
  return names;
}

/** 裸标识符调用：`name(` 且前面不是 `.`/标识符字符，且不是函数/类声明、不是方法定义。 */
export function bareCalls(source) {
  const clean = sanitize(source);
  const calls = [];
  const pattern = /(?<![\w$.#])([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of clean.matchAll(pattern)) {
    const name = match[1];
    if (KEYWORDS.has(name)) continue;
    const before = clean.slice(Math.max(0, match.index - 24), match.index);
    const lastWord = (before.match(/([A-Za-z_$][\w$]*)\s*$/) ?? [])[1];
    if (lastWord === 'function' || lastWord === 'class' || lastWord === 'import') continue;
    // 方法定义 / 函数体：`)` 之后紧跟 `{` ⇒ 不是调用。
    const open = match.index + match[0].length - 1;
    let depth = 0; let close = -1;
    for (let index = open; index < clean.length; index += 1) {
      if (clean[index] === '(') depth += 1;
      else if (clean[index] === ')') { depth -= 1; if (depth === 0) { close = index; break; } }
    }
    if (close === -1) continue; // 括号不配平（多半是屏蔽造成），跳过
    const after = clean.slice(close + 1).match(/^\s*([^\s])/);
    if (after && after[1] === '{') continue;
    calls.push({ name, offset: match.index });
  }
  return calls;
}

/** 裸引用（含属性简写、赋值等），用于半 1 判断「被删的定义是否还有引用」。 */
export function referencesOf(source, name) {
  const clean = sanitize(source);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\w$.#])${escaped}(?![\\w$])`, 'g');
  const hits = [];
  for (const match of clean.matchAll(pattern)) hits.push({ offset: match.index, line: lineOf(clean, match.index) });
  return hits;
}

/** 走一遍 scan dirs，返回 `{ relative, text }` 列表。 */
export async function readSources(root) {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const full = path.join(root, dir);
    const info = await stat(full).catch(() => null);
    if (!info?.isDirectory()) continue;
    for await (const relative of walk(full)) {
      if (!SOURCE_EXT.has(path.extname(relative))) continue;
      const normalized = path.relative(root, relative).split(path.sep).join('/');
      if ([...SCAN_SKIP].some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) continue;
      files.push({ relative: normalized, text: await readFile(relative, 'utf8') });
    }
  }
  files.sort((left, right) => (left.relative < right.relative ? -1 : 1));
  return files;
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/** 半 2：在工作树这份 sources 上找「被调用但全仓无声明」的标识符。 */
export function scanUndeclaredCalls(files) {
  const declared = new Set();
  for (const file of files) for (const name of declaredNames(file.text)) declared.add(name);
  const violations = [];
  for (const file of files) {
    const clean = sanitize(file.text);
    for (const call of bareCalls(file.text)) {
      if (declared.has(call.name)) continue;
      if (GLOBAL_WHITELIST.has(call.name)) continue;
      violations.push({ file: file.relative, line: lineOf(clean, call.offset), name: call.name, kind: 'undeclared_call' });
    }
  }
  return violations;
}

/**
 * 半 1：base（git rev）与工作树之间，顶层定义被删掉、但工作树里仍有引用 ⇒ 违规。
 * `base` 为 null 时不检查（只跑半 2）。
 */
export function scanRemovedDefs({ root, files, base, gitShow }) {
  if (!base) return [];
  const changed = listChangedFiles(root, base, gitShow);
  const byRelative = new Map(files.map((file) => [file.relative, file.text]));
  const importersByFile = importerNames(files);
  const violations = [];
  for (const relative of changed) {
    if (!SOURCE_EXT.has(path.extname(relative))) continue;
    const before = gitShow(base, relative);
    if (before === null) continue; // 文件在 base 里不存在（纯新增）⇒ 没有「被删的定义」
    const defsBefore = topLevelDefs(before);
    if (defsBefore.size === 0) continue;
    const after = byRelative.get(relative) ?? null;
    const defsAfter = after === null ? new Map() : topLevelDefs(after);
    const importers = importersByFile.get(relative) ?? new Map();
    // 同名**重声明**（函数/块里又 `const violations = []`）⇒ 那些命中是另一个绑定的，
    // 不能当「被删定义仍有引用」：这是半 1 最常见的误报源。同名被重声明就整条跳过。
    const redeclared = after === null ? new Set() : declaredNames(after);
    for (const [name, line] of defsBefore) {
      if (defsAfter.has(name)) continue;
      if (redeclared.has(name)) continue;
      const references = [];
      // ⚠️ 只算「真能看到这个名字」的地方：同一份文件，或真的 `import { name } from` 这份模块的文件。
      // 全仓同名变量（两个不同模块里各有一个 `violations`）不算引用 —— 那是误报，会把正常重构判红。
      if (after !== null) for (const hit of referencesOf(after, name)) references.push(`${relative}:${hit.line}`);
      for (const [importer, bound] of importers) {
        if (!bound.has(name)) continue;
        const text = byRelative.get(importer);
        if (text === undefined) continue;
        for (const hit of referencesOf(text, name)) references.push(`${importer}:${hit.line}`);
      }
      if (references.length > 0) {
        violations.push({ file: relative, line, name, kind: 'removed_definition', references: references.slice(0, 8), referenceCount: references.length });
      }
    }
  }
  return violations;
}

/**
 * 谁 `import` 了谁：`Map(被导入文件 → Map(导入文件 → 绑定名集合))`。
 * 只解析**相对说明符**（`./x.mjs` / `../y.js`）—— 裸说明符是包，本仓模块解析不到。
 * 默认导入记成 `default:<本地名>`、命名空间记成 `*<本地名>`（调用方按需匹配）。
 *
 * ⚠️ 说明符本身是**字符串**：`sanitize()` 会把它屏蔽掉，所以结构从 sanitize 后的文本找、
 * 说明符从**原文同位置**读（sanitize 保持长度不变，偏移可直接对齐）。
 */
function importerNames(files) {
  const known = new Set(files.map((file) => file.relative));
  const map = new Map();
  for (const file of files) {
    const clean = sanitize(file.text);
    for (const match of clean.matchAll(/(?<![\w$])import\s+([\s\S]*?)\s+from\s+/g)) {
      const clause = match[1];
      // 说明符从原文的对应区间取（`from` 后面那段在 sanitize 后是空格，引号也被抹掉了）。
      const rawRegion = file.text.slice(match.index, match.index + match[0].length);
      const quoted = rawRegion.match(/from\s*(['"])([^'"]+)\1/);
      if (!quoted) continue;
      const specifier = quoted[2];
      if (!specifier.startsWith('.')) continue;
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(file.relative), specifier));
      if (!known.has(target)) {
        const withExt = [...SOURCE_EXT].map((ext) => `${target}${ext}`).find((candidate) => known.has(candidate));
        if (!withExt) continue;
        target = withExt;
      }
      const bound = new Set();
      const asMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (asMatch) bound.add(`*${asMatch[1]}`);
      const defaultMatch = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/);
      if (defaultMatch) bound.add(`default:${defaultMatch[1]}`);
      const named = clause.match(/\{([^}]*)\}/);
      if (named) {
        for (const part of named[1].split(',')) {
          const pair = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
          if (pair) bound.add(pair[2] ?? pair[1]);
        }
      }
      if (!map.has(target)) map.set(target, new Map());
      map.get(target).set(file.relative, bound);
    }
  }
  return map;
}

function listChangedFiles(root, base, gitShow) {
  void gitShow;
  const output = execFileSync('git', ['-C', root, 'diff', '--name-only', base, '--'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function gitShowAt(root, rev, relative) {
  try {
    return execFileSync('git', ['-C', root, 'show', `${rev}:${relative}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function gitAvailable(root, rev) {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** 默认 base：HEAD 与 origin/master 的 merge-base（=「我这支分支引入的改动」）；退化到 HEAD。 */
export function resolveDefaultBase(root) {
  const run = (args) => {
    try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return ''; }
  };
  if (!gitAvailable(root, 'HEAD')) return null;
  if (gitAvailable(root, 'origin/master')) {
    const mergeBase = run(['merge-base', 'HEAD', 'origin/master']);
    if (mergeBase) return mergeBase;
  }
  return 'HEAD';
}

/** 一条命令跑完两半。返回 `{ violations, stats }`。 */
export async function check({ root = defaultRoot, base } = {}) {
  const files = await readSources(root);
  const resolvedBase = base === undefined ? resolveDefaultBase(root) : base;
  const removed = scanRemovedDefs({ root, files, base: resolvedBase, gitShow: (rev, relative) => gitShowAt(root, rev, relative) });
  const undeclared = scanUndeclaredCalls(files);
  const violations = [...removed, ...undeclared];
  return {
    violations,
    stats: {
      root,
      base: resolvedBase,
      files: files.length,
      declaredNames: files.reduce((sum, file) => sum + declaredNames(file.text).size, 0),
      removedDefs: removed.length,
      undeclaredCalls: undeclared.length,
    },
  };
}

function formatViolation(violation) {
  if (violation.kind === 'removed_definition') {
    return `[removed-def] ${violation.file}:${violation.line} 「${violation.name}」在 base 里是顶层定义、工作树里没了，但仍有 ${violation.referenceCount} 处引用：${violation.references.join(', ')}`;
  }
  return `[undeclared-call] ${violation.file}:${violation.line} 「${violation.name}(…)」被调用，但全仓找不到声明（也不是 import/语言全局）；一撞必 ReferenceError`;
}

async function main() {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes('--json');
  const baseIndex = argv.findIndex((item) => item === '--base' || item.startsWith('--base='));
  let base;
  if (baseIndex !== -1) base = argv[baseIndex].includes('=') ? argv[baseIndex].slice('--base='.length) : argv[baseIndex + 1];
  else if (process.env.SOPHO_DEFSREFS_BASE) base = process.env.SOPHO_DEFSREFS_BASE;
  const result = await check({ root: process.env.SOPHO_DEFSREFS_ROOT || defaultRoot, base });
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`defs/refs scan: base=${result.stats.base ?? '(none)'} files=${result.stats.files} removed-def=${result.stats.removedDefs} undeclared-call=${result.stats.undeclaredCalls}\n`);
    for (const violation of result.violations) process.stdout.write(`  ${formatViolation(violation)}\n`);
    process.stdout.write(result.violations.length === 0 ? 'RESULT: defs/refs PASS\n' : `RESULT: defs/refs FAIL (${result.violations.length} violation(s))\n`);
  }
  process.exitCode = result.violations.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
