package com.newmark.mobile.ui

import android.Manifest
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Dangerous
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.produceState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import com.newmark.mobile.data.INTELLIGENCE_TIERS
import com.newmark.mobile.data.LocalWorkEvent
import com.newmark.mobile.data.LocalWorkRun
import kotlinx.coroutines.delay
import com.newmark.mobile.data.LocalImageAttachment
import com.newmark.mobile.data.ModelOption
import com.newmark.mobile.data.RemoteGoal
import com.newmark.mobile.data.RemoteFlowTakeover
import com.newmark.mobile.data.LocalQueuedMessage
import com.newmark.mobile.data.RemoteConversationImage
import com.newmark.mobile.data.WorkGuide
import com.newmark.mobile.data.WorkRunProjection
import com.newmark.mobile.ui.components.LucideIcons
import com.newmark.mobile.ui.components.MarqueeBorder
import com.newmark.mobile.ui.components.MobileInteractionGlassEdge
import com.newmark.mobile.ui.components.MobilePopupShape
import com.newmark.mobile.ui.components.MarkdownBody
import com.newmark.mobile.ui.components.MenuRow
import com.newmark.mobile.ui.components.NewmarkShapeLarge
import com.newmark.mobile.ui.components.NewmarkShapeExtra
import com.newmark.mobile.ui.components.NewmarkShapeMedium
import com.newmark.mobile.ui.components.NewmarkShapeSmall
import com.newmark.mobile.ui.components.glassButtonSurface
import com.newmark.mobile.ui.components.GlassButtonCanvas
import com.newmark.mobile.ui.components.liquidGlassModifier
import com.newmark.mobile.ui.components.liquidHoldDragGesture
import com.newmark.mobile.ui.components.liquidMotionDeformationDeferred
import com.newmark.mobile.ui.components.liquidSelectionMorph
import com.newmark.mobile.ui.components.runOverlappedLiquidFlight
import com.newmark.mobile.ui.components.resistedLiquidBoundaryPosition
import com.newmark.mobile.ui.components.rememberLiquidBackdrop
import com.newmark.mobile.ui.components.LocalSidebarGestureLock
import com.kyant.backdrop.Backdrop
import com.kyant.backdrop.backdrops.layerBackdrop
import com.newmark.mobile.ui.theme.NewmarkAccent
import com.newmark.mobile.ui.theme.LocalNewmarkColors
import com.newmark.mobile.ui.theme.LocalThemeMode
import com.newmark.mobile.ui.theme.NewmarkAccentBorder
import com.newmark.mobile.ui.theme.NewmarkAccentSoft
import com.newmark.mobile.ui.theme.NewmarkBgPrimary
import com.newmark.mobile.ui.theme.NewmarkBgQuaternary
import com.newmark.mobile.ui.theme.NewmarkBgSecondary
import com.newmark.mobile.ui.theme.NewmarkBgTertiary
import com.newmark.mobile.ui.theme.NewmarkBorder
import com.newmark.mobile.ui.theme.NewmarkTextPrimary
import com.newmark.mobile.ui.theme.NewmarkTextSecondary
import com.newmark.mobile.ui.theme.NewmarkTextTertiary
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val MODES = listOf("Build", "Plan", "Chat", "Goal", "Flow")
private val PcQueueEase = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)
private enum class InputCompositeMenu { PlusMain, PlusModes, ModelMain, Models, Tiers }

// PC `#chat-area` / `.conversation-work-run` layout contract.  These are
// deliberately shared so long text never touches a timeline rail or the chat
// area's visual edge when the phone is narrow.
private val ChatAreaHorizontalInset = 24.dp
private val WorkRunContentStartInset = 24.dp
private val WorkRunRightSafeInset = 34.dp
internal val MobileReadableStartInset = 24.dp
internal val MobileReadableEndInset = 34.dp
internal const val InputComposerMaxLines = 5
internal val InputComposerCornerRadius = 24.dp
internal val InputComposerSingleLineOpticalOffset = (-1).dp
internal val InputComposerEdgeControlSize = 36.dp
internal val InputComposerPlusSize = 28.dp
internal val InputComposerPlusBottomOffset = 4.dp
internal val InputComposerHorizontalCenterCompensation = 2.dp

internal fun centeredInputMenuX(
    anchor: Rect,
    popupWidthPx: Int,
    viewportWidthPx: Int,
    marginPx: Int,
): Int {
    val preferred = (anchor.center.x - popupWidthPx / 2f).roundToInt()
    val maxX = (viewportWidthPx - popupWidthPx - marginPx).coerceAtLeast(marginPx)
    return preferred.coerceIn(marginPx, maxX)
}

internal fun inputMenuAnchorInContainer(anchorInWindow: Rect, containerInWindow: Rect): Rect = Rect(
    left = anchorInWindow.left - containerInWindow.left,
    top = anchorInWindow.top - containerInWindow.top,
    right = anchorInWindow.right - containerInWindow.left,
    bottom = anchorInWindow.bottom - containerInWindow.top,
)

internal data class ModelOptionGroup(
    val providerLabel: String,
    val options: List<ModelOption>,
)

internal fun modelOptionDisplayName(option: ModelOption): String =
    option.displayName.ifBlank {
        option.label.substringAfter(" / ", option.label).ifBlank { option.modelName }
    }

internal fun selectedModelMenuLabel(
    selectedModel: String,
    selectedProviderId: String,
    selectedModelName: String,
    options: List<ModelOption>,
): String {
    val matched = options.firstOrNull { option ->
        modelOptionMatchesSelection(option, selectedProviderId, selectedModelName)
    }
    if (matched != null) return modelOptionDisplayName(matched)

    return selectedModelName
        .takeUnless { it.startsWith("deployment:") }
        ?.substringAfterLast(" / ")
        ?.takeIf(String::isNotBlank)
        ?: selectedModel.substringAfterLast(" / ").ifBlank { "未选择" }
}

internal fun modelOptionMatchesSelection(
    option: ModelOption,
    selectedProviderId: String,
    selectedModelName: String,
): Boolean = if (selectedModelName.startsWith("deployment:")) {
    option.modelName == selectedModelName
} else {
    option.providerId == selectedProviderId && option.modelName == selectedModelName
}

internal fun groupModelOptions(options: List<ModelOption>): List<ModelOptionGroup> =
    options.groupBy { option ->
        option.providerLabel.ifBlank {
            option.label.substringBefore(" / ", option.providerId).ifBlank { option.providerId.ifBlank { "其他" } }
        }
    }.map { (providerLabel, providerOptions) -> ModelOptionGroup(providerLabel, providerOptions) }

internal fun queueDragTargetIndex(
    sourceIndex: Int,
    dragOffsetPx: Float,
    rowStepPx: Float,
    itemCount: Int,
): Int {
    if (sourceIndex !in 0 until itemCount || rowStepPx <= 0f) return sourceIndex
    return (sourceIndex + (dragOffsetPx / rowStepPx).roundToInt())
        .coerceIn(0, itemCount - 1)
}

internal fun queueRowDisplacementPx(
    rowIndex: Int,
    sourceIndex: Int,
    targetIndex: Int,
    rowStepPx: Float,
): Float = when {
    sourceIndex < targetIndex && rowIndex in (sourceIndex + 1)..targetIndex -> -rowStepPx
    sourceIndex > targetIndex && rowIndex in targetIndex until sourceIndex -> rowStepPx
    else -> 0f
}

/** 对话区渲染项：气泡 或 工作事件块（与 GUI 桌面端渲染契约一致） */
sealed interface ChatItem {
    data class Bubble(
        val role: String, // user | assistant | system | workflow
        val content: String,
        val mode: String = "",
        val model: String = "",
        val timestamp: String = "",
        val workRun: LocalWorkRun? = null, // assistant 消息的 build block
        val keyHint: String = "", // 稳定唯一 key（远程 messageId / runId / 本地序号）；缺省按内容推导（可能碰撞）
        val messageId: String = "",
        val messageIndex: Int = -1,
        val attachments: List<RemoteConversationImage> = emptyList(),
        val displayedImages: List<com.newmark.mobile.data.WorkDisplayImage> = emptyList(),
        val branchPager: ConversationBranchPagerUi? = null,
    ) : ChatItem {
        /** LazyColumn 稳定 key：优先用唯一 keyHint，避免同秒同内容消息碰撞导致滚动/渲染错乱 */
        val stableKey: String get() =
            keyHint.ifBlank { "b:$role:$timestamp:${content.hashCode()}:${workRun?.runId ?: ""}" }
    }

}

/** PC `.conversation-branch-pager` 的移动端投影。 */
data class ConversationBranchPagerUi(
    val groupId: String,
    val currentPage: Int,
    val totalPages: Int,
    val canPrevious: Boolean,
    val canNext: Boolean,
)

data class QueueMessageUi(
    val id: String,
    val text: String,
    val editable: Boolean,
    val requestedMode: String = "build",
    val goalObjective: String = "",
)

