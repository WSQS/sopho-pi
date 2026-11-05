#!/usr/bin/env node
// messages-parity-fixture.mjs —— 「提速不许改内容口径」的**已知内容** fixture + 平价断言。
//
// 为什么要有它：v2.2 的整树读在真机规模上 >5 s（A-29 事故），提速那条 landing 会去改
// `server/base-logic.mjs` 里**读会话文件**的那条路。读得快没问题，但**读出来的东西不许变**：
// 正文的 parts 顺序（thinking → tool → text 就是到达顺序，不许按类型归并）、每个字段、
// tool 调用的配对与状态、extras、压缩边界 —— 都要逐字一样。
//
// 做法：**golden**。本文件造一条**内容完全已知且确定**的会话（固定 uuid / 固定时间戳 /
// 固定的 thinking+toolCall+text 混序 parts / toolResult 配对 / custom_message / compaction），
// 对着一个沙箱实例打一次 `GET /sessions/{id}/messages`，把归一化后的响应写成 golden。
// 提速前后跑同一条命令，diff 必须为空。
//
// 两种入口：
//   · 导出 `createMessagesParityFixture()` / `normalizeMessagesPayload()` / `diffMessagesParity()`
//     —— 别的门（或另一条 landing 的测试）直接 import 复用；
//   · CLI `node test/messages-parity-fixture.mjs`（自起沙箱 → 比 golden；`--update-golden` 重录）。
//
// 铁律：只起**自己 spawn** 的 A、只按那个 pid 停；高位随机端口；**不碰真 profile**；**不 pkill**。

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { hostStatus, poll, request, startSandboxBase, writeMinimalHome } from './perf-verify-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GOLDEN = path.join(here, 'fixtures', 'messages-parity.golden.json');

/** 固定的会话 uuid：fixture 的「已知内容」从这一条开始就是确定的。 */
export const PARITY_SESSION_ID = '11111111-1111-4111-8111-111111111111';

const T0 = '2026-09-01T00:00:00.000Z';

function iso(offsetSeconds) {
  return new Date(Date.parse(T0) + offsetSeconds * 1000).toISOString();
}

