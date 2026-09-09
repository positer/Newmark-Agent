package com.newmark.mobile.ui

import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.wrapContentSize

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color as AndroidColor
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.RenderProcessGoneDetail
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.zIndex
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.boundsInParent
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.newmark.mobile.data.RemoteSubagent
import com.newmark.mobile.data.RemotePlanItem
import com.newmark.mobile.ui.components.LucideIcons
import com.newmark.mobile.ui.components.MarkdownBody
import com.newmark.mobile.ui.theme.LocalNewmarkColors
import com.newmark.mobile.ui.theme.scaledGlassAlpha
import com.newmark.mobile.ui.theme.NewmarkLightThemeColors
import com.newmark.mobile.ui.theme.NewmarkThemeColors
import com.newmark.mobile.ui.components.liquidPopupShell
import com.newmark.mobile.ui.components.liquidGlassModifier
import com.newmark.mobile.ui.components.glassButtonSurface
import com.newmark.mobile.ui.components.liquidHoldDragGesture
import com.newmark.mobile.ui.components.DialogBackdropBlur
import com.newmark.mobile.ui.components.MobilePopupShape
import com.newmark.mobile.ui.components.MobileInteractionGlassEdge
import com.newmark.mobile.ui.components.liquidMotionDeformationDeferred
import com.newmark.mobile.ui.components.liquidSelectionMorph
import com.newmark.mobile.ui.components.runOverlappedLiquidFlight
import com.newmark.mobile.ui.components.resistedLiquidBoundaryPosition
import com.newmark.mobile.ui.components.rememberLiquidBackdrop
import com.newmark.mobile.ui.components.rememberLiquidContactState
import com.newmark.mobile.ui.components.rememberLiquidDragFollower
import com.newmark.mobile.ui.components.rememberLiquidPopupExit
import com.newmark.mobile.ui.components.liquidPopupExit
import com.newmark.mobile.ui.components.LocalSidebarGestureLock
import com.kyant.backdrop.backdrops.layerBackdrop
import com.newmark.mobile.vm.ChatViewModel
import com.newmark.mobile.vm.DesktopLinkViewModel
import com.newmark.mobile.vm.WorkspaceUploadProgress
import kotlinx.coroutines.delay
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.Closeable
import kotlin.math.roundToInt

enum class RightSidebarTab(val label: String, val icon: ImageVector) {
    Files("文件", LucideIcons.Folder),
    Editor("编辑器", LucideIcons.SquarePen),
    Plan("计划", LucideIcons.ListChecks),
    Subagents("Subagent", LucideIcons.Bot),
    Browser("浏览器", LucideIcons.Globe),
    Uploads("上传", LucideIcons.Activity),
}

private fun availableRightTabs(remoteMode: Boolean): List<RightSidebarTab> = if (remoteMode) {
    RightSidebarTab.entries.toList()
} else {
    // Uploads is local/global UI state, so it remains available even when
    // the conversation is local and remote workspace tabs are unavailable.
    listOf(RightSidebarTab.Plan, RightSidebarTab.Browser, RightSidebarTab.Uploads)
}

private const val BrowserTextScript =
    "(function(){var b=document.body;return b?(b.innerText||b.textContent||''):'';})()"

/** Renderer loss and Compose disposal can arrive for the same instance. */
private class ManagedBrowserWebView(context: Context) : WebView(context) {
    private var released = false
    fun release(stopPendingLoad: Boolean = true) {
        if (released) return
        released = true
        visibility = View.GONE
        if (stopPendingLoad) stopLoading()
        (parent as? android.view.ViewGroup)?.removeView(this)
        removeAllViews()
        destroy()
    }
}

/** A requested CSS canvas is fitted into the panel without changing the panel geometry. */
internal class BrowserViewportLayout(context: Context, val browser: WebView) : android.widget.FrameLayout(context) {
    var viewport: Pair<Int, Int>? = null
        set(value) { field = value; requestLayout() }
    init { addView(browser); clipChildren = true }
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = View.MeasureSpec.getSize(widthMeasureSpec)
        val height = View.MeasureSpec.getSize(heightMeasureSpec)
        val size = viewport
        val density = resources.displayMetrics.density
        val childWidth = size?.let { (it.first * density).toInt() } ?: width
        val childHeight = size?.let { (it.second * density).toInt() } ?: height
        browser.measure(View.MeasureSpec.makeMeasureSpec(childWidth, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(childHeight, View.MeasureSpec.EXACTLY))
        setMeasuredDimension(width, height)
    }
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        browser.layout(0, 0, browser.measuredWidth, browser.measuredHeight)
        val scale = minOf(width.toFloat() / browser.width.coerceAtLeast(1), height.toFloat() / browser.height.coerceAtLeast(1), 1f)
        browser.pivotX = 0f; browser.pivotY = 0f
        browser.scaleX = scale; browser.scaleY = scale
    }
}

internal suspend fun applyBrowserViewport(webView: WebView, size: Pair<Int, Int>): JSONObject {
    val density = webView.resources.displayMetrics.density
    val width = (size.first * density).toInt()
    val height = (size.second * density).toInt()
    require(width.toLong() * height <= 16_000_000L) { "Viewport exceeds device pixel limit" }
    val panel = webView.parent as? BrowserViewportLayout
    if (panel != null) {
        panel.viewport = size
        panel.measure(View.MeasureSpec.makeMeasureSpec(panel.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(panel.height, View.MeasureSpec.EXACTLY))
        panel.layout(panel.left, panel.top, panel.right, panel.bottom)
    } else {
        webView.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        webView.layout(0, 0, width, height)
    }
    kotlinx.coroutines.delay(150)
    return kotlinx.coroutines.suspendCancellableCoroutine { continuation ->
        webView.evaluateJavascript("JSON.stringify({width:innerWidth,height:innerHeight,devicePixelRatio:devicePixelRatio})") { encoded ->
            val decoded = runCatching { org.json.JSONArray("[$encoded]").getString(0) }.getOrDefault("{}")
            if (continuation.isActive) continuation.resumeWith(Result.success(JSONObject(decoded)))
        }
    }
}

internal fun WebView.applyNewmarkBrowserSettings() {
    setBackgroundColor(AndroidColor.TRANSPARENT)
    settings.javaScriptEnabled = true
    settings.useWideViewPort = false
    settings.domStorageEnabled = true
    settings.loadsImagesAutomatically = true
    settings.cacheMode = WebSettings.LOAD_DEFAULT
    settings.allowFileAccess = true
    @Suppress("DEPRECATION")
    settings.allowFileAccessFromFileURLs = false
    @Suppress("DEPRECATION")
    settings.allowUniversalAccessFromFileURLs = false
    settings.allowContentAccess = true
    settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    settings.javaScriptCanOpenWindowsAutomatically = true
    settings.setSupportMultipleWindows(true)
    settings.setGeolocationEnabled(false)
    settings.mediaPlaybackRequiresUserGesture = true
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
        settings.safeBrowsingEnabled = true
    }
}

private fun WebView.updateBrowserSessionText(session: BrowserSessionState, onComplete: (() -> Unit)? = null) {
    evaluateJavascript(BrowserTextScript) { encoded ->
        val text = runCatching { org.json.JSONArray("[$encoded]").optString(0) }.getOrDefault("")
        session.onPublicText(text)
        onComplete?.invoke()
    }
}

