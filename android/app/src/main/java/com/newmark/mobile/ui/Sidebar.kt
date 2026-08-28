package com.newmark.mobile.ui

import android.widget.Toast
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredHeight
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Laptop
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.layout.boundsInParent
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import com.newmark.mobile.data.LocalConversation
import com.newmark.mobile.data.PairInfo
import com.newmark.mobile.data.RemoteConversation
import com.newmark.mobile.data.WorkspaceInfo
import com.newmark.mobile.vm.LinkStatus
import com.newmark.mobile.ui.components.AnchorMenu
import com.newmark.mobile.ui.components.LucideIcons
import com.newmark.mobile.ui.components.MarqueeBorder
import com.newmark.mobile.ui.components.MobileInteractionGlassEdge
import com.newmark.mobile.ui.components.MobileConversationGlassHorizontalEdge
import com.newmark.mobile.ui.components.MenuPlacement
import com.newmark.mobile.ui.components.MenuRow
import com.newmark.mobile.ui.components.NewmarkShapeMedium
import com.newmark.mobile.ui.components.NewmarkShapeSmall
import com.newmark.mobile.ui.components.glassButtonSurface
import com.newmark.mobile.ui.components.GlassButtonCanvas
import com.newmark.mobile.ui.components.liquidHoldDragGesture
import com.newmark.mobile.ui.components.liquidGlassModifier
import com.newmark.mobile.ui.components.liquidMotionDeformation
import com.newmark.mobile.ui.components.liquidSelectionMorph
import com.newmark.mobile.ui.components.rememberLiquidBackdrop
import com.newmark.mobile.ui.components.runOverlappedLiquidFlight
import com.newmark.mobile.ui.components.resistedLiquidBoundaryPosition
import com.newmark.mobile.ui.components.LocalSidebarGestureLock
import com.newmark.mobile.ui.theme.LocalNewmarkColors
import com.newmark.mobile.ui.theme.LocalGlassMode
import com.newmark.mobile.ui.theme.scaledGlassAlpha
import com.newmark.mobile.ui.theme.LocalThemeMode
import com.newmark.mobile.ui.theme.NewmarkAccent
import com.newmark.mobile.ui.theme.NewmarkAccentSoft
import com.newmark.mobile.ui.theme.NewmarkBgQuaternary
import com.newmark.mobile.ui.theme.NewmarkBgSecondary
import com.newmark.mobile.ui.theme.NewmarkBgTertiary
import com.newmark.mobile.ui.theme.NewmarkGreen
import com.newmark.mobile.ui.theme.NewmarkRed
import com.newmark.mobile.ui.theme.NewmarkTextPrimary
import com.newmark.mobile.ui.theme.NewmarkTextSecondary
import com.newmark.mobile.ui.theme.NewmarkTextTertiary
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.coroutineScope
import com.kyant.backdrop.backdrops.layerBackdrop

sealed interface SidebarPage {
    data object Main : SidebarPage
    data class WorkspaceConversations(val workspace: WorkspaceInfo) : SidebarPage
}

private val PcEaseOutExpo = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)
private enum class ConversationMenuTrigger { MoreButton, LongPress }

@Composable
fun SidebarContent(
    rail: Boolean,
    page: SidebarPage,
    expandedDevice: Device?,
    conversations: List<LocalConversation>,
    currentConversationId: String?,
    onToggleDevice: (Device) -> Unit,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenMemoryLab: () -> Unit,
    onOpenTerminal: () -> Unit,
    onNewConversation: () -> Unit,
    onNewRemoteConversation: () -> Unit = {},
    onSelectConversation: (String) -> Unit,
    onToggleRail: (() -> Unit)? = null,
    pairedDevices: List<PairInfo> = emptyList(),
    activeHost: String? = null,
    linkStatus: LinkStatus = LinkStatus.Disconnected,
    onSelectDevice: (String) -> Unit = {},
    workspaces: List<WorkspaceInfo> = emptyList(),
    workspaceConversations: List<RemoteConversation> = emptyList(),
    remoteConversations: List<RemoteConversation> = emptyList(),
    activeConversationId: String = "",
    onSelectRemoteConversation: (String) -> Unit = {},
    onOpenWorkspace: (WorkspaceInfo) -> Unit = {},
    onRenameLocal: (String, String) -> Unit = { _, _ -> },
    onArchiveLocal: (String) -> Unit = {},
    onTogglePinLocal: (String) -> Unit = {},
    onReorderLocal: (List<String>) -> Unit = {},
    onRenameRemote: (RemoteConversation, String) -> Unit = { _, _ -> },
    onArchiveRemote: (RemoteConversation) -> Unit = {},
    onTogglePinRemote: (RemoteConversation) -> Unit = {},
    onReorderRemote: (List<String>) -> Unit = {},
    archivePendingIds: Set<String> = emptySet(),
    swapPages: Boolean = false,
) {
    val p = LocalNewmarkColors.current
    val mainContent: @Composable () -> Unit = {
        MainSidebar(
            rail = rail,
            expandedDevice = expandedDevice,
            conversations = conversations,
            currentConversationId = currentConversationId,
            onToggleDevice = onToggleDevice,
            onOpenSettings = onOpenSettings,
            onOpenMemoryLab = onOpenMemoryLab,
            onOpenTerminal = onOpenTerminal,
            onNewConversation = onNewConversation,
            onSelectConversation = onSelectConversation,
            onToggleRail = onToggleRail,
            pairedDevices = pairedDevices,
            activeHost = activeHost,
            linkStatus = linkStatus,
            onSelectDevice = onSelectDevice,
            workspaces = workspaces,
            onOpenWorkspace = onOpenWorkspace,
            onRenameLocal = onRenameLocal,
            onArchiveLocal = onArchiveLocal,
            onTogglePinLocal = onTogglePinLocal,
            onReorderLocal = onReorderLocal,
        )
    }
    val pageContent: @Composable (SidebarPage) -> Unit = { targetPage ->
        when (targetPage) {
            SidebarPage.Main -> mainContent()
            is SidebarPage.WorkspaceConversations -> WorkspaceConversationsSidebar(
                conversations = workspaceConversations,
                activeConversationId = activeConversationId,
                onBack = onBack,
                onSelectConversation = onSelectRemoteConversation,
                onNewConversation = onNewRemoteConversation,
                onRenameConversation = onRenameRemote,
                onArchiveConversation = onArchiveRemote,
                onTogglePinConversation = onTogglePinRemote,
                onReorderConversations = onReorderRemote,
                archivePendingIds = archivePendingIds,
            )
        }
    }

    if (swapPages) {
        // 竖屏抽屉只保留一个页面：一级先向左收回，再从右侧展开二级；返回时反向。
        AnimatedContent(
            targetState = page,
            transitionSpec = {
                val forward = targetState is SidebarPage.WorkspaceConversations
                val enter = slideInHorizontally(
                    animationSpec = tween(
                        durationMillis = 250,
                        delayMillis = 250,
                        easing = PcEaseOutExpo,
                    ),
                    initialOffsetX = { width -> if (forward) width else -width },
                ) + fadeIn(
                    animationSpec = tween(
                        durationMillis = 250,
                        delayMillis = 250,
                        easing = PcEaseOutExpo,
                    ),
                )
                val exit = slideOutHorizontally(
                    animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo),
                    targetOffsetX = { width -> if (forward) -width else width },
                ) + fadeOut(animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo))
                enter.togetherWith(exit)
            },
            label = "compactSidebarPage",
        ) { targetPage ->
            pageContent(targetPage)
        }
    } else {
        // 宽屏的二级栏由 NewmarkApp 作为 48dp 一级栏右侧的独立 220dp 面板渲染。
        mainContent()
    }
}

