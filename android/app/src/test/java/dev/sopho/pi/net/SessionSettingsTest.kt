package dev.sopho.pi.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 模型 / 思考档位这条线的**纯逻辑**证据：
 * 目录解析（含三态能力与“清单没给就是未知”）、写回执的自证、失败分类（不自动重试）、
 * 以及“客户端不硬编码档位、不把请求值当已生效”的三条硬口径。
 *
 * 会失败的理由：
 * - 把 `input` 缺失当成“不支持图片” ⇒ 三态被压成两态，界面会给出错误结论；
 * - 服务端没给 `levels` 时自己摆一排档位 ⇒ 用户点了不存在的档位；
 * - 2xx 就标“已生效” ⇒ 回执里没有回读值时，界面会撒谎；
 * - 409 忙当“失败可重试”并自动重发 ⇒ 用户看不到那次写入到底成没成。
 */
class SessionSettingsTest {

    private val sid = "11111111-1111-4111-8111-111111111111"

    // ───────────────────────── 目录解析 ─────────────────────────

    @Test
    fun modelsParseFullShapeWithThinkingAndCapabilities() {
        val catalog = SettingsWire.parseModels(MODELS_BODY, sid)
        assertEquals("litellm/gpt-5", catalog.current)
        assertEquals("scoped", catalog.source)
        assertEquals(2, catalog.models.size)

        val vision = catalog.models.first { it.id == "gpt-5" }
        assertTrue("服务端说 supportsImages=true", vision.supportsImages == true)
        assertEquals(listOf("text", "image"), vision.input)
        assertEquals(listOf("low", "high"), vision.thinkingLevels)
        assertTrue(vision.current)
        assertTrue("当前模型就是它", catalog.currentEntry == vision)
        assertEquals("当前模型的可支持档位", listOf("off", "low", "high"), catalog.levels)
        assertTrue("当前模型可发图", catalog.supportsImages == true)
        assertEquals("off", catalog.thinking?.current)
    }

    /**
     * `input` / `supportsImages` 缺失 ⇒ **null（未知）**，不能变成 false。
     * 这一条直接决定功能盘的图片按钮“不假装支持”还是“假装不支持”。
     */
    @Test
    fun missingCapabilityStaysUnknown() {
        val body = """{"sessionId":"$sid","current":"m/a","models":[{"provider":"m","id":"a","current":true}]}"""
        val catalog = SettingsWire.parseModels(body, sid)
        assertNull("input 缺失 ⇒ 未知", catalog.models.single().input)
        assertNull("supportsImages 缺失 ⇒ 未知", catalog.models.single().supportsImages)
        assertNull("当前模型的图片能力未知", catalog.supportsImages)
        val note = SettingsProtocol.capabilityNote(catalog.supportsImages, null)
        assertTrue("未知时不许说“支持”", !note.contains("含 image"))
        assertTrue("未知时要说清无法证明", note.contains("无法证明"))
    }

    /** `input=["text"]` ⇒ 明确的不支持（false），与“未知”区分开。 */
    @Test
    fun inputWithoutImageMeansExplicitlyUnsupported() {
        val body = """{"sessionId":"$sid","current":"m/a","models":[
            {"provider":"m","id":"a","ref":"m/a","current":true,"input":["text"]}]}"""
        val catalog = SettingsWire.parseModels(body, sid)
        assertEquals(false, catalog.supportsImages)
        val note = SettingsProtocol.capabilityNote(catalog.supportsImages, null)
        assertTrue(note.contains("不接受"))
    }

    /** 服务端没给 `thinking` 块 / 没给 `levels` ⇒ null（未知），**不是**空数组（“一个档位都没有”）。 */
    @Test
    fun thinkingMissingIsUnknownNotEmpty() {
        val noThinking = SettingsWire.parseModels(
            """{"sessionId":"$sid","current":"m/a","models":[{"provider":"m","id":"a","ref":"m/a","current":true}]}""",
            sid,
        )
        assertNull(noThinking.thinking)
        assertNull("没有清单就是 null", noThinking.levels)
        assertTrue("界面据此显示“清单未知”", noThinking.levels?.isEmpty() != true)

        val thinkingWithoutLevels = SettingsWire.parseModels(
            """{"sessionId":"$sid","current":"m/a","thinking":{"current":"high"},"models":[]}""",
            sid,
        )
        assertEquals("high", thinkingWithoutLevels.thinking?.current)
        assertNull("levels 缺失 ⇒ 未知", thinkingWithoutLevels.thinking?.levels)
    }

