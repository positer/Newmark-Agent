package com.newmark.mobile.data

import org.json.JSONArray
import org.json.JSONObject

/** 本地 Agent 工具定义（OpenAI function calling schema），供本地对话 tool-call 使用 */
object LocalTools {

    private fun prop(type: String, description: String): JSONObject =
        JSONObject()
            .put("type", type)
            .put("description", "${description.trimEnd('。')}。JSON 类型：$type。")

    private fun enumProp(values: Collection<String>, description: String): JSONObject =
        prop("string", description).put("enum", JSONArray(values))

    private fun arrayProp(items: JSONObject, description: String): JSONObject =
        prop("array", description).put("items", items)

    private fun stringMapProp(description: String): JSONObject =
        prop("object", description).put("additionalProperties", JSONObject().put("type", "string"))

    private fun objectProp(
        description: String,
        properties: Map<String, JSONObject>,
        required: List<String> = emptyList(),
    ): JSONObject = prop("object", description).apply {
        put("properties", JSONObject().apply { properties.forEach { (key, value) -> put(key, value) } })
        put("required", JSONArray(required))
        put("additionalProperties", false)
    }

    private fun function(name: String, description: String, properties: Map<String, JSONObject>, required: List<String>): JSONObject {
        val optional = properties.keys - required.toSet()
        val formatHelp = buildString {
            append("调用格式：传入一个 JSON 对象；")
            append(if (required.isEmpty()) "没有必填字段" else "必填字段为 ${required.joinToString(", ")}")
            append(if (optional.isEmpty()) "；没有可选字段" else "；可选字段为 ${optional.joinToString(", ")}")
            append("；不接受未声明字段。")
        }
        return JSONObject()
            .put("type", "function")
            .put("function", JSONObject().apply {
                put("name", name)
                put("description", "${description.trimEnd('。')}。$formatHelp")
                put("parameters", JSONObject().apply {
                    put("type", "object")
                    put("properties", JSONObject().apply { properties.forEach { (k, v) -> put(k, v) } })
                    put("required", JSONArray(required))
                    put("additionalProperties", false)
                })
            })
    }

    private val settingsModelSchema: JSONObject
        get() = objectProp(
            description = "一个模型配置。name 是供应商 API 使用的模型标识，其余字段均可省略并采用应用默认值。",
            properties = mapOf(
                "name" to prop("string", "必填；供应商 API 使用的模型标识，例如 gpt-5.6-sol"),
                "display" to prop("string", "可选；设置页显示名称，留空时显示 name"),
                "description" to prop("string", "可选；模型用途说明"),
                "max_tokens" to prop("integer", "可选；模型上下文 token 上限，未知时填 0 或省略"),
                "vision" to prop("boolean", "可选；是否接受图片输入，默认 false"),
                "thinking" to prop("boolean", "可选；是否支持 reasoning_effort，默认 false"),
                "image_output" to prop("boolean", "可选；是否支持图片输出，默认 false"),
                "enabled" to prop("boolean", "可选；是否在模型选择器中启用，默认 true"),
                "preview" to prop("boolean", "可选；是否标记为预览模型，默认 false"),
                "privacy" to arrayProp(prop("string", "隐私标签"), "可选；模型隐私标签数组"),
                "capabilities" to arrayProp(prop("string", "能力名称"), "可选；模型能力名称数组"),
                "fallback_only" to prop("boolean", "可选；是否只允许作为回退模型，默认 false"),
                "speed_rating" to prop("string", "可选；速度评级"),
                "capability_rating" to prop("string", "可选；能力评级"),
                "intelligence_tiers" to objectProp(
                    description = "可选；low、medium、high 三个 Newmark 智能档位的显示说明",
                    properties = mapOf(
                        "low" to objectProp("low 档位说明", mapOf("description" to prop("string", "low 档位显示说明"))),
                        "medium" to objectProp("medium 档位说明", mapOf("description" to prop("string", "medium 档位显示说明"))),
                        "high" to objectProp("high 档位说明", mapOf("description" to prop("string", "high 档位显示说明"))),
                    ),
                ),
                "thinking_tier_map" to stringMapProp("可选；模型原生思考档位名到 Newmark 档位名的字符串映射"),
            ),
            required = listOf("name"),
        )

