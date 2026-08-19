package com.newmark.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.newmark.mobile.data.MemoryComponent
import com.newmark.mobile.data.MemoryLabIndex
import com.newmark.mobile.data.MemoryLabStore
import com.newmark.mobile.ui.components.MarqueeBorder
import com.newmark.mobile.ui.components.NewmarkShapeMedium
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkAccent
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkAccentSoft
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkBgPrimary
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkBgQuaternary
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkBgSecondary
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkBgTertiary
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkTextPrimary
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkTextSecondary
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkTextTertiary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Memory Lab 单开页面（移动端适配：只读可视化 + 搜索 + Reindex，写入仅由 Agent 工具完成） */
@Composable
fun MemoryLabScreen(onBack: () -> Unit, dialogMode: Boolean = false) {
    val p = LocalNewmarkPalette.current
    val context = LocalContext.current
    val store = remember { MemoryLabStore(context) }
    var index by remember { mutableStateOf(store.emptyIndex()) }
    var view by remember { mutableStateOf("overview") } // overview | detail

    // 异步加载索引：避免大 index.json 阻塞进入动画与主线程
    LaunchedEffect(Unit) {
        index = withContext(Dispatchers.IO) { store.load() }
    }

    // 预测性返回：detail → overview → 退出
    BackHandler {
        if (view == "detail") view = "overview" else onBack()
    }
    var selectedTag by remember { mutableStateOf("") }
    var selectedComponent by remember { mutableStateOf("") }
    var search by remember { mutableStateOf("") }
    var reindexing by remember { mutableStateOf(false) }
    var componentContent by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    fun loadComponent(slug: String) {
        scope.launch {
            componentContent = withContext(Dispatchers.IO) { store.componentContent(slug) }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(p.bgPrimary)
            .then(if (dialogMode) Modifier else Modifier.statusBarsPadding()),
    ) {
        // 顶栏
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(p.bgSecondary)
                .height(52.dp)
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(p.bgQuaternary)
                    .clickable(onClick = onBack),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.ArrowBack, contentDescription = "返回", tint = p.textPrimary, modifier = Modifier.size(20.dp))
            }
            Text(
                text = "Memory Lab",
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = p.textPrimary,
                modifier = Modifier.padding(horizontal = 12.dp),
            )
        }

        // 视图 tab + Reindex
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            listOf("overview" to "总览", "detail" to "详细").forEach { (value, label) ->
                Box(
                    modifier = Modifier
                        .clip(NewmarkShapeMedium)
                        .background(if (view == value) p.accentSoft else p.bgQuaternary)
                        .clickable { view = value }
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                ) {
                    Text(label, fontSize = 11.5.sp, color = if (view == value) p.accent else p.textSecondary)
                }
                Spacer(Modifier.width(6.dp))
            }
            Spacer(Modifier.weight(1f))
            Box(
                modifier = Modifier
                    .clip(NewmarkShapeMedium)
                    .background(p.bgQuaternary)
                    .clickable(enabled = !reindexing) {
                        reindexing = true
                        scope.launch {
                            index = withContext(Dispatchers.IO) { store.reindex() }
                            reindexing = false
                        }
                    }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            ) {
                Text(
                    text = if (reindexing) "重建中..." else "重建索引",
                    fontSize = 11.sp,
                    color = p.textSecondary,
                )
            }
        }

        // 搜索
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp)
                .clip(NewmarkShapeMedium)
                .background(p.bgSecondary)
                .padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            BasicTextField(
                value = search,
                onValueChange = { search = it },
                modifier = Modifier.fillMaxWidth(),
                textStyle = TextStyle(color = p.textPrimary, fontSize = 12.sp),
                singleLine = true,
                decorationBox = { inner ->
                    if (search.isEmpty()) Text("搜索标签", fontSize = 12.sp, color = p.textTertiary)
                    inner()
                },
            )
        }

        // 内容
        if (reindexing) {
            MarqueeBorder(cornerRadius = 9.dp, modifier = Modifier.padding(12.dp)) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(NewmarkShapeMedium)
                        .background(p.bgSecondary)
                        .padding(16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("正在载入 Memory Lab...", fontSize = 12.sp, color = p.textSecondary)
                }
            }
        } else {
            AnimatedContent(
                targetState = view,
                transitionSpec = {
                    // 纯淡入淡出（与设置页一致，用户判定口径）
                    fadeIn(animationSpec = tween(220)) togetherWith fadeOut(animationSpec = tween(180))
                },
                label = "memoryLabView",
            ) { v ->
                if (v == "overview") {
                    Overview(index, search, onSelectTag = { tag ->
                        selectedTag = tag
                        selectedComponent = ""
                        view = "detail"
                    }, onSelectComponent = { slug ->
                        selectedComponent = slug
                        loadComponent(slug)
                        view = "detail"
                    })
                } else {
                    Detail(
                        index = index,
                        selectedTag = selectedTag,
                        selectedComponent = selectedComponent,
                        componentContent = componentContent,
                        onSelectTag = { tag -> selectedTag = tag; selectedComponent = "" },
                        onSelectComponent = { slug -> selectedComponent = slug; loadComponent(slug) },
                    )
                }
            }
        }
    }
}

