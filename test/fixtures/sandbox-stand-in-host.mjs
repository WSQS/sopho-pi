#!/usr/bin/env node
// 测试替身：沙箱进程树的根（形状与 `server/base.mjs` 相同 —— 长期存活，并 fork 一个子进程）。
//
// 为什么要有替身：`bin/sandbox-sweep.mjs` 的判据只看「cmdline 里的 argv 是 <...>/server/
// base.mjs 或 worker.mjs」。用真 base.mjs 验完整链路（见 test/sandbox-hygiene.mjs 的
// real-host 那一臂），用这个替身做**快而确定**的臂（寿命上限、被删掉的 worktree 形状）。
// 替身不做任何真事：起一个子进程，写一份 facts，然后睡到被杀。
//
// 环境变量：
//   SANDBOX_STAND_IN_CHILD   必填，子进程脚本的绝对路径（模拟 base fork worker）
//   SANDBOX_STAND_IN_FACTS   可选，写下 { pid, childPid } 的 JSON 路径
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const childEntry = process.env.SANDBOX_STAND_IN_CHILD;
if (!childEntry) throw new Error('SANDBOX_STAND_IN_CHILD is required');

const child = spawn(process.execPath, [childEntry], { stdio: ['ignore', 'inherit', 'inherit'] });
process.stdout.write(`${JSON.stringify({ event: 'stand-in-host', pid: process.pid, childPid: child.pid, self: fileURLToPath(import.meta.url), cwd: path.resolve('.') })}\n`);
if (process.env.SANDBOX_STAND_IN_FACTS) {
  await writeFile(process.env.SANDBOX_STAND_IN_FACTS, `${JSON.stringify({ hostPid: process.pid, childPid: child.pid }, null, 2)}\n`);
}
process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch {} process.exit(0); });
setInterval(() => {}, 1000);
