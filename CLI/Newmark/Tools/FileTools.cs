namespace Newmark.Tools;

using Newmark.Engine;

/// <summary>
/// File operations: read, write, list, edit with workspace permission checks.
/// </summary>
public class FileTools
{
    private readonly NewmarkAgent _agent;

    public FileTools(NewmarkAgent agent) => _agent = agent;

    public string Read(string path)
    {
        var fullPath = ResolvePath(path);
        if (!CheckAccess(fullPath)) return $"[Access denied] {path}";
        if (!File.Exists(fullPath)) return $"[File not found] {path}";
        return File.ReadAllText(fullPath);
    }

    public string Write(string path, string content)
    {
        var fullPath = ResolvePath(path);
        if (!CheckAccess(fullPath)) return $"[Access denied] {path}";
        if (_agent.CurrentMode == Engine.AgentMode.Plan)
            return "[Plan mode: cannot write files except README.md]";

        if (_agent.CurrentMode == AgentMode.Plan && !fullPath.EndsWith("README.md", StringComparison.OrdinalIgnoreCase))
            return "[Plan mode: only README.md can be written]";

        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        File.WriteAllText(fullPath, content);
        return $"File written: {path}";
    }

    public string List(string path = ".")
    {
        var fullPath = ResolvePath(path);
        if (!CheckAccess(fullPath)) return $"[Access denied] {path}";
        if (!Directory.Exists(fullPath)) return $"[Not a directory] {path}";

        var entries = Directory.GetFileSystemEntries(fullPath)
            .Select(e =>
            {
                var name = Path.GetFileName(e);
                return Directory.Exists(e) ? $"{name}/" : name;
            });
        return string.Join("\n", entries);
    }

    public string Edit(string path, string oldText, string newText)
    {
        var fullPath = ResolvePath(path);
        if (!CheckAccess(fullPath)) return $"[Access denied] {path}";
        if (_agent.CurrentMode == Engine.AgentMode.Plan)
            return "[Plan mode: cannot edit files]";
        if (!File.Exists(fullPath)) return $"[File not found] {path}";

        var content = File.ReadAllText(fullPath);
        if (!content.Contains(oldText)) return "[Not found in file]";
        content = content.Replace(oldText, newText);
        File.WriteAllText(fullPath, content);
        return $"Edited: {path}";
    }

    private string ResolvePath(string path)
    {
        if (Path.IsPathRooted(path)) return path;
        var wsInfo = _agent.Workspace.GetCurrentInfo();
        var basePath = wsInfo.GetValueOrDefault("path", ".")?.ToString() ?? ".";
        return Path.GetFullPath(Path.Combine(basePath, path));
    }

    private bool CheckAccess(string path) => _agent.Workspace.CheckAccessPermission(path);
}