@Composable
fun ChatScreen(
    title: String,
    items: List<ChatItem>,
    isSending: Boolean,
    showMenuButton: Boolean,
    remoteMode: Boolean = false,
    modelOptions: List<ModelOption> = emptyList(),
    selectedModel: String = "",
    selectedProviderId: String = "",
    selectedModelName: String = "",
    intelligence: String = "medium",
    selectedMode: String = "Build",
    onSelectModel: (ModelOption) -> Unit = {},
    onSelectIntelligence: (String) -> Unit = {},
    onSelectMode: (String) -> Unit = {},
    onMenuClick: () -> Unit,
    onNewChat: () -> Unit,
    onSend: (String) -> Unit,
    onSendWithImages: (String, List<LocalImageAttachment>) -> Unit = { text, _ -> onSend(text) },
    onGuide: (String) -> Boolean = { false },
    onStop: () -> Unit = {},
    escalating: Boolean = false,
    showConnectRemote: Boolean = false,
    onConnectRemote: () -> Unit = {},
    goal: RemoteGoal? = null,
    flow: RemoteFlowTakeover? = null,
    queueItems: List<QueueMessageUi> = emptyList(),
    queuePaused: Boolean = false,
    onEditGoal: (String) -> Unit = {},
    onToggleGoalPause: () -> Unit = {},
    onDeleteGoal: () -> Unit = {},
    onToggleFlow: () -> Unit = {},
    onToggleQueuePause: () -> Unit = {},
    onUpdateQueueItem: (String, String) -> Unit = { _, _ -> },
    onDeleteQueueItem: (String) -> Unit = {},
    onReorderQueueItems: (List<String>) -> Unit = {},
    onGuideQueueItem: (String) -> Unit = {},
    onInspectBranch: (String, Int) -> Unit = { _, _ -> },
    onEditUserMessage: (Int, String) -> Unit = { _, _ -> },
    onOpenWebLink: (String) -> Unit = {},
    onBeginFileUpload: () -> (suspend (String, String, ByteArray) -> Result<String>) = {
        { _, _, _ -> Result.failure(IllegalStateException("文件上传不可用")) }
    },
    uploadInjectsGuide: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val p = LocalNewmarkColors.current
    val dark = LocalThemeMode.current.dark ?: isSystemInDarkTheme()
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    var inputBounds by remember { mutableStateOf<Rect?>(null) }
    // Preserve selection and IME composition while the cursor moves.
    var inputValue by remember { mutableStateOf(TextFieldValue()) }
    var goalEditPending by remember { mutableStateOf(false) }
    var queueEditPending by remember { mutableStateOf<QueueMessageUi?>(null) }
    val inputFocusRequester = remember { FocusRequester() }
    var inputMenu by remember { mutableStateOf<InputCompositeMenu?>(null) }
    val inputOverlayBounds = remember { mutableStateOf<Rect?>(null) }
    val plusMenuAnchor = remember { mutableStateOf<Rect?>(null) }
    val modelMenuAnchor = remember { mutableStateOf<Rect?>(null) }
    var inputAreaHeight by remember { mutableIntStateOf(0) }
    var inputStackHeight by remember { mutableIntStateOf(0) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pendingFileUpload by remember {
        mutableStateOf<suspend (String, String, ByteArray) -> Result<String>>({ _, _, _ ->
            Result.failure(IllegalStateException("文件上传不可用"))
        })
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        scope.launch {
            val selected = withContext(Dispatchers.IO) {
                runCatching {
                    val name = context.contentResolver
                        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                        ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
                        ?.takeIf(String::isNotBlank)
                        ?: uri.lastPathSegment?.substringAfterLast('/')
                        ?: "mobile-upload.bin"
                    val mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
                    val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
                        val output = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(64 * 1024)
                        var total = 0
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            total += read
                            require(total <= 20 * 1024 * 1024) { "文件超过 20 MiB" }
                            output.write(buffer, 0, read)
                        }
                        output.toByteArray()
                    } ?: error("无法读取文件")
                    Triple(name, mime, bytes)
                }
            }
            selected.fold(
                onSuccess = { (name, mime, bytes) ->
                    pendingFileUpload(name, mime, bytes).fold(
                        onSuccess = { path ->
                            if (!uploadInjectsGuide) {
                                val nextText = listOf(inputValue.text, "已上传文件：$path")
                                    .filter(String::isNotBlank)
                                    .joinToString("\n")
                                inputValue = TextFieldValue(nextText, TextRange(nextText.length))
                            }
                            Toast.makeText(context, "已上传到：$path", Toast.LENGTH_SHORT).show()
                        },
                        onFailure = { Toast.makeText(context, it.message ?: "上传失败", Toast.LENGTH_LONG).show() },
                    )
                },
                onFailure = { Toast.makeText(context, it.message ?: "读取文件失败", Toast.LENGTH_LONG).show() },
            )
        }
    }
    var pendingImage by remember { mutableStateOf<LocalImageAttachment?>(null) }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val mime = (context.contentResolver.getType(uri) ?: "").lowercase().replace("image/jpg", "image/jpeg")
                    require(mime == "image/png" || mime == "image/jpeg") { "仅支持 PNG/JPEG 图片" }
                    val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
                        val output = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(64 * 1024)
                        var total = 0
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            total += read
                            require(total <= 12 * 1024 * 1024) { "图片超过 12 MiB" }
                            output.write(buffer, 0, read)
                        }
                        output.toByteArray()
                    } ?: error("无法读取图片")
                    require(bytes.isNotEmpty()) { "图片为空" }
                    LocalImageAttachment(
                        id = java.util.UUID.randomUUID().toString(),
                        name = "image",
                        mimeType = mime,
                        dataUrl = "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP),
                    )
                }
            }
            result.fold(
                onSuccess = { pendingImage = it; Toast.makeText(context, "图片已添加到待发送消息", Toast.LENGTH_SHORT).show() },
                onFailure = { Toast.makeText(context, it.message ?: "读取图片失败", Toast.LENGTH_LONG).show() },
            )
        }
    }
    BackHandler(enabled = inputMenu != null) { inputMenu = null }
    LaunchedEffect(remoteMode) {
        // The paired desktop and this device own separate model catalogues.
        // Drop any retained remote popup page before rendering local options.
        inputMenu = null
    }
    LaunchedEffect(goalEditPending, queueEditPending?.id) {
        if (goalEditPending || queueEditPending != null) {
            inputFocusRequester.requestFocus()
            keyboardController?.show()
        }
    }
    CompositionLocalProvider(LocalPcColors provides if (dark) PcColorsDark else PcColorsLight) {
        Box(
            modifier = modifier
                .fillMaxSize()
                .background(p.bgPrimary)
                .pointerInput(inputBounds) {
                    awaitEachGesture {
                        val down = awaitFirstDown(
                            requireUnconsumed = false,
                            pass = PointerEventPass.Final,
                        )
                        if (!down.isConsumed && inputBounds?.contains(down.position) != true) {
                            focusManager.clearFocus(force = true)
                            keyboardController?.hide()
                        }
                    }
                }
                .imePadding()
                .onGloballyPositioned { inputOverlayBounds.value = it.boundsInWindow() },
        ) {
            val inputMenuBackdrop = rememberLiquidBackdrop()
            Box(
                Modifier
                    .fillMaxSize()
                    .then(
                        if (inputMenu != null) Modifier.layerBackdrop(inputMenuBackdrop)
                        else Modifier,
                    ),
            ) {
            Column(Modifier.fillMaxSize()) {
                ChatTopBar(
                title = title,
                showMenuButton = showMenuButton,
                onMenuClick = onMenuClick,
                onNewChat = onNewChat,
                showConnectRemote = showConnectRemote,
                onConnectRemote = onConnectRemote,
            )
                ChatContent(
                items = items,
                isSending = isSending,
                bottomAvoidancePx = inputStackHeight,
                onInspectBranch = onInspectBranch,
                onEditUserMessage = onEditUserMessage,
                onOpenWebLink = onOpenWebLink,
                modifier = Modifier.weight(1f),
            )

                InputArea(
                running = isSending,
                remoteMode = remoteMode,
                modelOptions = modelOptions,
                selectedModel = selectedModel,
                selectedModelName = selectedModelName,
                intelligence = intelligence,
                selectedMode = selectedMode,
                value = inputValue,
                pendingImage = pendingImage,
                onRemovePendingImage = { pendingImage = null },
                onValueChange = { inputValue = it },
                onSelectModel = onSelectModel,
                onSelectIntelligence = onSelectIntelligence,
                onSelectMode = onSelectMode,
                onSend = { value ->
                    val images = pendingImage?.let(::listOf).orEmpty()
                    pendingImage = null
                    val queueEdit = queueEditPending
                    if (queueEdit != null) {
                        onUpdateQueueItem(queueEdit.id, value)
                        queueEditPending = null
                    } else if (goalEditPending) {
                        onEditGoal(value)
                        goalEditPending = false
                    } else if (images.isNotEmpty()) onSendWithImages(value, images) else onSend(value)
                },
                onGuide = { value ->
                    val accepted = onGuide(value)
                    if (accepted) inputValue = TextFieldValue()
                    accepted
                },
                onStop = onStop,
                escalating = escalating,
                onInputBoundsChanged = { inputBounds = it },
                onPlusAnchorBoundsChanged = { plusMenuAnchor.value = it },
                onModelAnchorBoundsChanged = { modelMenuAnchor.value = it },
                onOpenPlusMenu = { inputMenu = InputCompositeMenu.PlusMain },
                onOpenModelMenu = { inputMenu = InputCompositeMenu.ModelMain },
                focusRequester = inputFocusRequester,
                modifier = Modifier.onSizeChanged { inputAreaHeight = it.height },
            )
            }
            // PC `.input-float-stack` is absolutely positioned above the input
            // and never consumes transcript layout space. Keeping runtime
            // controls in this overlay prevents Queue expansion from measuring
            // and redrawing the complete long conversation on every frame.
            Column(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .offset { IntOffset(0, -inputAreaHeight) }
                    .fillMaxWidth()
                    .onSizeChanged { inputStackHeight = it.height },
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                flow?.takeIf { it.running }?.let {
                    FlowTakeoverBubble(flow = it, onToggle = onToggleFlow)
                }
                InputStack(
                    goal = goal.takeUnless { goalEditPending },
                    flow = flow,
                    queueItems = queueItems.filterNot { it.id == queueEditPending?.id },
                    queuePaused = queuePaused,
                    onEditGoal = {
                        inputValue = TextFieldValue(it, TextRange(it.length))
                        goalEditPending = true
                        onSelectMode("Goal")
                        onDeleteGoal()
                    },
                    onToggleGoalPause = onToggleGoalPause,
                    onDeleteGoal = onDeleteGoal,
                    onToggleQueuePause = onToggleQueuePause,
                    onUpdateQueueItem = onUpdateQueueItem,
                    onDeleteQueueItem = onDeleteQueueItem,
                    onEditQueueItem = {
                        inputValue = TextFieldValue(it.text, TextRange(it.text.length))
                        queueEditPending = it
                        onSelectMode(it.requestedMode.ifBlank { "build" }.replaceFirstChar(Char::titlecase))
                    },
                    onReorderQueueItems = onReorderQueueItems,
                    onGuideQueueItem = onGuideQueueItem,
                )
            }
            }
            key(remoteMode) {
                InputCompositeMenuOverlay(
                    menu = inputMenu,
                    containerBounds = inputOverlayBounds,
                    plusAnchor = plusMenuAnchor,
                    modelAnchor = modelMenuAnchor,
                    remoteMode = remoteMode,
                    mode = selectedMode,
                    selectedModel = selectedModel,
                    selectedProviderId = selectedProviderId,
                    selectedModelName = selectedModelName,
                    intelligence = intelligence,
                    options = modelOptions,
                    backdrop = inputMenuBackdrop,
                    onMenuChange = { inputMenu = it },
                    onDismiss = { inputMenu = null },
                    onMode = onSelectMode,
                    onSelectModel = onSelectModel,
                    onSelectIntelligence = onSelectIntelligence,
                    onChooseFile = {
                        pendingFileUpload = onBeginFileUpload()
                        filePicker.launch("*/*")
                    },
                    onChooseImage = {
                        inputMenu = null
                        imagePicker.launch("image/*")
                    },
                )
            }
        }
    }
}

@Composable
private fun ChatTopBar(
    title: String,
    showMenuButton: Boolean,
    onMenuClick: () -> Unit,
    onNewChat: () -> Unit,
    showConnectRemote: Boolean = false,
    onConnectRemote: () -> Unit = {},
) {
    val p = LocalNewmarkColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(p.bgSecondary)
            .statusBarsPadding()
            .height(52.dp)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showMenuButton) {
            CircleButton(onClick = onMenuClick) {
                Icon(
                    imageVector = Icons.Filled.Menu,
                    contentDescription = "菜单",
                    tint = p.textPrimary,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
        Text(
            text = title,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            color = p.textPrimary,
            maxLines = 1,
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 12.dp),
        )
        if (showConnectRemote) {
            CircleButton(onClick = onConnectRemote) {
                Icon(
                    imageVector = Icons.Filled.Computer,
                    contentDescription = "连接桌面端",
                    tint = p.accent,
                    modifier = Modifier.size(18.dp),
                )
            }
            // The PC top bar keeps distinct hit targets here.  Without this
            // fixed gap the two circular controls visually merge on phones.
            Spacer(Modifier.width(8.dp))
        }
        CircleButton(onClick = onNewChat) {
            Icon(
                imageVector = Icons.Filled.Add,
                contentDescription = "新对话",
                tint = p.accent,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Composable
private fun CircleButton(onClick: () -> Unit, content: @Composable () -> Unit) {
    val p = LocalNewmarkColors.current
    GlassButtonCanvas(
        visualSize = 36.dp,
        shape = CircleShape,
        surfaceColor = p.bgQuaternary,
        onClick = onClick,
        content = content,
    )
}

// ---- 对话内容（气泡 + 工作事件块） ----
@Composable
private fun ChatContent(
    items: List<ChatItem>,
    isSending: Boolean,
    bottomAvoidancePx: Int,
    onInspectBranch: (String, Int) -> Unit,
    onEditUserMessage: (Int, String) -> Unit,
    onOpenWebLink: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val p = LocalNewmarkColors.current
    val pc = LocalPcColors.current
    val listState = rememberLazyListState()
    val chatScope = rememberCoroutineScope()
    val density = LocalDensity.current
    val bottomAvoidanceDp = with(density) { bottomAvoidancePx.toDp() }
    var viewportHeightPx by remember { mutableIntStateOf(0) }
    // A live Build keeps one LazyColumn row while its internal event stream
    // grows.  Key scrolling to that stream as well as the outer item count;
    // otherwise thought/tool updates below the fold appear to arrive only
    // when the terminal persisted row replaces the live row.
    val liveContentRevision = items.fold(0L) { revision, item ->
        val run = (item as? ChatItem.Bubble)?.workRun ?: return@fold revision
        revision * 31L + run.events.size * 17L + run.status.hashCode().toLong()
    }
    // PC `#scroll-bottom-btn` 同款：仅当用户视野不在底部时显示浮动回到底部按钮。
    val atBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val lastVisible = info.visibleItemsInfo.lastOrNull()
            if (lastVisible == null) true
            else lastVisible.index >= info.totalItemsCount - 1
        }
    }
    // Index of the trailing bottom-reserve row: the real transcript end.
    val transcriptEndIndex = transcriptEndIndex(items.size, isSending)
    LaunchedEffect(items.size, isSending, liveContentRevision, viewportHeightPx) {
        // PC 语义：仅当用户视野原本就在底部时才跟随新内容；向上滚动阅读时
        // 不强制拉回，此时由右下角回到底部按钮接管。
        if (items.isNotEmpty() && atBottom) {
            listState.scrollToItem(transcriptEndIndex)
        }
    }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .onSizeChanged { viewportHeightPx = it.height },
    ) {
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .padding(
                    start = ChatAreaHorizontalInset,
                    end = ChatAreaHorizontalInset,
                    top = 16.dp,
                    bottom = 16.dp + bottomAvoidanceDp,
                )
            .drawBehind {
                // PC #chat-area owns two continuous timeline rails. The
                // message rows only provide the colored 11dp node circles.
                if (items.any { it is ChatItem.Bubble }) {
                    val railInset = 8.5.dp.toPx() // 3dp spacer + 11dp dot radius
                    val stroke = 1.dp.toPx()
                    drawLine(
                        color = pc.border,
                        start = Offset(railInset, 0f),
                        end = Offset(railInset, size.height),
                        strokeWidth = stroke,
                    )
                    drawLine(
                        color = pc.border,
                        start = Offset(size.width - railInset, 0f),
                        end = Offset(size.width - railInset, size.height),
                        strokeWidth = stroke,
                    )
                }
            },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (items.isEmpty()) {
            item {
                Text(
                    text = "你好！我是 Newmark Agent。\n在下方输入消息开始对话。",
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                    color = p.textSecondary,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }
        } else {
            items(items, key = { item ->
                when (item) {
                    is ChatItem.Bubble -> item.stableKey
                }
            }) { item ->
                when (item) {
                    is ChatItem.Bubble -> ChatBubble(
                        item = item,
                        onInspectBranch = onInspectBranch,
                        onEditUserMessage = onEditUserMessage,
                        onOpenWebLink = onOpenWebLink,
                    )
                }
            }
        }
        if (isSending) {
            item { ThinkingDots() }
        }
        item(key = "transcript-bottom-reserve") {
            Spacer(Modifier.height(TranscriptBottomReserveDp.dp))
        }
        }
        // Floating scroll-to-bottom button, PC `#scroll-bottom-btn` 同款。
        if (!atBottom && items.isNotEmpty()) {
            GlassButtonCanvas(
                visualSize = 40.dp,
                shape = CircleShape,
                surfaceColor = p.bgQuaternary,
                restingBorderColor = p.border2,
                alpha = 0.72f,
                onClick = {
                    chatScope.launch { listState.scrollToItem(transcriptEndIndex) }
                },
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 14.dp, bottom = 14.dp),
            ) {
                Icon(
                    imageVector = Icons.Filled.KeyboardArrowDown,
                    contentDescription = "回到底部",
                    tint = p.textPrimary,
                    modifier = Modifier.size(22.dp),
                )
            }
        }
    }
}

internal const val TranscriptBottomReserveLines = 10
internal const val TranscriptBodyLineHeightDp = 19
internal const val TranscriptBottomReserveDp =
    TranscriptBottomReserveLines * TranscriptBodyLineHeightDp

/**
 * Index of the trailing bottom-reserve row (the real transcript end) inside
 * the chat LazyColumn: item rows, then an optional ThinkingDots row, then the
 * reserve spacer. Scrolling here lands past any tall Build block tail.
 */
internal fun transcriptEndIndex(itemCount: Int, isSending: Boolean): Int =
    itemCount + (if (isSending) 1 else 0)

// ---- PC 对话区颜色（暗色对齐 index.html :root；亮色对齐 [data-theme=light]） ----
@Immutable
private data class PcColors(
    val text: Color,
    val textDim: Color,
    val accent: Color,
    val accent2: Color,
    val border: Color,
    val error: Color,
)

private val PcColorsDark = PcColors(
    text = Color(0xFFC8D0E8),
    textDim = Color(0xFF7880A0),
    accent = Color(0xFF5B78FF),
    accent2 = Color(0xFF38D4A0),
    border = Color(0x14FFFFFF), // rgba(255,255,255,.08)
    error = Color(0xFFFF8888),
)

private val PcColorsLight = PcColors(
    text = Color(0xFF1A1A2E),    // PC light --text
    textDim = Color(0xFF6A7090), // PC light --text-dim
    accent = Color(0xFF5B78FF),  // PC --accent（light 无覆盖）
    accent2 = Color(0xFF38D4A0), // PC --accent2（light 无覆盖）
    border = Color(0x14000000),  // 黑 8%（白 8% 的亮色语义）
    error = Color(0xFFFF8888),
)

