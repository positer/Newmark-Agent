package com.newmark.mobile.data

import org.json.JSONArray
import org.json.JSONObject

/** 本地 Agent 工具定义（OpenAI function calling schema），供本地对话 tool-call 使用 */
object LocalTools {

    private fun prop(type: String, description: String): JSONObject =
        JSONObject().put("type", type).put("description", description)

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
            "memory_lab_read",
            "读取本地 Memory Lab 索引，或读取单个记忆组件",
            mapOf("component" to prop("string", "组件 slug（留空读取全部索引）")),
            emptyList(),
        ),
        function(
            "memory_lab_query",
            "按关键词查询本地 Memory Lab 记忆组件",
            mapOf("query" to prop("string", "查询关键词")),
            listOf("query"),
        ),
        function(
            "memory_lab_update",
            "创建或更新一个本地 Memory Lab 记忆组件",
            mapOf(
                "name" to prop("string", "记忆组件名称"),
                "tags" to prop("string", "标签（逗号分隔，可带 # 前缀）"),
                "content" to prop("string", "记忆组件核心内容（markdown）"),
            ),
            listOf("name", "tags", "content"),
        ),
        function(
            "memory_lab_reindex",
            "重建本地 Memory Lab 索引",
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
    )
}
