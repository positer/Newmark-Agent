package com.newmark.mobile.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** 记忆标签节点（对齐 PC MemoryLabTagNode） */
data class MemoryTagNode(
    val parents: List<String> = emptyList(),
    val children: List<String> = emptyList(),
    val components: List<String> = emptyList(),
    val aliases: List<String> = emptyList(),
)

/** 记忆组件（对齐 PC MemoryLabComponent） */
data class MemoryComponent(
    val name: String = "",
    val description: String = "",
    val tags: List<String> = emptyList(),
    val tagPaths: List<List<String>> = emptyList(),
    val path: String = "",
    val coreMd: String = "",
    val kind: String = "file",
    val createdAt: String = "",
    val updatedAt: String = "",
    val revision: Int = 1,
)

/** Memory Lab 索引（对齐 PC MemoryLabIndex；只读 + Reindex，写入仅由 Agent 工具完成） */
data class MemoryLabIndex(
    val version: Int = 2,
    val updatedAt: String = "",
    val preferredLanguage: String = "auto",
    val tags: Map<String, MemoryTagNode> = emptyMap(),
    val components: Map<String, MemoryComponent> = emptyMap(),
)

/**
 * 移动端本地 Memory Lab 存储。
 * 数据目录：files/newmark/Memory Lab/{index.json, components}
 * 只读 + Reindex（规范化重建），写入仅由本地 Agent 工具完成。
 */
class MemoryLabStore(context: Context) {

    private val appContext = context.applicationContext
    private val dir: File get() = File(appContext.filesDir, "newmark/Memory Lab").apply { mkdirs() }
    private val indexPath: File get() = File(dir, "index.json")
    val componentsDir: File get() = File(dir, "components").apply { mkdirs() }

    fun emptyIndex(): MemoryLabIndex = MemoryLabIndex(
        updatedAt = java.time.Instant.now().toString(),
    )

    fun load(): MemoryLabIndex = runCatching {
        if (!indexPath.exists()) emptyIndex()
        else parseIndex(JSONObject(indexPath.readText()))
    }.getOrDefault(emptyIndex())

    fun componentContent(slug: String): String {
        val meta = load().components[slug] ?: return ""
        val fallback = File(componentsDir, if (meta.kind == "folder") "$slug/memory.md" else "$slug.md")
        // Desktop indexes may carry an absolute coreMd from another package
        // (for example the stress application id). Prefer it only when it is
        // readable, then resolve the same relative component in this app.
        val indexed = meta.coreMd.takeIf { it.isNotBlank() }?.let(::File)
        val core = indexed?.takeIf { it.exists() && it.isFile } ?: fallback
        return runCatching { if (core.exists() && core.isFile) core.readText() else "" }.getOrDefault("")
    }

    /** 规范化重建索引（对齐 PC reindex 的排序/一致性语义，移动端只读场景为幂等重写） */
    fun reindex(): MemoryLabIndex {
        val index = load()
        val normalized = MemoryLabIndex(
            version = 2,
            updatedAt = java.time.Instant.now().toString(),
            preferredLanguage = index.preferredLanguage,
            tags = rebuildMemoryTags(index.tags, index.components),
            components = index.components.toSortedMap(),
        )
        save(normalized)
        return normalized
    }

    fun save(index: MemoryLabIndex) {
        dir.mkdirs()
        indexPath.writeText(toJson(index))
    }

