package com.newmark.mobile.ui

import android.annotation.SuppressLint
import android.graphics.Color as AndroidColor
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
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
import com.newmark.mobile.ui.components.liquidGlassModifier
import com.newmark.mobile.ui.components.glassButtonSurface
import com.newmark.mobile.ui.components.liquidHoldDragGesture
import com.newmark.mobile.ui.components.DialogBackdropBlur
import com.newmark.mobile.ui.components.MobilePopupShape
import com.newmark.mobile.ui.components.MobileInteractionGlassEdge
import com.newmark.mobile.ui.components.liquidMotionDeformation
import com.newmark.mobile.ui.components.liquidSelectionMorph
import com.newmark.mobile.ui.components.runOverlappedLiquidFlight
import com.newmark.mobile.ui.components.resistedLiquidBoundaryPosition
import com.newmark.mobile.ui.components.rememberLiquidBackdrop
import com.newmark.mobile.ui.components.LocalSidebarGestureLock
import com.kyant.backdrop.backdrops.layerBackdrop
import com.newmark.mobile.vm.ChatViewModel
import com.newmark.mobile.vm.DesktopLinkViewModel
import com.newmark.mobile.vm.WorkspaceUploadProgress
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
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
    var browserPrewarmReady by remember(browserSession) { mutableStateOf(false) }

    LaunchedEffect(browserSession) {
        // Let the main conversation surface finish its first composition, then
        // create one resident WebView off-screen so opening Browser is cheap.
        delay(450)
        browserPrewarmReady = true
    }

    LaunchedEffect(remoteMode, vm.selectedConversationWorkspaceId, vm.selectedConversationId) {
        if (remoteMode && !vm.selectedConversationWorkspaceId.isNullOrBlank() && !vm.selectedConversationId.isNullOrBlank()) {
            vm.refreshRightSidebar()
        }
    }
    // Match PC #right: the conversation surface behind the panel owns the
    // backdrop blur, while the panel itself is a tinted carrier rather than a
    // full-height refractive lens. A large lens produces a mirrored vertical
    // band while the sidebar is only half revealed.
    val panelSurface = if (p == NewmarkLightThemeColors) {
        p.bgTertiary.copy(alpha = 0.98f)
    } else {
        p.bgTertiary.copy(alpha = scaledGlassAlpha(0.74f, com.newmark.mobile.ui.theme.DefaultGlassAlpha))
    }
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
                // Keep the conversation-bound WebView alive even while the
                // sidebar is folded or another right-panel tab is selected.
                // This lets browser_use navigate/extract in the background,
                // then reveal the exact same page and history when requested.
                BrowserPanel(
                    session = browserSession,
                    visible = tab == RightSidebarTab.Browser,
                    keepMounted = browserPrewarmReady,
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
            Text(task.error, color = Color(0xFFFF7777), fontSize = 9.sp, maxLines = 2,
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
private fun RightTabs(
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
    val floatWidth = 44.dp
    val trackHeight = 40.dp
    val floatHeight = 40.dp
    val density = LocalDensity.current
    val tabBackdrop = rememberLiquidBackdrop()
    val selectedIndex = tabs.indexOf(selected).coerceAtLeast(0)
    val glassX = remember { Animatable(0f) }
    val tabBounds = remember(tabs) { mutableStateMapOf<Int, Rect>() }
    var activeIndex by remember(tabs) { mutableIntStateOf(selectedIndex) }
    var visualSelectedIndex by remember(tabs) { mutableIntStateOf(selectedIndex) }
    var moving by remember { mutableStateOf(false) }
    var lifting by remember { mutableStateOf(false) }
    var landing by remember { mutableStateOf(false) }
    var draggingGlass by remember { mutableStateOf(false) }
    var draggedGlassX by remember { mutableFloatStateOf(0f) }
    var draggedGlassVelocityX by remember { mutableFloatStateOf(0f) }
    var flightJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    fun tabLeft(index: Int): Float = tabBounds[index]?.left
        ?: with(density) { index * slotWidth.toPx() }
    fun glassLeft(index: Int): Float = tabLeft(index) - with(density) { MobileInteractionGlassEdge.toPx() }
    val glassProgress by animateFloatAsState(
        targetValue = if (landing || lifting) 0f else if (moving) 1f else 0f,
        animationSpec = tween(if (landing) 240 else 100),
        label = "rightTabGlassMaterial",
    )
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
        if (!redirecting) lifting = true
        moving = true
        flightJob = scope.launch {
            draggingGlass = false
            draggedGlassVelocityX = 0f
            if (!redirecting) {
                glassX.snapTo(glassLeft(selectedIndex))
            }
            val targetX = glassLeft(index)
            val staysInPlace = kotlin.math.abs(glassX.value - targetX) < 0.5f
            runOverlappedLiquidFlight(
                lift = { kotlinx.coroutines.yield(); lifting = false; delay(100) },
                move = { if (!staysInPlace) glassX.animateTo(targetX, tween(380, easing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f))) },
                onLandingStarted = { landing = true },
                land = { delay(240) },
            )
            landing = false
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
        if (!redirecting) lifting = true
        moving = true
        flightJob = scope.launch {
            draggingGlass = false
            draggedGlassVelocityX = 0f
            if (!redirecting) glassX.snapTo(glassLeft(selectedIndex))
            runOverlappedLiquidFlight(
                holdKeepsLifted = true,
                lift = { kotlinx.coroutines.yield(); lifting = false; delay(100) },
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
                        .liquidHoldDragGesture(
                            tabs.size,
                            selectedIndex,
                            onCandidateStart = { setSidebarGestureLock("right-tab-candidate", true) },
                            onCandidateEnd = { setSidebarGestureLock("right-tab-candidate", false) },
                            onTap = { flyTo(indexAt(it.x), commit = true) },
                            onHoldStart = {
                                val index = indexAt(it.x)
                                holdAt(index)
                            },
                            onDrag = { position, delta ->
                                flightJob?.cancel()
                                moving = true
                                lifting = false
                                draggingGlass = true
                                activeIndex = indexAt(position.x)
                                draggedGlassX = with(density) {
                                    resistedLiquidBoundaryPosition(
                                        raw = position.x - floatWidth.toPx() / 2f,
                                        minimum = -6.dp.toPx(),
                                        maximum = tabs.size * slotWidth.toPx() - floatWidth.toPx() + 6.dp.toPx(),
                                        maxDisplacement = 4.dp.toPx(),
                                    )
                                }
                                draggedGlassVelocityX = delta.x * 60f
                            },
                             onHoldEnd = { _, _ ->
                                 val commit = activeIndex
                                 flightJob = scope.launch {
                                     lifting = false
                                     glassX.snapTo(draggedGlassX)
                                     draggingGlass = false
                                     runOverlappedLiquidFlight(
                                         lift = {},
                                         move = { glassX.animateTo(glassLeft(commit), tween(120, easing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f))) },
                                         onLandingStarted = { landing = true },
                                         land = { delay(240) },
                                     )
                                    landing = false
                                    moving = false
                                    draggingGlass = false
                                    draggedGlassVelocityX = 0f
                                    visualSelectedIndex = commit
                                    setSidebarGestureLock("right-tab-selector", false)
                                    onSelect(tabs[commit])
                                }
                            },
                            onCancel = {
                                moving = false
                                lifting = false
                                landing = false
                                draggingGlass = false
                                draggedGlassVelocityX = 0f
                                setSidebarGestureLock("right-tab-selector", false)
                            },
                        ),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxHeight()
                            .then(if (moving) Modifier.layerBackdrop(tabBackdrop) else Modifier),
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
                                onClick = {},
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
                                .width(targetWidth + edgeExpansion)
                                .height(targetHeight + edgeExpansion)
                                 .graphicsLayer {
                                     translationX = (if (draggingGlass) draggedGlassX else glassX.value) + with(density) { landingInset.toPx() }
                                     translationY = (targetBounds?.top ?: with(density) { 6.dp.toPx() }) -
                                         with(density) { (MobileInteractionGlassEdge * glassProgress).toPx() }
                                }
                                .liquidMotionDeformation(
                                    velocityX = if (draggingGlass) draggedGlassVelocityX else glassX.velocity,
                                    velocityY = 0f,
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
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(50)
    Box(
        modifier.size(width = 32.dp, height = 28.dp).clip(shape).background(background)
            .border(1.dp, border, shape).clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            ),
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
    val editorBackground = if (lightTheme) Color(0xFFF7F8FC) else Color(0xFF0B0D14)
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
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp)) {
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
                Text(if (markdownPreview) "READ" else "INSERT", color = Color(0xFF38D4A0), fontSize = 9.sp,
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
            if (item.status == "done") Color(0xFF38D4A0) else p.textSecondary,
            border = if (item.status == "in_progress") Color(0x80F0AD4E) else p.border,
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
                    ) { status -> Text(status, color = Color(0xFF38D4A0), fontSize = 9.sp) }
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
    val (_, predictiveModifier) = predictiveBackMotion(onDismiss, fadeOnly = true)
    val backdrop = rememberLiquidBackdrop()
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        DialogBackdropBlur(42.dp)
        Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().layerBackdrop(backdrop))
        Box(predictiveModifier.fillMaxWidth(.82f).fillMaxHeight(.8f).widthIn(max = 680.dp)
            .liquidGlassModifier(
                backdrop = backdrop,
                shape = MobilePopupShape,
                alpha = 0f,
                blurRadius = 8.dp,
                refractionHeight = 5.dp,
                refractionAmount = 8.dp,
                surfaceColor = Color.Transparent,
            )) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("实时历史 — 运行期间自动更新。", color = p.textSecondary, fontSize = 11.sp, modifier = Modifier.weight(1f))
                    IconButton(LucideIcons.X, "关闭", p.textSecondary, onClick = onDismiss)
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
            Text("结果", color = Color(0xFF38D4A0), fontSize = 11.sp, modifier = Modifier.padding(bottom = 4.dp))
            Text(it, color = p.textPrimary, fontSize = 11.sp, lineHeight = 16.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(p.bgTertiary)
                    .border(1.dp, p.border, RoundedCornerShape(8.dp)).padding(10.dp))
        }
        Text("历史", color = Color(0xFF38D4A0), fontSize = 11.sp, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
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
    keepMounted: Boolean,
    localVm: ChatViewModel? = null,
    modifier: Modifier = Modifier,
) {
    key(session) {
        if (visible || session.hasActivity || keepMounted) {
            ConversationBrowserPanel(session, visible, localVm, modifier)
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
            EditorToolbarButton(LucideIcons.RefreshCw, "刷新", webView != null) { session.reload() }
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
        AndroidView(
            factory = {
                WebView(context).apply {
                    setBackgroundColor(AndroidColor.TRANSPARENT)
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.loadsImagesAutomatically = true
                    settings.cacheMode = WebSettings.LOAD_DEFAULT
                    settings.allowFileAccess = false
                    settings.allowContentAccess = false
                    settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    settings.javaScriptCanOpenWindowsAutomatically = false
                    settings.setSupportMultipleWindows(false)
                    settings.setGeolocationEnabled(false)
                    settings.mediaPlaybackRequiresUserGesture = true
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        settings.safeBrowsingEnabled = true
                    }
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                            val target = BrowserUrlPolicy.normalizeNavigation(request.url.toString())
                            return if (target != null) {
                                // Return false and let WebView continue this exact request.
                                // Calling loadUrl here duplicates navigation and can bypass
                                // redirect bookkeeping.
                                false
                            } else {
                                session.onNavigationError("已阻止非网页链接：${request.url.scheme ?: "unknown"}", view.canGoBack(), view.canGoForward())
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
                        }
                        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                            session.onNavigationStarted(url)
                        }
                        override fun onPageFinished(view: WebView, url: String) {
                            session.onNavigationFinished(url, view.canGoBack(), view.canGoForward())
                            view.evaluateJavascript(
                                "(function(){var b=document.body;return b?(b.innerText||b.textContent||''):'';})()",
                            ) { encoded ->
                                val text = runCatching { org.json.JSONArray("[$encoded]").optString(0) }.getOrDefault("")
                                session.onPublicText(text)
                            }
                        }
                        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                            if (request.isForMainFrame) {
                                session.onNavigationError(error.description?.toString() ?: "网页加载失败", view.canGoBack(), view.canGoForward())
                            }
                        }
                        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                            if (request.isForMainFrame && errorResponse.statusCode >= 400) {
                                session.onNavigationError("网页返回 HTTP ${errorResponse.statusCode}", view.canGoBack(), view.canGoForward())
                            }
                        }
                    }
                    webChromeClient = object : WebChromeClient() {
                        override fun onProgressChanged(view: WebView, newProgress: Int) {
                            session.onNavigationProgress(newProgress)
                            session.onHistoryChanged(view.canGoBack(), view.canGoForward())
                        }
                        override fun onReceivedTitle(view: WebView, title: String?) {
                            session.onTitle(title)
                        }
                    }
                    val handler: suspend (String, Int) -> org.json.JSONObject = { url, maxChars ->
                        val browserRecognition = recognition
                            ?: BrowserRecognition(
                                context.applicationContext,
                                this,
                            ).also { recognition = it }
                        val receipt = browserRecognition.recognize(url, maxChars)
                        val raw = receipt.optString("text")
                        if (raw.isNotBlank() && localVm != null) {
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
                    visibility = if (visible) View.VISIBLE else View.INVISIBLE
                }
            },
            update = { view ->
                // INVISIBLE keeps the warmed WebView mounted and loading, but
                // guarantees it cannot draw over or intercept sibling tabs.
                view.visibility = if (visible) View.VISIBLE else View.INVISIBLE
            },
            modifier = Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(8.dp)).border(1.dp, p.border2, RoundedCornerShape(8.dp)),
        )
    }
    DisposableEffect(Unit) {
        onDispose {
            recognitionHandler?.let(session::unbindRecognition)
            recognitionHandler = null
            recognition?.close()
            recognition = null
            webView?.apply {
                stopLoading()
                loadUrl("about:blank")
                clearHistory()
                removeAllViews()
                destroy()
            }
            webView = null
        }
    }
}

@Composable
private fun EmptyState(text: String) {
    val p = LocalNewmarkColors.current
    Text(text, color = p.textTertiary, fontSize = 11.sp, modifier = Modifier.fillMaxWidth().padding(12.dp))
}
