#!/usr/bin/env node
// test/gen-values-freshness.mjs —— 「生成物新鲜度」门：**盘上那份 == 按当前规格刚重跑出来的**（逐字节）。
//
// 为什么要有它（总台 2026-09-26 复核的原话）：「`npm run gen:designvalues` 重跑后，与盘上
// `web/generated/design-values.css` **逐字节相同**，不等就红（这样『改了规格忘了重跑生成器』就不会静默分叉）」。
// 取值层那条链是「规格 ⇒ 生成物 ⇒ 产品」：生成物一旦是旧的，产品就在用旧值，而**没人会看见** ——
// 本门把这件事变成一条**不用浏览器、一两秒**就能跑的红/绿。
//
// 它**不另写一套比较**（同一件事两个实现就是下一处会漂的地方）：直接跑**真生成器自己的** `--check`
// （`bin/gen-design-values.mjs --check`，＝`npm run gen:designvalues:check` 那个判据：盘上那份与刚渲染
// 出来的逐字节比）；另外**再渲染一次**打到 stdout 只为**取证**（两侧的 sha256 ＋ 字节数；不一致时把第一处
// 不同的行、以及生成器自己那句话原样打出来）。两个口径必须一致 —— 生成器说「一致」而字节不同（或反过来）
// 也判红：那是**门的判据自己坏了**，不是"差不多"。
//
// 它**还有一条落盘原子性**的断言（`landing:no-partial-read`）：真生成器在改写这份生成物时，让真读者
// 一直读（16 路本进程 `readFile` ＋ 4 路走**真静态服务**的 HTTP GET），**每一次读都必须要么是完整的
// 旧那份、要么是完整的新那份**；读到 0 字节 / 半份 / 读不到就红。为什么值这一条：这份生成物有**活的
// 读者**（页面 `<link>`、编辑页 `readGenerated()`、两道门直接读它），而生产里改写它的那一刻是
// **人在终端跑 `npm run gen:designvalues`** —— 页面 / iframe / 门完全可能正开着。见下面「装置」那一段。
//
// 用法：
//   node test/gen-values-freshness.mjs                        # 真仓库（规格与生成物都在规范路径）
//   node test/gen-values-freshness.mjs --out=<文件>            # 把「盘上那一份」指到别处（反证臂用；
//                                                             # 生成来源仍是**规范路径**那份规格 ⇒ 头部注记逐字一致）
//   node test/gen-values-freshness.mjs --reverse-arm=onebyte   # 反证臂①：手改生成物**一个字节** ⇒ 必红
//   node test/gen-values-freshness.mjs --reverse-arm=tornwrite # 反证臂②：把生成器的落盘换成**分两块写 ＋
//                                                             # 停 400 ms** ⇒ `landing:no-partial-read` 必红
//
// 出口：0 = 新鲜（且若选了臂，臂也红到位）；1 = 不新鲜 / 两口径不一致 / 臂没红到位。

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { removeSandbox } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREEN = 'settings-overlay';
const GENERATOR = path.join(root, 'bin', 'gen-design-values.mjs');
const SPEC_RELATIVE = path.join('spec', 'screens', `${SCREEN}.md`).split(path.sep).join('/');
const CANONICAL_OUT = path.join(root, 'web', 'generated', 'design-values.css');
const ARM = (process.argv.find((arg) => arg.startsWith('--reverse-arm=')) || '').split('=')[1] || null;
const argOf = (name) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const problems = [];
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const print = (label, value) => process.stdout.write(`${label}: ${value}\n`);
let failures = 0;
function check(id, name, ok, detail) {
  if (ok) {
    process.stdout.write(`✓ [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
    return true;
  }
  failures += 1;
  process.stdout.write(`✗ [${id}] ${name} —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`);
  return false;
}

const sandboxes = [];

/** 反证臂 `tornwrite` 的接缝：生产生成器（`bin/gen-design-values.mjs`）里那段**原子落盘**
    （先写**同目录**临时文件、再 `rename` 换上去）。 */
const ATOMIC_LANDING_SEAM = 'async function atomicWriteFile(file, text) {\n  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;\n  await writeFile(temporary, text, \'utf8\');\n  await rename(temporary, file);\n}';
/** 把它换成**分两块写 ＋ 中间停 400 ms**：切点取在第 2 条 `--design-*` 声明的行末（于是中间态里
    `:root` 变量表**少了几条**），装置自己会把 cut 打出来 —— 臂据此自证切点落在中间。 */
const TORN_LANDING_FOR = `async function atomicWriteFile(file, text) {
  const { open } = await import('node:fs/promises');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const lines = text.split('\\n');
  const rootAt = lines.findIndex((line) => line.includes(':root {'));
  let seen = 0;
  let cut = Math.floor(text.length / 2);
  for (let i = rootAt + 1; i < lines.length; i += 1) {
    if (lines[i].includes('--design-')) seen += 1;
    if (seen === 2) { cut = lines.slice(0, i + 1).join('\\n').length + 1; break; }
  }
  if (!(cut > 0 && cut < text.length)) cut = Math.floor(text.length / 2);
  const handle = await open(file, 'w');
  process.stdout.write('[tornwrite] cut=' + Buffer.byteLength(text.slice(0, cut)) + ' total=' + Buffer.byteLength(text) + ' gap=400ms\\n');
  await handle.write(text.slice(0, cut));
  await sleep(400);
  await handle.write(text.slice(cut));
  await handle.close();
}`;

/** 反证臂清单（`--reverse-arm=<名>`）：每条声明它盯着哪个文件（`file:`）、以及哪一段字节（`from:` ⇒ `to:`）。 */
const ARM_MUTANTS = {
  onebyte: {
    what: '把「盘上那份」换成**手改一个字节**的副本（`560px` ⇒ `561px`）⇒ 两条新鲜度断言必红',
    expect: ['freshness:bytes', 'freshness:check-agrees'],
  },
  tornwrite: {
    what: '把生成器的落盘换成**分两块写 ＋ 中间停 400 ms**（切点落在整行边界）⇒ `landing:no-partial-read` 必红',
    file: 'gen-design-values.mjs',
    from: ATOMIC_LANDING_SEAM,
    to: TORN_LANDING_FOR,
    expect: ['landing:no-partial-read'],
  },
};
if (ARM && !ARM_MUTANTS[ARM]) throw new Error(`不认识的反证臂：${ARM}（可选：${Object.keys(ARM_MUTANTS).join(' / ')}）`);

/** 反证臂 `onebyte`：把生成物拷一份出来，**手改一个字节**（`560px` ⇒ `561px`），再拿它当「盘上那份」。 */
let outFile = path.resolve(argOf('out') || CANONICAL_OUT);
if (ARM === 'onebyte') {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-genvalues-'));
  sandboxes.push(sandbox);
  outFile = path.join(sandbox, 'design-values.css');
  const canonical = await readFile(CANONICAL_OUT, 'utf8');
  if (!canonical.includes('560px')) throw new Error('反证臂 onebyte 的改写没命中（生成物里没有 560px？）');
  await writeFile(outFile, canonical.replace('560px', '561px'), 'utf8');
  print('反证臂 onebyte', `手改一个字节（560px ⇒ 561px）后的副本：${outFile}（真仓库那份一个字节没动）`);
}

// ── 两个口径：① 真生成器自己的 `--check`；② 门自己再渲染一次逐字节比 ──────────────────────────────
const checkRun = spawnSync(process.execPath, [GENERATOR, `--screen=${SCREEN}`, `--out=${outFile}`, '--check'], { encoding: 'utf8', timeout: 60000 });
const renderRun = spawnSync(process.execPath, [GENERATOR, `--screen=${SCREEN}`, '--stdout'], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
if (renderRun.status !== 0) {
  print('生成器 --stdout 失败', JSON.stringify({ exit: renderRun.status, stderr: (renderRun.stderr ?? '').trim() }));
  process.exit(1);
}
const onDisk = await readFile(outFile).catch(() => null);
const fresh = Buffer.from(renderRun.stdout ?? '', 'utf8');
const identical = onDisk !== null && onDisk.equals(fresh);
const checkSaysFresh = checkRun.status === 0;

print('规格（唯一来源）', SPEC_RELATIVE);
print('盘上那一份', `${outFile}${onDisk === null ? '（读不到）' : `（${onDisk.length} B；sha256 ${sha256(onDisk).slice(0, 12)}…）`}`);
print('刚渲染出来', `${fresh.length} B；sha256 ${sha256(fresh).slice(0, 12)}…`);
print('生成器自己的 --check', `exit=${checkRun.status}｜${(checkRun.stdout || checkRun.stderr || '').trim().split(/\r?\n/)[0] ?? ''}`);

// 第一处不同（红的时候要看得见**哪一行**变了，不是只说"不相等"）
let firstDiff = null;
if (!identical && onDisk !== null) {
  const left = onDisk.toString('utf8').split(/\r?\n/);
  const right = fresh.toString('utf8').split(/\r?\n/);
  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    if (left[at] !== right[at]) { firstDiff = { line: at + 1, onDisk: left[at] ?? '(没有这一行)', fresh: right[at] ?? '(没有这一行)' }; break; }
  }
}

check('freshness:bytes', `盘上那份 web/generated/design-values.css == 按 ${SPEC_RELATIVE} 刚重跑出来的（**逐字节**）`,
  identical,
  identical
    ? `${fresh.length} B｜sha256 ${sha256(fresh).slice(0, 12)}…（两侧相同）`
    : `盘上 ${onDisk === null ? '读不到' : `${onDisk.length} B（sha256 ${sha256(onDisk).slice(0, 12)}…）`} / 刚渲染 ${fresh.length} B（sha256 ${sha256(fresh).slice(0, 12)}…）`
      + `｜第一处不同在第 ${firstDiff?.line} 行：盘上 ${JSON.stringify(firstDiff?.onDisk)} / 刚渲染 ${JSON.stringify(firstDiff?.fresh)}`);
check('freshness:check-agrees', '生成器自己的 `--check`（`npm run gen:designvalues:check` 的同一个判据）与上面这一条**口径一致**（它说一致就得真一致；说没跟上就得真不同）',
  checkSaysFresh === identical,
  `--check exit=${checkRun.status}（＝“${checkSaysFresh ? '一致' : '没跟上'}”）｜字节比较＝“${identical ? '相同' : '不同'}”`);

// ── 装置：真读者在「生成器正把这份生成物改写掉」的这段时间里读到了什么 ────────────────────────────
//
// 判据（一句话）：**读者看到的，要么是完整的旧那份、要么是完整的新那份 —— 永远不许是别的东西**。
//
// 为什么要有它（2026-09-27 派单）：这份生成物有**活的读者** ——
//   · 生产：`server/app.mjs` 的 `serveStatic`（`await readFile(filePath)`，`cache-control: no-store`）把
//     `/generated/design-values.css` 发给页面（`web/index.html` 的 `<link>`；编辑页的预览 iframe
//     加载的也是同一个真页面）；
//   · 编辑页：`web/design.js` 的 `readGenerated()` 拉它、与规格逐条比（`cache: 'no-store'`）；
//   · 门：`test/design-spec.mjs` 与本门自己**直接 `readFile`** 它。
// 而生产里改写它的那一刻是**人在终端跑 `npm run gen:designvalues`**（编辑页自己不能重跑生成器）——
// 页面 / iframe / 门完全可能正开着。落盘若不是原子的（先截断、再写），读者就会读到 0 字节 / 半份。
// 这一条**量**的就是那件事：把真生成器起成**子进程**（异步 —— `spawnSync` 会把本门的事件循环卡住，
// 读者在整个落盘期间一次都读不到，装置就成了假的），同时让真读者一直读。
//
// 反证臂 `tornwrite` 把这份落盘换成**分两块写 ＋ 中间停 400 ms**（切点落在整行边界），于是
// 「读者读到半份」这件事**必定发生**（不再靠时序碰运气）；臂自己把 cut 打出来自证切点在中间。
// 读者的路数 / 轮数：预修版（裸 `writeFile`）量到的那个中间态是**微秒级**的，靠采样去碰 ——
// 32 路直读 × 8 轮下实测 10/10 轮次都能读到 0 字节（5–22 次/轮）；16 路 × 3 轮会偶尔一轮都不中。
// 修好之后（rename）这一条是**确定**绿的：读者只可能看到完整的旧那份或完整的新那份。
const READER_WORKERS = 32;
const HTTP_READER_WORKERS = 4;
const DEVICE_ROUNDS = 8;

const designVars = (text) => (String(text).match(/--design-[\w-]+:/g) ?? []).length;
const digestOf = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 12);

/** 跑一次真生成器（可以是**副本**）：真子进程、**异步**（见上）。返回它的 stdout / stderr 原样。 */
function runGeneratorAsync({ file = GENERATOR, spec, out }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, `--screen=${SCREEN}`, `--spec=${spec}`, `--out=${out}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`生成器退出码 ${code}：${(stderr || stdout).trim()}`));
    });
  });
}

