/**
 * 停掉正在跑的服务器。
 *
 * 为什么需要这个文件：`pkill -f` 在这个项目里极易自杀或杀错 ——
 *   - 服务器的命令行是 `node server/index.mjs`（相对路径），按 "sopho-pi/server" 找不到它
 *   - 直接 pkill -f "server/index.mjs" 又会匹配到你自己这条命令
 * 所以用 pidfile：启动时写，停的时候读。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PORT = Number(process.env.SOPHO_PORT ?? 7321);
const pidFile = path.join(os.tmpdir(), `sopho-pi-${PORT}.pid`);

let pid;
try {
	pid = Number(fs.readFileSync(pidFile, "utf8").trim());
} catch {
	console.log(`没有 pidfile（${pidFile}）—— 服务器大概没在跑，或者是被别的方式启动的。`);
	console.log(`兜底：ss -ltnp | grep :${PORT}  看谁占着端口`);
	process.exit(0);
}

/**
 * 只有在 pid **确实是我们的服务器**时才杀。
 *
 * 为什么需要：pidfile 会过期。服务器崩了之后 pid 可能被系统重用给别的进程 ——
 * 那时候盲杀就是在杀无辜的东西。所以看一眼 /proc/<pid>/cmdline。
 */
function looksLikeOurServer(p) {
	try {
		const cmd = fs.readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").join(" ");
		return cmd.includes("server/index.mjs");
	} catch {
		return false; // 读不到 /proc/<pid> = 进程已经不在了
	}
}

if (!looksLikeOurServer(pid)) {
	console.log(`pidfile 里的 ${pid} 不是我们的服务器（或已经退出）—— 不杀它，只清掉 pidfile。`);
	try {
		fs.readFileSync(`/proc/${pid}/cmdline`);
		console.log(`  它现在跑的是：${fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim()}`);
	} catch {
		// 进程不在了，不用报告
	}
	console.log(`  兜底：ss -ltnp | grep :${PORT}`);
	fs.rmSync(pidFile, { force: true });
	process.exit(0);
}

try {
	process.kill(pid, "SIGTERM");
	fs.rmSync(pidFile, { force: true });
	console.log(`已停止 pid ${pid}（端口 ${PORT}）`);
} catch (err) {
	console.log(`pid ${pid} 已经不在了（${err.code ?? err.message}），清掉 pidfile`);
	fs.rmSync(pidFile, { force: true });
}
