#!/usr/bin/env node
// bin/check-arm-seams.mjs —— 「反证臂的接缝会不会失配」的**常驻机械门**。
//
// ── 为什么要有这道门（真实发生一次，被人工抓到的）────────────────────────────────────────────
// 某单给 `web/designer.js` 的 `labelCandidatesOnPath(path)` 加了个形参 ⇒ 签名变成 `(path, zoom)`；
// 而既有一条反证臂的 `from` 串**还是旧签名** ⇒ 若不改它，那条臂会在「改写没命中」处直接抛错：
//     `if (!text.includes(arm.from)) throw new Error('反证臂 … 的改写没命中（接缝形状变了？）')`
// ⇒ **它不是变红，而是崩**。主门照样绿（绿的是别的 id），所以没人发现。作者事后用一个**一次性脚本**
// 逐条比对（20/20 命中）才抓到。本笔把那个一次性脚本变成常驻门，让本仓那条纪律
// 「**臂崩 ≠ 臂红**」机械成立：每条臂的 `from` 串，必须在仓库里某个文件里**逐字**找得到 ——
// 找不到就是**失配**，这道门立刻红，并点名是哪条臂、它声明盯的是哪个文件。
//
// ── 判据（一句话）────────────────────────────────────────────────────────────────────────────
// 扫遍本仓所有**声明了反证/变异臂**的 `.mjs`（同一个对象里 `from:` 与 `to:` 成对出现，且带臂标记
// `what`/`expect`/`anchor`/`spec`/`draft`/`web` 之类），对每条臂的 `from` 表达式做**静态求值**
// （逐条还原 JS 转义：`\n` → 真换行，`\'`/`\"`/`\\`/`\t`/`\uXXXX` …），再拿去在**仓库里
// （排除 node_modules / .git / 一次性 `.sopho-*` 沙箱副本）某个文件**里逐字找：
//   · 找得到 ⇒ 该臂的接缝还在（打印命中在哪个文件＋命中分布，便于审计）；
//   · 找不到 ⇒ **失配**，红（点名臂 + 声明文件 + from 预览）；
//   · 静态求不出来（模板里带 `${}`、动态拼的、非字面量标识符）⇒ **红**（不静默跳过）。
// 声明文件自己**排除在搜索之外** —— 否则单行 from 会「在声明它的那份测试里找到自己」，门就变成假绿。
//
// ── 判据收紧之一：接缝**不能只在兄弟测试里还在**（`test/**` 之外至少要有一处命中）──────────────
// 2026-09-20 总台独立打实的一个洞：把 `server/base-logic.mjs` 里那两条接缝删掉，而**兄弟测试**
// `test/cache-identity-ctime.mjs` 里同一串还在 ⇒ 命中数照样 86/86，门**仍然绿**。
// 于是判据补上一条：每条臂的命中里，**至少有一处落在臂目录（默认 `test/`）之外** ——
// 产品 / `bin/` / `designer/` / `pi-extensions/` / `spec/` / `docs/` 都算；
// **只有兄弟测试命中 ⇒ 红**（接缝已经从产品里消失，臂在拿别处的字节自证，是假绿）。
//
// ── 判据收紧之二：**声明了目标文件的臂，必须在那个目标文件里命中**（fail-closed）──────────────
// 臂可以带 `file:` 声明它的接缝**盯的是哪个文件**（`--json` 里是 `declaredFile`）。解析规则**显式**：
//   ① `file:` 恰好等于某个仓内路径 ⇒ 用它；
//   ② 否则取所有「以 `/<file>` 结尾」的仓内文件 ⇒ **恰好一个**才算解出来（`designer.js` ⇒ `web/designer.js`）；
//   ③ 0 个（名字漂了/文件没了）或多个（有歧义）⇒ **判红**，绝不静默跳过；
// 解出来之后，该文件里**必须**有这条接缝；没有 ⇒ 红（声明盯的是 A，接缝其实在 B，声明已经过期）。
// ⚠ 「有歧义 ⇒ 红」是**实的**：2026-09-27 它当场抓住一条真的（`test/designer-sample-anchor.mjs` 的臂
// 声明的 `main-screen.json` 在仓里有**两个**候选：真源 ＋ 它的生成物）；那条线随后把 `file:` 改成
// **完整仓内路径**（`design/samples/two-pane/main-screen.json`）就绿了（提交 `0368174`）⇒ 这条判据不是
// 「做不到的严格要求」，而是「声明者把名字写准」，且有自己的反证臂（反证臂 ⑦）。
// 这条**不**要求目标必须是产品：`docs/human/v2.2-lessons.md` / `spec/screens/*` 这类
// 「目标本来就是文档」的臂按事实放过（只要求「在它声明的那个文件里命中」）。
//
// ── 判据收紧之三：**没进扫描范围的臂必须有机械台账**（`bin/arm-seam-coverage.json`）────────────
// 本门只认 `test/**/*.mjs` 里 `from:/to:` 与 `anchor:/replace:` 两种**成对声明**的形状。别的形状
// （`--reverse-arm` 驱动的副本改写、`MUTANT_RULES`、env 变异、程序化 `mutate()`、结构式 splice…）
// 进不了扫描 —— 那些一律逐条写进台账（形状 / 证据 / 决策 / 理由），并由本门**机械核对**：
//   · 每个带臂标记（`--reverse` / `MUTANT` / `expectRed` / `anchor:`）的 `test/**/*.mjs`，
//     要么**贡献了 ≥1 条臂**，要么**在台账里**；两边都没有 ⇒ 红（新臂不许被静默漏掉）；
//   · 台账每条：`present` 证据必须**逐字**在文件里找得到、`absent` 证据必须**找不到**（台账不许腐坏）；
//     `decision` 三选一：`excluded`（**有臂**，但形状进不了扫描）/ `partial`（同一文件里另有进了扫描的臂）/
//     `not-an-arm`（**没有臂**：只是被臂标记误捕，或用来让「`test/` 之外没有臂」这条结论有落点）；
//     且分类必须与事实相符（`excluded`/`not-an-arm` 的文件必须 0 条臂、`partial` 的必须 ≥1 条）。
// ⇒ 「覆盖多少条 / 已知未覆盖多少条」是打印出来的、可核对的，不靠人记。
//
// ⚠ 本门的范围就是 `test/**/*.mjs`（臂目录）。2026-09-20 普查过 `test/` **之外**：非 test 的
// .mjs/.js/.ts 共 58 个文件，用本门的 `extractArms()` 跑一遍只得到 1 个「臂形状」命中
// （`server/design-spec.mjs`，而它是比对行 `{ from, to, doc, source, draft }`，`draft:` 那个键
// 撞上了臂标记）；该文件已于 2026-10-05 随「设计编辑页 v3」退休、它那条 `not-an-arm` 台账一并删除
// ⇒ **今天 `test/` 之外没有已登记的臂**；将来若有非 test 文件带臂，要重做这次普查。
//
// ── 判据收紧之四：**声明了目标文件的臂，接缝在那个文件里必须恰好 1 处**（2026-09-27 加）────────
// 为什么：`String.replace` 配**字符串**只改**第一处**，而本门原先只判「那条 `from` 串在仓库里
// **还在不在**」⇒ 一条臂的接缝串若在**它宣称要改的那个文件里出现两次**（最典型的成因：新加的函数
// 里有一行与旧接缝**逐字相同**），臂就会改到**另一处**、旧接缝一动没动 ⇒ 臂「跑了」却没红到它该红的
// 那条 ⇒ **假臂**，而这道门看不见（2026-09-27 `designer-ui.mjs` 的 `anchor-falls-back-to-root`
// 真踩过：那时 `web/designer.js` 里那行出现两次；它在**施加处**补了 `hits !== 1 ⇒ throw` 才修好）。
// 判据：`file:` 解析得出来的臂，`from` 在**那个文件**里的出现次数必须**恰好 1** ⇒
//   0 次（声明过期）原本已红；**> 1 次** 现在也红，并点名「出现 N 次」。
// ⚠ 这条只管**声明了目标**的臂。另外那些没声明目标（改的目标写在施加处）的，本门词法层看不见
// 「它到底改哪个文件」⇒ 靠**施加处自己的「恰好一处」守卫**。★ 下面这句是 **2026-09-27 那次普查**
// 的读数（不是今天——本仓盘一直在长）：119 条臂里 78 条声明了目标、41 条没有；41 条里 29 条有守卫、
// 12 条没有（后者＝既没声明目标也没守卫：designer-cli 7 / design-spec 4 / design-edit 1）。
// ⚠️ 其中 `design-edit 1` 那条**已不存在**：`test/design-edit.mjs` 已于 2026-10-05 随
// 「设计编辑页 v3」退休 ⇒ 今天实际是 11 条。别把这条判据误读成「所有臂都覆盖到了」——
// 报告里「声明目标里出现 >1 次」「没有声明目标」「有/无施加处守卫」三个读数要一起看。
// 自己的牙：反证臂 ⑧（同一条接缝在声明目标里出现两次 ⇒ 门必红；一次仍绿）。
//
// ── 判据收紧之五：**过去某次运行的记录不算证据**（2026-10-05 加）─────────────────────────────────
// 检进仓里的「门日志 / 历史归档」里会**逐字印着**它当时量到的接缝串 —— 本仓就有活例：
//   `design/samples/two-pane/attempts/realign-2026-09-27/logs/gate-final-test_armseams.txt`
// 里 **52 条臂的 `from`** 逐字出现（`--json` 数出来的 ✓）。那些字节是**对当时状态的引用** ✗，
// 不是**今日状态的存在性证据** ✗：拿它当证据 ⇒ 产品里的接缝删了照样绿 ✗。2026-10-05 实测过一次**假绿**：
//   · 把 `server/base-logic.mjs` 里 `annotate-notify` 那条臂的接缝删掉、那份日志原样留着 ⇒
//     门仍报 `132 命中 / 0 失配`（日志替它满足了「臂目录之外至少一处命中」✗）；
//   · 把日志也拿掉、同一棵树 ⇒ 那条臂**当场失配**、门红 ✓。
// 规则（按名、机械、可核）：路径里**任一目录段**叫 `logs` 或 `attempts` ⇒ 该文件**不进证据语料** ✓。
//   （`attempts/` 是本仓的「历史 / 探针归档」—— `test/designer-sample.mjs` 早就把它排除在 live 集合之外 ✓。）
// 实测（2026-10-05）：把两棵 `attempts/**` 归档**整棵**移走，门仍是 `132/0` ⇒ 今天的判据**没有**依赖
//   任何过去记录（这条只是把「记录不能当证据」写成不变量，方向是**收紧** ✓，不是放宽 ✗）。
// 自己的牙：反证臂 ⑨（接缝只出现在一份 `logs/` 记录里 ⇒ 门必红；同一串放回产品文件 ⇒ 绿 ✓）。
//
// ── 注释掉的臂：不算臂（点名排除）────────────────────────────────────────────────────────────
// 词法层**先吃掉注释**（`//` 与 `/* */` 都进不了 token 流）⇒ 注释里的 `from:` 天然不是属性赋值，
// 不会被当成一条臂。报告里另有「被注释掉的 `from:`（已排除）」一节，把注释里出现过的 `from:`
// 逐条打出来（file:line＋原文），好让人一眼看出「它确实看见过、并且确实排除了」；
// `--self-test` 里的**正控制 B** 再把这条排除变成会红的机械证据。同理，`arm.from` 这类
// 「前置 token 是 `.`」的 from 不是属性位置，也不会被算进去。
//
// ── 红半（`--self-test`，正控制 + 反证臂都要有）──────────────────────────────────────────────
//   · 正控制 A：在一份**臂文件副本**里把某条臂的 `from` 换成仓库里不存在的串 ⇒ 门**必红**且**点名**那条臂；
//   · 正控制 B：在副本里塞一条**整个被注释掉**的假臂（from 是不存在的串）⇒ 门**必须仍然绿**、
//     且报告里**不许出现**那条假臂（证明「注释里的 from 不算臂」这条排除是真的，不是嘴上说的）。
//   · 反证臂 ①「掏空扫描」：把**本门脚本副本**的 `extractArms()` 换成直接 `return []` ⇒ 门必红
//     （红在「抽取器返回形状不对 ⇒ 扫描失去 reach」这条自检上）。
//   · 反证臂 ②「掏空匹配」：把**本门脚本副本**的 `findSeamInRepo()` 换成永远说「找到了」⇒ 门必红
//     （红在负控制上：一个绝不可能存在的串也必须报 0 命中）。
//   · 反证臂 ③「兄弟测试自证」：把产品里那两条接缝的字节从搜索树里拿掉、只留兄弟测试 ⇒ 门必红
//     （红在新判据之一上）—— 这就是当初那个洞的复现。
//   · 反证臂 ④「声明目标过期」：把一条臂的 `file:` 改成一个仓里存在但不含这条接缝的文件 ⇒ 门必红；
//     再改成仓里**不存在**的名字 ⇒ 门必红（解析 fail-closed，两条新判据都要有牙）。
//   · 反证臂 ④b「多候选一律红，不许猜」：一条臂声明的名字在仓里有**两个**候选、两个候选**都含**这条接缝
//     ⇒ 门仍必红（有歧义 ⇒ 声明者必须写全路径）；同一个候选只有一个时仍绿。
//   · 反证臂 ⑤「台账漏登记」：往副本臂目录里塞一个带臂标记、却没有可扫描臂的文件 ⇒ 门必红
//     （红在台账完整性上）。
//   · 反证臂 ⑥「台账证据腐坏」：把台账副本里一条 `present` 证据改成文件里没有的串 ⇒ 门必红；
//     再把一条 `decision` 改成与事实相反的 `excluded` ⇒ 门必红。
//   · 反证臂 ⑧「接缝在声明目标里出现两次」：同一串在**声明的那个文件**里放两处 ⇒ 门必红
//     （红在判据收紧之四上）；只放一处的同一棵树仍绿（证明它红的是「次数」，不是形状）。
//   · 反证臂 ⑨「过去运行的记录不算证据」：接缝只出现在一棵 `logs/` 记录里（产品里没有）⇒ 门必红
//     （红在「from 在仓库里找不到」上）；把同一串放回一个产品文件 ⇒ 绿（证它红的是「证据来源」，不是接缝形状）。
//   两条正控制 + 九条反证臂都跑在**副本**上（真树一个字不动），沿用本仓既有写法。
//
// 跑法：
//   node bin/check-arm-seams.mjs                 # 只跑扫描（真树只读）
//   npm run test:armseams                        # 扫描 ＋ 红半（正控制两条 ＋ 反证臂七条）
// 可选参数：--root=<dir>（默认本仓根）、--arms-root=<dir>（默认 <root>/test）、
//           --search-root=<dir>（默认 <root>）、--coverage=<file>（默认 <本门目录>/arm-seam-coverage.json）、
//           --json、--self-test
//
// 纪律：**只读真树**（红半一律打副本，副本建在 os.tmpdir() 的 mkdtemp 里，跑完删**精确路径**，不用 glob）；
//       绝不 pkill / pgrep -f；不重启任何宿主；不用 7331/7321。

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GATE_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(GATE_FILE), '..');

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const hit = argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const ROOT = path.resolve(argOf('root', REPO_ROOT));
const ARMS_ROOT = path.resolve(argOf('arms-root', path.join(ROOT, 'test')));
const SEARCH_ROOT = path.resolve(argOf('search-root', ROOT));
const COVERAGE_FILE = path.resolve(argOf('coverage', path.join(path.dirname(GATE_FILE), 'arm-seam-coverage.json')));
const AS_JSON = argv.includes('--json');
const SELF_TEST = argv.includes('--self-test');

