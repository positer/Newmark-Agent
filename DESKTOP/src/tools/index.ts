import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync, spawnSync } from 'child_process';
// glob v7 - imported via require for CommonJS compatibility
const globSync: (pattern: string, opts?: { cwd?: string; ignore?: string | string[] }) => string[]
  = require('glob').sync;
import { ConfigManager } from '../core/config';
import { BrowserControl, BrowserControlRequest, BrowserControlResult } from '../core/browserControl';
import { MemoryLabManager } from '../core/memoryLab';
import {
  NewmarkToolDefinition,
  NewmarkToolResult,
  emitAnthropicTool,
  emitOpenAIChatTool,
  emitOpenAIResponsesTool,
  legacyToolToNewmark,
  normalizeToolResult,
} from '../core/compat';
import { runTerminalTakeover } from './terminalTakeover';
import { runComputerUse } from './computerUse';
import { isNativeToolEnabled } from './nativeTools';
import { SshManager } from '../core/ssh';
import { WorkspaceManager } from '../core/workspace';

export interface ToolExecutionContext {
  mode?: string;
  workspacePath?: string;
  allowEphemeralVisionImage?: boolean;
  conversationId?: string;
  invocation?: 'agent' | 'cli';
}

type ComputerUseLock = {
  owner: string;
  workspacePath: string;
  acquiredAt: number;
  updatedAt: number;
};

let computerUseLock: ComputerUseLock | null = null;
const COMPUTER_USE_LOCK_TTL_MS = 10 * 60 * 1000;

function normalizeComputerUseAction(action: string): string {
  return String(action || '').trim().toLowerCase();
}

function computerUseOwner(context: ToolExecutionContext, wsPath: string): string {
  const conversationId = String(context.conversationId || '').trim();
  if (conversationId) return `conversation:${conversationId}`;
  const resolved = path.resolve(context.workspacePath || wsPath || process.cwd());
  const workspaceHash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 12);
  return `direct:${workspaceHash}`;
}

function clearStaleComputerUseLock(now = Date.now()): void {
  if (computerUseLock && now - computerUseLock.updatedAt > COMPUTER_USE_LOCK_TTL_MS) {
    computerUseLock = null;
  }
}

function computerUseLockError(action: string, owner: string): string {
  return JSON.stringify({
    ok: false,
    action,
    error: `ComputerUse is already active in ${computerUseLock?.owner || 'another conversation'}. Stop it with computer_use takeover_stop or wait before using ComputerUse from another conversation.`,
    lock_owner: computerUseLock?.owner || '',
    requested_owner: owner,
  }, null, 2);
}

function acquireComputerUseLock(action: string, owner: string, wsPath: string): string | null {
  const now = Date.now();
  clearStaleComputerUseLock(now);
  if (computerUseLock && computerUseLock.owner !== owner) {
    return computerUseLockError(action, owner);
  }
  computerUseLock = {
    owner,
    workspacePath: path.resolve(wsPath || process.cwd()),
    acquiredAt: computerUseLock?.owner === owner ? computerUseLock.acquiredAt : now,
    updatedAt: now,
  };
  return null;
}

function releaseComputerUseLock(action: string, owner: string): string | null {
  clearStaleComputerUseLock();
  if (computerUseLock && computerUseLock.owner !== owner) {
    return computerUseLockError(action, owner);
  }
  if (computerUseLock?.owner === owner) computerUseLock = null;
  return null;
}

function assertComputerUseLockOwner(action: string, owner: string): string | null {
  clearStaleComputerUseLock();
  if (computerUseLock && computerUseLock.owner !== owner) {
    return computerUseLockError(action, owner);
  }
  return null;
}

export class ToolExecutor {
  private root: string;

  constructor(root: string, private config: ConfigManager, private ssh?: SshManager, private workspace?: WorkspaceManager) {
    this.root = root;
  }

  async webSearch(query: string): Promise<string> {
    return this.wsearch(query);
  }

