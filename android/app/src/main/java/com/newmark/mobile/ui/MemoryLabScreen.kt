package com.newmark.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
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
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.layout.onSizeChanged
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
import com.newmark.mobile.ui.theme.NewmarkPalette
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
import kotlinx.coroutines.isActive
import kotlinx.coroutines.android.awaitFrame
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

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

    val (_, predictiveModifier) = predictiveBackMotion({
        if (view == "detail") view = "overview" else onBack()
    }, fadeOnly = dialogMode)
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
            .then(predictiveModifier)
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
                        .clickable {
                            if (value == "detail" && selectedComponent.isBlank()) {
                                selectedComponent = index.components.keys.sorted().firstOrNull().orEmpty()
                                if (selectedComponent.isNotBlank()) loadComponent(selectedComponent)
                            }
                            view = value
                        }
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
                    if (targetState == "detail") {
                        (slideInHorizontally(tween(280)) { it / 5 } + fadeIn(tween(200))) togetherWith
                            (slideOutHorizontally(tween(220)) { -it / 8 } + fadeOut(tween(150)))
                    } else {
                        (slideInHorizontally(tween(280)) { -it / 5 } + fadeIn(tween(200))) togetherWith
                            (slideOutHorizontally(tween(220)) { it / 8 } + fadeOut(tween(150)))
                    }
                },
                label = "memoryLabView",
            ) { v ->
                if (v == "overview") {
                    Overview(index, search, onSelectTag = { tag ->
                        selectedTag = tag
                        selectedComponent = index.tags[tag]?.components?.firstOrNull().orEmpty()
                        if (selectedComponent.isNotBlank()) loadComponent(selectedComponent)
                        view = "detail"
                    }, onSelectComponent = { slug ->
                        val meta = index.components[slug]
                        selectedTag = meta?.tagPaths?.firstOrNull()?.lastOrNull()
                            ?: meta?.tags?.firstOrNull().orEmpty()
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
                        onSelectTag = { tag ->
                            selectedTag = tag
                            selectedComponent = index.tags[tag]?.components?.firstOrNull().orEmpty()
                            if (selectedComponent.isNotBlank()) loadComponent(selectedComponent) else componentContent = ""
                        },
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

// ---- 总览：PC Memory Lab 的二维动态 tag/component 关系云 ----
@Composable
private fun Overview(
    index: MemoryLabIndex,
    search: String,
    onSelectTag: (String) -> Unit,
    onSelectComponent: (String) -> Unit,
) {
    val p = LocalNewmarkPalette.current
    val graph = remember(index) { MemoryCloudGraph.from(index) }
    var focusId by remember(index) { mutableStateOf("") }
    var relationMode by remember { mutableStateOf(MemoryRelationMode.Both) }
    val positions = remember(index) { mutableStateMapOf<String, Offset>() }
    val velocities = remember(index) { mutableMapOf<String, Offset>() }
    var stageSize by remember { mutableStateOf(Size.Zero) }
    var cameraScale by remember { mutableStateOf(.88f) }
    var cameraPan by remember { mutableStateOf(Offset.Zero) }
    var isInteracting by remember { mutableStateOf(false) }
    var flowPhase by remember { mutableFloatStateOf(0f) }

    LaunchedEffect(graph, stageSize) {
        if (stageSize.width <= 0f || graph.nodes.isEmpty()) return@LaunchedEffect
        graph.nodes.forEachIndexed { i, node ->
            if (positions[node.id] == null) {
                if (node.id == "anchor") {
                    positions[node.id] = Offset(stageSize.width / 2f, stageSize.height / 2f)
                    velocities[node.id] = Offset.Zero
                    return@forEachIndexed
                }
                val angle = i * 2.399963f
                val radius = 46f + 24f * sqrt(i.toFloat())
                positions[node.id] = Offset(
                    stageSize.width / 2f + cos(angle) * radius,
                    stageSize.height / 2f + sin(angle) * radius,
                )
                velocities[node.id] = Offset.Zero
            }
        }
        var phase = 0f
        while (isActive) {
            awaitFrame()
            if (isInteracting) continue
            phase += .012f
            flowPhase = (flowPhase + .018f) % 1f
            val forces = graph.nodes.associate { it.id to Offset.Zero }.toMutableMap()
            for (i in graph.nodes.indices) for (j in i + 1 until graph.nodes.size) {
                val a = graph.nodes[i].id; val b = graph.nodes[j].id
                val delta = (positions[a] ?: Offset.Zero) - (positions[b] ?: Offset.Zero)
                val distance2 = (delta.x * delta.x + delta.y * delta.y).coerceAtLeast(900f)
                val force = delta / sqrt(distance2) * (10500f / distance2)
                forces[a] = forces.getValue(a) + force
                forces[b] = forces.getValue(b) - force
            }
            graph.edges.forEach { edge ->
                val delta = (positions[edge.to] ?: Offset.Zero) - (positions[edge.from] ?: Offset.Zero)
                val distance = sqrt(delta.x * delta.x + delta.y * delta.y).coerceAtLeast(1f)
                val spring = delta / distance * ((distance - 128f) * .0055f)
                forces[edge.from] = forces.getValue(edge.from) + spring
                forces[edge.to] = forces.getValue(edge.to) - spring
            }
            graph.nodes.forEach { node ->
                val point = positions.getValue(node.id)
                if (node.id == "anchor") {
                    positions[node.id] = Offset(stageSize.width / 2f, stageSize.height / 2f)
                    velocities[node.id] = Offset.Zero
                    return@forEach
                }
                val centerPull = (Offset(stageSize.width / 2f, stageSize.height / 2f) - point) * .0008f
                // PC overview never becomes a dead diagram: retain a bounded,
                // deterministic low-amplitude drift after the main layout settles.
                val drift = Offset(
                    sin(phase + node.id.hashCode() * .0007f) * .0045f,
                    cos(phase * .83f + node.id.hashCode() * .0009f) * .0045f,
                )
                val velocity = ((velocities[node.id] ?: Offset.Zero) + forces.getValue(node.id) + centerPull + drift) * .86f
                velocities[node.id] = velocity
                positions[node.id] = point + velocity
            }
            if (focusId.isNotBlank()) {
                positions[focusId]?.let { focused ->
                    val target = Offset(stageSize.width / 2f, stageSize.height / 2f) - focused * cameraScale
                    cameraPan += (target - cameraPan) * .06f
                }
            }
        }
    }

    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("记忆 Tag 图谱 · ${index.tags.size} 标签 · ${index.components.size} 组件",
                fontSize = 10.5.sp, color = p.textTertiary, modifier = Modifier.weight(1f))
            Text(relationMode.label, fontSize = 10.sp, color = p.textSecondary,
                modifier = Modifier.clip(RoundedCornerShape(50)).background(p.bgQuaternary).clickable {
                    relationMode = relationMode.next()
                }.padding(horizontal = 8.dp, vertical = 6.dp))
            Text("清除", fontSize = 10.sp, color = p.textSecondary,
                modifier = Modifier.padding(start = 5.dp).clip(RoundedCornerShape(50)).clickable { focusId = "" }.padding(7.dp))
            Text("重置", fontSize = 10.sp, color = p.textSecondary,
                modifier = Modifier.clip(RoundedCornerShape(50)).clickable { cameraScale = .88f; cameraPan = Offset.Zero; focusId = "" }.padding(7.dp))
        }
        Text(if (focusId.isBlank()) "未选择" else "已选择：${graph.nodeMap[focusId]?.label.orEmpty()}",
            color = p.textTertiary, fontSize = 9.5.sp, modifier = Modifier.padding(vertical = 6.dp))
        if (graph.nodes.isEmpty()) {
            EmptyHint("暂无记忆。")
        } else Box(Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp)).background(p.bgSecondary)) {
            Canvas(
                Modifier.fillMaxSize().onSizeChanged { stageSize = Size(it.width.toFloat(), it.height.toFloat()) }
                    // cameraPan/cameraScale change on every drag frame. They
                    // must not be pointerInput keys or Compose cancels the
                    // active gesture coroutine after the first movement.
                    .pointerInput(graph) {
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                            val downWorld = (down.position - cameraPan) / cameraScale
                            val hit = graph.nodes.lastOrNull { node ->
                                val point = positions[node.id] ?: return@lastOrNull false
                                // A 28 px PC pill is too small for fingers. Preserve
                                // its visuals but guarantee a 48 dp screen hit target.
                                val hitWidth = maxOf(node.width, 48f / cameraScale)
                                val hitHeight = maxOf(node.height, 48f / cameraScale)
                                kotlin.math.abs(downWorld.x - point.x) <= hitWidth / 2f &&
                                    kotlin.math.abs(downWorld.y - point.y) <= hitHeight / 2f
                            }
                            down.consume()
                            isInteracting = true
                            var total = Offset.Zero
                            var panning = false
                            while (true) {
                                val event = awaitPointerEvent(PointerEventPass.Initial)
                                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                if (event.changes.none { it.pressed }) {
                                    if (!panning && hit != null) {
                                        if (focusId == hit.id) {
                                            if (hit.slug.isNotBlank()) onSelectComponent(hit.slug) else onSelectTag(hit.tag)
                                        } else focusId = hit.id
                                    }
                                    break
                                }
                                val zoom = event.calculateZoom()
                                val pan = event.calculatePan()
                                total += pan
                                if (!panning && (total.getDistance() >= viewConfiguration.touchSlop || kotlin.math.abs(zoom - 1f) > .01f)) {
                                    panning = true
                                }
                                if (panning) {
                                    val oldScale = cameraScale
                                    val nextScale = (oldScale * zoom).coerceIn(.0001f, 10_000f)
                                    val centroid = event.calculateCentroid(useCurrent = false)
                                    cameraPan = centroid - (centroid - cameraPan) * (nextScale / oldScale) + pan
                                    cameraScale = nextScale
                                }
                                event.changes.forEach { it.consume() }
                            }
                            isInteracting = false
                        }
                    },
            ) {
                fun screen(point: Offset) = point * cameraScale + cameraPan
                val related = graph.related(focusId, relationMode)
                // Switch to PC-style dots as soon as the graph label would
                // fall below the smallest readable page text (9 px), rather
                // than waiting for the old distant-zoom threshold.
                val nodeLabelFontPx = 11f * cameraScale
                val minimumPageFontPx = 9f
                val dotMode = nodeLabelFontPx < minimumPageFontPx
                val gridStep = 38f * cameraScale
                if (gridStep >= 10f) {
                    var x = cameraPan.x % gridStep
                    while (x < size.width) { drawLine(Color.White.copy(alpha = .035f), Offset(x, 0f), Offset(x, size.height), 1f); x += gridStep }
                    var y = cameraPan.y % gridStep
                    while (y < size.height) { drawLine(Color.White.copy(alpha = .035f), Offset(0f, y), Offset(size.width, y), 1f); y += gridStep }
                }
                graph.edges.forEach { edge ->
                    val a = positions[edge.from] ?: return@forEach
                    val b = positions[edge.to] ?: return@forEach
                    val hot = focusId.isBlank() || edge in related.edges
                    val edgeColor = when {
                        edge in related.parents -> Color(0xFFF6C96B).copy(alpha = .78f)
                        edge in related.children -> Color(0xFF74DFB0).copy(alpha = .72f)
                        hot -> Color(0xFF7EDCFF).copy(alpha = .78f)
                        else -> Color(0xFF96A8D2).copy(alpha = .08f)
                    }
                    val start = screen(a); val end = screen(b)
                    drawLine(edgeColor, start, end, if (hot) 1.45f else 1.05f)
                    if (focusId.isNotBlank() && hot) {
                        val flowColor = when {
                            edge in related.parents -> Color(0xFFF6C96B).copy(alpha = .88f)
                            edge in related.children -> Color(0xFF74DFB0).copy(alpha = .82f)
                            else -> Color(0xFF7EDCFF).copy(alpha = .82f)
                        }
                        val t0 = flowPhase
                        val t1 = (t0 + .09f).coerceAtMost(1f)
                        drawLine(flowColor, start + (end - start) * t0, start + (end - start) * t1, 1.7f)
                    }
                }
                graph.nodes.forEach { node ->
                    val center = screen(positions[node.id] ?: return@forEach)
                    val hot = focusId.isBlank() || node.id in related.nodes
                    val focused = node.id == focusId
                    val width = node.width * cameraScale
                    val height = node.height * cameraScale
                    val pillRadius = height / 2f
                    val tone = node.color(p)
                    if (dotMode) {
                        // PC .zoom-dots uses a fixed 10x10 screen pixel,
                        // borderless solid node. Only its position follows
                        // camera scale; the dot itself does not shrink again.
                        drawCircle(tone.copy(alpha = if (hot) .18f else .04f), 8.5f, center)
                        drawCircle(tone.copy(alpha = if (hot) 1f else .18f), 5f, center)
                        return@forEach
                    }
                    drawRoundRect(
                        color = if (focused) p.accentSoft else p.bgTertiary.copy(alpha = if (hot) .96f else .18f),
                        topLeft = Offset(center.x - width / 2f, center.y - height / 2f),
                        size = Size(width, height), cornerRadius = androidx.compose.ui.geometry.CornerRadius(pillRadius),
                    )
                    if (focused) {
                        drawRoundRect(p.accent.copy(alpha = .11f), Offset(center.x - width / 2f - 5f, center.y - height / 2f - 5f),
                            Size(width + 10f, height + 10f), androidx.compose.ui.geometry.CornerRadius((height + 10f) / 2f))
                    }
                    drawRoundRect(
                        color = if (focused) p.accent else tone.copy(alpha = if (hot) .58f else .12f),
                        topLeft = Offset(center.x - width / 2f, center.y - height / 2f), size = Size(width, height),
                        cornerRadius = androidx.compose.ui.geometry.CornerRadius(pillRadius), style = Stroke(1f * cameraScale),
                    )
                    drawCircle(tone.copy(alpha = if (hot) 1f else .18f), 4.5f * cameraScale, Offset(center.x - width / 2f + 11.5f * cameraScale, center.y))
                    drawContext.canvas.nativeCanvas.drawText(
                        node.label.take(22), center.x - width / 2f + 22f * cameraScale, center.y + 4f * cameraScale,
                        android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                            color = memoryLabOverviewLabelColor(p, hot).toArgb()
                            textSize = 11f * cameraScale
                        },
                    )
                }
            }
        }
    }
}

