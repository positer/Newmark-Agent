package com.newmark.mobile.vm

import android.app.Application
import android.os.SystemClock
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.newmark.mobile.data.DesktopState
import com.newmark.mobile.data.MobileApiClient
import com.newmark.mobile.data.MobileSessionGate
import com.newmark.mobile.data.PairInfo
import com.newmark.mobile.data.PairInvite
import com.newmark.mobile.data.PairStore
import com.newmark.mobile.data.ModelOption
import com.newmark.mobile.data.RemoteConversation
import com.newmark.mobile.data.RemoteBranchGroup
import com.newmark.mobile.data.RemoteMessage
import com.newmark.mobile.data.RemoteConversationPlan
import com.newmark.mobile.data.RemoteConversationUiState
import com.newmark.mobile.data.LocalQueuedMessage
import com.newmark.mobile.data.RemoteLinkedPlan
import com.newmark.mobile.data.RemotePlanItem
import com.newmark.mobile.data.RemoteSubagent
import com.newmark.mobile.data.RemoteWorkspaceFile
import com.newmark.mobile.data.RemoteWorkEvent
import com.newmark.mobile.data.RemotePayloadNormalizer
import com.newmark.mobile.data.RemoteWorkRun
import com.newmark.mobile.data.RemoteTrackingContract
import com.newmark.mobile.data.SendResponse
import com.newmark.mobile.data.WorkEvent
import com.newmark.mobile.data.WorkspaceInfo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.json.JSONArray
import kotlin.coroutines.coroutineContext

/** Accept both current `data: payload` and legacy `data:payload` SSE lines. */
internal fun sseDataPayload(line: String): String? =
    line.takeIf { it.startsWith("data:") }
        ?.removePrefix("data:")
        ?.trim()
        ?.takeIf(String::isNotBlank)

/** 连接状态：断开 / 连接中 / 已连接 / 重连中 */
enum class LinkStatus { Disconnected, Connecting, Connected, Reconnecting }

data class WorkspaceUploadProgress(
    val id: String,
    val workspaceId: String,
    val conversationId: String,
    val conversationTitle: String,
    val fileName: String,
    val targetPath: String,
    val uploadedBytes: Long,
    val totalBytes: Long,
    val status: String = "uploading",
    val error: String = "",
) {
    val fraction: Float
        get() = if (totalBytes <= 0L) 0f else (uploadedBytes.toDouble() / totalBytes).toFloat().coerceIn(0f, 1f)
}

/** 桌面端多设备配对 + 对话同步 + 发送 + 同内网端口可达自动重连 */
class DesktopLinkViewModel(app: Application) : AndroidViewModel(app) {

    private val pairStore = PairStore(app)
    private val api = MobileApiClient()
    private val gson = Gson()

    var pairedDevices by mutableStateOf<List<PairInfo>>(emptyList())
        private set
    var activeDevice by mutableStateOf<PairInfo?>(null)
        private set
    var linkStatus by mutableStateOf(LinkStatus.Disconnected)
        private set
    var isConnected by mutableStateOf(false)
        private set
    var pairing by mutableStateOf(false)
        private set
    var desktopState by mutableStateOf<DesktopState?>(null)
        private set
    /**
     * 最近一次桌面端模型回退的实际生效模型（deployment:provider:model 或纯模型名）。
     * 与 PC 端一致：回退不是隐藏的参数回退，输入框下方的模型选择区同步显示它；
     * 用户手动切换模型或切换对话后清除。
     */
    var fallbackModel by mutableStateOf("")
        private set
    var remoteConversations by mutableStateOf<List<RemoteConversation>>(emptyList())
        private set
    /** 二级边栏：当前打开工作区的从属对话（按 workspaceId 从 PC 拉取） */
    var workspaceConversations by mutableStateOf<List<RemoteConversation>>(emptyList())
        private set
    var openedWorkspaceId by mutableStateOf<String?>(null)
        private set
    var openedWorkspaceActiveConversationId by mutableStateOf("")
        private set
    private var workspaceArchivePendingKeys by mutableStateOf<Set<String>>(emptySet())
    var workspaceReorderPending by mutableStateOf(false)
        private set
    val workspaceArchivePendingIds: Set<String>
        get() {
            val workspaceId = openedWorkspaceId ?: return emptySet()
            val prefix = "$workspaceId::"
            return workspaceArchivePendingKeys
                .asSequence()
                .filter { it.startsWith(prefix) }
                .map { it.removePrefix(prefix) }
                .toSet()
        }
    /** 当前选中远程对话的标题（标题栏显示用） */
    var selectedConversationTitle by mutableStateOf<String?>(null)
        private set
    /** 当前选中远程对话 id（侧边栏选中态；与本地 currentId 并集互斥） */
    var selectedConversationId by mutableStateOf<String?>(null)
        private set
    /** 当前选中远程对话所属工作区；与仅用于浏览二级栏的 openedWorkspaceId 分离。 */
    var selectedConversationWorkspaceId by mutableStateOf<String?>(null)
        private set
    var remoteMessages by mutableStateOf<List<RemoteMessage>>(emptyList())
        private set
    var remoteWindowStart by mutableStateOf(0)
        private set
    var remoteBranchGroups by mutableStateOf<List<RemoteBranchGroup>>(emptyList())
        private set
    var remoteViewedBranchId by mutableStateOf("")
        private set
    var remoteRuntimeBranchId by mutableStateOf("")
        private set
    var remoteBranchGroupId by mutableStateOf("")
        private set
    var remoteViewedBranchNodePath by mutableStateOf<List<String>>(emptyList())
        private set
    var remoteRuntimeBranchNodePath by mutableStateOf<List<String>>(emptyList())
        private set
    /** 当前对话的历史 work runs（含 interrupted/force_interrupted 被中断的构建） */
    var remoteWorkRuns by mutableStateOf<List<RemoteWorkRun>>(emptyList())
        private set
    /** SSE 实时 build block（进行中的 run，事件流实时追加） */
    var liveRun by mutableStateOf<RemoteWorkRun?>(null)
        private set
    var conversationUiState by mutableStateOf(RemoteConversationUiState())
        private set
    val editableRemoteQueue: List<LocalQueuedMessage>
        get() = conversationUiState.queueItems.map { item ->
            LocalQueuedMessage(
                id = item.id,
                text = item.text,
                requestedMode = item.requestedMode,
                goalObjective = item.goalObjective,
            )
        }

    val remoteQueuePaused: Boolean
        get() = conversationUiState.queuePaused
    var lastTokens by mutableStateOf<List<WorkEvent>>(emptyList())
        private set
    var isSending by mutableStateOf(false)
        private set
    var lastError by mutableStateOf<String?>(null)
        private set
    var rightSidebarFiles by mutableStateOf<List<RemoteWorkspaceFile>>(emptyList())
        private set
    var rightSidebarPath by mutableStateOf("")
        private set
    var rightSidebarPlan by mutableStateOf(RemoteConversationPlan())
        private set
    var rightSidebarLinkedPlan by mutableStateOf(RemoteLinkedPlan())
        private set
    var rightSidebarSubagents by mutableStateOf<List<RemoteSubagent>>(emptyList())
        private set
    var rightSidebarEditorPath by mutableStateOf("")
        private set
    var rightSidebarEditorContent by mutableStateOf("")
        private set
    var rightSidebarLoading by mutableStateOf(false)
        private set
    var rightSidebarSaving by mutableStateOf(false)
        private set
    var rightSidebarError by mutableStateOf("")
        private set
    var workspaceUploadProgress by mutableStateOf<List<WorkspaceUploadProgress>>(emptyList())
        private set

    private fun updateWorkspaceUpload(task: WorkspaceUploadProgress) {
        Snapshot.withMutableSnapshot {
            workspaceUploadProgress = (workspaceUploadProgress.filterNot { it.id == task.id } + task)
                .sortedByDescending { it.id }
        }
    }
    fun bindSelectedWorkspaceUpload(): suspend (String, String, ByteArray) -> Result<String> {
        val pair = activeDevice ?: return { _, _, _ ->
            Result.failure(IllegalStateException("未连接远程设备"))
        }
        val workspaceId = selectedConversationWorkspaceId
            ?: return { _, _, _ -> Result.failure(IllegalStateException("当前远程对话没有对应工作区")) }
        val conversationId = selectedConversationId
            ?: return { _, _, _ -> Result.failure(IllegalStateException("尚未选择远程对话")) }
        val conversationTitle = selectedConversationTitle.orEmpty().ifBlank { conversationId }
        return upload@{ name, mimeType, bytes ->
            if (bytes.isEmpty()) return@upload Result.failure(IllegalArgumentException("文件为空"))
            if (bytes.size > 20 * 1024 * 1024) {
                return@upload Result.failure(IllegalArgumentException("文件超过 20 MiB"))
            }
            val targetPath = "Uploaded/$name"
            val taskId = "${System.currentTimeMillis()}:${java.util.UUID.randomUUID()}"
            var task = WorkspaceUploadProgress(
                id = taskId,
                workspaceId = workspaceId,
                conversationId = conversationId,
                conversationTitle = conversationTitle,
                fileName = name,
                targetPath = targetPath,
                uploadedBytes = 0L,
                totalBytes = bytes.size.toLong(),
            )
            updateWorkspaceUpload(task)
            api.uploadWorkspaceFile(
                pair = pair,
                workspaceId = workspaceId,
                directory = "Uploaded",
                fileName = name,
                mimeType = mimeType,
                contentLength = bytes.size.toLong(),
                openStream = { bytes.inputStream() },
                onProgress = { uploaded, total ->
                    task = task.copy(
                        uploadedBytes = uploaded,
                        totalBytes = total ?: bytes.size.toLong(),
                    )
                    updateWorkspaceUpload(task)
                },
            ).mapCatching { json ->
                val remotePath = json.optJSONObject("file")?.optString("path")?.takeIf(String::isNotBlank)
                    ?: error("远程未返回上传路径")
                api.send(
                    pair = pair,
                    message = "有文件已上传到 /${remotePath.trimStart('/')}",
                    conversationId = conversationId,
                    workspaceId = workspaceId,
                    requestedMode = "",
                    goalObjective = "",
                    inputMode = "guide",
                ).getOrThrow()
                if (isActivePair(pair) && isSelectedTarget(workspaceId, conversationId)) {
                    refreshConversationUiState()
                }
                task = task.copy(
                    targetPath = remotePath,
                    uploadedBytes = bytes.size.toLong(),
                    totalBytes = bytes.size.toLong(),
                    status = "completed",
                )
                updateWorkspaceUpload(task)
                remotePath
            }.onFailure { failure ->
                task = task.copy(status = "failed", error = failure.message.orEmpty())
                updateWorkspaceUpload(task)
            }
        }
    }

