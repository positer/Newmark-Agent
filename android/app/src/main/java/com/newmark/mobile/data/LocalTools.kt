package com.newmark.mobile.data

import org.json.JSONArray
import org.json.JSONObject

/** 本地 Agent 工具定义（OpenAI function calling schema），供本地对话 tool-call 使用 */
object LocalTools {

    private fun prop(type: String, description: String): JSONObject =
        JSONObject().put("type", type).put("description", description)

    private fun enumProp(values: Collection<String>, description: String): JSONObject =
        prop("string", description).put("enum", JSONArray(values))

    private fun function(name: String, description: String, properties: Map<String, JSONObject>, required: List<String>): JSONObject =
        JSONObject()
            .put("type", "function")
            .put("function", JSONObject().apply {
                put("name", name)
                put("description", description)
                put("parameters", JSONObject().apply {
                    put("type", "object")
                    put("properties", JSONObject().apply { properties.forEach { (k, v) -> put(k, v) } })
                    put("required", JSONArray(required))
                })
            })

    val definitions: List<JSONObject> = listOf(
        function(
            "read_file",
            "读取 Android 安全目录（files/newmark/workspace）内的文件内容",
            mapOf("path" to prop("string", "文件路径（相对或绝对）")),
            listOf("path"),
        ),
        function(
            "write_file",
            "把内容写入 Android 安全目录内的文件（自动创建父目录）",
            mapOf(
                "path" to prop("string", "文件路径"),
                "content" to prop("string", "完整文件内容"),
            ),
            listOf("path", "content"),
        ),
        function(
            "list_dir",
            "列出安全目录内容",
            mapOf("path" to prop("string", "目录路径（留空为当前目录）")),
            emptyList(),
        ),
        function(
            "recent_files",
            "从 Android 系统允许暴露的最新文件集合与已授权 DocumentProvider 中发现文档、图片和视频；识别云端仅在线、系统优化释放及重复文件占位符，返回稳定 document_id/canonical_identity 和可触发恢复下载的 content:// URI。",
            mapOf(
                "types" to prop("string", "类型，逗号分隔：documents,images,videos；留空为全部"),
                "query" to prop("string", "可选文件名或 MIME 关键词"),
                "limit" to prop("number", "最多返回 1 到 200 项，默认 50"),
            ),
            emptyList(),
        ),
        function(
            "terminal_exec",
            "执行移动端本地受控终端命令。与命令行页面复用同一套 80+ 内置命令和 files/newmark/workspace 安全目录；可先执行 help 查看完整命令，支持 date/time、文件、检索、哈希、编码、Memory Lab 与设置命令，但不提供 Android 系统 shell。",
            mapOf("command" to prop("string", "要执行的一行终端命令，例如 date、pwd、ls、grep 关键词 文件、sha256sum 文件")),
            listOf("command"),
        ),
        function(
            "memory_lab_read",
            "读取 Memory Lab 索引或单个组件；先读后改",
            mapOf("component" to prop("string", "组件 slug（留空读取全部索引）")),
            emptyList(),
        ),
        function(
            "memory_lab_query",
            "按关键词查询 Memory Lab 组件，返回精简命中",
            mapOf("query" to prop("string", "查询关键词")),
            listOf("query"),
        ),
        function(
            "memory_lab_update",
            "创建/更新 Memory Lab 组件；content 用 Markdown，tag_paths 用 JSON 数组",
            mapOf(
                "name" to prop("string", "记忆组件名称"),
                "description" to prop("string", "组件描述"),
                "tags" to prop("string", "标签（逗号分隔，可带 # 前缀）"),
                "tag_paths" to prop("string", "完整标签路径 JSON，例如 [[\"#物理\",\"#理论物理\"]]"),
                "content" to prop("string", "记忆组件核心内容（markdown）"),
                "kind" to prop("string", "file 或 folder"),
                "expected_updated_at" to prop("string", "更新已有组件时从最新读取结果取得的 updatedAt"),
                "reason" to prop("string", "本次持久记忆变更原因"),
                "source" to prop("string", "变更来源"),
            ),
            listOf("name", "tags", "content"),
        ),
        function(
            "memory_lab_delete",
            "删除 Memory Lab 组件；先读并提供 expected_updated_at",
            mapOf(
                "component" to prop("string", "组件名称或 slug"),
                "expected_updated_at" to prop("string", "从最新读取结果取得的 updatedAt"),
                "reason" to prop("string", "明确的删除原因"),
                "source" to prop("string", "变更来源"),
            ),
            listOf("component"),
        ),
        function(
            "memory_lab_reindex",
            "重建 Memory Lab 标签与组件索引",
            emptyMap(),
            emptyList(),
        ),
        function(
            "settings_read",
            "读取当前设置 JSON。与 PC config.json 同构：providers 数组（每项 id/name/base_url/api_key/protocol/enabled/models，models 每项 name/display/description/enabled 等）+ active 激活选择（provider_id/model_name/intelligence）",
            emptyMap(),
            emptyList(),
        ),
        function(
            "settings_update",
            "通过 JSON 更新设置（对齐 PC：Agent 可直接编辑设置文件，改动立即生效）。json 为 JSON 字符串，形态：{\"providers\":[ProviderConfig...],\"active\":{\"provider_id\":\"\",\"model_name\":\"\",\"intelligence\":\"low|medium|high\"}}；providers 与 active 至少提供一项，提供哪个更新哪个。",
            mapOf("json" to prop("string", "JSON 设置字符串（providers 数组与/或 active 激活选择）")),
            listOf("json"),
        ),
        function(
            "web_search",
            "通过 DuckDuckGo 搜索网页并返回标题、地址与摘要",
            mapOf("query" to prop("string", "搜索关键词")),
            listOf("query"),
        ),
        function(
            "web_fetch",
            "获取 http/https 网页并提取可读文本",
            mapOf("url" to prop("string", "网页地址")),
            listOf("url"),
        ),
        browserUse(LocalToolCatalog.buildBrowserActions),
        function(
            "task_read",
            "读取当前对话持久化的 task/plan 清单",
            emptyMap(),
            emptyList(),
        ),
        function(
            "task_create",
            "维护当前对话持久化 task/plan 清单；create 新增，update 更新文字或状态，clear 删除已完成项",
            mapOf(
                "action" to enumProp(listOf("create", "update", "clear"), "操作"),
                "task" to prop("string", "create 的任务文字，或 update 的新文字"),
                "text" to prop("string", "task 的别名"),
                "id" to prop("string", "update 的任务 id"),
                "index" to prop("number", "update 的零基索引"),
                "status" to enumProp(listOf("pending", "in_progress", "done", "blocked"), "update 的状态"),
            ),
            listOf("action"),
        ),
        function(
            "build_history_query",
            "只读读取当前对话历史 Build block 的工具活动、状态和最终摘要；不会恢复或重新执行历史任务",
            mapOf(
                "history_index" to prop("number", "按最新到最旧的历史序号，1 表示上一条 Build block"),
                "run_id" to prop("string", "历史 Build block 的 run id，可替代 history_index"),
                "max_events" to prop("number", "最多返回活动条数，1 到 200"),
                "max_chars" to prop("number", "每条活动最多返回字符数，100 到 4000"),
            ),
            emptyList(),
        ),
        function(
            "context_compress",
            "主动压缩当前模型历史上下文；显示历史不变，force=true 可在未达到自动阈值时执行",
            mapOf(
                "force" to prop("boolean", "是否强制压缩"),
                "keep_recent" to prop("number", "保留最近消息数，2 到 60；移动端按安全窗口裁剪"),
            ),
            emptyList(),
        ),
        function(
            "context_history_manage",
            "管理上下文压缩记录：status/search/read；只读操作不会改变历史，恢复需明确 restore_id 且不得覆盖最近上下文",
            mapOf(
                "action" to enumProp(listOf("status", "search", "read"), "操作"),
                "query" to prop("string", "search 的关键词"),
                "restore_id" to prop("string", "压缩记录 id"),
                "limit" to prop("number", "search 返回条数"),
            ),
            listOf("action"),
        ),
        function(
            "calendar_create",
            "打开 Android 默认日程 App 的新建日程界面，由用户检查并确认保存；无需读取或写入日历权限",
            mapOf(
                "title" to prop("string", "日程标题"),
                "begin_time_ms" to prop("number", "开始时间，Unix epoch 毫秒"),
                "end_time_ms" to prop("number", "结束时间，Unix epoch 毫秒"),
                "all_day" to prop("boolean", "是否全天日程"),
                "location" to prop("string", "地点"),
                "description" to prop("string", "说明"),
                "emails" to prop("string", "受邀人邮箱，逗号分隔"),
                "recurrence_rule" to prop("string", "可选 RFC 5545 RRULE，例如 FREQ=WEEKLY;COUNT=4"),
                "availability" to enumProp(listOf("busy", "free"), "忙碌状态"),
            ),
            listOf("title"),
        ),
        function(
            "calendar_read",
            "读取 Android 系统日历中用户授权可见的日程，默认查询从现在起 30 天；用于在规划和执行前辅助 Agent 了解已有安排",
            mapOf(
                "start_time_ms" to prop("number", "查询起点，Unix epoch 毫秒；留空为当前时间"),
                "end_time_ms" to prop("number", "查询终点，Unix epoch 毫秒；留空为起点后 30 天"),
                "query" to prop("string", "可选标题、地点或说明关键词"),
                "max_results" to prop("number", "最多返回条数，1 到 200，默认 50"),
            ),
            emptyList(),
        ),
        function(
            "alarm_manage",
            "通过 Android 默认时钟应用创建和查看系统闹钟；create 会显示默认时钟确认界面，list 打开系统闹钟列表；系统协议仅支持 create|list，不提供跨时钟应用的 alarm_id 删除",
            mapOf(
                "action" to enumProp(listOf("create", "list"), "操作（create|list）"),
                "trigger_at_ms" to prop("number", "create 的未来 Unix epoch 毫秒"),
                "title" to prop("string", "闹钟标题"),
                "message" to prop("string", "触发时显示的内容"),
            ),
            listOf("action"),
        ),
    )