private fun bindBrowserClients(
    context: Context,
    webView: WebView,
    session: BrowserSessionState,
    onPageSettled: (() -> Unit)? = null,
    onRendererGone: (WebView) -> Unit,
) {
    webView.setDownloadListener { url, _, _, mime, _ ->
        if (mime.substringBefore(';').equals("application/pdf", true) || url.substringBefore('?').endsWith(".pdf", true)) {
            session.onPdfDocument(url)
            onPageSettled?.invoke()
        }
    }
    webView.webViewClient = object : WebViewClient() {
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            session.onNavigationError("网页渲染进程已结束，可重新加载网页", false, false)
            onPageSettled?.invoke()
            onRendererGone(view)
            return true
        }
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val target = BrowserUrlPolicy.normalizeFromPage(view.url, request.url.toString())
            return if (target != null) {
                false
            } else {
                session.onNavigationError(
                    "已阻止非网页链接：${request.url.scheme ?: "unknown"}",
                    view.canGoBack(),
                    view.canGoForward(),
                )
                onPageSettled?.invoke()
                true
            }
        }

        override fun onSafeBrowsingHit(
            view: WebView,
            request: WebResourceRequest,
            threatType: Int,
            callback: android.webkit.SafeBrowsingResponse,
        ) {
            callback.backToSafety(true)
            session.onNavigationError("安全浏览已阻止危险网页", view.canGoBack(), view.canGoForward())
            onPageSettled?.invoke()
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            session.onNavigationStarted(url)
        }

        override fun onPageFinished(view: WebView, url: String) {
            session.onNavigationFinished(url, view.canGoBack(), view.canGoForward())
            view.updateBrowserSessionText(session, onPageSettled)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
                session.onNavigationError(
                    error.description?.toString() ?: "网页加载失败",
                    view.canGoBack(),
                    view.canGoForward(),
                )
                onPageSettled?.invoke()
            }
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            if (request.isForMainFrame && errorResponse.statusCode >= 400) {
                session.onNavigationError(
                    "网页返回 HTTP ${errorResponse.statusCode}",
                    view.canGoBack(),
                    view.canGoForward(),
                )
                onPageSettled?.invoke()
            }
        }
    }
    webView.webChromeClient = object : WebChromeClient() {
        override fun onCreateWindow(
            view: WebView,
            isDialog: Boolean,
            isUserGesture: Boolean,
            resultMsg: android.os.Message,
        ): Boolean {
            val popup = ManagedBrowserWebView(context).apply {
                settings.javaScriptEnabled = view.settings.javaScriptEnabled
                settings.domStorageEnabled = view.settings.domStorageEnabled
                webViewClient = object : WebViewClient() {
                    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                        (view as ManagedBrowserWebView).release(stopPendingLoad = false)
                        return true
                    }
                    override fun onPageStarted(popupView: WebView, url: String, favicon: android.graphics.Bitmap?) {
                        BrowserUrlPolicy.normalizeFromPage(view.url, url)?.let {
                            session.navigate(it)
                            (popupView as ManagedBrowserWebView).release()
                        }
                    }

                    override fun shouldOverrideUrlLoading(popupView: WebView, request: WebResourceRequest): Boolean {
                        BrowserUrlPolicy.normalizeFromPage(view.url, request.url.toString())?.let {
                            session.navigate(it)
                            (popupView as ManagedBrowserWebView).release()
                            return true
                        }
                        return true
                    }
                }
            }
            val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
            transport.webView = popup
            resultMsg.sendToTarget()
            return true
        }

        override fun onProgressChanged(view: WebView, newProgress: Int) {
            session.onNavigationProgress(newProgress)
            session.onHistoryChanged(view.canGoBack(), view.canGoForward())
        }

        override fun onReceivedTitle(view: WebView, title: String?) {
            session.onTitle(title)
        }
    }
}

/**
 * WebView host for visible=false. It lives outside Compose/AndroidView, is never attached to a
 * ViewGroup, and therefore cannot bind to, display in, or draw the right sidebar.
 */
