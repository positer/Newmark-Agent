package com.newmark.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.newmark.mobile.data.LocalToolExecutor
import com.newmark.mobile.data.TerminalEntry
import com.newmark.mobile.data.TerminalSessionStore
import com.newmark.mobile.ui.components.glassButtonSurface
import com.newmark.mobile.ui.theme.LocalNewmarkColors
import com.newmark.mobile.ui.theme.NewmarkGreen
import com.newmark.mobile.ui.theme.NewmarkRed

/** 命令行终端（参考 tmux：会话持久化，退出后 cwd + 命令/输出历史仍在） */
@Composable
fun TerminalScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val store = remember { TerminalSessionStore(context) }
    val executor = remember { LocalToolExecutor(context) }
    var session by remember { mutableStateOf(store.load("main")) }
    var input by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    val p = LocalNewmarkColors.current

    LaunchedEffect(Unit) {
        executor.restoreCwd(session.cwd)
        if (session.entries.isNotEmpty()) listState.scrollToItem(session.entries.size - 1)
    }

    fun runCommand(cmd: String) {
        val result = executor.execute(cmd)
        val entry = TerminalEntry(command = cmd, output = result.output, ok = result.ok)
        session = session.copy(cwd = executor.cwdPath, entries = session.entries + entry)
        store.save(session)
        input = ""
    }

    val (_, predictiveModifier) = predictiveBackMotion(
        onBack = onBack,
        retainProgressOnCommit = true,
    )

    Column(
        modifier = Modifier
            .fillMaxSize()
            .then(predictiveModifier)
            .background(p.bgPrimary)
            .imePadding(),
    ) {
        // 顶栏
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(p.bgSecondary)
                .statusBarsPadding()
                .height(52.dp)
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .glassButtonSurface(CircleShape, p.bgQuaternary)
                    .clickable(onClick = onBack),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.ArrowBack, contentDescription = "返回", tint = p.textPrimary, modifier = Modifier.size(20.dp))
            }
            Text("命令行", fontSize = 13.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, color = p.textPrimary, modifier = Modifier.padding(horizontal = 12.dp))
        }

        // 会话指示（参考 tmux session 名 + 工作目录）
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(p.bgSecondary)
                .padding(horizontal = 14.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("[${session.name}]", fontSize = 11.sp, color = p.accent, fontFamily = FontFamily.Monospace)
            Spacer(Modifier.width(8.dp))
            Text(executor.cwdPath, fontSize = 10.5.sp, color = p.textTertiary, fontFamily = FontFamily.Monospace, maxLines = 1)
        }

        // 输出历史
        LazyColumn(
            state = listState,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
        ) {
            if (session.entries.isEmpty()) {
                item {
                    Text(
                        text = "输入 help 查看可用命令。会话与历史会自动保存。",
                        fontSize = 11.sp,
                        color = p.textTertiary,
                        modifier = Modifier.padding(vertical = 8.dp),
                    )
                }
            }
            items(session.entries) { entry ->
                Column(Modifier.padding(vertical = 3.dp)) {
                    Text(
                        text = "\$ ${entry.command}",
                        fontSize = 12.sp,
                        color = p.textPrimary,
                        fontFamily = FontFamily.Monospace,
                    )
                    if (entry.output.isNotBlank()) {
                        Text(
                            text = entry.output,
                            fontSize = 11.5.sp,
                            lineHeight = 16.sp,
                            color = if (entry.ok) p.textSecondary else NewmarkRed,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier.padding(start = 10.dp, top = 2.dp),
                        )
                    }
                }
            }
        }

        // 输入区
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .clip(com.newmark.mobile.ui.components.NewmarkShapeExtra)
                .background(p.bgSecondary)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("\$", fontSize = 13.sp, color = p.accent, fontFamily = FontFamily.Monospace)
            Spacer(Modifier.width(8.dp))
            BasicTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.weight(1f),
                textStyle = TextStyle(color = p.textPrimary, fontSize = 13.sp, fontFamily = FontFamily.Monospace),
                singleLine = true,
                decorationBox = { inner ->
                    if (input.isEmpty()) Text("输入命令…", fontSize = 13.sp, color = p.textTertiary, fontFamily = FontFamily.Monospace)
                    inner()
                },
            )
            Spacer(Modifier.width(8.dp))
            Box(
                modifier = Modifier
                    .size(30.dp)
                    .glassButtonSurface(CircleShape, p.accent, alpha = 0.78f)
                    .clickable { if (input.isNotBlank()) runCommand(input.trim()) },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Send, contentDescription = "执行", tint = Color.White, modifier = Modifier.size(14.dp))
            }
        }
    }
}
