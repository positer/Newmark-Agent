namespace Newmark.Config;

/// <summary>
/// Configuration manager for Newmark Agent.
/// Loads root config.json, handles workspace-specific overrides,
/// provides validation and settings adjustment.
/// </summary>
public class ConfigManager
{
    private readonly string _rootPath;
    private string _configPath;
    public string ConfigPath => _configPath;
    private Dictionary<string, object> _config = new();
    private Dictionary<string, object> _workspaceOverrides = new();

    public ConfigManager(string rootPath)
    {
        _rootPath = rootPath;
        _configPath = Path.Combine(rootPath, "config.json");
        Load();
    }

    public void Load()
    {
        if (File.Exists(_configPath))
        {
            string json = File.ReadAllText(_configPath);
            _config = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, object>>(json) ?? new();
        }
        else
        {
            _config = GetDefaults();
        }
    }

    public void Save()
    {
        var options = new System.Text.Json.JsonSerializerOptions { WriteIndented = true };
        string json = System.Text.Json.JsonSerializer.Serialize(_config, options);
        File.WriteAllText(_configPath, json);
    }

    public T? Get<T>(string section, string key)
    {
        string wsKey = $"{section}.{key}";
        if (_workspaceOverrides.TryGetValue(wsKey, out var overrideVal))
            return (T?)overrideVal;

        if (_config.TryGetValue(section, out var sectionObj) && sectionObj is Dictionary<string, object> sectionDict)
        {
            if (sectionDict.TryGetValue(key, out var raw))
            {
                if (raw is Dictionary<string, object> nested && nested.TryGetValue("value", out var val))
                    return ConvertValue<T>(val);
                return ConvertValue<T>(raw);
            }
        }
        return default;
    }

    public void Set(string section, string key, object value)
    {
        if (!_config.ContainsKey(section))
            _config[section] = new Dictionary<string, object>();

        if (_config[section] is Dictionary<string, object> sectionDict)
        {
            if (sectionDict.TryGetValue(key, out var existing) && existing is Dictionary<string, object> existingDict)
            {
                existingDict["value"] = value;
            }
            else
            {
                sectionDict[key] = new Dictionary<string, object> { ["value"] = value };
            }
        }
    }

    public void LoadWorkspaceConfig(string workspacePath)
    {
        string wsConfigPath = Path.Combine(workspacePath, "config.json");
        if (File.Exists(wsConfigPath))
        {
            string json = File.ReadAllText(wsConfigPath);
            var wsConfig = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, object>>(json);
            _workspaceOverrides.Clear();
            if (wsConfig != null)
            {
                foreach (var (section, items) in wsConfig)
                {
                    if (items is Dictionary<string, object> sectionItems)
                    {
                        foreach (var (key, raw) in sectionItems)
                        {
                            if (raw is Dictionary<string, object> nested && nested.TryGetValue("value", out var val))
                                _workspaceOverrides[$"{section}.{key}"] = val;
                            else
                                _workspaceOverrides[$"{section}.{key}"] = raw;
                        }
                    }
                }
            }
        }
    }

    public void ClearWorkspaceOverrides()
    {
        _workspaceOverrides.Clear();
    }

    public List<string> Validate()
    {
        var issues = new List<string>();
        string[] required = { "general", "models", "agent", "workspace", "skills", "ui", "web", "git", "terminal" };
        foreach (var section in required)
            if (!_config.ContainsKey(section))
                issues.Add($"Missing section: {section}");
        return issues;
    }

    public Dictionary<string, object> GetFullConfig() => new(_config);

    public List<Dictionary<string, object>> GetProviders()
    {
        var providers = Get<System.Text.Json.JsonElement?>("models", "providers");
        if (providers == null) return new();

        var list = new List<Dictionary<string, object>>();
        foreach (var element in providers.Value.EnumerateArray())
        {
            var dict = new Dictionary<string, object>();
            foreach (var prop in element.EnumerateObject())
            {
                dict[prop.Name] = ConvertElement(prop.Value);
            }
            if (dict.TryGetValue("enabled", out var en) && en is bool b && !b)
                continue;
            list.Add(dict);
        }
        return list;
    }

    public List<Dictionary<string, object>> GetAllModels()
    {
        var models = new List<Dictionary<string, object>>();
        foreach (var provider in GetProviders())
        {
            if (provider.TryGetValue("models", out var modelsObj) && modelsObj is List<object> modelList)
            {
                foreach (var m in modelList)
                {
                    if (m is Dictionary<string, object> model)
                    {
                        model["provider"] = provider.GetValueOrDefault("name", "");
                        model["provider_url"] = provider.GetValueOrDefault("base_url", "");
                        model["api_key"] = provider.GetValueOrDefault("api_key", "");
                        models.Add(model);
                    }
                }
            }
        }
        return models;
    }

