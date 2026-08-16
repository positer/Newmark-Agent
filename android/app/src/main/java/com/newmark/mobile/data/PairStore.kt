package com.newmark.mobile.data

import android.content.Context
import com.google.gson.Gson
import java.io.File

/** 配对信息持久化：filesDir/newmark/pair.json（扫码绑定一次保存） */
class PairStore(context: Context) {

    private val gson = Gson()
    private val dir = File(context.filesDir, "newmark")
    private val file = File(dir, "pair.json")

    fun load(): PairInfo? {
        if (!file.exists()) return null
        return runCatching {
            gson.fromJson(file.readText(), PairInfo::class.java)
        }.getOrNull()
    }

    fun save(pair: PairInfo) {
        runCatching {
            dir.mkdirs()
            file.writeText(gson.toJson(pair))
        }
    }

    fun clear() {
        runCatching { file.delete() }
    }
}
