package com.newmark.mobile.data

import com.google.gson.annotations.SerializedName
import org.json.JSONObject

/**
 * 模型/供应商持久化结构 —— 与 PC config.json `models.providers` 完全一致（snake_case 序列化）。
 * Kotlin 属性保持 camelCase，通过 @SerializedName 映射 PC 的字段名。
 */

/** 智能档位描述（intelligence_tiers.low/medium/high） */
data class TierDescription(
    @SerializedName("description") val description: String = "",
)

/** 智能档位（low=Quick / medium=Balanced / high=Deep） */
data class IntelligenceTiers(
    @SerializedName("low") val low: TierDescription = TierDescription(),
    @SerializedName("medium") val medium: TierDescription = TierDescription(),
    @SerializedName("high") val high: TierDescription = TierDescription(),
) {
    fun label(tier: String): String = when (tier) {
        "low" -> low.description.ifBlank { "Quick" }
        "high" -> high.description.ifBlank { "Deep" }
        else -> medium.description.ifBlank { "Balanced" }
    }
}

/** 供应商所属模型（对齐 PC models.providers[].models[]） */
data class ModelConfig(
    @SerializedName("name") val name: String = "",
    @SerializedName("display") val display: String = "",
    @SerializedName("description") val description: String = "",
    @SerializedName("max_tokens") val maxTokens: Int = 0,
    @SerializedName("vision") val vision: Boolean = false,
    @SerializedName("thinking") val thinking: Boolean = false,
    @SerializedName("image_output") val imageOutput: Boolean = false,
    @SerializedName("enabled") val enabled: Boolean = true,
    @SerializedName("preview") val preview: Boolean = false,
    @SerializedName("privacy") val privacy: List<String> = emptyList(),
    @SerializedName("capabilities") val capabilities: List<String> = emptyList(),
    @SerializedName("fallback_only") val fallbackOnly: Boolean = false,
    @SerializedName("speed_rating") val speedRating: String = "",
    @SerializedName("capability_rating") val capabilityRating: String = "",
    @SerializedName("intelligence_tiers") val intelligenceTiers: IntelligenceTiers = IntelligenceTiers(),
    @SerializedName("thinking_tier_map") val thinkingTierMap: Map<String, String> = emptyMap(),
) {
    val label: String get() = display.ifBlank { name }
}

/** 一个模型供应商（对齐 PC models.providers[]） */
data class ProviderConfig(
    @SerializedName("id") val id: String = "",
    @SerializedName("name") val name: String = "",
    @SerializedName("base_url") val baseUrl: String = "",
    @SerializedName("api_key") val apiKey: String = "",
    @SerializedName("protocol") val protocol: String = "openai",
    @SerializedName("enabled") val enabled: Boolean = true,
    @SerializedName("has_api_key") val hasApiKey: Boolean = true,
    @SerializedName("models") val models: List<ModelConfig> = emptyList(),
) {
    val label: String get() = name.ifBlank { "未命名供应商" }

    /** 生成该供应商某个模型的 OpenAI 兼容调用配置 */
    fun toApiConfig(model: ModelConfig): ApiConfig =
        ApiConfig(baseUrl = baseUrl, apiKey = apiKey, model = model.name)
}

data class ProviderCatalogMergeResult(
    val providers: List<ProviderConfig>,
    val addedProviders: Int,
    val addedModels: Int,
)

internal fun createManualProviderConfig(
    id: String,
    name: String,
    baseUrl: String,
    apiKey: String,
    protocol: String,
): ProviderConfig {
    val normalizedName = name.trim()
    val normalizedProtocol = protocol.trim().lowercase().ifBlank { "openai" }
    require(normalizedName.isNotBlank()) { "provider name is required" }
    require(normalizedProtocol in setOf("openai", "anthropic", "github_models")) {
        "unsupported provider protocol: $normalizedProtocol"
    }
    val normalizedUrl = baseUrl.trim().ifBlank {
        if (normalizedProtocol == "github_models") "https://models.github.ai" else ""
    }.trimEnd('/')
    require(normalizedUrl.isNotBlank()) { "provider endpoint is required" }
    require(id.isNotBlank()) { "provider id is required" }
    return ProviderConfig(
        id = id,
        name = normalizedName,
        baseUrl = normalizedUrl,
        apiKey = apiKey.trim(),
        protocol = normalizedProtocol,
        enabled = true,
        hasApiKey = apiKey.trim().isNotBlank(),
        models = emptyList(),
    )
}

