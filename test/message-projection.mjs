#!/usr/bin/env node
// message-projection.mjs —— 会话 entry → wire 投影的**逐字段形状门 + 诚实性门**。
//
// 为什么要有它：`docs/tui-parity.md` 里好几条「服务端投影」的缺口是**静默的** ——
// 不是画错，是**掉在地上**或**画出空壳**（M-39 bashExecution 空壳、M-33 branch_summary 掉地、
// M-25 工具 details 被丢掉）。这类 bug 不会让任何东西变红，所以必须有人**逐字段**断言。
//
// 判据（每项两条，缺一不可）：
//   · 形状断言：字段逐个断言（值来自 `test/messages-parity-fixture.mjs` 里**完全已知**的会话）；
//   · 诚实性断言：文件里**没有**的字段必须如实报 null（不许按 0/false/空串编），
//     而且**不许留空壳**（`text` 非空 —— 空壳正是 M-39 的形状）。
//
// 做法：复用 parity fixture（内容确定、固定 uuid/时间戳）+ 自起沙箱 → `GET /sessions/{id}/messages`
// → 对真实 HTTP 响应断言。黄金文件（`test/fixtures/messages-parity.golden.json`）另有一道
// 「内容口径不许变」的门（`test/messages-parity-fixture.mjs`）；本文件管的是「语义对不对」。
//
// 跑法：
//   npm run test:projection                # 全部项
//   node test/message-projection.mjs --item M-39
//   node test/message-projection.mjs --from PORT   # 不自己起沙箱，打已在跑的实例（只读）
//
// 铁律：只起**自己 spawn** 的 A、只按那个 pid 停；高位随机端口；**不碰真 profile**；**不 pkill**。
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { createMessagesParityFixture, parityImageBase64 } from './messages-parity-fixture.mjs';
import { hostStatus, poll, request, startSandboxBase } from './perf-verify-lib.mjs';

const ITEMS = ['M-39', 'M-33', 'M-25', 'M-31', 'M-34'];const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

