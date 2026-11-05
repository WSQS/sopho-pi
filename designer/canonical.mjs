// designer/canonical.mjs —— 中立文档的**规范序列化**（纯 Node、零依赖）。
//
// 为什么要有它：业主的判据之一是「产物是开放、可 diff 的文本」，而「同一份内容两种字节」会把
// `git diff` 弄脏、也会让「导出物是不是旧的」这类判据失去意义。所以 JSON 的**键序与缩进是规定死的**：
//
//   · 键序 = `designer/schema.json` 里 `properties` 的声明顺序（**唯一来源就是那份 schema**，
//     本文件不再抄一份键名表）；
//   · 自由对象（`tokens`：键是用户起的 `--名字`）⇒ 键**字典序**；
//   · 数组顺序 = 文档顺序（数组顺序本身有语义：children 的顺序就是绘制顺序）；
//   · 2 空格缩进、结尾一个换行、UTF-8。
//
// `docDigest()` 是同一份规范字节的 sha256 —— 导出物把它嵌在自己的 `<meta>`/`<desc>` 里，
// 「盘上那份导出物对应哪一版文档」因此可以**当场**判（designer/diff.mjs 的 `--check-export`）。

import { createHash } from 'node:crypto';
import { SCHEMA, resolveRef } from './validate.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function nodeFor(node) {
  let current = node;
  const seen = new Set();
  while (isObject(current) && current.$ref) {
    if (seen.has(current.$ref)) throw new Error(`$ref 成环：${current.$ref}`);
    seen.add(current.$ref);
    current = resolveRef(current.$ref, SCHEMA);
  }
  return current ?? {};
}

/** 按 schema 的声明顺序重排一份文档（不认识的对象形态：键字典序）。 */
export function canonicalize(value, node = SCHEMA) {
  const schema = nodeFor(node);
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, schema.items));
  if (isObject(value)) {
    const out = {};
    if (isObject(schema.properties)) {
      for (const key of Object.keys(schema.properties)) {
        if (value[key] !== undefined) out[key] = canonicalize(value[key], schema.properties[key]);
      }
      const extra = isObject(schema.additionalProperties) ? schema.additionalProperties : null;
      const unknown = Object.keys(value).filter((key) => out[key] === undefined).sort();
      for (const key of unknown) out[key] = canonicalize(value[key], extra ?? {});
      return out;
    }
    const extra = isObject(schema.additionalProperties) ? schema.additionalProperties : {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key], extra);
    return out;
  }
  return value;
}

/** 规范 JSON 文本（**逐字节确定**：同一份语义 ⇒ 同一串字节）。 */
export function canonicalJson(doc) {
  return `${JSON.stringify(canonicalize(doc), null, 2)}\n`;
}

/** 规范字节的 sha256（十六进制，64 字符）。导出物把它嵌进去，用来判「这份导出物对应哪一版文档」。 */
export function docDigest(doc) {
  return createHash('sha256').update(canonicalJson(doc), 'utf8').digest('hex');
}