internal fun createManualModelConfig(
    name: String,
    display: String,
    description: String,
    maxTokens: Int,
    vision: Boolean,
    thinking: Boolean,
): ModelConfig {
    val normalizedName = name.trim()
    require(normalizedName.isNotBlank()) { "model name is required" }
    require(maxTokens > 0) { "max tokens must be positive" }
    return ModelConfig(
        name = normalizedName,
        display = display.trim().ifBlank { normalizedName },
        description = description.trim(),
        maxTokens = maxTokens,
        vision = vision,
        thinking = thinking,
        enabled = true,
    )
}

/**
 * Merge an explicitly exported provider catalog into local settings. Existing
 * local credentials win; a previously redacted pull is repaired from the new
 * credential-bearing export instead of creating a duplicate provider.
 */
fun mergeProviderCatalogEntries(
    existing: List<ProviderConfig>,
    incoming: List<ProviderConfig>,
    uniqueSuffix: () -> String = { java.util.UUID.randomUUID().toString() },
): ProviderCatalogMergeResult {
    var addedProviders = 0
    var addedModels = 0
    val merged = existing.toMutableList()
    incoming.forEach { remote ->
        val normalizedUrl = remote.baseUrl.trim().trimEnd('/').lowercase()
        val index = merged.indexOfFirst { local ->
            local.id == remote.id || (
                normalizedUrl.isNotBlank() &&
                    local.baseUrl.trim().trimEnd('/').lowercase() == normalizedUrl &&
                    local.protocol.equals(remote.protocol, ignoreCase = true)
                )
        }
        if (index < 0) {
            val baseId = remote.id.ifBlank { "device-${uniqueSuffix()}" }
            val uniqueId = if (merged.none { it.id == baseId }) baseId else "$baseId-${uniqueSuffix()}"
            merged += remote.copy(
                id = uniqueId,
                hasApiKey = remote.apiKey.isNotBlank() || remote.hasApiKey,
            )
            addedProviders += 1
            addedModels += remote.models.distinctBy { it.name.lowercase() }.size
        } else {
            val local = merged[index]
            val known = local.models.map { it.name.lowercase() }.toMutableSet()
            val additions = remote.models.filter { it.name.isNotBlank() && known.add(it.name.lowercase()) }
            val mergedApiKey = local.apiKey.ifBlank { remote.apiKey }
            merged[index] = local.copy(
                name = local.name.ifBlank { remote.name },
                baseUrl = local.baseUrl.ifBlank { remote.baseUrl },
                apiKey = mergedApiKey,
                protocol = local.protocol.ifBlank { remote.protocol },
                hasApiKey = mergedApiKey.isNotBlank() || local.hasApiKey || remote.hasApiKey,
                models = local.models + additions,
            )
            addedModels += additions.size
        }
    }
    return ProviderCatalogMergeResult(merged, addedProviders, addedModels)
}

/** 模型选择对话框候选项（输入框模型按钮弹出） */
data class ModelOption(
    val providerId: String = "",
    val modelName: String = "",
    val label: String = "",
    val providerLabel: String = "",
    val displayName: String = "",
)

/** 智能档位（对齐 PC IntelligenceTier：low/medium/high/xhigh/max/ultra，显示即档位名） */
val INTELLIGENCE_TIERS: List<String> = listOf("low", "medium", "high", "xhigh", "max", "ultra")

