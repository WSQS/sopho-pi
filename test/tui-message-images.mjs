// test/tui-message-images.mjs —— M-31 的前端那一半：把服务端**已经送上来**的图片块画成真 `<img>`。
//
// 背景（`docs/tui-parity.md` §2.2 M-31 / §3：「服务端已补（`c2e4e08`）… 剩下的前端渲染仍未做」）：
//   `server/base-logic.mjs` 的 `imageBlocks()` / `contentTextWithImages()` 保留图片元数据、写占位行，
//   而**原图 base64 一直原样在 `wire.content` 的 image 块里**（`--item M-31` 那半已验）。
//   网页侧修前 `grep -rn "<img" web/` 0 命中 —— 这里钉的是**网页真的把占位画成了图**，
//   以及**画不出来的三种现场都如实说清**（不许静默空白）。
//
// 判据（正反两面都断言，数据逐字已知）：
//   正：PNG 夹具（本门自己按 PNG 规范造，尺寸 400×300 确定）⇒
//       · `<img src="data:image/png;base64,…">` 出现，src 与我们给的原文**逐字相同**；
//       · 宽高由 `web/image-size.mjs` 读图片文件头得到并事先写进 `width`/`height` 属性
//         ⇒ 插进 DOM 那一刻（还没解码）盒子就已经是 300px 高，解码完成后再量**一点没变**；
//       · 「只有图片」的消息不再是空壳；占位行「（网页暂不显示图片内容）」在画得出图时从正文里让位；
//       · `read` 工具结果里的图配到**工具卡**上（toolResult 自己不单独成节点）。
//   反：坏 base64 / 缺 data / 认不出类型 ⇒ 各有各的那一句 `.message-image-bad`，且页面不崩。
//
// 只起自己 spawn 的 A、只按那个 pid 停；高位随机端口、临时 Chromium profile；不碰真 profile；不 pkill。
import { deflateSync } from 'node:zlib';
import { boot, sendJson, waitFor } from './ui-harness.mjs';

const SESSION = '26262626-2626-4626-8626-262626262626';
const IMAGE_W = 400;
const IMAGE_H = 300;

