#!/usr/bin/env node
// test/pi-html-render-snapshot-inspect.mjs —— 观察台（不是门，永远 exit 0，除非自身崩）：
// 把 pi 快照导出（@earendil-works/pi-coding-agent dist/core/export-html）**到底是什么**量清楚：
//   · 是整会话一个自包含 HTML 文件（vendored marked + highlight 内联进 <script>），还是能只渲一条消息；
//   · 它渲出来的 DOM 长什么样（正文根类名 / 代码块形状 / 思考块 / 工具调用 / entry 锚）；
//   · 它有没有可编程的「单条消息」入口（看公开 exports 图 + 模板里是不是硬绑 #session-data）。
//
// 纪律：真 profile 只读；导出目标写到临时目录；只用本次 spawn 的 chromium + 随机高位端口；不碰 7331/7321。
//
// 用法：CHROME_BIN=/usr/bin/chromium node test/pi-html-render-snapshot-inspect.mjs

import { copyFile, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boot } from './ui-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const piEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const piPackageRoot = path.dirname(path.dirname(piEntry));
const EXPORT_DIR = path.join(piPackageRoot, 'dist', 'core', 'export-html');

async function pickSession() {
  if (process.env.SOPHO_SNAPSHOT_SESSION) return process.env.SOPHO_SNAPSHOT_SESSION;
  const dir = path.join(os.homedir(), '.pi', 'profiles', 'assistant', 'sessions');
  const names = await readdir(dir);
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    const info = await stat(file);
    if (info.size > 200 * 1024 && info.size < 4 * 1024 * 1024) candidates.push({ file, size: info.size });
  }
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0] ? candidates[0].file : null;
}

