package com.newmark.mobile.ui

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Test

class BackgroundBrowserHostInstrumentedTest {
    @Test
    fun invisibleBrowserHostIsNeverAttachedToAViewHierarchy() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val host = BackgroundBrowserHost(instrumentation.targetContext, BrowserSessionState())
            try {
                assertFalse(host.isAttachedToUi)
            } finally {
                host.close()
            }
        }
    }
}
