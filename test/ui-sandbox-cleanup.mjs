#!/usr/bin/env node
// test/ui-sandbox-cleanup.mjs —— 「真 Chromium 起停之后，/tmp 里不许留下沙箱」这一条的门。
//
// 跑法（**故意不注册成 npm script** —— 与 test/sandbox-hygiene.mjs 同一个理由：别和别的 landing 抢 package.json）：
//   node test/ui-sandbox-cleanup.mjs              # 10 轮 + 5 条反证/边界臂，本机实测 ~20 s
//   node test/ui-sandbox-cleanup.mjs --rounds 20  # 加轮
// 全程只动本门自己 `boot()` 出来的沙箱（运行令牌 / 本次 run 清单认领）与本门自己 spawn 的替身（按精确 pid）；
// **绝不清任何既有残留**、不碰用户自己的 /tmp/org.chromium.Chromium.*、不用 pkill/pgrep、不动活实例。
//
// ── 上界（2026-09-22 总台第二棒追加：挂住是最坏结果） ─────────────────────────────────────
// 本门自带三层上界，**到点报明确的红（带臂名与现场），绝不挂到外面被人 timeout 杀掉**：
//   · 每轮 / 每条臂一条上界（`DEADLINES`，可用 `SOPHO_UI_GATE_ARM_MS` 缩放）；
//   · 全局上界 `SOPHO_UI_GATE_DEADLINE_MS`（默认 600 s）：到点打印现场、收干净自己的东西、`exit 1`；
//   · 失败路径也必须收干净自己：`finally` 里先停掉所有进程内迟写者、关掉所有还挂着的页面（按精确 pid），
//     再按运行令牌/本次 run 清单扫掉自己的沙箱，最后把清空的清单文件删掉。
//
// ── 背景与修法（2026-09-22 派单 uiharness-leak；原始输出见交付报告） ──────────────────────
// `test/ui-harness.mjs` 用 `mkdtemp('sopho-ui-')` 建沙箱、`spawn('/usr/bin/chromium', … --user-data-dir=<沙箱>/chromium)`。
// 老 `close()` 只 `SIGTERM` **本次 spawn 的主 pid**、等它 exit 就返回；调用方紧接着 `rm` 沙箱。两处漏：
//   (a) **清理先于浏览器退出**：插桩实测 8/8 次，**主进程 exit 那一刻仍有 1–3 个自有进程活着**（zygote / utility），
//       它们退出前还会往 profile 里落最后一笔（`Default/Network Persistent State`、`Default/Cache/Cache_Data/*`）
//       ⇒ `rm` 之后目录又被建回来：`/tmp/sopho-ui-*/chromium/Default/…`（本机实测累计到过 65 个 / 486 MB；
//       `rm` 只要 2–54 ms，所以「谁先到」是竞态；把顺序倒过来——先删再等——5/5 次都留下 7–11 项残骸）。
//   (b) **有一批门根本没删过**：25 个用这个底座的门（不含本件新加的那道）里 20 个只 `await ui.close()`、
//       从不 `removeSandbox` ⇒ 每次跑留一棵 ~3 MB 的 profile（实测 `test/tui-tool-diff.mjs` 8/8 次 +1）。
// 修法落在 `test/ui-harness.mjs` 的 `close()`（门一行不用改）：① 等**自己这棵树**退到空集（有上界，到点按
// **精确 pid** 升级 SIGKILL）② 删自己的沙箱 ③ 删完再核（连续一段空窗才算干净；又出现就再删并**如实记账**）。
// 认领口径是**自己那个 profile 目录**（`<sandbox>/chromium`）✓，**不是**整条沙箱路径 ✗（多引擎的门里它是共用的：
// 2026-09-21 实测 Firefox 的收尾把还在跑的整棵 Chromium 杀了）。看进程一律经过 `test/harness.mjs`
// （`processTable` / `processStateOf` / `processAlive`）—— 本文件里不出现 procfs 字面量（harness-contract 的纪律）。
//
// ── 删目录的机械认领（2026-09-22 总台第一棒追加） ────────────────────────────────────────
// 只许删「**本次 run 自己创造**」的路径：令牌写在每个沙箱根上（`.sopho-ui-run.json`），本次 run 的清单
// 登记自己建过的**精确路径**（`/tmp/.sopho-ui-run-<id>.json`）；`removeOwnedRunDirectory` 是唯一删法，
// 两条带内证据任一命中才删，否则**一个字节都不动**。判归属**不做「两次列清单做差集」**（2026-09-22 那次
// 误删就是格式假设骗了自己）。
//
// ── 本门钉的读数 ────────────────────────────────────────────────────────────────────
//   ① 连跑 N 轮（默认 10）真起停：**每轮残留增量 = 0**、自己那个目录真的没了、`cleanup.ok === true`、
//      `cleanup.survivors` 空、`removed ≥ 1`、`reappeared === 0`。
//   ② 端到端：今天**从不删沙箱**的真门（test/tui-tool-diff.mjs）跑完 ⇒ 它自己的沙箱残留 0（本门不替它删）。
//   ③ 反证（必红，**确定性**）：撤掉「等退出」（`SOPHO_UI_SETTLE=nowait` ⇒ 先删后等）⇒ 残留 ≥ 1。
//   ④ 反证（必红，**确定性**）：今天的形状（`SOPHO_UI_SETTLE=off` ⇒ 只停主进程、不删不核）⇒ 整棵沙箱留着。
//   ⑤ 上界臂：忽略 SIGTERM、命令行带本沙箱 profile 目录的自有替身 ⇒ 上界到了必须按精确 pid 升级 SIGKILL、
//      整段有界不挂住。
//   ⑥ 「删完再核」是承重的（**只断言确定性那一半**）：迟写者锚定**事件**（观察到沙箱被删掉才写），
//      ①撤掉复核 ⇒ 必然留下残留（确定性断言）；②默认收尾 ⇒ 复核必须**看见**它（`reappeared ≥ 1`，确定性断言），
//      擦干净与否只作为**读数**打印 + 断言记账不变量（`ok === false` ⟺ `problems` 非空）；③不罢休的迟写者
//      ⇒ 断言有界返回 + 记账不变量；无论哪种结果，本门最后都必须把自己的沙箱扫到 0（兜底，确定性）。
//   ⑦ 机械保证：本门自己造一个「别人的」沙箱（令牌 id 不是本次 run）和一个「既没令牌、也不在本次 run 清单里」
//      的沙箱，两条都必须被 `removeOwnedRunDirectory` **拒绝删除**（一个字节不动），只读盘点也判它们 `mine=false`。
// ⚠️ 没验到什么：「SIGKILL 之后还活着 ⇒ 判红」那条分支本门**不覆盖** —— 用户态造不出杀不掉的进程
//    （SIGKILL 不可阻塞、不可捕获），所以那一条只有代码里的 `record(...)`，没有稳定的红臂可摆。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_ID, RUN_TOKEN_NAME, boot, dropRunManifestIfClean, readRunToken, removeOwnedRunDirectory, scanSandboxDirectories } from './ui-harness.mjs';
import { cleanupStep, finishCleanup, processAlive, processTable, runArms } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = os.tmpdir();
const PREFIX = 'sopho-ui-';
const argv = process.argv.slice(2);
const rounds = Number(argv.includes('--rounds') ? argv[argv.indexOf('--rounds') + 1] : 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const print = (label, value) => process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

// 上界：本门量的是**收尾**，不是启动延迟 ⇒ 起停预算放宽；每条臂、以及整门都有上界。倍率方便机器特别慢时整体放大。
const SCALE = Number(process.env.SOPHO_UI_GATE_ARM_MS ?? 1);
const GLOBAL_DEADLINE_MS = Number(process.env.SOPHO_UI_GATE_DEADLINE_MS ?? 600_000);
const DEADLINES = {
  round: 60_000 * SCALE,
  childGate: 300_000 * SCALE,
  mutant: 60_000 * SCALE,
  lateWriter: 120_000 * SCALE,
};
process.env.SOPHO_UI_BOOT_TIMEOUT_MS ??= String(Math.round(20_000 * SCALE));

// 现场（给「到点判红」用：红必须带臂名与现场，而不是一句空话）。
const startedWall = Date.now();
const scene = { where: 'start', since: new Date().toISOString() };
const setScene = (where) => { scene.where = where; scene.since = new Date().toISOString(); };

// ── 「残留增量」读数：**按运行令牌分类**，不是「两次清单做差集」 ─────────────────────────────
// 2026-09-22 总台追加：判归属一律靠**带内标记**。差集依赖「两次清单格式一致」这种假设，而一次误删
// （一边 `/tmp/x`、一边 `x` ⇒ 判「全不同」⇒ 全被当成自己的）就是这么来的。这里：本次 run 的沙箱由
// `scanSandboxDirectories()` 按令牌里的 id 认；**非本次的一律只报数、不删**。
const readingOf = async () => {
  const rows = await scanSandboxDirectories(TMP);
  // 防「格式假设」那一类错：列出来的必须是**纯目录名**（带路径分隔符说明谁又把两种格式混在一起了）。
  const malformed = rows.filter((row) => row.name.includes('/') || row.name.includes(path.sep));
  return {
    mine: rows.filter((row) => row.mine).map((row) => row.name),
    foreign: rows.filter((row) => !row.mine).map((row) => `${row.name}(令牌=${row.tokenId ?? '无'})`),
    malformed: malformed.map((row) => row.name),
  };
};
// 全机指纹（判据的底气）：开工前 / 收尾各取一次，两边**都**用 realpath 归一化后的**绝对路径**做集合
// （2026-09-23 总台纪律：别再犯「两份清单格式不一致」那个错 —— 所以这里两边同格式，并断言 basename 是纯名字）。
const fingerprint = () => {
  const entries = readdirSync(TMP).filter((name) => name.startsWith(PREFIX)).sort().map((name) => {
    const directory = path.join(TMP, name);
    const base = path.basename(directory);
    assert.ok(!base.includes('/') && !base.includes(path.sep), `名字里出现路径分隔符（格式混用）：${directory}`);
    let real = directory;
    try { real = realpathSync(directory); } catch { real = directory; }
    let token = null;
    try { token = JSON.parse(readFileSync(path.join(directory, RUN_TOKEN_NAME), 'utf8')); } catch { token = null; }
    return { key: real, name, directory, tokenId: typeof token?.id === 'string' ? token.id : null, tokenPid: Number.isInteger(token?.pid) ? token.pid : null };
  });
  return { entries, keys: new Set(entries.map((entry) => entry.key)) };
};

const dirBytes = (dir) => {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) bytes += statSync(full).size;
    }
  }
  return bytes;
};
// 「这条路径正被哪个活进程拿着」。看进程一律经过 `test/harness.mjs` 的 `processTable`（跨平台；
// 本文件里不出现 procfs 字面量，也不自己调 ss —— `test/harness-contract.mjs` 钉的纪律）。
async function liveOwners(dir) {
  const table = await processTable();
  return table.filter((row) => row.state !== 'Z' && (row.commandLine ?? '').includes(dir)).map((row) => row.pid);
}
const ownedByLiveProcess = async (dir) => (await liveOwners(dir)).length > 0;