/** 非竖屏恢复 PC sub-window 语义；占用更大的可用窗口但仍保留遮罩与关闭层级。 */
@Composable
fun MemoryLabDialog(onDismiss: () -> Unit) {
    val p = LocalNewmarkPalette.current
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(
            modifier = Modifier
                .fillMaxWidth(.94f)
                .fillMaxHeight(.92f)
                .clip(RoundedCornerShape(14.dp))
                .background(p.bgPrimary.copy(alpha = 0.78f))
                .border(1.dp, p.border2, RoundedCornerShape(14.dp)),
        ) {
            MemoryLabScreen(onBack = onDismiss, dialogMode = true)
        }
    }
}

// ---- 总览（移动端适配：节点列表替代力导向图） ----
@Composable
private fun Overview(
    index: MemoryLabIndex,
    search: String,
    onSelectTag: (String) -> Unit,
    onSelectComponent: (String) -> Unit,
) {
    val p = LocalNewmarkPalette.current
    val tags = index.tags.keys.sorted()
    val needle = search.trim().lowercase()
    val visibleTags = if (needle.isEmpty()) tags else tags.filter { it.lowercase().contains(needle) }
    val components = index.components.keys.sorted()

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Text(
                text = "记忆 Tag 图谱 · ${tags.size} 标签 · ${components.size} 组件",
                fontSize = 11.sp,
                color = p.textTertiary,
            )
        }
        if (visibleTags.isEmpty()) {
            item { EmptyHint(if (tags.isEmpty()) "暂无记忆。" else "无匹配标签。") }
        } else {
            item { Text("标签", fontSize = 10.5.sp, color = p.textTertiary, fontWeight = FontWeight.SemiBold) }
            items(visibleTags) { tag ->
                val node = index.tags[tag]
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(NewmarkShapeMedium)
                        .background(p.bgSecondary)
                        .clickable { onSelectTag(tag) }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(tag, fontSize = 12.sp, color = p.textPrimary, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${node?.components?.size ?: 0}", fontSize = 10.5.sp, color = p.textTertiary)
                }
            }
        }
        if (components.isNotEmpty()) {
            item { Text("组件", fontSize = 10.5.sp, color = p.textTertiary, fontWeight = FontWeight.SemiBold) }
            items(components) { slug ->
                val meta = index.components[slug]
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(NewmarkShapeMedium)
                        .background(p.bgTertiary)
                        .clickable { onSelectComponent(slug) }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(meta?.name ?: slug, fontSize = 12.sp, color = p.textPrimary, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

// ---- 详细（三列 tag 图谱 + 组件预览，移动端纵向适配） ----
@Composable
private fun Detail(
    index: MemoryLabIndex,
    selectedTag: String,
    selectedComponent: String,
    componentContent: String,
    onSelectTag: (String) -> Unit,
    onSelectComponent: (String) -> Unit,
) {
    val p = LocalNewmarkPalette.current
    val tags = index.tags.keys.sorted()
    val firstTag = tags.firstOrNull() ?: ""
    val currentTag = selectedTag.ifBlank { firstTag }
    val node = index.tags[currentTag]

    val rootTags = tags.filter { index.tags[it]?.parents.isNullOrEmpty() }.sorted()
    val parentTags = (node?.parents ?: emptyList()).filter { index.tags.containsKey(it) }.sorted()
    val parentColumn = if (parentTags.isNotEmpty()) parentTags else rootTags
    val childTags = (node?.children ?: emptyList()).filter { index.tags.containsKey(it) }.sorted()
    val selectedComponents = (node?.components ?: emptyList()).filter { index.components.containsKey(it) }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (tags.isEmpty()) {
            item { EmptyHint("暂无记忆。") }
            return@LazyColumn
        }
        item { Text(if (parentTags.isNotEmpty()) "父标签" else "根父标签", fontSize = 10.5.sp, color = p.textTertiary, fontWeight = FontWeight.SemiBold) }
        if (parentColumn.isEmpty()) {
            item { EmptyHint("无父标签。") }
        } else {
            item {
                Row(modifier = Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    parentColumn.forEach { tag ->
                        TagChip(tag, selected = false, count = index.tags[tag]?.components?.size ?: 0) { onSelectTag(tag) }
                    }
                }
            }
        }
        item { Text("当前标签", fontSize = 10.5.sp, color = p.textTertiary, fontWeight = FontWeight.SemiBold) }
        item {
            TagChip(currentTag, selected = true, count = node?.components?.size ?: 0) { }
        }
        item { Text("子标签", fontSize = 10.5.sp, color = p.textTertiary, fontWeight = FontWeight.SemiBold) }
        if (childTags.isEmpty()) {
            item { EmptyHint("无子标签。") }
        } else {
            item {
                Row(modifier = Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    childTags.forEach { tag ->
                        TagChip(tag, selected = false, count = index.tags[tag]?.components?.size ?: 0) { onSelectTag(tag) }
                    }
                }
            }
        }
        item { Text("记忆组件", fontSize = 10.5.sp, color = p.textTertiary, fontWeight = FontWeight.SemiBold) }
        if (selectedComponents.isEmpty()) {
            item { EmptyHint("暂无记忆。") }
        } else {
            items(selectedComponents) { slug ->
                val meta = index.components[slug]
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(NewmarkShapeMedium)
                        .background(if (slug == selectedComponent) p.accentSoft else p.bgSecondary)
                        .clickable { onSelectComponent(slug) }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                ) {
                    Text(meta?.name ?: slug, fontSize = 12.sp, color = p.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        item { Text("核心记忆", fontSize = 10.5.sp, color = p.textTertiary, fontWeight = FontWeight.SemiBold) }
        item {
            val meta = index.components[selectedComponent]
            if (meta == null) {
                EmptyHint("请选择记忆组件。")
            } else {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(NewmarkShapeMedium)
                        .background(p.bgSecondary)
                        .padding(12.dp),
                ) {
                    if (meta.description.isNotBlank()) {
                        Text(meta.description, fontSize = 11.sp, color = p.textSecondary, modifier = Modifier.padding(bottom = 6.dp))
                    }
                    Text(
                        text = componentContent.ifBlank { "（无内容）" },
                        fontSize = 11.5.sp,
                        lineHeight = 16.sp,
                        color = p.textPrimary,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }
    }
}

@Composable
private fun TagChip(tag: String, selected: Boolean, count: Int, onClick: () -> Unit) {
    val p = LocalNewmarkPalette.current
    Row(
        modifier = Modifier
            .clip(NewmarkShapeMedium)
            .background(if (selected) p.accentSoft else p.bgQuaternary)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(tag, fontSize = 11.5.sp, color = if (selected) p.accent else p.textPrimary, maxLines = 1)
        if (count > 0) {
            Text(" $count", fontSize = 10.sp, color = p.textTertiary)
        }
    }
}

@Composable
private fun EmptyHint(text: String) {
    val p = LocalNewmarkPalette.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(NewmarkShapeMedium)
            .background(p.bgSecondary)
            .padding(12.dp),
    ) {
        Text(text, fontSize = 11.5.sp, color = p.textTertiary)
    }
}
