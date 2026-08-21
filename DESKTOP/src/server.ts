import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash, randomUUID } from 'crypto';
import { normalizeUiBackgroundColor, normalizeUiFontFamily, normalizeUiTheme } from './core/uiPreferences';
import { spawnSync } from 'child_process';
import { Agent, AgentWorkEvent } from './core/agent';
import { AgentMode } from './core/types';
import { AutomationManager } from './core/automation';
import { sanitizeProvidersForState } from './core/config';
import { FlowEngine, FlowWorkflow } from './core/flow';
import { WorkspaceFileRouter } from './core/workspaceFileRouter';
import { WorkspaceInfo } from './core/workspace';
import { executeWorkspaceBash } from './core/nativeBash';
import { currentAppVersion } from './core/installUpdate';
import { confirmPairing, ensureMobileToken, lanIpv4, pairingStatus, tailscaleIpv4 } from './core/mobilePairing';
import { WorkEventCoalescer } from './core/workEventCoalescer';

const PORT = 47890;
let agent: Agent | null = null;
let automation: AutomationManager | null = null;
let workspaceFileRouter: WorkspaceFileRouter | null = null;
let mobileToken = '';
let appRoot = '';
const mobileWorkEventSubscribers = new Set<(event: AgentWorkEvent) => void>();
const mobileScopedRuntimes = new Map<string, { agent: Agent; workspaceId: string; conversationId: string; unsubscribe: () => void }>();
let hostedWorkEventSink: ((event: AgentWorkEvent) => void) | null = null;
let unsubscribeHostedWorkEvents: (() => void) | null = null;
let unsubscribeServerAgentWorkEvents: (() => void) | null = null;
let hostedServer: http.Server | null = null;
let hostedServerRoot = '';
let hostedServerOptions: HostedMobileServerOptions = {};
let hostedServerError = '';
let hostedServerStartedAt = 0;
let hostedAccessHost = '';
let hostedAccessHostCheckedAt = 0;

export interface HostedMobileServerOptions {
  agent?: Agent;
  automation?: AutomationManager | null;
  /** Mobile-originated runs must reach the already-open desktop renderer. */
  onWorkEvent?: (event: AgentWorkEvent) => void;
  /** Desktop GUI/runtime-pool events must reach mobile SSE subscribers. */
  subscribeWorkEvents?: (listener: (event: AgentWorkEvent) => void) => (() => void);
  /** Read the GUI runtime-pool state for one exact workspace/conversation. */
  conversationUiState?: (target: { workspaceId: string; conversationId: string }) => Promise<Record<string, unknown>>;
  /** Mutate Goal/Flow state owned by the GUI runtime pool for one exact target. */
  conversationUiAction?: (
    target: { workspaceId: string; conversationId: string },
    action: 'goal_update' | 'goal_guide' | 'conversation_guide' | 'goal_toggle_pause' | 'goal_clear' | 'flow_pause' | 'flow_resume' | 'flow_guide' | 'conversation_stop' | 'input_mode' | 'queue_enqueue' | 'queue_update' | 'queue_delete' | 'queue_reorder' | 'queue_toggle_pause' | 'queue_guide',
    value?: string,
    input?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /** Send through the same GUI runtime pool used by the desktop renderer. */
  conversationPrompt?: (
    target: { workspaceId: string; conversationId: string },
    message: string,
    options?: { requestedMode?: string; goalObjective?: string; inputMode?: string },
  ) => Promise<Record<string, unknown>>;
}

export interface HostedMobileServerStatus {
  enabled: boolean;
  listening: boolean;
  reachable: boolean;
  state: 'off' | 'listening' | 'error';
  host: string;
  port: number;
  error: string;
  checkedAt: string;
  startedAt: number;
}

let hostedConversationUiState: HostedMobileServerOptions['conversationUiState'];
let hostedConversationUiAction: HostedMobileServerOptions['conversationUiAction'];
let hostedConversationPrompt: HostedMobileServerOptions['conversationPrompt'];

function mobileRuntimeKey(workspaceId: string, conversationId: string): string {
  return `${String(workspaceId || '')}::${String(conversationId || '')}`;
}

function publishMobileWorkEvent(event: AgentWorkEvent): void {
  for (const subscriber of mobileWorkEventSubscribers) {
    try { subscriber(event); } catch { /* ignore disconnected mobile listeners */ }
  }
}

function publishServerWorkEvent(event: AgentWorkEvent): void {
  serverWorkEventCoalescer.push(event);
}

const serverWorkEventCoalescer = new WorkEventCoalescer(event => {
  publishMobileWorkEvent(event);
  hostedWorkEventSink?.(event);
});

function mobileAuthorized(req: http.IncomingMessage): boolean {
  if (!mobileToken) return false;
  const bearer = String(req.headers.authorization || '');
  if (bearer.startsWith('Bearer ')) return bearer.slice('Bearer '.length).trim() === mobileToken;
  try {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const queryToken = url.searchParams.get('token') || '';
    return queryToken === mobileToken;
  } catch {
    return false;
  }
}

function mobileJson(res: http.ServerResponse, data: unknown, code = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function resolveMobileWorkspace(current: Agent, workspaceId: string): WorkspaceInfo | null {
  const clean = String(workspaceId || '');
  return [...current.workspace.internal, ...current.workspace.external].find(workspace => workspace.id === clean)
    || (current.workspace.current?.id === clean ? current.workspace.current : null);
}

const MOBILE_EDITABLE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.html', '.htm', '.xml', '.svg',
  '.kt', '.kts', '.java', '.py', '.rb', '.rs', '.go', '.c', '.h', '.cpp', '.hpp', '.cs', '.sh',
  '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.tex', '.typ', '.properties', '.gradle', '.gitignore',
]);
const MOBILE_EDITOR_MAX_BYTES = 1024 * 1024;
const MAX_API_BODY_BYTES = 30 * 1024 * 1024;
export const MOBILE_WORKSPACE_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

function resolveMobileWorkspacePath(ws: WorkspaceInfo, relativePath: string): { root: string; target: string; relative: string } {
  const root = path.resolve(ws.path);
  const clean = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(root, clean || '.');
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Path escapes workspace');
  return { root, target, relative: path.relative(root, target).replace(/\\/g, '/') };
}

async function assertMobileRealPathContained(root: string, target: string): Promise<void> {
  const realRoot = await fs.promises.realpath(root);
  const realTarget = await fs.promises.realpath(target);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) throw new Error('Path escapes workspace through a symbolic link');
}

function mobileEditableFile(target: string): boolean {
  const base = path.basename(target).toLowerCase();
  return MOBILE_EDITABLE_EXTENSIONS.has(path.extname(base)) || MOBILE_EDITABLE_EXTENSIONS.has(base);
}

function validMobileUploadDirectory(value: string): boolean {
  const clean = String(value || '').replace(/\\/g, '/');
  return !path.isAbsolute(clean)
    && !/^[A-Za-z]:\//.test(clean)
    && !clean.split('/').some(segment => segment === '..' || segment.includes('\0'));
}

function validMobileUploadFileName(value: string): boolean {
  const clean = String(value || '');
  return clean.length > 0
    && clean.length <= 255
    && clean !== '.'
    && clean !== '..'
    && !clean.includes('/')
    && !clean.includes('\\')
    && !clean.includes('\0')
    && path.basename(clean) === clean;
}

function numberedUploadName(fileName: string, index: number): string {
  if (index <= 0) return fileName;
  const extension = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  return `${stem} (${index})${extension}`;
}

