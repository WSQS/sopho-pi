#!/usr/bin/env node
// 测试替身：一棵浏览器树（形状与真 chromium 树相同 —— 一个根 + 一个把**同一个 profile 路径**
// 也写在命令行里的子进程，并长期存活）。
//
// 为什么需要它：`bin/sandbox-sweep.mjs` 的第二类候选（浏览器树）**只能按沙箱标记认**
// （命令行里的 `--user-data-dir=<本机临时目录>/…`），而真 chromium 又慢又重。这个替身让
// 「带标记 ⇒ 认出」「不带标记但含 headless/chromium 字样 ⇒ 认不出」两臂都能**受控且确定**
// 地跑出来：标记与进程名完全解耦，所以只要判别逻辑有一处按名字匹配，红绿两边就有一边会错。
//
// 用法（观察者脚本里）：
//   const child = spawn(process.execPath, [
//     standInBrowser, '--headless=new',
//     `--user-data-dir=${profileDir}`,           // ← 沙箱标记（必须）
//   ], { stdio: ['ignore', 'pipe', 'pipe'] });
//
// 环境变量：
//   SANDBOX_STAND_IN_CHILD   可选，子进程脚本的绝对路径；给了就 fork（子进程同样把
//                            --user-data-dir 带在命令行里，如实模仿 chromium 的 zygote/renderer）
//   SANDBOX_STAND_IN_FACTS   可选，把 ready 行（含 pid / childPid）写进这个 JSON 文件。
//                            观察者把**起它的进程** SIGKILL 掉之后（制造「被收养」），
//                            仍然读得到它的 pid —— stdout 已经没人看了。
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const childEntry = process.env.SANDBOX_STAND_IN_CHILD;
const child = childEntry
  // `SANDBOX_STAND_IN_CHILD`/`SANDBOX_STAND_IN_FACTS` 都不进子进程的环境：一是只嵌套一层
  // （否则这个替身会一胎一胎生下去），二是不让子进程把 facts 文件覆盖掉 —— 上一层要看到的
  // 是**起它那条进程**的 pid（SIGKILL 掉它之后才好在表里认出“被收养”的那个）。
  ? spawn(process.execPath, [childEntry, ...process.argv.slice(2)], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, SANDBOX_STAND_IN_CHILD: undefined, SANDBOX_STAND_IN_FACTS: undefined } })
  : null;
const ready = { event: 'stand-in-browser', pid: process.pid, childPid: child?.pid ?? null, argv: process.argv.slice(2), self: fileURLToPath(import.meta.url), cwd: path.resolve('.') };
if (process.env.SANDBOX_STAND_IN_FACTS) {
  await mkdir(path.dirname(process.env.SANDBOX_STAND_IN_FACTS), { recursive: true });
  await writeFile(process.env.SANDBOX_STAND_IN_FACTS, `${JSON.stringify(ready, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(ready)}\n`);
process.on('SIGTERM', () => { try { child?.kill('SIGTERM'); } catch {} process.exit(0); });
setInterval(() => {}, 1000);
