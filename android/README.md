# android/ —— sopho-pi 安卓原生客户端**原型 v0**

> 状态：原型（2026-10-21 立项；**未合主干**）。v0 在 `wt/v0-f21d725a`；2026-10-22 的两笔增量
> （UI 去“演示/原型”、**Moon 设置项 / 默认隐藏归档 / 按真实关系缩进**）在 `wt/child-fdbd7e70`；
> **2026-10-23 包名迁移到 `dev.sopho.pi`（与旧 `dev.sopho.proto` 并存）** 在 `wt/dev-sopho-pi-98281626`；
> **libzt 生命周期修复（`initFromStorage` 返回 -2）** 在 `wt/libzt-2-ccf0768e`（`docs/ops/android-client.md` §18）；
> **Profile 序列化修复（「第五行看不懂」）** 在 `wt/profile-6cae055b`（§19）。
> 两笔已由 **集成树 `wt/zt-7ec1d48c`** 用 `merge --no-ff` 合**一个包**（基线 `bae6523`，见 §20）；
> 那棵树上出的包才是“两修都在”的那一份，单装两个分支出包的那两份会来回覆盖。
> **当前可体验的那一份 = 集成树 `wt/integration-3lines`**（2026-10-23：A libzt 超时/取消、B 新建会话＋列表单行、
> C IME 几何 三线 `merge --no-ff` 合成一个包，共同基线 `wt/ime-b0e3848f` @ `1cbf0e4`）——
> 身份、读数与未验清单：[`../current-version.md`](../current-version.md)、
> [`../docs/ops/android-three-lines-integration-20261023.md`](../docs/ops/android-three-lines-integration-20261023.md)、
> `docs/ops/android-client.md` §22。旧交付包 `eb690880…` 不覆盖，留作历史。
> 工作面（范围 / 开放区 / 依据）：[`../items/android-client/item.md`](../items/android-client/item.md)。
> 构建与验收证据（原始命令＋读数）：[`../docs/ops/android-client.md`](../docs/ops/android-client.md)。

**它是什么**：连接（复用既有 libzt AAR / 直连）→ 会话列表（**默认隐藏归档、按真实 parentId 缩进**）
→ 打开阅读消息 + **在详情页发文本**，并在**前台**接 SSE 更新。ZeroTier 模式可填**可选 Moon**（World ID / Seed ID，空＝不 orbit）。
（2026-10-22 起界面**不再提供「演示（本地假 API）」选项**，也不再出现「原型」字样。）
**它不是什么**：不是正式客户端；没有后台常驻/推送、没有 TLS、没有鉴权。
**唯一的写口是发送**（`POST /message`、忙时 `POST /steer`，body 只有 `{text}`）；
**另一处写口（2026-10-23 起）是会话列表的「＋ 新建」**：只发 `POST /api/sessions`（`name`/`cwd`/`scratch`），
只建**空**会话、不带 `task`、不自动发 prompt；失败保留输入、忙/超时未知**不自动重发**。
停止/压缩/归档/改名/切模型都没有入口，也不改服务端。

## 签名与版本（固定包名 ＋ 原签名；升级只在新包名内成立）

- **正式包名** `applicationId = "dev.sopho.pi"`（2026-10-23 业主拍板，从此固定）：`namespace` / Kotlin 包 / 目录 /
  `androidTest` 包与 instrumentation component 全部迁到 `dev.sopho.pi`。旧包 `dev.sopho.proto` **并存**（不卸载、不清数据），
  两者是**两个应用**（不同 uid / dataDir / Prefs）⇒ **新包不是旧包的覆盖升级**，也不自动继承旧 Profile / identity。
  细节与读数：`docs/ops/android-client.md` §17。
