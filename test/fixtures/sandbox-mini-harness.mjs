#!/usr/bin/env node
// 测试替身：一个"最小 harness"，模仿 `test/runtime-isolation.mjs` 的 startHost()。
//
// 存在的意义：`test/sandbox-hygiene.mjs` 要造出「**harness 被 SIGKILL**」这个场景，而
// SIGKILL 掉的必须是"harness 那条进程"，不是测试自己。所以把 harness 摘出来当子进程，
// 由观察者（gate）SIGKILL 它。
//
// 两种模式，正好是被修与没被修的两臂：
//   --mode legacy  完全照旧：把 entry 当普通子进程起（`stdio:['ignore', logfd, logfd]`，
//                  没有 IPC、没有父进程监视、没有寿命上限）。这就是出事故的那种起法。
//   --mode guard   经由 `test/sandbox-guard.mjs` 起：stdin 是管道 + IPC 通道 + 寿命上限。
//                  守卫以 detached 起 —— 这样即使 harness 被 SIGKILL，守卫也还活着，
//                  能真的执行"同生共死"（Windows 上不 detached 会被 libuv 的 job 一起带走，
//                  那样这条臂就测不到守卫自己的逻辑了）。
//
// 起完之后写下 facts JSON（{ harnessPid, sandboxPid, guardPid, mode, entry }）然后一直睡，
// 等观察者把它 SIGKILL 掉。
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const options = { mode: 'legacy', entry: null, facts: null, log: null, guard: null, label: 'mini', lifetimeMs: null, cwd: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[index];
    };
    if (arg === '--mode') options.mode = take();
    else if (arg === '--entry') options.entry = take();
    else if (arg === '--facts') options.facts = take();
    else if (arg === '--log') options.log = take();
    else if (arg === '--guard') options.guard = take();
    else if (arg === '--label') options.label = take();
    else if (arg === '--lifetime-ms') options.lifetimeMs = take();
    else if (arg === '--cwd') options.cwd = take();
    else throw new Error(`unknown option ${arg}`);
  }
  if (!options.entry) throw new Error('--entry is required');
  if (!options.facts) throw new Error('--facts is required');
  if (!options.log) throw new Error('--log is required');
  if (options.mode === 'guard' && !options.guard) throw new Error('--mode guard needs --guard');
  return options;
}

const options = parseArgs(process.argv.slice(2));
await mkdir(path.dirname(options.facts), { recursive: true });
await mkdir(path.dirname(options.log), { recursive: true });
// A raw fd, not a `FileHandle`: a FileHandle that stops being referenced gets closed by
// the GC, and node >= 24 treats "closed during garbage collection" as a fatal error. That
// killed this fixture mid-run and (on Windows) took the whole job down with it.
const logFd = openSync(options.log, 'a');
process.on('exit', () => { try { closeSync(logFd); } catch {} });

let sandboxPid;
let guardPid = null;
if (options.mode === 'legacy') {
  // The pre-fix launch style, on purpose: a plain child, no guard, no parent watch. This
  // is the arm that reproduces the orphan on POSIX.
  const child = spawn(process.execPath, [options.entry], { cwd: options.cwd, env: process.env, stdio: ['ignore', logFd, logFd] });
  sandboxPid = child.pid;
} else {
  const guardArgs = [
    options.guard,
    '--entry', options.entry,
    '--label', options.label,
    '--watch-stdin',
    '--record', `${options.facts}.guard.json`,
  ];
  if (options.lifetimeMs) guardArgs.push('--lifetime-ms', options.lifetimeMs);
  // detached on purpose: the guard must OUTLIVE this harness so it can honour "same-life".
  // Without it, Windows' libuv job object would kill the guard the instant the harness dies
  // and this arm would only be testing the OS, not the guard.
  const guard = spawn(process.execPath, guardArgs, { cwd: options.cwd, env: process.env, stdio: ['pipe', logFd, logFd, 'ipc'], detached: true });
  guardPid = guard.pid;
  sandboxPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('guard never reported sandbox-start')), 20_000);
    guard.on('message', (message) => {
      if (message?.type === 'sandbox-start') {
        clearTimeout(timer);
        resolve(message.pid);
      }
    });
    guard.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`guard exited before sandbox-start (code=${code} signal=${signal})`));
    });
  });
}

await writeFile(options.facts, `${JSON.stringify({ harnessPid: process.pid, mode: options.mode, entry: options.entry, sandboxPid, guardPid, log: options.log }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ event: 'mini-harness-ready', harnessPid: process.pid, sandboxPid, guardPid, mode: options.mode })}\n`);
setInterval(() => {}, 1000);