const out = (line = '') => process.stdout.write(`${line}\n`);
const preview = (text, max = 96) => {
  const flat = String(text).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
  return flat.length > max ? `${flat.slice(0, max)}…（共 ${text.length} 字符）` : flat;
};

// ── ① JS 字符串转义解码（逐条吃，别拿整串去 unicode_escape）───────────────────────────────────
// 逐条处理是**关键**：`\\` 当成一个整体吃掉，它后面那个字符就不会被再解释一次。
// （上一任就是拿整串去做 unicode_escape，栽在尾随反斜杠上。）raw 里不含首尾引号。
export function decodeJsEscapes(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') { out += ch; continue; }
    if (i + 1 >= raw.length) { out += '\\'; break; } // 尾随反斜杠：原样保留，不吞、也不乱解
    const next = raw[i + 1];
    i += 1;
    switch (next) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '0': out += '\0'; break;
      case 'x': {
        const hex = raw.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 2; }
        else out += 'x';
        break;
      }
      case 'u': {
        if (raw[i + 1] === '{') {
          const end = raw.indexOf('}', i);
          const hex = end < 0 ? '' : raw.slice(i + 2, end);
          if (/^[0-9a-fA-F]+$/.test(hex)) { out += String.fromCodePoint(parseInt(hex, 16)); i = end; }
          else out += 'u';
        } else {
          const hex = raw.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
          else out += 'u';
        }
        break;
      }
      case '\n': break; // 行继续
      case '\r': if (raw[i + 1] === '\n') i += 1; break;
      default: out += next; break; // `\\` `\'` `\"` `` \` `` 以及不认识的转义：原样（去掉反斜杠）
    }
  }
  return out;
}

// ── ② 词法层：注释先吃掉，字符串/模板/正则各自成 token ────────────────────────────────────────
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const ID_START = /[A-Za-z_$\u00aa-\uffff]/;
const ID_PART = /[A-Za-z0-9_$\u00aa-\uffff]/;

export function tokenize(source) {
  const tokens = [];
  const comments = [];
  const n = source.length;
  let i = 0;
  let prev = null;
  const push = (token) => { tokens.push(token); prev = token; };

  while (i < n) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00a0' || ch === '\ufeff') { i += 1; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      const start = i;
      while (i < n && source[i] !== '\n') i += 1;
      comments.push({ start, end: i, text: source.slice(start, i) });
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i = Math.min(n, i + 2);
      comments.push({ start, end: i, text: source.slice(start, i) });
      continue;
    }
    if (ch === "'" || ch === '"') {
      const start = i;
      i += 1;
      let raw = '';
      while (i < n && source[i] !== ch) {
        if (source[i] === '\\') { raw += source[i] + (source[i + 1] ?? ''); i += 2; }
        else { raw += source[i]; i += 1; }
      }
      i += 1;
      push({ type: 'string', value: decodeJsEscapes(raw), start, end: i });
      continue;
    }
    if (ch === '`') {
      const start = i;
      i += 1;
      let cooked = '';
      let hasSubstitution = false;
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\') { cooked += decodeJsEscapes(source[i] + (source[i + 1] ?? '')); i += 2; continue; }
        if (source[i] === '$' && source[i + 1] === '{') {
          hasSubstitution = true;
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') { depth -= 1; if (depth === 0) break; }
            i += 1;
          }
          i += 1;
          continue;
        }
        cooked += source[i];
        i += 1;
      }
      i += 1;
      push({ type: 'template', value: cooked, hasSubstitution, start, end: i });
      continue;
    }
    if (ch === '/') {
      const p = prev;
      const canRegex = !p
        || (p.type === 'punct' && ![')', ']', '}'].includes(p.value))
        || (p.type === 'ident' && REGEX_KEYWORDS.has(p.value));
      if (canRegex) {
        const start = i;
        i += 1;
        let inClass = false;
        let closed = false;
        while (i < n) {
          const c = source[i];
          if (c === '\\') { i += 2; continue; }
          if (c === '\n') break;
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) { closed = true; break; }
          i += 1;
        }
        if (closed) {
          i += 1;
          while (i < n && /[a-z]/i.test(source[i])) i += 1;
          push({ type: 'regex', value: source.slice(start, i), start, end: i });
          continue;
        }
        i = start;
      }
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const start = i;
      while (i < n && /[0-9a-zA-Z_.]/.test(source[i])) i += 1;
      if ((source[i] === '+' || source[i] === '-') && /[eE]/.test(source[i - 1] ?? '')) {
        i += 1;
        while (i < n && /[0-9]/.test(source[i])) i += 1;
      }
      push({ type: 'number', value: source.slice(start, i), start, end: i });
      continue;
    }
    if (ID_START.test(ch)) {
      const start = i;
      while (i < n && ID_PART.test(source[i])) i += 1;
      push({ type: 'ident', value: source.slice(start, i), start, end: i });
      continue;
    }
    push({ type: 'punct', value: ch, start: i, end: i + 1 });
    i += 1;
  }
  return { tokens, comments };
}

// ── ③ 文件级 const 字面量表（只收括号深度 0 的 `const NAME = …;`）──────────────────────────────
export function collectConsts(tokens) {
  const consts = new Map();
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === 'punct' && ['{', '(', '['].includes(token.value)) depth += 1;
    else if (token.type === 'punct' && ['}', ')', ']'].includes(token.value)) depth -= 1;
    else if (depth === 0 && token.type === 'ident' && token.value === 'const') {
      const name = tokens[i + 1];
      const eq = tokens[i + 2];
      if (name?.type === 'ident' && eq?.type === 'punct' && eq.value === '=') {
        const value = [];
        let inner = 0;
        for (let j = i + 3; j < tokens.length; j += 1) {
          const t = tokens[j];
          if (t.type === 'punct' && ['{', '(', '['].includes(t.value)) inner += 1;
          else if (t.type === 'punct' && ['}', ')', ']'].includes(t.value)) inner -= 1;
          else if (t.type === 'punct' && t.value === ';' && inner === 0) break;
          else if (t.type === 'punct' && t.value === ',' && inner === 0) break;
          value.push(t);
        }
        consts.set(name.value, value);
      }
    }
  }
  return consts;
}

