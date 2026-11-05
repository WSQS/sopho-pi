#!/usr/bin/env node
// 一次性迁移：把 v2.1 的「归档旧账」搬进 v2.2 的「归档新账」。
//
// 为什么需要这个工具：
//   · v2.1 的归档态**不在会话文件里**，而在 sidecar `$AGENT_DIR/archive.json`
//     （形状 `{ "<完整 uuid>": <毫秒时间戳> }`，**键存在 = 已归档**；`setArchived(id,false)` 是 delete）。
//   · v2.2 换成「归档态写在会话文件自己的 custom entry `sopho.archive` 上」。
//   · v2.2 的兼容层会只读回落 archive.json，先保证旧归档不泄漏回主树；迁移仍要把义务
//     写进会话自己的新账，才能最终脱离 sidecar，并让显式 `{archived:false}` 覆盖旧键。
//
// 这个工具刻意**不直接改会话文件**：格式写错（少一行字段、JSON 拼错）会让会话读不出来。
// 它只发 HTTP，让 pi 自己的写入路径（`POST /sessions/{id}/archive` → `manager.appendCustomEntry`）
// 落笔 —— 与用户在 UI 上点「存档」走的是同一条路。
//
// 用法：
//   node bin/migrate-legacy-archive.mjs --home ~/.pi/profiles/assistant --api http://127.0.0.1:7331 --dry-run
//   node bin/migrate-legacy-archive.mjs --home ~/.pi/profiles/assistant --api http://127.0.0.1:7331 --rotate-every 5
//   node bin/migrate-legacy-archive.mjs --home ~/.pi/profiles/assistant --api http://127.0.0.1:7331 --undo --rotate-every 5
//
// 只读旧账（绝不删改 archive.json），可重复跑（幂等：新账已写到目标态的直接跳过）。

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const HELP = `把 v2.1 的归档旧账（archive.json）迁移进 v2.2 的会话内归档账（sopho.archive）

选项：
  --home <dir>         agent home（含 archive.json）。默认取 PI_CODING_AGENT_DIR/ASSIST_HOME/SOPHO_AGENT_DIR
  --api <url>          v2.2 实例地址（打 A：base）。默认 http://127.0.0.1:7331
  --dry-run            只报会改哪些，不发写入请求
  --undo               反向迁移：把这些会话写回「未归档」（sopho.archive {archived:false}）
  --limit <n>          只处理前 n 个（演练用）
  --concurrency <n>    并发（默认 1：一个一个来，避免 pool 里同时挂一堆会话）
  --retries <n>        每个会话遇到 409（忙碌）时的重试次数（默认 3）
  --rotate-every <n>   每成功写 n 条就 POST <api>/reload-code（无 body），默认 5；0=关闭
                       每次轮换后等待 /host.currentGenerationId 翻代、currentWorkerPid 改变且 workerCount=1
                       正式 profile 的完整 runtime 很重；关闭轮换可能撞 V8 约 4 GiB heap 并打掉 worker
  --report <file>      额外把 JSON 汇总写到文件（含轮换 URL/body、等待判据与每次 generation）
  --help               这段文字
`;

function parseArgs(argv) {
  const options = { dryRun: false, undo: false, concurrency: 1, retries: 3, rotateEvery: 5, limit: null, report: null, home: null, api: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--undo') options.undo = true;
    else if (arg === '--home') options.home = next();
    else if (arg === '--api') options.api = next();
    else if (arg === '--limit') options.limit = Number(next());
    else if (arg === '--concurrency') options.concurrency = Number(next());
    else if (arg === '--retries') options.retries = Number(next());
    else if (arg === '--rotate-every') options.rotateEvery = Number(next());
    else if (arg === '--report') options.report = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function defaultHome() {
  const explicit = process.env.PI_CODING_AGENT_DIR || process.env.ASSIST_HOME || process.env.SOPHO_AGENT_DIR;
  if (explicit) return path.resolve(explicit);
  return path.join(process.env.HOME || process.cwd(), '.pi', 'agent');
}

async function readNewArchiveStates(home, targetIds) {
  const states = new Map();
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  }
  await walk(path.join(home, 'sessions'));
  for (const file of files) {
    let id = null;
    let latest;
    try {
      for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry?.type === 'session' && typeof entry.id === 'string') id = entry.id.toLowerCase();
        if (entry?.type === 'custom' && entry.customType === 'sopho.archive' && typeof entry.data?.archived === 'boolean') {
          latest = entry.data.archived;
        }
      }
    } catch {
      continue;
    }
    if (id && targetIds.has(id) && latest !== undefined) states.set(id, latest);
  }
  return states;
}