- **签名基线**：证书 SHA-256 `faff248f15977835c25c25ec8c0b865fa6c4207bada8cfc8e5785ea8aa94e956`（`CN=Android Debug`），
  key 在 `~/.android/debug.keystore`，是 SDK 生成的 **debug key**，**不是长期/正式发行签名**；丢了或换机器就**断链**。
  `app/build.gradle.kts` 把 debug 签名**显式**钉到这条基线（`signingConfigs.baseline`）：
  keystore 缺失时**构建立刻失败**，不会静默退回“本机默认 debug key”。
  路径/口令只来自本地 gradle 属性或环境变量（`sopho.keystore` / `sopho.keystore.password` / `sopho.key.alias` /
  `SOPHO_KEYSTORE` / `SOPHO_KEYSTORE_PASSWORD`）；**仓库里没有任何秘密**，keystore 也不要提交进 git。
- **版本号只需不下降**（业主 2026-10-22 更正）：允许**相同 versionCode 覆盖安装**（不强制每包 +1）；
  `versionName` 用人能读的明确版本；交付表在 `docs/ops/android-client.md` §14.3。
- **机械闸**：`node android/tools/apk-baseline-check.mjs [apk] [--min-version N]` ——
  断言 包名（`dev.sopho.pi`）/ 证书 SHA-256 / versionCode 三条；找不到 SDK 的 aapt/apksigner 时退出 2（**不静默通过**）。
  拿**旧包**（`dev.sopho.proto`）跑这条闸**必须红** —— 那是安全检查（包名不同 ⇒ 并存，不是升级）。

## 目录

```
android/
  settings.gradle.kts / build.gradle.kts / gradle.properties   仓库根（插件版本、JitPack 源）
  app/                                                       单模块（Kotlin + Compose）
    build.gradle.kts                                          依赖与 SDK 版本
    src/main/AndroidManifest.xml                              INTERNET + ACCESS_NETWORK_STATE；allowBackup=false
    src/main/res/xml/network_security_config.xml              明文的边界（应用层收窄，见下）
    src/main/res/xml/data_extraction_rules.xml                备份规则（排除 identity 所在目录）
    src/main/java/dev/sopho/pi/
      MainActivity.kt                                         入口（前台/后台语义在这里挂）
      AppState.kt                                             界面状态与动作（含唯一的写：发送）
      Prefs.kt                                                 应用私有设置（SharedPreferences：`profilesRaw` 整块 ＋ 迁移标记 ＋ 只读的旧键）
      net/Wire.kt                                             /api/tree、/messages 的字段翻译
      net/SessionForest.kt                                    真实 parentId → 展示树（缩进/提升/成环/封顶）
      net/SophoApi.kt                                           HTTP 面（只读 GET ＋ 唯一写口 send）
      net/Send.kt                                              发送协议：路由选择 / 回执文本 / 可重试白名单
      net/SessionStream.kt                                     手写 SSE（事件/心跳/重连；不用 Last-Event-ID）
      net/Transport.kt                                         两套 OkHttp（明文 / libzt socketFactory）
      zt/ZtManager.kt                                          libzt 生命周期（连接页/自检/阶段化失败读数）
      zt/ZtNode.kt                                             进程级唯一生命周期 owner（串行、幂等、断开=leave、网归“持有者”租约）
      zt/ZtNative.kt                                           native 调用面（真实现/假货可换）＋错误码＋ZtRuntime 单例
      zt/Moon.kt                                               zts_moon_orbit 的契约、输入解析、返回码文案
      zt/MoonLauncher.kt                                       「配了 Moon 就 orbit 一次」（可注入替身⇒可单测）
      zt/ZeroTierSocketsSocketFactory.java                     libzt → java.net.Socket 适配层
      ui/*.kt                                                  Compose 屏（连接 / 列表 / 详情）
  fake-api/server.mjs                                         本地假 API（含 SSE/Send 与断线模拟；**界面已无入口**，离线夹具）
  tools/apk-baseline-check.mjs                               身份闸：包名（dev.sopho.pi）/ 证书 SHA-256 / versionCode
```

## 构建

需要 **JDK 17** 与 Android SDK（`compileSdk 36`、`minSdk 26`）。本机 `java` 不在 PATH 里，
但 `JAVA_HOME` 指向 JDK 17（`C:\Users\user\.jdks\ms-17.0.17`）；用 `JAVA_HOME=… ./gradlew` 即可。

