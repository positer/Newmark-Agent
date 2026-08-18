package com.newmark.mobile.ui

import android.content.ClipData
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.CubicBezierEasing
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
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.newmark.mobile.data.LocalWorkEvent
import com.newmark.mobile.data.LocalWorkRun
import com.newmark.mobile.data.ModelOption
import com.newmark.mobile.data.RemoteConversation
import com.newmark.mobile.data.WorkDisplayImage
import com.newmark.mobile.data.WorkConversationImage
import com.newmark.mobile.data.WorkGuide
import com.newmark.mobile.data.RemoteSubagent
import com.newmark.mobile.data.RemoteWorkRun
import com.newmark.mobile.data.ThemeStore
import com.newmark.mobile.data.WorkspaceInfo
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.LocalThemeMode
import com.newmark.mobile.ui.theme.NewmarkBgPrimary
import com.newmark.mobile.ui.theme.NewmarkBgSecondary
import com.newmark.mobile.ui.theme.NewmarkScrim
import com.newmark.mobile.ui.theme.NewmarkTheme
import com.newmark.mobile.ui.theme.ThemeMode
import com.newmark.mobile.vm.ChatViewModel
import com.newmark.mobile.vm.DesktopLinkViewModel
import com.newmark.mobile.vm.LinkStatus
import kotlinx.coroutines.launch
import kotlinx.coroutines.android.awaitFrame
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val LocalTimeFmt = DateTimeFormatter.ofPattern("HH:mm:ss")
private val PcEaseOutExpo = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)

private fun formatLocalTime(ms: Long): String =
    runCatching { LocalTimeFmt.format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault())) }
        .getOrDefault("")

/** ISO 时间 → epoch ms（PC 事件时间戳） */
private fun parseIsoMs(iso: String): Long =
    runCatching { Instant.parse(iso).toEpochMilli() }.getOrDefault(0L)

/** 桌面端 work run → 本地渲染结构（事件 durationMs 按相邻事件时间差计算） */
private fun remoteRunToLocal(run: RemoteWorkRun): LocalWorkRun {
    val times = run.events.map { parseIsoMs(it.timestamp) }
    val events = run.events.mapIndexed { i, e ->
        LocalWorkEvent(
            type = e.type,
            id = e.id,
            content = e.content,
            mode = e.mode,
            model = e.model,
            toolCallId = e.toolCallId,
            toolName = e.toolName,
            toolArgs = e.toolArgs,
            timestamp = times[i],
            timestampText = e.timestamp,
            sequence = e.sequence,
            status = e.status,
            clientMessageId = e.clientMessageId,
            guideId = e.guideId,
            guide = e.guide?.let { guide ->
                WorkGuide(
                    clientMessageId = guide.clientMessageId,
                    guideId = guide.guideId,
                    runId = guide.runId,
                    status = guide.status,
                    content = guide.content,
                    createdAt = guide.createdAt,
                    updatedAt = guide.updatedAt,
                    appliedAt = guide.appliedAt,
                    reason = guide.reason,
                    attachments = guide.attachments.map { attachment ->
                        WorkConversationImage(
                            id = attachment.id,
                            origin = attachment.origin,
                            name = attachment.name,
                            mimeType = attachment.mimeType,
                            dataUrl = attachment.dataUrl,
                            width = attachment.width,
                            height = attachment.height,
                        )
                    },
                )
            },
            displayImage = e.displayImage?.let { image ->
                WorkDisplayImage(
                    id = image.id,
                    origin = image.origin,
                    name = image.name,
                    caption = image.caption,
                    mimeType = image.mimeType,
                    dataUrl = image.dataUrl,
                    width = image.width,
                    height = image.height,
                )
            },
            durationMs = if (i + 1 < times.size) maxOf(0L, times[i + 1] - times[i]) else 0L,
        )
    }
    val guideEvents = run.guides.mapIndexed { i, guide ->
        LocalWorkEvent(
            type = "guide_${guide.status.ifBlank { "accepted" }}",
            id = "guide:${guide.clientMessageId.ifBlank { guide.guideId }}",
            content = guide.content,
            timestamp = parseIsoMs(guide.updatedAt.ifBlank { guide.createdAt }),
            timestampText = guide.updatedAt.ifBlank { guide.createdAt },
            sequence = Long.MAX_VALUE / 2 + i,
            status = guide.status,
            clientMessageId = guide.clientMessageId,
            guideId = guide.guideId,
            guide = WorkGuide(
                clientMessageId = guide.clientMessageId,
                guideId = guide.guideId,
                runId = guide.runId,
                status = guide.status,
                content = guide.content,
                createdAt = guide.createdAt,
                updatedAt = guide.updatedAt,
                appliedAt = guide.appliedAt,
                reason = guide.reason,
                attachments = guide.attachments.map { attachment ->
                    WorkConversationImage(
                        id = attachment.id,
                        origin = attachment.origin,
                        name = attachment.name,
                        mimeType = attachment.mimeType,
                        dataUrl = attachment.dataUrl,
                        width = attachment.width,
                        height = attachment.height,
                    )
                },
            ),
        )
    }
    val startedAt = parseIsoMs(run.startedAt)
    val endedAt = if (run.endedAt.isNotBlank()) parseIsoMs(run.endedAt) else startedAt
    return LocalWorkRun(
        runId = run.runId,
        status = run.status,
        startedAt = startedAt,
        endedAt = endedAt,
        expanded = run.expanded,
        events = events + guideEvents,
        text = run.events.lastOrNull { it.type == "response" || it.type == "final_response" }?.content ?: "",
    )
}

