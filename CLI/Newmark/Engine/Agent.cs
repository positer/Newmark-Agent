namespace Newmark.Engine;

using System.Text.Json;
using Newmark.Config;
using Newmark.LLM;
using Newmark.Workspace;
using Newmark.Subagent;
using Newmark.Tools;

public enum AgentMode { Build, Plan, Goal, Flow }
public enum InputMode { Guide, Next }
public enum AgentStatus { Idle, Working, Error, GoalWorking, GoalComplete, Planning }

public class GoalState
{
    public string Objective { get; set; } = "";
    public DateTime CreatedAt = DateTime.Now;
    public List<GoalChange> Changes { get; set; } = new();
    public int RoundsCompleted; public bool Verified;
    public void UpdateObjective(string o) { Changes.Add(new GoalChange { Timestamp = DateTime.Now, Old = Objective, New = o }); Objective = o; }
    public string GetHistoryText()
    {
        if (Changes.Count == 0) return $"Goal: {Objective}";
        var l = new List<string> { $"Current Goal: {Objective}", "--- Goal Changes ---" };
        for (int i = 0; i < Changes.Count; i++) l.Add($"  Change {i + 1}: '{Changes[i].Old}' -> '{Changes[i].New}'");
        return string.Join("\n", l);
    }
}
public class GoalChange { public DateTime Timestamp; public string Old = "", New = ""; }

public class OptionQuestion { public string Header = "", Question = ""; public List<OptionChoice> Options = new(); public bool Multiple; }
public class OptionChoice { public string Label = "", Description = ""; }

/// <summary>
/// Self-contained Agent Core — engine-switchable: built-in, codex, opencode.
/// All engines run locally — no external process dependency beyond downloaded CLI binaries.
/// </summary>
public class NewmarkAgent
{
    private readonly string _rootPath;
    public ConfigManager Config;
    public LLMManager LLM;
    public WorkspaceManager Workspace;
    public SubagentManager Subagents;
    public ToolRegistry Tools;
    public ToolExecutor Executor;
    public EngineManager Engines;

    public AgentMode CurrentMode;
    public InputMode CurrentInput;
    public AgentStatus Status = AgentStatus.Idle;
    public GoalState? GoalState;
    public string? NextPrompt;
    public string? CurrentWorkflow;
    public FlowManager FlowManager;
    public List<Dictionary<string, object>> ConversationHistory = new();
    public List<OptionQuestion> PendingOptions = new();

    public string CurrentModel => Config.Get<string>("models", "default_model") ?? "";
    public string Intelligence => Config.Get<string>("models", "default_intelligence") ?? "medium";
    public string CurrentEngine => Engines?.CurrentEngine ?? "builtin";
    private const int MaxToolRounds = 30;

    public event Action<AgentStatus>? OnStatusChange;
    public event Action<string>? OnOutput;
    public event Action<OptionQuestion>? OnOptionQuestion;
    public event Action<string>? OnSubagentOutput;

    public NewmarkAgent(string rootPath)
    {
        _rootPath = rootPath;
        Config = new ConfigManager(rootPath);
        LLM = new LLMManager(Config);
        Workspace = new WorkspaceManager(rootPath, Config);
        Subagents = new SubagentManager(this);
        Tools = new ToolRegistry(this);
        Executor = new ToolExecutor(this, rootPath);
        Engines = new EngineManager(rootPath);
        FlowManager = new FlowManager(rootPath, this);

        var engineCfg = Config.Get<string>("models", "agent_engine") ?? "builtin";
        if (Engines.IsAvailable(engineCfg)) Engines.SetEngine(engineCfg);
        else if (Engines.IsAvailable("builtin")) Engines.SetEngine("builtin");

        CurrentMode = (Config.Get<string>("agent", "default_mode") ?? "build").ToLower() switch { "plan" => AgentMode.Plan, "goal" => AgentMode.Goal, "flow" => AgentMode.Flow, _ => AgentMode.Build };
        CurrentInput = (Config.Get<string>("agent", "default_input") ?? "guide").ToLower() == "next" ? InputMode.Next : InputMode.Guide;
        FlowManager.EnsureFlowDocs();
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Config.Save();
    }

