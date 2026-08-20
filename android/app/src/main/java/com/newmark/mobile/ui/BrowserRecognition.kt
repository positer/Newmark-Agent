package com.newmark.mobile.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.webkit.CookieManager
import android.webkit.WebView
import com.google.android.gms.tasks.Task
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private const val RecognitionOrder = "text>vision>local_ocr"
private const val MaxPdfBytes = 250L * 1024L * 1024L
private val RepairPrompt = listOf(
    "本地 OCR 只是近似的中英文回退证据。",
    "请结合当前网页/PDF 上下文保守修复可能的字符替换、空格和换行。",
    "公式仅在上下文支持时恢复运算符、变量、上下标与分组。",
    "不得补写 OCR 或上下文无法支持的内容；有歧义时保留不确定性。",
).joinToString("")

/** Lightweight recognition bound to one conversation-scoped WebView. */
class BrowserRecognition(private val context: Context, private val webView: WebView) : AutoCloseable {
    private val latin = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    private val chinese = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    suspend fun recognize(url: String, maxChars: Int): JSONObject = runCatching {
        if (url.substringBefore('#').substringBefore('?').endsWith(".pdf", ignoreCase = true)) {
            recognizePdf(url, maxChars)
        } else {
            val bitmap = captureWebView()
            ocrReceipt(bitmap, maxChars, "webview_screenshot", "sparse-ui")
        }
    }.getOrElse { error ->
        JSONObject()
            .put("ok", false)
            .put("source", "local_ocr")
            .put("recognition_order", RecognitionOrder)
            .put("error", error.message.orEmpty().ifBlank { "本地识别失败" }.take(320))
            .put("agent_repair_prompt", RepairPrompt)
    }

    private suspend fun recognizePdf(url: String, maxChars: Int): JSONObject {
        val pdf = downloadPdf(url)
        try {
            val text = extractPdfTextLayer(pdf.readBytes()).take(maxChars)
            if (text.count { it.isLetterOrDigit() } >= 20) {
                return JSONObject()
                    .put("ok", true)
                    .put("source", "pdf_text_layer")
                    .put("recognition_order", RecognitionOrder)
                    .put("text", text)
                    .put("truncated", text.length >= maxChars)
            }
            return ocrReceipt(renderPdfFirstPage(pdf), maxChars, "pdf_rendered_page", "academic-document")
                .put("page", 1)
        } finally {
            pdf.delete()
        }
    }

    private suspend fun captureWebView(): Bitmap = withContext(Dispatchers.Main.immediate) {
        val width = webView.width.coerceAtLeast(1)
        val height = webView.height.coerceAtLeast(1)
        require(width.toLong() * height <= 16_000_000L) { "WebView 截图尺寸过大" }
        Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { bitmap ->
            bitmap.eraseColor(Color.WHITE)
            webView.draw(Canvas(bitmap))
        }
    }

    private suspend fun ocrReceipt(bitmap: Bitmap, maxChars: Int, source: String, profile: String): JSONObject {
        try {
            val image = InputImage.fromBitmap(bitmap, 0)
            val latinText = latin.process(image).await().text.trim()
            val chineseText = chinese.process(image).await().text.trim()
            val text = mergeRecognitions(latinText, chineseText).take(maxChars)
            return JSONObject()
                .put("ok", text.isNotBlank())
                .put("source", source)
                .put("recognition_order", RecognitionOrder)
                .put("engine", "mlkit-bundled")
                .put("languages", "chi_sim+eng")
                .put("approximate", true)
                .put("profile", profile)
                .put("text", text)
                .put("agent_repair_prompt", RepairPrompt)
                .put("truncated", text.length >= maxChars)
                .apply { if (text.isBlank()) put("error", "本地 OCR 未识别到可读的中英文文本") }
        } finally {
            bitmap.recycle()
        }
    }

    private suspend fun downloadPdf(url: String): File = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url.substringBefore('#')).apply {
            CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotBlank() }?.let { header("Cookie", it) }
        }.build()
        val target = File.createTempFile("browser-", ".pdf", context.cacheDir)
        try {
            http.newCall(request).execute().use { response ->
                require(response.isSuccessful) { "PDF 下载失败：HTTP ${response.code}" }
                val body = requireNotNull(response.body) { "PDF 响应为空" }
                val length = body.contentLength()
                require(length in -1L..MaxPdfBytes) { "PDF 必须小于 250 MiB" }
                body.byteStream().use { input ->
                    target.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            total += count
                            require(total <= MaxPdfBytes) { "PDF 必须小于 250 MiB" }
                            output.write(buffer, 0, count)
                        }
                    }
                }
            }
            require(target.inputStream().use { input -> String(input.readNBytes(5), Charsets.US_ASCII) } == "%PDF-") {
                "目标不是有效 PDF"
            }
            target
        } catch (error: Throwable) {
            target.delete()
            throw error
        }
    }

    private fun renderPdfFirstPage(file: File): Bitmap {
        val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        PdfRenderer(descriptor).use { renderer ->
            require(renderer.pageCount > 0) { "PDF 没有可渲染页面" }
            renderer.openPage(0).use { page ->
                val scale = (1800f / page.width.coerceAtLeast(1)).coerceIn(1f, 3f)
                val bitmap = Bitmap.createBitmap((page.width * scale).toInt(), (page.height * scale).toInt(), Bitmap.Config.ARGB_8888)
                bitmap.eraseColor(Color.WHITE)
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                return bitmap
            }
        }
    }

    override fun close() {
        latin.close()
        chinese.close()
    }
}

internal fun extractPdfTextLayer(bytes: ByteArray): String {
    val raw = bytes.toString(Charsets.ISO_8859_1)
    return Regex("\\((?:\\\\.|[^\\)]){2,}\\)\\s*(?:Tj|'|\")")
        .findAll(raw)
        .map { match ->
            match.value.substringAfter('(').substringBeforeLast(')')
                .replace(Regex("\\\\([()\\\\])"), "$1")
                .replace("\\n", "\n")
                .replace("\\r", "\n")
        }
        .joinToString(" ")
        .replace(Regex("[ \\t]+"), " ")
        .replace(Regex("\\n{3,}"), "\n\n")
        .trim()
}

internal fun mergeRecognitions(latin: String, chinese: String): String {
    if (latin.isBlank()) return chinese
    if (chinese.isBlank()) return latin
    val latinReadable = latin.count { it.isLetterOrDigit() }
    val chineseReadable = chinese.count { it.isLetterOrDigit() }
    return if (chineseReadable >= latinReadable) chinese else latin
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { continuation ->
    addOnSuccessListener { continuation.resume(it) }
    addOnFailureListener { continuation.resumeWithException(it) }
    addOnCanceledListener { continuation.cancel() }
}