// ── ④ 静态求值：只认「字面量 / 无 ${} 模板 / 文件级 const / 字符串 + / 字面量数组 .join()」──
const splitTop = (tokens, value) => {
  const parts = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.type === 'punct' && ['{', '(', '['].includes(token.value)) depth += 1;
    else if (token.type === 'punct' && ['}', ')', ']'].includes(token.value)) depth -= 1;
    if (depth === 0 && token.type === 'punct' && token.value === value) { parts.push([]); continue; }
    parts[parts.length - 1].push(token);
  }
  return parts;
};

export function resolveExpr(tokens, consts, seen = new Set()) {
  if (!tokens || tokens.length === 0) return { ok: false, reason: '空表达式' };
  const sums = splitTop(tokens, '+');
  if (sums.length > 1) {
    let value = '';
    for (const part of sums) {
      const resolved = resolveExpr(part, consts, seen);
      if (!resolved.ok) return resolved;
      value += resolved.value;
    }
    return { ok: true, value };
  }
  if (tokens.length === 1) {
    const token = tokens[0];
    if (token.type === 'string') return { ok: true, value: token.value };
    if (token.type === 'template') {
      return token.hasSubstitution ? { ok: false, reason: '模板里带 ${}（动态拼的，静态求不出来）' } : { ok: true, value: token.value };
    }
    if (token.type === 'ident') {
      if (seen.has(token.value)) return { ok: false, reason: `常量 ${token.value} 自引用` };
      const init = consts.get(token.value);
      if (!init) return { ok: false, reason: `标识符 ${token.value} 不是文件级 const 字面量` };
      return resolveExpr(init, consts, new Set([...seen, token.value]));
    }
    return { ok: false, reason: `非字符串字面量（${token.type}）` };
  }
  if (tokens[0].type === 'punct' && tokens[0].value === '[') {
    let depth = 0;
    let close = -1;
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t.type === 'punct' && ['[', '(', '{'].includes(t.value)) depth += 1;
      else if (t.type === 'punct' && [']', ')', '}'].includes(t.value)) {
        depth -= 1;
        if (depth === 0 && t.value === ']') { close = i; break; }
      }
    }
    if (close > 0) {
      const tail = tokens.slice(close + 1);
      const isJoin = tail.length >= 4
        && tail[0].type === 'punct' && tail[0].value === '.'
        && tail[1].type === 'ident' && tail[1].value === 'join'
        && tail[2].type === 'punct' && tail[2].value === '('
        && tail[tail.length - 1].type === 'punct' && tail[tail.length - 1].value === ')';
      if (isJoin) {
        let separator = ',';
        const argTokens = tail.slice(3, tail.length - 1);
        if (argTokens.length === 1 && argTokens[0].type === 'string') separator = argTokens[0].value;
        else if (argTokens.length !== 0) return { ok: false, reason: '数组 .join(…) 的分隔符不是字面量' };
        const elements = splitTop(tokens.slice(1, close), ',').filter((part) => part.length > 0); // 尾随逗号不算一个空元素
        const values = [];
        for (const element of elements) {
          const resolved = resolveExpr(element, consts, seen);
          if (!resolved.ok) return resolved;
          values.push(resolved.value);
        }
        return { ok: true, value: values.join(separator) };
      }
    }
  }
  return { ok: false, reason: '不是静态可求值的字符串表达式' };
}

// ── ⑤ 抽臂：`{ … from: <expr> … to: <expr> … }`（同一个对象里成对），按作用域配对 ────────────────
// 臂标记：这些键出现，才把它当成「反证/变异臂」；否则只是恰好也叫 from/to 的数据字段
// （例如 `test/big-session-refetch.mjs` 里 `print(...)` 载荷的 `{ from: messages.length, to: … }`）。
const ARM_MARKERS = new Set(['what', 'expect', 'expectGreen', 'expectMatch', 'anchor', 'spec', 'draft', 'web', 'note', 'apply']);
// anchor/replace 形状多两个标记：它的臂规格总是带 `why` / `expectRed`。
// ⚠ 这两个**不能**加进主集合：`test/big-session-refetch.mjs` 里 `print(...)` 的载荷
// `{ from, to, why, … }` 是**数据**不是臂，主集合放宽就会把它误收成一条臂。
const ANCHOR_ARM_MARKERS = new Set([...ARM_MARKERS, 'why', 'expectRed']);

// 臂的**接缝字段**有两种成对写法（同一个东西，只是键名不同）：
//   · `{ from: …, to: … }`        —— 主形状（`to` 是替换后的文本，只为可读与审阅）
//   · `{ anchor: …, replace: … }` —— `test/designer-export.mjs` / `designer-model.mjs` / `designer-anchor-flow.mjs`
// 后者过去**完全没进扫描**（本门只认 from/to），本笔把它纳入：接缝是 `anchor`。
function seamKeysOf(scope) {
  if (scope.props.has('from') && scope.props.has('to')) return { fromKey: 'from', toKey: 'to', kind: 'from-to' };
  if (scope.props.has('anchor') && scope.props.has('replace')) return { fromKey: 'anchor', toKey: 'replace', kind: 'anchor-replace' };
  return null;
}

function collectValueTokens(tokens, start) {
  const collected = [];
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === 'punct' && ['{', '(', '['].includes(t.value)) depth += 1;
    else if (t.type === 'punct' && ['}', ')', ']'].includes(t.value)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (t.type === 'punct' && t.value === ',' && depth === 0) break;
    collected.push(t);
  }
  if (collected.length === 0) return { tokens: [], span: null };
  return { tokens: collected, span: { start: collected[0].start, end: collected[collected.length - 1].end } };
}

export function extractArms(source, file) {
  const { tokens, comments } = tokenize(source);
  const consts = collectConsts(tokens);
  const arms = [];
  const nonArms = [];
  const stack = [{ key: null, parent: null, props: new Map() }];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === 'punct' && token.value === '{') {
      let key = null;
      const colon = tokens[i - 1];
      const keyTok = tokens[i - 2];
      const beforeKey = tokens[i - 3];
      const keyInPropertyPosition = beforeKey && beforeKey.type === 'punct' && (beforeKey.value === '{' || beforeKey.value === ',');
      if (colon?.type === 'punct' && colon.value === ':' && keyTok && (keyTok.type === 'ident' || keyTok.type === 'string') && keyInPropertyPosition) {
        key = keyTok.value;
      }
      stack.push({ key, parent: stack[stack.length - 1], props: new Map() });
      continue;
    }
    if (token.type === 'punct' && token.value === '}') {
      const scope = stack.pop();
      const seam = scope ? seamKeysOf(scope) : null;
      if (scope && seam) {
        const arm = makeArm(scope, file, source, consts, seam.kind);
        if (arm.isArm) arms.push(arm);
        else nonArms.push(arm);
      }
      continue;
    }
    if (token.type === 'ident') {
      const before = tokens[i - 1];
      const next = tokens[i + 1];
      const inPropertyPosition = before && before.type === 'punct' && (before.value === '{' || before.value === ',');
      if (!inPropertyPosition || !(next && next.type === 'punct' && next.value === ':')) continue;
      const scope = stack[stack.length - 1];
      if (!scope.props.has(token.value)) scope.props.set(token.value, collectValueTokens(tokens, i + 2));
    }
  }
  return { arms, nonArms, comments, consts, tokens };
}

function armNameOf(scope) {
  let name = null;
  for (let s = scope; s; s = s.parent) if (s.key !== null) name = s.key;
  return name;
}

function firstStringProp(scope, key) {
  const value = scope.props.get(key);
  if (!value || value.tokens.length !== 1 || value.tokens[0].type !== 'string') return null;
  return value.tokens[0].value;
}

function makeArm(scope, file, source, consts, kind = 'from-to') {
  const fromExpr = scope.props.get(kind === 'anchor-replace' ? 'anchor' : 'from');
  const line = source.slice(0, fromExpr.span?.start ?? 0).split('\n').length;
  const name = armNameOf(scope);
  const resolved = resolveExpr(fromExpr.tokens, consts);
  const markers = [...scope.props.keys()].filter((key) => (kind === 'anchor-replace' ? ANCHOR_ARM_MARKERS : ARM_MARKERS).has(key));
  const isArm = resolved.ok || markers.length > 0;
  const declaredProp = scope.props.get('file');
  const declaredToken = declaredProp && declaredProp.tokens.length === 1 && declaredProp.tokens[0].type === 'string' ? declaredProp.tokens[0] : null;
  return {
    file,
    kind,
    name: name ?? `<未命名@${path.basename(file)}:${line}>`,
    line,
    declaredFile: firstStringProp(scope, 'file'),
    declaredFileSpan: declaredToken ? { start: declaredToken.start, end: declaredToken.end } : null,
    markers,
    fromRaw: fromExpr.span ? source.slice(fromExpr.span.start, fromExpr.span.end) : '',
    fromSpan: fromExpr.span,
    from: resolved.ok ? resolved.value : null,
    unresolvedReason: resolved.ok ? null : resolved.reason,
    isArm,
  };
}

// ── ⑥ 搜索：在仓库里（排除 node_modules/.git/一次性沙箱）某个文件里逐字找 ──────────────────────
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);

// ── ⑥d 「过去运行的记录」不进证据语料（见文件头「判据收紧之五」）───────────────────────────────
// 判据按**路径名**做，机械且可核：任一**目录段**叫 `logs` 或 `attempts` ⇒ 该文件不是今日状态的证据。
const RECORD_DIR_NAMES = new Set(['logs', 'attempts']);
export function isPastRunRecord(relative) {
  const segments = relative.split('/');
  return segments.slice(0, -1).some((segment) => RECORD_DIR_NAMES.has(segment));
}

async function walkFiles(directory, prefix = '', acc = []) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.sopho-')) continue; // 其它门的一次性副本（含从产品拷来的字节）不算一手来源
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walkFiles(path.join(directory, entry.name), relative, acc);
    else if (entry.isFile()) acc.push(relative);
  }
  return acc;
}

export async function loadSearchTexts(root) {
  const files = await walkFiles(root);
  const texts = new Map();
  for (const relative of files) {
    let buffer;
    try { buffer = await readFile(path.join(root, relative)); } catch { continue; }
    if (buffer.includes(0)) continue; // 二进制
    texts.set(relative, buffer.toString('utf8'));
  }
  return texts;
}

// 出现次数：与 findSeamInRepo 同一算法（非重叠、逐处前进），供「声明目标里恰好 1 处」这条判据用。
export function countOccurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

export function findSeamInRepo({ texts, needle, exclude = null }) {
  const hits = [];
  for (const [file, content] of texts) {
    if (file === exclude) continue;
    const at = content.indexOf(needle);
    if (at < 0) continue;
    let count = 0;
    for (let i = at; i >= 0; i = content.indexOf(needle, i + needle.length)) count += 1;
    hits.push({ file, count });
  }
  hits.sort((left, right) => left.file.localeCompare(right.file));
  return hits;
}

