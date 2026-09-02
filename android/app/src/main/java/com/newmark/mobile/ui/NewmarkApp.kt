package com.newmark.mobile.ui

import android.Manifest
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.provider.Settings
import android.view.View
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DrawerState
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.zIndex
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.core.content.ContextCompat
import com.newmark.mobile.data.CalendarTool
import com.newmark.mobile.data.AlarmTool
import com.newmark.mobile.data.LocalWorkEvent
import com.newmark.mobile.data.IncomingShare
import com.newmark.mobile.data.IncomingShareRouter
import com.newmark.mobile.data.IncomingShareTarget
import com.newmark.mobile.data.LocalWorkRun
import com.newmark.mobile.ui.QueueMessageUi
import com.newmark.mobile.data.ModelOption
import com.newmark.mobile.data.RemoteConversation
import com.newmark.mobile.data.RemoteConversationImage
import com.newmark.mobile.data.RemoteFlowTakeover
import com.newmark.mobile.data.RemoteGoal
import com.newmark.mobile.data.WorkDisplayImage
import com.newmark.mobile.data.WorkConversationImage
import com.newmark.mobile.data.WorkGuide
import com.newmark.mobile.data.RemoteSubagent
import com.newmark.mobile.data.RemoteWorkRun
import com.newmark.mobile.data.RemoteTrackingContract
import com.newmark.mobile.data.RemotePayloadNormalizer
import com.newmark.mobile.data.ThemeStore
import com.newmark.mobile.data.WorkspaceInfo
import com.newmark.mobile.ui.theme.LocalNewmarkColors
import com.newmark.mobile.ui.theme.LocalGlassMode
import com.newmark.mobile.ui.theme.mobileBackdropBlurDp
import com.newmark.mobile.ui.theme.scaledGlassAlpha
import com.newmark.mobile.ui.theme.LocalThemeMode
import com.newmark.mobile.ui.theme.NewmarkBgPrimary
import com.newmark.mobile.ui.theme.NewmarkBgSecondary
import com.newmark.mobile.ui.theme.NewmarkScrim
import com.newmark.mobile.ui.components.LocalLiquidBackdrop
import com.newmark.mobile.ui.components.LocalSidebarGestureLock
import com.newmark.mobile.ui.components.rememberLiquidBackdrop
import com.newmark.mobile.ui.components.liquidGlassModifier
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.LayerBackdrop
import com.newmark.mobile.ui.theme.NewmarkTheme
import com.newmark.mobile.ui.theme.ThemeMode
import com.newmark.mobile.vm.ChatViewModel
import com.newmark.mobile.vm.DesktopLinkViewModel
import com.newmark.mobile.vm.LinkStatus
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.android.awaitFrame
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val LocalTimeFmt = DateTimeFormatter.ofPattern("HH:mm:ss")
private val PcEaseOutExpo = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)
private val SidebarEaseInOut = CubicBezierEasing(0.4f, 0f, 0.2f, 1f)
private val IndependentPageExitEase = CubicBezierEasing(0.4f, 0f, 1f, 1f)

internal fun sidebarPresentedProgress(
    dragging: Boolean,
    dragProgress: Float,
    settleStart: Float?,
    animatedProgress: Float,
): Float = when {
    dragging -> dragProgress
    settleStart != null -> settleStart
    else -> animatedProgress
}

/** Connection transitions must not change which conversation surface owns focus. */
internal fun shouldPresentRemoteConversation(preferLocal: Boolean, hasPairedDevice: Boolean): Boolean =
    !preferLocal && hasPairedDevice

@Composable
private fun SidebarFrameProgressHost(
    rightDragging: Boolean,
    rightDragProgress: Float,
    rightSettleStart: Float?,
    rightMotion: Animatable<Float, AnimationVector1D>,
    leftDragging: Boolean,
    leftDragProgress: Float,
    leftSettleStart: Float?,
    leftMotion: Animatable<Float, AnimationVector1D>,
    content: @Composable (leftProgress: Float, rightProgress: Float) -> Unit,
) {
    // Keep frame-by-frame snapshot reads in this narrow restart scope. The
    // parent retains the same conversation surface and callbacks while only
    // this host and the affected layout boundary advance on the frame clock.
    val rightProgress = sidebarPresentedProgress(
        dragging = rightDragging,
        dragProgress = rightDragProgress,
        settleStart = rightSettleStart,
        animatedProgress = rightMotion.value,
    )
    val leftProgress = sidebarPresentedProgress(
        dragging = leftDragging,
        dragProgress = leftDragProgress,
        settleStart = leftSettleStart,
        animatedProgress = leftMotion.value,
    )
    content(leftProgress, rightProgress)
}

private fun formatLocalTime(ms: Long): String =
    runCatching { LocalTimeFmt.format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault())) }
        .getOrDefault("")

/** ISO 时间 → epoch ms（PC 事件时间戳） */
private fun parseIsoMs(iso: String): Long =
    runCatching { Instant.parse(iso).toEpochMilli() }.getOrDefault(0L)

/** 桌面端 work run → 本地渲染结构（事件 durationMs 按相邻事件时间差计算） */
internal fun remoteRunToLocal(run: RemoteWorkRun): LocalWorkRun {
    val normalizedRun = RemotePayloadNormalizer.workRun(run)
    // Gson can instantiate Kotlin DTOs without invoking their default-value
    // constructors. A field omitted by an older desktop server is therefore a
    // runtime null even when the source property is declared non-null. Normalize
    // the complete remote boundary once before constructing strict local UI
    // models; otherwise Release/R8 crashes one omitted field at a time.
    val remoteEvents = normalizedRun.events.orEmpty()
    val times = remoteEvents.map { parseIsoMs(it.timestamp.orEmpty()) }
    val events = remoteEvents.mapIndexed { i, e ->
        LocalWorkEvent(
            type = e.type.orEmpty(),
            id = e.id.orEmpty(),
            content = e.content.orEmpty(),
            mode = e.mode.orEmpty(),
            model = e.model.orEmpty(),
            toolCallId = e.toolCallId.orEmpty(),
            toolName = e.toolName.orEmpty(),
            toolArgs = e.toolArgs.orEmpty(),
            timestamp = times[i],
            timestampText = e.timestamp.orEmpty(),
            sequence = e.sequence,
            status = e.status.orEmpty(),
            clientMessageId = e.clientMessageId.orEmpty(),
            guideId = e.guideId.orEmpty(),
            guide = e.guide?.let { guide ->
                WorkGuide(
                    clientMessageId = guide.clientMessageId.orEmpty(),
                    guideId = guide.guideId.orEmpty(),
                    runId = guide.runId.orEmpty(),
                    status = guide.status.orEmpty(),
                    content = guide.content.orEmpty(),
                    createdAt = guide.createdAt.orEmpty(),
                    updatedAt = guide.updatedAt.orEmpty(),
                    appliedAt = guide.appliedAt.orEmpty(),
                    reason = guide.reason.orEmpty(),
                    attachments = guide.attachments.orEmpty().map { attachment ->
                        WorkConversationImage(
                            id = attachment.id.orEmpty(),
                            origin = attachment.origin.orEmpty(),
                            name = attachment.name.orEmpty(),
                            mimeType = attachment.mimeType.orEmpty(),
                            dataUrl = attachment.dataUrl.orEmpty(),
                            width = attachment.width,
                            height = attachment.height,
                        )
                    },
                )
            },
            displayImage = e.displayImage?.let { image ->
                WorkDisplayImage(
                    id = image.id.orEmpty(),
                    origin = image.origin.orEmpty(),
                    name = image.name.orEmpty(),
                    caption = image.caption.orEmpty(),
                    mimeType = image.mimeType.orEmpty(),
                    dataUrl = image.dataUrl.orEmpty(),
                    width = image.width,
                    height = image.height,
                )
            },
            durationMs = if (i + 1 < times.size) maxOf(0L, times[i + 1] - times[i]) else 0L,
        )
    }
    val guideEvents = normalizedRun.guides.orEmpty().mapIndexed { i, guide ->
        val guideStatus = guide.status.orEmpty()
        val guideClientMessageId = guide.clientMessageId.orEmpty()
        val guideId = guide.guideId.orEmpty()
        val guideCreatedAt = guide.createdAt.orEmpty()
        val guideUpdatedAt = guide.updatedAt.orEmpty()
        LocalWorkEvent(
            type = "guide_${guideStatus.ifBlank { "accepted" }}",
            id = "guide:${guideClientMessageId.ifBlank { guideId }}",
            content = guide.content.orEmpty(),
            timestamp = parseIsoMs(guideUpdatedAt.ifBlank { guideCreatedAt }),
            timestampText = guideUpdatedAt.ifBlank { guideCreatedAt },
            sequence = Long.MAX_VALUE / 2 + i,
            status = guideStatus,
            clientMessageId = guideClientMessageId,
            guideId = guideId,
            guide = WorkGuide(
                clientMessageId = guideClientMessageId,
                guideId = guideId,
                runId = guide.runId.orEmpty(),
                status = guideStatus,
                content = guide.content.orEmpty(),
                createdAt = guideCreatedAt,
                updatedAt = guideUpdatedAt,
                appliedAt = guide.appliedAt.orEmpty(),
                reason = guide.reason.orEmpty(),
                attachments = guide.attachments.orEmpty().map { attachment ->
                    WorkConversationImage(
                        id = attachment.id.orEmpty(),
                        origin = attachment.origin.orEmpty(),
                        name = attachment.name.orEmpty(),
                        mimeType = attachment.mimeType.orEmpty(),
                        dataUrl = attachment.dataUrl.orEmpty(),
                        width = attachment.width,
                        height = attachment.height,
                    )
                },
            ),
        )
    }
    val startedAtText = normalizedRun.startedAt.orEmpty()
    val endedAtText = normalizedRun.endedAt.orEmpty()
    val startedAt = parseIsoMs(startedAtText)
    val endedAt = if (endedAtText.isNotBlank()) parseIsoMs(endedAtText) else startedAt
    return LocalWorkRun(
        runId = normalizedRun.runId.orEmpty(),
        status = normalizedRun.status.orEmpty(),
        startedAt = startedAt,
        endedAt = endedAt,
        expanded = normalizedRun.expanded,
        events = events + guideEvents,
        text = remoteEvents.lastOrNull { it.type == "response" || it.type == "final_response" }?.content.orEmpty(),
        anchorMessageId = normalizedRun.anchorMessageId.orEmpty(),
        branchNodeId = normalizedRun.branchNodeId.orEmpty(),
    )
}