// ── 造一张**真的** PNG（IHDR + IDAT + IEND，CRC 按规范算）——尺寸是确定的 400×300，用来验
//    「前端读文件头读出来的宽高 == 真图宽高」。纯色 + 每行 filter=0，deflate 之后很小。
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  // 一个 chunk = 4 字节长度 + 4 字节类型 + data + 4 字节 CRC（12 已经把三个 4 算进去了）。
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function pngBytes(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit / truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = 90;
      raw[row + 2 + x * 3] = 190;
      raw[row + 3 + x * 3] = 183;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = pngBytes(IMAGE_W, IMAGE_H);
const pngBase64 = png.toString('base64');
const pngBytesLength = Buffer.byteLength(pngBase64, 'base64'); // 服务端 `images[].bytes` 就是这个口径
const dataUrl = `data:image/png;base64,${pngBase64}`;
const placeholder = (bytes) => `[图片：image/png，${bytes} 字节（网页暂不显示图片内容）]`;
const BROKEN = 'bm90LWEtcG5n'; // 合法 base64，但不是图片（解码必然失败）

const sessions = [{
  id: SESSION, name: '图片门', parentId: null, archived: false, status: 'idle', statusLabel: '闲置',
  unread: false, modifiedAt: '2026-09-20T09:00:00.000Z', notify: { notifies: [], waitingFor: [] },
}];

const messages = [
  // ① 文本 + 图片（用户贴的截图就是这个形状）
  {
    entryId: 'u1', role: 'user',
    content: [{ type: 'text', text: '看这张截图' }, { type: 'image', data: pngBase64, mimeType: 'image/png' }],
    text: `看这张截图\n${placeholder(pngBytesLength)}`,
    images: [{ mimeType: 'image/png', bytes: pngBytesLength }],
  },
  // ② 「只有图片」——修前 `contentText()` 只收 text 块 ⇒ `text: ''` ⇒ 空壳
  {
    entryId: 'u2', role: 'user',
    content: [{ type: 'image', data: pngBase64, mimeType: 'image/png' }],
    text: placeholder(pngBytesLength),
    images: [{ mimeType: 'image/png', bytes: pngBytesLength }],
  },
  // ③ assistant 的 image part（parts 里只有 mimeType/bytes，原图在 content 里）
  {
    entryId: 'a1', role: 'assistant',
    content: [{ type: 'text', text: '模型看到的图：' }, { type: 'image', data: pngBase64, mimeType: 'image/png' }],
    parts: [{ type: 'text', text: '模型看到的图：' }, { type: 'image', mimeType: 'image/png', bytes: pngBytesLength }],
    text: `模型看到的图：\n${placeholder(pngBytesLength)}`,
    images: [{ mimeType: 'image/png', bytes: pngBytesLength }],
  },
  // ④ 工具结果里的图（`read` 一张 png）：工具卡那半 —— toolResult 自己不单独成节点
  {
    entryId: 'a2', role: 'assistant',
    content: [],
    parts: [{
      type: 'tool', toolCallId: 'call_read', name: 'read', args: { path: 'shot.png' },
      status: 'done-success', result: `Read image file [image/png]\n${placeholder(pngBytesLength)}`,
      details: { status: 'absent', value: null, bytes: null, truncated: false, note: null, preview: null },
    }],
  },
  {
    entryId: 'tr1', role: 'toolResult', toolCallId: 'call_read', toolName: 'read',
    content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data: pngBase64, mimeType: 'image/png' }],
    text: `Read image file [image/png]\n${placeholder(pngBytesLength)}`,
    images: [{ mimeType: 'image/png', bytes: pngBytesLength }],
  },
  // ⑤ 坏 base64（声明 image/png，但字节不是图）⇒ 浏览器解码失败
  {
    entryId: 'u3', role: 'user',
    content: [{ type: 'text', text: '这张是坏的' }, { type: 'image', data: BROKEN, mimeType: 'image/png' }],
    text: `这张是坏的\n[图片：image/png，9 字节（网页暂不显示图片内容）]`,
    images: [{ mimeType: 'image/png', bytes: 9 }],
  },
  // ⑥ 缺 data（只有元数据）⇒ 没有东西可画
  {
    entryId: 'u4', role: 'user',
    content: [{ type: 'image', mimeType: 'image/png' }],
    text: placeholder(1216),
    images: [{ mimeType: 'image/png', bytes: 1216 }],
  },
  // ⑦ 认不出类型（没有 mimeType，字节也不是 PNG/JPEG/GIF/WebP）
  {
    entryId: 'u5', role: 'user',
    content: [{ type: 'text', text: '不知道这是啥' }, { type: 'image', data: BROKEN }],
    text: `不知道这是啥\n[图片：类型未知，9 字节（网页暂不显示图片内容）]`,
    images: [{ mimeType: null, bytes: 9 }],
  },
];

let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) throw new Error(`✗ ${name}\n  期望：断言成立\n  实测：${detail}`);
  checks += 1;
  process.stdout.write(`✓ ${name} —— ${detail}\n`);
};
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const screenshotFile = `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/sopho-tui-message-images-1200x760.png`;

const ui = await boot({
  routes: async (request, response, url) => {
    if (url.pathname === '/api/host') return sendJson(response, 200, { ok: true }), true;
    if (url.pathname === '/api/devices') return sendJson(response, 200, { exists: false, devices: [] }), true;
    if (url.pathname === '/api/tree') return sendJson(response, 200, { sessions, unread: { count: 0 } }), true;
    if (url.pathname === '/api/tree/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
      response.write(`event: tree.snapshot\ndata: ${JSON.stringify({ sessions })}\n\n`);
      return true;
    }
    const match = /^\/api\/sessions\/([^/]+)\/(messages|events|commands|seen)$/.exec(url.pathname);
    if (match) {
      if (match[2] === 'messages') return sendJson(response, 200, { sessionId: SESSION, messages, extras: [], compaction: { atIndex: null }, observability: null }), true;
      if (match[2] === 'commands') return sendJson(response, 200, { streaming: false, commands: [] }), true;
      if (match[2] === 'seen') return sendJson(response, 200, { ok: true }), true;
      if (match[2] === 'events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-store' });
        response.write(`event: session.snapshot\ndata: ${JSON.stringify({ isStreaming: false, isCompacting: false, isRetrying: false })}\n\n`);
        return true;
      }
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (detail) {
      return sendJson(response, 200, { name: '图片门', cwd: '/home/user/code/ai/sopho-pi', archived: false, runtime: { isStreaming: false, isCompacting: false, isRetrying: false }, observability: null, context: null }), true;
    }
    return false;
  },
});

