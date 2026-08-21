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
 * The mobile browser accepts only ordinary web origins.  Keeping this policy
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
        if (trimmed.contains("://")) return normalizeNavigation(trimmed)
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
        val candidate = trimmed
        val uri = runCatching { URI(candidate) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme !in setOf("http", "https") || uri.host.isNullOrBlank() || uri.userInfo != null) return null
        if (uri.port !in -1..65535) return null
        return uri.toASCIIString()
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
            error = "仅支持带有效主机名的 http:// 或 https:// 网页地址"
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

    suspend fun executeTool(args: JSONObject): ToolResult = when (val action = args.optString("action").trim().lowercase()) {
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
            if (readable >= 20) {
                ToolResult.ok(receipt(action, text, "dom_text"))
            } else {
                val fallback = recognition?.invoke(address, maxChars)
                    ?: JSONObject()
                        .put("ok", false)
                        .put("error", "WebView 尚未挂载，无法获取视觉回退")
                fallback.put("action", action).put("url", address).put("title", title)
                ToolResult.ok(fallback.toString(2))
            }
        }
        else -> ToolResult.err("browser_use 不支持动作：$action")
    }

    private fun receipt(action: String, text: String = "", source: String = ""): String = JSONObject()
        .put("ok", true)
        .put("action", action)
        .put("url", address)
        .put("title", title)
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
    private val sessions = linkedMapOf<String, BrowserSessionState>()

    fun session(targetKey: String): BrowserSessionState =
        sessions.getOrPut(targetKey) { BrowserSessionState() }
}