private enum class Screen { Main, Settings, MemoryLab, Terminal }

/** Expanded-layout rail state is never inherited by the compact portrait drawer. */
internal fun sidebarRailForLayout(isCompact: Boolean, expandedLayoutRail: Boolean): Boolean =
    !isCompact && expandedLayoutRail

/**
 * Compose binds one conversation command surface. Local/remote differences
 * live behind this adapter instead of being reimplemented by every button,
 * layout, popup and queue row.
 */
private data class ConversationUiActions(
    val send: (String) -> Unit,
    val sendImages: (String, List<com.newmark.mobile.data.LocalImageAttachment>) -> Unit,
    val guide: (String) -> Boolean,
    val stop: () -> Unit,
    val selectModel: (ModelOption) -> Unit,
    val selectIntelligence: (String) -> Unit,
    val selectMode: (String) -> Unit,
    val editGoal: (String) -> Unit,
    val toggleGoalPause: () -> Unit,
    val deleteGoal: () -> Unit,
    val toggleFlow: () -> Unit,
    val toggleQueuePause: () -> Unit,
    val updateQueueItem: (String, String) -> Unit,
    val deleteQueueItem: (String) -> Unit,
    val reorderQueueItems: (List<String>) -> Unit,
    val guideQueueItem: (String) -> Unit,
    val inspectBranch: (String, Int) -> Unit,
    val editUserMessage: (Int, String) -> Unit,
)

/** One immutable argument surface shared by compact and expanded layouts. */
private data class ConversationSurface(
    val title: String,
    val items: List<ChatItem>,
    val isSending: Boolean,
    val remoteMode: Boolean,
    val modelOptions: List<ModelOption>,
    val selectedModel: String,
    val selectedProviderId: String,
    val selectedModelName: String,
    val intelligence: String,
    val selectedMode: String,
    val actions: ConversationUiActions,
    val escalating: Boolean,
    val showConnectRemote: Boolean,
    val onConnectRemote: () -> Unit,
    val goal: RemoteGoal?,
    val flow: RemoteFlowTakeover?,
    val queueItems: List<QueueMessageUi>,
    val queuePaused: Boolean,
    val onNewChat: () -> Unit,
    val onOpenWebLink: (String) -> Unit,
    val onBeginFileUpload: () -> (suspend (String, String, ByteArray) -> Result<String>),
    val uploadInjectsGuide: Boolean,
)

/** 自适应根布局：主题（亮暗色开关） + 竖屏 drawer / 平板 rail↔full，绑定本地对话 + 桌面端同步 */
@Composable
fun NewmarkApp(
    initialPairUrl: String? = null,
    runtimeStressScenario: String? = null,
    incomingShare: IncomingShare? = null,
    onIncomingShareConsumed: (Long) -> Unit = {},
    onInteractiveReady: () -> Unit = {},
) {
    val context = LocalContext.current
    val themeStore = remember { ThemeStore(context) }
    // SharedPreferences is tiny, but avoid adding synchronous storage work to
    // the first composition.  The system theme is an acceptable first-frame
    // fallback and the persisted preference replaces it immediately after.
    var darkMode by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(themeStore) {
        darkMode = themeStore.loadDarkMode()
    }
    val dark = darkMode ?: isSystemInDarkTheme()
    CompositionLocalProvider(
        LocalThemeMode provides ThemeMode(darkMode) { new ->
            darkMode = new
            themeStore.saveDarkMode(new)
        },
    ) {
        NewmarkTheme(darkTheme = dark) {
            NewmarkAppContent(
                initialPairUrl = initialPairUrl,
                runtimeStressScenario = runtimeStressScenario,
                incomingShare = incomingShare,
                onIncomingShareConsumed = onIncomingShareConsumed,
                onInteractiveReady = onInteractiveReady,
            )
        }
    }
}

