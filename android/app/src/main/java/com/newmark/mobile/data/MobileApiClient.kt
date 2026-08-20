package com.newmark.mobile.data

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONObject
import java.io.InputStream
import java.io.ByteArrayInputStream
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/** 桌面端 mobile API 客户端（Tailscale 内网 + token 认证） */
class MobileApiClient {

    private val client = OkHttpClient.Builder()
        // A missing desktop listener is the normal mobile-first startup case.
        // Keep TCP probing bounded so a socket opened before the PC service
        // exists cannot consume an entire reconnect period. Long provider and
        // conversation responses remain governed by the independent 180 s
        // read timeout below.
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .build()

    /** 供 SSE 长连接复用（读超时由流式消费控制） */
    val rawClient: OkHttpClient get() = client

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private fun authedUrl(pair: PairInfo, path: String): String =
        "${pair.baseUrl}$path${if (path.contains('?')) "&" else "?"}token=${pair.token}"

    private suspend fun get(pair: PairInfo, path: String): Result<JSONObject> = executeJson(
        Request.Builder().url(authedUrl(pair, path)).get().build(),
    )

    private suspend fun post(pair: PairInfo, path: String, body: JSONObject): Result<JSONObject> = executeJson(
        Request.Builder()
            .url(authedUrl(pair, path))
            .post(body.toString().toRequestBody(jsonMedia))
            .build(),
    )

    /**
     * Request is tied to its coroutine: switching desktop devices or leaving
     * the screen immediately closes the socket instead of leaving a 10–180s
     * blocking OkHttp `execute()` behind.  This is required for bounded SSE /
     * reconnect resource use and prevents stale callbacks after a device swap.
     */
    private suspend fun executeJson(request: Request): Result<JSONObject> = suspendCancellableCoroutine { continuation ->
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: okhttp3.Call, error: java.io.IOException) {
                if (continuation.isActive) continuation.resume(Result.failure(error))
            }