@SuppressLint("SetJavaScriptEnabled")
class BackgroundBrowserHost(
    context: Context,
    private val session: BrowserSessionState,
    private val correctOcr: suspend (String, String) -> String = { _, _ -> "" },
    private val inspectImage: suspend (String) -> String = { "" },
) : Closeable {
    private val webView = ManagedBrowserWebView(context.applicationContext).apply {
        applyNewmarkBrowserSettings()
        visibility = View.GONE
    }
    private val recognition = BrowserRecognition(context.applicationContext, webView, inspectImage, { session.isPdfDocument })
    private var settled = CompletableDeferred<Unit>().apply { complete(Unit) }
    private var handledCommandId = -1L
    private var closed = false
    val isClosed: Boolean get() = closed
    private val recognitionHandler: suspend (String, Int) -> JSONObject = { url, maxChars ->
        val receipt = recognition.recognize(url, maxChars, session.forceVisual, session.recognitionPage)
        val raw = receipt.optString("text")
        if (raw.isNotBlank() && receipt.optString("engine") == "mlkit-bundled") {
            val corrected = correctOcr(raw, receipt.optString("profile"))
            if (corrected.isNotBlank()) {
                receipt.put("corrected_text", corrected.take(maxChars))
                receipt.put("fallback", "mini_ocr_llm")
                receipt.put("uncertainty", "preserved")
                receipt.put("warning", "视觉输入不可用；内容来自本地 OCR 和文本模型保守校正，可能不完整")
            }
        }
        receipt
    }

    init {
        bindBrowserClients(context.applicationContext, webView, session,
            onPageSettled = { if (!settled.isCompleted) settled.complete(Unit) },
            onRendererGone = { webView.release(stopPendingLoad = false); close() },
        )
        session.bindRecognition(recognitionHandler)
        session.viewportHandler = { size -> applyBrowserViewport(webView, size) }
        val density = webView.resources.displayMetrics.density
        webView.measure(View.MeasureSpec.makeMeasureSpec((1280 * density).toInt(), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec((720 * density).toInt(), View.MeasureSpec.EXACTLY))
        webView.layout(0, 0, webView.measuredWidth, webView.measuredHeight)
    }

    val isAttachedToUi: Boolean
        get() = webView.parent != null

    suspend fun execute(args: JSONObject): com.newmark.mobile.data.ToolResult = withContext(Dispatchers.Main.immediate) {
        if (closed) return@withContext com.newmark.mobile.data.ToolResult.err("后台浏览器会话已关闭")
        val action = args.optString("action").trim().lowercase()
        if (action !in setOf("observe", "navigate", "wait", "extract", "back", "forward", "reload")) {
            return@withContext session.executeTool(args)
        }
        when (action) {
            "navigate", "back", "forward", "reload" -> {
                val result = session.executeTool(args)
                if (result.ok && handledCommandId != session.command.id) dispatchPendingCommand()
                result
            }
            "wait" -> {
                if (handledCommandId != session.command.id) dispatchPendingCommand()
                val duration = args.optLong("duration_ms", 500L).coerceIn(0L, 10_000L)
                if (!settled.isCompleted) kotlinx.coroutines.withTimeoutOrNull(duration) { settled.await() }
                val refreshed = CompletableDeferred<Unit>()
                webView.updateBrowserSessionText(session) { refreshed.complete(Unit) }
                kotlinx.coroutines.withTimeoutOrNull(2_000L) { refreshed.await() }
                session.executeTool(JSONObject().put("action", "wait").put("duration_ms", 0L))
            }
            "observe", "extract" -> {
                if (handledCommandId != session.command.id) dispatchPendingCommand()
                if (!settled.isCompleted) kotlinx.coroutines.withTimeoutOrNull(10_000L) { settled.await() }
                val refreshed = CompletableDeferred<Unit>()
                webView.updateBrowserSessionText(session) { refreshed.complete(Unit) }
                kotlinx.coroutines.withTimeoutOrNull(2_000L) { refreshed.await() }
                session.executeTool(args)
            }
            else -> session.executeTool(args)
        }
    }

    private fun dispatchPendingCommand() {
        val command = session.command
        if (command.id == handledCommandId) return
        handledCommandId = command.id
        settled = CompletableDeferred()
        when (command.kind) {
            BrowserCommandKind.Navigate -> webView.loadUrl(command.url)
            BrowserCommandKind.Back -> if (webView.canGoBack()) webView.goBack() else settled.complete(Unit)
            BrowserCommandKind.Forward -> if (webView.canGoForward()) webView.goForward() else settled.complete(Unit)
            BrowserCommandKind.Reload -> webView.reload()
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        session.unbindRecognition(recognitionHandler)
        session.viewportHandler = null
        recognition.close()
        webView.release()
    }
}

/** PC #right：横向 tabs、可关闭内容区；内容展开时占据第三栏并让聊天区避让。 */
@Composable
fun MobileRightSidebar(
    vm: DesktopLinkViewModel,
    localVm: ChatViewModel? = null,
    remoteMode: Boolean,
    browserSession: BrowserSessionState,
    selectedTab: RightSidebarTab,
    backdrop: com.kyant.backdrop.Backdrop? = null,
    panelWidth: Dp = 300.dp,
    /** 宽屏拖拽期间使用同一正式栏的可见宽度，不再渲染独立预测层。 */
    visibleWidth: Dp = panelWidth,
    expanded: Boolean,
    onOpenSubagentPage: ((RemoteSubagent) -> Unit)? = null,
    onExpandedChange: (Boolean) -> Unit = {},
    onSelectTab: (RightSidebarTab) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val p = LocalNewmarkColors.current
    val tabs = remember(remoteMode) { availableRightTabs(remoteMode) }
    val tab = selectedTab.takeIf { it in tabs } ?: tabs.first()
    var selectedSubagent by remember { mutableStateOf<RemoteSubagent?>(null) }
    LaunchedEffect(remoteMode, vm.selectedConversationWorkspaceId, vm.selectedConversationId) {
        if (remoteMode && !vm.selectedConversationWorkspaceId.isNullOrBlank() && !vm.selectedConversationId.isNullOrBlank()) {
            vm.refreshRightSidebar()
        }
    }
    // Match PC #right: the conversation surface behind the panel owns the
    // backdrop blur, while the panel itself is a tinted carrier rather than a
    // full-height refractive lens. A large lens produces a mirrored vertical
    // band while the sidebar is only half revealed.
    val panelSurface = rightSidebarCarrierColor(p)
    Column(
        modifier = modifier
            .width(visibleWidth)
            .fillMaxHeight()
            .background(panelSurface)
            .drawBehind {
                val stroke = 1.dp.toPx()
                drawLine(
                    color = p.border,
                    start = Offset(stroke / 2f, 0f),
                    end = Offset(stroke / 2f, size.height),
                    strokeWidth = stroke,
                )
            },
    ) {
        RightTabs(
            selected = tab,
            tabs = tabs,
            expanded = expanded,
            onSelect = { target ->
                onSelectTab(target)
                onExpandedChange(true)
                if (remoteMode && (target == RightSidebarTab.Files || target == RightSidebarTab.Plan || target == RightSidebarTab.Subagents)) {
                    vm.refreshRightSidebar()
                }
            },
            onClose = { onExpandedChange(false) },
        )
        if (expanded) {
            Box(Modifier.fillMaxSize().padding(horizontal = 10.dp, vertical = 8.dp)) {
                // Mount the right-sidebar WebView only after the user opens the
                // Browser tab or the default/visible tool lane requests it.
                // visible=false owns BackgroundBrowserHost and never reaches
                // this Compose/AndroidView branch.
                BrowserPanel(
                    session = browserSession,
                    visible = tab == RightSidebarTab.Browser,
                    localVm = localVm,
                    modifier = Modifier.fillMaxSize().graphicsLayer {
                        alpha = if (tab == RightSidebarTab.Browser) 1f else 0f
                    }.zIndex(if (tab == RightSidebarTab.Browser) 1f else -1f),
                )
                when (tab) {
                    RightSidebarTab.Files -> if (remoteMode) FilesPanel(vm) { onSelectTab(RightSidebarTab.Editor) }
                    RightSidebarTab.Editor -> if (remoteMode) EditorPanel(vm)
                    RightSidebarTab.Plan -> if (remoteMode) PlanPanel(vm) else LocalPlanPanel(localVm)
                    RightSidebarTab.Subagents -> if (remoteMode) {
                        SubagentPanel(vm, onOpen = { agent ->
                            if (onOpenSubagentPage != null) onOpenSubagentPage(agent) else selectedSubagent = agent
                        })
                    }
                    RightSidebarTab.Browser -> Unit
                    RightSidebarTab.Uploads -> UploadsPanel(vm.workspaceUploadProgress)
                }
            }
        }
    }
    selectedSubagent?.let { agent -> SubagentHistoryDialog(agent, onDismiss = { selectedSubagent = null }) }
}

private fun rightSidebarCarrierColor(p: NewmarkThemeColors): Color =
    if (p == NewmarkLightThemeColors) {
        p.bgTertiary.copy(alpha = 0.98f)
    } else {
        p.bgTertiary.copy(alpha = scaledGlassAlpha(0.74f, com.newmark.mobile.ui.theme.DefaultGlassAlpha))
    }

@Composable
private fun UploadsPanel(tasks: List<WorkspaceUploadProgress>) {
    val p = LocalNewmarkColors.current
    Column(Modifier.fillMaxSize()) {
        SectionHead("文件上传进度", meta = "${tasks.count { it.status == "uploading" }} 项上传中")
        if (tasks.isEmpty()) {
            EmptyState("暂无文件上传任务")
            return@Column
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(tasks, key = { it.id }) { task ->
                UploadTaskRow(task)
            }
        }
    }
}

@Composable
private fun UploadTaskRow(task: WorkspaceUploadProgress) {
    val p = LocalNewmarkColors.current
    val statusText = when (task.status) {
        "completed" -> "已完成"
        "failed" -> "失败"
        else -> "${(task.fraction * 100).toInt()}%"
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(LucideIcons.Activity, null, tint = p.accent, modifier = Modifier.size(14.dp))
            Text(
                task.fileName,
                color = p.textPrimary,
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 6.dp).weight(1f),
            )
            Text(statusText, color = p.textTertiary, fontSize = 9.sp)
        }
        Text(
            "${task.workspaceId} / ${task.conversationTitle}",
            color = p.textTertiary,
            fontSize = 9.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 3.dp),
        )
        Text(task.targetPath, color = p.textSecondary, fontSize = 9.sp, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp, bottom = 6.dp))
        LinearProgressIndicator(
            progress = { task.fraction },
            modifier = Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)),
            color = p.accent,
            trackColor = p.bgQuaternary,
        )
        if (task.error.isNotBlank()) {
            Text(task.error, color = p.red, fontSize = 9.sp, maxLines = 2,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 5.dp))
        }
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(p.border))
}

/** PC .right-open-btn：折叠时覆盖在主页面右缘中部，不占据任何布局宽度。 */
@Composable
fun RightSidebarOpenButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val p = LocalNewmarkColors.current
    val shape = RoundedCornerShape(50)
    Box(
        modifier = modifier
            .width(18.dp)
            .height(48.dp)
            .glassButtonSurface(shape, p.bgTertiary)
            .clip(shape)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(LucideIcons.PanelRight, "打开右侧栏", tint = p.textSecondary, modifier = Modifier.size(10.dp))
    }
}

/**
 * 手势尚未松开时的右栏预测层。它与完整栏使用相同的表面与边框，只由拖动距离决定
 * 位移和透明度；达到阈值才交给真正的右栏展开动画，短拖动则回弹且不改变布局。
 */
