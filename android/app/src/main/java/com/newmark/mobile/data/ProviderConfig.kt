package com.newmark.mobile.data

import com.google.gson.annotations.SerializedName

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