    private fun parseIndex(json: JSONObject): MemoryLabIndex {
        val tags = mutableMapOf<String, MemoryTagNode>()
        json.optJSONObject("tags")?.let { tagsObj ->
            tagsObj.keys().forEach { tag ->
                val node = tagsObj.getJSONObject(tag)
                tags[tag] = MemoryTagNode(
                    parents = node.optJSONArray("parents")?.toStringList() ?: emptyList(),
                    children = node.optJSONArray("children")?.toStringList() ?: emptyList(),
                    components = node.optJSONArray("components")?.toStringList() ?: emptyList(),
                    aliases = node.optJSONArray("aliases")?.toStringList() ?: emptyList(),
                )
            }
        }
        val components = mutableMapOf<String, MemoryComponent>()
        json.optJSONObject("components")?.let { compObj ->
            compObj.keys().forEach { slug ->
                val c = compObj.getJSONObject(slug)
                components[slug] = MemoryComponent(
                    name = c.optString("name"),
                    description = c.optString("description"),
                    tags = c.optJSONArray("tags")?.toStringList() ?: emptyList(),
                    tagPaths = c.optJSONArray("tagPaths")?.let { arr ->
                        (0 until arr.length()).map { i ->
                            arr.getJSONArray(i).toStringList()
                        }
                    } ?: emptyList(),
                    path = c.optString("path"),
                    coreMd = c.optString("coreMd"),
                    kind = c.optString("kind", "file"),
                    createdAt = c.optString("createdAt"),
                    updatedAt = c.optString("updatedAt"),
                    revision = c.optInt("revision", 1),
                )
            }
        }
        return MemoryLabIndex(
            version = json.optInt("version", 2),
            updatedAt = json.optString("updatedAt"),
            preferredLanguage = json.optString("preferredLanguage", "auto"),
            tags = tags,
            components = components,
        )
    }

    private fun toJson(index: MemoryLabIndex): String {
        val root = JSONObject()
        root.put("version", index.version)
        root.put("updatedAt", index.updatedAt)
        root.put("preferredLanguage", index.preferredLanguage)
        root.put("tags", JSONObject().apply {
            index.tags.forEach { (tag, node) ->
                put(tag, JSONObject().apply {
                    put("parents", JSONArray(node.parents))
                    put("children", JSONArray(node.children))
                    put("components", JSONArray(node.components))
                    put("aliases", JSONArray(node.aliases))
                })
            }
        })
        root.put("components", JSONObject().apply {
            index.components.forEach { (slug, c) ->
                put(slug, JSONObject().apply {
                    put("name", c.name)
                    put("description", c.description)
                    put("tags", JSONArray(c.tags))
                    put("tagPaths", JSONArray().apply {
                        c.tagPaths.forEach { put(JSONArray(it)) }
                    })
                    put("path", c.path)
                    put("coreMd", c.coreMd)
                    put("kind", c.kind)
                    put("createdAt", c.createdAt)
                    put("updatedAt", c.updatedAt)
                    put("revision", c.revision)
                })
            }
        })
        return root.toString(2)
    }
}

internal fun rebuildMemoryTags(
    existing: Map<String, MemoryTagNode>,
    components: Map<String, MemoryComponent>,
): Map<String, MemoryTagNode> {
    data class MutableNode(
        val parents: MutableSet<String> = sortedSetOf(),
        val children: MutableSet<String> = sortedSetOf(),
        val components: MutableSet<String> = sortedSetOf(),
        val aliases: MutableSet<String> = sortedSetOf(),
    )

    val nodes = sortedMapOf<String, MutableNode>()
    fun node(tag: String): MutableNode = nodes.getOrPut(tag) { MutableNode() }
    existing.forEach { (tag, value) ->
        if (tag.isNotBlank()) node(tag).aliases += value.aliases.filter(String::isNotBlank)
    }
    components.toSortedMap().forEach { (slug, component) ->
        val paths = component.tagPaths.map { path -> path.filter(String::isNotBlank) }
        val componentTags = (component.tags + paths.flatten()).filter(String::isNotBlank).distinct()
        componentTags.forEach { tag -> node(tag).components += slug }
        paths.forEach { path ->
            path.zipWithNext().forEach { (parent, child) ->
                node(parent).children += child
                node(child).parents += parent
            }
        }
    }
    return nodes.mapValues { (_, value) ->
        MemoryTagNode(
            parents = value.parents.toList(),
            children = value.children.toList(),
            components = value.components.toList(),
            aliases = value.aliases.toList(),
        )
    }
}

private fun JSONArray.toStringList(): List<String> =
    (0 until length()).map { optString(it) }.filter { it.isNotBlank() }
