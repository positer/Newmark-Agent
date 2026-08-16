package com.newmark.mobile.ui

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.newmark.mobile.data.LocalConversation
import com.newmark.mobile.ui.components.MarqueeBorder
import com.newmark.mobile.ui.components.NewmarkShapeMedium
import com.newmark.mobile.ui.components.NewmarkShapeSmall
import com.newmark.mobile.ui.theme.NewmarkAccent
import com.newmark.mobile.ui.theme.NewmarkAccentSoft
import com.newmark.mobile.ui.theme.NewmarkBgQuaternary
import com.newmark.mobile.ui.theme.NewmarkBgSecondary
import com.newmark.mobile.ui.theme.NewmarkBgTertiary
import com.newmark.mobile.ui.theme.NewmarkGreen
import com.newmark.mobile.ui.theme.NewmarkTextPrimary
import com.newmark.mobile.ui.theme.NewmarkTextSecondary
import com.newmark.mobile.ui.theme.NewmarkTextTertiary

sealed interface SidebarPage {
    data object Main : SidebarPage
    data class WorkspaceChats(val workspace: Workspace) : SidebarPage
}

@Composable
fun SidebarContent(
    rail: Boolean,
    page: SidebarPage,
    expandedDevice: Device?,
    conversations: List<LocalConversation>,
    currentConversationId: String?,
    onToggleDevice: (Device) -> Unit,
    onOpenWorkspace: (Workspace) -> Unit,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
    onNewConversation: () -> Unit,
    onSelectConversation: (String) -> Unit,
    onToggleRail: (() -> Unit)? = null,
) {
    when (page) {
        is SidebarPage.Main -> MainSidebar(
            rail = rail,
            expandedDevice = expandedDevice,
            conversations = conversations,
            currentConversationId = currentConversationId,
            onToggleDevice = onToggleDevice,
            onOpenWorkspace = onOpenWorkspace,
            onOpenSettings = onOpenSettings,
            onNewConversation = onNewConversation,
            onSelectConversation = onSelectConversation,
            onToggleRail = onToggleRail,
        )
        is SidebarPage.WorkspaceChats -> WorkspaceSidebar(
            workspace = page.workspace,
            onBack = onBack,
            onNewChat = onNewConversation,
        )
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
    onOpenWorkspace: (Workspace) -> Unit,
    onOpenSettings: () -> Unit,
    onNewConversation: () -> Unit,
    onSelectConversation: (String) -> Unit,
    onToggleRail: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(NewmarkBgSecondary)
            .padding(horizontal = if (rail) 4.dp else 6.dp),
    ) {
        // 区 1：设备与工作区（顶部）
        DeviceWorkspaceSection(
            rail = rail,
            expandedDevice = expandedDevice,
            onToggleDevice = onToggleDevice,
            onOpenWorkspace = onOpenWorkspace,
        )

        // 区 2：本地对话（中部，占剩余高度，真实数据）
        if (rail) {
            RailLocalConversations(
                conversations = conversations,
                currentId = currentConversationId,
                onSelect = onSelectConversation,
            )
        } else {
            Column(Modifier.weight(1f)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SectionLabel("本地对话")
                    Spacer(Modifier.weight(1f))
                    Box(
                        modifier = Modifier
                            .padding(end = 10.dp)
                            .size(24.dp)
                            .clip(CircleShape)
                            .background(NewmarkBgQuaternary)
                            .clickable(onClick = onNewConversation),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Add,
                            contentDescription = "新对话",
                            tint = NewmarkTextSecondary,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
                if (conversations.isEmpty()) {
                    Text(
                        text = "点击右上角 + 新建对话",
                        fontSize = 11.sp,
                        color = NewmarkTextTertiary,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                    )
                } else {
                    LazyColumn(Modifier.fillMaxSize()) {
                        items(conversations, key = { it.id }) { conv ->
                            LocalConversationRow(
                                conversation = conv,
                                selected = conv.id == currentConversationId,
                                onClick = { onSelectConversation(conv.id) },
                            )
                        }
                    }
                }
            }
        }

        // 区 3：折叠切换 + 设置（固定底部）
        if (onToggleRail != null) {
            ToggleRailButton(rail = rail, onClick = onToggleRail)
        }
        SettingsButton(rail = rail, onClick = onOpenSettings)
    }
}

@Composable
private fun ToggleRailButton(rail: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (rail) "▶" else "◀",
            fontSize = 10.sp,
            color = NewmarkTextTertiary,
        )
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        fontSize = 10.5.sp,
        fontWeight = FontWeight.SemiBold,
        color = NewmarkTextTertiary,
        letterSpacing = 0.6.sp,
        modifier = Modifier.padding(start = 10.dp, top = 6.dp, bottom = 4.dp),
        maxLines = 1,
        overflow = TextOverflow.Clip,
    )
}

