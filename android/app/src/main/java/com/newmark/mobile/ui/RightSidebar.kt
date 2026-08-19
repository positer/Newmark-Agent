package com.newmark.mobile.ui

import android.annotation.SuppressLint
import android.graphics.Color as AndroidColor
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.newmark.mobile.data.RemoteSubagent
import com.newmark.mobile.data.RemotePlanItem
import com.newmark.mobile.ui.components.LucideIcons
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkLightPalette
import com.newmark.mobile.vm.ChatViewModel
import com.newmark.mobile.vm.DesktopLinkViewModel

enum class RightSidebarTab(val label: String, val icon: ImageVector) {
    Files("文件", LucideIcons.Folder),
    Editor("编辑器", LucideIcons.SquarePen),
    Plan("计划", LucideIcons.ListChecks),
    Subagents("Subagent", LucideIcons.Bot),
    Browser("浏览器", LucideIcons.Globe),
}

private fun availableRightTabs(remoteMode: Boolean): List<RightSidebarTab> = if (remoteMode) {
    RightSidebarTab.entries.toList()
} else {
    // 本地没有远程工作区文件/编辑器 API，也不保留 SubAgent 面板。
    listOf(RightSidebarTab.Plan, RightSidebarTab.Browser)
}

/** PC #right：横向 tabs、可关闭内容区；内容展开时占据第三栏并让聊天区避让。 */
@Composable
fun MobileRightSidebar(
    vm: DesktopLinkViewModel,
    localVm: ChatViewModel? = null,
    remoteMode: Boolean,
    browserSession: BrowserSessionState,
    selectedTab: RightSidebarTab,
    panelWidth: Dp = 300.dp,
    /** 宽屏拖拽期间使用同一正式栏的可见宽度，不再渲染独立预测层。 */
    visibleWidth: Dp = panelWidth,
    expanded: Boolean,
    onOpenSubagentPage: ((RemoteSubagent) -> Unit)? = null,
    onExpandedChange: (Boolean) -> Unit = {},
    onSelectTab: (RightSidebarTab) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val p = LocalNewmarkPalette.current
    val tabs = remember(remoteMode) { availableRightTabs(remoteMode) }
    val tab = selectedTab.takeIf { it in tabs } ?: tabs.first()
    var selectedSubagent by remember { mutableStateOf<RemoteSubagent?>(null) }

    LaunchedEffect(remoteMode, vm.selectedConversationWorkspaceId, vm.selectedConversationId) {
        if (remoteMode && !vm.selectedConversationWorkspaceId.isNullOrBlank() && !vm.selectedConversationId.isNullOrBlank()) {
            vm.refreshRightSidebar()
        }
    }
    Column(
        modifier = modifier.width(visibleWidth).fillMaxHeight()
            .background(p.bgTertiary.copy(alpha = 0.74f)).border(1.dp, p.border),
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
                }
            }
        }
    }
    selectedSubagent?.let { agent -> SubagentHistoryDialog(agent, onDismiss = { selectedSubagent = null }) }
}

