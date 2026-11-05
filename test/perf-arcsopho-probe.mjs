#!/usr/bin/env node
// perf-arcsopho-probe.mjs —— 部署后「一发入魂」的**只读**验证：GET /tree 是不是 200 且条数对。
//
// 它解决的是 2026-09-18 那场事故的验收问题：v2.2 的整树读在真机数据上被宿主 5 秒硬超时掐成
// 500，而 worker 继续算、前端无退避重试，最后连 /host 都 3 s。修完之后要能**一次**说清
// 「现在这一发是 200、多少条、耗时多少、worker RSS 前后各多少」。
//
// ⚠️ 它**故意只发一发**（外加两发 /host 量前后态），没有循环、没有并发、没有重试。
//    **这不是压测工具** —— 绝不许在别人正在用实例的时候拿它跑压力：
//    /tree 是整树读，真机数据上一发就是数秒 CPU；发洪水正是当晚把实例打瘫的那件事。
//    要复现规模请在**本机用副本 profile**（`test/a29-tree-leak.mjs` 就是干这个的）。
//
// 默认**不发任何请求**（只打印它将要做什么）。确实要发，显式加 `--apply`。
//
// 用法：
//   node test/perf-arcsopho-probe.mjs                          # dry-run：只打印计划
//   node test/perf-arcsopho-probe.mjs --apply                  # 真打一发 /tree
//   node test/perf-arcsopho-probe.mjs --apply --url http://127.0.0.1:7331 --expect-sessions 302
//
// 退出码：0 = 200 且条数符合期望；1 = 不符合；2 = 用法/连接错误。

import http from 'node:http';
import https from 'node:https';
import process from 'node:process';
import { URL } from 'node:url';