@Composable
fun RightSidebarDragPreview(
    progress: Float,
    panelWidth: Dp,
    modifier: Modifier = Modifier,
) {
    val p = LocalNewmarkColors.current
    val clamped = progress.coerceIn(0f, 1f)
    Box(
        modifier = modifier
            .width(panelWidth)
            .fillMaxHeight()
            .statusBarsPadding()
            .graphicsLayer {
                translationX = size.width * (1f - clamped)
                alpha = 0.58f + (0.42f * clamped)
            }
            .background(p.bgTertiary)
            .border(1.dp, p.border),
    ) {
        Column(Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(41.dp)
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(LucideIcons.PanelRight, contentDescription = null, tint = p.textSecondary, modifier = Modifier.size(15.dp))
                Text(
                    text = if (clamped >= 0.28f) "松手打开右侧栏" else "继续左滑打开右侧栏",
                    color = p.textSecondary,
                    fontSize = 11.sp,
                    maxLines = 1,
                )
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(p.border))
            Box(
                Modifier
                    .fillMaxWidth(clamped)
                    .height(2.dp)
                    .background(p.accent),
            )
            Column(Modifier.padding(horizontal = 12.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(3) { index ->
                    Box(
                        Modifier
                            .fillMaxWidth(if (index == 0) 0.82f else 0.64f)
                            .height(10.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .background(p.bgPrimary),
                    )
                }
            }
        }
    }
}

@Composable
internal fun RightTabs(
    selected: RightSidebarTab,
    tabs: List<RightSidebarTab>,
    expanded: Boolean,
    onSelect: (RightSidebarTab) -> Unit,
    onClose: () -> Unit,
) {
    val p = LocalNewmarkColors.current
    val setSidebarGestureLock = LocalSidebarGestureLock.current
    val scope = rememberCoroutineScope()
    val slotWidth = 34.dp
    val trackHeight = 40.dp
    val density = LocalDensity.current
    val tabBackdrop = rememberLiquidBackdrop()
    val glassContact = rememberLiquidContactState()
    val dragFollower = rememberLiquidDragFollower()
    val selectedIndex = tabs.indexOf(selected).coerceAtLeast(0)
    val glassX = remember { Animatable(0f) }
    val tabBounds = remember(tabs) { mutableStateMapOf<Int, Rect>() }
    var activeIndex by remember(tabs) { mutableIntStateOf(selectedIndex) }
    var visualSelectedIndex by remember(tabs) { mutableIntStateOf(selectedIndex) }
    var moving by remember { mutableStateOf(false) }


    var draggingGlass by remember { mutableStateOf(false) }
    var draggedGlassX by remember { mutableFloatStateOf(0f) }
    var flightJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    fun tabLeft(index: Int): Float = tabBounds[index]?.left
        ?: with(density) { index * slotWidth.toPx() }
    fun glassLeft(index: Int): Float = tabLeft(index) - with(density) { MobileInteractionGlassEdge.toPx() }
    val glassLift = remember { Animatable(0f) }
    val glassProgress = glassLift.value
    DisposableEffect(Unit) {
        onDispose {
            flightJob?.cancel()
            dragFollower.cancel()
            setSidebarGestureLock("right-tab-selector", false)
            setSidebarGestureLock("right-tab-candidate", false)
        }
    }
    LaunchedEffect(selectedIndex, tabs) {
        if (!moving) {
            activeIndex = selectedIndex
            visualSelectedIndex = selectedIndex
            glassX.snapTo(glassLeft(selectedIndex))
        }
    }
    fun indexAt(x: Float): Int = with(density) {
        (x / slotWidth.toPx()).toInt().coerceIn(tabs.indices)
    }
    fun flyTo(index: Int, commit: Boolean) {
        val redirecting = moving
        flightJob?.cancel()
        activeIndex = index
        setSidebarGestureLock("right-tab-selector", true)
        moving = true
        flightJob = scope.launch {
            if (draggingGlass) glassX.snapTo(dragFollower.stopAndRead())
            draggingGlass = false
            if (!redirecting) {
                glassX.snapTo(glassLeft(selectedIndex))
            }
            val targetX = glassLeft(index)
            val staysInPlace = kotlin.math.abs(glassX.value - targetX) < 0.5f
            runOverlappedLiquidFlight(
                lift = { glassLift.animateTo(1f, tween(100)) },
                move = { if (!staysInPlace) glassX.animateTo(targetX, tween(380, easing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f))) },
                onLandingStarted = {},
                land = { glassLift.animateTo(0f, tween(240)) },
            )

            moving = false
            visualSelectedIndex = index
            setSidebarGestureLock("right-tab-selector", false)
            if (commit) onSelect(tabs[index])
        }
    }
    fun holdAt(index: Int) {
        val redirecting = moving
        flightJob?.cancel()
        activeIndex = index
        setSidebarGestureLock("right-tab-selector", true)
        moving = true
        flightJob = scope.launch {
            if (draggingGlass) glassX.snapTo(dragFollower.stopAndRead())
            draggingGlass = false
            if (!redirecting) glassX.snapTo(glassLeft(selectedIndex))
            runOverlappedLiquidFlight(
                holdKeepsLifted = true,
                lift = { glassLift.animateTo(1f, tween(100)) },
                move = { glassX.animateTo(glassLeft(index), tween(380, easing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f))) },
                onLandingStarted = {}, land = {},
            )
        }
    }
    Column(Modifier.fillMaxWidth().statusBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().height(41.dp).padding(horizontal = 6.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (expanded) {
                Box(
                    Modifier
                        .width(slotWidth * tabs.size)
                        .height(trackHeight)
                        .testTag("right-tab-rail")
                        .liquidHoldDragGesture(
                            tabs.size,
                            selectedIndex,
                            contact = glassContact,
                            onCandidateStart = { setSidebarGestureLock("right-tab-candidate", true) },
                            onCandidateEnd = { setSidebarGestureLock("right-tab-candidate", false) },
                            onTap = { flyTo(indexAt(it.x), commit = true) },
                            onHoldStart = {
                                val index = indexAt(it.x)
                                holdAt(index)
                            },
                            onDrag = { position, _ ->
                                if (!draggingGlass) {
                                    flightJob?.cancel()
                                    dragFollower.startFrom(glassX.value)
                                    flightJob = scope.launch { glassLift.animateTo(1f, tween(100)) }
                                }
                                moving = true

                                draggingGlass = true
                                activeIndex = indexAt(position.x)
                                draggedGlassX = with(density) {
                                    val nominalWidth = tabBounds[activeIndex]?.width ?: 32.dp.toPx()
                                    resistedLiquidBoundaryPosition(
                                        raw = position.x - nominalWidth / 2f - MobileInteractionGlassEdge.toPx(),
                                        minimum = glassLeft(0),
                                        maximum = glassLeft(tabs.lastIndex),
                                        maxDisplacement = 0f,
                                    )
                                }
                                dragFollower.updateTarget(draggedGlassX)
                            },
                             onHoldEnd = { _, _ ->
                                 val commit = activeIndex
                                 flightJob?.cancel()
                                 flightJob = scope.launch {

                                     // Landing continues from the displayed,
                                     // damped frame, never the raw pointer target.
                                     // A stationary hold keeps its flight frame.
                                     if (draggingGlass) glassX.snapTo(dragFollower.stopAndRead())
                                     draggingGlass = false
                                     runOverlappedLiquidFlight(
                                         lift = { glassLift.animateTo(1f, tween(100)) },
                                         move = { glassX.animateTo(glassLeft(commit), tween(120, easing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f))) },
                                         onLandingStarted = {},
                                         land = { glassLift.animateTo(0f, tween(240)) },
                                     )

                                    moving = false
                                    draggingGlass = false
                                    visualSelectedIndex = commit
                                    setSidebarGestureLock("right-tab-selector", false)
                                    onSelect(tabs[commit])
                                }
                            },
                            onCancel = {
                                dragFollower.cancel()
                                flightJob?.cancel()
                                flightJob = scope.launch { glassLift.snapTo(0f) }
                                moving = false


                                draggingGlass = false
                                setSidebarGestureLock("right-tab-selector", false)
                            },
                        ),
                ) {
                    if (moving) {
                        // Sample only the carrier, never the fixed glyphs:
                        // refracting the icon row creates a second copy below
                        // its translucent foreground even with the correct z.
                        Box(
                            Modifier.matchParentSize()
                                .layerBackdrop(tabBackdrop)
                                .background(rightSidebarCarrierColor(p).compositeOver(p.bgPrimary)),
                        )
                    }
                    Row(
                        modifier = Modifier
                            .fillMaxHeight()
                            // Foreground glyphs remain sharp above the lens and
                            // are excluded from its independent carrier sample.
                            .zIndex(6f),
                        horizontalArrangement = Arrangement.spacedBy(2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        tabs.forEachIndexed { index, target ->
                            val active = !moving && index == visualSelectedIndex
                            IconButton(
                                target.icon,
                                target.label,
                                if (active) p.accent else p.textSecondary,
                                if (active) p.accentSoft else Color.Transparent,
                                Color.Transparent,
                                modifier = Modifier.onGloballyPositioned { coordinates ->
                                    tabBounds[index] = coordinates.boundsInParent()
                                },
                                glassSurface = false,
                                pointerClick = false,
                                onClick = { flyTo(index, commit = true) },
                            )
                        }
                    }
                    if (moving) {
                        val targetBounds = tabBounds[activeIndex]
                        val targetWidth = with(density) { (targetBounds?.width ?: 32.dp.toPx()).toDp() }
                        val targetHeight = with(density) { (targetBounds?.height ?: 28.dp.toPx()).toDp() }
                        val edgeExpansion = MobileInteractionGlassEdge * 2f * glassProgress
                        val landingInset = MobileInteractionGlassEdge * (1f - glassProgress)
                        Box(
                            Modifier
                                .wrapContentSize(Alignment.TopStart, unbounded = true)
                                .requiredSize(targetWidth + edgeExpansion, targetHeight + edgeExpansion)
                                .testTag("right-tab-float")
                                 .graphicsLayer {
                                     translationX = (if (draggingGlass) dragFollower.value else glassX.value) + with(density) { landingInset.toPx() }
                                     translationY = (targetBounds?.top ?: with(density) { 6.dp.toPx() }) -
                                         with(density) { (MobileInteractionGlassEdge * glassProgress).toPx() }
                                }
                                .liquidMotionDeformationDeferred(
                                    velocityX = { if (draggingGlass) dragFollower.velocity else glassX.velocity },
                                    velocityY = { 0f },
                                    density = density.density,
                                )
                                .zIndex(5f)
                                 .liquidSelectionMorph(
                                     backdrop = tabBackdrop,
                                     shape = RoundedCornerShape(50),
                                     fillColor = p.accentSoft,
                                     glassProgress = glassProgress,
                                     glassAlpha = 0.05f,
                                     blurRadius = 2.dp,
                                     refractionHeight = MobileInteractionGlassEdge,
                                     refractionAmount = 20.dp,
                                     contact = glassContact,
                                     contactGeometry = {
                                         // Reproject the physical contact after every
                                         // translation, lift and velocity-scale frame.
                                         glassX.value; glassX.velocity; glassLift.value
                                         draggingGlass; dragFollower.value; dragFollower.velocity
                                         tabBounds[activeIndex]
                                     },
                                 ),
                        )
                    }
                }
                Spacer(Modifier.weight(1f))
                Box(Modifier.width(1.dp).height(20.dp).background(p.border2))
                IconButton(LucideIcons.X, "关闭右侧栏", p.textSecondary, onClick = onClose)
            } else {
                IconButton(selected.icon, "打开右侧栏", p.textSecondary, onClick = { onSelect(selected) })
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(p.border))
    }
}