    public Dictionary<string, object>? GetModel(string modelName)
    {
        return GetAllModels().FirstOrDefault(m => m.GetValueOrDefault("name", "")?.ToString() == modelName);
    }

    public void UpdateModelDescription(string modelName, string description, double? cost = null,
        string? speed = null, string? capability = null)
    {
        var providers = Get<System.Text.Json.JsonElement?>("models", "providers");
        if (providers == null) return;

        var raw = _config["models"] as Dictionary<string, object>;
        if (raw == null || !raw.ContainsKey("providers")) return;

        var providersVal = raw["providers"] as Dictionary<string, object>;
        if (providersVal == null || !providersVal.ContainsKey("value")) return;

        if (providersVal["value"] is System.Text.Json.JsonElement pv)
        {
            var updated = System.Text.Json.JsonSerializer.Deserialize<object[]>(pv.GetRawText()) ?? Array.Empty<object>();
            raw["providers"] = new Dictionary<string, object> { ["value"] = updated };
        }
    }

    private object ConvertElement(System.Text.Json.JsonElement element)
    {
        return element.ValueKind switch
        {
            System.Text.Json.JsonValueKind.String => element.GetString() ?? "",
            System.Text.Json.JsonValueKind.Number => element.TryGetInt64(out long l) ? l : element.GetDouble(),
            System.Text.Json.JsonValueKind.True => true,
            System.Text.Json.JsonValueKind.False => false,
            System.Text.Json.JsonValueKind.Array => element.EnumerateArray().Select(ConvertElement).ToList(),
            System.Text.Json.JsonValueKind.Object => element.EnumerateObject().ToDictionary(p => p.Name, p => ConvertElement(p.Value)),
            _ => element.ToString()
        };
    }

    private T? ConvertValue<T>(object? val)
    {
        if (val == null) return default;
        if (val is T t) return t;
        if (val is System.Text.Json.JsonElement je)
        {
            try { return System.Text.Json.JsonSerializer.Deserialize<T>(je.GetRawText()); } catch { return default; }
        }
        try { return (T?)Convert.ChangeType(val, typeof(T)); } catch { return default; }
    }

    private Dictionary<string, object> GetDefaults() => new()
    {
        ["general"] = new Dictionary<string, object> { ["tone"] = Dv("strict_simple"), ["language"] = Dv("auto") },
        ["models"] = new Dictionary<string, object> {
            ["providers"] = Dv(new List<object>()),
            ["default_model"] = Dv(""),
            ["default_intelligence"] = Dv("medium"),
            ["agent_engine"] = Dv("builtin"),
            ["auto_switch"] = Dv(false),
            ["auto_switch_preference"] = Dv("default"),
            ["fuzzy_injection"] = Dv(false)
        },
        ["agent"] = new Dictionary<string, object> {
            ["default_mode"] = Dv("build"), ["default_input"] = Dv("guide"),
            ["option_feedback"] = Dv("default"), ["auto_adjust_settings"] = Dv(false),
            ["option_feedback_default_auto"] = Dv(true)
        },
        ["workspace"] = new Dictionary<string, object> {
            ["access_permission"] = Dv("full_access"), ["on_permission_violation"] = Dv("ask_user"),
            ["prompt_mode"] = Dv("both"), ["auto_create_timestamp_workspace"] = Dv(true)
        },
        ["skills"] = new Dictionary<string, object> { ["auto_download"] = Dv("conservative") },
        ["ui"] = new Dictionary<string, object> {
            ["gradient_colors"] = Dv(new List<string> { "#00ff88", "#00ccff", "#aa44ff", "#ff4488" }),
            ["gradient_speed"] = Dv(2), ["gradient_width"] = Dv(2),
            ["show_mode_label"] = Dv(true), ["left_panel_collapsed"] = Dv(false),
            ["right_panel_collapsed"] = Dv(false)
        },
        ["web"] = new Dictionary<string, object> { ["search_enabled"] = Dv(true), ["fetch_enabled"] = Dv(true), ["default_search_engine"] = Dv("duckduckgo") },
        ["git"] = new Dictionary<string, object> { ["auto_pull"] = Dv(false), ["auto_push"] = Dv(false) },
        ["terminal"] = new Dictionary<string, object> { ["default_shell"] = Dv("shell") }
    };

    private static Dictionary<string, object> Dv(object val) => new() { ["value"] = val };
}
