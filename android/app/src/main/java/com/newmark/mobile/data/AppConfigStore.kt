package com.newmark.mobile.data

import android.content.Context
import com.google.gson.Gson
import java.io.File

/** OpenAI 兼容端点的 API 配置 */
data class ApiConfig(
    val baseUrl: String = "",
    val apiKey: String = "",
    val model: String = "",
) {
    val isReady: Boolean get() = baseUrl.isNotBlank() && apiKey.isNotBlank() && model.isNotBlank()
}

/** API 配置持久化：filesDir/newmark/config.json */
class AppConfigStore(context: Context) {

    private val gson = Gson()
    private val dir = File(context.filesDir, "newmark")
    private val file = File(dir, "config.json")

    fun load(): ApiConfig {
        if (!file.exists()) return ApiConfig()
        return runCatching {
            gson.fromJson(file.readText(), ApiConfig::class.java) ?: ApiConfig()
        }.getOrDefault(ApiConfig())
    }

    fun save(config: ApiConfig) {
        runCatching {
            dir.mkdirs()
            file.writeText(gson.toJson(config))
        }
    }
}