    /** 兼容旧引用：当前活跃设备 */
    val pairInfo: PairInfo? get() = activeDevice

    /** 旧设备/旧 token 的迟到 HTTP 或 SSE 回调不能写入当前 UI。 */
    private val sessionGate = MobileSessionGate()
    private var connectionJob: Job? = null
    private var reconnectJob: Job? = null
    private var conversationLoadGeneration = 0L
    /** Rejects an older overlapping Goal/Flow/runtime poll after a newer full resident snapshot committed. */
    private var conversationUiRefreshGeneration = 0L
    /** One target-scoped resident snapshot request at a time; slow networks must not starve commits. */
    private var conversationUiRefreshJob: Job? = null
    private var conversationUiRefreshTarget = ""
    private var initialized = false

    private data class TerminalRunSync(
        val runId: String,
        val conversationId: String?,
        val workspaceId: String?,
    )

    init {
        // Do not start network work from the ViewModel constructor.  A paired
        // device may point at a temporarily unreachable desktop (for example
        // after an emulator restart); starting the 5-10s hello timeout during
        // first composition causes a large burst of state changes and jank.
        // NewmarkApp calls initialize() after the first frame instead.
    }

    /** Hydrate the saved device and begin remote work after the first frame. */
    fun initialize() {
        if (initialized) return
        initialized = true
        viewModelScope.launch(Dispatchers.IO) {
            val saved = pairStore.loadAll()
            withContext(Dispatchers.Main) {
                // A pairing deep link may arrive with the first composition.
                // Never let the delayed disk hydration overwrite the device
                // selected by that in-flight pairing operation.
                if (pairing || activeDevice != null) return@withContext
                pairedDevices = saved
                activeDevice = saved.firstOrNull()
                if (activeDevice != null) refresh()
            }
        }
    }

    /** 扫码/粘贴配对：新增设备（名称+IP 去重整合），成功后设为活跃并连接 */
    fun pairFromUrl(url: String) {
        val invite = PairInvite.fromUrl(url)
        if (invite == null) {
            lastError = "无法解析二维码/URL"
            return
        }
        // Set this before launching so asynchronous saved-device hydration
        // cannot race a cold-start deep link and clear the pairing target.
        pairing = true
        lastError = null
        viewModelScope.launch {
            api.confirm(invite)
                .onSuccess {
                    val base = PairInfo(host = invite.host, port = invite.port, token = invite.token)
                    val name = api.hello(base).getOrNull()?.optString("hostname", "") ?: ""
                    val pair = base.copy(name = name)
                    pairedDevices = pairStore.add(pair)
                    activeDevice = pair
                    refresh()
                }
                .onFailure { e ->
                    lastError = "配对失败：${e.message}"
                    pairing = false
                }
        }
    }

    /** 图片扫码失败等 UI 层可报告的配对错误。 */
    fun reportPairingError(message: String) {
        lastError = message
    }

    fun pairDirect(host: String, port: Int, token: String) {
        val pair = PairInfo(host = host.trim(), port = port, token = token.trim())
        if (!pair.isValid()) {
            lastError = "地址或 token 为空"
            return
        }
        pairedDevices = pairStore.add(pair)
        activeDevice = pair
        refresh()
    }

    /** 删除绑定设备（名称+IP 去重后按 host 删除）；删活跃设备则切到下一台 */
    fun removeDevice(host: String) {
        pairedDevices = pairStore.remove(host)
        if (activeDevice?.host == host) {
            activeDevice = pairedDevices.firstOrNull()
            if (activeDevice == null) {
                clearSession()
            } else {
                refresh()
            }
        }
    }

    /** 切换活跃设备并重连 */
    fun selectDevice(host: String) {
        val target = pairedDevices.firstOrNull { it.host == host } ?: return
        if (activeDevice?.host == host) return
        activeDevice = target
        refresh()
    }

    fun unpair() {
        val host = activeDevice?.host ?: return
        removeDevice(host)
    }

    private fun clearSession() {
        cancelConnectionWork(clearGate = true)
        linkStatus = LinkStatus.Disconnected
        isConnected = false
        desktopState = null
        remoteConversations = emptyList()
        workspaceConversations = emptyList()
        openedWorkspaceId = null
        openedWorkspaceActiveConversationId = ""
        workspaceArchivePendingKeys = emptySet()
        selectedConversationWorkspaceId = null
        remoteMessages = emptyList()
        remoteWindowStart = 0
        clearRemoteBranchState()
        lastTokens = emptyList()
        lastError = null
        pairing = false
    }

    fun refresh() {
        val pair = activeDevice ?: return
        val session = beginConnectionSession(pair)
        connectionJob = viewModelScope.launch {
            if (!isCurrent(session, pair)) return@launch
            linkStatus = LinkStatus.Connecting
            pairing = true
            lastError = null
            val ok = connect(pair, session)
            if (!isCurrent(session, pair)) return@launch
            pairing = false
            if (ok) {
                linkStatus = LinkStatus.Connected
            } else {
                startReconnect(pair, session)
            }
        }
    }

    /** 尝试连接（hello + state），成功返回 true。不强制 Tailscale，同内网端口可达即可。 */
    private suspend fun connect(pair: PairInfo, session: MobileSessionGate.Session): Boolean {
        val hello = api.hello(pair).getOrElse { error ->
            if (!isCurrent(session, pair)) return false
            isConnected = false
            lastError = "连接失败：${error.message}"
            return false
        }
        if (!isCurrent(session, pair)) return false
        isConnected = true
        // 设备名正确性：连接成功后用桌面端 hostname 回填/修正显示名
        val hostname = hello.optString("hostname", "")
        if (hostname.isNotBlank() && pair.name != hostname) {
            val updated = pair.copy(name = hostname)
            if (!isCurrent(session, pair)) return false
            activeDevice = updated
            pairedDevices = pairStore.add(updated)
        }
        api.state(pair)
            .getOrNull()
            ?.let { state ->
                val hydratedState = hydrateLegacyProviderCatalog(pair, state)
                // Gson/JSON work is deliberately kept off the main thread;
                // the result is only committed to Compose state on Main.
                val parsed = withContext(Dispatchers.Default) { parseState(hydratedState) }
                if (!isCurrent(session, pair)) return false
                desktopState = parsed
                remoteConversations = parsed?.conversations ?: emptyList()
                if (remoteMessages.isEmpty()) {
                    remoteMessages = parsed?.chatMessages ?: emptyList()
                }
                remoteWorkRuns = parsed?.workRuns ?: emptyList()
            }
            ?: run { if (isCurrent(session, pair)) lastError = "桌面状态同步失败" }
            // state 端点的 workRuns 依赖 server agent 内存（run 结束后为空，被中断的构建会丢失）；
            // 用 conversation 端点补拉持久化 workRuns（含 interrupted/force_interrupted）
        val hydrationWorkspaceId = selectedConversationWorkspaceId
            ?.takeIf(String::isNotBlank)
            ?: desktopState?.currentWorkspaceId?.takeIf(String::isNotBlank)
        val hydrationConversationId = selectedConversationId
            ?.takeIf(String::isNotBlank)
            ?: desktopState?.activeConversationId?.takeIf(String::isNotBlank)
        if (selectedConversationWorkspaceId.isNullOrBlank() && !hydrationWorkspaceId.isNullOrBlank()) {
            selectedConversationWorkspaceId = hydrationWorkspaceId
        }
        if (selectedConversationId.isNullOrBlank() && !hydrationConversationId.isNullOrBlank()) {
            selectedConversationId = hydrationConversationId
        }
        api.conversation(pair, hydrationConversationId, hydrationWorkspaceId)
            .getOrNull()
            ?.let { snap ->
                if (!isCurrent(session, pair)) return false
                val snapshot = withContext(Dispatchers.Default) { parseConversationSnapshot(snap) }
                if (isSelectedTarget(hydrationWorkspaceId, hydrationConversationId)) {
                    applyConversationSnapshot(snapshot)
                }
            }
        if (!isCurrent(session, pair)) return false
        // 连接成功即挂 SSE：实时追踪进行中的 build block
        startSse(pair, session)
        return true
    }