private val LocalPcColors = staticCompositionLocalOf { PcColorsDark }

/** PC 同款处理时长：满 60s 进 min，满 60min 进 h；未满一秒显示 1s。 */
private fun formatDuration(ms: Long): String {
    val seconds = maxOf(1L, ms.coerceAtLeast(0L) / 1000L)
    val hours = seconds / 3600L
    val minutes = (seconds % 3600L) / 60L
    val remainder = seconds % 60L
    return when {
        hours > 0L -> "${hours}h ${minutes.toString().padStart(2, '0')}m ${remainder.toString().padStart(2, '0')}s"
        minutes > 0L -> "${minutes}m ${remainder.toString().padStart(2, '0')}s"
        else -> "${remainder}s"
    }
}

/** 对齐 PC publicToolNameForUi：取第一行、去 think 标签、trim、截断 */
private fun publicToolNameForUi(value: String): String =
    WorkRunProjection.publicToolName(value)

/**
 * 消息渲染（对齐 PC .chat-msg，无气泡）：
 * 左侧/右侧 11px 小圆点 + meta 行 + msg-body（扁平 markdown）。
 */
@Composable
private fun ChatBubble(
    item: ChatItem.Bubble,
    onInspectBranch: (String, Int) -> Unit,
    onEditUserMessage: (Int, String) -> Unit,
    onOpenWebLink: (String) -> Unit,
) {
    val pc = LocalPcColors.current
    val isUser = item.role == "user"
    val roleLabel = when (item.role) {
        "user" -> "用户输入"
        "workflow" -> "工作流"
        "system" -> "系统"
        else -> "Agent"
    }
    val roleColor = when {
        isUser -> pc.accent
        item.role == "assistant" -> pc.accent2
        item.role == "workflow" -> pc.accent
        else -> pc.textDim
    }
    val run = item.workRun
    Column(Modifier.fillMaxWidth()) {
        if (!isUser && run != null) {
            // WorkRun 与最终 Agent 正文在 PC 中是相邻但独立的历史实体。
            // 远程快照有真实 assistant 消息时，run.text 为空，绝不额外留一行空 Agent。
            WorkRunMessageRow(run)
            if (run.text.isNotBlank()) {
                ChatMessageRow(
                    roleLabel = roleLabel, roleColor = roleColor, isUser = false,
                    timestamp = item.timestamp, mode = item.mode, model = item.model, content = run.text,
                    messageIndex = item.messageIndex,
                    attachments = emptyList(),
                    displayedImages = item.displayedImages,
                    branchPager = item.branchPager,
                    onInspectBranch = onInspectBranch,
                    onEditUserMessage = onEditUserMessage,
                    onOpenWebLink = onOpenWebLink,
                )
            }
        } else {
            ChatMessageRow(
                roleLabel = roleLabel, roleColor = roleColor, isUser = isUser,
                timestamp = item.timestamp, mode = item.mode, model = item.model, content = item.content,
                messageIndex = item.messageIndex,
                attachments = item.attachments,
                displayedImages = item.displayedImages,
                branchPager = item.branchPager,
                onInspectBranch = onInspectBranch,
                onEditUserMessage = onEditUserMessage,
                onOpenWebLink = onOpenWebLink,
            )
        }
    }
}

/**
 * PC `chat-msg assistant work-run-message` 的外层轨道。
 *
 * 处理块不是直接挂在聊天区：先占用 Agent 时间线的 28dp 正文起点，再由
 * [WorkRunBlock] 在其中建立 Build 自己的左侧轨道。这样长文本的左边不会压到
 * Build rail，右边则由 work-run body 的 34dp 安全区避开用户时间线。
 */
@Composable
private fun WorkRunMessageRow(run: LocalWorkRun) {
    val pc = LocalPcColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Spacer(Modifier.width(3.dp))
        MessageDot(pc.accent2)
        Spacer(Modifier.width(14.dp))
        WorkRunBlock(
            run = run,
            modifier = Modifier.weight(1f),
        )
    }
}

/** 一条扁平消息：小圆点（::after）+ meta + msg-body */
@Composable
private fun ChatMessageRow(
    roleLabel: String,
    roleColor: Color,
    isUser: Boolean,
    timestamp: String,
    mode: String,
    model: String,
    content: String,
    messageIndex: Int,
    attachments: List<RemoteConversationImage>,
    displayedImages: List<com.newmark.mobile.data.WorkDisplayImage> = emptyList(),
    branchPager: ConversationBranchPagerUi?,
    onInspectBranch: (String, Int) -> Unit,
    onEditUserMessage: (Int, String) -> Unit,
    onOpenWebLink: (String) -> Unit,
) {
    val pc = LocalPcColors.current
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    var editing by remember(content, messageIndex) { mutableStateOf(false) }
    var editedText by remember(content, messageIndex) { mutableStateOf(content) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        if (!isUser) {
            Spacer(Modifier.width(3.dp))
            MessageDot(roleColor)
            Spacer(Modifier.width(14.dp))
        }
        Column(
            modifier = Modifier.weight(1f),
            horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
        ) {
            MessageMeta(
                roleLabel = roleLabel,
                roleColor = roleColor,
                timestamp = timestamp,
                mode = mode,
                model = model,
                isUser = isUser,
                onCopy = {
                    clipboard.setText(AnnotatedString(content))
                    Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
                },
                onEdit = if (isUser && messageIndex >= 0) ({ editing = true }) else null,
            )
            if (isUser) ConversationImageAttachments(attachments)
            if (!isUser) WorkDisplayImagePreviews(displayedImages)
            if (editing) {
                MessageInlineEditor(
                    value = editedText,
                    onValueChange = { editedText = it },
                    modifier = Modifier.padding(start = 28.dp),
                    onCancel = {
                        editedText = content
                        editing = false
                    },
                    onSubmit = {
                        val normalized = editedText.trim()
                        if (normalized.isNotBlank()) {
                            editing = false
                            onEditUserMessage(messageIndex, normalized)
                        }
                    },
                )
            } else {
                MarkdownBody(
                    text = content,
                    baseColor = pc.text,
                    alignEnd = isUser,
                    onLinkClick = onOpenWebLink,
                )
            }
            branchPager?.let { pager ->
                ConversationBranchPager(
                    pager = pager,
                    onPrevious = { onInspectBranch(pager.groupId, -1) },
                    onNext = { onInspectBranch(pager.groupId, 1) },
                )
            }
        }
        if (isUser) {
            Spacer(Modifier.width(14.dp))
            MessageDot(roleColor)
            Spacer(Modifier.width(3.dp))
        }
    }
}

/** PC ChatMessage.attachments 的移动端公开历史投影。 */
@Composable
private fun ConversationImageAttachments(attachments: List<RemoteConversationImage>) {
    val valid = attachments.filter { attachment ->
        val mime = attachment.mimeType.lowercase().replace("image/jpg", "image/jpeg")
        attachment.origin == "user" && mime in setOf("image/png", "image/jpeg") &&
            attachment.dataUrl.startsWith("data:$mime;base64,", ignoreCase = true) &&
            attachment.dataUrl.length <= 14 * 1024 * 1024
    }.take(6)
    valid.forEach { attachment ->
        var expanded by remember(attachment.id, attachment.dataUrl) { mutableStateOf(false) }
        val bitmap = remember(attachment.dataUrl) {
            runCatching {
                val bytes = android.util.Base64.decode(attachment.dataUrl.substringAfter(',', ""), android.util.Base64.DEFAULT)
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            }.getOrNull()
        } ?: return@forEach
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 6.dp)
                .wrapContentWidth(Alignment.End)
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                ) { expanded = !expanded },
        ) {
            androidx.compose.foundation.Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = attachment.name.ifBlank { "已提交图片" },
                contentScale = androidx.compose.ui.layout.ContentScale.Fit,
                modifier = Modifier
                    .widthIn(max = 280.dp)
                    .height(if (expanded) 260.dp else 104.dp)
                    .clip(NewmarkShapeSmall),
            )
            Text(
                text = attachment.name.ifBlank { "已提交图片" },
                fontSize = 10.sp,
                color = LocalPcColors.current.textDim,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .widthIn(max = 280.dp)
                    .align(Alignment.End)
                    .padding(top = 2.dp),
            )
        }
    }
}

/** 小圆点（对齐 .chat-msg::after）：11x11 圆，1dp border，top 17dp */
@Composable
private fun MessageDot(color: Color) {
    Box(
        modifier = Modifier
            .padding(top = 17.dp)
            .size(11.dp)
            .border(width = 1.dp, color = color, shape = CircleShape),
    )
}

/** meta 行（对齐 .chat-msg .meta）：10sp，dim，角色名 650；user 右对齐（PC 8px 28px 8px 0 + text-align right） */
@Composable
private fun MessageMeta(
    roleLabel: String,
    roleColor: Color,
    timestamp: String,
    mode: String,
    model: String,
    isUser: Boolean,
    onCopy: () -> Unit,
    onEdit: (() -> Unit)?,
) {
    val pc = LocalPcColors.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = roleLabel, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, color = roleColor)
        if (timestamp.isNotBlank()) {
            Text(text = " | $timestamp", fontSize = 10.sp, color = pc.textDim)
        }
        val extras = listOfNotNull(
            mode.takeIf { it.isNotBlank() }?.let { "模式: $it" },
            model.takeIf { it.isNotBlank() }?.let { "模型: $it" },
        ).joinToString(" | ")
        if (extras.isNotBlank()) {
            Text(text = " | $extras", fontSize = 10.sp, color = pc.textDim)
        }
        MessageActionButton(label = "复制", onClick = onCopy) {
            Text(text = "⧉", fontSize = 12.sp, color = pc.textDim)
        }
        if (onEdit != null) {
            MessageActionButton(label = "编辑", onClick = onEdit) {
                Icon(
                    imageVector = LucideIcons.Pencil,
                    contentDescription = null,
                    tint = pc.textDim,
                    modifier = Modifier.size(12.dp),
                )
            }
        }
    }
}

@Composable
private fun MessageActionButton(
    label: String,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        modifier = Modifier
            .padding(start = 2.dp)
            .size(width = 24.dp, height = 22.dp)
            .clip(RoundedCornerShape(50))
            .clickable(
                interactionSource = interaction,
                indication = androidx.compose.foundation.LocalIndication.current,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

@Composable
private fun MessageInlineEditor(
    value: String,
    onValueChange: (String) -> Unit,
    onCancel: () -> Unit,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val pc = LocalPcColors.current
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 4.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            textStyle = TextStyle(color = pc.text, fontSize = 13.sp, lineHeight = 20.sp),
            modifier = Modifier
                .fillMaxWidth()
                .height(92.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(Color.White.copy(alpha = 0.05f))
                .border(1.dp, pc.border, RoundedCornerShape(10.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
        ) {
            MessageEditButton(text = "取消", accent = false, onClick = onCancel)
            Spacer(Modifier.width(7.dp))
            MessageEditButton(text = "提交", accent = true, onClick = onSubmit)
        }
    }
}

@Composable
private fun MessageEditButton(text: String, accent: Boolean, onClick: () -> Unit) {
    val pc = LocalPcColors.current
    val interaction = remember { MutableInteractionSource() }
    Box(
        modifier = Modifier
            .glassButtonSurface(NewmarkShapeSmall, if (accent) pc.accent else Color.White, if (accent) 0.64f else 0.12f)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 11.dp, vertical = 5.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = text, fontSize = 11.sp, color = if (accent) pc.accent else pc.text)
    }
}

@Composable
private fun ConversationBranchPager(
    pager: ConversationBranchPagerUi,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
) {
    val pc = LocalPcColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 7.dp),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BranchPageArrow(text = "<", enabled = pager.canPrevious, onClick = onPrevious)
        Text(
            text = "${pager.currentPage}/${pager.totalPages}",
            color = pc.textDim,
            fontSize = 11.sp,
        )
        BranchPageArrow(text = ">", enabled = pager.canNext, onClick = onNext)
    }
}

@Composable
private fun BranchPageArrow(text: String, enabled: Boolean, onClick: () -> Unit) {
    val pc = LocalPcColors.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Text(
        text = text,
        color = pc.textDim.copy(alpha = if (enabled) 1f else 0.32f),
        fontSize = 11.sp,
        modifier = Modifier
            .graphicsLayer {
                val scale = if (pressed && enabled) 0.92f else 1f
                scaleX = scale
                scaleY = scale
            }
            .clip(NewmarkShapeSmall)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                onClick = onClick,
            )
            .padding(horizontal = 3.dp, vertical = 1.dp),
    )
}

/**
 * work run（对齐 PC .conversation-work-run）：左侧 1px 竖线 + header（chevron/title/status）+ 事件流。
 * 无背景、无边框、无圆角。
 */
@Composable
private fun WorkRunBlock(run: LocalWorkRun, modifier: Modifier = Modifier) {
    // 用户要求：工具集合默认折叠；桌面历史中用户保存的展开状态优先。
    var collapsed by remember(run.runId) { mutableStateOf(!run.expanded) }
    val pc = LocalPcColors.current
    val collapsedGuides = remember(run.events, run.status) {
        WorkRunProjection.collapsedGuides(run.events, run.status)
    }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .drawBehind {
                // CSS .conversation-work-run::before is positioned on the
                // outer run box, not inside its text padding. Keep this rail
                // parallel to the Agent rail, then start Build content 24dp
                // to its right.
                drawLine(
                    color = pc.border,
                    start = Offset(7.dp.toPx(), 17.dp.toPx()),
                    end = Offset(7.dp.toPx(), (size.height - 7.dp.toPx()).coerceAtLeast(17.dp.toPx())),
                    strokeWidth = 1.dp.toPx(),
                )
            }
            .padding(start = WorkRunContentStartInset, top = 5.dp, bottom = 9.dp),
    ) {
        WorkRunHead(run = run, collapsed = collapsed) { collapsed = !collapsed }
        if (!collapsed) {
            WorkRunEvents(run.events, run.status)
        } else {
            // PC keeps Guide messages visible below a collapsed Build. A Guide
            // is an intervening user message, not hidden Build activity.
            collapsedGuides.forEach { WorkGuideTimelineRow(it.event) }
        }
    }
}

