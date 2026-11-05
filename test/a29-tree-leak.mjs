import { mkdir, mkdtemp, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createTreeScaleFixture, DEFAULT_BIG_MIB, DEFAULT_SESSIONS, MIB } from './tree-scale-fixture.mjs';
import { createProcessSampler } from './harness.mjs';
import {
  hostStatus,
  poll,
  readWorkerPortFromLog,
  request,
  settleWindow,
  sleep,
  startSandboxBase,
  waitForIdle,
  workerToken,
  workerTreeRequest,
} from './perf-verify-lib.mjs';

// ───────────────────────────── CLI ─────────────────────────────
function parseArgs(argv) {
  const options = {
    fixtureDir: null,
    sessions: DEFAULT_SESSIONS,
    bigMib: DEFAULT_BIG_MIB,
    bigCount: 3,
    noReal: false,
    requests: 10,
    abortAfterMs: 1500,
    settleMs: 3000,
    idleCpuMsPerSec: 50,
    calibrateMaxMs: 120_000,
    hostArm: 3,
    workerOldSpaceMiB: 0,
    singleSessionHeapMib: 256,
    timeoutSeconds: 1800,
    reportOnly: false,
    keep: false,
    json: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    const num = (key, min = 0) => { options[key] = Number(next()); if (!Number.isFinite(options[key]) || options[key] < min) throw new Error(`--${key} must be a number >= ${min}`); };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--fixture-dir') options.fixtureDir = next();
    else if (arg === '--sessions') num('sessions', 1);
    else if (arg === '--big-mib') num('bigMib', 0);
    else if (arg === '--big-count') num('bigCount', 0);
    else if (arg === '--no-real') options.noReal = true;
    else if (arg === '--requests') num('requests', 1);
    else if (arg === '--abort-after-ms') num('abortAfterMs', 50);
    else if (arg === '--settle-ms') num('settleMs', 100);
    else if (arg === '--idle-cpu-ms-per-sec') num('idleCpuMsPerSec', 1);
    else if (arg === '--calibrate-max-ms') num('calibrateMaxMs', 1000);
    else if (arg === '--host-arm') num('hostArm', 0);
    else if (arg === '--worker-old-space-mib') num('workerOldSpaceMiB', 0);
    else if (arg === '--single-session-heap-mib') num('singleSessionHeapMib', 64);
    else if (arg === '--timeout-seconds') num('timeoutSeconds', 30);
    else if (arg === '--report-only') options.reportOnly = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--json') options.json = next();
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return `Usage: node test/a29-tree-leak.mjs [options]\n\n` +
    `  --fixture-dir DIR        复用已有的 fixture home（不给就现造一个临时 home）\n` +
    `  --sessions N             目标会话总数（默认 ${DEFAULT_SESSIONS}）\n` +
    `  --big-mib M / --big-count K  「10 MB 级」大文件的尺寸 / 个数（默认 ${DEFAULT_BIG_MIB} / 3）\n` +
    `  --no-real                不复制真会话（只用合成），用于快速自检\n` +
    `  --requests N             臂 B 的请求数（默认 10）\n` +
    `  --abort-after-ms T       臂 B 在第 T ms 主动 abort（默认 1500）\n` +
    `  --settle-ms T            放弃后静默观察窗（默认 3000）\n` +
    `  --idle-cpu-ms-per-sec N  「已停算」判据：窗内 CPU 速率低于 N ms/s 即视为噪声（默认 50）\n` +
    `  --host-arm N             臂 A（走宿主 /tree）次数，0 = 跳过（默认 3）\n` +
    `  --worker-old-space-mib N 给 worker 一个确定的小堆（默认 0 = Node 默认）\n` +
    `  --single-session-heap-mib N 单会话保护相位的小堆（默认 256）\n` +
    `  --report-only            只打印数字、不下结论（收集基线用）\n` +
    `  --keep                   保留 fixture / 日志目录\n` +
    `  --json PATH              把原始样本写成 JSON\n\n` +
    `绝不碰真 profile / 固定端口 / 生产实例。`;
}

// ───────────────────────── 相位 1/2：泄漏曲线 ─────────────────────────
async function leakCurve({ sampler, hostPort, workerPid, workerPort, token, options, report }) {
  const samples = [];
  const pids = [workerPid];

  const cpuOf = async () => {
    const map = await sampler.sample(pids);
    return map.get(workerPid) ?? null;
  };

  // (0) 先量「不放弃时一发整树读的真实成本」：这个数字决定放弃点设在哪、
  //     也是后面「被放弃的那一发到底少算了多少」的分母。
  const probeBefore = await cpuOf();
  const probeT0 = Date.now();
  const probe = await workerTreeRequest(workerPort, options.calibrateMaxMs, { token });
  const probeAfter = await cpuOf();
  const probeIdle = await waitForIdle(sampler, workerPid, options.idleCpuMsPerSec, options.calibrateMaxMs);
  const fullCostCpuMs = probeBefore && probeIdle.cpuMs ? Number((probeIdle.cpuMs - probeBefore.cpuMs).toFixed(1)) : null;
  const fullCost = {
    aborted: probe.aborted,
    statusCode: probe.statusCode,
    sessions: probe.sessions,
    wallMs: Date.now() - probeT0,
    responseMs: probe.elapsedMs,
    fullCostCpuMs,
    rssBeforeBytes: probeBefore?.rssBytes ?? null,
    rssPeakBytes: probeIdle.rssBytes ?? null,
    idleTrail: probeIdle.trail,
  };
  report('full_cost_probe', fullCost);

  // 放弃点：通常用配置值；但若这台机器/这版代码快得让整树读在放弃点前就跑完，
  // 那「放弃」根本没发生 —— 自动改到 fullCost 的 40%，并如实记下来。
  let effectiveAbortMs = options.abortAfterMs;
  let abortAdjusted = false;
  if (fullCostCpuMs !== null && effectiveAbortMs > fullCostCpuMs - 300) {
    effectiveAbortMs = Math.max(150, Math.floor(fullCostCpuMs * 0.4));
    abortAdjusted = true;
    report('abort_ms_adjusted', { configured: options.abortAfterMs, fullCostCpuMs, effectiveAbortMs });
  }

  // (1) 一次「放弃 → 等到空闲」的定性证据：abort 之后还在烧多久。
  const abandonStart = await cpuOf();
  const abandonT0 = Date.now();
  const abandoned = await workerTreeRequest(workerPort, effectiveAbortMs, { token });
  const abandonAfterAbort = await cpuOf();
  const abandonIdle = await waitForIdle(sampler, workerPid, options.idleCpuMsPerSec, options.calibrateMaxMs);
  const abandonTrail = {
    aborted: abandoned.aborted,
    effectiveAbortMs,
    responseMs: abandoned.elapsedMs,
    cpuAtAbortMs: abandonAfterAbort?.cpuMs ?? null,
    cpuBurnAfterAbortMs: abandonAfterAbort && abandonIdle.cpuMs ? Number((abandonIdle.cpuMs - abandonAfterAbort.cpuMs).toFixed(1)) : null,
    wallAfterAbortMs: Date.now() - abandonT0 - abandoned.elapsedMs,
    cpuBeforeMs: abandonStart?.cpuMs ?? null,
    cpuAfterIdleMs: abandonIdle.cpuMs,
    idleTrail: abandonIdle.trail,
  };
  report('abandon_trail', abandonTrail);

  // (2) 曲线：连着打 N 发，每发之后只静默 settleMs —— 不复位、不等空闲，正是事故里的形状。
  for (let index = 0; index < options.requests; index += 1) {
    const beforeHost = await hostStatus(hostPort);
    const beforeCpu = await cpuOf();
    const t0 = Date.now();
    const outcome = await workerTreeRequest(workerPort, effectiveAbortMs, { token });
    const afterCpu = await cpuOf();
    const hostAfterRequest = await hostStatus(hostPort);
    const settle = await settleWindow(sampler, workerPid, options.settleMs);
    const hostAfterSettle = await hostStatus(hostPort);
    const wallMs = Date.now() - t0;
    samples.push({
      index: index + 1,
      aborted: outcome.aborted,
      statusCode: outcome.statusCode,
      sessions: outcome.sessions,
      bodyError: outcome.bodyError,
      responseElapsedMs: outcome.elapsedMs,
      wallMs,
      busyCpuMs: beforeCpu && afterCpu ? Number((afterCpu.cpuMs - beforeCpu.cpuMs).toFixed(1)) : null,
      residualCpuMs: settle.cpuMs,
      residualMaxRateMsPerSec: settle.maxRateMsPerSec,
      totalCpuMs: beforeCpu && settle.endCpuMs ? Number((settle.endCpuMs - beforeCpu.cpuMs).toFixed(1)) : null,
      settleMs: options.settleMs,
      settleTrail: settle.trail,
      workerRssBeforeBytes: beforeCpu?.rssBytes ?? null,
      workerRssAfterBytes: afterCpu?.rssBytes ?? null,
      workerRssAfterSettleBytes: settle.rssEndBytes,
      workerRssPeakSettleBytes: settle.rssMaxBytes,
      hostRssBytesBefore: beforeHost.workerRssBytes,
      hostHeapUsedBytesBefore: beforeHost.workerHeapUsedBytes,
      hostRssBytesAfterRequest: hostAfterRequest.workerRssBytes,
      hostHeapUsedBytesAfterRequest: hostAfterRequest.workerHeapUsedBytes,
      hostRssBytesAfterSettle: hostAfterSettle.workerRssBytes,
      hostHeapUsedBytesAfterSettle: hostAfterSettle.workerHeapUsedBytes,
      hostElapsedMsDuringStorm: afterCpu ? hostAfterRequest._elapsedMs : null,
      hostElapsedMsAfterSettle: hostAfterSettle._elapsedMs,
      hostPoolHot: hostAfterSettle.pool?.hot ?? null,
      hostPoolCounters: hostAfterSettle.pool ?? null,
      hostWorkerTotals: hostAfterSettle.workerTotals ?? null,
      currentWorkerPid: hostAfterSettle.currentWorkerPid,
      workerCount: hostAfterSettle.workerCount,
      draining: hostAfterSettle.drainingGenerations?.length ?? null,
    });
    report('request', samples.at(-1));
  }
  return { samples, fullCost, abandonTrail, effectiveAbortMs, abortAdjusted };
}

// ───────────────────────── 相位 3：宿主 /tree（真机形状） ─────────────────────────
async function hostTreeArm({ sampler, hostPort, workerPid, options, report }) {
  const results = [];
  for (let index = 0; index < options.hostArm; index += 1) {
    const beforeCpu = (await sampler.sample([workerPid])).get(workerPid);
    const response = await request(hostPort, '/tree', { timeoutMs: 120_000 });
    const afterCpu = (await sampler.sample([workerPid])).get(workerPid);
    await sleep(options.settleMs);
    const settleCpu = (await sampler.sample([workerPid])).get(workerPid);
    results.push({
      index: index + 1,
      statusCode: response.statusCode,
      elapsedMs: response.elapsedMs,
      bytes: response.bytes,
      sessions: response.value?.sessions?.length ?? null,
      error: response.value?.error ?? response.value?.message ?? null,
      busyCpuMs: beforeCpu && afterCpu ? Number((afterCpu.cpuMs - beforeCpu.cpuMs).toFixed(1)) : null,
      residualCpuMs: afterCpu && settleCpu ? Number((settleCpu.cpuMs - afterCpu.cpuMs).toFixed(1)) : null,
      timedOut: response.statusCode === 500 && /Timeout|timeout/i.test(String(response.value?.message ?? response.value?.error ?? '')),
    });
    report('host_tree', results.at(-1));
  }
  return results;
}

// ───────────────────────── 相位 4：单会话保护不能被修没 ─────────────────────────
async function singleSessionGuard({ report, sandboxRoot, heapMiB }) {
  const home = path.join(sandboxRoot, 'guard-home');
  const sessionsRoot = path.join(home, 'sessions');
  const workspace = path.join(home, 'workspace');
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(home, 'models.json'), `${JSON.stringify({ providers: {} }, null, 2)}\n`);
  await writeFile(path.join(home, 'settings.json'), `${JSON.stringify({ defaultThinkingLevel: 'off', compaction: { enabled: false } }, null, 2)}\n`);

  // 一条 15 MiB 的合成会话：小堆（默认 256 MiB ⇒ heapHigh ≈ 0.6×256 = 153 MiB）下
  // 单文件准入 `文件×8 + 128 MiB ≈ 248 MiB > 153 MiB` ⇒ 必须 503 worker_memory_pressure。
  const id = `00000000-0000-4000-8000-${String(Date.now()).padStart(12, '0').slice(-12)}`;
  const file = path.join(sessionsRoot, `guard_${id}.jsonl`);
  const header = JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: workspace });
  const stream = createWriteStream(file, { encoding: 'utf8' });
  let streamError = null;
  stream.once('error', (error) => { streamError = error; });
  const write = async (line) => {
    if (!stream.write(line)) await new Promise((resolve) => stream.once('drain', resolve));
    if (streamError) throw streamError;
  };
  await write(`${header}\n`);
  const chunk = `${JSON.stringify({ type: 'message', id: 'aaaaaaaa', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'y'.repeat(900) }], timestamp: new Date().toISOString() } })}\n`;
  const perMessage = Buffer.byteLength(chunk);
  const messages = Math.ceil((15 * MIB) / perMessage);
  for (let index = 0; index < messages; index += 1) await write(chunk);
  await new Promise((resolve, reject) => stream.end(resolve).once('error', reject));
  const info = await stat(file);
  const logPath = path.join(sandboxRoot, 'guard-base.log');
  const sandbox = await startSandboxBase({ home, sessionsRoot, workspace, logPath, workerOldSpaceMiB: heapMiB });
  try {
    await poll('guard sandbox ready', () => hostStatus(sandbox.port), (host) => host?.currentWorkerPid > 0, 60_000);
    const response = await request(sandbox.port, `/sessions/${id}`, { timeoutMs: 120_000 });
    const detail = {
      heapMiB,
      sessionFileBytes: info.size,
      statusCode: response.statusCode,
      error: response.value?.error ?? null,
      reason: response.value?.details?.reason ?? null,
      retryable: response.value?.details?.retryable ?? null,
      predictedPeakBytes: response.value?.details?.predictedPeakBytes ?? null,
    };
    report('single_session_guard', detail);
    return detail;
  } finally {
    await sandbox.stop();
  }
}