// ---- 设备与工作区 ----
@Composable
private fun DeviceWorkspaceSection(
    rail: Boolean,
    expandedDevice: Device?,
    onToggleDevice: (Device) -> Unit,
    onOpenWorkspace: (Workspace) -> Unit,
) {
    Column {
        if (rail) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                MockData.devices.forEach { device ->
                    DeviceRailIcon(device = device, expanded = expandedDevice == device) {
                        onToggleDevice(device)
                    }
                }
            }
            if (expandedDevice != null) {
                Text(
                    text = "工作区",
                    fontSize = 9.sp,
                    color = NewmarkTextTertiary,
                    modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 4.dp),
                    maxLines = 1,
                )
                Column(
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.padding(top = 4.dp),
                ) {
                    expandedDevice.workspaces.forEach { ws ->
                        WorkspaceRailIcon(workspace = ws) { onOpenWorkspace(ws) }
                    }
                }
            }
        } else {
            SectionLabel("设备与工作区")
            MockData.devices.forEach { device ->
                DeviceRow(
                    device = device,
                    expanded = expandedDevice == device,
                    onClick = { onToggleDevice(device) },
                )
                if (expandedDevice == device) {
                    Column(Modifier.padding(start = 18.dp, top = 2.dp, bottom = 2.dp)) {
                        device.workspaces.forEach { ws ->
                            WorkspaceRow(workspace = ws, onClick = { onOpenWorkspace(ws) })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DeviceRow(device: Device, expanded: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(NewmarkShapeSmall)
            .clickable(onClick = onClick)
            .background(if (expanded) NewmarkAccentSoft else Color.Transparent)
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = if (device.online) "🖥️" else "💻", fontSize = 15.sp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = device.name,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Medium,
                color = NewmarkTextPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = if (device.online) "已连接 · Tailscale" else "离线",
                fontSize = 10.5.sp,
                color = if (device.online) NewmarkGreen else NewmarkTextTertiary,
                maxLines = 1,
            )
        }
        Icon(
            imageVector = Icons.Filled.KeyboardArrowDown,
            contentDescription = null,
            tint = NewmarkTextTertiary,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
private fun DeviceRailIcon(device: Device, expanded: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(NewmarkShapeSmall)
            .background(if (expanded) NewmarkAccentSoft else Color.Transparent)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = if (device.online) "🖥️" else "💻", fontSize = 16.sp)
    }
}

@Composable
private fun WorkspaceRow(workspace: Workspace, onClick: () -> Unit) {
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
                color = NewmarkTextPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = workspace.path,
                fontSize = 10.5.sp,
                color = NewmarkTextTertiary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun WorkspaceRailIcon(workspace: Workspace, onClick: () -> Unit) {
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
    Box(
        modifier = Modifier
            .size(30.dp)
            .clip(NewmarkShapeSmall)
            .background(
                Brush.linearGradient(
                    colors = listOf(NewmarkAccentSoft, NewmarkAccent.copy(alpha = 0.08f)),
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = workspace.initial.toString(),
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            color = NewmarkAccent,
        )
    }
}

// ---- 本地对话（rail 态缩略，真实数据） ----
@Composable
private fun ColumnScope.RailLocalConversations(
    conversations: List<LocalConversation>,
    currentId: String?,
    onSelect: (String) -> Unit,
) {
    Column(Modifier.weight(1f)) {
        Text(
            text = "本地",
            fontSize = 9.sp,
            color = NewmarkTextTertiary,
            modifier = Modifier.align(Alignment.CenterHorizontally).padding(vertical = 6.dp),
        )
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            conversations.forEach { conv ->
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .background(
                            if (conv.id == currentId) NewmarkAccentSoft else NewmarkBgQuaternary,
                        )
                        .clickable { onSelect(conv.id) }
                        .align(Alignment.CenterHorizontally),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(text = "💬", fontSize = 12.sp)
                }
            }
        }
    }
}

// ---- 本地对话行（真实数据） ----
@Composable
private fun LocalConversationRow(
    conversation: LocalConversation,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(NewmarkShapeMedium)
            .background(if (selected) NewmarkAccentSoft else NewmarkBgQuaternary)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = conversation.title,
                fontSize = 11.5.sp,
                fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
                color = if (selected) NewmarkAccent else NewmarkTextSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "${conversation.messages.size} 条消息",
                fontSize = 10.sp,
                color = NewmarkTextTertiary,
                maxLines = 1,
            )
        }
    }
}