            override fun onResponse(call: okhttp3.Call, response: Response) {
                val result = runCatching {
                    response.use { resp ->
                        val text = resp.body?.string() ?: ""
                        if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(120)}")
                        JSONObject(text)
                    }
                }
                if (continuation.isActive) continuation.resume(result)
            }
        })
    }

    /** 验证配对并获取桌面端基本信息 */
    suspend fun hello(pair: PairInfo): Result<JSONObject> = get(pair, "/api/mobile/hello")

    /** 确认配对窗口（扫码后调用；token 鉴权 + pairingId 确认，桌面端随即关闭二维码） */
    suspend fun confirm(invite: PairInvite): Result<JSONObject> = executeJson(
        Request.Builder()
            .url("http://${invite.host}:${invite.port}/api/mobile/pair-confirm?token=${invite.token}")
            .post(JSONObject().apply { put("pairingId", invite.pairingId) }.toString().toRequestBody(jsonMedia))
            .build(),
    )

    /** 桌面端状态（对话列表 + 当前对话消息 + 模式/模型） */
    suspend fun state(pair: PairInfo): Result<JSONObject> = get(pair, "/api/mobile/state")

    /**
     * 旧桌面包的 mobile state 尚未包含 provider catalog；它的普通 state
     * 已经返回同一份脱敏 providers。仅用于兼容已安装旧桌面进程。
     */
    suspend fun legacyProviderState(pair: PairInfo): Result<JSONObject> = get(pair, "/api/state")

    suspend fun selectModel(pair: PairInfo, model: String): Result<JSONObject> =
        post(pair, "/api/mobile/model", JSONObject().apply { put("model", model) })

    suspend fun selectIntelligence(pair: PairInfo, tier: String): Result<JSONObject> =
        post(pair, "/api/mobile/intelligence", JSONObject().apply { put("tier", tier) })

    /** 某个对话的快照（workspaceId 指定所属工作区，缺省当前工作区） */
    suspend fun conversation(pair: PairInfo, conversationId: String?, workspaceId: String? = null): Result<JSONObject> {
        val suffix = conversationId?.let { "&conversationId=$it" } ?: ""
        val wsSuffix = workspaceId?.takeIf { it.isNotBlank() }?.let { "&workspaceId=$it" } ?: ""
        return get(pair, "/api/mobile/conversation?window=200$suffix$wsSuffix")
    }

    /** 向桌面端 Agent 发送消息（同步等待完成） */
    suspend fun send(
        pair: PairInfo,
        message: String,
        conversationId: String?,
        workspaceId: String? = null,
        requestedMode: String = "",
        goalObjective: String = "",
        inputMode: String = "",
    ): Result<JSONObject> {
        val body = JSONObject().apply {
            put("message", message)
            conversationId?.let { put("conversationId", it) }
            workspaceId?.takeIf { it.isNotBlank() }?.let { put("workspaceId", it) }
            requestedMode.takeIf { it.isNotBlank() }?.let { put("requestedMode", it) }
            goalObjective.takeIf { it.isNotBlank() }?.let { put("goalObjective", it) }
            inputMode.takeIf { it.isNotBlank() }?.let { put("inputMode", it) }
        }
        return post(pair, "/api/mobile/send", body)
    }

    suspend fun createConversation(pair: PairInfo, workspaceId: String, title: String): Result<JSONObject> =
        post(pair, "/api/mobile/conversation-create", JSONObject().apply {
            put("workspaceId", workspaceId)
            put("title", title)
        })

    suspend fun renameConversation(
        pair: PairInfo,
        workspaceId: String,
        conversationId: String,
        title: String,
    ): Result<JSONObject> = post(pair, "/api/mobile/conversation-rename", JSONObject().apply {
        put("workspaceId", workspaceId)
        put("conversationId", conversationId)
        put("title", title)
    })

    suspend fun setConversationPinned(
        pair: PairInfo,
        workspaceId: String,
        conversationId: String,
        pinned: Boolean,
    ): Result<JSONObject> = post(pair, "/api/mobile/conversation-pin", JSONObject().apply {
        put("workspaceId", workspaceId)
        put("conversationId", conversationId)
        put("pinned", pinned)
    })

    suspend fun reorderConversations(
        pair: PairInfo,
        workspaceId: String,
        conversationIds: List<String>,
    ): Result<JSONObject> = post(pair, "/api/mobile/conversation-reorder", JSONObject().apply {
        put("workspaceId", workspaceId)
        put("conversationIds", org.json.JSONArray(conversationIds))
    })

    /** 归档桌面端工作区对话（PC 端运行中拒绝 423） */
    suspend fun archiveConversation(
        pair: PairInfo,
        workspaceId: String,
        conversationId: String,
    ): Result<JSONObject> = post(pair, "/api/mobile/conversation-archive", JSONObject().apply {
        put("workspaceId", workspaceId)
        put("conversationId", conversationId)
    })

    /** 某工作区的从属对话列表（含 running） */
    suspend fun workspaceConversations(pair: PairInfo, workspaceId: String): Result<JSONObject> =
        get(pair, "/api/mobile/workspace-conversations?workspaceId=$workspaceId")

    private fun query(value: String): String = URLEncoder.encode(value, Charsets.UTF_8.name())

    suspend fun rightSidebarState(pair: PairInfo, workspaceId: String, conversationId: String): Result<JSONObject> =
        get(pair, "/api/mobile/right-sidebar-state?workspaceId=${query(workspaceId)}&conversationId=${query(conversationId)}")

    suspend fun conversationUiState(pair: PairInfo, workspaceId: String, conversationId: String): Result<JSONObject> =
        get(pair, "/api/mobile/conversation-ui-state?workspaceId=${query(workspaceId)}&conversationId=${query(conversationId)}")

    suspend fun conversationUiAction(
        pair: PairInfo,
        workspaceId: String,
        conversationId: String,
        action: String,
        value: String = "",
    ): Result<JSONObject> = post(pair, "/api/mobile/conversation-ui-action", JSONObject().apply {
        put("workspaceId", workspaceId)
        put("conversationId", conversationId)
        put("action", action)
        put("value", value)
    })

    suspend fun conversationQueueAction(
        pair: PairInfo,
        workspaceId: String,
        conversationId: String,
        action: String,
        id: String = "",
        text: String = "",
        requestedMode: String = "build",
        goalObjective: String = "",
        orderedIds: List<String> = emptyList(),
    ): Result<JSONObject> = post(pair, "/api/mobile/conversation-ui-action", JSONObject().apply {
        put("workspaceId", workspaceId)
        put("conversationId", conversationId)
        put("action", action)
        id.takeIf(String::isNotBlank)?.let { put("id", it) }
        text.takeIf(String::isNotBlank)?.let { put("text", it) }
        requestedMode.takeIf(String::isNotBlank)?.let { put("requestedMode", it) }
        goalObjective.takeIf(String::isNotBlank)?.let { put("goalObjective", it) }
        if (orderedIds.isNotEmpty()) put("orderedIds", org.json.JSONArray(orderedIds))
    })

    suspend fun workspaceFiles(pair: PairInfo, workspaceId: String, path: String): Result<JSONObject> =
        get(pair, "/api/mobile/workspace-files?workspaceId=${query(workspaceId)}&path=${query(path)}")

    suspend fun workspaceFile(pair: PairInfo, workspaceId: String, path: String): Result<JSONObject> =
        get(pair, "/api/mobile/workspace-file?workspaceId=${query(workspaceId)}&path=${query(path)}")

    suspend fun saveWorkspaceFile(pair: PairInfo, workspaceId: String, path: String, content: String): Result<JSONObject> =
        post(pair, "/api/mobile/workspace-file", JSONObject().apply {
            put("workspaceId", workspaceId)
            put("path", path)
            put("content", content)
        })

    /** Raw streaming upload; the selected SAF document is never materialized as a ByteArray/base64 string. */
    suspend fun uploadWorkspaceFile(
        pair: PairInfo,
        workspaceId: String,
        directory: String,
        fileName: String,
        mimeType: String,
        contentLength: Long?,
        openStream: () -> InputStream,
        onProgress: (Long, Long?) -> Unit = { _, _ -> },
    ): Result<JSONObject> {
        val requestBody = object : RequestBody() {
            override fun contentType() = mimeType.ifBlank { "application/octet-stream" }.toMediaType()
            override fun contentLength(): Long = contentLength?.takeIf { it >= 0L } ?: -1L
            override fun writeTo(sink: BufferedSink) {
                openStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var uploaded = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        sink.write(buffer, 0, read)
                        uploaded += read
                        onProgress(uploaded, contentLength?.takeIf { it >= 0L })
                    }
                }
            }
        }
        val endpoint = "/api/mobile/workspace-file-upload" +
            "?workspaceId=${query(workspaceId)}" +
            "&directory=${query(directory)}" +
            "&fileName=${query(fileName)}"
        return executeJson(Request.Builder().url(authedUrl(pair, endpoint)).post(requestBody).build())
    }

    suspend fun uploadWorkspaceFile(
        pair: PairInfo,
        workspaceId: String,
        name: String,
        mimeType: String,
        bytes: ByteArray,
    ): Result<JSONObject> = uploadWorkspaceFile(
        pair = pair,
        workspaceId = workspaceId,
        directory = "",
        fileName = name,
        mimeType = mimeType,
        contentLength = bytes.size.toLong(),
        openStream = { ByteArrayInputStream(bytes) },
    )

    suspend fun updateConversationPlan(
        pair: PairInfo,
        workspaceId: String,
        conversationId: String,
        items: org.json.JSONArray,
    ): Result<JSONObject> = post(pair, "/api/mobile/conversation-plan-update", JSONObject().apply {
        put("workspaceId", workspaceId)
        put("conversationId", conversationId)
        put("items", items)
    })

    suspend fun inspectConversationBranch(
        pair: PairInfo,
        workspaceId: String,
        conversationId: String,
        branchId: String,
        branchGroupId: String,
    ): Result<JSONObject> = post(pair, "/api/mobile/conversation-branch-inspect", JSONObject().apply {
        put("workspaceId", workspaceId)
        put("conversationId", conversationId)
        put("branchId", branchId)
        put("branchGroupId", branchGroupId)
    })

    suspend fun activateConversationBranch(
        pair: PairInfo,
        workspaceId: String,
        conversationId: String,
        branchId: String,
        branchGroupId: String,
    ): Result<JSONObject> = post(pair, "/api/mobile/conversation-branch-activate", JSONObject().apply {
        put("workspaceId", workspaceId)
        put("conversationId", conversationId)
        put("branchId", branchId)
        put("branchGroupId", branchGroupId)
    })

    suspend fun createConversationBranch(
        pair: PairInfo,
        workspaceId: String,
        conversationId: String,
        messageIndex: Int,
        editedText: String,
        message: RemoteMessage,
        branchNodePath: List<String>,
    ): Result<JSONObject> = post(pair, "/api/mobile/conversation-branch-create", JSONObject().apply {
        put("workspaceId", workspaceId)
        put("conversationId", conversationId)
        put("messageIndex", messageIndex)
        put("editedText", editedText)
        put("messageId", message.id)
        put("guideId", message.guideId)
        put("clientMessageId", message.clientMessageId)
        put("runId", message.runId)
        put("branchNodePath", org.json.JSONArray(branchNodePath))
    })
}
