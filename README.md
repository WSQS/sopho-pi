# sopho-pi · v2.1

个人助手：**事项账本 + Web UI**，把 [pi](https://github.com/earendil-works/pi) 当作 agent 引擎。

> 这是 **v2.1** 的源码快照（2026 年 9 月），**不含上游开发历史**，也不包含之后的版本。
> 快照导出时删掉了内部文档与压测留档，代码里的机器名 / 真实路径做了脱敏。

## 结构

| 位置 | 是什么 |
|---|---|
| `server/base.mjs` | **A**：会话基底（pi runtime 池 + 逻辑层 + HTTP/SSE），默认端口 **7331**，数据根 `$ASSIST_HOME`（默认 `~/.pi/profiles/assistant`） |
| `server/app.mjs` | **B**：对外 Web UI + 反向代理，默认端口 **7321** |
| `server/reading-page.mjs` / `epub-extract.mjs` / `page-store.mjs` | 阅读页 / EPUB 抽取 / 页面账本 |
| `pi-extensions/assistant/index.ts` | pi 插件：`cwd` / `session_new` / 页面提问等工具与命令 |
| `web/` | 前端：会话树、正文与流式、`@` 提及、阅读页 |
| `bin/` | 起停脚本（bash + PowerShell）、端口查询、模型默认值、pre-push 钩子 |
| `test/` | 契约测试（多数自足：临时 home / 随机端口 / 本地假模型端点；几个需要真实笔记夹具或 Chromium，见下） |

## 要求

- **Node ≥ 22.19**；唯一直接依赖 `@earendil-works/pi-coding-agent`

## 跑起来

```bash
npm install
bash bin/serve.sh       # 起 A(7331) + B(7321)；只打印不动进程：SOPHO_DRY_RUN=1 bash bin/serve.sh
bash bin/stop.sh        # 按 pidfile 停
```

Windows：`powershell -NoProfile -ExecutionPolicy Bypass -File bin/serve-win.ps1`（停：`bin/stop-win.ps1`）。

## ⚠️ 安全：先读这一节

- **Web UI 零认证**。谁能连上它，谁就能在这台机器上执行任意命令 —— 只在你能控制的网络里跑。
- 服务端默认对外绑定 `0.0.0.0`（面向局域网）；只想本机访问就设 `SOPHO_HOST=127.0.0.1`。
- 要在**真实机器上**起服务（不要从另一个会话里起，会把自己住的实例弄乱）。
- 数据是**本地文件**（会话 JSONL / 账本 / 页面），没有远端同步、没有多用户隔离。

## 测试

没有总入口，按 `package.json` 的 `scripts` 逐条跑。**它们不是全都自足** —— 实测依赖如下：

| 测试 | 需要什么 |
|---|---|
| `test:cwd` `test:header` `test:proxy` `test:runtime-roots` `test:mentions` `test:extract` | **自足**：自带临时 home、临时目录、随机端口与本地假模型端点，不碰真实数据 |
| `test:page` `test:page-demo` `test:tools` `test:page-api` | 需要一份**真实笔记夹具**（默认找 `/tmp/note-gongdu.md`，可用 `SOPHO_REAL_NOTE` 指过去）。没有夹具时 `page-api` 会退回造出来的页，但「阅读位置」那条断言会红 |
| `test:compact-window` `test:delivery` | 需要**已经在跑的 A**（`http://127.0.0.1:7331`），不是自足测试 |
| `test:toolstate` `test:livededup` `test:scroll` | 需要 **Chromium**（`CHROME_BIN=/path/to/chrome`） |

## 许可

MIT —— 见 `LICENSE`。