private enum class Screen { Main, Settings, MemoryLab, Terminal }

/** 自适应根布局：主题（亮暗色开关） + 竖屏 drawer / 平板 rail↔full，绑定本地对话 + 桌面端同步 */
@Composable
fun NewmarkApp(initialPairUrl: String? = null) {
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
            NewmarkAppContent(initialPairUrl = initialPairUrl)
        }
    }
}

@Composable
private fun NewmarkAppContent(initialPairUrl: String?) {
    val p = LocalNewmarkPalette.current
    val secondarySurface = pcSecondarySurfaceColor()
    val context = LocalContext.current
    val vm: ChatViewModel = viewModel()
    val linkVm: DesktopLinkViewModel = viewModel()

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
    var rightSidebarDragProgress by remember { mutableStateOf(0f) }
    var rightSidebarTab by remember { mutableStateOf(RightSidebarTab.Files) }
    val browserSessions = remember { BrowserSessionRegistry() }
    var compactSubagent by remember { mutableStateOf<RemoteSubagent?>(null) }

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

    // 配对后按连接状态展示远程对话 / 重连中 / 断开；新建对话时切回本地
    var preferLocal by remember { mutableStateOf(false) }
    val useRemote = !preferLocal && linkVm.pairInfo != null &&
        (linkVm.linkStatus == LinkStatus.Connected || linkVm.linkStatus == LinkStatus.Reconnecting)
    val browserTargetKey = if (useRemote) {
        "remote:${linkVm.selectedConversationWorkspaceId.orEmpty()}:${linkVm.selectedConversationId.orEmpty()}"
    } else {
        "local:${vm.currentId.orEmpty()}"
    }
    val browserSession = browserSessions.session(browserTargetKey)
    val selectedRightSidebarTab = when {
        useRemote -> rightSidebarTab
        rightSidebarTab in listOf(RightSidebarTab.Plan, RightSidebarTab.Browser) -> rightSidebarTab
        else -> RightSidebarTab.Plan
    }
    val displayItems by remember(
        useRemote,
        linkVm.remoteMessages,
        linkVm.remoteWorkRuns,
        linkVm.remoteBranchGroups,
        linkVm.remoteWindowStart,
        linkVm.liveRun,
        vm.currentMessages,
        vm.currentBranchPagers,
    ) {
        derivedStateOf {
            if (useRemote) {
        // 完全依照 PC 渲染语义：work run 块锚定在对应 user 消息（anchorMessageId→messageId）之后；
        // 无锚或失锚的 run 按开始时间排在消息尾部；SSE 实时 run 追加在最后。
        // 每条 item 注入唯一 keyHint（PC messageId / runId），防止同秒同内容消息 key 碰撞。
        val runsByAnchor = linkVm.remoteWorkRuns.groupBy { it.anchorMessageId }
        val matchedRunIds = mutableSetOf<String>()
        val remoteRunsById = linkVm.remoteWorkRuns.associateBy { it.runId }
        val visibleRunMessages = linkVm.remoteMessages
            .filter { it.runId.isNotBlank() && it.runId in remoteRunsById && it.clientMessageId.isBlank() && !isHiddenWorkflowMessage(it) }
        val runMessageRoles = visibleRunMessages
            .groupBy { it.runId }
            .mapValues { (_, messages) -> messages.map { it.role }.toSet() }
        val items = mutableListOf<ChatItem>()
        val remotePagersByIndex = linkVm.remoteBranchGroups.mapNotNull { group ->
            val visibleMessageIndex = group.sourceMessageIndex - linkVm.remoteWindowStart
            if (group.branches.size < 2 || visibleMessageIndex < 0 || visibleMessageIndex >= linkVm.remoteMessages.size) {
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
        linkVm.remoteMessages.forEachIndexed { idx, m ->
            // Desktop keeps Guide lifecycle within the WorkRun; the matching
            // chat row is intentionally not emitted a second time.
            if (m.clientMessageId.isNotBlank() && m.runId in remoteRunsById) return@forEachIndexed
            if (isHiddenWorkflowMessage(m) || (m.role == "workflow" && m.mode.startsWith("tool:"))) return@forEachIndexed
            val associatedRun = remoteRunsById[m.runId]
            if (associatedRun != null && m.role == "assistant" && m.runId !in matchedRunIds) {
                matchedRunIds += m.runId
                items += remoteRunItems(
                    associatedRun,
                    runMessageRoles[m.runId].orEmpty(),
                    keyPrefix = "run",
                )
            }
            items += ChatItem.Bubble(
                role = m.role, content = m.content, mode = m.mode, model = m.model, timestamp = m.timestamp,
                keyHint = m.id.ifBlank { "m:$idx" },
                messageId = m.id,
                messageIndex = idx,
                attachments = m.attachments,
                branchPager = remotePagersByIndex[idx],
            )
            if (associatedRun != null && m.role == "user" && m.runId !in matchedRunIds) {
                matchedRunIds += m.runId
                items += remoteRunItems(
                    associatedRun,
                    runMessageRoles[m.runId].orEmpty(),
                    keyPrefix = "run",
                )
            }
            runsByAnchor[m.id]?.sortedBy { it.startedAt }?.forEach { run ->
                if (run.runId !in matchedRunIds) {
                    matchedRunIds += run.runId
                    items += remoteRunItems(run, runMessageRoles[run.runId].orEmpty(), keyPrefix = "run")
                }
            }
        }
        items += linkVm.remoteWorkRuns
            .filter { it.runId !in matchedRunIds }
            .sortedBy { it.startedAt }
            .flatMap { run -> remoteRunItems(run, runMessageRoles[run.runId].orEmpty(), keyPrefix = "run") }
        // 持久化 WorkRun 已包含完整公开事件；send 回执 token 不再另起简化
        // WorkBlock，避免重复或只留下工具调用片段。
        linkVm.liveRun?.let { run ->
            items += ChatItem.Bubble(
                role = "assistant",
                content = "",
                timestamp = "",
                workRun = remoteRunToLocal(run),
                keyHint = "live:${run.runId}",
            )
        }
                items
            } else {
                val localPagersByMessageId = vm.currentBranchPagers.associateBy { it.sourceMessageId }
                vm.currentMessages.mapIndexed { idx, m ->
                    val pager = localPagersByMessageId[m.messageId]
                    ChatItem.Bubble(
                        role = m.role, content = m.content, timestamp = formatLocalTime(m.timestamp), workRun = m.workRun,
                        keyHint = m.messageId.ifBlank { "l:$idx:${m.timestamp}" },
                        messageId = m.messageId,
                        messageIndex = idx,
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
                }
            }
        }
    }
    val sending = if (useRemote) linkVm.isSending else vm.isSending
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
    // 本地模型选择：所有启用模型候选 + 当前模型名 + 智能档位；远程由桌面端决定，仅展示
    val modelOptions = if (useRemote) emptyList<ModelOption>() else vm.enabledModelOptions()
    // 模型显示名对齐 PC modelLabel（`provider / model`）；判定用原始模型名单独传
    val selectedModelName = if (useRemote) (linkVm.desktopState?.model ?: "") else vm.apiConfig.model
    val selectedModel = if (useRemote) {
        val st = linkVm.desktopState
        st?.modelLabel?.takeIf { it.isNotBlank() } ?: st?.model ?: ""
    } else {
        val providerLabel = vm.activeProvider?.label?.takeIf { it.isNotBlank() }
        if (providerLabel != null) "$providerLabel / $selectedModelName" else selectedModelName
    }
    val intelligence = if (useRemote) "medium" else vm.intelligence
    // 强制停止态（octagon-x）：仅远程，PC 端 runtime.status 为 stopping / force_restarting
    val escalating = useRemote && linkVm.desktopState?.status in setOf("stopping", "force_restarting")
    val onSend: (String) -> Unit = { text ->
        if (useRemote) linkVm.sendToDesktop(text) else vm.send(text)
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
            onToggleRail = if (isCompact) null else ({ rail = !rail }),
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
            onRenameRemote = onRenameRemoteCallback,
            onArchiveRemote = onArchiveRemoteCallback,
            onTogglePinRemote = onTogglePinRemoteCallback,
            onReorderRemote = onReorderRemoteCallback,
            archivePendingIds = linkVm.workspaceArchivePendingIds,
            swapPages = isCompact,
        )
    }

    // 预测性返回：设备展开收起 → 二级边栏 → 设置页（后注册优先响应）
    BackHandler(enabled = screen == Screen.Main && sidebarPage is SidebarPage.Main && expandedDevice != null) {
        expandedDevice = null
    }
    BackHandler(enabled = screen == Screen.Main && sidebarPage is SidebarPage.WorkspaceConversations) {
        sidebarPage = SidebarPage.Main
    }
    // 预测性返回：设置/MemoryLab/命令行等子页面各自内部逐级处理；此处仅设备展开与二级边栏

    fun rightSwipeModifier(): Modifier = Modifier.pointerInput(rightSidebarExpanded) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            var horizontalDrag = 0f
            var verticalDrag = 0f
            val openThresholdPx = 56.dp.toPx()
            val previewDistancePx = 168.dp.toPx()
            do {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                horizontalDrag += change.position.x - change.previousPosition.x
                verticalDrag += change.position.y - change.previousPosition.y
                if (!rightSidebarExpanded && horizontalDrag < 0f &&
                    kotlin.math.abs(horizontalDrag) > kotlin.math.abs(verticalDrag)
                ) {
                    rightSidebarDragProgress = ((-horizontalDrag) / previewDistancePx).coerceIn(0f, 1f)
                    change.consume()
                }
            } while (event.changes.any { it.pressed })
            val shouldOpen = horizontalDrag < -openThresholdPx && kotlin.math.abs(horizontalDrag) > kotlin.math.abs(verticalDrag)
            rightSidebarDragProgress = 0f
            if (shouldOpen) {
                rightSidebarExpanded = true
            }
        }
    }

    when {
        isCompact && compactSubagent != null -> {
            SubagentHistoryPage(agent = compactSubagent!!, onBack = { compactSubagent = null })
        }

        screen == Screen.Settings -> {
            SettingsScreen(
                vm = vm,
                linkVm = linkVm,
                onBack = { screen = Screen.Main },
            )
        }

        screen == Screen.MemoryLab && isCompact -> {
            MemoryLabScreen(onBack = { screen = Screen.Main })
        }

        screen == Screen.Terminal -> {
            TerminalScreen(onBack = { screen = Screen.Main })
        }

        isCompact -> {
            ModalNavigationDrawer(
                drawerState = drawerState,
                drawerContent = {
                    ModalDrawerSheet(
                        modifier = Modifier.width(drawerWidth),
                        drawerContainerColor = if (sidebarPage is SidebarPage.WorkspaceConversations) {
                            secondarySurface
                        } else {
                            p.bgSecondary
                        },
                        drawerContentColor = p.textPrimary,
                        drawerShape = RectangleShape,
                        drawerTonalElevation = 0.dp,
                    ) {
                        sidebar(sidebarPage, rail)
                    }
                },
                gesturesEnabled = true,
                scrimColor = NewmarkScrim,
            ) {
                Box(Modifier.fillMaxSize().then(rightSwipeModifier())) {
                    ChatScreen(
                        title = title,
                        items = displayItems,
                        isSending = sending,
                        showMenuButton = true,
                        remoteMode = useRemote,
                        modelOptions = modelOptions,
                        selectedModel = selectedModel,
                        selectedModelName = selectedModelName,
                        intelligence = intelligence,
                        onSelectModel = { vm.selectModel(it.providerId, it.modelName) },
                        onSelectIntelligence = { vm.selectIntelligence(it) },
                        onMenuClick = { scope.launch { drawerState.open() } },
                        onNewChat = onNewConversation,
                        onSend = onSend,
                        onStop = { vm.stop() },
                        escalating = escalating,
                        showConnectRemote = !useRemote && linkVm.pairInfo != null,
                        onConnectRemote = { preferLocal = false },
                        onInspectBranch = if (useRemote) linkVm::inspectRemoteBranch else vm::inspectBranch,
                        onEditUserMessage = if (useRemote) linkVm::branchRemoteMessage else vm::branchFromUserMessage,
                        onOpenWebLink = onOpenWebLink,
                    )
                    AnimatedVisibility(
                        visible = rightSidebarExpanded,
                            enter = slideInHorizontally(
                                animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo),
                                initialOffsetX = { width -> width },
                            ) + fadeIn(animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo)),
                            exit = slideOutHorizontally(
                                animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo),
                                targetOffsetX = { width -> width },
                            ) + fadeOut(animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo)),
                        modifier = Modifier.align(Alignment.CenterEnd),
                        label = "compactRightSidebar",
                    ) {
                            MobileRightSidebar(
                                vm = linkVm,
                                remoteMode = useRemote,
                                browserSession = browserSession,
                                selectedTab = selectedRightSidebarTab,
                                panelWidth = minOf(360.dp, (config.screenWidthDp - 24).dp),
                                expanded = true,
                                onOpenSubagentPage = { compactSubagent = it },
                                onExpandedChange = { rightSidebarExpanded = it },
                                onSelectTab = { rightSidebarTab = it },
                            )
                    }
                    if (!rightSidebarExpanded) {
                        if (rightSidebarDragProgress > 0f) {
                            RightSidebarDragPreview(
                                progress = rightSidebarDragProgress,
                                panelWidth = minOf(360.dp, (config.screenWidthDp - 24).dp),
                                modifier = Modifier.align(Alignment.CenterEnd),
                            )
                        }
                        RightSidebarOpenButton(
                            onClick = { rightSidebarExpanded = true },
                            modifier = Modifier.align(Alignment.CenterEnd),
                        )
                    }
                }
            }
        }

        else -> {
            // 折叠屏/平板横屏：一级边栏 + 二级边栏横向连续（与 PC 一致），对话区自然避让
            val hasSecondary = sidebarPage is SidebarPage.WorkspaceConversations
            val primaryRail = rail || hasSecondary || rightSidebarExpanded
            val primaryWidth = if (primaryRail) 48.dp else 220.dp
            val secondarySlidePx = with(LocalDensity.current) { 8.dp.roundToPx() }
            val rightSlidePx = secondarySlidePx
            val sideWidth by animateDpAsState(
                targetValue = primaryWidth,
                animationSpec = tween(durationMillis = 400, easing = PcEaseOutExpo),
                label = "sideWidth",
            )
            Row(Modifier.fillMaxSize()) {
                Box(
                    modifier = Modifier
                        .width(sideWidth)
                        .fillMaxHeight()
                        .background(p.bgSecondary)
                        .statusBarsPadding(),
                ) {
                    // 二级边栏存在时一级只渲染主边栏，二级由右侧接续
                    sidebar(if (hasSecondary) SidebarPage.Main else sidebarPage, primaryRail)
                }
                AnimatedVisibility(
                    visible = hasSecondary,
                    enter = expandHorizontally(
                        animationSpec = tween(durationMillis = 400, easing = PcEaseOutExpo),
                        expandFrom = Alignment.Start,
                        clip = true,
                    ) + slideInHorizontally(
                        animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo),
                        initialOffsetX = { -secondarySlidePx },
                    ) + fadeIn(
                        animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo),
                    ),
                    exit = shrinkHorizontally(
                        animationSpec = tween(durationMillis = 400, easing = PcEaseOutExpo),
                        shrinkTowards = Alignment.Start,
                        clip = true,
                    ) + slideOutHorizontally(
                        animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo),
                        targetOffsetX = { -secondarySlidePx },
                    ) + fadeOut(
                        animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo),
                    ),
                ) {
                    val ws = retainedSecondaryWorkspace
                    if (ws != null) {
                        Box(
                            modifier = Modifier
                                .width(220.dp)
                                .fillMaxHeight(),
                        ) {
                            WorkspaceConversationsSidebar(
                                conversations = linkVm.workspaceConversations,
                                activeConversationId = linkVm.openedWorkspaceActiveConversationId,
                                onBack = onBackSidebar,
                                onSelectConversation = {
                                    linkVm.selectConversation(it, ws.id)
                                    preferLocal = false
                                },
                                onNewConversation = onNewRemoteConversation,
                                onRenameConversation = onRenameRemoteCallback,
                                onArchiveConversation = onArchiveRemoteCallback,
                                onTogglePinConversation = onTogglePinRemoteCallback,
                                onReorderConversations = onReorderRemoteCallback,
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
                        .background(p.bgPrimary)
                        .then(rightSwipeModifier()),
                ) {
                    ChatScreen(
                        title = title,
                        items = displayItems,
                        isSending = sending,
                        showMenuButton = false,
                        remoteMode = useRemote,
                        modelOptions = modelOptions,
                        selectedModel = selectedModel,
                        selectedModelName = selectedModelName,
                        intelligence = intelligence,
                        onSelectModel = { vm.selectModel(it.providerId, it.modelName) },
                        onSelectIntelligence = { vm.selectIntelligence(it) },
                        onMenuClick = {},
                        onNewChat = onNewConversation,
                        onSend = onSend,
                        onStop = { vm.stop() },
                        escalating = escalating,
                        showConnectRemote = !useRemote && linkVm.pairInfo != null,
                        onConnectRemote = { preferLocal = false },
                        goal = if (useRemote) linkVm.desktopState?.goal else null,
                        flowName = if (useRemote) linkVm.desktopState?.flowSelection?.name else null,
                        onInspectBranch = if (useRemote) linkVm::inspectRemoteBranch else vm::inspectBranch,
                        onEditUserMessage = if (useRemote) linkVm::branchRemoteMessage else vm::branchFromUserMessage,
                        onOpenWebLink = onOpenWebLink,
                    )
                    if (!rightSidebarExpanded) {
                        if (rightSidebarDragProgress > 0f) {
                            RightSidebarDragPreview(
                                progress = rightSidebarDragProgress,
                                panelWidth = if (config.screenWidthDp < 840) 280.dp else 300.dp,
                                modifier = Modifier.align(Alignment.CenterEnd),
                            )
                        }
                        RightSidebarOpenButton(
                            onClick = { rightSidebarExpanded = true },
                            modifier = Modifier.align(Alignment.CenterEnd),
                        )
                    }
                }
                AnimatedVisibility(
                    visible = rightSidebarExpanded,
                    enter = expandHorizontally(
                        animationSpec = tween(durationMillis = 400, easing = PcEaseOutExpo),
                        expandFrom = Alignment.End,
                        clip = true,
                    ) + slideInHorizontally(
                        animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo),
                        initialOffsetX = { width -> width.coerceAtMost(rightSlidePx) },
                    ) + fadeIn(animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo)),
                    exit = shrinkHorizontally(
                        animationSpec = tween(durationMillis = 400, easing = PcEaseOutExpo),
                        shrinkTowards = Alignment.End,
                        clip = true,
                    ) + slideOutHorizontally(
                        animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo),
                        targetOffsetX = { width -> width.coerceAtMost(rightSlidePx) },
                    ) + fadeOut(animationSpec = tween(durationMillis = 250, easing = PcEaseOutExpo)),
                    label = "wideRightSidebar",
                ) {
                    MobileRightSidebar(
                        vm = linkVm,
                        remoteMode = useRemote,
                        browserSession = browserSession,
                        selectedTab = selectedRightSidebarTab,
                        panelWidth = if (config.screenWidthDp < 840) 280.dp else 300.dp,
                        expanded = true,
                        onExpandedChange = { rightSidebarExpanded = it },
                        onSelectTab = { rightSidebarTab = it },
                    )
                }
            }
        }
    }

    if (!isCompact && screen == Screen.MemoryLab) {
        MemoryLabDialog(onDismiss = { screen = Screen.Main })
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
