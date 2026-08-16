package com.newmark.mobile.ui

import android.widget.Toast
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.newmark.mobile.data.WorkEvent
import com.newmark.mobile.ui.components.MarqueeBorder
import com.newmark.mobile.ui.components.MarqueeTopBar
import com.newmark.mobile.ui.components.NewmarkShapeLarge
import com.newmark.mobile.ui.components.NewmarkShapeMedium
import com.newmark.mobile.ui.components.NewmarkShapeSmall
import com.newmark.mobile.ui.theme.NewmarkAccent
import com.newmark.mobile.ui.theme.NewmarkAccentSoft
import com.newmark.mobile.ui.theme.NewmarkBgPrimary
import com.newmark.mobile.ui.theme.NewmarkBgQuaternary
import com.newmark.mobile.ui.theme.NewmarkBgSecondary
import com.newmark.mobile.ui.theme.NewmarkBgTertiary
import com.newmark.mobile.ui.theme.NewmarkTextPrimary
import com.newmark.mobile.ui.theme.NewmarkTextSecondary
import com.newmark.mobile.ui.theme.NewmarkTextTertiary

private val MODES = listOf("Build", "Plan", "Goal", "Flow")
private val MODELS = listOf("GPT-4o", "GPT-4", "Claude Sonnet", "Claude Opus", "Gemini Pro")
private val TIERS = listOf("low", "medium", "high", "xhigh", "max")

/** 对话区渲染项：气泡 或 工作事件块（与 GUI 桌面端渲染契约一致） */
sealed interface ChatItem {
    data class Bubble(
        val role: String, // user | assistant | system | workflow
        val content: String,
        val mode: String = "",
        val model: String = "",
    ) : ChatItem

    data class Work(val event: WorkEvent) : ChatItem
}

@Composable
fun ChatScreen(
    title: String,
    items: List<ChatItem>,
    isSending: Boolean,
    showMenuButton: Boolean,
    onMenuClick: () -> Unit,
    onNewChat: () -> Unit,
    onSend: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(NewmarkBgPrimary),
    ) {
        ChatTopBar(
            title = title,
            showMenuButton = showMenuButton,
            onMenuClick = onMenuClick,
            onNewChat = onNewChat,
        )

        ChatContent(
            items = items,
            isSending = isSending,
            modifier = Modifier.weight(1f),
        )

        InputArea(running = isSending, onSend = onSend)
    }
}