    public void SetEngine(string name) { Engines.SetEngine(name); Config.Set("models", "agent_engine", name); }
    public void SetMode(AgentMode mode)
    {
        if (mode == AgentMode.Goal && GoalState == null) GoalState = new GoalState { Objective = "Set your objective" };
        if (mode != AgentMode.Goal) GoalState = null;
        if (mode != AgentMode.Flow) CurrentWorkflow = null;
        CurrentMode = mode; UpdateStatus();
    }
    public void SetInputMode(InputMode m) => CurrentInput = m;
    public void SetIntelligence(string t) => Config.Set("models", "default_intelligence", t);
    public void QueueNextPrompt(string p) => NextPrompt = p;
    public string? GetQueuedPrompt() { var p = NextPrompt; NextPrompt = null; return p; }
    public void RaiseOptionQuestion(OptionQuestion q) { PendingOptions.Add(q); OnOptionQuestion?.Invoke(q); }
    public void AnswerOption(int idx, string a) { if (idx < PendingOptions.Count) { ConversationHistory.Add(new() { ["role"] = "user", ["content"] = $"Answer: {a}" }); PendingOptions.RemoveAt(idx); } }
    public bool CanAdjustSettings() => Config.Get<bool>("agent", "auto_adjust_settings");
    public void AdjustSetting(string s, string k, object v) { if (CanAdjustSettings()) { Config.Set(s, k, v); Config.Save(); } }

    // ==================== MAIN ENTRY ====================

    public async IAsyncEnumerable<string> ProcessAsync(string input)
    {
        if (CurrentMode == AgentMode.Flow)
        {
            if (string.IsNullOrEmpty(CurrentWorkflow))
            {
                yield return "[Flow] No workflow selected. Select a workflow first.";
                yield break;
            }
            Status = AgentStatus.Working; UpdateStatus();
            await foreach (var token in FlowManager.ExecuteFlowAsync(CurrentWorkflow, input))
            {
                OnOutput?.Invoke(token);
                yield return token;
            }
            Status = AgentStatus.Idle; UpdateStatus();
            yield break;
        }

        string engine = CurrentEngine;

        if (engine != "builtin" && Engines.IsAvailable(engine))
        {
            await foreach (var token in RunExternalEngineAsync(engine, input))
                yield return token;
            yield break;
        }

        await foreach (var token in RunBuiltinLoopAsync(input))
            yield return token;
    }

    // ==================== EXTERNAL ENGINE (CODX / OPENCODE) ====================

    private async IAsyncEnumerable<string> RunExternalEngineAsync(string engine, string input)
    {
        Status = AgentStatus.Working; UpdateStatus();
        ConversationHistory.Add(new() { ["role"] = "user", ["content"] = input });

        var sysPrompt = BuildSystemPrompt();
        var wsPath = Workspace.CurrentWorkspace?.Path ?? _rootPath;

        yield return $"[Engine: {engine}] Starting...\n";

        await foreach (var token in Engines.RunWithEngineAsync(engine, input, sysPrompt, wsPath))
        {
            OnOutput?.Invoke(token);
            yield return token;
        }

        Status = AgentStatus.Idle; UpdateStatus();
    }

    // ==================== BUILT-IN TOOL-CALLING LOOP ====================

    private async IAsyncEnumerable<string> RunBuiltinLoopAsync(string input)
    {
        Status = AgentStatus.Working; UpdateStatus();
        ConversationHistory.Add(new() { ["role"] = "user", ["content"] = input });

        var provider = LLM.GetCurrentProvider();
        var model = CurrentModel;
        if (provider == null || string.IsNullOrEmpty(model))
        { yield return "[Error] No LLM configured. Set API key in config.json."; Status = AgentStatus.Error; UpdateStatus(); yield break; }

        string sysPrompt = BuildSystemPrompt();
        var tcfg = provider.GetIntelligenceConfig(Intelligence);
        double temp = Convert.ToDouble(tcfg.GetValueOrDefault("temperature", 0.7));
        int maxTok = Convert.ToInt32(tcfg.GetValueOrDefault("max_tokens", 8192));
        var msgs = new List<Dictionary<string, object>>(ConversationHistory);
        var tools = Executor.GetToolDefinitions();

        await foreach (var token in ToolLoopAsync(provider, model, msgs, sysPrompt, temp, maxTok, tools))
            yield return token;

        Status = AgentStatus.Idle; UpdateStatus();
    }

