package com.newmark.mobile.data

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Dns
import java.net.Inet4Address
import java.net.InetAddress

/** 本地工具执行结果 */
data class ToolResult(val ok: Boolean, val output: String) {
    companion object {
        fun ok(output: String) = ToolResult(true, output)
        fun err(output: String) = ToolResult(false, output)
    }
}

/**
 * 本地工具执行器：在 Android 安全目录（filesDir/newmark/workspace）内执行
 * 文件/记忆/搜索等工具命令。命令行与本地对话 Agent 复用同一套工具。
 */
class LocalToolExecutor(
    context: Context,
    private val runtimeTool: (suspend (String, JSONObject) -> ToolResult?)? = null,
) {

    private val appContext = context.applicationContext
    private val root = File(appContext.filesDir, "newmark/workspace").apply { mkdirs() }
    private val memoryLab = MemoryLabStore(appContext)
    private val providerStore = ProviderStore(appContext)
    private val gson = Gson()
    private val ipv4FirstDns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> =
            InetAddress.getAllByName(hostname).toList().sortedBy { if (it is Inet4Address) 0 else 1 }
    }
    private val webClient = OkHttpClient.Builder()
        .dns(ipv4FirstDns)
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()
    private var cwd = root

    /** Agent 工具调用入口（OpenAI function calling）：按 name + JSON 参数执行 */
    suspend fun executeTool(name: String, arguments: String): ToolResult {
        val args = runCatching { JSONObject(arguments) }.getOrDefault(JSONObject())
        runtimeTool?.invoke(name, args)?.let { return it }
        return runCatching {
            when (name) {
                "read_file" -> readFile(args.optString("path"))
                "write_file" -> writeFileArgs(args.optString("path"), args.optString("content"))
                "list_dir" -> ls(args.optString("path"))
                "memory_lab_read" -> mlRead(args.optString("component"))
                "memory_lab_query" -> mlQuery(args.optString("query"))
                "memory_lab_update" -> mlUpdateArgs(args.optString("name"), args.optString("tags"), args.optString("content"))
                "memory_lab_reindex" -> mlReindex()
                "settings_read" -> settingsRead()
                "settings_update" -> settingsUpdate(args.optString("json"))
                "web_search" -> webSearch(args.optString("query"))
                "web_fetch" -> webFetch(args.optString("url"))
                else -> ToolResult.err("未知工具：$name")
            }
        }.getOrElse { ToolResult.err("工具执行失败：${it.message ?: it.toString()}") }
    }

    private fun normalizedWebUrl(raw: String): String? {
        val uri = runCatching { URI(raw.trim()) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() !in setOf("http", "https") || uri.host.isNullOrBlank()) return null
        return uri.toASCIIString()
    }

    private fun fetch(url: String): String {
        val request = Request.Builder().url(url).header("User-Agent", "NewmarkMobile/1.0").build()
        return webClient.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) error("HTTP ${response.code}: ${body.take(200)}")
            body
        }
    }

    private fun readableText(html: String, limit: Int = 12_000): String = html
        .replace(Regex("(?is)<script[^>]*>.*?</script>"), " ")
        .replace(Regex("(?is)<style[^>]*>.*?</style>"), " ")
        .replace(Regex("(?is)<head[^>]*>.*?</head>"), " ")
        .replace(Regex("(?s)<[^>]+>"), " ")
        .replace("&amp;", "&").replace("&quot;", "\"").replace("&#x27;", "'")
        .replace("&lt;", "<").replace("&gt;", ">")
        .replace(Regex("\\s+"), " ").trim().let { if (it.length > limit) it.take(limit) + "\n…（截断）" else it }

    private fun webFetch(raw: String): ToolResult {
        val url = normalizedWebUrl(raw) ?: return ToolResult.err("仅支持带有效主机名的 http:// 或 https:// 网页地址")
        return runCatching { readableText(fetch(url)) }
            .fold({ ToolResult.ok(it.ifBlank { "网页没有可提取正文。" }) }, { ToolResult.err("[web_fetch] ${it.message ?: it}") })
    }

    private fun webSearch(query: String): ToolResult {
        if (query.isBlank()) return ToolResult.err("需要 query")
        val encoded = java.net.URLEncoder.encode(query, Charsets.UTF_8.name())
        val errors = mutableListOf<String>()
        runCatching {
            val html = fetch("https://html.duckduckgo.com/html/?q=$encoded")
            val blocks = Regex("(?is)<a[^>]+class=\"result__a\"[^>]+href=\"([^\"]+)\"[^>]*>(.*?)</a>[\\s\\S]*?class=\"result__snippet\"[^>]*>(.*?)</(?:a|div)>")
                .findAll(html).take(8).map { match ->
                    val title = readableText(match.groupValues[2], 500)
                    val snippet = readableText(match.groupValues[3], 800)
                    "$title\n${match.groupValues[1]}\n$snippet"
                }.toList()
            if (blocks.isNotEmpty()) return ToolResult.ok(blocks.joinToString("\n\n"))
            errors += "DuckDuckGo 无可解析结果"
        }.onFailure { errors += "DuckDuckGo: ${it.message ?: it}" }
        runCatching {
            val html = fetch("https://www.bing.com/search?q=$encoded")
            val blocks = Regex("(?is)<li class=\"b_algo\".*?</li>").findAll(html).take(8).mapNotNull { block ->
                val title = Regex("(?is)<h2[^>]*>\\s*<a[^>]+href=\"([^\"]+)\"[^>]*>(.*?)</a>").find(block.value)
                    ?: return@mapNotNull null
                val snippet = Regex("(?is)<p[^>]*>(.*?)</p>").find(block.value)?.groupValues?.get(1).orEmpty()
                "${readableText(title.groupValues[2], 500)}\n${title.groupValues[1]}\n${readableText(snippet, 800)}".trim()
            }.toList()
            if (blocks.isNotEmpty()) return ToolResult.ok(blocks.joinToString("\n\n"))
            errors += "Bing 无可解析结果"
        }.onFailure { errors += "Bing: ${it.message ?: it}" }
        return ToolResult.err("[web_search] No results. ${errors.joinToString("; ")}")
    }

    private fun writeFileArgs(path: String, content: String): ToolResult {
        if (path.isBlank()) return ToolResult.err("需要 path")
        val f = resolve(path)
        f.parentFile?.mkdirs()
        f.writeText(content)
        return ToolResult.ok("已写入 ${f.absolutePath}（${content.length} 字符）")
    }

    private fun mlUpdateArgs(name: String, tags: String, content: String): ToolResult {
        val tagList = tags.split(Regex("[,，]")).map { it.trim() }.filter { it.isNotEmpty() }
            .map { if (it.startsWith("#")) it else "#$it" }
        val slug = slugify(name)
        val now = java.time.Instant.now().toString()
        val index = memoryLab.load()
        val meta = MemoryComponent(
            name = name,
            tags = tagList,
            tagPaths = tagList.map { listOf(it) },
            path = "${memoryLab.componentsDir.absolutePath}/$slug.md",
            coreMd = "${memoryLab.componentsDir.absolutePath}/$slug.md",
            kind = "file",
            createdAt = index.components[slug]?.createdAt ?: now,
            updatedAt = now,
            revision = (index.components[slug]?.revision ?: 0) + 1,
        )
        val newIndex = index.copy(components = index.components + (slug to meta))
        memoryLab.save(newIndex)
        File(meta.coreMd).apply { parentFile?.mkdirs() }.writeText(content)
        return ToolResult.ok("已写入记忆组件 $slug")
    }

    val cwdPath: String get() = cwd.absolutePath

    /** 从持久化会话恢复工作目录（参考 tmux session 保留 cwd） */
    fun restoreCwd(path: String) {
        if (path.isBlank()) return
        runCatching {
            val f = File(path).canonicalFile
            if (f.isDirectory && f.path.startsWith(root.canonicalFile.path)) cwd = f
        }
    }

    /** 解析并执行一行命令（命令行入口，也供 Agent 工具调用复用） */
    fun execute(line: String): ToolResult {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) return ToolResult.ok("")
        val parts = trimmed.split(Regex("\\s+"), limit = 2)
        val cmd = parts[0].lowercase()
        val arg = parts.getOrNull(1)?.trim() ?: ""
        return runCatching {
            when (cmd) {
                "pwd" -> ToolResult.ok(cwd.absolutePath)
                "ls", "dir" -> ls(arg)
                "cd" -> cd(arg)
                "read", "cat" -> readFile(arg)
                "write" -> writeFile(arg)
                "edit" -> editFile(arg)
                "memory_lab_read", "ml-read" -> mlRead(arg)
                "memory_lab_query", "ml-query" -> mlQuery(arg)
                "memory_lab_update", "ml-update" -> mlUpdate(arg)
                "memory_lab_reindex", "ml-reindex" -> mlReindex()
                "settings_read", "settings-read" -> settingsRead()
                "settings_update", "settings-update" -> settingsUpdate(arg)
                "state" -> state()
                "help" -> help()
                else -> ToolResult.err("未知命令：$cmd（输入 help 查看可用命令）")
            }
        }.getOrElse { ToolResult.err("执行失败：${it.message ?: it.toString()}") }
    }

    private fun resolve(p: String): File {
        val f = File(p)
        val target = if (f.isAbsolute) f else File(cwd, p)
        val canonical = target.canonicalFile
        val rootCanonical = root.canonicalFile
        if (!canonical.path.startsWith(rootCanonical.path + File.separator) && canonical != rootCanonical) {
            throw SecurityException("路径越出安全目录：$p")
        }
        return canonical
    }

    private fun ls(arg: String): ToolResult {
        val dir = if (arg.isBlank()) cwd else resolve(arg)
        if (!dir.exists()) return ToolResult.err("不存在：${dir.absolutePath}")
        if (!dir.isDirectory) return ToolResult.err("不是目录：${dir.absolutePath}")
        val entries = dir.listFiles()?.sortedBy { it.name } ?: emptyList()
        val out = entries.joinToString("\n") { f ->
            (if (f.isDirectory) "[d] " else "    ") + f.name
        }.ifBlank { "（空目录）" }
        return ToolResult.ok(out)
    }

    private fun cd(arg: String): ToolResult {
        val dir = if (arg.isBlank()) root else resolve(arg)
        if (!dir.exists() || !dir.isDirectory) return ToolResult.err("目录不存在：${dir.absolutePath}")
        cwd = dir
        return ToolResult.ok(cwd.absolutePath)
    }

    private fun readFile(arg: String): ToolResult {
        val f = resolve(arg)
        if (!f.exists()) return ToolResult.err("文件不存在：${f.absolutePath}")
        if (f.isDirectory) return ToolResult.err("是目录：${f.absolutePath}")
        val text = f.readText()
        val bounded = if (text.length > 48_000) text.take(48_000) + "\n…（截断）" else text
        return ToolResult.ok(bounded)
    }

    private fun writeFile(arg: String): ToolResult {
        val idx = arg.indexOf(' ')
        if (idx < 0) return ToolResult.err("用法：write <路径> <内容>")
        val path = arg.substring(0, idx).trim()
        val content = arg.substring(idx + 1)
        val f = resolve(path)
        f.parentFile?.mkdirs()
        f.writeText(content)
        return ToolResult.ok("已写入 ${f.absolutePath}（${content.length} 字符）")
    }

    private fun editFile(arg: String): ToolResult {
        val parts = arg.split(Regex("\\s+"), limit = 3)
        if (parts.size < 3) return ToolResult.err("用法：edit <路径> <旧文本> <新文本>")
        val f = resolve(parts[0])
        if (!f.exists()) return ToolResult.err("文件不存在：${f.absolutePath}")
        val text = f.readText()
        val count = text.split(parts[1]).size - 1
        val updated = text.replace(parts[1], parts[2])
        f.writeText(updated)
        return ToolResult.ok("已替换 $count 处，写入 ${f.absolutePath}")
    }

    private fun mlRead(arg: String): ToolResult {
        val index = memoryLab.load()
        if (arg.isNotBlank()) {
            val slug = arg.trim()
            val meta = index.components[slug]
            if (meta == null) return ToolResult.err("记忆组件不存在：$slug")
            val content = memoryLab.componentContent(slug)
            return ToolResult.ok("${meta.name}（${slug}）\n${meta.description}\n---\n$content")
        }
        if (index.components.isEmpty()) return ToolResult.ok("暂无记忆组件。")
        val out = index.components.entries.joinToString("\n") { (slug, c) -> "$slug  ${c.name}  ${c.tags.joinToString(",")}" }
        return ToolResult.ok("标签：${index.tags.keys.joinToString(", ")}\n组件：\n$out")
    }

    private fun mlQuery(arg: String): ToolResult {
        if (arg.isBlank()) return ToolResult.err("用法：memory_lab_query <关键词>")
        val needle = arg.lowercase()
        val index = memoryLab.load()
        val hits = index.components.filter { (slug, c) ->
            slug.contains(needle) || c.name.lowercase().contains(needle) ||
                c.tags.any { it.lowercase().contains(needle) }
        }
        if (hits.isEmpty()) return ToolResult.ok("无匹配。")
        return ToolResult.ok(hits.entries.joinToString("\n") { (slug, c) -> "$slug  ${c.name}" })
    }

    private fun mlUpdate(arg: String): ToolResult {
        if (arg.isBlank()) return ToolResult.err("用法：memory_lab_update <name> <tags(逗号分隔)> <content>")
        val parts = arg.split(Regex("\\s+"), limit = 3)
        if (parts.size < 3) return ToolResult.err("用法：memory_lab_update <name> <tags> <content>")
        val name = parts[0]
        val tags = parts[1].split(Regex("[,，]")).map { it.trim() }.filter { it.isNotEmpty() }
            .map { if (it.startsWith("#")) it else "#$it" }
        val content = parts[2]
        val slug = slugify(name)
        val now = java.time.Instant.now().toString()
        val index = memoryLab.load()
        val meta = MemoryComponent(
            name = name,
            tags = tags,
            tagPaths = tags.map { listOf(it) },
            path = "${memoryLab.componentsDir.absolutePath}/$slug.md",
            coreMd = "${memoryLab.componentsDir.absolutePath}/$slug.md",
            kind = "file",
            createdAt = index.components[slug]?.createdAt ?: now,
            updatedAt = now,
            revision = (index.components[slug]?.revision ?: 0) + 1,
        )
        val newIndex = index.copy(components = index.components + (slug to meta))
        memoryLab.save(newIndex)
        File(meta.coreMd).apply { parentFile?.mkdirs() }.writeText(content)
        return ToolResult.ok("已写入记忆组件 $slug")
    }

    private fun mlReindex(): ToolResult {
        val index = memoryLab.reindex()
        return ToolResult.ok("重建索引完成：${index.tags.size} 标签 / ${index.components.size} 组件")
    }

    // ---- 设置（providers.json + active-model.json，对齐 PC config.json 可被 Agent 编辑） ----

    /** 读取全部设置 JSON：providers 数组 + active 激活选择 */
    private fun settingsRead(): ToolResult {
        val providers = providerStore.load()
        val active = providerStore.loadActive()
        val json = JSONObject()
            .put("providers", JSONArray(gson.toJson(providers)))
            .put("active", JSONObject()
                .put("provider_id", active.providerId)
                .put("model_name", active.modelName)
                .put("intelligence", active.intelligence))
        return ToolResult.ok(json.toString(2))
    }

    /** 以 JSON 更新设置：providers 数组与/或 active 激活选择，改动立即落盘 */
    private fun settingsUpdate(raw: String): ToolResult {
        if (raw.isBlank()) return ToolResult.err("需要 json 参数")
        val json = runCatching { JSONObject(raw) }.getOrNull()
            ?: return ToolResult.err("json 参数不是合法 JSON 对象")
        val changes = mutableListOf<String>()

        if (json.has("providers")) {
            val arr = json.opt("providers") ?: return ToolResult.err("providers 必须是数组")
            val type = object : TypeToken<List<ProviderConfig>>() {}.type
            val providers = runCatching { gson.fromJson<List<ProviderConfig>>(arr.toString(), type) }
                .getOrNull()
            if (providers == null) return ToolResult.err("providers 解析失败：需为 ProviderConfig 数组（snake_case 字段）")
            val cleaned = providers.filter { it.id.isNotBlank() || it.name.isNotBlank() }
            providerStore.save(cleaned)
            changes += "providers(${cleaned.size})"
        }

        if (json.has("active")) {
            val a = json.optJSONObject("active") ?: return ToolResult.err("active 必须是对象")
            val intelligence = a.optString("intelligence", "medium")
            val active = ActiveModel(
                providerId = a.optString("provider_id", a.optString("providerId", "")),
                modelName = a.optString("model_name", a.optString("modelName", "")),
                intelligence = if (intelligence in setOf("low", "medium", "high")) intelligence else "medium",
            )
            providerStore.saveActive(active)
            changes += "active(${active.providerId}/${active.modelName}/${active.intelligence})"
        }

        if (changes.isEmpty()) return ToolResult.err("json 至少需包含 providers 或 active 之一")
        return ToolResult.ok("设置已更新：${changes.joinToString("，")}")
    }

    private fun state(): ToolResult {
        val workspaceFiles = root.walkTopDown().count { it.isFile }
        val index = memoryLab.load()
        return ToolResult.ok(
            buildString {
                appendLine("cwd: ${cwd.absolutePath}")
                appendLine("workspace 文件数: $workspaceFiles")
                appendLine("Memory Lab: ${index.tags.size} 标签 / ${index.components.size} 组件")
            }.trim(),
        )
    }

    private fun help(): ToolResult = ToolResult.ok(
        """
        可用命令：
        pwd / ls [路径] / cd <路径>
        read <路径> / write <路径> <内容> / edit <路径> <旧> <新>
        memory_lab_read [组件] / memory_lab_query <关键词>
        memory_lab_update <名称> <tags> <内容> / memory_lab_reindex
        settings_read / settings_update <JSON 设置字符串>
        state / help
        """.trimIndent(),
    )

    private fun slugify(name: String): String =
        name.trim().lowercase()
            .replace(Regex("[<>:\"/\\\\|?*\\x00-\\x1F]"), "-")
            .replace(Regex("\\s+"), "-")
            .replace(Regex("[^a-z0-9_.\\-\\u4e00-\\u9fff]+"), "-")
            .replace(Regex("-+"), "-")
            .replace(Regex("^-+|-+$"), "")
            .ifBlank { "memory" }
            .take(120)
}
