package com.newmark.mobile.data

import android.content.Context
import com.google.gson.Gson
import java.io.File

/** 终端一行记录 */
data class TerminalEntry(
    val command: String,
    val output: String,
    val ok: Boolean,
    val time: Long = System.currentTimeMillis(),
)

/** 终端会话（参考 tmux session：持久化 cwd + 命令/输出历史，退出后仍在） */
data class TerminalSession(
    val name: String = "main",
    val cwd: String = "",
    val entries: List<TerminalEntry> = emptyList(),
)

/** 终端会话持久化：filesDir/newmark/terminal/sessions.json */
class TerminalSessionStore(context: Context) {

    private val gson = Gson()
    private val dir = File(context.filesDir, "newmark/terminal").apply { mkdirs() }
    private val file = File(dir, "sessions.json")

    fun load(name: String = "main"): TerminalSession {
        if (!file.exists()) return TerminalSession(name = name)
        return runCatching {
            val type = object : com.google.gson.reflect.TypeToken<Map<String, TerminalSession>>() {}.type
            val map = gson.fromJson<Map<String, TerminalSession>>(file.readText(), type) ?: emptyMap()
            map[name] ?: TerminalSession(name = name)
        }.getOrDefault(TerminalSession(name = name))
    }

    fun save(session: TerminalSession) {
        runCatching {
            dir.mkdirs()
            val type = object : com.google.gson.reflect.TypeToken<Map<String, TerminalSession>>() {}.type
            val map = if (file.exists()) {
                gson.fromJson<Map<String, TerminalSession>>(file.readText(), type) ?: emptyMap()
            } else emptyMap()
            map.toMutableMap()[session.name] = session
            file.writeText(gson.toJson(map))
        }
    }

    fun list(): List<String> {
        if (!file.exists()) return emptyList()
        return runCatching {
            val type = object : com.google.gson.reflect.TypeToken<Map<String, TerminalSession>>() {}.type
            val map = gson.fromJson<Map<String, TerminalSession>>(file.readText(), type) ?: emptyMap()
            map.keys.sorted()
        }.getOrDefault(emptyList())
    }
}
