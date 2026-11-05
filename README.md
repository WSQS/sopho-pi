# sopho-pi · v2

个人助手：**事项账本 + Web UI**，把 [pi](https://github.com/earendil-works/pi) 当作 agent 引擎。

> 这是 **v2** 的源码快照，**不含上游开发历史**。v2 把系统拆成两个进程（A / B）+ 插件机制。

## 结构

| 位置 | 是什么 |
|---|---|
| `server/base.mjs` | **A**：会话基底（pi runtime 池 + 逻辑层 + HTTP/SSE），默认端口 **7331**，数据根 `$ASSIST_HOME`（默认 `~/.pi/profiles/assistant`） |
| `server/base-logic.mjs` | 逻辑层（可热重载） |
| `server/app.mjs` | **B**：对外 Web UI + 反向代理，默认端口 **7321** |
| `pi-extensions/assistant/index.ts` | pi 插件（工具与命令） |
| `web/` | 前端：会话树、正文与流式渲染 |
| `bin/` | 起停脚本（bash / PowerShell）、端口查询、pre-push 钩子 |

## 要求

- **Node ≥ 22.19**；唯一直接依赖 `@earendil-works/pi-coding-agent`

## 跑起来

```bash
npm install
bash bin/serve.sh       # 起 A(7331) + B(7321)
bash bin/stop.sh        # 按 pidfile 停
```

Windows：`powershell -NoProfile -ExecutionPolicy Bypass -File bin/serve-win.ps1`。

## ⚠️ 安全：先读这一节

- **Web UI 零认证**。谁能连上它，谁就能在这台机器上执行任意命令 —— 只在你能控制的网络里跑。
- 服务端默认对外绑定 `0.0.0.0`（面向局域网）；只想本机访问就设 `SOPHO_HOST=127.0.0.1`。
- 要在**真实机器上**起服务（不要从另一个会话里起，会把自己住的实例弄乱）。
- 数据是**本地文件**（会话 JSONL / 账本 / 页面），没有远端同步、没有多用户隔离。

## 测试

```bash
npm run test:scroll        # 前端滚动（需要 Chromium）
```

## 许可

MIT —— 见 `LICENSE`。