    /** 端口不可达：与 SSE 同步每 3s 主动重连，5min 后判定连接已断开 */
    private fun startReconnect(pair: PairInfo, session: MobileSessionGate.Session) {
        if (!isCurrent(session, pair)) return
        linkStatus = LinkStatus.Reconnecting
        reconnectJob?.cancel()
        reconnectJob = viewModelScope.launch {
            val deadline = System.currentTimeMillis() + RECONNECT_TIMEOUT_MS
            while (isCurrent(session, pair) && System.currentTimeMillis() < deadline) {
                delay(RECONNECT_INTERVAL_MS)
                if (!isCurrent(session, pair)) return@launch
                if (connect(pair, session)) {
                    if (!isCurrent(session, pair)) return@launch
                    linkStatus = LinkStatus.Connected
                    return@launch
                }
            }
            if (!isCurrent(session, pair)) return@launch
            linkStatus = LinkStatus.Disconnected
            isConnected = false
            lastError = "连接已断开"
        }
    }

    fun retryConnect() {
        if (activeDevice != null) refresh()
    }

    /** Pull a paired device's provider catalog for explicit local migration. */
    suspend fun providerCatalog(pair: PairInfo): Result<List<com.newmark.mobile.data.ProviderConfig>> {
        val response = api.exportProviderCatalog(pair).getOrElse { return Result.failure(it) }
        val providers = withContext(Dispatchers.Default) {
            runCatching {
                val type = object : TypeToken<List<com.newmark.mobile.data.ProviderConfig>>() {}.type
                val array = response.optJSONArray("providers")
                    ?: throw IllegalStateException("设备未返回供应商目录")
                gson.fromJson<List<com.newmark.mobile.data.ProviderConfig>>(array.toString(), type)
                    ?.filter { it.id.isNotBlank() && it.name.isNotBlank() }
                    ?: emptyList()
            }
        }.getOrElse { return Result.failure(it) }
        return Result.success(providers)
    }

    fun remoteModelOptions(): List<ModelOption> = desktopState?.providers.orEmpty()
        .asSequence()
        .filter { it.enabled }
        .flatMap { provider ->
            provider.models.asSequence()
                .filter { it.enabled }
                .map { model ->
                    ModelOption(
                        providerId = provider.id,
                        modelName = "deployment:${java.net.URLEncoder.encode(provider.id, Charsets.UTF_8.name())}:${java.net.URLEncoder.encode(model.name, Charsets.UTF_8.name())}",
                        label = model.label,
                        providerLabel = provider.label,
                        displayName = model.label,
                    )
                }
        }
        .toList()

    fun selectRemoteModel(option: ModelOption) {
        val pair = activeDevice ?: return
        val model = option.modelName.ifBlank { return }
        fallbackModel = ""
        viewModelScope.launch {
            api.selectModel(pair, model)
                .onSuccess { refreshStateSnapshot(pair) }
                .onFailure { lastError = "切换远程模型失败：${it.message}" }
        }
    }

    fun selectRemoteIntelligence(tier: String) {
        if (tier !in com.newmark.mobile.data.INTELLIGENCE_TIERS) return
        val pair = activeDevice ?: return
        viewModelScope.launch {
            api.selectIntelligence(pair, tier)
                .onSuccess { refreshStateSnapshot(pair) }
                .onFailure { lastError = "切换远程智能档位失败：${it.message}" }
        }
    }

    private suspend fun refreshStateSnapshot(pair: PairInfo) {
        val session = sessionGate.current(pair) ?: return
        if (!isCurrent(session, pair)) return
        val response = api.state(pair).getOrNull() ?: return
        val hydrated = hydrateLegacyProviderCatalog(pair, response)
        val parsed = withContext(Dispatchers.Default) { parseState(hydrated) }
        if (isCurrent(session, pair)) desktopState = parsed
    }

    /** New desktop uses authenticated mobile state; installed legacy desktop falls back to its redacted state catalog. */
    private suspend fun hydrateLegacyProviderCatalog(pair: PairInfo, mobileState: JSONObject): JSONObject {
        if (mobileState.optJSONArray("providers")?.length()?.let { it > 0 } == true) return mobileState
        val legacy = api.legacyProviderState(pair).getOrNull() ?: return mobileState
        legacy.optJSONArray("providers")?.takeIf { it.length() > 0 }?.let { mobileState.put("providers", it) }
        if (!mobileState.has("intelligence") && legacy.has("intelligence")) {
            mobileState.put("intelligence", legacy.optString("intelligence", "medium"))
        }
        return mobileState
    }

    /** Cancel every old remote owner before a new device generation begins. */
    private fun beginConnectionSession(pair: PairInfo): MobileSessionGate.Session {
        cancelConnectionWork(clearGate = false)
        return sessionGate.begin(pair)
    }

    private fun cancelConnectionWork(clearGate: Boolean) {
        connectionJob?.cancel()
        connectionJob = null
        reconnectJob?.cancel()
        reconnectJob = null
        sseJob?.cancel()
        sseJob = null
        conversationUiRefreshJob?.cancel()
        conversationUiRefreshJob = null
        conversationUiRefreshTarget = ""
        conversationLoadGeneration += 1
        if (clearGate) sessionGate.clear()
    }

    private fun isCurrent(session: MobileSessionGate.Session, pair: PairInfo): Boolean =
        sessionGate.isCurrent(session, activeDevice)

    private fun isActivePair(pair: PairInfo): Boolean = activeDevice?.let { current ->
        current.host == pair.host && current.port == pair.port && current.token == pair.token
    } == true

    private fun isSelectedTarget(workspaceId: String?, conversationId: String?): Boolean =
        RemoteTrackingContract.matchesTarget(
            workspaceId,
            conversationId,
            selectedConversationWorkspaceId,
            selectedConversationId,
        )

    fun selectConversation(id: String, workspaceId: String? = openedWorkspaceId) {
        if (id.isBlank()) return
        val pair = activeDevice ?: return
        selectedConversationId = id
        selectedConversationWorkspaceId = workspaceId
        fallbackModel = ""
        val loadGeneration = ++conversationLoadGeneration
        conversationUiRefreshGeneration += 1L
        conversationUiRefreshJob?.cancel()
        conversationUiRefreshJob = null
        conversationUiRefreshTarget = ""
        selectedConversationTitle = (remoteConversations + workspaceConversations)
            .firstOrNull { it.id == id }?.title
        if (workspaceConversations.any { it.id == id }) {
            openedWorkspaceActiveConversationId = id
            workspaceConversations = workspaceConversations.map { conversation ->
                conversation.copy(active = conversation.id == id)
            }
        }
        viewModelScope.launch {
            val snapshotResult = api.conversation(pair, id, workspaceId)
            val uiResult = workspaceId?.takeIf { it.isNotBlank() }
                ?.let { api.conversationUiState(pair, it, id) }
            snapshotResult.onSuccess { snap ->
                    if (loadGeneration != conversationLoadGeneration || !isActivePair(pair) ||
                        selectedConversationId != id || selectedConversationWorkspaceId != workspaceId
                    ) return@onSuccess
                    applyConversationSnapshot(snap)
                    liveRun = null
                }
                .onFailure { e ->
                    if (loadGeneration == conversationLoadGeneration && isActivePair(pair)) lastError = e.message
                }
            uiResult?.onSuccess { json ->
                if (loadGeneration == conversationLoadGeneration && isActivePair(pair) &&
                    selectedConversationId == id && selectedConversationWorkspaceId == workspaceId
                ) applyResidentConversationUiState(parseConversationUiState(json))
            }
        }
    }

    fun refreshConversationUiState() {
        val pair = activeDevice ?: return
        val workspaceId = selectedConversationWorkspaceId ?: return
        val conversationId = selectedConversationId ?: return
        val targetKey = "$workspaceId::$conversationId"
        if (conversationUiRefreshJob?.isActive == true && conversationUiRefreshTarget == targetKey) return
        val refreshGeneration = ++conversationUiRefreshGeneration
        conversationUiRefreshTarget = targetKey
        conversationUiRefreshJob = viewModelScope.launch {
            try {
                api.conversationUiState(pair, workspaceId, conversationId)
                    .onSuccess { response ->
                        val parsed = withContext(Dispatchers.Default) { parseConversationUiState(response) }
                        if (refreshGeneration == conversationUiRefreshGeneration && isActivePair(pair) &&
                            isSelectedTarget(workspaceId, conversationId)
                        ) {
                            Snapshot.withMutableSnapshot { applyResidentConversationUiState(parsed) }
                            drainRemoteNextIfReady()
                        }
                    }
                    .onFailure {
                        if (refreshGeneration == conversationUiRefreshGeneration && isActivePair(pair) &&
                            isSelectedTarget(workspaceId, conversationId)
                        ) lastError = "对话控制状态同步失败：${it.message}"
                    }
            } finally {
                if (conversationUiRefreshGeneration == refreshGeneration) {
                    conversationUiRefreshJob = null
                    conversationUiRefreshTarget = ""
                }
            }
        }
    }

    /**
     * One GUI-hosted response is one PC runtime snapshot. Goal, Flow, queue,
     * runtime, messages and WorkRuns must become visible in the same Compose
     * commit; splitting them recreates impossible UI combinations.
     */
    private fun applyResidentConversationUiState(state: RemoteConversationUiState) {
        conversationUiState = state
        state.chatMessages?.let { remoteMessages = it }
        state.workRuns?.let { residentRuns ->
            remoteWorkRuns = residentRuns
            val runningRunId = state.runtime?.takeIf { it.running }?.runId.orEmpty()
            if (runningRunId.isNotBlank()) {
                val resident = residentRuns.firstOrNull { RemoteTrackingContract.sameRun(it.runId, runningRunId) }
                liveRun = when {
                    liveRun?.runId == runningRunId -> liveRun
                    resident != null -> resident.copy(status = "running", endedAt = "")
                    else -> RemoteWorkRun(runId = runningRunId, status = "running")
                }
            } else if (state.runtime?.running == false) {
                liveRun = null
            }
        }
    }

