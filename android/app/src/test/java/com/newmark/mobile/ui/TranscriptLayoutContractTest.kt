package com.newmark.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class TranscriptLayoutContractTest {
    @Test
    fun transcriptKeepsTenScrollableLinesBelowTheLatestMessage() {
        assertEquals(10, TranscriptBottomReserveLines)
        assertEquals(190, TranscriptBottomReserveDp)
    }
}
