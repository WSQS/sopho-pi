// test/browser-spawn-scan.mjs —— 「每个起真浏览器的 spawn 点都给了**私有** TMPDIR/home/XDG」这条机械规矩的扫描器。
//
// 为什么要有它（2026-09-23 派单 chromium-isolation；原始读数见交付报告）：
//   · 不隔离 TMPDIR ⇒ 每次起浏览器都在**共享 /tmp** 留两个 `org.chromium.Chromium.*` 目录；
//   · 不重定向 HOME/XDG_CONFIG_HOME ⇒ crashpad 的 `--database` 指向用户真实 `~/.config/chromium/Crash Reports`
//     并真的往里写（`settings.dat`）。两者都不是「某个门忘了」而是「一批门都这样」，所以规矩得是**机械的**。
//
// 它只做一件事：在一份源码里找出「起浏览器」的 `spawn(` 调用，检查它的选项对象里有没有
// `env: browserSandboxEnv(...)`。纯函数（只吃字符串）—— 谁都能拿它去扫一份**副本**做正/负对照，
// 真树一个字节都不动。当前使用者：
//   · `test/harness-contract.mjs`（`npm run test:harness` / `test:prepush` 会跑，fail 即拦）；
//   · `test/browser-sandbox-isolation.mjs`（本件的端到端门，顺带打印同一份读数）。
//
// 认「起浏览器」的判据是命令行参数里的**浏览器旗标**（`--user-data-dir` / `--remote-debugging-port` /
// `--headless` / `--profile`），不是进程名 —— 与 `bin/sandbox-sweep.mjs` 同一条口径：这台机器上命令行
// 带 `headless` 的进程 30+ 个，按名字认会认到用户自己的东西。
//
// ⚠️ 已知的边界（不许当成「全扫到了」）：
//   · 首参是 `process.execPath` 的 spawn **不算**真浏览器（那是 `test/fixtures/sandbox-stand-in-browser.mjs`
//     那种**替身**：node 装作浏览器，用来受控地喂 `bin/sandbox-sweep.mjs`）⇒ 这类调用点既不要求信封、也不会被报；
//   · 注释里的示例**只**在行首就是注释（`//` / `*`）时被跳过 —— 其它形状的注释里若写了整条 spawn，会误报；
//   · 括号配对会跳过字符串/模板串里的括号，但不解析正则字面量里的括号。
export const BROWSER_ARG_HINTS = Object.freeze([
  /--user-data-dir/,
  /--remote-debugging-port/,
  /--headless/,
  /['"`]--profile['"`]/,
  /FIREFOX_BIN/,
]);

const ISOLATION_CALL = /env:\s*browserSandboxEnv\s*\(/;

// 从一个 `(` 开始取到配对的 `)`：字符串/模板串里的括号不算（`'--user-data-dir=' + x` 这类实参里常有）。
function callTextAt(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return source.slice(openIndex);
}

// 扫一份源码：返回 { sites, violations }。
//   · sites：认到的 spawn 点（`line`、`standIn`、`isolated`）—— 用来做「一次也没认到」的兜底断言；
//   · violations：认到、但选项对象里没有 `env: browserSandboxEnv(...)` 的点（`file` 由调用方拼）。
export function scanBrowserSpawnIsolation(source, file = '<source>') {
  const sites = [];
  const violations = [];
  const pattern = /\bspawn(?:Sync)?\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    const lineNumber = source.slice(0, match.index).split('\n').length;
    const prefix = source.slice(lineStart, match.index);
    // 行首就是注释的（整行示例）不认 —— 例如替身 fixture 的头注释里写着一条完整调用。
    if (/^\s*(\/\/|\/\*|\*)/.test(prefix)) continue;
    const open = source.indexOf('(', match.index);
    const call = callTextAt(source, open);
    if (!BROWSER_ARG_HINTS.some((hint) => hint.test(call))) continue;
    const bin = call.slice(1, call.indexOf(',') === -1 ? call.length : call.indexOf(','));
    const standIn = /process\.execPath/.test(bin);
    const isolated = ISOLATION_CALL.test(call);
    const site = { file, line: lineNumber, standIn, isolated };
    sites.push(site);
    if (!standIn && !isolated) {
      violations.push({ ...site, text: call.split('\n')[0].trim().slice(0, 180) });
    }
  }
  return { sites, violations };
}