// ── ⑥b 声明目标（`file:`）的**显式**解析规则（fail-closed：解不出来就是红）───────────────────
// 臂里 `file:` 的两种写法都在用：仓根相对（`server/base-logic.mjs` / `pi-extensions/assistant/index.ts` / `docs/human/v2.2-lessons.md`）
// 与短名/子路径（`designer.js` / `render.js` / `index.html` / `fixtures/demo.json` / `toSvg.mjs`）。
// 规则（按序，只认唯一解）：
//   ① `declared` 恰好是一个仓内文件路径 ⇒ 用它；
//   ② 否则取所有「以 `/<declared>` 结尾」的仓内文件 ⇒ **恰好一个**才算解出来；
//   ③ 0 个（名字漂了 / 文件没了）/ 多个（有歧义 ⇒ 声明者必须写全路径）⇒ **解析失败**（调用方判红）。
export function resolveDeclaredFile({ files, declared }) {
  if (!declared) return { ok: false, file: null, how: null, reason: '这条臂没有声明目标文件', candidates: [] };
  const exact = files.filter((relative) => relative === declared);
  if (exact.length === 1) return { ok: true, file: exact[0], how: 'repo-relative', candidates: exact };
  if (exact.length > 1) return { ok: false, file: null, how: null, reason: `仓里有 ${exact.length} 个叫 ${declared} 的文件 ${JSON.stringify(exact)} —— 有歧义`, candidates: exact };
  const suffix = files.filter((relative) => relative.endsWith(`/${declared}`));
  if (suffix.length === 1) return { ok: true, file: suffix[0], how: 'unique-suffix', candidates: suffix };
  if (suffix.length === 0) return { ok: false, file: null, how: null, reason: `仓里既没有 ${declared}，也没有以 /${declared} 结尾的文件`, candidates: [] };
  return { ok: false, file: null, how: null, reason: `以 /${declared} 结尾的文件有 ${suffix.length} 个 ${JSON.stringify(suffix)} —— 有歧义，请声明完整仓内路径`, candidates: suffix };
}

// ── ⑥c 「没进扫描范围的臂」的机械台账（`bin/arm-seam-coverage.json`）──────────────────────────
// 臂标记：一个 `test/**/*.mjs` 里出现下面任一串，就认为它「带臂」（带臂却贡献不出可扫描的臂 ⇒ 要写台账）。
const ARM_FILE_MARKERS = ['--reverse', 'MUTANT', 'expectRed', 'anchor:'];
const COVERAGE_DECISIONS = new Set(['excluded', 'partial', 'not-an-arm']);

export async function loadCoverageFile(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (error) {
    return { path: file, ok: false, reason: `读不到覆盖台账 ${file}：${error?.message ?? error}`, entries: [] };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) {
    return { path: file, ok: false, reason: `覆盖台账 ${file} 不是合法 JSON：${error?.message ?? error}`, entries: [] };
  }
  if (!Array.isArray(parsed?.entries)) return { path: file, ok: false, reason: `覆盖台账 ${file} 里没有 entries 数组`, entries: [] };
  return { path: file, ok: true, reason: null, entries: parsed.entries };
}

// 核对台账：每条证据逐字核、分类与事实对齐，再机械核对「带臂却没进扫描」的文件是否漏登记。
// 一律从 `ROOT` 直接读被核对的文件（与 `--search-root` 无关，方便红半用别的搜索根）。
// `canonical` = 本次跑的就是仓原生臂目录（`<ROOT>/test`）—— 只有这时才拿「该文件贡献了几条臂」
// 去核 `decision`：红半故意用**子集**臂目录（比如只放一份 `designer-ui.mjs`），那种情形下
// 「其余文件 0 条臂」是预期的，不能拿来判台账分类错。
export async function auditCoverage({ coverage, markerFiles, armsPerRepoFile, canonical }) {
  const problems = [];
  const entries = [];
  if (!coverage.ok) return { entries, problems: [`覆盖台账不可用：${coverage.reason}`] };
  const tableFiles = new Set();
  for (const entry of coverage.entries) {
    const row = {
      file: typeof entry?.file === 'string' ? entry.file : null,
      shape: typeof entry?.shape === 'string' ? entry.shape : '',
      decision: entry?.decision ?? null,
      present: Array.isArray(entry?.present) ? entry.present : [],
      absent: Array.isArray(entry?.absent) ? entry.absent : [],
      reason: typeof entry?.reason === 'string' ? entry.reason.trim() : '',
    };
    if (!row.file) { problems.push('覆盖台账里有一条没有 file'); entries.push({ ...row, ok: false, contributed: 0, presentMissing: [], absentFound: [] }); continue; }
    tableFiles.add(row.file);
    if (!COVERAGE_DECISIONS.has(row.decision)) problems.push(`覆盖台账 ${row.file}：decision=${JSON.stringify(row.decision)} 不认识（只认 ${[...COVERAGE_DECISIONS].join(' / ')}）`);
    if (!row.shape) problems.push(`覆盖台账 ${row.file}：缺 shape（每条都必须写明「它是什么形状」）`);
    if (row.reason.length < 8) problems.push(`覆盖台账 ${row.file}：reason 太短 —— 必须逐条写明「为什么进不了现在的扫描」`);
    if (row.present.length === 0 && row.absent.length === 0) problems.push(`覆盖台账 ${row.file}：present/absent 都是空的（没有可机械核对的证据）`);
    let content = null;
    try { content = await readFile(path.join(ROOT, row.file), 'utf8'); } catch { content = null; }
    if (content === null) {
      problems.push(`覆盖台账 ${row.file}：仓里读不到这个文件（台账腐坏了）`);
      entries.push({ ...row, ok: false, contributed: armsPerRepoFile.get(row.file) ?? 0, presentMissing: [], absentFound: [] });
      continue;
    }
    const presentMissing = row.present.filter((needle) => !content.includes(needle));
    const absentFound = row.absent.filter((needle) => content.includes(needle));
    for (const needle of presentMissing) problems.push(`覆盖台账 ${row.file}：present 证据在文件里找不到 —— ${preview(needle, 60)}（台账腐坏 / 形状变了）`);
    for (const needle of absentFound) problems.push(`覆盖台账 ${row.file}：absent 证据居然在文件里找到了 —— ${preview(needle, 60)}（「这个文件没有臂」这条结论过期了）`);
    const contributed = armsPerRepoFile.get(row.file) ?? 0;
    if (canonical && row.decision !== 'partial' && contributed > 0) problems.push(`覆盖台账 ${row.file}：decision=${row.decision}，但它其实有 ${contributed} 条臂进了扫描（分类说错了）`);
    if (canonical && row.decision === 'partial' && contributed === 0) problems.push(`覆盖台账 ${row.file}：decision=partial，但它一条臂都没进扫描（分类说错了）`);
    entries.push({ ...row, ok: presentMissing.length === 0 && absentFound.length === 0, contributed, presentMissing, absentFound });
  }
  for (const item of markerFiles) {
    if ((armsPerRepoFile.get(item.repoFile) ?? 0) > 0) continue;
    if (tableFiles.has(item.repoFile)) continue;
    problems.push(`带臂标记的文件既没进扫描、也不在覆盖台账里：${item.repoFile}（标记 ${item.markers.join(', ')}）⇒ 要么把它的臂纳入扫描，要么写进 ${path.basename(COVERAGE_FILE)} 说明为什么不纳入`);
  }
  return { entries, problems };
}

// ── ⑦ 主扫描 ──────────────────────────────────────────────────────────────────────────────────
const NEGATIVE_PROBE = `SOPHO_ARM_SEAM_NEGATIVE_PROBE_${Math.random().toString(36).slice(2)}_${Date.now()}`;