    private async IAsyncEnumerable<string> ToolLoopAsync(LLMProvider provider, string model,
        List<Dictionary<string, object>> messages, string sysPrompt, double temp, int maxTok,
        List<Dictionary<string, object>> tools)
    {
        for (int round = 0; round < MaxToolRounds; round++)
        {
            var tcList = new List<ToolCallRequest>();
            string accumulated = "";
            bool hasTC = false;

            await foreach (var tok in provider.ChatStreamWithToolsAsync(model, messages, sysPrompt, temp, maxTok, tools, round == 0))
            {
                if (tok.Type == "text") { accumulated += tok.Text; OnOutput?.Invoke(tok.Text); yield return tok.Text; }
                else if (tok.Type == "tool_call") { hasTC = true; tcList.Add(tok.ToolCall!); }
            }

            if (!hasTC)
            {
                messages.Add(new() { ["role"] = "assistant", ["content"] = accumulated });
                ConversationHistory.Add(new() { ["role"] = "assistant", ["content"] = accumulated });
                yield break;
            }

            messages.Add(new() {
                ["role"] = "assistant", ["content"] = accumulated,
                ["tool_calls"] = tcList.Select(tc => new Dictionary<string, object> {
                    ["id"] = tc.Id, ["type"] = "function",
                    ["function"] = new Dictionary<string, object> { ["name"] = tc.Name, ["arguments"] = tc.Arguments }
                }).ToList()
            });

            foreach (var tc in tcList)
            {
                yield return $"\n[Tool: {tc.Name}]\n";
                var result = await Executor.ExecuteAsync(tc.Name, tc.Arguments);
                var display = result.Length > 2000 ? result[..2000] + "..." : result;
                yield return display + "\n";

                messages.Add(new() { ["role"] = "tool", ["tool_call_id"] = tc.Id, ["name"] = tc.Name, ["content"] = result });
            }
        }
    }

    // ==================== SUBAGENTS ====================

    public string CreateSubagent(string n, string p, string? m = null, InputMode? im = null, AgentMode? am = null)
    {
        var id = Subagents.Create(n, p, m, im, am);
        OnSubagentOutput?.Invoke($"Subagent '{n}' created (id: {id})"); return id;
    }
    public Dictionary<string, object>? GetSubagent(string n) => Subagents.Get(n);
    public void SendToSubagent(string n, string p) => Subagents.Send(n, p);
    public void CloseSubagent(string n) => Subagents.Close(n);
    public List<Dictionary<string, object>> GetActiveSubagents() => Subagents.ListActive();
    public void ToggleLeftPanel() => Config.Set("ui", "left_panel_collapsed", !Config.Get<bool>("ui", "left_panel_collapsed"));
    public void ToggleRightPanel() => Config.Set("ui", "right_panel_collapsed", !Config.Get<bool>("ui", "right_panel_collapsed"));
    public Dictionary<string, object> GetWorkspaceInfo() => Workspace.GetCurrentInfo();

    // ==================== SYSTEM PROMPT ====================

    private string BuildSystemPrompt()
    {
        var parts = new List<string>();
        var pm = Config.Get<string>("workspace", "prompt_mode") ?? "both";
        var amd = Path.Combine(_rootPath, "agent.md");
        if (pm is "global_only" or "both" && File.Exists(amd)) parts.Add(File.ReadAllText(amd));
        if (pm is "workspace_only" or "both") { var wp = Workspace.GetCurrentAgentPrompt(); if (wp != null) parts.Add(wp); }
        parts.Add(CurrentMode switch
        {
            AgentMode.Build => "BUILD mode. Use tools to complete tasks autonomously. Call tools when needed: bash, read, write, edit, glob, grep, web_search, web_fetch.",
            AgentMode.Plan => "PLAN mode. Do NOT modify files except README.md. Explore, research, analyze. Produce plan in README.md.",
            AgentMode.Goal => $"GOAL mode. Objective: {GoalState?.Objective}\n{GoalState?.GetHistoryText()}\nVerify completion each round. Continue if not done.",
            AgentMode.Flow => $"FLOW mode. Executing workflow: {CurrentWorkflow ?? "(none)"}. Follow the workflow component instructions precisely.",
            _ => ""
        });
        var tone = Config.Get<string>("general", "tone") ?? "strict_simple";
        parts.Add(tone == "casual_friendly" ? "Be friendly and casual." : "Be concise and direct.");
        parts.Add((Config.Get<string>("agent", "option_feedback") ?? "default") switch
        {
            "ask_more" => "Present options whenever possible.", "ask_less" => "Minimize questions. Decide yourself.",
            "fully_autonomous" => "Make ALL decisions autonomously. Never ask.",
            _ => "Ask when decisions are needed."
        });
        return string.Join("\n\n", parts);
    }