async function readLegacyLedger(home) {
  const file = path.join(home, 'archive.json');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, exists: false, archived: [], malformed: false };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { file, exists: true, archived: [], malformed: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { file, exists: true, archived: [], malformed: true };
  }
  // v2.1 的语义是「键存在 = 已归档」；值只是归档那一刻的毫秒时间戳，不参与判定。
  const archived = Object.keys(parsed);
  return { file, exists: true, archived, malformed: false };
}

async function request(api, pathname, { method = 'GET', body, timeoutMs = 30_000 } = {}) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: body === undefined
      ? { accept: 'application/json' }
      : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { status: response.status, value, text };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function assertTargetIsV22(api) {
  const host = await request(api, '/host').catch((error) => ({ status: 0, error }));
  if (host.status !== 200 || typeof host.value?.logicVersion !== 'string') {
    throw new Error(`不是活的 v2.2 实例（GET /host 返回 ${host.status}）：${api}`);
  }
  const tree = await request(api, '/tree');
  if (tree.status !== 200 || !Array.isArray(tree.value?.sessions)) {
    // v2.1 的 /tree 返回 `.nodes`，v2.2 返回 `.sessions` —— 拿错实例就会在这里停住，
    // 免得把 v2.2 的迁移请求打到 v2.1 上（那边 POST /archive 写的是旧账本）。
    throw new Error(`GET /tree 不像 v2.2（缺少 .sessions）：${api} ${JSON.stringify(tree.value).slice(0, 200)}`);
  }
  return { logicVersion: host.value.logicVersion, sessions: tree.value.sessions };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || process.argv.length <= 2) {
    process.stdout.write(HELP);
    return 0;
  }
  const home = path.resolve(options.home ?? defaultHome());
  const api = (options.api ?? process.env.SOPHO_API ?? 'http://127.0.0.1:7331').replace(/\/$/, '');
  const target = options.undo ? false : true;
  if (!Number.isInteger(options.rotateEvery) || options.rotateEvery < 0) {
    process.stderr.write('--rotate-every 必须是 >= 0 的整数\n');
    return 2;
  }
  if (!options.dryRun && options.rotateEvery > 0 && options.concurrency !== 1) {
    process.stderr.write('启用 --rotate-every 时 --concurrency 必须为 1（轮换期间不许还有并发写）\n');
    return 2;
  }

  const ledger = await readLegacyLedger(home);
  const targetIsV22 = await assertTargetIsV22(api).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    return null;
  });
  if (!targetIsV22) return 2;

  process.stdout.write(`${JSON.stringify({
    mode: options.dryRun ? 'dry-run' : options.undo ? 'undo' : 'migrate',
    home,
    ledger: ledger.file,
    ledgerExists: ledger.exists,
    ledgerMalformed: ledger.malformed,
    ledgerArchivedCount: ledger.archived.length,
    api,
    logicVersion: targetIsV22.logicVersion,
    instancesSessions: targetIsV22.sessions.length,
    rotateEvery: options.rotateEvery,
    rotateEndpoint: `${api}/reload-code`,
  })}\n`);
  if (!ledger.exists) {
    process.stderr.write(`旧账不存在：${ledger.file} —— 没什么可迁的\n`);
    return 0;
  }
  if (ledger.malformed) {
    process.stderr.write(`旧账解析失败：${ledger.file} —— 一个都不动（绝不猜）\n`);
    return 2;
  }

  const ids = options.limit === null ? ledger.archived : ledger.archived.slice(0, options.limit);
  // `/tree.archived` 可能来自 v2.1 sidecar 的只读兼容层，不能据此判断「新账已迁」。
  // 这里只读会话 JSONL 来区分：最新 sopho.archive 已是目标态才算 already；写入仍只走正式 HTTP。
  const newArchiveStates = await readNewArchiveStates(home, new Set(ids));
  const summary = { targeted: ids.length, already: 0, migrated: 0, notFound: 0, unopenable: 0, busy: 0, errors: [], skipped: [], unopenableSample: [] };
  const rotation = {
    enabled: !options.dryRun && options.rotateEvery > 0,
    every: options.rotateEvery,
    endpoint: `${api}/reload-code`,
    method: 'POST',
    body: null,
    waitCriterion: '/host.currentGenerationId changes AND currentWorkerPid changes AND workerCount === 1',
    count: 0,
    events: [],
  };
  let writesSinceRotation = 0;
  let stopAfterRotationFailure = false;

  async function rotateGeneration() {
    const before = await request(api, '/host');
    if (before.status !== 200 || typeof before.value?.currentGenerationId !== 'string' || !before.value?.currentWorkerPid) {
      throw new Error(`轮换前 GET /host 失败：${before.status} ${String(before.text).slice(0, 160)}`);
    }
    const reload = await request(api, '/reload-code', { method: 'POST', timeoutMs: 120_000 });
    if (reload.status !== 200) throw new Error(`POST /reload-code 失败：${reload.status} ${String(reload.text).slice(0, 160)}`);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const after = await request(api, '/host').catch(() => null);
      if (after?.status === 200
          && after.value?.currentGenerationId !== before.value.currentGenerationId
          && after.value?.currentWorkerPid !== before.value.currentWorkerPid
          && after.value?.workerCount === 1) {
        rotation.count += 1;
        rotation.events.push({
          afterMigrated: summary.migrated,
          fromGenerationId: before.value.currentGenerationId,
          fromWorkerPid: before.value.currentWorkerPid,
          toGenerationId: after.value.currentGenerationId,
          toWorkerPid: after.value.currentWorkerPid,
          hostPid: after.value.pid ?? null,
        });
        writesSinceRotation = 0;
        return;
      }
      await sleep(250);
    }
    throw new Error(`轮换后 120000ms 内未满足等待判据（from=${before.value.currentGenerationId} pid=${before.value.currentWorkerPid}）`);
  }

  // `/tree` 给出会话存在性；「新账是否已就位」由上面的 JSONL 只读扫描判断，避免把兼容层
  // 从 archive.json 回落出的 archived=true 误认成迁移完成。已就位时仍不打开 runtime，保持低扰动。
  const treeState = new Map(targetIsV22.sessions.map((session) => [session.id, session.archived === true]));

  // 有些会话真的开不起来：仓库里记的 cwd 已经不在了（被删掉的工作树、临时的 /tmp 目录），
  // 而 v2.2 的池在打开会话时硬要求 cwd 存在（`session cwd does not exist or is not a directory`）。
  // 这类既不是我们参数错了、也不是可以重试的忙 —— 单独归一类，报清楚，别混进 errors 里。
  const isUnopenableCwd = (text) => /cwd does not exist or is not a directory/i.test(String(text));

  async function processOne(id) {
    if (!treeState.has(id)) {
      summary.notFound += 1;
      summary.skipped.push({ id, reason: 'session_not_found' });
      return;
    }
    if (newArchiveStates.get(id) === target) {
      summary.already += 1;
      return;
    }
    const detail = await request(api, `/sessions/${encodeURIComponent(id)}`).catch((error) => ({ status: 0, text: String(error?.message ?? error) }));
    if (detail.status === 404) {
      summary.notFound += 1;
      summary.skipped.push({ id, reason: 'session_not_found' });
      return;
    }
    if (detail.status !== 200) {
      if (isUnopenableCwd(detail.text)) {
        summary.unopenable += 1;
        const cwd = String(detail.text).match(/: (.+?)"/)?.[1] ?? null;
        if (summary.unopenableSample.length < 5) summary.unopenableSample.push({ id, cwd });
        return;
      }
      summary.errors.push({ id, reason: `detail_${detail.status}`, text: String(detail.text).slice(0, 160) });
      return;
    }
    // A-30 让 cwd 缺失会话的详情/正文能以只读态返回 200；迁移写路仍会稳定 409。
    // 用结构化字段判定（不是错误字符串启发式），直接归到 unopenable，避免误报成 busy 并重试。
    if (detail.value?.readOnly === true && detail.value?.readOnlyReason === 'cwd-missing') {
      summary.unopenable += 1;
      if (summary.unopenableSample.length < 5) summary.unopenableSample.push({ id, cwd: detail.value.cwdMissing ?? null });
      return;
    }
    if (options.dryRun) {
      summary.migrated += 1;
      return;
    }
    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      const write = await request(api, `/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST', body: { archived: target } })
        .catch((error) => ({ status: 0, text: String(error?.message ?? error) }));
      if (write.status === 200 && write.value?.archived === target) {
        treeState.set(id, target);
        newArchiveStates.set(id, target);
        summary.migrated += 1;
        writesSinceRotation += 1;
        if (rotation.enabled && writesSinceRotation >= options.rotateEvery) {
          try {
            await rotateGeneration();
          } catch (error) {
            summary.errors.push({ id, reason: 'rotation_failed', text: String(error?.message ?? error).slice(0, 240) });
            stopAfterRotationFailure = true;
          }
        }
        return;
      }
      // 409 = 会话正忙（在跑/压缩/重试）。等着再来，别硬来。
      if (write.status === 409 && attempt < options.retries) {
        await sleep(750 * (attempt + 1));
        continue;
      }
      if (write.status === 409) {
        summary.busy += 1;
        summary.skipped.push({ id, reason: 'busy' });
        return;
      }
      if (isUnopenableCwd(write.text)) {
        summary.unopenable += 1;
        return;
      }
      summary.errors.push({ id, reason: `write_${write.status}`, text: String(write.text).slice(0, 160) });
      return;
    }
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency, ids.length || 1)) }, async () => {
    while (cursor < ids.length && !stopAfterRotationFailure) {
      const id = ids[cursor];
      cursor += 1;
      await processOne(id);
      const done = summary.already + summary.migrated + summary.notFound + summary.unopenable + summary.busy + summary.errors.length;
      if (done % 25 === 0) process.stdout.write(`  … ${done}/${ids.length}（已改 ${summary.migrated} / 已就位 ${summary.already} / 缺 ${summary.notFound} / 开不起来 ${summary.unopenable} / 忙 ${summary.busy} / 错 ${summary.errors.length}）\n`);
    }
  });
  await Promise.all(workers);

  // 迁移后同时对账：/tree 是用户看到的最终归档态；新账 map 才能证明义务真的已脱离 sidecar。
  const tree = await request(api, '/tree');
  const sessions = Array.isArray(tree.value?.sessions) ? tree.value.sessions : [];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const existing = ids.filter((id) => byId.has(id));
  const nowArchived = existing.filter((id) => byId.get(id).archived === target).length;
  const newLedgerApplied = existing.filter((id) => newArchiveStates.get(id) === target).length;
  const verification = {
    ledgerIdsPresentInTree: existing.length,
    archivedInTree: nowArchived,
    newLedgerApplied,
    // dry-run 什么都没写，所以「是否都到位」不适用 —— 用 null 明说，别拿它当绿灯。
    allTargetsApplied: options.dryRun ? null : existing.length === newLedgerApplied,
    outstanding: existing.length - newLedgerApplied,
    treeArchivedTotal: sessions.filter((session) => session.archived === true).length,
    treeActiveTotal: sessions.filter((session) => session.archived !== true).length,
    treeUnreadCount: tree.value?.unread?.count ?? null,
  };

  const result = {
    mode: options.dryRun ? 'dry-run' : options.undo ? 'undo' : 'migrate',
    ...summary,
    rotation,
    verification,
    // 「开不起来」不当作假成功：它是有事没做成的**真**残留，退出码仍然非零，
    // 但归类清楚（不是参数错、不是忙），让人一眼知道剩的是什么、为什么。
    ok: summary.errors.length === 0 && summary.busy === 0 && summary.unopenable === 0 && (options.dryRun || verification.allTargetsApplied),
  };
  // 结果压成一行 JSON：调用方（人/脚本/测试）拿最后一行就能解析，不必跟缩进较劲。
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (options.report) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(options.report, `${JSON.stringify({ at: new Date().toISOString(), options: { ...options, api, home }, ...result }, null, 2)}\n`);
    process.stdout.write(`report: ${options.report}\n`);
  }
  process.stdout.write(result.ok ? 'RESULT: migrate-legacy-archive OK\n' : 'RESULT: migrate-legacy-archive INCOMPLETE\n');
  if (summary.unopenable > 0) {
    process.stderr.write(`⚠ ${summary.unopenable} 个会话开不起来（仓库里记的 cwd 已不存在）→ 迁移不到；`
      + `它们是「cwd 消失」这一类，需要读兼容回退或先恢复目录，例子：${JSON.stringify(summary.unopenableSample)}\n`);
  }
  return result.ok ? 0 : 1;
}

process.exitCode = await main();