    private fun runConversationUiAction(action: String, value: String = "") {
        val pair = activeDevice ?: return
        val workspaceId = selectedConversationWorkspaceId ?: return
        val conversationId = selectedConversationId ?: return
        viewModelScope.launch {
            api.conversationUiAction(pair, workspaceId, conversationId, action, value)
                .onSuccess {
                    if (!isActivePair(pair) || !isSelectedTarget(workspaceId, conversationId)) return@onSuccess
                    refreshConversationUiState()
                    api.conversation(pair, conversationId, workspaceId).onSuccess { snapshot ->
                        if (isActivePair(pair) && isSelectedTarget(workspaceId, conversationId)) {
                            applyConversationSnapshot(snapshot)
                        }
                    }
                }
                .onFailure {
                    if (isActivePair(pair) && isSelectedTarget(workspaceId, conversationId)) {
                        lastError = "对话操作失败：${it.message}"
                    }
                }
        }
    }

    fun submitRemoteGoalEdit(value: String) {
        val objective = value.trim()
        if (objective.isBlank()) return
        enqueueRemoteNext(objective, requestedMode = "goal", goalObjective = objective)
        drainRemoteNextIfReady()
    }
    fun toggleRemoteGoalPause() = runConversationUiAction("goal_toggle_pause")
    fun clearRemoteGoal() = runConversationUiAction("goal_clear")
    fun pauseRemoteFlow() = runConversationUiAction("flow_pause")
    fun resumeRemoteFlow() = runConversationUiAction("flow_resume")
    fun guideRemoteFlow(value: String) = runConversationUiAction("flow_guide", value)
    fun guideRemoteConversation(value: String) = runConversationUiAction("conversation_guide", value)
    fun stopRemoteConversation() = runConversationUiAction("conversation_stop")

    fun enqueueRemoteNext(text: String, requestedMode: String = "build", goalObjective: String = "") {
        val content = text.trim()
        if (content.isBlank()) return
        runRemoteQueueAction(
            action = "queue_enqueue",
            id = java.util.UUID.randomUUID().toString(),
            text = content,
            requestedMode = requestedMode,
            goalObjective = goalObjective,
        )
    }

    fun toggleRemoteQueuePause() {
        runRemoteQueueAction("queue_toggle_pause")
    }

    fun updateRemoteQueueMessage(id: String, text: String) {
        val content = text.trim()
        if (content.isBlank()) deleteRemoteQueueMessage(id)
        else runRemoteQueueAction("queue_update", id = id, text = content)
    }

    fun deleteRemoteQueueMessage(id: String) {
        runRemoteQueueAction("queue_delete", id = id)
    }

    fun reorderRemoteQueueMessages(orderedIds: List<String>) {
        runRemoteQueueAction("queue_reorder", orderedIds = orderedIds)
    }

    fun guideRemoteQueueMessage(id: String) {
        runRemoteQueueAction("queue_guide", id = id)
    }

    private fun runRemoteQueueAction(
        action: String,
        id: String = "",
        text: String = "",
        requestedMode: String = "build",
        goalObjective: String = "",
        orderedIds: List<String> = emptyList(),
    ) {
        val pair = activeDevice ?: return
        val workspaceId = selectedConversationWorkspaceId ?: return
        val conversationId = selectedConversationId ?: return
        viewModelScope.launch {
            api.conversationQueueAction(
                pair, workspaceId, conversationId, action, id, text,
                requestedMode, goalObjective, orderedIds,
            )
                .onSuccess { response ->
                    if (!isActivePair(pair) || !isSelectedTarget(workspaceId, conversationId)) return@onSuccess
                    val currentJson = JSONObject(gson.toJson(conversationUiState))
                    if (response.has("queueItems")) currentJson.put("queueItems", response.getJSONArray("queueItems"))
                    if (response.has("queuePaused")) currentJson.put("queuePaused", response.getBoolean("queuePaused"))
                    if (response.has("queued")) currentJson.put("queued", response.getJSONObject("queued"))
                    conversationUiState = parseConversationUiState(currentJson)
                    if (!response.optBoolean("ok", true)) {
                        lastError = response.optJSONObject("receipt")?.optString("reason", "Guide 未被远程运行接收")
                            ?: "远程队列操作失败"
                    }
                }
                .onFailure {
                    if (isActivePair(pair) && isSelectedTarget(workspaceId, conversationId)) {
                        lastError = "远程队列操作失败：${it.message}"
                    }
                }
        }
    }

    private fun drainRemoteNextIfReady() {
        // The PC runtime owns and drains the remote continuation queue.
    }

    /** 打开工作区二级边栏：按 workspaceId 拉取该工作区的从属对话（含 running） */
    fun openWorkspace(workspace: WorkspaceInfo) {
        val pair = activeDevice ?: run {
            lastError = "尚未配对桌面端"
            return
        }
        if (openedWorkspaceId == workspace.id && workspaceConversations.isNotEmpty()) return
        openedWorkspaceId = workspace.id
        openedWorkspaceActiveConversationId = ""
        workspaceConversations = emptyList()
        viewModelScope.launch {
            api.workspaceConversations(pair, workspace.id)
                .onSuccess { json ->
                    if (openedWorkspaceId != workspace.id) return@onSuccess
                    val list = parseWorkspaceConversationRows(json)
                    workspaceConversations = list
                    openedWorkspaceActiveConversationId = list.firstOrNull { it.active }?.id.orEmpty()
                }
                .onFailure { e ->
                    if (openedWorkspaceId == workspace.id) lastError = "工作区对话加载失败：${e.message}"
                }
        }
    }

    fun refreshRightSidebar() {
        val pair = activeDevice ?: return
        val workspaceId = selectedConversationWorkspaceId ?: openedWorkspaceId ?: return
        val conversationId = selectedConversationId ?: return
        viewModelScope.launch {
            rightSidebarLoading = true
            rightSidebarError = ""
            api.rightSidebarState(pair, workspaceId, conversationId)
                .onSuccess { json ->
                    rightSidebarPlan = runCatching {
                        gson.fromJson(json.optJSONObject("conversationPlan")?.toString(), RemoteConversationPlan::class.java)
                    }.getOrNull() ?: RemoteConversationPlan()
                    rightSidebarLinkedPlan = runCatching {
                        gson.fromJson(json.optJSONObject("linkedPlan")?.toString(), RemoteLinkedPlan::class.java)
                    }.getOrNull() ?: RemoteLinkedPlan()
                    rightSidebarSubagents = runCatching {
                        val type = object : TypeToken<List<RemoteSubagent>>() {}.type
                        gson.fromJson<List<RemoteSubagent>>(json.optJSONArray("subagents")?.toString() ?: "[]", type)
                    }.getOrNull() ?: emptyList()
                }
                .onFailure {
                    rightSidebarError = "右侧栏状态加载失败：${it.message}"
                    lastError = rightSidebarError
                }
            api.workspaceFiles(pair, workspaceId, rightSidebarPath)
                .onSuccess { json ->
                    rightSidebarPath = json.optString("path", "")
                    val type = object : TypeToken<List<RemoteWorkspaceFile>>() {}.type
                    rightSidebarFiles = gson.fromJson<List<RemoteWorkspaceFile>>(
                        json.optJSONArray("entries")?.toString() ?: "[]",
                        type,
                    ) ?: emptyList()
                }
                .onFailure {
                    rightSidebarError = "文件树加载失败：${it.message}"
                    lastError = rightSidebarError
                }
            rightSidebarLoading = false
        }
    }

    fun loadRightSidebarDirectory(path: String) {
        val pair = activeDevice ?: return
        val workspaceId = selectedConversationWorkspaceId ?: openedWorkspaceId ?: return
        viewModelScope.launch {
            rightSidebarLoading = true
            rightSidebarError = ""
            api.workspaceFiles(pair, workspaceId, path)
                .onSuccess { json ->
                    rightSidebarPath = json.optString("path", "")
                    val type = object : TypeToken<List<RemoteWorkspaceFile>>() {}.type
                    rightSidebarFiles = gson.fromJson<List<RemoteWorkspaceFile>>(
                        json.optJSONArray("entries")?.toString() ?: "[]",
                        type,
                    ) ?: emptyList()
                }
                .onFailure {
                    rightSidebarError = "文件树加载失败：${it.message}"
                    lastError = rightSidebarError
                }
            rightSidebarLoading = false
        }
    }

    fun openRightSidebarFile(path: String) {
        val pair = activeDevice ?: return
        val workspaceId = selectedConversationWorkspaceId ?: openedWorkspaceId ?: return
        viewModelScope.launch {
            rightSidebarLoading = true
            api.workspaceFile(pair, workspaceId, path)
                .onSuccess { json ->
                    rightSidebarEditorPath = json.optString("path", path)
                    rightSidebarEditorContent = json.optString("content", "")
                }
                .onFailure { lastError = "文件打开失败：${it.message}" }
            rightSidebarLoading = false
        }
    }

    fun updateRightSidebarEditor(content: String) {
        rightSidebarEditorContent = content
    }

    fun closeRightSidebarFile() {
        rightSidebarEditorPath = ""
        rightSidebarEditorContent = ""
    }