async function handleMobileWorkspaceUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (agent && !agent.config.getBool('remote', 'touch_enabled')) {
    mobileJson(res, { error: 'Remote touch disabled' }, 403);
    req.resume();
    return;
  }
  if (!mobileAuthorized(req)) {
    mobileJson(res, { error: 'Unauthorized' }, 401);
    req.resume();
    return;
  }
  if (!agent) {
    mobileJson(res, { error: 'Agent not initialized' }, 500);
    req.resume();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const workspaceId = url.searchParams.get('workspaceId') || '';
  const directory = url.searchParams.get('directory') || '';
  const fileName = url.searchParams.get('fileName') || '';
  const ws = resolveMobileWorkspace(agent, workspaceId);
  if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); req.resume(); return; }
  if (!validMobileUploadDirectory(directory) || !validMobileUploadFileName(fileName)) {
    mobileJson(res, { error: 'Invalid upload path or file name' }, 400);
    req.resume();
    return;
  }
  const declaredLength = Number(req.headers['content-length'] || -1);
  if (Number.isFinite(declaredLength) && declaredLength > MOBILE_WORKSPACE_UPLOAD_MAX_BYTES) {
    mobileJson(res, { error: 'Upload exceeds the 64 MiB limit' }, 413);
    req.resume();
    return;
  }

  let temporaryPath = '';
  try {
    const resolved = resolveMobileWorkspacePath(ws, directory);
    const realRoot = await fs.promises.realpath(resolved.root);
    if (directory === 'Uploaded') {
      await fs.promises.mkdir(resolved.target, { recursive: true });
    }
    const realDirectory = await fs.promises.realpath(resolved.target);
    const canonicalRelative = path.relative(realRoot, realDirectory);
    if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
      throw new Error('Path escapes workspace through a symbolic link');
    }
    const directoryStat = await fs.promises.stat(realDirectory);
    if (!directoryStat.isDirectory()) { mobileJson(res, { error: 'Upload destination is not a directory' }, 400); req.resume(); return; }

    temporaryPath = path.join(realDirectory, `.newmark-upload-${randomUUID()}.tmp`);
    const handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const part of req) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        size += chunk.length;
        if (size > MOBILE_WORKSPACE_UPLOAD_MAX_BYTES) throw new RangeError('Upload exceeds the 64 MiB limit');
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten <= 0) throw new Error('Unable to write the complete upload');
          offset += bytesWritten;
        }
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    let finalPath = '';
    let finalName = '';
    let published = false;
    for (let index = 0; index < 10_000; index++) {
      finalName = numberedUploadName(fileName, index);
      finalPath = path.join(realDirectory, finalName);
      try {
        // A hard link publishes the already-complete inode atomically and fails
        // with EEXIST, so parallel uploads can never overwrite one another.
        await fs.promises.link(temporaryPath, finalPath);
        published = true;
        break;
      } catch (error: any) {
        if (error?.code === 'EEXIST') continue;
        throw error;
      }
    }
    if (!published) throw new Error('Unable to allocate a unique upload name');
    await fs.promises.unlink(temporaryPath);
    temporaryPath = '';
    const relativePath = path.posix.join(resolved.relative, finalName).replace(/^\.\//, '');
    const suppliedMime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
    const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(suppliedMime) ? suppliedMime : 'application/octet-stream';
    mobileJson(res, {
      ok: true,
      file: { name: finalName, path: relativePath, size, mimeType, sha256: hash.digest('hex'), created: true },
    }, 201);
  } catch (error) {
    if (temporaryPath) await fs.promises.unlink(temporaryPath).catch(() => {});
    if (error instanceof RangeError) mobileJson(res, { error: error.message }, 413);
    else if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ENOTDIR') {
      mobileJson(res, { error: 'Upload destination does not exist' }, 400);
    } else if (String((error as Error)?.message || '').toLowerCase().includes('workspace')) {
      mobileJson(res, { error: 'Invalid upload destination' }, 400);
    } else {
      mobileJson(res, { error: 'Upload could not be stored' }, 500);
    }
  }
}

function mobileRightSidebarState(current: Agent, ws: WorkspaceInfo, conversationId: string): Record<string, unknown> {
  const scoped = mobileScopedAgent(ws, conversationId);
  return {
    workspace: { id: ws.id, name: ws.name, path: ws.path, isInternal: ws.isInternal },
    conversationId,
    conversationPlan: scoped.getConversationPlan(conversationId),
    linkedPlan: scoped.getLinkedPlan(conversationId),
    subagents: scoped.subagents.listAll()
      .filter(record => !record.conversationId || record.conversationId === conversationId)
      .map(record => ({
        id: record.id,
        name: record.name,
        displayName: record.displayName,
        status: record.status,
        model: record.model,
        mode: record.agentMode,
        inputMode: record.inputMode,
        result: record.result,
        error: record.error || '',
        messageCount: record.messages.length,
        messages: record.messages.slice(-40),
      })),
  };
}

function mobileWorkspaceConversationRows(current: Agent, ws: WorkspaceInfo): Array<Record<string, unknown>> {
  const activeConversationId = current.activeConversationIdForWorkspace(ws);
  const isRuntimeWorkspace = !!current.workspace.current
    && path.resolve(current.workspace.current.path) === path.resolve(ws.path);
  const activeRuntimeStatus = current.status === 'working' ? 'running' : current.status;
  return current.listWorkspaceConversationStates(ws).map(conversation => {
    const scopedRuntime = mobileScopedRuntimes.get(mobileRuntimeKey(String(ws.id || ''), conversation.id));
    const scopedStatus = scopedRuntime?.agent.status === 'working' ? 'running' : scopedRuntime?.agent.status || '';
    const runtimeStatus = scopedRuntime
      ? scopedStatus
      : isRuntimeWorkspace && conversation.id === current.activeConversationId && activeRuntimeStatus !== 'idle'
        ? activeRuntimeStatus
        : '';
    return {
      ...conversation,
      active: conversation.id === activeConversationId || !!scopedRuntime,
      runtimeStatus,
      running: ['running', 'stopping', 'force_restarting'].includes(runtimeStatus),
    };
  });
}

function mobileScopedAgent(ws: WorkspaceInfo, conversationId: string): Agent {
  const scoped = new Agent(appRoot, {
    agentOnly: true,
    workspaceRegistryMode: 'detached',
    readOnlyConfig: true,
    conversationId,
  });
  scoped.workspace.current = { ...ws };
  scoped.config.loadWorkspaceConfig(ws.path);
  scoped.setConversationFromStorage(conversationId);
  return scoped;
}

function mobileConversationRuntimeBusy(current: Agent, ws: WorkspaceInfo, conversationId: string): boolean {
  const scoped = mobileScopedRuntimes.get(mobileRuntimeKey(String(ws.id || ''), conversationId));
  if (scoped && scoped.agent.status !== 'idle') return true;
  const currentWs = current.workspace.current;
  return !!currentWs
    && path.resolve(currentWs.path) === path.resolve(ws.path)
    && current.activeConversationId === conversationId
    && current.status !== 'idle';
}

function handleMobileEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (agent && !agent.config.getBool('remote', 'touch_enabled')) {
    mobileJson(res, { error: 'Remote touch disabled' }, 403);
    return;
  }
  if (!mobileAuthorized(req)) {
    mobileJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  if (!agent) {
    mobileJson(res, { error: 'Agent not initialized' }, 500);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 3000\n\n');
  const subscriber = (event: AgentWorkEvent) => {
    try {
      res.write(`event: work\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      // socket is gone; the close handler will clean up
    }
  };
  mobileWorkEventSubscribers.add(subscriber);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 15000);
  res.on('close', () => {
    clearInterval(heartbeat);
    mobileWorkEventSubscribers.delete(subscriber);
  });
}

function resolveAppPath(root: string, targetPath: string): string {
  if (!targetPath) return root;
  return path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
}

function defaultTerminalShell(): string {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

function availableTerminalShells(): string[] {
  return process.platform === 'win32' ? ['powershell', 'cmd', 'bash', 'pwsh'] : ['bash', 'sh', 'pwsh'];
}

function normalizeTerminalShell(shellId: string): string {
  const requested = String(shellId || '').toLowerCase();
  if (process.platform === 'win32') {
    return availableTerminalShells().includes(requested) ? requested : 'powershell';
  }
  return availableTerminalShells().includes(requested) ? requested : 'bash';
}

async function runShellCommand(command: string, shellId: string, cwd: string): Promise<{ output: string; error?: string; engine?: string }> {
  const requested = normalizeTerminalShell(shellId || defaultTerminalShell());
  if (requested === 'bash') {
    const result = await executeWorkspaceBash(command, cwd, { cwd, allowHostFallback: true });
    return { output: result.output, error: result.error, engine: result.engine };
  }
  const linuxShell = process.env.SHELL || '/bin/bash';
  const exe =
    requested === 'cmd' ? 'cmd.exe' :
    requested === 'bash' ? (process.platform === 'win32' ? 'bash.exe' : linuxShell) :
    requested === 'sh' ? '/bin/sh' :
    requested === 'pwsh' ? (process.platform === 'win32' ? 'pwsh.exe' : 'pwsh') :
    'powershell.exe';
  const args =
    requested === 'cmd' ? ['/d', '/s', '/c', command] :
    requested === 'bash' ? ['-lc', command] :
    requested === 'sh' ? ['-c', command] :
    ['-NoProfile', '-NonInteractive', '-Command', command];
  const result = spawnSync(exe, args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
    windowsHide: true,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error) return { output, error: result.error.message };
  if (result.status && result.status !== 0) return { output, error: output.trim() || `Shell exited ${result.status}` };
  return { output };
}

function applyConfigPatch(cfg: Record<string, unknown>): void {
  if (!agent) return;
  for (const [key, value] of Object.entries(cfg || {})) {
    switch (key) {
      case 'gradientColors': agent.config.set('ui', 'gradient_colors', value); break;
      case 'gradientSpeed': agent.config.set('ui', 'gradient_speed', value); break;
      case 'gradientWidth': agent.config.set('ui', 'gradient_width', value); break;
      case 'glassAlpha': agent.config.set('ui', 'glass_alpha', value); break;
    case 'theme': agent.config.set('ui', 'dark_mode', normalizeUiTheme(value)); break;
    case 'backgroundColor': agent.config.set('ui', 'background_color', normalizeUiBackgroundColor(value)); break;
    case 'fontFamily': agent.config.set('ui', 'font_family', normalizeUiFontFamily(value)); break;
    case 'feedbackLevel': agent.config.set('agent', 'option_feedback', value); break;
    case 'language': agent.config.set('general', 'language', value); break;
    case 'autoSwitch': agent.config.set('models', 'auto_switch', value === true || value === 'on'); break;
    case 'autoSwitchScope': agent.config.set('models', 'auto_switch_scope', value === 'provider' ? 'provider' : 'all'); break;
    case 'fallbackOnUnavailable': agent.config.set('models', 'fallback_on_unavailable', value === true || value === 'on'); break;
    case 'switchTendency': agent.config.set('models', 'auto_switch_preference', value); break;
    case 'clearLearnedAutoPreferences': if (value === true) agent.clearLearnedModelPreferences(); break;
    case 'openAIApiMode': agent.config.set('models', 'openai_api_mode', ['chat_stream', 'chat', 'responses'].includes(String(value)) ? value : 'chat_stream'); break;
    case 'providers': agent.updateProviders(value); break;
    case 'defaultFlow': agent.config.set('flow', 'default_flow', value); break;
      case 'dialogStyle': agent.config.set('ui', 'dialog_style', value); break;
      default: agent.config.set('ui', key, value);
    }
  }
  agent.config.save();
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function fileTreeLevel(workspaceRoot: string, requestedPath: string): Promise<unknown[]> {
  const lexicalRoot = path.resolve(workspaceRoot);
  const lexicalTarget = requestedPath ? path.resolve(requestedPath) : lexicalRoot;
  if (!isPathInside(lexicalRoot, lexicalTarget)) throw new Error('File tree path is outside the active workspace');
  const [realRoot, realTarget] = await Promise.all([fs.promises.realpath(lexicalRoot), fs.promises.realpath(lexicalTarget)]);
  if (!isPathInside(realRoot, realTarget)) throw new Error('File tree path escapes the active workspace through a link');
  const entries = await fs.promises.readdir(realTarget, { withFileTypes: true });
  return entries
    .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : 'file',
      path: path.join(lexicalTarget, entry.name),
    }))
    .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'directory' ? -1 : 1));
}

function mimeType(fp: string): string {
  const ext = path.extname(fp).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  };
  return map[ext] || 'application/octet-stream';
}

function serveFile(res: http.ServerResponse, fp: string): void {
  try {
    const content = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': mimeType(fp), 'Content-Length': content.length });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function jsonResponse(res: http.ServerResponse, data: unknown, code = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, body: string): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/mobile/')) {
    if (agent && !agent.config.getBool('remote', 'touch_enabled')) {
      mobileJson(res, { error: 'Remote touch disabled' }, 403);
      return;
    }
    if (!mobileAuthorized(req)) {
      mobileJson(res, { error: 'Unauthorized' }, 401);
      return;
    }
  }

  if (!agent) {
    jsonResponse(res, { error: 'Agent not initialized' }, 500);
    return;
  }

  try {
    switch (pathname) {
      case '/api/state': {
        jsonResponse(res, {
          mode: agent.mode, model: agent.modelSelectionValue(), modelLabel: agent.modelLabel(),
          resolvedDeployment: agent.activeDeployment(), routeDecision: agent.lastRouteDecision,
          intelligence: agent.intelligence, status: agent.status, goal: agent.goal,
          models: agent.allModelNames(), inputMode: agent.inputMode,
          conversationId: agent.activeConversationId,
          conversations: agent.listConversationStates(),
          conversationPlan: agent.getConversationPlan(),
          historyMessages: agent.history.length,
          conversationLocked: agent.isConversationLocked(),
          gradientColors: agent.config.get<string[]>('ui', 'gradient_colors') || [],
          gradientSpeed: agent.config.getNum('ui', 'gradient_speed'),
          gradientWidth: agent.config.getNum('ui', 'gradient_width'),
          glassAlpha: agent.config.getNum('ui', 'glass_alpha'),
          darkMode: agent.config.getStr('ui', 'dark_mode'),
          backgroundColor: normalizeUiBackgroundColor(agent.config.getStr('ui', 'background_color')),
          fontFamily: normalizeUiFontFamily(agent.config.getStr('ui', 'font_family')),
          tone: agent.config.getStr('general', 'tone'),
          language: agent.config.getStr('general', 'language'),
          feedback: agent.config.getStr('agent', 'option_feedback'),
          accessPerm: agent.config.getStr('workspace', 'access_permission'),
          promptMode: agent.config.getStr('workspace', 'prompt_mode'),
          skillPolicy: agent.config.getStr('skills', 'auto_download'),
          autoSwitch: agent.config.getBool('models', 'auto_switch'),
          autoSwitchScope: agent.config.getStr('models', 'auto_switch_scope') || 'all',
          switchTendency: agent.config.autoSwitchPreference(),
          fallbackOnUnavailable: agent.config.getBool('models', 'fallback_on_unavailable'),
          openAIApiMode: agent.config.openAIApiMode(),
          automations: automation?.list() || [],
          contextCompression: agent.lastCompression,
          contextWindow: agent.contextWindow(),
          platform: process.platform,
          defaultTerminalShell: normalizeTerminalShell(agent.config.getStr('terminal', 'default_shell') || defaultTerminalShell()),
          runtimeDefaultTerminalShell: defaultTerminalShell(),
          terminalShells: availableTerminalShells(),
          chatMessages: agent.chatMessages,
          workspaces: { internal: agent.workspace.internal, external: agent.workspace.external, current: agent.workspace.current },
          providers: sanitizeProvidersForState(agent.config.providers()),
          skills: agent.skills.listDetailed(),
          subagents: agent.subagents.listAll().map(s => ({
            id: s.id,
            name: s.name,
            status: s.status,
            model: s.model,
            mode: s.agentMode,
            inputMode: s.inputMode,
            result: s.result,
            messageCount: s.messages.length,
            messages: s.messages.slice(-20),
          })),
          archives: agent.listArchives(),
        });
        return;
      }
      case '/api/send':
      case '/api/send-prompt': {
        const params = JSON.parse(body || '{}');
        const message = params.message || '';
        if (!message) { jsonResponse(res, { error: 'No message' }, 400); return; }
        if (params.conversation) agent.setConversation(String(params.conversation));
        const tokens = await agent.process(message);
        if (pathname === '/api/send-prompt') {
          jsonResponse(res, tokens.map(t => t.text).join(''));
          return;
        }
        jsonResponse(res, {
          tokens: tokens.map(t => ({ type: t.type, text: t.text })),
          diffs: agent.fileDiffs.map(d => ({ path: d.path, old: d.oldContent.length, new: d.newContent.length })),
          mode: agent.mode, model: agent.modelSelectionValue(), status: agent.status,
          resolvedDeployment: agent.activeDeployment(), routeDecision: agent.lastRouteDecision,
          goal: agent.goal ? { objective: agent.goal.objective, paused: agent.goal.paused } : null,
          options: agent.pendingOptions,
          contextCompression: agent.lastCompression,
          contextWindow: agent.contextWindow(),
          conversationId: agent.activeConversationId,
          conversations: agent.listConversationStates(),
          conversationPlan: agent.getConversationPlan(),
          chatMessages: agent.chatMessages,
          historyMessages: agent.history.length,
          conversationLocked: agent.isConversationLocked(),
        });
        return;
      }
      case '/api/mode': {
        const m = JSON.parse(body || '{}').mode || 'build';
        agent.setMode(m as AgentMode);
        jsonResponse(res, { mode: agent.mode });
        return;
      }
      case '/api/conversation-plan': {
        if (req.method === 'GET') {
          jsonResponse(res, agent.getConversationPlan());
          return;
        }
        const params = JSON.parse(body || '{}');
        jsonResponse(res, agent.updateConversationPlan(params));
        return;
      }
      case '/api/model': {
        agent.setModel(JSON.parse(body || '{}').model || '');
        jsonResponse(res, { model: agent.modelSelectionValue(), resolvedDeployment: agent.activeDeployment() });
        return;
      }
      case '/api/intelligence': {
        agent.setIntelligence(JSON.parse(body || '{}').tier || 'medium', true);
        jsonResponse(res, { intelligence: agent.intelligence });
        return;
      }
      case '/api/goal': {
        const g = JSON.parse(body || '{}').goal || '';
        agent.updateGoal(g);
        jsonResponse(res, { goal: agent.goal });
        return;
      }
      case '/api/goal-pause': {
        const paused = agent.toggleGoalPause();
        jsonResponse(res, { paused });
        return;
      }
      case '/api/automations': {
        if (req.method === 'GET') {
          jsonResponse(res, automation?.list() || []);
          return;
        }
        const params = JSON.parse(body || '{}');
        const created = automation?.create({
          prompt: params.prompt || '',
          model: params.model || '',
          workspaceId: params.workspaceId || params.workspace_id || agent.workspace.current?.id || agent.workspace.current?.path || '',
          workspaceName: params.workspaceName || params.workspace_name || agent.workspace.current?.name || '',
          conversationMode: params.conversationMode === 'existing' || params.conversation_mode === 'existing' ? 'existing' : 'new',
          conversationId: params.conversationId || params.conversation_id || '',
          condition: params.condition || 'once',
          intervalSec: Number(params.intervalSec || params.interval || 0),
          startAt: params.startAt || '',
          endAt: params.endAt || '',
          active: params.active !== false,
        });
        jsonResponse(res, created || { error: 'Automation manager not initialized' });
        return;
      }
      case '/api/automation-toggle': {
        const id = JSON.parse(body || '{}').id || '';
        jsonResponse(res, automation?.toggle(id) || null);
        return;
      }
      case '/api/automation-delete': {
        const id = JSON.parse(body || '{}').id || '';
        jsonResponse(res, { ok: automation?.delete(id) || false });
        return;
      }
      case '/api/archive': {
        const name = agent.archiveSession();
        jsonResponse(res, { name });
        return;
      }
      case '/api/open-workspace-file': {
        const fp = JSON.parse(body || '{}').path || '';
        if (!workspaceFileRouter) { jsonResponse(res, { kind: 'rejected', error: 'Workspace file router unavailable' }, 500); return; }
        jsonResponse(res, await workspaceFileRouter.open(fp, 'http-server'));
        return;
      }
      case '/api/save-workspace-file': {
        const params = JSON.parse(body || '{}');
        if (agent.mode === 'plan') { jsonResponse(res, { error: 'Plan mode is fully read-only; save is blocked.' }, 403); return; }
        if (!workspaceFileRouter) { jsonResponse(res, { error: 'Workspace file router unavailable' }, 500); return; }
        jsonResponse(res, await workspaceFileRouter.save(String(params.token || ''), String(params.content || ''), String(params.expectedRevision || ''), 'http-server'));
        return;
      }
      case '/api/bash': {
        const { cmd, command, shell, cwd } = JSON.parse(body || '{}');
        try {
          jsonResponse(res, await runShellCommand(String(command || cmd || ''), String(shell || ''), cwd || agent.rootPath));
        } catch(e: any) { jsonResponse(res, { output: e.stdout || '', error: e.stderr || String(e) }); }
        return;
      }
      case '/api/flows': {
        jsonResponse(res, FlowEngine.listAll(path.join(agent.rootPath, 'Flow')));
        return;
      }
      case '/api/flow-read': {
        const params = JSON.parse(body || '{}');
        const name = String(params.name || '').trim();
        if (!name || name !== path.basename(name) || /[\\/]/.test(name)) { jsonResponse(res, { error: 'Invalid workflow name' }, 400); return; }
        const workflow = FlowEngine.load(path.join(agent.rootPath, 'Flow'), name);
        jsonResponse(res, workflow ? { ok: true, workflow } : { error: `Workflow not found: ${name}` }, workflow ? 200 : 404);
        return;
      }
      case '/api/flow-save': {
        if (agent.mode === 'plan') { jsonResponse(res, { error: 'Plan mode is fully read-only; Flow save is blocked.' }, 403); return; }
        const params = JSON.parse(body || '{}');
        const name = String(params.name || '').trim();
        if (!name || name !== path.basename(name) || /[<>:"/\\|?*]/.test(name)) { jsonResponse(res, { error: 'Invalid workflow name' }, 400); return; }
        const workflow = { name, components: Array.isArray(params.components) ? params.components : [] } as FlowWorkflow;
        const validation = FlowEngine.validate(workflow);
        if (validation.length) { jsonResponse(res, { error: validation.map(item => item.message).join('; ') }, 400); return; }
        const flowDir = path.join(agent.rootPath, 'Flow');
        fs.mkdirSync(flowDir, { recursive: true });
        FlowEngine.save(flowDir, workflow);
        jsonResponse(res, { ok: true, workflow });
        return;
      }
      case '/api/workspace-prompt': {
        const workspace = agent.workspace.current;
        if (!workspace) { jsonResponse(res, { error: 'No active workspace' }, 400); return; }
        const promptPath = path.join(workspace.path, 'agent.md');
        if (req.method === 'GET') {
          try {
            const stat = fs.statSync(promptPath);
            if (stat.size > 256 * 1024) { jsonResponse(res, { error: 'Workspace prompt exceeds 256 KiB.' }, 400); return; }
            jsonResponse(res, { content: fs.readFileSync(promptPath, 'utf-8') });
          } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code || '') : '';
            jsonResponse(res, code === 'ENOENT' ? { content: '' } : { error: String(error) }, code === 'ENOENT' ? 200 : 500);
          }
          return;
        }
        if (agent.mode === 'plan') { jsonResponse(res, { error: 'Plan mode is fully read-only; workspace prompt save is blocked.' }, 403); return; }
        const content = String(JSON.parse(body || '{}').content || '');
        if (Buffer.byteLength(content, 'utf8') > 256 * 1024) { jsonResponse(res, { error: 'Workspace prompt exceeds 256 KiB.' }, 400); return; }
        fs.writeFileSync(promptPath, content, 'utf-8');
        agent.invalidateSystemPrompt();
        jsonResponse(res, { ok: true });
        return;
      }
      case '/api/global-prompt': {
        const promptPath = path.join(agent.rootPath, 'agent.md');
        if (req.method === 'GET') {
          try {
            const stat = fs.statSync(promptPath);
            if (stat.size > 256 * 1024) { jsonResponse(res, { error: 'Global Agent.md exceeds 256 KiB.' }, 400); return; }
            jsonResponse(res, { content: fs.readFileSync(promptPath, 'utf-8').replace(/^\uFEFF/, '') });
          } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code || '') : '';
            jsonResponse(res, code === 'ENOENT' ? { content: '' } : { error: String(error) }, code === 'ENOENT' ? 200 : 500);
          }
          return;
        }
        const content = String(JSON.parse(body || '{}').content || '');
        if (Buffer.byteLength(content, 'utf8') > 256 * 1024) { jsonResponse(res, { error: 'Global Agent.md exceeds 256 KiB.' }, 400); return; }
        fs.writeFileSync(promptPath, content, 'utf-8');
        agent.invalidateSystemPrompt();
        jsonResponse(res, { ok: true });
        return;
      }
      case '/api/config-reload': {
        agent.config.reload();
        if (agent.workspace.current) agent.config.loadWorkspaceConfig(agent.workspace.current.path);
        agent.invalidateSystemPrompt();
        jsonResponse(res, { ok: true, path: path.join(agent.rootPath, 'config.json') });
        return;
      }
      case '/api/filetree': {
        const params = body ? JSON.parse(body || '{}') : {};
        const workspaceRoot = path.resolve(agent.workspace.current?.path || agent.rootPath);
        const treeRoot = params.path ? path.resolve(String(params.path)) : workspaceRoot;
        try { jsonResponse(res, await fileTreeLevel(workspaceRoot, treeRoot)); }
        catch(e) { jsonResponse(res, { error: String(e) }, 500); }
        return;
      }
      case '/api/config': {
        if (req.method === 'GET') {
          jsonResponse(res, { error: 'Direct config export is disabled; use /api/state for the redacted runtime view.' }, 405);
          return;
        }
        applyConfigPatch(JSON.parse(body || '{}'));
        jsonResponse(res, { ok: true });
        return;
      }
      case '/api/settings': {
        const cfg = JSON.parse(body || '{}');
        if (cfg.section && cfg.key !== undefined) {
          if (cfg.section === 'models' && cfg.key === 'providers') agent.updateProviders(cfg.value);
          else agent.config.set(cfg.section, cfg.key, cfg.value);
          agent.config.save();
        }
        jsonResponse(res, { ok: true });
        return;
      }
      case '/api/providers': {
        const p = JSON.parse(body || '{}');
        if (p.name && p.url && p.key) {
          agent.config.upsertProvider(p.name, p.url, p.key);
          agent.config.save();
        }
        jsonResponse(res, { ok: true });
        return;
      }
      case '/api/validate-models': {
        const parsed = body ? JSON.parse(body || '{}') : {};
        const results = await agent.validateModels(parsed.selected || undefined);
        jsonResponse(res, results);
        return;
      }
      case '/api/model-validation-status': {
        jsonResponse(res, agent.modelValidationStatus());
        return;
      }
      case '/api/fuzzy-inject': {
        const parsed = JSON.parse(body || '{}');
        const protocol = parsed.protocol === 'anthropic' ? 'anthropic' : parsed.protocol === 'openai' ? 'openai' : undefined;
        const result = await agent.fuzzyInject(parsed.name || '', parsed.url || '', parsed.key || '', protocol);
        jsonResponse(res, result);
        return;
      }
      case '/api/workspace-select': {
        const id = JSON.parse(body || '{}').id || '';
        agent.selectWorkspace(id);
        jsonResponse(res, { current: agent.workspace.current });
        return;
      }
      case '/api/workspace-create': {
        agent.createInternalWorkspace();
        jsonResponse(res, { ok: true });
        return;
      }
      case '/api/delete-archive': {
        const aName = JSON.parse(body || '{}').name || '';
        agent.deleteArchive(aName);
        jsonResponse(res, { ok: true });
        return;
      }
      case '/api/read-archive': {
        const aName2 = JSON.parse(body || '{}').name || '';
        jsonResponse(res, { content: agent.readArchive(aName2) });
        return;
      }
      case '/api/mobile/pair-confirm': {
        let pairingId = url.searchParams.get('pairingId') || '';
        if (!pairingId) {
          try { pairingId = String((JSON.parse(body || '{}') as Record<string, unknown>).pairingId || ''); } catch {}
        }
        const result = confirmPairing(appRoot, pairingId, mobileToken);
        mobileJson(res, result.ok
          ? { ok: true, status: result.status }
          : { ok: false, error: result.error, status: result.status },
          result.ok ? 200 : 401);
        return;
      }
      case '/api/mobile/pair-status': {
        mobileJson(res, { ok: true, status: pairingStatus(appRoot) });
        return;
      }
      case '/api/mobile/hello': {
        mobileJson(res, {
          ok: true,
          version: currentAppVersion(),
          hostname: os.hostname(),
          platform: process.platform,
          tailscaleIpv4: tailscaleIpv4(),
          lanIpv4: lanIpv4(),
          workspace: agent.workspace.current ? {
            id: agent.workspace.current.id,
            name: agent.workspace.current.name,
            path: agent.workspace.current.path,
          } : null,
          conversationCount: agent.listConversationStates().length,
          activeConversationId: agent.activeConversationId,
        });
        return;
      }
      case '/api/mobile/state': {
        const active = agent.getConversationSnapshot(agent.activeConversationId, { window: 200 });
        // 完整对话信息：workRuns 用持久化记录透出（含被中断的构建，不依赖运行时内存）
        const persistedRuns = agent.getPersistedConversationWorkRuns(agent.activeConversationId);
        if (persistedRuns.length) (active as { workRuns?: unknown }).workRuns = persistedRuns;
        mobileJson(res, {
          mode: agent.mode,
          model: agent.modelSelectionValue(),
          modelLabel: agent.modelLabel(),
          models: agent.allModelNames(),
          providers: sanitizeProvidersForState(agent.config.providers()),
          intelligence: agent.intelligence,
          status: agent.status,
          activeConversationId: agent.activeConversationId,
          conversations: agent.listConversationStates(),
          workspaces: { internal: agent.workspace.internal, external: agent.workspace.external, current: agent.workspace.current },
          pendingOptions: agent.pendingOptions,
          contextWindow: agent.contextWindow(),
          chatMessages: active.chatMessages,
          totalMessages: active.totalMessages,
          conversationLocked: agent.isConversationLocked(),
          // workRuns 透出：完整 Build Block 记录（含 interrupted/force_interrupted），供移动端渲染被中断的对话
          workRuns: active.workRuns,
          // goal bar / flow bar：目标状态与当前 Flow 选择
          goal: active.goal,
          flowSelection: active.flowSelection,
        });
        return;
      }
      case '/api/mobile/conversations': {
        mobileJson(res, agent.listConversationStates());
        return;
      }
      case '/api/mobile/conversation': {
        const workspaceId = url.searchParams.get('workspaceId') || '';
        const windowParam = url.searchParams.get('window');
        const beforeParam = url.searchParams.get('before');
        const windowSize = windowParam ? Math.max(1, Math.min(500, Number(windowParam) || 200)) : 200;
        const before = beforeParam ? Math.max(0, Number(beforeParam) || 0) : undefined;
        const current = agent;
        const ws = workspaceId ? resolveMobileWorkspace(current, workspaceId) : null;
        if (workspaceId && !ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        const conversationId = url.searchParams.get('conversationId')
          || (ws ? current.activeConversationIdForWorkspace(ws) : current.activeConversationId);
        if (ws && !current.hasConversationInWorkspace(String(conversationId), ws)) {
          mobileJson(res, { error: 'Conversation not found in workspace' }, 404);
          return;
        }
        // GUI conversations normally execute inside isolated runtime pools.
        // Their durable target state can be newer than the hosted main Agent's
        // foreground memory, so workspace-bound mobile reads must hydrate a
        // fresh read-only target Agent from storage.
        const snapshotAgent = ws ? mobileScopedAgent(ws, String(conversationId)) : current;
        const snapshot = snapshotAgent.getConversationSnapshot(String(conversationId), {
          window: windowSize,
          before,
          workspace: ws || undefined,
        });
        // 完整对话信息：workRuns 统一用持久化记录透出（含被中断的构建）
        const persistedRuns = snapshotAgent.getPersistedConversationWorkRuns(String(conversationId), ws || undefined);
        if (persistedRuns.length) (snapshot as { workRuns?: unknown }).workRuns = persistedRuns;
        mobileJson(res, snapshot);
        return;
      }
      case '/api/mobile/workspaces': {
        mobileJson(res, { internal: agent.workspace.internal, external: agent.workspace.external, current: agent.workspace.current });
        return;
      }
      case '/api/mobile/workspace-conversations': {
        const workspaceId = url.searchParams.get('workspaceId') || '';
        const current = agent;
        const ws = resolveMobileWorkspace(current, workspaceId);
        if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        const conversations = mobileWorkspaceConversationRows(current, ws);
        mobileJson(res, { workspace: { id: ws.id, name: ws.name, path: ws.path, isInternal: ws.isInternal }, conversations });
        return;
      }
      case '/api/mobile/provider-catalog-export': {
        if (req.method !== 'POST') {
          mobileJson(res, { error: 'Method not allowed' }, 405);
          return;
        }
        // This is intentionally separate from mobile state: normal remote UI
        // projection stays redacted, while an explicit paired-device import
        // can migrate a usable local provider configuration.
        res.setHeader('Cache-Control', 'no-store');
        mobileJson(res, { providers: agent.config.providers() });
        return;
      }
      case '/api/mobile/right-sidebar-state': {
        const workspaceId = url.searchParams.get('workspaceId') || '';
        const conversationId = url.searchParams.get('conversationId') || '';
        const ws = resolveMobileWorkspace(agent, workspaceId);
        if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        if (!conversationId || !agent.hasConversationInWorkspace(conversationId, ws)) {
          mobileJson(res, { error: 'Conversation not found in workspace' }, 404);
          return;
        }
        mobileJson(res, mobileRightSidebarState(agent, ws, conversationId));
        return;
      }
      case '/api/mobile/conversation-ui-state': {
        const workspaceId = url.searchParams.get('workspaceId') || '';
        const conversationId = url.searchParams.get('conversationId') || '';
        const ws = resolveMobileWorkspace(agent, workspaceId);
        if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        if (!conversationId || !agent.hasConversationInWorkspace(conversationId, ws)) {
          mobileJson(res, { error: 'Conversation not found in workspace' }, 404);
          return;
        }
        if (hostedConversationUiState) {
          mobileJson(res, await hostedConversationUiState({ workspaceId, conversationId }));
          return;
        }
        const scoped = mobileScopedAgent(ws, conversationId);
        const snapshot = scoped.getConversationSnapshot(conversationId, { workspace: ws, window: 1 });
        mobileJson(res, {
          goal: snapshot.goal,
          flowSelection: snapshot.flowSelection,
          flow: null,
          queued: { steering: [], followUp: [] },
          runtime: null,
          mode: scoped.mode,
          status: scoped.status,
          inputMode: scoped.inputMode,
        });
        return;
      }
      case '/api/mobile/workspace-files': {
        const workspaceId = url.searchParams.get('workspaceId') || '';
        const relativePath = url.searchParams.get('path') || '';
        const ws = resolveMobileWorkspace(agent, workspaceId);
        if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        const resolved = resolveMobileWorkspacePath(ws, relativePath);
        await assertMobileRealPathContained(resolved.root, resolved.target);
        const stat = await fs.promises.stat(resolved.target);
        if (!stat.isDirectory()) { mobileJson(res, { error: 'Path is not a directory' }, 400); return; }
        const entries = await fs.promises.readdir(resolved.target, { withFileTypes: true });
        const rows = entries
          .filter(entry => entry.name !== '.git' && entry.name !== 'node_modules')
          .map(entry => ({
            name: entry.name,
            path: path.posix.join(resolved.relative, entry.name).replace(/^\.\//, ''),
            directory: entry.isDirectory(),
          }))
          .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
        mobileJson(res, { workspaceId, path: resolved.relative, entries: rows });
        return;
      }
      case '/api/mobile/workspace-file': {
        if (req.method === 'GET') {
          const workspaceId = url.searchParams.get('workspaceId') || '';
          const relativePath = url.searchParams.get('path') || '';
          const ws = resolveMobileWorkspace(agent, workspaceId);
          if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
          const resolved = resolveMobileWorkspacePath(ws, relativePath);
          await assertMobileRealPathContained(resolved.root, resolved.target);
          const stat = await fs.promises.stat(resolved.target);
          if (!stat.isFile() || stat.size > MOBILE_EDITOR_MAX_BYTES || !mobileEditableFile(resolved.target)) {
            mobileJson(res, { error: 'File is not an editable text file' }, 415);
            return;
          }
          const content = (await fs.promises.readFile(resolved.target, 'utf-8')).replace(/^\uFEFF/, '');
          mobileJson(res, { workspaceId, path: resolved.relative, content, size: stat.size });
          return;
        }
        const params = JSON.parse(body || '{}');
        const workspaceId = String(params.workspaceId || '');
        const relativePath = String(params.path || '');
        const content = String(params.content ?? '');
        const ws = resolveMobileWorkspace(agent, workspaceId);
        if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        if (Buffer.byteLength(content, 'utf-8') > MOBILE_EDITOR_MAX_BYTES) {
          mobileJson(res, { error: 'File exceeds mobile editor size limit' }, 413);
          return;
        }
        const resolved = resolveMobileWorkspacePath(ws, relativePath);
        await assertMobileRealPathContained(resolved.root, resolved.target);
        if (!mobileEditableFile(resolved.target)) { mobileJson(res, { error: 'File type is not editable' }, 415); return; }
        const stat = await fs.promises.stat(resolved.target);
        if (!stat.isFile()) { mobileJson(res, { error: 'Path is not a file' }, 400); return; }
        await fs.promises.writeFile(resolved.target, content, 'utf-8');
        mobileJson(res, { ok: true, workspaceId, path: resolved.relative, size: Buffer.byteLength(content, 'utf-8') });
        return;
      }
      case '/api/mobile/conversation-plan-update': {
        const params = JSON.parse(body || '{}');
        const workspaceId = String(params.workspaceId || '');
        const conversationId = String(params.conversationId || '');
        const ws = resolveMobileWorkspace(agent, workspaceId);
        if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        if (!conversationId || !agent.hasConversationInWorkspace(conversationId, ws)) {
          mobileJson(res, { error: 'Conversation not found in workspace' }, 404);
          return;
        }
        const scoped = mobileScopedAgent(ws, conversationId);
        const plan = scoped.updateConversationPlan({ items: Array.isArray(params.items) ? params.items : [] }, conversationId);
        mobileJson(res, { ok: true, conversationPlan: plan });
        return;
      }
      case '/api/mobile/conversation-create': {
        const params = JSON.parse(body || '{}');
        const workspaceId = String(params.workspaceId || '');
        if (!workspaceId) { mobileJson(res, { error: 'No workspaceId' }, 400); return; }
        const ws = resolveMobileWorkspace(agent, workspaceId);
        if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        const created = agent.createConversationInWorkspace(ws, String(params.title || ''));
        mobileJson(res, {
          ok: true,
          workspace: { id: ws.id, name: ws.name, path: ws.path, isInternal: ws.isInternal },
          conversation: created,
          activeConversationId: created.id,
          conversations: mobileWorkspaceConversationRows(agent, ws),
        });
        return;
      }
      case '/api/mobile/model': {
        const next = String((JSON.parse(body || '{}') as Record<string, unknown>).model || '');
        if (!next) { mobileJson(res, { error: 'Model is required' }, 400); return; }
        agent.setModel(next);
        mobileJson(res, {
          ok: true,
          model: agent.modelSelectionValue(),
          modelLabel: agent.modelLabel(),
        });
        return;
      }
      case '/api/mobile/intelligence': {
        const tier = String((JSON.parse(body || '{}') as Record<string, unknown>).tier || 'medium');
        agent.setIntelligence(tier, true);
        mobileJson(res, { ok: true, intelligence: agent.intelligence });
        return;
      }
      case '/api/mobile/conversation-ui-action': {
        const params = JSON.parse(body || '{}') as Record<string, unknown>;
        const workspaceId = String(params.workspaceId || '');
        const conversationId = String(params.conversationId || '');
        const action = String(params.action || '') as 'goal_update' | 'goal_guide' | 'conversation_guide' | 'goal_toggle_pause' | 'goal_clear' | 'flow_pause' | 'flow_resume' | 'flow_guide' | 'conversation_stop' | 'input_mode' | 'queue_enqueue' | 'queue_update' | 'queue_delete' | 'queue_reorder' | 'queue_toggle_pause' | 'queue_guide';
        const allowed = new Set(['goal_update', 'goal_guide', 'conversation_guide', 'goal_toggle_pause', 'goal_clear', 'flow_pause', 'flow_resume', 'flow_guide', 'conversation_stop', 'input_mode', 'queue_enqueue', 'queue_update', 'queue_delete', 'queue_reorder', 'queue_toggle_pause', 'queue_guide']);
        if (!workspaceId || !conversationId || !allowed.has(action)) {
          mobileJson(res, { error: 'workspaceId, conversationId, and a valid action are required' }, 400);
          return;
        }
        const ws = resolveMobileWorkspace(agent, workspaceId);
        if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        if (!agent.hasConversationInWorkspace(conversationId, ws)) {
          mobileJson(res, { error: 'Conversation not found in workspace' }, 404);
          return;
        }
        if (!hostedConversationUiAction) {
          mobileJson(res, { error: 'This action requires the GUI-hosted mobile server' }, 409);
          return;
        }
        mobileJson(res, await hostedConversationUiAction(
          { workspaceId, conversationId },
          action,
          String(params.value || ''),
          params,
        ));
        return;
      }
      case '/api/mobile/conversation-rename': {
        const params = JSON.parse(body || '{}');
        const workspaceId = String(params.workspaceId || '');
        const conversationId = String(params.conversationId || '');
        const title = String(params.title || '');
        if (!workspaceId || !conversationId || !title.trim()) {
          mobileJson(res, { error: 'workspaceId, conversationId, and title are required' }, 400);
          return;
        }
        const ws = resolveMobileWorkspace(agent, workspaceId);
        if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        const ok = agent.renameConversation(conversationId, title, ws);
        if (!ok) { mobileJson(res, { ok: false, error: 'Conversation rename failed' }, 404); return; }
        mobileJson(res, { ok: true, conversations: mobileWorkspaceConversationRows(agent, ws) });
        return;
      }
      case '/api/mobile/conversation-pin': {
        const params = JSON.parse(body || '{}');
        const workspaceId = String(params.workspaceId || '');
        const conversationId = String(params.conversationId || '');
        if (!workspaceId || !conversationId) {
          mobileJson(res, { error: 'workspaceId and conversationId are required' }, 400);
          return;
        }
        const ws = resolveMobileWorkspace(agent, workspaceId);
        if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        const pinned = params.pinned === true;
        const ok = agent.setConversationPinned(conversationId, pinned, ws);
        if (!ok) { mobileJson(res, { ok: false, error: 'Conversation pin update failed' }, 404); return; }
        mobileJson(res, { ok: true, pinned, conversations: mobileWorkspaceConversationRows(agent, ws) });
        return;
      }
      case '/api/mobile/conversation-reorder': {
        const params = JSON.parse(body || '{}');
        const workspaceId = String(params.workspaceId || '');
        const conversationIds = Array.isArray(params.conversationIds)
          ? params.conversationIds.map((id: unknown) => String(id || ''))
          : [];
        if (!workspaceId || conversationIds.length < 2 || conversationIds.some((id: string) => !id)) {
          mobileJson(res, { error: 'workspaceId and at least two conversationIds are required' }, 400);
          return;
        }
        if (new Set(conversationIds).size !== conversationIds.length) {
          mobileJson(res, { error: 'conversationIds must be unique' }, 400);
          return;
        }
        const ws = resolveMobileWorkspace(agent, workspaceId);
        if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        const current = agent;
        if (conversationIds.some((id: string) => !current.hasConversationInWorkspace(id, ws))) {
          mobileJson(res, { error: 'Conversation not found in workspace' }, 404);
          return;
        }
        const listedById = new Map(current.listWorkspaceConversationStates(ws).map(item => [item.id, item]));
        if (new Set(conversationIds.map((id: string) => !!listedById.get(id)?.pinned)).size !== 1) {
          mobileJson(res, { error: 'Conversations must remain within one pinned group' }, 409);
          return;
        }
        const ok = current.reorderWorkspaceConversationGroup(conversationIds, ws);
        if (!ok) { mobileJson(res, { ok: false, error: 'Conversation reorder failed' }, 409); return; }
        mobileJson(res, { ok: true, conversations: mobileWorkspaceConversationRows(current, ws) });
        return;
      }
      case '/api/mobile/send': {
        const params = JSON.parse(body || '{}');
        const message = String(params.message || '');
        if (!message) { mobileJson(res, { error: 'No message' }, 400); return; }
        const workspaceId = String(params.workspaceId || '');
        let requestAgent = agent;
        let requestWorkspace: WorkspaceInfo | null = agent.workspace.current;
        let resolvedWorkspace: WorkspaceInfo | null = null;
        if (workspaceId) {
          const ws = resolveMobileWorkspace(agent, workspaceId);
          if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
          resolvedWorkspace = ws;
          requestWorkspace = ws;
        }
        const conversationId = String(params.conversationId
          || (resolvedWorkspace ? agent.activeConversationIdForWorkspace(resolvedWorkspace) : agent.activeConversationId));
        if (resolvedWorkspace) {
          const ws = resolvedWorkspace;
          if (!agent.hasConversationInWorkspace(conversationId, ws)) {
            mobileJson(res, { error: 'Conversation not found in workspace' }, 404);
            return;
          }
          const currentWs = agent.workspace.current;
          if (!currentWs || path.resolve(currentWs.path) !== path.resolve(ws.path)) {
            requestAgent = mobileScopedAgent(ws, conversationId);
          }
        }
        if (hostedConversationPrompt && resolvedWorkspace) {
          const result = await hostedConversationPrompt({ workspaceId, conversationId }, message, {
            requestedMode: String(params.requestedMode || ''),
            goalObjective: String(params.goalObjective || ''),
            inputMode: String(params.inputMode || ''),
          });
          mobileJson(res, { ok: true, conversationId, ...result });
          return;
        }
        if (requestAgent === agent && params.conversationId) requestAgent.setConversation(conversationId);
        let scopedRuntimeKey = '';
        let scopedRuntime: { agent: Agent; workspaceId: string; conversationId: string; unsubscribe: () => void } | null = null;
        let unsubscribeScoped: (() => void) | null = null;
        if (requestAgent !== agent && requestWorkspace) {
          scopedRuntimeKey = mobileRuntimeKey(String(requestWorkspace.id || ''), conversationId);
          unsubscribeScoped = requestAgent.subscribeWorkEvents(event => publishServerWorkEvent({
            ...event,
            workspaceId: String(requestWorkspace?.id || ''),
            conversationId,
          }));
          scopedRuntime = {
            agent: requestAgent,
            workspaceId: String(requestWorkspace.id || ''),
            conversationId,
            unsubscribe: unsubscribeScoped,
          };
          mobileScopedRuntimes.set(scopedRuntimeKey, scopedRuntime);
        }
        let tokens;
        try {
          tokens = await requestAgent.process(message);
        } finally {
          if (scopedRuntimeKey && mobileScopedRuntimes.get(scopedRuntimeKey) === scopedRuntime) {
            mobileScopedRuntimes.delete(scopedRuntimeKey);
          }
          if (unsubscribeScoped) unsubscribeScoped();
        }
        const snapshot = requestAgent.getConversationSnapshot(conversationId, {
          window: 200,
          workspace: requestWorkspace,
        });
        mobileJson(res, {
          ok: true,
          conversationId,
          response: tokens.map(token => token.text).join(''),
          tokens: tokens.map(token => ({ type: token.type, text: token.text })),
          options: requestAgent.pendingOptions,
          status: requestAgent.status,
          conversations: requestWorkspace
            ? mobileWorkspaceConversationRows(requestAgent, requestWorkspace)
            : requestAgent.listConversationStates(),
          chatMessages: snapshot.chatMessages,
          totalMessages: snapshot.totalMessages,
        });
        return;
      }
      case '/api/mobile/conversation-branch-inspect':
      case '/api/mobile/conversation-branch-activate':
      case '/api/mobile/conversation-branch-create': {
        const params = JSON.parse(body || '{}');
        const workspaceId = String(params.workspaceId || '');
        const conversationId = String(params.conversationId || '');
        if (!workspaceId || !conversationId) {
          mobileJson(res, { error: 'workspaceId and conversationId are required' }, 400);
          return;
        }
        const ws = resolveMobileWorkspace(agent, workspaceId);
        if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        if (!agent.hasConversationInWorkspace(conversationId, ws)) {
          mobileJson(res, { error: 'Conversation not found in workspace' }, 404);
          return;
        }
        const scoped = mobileScopedAgent(ws, conversationId);
        if (pathname === '/api/mobile/conversation-branch-inspect') {
          const branchId = String(params.branchId || '');
          if (!branchId) { mobileJson(res, { error: 'branchId is required' }, 400); return; }
          mobileJson(res, scoped.inspectConversationBranch(conversationId, branchId, String(params.branchGroupId || '')));
          return;
        }
        if (mobileConversationRuntimeBusy(agent, ws, conversationId)) {
          mobileJson(res, { error: 'Conversation is running' }, 423);
          return;
        }
        if (pathname === '/api/mobile/conversation-branch-activate') {
          const branchId = String(params.branchId || '');
          if (!branchId) { mobileJson(res, { error: 'branchId is required' }, 400); return; }
          mobileJson(res, scoped.switchConversationBranch(conversationId, branchId, String(params.branchGroupId || '')));
          return;
        }
        const messageIndex = Math.floor(Number(params.messageIndex));
        const editedText = String(params.editedText || '').trim();
        if (!Number.isFinite(messageIndex) || messageIndex < 0 || !editedText) {
          mobileJson(res, { error: 'messageIndex and editedText are required' }, 400);
          return;
        }
        const branchNodePath = Array.isArray(params.branchNodePath)
          ? params.branchNodePath.map((id: unknown) => String(id || '')).filter(Boolean)
          : [];
        const snapshot = scoped.branchConversation(conversationId, messageIndex, editedText, {
          messageId: String(params.messageId || '') || undefined,
          guideId: String(params.guideId || '') || undefined,
          clientMessageId: String(params.clientMessageId || '') || undefined,
          runId: String(params.runId || '') || undefined,
          branchNodePath,
        });
        mobileJson(res, snapshot);
        return;
      }
      case '/api/mobile/conversation-archive': {
        const params = JSON.parse(body || '{}');
        const conversationId = String(params.conversationId || '');
        const workspaceId = String(params.workspaceId || '');
        if (!workspaceId || !conversationId) {
          mobileJson(res, { error: 'workspaceId and conversationId are required' }, 400);
          return;
        }
        const ws = resolveMobileWorkspace(agent, workspaceId);
        if (!ws) { mobileJson(res, { error: 'Unknown workspace' }, 404); return; }
        if (!agent.hasConversationInWorkspace(conversationId, ws)) {
          mobileJson(res, { ok: false, error: 'Conversation not found in workspace' }, 404);
          return;
        }
        // 运行中拒绝：与移动端 running 判定一致（activeConversationId + agent.status 非 idle）
        if (mobileConversationRuntimeBusy(agent, ws, conversationId)) {
          mobileJson(res, { ok: false, error: 'Conversation is running' }, 423);
          return;
        }
        const filename = await agent.archiveConversationAsync(conversationId, ws);
        if (!filename) { mobileJson(res, { ok: false, error: 'Conversation archive could not be written.' }, 500); return; }
        mobileJson(res, {
          ok: true,
          fileName: filename,
          conversationId,
          activeConversationId: agent.activeConversationIdForWorkspace(ws),
          conversations: mobileWorkspaceConversationRows(agent, ws),
        });
        return;
      }
      default:
        jsonResponse(res, { error: 'Unknown API' }, 404);
    }
  } catch(e: any) {
    if (pathname.startsWith('/api/mobile/')) mobileJson(res, { error: e.message }, 500);
    else jsonResponse(res, { error: e.message }, 500);
  }
}

function startServer(root: string, options: HostedMobileServerOptions = {}): http.Server {
  mobileToken = ensureMobileToken(root);
  appRoot = root;
  agent = options.agent || new Agent(root);
  hostedWorkEventSink = options.onWorkEvent || null;
  hostedConversationUiState = options.conversationUiState;
  hostedConversationUiAction = options.conversationUiAction;
  hostedConversationPrompt = options.conversationPrompt;
  unsubscribeHostedWorkEvents?.();
  unsubscribeHostedWorkEvents = options.subscribeWorkEvents?.(publishMobileWorkEvent) || null;
  workspaceFileRouter = new WorkspaceFileRouter(() => path.resolve(agent?.workspace.current?.path || root));
  automation = options.automation || null;
  if (!automation && !options.agent) automation = new AutomationManager(agent.config, async (prompt, model, item) => {
    if (!agent) return '';
    const previousModel = agent.model;
    const previousWorkspace = agent.workspace.current?.id || agent.workspace.current?.path || '';
    const previousConversation = agent.activeConversationId;
    agent.selectWorkspaceFromStorage(item.workspaceId);
    const conversationId = item.conversationMode === 'existing'
      ? item.conversationId
      : `automation-${item.id}-${Date.now().toString(36)}`;
    agent.setConversationFromStorage(conversationId);
    automation?.update(item.id, { lastConversationId: conversationId });
    if (model) agent.setModel(model);
    try {
      const tokens = await agent.process(prompt);
      return tokens.map(t => t.text).join('');
    } finally {
      if (model) agent.setModel(previousModel);
      if (previousWorkspace) agent.selectWorkspaceFromStorage(previousWorkspace);
      agent.setConversationFromStorage(previousConversation);
    }
  });
  unsubscribeServerAgentWorkEvents?.();
  unsubscribeServerAgentWorkEvents = agent.subscribeWorkEvents(publishServerWorkEvent);
  if (automation) {
    agent.setAutomationManager(automation);
    if (!options.automation) automation.start();
  }
  const uiDir = path.join(__dirname, 'ui');

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    if (url.pathname === '/api/mobile/events') {
      handleMobileEvents(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/mobile/workspace-file-upload') {
      await handleMobileWorkspaceUpload(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      let body = '';
      let bodyBytes = 0;
      let rejected = false;
      req.on('data', chunk => {
        if (rejected) return;
        bodyBytes += Buffer.byteLength(chunk);
        if (bodyBytes > MAX_API_BODY_BYTES) {
          rejected = true;
          if (url.pathname.startsWith('/api/mobile/')) mobileJson(res, { error: 'Request body too large' }, 413);
          else jsonResponse(res, { error: 'Request body too large' }, 413);
          return;
        }
        body += chunk;
      });
      req.on('end', () => { if (!rejected) handleApi(req, res, body); });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => handleApi(req, res, body));
      return;
    }

    // Static files
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const fullPath = path.join(uiDir, filePath);
    serveFile(res, fullPath);
  });

  const bindHost = process.env.NEWMARK_BIND_HOST || '0.0.0.0';
  const tailscale = tailscaleIpv4();
  const lan = lanIpv4();
  const accessHost = tailscale || lan || '<lan-or-tailscale-ip>';
  const tokenPath = path.join(root, '.newmark-mobile-token');
  hostedServer = server;
  hostedServerError = '';
  hostedServerStartedAt = Date.now();
  server.once('error', error => {
    hostedServerError = error instanceof Error ? error.message : String(error);
    if (hostedServer === server) hostedServer = null;
  });
  server.listen(PORT, bindHost, () => {
    console.log(`\n  Newmark Agent v1.0 - Server Mode`);
    console.log(`  Bind: ${bindHost}:${PORT}`);
    console.log(`  GUI: http://localhost:${PORT}`);
    console.log(`  Tailscale IPv4: ${tailscale || 'not detected'}`);
    console.log(`  LAN IPv4: ${lan || 'not detected'}`);
    console.log(`  Mobile endpoint: http://${accessHost}:${PORT}/api/mobile/hello?token=<token>`);
    console.log(`  Mobile token file: ${tokenPath}`);
    console.log(`  Mobile events (SSE): http://${accessHost}:${PORT}/api/mobile/events?token=<token>`);
    console.log(`  Press Ctrl+C to stop\n`);
  });
  return server;
}

function configuredAccessHost(): string {
  const now = Date.now();
  if (now - hostedAccessHostCheckedAt < 30_000) return hostedAccessHost;
  hostedAccessHost = tailscaleIpv4() || lanIpv4() || '';
  hostedAccessHostCheckedAt = now;
  return hostedAccessHost;
}

function waitForHostedServerListening(timeoutMs = 5000): Promise<void> {
  if (hostedServer?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (hostedServer?.listening) return resolve();
      if (hostedServerError) return reject(new Error(hostedServerError));
      if (Date.now() >= deadline) return reject(new Error('Mobile server listen timeout'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function probeHostedServer(host: string): Promise<{ ok: boolean; error: string }> {
  if (!hostedServer?.listening || !mobileToken) return { ok: false, error: hostedServerError || 'Mobile server is not listening' };
  return await new Promise(resolve => {
    const request = http.get({
      hostname: host,
      port: PORT,
      path: `/api/mobile/hello?token=${encodeURIComponent(mobileToken)}`,
      timeout: 1800,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}') as { ok?: boolean; error?: string };
          const ok = response.statusCode === 200 && parsed.ok === true;
          resolve({ ok, error: ok ? '' : String(parsed.error || `HTTP ${response.statusCode || 0}`) });
        } catch (error) {
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Mobile server probe timeout')));
    request.on('error', error => resolve({ ok: false, error: error.message }));
  });
}

export function configureHostedServer(root: string, options: HostedMobileServerOptions = {}): void {
  hostedServerRoot = root;
  hostedServerOptions = options;
}

export async function stopHostedServer(): Promise<void> {
  const server = hostedServer;
  hostedServer = null;
  if (server) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 2500);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  }
  unsubscribeHostedWorkEvents?.();
  unsubscribeHostedWorkEvents = null;
  unsubscribeServerAgentWorkEvents?.();
  unsubscribeServerAgentWorkEvents = null;
  hostedServerStartedAt = 0;
}

export async function hostedServerStatus(enabled = true, probeHost = ''): Promise<HostedMobileServerStatus> {
  const listening = !!hostedServer?.listening;
  const host = enabled ? (String(probeHost || '').trim() || configuredAccessHost()) : '';
  let reachable = false;
  let error = hostedServerError;
  if (enabled && listening) {
    if (!host) error = 'No LAN or Tailscale IPv4 address is available';
    else {
      const probe = await probeHostedServer(host);
      reachable = probe.ok;
      if (!probe.ok) error = probe.error;
    }
  }
  const state: HostedMobileServerStatus['state'] = !enabled ? 'off' : listening && reachable ? 'listening' : 'error';
  return {
    enabled,
    listening,
    reachable,
    state,
    host,
    port: PORT,
    error: state === 'error' ? (error || 'Mobile server is not reachable') : '',
    checkedAt: new Date().toISOString(),
    startedAt: hostedServerStartedAt,
  };
}

export async function setHostedServerEnabled(enabled: boolean, probeHost = ''): Promise<HostedMobileServerStatus> {
  await stopHostedServer();
  hostedServerError = '';
  if (enabled) {
    if (!hostedServerRoot) throw new Error('Hosted mobile server is not configured');
    startServer(hostedServerRoot, hostedServerOptions);
    try { await waitForHostedServerListening(); } catch (error) { hostedServerError = error instanceof Error ? error.message : String(error); }
  }
  return await hostedServerStatus(enabled, probeHost);
}

/** 托管启动 server（GUI/TUI 内嵌调用；幂等防重入，进程常驻即服务常驻） */
export function runServer(root: string, options: HostedMobileServerOptions = {}): void {
  if (!hostedServerRoot || Object.keys(options).length > 0) configureHostedServer(root, options);
  else hostedServerRoot = root;
  if (hostedServer?.listening) return;
  startServer(hostedServerRoot, hostedServerOptions);
}

/** Attach the GUI-owned automation manager after deferred startup. */
export function setHostedServerAutomation(manager: AutomationManager): void {
  automation = manager;
}
