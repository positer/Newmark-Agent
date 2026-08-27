package com.newmark.mobile.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

data class MemoryLabUpdateInput(
    val name: String,
    val description: String = "",
    val tags: List<String>,
    val tagPaths: List<List<String>> = emptyList(),
    val content: String,
    val kind: String = "file",
    val expectedUpdatedAt: String = "",
    val reason: String = "",
    val source: String = "memory_lab_update",
)

data class MemoryLabPatchInput(
    val component: String,
    val name: String? = null,
    val description: String? = null,
    val tags: List<String>? = null,
    val tagPaths: List<List<String>>? = null,
    val content: String? = null,
    val contentAppend: String? = null,
    val oldText: String? = null,
    val newText: String = "",
    val replaceAll: Boolean = false,
    val kind: String? = null,
    val expectedUpdatedAt: String = "",
    val reason: String = "",
    val source: String = "memory_lab_update",
)

data class MemoryLabWriteResult(
    val index: MemoryLabIndex,
    val slug: String = "",
    val component: MemoryComponent? = null,
    val rebuildReceipt: JSONObject,
)

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
    private val archiveDir: File get() = File(dir, "archive").apply { mkdirs() }
    private val policyLog: File get() = File(dir, "policy.jsonl")
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
        val normalized = normalizeMemoryIndex(index)
        save(normalized)
        return normalized
    }

    fun save(index: MemoryLabIndex) {
        dir.mkdirs()
        indexPath.writeText(toJson(index))
    }

    @Synchronized
    fun update(input: MemoryLabUpdateInput): MemoryLabWriteResult {
        val name = input.name.trim().ifBlank { error("Memory component name is required") }
        val content = input.content.trim().ifBlank { error("Memory component content is required") }
        val slug = slugifyMemory(name)
        val oldIndex = load()
        val existing = oldIndex.components[slug]
        if (existing != null && input.expectedUpdatedAt.isNotBlank() && input.expectedUpdatedAt != existing.updatedAt) {
            error("Memory component changed since it was read: $slug")
        }
        if (existing != null) archiveComponentRevision(slug, existing)
        val normalizedPaths = input.tagPaths.map { it.map(String::trim).filter(String::isNotBlank) }.filter(List<String>::isNotEmpty)
        val normalizedTags = (input.tags + normalizedPaths.flatten()).map(String::trim).filter(String::isNotBlank).distinct()
        require(normalizedTags.isNotEmpty()) { "At least one tag is required" }
        val now = java.time.Instant.now().toString()
        val kind = if (input.kind == "folder") "folder" else "file"
        val container = if (kind == "folder") File(componentsDir, slug) else File(componentsDir, "$slug.md")
        val core = if (kind == "folder") File(container, "memory.md") else container
        core.parentFile?.mkdirs()
        core.writeText(content)
        val component = MemoryComponent(
            name = name, description = input.description.trim(), tags = normalizedTags,
            tagPaths = normalizedPaths.ifEmpty { normalizedTags.map(::listOf) },
            path = container.absolutePath, coreMd = core.absolutePath, kind = kind,
            createdAt = existing?.createdAt ?: now, updatedAt = now,
            revision = (existing?.revision ?: 0) + 1,
        )
        val next = oldIndex.copy(updatedAt = now, components = (oldIndex.components + (slug to component)).toSortedMap())
        val rebuilt = normalizeMemoryIndex(next)
        save(rebuilt)
        appendPolicy(if (existing == null) "add" else "update", slug, input.reason, input.source, component.revision, sha256(content))
        return MemoryLabWriteResult(rebuilt, slug, component, receipt(if (existing == null) "update" else "update", rebuilt, slug))
    }

    @Synchronized
    fun patch(input: MemoryLabPatchInput): MemoryLabWriteResult {
        val index = load()
        val oldSlug = resolveSlug(index, input.component) ?: error("Memory component not found: ${input.component}")
        val existing = index.components.getValue(oldSlug)
        if (input.expectedUpdatedAt.isNotBlank() && input.expectedUpdatedAt != existing.updatedAt) {
            error("Memory component changed since it was read: $oldSlug")
        }
        val oldContent = componentContent(oldSlug)
        val nextContent = when {
            input.content != null -> input.content
            input.contentAppend != null -> oldContent + input.contentAppend
            input.oldText != null -> {
                require(input.oldText.isNotEmpty()) { "old_text must not be empty" }
                val count = oldContent.windowed(input.oldText.length, 1).count { it == input.oldText }
                require(count > 0) { "old_text not found" }
                require(count == 1 || input.replaceAll) { "old_text matched $count places; pass replace_all=true or a unique fragment" }
                if (input.replaceAll) oldContent.replace(input.oldText, input.newText) else oldContent.replaceFirst(input.oldText, input.newText)
            }
            else -> oldContent
        }
        val nextName = input.name ?: existing.name
        val nextTags = input.tags ?: input.tagPaths?.flatten() ?: existing.tags
        val nextPaths = input.tagPaths ?: input.tags?.map(::listOf) ?: existing.tagPaths
        val nextKind = input.kind ?: existing.kind
        val nextSlug = slugifyMemory(nextName)
        require(nextSlug == oldSlug) { "renaming a Memory Lab component is not supported by incremental patch; create the new component then delete the old one" }
        return update(MemoryLabUpdateInput(
            name = nextName,
            description = input.description ?: existing.description,
            tags = nextTags,
            tagPaths = nextPaths,
            content = nextContent,
            kind = nextKind,
            expectedUpdatedAt = existing.updatedAt,
            reason = input.reason,
            source = input.source,
        ))
    }

    @Synchronized
    fun delete(componentSelector: String, expectedUpdatedAt: String = "", reason: String = "", source: String = "memory_lab_delete"): MemoryLabWriteResult {
        val index = load()
        val slug = resolveSlug(index, componentSelector) ?: error("Memory component not found: $componentSelector")
        val existing = index.components.getValue(slug)
        if (expectedUpdatedAt.isNotBlank() && expectedUpdatedAt != existing.updatedAt) error("Memory component changed since it was read: $slug")
        archiveComponentRevision(slug, existing)
        val target = File(if (existing.kind == "folder") existing.path else existing.coreMd)
        if (target.exists()) target.deleteRecursively()
        val now = java.time.Instant.now().toString()
        val nextComponents = index.components - slug
        val next = normalizeMemoryIndex(index.copy(updatedAt = now, components = nextComponents))
        save(next)
        appendPolicy("delete", slug, reason, source, existing.revision, "")
        return MemoryLabWriteResult(next, slug, null, receipt("delete", next, slug))
    }

    fun readJson(componentSelector: String = ""): JSONObject {
        val index = load()
        return JSONObject().put("ok", true).put("instructions", instructions()).put("index", JSONObject(toJson(index))).apply {
            if (componentSelector.isNotBlank()) {
                val slug = resolveSlug(index, componentSelector)
                if (slug == null) put("error", "Memory component not found: $componentSelector")
                else put("component", JSONObject().put("slug", slug).put("meta", JSONObject(toJson(index)).getJSONObject("components").getJSONObject(slug)).put("content", componentContent(slug)))
            }
        }
    }

    fun instructions(): String = "Memory Lab tool contract: read/query first. Create with name/tags/content; tag_paths is JSON array of tag-path arrays. Patch an existing component with component + latest expected_updated_at and only changed fields; use content_append or old_text/new_text for small content edits. Delete with component + latest expected_updated_at. Mutations return a receipt and are archived in policy.jsonl. Never print tool schemas or repeat the full index in chat."

    private fun resolveSlug(index: MemoryLabIndex, selector: String): String? {
        val value = selector.trim()
        return index.components.keys.firstOrNull { it == value } ?: index.components.entries.firstOrNull { it.value.name.equals(value, true) }?.key
    }

    private fun archiveComponentRevision(slug: String, component: MemoryComponent): String {
        val stamp = java.time.Instant.now().toString().replace(":", "-")
        val folder = File(archiveDir, "$slug/$stamp-r${component.revision}").apply { mkdirs() }
        File(folder, "meta.json").writeText(JSONObject().put("slug", slug).put("name", component.name).put("updatedAt", component.updatedAt).put("revision", component.revision).toString(2))
        File(folder, "memory.md").writeText(componentContent(slug))
        return folder.absolutePath
    }

    private fun appendPolicy(operation: String, slug: String, reason: String, source: String, revision: Int, contentHash: String) {
        policyLog.appendText(JSONObject().put("at", java.time.Instant.now().toString()).put("operation", operation).put("slug", slug)
            .put("reason", reason.ifBlank { "Durable memory mutation." }).put("source", source).put("revision", revision).put("contentSha256", contentHash).toString() + "\n")
    }

    private fun receipt(operation: String, index: MemoryLabIndex, slug: String) = JSONObject()
        .put("operation", operation).put("completed", true).put("indexUpdatedAt", index.updatedAt)
        .put("verifiedAt", java.time.Instant.now().toString()).put("slug", slug)

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

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

