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
  'screen_capture',
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
  'task_read',
  'task_create',
  'question',
  'SubAgent',
  'subagent_create',
  // Legacy runtime alias. It is no longer published to models because its
  // generic name collides with the persistent task checklist.
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
  'screen_capture',
  'task_read',
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
  'SubAgent',
  'subagent_create',
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
 * 确定性无副作用的只读工具允许与兄弟 tool call 并发执行。`SubAgent` 创建是
 * 唯一允许并发的受控写操作：每个调用只追加一个独立 UUID 记录，真正的 worker
 * 并发由 SubagentManager 的 4/16 槽位及 Build Block 硬上限管理。其他写入、shell、
 * 浏览器交互、子代理发送/关闭等操作仍保持独占串行。缺省保守：不在集合中的
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
  'screen_capture',
  'SubAgent',
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

// ============================================================================
// 硬性删除审查（dev-0.4.2）
//
// 允许删除，但不允许通过脚本/命令批量删除。删除必须逐个、明确、在 Agent 监管下
// 进行：优先使用受监管的 delete_file 工具；bash/terminal_takeover 的单文件删除
// （单个明确路径、无递归、无通配符、无循环、无管道、无多目标）放行；任何递归、
// 通配符、循环、find/xargs、管道接收端、多目标或多条删除语句的批量删除一律硬性拒绝。
// 本函数是纯函数，输出字节稳定，不参与 system prompt 组装，因此不影响前缀缓存命中。
// ============================================================================

export interface DeletionGuardDecision {
  blocked: boolean;
  reason?: string;
}

/** 删除命令动词（跨 POSIX / PowerShell / cmd）。注意：不含单独 "remove"（避免匹配普通英文）。 */
const DELETE_VERB_SOURCE = '(?:remove-item|rmdir|unlink|erase|del|rm|rd|ri)';
const DELETE_VERB_BOUNDARY = new RegExp(`(?:^|[\\s;&|()\\n])${DELETE_VERB_SOURCE}(?:\\s|$)`, 'i');

function hasDeletionVerb(text: string): boolean {
  return DELETE_VERB_BOUNDARY.test(text);
}

function deletionVerbCount(text: string): number {
  const matches = text.match(new RegExp(DELETE_VERB_BOUNDARY.source, 'gi'));
  return matches ? matches.length : 0;
}

