namespace Newmark.LLM;

using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.IO.Compression;
using System.Runtime.InteropServices;

/// <summary>
/// Manages external agent engine backends (Codex CLI, OpenCode CLI).
/// Downloads pre-built binaries from GitHub, stores locally, and provides
/// subprocess-based agent execution.
/// </summary>
public class EngineManager
{
    private readonly string _enginesDir;
    private readonly HttpClient _http;
    private readonly Dictionary<string, EngineInfo> _engines = new();

    public string CurrentEngine { get; private set; } = "builtin";

    public EngineManager(string rootPath)
    {
        _enginesDir = Path.Combine(rootPath, "engines");
        Directory.CreateDirectory(_enginesDir);
        _http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        _http.DefaultRequestHeaders.Add("User-Agent", "Newmark-Agent/1.0");
        ScanEngines();
    }

    public void ScanEngines()
    {
        _engines.Clear();

        // Check for codex-cli
        var codexPaths = new[] {
            Path.Combine(_enginesDir, "codex", "codex.exe"),
            Path.Combine(_enginesDir, "codex", "codex"),
            "codex", "codex.exe"
        };
        foreach (var p in codexPaths)
        {
            if (File.Exists(p) || ExistsInPath("codex"))
            {
                _engines["codex"] = new EngineInfo
                {
                    Name = "codex",
                    Display = "Codex CLI (OpenAI)",
                    Repo = "openai/codex",
                    ExePath = File.Exists(p) ? p : "codex",
                    Installed = File.Exists(p)
                };
                break;
            }
        }

        // Check for opencode-cli
        var openPaths = new[] {
            Path.Combine(_enginesDir, "opencode", "opencode.exe"),
            Path.Combine(_enginesDir, "opencode", "opencode"),
            "opencode", "opencode.exe"
        };
        foreach (var p in openPaths)
        {
            if (File.Exists(p) || ExistsInPath("opencode"))
            {
                _engines["opencode"] = new EngineInfo
                {
                    Name = "opencode",
                    Display = "OpenCode CLI (anomalyco)",
                    Repo = "anomalyco/opencode",
                    ExePath = File.Exists(p) ? p : "opencode",
                    Installed = File.Exists(p)
                };
                break;
            }
        }

        // Built-in is always available
        _engines["builtin"] = new EngineInfo
        {
            Name = "builtin", Display = "Built-in (Newmark)", Repo = "",
            ExePath = "", Installed = true
        };
    }

    public List<EngineInfo> ListEngines() => _engines.Values.ToList();

    public void SetEngine(string name)
    {
        if (_engines.ContainsKey(name)) CurrentEngine = name;
    }

    public EngineInfo? GetEngine(string name) => _engines.GetValueOrDefault(name);

    public bool IsAvailable(string name) => _engines.ContainsKey(name) && _engines[name].Installed;

    // ==================== DOWNLOAD & INSTALL ====================

    public async Task<EngineInstallResult> InstallCodexAsync()
    {
        try
        {
            // Download latest Codex CLI binary from GitHub releases
            string os = OperatingSystem.IsWindows() ? "windows" :
                        OperatingSystem.IsMacOS() ? "macos" : "linux";
            string arch = RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? "arm64" : "x64";

            string releaseUrl = $"https://api.github.com/repos/openai/codex/releases/latest";
            _http.DefaultRequestHeaders.Add("Accept", "application/vnd.github+json");
            var releaseJson = await _http.GetStringAsync(releaseUrl);
            var release = JsonDocument.Parse(releaseJson);
            var assets = release.RootElement.GetProperty("assets");

            string? downloadUrl = null;
            foreach (var asset in assets.EnumerateArray())
            {
                var name = asset.GetProperty("name").GetString() ?? "";
                if (os == "windows" && name.Contains("windows") && name.Contains("x86_64")) { downloadUrl = asset.GetProperty("browser_download_url").GetString(); break; }
                if (os == "macos" && name.Contains("apple-darwin")) { downloadUrl = asset.GetProperty("browser_download_url").GetString(); break; }
                if (os == "linux" && name.Contains("linux-musl") && name.Contains(arch == "arm64" ? "aarch64" : "x86_64")) { downloadUrl = asset.GetProperty("browser_download_url").GetString(); break; }
            }

            if (downloadUrl == null) downloadUrl = $"https://github.com/openai/codex/releases/latest/download/codex-{os}-{arch}.zip";

            var engineDir = Path.Combine(_enginesDir, "codex");
            Directory.CreateDirectory(engineDir);
            var zipPath = Path.Combine(engineDir, "codex.zip");

            var zipData = await _http.GetByteArrayAsync(downloadUrl);
            await File.WriteAllBytesAsync(zipPath, zipData);

            // Extract
            try { ZipFile.ExtractToDirectory(zipPath, engineDir, true); }
            catch {
                // If not a zip, it might be the binary directly
                var exePath = Path.Combine(engineDir, OperatingSystem.IsWindows() ? "codex.exe" : "codex");
                await File.WriteAllBytesAsync(exePath, zipData);
                if (!OperatingSystem.IsWindows())
                    await SetExecutableAsync(exePath);
            }

            ScanEngines();
            return new EngineInstallResult { Success = true, Engine = "codex" };
        }
        catch (Exception ex) { return new EngineInstallResult { Success = false, Error = ex.Message }; }
    }