internal fun normalizeMemoryIndex(index: MemoryLabIndex): MemoryLabIndex {
    val aliasGroups = collectMemoryAliasGroups(index.tags, index.preferredLanguage)
    val aliasLookup = mutableMapOf<String, String>()
    aliasGroups.forEach { (canonical, names) ->
        aliasLookup[memoryTagComparisonKey(canonical)] = canonical
        names.forEach { aliasLookup[memoryTagComparisonKey(it)] = canonical }
    }
    fun canonical(tag: String): String = aliasLookup[memoryTagComparisonKey(tag)] ?: normalizeMemoryTag(tag)
    val components = index.components.toSortedMap().mapValues { (_, component) ->
        val tags = component.tags.map(::canonical).filter(String::isNotBlank).distinct().sorted()
        val paths = component.tagPaths.map { path ->
            path.map(::canonical).filter(String::isNotBlank).fold(emptyList<String>()) { acc, tag ->
                if (acc.lastOrNull() == tag) acc else acc + tag
            }
        }.filter(List<String>::isNotEmpty).distinctBy { it.joinToString("\u0000") }.sortedBy { it.joinToString("\u0000") }
        component.copy(tags = tags, tagPaths = paths)
    }
    // Rebuild only from canonicalized component relationships. Feeding the raw
    // tag map back in would resurrect synonym nodes that were just merged.
    val rebuilt = rebuildMemoryTags(emptyMap(), components).toMutableMap()
    rebuilt.keys.toList().forEach { tag ->
        val aliases = aliasGroups[tag].orEmpty().filter { it != tag }.distinct().sorted()
        rebuilt[tag] = rebuilt.getValue(tag).copy(aliases = aliases)
    }
    return MemoryLabIndex(
        version = 2,
        updatedAt = java.time.Instant.now().toString(),
        preferredLanguage = index.preferredLanguage,
        tags = rebuilt.toSortedMap(),
        components = components,
    )
}