```bash
cd android
JAVA_HOME="C:/Users/user/.jdks/ms-17.0.17" ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk

# 单元测试（JVM，不碰设备：libzt 生命周期 / 发送协议 / 树 / Moon / 地址判据 / Profile 编解码）
JAVA_HOME="C:/Users/user/.jdks/ms-17.0.17" ./gradlew testDebugUnitTest
# app/build/test-results/testDebugUnitTest/*.xml → 2026-10-23 集成树实测 **71 条，0 failures 0 errors**
# （= 基线 50 ＋ ZtLifecycleTest 11→13（libzt 生命周期：幂等/串行/失败清理/取消/网租约/反证臂）
#  ＋ ProfileTest 9→17（§19 的 `\r` 修复）；相加不重不漏，见 docs/ops/android-client.md §20.4）
```

⚠️ 本机 `~/.gradle/gradle.properties` 里配了一条 `localhost:7890` 的代理（2026-10-21 实测对
`dl.google.com` / `repo1.maven.org` 都不通，**直连** 200）。所以本工程的 `gradle.properties` 里有两行
`systemProp.http(s).nonProxyHosts=*`，只让**本工程**绕过它；换一台有可用代理的机器时删掉那两行即可。

## 仪表化行为测试（真设备/模拟器，2026-10-23 加）

`app/src/androidTest/` 里有四组：`ProfileBehaviourTest`（6 条：切配置隔离、草稿隔离、发送在途守卫、
落盘/重建回读、迁移幂等、坏数据不覆盖）、`ProfilePrefsRepairTest`（5 条：真 prefs 下的 CR 存盘再读回、
旧裸 CR 无损、CRLF 可唯一拼回、拆在整条之后必须 Corrupt 不吞行、读不懂时四个写点全封死）、
`FakeServerSelfTest`（夹具自检）与 `zt/RealNativeInitTest`（1 条：**不 start** 地量真实 AAR 的
`initFromStorage` 返回码）。它们用的是**真 Context**、
**真 `SharedPreferences`**、**真 `AppState`**，只把服务端换成本进程内绑 `127.0.0.1:0` 的 `FakeServer`
（真 OkHttp、真 TCP；能给 `/messages` 加延迟、能往 SSE 推帧）。**宿主机不占任何端口**；`ProfilePrefsRepairTest`
连服务端都不用（不 `connect()`、不启动 libzt）。

```bash
JAVA_HOME="C:/Users/user/.jdks/ms-17.0.17" ./gradlew assembleDebug assembleDebugAndroidTest

# ⚠️ 不要用 `./gradlew connectedDebugAndroidTest`：它会挑“所有连着设备”，本机还挂着别人的设备。
# 显式指定自己那台的序列号；instrumentation 的 component 随包名一起改成 dev.sopho.pi：
adb -s emulator-5554 install -r -t app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5554 shell am instrument -w -r \
  -e class dev.sopho.pi.FakeServerSelfTest,dev.sopho.pi.ProfileBehaviourTest,dev.sopho.pi.ProfilePrefsRepairTest \
  dev.sopho.pi.test/androidx.test.runner.AndroidJUnitRunner > instr.log 2>&1
```

**怎么读结果（踩过）**：`am instrument` 的退出码**不判成败**（全红也是 0）；`INSTRUMENTATION_CODE: -1`
**也不判成败**（绿是 -1，部分红也是 -1）。看三样：`OK (N tests)` / `Tests run: N,  Failures: 0`、
每条用例的 `INSTRUMENTATION_STATUS_CODE`（**先一条 1 = 开始，再一条 0 = 通过**；-2/-3/-4 = 失败）、
以及失败时 `STATUS: stack=` 的原文。所以 13 条用例会有 **26 行** `STATUS_CODE`，不要数错。
输出**先重定向到文件再判读**（别拿管道里的 `tail` 退码当结果）。
读数、反证臂（把守卫拆掉 ⇒ 对应用例真的红）与未验清单：`docs/ops/android-client.md` §16、§20.4、§20.5。

