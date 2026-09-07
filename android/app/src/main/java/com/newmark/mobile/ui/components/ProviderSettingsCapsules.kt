package com.newmark.mobile.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Stable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.zIndex
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.newmark.mobile.ui.theme.LocalNewmarkColors
import com.kyant.backdrop.backdrops.layerBackdrop
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.cancelAndJoin
import kotlin.math.roundToInt

internal val ProviderCapsuleHeight = 44.dp
private val ProviderCapsuleGap = 6.dp
private val ProviderCapsuleShape = RoundedCornerShape(50)
private val LocalProviderRailMoving = staticCompositionLocalOf { false }
private val ProviderRailEase = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)
/** 供应商模型横向/纵向浮块包边：共享边带基础上再增加 2dp。 */
internal val ProviderRailInteractionGlassEdge = MobileInteractionGlassEdge + 2.dp
internal val ProviderRailRefractionAmount = 24.dp

internal enum class ProviderRailAxis { Vertical, Horizontal }

@Stable
class ProviderRailMotionCoordinator internal constructor() {
    private var activeAxis by mutableStateOf<ProviderRailAxis?>(null)

    internal fun acquire(axis: ProviderRailAxis): Boolean {
        if (activeAxis != null && activeAxis != axis) return false
        activeAxis = axis
        return true
    }

    internal fun release(axis: ProviderRailAxis) {
        if (activeAxis == axis) activeAxis = null
    }
}

@Composable
fun rememberProviderRailMotionCoordinator(): ProviderRailMotionCoordinator =
    remember { ProviderRailMotionCoordinator() }

@Composable
fun ProviderCapsuleRow(
    label: String,
    modifier: Modifier = Modifier,
    detail: String = "",
    active: Boolean = false,
    enabled: Boolean = true,
    onClick: (() -> Unit)? = null,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    val p = LocalNewmarkColors.current
    val click = if (onClick == null) Modifier else Modifier.clickable(
        enabled = enabled,
        interactionSource = remember { MutableInteractionSource() },
        indication = null,
        onClick = onClick,
    )
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(ProviderCapsuleHeight)
            .clip(ProviderCapsuleShape)
            .background(if (active && !LocalProviderRailMoving.current) p.accentSoft else p.bgSecondary)
            .then(click)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.material3.Text(
            text = label,
            fontSize = 12.sp,
            color = if (active) p.accent else p.textPrimary,
            maxLines = 1,
            modifier = Modifier.weight(1f),
        )
        if (detail.isNotBlank()) {
            androidx.compose.material3.Text(
                text = detail,
                fontSize = 10.5.sp,
                color = p.textTertiary,
                maxLines = 1,
                modifier = Modifier.weight(1f),
            )
        }
        trailing()
    }
}

/**
 * Button-sized provider action glass. It is intentionally independent from
 * the full-width vertical selector: the optical float is constrained to this
 * button, keeps the shared 4dp resisted drag, and commits only after the
 * complete lift/landing cycle has returned to the button.
 */
