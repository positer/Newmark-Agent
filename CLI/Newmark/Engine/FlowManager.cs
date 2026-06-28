namespace Newmark.Engine;

using System.Text.Json;

public class FlowWorkflow
{
    public string Name { get; set; } = "";
    public List<FlowComponent> Components { get; set; } = new();
}

public class FlowComponent
{
    public string Type { get; set; } = "";
    public int Id { get; set; }
    public string Prompt { get; set; } = "";
}

public class FlowDialogComponent : FlowComponent
{
    public string Mode { get; set; } = "Build";
}

public class FlowLogicComponent : FlowComponent
{
    public int GotoTrue { get; set; }
    public int GotoFalse { get; set; }
}

public class FlowManager
{
    private readonly string _flowDir;
    private readonly NewmarkAgent _agent;

    public FlowManager(string rootPath, NewmarkAgent agent)
    {
        _flowDir = Path.Combine(rootPath, "Flow");
        _agent = agent;
        Directory.CreateDirectory(_flowDir);
    }

    public List<string> GetWorkflowNames()
    {
        if (!Directory.Exists(_flowDir)) return new();
        return Directory.GetFiles(_flowDir, "*.Flow.json")
            .Select(f => Path.GetFileNameWithoutExtension(f))
            .Where(n => n.EndsWith(".Flow"))
            .Select(n => n[..^5])
            .ToList();
    }

    public FlowWorkflow? LoadWorkflow(string name)
    {
        var path = Path.Combine(_flowDir, $"{name}.Flow.json");
        if (!File.Exists(path)) return null;

        try
        {
            var json = File.ReadAllText(path);
            var doc = JsonDocument.Parse(json);
            var workflow = new FlowWorkflow { Name = name };

            foreach (var comp in doc.RootElement.GetProperty("components").EnumerateArray())
            {
                var type = comp.GetProperty("type").GetString() ?? "";
                var id = comp.GetProperty("id").GetInt32();

                if (type == "dialog")
                {
                    workflow.Components.Add(new FlowDialogComponent
                    {
                        Id = id,
                        Type = "dialog",
                        Mode = comp.GetProperty("mode").GetString() ?? "Build",
                        Prompt = comp.GetProperty("prompt").GetString() ?? ""
                    });
                }
                else if (type == "logic")
                {
                    workflow.Components.Add(new FlowLogicComponent
                    {
                        Id = id,
                        Type = "logic",
                        Prompt = comp.GetProperty("prompt").GetString() ?? "",
                        GotoTrue = comp.GetProperty("goto_true").GetInt32(),
                        GotoFalse = comp.GetProperty("goto_false").GetInt32()
                    });
                }
            }

            return workflow;
        }
        catch { return null; }
    }

