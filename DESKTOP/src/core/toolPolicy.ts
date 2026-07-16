import { AgentMode } from './types';

export type ToolAvailability = 'required' | 'mode-scoped' | 'configurable';

export interface ToolPolicyRequest {
  name: string;
  mode?: AgentMode | string;
  isSubagent?: boolean;
  args?: Record<string, unknown>;
}

export interface ToolPolicyDecision {
  allowed: boolean;
  availability: ToolAvailability;
  settingsVisible: boolean;
  reason?: string;
}

const REQUIRED_TOOLS = new Set(['pwd', 'read', 'glob', 'grep']);
const MODE_SCOPED_TOOLS = new Set([
  'image_inspect',
  'linked_plan',
  'question',
  'task',
  'subagent_list',
  'subagent_read',
  'subagent_send',
  'subagent_result',
  'subagent_close',
]);
const PLAN_READ_ONLY_TOOLS = new Set([
  'pwd',
  'read',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'browser_open',
  'browser_snapshot',
  'image_inspect',
  'git_status',
  'file_audit',
  'repo_security_audit',
  'automation_list',
  'memory_lab_read',
  'linked_plan',
  'task',
  'subagent_list',
  'subagent_read',
  'subagent_send',
  'subagent_result',
  'subagent_close',
  'question',
]);
export const PLAN_COMPUTER_USE_ACTIONS = ['observe', 'app_list', 'app_observe'] as const;
export const PLAN_BROWSER_USE_ACTIONS = ['observe', 'navigate', 'wait', 'extract'] as const;
const PLAN_COMPUTER_USE_ACTION_SET = new Set<string>(PLAN_COMPUTER_USE_ACTIONS);
const PLAN_BROWSER_USE_ACTION_SET = new Set<string>(PLAN_BROWSER_USE_ACTIONS);

export function isReadOnlyScopedToolAction(name: string, action: string): boolean {
  if (name === 'computer_use') return PLAN_COMPUTER_USE_ACTION_SET.has(action);
  if (name === 'browser_use') return PLAN_BROWSER_USE_ACTION_SET.has(action);
  return false;
}

export function toolAvailability(name: string): ToolAvailability {
  if (REQUIRED_TOOLS.has(name)) return 'required';
  if (MODE_SCOPED_TOOLS.has(name)) return 'mode-scoped';
  return 'configurable';
}

export function evaluateToolPolicy(request: ToolPolicyRequest): ToolPolicyDecision {
  const name = String(request.name || '').trim();
  const availability = toolAvailability(name);
  const base = { availability, settingsVisible: availability === 'configurable' };
  if (!name) return { ...base, allowed: false, reason: '[permission] Tool name is required.' };

  if (request.mode === 'plan') {
    if (name === 'computer_use') {
      const action = String(request.args?.action || '').trim();
      if (!PLAN_COMPUTER_USE_ACTION_SET.has(action)) {
        return { ...base, allowed: false, reason: `[permission] Plan mode only allows Computer Use observation. Blocked: computer_use.${action || '(missing action)'}` };
      }
      return { ...base, allowed: true };
    }
    if (name === 'browser_use') {
      const action = String(request.args?.action || '').trim();
      if (!PLAN_BROWSER_USE_ACTION_SET.has(action)) {
        return { ...base, allowed: false, reason: `[permission] Plan mode only allows Browser-Use observation and read-only navigation. Blocked: browser_use.${action || '(missing action)'}` };
      }
      return { ...base, allowed: true };
    }
    if (!PLAN_READ_ONLY_TOOLS.has(name)) {
      return { ...base, allowed: false, reason: `[permission] Plan mode is fully read-only. Blocked: ${name}` };
    }
  }

  if (request.isSubagent) {
    if (name === 'skill_download' || name === 'question' || name.startsWith('automation_')) {
      return { ...base, allowed: false, reason: `[Subagent sandbox] Tool '${name}' is disabled for peer agents.` };
    }
  }
  return { ...base, allowed: true };
}

export function filterToolDefinitions<T>(definitions: T[], request: Omit<ToolPolicyRequest, 'name' | 'args'>): T[] {
  return definitions.filter(definition => {
    const name = String((definition as any)?.function?.name || '');
    if (request.mode === 'plan' && (name === 'computer_use' || name === 'browser_use')) return true;
    return evaluateToolPolicy({ ...request, name }).allowed;
  });
}

export function planModePolicyPrompt(): string {
  return [
    'Plan mode is read-only for the workspace, host environment, network services, and user applications.',
    'Use only observation/read tools, read-only peer-agent orchestration, and linked_plan maintenance.',
    'Peer agents created in Plan mode inherit Plan mode and cannot request a writable mode.',
    'Runtime policy rejects stale or hidden mutating tool calls even if a prompt asks for them.',
  ].join(' ');
}