    /** Runtime exposure is capability-bound; stale model context cannot grant a tool. */
    fun definitionsFor(context: android.content.Context, plan: Boolean = false): List<JSONObject> {
        val state = MobileCapabilityStore(context)
        val extras = listOf(
            function("files_read_all", "读取系统当前允许访问的文件并自动恢复 DocumentProvider 占位内容。支持 PDF、DOC/DOCX、PPT/PPTX、CSV/TSV、XLS/XLSX；PDF 使用文字层→视觉模型→miniOCR→LLM完整视觉退路。", mapOf("path" to prop("string", "recent_files 返回的 content:// URI 或共享存储路径")), listOf("path")),
            function("apps_list", "读取已安装应用列表", emptyMap(), emptyList()),
            function("files_manage", "在共享存储安全边界内管理文件；delete 仅允许精确单文件或空目录并要求 confirm=true", mapOf(
                "action" to enumProp(listOf("list", "read", "stat", "mkdir", "write", "copy", "move", "delete"), "操作"),
                "path" to prop("string", "共享存储内路径"), "destination" to prop("string", "copy/move 目标路径"),
                "content" to prop("string", "write 内容"), "confirm" to prop("boolean", "delete 二次确认"),
            ), listOf("action", "path")),
            function("apps_inspect", "读取用户授权范围内的应用公开元数据、版本与声明权限；不读取其他应用私有数据", mapOf(
                "package_name" to prop("string", "可选包名；留空返回应用列表"),
            ), emptyList()),
            function("skills_list", "读取启用的 Skill", emptyMap(), emptyList()),
            function("mcp_list", "读取启用的 MCP", emptyMap(), emptyList()),
            function("shizuku_exec", "仅经 Shizuku shell/ADB 权限边界执行命令", mapOf("command" to prop("string", "命令")), listOf("command")),
            function("root_exec", "仅经设备 Root 权限边界执行命令", mapOf("command" to prop("string", "命令")), listOf("command")),
            function("adb_exec", "经 Shizuku shell/ADB 权限边界执行命令", mapOf("command" to prop("string", "命令")), listOf("command")),
        )
        val safeExtras = if (!plan) extras else extras.filterNot {
            it.optJSONObject("function")?.optString("name") in setOf("files_manage", "root_exec", "shizuku_exec", "adb_exec")
        } + function("files_manage", "只读查看共享存储", mapOf(
            "action" to enumProp(listOf("list", "read", "stat"), "只读操作"), "path" to prop("string", "共享存储内路径"),
        ), listOf("action", "path"))
        val base = (if (plan) planDefinitions else definitions) + safeExtras
        return base.filter { definition ->
            val name = definition.optJSONObject("function")?.optString("name") ?: return@filter false
            when {
                name in LocalToolCatalog.shizukuNames -> state.shizukuActive()
                name in LocalToolCatalog.rootNames -> state.rootActive()
                name in LocalToolCatalog.privilegedNames -> state.highPrivilegeActive()
                name in LocalToolCatalog.externalFileNames -> state.externalFilesEnabled()
                name in LocalToolCatalog.allFilesNames -> state.allFilesGranted()
                name in LocalToolCatalog.appListNames -> state.appListGranted()
                else -> true
            }
        }
    }

    private fun browserUse(actions: Collection<String>): JSONObject = function(
        "browser_use",
        "操作当前对话的内置浏览器。observe/extract 优先读取 DOM 或 PDF 文本层；文本不足时使用同一 WebView/PDF 页面截图和设备端中英 OCR，并返回只允许保守 LLM 矫正的提示。",
        mapOf(
            "action" to enumProp(actions, "浏览器动作"),
            "url" to prop("string", "navigate 的 http/https 地址"),
            "max_chars" to prop("number", "observe/extract 最大正文字符数"),
            "duration_ms" to prop("number", "wait 等待毫秒数"),
        ),
        listOf("action"),
    )

    /** 本地 Plan 与 PC 一致为只读：可读文件、读取/查询记忆和设置，写入能力不向模型暴露。 */
    val planDefinitions: List<JSONObject>
        get() = definitions.mapNotNull { definition ->
            val name = definition.optJSONObject("function")?.optString("name")
            when {
                name == "browser_use" -> browserUse(LocalToolCatalog.planBrowserActions)
                name in LocalToolCatalog.planNames -> definition
                else -> null
            }
        }
}
