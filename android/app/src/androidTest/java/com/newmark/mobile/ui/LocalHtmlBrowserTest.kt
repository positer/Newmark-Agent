package com.newmark.mobile.ui

import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class LocalHtmlBrowserTest {
    @Test fun localHtmlLoadsRelativeAssetsAndLinksWithoutUniversalFileAccess() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.cacheDir, "本地 pages").apply { mkdirs() }
        val entry = File(directory, "index #1.html").apply {
            writeText("<meta charset='utf-8'><title>Local ready</title><link rel='stylesheet' href='style.css'><h1>本地 HTML</h1><script src='script.js'></script><a id='next' href='next.html'>Next</a>")
        }
        File(directory, "style.css").writeText("h1 { color: rgb(12, 34, 56) }")
        File(directory, "script.js").writeText("document.body.dataset.script='ready'")
        File(directory, "next.html").writeText("<title>Next ready</title>")
        lateinit var view: WebView
        var loaded = CountDownLatch(1)
        instrumentation.runOnMainSync {
            view = WebView(instrumentation.targetContext)
            view.applyNewmarkBrowserSettings()
            assertTrue(view.settings.allowFileAccess)
            @Suppress("DEPRECATION")
            assertFalse(view.settings.allowUniversalAccessFromFileURLs)
            view.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) { loaded.countDown() }
            }
        }
        fun evaluate(script: String): String {
            val completed = CountDownLatch(1)
            var result = ""
            instrumentation.runOnMainSync { view.evaluateJavascript(script) { result = it; completed.countDown() } }
            assertTrue(completed.await(15, TimeUnit.SECONDS))
            return result
        }
        try {
            for (raw in listOf(entry.absolutePath, entry.toURI().toASCIIString(), entry.toURI().toASCIIString().replace("file:", "files://"))) {
                loaded = CountDownLatch(1)
                val session = BrowserSessionState()
                assertTrue(session.navigate(raw))
                instrumentation.runOnMainSync { view.loadUrl(session.command.url) }
                assertTrue("Local document loaded: $raw", loaded.await(20, TimeUnit.SECONDS))
                assertEquals("\"Local ready\"", evaluate("document.title"))
                assertEquals("\"ready\"", evaluate("document.body.dataset.script"))
                assertEquals("\"rgb(12, 34, 56)\"", evaluate("getComputedStyle(document.querySelector('h1')).color"))
            }
            loaded = CountDownLatch(1)
            evaluate("document.querySelector('#next').click()")
            assertTrue(loaded.await(20, TimeUnit.SECONDS))
            assertEquals("\"Next ready\"", evaluate("document.title"))
        } finally {
            instrumentation.runOnMainSync { view.destroy() }
        }
    }
}