@Composable
private fun NewmarkAppContent(
    initialPairUrl: String?,
    runtimeStressScenario: String?,
    incomingShare: IncomingShare?,
    onIncomingShareConsumed: (Long) -> Unit,
    onInteractiveReady: () -> Unit,
) {
    val p = LocalNewmarkColors.current
    val context = LocalContext.current
    val rootView = LocalView.current
    val vm: ChatViewModel = viewModel()
    val linkVm: DesktopLinkViewModel = viewModel()
    var pendingCalendarPermission by remember { mutableStateOf<CompletableDeferred<Boolean>?>(null) }
    val calendarPermissionMutex = remember { Mutex() }
    val calendarPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val pending = pendingCalendarPermission
        pendingCalendarPermission = null
        pending?.complete(granted)
    }
    DisposableEffect(vm, context) {
        val handler: suspend (String, org.json.JSONObject) -> com.newmark.mobile.data.ToolResult = { name, args ->
            calendarPermissionMutex.withLock {
                val permission = when (name) {
                    "calendar_read" -> Manifest.permission.READ_CALENDAR
                    "calendar_create" -> Manifest.permission.WRITE_CALENDAR
                    else -> return@withLock com.newmark.mobile.data.ToolResult.err("未知日历工具：$name")
                }
                val alreadyGranted = ContextCompat.checkSelfPermission(
                    context,
                    permission,
                ) == PackageManager.PERMISSION_GRANTED
                val granted = if (alreadyGranted) {
                    true
                } else {
                    val pending = CompletableDeferred<Boolean>()
                    pendingCalendarPermission = pending
                    calendarPermissionLauncher.launch(permission)
                    pending.await()
                }
                if (!granted) {
                    return@withLock com.newmark.mobile.data.ToolResult.err(
                        "用户拒绝了${if (name == "calendar_read") "日历读取" else "日历写入"}权限，未执行工具",
                    )
                }
                if (name == "calendar_read") CalendarTool.read(context, args) else CalendarTool.launch(context, args)
            }
        }
        vm.bindLocalCalendarTool(handler)
        onDispose {
            vm.unbindLocalCalendarTool(handler)
            pendingCalendarPermission?.complete(false)
            pendingCalendarPermission = null
        }
    }
    DisposableEffect(vm, context) {
        val handler: suspend (org.json.JSONObject) -> com.newmark.mobile.data.ToolResult = { args ->
            AlarmTool.manage(context, args)
        }
        vm.bindLocalAlarmTool(handler)
        onDispose { vm.unbindLocalAlarmTool(handler) }
    }
    val keepScreenOn = vm.hasRunningLocalAgents
    DisposableEffect(rootView, keepScreenOn) {
        if (keepScreenOn) rootView.keepScreenOn = true
        onDispose { if (keepScreenOn) rootView.keepScreenOn = false }
    }

    LaunchedEffect(runtimeStressScenario) {
        if (runtimeStressScenario != "local_queue_guide") return@LaunchedEffect
        while (vm.providers.isEmpty()) delay(50)
        vm.newConversation()
        vm.send("QUEUE_STRESS_DIAGNOSTIC")
        while (!vm.isSending) delay(20)
        vm.enqueueLocal("guide_runtime_candidate")
        vm.enqueueLocal("next_runtime_original")
        vm.enqueueLocal("next_runtime_delete")
        while (vm.currentQueue.size < 3) delay(20)
        val queued = vm.currentQueue.toList()
        vm.toggleLocalQueuePause()
        vm.updateLocalQueueMessage(queued[1].id, "next_runtime_edited")
        vm.deleteLocalQueueMessage(queued[2].id)
        vm.guideLocalQueueMessage(queued[0].id)
        vm.toggleLocalQueuePause()
    }

    LaunchedEffect(Unit) {
        // This effect can run only after the complete root composition has
        // been applied. One additional frame proves the real input surface is
        // drawn; no launch placeholder or missing-feature shell is counted.
        awaitFrame()
        onInteractiveReady()
    }

    // Let Compose produce the chat shell first.  Remote hydration can involve
    // network timeouts and a large desktop snapshot, neither of which should
    // contend with first-frame composition.
    LaunchedEffect(linkVm) {
        awaitFrame()
        linkVm.initialize()
    }

    // 深链 / 扫码触发配对（newmark-pair://...）
    LaunchedEffect(initialPairUrl) {
        if (!initialPairUrl.isNullOrBlank()) {
            linkVm.pairFromUrl(initialPairUrl)
        }
    }

    val config = LocalConfiguration.current
    val isCompact = config.screenWidthDp < 600

    var screen by remember { mutableStateOf(Screen.Main) }
    var sidebarPage by remember { mutableStateOf<SidebarPage>(SidebarPage.Main) }
    var retainedSecondaryWorkspace by remember { mutableStateOf<WorkspaceInfo?>(null) }
    var expandedDevice by remember { mutableStateOf<Device?>(null) }
    var rail by remember { mutableStateOf(false) }
    var rightSidebarExpanded by remember { mutableStateOf(false) }
    var rightSidebarDragProgress by remember { mutableFloatStateOf(0f) }
    var isRightSidebarDragging by remember { mutableStateOf(false) }
    var leftSidebarDragProgress by remember { mutableFloatStateOf(0f) }
    var isLeftSidebarDragging by remember { mutableStateOf(false) }
    var rightSidebarSettleStart by remember { mutableStateOf<Float?>(null) }
    var leftSidebarSettleStart by remember { mutableStateOf<Float?>(null) }
    val rightSidebarMotion = remember { Animatable(0f) }
    val leftSidebarTarget = if (
        rail || sidebarPage is SidebarPage.WorkspaceConversations || rightSidebarExpanded
    ) 0f else 1f
    val leftSidebarMotion = remember { Animatable(leftSidebarTarget) }
    LaunchedEffect(rightSidebarExpanded, isRightSidebarDragging) {
        if (!isRightSidebarDragging) {
            val settleStart = rightSidebarSettleStart
            if (settleStart != null) {
                rightSidebarMotion.snapTo(settleStart)
                rightSidebarSettleStart = null
            }
            rightSidebarMotion.animateTo(
                targetValue = if (rightSidebarExpanded) 1f else 0f,
                animationSpec = tween(durationMillis = 250, easing = SidebarEaseInOut),
            )
        }
    }
    LaunchedEffect(leftSidebarTarget, isLeftSidebarDragging) {
        if (!isLeftSidebarDragging) {
            val settleStart = leftSidebarSettleStart
            if (settleStart != null) {
                leftSidebarMotion.snapTo(settleStart)
                leftSidebarSettleStart = null
            }
            leftSidebarMotion.animateTo(
                targetValue = leftSidebarTarget,
                animationSpec = tween(durationMillis = 320, easing = SidebarEaseInOut),
            )
        }
    }
    // Drag frames and release settling share the same Animatable. snapTo keeps
    // its internal value at the finger position, so animateTo can only cover
    // the remaining distance instead of replaying from the old endpoint.
    var rightSidebarTab by remember { mutableStateOf(RightSidebarTab.Files) }
    val browserSessions = remember { BrowserSessionRegistry() }
    val backgroundBrowserHosts = remember {
        mutableMapOf<String, BackgroundBrowserHost>()
    }
    var compactSubagent by remember { mutableStateOf<RemoteSubagent?>(null) }
    var retainedCompactSubagent by remember { mutableStateOf<RemoteSubagent?>(null) }
    LaunchedEffect(compactSubagent) {
        compactSubagent?.let { retainedCompactSubagent = it }
    }
    val compactSubagentVisibility = remember { MutableTransitionState(false) }
    val settingsVisibility = remember { MutableTransitionState(false) }
    val terminalVisibility = remember { MutableTransitionState(false) }
    val memoryLabVisibility = remember { MutableTransitionState(false) }
    SideEffect {
        compactSubagentVisibility.targetState = isCompact && compactSubagent != null
        settingsVisibility.targetState = screen == Screen.Settings
        terminalVisibility.targetState = screen == Screen.Terminal
        memoryLabVisibility.targetState = screen == Screen.MemoryLab
    }
    val independentPageTransitionRunning = !compactSubagentVisibility.isIdle ||
        !settingsVisibility.isIdle || !terminalVisibility.isIdle || !memoryLabVisibility.isIdle
    val highFrameRateActive = isRightSidebarDragging || isLeftSidebarDragging ||
        rightSidebarMotion.isRunning || leftSidebarMotion.isRunning || independentPageTransitionRunning
    DisposableEffect(rootView, highFrameRateActive) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            rootView.requestedFrameRate = if (highFrameRateActive) {
                View.REQUESTED_FRAME_RATE_CATEGORY_HIGH
            } else {
                View.REQUESTED_FRAME_RATE_CATEGORY_DEFAULT
            }
        }
        onDispose {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM && highFrameRateActive) {
                rootView.requestedFrameRate = View.REQUESTED_FRAME_RATE_CATEGORY_DEFAULT
            }
        }
    }

    val mainDrawerWidth = minOf(
        360.dp,
        (config.screenWidthDp - 56).coerceAtLeast(220).dp,
    )
    val drawerWidth by animateDpAsState(
        targetValue = if (sidebarPage is SidebarPage.WorkspaceConversations) 220.dp else mainDrawerWidth,
        animationSpec = tween(durationMillis = 400, easing = PcEaseOutExpo),
        label = "drawerWidth",
    )

    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val drawerWidthPx = with(LocalDensity.current) { drawerWidth.toPx() }
    val compactLeftSidebarProgress by remember(drawerState, drawerWidthPx) {
        derivedStateOf {
            val offset = drawerState.currentOffset
            if (offset.isFinite() && drawerWidthPx > 0f) {
                (1f + offset / drawerWidthPx).coerceIn(0f, 1f)
            } else if (drawerState.isOpen) {
                1f
            } else {
                0f
            }
        }
    }
    // Pair ownership, rather than transient connectivity, keeps the remote
    // transcript mounted while Connecting/Reconnecting/Disconnected changes.
    var preferLocal by remember { mutableStateOf(true) }
    val useRemote = shouldPresentRemoteConversation(preferLocal, linkVm.pairInfo != null)
    val browserTargetKey = if (useRemote) {
        "remote:${linkVm.selectedConversationWorkspaceId.orEmpty()}:${linkVm.selectedConversationId.orEmpty()}"
    } else {
        "local:${vm.currentId.orEmpty()}"
    }
    val browserSession = browserSessions.visibleSession(browserTargetKey)
    val localBrowserConversationId = vm.currentId.orEmpty()
    DisposableEffect(useRemote, localBrowserConversationId, browserTargetKey, browserSession, vm, context) {
        if (useRemote || localBrowserConversationId.isBlank()) return@DisposableEffect onDispose { }
        val handler: suspend (org.json.JSONObject) -> com.newmark.mobile.data.ToolResult = handler@{ args ->
            val visible = when {
                !args.has("visible") -> true
                args.opt("visible") is Boolean -> args.getBoolean("visible")
                else -> return@handler com.newmark.mobile.data.ToolResult.err("browser_use.visible 必须是 boolean")
            }
            if (visible) {
                // Default/true keeps the historical conversation-scoped right
                // sidebar session. Visibility is presentation state only; the
                // tool never expands the sidebar or switches its tab.
                browserSession.executeTool(args)
            } else {
                // The false lane owns a separate unattached WebView. It never
                // resolves the right-sidebar session and never enters Compose.
                val host = backgroundBrowserHosts[browserTargetKey]
                    ?: withContext(Dispatchers.Main.immediate) {
                        backgroundBrowserHosts.getOrPut(browserTargetKey) {
                            BackgroundBrowserHost(
                                context = context.applicationContext,
                                session = browserSessions.backgroundSession(browserTargetKey),
                                correctOcr = vm::correctFinalVisualOcr,
                            )
                        }
                    }
                host.execute(args)
            }
        }
        vm.bindLocalBrowserTools(localBrowserConversationId, handler)
        onDispose { vm.unbindLocalBrowserTools(localBrowserConversationId, handler) }
    }
    DisposableEffect(backgroundBrowserHosts) {
        onDispose {
            backgroundBrowserHosts.forEach { (targetKey, host) ->
                host.close()
                browserSessions.releaseBackgroundSession(targetKey)
            }
            backgroundBrowserHosts.clear()
        }
    }
    LaunchedEffect(backgroundBrowserHosts, browserTargetKey) {
        val staleTargets = backgroundBrowserHosts.keys.filter { it != browserTargetKey }
        staleTargets.forEach { targetKey ->
            backgroundBrowserHosts.remove(targetKey)?.close()
            browserSessions.releaseBackgroundSession(targetKey)
        }
    }
    val selectedRightSidebarTab = when {
        useRemote -> rightSidebarTab
        rightSidebarTab in listOf(RightSidebarTab.Plan, RightSidebarTab.Browser, RightSidebarTab.Uploads) -> rightSidebarTab
        else -> RightSidebarTab.Plan
    }
    val displayItems = rememberConversationItems(useRemote = useRemote, linkVm = linkVm, vm = vm)
    val remoteUi = linkVm.conversationUiState
    val remoteRunning = remoteUi.runtime?.running == true || remoteUi.runtime?.stopRequested == true || remoteUi.flow?.running == true
    val sending = if (useRemote) linkVm.isSending || remoteRunning else vm.isSending
    // 标题始终显示当前对话标题（本地 or 远程），连接状态在侧边栏设备旁展示
    val title = if (useRemote) {
        linkVm.selectedConversationTitle?.takeIf { it.isNotBlank() }
            ?: linkVm.desktopState?.let { st ->
                st.conversations.find { it.id == st.activeConversationId }?.title
            }?.takeIf { it.isNotBlank() }
            ?: "Newmark"
    } else {
        vm.current?.title ?: "Newmark"
    }
    // 远程菜单使用远端桌面配置的脱敏 provider/model 清单，不混入移动端本地配置。
    val modelOptions = if (useRemote) linkVm.remoteModelOptions() else vm.enabledModelOptions()
    // 模型显示名对齐 PC modelLabel（`provider / model`）；判定用原始模型名单独传。
    // 桌面端回退模型优先显示：回退不是隐藏参数回退，选择区必须同步实际生效模型。
    val selectedModelName = if (useRemote) {
        linkVm.fallbackModel.ifBlank { linkVm.desktopState?.model ?: "" }
    } else vm.apiConfig.model
    val selectedModel = if (useRemote) {
        val fallback = linkVm.fallbackModel
        if (fallback.isNotBlank()) {
            val option = modelOptions.firstOrNull { it.modelName == fallback }
            if (option != null) {
                option.providerLabel.takeIf(String::isNotBlank)
                    ?.let { "$it / ${option.label.ifBlank { option.modelName }}" }
                    ?: option.label.ifBlank { option.modelName }
            } else {
                fallback
            }
        } else {
            val st = linkVm.desktopState
            st?.modelLabel?.takeIf { it.isNotBlank() } ?: st?.model ?: ""
        }
    } else {
        val providerLabel = vm.activeProvider?.label?.takeIf { it.isNotBlank() }
        if (providerLabel != null) "$providerLabel / $selectedModelName" else selectedModelName
    }
    val selectedProviderId = if (useRemote) {
        modelOptions.firstOrNull { it.modelName == selectedModelName }?.providerId.orEmpty()
    } else {
        vm.activeProviderId
    }
    val intelligence = if (useRemote) (linkVm.desktopState?.intelligence ?: "medium") else vm.intelligence
    val selectedMode = if (useRemote) {
        linkVm.desktopState?.mode.orEmpty().ifBlank { "build" }.replaceFirstChar(Char::titlecase)
    } else vm.currentMode.replaceFirstChar(Char::titlecase)
    // 强制停止态（octagon-x）：仅远程，PC 端 runtime.status 为 stopping / force_restarting
    val escalating = useRemote && linkVm.desktopState?.status in setOf("stopping", "force_restarting")
    val conversationActions = if (useRemote) ConversationUiActions(
        send = linkVm::sendToDesktop,
        sendImages = { text, _ -> linkVm.sendToDesktop(text) },
        guide = { text ->
            linkVm.guideRemoteConversation(text)
            true
        },
        stop = { if (remoteUi.flow?.running == true) linkVm.pauseRemoteFlow() else linkVm.stopRemoteConversation() },
        selectModel = linkVm::selectRemoteModel,
        selectIntelligence = linkVm::selectRemoteIntelligence,
        selectMode = {},
        editGoal = linkVm::submitRemoteGoalEdit,
        toggleGoalPause = linkVm::toggleRemoteGoalPause,
        deleteGoal = linkVm::clearRemoteGoal,
        toggleFlow = { if (remoteUi.flow?.paused == true) linkVm.resumeRemoteFlow() else linkVm.pauseRemoteFlow() },
        toggleQueuePause = linkVm::toggleRemoteQueuePause,
        updateQueueItem = linkVm::updateRemoteQueueMessage,
        deleteQueueItem = linkVm::deleteRemoteQueueMessage,
        reorderQueueItems = linkVm::reorderRemoteQueueMessages,
        guideQueueItem = linkVm::guideRemoteQueueMessage,
        inspectBranch = linkVm::inspectRemoteBranch,
        editUserMessage = linkVm::branchRemoteMessage,
    ) else ConversationUiActions(
        send = { text -> if (vm.isSending) vm.enqueueLocal(text) else vm.send(text) },
        sendImages = { text, images -> if (!vm.isSending) vm.sendWithImages(text, images) else vm.enqueueLocal(text) },
        guide = vm::guideLocalConversation,
        stop = vm::stop,
        selectModel = { vm.selectModel(it.providerId, it.modelName) },
        selectIntelligence = vm::selectIntelligence,
        selectMode = vm::selectMode,
        editGoal = {},
        toggleGoalPause = {},
        deleteGoal = {},
        toggleFlow = {},
        toggleQueuePause = vm::toggleLocalQueuePause,
        updateQueueItem = vm::updateLocalQueueMessage,
        deleteQueueItem = vm::deleteLocalQueueMessage,
        reorderQueueItems = vm::reorderLocalQueueMessages,
        guideQueueItem = vm::guideLocalQueueMessage,
        inspectBranch = vm::inspectBranch,
        editUserMessage = vm::branchFromUserMessage,
    )
    val queueItems = if (useRemote) {
        linkVm.editableRemoteQueue.takeIf { it.isNotEmpty() }
            ?.map { QueueMessageUi(it.id, it.text, true, it.requestedMode, it.goalObjective) }
            ?: remoteUi.queued.followUp.mapIndexed { index, text -> QueueMessageUi("legacy:$index:$text", text, false) }
    } else vm.currentQueue.map { QueueMessageUi(it.id, it.text, true, it.requestedMode, it.goalObjective) }
    val queuePaused = if (useRemote) linkVm.remoteQueuePaused else vm.currentQueuePaused

    LaunchedEffect(incomingShare?.id) {
        val share = incomingShare ?: return@LaunchedEffect
        try {
            val target = IncomingShareRouter.target(share.coldStart, useRemote)
            if (target == IncomingShareTarget.NewLocalConversation) {
                preferLocal = true
                sidebarPage = SidebarPage.Main
                vm.newConversation()
            }
            fun sendLocal(text: String) {
                if (text.isBlank()) return
                if (vm.isSending) vm.enqueueLocal(text) else vm.send(text)
            }
            if (share.text.isNotBlank()) {
                if (target == IncomingShareTarget.ActiveRemoteConversation) linkVm.sendToDesktop(share.text)
                else sendLocal(share.text)
            }
            for (rawUri in share.contentUris) {
                val incoming = readIncomingContent(context, Uri.parse(rawUri), share.mimeType).getOrThrow()
                if (target == IncomingShareTarget.ActiveRemoteConversation) {
                    linkVm.bindSelectedWorkspaceUpload()(incoming.name, incoming.mimeType, incoming.bytes).getOrThrow()
                } else {
                    val location = vm.importLocalFile(incoming.name, incoming.bytes).getOrThrow()
                    sendLocal("有文件已导入到 $location")
                }
            }
            Toast.makeText(context, "已发送到 ${if (target == IncomingShareTarget.ActiveRemoteConversation) "远程" else "本地"}对话", Toast.LENGTH_SHORT).show()
        } catch (error: Throwable) {
            Toast.makeText(context, "接收分享失败：${error.message ?: error}", Toast.LENGTH_LONG).show()
        } finally {
            onIncomingShareConsumed(share.id)
        }
    }
    LaunchedEffect(useRemote, linkVm.selectedConversationWorkspaceId, linkVm.selectedConversationId, linkVm.linkStatus) {
        while (useRemote && linkVm.linkStatus == LinkStatus.Connected &&
            !linkVm.selectedConversationWorkspaceId.isNullOrBlank() && !linkVm.selectedConversationId.isNullOrBlank()
        ) {
            linkVm.refreshConversationUiState()
            delay(1000)
        }
    }
    val onOpenWebLink: (String) -> Unit = { url ->
        if (browserSession.navigate(url)) {
            context.getSystemService(android.content.ClipboardManager::class.java)
                ?.setPrimaryClip(ClipData.newPlainText("Newmark 网页链接", browserSession.address))
            rightSidebarTab = RightSidebarTab.Browser
            rightSidebarExpanded = true
            Toast.makeText(context, "链接已复制并在内置浏览器打开", Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(context, "无效网页链接", Toast.LENGTH_SHORT).show()
        }
    }

    val onNewConversation: () -> Unit = {
        preferLocal = true
        sidebarPage = SidebarPage.Main
        vm.newConversation()
    }
    val onOpenSettings: () -> Unit = { screen = Screen.Settings }
    val onOpenMemoryLab: () -> Unit = { screen = Screen.MemoryLab }
    val onOpenTerminal: () -> Unit = { screen = Screen.Terminal }
    val onBackSidebar: () -> Unit = { sidebarPage = SidebarPage.Main }
    val onToggleDevice: (Device) -> Unit = {
        expandedDevice = if (expandedDevice == it) null else it
    }

    val onNewRemoteConversation: () -> Unit = {
        preferLocal = false
        linkVm.createWorkspaceConversation { ok, message ->
            Toast.makeText(context, if (ok) "已新建：$message" else message, Toast.LENGTH_SHORT).show()
        }
    }

    // 远程对话菜单回调（二级边栏按已打开 workspaceId 精确路由）
    val onRenameRemoteCallback: (RemoteConversation, String) -> Unit = { conversation, title ->
        linkVm.renameWorkspaceConversation(conversation, title) { ok, message ->
            Toast.makeText(context, if (ok) "已重命名：$message" else message, Toast.LENGTH_SHORT).show()
        }
    }
    val onArchiveRemoteCallback: (RemoteConversation) -> Unit = { conv ->
        linkVm.archiveRemote(conv) { ok, msg ->
            Toast.makeText(
                context,
                if (ok) "已归档：$msg" else msg,
                Toast.LENGTH_SHORT,
            ).show()
        }
    }
    val onTogglePinRemoteCallback: (RemoteConversation) -> Unit = { conversation ->
        linkVm.toggleWorkspaceConversationPin(conversation) { _, message ->
            Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
        }
    }
    val onReorderRemoteCallback: (List<String>) -> Unit = { conversationIds ->
        linkVm.reorderWorkspaceConversations(conversationIds) { ok, message ->
            if (!ok) Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
        }
    }

    val conversationSurface = ConversationSurface(
        title = title,
        items = displayItems,
        isSending = sending,
        remoteMode = useRemote,
        modelOptions = modelOptions,
        selectedModel = selectedModel,
        selectedProviderId = selectedProviderId,
        selectedModelName = selectedModelName,
        intelligence = intelligence,
        selectedMode = selectedMode,
        actions = conversationActions,
        escalating = escalating,
        showConnectRemote = linkVm.pairInfo != null &&
            (preferLocal || linkVm.linkStatus == LinkStatus.Disconnected),
        onConnectRemote = {
            preferLocal = false
            if (linkVm.linkStatus == LinkStatus.Disconnected) linkVm.retryConnect()
        },
        goal = if (useRemote) remoteUi.goal else null,
        flow = if (useRemote) remoteUi.flow else null,
        queueItems = queueItems,
        queuePaused = queuePaused,
        onNewChat = onNewConversation,
        onOpenWebLink = onOpenWebLink,
        onBeginFileUpload = if (useRemote) {
            { linkVm.bindSelectedWorkspaceUpload() }
        } else {
            { { name, _, bytes -> vm.importLocalFile(name, bytes) } }
        },
        uploadInjectsGuide = useRemote,
    )

    val sidebar: @Composable (SidebarPage, Boolean) -> Unit = { pageArg, railArg ->
        SidebarContent(
            rail = railArg,
            page = pageArg,
            expandedDevice = expandedDevice,
            conversations = vm.conversations,
            // 并集互斥选中：远程模式下本地对话不显示选中态，反之亦然
            currentConversationId = if (useRemote) null else vm.currentId,
            onToggleDevice = onToggleDevice,
            onBack = onBackSidebar,
            onOpenSettings = onOpenSettings,
            onOpenMemoryLab = onOpenMemoryLab,
            onOpenTerminal = onOpenTerminal,
            onNewConversation = onNewConversation,
            onNewRemoteConversation = onNewRemoteConversation,
            onSelectConversation = {
                vm.selectConversation(it)
                preferLocal = true
                sidebarPage = SidebarPage.Main
                // 竖屏：选中即关抽屉回到对话区
                if (isCompact) scope.launch { drawerState.close() }
            },
            // Expanded/foldable layouts use the same swipe-only rail
            // interaction as portrait; no visible expand/collapse button.
            onToggleRail = null,
            pairedDevices = linkVm.pairedDevices,
            activeHost = linkVm.activeDevice?.host,
            linkStatus = linkVm.linkStatus,
            onSelectDevice = { linkVm.selectDevice(it) },
            workspaces = linkVm.desktopState?.workspaces ?: emptyList(),
            onOpenWorkspace = { ws ->
                retainedSecondaryWorkspace = ws
                sidebarPage = SidebarPage.WorkspaceConversations(ws)
                if (!isCompact) rail = true
                linkVm.openWorkspace(ws)
            },
            workspaceConversations = linkVm.workspaceConversations,
            remoteConversations = linkVm.remoteConversations,
            activeConversationId = linkVm.openedWorkspaceActiveConversationId,
            onSelectRemoteConversation = {
                linkVm.selectConversation(it, linkVm.openedWorkspaceId)
                // 选择远程对话即进入远程模式（本地模式下点击也不会被本地内容遮住）
                preferLocal = false
                // PC/宽屏保持二级栏常驻；仅竖屏返回对话区并关闭抽屉。
                if (isCompact) {
                    sidebarPage = SidebarPage.Main
                    scope.launch { drawerState.close() }
                }
            },
            onRenameLocal = { id, title -> vm.renameConversation(id, title) },
            onArchiveLocal = { id -> vm.archiveConversation(id) },
            onTogglePinLocal = { id -> vm.togglePin(id) },
            onReorderLocal = vm::reorderConversations,
            onRenameRemote = onRenameRemoteCallback,
            onArchiveRemote = onArchiveRemoteCallback,
            onTogglePinRemote = onTogglePinRemoteCallback,
            onReorderRemote = onReorderRemoteCallback,
            archivePendingIds = linkVm.workspaceArchivePendingIds,
            swapPages = isCompact,
        )
    }

    // 系统返回优先收起当前最靠前的移动层；没有边栏/弹窗时才交给桌面返回。
    val hasMainOverlay = compactSubagent != null || rightSidebarExpanded ||
        (isCompact && drawerState.isOpen) || (!isCompact && sidebarPage is SidebarPage.WorkspaceConversations) ||
        expandedDevice != null
    BackHandler(enabled = screen == Screen.Main && hasMainOverlay) {
        when {
            compactSubagent != null -> compactSubagent = null
            rightSidebarExpanded -> rightSidebarExpanded = false
            isCompact && drawerState.isOpen -> scope.launch { drawerState.close() }
            !isCompact && sidebarPage is SidebarPage.WorkspaceConversations -> sidebarPage = SidebarPage.Main
            expandedDevice != null -> expandedDevice = null
            else -> { /* no mobile layer; host activity handles the back */ }
        }
    }
    val sidebarGestureLocks = remember { mutableStateMapOf<String, Boolean>() }
    val sidebarGesturesLocked = sidebarGestureLocks.values.any { it }
    val setSidebarGestureLock: (String, Boolean) -> Unit = remember(sidebarGestureLocks) {
        { token, locked ->
            if (locked) sidebarGestureLocks[token] = true else sidebarGestureLocks.remove(token)
        }
    }
    fun sidebarGestureModifier(): Modifier = Modifier.pointerInput(isCompact, rightSidebarExpanded, sidebarPage, rail) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            if (sidebarGestureLocks.isNotEmpty()) return@awaitEachGesture
            var horizontalDrag = 0f
            var verticalDrag = 0f
            var canceledByControl = false
            val openThresholdPx = 56.dp.toPx()
            val rightHalf = size.width / 2f
            val controlsRight = isCompact || down.position.x >= rightHalf
            isRightSidebarDragging = false
            do {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                if (sidebarGestureLocks.isNotEmpty()) {
                    canceledByControl = true
                    break
                }
                horizontalDrag += change.position.x - change.previousPosition.x
                verticalDrag += change.position.y - change.previousPosition.y
                if (kotlin.math.abs(horizontalDrag) > kotlin.math.abs(verticalDrag)) {
                    val closesCompactLeft = isCompact && drawerState.isOpen && horizontalDrag < 0f
                    val opensCompactLeft = isCompact && drawerState.isClosed && !rightSidebarExpanded && horizontalDrag > 0f
                    val controlsRightGesture = when {
                        closesCompactLeft || opensCompactLeft -> false
                        isCompact -> horizontalDrag < 0f || rightSidebarExpanded
                        else -> controlsRight
                    }
                    if (controlsRight && !closesCompactLeft && horizontalDrag < 0f && !rightSidebarExpanded) {
                        isRightSidebarDragging = true
                        rightSidebarDragProgress = ((-horizontalDrag) / (168.dp.toPx())).coerceIn(0f, 1f)
                    } else if (controlsRight && rightSidebarExpanded && horizontalDrag > 0f) {
                        isRightSidebarDragging = true
                        rightSidebarDragProgress = (1f - (horizontalDrag / (168.dp.toPx()))).coerceIn(0f, 1f)
                    } else if (!isCompact && !controlsRight) {
                        // Expanded/foldable left rail follows the finger. The
                        // committed rail flag changes only after release.
                        val opening = rail && horizontalDrag > 0f
                        val closing = !rail && horizontalDrag < 0f
                        if (opening || closing) {
                            isLeftSidebarDragging = true
                            leftSidebarDragProgress = if (opening) {
                                (horizontalDrag / 172.dp.toPx()).coerceIn(0f, 1f)
                            } else {
                                (1f + horizontalDrag / 172.dp.toPx()).coerceIn(0f, 1f)
                            }
                        }
                    }
                    // Compact right-swipes belong to Material3's left drawer so its
                    // position and the window blur remain finger-synchronous.
                    if (controlsRightGesture) change.consume()
                }
            } while (event.changes.any { it.pressed })
            if (!canceledByControl && kotlin.math.abs(horizontalDrag) > kotlin.math.abs(verticalDrag) && kotlin.math.abs(horizontalDrag) > openThresholdPx) {
                if (isCompact && drawerState.isOpen && horizontalDrag < 0f) {
                    scope.launch { drawerState.close() }
                } else if (isCompact && drawerState.isClosed && !rightSidebarExpanded && horizontalDrag > 0f) {
                    scope.launch { drawerState.open() }
                } else if (controlsRight) {
                    if (rightSidebarExpanded && horizontalDrag > 0f) rightSidebarExpanded = false
                    else if (!rightSidebarExpanded && horizontalDrag < 0f) rightSidebarExpanded = true
                } else if (!isCompact) {
                    // 平板/折叠屏左半区只控制左栏，绝不影响右栏。
                    if (horizontalDrag < 0f) {
                        if (sidebarPage is SidebarPage.WorkspaceConversations) sidebarPage = SidebarPage.Main
                        else rail = true
                    } else {
                        rail = false
                    }
                }
            }
            if (isRightSidebarDragging) rightSidebarSettleStart = rightSidebarDragProgress
            if (isLeftSidebarDragging) leftSidebarSettleStart = leftSidebarDragProgress
            isRightSidebarDragging = false
            isLeftSidebarDragging = false
        }
    }

    // Shared Liquid Glass backdrop. Each layout attaches the recorder only to
    // its background content; glass consumers must remain sibling overlays so
    // the recorded GraphicsLayer can never contain a reference to itself.
    val liquidBackdrop = rememberLiquidBackdrop()
    CompositionLocalProvider(
        LocalLiquidBackdrop provides liquidBackdrop,
        LocalSidebarGestureLock provides setSidebarGestureLock,
    ) {
    Box(Modifier.fillMaxSize()) {
    SidebarFrameProgressHost(
        rightDragging = isRightSidebarDragging,
        rightDragProgress = rightSidebarDragProgress,
        rightSettleStart = rightSidebarSettleStart,
        rightMotion = rightSidebarMotion,
        leftDragging = isLeftSidebarDragging,
        leftDragProgress = leftSidebarDragProgress,
        leftSettleStart = leftSidebarSettleStart,
        leftMotion = leftSidebarMotion,
    ) { leftSidebarProgress, rightSidebarProgress ->
    when {
        isCompact -> {
            CompactMainLayout(
                drawerState = drawerState,
                drawerWidth = drawerWidth,
                secondaryDrawer = sidebarPage is SidebarPage.WorkspaceConversations,
                sidebar = { sidebar(sidebarPage, sidebarRailForLayout(isCompact = true, expandedLayoutRail = rail)) },
                gestureModifier = sidebarGestureModifier(),
                // Candidate locks arbitrate the app-wide edge recognizer, but
                // must not toggle MaterialDrawer's state machine mid-frame;
                // doing so removes its normal button-open/button-close settle.
                gesturesEnabled = true,
                liquidBackdrop = liquidBackdrop,
                surface = conversationSurface,
                leftProgress = compactLeftSidebarProgress,
                rightProgress = rightSidebarProgress,
                rightExpanded = rightSidebarExpanded,
                screenWidthDp = config.screenWidthDp,
                linkVm = linkVm,
                localVm = vm,
                browserSession = browserSession,
                selectedTab = selectedRightSidebarTab,
                onMenuClick = { scope.launch { drawerState.open() } },
                onOpenSubagentPage = { compactSubagent = it },
                onRightExpandedChange = { rightSidebarExpanded = it },
                onSelectRightTab = { rightSidebarTab = it },
            )
        }

        else -> {
            ExpandedMainLayout(
                page = sidebarPage,
                leftProgress = leftSidebarProgress,
                rightExpanded = rightSidebarExpanded,
                rightProgress = rightSidebarProgress,
                screenWidthDp = config.screenWidthDp,
                retainedWorkspace = retainedSecondaryWorkspace,
                surface = conversationSurface,
                gestureModifier = sidebarGestureModifier(),
                liquidBackdrop = liquidBackdrop,
                primarySidebar = { page, railMode ->
                    sidebar(page, sidebarRailForLayout(isCompact = false, expandedLayoutRail = railMode))
                },
                linkVm = linkVm,
                localVm = vm,
                browserSession = browserSession,
                selectedTab = selectedRightSidebarTab,
                onBackSidebar = onBackSidebar,
                onNewRemoteConversation = onNewRemoteConversation,
                onRenameRemote = onRenameRemoteCallback,
                onArchiveRemote = onArchiveRemoteCallback,
                onTogglePinRemote = onTogglePinRemoteCallback,
                onReorderRemote = onReorderRemoteCallback,
                onSelectRemote = { conversation, workspaceId ->
                    linkVm.selectConversation(conversation.id, workspaceId)
                    preferLocal = false
                },
                onRightExpandedChange = { rightSidebarExpanded = it },
                onSelectRightTab = { rightSidebarTab = it },
            )
        }
    }
    }

    AnimatedVisibility(
        visibleState = compactSubagentVisibility,
        enter = slideInHorizontally(
            initialOffsetX = { it },
            animationSpec = tween(320, easing = PcEaseOutExpo),
        ) + fadeIn(tween(180)),
        exit = slideOutHorizontally(
            targetOffsetX = { it },
            animationSpec = tween(260, easing = IndependentPageExitEase),
        ) + fadeOut(tween(150)),
    ) {
        retainedCompactSubagent?.let { agent ->
            SubagentHistoryPage(agent = agent, onBack = { compactSubagent = null })
        }
    }

    AnimatedVisibility(
        visibleState = settingsVisibility,
        enter = slideInHorizontally(tween(320, easing = PcEaseOutExpo)) { it } + fadeIn(tween(180)),
        exit = slideOutHorizontally(tween(260, easing = IndependentPageExitEase)) { it } + fadeOut(tween(150)),
    ) {
        SettingsScreen(vm = vm, linkVm = linkVm, onBack = { screen = Screen.Main })
    }
    AnimatedVisibility(
        visibleState = terminalVisibility,
        enter = slideInHorizontally(tween(320, easing = PcEaseOutExpo)) { it } + fadeIn(tween(180)),
        exit = slideOutHorizontally(tween(260, easing = IndependentPageExitEase)) { it } + fadeOut(tween(150)),
    ) {
        TerminalScreen(onBack = { screen = Screen.Main })
    }
    AnimatedVisibility(
        visibleState = memoryLabVisibility,
        enter = slideInHorizontally(tween(320, easing = PcEaseOutExpo)) { it } + fadeIn(tween(180)),
        exit = slideOutHorizontally(tween(260, easing = IndependentPageExitEase)) { it } + fadeOut(tween(150)),
    ) {
        if (isCompact) MemoryLabScreen(onBack = { screen = Screen.Main })
        else MemoryLabDialog(onDismiss = { screen = Screen.Main })
    }
    }
    }
}