function usage(input, output) {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/**
 * 一条**内容已知**的会话。刻意塞进这些形状（它们最容易在「提速」时被改坏）：
 *   ① parts 顺序 thinking → tool → text（不许按类型归并）；
 *   ② toolCall 与 toolResult 的配对与 done-success / done-error 状态；
 *   ③ 一个 custom_message（走 `extras`，且**不许**混进 `messages`）；
 *   ④ 一条 compaction（`atIndex` 必须指向 messages 的下标）；
 *   ⑤ bashExecution（M-39）：**没有** `content` 字段的形状 + 缺 output/exitCode 的诚实性样例；
 *   ⑥ branch_summary（M-33）：一条 `usage` known、一条**没有** usage（诚实性）；
 *   ⑦ 工具 `details`（M-25）：小 details 原样、没有 details、**超限**（省略 + 字节数 + 预览）；
 *   ⑧ 图片块（M-31 服务端那一半）：只有图片的消息（修前被投影成空壳）+ 文本与图片混排。
 */
export function paritySessionEntries({ cwd }) {
  const entries = [];
  const push = (entry) => { entries.push(entry); return entry.id; };

  let parentId = null;
  parentId = push({ type: 'session', version: 3, id: PARITY_SESSION_ID, timestamp: iso(0), cwd });
  parentId = push({ type: 'model_change', id: 'a0000001', parentId, timestamp: iso(1), provider: 'parity', modelId: 'parity-model' });
  parentId = push({ type: 'thinking_level_change', id: 'a0000002', parentId, timestamp: iso(1), thinkingLevel: 'off' });
  parentId = push({ type: 'session_info', id: 'a0000003', parentId, timestamp: iso(2), name: 'messages parity fixture' });

  parentId = push({ type: 'message', id: 'b0000001', parentId, timestamp: iso(3), message: { role: 'user', content: [{ type: 'text', text: 'PARITY-USER-1' }], timestamp: Date.parse(iso(3)) } });

  // ① thinking → text → toolCall
  parentId = push({
    type: 'message', id: 'b0000002', parentId, timestamp: iso(4),
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'PARITY-THINKING-1' },
        { type: 'text', text: 'PARITY-TEXT-1' },
        { type: 'toolCall', id: 'call_parity_1', name: 'parity_tool', arguments: { a: 1, b: '二' } },
      ],
      api: 'parity-api', provider: 'parity', model: 'parity-model', usage: usage(11, 12), stopReason: 'toolUse', timestamp: Date.parse(iso(4)),
    },
  });
  parentId = push({
    type: 'message', id: 'b0000003', parentId, timestamp: iso(5),
    message: { role: 'toolResult', toolCallId: 'call_parity_1', toolName: 'parity_tool', content: [{ type: 'text', text: 'PARITY-RESULT-1' }], details: { ok: true }, isError: false, timestamp: Date.parse(iso(5)) },
  });

  // ② thinking → toolCall → text（顺序与前一条不同，专钉「不许归并」）
  parentId = push({
    type: 'message', id: 'b0000004', parentId, timestamp: iso(6),
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'PARITY-THINKING-2' },
        { type: 'toolCall', id: 'call_parity_2', name: 'parity_tool', arguments: { a: 2 } },
        { type: 'text', text: 'PARITY-TEXT-2' },
      ],
      api: 'parity-api', provider: 'parity', model: 'parity-model', usage: usage(21, 22), stopReason: 'toolUse', timestamp: Date.parse(iso(6)),
    },
  });
  parentId = push({
    type: 'message', id: 'b0000005', parentId, timestamp: iso(7),
    message: { role: 'toolResult', toolCallId: 'call_parity_2', toolName: 'parity_tool', content: [{ type: 'text', text: 'PARITY-RESULT-2' }], isError: true, timestamp: Date.parse(iso(7)) },
  });

  parentId = push({ type: 'message', id: 'b0000006', parentId, timestamp: iso(8), message: { role: 'user', content: [{ type: 'text', text: 'PARITY-USER-2' }], timestamp: Date.parse(iso(8)) } });
  parentId = push({
    type: 'message', id: 'b0000007', parentId, timestamp: iso(9),
    message: { role: 'assistant', content: [{ type: 'text', text: 'PARITY-TEXT-3' }], api: 'parity-api', provider: 'parity', model: 'parity-model', usage: usage(31, 32), stopReason: 'stop', timestamp: Date.parse(iso(9)) },
  });

  // ③ extras：`custom_message` 走独立字段，绝不进 `messages`
  parentId = push({ type: 'custom_message', id: 'c0000001', parentId, timestamp: iso(10), customType: 'parity.note', content: [{ type: 'text', text: 'PARITY-EXTRA-1' }], display: true, details: { tag: 'parity' } });

  // ⑤ bashExecution（M-39）：**没有** `content` 字段的形状（`docs/session-format.md:125-134`）。
  //    修前会被投影成空壳（`text === ''`），所以这里的 `text` 必须非空且来自下面的真值。
  parentId = push({
    type: 'message', id: 'e0000001', parentId, timestamp: iso(12),
    message: {
      role: 'bashExecution', command: 'git status --short', output: ' M server/base-logic.mjs',
      exitCode: 0, cancelled: false, truncated: false, timestamp: Date.parse(iso(12)),
    },
  });
  // ⑤b 诚实性：output/exitCode **在文件里就是没有**（pi 的类型是 `number | undefined`）——
  //     投影必须如实报 null，不许按 0/false/空串编一个；同时 text 仍要非空。
  parentId = push({
    type: 'message', id: 'e0000002', parentId, timestamp: iso(13),
    message: {
      role: 'bashExecution', command: 'bash -c "yes | head -n 100000"',
      cancelled: true, truncated: true, fullOutputPath: 'PARITY-FULL-OUTPUT.txt', timestamp: Date.parse(iso(13)),
    },
  });

  // ④ compaction：只追加，atIndex 指向 messages 的下标（= 9：7 条正文 + 2 条 bashExecution）
  parentId = push({ type: 'compaction', id: 'd0000001', parentId, timestamp: iso(11), summary: 'PARITY-COMPACTION-SUMMARY', firstKeptEntryId: 'b0000003', tokensBefore: 1234, usage: usage(71, 72), details: { readFiles: ['a.ts'], modifiedFiles: ['d.ts'] } });

  // ⑥ branch_summary（M-33）：切分支时给**被抛下的那条路**生成的摘要。修前这一类 entry 整条掉地。
  //    `usage` 是**可选**字段（`docs/session-format.md:250-262`）：一条有、一条没有 ——
  //    没有的那条必须如实报 unknown（不许按 0 计）。
  parentId = push({
    type: 'branch_summary', id: 'f0000001', parentId, timestamp: iso(14), fromId: 'b0000002',
    summary: 'PARITY-BRANCH-SUMMARY-1', usage: usage(41, 42), details: { readFiles: ['a.ts'], modifiedFiles: ['b.ts'] },
  });
  parentId = push({
    type: 'branch_summary', id: 'f0000002', parentId, timestamp: iso(15), fromId: 'b0000004',
    summary: 'PARITY-BRANCH-SUMMARY-2',
  });

  // ⑦ 工具 `details` 透传（M-25）：`ToolResultMessage.details` 是工具特有元数据（edit/write 的 diff）。
  //    小 details 原样给；**超限**的不许截成半截 JSON，改成「省略 + 字节数 + 预览」。
  parentId = push({
    type: 'message', id: 'b0000008', parentId, timestamp: iso(16),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'PARITY-TEXT-4' }, { type: 'toolCall', id: 'call_parity_big', name: 'edit', arguments: { path: 'b.ts' } }],
      api: 'parity-api', provider: 'parity', model: 'parity-model', usage: usage(51, 52), stopReason: 'toolUse', timestamp: Date.parse(iso(16)),
    },
  });
  parentId = push({
    type: 'message', id: 'b0000009', parentId, timestamp: iso(17),
    message: {
      role: 'toolResult', toolCallId: 'call_parity_big', toolName: 'edit',
      content: [{ type: 'text', text: 'PARITY-BIG-RESULT' }],
      details: { diff: `PARITY-BIG-DIFF\n${'x'.repeat(70_000)}` },
      isError: false, timestamp: Date.parse(iso(17)),
    },
  });

  // ⑧ 图片块（M-31 服务端那一半）：修前 `contentText` 只收 text 块 ⇒ 一条**只有图片**的消息
  //    （截图粘进会话就是这个形状）被投影成 `text === ''` —— 又一种空壳。
  //    ⚠️ 原图 base64 仍按既有语义原样留在 `wire.content` 里（前端将来渲染用），本次不动。
  const imageData = Buffer.from('PARITY-IMAGE-BYTES-'.repeat(64)).toString('base64');
  parentId = push({
    type: 'message', id: 'b000000a', parentId, timestamp: iso(18),
    message: { role: 'user', content: [{ type: 'image', data: imageData, mimeType: 'image/png' }], timestamp: Date.parse(iso(18)) },
  });
  parentId = push({
    type: 'message', id: 'b000000b', parentId, timestamp: iso(19),
    message: { role: 'user', content: [{ type: 'text', text: 'PARITY-TEXT-5' }, { type: 'image', data: imageData, mimeType: 'image/jpeg' }], timestamp: Date.parse(iso(19)) },
  });

  return entries;
}