let checks = 0;
const failures = [];
function check(name, ok, detail) {
  checks += 1;
  if (!ok) failures.push(name);
  process.stdout.write(`${ok ? '✓' : '✗'} ${name} —— ${detail}\n`);
}

// ── 自己这次跑出来的东西：一定收干净（失败路径也一样） ─────────────────────────────────────
// 两条互补的认领口径（2026-09-23 总台第二棒追加）：
//   · **令牌 / 本次 run 清单**管「别人的 vs 我的」——绝不误删别人的；
//   · **自己登记过的精确路径**管「我自己造的这一条」——不管它后来有没有令牌（arm ⑥ 的迟写者会在沙箱被删掉
//     之后把那条路径**再建回来**，那时它没有令牌）；这两条不冲突，收尾两条都跑。
const createdPaths = new Set();
const rememberPath = (...paths) => { for (const p of paths) createdPaths.add(p); };
const activePages = new Set();
const activeWriters = new Set();
const bootTracked = async (options, problems) => {
  const page = await boot(options);
  activePages.add(page);
  rememberPath(page.sandbox, page.profileDir);
  return page;
};
// 按**精确路径**收自己造过的东西（那些路径是本门自己 mkdtemp / mkdir 出来的，不是从清单里推的）。
const removeCreatedPaths = async (problems) => {
  let removed = 0;
  for (const target of createdPaths) {
    if (!existsSync(target)) continue;
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      removed += existsSync(target) ? 0 : 1;
      if (existsSync(target)) problems.push(`收尾兜底（精确路径）：${target} 没能删掉`);
    } catch (error) {
      problems.push(`收尾兜底（精确路径）：rm ${target} 失败：${error.message}`);
    }
  }
  return removed;
};
const closeTracked = async (page, problems) => {
  try { return await page.close(problems); } finally { activePages.delete(page); }
};
const closeAllActivePages = async (problems) => {
  for (const page of [...activePages]) {
    await closeTracked(page, problems).catch((error) => problems.push(`兜底关闭页面 ${page.sandbox}：${error.message}`));
  }
};
// 按运行令牌 / 本次 run 清单扫掉自己的沙箱（**只动 mine**；别人的一个字节都不动）。会**收敛式**扫几遍：
// 被上界判死（abandoned）的那条臂可能还在后台跑，于是它那一份沙箱晚一步才落盘 —— 所以每一遍先按
// **沙箱自己令牌里记的那个 pid**（= 我们 spawn 的浏览器，精确 pid）把它停掉，再删目录；删不干净就歇一下再来。
const sweepOwnSandboxes = async (problems, { passes = 6, pauseMs = 400 } = {}) => {
  let lastRound = null;
  let swept = 0;
  for (let pass = 1; pass <= passes; pass += 1) {
    const mineRows = (await scanSandboxDirectories(TMP)).filter((row) => row.mine);
    lastRound = mineRows.length;
    if (mineRows.length === 0) break;
    for (const row of mineRows) {
      const token = await readRunToken(row.directory).catch(() => null);
      if (token?.pid) {
        // 精确 pid：沙箱自己的运行令牌里写着我们 spawn 的那个浏览器 pid。
        try { process.kill(token.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') problems.push(`收尾兜底：SIGKILL pid ${token.pid} 失败：${error.message}`); }
      }
      const result = await removeOwnedRunDirectory(row.directory).catch((error) => ({ removed: false, reason: error.message }));
      swept += result.removed ? 1 : 0;
      print('  · 兜底收尾', { pass, directory: row.directory, pid: token?.pid ?? null, ...result, 还在: existsSync(row.directory) });
      if (!result.removed || existsSync(row.directory)) problems.push(`收尾兜底：${row.directory} 没能删掉（${result.reason ?? '仍在'}）`);
    }
    if (pass < passes) await sleep(pauseMs);
  }
  const manifest = await dropRunManifestIfClean();
  if (manifest.remaining.length > 0) problems.push(`收尾兜底：本次 run 的清单里还有 ${manifest.remaining.length} 条没能清掉（${manifest.remaining.join(' / ')}）`);
  return { swept, remainingLastPass: lastRound, manifest };
};
// 删自己的沙箱：一律走令牌校验，并把结果记成判据（令牌对不上 ⇒ removed:false ⇒ 这里就红）。
const removeMine = async (dir, label) => {
  if (!existsSync(dir)) { check(`${label}：自己的沙箱已经没了（无需再删）`, true, dir); return { removed: true, reason: 'already-gone' }; }
  const result = await removeOwnedRunDirectory(dir);
  check(`${label}：按**运行令牌 / 本次 run 清单**校验后删掉自己的沙箱`, result.removed === true && !existsSync(dir), JSON.stringify(result));
  return result;
};

// 迟写者（**进程内**、确定性、锚定事件）：一直盯到沙箱**被删掉**（= 观察到 rm 真的发生了），然后才往
// profile 目录里写。为什么不用后台 bash 循环：那会与收尾的复核窗赛跑，而且会活过本次跑影响下一跑。
// 与收尾的 `rm` 擦肩而过（ENOENT）是**预期**的 —— 记一笔继续，绝不往外抛（外抛会变成 unhandled rejection，
// 把整门打成「没有 RESULT 的一行退出」；2026-09-22 实测踩过）。
function lateWriterOnRemoval(sandbox, profileDir, { writes = 1, everyMs = 0, watchMs = 20_000 } = {}) {
  const state = { stop: false, written: 0, races: 0, error: null };
  activeWriters.add(state);
  state.done = (async () => {
    try {
      const deadline = Date.now() + watchMs;
      while (existsSync(sandbox) && !state.stop && Date.now() < deadline) await sleep(2);
      while (!state.stop && state.written < writes) {
        try {
          await mkdir(profileDir, { recursive: true });
          await writeFile(path.join(profileDir, `late-${state.written + 1}`), 'late write\n');
          state.written += 1;
        } catch (error) {
          if (error?.code === 'ENOENT') state.races += 1;
          else { state.error = error; break; }
        }
        if (everyMs > 0) await sleep(everyMs);
      }
    } catch (error) {
      state.error = error;
    } finally {
      activeWriters.delete(state);
    }
    return state;
  })();
  return state;
}
const stopAllWriters = () => { for (const state of activeWriters) state.stop = true; };

// 每条臂一条上界：到点**抛一条带臂名与现场的错**（`runArms` 会把它记成红），而不是挂住。
const pendingTasks = new Set();
const withDeadline = (label, ms, run) => {
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve({ __deadline: true, label, ms }), ms); });
  const body = run();
  // 登记在案：上界判死之后这条 promise **还在后台跑**（Promise 取消不了）⇒ 收尾必须等它落地、
  // 落地之后再扫一遍，否则它晚一步落下的沙箱就会留在盘上（2026-09-23 实测踩过）。
  pendingTasks.add(body);
  const settle = () => pendingTasks.delete(body);
  body.then(settle, settle);
  return Promise.race([body, limit]).then((value) => {
    clearTimeout(timer);
    if (value?.__deadline) throw new Error(`${label}：超过臂上界 ${ms} ms（现场 ${JSON.stringify(scene)}）`);
    return value;
  }, (error) => { clearTimeout(timer); throw error; });
};
// 等后台残党落地（有界）：能落地的就先让它们自己收，收不掉的由下面的兜底按令牌/清单扫。
const waitPendingSettle = async (ms) => {
  if (pendingTasks.size === 0) return true;
  await Promise.race([Promise.allSettled([...pendingTasks]), sleep(ms)]);
  return pendingTasks.size === 0;
};