async function main() {
  const sessionFile = await pickSession();
  if (!sessionFile) {
    console.log('SKIP: 找不到可用的真会话文件（设 SOPHO_SNAPSHOT_SESSION=<path>）');
    return;
  }
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-snapshot-'));
  const exporter = await import(pathToFileURL(path.join(EXPORT_DIR, 'index.js')).href);
  const snapshotPath = path.join(sandbox, 'snapshot.html');
  const t0 = Date.now();
  await exporter.exportFromFile(sessionFile, { outputPath: snapshotPath });
  const exportMs = Date.now() - t0;
  const html = await readFile(snapshotPath, 'utf8');
  const info = await stat(snapshotPath);
  const sessionInfo = await stat(sessionFile);
  console.log('export', JSON.stringify({ sessionFile, sessionBytes: sessionInfo.size, snapshotBytes: info.size, ratio: +(info.size / sessionInfo.size).toFixed(2), exportMs, templateDir: EXPORT_DIR }));

  // 独立量：模板里三个 vendor / template.css 的字节数（就是快照内联进去的那几个）
  const bytes = async (rel) => (await stat(path.join(EXPORT_DIR, rel))).size;
  console.log('snapshot parts (raw bytes)', JSON.stringify({ template_html: await bytes('template.html'), template_css: await bytes('template.css'), template_js: await bytes('template.js'), marked_min: await bytes('vendor/marked.min.js'), highlight_min: await bytes('vendor/highlight.min.js') }));

  const instance = await boot({
    routes: async (request, response, url) => {
      if (url.pathname === '/' || url.pathname === '/snapshot.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html);
        return true;
      }
      return false;
    },
  });
  try {
    const view = await instance.waitFor(async () => {
      const value = await instance.evaluate(`(() => {
        const assistants = document.querySelectorAll('.assistant-message');
        if (!assistants.length) return null;
        const first = assistants[assistants.length - 1];
        const all = document.querySelectorAll('*');
        const tagCounts = {};
        for (const el of all) { const t = el.tagName.toLowerCase(); tagCounts[t] = (tagCounts[t] || 0) + 1; }
        const codeBlocks = document.querySelectorAll('pre > code');
        const withLang = document.querySelectorAll('pre > code[data-language], pre.code-block');
        const thinking = document.querySelectorAll('.thinking-block');
        const toolCalls = document.querySelectorAll('[id^="tool-call-"]');
        return {
          title: document.title,
          inlineStyleBytes: (document.querySelector('style') || {}).textContent ? document.querySelector('style').textContent.length : 0,
          externalRefs: { linkHref: document.querySelectorAll('link[href]').length, scriptSrc: document.querySelectorAll('script[src]').length, imgSrc: document.querySelectorAll('img[src^="http"]').length },
          firstBlockOuterHtml: (() => { const n = document.querySelector('#messages').firstElementChild; return n ? n.outerHTML.slice(0, 400) : null; })(),
          fullSampleMessage: (() => {
            const nodes = Array.from(document.querySelectorAll('.assistant-message'));
            const hit = nodes.reverse().find((n) => n.querySelector('.thinking-block') && n.querySelector('[id^="tool-call-"]')) || nodes[0];
            return hit ? hit.outerHTML.slice(0, 1600) : null;
          })(),
          fullFirstPre: (() => { const n = document.querySelector('#messages pre'); return n ? n.outerHTML.slice(0, 500) : null; })(),
          compactionOuterHtml: (() => { const n = document.querySelector('.compaction'); return n ? n.outerHTML.slice(0, 400) : null; })(),
          hookMessageOuterHtml: (() => { const n = document.querySelector('.hook-message'); return n ? n.outerHTML.slice(0, 300) : null; })(),
          hasSidebar: !!document.querySelector('#sidebar'),
          hasTree: !!document.querySelector('#tree-container'),
          hasHeaderContainer: !!document.querySelector('#header-container'),
          messagesChildren: document.querySelector('#messages').children.length,
          assistantMessages: assistants.length,
          userMessages: document.querySelectorAll('.user-message').length,
          markdownContent: document.querySelectorAll('.markdown-content').length,
          codeBlocks: codeBlocks.length,
          codeBlocksWithDataLanguage: withLang.length,
          codeBlockFirst: codeBlocks.length ? codeBlocks[0].outerHTML.slice(0, 160) : null,
          thinkingBlocks: thinking.length,
          thinkingTextEscape: thinking.length ? thinking[0].querySelector('.thinking-text').innerHTML.slice(0, 80) : null,
          toolCallNodes: toolCalls.length,
          entryIdAnchors: document.querySelectorAll('[id^="entry-"]').length,
          firstToolCallIdOuterHtml: (() => { const n = document.querySelector('[id^="tool-call-"]'); return n ? n.outerHTML.slice(0, 320) : null; })(),
          firstAssistantTextOuterHtml: (() => { const n = document.querySelector('.assistant-text'); return n ? n.outerHTML.slice(0, 260) : null; })(),
          firstUserOuterHtml: (() => { const n = document.querySelector('.user-message'); return n ? n.outerHTML.slice(0, 260) : null; })(),
          lastAssistantOuterHtml: first.outerHTML.slice(0, 700),
          inlineScripts: Array.from(document.querySelectorAll('script')).map((s) => ({ id: s.id || null, src: s.src || null, bytes: s.textContent.length })),
          sessionDataBytes: (document.getElementById('session-data') || {}).textContent ? document.getElementById('session-data').textContent.length : 0,
          sidebarEntriesRendered: document.querySelectorAll('.tree-node, [class*="tree-"]').length,
          tagCounts,
        };
      })()`);
      return value;
    }, 'snapshot did not render in chromium', 20000);
    console.log('snapshot DOM', JSON.stringify(view, null, 1));
    // 结论性的机械事实：整份 HTML 里有没有「按 entry id 单独渲一条」的入口
    console.log('per-message entrypoint?', JSON.stringify({
      publicExportsMap: (await import(pathToFileURL(path.join(piPackageRoot, 'package.json')).href, { with: { type: 'json' } })).default.exports,
      templateExports: Object.keys(await import(pathToFileURL(path.join(EXPORT_DIR, 'template.js')).href).catch(() => ({}))),
      indexExports: Object.keys(await import(pathToFileURL(path.join(EXPORT_DIR, 'index.js')).href).catch(() => ({}))),
      templateBindsSessionData: /getElementById\('session-data'\)/.test(await readFile(path.join(EXPORT_DIR, 'template.js'), 'utf8')),
    }, null, 1));
    await writeFile('/tmp/pi-html-render/snapshot-dom.json', JSON.stringify(view, null, 1));
    console.log('RESULT: snapshot inspect done（默认整会话一个自包含 HTML；无单条消息入口）');
  } finally {
    await instance.close();
  }
}

main().catch((error) => {
  console.error('RESULT: snapshot inspect crashed');
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