    fun saveRightSidebarFile() {
        val pair = activeDevice ?: return
        val workspaceId = selectedConversationWorkspaceId ?: openedWorkspaceId ?: return
        val path = rightSidebarEditorPath.takeIf(String::isNotBlank) ?: return
        viewModelScope.launch {
            rightSidebarSaving = true
            api.saveWorkspaceFile(pair, workspaceId, path, rightSidebarEditorContent)
                .onFailure { lastError = "文件保存失败：${it.message}" }
            rightSidebarSaving = false
        }
    }

    fun cycleRightSidebarPlanItem(itemId: String) {
        val updated = rightSidebarPlan.items.map { item ->
            if (item.id != itemId) item else item.copy(status = when (item.status) {
                "pending" -> "in_progress"
                "in_progress" -> "done"
                else -> "pending"
            })
        }
        persistRightSidebarPlan(updated)
    }

    fun addRightSidebarPlanItem(text: String) {
        val clean = text.trim().take(240)
        if (clean.isBlank()) return
        persistRightSidebarPlan(
            rightSidebarPlan.items + RemotePlanItem(
                id = "mobile-${java.util.UUID.randomUUID()}",
                text = clean,
                status = "pending",
            ),
        )
    }

    fun updateRightSidebarPlanItem(itemId: String, text: String) {
        val clean = text.trim().take(240)
        if (clean.isBlank()) return
        persistRightSidebarPlan(
            rightSidebarPlan.items.map { item -> if (item.id == itemId) item.copy(text = clean) else item },
        )
    }

    fun removeRightSidebarPlanItem(itemId: String) {
        persistRightSidebarPlan(rightSidebarPlan.items.filterNot { it.id == itemId })
    }

    /** 所有远程 task 的增删改查最终走 PC 的单一 conversation-plan 更新契约。 */
    private fun persistRightSidebarPlan(updated: List<RemotePlanItem>) {
        val pair = activeDevice ?: return
        val workspaceId = selectedConversationWorkspaceId ?: openedWorkspaceId ?: return
        val conversationId = selectedConversationId ?: return
        rightSidebarPlan = RemoteConversationPlan(updated)
        viewModelScope.launch {
            rightSidebarSaving = true
            val array = JSONArray().apply {
                updated.forEach { item ->
                    put(JSONObject().apply {
                        put("id", item.id)
                        put("text", item.text)
                        put("status", item.status)
                    })
                }
            }
            api.updateConversationPlan(pair, workspaceId, conversationId, array)
                .onSuccess { json ->
                    rightSidebarPlan = runCatching {
                        gson.fromJson(json.optJSONObject("conversationPlan")?.toString(), RemoteConversationPlan::class.java)
                    }.getOrNull() ?: rightSidebarPlan
                }
                .onFailure {
                    lastError = "任务状态更新失败：${it.message}"
                    refreshRightSidebar()
                }
            rightSidebarSaving = false
        }
    }

    fun sendToDesktop(text: String, forceGuide: Boolean = false, queuedItem: LocalQueuedMessage? = null) {
        val content = text.trim()
        if (content.isEmpty()) return
        val flow = conversationUiState.flow
        if (!forceGuide && (isSending || conversationUiState.runtime?.running == true || flow?.running == true)) {
            enqueueRemoteNext(content)
            return
        }
        if (isSending) return
        val pair = activeDevice ?: run {
            lastError = "尚未配对桌面端"
            return
        }
        val targetConversationId = selectedConversationId
        val targetWorkspaceId = selectedConversationWorkspaceId
        if (targetConversationId.isNullOrBlank() || targetWorkspaceId.isNullOrBlank()) {
            lastError = "尚未选择远程对话"
            return
        }
        isSending = true
        lastError = null
        viewModelScope.launch {
            if (!activateViewedBranchForSend(pair, targetWorkspaceId, targetConversationId)) {
                if (isSelectedTarget(targetWorkspaceId, targetConversationId)) isSending = false
                return@launch
            }
            sendRemoteContent(pair, content, targetConversationId, targetWorkspaceId, queuedItem)
            if (isActivePair(pair) && isSelectedTarget(targetWorkspaceId, targetConversationId)) {
                isSending = false
                refreshConversationUiState()
                drainRemoteNextIfReady()
            }
        }
    }

    /** 左右箭头只切换阅读快照，不改变桌面运行分支。 */
    fun inspectRemoteBranch(groupId: String, offset: Int) {
        if (isSending || offset == 0) return
        val pair = activeDevice ?: return
        val workspaceId = selectedConversationWorkspaceId ?: return
        val conversationId = selectedConversationId ?: return
        val group = remoteBranchGroups.firstOrNull { it.id == groupId } ?: return
        val current = group.branches.indexOfFirst { it.id == group.activeBranchId }
        val next = ((if (current < 0) group.branches.lastIndex else current) + offset)
            .coerceIn(0, group.branches.lastIndex)
        if (next == current || next !in group.branches.indices) return
        viewModelScope.launch {
            api.inspectConversationBranch(pair, workspaceId, conversationId, group.branches[next].id, group.id)
                .onSuccess { snapshot ->
                    if (isActivePair(pair) && isSelectedTarget(workspaceId, conversationId)) {
                        applyConversationSnapshot(snapshot)
                    }
                }
                .onFailure { error ->
                    if (isActivePair(pair) && isSelectedTarget(workspaceId, conversationId)) {
                        lastError = "分支切换失败：${error.message ?: "未知错误"}"
                    }
                }
        }
    }

    /** 编辑历史用户消息：让 PC 创建规范化分支，再在新运行分支上发送编辑内容。 */
    fun branchRemoteMessage(messageIndex: Int, editedText: String) {
        val content = editedText.trim()
        if (content.isBlank() || isSending) return
        val pair = activeDevice ?: return
        val workspaceId = selectedConversationWorkspaceId ?: return
        val conversationId = selectedConversationId ?: return
        val message = remoteMessages.getOrNull(messageIndex)?.takeIf { it.role == "user" } ?: return
        isSending = true
        lastError = null
        viewModelScope.launch {
            api.createConversationBranch(
                pair, workspaceId, conversationId, messageIndex, content, message, remoteViewedBranchNodePath,
            ).onSuccess { snapshot ->
                if (!isActivePair(pair) || !isSelectedTarget(workspaceId, conversationId)) return@onSuccess
                applyConversationSnapshot(snapshot)
                sendRemoteContent(pair, content, conversationId, workspaceId)
            }.onFailure { error ->
                if (!isActivePair(pair) || !isSelectedTarget(workspaceId, conversationId)) return@onFailure
                val detail = error.message ?: "未知错误"
                lastError = if (detail.contains("423")) "对话正在运行，无法编辑历史消息" else "创建分支失败：$detail"
            }
            if (isActivePair(pair) && isSelectedTarget(workspaceId, conversationId)) isSending = false
        }
    }

    private suspend fun activateViewedBranchForSend(
        pair: PairInfo,
        workspaceId: String?,
        conversationId: String?,
    ): Boolean {
        if (remoteViewedBranchId.isBlank() || remoteRuntimeBranchId.isBlank() || remoteViewedBranchId == remoteRuntimeBranchId) {
            return true
        }
        if (workspaceId.isNullOrBlank() || conversationId.isNullOrBlank()) return true
        return api.activateConversationBranch(
            pair, workspaceId, conversationId, remoteViewedBranchId, remoteBranchGroupId,
        ).fold(
            onSuccess = { snapshot ->
                if (!isActivePair(pair) || !isSelectedTarget(workspaceId, conversationId)) false
                else {
                    applyConversationSnapshot(snapshot)
                    true
                }
            },
            onFailure = { error ->
                if (isActivePair(pair) && isSelectedTarget(workspaceId, conversationId)) {
                    val detail = error.message ?: "未知错误"
                    lastError = if (detail.contains("423")) "对话正在运行，无法激活所阅分支" else "分支激活失败：$detail"
                }
                false
            },
        )
    }

    private suspend fun sendRemoteContent(
        pair: PairInfo,
        content: String,
        conversationId: String?,
        workspaceId: String?,
        queuedItem: LocalQueuedMessage? = null,
    ) {
        api.send(
            pair = pair,
            message = content,
            conversationId = conversationId,
            workspaceId = workspaceId,
            requestedMode = queuedItem?.requestedMode.orEmpty(),
            goalObjective = queuedItem?.goalObjective.orEmpty(),
            inputMode = "next",
        )
            .onSuccess { resp ->
                if (!isActivePair(pair) || !isSelectedTarget(workspaceId, conversationId)) return@onSuccess
                val sendResp = parseSend(resp)
                if (sendResp.chatMessages.isNotEmpty()) remoteMessages = sendResp.chatMessages
                lastTokens = sendResp.tokens
                if (!conversationId.isNullOrBlank()) {
                    api.conversation(pair, conversationId, workspaceId).onSuccess { snapshot ->
                        if (isActivePair(pair) && isSelectedTarget(workspaceId, conversationId)) {
                            applyConversationSnapshot(snapshot)
                        }
                    }
                }
            }
            .onFailure { error ->
                if (isActivePair(pair) && isSelectedTarget(workspaceId, conversationId)) {
                    lastError = "发送失败：${error.message}"
                }
            }
    }

