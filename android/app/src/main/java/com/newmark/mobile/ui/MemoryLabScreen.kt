package com.newmark.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.newmark.mobile.data.MemoryComponent
import com.newmark.mobile.data.MemoryLabIndex
import com.newmark.mobile.data.MemoryLabStore
import com.newmark.mobile.data.MemoryLabUpdateInput
import com.newmark.mobile.ui.components.MarqueeBorder
import com.newmark.mobile.ui.components.MobilePopupShape
import com.newmark.mobile.ui.components.MobileInteractionGlassEdge
import com.newmark.mobile.ui.components.liquidMotionDeformation
import com.newmark.mobile.ui.components.liquidSelectionMorph
import com.newmark.mobile.ui.components.runOverlappedLiquidFlight
import com.newmark.mobile.ui.components.DialogBackdropBlur
import com.newmark.mobile.ui.components.NewmarkShapeMedium
import com.newmark.mobile.ui.components.glassButtonSurface
import com.newmark.mobile.ui.components.rememberLiquidBackdrop
import com.newmark.mobile.ui.components.liquidGlassModifier
import com.newmark.mobile.ui.components.liquidHoldDragGesture
import com.newmark.mobile.ui.components.LocalSidebarGestureLock
import com.kyant.backdrop.backdrops.layerBackdrop
import com.newmark.mobile.ui.theme.LocalGlassMode
import com.newmark.mobile.ui.theme.LocalNewmarkColors
import com.newmark.mobile.ui.theme.NewmarkAccent
import com.newmark.mobile.ui.theme.NewmarkThemeColors
import com.newmark.mobile.ui.theme.NewmarkAccentSoft
import com.newmark.mobile.ui.theme.NewmarkBgPrimary
import com.newmark.mobile.ui.theme.NewmarkBgQuaternary
import com.newmark.mobile.ui.theme.NewmarkBgSecondary
import com.newmark.mobile.ui.theme.NewmarkBgTertiary
import com.newmark.mobile.ui.theme.NewmarkTextPrimary
import com.newmark.mobile.ui.theme.NewmarkTextSecondary
import com.newmark.mobile.ui.theme.NewmarkTextTertiary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.android.awaitFrame
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** Memory Lab 单开页面（移动端适配：只读可视化 + 搜索 + Reindex，写入仅由 Agent 工具完成） */
@Composable
fun MemoryLabScreen(onBack: () -> Unit, dialogMode: Boolean = false) {
    val p = LocalNewmarkColors.current
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
    },
        fadeOnly = dialogMode,
        retainProgressOnCommit = view == "overview",
        settleProgressOnCommit = view == "detail",
    )
    var selectedTag by remember { mutableStateOf("") }
    var selectedComponent by remember { mutableStateOf("") }
    var search by remember { mutableStateOf("") }
    var reindexing by remember { mutableStateOf(false) }
    var componentContent by remember { mutableStateOf("") }
    var editingSlug by remember { mutableStateOf<String?>(null) }
    var editorOpen by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun loadComponent(slug: String) {
        scope.launch {
            componentContent = withContext(Dispatchers.IO) { store.componentContent(slug) }
        }
    }

    fun selectView(value: String) {
        if (value == "detail" && selectedComponent.isBlank()) {
            selectedComponent = index.components.keys.sorted().firstOrNull().orEmpty()
            if (selectedComponent.isNotBlank()) loadComponent(selectedComponent)
        }
        view = value
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
                    .glassButtonSurface(CircleShape, p.bgQuaternary)
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
            MemoryLabViewPager(view = view, onSelect = ::selectView)
            Spacer(Modifier.weight(1f))
            MemoryLabGlassAction(
                label = "新增",
                accent = true,
                onClick = {
                    editingSlug = null
                    editorOpen = true
                },
            )
            Spacer(Modifier.width(6.dp))
            MemoryLabGlassAction(
                label = if (reindexing) "重建中..." else "重建索引",
                enabled = !reindexing,
                onClick = {
                    reindexing = true
                    scope.launch {
                        index = withContext(Dispatchers.IO) { store.reindex() }
                        reindexing = false
                    }
                },
            )
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
                        onEditComponent = { slug -> editingSlug = slug; editorOpen = true },
                        onDeleteComponent = { slug ->
                            scope.launch {
                                withContext(Dispatchers.IO) {
                                    val meta = store.load().components[slug]
                                    store.delete(slug, meta?.updatedAt.orEmpty(), "User deleted from mobile Memory Lab UI", "mobile_memory_lab_ui")
                                }
                                index = withContext(Dispatchers.IO) { store.load() }
                                selectedComponent = ""
                                componentContent = ""
                            }
                        },
                    )
                }
            }
        }
    }
    if (editorOpen) {
        MemoryLabEditorDialog(
            existingSlug = editingSlug,
            index = index,
            initialContent = editingSlug?.let { store.componentContent(it) }.orEmpty(),
            onDismiss = { editorOpen = false },
            onSave = { input ->
                scope.launch {
                    val result = withContext(Dispatchers.IO) { store.update(input) }
                    index = result.index
                    selectedComponent = result.slug
                    componentContent = input.content
                    editorOpen = false
                    view = "detail"
                }
            },
        )
    }
}

