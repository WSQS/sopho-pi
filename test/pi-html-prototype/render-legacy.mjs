// test/pi-html-prototype/render-legacy.mjs —— **换渲染器之前的正式消息渲染器，冻结一份**。
//
// 用途只有一个：给 test/pi-html-render-adversarial.mjs 当「before」基线，量换 marked 前后的
// 渲染耗时 / DOM 体积 / 特性差异。**它不是产品路径**（产品路径是 web/render.js → web/markdown.mjs），
// 也不要在这里加功能 —— 一旦改了，历史数字就对不上了。内容逐字取自旧
// web/render.js:30 的 renderMarkdown（连同它私有的 appendInline）。

export function renderMarkdownLegacy(document, text) {
  const root = document.createElement('div');
  root.className = 'markdown';
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const fence = /^```\s*([^\s`]*)/.exec(line);
    if (fence) {
      const code = [];
      for (index += 1; index < lines.length && !lines[index].startsWith('```'); index += 1) code.push(lines[index]);
      if (index < lines.length) index += 1;
      const pre = document.createElement('pre');
      pre.className = 'code-block';
      if (fence[1]) pre.dataset.language = fence[1];
      const codeNode = document.createElement('code');
      codeNode.textContent = code.join('\n');
      pre.append(codeNode);
      root.append(pre);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const list = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (heading || list || quote) {
      const node = document.createElement(heading ? `h${heading[1].length}` : quote ? 'blockquote' : 'div');
      if (list) node.className = 'markdown-list-item';
      appendInline(document, node, (heading?.[2] ?? list?.[1] ?? quote?.[1] ?? ''));
      root.append(node);
      index += 1;
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(?:```|#{1,6}\s|>\s?|\s*(?:[-*+]|\d+\.)\s)/.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    const node = document.createElement('p');
    appendInline(document, node, paragraph.join('\n'));
    root.append(node);
  }
  return root;
}

function appendInline(document, parent, text) {
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/g;
  let offset = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > offset) parent.append(document.createTextNode(text.slice(offset, match.index)));
    const token = match[0];
    const node = document.createElement(token.startsWith('`') ? 'code' : token.startsWith('**') ? 'strong' : 'em');
    node.textContent = token.startsWith('**') ? token.slice(2, -2) : token.slice(1, -1);
    parent.append(node);
    offset = match.index + token.length;
  }
  if (offset < text.length) parent.append(document.createTextNode(text.slice(offset)));
}