  definitions(mode?: string): unknown[] {
    const t = (name: string, desc: string, params: Record<string, unknown>, required: string[]) => ({
      type: 'function',
      function: {
        name,
        description: desc,
        parameters: {
          type: 'object',
          properties: params,
          required,
        },
      },
    });

    const shellDescription = process.platform === 'win32'
      ? 'Run a shell command in Windows PowerShell. Use PowerShell syntax only (Get-ChildItem not dir /s, Get-Content not type, Set-Content not echo >, 2>$null not 2>nul, and `; if ($?) { ... }` instead of &&).'
      : 'Run a shell command in bash on Linux/macOS. Use POSIX/bash syntax and normal Unix paths.';
    const tools = [
      t('bash', `${shellDescription} Optional timeout_ms lets the Agent choose this command timeout in milliseconds; 0 requests no limit, but a nonzero terminal.interrupt_timeout_ms setting is the upper cap.`, { command: { type: 'string' }, timeout_ms: { type: 'number', description: 'Per-command timeout in milliseconds. 0 means no requested limit unless capped by settings.' } }, ['command']),
      t('pwd', 'Print working directory (current folder path)', {}, []),
      t('read', 'Read file contents. Use ABSOLUTE paths. The working directory is given in system prompt.', { path: { type: 'string' } }, ['path']),
      t('write', 'Write/create a file. Use ABSOLUTE paths.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
      t('edit', 'Edit file with find-and-replace. Use ABSOLUTE paths.', { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, ['path', 'old_str', 'new_str']),
      t('glob', 'Find files by glob pattern (e.g. **/*.ts, src/**/*.html)', { pattern: { type: 'string' } }, ['pattern']),
      t('grep', 'Search file content with regex', { pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern', 'path']),
      t('web_search', 'Search the web', { query: { type: 'string' } }, ['query']),
      t('web_fetch', 'Fetch and extract URL content', { url: { type: 'string' } }, ['url']),
      t('browser_open', 'Open a URL in Newmark browser control. Uses Chromium/CDP backend in Desktop. URL must be http, https, file, or about:blank.', { url: { type: 'string' } }, ['url']),
      t('browser_snapshot', 'Return the current browser URL, title, and readable page text from Newmark browser control.', { max_chars: { type: 'number' } }, []),
      t('browser_click', 'Click an element in the controlled browser by CSS selector.', { selector: { type: 'string' } }, ['selector']),
      t('browser_type', 'Type text into an element in the controlled browser by CSS selector.', { selector: { type: 'string' }, text: { type: 'string' } }, ['selector', 'text']),
      t('browser_eval', 'Execute JavaScript in the controlled browser and return a JSON-serializable result. Use only for page inspection or interaction.', { script: { type: 'string' } }, ['script']),
      t('browser_back', 'Navigate the controlled browser back.', {}, []),
      t('browser_forward', 'Navigate the controlled browser forward.', {}, []),
      t('browser_reload', 'Reload the controlled browser.', {}, []),
      t('browser_cdp', 'Run a raw Chrome DevTools Protocol command against the controlled browser. Advanced use only.', { method: { type: 'string' }, params: { type: 'object' } }, ['method']),
      t('computer_use', 'Native desktop Computer Use control. takeover_start/takeover_stop show or clear a full-virtual-desktop dynamic gradient edge indicator while the Agent is taking over the desktop. observe captures an ephemeral full desktop screenshot; app_list/app_observe/app_activate/app_click/app_scroll/app_type/app_key scope perception and actions to a specific taskbar/visible application window by title, process name, PID, or window handle. Vision screenshots remain one-time inputs and are deleted immediately after request preparation or before non-vision returns.', {
        action: { type: 'string', enum: ['observe', 'app_list', 'app_observe', 'takeover_start', 'takeover_stop', 'move', 'click', 'scroll', 'type', 'key', 'wait', 'app_activate', 'app_click', 'app_scroll', 'app_type', 'app_key'] },
        x: { type: 'number' },
        y: { type: 'number' },
        target_id: { type: 'string', description: 'Stable id from the latest observe perception.objects entry. Preferred over raw coordinates when available.' },
        app_target: { type: 'string', description: 'Application title, process name, or process id for app-scoped observation and actions.' },
        window_handle: { type: 'string', description: 'Native window handle from app_list/app_observe for exact app-scoped actions.' },
        scroll_x: { type: 'number', description: 'Horizontal scroll delta for action=scroll.' },
        scroll_y: { type: 'number', description: 'Vertical scroll delta for action=scroll. Positive scrolls down.' },
        button: { type: 'string', enum: ['left', 'right'] },
        text: { type: 'string' },
        key: { type: 'string' },
        duration_ms: { type: 'number' },
        dry_run: { type: 'boolean' },
      }, ['action']),
      t('terminal_takeover', 'Take over a persistent shell session that is independent from the one-shot bash tool. Actions: start creates/reuses a named session, write sends a command to the same session, read returns its output buffer, stop interrupts it, list shows sessions. Use this when the user wants continuous terminal state such as cd/env/process context.', {
        action: { type: 'string', enum: ['start', 'write', 'read', 'stop', 'list'] },
        name: { type: 'string', description: 'Stable takeover session name. Defaults to agent.' },
        shell: { type: 'string', enum: ['powershell', 'pwsh', 'cmd', 'bash', 'sh'] },
        command: { type: 'string', description: 'Command text for action=write.' },
        max_chars: { type: 'number', description: 'Maximum trailing buffer characters for action=read.' },
      }, ['action']),
      t('ssh_workspace', 'Manage native OpenSSH connections and remote external workspaces. Uses the system ssh executable with argument-array invocation, BatchMode, ConnectTimeout, and no stored passwords. Actions: list, upsert, remove, validate, create_workspace. validate reads/creates remote PC_Hash.config; create_workspace validates SSH, creates the remote directory if needed, links saved remote workspaces with matching PC_Hash, and creates a local shadow workspace for conversation state.', {
        action: { type: 'string', enum: ['list', 'upsert', 'remove', 'validate', 'create_workspace'] },
        id: { type: 'string' },
        name: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'number' },
        user: { type: 'string' },
        identity_file: { type: 'string' },
        remote_root: { type: 'string' },
        remote_path: { type: 'string' },
      }, ['action']),
      t('task', 'Create and run a constrained subagent. Optional preset/agent selects a normalized Codex, Claude Code, OpenCode, or Newmark agent preset. Subagents cannot change settings or choose their own model.', { name: { type: 'string' }, prompt: { type: 'string' }, preset: { type: 'string' }, agent: { type: 'string' }, model: { type: 'string' }, mode: { type: 'string' }, input_mode: { type: 'string' }, flow: { type: 'string' } }, ['prompt']),
      t('subagent_send', 'Continue an existing subagent by name or id with another prompt.', { name: { type: 'string' }, prompt: { type: 'string' } }, ['name', 'prompt']),
      t('subagent_result', 'Return get.subagent(name): the latest result and conversation content for a subagent.', { name: { type: 'string' } }, ['name']),
      t('subagent_close', 'Close an existing subagent by name or id and release it from the active agent list.', { name: { type: 'string' } }, ['name']),
      t('question', 'Ask user a multiple-choice question', { questions: { type: 'array' } }, ['questions']),
      t('skill_download', 'Download a skill', { name: { type: 'string' }, source: { type: 'string' } }, ['name', 'source']),
      t('flow_list', 'List available Newmark Flow workflows from the Flow folder so the agent can choose one.', {}, []),
      t('flow_save', 'Design or update a Newmark Flow workflow. Components must be an array of dialog/logic objects compatible with *.Flow.json.', { name: { type: 'string' }, components: { type: 'array' } }, ['name', 'components']),
      t('flow_run', 'Trigger an existing Newmark Flow workflow by name with optional input and start component.', { name: { type: 'string' }, input: { type: 'string' }, start: { type: 'number' } }, ['name']),
      t('memory_lab_read', 'Read Memory Lab index.json, its path, and usage instructions. Optionally pass component/name/slug to read a memory component core markdown.', { component: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' } }, []),
      t('memory_lab_update', 'Create or update a Memory Lab persistent memory component. Agent must pass name, description, hierarchical tags, concrete markdown content, and optional kind=file|folder. Routed through the Agent runtime so MemoryLabIndexAgent can organize it with the current working model.', { name: { type: 'string' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, content: { type: 'string' }, kind: { type: 'string', enum: ['file', 'folder'] } }, ['name', 'tags', 'content']),
      t('memory_lab_reindex', 'Rebuild and organize Memory Lab index links. Routed through Agent runtime when invoked by the model.', {}, []),
      t('automation_list', 'List persisted Newmark automations so the agent can inspect scheduled work.', {}, []),
      t('automation_create', 'Create a persisted Newmark automation. Supports once, loop, and schedule conditions. The prompt is what the agent will run later.', {
        prompt: { type: 'string' },
        model: { type: 'string' },
        condition: { type: 'string', enum: ['once', 'loop', 'schedule'] },
        interval_sec: { type: 'number' },
        start_at: { type: 'string' },
        end_at: { type: 'string' },
        active: { type: 'boolean' },
      }, ['prompt']),
      t('automation_update', 'Update an existing persisted Newmark automation by id.', {
        id: { type: 'string' },
        prompt: { type: 'string' },
        model: { type: 'string' },
        condition: { type: 'string', enum: ['once', 'loop', 'schedule'] },
        interval_sec: { type: 'number' },
        start_at: { type: 'string' },
        end_at: { type: 'string' },
        active: { type: 'boolean' },
      }, ['id']),
      t('automation_toggle', 'Pause or resume an existing persisted Newmark automation by id.', { id: { type: 'string' } }, ['id']),
      t('automation_delete', 'Delete an existing persisted Newmark automation by id.', { id: { type: 'string' } }, ['id']),
      t('git_status', 'Show git status', {}, []),
      t('file_audit', 'Audit file creation/change state. Uses local filesystem and git metadata by default, and adds GitHub remote metadata for files inside a GitHub-backed repository when include_remote is true.', {
        path: { type: 'string' },
        include_remote: { type: 'boolean' },
        base_ref: { type: 'string' },
      }, []),
      t('repo_security_audit', 'Review a local or remote-backed repository for release/privacy risk before remote actions. Reports GitHub/private/public state, dirty files, ignored local-only files, likely secret material, release-excluded paths, and recommended next checks. Read-only.', {
        path: { type: 'string' },
        base_ref: { type: 'string' },
      }, []),
      t('git_pull', 'Pull from remote', {}, []),
      t('git_push', 'Stage, commit, push', { message: { type: 'string' } }, ['message']),
      t('git_clone', 'Clone a git repo', { url: { type: 'string' }, path: { type: 'string' } }, ['url', 'path']),
      t('git_branch', 'Inspect or manage local git branches. Actions: current, list, create, switch.', {
        action: { type: 'string', enum: ['current', 'list', 'create', 'switch'] },
        name: { type: 'string' },
        start_point: { type: 'string' },
      }, ['action']),
      t('gh_auth_status', 'Run `gh auth status` through GitHub CLI and return authentication state.', {}, []),
      t('gh_repo_view', 'Run `gh repo view` for the current repo or provided repo, returning concise metadata.', { repo: { type: 'string' } }, []),
      t('gh_issue_list', 'Run `gh issue list` for the current repo or provided repo.', { repo: { type: 'string' }, limit: { type: 'number' } }, []),
      t('gh_pr_list', 'Run `gh pr list` for the current repo or provided repo.', { repo: { type: 'string' }, limit: { type: 'number' } }, []),
      t('gh_fork', 'Create or inspect a GitHub fork through GitHub CLI. action=status is read-only; action=create is an explicit remote write.', {
        action: { type: 'string', enum: ['status', 'create'] },
        repo: { type: 'string' },
        clone: { type: 'boolean' },
        remote: { type: 'boolean' },
        remote_name: { type: 'string' },
      }, []),
      t('gh_pr_create', 'Create a GitHub pull request for the current branch through GitHub CLI. Requires explicit title and body.', {
        title: { type: 'string' },
        body: { type: 'string' },
        base: { type: 'string' },
        head: { type: 'string' },
        draft: { type: 'boolean' },
      }, ['title', 'body']),
    ];
    let visibleTools = tools.filter((tool: any) => isNativeToolEnabled(tool.function?.name || '', this.config.nativeToolEnabled()));
    if (this.config.getStr('agent', 'option_feedback') === 'fully_autonomous') {
      visibleTools = visibleTools.filter((tool: any) => tool.function?.name !== 'question');
    }
    if (mode === 'plan') {
      return visibleTools.filter((tool: any) =>
        ['pwd', 'read', 'glob', 'grep', 'web_search', 'web_fetch', 'browser_open', 'browser_snapshot', 'git_status', 'file_audit', 'repo_security_audit'].includes(tool.function?.name)
        || tool.function?.name === 'automation_list'
        || tool.function?.name === 'memory_lab_read'
      );
    }
    return visibleTools;
  }

  canonicalDefinitions(mode?: string): NewmarkToolDefinition[] {
    return this.definitions(mode)
      .map(def => legacyToolToNewmark(def))
      .filter((def): def is NewmarkToolDefinition => !!def);
  }

  openAIResponsesDefinitions(mode?: string): unknown[] {
    return this.canonicalDefinitions(mode).map(emitOpenAIResponsesTool);
  }

  anthropicDefinitions(mode?: string): unknown[] {
    return this.canonicalDefinitions(mode).map(emitAnthropicTool);
  }

  openAIChatDefinitions(mode?: string): unknown[] {
    return this.canonicalDefinitions(mode).map(emitOpenAIChatTool);
  }

  async executeEnvelope(tool: string, argsStr: string, wsPath: string, context: ToolExecutionContext = {}): Promise<NewmarkToolResult> {
    const output = await this.execute(tool, argsStr, wsPath, context);
    return normalizeToolResult(output, { tool, workspacePath: wsPath, mode: context.mode || '' });
  }

  async execute(tool: string, argsStr: string, wsPath: string, context: ToolExecutionContext = {}): Promise<string> {
    if (!isNativeToolEnabled(tool, this.config.nativeToolEnabled())) {
      return `[tool disabled] ${tool} is disabled in Settings > Tools.`;
    }
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsStr); } catch { /* use empty */ }
    const g = (k: string) => {
      const value = args[k];
      return value === undefined || value === null ? '' : String(value);
    };
    const resolve = (relPath: string) => {
      if (path.isAbsolute(relPath)) return relPath;
      return path.join(wsPath, relPath);
    };

    const targetForTool = () => {
      switch (tool) {
        case 'read':
        case 'write':
        case 'edit':
        case 'grep':
        case 'file_audit':
          return resolve(g('path'));
        case 'git_clone':
          return resolve(g('path'));
        case 'ssh_workspace':
          return wsPath;
        default:
          return wsPath;
      }
    };

    const planGuard = this.checkPlanMode(tool, targetForTool(), context.mode || '', context.workspacePath || wsPath);
    if (planGuard) return planGuard;
    const permissionGuard = this.checkWorkspaceAccess(tool, targetForTool(), context.workspacePath || wsPath);
    if (permissionGuard) return permissionGuard;
    const bashGuard = (tool === 'bash' || (tool === 'terminal_takeover' && g('action') === 'write'))
      ? this.checkBashWorkspaceAccess(g('command'), context.workspacePath || wsPath)
      : null;
    if (bashGuard) return bashGuard;

    try {
      switch (tool) {
        case 'bash': return this.bash(g('command'), wsPath, args.timeout_ms);
        case 'pwd': return `Current directory: ${wsPath}`;
        case 'read': return this.fread(resolve(g('path')));
        case 'write': return this.fwrite(resolve(g('path')), g('content'));
        case 'edit': return this.fedit(resolve(g('path')), g('old_str'), g('new_str'));
        case 'glob': return this.glob(g('pattern'), wsPath);
        case 'grep': return this.grep(g('pattern'), resolve(g('path')));
        case 'web_search': return await this.wsearch(g('query'));
        case 'web_fetch': return await this.wfetch(g('url'));
        case 'browser_open': return await this.browserRun({ action: 'open', url: g('url') });
        case 'browser_snapshot': return await this.browserRun({ action: 'snapshot', maxChars: Number((args as Record<string, unknown>).max_chars || 12000) });
        case 'browser_click': return await this.browserRun({ action: 'click', selector: g('selector') });
        case 'browser_type': return await this.browserRun({ action: 'type', selector: g('selector'), text: g('text') });
        case 'browser_eval': return await this.browserRun({ action: 'eval', script: g('script') });
        case 'browser_back': return await this.browserRun({ action: 'back' });
        case 'browser_forward': return await this.browserRun({ action: 'forward' });
        case 'browser_reload': return await this.browserRun({ action: 'reload' });
        case 'browser_cdp': return await this.browserRun({ action: 'cdp', method: g('method'), params: (args as Record<string, unknown>).params || {} });
        case 'computer_use': {
          const action = normalizeComputerUseAction(g('action'));
          const owner = computerUseOwner(context, wsPath);
          const lockGuard = action === 'takeover_stop'
            ? assertComputerUseLockOwner(action, owner)
            : acquireComputerUseLock(action, owner, wsPath);
          if (lockGuard) return lockGuard;
          const output = runComputerUse({
            action,
            x: Number((args as Record<string, unknown>).x),
            y: Number((args as Record<string, unknown>).y),
            scrollX: Number((args as Record<string, unknown>).scroll_x || 0),
            scrollY: Number((args as Record<string, unknown>).scroll_y || 0),
            targetId: g('target_id'),
            button: g('button'),
            text: g('text'),
            key: g('key'),
            appTarget: g('app_target'),
            windowHandle: g('window_handle'),
            durationMs: Number((args as Record<string, unknown>).duration_ms || 0),
            maxChars: Number((args as Record<string, unknown>).max_chars || 30000),
            dryRun: (args as Record<string, unknown>).dry_run === true,
            workspacePath: wsPath,
            allowEphemeralVisionImage: context.allowEphemeralVisionImage === true,
            gradientColors: Array.isArray((args as Record<string, unknown>).gradient_colors) ? (args as Record<string, unknown>).gradient_colors as string[] : (this.config.get<string[]>('ui', 'gradient_colors') || []),
            gradientSpeed: (args as Record<string, unknown>).gradient_speed !== undefined ? Number((args as Record<string, unknown>).gradient_speed) : this.config.getNum('ui', 'gradient_speed'),
            gradientWidth: (args as Record<string, unknown>).gradient_width !== undefined ? Number((args as Record<string, unknown>).gradient_width) : this.config.getNum('ui', 'gradient_width'),
            invocation: context.invocation,
          });
          if (action === 'takeover_stop') releaseComputerUseLock(action, owner);
          return output;
        }
        case 'terminal_takeover': return runTerminalTakeover({
          action: g('action'),
          name: g('name'),
          shell: g('shell'),
          command: g('command'),
          cwd: wsPath,
          maxChars: Number((args as Record<string, unknown>).max_chars || 12000),
        });
        case 'ssh_workspace': return this.sshWorkspace(args, wsPath);
        case 'task': return `[task] Subagent request accepted: ${g('name')}`;
        case 'subagent_send': return `[subagent_send] Routed to Agent runtime: ${g('name')}`;
        case 'subagent_result': return `[subagent_result] Routed to Agent runtime: ${g('name')}`;
        case 'subagent_close': return `[subagent_close] Routed to Agent runtime: ${g('name')}`;
        case 'question':
          if (this.config.getStr('agent', 'option_feedback') === 'fully_autonomous') {
            return '[question] Disabled by fully_autonomous option feedback.';
          }
          return '[question] Options sent to user.';
        case 'skill_download': return await this.skillDownload(g('name'), g('source'));
        case 'flow_list': return this.flowList();
        case 'flow_save': return this.flowSave(g('name'), (args as Record<string, unknown>).components);
        case 'flow_run': return `[flow_run] Routed to Agent runtime: ${g('name')}`;
        case 'memory_lab_read': return this.memoryLabRead(g('component') || g('name') || g('slug'));
        case 'memory_lab_update': return '[memory_lab_update] Routed to Agent runtime for MemoryLabIndexAgent model organization.';
        case 'memory_lab_reindex': return '[memory_lab_reindex] Routed to Agent runtime for MemoryLabIndexAgent model organization.';
        case 'automation_list': return '[automation_list] Routed to Agent runtime.';
        case 'automation_create': return '[automation_create] Routed to Agent runtime.';
        case 'automation_update': return `[automation_update] Routed to Agent runtime: ${g('id')}`;
        case 'automation_toggle': return `[automation_toggle] Routed to Agent runtime: ${g('id')}`;
        case 'automation_delete': return `[automation_delete] Routed to Agent runtime: ${g('id')}`;
        case 'git_status': return this.gstat(wsPath);
        case 'file_audit': return await this.fileAudit(resolve(g('path') || '.'), wsPath, (args as Record<string, unknown>).include_remote !== false, g('base_ref'));
        case 'repo_security_audit': return this.repoSecurityAudit(resolve(g('path') || '.'), wsPath, g('base_ref'));
        case 'git_pull': return this.gpull(wsPath);
        case 'git_push': return this.withRemoteSecurityPreamble(wsPath, this.gpush(g('message'), wsPath));
        case 'git_clone': return this.gclone(g('url'), resolve(g('path')));
        case 'git_branch': return this.gbranch(g('action'), g('name'), g('start_point'), wsPath);
        case 'gh_auth_status': return this.gh(['auth', 'status'], wsPath);
        case 'gh_repo_view': return this.ghRepoView(g('repo'), wsPath);
        case 'gh_issue_list': return this.ghList('issue', g('repo'), Number((args as Record<string, unknown>).limit || 20), wsPath);
        case 'gh_pr_list': return this.ghList('pr', g('repo'), Number((args as Record<string, unknown>).limit || 20), wsPath);
        case 'gh_fork': return this.ghFork(g('action'), g('repo'), (args as Record<string, unknown>).clone === true, (args as Record<string, unknown>).remote === true, g('remote_name'), wsPath);
        case 'gh_pr_create': return this.withRemoteSecurityPreamble(wsPath, this.ghPrCreate(g('title'), g('body'), g('base'), g('head'), (args as Record<string, unknown>).draft === true, wsPath));
        default: return `[?] Unknown tool: ${tool}`;
      }
    } catch (e: unknown) {
      return `[${tool} error] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private isInside(parent: string, child: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  }

  private sshWorkspace(args: Record<string, unknown>, wsPath: string): string {
    const manager = this.ssh || new SshManager(this.root);
    const action = String(args.action || 'list').toLowerCase();
    const id = String(args.id || '').trim();
    const input = {
      id: id || undefined,
      name: String(args.name || '').trim() || undefined,
      host: String(args.host || '').trim() || undefined,
      port: Number(args.port || 22),
      user: String(args.user || '').trim() || undefined,
      identityFile: String(args.identity_file || '').trim() || undefined,
      remoteRoot: String(args.remote_root || '').trim() || undefined,
      enabled: true,
    };
    if (action === 'list') {
      return JSON.stringify({ ok: true, connections: manager.list(true) }, null, 2);
    }
    if (action === 'upsert') {
      return JSON.stringify({ ok: true, connection: manager.upsert(input) }, null, 2);
    }
    if (action === 'remove') {
      if (!id) return '[ssh_workspace] id is required for remove.';
      return JSON.stringify({ ok: manager.remove(id) }, null, 2);
    }
    if (action === 'validate') {
      const target = id || input.id || input.name || '';
      const conn = target ? manager.get(target) : null;
      const saved = conn || manager.upsert(input);
      return JSON.stringify(manager.validate(saved.id, input.remoteRoot), null, 2);
    }
    if (action === 'create_workspace') {
      const remotePath = String(args.remote_path || args.remote_root || '').trim();
      if (!remotePath) return '[ssh_workspace] remote_path is required for create_workspace.';
      const existing = id ? manager.get(id) : null;
      const cleanInput = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ''));
      const conn = existing
        ? manager.upsert({ ...existing, ...cleanInput, id: existing.id })
        : manager.upsert(input);
      const validation = manager.ensureRemoteWorkspace(conn.id, remotePath);
      if (!validation.ok || !validation.remotePcHash) return JSON.stringify({ ok: false, validation }, null, 2);
      if (!this.workspace) {
        return JSON.stringify({ ok: false, validation, error: 'Workspace manager is not available in this runtime.' }, null, 2);
      }
      const linkedExisting = this.workspace.activateSshExternalByPcHash(conn.id, validation.remotePcHash);
      const workspace = this.workspace.addSshExternal({
        name: String(args.name || conn.name || '').trim() || undefined,
        sshConnectionId: conn.id,
        remotePath,
        remotePcHash: validation.remotePcHash,
        remoteUserHost: `${conn.user}@${conn.host}:${conn.port}`,
      });
      if (workspace) manager.markLinkedWorkspace(conn.id, workspace.name);
      return JSON.stringify({ ok: !!workspace, workspace, validation, linkedExisting: linkedExisting.length, shadowPath: workspace?.path || wsPath }, null, 2);
    }
    return `[ssh_workspace] Unknown action: ${action}`;
  }

  private checkPlanMode(tool: string, target: string, mode: string, wsPath: string): string | null {
    if (mode !== 'plan') return null;
    if (['read', 'glob', 'grep', 'web_search', 'web_fetch', 'browser_open', 'browser_snapshot', 'pwd', 'git_status', 'file_audit', 'repo_security_audit', 'automation_list'].includes(tool)) return null;
    return `[permission] Plan mode is fully read-only. Blocked: ${tool}`;
  }

  private checkWorkspaceAccess(tool: string, target: string, wsPath: string): string | null {
    const perm = this.config.getStr('workspace', 'access_permission');
    if (perm === 'full_access') return null;

    const insideWorkspace = this.isInside(wsPath, target);
    if (insideWorkspace) return null;

    const readOnlyTools = ['read', 'grep', 'glob', 'web_search', 'web_fetch', 'pwd', 'git_status', 'file_audit', 'repo_security_audit'];
    if (perm === 'outside_readonly' && readOnlyTools.includes(tool)) return null;

    const policy = this.config.getStr('workspace', 'on_permission_violation');
    const action = policy === 'ask_user' ? 'User approval required' : 'Denied';
    return `[permission] ${action}: ${tool} cannot access outside workspace (${target}).`;
  }

  private checkBashWorkspaceAccess(command: string, wsPath: string): string | null {
    const perm = this.config.getStr('workspace', 'access_permission');
    if (perm === 'full_access') return null;

    const refs = this.extractCommandPathRefs(command, wsPath);
    const outside = refs.filter(ref => !this.isInside(wsPath, ref));
    if (outside.length === 0) return null;

    const policy = this.config.getStr('workspace', 'on_permission_violation');
    const action = policy === 'ask_user' ? 'User approval required' : 'Denied';
    if (perm === 'no_outside_access') {
      return `[permission] ${action}: bash cannot access outside workspace (${outside[0]}).`;
    }
    if (perm === 'outside_readonly' && this.isReadonlyShellCommand(command)) return null;
    return `[permission] ${action}: bash cannot modify outside workspace (${outside[0]}).`;
  }

  private extractCommandPathRefs(command: string, wsPath: string): string[] {
    const refs: string[] = [];
    const tokenRe = /"([^"]+)"|'([^']+)'|([^\s;|&<>]+)/g;
    let match: RegExpExecArray | null;
    while ((match = tokenRe.exec(command)) !== null) {
      const raw = match[1] || match[2] || match[3] || '';
      const token = raw.trim().replace(/^[,()]+|[,()]+$/g, '');
      if (!token || /^https?:\/\//i.test(token) || token.startsWith('-')) continue;
      if (!this.looksLikePath(token)) continue;
      const withoutWildcard = token.replace(/[\\/][*?][^\\/]*$/g, '');
      refs.push(path.isAbsolute(withoutWildcard) ? path.resolve(withoutWildcard) : path.resolve(wsPath, withoutWildcard));
    }
    return Array.from(new Set(refs));
  }

  private looksLikePath(token: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(token) || /^\\\\/.test(token) || /^\.{1,2}[\\/]/.test(token) || token.includes('\\') || token.includes('/');
  }

  private isReadonlyShellCommand(command: string): boolean {
    const lower = command.toLowerCase();
    if (/[>]/.test(lower)) return false;
    const mutating = /(^|[\s;|&])(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|clear-content|mkdir|md|ni|rm|del|erase|mv|move|cp|copy)\b/;
    if (mutating.test(lower)) return false;
    if (/(^|[\s;|&])git\s+(clone|pull|push|checkout|switch|merge|rebase|commit|reset|clean|stash|apply)\b/.test(lower)) return false;
    return true;
  }

  private resolveBashTimeout(requestedRaw?: unknown): number | undefined {
    const configuredTimeout = this.config.getNum('terminal', 'interrupt_timeout_ms');
    const cap = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.floor(configuredTimeout) : undefined;
    const hasRequested = requestedRaw !== undefined && requestedRaw !== null && String(requestedRaw).trim() !== '';
    if (!hasRequested) return cap;
    const requestedNum = Number(requestedRaw);
    if (!Number.isFinite(requestedNum)) return cap;
    const requested = Math.max(0, Math.floor(requestedNum));
    if (requested === 0) return cap;
    return cap === undefined ? requested : Math.min(requested, cap);
  }

  private bash(cmd: string, ws: string, timeoutMs?: unknown): string {
    if (!cmd.trim()) return '[bash] No command.';
    const timeout = this.resolveBashTimeout(timeoutMs);
    const execOptions = {
      cwd: ws, encoding: 'utf-8' as const, timeout, maxBuffer: 1024 * 1024,
    };
    try {
      if (process.platform === 'win32') {
        const result = spawnSync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command', cmd,
        ], execOptions);
        const out = (result.stdout || '') + (result.stderr || '');
        if (result.error) return (out.trim() ? `${out.trim()}\n` : '') + `[bash] ${result.error.message}`;
        return out.trim() || `[bash] Exit: ${result.status ?? -1}`;
      } else {
        const result = spawnSync('/bin/bash', ['-c', cmd], execOptions);
        const out = (result.stdout || '') + (result.stderr || '');
        if (result.error) return (out.trim() ? `${out.trim()}\n` : '') + `[bash] ${result.error.message}`;
        return out.trim() || `[bash] Exit: ${result.status ?? -1}`;
      }
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return (err.stdout || '') + (err.stderr || '') || `[bash] ${e}`;
    }
  }

  private fread(p: string): string {
    try {
      const c = fs.readFileSync(p, 'utf-8');
      return c.length > 30000 ? c.slice(0, 30000) + '...\n[truncated]' : c;
    } catch (e) { return `[read] ${e}`; }
  }

  private fwrite(p: string, content: string): string {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
      return `[write] OK: ${p}`;
    } catch (e) { return `[write] ${e}`; }
  }

  private fedit(p: string, oldStr: string, newStr: string): string {
    try {
      const c = fs.readFileSync(p, 'utf-8');
      if (!c.includes(oldStr)) return `[edit] String not found in ${p}.`;
      const updated = c.replace(oldStr, newStr);
      fs.writeFileSync(p, updated, 'utf-8');
      return `[edit] OK: ${p}`;
    } catch (e) { return `[edit] ${e}`; }
  }

  private glob(pattern: string, ws: string): string {
    try {
      const results = globSync(pattern, {
        cwd: ws,
        ignore: ['**/node_modules/**'],
      });
      if (results.length === 0) return '[glob] No matches.';
      return results.slice(0, 200).join('\n');
    } catch (e) { return `[glob] ${e}`; }
  }

  private grep(pattern: string, dir: string): string {
    try {
      const re = new RegExp(pattern);
      const results: string[] = [];
      const walk = (d: string, depth: number) => {
        if (depth > 5 || results.length >= 80) return;
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isFile()) {
            try {
              const content = fs.readFileSync(full, 'utf-8');
              for (const [i, line] of content.split('\n').entries()) {
                if (re.test(line)) {
                  results.push(`${entry.name}:${i + 1}:${line.trim()}`);
                  if (results.length >= 80) return;
                }
              }
            } catch { /* skip binary */ }
          } else if (entry.isDirectory()) {
            walk(full, depth + 1);
          }
        }
      };
      walk(dir, 0);
      return results.length > 0 ? results.join('\n') : '[grep] No matches.';
    } catch (e) { return `[grep] ${e}`; }
  }

  private async createProxyAgent(): Promise<unknown> {
    const proxyUrl = this.config.getStr('proxy', 'url');
    const proxyEnabled = this.config.getBool('proxy', 'enabled');
    if (!proxyEnabled || !proxyUrl) return null;
    const mod = await import('https-proxy-agent');
    const proxyAuth = this.config.getStr('proxy', 'auth');
    return new mod.HttpsProxyAgent(proxyUrl, proxyAuth ? { headers: { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxyAuth).toString('base64') } } : undefined);
  }

  private async proxyFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const agent = await this.createProxyAgent();
    if (agent) return fetch(url, { ...options, agent } as RequestInit & { agent: unknown });
    return fetch(url, options);
  }

  private proxyExec(cmd: string, opts: { cwd?: string; encoding?: string; timeout?: number; maxBuffer?: number } = {}): string {
    const proxyUrl = this.config.getStr('proxy', 'url');
    const proxyEnabled = this.config.getBool('proxy', 'enabled');
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (proxyEnabled && proxyUrl) {
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.http_proxy = proxyUrl;
      env.https_proxy = proxyUrl;
    }
    try {
      return execSync(cmd, { ...opts, encoding: 'utf-8' as const, env }).toString().trim();
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return (err.stdout || '') + (err.stderr || '') || `[exec] ${e}`;
    }
  }

  private async wsearch(query: string): Promise<string> {
    const clean = (s: string) => s
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();

    const errors: string[] = [];

    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const resp = await this.proxyFetch(url, {
        headers: { 'User-Agent': 'NewmarkAgent/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      const html = await resp.text();
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?class="result__snippet">(.*?)<\/a>/g;
      const results: string[] = [];
      let m;
      while ((m = re.exec(html)) !== null && results.length < 8) {
        results.push(`${clean(m[2])}\n${clean(m[1])}\n${clean(m[3])}`);
      }
      if (results.length > 0) return results.join('\n\n');
      errors.push('DuckDuckGo returned no parseable results');
    } catch (e) {
      errors.push(`DuckDuckGo: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      const resp = await this.proxyFetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 NewmarkAgent/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      const html = await resp.text();
      const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
      const results: string[] = [];
      let block;
      while ((block = blockRe.exec(html)) !== null && results.length < 8) {
        const item = block[0];
        const title = item.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/);
        if (!title) continue;
        const snippet = item.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        results.push(`${clean(title[2])}\n${clean(title[1])}\n${snippet ? clean(snippet[1]) : ''}`.trim());
      }
      if (results.length > 0) return results.join('\n\n');
      errors.push('Bing returned no parseable results');
    } catch (e) {
      errors.push(`Bing: ${e instanceof Error ? e.message : String(e)}`);
    }

    return `[web_search] No results. ${errors.join('; ')}`;
  }

  private async wfetch(url: string): Promise<string> {
    try {
      const resp = await this.proxyFetch(url, {
        headers: { 'User-Agent': 'NewmarkAgent/1.0' },
        signal: AbortSignal.timeout(30000),
      });
      const html = await resp.text();
      let text = this.extractReadableText(html, url);
      if (!text) {
        text = html.replace(/<script[^>]*>.*?<\/script>/gs, '')
        .replace(/<style[^>]*>.*?<\/style>/gs, '')
        .replace(/<head[^>]*>.*?<\/head>/gs, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      }
      return text.length > 8000 ? text.slice(0, 8000) + '...\n[truncated]' : text;
    } catch (e) { return `[web_fetch] ${e}`; }
  }

  private async browserRun(request: BrowserControlRequest): Promise<string> {
    const result = await BrowserControl.run(request);
    return this.formatBrowserResult(result);
  }

  private formatBrowserResult(result: BrowserControlResult): string {
    const header = `[browser:${result.action}] ${result.ok ? 'OK' : 'ERROR'} (${result.source})`;
    if (!result.ok) return `${header}\n${result.error || 'Unknown browser control error.'}`;
    const parts = [header];
    if (result.url) parts.push(`URL: ${result.url}`);
    if (result.title) parts.push(`Title: ${result.title}`);
    if (typeof result.text === 'string' && result.text) parts.push(`Text:\n${result.text}`);
    if (result.data !== undefined) {
      try {
        parts.push(`Data:\n${JSON.stringify(result.data, null, 2)}`);
      } catch {
        parts.push(`Data:\n${String(result.data)}`);
      }
    }
    return parts.join('\n');
  }

  private extractReadableText(html: string, url: string): string {
    try {
      const { JSDOM } = require('jsdom') as typeof import('jsdom');
      const { Readability } = require('@mozilla/readability') as typeof import('@mozilla/readability');
      const dom = new JSDOM(html, { url });
      const article = new Readability(dom.window.document).parse();
      if (!article) return '';
      const parts = [
        article.title ? `# ${article.title}` : '',
        article.byline ? `By ${article.byline}` : '',
        article.excerpt ? `Summary: ${article.excerpt}` : '',
        article.textContent || '',
      ].filter(Boolean);
      return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    } catch {
      return '';
    }
  }

  private async skillDownload(name: string, src: string): Promise<string> {
    if (!src.startsWith('http')) return `[skill] Not a URL: ${src}`;
    try {
      const resp = await this.proxyFetch(src);
      const content = await resp.text();
      const dir = path.join(this.root, 'skills', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
      return `[skill] Downloaded '${name}'`;
    } catch (e) { return `[skill] ${e}`; }
  }

  private flowList(): string {
    const dir = path.join(this.root, 'Flow');
    try {
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.Flow.json'))
        .sort();
      if (!files.length) return '[flow_list] No workflows found.';
      return files.map(f => f.replace(/\.Flow\.json$/, '')).join('\n');
    } catch (e) {
      return `[flow_list] ${e}`;
    }
  }

  private flowSave(name: string, componentsRaw: unknown): string {
    const cleanName = (name || '').replace(/[<>:"/\\|?*]/g, '-').trim();
    if (!cleanName) return '[flow_save] Workflow name is required.';
    if (!Array.isArray(componentsRaw)) return '[flow_save] components must be an array.';
    const components = componentsRaw.map((raw, idx) => {
      const c = raw as Record<string, unknown>;
      const type = c.type === 'logic' ? 'logic' : 'dialog';
      if (type === 'logic') {
        return {
          id: Number.isFinite(Number(c.id)) ? Number(c.id) : idx,
          type,
          prompt: String(c.prompt || ''),
          goto_true: Number.isFinite(Number(c.goto_true ?? c.goto1)) ? Number(c.goto_true ?? c.goto1) : idx + 1,
          goto_false: Number.isFinite(Number(c.goto_false ?? c.goto2)) ? Number(c.goto_false ?? c.goto2) : idx + 1,
        };
      }
      const mode = ['build', 'plan', 'goal'].includes(String(c.mode)) ? String(c.mode) : 'build';
      return {
        id: Number.isFinite(Number(c.id)) ? Number(c.id) : idx,
        type,
        mode,
        prompt: String(c.prompt || c.base_prompt || ''),
      };
    });
    const workflow = { name: cleanName, components };
    const dir = path.join(this.root, 'Flow');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${cleanName}.Flow.json`), JSON.stringify(workflow, null, 2), 'utf-8');
    return `[flow_save] OK: ${cleanName}.Flow.json`;
  }

  private memoryLabRead(selector: string): string {
    const lab = new MemoryLabManager(this.root);
    return lab.formatRead(lab.read(selector));
  }

  private gitExec(cmd: string, ws: string): string {
    return this.proxyExec(cmd, { cwd: ws, timeout: 120000, maxBuffer: 1024 * 1024 });
  }

  private gitExecAt(repoRoot: string, args: string[]): string {
    const proxyUrl = this.config.getStr('proxy', 'url');
    const proxyEnabled = this.config.getBool('proxy', 'enabled');
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (proxyEnabled && proxyUrl) {
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.http_proxy = proxyUrl;
      env.https_proxy = proxyUrl;
    }
    try {
      const result = spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env,
      });
      const out = `${result.stdout || ''}${result.stderr || ''}`.trim();
      if (result.error) return `[git] ${result.error.message}`;
      if (result.status === 0) return out;
      return out || `[git] Exit: ${result.status ?? -1}`;
    } catch (e) {
      return `[git] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private spawnTool(command: string, args: string[], ws: string, timeout = 60000): string {
    const proxyUrl = this.config.getStr('proxy', 'url');
    const proxyEnabled = this.config.getBool('proxy', 'enabled');
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (proxyEnabled && proxyUrl) {
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.http_proxy = proxyUrl;
      env.https_proxy = proxyUrl;
    }
    try {
      const result = spawnSync(command, args, {
        cwd: ws,
        encoding: 'utf-8',
        timeout,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env,
      });
      const out = `${result.stdout || ''}${result.stderr || ''}`.trim();
      if (result.error) return `[${command}] ${result.error.message}`;
      return out || `[${command}] Exit: ${result.status ?? -1}`;
    } catch (e) {
      return `[${command}] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private gh(args: string[], ws: string): string {
    return this.spawnTool('gh', args, ws, 60000);
  }

  private ghRepoView(repo: string, ws: string): string {
    const args = ['repo', 'view'];
    if (repo) args.push(repo);
    args.push('--json', 'nameWithOwner,description,url,isPrivate,defaultBranchRef');
    return this.gh(args, ws);
  }

  private ghList(kind: 'issue' | 'pr', repo: string, limit: number, ws: string): string {
    const args = [kind, 'list'];
    if (repo) args.push('--repo', repo);
    args.push('--limit', String(Math.min(Math.max(limit || 20, 1), 100)), '--json', 'number,title,state,url');
    return this.gh(args, ws);
  }

  private async fileAudit(target: string, ws: string, includeRemote: boolean, baseRef: string): Promise<string> {
    const resolvedTarget = path.resolve(target || ws);
    const exists = fs.existsSync(resolvedTarget);
    const stat = exists ? fs.statSync(resolvedTarget) : null;
    const repoRoot = this.findGitRoot(exists && stat?.isDirectory() ? resolvedTarget : path.dirname(resolvedTarget), ws);
    const audit: Record<string, unknown> = {
      ok: true,
      target: resolvedTarget,
      exists,
      kind: stat?.isDirectory() ? 'directory' : stat?.isFile() ? 'file' : exists ? 'other' : 'missing',
      local: this.localFileAudit(resolvedTarget, stat),
      git: repoRoot ? this.gitFileAudit(repoRoot, resolvedTarget, baseRef) : { tracked: false, repository: null, note: 'No local git repository contains this path.' },
      remote: { enabled: includeRemote, provider: 'local-only', note: includeRemote ? 'No GitHub remote was detected for this path.' : 'Remote audit disabled by include_remote=false.' },
    };
    if (includeRemote && repoRoot) {
      const ghRemote = this.githubRemote(repoRoot);
      if (ghRemote) audit.remote = await this.githubFileAudit(repoRoot, resolvedTarget, ghRemote);
    }
    return JSON.stringify(audit, null, 2);
  }

  private localFileAudit(target: string, stat: fs.Stats | null): Record<string, unknown> {
    if (!stat) return { path: target, exists: false };
    const base: Record<string, unknown> = {
      path: target,
      size: stat.size,
      created_at: stat.birthtime.toISOString(),
      modified_at: stat.mtime.toISOString(),
      changed_at: stat.ctime.toISOString(),
    };
    if (stat.isFile()) {
      const hash = crypto.createHash('sha256');
      hash.update(fs.readFileSync(target));
      base.sha256 = hash.digest('hex').toUpperCase();
    }
    if (stat.isDirectory()) {
      base.entries = fs.readdirSync(target).slice(0, 200).sort();
    }
    return base;
  }

  private findGitRoot(start: string, fallback: string): string | null {
    for (const candidate of [start, fallback]) {
      const out = this.gitExecAt(candidate, ['rev-parse', '--show-toplevel']);
      if (!out.startsWith('[git]') && !out.includes('not a git repository')) {
        const root = out.split(/\r?\n/)[0].trim();
        if (root && fs.existsSync(root)) return path.resolve(root);
      }
    }
    return null;
  }

  private gitFileAudit(repoRoot: string, target: string, baseRef: string): Record<string, unknown> {
    const rel = path.relative(repoRoot, target).replace(/\\/g, '/');
    const inside = rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    if (!inside) return { repository: repoRoot, tracked: false, note: 'Path is outside the detected repository.' };
    const branch = this.gitExecAt(repoRoot, ['branch', '--show-current']);
    const status = rel === ''
      ? this.gitExecAt(repoRoot, ['status', '--short'])
      : this.gitExecAt(repoRoot, ['status', '--short', '--', rel]);
    const trackedOutput = rel !== '' ? this.gitExecAt(repoRoot, ['ls-files', '--error-unmatch', '--', rel]) : '';
    const lastCommit = rel === ''
      ? this.gitExecAt(repoRoot, ['log', '-1', '--format=%H%x09%cI%x09%an%x09%s'])
      : this.gitExecAt(repoRoot, ['log', '-1', '--format=%H%x09%cI%x09%an%x09%s', '--', rel]);
    const chosenBase = baseRef || this.defaultRemoteRef(repoRoot);
    const diff = chosenBase && rel
      ? this.gitExecAt(repoRoot, ['diff', '--name-status', chosenBase, '--', rel])
      : '';
    return {
      repository: repoRoot,
      relative_path: rel || '.',
      branch: branch.startsWith('[git]') ? '' : branch.trim(),
      tracked: !!rel && !trackedOutput.startsWith('[git]') && !trackedOutput.includes('did not match any file'),
      status: status.trim() || 'clean',
      last_commit: this.parseGitCommit(lastCommit),
      base_ref: chosenBase || '',
      diff_from_base: diff.trim() || 'none',
    };
  }

  private parseGitCommit(raw: string): Record<string, unknown> | null {
    if (!raw || raw.startsWith('[git]')) return null;
    const [sha, committedAt, author, ...subjectParts] = raw.split('\t');
    if (!sha) return null;
    return { sha, committed_at: committedAt || '', author: author || '', subject: subjectParts.join('\t') };
  }

  private defaultRemoteRef(repoRoot: string): string {
    const upstream = this.gitExecAt(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (upstream && !upstream.startsWith('[git]') && !upstream.includes('no upstream')) return upstream.trim();
    const branch = this.gitExecAt(repoRoot, ['branch', '--show-current']).trim();
    if (branch) {
      const originBranch = `origin/${branch}`;
      const hasOriginBranch = this.gitExecAt(repoRoot, ['rev-parse', '--verify', '--quiet', originBranch]);
      if (hasOriginBranch && !hasOriginBranch.startsWith('[git]')) return originBranch;
    }
    const symbolic = this.gitExecAt(repoRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const match = symbolic.match(/refs\/remotes\/(.+)$/);
    if (match) return match[1].trim();
    return '';
  }

  private githubRemote(repoRoot: string): { owner: string; name: string; remote: string; url: string } | null {
    const remotes = this.gitExecAt(repoRoot, ['remote', '-v']).split(/\r?\n/);
    for (const line of remotes) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match || match[3] !== 'fetch') continue;
      const repo = this.parseGitHubRepo(match[2]);
      if (repo) return { ...repo, remote: match[1], url: match[2] };
    }
    return null;
  }

  private parseGitHubRepo(url: string): { owner: string; name: string } | null {
    const https = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/i);
    if (https) return { owner: https[1], name: https[2] };
    const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
    if (ssh) return { owner: ssh[1], name: ssh[2] };
    return null;
  }

  private async githubFileAudit(repoRoot: string, target: string, remote: { owner: string; name: string; remote: string; url: string }): Promise<Record<string, unknown>> {
    const repo = `${remote.owner}/${remote.name}`;
    const rel = path.relative(repoRoot, target).replace(/\\/g, '/');
    const branch = this.gitExecAt(repoRoot, ['branch', '--show-current']).trim();
    const encodedPath = rel && rel !== '.' ? rel.split('/').map(part => encodeURIComponent(part)).join('/') : '';
    const repoInfo = this.ghJson(['api', `repos/${repo}`, '--jq', '{name: .full_name, private: .private, default_branch: .default_branch, fork: .fork, html_url: .html_url}'], repoRoot);
    const branchName = branch || String((repoInfo && (repoInfo as Record<string, unknown>).default_branch) || '');
    const branchInfo = branchName ? this.ghJson(['api', `repos/${repo}/branches/${encodeURIComponent(branchName)}`, '--jq', '{name: .name, protected: .protected, commit: .commit.sha}'], repoRoot) : null;
    const commitsPath = encodedPath
      ? `repos/${repo}/commits?path=${encodedPath}&per_page=5`
      : `repos/${repo}/commits?per_page=5`;
    const commits = this.ghJson(['api', commitsPath, '--jq', '[.[] | {sha: .sha, html_url: .html_url, committed_at: .commit.committer.date, message: .commit.message}]'], repoRoot);
    const content = encodedPath
      ? this.ghJson(['api', `repos/${repo}/contents/${encodedPath}${branchName ? `?ref=${encodeURIComponent(branchName)}` : ''}`, '--jq', '{path: .path, type: .type, sha: .sha, size: .size, html_url: .html_url}'], repoRoot)
      : null;
    return {
      enabled: true,
      provider: 'github',
      repository: repo,
      remote: remote.remote,
      remote_url: remote.url,
      branch: branchName,
      repo: repoInfo || undefined,
      branch_info: branchInfo || undefined,
      content: content || undefined,
      recent_commits_for_path: commits || undefined,
      note: 'GitHub audit uses gh api over GitHub REST for repository, branch, contents, and commits-by-path metadata.',
    };
  }

  private repoSecurityAudit(target: string, ws: string, baseRef: string): string {
    const resolvedTarget = path.resolve(target || ws);
    const repoRoot = this.findGitRoot(fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory() ? resolvedTarget : path.dirname(resolvedTarget), ws);
    if (!repoRoot) {
      return JSON.stringify({
        ok: true,
        target: resolvedTarget,
        remote_repository_detected: false,
        remote: { provider: 'none', note: 'No local git repository contains this path.' },
        security_review: {
          required: false,
          verdict: 'local-only',
          notes: ['Use file_audit for local file metadata if needed.'],
        },
      }, null, 2);
    }
    const ghRemote = this.githubRemote(repoRoot);
    const remotesRaw = this.gitExecAt(repoRoot, ['remote', '-v']);
    const chosenBase = baseRef || this.defaultRemoteRef(repoRoot);
    const statusShort = this.gitExecAt(repoRoot, ['status', '--short']);
    const trackedFiles = this.gitExecAt(repoRoot, ['ls-files']);
    const ignoredFiles = this.gitExecAt(repoRoot, ['ls-files', '--others', '--ignored', '--exclude-standard']);
    const changedAgainstBase = chosenBase ? this.gitExecAt(repoRoot, ['diff', '--name-status', chosenBase]) : '';
    const secretFindings = this.scanRepositorySecrets(repoRoot, trackedFiles, statusShort);
    const localOnlyFindings = this.releaseExcludedPathFindings(repoRoot, ignoredFiles);
    const repoInfo = ghRemote
      ? this.ghJson(['api', `repos/${ghRemote.owner}/${ghRemote.name}`, '--jq', '{name: .full_name, private: .private, visibility: .visibility, fork: .fork, archived: .archived, default_branch: .default_branch, html_url: .html_url}'], repoRoot)
      : null;
    const remotePrivate = repoInfo && typeof repoInfo === 'object' && !Array.isArray(repoInfo)
      ? (repoInfo as Record<string, unknown>).private
      : undefined;
    const risks: string[] = [];
    if (ghRemote && remotePrivate === false) risks.push('Remote GitHub repository is public; treat all tracked content and PR metadata as publicly visible.');
    if (ghRemote && secretFindings.length) risks.push('Potential secret-like material appears in tracked or changed files.');
    if (ghRemote && localOnlyFindings.length) risks.push('Workspace contains release-excluded/local-only files that must stay out of remote commits and public reports.');
    if (ghRemote && String(statusShort || '').trim()) risks.push('Working tree has uncommitted changes; review changed files before push/PR.');
    if (!ghRemote && remotesRaw && !remotesRaw.startsWith('[git]')) risks.push('A non-GitHub remote exists; remote safety review still applies but GitHub metadata is unavailable.');
    const recommendations = ghRemote ? [
      'Run repo_security_audit before git_push or gh_pr_create when remote-backed content is present.',
      'Inspect changed files with git status/diff and file_audit for sensitive paths before remote writes.',
      'Do not include local config, archive, Memory Lab, Work, release output, provider keys, or private URLs in commits, PR bodies, or user-facing summaries.',
      remotePrivate === false ? 'Because the remote is public, assume PR text, commit messages, issue links, and uploaded artifacts are public.' : 'Even private remotes should avoid committing local runtime state, secrets, and private machine paths.',
    ] : [
      'Remote repository metadata is unavailable; keep review local and avoid remote writes until the target remote is explicit.',
    ];
    return JSON.stringify({
      ok: true,
      target: resolvedTarget,
      repository: repoRoot,
      remote_repository_detected: !!ghRemote,
      remote: ghRemote ? {
        provider: 'github',
        repository: `${ghRemote.owner}/${ghRemote.name}`,
        remote: ghRemote.remote,
        remote_url: ghRemote.url,
        repo: repoInfo || undefined,
      } : {
        provider: remotesRaw && !remotesRaw.startsWith('[git]') ? 'git' : 'none',
        remotes: remotesRaw && !remotesRaw.startsWith('[git]') ? remotesRaw.split(/\r?\n/).filter(Boolean) : [],
      },
      git: {
        branch: this.gitExecAt(repoRoot, ['branch', '--show-current']).trim(),
        base_ref: chosenBase || '',
        status: String(statusShort || '').trim() || 'clean',
        changed_from_base: String(changedAgainstBase || '').trim() || 'none',
      },
      security_review: {
        required: !!ghRemote || (remotesRaw && !remotesRaw.startsWith('[git]')),
        verdict: risks.length ? 'review-required' : 'no-obvious-risk',
        risks,
        secret_findings: secretFindings,
        release_excluded_local_files: localOnlyFindings,
        recommendations,
      },
    }, null, 2);
  }

  private scanRepositorySecrets(repoRoot: string, trackedFilesRaw: string, statusRaw: string): Array<Record<string, unknown>> {
    const files = new Set<string>();
    for (const line of String(trackedFilesRaw || '').split(/\r?\n/)) {
      const rel = line.trim();
      if (rel) files.add(rel);
    }
    for (const line of String(statusRaw || '').split(/\r?\n/)) {
      const rel = line.slice(3).trim().replace(/^"|"$/g, '');
      if (rel) files.add(rel.replace(/\\/g, '/'));
    }
    const patterns: Array<{ id: string; re: RegExp }> = [
      { id: 'openai_or_generic_sk_key', re: /\bsk-[A-Za-z0-9._-]{16,}\b/ },
      { id: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/ },
      { id: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9._-]{16,}\b/ },
      { id: 'private_key_block', re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/ },
      { id: 'env_assignment_secret', re: /\b(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)\s*=\s*['"]?[^'"\s]{8,}/i },
    ];
    const findings: Array<Record<string, unknown>> = [];
    for (const rel of Array.from(files).sort()) {
      if (findings.length >= 40) break;
      const full = path.join(repoRoot, rel);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
      if (fs.statSync(full).size > 512 * 1024) continue;
      let text = '';
      try { text = fs.readFileSync(full, 'utf-8'); } catch { continue; }
      for (const [idx, line] of text.split(/\r?\n/).entries()) {
        const matched = patterns.find(p => p.re.test(line));
        if (matched) {
          findings.push({ path: rel, line: idx + 1, type: matched.id, sample: line.replace(/=.*/, '= <redacted>').replace(/\b(?:sk|gh[pousr]|sk-ant)-[A-Za-z0-9._-]{8,}\b/g, '<redacted-token>').slice(0, 160) });
          if (findings.length >= 40) break;
        }
      }
    }
    return findings;
  }

  private releaseExcludedPathFindings(repoRoot: string, ignoredFilesRaw: string): string[] {
    const sensitive = /^(config\.json|agent\.md|PC_Hash\.config|Work\/|archive\/|skills\/|Memory Lab\/|Design\.md|release\/|_local\/|_ref\/|vendor\/)/i;
    const fromIgnored = String(ignoredFilesRaw || '')
      .split(/\r?\n/)
      .map(line => line.trim().replace(/\\/g, '/'))
      .filter(line => line && sensitive.test(line));
    const direct = ['config.json', 'agent.md', 'PC_Hash.config', 'Work', 'archive', 'skills', 'Memory Lab', 'Design.md', 'release', '_local', '_ref', 'vendor']
      .filter(rel => fs.existsSync(path.join(repoRoot, rel)))
      .map(rel => rel.replace(/\\/g, '/'));
    return Array.from(new Set([...fromIgnored, ...direct])).slice(0, 80);
  }

  private ghJson(args: string[], ws: string): unknown {
    const raw = this.gh(args, ws);
    if (raw.startsWith('[gh]')) return { error: raw };
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }

  private gbranch(action: string, name: string, startPoint: string, ws: string): string {
    const normalized = (action || 'current').toLowerCase();
    if (normalized === 'current') return this.gitExecAt(ws, ['branch', '--show-current']);
    if (normalized === 'list') return this.gitExecAt(ws, ['branch', '--all', '--verbose', '--no-abbrev']);
    if (normalized === 'create') {
      if (!name) return '[git_branch] Branch name is required for create.';
      const args = ['switch', '-c', name];
      if (startPoint) args.push(startPoint);
      return this.gitExecAt(ws, args);
    }
    if (normalized === 'switch') {
      if (!name) return '[git_branch] Branch name is required for switch.';
      return this.gitExecAt(ws, ['switch', name]);
    }
    return `[git_branch] Unknown action: ${action}`;
  }

  private ghFork(action: string, repo: string, clone: boolean, remote: boolean, remoteName: string, ws: string): string {
    const normalized = (action || 'status').toLowerCase();
    if (normalized === 'status') {
      const args = ['repo', 'view'];
      if (repo) args.push(repo);
      args.push('--json', 'nameWithOwner,parent,isFork,url');
      const raw = this.gh(args, ws);
      try {
        const parsed = JSON.parse(raw);
        return JSON.stringify({ ok: true, source: 'github-cli', ...parsed }, null, 2);
      } catch {
        const repoRoot = this.findGitRoot(ws, ws);
        const remoteRepo = repoRoot ? this.githubRemote(repoRoot) : null;
        if (remoteRepo) {
          return JSON.stringify({
            ok: false,
            source: 'git-remote-fallback',
            nameWithOwner: `${remoteRepo.owner}/${remoteRepo.name}`,
            isFork: false,
            parent: null,
            url: `https://github.com/${remoteRepo.owner}/${remoteRepo.name}`,
            remote: remoteRepo.remote,
            error: raw.slice(0, 500),
          }, null, 2);
        }
        return JSON.stringify({ ok: false, source: 'github-cli', error: raw.slice(0, 500) }, null, 2);
      }
    }
    if (normalized !== 'create') return `[gh_fork] Unknown action: ${action}`;
    const args = ['repo', 'fork'];
    if (repo) args.push(repo);
    if (clone) args.push('--clone');
    if (remote) args.push('--remote');
    if (remoteName) args.push('--remote-name', remoteName);
    return this.gh(args, ws);
  }

  private ghPrCreate(title: string, body: string, base: string, head: string, draft: boolean, ws: string): string {
    if (!title || !body) return '[gh_pr_create] title and body are required.';
    const args = ['pr', 'create', '--title', title, '--body', body];
    if (base) args.push('--base', base);
    if (head) args.push('--head', head);
    if (draft) args.push('--draft');
    return this.gh(args, ws);
  }

  private withRemoteSecurityPreamble(ws: string, actionOutput: string): string {
    const repoRoot = this.findGitRoot(ws, ws);
    if (!repoRoot) return actionOutput;
    const remotes = this.gitExecAt(repoRoot, ['remote', '-v']);
    if (!remotes || remotes.startsWith('[git]')) return actionOutput;
    let summary = '[repo_security_audit] Remote repository safety review should be considered before remote writes.';
    try {
      const audit = JSON.parse(this.repoSecurityAudit(repoRoot, ws, '')) as Record<string, any>;
      const review = audit.security_review || {};
      const remote = audit.remote || {};
      const risks = Array.isArray(review.risks) ? review.risks : [];
      const findings = Array.isArray(review.secret_findings) ? review.secret_findings : [];
      const localOnly = Array.isArray(review.release_excluded_local_files) ? review.release_excluded_local_files : [];
      summary = [
        '[repo_security_audit]',
        `remote=${remote.provider || 'git'}${remote.repository ? ` ${remote.repository}` : ''}`,
        `verdict=${review.verdict || 'unknown'}`,
        risks.length ? `risks=${risks.length}` : 'risks=0',
        findings.length ? `secret_findings=${findings.length}` : 'secret_findings=0',
        localOnly.length ? `release_excluded_local_files=${localOnly.length}` : 'release_excluded_local_files=0',
      ].join(' ');
    } catch {
      // Keep the remote action result visible even if the preflight summary cannot be parsed.
    }
    return `${summary}\n${actionOutput}`;
  }

  private gstat(ws: string): string {
    try {
      const r = this.gitExec('git status --short', ws);
      return r.trim() || '[git] Clean.';
    } catch (e) { return `[git] ${e}`; }
  }

  private gpull(ws: string): string {
    try {
      const r = this.gitExec('git pull --ff-only', ws);
      return `[git pull]\n${r.trim()}`;
    } catch (e) { return `[git] ${e}`; }
  }

  private gpush(msg: string, ws: string): string {
    let out = '';
    try {
      if (msg) {
        this.gitExec('git add -A', ws);
        this.gitExec(`git commit -m "${msg.replace(/"/g, '\\"')}"`, ws);
      }
      out += this.gitExec('git push', ws);
    } catch (e) { out += `[git] ${e}`; }
    return out.trim() || '[git push] Done.';
  }

  private gclone(url: string, target: string): string {
    try {
      const r = this.gitExec(`git clone ${url} "${target}"`, target);
      return `[git clone]\n${r.trim()}`;
    } catch (e) { return `[git clone] ${e}`; }
  }
}