@Composable
fun ProviderCapsuleAction(
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    active: Boolean = false,
    onClick: () -> Unit,
) {
    val p = LocalNewmarkColors.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    var widthPx by remember { mutableIntStateOf(0) }
    var lifted by remember { mutableStateOf(false) }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(ProviderCapsuleHeight)
            .zIndex(if (lifted) 8f else 0f)
            .onSizeChanged { widthPx = it.width },
        // The parent is the Row sibling; elevating only its child cannot put
        // a landing glass surface above the neighboring action's parent.
    ) {
        if (widthPx > 0) {
            GlassButtonCanvas(
                visualWidth = with(density) { widthPx.toDp() },
                visualHeight = ProviderCapsuleHeight,
                shape = ProviderCapsuleShape,
                surfaceColor = if (active) p.accentSoft else p.bgSecondary,
                alpha = if (active) .58f else .24f,
                enabled = enabled,
                onLiftedChange = { lifted = it },
                onClick = {
                    scope.launch {
                        // glassButtonSurface completes a quick tap as 105ms
                        // lift + 165ms landing; action follows the landing.
                        delay(270)
                        onClick()
                    }
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                androidx.compose.material3.Text(
                    text = label,
                    fontSize = 12.sp,
                    color = if (active) p.accent else p.textPrimary,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
fun ProviderCapsuleField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    password: Boolean = false,
) {
    val p = LocalNewmarkColors.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(ProviderCapsuleHeight)
            .clip(ProviderCapsuleShape)
            .background(p.bgSecondary)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.material3.Text(label, fontSize = 10.5.sp, color = p.textTertiary, maxLines = 1)
        Spacer(Modifier.width(12.dp))
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.weight(1f),
            textStyle = TextStyle(color = p.textPrimary, fontSize = 12.sp),
            visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
            singleLine = true,
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterEnd) {
                    if (value.isEmpty()) {
                        androidx.compose.material3.Text(placeholder, fontSize = 11.sp, color = p.textTertiary, maxLines = 1)
                    }
                    inner()
                }
            },
        )
    }
}