// ---- 远端工作区对话行（mock） ----
@Composable
private fun ConversationRow(conversation: Conversation) {
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
                color = NewmarkTextSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Box(
                modifier = Modifier
                    .size(22.dp)
                    .clip(CircleShape)
                    .background(NewmarkBgQuaternary),
                contentAlignment = Alignment.Center,
            ) {
                Text(text = "📁", fontSize = 10.sp)
            }
        }
    }
    if (conversation.running) {
        MarqueeBorder(shape = NewmarkShapeMedium, innerColor = NewmarkBgTertiary) {
            rowContent()
        }
    } else {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(NewmarkShapeMedium)
                .background(NewmarkBgQuaternary),
        ) {
            rowContent()
        }
    }
}

// ---- 设置按钮（底部固定） ----
@Composable
private fun SettingsButton(rail: Boolean, onClick: () -> Unit) {
    Box(Modifier.padding(vertical = 6.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(NewmarkShapeSmall)
                .clickable(onClick = onClick)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = if (rail) Arrangement.Center else Arrangement.Start,
        ) {
            Icon(
                imageVector = Icons.Filled.Settings,
                contentDescription = "设置",
                tint = NewmarkTextSecondary,
                modifier = Modifier.size(18.dp),
            )
            if (!rail) {
                Spacer(Modifier.width(10.dp))
                Text(
                    text = "设置",
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.Medium,
                    color = NewmarkTextPrimary,
                )
            }
        }
    }
}

// ============ 二级边栏：工作区对话管理（远端 mock） ============
@Composable
private fun WorkspaceSidebar(
    workspace: Workspace,
    onBack: () -> Unit,
    onNewChat: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(NewmarkBgTertiary),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(30.dp)
                    .clip(CircleShape)
                    .clickable(onClick = onBack)
                    .background(NewmarkBgQuaternary),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Filled.ArrowBack,
                    contentDescription = "返回",
                    tint = NewmarkTextSecondary,
                    modifier = Modifier.size(16.dp),
                )
            }
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    text = workspace.name,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = NewmarkTextPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = workspace.path,
                    fontSize = 10.5.sp,
                    color = NewmarkTextTertiary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            SmallActionButton(label = "⚙ 工作区")
            Spacer(Modifier.width(5.dp))
            SmallActionButton(label = "＋ 新对话", accent = true, onClick = onNewChat)
        }

        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 6.dp),
        ) {
            items(workspace.conversations) { conv ->
                ConversationRow(conversation = conv)
            }
        }
    }
}

@Composable
private fun SmallActionButton(label: String, accent: Boolean = false, onClick: () -> Unit = {}) {
    Box(
        modifier = Modifier
            .clip(NewmarkShapeMedium)
            .background(if (accent) NewmarkAccentSoft else NewmarkBgQuaternary)
            .clickable(onClick = onClick)
            .padding(horizontal = 9.dp, vertical = 6.dp),
    ) {
        Text(
            text = label,
            fontSize = 11.5.sp,
            fontWeight = FontWeight.Medium,
            color = if (accent) NewmarkAccent else NewmarkTextPrimary,
            maxLines = 1,
        )
    }
}