## 跑起来（连自己填的私网 B）
```bash
# 终端 1（可选）：只在想离线跑夹具时才用；界面已经没有「演示」入口了
# node android/fake-api/server.mjs        # 127.0.0.1:7399

# 装到**自己起的那台**模拟器上（本机惯例：自己起的用序列号认，别碰别人的设备）
adb -s emulator-5554 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 shell am start -n dev.sopho.pi/.MainActivity
```

App 里默认就是「直连（HTTP）」，地址默认 `http://10.0.2.2:7321`（模拟器里 `10.0.2.2` = 宿主回环，B 的 `/api`），点「连接」
⇒ **先 `GET /api/tree`，成功才进列表**。

**2026-10-22 起没有「演示」选项了**：`fake-api` 文件还在（离线夹具），但界面选不到它。下面两条夹具行为只在你
**手动起假 API 并直连它**时才看得到：

- **「演示 · 慢响应 A」**的 `/messages` 故意等 **5 s**；配合「演示 · 未读回复」（`noTurns`，不推演示回合），
  可以复现「先在 A 上发起慢请求、切到 B，A 的迟到结果不许盖掉 B」（做法与正/反读数见
  `docs/ops/android-client.md` §5.1）。
- 列表**已接** `/api/tree/events`（2026-10-29，分支 `wt/android-0bc3b731`，**本分支未出包、未上设备**）：连接成功、
  回前台（列表与详情都在前台挂着）时开一条树事件流；一帧 ⇒ 一次**合并后的**权威 `GET /api/tree` 重拉
  （同一时刻最多一发在飞，在飞期间来的只攒成一次补发）；断线按 1→2→4→8→16→30 s 退避重连，**重连必重新对账**；
  后台/断开/切配置/关进程收掉订阅，旧归属的迟到结果不上屏。列表页那行「列表实时：…」照事实写（未连接就写未连接）。
  仍没说清的：取消只 cancel OkHttp 的 Call，**native fd 是否真 close 没有证据**；真机/真网一次没跑。

## 两种运行模式

| 模式 | 打哪里 | 说明 |
|---|---|---|
| 直连（HTTP） | 自己填的私网地址 | 真服务端（B 的根地址，客户端自己加 `/api`）；明文 |
| ZeroTier（libzt） | AAR 里的 libzt 用户态协议栈 | 不占 `VpnService`；identity 落 `filesDir/zerotier` |

两种模式下顶栏都常显**当前模式**。界面文字**不出现「原型」「演示」**（2026-10-22 业主指示），
也没有演示数据黄槽 —— 所以现在的如实性靠「顶栏模式 + 只读说明」，不靠一条演示提示。

## libzt 模式的现状（如实）

- **已验**：APK 里带 4 个 ABI 的 `libzt.so`；在本机 x86_64 模拟器上 `libzt.so` **真的装上了**，
  「自检（不连网）」调 `initFromStorage` 返回 0（一次真实 JNI 调用进了 native），连调两次也都是 0。
- **已验的一条边界**：`initFromStorage` **不读也不建 identity**（它只记 home path；实测自检后
  `files/zerotier` 里 0 个条目）—— identity 的读/建发生在节点 `run()` 里。所以「自检证明 identity 读写通了」
  是过度声称（旧文案已删）。
- **没验**：真机/真网络下的 `start → join → isNetworkTransportReady → addr_is_assigned` 全链路
  （需要业主的 ZeroTier 网络与授权）；HTTPS（`SocketProxy` 之上叠 TLS）**没有任何证据**。
- **一次量到的崩溃**：`ZeroTierNode.stop()` 在这版 AAR 上**必崩** —— JNI 壳里 `..._zts_1node_1stop`
  无条件 `java_detach_from_thread()`（`src/bindings/java/JavaSockets.cxx:454-459`），ART 上就是 SIGABRT。
  所以本应用**从不调用它**（`ZtNative` 接口里没有 `stop`/`free`）。
