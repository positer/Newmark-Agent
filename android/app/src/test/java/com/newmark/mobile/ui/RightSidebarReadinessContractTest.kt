package com.newmark.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RightSidebarReadinessContractTest {
    @Test
    fun addressCursorKeepsAnEdgeMarginByMovingTheWholeInputRange() {
        assertEquals(0, browserAddressScrollTarget(4f, 5f, 20, 100, 300, 14f))
        assertEquals(65, browserAddressScrollTarget(150f, 151f, 20, 100, 300, 14f))
        assertEquals(40, browserAddressScrollTarget(70f, 71f, 40, 100, 300, 14f))
        assertEquals(300, browserAddressScrollTarget(480f, 490f, 200, 100, 300, 14f))
    }

    @Test
    fun visibleBrowserMountsOnDemandWhileInvisibleToolsStayOutsideCompose() {
        val root = generateSequence(File(System.getProperty("user.dir") ?: ".")) { it.parentFile }
            .first { File(it, "android/app/src").isDirectory }
        val sidebar = File(root, "android/app/src/main/java/com/newmark/mobile/ui/RightSidebar.kt").readText()
        val app = File(root, "android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt").readText()
        val instrumented = File(root, "android/app/src/androidTest/java/com/newmark/mobile/ui/BackgroundBrowserHostInstrumentedTest.kt").readText()

        assertFalse(sidebar.contains("delay(450)"))
        assertTrue(sidebar.contains("visible || session.hasActivity"))
        assertFalse(sidebar.contains("keepMounted"))
        assertTrue(sidebar.contains("View.INVISIBLE"))
        assertTrue(sidebar.contains("class BackgroundBrowserHost("))
        assertTrue(sidebar.contains("WebView(context.applicationContext)"))
        assertTrue(sidebar.contains("visibility = View.GONE"))
        assertTrue(sidebar.contains("get() = webView.parent != null"))
        assertFalse(sidebar.substringAfter("class BackgroundBrowserHost(").substringBefore("/** PC #right").contains("AndroidView("))
        assertTrue(sidebar.contains("horizontalScroll(addressScroll)"))
        assertTrue(app.contains("RightSidebarTab.Plan, RightSidebarTab.Browser, RightSidebarTab.Uploads"))
        assertTrue(app.contains("!args.has(\"visible\") -> true"))
        assertTrue(app.contains("browserSessions.backgroundSession(browserTargetKey)"))
        assertTrue(app.contains("BackgroundBrowserHost("))
        assertTrue(app.contains("backgroundBrowserHosts.remove(targetKey)?.close()"))
        assertTrue(app.contains("browserSessions.releaseBackgroundSession(targetKey)"))
        val binding = app.substringAfter("val handler: suspend (org.json.JSONObject)")
            .substringBefore("vm.bindLocalBrowserTools")
        assertFalse(binding.contains("rightSidebarExpanded = true"))
        assertFalse(binding.contains("rightSidebarTab = RightSidebarTab.Browser"))
        assertTrue(instrumented.contains("assertFalse(host.isAttachedToUi)"))
        assertFalse(app.contains("if (rightProgress > 0.001f) {"))
    }
}