// ============ 主侧栏：设备与工作区 / 本地对话 / 设置 ============
@Composable
private fun MainSidebar(
    rail: Boolean,
    expandedDevice: Device?,
    conversations: List<LocalConversation>,
    currentConversationId: String?,
    onToggleDevice: (Device) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenMemoryLab: () -> Unit,
    onOpenTerminal: () -> Unit,
    onNewConversation: () -> Unit,
    onSelectConversation: (String) -> Unit,
    onToggleRail: (() -> Unit)? = null,
    pairedDevices: List<PairInfo> = emptyList(),
    activeHost: String? = null,
    linkStatus: LinkStatus = LinkStatus.Disconnected,
    onSelectDevice: (String) -> Unit = {},
    workspaces: List<WorkspaceInfo> = emptyList(),
    onOpenWorkspace: (WorkspaceInfo) -> Unit = {},
    onRenameLocal: (String, String) -> Unit = { _, _ -> },
    onArchiveLocal: (String) -> Unit = {},
    onTogglePinLocal: (String) -> Unit = {},
    onReorderLocal: (List<String>) -> Unit = {},
) {
    val pc = pcSecondaryPalette()
    val setSidebarGestureLock = LocalSidebarGestureLock.current
    val glass = LocalGlassMode.current
    val surface = pc.panel.compositeOver(pc.canvas)
    val sidebarSurfaceAlpha = if (pc == PcSecondaryLight) 0.90f else 0.72f
    val localConversationBounds = remember { mutableStateMapOf<String, Rect>() }
    var localConversationHostCoordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    val localConversationGlassY = remember { Animatable(0f) }
    val localConversationGlassLift = remember { Animatable(0f) }
    val localConversationGlassScaleX = remember { Animatable(1f) }
    val localConversationGlassScaleY = remember { Animatable(1f) }
    val localConversationBackdrop = rememberLiquidBackdrop()
    var localConversationGlassVisible by remember { mutableStateOf(false) }
    var localConversationGlassX by remember { mutableStateOf(0f) }
    var localConversationGlassWidth by remember { mutableStateOf(0f) }
    var localConversationGlassHeight by remember { mutableStateOf(0f) }
    var localGlassArrivedId by remember { mutableStateOf<String?>(null) }
    var localGlassDestinationId by remember { mutableStateOf<String?>(null) }
    var localGlassLanding by remember { mutableStateOf(false) }
    var localVisualSelectedId by remember { mutableStateOf(currentConversationId) }
    var draggingLocalId by remember { mutableStateOf<String?>(null) }
    var localDragPointerY by remember { mutableStateOf(0f) }
    var localDragOriginY by remember { mutableStateOf(0f) }
    var localDragVelocityY by remember { mutableStateOf(0f) }
    var localDragSourceGroupIndex by remember { mutableIntStateOf(-1) }
    var localDragDestinationGroupIndex by remember { mutableIntStateOf(-1) }
    var localDragItemHeight by remember { mutableStateOf(0f) }
    val localConversationScope = rememberCoroutineScope()
    var localConversationFlightJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    val localDensity = LocalDensity.current

    fun flyLocalConversationGlass(targetId: String, onArrive: () -> Unit = {}) {
        val target = localConversationBounds[targetId]
        val sourceId = localGlassArrivedId ?: currentConversationId
        val source = sourceId?.let(localConversationBounds::get) ?: target
        if (target == null || source == null) return onArrive()
        val redirecting = localConversationGlassVisible
        localConversationFlightJob?.cancel()
        localConversationGlassX = target.left
        localConversationGlassWidth = target.width
        localConversationGlassHeight = target.height
        localGlassDestinationId = targetId
        localGlassLanding = false
        setSidebarGestureLock("local-conversation-flight", true)
        localConversationFlightJob = localConversationScope.launch {
            if (!redirecting) {
                localConversationGlassY.snapTo(source.top)
                localConversationGlassLift.snapTo(0f)
                localConversationGlassScaleX.snapTo(0f)
                localConversationGlassScaleY.snapTo(0f)
            }
            localConversationGlassVisible = true
            runOverlappedLiquidFlight(
                lift = { coroutineScope { launch { localConversationGlassLift.animateTo(1f, tween(100, easing = PcEaseOutExpo)) }; launch { localConversationGlassScaleX.animateTo(1f, tween(100, easing = PcEaseOutExpo)) }; launch { localConversationGlassScaleY.animateTo(1f, tween(100, easing = PcEaseOutExpo)) } } },
                move = { localConversationGlassY.animateTo(target.top, tween(240, easing = PcEaseOutExpo)) },
                onLandingStarted = { localGlassLanding = true },
                land = { coroutineScope { launch { localConversationGlassLift.animateTo(0f, tween(240, easing = PcEaseOutExpo)) }; launch { localConversationGlassScaleX.animateTo(0f, tween(240, easing = PcEaseOutExpo)) }; launch { localConversationGlassScaleY.animateTo(0f, tween(240, easing = PcEaseOutExpo)) } } },
            )
            localGlassArrivedId = targetId
            localVisualSelectedId = targetId
            localConversationGlassVisible = false
            localGlassLanding = false
            localGlassDestinationId = null
            setSidebarGestureLock("local-conversation-flight", false)
            onArrive()
        }
    }
    fun selectLocalConversationWithGlass(targetId: String) {
        flyLocalConversationGlass(targetId) { onSelectConversation(targetId) }
    }
    fun beginLocalConversationDrag(targetId: String) {
        val target = localConversationBounds[targetId] ?: return
        localConversationFlightJob?.cancel()
        localConversationGlassX = target.left
        localConversationGlassWidth = target.width
        localConversationGlassHeight = target.height
        localGlassArrivedId = targetId
        localGlassDestinationId = targetId
        localGlassLanding = false
        localConversationFlightJob = localConversationScope.launch {
            localConversationGlassY.snapTo(target.top)
            localConversationGlassScaleX.snapTo(0f)
            localConversationGlassScaleY.snapTo(0f)
            localConversationGlassVisible = true
            runOverlappedLiquidFlight(
                holdKeepsLifted = true,
                lift = { coroutineScope { launch { localConversationGlassLift.animateTo(1f, tween(100, easing = PcEaseOutExpo)) }; launch { localConversationGlassScaleX.animateTo(1f, tween(100, easing = PcEaseOutExpo)) }; launch { localConversationGlassScaleY.animateTo(1f, tween(100, easing = PcEaseOutExpo)) } } },
                move = {}, onLandingStarted = {}, land = {},
            )
        }
    }
    fun clearLocalDrag() {
        localConversationFlightJob?.cancel()
        localConversationFlightJob = null
        localConversationGlassVisible = false
        draggingLocalId = null
        localDragPointerY = 0f
        localDragOriginY = 0f
        localDragVelocityY = 0f
        localDragSourceGroupIndex = -1
        localDragDestinationGroupIndex = -1
        localDragItemHeight = 0f
        localGlassArrivedId = null
        localGlassDestinationId = null
        localGlassLanding = false
        setSidebarGestureLock("local-conversation-flight", false)
        setSidebarGestureLock("local-conversation-reorder", false)
    }
    fun finishLocalDrag(moved: Boolean) {
        val sourceId = draggingLocalId
        if (moved && sourceId != null) {
            val source = conversations.firstOrNull { it.id == sourceId }
            if (source != null) {
                val group = conversations.filter { it.pinned == source.pinned }.map { it.id }.toMutableList()
                val original = group.toList()
                val sourceGroupIndex = localDragSourceGroupIndex
                val destinationGroupIndex = localDragDestinationGroupIndex
                if (sourceGroupIndex >= 0 && destinationGroupIndex >= 0) {
                    group.removeAt(sourceGroupIndex)
                    group.add(destinationGroupIndex.coerceIn(0, group.size), sourceId)
                    if (group != original) {
                        rebaseConversationBounds(localConversationBounds, original, group)
                        onReorderLocal(group)
                    }
                }
            }
        }
        if (sourceId == null) return clearLocalDrag()
        val releasedTop = localConversationGlassY.value + localDragPointerY - localDragOriginY
        localConversationFlightJob?.cancel()
        localConversationFlightJob = localConversationScope.launch {
            localConversationGlassY.snapTo(releasedTop)
            draggingLocalId = null
            localDragPointerY = 0f
            localDragOriginY = 0f
            localDragVelocityY = 0f
            localDragSourceGroupIndex = -1
            localDragDestinationGroupIndex = -1
            localDragItemHeight = 0f
            val landingTop = localConversationBounds[sourceId]?.top ?: localConversationGlassY.value
            runOverlappedLiquidFlight(
                lift = {},
                move = { localConversationGlassY.animateTo(landingTop, tween(120, easing = PcEaseOutExpo)) },
                onLandingStarted = { localGlassLanding = true },
                land = { coroutineScope { launch { localConversationGlassLift.animateTo(0f, tween(240, easing = PcEaseOutExpo)) }; launch { localConversationGlassScaleX.animateTo(0f, tween(240, easing = PcEaseOutExpo)) }; launch { localConversationGlassScaleY.animateTo(0f, tween(240, easing = PcEaseOutExpo)) } } },
            )
            localConversationGlassVisible = false
            localGlassLanding = false
            localGlassArrivedId = sourceId
            setSidebarGestureLock("local-conversation-flight", false)
            setSidebarGestureLock("local-conversation-reorder", false)
        }
    }
    LaunchedEffect(conversations.map { it.id }) {
        localConversationBounds.keys.toList().filterNot { id -> conversations.any { it.id == id } }
            .forEach(localConversationBounds::remove)
    }
    LaunchedEffect(currentConversationId, localConversationGlassVisible) {
        if (!localConversationGlassVisible) localVisualSelectedId = currentConversationId
    }
    DisposableEffect(Unit) {
        onDispose {
            localConversationFlightJob?.cancel()
            setSidebarGestureLock("local-conversation-flight", false)
            setSidebarGestureLock("local-conversation-reorder", false)
        }
    }
    Column(
        modifier = Modifier
            .fillMaxSize()
            // 一级栏宽度和信息架构不变；视觉 token 直接沿用 PC 二级栏。
            .background(surface.copy(alpha = scaledGlassAlpha(sidebarSurfaceAlpha, glass.alpha)))
            .padding(horizontal = if (rail) 4.dp else 6.dp),
    ) {
        // 区 1：设备与工作区（顶部）
        DeviceWorkspaceSection(
            rail = rail,
            expandedDevice = expandedDevice,
            onToggleDevice = onToggleDevice,
            pairedDevices = pairedDevices,
            activeHost = activeHost,
            linkStatus = linkStatus,
            onSelectDevice = onSelectDevice,
            workspaces = workspaces,
            onOpenWorkspace = onOpenWorkspace,
        )

        // 区 2：本地对话。rail 仅保留一级导航，不显示本地对话缩略项。
        if (rail) {
            Spacer(Modifier.weight(1f))
        } else {
            Column(Modifier.weight(1f)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SectionLabel("本地对话")
                    Spacer(Modifier.weight(1f))
                    GlassButtonCanvas(
                        visualSize = 24.dp,
                        shape = CircleShape,
                        surfaceColor = pc.control,
                        onClick = onNewConversation,
                        modifier = Modifier.padding(end = 10.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Add,
                            contentDescription = "新对话",
                            tint = pc.textDim,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
                if (conversations.isEmpty()) {
                    Text(
                        text = "点击右上角 + 新建对话",
                        fontSize = 11.sp,
                        color = pc.textDim,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                    )
                } else {
                    val sourceIndex = conversations.indexOfFirst { it.id == draggingLocalId }
                    val previewHeight = draggingLocalId?.let(localConversationBounds::get)?.height ?: 0f
                    val sourcePinned = draggingLocalId
                        ?.let { id -> conversations.firstOrNull { it.id == id } }
                        ?.pinned
                    val groupIndices = conversations.indices.filter { conversations[it].pinned == sourcePinned }
                    val sourceGroupIndex = localDragSourceGroupIndex
                    val destinationGroupIndex = localDragDestinationGroupIndex
                    val destinationIndex = groupIndices.getOrElse(destinationGroupIndex) { sourceIndex }
                    Box(
                        Modifier
                            .fillMaxSize()
                            .onGloballyPositioned { localConversationHostCoordinates = it },
                    ) {
                        LazyColumn(
                            Modifier
                                .fillMaxSize()
                                .then(
                                    if (localConversationGlassVisible) Modifier.layerBackdrop(localConversationBackdrop)
                                    else Modifier,
                                ),
                        ) {
                            itemsIndexed(conversations, key = { _, item -> item.id }) { itemIndex, conv ->
                                LocalConversationRow(
                                    modifier = Modifier.animateItem(
                                        fadeInSpec = tween(160, easing = PcEaseOutExpo),
                                        placementSpec = tween(260, easing = PcEaseOutExpo),
                                        fadeOutSpec = tween(180, easing = PcEaseOutExpo),
                                    ).onGloballyPositioned { coordinates ->
                                        localConversationBounds[conv.id] = localConversationHostCoordinates
                                            ?.localBoundingBoxOf(coordinates, clipBounds = false)
                                            ?: coordinates.boundsInParent()
                                    },
                                    conversation = conv,
                                    selected = !localConversationGlassVisible && conv.id == localVisualSelectedId,
                                    reordering = draggingLocalId != null,
                                    glassCovered = localConversationGlassVisible && !localGlassLanding &&
                                        (conv.id == localGlassArrivedId || conv.id == localGlassDestinationId),
                                    onClick = { selectLocalConversationWithGlass(conv.id) },
                                    onRename = { onRenameLocal(conv.id, it) },
                                    onArchive = { onArchiveLocal(conv.id) },
                                    onTogglePin = { onTogglePinLocal(conv.id) },
                                    dragging = draggingLocalId == conv.id,
                                    lifted = draggingLocalId == conv.id,
                                    dragTranslationY = if (draggingLocalId == conv.id) {
                                        localDragPointerY - localDragOriginY
                                    } else 0f,
                                    dragVelocityY = if (draggingLocalId == conv.id) localDragVelocityY else 0f,
                                    previewTranslationY = conversationPreviewShift(
                                        itemIndex = itemIndex,
                                        sourceIndex = sourceIndex,
                                        destinationIndex = destinationIndex,
                                        itemHeightPx = previewHeight,
                                    ),
                                    onDragStart = {
                                        if (localConversationBounds[conv.id] == null || conversations.none { it.id == conv.id }) return@LocalConversationRow
                                        draggingLocalId = conv.id
                                        localDragPointerY = localConversationBounds[conv.id]?.center?.y ?: 0f
                                        localDragOriginY = localDragPointerY
                                        val sourcePinned = conversations.firstOrNull { it.id == conv.id }?.pinned
                                        val group = conversations.filter { it.pinned == sourcePinned }
                                        localDragSourceGroupIndex = group.indexOfFirst { it.id == conv.id }
                                        localDragDestinationGroupIndex = localDragSourceGroupIndex
                                        localDragItemHeight = localConversationBounds[conv.id]?.height ?: 0f
                                        setSidebarGestureLock("local-conversation-reorder", true)
                                        beginLocalConversationDrag(conv.id)
                                    },
                                    onDragDelta = { deltaY ->
                                        if (draggingLocalId == conv.id) {
                                            val sourcePinned = conversations.firstOrNull { it.id == conv.id }?.pinned
                                            val groupSize = conversations.count { it.pinned == sourcePinned }
                                            val previousPointerY = localDragPointerY
                                            val nextPointerY = clampConversationDragDelta(
                                                sourceIndex = localDragSourceGroupIndex,
                                                pointerDeltaY = localDragPointerY + deltaY - localDragOriginY,
                                                itemHeightPx = localDragItemHeight,
                                                itemCount = groupSize,
                                            ) + localDragOriginY
                                            localDragPointerY = nextPointerY
                                            localDragVelocityY = (nextPointerY - previousPointerY) * 60f
                                            localDragDestinationGroupIndex = conversationDragDestinationIndex(
                                                sourceIndex = localDragSourceGroupIndex,
                                                pointerDeltaY = nextPointerY - localDragOriginY,
                                                itemHeightPx = localDragItemHeight,
                                                itemCount = groupSize,
                                            )
                                        }
                                    },
                                    onDragEnd = ::finishLocalDrag,
                                    onDragCancel = ::clearLocalDrag,
                                )
                            }
                        }
                        if (localConversationGlassVisible) {
                            val edgePx = with(localDensity) { MobileInteractionGlassEdge.toPx() }
                            val horizontalEdgePx = with(localDensity) { MobileConversationGlassHorizontalEdge.toPx() }
                            val travelCenterCorrectionPx = with(localDensity) { 2.dp.toPx() } * localConversationGlassLift.value
                            Box(
                                Modifier
                                    .requiredWidth(with(localDensity) { (localConversationGlassWidth + horizontalEdgePx * 2f * localConversationGlassScaleX.value).toDp() })
                                    .requiredHeight(with(localDensity) { (localConversationGlassHeight + edgePx * 2f * localConversationGlassScaleY.value).toDp() })
                                    .graphicsLayer {
                                        translationX = localConversationGlassX - horizontalEdgePx * localConversationGlassScaleX.value +
                                            travelCenterCorrectionPx
                                        translationY = localConversationGlassY.value - edgePx * localConversationGlassScaleY.value +
                                            if (draggingLocalId == localGlassArrivedId) localDragPointerY - localDragOriginY else 0f
                                    }
                                    .liquidMotionDeformation(
                                        velocityX = 0f,
                                        velocityY = if (draggingLocalId != null) localDragVelocityY else localConversationGlassY.velocity,
                                        density = localDensity.density,
                                    )
                                    .zIndex(8f)
                                    .liquidSelectionMorph(
                                        backdrop = localConversationBackdrop,
                                        shape = RoundedCornerShape(50),
                                        fillColor = pc.activeSurface,
                                        glassProgress = localConversationGlassLift.value,
                                        glassAlpha = 0.08f,
                                        blurRadius = 2.dp,
                                        refractionHeight = MobileInteractionGlassEdge,
                                        refractionAmount = 20.dp,
                                    ),
                            )
                        }
                    }
                }
            }
        }

        // 区 3：折叠切换 + 底部固定按钮（从下往上：设置 → Memory Lab → 命令行）
        if (onToggleRail != null) {
            ToggleRailButton(rail = rail, onClick = onToggleRail)
        }
        if (rail) {
            CollapsedUtilityButtons(
                onOpenTerminal = onOpenTerminal,
                onOpenMemoryLab = onOpenMemoryLab,
                onOpenSettings = onOpenSettings,
            )
        } else {
            ExpandedUtilityButtons(
                onOpenTerminal = onOpenTerminal,
                onOpenMemoryLab = onOpenMemoryLab,
                onOpenSettings = onOpenSettings,
            )
        }
    }
}

@Composable
private fun ToggleRailButton(rail: Boolean, onClick: () -> Unit) {
    val pc = pcSecondaryPalette()
    val shape = RoundedCornerShape(50)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .glassButtonSurface(shape, pc.control)
            .border(1.dp, pc.buttonBorder, shape)
            .clickable(onClick = onClick)
            .padding(vertical = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (rail) "▶" else "◀",
            fontSize = 10.sp,
            color = pc.textDim,
        )
    }
}

@Composable
private fun SectionLabel(text: String) {
    val pc = pcSecondaryPalette()
    Text(
        text = text,
        fontSize = 10.5.sp,
        fontWeight = FontWeight.SemiBold,
        color = pc.textDim,
        letterSpacing = 0.6.sp,
        modifier = Modifier.padding(start = 10.dp, top = 6.dp, bottom = 4.dp),
        maxLines = 1,
        overflow = TextOverflow.Clip,
    )
}

// ---- 设备（真实配对设备，清除 demo mock） ----
@Composable
private fun DeviceWorkspaceSection(
    rail: Boolean,
    expandedDevice: Device?,
    onToggleDevice: (Device) -> Unit,
    pairedDevices: List<PairInfo> = emptyList(),
    activeHost: String? = null,
    linkStatus: LinkStatus = LinkStatus.Disconnected,
    onSelectDevice: (String) -> Unit = {},
    workspaces: List<WorkspaceInfo> = emptyList(),
    onOpenWorkspace: (WorkspaceInfo) -> Unit = {},
) {
    val pc = pcSecondaryPalette()
    var expandedHost by remember { mutableStateOf<String?>(null) }
    Column {
        if (rail) {
            pairedDevices.forEach { device ->
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(if (device.host == activeHost) pc.activeSurface else pc.control)
                        .border(1.dp, if (device.host == activeHost) pc.accent else pc.border, RoundedCornerShape(6.dp))
                        .clickable { onSelectDevice(device.host) },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.Computer, contentDescription = device.displayName, tint = pc.textDim, modifier = Modifier.size(16.dp))
                }
            }
        } else {
            SectionLabel("设备")
            if (pairedDevices.isEmpty()) {
                Text(
                    text = "未配对设备",
                    fontSize = 11.sp,
                    color = pc.textDim,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                )
            } else {
                pairedDevices.forEach { device ->
                    val isExpanded = expandedHost == device.host
                    PairedDeviceRow(
                        device = device,
                        active = device.host == activeHost,
                        linkStatus = if (device.host == activeHost) linkStatus else LinkStatus.Disconnected,
                        onClick = {
                            onSelectDevice(device.host)
                            expandedHost = if (isExpanded) null else device.host
                        },
                    )
                    AnimatedVisibility(visible = isExpanded) {
                        Column(Modifier.padding(start = 26.dp)) {
                            if (workspaces.isEmpty()) {
                                Text("无工作区", fontSize = 10.5.sp, color = pc.textDim, modifier = Modifier.padding(vertical = 4.dp))
                            } else {
                                workspaces.forEach { ws ->
                                    WorkspaceInfoRow(ws, onClick = { onOpenWorkspace(ws) })
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun WorkspaceInfoRow(workspace: WorkspaceInfo, onClick: () -> Unit) {
    val pc = pcSecondaryPalette()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(pc.control)
            .border(1.dp, pc.border, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Folder, contentDescription = null, tint = pc.textDim, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(workspace.name, fontSize = 11.5.sp, fontWeight = FontWeight.Medium, color = pc.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(workspace.path, fontSize = 9.5.sp, color = pc.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text("›", fontSize = 14.sp, color = pc.textDim)
    }
}

@Composable
private fun PairedDeviceRow(device: PairInfo, active: Boolean, linkStatus: LinkStatus, onClick: () -> Unit) {
    val pc = pcSecondaryPalette()
    val (text, color) = if (!active) {
        "点击连接" to pc.textDim
    } else when (linkStatus) {
        LinkStatus.Connected -> "已连接" to pc.accent2
        LinkStatus.Connecting -> "连接中..." to pc.textDim
        LinkStatus.Reconnecting -> "重连中..." to pc.textDim
        LinkStatus.Disconnected -> "已断开" to pc.runtimeDanger
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(if (active) pc.activeSurface else pc.control)
            .border(1.dp, if (active) pc.accent else pc.border, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Computer, contentDescription = null, tint = if (active) pc.accent else pc.textDim, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = device.displayName,
                fontSize = 12.5.sp,
                fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
                color = pc.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = if (active) text else "${device.host} · $text",
                fontSize = 10.5.sp,
                color = color,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun DeviceRow(device: Device, expanded: Boolean, onClick: () -> Unit) {
    val p = LocalNewmarkColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(NewmarkShapeSmall)
            .clickable(onClick = onClick)
            .background(if (expanded) p.accentSoft else Color.Transparent)
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(imageVector = if (device.online) Icons.Filled.Computer else Icons.Filled.Laptop, contentDescription = null, tint = p.textSecondary, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = device.name,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Medium,
                color = p.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = if (device.online) "已连接 · Tailscale" else "离线",
                fontSize = 10.5.sp,
                color = if (device.online) p.green else p.textTertiary,
                maxLines = 1,
            )
        }
        Icon(
            imageVector = Icons.Filled.KeyboardArrowDown,
            contentDescription = null,
            tint = p.textTertiary,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
private fun DeviceRailIcon(device: Device, expanded: Boolean, onClick: () -> Unit) {
    val p = LocalNewmarkColors.current
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(NewmarkShapeSmall)
            .background(if (expanded) p.accentSoft else Color.Transparent)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(imageVector = if (device.online) Icons.Filled.Computer else Icons.Filled.Laptop, contentDescription = null, tint = p.textSecondary, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun WorkspaceRow(workspace: Workspace, onClick: () -> Unit) {
    val p = LocalNewmarkColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(NewmarkShapeSmall)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WorkspaceThumb(workspace = workspace)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = workspace.name,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Medium,
                color = p.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = workspace.path,
                fontSize = 10.5.sp,
                color = p.textTertiary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun WorkspaceRailIcon(workspace: Workspace, onClick: () -> Unit) {
    val p = LocalNewmarkColors.current
    Box(
        modifier = Modifier
            .size(32.dp)
            .clip(NewmarkShapeSmall)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        WorkspaceThumb(workspace = workspace)
    }
}

@Composable
private fun WorkspaceThumb(workspace: Workspace) {
    val p = LocalNewmarkColors.current
    Box(
        modifier = Modifier
            .size(30.dp)
            .clip(NewmarkShapeSmall)
            .background(
                Brush.linearGradient(
                    colors = listOf(p.accentSoft, p.accent.copy(alpha = 0.08f)),
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = workspace.initial.toString(),
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            color = p.accent,
        )
    }
}

// ---- 本地对话行（真实数据 + PC 对话菜单：三个点/长按 → 重命名/归档/置顶） ----
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun LocalConversationRow(
    modifier: Modifier = Modifier,
    conversation: LocalConversation,
    selected: Boolean,
    reordering: Boolean,
    glassCovered: Boolean,
    onClick: () -> Unit,
    onRename: (String) -> Unit,
    onArchive: () -> Unit,
    onTogglePin: () -> Unit,
    dragging: Boolean,
    lifted: Boolean,
    dragTranslationY: Float,
    dragVelocityY: Float,
    previewTranslationY: Float,
    onDragStart: () -> Unit,
    onDragDelta: (Float) -> Unit,
    onDragEnd: (Boolean) -> Unit,
    onDragCancel: () -> Unit,
) {
    val pc = pcSecondaryPalette()
    val density = LocalDensity.current
    val setSidebarGestureLock = LocalSidebarGestureLock.current
    var showMenu by remember { mutableStateOf(false) }
    var menuTrigger by remember { mutableStateOf(ConversationMenuTrigger.MoreButton) }
    var renaming by remember { mutableStateOf(false) }
    var archivingOut by remember { mutableStateOf(false) }
    val archiveProgress = remember { Animatable(1f) }
    val scope = rememberCoroutineScope()
    fun archiveConversationAfterExit() {
        if (archivingOut) return
        archivingOut = true
        showMenu = false
        scope.launch {
            delay(170)
            archiveProgress.animateTo(0f, tween(220, easing = PcEaseOutExpo))
            onArchive()
        }
    }
    val shape = RoundedCornerShape(50)
    val previewTranslation by animateFloatAsState(
        targetValue = previewTranslationY,
        animationSpec = tween(180, easing = PcEaseOutExpo),
        label = "localConversationDropPreview",
    )
    Box(
        modifier
            .graphicsLayer {
                translationY = dragTranslationY + previewTranslation
                alpha = archiveProgress.value
                scaleX = 0.96f + 0.04f * archiveProgress.value
                scaleY = 0.96f + 0.04f * archiveProgress.value
            }
            .zIndex(if (dragging) 6f else 0f)
            .fillMaxWidth()
            .padding(vertical = 2.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(
                    when {
                        lifted || glassCovered -> Color.Transparent
                        selected && !reordering -> pc.activeSurface
                        else -> pc.control
                    },
                )
                .padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (renaming) {
                PcConversationRenameInput(
                    initialTitle = conversation.title,
                    palette = pc,
                    onSave = onRename,
                    onFinish = { renaming = false },
                    modifier = Modifier.weight(1f),
                )
            } else {
                Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
                    if (conversation.pinned) {
                        Icon(Icons.Filled.PushPin, contentDescription = null, tint = pc.accent, modifier = Modifier.size(12.dp))
                    }
                }
                Box(
                    Modifier
                        .weight(1f)
                        .liquidHoldDragGesture(
                            conversation.id,
                            renaming,
                            onCandidateStart = { setSidebarGestureLock("local-conversation-candidate", true) },
                            onCandidateEnd = { setSidebarGestureLock("local-conversation-candidate", false) },
                            onTap = { if (!renaming) onClick() },
                            onHoldStart = { if (!renaming) onDragStart() },
                            onDrag = { _, delta -> if (!renaming) onDragDelta(delta.y) },
                            onHoldEnd = { _, moved ->
                                if (!renaming) {
                                    onDragEnd(moved)
                                    if (!moved) {
                                        menuTrigger = ConversationMenuTrigger.LongPress
                                        showMenu = true
                                    }
                                }
                            },
                            onCancel = { if (!renaming) onDragCancel() },
                        ),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    Text(
                        text = conversation.title,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Normal,
                        color = pc.textDim,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.fillMaxWidth(),
                        textAlign = androidx.compose.ui.text.style.TextAlign.Start,
                    )
                }
            }
            if (!renaming) {
                Spacer(Modifier.width(6.dp))
                Box(
                    modifier = Modifier
                        .size(20.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(if (showMenu) pc.controlHover else Color.Transparent)
                        .clickable {
                            menuTrigger = ConversationMenuTrigger.MoreButton
                            showMenu = true
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(LucideIcons.Ellipsis, contentDescription = "更多", tint = if (showMenu) pc.textBright else pc.textDim, modifier = Modifier.size(14.dp))
                }
            }
        }
        PcConversationActionMenu(
            expanded = showMenu,
            pinned = conversation.pinned,
            archiving = false,
            palette = pc,
            transformOrigin = if (menuTrigger == ConversationMenuTrigger.MoreButton) TransformOrigin(1f, 0f) else TransformOrigin.Center,
            onDismiss = { showMenu = false },
            onRename = { showMenu = false; renaming = true },
            onArchive = ::archiveConversationAfterExit,
            onTogglePin = { showMenu = false; onTogglePin() },
        )
    }
}

// ---- 远端工作区对话行（mock） ----
@Composable
private fun ConversationRow(conversation: Conversation) {
    val p = LocalNewmarkColors.current
    val rowContent: @Composable () -> Unit = {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = conversation.title,
                fontSize = 11.5.sp,
                color = p.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Box(
                modifier = Modifier
                    .size(22.dp)
                    .clip(CircleShape)
                    .background(p.bgQuaternary),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Folder, contentDescription = null, tint = p.textTertiary, modifier = Modifier.size(13.dp))
            }
        }
    }
    if (conversation.running) {
        MarqueeBorder(cornerRadius = 9.dp) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(NewmarkShapeMedium)
                    .background(p.bgTertiary),
            ) {
                rowContent()
            }
        }
    } else {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(NewmarkShapeMedium)
                .background(p.bgQuaternary),
        ) {
            rowContent()
        }
    }
}

// ---- 设置按钮（底部固定） ----
@Composable
private fun CollapsedUtilityButtons(
    onOpenTerminal: () -> Unit,
    onOpenMemoryLab: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val pc = pcSecondaryPalette()
    val setSidebarGestureLock = LocalSidebarGestureLock.current
    val actions = listOf(onOpenTerminal, onOpenMemoryLab, onOpenSettings)
    val currentActions by rememberUpdatedState(actions)
    val icons = listOf(Icons.Filled.Terminal, Icons.Filled.Psychology, Icons.Filled.Settings)
    val labels = listOf("命令行", "Memory Lab", "设置")
    val utilityBackdrop = rememberLiquidBackdrop()
    val scope = rememberCoroutineScope()
    val itemHeight = 46.dp
    val density = LocalDensity.current
    val itemPx = with(density) { itemHeight.toPx() }
    val topInsetPx = with(density) { 3.dp.toPx() }
    val halfFloatPx = with(density) { 20.dp.toPx() }
    val bottomInsetPx = with(density) { 43.dp.toPx() }
    var moving by remember { mutableStateOf(false) }
    var lifting by remember { mutableStateOf(false) }
    var landing by remember { mutableStateOf(false) }
    var activeIndex by remember { mutableStateOf(0) }
    var selectedIndex by remember { mutableStateOf(0) }
    var glassTopPx by remember { mutableStateOf(0f) }
    var glassVelocityY by remember { mutableStateOf(0f) }
    var flightJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    val glassProgress by animateFloatAsState(
        targetValue = if (landing || lifting) 0f else 1f,
        animationSpec = tween(if (landing) 240 else 100, easing = PcEaseOutExpo),
        label = "collapsedUtilityGlassMaterial",
    )
    Box(
        Modifier
            .fillMaxWidth()
            .height(itemHeight * actions.size)
            .liquidHoldDragGesture(
                actions.size,
                onCandidateStart = { setSidebarGestureLock("collapsed-utility-candidate", true) },
                onCandidateEnd = { setSidebarGestureLock("collapsed-utility-candidate", false) },
                onTap = { position ->
                    val target = (position.y / itemPx).toInt().coerceIn(actions.indices)
                    val start = if (moving) glassTopPx else selectedIndex * itemPx + topInsetPx
                    flightJob?.cancel()
                    activeIndex = target
                    setSidebarGestureLock("collapsed-utility", true)
                    if (!moving) lifting = true
                    moving = true
                    flightJob = scope.launch {
                        glassTopPx = start
                        val targetTop = target * itemPx + topInsetPx
                        runOverlappedLiquidFlight(
                            lift = { kotlinx.coroutines.yield(); lifting = false; delay(100) },
                            move = { if (kotlin.math.abs(start - targetTop) >= 0.5f) animate(start, targetTop, animationSpec = tween(380, easing = PcEaseOutExpo)) { value, velocity -> glassTopPx = value; glassVelocityY = velocity } },
                            onLandingStarted = { landing = true }, land = { delay(240) },
                        )
                        landing = false
                        moving = false
                        selectedIndex = target
                        setSidebarGestureLock("collapsed-utility", false)
                        currentActions[target]()
                    }
                },
                onHoldStart = { position ->
                    val target = (position.y / itemPx).toInt().coerceIn(actions.indices)
                    val start = if (moving) glassTopPx else selectedIndex * itemPx + topInsetPx
                    flightJob?.cancel()
                    activeIndex = target
                    setSidebarGestureLock("collapsed-utility", true)
                    if (!moving) lifting = true
                    moving = true
                    flightJob = scope.launch {
                        glassTopPx = start
                        val targetTop = target * itemPx + topInsetPx
                        runOverlappedLiquidFlight(holdKeepsLifted = true, lift = { kotlinx.coroutines.yield(); lifting = false; delay(100) }, move = { animate(start, targetTop, animationSpec = tween(380, easing = PcEaseOutExpo)) { value, velocity -> glassTopPx = value; glassVelocityY = velocity } }, onLandingStarted = {}, land = {})
                    }
                },
                onDrag = { position, delta ->
                    flightJob?.cancel()
                    moving = true
                    lifting = false
                    activeIndex = (position.y / itemPx).toInt().coerceIn(actions.indices)
                    glassTopPx = resistedLiquidBoundaryPosition(
                        raw = position.y - halfFloatPx,
                        minimum = topInsetPx,
                        maximum = itemPx * actions.size - bottomInsetPx,
                        maxDisplacement = with(density) { 4.dp.toPx() },
                    )
                    glassVelocityY = delta.y * 60f
                },
                onHoldEnd = { _, _ ->
                    val commit = activeIndex
                    flightJob = scope.launch {
                        lifting = false
                        val targetTop = commit * itemPx + topInsetPx
                        runOverlappedLiquidFlight(lift = {}, move = { animate(initialValue = glassTopPx, targetValue = targetTop, animationSpec = tween(120, easing = PcEaseOutExpo)) { value, velocity -> glassTopPx = value; glassVelocityY = velocity } }, onLandingStarted = { landing = true }, land = { delay(240) })
                        landing = false
                        moving = false
                        glassVelocityY = 0f
                        selectedIndex = commit
                        setSidebarGestureLock("collapsed-utility", false)
                        currentActions[commit]()
                    }
                },
                onCancel = {
                    moving = false
                    lifting = false
                    landing = false
                    glassVelocityY = 0f
                    setSidebarGestureLock("collapsed-utility", false)
                },
            ),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .then(if (moving) Modifier.layerBackdrop(utilityBackdrop) else Modifier),
        ) {
            actions.indices.forEach { index ->
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(itemHeight),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(
                        Modifier
                            .size(36.dp)
                            .clip(CircleShape)
                            .background(if (!moving && index == selectedIndex) pc.activeSurface else pc.control),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(icons[index], labels[index], tint = pc.textDim, modifier = Modifier.size(18.dp))
                    }
                }
            }
        }
        if (moving) {
            val collapsedTargetSize = 36.dp
            val collapsedExpansion = 4.dp * glassProgress
            Box(
                Modifier
                    .align(Alignment.TopCenter)
                    .size(collapsedTargetSize + collapsedExpansion)
                    .graphicsLayer {
                        translationY = glassTopPx + with(density) { ((4.dp - collapsedExpansion) / 2f).toPx() }
                    }
                    .liquidMotionDeformation(0f, glassVelocityY, density.density)
                    .zIndex(4f)
                    .liquidSelectionMorph(
                        backdrop = utilityBackdrop,
                        shape = CircleShape,
                        fillColor = pc.activeSurface,
                        glassProgress = glassProgress,
                        glassAlpha = 0.08f,
                        blurRadius = 2.dp,
                        refractionHeight = MobileInteractionGlassEdge,
                        refractionAmount = 20.dp,
                    ),
            )
        }
    }
}

/** Expanded counterpart of the folded three-item rail selector.
 * One empty glass block owns the whole gesture; the labels remain in their
 * static rows and are never duplicated into the floating layer.
 */
@Composable
private fun ExpandedUtilityButtons(
    onOpenTerminal: () -> Unit,
    onOpenMemoryLab: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val pc = pcSecondaryPalette()
    val setSidebarGestureLock = LocalSidebarGestureLock.current
    val actions = listOf(onOpenTerminal, onOpenMemoryLab, onOpenSettings)
    val currentActions by rememberUpdatedState(actions)
    val icons = listOf(Icons.Filled.Terminal, Icons.Filled.Psychology, Icons.Filled.Settings)
    val labels = listOf("命令行", "Memory Lab", "设置")
    val utilityBackdrop = rememberLiquidBackdrop()
    val scope = rememberCoroutineScope()
    val itemHeight = 46.dp
    val density = LocalDensity.current
    val itemPx = with(density) { itemHeight.toPx() }
    var moving by remember { mutableStateOf(false) }
    var lifting by remember { mutableStateOf(false) }
    var landing by remember { mutableStateOf(false) }
    var activeIndex by remember { mutableStateOf(0) }
    var selectedIndex by remember { mutableStateOf(0) }
    var glassTopPx by remember { mutableStateOf(0f) }
    var glassVelocityY by remember { mutableStateOf(0f) }
    var flightJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    val glassProgress by animateFloatAsState(
        targetValue = if (landing || lifting) 0f else if (moving) 1f else 0f,
        animationSpec = tween(if (landing) 240 else 100, easing = PcEaseOutExpo),
        label = "expandedUtilityGlassMaterial",
    )
    Box(
        Modifier
            .fillMaxWidth()
            .height(itemHeight * actions.size)
            .liquidHoldDragGesture(
                actions.size,
                onCandidateStart = { setSidebarGestureLock("expanded-utility-candidate", true) },
                onCandidateEnd = { setSidebarGestureLock("expanded-utility-candidate", false) },
                onTap = { position ->
                    val target = (position.y / itemPx).toInt().coerceIn(actions.indices)
                    val start = if (moving) glassTopPx else selectedIndex * itemPx
                    flightJob?.cancel()
                    activeIndex = target
                    setSidebarGestureLock("expanded-utility", true)
                    if (!moving) lifting = true
                    moving = true
                    flightJob = scope.launch {
                        glassTopPx = start
                        val targetTop = target * itemPx
                        runOverlappedLiquidFlight(lift = { kotlinx.coroutines.yield(); lifting = false; delay(100) }, move = { if (kotlin.math.abs(start - targetTop) >= 0.5f) animate(start, targetTop, animationSpec = tween(380, easing = PcEaseOutExpo)) { value, velocity -> glassTopPx = value; glassVelocityY = velocity } }, onLandingStarted = { landing = true }, land = { delay(240) })
                        landing = false
                        moving = false
                        selectedIndex = target
                        setSidebarGestureLock("expanded-utility", false)
                        currentActions[target]()
                    }
                },
                onHoldStart = { position ->
                    val target = (position.y / itemPx).toInt().coerceIn(actions.indices)
                    val start = if (moving) glassTopPx else selectedIndex * itemPx
                    flightJob?.cancel()
                    activeIndex = target
                    setSidebarGestureLock("expanded-utility", true)
                    if (!moving) lifting = true
                    moving = true
                    flightJob = scope.launch {
                        glassTopPx = start
                        val targetTop = target * itemPx
                        runOverlappedLiquidFlight(holdKeepsLifted = true, lift = { kotlinx.coroutines.yield(); lifting = false; delay(100) }, move = { animate(start, targetTop, animationSpec = tween(380, easing = PcEaseOutExpo)) { value, velocity -> glassTopPx = value; glassVelocityY = velocity } }, onLandingStarted = {}, land = {})
                    }
                },
                onDrag = { position, delta ->
                    flightJob?.cancel()
                    moving = true
                    lifting = false
                    activeIndex = (position.y / itemPx).toInt().coerceIn(actions.indices)
                    glassTopPx = resistedLiquidBoundaryPosition(
                        raw = position.y - itemPx / 2f,
                        minimum = 0f,
                        maximum = itemPx * (actions.size - 1),
                        maxDisplacement = with(density) { 4.dp.toPx() },
                    )
                    glassVelocityY = delta.y * 60f
                },
                onHoldEnd = { _, _ ->
                    val commit = activeIndex
                    flightJob = scope.launch {
                        lifting = false
                        val targetTop = commit * itemPx
                        runOverlappedLiquidFlight(lift = {}, move = { animate(initialValue = glassTopPx, targetValue = targetTop, animationSpec = tween(120, easing = PcEaseOutExpo)) { value, velocity -> glassTopPx = value; glassVelocityY = velocity } }, onLandingStarted = { landing = true }, land = { delay(240) })
                        landing = false
                        moving = false
                        glassVelocityY = 0f
                        selectedIndex = commit
                        setSidebarGestureLock("expanded-utility", false)
                        currentActions[commit]()
                    }
                },
                onCancel = {
                    moving = false
                    lifting = false
                    landing = false
                    glassVelocityY = 0f
                    setSidebarGestureLock("expanded-utility", false)
                },
            ),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .then(if (moving) Modifier.layerBackdrop(utilityBackdrop) else Modifier),
        ) {
            actions.indices.forEach { index ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .height(itemHeight)
                        .padding(horizontal = 4.dp, vertical = 4.dp)
                        .background(if (!moving && index == selectedIndex) pc.activeSurface else pc.control, RoundedCornerShape(50))
                        .padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(icons[index], labels[index], tint = pc.textDim, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(labels[index], fontSize = 12.5.sp, fontWeight = FontWeight.Medium, color = pc.text)
                }
            }
        }
        if (moving) {
            val expandedTargetInset = 4.dp * (1f - glassProgress)
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(itemHeight)
                    .padding(horizontal = expandedTargetInset, vertical = expandedTargetInset)
                    .graphicsLayer {
                        translationY = glassTopPx
                    }
                    .liquidMotionDeformation(0f, glassVelocityY, density.density)
                    .zIndex(4f)
                    .liquidSelectionMorph(
                        backdrop = utilityBackdrop,
                        shape = RoundedCornerShape(50),
                        fillColor = pc.activeSurface,
                        glassProgress = glassProgress,
                        glassAlpha = 0.06f,
                        blurRadius = 2.dp,
                        refractionHeight = MobileInteractionGlassEdge,
                        refractionAmount = 20.dp,
                    ),
            )
        }
    }
}

@Composable
private fun TerminalButton(rail: Boolean, onClick: () -> Unit) {
    val pc = pcSecondaryPalette()
    Box(Modifier.padding(vertical = 6.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .glassButtonSurface(RoundedCornerShape(50), pc.control)
                .clickable(onClick = onClick)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = if (rail) Arrangement.Center else Arrangement.Start,
        ) {
            Icon(Icons.Filled.Terminal, contentDescription = "命令行", tint = pc.textDim, modifier = Modifier.size(18.dp))
            if (!rail) {
                Spacer(Modifier.width(10.dp))
                Text(
                    text = "命令行",
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.Medium,
                    color = pc.text,
                )
            }
        }
    }
}

@Composable
private fun MemoryLabButton(rail: Boolean, onClick: () -> Unit) {
    val pc = pcSecondaryPalette()
    Box(Modifier.padding(vertical = 6.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .glassButtonSurface(RoundedCornerShape(50), pc.control)
                .clickable(onClick = onClick)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = if (rail) Arrangement.Center else Arrangement.Start,
        ) {
            Icon(Icons.Filled.Psychology, contentDescription = "Memory Lab", tint = pc.textDim, modifier = Modifier.size(18.dp))
            if (!rail) {
                Spacer(Modifier.width(10.dp))
                Text(
                    text = "Memory Lab",
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.Medium,
                    color = pc.text,
                )
            }
        }
    }
}

@Composable
private fun SettingsButton(rail: Boolean, onClick: () -> Unit) {
    val pc = pcSecondaryPalette()
    Box(Modifier.padding(vertical = 6.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .glassButtonSurface(RoundedCornerShape(50), pc.control)
                .clickable(onClick = onClick)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = if (rail) Arrangement.Center else Arrangement.Start,
        ) {
            Icon(
                imageVector = Icons.Filled.Settings,
                contentDescription = "设置",
                tint = pc.textDim,
                modifier = Modifier.size(18.dp),
            )
            if (!rail) {
                Spacer(Modifier.width(10.dp))
                Text(
                    text = "设置",
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.Medium,
                    color = pc.text,
                )
            }
        }
    }
}

// ============ 二级边栏：逐项复刻 PC GUI #left-secondary ============
@Immutable
private data class PcSecondaryPalette(
    val canvas: Color,
    val panel: Color,
    val control: Color,
    val raised: Color,
    val modal: Color,
    val text: Color,
    val textDim: Color,
    val textBright: Color,
    val textAccent: Color,
    val accent: Color,
    val accent2: Color,
    val runtimeWarning: Color,
    val runtimeDanger: Color,
    val border: Color,
    val buttonBorder: Color,
    val border2: Color,
    val borderHover: Color,
    val controlHover: Color,
    val activeSurface: Color,
    val menuShadow: Color,
)

private val PcSecondaryDark = PcSecondaryPalette(
    canvas = Color(0xFF0A0A1A),      // --app-bg
    panel = Color(0xB81A1A38),       // --glass-bg-3: rgb(26 26 56 / .7225)
    control = Color(0xA30A0A1A),     // --glass-bg-1: rgb(10 10 26 / .6375)
    raised = Color(0xAD11112A),      // --glass-bg-2: rgb(17 17 42 / .68)
    modal = Color(0xE611112A),       // --modal-surface: alpha floor .9
    text = Color(0xFFC8D0E8),
    textDim = Color(0xFF7880A0),
    textBright = Color(0xFFE4ECFF),
    textAccent = Color(0xFFA0B8FF),
    accent = Color(0xFF5B78FF),
    accent2 = Color(0xFF38D4A0),
    runtimeWarning = Color(0xFFFFD27A),
    runtimeDanger = Color(0xFFFF9CA6),
    border = Color(0x0FFFFFFF),
    buttonBorder = Color(0x0FFFFFFF),
    border2 = Color(0x14FFFFFF),
    borderHover = Color(0x1FFFFFFF),
    controlHover = Color(0x14FFFFFF),
    activeSurface = Color(0x1A5B78FF),
    menuShadow = Color(0x99000000),
)

private val PcSecondaryLight = PcSecondaryPalette(
    canvas = Color(0xFFF0F2F8),
    panel = Color(0xB8FFFFFF),
    control = Color(0xA3FFFFFF),
    raised = Color(0xADFFFFFF),
    modal = Color(0xC2F8FAFF),
    text = Color(0xFF1A1A2E),
    textDim = Color(0xFF6A7090),
    textBright = Color(0xFF0A0A1A),
    textAccent = Color(0xFF4A68DF),
    accent = Color(0xFF5B78FF),
    accent2 = Color(0xFF38D4A0),
    runtimeWarning = Color(0xFFFFD27A),
    runtimeDanger = Color(0xFFFF9CA6),
    border = Color(0x0F000000),
    buttonBorder = Color(0x14000000),
    border2 = Color(0x14000000),
    borderHover = Color(0x24000000),
    controlHover = Color(0x0E000000),
    activeSurface = Color(0x1A5B78FF),
    menuShadow = Color(0x17000000),
)

@Composable
private fun pcSecondaryPalette(): PcSecondaryPalette {
    val configured = LocalThemeMode.current.dark
    val dark = configured ?: isSystemInDarkTheme()
    return if (dark) PcSecondaryDark else PcSecondaryLight
}

@Composable
internal fun pcSecondarySurfaceColor(): Color {
    val pc = pcSecondaryPalette()
    return pc.panel.compositeOver(pc.canvas)
}

@Composable
fun WorkspaceConversationsSidebar(
    conversations: List<RemoteConversation>,
    activeConversationId: String,
    onBack: () -> Unit,
    onSelectConversation: (String) -> Unit,
    onNewConversation: () -> Unit = {},
    onRenameConversation: (RemoteConversation, String) -> Unit = { _, _ -> },
    onArchiveConversation: (RemoteConversation) -> Unit = {},
    onTogglePinConversation: (RemoteConversation) -> Unit = {},
    onReorderConversations: (List<String>) -> Unit = {},
    archivePendingIds: Set<String> = emptySet(),
    respectStatusBars: Boolean = false,
) {
    val pc = pcSecondaryPalette()
    val surface = pc.panel.compositeOver(pc.canvas)
    val sidebarSurfaceAlpha = if (pc == PcSecondaryLight) 0.90f else 0.72f
    val duplicateTitles = remember(conversations) {
        conversations.groupingBy { it.title.ifBlank { it.id } }.eachCount()
    }
    var renamingConversationId by remember { mutableStateOf<String?>(null) }
    var draggingConversationId by remember { mutableStateOf<String?>(null) }
    var dragPointerY by remember { mutableStateOf(0f) }
    var dragOriginY by remember { mutableStateOf(0f) }
    var dragVelocityY by remember { mutableStateOf(0f) }
    var dragSourceGroupIndex by remember { mutableIntStateOf(-1) }
    var dragDestinationGroupIndex by remember { mutableIntStateOf(-1) }
    var dragItemHeight by remember { mutableStateOf(0f) }
    var glassArrivedConversationId by remember { mutableStateOf<String?>(null) }
    var glassDestinationConversationId by remember { mutableStateOf<String?>(null) }
    var conversationGlassLanding by remember { mutableStateOf(false) }
    var visualActiveConversationId by remember { mutableStateOf(activeConversationId) }
    var flyingConversationGlass by remember { mutableStateOf(false) }
    var flyingGlassX by remember { mutableStateOf(0f) }
    var flyingGlassWidth by remember { mutableStateOf(0f) }
    var flyingGlassHeight by remember { mutableStateOf(0f) }
    val flyingGlassY = remember { Animatable(0f) }
    val flyingGlassLift = remember { Animatable(0f) }
    val flyingGlassScaleX = remember { Animatable(1f) }
    val flyingGlassScaleY = remember { Animatable(1f) }
    val conversationBackdrop = rememberLiquidBackdrop()
    val conversationBounds = remember { mutableStateMapOf<String, Rect>() }
    var conversationHostCoordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    val scope = rememberCoroutineScope()
    var conversationFlightJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    val density = LocalDensity.current
    val setSidebarGestureLock = LocalSidebarGestureLock.current

    fun flyConversationGlass(targetId: String, onArrive: () -> Unit = {}) {
        val target = conversationBounds[targetId]
        val sourceId = glassArrivedConversationId ?: activeConversationId
        val source = sourceId?.let(conversationBounds::get) ?: target
        if (target == null || source == null) return onArrive()
        val redirecting = flyingConversationGlass
        conversationFlightJob?.cancel()
        setSidebarGestureLock("conversation-flight", true)
        flyingGlassX = target.left
        flyingGlassWidth = target.width
        flyingGlassHeight = target.height
        glassDestinationConversationId = targetId
        conversationGlassLanding = false
        conversationFlightJob = scope.launch {
            if (!redirecting) {
                flyingGlassY.snapTo(source.top)
                flyingGlassLift.snapTo(0f)
                flyingGlassScaleX.snapTo(0f)
                flyingGlassScaleY.snapTo(0f)
            }
            flyingConversationGlass = true
            runOverlappedLiquidFlight(
                lift = { coroutineScope { launch { flyingGlassLift.animateTo(1f, tween(100, easing = PcEaseOutExpo)) }; launch { flyingGlassScaleX.animateTo(1f, tween(100, easing = PcEaseOutExpo)) }; launch { flyingGlassScaleY.animateTo(1f, tween(100, easing = PcEaseOutExpo)) } } },
                move = { flyingGlassY.animateTo(target.top, tween(240, easing = PcEaseOutExpo)) },
                onLandingStarted = { conversationGlassLanding = true },
                land = { coroutineScope { launch { flyingGlassLift.animateTo(0f, tween(240, easing = PcEaseOutExpo)) }; launch { flyingGlassScaleX.animateTo(0f, tween(240, easing = PcEaseOutExpo)) }; launch { flyingGlassScaleY.animateTo(0f, tween(240, easing = PcEaseOutExpo)) } } },
            )
            glassArrivedConversationId = targetId
            visualActiveConversationId = targetId
            flyingConversationGlass = false
            conversationGlassLanding = false
            glassDestinationConversationId = null
            setSidebarGestureLock("conversation-flight", false)
            onArrive()
        }
    }

    fun beginConversationDrag(targetId: String) {
        val target = conversationBounds[targetId] ?: return
        conversationFlightJob?.cancel()
        flyingGlassX = target.left
        flyingGlassWidth = target.width
        flyingGlassHeight = target.height
        glassArrivedConversationId = targetId
        glassDestinationConversationId = targetId
        conversationGlassLanding = false
        conversationFlightJob = scope.launch {
            flyingGlassY.snapTo(target.top)
            flyingGlassScaleX.snapTo(0f)
            flyingGlassScaleY.snapTo(0f)
            flyingConversationGlass = true
            runOverlappedLiquidFlight(
                holdKeepsLifted = true,
                lift = { coroutineScope { launch { flyingGlassLift.animateTo(1f, tween(100, easing = PcEaseOutExpo)) }; launch { flyingGlassScaleX.animateTo(1f, tween(100, easing = PcEaseOutExpo)) }; launch { flyingGlassScaleY.animateTo(1f, tween(100, easing = PcEaseOutExpo)) } } },
                move = {}, onLandingStarted = {}, land = {},
            )
        }
    }

    fun clearDrag() {
        conversationFlightJob?.cancel()
        conversationFlightJob = null
        flyingConversationGlass = false
        draggingConversationId = null
        dragPointerY = 0f
        dragOriginY = 0f
        dragVelocityY = 0f
        dragSourceGroupIndex = -1
        dragDestinationGroupIndex = -1
        dragItemHeight = 0f
        glassArrivedConversationId = null
        glassDestinationConversationId = null
        conversationGlassLanding = false
        setSidebarGestureLock("conversation-flight", false)
        setSidebarGestureLock("conversation-reorder", false)
    }

    fun finishDrag(moved: Boolean) {
        val sourceId = draggingConversationId
        if (moved && sourceId != null) {
            val source = conversations.firstOrNull { it.id == sourceId }
            if (source != null) {
                val group = conversations.filter { it.pinned == source.pinned }.map { it.id }.toMutableList()
                val original = group.toList()
                val sourceGroupIndex = dragSourceGroupIndex
                val destinationGroupIndex = dragDestinationGroupIndex
                if (sourceGroupIndex >= 0 && destinationGroupIndex >= 0) {
                    group.removeAt(sourceGroupIndex)
                    group.add(destinationGroupIndex.coerceIn(0, group.size), sourceId)
                    if (group != original) {
                        rebaseConversationBounds(conversationBounds, original, group)
                        onReorderConversations(group)
                    }
                }
            }
        }
        if (sourceId == null) return clearDrag()
        val releasedTop = flyingGlassY.value + dragPointerY - dragOriginY
        conversationFlightJob?.cancel()
        conversationFlightJob = scope.launch {
            flyingGlassY.snapTo(releasedTop)
            draggingConversationId = null
            dragPointerY = 0f
            dragOriginY = 0f
            dragVelocityY = 0f
            dragSourceGroupIndex = -1
            dragDestinationGroupIndex = -1
            dragItemHeight = 0f
            val landingTop = conversationBounds[sourceId]?.top ?: flyingGlassY.value
            runOverlappedLiquidFlight(
                lift = {},
                move = { flyingGlassY.animateTo(landingTop, tween(120, easing = PcEaseOutExpo)) },
                onLandingStarted = { conversationGlassLanding = true },
                land = { coroutineScope { launch { flyingGlassLift.animateTo(0f, tween(240, easing = PcEaseOutExpo)) }; launch { flyingGlassScaleX.animateTo(0f, tween(240, easing = PcEaseOutExpo)) }; launch { flyingGlassScaleY.animateTo(0f, tween(240, easing = PcEaseOutExpo)) } } },
            )
            flyingConversationGlass = false
            conversationGlassLanding = false
            glassArrivedConversationId = sourceId
            setSidebarGestureLock("conversation-flight", false)
            setSidebarGestureLock("conversation-reorder", false)
        }
    }
    LaunchedEffect(conversations.map { it.id }) {
        conversationBounds.keys.toList().filterNot { id -> conversations.any { it.id == id } }
            .forEach(conversationBounds::remove)
        if (draggingConversationId != null && conversations.none { it.id == draggingConversationId }) clearDrag()
    }
    LaunchedEffect(activeConversationId, flyingConversationGlass) {
        if (!flyingConversationGlass) visualActiveConversationId = activeConversationId
    }
    DisposableEffect(Unit) {
        onDispose {
            conversationFlightJob?.cancel()
            setSidebarGestureLock("conversation-flight", false)
            setSidebarGestureLock("conversation-reorder", false)
            setSidebarGestureLock("remote-conversation-candidate", false)
        }
    }
    val glass = LocalGlassMode.current
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(surface.copy(alpha = scaledGlassAlpha(sidebarSurfaceAlpha, glass.alpha)))
            .then(if (respectStatusBars) Modifier.statusBarsPadding() else Modifier)
            .drawBehind {
                val stroke = 1.dp.toPx()
                drawLine(
                    color = pc.border,
                    start = Offset(size.width - stroke / 2f, 0f),
                    end = Offset(size.width - stroke / 2f, size.height),
                    strokeWidth = stroke,
                )
            },
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 10.dp, top = 10.dp, end = 10.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // 移动端二级栏不提供远程工作区设置入口；保留 PC 同源的新对话
            // 主操作，并让它占满原设置位，避免顶部留下不对称的空槽。
            PcSecondaryButton(
                modifier = Modifier.weight(1f),
                icon = LucideIcons.MessageSquare,
                label = "新对话",
                contentDescription = "新对话",
                primary = true,
                palette = pc,
                onClick = onNewConversation,
            )
            Spacer(Modifier.width(6.dp))
            PcSecondaryButton(
                modifier = Modifier.width(32.dp),
                icon = LucideIcons.ChevronLeft,
                contentDescription = "收起二级边栏",
                palette = pc,
                onClick = onBack,
            )
        }

        Box(
            Modifier
                .fillMaxSize()
                .onGloballyPositioned { conversationHostCoordinates = it },
        ) {
        val sourceIndex = conversations.indexOfFirst { it.id == draggingConversationId }
        val previewHeight = draggingConversationId?.let(conversationBounds::get)?.height ?: 0f
        val sourcePinned = draggingConversationId
            ?.let { id -> conversations.firstOrNull { it.id == id } }
            ?.pinned
        val groupIndices = if (sourcePinned == null) emptyList() else {
            conversations.indices.filter { conversations[it].pinned == sourcePinned }
        }
        val sourceGroupIndex = dragSourceGroupIndex
        val destinationGroupIndex = dragDestinationGroupIndex
        val destinationIndex = groupIndices.getOrElse(destinationGroupIndex) { sourceIndex }
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 8.dp, vertical = 4.dp)
                .then(
                    if (flyingConversationGlass) Modifier.layerBackdrop(conversationBackdrop)
                    else Modifier,
                ),
        ) {
            itemsIndexed(conversations, key = { _, item -> item.id }) { itemIndex, conv ->
                val baseSummary = conv.title.ifBlank { conv.id }
                val displaySummary = if ((duplicateTitles[baseSummary] ?: 0) > 1) {
                    "$baseSummary · ${conv.id.takeLast(8)}"
                } else {
                    baseSummary
                }
                PcRemoteConversationRow(
                    modifier = Modifier.animateItem(
                        fadeInSpec = tween(160, easing = PcEaseOutExpo),
                        placementSpec = tween(260, easing = PcEaseOutExpo),
                        fadeOutSpec = tween(180, easing = PcEaseOutExpo),
                    ).onGloballyPositioned { coordinates ->
                        conversationBounds[conv.id] = conversationHostCoordinates
                            ?.localBoundingBoxOf(coordinates, clipBounds = false)
                            ?: coordinates.boundsInParent()
                    },
                    conversation = conv,
                    displaySummary = displaySummary,
                    active = !flyingConversationGlass && conv.id == visualActiveConversationId,
                    reordering = draggingConversationId != null,
                    glassCovered = flyingConversationGlass && !conversationGlassLanding &&
                        (conv.id == glassArrivedConversationId || conv.id == glassDestinationConversationId),
                    palette = pc,
                    onClick = { flyConversationGlass(conv.id) { onSelectConversation(conv.id) } },
                    onRename = { title -> onRenameConversation(conv, title) },
                    renaming = renamingConversationId == conv.id,
                    onBeginRename = { renamingConversationId = conv.id },
                    onEndRename = { renamingConversationId = null },
                    onArchive = { onArchiveConversation(conv) },
                    onTogglePin = { onTogglePinConversation(conv) },
                    archiving = conv.id in archivePendingIds,
                    dragging = draggingConversationId == conv.id,
                    lifted = draggingConversationId == conv.id,
                    dragTranslationY = if (draggingConversationId == conv.id) {
                        dragPointerY - dragOriginY
                    } else 0f,
                    dragVelocityY = if (draggingConversationId == conv.id) dragVelocityY else 0f,
                    previewTranslationY = conversationPreviewShift(
                        itemIndex = itemIndex,
                        sourceIndex = sourceIndex,
                        destinationIndex = destinationIndex,
                        itemHeightPx = previewHeight,
                    ),
                    onDragStart = {
                        if (renamingConversationId == null && conversationBounds[conv.id] != null && conversations.any { it.id == conv.id }) {
                            draggingConversationId = conv.id
                            dragPointerY = conversationBounds[conv.id]?.center?.y ?: 0f
                            dragOriginY = dragPointerY
                            val sourcePinned = conversations.firstOrNull { it.id == conv.id }?.pinned
                            val group = conversations.filter { it.pinned == sourcePinned }
                            dragSourceGroupIndex = group.indexOfFirst { it.id == conv.id }
                            dragDestinationGroupIndex = dragSourceGroupIndex
                            dragItemHeight = conversationBounds[conv.id]?.height ?: 0f
                            setSidebarGestureLock("conversation-reorder", true)
                            beginConversationDrag(conv.id)
                        }
                    },
                    onDragDelta = { deltaY ->
                        if (draggingConversationId == conv.id) {
                            val sourcePinned = conversations.firstOrNull { it.id == conv.id }?.pinned
                            val groupSize = conversations.count { it.pinned == sourcePinned }
                            val previousPointerY = dragPointerY
                            val nextPointerY = clampConversationDragDelta(
                                sourceIndex = dragSourceGroupIndex,
                                pointerDeltaY = dragPointerY + deltaY - dragOriginY,
                                itemHeightPx = dragItemHeight,
                                itemCount = groupSize,
                            ) + dragOriginY
                            dragPointerY = nextPointerY
                            dragVelocityY = (nextPointerY - previousPointerY) * 60f
                            dragDestinationGroupIndex = conversationDragDestinationIndex(
                                sourceIndex = dragSourceGroupIndex,
                                pointerDeltaY = nextPointerY - dragOriginY,
                                itemHeightPx = dragItemHeight,
                                itemCount = groupSize,
                            )
                        }
                    },
                    onDragEnd = ::finishDrag,
                    onDragCancel = ::clearDrag,
                )
            }
        }
        if (flyingConversationGlass) {
            val edgePx = with(density) { MobileInteractionGlassEdge.toPx() }
            val horizontalEdgePx = with(density) { MobileConversationGlassHorizontalEdge.toPx() }
            val travelCenterCorrectionPx = with(density) { 2.dp.toPx() } * flyingGlassLift.value
            Box(
                Modifier
                    .requiredWidth(with(density) { (flyingGlassWidth + horizontalEdgePx * 2f * flyingGlassScaleX.value).toDp() })
                    .requiredHeight(with(density) { (flyingGlassHeight + edgePx * 2f * flyingGlassScaleY.value).toDp() })
                    .graphicsLayer {
                        translationX = flyingGlassX - horizontalEdgePx * flyingGlassScaleX.value +
                            travelCenterCorrectionPx
                        translationY = flyingGlassY.value - edgePx * flyingGlassScaleY.value +
                            if (draggingConversationId == glassArrivedConversationId) dragPointerY - dragOriginY else 0f
                    }
                    .liquidMotionDeformation(
                        velocityX = 0f,
                        velocityY = if (draggingConversationId != null) dragVelocityY else flyingGlassY.velocity,
                        density = density.density,
                    )
                    .zIndex(8f)
                    .liquidSelectionMorph(
                        backdrop = conversationBackdrop,
                        shape = RoundedCornerShape(50),
                        fillColor = pc.activeSurface,
                        glassProgress = flyingGlassLift.value,
                        glassAlpha = 0.08f,
                        blurRadius = 2.dp,
                        refractionHeight = MobileInteractionGlassEdge,
                        refractionAmount = 20.dp,
                    ),
            )
        }
        }
    }
}

@Composable
private fun PcSecondaryButton(
    icon: ImageVector,
    contentDescription: String,
    palette: PcSecondaryPalette,
    modifier: Modifier = Modifier,
    label: String = "",
    primary: Boolean = false,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 1.04f else 1f,
        animationSpec = tween(durationMillis = 80),
        label = "secondaryButtonScale",
    )
    val shape = RoundedCornerShape(50)
    val background = if (primary) palette.accent else palette.control
    val border = if (primary) palette.accent else palette.buttonBorder
    val tint = if (primary) Color.White else palette.text
    Box(
        modifier = modifier
            .height(30.dp)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .glassButtonSurface(shape, background)
            .border(1.dp, border, shape)
            .clip(shape)
            .clickable(
                interactionSource = interaction,
                indication = androidx.compose.foundation.LocalIndication.current,
                onClick = onClick,
            )
            .padding(horizontal = if (label.isBlank()) 8.dp else 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = contentDescription,
                tint = tint,
                modifier = Modifier.size(14.dp),
            )
            if (label.isNotBlank()) {
                Spacer(Modifier.width(6.dp))
                Text(
                    text = label,
                    color = tint,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Normal,
                    maxLines = 1,
                )
            }
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun PcRemoteConversationRow(
    modifier: Modifier = Modifier,
    conversation: RemoteConversation,
    displaySummary: String,
    active: Boolean,
    reordering: Boolean,
    glassCovered: Boolean,
    palette: PcSecondaryPalette,
    onClick: () -> Unit,
    onRename: (String) -> Unit,
    renaming: Boolean,
    onBeginRename: () -> Unit,
    onEndRename: () -> Unit,
    onArchive: () -> Unit,
    onTogglePin: () -> Unit,
    archiving: Boolean,
    dragging: Boolean,
    lifted: Boolean,
    dragTranslationY: Float,
    dragVelocityY: Float,
    previewTranslationY: Float,
    onDragStart: () -> Unit,
    onDragDelta: (Float) -> Unit,
    onDragEnd: (Boolean) -> Unit,
    onDragCancel: () -> Unit,
) {
    var showMenu by remember { mutableStateOf(false) }
    var menuTrigger by remember { mutableStateOf(ConversationMenuTrigger.MoreButton) }
    var archivingOut by remember { mutableStateOf(false) }
    val archiveProgress = remember { Animatable(1f) }
    val scope = rememberCoroutineScope()
    fun archiveConversationAfterExit() {
        if (archivingOut || archiving) return
        archivingOut = true
        showMenu = false
        scope.launch {
            delay(170)
            archiveProgress.animateTo(0f, tween(220, easing = PcEaseOutExpo))
            onArchive()
        }
    }
    val setSidebarGestureLock = LocalSidebarGestureLock.current
    val density = LocalDensity.current
    val interaction = remember { MutableInteractionSource() }
    val shape = RoundedCornerShape(50)
    val previewTranslation by animateFloatAsState(
        targetValue = previewTranslationY,
        animationSpec = tween(180, easing = PcEaseOutExpo),
        label = "remoteConversationDropPreview",
    )
    val runtimeStatus = conversation.runtimeStatus.orEmpty().ifBlank {
        if (conversation.running) "running" else ""
    }
    val row: @Composable () -> Unit = {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(
                    when {
                        lifted || glassCovered -> Color.Transparent
                        active && !reordering -> palette.activeSurface
                        else -> palette.control
                    },
                )
                .alpha(if (dragging && !lifted) 0.72f else 1f)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (renaming) {
                PcConversationRenameInput(
                    initialTitle = conversation.title,
                    palette = palette,
                    onSave = onRename,
                    onFinish = onEndRename,
                    modifier = Modifier.weight(1f),
                )
            } else {
                Text(
                    text = displaySummary,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Normal,
                    color = palette.textDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .weight(1f)
                        .liquidHoldDragGesture(
                            conversation.id,
                            renaming,
                            onCandidateStart = { setSidebarGestureLock("remote-conversation-candidate", true) },
                            onCandidateEnd = { setSidebarGestureLock("remote-conversation-candidate", false) },
                            onTap = { if (!renaming) onClick() },
                            onHoldStart = { if (!renaming) onDragStart() },
                            onDrag = { _, delta -> if (!renaming) onDragDelta(delta.y) },
                            onHoldEnd = { _, moved ->
                                if (!renaming) {
                                    onDragEnd(moved)
                                    if (!moved) {
                                        menuTrigger = ConversationMenuTrigger.LongPress
                                        showMenu = true
                                    }
                                }
                            },
                            onCancel = { if (!renaming) onDragCancel() },
                        ),
                )
            }
            if (conversation.branchCommunication) {
                Spacer(Modifier.width(6.dp))
                Box(
                    modifier = Modifier
                        .size(20.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .border(1.dp, palette.buttonBorder, RoundedCornerShape(6.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = LucideIcons.GitBranch,
                        contentDescription = "允许分支交流",
                        tint = palette.accent,
                        modifier = Modifier.size(11.dp),
                    )
                }
            }
            if (runtimeStatus.isNotBlank()) {
                Spacer(Modifier.width(6.dp))
                Text(
                    text = runtimeStatus,
                    color = when (runtimeStatus) {
                        "running" -> palette.accent2
                        "stopping", "force_restarting" -> palette.runtimeWarning
                        "error", "force_interrupted" -> palette.runtimeDanger
                        else -> palette.textDim
                    },
                    fontSize = 9.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .widthIn(max = 92.dp)
                        .clip(CircleShape)
                        .background(palette.raised)
                        .padding(horizontal = 5.dp, vertical = 2.dp),
                )
            }
            Spacer(Modifier.width(6.dp))
            Box(
                modifier = Modifier.size(20.dp),
                contentAlignment = Alignment.Center,
            ) {
                val moreInteraction = remember { MutableInteractionSource() }
                Box(
                    modifier = Modifier
                        .size(20.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(if (showMenu) palette.controlHover else Color.Transparent)
                        .clickable(
                            interactionSource = moreInteraction,
                            indication = androidx.compose.foundation.LocalIndication.current,
                            onClick = {
                                menuTrigger = ConversationMenuTrigger.MoreButton
                                showMenu = true
                            },
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = LucideIcons.Ellipsis,
                        contentDescription = "更多",
                        tint = if (showMenu) palette.textBright else palette.textDim,
                        modifier = Modifier.size(14.dp),
                    )
                }
                PcConversationActionMenu(
                    expanded = showMenu,
                    pinned = conversation.pinned,
                    archiving = archiving,
                    palette = palette,
                    transformOrigin = if (menuTrigger == ConversationMenuTrigger.MoreButton) TransformOrigin(1f, 0f) else TransformOrigin.Center,
                    onDismiss = { showMenu = false },
                    onRename = {
                        showMenu = false
                        onBeginRename()
                    },
                    onArchive = ::archiveConversationAfterExit,
                    onTogglePin = { showMenu = false; onTogglePin() },
                )
            }
        }
    }
    Box(
        modifier = modifier
            .graphicsLayer {
                translationY = dragTranslationY + previewTranslation
                alpha = archiveProgress.value
                scaleX = 0.96f + 0.04f * archiveProgress.value
                scaleY = 0.96f + 0.04f * archiveProgress.value
            }
            .zIndex(if (dragging) 6f else 0f)
            .fillMaxWidth()
            .padding(vertical = 2.dp),
    ) {
        row()
    }
}

internal fun conversationDropIndex(
    sourceIndex: Int,
    targetIndex: Int,
    insertAfter: Boolean,
    itemCount: Int,
): Int {
    if (sourceIndex !in 0 until itemCount || targetIndex !in 0 until itemCount) return sourceIndex
    val targetAfterRemoval = targetIndex - if (sourceIndex < targetIndex) 1 else 0
    return (targetAfterRemoval + if (insertAfter) 1 else 0).coerceIn(0, itemCount - 1)
}

internal fun conversationDragDestinationIndex(
    sourceIndex: Int,
    pointerDeltaY: Float,
    itemHeightPx: Float,
    itemCount: Int,
): Int {
    if (sourceIndex !in 0 until itemCount || itemHeightPx <= 0f) return sourceIndex
    val slotDelta = kotlin.math.round(pointerDeltaY / itemHeightPx).toInt()
    return (sourceIndex + slotDelta).coerceIn(0, itemCount - 1)
}

internal fun clampConversationDragDelta(
    sourceIndex: Int,
    pointerDeltaY: Float,
    itemHeightPx: Float,
    itemCount: Int,
): Float {
    if (sourceIndex !in 0 until itemCount || itemHeightPx <= 0f) return 0f
    val minimum = -(sourceIndex + 1) * itemHeightPx
    val maximum = (itemCount - sourceIndex) * itemHeightPx
    return resistedLiquidBoundaryPosition(
        raw = pointerDeltaY,
        minimum = minimum,
        maximum = maximum,
        maxDisplacement = itemHeightPx * 0.085f,
    )
}

internal fun rebaseConversationBounds(
    bounds: MutableMap<String, Rect>,
    previousOrder: List<String>,
    nextOrder: List<String>,
) {
    if (previousOrder.size != nextOrder.size || previousOrder.toSet() != nextOrder.toSet()) return
    val slots = previousOrder.map { bounds[it] ?: return }
    nextOrder.forEachIndexed { index, id -> bounds[id] = slots[index] }
}

internal fun conversationPreviewShift(
    itemIndex: Int,
    sourceIndex: Int,
    destinationIndex: Int,
    itemHeightPx: Float,
): Float = when {
    itemIndex == sourceIndex || itemHeightPx <= 0f -> 0f
    destinationIndex > sourceIndex && itemIndex in (sourceIndex + 1)..destinationIndex -> -itemHeightPx
    destinationIndex < sourceIndex && itemIndex in destinationIndex until sourceIndex -> itemHeightPx
    else -> 0f
}

@Composable
private fun PcConversationRenameInput(
    initialTitle: String,
    palette: PcSecondaryPalette,
    onSave: (String) -> Unit,
    onFinish: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    var value by remember(initialTitle) {
        mutableStateOf(
            TextFieldValue(
                text = initialTitle,
                selection = TextRange(0, initialTitle.length),
            ),
        )
    }
    var settled by remember { mutableStateOf(false) }
    var receivedFocus by remember { mutableStateOf(false) }

    fun finish(save: Boolean) {
        if (settled) return
        settled = true
        keyboard?.hide()
        val normalized = value.text.replace(Regex("\\s+"), " ").trim().take(80)
        if (save && normalized.isNotBlank() && normalized != initialTitle) onSave(normalized)
        onFinish()
    }

    LaunchedEffect(Unit) {
        focusRequester.requestFocus()
        keyboard?.show()
    }

    BasicTextField(
        value = value,
        onValueChange = { next ->
            value = next
        },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { finish(save = true) }),
        textStyle = TextStyle(
            color = palette.text,
            fontSize = 11.sp,
            fontWeight = FontWeight.Normal,
        ),
        modifier = modifier
            .height(24.dp)
            .focusRequester(focusRequester)
            .onFocusChanged { state ->
                if (state.isFocused) receivedFocus = true
                else if (receivedFocus) finish(save = true)
            }
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when {
                    event.key == Key.Escape -> {
                        finish(save = false)
                        true
                    }
                    event.key == Key.Enter || event.key == Key.NumPadEnter -> {
                        finish(save = true)
                        true
                    }
                    else -> false
                }
            }
            .drawBehind {
                drawRoundRect(
                    color = palette.accent.copy(alpha = 0.2f),
                    topLeft = Offset(-3.dp.toPx(), -3.dp.toPx()),
                    size = androidx.compose.ui.geometry.Size(
                        width = size.width + 6.dp.toPx(),
                        height = size.height + 6.dp.toPx(),
                    ),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(9.dp.toPx()),
                    style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3.dp.toPx()),
                )
            }
            .clip(RoundedCornerShape(6.dp))
            .background(palette.raised)
            .border(1.dp, palette.accent, RoundedCornerShape(6.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
private fun PcConversationActionMenu(
    expanded: Boolean,
    pinned: Boolean,
    archiving: Boolean,
    palette: PcSecondaryPalette,
    transformOrigin: TransformOrigin,
    onDismiss: () -> Unit,
    onRename: () -> Unit,
    onArchive: () -> Unit,
    onTogglePin: () -> Unit,
) {
    val shape = RoundedCornerShape(16.dp)
    AnchorMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        modifier = Modifier
            .width(168.dp)
            .shadow(
                elevation = 16.dp,
                shape = shape,
                ambientColor = palette.menuShadow,
                spotColor = palette.menuShadow,
            ),
        placement = MenuPlacement.DownEnd,
        gap = 8.dp,
        viewportMargin = 8.dp,
        shape = shape,
        backgroundColor = palette.modal,
        borderColor = palette.border2,
        contentPadding = 6.dp,
        transformOrigin = transformOrigin,
    ) {
        PcConversationActionMenuItem(
            icon = LucideIcons.Pencil,
            text = "编辑对话名称",
            palette = palette,
            onClick = onRename,
        )
        if (archiving) {
            PcConversationActionMenuItem(
                icon = null,
                text = "归档中…",
                enabled = false,
                loading = true,
                palette = palette,
                onClick = {},
            )
        } else {
            PcConversationActionMenuItem(
                icon = LucideIcons.Archive,
                text = "归档",
                palette = palette,
                onClick = onArchive,
            )
        }
        PcConversationActionMenuItem(
            icon = LucideIcons.Pin,
            text = if (pinned) "取消置顶" else "置顶对话",
            active = pinned,
            palette = palette,
            onClick = onTogglePin,
        )
    }
}

@Composable
private fun PcConversationActionMenuItem(
    icon: ImageVector?,
    text: String,
    palette: PcSecondaryPalette,
    active: Boolean = false,
    enabled: Boolean = true,
    loading: Boolean = false,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val shape = RoundedCornerShape(50)
    val pressGlass = if (pressed) {
        Modifier.liquidGlassModifier(
            shape = shape,
            alpha = 0.06f,
            blurRadius = 2.dp,
            refractionHeight = MobileInteractionGlassEdge,
            refractionAmount = 20.dp,
            surfaceColor = Color.Transparent,
            ambientHighlight = true,
        )
    } else Modifier
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 32.dp)
            .alpha(if (enabled) 1f else 0.55f)
            .then(pressGlass)
            .clip(shape)
            .clickable(
                interactionSource = interaction,
                indication = androidx.compose.foundation.LocalIndication.current,
                enabled = enabled,
                onClick = onClick,
            )
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val color = if (active) palette.textAccent else palette.text
        if (loading) {
            PcArchiveSpinner(
                trackColor = palette.border,
                accentColor = palette.accent,
            )
        } else if (icon != null) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = if (active) palette.textAccent else palette.textDim,
                modifier = Modifier.size(14.dp),
            )
        }
        Spacer(Modifier.width(8.dp))
        Text(
            text = text,
            fontSize = 12.sp,
            fontWeight = FontWeight.Normal,
            color = color,
            maxLines = 1,
        )
    }
}

@Composable
private fun PcArchiveSpinner(
    trackColor: Color,
    accentColor: Color,
) {
    val transition = androidx.compose.animation.core.rememberInfiniteTransition(label = "archiveSpinner")
    val rotation by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = androidx.compose.animation.core.infiniteRepeatable(
            animation = tween(durationMillis = 700, easing = androidx.compose.animation.core.LinearEasing),
            repeatMode = androidx.compose.animation.core.RepeatMode.Restart,
        ),
        label = "archiveSpinnerRotation",
    )
    androidx.compose.foundation.Canvas(
        modifier = Modifier
            .size(11.dp)
            .graphicsLayer { rotationZ = rotation },
    ) {
        val stroke = 2.dp.toPx()
        val inset = stroke / 2f
        val diameter = size.minDimension - stroke
        drawArc(
            color = trackColor,
            startAngle = 0f,
            sweepAngle = 360f,
            useCenter = false,
            topLeft = Offset(inset, inset),
            size = androidx.compose.ui.geometry.Size(diameter, diameter),
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke),
        )
        drawArc(
            color = accentColor,
            startAngle = -90f,
            sweepAngle = 86f,
            useCenter = false,
            topLeft = Offset(inset, inset),
            size = androidx.compose.ui.geometry.Size(diameter, diameter),
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke, cap = StrokeCap.Butt),
        )
    }
}

@Composable
private fun SmallActionButton(label: String, accent: Boolean = false, onClick: () -> Unit = {}) {
    val p = LocalNewmarkColors.current
    Box(
        modifier = Modifier
            .glassButtonSurface(NewmarkShapeMedium, if (accent) p.accentSoft else p.bgQuaternary)
            .clickable(onClick = onClick)
            .padding(horizontal = 9.dp, vertical = 6.dp),
    ) {
        Text(
            text = label,
            fontSize = 11.5.sp,
            fontWeight = FontWeight.Medium,
            color = if (accent) p.accent else p.textPrimary,
            maxLines = 1,
        )
    }
}
