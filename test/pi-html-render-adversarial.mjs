#!/usr/bin/env node
// test/pi-html-render-adversarial.mjs —— 「正式消息走 marked + highlight.js」这条路的
// **对抗门 + 契约门 + 真数据量测台**（真 Chromium）。
//
// 它跑三条臂（同一个 page、同一个 realm）：
//   ① naive  —— **没有任何配置**的 marked（默认会把原文里的 HTML 透传成标记）：阳性对照，
//                必须真的把 `<img src=x onerror=…>` 执行起来 —— 否则这条门证明不了它能测出执行；
//   ② prod   —— **产品入口** `web/render.js` 的 `renderMarkdown`（app.js 正式消息用的就是它）；
//   ③ module —— 它下面那层 `web/markdown.mjs` 的 `renderMarkdownMarked`（配置本身）。
// 判据（不过就整条方案否掉，不拿安全换功能）：
//   · scan(② ③) === [] 且注入后 `globalThis.__pwn` 没涨（0 执行 / 0 可执行属性）；
//   · scan(①) !== [] 且 `__pwn` 涨了（证明这条门能红）。
//
// 另外有两条**断言**的契约（借库最容易弄坏的东西）：
//   · DOM 契约：`div.markdown` 根 + `pre.code-block[data-language]` + code 文本不被高亮破坏；
//   · **关掉 highlightAuto**：有语言标注的围栏出 hljs span，没有语言标注的围栏一个 span 都不出。
// 还有两组只在页内量、写进 stdout 的观察（不参与断言，避免机器忙时假红）：
//   · 真数据 before/after：真 assistant 消息（最大 13.8k 字、最大 thinking 97k 字、40 条样本）
//     旧渲染器 vs 新渲染器的耗时与 long task 数；
//   · 真数据 DOM 差异表：同一条真消息两个渲染器各渲一遍的表格/链接/高亮/文本差异。
//
// 纪律：真 profile 只读（只 readFile 抽样）；随机高位端口；只按本次 spawn 的 pid 停 Chromium。
//
// 用法：
//   CHROME_BIN=/usr/bin/chromium node test/pi-html-render-adversarial.mjs
//   SOPHO_RENDER_SAMPLE=/tmp/pi-html-render/real-messages.json   （默认就用这个；缺了则只跑合成语料）

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, sendJson } from './ui-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = process.env.SOPHO_RENDER_SAMPLE || path.join(os.tmpdir(), 'pi-html-render', 'real-messages.json');

const PAYLOADS = [
  '<script>globalThis.__pwn=(globalThis.__pwn||0)+1</script>',
  '<img src=x onerror=globalThis.__pwn=(globalThis.__pwn||0)+1>',
  'text <img src=x onerror=globalThis.__pwn=(globalThis.__pwn||0)+1> tail',
  '<div>\n<img src=x onerror=globalThis.__pwn=(globalThis.__pwn||0)+1>\n</div>',
  '<b onclick="globalThis.__pwn=1">hi</b>',
  '<div onclick="globalThis.__pwn=1">x</div>',
  '<svg onload=globalThis.__pwn=1></svg>',
  '<iframe src="javascript:globalThis.__pwn=1"></iframe>',
  '<object data="javascript:globalThis.__pwn=1"></object>',
  '<form action="javascript:globalThis.__pwn=1"><button>go</button></form>',
  '[click](javascript:globalThis.__pwn=1)',
  '[click](JaVaScRiPt:globalThis.__pwn=1)',
  '[click](data:text/html,<script>globalThis.__pwn=1</script>)',
  '[click](vbscript:globalThis.__pwn=1)',
  '![x](javascript:globalThis.__pwn=1)',
  '<javascript:globalThis.__pwn=1>',
  '[x][1]\n\n[1]: javascript:globalThis.__pwn=1',
  '[ok](https://example.com/safe)',
  '![x](https://example.com/a.png)',
];

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>pi-html-render-probe</title></head>
<body>
<div id="naive"></div><div id="prod"></div><div id="module"></div><div id="perf"></div>
<script src="/vendor/marked.min.js"></script>
<script src="/vendor/highlight.min.js"></script>
<script type="module">
  import * as prod from '/render-ours.js';
  import * as md from '/markdown.mjs';
  import * as legacy from '/legacy/render-legacy.mjs';
  window.__prod = prod; window.__md = md; window.__legacy = legacy; window.__ready = true;