/** PC .right-open-btn：折叠时覆盖在主页面右缘中部，不占据任何布局宽度。 */
@Composable
fun RightSidebarOpenButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val p = LocalNewmarkPalette.current
    Box(
        modifier = modifier
            .width(18.dp)
            .height(48.dp)
            .clip(RoundedCornerShape(topStart = 4.dp, bottomStart = 4.dp))
            .background(p.bgTertiary)
            .border(1.dp, p.border, RoundedCornerShape(topStart = 4.dp, bottomStart = 4.dp))
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
    val p = LocalNewmarkPalette.current
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
    val p = LocalNewmarkPalette.current
    Column(Modifier.fillMaxWidth().statusBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().height(41.dp).padding(horizontal = 6.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (expanded) {
                tabs.forEach { target ->
                    val active = selected == target
                    IconButton(target.icon, target.label, if (active) p.accent else p.textSecondary,
                        if (active) p.accentSoft else Color.Transparent,
                        if (active) p.accentBorder else Color.Transparent) { onSelect(target) }
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
    onClick: () -> Unit,
) {
    Box(
        Modifier.size(width = 32.dp, height = 28.dp).clip(RoundedCornerShape(6.dp)).background(background)
            .border(1.dp, border, RoundedCornerShape(6.dp)).clickable(
                interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, label, tint = tint, modifier = Modifier.size(15.dp)) }
}

@Composable
private fun SectionHead(title: String, meta: String = "", onRefresh: (() -> Unit)? = null) {
    val p = LocalNewmarkPalette.current
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
    val p = LocalNewmarkPalette.current
    Column {
        SectionHead("Workspace file tree", onRefresh = { vm.loadRightSidebarDirectory(vm.rightSidebarPath) })
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
    val p = LocalNewmarkPalette.current
    val lightTheme = p == NewmarkLightPalette
    val editorBackground = if (lightTheme) Color(0xFFF7F8FC) else Color(0xFF0B0D14)
    val gutterBackground = if (lightTheme) Color(0x0B1D243A) else Color(0x06FFFFFF)
    val editorCaret = if (lightTheme) Color(0xFF172033) else Color.White
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    val lineCount = remember(vm.rightSidebarEditorContent) { vm.rightSidebarEditorContent.count { it == '\n' } + 1 }
    val gutter = remember(lineCount) { (1..lineCount).joinToString("\n") }
    LaunchedEffect(vm.rightSidebarEditorPath) {
        if (vm.rightSidebarEditorPath.isNotBlank()) {
            focusRequester.requestFocus()
            keyboardController?.show()
        }
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().height(39.dp).padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            EditorToolbarButton(LucideIcons.Save, "保存", vm.rightSidebarEditorPath.isNotBlank()) { vm.saveRightSidebarFile() }
            EditorToolbarButton(LucideIcons.X, "关闭", vm.rightSidebarEditorPath.isNotBlank()) { vm.closeRightSidebarFile() }
            Text(vm.rightSidebarEditorPath.ifBlank { "No file selected" }, color = p.textTertiary, fontSize = 10.sp,
                textAlign = androidx.compose.ui.text.style.TextAlign.End, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f))
        }
        Row(Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp)).background(editorBackground)
            .border(1.dp, p.border2, RoundedCornerShape(8.dp))) {
            Text(gutter, color = p.textTertiary, fontSize = 11.sp, lineHeight = 17.sp, fontFamily = FontFamily.Monospace,
                textAlign = androidx.compose.ui.text.style.TextAlign.End,
                modifier = Modifier.width(44.dp).fillMaxHeight().background(gutterBackground).padding(top = 10.dp, end = 8.dp))
            Column(Modifier.weight(1f).fillMaxHeight()) {
                BasicTextField(
                    value = vm.rightSidebarEditorContent,
                    onValueChange = vm::updateRightSidebarEditor,
                    enabled = vm.rightSidebarEditorPath.isNotBlank(),
                    textStyle = TextStyle(color = p.textPrimary, fontSize = 11.sp, lineHeight = 17.sp, fontFamily = FontFamily.Monospace),
                    cursorBrush = SolidColor(editorCaret),
                    modifier = Modifier.weight(1f).fillMaxWidth().focusRequester(focusRequester)
                        .onFocusChanged { if (it.isFocused) keyboardController?.show() }.padding(10.dp),
                    decorationBox = { inner ->
                        if (vm.rightSidebarEditorPath.isBlank()) Text("Open a file to edit...", color = p.textTertiary, fontSize = 11.sp)
                        inner()
                    },
                )
                Row(Modifier.fillMaxWidth().height(25.dp).border(1.dp, p.border).padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text("INSERT", color = Color(0xFF38D4A0), fontSize = 9.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                    Text("  ${editorLanguage(vm.rightSidebarEditorPath)}", color = p.textTertiary, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
                    Spacer(Modifier.weight(1f))
                    Text(if (vm.rightSidebarSaving) "Saving…" else "$lineCount lines", color = p.textTertiary, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
                }
            }
        }
    }
}

private fun editorLanguage(path: String): String = path.substringAfterLast('.', "text").ifBlank { "text" }

@Composable
private fun EditorToolbarButton(icon: ImageVector, label: String, enabled: Boolean, onClick: () -> Unit) {
    val p = LocalNewmarkPalette.current
    Box(Modifier.size(30.dp).clip(RoundedCornerShape(6.dp)).background(p.bgPrimary)
        .border(1.dp, p.border2, RoundedCornerShape(6.dp)).clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = if (enabled) p.textSecondary else p.textTertiary.copy(alpha = .35f), modifier = Modifier.size(15.dp))
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
    val p = LocalNewmarkPalette.current
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
    val p = LocalNewmarkPalette.current
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
    val p = LocalNewmarkPalette.current
    Column {
        SectionHead("Subagents", onRefresh = vm::refreshRightSidebar)
        if (vm.rightSidebarSubagents.isEmpty()) EmptyState("暂无保留的 Subagent 记录")
        else LazyColumn(Modifier.fillMaxSize()) {
            items(vm.rightSidebarSubagents, key = { it.id }) { agent ->
                Row(Modifier.fillMaxWidth().clickable { onOpen(agent) }.padding(horizontal = 8.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Icon(LucideIcons.Bot, null, tint = p.accent, modifier = Modifier.size(16.dp))
                    Column(Modifier.weight(1f).padding(horizontal = 7.dp)) {
                        Text(agent.displayName.ifBlank { agent.name }, color = p.textPrimary, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${agent.mode} / ${agent.model.ifBlank { "default" }} / ${agent.messageCount} 条消息",
                            color = p.textTertiary, fontSize = 9.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Text(agent.status, color = Color(0xFF38D4A0), fontSize = 9.sp)
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(p.border))
            }
        }
    }
}

@Composable
fun SubagentHistoryPage(agent: RemoteSubagent, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val p = LocalNewmarkPalette.current
    Column(Modifier.fillMaxSize().background(p.bgPrimary).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(52.dp).background(p.bgSecondary).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(LucideIcons.ChevronLeft, "返回", p.textPrimary, onClick = onBack)
            Text("Subagent 历史", color = p.textPrimary, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 10.dp))
        }
        SubagentHistoryContent(agent, Modifier.fillMaxSize().padding(16.dp))
    }
}

@Composable
private fun SubagentHistoryDialog(agent: RemoteSubagent, onDismiss: () -> Unit) {
    val p = LocalNewmarkPalette.current
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxWidth(.82f).fillMaxHeight(.8f).widthIn(max = 680.dp).clip(RoundedCornerShape(12.dp))
            .background(p.bgPrimary.copy(alpha = 0.78f)).border(1.dp, p.border2, RoundedCornerShape(12.dp))) {
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

@Composable
private fun SubagentHistoryContent(agent: RemoteSubagent, modifier: Modifier = Modifier) {
    val p = LocalNewmarkPalette.current
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
            Text(message.role.uppercase(), color = p.textTertiary, fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
            Text(message.content, color = p.textPrimary, fontSize = 11.sp, lineHeight = 16.sp, modifier = Modifier.padding(bottom = 10.dp))
        }
        if (agent.error.isNotBlank()) Text(agent.error, color = p.red, fontSize = 11.sp, lineHeight = 16.sp)
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun BrowserPanel(session: BrowserSessionState, visible: Boolean, modifier: Modifier = Modifier) {
    key(session) {
        if (visible || session.hasActivity) {
            ConversationBrowserPanel(session, modifier)
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun ConversationBrowserPanel(session: BrowserSessionState, modifier: Modifier = Modifier) {
    val p = LocalNewmarkPalette.current
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    var address by remember { mutableStateOf("https://www.google.com") }
    var webView by remember { mutableStateOf<WebView?>(null) }

    LaunchedEffect(session.address) {
        if (session.address != address) address = session.address
    }

    fun navigate() {
        session.navigate(address)
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
            BasicTextField(value = address, onValueChange = { value ->
                address = value
                session.updateAddressDraft(value)
            }, singleLine = true,
                textStyle = TextStyle(color = p.textPrimary, fontSize = 11.sp),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go), keyboardActions = KeyboardActions(onGo = { navigate() }),
                modifier = Modifier.weight(1f).height(30.dp).clip(RoundedCornerShape(8.dp)).background(p.bgPrimary)
                    .border(1.dp, p.border2, RoundedCornerShape(8.dp)).padding(horizontal = 9.dp, vertical = 6.dp))
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
                    settings.javaScriptCanOpenWindowsAutomatically = false
                    settings.setSupportMultipleWindows(false)
                    settings.mediaPlaybackRequiresUserGesture = true
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        settings.safeBrowsingEnabled = true
                    }
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                            val target = BrowserUrlPolicy.normalize(request.url.toString())
                            return if (target != null) {
                                session.onNavigationStarted(target)
                                false
                            } else {
                                session.onNavigationError("已阻止非网页链接：${request.url.scheme ?: "unknown"}", view.canGoBack(), view.canGoForward())
                                true
                            }
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
                    webView = this
                }
            },
            modifier = Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(8.dp)).border(1.dp, p.border2, RoundedCornerShape(8.dp)),
        )
    }
    DisposableEffect(Unit) {
        onDispose {
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
    val p = LocalNewmarkPalette.current
    Text(text, color = p.textTertiary, fontSize = 11.sp, modifier = Modifier.fillMaxWidth().padding(12.dp))
}
