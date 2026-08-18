package com.newmark.mobile.data

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.io.File

/** 本地对话持久化：filesDir/newmark/conversations.json（活跃）；归档移入 archived.json 保留数据 */
class ConversationStore(context: Context) {

    private val gson = Gson()
    private val dir = File(context.filesDir, "newmark")
    private val file = File(dir, "conversations.json")
    private val archivedFile = File(dir, "archived.json")

    fun load(): List<LocalConversation> {
        if (!file.exists()) return emptyList()
        return runCatching {
            val type = object : TypeToken<List<LocalConversation>>() {}.type
            gson.fromJson<List<LocalConversation>>(file.readText(), type) ?: emptyList()
        }.getOrDefault(emptyList())
    }

    fun save(conversations: List<LocalConversation>) {
        runCatching {
            dir.mkdirs()
            file.writeText(gson.toJson(conversations))
        }
    }

    fun loadArchived(): List<LocalConversation> {
        if (!archivedFile.exists()) return emptyList()
        return runCatching {
            val type = object : TypeToken<List<LocalConversation>>() {}.type
            gson.fromJson<List<LocalConversation>>(archivedFile.readText(), type) ?: emptyList()
        }.getOrDefault(emptyList())
    }

    fun saveArchived(conversations: List<LocalConversation>) {
        runCatching {
            dir.mkdirs()
            archivedFile.writeText(gson.toJson(conversations))
        }
    }
}