@Composable
private fun ChatTopBar(
    title: String,
    showMenuButton: Boolean,
    onMenuClick: () -> Unit,
    onNewChat: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .background(NewmarkBgSecondary)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showMenuButton) {
            CircleButton(onClick = onMenuClick) {
                Icon(
                    imageVector = Icons.Filled.Menu,
                    contentDescription = "菜单",
                    tint = NewmarkTextPrimary,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
        Text(
            text = title,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            color = NewmarkTextPrimary,
            maxLines = 1,
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 12.dp),
        )
        CircleButton(onClick = onNewChat) {
            Icon(
                imageVector = Icons.Filled.Add,
                contentDescription = "新对话",
                tint = NewmarkAccent,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Composable
private fun CircleButton(onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(NewmarkBgQuaternary)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

// ---- 对话内容（气泡 + 工作事件块） ----
@Composable
private fun ChatContent(
    items: List<ChatItem>,
    isSending: Boolean,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    LazyColumn(
        state = listState,
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (items.isEmpty()) {
            item {
                Text(
                    text = "👋 你好！我是 Newmark Agent。\n在下方输入消息开始对话。",
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                    color = NewmarkTextSecondary,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }
        } else {
            items(items) { item ->
                when (item) {
                    is ChatItem.Bubble -> ChatBubble(item)
                    is ChatItem.Work -> WorkBlock(item.event)
                }
            }
        }
        if (isSending) {
            item { ThinkingDots() }
        }
    }
}

@Composable
private fun ChatBubble(item: ChatItem.Bubble) {
    val isUser = item.role == "user"
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
    ) {
        // 与 GUI 一致：每轮回复标注工作模式与模型
        if (!isUser && (item.mode.isNotBlank() || item.model.isNotBlank())) {
            Text(
                text = listOf(item.mode, item.model).filter { it.isNotBlank() }.joinToString(" · "),
                fontSize = 9.5.sp,
                color = NewmarkTextTertiary,
                modifier = Modifier.padding(start = 14.dp, bottom = 2.dp),
            )
        }
        Box(
            modifier = Modifier
                .fillMaxWidth(0.82f)
                .clip(NewmarkShapeLarge)
                .background(if (isUser) NewmarkAccentSoft else NewmarkBgQuaternary)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            Text(
                text = item.content,
                fontSize = 13.sp,
                lineHeight = 19.sp,
                color = NewmarkTextPrimary,
            )
        }
    }
}

@Composable
private fun WorkBlock(event: WorkEvent) {
    var expanded by remember { mutableStateOf(false) }
    val (icon, label) = when (event.type) {
        "tool_call" -> "🔧" to event.toolName.ifBlank { "工具调用" }
        "tool_result" -> "📤" to event.toolName.ifBlank { "工具结果" }
        "thought", "thought_result" -> "💭" to "思考"
        "status" -> "ℹ️" to "状态"
        else -> "⚙️" to event.type.ifBlank { "工作" }
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(NewmarkShapeMedium)
            .background(NewmarkBgPrimary),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(NewmarkBgTertiary)
                .clickable { expanded = !expanded }
                .padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "$icon $label",
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
                color = NewmarkTextSecondary,
                modifier = Modifier.weight(1f),
                maxLines = 1,
            )
            Text(text = if (expanded) "▼" else "▶", fontSize = 9.sp, color = NewmarkTextTertiary)
        }
        if (expanded) {
            val body = event.displayText.ifBlank { event.toolArgs }
            if (body.isNotBlank()) {
                Text(
                    text = body,
                    fontSize = 11.5.sp,
                    lineHeight = 16.sp,
                    color = NewmarkTextSecondary,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.padding(10.dp),
                )
            }
        }
    }
}

@Composable
private fun ThinkingDots() {
    val transition = rememberInfiniteTransition(label = "thinking")
    val alpha by transition.animateFloat(
        initialValue = 0.3f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(600), RepeatMode.Reverse),
        label = "dotAlpha",
    )
    Row(
        modifier = Modifier.padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        listOf(0, 1, 2).forEach { i ->
            Box(
                modifier = Modifier
                    .size(5.dp)
                    .clip(CircleShape)
                    .background(NewmarkTextTertiary.copy(alpha = if (i == 0) alpha else 0.4f)),
            )
        }
    }
}

// ---- 输入区 ----
@Composable
private fun InputArea(running: Boolean, onSend: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("Build") }
    var model by remember { mutableStateOf("GPT-4o") }
    var tier by remember { mutableStateOf("medium") }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(NewmarkBgSecondary),
    ) {
        if (running) {
            MarqueeTopBar()
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .clip(NewmarkShapeLarge)
                .background(NewmarkBgPrimary)
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ModelTierCombo(
                model = model,
                tier = tier,
                onModel = { model = it },
                onTier = { tier = it },
            )
            Spacer(Modifier.width(6.dp))
            PlusCombo(mode = mode, onMode = { mode = it })
            Spacer(Modifier.width(8.dp))
            BasicTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.weight(1f),
                textStyle = TextStyle(
                    color = NewmarkTextPrimary,
                    fontSize = 12.5.sp,
                    lineHeight = 17.sp,
                ),
                decorationBox = { inner ->
                    if (text.isEmpty()) {
                        Text(
                            text = "输入消息...",
                            color = NewmarkTextTertiary,
                            fontSize = 12.5.sp,
                        )
                    }
                    inner()
                },
                maxLines = 4,
            )
            Spacer(Modifier.width(8.dp))
            SubmitButton(
                running = running,
                onClick = {
                    onSend(text)
                    text = ""
                },
            )
        }
    }
}