private data class IncomingContent(val name: String, val mimeType: String, val bytes: ByteArray)

private suspend fun readIncomingContent(
    context: android.content.Context,
    uri: Uri,
    fallbackMimeType: String,
): Result<IncomingContent> = withContext(Dispatchers.IO) {
    runCatching {
        require(uri.scheme.equals("content", ignoreCase = true)) { "只接收 content URI" }
        var name = "shared-file"
        var declaredSize = -1L
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { name = cursor.getString(it).orEmpty() }
                cursor.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !cursor.isNull(it) }?.let { declaredSize = cursor.getLong(it) }
            }
        }
        require(declaredSize <= 20L * 1024L * 1024L || declaredSize < 0L) { "文件超过 20 MiB" }
        val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
            val limit = 20 * 1024 * 1024 + 1
            val output = java.io.ByteArrayOutputStream(minOf(limit, declaredSize.coerceAtLeast(8_192L).toInt()))
            val buffer = ByteArray(32 * 1024)
            var total = 0
            while (total < limit) {
                val read = input.read(buffer, 0, minOf(buffer.size, limit - total))
                if (read < 0) break
                output.write(buffer, 0, read)
                total += read
            }
            output.toByteArray()
        } ?: error("无法读取分享内容")
        require(bytes.size <= 20 * 1024 * 1024) { "文件超过 20 MiB" }
        require(bytes.isNotEmpty()) { "文件为空" }
        IncomingContent(
            name = java.io.File(name).name.take(160).ifBlank { "shared-file" },
            mimeType = context.contentResolver.getType(uri).orEmpty().ifBlank { fallbackMimeType },
            bytes = bytes,
        )
    }
}

