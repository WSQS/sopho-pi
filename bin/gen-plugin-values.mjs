#!/usr/bin/env node
// bin/gen-plugin-values.mjs —— 把**插件源码里那几个数**变成前端的取值来源（生成物层）。
//
// 为什么要有它（工单：让「没指定 timeout 的 bash 调用其实有本机缺省上限」在工具卡上看得见）：
//   那条**缺省超时安全网**活在插件里（`pi-extensions/assistant/index.ts` 的 `pi.on("tool_call")`，
//   常量 `DEFAULT_BASH_TIMEOUT_S`）。它**在 UI 上完全看不见**：注入的值不落盘 ⇒ 工具卡渲染的会话
//   记录里根本没有 `timeout` 字段；模型看到的 pi 内置描述仍是 `optional, no default timeout`（插件改不了）。
//   所以这一单只做**显示**：让「这条命令没有显式超时 ⇒ 本机缺省 1800 s」出现在工具卡上。
//
//   ⚠️ 唯一真理：前端**不许**自己写死 `1800`。写了就是第二份真理，插件一改前端就撒谎。
//   所以照本仓既有惯例（`bin/gen-design-values.mjs` ⇒ `web/generated/design-values.css`）铺一层：
//     插件源码（唯一真源）⇒ 本脚本 ⇒ `web/generated/plugin-values.js` ⇒ 前端 import。
//   将来谁改了插件常量而忘了重新生成，`npm run test:pluginvalues` 会红（逐字节比），前端不会说谎。
//
// 这个脚本只做一件事，规则一句话：
//   **生成值 ＝ 插件源码里那几处声明的**逐字**读数**（`DEFAULT_BASH_TIMEOUT_S` 的数字、`SOPHO_BASH_TIMEOUT`
//   的 env 名、`^(0|off|none|false|no)$` 那串关掉取值）。它不发明任何数、不做换算、不加壳。
//   ⚠️ 因此「哪些东西可生成」这件事**只有一份判断**，就是下面那张 ITEMS 表（每条带一个**必须命中**的
//   锚点正则）——锚点漂了就**报错退出**（绝不静默降级 / 绝不猜），这样插件形状一变就不会悄悄分叉。
//
// 用法：
//   node bin/gen-plugin-values.mjs                      # 重写 web/generated/plugin-values.js（一键重跑）
//   node bin/gen-plugin-values.mjs --check              # 只比：盘上那份是不是当前插件源码的生成结果（不写）
//   node bin/gen-plugin-values.mjs --stdout             # 打到标准输出（不写盘）
//   node bin/gen-plugin-values.mjs --source=<文件>       # 换插件源码（反证臂 / 副本实验用）
//   node bin/gen-plugin-values.mjs --out=<文件>          # 换落点（默认 web/generated/plugin-values.js）
//
// 出口：0 = 与插件源码一致；1 = 源码里读不到某条锚点 / （`--check` 时）盘上那份与当前源码生成的
//       不一致。**不写半份文件**（先算完再落盘），且落盘是**原子**的（同目录 temp ⇒ rename）——
//       与 `bin/gen-design-values.mjs` 同一约定：这份生成物有活的读者（页面 / 门直接读它）。
//
// 谁写 / 谁读：写者只有本脚本（人手动跑一次 `npm run gen:pluginvalues`）；读者 ——
//   · 前端：`web/render.js`（`toolCard()` 那条注记，`import { … } from './generated/plugin-values.js'`），
//     经 `server/app.mjs` 的 `serveStatic`（每个请求 `readFile` 一次、`cache-control: no-store`）送达；
//   · 门：`test/plugin-values-freshness.mjs`（逐字节比）与本脚本自己的 `--check`。

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

/** 可生成的那几项（**唯一一份判断**）。每项一个 `read`：拿源码文本 ⇒ { name, value, literal } 或抛错。
 *  `value` 会逐字写进生成物；`anchors` 是必须逐字命中的证据串（生成物注释里也写出来，好审）。 */
const ITEMS = [
  {
    name: 'BASH_DEFAULT_TIMEOUT_S',
    what: '插件给「没给 timeout」的 bash 调用补的那个缺省秒数（安全网）',
    anchors: ['const DEFAULT_BASH_TIMEOUT_S = <数字>;'],
    read: (source) => {
      const match = /const DEFAULT_BASH_TIMEOUT_S = (\d+);/.exec(source);
      if (!match) throw new Error('插件源码里找不到 `const DEFAULT_BASH_TIMEOUT_S = <数字>;`（常量改名/改形了？）');
      return match[1];
    },
  },
  {
    name: 'BASH_TIMEOUT_ENV',
    what: '覆盖 / 关掉那层安全网的 env 名',
    anchors: ['process.env.SOPHO_BASH_TIMEOUT'],
    read: (source) => {
      const match = /process\.env\.(SOPHO_BASH_TIMEOUT)\b/.exec(source);
      if (!match) throw new Error('插件源码里找不到 `process.env.SOPHO_BASH_TIMEOUT`（env 改名了？）');
      return match[1];
    },
  },
  {
    name: 'BASH_TIMEOUT_OFF_VALUES',
    what: '把 env 置成这几个值之一 ⇒ **显式关掉**安全网（回到「没超时」）',
    anchors: ['if (/^(0|off|none|false|no)$/i.test(raw)) return null;'],
    read: (source) => {
      const match = /if \(\/\^\(([^()]+)\)\$\/i\.test\(raw\)\) return null;/.exec(source);
      if (!match) throw new Error('插件源码里找不到「关掉」那条判据 `if (/^(…)$/i.test(raw)) return null;`（判据改形了？）');
      const values = match[1].split('|').map((value) => value.trim());
      if (values.length < 2 || values.some((value) => value === '')) throw new Error(`「关掉」那一串读出来不对劲：${JSON.stringify(match[1])}`);
      return values;
    },
  },
];