/** 模型选择 + 智能等级：一级弹窗 → 各自二级弹窗 */
@Composable
private fun ModelTierCombo(
    model: String,
    tier: String,
    onModel: (String) -> Unit,
    onTier: (String) -> Unit,
) {
    var showCombo by remember { mutableStateOf(false) }
    var showModels by remember { mutableStateOf(false) }
    var showTiers by remember { mutableStateOf(false) }

    Box {
        Row(
            modifier = Modifier
                .clip(NewmarkShapeSmall)
                .background(NewmarkBgTertiary)
                .clickable { showCombo = true }
                .padding(horizontal = 6.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text = "🧠", fontSize = 11.sp)
            Spacer(Modifier.width(3.dp))
            Text(text = model, fontSize = 10.5.sp, color = NewmarkTextSecondary, maxLines = 1)
            Text(text = " ▾", fontSize = 9.sp, color = NewmarkTextTertiary)
        }

        DropdownMenu(
            expanded = showCombo,
            onDismissRequest = {
                showCombo = false
                showModels = false
                showTiers = false
            },
        ) {
            Box {
                DropdownMenuItem(
                    text = { Text("模型选择", fontSize = 12.sp, color = NewmarkTextPrimary) },
                    onClick = { showModels = true },
                    trailingIcon = { Text(model, fontSize = 10.5.sp, color = NewmarkTextTertiary) },
                )
                DropdownMenu(
                    expanded = showModels,
                    onDismissRequest = { showModels = false },
                ) {
                    MODELS.forEach { m ->
                        DropdownMenuItem(
                            text = {
                                Text(
                                    m,
                                    fontSize = 12.sp,
                                    color = if (m == model) NewmarkAccent else NewmarkTextSecondary,
                                )
                            },
                            onClick = {
                                onModel(m)
                                showModels = false
                            },
                        )
                    }
                }
            }
            Box {
                DropdownMenuItem(
                    text = { Text("智能等级", fontSize = 12.sp, color = NewmarkTextPrimary) },
                    onClick = { showTiers = true },
                    trailingIcon = { Text(tier, fontSize = 10.5.sp, color = NewmarkTextTertiary) },
                )
                DropdownMenu(
                    expanded = showTiers,
                    onDismissRequest = { showTiers = false },
                ) {
                    TIERS.forEach { t ->
                        DropdownMenuItem(
                            text = {
                                Text(
                                    t,
                                    fontSize = 12.sp,
                                    color = if (t == tier) NewmarkAccent else NewmarkTextSecondary,
                                )
                            },
                            onClick = {
                                onTier(t)
                                showTiers = false
                            },
                        )
                    }
                }
            }
        }
    }
}

/** Build 模式选择 + 选择文件：单个 + 按钮弹出一级弹窗 */
@Composable
private fun PlusCombo(mode: String, onMode: (String) -> Unit) {
    var showMenu by remember { mutableStateOf(false) }
    var showModes by remember { mutableStateOf(false) }
    val context = LocalContext.current

    Box {
        Box(
            modifier = Modifier
                .size(28.dp)
                .clip(CircleShape)
                .background(NewmarkBgTertiary)
                .clickable { showMenu = true },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Filled.Add,
                contentDescription = "模式与文件",
                tint = NewmarkAccent,
                modifier = Modifier.size(18.dp),
            )
        }

        DropdownMenu(
            expanded = showMenu,
            onDismissRequest = {
                showMenu = false
                showModes = false
            },
        ) {
            Box {
                DropdownMenuItem(
                    text = { Text("Build 模式选择", fontSize = 12.sp, color = NewmarkTextPrimary) },
                    onClick = { showModes = true },
                    trailingIcon = { Text(mode, fontSize = 10.5.sp, color = NewmarkTextTertiary) },
                )
                DropdownMenu(
                    expanded = showModes,
                    onDismissRequest = { showModes = false },
                ) {
                    MODES.forEach { m ->
                        DropdownMenuItem(
                            text = {
                                Text(
                                    m,
                                    fontSize = 12.sp,
                                    color = if (m == mode) NewmarkAccent else NewmarkTextSecondary,
                                )
                            },
                            onClick = {
                                onMode(m)
                                showModes = false
                            },
                        )
                    }
                }
            }
            DropdownMenuItem(
                text = { Text("选择文件", fontSize = 12.sp, color = NewmarkTextPrimary) },
                onClick = {
                    showMenu = false
                    Toast.makeText(context, "选择文件（待接入）", Toast.LENGTH_SHORT).show()
                },
            )
        }
    }
}

@Composable
private fun SubmitButton(running: Boolean, onClick: () -> Unit) {
    if (running) {
        MarqueeBorder(
            shape = CircleShape,
            innerColor = NewmarkAccent,
            modifier = Modifier.size(36.dp),
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Icon(
                    imageVector = Icons.Filled.Send,
                    contentDescription = "发送",
                    tint = Color.White,
                    modifier = Modifier.size(15.dp),
                )
            }
        }
    } else {
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(CircleShape)
                .background(NewmarkAccent)
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Filled.Send,
                contentDescription = "发送",
                tint = Color.White,
                modifier = Modifier.size(15.dp),
            )
        }
    }
}