/** 按某份规格渲染一次生成物（只打 stdout、不写盘）—— 用来算出「新那份」的**权威字节**。 */
function renderOf(specFile) {
  const run = spawnSync(process.execPath, [GENERATOR, `--screen=${SCREEN}`, `--spec=${specFile}`, '--stdout'], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`生成器 --stdout 失败：exit=${run.status}｜${(run.stderr ?? '').trim()}`);
  return run.stdout;
}

/** 与生产同形的静态服务：每个请求 `readFile` 一次、`cache-control: no-store`（`server/app.mjs` 的 serveStatic）。 */
async function startStaticServer(servedFile) {
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://device.local').pathname;
    if (pathname !== '/generated/design-values.css') { response.writeHead(404).end(); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    try {
      const body = await readFile(servedFile);
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
      if (request.method === 'HEAD') response.end(); else response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** 一次 GET（keep-alive；读者要的是**采样率**，不是 HTTP 语义）。 */
function httpGet(port, agent) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/generated/design-values.css', agent }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on('error', (error) => resolve({ status: 'ERR', body: Buffer.alloc(0), error: error.message }));
  });
}

/**
 * 让真读者在 `runWrite()`（生成器的一次落盘，跑 `DEVICE_ROUNDS` 轮）期间一直读，把每一次读到的**内容**
 * 记下来：`old`（完整的旧那份）/ `new`（完整的新那份）/ `partial`（别的一切：0 字节、半份、读不到、
 * HTTP 非 200）。`partial` 带上原始读数（长度、变量条数、是不是旧/新的严格前缀、开头几字）——
 * 要贴的就是「读者读到了什么」。
 */
