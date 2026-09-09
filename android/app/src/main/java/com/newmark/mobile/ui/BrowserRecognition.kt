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
class BrowserRecognition(
    private val context: Context,
    private val webView: WebView,
    private val inspectImage: suspend (String) -> String = { "" },
    private val isPdf: () -> Boolean = { false },
) : AutoCloseable {
    private val latin = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    private val chinese = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    suspend fun recognize(url: String, maxChars: Int, forceVision: Boolean = false, pdfPage: Int? = null): JSONObject = runCatching {
        if (isPdf() || url.substringBefore('#').substringBefore('?').endsWith(".pdf", ignoreCase = true)) {
            recognizePdf(url, maxChars, forceVision, pdfPage)
        } else {
            val bitmap = captureWebView()
            visualReceipt(bitmap, maxChars, "webview_screenshot", "sparse-ui")
        }
    }.getOrElse { error ->
        if (error is kotlinx.coroutines.CancellationException) throw error
        JSONObject()
            .put("ok", false)
            .put("source", "local_ocr")
            .put("recognition_order", RecognitionOrder)
            .put("error", error.message.orEmpty().ifBlank { "本地识别失败" }.take(320))
            .put("agent_repair_prompt", RepairPrompt)
    }

    private suspend fun recognizePdf(url: String, maxChars: Int, forceVision: Boolean, pdfPage: Int?): JSONObject {
        val pdf = downloadPdf(url)
        try {
            var pageCount = 0
            val text = try { withContext(Dispatchers.IO) {
                com.tom_roush.pdfbox.android.PDFBoxResourceLoader.init(context)
                com.tom_roush.pdfbox.pdmodel.PDDocument.load(pdf).use { document ->
                    pageCount = document.numberOfPages
                    com.tom_roush.pdfbox.text.PDFTextStripper().apply {
                        if (pdfPage != null) { require(pdfPage <= document.numberOfPages); startPage = pdfPage; endPage = pdfPage }
                    }.getText(document).trim().take(maxChars)
                }
            } } catch (error: kotlinx.coroutines.CancellationException) { throw error } catch (_: Exception) { "" }
            if (!forceVision && text.count { it.isLetterOrDigit() } >= 20) {
                return JSONObject()
                    .put("ok", true)
                    .put("source", "pdf_text_layer")
                    .put("engine", "pdfbox_binary").put("pages", pageCount)
                    .put("page", pdfPage).put("scope", if (pdfPage == null) "document_text" else "selected_page_only")
                    .put("recognition_order", RecognitionOrder)
                    .put("text", text)
                    .put("truncated", text.length >= maxChars)
            }
            return visualReceipt(renderPdfPage(pdf, pdfPage ?: 1), maxChars, "pdf_rendered_page", "academic-document")
                .put("pages", pageCount).put("page", pdfPage ?: 1).put("scope", if (pdfPage == null) "first_page_only" else "selected_page_only").put("engine_pdf", "pdfbox_binary+PdfRenderer")
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

    private suspend fun visualReceipt(bitmap: Bitmap, maxChars: Int, source: String, profile: String): JSONObject {
        val dataUrl = java.io.ByteArrayOutputStream().use { output ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, 82, output)
            "data:image/jpeg;base64," + android.util.Base64.encodeToString(output.toByteArray(), android.util.Base64.NO_WRAP)
        }
        val text = try { inspectImage(dataUrl) } catch (error: kotlinx.coroutines.CancellationException) {
            bitmap.recycle()
            throw error
        } catch (_: Exception) { "" }
        if (text.isNotBlank()) {
            bitmap.recycle()
            return JSONObject().put("ok", true).put("source", "vision_model")
                .put("recognition_order", RecognitionOrder).put("approximate", true)
                .put("text", text.take(maxChars)).put("truncated", text.length > maxChars)
        }
        return ocrReceipt(bitmap, maxChars, source, profile)
            .put("visual_model_error", "Visual collaborator unavailable or failed; using local OCR")
    }

    private suspend fun ocrReceipt(bitmap: Bitmap, maxChars: Int, source: String, profile: String): JSONObject {
        try {
            val image = InputImage.fromBitmap(bitmap, 0)
            val latinText = latin.process(image).await().text.trim()
            val chineseText = chinese.process(image).await().text.trim()
            val text = mergeRecognitions(latinText, chineseText).take(maxChars)
            val receipt = JSONObject()
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
            if (text.isNotBlank()) {
                receipt.put("fallback", "mini_ocr")
                receipt.put("uncertainty", "raw_ocr_only")
            }
            return receipt
        } finally {
            bitmap.recycle()
        }
    }

    private suspend fun downloadPdf(url: String): File = withContext(Dispatchers.IO) {
        val target = File.createTempFile("browser-", ".pdf", context.cacheDir)
        fun copyBounded(input: java.io.InputStream) {
            input.use { stream -> target.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val count = stream.read(buffer)
                    if (count < 0) break
                    total += count
                    require(total <= MaxPdfBytes) { "PDF must be smaller than 250 MiB" }
                    output.write(buffer, 0, count)
                }
            } }
        }
        try {
            val uri = android.net.Uri.parse(url.substringBefore('#'))
            when (uri.scheme?.lowercase()) {
                "file", "content" -> copyBounded(requireNotNull(context.contentResolver.openInputStream(uri)))
                "blob" -> {
                    val encoded = withContext(Dispatchers.Main.immediate) {
                        kotlinx.coroutines.suspendCancellableCoroutine<String> { continuation ->
                            val quoted = JSONObject.quote(url)
                            // evaluateJavascript does not await promises: poll a private temporary result.
                            val key = "__newmarkPdf" + java.util.UUID.randomUUID().toString().replace("-", "")
                            webView.evaluateJavascript("(function(){fetch(" + quoted + ").then(r=>r.blob()).then(b=>{if(b.size>" + MaxPdfBytes + ")throw Error('PDF too large');const f=new FileReader();f.onload=()=>window['" + key + "']=f.result;f.readAsDataURL(b)}).catch(()=>window['" + key + "']='error');})()", null)
                            val poll = object : Runnable {
                                var attempts = 0
                                override fun run() {
                                    if (!continuation.isActive) { webView.evaluateJavascript("delete window['" + key + "']", null); return }
                                    webView.evaluateJavascript("window['" + key + "'] || ''") { value ->
                                        val result = runCatching { org.json.JSONArray("[$value]").getString(0) }.getOrDefault("")
                                        if (result.isNotBlank() || ++attempts >= 150) {
                                            webView.evaluateJavascript("delete window['" + key + "']", null)
                                            continuation.resumeWith(Result.success(result))
                                        } else webView.postDelayed(this, 100)
                                    }
                                }
                            }
                            webView.post(poll)
                        }
                    }
                    require(encoded.startsWith("data:")) { "Unable to read PDF blob" }
                    copyBounded(android.util.Base64.decode(encoded.substringAfter(','), android.util.Base64.DEFAULT).inputStream())
                }
                "http", "https" -> {
                    val cookies = withContext(Dispatchers.Main.immediate) { CookieManager.getInstance().getCookie(url) }
                    val request = Request.Builder().url(url.substringBefore('#')).apply {
                        cookies?.takeIf { it.isNotBlank() }?.let { header("Cookie", it) }
                    }.build()
                    val client = if (uri.host in setOf("localhost", "127.0.0.1", "::1", "[::1]"))
                        http.newBuilder().proxy(java.net.Proxy.NO_PROXY).build() else http
                    client.newCall(request).execute().use { response ->
                        require(response.isSuccessful) { "PDF HTTP ${response.code}" }
                        val body = requireNotNull(response.body)
                        require(body.contentLength() in -1L..MaxPdfBytes) { "PDF must be smaller than 250 MiB" }
                        copyBounded(body.byteStream())
                    }
                }
                else -> error("Unsupported PDF URL")
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

    private fun renderPdfPage(file: File, pageNumber: Int): Bitmap {
        val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        PdfRenderer(descriptor).use { renderer ->
            require(renderer.pageCount > 0) { "PDF 没有可渲染页面" }
            renderer.openPage(pageNumber - 1).use { page ->
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