    /** 回执里自报的 `error` 必须浮上来（不吞掉、不说成“没有模型”）。 */
    @Test
    fun serverErrorIsSurfaced() {
        val catalog = SettingsWire.parseModels(
            """{"sessionId":"$sid","error":"scoped models 读取失败","models":[]}""",
            sid,
        )
        assertEquals("scoped models 读取失败", catalog.serverError)
        assertEquals(0, catalog.models.size)
        assertNull("没有当前模型 ⇒ 能力未知", catalog.supportsImages)
    }

    @Test
    fun modelsSessionMismatchIsRefused() {
        try {
            SettingsWire.parseModels("""{"sessionId":"other","models":[]}""", sid)
            fail("归属不符必须抛")
        } catch (expected: SettingsParseException) {
            assertTrue(expected.message!!.contains("不符"))
        }
    }

    // ───────────────────────── 写回执 ─────────────────────────

    /** 200 `ok:true` 且回执带了写后的值 ⇒ Applied，并且把**回读值**（不是请求值）记下来。 */
    @Test
    fun appliedRequiresReceiptProofAndUsesReadBackValue() {
        val request = SettingsRequest(model = "litellm/new", thinkingLevel = null)
        val outcome = SettingsWire.interpretWrite(
            200,
            """{"ok":true,"sessionId":"$sid","model":"litellm/clamped","previous":"litellm/old",
                "thinkingLevel":"high","previousThinkingLevel":"off","thinkingChanged":true,
                "thinkingLevels":["off","high"],"matchedBy":"provider/id","persist":false}""",
            request,
            sid,
        )
        if (outcome !is SettingsWriteOutcome.Applied) throw AssertionError("应当 Applied：$outcome")
        assertEquals("回执里的值（服务端回读）", "litellm/clamped", outcome.model)
        assertEquals("litellm/old", outcome.previousModel)
        assertEquals(true, outcome.thinkingChanged)
        assertEquals(false, outcome.persist)
        val text = SettingsProtocol.receiptText(outcome, request)
        assertTrue("说清请求值与实际值", text.contains("litellm/new") && text.contains("litellm/clamped"))
        assertTrue("如实陈述换模型后档位变成什么（这里是 off → high）", text.contains("从 off 改成了 high"))
        assertFalse("换模型这一支没有 requested 可比 ⇒ 不许用偏差话术", text.contains("不是你选的"))
        assertTrue("说清没改全局", text.contains("persist=false"))
    }

    /** 2xx 但回执里没有本次要写的那个字段 ⇒ **不确定**（不能标“已生效”）。 */
    @Test
    fun twoHundredWithoutFieldProofIsUncertain() {
        val thinkingOnly = SettingsRequest(model = null, thinkingLevel = "high")
        val missingLevel = SettingsWire.interpretWrite(
            200,
            """{"ok":true,"sessionId":"$sid","model":"m/a"}""",
            thinkingOnly,
            sid,
        )
        assertTrue("没有写后档位 ⇒ 不确定", missingLevel is SettingsWriteOutcome.Uncertain)

        val busyOkFalse = SettingsWire.interpretWrite(
            200,
            """{"ok":false,"sessionId":"$sid","model":"m/a"}""",
            SettingsRequest("m/a", null),
            sid,
        )
        assertTrue(busyOkFalse is SettingsWriteOutcome.Uncertain)

        val wrongSession = SettingsWire.interpretWrite(
            200,
            """{"ok":true,"sessionId":"another","model":"m/a"}""",
            SettingsRequest("m/a", null),
            sid,
        )
        assertTrue("归属不符 ⇒ 不确定", wrongSession is SettingsWriteOutcome.Uncertain)
    }

    /** 409 忙 / 档位不支持 ⇒ Rejected（**明确没写**），并且把服务端给的合法档位带出来。 */
    @Test
    fun rejectedCarriesServerLevels() {
        val outcome = SettingsWire.interpretWrite(
            409,
            """{"error":"thinking_level_unsupported","message":"level xhigh is not supported by this model",
                "details":{"level":"xhigh","levels":["off","medium","high"],"model":"m/a"}}""",
            SettingsRequest(null, "xhigh"),
            sid,
        )
        if (outcome !is SettingsWriteOutcome.Rejected) throw AssertionError("应当 Rejected：$outcome")
        assertEquals("thinking_level_unsupported", outcome.errorCode)
        assertEquals(listOf("off", "medium", "high"), outcome.levels)
        val text = SettingsProtocol.receiptText(outcome, SettingsRequest(null, "xhigh"))
        assertTrue("说清没写入", text.contains("没有写入"))
        assertTrue("带出合法档位", text.contains("off, medium, high"))
        assertTrue("说清服务端没静默改成别的档位", text.contains("没有静默"))
    }

