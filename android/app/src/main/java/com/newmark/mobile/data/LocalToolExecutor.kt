package com.newmark.mobile.data

import android.content.Context
import android.content.ContentResolver
import android.net.Uri
import android.provider.MediaStore
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.os.CancellationSignal
import com.google.gson.Gson
import com.google.gson.JsonParser
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
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import android.os.Build
import android.os.SystemClock
import android.util.Base64

private fun JSONArray.toStringListForMemory(): List<String> =
    (0 until length()).map { optString(it) }.filter(String::isNotBlank)

internal fun parseToolArgumentsObject(arguments: String): Result<JSONObject> = runCatching {
    val parsed = JsonParser.parseString(arguments)
    require(parsed.isJsonObject) { "tool arguments must be one JSON object" }
    JSONObject(parsed.toString())
}

/** Accept dev-0.5.9 structured arguments and the dev-0.5.8 string envelope. */
internal fun settingsUpdatePayload(arguments: JSONObject): Result<String> = runCatching {
    if (listOf("providers", "active", "action", "provider", "model", "provider_id", "model_name").any(arguments::has)) {
        return@runCatching arguments.toString()
    }
    when (val legacy = arguments.opt("json")) {
        is JSONObject -> legacy.toString()
        is String -> legacy.takeIf(String::isNotBlank) ?: error("settings_update 至少需要 providers 或 active")
        else -> error("settings_update 至少需要 providers 或 active")
    }
}

internal fun normalizedMobileIntelligence(value: String): String =
    value.takeIf { it in INTELLIGENCE_TIERS } ?: "medium"

internal fun sha256Text(value: String): String =
    MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

