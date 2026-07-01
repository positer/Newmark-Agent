import * as fs from 'fs';
import * as path from 'path';
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

export interface ToolExecutionContext {
  mode?: string;
  workspacePath?: string;
}

export class ToolExecutor {
  private root: string;

  constructor(root: string, private config: ConfigManager) {
    this.root = root;
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

    const tools = [
      t('bash', 'Run a shell command. On Windows, use ONLY PowerShell syntax (Get-ChildItem not dir, Set-Content not echo>, etc). Optional timeout_ms lets the Agent choose this command timeout in milliseconds; 0 requests no limit, but a nonzero terminal.interrupt_timeout_ms setting is the upper cap. Valid PowerShell: Get-ChildItem, Get-Content, Set-Content, Remove-Item, New-Item, Move-Item, Copy-Item, Select-String, pwd, ls (alias), cd, mkdir. INVALID: dir /s, echo >, type, &&, 2>&1, 2>nul. Use `;` to chain commands.', { command: { type: 'string' }, timeout_ms: { type: 'number', description: 'Per-command timeout in milliseconds. 0 means no requested limit unless capped by settings.' } }, ['command']),
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
      t('git_pull', 'Pull from remote', {}, []),
      t('git_push', 'Stage, commit, push', { message: { type: 'string' } }, ['message']),
      t('git_clone', 'Clone a git repo', { url: { type: 'string' }, path: { type: 'string' } }, ['url', 'path']),
      t('gh_auth_status', 'Run `gh auth status` through GitHub CLI and return authentication state.', {}, []),
      t('gh_repo_view', 'Run `gh repo view` for the current repo or provided repo, returning concise metadata.', { repo: { type: 'string' } }, []),
      t('gh_issue_list', 'Run `gh issue list` for the current repo or provided repo.', { repo: { type: 'string' }, limit: { type: 'number' } }, []),
      t('gh_pr_list', 'Run `gh pr list` for the current repo or provided repo.', { repo: { type: 'string' }, limit: { type: 'number' } }, []),
    ];
    if (this.config.getStr('agent', 'option_feedback') === 'fully_autonomous') {
      return tools.filter((tool: any) => tool.function?.name !== 'question');
    }
    if (mode === 'plan') {
      return tools.filter((tool: any) =>
        ['pwd', 'read', 'glob', 'grep', 'web_search', 'web_fetch', 'browser_open', 'browser_snapshot', 'git_status'].includes(tool.function?.name)
        || tool.function?.name === 'automation_list'
        || tool.function?.name === 'memory_lab_read'
      );
    }
    return tools;
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
          return resolve(g('path'));
        case 'git_clone':
          return resolve(g('path'));
        default:
          return wsPath;
      }
    };

    const planGuard = this.checkPlanMode(tool, targetForTool(), context.mode || '', context.workspacePath || wsPath);
    if (planGuard) return planGuard;
    const permissionGuard = this.checkWorkspaceAccess(tool, targetForTool(), context.workspacePath || wsPath);
    if (permissionGuard) return permissionGuard;
    const bashGuard = tool === 'bash' ? this.checkBashWorkspaceAccess(g('command'), context.workspacePath || wsPath) : null;
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
        case 'git_pull': return this.gpull(wsPath);
        case 'git_push': return this.gpush(g('message'), wsPath);
        case 'git_clone': return this.gclone(g('url'), resolve(g('path')));
        case 'gh_auth_status': return this.gh(['auth', 'status'], wsPath);
        case 'gh_repo_view': return this.ghRepoView(g('repo'), wsPath);
        case 'gh_issue_list': return this.ghList('issue', g('repo'), Number((args as Record<string, unknown>).limit || 20), wsPath);
        case 'gh_pr_list': return this.ghList('pr', g('repo'), Number((args as Record<string, unknown>).limit || 20), wsPath);
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

  private checkPlanMode(tool: string, target: string, mode: string, wsPath: string): string | null {
    if (mode !== 'plan') return null;
    if (['read', 'glob', 'grep', 'web_search', 'web_fetch', 'browser_open', 'browser_snapshot', 'pwd', 'git_status', 'automation_list'].includes(tool)) return null;
    return `[permission] Plan mode is fully read-only. Blocked: ${tool}`;
  }

  private checkWorkspaceAccess(tool: string, target: string, wsPath: string): string | null {
    const perm = this.config.getStr('workspace', 'access_permission');
    if (perm === 'full_access') return null;

    const insideWorkspace = this.isInside(wsPath, target);
    if (insideWorkspace) return null;

    const readOnlyTools = ['read', 'grep', 'glob', 'web_search', 'web_fetch', 'pwd', 'git_status'];
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

  private gh(args: string[], ws: string): string {
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
      const result = spawnSync('gh', args, {
        cwd: ws,
        encoding: 'utf-8',
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env,
      });
      const out = `${result.stdout || ''}${result.stderr || ''}`.trim();
      if (result.error) return `[gh] ${result.error.message}`;
      return out || `[gh] Exit: ${result.status ?? -1}`;
    } catch (e) {
      return `[gh] ${e instanceof Error ? e.message : String(e)}`;
    }
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
