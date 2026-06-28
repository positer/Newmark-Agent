namespace Newmark.LLM;

using Newmark.Config;

/// <summary>
/// Manages all LLM providers: switching, validation, fuzzy injection, and model assessment.
/// </summary>
public class LLMManager
{
    private readonly ConfigManager _config;
    private readonly Dictionary<string, LLMProvider> _providers = new();
    private readonly Dictionary<string, Dictionary<string, object>> _validations = new();

    public LLMManager(ConfigManager config)
    {
        _config = config;
        InitProviders();
    }

    private void InitProviders()
    {
        foreach (var p in _config.GetProviders())
        {
            var name = p.GetValueOrDefault("name", "")?.ToString() ?? "";
            var apiKey = p.GetValueOrDefault("api_key", "")?.ToString() ?? "";
            var baseUrl = p.GetValueOrDefault("base_url", "")?.ToString() ?? "";
            if (!string.IsNullOrEmpty(name) && !string.IsNullOrEmpty(apiKey) && !string.IsNullOrEmpty(baseUrl))
                _providers[name] = new LLMProvider(name, baseUrl, apiKey);
        }
    }

    public LLMProvider? GetProvider(string modelName)
    {
        var model = _config.GetModel(modelName);
        if (model == null) return null;
        var providerName = model.GetValueOrDefault("provider", "")?.ToString() ?? "";
        return _providers.GetValueOrDefault(providerName);
    }

    public LLMProvider? GetCurrentProvider()
    {
        var defaultModel = _config.Get<string>("models", "default_model");
        return string.IsNullOrEmpty(defaultModel) ? _providers.Values.FirstOrDefault() : GetProvider(defaultModel);
    }

    public async Task<Dictionary<string, Dictionary<string, object>>> ValidateAllModelsAsync()
    {
        var results = new Dictionary<string, Dictionary<string, object>>();
        foreach (var model in _config.GetAllModels())
        {
            var providerName = model.GetValueOrDefault("provider", "")?.ToString() ?? "";
            if (!_providers.TryGetValue(providerName, out var provider)) continue;

            var modelName = model["name"]?.ToString() ?? "";
            var basic = await provider.ValidateAsync(modelName);
            results[modelName] = new Dictionary<string, object>
            {
                ["basic"] = basic, ["provider"] = providerName
            };
            _validations[modelName] = results[modelName];
        }
        return results;
    }

    public async Task<Dictionary<string, object>> AssessModelAsync(string modelName)
    {
        var model = _config.GetModel(modelName);
        if (model == null) return new() { ["error"] = $"Model {modelName} not found" };

        var provider = GetProvider(modelName);
        var cost = model.GetValueOrDefault("cost_per_1k_output", 0d);
        var assessment = new Dictionary<string, object>
        {
            ["name"] = modelName,
            ["cost"] = cost switch { < 0.005 => "cheap", < 0.03 => "medium", _ => "expensive" },
            ["performance"] = model.GetValueOrDefault("capability_rating", "unknown")?.ToString() ?? "unknown",
            ["speed"] = model.GetValueOrDefault("speed_rating", "unknown")?.ToString() ?? "unknown",
            ["validated"] = _validations.ContainsKey(modelName)
        };

        if (provider != null)
        {
            var validation = await provider.ValidateAsync(modelName);
            if (validation.TryGetValue("valid", out var valid) && valid is true)
            {
                var latency = validation.GetValueOrDefault("latency_seconds", 999d);
                assessment["latency"] = latency;
                assessment["speed_measured"] = latency switch { < 1.0 => "fast", < 3.0 => "medium", _ => "slow" };
            }
        }
        return assessment;
    }

    public string? SelectModelForTask(string taskType, string preference = "default")
    {
        var models = _config.GetAllModels();
        var validModels = models.Where(m =>
            _providers.ContainsKey(m.GetValueOrDefault("provider", "")?.ToString() ?? "")).ToList();

        if (validModels.Count == 0) return null;

        return preference switch
        {
            "cheap_save" => validModels.OrderBy(m =>
                m.TryGetValue("cost_per_1k_output", out var c) ? Convert.ToDouble(c) : 999).First()["name"]?.ToString(),
            "speed" => validModels.OrderBy(m =>
            {
                var r = m.GetValueOrDefault("speed_rating", "slow")?.ToString();
                return r switch { "fast" => 0, "medium" => 1, _ => 2 };
            }).First()["name"]?.ToString(),
            "performance" => validModels.OrderBy(m =>
            {
                var r = m.GetValueOrDefault("capability_rating", "low")?.ToString();
                return r switch { "high" => 0, "medium" => 1, _ => 2 };
            }).First()["name"]?.ToString(),
            _ => validModels.First()["name"]?.ToString()
        };
    }

    public async Task<Dictionary<string, object>> FuzzyInjectModelAsync(string baseUrl, string apiKey, string providerName = "custom")
    {
        var provider = new LLMProvider(providerName, baseUrl, apiKey);
        var discovered = await provider.ListModelsAsync();
        var validModels = new List<Dictionary<string, object>>();

        foreach (var modelName in discovered.Take(5))
        {
            var validation = await provider.ValidateAsync(modelName);
            if (validation.TryGetValue("valid", out var v) && v is true)
            {
                var vision = await provider.ValidateVisionAsync(modelName);
                validModels.Add(new Dictionary<string, object>
                {
                    ["name"] = modelName,
                    ["latency"] = validation.GetValueOrDefault("latency_seconds", 0d),
                    ["vision"] = vision.GetValueOrDefault("supports_vision", false)
                });
            }
        }

        if (validModels.Count == 0)
            return new() { ["success"] = false, ["error"] = "No valid models found", ["models"] = new List<object>() };

        _providers[providerName] = provider;
        return new()
        {
            ["success"] = true, ["provider"] = providerName,
            ["base_url"] = baseUrl, ["models"] = validModels
        };
    }
}