    private val settingsProviderSchema: JSONObject
        get() = objectProp(
            description = "一个 OpenAI 兼容供应商配置。更新 providers 会整体替换现有供应商数组，修改前应先调用 settings_read。",
            properties = mapOf(
                "id" to prop("string", "供应商稳定唯一标识；已有供应商必须保留原 id"),
                "name" to prop("string", "设置页显示的供应商名称"),
                "base_url" to prop("string", "OpenAI 兼容 API 基础地址，例如 https://example.com/v1"),
                "api_key" to prop("string", "供应商 API Key；保留现有供应商时不得无意清空"),
                "protocol" to enumProp(listOf("openai", "anthropic"), "请求协议；通常为 openai"),
                "enabled" to prop("boolean", "是否启用该供应商，默认 true"),
                "has_api_key" to prop("boolean", "是否已有凭据；通常与 api_key 是否非空一致"),
                "models" to arrayProp(settingsModelSchema, "该供应商的完整模型配置数组"),
            ),
            required = listOf("id", "name", "base_url", "models"),
        )

    private val settingsActiveSchema: JSONObject
        get() = objectProp(
            description = "当前激活的供应商、模型和智能档位；provider_id 与 model_name 应对应 providers 中已启用的条目。",
            properties = mapOf(
                "provider_id" to prop("string", "要激活的供应商 id"),
                "model_name" to prop("string", "要激活的模型 name"),
                "intelligence" to enumProp(
                    listOf("low", "medium", "high", "xhigh", "max", "ultra"),
                    "Newmark 智能档位，默认 medium",
                ),
            ),
            required = emptyList(),
        )

    private val settingsProviderPatchSchema: JSONObject
        get() = objectProp(
            description = "单个供应商的局部 patch。id 必填；仅提供要修改的字段，未提供字段保持不变。新建供应商时应同时提供 name、base_url。",
            properties = mapOf(
                "id" to prop("string", "要新增或修改的供应商稳定 id"),
                "name" to prop("string", "可选的新显示名称"),
                "base_url" to prop("string", "可选的新 API 基础地址"),
                "api_key" to prop("string", "可选的新 API Key；省略会保留旧 Key"),
                "protocol" to enumProp(listOf("openai", "anthropic"), "可选的新请求协议"),
                "enabled" to prop("boolean", "可选的新启用状态"),
                "has_api_key" to prop("boolean", "可选的新凭据存在标记"),
            ),
            required = listOf("id"),
        )

    private val settingsModelPatchSchema: JSONObject
        get() = objectProp(
            description = "单个模型的局部 patch。name 必填；仅提供要修改的字段，未提供字段保持不变。",
            properties = settingsModelSchema.getJSONObject("properties").keys().asSequence()
                .associateWith { key -> settingsModelSchema.getJSONObject("properties").getJSONObject(key) },
            required = listOf("name"),
        )

