package com.newmark.mobile.ui

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.newmark.mobile.data.ToolResult
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder

/**
 * The mobile browser accepts web origins and explicit local file/content URLs.  Keeping this policy
 * outside the WebView makes links, address-bar input, and future local
 * `browser_use` calls share the same boundary.
 */
object BrowserUrlPolicy {
    const val DefaultUrl = "https://www.google.com/"
    private val hostLike = Regex("^(localhost|\\[[0-9a-fA-F:]+]|(?:[a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,63}|(?:\\d{1,3}\\.){3}\\d{1,3})(?::\\d{1,5})?(?:[/?#].*)?$")

    /** Address-bar resolution: web address completion first, search fallback second. */
    fun resolveInput(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isBlank()) return null
        if (trimmed.any { it.isISOControl() }) return null
        if (trimmed.startsWith("/")) return URI("file", "", trimmed, null).toASCIIString()
        if (trimmed.contains("://") || trimmed.startsWith("file:", true)) return normalizeNavigation(trimmed)
        if (hostLike.matches(trimmed)) {
            val local = trimmed.startsWith("localhost", true) || trimmed.startsWith("127.") || trimmed.startsWith("[::1]")
            return normalizeNavigation("${if (local) "http" else "https"}://$trimmed")
        }
        if (Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(trimmed)) return null
        val query = URLEncoder.encode(trimmed, Charsets.UTF_8.name()).replace("+", "%20")
        return "https://www.google.com/search?q=$query"
    }

    /** Navigation boundary: never turns an untrusted callback URL into a search. */
    fun normalizeNavigation(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isBlank() || trimmed.any { it.isISOControl() || it.isWhitespace() }) return null
        val candidate = trimmed.replace(Regex("^files://", RegexOption.IGNORE_CASE), "file://")
        val uri = runCatching { URI(candidate) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme == "file") {
            if (uri.isOpaque || (!uri.host.isNullOrBlank() && uri.host != "localhost") || uri.path?.startsWith("/") != true) return null
            return uri.toASCIIString()
        }
        if (scheme == "content") return if (!uri.authority.isNullOrBlank()) uri.toASCIIString() else null
        if (scheme !in setOf("http", "https") || uri.host.isNullOrBlank() || uri.userInfo != null) return null
        if (uri.port !in -1..65535) return null
        return uri.toASCIIString()
    }

    /** Web-origin redirects/popups cannot promote themselves into local-file access. */
    fun normalizeFromPage(current: String?, target: String): String? {
        val normalized = normalizeNavigation(target) ?: return null
        val sourceScheme = runCatching { URI(current.orEmpty()).scheme?.lowercase() }.getOrNull()
        val targetScheme = URI(normalized).scheme.lowercase()
        if (targetScheme in setOf("file", "content") && sourceScheme !in setOf("file", "content")) return null
        return normalized
    }

    fun normalize(raw: String): String? = resolveInput(raw)
}

enum class BrowserCommandKind { Navigate, Back, Forward, Reload }

data class BrowserCommand(
    val id: Long,
    val kind: BrowserCommandKind,
    val url: String = "",
)

/**
 * Conversation-scoped browser state.  A URL entered from a reply, the
 * address bar, or a later Agent browser tool always goes through this one
 * command stream; a WebView only executes the current conversation's stream.
 */
@Stable
class BrowserSessionState(initialUrl: String = BrowserUrlPolicy.DefaultUrl) {
    var hasActivity by mutableStateOf(false)
        private set
    var address by mutableStateOf(initialUrl)
        private set
    var title by mutableStateOf("")
        private set
    var isLoading by mutableStateOf(false)
        private set
    var progress by mutableStateOf(0)
        private set
    var error by mutableStateOf("")
        private set
    var canGoBack by mutableStateOf(false)
        private set
    var canGoForward by mutableStateOf(false)
        private set
    var publicText by mutableStateOf("")
        private set