/** vendor 给 fixture 用的那张图的 base64（测试与断言共用同一份真值）。 */
export function parityImageBase64() {
  return Buffer.from('PARITY-IMAGE-BYTES-'.repeat(64)).toString('base64');
}

/**
 * 造 fixture home（只写临时目录）——**只读**真 profile 无关，这里根本不碰它。
 * 返回 handle：`{ home, sessionsRoot, workspace, sessionId, file, entries, cleanup() }`。
 */
export async function createMessagesParityFixture({ out = null, keep = true } = {}) {
  const home = path.resolve(out ?? await mkdtemp(path.join(os.tmpdir(), 'sopho-msg-parity-')));
  const sessionsRoot = path.join(home, 'sessions');
  const workspace = path.join(home, 'workspace');
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeMinimalHome(home, workspace);

  const entries = paritySessionEntries({ cwd: workspace });
  const file = path.join(sessionsRoot, `parity_${PARITY_SESSION_ID}.jsonl`);
  const stream = createWriteStream(file, { encoding: 'utf8' });
  let streamError = null;
  stream.once('error', (error) => { streamError = error; });
  for (const entry of entries) {
    if (!stream.write(`${JSON.stringify(entry)}\n`)) await new Promise((resolve) => stream.once('drain', resolve));
    if (streamError) throw streamError;
  }
  await new Promise((resolve, reject) => stream.end(resolve).once('error', reject));

  return {
    home,
    sessionsRoot,
    workspace,
    sessionId: PARITY_SESSION_ID,
    file,
    entries,
    keep,
    cleanup: async () => { await rm(home, { recursive: true, force: true }); },
  };
}