const view = () => ui.evaluate(`(() => {
  const figures = Array.from(document.querySelectorAll('.message-image')).map((figure) => {
    const img = figure.querySelector('img');
    return {
      state: figure.dataset.state,
      article: figure.closest('article')?.dataset.entryId ?? null,
      inToolOutput: figure.parentElement?.classList.contains('tool-output') ?? false,
      caption: figure.querySelector('.message-image-meta')?.textContent ?? null,
      bad: figure.querySelector('.message-image-bad')?.textContent ?? null,
      hasImg: Boolean(img),
      src: img?.getAttribute('src') ?? null,
      width: img?.getAttribute('width') ?? null,
      height: img?.getAttribute('height') ?? null,
      naturalWidth: img?.naturalWidth ?? 0,
      naturalHeight: img?.naturalHeight ?? 0,
      boxHeight: img ? +img.getBoundingClientRect().height.toFixed(2) : null,
    };
  });
  const toolCard = Array.from(document.querySelectorAll('.tool-card')).find((card) => card.dataset.toolCallId === 'call_read');
  return {
    figures,
    tool: toolCard ? {
      childSignature: Array.from(toolCard.children).map((child) => child.tagName.toLowerCase() + '.' + child.className).join('|'),
      result: toolCard.querySelector('.tool-result').textContent,
    } : null,
    bodyText: document.querySelector('#messages').textContent,
    placeholderLeft: (document.querySelector('#messages').textContent.match(/（网页暂不显示图片内容）/g) || []).length,
  };
})()`);

