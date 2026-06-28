namespace Newmark.Tools;

using System.Diagnostics;
using Newmark.Engine;

/// <summary>
/// Terminal/shell command execution with shell selection.
/// </summary>
public class TerminalTools
{
    private readonly NewmarkAgent _agent;

    public TerminalTools(NewmarkAgent agent) => _agent = agent;

    public async Task<string> RunCommandAsync(string command)
    {
        var shell = _agent.Config.Get<string>("terminal", "default_shell") ?? "shell";
        var (shellPath, shellArgs) = GetShellInfo(shell);

        try
        {
            var psi = new ProcessStartInfo(shellPath, $"{shellArgs} \"{command}\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            using var proc = Process.Start(psi);
            if (proc == null) return "[Error] Cannot start shell";

            var output = await proc.StandardOutput.ReadToEndAsync();
            var error = await proc.StandardError.ReadToEndAsync();
            await proc.WaitForExitAsync();

            if (proc.ExitCode != 0 && !string.IsNullOrEmpty(error))
                output += $"\n[stderr] {error}";

            return output.Trim();
        }
        catch (Exception ex) { return $"[Terminal Error] {ex.Message}"; }
    }

    private (string, string) GetShellInfo(string shell) => shell.ToLower() switch
    {
        "cmd" => ("cmd.exe", "/c"),
        "bash" => (OperatingSystem.IsWindows() ? "bash.exe" : "/bin/bash", "-c"),
        _ => (OperatingSystem.IsWindows() ? "powershell.exe" : "/bin/bash",
              OperatingSystem.IsWindows() ? "-Command" : "-c")
    };
}
