package com.newmark.mobile.vm

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.newmark.mobile.data.DesktopState
import com.newmark.mobile.data.MobileApiClient
import com.newmark.mobile.data.PairInfo
import com.newmark.mobile.data.PairInvite
import com.newmark.mobile.data.PairStore
import com.newmark.mobile.data.RemoteConversation
import com.newmark.mobile.data.RemoteMessage
import com.newmark.mobile.data.SendResponse
import com.newmark.mobile.data.WorkEvent
import kotlinx.coroutines.launch
import org.json.JSONObject

/** 桌面端配对 + 对话同步 + 发送 */
class DesktopLinkViewModel(app: Application) : AndroidViewModel(app) {

    private val pairStore = PairStore(app)
    private val api = MobileApiClient()
    private val gson = Gson()

    var pairInfo by mutableStateOf(pairStore.load())
        private set
    var isConnected by mutableStateOf(false)
        private set
    var pairing by mutableStateOf(false)
        private set
    var desktopState by mutableStateOf<DesktopState?>(null)
        private set
    var remoteConversations by mutableStateOf<List<RemoteConversation>>(emptyList())
        private set
    var remoteMessages by mutableStateOf<List<RemoteMessage>>(emptyList())
        private set
    var lastTokens by mutableStateOf<List<WorkEvent>>(emptyList())
        private set
    var isSending by mutableStateOf(false)
        private set
    var lastError by mutableStateOf<String?>(null)
        private set

    init {
        if (pairInfo != null) refresh()
    }

    fun pairFromUrl(url: String) {
        val invite = PairInvite.fromUrl(url)
        if (invite == null) {
            lastError = "无法解析二维码/URL"
            return
        }
        viewModelScope.launch {
            pairing = true
            lastError = null
            api.confirm(invite)
                .onSuccess {
                    val pair = PairInfo(host = invite.host, port = invite.port, token = invite.token)
                    pairInfo = pair
                    pairStore.save(pair)
                    refresh()
                }
                .onFailure { e ->
                    lastError = "配对失败：${e.message}"
                    pairing = false
                }
        }
    }

    fun pairDirect(host: String, port: Int, token: String) {
        val pair = PairInfo(host = host.trim(), port = port, token = token.trim())
        if (!pair.isValid()) {
            lastError = "地址或 token 为空"
            return
        }
        pairInfo = pair
        pairStore.save(pair)
        refresh()
    }

    fun unpair() {
        pairStore.clear()
        pairInfo = null
        isConnected = false
        desktopState = null
        remoteConversations = emptyList()
        remoteMessages = emptyList()
        lastTokens = emptyList()
        lastError = null
    }

    fun refresh() {
        val pair = pairInfo ?: return
        viewModelScope.launch {
            pairing = true
            lastError = null
            api.hello(pair)
                .onSuccess { isConnected = true }
                .onFailure { e ->
                    isConnected = false
                    lastError = "连接失败：${e.message}"
                }
            api.state(pair)
                .onSuccess { state ->
                    desktopState = parseState(state)
                    remoteConversations = desktopState?.conversations ?: emptyList()
                    if (remoteMessages.isEmpty()) {
                        remoteMessages = desktopState?.chatMessages ?: emptyList()
                    }
                }
                .onFailure { e -> lastError = e.message }
            pairing = false
        }
    }

    fun selectConversation(id: String) {
        if (id.isBlank()) return
        val pair = pairInfo ?: return
        viewModelScope.launch {
            api.conversation(pair, id)
                .onSuccess { snap -> remoteMessages = parseMessages(snap) }
                .onFailure { e -> lastError = e.message }
        }
    }

    /** 发送到桌面端 Agent，同步等待完成后用返回的 chatMessages 刷新渲染 */
    fun sendToDesktop(text: String) {
        val content = text.trim()
        if (content.isEmpty() || isSending) return
        val pair = pairInfo ?: run {
            lastError = "尚未配对桌面端"
            return
        }
        isSending = true
        lastError = null
        viewModelScope.launch {
            api.send(pair, content, null)
                .onSuccess { resp ->
                    val sendResp = parseSend(resp)
                    if (sendResp.chatMessages.isNotEmpty()) {
                        remoteMessages = sendResp.chatMessages
                    }
                    lastTokens = sendResp.tokens
                    desktopState?.let { }
                }
                .onFailure { e -> lastError = "发送失败：${e.message}" }
            isSending = false
        }
    }

    private fun parseState(json: JSONObject): DesktopState? = runCatching {
        gson.fromJson(json.toString(), DesktopState::class.java)
    }.getOrNull()

    private fun parseMessages(json: JSONObject): List<RemoteMessage> = runCatching {
        val type = object : TypeToken<List<RemoteMessage>>() {}.type
        val arr = json.optJSONArray("chatMessages") ?: return emptyList()
        gson.fromJson<List<RemoteMessage>>(arr.toString(), type) ?: emptyList()
    }.getOrDefault(emptyList())

    private fun parseSend(json: JSONObject): SendResponse = runCatching {
        gson.fromJson(json.toString(), SendResponse::class.java) ?: SendResponse()
    }.getOrDefault(SendResponse())
}
