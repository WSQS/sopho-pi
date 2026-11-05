// web/markdown.mjs —— 正式消息的 markdown 渲染（marked v18.0.5 + highlight.js v11.9.0）。
//
// 为什么有这一层：本仓原来在 web/render.js 里手写了一个约 50 行的「伪 markdown」（只认围栏/标题/
// 列表/引用），故意不解析表格、不画 `---`、不高亮代码。用户拍板走「借 pi vendored 的 marked +
// highlight.js」（评估见 /tmp/pi-html-renderer-report.md §7 路②），只用于**流式结束后的正式消息**；
// 流式那条纯文本 + `appendData` 的路径一行没碰。
//
// 安全（这是这条路的全部依据，逐条照抄 pi 自己 template.js:1560-1636 的配置）：
//   ① tokenizer.html() / tokenizer.tag() 一律返回 undefined ⇒ 原文里的 HTML **不会**变成标记，只被转义；
//   ② link / image 全过 sanitizeMarkdownUrl 的 scheme 白名单（http/https/mailto/tel/ftp）；
//   ③ code 交 hljs（hljs 只包 span、不改文本），codespan 显式转义。
// 少任何一条，`innerHTML = marked.parse(text)` 就是一条 XSS 通道 —— 见 test/pi-html-render-adversarial.mjs
// （它有一条阳性对照：不做配置的 marked 真的会执行注入；本模块必须 0 执行 / 0 可执行属性）。
//
// 性能：**关掉 highlightAuto**。pi 的导出对没有语言标注的围栏会猜语言（highlightAuto），在真数据上
// 40 条拼接体跑出 100–200ms long task（20/20 次超过 50ms）；只对**显式写了语言**的围栏高亮后
// 是 3–12ms、0 long task。本模块对无语言围栏只转义。
//
// 契约：产出的根仍是 `div.markdown`；代码块仍是 `pre.code-block`（有语言时带 `data-language`）——
// pi 导出的 `<pre><code class="hljs">` **没有** data-language，而折叠/复制/语言显示都依赖它，所以
// code renderer 自己写。

const STRICT_STRIKETHROUGH = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 只放行无 scheme 的相对地址与 http/https/mailto/tel/ftp；其余（javascript:/data:/vbscript:…）返回 null。 */
export function sanitizeMarkdownUrl(value) {
  const href = String(value || '').trim().replace(/[\x00-\x1f\x7f]/g, '');
  if (!href) return href;
  const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  if (scheme && !/^(https?|mailto|tel|ftp)$/i.test(scheme[1])) return null;
  return href;
}

/** 只对**写法已知**的语言高亮；没有语言或语言不认识 ⇒ 只转义（**不** highlightAuto）。 */
function highlightCode(hljs, code, lang) {
  if (!hljs || !lang) return escapeHtml(code);
  if (typeof hljs.getLanguage !== 'function' || !hljs.getLanguage(lang)) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: lang }).value;
  } catch {
    return escapeHtml(code);
  }
}

/**
 * 造一个按 pi 口径配好的 marked 实例。
 *   namespace: `window.marked`（UMD bundle，含 `Marked` 类）。
 *   hljs:      `window.hljs`，可选（缺了就只转义）。
 * codeStyle:
 *   'ours'（默认，本仓契约）⇒ `<pre class="code-block" [data-language]>`；
 *   'pi'                  ⇒ pi 导出的 `<pre><code class="hljs">`（只用于对照，不在产品路径）。
 */
export function createPiMarked(namespace, { hljs = null, codeStyle = 'ours' } = {}) {
  const instance = namespace && namespace.Marked ? new namespace.Marked() : namespace;
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
        const body = highlightCode(hljs, token.text, token.lang);
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

let cached = null;
let cachedNamespace = null;

/**
 * 惰性拿生产用的 marked 实例（`window.marked` 在页面里由 web/index.html 的
 * `<script src="/vendor/marked.min.js">` 先于本模块执行）。惰性是为了：Node 侧只有
 * test/fake-dom-contract.mjs import 本模块（它不调渲染），没有 window 时也不该在 import 期炸。
 */
export function markdownRenderer() {
  const namespace = globalThis.marked;
  if (!namespace) return null;
  if (cached && cachedNamespace === namespace) return cached;
  cachedNamespace = namespace;
  cached = createPiMarked(namespace, { hljs: globalThis.hljs || null, codeStyle: 'ours' });
  return cached;
}

/**
 * 把一段 markdown 渲成 DOM。返回 `div.markdown`（本仓契约）。
 * marked 不可用（静态资源缺失 / 非浏览器环境）时返回 null，由调用方安全退化 —— 本函数绝不
 * 在没有消毒配置时写 innerHTML。
 */
export function renderMarkdownMarked(document, text, { rootClass = 'markdown' } = {}) {
  const instance = markdownRenderer();
  if (!instance) return null;
  const root = document.createElement('div');
  root.className = rootClass;
  root.innerHTML = instance.parse(String(text ?? ''));
  return root;
}