@Composable
private fun LocalPlanPanel(vm: ChatViewModel?) {
    if (vm == null) {
        EmptyState("本地任务状态尚未加载")
        return
    }
    EditablePlanPanel(
        items = vm.currentPlanItems.map { RemotePlanItem(it.id, it.text, it.status) },
        saving = false,
        onAdd = vm::addPlanItem,
        onCycle = vm::cyclePlanItem,
        onEdit = vm::updatePlanItem,
        onRemove = vm::removePlanItem,
        onRefresh = {},
        linkedPlan = "",
        linkedPlanRevision = 0,
    )
}

@Composable
private fun IconButton(
    icon: ImageVector,
    label: String,
    tint: Color,
    background: Color = Color.Transparent,
    border: Color = Color.Transparent,
    modifier: Modifier = Modifier,
    glassSurface: Boolean = true,
    pointerClick: Boolean = true,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(50)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        modifier.size(width = 32.dp, height = 28.dp)
            .then(if (glassSurface) Modifier.liquidGlassModifier(
                shape = shape,
                alpha = 0f,
                surfaceColor = background,
                refractionHeight = if (pressed) MobileInteractionGlassEdge else 0.dp,
                refractionAmount = if (pressed) 18.dp else 0.dp,
                blurRadius = if (pressed) 2.dp else 0.dp,
                pointerGlow = true,
                ambientHighlight = pressed,
            ) else Modifier)
            // Transparent is transparent black; replacing its alpha with 1
            // makes an opaque black button. AccentSoft must retain its alpha
            // too, otherwise its RGB matches the selected icon exactly.
            .clip(shape).background(background.copy(alpha = background.alpha * if (pressed) 0.18f else 1f))
            .border(1.dp, border, shape)
            .then(if (pointerClick) Modifier.clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            ) else Modifier.semantics {
                // The parent rail owns physical taps and held drags. A child
                // clickable would consume UP in Main before that rail sees it.
                // Keep an actionable tab for accessibility without a second
                // physical pointer owner competing with the 300ms hold.
                role = Role.Tab
                this.onClick(label) { onClick(); true }
            }),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, label, tint = tint, modifier = Modifier.size(15.dp)) }
}

