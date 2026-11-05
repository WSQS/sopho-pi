package dev.sopho.pi.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 带图发送的**计划与回执**：`SendPlan` 扩了 `images`，但文本那条老路必须一字不变
 * （旧的 `SendProtocolTest` 150 条里已经在钉这一点；这里钉新增的那部分）。
 */
class SendProtocolImagesTest {

    private val onePng = listOf(ImagePayload("image/png", "QUJD"))
    private val sid = "0aa01827-0000-4000-8000-000000000001"

    // ── 计划 ──

    @Test
    fun textOnlyPlanIsUnchanged() {
        val plan = SendProtocol.plan(sid, "  看这个 ", busy = false)!!
        assertEquals("看这个", plan.text)
        assertEquals(SendRoute.MESSAGE, plan.route)
        assertTrue(plan.images.isEmpty())
        // 空文本 + 没有图 ⇒ 仍然是 null（老的“内容为空”分支照旧）。
        assertNull(SendProtocol.plan(sid, "   ", busy = false))
    }

    @Test
    fun pureImageIsAPlan_withEmptyText() {
        val plan = SendProtocol.plan(sid, "", busy = false, hasImages = true)!!
        assertEquals("", plan.text)
        assertEquals(SendRoute.MESSAGE, plan.route)
    }

    @Test
    fun pureImageWhileBusy_goesSteer_neverDowngradedToText() {
        val plan = SendProtocol.plan(sid, "  ", busy = true, hasImages = true)!!
        assertEquals(SendRoute.STEER, plan.route)
        assertEquals("", plan.text)
    }

    @Test
    fun slashShapeStillForcesMessage_evenWedgedImages() {
        val plan = SendProtocol.plan(sid, "/compact", busy = true, hasImages = true)!!
        assertEquals(SendRoute.MESSAGE, plan.route)
    }

    @Test
    fun withImages_attachesToPlan_andSurvivesFallback() {
        val base = SendProtocol.plan(sid, "看这张", busy = true)!!
        val plan = SendProtocol.withImages(base, onePng)
        assertEquals(1, plan.images.size)
        // 忙 ⇒ 先按 steer 发，被 409 session_not_streaming 拒 ⇒ 切一次 message，图**不能丢**。
        val rejected = SendOutcome.Rejected(409, "session_not_streaming", "")
        val next = SendProtocol.fallback(plan, rejected)!!
        assertEquals(SendRoute.MESSAGE, next.route)
        assertEquals(1, next.images.size)
        assertEquals("看这张", next.text)
    }

    @Test
    fun sendPlanToString_neverContainsBase64() {
        val plan = SendProtocol.withImages(SendProtocol.plan(sid, "x", busy = false)!!, onePng)
        assertTrue(!plan.toString().contains("QUJD"))
    }

    // ── 回执 ──

    private fun planWithImage() = SendProtocol.withImages(SendProtocol.plan(sid, "看这张", busy = false)!!, onePng)

    @Test
    fun acceptedWithoutImageEvidence_isNotAccepted() {
        val outcome = SendProtocol.interpretAccepted(
            plan = planWithImage(),
            httpStatus = 202,
            accepted = true,
            sessionId = sid,
            mode = null,
            imagesAcked = null,
        )
        assertTrue(outcome is SendOutcome.Uncertain)
        assertEquals("images_not_acknowledged", (outcome as SendOutcome.Uncertain).errorCode)
        assertTrue(SendProtocol.failureText(outcome).contains("没有确认图片"))
        assertTrue(SendProtocol.failureText(outcome).contains("草稿与图片都保留"))
    }

    @Test
    fun acceptedWithMatchingImageEvidence_isAccepted() {
        val outcome = SendProtocol.interpretAccepted(
            plan = planWithImage(),
            httpStatus = 202,
            accepted = true,
            sessionId = sid,
            mode = null,
            imagesAcked = 1,
        )
        assertTrue(outcome is SendOutcome.Accepted)
        val text = SendProtocol.acceptedText(planWithImage(), outcome as SendOutcome.Accepted)
        assertTrue("回执要说清带了图、且是服务端确认的", text.contains("带 1 张图片"))
        assertTrue(text.contains("不是“已回答”"))
    }