    public async Task<EngineInstallResult> InstallOpenCodeAsync()
    {
        try
        {
            // Try npm install first (most reliable), fall back to binary download
            var engineDir = Path.Combine(_enginesDir, "opencode");
            Directory.CreateDirectory(engineDir);

            // Attempt npm install
            var psi = new ProcessStartInfo("npm", $"install opencode-ai@latest --prefix \"{engineDir}\"")
            { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
            using var proc = Process.Start(psi);
            if (proc != null) { await proc.StandardOutput.ReadToEndAsync(); await proc.StandardError.ReadToEndAsync(); await proc.WaitForExitAsync(); }

            // Fallback: download binary from GitHub
            string os = OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : "linux";
            string downloadUrl = $"https://github.com/anomalyco/opencode/releases/latest/download/opencode-{os}-x64.zip";

            var zipPath = Path.Combine(engineDir, "opencode.zip");
            try
            {
                var zipData = await _http.GetByteArrayAsync(downloadUrl);
                await File.WriteAllBytesAsync(zipPath, zipData);
                ZipFile.ExtractToDirectory(zipPath, engineDir, true);
            }
            catch { /* binary download fallback failed, rely on npm */ }

            ScanEngines();
            return new EngineInstallResult { Success = true, Engine = "opencode" };
        }
        catch (Exception ex) { return new EngineInstallResult { Success = false, Error = ex.Message }; }
    }

    // ==================== AGENT EXECUTION VIA ENGINE ====================

    public async IAsyncEnumerable<string> RunWithEngineAsync(string engine, string prompt,
        string? systemPrompt = null, string? workspacePath = null)
    {
        var info = GetEngine(engine);
        if (info == null || !info.Installed)
        {
            yield return $"[Engine] {engine} not available.";
            yield break;
        }

        if (engine == "builtin") yield break; // handled by built-in

        var process = StartEngineProcess(info.ExePath, prompt, systemPrompt, workspacePath);
        if (process == null)
        {
            yield return $"[Engine] Cannot start {engine}.";
            yield break;
        }

        using var reader = process.StandardOutput;
        using var errorReader = process.StandardError;

        var buffer = new char[256];
        while (!reader.EndOfStream)
        {
            var count = await reader.ReadAsync(buffer, 0, buffer.Length);
            if (count == 0) break;
            yield return new string(buffer, 0, count);
        }

        var error = await errorReader.ReadToEndAsync();
        if (!string.IsNullOrEmpty(error)) yield return $"\n[stderr] {error}";

        await process.WaitForExitAsync();
    }

    private Process? StartEngineProcess(string exePath, string prompt, string? systemPrompt, string? workspacePath)
    {
        try
        {
            var args = new List<string>();
            args.Add("--print");      // non-interactive mode
            args.Add("--prompt");
            args.Add(prompt);
            if (!string.IsNullOrEmpty(systemPrompt))
            {
                args.Add("--system-prompt");
                args.Add(systemPrompt);
            }
            if (!string.IsNullOrEmpty(workspacePath))
            {
                args.Add("--cwd");
                args.Add(workspacePath);
            }

            var psi = new ProcessStartInfo(exePath, string.Join(" ", args.Select(a => $"\"{a}\"")))
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = workspacePath ?? Environment.CurrentDirectory
            };

            var proc = Process.Start(psi);
            return proc;
        }
        catch { return null; }
    }

    private static async Task SetExecutableAsync(string path)
    {
        try { await Task.Run(() => File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)); }
        catch { }
    }

    private static bool ExistsInPath(string name) {
        try { var p = Process.Start(new ProcessStartInfo(OperatingSystem.IsWindows() ? "where" : "which", name) { RedirectStandardOutput = true, UseShellExecute = false }); p?.WaitForExit(); return p?.ExitCode == 0; }
        catch { return false; }
    }
}

public class EngineInfo
{
    public string Name { get; set; } = "";
    public string Display { get; set; } = "";
    public string Repo { get; set; } = "";
    public string ExePath { get; set; } = "";
    public bool Installed { get; set; }
}

public class EngineInstallResult
{
    public bool Success { get; set; }
    public string Engine { get; set; } = "";
    public string Error { get; set; } = "";
}