- **生命周期口径（2026-10-23 修）**：一个进程一个节点（`ZtRuntime` 唯一 owner，init 一次、start 一次、全部串行）；
  「断开」= `zts_net_leave`，节点寿命 = 进程寿命；换网先 leave 旧网再 join 新网；失败/超时如实报
  阶段＋返回码，`-2` 不重试并提示重启进程。因果与原始读数：`docs/ops/android-client.md` §18。
- **⚠️「断开」不等于「完全停止联网」**：`zts_node_stop()` 不能用（见上），所以断开只把**网** leave 掉，
  native 节点、它的工作线程与 socket **仍在进程里活着**（按源码，`NodeService::run()` 只在 `zts_node_stop()`
  之后才退出）。要彻底停下只能**结束应用进程**（最近任务里划掉）。这条界面上也写了（ZeroTier 面板）。
  本条是**按源码判定的**代价，没有用真机抓包量过。
- **网的归属（租约，2026-10-23 集成时补）**：native 是进程级、`ZtManager` 却是每个 Activity 一个 ⇒
  「节点上此刻 join 着的那张网」只能有**一个持有者**：谁 join 成功就把租约换给它（同网接管也换）；
  `disconnect` 只有当前持有者叫得动，旧实例迟到的 `close()` / 失败清理一定是空操作；重复 `disconnect()` 幂等。
  否则旧 Activity 晚到的 `close` 会把新实例刚连上的网 leave 掉。见 `docs/ops/android-client.md` §20.3。
- **本机实测的一条 libzt 行为**：节点**未启动**时 `zts_node_get_id` 返回**负的错误码**
  （模拟器上拿到 `fffffffffffffffe` ＝ -2）⇒ 所以「自检」只证明 `libzt.so` 装上且一次 JNI 调用成功，
  **节点 ID 要等节点启动后才有**：界面不把错误码当 ID 显示，也**不再**承诺「先拿 ID 去 Central 授权」。
- **`zts_addr_is_assigned` 的判据按源码，不按"非 0 就行"**：正数 = 已分配、0 = 还没分配、负数 = 错误码
  （实现见固定 revision 的 `src/NodeService.cpp` / `src/Controls.cpp`，原始行号抄在
  `docs/ops/android-client.md` §6.1）⇒ 负数会当面报错并停住，不会被当成「已拿到虚拟地址」。
  这条判据有 JVM 单测（`app/src/test/java/dev/sopho/pi/zt/AddressProbeTest.kt`）。

## 明文的边界

- 构建层：`network_security_config` 允许明文（A/B 今天只有明文 HTTP，而服务器地址是任意私网地址）。
- **真正的收窄在应用层**：`Destinations.refusal()` 只接受回环 / 私网（10/8、172.16/12、192.168/16、
  169.254/16、100.64/10、`10.0.2.2`、`localhost`）的 `http://`；公网地址直接拒绝并说明原因；
  `https` 直接拒绝（未验，不装作能连）。
- ⚠️ A/B **今天零认证**：能把手机接进这张网 ≈ 能以当前账户执行命令。原型只连自己控制的私网/回环。

## identity 与备份

- identity 目录 = `filesDir/zerotier`（应用私有）；`android:allowBackup="false"` ＋
  `data_extraction_rules.xml` 排除 `file`/`sharedpref` —— 不让它进自动备份（两台设备同身份会撞
  `NODE_IDENTITY_COLLISION`）。
- 本机自检后该目录**仍是空的**（节点未启动；identity 何时落盘本单没验）。
- 仓库里**没有**任何 identity / token / network secret。

## 与桌面 webui 的关系

只沿用它的设计语言，不重做界面：调色板逐值抄 `web/index.html` 的 `:root`，左槽原语抄 `web/slot.css`
（1px 其余边 ＋ 贴最左 3px 语义色）。**没有**为安卓屏写 `spec/screens/` 的精确规格（见 item 的开放区）。