    @Test
    fun acceptedWithFewerImagesThanSent_isNotAccepted() {
        val outcome = SendProtocol.interpretAccepted(
            plan = planWithImage(),
            httpStatus = 202,
            accepted = true,
            sessionId = sid,
            mode = null,
            imagesAcked = 0,
        )
        assertEquals("images_not_acknowledged", (outcome as SendOutcome.Uncertain).errorCode)
    }

    @Test
    fun textOnlyReceiptDoesNotNeedImageEvidence() {
        val plan = SendProtocol.plan(sid, "只有文字", busy = false)!!
        val outcome = SendProtocol.interpretAccepted(plan, 202, true, sid, null, imagesAcked = null)
        assertTrue(outcome is SendOutcome.Accepted)
        // 老口径不变：纯文本回执仍然可接受、文案里没有“带 N 张图片”。
        assertTrue(!SendProtocol.acceptedText(plan, outcome as SendOutcome.Accepted).contains("张图片"))
    }

    @Test
    fun steerWithImage_needsModeSteerAndImageEvidence() {
        val plan = SendProtocol.withImages(SendProtocol.plan(sid, "插一句", busy = true)!!, onePng)
        assertEquals(SendRoute.STEER, plan.route)
        val missingMode = SendProtocol.interpretAccepted(plan, 202, true, sid, null, imagesAcked = 1)
        assertEquals("route_mismatch", (missingMode as SendOutcome.Uncertain).errorCode)
        val ok = SendProtocol.interpretAccepted(plan, 202, true, sid, "steer", imagesAcked = 1)
        assertTrue(ok is SendOutcome.Accepted)
        assertEquals(SendRoute.STEER, (ok as SendOutcome.Accepted).route)
    }

    // ── 服务端图片错误码的文案与“确定没入队” ──

    @Test
    fun imageErrorCodes_areAllTreatedAsNotEnqueued_withTheirOwnWording() {
        val cases = mapOf(
            "invalid_images" to "形状",
            "invalid_image_data" to "解不开",
            "too_many_images" to "4 张",
            "image_too_large" to "4 MiB",
            "body_too_large" to "请求体",
            "unsupported_image_type" to "image/jpeg",
            "model_does_not_support_images" to "读不了图",
        )
        for ((code, needle) in cases) {
            val outcome = SendOutcome.Rejected(400, code, "")
            assertTrue("$code 必须算“确定没入队”", SendProtocol.safeToRetry(outcome))
            val text = SendProtocol.failureText(outcome)
            assertTrue("$code 的文案要写清原因", text.contains(needle))
            assertTrue("$code 的文案要说草稿与图片都保留", text.contains("保留"))
        }
    }

    @Test
    fun unknown4xxStaysUncertain_notSafeToRetry() {
        val outcome = SendOutcome.Rejected(404, "session_not_found", "")
        assertTrue(!SendProtocol.safeToRetry(outcome))
    }

    // ── 发送前的图片闸 ──

    @Test
    fun gate_passesWithoutImages() {
        assertEquals(ImageSendCheck.Ok, SendImageGate.check("只有文字", emptyList(), modelCapability = null))
    }

    @Test
    fun gate_passesNormalImage_whenServerSaidNothing() {
        assertEquals(ImageSendCheck.Ok, SendImageGate.check("看图", onePng, modelCapability = null))
        assertEquals(ImageSendCheck.Ok, SendImageGate.check("看图", onePng, modelCapability = true))
    }

    @Test
    fun gate_refusesWhenModelIsKnownToBeBlind() {
        val refused = SendImageGate.check("看图", onePng, modelCapability = false)
        assertTrue(refused is ImageSendCheck.Refused)
        assertTrue((refused as ImageSendCheck.Refused).receipt.contains("不可读图"))
        assertTrue(refused.receipt.contains("保留"))
    }

    @Test
    fun gate_refusesOversizedImage_beforeAnyRequest() {
        val huge = "A".repeat(((ImageLimits.MAX_ENCODED_BYTES / 3) + 10) * 4)
        val refused = SendImageGate.check("看图", listOf(ImagePayload("image/png", huge)), modelCapability = true)
        assertTrue(refused is ImageSendCheck.Refused)
    }

    @Test
    fun gate_doesNotCareAboutBusy_becauseSteerAcceptsImages() {
        // 忙时照样能发（steer 收图）；闸里**没有**任何“忙就拒”的分支。
        assertEquals(ImageSendCheck.Ok, SendImageGate.check("看图", onePng, modelCapability = true))
    }
}