@Composable
fun ProviderVerticalCapsuleRail(
    itemCount: Int,
    selectedIndex: Int,
    onSelected: (Int) -> Unit,
    modifier: Modifier = Modifier,
    coordinator: ProviderRailMotionCoordinator = rememberProviderRailMotionCoordinator(),
    horizontalBarrierIndices: Set<Int> = emptySet(),
    selectableIndices: Set<Int> = (0 until itemCount).toSet(),
    itemContent: @Composable (Int) -> Unit,
) {
    if (itemCount <= 0) return
    val p = LocalNewmarkColors.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val slotPx = with(density) { (ProviderCapsuleHeight + ProviderCapsuleGap).toPx() }
    val trackHeight = ProviderCapsuleHeight * itemCount + ProviderCapsuleGap * (itemCount - 1)
    var moving by remember { mutableStateOf(false) }
    var dragging by remember { mutableStateOf(false) }
    val glassLift = remember { Animatable(0f) }
    val glassTopPx = remember { Animatable(selectedIndex.coerceIn(0, itemCount - 1) * slotPx) }
    val glassContact = rememberLiquidContactState()
    val dragFollower = rememberLiquidDragFollower()
    var dragTargetTopPx by remember { mutableFloatStateOf(glassTopPx.value) }
    var glassVelocityY by remember { mutableFloatStateOf(0f) }
    var flightJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    var activeIndex by remember(selectedIndex, itemCount) { mutableIntStateOf(selectedIndex.coerceIn(0, itemCount - 1)) }
    val utilityBackdrop = rememberLiquidBackdrop()
    val barriers = horizontalBarrierIndices.filter { it in 0 until itemCount }.toSet()
    val selectable = selectableIndices.filter { it in 0 until itemCount && it !in barriers }.toSet()
    fun nearestSelectable(index: Int, direction: Float = 0f): Int {
        val clamped = index.coerceIn(0, itemCount - 1)
        if (clamped in selectable) return clamped
        val candidates = selectable.sortedWith(compareBy<Int> {
            val directionalPenalty = when {
                direction > 0f && it < clamped -> 1
                direction < 0f && it > clamped -> 1
                else -> 0
            }
            directionalPenalty
        }.thenBy { kotlin.math.abs(it - clamped) })
        return candidates.firstOrNull() ?: clamped
    }
    fun physicalIndexAt(y: Float): Int =
        (y.coerceAtLeast(0f) / slotPx.coerceAtLeast(1f)).toInt().coerceIn(0, itemCount - 1)
    fun indexAt(y: Float, direction: Float = 0f): Int = nearestSelectable(
        physicalIndexAt(y),
        direction,
    )
    fun crossedBarrier(start: Int, target: Int): Int? = barriers.firstOrNull { barrier ->
        barrier > minOf(start, target) && barrier < maxOf(start, target)
    }
    suspend fun flySegment(target: Int, hold: Boolean) = runOverlappedLiquidFlight(
        holdKeepsLifted = hold,
        lift = { glassLift.animateTo(1f, tween(100, easing = ProviderRailEase)) },
        move = { glassTopPx.animateTo(target * slotPx, tween(380, easing = ProviderRailEase)) },
        onLandingStarted = {},
        land = { glassLift.animateTo(0f, tween(240, easing = ProviderRailEase)) },
    )
    fun startFlight(target: Int, hold: Boolean) {
        if (!coordinator.acquire(ProviderRailAxis.Vertical)) return
        val start = if (moving) glassTopPx.value else activeIndex * slotPx
        val interruptedFlight = flightJob
        interruptedFlight?.cancel()
        activeIndex = target
        moving = true
        dragging = false
        flightJob = scope.launch {
            interruptedFlight?.join()
            glassTopPx.snapTo(start)
            val startIndex = nearestSelectable((start / slotPx).roundToInt())
            val barrier = crossedBarrier(startIndex, target)
            if (!hold && barrier != null) {
                val before = if (target > startIndex) barrier - 1 else barrier + 1
                val after = if (target > startIndex) barrier + 1 else barrier - 1
                flySegment(nearestSelectable(before), hold = false)
                moving = false
                glassTopPx.snapTo(nearestSelectable(after) * slotPx)
                kotlinx.coroutines.yield()
                moving = true
                flySegment(target, hold = false)
            } else {
                flySegment(target, hold)
            }
            if (!hold) {
                moving = false; glassVelocityY = 0f; coordinator.release(ProviderRailAxis.Vertical); onSelected(target)
            }
        }
    }
    LaunchedEffect(selectedIndex, itemCount) {
        val target = selectedIndex.coerceIn(0, itemCount - 1)
        activeIndex = target
        if (!moving) glassTopPx.snapTo(nearestSelectable(target) * slotPx)
    }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(trackHeight)
            .testTag("provider-vertical-rail")
            .semantics {
                contentDescription = "纵向设置胶囊浮块"
                stateDescription = "${activeIndex + 1}/$itemCount"
            }
            .liquidHoldDragGesture(
            itemCount,
            selectedIndex,
            selectable,
            canStartAt = { position ->
                physicalIndexAt(position.y) in selectable
            },
            contact = glassContact,
            onTap = { startFlight(indexAt(it.y), hold = false) },
            onHoldStart = { startFlight(indexAt(it.y), hold = true) },
            onDrag = { position, delta ->
                if (!coordinator.acquire(ProviderRailAxis.Vertical)) return@liquidHoldDragGesture
                if (!dragging) {
                    flightJob?.cancel()
                    dragTargetTopPx = glassTopPx.value
                    dragFollower.startFrom(glassTopPx.value)
                    dragging = true
                    moving = true
                    flightJob = scope.launch { glassLift.animateTo(1f, tween(100, easing = ProviderRailEase)) }
                }
                val candidate = indexAt(position.y, delta.y)
                val current = nearestSelectable((dragTargetTopPx / slotPx).roundToInt())
                val barrier = crossedBarrier(current, candidate)
                activeIndex = if (barrier == null) candidate else current
                val segmentMinimum = ((barriers.filter { it < current }.maxOrNull() ?: -1) + 1) * slotPx
                val segmentMaximum = ((barriers.filter { it > current }.minOrNull() ?: itemCount) - 1) * slotPx
                val resisted = resistedLiquidBoundaryPosition(position.y - with(density) { ProviderCapsuleHeight.toPx() } / 2f, segmentMinimum, segmentMaximum, with(density) { 4.dp.toPx() })
                dragTargetTopPx = resisted
                dragFollower.updateTarget(resisted)
                glassVelocityY = delta.y * 60f
            },
            onHoldEnd = { _, _ ->
                val commit = activeIndex
                val interruptedFlight = flightJob
                flightJob = scope.launch {
                    interruptedFlight?.cancelAndJoin()
                    moving = true
                    if (dragging) glassTopPx.snapTo(dragFollower.stopAndRead())
                    dragging = false
                    runOverlappedLiquidFlight(
                        lift = { glassLift.animateTo(1f, tween(100, easing = ProviderRailEase)) },
                        move = { glassTopPx.animateTo(commit * slotPx, tween(180, easing = ProviderRailEase)) },
                        onLandingStarted = {},
                        land = { glassLift.animateTo(0f, tween(240, easing = ProviderRailEase)) },
                    )
                    moving = false; glassVelocityY = 0f; coordinator.release(ProviderRailAxis.Vertical); onSelected(commit)
                }
            },
            onCancel = {
                dragFollower.cancel()
                flightJob?.cancel(); moving = false; dragging = false; glassVelocityY = 0f
                activeIndex = selectedIndex.coerceIn(0, itemCount - 1)
                scope.launch { glassTopPx.snapTo(activeIndex * slotPx); glassLift.snapTo(0f) }
                coordinator.release(ProviderRailAxis.Vertical)
            },
            ),
    ) {
        Column(Modifier.fillMaxWidth().layerBackdrop(utilityBackdrop)) {
                repeat(itemCount) { index ->
                Box(Modifier.fillMaxWidth().height(ProviderCapsuleHeight)) {
                    if (!moving && index == activeIndex && index in selectable) {
                        Box(Modifier.fillMaxWidth().height(ProviderCapsuleHeight).background(p.accentSoft, ProviderCapsuleShape))
                    }
                    CompositionLocalProvider(LocalProviderRailMoving provides moving) {
                        itemContent(index)
                    }
                }
                if (index < itemCount - 1) Spacer(Modifier.height(ProviderCapsuleGap))
            }
        }
        if (moving) {
            BoxWithConstraints(Modifier.fillMaxWidth().height(ProviderCapsuleHeight)) {
                val envelope = with(density) {
                    expandedLiquidBounds(Size(maxWidth.toPx(), ProviderCapsuleHeight.toPx()), GlassButtonCanvasOutset.toPx(), glassLift.value)
                }
                // Grow the actual supported capsule shape equally outwards;
                // an inset shape erased the expansion and broke the lens shader.
                Box(
                    Modifier
                        .wrapContentSize(Alignment.TopStart, unbounded = true)
                        .requiredSize(with(density) { envelope.width.toDp() }, with(density) { envelope.height.toDp() })
                        .graphicsLayer {
                            translationX = envelope.left
                            translationY = (if (dragging) dragFollower.value else glassTopPx.value) + envelope.top
                        }
                        .graphicsLayer { clip = false }
                        .liquidMotionDeformationDeferred({ 0f }, { if (dragging) dragFollower.velocity else glassVelocityY }, density.density)
                        .zIndex(8f)
                        .testTag("provider-vertical-glass")
                        .liquidSelectionMorph(backdrop = utilityBackdrop, shape = ProviderCapsuleShape, fillColor = p.accentSoft, glassProgress = glassLift.value, glassAlpha = 0.18f, blurRadius = 2.dp, refractionHeight = ProviderRailInteractionGlassEdge, refractionAmount = ProviderRailRefractionAmount,
                            contact = glassContact,
                            contactGeometry = {
                                glassTopPx.value; glassLift.value; dragging
                                dragFollower.value; dragFollower.velocity; glassVelocityY
                            },
                        ),
                ) {}
            }
        }
    }
}

