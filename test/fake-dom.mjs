export class FakeElement {
  constructor(ownerDocument = null, tagName = 'div') {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
    this.parentElement = null;
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.attributes = {};
    this.hidden = false;
    this.disabled = false;
    this.focusCalls = 0;
    this.scrollIntoViewCalls = [];
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node && typeof node === 'object') node.parentElement = this;
      this.children.push(node);
    }
  }

  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      if (node && typeof node === 'object') node.parentElement = this;
      this.children.unshift(node);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.children) if (child && typeof child === 'object') child.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }

  // 插到某个子节点**之前**（`anchor` 为 null = append）。`insertBefore` 在**同容器内的节点**
  // 上就是「挪个位置」（先把旧的捅掉再插），与真 DOM 一致 —— 直播块的落位（web/app.js 的
  // restackTransient、web/render.js 的 appendMessageNodes 的 `options.before`）靠的是这一条。
  insertBefore(node, anchor) {
    if (anchor === null || anchor === undefined) {
      this.append(node);
      return node;
    }
    const index = this.children.indexOf(anchor);
    if (index < 0) {
      this.append(node);
      return node;
    }
    const rest = this.children.filter((child) => child !== node);
    const target = rest.indexOf(anchor);
    if (node && typeof node === 'object') node.parentElement = this;
    rest.splice(target, 0, node);
    this.children = rest;
    return node;
  }

  // `parentNode` / `nextSibling`：真 DOM 的邻接读法。web/app.js 的 restackTransient 用它算
  // 「顺序对不对」（对了就一个写都不做）—— 假 DOM 里也得给，不然那一段在套件里等于永远进「不对」分支。
  get parentNode() { return this.parentElement; }

  // `isConnected`：真 DOM 的「这个节点在文档里吗」。工具卡的耗时定时器靠它清场（正文重画 /
  // 切会话换掉的那张卡 = 离开文档 ⇒ 自己出册，定时器最后自己停）。假 DOM 按同一语义给：
  // 根向上直到 `documentElement` 才算连上（`createElement` 出来的孤立节点是 false，同真 DOM）。
  get isConnected() {
    let node = this;
    while (node.parentElement) node = node.parentElement;
    return this.ownerDocument !== null && node === this.ownerDocument.documentElement;
  }

  get nextSibling() {
    const parent = this.parentElement;
    if (!parent) return null;
    const index = parent.children.indexOf(this);
    if (index < 0 || index + 1 >= parent.children.length) return null;
    return parent.children[index + 1];
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    const text = String(value);
    this.attributes[name] = text;
    if (name === 'hidden') this.hidden = true;
    if (name === 'disabled') this.disabled = true;
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'hidden') this.hidden = false;
    if (name === 'disabled') this.disabled = false;
  }

  matches(selector) {
    if (selector.startsWith('.')) {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      return selector.slice(1).split('.').every((name) => classes.has(name));
    }
    if (selector.startsWith('#')) return this.getAttribute('id') === selector.slice(1);
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some((child) => child && typeof child === 'object' && child.contains?.(candidate));
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (!child || typeof child !== 'object') continue;
      if (child.matches?.(selector)) return child;
      const descendant = child.querySelector?.(selector);
      if (descendant) return descendant;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (!child || typeof child !== 'object') continue;
      if (child.matches?.(selector)) found.push(child);
      if (child.querySelectorAll) found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  focus() { this.focusCalls += 1; }

  // 输入型元素把光标还给原位置（web/app.js 的问题页重画不打断答题）。假 DOM 只需要
  // 记下这次调用与范围，够契约门与行为套件断言「重画后确实还原过光标」。
  setSelectionRange(start, end = start) { this.selectionRange = { start, end }; }

  // 文本节点（`createTextNode` 也建 FakeElement）的增量写：与 `textContent` 同一份内容，
  // 这样用假 DOM 的行为套件读 `textContent` 也能看到 `appendData` 的效果。
  get data() { return this.textContent; }

  set data(value) { this.textContent = String(value); }

  appendData(value) { this.textContent += String(value); }

  scrollIntoView(options) { this.scrollIntoViewCalls.push(options); }

  addEventListener() {}

  // `EventSource`/委托监听那一类在假 DOM 里只有「登记」意义（`addEventListener` 就是个空函数），
  // 卸监听同义 —— 注解触发点装卸（web/app.js 的 installAnnotationTrigger）会走到 `removeEventListener`。
  removeEventListener() {}

  // `Node#cloneNode`：卡片正文取样（web/render.js 的 annotationCardText）要把 `.message-body`
  // 克隆一份再把里面的工具卡剔掉 —— **原节点一个都不能动**。假 DOM 按同一语义给：元素自己的
  // 字段浅拷（`dataset`/`style`/`attributes` 各拷一份，免得改克隆体回头改到原件），子节点按 `deep` 深拷。
  cloneNode(deep = false) {
    const clone = new FakeElement(this.ownerDocument, this.tagName);
    clone.className = this.className;
    clone.textContent = this.textContent;
    clone.hidden = this.hidden;
    clone.disabled = this.disabled;
    clone.dataset = { ...this.dataset };
    clone.style = { ...this.style };
    clone.attributes = { ...this.attributes };
    if (deep) {
      for (const child of this.children) {
        clone.append(child && typeof child === 'object' && typeof child.cloneNode === 'function' ? child.cloneNode(true) : child);
      }
    }
    return clone;
  }
}

export class FakeDocument {
  constructor() { this.documentElement = new FakeElement(this, 'html'); }

  createElement(tagName) { return new FakeElement(this, tagName); }
  createTextNode(text) {
    const node = new FakeElement(this, '#text');
    node.textContent = text;
    return node;
  }
}