    public bool SaveWorkflow(FlowWorkflow workflow)
    {
        try
        {
            var list = new List<object>();
            foreach (var comp in workflow.Components.OrderBy(c => c.Id))
            {
                if (comp is FlowDialogComponent dc)
                {
                    list.Add(new { type = "dialog", id = dc.Id, mode = dc.Mode, prompt = dc.Prompt });
                }
                else if (comp is FlowLogicComponent lc)
                {
                    list.Add(new { type = "logic", id = lc.Id, prompt = lc.Prompt, goto_true = lc.GotoTrue, goto_false = lc.GotoFalse });
                }
            }

            var json = JsonSerializer.Serialize(new { name = workflow.Name, components = list }, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(Path.Combine(_flowDir, $"{workflow.Name}.Flow.json"), json);
            return true;
        }
        catch { return false; }
    }

    public bool DeleteWorkflow(string name)
    {
        try
        {
            var path = Path.Combine(_flowDir, $"{name}.Flow.json");
            if (File.Exists(path)) { File.Delete(path); return true; }
            return false;
        }
        catch { return false; }
    }

    public void EnsureFlowDocs()
    {
        var mdPath = Path.Combine(_flowDir, "Flow.md");
        if (File.Exists(mdPath)) return;

        var content = @"# Newmark Flow Format Guide

## File Naming
Flow files are stored in the `Flow/` directory with the naming pattern `{name}.Flow.json`.

## JSON Format
```json
{
  ""name"": ""my_workflow"",
  ""components"": [
    {
      ""type"": ""dialog"",
      ""id"": 0,
      ""mode"": ""Build"",
      ""prompt"": ""Base prompt with {#prompt#} placeholder""
    },
    {
      ""type"": ""logic"",
      ""id"": 1,
      ""prompt"": ""Has the file been created?"",
      ""goto_true"": 2,
      ""goto_false"": 0
    },
    {
      ""type"": ""dialog"",
      ""id"": 2,
      ""mode"": ""Plan"",
      ""prompt"": ""Review and document: {#prompt#}""
    }
  ]
}
```

## Component Types

### Dialog Component
- `type`: ""dialog""
- `id`: Unique numeric identifier (sequential order)
- `mode`: ""Build"" | ""Plan"" | ""Goal"" (NOT ""Flow"")
- `prompt`: Base prompt template. Use `{#prompt#}` as placeholder for user input.

### Logic Component
- `type`: ""logic""
- `id`: Unique numeric identifier
- `prompt`: Condition to evaluate (agent answers TRUE/FALSE). Use `{#prompt#}` as placeholder for user input.
- `goto_true`: Component ID to jump to if TRUE
- `goto_false`: Component ID to jump to if FALSE

## Execution
1. Components execute in sequential order by ID
2. Dialog components: inject user input into `{#prompt#}` placeholder, then execute with specified mode
3. Logic components: evaluate condition, then jump to specified component ID based on result
4. Execution stops when a component ID has no successor

## Example
```
Flow/
├── deploy.Flow.json       # Automated deployment workflow
├── review.Flow.json       # Code review workflow
└── Flow.md                # This guide
```
";
        File.WriteAllText(mdPath, content);
    }

    public async IAsyncEnumerable<string> ExecuteFlowAsync(string name, string userInput)
    {
        var workflow = LoadWorkflow(name);
        if (workflow == null)
        {
            yield return $"[Flow] Workflow '{name}' not found.";
            yield break;
        }

        var components = workflow.Components.OrderBy(c => c.Id).ToList();
        int currentIdx = 0;

        while (currentIdx >= 0 && currentIdx < components.Count)
        {
            var comp = components[currentIdx];

            if (comp is FlowDialogComponent dc)
            {
                var prompt = dc.Prompt.Replace("{#prompt#}", userInput);
                yield return $"\n>>> Dialog [{dc.Id}] Mode: {dc.Mode} >>>\n";

                var dialogMode = dc.Mode.ToLower() switch
                {
                    "plan" => AgentMode.Plan,
                    "goal" => AgentMode.Goal,
                    _ => AgentMode.Build
                };

                await foreach (var token in _agent.FlowSubExecutionAsync(dialogMode, prompt))
                    yield return token;

                currentIdx++;
            }
            else if (comp is FlowLogicComponent lc)
            {
                var logicPrompt = lc.Prompt.Replace("{#prompt#}", userInput);
                yield return $"\n>>> Logic [{lc.Id}] Evaluating: {logicPrompt} >>>\n";

                var result = await _agent.EvaluateConditionAsync($"{logicPrompt}\n\nDetermine if this condition is satisfied in the current workspace. Respond TRUE or FALSE.");

                if (result)
                {
                    yield return $"  -> TRUE, goto component {lc.GotoTrue}\n";
                    currentIdx = components.FindIndex(c => c.Id == lc.GotoTrue);
                }
                else
                {
                    yield return $"  -> FALSE, goto component {lc.GotoFalse}\n";
                    currentIdx = components.FindIndex(c => c.Id == lc.GotoFalse);
                }

                if (currentIdx < 0)
                {
                    yield return $"  [Flow] Goto target not found, stopping.\n";
                    break;
                }
            }
        }

        yield return "\n[Flow] Workflow complete.\n";
    }
}