@Composable
fun ProviderProtocolRail(
    options: List<Pair<String, String>>,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    coordinator: ProviderRailMotionCoordinator = rememberProviderRailMotionCoordinator(),
) {
    if (options.isEmpty()) return
    val p = LocalNewmarkColors.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    var widthPx by remember { mutableIntStateOf(0) }
    var dragging by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf(false) }
    val glassLift = remember { Animatable(0f) }
    var dragX by remember { mutableFloatStateOf(0f) }
    var holdFlightActive by remember { mutableStateOf(false) }
    var velocityX by remember { mutableFloatStateOf(0f) }
    var flightJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    val selectedIndex = options.indexOfFirst { it.first == value }.coerceAtLeast(0)
    val thumbX = remember { Animatable(0f) }
    val glassContact = rememberLiquidContactState()
    val dragFollower = rememberLiquidDragFollower()
    val slotPx = if (widthPx > 0) widthPx.toFloat() / options.size else 0f
    fun indexAt(x: Float) = (x / slotPx.coerceAtLeast(1f)).toInt().coerceIn(0, options.lastIndex)
    val utilityBackdrop = rememberLiquidBackdrop()
    fun settle(index: Int, commit: Boolean, fromDrag: Boolean = false) {
        if (!coordinator.acquire(ProviderRailAxis.Horizontal)) return
        val interruptedFlight = flightJob
        interruptedFlight?.cancel()
        flightJob = scope.launch {
            interruptedFlight?.join()
            moving = true
            if (fromDrag && dragging) {
                // Transfer the released thumb position into the animatable
                // before starting the final flight. Clear dragging now so the
                // renderer follows thumbX during the move instead of keeping
                // the old dragX until the color block flashes into place.
                thumbX.snapTo(dragFollower.stopAndRead())
                dragging = false
            }
            runOverlappedLiquidFlight(
                lift = { glassLift.animateTo(1f, tween(100, easing = ProviderRailEase)) },
                move = { thumbX.animateTo(index * slotPx, tween(if (fromDrag) 120 else 380, easing = ProviderRailEase)) },
                onLandingStarted = {},
                land = { glassLift.animateTo(0f, tween(240, easing = ProviderRailEase)) },
            )
            moving = false
            dragging = false
            velocityX = 0f
            coordinator.release(ProviderRailAxis.Horizontal)
            if (commit) onValueChange(options[index].first)
        }
    }
    LaunchedEffect(selectedIndex, widthPx) {
        if (widthPx > 0 && !dragging && !moving) thumbX.snapTo(selectedIndex * slotPx)
    }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(ProviderCapsuleHeight)
            .background(p.bgQuaternary, ProviderCapsuleShape)
            .onSizeChanged { widthPx = it.width }
            .testTag("provider-protocol-rail")
            .semantics {
                contentDescription = "协议滑轨"
                stateDescription = options[selectedIndex].second
            }
            .liquidHoldDragGesture(
                options,
                value,
                contact = glassContact,
                onTap = { settle(indexAt(it.x), commit = true) },
                onHoldStart = {
                    if (coordinator.acquire(ProviderRailAxis.Horizontal)) {
                        val source = if (moving) thumbX.value else selectedIndex * slotPx
                        val target = indexAt(it.x)
                        val interruptedFlight = flightJob
                        interruptedFlight?.cancel()
                        moving = true; holdFlightActive = true
                        flightJob = scope.launch {
                            interruptedFlight?.join()
                            thumbX.snapTo(source)
                            runOverlappedLiquidFlight(
                                holdKeepsLifted = true,
                                lift = { glassLift.animateTo(1f, tween(100, easing = ProviderRailEase)) },
                                move = { thumbX.animateTo(target * slotPx, tween(380, easing = ProviderRailEase)) },
                                onLandingStarted = {}, land = {},
                            )
                            if (holdFlightActive) {
                                dragX = target * slotPx
                                dragFollower.startFrom(thumbX.value)
                                dragging = true
                            }
                        }
                    }
                },
                onDrag = { position, delta ->
                    if (!dragging) {
                        if (!holdFlightActive) return@liquidHoldDragGesture
                        holdFlightActive = false
                        flightJob?.cancel()
                        dragFollower.startFrom(thumbX.value)
                        dragging = true
                        moving = true
                        flightJob = scope.launch { glassLift.animateTo(1f, tween(100, easing = ProviderRailEase)) }
                    }
                    dragX = resistedLiquidBoundaryPosition(
                        raw = position.x - slotPx / 2f,
                        minimum = 0f,
                        maximum = (options.size - 1) * slotPx,
                        maxDisplacement = with(density) { 4.dp.toPx() },
                    )
                    dragFollower.updateTarget(dragX)
                    velocityX = delta.x * 60f
                },
                onHoldEnd = { position, _ ->
                    holdFlightActive = false
                    if (dragging) {
                        settle(indexAt(dragX + slotPx / 2f), commit = true, fromDrag = true)
                    }
                    else settle(indexAt(position.x), commit = true, fromDrag = true)
                },
                onCancel = {
                    holdFlightActive = false
                    dragFollower.cancel()
                    flightJob?.cancel(); dragging = false; moving = false; velocityX = 0f
                    scope.launch { thumbX.snapTo(selectedIndex * slotPx); glassLift.snapTo(0f) }
                    coordinator.release(ProviderRailAxis.Horizontal)
                },
            ),
    ) {
        if (slotPx > 0f) {
            val thumbModifier = Modifier
                .graphicsLayer { translationX = if (dragging) dragFollower.value else thumbX.value }
                .liquidMotionDeformationDeferred({ if (dragging) dragFollower.velocity else velocityX }, { 0f }, density.density)
                .zIndex(8f)
            if (moving || dragging) {
                // The raised thumb is a real glass envelope. Its optical
                // canvas is larger than the color block so the thick edge is
                // visible during a tap/drag.
                val envelope = with(density) {
                    expandedLiquidBounds(Size(slotPx, ProviderCapsuleHeight.toPx()), GlassButtonCanvasOutset.toPx(), glassLift.value)
                }
                Box(
                    Modifier
                        .wrapContentSize(Alignment.TopStart, unbounded = true)
                        .requiredSize(with(density) { envelope.width.toDp() }, with(density) { envelope.height.toDp() })
                        .graphicsLayer {
                            translationX = (if (dragging) dragFollower.value else thumbX.value) + envelope.left
                            translationY = envelope.top
                        }
                        .zIndex(8f)
                        .testTag("provider-protocol-glass")
                        .liquidMotionDeformationDeferred({ if (dragging) dragFollower.velocity else velocityX }, { 0f }, density.density)
                        .liquidSelectionMorph(backdrop = utilityBackdrop, shape = ProviderCapsuleShape, fillColor = p.accentSoft, glassProgress = glassLift.value, glassAlpha = 0.18f, blurRadius = 2.dp, refractionHeight = ProviderRailInteractionGlassEdge, refractionAmount = ProviderRailRefractionAmount,
                            contact = glassContact,
                            contactGeometry = {
                                thumbX.value; glassLift.value; dragging
                                dragFollower.value; dragFollower.velocity; velocityX
                            },
                        ),
                ) {}
            } else {
                // Resting state is intentionally a flat semantic color block.
                Box(
                    thumbModifier
                        .size(with(density) { slotPx.toDp() }, ProviderCapsuleHeight)
                        .background(p.accentSoft, ProviderCapsuleShape),
                )
            }
        }
        Row(Modifier.fillMaxWidth().height(ProviderCapsuleHeight).layerBackdrop(utilityBackdrop)) {
            options.forEach { (key, label) ->
                Box(Modifier.weight(1f).height(ProviderCapsuleHeight), contentAlignment = Alignment.Center) {
                    androidx.compose.material3.Text(
                        label,
                        fontSize = 10.5.sp,
                        color = if (key == value) p.accent else p.textSecondary,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}