/** work run 头部（对齐 .conversation-work-run-head）：chevron + title + status */
@Composable
private fun WorkRunHead(run: LocalWorkRun, collapsed: Boolean, onToggle: () -> Unit) {
    val pc = LocalPcColors.current
    // Keep the clock local to the header so a running Build block advances by
    // itself without forcing the entire conversation tree to recompose.
    val nowMs by produceState(
        initialValue = System.currentTimeMillis(),
        key1 = run.runId,
        key2 = run.status,
        key3 = run.endedAt,
    ) {
        if (run.endedAt <= 0L && run.status.lowercase() in setOf("running", "stopping", "force_restarting")) {
            while (true) {
                value = System.currentTimeMillis()
                delay(100L)
            }
        }
    }
    // 完全采用 PC workRunTitle 的中文状态词；“构建”不再作为独立标题出现。
    val title = when (run.status.lowercase()) {
        "running" -> "处理中"
        "stopping" -> "正在停止"
        "force_restarting" -> "正在强制停止"
        "interrupted" -> "已停止"
        "force_interrupted" -> "已强制停止"
        "error" -> "处理失败"
        else -> "已处理"
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(42.dp)
            .padding(end = WorkRunRightSafeInset)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onToggle,
            ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Chevron(collapsed)
        Spacer(Modifier.width(9.dp))
        Text(
            text = title,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = pc.text,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = formatDuration(run.elapsedAt(nowMs)),
            fontSize = 10.sp,
            color = pc.textDim,
            fontFamily = FontFamily.Monospace,
        )
    }
}

/** chevron（对齐 PC）：45deg 展开 / -45deg 折叠；size 缺省 8dp（work-run head），activity 用 7dp */
@Composable
private fun Chevron(collapsed: Boolean, size: Dp = 8.dp) {
    val pc = LocalPcColors.current
    Box(
        modifier = Modifier
            .size(size)
            .drawBehind {
                val s = this.size.width
                val stroke = 1.dp.toPx()
                if (collapsed) {
                    drawLine(pc.textDim, Offset(s * 0.25f, s * 0.2f), Offset(s * 0.75f, s * 0.5f), stroke)
                    drawLine(pc.textDim, Offset(s * 0.75f, s * 0.5f), Offset(s * 0.25f, s * 0.8f), stroke)
                } else {
                    drawLine(pc.textDim, Offset(s * 0.2f, s * 0.35f), Offset(s * 0.5f, s * 0.65f), stroke)
                    drawLine(pc.textDim, Offset(s * 0.5f, s * 0.65f), Offset(s * 0.8f, s * 0.35f), stroke)
                }
            },
    )
}

/**
 * 事件流与 PC `renderWorkRunEvents` 同构：事件不是直接按 type 渲染，而是先做
 * 公开投影，确保历史 `response`、多段 text、thought_result、工具完成状态和
 * Guide 生命周期都不会丢失。
 */
@Composable
private fun WorkRunEvents(events: List<LocalWorkEvent>, runStatus: String = "") {
    val pc = LocalPcColors.current
    val projected = remember(events, runStatus) { WorkRunProjection.project(events, runStatus) }
    // Ordinary Build rows reserve 34dp for the user timeline. Guide is the
    // deliberate exception: PC renders it as `.chat-msg.user` and places its
    // node in that reserved right-side lane.
    Column(Modifier.fillMaxWidth()) {
        if (projected.isEmpty()) {
            Text(
                text = "等待公开工作进度…",
                fontSize = 11.sp,
                color = pc.textDim,
                modifier = Modifier.padding(vertical = 4.dp),
            )
            return@Column
        }
        projected.forEach { item ->
            when (item) {
                is WorkRunProjection.Item.Guide -> WorkGuideTimelineRow(item.event)
                else -> Box(Modifier.fillMaxWidth().padding(end = WorkRunRightSafeInset)) {
                    when (item) {
                        is WorkRunProjection.Item.Narrative -> WorkNarrativeRow(item.content, item.incomplete)
                        is WorkRunProjection.Item.Thought -> WorkThoughtRow(item.event)
                        is WorkRunProjection.Item.ToolGroup -> WorkToolGroup(item.items, item.completed)
                        is WorkRunProjection.Item.Event -> WorkProjectedEventRow(item.event)
                        is WorkRunProjection.Item.Guide -> Unit
                    }
                }
            }
        }
    }
}

// ---- PC workToolActivity / workToolActivityLabel / workToolGroupLabel / workToolCommandLabel / workToolRowIcon 移植 ----

/** 工具活动分类 key（对齐 PC workToolActivity） */
private fun toolActivityKey(name: String): String {
    val n = name.lowercase()
    return when {
        n == "task" || n.startsWith("subagent_") -> "subagents"
        n == "skill" || n == "skill_load" || n == "skill_read" || n == "skill_download" -> "skills"
        isMcpName(n) -> "mcp"
        n == "context_compression" || n == "context_compress" || n == "context_history_manage" -> "context_compression"
        n == "memory_lab_update" || n == "memory_lab_reindex" -> "memory_lab"
        n == "image_inspect" || n == "computer_use" -> "images"
        n == "write" || n == "edit" -> "files"
        n == "web_search" -> "searched_web"
        n == "web_fetch" || n == "web_catch" -> "fetched_web"
        n == "read" || n == "glob" || n == "grep" || n.contains("snapshot") -> "search"
        n == "bash" || n == "pwd" || n.startsWith("git_") || n.startsWith("gh_") || n.contains("terminal") -> "commands"
        else -> "tool_call"
    }
}

private fun isMcpName(n: String): Boolean =
    n == "mcp" || n.startsWith("mcp__") || n.startsWith("mcp:") || n.startsWith("mcp.") || n.startsWith("mcp_") ||
        Regex("[:._-]mcp[:._-]").containsMatchIn(n)

/** 活动摘要文案（对齐 PC workToolActivityLabel，中文） */
private fun toolActivityLabel(key: String, count: Int, completed: Boolean): String = when (key) {
    "context_compression" -> if (completed) "上下文已压缩" else "正在压缩上下文"
    "memory_lab" -> if (completed) "更新了记忆" else "正在更新 Memory Lab"
    "skills" -> if (completed) "已加载 Skill" else "正在加载 Skill"
    "mcp" -> if (completed) "已调用 MCP" else "正在调用 MCP"
    "subagents" -> if (completed) "Subagent 已完成" else "Subagent 正在工作"
    "commands" -> if (count > 1) "运行了多个命令" else "运行了命令"
    "files" -> if (count > 1) "编辑了多个文件" else "编辑了文件"
    "images" -> "已查看 $count 张图像"
    "searched_web" -> if (completed) "搜索了网页" else "正在搜索网页"
    "fetched_web" -> if (completed) "抓取了网页" else "正在抓取网页"
    "search" -> if (count > 1) "读取并检索了多项内容" else "读取并检索了内容"
    else -> if (completed) "$key · 已完成" else key
}

private data class EditedFileInfo(val name: String, val added: Int, val deleted: Int)

/** PC isFileEditToolName：/^(edit|write|apply_patch|multi_edit|save_file|write_file)$/i */
private fun isFileEditToolName(name: String): Boolean =
    Regex("^(edit|write|apply_patch|multi_edit|save_file|write_file)$", RegexOption.IGNORE_CASE).matches(name)

/** write/edit 且带 path 参数 → 编辑文件信息（对齐 PC workToolEditedFile） */
private fun editedFileInfo(e: LocalWorkEvent): EditedFileInfo? {
    if (!isFileEditToolName(publicToolNameForUi(e.toolName))) return null
    val args = runCatching { org.json.JSONObject(e.toolArgs.ifBlank { "{}" }) }.getOrDefault(org.json.JSONObject())
    val path = args.optString("path").ifBlank { args.optString("file").ifBlank { args.optString("file_path") } }
    if (path.isBlank()) return null
    val oldContent = args.optString("old_str").ifBlank { args.optString("oldContent") }
    val newContent = args.optString("new_str").ifBlank { args.optString("newContent").ifBlank { args.optString("content") } }
    val oldLines = if (oldContent.isNotEmpty()) oldContent.split(Regex("\\r?\\n")) else emptyList()
    val newLines = if (newContent.isNotEmpty()) newContent.split(Regex("\\r?\\n")) else emptyList()
    val name = path.split(Regex("[\\\\/]")).lastOrNull()?.takeIf { it.isNotBlank() } ?: path
    return EditedFileInfo(name = name, added = newLines.size, deleted = oldLines.size)
}

/** 工具组摘要（对齐 PC workToolGroupLabel，中文） */
private fun toolGroupLabel(events: List<LocalWorkEvent>, completed: Boolean): String {
    val files = events.count { editedFileInfo(it) != null }
    val skills = mutableListOf<String>()
    val mcps = mutableListOf<String>()
    val subagents = mutableListOf<String>()
    var webSearches = 0
    var webFetches = 0
    events.forEach { e ->
        val n = publicToolNameForUi(e.toolName).lowercase()
        when {
            n == "skill" || n == "skill_load" || n == "skill_read" || n == "skill_download" -> skills += toolCommandLabel(e)
            isMcpName(n) -> mcps += toolCommandLabel(e)
            n == "task" || n.startsWith("subagent_") -> subagents += toolCommandLabel(e)
            n == "web_search" -> webSearches++
            n == "web_fetch" || n == "web_catch" -> webFetches++
        }
    }
    val commands = maxOf(0, events.size - files - skills.size - mcps.size - subagents.size - webSearches - webFetches)
    val parts = mutableListOf<String>()
    if (files > 0) parts += if (files > 1) "编辑了多个文件" else "编辑了文件"
    if (skills.isNotEmpty()) parts += skills.joinToString("，")
    if (mcps.isNotEmpty()) parts += mcps.joinToString("，")
    if (subagents.isNotEmpty()) parts += subagents.joinToString("，")
    if (webSearches > 0) parts += if (completed) if (webSearches > 1) "搜索了多个网页" else "搜索了网页" else "正在搜索网页"
    if (webFetches > 0) parts += if (completed) if (webFetches > 1) "抓取了多个网页" else "抓取了网页" else "正在抓取网页"
    if (commands > 0) parts += if (commands > 1) "运行了多个命令" else "运行了命令"
    if (parts.isEmpty()) return if (completed) "调用了工具" else "正在调用工具"
    return if (completed) parts.joinToString("，") else parts.joinToString("，正在")
}

/** 工具行命令标签（对齐 PC workToolCommandLabel，中文） */
private fun toolCommandLabel(e: LocalWorkEvent): String {
    val args = runCatching { org.json.JSONObject(e.toolArgs.ifBlank { "{}" }) }.getOrDefault(org.json.JSONObject())
    val toolName = publicToolNameForUi(e.toolName)
    val n = toolName.lowercase()
    when {
        n == "task" -> {
            val name = args.optString("nature").ifBlank { args.optString("name").ifBlank { args.optString("agent").ifBlank { "Subagent" } } }
            return "调用 Subagent · $name"
        }
        n.startsWith("subagent_") -> {
            val name = args.optString("name").ifBlank { args.optString("id").ifBlank { n.removePrefix("subagent_") } }
            return "Subagent 操作 · $name"
        }
        n == "skill" || n == "skill_load" || n == "skill_read" -> {
            val skillName = args.optString("name")
            if (skillName.isNotBlank()) return "加载 Skill · $skillName"
            return "检索 Skills · " + (args.optString("query").ifBlank { "*" })
        }
        n == "skill_download" -> return "安装 Skill · " + (args.optString("name").ifBlank { args.optString("source") })
        n == "web_fetch" -> return "web_fetch · " + (args.optString("url").ifBlank { args.optString("uri") })
        n == "web_catch" -> return "web_catch · " + (args.optString("url").ifBlank { args.optString("destination") })
        n == "web_search" -> return "web_search · " + (args.optString("url").ifBlank { args.optString("query").ifBlank { args.optString("q") } })
        isMcpName(n) -> {
            var server = args.optString("server").ifBlank { args.optString("server_name").ifBlank { args.optString("mcp_server") } }
            val encoded = n.split("__").filter { it.isNotBlank() }
            if (server.isBlank() && encoded.size > 1) server = encoded[1]
            val mcpTool = args.optString("tool").ifBlank {
                args.optString("name").ifBlank {
                    if (encoded.size > 2) encoded.drop(2).joinToString("/") else n.removePrefix("mcp").removePrefix(":").removePrefix(".").removePrefix("_")
                }
            }
            return "调用 MCP · " + listOf(server, mcpTool).filter { it.isNotBlank() }.joinToString(" / ")
        }
    }
    var command = args.optString("command").ifBlank { args.optString("cmd") }
    if (command.isBlank()) {
        command = when {
            toolName == "read" && args.has("path") -> "read ${args.optString("path")}"
            (toolName == "grep" || toolName == "glob") && (args.has("pattern") || args.has("path")) ->
                "$toolName ${args.optString("pattern").ifBlank { args.optString("path") }}"
            else -> toolName
        }
    }
    command = command.replace(Regex("\\s+"), " ").trim()
    return "Ran $command"
}

/** 工具行图标（对齐 PC workToolRowIcon） */
private fun toolRowIcon(name: String): androidx.compose.ui.graphics.vector.ImageVector {
    val n = publicToolNameForUi(name).lowercase()
    return when {
        n == "task" || n.startsWith("subagent_") -> LucideIcons.Bot
        n == "skill" || n == "skill_download" -> LucideIcons.Sparkles
        isMcpName(n) -> LucideIcons.Plug
        else -> LucideIcons.SquareTerminal
    }
}

/** 思考活动（对齐 PC renderWorkThought：brain + 「进行了思考」+ 展开正文）。 */
@Composable
private fun WorkThoughtRow(event: LocalWorkEvent) {
    val pc = LocalPcColors.current
    var expanded by remember(event.id, event.sequence) { mutableStateOf(false) }
    val content = event.content
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                ) { expanded = !expanded },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = LucideIcons.Brain,
                contentDescription = "thought",
                tint = pc.textDim,
                modifier = Modifier.size(12.dp),
            )
            Spacer(Modifier.width(12.dp))
            Text(
                text = if (event.completed) "进行了思考" else "思考中",
                fontSize = 11.sp,
                color = pc.textDim,
                modifier = Modifier.weight(1f),
            )
            Chevron(collapsed = !expanded, size = 7.dp)
        }
        if (expanded && (content.isNotBlank() || !event.completed)) {
            Text(
                text = content.ifBlank { "正在思考…" },
                fontSize = 11.sp,
                lineHeight = 17.sp,
                color = pc.textDim,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(start = 24.dp, top = 4.dp, bottom = 5.dp),
            )
        }
    }
}