internal fun patchProviderConfig(existing: ProviderConfig?, patch: JSONObject): ProviderConfig {
    val id = patch.optString("id").ifBlank { existing?.id.orEmpty() }
    require(id.isNotBlank()) { "provider_patch.id is required" }
    return ProviderConfig(
        id = id,
        name = if (patch.has("name")) patch.optString("name") else existing?.name.orEmpty(),
        baseUrl = if (patch.has("base_url")) patch.optString("base_url") else existing?.baseUrl.orEmpty(),
        apiKey = if (patch.has("api_key")) patch.optString("api_key") else existing?.apiKey.orEmpty(),
        protocol = if (patch.has("protocol")) patch.optString("protocol", "openai") else existing?.protocol ?: "openai",
        enabled = if (patch.has("enabled")) patch.optBoolean("enabled") else existing?.enabled ?: true,
        hasApiKey = when {
            patch.has("has_api_key") -> patch.optBoolean("has_api_key")
            patch.has("api_key") -> patch.optString("api_key").isNotBlank()
            else -> existing?.hasApiKey ?: false
        },
        models = existing?.models ?: emptyList(),
    )
}

internal fun patchModelConfig(existing: ModelConfig?, patch: JSONObject): ModelConfig {
    val name = patch.optString("name").ifBlank { existing?.name.orEmpty() }
    require(name.isNotBlank()) { "model_patch.name is required" }
    fun strings(key: String, fallback: List<String>) = if (patch.has(key)) {
        patch.optJSONArray(key)?.let { array -> (0 until array.length()).map(array::optString).filter(String::isNotBlank) } ?: emptyList()
    } else fallback
    fun tierDescriptions(key: String, fallback: IntelligenceTiers): IntelligenceTiers {
        val value = patch.optJSONObject(key) ?: return fallback
        fun tier(name: String, old: TierDescription) = value.optJSONObject(name)?.let { node ->
            if (node.has("description")) TierDescription(node.optString("description")) else old
        } ?: old
        return IntelligenceTiers(tier("low", fallback.low), tier("medium", fallback.medium), tier("high", fallback.high))
    }
    fun tierMap(key: String, fallback: Map<String, String>): Map<String, String> {
        val value = patch.optJSONObject(key) ?: return fallback
        return value.keys().asSequence().associateWith(value::optString).filterValues(String::isNotBlank)
    }
    val old = existing ?: ModelConfig(name = name)
    return old.copy(
        name = name,
        display = if (patch.has("display")) patch.optString("display") else old.display,
        description = if (patch.has("description")) patch.optString("description") else old.description,
        maxTokens = if (patch.has("max_tokens")) patch.optInt("max_tokens") else old.maxTokens,
        vision = if (patch.has("vision")) patch.optBoolean("vision") else old.vision,
        thinking = if (patch.has("thinking")) patch.optBoolean("thinking") else old.thinking,
        imageOutput = if (patch.has("image_output")) patch.optBoolean("image_output") else old.imageOutput,
        enabled = if (patch.has("enabled")) patch.optBoolean("enabled") else old.enabled,
        preview = if (patch.has("preview")) patch.optBoolean("preview") else old.preview,
        privacy = strings("privacy", old.privacy),
        capabilities = strings("capabilities", old.capabilities),
        fallbackOnly = if (patch.has("fallback_only")) patch.optBoolean("fallback_only") else old.fallbackOnly,
        speedRating = if (patch.has("speed_rating")) patch.optString("speed_rating") else old.speedRating,
        capabilityRating = if (patch.has("capability_rating")) patch.optString("capability_rating") else old.capabilityRating,
        intelligenceTiers = tierDescriptions("intelligence_tiers", old.intelligenceTiers),
        thinkingTierMap = tierMap("thinking_tier_map", old.thinkingTierMap),
    )
}

internal fun patchActiveModel(existing: ActiveModel, patch: JSONObject): ActiveModel = ActiveModel(
    providerId = if (patch.has("provider_id") || patch.has("providerId")) patch.optString("provider_id", patch.optString("providerId")) else existing.providerId,
    modelName = if (patch.has("model_name") || patch.has("modelName")) patch.optString("model_name", patch.optString("modelName")) else existing.modelName,
    intelligence = if (patch.has("intelligence")) normalizedMobileIntelligence(patch.optString("intelligence")) else existing.intelligence,
)