try {
  await waitFor(() => ui.evaluate(`document.querySelectorAll('.tree-session').length === 1`), 'tree did not render');
  await ui.evaluate(`document.querySelector('[data-session-id="${SESSION}"] .tree-select').click()`);
  await waitFor(() => ui.evaluate(`document.querySelectorAll('.message-image').length === 7`), 'image figures did not render');
  await ui.frames(3);

  const all = await view();
  const byEntry = (id) => all.figures.filter((figure) => figure.article === id);
  // 断言输出里不需要 1.4 KB 的 data URL 原文：截短只影响**打印**，断言用的仍是原对象。
  const brief = (figure) => (figure ? { ...figure, src: figure.src ? `${figure.src.slice(0, 32)}…（${figure.src.length} 字符）` : figure.src } : figure);

  // ── 正：真 <img> ───────────────────────────────────────────────────────────
  check('正：七张图各画出一个 `.message-image`（①②③④各一张 + 三种降级各一张）',
    all.figures.length === 7, JSON.stringify(all.figures.map((f) => [f.article, f.state])));
  const textImage = byEntry('u1')[0];
  check('正：文本+图片那条——`<img>` 的 src 与我们给的原文**逐字相同**，caption 报出 mime 与字节数',
    textImage?.src === dataUrl && textImage.caption === `图片 · image/png · ${pngBytesLength} 字节` && textImage.state === 'loaded',
    JSON.stringify(brief(textImage)));
  check('正：宽高是从图片文件头读出来的真尺寸（400×300，不是猜的、也不是等着解码才知道）',
    textImage?.width === '400' && textImage?.height === '300' && textImage.naturalWidth === 400 && textImage.naturalHeight === 300,
    JSON.stringify({ width: textImage?.width, height: textImage?.height, naturalWidth: textImage?.naturalWidth, naturalHeight: textImage?.naturalHeight }));
  check('正：「只有图片」的消息不再是空壳（有图、且正文里没有那句反话）',
    byEntry('u2')[0]?.hasImg === true && !all.bodyText.includes('网页暂不显示图片内容') && all.placeholderLeft === 0,
    JSON.stringify({ figures: byEntry('u2').length, placeholderLeft: all.placeholderLeft }));
  check('正：assistant 的 image part 也画出来（原图从 content 同序取到）',
    byEntry('a1')[0]?.src === dataUrl,
    JSON.stringify(brief(byEntry('a1')[0])));

  // ── 正：工具结果里的图配到工具卡上 ─────────────────────────────────────────
  const toolFigure = all.figures.filter((figure) => figure.inToolOutput);
  check('正：`read` 工具结果里的图画在**工具卡**里（.tool-output 内，toolResult 自己不单独成节点）',
    toolFigure.length === 1 && toolFigure[0].src === dataUrl && toolFigure[0].inToolOutput === true,
    JSON.stringify(toolFigure.map(brief)));
  check('正：卡片直接子元素次序不变（图片进的是 .tool-output，不是给卡片加兄弟；新增的是角标行与标注控件）',
    all.tool?.childSignature === 'div.message-role|div.tool-call|div.tool-output|div.annotate',
    JSON.stringify(all.tool?.childSignature));
  check('正：画得出图时，结果文本里的占位行让位（不再有「网页暂不显示图片内容」这句反话）',
    all.tool?.result === 'Read image file [image/png]' && !all.tool.result.includes('（网页暂不显示图片内容）'),
    JSON.stringify(all.tool?.result));

  // ── 正：不跳变（插进 DOM 那一刻的盒子 == 解码完成之后的盒子）──────────────────
  const probe = await ui.evaluate(`(async () => {
    const { renderMessages } = await import('/render.js');
    const payload = await (await fetch('/api/sessions/${SESSION}/messages')).json();
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:1000px;';
    document.body.append(host);
    renderMessages(host, payload);
    const figure = host.querySelector('.message-image');
    const img = figure.querySelector('img');
    const atInsert = {
      state: figure.dataset.state,
      boxHeight: +img.getBoundingClientRect().height.toFixed(2),
      naturalWidth: img.naturalWidth,
      width: img.getAttribute('width'),
      height: img.getAttribute('height'),
    };
    host.remove();
    return atInsert;
  })()`);
  check('正：插进 DOM 那一刻盒子已经按 `width`/`height` 属性占好了 ~300px（不必等解码完成才知道多高）',
    probe.state === 'pending' && Math.abs(probe.boxHeight - 300) <= 3 && probe.width === '400' && probe.height === '300',
    JSON.stringify(probe));
  check('正：解码完成之后盒子一模一样（这就是「不引起布局跳变」）',
    textImage.boxHeight === probe.boxHeight,
    JSON.stringify({ afterLoad: textImage.boxHeight, atInsert: probe.boxHeight }));

  // ── 反：三种画不出来的现场，各有各的话，且不留空白 ──────────────────────────
  const broken = byEntry('u3')[0];
  check('反：坏 base64 ⇒ 摘掉那张 img，写下「解不出图片」，不留空白也不崩',
    broken?.state === 'error' && broken.hasImg === false && /解不出图片/.test(broken.bad ?? '') && broken.width === null,
    JSON.stringify(broken));
  const missing = byEntry('u4')[0];
  check('反：缺 `data` ⇒ 明说「没有 base64 数据」（不是画一张破图，也不是静默空白）',
    missing?.state === 'missing' && missing.hasImg === false && /没有 base64 数据/.test(missing.bad ?? ''),
    JSON.stringify(missing));
  const unknown = byEntry('u5')[0];
  check('反：认不出类型 ⇒ 明说「认不出类型，未内联显示」',
    unknown?.state === 'unknown-type' && unknown.hasImg === false && /认不出类型/.test(unknown.bad ?? ''),
    JSON.stringify(unknown));
  check('反：三种降级都带上了元信息 caption（mime / 字节数，或如实写「未知」）',
    (broken.caption ?? '').includes('image/png') && (missing.caption ?? '').includes('1216 字节') && (unknown.caption ?? '').includes('类型未知'),
    JSON.stringify([broken.caption, missing.caption, unknown.caption]));

  check('页面没有未捕获异常或 console.error', ui.pageProblems.length === 0, JSON.stringify(ui.pageProblems));

  await ui.screenshot(screenshotFile);
  print('figures', all.figures.map((f) => ({ entry: f.article, state: f.state, box: [f.width, f.height], src: f.src ? f.src.slice(0, 32) + '…' : null })));
  print('tool card', all.tool);
  print('screenshots', { images: screenshotFile });
  print('RESULT', `M-31 inline images frontend PASS (${checks} checks)`);
} finally {
  await ui.close();
}
