plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.sopho.pi"
    compileSdk = 36

    defaultConfig {
        // **正式包名（2026-10-23 业主拍板）：`dev.sopho.pi`，从此固定。**
        // 它就是应用身份：与旧的 `dev.sopho.proto` 是**两个应用**（并存，不覆盖升级）。
        // 改动它等于再换一个应用，已装包不能升级 —— 见 docs/ops/android-client.md §17。
        applicationId = "dev.sopho.pi"
        minSdk = 26
        targetSdk = 36
        // 版本号只需**不下降**（允许同 code 覆盖安装，业主 2026-10-22 更正）；规则见 docs/ops/android-client.md §14。
        // v1 = 已交付的 fb54b1ee…（versionCode 1）；当前 2。
        versionCode = 2
        versionName = "0.2.0"
        // 仪表化行为测试（`app/src/androidTest`）跑在真机/模拟器里，用的是应用自己的 Context 与 Prefs。
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        // 签名基线：**必须**与旧包（`dev.sopho.proto`）同一把 key（cert SHA-256 = faff248f…）。
        // 包名变了 ⇒ 新包是另一个应用、不构成覆盖升级；但签名仍钉在这条基线上，不换 key。
        // 路径/口令只从本地 gradle 属性或环境变量读，仓库里不写任何秘密；
        // 属性口令是 SDK 自动生成 debug key 时的公开默认值（不是秘密），也允许被覆盖。
        create("baseline") {
            val keystorePath = providers.gradleProperty("sopho.keystore").orNull
                ?: System.getenv("SOPHO_KEYSTORE")
                ?: "${System.getProperty("user.home")}/.android/debug.keystore"
            val keystoreFile = file(keystorePath)
            if (!keystoreFile.isFile) {
                // 缺 key 就当场失败：**不许**静默退回“另一把 debug key”——
                // 那会让覆盖升级失败（签名不符），或者更糟：装成一个“新应用”。
                throw GradleException(
                    "签名基线缺失：$keystorePath\n" +
                        "已交付包的证书 SHA-256 是 faff248f…；没有这把 key 就不是同一个发布者。\n" +
                        "不要生成替代 key（会断链）；把原 keystore 放回，或用 -Psopho.keystore=<path> 指过去。",
                )
            }
            storeFile = keystoreFile
            storePassword = providers.gradleProperty("sopho.keystore.password").orNull
                ?: System.getenv("SOPHO_KEYSTORE_PASSWORD")
                ?: "android"
            keyAlias = providers.gradleProperty("sopho.key.alias").orNull ?: "androiddebugkey"
            keyPassword = providers.gradleProperty("sopho.key.password").orNull
                ?: providers.gradleProperty("sopho.keystore.password").orNull
                ?: System.getenv("SOPHO_KEYSTORE_PASSWORD")
                ?: "android"
        }
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        // 原型只有 debug 一种：不许把它当发行包（未做混淆、无鉴权）。
        // debug 的签名**显式**指向 baseline（= 已交付包那把 key）—— 不靠 AGP 自动生成的
        // 「本机默认 debug key」，这样“换一台机器就静默换 key”那种事会直接编译失败。
        debug {
            signingConfig = signingConfigs.getByName("baseline")
        }
        release {
            isMinifyEnabled = false
        }
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/LICENSE*", "/META-INF/NOTICE*")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.07.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    // HTTP + SSE（OkHttp 的 EventSource：自己实现重连，服务端不读 Last-Event-ID）
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")

    // 复用既有 libzt AAR（不占 VpnService 的用户态协议栈）。坐标＝tag，绝不浮动。
    implementation("com.github.WSQS:libzt-prebuild:main-a707ea6-20260808")

    // 极小的单元测试：钉住 `zts_addr_is_assigned` 的返回码判据（`./gradlew testDebugUnitTest`）。
    testImplementation("junit:junit:4.13.2")
    // JVM 单测里要能跑**真** `org.json`：Android 的 `android.jar` 在单测里只是桩（调用即 "Stub!"），
    // 而 `/messages` 的合成顺序是纯解析逻辑，值得在 JVM 上直接钉住（版本取本机 gradle 缓存里已有的那个，
    // 不引入新下载；`androidTest` 用的是设备上的真实现，不受影响）。
    testImplementation("org.json:json:20240303")

    // 仪表化行为测试：真实 Context/Prefs/AppState，服务端换成本进程内的假货（见 androidTest 里的 FakeServer）。
    // 版本按本机 gradle 缓存里的已有版本钉，不引入 Robolectric（那要为一个纯状态机再搭一套影子实现）。
    androidTestImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    // Compose 的仪表化测试：**用真实 UI 语义**（输入 / 点击「保存」）走一遍，
    // 而不是直接写 prefs 冒充“用户保存过”（见 docs/ops/android-client.md §21）。
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.07.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    // `createComposeRule()` 需要一个宿主 Activity 声明（`androidx.activity.ComponentActivity`）；
    // 没有这一条，仪表化里会报 "Unable to find explicit activity class"（只加 debug 变体，不进交付包）。
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
