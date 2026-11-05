#!/usr/bin/env node
// tree-scale-fixture.mjs —— 造「真机规模」的会话树候选集合，给规模 / 泄漏 / 提速几道门共用。
//
// 为什么要有它（原始证据，2026-09-18 晚）：
//   v2.2 的整树读在真机数据（302 会话 / 388 MB，含 10 MB 与 60 MB 级文件）上 >5 s
//   ⇒ 被宿主 `workerJson` 的 5 秒硬超时掐掉（server/base.mjs:1060）⇒ GET /tree 500，
//      而 worker 那边【继续算】—— 打两次 /tree 实测 6 秒墙钟烧 22 s CPU、RSS 3718 MiB。
//   要复现这个规模，就得有**真机形状**的候选集合。本文件只负责造它，不做断言。
//
// 铁律（写在代码里，防后来人改坏）：
//   · **绝不改真 profile** —— 只用 fs 读 + `copyFile` 复制出去；真 home 全程只读。
//   · fixture 落在 `os.tmpdir()` 下的临时目录（或显式 `--out`），**绝不在真 home 里面**。
//   · 不碰任何端口（本文件不起进程）；不 pkill；不打日志到 /tmp/sopho-*.log。
//
// 两种入口：
//   · 导出 `createTreeScaleFixture(options)` —— 别的门直接 import 复用（返回 handle + cleanup）。
//   · CLI `node test/tree-scale-fixture.mjs --out <dir> [--sessions 320] [--big-mib 10]` —— 打印 JSON。

import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MIB = 1024 * 1024;

/** 真 profile 的默认位置（只读来源）。可用 SOPHO_REAL_HOME 覆盖。 */
export const DEFAULT_REAL_HOME = process.env.SOPHO_REAL_HOME
  || path.join(os.homedir(), '.pi', 'profiles', 'assistant');

/** 真机上「大文件」那一档的量级（10 MB 级）。 */
export const DEFAULT_BIG_MIB = 10;
/** 真 profile 的规模（原始证据：302 会话 / 388 MB；本机副本实测 180 会话 / 384 MB）。 */
export const DEFAULT_SESSIONS = 320;

/** 这些 sidecar 会改变 `/tree` 的形状（归档 / 标题 / 未读），存在就一并只读复制。 */
const SIDECARS = ['archive.json', 'titles.json', 'seen.json', 'settled.json', 'paths.json'];

function log2() {}

function parseArgs(argv) {
  const options = {
    out: null,
    realHome: DEFAULT_REAL_HOME,
    copyReal: true,
    sessions: DEFAULT_SESSIONS,
    bigMib: DEFAULT_BIG_MIB,
    bigCount: 3,
    seed: 1,
    rm: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--out') options.out = next();
    else if (arg === '--real-home') options.realHome = next();
    else if (arg === '--no-real') options.copyReal = false;
    else if (arg === '--sessions') options.sessions = Number(next());
    else if (arg === '--big-mib') options.bigMib = Number(next());
    else if (arg === '--big-count') options.bigCount = Number(next());
    else if (arg === '--seed') options.seed = Number(next());
    else if (arg === '--rm') options.rm = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return `Usage: node test/tree-scale-fixture.mjs [options]\n\n` +
    `  --out DIR            fixture home（默认 os.tmpdir() 下 mkdtemp）\n` +
    `  --real-home DIR      只读复制的来源（默认 ${DEFAULT_REAL_HOME}）\n` +
    `  --no-real            不复制真会话，只用合成会话补齐\n` +
    `  --sessions N         目标会话总数（默认 ${DEFAULT_SESSIONS}；真副本 + 合成补足）\n` +
    `  --big-mib M          「10 MB 级」大文件的字节数，单位 MiB（默认 ${DEFAULT_BIG_MIB}）\n` +
    `  --big-count K        造几个大文件（默认 3）\n` +
    `  --seed N             合成会话的确定性种子（默认 1）\n` +
    `  --rm                 造完立刻删掉（只做自检时用）\n\n` +
    `绝不写真 profile；fixture 只落在 --out / 临时目录里。`;
}

// ── 确定性伪随机（同一个 seed 造出同一份 fixture，便于对照数字） ──
function makeRandom(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function guardOut(out, realHome) {
  const resolvedOut = path.resolve(out);
  const resolvedReal = path.resolve(realHome);
  if (resolvedOut === resolvedReal) throw new Error(`refusing to use the real profile as a fixture home: ${resolvedOut}`);
  if (resolvedOut.startsWith(resolvedReal + path.sep)) throw new Error(`refusing to write a fixture inside the real profile: ${resolvedOut}`);
  return resolvedOut;
}

function assistantMessage(text, timestamp) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fixture',
    model: 'tree-scale-fixture',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp,
  };
}