function lineIndexer(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

async function runScan({ armsRoot, searchRoot, coverageFile }) {
  const armFiles = (await walkFiles(armsRoot)).filter((relative) => relative.endsWith('.mjs')).sort();
  const allTexts = await loadSearchTexts(searchRoot);
  // 「过去运行的记录」（logs/ 或 attempts/）不算证据：整类从证据语料里剔除，并把剔了哪些如实打印。
  const recordFiles = [...allTexts.keys()].filter(isPastRunRecord).sort();
  const texts = new Map([...allTexts].filter(([file]) => !isPastRunRecord(file)));
  const arms = [];
  const nonArms = [];
  const commentedFroms = [];
  const parseProblems = [];
  const markerFiles = [];
  for (const relative of armFiles) {
    const absolute = path.join(armsRoot, relative);
    let source;
    try { source = await readFile(absolute, 'utf8'); } catch (error) { parseProblems.push({ file: relative, reason: String(error?.message ?? error) }); continue; }
    // 臂标记（用于「没进扫描范围的臂」的台账核对）：带标记却贡献不出可扫描的臂 ⇒ 必须在台账里
    const markers = ARM_FILE_MARKERS.filter((marker) => source.includes(marker));
    if (markers.length > 0) markerFiles.push({ file: relative, repoFile: path.relative(ROOT, absolute).split(path.sep).join('/'), markers });
    let extracted;
    try {
      extracted = extractArms(source, relative);
      if (!extracted || !Array.isArray(extracted.arms) || !Array.isArray(extracted.nonArms) || !Array.isArray(extracted.comments)) {
        throw new Error('extractArms 返回的形状不对（抽取器被掏空/改坏了？）');
      }
    } catch (error) { parseProblems.push({ file: relative, reason: `词法/抽臂抛出：${error?.message ?? error}` }); continue; }
    arms.push(...extracted.arms);
    nonArms.push(...extracted.nonArms);
    const lineOf = lineIndexer(source);
    for (const comment of extracted.comments) {
      if (/(^|[^\w.$])from\s*:/.test(comment.text)) {
        commentedFroms.push({ file: relative, line: lineOf(comment.start), text: comment.text.replace(/\s+/g, ' ').slice(0, 110) });
      }
    }
  }

  // 臂目录在搜索根里的前缀（默认 `test`）：命中落在这个前缀之下 = 「只在臂目录/兄弟测试里」
  const armsPrefix = path.relative(searchRoot, armsRoot).split(path.sep).join('/');
  const insideArmsRoot = (file) => armsPrefix !== '' && !armsPrefix.startsWith('..') && (file === armsPrefix || file.startsWith(`${armsPrefix}/`));
  const repoFiles = [...texts.keys()];

  const results = arms.map((arm) => {
    const declared = arm.declaredFile ? resolveDeclaredFile({ files: repoFiles, declared: arm.declaredFile }) : null;
    if (!arm.from) return { ...arm, hits: [], verdict: 'unresolved', declared, outsideRootHits: 0, declaredHit: false };
    const absolute = path.join(armsRoot, arm.file);
    const relativeToSearch = path.relative(searchRoot, absolute);
    const exclude = relativeToSearch.startsWith('..') ? null : relativeToSearch;
    const hits = findSeamInRepo({ texts, needle: arm.from, exclude });
    return {
      ...arm,
      hits,
      verdict: hits.length > 0 ? 'hit' : 'mismatch',
      declared,
      outsideRootHits: hits.filter((hit) => !insideArmsRoot(hit.file)).length,
      declaredHit: Boolean(declared?.ok && hits.some((hit) => hit.file === declared.file)),
      // 判据收紧之四的读数：这条接缝在**它声明的那个文件**里出现几次（0 / 1 / N）
      declaredCount: declared?.ok ? countOccurrences(texts.get(declared.file) ?? '', arm.from) : null,
    };
  });

  const distribution = new Map();
  for (const result of results) {
    if (result.verdict !== 'hit') continue;
    const primary = result.declaredHit ? result.declared.file : result.hits[0].file;
    distribution.set(primary, (distribution.get(primary) ?? 0) + 1);
  }

  // 覆盖台账：把「没进扫描范围的臂」摆到台面上，并机械核对（见 auditCoverage）
  const canonical = path.resolve(armsRoot) === path.resolve(path.join(ROOT, 'test'));
  const coverage = await loadCoverageFile(coverageFile);
  const armsPerRepoFile = new Map();
  for (const arm of arms) {
    const absolute = path.join(armsRoot, arm.file);
    const repoFile = path.relative(ROOT, absolute).split(path.sep).join('/');
    armsPerRepoFile.set(repoFile, (armsPerRepoFile.get(repoFile) ?? 0) + 1);
  }
  const coverageAudit = await auditCoverage({ coverage, markerFiles, armsPerRepoFile, canonical });

  const negative = findSeamInRepo({ texts, needle: NEGATIVE_PROBE });
  const by = (verdict) => results.filter((arm) => arm.verdict === verdict);
  return {
    armsRoot,
    searchRoot,
    armsPrefix,
    coverageFile,
    armFiles,
    recordFiles,
    searchedFiles: texts.size,
    arms: results,
    nonArms,
    commentedFroms,
    parseProblems,
    markerFiles,
    coverage: { ...coverage, entries: coverageAudit.entries, problems: coverageAudit.problems },
    negative,
    distribution,
    summary: {
      armFiles: armFiles.length,
      searchedFiles: texts.size,
      recordFilesExcluded: recordFiles.length,
      arms: results.length,
      hit: by('hit').length,
      mismatch: by('mismatch').length,
      nonArms: nonArms.length,
      commentedFroms: commentedFroms.length,
      negativeProbeHits: negative.length,
      // 收紧判据的读数：只在臂目录里命中的臂 / 声明目标解析不出来的臂 / 声明目标里没命中的臂
      onlyArmsRootHits: by('hit').filter((arm) => arm.outsideRootHits === 0).length,
      // 臂目录是否在搜索根里：不在时「臂目录之外至少一处命中」判据停用（报告里明写 ✗ 不静默）
      armsRootInsideSearch: armsPrefix !== '' && !armsPrefix.startsWith('..'),
      declaredUnresolved: results.filter((arm) => arm.declared && !arm.declared.ok).length,
      declaredMiss: by('hit').filter((arm) => arm.declared?.ok && !arm.declaredHit).length,
      // 判据收紧之四：声明目标里出现 >1 次的臂（今天要 0；不为 0 就是「字符串替换会改错处」的嫌疑名单）
      declaredCountGtOne: results.filter((arm) => arm.declared?.ok && arm.declaredCount > 1).length,
      declaredArms: results.filter((arm) => arm.declared?.ok).length,
      // 覆盖台账的读数：覆盖了多少（机器数的臂）/ 已知未覆盖多少个文件（逐条登记的形状）
      armFilesWithArms: armsPerRepoFile.size,
      markerFiles: markerFiles.length,
      uncoveredFiles: coverageAudit.entries.length,
      uncoveredNotAnArm: coverageAudit.entries.filter((entry) => entry.decision === 'not-an-arm').length,
      uncoveredEvidence: coverageAudit.entries.reduce((sum, entry) => sum + entry.present.length + entry.absent.length, 0),
    },
  };
}

function printScan(scan) {
  out('── 反证臂接缝门 ───────────────────────────────────────────────────────────');
  out(`臂文件根：${scan.armsRoot}（${scan.armFiles.length} 个 .mjs）`);
  out(`搜索根　：${scan.searchRoot}（${scan.searchedFiles} 个文本文件进入证据语料；已排除 node_modules/.git/.sopho-*）`);
  // 过去运行的记录（logs/ 或 attempts/）：整类从证据语料里剔除（见「判据收紧之五」），按记录目录汇总打印。
  const recordRoots = new Map();
  for (const file of scan.recordFiles) {
    const segments = file.split('/');
    const at = segments.findIndex((segment) => segment === 'logs' || segment === 'attempts');
    const root = at < 0 ? file : segments.slice(0, at + 1).join('/');
    recordRoots.set(root, (recordRoots.get(root) ?? 0) + 1);
  }
  out(`证据纪律：过去运行的记录（目录段叫 logs/ 或 attempts/）**不算证据**，已剔除 ${scan.recordFiles.length} 个文件：`);
  for (const [root, count] of [...recordRoots].sort()) out(`  · ${root}/ — ${count} 个（引用了当时的状态，不是今日状态的证据）`);
  out(`覆盖台账：${scan.coverageFile}（已加载 ${scan.coverage.ok ? '✓' : '✗'}）`);
  if (scan.summary.armsRootInsideSearch === false) {
    out(`⚠ 臂目录（${scan.armsRoot}）不在搜索根（${scan.searchRoot}）里 ⇒ 「臂目录之外至少一处命中」这条判据本次**停用**（不静默）`);
  }
  out('');
  out(`逐条臂（✓ 命中 / ✗ 失配 / ? 静态求不出来；接缝形状中 ${scan.arms.filter((arm) => arm.kind === 'anchor-replace').length} 条是 anchor/replace）：`);
  for (const arm of scan.arms) {
    const declared = arm.declaredFile
      ? ` 声明目标:${arm.declaredFile}${arm.declared?.ok ? `（⇒ ${arm.declared.file}，${arm.declared.how}）` : '（**解析不出来**）'}`
      : '';
    if (arm.verdict === 'hit') {
      const outside = arm.outsideRootHits > 0 ? `臂目录外命中 ${arm.outsideRootHits} 处 ✓` : '**臂目录（兄弟测试）之外 0 处命中 ✗**';
      out(`  ✓ ${arm.file} :: ${arm.name}${declared}`);
      out(`      from: ${preview(arm.from)}`);
      out(`      命中: ${arm.hits.map((hit) => `${hit.file}${hit.count > 1 ? `×${hit.count}` : ''}`).join(', ')}（${outside}${arm.declared?.ok ? `；声明的目标里${arm.declaredHit ? `命中 ${arm.declaredCount} 次${arm.declaredCount === 1 ? ' ✓' : ' ✗（要求恰好 1 次）'}` : '没有这条接缝 ✗'}` : ''}）`);
    } else if (arm.verdict === 'mismatch') {
      out(`  ✗ ${arm.file} :: ${arm.name} —— **失配**：from 在仓库里任何文件里都找不到${declared}`);
      out(`      from: ${preview(arm.from)}`);
    } else {
      out(`  ? ${arm.file} :: ${arm.name} —— **静态求不出来**（${arm.unresolvedReason}）`);
      out(`      from 原文: ${preview(arm.fromRaw)}`);
    }
  }
  out('');
  for (const problem of scan.parseProblems) out(`  ⚠ 读/解析失败：${problem.file} —— ${problem.reason}`);
  out(`被注释掉的 from:（**已排除**，不算臂）：${scan.commentedFroms.length} 条`);
  for (const item of scan.commentedFroms) out(`  · ${item.file}:${item.line}  ${item.text}`);
  out(`同名但不是臂的 from/to 对（没有臂标记，已忽略）：${scan.nonArms.length} 条`);
  for (const item of scan.nonArms) out(`  · ${item.file} :: ${item.name} —— from 原文: ${preview(item.fromRaw, 60)}`);
  out('');
  out('── 没进扫描范围的臂（机械台账）─────────────────────────────────────────────');
  out(`带臂标记（${ARM_FILE_MARKERS.join(' / ')}）的 .mjs：${scan.markerFiles.length} 个`);
  out(`其中贡献了可扫描臂的文件：${scan.summary.armFilesWithArms} 个（共 ${scan.summary.arms} 条臂）`);
  out(`已知未覆盖的臂文件（台账逐条登记，共 ${scan.coverage.entries.length} 个文件 / ${scan.summary.uncoveredEvidence} 条证据；其中 ${scan.summary.uncoveredNotAnArm} 条是「其实没有臂」的实情记录）：`);
  for (const entry of scan.coverage.entries) {
    const contributed = entry.decision === 'partial' ? `（同一文件里另有 ${entry.contributed} 条进扫描的臂）` : '';
    out(`  · ${entry.file}［${entry.shape}／${entry.decision}］${contributed}`);
    out(`      证据：present=${JSON.stringify(entry.present)}${entry.absent.length ? ` absent=${JSON.stringify(entry.absent)}` : ''}`);
    out(`      理由：${entry.reason}`);
    for (const needle of entry.presentMissing) out(`      ⚠ present 证据在文件里找不到：${preview(needle, 60)}`);
    for (const needle of entry.absentFound) out(`      ⚠ absent 证据居然在文件里找到了：${preview(needle, 60)}`);
  }
  out('');
  out(`汇总：扫到 ${scan.summary.arms} 条臂（命中 ${scan.summary.hit} / 失配 ${scan.summary.mismatch}；只在臂目录里命中 ${scan.summary.onlyArmsRootHits}；声明目标解析不出来 ${scan.summary.declaredUnresolved} / 声明目标里没命中 ${scan.summary.declaredMiss} / 声明目标里出现 >1 次 ${scan.summary.declaredCountGtOne}）`);
  out(`覆盖读数：进扫描 ${scan.summary.arms} 条臂 / ${scan.summary.armFilesWithArms} 个臂文件；已知未覆盖 ${scan.coverage.entries.length} 个臂文件（逐条形状与理由见上）`);
  out('命中分布（每条臂的声明目标或首个命中文件 → 被几条臂盯着）：');
  for (const [file, count] of [...scan.distribution].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    out(`  ${file} — ${count} 条`);
  }
}

function judge(scan) {
  const problems = [];
  if (scan.armFiles.length === 0) problems.push(`扫到 0 个臂文件（${scan.armsRoot}）—— 扫描失去 reach`);
  if (scan.arms.length === 0) problems.push(`扫到 0 条臂（${scan.armsRoot}）—— 扫描失去 reach`);
  for (const arm of scan.arms) {
    if (arm.verdict === 'mismatch') problems.push(`臂失配：${arm.file} :: ${arm.name}（from 在仓库里找不到：${preview(arm.from, 60)}）`);
    else if (arm.verdict === 'unresolved') problems.push(`臂的 from 静态求不出来：${arm.file} :: ${arm.name}（${arm.unresolvedReason}）`);
    if (arm.verdict !== 'hit') continue;
    // 收紧判据之一：接缝不能只在臂目录（默认 test/）里还在
    if (arm.outsideRootHits === 0) {
      problems.push(`臂只在臂目录（${scan.armsPrefix}/）里命中，接缝已从产品里消失：${arm.file} :: ${arm.name}`
        + `（命中：${arm.hits.map((hit) => hit.file).join(', ')}）—— 兄弟测试里的同一串不能给臂作证`);
    }
    // 收紧判据之二：声明了目标文件的臂，必须在那个目标文件里命中（解析 fail-closed）
    if (arm.declaredFile) {
      if (!arm.declared.ok) problems.push(`臂声明的目标文件解析不出来：${arm.file} :: ${arm.name}（file: ${JSON.stringify(arm.declaredFile)} —— ${arm.declared.reason}）`);
      else if (!arm.declaredHit) problems.push(`臂声明的目标 ${arm.declared.file} 里没有这条接缝：${arm.file} :: ${arm.name}（实际命中：${arm.hits.map((hit) => hit.file).join(', ') || '无'}）`);
      // 判据收紧之四：恰好 1 处（`String.replace` 配字符串只改第一处 ⇒ 出现两次就会改错处 = 假臂）
      else if (arm.declaredCount !== 1) problems.push(`臂声明的目标 ${arm.declared.file} 里这条接缝出现 ${arm.declaredCount} 次（要求**恰好 1 次**）：${arm.file} :: ${arm.name} —— String.replace 配字符串只改第一处，改到别处就等于这条臂没动它该动的接缝（假臂）`);
    }
  }
  if (scan.negative.length > 0) problems.push(`负控制失败：一个绝不可能存在的串居然命中 ${scan.negative.map((hit) => hit.file).join(', ')}`);
  for (const problem of scan.parseProblems) problems.push(`读/解析失败：${problem.file}（${problem.reason}）`);
  for (const problem of scan.coverage.problems) problems.push(`覆盖台账：${problem}`);
  return problems;
}

// ── ⑧ 红半：正控制两条 ＋ 反证臂九条（一律打副本）─────────────────────────────────────────────
const selfChecks = [];
function recordSelf(id, name, ok, detail) {
  selfChecks.push({ id, name, ok: Boolean(ok), detail });
  out(`${ok ? '✓' : '✗'} [${id}] ${name} —— ${detail}`);
  return Boolean(ok);
}

async function runNode(script, args) {
  try {
    const reply = await execFileAsync(process.execPath, [script, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000 });
    return { code: 0, output: `${reply.stdout}\n${reply.stderr}` };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, output: `${error.stdout ?? ''}\n${error.stderr ?? ''}` };
  }
}

