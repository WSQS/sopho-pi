# sopho-pi

个人助手：**会话树 + Web UI + 原生 Android 客户端**，把 [pi](https://github.com/earendil-works/pi)
当作 agent 引擎。

> 本仓是 **v2.2 的源码快照**（2026-11-05 锁版），**不含上游开发历史**，也不包含更早的 v1 / v2.1
> 或另一条 v3.0 平台线。快照导出时删掉了内部文档与压测留档，代码里的机器名 / 真实路径已脱敏。
>
> ⚠️ 代码注释里仍会看到 `docs/…` 的引用 —— 那些是**内部操作手记与事故复盘**，未随本快照公开；
> 保留引用是为了让注释的上下文完整，**不是**指向本仓里存在的文件。

## 它是什么

| 位置 | 是什么 |
|---|---|
| `server/base.mjs` + `server/base-logic.mjs` + `server/pool.mjs` + `server/worker.mjs` | **A**：宿主（runtime 池、generation worker、owner 路由、热重载）＋ 逻辑层（路由 / SSE / 账本投影） |
| `server/app.mjs` | **B**：对外 Web UI 与反向代理（默认 **7321**，A 默认 **7331**） |
| `web/` | 前端：会话树、正文流式、`@` 提及、设置页、设计器页 |
| `pi-extensions/assistant/index.ts` | 给 pi 的 17 个工具（`cwd` / `session_*` / `device_*` / `handoff` / `image_generate` / `question_*` …）与命令 |
| `android/` | 原生 Android 客户端（Kotlin + Compose；`dev.sopho.pi` / `0.2.0` / `versionCode 2`） |
| `designer/` `spec/` 生成物 | 设计器与设计值流水线（`web/generated/` 由 `bin/gen-*-values.mjs` 产出） |
| `test/` | 188 个契约测试（自带临时 home / 随机端口 / 假 provider；部分需要 Chromium 或真设备） |

## 要求

- **Node ≥ 22.19**；唯一直接依赖 `@earendil-works/pi-coding-agent`
- Android 另需 **JDK 17** + **Android SDK（compileSdk 36 / minSdk 26）**

## 跑起来

```bash
npm ci                      # 用锁文件（不要用 npm install 引入隐式升级）
bash bin/serve.sh           # 起 A(7331) + B(7321)；只打印不动进程：SOPHO_DRY_RUN=1 bash bin/serve.sh
bash bin/stop.sh            # 按 pidfile 停
```

Windows：`powershell -NoProfile -ExecutionPolicy Bypass -File bin/serve-win.ps1`（停：`bin/stop-win.ps1`）。
数据根 `$ASSIST_HOME`，默认 `~/.pi/profiles/assistant`。

## ⚠️ 安全：先读这一节

- **Web UI 零认证**，且 B 默认绑 `0.0.0.0`：**谁能连上 7321，谁就能在这台机器上执行任意命令**。
  只在你能控制的网络里跑；只想本机访问就设 `SOPHO_APP_HOST=127.0.0.1`。
- 没有 TLS、没有多用户隔离；数据是本地文件（会话 JSONL / 账本 / 页面），没有远端同步。
- A / B 要在**真实机器上**起；不要从另一个 agent 会话里起它们（会把自己住的实例弄乱）。

## 测试

**没有 `npm test` 总入口**：按 `package.json` 的 `scripts` 逐条跑（`test*` 共 336 条）。
多数自带临时 `ASSIST_HOME`、随机高位端口与假 provider；**有一部分需要 Chromium**
（`CHROME_BIN=…`）或真设备/模拟器，缺了会如实报错而不是假装通过。

Android：`cd android && ./gradlew testDebugUnitTest assembleDebug`（单元测试不碰设备）。
**本仓库不附带签名 key** —— 构建需要一把 keystore（`-Psopho.keystore=…` 或 `~/.android/debug.keystore`），
缺失时构建立刻失败（不会静默换成本机默认 debug key）。

## 许可与第三方

- 本仓：**MIT**，见 [`LICENSE`](LICENSE)。
- 随仓库分发的第三方：`web/vendor/marked.min.js`（MIT）、`web/vendor/highlight.min.js`（BSD-3-Clause）、
  `android/gradle/wrapper/gradle-wrapper.jar`（Apache-2.0）—— 各自许可证全文见 `web/vendor/` 与 `android/NOTICE.md`。
- Android 构建时从 JitPack 取 libzt 预编译包（Apache-2.0）：**对外分发 APK 时须随包附上游许可与版权声明**，
  见 [`android/NOTICE.md`](android/NOTICE.md)。