/** 工具组（对齐 PC renderWorkToolGroup：连续 tool_call 合并，结果只回填完成态）。 */
@Composable
private fun WorkToolGroup(events: List<LocalWorkEvent>, completed: Boolean) {
    val pc = LocalPcColors.current
    var expanded by remember(events.firstOrNull()?.id, events.firstOrNull()?.sequence) { mutableStateOf(false) }
    val hasFiles = events.any { editedFileInfo(it) != null }
    val label = toolGroupLabel(events, completed)
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                ) { expanded = !expanded },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = if (hasFiles) LucideIcons.Pencil else LucideIcons.SquareTerminal,
                contentDescription = "tools",
                tint = pc.textDim,
                modifier = Modifier.size(12.dp),
            )
            Spacer(Modifier.width(12.dp))
            Text(
                text = label,
                fontSize = 11.sp,
                color = pc.textDim,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Chevron(collapsed = !expanded, size = 7.dp)
        }
        if (expanded) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 24.dp, top = 4.dp, bottom = 5.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                events.forEach { e -> ToolGroupRow(e) }
            }
        }
    }
}

/** 工具组内单行（对齐 PC conversation-work-activity-item：12px 图标 + command label + detail） */
@Composable
private fun ToolGroupRow(e: LocalWorkEvent) {
    val pc = LocalPcColors.current
    var rowExpanded by remember { mutableStateOf(false) }
    val detail = e.toolArgs
    val label = toolCommandLabel(e)
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                ) { rowExpanded = !rowExpanded },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = toolRowIcon(e.toolName),
                contentDescription = "tool",
                tint = pc.textDim,
                modifier = Modifier.size(12.dp),
            )
            Spacer(Modifier.width(5.dp))
            Text(
                text = label,
                fontSize = 11.sp,
                lineHeight = 16.sp,
                color = pc.textDim,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (e.completed && e.durationMs > 0) {
                Spacer(Modifier.width(8.dp))
                Text(text = formatDuration(e.durationMs), fontSize = 10.sp, color = pc.textDim, fontFamily = FontFamily.Monospace)
            }
        }
        if (rowExpanded && detail.isNotBlank()) {
            Text(
                text = detail,
                fontSize = 10.sp,
                lineHeight = 14.sp,
                color = pc.textDim,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(start = 17.dp, top = 2.dp),
            )
        }
        WorkDisplayImagePreview(e.displayImage)
    }
}

/** 单个工作事件（对齐 .conversation-work-event）：17px 列（12px 图标）+ 内容 */
@Composable
private fun WorkEventRow(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, color: Color) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(imageVector = icon, contentDescription = null, tint = color, modifier = Modifier.size(12.dp))
        Spacer(Modifier.width(12.dp))
        Text(
            text = text,
            fontSize = 11.sp,
            lineHeight = 16.sp,
            color = color,
            modifier = Modifier.weight(1f),
        )
    }
}

/** PC normalizeWorkDisplayImage 的 Compose 投影：仅显示 Agent 公开的 PNG/JPEG。 */
@Composable
private fun WorkDisplayImagePreview(image: com.newmark.mobile.data.WorkDisplayImage?) {
    val normalizedMime = image?.mimeType?.lowercase()?.replace("image/jpg", "image/jpeg") ?: return
    val safe = image.takeIf {
        it.origin == "agent" && normalizedMime in setOf("image/png", "image/jpeg") &&
            it.dataUrl.startsWith("data:$normalizedMime;base64,", ignoreCase = true) &&
            it.dataUrl.length <= 14 * 1024 * 1024
    } ?: return
    var expanded by remember(safe.id, safe.dataUrl) { mutableStateOf(false) }
    val bitmap = remember(safe.dataUrl) {
        runCatching {
            val bytes = android.util.Base64.decode(safe.dataUrl.substringAfter(',', ""), android.util.Base64.DEFAULT)
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull()
    } ?: return
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 5.dp)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { expanded = !expanded },
    ) {
        androidx.compose.foundation.Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = safe.caption.ifBlank { safe.name.ifBlank { "示意图" } },
            contentScale = androidx.compose.ui.layout.ContentScale.Fit,
            modifier = Modifier
                .widthIn(max = 280.dp)
                .align(Alignment.Start)
                .height(if (expanded) 260.dp else 108.dp)
                .clip(NewmarkShapeSmall),
        )
        Text(
            text = safe.caption.ifBlank { safe.name.ifBlank { "示意图" } },
            color = LocalPcColors.current.textDim,
            fontSize = 10.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
}

/** 最终 Agent 回复的 image_display 顺序画廊：图片始终排在回复正文之前。 */
@Composable
private fun WorkDisplayImagePreviews(images: List<com.newmark.mobile.data.WorkDisplayImage>) {
    images.forEach { image -> WorkDisplayImagePreview(image) }
}

/** text/response 投影：正文必须在 Build 内显示，未完成 run 额外标出片段属性。 */
@Composable
private fun WorkNarrativeRow(content: String, incomplete: Boolean) {
    val pc = LocalPcColors.current
    val label = if (incomplete) "未完成回复片段\n$content" else content
    if (label.isBlank()) return
    MarkdownBody(
        text = label,
        baseColor = pc.text,
        baseFontSize = 12f,
        baseLineHeight = 18f,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
    )
}

/** start/status/done/error/interrupted 等公开事件。 */
@Composable
private fun WorkProjectedEventRow(event: LocalWorkEvent) {
    val pc = LocalPcColors.current
    val type = event.type.lowercase()
    val icon = when {
        type == "error" -> LucideIcons.TriangleAlert
        type == "done" -> LucideIcons.Activity
        type.contains("interrupt") -> LucideIcons.Square
        else -> LucideIcons.Activity
    }
    val color = if (type == "error") pc.error else pc.textDim
    val fallback = when (type) {
        "start" -> "已开始"
        "done" -> "已完成"
        "interrupted", "force_interrupted" -> "已中断"
        "queue_update" -> "队列已更新"
        else -> type.replace('_', ' ')
    }
    val label = event.content.ifBlank { fallback }
    WorkEventRow(icon = icon, text = label, color = color)
}

private val GuideTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss")

private fun guideTimestamp(raw: String, fallbackMs: Long): String {
    val epochMs = raw.toLongOrNull()
        ?: runCatching { Instant.parse(raw).toEpochMilli() }.getOrNull()
        ?: fallbackMs.takeIf { it > 0 }
        ?: return ""
    return runCatching {
        GuideTimeFormatter.format(Instant.ofEpochMilli(epochMs).atZone(ZoneId.systemDefault()))
    }.getOrDefault("")
}

/**
 * PC `.work-run-guide-message.chat-msg.user`：Guide 是插入当前 Build 的用户输入，
 * 必须落在右侧用户时间线，而不是显示成 Build 左轨里的普通事件。
 */
@Composable
private fun WorkGuideTimelineRow(event: LocalWorkEvent) {
    val pc = LocalPcColors.current
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val guide = event.guide ?: WorkGuide(
        clientMessageId = event.clientMessageId,
        guideId = event.guideId,
        status = event.status.ifBlank { event.type.removePrefix("guide_").ifBlank { "accepted" } },
        content = event.content,
    )
    val status = guide.status.ifBlank { "accepted" }.lowercase()
    val label = "Guide · " + when (status) {
        "accepted" -> "已接收"
        "applied" -> "已应用"
        "deferred" -> "已延后"
        "rejected" -> "已拒绝"
        else -> status
    }
    val time = guideTimestamp(
        raw = guide.createdAt.ifBlank { event.timestampText },
        fallbackMs = event.timestamp,
    )
    val statusColor = when (status) {
        "rejected" -> pc.error
        "deferred" -> Color(0xFFFFD27A)
        else -> pc.accent
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            horizontalAlignment = Alignment.End,
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("用户输入", fontSize = 10.sp, fontWeight = FontWeight.SemiBold, color = pc.accent)
                if (time.isNotBlank()) Text(" | $time", fontSize = 10.sp, color = pc.textDim)
                Text(
                    text = label,
                    fontSize = 9.sp,
                    color = statusColor,
                    modifier = Modifier
                        .padding(start = 5.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .border(1.dp, statusColor.copy(alpha = 0.34f), RoundedCornerShape(999.dp))
                        .padding(horizontal = 5.dp, vertical = 1.dp),
                )
                MessageActionButton(
                    label = "复制",
                    onClick = {
                        clipboard.setText(AnnotatedString(guide.content))
                        Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
                    },
                ) {
                    Text(text = "⧉", fontSize = 12.sp, color = pc.textDim)
                }
            }
            MarkdownBody(
                text = guide.content,
                baseColor = pc.text,
                alignEnd = true,
            )
            WorkGuideImageAttachments(guide.attachments)
        }
        Spacer(Modifier.width(14.dp))
        MessageDot(statusColor)
        Spacer(Modifier.width(3.dp))
    }
}

/** Guide 回执所携带的用户图片，和 PC 公开 Guide 历史保持同一展示边界。 */
@Composable
private fun WorkGuideImageAttachments(attachments: List<com.newmark.mobile.data.WorkConversationImage>) {
    attachments.filter { attachment ->
        val mime = attachment.mimeType.lowercase().replace("image/jpg", "image/jpeg")
        attachment.origin == "user" && mime in setOf("image/png", "image/jpeg") &&
            attachment.dataUrl.startsWith("data:$mime;base64,", ignoreCase = true) &&
            attachment.dataUrl.length <= 14 * 1024 * 1024
    }.take(6).forEach { attachment ->
        var expanded by remember(attachment.id, attachment.dataUrl) { mutableStateOf(false) }
        val bitmap = remember(attachment.dataUrl) {
            runCatching {
                val bytes = android.util.Base64.decode(attachment.dataUrl.substringAfter(',', ""), android.util.Base64.DEFAULT)
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            }.getOrNull()
        } ?: return@forEach
        androidx.compose.foundation.Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = attachment.name.ifBlank { "Guide 图片" },
            contentScale = androidx.compose.ui.layout.ContentScale.Fit,
            modifier = Modifier
                .fillMaxWidth()
                .wrapContentWidth(Alignment.End)
                .widthIn(max = 280.dp)
                .padding(top = 5.dp)
                .height(if (expanded) 260.dp else 104.dp)
                .clip(NewmarkShapeSmall)
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                ) { expanded = !expanded },
        )
    }
}

@Composable
private fun ThinkingDots() {
    val p = LocalNewmarkColors.current
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
                    .background(p.textTertiary.copy(alpha = if (i == 0) alpha else 0.4f)),
            )
        }
    }
}

@Composable
private fun InputStack(
    goal: RemoteGoal?,
    flow: RemoteFlowTakeover?,
    queueItems: List<QueueMessageUi>,
    queuePaused: Boolean,
    onEditGoal: (String) -> Unit,
    onToggleGoalPause: () -> Unit,
    onDeleteGoal: () -> Unit,
    onToggleQueuePause: () -> Unit,
    onUpdateQueueItem: (String, String) -> Unit,
    onDeleteQueueItem: (String) -> Unit,
    onEditQueueItem: (QueueMessageUi) -> Unit,
    onReorderQueueItems: (List<String>) -> Unit,
    onGuideQueueItem: (String) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (queueItems.isNotEmpty()) QueuePanel(
            items = queueItems,
            paused = queuePaused,
            onTogglePause = onToggleQueuePause,
            onDelete = onDeleteQueueItem,
            onEdit = onEditQueueItem,
            onReorder = onReorderQueueItems,
            onGuide = onGuideQueueItem,
        )
        flow?.promptText?.takeIf { it.isNotBlank() }?.let {
            FlowPromptBar(text = it, paused = flow.paused)
        }
        goal?.takeIf { it.objective.isNotBlank() }?.let {
            RemoteGoalBar(
                goal = it,
                onEdit = { onEditGoal(it.objective) },
                onTogglePause = onToggleGoalPause,
                onDelete = onDeleteGoal,
            )
        }
    }
}

@Composable
private fun StackCard(
    modifier: Modifier = Modifier,
    backgroundBrush: Brush? = null,
    content: @Composable () -> Unit,
) {
    val pc = LocalPcColors.current
    val light = pc == PcColorsLight
    val shape = RoundedCornerShape(8.dp)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .clip(shape)
            .background(backgroundBrush ?: Brush.linearGradient(listOf(
                if (light) Color.White.copy(alpha = 0.72f) else Color(0xEB121422),
                if (light) Color.White.copy(alpha = 0.72f) else Color(0xEB121422),
            )))
            .border(1.dp, pc.border, shape),
    ) { content() }
}