    val definitions: List<JSONObject> = listOf(
        function(
            "read_file",
            "读取应用私有安全工作区 files/newmark/workspace 内的 UTF-8 文本文件。路径不能越过该目录；返回路径、完整文件 SHA-256、截断标记和最多 48000 字符文本，可把 SHA-256 传给 write_file.expected_sha256 防止覆盖并发变化",
            mapOf("path" to prop("string", "安全工作区内的相对路径，或仍位于该目录内的绝对路径")),
            listOf("path"),
        ),
        function(
            "write_file",
            "增量或完整修改应用私有安全工作区内的 UTF-8 文本文件。overwrite 覆盖全文；append 追加 content；replace 用 old_text/new_text 替换唯一片段，多个命中需 replace_all=true。可传读取时取得的 expected_sha256 防止覆盖并发变化。路径不能越过安全目录",
            mapOf(
                "path" to prop("string", "安全工作区内目标文件的相对路径"),
                "action" to enumProp(listOf("overwrite", "append", "replace"), "文件更新方式；省略时兼容旧调用并按 overwrite"),
                "content" to prop("string", "overwrite 的完整正文或 append 的追加正文"),
                "old_text" to prop("string", "replace 要定位的原始文本片段"),
                "new_text" to prop("string", "replace 的替换文本，可为空字符串表示删除片段"),
                "replace_all" to prop("boolean", "replace 多处命中时是否全部替换，默认 false"),
                "expected_sha256" to prop("string", "可选；读取时记录的文件 SHA-256，目标变化时拒绝写入"),
            ),
            listOf("path"),
        ),
        function(
            "list_dir",
            "列出应用私有安全工作区内一个目录的直属文件和子目录，不访问共享存储。返回带类型标记的条目列表或路径错误",
            mapOf("path" to prop("string", "安全工作区内目录路径；省略或空字符串表示当前工作目录")),
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
            "读取 Memory Lab 的完整组件索引或指定组件内容。更新、重构或删除前应先读取最新 updatedAt；返回结构化索引或 Markdown 组件",
            mapOf("component" to prop("string", "组件 slug；省略或空字符串时读取完整索引")),
            emptyList(),
        ),
        function(
            "memory_lab_query",
            "按关键词查询 Memory Lab 组件名称、描述、标签和内容，返回有界的精简命中列表，不修改记忆数据",
            mapOf("query" to prop("string", "查询关键词")),
            listOf("query"),
        ),
        function(
            "memory_lab_update",
            "创建或局部更新一个 Memory Lab 组件。新建时提供 name、tags、content；更新时提供 component 与最新 expected_updated_at，只传要改变的 description/tags/tag_paths/kind/content，或使用 content_append、old_text/new_text 做正文增量修改。未提供字段保持不变",
            mapOf(
                "component" to prop("string", "局部更新时必填的现有组件 slug 或精确名称"),
                "name" to prop("string", "新建时的组件名称；局部更新仅允许不改变 slug 的显示名称调整"),
                "description" to prop("string", "可选的新组件描述；显式空字符串可清空"),
                "tags" to prop("string", "可选的完整新标签集合，逗号分隔；省略则保留"),
                "tag_paths" to prop("string", "可选的完整新标签路径 JSON；省略则保留"),
                "content" to prop("string", "可选的完整新 Markdown 正文"),
                "content_append" to prop("string", "可选；追加到现有 Markdown 正文末尾的文本"),
                "old_text" to prop("string", "可选；在现有正文中定位的待替换文本"),
                "new_text" to prop("string", "old_text 对应的替换文本，可为空"),
                "replace_all" to prop("boolean", "old_text 多处命中时是否全部替换"),
                "kind" to enumProp(listOf("file", "folder"), "可选的新存储类型；省略则保留"),
                "expected_updated_at" to prop("string", "更新已有组件时从最新读取结果取得的 updatedAt"),
                "reason" to prop("string", "本次持久记忆变更原因"),
                "source" to prop("string", "变更来源"),
            ),
            emptyList(),
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
            "根据当前 Memory Lab 组件文件重建标签和组件索引，不需要参数。返回重建后的标签数与组件数",
            emptyMap(),
            emptyList(),
        ),
        function(
            "settings_read",
            "读取移动端当前完整模型设置，不需要参数。返回 providers 数组和 active 对象；修改前先读取并保留未变字段，尤其是 provider id、API Key 和完整 models 数组。",
            emptyMap(),
            emptyList(),
        ),
        function(
            "settings_update",
            "增量更新移动端模型设置并立即生效。常用 action：provider_upsert 传 provider 局部字段；model_upsert 传 provider_id 和 model 局部字段；provider_delete/model_delete 需 confirm=true；切换当前模型只传 active 的变化字段。旧 providers 全量替换仍兼容但不推荐",
            mapOf(
                "action" to enumProp(listOf("provider_upsert", "provider_delete", "model_upsert", "model_delete"), "可选的增量设置动作；仅更新 active 时省略"),
                "provider" to settingsProviderPatchSchema,
                "model" to settingsModelPatchSchema,
                "provider_id" to prop("string", "model_upsert/model_delete 的供应商 id，或 provider_delete 的目标 id"),
                "model_name" to prop("string", "model_delete 的目标模型 name"),
                "confirm" to prop("boolean", "删除 provider 或 model 时必须为 true"),
                "active" to settingsActiveSchema,
                "providers" to arrayProp(settingsProviderSchema, "旧调用兼容：整体替换完整供应商数组；新调用不要使用"),
            ),
            emptyList(),
        ),
        function(
            "web_search",
            "通过 DuckDuckGo 搜索公开网页，不打开结果页面。返回匹配结果的标题、绝对 URL 与摘要；需要正文时再调用 web_fetch",
            mapOf("query" to prop("string", "搜索关键词")),
            listOf("query"),
        ),
        function(
            "web_fetch",
            "获取一个公开 HTTP 或 HTTPS 网页并提取有界可读文本，不执行页面交互。返回最终 URL、页面标题和正文，或网络/协议错误",
            mapOf("url" to prop("string", "完整 http:// 或 https:// 网页地址")),
            listOf("url"),
        ),
        browserUse(LocalToolCatalog.buildBrowserActions),
        function(
            "task_read",
            "读取当前本地对话持久化的 task/plan 清单，不需要参数且不修改任务。返回每项 id、文字和状态",
            emptyMap(),
            emptyList(),
        ),
        function(
            "task_create",
            "维护当前本地对话持久化的 task/plan 清单。create 需要 task 或 text；update 需要 id 或 index，并可传 task/text/status；clear 删除全部已完成项且不需要目标字段。返回更新后的任务状态或参数错误",
            mapOf(
                "action" to enumProp(listOf("create", "update", "clear"), "操作类型，只能是 create、update 或 clear"),
                "task" to prop("string", "create 的任务文字，或 update 的新文字；可用 text 作为别名"),
                "text" to prop("string", "task 字段的兼容别名；与 task 二选一"),
                "id" to prop("string", "update 要修改的任务 id；可用 index 替代"),
                "index" to prop("integer", "update 要修改的任务零基索引；可用 id 替代"),
                "status" to enumProp(listOf("pending", "in_progress", "done", "blocked"), "update 的新状态"),
            ),
            listOf("action"),
        ),
        function(
            "build_history_query",
            "只读查询当前对话已经持久化的历史 Build block，返回工具活动、状态和最终摘要，不恢复或重新执行历史任务。history_index 与 run_id 二选一；两者均省略时由运行时选择最近历史项",
            mapOf(
                "history_index" to prop("integer", "按最新到最旧的历史序号，1 表示上一条 Build block"),
                "run_id" to prop("string", "历史 Build block 的 run id，可替代 history_index"),
                "max_events" to prop("number", "最多返回活动条数，1 到 200"),
                "max_chars" to prop("number", "每条活动最多返回字符数，100 到 4000"),
            ),
            emptyList(),
        ),
        function(
            "context_compress",
            "主动压缩当前本地对话的模型上下文，显示历史保持不变。force=true 可在未达到自动阈值时执行；返回是否压缩、保留范围和摘要状态",
            mapOf(
                "force" to prop("boolean", "是否强制压缩"),
                "keep_recent" to prop("integer", "要保留的最近消息数，2 到 60；移动端会按安全窗口裁剪"),
            ),
            emptyList(),
        ),
        function(
            "context_history_manage",
            "只读管理当前对话的上下文压缩记录。status 返回当前压缩状态；search 按 query 检索记录；read 需要 restore_id 并读取指定记录。此工具不会恢复或覆盖最近上下文",
            mapOf(
                "action" to enumProp(listOf("status", "search", "read"), "只读操作，只能是 status、search 或 read"),
                "query" to prop("string", "search 使用的关键词；其他操作省略"),
                "restore_id" to prop("string", "read 要读取的压缩记录 id；其他操作省略"),
                "limit" to prop("integer", "search 最多返回的记录条数"),
            ),
            listOf("action"),
        ),
        function(
            "calendar_create",
            "在取得 Android WRITE_CALENDAR 运行时授权后，打开默认日程应用的新建界面，由用户检查并确认保存；工具不会静默保存。返回界面启动状态或授权/应用不可用错误",
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
            "在取得 Android READ_CALENDAR 运行时授权后读取系统日历中用户可见的日程，默认查询从现在起 30 天。返回有界的标题、时间、地点和说明列表或授权错误",
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
            "通过 Android 默认时钟应用创建或查看系统闹钟。create 需要 trigger_at_ms，并显示确认界面后由用户保存；list 不需要时间并打开系统闹钟列表。仅支持 create、list，不提供跨时钟应用的删除；返回界面启动状态或错误",
            mapOf(
                "action" to enumProp(listOf("create", "list"), "操作类型，只能是 create 或 list"),
                "trigger_at_ms" to prop("integer", "create 必填的未来 Unix epoch 毫秒；list 时省略"),
                "title" to prop("string", "create 的可选闹钟标题"),
                "message" to prop("string", "create 触发时显示的可选内容"),
            ),
            listOf("action"),
        ),
    )