@Composable
private fun SectionHead(
    title: String,
    meta: String = "",
    onRefresh: (() -> Unit)? = null,
) {
    val p = LocalNewmarkColors.current
    Row(Modifier.fillMaxWidth().height(36.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, color = p.textPrimary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        if (meta.isNotBlank()) Text(meta, color = p.textTertiary, fontSize = 9.sp)
        if (onRefresh != null) Icon(LucideIcons.RefreshCw, "刷新", tint = p.textSecondary,
            modifier = Modifier.size(28.dp).padding(6.dp).clickable(onClick = onRefresh))
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(p.border))
    Spacer(Modifier.height(8.dp))
}

@Composable
private fun FilesPanel(vm: DesktopLinkViewModel, onFileOpened: () -> Unit) {
    val p = LocalNewmarkColors.current
    Column {
        SectionHead(
            "Workspace file tree",
            onRefresh = { vm.loadRightSidebarDirectory(vm.rightSidebarPath) },
        )
        if (vm.rightSidebarPath.isNotBlank()) {
            Row(Modifier.fillMaxWidth().clickable {
                vm.loadRightSidebarDirectory(vm.rightSidebarPath.substringBeforeLast('/', ""))
            }.padding(horizontal = 8.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(LucideIcons.ChevronLeft, null, tint = p.textSecondary, modifier = Modifier.size(14.dp))
                Text(vm.rightSidebarPath, color = p.textSecondary, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (!vm.rightSidebarLoading && vm.rightSidebarFiles.isEmpty()) EmptyState(vm.rightSidebarError.ifBlank { "工作区中没有可显示的文件" })
        else LazyColumn(Modifier.fillMaxSize()) {
            items(vm.rightSidebarFiles, key = { it.path }) { file ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).clickable {
                    if (file.directory) vm.loadRightSidebarDirectory(file.path)
                    else { vm.openRightSidebarFile(file.path); onFileOpened() }
                }.padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (file.directory) LucideIcons.Folder else LucideIcons.SquarePen, null,
                        tint = p.textSecondary, modifier = Modifier.size(15.dp))
                    Text(file.name, color = p.textSecondary, fontSize = 12.sp, maxLines = 1,
                        overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp))
                }
            }
        }
    }
}

@Composable
private fun EditorPanel(vm: DesktopLinkViewModel) {
    val p = LocalNewmarkColors.current
    val lightTheme = p == NewmarkLightThemeColors
    val editorBackground = if (lightTheme) Color(0xFFF7F8FC) else Color(0xFF141414)
    val gutterBackground = if (lightTheme) Color(0x0B1D243A) else Color(0x06FFFFFF)
    val editorCaret = if (lightTheme) Color(0xFF172033) else Color.White
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    var markdownPreview by remember { mutableStateOf(false) }
    val markdownFile = remember(vm.rightSidebarEditorPath) {
        vm.rightSidebarEditorPath.substringAfterLast('.', "").lowercase() in setOf("md", "markdown")
    }
    val lineCount = remember(vm.rightSidebarEditorContent) { vm.rightSidebarEditorContent.count { it == '\n' } + 1 }
    val gutter = remember(lineCount) { (1..lineCount).joinToString("\n") }
    LaunchedEffect(vm.rightSidebarEditorPath) {
        markdownPreview = false
        if (vm.rightSidebarEditorPath.isNotBlank()) {
            focusRequester.requestFocus()
            keyboardController?.show()
        }
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().height(39.dp).padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            EditorToolbarButton(LucideIcons.Save, "保存", vm.rightSidebarEditorPath.isNotBlank()) { vm.saveRightSidebarFile() }
            if (markdownFile) {
                EditorToolbarButton(
                    LucideIcons.BookOpen,
                    if (markdownPreview) "返回编辑" else "Markdown 预览",
                    enabled = true,
                    active = markdownPreview,
                ) {
                    markdownPreview = !markdownPreview
                    if (markdownPreview) keyboardController?.hide()
                    else {
                        focusRequester.requestFocus()
                        keyboardController?.show()
                    }
                }
            }
            EditorToolbarButton(LucideIcons.X, "关闭", vm.rightSidebarEditorPath.isNotBlank()) { vm.closeRightSidebarFile() }
            Text(vm.rightSidebarEditorPath.ifBlank { "No file selected" }, color = p.textTertiary, fontSize = 10.sp,
                textAlign = androidx.compose.ui.text.style.TextAlign.End, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f))
        }
        Column(Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp)).background(editorBackground)
            .border(1.dp, p.border2, RoundedCornerShape(8.dp))) {
            AnimatedContent(
                targetState = markdownPreview && markdownFile,
                transitionSpec = {
                    (fadeIn(tween(190)) + androidx.compose.animation.slideInHorizontally(tween(220)) { it / 12 }) togetherWith
                        (fadeOut(tween(130)) + androidx.compose.animation.slideOutHorizontally(tween(170)) { -it / 16 })
                },
                modifier = Modifier.weight(1f).fillMaxWidth(),
                label = "editorMarkdownPreview",
            ) { preview ->
                if (preview) {
                    Column(
                        Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(
                                start = MobileReadableStartInset,
                                end = MobileReadableEndInset,
                                top = 12.dp,
                                bottom = 12.dp,
                            ),
                    ) {
                        if (vm.rightSidebarEditorContent.isBlank()) {
                            Text("从文件树打开 Markdown 文件即可在这里预览。", color = p.textTertiary, fontSize = 11.sp)
                        } else {
                            MarkdownBody(
                                text = vm.rightSidebarEditorContent,
                                baseColor = p.textPrimary,
                                baseFontSize = 12f,
                                baseLineHeight = 18f,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                } else Row(Modifier.fillMaxSize()) {
                    Text(gutter, color = p.textTertiary, fontSize = 11.sp, lineHeight = 17.sp, fontFamily = FontFamily.Monospace,
                        textAlign = androidx.compose.ui.text.style.TextAlign.End,
                        modifier = Modifier.width(44.dp).fillMaxHeight().background(gutterBackground).padding(top = 10.dp, end = 8.dp))
                    BasicTextField(
                        value = vm.rightSidebarEditorContent,
                        onValueChange = vm::updateRightSidebarEditor,
                        enabled = vm.rightSidebarEditorPath.isNotBlank(),
                        textStyle = TextStyle(color = p.textPrimary, fontSize = 11.sp, lineHeight = 17.sp, fontFamily = FontFamily.Monospace),
                        cursorBrush = SolidColor(editorCaret),
                        modifier = Modifier.fillMaxSize().focusRequester(focusRequester)
                            .onFocusChanged { if (it.isFocused) keyboardController?.show() }.padding(10.dp),
                        decorationBox = { inner ->
                            if (vm.rightSidebarEditorPath.isBlank()) Text("Open a file to edit...", color = p.textTertiary, fontSize = 11.sp)
                            inner()
                        },
                    )
                }
            }
            Row(Modifier.fillMaxWidth().height(25.dp).border(1.dp, p.border).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Text(if (markdownPreview) "READ" else "INSERT", color = p.green, fontSize = 9.sp,
                    fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                Text("  ${editorLanguage(vm.rightSidebarEditorPath)}", color = p.textTertiary, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
                Spacer(Modifier.weight(1f))
                Text(if (vm.rightSidebarSaving) "Saving…" else "$lineCount lines", color = p.textTertiary, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

private fun editorLanguage(path: String): String = path.substringAfterLast('.', "text").ifBlank { "text" }

@Composable
private fun EditorToolbarButton(icon: ImageVector, label: String, enabled: Boolean, active: Boolean = false, onClick: () -> Unit) {
    val p = LocalNewmarkColors.current
    val shape = RoundedCornerShape(50)
    Box(Modifier.size(30.dp).glassButtonSurface(shape, if (active) p.accentSoft else p.bgPrimary)
        .border(1.dp, if (active) p.accentBorder else p.border2, shape).clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = if (active) p.accent else if (enabled) p.textSecondary else p.textTertiary.copy(alpha = .35f), modifier = Modifier.size(15.dp))
    }
}

@Composable
private fun PlanPanel(vm: DesktopLinkViewModel) {
    EditablePlanPanel(
        items = vm.rightSidebarPlan.items,
        saving = vm.rightSidebarSaving,
        onAdd = vm::addRightSidebarPlanItem,
        onCycle = vm::cycleRightSidebarPlanItem,
        onEdit = vm::updateRightSidebarPlanItem,
        onRemove = vm::removeRightSidebarPlanItem,
        onRefresh = vm::refreshRightSidebar,
        linkedPlan = vm.rightSidebarLinkedPlan.markdown,
        linkedPlanRevision = vm.rightSidebarLinkedPlan.revision,
    )
}

/** PC plan-compose + plan-row：新增、状态循环、编辑和删除全部在同一个任务面板内。 */
@Composable
private fun EditablePlanPanel(
    items: List<RemotePlanItem>,
    saving: Boolean,
    onAdd: (String) -> Unit,
    onCycle: (String) -> Unit,
    onEdit: (String, String) -> Unit,
    onRemove: (String) -> Unit,
    onRefresh: () -> Unit,
    linkedPlan: String,
    linkedPlanRevision: Int,
) {
    val p = LocalNewmarkColors.current
    var draft by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        SectionHead("当前对话计划", meta = if (saving) "正在保存…" else "", onRefresh = onRefresh)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            BasicTextField(
                value = draft,
                onValueChange = { draft = it },
                singleLine = true,
                textStyle = TextStyle(color = p.textPrimary, fontSize = 12.sp),
                modifier = Modifier.weight(1f).clip(RoundedCornerShape(8.dp)).background(p.bgPrimary)
                    .border(1.dp, p.border2, RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 8.dp),
                decorationBox = { inner ->
                    if (draft.isBlank()) Text("新建计划项…", color = p.textTertiary, fontSize = 12.sp)
                    inner()
                },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = {
                    onAdd(draft)
                    draft = ""
                }),
            )
            IconButton(LucideIcons.Plus, "新增计划项", p.textPrimary, p.accentSoft, p.accentBorder) {
                onAdd(draft)
                draft = ""
            }
        }
        Spacer(Modifier.height(10.dp))
        if (items.isEmpty()) EmptyState("当前对话暂无计划项")
        items.forEach { item ->
            EditablePlanRow(item = item, onCycle = { onCycle(item.id) }, onEdit = { onEdit(item.id, it) }, onRemove = { onRemove(item.id) })
            Spacer(Modifier.height(7.dp))
        }
        Spacer(Modifier.height(8.dp))
        SectionHead("关联计划", meta = if (linkedPlanRevision > 0) "r$linkedPlanRevision" else "")
        if (linkedPlan.isNotBlank()) {
            Text(linkedPlan, color = p.textPrimary, fontSize = 11.sp, lineHeight = 17.sp)
        } else {
            EmptyState("当前对话没有关联计划")
        }
    }
}

@Composable
private fun EditablePlanRow(item: RemotePlanItem, onCycle: () -> Unit, onEdit: (String) -> Unit, onRemove: () -> Unit) {
    val p = LocalNewmarkColors.current
    var editing by remember(item.id) { mutableStateOf(false) }
    var value by remember(item.id, item.text) { mutableStateOf(item.text) }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(p.bgPrimary)
            .border(1.dp, p.border, RoundedCornerShape(8.dp)).padding(7.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        IconButton(
            LucideIcons.Check,
            "切换任务状态",
            if (item.status == "done") p.green else p.textSecondary,
            border = if (item.status == "in_progress") p.warning.copy(alpha = .5f) else p.border,
        ) { onCycle() }
        if (editing) {
            BasicTextField(
                value = value,
                onValueChange = { value = it },
                textStyle = TextStyle(color = p.textPrimary, fontSize = 11.sp, lineHeight = 16.sp),
                modifier = Modifier.weight(1f).border(1.dp, p.accentBorder, RoundedCornerShape(6.dp)).padding(6.dp),
            )
            IconButton(LucideIcons.Check, "保存任务", p.accent) {
                onEdit(value)
                editing = false
            }
        } else {
            Text(
                item.text,
                color = if (item.status == "done") p.textSecondary else p.textPrimary,
                fontSize = 11.sp,
                lineHeight = 16.sp,
                modifier = Modifier.weight(1f).clickable { editing = true }.padding(top = 5.dp),
            )
            IconButton(LucideIcons.Pencil, "编辑任务", p.textSecondary) { editing = true }
        }
        IconButton(LucideIcons.X, "删除任务", p.red) { onRemove() }
    }
}

@Composable
private fun SubagentPanel(vm: DesktopLinkViewModel, onOpen: (RemoteSubagent) -> Unit) {
    val p = LocalNewmarkColors.current
    Column {
        SectionHead("Subagents", onRefresh = vm::refreshRightSidebar)
        if (vm.rightSidebarSubagents.isEmpty()) EmptyState("暂无保留的 Subagent 记录")
        else LazyColumn(Modifier.fillMaxSize()) {
            items(vm.rightSidebarSubagents, key = { it.id }) { agent ->
                Row(Modifier.fillMaxWidth().animateItem(
                    fadeInSpec = tween(180),
                    placementSpec = tween(240, easing = CubicBezierEasing(.16f, 1f, .3f, 1f)),
                    fadeOutSpec = tween(140),
                ).clickable { onOpen(agent) }.padding(horizontal = 8.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Icon(LucideIcons.Bot, null, tint = p.accent, modifier = Modifier.size(16.dp))
                    Column(Modifier.weight(1f).padding(horizontal = 7.dp)) {
                        Text(agent.displayName.ifBlank { agent.name }, color = p.textPrimary, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${agent.mode} / ${agent.model.ifBlank { "default" }} / ${agent.messageCount} 条消息",
                            color = p.textTertiary, fontSize = 9.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    AnimatedContent(
                        targetState = agent.status,
                        transitionSpec = { fadeIn(tween(160)) togetherWith fadeOut(tween(120)) },
                        label = "subagentStatus",
                    ) { status -> Text(status, color = p.green, fontSize = 9.sp) }
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(p.border))
            }
        }
    }
}

@Composable
fun SubagentHistoryPage(agent: RemoteSubagent, onBack: () -> Unit) {
    val p = LocalNewmarkColors.current
    val (_, predictiveModifier) = predictiveBackMotion(onBack)
    Column(Modifier.fillMaxSize().then(predictiveModifier).background(p.bgPrimary).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(52.dp).background(p.bgSecondary).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(LucideIcons.ChevronLeft, "返回", p.textPrimary, onClick = onBack)
            Text("Subagent 历史", color = p.textPrimary, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 10.dp))
        }
        SubagentHistoryContent(agent, Modifier.fillMaxSize().padding(16.dp))
    }
}

@Composable
private fun SubagentHistoryDialog(agent: RemoteSubagent, onDismiss: () -> Unit) {
    val p = LocalNewmarkColors.current
    val exit = rememberLiquidPopupExit(onDismiss)
    val (_, predictiveModifier) = predictiveBackMotion(exit::requestClose, fadeOnly = true)
    val backdrop = rememberLiquidBackdrop()
    Dialog(onDismissRequest = exit::requestClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        DialogBackdropBlur(42.dp)
        Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().layerBackdrop(backdrop))
        Box(predictiveModifier.fillMaxWidth(.82f).fillMaxHeight(.8f).widthIn(max = 680.dp)
            .liquidPopupExit(exit)
            .liquidPopupShell(
                backdrop = backdrop,
                shape = MobilePopupShape,
                alpha = 0.18f,
                blurRadius = 12.dp,
                refractionHeight = MobileInteractionGlassEdge,
                refractionAmount = 22.dp,
                surfaceColor = p.bgSecondary,
            )) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("实时历史 — 运行期间自动更新。", color = p.textSecondary, fontSize = 11.sp, modifier = Modifier.weight(1f))
                    IconButton(LucideIcons.X, "关闭", p.textSecondary, onClick = exit::requestClose)
                }
                SubagentHistoryContent(agent, Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp))
            }
        }
        }
    }
}