/** 把机器相关的东西归一化掉（fixture home 路径），其余一律**不动**。 */
export function normalizeMessagesPayload(value, { home = null } = {}) {
  const walk = (node) => {
    if (typeof node === 'string') {
      let out = node;
      if (home) out = out.split(path.resolve(home)).join('<HOME>').split(path.resolve(home).split(path.sep).join('/')).join('<HOME>');
      return out;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const key of Object.keys(node).sort()) out[key] = walk(node[key]);
      return out;
    }
    return node;
  };
  return walk(value);
}

/** 逐路径 diff；只报**真差异**，且把 parts 的顺序差异单独指出来（那才是最要命的）。 */
export function diffMessagesParity(expected, actual, at = '$', out = []) {
  if (out.length > 40) return out;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) { out.push({ path: at, reason: 'array/not-array', expected, actual }); return out; }
    if (expected.length !== actual.length) out.push({ path: `${at}.length`, reason: 'length', expected: expected.length, actual: actual.length });
    for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
      if (index >= expected.length || index >= actual.length) { out.push({ path: `${at}[${index}]`, reason: 'missing', expected: expected[index] ?? null, actual: actual[index] ?? null }); continue; }
      diffMessagesParity(expected[index], actual[index], `${at}[${index}]`, out);
    }
    return out;
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (!(key in expected)) { out.push({ path: `${at}.${key}`, reason: 'unexpected', actual: actual[key] }); continue; }
      if (!(key in actual)) { out.push({ path: `${at}.${key}`, reason: 'missing', expected: expected[key] }); continue; }
      diffMessagesParity(expected[key], actual[key], `${at}.${key}`, out);
    }
    return out;
  }
  if (expected !== actual) out.push({ path: at, reason: 'value', expected, actual });
  return out;
}

/**
 * 断言口径：`messages` 与 `extras` 与 `compaction` **逐 part / 逐字段**不许变。
 * `observability` 里那些由运行环境（模型清单）决定、与读文件无关的部分不在本门的判据里 ——
 * 但 fixture 用的是空 providers，所以它其实也是确定的：golden 里一并记下，diff 一起报。
 */
export function assertMessagesParity(golden, actual) {
  const expected = normalizeMessagesPayload(golden);
  const observed = normalizeMessagesPayload(actual);
  const differences = diffMessagesParity(expected, observed);
  return { ok: differences.length === 0, differences };
}