    internal val capabilityDefinitions: List<JSONObject>
        get() = listOf(
            function(
                "files_read_all",
                "读取 Android 系统或 DocumentProvider 已授权的单个文件。需要应用内“读取所有文件”开关；content URI 不要求全盘路径权限。支持纯文本及 PDF、DOC/DOCX、PPT/PPTX、CSV/TSV、XLS/XLSX 结构化提取，并返回实际读取方法或错误",
                mapOf("path" to prop("string", "目标文件的 content:// URI，或系统已授权的共享存储绝对路径")),
                listOf("path"),
            ),
            function(
                "apps_list",
                "列出 Android 系统向 Newmark 可见的已安装应用。需要应用内“读取应用列表”开关和系统使用情况访问授权；返回 package name、版本和显示名称，不读取私有数据",
                emptyMap(),
                emptyList(),
            ),
            function(
                "files_manage",
                "在 Android 共享存储授权边界内管理文件。list/read/stat 只读；mkdir 创建目录；write 覆盖全文；append 追加；replace 局部替换；三种写入均可用 expected_sha256 防并发覆盖且更新后不超过 5 MiB。copy/move 拒绝覆盖；delete 需 confirm=true 且不递归",
                mapOf(
                "action" to enumProp(listOf("list", "read", "stat", "mkdir", "write", "append", "replace", "copy", "move", "delete"), "要执行的文件动作"),
                    "path" to prop("string", "共享存储内的源路径；不能越过共享存储根目录"),
                    "destination" to prop("string", "copy 或 move 的共享存储目标路径；其他动作省略"),
                    "content" to prop("string", "write 要覆盖写入的完整 UTF-8 文本；其他动作省略"),
                    "old_text" to prop("string", "replace 要定位的原始文本片段"),
                    "new_text" to prop("string", "replace 的替换文本，可为空"),
                    "replace_all" to prop("boolean", "replace 多处命中时是否全部替换"),
                    "expected_sha256" to prop("string", "write/append/replace 的可选并发保护哈希"),
                    "confirm" to prop("boolean", "delete 必须显式传 true；其他动作省略"),
                ),
                listOf("action", "path"),
            ),
            function(
                "apps_inspect",
                "读取 Android 系统授权范围内某个应用的公开包名、显示名、版本、启用状态、系统应用标记和声明权限。需要应用列表开关及系统授权；省略包名时返回可见应用列表，绝不读取其他应用私有数据",
                mapOf("package_name" to prop("string", "要检查的完整 Android package name；省略或空字符串时列出可见应用")),
                emptyList(),
            ),
            function(
                "skills_list",
                "读取移动端本地配置中当前启用的 Skill 名称，不需要参数且不安装、启用或执行 Skill。返回按名称排序的列表",
                emptyMap(),
                emptyList(),
            ),
            function(
                "mcp_list",
                "读取移动端本地配置中当前启用的 MCP 名称，不需要参数且不连接、启用或调用 MCP。返回按名称排序的列表",
                emptyMap(),
                emptyList(),
            ),
            function(
                "shizuku_exec",
                "通过当前已授权的 Shizuku shell 身份执行一条 Android shell 命令。仅在高权限模式开启且 Shizuku 服务可用时暴露；不会自动取得 Root。返回 stdout/stderr 和退出状态，命令效果由调用者负责",
                mapOf("command" to prop("string", "传给 Shizuku shell 的完整单行命令；不要包含未确认的破坏性操作")),
                listOf("command"),
            ),
            function(
                "root_exec",
                "通过设备当前可用的 su/Root 身份执行一条 Android shell 命令。仅在高权限模式开启且 Root 授权有效时暴露；不会回退到 Shizuku。返回 stdout/stderr 和退出状态，命令效果由调用者负责",
                mapOf("command" to prop("string", "传给 Root shell 的完整单行命令；不要包含未确认的破坏性操作")),
                listOf("command"),
            ),
            function(
                "adb_exec",
                "通过当前已授权的 Shizuku shell/ADB 身份执行一条 Android shell 命令，是 shizuku_exec 的兼容入口。仅在高权限模式开启且 Shizuku 服务可用时暴露；返回 stdout/stderr 和退出状态",
                mapOf("command" to prop("string", "传给 Shizuku/ADB shell 的完整单行命令；不要包含未确认的破坏性操作")),
                listOf("command"),
            ),
        )

