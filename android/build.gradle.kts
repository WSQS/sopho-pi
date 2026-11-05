// 顶层 build 文件：只声明插件版本，模块自己去 apply。
// 版本选择以**本机已缓存的工具链**为准（Gradle 8.13 / AGP 8.9.2 / Kotlin 2.2.20），
// 与 feishu-dispatcher 那套（AGP 8.7.3 / Kotlin 2.0.21 / Gradle 8.13）同世代，但不逐字照抄 —— 见 docs/ops/android-client.md。
plugins {
    id("com.android.application") version "8.9.2" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.20" apply false
}
