# sopho-pi · v1（原型）

个人助手：**以事项为中心**的助手 —— 事项账本 + Web UI，把 [pi](https://github.com/earendil-works/pi) 当作 agent 引擎。

> 这是 **v1 原型**的源码快照，**不含上游开发历史**。核心想法是"账本里的一个事项 = 一段被推进的工作"。

## 结构

| 位置 | 是什么 |
|---|---|
| `bin/ledger.mjs` | 账本 CLI（`npm run a`） |
| `bin/triage*.mjs` | 分诊：把自由文本拆成事项 |
| `defaults/*.md` | 各阶段的提示词模板（讨论 / 执行 / 汇报 / 复盘 / 判据） |
| `server/index.mjs` | 服务端入口（`npm start`），默认端口 **7331** |
| `server/runtime-pool.mjs` | pi runtime 池 |
| `web/` | Web UI（含乐观更新的前端测试 `web/test-optimistic.mjs`） |
| `pi-extensions/assistant/index.ts` | pi 插件 |

## 要求

- **Node ≥ 22.19**；唯一直接依赖 `@earendil-works/pi-coding-agent`

## 跑起来

```bash
npm install
npm start              # 服务端（scss: npm stop 停）
npm run a              # 账本 CLI
```

## ⚠️ 安全：先读这一节

- **Web UI 零认证**。谁能连上它，谁就能在这台机器上执行任意命令 —— 只在你能控制的网络里跑。
- 服务端默认对外绑定 `0.0.0.0`（面向局域网）；只想本机访问就设 `SOPHO_HOST=127.0.0.1`。
- 要在**真实机器上**起服务（不要从另一个会话里起，会把自己住的实例弄乱）。
- 数据是**本地文件**（会话 JSONL / 账本 / 页面），没有远端同步、没有多用户隔离。

## 测试

```bash
npm run test:triage        # 分诊解析
npm run test:auto          # 自动续跑
npm run test:optimistic    # 前端乐观更新
```

## 许可

MIT —— 见 `LICENSE`。
