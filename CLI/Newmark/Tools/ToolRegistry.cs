namespace Newmark.Tools;

using Newmark.Engine;

/// <summary>
/// Tool registry - all available tools the agent can use.
/// Web search, web fetch, git, file operations, terminal, etc.
/// </summary>
public class ToolRegistry
{
    private readonly NewmarkAgent _agent;
    public readonly WebTools Web;
    public readonly GitTools Git;
    public readonly FileTools Files;
    public readonly TerminalTools Terminal;

    public ToolRegistry(NewmarkAgent agent)
    {
        _agent = agent;
        Web = new WebTools(agent);
        Git = new GitTools(agent);
        Files = new FileTools(agent);
        Terminal = new TerminalTools(agent);
    }

    public Dictionary<string, object> GetToolDescriptions() => new()
    {
        ["web_search"] = new Dictionary<string, object> { ["description"] = "Search the web", ["parameters"] = new List<string> { "query" } },
        ["web_fetch"] = new Dictionary<string, object> { ["description"] = "Fetch web page content", ["parameters"] = new List<string> { "url" } },
        ["git_status"] = new Dictionary<string, object> { ["description"] = "Git working tree status" },
        ["git_pull"] = new Dictionary<string, object> { ["description"] = "Git pull from remote" },
        ["git_push"] = new Dictionary<string, object> { ["description"] = "Git push to remote" },
        ["read_file"] = new Dictionary<string, object> { ["description"] = "Read file content", ["parameters"] = new List<string> { "path" } },
        ["write_file"] = new Dictionary<string, object> { ["description"] = "Write file content", ["parameters"] = new List<string> { "path", "content" } },
        ["list_files"] = new Dictionary<string, object> { ["description"] = "List directory files", ["parameters"] = new List<string> { "path" } },
        ["run_command"] = new Dictionary<string, object> { ["description"] = "Run terminal command", ["parameters"] = new List<string> { "command" } },
    };
}
