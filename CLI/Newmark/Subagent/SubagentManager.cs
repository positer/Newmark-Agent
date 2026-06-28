namespace Newmark.Subagent;

using Newmark.Engine;

/// <summary>
/// Manages subagent lifecycle: creation, tracking, inter-agent communication, termination.
/// Subagents cannot change settings or switch models autonomously.
/// </summary>
public class SubagentManager
{
    private readonly NewmarkAgent _parent;
    private readonly Dictionary<string, SubagentInstance> _subagents = new();

    public SubagentManager(NewmarkAgent parent) => _parent = parent;

    public string Create(string name, string prompt, string? model = null,
        InputMode? inputMode = null, AgentMode? agentMode = null)
    {
        var sub = new SubagentInstance(name, prompt, model, inputMode ?? InputMode.Guide, agentMode ?? AgentMode.Build);
        sub.AddMessage("system", $"Subagent '{name}' created: {prompt}");
        sub.AddMessage("user", prompt);
        sub.Status = SubagentStatus.Working;
        _subagents[sub.Id] = sub;
        return sub.Id;
    }

    public Dictionary<string, object>? Get(string nameOrId)
    {
        var sub = FindSubagent(nameOrId);
        return sub?.ToDict();
    }

    public void Send(string nameOrId, string prompt)
    {
        var sub = FindSubagent(nameOrId);
        if (sub?.Status == SubagentStatus.Working)
            sub.AddMessage("user", prompt);
    }

    public void Close(string nameOrId)
    {
        var sub = FindSubagent(nameOrId);
        if (sub != null) sub.Close();
    }

    public List<Dictionary<string, object>> ListActive()
    {
        return _subagents.Values
            .Where(s => s.Status != SubagentStatus.Closed)
            .Select(s => s.ToDict()).ToList();
    }

    public List<Dictionary<string, object>> ListAll()
    {
        return _subagents.Values.Select(s => s.ToDict()).ToList();
    }

    public List<Dictionary<string, object>>? GetConversation(string nameOrId)
    {
        return FindSubagent(nameOrId)?.Messages;
    }

    private SubagentInstance? FindSubagent(string nameOrId)
    {
        return _subagents.Values.FirstOrDefault(s => s.Name == nameOrId || s.Id == nameOrId);
    }
}

public enum SubagentStatus { Idle, Working, Completed, Closed }

public class SubagentInstance
{
    public string Id { get; }
    public string Name { get; }
    public string Prompt { get; }
    public string Model { get; }
    public InputMode InputMode { get; }
    public AgentMode AgentMode { get; }
    public SubagentStatus Status { get; set; } = SubagentStatus.Idle;
    public List<Dictionary<string, object>> Messages { get; } = new();
    public string? Result { get; set; }
    public DateTime CreatedAt { get; } = DateTime.Now;
    public DateTime? ClosedAt { get; set; }

    public SubagentInstance(string name, string prompt, string? model, InputMode inputMode, AgentMode agentMode)
    {
        Id = Guid.NewGuid().ToString()[..8];
        Name = name; Prompt = prompt;
        Model = model ?? "default";
        InputMode = inputMode; AgentMode = agentMode;
    }

    public void AddMessage(string role, string content)
    {
        Messages.Add(new Dictionary<string, object> { ["role"] = role, ["content"] = content });
    }

    public void AddResult(string result) { Result = result; Status = SubagentStatus.Completed; }

    public void Close() { Status = SubagentStatus.Closed; ClosedAt = DateTime.Now; }

    public Dictionary<string, object> ToDict() => new()
    {
        ["id"] = Id, ["name"] = Name, ["status"] = Status.ToString(),
        ["model"] = Model, ["agent_mode"] = AgentMode.ToString(),
        ["input_mode"] = InputMode.ToString(), ["messages"] = Messages,
        ["result"] = Result ?? "", ["created_at"] = CreatedAt.ToString("o"),
        ["closed_at"] = ClosedAt?.ToString("o") ?? ""
    };
}
