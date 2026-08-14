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
  'image_display',
  'ocr_read',
  'pdf_read',
  'linked_plan',
  'build_history_query',
  'context_compress',
  'context_history_manage',
  'compress_tool_result',
  'background_tool',
  'read_tool_result',
  'goal_manage',
  'conversation_rename',
  'question',
  'task',
  'subagent_list',
  'subagent_read',
  'subagent_send',
  'subagent_result',
  'subagent_close',
  'branch_list',
  'branch_send',
  'branch_read',
  'branch_create',
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
  'ocr_read',
  'pdf_read',
  'git_status',
  'file_audit',
  'repo_security_audit',
  'automation_list',
  'memory_lab_read',
  'memory_lab_query',
  'skill',
  'linked_plan',
  'build_history_query',
  'task',
  'subagent_list',
  'subagent_read',
  'subagent_send',
  'subagent_result',
  'subagent_close',
  'branch_list',
  'branch_read',
  'question',
]);
export const PLAN_COMPUTER_USE_ACTIONS = ['observe', 'app_list', 'app_observe'] as const;
export const PLAN_BROWSER_USE_ACTIONS = ['observe', 'navigate', 'wait', 'extract'] as const;
const PLAN_COMPUTER_USE_ACTION_SET = new Set<string>(PLAN_COMPUTER_USE_ACTIONS);
const PLAN_BROWSER_USE_ACTION_SET = new Set<string>(PLAN_BROWSER_USE_ACTIONS);

/**
 * 并发安全工具集合（DSH isConcurrencySafe 语义的 Newmark 落地）。
 *
 * 只有确定性无副作用的只读工具才允许与兄弟 tool call 并发执行；任何写入、
 * shell 命令、浏览器交互、子代理编排、以及会改变对话/文件/外部状态的工具
 * 都保持独占串行，避免盲目 Promise.all 引发竞态。缺省保守：不在集合中的
 * 工具一律视为独占。
 *
 * 注意：read/grep/glob/pwd 是同一进程内的内存/文件系统只读，可安全重叠；
 * web_search/web_fetch 只读网络，可重叠；git_status/file_audit/repo_security_audit
 * 只读审计，可重叠。其余（含 memory_lab_read 等读接口）因可能触发内部缓存/
 * 重建副作用，默认保守串行。
 */
const CONCURRENCY_SAFE_TOOLS = new Set<string>([
  'pwd',
  'read',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'git_status',
  'file_audit',
  'repo_security_audit',
]);

/** 判断一个工具是否可参与并行调度。缺省 false（独占）。
 *  优先看 toolchain registry 推断的 riskLevel（'read' 工具天然并发安全，
 *  seedToolchainFromDefinitions 的 inferRiskLevel 自动推断），显式白名单作兜底。
 *  这样后续新增工具只需在 ToolExecutor.definitions() 加 schema，seed 时其
 *  riskLevel 被自动推断，'read' 工具自动并发安全——无需再改本文件。 */
export function isConcurrencySafeTool(name: string, riskLevel?: string): boolean {
  const toolName = String(name || '').trim();
  if (CONCURRENCY_SAFE_TOOLS.has(toolName)) return true;
  // 从 toolchain registry 派生的 riskLevel：read 工具默认并发安全。
  return riskLevel === 'read';
}

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
    if (name === 'skill_download' || name === 'question' || name.startsWith('automation_') || name === 'goal_manage' || name === 'conversation_rename') {
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