</script>
</body></html>`;

const PROBE = String.raw`
(async () => {
  const payloads = PAYLOADS_JSON;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TAGS = new Set(['script','iframe','object','embed','svg','math','base','link','style','meta','form','template','noscript']);
  const URL_ATTRS = ['href','src','xlink:href','formaction','action','data','poster','background','srcdoc'];
  function scan(host) {
    const out = [];
    for (const el of host.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      if (TAGS.has(tag)) out.push('tag:' + tag);
      for (const attr of el.attributes) {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || '');
        if (name.startsWith('on')) out.push('handler:' + tag + '@' + name);
        if (URL_ATTRS.includes(name)) {
          const clean = value.replace(/[\u0000-\u001f\u007f\s]/g, '').toLowerCase();
          if (/^(javascript|data|vbscript|file):/.test(clean)) out.push('url:' + tag + '@' + name + '=' + value.slice(0, 48));
        }
      }
    }
    return out;
  }
  function host(id) { const node = document.getElementById(id); node.replaceChildren(); return node; }
  function renderInto(target, html) { const box = document.createElement('div'); box.innerHTML = html; target.append(box); return box; }

  // ① 阳性对照：默认 marked（无配置）
  const naiveMarked = window.marked.Marked ? new window.marked.Marked() : window.marked;
  globalThis.__pwn = 0;
  const naiveHost = host('naive');
  for (const p of payloads) renderInto(naiveHost, naiveMarked.parse(p));
  await sleep(600);
  const naive = { pwned: globalThis.__pwn, violations: scan(naiveHost) };

  // ② 产品入口：web/render.js 的 renderMarkdown
  const beforeProd = globalThis.__pwn;
  const prodHost = host('prod');
  for (const p of payloads) prodHost.append(window.__prod.renderMarkdown(document, p));
  await sleep(600);
  const prod = { pwnDelta: globalThis.__pwn - beforeProd, violations: scan(prodHost) };

  // ③ 配置模块本身：web/markdown.mjs 的 renderMarkdownMarked
  const beforeModule = globalThis.__pwn;
  const moduleHost = host('module');
  for (const p of payloads) moduleHost.append(window.__md.renderMarkdownMarked(document, p));
  await sleep(600);
  const mod = { pwnDelta: globalThis.__pwn - beforeModule, violations: scan(moduleHost) };

  // DOM 契约 + autoDetect 关闭（都在产品入口上量）
  const contract = (() => {
    const BT = String.fromCharCode(96);
    const FENCE = BT + BT + BT;
    const text = ['# 标题', '', '段落 **粗** 与 ' + BT + '行内' + BT + '。', '', '- a', '- b', '', '> 引用', '', '| a | b |', '| - | - |', '| 1 | 2 |', '', '---', '', FENCE + 'js', 'const a = 1;', FENCE, '', FENCE, 'no-language line', FENCE, '', '[链接](https://example.com/x)', '[坏](javascript:alert(1))'].join('\n');
    const node = window.__prod.renderMarkdown(document, text);
    const pre = node.querySelector('pre.code-block');
    const pres = [...node.querySelectorAll('pre.code-block')];
    return {
      rootClass: node.className,
      hasRoot: node.classList.contains('markdown'),
      codeBlockSelector: pre ? 'pre.code-block' : null,
      dataLanguage: pre ? pre.getAttribute('data-language') : null,
      codeText: pre ? pre.querySelector('code').textContent : null,
      hljsSpans: pres[0] ? pres[0].querySelectorAll('[class^="hljs-"]').length : 0,
      // 无语言围栏（pres[1]）：关掉 highlightAuto ⇒ 一个 hljs span 都不该有
      hljsSpansNoLang: pres[1] ? pres[1].querySelectorAll('[class^="hljs-"]').length : -1,
      tables: node.querySelectorAll('table').length,
      hrs: node.querySelectorAll('hr').length,
      links: node.querySelectorAll('a').length,
      linkHref: node.querySelector('a') ? node.querySelector('a').getAttribute('href') : null,
      headings: node.querySelectorAll('h1').length,
      lists: node.querySelectorAll('li').length,
      quotes: node.querySelectorAll('blockquote').length,
    };
  })();

  // 真数据 before/after（观察项）
  const sample = window.__SAMPLE__ || null;
  const perf = { available: !!sample, rows: [], longTasks: [] };
  if (sample) {
    const phases = [];
    let current = null;
    const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) phases.push({ label: current, duration: +entry.duration.toFixed(1) }); });
    try { observer.observe({ entryTypes: ['longtask'] }); } catch {}
    const scratch = document.createElement('div');
    async function measure(label, fn, times) {
      // 每次渲染后让出一个 macrotask：每次渲染自成一个 task，longtask 观测器数的就是
      // 「这一次渲染是否超过 50ms」，而不是「整段循环加起来多久」。
      const per = [];
      for (let i = 0; i < times; i += 1) {
        current = label;
        scratch.replaceChildren();
        const start = performance.now();
        fn(scratch);
        per.push(performance.now() - start);
        await sleep(0);
      }
      await sleep(150);
      const long = phases.filter((p) => p.label === label);
      const avg = per.reduce((a, b) => a + b, 0) / per.length;
      return { label, times, avgMs: +avg.toFixed(2), maxMs: +Math.max(...per).toFixed(2), longTasks: long.length, maxTaskMs: long.length ? Math.max(...long.map((t) => t.duration)) : 0 };
    }
    const cases = [
      { label: 'largest-text', text: sample.largest.text },
      { label: 'largest-thinking', text: sample.thinking ? sample.thinking.text : '' },
      { label: 'sample-40', text: sample.sample.map((s) => s.text).join('\n\n') },
    ];
    for (const c of cases) {
      scratch.replaceChildren();
      const legacyRow = await measure('legacy:' + c.label, (t) => { t.append(window.__legacy.renderMarkdownLegacy(document, c.text)); }, 20);
      scratch.replaceChildren();
      const prodRow = await measure('marked:' + c.label, (t) => { t.append(window.__prod.renderMarkdown(document, c.text)); }, 20);
      // DOM 体积：同样的文本，两臂各建多少节点
      const count = (node) => node.querySelectorAll('*').length;
      const legacyNodes = count(window.__legacy.renderMarkdownLegacy(document, c.text));
      const prodNodes = count(window.__prod.renderMarkdown(document, c.text));
      perf.rows.push({ case: c.label, chars: c.text.length, legacy: legacyRow, marked: prodRow, domNodes: { legacy: legacyNodes, marked: prodNodes } });
    }
    try { observer.disconnect(); } catch {}
    perf.longTasks = phases;
  }

  // 真数据 DOM 差异（观察项 + 两条赚到的断言）：同一条真消息，旧渲染器 vs 新渲染器
  const diff = { available: !!sample, rows: [], totals: null };
  if (sample) {
    const norm = (text) => String(text).replace(/\s+/g, ' ').trim();
    let features = { legacyLinks: 0, legacyTables: 0, legacyHljs: 0, legacyHrs: 0, markedLinks: 0, markedTables: 0, markedHljs: 0, markedHrs: 0, textEqual: 0, textTotal: 0, legacyBlocks: 0, markedBlocks: 0 };
    for (const s of sample.sample) {
      const a = window.__legacy.renderMarkdownLegacy(document, s.text);
      const b = window.__prod.renderMarkdown(document, s.text);
      const row = {
        chars: s.text.length,
        textEqual: norm(a.textContent) === norm(b.textContent),
        legacyTextLen: norm(a.textContent).length,
        markedTextLen: norm(b.textContent).length,
        firstDiff: (() => {
          const x = norm(a.textContent), y = norm(b.textContent);
          let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
          return { at: i, legacy: x.slice(Math.max(0, i - 30), i + 60), marked: y.slice(Math.max(0, i - 30), i + 60) };
        })(),
        legacy: { links: a.querySelectorAll('a').length, tables: a.querySelectorAll('table').length, hljs: a.querySelectorAll('[class^="hljs-"]').length, hrs: a.querySelectorAll('hr').length, blocks: a.querySelectorAll('p,pre,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,table,hr').length },
        marked: { links: b.querySelectorAll('a').length, tables: b.querySelectorAll('table').length, hljs: b.querySelectorAll('[class^="hljs-"]').length, hrs: b.querySelectorAll('hr').length, blocks: b.querySelectorAll('p,pre,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,table,hr').length },
      };
      features.legacyLinks += row.legacy.links; features.legacyTables += row.legacy.tables; features.legacyHljs += row.legacy.hljs; features.legacyHrs += row.legacy.hrs;
      features.markedLinks += row.marked.links; features.markedTables += row.marked.tables; features.markedHljs += row.marked.hljs; features.markedHrs += row.marked.hrs;
      features.legacyBlocks += row.legacy.blocks; features.markedBlocks += row.marked.blocks;
      features.textTotal += 1; if (row.textEqual) features.textEqual += 1;
      diff.rows.push(row);
    }
    diff.totals = features;
  }

  return { naive, prod, mod, contract, perf, diff, ready: window.__ready === true };
})()
`;

async function main() {
  let sample = null;
  try { sample = JSON.parse(await readFile(SAMPLE, 'utf8')); } catch { sample = null; }

  const vendor = path.join(ROOT, 'web', 'vendor');
  const instance = await boot({
    routes: async (request, response, url) => {
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(PAGE);
        return true;
      }
      const map = {
        '/vendor/marked.min.js': path.join(vendor, 'marked.min.js'),
        '/vendor/highlight.min.js': path.join(vendor, 'highlight.min.js'),
        '/render-ours.js': path.join(ROOT, 'web', 'render.js'),
        '/markdown.mjs': path.join(ROOT, 'web', 'markdown.mjs'),
        '/legacy/render-legacy.mjs': path.join(ROOT, 'test', 'pi-html-prototype', 'render-legacy.mjs'),
      };
      if (map[url.pathname]) {
        try {
          const content = await readFile(map[url.pathname]);
          response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
          response.end(content);
        } catch (error) { sendJson(response, 500, { error: String(error && error.message) }); }
        return true;
      }
      return false;
    },
  });

  try {
    await instance.waitFor(() => instance.evaluate('window.__ready === true && !!window.__prod && !!window.__md && !!window.__legacy && !!window.marked && !!window.hljs'), 'production modules did not load');
    const injected = `window.__SAMPLE__ = ${JSON.stringify(sample)};\n` + PROBE.replace('PAYLOADS_JSON', JSON.stringify(PAYLOADS));
    const result = await instance.evaluate(injected);

    console.log('chromium', JSON.stringify({ product: instance.version.Browser, chrome: instance.chrome }));
    console.log('sample', JSON.stringify(sample ? { largestChars: sample.largest.text.length, thinkingChars: sample.thinking ? sample.thinking.text.length : 0, samples: sample.sample.length } : { available: false, path: SAMPLE }));

    console.log('① 阳性对照 naive marked（默认配置）:', JSON.stringify({ pwned: result.naive.pwned, violationCount: result.naive.violations.length, violations: [...new Set(result.naive.violations)].slice(0, 8) }));
    console.log('② 产品入口 web/render.js renderMarkdown:', JSON.stringify({ pwnDelta: result.prod.pwnDelta, violations: result.prod.violations }));
    console.log('③ 配置模块 web/markdown.mjs renderMarkdownMarked:', JSON.stringify({ pwnDelta: result.mod.pwnDelta, violations: result.mod.violations }));
    console.log('DOM 契约 + autoDetect 关闭（产品入口）:', JSON.stringify(result.contract));
    for (const row of result.perf.rows) {
      console.log('perf', JSON.stringify({ case: row.case, chars: row.chars, legacy: row.legacy, marked: row.marked, domNodes: row.domNodes }));
    }
    console.log('long tasks (全部 phase 汇总):', JSON.stringify(result.perf.longTasks.slice(0, 20)));
    console.log('真数据 DOM 差异合计:', JSON.stringify(result.diff.totals));
    console.log('真数据 DOM 差异 · 前 2 条首次分歧:', JSON.stringify(result.diff.rows.slice(0, 2).map((r) => ({ chars: r.chars, at: r.firstDiff.at, legacy: r.firstDiff.legacy, marked: r.firstDiff.marked }))));
    console.log('真数据 DOM 差异 · 前 5 条样本:', JSON.stringify(result.diff.rows.slice(0, 5)));

    assert.equal(result.ready, true, 'page module ready flag');
    // 这条门必须能红：默认 marked 真的把注入执行了、并且 DOM 里真出现了可执行属性
    assert.ok(result.naive.pwned > 0, `阳性对照没有触发：naive marked 应当执行注入，pwned=${result.naive.pwned}`);
    assert.ok(result.naive.violations.length > 0, '阳性对照没有落在可执行属性上：扫描器测不出危险 DOM');
    // 产品路径：不执行、且渲染结果里没有可执行属性
    assert.equal(result.prod.pwnDelta, 0, `产品 renderMarkdown 仍执行了注入（pwnDelta=${result.prod.pwnDelta}）`);
    assert.deepEqual(result.prod.violations, [], `产品 renderMarkdown 渲染结果里出现可执行属性: ${JSON.stringify(result.prod.violations)}`);
    assert.equal(result.mod.pwnDelta, 0, `web/markdown.mjs 仍执行了注入（pwnDelta=${result.mod.pwnDelta}）`);
    assert.deepEqual(result.mod.violations, [], `web/markdown.mjs 渲染结果里出现可执行属性: ${JSON.stringify(result.mod.violations)}`);
    // DOM 契约
    assert.equal(result.contract.hasRoot, true, '产品渲染器没有 .markdown 根');
    assert.equal(result.contract.codeBlockSelector, 'pre.code-block', '产品渲染器没有 pre.code-block');
    assert.equal(result.contract.dataLanguage, 'js', '产品渲染器丢了 data-language');
    assert.equal(result.contract.codeText, 'const a = 1;', '产品渲染器 code 文本被高亮破坏');
    assert.ok(result.contract.hljsSpans > 0, '有语言标注的围栏没有出 hljs span（高亮没生效）');
    assert.equal(result.contract.hljsSpansNoLang, 0, '无语言标注的围栏出了 hljs span（highlightAuto 没关掉）');
    assert.equal(result.contract.tables, 1, '表格没被渲染');
    assert.equal(result.contract.hrs, 1, '--- 没被渲染成 hr');
    assert.equal(result.contract.lists, 2, '列表项数不对');
    assert.equal(result.contract.quotes, 1, '引用没被渲染');
    // 安全链接渲染出来了，`javascript:` 链接被整条挡掉（不出 <a>）
    assert.equal(result.contract.links, 1, 'javascript: 链接没有被 scheme 白名单挡下（只该剩安全那条）');
    assert.equal(result.contract.linkHref, 'https://example.com/x', '安全链接的 href 不对');
    // 真数据：确实赚到了表格与高亮（旧渲染器这两样都是 0）
    if (result.diff.available) {
      assert.ok(result.diff.totals.markedTables > 0, '真数据里一个表格都没渲出来');
      assert.ok(result.diff.totals.markedHljs > 0, '真数据里一个高亮 span 都没出');
      assert.equal(result.diff.totals.legacyTables, 0, '旧渲染器不该出表格（基线变了？）');
      assert.equal(result.diff.totals.legacyHljs, 0, '旧渲染器不该出高亮（基线变了？）');
    }
    // 性能目标：产品渲染器在真数据上不得出 long task
    for (const row of result.perf.rows) {
      assert.equal(row.marked.longTasks, 0, `${row.case}: 产品渲染器出现 long task（${row.marked.longTasks} 次，最长 ${row.marked.maxTaskMs}ms）`);
    }

    console.log('RESULT: pi-html-render adversarial PASS（阳性对照真的执行了注入；产品入口与配置模块都是 0 执行 / 0 可执行属性；契约与 autoDetect 关闭断言通过）');
  } finally {
    await instance.close();
  }
}

main().catch((error) => {
  console.error('RESULT: pi-html-render adversarial FAIL');
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