const SOURCE_RELATIVE = path.join('pi-extensions', 'assistant', 'index.ts').split(path.sep).join('/');
const sourceFile = path.resolve(argOf('source') || path.join(root, SOURCE_RELATIVE));
const canonicalSourceFile = path.join(root, SOURCE_RELATIVE);
const outFile = path.resolve(argOf('out') || path.join(root, 'web', 'generated', 'plugin-values.js'));

/** 源码 ⇒ 生成物的每个常量（名字 → 字面量文本）。读不到就抛（不猜）。 */
function valuesFromSource(source) {
  return ITEMS.map((item) => {
    const value = item.read(source);
    return { name: item.name, value, what: item.what, anchors: item.anchors };
  });
}

/** 把读到的值渲染成 JS 字面量（数字就裸写、字符串加引号、字符串数组写成数组）。 */
function literalOf(item, value) {
  if (Array.isArray(value)) return `[${value.map((entry) => JSON.stringify(entry)).join(', ')}]`;
  if (/^\d+$/.test(value)) return value;
  return JSON.stringify(value);
}

const BANNER = (sourceRelative, extraNote) => `\
/* web/generated/plugin-values.js —— **生成物，不要手改**。
 *
 * 来源（唯一真源）：${sourceRelative} 里那几处**声明** —— 逐字搬过来，不发明、不换算。
${extraNote} * 生成器：bin/gen-plugin-values.mjs（一键重跑 \`npm run gen:pluginvalues\`；重跑两次字节相同、结果确定）。
 *
 * 为什么有这一份：插件那条**缺省 bash 超时**安全网在 UI 上看不见（注入的值不落盘），
 * 工具卡上那句「未指定 timeout ⇒ 本机缺省 N s」的 N **必须只有这一个来处** ——
 * 前端（web/render.js）写死 1800 就是第二份真理，插件一改前端就撒谎。
 * 手改这一份没有意义：\`npm run test:pluginvalues\` 会重跑生成器并与盘上这份**逐字节**比；
 * 谁改了插件常量而忘了重新生成，那道门会红。
 */
`;

function renderGenerated(source, sourceRelative, extraNote = '') {
  const values = valuesFromSource(source);
  const lines = values.map((item) => `/** ${item.what}（源码锚点：${item.anchors.join('；')}） */\nexport const ${item.name} = ${literalOf(item, item.value)};`);
  return `${BANNER(sourceRelative, extraNote)}${lines.join('\n')}\n`;
}

/** 落盘：**先写同目录临时文件、再 `rename` 换上去**（原子写）。
 *  与 `bin/gen-design-values.mjs` 同一约定：这份生成物有活的读者（静态服务每个请求 `readFile` 一次、
 *  门直接读它），裸 `writeFile`（先截断再写）会让读者读到 0 字节。temp 与目标同目录（跨设备 rename 会 EXDEV）。 */
async function atomicWriteFile(file, text) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, 'utf8');
  await rename(temporary, file);
}

const sourceText = await readFile(sourceFile, 'utf8').catch((error) => {
  process.stderr.write(`读不到插件源码 ${sourceFile}：${error.message}\n`);
  process.exit(1);
});

let rendered;
try {
  // `--source=` 指到别的文件时（反证臂 / 副本实验）把这件事写进生成物 —— 不假装这份是规范路径那份生成的。
  const extraNote = sourceFile === canonicalSourceFile ? ''
    : ` * ⚠️ 这一份是按 --source=${sourceFile.split(path.sep).join('/')} 生成的（不是上面那份规范路径）。\n`;
  rendered = renderGenerated(sourceText, SOURCE_RELATIVE, extraNote);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

if (hasFlag('stdout')) {
  process.stdout.write(rendered);
} else if (hasFlag('check')) {
  const current = await readFile(outFile, 'utf8').catch(() => null);
  if (current === null) {
    process.stderr.write(`${outFile} 不存在 —— 跑一次 \`npm run gen:pluginvalues\`\n`);
    process.exit(1);
  }
  if (current !== rendered) {
    process.stderr.write(`${outFile} 与当前插件源码（${SOURCE_RELATIVE}）生成的**不一致** —— 跑一次 \`npm run gen:pluginvalues\`\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ ${path.relative(root, outFile).split(path.sep).join('/')} 与 ${SOURCE_RELATIVE} 一致（${Buffer.byteLength(rendered)} B）\n`);
} else {
  await mkdir(path.dirname(outFile), { recursive: true });
  await atomicWriteFile(outFile, rendered);
  const values = valuesFromSource(sourceText);
  process.stdout.write(`✓ 生成 ${path.relative(root, outFile).split(path.sep).join('/')} ← ${SOURCE_RELATIVE}`
    + `（${values.length} 个常量：${values.map((item) => `${item.name}=${literalOf(item, item.value)}`).join('、')}）\n`);
}