    private var downloadedPdfUrl: String? = null
    val isPdfDocument: Boolean get() = downloadedPdfUrl == address || address.substringBefore('#').substringBefore('?').endsWith(".pdf", true)
    fun onPdfDocument(url: String) {
        downloadedPdfUrl = url
        address = url
        publicText = ""
        isLoading = false
        progress = 100
        error = ""
    }

    var viewport by mutableStateOf<Pair<Int, Int>?>(null)
        private set
    var viewportHandler: (suspend (Pair<Int, Int>) -> JSONObject)? = null
    private var actualViewport = JSONObject()

    var forceVisual = false
        private set
    var recognitionPage: Int? = null
        private set
    private var recognition: (suspend (String, Int) -> JSONObject)? = null

    fun bindRecognition(handler: suspend (String, Int) -> JSONObject) {
        recognition = handler
    }

    fun unbindRecognition(handler: suspend (String, Int) -> JSONObject) {
        if (recognition === handler) recognition = null
    }

    private var nextCommandId = 0L
    var command by mutableStateOf(BrowserCommand(++nextCommandId, BrowserCommandKind.Navigate, initialUrl))
        private set

    fun updateAddressDraft(value: String) {
        address = value
        error = ""
    }

    fun navigate(raw: String): Boolean {
        val normalized = BrowserUrlPolicy.resolveInput(raw)
        if (normalized == null) {
            error = "请输入有效网页地址、本地绝对路径或 file:// / content:// 地址"
            isLoading = false
            return false
        }
        address = normalized
        hasActivity = true
        title = ""
        error = ""
        isLoading = true
        progress = 0
        issue(BrowserCommandKind.Navigate, normalized)
        return true
    }

    fun back() {
        hasActivity = true
        error = ""
        issue(BrowserCommandKind.Back)
    }

    fun forward() {
        hasActivity = true
        error = ""
        issue(BrowserCommandKind.Forward)
    }

    fun reload() {
        hasActivity = true
        error = ""
        isLoading = true
        progress = 0
        issue(BrowserCommandKind.Reload)
    }

    fun onNavigationStarted(url: String) {
        BrowserUrlPolicy.normalizeNavigation(url)?.let { address = it }
        isLoading = true
        progress = 0
        error = ""
    }

    fun onNavigationFinished(url: String, canBack: Boolean, canForward: Boolean) {
        BrowserUrlPolicy.normalizeNavigation(url)?.let { address = it }
        isLoading = false
        progress = 100
        canGoBack = canBack
        canGoForward = canForward
    }

    fun onNavigationProgress(value: Int) {
        progress = value.coerceIn(0, 100)
        isLoading = progress in 0..99
    }

    fun onTitle(value: String?) {
        title = value.orEmpty().trim().take(240)
    }

    fun onPublicText(value: String?) {
        publicText = value.orEmpty().replace(Regex("\\s+"), " ").trim().take(48_000)
    }

