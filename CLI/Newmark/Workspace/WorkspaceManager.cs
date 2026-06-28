namespace Newmark.Workspace;

using System.Net;
using Newmark.Config;

/// <summary>
/// Manages internal (under root/Work/) and external workspaces.
/// External workspaces are tied to PC hostname and validated on access.
/// </summary>
public class WorkspaceManager
{
    private readonly string _rootPath;
    private readonly ConfigManager _config;
    public WorkspaceInfo? CurrentWorkspace { get; private set; }
    public List<WorkspaceInfo> InternalWorkspaces { get; } = new();
    public List<WorkspaceInfo> ExternalWorkspaces { get; } = new();

    public WorkspaceManager(string rootPath, ConfigManager config)
    {
        _rootPath = rootPath;
        _config = config;
        ScanWorkspaces();
    }

    private void ScanWorkspaces()
    {
        var workDir = Path.Combine(_rootPath, "Work");
        if (Directory.Exists(workDir))
        {
            foreach (var item in Directory.GetDirectories(workDir))
                InternalWorkspaces.Add(new WorkspaceInfo(item, Path.GetFileName(item), true));
        }
    }

    public WorkspaceInfo CreateInternalWorkspace(string? name = null)
    {
        name ??= DateTime.Now.ToString("yyyyMMdd_HHmmss");
        var dir = Path.Combine(_rootPath, "Work", name);
        Directory.CreateDirectory(dir);
        var ws = new WorkspaceInfo(dir, name, true);
        InternalWorkspaces.Add(ws);
        CurrentWorkspace = ws;
        return ws;
    }

    public WorkspaceInfo? AddExternalWorkspace(string path)
    {
        var fullPath = Path.GetFullPath(path);
        if (!Directory.Exists(fullPath)) return null;

        var rootFull = Path.GetFullPath(_rootPath);
        if (fullPath.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase)) return null;

        var hostname = Dns.GetHostName();
        var ws = new WorkspaceInfo(fullPath, Path.GetFileName(fullPath), false, hostname);
        ExternalWorkspaces.Add(ws);
        CurrentWorkspace = ws;
        return ws;
    }

    public WorkspaceInfo? SelectWorkspace(string id)
    {
        var all = InternalWorkspaces.Concat(ExternalWorkspaces).ToList();
        var ws = all.FirstOrDefault(w => w.Name == id || w.Path == id);
        if (ws != null)
        {
            CurrentWorkspace = ws;
            _config.LoadWorkspaceConfig(ws.Path);
        }
        return ws;
    }

    public void ClearWorkspace()
    {
        CurrentWorkspace = null;
        _config.ClearWorkspaceOverrides();
    }

    public string? GetCurrentAgentPrompt()
    {
        if (CurrentWorkspace == null) return null;
        var agentPath = Path.Combine(CurrentWorkspace.Path, "agent.md");
        return File.Exists(agentPath) ? File.ReadAllText(agentPath) : null;
    }

    public Dictionary<string, object> GetCurrentInfo()
    {
        if (CurrentWorkspace == null)
            return new() {
                ["name"] = "No workspace", ["path"] = _rootPath, ["is_internal"] = true,
                ["internal_count"] = InternalWorkspaces.Count, ["external_count"] = ExternalWorkspaces.Count
            };

        return new() {
            ["name"] = CurrentWorkspace.Name, ["path"] = CurrentWorkspace.Path,
            ["is_internal"] = CurrentWorkspace.IsInternal,
            ["internal_count"] = InternalWorkspaces.Count, ["external_count"] = ExternalWorkspaces.Count
        };
    }

    public bool CheckAccessPermission(string targetPath)
    {
        var permission = _config.Get<string>("workspace", "access_permission") ?? "full_access";
        if (permission == "full_access") return true;

        if (CurrentWorkspace == null) return permission != "no_outside_access";

        var target = Path.GetFullPath(targetPath);
        if (CurrentWorkspace.IsInternal)
            return permission != "no_outside_access";

        if (target.StartsWith(CurrentWorkspace.Path, StringComparison.OrdinalIgnoreCase))
            return true;

        if (permission == "outside_readonly") return true;
        if (permission == "no_outside_access")
        {
            var onViolation = _config.Get<string>("workspace", "on_permission_violation") ?? "ask_user";
            return onViolation == "ask_user";
        }
        return true;
    }

    public Dictionary<string, object> ListWorkspaces() => new()
    {
        ["internal"] = InternalWorkspaces.Select(w => new Dictionary<string, object> { ["name"] = w.Name, ["path"] = w.Path }).ToList(),
        ["external"] = ExternalWorkspaces.Select(w => new Dictionary<string, object> { ["name"] = w.Name, ["path"] = w.Path, ["host"] = w.RemoteHost }).ToList()
    };
}

public class WorkspaceInfo
{
    public string Path { get; set; }
    public string Name { get; set; }
    public bool IsInternal { get; set; }
    public bool IsRemote { get; set; }
    public string RemoteHost { get; set; }

    public WorkspaceInfo(string path, string name, bool isInternal, string? remoteHost = null)
    {
        Path = path; Name = name; IsInternal = isInternal;
        IsRemote = !string.IsNullOrEmpty(remoteHost);
        RemoteHost = remoteHost ?? "";
    }
}