/** 循环结构批量删除：foreach / for…in / for( / CMD for…do del / while( / bash do…done。 */
function hasLoopDeletion(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\bforeach\b/.test(lower)) return true;                       // PowerShell foreach / ForEach-Object
  if (/\bfor\b\s*[$({]/.test(lower)) return true;                 // PowerShell/C/bash for(...)
  if (/\bfor\b\s+\S+\s+in\b/.test(lower)) return true;          // bash for f in ... / CMD for %f in (...)
  if (/\bfor\b[^\n;&|]*\bdo\b[^\n;&|]*\b(?:del|rm|erase|remove-item|ri)\b/.test(lower)) return true; // CMD for ... do del
  if (/\bwhile\b\s*[({]/.test(lower)) return true;                 // while(...)
  if (/\bwhile\b\s+\S/.test(lower) && /\bdo\b/.test(lower)) return true; // bash while ... do
  return false;
}

/** find -delete / find -exec rm / xargs rm 批量删除。 */
function hasFindXargsDeletion(text: string): boolean {
  if (/\bfind\b[^\n;&|]*-(?:delete\b|exec(?:dir)?\s+(?:rm|del|erase)\b)/i.test(text)) return true;
  if (/\bxargs\b[^\n;&|]*\b(?:rm|del|erase|remove-item)\b/i.test(text)) return true;
  return false;
}

/** git clean（非 dry-run）删除未跟踪文件 = 批量删除；`-n` / `--dry-run` 只预览放行。 */
function hasGitCleanDeletion(text: string): boolean {
  const lower = text.toLowerCase();
  if (!/\bgit\b\s+clean\b/.test(lower)) return false;
  if (/(?:^|\s)-[a-z]*n[a-z]*(?:\s|$)/.test(lower)) return false;
  if (/(?:^|\s)--dry-run(?:\s|$)/.test(lower)) return false;
  return true;
}

/** 按 shell 语义切分参数：引号内的空格不拆分，返回去引号后的 token。 */
function splitCommandArgs(args: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    const token = m[1] ?? m[2] ?? m[3] ?? '';
    if (token) tokens.push(token);
  }
  return tokens;
}

/** 管道接收端删除：上游产出多项，删除动词作为接收端即批量删除。`||`（逻辑或）不是管道。 */
function hasPipeDeletion(text: string): boolean {
  return /(?<!\|)\|\s*(?:remove-item|rmdir|unlink|erase|del|rm|rd|ri)\b/i.test(text);
}

/** 递归删除标志：rm -r/-R/--recursive、Remove-Item/ri -Recurse、rmdir/rd /s、del/erase /s。 */
function hasRecursiveDeletionFlag(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\brm\b\s+(-[a-z]*r[a-z]*|--recursive)\b/.test(lower)) return true;
  if (/\b(?:remove-item|ri)\b[^\n;&|]*\s+-(?:recurse|r)\b/.test(lower)) return true;
  if (/\b(?:rmdir|rd)\b\s+(-r\b|\/[s]\b)/.test(lower)) return true;
  if (/\b(?:del|erase)\b\s+\/[s]\b/.test(lower)) return true;
  return false;
}

/** 删除命令后跟含通配符的目标 token。 */
function hasWildcardDeletionTarget(text: string): boolean {
  const segmentRe = new RegExp(`(?:^|[\\s;&|()\\n])${DELETE_VERB_SOURCE}([\\s][^;&|\\n]*)?`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = segmentRe.exec(text)) !== null) {
    const args = m[1] || '';
    for (const token of splitCommandArgs(args)) {
      if (!token || token.startsWith('-') || /^\/[A-Za-z]/.test(token)) continue;
      if (/[*?]/.test(token)) return true;
    }
  }
  return false;
}

/** 单条删除命令后跟 >= 2 个明确目标（非 flag、非 shell 开关）。 */
function hasMultipleDeleteTargets(text: string): boolean {
  const segmentRe = new RegExp(`(?:^|[\\s;&|()\\n])${DELETE_VERB_SOURCE}([\\s][^;&|\\n]*)?`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = segmentRe.exec(text)) !== null) {
    const args = m[1] || '';
    const targets = splitCommandArgs(args)
      .filter(t => t && !t.startsWith('-') && !/^\/[A-Za-z]/.test(t) && !/^(&&|\|\||;|\||&|>|>>|<|2>&1)$/.test(t));
    if (targets.length >= 2) return true;
  }
  return false;
}

/**
 * 硬性删除命令审查。blocked=true 表示该命令构成脚本/命令批量删除，必须拒绝并
 * 引导 Agent 使用受监管的 delete_file 工具逐个删除。
 */
export function evaluateDeletionGuard(command: string): DeletionGuardDecision {
  const text = String(command || '');
  if (!text.trim()) return { blocked: false };
  // find -delete / find -exec rm 中，-delete 不含标准删除动词；git clean 也不含删除动词，
  // 均需在入口单独识别为批量删除意图。
  const findXargs = hasFindXargsDeletion(text);
  const gitClean = hasGitCleanDeletion(text);
  if (!hasDeletionVerb(text) && !findXargs && !gitClean) return { blocked: false };

  const refuse = (kind: string): DeletionGuardDecision => ({
    blocked: true,
    reason: `[deletion guard] ${kind} batch deletion is not allowed. Delete files one by one with the delete_file tool under Agent supervision.`,
  });

  if (hasLoopDeletion(text)) return refuse('Loop-based');
  if (findXargs) return refuse('find/xargs');
  if (gitClean) return refuse('git-clean');
  if (hasPipeDeletion(text)) return refuse('Pipe-fed');
  if (hasRecursiveDeletionFlag(text)) return refuse('Recursive');
  if (hasWildcardDeletionTarget(text)) return refuse('Wildcard');
  if (hasMultipleDeleteTargets(text)) return refuse('Multiple-target');
  if (deletionVerbCount(text) >= 2) return refuse('Multiple-statement');
  return { blocked: false };
}