    fun createWorkspaceConversation(onDone: (Boolean, String) -> Unit) {
        val pair = activeDevice ?: run {
            onDone(false, "尚未配对桌面端")
            return
        }
        val workspaceId = openedWorkspaceId ?: run {
            onDone(false, "尚未选择工作区")
            return
        }
        val title = "新对话 ${workspaceConversations.size + 1}"
        viewModelScope.launch {
            api.createConversation(pair, workspaceId, title)
                .onSuccess { response ->
                    applyWorkspaceConversationRows(workspaceId, response)
                    val conversationId = response.optJSONObject("conversation")?.optString("id", "")
                        .orEmpty()
                    if (conversationId.isNotBlank() && openedWorkspaceId == workspaceId) {
                        openedWorkspaceActiveConversationId = conversationId
                        selectConversation(conversationId, workspaceId)
                    }
                    onDone(true, title)
                }
                .onFailure { error ->
                    val message = "新建对话失败：${error.message ?: "未知错误"}"
                    lastError = message
                    onDone(false, message)
                }
        }
    }

    fun renameWorkspaceConversation(
        conversation: RemoteConversation,
        title: String,
        onDone: (Boolean, String) -> Unit,
    ) {
        val pair = activeDevice ?: run {
            onDone(false, "尚未配对桌面端")
            return
        }
        val workspaceId = openedWorkspaceId ?: run {
            onDone(false, "尚未选择工作区")
            return
        }
        val normalized = title.replace(Regex("\\s+"), " ").trim().take(80)
        if (normalized.isBlank()) {
            onDone(false, "对话名称不能为空")
            return
        }
        viewModelScope.launch {
            api.renameConversation(pair, workspaceId, conversation.id, normalized)
                .onSuccess { response ->
                    applyWorkspaceConversationRows(workspaceId, response)
                    if (selectedConversationId == conversation.id) selectedConversationTitle = normalized
                    onDone(true, normalized)
                }
                .onFailure { error ->
                    val message = "重命名失败：${error.message ?: "未知错误"}"
                    lastError = message
                    onDone(false, message)
                }
        }
    }

    fun toggleWorkspaceConversationPin(
        conversation: RemoteConversation,
        onDone: (Boolean, String) -> Unit,
    ) {
        val pair = activeDevice ?: run {
            onDone(false, "尚未配对桌面端")
            return
        }
        val workspaceId = openedWorkspaceId ?: run {
            onDone(false, "尚未选择工作区")
            return
        }
        val nextPinned = !conversation.pinned
        if (openedWorkspaceId == workspaceId) {
            workspaceConversations = workspaceConversations.map { item ->
                if (item.id == conversation.id) item.copy(pinned = nextPinned) else item
            }
        }
        viewModelScope.launch {
            api.setConversationPinned(pair, workspaceId, conversation.id, nextPinned)
                .onSuccess { response ->
                    applyWorkspaceConversationRows(workspaceId, response)
                    onDone(true, if (nextPinned) "已置顶" else "已取消置顶")
                }
                .onFailure { error ->
                    val message = "置顶状态更新失败：${error.message ?: "未知错误"}"
                    lastError = message
                    refreshWorkspaceConversationRows(pair, workspaceId)
                    onDone(false, message)
                }
        }
    }

    fun reorderWorkspaceConversations(
        conversationIds: List<String>,
        onDone: (Boolean, String) -> Unit = { _, _ -> },
    ) {
        if (workspaceReorderPending) return
        val pair = activeDevice ?: run {
            onDone(false, "尚未配对桌面端")
            return
        }
        val workspaceId = openedWorkspaceId ?: run {
            onDone(false, "尚未选择工作区")
            return
        }
        val normalized = conversationIds.filter { it.isNotBlank() }.distinct()
        if (normalized.size < 2 || normalized.size != conversationIds.size) return
        val requested = normalized.mapNotNull { id -> workspaceConversations.firstOrNull { it.id == id } }
        if (requested.size != normalized.size || requested.map { it.pinned }.distinct().size != 1) return
        val previous = workspaceConversations
        val optimistic = reorderConversationSubset(previous, normalized)
        if (optimistic == previous) return
        workspaceConversations = optimistic
        if (desktopState?.currentWorkspaceId == workspaceId) remoteConversations = optimistic
        workspaceReorderPending = true
        viewModelScope.launch {
            api.reorderConversations(pair, workspaceId, normalized)
                .onSuccess { response ->
                    applyWorkspaceConversationRows(workspaceId, response)
                    onDone(true, "排序已保存")
                }
                .onFailure { error ->
                    if (openedWorkspaceId == workspaceId) {
                        workspaceConversations = previous
                        if (desktopState?.currentWorkspaceId == workspaceId) remoteConversations = previous
                    }
                    val message = "排序保存失败：${error.message ?: "未知错误"}"
                    lastError = message
                    refreshWorkspaceConversationRows(pair, workspaceId)
                    onDone(false, message)
                }
            workspaceReorderPending = false
        }
    }

    private fun reorderConversationSubset(
        rows: List<RemoteConversation>,
        orderedIds: List<String>,
    ): List<RemoteConversation> {
        val requestedIds = orderedIds.toSet()
        val slots = rows.indices.filter { rows[it].id in requestedIds }
        if (slots.size != orderedIds.size) return rows
        val byId = rows.associateBy { it.id }
        val reordered = rows.toMutableList()
        slots.forEachIndexed { index, slot -> reordered[slot] = byId.getValue(orderedIds[index]) }
        return reordered
    }

    /** 归档桌面端对话（PC 端点；运行中 423 拒绝）→ 成功后全量同步对话列表与当前对话 */
    fun archiveRemote(conversation: RemoteConversation, onDone: (Boolean, String) -> Unit) {
        val pair = activeDevice ?: run {
            lastError = "尚未配对桌面端"
            onDone(false, "尚未配对桌面端")
            return
        }
        val workspaceId = openedWorkspaceId ?: run {
            onDone(false, "尚未选择工作区")
            return
        }
        val pendingKey = "$workspaceId::${conversation.id}"
        workspaceArchivePendingKeys = workspaceArchivePendingKeys + pendingKey
        viewModelScope.launch {
            api.archiveConversation(pair, workspaceId, conversation.id)
                .onSuccess { response ->
                    val list = applyWorkspaceConversationRows(workspaceId, response)
                    if (selectedConversationId == conversation.id && openedWorkspaceId == workspaceId) {
                        val nextId = list.firstOrNull { it.active }?.id ?: list.firstOrNull()?.id
                        if (nextId != null) {
                            selectConversation(nextId, workspaceId)
                        } else {
                            selectedConversationId = null
                            selectedConversationWorkspaceId = null
                            selectedConversationTitle = null
                            remoteMessages = emptyList()
                            remoteWorkRuns = emptyList()
                        }
                    }
                    onDone(true, conversation.title)
                }
                .onFailure { e ->
                    val msg = e.message ?: "未知错误"
                    val friendly = if (msg.contains("423")) "对话正在运行，无法归档" else "归档失败：$msg"
                    lastError = friendly
                    onDone(false, friendly)
                }
            workspaceArchivePendingKeys = workspaceArchivePendingKeys - pendingKey
        }
    }

    private fun parseWorkspaceConversationRows(json: JSONObject): List<RemoteConversation> = runCatching {
        val arr = json.optJSONArray("conversations") ?: return emptyList()
        val type = object : TypeToken<List<RemoteConversation>>() {}.type
        gson.fromJson<List<RemoteConversation>>(arr.toString(), type) ?: emptyList()
    }.getOrDefault(emptyList())

    private fun applyWorkspaceConversationRows(workspaceId: String, json: JSONObject): List<RemoteConversation> {
        val list = parseWorkspaceConversationRows(json)
        if (openedWorkspaceId == workspaceId) {
            workspaceConversations = list
            openedWorkspaceActiveConversationId = list.firstOrNull { it.active }?.id.orEmpty()
        }
        if (desktopState?.currentWorkspaceId == workspaceId) remoteConversations = list
        return list
    }

    private suspend fun refreshWorkspaceConversationRows(pair: PairInfo, workspaceId: String) {
        api.workspaceConversations(pair, workspaceId)
            .onSuccess { response -> applyWorkspaceConversationRows(workspaceId, response) }
    }