// ───────────────────────── 主流程 ─────────────────────────
function median(values) {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), 'sopho-tree-leak-'));
const checks = [];
const raw = { startedAt: new Date().toISOString(), options: { ...options }, events: [] };
const report = (event, fields) => {
  raw.events.push({ at: new Date().toISOString(), event, ...fields });
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
};
const check = (id, ok, detail, evidence) => {
  checks.push({ id, ok, detail, evidence });
  process.stdout.write(`${JSON.stringify({ event: 'check', id, ok, detail, evidence })}\n`);
};

let sampler;
let base;
let fixture;
let deadline;
try {
  deadline = setTimeout(() => {
    report('deadline', { timeoutSeconds: options.timeoutSeconds });
    base?.child?.kill('SIGTERM');
  }, options.timeoutSeconds * 1000);
  deadline.unref?.();

  sampler = createProcessSampler();

  if (options.fixtureDir) {
    const home = path.resolve(options.fixtureDir);
    fixture = {
      home,
      sessionsRoot: path.join(home, 'sessions'),
      cwd: path.join(home, 'workspace'),
      reuse: true,
      cleanup: async () => {},
    };
    await mkdir(fixture.sessionsRoot, { recursive: true });
    await mkdir(fixture.cwd, { recursive: true });
    const files = await readdir(fixture.sessionsRoot);
    fixture.sessions = files.filter((name) => name.endsWith('.jsonl'));
  } else {
    fixture = await createTreeScaleFixture({
      out: path.join(sandboxRoot, 'home'),
      sessions: options.sessions,
      bigMib: options.bigMib,
      bigCount: options.bigCount,
      copyReal: !options.noReal,
      log: (line) => process.stderr.write(`${line}\n`),
    });
  }
  report('fixture', {
    home: fixture.home,
    sessionFiles: fixture.sessions.length,
    corpusBytes: fixture.corpusBytes ?? null,
    copiedReal: fixture.copiedReal?.length ?? null,
    synthetic: fixture.synthetic?.length ?? null,
    reused: Boolean(fixture.reuse),
    sandbox: sandboxRoot,
  });

  const logPath = path.join(sandboxRoot, 'base.log');
  base = await startSandboxBase({
    home: fixture.home,
    sessionsRoot: fixture.sessionsRoot,
    workspace: fixture.cwd,
    logPath,
    workerOldSpaceMiB: options.workerOldSpaceMiB,
  });
  const firstHost = await poll('sandbox ready', () => hostStatus(base.port), (host) => host?.currentWorkerPid > 0, 90_000);
  const worker = await readWorkerPortFromLog(logPath);
  report('sandbox_ready', {
    hostPort: base.port,
    hostPid: firstHost.pid,
    workerPid: firstHost.currentWorkerPid,
    workerPort: worker.port,
    generationId: firstHost.currentGenerationId,
    workerOldSpaceMiB: options.workerOldSpaceMiB || null,
    heapLimitNote: 'worker default heap unless --worker-old-space-mib',
  });

  const workerPid = firstHost.currentWorkerPid;
  const token = workerToken(firstHost.pid, firstHost.currentGenerationId, 'boot');
  const { samples, fullCost, abandonTrail, effectiveAbortMs, abortAdjusted } = await leakCurve({
    sampler,
    hostPort: base.port,
    workerPid,
    workerPort: worker.port,
    token,
    options,
    report,
  });
  raw.leak = { fullCost, abandonTrail, effectiveAbortMs, abortAdjusted, samples };
  check('ARM-B-authenticated', fullCost.statusCode !== 403,
    '臂 B 必须能直连 worker（否则“被放弃”这件事根本没发生）；403 = token 算错，门本身就废了',
    { statusCode: fullCost.statusCode, sessions: fullCost.sessions });
  check('FIXTURE-1-abort-actually-cuts-work', fullCost.statusCode === 200 && (fullCost.fullCostCpuMs ?? 0) >= effectiveAbortMs + 300,
    `放弃点必须真的把活切断：一发整树读的成本（${fullCost.fullCostCpuMs} ms）须 ≥ 放弃点（${effectiveAbortMs} ms）+300 ms；否则是 fixture 太小 / 放弃点太大`,
    { statusCode: fullCost.statusCode, fullCostCpuMs: fullCost.fullCostCpuMs, fullCostWallMs: fullCost.wallMs, effectiveAbortMs, abortAdjusted, sessions: fullCost.sessions });
  const hostTree = options.hostArm > 0
    ? await hostTreeArm({ sampler, hostPort: base.port, workerPid, options, report })
    : [];
  raw.hostTree = hostTree;

  // ── 判据 ──
  // 1) 被放弃之后必须停算：静默窗内**最大** CPU 速率回落到噪声。
  const worstResidualRate = Math.max(0, ...samples.map((sample) => sample.residualMaxRateMsPerSec ?? 0));
  const residualOk = samples.every((sample) => (sample.residualMaxRateMsPerSec ?? 0) <= options.idleCpuMsPerSec);
  check('LEAK-1-abandoned-read-stops', residualOk,
    `静默窗内最大 CPU 速率必须 ≤ ${options.idleCpuMsPerSec} ms/s（噪声）；实测最坏 ${worstResidualRate} ms/s`,
    { thresholdMsPerSec: options.idleCpuMsPerSec, worstResidualRateMsPerSec: worstResidualRate, settleMs: options.settleMs,
      perWindowResidualCpuMs: samples.map((sample) => sample.residualCpuMs), perWindowMaxRate: samples.map((sample) => sample.residualMaxRateMsPerSec) });

  // 2) 每发被算的钱要封顶：忙 + 静默窗 必须明显低于「不放弃时的全量成本」——
  //    放弃必须真的省下活，而不是把整棵树读完。
  const costCap = Math.max(effectiveAbortMs, Math.min(effectiveAbortMs + 800, (fullCost.fullCostCpuMs ?? Infinity) - 200));
  const worstTotalCpu = Math.max(0, ...samples.map((sample) => sample.totalCpuMs ?? 0));
  const costOk = samples.every((sample) => (sample.totalCpuMs ?? Infinity) <= costCap);
  check('LEAK-2-per-request-cpu-capped', costOk,
    `每发总 CPU（忙 + 静默窗）必须 ≤ ${costCap} ms（min(放弃点+800, 全量成本-200)）；实测最坏 ${worstTotalCpu} ms（全量成本 ${fullCost.fullCostCpuMs} ms）`,
    { costCapMs: costCap, effectiveAbortMs, fullCostCpuMs: fullCost.fullCostCpuMs, perRequestTotalCpuMs: samples.map((sample) => sample.totalCpuMs), perRequestBusyCpuMs: samples.map((sample) => sample.busyCpuMs), perRequestResidualCpuMs: samples.map((sample) => sample.residualCpuMs) });

  // 3) 内存不许随请求数单调堆积：后一半的 RSS 峰值不该显著超过前一半。
  const rss = samples.map((sample) => sample.workerRssPeakSettleBytes ?? sample.workerRssAfterSettleBytes);
  const firstHalf = median(rss.slice(0, Math.max(1, Math.floor(rss.length / 2))));
  const secondHalf = median(rss.slice(Math.max(1, Math.floor(rss.length / 2))));
  const rssOk = firstHalf === null || secondHalf === null || secondHalf <= firstHalf * 1.5 + 128 * MIB;
  check('LEAK-3-rss-not-monotonic', rssOk,
    `后半段 RSS 中位数 ≤ 前半段 ×1.5 + 128 MiB；实测 ${firstHalf} → ${secondHalf}`,
    { firstHalfRssMedianBytes: firstHalf, secondHalfRssMedianBytes: secondHalf, rssSeriesBytes: rss, hostReportedRssAfterSettleBytes: samples.map((sample) => sample.hostRssBytesAfterSettle), processRssAfterSettleBytes: samples.map((sample) => sample.workerRssAfterSettleBytes), hostReportedHeapAfterSettleBytes: samples.map((sample) => sample.hostHeapUsedBytesAfterSettle) });

  // 4) 顺手钉住「还在跑的那些次里 /host 没被拖垮」（事故里 /host 涨到 3 s）。
  const hostElapsed = samples.map((sample) => sample.hostElapsedMsDuringStorm).filter((value) => typeof value === 'number');
  const worstHostElapsed = Math.max(0, ...hostElapsed);
  check('LEAK-4-host-still-answers', hostElapsed.length === 0 || worstHostElapsed <= 3000,
    `洪峰中的 /host 必须 ≤ 3000 ms；实测最坏 ${worstHostElapsed} ms`,
    { worstHostElapsedMs: worstHostElapsed, series: hostElapsed });

  // 5) 池里不许堆下东西：/tree 是磁盘推导，不该留下热/活跃 runtime（用 /host 的 workerTotals + pool 交叉核对）。
  const firstTotals = samples[0]?.hostWorkerTotals ?? null;
  const lastTotals = samples.at(-1)?.hostWorkerTotals ?? null;
  const lastPool = samples.at(-1)?.hostPoolCounters ?? null;
  const poolOk = firstTotals === null || lastTotals === null
    || ((lastTotals.hot ?? 0) <= (firstTotals.hot ?? 0) && (lastTotals.active ?? 0) === 0 && (lastTotals.loading ?? 0) === 0);
  check('LEAK-6-pool-does-not-accumulate', poolOk,
    `整树读不该在池里留下 hot/active/loading：last=${JSON.stringify(lastTotals)}（first=${JSON.stringify(firstTotals)}）`,
    { firstWorkerTotals: firstTotals, lastWorkerTotals: lastTotals, lastPool, workerCount: samples.at(-1)?.workerCount ?? null, draining: samples.at(-1)?.draining ?? null });

  // 6) 臂 A 只在真的触发了宿主超时时才给结论（机器太快就先如实记 not_triggered）。
  const timedOutHost = hostTree.filter((entry) => entry.timedOut);
  if (hostTree.length === 0) {
    report('host_arm_skipped', { reason: '--host-arm 0' });
  } else if (timedOutHost.length === 0) {
    report('host_arm_not_triggered', {
      reason: 'this machine reads the whole tree in <5 s, so the host 5 s timeout never fired; the machine-independent arm B still covers abandonment',
      hostTree: hostTree.map((entry) => ({ statusCode: entry.statusCode, elapsedMs: entry.elapsedMs, sessions: entry.sessions })),
    });
  } else {
    // 宿主 5 s 硬超时放弃的那几发：残留 CPU 必须落在噪声预算内。
    const hostResidualCap = Math.max(500, options.idleCpuMsPerSec * (options.settleMs / 1000));
    const hostResidualOk = timedOutHost.every((entry) => (entry.residualCpuMs ?? 0) <= hostResidualCap);
    check('LEAK-5-host-timeout-stops-worker', hostResidualOk,
      `宿主 5 s 超时放弃的那几发，残留 CPU 必须 ≤ ${hostResidualCap} ms；实测 ${timedOutHost.map((entry) => entry.residualCpuMs).join(', ')}`,
      { timedOut: timedOutHost.length, residualCpuMs: timedOutHost.map((entry) => entry.residualCpuMs), residualCapMs: hostResidualCap,
        statusCodes: timedOutHost.map((entry) => entry.statusCode), errors: timedOutHost.map((entry) => entry.error) });
  }

  // 7) 单会话保护不许被修没。
  const guard = await singleSessionGuard({ report, sandboxRoot, heapMiB: options.singleSessionHeapMib });
  check('GUARD-1-single-session-still-503', guard.statusCode === 503 && guard.error === 'worker_memory_pressure',
    `单条装不下的会话仍须 503 worker_memory_pressure；实测 ${guard.statusCode} ${guard.error}`,
    guard);

  raw.finishedAt = new Date().toISOString();
  raw.checks = checks;
  if (options.json) await writeFile(path.resolve(options.json), `${JSON.stringify(raw, null, 2)}\n`);

  const failed = checks.filter((entry) => !entry.ok);
  process.stdout.write(`${JSON.stringify({ event: 'summary', checks: checks.map(({ id, ok }) => ({ id, ok })), failed: failed.length, reportOnly: options.reportOnly })}\n`);
  if (!options.reportOnly && failed.length > 0) {
    process.stderr.write(`\nA-29 tree leak gate FAILED (${failed.length}):\n${failed.map((entry) => `  - ${entry.id}: ${entry.detail}`).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`\nA-29 tree leak gate ${options.reportOnly ? '(report-only)' : 'PASSED'}: ${checks.length} checks, ${failed.length} failed\n`);
  }
} catch (error) {
  process.stderr.write(`a29-tree-leak crashed: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
} finally {
  clearTimeout(deadline);
  await sampler?.stop?.();
  await base?.stop?.();
  if (!options.keep && fixture && !options.fixtureDir) await fixture.cleanup().catch(() => {});
  if (!options.keep) await rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
  else process.stderr.write(`sandbox kept at ${sandboxRoot}\n`);
}