// ───────────────────────────── CLI ─────────────────────────────
function parseArgs(argv) {
  const options = { out: null, keep: false, golden: DEFAULT_GOLDEN, updateGolden: false, from: null, fixtureOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => { index += 1; if (index >= argv.length) throw new Error(`${arg} requires a value`); return argv[index]; };
    if (arg === '--out') options.out = next();
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--golden') options.golden = path.resolve(next());
    else if (arg === '--update-golden') options.updateGolden = true;
    else if (arg === '--from') options.from = Number(next());
    else if (arg === '--fixture-only') options.fixtureOnly = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function usageText() {
  return `Usage: node test/messages-parity-fixture.mjs [options]\n\n` +
    `  默认：造 fixture → 自起沙箱 → GET /messages → 与 golden 比（有差异就非零退出）\n` +
    `  --update-golden      把这次的响应重录成 golden（**提速前**录，提速后只比不改）\n` +
    `  --golden PATH        golden 路径（默认 test/fixtures/messages-parity.golden.json）\n` +
    `  --from PORT          不自己起沙箱，打已经在跑的实例（只读请求）\n` +
    `  --fixture-only       只造 fixture 并打印它的 home，不起任何进程\n` +
    `  --out DIR            自定 fixture home\n` +
    `  --keep               跑完保留 fixture home\n\n` +
    `只起自己的 A、只按它的 pid 停；高位随机端口；不碰真 profile；不 pkill。`;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usageText()}\n`);
    process.exit(0);
  }
  const fixture = await createMessagesParityFixture({ out: options.out, keep: options.keep });
  process.stdout.write(`${JSON.stringify({ event: 'fixture', home: fixture.home, sessionId: fixture.sessionId, file: fixture.file })}\n`);
  if (options.fixtureOnly) process.exit(0);

  let sandbox = null;
  let port = options.from;
  try {
    if (port === null) {
      await mkdir(path.join(fixture.home, '..'), { recursive: true });
      const logPath = path.join(fixture.home, 'parity-base.log');
      sandbox = await startSandboxBase({ home: fixture.home, sessionsRoot: fixture.sessionsRoot, workspace: fixture.workspace, logPath });
      await poll('parity sandbox ready', () => hostStatus(sandbox.port), (host) => host?.currentWorkerPid > 0, 60_000);
      port = sandbox.port;
      process.stdout.write(`${JSON.stringify({ event: 'sandbox_ready', port, pid: sandbox.child.pid })}\n`);
    }
    const response = await request(port, `/sessions/${fixture.sessionId}/messages`, { timeoutMs: 120_000 });
    if (response.statusCode !== 200) {
      process.stderr.write(`GET /messages -> ${response.statusCode} ${response.raw?.slice(0, 500)}\n`);
      process.exitCode = 2;
    } else {
      const captured = normalizeMessagesPayload(response.value, { home: fixture.home });
      if (options.updateGolden || !(await readFile(options.golden, 'utf8').then(() => true, () => false))) {
        await mkdir(path.dirname(options.golden), { recursive: true });
        await writeFile(options.golden, `${JSON.stringify(captured, null, 2)}\n`);
        process.stdout.write(`${JSON.stringify({ event: 'golden_written', golden: options.golden, messages: captured.messages?.length ?? null, extras: captured.extras?.length ?? null })}\n`);
      } else {
        const golden = JSON.parse(await readFile(options.golden, 'utf8'));
        const result = assertMessagesParity(golden, captured);
        process.stdout.write(`${JSON.stringify({ event: 'parity', ok: result.ok, differences: result.differences.slice(0, 40) })}\n`);
        if (!result.ok) {
          process.stderr.write(`MESSAGES PARITY FAILED (${result.differences.length} differences)\n`);
          process.exitCode = 1;
        } else {
          process.stderr.write(`messages parity OK against ${options.golden}\n`);
        }
      }
    }
  } finally {
    await sandbox?.stop?.();
    if (!options.keep) await fixture.cleanup().catch(() => {});
  }
}