    private fun parseState(json: JSONObject): DesktopState? = runCatching {
        val base = gson.fromJson(json.toString(), DesktopState::class.java) ?: return null
        val workspaces = mutableListOf<WorkspaceInfo>()
        val wsObj = json.optJSONObject("workspaces")
        wsObj?.optJSONArray("internal")?.let { arr ->
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                workspaces += WorkspaceInfo(o.optString("id"), o.optString("name"), o.optString("path"), true)
            }
        }
        wsObj?.optJSONArray("external")?.let { arr ->
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                workspaces += WorkspaceInfo(o.optString("id"), o.optString("name"), o.optString("path"), false)
            }
        }
        val currentWsId = wsObj?.optJSONObject("current")?.optString("id", "") ?: ""
        val agentRunning = base.status == "working"
        val conversations = base.conversations.map { c ->
            c.copy(running = c.id == base.activeConversationId && agentRunning)
        }
        base.copy(workspaces = workspaces, currentWorkspaceId = currentWsId, conversations = conversations)
    }.onFailure { error ->
        // A connected device with a silently null state is indistinguishable
        // from a valid desktop that has no workspaces. Preserve fail-soft UI,
        // but make Release/R8 parse regressions observable and diagnosable.
        Log.e("NewmarkRemoteState", "Failed to parse authenticated mobile state", error)
    }.getOrNull()

    private fun parseConversationUiState(json: JSONObject): RemoteConversationUiState = runCatching {
        RemotePayloadNormalizer.conversationUiState(
            gson.fromJson(json.toString(), RemoteConversationUiState::class.java) ?: RemoteConversationUiState(),
        )
    }.getOrNull() ?: RemoteConversationUiState()

    private fun parseMessages(json: JSONObject): List<RemoteMessage> = runCatching {
        val type = object : TypeToken<List<RemoteMessage>>() {}.type
        val arr = json.optJSONArray("chatMessages") ?: return emptyList()
        (gson.fromJson<List<RemoteMessage>>(arr.toString(), type) ?: emptyList())
            .map(RemotePayloadNormalizer::message)
    }.getOrDefault(emptyList())

    private fun parseBranchGroups(json: JSONObject): List<RemoteBranchGroup> = runCatching {
        val type = object : TypeToken<List<RemoteBranchGroup>>() {}.type
        val arr = json.optJSONArray("branchGroups") ?: return emptyList()
        gson.fromJson<List<RemoteBranchGroup>>(arr.toString(), type) ?: emptyList()
    }.getOrDefault(emptyList())

    private fun parseStringArray(json: JSONObject, key: String): List<String> {
        val array = json.optJSONArray(key) ?: return emptyList()
        return buildList {
            for (index in 0 until array.length()) {
                array.optString(index).takeIf(String::isNotBlank)?.let(::add)
            }
        }
    }

    private fun applyConversationSnapshot(json: JSONObject) {
        applyConversationSnapshot(parseConversationSnapshot(json))
    }

    private fun applyConversationSnapshot(snapshot: ConversationSnapshot) {
        remoteMessages = snapshot.messages
        remoteWindowStart = snapshot.windowStart
        remoteWorkRuns = snapshot.workRuns
        liveRun?.let { provisional ->
            if (snapshot.workRuns.any { RemoteTrackingContract.sameRun(it.runId, provisional.runId) }) liveRun = null
        }
        remoteBranchGroups = snapshot.branchGroups
        remoteViewedBranchId = snapshot.viewedBranchId
        remoteRuntimeBranchId = snapshot.runtimeBranchId
        remoteBranchGroupId = snapshot.branchGroupId
        remoteViewedBranchNodePath = snapshot.viewedPath
        remoteRuntimeBranchNodePath = snapshot.runtimePath
    }

    private fun parseConversationSnapshot(json: JSONObject): ConversationSnapshot {
        return ConversationSnapshot(
            messages = parseMessages(json),
            windowStart = json.optInt("windowStart", 0).coerceAtLeast(0),
            workRuns = parseWorkRuns(json),
            branchGroups = parseBranchGroups(json),
            viewedBranchId = json.optString("activeBranchId", ""),
            runtimeBranchId = json.optString("runtimeBranchId", json.optString("activeBranchId", "")),
            branchGroupId = json.optString("branchGroupId", ""),
            viewedPath = parseStringArray(json, "viewedBranchNodePath"),
            runtimePath = parseStringArray(json, "runtimeBranchNodePath"),
        )
    }

    private data class ConversationSnapshot(
        val messages: List<RemoteMessage>,
        val windowStart: Int,
        val workRuns: List<RemoteWorkRun>,
        val branchGroups: List<RemoteBranchGroup>,
        val viewedBranchId: String,
        val runtimeBranchId: String,
        val branchGroupId: String,
        val viewedPath: List<String>,
        val runtimePath: List<String>,
    )

    private fun clearRemoteBranchState() {
        remoteBranchGroups = emptyList()
        remoteViewedBranchId = ""
        remoteRuntimeBranchId = ""
        remoteBranchGroupId = ""
        remoteViewedBranchNodePath = emptyList()
        remoteRuntimeBranchNodePath = emptyList()
    }

    private fun parseWorkRuns(json: JSONObject): List<RemoteWorkRun> = runCatching {
        val type = object : TypeToken<List<RemoteWorkRun>>() {}.type
        val arr = json.optJSONArray("workRuns") ?: return emptyList()
        (gson.fromJson<List<RemoteWorkRun>>(arr.toString(), type) ?: emptyList())
            .map(RemotePayloadNormalizer::workRun)
    }.getOrDefault(emptyList())

    // ---- SSE：实时追踪进行中的 build block（对齐 PC /api/mobile/events，event: work / data: JSON） ----

    private var sseJob: Job? = null

    /** 连接成功后挂 SSE 长连接；断线自动 3s 重试，viewModelScope 取消即停 */
    private fun startSse(pair: PairInfo, session: MobileSessionGate.Session) {
        sseJob?.cancel()
        sseJob = viewModelScope.launch(Dispatchers.IO) {
            var outageStartedAt = 0L
            while (isActive && isCurrent(session, pair)) {
                var cancellation: kotlinx.coroutines.DisposableHandle? = null
                val eventQueue = Channel<RemoteWorkEvent>(capacity = SSE_EVENT_QUEUE_CAPACITY)
                val batchApplier = launch {
                    applyQueuedSseEvents(eventQueue, session, pair)
                }
                try {
                    val req = okhttp3.Request.Builder()
                        .url("${pair.baseUrl}/api/mobile/events?token=${pair.token}")
                        .get()
                        .build()
                    val call = api.rawClient.newCall(req)
                    // OkHttp execute is blocking.  Explicitly close its socket on
                    // coroutine cancellation so a stale device cannot retain a
                    // long-lived SSE thread until readTimeout expires.
                    cancellation = coroutineContext[Job]?.invokeOnCompletion { call.cancel() }
                    call.execute().use { resp ->
                        if (!resp.isSuccessful) throw java.io.IOException("SSE HTTP ${resp.code}")
                        outageStartedAt = 0L
                        withContext(Dispatchers.Main.immediate) {
                            if (isCurrent(session, pair)) {
                                isConnected = true
                                linkStatus = LinkStatus.Connected
                                lastError = null
                            }
                        }
                        refreshSelectedTargetAfterSseConnect(session, pair)
                        val source = resp.body?.source() ?: throw java.io.IOException("SSE no body")
                        while (isActive && isCurrent(session, pair) && !source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            sseDataPayload(line)?.let { payload ->
                                parseSseWorkEvent(payload)?.let { eventQueue.send(it) }
                            }
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Throwable) {
                    // 断线重连（retry 3000 语义）
                } finally {
                    cancellation?.dispose()
                    eventQueue.close()
                    batchApplier.join()
                }
                if (isActive && isCurrent(session, pair)) {
                    val now = System.currentTimeMillis()
                    if (outageStartedAt == 0L) outageStartedAt = now
                    withContext(Dispatchers.Main.immediate) {
                        if (isCurrent(session, pair)) {
                            isConnected = false
                            if (now - outageStartedAt >= RECONNECT_TIMEOUT_MS) {
                                linkStatus = LinkStatus.Disconnected
                                lastError = "连接已断开"
                            } else {
                                linkStatus = LinkStatus.Reconnecting
                                lastError = "连接中断，正在重连…"
                            }
                        }
                    }
                    delay(SSE_RECONNECT_INTERVAL_MS)
                }
            }
        }
    }

    /** SSE does not replay missed events, so every successful connection rehydrates its exact durable target. */
    private suspend fun refreshSelectedTargetAfterSseConnect(
        session: MobileSessionGate.Session,
        pair: PairInfo,
    ) {
        val workspaceId = selectedConversationWorkspaceId ?: return
        val conversationId = selectedConversationId ?: return
        if (!isCurrent(session, pair) || !isSelectedTarget(workspaceId, conversationId)) return
        val snapshotResponse = api.conversation(pair, conversationId, workspaceId).getOrNull()
        val uiResponse = api.conversationUiState(pair, workspaceId, conversationId).getOrNull()
        val snapshot = snapshotResponse?.let { response ->
            withContext(Dispatchers.Default) { parseConversationSnapshot(response) }
        }
        val uiState = uiResponse?.let { response ->
            withContext(Dispatchers.Default) { parseConversationUiState(response) }
        }
        withContext(Dispatchers.Main.immediate) {
            if (!isCurrent(session, pair) || !isSelectedTarget(workspaceId, conversationId)) return@withContext
            snapshot?.let(::applyConversationSnapshot)
            uiState?.let(::applyResidentConversationUiState)
            val runtime = uiState?.runtime
            val runtimeRunId = runtime?.runId.orEmpty()
            if (runtime?.running == true && runtimeRunId.isNotBlank()) {
                val durableRun = snapshot?.workRuns?.firstOrNull { it.runId == runtimeRunId }
                liveRun = when {
                    liveRun?.runId == runtimeRunId -> liveRun
                    durableRun != null -> durableRun.copy(status = "running", endedAt = "")
                    else -> RemoteWorkRun(runId = runtimeRunId, status = "running")
                }
            } else if (runtime?.running == false) {
                liveRun = null
            }
            drainRemoteNextIfReady()
        }
    }

    /**
     * The network reader never writes Compose state one event at a time. A
     * fast desktop Build can emit hundreds of public events in one burst; at
     * most one batched mutable snapshot is committed per 48 ms / 48 events.
     * This keeps event order and terminal delivery exact while avoiding a
     * recomposition and list-layout pass for every SSE line.
     */
    private suspend fun applyQueuedSseEvents(
        queue: Channel<RemoteWorkEvent>,
        session: MobileSessionGate.Session,
        pair: PairInfo,
    ) {
        while (coroutineContext[Job]?.isActive == true && isCurrent(session, pair)) {
            val first = queue.receiveCatching().getOrNull() ?: return
            val batch = ArrayList<RemoteWorkEvent>(SSE_MAX_BATCH_SIZE)
            batch += first
            val flushAt = SystemClock.elapsedRealtime() + SSE_BATCH_WINDOW_MS
            while (batch.size < SSE_MAX_BATCH_SIZE && !isTerminalSseEvent(batch.last())) {
                val remaining = (flushAt - SystemClock.elapsedRealtime()).coerceAtLeast(0L)
                val next = withTimeoutOrNull(remaining) { queue.receiveCatching().getOrNull() } ?: break
                batch += next
            }
            withContext(Dispatchers.Main.immediate) {
                if (isCurrent(session, pair)) applySseEventBatch(batch, session, pair)
            }
        }
    }

    private fun parseSseWorkEvent(payload: String): RemoteWorkEvent? {
        if (payload.isBlank()) return null
        return runCatching {
            // SSE and `/conversation` snapshots share the exact
            // AgentWorkEvent contract; direct Gson mapping preserves Guide,
            // display-image, actor and branch fields without a lossy shim.
            gson.fromJson(payload, RemoteWorkEvent::class.java)
                ?.let(RemotePayloadNormalizer::workEvent)
        }.getOrNull()
    }

    private fun isTerminalSseEvent(event: RemoteWorkEvent): Boolean =
        event.type in TERMINAL_SSE_EVENT_TYPES

    private fun applySseEventBatch(
        events: List<RemoteWorkEvent>,
        session: MobileSessionGate.Session,
        pair: PairInfo,
    ) {
        val terminalSyncs = ArrayList<TerminalRunSync>(1)
        Snapshot.withMutableSnapshot {
            events.forEach { event -> applySseEvent(event, terminalSyncs) }
        }
        terminalSyncs.distinctBy { it.runId }.forEach { sync ->
            refreshTerminalWorkRun(session, pair, sync)
        }
    }

    /** SSE work event → live Build reducer. Must run on Main inside one mutable snapshot. */
    private fun applySseEvent(
        event: RemoteWorkEvent,
        terminalSyncs: MutableList<TerminalRunSync>,
    ) {
        val type = event.type
        val runId = event.runId
        val eventWorkspaceId = event.workspaceId
        val selectedId = selectedConversationId
        val selectedWorkspace = selectedConversationWorkspaceId
        val belongsToSelected = RemoteTrackingContract.acceptsLiveEvent(selectedWorkspace, selectedId, event)
        if (!belongsToSelected) {
            if (eventWorkspaceId.isNotBlank() && event.conversationId.isNotBlank() && runId.isNotBlank()) {
                updateWorkspaceConversationRuntime(eventWorkspaceId, event.conversationId, event.status.ifBlank {
                    when (type) {
                        "start" -> "running"
                        "done" -> ""
                        else -> type
                    }
                })
            }
            return
        }
        // 模型回退同步输入框下方选择区：PC 端回退后移动端显示实际生效模型。
        event.fallback?.to?.takeIf(String::isNotBlank)?.let { to ->
            val providerId = event.fallback.providerId.orEmpty()
            fallbackModel = if (providerId.isNotBlank()) {
                "deployment:${java.net.URLEncoder.encode(providerId, Charsets.UTF_8.name())}:" +
                    java.net.URLEncoder.encode(to, Charsets.UTF_8.name())
            } else {
                to
            }
        }
        val current = liveRun
        val authoritativeRunningRunId = conversationUiState.runtime
            ?.takeIf { it.running }
            ?.runId
            .orEmpty()
        val durableRunStatus = remoteWorkRuns
            .firstOrNull { RemoteTrackingContract.sameRun(it.runId, runId) }
            ?.status
        val acceptsNonTerminalEvent = RemoteTrackingContract.acceptsNonTerminalRunEvent(
            eventRunId = runId,
            liveRunStatus = current
                ?.takeIf { RemoteTrackingContract.sameRun(it.runId, runId) }
                ?.status,
            durableRunStatus = durableRunStatus,
            authoritativeRunningRunId = authoritativeRunningRunId,
        )
        when (type) {
            "start" -> {
                if (!acceptsNonTerminalEvent) return
                updateWorkspaceConversationRuntime(eventWorkspaceId, event.conversationId, "running")
                if (current != null && sameRun(current.runId, runId)) {
                    liveRun = current.copy(events = appendUniqueEvent(current.events, event))
                } else {
                    liveRun = RemoteWorkRun(
                        runId = runId,
                        status = "running",
                        startedAt = event.timestamp,
                        events = listOf(event),
                        anchorMessageId = event.anchorMessageId,
                        branchNodeId = event.branchNodeId,
                    )
                }
            }

            "done", "error", "interrupted", "force_interrupted" -> {
                updateWorkspaceConversationRuntime(
                    eventWorkspaceId,
                    event.conversationId,
                    when (type) {
                        "done" -> ""
                        "error" -> "error"
                        else -> type
                    },
                )
                if (current != null && sameRun(current.runId, runId)) {
                    liveRun = current.copy(
                        status = when (type) {
                            "done" -> "completed"
                            "error" -> "error"
                            else -> "interrupted"
                        },
                        endedAt = event.timestamp,
                        events = appendUniqueEvent(current.events, event),
                    )
                }
                // The terminal event is authoritative even if a PC-started
                // run or an SSE reconnect means no matching liveRun exists.
                terminalSyncs += TerminalRunSync(
                    runId = runId,
                    conversationId = event.conversationId,
                    workspaceId = eventWorkspaceId,
                )
            }

            else -> {
                if (!acceptsNonTerminalEvent) return
                if (event.status.isNotBlank()) {
                    updateWorkspaceConversationRuntime(eventWorkspaceId, event.conversationId, event.status)
                }
                if (current != null && sameRun(current.runId, runId)) {
                    liveRun = current.copy(events = appendUniqueEvent(current.events, event))
                } else {
                    liveRun = RemoteWorkRun(
                        runId = runId,
                        status = "running",
                        startedAt = event.timestamp,
                        events = listOf(event),
                        anchorMessageId = event.anchorMessageId,
                        branchNodeId = event.branchNodeId,
                    )
                }
            }
        }
    }

    /** Pull the durable desktop snapshot after a terminal SSE boundary. */
    private fun refreshTerminalWorkRun(
        session: MobileSessionGate.Session,
        pair: PairInfo,
        sync: TerminalRunSync,
    ) {
        viewModelScope.launch {
            if (!isCurrent(session, pair)) return@launch
            val stateResponse = api.state(pair).getOrNull()
            if (stateResponse != null && isCurrent(session, pair)) {
                val parsedState = withContext(Dispatchers.Default) { parseState(stateResponse) }
                if (!isCurrent(session, pair)) return@launch
                desktopState = parsedState
                remoteConversations = parsedState?.conversations ?: emptyList()
            }
            val conversationId = sync.conversationId
            if (!conversationId.isNullOrBlank()) {
                val snapshotResponse = api.conversation(pair, conversationId, sync.workspaceId).getOrNull()
                val snapshot = snapshotResponse?.let { response ->
                    withContext(Dispatchers.Default) { parseConversationSnapshot(response) }
                }
                if (snapshot != null && isCurrent(session, pair) &&
                    isSelectedTarget(sync.workspaceId, conversationId)
                ) applyConversationSnapshot(snapshot)
            }
            if (isCurrent(session, pair) && isSelectedTarget(sync.workspaceId, conversationId) &&
                RemoteTrackingContract.sameRun(liveRun?.runId.orEmpty(), sync.runId)
            ) liveRun = null
        }
    }

    private fun sameRun(currentRunId: String, eventRunId: String): Boolean =
        RemoteTrackingContract.sameRun(currentRunId, eventRunId)

    private fun appendUniqueEvent(
        events: List<RemoteWorkEvent>,
        incoming: RemoteWorkEvent,
    ): List<RemoteWorkEvent> {
        val duplicate = events.any { existing ->
            incoming.id.isNotBlank() && existing.id == incoming.id ||
                (incoming.id.isBlank() && existing.id.isBlank() &&
                    existing.sequence == incoming.sequence && existing.type == incoming.type &&
                    existing.timestamp == incoming.timestamp)
        }
        return if (duplicate) events else events + incoming
    }

    private fun updateWorkspaceConversationRuntime(
        workspaceId: String,
        conversationId: String,
        runtimeStatus: String,
    ) {
        if (conversationId.isBlank()) return
        if (openedWorkspaceId == null || (workspaceId.isNotBlank() && openedWorkspaceId != workspaceId)) return
        val marqueeStatuses = setOf("running", "stopping", "force_restarting")
        workspaceConversations = workspaceConversations.map { conversation ->
            if (conversation.id == conversationId) {
                conversation.copy(
                    runtimeStatus = runtimeStatus,
                    running = runtimeStatus in marqueeStatuses,
                )
            } else {
                conversation
            }
        }
    }

    private fun parseSend(json: JSONObject): SendResponse = runCatching {
        gson.fromJson(json.toString(), SendResponse::class.java) ?: SendResponse()
    }.getOrDefault(SendResponse())

    companion object {
        private const val SSE_BATCH_WINDOW_MS = 48L
        private const val SSE_MAX_BATCH_SIZE = 48
        private const val SSE_EVENT_QUEUE_CAPACITY = 256
        private const val SSE_RECONNECT_INTERVAL_MS = 3_000L
        private val TERMINAL_SSE_EVENT_TYPES = setOf("done", "error", "interrupted", "force_interrupted")
        private const val RECONNECT_INTERVAL_MS = 3_000L
        private const val RECONNECT_TIMEOUT_MS = 5 * 60_000L
    }
}