let primaryError = null;
const problems = [];
let watchdog = null;
let startedFingerprint = { entries: [], keys: new Set() };

// 全局上界：到点打印现场 → 收干净自己的东西 → 明确判红 → 退出。`unref()` 让它不拖住正常结束的进程。
watchdog = setTimeout(async () => {
  const message = `全局上界 ${GLOBAL_DEADLINE_MS} ms 到点，现场：${JSON.stringify(scene)}`;
  process.stderr.write(`[ui-sandbox-cleanup] ${message}\n`);
  problems.push(message);
  stopAllWriters();
  await waitPendingSettle(5_000).catch(() => {});
  await closeAllActivePages(problems).catch(() => {});
  await sweepOwnSandboxes(problems).catch(() => {});
  process.stdout.write(`RESULT: ui-sandbox-cleanup FAIL (${checks} checks); 失败的判据=${JSON.stringify(failures)}; problems=${JSON.stringify(problems)}\n`);
  process.exit(1);
}, GLOBAL_DEADLINE_MS);
watchdog.unref?.();

try {
  // ── ① N 轮真起停：每轮残留增量必须 0 ────────────────────────────────────────────────
  const perRound = [];
  const deltas = [];
  let roundFailures = 0;
  startedFingerprint = fingerprint();
  print('① 开工前的全机读数（别人的/历史的，只报数、一个字节都不动）', (await readingOf()).foreign);
  print('① 开工前全机指纹（归一化绝对路径）', { 沙箱数: startedFingerprint.entries.length, 名字: startedFingerprint.entries.map((entry) => entry.name) });
  for (let round = 1; round <= rounds; round += 1) {
    setScene(`① 第 ${round}/${rounds} 轮`);
    let page = null;
    let bootError = null;
    for (let attempt = 1; attempt <= 2 && page === null; attempt += 1) {
      // 起停本身也带上界；万一它被上界判死（boot 还没回来），把那条**尚未落地的** boot 挂上收尾钩子：
      // 它一旦返回就按精确 pid 关掉 —— 失败路径同样不许留下自己的浏览器/沙箱。
      const pending = bootTracked({ routes: async () => false }, problems);
      try {
        page = await withDeadline(`① 第 ${round} 轮 boot`, DEADLINES.round, () => pending);
      } catch (error) {
        bootError = String(error?.message ?? error).slice(0, 200);
        if (attempt === 1) print(`  · 第 ${round} 轮：boot 失败，重试一次（如实记账）`, bootError);
        await Promise.race([pending.then((late) => closeTracked(late, problems)).catch(() => {}), sleep(3000)]);
        await sweepOwnSandboxes(problems).catch(() => {});
      }
    }
    if (page === null) {
      roundFailures += 1;
      perRound.push({ round, bootError });
      deltas.push(-1);
      print(`  · 第 ${round} 轮：boot 两次都没起来（环境问题，如实记账，继续）`, bootError);
      continue;
    }
    // 干一点活，让浏览器真的写点 profile（缓存/落盘），别拿一个空壳当夹具。
    // 「干活 + 收尾」整段包住且带上界：中途失败（浏览器被谁杀了、收尾抛了、CDP 不回话）都如实记在
    // 那一轮里并继续，绝不让整门半路死掉、也只留一行「0 checks」。
    let facts = null;
    const t0 = Date.now();
    try {
      await withDeadline(`① 第 ${round} 轮 干活`, DEADLINES.round, async () => {
        await page.evaluate('document.title = "cleanup-gate"');
        await page.evaluate('new Promise((resolve)=>{const s=Date.now();let n=0;while(Date.now()-s<60){n+=Math.random()*Math.random()}resolve(n)})');
      });
      const closing = closeTracked(page, problems);
      try {
        facts = await withDeadline(`① 第 ${round} 轮 close`, DEADLINES.round, () => closing);
      } catch (error) {
        // close 被上界判死：同样挂钩子，等它落地就按精确 pid 收（有界）。
        await Promise.race([closing.catch(() => {}), sleep(3000)]);
        throw error;
      }
    } catch (error) {
      roundFailures += 1;
      perRound.push({ round, roundError: String(error?.message ?? error).slice(0, 200) });
      deltas.push(-1);
      print(`  · 第 ${round} 轮：干活/收尾中途失败（如实记账，继续）`, String(error?.message ?? error).slice(0, 200));
      await closeTracked(page, problems).catch(() => {});
      continue;
    }
    const closeMs = Date.now() - t0;
    const after = await readingOf();
    const mineLeft = after.mine;
    const borrowed = [];
    for (const name of after.foreign) {
      const bare = name.replace(/\(令牌=.*\)$/, '');
      if (await ownedByLiveProcess(path.join(TMP, bare))) borrowed.push(name);
    }
    const reading = {
      round, closeMs, mineGone: !existsSync(page.sandbox), ok: facts.ok, survivors: facts.survivors.length,
      removed: facts.removed, reappeared: facts.reappeared,
      mineLeft: mineLeft.length, otherSandboxes: after.foreign.length, otherAlive: borrowed.length,
    };
    perRound.push(reading);
    deltas.push(mineLeft.length);
    print(`  · 第 ${round} 轮残留增量`, reading);
    if (after.foreign.length > 0) print(`  · 第 ${round} 轮：tmp 里还有**别人的/历史的**沙箱（只报数、一个字节都不动）`, after.foreign);
    if (after.malformed.length > 0) print(`  · 第 ${round} 轮：⚠️ 出现了带路径分隔符的名字（格式混用就是那次误删的根）`, after.malformed);
    if (mineLeft.length > 0) print(`  · 第 ${round} 轮：本次 run 的沙箱没收干净（= 残留）`, mineLeft.map((name) => `${name} ${dirBytes(path.join(TMP, name))}B`));
    if (!reading.mineGone || !facts.ok || facts.survivors.length > 0 || mineLeft.length > 0 || after.malformed.length > 0 || facts.removed < 1 || facts.reappeared > 0) roundFailures += 1;
  }
  print('① N 轮读数', { rounds, 每轮增量: deltas, 最大: Math.max(...deltas), 有问题的轮: roundFailures });
  check(`① 连跑 ${rounds} 轮真起停：每轮残留增量 0（本次 run 自己那个目录 + 按令牌认的集合差）`, roundFailures === 0, JSON.stringify(deltas));
  check('① 每轮 close() 自报 ok、survivors 空、removed ≥ 1、reappeared 0',
    perRound.filter((row) => !row.bootError && !row.roundError).every((row) => row.ok === true && row.survivors === 0 && row.removed >= 1 && row.reappeared === 0),
    JSON.stringify(perRound.map((row) => ({ ok: row.ok, survivors: row.survivors, removed: row.removed, reappeared: row.reappeared, bootError: row.bootError ?? null, roundError: row.roundError ?? null }))));

  // ── ② 端到端：一个今天从不删沙箱的真门 ──────────────────────────────────────────────
  setScene('② 子门 tui-tool-diff');
  const gate = 'tui-tool-diff';
  let gatePid = null;
  let gateExit = null;
  let gateChild = null;
  try {
    gateChild = spawn(process.execPath, [path.join(ROOT, 'test', `${gate}.mjs`)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
    gatePid = gateChild.pid;
    const child = gateChild;
    gateExit = await withDeadline(`② 子门 ${gate}`, DEADLINES.childGate, () => new Promise((resolve) => child.once('exit', (code) => resolve(code))));
  } catch (error) {
    print(`② 子门 ${gate} 没在臂上界内正常结束（按精确 pid 收掉，如实记账）`, String(error?.message ?? error).slice(0, 200));
    if (gatePid) { try { process.kill(gatePid, 'SIGKILL'); } catch {} }
  }
  await sleep(300);
  // 那道子门是**另一个 run**（自己的令牌、自己的 pid）⇒ 它的沙箱用「令牌里的 pid == 子门 pid」认
  // （带内标记，不是清单做差集）。它的残留本门**不替它删**。
  const rows = await scanSandboxDirectories(TMP);
  const gateLeftovers = rows.filter((row) => row.tokenPid === gatePid);
  const mineLeft = rows.filter((row) => row.mine);
  const gateReading = { exit: gateExit, 子门自己的沙箱残留: gateLeftovers.map((row) => row.name), 本门自己的: mineLeft.map((row) => row.name), 'tmp 里别人的': rows.filter((row) => !row.mine && row.tokenPid !== gatePid).length };
  print(`② ${gate} 跑完`, gateReading);
  check(`② 从不删沙箱的真门（${gate} pid ${gatePid}，它自己那条红与本门无关）跑完：它自己的沙箱残留 0（本门也不动别人的）`,
    gateLeftovers.length === 0 && mineLeft.length === 0, JSON.stringify(gateReading));
  if (gateLeftovers.length > 0) print('   ⚠️ ② 子门留下残留 —— 本门**不替它删**（红线：别人/别的门的残留不归本门动）', gateReading.子门自己的沙箱残留);

  // ── ③④⑤⑥⑦ 反证 / 边界臂（每条带自己的上界） ────────────────────────────────────────
  const { failed } = await runArms([
    ['③ 反证（撤掉「等退出」⇒ 先删后等）必须留下残留', () => withDeadline('③', DEADLINES.mutant, async () => {
      setScene('③ nowait 反证');
      process.env.SOPHO_UI_SETTLE = 'nowait';
      let page;
      try { page = await bootTracked({ routes: async () => false }, problems); } finally { delete process.env.SOPHO_UI_SETTLE; }
      try {
        await page.evaluate('document.title = "nowait"');
        const facts = await closeTracked(page, problems);
        const sandbox = page.sandbox;
        const leftover = existsSync(sandbox);
        const bytes = leftover ? dirBytes(sandbox) : 0;
        const files = leftover ? readdirSync(path.join(sandbox, 'chromium', 'Default')).slice(0, 4) : [];
        print('  ③ 现场', { leftover, bytes, treeWaitMs: facts.treeWaitMs, 残留前四项: files });
        await removeMine(sandbox, '③ 反证跑完');
        check('③ 反证：先删后等 ⇒ 目录**又被建回来**（所以「残留增量」这个读数不是恒 0 的死读数）', leftover, `${sandbox} leftover=${leftover} ${bytes}B`);
        assert.ok(leftover, '撤掉「等退出」之后竟然没有残留 —— 本门的判定力就是假的');
        return { leftover, bytes };
      } finally { await closeTracked(page, problems).catch(() => {}); }
    })],
    ['④ 反证（今天的形状：只停主进程、不删不核）必须整棵留着', () => withDeadline('④', DEADLINES.mutant, async () => {
      setScene('④ off 反证');
      process.env.SOPHO_UI_SETTLE = 'off';
      let page;
      try { page = await bootTracked({ routes: async () => false }, problems); } finally { delete process.env.SOPHO_UI_SETTLE; }
      try {
        await page.evaluate('document.title = "off"');
        const facts = await closeTracked(page, problems);
        const sandbox = page.sandbox;
        const whole = existsSync(sandbox);
        const bytes = whole ? dirBytes(sandbox) : 0;
        print('  ④ 现场', { whole, bytes, removed: facts.removed, notes: facts.notes });
        await removeMine(sandbox, '④ 反证跑完');
        assert.ok(whole, 'off（今天的形状）竟然没留下沙箱 —— 这条反证臂没量到东西');
        return { whole, bytes, removed: facts.removed };
      } finally { await closeTracked(page, problems).catch(() => {}); }
    })],
    ['⑤ 上界臂：忽略 SIGTERM 的自有进程 ⇒ 到点按精确 pid 升级 SIGKILL，不许静默挂住', () => withDeadline('⑤', DEADLINES.mutant, async () => {
      setScene('⑤ 上界臂');
      // ⚠️ 收尾的上界是 `boot()` 时读的 ⇒ 环境变量必须在 `boot()` **之前**设。
      process.env.SOPHO_UI_SETTLE_TREE_MS = '400';
      process.env.SOPHO_UI_SETTLE_KILL_MS = '4000';
      let page;
      try { page = await bootTracked({ routes: async () => false }, problems); } finally { delete process.env.SOPHO_UI_SETTLE_TREE_MS; delete process.env.SOPHO_UI_SETTLE_KILL_MS; }
      // 替身：命令行里带本沙箱的 profile 目录（⇒ 按「自己的 profile 目录」认领得到），并且忽略 SIGTERM。
      const plant = spawn('bash', ['-c', 'trap "" TERM; while :; do sleep 0.2; done', page.profileDir], { stdio: 'ignore' });
      await sleep(150);
      try {
        const t0 = Date.now();
        const facts = await closeTracked(page, problems);
        const elapsed = Date.now() - t0;
        const plantGone = !await processAlive(plant.pid);
        print('  ⑤ 现场', { treeWaitMs: facts.treeWaitMs, sigkilled: facts.sigkilled, survivors: facts.survivors, elapsed, 替身已死: plantGone });
        check('⑤ 上界到了按精确 pid 升级 SIGKILL（替身 pid 出现在 sigkilled 里）', facts.sigkilled.includes(plant.pid), JSON.stringify({ sigkilled: facts.sigkilled, plant: plant.pid }));
        check('⑤ 真的等满了上界才升级（treeWaitMs ≥ 400 ms）', facts.treeWaitMs >= 400, `treeWaitMs=${facts.treeWaitMs}`);
        check('⑤ 整段有上界、没有静默挂住（400 + 4000 + 收尾 < 5 s）', elapsed < 5000, `${elapsed} ms`);
        check('⑤ 升级之后收尾仍然干净（survivors 空 + 沙箱没了）',
          facts.survivors.length === 0 && !existsSync(page.sandbox), JSON.stringify({ survivors: facts.survivors, sandboxGone: !existsSync(page.sandbox) }));
        assert.ok(facts.sigkilled.includes(plant.pid), '没有升级 SIGKILL —— 上界这条路没生效');
        return { sigkilled: facts.sigkilled, treeWaitMs: facts.treeWaitMs, elapsed };
      } finally {
        // 替身无论走到哪一步都必须按**精确 pid** 收掉（正常路径里收尾已经 SIGKILL 过它，这里兜一遍）。
        try { process.kill(plant.pid, 'SIGKILL'); } catch {}
        await closeTracked(page, problems).catch(() => {});
      }
    })],
    ['⑥ 「删完再核」承重（只断言确定性那一半）', () => withDeadline('⑥', DEADLINES.lateWriter, async () => {
      // 迟写者锚定的是**事件**（沙箱被删掉）不是时间；两个臂的复核窗都用环境变量放宽/收紧，
      // 让「看得见」与「擦不掉」两件事各自确定；**擦干净与否只当读数打印**，断言只钉确定性那一半。
      // (a) 撤掉复核（noverify）：rm 之后迟写者写回来的东西没人再删 ⇒ 残留 ≥ 1（确定性）。
      setScene('⑥a noverify');
      process.env.SOPHO_UI_SETTLE = 'noverify';
      let noVerify;
      try { noVerify = await bootTracked({ routes: async () => false }, problems); } finally { delete process.env.SOPHO_UI_SETTLE; }
      let factsA; let leftoverA; let bytesA; let writerA;
      try {
        writerA = lateWriterOnRemoval(noVerify.sandbox, noVerify.profileDir, { writes: 1 });
        factsA = await closeTracked(noVerify, problems);
        await writerA.done;
        leftoverA = existsSync(noVerify.sandbox);
        bytesA = leftoverA ? dirBytes(noVerify.sandbox) : 0;
        print('  ⑥a 撤掉复核（noverify）', { leftover: leftoverA, bytes: bytesA, 迟写者写了: writerA.written, 擦肩: writerA.races, 写者错误: writerA.error?.message ?? null, reappeared: factsA.reappeared });
        await removeMine(noVerify.sandbox, '⑥a 反证跑完');
      } finally { await closeTracked(noVerify, problems).catch(() => {}); }
      // (b) 默认收尾：复核窗放宽到 1.5 s / 8 s（写者只写一笔）⇒ 复核必须**看见**它（确定性断言）；
      //     擦干净与否是读数（本机每次都是擦干净的，见打印），另钉一条不变量：ok === false ⟺ problems 非空。
      setScene('⑥b settle 看见迟写者');
      process.env.SOPHO_UI_RECHECK_QUIET_MS = '1500';
      process.env.SOPHO_UI_RECHECK_MS = '8000';
      let strict;
      try { strict = await bootTracked({ routes: async () => false }, problems); } finally { delete process.env.SOPHO_UI_RECHECK_QUIET_MS; delete process.env.SOPHO_UI_RECHECK_MS; }
      let factsB; let leftoverB; let writerB;
      try {
        writerB = lateWriterOnRemoval(strict.sandbox, strict.profileDir, { writes: 1 });
        factsB = await closeTracked(strict, problems);
        await writerB.done;
        leftoverB = existsSync(strict.sandbox);
        print('  ⑥b 默认收尾（settle）', { leftover: leftoverB, reappeared: factsB.reappeared, removed: factsB.removed, ok: factsB.ok, 迟写者写了: writerB.written, 擦肩: writerB.races, 写者错误: writerB.error?.message ?? null });
        await removeMine(strict.sandbox, '⑥b 跑完');
      } finally { await closeTracked(strict, problems).catch(() => {}); }
      // (c) 一个**不罢休**的迟写者（每 25 ms 一笔、写到 3 s）：复核窗收紧（200/800 ms）—— 断言**有界返回**
      //     + 记账不变量；擦不擦得掉是读数（两种结果都合法：擦掉了 ⇒ 干净；擦不掉 ⇒ 必须如实记账）。
      setScene('⑥c 不罢休的迟写者');
      process.env.SOPHO_UI_RECHECK_QUIET_MS = '200';
      process.env.SOPHO_UI_RECHECK_MS = '800';
      let stubborn;
      try { stubborn = await bootTracked({ routes: async () => false }, problems); } finally { delete process.env.SOPHO_UI_RECHECK_QUIET_MS; delete process.env.SOPHO_UI_RECHECK_MS; }
      let factsC; let elapsedC; let writerC;
      try {
        writerC = lateWriterOnRemoval(stubborn.sandbox, stubborn.profileDir, { writes: 120, everyMs: 25 });
        const ownProblems = [];
        const tC0 = Date.now();
        factsC = await closeTracked(stubborn, ownProblems);
        elapsedC = Date.now() - tC0;
        writerC.stop = true;
        await writerC.done;
        print('  ⑥c 不罢休的迟写者', { elapsedC, ok: factsC.ok, problems: factsC.problems, 门拿到的: ownProblems.length, reappeared: factsC.reappeared, removed: factsC.removed, 迟写者写了: writerC.written, 擦肩: writerC.races, 写者错误: writerC.error?.message ?? null });
        await removeMine(stubborn.sandbox, '⑥c 跑完');
        check('⑥c 记账不变量：`cleanup.ok === false` ⟺ `cleanup.problems` 非空 ⟺ 门拿到的 problems 非空',
          (factsC.ok === false) === (factsC.problems.length > 0) && (factsC.problems.length > 0) === (ownProblems.length > 0),
          JSON.stringify({ ok: factsC.ok, problems: factsC.problems.slice(0, 1), 门拿到: ownProblems.length }));
        check('⑥c 有界返回、没有静默挂住（复核上界 800 ms，整段 < 8 s）', elapsedC < 8000, `${elapsedC} ms`);
      } finally { writerC && (writerC.stop = true); await closeTracked(stubborn, problems).catch(() => {}); }
      check('⑥ 撤掉「删完再核」（noverify）⇒ 迟写者的那几笔留在盘上（确定性：先删后写，没人再删）', leftoverA, `${bytesA} B`);
      check('⑥ 默认收尾的复核**看见了**迟写者（确定性：锚定事件 ⇒ reappeared ≥ 1；擦干净与否见上面的读数）',
        factsB.reappeared >= 1, JSON.stringify({ reappeared: factsB.reappeared, leftover: leftoverB, ok: factsB.ok, removed: factsB.removed }));
      check('⑥ 三个迟写者自己都没出错（ENOENT 擦肩记在 races 里，不算错）',
        [writerA, writerB, writerC].every((state) => state.error === null), JSON.stringify([writerA.error?.message ?? null, writerB.error?.message ?? null, writerC.error?.message ?? null]));
      assert.ok(leftoverA, '撤掉复核竟然没留下残留 —— 这条反证臂没量到东西');
      assert.ok(factsB.reappeared >= 1, '默认收尾的复核没看见迟写者 —— 「删完再核」没生效');
      assert.ok([writerA, writerB, writerC].every((state) => state.error === null), '迟写者自己出错了（不该）');
      return {
        noVerify: { leftover: leftoverA, bytes: bytesA },
        settle: { reappeared: factsB.reappeared, leftover: leftoverB, ok: factsB.ok, removed: factsB.removed },
        stubborn: { elapsedC, reappeared: factsC.reappeared, ok: factsC.ok, problems: factsC.problems.length },
      };
    })],
    ['⑦ 机械保证：只许删「本次 run 令牌匹配」的目录（别人的/没令牌的一个字节都不动）', () => withDeadline('⑦', DEADLINES.mutant, async () => {
      setScene('⑦ 令牌拒绝');
      // 这两条**是本臂自己造的**：一个「别的 run 的令牌」，一个「既没令牌也不在本次清单里」。造完/核完都按精确路径收拾掉。
      const foreign = await mkdtemp(path.join(TMP, PREFIX));
      const noTokenPath = path.join(TMP, `${PREFIX}${Math.random().toString(36).slice(2, 8)}`);
      rememberPath(foreign, noTokenPath);
      await writeFile(path.join(foreign, RUN_TOKEN_NAME), `${JSON.stringify({ id: 'some-other-run-20260921', pid: 1, startedAt: '2026-09-21T00:00:00.000Z' }, null, 2)}\n`);
      const noToken = await mkdtemp(path.join(TMP, PREFIX));
      rememberPath(noToken);
      try {
        const refusedForeign = await removeOwnedRunDirectory(foreign);
        const refusedNoToken = await removeOwnedRunDirectory(noToken);
        print('  ⑦ 现场', { refusedForeign, refusedNoToken, 两个都还在: [existsSync(foreign), existsSync(noToken)] });
        check('⑦ 令牌 id 不是本次 run ⇒ **拒绝删除**、目录原样还在', refusedForeign.removed === false && existsSync(foreign), JSON.stringify(refusedForeign));
        check('⑦ 既没令牌、也不在本次 run 的清单里 ⇒ **拒绝删除**、目录原样还在', refusedNoToken.removed === false && existsSync(noToken), JSON.stringify(refusedNoToken));
        const rows = await scanSandboxDirectories(TMP);
        const seen = rows.filter((row) => row.directory === foreign || row.directory === noToken);
        check('⑦ 只读盘点按令牌分类：这两个都必须是「非本次 run」（mine=false）', seen.length === 2 && seen.every((row) => row.mine === false), JSON.stringify(seen.map((row) => ({ name: row.name, mine: row.mine, tokenId: row.tokenId }))));
        assert.ok(refusedForeign.removed === false && refusedNoToken.removed === false && seen.every((row) => row.mine === false), '令牌校验没拦住 —— 这条机械保证是假的');
        return { refusedForeign, refusedNoToken };
      } finally {
        // 本臂自己造的两个（精确路径）自己收。收尾走 harness 的 `cleanupStep`（收集问题、不替换原始错误）。
        await cleanupStep(problems, '⑦ 收自己的两个替身', () => rm(foreign, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
        await cleanupStep(problems, '⑦ 收自己的两个替身', () => rm(noToken, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
        assert.ok(!existsSync(foreign) && !existsSync(noToken), '⑦ 自己造的两个替身没收拾干净');
      }
    })],
  ], { title: 'ui-sandbox-cleanup 反证/边界臂' });
  for (const item of failed) problems.push(`arm ${item.name}: ${item.error.message}`);
} catch (error) {
  primaryError = error;
} finally {
  setScene('收尾');
  // 兜底：**本门自己这次 run 创造的东西**一条都不许留给下一个人（上面哪条臂/哪一轮中途抛了、超时了也一样）：
  // ① 停掉所有进程内迟写者；② 关掉所有还挂着的页面（按精确 pid）；③ 按令牌/清单扫掉自己的沙箱；
  // ④ 清单清空了就删掉清单文件。非 `mine` 的一律不碰（只报数）。
  try {
    stopAllWriters();
    // 被上界判死的那几条臂还在后台跑：先给它们一个有界的落地窗口（它们自己的 finally 会收页面），
    // 再关所有还挂着的页面、再按令牌/清单收敛式扫自己的沙箱。停不下来的**如实记账**，不假装干净。
    const settled = await waitPendingSettle(Number(process.env.SOPHO_UI_GATE_SETTLE_GRACE_MS ?? 15_000));
    if (!settled) problems.push(`收尾兜底：还有 ${pendingTasks.size} 条被判死的任务没在上界内落地（现场 ${JSON.stringify(scene)}）`);
    await closeAllActivePages(problems);
    // 两条互补口径都跑：先按**精确路径**收自己造过的（有没有令牌都收），再按令牌/清单收敛式扫。
    const byPath = await removeCreatedPaths(problems);
    const swept = await sweepOwnSandboxes(problems);
    print('  · 收尾兜底读数', { 后台残党已落地: settled, 按精确路径删掉: byPath, 删掉几个: swept.swept, 最后一遍还剩: swept.remainingLastPass, 清单: swept.manifest });
  } catch (error) {
    problems.push(`收尾兜底抛了：${error.message}`);
  }
  clearTimeout(watchdog);
  try {
    finishCleanup(primaryError, problems);
  } catch (error) {
    primaryError = error;
  }
}

// ── ⑧⑨ 收尾后的**全机**读数（判据的底气：不能只由「自己那套认领口径」支撑） ────────────────
// 两边同格式（realpath 归一化后的绝对路径）⇒ 集合差；分类如实：
//   · 本次 run 的（令牌/清单命中）⇒ **本门自己的漏**，必须红；
//   · 别人的、且**那个 run 还活着** ⇒ 并行实例，如实报出来，不是本门的红；
//   · 别人的、**owner 已经死了** ⇒ **只记录**（2026-09-25 修）。
//
// ⚠️ 为什么第三类不再判红：那一条断的是**本门没有所有权**的状态 —— 别的会话/别的门在这个窗口里
//   起一个 `sopho-ui-*` 沙箱、然后它的进程被 SIGKILL/超时干掉，本门就会红在一个它从没建过、也从没删过的
//   目录上（而且「owner 死了」这半个判据本身不可靠：token 里的 pid 会被系统回收，别人的残留会因此被当成
//   “并行实例”放过；反过来一个刚正常结束的并行实例又会被当成“死了”）。全机残留是 `bin/sandbox-sweep.mjs`
//   那类工具的活；本门该自证的只有「**本门名下**的沙箱一个不剩」。
//   「认领口径会不会骗自己」那一半已由 ⑦ 机械证过（令牌 id 不是本轮的、以及既无令牌也不在本轮清单里的，
//   都必须 `mine=false` 且拒绝删除）⇒ 这里不再需要拿别人的残留当 backstop。
try {
  const endedFingerprint = fingerprint();
  const added = endedFingerprint.entries.filter((entry) => !startedFingerprint.keys.has(entry.key));
  const mineAdded = added.filter((entry) => entry.tokenId === RUN_ID || (entry.tokenId === null && createdPaths.has(entry.directory)));
  const foreignAdded = added.filter((entry) => !mineAdded.includes(entry));
  const concurrent = [];
  const dead = [];
  for (const entry of foreignAdded) {
    if (entry.tokenPid !== null && await processAlive(entry.tokenPid)) concurrent.push(`${entry.name}(令牌=${entry.tokenId})`);
    else dead.push(`${entry.name}(令牌=${entry.tokenId ?? '无'})`);
  }
  const manifestLeft = readdirSync(TMP).filter((name) => name.startsWith(`.sopho-ui-run-${RUN_ID}`));
  print('⑧ 收尾后的全机读数', {
    开工前沙箱数: startedFingerprint.entries.length, 收尾后沙箱数: endedFingerprint.entries.length,
    全机增量: added.map((entry) => entry.name), 本门自己的: mineAdded.map((entry) => entry.name),
    '并行实例在跑的': concurrent, 'owner 已死的（别人的，只记录）': dead, '本门清单文件残留': manifestLeft,
  });
  check('⑧ **本门名下**的残留增量 0（别人的沙箱一律不判红：并行实例在跑的不算，owner 已死的只如实列出归属）',
    mineAdded.length === 0, JSON.stringify({ mineAdded: mineAdded.map((entry) => entry.name), concurrent, dead }));
  if (dead.length > 0) {
    print('⑧ 记录（不断言）：全机里还有「owner 已死」的**别人**的沙箱 —— 那不是本门的漏', {
      目录: dead,
      归属: '别人的：它们不是本门建的（令牌 id ≠ 本轮 run），本门对它们没有所有权、也一个字节都不动；全机残留归 bin/sandbox-sweep.mjs 那类工具去报',
    });
  }
  check('⑨ 本门自己的清单文件增量 0（收尾已清算）', manifestLeft.length === 0, JSON.stringify(manifestLeft));
} catch (error) {
  problems.push(`⑧⑨ 全机读数抛了：${error.message}`);
}

const ok = primaryError === null && failures.length === 0 && problems.length === 0;
process.stdout.write(`RESULT: ui-sandbox-cleanup ${ok ? 'PASS' : 'FAIL'} (${checks} checks)` +
  `${failures.length ? `; 失败的判据=${JSON.stringify(failures)}` : ''}${problems.length ? `; problems=${JSON.stringify(problems)}` : ''}` +
  `; 耗时=${Math.round((Date.now() - startedWall) / 1000)}s / 全局上界 ${Math.round(GLOBAL_DEADLINE_MS / 1000)}s\n`);
if (!ok) process.exitCode = 1;
