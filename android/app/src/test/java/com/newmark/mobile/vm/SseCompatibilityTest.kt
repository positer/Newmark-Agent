package com.newmark.mobile.vm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SseCompatibilityTest {
    @Test
    fun acceptsSseDataWithAndWithoutLegacySpace() {
        assertEquals("{\"type\":\"thought_delta\"}", sseDataPayload("data: {\"type\":\"thought_delta\"}"))
        assertEquals("{\"type\":\"thought_delta\"}", sseDataPayload("data:{\"type\":\"thought_delta\"}"))
        assertNull(sseDataPayload("event: work"))
        assertNull(sseDataPayload("data:"))
    }
}