@Composable
private fun MemoryLabViewPager(view: String, onSelect: (String) -> Unit) {
    val p = LocalNewmarkColors.current
    val options = listOf("overview" to "总览", "detail" to "详细")
    val selectedIndex = options.indexOfFirst { it.first == view }.coerceAtLeast(0)
    val slotWidth = 64.dp
    val trackHeight = 46.dp
    val floatWidth = 76.dp
    val floatHeight = 46.dp
    val density = LocalDensity.current
    val pagerBackdrop = rememberLiquidBackdrop()
    val glassX = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val setSidebarGestureLock = LocalSidebarGestureLock.current
    var activeIndex by remember { mutableIntStateOf(selectedIndex) }
    var moving by remember { mutableStateOf(false) }
    var lifting by remember { mutableStateOf(false) }
    var landing by remember { mutableStateOf(false) }
    var draggingGlass by remember { mutableStateOf(false) }
    var draggedGlassX by remember { mutableFloatStateOf(0f) }
    var draggedGlassVelocityX by remember { mutableFloatStateOf(0f) }
    var flightJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    val glassProgress by animateFloatAsState(if (landing || lifting) 0f else if (moving) 1f else 0f, tween(if (landing) 240 else 100), label = "memoryPagerGlassMaterial")
    LaunchedEffect(selectedIndex) {
        if (!moving) {
            activeIndex = selectedIndex
            glassX.snapTo(with(density) { selectedIndex * slotWidth.toPx() - 6.dp.toPx() })
        }
    }
    fun indexAt(x: Float): Int = with(density) {
        (x / slotWidth.toPx()).toInt().coerceIn(options.indices)
    }
    fun flyTo(index: Int, commit: Boolean) {
        val redirecting = moving
        flightJob?.cancel()
        activeIndex = index
        setSidebarGestureLock("memory-lab-view-pager", true)
        if (!redirecting) lifting = true
        moving = true
        flightJob = scope.launch {
            draggingGlass = false
            draggedGlassVelocityX = 0f
            if (!redirecting) {
                glassX.snapTo(with(density) { selectedIndex * slotWidth.toPx() - 6.dp.toPx() })
            }
            val targetX = with(density) { index * slotWidth.toPx() - 6.dp.toPx() }
            val staysInPlace = kotlin.math.abs(glassX.value - targetX) < 0.5f
            runOverlappedLiquidFlight(
                lift = { kotlinx.coroutines.yield(); lifting = false; delay(100) },
                move = { if (!staysInPlace) glassX.animateTo(targetX, tween(380)) },
                onLandingStarted = { landing = true },
                land = { delay(240) },
            )
            landing = false
            moving = false
            setSidebarGestureLock("memory-lab-view-pager", false)
            if (commit) onSelect(options[index].first)
        }
    }
    fun holdAt(index: Int) {
        val redirecting = moving
        flightJob?.cancel()
        activeIndex = index
        setSidebarGestureLock("memory-lab-view-pager", true)
        if (!redirecting) lifting = true
        moving = true
        flightJob = scope.launch {
            draggingGlass = false
            draggedGlassVelocityX = 0f
            if (!redirecting) {
                glassX.snapTo(with(density) { selectedIndex * slotWidth.toPx() - 6.dp.toPx() })
            }
            runOverlappedLiquidFlight(
                holdKeepsLifted = true,
                lift = { kotlinx.coroutines.yield(); lifting = false; delay(100) },
                move = { glassX.animateTo(with(density) { index * slotWidth.toPx() - 6.dp.toPx() }, tween(380)) },
                onLandingStarted = {}, land = {},
            )
        }
    }
    Box(
        Modifier
            .width(slotWidth * options.size)
            .height(trackHeight)
            .background(p.bgQuaternary, RoundedCornerShape(50))
            .liquidHoldDragGesture(
                options.size,
                selectedIndex,
                onCandidateStart = { setSidebarGestureLock("memory-pager-candidate", true) },
                onCandidateEnd = { setSidebarGestureLock("memory-pager-candidate", false) },
                onTap = { flyTo(indexAt(it.x), commit = true) },
                onHoldStart = { holdAt(indexAt(it.x)) },
                onDrag = { position, delta ->
                    flightJob?.cancel()
                    moving = true
                    lifting = false
                    draggingGlass = true
                    activeIndex = indexAt(position.x)
                    draggedGlassX = with(density) {
                        (position.x - floatWidth.toPx() / 2f).coerceIn(
                            -6.dp.toPx(),
                            options.size * slotWidth.toPx() - floatWidth.toPx() + 6.dp.toPx(),
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
                             move = { glassX.animateTo(with(density) { commit * slotWidth.toPx() - 6.dp.toPx() }, tween(120)) },
                             onLandingStarted = { landing = true },
                             land = { delay(240) },
                         )
                        landing = false
                        moving = false
                        draggingGlass = false
                        draggedGlassVelocityX = 0f
                        setSidebarGestureLock("memory-lab-view-pager", false)
                        onSelect(options[commit].first)
                    }
                },
                onCancel = {
                    moving = false
                    lifting = false
                    landing = false
                    draggingGlass = false
                    draggedGlassVelocityX = 0f
                    setSidebarGestureLock("memory-lab-view-pager", false)
                },
            ),
    ) {
        Row(
            Modifier
                .fillMaxSize()
                .then(if (moving) Modifier.layerBackdrop(pagerBackdrop) else Modifier),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            options.forEachIndexed { index, (_, label) ->
                Box(
                    Modifier
                        .width(slotWidth)
                        .height(34.dp)
                        .background(if (!moving && index == selectedIndex) p.accentSoft else Color.Transparent, RoundedCornerShape(50)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(label, fontSize = 11.5.sp, color = if (!moving && index == selectedIndex) p.accent else p.textSecondary)
                }
            }
        }
        if (moving) {
            val edgeExpansion = MobileInteractionGlassEdge * 2f * glassProgress
            val landingInset = MobileInteractionGlassEdge * (1f - glassProgress)
            Box(
                Modifier
                    .width(slotWidth + edgeExpansion)
                    .height(34.dp + edgeExpansion)
                     .graphicsLayer {
                         translationX = (if (draggingGlass) draggedGlassX else glassX.value) +
                             with(density) { landingInset.toPx() }
                         translationY = with(density) { landingInset.toPx() }
                    }
                    .liquidMotionDeformation(
                        velocityX = if (draggingGlass) draggedGlassVelocityX else glassX.velocity,
                        velocityY = 0f,
                        density = density.density,
                    )
                    .zIndex(4f)
                    .liquidSelectionMorph(
                        backdrop = pagerBackdrop,
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
}

/** 非竖屏恢复 PC sub-window 语义；占用更大的可用窗口但仍保留遮罩与关闭层级。 */
@Composable
fun MemoryLabDialog(onDismiss: () -> Unit) {
    val p = LocalNewmarkColors.current
    val glass = LocalGlassMode.current
    // Dialog is its own window: capture the dialog background with a local
    // backdrop so the surface can refract what is behind it (Kyant glass).
    val backdrop = rememberLiquidBackdrop()
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        DialogBackdropBlur(42.dp)
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Box(Modifier.fillMaxSize().layerBackdrop(backdrop))
            Box(
                modifier = Modifier
                    .fillMaxWidth(.92f)
                    .fillMaxHeight(.88f)
                    .widthIn(max = 960.dp)
                    .heightIn(max = 720.dp)
                    .liquidGlassModifier(
                        backdrop = backdrop,
                        shape = MobilePopupShape,
                        alpha = 0f,
                        blurRadius = 8.dp,
                        refractionHeight = 5.dp,
                        refractionAmount = 8.dp,
                        surfaceColor = Color.Transparent,
                    )
                    .clip(MobilePopupShape),
            ) {
                MemoryLabScreen(onBack = onDismiss, dialogMode = true)
            }
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
    val p = LocalNewmarkColors.current
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
            MemoryLabGlassAction(label = relationMode.label, compact = true) { relationMode = relationMode.next() }
            Spacer(Modifier.width(5.dp))
            MemoryLabGlassAction(label = "清除", compact = true, enabled = focusId.isNotBlank()) { focusId = "" }
            Spacer(Modifier.width(5.dp))
            MemoryLabGlassAction(label = "重置", compact = true) {
                cameraScale = .88f
                cameraPan = Offset.Zero
                focusId = ""
            }
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

@Composable
private fun MemoryLabGlassAction(
    label: String,
    enabled: Boolean = true,
    accent: Boolean = false,
    compact: Boolean = false,
    onClick: () -> Unit,
) {
    val p = LocalNewmarkColors.current
    val shape = RoundedCornerShape(50)
    val interaction = remember { MutableInteractionSource() }
    val surface = if (accent) p.accentSoft else p.bgQuaternary.copy(alpha = 0.72f)
    Box(
        modifier = Modifier
            .height(if (compact) 32.dp else 34.dp)
            .widthIn(min = if (compact) 52.dp else 58.dp)
            .background(surface.copy(alpha = if (enabled) surface.alpha else surface.alpha * 0.45f), shape)
            .glassButtonSurface(shape, if (accent) p.accent else p.bgQuaternary, alpha = if (accent) 0.28f else 0.16f)
            .clickable(
                enabled = enabled,
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = if (compact) 11.dp else 13.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            fontSize = if (compact) 10.sp else 11.sp,
            fontWeight = if (accent) FontWeight.Medium else FontWeight.Normal,
            color = when {
                !enabled -> p.textTertiary.copy(alpha = 0.5f)
                accent -> p.accent
                else -> p.textSecondary
            },
            maxLines = 1,
        )
    }
}

internal fun memoryLabOverviewLabelColor(p: NewmarkThemeColors, emphasized: Boolean): Color =
    if (emphasized) p.textPrimary else p.textSecondary.copy(alpha = .72f)

private enum class MemoryRelationMode(val label: String) {
    Both("双向"), Parents("父链"), Children("子树"), Direct("直接");
    fun next() = entries[(ordinal + 1) % entries.size]
}

private data class MemoryCloudNode(val id: String, val label: String, val tag: String = "", val slug: String = "", val type: String, val width: Float, val height: Float = 28f) {
    fun color(p: com.newmark.mobile.ui.theme.NewmarkThemeColors) = when (type) {
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
    onEditComponent: (String) -> Unit,
    onDeleteComponent: (String) -> Unit,
) {
    val p = LocalNewmarkColors.current
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
                    Text("组件元数据", fontSize = 10.5.sp, color = p.textTertiary, fontWeight = FontWeight.SemiBold)
                    Text("slug: $activeComponent · kind: ${meta.kind} · revision: ${meta.revision}", fontSize = 10.sp, color = p.textSecondary)
                    Text("标签路径：${meta.tagPaths.joinToString("；") { it.joinToString(" → ") }}", fontSize = 10.sp, color = p.textSecondary)
                    val aliases = meta.tags.flatMap { index.tags[it]?.aliases.orEmpty() }.distinct()
                    Text("别名：${aliases.joinToString().ifBlank { "无" }}", fontSize = 10.sp, color = p.textSecondary, modifier = Modifier.padding(bottom = 8.dp))
                    Text(
                        text = componentContent.ifBlank { "（无内容）" },
                        fontSize = 11.5.sp,
                        lineHeight = 16.sp,
                        color = p.textPrimary,
                        fontFamily = FontFamily.Monospace,
                    )
                    Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("编辑 / 重构", color = p.accent, fontSize = 11.sp, modifier = Modifier.clickable { onEditComponent(activeComponent) }.padding(8.dp))
                        Text("删除", color = Color(0xFFFF7777), fontSize = 11.sp, modifier = Modifier.clickable { onDeleteComponent(activeComponent) }.padding(8.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun MemoryLabEditorDialog(
    existingSlug: String?,
    index: MemoryLabIndex,
    initialContent: String,
    onDismiss: () -> Unit,
    onSave: (MemoryLabUpdateInput) -> Unit,
) {
    val p = LocalNewmarkColors.current
    val existing = existingSlug?.let(index.components::get)
    var name by remember(existingSlug) { mutableStateOf(existing?.name.orEmpty()) }
    var description by remember(existingSlug) { mutableStateOf(existing?.description.orEmpty()) }
    var tags by remember(existingSlug) { mutableStateOf(existing?.tags?.joinToString(", ").orEmpty()) }
    var paths by remember(existingSlug) { mutableStateOf(existing?.tagPaths?.joinToString("\n") { it.joinToString(" → ") }.orEmpty()) }
    var content by remember(existingSlug) { mutableStateOf(initialContent) }
    Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().clip(MobilePopupShape).background(p.bgSecondary).padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Text(if (existing == null) "新增记忆组件" else "编辑 / 重构记忆组件", color = p.textPrimary, fontWeight = FontWeight.SemiBold)
            MemoryEditorField("名称", name) { name = it }
            MemoryEditorField("描述", description) { description = it }
            MemoryEditorField("标签（逗号分隔）", tags) { tags = it }
            MemoryEditorField("标签路径（每行一条，使用 → 分隔）", paths) { paths = it }
            MemoryEditorField("核心 Markdown", content, singleLine = false) { content = it }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Text("取消", color = p.textSecondary, modifier = Modifier.clickable(onClick = onDismiss).padding(10.dp))
                Text("保存", color = p.accent, modifier = Modifier.clickable {
                    val tagList = tags.split(Regex("[,，]")).map(String::trim).filter(String::isNotBlank)
                    val pathList = paths.lines().map { line -> line.split(Regex("\\s*(?:→|>|/)\\s*")).map(String::trim).filter(String::isNotBlank) }.filter(List<String>::isNotEmpty)
                    onSave(MemoryLabUpdateInput(name, description, tagList, pathList, content, existing?.kind ?: "file", existing?.updatedAt.orEmpty(), "Mobile Memory Lab UI edit", "mobile_memory_lab_ui"))
                }.padding(10.dp))
            }
        }
    }
}

@Composable
private fun MemoryEditorField(label: String, value: String, singleLine: Boolean = true, onValueChange: (String) -> Unit) {
    val p = LocalNewmarkColors.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, color = p.textTertiary, fontSize = 10.sp)
        BasicTextField(value, onValueChange, Modifier.fillMaxWidth().heightIn(min = if (singleLine) 38.dp else 120.dp).clip(NewmarkShapeMedium).background(p.bgTertiary).padding(10.dp),
            textStyle = TextStyle(color = p.textPrimary, fontSize = 11.sp), singleLine = singleLine)
    }
}

@Composable
private fun TagChip(tag: String, selected: Boolean, count: Int, onClick: () -> Unit) {
    val p = LocalNewmarkColors.current
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
    val p = LocalNewmarkColors.current
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