    /** 408 / 5xx ⇒ Uncertain；IO 失败 ⇒ Unknown。两类都不许自动重发。 */
    @Test
    fun timeoutAndServerErrorAndIoAreNotSuccess() {
        val request = SettingsRequest("m/a", null)
        assertTrue(SettingsWire.interpretWrite(408, "", request, sid) is SettingsWriteOutcome.Uncertain)
        assertTrue(SettingsWire.interpretWrite(500, """{"error":"internal_error"}""", request, sid) is SettingsWriteOutcome.Uncertain)
        assertTrue(SettingsWire.interpretWrite(200, "", request, sid, ioFailure = true) is SettingsWriteOutcome.Unknown)
        val uncertainText = SettingsProtocol.receiptText(
            SettingsWriteOutcome.Uncertain(500, "internal_error", "boom"),
            request,
        )
        assertTrue("说清不确定", uncertainText.contains("不确定"))
        assertTrue("说清不自动重试", uncertainText.contains("不自动重试"))
    }

    /** 请求体只放**本次真的要写**的字段（思考-only 不夹带 model）。 */
    @Test
    fun requestBodyOnlyCarriesRequestedFields() {
        assertEquals("""{"model":"m/a"}""", SettingsWire.requestBody(SettingsRequest("m/a", null)))
        assertEquals("""{"thinkingLevel":"high"}""", SettingsWire.requestBody(SettingsRequest(null, "high")))
        val both = SettingsWire.requestBody(SettingsRequest("m/a", "high"))
        assertTrue(both.contains("\"model\"") && both.contains("\"thinkingLevel\""))
    }

    // ───────────────────────── 回读与档位自查 ─────────────────────────

    /** 详情回读：`runtime.model` 是对象（provider+id）⇒ 拼成 ref；`thinkingLevel` 原样取字符串。 */
    @Test
    fun readbackParsesRuntimeModelObjectAndThinkingLevel() {
        val read = SettingsWire.parseReadback(
            """{"id":"$sid","runtime":{"streaming":false,"model":{"provider":"litellm","id":"gpt-5"},"thinkingLevel":"high"}}""",
        )
        assertEquals("litellm/gpt-5", read.model)
        assertEquals("high", read.thinkingLevel)

        val missing = SettingsWire.parseReadback("""{"id":"$sid","runtime":{}}""")
        assertNull("读不到就是 null（不补默认模型）", missing.model)
        assertNull("读不到就是 null（不补默认档位）", missing.thinkingLevel)
    }

    /**
     * 组合写（`{model, thinkingLevel}` 同一条请求）的回执**必须两个值都自证**。
     * 这是 S 线定稿的原子语义：服务端先预校验两者再串行落地 ⇒ 回执少一个值就说明“这一发不能当成写成了”。
     */
    @Test
    fun combinedWriteNeedsBothValuesInReceipt() {
        val both = SettingsRequest("m/new", "high")
        val full = SettingsWire.interpretWrite(
            200,
            """{"ok":true,"sessionId":"$sid","model":"m/new","thinkingLevel":"high"}""",
            both,
            sid,
        )
        assertTrue("两个值都在 ⇒ Applied", full is SettingsWriteOutcome.Applied)

        val half = SettingsWire.interpretWrite(
            200,
            """{"ok":true,"sessionId":"$sid","model":"m/new"}""",
            both,
            sid,
        )
        assertTrue("少了写后档位 ⇒ 不确定（不能标“已生效”）", half is SettingsWriteOutcome.Uncertain)
    }