function parseArgs(argv) {
  const options = {
    url: 'http://127.0.0.1:7331',
    apply: false,
    expectSessions: null,
    timeoutMs: 60_000,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => { index += 1; if (index >= argv.length) throw new Error(`${arg} requires a value`); return argv[index]; };
    if (arg === '--url') options.url = next();
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--expect-sessions') options.expectSessions = Number(next());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function usageText() {
  return `Usage: node test/perf-arcsopho-probe.mjs [options]\n\n` +
    `  --url URL               宿主地址（默认 http://127.0.0.1:7331）\n` +
    `  --apply                 真的发请求（默认只打印计划，一个包都不发）\n` +
    `  --expect-sessions N     /tree 的条数期望值（不给就只报数、不判条数）\n` +
    `  --timeout-ms N          单发超时（默认 60000）\n` +
    `  --json                  只输出一行 JSON（给脚本消费）\n\n` +
    `⚠️ 只发一发 /tree + 两发 /host。这不是压测工具；别在别人正在用时跑。`;
}

function once(url, { timeoutMs, accept }) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const started = Date.now();
    const request = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { accept, 'accept-encoding': 'identity', connection: 'close' },
    });
    const timer = setTimeout(() => request.destroy(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...outcome, elapsedMs: Date.now() - started });
    };
    request.once('error', (error) => finish({ error: error.message, statusCode: 0, bodyBytes: 0, value: null }));
    request.once('response', (response) => {
      const chunks = [];
      let bodyBytes = 0;
      response.on('data', (chunk) => { bodyBytes += chunk.length; chunks.push(chunk); });
      response.once('error', (error) => finish({ error: error.message, statusCode: response.statusCode, bodyBytes, value: null }));
      response.once('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let value = null;
        try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
        finish({
          statusCode: response.statusCode,
          bodyBytes,
          value,
          contentEncoding: response.headers['content-encoding'] ?? null,
          rawHead: raw.slice(0, 300),
        });
      });
    });
    request.end();
  });
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${usageText()}\n`);
  process.exit(0);
}

const base = new URL(options.url);
const hostUrl = new URL('/host', base).toString();
const treeUrl = new URL('/tree', base).toString();

const plan = {
  url: options.url,
  willSend: options.apply,
  requests: options.apply ? [{ method: 'GET', url: hostUrl }, { method: 'GET', url: treeUrl }, { method: 'GET', url: hostUrl }] : [],
  expectSessions: options.expectSessions,
  timeoutMs: options.timeoutMs,
  warning: 'single-shot read-only probe; NOT a load test — do not run it while people are using the instance',
};

if (!options.apply) {
  if (options.json) process.stdout.write(`${JSON.stringify({ event: 'dry_run', ...plan })}\n`);
  else {
    process.stdout.write(`dry-run（一个包都不发）。将要发的请求：\n`);
    process.stdout.write(`  1. GET ${hostUrl}   —— worker RSS / heap / generation\n`);
    process.stdout.write(`  2. GET ${treeUrl}   —— 整树读一发\n`);
    process.stdout.write(`  3. GET ${hostUrl}   —— 再看 worker RSS / heap\n`);
    process.stdout.write(`要看真的：加 --apply。\n`);
    process.stdout.write(`⚠️ ${plan.warning}\n`);
  }
  process.exit(0);
}

const before = await once(hostUrl, { timeoutMs: options.timeoutMs, accept: 'application/json' });
if (before.statusCode !== 200) {
  process.stderr.write(`GET /host -> ${before.statusCode} ${before.rawHead ?? before.error ?? ''}\n`);
  process.exit(2);
}
const tree = await once(treeUrl, { timeoutMs: options.timeoutMs, accept: 'application/json' });
const after = await once(hostUrl, { timeoutMs: options.timeoutMs, accept: 'application/json' });

const sessions = tree.value?.sessions?.length ?? null;
const summary = {
  event: 'probe',
  url: options.url,
  generatedAt: new Date().toISOString(),
  tree: {
    statusCode: tree.statusCode,
    elapsedMs: tree.elapsedMs,
    bodyBytes: tree.bodyBytes,
    contentEncoding: tree.contentEncoding,
    sessions,
    error: tree.value?.error ?? (tree.value?.message ?? null),
    rawHead: tree.value ? null : tree.rawHead,
  },
  worker: {
    generationIdBefore: before.value?.currentGenerationId ?? null,
    workerPid: before.value?.currentWorkerPid ?? null,
    rssBytesBefore: before.value?.workerRssBytes ?? null,
    heapUsedBytesBefore: before.value?.workerHeapUsedBytes ?? null,
    rssBytesAfter: after.value?.workerRssBytes ?? null,
    heapUsedBytesAfter: after.value?.workerHeapUsedBytes ?? null,
    workerCountAfter: after.value?.workerCount ?? null,
    generationChanged: (before.value?.currentGenerationId ?? null) !== (after.value?.currentGenerationId ?? null),
  },
  expectSessions: options.expectSessions,
  ok: tree.statusCode === 200 && (options.expectSessions === null || sessions === options.expectSessions),
  note: 'single request only; no retry, no concurrency',
};

if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
else {
  process.stdout.write(`GET /tree -> ${summary.tree.statusCode}  ${summary.tree.elapsedMs} ms  ${summary.tree.bodyBytes} B  sessions=${summary.tree.sessions}${summary.tree.error ? `  error=${summary.tree.error}` : ''}\n`);
  process.stdout.write(`worker: pid=${summary.worker.workerPid} rss ${summary.worker.rssBytesBefore} -> ${summary.worker.rssBytesAfter} B, heap ${summary.worker.heapUsedBytesBefore} -> ${summary.worker.heapUsedBytesAfter} B, generationChanged=${summary.worker.generationChanged}\n`);
  if (options.expectSessions !== null) process.stdout.write(`expected sessions=${options.expectSessions} -> ${summary.ok ? 'MATCH' : 'MISMATCH'}\n`);
  process.stdout.write(`⚠️ ${plan.warning}\n`);
}
process.exit(summary.ok ? 0 : 1);
