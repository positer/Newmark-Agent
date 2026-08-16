package com.newmark.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.newmark.mobile.ui.theme.NewmarkBgPrimary
import com.newmark.mobile.ui.theme.NewmarkBgSecondary
import com.newmark.mobile.ui.theme.NewmarkScrim
import com.newmark.mobile.vm.ChatViewModel
import com.newmark.mobile.vm.DesktopLinkViewModel
import kotlinx.coroutines.launch

private enum class Screen { Main, Settings }

/** 自适应根布局：竖屏 drawer / 平板 rail↔full，绑定本地对话 + 桌面端同步 */
@Composable
fun NewmarkApp() {
    val vm: ChatViewModel = viewModel()
    val linkVm: DesktopLinkViewModel = viewModel()

    val config = LocalConfiguration.current
    val isCompact = config.screenWidthDp < 600

    var screen by remember { mutableStateOf(Screen.Main) }
    var sidebarPage by remember { mutableStateOf<SidebarPage>(SidebarPage.Main) }
    var expandedDevice by remember { mutableStateOf<Device?>(null) }
    var rail by remember { mutableStateOf(false) }

    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    // 配对成功后优先展示/发送到桌面端
    val useRemote = linkVm.isConnected && linkVm.pairInfo != null
    val displayItems: List<ChatItem> = if (useRemote) {
        linkVm.remoteMessages.map { m ->
            ChatItem.Bubble(role = m.role, content = m.content, mode = m.mode, model = m.model)
        } + linkVm.lastTokens.map { ChatItem.Work(it) }
    } else {
        (vm.current?.messages ?: emptyList()).map { m ->
            ChatItem.Bubble(role = m.role, content = m.content)
        }
    }
    val sending = if (useRemote) linkVm.isSending else vm.isSending
    val title = if (useRemote) {
        "桌面端 · " + (linkVm.desktopState?.model?.takeIf { it.isNotBlank() } ?: "Newmark")
    } else {
        vm.current?.title ?: "Newmark"
    }
    val onSend: (String) -> Unit = { text ->
        if (useRemote) linkVm.sendToDesktop(text) else vm.send(text)
    }

    val onNewConversation: () -> Unit = { vm.newConversation() }
    val onOpenSettings: () -> Unit = { screen = Screen.Settings }
    val onOpenWorkspace: (Workspace) -> Unit = { sidebarPage = SidebarPage.WorkspaceChats(it) }
    val onBackSidebar: () -> Unit = { sidebarPage = SidebarPage.Main }
    val onToggleDevice: (Device) -> Unit = {
        expandedDevice = if (expandedDevice == it) null else it
    }

    val sidebar: @Composable () -> Unit = {
        SidebarContent(
            rail = rail,
            page = sidebarPage,
            expandedDevice = expandedDevice,
            conversations = vm.conversations,
            currentConversationId = vm.currentId,
            onToggleDevice = onToggleDevice,
            onOpenWorkspace = onOpenWorkspace,
            onBack = onBackSidebar,
            onOpenSettings = onOpenSettings,
            onNewConversation = onNewConversation,
            onSelectConversation = { vm.selectConversation(it) },
            onToggleRail = if (isCompact) null else ({ rail = !rail }),
        )
    }

    BackHandler(enabled = screen == Screen.Settings) {
        screen = Screen.Main
    }
    BackHandler(enabled = screen == Screen.Main && sidebarPage is SidebarPage.WorkspaceChats) {
        sidebarPage = SidebarPage.Main
    }

    when {
        screen == Screen.Settings -> {
            SettingsScreen(
                apiConfig = vm.apiConfig,
                onSaveConfig = { vm.saveApiConfig(it) },
                linkVm = linkVm,
                onBack = { screen = Screen.Main },
            )
        }

        isCompact -> {
            ModalNavigationDrawer(
                drawerState = drawerState,
                drawerContent = {
                    ModalDrawerSheet(
                        drawerContainerColor = NewmarkBgSecondary,
                        drawerContentColor = NewmarkBgSecondary,
                    ) {
                        sidebar()
                    }
                },
                gesturesEnabled = true,
                scrimColor = NewmarkScrim,
            ) {
                Box(Modifier.fillMaxSize()) {
                    ChatScreen(
                        title = title,
                        items = displayItems,
                        isSending = sending,
                        showMenuButton = true,
                        onMenuClick = { scope.launch { drawerState.open() } },
                        onNewChat = onNewConversation,
                        onSend = onSend,
                    )
                }
            }
        }

        else -> {
            val effectiveRail = rail && sidebarPage is SidebarPage.Main
            val targetWidth = if (effectiveRail) 52.dp else 220.dp
            val sideWidth by animateDpAsState(
                targetValue = targetWidth,
                animationSpec = tween(durationMillis = 300),
                label = "sideWidth",
            )
            Row(Modifier.fillMaxSize()) {
                Box(
                    modifier = Modifier
                        .width(sideWidth)
                        .fillMaxHeight()
                        .background(NewmarkBgSecondary),
                ) {
                    sidebar()
                }
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .background(NewmarkBgPrimary),
                ) {
                    ChatScreen(
                        title = title,
                        items = displayItems,
                        isSending = sending,
                        showMenuButton = false,
                        onMenuClick = {},
                        onNewChat = onNewConversation,
                        onSend = onSend,
                    )
                }
            }
        }
    }
}
