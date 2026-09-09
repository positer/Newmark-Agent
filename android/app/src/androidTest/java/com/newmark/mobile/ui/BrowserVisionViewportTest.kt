package com.newmark.mobile.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.webkit.WebView
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class BrowserVisionViewportTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun pdf(name: String, scanned: Boolean): File {
        val file = File(context.cacheDir, name)
        val document = PdfDocument()
        try {
            val page = document.startPage(PdfDocument.PageInfo.Builder(600, 400, 1).create())
            val paint = Paint().apply { color = Color.BLACK; textSize = 28f }
            if (scanned) {
                val bitmap = Bitmap.createBitmap(600, 300, Bitmap.Config.ARGB_8888)
                Canvas(bitmap).apply { drawColor(Color.WHITE); drawText("SCANNED PDF TEXT 12345", 20f, 100f, paint) }
                page.canvas.drawBitmap(bitmap, 0f, 0f, null); bitmap.recycle()
            } else page.canvas.drawText("Compressed PDF binary text extraction fixture 12345", 10f, 100f, paint)
            document.finishPage(page)
            file.outputStream().use { document.writeTo(it) }
        } finally { document.close() }
        return file
    }
    @Test fun binaryPdfTextPrecedesVisionAndScannedPdfUsesRenderedPage() = runBlocking {
        val web = withContext(Dispatchers.Main) { WebView(context).apply { applyNewmarkBrowserSettings() } }
        var calls = 0
        val recognition = BrowserRecognition(context, web, { image -> calls++; assertTrue(image.startsWith("data:image/jpeg;base64,")); "Visual PDF result" })
        try {
            val text = recognition.recognize(pdf("binary.pdf", false).toURI().toString(), 12000)
            assertEquals(text.toString(), "pdf_text_layer", text.optString("source")); assertEquals(0, calls)
            assertTrue(text.optString("text").contains("Compressed PDF"))
            val scan = recognition.recognize(pdf("scan.pdf", true).toURI().toString(), 12000)
            assertEquals(scan.toString(), "vision_model", scan.optString("source")); assertEquals(1, calls)
            assertEquals("first_page_only", scan.optString("scope"))
            val ocr = BrowserRecognition(context, web, { throw IllegalStateException("offline fixture") }).use {
                it.recognize(File(context.cacheDir, "scan.pdf").toURI().toString(), 12000)
            }
            assertEquals(ocr.toString(), "mlkit-bundled", ocr.optString("engine")); assertTrue(ocr.optString("text").contains("12345"))
        } finally { recognition.close(); withContext(Dispatchers.Main) { web.destroy() } }
    }
    @Test fun extensionlessWebPdfRoutesFromDownloadMimeToBinaryReader() = runBlocking {
        val bytes = pdf("web-fixture.pdf", false).readBytes()
        val server = java.net.ServerSocket(0)
        val cookieRequests = java.util.concurrent.atomic.AtomicInteger()
        val thread = kotlin.concurrent.thread(isDaemon = true) {
            while (!server.isClosed) try {
                server.accept().use { socket ->
                    val reader = socket.getInputStream().bufferedReader()
                    var line = reader.readLine()
                    while (!line.isNullOrBlank()) {
                        if (line.startsWith("Cookie:", true) && line.contains("pdfFixture=yes")) cookieRequests.incrementAndGet()
                        line = reader.readLine()
                    }
                    socket.getOutputStream().apply {
                        write(("HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=report.pdf\r\nContent-Length: " + bytes.size + "\r\nConnection: close\r\n\r\n").toByteArray())
                        write(bytes); flush()
                    }
                }
            } catch (_: Exception) { }
        }
        val url = "http://127.0.0.1:${server.localPort}/download?id=42"
        val session = BrowserSessionState()
        val host = withContext(Dispatchers.Main) {
            android.webkit.CookieManager.getInstance().setCookie(url, "pdfFixture=yes")
            BackgroundBrowserHost(context, session)
        }
        try {
            assertTrue(host.execute(JSONObject().put("action", "navigate").put("url", url)).ok)
            val result = host.execute(JSONObject().put("action", "observe"))
            assertTrue(result.output, result.ok)
            assertTrue(result.output, result.output.contains("pdfbox_binary"))
            assertTrue(session.isPdfDocument)
            assertTrue(cookieRequests.get() >= 2)
        } finally { withContext(Dispatchers.Main) { host.close() }; server.close(); thread.join(1000) }
    }

    @Test fun requestedViewportIsRealInPanelAndBackground() = runBlocking {
        withContext(Dispatchers.Main) {
            val web = WebView(context).apply { applyNewmarkBrowserSettings(); loadData("<h1>viewport</h1>", "text/html", "UTF-8") }
            try {
                delay(500)
                val background = applyBrowserViewport(web, 800 to 600)
                assertEquals(background.toString(), 800, background.optInt("width")); assertEquals(600, background.optInt("height"))
                val panel = BrowserViewportLayout(context, web)
                val exact = android.view.View.MeasureSpec.EXACTLY
                panel.measure(android.view.View.MeasureSpec.makeMeasureSpec(400, exact), android.view.View.MeasureSpec.makeMeasureSpec(600, exact)); panel.layout(0,0,400,600)
                val visible = applyBrowserViewport(web, 390 to 844)
                assertEquals(visible.toString(), 390, visible.optInt("width")); assertEquals(844, visible.optInt("height"))
                assertTrue(web.scaleX <= 1f)
                BrowserRecognition(context, web, { data ->
                    val bytes = android.util.Base64.decode(data.substringAfter(','), android.util.Base64.DEFAULT)
                    File(context.cacheDir, "browser-viewport.jpg").writeBytes(bytes)
                    val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    assertEquals(web.width, bitmap.width); assertEquals(web.height, bitmap.height)
                    var dark = 0
                    for (y in 0 until minOf(bitmap.height, 250)) for (x in 0 until minOf(bitmap.width, 500)) {
                        if (Color.red(bitmap.getPixel(x, y)) < 100) dark++
                    }
                    bitmap.recycle()
                    assertTrue("WebView screenshot must contain rendered heading pixels", dark > 20)
                    "Rendered heading"
                }).use { assertEquals("vision_model", it.recognize("https://fixture.invalid", 12000).optString("source")) }
                panel.removeView(web)
            } finally { web.destroy() }
        }
    }
    @Test fun sessionTextPriorityForceVisionAndInvalidViewport() = runBlocking {
        val session = BrowserSessionState()
        var calls = 0
        session.bindRecognition { _, _ -> calls++; JSONObject().put("ok", true).put("source", "vision_model").put("text", "visual") }
        session.onPublicText("This DOM has sufficient readable text to avoid a visual request")
        assertTrue(session.executeTool(JSONObject().put("action", "observe")).ok); assertEquals(0, calls)
        assertTrue(session.executeTool(JSONObject().put("action", "observe").put("visual_mode", "vision")).ok); assertEquals(1, calls)
        assertFalse(session.executeTool(JSONObject().put("action", "observe").put("viewport", JSONObject().put("width", 0).put("height", 600))).ok)
        session.onPdfDocument("https://fixture.invalid/download?id=1")
        assertTrue(session.isPdfDocument)
        assertTrue(session.executeTool(JSONObject().put("action", "observe")).ok); assertEquals(2, calls)
    }
}