@Composable
private fun CompactMainLayout(
    drawerState: DrawerState,
    drawerWidth: Dp,
    secondaryDrawer: Boolean,
    sidebar: @Composable () -> Unit,
    gestureModifier: Modifier,
    gesturesEnabled: Boolean,
    liquidBackdrop: LayerBackdrop,
    surface: ConversationSurface,
    leftProgress: Float,
    rightProgress: Float,
    rightExpanded: Boolean,
    screenWidthDp: Int,
    linkVm: DesktopLinkViewModel,
    localVm: ChatViewModel,
    browserSession: BrowserSessionState,
    selectedTab: RightSidebarTab,
    onMenuClick: () -> Unit,
    onOpenSubagentPage: (RemoteSubagent) -> Unit,
    onRightExpandedChange: (Boolean) -> Unit,
    onSelectRightTab: (RightSidebarTab) -> Unit,
) {
    val palette = LocalNewmarkColors.current
    val glass = LocalGlassMode.current
    ModalNavigationDrawer(
        modifier = gestureModifier,
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(
                modifier = Modifier
                    .width(drawerWidth)
                    .liquidGlassModifier(
                        backdrop = liquidBackdrop,
                        cornerRadius = 0.dp,
                        alpha = scaledGlassAlpha(0.72f, glass.alpha),
                        blurRadius = 3.dp,
                        refractionHeight = 5.dp,
                        refractionAmount = 8.dp,
                        surfaceColor = if (secondaryDrawer) {
                            pcSecondarySurfaceColor()
                        } else {
                            palette.bgSecondary
                        },
                    ),
                drawerContainerColor = Color.Transparent,
                drawerContentColor = palette.textPrimary,
                drawerShape = RectangleShape,
                drawerTonalElevation = 0.dp,
            ) { sidebar() }
        },
        gesturesEnabled = gesturesEnabled,
        scrimColor = NewmarkScrim,
    ) {
        Box(Modifier.fillMaxSize()) {
            val blurProgress = maxOf(leftProgress, rightProgress)
            val backdropBlur = mobileBackdropBlurDp(glass.alpha)
            ConversationSurfaceContent(
                surface = surface,
                showMenuButton = true,
                onMenuClick = onMenuClick,
                modifier = (if (blurProgress > 0.001f) {
                    // Recording a long transcript is expensive even when no
                    // glass consumer is visible. Activate the recorder only
                    // while a drawer/sidebar is actually presented.
                    Modifier.layerBackdrop(liquidBackdrop)
                } else {
                    Modifier
                })
                    .then(
                        if (blurProgress > 0.001f) {
                            Modifier.blur(backdropBlur.dp * blurProgress)
                        } else {
                            Modifier
                        },
                    ),
            )
            Box(
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .graphicsLayer {
                        translationX = size.width * (1f - rightProgress)
                    },
            ) {
                MobileRightSidebar(
                    vm = linkVm,
                    localVm = localVm,
                    remoteMode = surface.remoteMode,
                    browserSession = browserSession,
                    selectedTab = selectedTab,
                    backdrop = liquidBackdrop,
                    panelWidth = minOf(360.dp, (screenWidthDp - 24).dp),
                    expanded = true,
                    onOpenSubagentPage = onOpenSubagentPage,
                    onExpandedChange = onRightExpandedChange,
                    onSelectTab = onSelectRightTab,
                )
            }
            // Compact mobile expansion is gesture-only: reveal the right
            // sidebar by swiping left from the right edge. There is no
            // persistent affordance competing with that gesture.
        }
    }
}

