# Flow Workflow Skill

Multi-agent compatible skill for defining and executing sequential workflows with dialog and logic components. Supports OpenCode, Claude Code, and custom agent environments.

## Overview

Flow workflows let you chain together dialog steps (Build/Plan/Goal modes) with conditional logic branches into a reusable saved workflow. Each workflow is a `*.Flow.json` file.

## Workflow Format

Flow files are stored in a `Flow/` directory or accessible path, named `{name}.Flow.json`.

```json
{
  "name": "my_workflow",
  "components": [
    {
      "type": "dialog",
      "id": 0,
      "mode": "Plan",
      "prompt": "Plan the implementation of: {#prompt#}"
    },
    {
      "type": "logic",
      "id": 1,
      "prompt": "Has the README.md been created?",
      "goto_true": 3,
      "goto_false": 2
    },
    {
      "type": "dialog",
      "id": 2,
      "mode": "Build",
      "prompt": "Create README.md with basic structure for: {#prompt#}"
    },
    {
      "type": "dialog",
      "id": 3,
      "mode": "Goal",
      "prompt": "Goal: Complete implementation of {#prompt#}"
    }
  ]
}
```

## Components

### Dialog Component
- `type`: `"dialog"`
- `id`: Sequential integer address
- `mode`: `"Build"` | `"Plan"` | `"Goal"` (NOT "Flow")
- `prompt`: Instruction text. Use `{#prompt#}` as placeholder for user input

Execution: Injects user input into `{#prompt#}`, then runs with the specified mode. Build mode permits full tool access. Plan mode restricts writes to README.md only. Goal mode tracks an objective with completion verification.

### Logic Component
- `type`: `"logic"`
- `id`: Sequential integer address
- `prompt`: Condition statement evaluated by the agent
- `goto_true`: Component ID to jump to if condition is TRUE
- `goto_false`: Component ID to jump to if condition is FALSE

Execution: Agent evaluates whether the condition is satisfied in the current workspace. Returns TRUE or FALSE to determine branching.

## Execution Semantics

1. Components execute in ascending order by `id`
2. Dialog components: substitute `{#prompt#}` with user input, execute with specified mode
3. Logic components: evaluate condition, jump to `goto_true` or `goto_false`
4. After a goto, execution continues sequentially from the target component
5. Execution stops when no next component exists

## Usage with Different Agents

### OpenCode
Place `*.Flow.json` files in project root's `Flow/` directory. Use the Flow skill to select and execute workflows.

### Claude Code
Reference workflow files by path. The skill provides execution instructions for sequential and conditional prompts.

### Custom Agents
Agents should implement a flow execution engine that:
1. Loads and parses `*.Flow.json`
2. Iterates components in ID order
3. For dialog: substitutes prompt, runs with specified mode
4. For logic: evaluates condition, follows goto

## Flow Editor

A standalone HTML editor (`FlowEditor.html`) is available for visually editing workflows with a tree view interface. Open it directly in a browser to create, modify, and manage workflow files.

## Example Workflows

### Code Review Flow
```
0 (dialog, Build): Run code review checklist on {#prompt#}
1 (logic): Were any critical issues found?
  TRUE -> 2, FALSE -> 3
2 (dialog, Plan): Create plan to fix: {#prompt#}
3 (dialog, Goal): Goal: Code review complete for {#prompt#}
```

### Deploy Flow
```
0 (dialog, Plan): Plan deployment of {#prompt#}
1 (logic): Are tests passing?
  TRUE -> 2, FALSE -> 0
2 (dialog, Build): Deploy {#prompt#} to staging
3 (logic): Deploy successful?
  TRUE -> 4, FALSE -> 2
4 (dialog, Goal): Goal: Production deploy of {#prompt#}
```
