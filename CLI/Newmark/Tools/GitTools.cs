namespace Newmark.Tools;

using System.Diagnostics;
using Newmark.Engine;

/// <summary>
/// Git operations with config-aware safety controls.
/// </summary>
public class GitTools
{
    private readonly NewmarkAgent _agent;
    private string? _repoPath;

    public GitTools(NewmarkAgent agent) => _agent = agent;

    public void SetRepoPath(string? path) => _repoPath = path;

    public async Task<string> StatusAsync()
    {
        return await RunGitAsync("status --short");
    }

    public async Task<string> PullAsync()
    {
        if (!_agent.Config.Get<bool>("git", "auto_pull")) return "[Auto-pull disabled]";
        return await RunGitAsync("pull");
    }

    public async Task<string> PushAsync(string? message = null)
    {
        if (!_agent.Config.Get<bool>("git", "auto_push")) return "[Auto-push disabled]";
        if (message != null)
        {
            await RunGitAsync($"add -A");
            await RunGitAsync($"commit -m \"{message}\"");
        }
        return await RunGitAsync("push");
    }

    public async Task<string> CloneAsync(string url, string? targetDir = null)
    {
        var args = $"clone {url}";
        if (targetDir != null) args += $" {targetDir}";
        return await RunGitAsync(args);
    }

    private async Task<string> RunGitAsync(string args)
    {
        try
        {
            var psi = new ProcessStartInfo("git", args)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            if (_repoPath != null) psi.WorkingDirectory = _repoPath;

            using var proc = Process.Start(psi);
            if (proc == null) return "[Error] Cannot start git";

            var output = await proc.StandardOutput.ReadToEndAsync();
            var error = await proc.StandardError.ReadToEndAsync();
            await proc.WaitForExitAsync();

            return proc.ExitCode == 0 ? output : $"[Git Error] {error}";
        }
        catch (Exception ex) { return $"[Git Error] {ex.Message}"; }
    }
}
