# NOTICE —— 第三方组件与许可证

本原型**复用**一份已经发布好的 libzt 预编译包，不自己编译 native。


## Gradle Wrapper（随仓库分发）

| 项 | 值 |
|---|---|
| 文件 | `android/gradle/wrapper/gradle-wrapper.jar`（以及同目录 `gradle-wrapper.properties`） |
| 来源 | Gradle 官方发行版 `gradle-8.13-bin` 自带（`gradlew` 启动器） |
| 许可证 | **Apache-2.0**（Gradle, Inc.）；全文见 <https://www.apache.org/licenses/LICENSE-2.0> |
| 说明 | 它是**二进制 jar**，随本仓库分发；使用时需保留其许可与版权声明（本文件即该声明） |

## libzt（ZeroTier Sockets）

| 项 | 值 | 依据 |
|---|---|---|
| Gradle 坐标 | `com.github.WSQS:libzt-prebuild:main-a707ea6-20260808` | `android/app/build.gradle.kts` |
| 发布位置 | JitPack；同一份字节也挂在 GitHub Release（`WSQS/libzt-prebuild` 的 tag `main-a707ea6-20260808`） | 调研：`wt/zerotier-aar-586fd620` @ `de8b2d7` 的 `docs/plans/android-feishu-dispatcher-reuse.md` §2.1 |
| 资产 sha256 | `6db24b37340fc5a13bdb525181b502a49f65c2bdbac03f39e0c84d20cb246699`（3,242,904 B） | 本单**自己下载并复算过**这一次（见 `docs/ops/android-client.md`） |
| 上游源码 | `zerotier/libzt@a707ea6ae0910efdc1125d04758c411e2e9ea4f9` | 同上 §2.2 |
| 构建工具链 | GitHub Actions：NDK 25.1.8937393 / CMake 3.22.1 / JDK 17，`./build.sh android-aar release` | 同上 §2.2 |
| 许可证 | 上游 `LICENSE.txt` 是 **BSL 1.1**，`Change Date: 2026-01-01`，`Change License: Apache-2.0`
⇒ 该 revision 的许可今天已转为 **Apache-2.0** | 同上 §7（本单未重新核上游许可证，只转述） |

⚠️ **AAR 内部不带 `LICENSE`/`NOTICE` 文件**（它只有 `AndroidManifest.xml` / `classes.jar` / 4 个 `libzt.so` /
`R.txt` / `META-INF/…aar-metadata.properties`）。本仓**不随仓库分发 libzt 的二进制**（构建时由 Gradle 从 JitPack 取），所以源码里不附；**但一旦对外分发打好的 APK（里面含 `libzt.so`），必须随包附上上游 Apache-2.0 `LICENSE.txt` 与版权声明。** 本单**没有把 Apache-2.0 全文放进仓库**：
若要把这个原型**对外分发**（而不是自己装上跑），需要随包附上 libzt 的 Apache-2.0 `LICENSE.txt` 与上游版权声明 —— 本单没做。
本文件不是法律意见。

4 个 ABI 的 `libzt.so`（未压缩合计 8,548,734 B）都进了 debug APK；本单**没有**做 `abiFilters` 裁剪。

## 其它依赖（均为 Apache-2.0）

- `androidx.compose:compose-bom:2025.07.00` 及其 `ui` / `foundation` / `material3`
- `androidx.activity:activity-compose:1.10.1`
- `org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2`
- `com.squareup.okhttp3:okhttp:4.12.0`（SSE 由本仓库手写解析）
  - ⚠️ **与下面这句不一致，据实记**：`android/app/build.gradle.kts` 还声明了 `com.squareup.okhttp3:okhttp-sse:4.12.0`，
    但 `android/app/src` 里对 `okhttp3.sse` / `EventSources` **零引用**（2026-10-24 逐文件 grep 核对）
    ⇒ 它是一条**没用上的依赖**。本文件此前写「**没有**引入 `okhttp-sse`」是错的。
    修法二选一（删依赖行 / 改本文件口径）；**本笔只改文字，不动依赖、不换包**。
- Android Gradle Plugin 8.9.2 / Kotlin 2.2.20 / Gradle 8.13（仅构建期）

## 参考实现（未复制整份代码）

`C:/Users/user/Documents/ai/feishu-dispatcher`（业主自己的仓库，HEAD `a7966d6`）里的
`client/android/app/src/main/java/.../network/{ZtManager.kt,ZeroTierSocketsSocketFactory.java}`
只作**形状参考**（那份本身抄自 libzt-android-examples 的 okhttpclient demo）。本仓的
`zt/ZeroTierSocketsSocketFactory.java` 是**新写的一份**：只实现 OkHttp 4.12 明文路径用到的几个方法，
其余显式抛 `UnsupportedOperationException`。没有编辑、切换分支或构建那个项目。