private fun collectMemoryAliasGroups(
    tags: Map<String, MemoryTagNode>,
    preferredLanguage: String,
): Map<String, List<String>> {
    val groups = mutableMapOf<String, MutableSet<String>>()
    tags.forEach { (rawTag, node) ->
        val names = (listOf(rawTag) + node.aliases).map(::normalizeMemoryTag).filter(String::isNotBlank).distinct()
        names.forEach { name ->
            val group = groups.getOrPut(memorySynonymKey(name)) { sortedSetOf() }
            group += names
        }
    }
    return groups.values.associate { values ->
        val all = values.toList().sorted()
        choosePrimaryMemoryTag(all, preferredLanguage) to all
    }
}

private fun normalizeMemoryTag(value: String): String {
    val raw = value.trim()
    if (raw.isBlank()) return ""
    val body = raw.removePrefix("#").trim().replace(Regex("[\\s_]+"), "-").replace(Regex("-+"), "-")
    return body.takeIf(String::isNotBlank)?.let { "#$it" }.orEmpty()
}

private fun memoryTagComparisonKey(tag: String): String =
    tag.removePrefix("#").trim().lowercase().replace(Regex("[\\s_]+"), "-")

private fun memorySynonymKey(tag: String): String {
    val key = memoryTagComparisonKey(tag)
    return mapOf(
        "physics" to "physics", "物理" to "physics",
        "mathematics" to "mathematics", "math" to "mathematics", "数学" to "mathematics",
        "theoretical-physics" to "theoretical-physics", "理论物理" to "theoretical-physics",
        "agent" to "agent", "智能体" to "agent",
        "skill" to "skill", "skills" to "skill", "技能" to "skill",
        "memory" to "memory", "记忆" to "memory",
        "model" to "model", "模型" to "model",
        "provider" to "provider", "供应商" to "provider",
        "release" to "release", "发布" to "release",
        "code" to "code", "代码" to "code",
        "research" to "research", "研究" to "research",
    )[key] ?: key
}

private fun choosePrimaryMemoryTag(tags: List<String>, preferredLanguage: String): String {
    val chinese = tags.filter { Regex("[\\u3400-\\u9fff]").containsMatchIn(it) }
    val nonChinese = tags.filterNot { Regex("[\\u3400-\\u9fff]").containsMatchIn(it) }
    val pool = when (preferredLanguage) {
        "zh" -> chinese
        "en" -> nonChinese
        else -> emptyList()
    }.ifEmpty { tags }
    return pool.minWithOrNull(compareBy<String> { it.length }.thenBy { it }) ?: tags.first()
}

private fun JSONArray.toStringList(): List<String> =
    (0 until length()).map { optString(it) }.filter { it.isNotBlank() }

internal fun slugifyMemory(value: String): String = value.trim().lowercase()
    .replace(Regex("[^\\p{L}\\p{N}]+"), "-").trim('-').ifBlank { "memory" }