@Composable
private fun FlowPromptBar(text: String, paused: Boolean) {
    val pc = LocalPcColors.current
    val color = if (paused) Color(0xFFE2B74A) else Color(0xFF4CC4A0)
    StackCard(backgroundBrush = Brush.horizontalGradient(
        listOf(color.copy(alpha = 0.14f), Color.Transparent),
    )) {
        Row(Modifier.height(30.dp).padding(horizontal = 9.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusDot(color)
            Spacer(Modifier.width(8.dp))
            Text(text, color = pc.text, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun FlowTakeoverBubble(flow: RemoteFlowTakeover, onToggle: () -> Unit) {
    val pc = LocalPcColors.current
    val paused = flow.paused
    val accent = if (paused) Color(0xFFE06A6A) else pc.accent
    Box(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(if (pc == PcColorsLight) Color.White.copy(alpha = 0.9f) else Color(0xE0121422))
                .border(1.dp, accent.copy(alpha = 0.48f), RoundedCornerShape(999.dp))
                .clickable(onClick = onToggle)
                .padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(LucideIcons.Activity, contentDescription = null, tint = accent, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                text = (if (paused) "Flow 已暂停接管，点击继续" else "当前对话正由 Flow 接管") +
                    flow.name.takeIf { it.isNotBlank() }?.let { "：$it" }.orEmpty() +
                    flow.message.takeIf { paused && it.isNotBlank() }?.let { " · ${it.take(200)}" }.orEmpty(),
                color = pc.text,
                fontSize = 12.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun QueuePanel(
    items: List<QueueMessageUi>,
    paused: Boolean,
    onTogglePause: () -> Unit,
    onDelete: (String) -> Unit,
    onEdit: (QueueMessageUi) -> Unit,
    onReorder: (List<String>) -> Unit,
    onGuide: (String) -> Unit,
) {
    val pc = LocalPcColors.current
    val density = LocalDensity.current
    var collapsed by remember { mutableStateOf(true) }
    var visualItems by remember { mutableStateOf(items) }
    var draggingId by remember { mutableStateOf<String?>(null) }
    var dragOffsetPx by remember { mutableFloatStateOf(0f) }
    var dragSourceIndex by remember { mutableIntStateOf(-1) }
    var dragTargetIndex by remember { mutableIntStateOf(-1) }
    val headerInteractionSource = remember { MutableInteractionSource() }
    val rowStepPx = with(density) { 44.dp.toPx() }
    LaunchedEffect(items) {
        if (draggingId == null) visualItems = items
    }
    StackCard {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(38.dp)
                    .clickable(
                        interactionSource = headerInteractionSource,
                        indication = null,
                    ) { collapsed = !collapsed }
                    .padding(start = 12.dp, end = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(7.dp)
                        .clip(CircleShape)
                        .background(if (paused) Color(0xFFFFC857) else pc.accent2),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    "${items.size} 条待处理",
                    color = if (paused) Color(0xFFD9A928) else pc.textDim,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
                QueueIconButton(
                    icon = if (paused) Icons.Filled.PlayArrow else Icons.Filled.Pause,
                    label = if (paused) "继续队列" else "暂停队列",
                    tint = if (paused) Color(0xFFFFB82E) else pc.textDim,
                    onClick = onTogglePause,
                )
                Spacer(Modifier.width(2.dp))
                QueueIconButton(
                    icon = if (collapsed) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                    label = if (collapsed) "展开" else "折叠",
                    tint = pc.textDim,
                ) { collapsed = !collapsed }
            }
            AnimatedVisibility(
                visible = !collapsed,
                enter = expandVertically(
                    expandFrom = Alignment.Top,
                    animationSpec = tween(durationMillis = 150, easing = PcQueueEase),
                ),
                exit = shrinkVertically(
                    shrinkTowards = Alignment.Top,
                    animationSpec = tween(durationMillis = 150, easing = PcQueueEase),
                ),
            ) {
                Column(
                    Modifier
                        .heightIn(max = 196.dp)
                        .padding(horizontal = 5.dp, vertical = 4.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    visualItems.forEachIndexed { index, item ->
                        key(item.id) {
                            QueueRow(
                                item = item,
                                dragging = draggingId == item.id,
                                dragOffsetPx = if (draggingId == item.id) dragOffsetPx else 0f,
                                displacedOffsetPx = queueRowDisplacementPx(
                                    rowIndex = index,
                                    sourceIndex = dragSourceIndex,
                                    targetIndex = dragTargetIndex,
                                    rowStepPx = rowStepPx,
                                ),
                                onDragStart = {
                                    draggingId = item.id
                                    dragOffsetPx = 0f
                                    dragSourceIndex = index
                                    dragTargetIndex = index
                                },
                                onDrag = { delta ->
                                    if (draggingId != item.id) return@QueueRow
                                    val minimum = -dragSourceIndex * rowStepPx
                                    val maximum = (visualItems.lastIndex - dragSourceIndex) * rowStepPx
                                    dragOffsetPx = (dragOffsetPx + delta).coerceIn(minimum, maximum)
                                    dragTargetIndex = queueDragTargetIndex(
                                        sourceIndex = dragSourceIndex,
                                        dragOffsetPx = dragOffsetPx,
                                        rowStepPx = rowStepPx,
                                        itemCount = visualItems.size,
                                    )
                                },
                                onDragEnd = {
                                    val source = dragSourceIndex
                                    val target = dragTargetIndex
                                    if (source in visualItems.indices && target in visualItems.indices && source != target) {
                                        val reordered = visualItems.toMutableList()
                                        val moved = reordered.removeAt(source)
                                        reordered.add(target, moved)
                                        visualItems = reordered
                                        onReorder(reordered.map { it.id })
                                    }
                                    draggingId = null
                                    dragOffsetPx = 0f
                                    dragSourceIndex = -1
                                    dragTargetIndex = -1
                                },
                                onDragCancel = {
                                    draggingId = null
                                    dragOffsetPx = 0f
                                    dragSourceIndex = -1
                                    dragTargetIndex = -1
                                },
                                onEdit = onEdit,
                                onDelete = onDelete,
                                onGuide = onGuide,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun QueueRow(
    item: QueueMessageUi,
    dragging: Boolean,
    dragOffsetPx: Float,
    displacedOffsetPx: Float,
    onDragStart: () -> Unit,
    onDrag: (Float) -> Unit,
    onDragEnd: () -> Unit,
    onDragCancel: () -> Unit,
    onEdit: (QueueMessageUi) -> Unit,
    onDelete: (String) -> Unit,
    onGuide: (String) -> Unit,
) {
    val pc = LocalPcColors.current
    val animatedDisplacementPx by animateFloatAsState(
        targetValue = displacedOffsetPx,
        animationSpec = tween(durationMillis = 150, easing = PcQueueEase),
        label = "queueNeighborDisplacement",
    )
    Row(
        Modifier
            .fillMaxWidth()
            .height(44.dp)
            .zIndex(if (dragging) 2f else 0f)
            .graphicsLayer {
                translationY = if (dragging) dragOffsetPx else animatedDisplacementPx
                scaleX = if (dragging) 0.99f else 1f
                scaleY = if (dragging) 0.99f else 1f
                alpha = if (dragging) 0.58f else 1f
            }
            .clip(NewmarkShapeSmall)
            .background(
                if (dragging) pc.accent.copy(alpha = 0.08f)
                else pc.text.copy(alpha = 0.025f),
            )
            .padding(start = 7.dp, end = 5.dp, top = 5.dp, bottom = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(width = 16.dp, height = 24.dp)
                // Drag ownership belongs only to the handle. A row-wide
                // long-press detector competes with Guide/edit/delete taps.
                .pointerInput(item.id, item.editable) {
                    if (!item.editable) return@pointerInput
                    detectDragGesturesAfterLongPress(
                        onDragStart = { onDragStart() },
                        onDragEnd = onDragEnd,
                        onDragCancel = onDragCancel,
                        onDrag = { change, amount ->
                            change.consume()
                            onDrag(amount.y)
                        },
                    )
                }
                .drawBehind {
                    val dotColor = pc.textDim
                    val radius = 1.25.dp.toPx()
                    val x1 = size.width * 0.35f
                    val x2 = size.width * 0.65f
                    for (row in 1..3) {
                        val y = size.height * row / 4f
                        drawCircle(dotColor, radius, Offset(x1, y))
                        drawCircle(dotColor, radius, Offset(x2, y))
                    }
                },
        )
        Spacer(Modifier.width(5.dp))
        Text(
            item.text,
            color = pc.text,
            fontSize = 11.sp,
            lineHeight = 14.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (item.editable) {
            QueueIconButton(LucideIcons.ArrowRight, "立即 Guide", pc.accent2) { onGuide(item.id) }
            QueueIconButton(LucideIcons.SquarePen, "编辑", pc.textDim) { onEdit(item) }
            QueueIconButton(LucideIcons.X, "删除", Color(0xFFFF6F7D)) { onDelete(item.id) }
        }
    }
}

/** Queue-only borderless action: color and lift replace the old framed glass button. */
@Composable
private fun QueueIconButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    tint: Color,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        modifier = Modifier
            .size(28.dp)
            .graphicsLayer {
                scaleX = if (pressed) 1.08f else 1f
                scaleY = if (pressed) 1.08f else 1f
                translationY = if (pressed) (-0.75).dp.toPx() else 0f
            }
            .clip(CircleShape)
            .background(tint.copy(alpha = if (pressed) 0.15f else 0f))
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            contentDescription = label,
            tint = tint.copy(alpha = if (pressed) 1f else 0.88f),
            modifier = Modifier.size(14.dp),
        )
    }
}

@Composable
private fun StackIconButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, tint: Color, onClick: () -> Unit) {
    Box(Modifier.size(24.dp).glassButtonSurface(NewmarkShapeSmall, alpha = 0.58f).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(13.dp))
    }
}

@Composable
private fun StatusDot(color: Color) {
    Box(Modifier.size(12.dp).clip(CircleShape).background(color.copy(alpha = 0.13f)), contentAlignment = Alignment.Center) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(color))
    }
}

/** 远程 goal bar，位置和操作与 PC #goal-bar 同构。 */
@Composable
private fun RemoteGoalBar(goal: RemoteGoal, onEdit: () -> Unit, onTogglePause: () -> Unit, onDelete: () -> Unit) {
    val pc = LocalPcColors.current
    val isDark = pc == PcColorsDark
    val paused = goal.paused
    val dotColor = if (paused) Color(0xFFF4C95D) else pc.accent
    val haloColor = if (paused) Color(0x1FF4C95D) else Color(0x1F5B78FF)
    val bg = if (isDark) {
        Brush.horizontalGradient(listOf(Color(0x1A5B78FF), Color(0xF0121422)))
    } else {
        Brush.horizontalGradient(listOf(Color(0x215B78FF), Color(0xD1FFFFFF)))
    }
    StackCard(backgroundBrush = bg) {
        Row(Modifier.fillMaxWidth().height(30.dp).padding(start = 9.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusDot(dotColor)
            Spacer(Modifier.width(8.dp))
            Text(
                text = goal.objective.ifBlank { "（未设置目标）" },
                fontSize = 12.sp,
                color = pc.text,
                modifier = Modifier.weight(1f).clickable(onClick = onEdit),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            StackIconButton(LucideIcons.SquarePen, "编辑目标", pc.textDim, onEdit)
            StackIconButton(if (paused) Icons.Filled.PlayArrow else Icons.Filled.Pause, if (paused) "继续目标" else "暂停目标", if (paused) Color(0xFFFFCC44) else pc.textDim, onTogglePause)
            StackIconButton(LucideIcons.X, "删除目标", Color(0xFFFF7777), onDelete)
        }
    }
}

// ---- 输入区 ----
@Composable
private fun InputArea(
    running: Boolean,
    remoteMode: Boolean,
    modelOptions: List<ModelOption>,
    selectedModel: String,
    selectedModelName: String,
    intelligence: String,
    selectedMode: String,
    value: TextFieldValue,
    pendingImage: com.newmark.mobile.data.LocalImageAttachment? = null,
    onRemovePendingImage: () -> Unit = {},
    onValueChange: (TextFieldValue) -> Unit,
    onSelectModel: (ModelOption) -> Unit,
    onSelectIntelligence: (String) -> Unit,
    onSelectMode: (String) -> Unit,
    onSend: (String) -> Unit,
    onGuide: (String) -> Boolean,
    onStop: () -> Unit,
    escalating: Boolean = false,
    onInputBoundsChanged: (Rect) -> Unit = {},
    onPlusAnchorBoundsChanged: (Rect) -> Unit,
    onModelAnchorBoundsChanged: (Rect) -> Unit,
    onOpenPlusMenu: () -> Unit,
    onOpenModelMenu: () -> Unit,
    focusRequester: FocusRequester,
    modifier: Modifier = Modifier,
) {
    val p = LocalNewmarkColors.current
    var mode by remember { mutableStateOf(selectedMode) }
    var inputLineCount by remember { mutableIntStateOf(1) }
    LaunchedEffect(selectedMode) {
        mode = selectedMode
    }
    // One line is 48dp tall on the formal portrait device, so CircleShape's
    // radius there is 24dp. Keep that exact R value when the editor grows;
    // using CircleShape for multiple lines would incorrectly increase it to
    // half of the new height.
    val inputShape = RoundedCornerShape(InputComposerCornerRadius)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(p.bgSecondary),
    ) {
        // PC `.prompt-attachments` 同款：选中图片后在输入框上方显示缩略图 + 文件名 + 移除。
        if (pendingImage != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 12.dp, end = 12.dp, top = 8.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(p.bgPrimary)
                    .border(1.dp, p.border2, RoundedCornerShape(10.dp))
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val bitmap = remember(pendingImage.dataUrl) {
                    runCatching {
                        val bytes = android.util.Base64.decode(pendingImage.dataUrl.substringAfter(",", ""), android.util.Base64.DEFAULT)
                        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    }.getOrNull()
                }
                if (bitmap != null) {
                    androidx.compose.foundation.Image(
                        bitmap = bitmap.asImageBitmap(),
                        contentDescription = "待发送图片",
                        modifier = Modifier
                            .size(42.dp)
                            .clip(RoundedCornerShape(5.dp))
                            .border(1.dp, p.border2, RoundedCornerShape(5.dp)),
                        contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                    )
                } else {
                    Box(
                        modifier = Modifier
                            .size(42.dp)
                            .clip(RoundedCornerShape(5.dp))
                            .background(p.bgQuaternary),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Upload,
                            contentDescription = null,
                            tint = p.textTertiary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
                Spacer(Modifier.width(8.dp))
                Text(
                    text = pendingImage.name.ifBlank { "待发送图片" },
                    fontSize = 12.sp,
                    color = p.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .clickable(onClick = onRemovePendingImage),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = LucideIcons.X,
                        contentDescription = "移除图片",
                        tint = p.textTertiary,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }
        // 单行：+（模式/文件） | 输入 | 模型小按钮 | 发送。整个输入条和其锚定菜单一起随 IME 上移。
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .background(p.bgPrimary, inputShape)
                .border(1.dp, p.border2, inputShape)
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            Box(
                Modifier
                    .width(32.dp)
                    .padding(bottom = InputComposerPlusBottomOffset),
                contentAlignment = Alignment.Center,
            ) {
                PlusCombo(
                    onMode = {
                        mode = it
                        onSelectMode(it)
                    },
                    onAnchorBoundsChanged = onPlusAnchorBoundsChanged,
                    onOpenMenu = onOpenPlusMenu,
                )
            }
            Spacer(Modifier.width(8.dp))
            Box(
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 36.dp)
                    .onGloballyPositioned { onInputBoundsChanged(it.boundsInRoot()) },
                contentAlignment = Alignment.CenterStart,
            ) {
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    modifier = Modifier
                        .fillMaxWidth()
                        .offset(y = if (inputLineCount == 1) InputComposerSingleLineOpticalOffset else 0.dp)
                        .focusRequester(focusRequester),
                    textStyle = TextStyle(
                        color = p.textPrimary,
                        fontSize = 14.sp,
                        lineHeight = 20.sp,
                        platformStyle = PlatformTextStyle(includeFontPadding = false),
                    ),
                    minLines = 1,
                    maxLines = InputComposerMaxLines,
                    onTextLayout = { inputLineCount = it.lineCount },
                    decorationBox = { inner ->
                        if (value.text.isEmpty()) {
                            Text(
                                text = "输入消息...",
                                color = p.textTertiary,
                                fontSize = 14.sp,
                                lineHeight = 20.sp,
                                style = TextStyle(
                                    platformStyle = PlatformTextStyle(includeFontPadding = false),
                                ),
                            )
                        }
                        inner()
                    },
                )
            }
            Spacer(Modifier.width(8.dp))
            Box(Modifier.size(InputComposerEdgeControlSize)) {
                ModelButton(
                    selectedModel = selectedModel,
                    selectedModelName = selectedModelName,
                    intelligence = intelligence,
                    options = modelOptions,
                    onSelectModel = onSelectModel,
                    onSelectIntelligence = onSelectIntelligence,
                    onAnchorBoundsChanged = onModelAnchorBoundsChanged,
                    onOpenMenu = onOpenModelMenu,
                )
            }
            Spacer(Modifier.width(6.dp))
            Box(Modifier.offset(x = InputComposerHorizontalCenterCompensation)) {
                SubmitButton(
                    running = running,
                    hasText = value.text.isNotBlank(),
                    onClick = {
                        onSend(value.text)
                        onValueChange(TextFieldValue())
                    },
                    onGuide = {
                        val accepted = onGuide(value.text)
                        if (accepted) onValueChange(TextFieldValue())
                    },
                    onStop = onStop,
                    escalating = escalating,
                )
            }
        }
    }
}

@Composable
private fun InputCompositeMenuOverlay(
    menu: InputCompositeMenu?,
    containerBounds: State<Rect?>,
    plusAnchor: State<Rect?>,
    modelAnchor: State<Rect?>,
    remoteMode: Boolean,
    mode: String,
    selectedModel: String,
    selectedProviderId: String,
    selectedModelName: String,
    intelligence: String,
    options: List<ModelOption>,
    backdrop: Backdrop,
    onMenuChange: (InputCompositeMenu) -> Unit,
    onDismiss: () -> Unit,
    onMode: (String) -> Unit,
    onSelectModel: (ModelOption) -> Unit,
    onSelectIntelligence: (String) -> Unit,
    onChooseFile: () -> Unit,
    onChooseImage: () -> Unit,
) {
    val setSidebarGestureLock = LocalSidebarGestureLock.current
    DisposableEffect(menu) {
        setSidebarGestureLock("input-popup", menu != null)
        onDispose { setSidebarGestureLock("input-popup", false) }
    }
    var pageOriginY by remember { mutableFloatStateOf(0.5f) }
    val visibleMenu = menu ?: return
    val popupScale = remember { Animatable(0.82f) }
    val popupAlpha = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        launch { popupScale.animateTo(1f, tween(260, easing = PcQueueEase)) }
        popupAlpha.animateTo(1f, tween(180, easing = PcQueueEase))
    }
    val activeWindowAnchor = when (visibleMenu) {
        InputCompositeMenu.PlusMain, InputCompositeMenu.PlusModes -> plusAnchor.value
        InputCompositeMenu.ModelMain, InputCompositeMenu.Models, InputCompositeMenu.Tiers -> modelAnchor.value
    }
    val visibleAnchor = activeWindowAnchor?.let { anchor ->
        containerBounds.value?.let { container -> inputMenuAnchorInContainer(anchor, container) }
    } ?: return
    val p = LocalNewmarkColors.current
    val density = LocalDensity.current
    val config = LocalConfiguration.current
    // First and second levels share the exact same compact shell. Model rows
    // scroll inside it; a secondary page must never widen the popup.
    val width = 190.dp
    val widthPx = with(density) { width.roundToPx() }
    val marginPx = with(density) { 8.dp.roundToPx() }
    var overlaySize by remember { mutableStateOf(IntSize.Zero) }
    val windowWidthPx = overlaySize.width.takeIf { it > 0 }
        ?: with(density) { config.screenWidthDp.dp.roundToPx() }
    val xPx = centeredInputMenuX(
        anchor = visibleAnchor,
        popupWidthPx = widthPx,
        viewportWidthPx = windowWidthPx,
        marginPx = marginPx,
    )
    val gapPx = with(density) { 6.dp.roundToPx() }
    // Align the menu's bottom edge to the anchor's top edge. Content expands
    // upward from that edge, so its first frame never needs a measured height
    // and cannot jump after IME-safe placement resolves.
    val bottomAnchorOffset = visibleAnchor.top.toInt() - gapPx - overlaySize.height
    val availableModes = remember(remoteMode) { if (remoteMode) MODES else listOf("Build", "Plan", "Chat") }
    val groupedModelOptions = remember(options) { groupModelOptions(options) }
    val currentOnMenuChange = rememberUpdatedState(onMenuChange)
    val currentOnDismiss = rememberUpdatedState(onDismiss)
    val currentOnMode = rememberUpdatedState(onMode)
    val currentOnSelectModel = rememberUpdatedState(onSelectModel)
    val currentOnSelectIntelligence = rememberUpdatedState(onSelectIntelligence)
    val currentOnChooseFile = rememberUpdatedState(onChooseFile)
    val currentOnChooseImage = rememberUpdatedState(onChooseImage)
    val updateInteractionOrigin = remember { { origin: Float -> pageOriginY = origin } }
    val menuShape = MobilePopupShape

    Box(
        Modifier
            .fillMaxSize()
            .onSizeChanged { overlaySize = it }
            .zIndex(20f)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onDismiss,
            ),
    ) {
        Box(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .offset { IntOffset(xPx, bottomAnchorOffset) },
        ) {
            Box(
                modifier = Modifier
                    .width(width)
                    .heightIn(max = 320.dp)
                    .graphicsLayer {
                        alpha = popupAlpha.value
                        scaleX = popupScale.value
                        scaleY = popupScale.value
                        transformOrigin = TransformOrigin(0.5f, 1f)
                    }
                    .liquidGlassModifier(
                        backdrop = backdrop,
                        shape = menuShape,
                        alpha = 0.72f,
                        blurRadius = 14.dp,
                        refractionHeight = MobileInteractionGlassEdge,
                        refractionAmount = 14.dp,
                        saturation = 1.25f,
                        surfaceColor = p.bgTertiary,
                        ambientHighlight = true,
                    )
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = {},
                    )
                    .padding(8.dp),
            ) {
                AnimatedContent(
                    targetState = visibleMenu,
                    transitionSpec = {
                        (fadeIn(
                            animationSpec = tween(durationMillis = 150, easing = PcQueueEase),
                        ) + scaleIn(
                            initialScale = 0.78f,
                            transformOrigin = TransformOrigin(0.5f, pageOriginY),
                            animationSpec = tween(durationMillis = 220, easing = PcQueueEase),
                        ) togetherWith fadeOut(
                            animationSpec = tween(durationMillis = 90, easing = PcQueueEase),
                        ) + scaleOut(
                            targetScale = 0.96f,
                            transformOrigin = TransformOrigin(0.5f, pageOriginY),
                            animationSpec = tween(durationMillis = 110, easing = PcQueueEase),
                        )).using(
                            SizeTransform(
                                clip = false,
                                sizeAnimationSpec = { _, _ ->
                                    tween(durationMillis = 220, easing = PcQueueEase)
                                },
                            ),
                        )
                    },
                    label = "inputCompositeMenuPageMorph",
                ) { targetMenu ->
                    val pageScroll = rememberScrollState()
                    val entrySet = remember(
                        targetMenu,
                        mode,
                        selectedModel,
                        selectedProviderId,
                        selectedModelName,
                        intelligence,
                        availableModes,
                        groupedModelOptions,
                    ) { LiquidMenuEntries(when (targetMenu) {
                        InputCompositeMenu.PlusMain -> listOf(
                            LiquidMenuEntry("模式选择", mode) { currentOnMenuChange.value(InputCompositeMenu.PlusModes) },
                            LiquidMenuEntry("选择文件") { currentOnDismiss.value(); currentOnChooseFile.value() },
                            LiquidMenuEntry("选择图片") { currentOnDismiss.value(); currentOnChooseImage.value() },
                        )
                        InputCompositeMenu.PlusModes -> listOf(
                            LiquidMenuEntry("← 返回") { currentOnMenuChange.value(InputCompositeMenu.PlusMain) },
                        ) + availableModes.map { candidate ->
                            LiquidMenuEntry(candidate, selected = candidate == mode) {
                                currentOnMode.value(candidate)
                                currentOnDismiss.value()
                            }
                        }
                        InputCompositeMenu.ModelMain -> listOf(
                            LiquidMenuEntry(
                                "模型选择",
                                selectedModelMenuLabel(selectedModel, selectedProviderId, selectedModelName, options),
                            ) { currentOnMenuChange.value(InputCompositeMenu.Models) },
                            LiquidMenuEntry("智能档位", intelligence.ifBlank { "medium" }) {
                                currentOnMenuChange.value(InputCompositeMenu.Tiers)
                            },
                        )
                        InputCompositeMenu.Models -> buildList {
                            add(LiquidMenuEntry("← 返回") { currentOnMenuChange.value(InputCompositeMenu.ModelMain) })
                            if (options.isEmpty()) {
                                add(LiquidMenuEntry("暂无可用模型") { currentOnDismiss.value() })
                            }
                            groupedModelOptions.forEach { group ->
                                add(LiquidMenuEntry(group.providerLabel, header = true))
                                group.options.forEach { option ->
                                    add(
                                        LiquidMenuEntry(
                                            text = modelOptionDisplayName(option),
                                            selected = modelOptionMatchesSelection(
                                                option,
                                                selectedProviderId,
                                                selectedModelName,
                                            ),
                                        ) {
                                            currentOnSelectModel.value(option)
                                            currentOnDismiss.value()
                                        },
                                    )
                                }
                            }
                        }
                        InputCompositeMenu.Tiers -> listOf(
                            LiquidMenuEntry("← 返回") { currentOnMenuChange.value(InputCompositeMenu.ModelMain) },
                        ) + INTELLIGENCE_TIERS.map { tier ->
                            LiquidMenuEntry(tier, selected = tier == intelligence) {
                                currentOnSelectIntelligence.value(tier)
                                currentOnDismiss.value()
                            }
                        }
                    }) }
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(max = 312.dp)
                            .verticalScroll(pageScroll),
                    ) {
                        LiquidMenuList(
                            entrySet = entrySet,
                            onInteractionOrigin = updateInteractionOrigin,
                        )
                    }
                }
            }
        }
    }
}

private data class LiquidMenuEntry(
    val text: String,
    val trailing: String = "",
    val selected: Boolean = false,
    val header: Boolean = false,
    val onActivate: () -> Unit = {},
)

@Immutable
private data class LiquidMenuEntries(val values: List<LiquidMenuEntry>)

@Immutable
private data class LiquidMenuGeometry(
    val offsets: List<Dp>,
    val totalHeight: Dp,
    val selectedIndex: Int,
    val gestureKeys: List<Pair<String, Boolean>>,
)

private class LiquidMenuFlightScheduler(initialIndex: Int) {
    var job: kotlinx.coroutines.Job? = null
    var activeIndex: Int = initialIndex

    fun cancel() {
        job?.cancel()
        job = null
    }
}

@Composable
private fun LiquidMenuList(
    entrySet: LiquidMenuEntries,
    onInteractionOrigin: (Float) -> Unit,
) {
    val entries = entrySet.values
    val p = LocalNewmarkColors.current
    val rowHeight = 44.dp
    val headerHeight = 26.dp
    val geometry = remember(entrySet) {
        var y = 0.dp
        val offsets = entries.map { entry ->
            val offset = y
            y += if (entry.header) headerHeight else rowHeight
            offset
        }
        LiquidMenuGeometry(
            offsets = offsets,
            totalHeight = y,
            selectedIndex = entries.indexOfFirst { it.selected },
            gestureKeys = entries.map { it.text to it.header },
        )
    }
    val offsets = geometry.offsets
    val totalHeight = geometry.totalHeight
    val selectedIndex = geometry.selectedIndex
    val selectionBackdrop = rememberLiquidBackdrop()
    val interactionScope = rememberCoroutineScope()
    val density = LocalDensity.current
    val flightScheduler = remember(entrySet) { LiquidMenuFlightScheduler(selectedIndex) }
    DisposableEffect(flightScheduler) {
        onDispose { flightScheduler.cancel() }
    }
    var moving by remember(entrySet) { mutableStateOf(false) }
    var lifting by remember(entrySet) { mutableStateOf(false) }
    var landing by remember(entrySet) { mutableStateOf(false) }
    var heldBoundaryOffsetPx by remember(entrySet) { mutableFloatStateOf(0f) }
    val activeOffsetPx = remember { Animatable(0f) }
    LaunchedEffect(selectedIndex, offsets, density.density) {
        if (!moving && selectedIndex >= 0) {
            flightScheduler.activeIndex = selectedIndex
            activeOffsetPx.snapTo(with(density) { offsets[selectedIndex].toPx() })
        }
    }
    val glassProgress by animateFloatAsState(
        targetValue = if (landing || lifting) 0f else if (moving) 1f else 0f,
        animationSpec = tween(durationMillis = if (landing) 240 else 100, easing = PcQueueEase),
        label = "liquidMenuSelectionMaterial",
    )

    fun interactiveIndexAt(yPx: Float, density: Float): Int {
        val yDp = yPx / density
        return entries.indices.firstOrNull { index ->
            !entries[index].header && yDp >= offsets[index].value && yDp < offsets[index].value + rowHeight.value
        } ?: -1
    }

    fun commitSelection(index: Int) {
        if (index >= 0) {
            onInteractionOrigin(
                ((offsets[index] + rowHeight / 2) / totalHeight).coerceIn(0f, 1f),
            )
            entries[index].onActivate()
        }
    }

    fun landSelection(index: Int) {
        flightScheduler.cancel()
        flightScheduler.job = interactionScope.launch {
            heldBoundaryOffsetPx = 0f
            runOverlappedLiquidFlight(
                lift = {},
                move = { activeOffsetPx.animateTo(with(density) { offsets.getOrElse(index) { 0.dp }.toPx() }, tween(durationMillis = 120, easing = PcQueueEase)) },
                onLandingStarted = { landing = true },
                land = { delay(240L) },
            )
            landing = false
            moving = false
            commitSelection(index)
        }
    }

    fun flySelectionTo(index: Int) {
        if (index < 0) return
        val redirecting = moving
        flightScheduler.cancel()
        val sourceIndex = selectedIndex.takeIf { it >= 0 } ?: index
        if (!redirecting) {
            flightScheduler.activeIndex = sourceIndex
            lifting = true
            moving = true
        }
        flightScheduler.job = interactionScope.launch {
            if (!redirecting) {
                activeOffsetPx.snapTo(with(density) { offsets[sourceIndex].toPx() })
                kotlinx.coroutines.yield()
                lifting = false
            }
            flightScheduler.activeIndex = index
            val targetOffset = with(density) { offsets[index].toPx() }
            runOverlappedLiquidFlight(
                lift = { lifting = false; delay(100L) },
                move = { if (kotlin.math.abs(activeOffsetPx.value - targetOffset) >= 0.5f) activeOffsetPx.animateTo(targetOffset, tween(durationMillis = 240, easing = PcQueueEase)) },
                onLandingStarted = { landing = true },
                land = { delay(240L) },
            )
            landing = false
            moving = false
            commitSelection(index)
        }
    }

    fun beginHeldSelection(index: Int) {
        if (index < 0) return
        val redirecting = moving
        flightScheduler.cancel()
        val sourceIndex = selectedIndex.takeIf { it >= 0 } ?: index
        if (!redirecting) {
            flightScheduler.activeIndex = sourceIndex
            lifting = true
            moving = true
        }
        flightScheduler.job = interactionScope.launch {
            if (!redirecting) {
                activeOffsetPx.snapTo(with(density) { offsets[sourceIndex].toPx() })
            }
            flightScheduler.activeIndex = index
            runOverlappedLiquidFlight(
                holdKeepsLifted = true,
                lift = { kotlinx.coroutines.yield(); lifting = false; delay(100L) },
                move = { activeOffsetPx.animateTo(with(density) { offsets[index].toPx() }, tween(durationMillis = 240, easing = PcQueueEase)) },
                onLandingStarted = {}, land = {},
            )
        }
    }

    Box(
        Modifier
            .fillMaxWidth()
            .height(totalHeight)
            .liquidHoldDragGesture(
                geometry.gestureKeys,
                holdMillis = 300L,
                onTap = { position ->
                    flySelectionTo(interactiveIndexAt(position.y, density.density))
                },
                onHoldStart = { position ->
                    beginHeldSelection(interactiveIndexAt(position.y, density.density))
                },
                onDrag = { position, _ ->
                    val firstInteractive = entries.indices.firstOrNull { !entries[it].header }
                    val lastInteractive = entries.indices.lastOrNull { !entries[it].header }
                    if (firstInteractive != null && lastInteractive != null) {
                        val minimum = with(density) { offsets[firstInteractive].toPx() }
                        val maximum = with(density) { offsets[lastInteractive].toPx() }
                        val raw = position.y - with(density) { rowHeight.toPx() / 2f }
                        heldBoundaryOffsetPx = resistedLiquidBoundaryPosition(
                            raw = raw,
                            minimum = minimum,
                            maximum = maximum,
                            maxDisplacement = with(density) { 4.dp.toPx() },
                        ) - raw.coerceIn(minimum, maximum)
                    }
                    interactiveIndexAt(position.y, density.density)
                        .takeIf { it >= 0 && it != flightScheduler.activeIndex }
                        ?.let { index ->
                            flightScheduler.activeIndex = index
                            flightScheduler.cancel()
                            flightScheduler.job = interactionScope.launch {
                                activeOffsetPx.animateTo(
                                    with(density) { offsets[index].toPx() },
                                    spring(dampingRatio = 0.82f, stiffness = 170f),
                                )
                            }
                        }
                },
                onHoldEnd = { position, _ ->
                    val releasedIndex = interactiveIndexAt(position.y, density.density)
                        .takeIf { it >= 0 }
                        ?: flightScheduler.activeIndex
                    flightScheduler.activeIndex = releasedIndex
                    landSelection(releasedIndex)
                },
                onCancel = {
                    flightScheduler.cancel()
                    heldBoundaryOffsetPx = 0f
                    moving = false
                    lifting = false
                    landing = false
                },
            ),
    ) {
        if ((moving || landing) && flightScheduler.activeIndex >= 0) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(rowHeight)
                    .graphicsLayer {
                        translationY = activeOffsetPx.value + heldBoundaryOffsetPx
                    }
                    .liquidMotionDeformationDeferred(
                        velocityX = { 0f },
                        velocityY = { activeOffsetPx.velocity },
                        density = density.density,
                    )
                    .zIndex(4f)
                    .liquidSelectionMorph(
                        backdrop = selectionBackdrop,
                        shape = RoundedCornerShape(22.dp),
                        fillColor = p.accentSoft,
                        glassProgress = glassProgress,
                        glassAlpha = 0.10f,
                        blurRadius = 2.dp,
                        refractionHeight = MobileInteractionGlassEdge,
                        refractionAmount = 24.dp,
                        saturation = 1.2f,
                    ),
            )
        }
        Column(
            Modifier
                .fillMaxWidth()
                .then(if (moving || landing) Modifier.layerBackdrop(selectionBackdrop) else Modifier),
        ) {
            entries.forEachIndexed { index, entry ->
                if (entry.header) {
                    Text(
                        text = entry.text,
                        color = p.accent,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(headerHeight)
                            .padding(horizontal = 12.dp, vertical = 5.dp),
                    )
                } else {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(rowHeight)
                            .background(
                                if (entry.selected && !(moving || landing)) p.accentSoft
                                else Color.Transparent,
                                RoundedCornerShape(22.dp),
                            )
                            .padding(horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = entry.text,
                            color = p.textPrimary,
                            fontSize = 12.sp,
                            fontWeight = if (entry.selected) FontWeight.Medium else FontWeight.Normal,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        if (entry.trailing.isNotBlank()) {
                            Spacer(Modifier.width(10.dp))
                            Text(
                                text = entry.trailing,
                                color = p.textTertiary,
                                fontSize = 10.5.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** 模型选择按钮：复合「模型选择 + 智能档位」的单图标按钮（发送键左侧） */
@Composable
private fun ModelButton(
    selectedModel: String,
    selectedModelName: String,
    intelligence: String,
    options: List<ModelOption>,
    onSelectModel: (ModelOption) -> Unit,
    onSelectIntelligence: (String) -> Unit,
    onAnchorBoundsChanged: (Rect) -> Unit,
    onOpenMenu: () -> Unit,
) {
    val p = LocalNewmarkColors.current
    GlassButtonCanvas(
        visualSize = InputComposerEdgeControlSize,
        shape = CircleShape,
        surfaceColor = p.bgQuaternary,
        onClick = onOpenMenu,
        visualModifier = Modifier.onGloballyPositioned { onAnchorBoundsChanged(it.boundsInWindow()) },
    ) {
        Icon(Icons.Filled.AutoAwesome, "模型", tint = p.textSecondary, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun PlusCombo(
    onMode: (String) -> Unit,
    onAnchorBoundsChanged: (Rect) -> Unit,
    onOpenMenu: () -> Unit,
) {
    val p = LocalNewmarkColors.current
    GlassButtonCanvas(
        visualSize = InputComposerPlusSize,
        shape = CircleShape,
        surfaceColor = p.bgTertiary,
        onClick = onOpenMenu,
        visualModifier = Modifier.onGloballyPositioned { onAnchorBoundsChanged(it.boundsInWindow()) },
    ) {
        Icon(Icons.Filled.Add, "模式与文件", tint = p.accent, modifier = Modifier.size(18.dp))
    }
}

internal enum class SubmitButtonMode {
    IdleSend,
    RunningStop,
    RunningSend,
}

internal fun submitButtonMode(running: Boolean, hasText: Boolean): SubmitButtonMode = when {
    !running -> SubmitButtonMode.IdleSend
    hasText -> SubmitButtonMode.RunningSend
    else -> SubmitButtonMode.RunningStop
}

internal const val DirectGuideHoldMillis = 300L
internal fun directGuideDragArmed(verticalOffsetPx: Float, thresholdPx: Float): Boolean =
    verticalOffsetPx <= -thresholdPx

@Composable
private fun SubmitButton(
    running: Boolean,
    hasText: Boolean,
    onClick: () -> Unit,
    onGuide: () -> Unit,
    onStop: () -> Unit,
    escalating: Boolean = false,
) {
    val p = LocalNewmarkColors.current
    // 按压缩放（对齐 PC :active scale(0.92)）
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 1.06f else 1f,
        animationSpec = tween(durationMillis = 80),
        label = "submitLiquidExpansion",
    )
    val shape = CircleShape
    val isDark = LocalPcColors.current == PcColorsDark
    when (submitButtonMode(running, hasText)) {
    SubmitButtonMode.RunningStop -> {
        // 三形态之「运行中/强制停止」（对齐 PC #submit-btn.running-action + .marquee-border）：
        // 背景 rgba(14,16,24,.88) + border rgba(255,255,255,.08) + 白图标；escalating=octagon-x，否则 square
        GlassButtonCanvas(
            visualSize = InputComposerEdgeControlSize,
            shape = shape,
            surfaceColor = if (isDark) Color(0xFF0E1018) else Color.White,
            alpha = if (isDark) 0.88f else 0.72f,
            onClick = onStop,
            interactionSource = interaction,
            visualModifier = Modifier.graphicsLayer {
                scaleX = scale
                scaleY = scale
            },
        ) {
            MarqueeBorder(
                cornerRadius = 18.dp,
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = if (escalating) LucideIcons.OctagonX else LucideIcons.Square,
                    contentDescription = if (escalating) "强制停止" else "停止",
                    tint = if (isDark) Color.White else Color(0xFF0A0A1A),
                    modifier = Modifier.size(14.dp),
                )
            }
        }
    }
    SubmitButtonMode.RunningSend -> {
        // PC 独立第三态：Agent 正在运行但输入非空。保持 running-action
        // 深色/浅色表面和旋转边框，图标与点击语义切换为 Send/Next。
        val density = LocalDensity.current
        val guideThresholdPx = with(density) { 14.dp.toPx() }
        val guideTravelLimitPx = with(density) { 64.dp.toPx() }
        var guideVisible by remember { mutableStateOf(false) }
        var guideOffsetPx by remember { mutableFloatStateOf(0f) }
        var guideArmed by remember { mutableStateOf(false) }
        Box(Modifier.size(InputComposerEdgeControlSize), contentAlignment = Alignment.Center) {
            if (guideVisible) {
                GlassButtonCanvas(
                    visualSize = InputComposerEdgeControlSize,
                    shape = shape,
                    surfaceColor = if (isDark) PcColorsDark.accent else Color.White,
                    alpha = if (isDark) 0.9f else 0.78f,
                    onClick = {},
                    modifier = Modifier
                        .zIndex(3f)
                        .graphicsLayer {
                            translationY = guideOffsetPx
                            scaleX = if (guideArmed) 1.08f else 1f
                            scaleY = if (guideArmed) 1.08f else 1f
                        },
                ) {
                    Icon(
                        imageVector = Icons.Filled.KeyboardArrowUp,
                        contentDescription = "松开发送 Guide",
                        tint = if (isDark) Color.White else Color(0xFF0A0A1A),
                        modifier = Modifier.size(19.dp),
                    )
                }
            }
            GlassButtonCanvas(
                visualSize = InputComposerEdgeControlSize,
                shape = shape,
                surfaceColor = if (isDark) Color(0xFF0E1018) else Color.White,
                alpha = if (isDark) 0.88f else 0.72f,
                onClick = onClick,
                interactionSource = interaction,
                modifier = Modifier.liquidHoldDragGesture(
                    running,
                    hasText,
                    holdMillis = DirectGuideHoldMillis,
                    onTap = {},
                    onHoldStart = {
                        guideVisible = true
                        guideOffsetPx = 0f
                        guideArmed = false
                    },
                    onDrag = { _, delta ->
                        guideOffsetPx = (guideOffsetPx + delta.y).coerceIn(-guideTravelLimitPx, 0f)
                        guideArmed = directGuideDragArmed(guideOffsetPx, guideThresholdPx)
                    },
                    onHoldEnd = { _, _ ->
                        val submitGuide = guideArmed
                        guideVisible = false
                        guideOffsetPx = 0f
                        guideArmed = false
                        if (submitGuide) onGuide()
                    },
                    onCancel = {
                        guideVisible = false
                        guideOffsetPx = 0f
                        guideArmed = false
                    },
                ),
                visualModifier = Modifier.graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                },
            ) {
                MarqueeBorder(
                    cornerRadius = 18.dp,
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = LucideIcons.Send,
                        contentDescription = "发送下一条；长按上滑发送 Guide",
                        tint = if (isDark) Color.White else Color(0xFF0A0A1A),
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
    }
    SubmitButtonMode.IdleSend -> {
        // idle（对齐 PC #submit-btn）：暗色 = 135deg 渐变 #5b78ff→#7b93ff + 白图标；
        // 亮色 = PC [data-theme=light] 白色 0.72 底 + 深色图标
        val iconTint = if (isDark) Color.White else Color(0xFF0A0A1A)
        GlassButtonCanvas(
            visualSize = InputComposerEdgeControlSize,
            shape = shape,
            surfaceColor = if (isDark) PcColorsDark.accent else Color.White,
            alpha = if (isDark) 0.86f else 0.72f,
            onClick = onClick,
            interactionSource = interaction,
            visualModifier = Modifier
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                }
                .shadow(
                    elevation = if (isDark) 12.dp else 10.dp,
                    shape = shape,
                    spotColor = if (isDark) Color(0x4D5B78FF) else Color(0x1A263254),
                    ambientColor = if (isDark) Color(0x4D5B78FF) else Color(0x1A263254),
                ),
        ) {
            Icon(
                imageVector = LucideIcons.Send,
                contentDescription = "发送",
                tint = iconTint,
                modifier = Modifier.size(14.dp),
            )
        }
    }
    }
}