/**
 * 造一条**同形**的合成会话：真 pi 文件的结构（header → 若干 type 条目 → message 链），
 * 也就是 `/tree` 真正会读到的那几个字段（session_info 的名字 / 最后一条 user|assistant /
 * `sopho.archive` 自定义条目 / parentSession 指向）。
 */
async function writeSyntheticSession({ sessionsRoot, cwd, index, id, parentFile, targetBytes, messageCount, named, archived, rand }) {
  const file = path.join(sessionsRoot, `fixture-${String(index + 1).padStart(4, '0')}_${id}.jsonl`);
  const header = { type: 'session', version: 3, id, timestamp: new Date(Date.UTC(2026, 8, 1) + index * 1000).toISOString(), cwd };
  if (parentFile) header.parentSession = parentFile;

  const headerLine = `${JSON.stringify(header)}\n`;
  const fixedEntryBytes = 260; // model_change / thinking_level_change / session_info / custom 的近似开销
  const textBytes = Math.max(64, Math.floor((Math.max(targetBytes, 4096) - Buffer.byteLength(headerLine) - messageCount * fixedEntryBytes) / messageCount));

  const stream = createWriteStream(file, { encoding: 'utf8' });
  let streamError = null;
  stream.once('error', (error) => { streamError = error; });
  const write = async (line) => {
    if (!stream.write(`${JSON.stringify(line)}\n`)) await new Promise((resolve) => stream.once('drain', resolve));
    if (streamError) throw streamError;
  };

  await write(header);
  await write({ type: 'model_change', id: '00000000', parentId: null, timestamp: header.timestamp, provider: 'fixture', modelId: 'tree-scale-fixture' });
  await write({ type: 'thinking_level_change', id: '00000001', parentId: '00000000', timestamp: header.timestamp, thinkingLevel: 'off' });
  let parentId = '00000001';
  if (named) {
    const infoId = '00000002';
    await write({ type: 'session_info', id: infoId, parentId, timestamp: header.timestamp, name: `fixture session ${index + 1}` });
    parentId = infoId;
  }
  if (archived) {
    const archiveId = '00000003';
    await write({ type: 'custom', id: archiveId, parentId, timestamp: header.timestamp, customType: 'sopho.archive', data: { archived: true, at: header.timestamp } });
    parentId = archiveId;
  }

  for (let messageIndex = 0; messageIndex < messageCount; messageIndex += 1) {
    const entryId = `${index.toString(16).padStart(4, '0')}${messageIndex.toString(16).padStart(8, '0')}`;
    const marker = ` fixture=${index + 1} message=${messageIndex + 1} `;
    const text = marker + 'x'.repeat(Math.max(1, textBytes - Buffer.byteLength(marker)));
    const timestamp = new Date(Date.UTC(2026, 8, 1) + index * 1000 + messageIndex).toISOString();
    const user = messageIndex % 2 === 0;
    const message = user
      ? { role: 'user', content: [{ type: 'text', text }], timestamp }
      : assistantMessage(text, timestamp);
    await write({ type: 'message', id: entryId, parentId, timestamp, message });
    parentId = entryId;
  }

  await new Promise((resolve, reject) => stream.end(resolve).once('error', reject));
  const info = await stat(file);
  return { id, file, bytes: info.size };
}

/**
 * 造一份「真机规模」的 fixture home。
 *
 * @returns {Promise<{home, sessionsRoot, sessions, copiedReal, synthetic, bigFiles, corpusBytes, realHome, copiedSidecars, cleanup, keep}>}
 */
