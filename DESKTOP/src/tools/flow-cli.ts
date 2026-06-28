import * as fs from 'fs';
import * as path from 'path';
import { FlowEngine, FlowWorkflow, DialogComponent, LogicComponent } from '../core/flow';

export function handleFlowCommand(root: string, args: string[]): string {
  const flowDir = path.join(root, 'Flow');
  if (!fs.existsSync(flowDir)) fs.mkdirSync(flowDir, { recursive: true });

  const cmd = args[0]?.toLowerCase();

  switch (cmd) {
    case 'list':
    case 'ls':
      return listFlows(flowDir);

    case 'show':
    case 'cat':
      return showFlow(flowDir, args.slice(1).join(' '));

    case 'add':
    case 'new':
      return addFlow(flowDir, args.slice(1));

    case 'delete':
    case 'rm':
      return deleteFlow(flowDir, args.slice(1).join(' '));

    case 'rename':
    case 'mv':
      return renameFlow(flowDir, args[1], args.slice(2).join(' '));

    case 'validate':
      return validateFlow(flowDir, args.slice(1).join(' '));

    case 'components':
      return listComponents(flowDir, args.slice(1).join(' '));

    case 'add-component':
    case 'addc':
      return addComponent(flowDir, args.slice(1));

    case 'edit-component':
    case 'editc':
      return editComponent(flowDir, args.slice(1));

    case 'remove-component':
    case 'rmc':
      return removeComponent(flowDir, args.slice(1));

    default:
      return `Unknown flow command: ${cmd}\n\nCommands:\n  list                              List all workflows\n  show <name>                       Show workflow JSON\n  add <name> [type] [mode]          Add a new workflow\n  run <name>                        Run a workflow\n  delete <name>                     Delete a workflow\n  rename <old> <new>                Rename a workflow\n  validate <name>                   Validate a workflow\n  components <name>                 List components\n  addc <name> [type] [mode] [id]    Add component\n  editc <name> <id> [field] [val]   Edit component field\n  rmc <name> <id>                   Remove component`;
  }
}

function listFlows(dir: string): string {
  const names = FlowEngine.listAll(dir);
  if (names.length === 0) return 'No workflows found.';
  const lines = names.map((n, i) => {
    const wf = FlowEngine.load(dir, n);
    const desc = wf ? FlowEngine.describeWorkflow(wf) : '';
    return `  ${i + 1}. ${n}${desc ? ' — ' + desc : ''}`;
  });
  return `Workflows (${names.length}):\n${lines.join('\n')}`;
}

function showFlow(dir: string, name: string): string {
  const found = FlowEngine.findWorkflow(name, dir);
  if (!found) return `Workflow '${name}' not found.`;
  const wf = FlowEngine.load(dir, found);
  if (!wf) return `Failed to load '${found}'.`;
  const json = JSON.stringify(wf, null, 2);
  const cycles = FlowEngine.getCycleWarnings(wf);
  const cycleWarn = cycles.length > 0 ? '\n\n' + cycles.join('\n') : '';
  return `${json}${cycleWarn}`;
}

function addFlow(dir: string, args: string[]): string {
  if (args.length === 0) return 'Usage: add <name> [type] [mode]\n  type: empty (dialog) or "logic"\n  mode: "build" (default), "plan", or "goal"\n  Shortcut: add <name> plan   → creates a plan-mode dialog';

  const name = args[0];
  const typeArg = args[1]?.toLowerCase();
  const modeArg = args[2]?.toLowerCase();

  const existing = FlowEngine.findWorkflow(name, dir);
  if (existing) return `Workflow '${name}' already exists (as '${existing}').`;

  let component: DialogComponent | LogicComponent;
  if (typeArg === 'logic') {
    component = {
      id: 0,
      type: 'logic',
      prompt: 'Evaluate condition',
      goto_true: 0,
      goto_false: 0,
    };
  } else {
    const mode = (['plan', 'goal'].includes(modeArg || '') ? modeArg : 'build') as 'build' | 'plan' | 'goal';
    component = {
      id: 0,
      type: 'dialog',
      mode,
      prompt: mode === 'plan' ? 'Plan: your task' : mode === 'goal' ? 'Goal: your objective' : 'Implement: your task',
    };
  }

  const wf: FlowWorkflow = { name, components: [component] };
  FlowEngine.save(dir, wf);
  const typeLabel = component.type === 'dialog' ? `${component.mode} dialog` : 'logic';
  return `Created workflow '${name}' with 1 ${typeLabel} component.\nUse '/flow add-component ${name}' to add more.`;
}

function deleteFlow(dir: string, name: string): string {
  const found = FlowEngine.findWorkflow(name, dir);
  if (!found) return `Workflow '${name}' not found.`;
  FlowEngine.delete(dir, found);
  return `Deleted workflow '${found}'.`;
}

function renameFlow(dir: string, oldName: string, newName: string): string {
  if (!oldName || !newName) return 'Usage: rename <old-name> <new-name>';
  const found = FlowEngine.findWorkflow(oldName, dir);
  if (!found) return `Workflow '${oldName}' not found.`;
  if (FlowEngine.findWorkflow(newName, dir)) return `Workflow '${newName}' already exists.`;
  const wf = FlowEngine.load(dir, found);
  if (!wf) return `Failed to load '${found}'.`;
  FlowEngine.delete(dir, found);
  wf.name = newName;
  FlowEngine.save(dir, wf);
  return `Renamed '${found}' → '${newName}'.`;
}