    internal async IAsyncEnumerable<string> FlowSubExecutionAsync(AgentMode mode, string prompt)
    {
        var provider = LLM.GetCurrentProvider();
        var model = CurrentModel;
        if (provider == null || string.IsNullOrEmpty(model))
        { yield return "[Error] No LLM configured."; yield break; }

        var savedMode = CurrentMode;
        CurrentMode = mode;
        var sysPrompt = BuildSystemPrompt();
        CurrentMode = savedMode;

        var tcfg = provider.GetIntelligenceConfig(Intelligence);
        double temp = Convert.ToDouble(tcfg.GetValueOrDefault("temperature", 0.7));
        int maxTok = Convert.ToInt32(tcfg.GetValueOrDefault("max_tokens", 8192));
        var msgs = new List<Dictionary<string, object>> { new() { ["role"] = "user", ["content"] = prompt } };
        var tools = Executor.GetToolDefinitions();

        for (int round = 0; round < MaxToolRounds; round++)
        {
            var tcList = new List<ToolCallRequest>();
            string accumulated = "";
            bool hasTC = false;

            await foreach (var tok in provider.ChatStreamWithToolsAsync(model, msgs, sysPrompt, temp, maxTok, tools, round == 0))
            {
                if (tok.Type == "text") { accumulated += tok.Text; yield return tok.Text; }
                else if (tok.Type == "tool_call") { hasTC = true; tcList.Add(tok.ToolCall!); }
            }

            if (!hasTC)
            {
                msgs.Add(new() { ["role"] = "assistant", ["content"] = accumulated });
                yield break;
            }

            msgs.Add(new() {
                ["role"] = "assistant", ["content"] = accumulated,
                ["tool_calls"] = tcList.Select(tc => new Dictionary<string, object> {
                    ["id"] = tc.Id, ["type"] = "function",
                    ["function"] = new Dictionary<string, object> { ["name"] = tc.Name, ["arguments"] = tc.Arguments }
                }).ToList()
            });

            foreach (var tc in tcList)
            {
                yield return $"\n[Flow Tool: {tc.Name}]\n";
                var result = await Executor.ExecuteAsync(tc.Name, tc.Arguments);
                var display = result.Length > 2000 ? result[..2000] + "..." : result;
                yield return display + "\n";
                msgs.Add(new() { ["role"] = "tool", ["tool_call_id"] = tc.Id, ["name"] = tc.Name, ["content"] = result });
            }
        }
    }

    internal async Task<bool> EvaluateConditionAsync(string prompt)
    {
        var provider = LLM.GetCurrentProvider();
        var model = CurrentModel;
        if (provider == null || string.IsNullOrEmpty(model)) return false;

        var sysPrompt = "You are a condition evaluator. Determine if the statement is TRUE or FALSE based on the current workspace state. Answer ONLY with TRUE or FALSE.";
        var msgs = new List<Dictionary<string, object>> { new() { ["role"] = "user", ["content"] = prompt } };

        try
        {
            var result = await provider.ChatAsync(model, msgs, sysPrompt, 0.3, 256);
            var cleaned = result?.Trim().ToUpperInvariant() ?? "";
            return cleaned.StartsWith("TRUE");
        }
        catch { return false; }
    }

    private void UpdateStatus() => OnStatusChange?.Invoke(Status);
}

// ==================== TOOL EXECUTOR ====================

public class ToolExecutor
{
    private readonly NewmarkAgent _agent;
    private readonly string _rootPath;
    private readonly HttpClient _http;

    public ToolExecutor(NewmarkAgent a, string rootPath) { _agent = a; _rootPath = rootPath; _http = new HttpClient { Timeout = TimeSpan.FromSeconds(60) }; _http.DefaultRequestHeaders.Add("User-Agent", "Newmark/1.0"); }

