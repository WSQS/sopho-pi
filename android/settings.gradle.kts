pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // libzt 预编译 AAR（业主 GitHub Release，经 JitPack 发布同一份字节）。
        // 坐标钉死在 tag 上；上游 commit 与 sha256 见 android/NOTICE.md。
        maven("https://jitpack.io")
    }
}

rootProject.name = "sopho-android"
include(":app")
