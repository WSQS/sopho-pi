#!/usr/bin/env node
// 测试替身：沙箱进程树里的子进程（形状与 `server/worker.mjs` 相同 —— 只有宿主一个客户，
// 自己不会因为宿主消失而退出）。见 test/fixtures/sandbox-stand-in-host.mjs 的说明。
process.stdout.write(`${JSON.stringify({ event: 'stand-in-worker', pid: process.pid, ppid: process.ppid })}\n`);
setInterval(() => {}, 1000);