function parseArgs(argv) {
  const options = { items: [...ITEMS], from: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => { index += 1; if (index >= argv.length) throw new Error(`${arg} requires a value`); return argv[index]; };
    if (arg === '--item') options.items = [next()];
    else if (arg === '--from') options.from = Number(next());
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

const byEntry = (payload, entryId) => payload.messages.find((message) => message.entryId === entryId) ?? null;

// ───────────────────────────── M-39：bashExecution 不许是空壳 ─────────────────────────────
// 形状来自 pi 的 `BashExecutionMessage`（`docs/session-format.md:125-134`）：
// command / output / exitCode / cancelled / truncated / fullOutputPath / excludeFromContext。
function checkBashExecution(payload) {
  const withFields = byEntry(payload, 'e0000001');
  const missingFields = byEntry(payload, 'e0000002');
  assert.ok(withFields, 'fixture 里的 bashExecution（e0000001）没出现在 messages 里');
  assert.ok(missingFields, 'fixture 里的 bashExecution（e0000002）没出现在 messages 里');

  // 形状断言：字段逐个。
  // 诚实性断言 ①（先断言这个）：text 非空 —— 这就是 M-39 的空壳判据。
  assert.notEqual(withFields.text, '', 'M-39：bashExecution 的 wire.text 不许是空串（那就是空壳消息）');
  assert.equal(withFields.kind, 'bashExecution', 'bashExecution 必须带一个明确的 kind，别让前端猜');
  assert.equal(withFields.role, 'bashExecution');
  assert.deepEqual(withFields.content, [], 'BashExecutionMessage 没有 content 字段 —— wire 如实报空数组，不许编');
  assert.deepEqual(withFields.bash, {
    command: 'git status --short',
    output: ' M server/base-logic.mjs',
    exitCode: 0,
    cancelled: false,
    truncated: false,
    fullOutputPath: null,
    excludeFromContext: null,
  });

  // 诚实性断言 ①：text 内容逐字来自真值。
  assert.equal(withFields.text, '$ git status --short\n M server/base-logic.mjs');

  // 诚实性断言 ②：文件里**没有** output/exitCode 的消息 —— 如实报 null，不按 0/false/空串编。
  assert.equal(missingFields.bash.output, null, 'output 在文件里缺省 ⇒ null（不是空串）');
  assert.equal(missingFields.bash.exitCode, null, 'exitCode 在文件里缺省 ⇒ null（不是 0）');
  assert.equal(missingFields.bash.cancelled, true);
  assert.equal(missingFields.bash.truncated, true);
  assert.equal(missingFields.bash.fullOutputPath, 'PARITY-FULL-OUTPUT.txt');
  assert.notEqual(missingFields.text, '', 'M-39：诚实性样例也不许是空壳');
  assert.ok(missingFields.text.includes('$ bash -c "yes | head -n 100000"'), 'text 必须带真命令行');
  assert.ok(missingFields.text.includes('(command cancelled)'), 'cancelled=true 必须在 text 里看得见');
  assert.ok(missingFields.text.includes('[Output truncated. Full output: PARITY-FULL-OUTPUT.txt]'), 'truncated 必须带 fullOutputPath');
  assert.ok(!missingFields.text.includes('(no output)'), 'output 缺省 ≠ 空输出：不许拿 pi 的 "(no output)" 冒名（那是 output === "" 的话术）');
  assert.ok(!missingFields.text.includes('Command exited with code'), 'exitCode 缺省 ⇒ 不许编一个退出码');

  // 全量诚实性：**任何** bashExecution 都不许是空壳（挡住「只修了 fixture 那两条」的假修）。
  const shells = payload.messages.filter((message) => message.role === 'bashExecution' && (message.text ?? '') === '');
  assert.deepEqual(shells, [], '还有 bashExecution 被投影成空壳');

  return {
    withFields: { kind: withFields.kind, bash: withFields.bash, text: withFields.text },
    missingFields: { kind: missingFields.kind, bash: missingFields.bash, text: missingFields.text },
    bashExecutionCount: payload.messages.filter((message) => message.role === 'bashExecution').length,
  };
}

// ───────────────────────────── M-33：branch_summary 不许整条掉地 ─────────────────────────────
// 形状来自 `BranchSummaryEntry`（`docs/session-format.md:250-262`）：fromId + summary（+ 可选 usage/details）。
function checkBranchSummary(payload) {
  assert.ok(Array.isArray(payload.branchSummaries), 'payload.branchSummaries 必须是数组 —— M-33 修前这一类 entry 整条掉在地上');
  const summaries = payload.branchSummaries;
  assert.equal(summaries.length, 2, 'fixture 里两条 branch_summary 都必须被投影出来');
  const withUsage = summaries.find((entry) => entry.entryId === 'f0000001');
  const withoutUsage = summaries.find((entry) => entry.entryId === 'f0000002');
  assert.ok(withUsage, 'branch_summary f0000001 没被投影');
  assert.ok(withoutUsage, 'branch_summary f0000002 没被投影');

  // 形状断言：字段逐个（与 compaction 块自洽：entryId/parentId/atIndex/timestamp/summary/note）。
  assert.deepEqual(
    { entryId: withUsage.entryId, parentId: withUsage.parentId, atIndex: withUsage.atIndex, timestamp: withUsage.timestamp, summary: withUsage.summary, fromId: withUsage.fromId, details: withUsage.details },
    { entryId: 'f0000001', parentId: 'd0000001', atIndex: 9, timestamp: '2026-09-01T00:00:14.000Z', summary: 'PARITY-BRANCH-SUMMARY-1', fromId: 'b0000002', details: { readFiles: ['a.ts'], modifiedFiles: ['b.ts'] } },
  );
  assert.equal(typeof withUsage.note, 'string');
  assert.ok(withUsage.note.includes('摘要'), 'note 要说明这块是什么（与 compaction 的 note 同一种作用）');
  assert.deepEqual(
    { parentId: withoutUsage.parentId, atIndex: withoutUsage.atIndex, timestamp: withoutUsage.timestamp, summary: withoutUsage.summary, fromId: withoutUsage.fromId, details: withoutUsage.details },
    { parentId: 'f0000001', atIndex: 9, timestamp: '2026-09-01T00:00:15.000Z', summary: 'PARITY-BRANCH-SUMMARY-2', fromId: 'b0000004', details: null },
  );

  // 诚实性断言：usage 在 entry 上**可选** —— 有就报真值，没有就如实报 unknown（不许按 0 计）。
  assert.equal(withUsage.usage.status, 'known');
  assert.deepEqual(
    { input: withUsage.usage.input, output: withUsage.usage.output, cacheRead: withUsage.usage.cacheRead, cacheWrite: withUsage.usage.cacheWrite },
    { input: 41, output: 42, cacheRead: 0, cacheWrite: 0 },
  );
  assert.equal(withoutUsage.usage.status, 'unknown');
  assert.deepEqual(
    { input: withoutUsage.usage.input, output: withoutUsage.usage.output },
    { input: null, output: null },
    'entry 上没有 usage ⇒ 如实报 null，不许按 0 计',
  );
  assert.equal(typeof withoutUsage.usage.note, 'string');
  assert.ok(withoutUsage.usage.note.length > 0, 'unknown 必须带说明');

  // branch_summary 是 entry，不是正文消息：不许混进 messages。
  assert.ok(
    payload.messages.every((message) => !String(message.text ?? '').includes('PARITY-BRANCH-SUMMARY')),
    'branch_summary 被混进了正文 messages',
  );
  assert.equal(
    payload.messages.filter((message) => message.role === 'branchSummary' || message.role === 'compactionSummary').length,
    0,
    'branch_summary 不该以 message 身份混进正文',
  );

  return { count: summaries.length, withUsage, withoutUsage };
}

// ───────────────────────────── M-25：工具 details 透传（有上限、超限诚实标注） ─────────────────────────────
// 数据形状：`ToolResultMessage.details`（`docs/session-format.md:98`）—— 工具特有元数据，edit/write 的 diff 在这里。
const BIG_DIFF = `PARITY-BIG-DIFF\n${'x'.repeat(70_000)}`;
function checkToolDetails(payload) {
  const toolParts = payload.messages
    .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
    .filter((part) => part.type === 'tool');
  const byId = new Map(toolParts.map((part) => [part.toolCallId, part]));
  const small = byId.get('call_parity_1');
  const none = byId.get('call_parity_2');
  const big = byId.get('call_parity_big');
  assert.ok(small, 'fixture 里 call_parity_1 没有被配对成 tool 卡');
  assert.ok(none, 'fixture 里 call_parity_2 没有被配对成 tool 卡');
  assert.ok(big, 'fixture 里 call_parity_big 没有被配对成 tool 卡');
  for (const [id, part] of [['call_parity_1', small], ['call_parity_2', none], ['call_parity_big', big]]) {
    assert.ok(part.details, `M-25：tool 卡 ${id} 上没有 details 字段 —— ToolResultMessage.details 被丢掉了`);
  }

  // 形状断言：小 details 原样——`status:'known'`，`value` 就是 entry 里那份对象（不重命名、不拍平）。
  assert.equal(small.details.status, 'known');
  assert.deepEqual(small.details.value, { ok: true });
  assert.equal(small.details.bytes, Buffer.byteLength(JSON.stringify({ ok: true }), 'utf8'));
  assert.equal(small.details.truncated, false);
  assert.equal(small.details.note, null);
  assert.equal(small.details.preview, null);

  // 诚实性断言 ①：entry 里**没有** details ⇒ `absent`（不是 `known` + 空对象，也不是 null 而不说）。
  assert.equal(none.details.status, 'absent');
  assert.deepEqual(
    { value: none.details.value, bytes: none.details.bytes, truncated: none.details.truncated, note: none.details.note, preview: none.details.preview },
    { value: null, bytes: null, truncated: false, note: null, preview: null },
  );

  // 诚实性断言 ②：超限 ⇒ 省略正文、报真实字节数、给一段原文预览，并且**说清楚**发生了什么。
  const expectedBytes = Buffer.byteLength(JSON.stringify({ diff: BIG_DIFF }), 'utf8');
  assert.equal(big.details.status, 'oversized');
  assert.equal(big.details.value, null, '超限时不许把半截 JSON 当 value 交出去');
  assert.equal(big.details.truncated, true);
  assert.equal(big.details.bytes, expectedBytes, '字节数必须是 entry 里那份 JSON 的真实长度');
  assert.ok(big.details.bytes > 64 * 1024, '这个样例本身必须真的超过上限，否则门什么都没验');
  assert.equal(big.details.preview.length, 2000);
  assert.ok(big.details.preview.startsWith('{"diff":"PARITY-BIG-DIFF'), '预览必须是原文的前缀（不是重新编的）');
  assert.ok(typeof big.details.note === 'string' && big.details.note.includes('上限'), '超限必须带一句人看得懂的说明');

  // 大小断言：超限的整段 diff **不许**进 payload（只许那 2000 字符预览）。
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes('x'.repeat(10_000)), 'M-25：超限的 details 整段塞进了 payload');

  return { small: small.details, absent: none.details, oversized: big.details, payloadBytes: Buffer.byteLength(serialized, 'utf8') };
}

// ───────────────── M-31（服务端那一半）：图片块不许被静默丢掉（空壳的另一种形状） ─────────────────
// 形状来自 `ImageContent`（`docs/session-format.md:57-61`）：`{ type:'image', data(base64), mimeType }`。
function checkImageBlocks(payload) {
  const onlyImage = byEntry(payload, 'b000000a');
  const textAndImage = byEntry(payload, 'b000000b');
  assert.ok(onlyImage, 'fixture 里的「只有图片」消息（b000000a）没出现在 messages 里');
  assert.ok(textAndImage, 'fixture 里的「文本+图片」消息（b000000b）没出现在 messages 里');
  const base64 = parityImageBase64();
  const expectedBytes = Buffer.byteLength(base64, 'base64');

  // 空壳判据：只有图片的消息 text 必须非空（修前 `contentText()` 只收 text 块 ⇒ 空串 ⇒ 空壳）。
  assert.notEqual(onlyImage.text, '', 'M-31：只有图片的消息被投影成空壳（text 是空串）');
  assert.equal(onlyImage.text, `[图片：image/png，${expectedBytes} 字节（网页暂不显示图片内容）]`);
  assert.deepEqual(onlyImage.images, [{ mimeType: 'image/png', bytes: expectedBytes }]);

  // 诚实性 ①：原图 base64 **仍原样在 wire.content 里**（没有被我们偷偷丢掉或改成占位）——
  // 那是前端将来 <img src="data:..."> 要用的原文；`images` 只是**派生的元数据**。
  assert.equal(onlyImage.content[0].data, base64);
  assert.equal(onlyImage.content[0].mimeType, 'image/png');

  // 文本与图片混排：文本在前、占位行在后；元数据只报图片那几块。
  assert.ok(textAndImage.text.startsWith('PARITY-TEXT-5'), '原有文本不许被占位行顶掉');
  assert.ok(textAndImage.text.includes(`[图片：image/jpeg，${expectedBytes} 字节（网页暂不显示图片内容）]`));
  assert.deepEqual(textAndImage.images, [{ mimeType: 'image/jpeg', bytes: expectedBytes }]);

  // 诚实性 ②：每条 message wire 都有 `images` 数组（没有图片就是空数组，不是 undefined）。
  const missing = payload.messages.filter((message) => !Array.isArray(message.images));
  assert.deepEqual(missing, [], '每条 message wire 都要带 images 数组（缺了前端就得猜）');

  return { onlyImage: { text: onlyImage.text, images: onlyImage.images }, textAndImage: { text: textAndImage.text, images: textAndImage.images }, imageBytes: expectedBytes };
}

// ───────────────── M-34（服务端那一半）：压缩块的 usage/details 与 branch_summary 自洽 ─────────────────
// 形状：`CompactionEntry` 上的可选 `usage`/`details`（`docs/session-format.md:245-248`）。
function checkCompactionUsage(payload) {
  const compaction = payload.compaction;
  assert.ok(compaction && compaction.entryId === 'd0000001', 'compaction 块不见了');
  assert.equal(compaction.tokensBefore, 1234, 'tokensBefore 不许因为新增字段而掉');
  assert.ok(compaction.usage, 'M-34：压缩块上没有 usage —— entry 上的 usage 被丢掉了');
  assert.ok('details' in compaction, 'M-34：压缩块上没有 details 字段');
  assert.equal(compaction.usage.status, 'known');
  assert.deepEqual(
    { input: compaction.usage.input, output: compaction.usage.output, cacheRead: compaction.usage.cacheRead, cacheWrite: compaction.usage.cacheWrite },
    { input: 71, output: 72, cacheRead: 0, cacheWrite: 0 },
  );
  assert.deepEqual(compaction.details, { readFiles: ['a.ts'], modifiedFiles: ['d.ts'] });
  assert.equal(typeof compaction.note, 'string');
  return { compaction };
}

const CHECKS = { 'M-39': checkBashExecution, 'M-33': checkBranchSummary, 'M-25': checkToolDetails, 'M-31': checkImageBlocks, 'M-34': checkCompactionUsage };

function usageText() {
  return `Usage: node test/message-projection.mjs [--item M-39] [--from PORT] [--keep]\n` +
    `  默认：造 parity fixture → 自起沙箱 → GET /messages → 逐项形状/诚实性断言\n` +
    `  --item ID     只跑某一项（${ITEMS.join(' / ')}）\n` +
    `  --from PORT   不自己起沙箱，打已经在跑的实例（只读请求）\n` +
    `  --keep        跑完保留 fixture home\n\n` +
    `只起自己的 A、只按它的 pid 停；高位随机端口；不碰真 profile；不 pkill。`;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${usageText()}\n`);
  process.exit(0);
}
for (const item of options.items) assert.ok(Object.hasOwn(CHECKS, item), `unknown item ${item}`);

const fixture = await createMessagesParityFixture({ keep: options.keep });
let sandbox = null;
let port = options.from;
try {
  if (port === null) {
    const logPath = path.join(fixture.home, 'projection-base.log');
    sandbox = await startSandboxBase({ home: fixture.home, sessionsRoot: fixture.sessionsRoot, workspace: fixture.workspace, logPath });
    await poll('projection sandbox ready', () => hostStatus(sandbox.port), (host) => host?.currentWorkerPid > 0, 60_000);
    port = sandbox.port;
    print('sandbox', { port, pid: sandbox.child.pid, fixtureHome: fixture.home, sessionId: fixture.sessionId });
  }
  const response = await request(port, `/sessions/${fixture.sessionId}/messages`, { timeoutMs: 120_000 });
  assert.equal(response.statusCode, 200, `GET /messages -> ${response.statusCode} ${response.raw?.slice(0, 500)}`);
  const payload = response.value;
  assert.ok(Array.isArray(payload.messages) && payload.messages.length > 0, 'GET /messages 没返回 messages');

  for (const item of options.items) {
    const evidence = CHECKS[item](payload);
    print(item, evidence);
  }
  print('RESULT', `message projection ${options.items.join('+')} PASS`);
} finally {
  await sandbox?.stop?.();
  if (!options.keep) await fixture.cleanup().catch(() => {});
}