@Composable
private fun ExpandedMainLayout(
    page: SidebarPage,
    leftProgress: Float,
    rightExpanded: Boolean,
    rightProgress: Float,
    screenWidthDp: Int,
    retainedWorkspace: WorkspaceInfo?,
    surface: ConversationSurface,
    gestureModifier: Modifier,
    liquidBackdrop: LayerBackdrop,
    primarySidebar: @Composable (SidebarPage, Boolean) -> Unit,
    linkVm: DesktopLinkViewModel,
    localVm: ChatViewModel,
    browserSession: BrowserSessionState,
    selectedTab: RightSidebarTab,
    onBackSidebar: () -> Unit,
    onNewRemoteConversation: () -> Unit,
    onRenameRemote: (RemoteConversation, String) -> Unit,
    onArchiveRemote: (RemoteConversation) -> Unit,
    onTogglePinRemote: (RemoteConversation) -> Unit,
    onReorderRemote: (List<String>) -> Unit,
    onSelectRemote: (RemoteConversation, String) -> Unit,
    onRightExpandedChange: (Boolean) -> Unit,
    onSelectRightTab: (RightSidebarTab) -> Unit,
) {
    val palette = LocalNewmarkColors.current
    val hasSecondary = page is SidebarPage.WorkspaceConversations
    val leftReveal = leftProgress
    val secondarySlidePx = with(LocalDensity.current) { 8.dp.roundToPx() }
    // The expanded layer has a stable width per screen class. Only its
    // translation changes during the gesture; it never stretches with drag.
    val expandedSidebarWidth = if (screenWidthDp >= 840) 280.dp else 240.dp
    val expandedSidebarWidthPx = with(LocalDensity.current) { expandedSidebarWidth.toPx() }
    val panelWidth = if (screenWidthDp < 840) 280.dp else 300.dp
    // The rail is the minimum occupied boundary. Once the expanded layer's
    // actual right edge crosses it, the conversation boundary follows that
    // exact edge rather than a separate normalized animation curve.
    val leftBoundaryWidth = maxOf(48.dp, expandedSidebarWidth * leftReveal)
    Box(Modifier.fillMaxSize().then(gestureModifier)) {
        Row(Modifier.layerBackdrop(liquidBackdrop).fillMaxSize()) {
            // These slots only reserve the currently visible boundaries. The
            // actual sidebars are fixed-size overlay surfaces below and never
            // inherit a changing width from layout animation.
            Box(Modifier.width(leftBoundaryWidth).fillMaxHeight())
            AnimatedVisibility(
                visible = hasSecondary,
                enter = expandHorizontally(
                    animationSpec = tween(durationMillis = 400, easing = PcEaseOutExpo),
                    expandFrom = Alignment.Start,
                    clip = true,
                ) + slideInHorizontally(
                    animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo),
                    initialOffsetX = { -secondarySlidePx },
                ) + fadeIn(animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo)),
                exit = shrinkHorizontally(
                    animationSpec = tween(durationMillis = 400, easing = PcEaseOutExpo),
                    shrinkTowards = Alignment.Start,
                    clip = true,
                ) + slideOutHorizontally(
                    animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo),
                    targetOffsetX = { -secondarySlidePx },
                ) + fadeOut(animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo)),
            ) {
                retainedWorkspace?.let { workspace ->
                    Box(Modifier.width(220.dp).fillMaxHeight()) {
                        WorkspaceConversationsSidebar(
                            conversations = linkVm.workspaceConversations,
                            activeConversationId = linkVm.openedWorkspaceActiveConversationId,
                            onBack = onBackSidebar,
                            onSelectConversation = { conversationId ->
                                linkVm.workspaceConversations
                                    .firstOrNull { it.id == conversationId }
                                    ?.let { onSelectRemote(it, workspace.id) }
                            },
                            onNewConversation = onNewRemoteConversation,
                            onRenameConversation = onRenameRemote,
                            onArchiveConversation = onArchiveRemote,
                            onTogglePinConversation = onTogglePinRemote,
                            onReorderConversations = onReorderRemote,
                            archivePendingIds = linkVm.workspaceArchivePendingIds,
                            respectStatusBars = true,
                        )
                    }
                }
            }
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .background(palette.bgPrimary),
            ) {
                ConversationSurfaceContent(surface, showMenuButton = false, onMenuClick = {})
                // The right sidebar is gesture-only on every mobile width;
                // swipe left from the right edge to expand it.
            }
            Box(Modifier.width(panelWidth * rightProgress).fillMaxHeight())
        }

        // The 48dp rail is a stable base layer. The complete expanded sidebar
        // (surface, border and every child) is mounted once above it and moved
        // only by this outer translation, so no child can drift independently.
        Box(
            modifier = Modifier
                .align(Alignment.CenterStart)
                .width(48.dp)
                .fillMaxHeight()
                .graphicsLayer { alpha = (1f - leftReveal).coerceIn(0f, 1f) }
                .background(palette.bgSecondary)
                .statusBarsPadding(),
        ) {
            primarySidebar(if (hasSecondary) SidebarPage.Main else page, true)
        }
        Box(
            modifier = Modifier
                .align(Alignment.CenterStart)
                .width(expandedSidebarWidth)
                .fillMaxHeight()
                .graphicsLayer {
                    translationX = -expandedSidebarWidthPx * (1f - leftReveal)
                }
                .background(palette.bgSecondary)
                .statusBarsPadding()
                .zIndex(2f),
        ) {
            primarySidebar(if (hasSecondary) SidebarPage.Main else page, false)
        }

        // Right uses the identical binding model: the layout slot reserves the
        // visible boundary, while one fixed panel surface carries all content.
        Box(
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .width(panelWidth)
                .fillMaxHeight()
                .graphicsLayer {
                    translationX = size.width * (1f - rightProgress)
                }
                .zIndex(3f),
        ) {
            MobileRightSidebar(
                vm = linkVm,
                localVm = localVm,
                remoteMode = surface.remoteMode,
                browserSession = browserSession,
                selectedTab = selectedTab,
                backdrop = liquidBackdrop,
                panelWidth = panelWidth,
                expanded = true,
                onExpandedChange = onRightExpandedChange,
                onSelectTab = onSelectRightTab,
            )
        }
    }
}