async function measureLanding({ specFile, outFile, runWrite, rounds }) {
  const oldBytes = await readFile(outFile);
  const newBytes = Buffer.from(renderOf(specFile), 'utf8');
  if (oldBytes.length === 0) throw new Error(`装置前提不成立：${outFile} 是空的`);
  if (oldBytes.equals(newBytes)) throw new Error('装置前提不成立：旧那份与将要写入的新那份字节相同（读者读到的旧/新分不出来）');
  const tally = { reads: 0, old: 0, new: 0, partial: 0, httpNotOk: 0, byKind: { file: { old: 0, new: 0, partial: 0 }, http: { old: 0, new: 0, partial: 0 } } };
  const partials = new Map();
  const server = await startStaticServer(outFile);
  const agent = new http.Agent({ keepAlive: true, maxSockets: HTTP_READER_WORKERS });
  const record = (source, buffer) => {
    tally.reads += 1;
    const kind = buffer === null ? 'partial' : (buffer.equals(oldBytes) ? 'old' : (buffer.equals(newBytes) ? 'new' : 'partial'));
    tally[kind] += 1;
    tally.byKind[source][kind] += 1;
    if (kind !== 'partial') return;
    const sha = buffer === null ? '(读不到)' : digestOf(buffer);
    const seen = partials.get(sha);
    if (seen) { seen.count += 1; return; }
    const text = buffer === null ? '' : buffer.toString('utf8');
    partials.set(sha, {
      length: buffer === null ? null : buffer.length,
      vars: designVars(text),
      prefixOfOld: buffer !== null && buffer.length < oldBytes.length && oldBytes.subarray(0, buffer.length).equals(buffer),
      prefixOfNew: buffer !== null && buffer.length < newBytes.length && newBytes.subarray(0, buffer.length).equals(buffer),
      head: text.slice(0, 40).replace(/\s+/g, ' '),
      count: 1,
    });
  };
  const stop = { flag: false };
  const fileReaders = Array.from({ length: READER_WORKERS }, async () => {
    while (!stop.flag) record('file', await readFile(outFile).catch(() => null));
  });
  const httpReaders = Array.from({ length: HTTP_READER_WORKERS }, async () => {
    while (!stop.flag) {
      const reply = await httpGet(server.port, agent);
      if (reply.status !== 200) tally.httpNotOk += 1;
      record('http', reply.body);
    }
  });
  await sleep(30); // 让读者先跑起来（否则「完整旧那份」可能一次都没被读到 —— 那条也是判据的一半）
  let writerStdout = '';
  for (let round = 1; round <= rounds; round += 1) writerStdout += (await runWrite()).stdout;
  await sleep(30); // 写完之后再读一会儿（证明读者确实读到了「完整新那份」）
  stop.flag = true;
  await Promise.all([...fileReaders, ...httpReaders]);
  agent.destroy();
  await server.close();
  return { oldBytes, newBytes, tally, partials, writerStdout };
}

