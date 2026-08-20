package com.newmark.mobile.data

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.io.File

/** 当前激活的供应商/模型/智能档位（本地 agent 实际调用所用） */
data class ActiveModel(
    val providerId: String = "",
    val modelName: String = "",
    val intelligence: String = "medium", // low | medium | high
)

/**
 * 供应商持久化：filesDir/newmark/providers.json（List<ProviderConfig>）。
 * 纯净安装首次启动写入空列表；激活选择存 filesDir/newmark/active-model.json。
 */
class ProviderStore(context: Context) {

    private val gson = Gson()
    private val dir = File(context.filesDir, "newmark")
    private val file = File(dir, "providers.json")
    private val activeFile = File(dir, "active-model.json")

    fun load(): List<ProviderConfig> {
        if (!file.exists()) {
            save(emptyList())
            return emptyList()
        }
        return runCatching {
            val type = object : TypeToken<List<ProviderConfig>>() {}.type
            gson.fromJson<List<ProviderConfig>>(file.readText(), type) ?: emptyList()
        }.getOrDefault(emptyList())
    }

    fun save(list: List<ProviderConfig>) {
        runCatching {
            dir.mkdirs()
            file.writeText(gson.toJson(list))
        }
    }

    fun loadActive(): ActiveModel {
        if (!activeFile.exists()) return ActiveModel()
        return runCatching {
            gson.fromJson(activeFile.readText(), ActiveModel::class.java) ?: ActiveModel()
        }.getOrDefault(ActiveModel())
    }

    fun saveActive(selection: ActiveModel) {
        runCatching {
            dir.mkdirs()
            activeFile.writeText(gson.toJson(selection))
        }
    }
}
