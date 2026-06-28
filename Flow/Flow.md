# Newmark Flow Format Guide

## File Naming
Flow files are stored in the `Flow/` directory with the naming pattern `{name}.Flow.json`.

## JSON Format
```json
{
  "name": "my_workflow",
  "components": [
    {
      "type": "dialog",
      "id": 0,
      "mode": "Build",
      "prompt": "Base prompt with {#prompt#} placeholder"
    },
    {
      "type": "logic",
      "id": 1,
      "prompt": "Has the file been created?",
      "goto_true": 2,
      "goto_false": 0
    },
    {
      "type": "dialog",
      "id": 2,
      "mode": "Plan",
      "prompt": "Review and document: {#prompt#}"
    }
  ]
}
```

## Component Types

### Dialog Component
- `type`: "dialog"
- `id`: Unique numeric identifier (sequential order)
- `mode`: "Build" | "Plan" | "Goal" (NOT "Flow")
- `prompt`: Base prompt template. Use `{#prompt#}` as placeholder for user input.

### Logic Component
- `type`: "logic"
- `id`: Unique numeric identifier
- `prompt`: Condition to evaluate (agent answers TRUE/FALSE). Use `{#prompt#}` as placeholder for user input.
- `goto_true`: Component ID to jump to if TRUE
- `goto_false`: Component ID to jump to if FALSE

## Execution
1. Components execute in sequential order by ID
2. Dialog components: inject user input into `{#prompt#}` placeholder, then execute with specified mode
3. Logic components: inject user input into `{#prompt#}` placeholder, evaluate condition, then jump to specified component ID based on result
4. Execution stops when a component ID has no successor

## Example
```
Flow/
├── deploy.Flow.json       # Automated deployment workflow
├── review.Flow.json       # Code review workflow
└── Flow.md                # This guide
```