    suspend fun executeTool(args: JSONObject): ToolResult {
        val action = args.optString("action").trim().lowercase()
        if (args.has("visual_mode") && args.optString("visual_mode") !in setOf("auto", "vision")) return ToolResult.err("invalid_visual_mode")
        if (args.has("viewport")) {
            val requested = args.optJSONObject("viewport") ?: return ToolResult.err("invalid_viewport")
            val width = requested.optDouble("width", Double.NaN)
            val height = requested.optDouble("height", Double.NaN)
            if (action !in setOf("observe", "navigate") || width !in 320.0..2560.0 || height !in 240.0..2560.0 ||
                width % 1 != 0.0 || height % 1 != 0.0 || width * height > 4_000_000) return ToolResult.err("invalid_viewport")
            val apply = viewportHandler ?: return ToolResult.err("WebView viewport host unavailable")
            val size = width.toInt() to height.toInt()
            actualViewport = try { apply(size) } catch (error: kotlinx.coroutines.CancellationException) { throw error } catch (error: Exception) { return ToolResult.err(error.message ?: "Viewport failed") }
            viewport = size
        }
        if (args.has("pdf_page")) {
            val page = args.optDouble("pdf_page", Double.NaN)
            if (page !in 1.0..100000.0 || page % 1 != 0.0 || action !in setOf("observe", "extract")) return ToolResult.err("invalid_pdf_page")
        }
        forceVisual = args.optString("visual_mode") == "vision"
        recognitionPage = if (args.has("pdf_page")) args.optInt("pdf_page") else null
        return when (action) {
        "navigate" -> if (navigate(args.optString("url"))) ToolResult.ok(receipt(action)) else ToolResult.err(error)
        "back" -> { back(); ToolResult.ok(receipt(action)) }
        "forward" -> { forward(); ToolResult.ok(receipt(action)) }
        "reload" -> { reload(); ToolResult.ok(receipt(action)) }
        "wait" -> {
            val duration = args.optLong("duration_ms", 500L).coerceIn(0L, 10_000L)
            var waited = 0L
            while (isLoading && waited < duration) {
                delay(50)
                waited += 50
            }
            ToolResult.ok(receipt(action))
        }
        "observe", "extract" -> {
            val maxChars = args.optInt("max_chars", 12_000).coerceIn(256, 48_000)
            val text = publicText.take(maxChars)
            val readable = text.count { it.isLetterOrDigit() }
            if (readable >= 20 && !isPdfDocument && args.optString("visual_mode", "auto") != "vision") {
                ToolResult.ok(receipt(action, text, "dom_text"))
            } else {
                val observedCommand = command.id
                val observedAddress = address
                val fallback = recognition?.invoke(address, maxChars)
                    ?: JSONObject()
                        .put("ok", false)
                        .put("error", "WebView 尚未挂载，无法获取视觉回退")
                if (command.id != observedCommand || address != observedAddress) return ToolResult.err("Page changed during recognition; observe again")
                fallback.put("viewport", actualViewport)
                fallback.put("action", action).put("url", address).put("title", title)
                if (fallback.optBoolean("ok")) ToolResult.ok(fallback.toString(2)) else ToolResult.err(fallback.toString(2))
            }
        }
        else -> ToolResult.err("browser_use 不支持动作：$action")
    }

    }

    private fun receipt(action: String, text: String = "", source: String = ""): String = JSONObject()
        .put("ok", true)
        .put("action", action)
        .put("url", address)
        .put("title", title)
        .put("viewport", actualViewport)
        .put("loading", isLoading)
        .put("progress", progress)
        .put("text", text)
        .put("source", source)
        .put("recognition_order", "text>vision>local_ocr")
        .toString(2)

    fun onNavigationError(message: String, canBack: Boolean = false, canForward: Boolean = false) {
        error = message.trim().ifBlank { "网页加载失败" }.take(320)
        isLoading = false
        canGoBack = canBack
        canGoForward = canForward
    }

    fun onHistoryChanged(canBack: Boolean, canForward: Boolean) {
        canGoBack = canBack
        canGoForward = canForward
    }

    private fun issue(kind: BrowserCommandKind, url: String = "") {
        command = BrowserCommand(++nextCommandId, kind, url)
    }
}

/** Keeps local and paired-desktop conversations from sharing a browser URL. */
class BrowserSessionRegistry {
    private val visibleSessions = linkedMapOf<String, BrowserSessionState>()
    private val backgroundSessions = linkedMapOf<String, BrowserSessionState>()

    /** Default/visible tools and the right sidebar intentionally share state. */
    fun session(targetKey: String): BrowserSessionState = visibleSession(targetKey)

    fun visibleSession(targetKey: String): BrowserSessionState =
        visibleSessions.getOrPut(targetKey) { BrowserSessionState() }

    /** visible=false never aliases the Compose-owned right-sidebar session. */
    fun backgroundSession(targetKey: String): BrowserSessionState =
        backgroundSessions.getOrPut(targetKey) { BrowserSessionState() }

    fun releaseBackgroundSession(targetKey: String) {
        backgroundSessions.remove(targetKey)
    }
}
