package com.newmark.mobile.data

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.io.File

/** 配对设备持久化：filesDir/newmark/pairs.json（多设备，扫码绑定一次保存） */
class PairStore(context: Context) {

    private val gson = Gson()
    private val dir = File(context.filesDir, "newmark")
    private val file = File(dir, "pairs.json")
    private val legacyFile = File(dir, "pair.json")

    fun loadAll(): List<PairInfo> {
        // 兼容旧的单设备 pair.json
        if (!file.exists() && legacyFile.exists()) {
            return runCatching {
                val p = gson.fromJson(legacyFile.readText(), PairInfo::class.java)
                if (p != null && p.isValid()) listOf(p) else emptyList()
            }.getOrDefault(emptyList())
        }
        if (!file.exists()) return emptyList()
        return runCatching {
            val type = object : TypeToken<List<PairInfo>>() {}.type
            gson.fromJson<List<PairInfo>>(file.readText(), type) ?: emptyList()
        }.getOrDefault(emptyList())
    }

    fun saveAll(list: List<PairInfo>) {
        runCatching {
            dir.mkdirs()
            file.writeText(gson.toJson(list))
            legacyFile.delete()
        }
    }

    /** 新增/更新设备（名称+IP 去重整合），返回更新后的列表 */
    fun add(pair: PairInfo): List<PairInfo> {
        val list = loadAll().toMutableList()
        val idx = list.indexOfFirst { it.dedupeKey == pair.dedupeKey }
        if (idx >= 0) list[idx] = pair else list.add(pair)
        saveAll(list)
        return list
    }

    /** 删除设备，返回更新后的列表 */
    fun remove(host: String): List<PairInfo> {
        val list = loadAll().filter { it.host != host }
        saveAll(list)
        return list
    }
}
