package com.newmark.mobile.data

/**
 * Newmark 供应商模板。真实 API key 必须由用户在设备上配置，绝不进入源码或安装包。
 * 首次启动时作为「保存的供应商」种子数据，字段与 PC `models.providers` 保持同构。
 */
object NewmarkPresets {

    private fun tiers() = IntelligenceTiers(
        low = TierDescription("Quick"),
        medium = TierDescription("Balanced"),
        high = TierDescription("Deep"),
    )

    private fun model(
        name: String,
        display: String,
        maxTokens: Int,
        thinking: Boolean = false,
        speed: String = "fast",
        capability: String = "high",
    ) = ModelConfig(
        name = name,
        display = display,
        maxTokens = maxTokens,
        vision = false,
        thinking = thinking,
        imageOutput = false,
        enabled = true,
        privacy = listOf("default"),
        capabilities = listOf("text_input", "text_output", "tool_use"),
        speedRating = speed,
        capabilityRating = capability,
        intelligenceTiers = tiers(),
    )

    fun asProviders(): List<ProviderConfig> = listOf(
        ProviderConfig(
            id = "preset-deepseek",
            name = "DeepSeek",
            baseUrl = "https://api.deepseek.com/v1",
            apiKey = "",
            protocol = "openai",
            enabled = true,
            models = listOf(
                model("deepseek-v4-pro", "deepseek-v4-pro", 1000000, thinking = true),
                model("deepseek-v4-flash", "deepseek-v4-flash", 128000),
            ),
        ),
        ProviderConfig(
            id = "preset-apinebula",
            name = "APInebula",
            baseUrl = "https://apinebula.ai/v1",
            apiKey = "",
            protocol = "openai",
            enabled = true,
            models = listOf(
                model("gpt-5.4", "gpt-5.4", 128000, speed = "slow", capability = "medium"),
                model("gpt-5.4-mini", "gpt-5.4-mini", 128000, speed = "slow", capability = "medium"),
                model("gpt-5.6-sol", "gpt-5.6-sol", 128000),
            ),
        ),
        ProviderConfig(
            id = "preset-openai-hub",
            name = "OpenAI-Hub",
            baseUrl = "https://api.openai-hub.net/v1",
            apiKey = "",
            protocol = "openai",
            enabled = true,
            models = listOf(
                model("deepseek-v4-pro", "deepseek-v4-pro", 128000),
                model("gpt-5.6-sol", "gpt-5.6-sol", 128000),
                model("kimi-k3", "kimi-k3", 128000),
            ),
        ),
        ProviderConfig(
            id = "preset-opencode",
            name = "OpenCode",
            baseUrl = "https://opencode.ai/zen/go/v1",
            apiKey = "",
            protocol = "openai",
            enabled = true,
            models = listOf(
                model("kimi-k3", "kimi-k3", 128000),
                model("minimax-m3", "minimax-m3", 128000),
                model("glm-5.2", "glm-5.2", 128000),
            ),
        ),
    )
}