@Composable
private fun SubagentHistoryContent(agent: RemoteSubagent, modifier: Modifier = Modifier) {
    val p = LocalNewmarkColors.current
    Column(modifier.verticalScroll(rememberScrollState())) {
        Text(agent.displayName.ifBlank { agent.name.ifBlank { "Subagent 历史" } }, color = p.textPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        Text(agent.name.ifBlank { agent.id }, color = p.textTertiary, fontSize = 9.sp, modifier = Modifier.padding(top = 3.dp))
        Text("${agent.status} / ${agent.mode} / ${agent.model.ifBlank { "default" }}", color = p.textSecondary,
            fontSize = 10.sp, modifier = Modifier.padding(top = 7.dp, bottom = 10.dp))
        agent.result?.takeIf(String::isNotBlank)?.let {
            Text("结果", color = p.green, fontSize = 11.sp, modifier = Modifier.padding(bottom = 4.dp))
            Text(it, color = p.textPrimary, fontSize = 11.sp, lineHeight = 16.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(p.bgTertiary)
                    .border(1.dp, p.border, RoundedCornerShape(8.dp)).padding(10.dp))
        }
        Text("历史", color = p.green, fontSize = 11.sp, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
        if (agent.messages.isEmpty()) EmptyState("没有记录消息。")
        agent.messages.forEach { message ->
            key(message.role, message.content) {
                AnimatedVisibility(visible = true, enter = fadeIn(tween(180)), exit = fadeOut(tween(120))) {
                    Column {
                        Text(message.role.uppercase(), color = p.textTertiary, fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
                        Text(message.content, color = p.textPrimary, fontSize = 11.sp, lineHeight = 16.sp, modifier = Modifier.padding(bottom = 10.dp))
                    }
                }
            }
        }
        if (agent.error.isNotBlank()) Text(agent.error, color = p.red, fontSize = 11.sp, lineHeight = 16.sp)
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun BrowserPanel(
    session: BrowserSessionState,
    visible: Boolean,
    localVm: ChatViewModel? = null,
    modifier: Modifier = Modifier,
) {
    key(session) {
        val context = LocalContext.current
        var startupReady by remember { mutableStateOf(false) }
        var startupError by remember { mutableStateOf("") }
        LaunchedEffect(visible, session.hasActivity) {
            if (visible || session.hasActivity) {
                try {
                    BrowserStartup.await(context)
                    startupReady = true
                } catch (cancelled: kotlinx.coroutines.CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    startupError = "浏览器暂时无法启动：${error.message.orEmpty()}"
                }
            }
        }
        if (visible || session.hasActivity) {
            if (startupReady) {
                ConversationBrowserPanel(session, visible, localVm, modifier)
            } else if (visible) {
                Box(modifier, contentAlignment = Alignment.Center) {
                    EmptyState(startupError.ifBlank { "正在准备浏览器…" })
                }
            }
        }
    }
}

internal fun browserAddressScrollTarget(
    cursorLeft: Float,
    cursorRight: Float,
    currentScroll: Int,
    viewportWidth: Int,
    maxScroll: Int,
    edgePadding: Float,
): Int {
    if (viewportWidth <= 0 || maxScroll <= 0) return currentScroll.coerceIn(0, maxScroll.coerceAtLeast(0))
    val visibleLeft = currentScroll.toFloat()
    val visibleRight = visibleLeft + viewportWidth
    val target = when {
        cursorLeft < visibleLeft + edgePadding -> cursorLeft - edgePadding
        cursorRight > visibleRight - edgePadding -> cursorRight + edgePadding - viewportWidth
        else -> currentScroll.toFloat()
    }
    return target.roundToInt().coerceIn(0, maxScroll)
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun ConversationBrowserPanel(session: BrowserSessionState, visible: Boolean, localVm: ChatViewModel? = null, modifier: Modifier = Modifier) {
    val p = LocalNewmarkColors.current
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    var address by remember {
        mutableStateOf(TextFieldValue(session.address, TextRange(session.address.length)))
    }
    val addressScroll = rememberScrollState()
    val density = LocalDensity.current
    var addressLayout by remember { mutableStateOf<TextLayoutResult?>(null) }
    var addressViewportWidth by remember { mutableStateOf(0) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    var recognition by remember { mutableStateOf<BrowserRecognition?>(null) }
    var recognitionHandler by remember { mutableStateOf<(suspend (String, Int) -> org.json.JSONObject)?>(null) }
    var rendererFailed by remember { mutableStateOf(false) }

    LaunchedEffect(session.address) {
        if (session.address != address.text) {
            address = TextFieldValue(session.address, TextRange(session.address.length))
        }
    }
    LaunchedEffect(address.selection, addressLayout, addressViewportWidth, addressScroll.maxValue) {
        val layout = addressLayout ?: return@LaunchedEffect
        val cursor = layout.getCursorRect(address.selection.end.coerceIn(0, address.text.length))
        val target = browserAddressScrollTarget(
            cursorLeft = cursor.left,
            cursorRight = cursor.right,
            currentScroll = addressScroll.value,
            viewportWidth = addressViewportWidth,
            maxScroll = addressScroll.maxValue,
            edgePadding = with(density) { 14.dp.toPx() },
        )
        if (target != addressScroll.value) {
            addressScroll.animateScrollTo(
                target,
                tween(durationMillis = 90, easing = CubicBezierEasing(.16f, 1f, .3f, 1f)),
            )
        }
    }

    fun navigate() {
        session.navigate(address.text)
        focus.clearFocus()
    }
    LaunchedEffect(webView, session.command.id) {
        val view = webView ?: return@LaunchedEffect
        val command = session.command
        when (command.kind) {
            BrowserCommandKind.Navigate -> view.loadUrl(command.url)
            BrowserCommandKind.Back -> if (view.canGoBack()) view.goBack()
            BrowserCommandKind.Forward -> if (view.canGoForward()) view.goForward()
            BrowserCommandKind.Reload -> view.reload()
        }
    }
    Column(modifier) {
        Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            EditorToolbarButton(LucideIcons.ArrowLeft, "后退", session.canGoBack) { session.back() }
            EditorToolbarButton(LucideIcons.ArrowRight, "前进", session.canGoForward) { session.forward() }
            EditorToolbarButton(LucideIcons.RefreshCw, "刷新", webView != null || rendererFailed) {
                if (rendererFailed) {
                    rendererFailed = false
                    session.navigate(session.address)
                } else session.reload()
            }
            Box(
                modifier = Modifier.weight(1f).height(30.dp)
                    .background(p.bgPrimary, RoundedCornerShape(8.dp))
                    .border(1.dp, p.border2, RoundedCornerShape(8.dp)),
                contentAlignment = Alignment.CenterStart,
            ) {
                BasicTextField(
                    value = address,
                    onValueChange = { value ->
                        address = value
                        session.updateAddressDraft(value.text)
                    },
                    singleLine = true,
                    textStyle = TextStyle(color = p.textPrimary, fontSize = 11.sp, lineHeight = 16.sp),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { navigate() }),
                    onTextLayout = { addressLayout = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .onSizeChanged { addressViewportWidth = it.width }
                        .horizontalScroll(addressScroll)
                        .padding(horizontal = 9.dp),
                )
            }
            EditorToolbarButton(LucideIcons.Send, "转到", true) { navigate() }
        }
        if (session.isLoading) {
            Box(Modifier.fillMaxWidth().height(2.dp).background(p.border)) {
                Box(
                    Modifier
                        .fillMaxWidth((session.progress.coerceAtLeast(4) / 100f).coerceIn(0f, 1f))
                        .fillMaxHeight()
                        .background(p.accent),
                )
            }
        }
        if (session.title.isNotBlank() || session.error.isNotBlank()) {
            Text(
                text = session.error.ifBlank { session.title },
                color = if (session.error.isBlank()) p.textTertiary else p.red,
                fontSize = 10.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth().padding(top = 5.dp, bottom = 6.dp),
            )
        }
        if (rendererFailed) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                EmptyState("网页已停止，可点击刷新重新加载")
            }
        } else AndroidView(
            factory = {
                ManagedBrowserWebView(context).apply {
                    // Route target=_blank/window.open into this conversation's
                    // single browser session so the resulting page keeps the
                    // address bar and Reload action.
                    applyNewmarkBrowserSettings()
                    bindBrowserClients(context, this, session, onRendererGone = { failed ->
                        recognitionHandler?.let(session::unbindRecognition)
                        recognitionHandler = null
                        recognition?.close()
                        recognition = null
                        if (webView === failed) webView = null
                        rendererFailed = true
                        (failed as ManagedBrowserWebView).release(stopPendingLoad = false)
                    })
                    val handler: suspend (String, Int) -> org.json.JSONObject = { url, maxChars ->
                        val browserRecognition = recognition
                            ?: BrowserRecognition(
                                context.applicationContext,
                                this,
                                { image -> localVm?.inspectBrowserImage(image).orEmpty() },
                                { session.isPdfDocument },
                            ).also { recognition = it }
                        val receipt = browserRecognition.recognize(url, maxChars, session.forceVisual, session.recognitionPage)
                        val raw = receipt.optString("text")
                        if (raw.isNotBlank() && localVm != null && receipt.optString("engine") == "mlkit-bundled") {
                            val corrected = localVm.correctFinalVisualOcr(raw, receipt.optString("profile"))
                            if (corrected.isNotBlank()) {
                                receipt.put("corrected_text", corrected.take(maxChars))
                                receipt.put("fallback", "mini_ocr_llm")
                                receipt.put("uncertainty", "preserved")
                                receipt.put("warning", "视觉输入不可用；内容来自本地 OCR 和文本模型保守校正，可能不完整")
                            }
                        }
                        receipt
                    }
                    recognitionHandler = handler
                    session.bindRecognition(handler)
                    webView = this
                    session.viewportHandler = { size -> applyBrowserViewport(this, size) }
                    visibility = if (visible) View.VISIBLE else View.INVISIBLE
                }.let { browser -> BrowserViewportLayout(context, browser).apply { viewport = session.viewport } }
            },
            update = { view ->
                // INVISIBLE keeps the warmed WebView mounted and loading, but
                // guarantees it cannot draw over or intercept sibling tabs.
                val visibility = if (visible) View.VISIBLE else View.INVISIBLE
                view.browser.visibility = visibility
                if (view.visibility != visibility) {
                    view.visibility = visibility
                    if (visible) view.browser.onResume() else view.browser.onPause()
                }
            },
            modifier = Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(8.dp)).border(1.dp, p.border2, RoundedCornerShape(8.dp)),
        )
    }
    DisposableEffect(Unit) {
        onDispose {
            recognitionHandler?.let(session::unbindRecognition)
            recognitionHandler = null
            session.viewportHandler = null
            recognition?.close()
            recognition = null
            (webView as? ManagedBrowserWebView)?.release()
            webView = null
        }
    }
}

@Composable
private fun EmptyState(text: String) {
    val p = LocalNewmarkColors.current
    Text(text, color = p.textTertiary, fontSize = 11.sp, modifier = Modifier.fillMaxWidth().padding(12.dp))
}