/** 把读数写成一行（红/绿都要能一眼看出「读者读到了什么」）。 */
function describeLanding(landing) {
  const { tally, partials } = landing;
  const fullVars = designVars(landing.newBytes.toString('utf8'));
  const readings = [...partials.entries()].map(([sha, read]) => `${sha}｜${read.length === null ? '读不到' : `${read.length} B`}｜`
    + `\`--design-*\` ${read.vars}/${fullVars} 条｜`
    + (read.length === null ? '' : `旧那份的严格前缀：${read.prefixOfOld ? '是' : '否'}；新那份的严格前缀：${read.prefixOfNew ? '是' : '否'}｜`)
    + `读到 ${read.count} 次｜开头 ${JSON.stringify(read.head)}`);
  const per = (source) => `${tally.byKind[source].old} 完整旧 / ${tally.byKind[source].new} 完整新 / ${tally.byKind[source].partial} **非完整**`;
  return `读者共 ${tally.reads} 次读 —— 本进程 readFile（${per('file')}）；走真静态服务 GET（${per('http')}）`
    + (tally.httpNotOk ? `；HTTP 非 200 ${tally.httpNotOk} 次` : '')
    + (readings.length ? `\n    非完整读数（同一个 sha 去重）：\n      - ${readings.join('\n      - ')}` : '');
}

