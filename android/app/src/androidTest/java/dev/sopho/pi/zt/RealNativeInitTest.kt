package dev.sopho.pi.zt

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.zerotier.sockets.ZeroTierNode
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 真实 AAR 上**不启动节点**的那一格：`zts_init_from_storage` 的真实返回码。
 *
 * 为什么只到这里：`zts_node_start()` 会让 libzt 起 UDP 并向 ZeroTier planet root 发握手包，
 * 本单没有那份出网授权 ⇒ **这个测试不 start**，所以它证明的是「新进程首次 init（以及紧接着再 init）是 0」
 * 和「未启动时 `zts_node_get_id` 给的是 -2 错误码」，**不是**「running 时会返回 -2」。后者见
 * docs/ops/android-client.md §18 的「没验到什么」。
 *
 * ⚠️ 这里**也不能**调 `ZeroTierNode.stop()`：`..._zts_1node_1stop` 的 JNI 壳无条件 `DetachCurrentThread`，
 * 在 ART 上就是 SIGABRT（2026-10-23 本测试自己踩到过，logcat：`attempting to detach while still running code`）。
 *
 * 前置：应用进程必须是干净的（先 `adb shell am force-stop dev.sopho.pi`）。若同进程里已经有一个
 * libzt 服务在跑，这条测试会以 `-2` 失败 —— 那正是 native 的契约，不是测试坏了。
 * 它会在应用私有目录写/读 identity（just 在 AVD 上）；不删、不搬任何既有 identity。
 */
@RunWith(AndroidJUnit4::class)
class RealNativeInitTest {

    @Test
    fun repeatedInitIsZeroBeforeStartAndIdIsTheServiceErrorCode() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dir = File(context.filesDir, "zerotier")
        val made = dir.mkdirs()

        val node = ZeroTierNode()
        val rc1 = node.initFromStorage(dir.absolutePath)
        val rc2 = node.initFromStorage(dir.absolutePath) // 没在跑时重复 init 也应当是 0（不是 -2）
        val id = node.id

        println(
            "SOPHO-RC-NT path=${dir.absolutePath} mkdirs=$made isDirectory=${dir.isDirectory} " +
                "canWrite=${dir.canWrite()} rc1=$rc1 rc2=$rc2 id=$id",
        )

        assertTrue("identity 目录应当是目录", dir.isDirectory)
        assertEquals("第一次 initFromStorage", 0, rc1)
        assertEquals("没在跑时重复 initFromStorage", 0, rc2)
        assertEquals("未启动时 zts_node_get_id 返回 ZTS_ERR_SERVICE(-2)，不是 ID", -2L, id)
    }
}