    public List<Dictionary<string, object>> GetToolDefinitions() => new()
    {
        T("bash", "Run shell command. Returns stdout+stderr.", new { command = "string" }),
        T("read", "Read file contents.", new { path = "string" }),
        T("write", "Write content to file.", new { path = "string", content = "string" }),
        T("edit", "Replace text in file.", new { path = "string", old_str = "string", new_str = "string" }),
        T("glob", "Find files by glob pattern.", new { pattern = "string" }),
        T("grep", "Search files with regex.", new { pattern = "string", path = "string" }),
        T("web_search", "Search the web via DuckDuckGo.", new { query = "string" }),
        T("web_fetch", "Fetch and extract text from URL.", new { url = "string" }),
        T("task", "Launch a subagent for a subtask. Returns subagent ID.", new { name = "string", prompt = "string" }),
    };

    private static Dictionary<string, object> T(string name, string desc, object par) { var j = JsonSerializer.SerializeToElement(par); var props = new Dictionary<string, object>(); foreach (var p in j.EnumerateObject()) props[p.Name] = new Dictionary<string, object> { ["type"] = p.Value.GetString() ?? "string" }; return new() { ["type"] = "function", ["function"] = new Dictionary<string, object> { ["name"] = name, ["description"] = desc, ["parameters"] = new Dictionary<string, object> { ["type"] = "object", ["properties"] = props, ["required"] = j.EnumerateObject().Select(p => p.Name).ToList() } } }; }

    public async Task<string> ExecuteAsync(string tool, string args)
    {
        try
        {
            var a = string.IsNullOrEmpty(args) ? new Dictionary<string, object>() : JsonSerializer.Deserialize<Dictionary<string, object>>(args) ?? new();
            return tool switch
            {
                "bash" => await Bash(a.GetV("command")),
                "read" => Read(a.GetV("path")),
                "write" => Write(a.GetV("path"), a.GetV("content")),
                "edit" => Edit(a.GetV("path"), a.GetV("old_str"), a.GetV("new_str")),
                "glob" => Glob(a.GetV("pattern")),
                "grep" => Grep(a.GetV("pattern"), a.GetV("path")),
                "web_search" => await WebSearch(a.GetV("query")),
                "web_fetch" => await WebFetch(a.GetV("url")),
                "task" => Task(a.GetV("name"), a.GetV("prompt")),
                _ => $"[Unknown: {tool}]"
            };
        }
        catch (Exception e) { return $"[Tool Error] {e.Message}"; }
    }