// 装置的沙箱：规格副本 ＋ 生成物副本（真 `spec/` 与真 `web/generated/` 一个字节不动）。
const deviceSandbox = await mkdtemp(path.join(os.tmpdir(), 'sopho-genvalues-landing-'));
sandboxes.push(deviceSandbox);
const deviceSpecFile = path.join(deviceSandbox, 'settings-overlay.md');
await cp(path.join(root, 'spec', 'screens', `${SCREEN}.md`), deviceSpecFile);
const deviceOut = path.join(deviceSandbox, 'generated', 'design-values.css');
await mkdir(path.dirname(deviceOut), { recursive: true });
await writeFile(deviceOut, renderOf(deviceSpecFile), 'utf8'); // 盘上那份 = 按**没改过**的规格生成的 ⇒ 「旧那份」
print('装置', `生成物副本 ${deviceOut}（旧那份）`);
const deviceSpecText = await readFile(deviceSpecFile, 'utf8');
if (!deviceSpecText.includes('560px')) throw new Error('装置前提不成立：规格副本里找不到 560px（几何表那一格改名了？）');
await writeFile(deviceSpecFile, deviceSpecText.replace('560px', '561px'), 'utf8'); // 「一次编辑」：560px ⇒ 561px
print('装置', `规格副本 ${deviceSpecFile} 改成 561px（真 spec/ 一个字节不动）—— 接下来让真生成器改写生成物，同时真读者一直读`);

let runWrite = () => runGeneratorAsync({ spec: deviceSpecFile, out: deviceOut });
if (ARM === 'tornwrite') {
  const arm = ARM_MUTANTS.tornwrite;
  const generatorSource = await readFile(GENERATOR, 'utf8');
  if (!generatorSource.includes(arm.from)) throw new Error(`反证臂 ${ARM} 的改写没命中（生成器形状变了？）：${arm.what}`);
  const mutatedFile = path.join(deviceSandbox, 'gen-design-values-torn.mjs');
  await writeFile(mutatedFile, generatorSource.replace(arm.from, arm.to), 'utf8');
  const mutatedSource = await readFile(mutatedFile, 'utf8');
  if (mutatedSource === generatorSource || !mutatedSource.includes('[tornwrite] cut=')) {
    throw new Error(`反证臂 ${ARM} 的变异**没落地**（副本与源相同 / 找不到注入标记）—— 这一臂不算数`);
  }
  print(`反证臂 ${ARM}`, `生成器副本 ${mutatedFile}（原子落盘 ⇒ 分两块写 ＋ 停 400 ms；真 bin/ 一个字节不动）`);
  runWrite = () => runGeneratorAsync({ file: mutatedFile, spec: deviceSpecFile, out: deviceOut });
}

