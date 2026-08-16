package com.newmark.mobile.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** 桌面端 mobile API 客户端（Tailscale 内网 + token 认证） */
class MobileApiClient {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private fun authedUrl(pair: PairInfo, path: String): String =
        "${pair.baseUrl}$path?token=${pair.token}"

    private suspend fun get(pair: PairInfo, path: String): Result<JSONObject> =
        withContext(Dispatchers.IO) {
            runCatching {
                val req = Request.Builder()
                    .url(authedUrl(pair, path))
                    .get()
                    .build()
                client.newCall(req).execute().use { resp ->
                    val text = resp.body?.string() ?: ""
                    if (!resp.isSuccessful) error("HTTP ${resp.code}")
                    JSONObject(text)
                }
            }
        }

    private suspend fun post(pair: PairInfo, path: String, body: JSONObject): Result<JSONObject> =
        withContext(Dispatchers.IO) {
            runCatching {
                val req = Request.Builder()
                    .url(authedUrl(pair, path))
                    .post(body.toString().toRequestBody(jsonMedia))
                    .build()
                client.newCall(req).execute().use { resp ->
                    val text = resp.body?.string() ?: ""
                    if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(120)}")
                    JSONObject(text)
                }
            }
        }

    /** 验证配对并获取桌面端基本信息 */
    suspend fun hello(pair: PairInfo): Result<JSONObject> = get(pair, "/api/mobile/hello")

    /** 确认配对窗口（扫码后调用；token 鉴权 + pairingId 确认，桌面端随即关闭二维码） */
    suspend fun confirm(invite: PairInvite): Result<JSONObject> =
        withContext(Dispatchers.IO) {
            runCatching {
                val url = "http://${invite.host}:${invite.port}/api/mobile/pair-confirm?token=${invite.token}"
                val body = JSONObject().apply { put("pairingId", invite.pairingId) }
                val req = Request.Builder()
                    .url(url)
                    .post(body.toString().toRequestBody(jsonMedia))
                    .build()
                client.newCall(req).execute().use { resp ->
                    val text = resp.body?.string() ?: ""
                    if (!resp.isSuccessful) error("HTTP ${resp.code}: ${text.take(120)}")
                    JSONObject(text)
                }
            }
        }

    /** 桌面端状态（对话列表 + 当前对话消息 + 模式/模型） */
    suspend fun state(pair: PairInfo): Result<JSONObject> = get(pair, "/api/mobile/state")

    /** 某个对话的快照 */
    suspend fun conversation(pair: PairInfo, conversationId: String?): Result<JSONObject> {
        val suffix = conversationId?.let { "&conversationId=$it" } ?: ""
        return get(pair, "/api/mobile/conversation?window=200$suffix")
    }

    /** 向桌面端 Agent 发送消息（同步等待完成） */
    suspend fun send(pair: PairInfo, message: String, conversationId: String?): Result<JSONObject> {
        val body = JSONObject().apply {
            put("message", message)
            conversationId?.let { put("conversationId", it) }
        }
        return post(pair, "/api/mobile/send", body)
    }
}