function validateFlow(dir: string, name: string): string {
  const found = FlowEngine.findWorkflow(name, dir);
  if (!found) return `Workflow '${name}' not found.`;
  const wf = FlowEngine.load(dir, found);
  if (!wf) return `Failed to load '${found}'.`;
  const errors = FlowEngine.validate(wf);
  const cycles = FlowEngine.getCycleWarnings(wf);
  const lines: string[] = [];
  lines.push(`Workflow '${found}': ${wf.components.length} components`);
  if (errors.length === 0) {
    lines.push('✓ No validation errors.');
  } else {
    lines.push(`✗ ${errors.length} validation error(s):`);
    for (const e of errors) {
      lines.push(`  ${e.componentId !== undefined ? `[#${e.componentId}] ` : ''}${e.message}`);
    }
  }
  if (cycles.length > 0) lines.push(...cycles);
  return lines.join('\n');
}

function getFlow(dir: string, name: string): { found: string; wf: FlowWorkflow } | string {
  const found = FlowEngine.findWorkflow(name, dir);
  if (!found) return `Workflow '${name}' not found.`;
  const wf = FlowEngine.load(dir, found);
  if (!wf) return `Failed to load '${found}'.`;
  return { found, wf };
}

function listComponents(dir: string, name: string): string {
  const result = getFlow(dir, name);
  if (typeof result === 'string') return result;
  const { found, wf } = result;
  const lines = [`Components in '${found}':`];
  for (const c of [...wf.components].sort((a, b) => a.id - b.id)) {
    if (c.type === 'dialog') {
      lines.push(`  #${c.id} [${c.mode}] ${c.prompt.slice(0, 60)}`);
    } else {
      lines.push(`  #${c.id} [?] ${c.prompt.slice(0, 60)} → true:${c.goto_true} false:${c.goto_false}`);
    }
  }
  return lines.join('\n');
}

function addComponent(dir: string, args: string[]): string {
  if (args.length < 1) return 'Usage: addc <name> [type] [mode] [id]';
  const name = args[0];
  const result = getFlow(dir, name);
  if (typeof result === 'string') return result;
  const { wf } = result;

  const typeArg = args[1]?.toLowerCase();
  const modeArg = args[2]?.toLowerCase();
  const idArg = args[3] !== undefined ? parseInt(args[3], 10) : undefined;

  const maxId = wf.components.reduce((m, c) => Math.max(m, c.id), -1);
  const newId = (idArg !== undefined && !isNaN(idArg)) ? idArg : maxId + 1;

  if (wf.components.some(c => c.id === newId)) {
    return `Component ID ${newId} already exists.`;
  }

  if (typeArg === 'logic') {
    const comp: LogicComponent = {
      id: newId,
      type: 'logic',
      prompt: 'Evaluate condition',
      goto_true: 0,
      goto_false: 0,
    };
    wf.components.push(comp);
  } else {
    const mode = (['plan', 'goal'].includes(modeArg || '') ? modeArg : 'build') as 'build' | 'plan' | 'goal';
    const comp: DialogComponent = {
      id: newId,
      type: 'dialog',
      mode,
      prompt: 'New component',
    };
    wf.components.push(comp);
  }

  FlowEngine.save(dir, wf);
  return `Added component #${newId} to '${name}'.`;
}

function editComponent(dir: string, args: string[]): string {
  if (args.length < 2) return 'Usage: editc <name> <id> [field] [value]';
  const name = args[0];
  const id = parseInt(args[1], 10);
  const result = getFlow(dir, name);
  if (typeof result === 'string') return result;
  const { wf } = result;

  const comp = wf.components.find(c => c.id === id);
  if (!comp) return `Component #${id} not found.`;

  const field = args[2]?.toLowerCase();
  if (!field) {
    return `Component #${id}:\n${JSON.stringify(comp, null, 2)}`;
  }

  const value = args.slice(3).join(' ');
  if (!value) return `No value provided for '${field}'.`;

  switch (field) {
    case 'mode':
      if (comp.type === 'dialog') {
        if (!['build', 'plan', 'goal'].includes(value.toLowerCase())) {
          return `Invalid mode '${value}'. Must be build, plan, or goal.`;
        }
        comp.mode = value.toLowerCase() as 'build' | 'plan' | 'goal';
      } else {
        return 'Logic components don\'t have a mode.';
      }
      break;
    case 'prompt':
      comp.prompt = value;
      break;
    case 'goto_true':
      if (comp.type !== 'logic') return 'Only logic components have goto_true.';
      comp.goto_true = parseInt(value, 10);
      break;
    case 'goto_false':
      if (comp.type !== 'logic') return 'Only logic components have goto_false.';
      comp.goto_false = parseInt(value, 10);
      break;
    default:
      return `Unknown field '${field}'. Fields: mode, prompt, goto_true, goto_false.`;
  }

  FlowEngine.save(dir, wf);
  return `Updated ${field} → '${value}' on component #${id}.`;
}

function removeComponent(dir: string, args: string[]): string {
  if (args.length < 2) return 'Usage: rmc <name> <id>';
  const name = args[0];
  const id = parseInt(args[1], 10);
  const result = getFlow(dir, name);
  if (typeof result === 'string') return result;
  const { wf } = result;

  const idx = wf.components.findIndex(c => c.id === id);
  if (idx < 0) return `Component #${id} not found.`;
  wf.components.splice(idx, 1);
  FlowEngine.save(dir, wf);
  return `Removed component #${id} from '${name}'.`;
}