internal fun applyTextMutation(existing: String, args: JSONObject): Result<String> = runCatching {
    args.optString("expected_sha256").takeIf(String::isNotBlank)?.let { expected ->
        val actual = sha256Text(existing)
        require(expected.equals(actual, ignoreCase = true)) { "target changed since it was read" }
    }
    when (args.optString("action").ifBlank { "overwrite" }) {
        "overwrite", "write" -> {
            require(args.has("content")) { "overwrite requires content" }
            args.optString("content")
        }
        "append" -> {
            require(args.has("content")) { "append requires content" }
            existing + args.optString("content")
        }
        "replace" -> {
            val oldText = args.optString("old_text")
            require(oldText.isNotEmpty()) { "replace requires old_text" }
            val count = existing.windowed(oldText.length, 1).count { it == oldText }
            require(count > 0) { "old_text not found" }
            require(count == 1 || args.optBoolean("replace_all")) { "old_text matched $count places; pass replace_all=true or a unique fragment" }
            if (args.optBoolean("replace_all")) existing.replace(oldText, args.optString("new_text"))
            else existing.replaceFirst(oldText, args.optString("new_text"))
        }
        else -> error("action must be overwrite|append|replace")
    }
}

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
    private val capabilities = MobileCapabilityStore(appContext)
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
    private val richDocuments = RichDocumentReader(appContext) { images, prompt ->
        val args = JSONObject().put("prompt", prompt).put("images", JSONArray(images.map { image ->
            JSONObject().put("name", image.name).put("mime_type", image.mimeType).put("data_url", image.dataUrl)
        }))
        runtimeTool?.invoke("__document_visual_read", args)?.takeIf { it.ok }?.output
    }

    /** Agent 工具调用入口（OpenAI function calling）：按 name + JSON 参数执行 */
    suspend fun executeTool(name: String, arguments: String, mode: String = "build"): ToolResult {
        val args = parseToolArgumentsObject(arguments).getOrElse {
            return ToolResult.err(
                "工具参数不是合法 JSON 对象；请按当前工具 schema 重新调用。" +
                    "解析错误：${it.message ?: "unknown"}；收到：${arguments.take(240)}",
            )
        }
        if (mode.equals("chat", ignoreCase = true) && name !in LocalToolCatalog.chatNames) {
            return ToolResult.err("[permission] Chat 模式仅允许 web_search 与 web_fetch；拒绝工作区、系统、应用、记忆、任务及其他写入或操作权限。已阻断：$name")
        }
        if (name in LocalToolCatalog.privilegedNames && !capabilities.highPrivilegeActive()) {
            return ToolResult.err("高权限模式未开启或 Root/Shizuku 未授权，已阻断高权限工具")
        }
        if (name in LocalToolCatalog.shizukuNames && !capabilities.shizukuActive()) return ToolResult.err("Shizuku 边界未授权或高权限模式已关闭")
        if (name in LocalToolCatalog.rootNames && !capabilities.rootActive()) return ToolResult.err("Root 边界不可用或高权限模式已关闭")
        if (name in LocalToolCatalog.externalFileNames && !capabilities.externalFilesEnabled()) return ToolResult.err("请先在应用内开启读取所有文件；关闭时仅允许内部安全目录工具")
        if (name in LocalToolCatalog.allFilesNames && !capabilities.allFilesGranted()) return ToolResult.err("请先在应用内开启读取所有文件并完成系统授权")
        if (name in LocalToolCatalog.appListNames && !capabilities.appListGranted()) return ToolResult.err("请先在应用内开启读取应用列表并完成系统授权")
        runtimeTool?.invoke(name, args)?.let { return it }
        return runCatching {
            when (name) {
                "read_file" -> readFile(args.optString("path"))
                "write_file" -> writeFileArgs(args)
                "list_dir" -> ls(args.optString("path"))
                "recent_files" -> recentFiles(args)
                "terminal_exec" -> terminalExec(args.optString("command"))
                "memory_lab_read" -> mlRead(args.optString("component"))
                "memory_lab_query" -> mlQuery(args.optString("query"))
                "memory_lab_update" -> mlUpdateArgs(args)
                "memory_lab_delete" -> mlDeleteArgs(args)
                "memory_lab_reindex" -> mlReindex()
                "settings_read" -> settingsRead()
                "settings_update" -> settingsUpdate(settingsUpdatePayload(args).getOrElse {
                    return ToolResult.err(it.message ?: "settings_update 参数格式错误")
                })
                "web_search" -> webSearch(args.optString("query"))
                "web_fetch" -> webFetch(args.optString("url"))
                "files_read_all" -> readSharedFile(args.optString("path"))
                "apps_list" -> listApps()
                "files_manage" -> manageSharedFile(args)
                "apps_inspect" -> inspectApps(args.optString("package_name"))
                "skills_list", "mcp_list" -> pluginList(name.removeSuffix("_list"))
                "shizuku_exec", "adb_exec" -> PrivilegedToolBridge.executeShizuku(args.optString("command"))
                "root_exec" -> PrivilegedToolBridge.executeRoot(args.optString("command"))
                else -> ToolResult.err("未知工具：$name")
            }
        }.getOrElse { ToolResult.err("工具执行失败：${it.message ?: it.toString()}") }
    }

    private fun normalizedWebUrl(raw: String): String? {
        val uri = runCatching { URI(raw.trim()) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() !in setOf("http", "https") || uri.host.isNullOrBlank()) return null
        return uri.toASCIIString()
    }

    private fun terminalExec(command: String): ToolResult {
        if (command.isBlank()) return ToolResult.err("terminal_exec 需要 command")
        return execute(command)
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

    private fun writeFileArgs(args: JSONObject): ToolResult {
        val path = args.optString("path")
        if (path.isBlank()) return ToolResult.err("需要 path")
        val f = resolve(path)
        val existing = if (f.exists()) f.readText() else ""
        val content = applyTextMutation(existing, args).getOrElse { return ToolResult.err("文件更新失败：${it.message}") }
        f.parentFile?.mkdirs()
        f.writeText(content)
        return ToolResult.ok("已写入 ${f.absolutePath}（${content.length} 字符）")
    }

    private fun mlUpdateArgs(args: JSONObject): ToolResult {
        val component = args.optString("component")
        if (component.isNotBlank()) {
            val patchFields = setOf("name", "description", "tags", "tag_paths", "content", "content_append", "old_text", "kind")
            if (patchFields.none(args::has)) return ToolResult.err("局部更新至少需要一个要修改的字段")
            fun optionalTags(key: String): List<String>? = if (args.has(key)) {
                args.optString(key).split(Regex("[,，]")).map(String::trim).filter(String::isNotEmpty)
                    .map { if (it.startsWith("#")) it else "#$it" }
            } else null
            val parsedPaths = if (args.has("tag_paths")) runCatching {
                val arr = JSONArray(args.optString("tag_paths", "[]"))
                (0 until arr.length()).map { i -> arr.getJSONArray(i).toStringListForMemory() }
            }.getOrElse { return ToolResult.err("tag_paths 必须是 JSON 路径数组") } else null
            val result = runCatching { memoryLab.patch(MemoryLabPatchInput(
                component = component,
                name = args.optString("name").takeIf { args.has("name") },
                description = args.optString("description").takeIf { args.has("description") },
                tags = optionalTags("tags"),
                tagPaths = parsedPaths,
                content = args.optString("content").takeIf { args.has("content") },
                contentAppend = args.optString("content_append").takeIf { args.has("content_append") },
                oldText = args.optString("old_text").takeIf { args.has("old_text") },
                newText = args.optString("new_text"),
                replaceAll = args.optBoolean("replace_all"),
                kind = args.optString("kind").takeIf { args.has("kind") },
                expectedUpdatedAt = args.optString("expected_updated_at"),
                reason = args.optString("reason"),
                source = args.optString("source", "memory_lab_update"),
            )) }.getOrElse { return ToolResult.err(it.message ?: "Memory Lab patch 失败") }
            return ToolResult.ok(JSONObject().put("ok", true).put("slug", result.slug).put("component", result.component?.name)
                .put("rebuildReceipt", result.rebuildReceipt).toString(2))
        }
        val name = args.optString("name")
        val tags = args.optString("tags")
        val content = args.optString("content")
        val tagList = tags.split(Regex("[,，]")).map { it.trim() }.filter { it.isNotEmpty() }
            .map { if (it.startsWith("#")) it else "#$it" }
        val paths = runCatching {
            val arr = JSONArray(args.optString("tag_paths", "[]"))
            (0 until arr.length()).map { i -> arr.getJSONArray(i).toStringListForMemory() }
        }.getOrDefault(emptyList())
        if (name.isBlank() || tagList.isEmpty() || content.isBlank()) return ToolResult.err("新建组件需要 name、tags、content；局部更新请传 component")
        val result = memoryLab.update(MemoryLabUpdateInput(
            name = name, description = args.optString("description"), tags = tagList,
            tagPaths = paths, content = content, kind = args.optString("kind", "file"),
            expectedUpdatedAt = args.optString("expected_updated_at"), reason = args.optString("reason"),
            source = args.optString("source", "memory_lab_update"),
        ))
        return ToolResult.ok(JSONObject().put("ok", true).put("slug", result.slug).put("component", result.component?.name)
            .put("rebuildReceipt", result.rebuildReceipt).toString(2))
    }

    private fun mlDeleteArgs(args: JSONObject): ToolResult {
        val result = memoryLab.delete(
            args.optString("component"), args.optString("expected_updated_at"),
            args.optString("reason"), args.optString("source", "memory_lab_delete"),
        )
        return ToolResult.ok(JSONObject().put("ok", true).put("slug", result.slug).put("rebuildReceipt", result.rebuildReceipt).toString(2))
    }

    val cwdPath: String get() = cwd.absolutePath

    /** 从持久化会话恢复工作目录（参考 tmux session 保留 cwd） */
    fun restoreCwd(path: String) {
        if (path.isBlank()) return
        runCatching {
            val f = File(path).canonicalFile
            val rootCanonical = root.canonicalFile
            if (f.isDirectory && (f == rootCanonical || f.path.startsWith(rootCanonical.path + File.separator))) cwd = f
        }
    }

    /** 解析并执行一行命令（命令行入口，也供 Agent 工具调用复用） */
    fun execute(line: String): ToolResult {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) return ToolResult.ok("")
        val parts = trimmed.split(Regex("\\s+"), limit = 2)
        val enteredCommand = parts[0].lowercase()
        val cmd = TerminalCommandCatalog.canonical(enteredCommand)
            ?: return if (capabilities.highPrivilegeActive()) executeCurrentPrivilegeBoundary(trimmed)
            else ToolResult.err("未知命令：$enteredCommand（输入 help 查看可用命令）")
        val arg = parts.getOrNull(1)?.trim() ?: ""
        return runCatching {
            when (cmd) {
                "pwd" -> ToolResult.ok(cwd.absolutePath)
                "ls" -> ls(arg)
                "tree" -> tree(arg)
                "cd" -> cd(arg)
                "mkdir" -> mkdir(arg)
                "touch" -> touch(arg)
                "read" -> readFile(arg)
                "write" -> writeFile(arg)
                "append" -> appendFile(arg)
                "edit" -> editFile(arg)
                "head" -> headTail(arg, fromEnd = false)
                "tail" -> headTail(arg, fromEnd = true)
                "wc" -> wordCount(arg)
                "stat", "file" -> stat(arg)
                "basename" -> ToolResult.ok(resolve(arg).name)
                "dirname" -> ToolResult.ok(resolve(arg).parentFile?.absolutePath.orEmpty())
                "realpath" -> ToolResult.ok(resolve(arg).absolutePath)
                "find" -> find(arg)
                "grep" -> grep(arg)
                "sort" -> transformLines(arg) { it.sorted() }
                "uniq" -> transformLines(arg) { it.distinct() }
                "copy" -> copyMove(arg, move = false)
                "move" -> copyMove(arg, move = true)
                "remove" -> remove(arg, directoryOnly = false)
                "rmdir" -> remove(arg, directoryOnly = true)
                "echo" -> ToolResult.ok(arg)
                "date" -> ToolResult.ok(ZonedDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE))
                "time" -> ToolResult.ok(ZonedDateTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss.SSS z")))
                "now" -> ToolResult.ok(Instant.now().toString())
                "uptime" -> ToolResult.ok("${SystemClock.elapsedRealtime() / 1000}s")
                "whoami", "id" -> ToolResult.ok(appContext.packageName)
                "hostname" -> ToolResult.ok(Build.MODEL.ifBlank { "android" })
                "uname" -> ToolResult.ok("Android ${Build.VERSION.RELEASE} (${Build.SUPPORTED_ABIS.joinToString(",")})")
                "env" -> environment()
                "which" -> which(arg)
                "sha256" -> hash(arg, "SHA-256")
                "md5" -> hash(arg, "MD5")
                "base64" -> ToolResult.ok(Base64.encodeToString(arg.toByteArray(), Base64.NO_WRAP))
                "unbase64" -> runCatching { String(Base64.decode(arg, Base64.DEFAULT)) }
                    .fold(ToolResult::ok) { ToolResult.err("无效 Base64：${it.message}") }
                "seq" -> sequence(arg)
                "memory_read" -> mlRead(arg)
                "memory_query" -> mlQuery(arg)
                "memory_update" -> mlUpdate(arg)
                "memory_reindex" -> mlReindex()
                "settings_read" -> settingsRead()
                "settings_update" -> settingsUpdate(arg)
                "state" -> state()
                "help" -> help()
                "pkg", "apt", "apt-get", "pm", "am", "cmd", "getprop", "setprop", "dumpsys", "logcat",
                "termux-battery-status", "termux-toast", "termux-notification", "termux-open", "termux-share",
                "termux-vibrate", "termux-clipboard-get", "termux-clipboard-set", "termux-wifi-connectioninfo" ->
                    androidCommand(cmd, arg)
                "shizuku" -> if (capabilities.shizukuActive()) PrivilegedToolBridge.executeShizuku(arg) else ToolResult.err("Shizuku 边界不可用或高权限模式已关闭")
                "root" -> if (capabilities.rootActive()) PrivilegedToolBridge.executeRoot(arg) else ToolResult.err("Root 边界不可用或高权限模式已关闭")
                else -> ToolResult.err("命令尚未实现：$enteredCommand")
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

    private fun mkdir(arg: String): ToolResult {
        if (arg.isBlank()) return ToolResult.err("用法：mkdir <目录>")
        val dir = resolve(arg)
        if (!dir.mkdirs() && !dir.isDirectory) return ToolResult.err("无法创建目录：${dir.absolutePath}")
        return ToolResult.ok("已创建 ${dir.absolutePath}")
    }

    private fun touch(arg: String): ToolResult {
        if (arg.isBlank()) return ToolResult.err("用法：touch <文件>")
        val file = resolve(arg)
        file.parentFile?.mkdirs()
        if (!file.exists()) file.createNewFile() else file.setLastModified(System.currentTimeMillis())
        return ToolResult.ok(file.absolutePath)
    }

    private fun appendFile(arg: String): ToolResult {
        val idx = arg.indexOf(' ')
        if (idx < 0) return ToolResult.err("用法：append <路径> <内容>")
        val file = resolve(arg.substring(0, idx))
        file.parentFile?.mkdirs()
        val content = arg.substring(idx + 1)
        file.appendText(content)
        return ToolResult.ok("已追加 ${content.length} 字符到 ${file.absolutePath}")
    }

    private fun headTail(arg: String, fromEnd: Boolean): ToolResult {
        val pieces = arg.split(Regex("\\s+"), limit = 2)
        val count = pieces.firstOrNull()?.toIntOrNull()?.coerceIn(1, 1000) ?: 10
        val path = if (pieces.firstOrNull()?.toIntOrNull() != null) pieces.getOrNull(1).orEmpty() else arg
        if (path.isBlank()) return ToolResult.err("用法：${if (fromEnd) "tail" else "head"} [行数] <路径>")
        val lines = resolve(path).readLines()
        return ToolResult.ok((if (fromEnd) lines.takeLast(count) else lines.take(count)).joinToString("\n"))
    }

    private fun wordCount(arg: String): ToolResult {
        if (arg.isBlank()) return ToolResult.err("用法：wc <路径>")
        val text = resolve(arg).readText()
        return ToolResult.ok("${text.lineSequence().count()} lines  ${text.split(Regex("\\s+")).count { it.isNotBlank() }} words  ${text.length} chars")
    }

    private fun stat(arg: String): ToolResult {
        if (arg.isBlank()) return ToolResult.err("用法：stat <路径>")
        val file = resolve(arg)
        if (!file.exists()) return ToolResult.err("不存在：${file.absolutePath}")
        return ToolResult.ok("path=${file.absolutePath}\ntype=${if (file.isDirectory) "directory" else "file"}\nsize=${file.length()}\nmodified=${Instant.ofEpochMilli(file.lastModified())}")
    }

    private fun tree(arg: String): ToolResult {
        val base = if (arg.isBlank()) cwd else resolve(arg)
        if (!base.isDirectory) return ToolResult.err("不是目录：${base.absolutePath}")
        val lines = base.walkTopDown().maxDepth(8).take(1000).map { file ->
            val depth = file.relativeTo(base).path.split(File.separator).size.let { if (file == base) 0 else it }
            "  ".repeat(depth) + if (file.isDirectory) "[${file.name}]" else file.name
        }.toList()
        return ToolResult.ok(lines.joinToString("\n") + if (lines.size >= 1000) "\n…（截断）" else "")
    }

    private fun find(arg: String): ToolResult {
        val needle = arg.trim().lowercase()
        if (needle.isBlank()) return ToolResult.err("用法：find <文件名片段>")
        val hits = cwd.walkTopDown().maxDepth(16).filter { it.name.lowercase().contains(needle) }.take(500).map { it.relativeTo(root).path }.toList()
        return ToolResult.ok(hits.joinToString("\n").ifBlank { "无匹配。" })
    }

    private fun grep(arg: String): ToolResult {
        val pieces = arg.split(Regex("\\s+"), limit = 2)
        if (pieces.size < 2) return ToolResult.err("用法：grep <文本> <路径>")
        val needle = pieces[0]
        val file = resolve(pieces[1])
        val matches = file.readLines().mapIndexedNotNull { index, line -> if (line.contains(needle, ignoreCase = true)) "${index + 1}:$line" else null }.take(1000)
        return ToolResult.ok(matches.joinToString("\n").ifBlank { "无匹配。" })
    }

    private fun transformLines(arg: String, transform: (List<String>) -> List<String>): ToolResult {
        if (arg.isBlank()) return ToolResult.err("需要文件路径")
        return ToolResult.ok(transform(resolve(arg).readLines()).joinToString("\n"))
    }

    private fun copyMove(arg: String, move: Boolean): ToolResult {
        val pieces = arg.split(Regex("\\s+"), limit = 2)
        if (pieces.size < 2) return ToolResult.err("用法：${if (move) "mv" else "cp"} <源> <目标>")
        val source = resolve(pieces[0]); val target = resolve(pieces[1])
        if (!source.isFile) return ToolResult.err("源必须是文件：${source.absolutePath}")
        target.parentFile?.mkdirs()
        if (target.exists()) return ToolResult.err("目标已存在：${target.absolutePath}")
        if (move) {
            if (!source.renameTo(target)) { source.copyTo(target); source.delete() }
        } else source.copyTo(target)
        return ToolResult.ok("${if (move) "已移动" else "已复制"}到 ${target.absolutePath}")
    }

    private fun remove(arg: String, directoryOnly: Boolean): ToolResult {
        if (arg.isBlank()) return ToolResult.err("需要明确路径")
        val target = resolve(arg)
        if (target == root) return ToolResult.err("不能删除工作区根目录")
        if (!target.exists()) return ToolResult.err("不存在：${target.absolutePath}")
        if (target.isDirectory && target.list()?.isNotEmpty() == true) return ToolResult.err("仅允许删除空目录")
        if (directoryOnly && !target.isDirectory) return ToolResult.err("不是目录：${target.absolutePath}")
        if (!target.delete()) return ToolResult.err("删除失败：${target.absolutePath}")
        return ToolResult.ok("已删除 ${target.absolutePath}")
    }

    private fun environment(): ToolResult = ToolResult.ok(
        "APP=${appContext.packageName}\nWORKSPACE=${root.absolutePath}\nCWD=${cwd.absolutePath}\nTZ=${ZoneId.systemDefault().id}\nSDK=${Build.VERSION.SDK_INT}",
    )

    private fun which(arg: String): ToolResult {
        val canonical = TerminalCommandCatalog.canonical(arg.trim()) ?: return ToolResult.err("未找到命令：$arg")
        return ToolResult.ok("builtin:$canonical")
    }

    private fun hash(arg: String, algorithm: String): ToolResult {
        if (arg.isBlank()) return ToolResult.err("需要文件路径")
        val digest = MessageDigest.getInstance(algorithm).digest(resolve(arg).readBytes()).joinToString("") { "%02x".format(it) }
        return ToolResult.ok("$digest  $arg")
    }

    private fun sequence(arg: String): ToolResult {
        val numbers = arg.split(Regex("\\s+")).mapNotNull(String::toLongOrNull)
        if (numbers.isEmpty()) return ToolResult.err("用法：seq [起点] <终点> [步长]")
        val start = if (numbers.size == 1) 1L else numbers[0]
        val end = if (numbers.size == 1) numbers[0] else numbers[1]
        val step = (numbers.getOrNull(2) ?: 1L).takeIf { it != 0L } ?: return ToolResult.err("步长不能为 0")
        val values = generateSequence(start) { it + step }.takeWhile { if (step > 0) it <= end else it >= end }.take(10_000).toList()
        return ToolResult.ok(values.joinToString("\n"))
    }

    private fun readFile(arg: String): ToolResult {
        val f = resolve(arg)
        if (!f.exists()) return ToolResult.err("文件不存在：${f.absolutePath}")
        if (f.isDirectory) return ToolResult.err("是目录：${f.absolutePath}")
        val text = f.readText()
        val bounded = if (text.length > 48_000) text.take(48_000) + "\n…（截断）" else text
        return ToolResult.ok("path=${f.absolutePath}\nsha256=${sha256Text(text)}\ntruncated=${text.length > 48_000}\n\n$bounded")
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
        return ToolResult.ok("[memory_lab_read]\n${memoryLab.readJson(arg).toString(2)}")
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

    /** 增量更新设置；保留 providers 全量替换作为旧调用兼容入口。 */
    private fun settingsUpdate(raw: String): ToolResult {
        if (raw.isBlank()) return ToolResult.err("需要 json 参数")
        val json = runCatching { JSONObject(raw) }.getOrNull()
            ?: return ToolResult.err("json 参数不是合法 JSON 对象")
        val changes = mutableListOf<String>()

        val action = json.optString("action")
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

        if (action == "provider_upsert" || json.has("provider")) {
            val patch = json.optJSONObject("provider") ?: return ToolResult.err("provider_upsert 需要 provider 对象")
            val current = providerStore.load().toMutableList()
            val id = patch.optString("id")
            val index = current.indexOfFirst { it.id == id }
            val updated = runCatching { patchProviderConfig(current.getOrNull(index), patch) }
                .getOrElse { return ToolResult.err(it.message ?: "provider patch 失败") }
            if (index >= 0) current[index] = updated else current += updated
            providerStore.save(current)
            changes += "provider_upsert(${updated.id})"
        }

        if (action == "provider_delete") {
            if (!json.optBoolean("confirm")) return ToolResult.err("provider_delete 需要 confirm=true")
            val id = json.optString("provider_id")
            if (id.isBlank()) return ToolResult.err("provider_delete 需要 provider_id")
            val current = providerStore.load()
            if (current.none { it.id == id }) return ToolResult.err("provider 不存在：$id")
            providerStore.save(current.filterNot { it.id == id })
            changes += "provider_delete($id)"
        }

        if (action == "model_upsert" || json.has("model")) {
            val providerId = json.optString("provider_id")
            val patch = json.optJSONObject("model") ?: return ToolResult.err("model_upsert 需要 model 对象")
            val providers = providerStore.load().toMutableList()
            val providerIndex = providers.indexOfFirst { it.id == providerId }
            if (providerIndex < 0) return ToolResult.err("provider 不存在：$providerId")
            val provider = providers[providerIndex]
            val modelName = patch.optString("name")
            val modelIndex = provider.models.indexOfFirst { it.name == modelName }
            val updated = runCatching { patchModelConfig(provider.models.getOrNull(modelIndex), patch) }
                .getOrElse { return ToolResult.err(it.message ?: "model patch 失败") }
            val models = provider.models.toMutableList().apply { if (modelIndex >= 0) this[modelIndex] = updated else add(updated) }
            providers[providerIndex] = provider.copy(models = models)
            providerStore.save(providers)
            changes += "model_upsert($providerId/${updated.name})"
        }

        if (action == "model_delete") {
            if (!json.optBoolean("confirm")) return ToolResult.err("model_delete 需要 confirm=true")
            val providerId = json.optString("provider_id")
            val modelName = json.optString("model_name")
            val providers = providerStore.load().toMutableList()
            val providerIndex = providers.indexOfFirst { it.id == providerId }
            if (providerIndex < 0) return ToolResult.err("provider 不存在：$providerId")
            val provider = providers[providerIndex]
            if (provider.models.none { it.name == modelName }) return ToolResult.err("model 不存在：$providerId/$modelName")
            providers[providerIndex] = provider.copy(models = provider.models.filterNot { it.name == modelName })
            providerStore.save(providers)
            changes += "model_delete($providerId/$modelName)"
        }

        if (json.has("active")) {
            val a = json.optJSONObject("active") ?: return ToolResult.err("active 必须是对象")
            val active = patchActiveModel(providerStore.loadActive(), a)
            providerStore.saveActive(active)
            changes += "active(${active.providerId}/${active.modelName}/${active.intelligence})"
        }

        if (changes.isEmpty()) return ToolResult.err("至少提供 active、provider、model、providers 或删除 action 之一")
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

    private fun recentFiles(args: JSONObject): ToolResult {
        val requested = args.optString("types").split(',').map(String::trim).filter(String::isNotBlank).toSet()
        val types = requested.ifEmpty { setOf("documents", "images", "videos") }
        val query = args.optString("query").trim().lowercase()
        val limit = args.optInt("limit", 50).coerceIn(1, 200)
        val rows = mutableListOf<JSONObject>()
        fun collect(kind: String, collection: Uri, selection: String? = null, selectionArgs: Array<String>? = null) {
            if (kind !in types) return
            val projection = arrayOf(
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.MIME_TYPE,
                MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_MODIFIED,
                MediaStore.MediaColumns.RELATIVE_PATH,
            )
            appContext.contentResolver.query(
                collection,
                projection,
                selection,
                selectionArgs,
                "${MediaStore.MediaColumns.DATE_MODIFIED} DESC",
            )?.use { cursor ->
                val idColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                val nameColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
                val mimeColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
                val sizeColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
                val modifiedColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
                val relativeColumn = cursor.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH)
                while (cursor.moveToNext() && rows.size < limit * 3) {
                    val name = cursor.getString(nameColumn).orEmpty()
                    val mime = cursor.getString(mimeColumn).orEmpty()
                    if (query.isNotEmpty() && !name.lowercase().contains(query) && !mime.lowercase().contains(query)) continue
                    val uri = android.content.ContentUris.withAppendedId(collection, cursor.getLong(idColumn))
                    rows += JSONObject()
                        .put("type", kind)
                        .put("name", name)
                        .put("mime_type", mime)
                        .put("size", cursor.getLong(sizeColumn))
                        .put("modified_ms", cursor.getLong(modifiedColumn) * 1000L)
                        .put("relative_path", if (relativeColumn >= 0) cursor.getString(relativeColumn).orEmpty() else "")
                        .put("uri", uri.toString())
                }
            }
        }
        val nonMediaSelection = if (Build.VERSION.SDK_INT >= 30) {
            "${MediaStore.Files.FileColumns.MEDIA_TYPE}=?"
        } else null
        val nonMediaArgs = if (Build.VERSION.SDK_INT >= 30) arrayOf(MediaStore.Files.FileColumns.MEDIA_TYPE_NONE.toString()) else null
        collect("documents", MediaStore.Files.getContentUri("external"), nonMediaSelection, nonMediaArgs)
        collect("images", MediaStore.Images.Media.EXTERNAL_CONTENT_URI)
        collect("videos", MediaStore.Video.Media.EXTERNAL_CONTENT_URI)
        collectPersistedDocuments(types, query, limit * 3, rows)
        val sorted = rows.sortedByDescending { it.optLong("modified_ms") }.take(limit)
        return ToolResult.ok(JSONObject().put("count", sorted.size).put("items", JSONArray(sorted)).toString(2))
    }

    private fun collectPersistedDocuments(types: Set<String>, query: String, limit: Int, rows: MutableList<JSONObject>) {
        if ("documents" !in types) return
        appContext.contentResolver.persistedUriPermissions.asSequence().filter { it.isReadPermission }.forEach { permission ->
            val rootUri = permission.uri
            val children = if (DocumentsContract.isTreeUri(rootUri)) {
                DocumentsContract.buildChildDocumentsUriUsingTree(rootUri, DocumentsContract.getTreeDocumentId(rootUri))
            } else rootUri
            val projection = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                DocumentsContract.Document.COLUMN_FLAGS,
            )
            runCatching {
                appContext.contentResolver.query(children, projection, null, null, null)?.use { cursor ->
                    while (cursor.moveToNext() && rows.size < limit) {
                        val documentId = cursor.getString(0).orEmpty(); val name = cursor.getString(1).orEmpty(); val mime = cursor.getString(2).orEmpty()
                        if (mime == DocumentsContract.Document.MIME_TYPE_DIR) continue
                        if (query.isNotBlank() && !name.lowercase().contains(query) && !mime.lowercase().contains(query)) continue
                        val uri = if (DocumentsContract.isTreeUri(rootUri)) DocumentsContract.buildDocumentUriUsingTree(rootUri, documentId) else rootUri
                        val size = if (cursor.isNull(3)) -1L else cursor.getLong(3); val flags = cursor.getInt(5)
                        rows += JSONObject().put("type", "documents").put("name", name).put("mime_type", mime)
                            .put("size", size).put("modified_ms", if (cursor.isNull(4)) 0L else cursor.getLong(4))
                            .put("uri", uri.toString()).put("document_id", documentId)
                            .put("canonical_identity", "${uri.authority}:$documentId")
                            .put("placeholder", size <= 0L || flags and DocumentsContract.Document.FLAG_PARTIAL != 0)
                            .put("provider_flags", flags)
                    }
                }
            }
        }
    }

    private suspend fun readSharedFile(path: String): ToolResult {
        if (path.isBlank()) return ToolResult.err("需要共享存储 path")
        val uri = runCatching { Uri.parse(path) }.getOrNull()
        if (uri?.scheme == ContentResolver.SCHEME_CONTENT) {
            val resolver = appContext.contentResolver
            val metadata = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (!cursor.moveToFirst()) null else Triple(cursor.getString(0).orEmpty(), cursor.getString(1).orEmpty(), if (cursor.isNull(2)) -1L else cursor.getLong(2))
            }
            val size = metadata?.third ?: -1L
            if (size > 20L * 1024 * 1024) return ToolResult.err("文件超过 20 MiB")
            val cancellation = CancellationSignal()
            // DocumentProvider may hydrate an online-only/optimized placeholder here.
            val descriptor = runCatching { resolver.openAssetFileDescriptor(uri, "r", cancellation) }.getOrNull()
            val bytes = (descriptor?.createInputStream() ?: appContext.contentResolver.openInputStream(uri))?.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                var total = 0
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > 20 * 1024 * 1024) return ToolResult.err("文件超过 20 MiB")
                    output.write(buffer, 0, read)
                }
                output.toByteArray()
            } ?: return ToolResult.err("无法读取该系统文件 URI")
            val mime = metadata?.second.orEmpty().ifBlank { resolver.getType(uri).orEmpty() }
            val name = metadata?.first.orEmpty().ifBlank { "shared-file" }
            val rich = name.substringAfterLast('.', "").lowercase() in setOf("pdf", "doc", "docx", "ppt", "pptx", "csv", "tsv", "xls", "xlsx")
            descriptor?.close()
            if (rich || mime.startsWith("text/")) {
                val pdfDescriptor = if (name.endsWith(".pdf", true) || mime == "application/pdf") {
                    runCatching { resolver.openFileDescriptor(uri, "r", cancellation) }.getOrNull()
                } else null
                return try { richDocuments.read(name, mime, bytes, pdfDescriptor) } finally { pdfDescriptor?.close() }
            }
            return ToolResult.ok(JSONObject().put("name", name).put("mime_type", mime).put("size", bytes.size).put("encoding", "base64").put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)).toString())
        }
        val file = safeSharedPath(path)
        if (!file.exists()) return ToolResult.err("不存在：${file.absolutePath}")
        if (file.isDirectory) return ToolResult.ok(file.listFiles()?.sortedBy { it.name }?.joinToString("\n") { it.name }.orEmpty())
        if (file.length() > 20L * 1024 * 1024) return ToolResult.err("文件超过 20 MiB")
        val bytes = file.readBytes()
        return richDocuments.read(file.name, java.net.URLConnection.guessContentTypeFromName(file.name).orEmpty(), bytes)
    }

    private fun safeSharedPath(path: String): File {
        require(path.isNotBlank()) { "需要共享存储路径" }
        val external = android.os.Environment.getExternalStorageDirectory().canonicalFile
        val file = File(path).let { if (it.isAbsolute) it else File(external, path) }.canonicalFile
        require(file == external || file.path.startsWith(external.path + File.separator)) { "路径越出共享存储边界" }
        val relative = file.relativeTo(external).invariantSeparatorsPath.lowercase()
        require(relative != "android/data" && !relative.startsWith("android/data/") && relative != "android/obb" && !relative.startsWith("android/obb/")) {
            "普通文件工具不触及 Android/data 或 Android/obb"
        }
        var cursor: File? = file
        while (cursor != null && cursor != external) {
            if (java.nio.file.Files.isSymbolicLink(cursor.toPath())) throw SecurityException("拒绝符号链接路径")
            cursor = cursor.parentFile
        }
        return file
    }

    private suspend fun manageSharedFile(args: JSONObject): ToolResult {
        val action = args.optString("action").lowercase()
        val file = safeSharedPath(args.optString("path"))
        return when (action) {
            "list" -> {
                if (!file.isDirectory) return ToolResult.err("不是目录：${file.absolutePath}")
                ToolResult.ok(file.listFiles()?.sortedWith(compareByDescending<File> { it.isDirectory }.thenBy { it.name })?.take(2000)?.joinToString("\n") {
                    "${if (it.isDirectory) "[d]" else "[f]"}\t${it.length()}\t${it.name}"
                }.orEmpty())
            }
            "read" -> readSharedFile(file.absolutePath)
            "stat" -> if (!file.exists()) ToolResult.err("不存在") else ToolResult.ok(buildString {
                append("path=${file.absolutePath}\ntype=${if (file.isDirectory) "directory" else "file"}\nsize=${file.length()}\nmodified=${file.lastModified()}")
                if (file.isFile && file.length() <= 20L * 1024 * 1024) append("\nsha256=${MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }}")
            })
            "mkdir" -> if (file.mkdirs() || file.isDirectory) ToolResult.ok("已创建 ${file.absolutePath}") else ToolResult.err("创建失败")
            "write" -> {
                val existing = if (file.exists()) file.readText() else ""
                val content = applyTextMutation(existing, args).getOrElse { return ToolResult.err("文件更新失败：${it.message}") }
                if (content.toByteArray().size > 5 * 1024 * 1024) return ToolResult.err("单次写入超过 5 MiB")
                file.parentFile?.mkdirs(); file.writeText(content); ToolResult.ok("已写入 ${file.absolutePath}")
            }
            "append", "replace" -> {
                if (!file.isFile) return ToolResult.err("目标必须是已有文件")
                val mutationArgs = JSONObject(args.toString()).put("action", action)
                val content = applyTextMutation(file.readText(), mutationArgs).getOrElse { return ToolResult.err("文件更新失败：${it.message}") }
                if (content.toByteArray().size > 5 * 1024 * 1024) return ToolResult.err("更新后文件超过 5 MiB")
                file.writeText(content); ToolResult.ok("已局部更新 ${file.absolutePath}")
            }
            "copy", "move" -> {
                if (!file.isFile) return ToolResult.err("仅允许复制或移动单个文件")
                val destination = safeSharedPath(args.optString("destination"))
                if (destination.exists()) return ToolResult.err("目标已存在，拒绝覆盖")
                destination.parentFile?.mkdirs()
                if (action == "copy") file.copyTo(destination, overwrite = false) else if (!file.renameTo(destination)) { file.copyTo(destination); file.delete() }
                ToolResult.ok("已${if (action == "copy") "复制" else "移动"}到 ${destination.absolutePath}")
            }
            "delete" -> {
                if (!args.optBoolean("confirm", false)) return ToolResult.err("删除需要 confirm=true 二次确认")
                val external = android.os.Environment.getExternalStorageDirectory().canonicalFile
                if (file == external) return ToolResult.err("拒绝删除共享存储根目录")
                if (file.isDirectory && !file.listFiles().isNullOrEmpty()) return ToolResult.err("拒绝递归删除非空目录")
                if (!file.exists()) return ToolResult.err("目标不存在")
                if (file.delete()) ToolResult.ok("已删除 ${file.absolutePath}") else ToolResult.err("删除失败")
            }
            else -> ToolResult.err("action 必须是 list|read|stat|mkdir|write|append|replace|copy|move|delete")
        }
    }

    private fun listApps(): ToolResult {
        val pm = appContext.packageManager
        val rows = pm.getInstalledPackages(0).asSequence().map { info ->
            val label = info.applicationInfo?.loadLabel(pm)?.toString().orEmpty()
            "${info.packageName}\t${info.versionName.orEmpty()}\t$label"
        }.sorted().toList()
        return ToolResult.ok(rows.joinToString("\n").ifBlank { "没有可见应用" })
    }

    private fun inspectApps(packageName: String): ToolResult {
        if (packageName.isBlank()) return listApps()
        val pm = appContext.packageManager
        val info = runCatching { pm.getPackageInfo(packageName, android.content.pm.PackageManager.GET_PERMISSIONS) }.getOrNull()
            ?: return ToolResult.err("应用不可见或不存在：$packageName")
        val app = info.applicationInfo
        return ToolResult.ok(JSONObject()
            .put("packageName", info.packageName)
            .put("label", app?.loadLabel(pm)?.toString().orEmpty())
            .put("versionName", info.versionName.orEmpty())
            .put("versionCode", if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong())
            .put("enabled", app?.enabled == true)
            .put("systemApp", app?.flags?.and(android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0)
            .put("requestedPermissions", JSONArray(info.requestedPermissions ?: emptyArray<String>()))
            .put("privateDataReadable", info.packageName == appContext.packageName)
            .toString(2))
    }

    private fun pluginList(kind: String): ToolResult {
        val state = MobilePluginStore(appContext).load()
        val entries = if (kind == "skills") state.skills else state.mcp
        return ToolResult.ok(entries.filterValues { it }.keys.sorted().joinToString("\n").ifBlank { "没有启用的 ${kind.uppercase()} 插件" })
    }

    private fun help(): ToolResult = ToolResult.ok(
        "内置受控命令（${TerminalCommandCatalog.names.size} 个命令名/别名；文件操作仅限工作区）：\n" +
            TerminalCommandCatalog.summary(),
    )

    private fun androidCommand(command: String, arg: String): ToolResult {
        val privileged = command in setOf("pkg", "apt", "apt-get", "pm", "am", "cmd", "setprop", "dumpsys", "logcat")
        if (privileged && !capabilities.highPrivilegeActive()) return ToolResult.err("$command 需要高权限模式（Root/Shizuku）")
        val line = if (arg.isBlank()) command else "$command $arg"
        if (privileged) return executeCurrentPrivilegeBoundary(line)
        return runCatching {
            val process = ProcessBuilder("/system/bin/sh", "-c", line).redirectErrorStream(true).start()
            val output = process.inputStream.bufferedReader().readText()
            val code = process.waitFor()
            if (code == 0) ToolResult.ok(output.trim()) else ToolResult.err(output.trim().ifBlank { "退出码 $code" })
        }.getOrElse { ToolResult.err("Android 命令不可用：${it.message ?: it}") }
    }

    private fun executeCurrentPrivilegeBoundary(command: String): ToolResult = when {
        capabilities.rootActive() -> PrivilegedToolBridge.executeRoot(command)
        capabilities.shizukuActive() -> PrivilegedToolBridge.executeShizuku(command)
        else -> ToolResult.err("当前没有可用的 Root/Shizuku 高权限边界")
    }

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