    private async Task<string> Bash(string cmd)
    {
        if (string.IsNullOrWhiteSpace(cmd)) return "[bash] No command.";
        try
        {
            var shell = OperatingSystem.IsWindows() ? "powershell.exe" : "/bin/bash";
            var arg = OperatingSystem.IsWindows() ? "-Command" : "-c";
            var psi = new System.Diagnostics.ProcessStartInfo(shell, $"{arg} \"{cmd}\"") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = WsDir() };
            using var p = System.Diagnostics.Process.Start(psi); if (p == null) return "[bash] Cannot start.";
            var o = await p.StandardOutput.ReadToEndAsync(); var e = await p.StandardError.ReadToEndAsync(); await p.WaitForExitAsync();
            var r = o; if (!string.IsNullOrEmpty(e)) r += $"\n[stderr]\n{e}";
            return string.IsNullOrWhiteSpace(r) ? $"[bash] Exit {p.ExitCode}" : r.Trim();
        }
        catch (Exception ex) { return $"[bash Error] {ex.Message}"; }
    }

    private string Read(string path)
    {
        var fp = Resolve(path); if (!File.Exists(fp)) return $"[read] Not found: {path}";
        try { var c = File.ReadAllText(fp); return c.Length > 10000 ? c[..10000] + "\n...(truncated)" : c; }
        catch (Exception e) { return $"[read Error] {e.Message}"; }
    }

    private string Write(string path, string content)
    {
        if (IsPlan() && !path.EndsWith("README.md", StringComparison.OrdinalIgnoreCase)) return "[write] Plan: README.md only.";
        var fp = Resolve(path);
        try { Directory.CreateDirectory(Path.GetDirectoryName(fp)!); File.WriteAllText(fp, content); return $"[write] OK: {path}"; }
        catch (Exception e) { return $"[write Error] {e.Message}"; }
    }

    private string Edit(string path, string old, string @new)
    {
        if (IsPlan() && !path.EndsWith("README.md", StringComparison.OrdinalIgnoreCase)) return "[edit] Plan: README.md only.";
        var fp = Resolve(path); if (!File.Exists(fp)) return $"[edit] Not found: {path}";
        try { var c = File.ReadAllText(fp); if (!c.Contains(old)) return $"[edit] old_str not found."; File.WriteAllText(fp, c.Replace(old, @new)); return $"[edit] OK: {path}"; }
        catch (Exception e) { return $"[edit Error] {e.Message}"; }
    }

    private string Glob(string pattern)
    {
        try
        {
            var b = WsDir(); var fp = Path.Combine(b, pattern); var d = Path.GetDirectoryName(fp) ?? b; var n = Path.GetFileName(fp);
            if (!Directory.Exists(d)) return $"[glob] Dir not found: {d}";
            var r = Directory.GetFiles(d, n, SearchOption.AllDirectories).Take(50).Select(f => f.Replace(b + Path.DirectorySeparatorChar, "")).ToList();
            r.AddRange(Directory.GetDirectories(d, n, SearchOption.AllDirectories).Take(50).Select(d2 => d2.Replace(b + Path.DirectorySeparatorChar, "") + "/"));
            return r.Count == 0 ? "[glob] No matches." : string.Join("\n", r);
        }
        catch (Exception e) { return $"[glob Error] {e.Message}"; }
    }

    private string Grep(string pattern, string path)
    {
        try
        {
            var sd = Resolve(path); var results = new List<string>();
            foreach (var f in Directory.GetFiles(sd, "*.*", SearchOption.TopDirectoryOnly).Take(200))
            {
                try { var lines = File.ReadAllLines(f); for (int i = 0; i < lines.Length; i++) if (System.Text.RegularExpressions.Regex.IsMatch(lines[i], pattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase)) { results.Add($"{Path.GetFileName(f)}:{i + 1}: {lines[i].Trim()}"); if (results.Count >= 30) break; } } catch { }
                if (results.Count >= 30) break;
            }
            return results.Count == 0 ? "[grep] No matches." : string.Join("\n", results);
        }
        catch (Exception e) { return $"[grep Error] {e.Message}"; }
    }

    private async Task<string> WebSearch(string q)
    {
        try { var html = await _http.GetStringAsync($"https://html.duckduckgo.com/html/?q={Uri.EscapeDataString(q)}"); var m = System.Text.RegularExpressions.Regex.Matches(html, @"class=""result__snippet"">(.*?)</a>", System.Text.RegularExpressions.RegexOptions.Singleline); var r = m.Take(5).Select(x => System.Text.RegularExpressions.Regex.Replace(x.Groups[1].Value, "<[^>]+>", "").Trim()).ToList(); return r.Count == 0 ? "[web_search] No results." : string.Join("\n\n", r); }
        catch (Exception e) { return $"[web_search Error] {e.Message}"; }
    }

    private async Task<string> WebFetch(string url)
    {
        try { var html = await _http.GetStringAsync(url); var t = System.Text.RegularExpressions.Regex.Replace(html, @"<(script|style)[^>]*>.*?</\1>", "", System.Text.RegularExpressions.RegexOptions.Singleline | System.Text.RegularExpressions.RegexOptions.IgnoreCase); t = System.Text.RegularExpressions.Regex.Replace(t, @"<[^>]+>", " "); t = System.Text.RegularExpressions.Regex.Replace(t, @"\s+", " ").Trim(); return t.Length > 5000 ? t[..5000] + "..." : t; }
        catch (Exception e) { return $"[web_fetch Error] {e.Message}"; }
    }

    private string Task(string name, string prompt) { var id = _agent.CreateSubagent(name, prompt); return $"[task] Subagent '{name}' (id: {id}) started."; }

    private string Resolve(string path) => Path.IsPathRooted(path) ? path : Path.GetFullPath(Path.Combine(WsDir(), path));
    private string WsDir() => _agent.Workspace.GetCurrentInfo().GetValueOrDefault("path", _rootPath)?.ToString() ?? _rootPath;
    private bool IsPlan() => _agent.CurrentMode == AgentMode.Plan;
}

public static class DictExt { public static string GetV(this Dictionary<string, object> d, string k) => d.TryGetValue(k, out var v) ? v?.ToString() ?? "" : ""; }