    /**
     * **正常成功的换档（off→high）不许说“不是你选的”**。
     * 服务端的 `thinkingChanged` 就是 `previous != actual`（与请求值无关）⇒ 拿它当夹取证据会把每一次正常的
     * 换档都说成“服务端改了你的选择”。判偏差只能比 `请求值 vs 回读值`。
     */
    @Test
    fun normalThinkingWriteIsNotReportedAsDeviation() {
        val request = SettingsRequest(model = null, thinkingLevel = "high")
        val outcome = SettingsWire.interpretWrite(
            200,
            """{"ok":true,"sessionId":"$sid","model":"m/a","thinkingLevel":"high",
                "previousThinkingLevel":"off","thinkingChanged":true,"persist":false}""",
            request,
            sid,
        )
        if (outcome !is SettingsWriteOutcome.Applied) throw AssertionError("应当 Applied：$outcome")
        assertEquals("服务端确实说前后不同", true, outcome.thinkingChanged)
        val text = SettingsProtocol.receiptText(outcome, request)
        assertTrue("正常写入要显示前后", text.contains("off → high"))
        assertFalse("不许说“不同”：$text", text.contains("不同"))
        assertFalse("不许说“不是你选的”：$text", text.contains("不是你选的"))
        assertFalse("不许说“连带”：$text", text.contains("连带"))
    }

    /** 请求 `max`、服务端落地 `high`（夹取/不支持）⇒ 必须说“和你选的不同”，并带 `partial:true` 作为佐证。 */
    @Test
    fun clampedThinkingWriteIsReportedAsDeviation() {
        val request = SettingsRequest(model = null, thinkingLevel = "max")
        val outcome = SettingsWire.interpretWrite(
            200,
            """{"ok":true,"sessionId":"$sid","model":"m/a","thinkingLevel":"high",
                "previousThinkingLevel":"high","thinkingChanged":false,"partial":true}""",
            request,
            sid,
        )
        if (outcome !is SettingsWriteOutcome.Applied) throw AssertionError("应当 Applied：$outcome")
        assertEquals(true, outcome.partial)
        val text = SettingsProtocol.receiptText(outcome, request)
        assertTrue("必须说与选择不同：$text", text.contains("你在本页选的 max 不同"))
    }

    /** 只换模型、本次没请求改档位，而写前/写后档位真值不同 ⇒ 只能陈述“换模型后档位变成了 Y”。 */
    @Test
    fun modelSwitchSideEffectIsReportedOnlyWithBeforeAfterEvidence() {
        val request = SettingsRequest(model = "m/new", thinkingLevel = null)
        val changed = SettingsWire.interpretWrite(
            200,
            """{"ok":true,"sessionId":"$sid","model":"m/new","previous":"m/old",
                "thinkingLevel":"low","previousThinkingLevel":"high","thinkingChanged":true}""",
            request,
            sid,
        )
        if (changed !is SettingsWriteOutcome.Applied) throw AssertionError("应当 Applied：$changed")
        val text = SettingsProtocol.receiptText(changed, request)
        assertTrue("说清是服务端换模型时改的：$text", text.contains("只要求换模型") && text.contains("从 high 改成了 low"))
        assertFalse("这一支不许说“不是你选的”（没有 requested 可比）：$text", text.contains("不是你选的"))

        // 档位前后没变（或服务端没给 before/after）⇒ 一个字都不该说。
        val unchanged = SettingsWire.interpretWrite(
            200,
            """{"ok":true,"sessionId":"$sid","model":"m/new","previous":"m/old",
                "thinkingLevel":"high","previousThinkingLevel":"high","thinkingChanged":false}""",
            request,
            sid,
        )
        if (unchanged !is SettingsWriteOutcome.Applied) throw AssertionError("应当 Applied：$unchanged")
        assertFalse("没变就不许说被换模型改了", SettingsProtocol.receiptText(unchanged, request).contains("改成了"))
    }

    companion object {
        /** 形状逐字照 S 线定稿（`thinking` 块 + 每个模型的 `input`/`supportsImages`/`thinkingLevels`）。 */
        private const val MODELS_BODY = """{
          "sessionId":"11111111-1111-4111-8111-111111111111",
          "hot":true,
          "error":null,
          "current":"litellm/gpt-5",
          "source":"scoped",
          "thinking":{"current":"off","levels":["off","low","high"]},
          "models":[
            {"provider":"litellm","id":"gpt-5","name":"GPT-5","ref":"litellm/gpt-5","reasoning":true,
             "contextWindow":272000,"current":true,"input":["text","image"],"supportsImages":true,
             "thinkingLevels":["low","high"]},
            {"provider":"litellm","id":"text-only","name":"Text only","ref":"litellm/text-only","reasoning":false,
             "contextWindow":128000,"current":false,"input":["text"],"supportsImages":false,
             "thinkingLevels":[]}
          ]
        }"""
    }
}