export async function createTreeScaleFixture(options = {}) {
  const {
    out = null,
    realHome = DEFAULT_REAL_HOME,
    copyReal = true,
    sessions = DEFAULT_SESSIONS,
    bigMib = DEFAULT_BIG_MIB,
    bigCount = 3,
    seed = 1,
    keep = true,
    log = log2,
  } = options;

  const fixtureHome = guardOut(out ?? await mkdtemp(path.join(os.tmpdir(), 'sopho-tree-scale-')), realHome);
  const sessionsRoot = path.join(fixtureHome, 'sessions');
  const cwd = path.join(fixtureHome, 'workspace');
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(cwd, { recursive: true });

  // 最小可用配置：不起真模型（tree 读不需要），只要 base 能起来。
  await writeFile(path.join(fixtureHome, 'models.json'), `${JSON.stringify({ providers: {} }, null, 2)}\n`);
  await writeFile(path.join(fixtureHome, 'settings.json'), `${JSON.stringify({ defaultThinkingLevel: 'off', compaction: { enabled: false } }, null, 2)}\n`);

  const rand = makeRandom(seed);
  const copiedReal = [];
  const copiedSidecars = [];
  const realSessionsRoot = path.join(realHome, 'sessions');

  if (copyReal) {
    let realFiles = [];
    try {
      const { readdir } = await import('node:fs/promises');
      realFiles = (await readdir(realSessionsRoot)).filter((name) => name.endsWith('.jsonl'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      log(`real sessions dir not found, continuing with synthetic only: ${realSessionsRoot}`);
    }
    for (const name of realFiles) {
      const source = path.join(realSessionsRoot, name);
      const target = path.join(sessionsRoot, name);
      await copyFile(source, target); // 只读来源 → 副本；真 profile 一个字节不改
      const info = await stat(target);
      copiedReal.push({ file: target, bytes: info.size, source });
    }
    log(`copied ${copiedReal.length} real sessions (${(copiedReal.reduce((sum, item) => sum + item.bytes, 0) / MIB).toFixed(1)} MiB)`);
    for (const name of SIDECARS) {
      const source = path.join(realHome, name);
      const target = path.join(fixtureHome, name);
      try {
        await copyFile(source, target);
        copiedSidecars.push(name);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }

  const synthetic = [];
  const need = Math.max(0, sessions - copiedReal.length);
  const bigTargetBytes = Math.floor(bigMib * MIB);
  const bigIndexes = new Set(Array.from({ length: Math.min(bigCount, need) }, (_, index) => Math.floor((index * need) / Math.max(1, Math.min(bigCount, need)))));

  // 先造一条「父」合成会话，再让后面的合成会话挂到它下面 —— 逼 `/tree` 真去解 parentSessionPath。
  let parentFile = null;
  for (let index = 0; index < need; index += 1) {
    const id = randomUUID();
    const isBig = bigIndexes.has(index);
    // 大文件要「大」得像个真会话：每条消息都是实打实的 JSON，json.parse 逐条跑。
    const messageCount = isBig ? 400 : 12;
    const targetBytes = isBig ? bigTargetBytes : Math.floor(16 * 1024 + rand() * 64 * 1024);
    const record = await writeSyntheticSession({
      sessionsRoot,
      cwd,
      index,
      id,
      parentFile: index > 0 && index % 3 === 0 ? parentFile : null,
      targetBytes,
      messageCount,
      named: index % 5 !== 0,
      archived: index % 17 === 0,
      rand,
    });
    if (index === 0) parentFile = record.file;
    synthetic.push({ ...record, kind: isBig ? 'big' : 'small' });
    if ((index + 1) % 25 === 0 || index + 1 === need) log(`synthetic ${index + 1}/${need}`);
  }

  const all = [
    ...copiedReal.map((item) => ({ ...item, kind: 'real' })),
    ...synthetic,
  ];
  const corpusBytes = all.reduce((sum, item) => sum + item.bytes, 0);
  const bigFiles = synthetic.filter((item) => item.kind === 'big');

  const cleanup = async () => { await rm(fixtureHome, { recursive: true, force: true }); };

  await writeFile(path.join(fixtureHome, 'fixture-manifest.json'), `${JSON.stringify({
    createdAt: new Date().toISOString(),
    realHome,
    copiedReal: copiedReal.length,
    copiedSidecars,
    synthetic: synthetic.length,
    bigFiles: bigFiles.map((item) => ({ id: item.id, file: item.file, bytes: item.bytes })),
    corpusBytes,
    seed,
    bigMib,
    bigCount,
    sessions,
  }, null, 2)}\n`);

  return {
    home: fixtureHome,
    sessionsRoot,
    cwd,
    sessions: all,
    copiedReal,
    synthetic,
    bigFiles,
    copiedSidecars,
    corpusBytes,
    realHome,
    keep,
    cleanup,
  };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const fixture = await createTreeScaleFixture({ ...options, log: (line) => process.stderr.write(`${line}\n`) });
  process.stdout.write(`${JSON.stringify({
    home: fixture.home,
    sessionsRoot: fixture.sessionsRoot,
    cwd: fixture.cwd,
    copiedReal: fixture.copiedReal.length,
    copiedSidecars: fixture.copiedSidecars,
    synthetic: fixture.synthetic.length,
    sessions: fixture.sessions.length,
    bigFiles: fixture.bigFiles.map((item) => ({ id: item.id, bytes: item.bytes })),
    corpusBytes: fixture.corpusBytes,
    corpusMiB: Number((fixture.corpusBytes / MIB).toFixed(2)),
    realHome: fixture.realHome,
  }, null, 2)}\n`);
  if (options.rm) {
    await fixture.cleanup();
    process.stderr.write(`removed ${fixture.home}\n`);
  } else {
    process.stderr.write(`fixture kept at ${fixture.home} (rm -rf 需自己按具体路径做)\n`);
  }
}
