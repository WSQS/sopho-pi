// test/pi-html-prototype/render-pi.mjs —— 评估原型：**只借 pi 快照里 vendored 的 marked + highlight.js**，
// 自己接到本仓的 DOM 契约上（这是三个取舍里的第 2 条：不用 pi 的整页导出，只借它的 md 解析器 + 高亮器）。
//
// 页面里必须先以经典 <script> 载入 pi 包里的 vendor 文件：
//   dist/core/export-html/vendor/marked.min.js   → window.marked（含 Marked 类）
//   dist/core/export-html/vendor/highlight.min.js → window.hljs
// 然后 dynamic import 本模块。
//
// marked 的配置**逐条照抄** pi 自己 template.js:1560-1636 的那份（这是它保住安全性的全部依据）：
//   ① tokenizer.html() / tokenizer.tag() 一律返回 undefined ⇒ 原文里的 HTML **不会**变成标记，只会被当纯文本转义；
//   ② link / image 走 sanitizeMarkdownUrl 的 scheme 白名单（http/https/mailto/tel/ftp）；
//   ③ code/codespan 由renderer 自己转义（code 交给 hljs，hljs 只包 span，不改文本）。
// 这三条缺任何一条，`innerHTML = marked.parse(text)` 就是一条 XSS 通道（见 test/pi-html-render-adversarial.mjs）。

const STRICT_STRIKETHROUGH = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeMarkdownUrl(value) {
  const href = String(value || '').trim().replace(/[\x00-\x1f\x7f]/g, '');
  if (!href) return href;
  const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  if (scheme && !/^(https?|mailto|tel|ftp)$/i.test(scheme[1])) return null;
  return href;
}

function highlightCode(hljs, code, lang, autoDetect) {
  if (!hljs) return escapeHtml(code);
  if (lang && typeof hljs.getLanguage === 'function' && hljs.getLanguage(lang)) {
    try { return hljs.highlight(code, { language: lang }).value; } catch { return escapeHtml(code); }
  }
  // ⚠️ pi 自己的导出在这里是 highlightAuto（猜语言）：24 个无语言围栏 ⇒ 一次 400ms 级 long task，
  // 所以本原型把「不猜语言」做成显式可选（autoDetect=false ⇒ 无语言就只转义）。
  if (!autoDetect) return escapeHtml(code);
  try { return hljs.highlightAuto(code).value; } catch { return escapeHtml(code); }
}

/**
 * 造一个按 pi 口径配好的 marked 实例。options:
 *   codeStyle: 'ours'（pre.code-block + data-language，本仓契约）| 'pi'（pre > code.hljs，pi 原生形状）
 *   highlight: 是否调 hljs（false 时只转义，方便量「高亮值多少耗时」）
 */
export function createPiMarked(markedNamespace, { codeStyle = 'ours', highlight = true, autoDetect = true } = {}) {
  const instance = markedNamespace.Marked ? new markedNamespace.Marked() : markedNamespace;
  const hljs = highlight ? globalThis.hljs : null;
  instance.use({
    breaks: true,
    gfm: true,
    tokenizer: {
      html() { return undefined; },
      tag() { return undefined; },
      del(src) {
        const match = STRICT_STRIKETHROUGH.exec(src);
        if (!match) return undefined;
        return { type: 'del', raw: match[0], text: match[2], tokens: this.lexer.inlineTokens(match[2]) };
      },
    },
    renderer: {
      link(token) {
        const href = sanitizeMarkdownUrl(token.href);
        if (href === null) return this.parser.parseInline(token.tokens);
        let out = '<a href="' + escapeHtml(href) + '"';
        if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
        out += '>' + this.parser.parseInline(token.tokens) + '</a>';
        return out;
      },
      image(token) {
        const href = sanitizeMarkdownUrl(token.href);
        if (href === null) return escapeHtml(token.text || '');
        let out = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(token.text || '') + '"';
        if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
        out += '>';
        return out;
      },
      code(token) {
        const body = highlightCode(hljs, token.text, token.lang, autoDetect);
        if (codeStyle === 'pi') return `<pre><code class="hljs">${body}</code></pre>`;
        const attr = token.lang ? ` data-language="${escapeHtml(token.lang)}"` : '';
        return `<pre class="code-block"${attr}><code>${body}</code></pre>`;
      },
      codespan(token) {
        return `<code>${escapeHtml(token.text)}</code>`;
      },
    },
  });
  return instance;
}

/** 把一段 markdown 渲成 DOM；rootClass 默认 'markdown'（本仓契约），代码块形状由 codeStyle 决定。 */
export function renderMarked(document, text, instance, { rootClass = 'markdown' } = {}) {
  const root = document.createElement('div');
  root.className = rootClass;
  root.innerHTML = instance.parse(String(text ?? ''));
  return root;
}

/** 对照组：**没有任何配置**的 marked（默认 html 透传）——只用于证明对抗测试能测出执行。 */
export function createNaiveMarked(markedNamespace) {
  return markedNamespace.Marked ? new markedNamespace.Marked() : markedNamespace;
}
