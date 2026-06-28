namespace Newmark.Skills;

using Newmark.Config;

/// <summary>
/// Skills Manager - downloads, configures, and manages skills.
/// Auto-download policy: aggressive/conservative/disabled.
/// All skills stored under root/skills/ for offline portability.
/// </summary>
public class SkillsManager
{
    private readonly string _skillsDir;
    private readonly ConfigManager _config;
    private readonly HttpClient _http;

    public SkillsManager(string rootPath, ConfigManager config)
    {
        _skillsDir = Path.Combine(rootPath, "skills");
        _config = config;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
        _http.DefaultRequestHeaders.Add("User-Agent", "Newmark-Agent/1.0");
        Directory.CreateDirectory(_skillsDir);
    }

    public string GetPolicy() => _config.Get<string>("skills", "auto_download") ?? "conservative";

    public bool CanAutoDownload()
    {
        var policy = GetPolicy();
        return policy != "disabled";
    }

    public bool CanAutoDownloadAggressively() => GetPolicy() == "aggressive";

    public List<Dictionary<string, object>> ListInstalledSkills()
    {
        var skills = new List<Dictionary<string, object>>();
        if (!Directory.Exists(_skillsDir)) return skills;

        foreach (var dir in Directory.GetDirectories(_skillsDir))
        {
            var name = Path.GetFileName(dir);
            var skillMd = Path.Combine(dir, "SKILL.md");
            skills.Add(new Dictionary<string, object>
            {
                ["name"] = name,
                ["path"] = dir,
                ["has_readme"] = File.Exists(skillMd)
            });
        }
        return skills;
    }

    public async Task<Dictionary<string, object>> DownloadSkillAsync(string skillName, string source)
    {
        try
        {
            var skillDir = Path.Combine(_skillsDir, skillName);
            Directory.CreateDirectory(skillDir);

            string content;
            if (source.StartsWith("http://") || source.StartsWith("https://"))
            {
                content = await _http.GetStringAsync(source);
            }
            else
            {
                if (!File.Exists(source)) return new() { ["success"] = false, ["error"] = "Source not found" };
                content = await File.ReadAllTextAsync(source);
            }

            var skillMdPath = Path.Combine(skillDir, "SKILL.md");
            await File.WriteAllTextAsync(skillMdPath, content);

            return new() { ["success"] = true, ["name"] = skillName, ["path"] = skillDir };
        }
        catch (Exception ex) { return new() { ["success"] = false, ["error"] = ex.Message }; }
    }

    public bool HasSkill(string name)
    {
        var dir = Path.Combine(_skillsDir, name);
        return Directory.Exists(dir) && File.Exists(Path.Combine(dir, "SKILL.md"));
    }

    public string? GetSkillContent(string name)
    {
        var mdPath = Path.Combine(_skillsDir, name, "SKILL.md");
        return File.Exists(mdPath) ? File.ReadAllText(mdPath) : null;
    }
}