@Composable
private fun ConversationSurfaceContent(
    surface: ConversationSurface,
    showMenuButton: Boolean,
    onMenuClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    ChatScreen(
        title = surface.title,
        items = surface.items,
        isSending = surface.isSending,
        showMenuButton = showMenuButton,
        remoteMode = surface.remoteMode,
        modelOptions = surface.modelOptions,
        selectedModel = surface.selectedModel,
        selectedProviderId = surface.selectedProviderId,
        selectedModelName = surface.selectedModelName,
        intelligence = surface.intelligence,
        selectedMode = surface.selectedMode,
        onSelectModel = surface.actions.selectModel,
        onSelectIntelligence = surface.actions.selectIntelligence,
        onSelectMode = surface.actions.selectMode,
        onMenuClick = onMenuClick,
        onNewChat = surface.onNewChat,
        onSend = surface.actions.send,
        onSendWithImages = surface.actions.sendImages,
        onGuide = surface.actions.guide,
        onStop = surface.actions.stop,
        escalating = surface.escalating,
        showConnectRemote = surface.showConnectRemote,
        onConnectRemote = surface.onConnectRemote,
        goal = surface.goal,
        flow = surface.flow,
        queueItems = surface.queueItems,
        queuePaused = surface.queuePaused,
        onEditGoal = surface.actions.editGoal,
        onToggleGoalPause = surface.actions.toggleGoalPause,
        onDeleteGoal = surface.actions.deleteGoal,
        onToggleFlow = surface.actions.toggleFlow,
        onToggleQueuePause = surface.actions.toggleQueuePause,
        onUpdateQueueItem = surface.actions.updateQueueItem,
        onDeleteQueueItem = surface.actions.deleteQueueItem,
        onReorderQueueItems = surface.actions.reorderQueueItems,
        onGuideQueueItem = surface.actions.guideQueueItem,
        onInspectBranch = surface.actions.inspectBranch,
        onEditUserMessage = surface.actions.editUserMessage,
        onOpenWebLink = surface.onOpenWebLink,
        onBeginFileUpload = surface.onBeginFileUpload,
        uploadInjectsGuide = surface.uploadInjectsGuide,
        modifier = modifier,
    )
}