    internal val planCapabilityDefinitions: List<JSONObject>
        get() = capabilityDefinitions.filterNot {
            it.optJSONObject("function")?.optString("name") in setOf("files_manage", "root_exec", "shizuku_exec", "adb_exec")
        } + function(
            "files_manage",
            "以 Plan 只读模式查看 Android 共享存储。需要应用内“读取所有文件”开关和系统全文件授权；只允许 list、read、stat，不能写入、移动或删除。返回目录条目、文本内容或文件元数据",
            mapOf(
                "action" to enumProp(listOf("list", "read", "stat"), "只读动作，只能是 list、read 或 stat"),
                "path" to prop("string", "共享存储内目标路径；不能越过共享存储根目录"),
            ),
            listOf("action", "path"),
        )

    /** Runtime exposure is capability-bound; stale model context cannot grant a tool. */
    fun definitionsFor(context: android.content.Context, mode: String = "build"): List<JSONObject> {
        val state = MobileCapabilityStore(context)
        val base = when (mode.lowercase()) {
            "chat" -> definitions.filter { it.optJSONObject("function")?.optString("name") in LocalToolCatalog.chatNames }
            "plan" -> planDefinitions + planCapabilityDefinitions
            else -> definitions + capabilityDefinitions
        }
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
        "操作当前本地对话的内置浏览器。navigate 需要 url；wait 可传 duration_ms；observe/extract 可传 max_chars；back、forward、reload 不需要附加字段。observe/extract 优先读取 DOM 或 PDF 文本层，文本不足时使用当前页面截图和设备端中英 OCR。返回页面状态、文本或导航错误。",
        mapOf(
            "action" to enumProp(actions, "当前模式允许的浏览器动作"),
            "url" to prop("string", "navigate 必填的完整 http:// 或 https:// 地址；其他动作省略"),
            "max_chars" to prop("integer", "observe 或 extract 返回的最大正文字符数"),
            "duration_ms" to prop("integer", "wait 等待的毫秒数；必须为非负值"),
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
