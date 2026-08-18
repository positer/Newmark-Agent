package com.newmark.mobile.ui

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.net.URI

/**
 * The mobile browser accepts only ordinary web origins.  Keeping this policy
 * outside the WebView makes links, address-bar input, and future local
 * `browser_use` calls share the same boundary.
 */
object BrowserUrlPolicy {
    const val DefaultUrl = "https://www.google.com/"

    fun normalize(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isBlank()) return null
        val candidate = if (trimmed.contains("://")) trimmed else "https://$trimmed"
        val uri = runCatching { URI(candidate) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme !in setOf("http", "https") || uri.host.isNullOrBlank()) return null
        return uri.toASCIIString()
    }
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

    private var nextCommandId = 0L
    var command by mutableStateOf(BrowserCommand(++nextCommandId, BrowserCommandKind.Navigate, initialUrl))
        private set

    fun updateAddressDraft(value: String) {
        address = value
        error = ""
    }

    fun navigate(raw: String): Boolean {
        val normalized = BrowserUrlPolicy.normalize(raw)
        if (normalized == null) {
            error = "仅支持带有效主机名的 http:// 或 https:// 网页地址"
            isLoading = false
            return false
        }
        address = normalized
        title = ""
        error = ""
        isLoading = true
        progress = 0
        issue(BrowserCommandKind.Navigate, normalized)
        return true
    }

    fun back() {
        error = ""
        issue(BrowserCommandKind.Back)
    }

    fun forward() {
        error = ""
        issue(BrowserCommandKind.Forward)
    }

    fun reload() {
        error = ""
        isLoading = true
        progress = 0
        issue(BrowserCommandKind.Reload)
    }

    fun onNavigationStarted(url: String) {
        BrowserUrlPolicy.normalize(url)?.let { address = it }
        isLoading = true
        progress = 0
        error = ""
    }

    fun onNavigationFinished(url: String, canBack: Boolean, canForward: Boolean) {
        BrowserUrlPolicy.normalize(url)?.let { address = it }
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