async function withTemp(prefix, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function parseJsonRun(output) {
  const at = output.indexOf('{');
  if (at < 0) return null;
  try { return JSON.parse(output.slice(at)); } catch { return null; }
}

const GATE_SOURCE = await readFile(GATE_FILE, 'utf8');

async function runSelfTests() {
  out('══ 红半：正控制两条 ＋ 反证臂九条（都在副本上，真树一个字不动）═════════════════════════');
  const anchorFile = 'designer-ui.mjs';
  const anchorArm = 'fill-as-fixed';
  const anchorSource = await readFile(path.join(ROOT, 'test', anchorFile), 'utf8');

  // 正控制 A：把某条臂的 from 换成一个仓库里不存在的串 ⇒ 门必红、且点名那条臂（同一份副本不改时必绿）。
  const pcA = await withTemp('sopho-armseam-pc-a-', async (dir) => {
    const { arms } = extractArms(anchorSource, anchorFile);
    const arm = arms.find((candidate) => candidate.name === anchorArm);
    if (!arm || !arm.fromSpan) return { ok: false, detail: `副本里找不到臂 ${anchorArm}，正控制无法成立` };
    const baselineDir = path.join(dir, 'baseline');
    const mutatedDir = path.join(dir, 'mutated');
    await mkdir(baselineDir, { recursive: true });
    await mkdir(mutatedDir, { recursive: true });
    await writeFile(path.join(baselineDir, anchorFile), anchorSource, 'utf8');
    const bogus = `__SOPHO_ARMSEAM_PC_A_${Date.now()}_${Math.random().toString(36).slice(2)}_不存在的接缝__`;
    const mutated = `${anchorSource.slice(0, arm.fromSpan.start)}${JSON.stringify(bogus)}${anchorSource.slice(arm.fromSpan.end)}`;
    await writeFile(path.join(mutatedDir, anchorFile), mutated, 'utf8');
    const baseRun = await runNode(GATE_FILE, [`--arms-root=${baselineDir}`, `--search-root=${ROOT}`, `--root=${ROOT}`, `--coverage=${COVERAGE_FILE}`]);
    const run = await runNode(GATE_FILE, [`--arms-root=${mutatedDir}`, `--search-root=${ROOT}`, `--root=${ROOT}`, `--coverage=${COVERAGE_FILE}`]);
    const named = run.output.includes(anchorArm);
    const redLine = run.output.split('\n').find((line) => line.includes(anchorArm) && line.includes('失配')) ?? '(没找到点名那条臂的红行)';
    return {
      ok: baseRun.code === 0 && run.code !== 0 && named,
      detail: `同一份副本不改时退出码 ${baseRun.code}（要 0）；把臂 ${anchorArm} 的 from 改成一个仓库里不存在的串后退出码 ${run.code}（要非 0）${named ? '' : '；**没有点名那条臂**'}；红行：${redLine.trim()}`,
    };
  });
  recordSelf('self:positive-control', '正控制：改坏一条臂的 from ⇒ 门必红并点名那条臂', pcA.ok, pcA.detail);

  // 正控制 B：塞一条**整个被注释掉**的假臂（from 不存在）⇒ 门必须仍然绿、且不许出现那条假臂。
  const pcB = await withTemp('sopho-armseam-pc-b-', async (dir) => {
    const baselineDir = path.join(dir, 'baseline');
    const ghostDir = path.join(dir, 'ghost');
    await mkdir(baselineDir, { recursive: true });
    await mkdir(ghostDir, { recursive: true });
    await writeFile(path.join(baselineDir, anchorFile), anchorSource, 'utf8');
    const ghostFrom = `SOPHO_ARMSEAM_GHOST_FROM_${Date.now()}_${Math.random().toString(36).slice(2)}_绝不存在的接缝`;
    const ghost = `\n// 下面这一整条是**注释**：门不许把它当成一条臂\n// 'ghost-arm': { from: '${ghostFrom}', to: 'x', expect: [] },\n`;
    await writeFile(path.join(ghostDir, anchorFile), anchorSource + ghost, 'utf8');
    const baseRun = await runNode(GATE_FILE, [`--arms-root=${baselineDir}`, `--search-root=${ROOT}`, `--root=${ROOT}`, `--coverage=${COVERAGE_FILE}`, '--json']);
    const ghostRun = await runNode(GATE_FILE, [`--arms-root=${ghostDir}`, `--search-root=${ROOT}`, `--root=${ROOT}`, `--coverage=${COVERAGE_FILE}`, '--json']);
    const base = parseJsonRun(baseRun.output);
    const ghostJson = parseJsonRun(ghostRun.output);
    return {
      ok: baseRun.code === 0 && ghostRun.code === 0 && !ghostRun.output.includes('ghost-arm')
        && (base?.summary?.arms ?? 0) > 0 && base?.summary?.arms === ghostJson?.summary?.arms,
      detail: `基线：退出码 ${baseRun.code}、臂 ${base?.summary?.arms}；塞一条整条注释掉的假臂后：退出码 ${ghostRun.code}、臂 ${ghostJson?.summary?.arms}；`
        + `${ghostRun.output.includes('ghost-arm') ? '**假臂被算成真的了**' : '假臂未被算进臂清单'}`,
    };
  });
  recordSelf('self:comment-exclusion', '正控制：注释里的 from: 不算是臂（塞一条注释假臂 ⇒ 门仍绿且不出现它）', pcB.ok, pcB.detail);

  // 反证臂 ①：把本门脚本副本的 extractArms() 掏空成 return [] ⇒ 门必红。
  const raHollowScan = await withTemp('sopho-armseam-ra-scan-', async (dir) => {
    const anchor = 'export function extractArms(source, file) {\n  const { tokens, comments } = tokenize(source);';
    if (!GATE_SOURCE.includes(anchor)) return { ok: false, detail: '反证臂锚点漂了（extractArms 开头）—— 请跟着改本门的自检' };
    const mutated = GATE_SOURCE.replace(anchor, 'export function extractArms(source, file) {\n  return []; // REVERSE ARM hollow-scan：掏空扫描\n  const { tokens, comments } = tokenize(source);');
    const file = path.join(dir, 'gate-hollow-scan.mjs');
    await writeFile(file, mutated, 'utf8');
    const run = await runNode(file, [`--arms-root=${path.join(ROOT, 'test')}`, `--search-root=${ROOT}`, `--root=${ROOT}`, `--coverage=${COVERAGE_FILE}`]);
    const redLine = run.output.split('\n').find((line) => line.includes('extractArms 返回的形状不对')) ?? '(没找到预期的红行)';
    return {
      ok: run.code !== 0 && run.output.includes('extractArms 返回的形状不对'),
      detail: `掏空扫描（extractArms 直接 return []）后退出码 ${run.code}（要非 0）；红行：${redLine.trim()}`,
    };
  });
  recordSelf('self:reverse-hollow-scan', '反证臂①：extractArms() 掏空成 return [] ⇒ 门必红（抽取器返回形状不对）', raHollowScan.ok, raHollowScan.detail);

  // 反证臂 ②：把本门脚本副本的 findSeamInRepo() 掏空成「永远说找到了」⇒ 门必红（负控制）。
  const raHollowMatch = await withTemp('sopho-armseam-ra-match-', async (dir) => {
    const anchor = 'export function findSeamInRepo({ texts, needle, exclude = null }) {\n  const hits = [];';
    if (!GATE_SOURCE.includes(anchor)) return { ok: false, detail: '反证臂锚点漂了（findSeamInRepo 开头）—— 请跟着改本门的自检' };
    const mutated = GATE_SOURCE.replace(anchor, 'export function findSeamInRepo({ texts, needle, exclude = null }) {\n  return [{ file: "(REVERSE ARM hollow-match：永远说找到了)", count: 1 }];\n  const hits = [];');
    const file = path.join(dir, 'gate-hollow-match.mjs');
    await writeFile(file, mutated, 'utf8');
    const run = await runNode(file, [`--arms-root=${path.join(ROOT, 'test')}`, `--search-root=${ROOT}`, `--root=${ROOT}`, `--coverage=${COVERAGE_FILE}`]);
    const redLine = run.output.split('\n').find((line) => line.includes('负控制失败')) ?? '(没找到预期的红行)';
    return {
      ok: run.code !== 0 && run.output.includes('负控制失败'),
      detail: `掏空匹配后退出码 ${run.code}（要非 0）；红行：${redLine.trim()}`,
    };
  });
  recordSelf('self:reverse-hollow-match', '反证臂②：findSeamInRepo() 掏空成永远命中 ⇒ 门必红（负控制）', raHollowMatch.ok, raHollowMatch.detail);

  // 反证臂 ③（判据收紧之一的牙）：把产品里那两条接缝的字节从搜索树里拿掉、只留兄弟测试 ⇒ 必红。
  // 背景：2026-09-20 总台独立打实的那个洞（本门当时 86/86 照样绿）。
  const raSiblingOnly = await withTemp('sopho-armseam-ra-sibling-', async (dir) => {
    const pair = ['cache-ctime-cost.mjs', 'cache-identity-ctime.mjs'];
    const withProduct = path.join(dir, 'with-product');
    const siblingOnly = path.join(dir, 'sibling-only');
    for (const target of [withProduct, siblingOnly]) await mkdir(path.join(target, 'test'), { recursive: true });
    for (const name of pair) {
      const source = await readFile(path.join(ROOT, 'test', name), 'utf8');
      await writeFile(path.join(withProduct, 'test', name), source, 'utf8');
      await writeFile(path.join(siblingOnly, 'test', name), source, 'utf8');
    }
    // with-product：产品那一份（含那两条接缝）也在搜索树里 ⇒ 臂目录之外有命中 ⇒ 绿
    const product = await readFile(path.join(ROOT, 'server', 'base-logic.mjs'), 'utf8');
    await mkdir(path.join(withProduct, 'server'), { recursive: true });
    await writeFile(path.join(withProduct, 'server', 'base-logic.mjs'), product, 'utf8');
    const args = (tree) => [`--arms-root=${path.join(tree, 'test')}`, `--search-root=${tree}`, `--root=${ROOT}`, `--coverage=${COVERAGE_FILE}`];
    const greenRun = await runNode(GATE_FILE, args(withProduct));
    const redRun = await runNode(GATE_FILE, args(siblingOnly));
    const redLines = redRun.output.split('\n').filter((line) => line.startsWith('✗ 臂只在臂目录'));
    const namedBoth = pair.every((name) => redLines.some((line) => line.includes(name)));
    return {
      ok: greenRun.code === 0 && redRun.code !== 0 && namedBoth && redLines.length >= 2,
      detail: `同形状但产品在树里时退出码 ${greenRun.code}（要 0）；只留兄弟测试时退出码 ${redRun.code}（要非 0）`
        + `；新判据红行 ${redLines.length} 条（两条兄弟文件各自的臂都该红）${namedBoth ? '、且两个文件都被点名了' : '；**没有同时点名那两个文件**'}`
        + `；红行：${redLines.map((line) => line.trim().slice(0, 120)).join(' ｜ ') || '(没找到)'}`,
    };
  });
  recordSelf('self:reverse-sibling-only', '反证臂③：接缝只剩兄弟测试还在（产品里已删）⇒ 门必红并点名那两条臂', raSiblingOnly.ok, raSiblingOnly.detail);

  // 反证臂 ④（判据收紧之二的牙）：声明目标 (a) 里没有这条接缝 / (b) 根本解析不出来 ⇒ 都必红。
  const raDeclared = await withTemp('sopho-armseam-ra-declared-', async (dir) => {
    const { arms } = extractArms(anchorSource, anchorFile);
    const arm = arms.find((candidate) => candidate.name === anchorArm);
    if (!arm || !arm.declaredFileSpan) return { ok: false, detail: `副本里找不到带 file: 的臂 ${anchorArm}，反证臂无法成立` };
    const rewrite = (value) => `${anchorSource.slice(0, arm.declaredFileSpan.start)}${JSON.stringify(value)}${anchorSource.slice(arm.declaredFileSpan.end)}`;
    const variants = [
      { id: 'baseline', source: anchorSource, wantRed: false },
      { id: 'wrong-file', source: rewrite('render.js'), wantRed: true, keyword: '里没有这条接缝' },
      { id: 'missing-file', source: rewrite('sopho-no-such-file-xyz.js'), wantRed: true, keyword: '解析不出来' },
    ];
    const parts = [];
    let ok = true;
    for (const variant of variants) {
      const variantDir = path.join(dir, variant.id);
      await mkdir(variantDir, { recursive: true });
      await writeFile(path.join(variantDir, anchorFile), variant.source, 'utf8');
      const run = await runNode(GATE_FILE, [`--arms-root=${variantDir}`, `--search-root=${ROOT}`, `--root=${ROOT}`, `--coverage=${COVERAGE_FILE}`]);
      const redLine = run.output.split('\n').find((line) => line.includes(arm.name) && line.includes('✗')) ?? '(没找到点名的红行)';
      const passed = variant.wantRed ? (run.code !== 0 && run.output.includes(variant.keyword)) : run.code === 0;
      ok = ok && passed;
      parts.push(`${variant.id}: 退出码 ${run.code}${variant.wantRed ? `（要非 0）关键词「${variant.keyword}」${run.output.includes(variant.keyword) ? '命中' : '**缺失**'}` : '（要 0）'}${variant.wantRed ? `；红行：${redLine.trim().slice(0, 140)}` : ''}`);
    }
    return { ok, detail: `臂 ${arm.name} 的 file: 原值 ${JSON.stringify(arm.declaredFile)}；${parts.join('；')}` };
  });
  recordSelf('self:reverse-declared-target', '反证臂④：声明目标里没这条接缝 / 目标名解析不出来 ⇒ 门都必红', raDeclared.ok, raDeclared.detail);

  // 反证臂 ④b：「名字在仓里有多个候选 ⇒ 一律红」这一支的牙（2026-09-27 它在主干上真的抓到过一条）。
  // 两个候选**都含**这条接缝时也必须红（fail-closed：不替声明者猜「那个文件」是哪一个）；
  // 只有一个候选时仍绿。
  const raDeclaredAmbiguous = await withTemp('sopho-armseam-ra-ambig-', async (dir) => {
    const seam = `const SOPHO_AMBIG_SEAM_${Date.now()} = 1;`;
    const armsDir = path.join(dir, 'arms');
    await mkdir(armsDir, { recursive: true });
    await writeFile(path.join(armsDir, 'dual.mjs'), [
      'const ARMS = {',
      '  dual: {',
      "    file: 'shared.json',",
      `    from: ${JSON.stringify(seam)},`,
      "    to: 'replaced',",
      "    what: '反证臂：声明一个在仓里有两个候选的名字',",
      '  },',
      '};',
      '',
    ].join('\n'), 'utf8');
    const trees = {};
    for (const variant of ['single', 'dual']) {
      const tree = path.join(dir, variant);
      const dirs = variant === 'single' ? ['a'] : ['a', 'b'];
      for (const name of dirs) {
        await mkdir(path.join(tree, name), { recursive: true });
        // 两个候选都含接缝：即使内容都「对」，有歧义照样红
        await writeFile(path.join(tree, name, 'shared.json'), `{"${name}": 1}\n// ${seam}\n`, 'utf8');
      }
      trees[variant] = tree;
    }
    const args = (tree) => [`--arms-root=${armsDir}`, `--search-root=${tree}`, `--root=${ROOT}`, `--coverage=${COVERAGE_FILE}`];
    const greenRun = await runNode(GATE_FILE, args(trees.single));
    const redRun = await runNode(GATE_FILE, args(trees.dual));
    const keyword = '有歧义';
    const redLine = redRun.output.split('\n').find((line) => line.includes(keyword)) ?? '(没找到预期的红行)';
    return {
      ok: greenRun.code === 0 && redRun.code !== 0 && redRun.output.includes(keyword) && redRun.output.includes('shared.json'),
      detail: `只有一个候选（含接缝）时退出码 ${greenRun.code}（要 0）；两个候选**都含**接缝时退出码 ${redRun.code}（要非 0，不替声明者猜）`
        + `；红行：${redLine.trim().slice(0, 190)}`,
    };
  });
  recordSelf('self:reverse-declared-ambiguous', '反证臂④b：声明的名字在仓里有多个候选 ⇒ 必红（一律 fail-closed，不许猜）', raDeclaredAmbiguous.ok, raDeclaredAmbiguous.detail);

  // 反证臂 ⑤（台账完整性判据的牙）：带臂标记、却连一条可扫描臂都贡献不出、又不在台账里 ⇒ 必红。
  const raCoverageGhost = await withTemp('sopho-armseam-ra-covghost-', async (dir) => {
    const cleanDir = path.join(dir, 'clean', 'test');
    const ghostDir = path.join(dir, 'ghost', 'test');
    await mkdir(cleanDir, { recursive: true });
    await mkdir(ghostDir, { recursive: true });
    await writeFile(path.join(cleanDir, anchorFile), anchorSource, 'utf8');
    await writeFile(path.join(ghostDir, anchorFile), anchorSource, 'utf8');
    // 一份带 `--reverse` 标记、但没有任何 from:/to: / anchor:/replace: 的文件（新臂的「漏登记」形状）
    const ghostSource = `#!/usr/bin/env node\n// 反证臂：node test/ghost-marker.mjs --reverse\n// 这个文件故意一条可扫描的臂都没有\nprocess.exitCode = 0;\n`;
    await writeFile(path.join(ghostDir, 'ghost-marker.mjs'), ghostSource, 'utf8');
    const args = (testDir) => [`--arms-root=${testDir}`, `--search-root=${ROOT}`, `--root=${ROOT}`, `--coverage=${COVERAGE_FILE}`];
    const cleanRun = await runNode(GATE_FILE, args(cleanDir));
    const ghostRun = await runNode(GATE_FILE, args(ghostDir));
    const keyword = '既没进扫描、也不在覆盖台账里';
    const redLine = ghostRun.output.split('\n').find((line) => line.includes(keyword)) ?? '(没找到预期的红行)';
    return {
      ok: cleanRun.code === 0 && ghostRun.code !== 0 && ghostRun.output.includes(keyword) && ghostRun.output.includes('ghost-marker.mjs'),
      detail: `不带 ghost 文件时退出码 ${cleanRun.code}（要 0）；塞一个带臂标记但零条可扫描臂的 ghost-marker.mjs 后退出码 ${ghostRun.code}（要非 0）；`
        + `红行：${redLine.trim().slice(0, 160)}`,
    };
  });
  recordSelf('self:reverse-coverage-ghost', '反证臂⑤：带臂标记却没进扫描、又不在台账里 ⇒ 门必红并点名那个文件', raCoverageGhost.ok, raCoverageGhost.detail);

  // 反证臂 ⑥（台账证据/分类判据的牙）：present 证据腐坏 / decision 与事实相反 ⇒ 都必红。
  const raCoverageRot = await withTemp('sopho-armseam-ra-covrot-', async (dir) => {
    const table = JSON.parse(await readFile(COVERAGE_FILE, 'utf8'));
    const rotten = JSON.parse(JSON.stringify(table));
    rotten.entries[0].present = [...rotten.entries[0].present, `__SOPHO_TABLE_ROT_${Date.now()}__`];
    const misclassified = JSON.parse(JSON.stringify(table));
    misclassified.entries.push({
      file: 'test/designer-ui.mjs', shape: 'flag-copy-patch', decision: 'excluded',
      present: ['--reverse-arm'], reason: '（反证臂：故意把一个「有臂进扫描」的文件写成 excluded）',
    });
    const rottenFile = path.join(dir, 'rotten.json');
    const misclassifiedFile = path.join(dir, 'misclassified.json');
    await writeFile(rottenFile, JSON.stringify(rotten, null, 2), 'utf8');
    await writeFile(misclassifiedFile, JSON.stringify(misclassified, null, 2), 'utf8');
    const baseRun = await runNode(GATE_FILE, [`--coverage=${COVERAGE_FILE}`]);
    const rottenRun = await runNode(GATE_FILE, [`--coverage=${rottenFile}`]);
    const misclassRun = await runNode(GATE_FILE, [`--coverage=${misclassifiedFile}`]);
    const rotKeyword = 'present 证据在文件里找不到';
    const classKeyword = '但它其实有';
    const rotLine = rottenRun.output.split('\n').find((line) => line.includes(rotKeyword)) ?? '(没找到预期的红行)';
    const classLine = misclassRun.output.split('\n').find((line) => line.includes(classKeyword)) ?? '(没找到预期的红行)';
    return {
      ok: baseRun.code === 0 && rottenRun.code !== 0 && rottenRun.output.includes(rotKeyword)
        && misclassRun.code !== 0 && misclassRun.output.includes(classKeyword),
      detail: `真台账基线退出码 ${baseRun.code}（要 0）；塞一条文件里没有的 present 证据后退出码 ${rottenRun.code}（要非 0）；`
        + `把「有臂进扫描」的文件写成 decision=excluded 后退出码 ${misclassRun.code}（要非 0）；`
        + `红行：${rotLine.trim().slice(0, 130)} ｜ ${classLine.trim().slice(0, 130)}`,
    };
  });
  recordSelf('self:reverse-coverage-rot', '反证臂⑥：台账 present 证据腐坏 / decision 与事实相反 ⇒ 门都必红', raCoverageRot.ok, raCoverageRot.detail);

  // 反证臂 ⑧（判据收紧之四的牙）：同一串接缝在**声明的那个文件**里放两处 ⇒ 门必红（点名出现次数）；
  // 只放一处的同一棵树仍绿 —— 证明它红的是「次数 > 1」，不是「形状不对 / 名字漂了」。
  const raDeclaredCount = await withTemp('sopho-armseam-ra-count-', async (dir) => {
    const seam = `const SOPHO_DECLARED_COUNT_SEAM_${Date.now()}_${Math.random().toString(36).slice(2)} = 1;`;
    const armsDir = path.join(dir, 'arms');
    await mkdir(armsDir, { recursive: true });
    await writeFile(path.join(armsDir, 'twice.mjs'), [
      'const ARMS = {',
      '  twice: {',
      "    file: 'shared.js',",
      `    from: ${JSON.stringify(seam)},`,
      "    to: 'replaced',",
      "    what: '反证臂：这条接缝在它声明的那个文件里出现两次',",
      '  },',
      '};',
      '',
    ].join('\n'), 'utf8');
    const trees = {};
    for (const variant of ['once', 'twice']) {
      const tree = path.join(dir, variant);
      await mkdir(path.join(tree, 'web'), { recursive: true });
      // 「两处」正是那个真实成因的形状：新函数里有一行与旧接缝**逐字相同**
      const body = variant === 'once'
        ? `${seam}\n`
        : `${seam}\n// （造成重复的典型成因：新函数里那行与旧接缝逐字相同）\n${seam}\n`;
      await writeFile(path.join(tree, 'web', 'shared.js'), `${body}export const unrelated = 1;\n`, 'utf8');
      trees[variant] = tree;
    }
    const args = (tree) => [`--arms-root=${armsDir}`, `--search-root=${tree}`, `--root=${ROOT}`, `--coverage=${COVERAGE_FILE}`];
    const greenRun = await runNode(GATE_FILE, args(trees.once));
    const redRun = await runNode(GATE_FILE, args(trees.twice));
    const keyword = '出现 2 次';
    const redLine = redRun.output.split('\n').find((line) => line.includes(keyword)) ?? '(没找到预期的红行)';
    return {
      ok: greenRun.code === 0 && redRun.code !== 0 && redRun.output.includes(keyword) && redRun.output.includes('恰好 1 次'),
      detail: `同一串接缝在声明目标里恰好 1 处时退出码 ${greenRun.code}（要 0）；放两处时退出码 ${redRun.code}（要非 0）`
        + `；红行：${redLine.trim().slice(0, 200)}`,
    };
  });
  recordSelf('self:reverse-declared-count', '反证臂⑧：接缝在声明的目标文件里出现两次 ⇒ 门必红（出现次数必须是 1）', raDeclaredCount.ok, raDeclaredCount.detail);

  // 反证臂 ⑨（「过去运行的记录不算证据」的牙，2026-10-05 加）：一条**未声明目标**的臂，接缝只出现在
  // 一份 `logs/` 记录里（产品里没有）⇒ 门必红（记录不算证据）；同一棵树里把接缝放回一个产品文件 ⇒ 绿。
  // 这一支复现的是一个**真实的假绿**：检入的 `gate-final-test_armseams.txt` 里逐字印着 52 条臂的 `from`，
  // 删掉产品里那条接缝后门照样 PASS（2026-10-05 实测），只有把它从证据语料里去掉才会红。
  const raRecordNotEvidence = await withTemp('sopho-armseam-ra-record-', async (dir) => {
    const seam = `const SOPHO_RECORD_SEAM_${Date.now()}_${Math.random().toString(36).slice(2)} = 1;`;
    const armSource = [
      'const ARMS = {',
      '  record: {',
      `    from: ${JSON.stringify(seam)},`,
      "    to: 'replaced',",
      "    what: '反证臂：接缝只出现在过去运行的记录里',",
      '  },',
      '};',
      '',
    ].join('\n');
    const trees = {};
    for (const variant of ['record-only', 'with-product']) {
      const tree = path.join(dir, variant);
      await mkdir(path.join(tree, 'test'), { recursive: true });
      await mkdir(path.join(tree, 'logs'), { recursive: true });
      await writeFile(path.join(tree, 'test', 'record.mjs'), armSource, 'utf8');
      // 记录里**逐字印着**这条接缝（照真日志的形状：它引用了当时量到的那串）
      await writeFile(path.join(tree, 'logs', 'gate-final-test_armseams.txt'), `上一次跑的记录里引用了这条接缝：\n      from: ${seam}\n`, 'utf8');
      if (variant === 'with-product') {
        await mkdir(path.join(tree, 'web'), { recursive: true });
        await writeFile(path.join(tree, 'web', 'product.js'), `${seam}\n`, 'utf8');
      }
      trees[variant] = tree;
    }
    const args = (tree) => [`--arms-root=${path.join(tree, 'test')}`, `--search-root=${tree}`, `--root=${ROOT}`, `--coverage=${COVERAGE_FILE}`];
    const recordOnlyRun = await runNode(GATE_FILE, args(trees['record-only']));
    const withProductRun = await runNode(GATE_FILE, args(trees['with-product']));
    const keyword = '**失配**：from 在仓库里任何文件里都找不到';
    const redLine = recordOnlyRun.output.split('\n').find((line) => line.includes(keyword)) ?? '(没找到预期的红行)';
    return {
      ok: recordOnlyRun.code !== 0 && recordOnlyRun.output.includes(keyword) && withProductRun.code === 0,
      detail: `接缝只出现在 logs/ 记录里（产品里没有）时退出码 ${recordOnlyRun.code}（要非 0）；把同一串放回 web/product.js 后退出码 ${withProductRun.code}（要 0）`
        + `；红行：${redLine.trim().slice(0, 180)}`,
    };
  });
  recordSelf('self:reverse-record-not-evidence', '反证臂⑨：接缝只出现在过去运行的记录（logs/）里 ⇒ 门必红（记录不算证据）', raRecordNotEvidence.ok, raRecordNotEvidence.detail);
  out('');
}

// ── ⑨ 入口（只有被直接跑才扫；被 import 时只导出函数，便于自检/调试）───────────────────────────
async function main() {
  let exitCode = 0;
  if (SELF_TEST) await runSelfTests();
  const scan = await runScan({ armsRoot: ARMS_ROOT, searchRoot: SEARCH_ROOT, coverageFile: COVERAGE_FILE });
  const problems = judge(scan);
  const selfOk = !SELF_TEST || selfChecks.every((check) => check.ok);

  if (AS_JSON) {
    for (const problem of problems) process.stderr.write(`✗ ${problem}\n`);
    for (const check of selfChecks) if (!check.ok) process.stderr.write(`✗ 红半失败：[${check.id}] ${check.name} —— ${check.detail}\n`);
    out(JSON.stringify({
      summary: scan.summary,
      selfChecks,
      coverage: {
        path: scan.coverageFile,
        loaded: scan.coverage.ok,
        problems: scan.coverage.problems,
        entries: scan.coverage.entries,
      },
      arms: scan.arms.map((arm) => ({
        file: arm.file,
        name: arm.name,
        kind: arm.kind,
        declaredFile: arm.declaredFile,
        declared: arm.declared ? { ok: arm.declared.ok, file: arm.declared.file, how: arm.declared.how, reason: arm.declared.reason } : null,
        declaredHit: arm.declaredHit,
        declaredCount: arm.declaredCount,
        outsideRootHits: arm.outsideRootHits,
        verdict: arm.verdict,
        hits: arm.hits.map((hit) => hit.file),
      })),
    }, null, 2));
  } else {
    printScan(scan);
    for (const problem of problems) out(`✗ ${problem}`);
    if (SELF_TEST) {
      for (const check of selfChecks) if (!check.ok) out(`✗ 红半失败：[${check.id}] ${check.name} —— ${check.detail}`);
      out('');
      const redArms = selfChecks.filter((check) => check.id.startsWith('self:reverse')).length;
      out(selfOk ? `红半：${selfChecks.length}/${selfChecks.length} 通过（正控制 ${selfChecks.length - redArms} ＋ 反证臂 ${redArms}）` : '红半：**有失败**（见上）');
    }
  }

  if (problems.length > 0 || !selfOk) exitCode = 1;
  if (!AS_JSON) {
    out(exitCode === 0
      ? `RESULT: arm-seam gate PASS（${scan.summary.arms} 条臂：命中 ${scan.summary.hit} / 失配 ${scan.summary.mismatch}；臂目录外零命中 ${scan.summary.onlyArmsRootHits}；声明目标未命中 ${scan.summary.declaredMiss}；声明目标里出现 >1 次 ${scan.summary.declaredCountGtOne}；已知未覆盖 ${scan.coverage.entries.length} 个臂文件；证据语料已剔除过去记录 ${scan.summary.recordFilesExcluded} 个文件）`
      : `RESULT: arm-seam gate FAIL（失配 ${scan.summary.mismatch} / 见上）`);
  }
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === GATE_FILE) await main();