const landing = await measureLanding({
  specFile: deviceSpecFile,
  outFile: deviceOut,
  runWrite,
  // 臂的中间态是**必定发生**的（400 ms 的停顿）⇒ 3 轮就够；基线要靠时序去碰那个**微秒级**的窗口
  //（预修版实测：8 轮下 10/10 红，5–22 次非完整读/轮；5 轮下偶尔会一轮都不中）⇒ 基线多跑几轮。
  rounds: ARM === 'tornwrite' ? 3 : DEVICE_ROUNDS,
});
const landingIntact = landing.tally.partial === 0 && landing.tally.old > 0 && landing.tally.new > 0;
check('landing:no-partial-read',
  '真读者在生成器改写这份生成物期间**只**读到「完整的旧那份」或「完整的新那份」（读到 0 字节 / 半份 / 读不到 ⇒ 红）',
  landingIntact, describeLanding(landing));

let armOk = null;
if (ARM === 'onebyte') {
  // 反证臂：手改一个字节之后，**两条**都必须红（这才是"不等就红"的机械证据）。
  const redIds = [];
  if (!identical) redIds.push('freshness:bytes');
  if (!checkSaysFresh) redIds.push('freshness:check-agrees');
  armOk = redIds.length === 2;
  process.stdout.write(`\n──── 反证臂 onebyte：预期红 ["freshness:bytes","freshness:check-agrees"] / 实际红 ${JSON.stringify(redIds)} ────\n`);
  process.stdout.write(`  红：[freshness:bytes] 逐字节比 —— 第一处不同在第 ${firstDiff?.line} 行：盘上 ${JSON.stringify(firstDiff?.onDisk)} / 刚渲染 ${JSON.stringify(firstDiff?.fresh)}\n`);
  process.stdout.write(`  红：[freshness:check-agrees] 生成器自己的 --check —— exit=${checkRun.status}｜${(checkRun.stderr ?? '').trim().split(/\r?\n/)[0] ?? ''}\n`);
  process.stdout.write(armOk
    ? '✓ 反证臂 onebyte 红到位（手改一个字节 ⇒ 两条都红）—— 这是**期望**的结果，不是缺陷\n'
    : `✗ 反证臂 onebyte **没红到位**：实际红 ${JSON.stringify(redIds)} ⇒ 这道门是个假门\n`);
}
if (ARM === 'tornwrite') {
  // 装置已经把读数记完了；这一臂要证两件事：①装置**自证**切点确实落在中间；②判据确实红（读者读到了半份）。
  const marker = /\[tornwrite\] cut=(\d+) total=(\d+) gap=(\d+)ms/.exec(landing.writerStdout);
  const cut = marker ? Number(marker[1]) : null;
  const total = marker ? Number(marker[2]) : null;
  const cutInMiddle = cut !== null && cut > 0 && cut < total;
  const observedCut = cut !== null && [...landing.partials.values()].some((read) => read.length === cut);
  armOk = cutInMiddle && observedCut && !landingIntact;
  process.stdout.write(`\n──── 反证臂 tornwrite：装置自证 ＋ 判据必须红 ────\n`);
  process.stdout.write(`  装置自证（生成器副本自己打的）：cut=${cut} B / total=${total} B / gap=${marker?.[3]}ms ⇒ 切点落在中间：${cutInMiddle}\n`);
  process.stdout.write(`  读者读到的非完整读数：${[...landing.partials.entries()].map(([sha, read]) => `${sha}（${read.length} B，×${read.count}）`).join('、') || '(一条也没有)'}\n`);
  process.stdout.write(`  判据 landing:no-partial-read：期望**红** / 实际 ${landingIntact ? '绿' : '红'}｜读者读到了 cut 那一段（${cut} B）：${observedCut}\n`);
  process.stdout.write(armOk
    ? '✓ 反证臂 tornwrite 红到位（读者必读到半份）—— 这是**期望**的结果，不是缺陷\n'
    : '✗ 反证臂 tornwrite **没红到位** ⇒ 装置是假的（切点没落在中间 / 读者没读到那一段 / 判据没红）\n');
}
if (!ARM) {
  process.stdout.write(`\n──── test/gen-values-freshness.mjs：3 条断言 —— ${3 - failures} 绿 / ${failures} 红 ────\n`);
  if (failures > 0) process.stdout.write('（怎么修：跑一次 `npm run gen:designvalues`；不要手改 web/generated/design-values.css）\n');
}

for (const sandbox of sandboxes) await removeSandbox(sandbox, problems, 'gen-values-freshness sandbox');
for (const problem of problems) process.stdout.write(`cleanup problems (secondary): ${problem}\n`);
// 反证臂下："预期的那几条红了"才算过（所以进程出口是 0）；基线跑则"零红 + 沙箱干净"才算过。
process.exitCode = (ARM ? armOk === true : failures === 0) && problems.length === 0 ? 0 : 1;