internal fun memoryLabOverviewLabelColor(p: NewmarkPalette, emphasized: Boolean): Color =
    if (emphasized) p.textPrimary else p.textSecondary.copy(alpha = .72f)

private enum class MemoryRelationMode(val label: String) {
    Both("双向"), Parents("父链"), Children("子树"), Direct("直接");
    fun next() = entries[(ordinal + 1) % entries.size]
}

private data class MemoryCloudNode(val id: String, val label: String, val tag: String = "", val slug: String = "", val type: String, val width: Float, val height: Float = 28f) {
    fun color(p: com.newmark.mobile.ui.theme.NewmarkPalette) = when (type) {
        "root", "anchor" -> androidx.compose.ui.graphics.Color(0xFFF6C96B)
        "leaf" -> androidx.compose.ui.graphics.Color(0xFF74DFB0)
        "component" -> androidx.compose.ui.graphics.Color(0xFFE8EEF8)
        else -> androidx.compose.ui.graphics.Color(0xFFB7A0FF)
    }
}
private data class MemoryCloudEdge(val from: String, val to: String, val type: String)
private data class MemoryCloudRelated(
    val nodes: Set<String>,
    val edges: Set<MemoryCloudEdge>,
    val parents: Set<MemoryCloudEdge>,
    val children: Set<MemoryCloudEdge>,
)
private data class MemoryCloudGraph(val nodes: List<MemoryCloudNode>, val edges: List<MemoryCloudEdge>) {
    val nodeMap = nodes.associateBy { it.id }
    fun related(id: String, mode: MemoryRelationMode): MemoryCloudRelated {
        if (id.isBlank()) return MemoryCloudRelated(nodes.map { it.id }.toSet(), edges.toSet(), emptySet(), emptySet())
        val parentEdges = mutableSetOf<MemoryCloudEdge>()
        val childEdges = mutableSetOf<MemoryCloudEdge>()
        fun up(cursor: String) { edges.filter { it.to == cursor }.forEach { if (parentEdges.add(it)) up(it.from) } }
        fun down(cursor: String) { edges.filter { it.from == cursor }.forEach { if (childEdges.add(it)) down(it.to) } }
        when (mode) {
            MemoryRelationMode.Both -> { up(id); down(id) }
            MemoryRelationMode.Parents -> up(id)
            MemoryRelationMode.Children -> down(id)
            MemoryRelationMode.Direct -> edges.filter { it.from == id || it.to == id }.forEach {
                if (it.to == id) parentEdges += it else childEdges += it
            }
        }
        val selected = parentEdges + childEdges
        return MemoryCloudRelated(buildSet { add(id); selected.forEach { add(it.from); add(it.to) } }, selected, parentEdges, childEdges)
    }
    companion object {
        fun from(index: MemoryLabIndex): MemoryCloudGraph {
            val nodes = mutableListOf(MemoryCloudNode("anchor", "Memory Lab", type = "anchor", width = 96f, height = 32f))
            val edges = mutableSetOf<MemoryCloudEdge>()
            index.tags.filterValues { it.parents.none(index.tags::containsKey) }.keys.forEach {
                edges += MemoryCloudEdge("anchor", "tag:$it", "child")
            }
            index.tags.toSortedMap().forEach { (tag, data) ->
                val type = when { data.parents.isEmpty() -> "root"; data.children.isEmpty() -> "leaf"; else -> "tag" }
                nodes += MemoryCloudNode("tag:$tag", tag, tag = tag, type = type, width = (45 + tag.length * 10).coerceAtMost(150).toFloat())
                data.children.forEach { child -> if (child in index.tags) edges += MemoryCloudEdge("tag:$tag", "tag:$child", "tag") }
                data.components.forEach { slug -> if (slug in index.components) edges += MemoryCloudEdge("tag:$tag", "component:$slug", "component") }
            }
            index.components.toSortedMap().forEach { (slug, data) ->
                val label = data.name.ifBlank { slug }
                nodes += MemoryCloudNode("component:$slug", label, slug = slug, type = "component", width = (45 + label.length * 10).coerceAtMost(150).toFloat())
            }
            return MemoryCloudGraph(nodes, edges.toList())
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
    val activeComponent = selectedComponent.takeIf { it in selectedComponents }
        ?: selectedComponents.firstOrNull()
        ?: index.components.keys.sorted().firstOrNull().orEmpty()

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
                        .background(if (slug == activeComponent) p.accentSoft else p.bgSecondary)
                        .clickable { onSelectComponent(slug) }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                ) {
                    Text(meta?.name ?: slug, fontSize = 12.sp, color = p.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        item { Text("核心记忆", fontSize = 10.5.sp, color = p.textTertiary, fontWeight = FontWeight.SemiBold) }
        item {
            val meta = index.components[activeComponent]
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
            .clip(RoundedCornerShape(50))
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