/**
 * Projects the local or paired-desktop transcript into the shared ChatScreen
 * model. Keeping this outside the root shell reduces first-start Compose JIT
 * work without changing the rendered hierarchy or any ordering contract.
 */
@Composable
private fun rememberConversationItems(
    useRemote: Boolean,
    linkVm: DesktopLinkViewModel,
    vm: ChatViewModel,
): List<ChatItem> = remember(
    useRemote,
    linkVm.remoteMessages,
    linkVm.remoteWorkRuns,
    linkVm.remoteBranchGroups,
    linkVm.remoteWindowStart,
    linkVm.liveRun,
    linkVm.conversationUiState.runtime,
    vm.currentMessages,
    vm.currentBranchPagers,
    vm.liveRun,
    vm.liveRunConversationId,
    vm.currentId,
) {
    if (useRemote) projectRemoteConversationItems(linkVm) else projectLocalConversationItems(vm)
}

private fun projectRemoteConversationItems(linkVm: DesktopLinkViewModel): List<ChatItem> {
    // PC ordering: anchored WorkRuns stay beside their owning message. Legacy
    // unanchored runs retain authoritative ledger order rather than moving to
    // the transcript frontier after reconnect or window hydration.
    val visibleRuns = RemoteTrackingContract.visibleRuns(
        linkVm.remoteWorkRuns,
        linkVm.liveRun,
        linkVm.conversationUiState.runtime?.takeIf { it.running }?.runId.orEmpty(),
    )
    val runsByAnchor = visibleRuns.groupBy { it.anchorMessageId }
    val matchedRunIds = mutableSetOf<String>()
    val remoteRunsById = visibleRuns.associateBy { it.runId }
    val visibleRunMessages = linkVm.remoteMessages.filter {
        it.runId.isNotBlank() && it.runId in remoteRunsById &&
            it.clientMessageId.isBlank() && !isHiddenWorkflowMessage(it)
    }
    val runMessageRoles = visibleRunMessages
        .groupBy { it.runId }
        .mapValues { (_, messages) -> messages.map { it.role }.toSet() }
    val messageOwnedRunIds = runMessageRoles.keys
    val visibleMessageIds = linkVm.remoteMessages.mapNotNull { it.id.takeIf(String::isNotBlank) }.toSet()
    val items = mutableListOf<ChatItem>()
    val remotePagersByIndex = linkVm.remoteBranchGroups.mapNotNull { group ->
        val visibleMessageIndex = group.sourceMessageIndex - linkVm.remoteWindowStart
        if (group.branches.size < 2 || visibleMessageIndex !in linkVm.remoteMessages.indices) {
            return@mapNotNull null
        }
        val page = group.branches.indexOfFirst { it.id == group.activeBranchId }
            .takeIf { it >= 0 } ?: return@mapNotNull null
        visibleMessageIndex to ConversationBranchPagerUi(
            groupId = group.id,
            currentPage = page + 1,
            totalPages = group.branches.size,
            canPrevious = page > 0,
            canNext = page < group.branches.lastIndex,
        )
    }.toMap()

    linkVm.remoteMessages.forEachIndexed { index, message ->
        if (message.clientMessageId.isNotBlank() && message.runId in remoteRunsById) return@forEachIndexed
        if (isHiddenWorkflowMessage(message) ||
            (message.role == "workflow" && message.mode.startsWith("tool:"))
        ) return@forEachIndexed

        val associatedRun = remoteRunsById[message.runId]
        if (associatedRun != null) {
            RemoteTrackingContract.unownedRunsBefore(
                owningRunId = associatedRun.runId,
                runs = visibleRuns,
                messageOwnedRunIds = messageOwnedRunIds,
                visibleMessageIds = visibleMessageIds,
                alreadyRenderedRunIds = matchedRunIds,
            ).forEach { orphan ->
                matchedRunIds += orphan.runId
                items += remoteRunItems(orphan, emptySet(), keyPrefix = "run")
            }
        }
        if (associatedRun != null && message.role == "assistant" && associatedRun.runId !in matchedRunIds) {
            matchedRunIds += associatedRun.runId
            items += remoteRunItems(associatedRun, runMessageRoles[associatedRun.runId].orEmpty(), "run")
        }
        items += ChatItem.Bubble(
            role = message.role,
            content = message.content,
            mode = message.mode,
            model = message.model,
            timestamp = message.timestamp,
            keyHint = message.id.ifBlank { "m:$index" },
            messageId = message.id,
            messageIndex = index,
            attachments = message.attachments,
            branchPager = remotePagersByIndex[index],
        )
        if (associatedRun != null && message.role == "user" && associatedRun.runId !in matchedRunIds) {
            matchedRunIds += associatedRun.runId
            items += remoteRunItems(associatedRun, runMessageRoles[associatedRun.runId].orEmpty(), "run")
        }
        runsByAnchor[message.id]?.forEach { run ->
            if (run.runId !in matchedRunIds) {
                matchedRunIds += run.runId
                items += remoteRunItems(run, runMessageRoles[run.runId].orEmpty(), "run")
            }
        }
    }
    items += visibleRuns
        .filter { it.runId !in matchedRunIds }
        .flatMap { remoteRunItems(it, runMessageRoles[it.runId].orEmpty(), "run") }
    return items
}

private fun projectLocalConversationItems(vm: ChatViewModel): List<ChatItem> {
    val localPagersByMessageId = vm.currentBranchPagers.associateBy { it.sourceMessageId }
    val live = vm.liveRun?.takeIf { vm.liveRunConversationId == vm.currentId }
    val persistedRunIds = vm.currentMessages.mapNotNull { it.workRun?.runId }.toSet()
    val renderedRunIds = mutableSetOf<String>()
    return vm.currentMessages.flatMapIndexed { index, message ->
        val pager = localPagersByMessageId[message.messageId]
        val associatedRun = message.workRun
            ?: live?.takeIf { it.anchorMessageId == message.messageId && it.runId !in persistedRunIds }
        // A completed local assistant message owns the final Markdown body.
        // Keep the WorkRun as the adjacent Build activity only; rendering its
        // copied terminal text would show the same Agent reply twice.
        val renderedRun = associatedRun?.let { run ->
            if (message.role == "assistant" && message.workRun != null) run.copy(text = "") else run
        }
        val runItems = renderedRun?.let { run ->
            if (!renderedRunIds.add(run.runId)) emptyList() else listOf(
                ChatItem.Bubble(
                    role = "assistant",
                    content = "",
                    timestamp = formatLocalTime(run.startedAt),
                    workRun = run,
                    keyHint = "local-run:${run.runId}",
                ),
            )
        }.orEmpty()
        val base = ChatItem.Bubble(
            role = message.role,
            content = message.content,
            timestamp = formatLocalTime(message.timestamp),
            // Keep the activity block as a separate PC-style assistant row.
            workRun = null,
            keyHint = message.messageId.ifBlank { "l:$index:${message.timestamp}" },
            messageId = message.messageId,
            messageIndex = index,
            attachments = message.imageAttachments.map { image ->
                RemoteConversationImage(
                    id = image.id,
                    origin = "user",
                    name = image.name,
                    mimeType = image.mimeType,
                    dataUrl = image.dataUrl,
                    width = image.width,
                    height = image.height,
                )
            },
            branchPager = pager?.let {
                ConversationBranchPagerUi(
                    groupId = it.groupId,
                    currentPage = it.currentPage,
                    totalPages = it.totalPages,
                    canPrevious = it.canPrevious,
                    canNext = it.canNext,
                )
            },
        )
        if (message.role == "assistant") runItems + base else listOf(base) + runItems
    }
}

/** PC renderChatMessages 的隐藏 workflow 规则；工具内部状态不应再次进入正文历史。 */
private fun isHiddenWorkflowMessage(message: com.newmark.mobile.data.RemoteMessage): Boolean {
    if (message.role != "workflow") return false
    if (message.mode == "tool:agent_status") return true
    return Regex(
        "^(Preparing request\\.?|Response complete\\.?|Preparing model request and available tools\\.?|Executing \\d+ tool calls?\\.?|Guidance received\\.?|Next message queued\\.?|Next message recorded for the next turn\\.?|Conversation queue updated\\.?)$",
        RegexOption.IGNORE_CASE,
    ).matches(message.content.trim())
}

/** 将一个 WorkRun 放在与 PC 相同的历史位置；最终正文仅由真实 assistant 消息承载。 */
private fun remoteRunItems(
    run: RemoteWorkRun,
    messageRoles: Set<String>,
    keyPrefix: String,
): List<ChatItem> {
    val items = mutableListOf<ChatItem>()
    if ("user" !in messageRoles && run.primaryPrompt.isNotBlank()) {
        items += ChatItem.Bubble(
            role = "user",
            content = run.primaryPrompt,
            timestamp = run.startedAt,
            keyHint = "$keyPrefix:recovered-user:${run.runId}",
        )
    }
    val recoveredFinal = if ("assistant" in messageRoles) null else run.events
        .asReversed()
        .firstOrNull { it.type.equals("final_response", ignoreCase = true) && it.content.isNotBlank() }
    items += ChatItem.Bubble(
        role = "assistant",
        content = "",
        timestamp = recoveredFinal?.timestamp ?: run.startedAt,
        workRun = remoteRunToLocal(run).copy(text = recoveredFinal?.content.orEmpty()),
        keyHint = "$keyPrefix:${run.runId}",
    )
    return items
}
