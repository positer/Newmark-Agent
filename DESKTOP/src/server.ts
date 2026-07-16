import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeUiBackgroundColor, normalizeUiFontFamily, normalizeUiTheme } from './core/uiPreferences';
import { spawnSync } from 'child_process';
import { Agent } from './core/agent';
import { AgentMode } from './core/types';
import { AutomationManager } from './core/automation';
import { sanitizeProvidersForState } from './core/config';
import { FlowEngine, FlowWorkflow } from './core/flow';
import { WorkspaceFileRouter } from './core/workspaceFileRouter';

const PORT = 47890;
let agent: Agent | null = null;
let automation: AutomationManager | null = null;
let workspaceFileRouter: WorkspaceFileRouter | null = null;

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

function runShellCommand(command: string, shellId: string, cwd: string): { output: string; error?: string } {
  const requested = normalizeTerminalShell(shellId || defaultTerminalShell());
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
        agent.setIntelligence(JSON.parse(body || '{}').tier || 'medium');
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
          jsonResponse(res, runShellCommand(String(command || cmd || ''), String(shell || ''), cwd || agent.rootPath));
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
        jsonResponse(res, { ok: true });
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
      default:
        jsonResponse(res, { error: 'Unknown API' }, 404);
    }
  } catch(e: any) {
    jsonResponse(res, { error: e.message }, 500);
  }
}

function startServer(root: string): void {
  agent = new Agent(root);
  workspaceFileRouter = new WorkspaceFileRouter(() => path.resolve(agent?.workspace.current?.path || root));
  automation = new AutomationManager(agent.config, async (prompt, model) => {
    if (!agent) return '';
    const previousModel = agent.model;
    if (model) agent.setModel(model);
    try {
      const tokens = await agent.process(prompt);
      return tokens.map(t => t.text).join('');
    } finally {
      if (model) agent.setModel(previousModel);
    }
  });
  agent.setAutomationManager(automation);
  automation.start();
  const uiDir = path.join(__dirname, 'ui');

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204); res.end(); return;
    }

    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => handleApi(req, res, body));
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

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Newmark Agent v1.0 - Server Mode`);
    console.log(`  GUI: http://localhost:${PORT}`);
    console.log(`  Press Ctrl+C to stop\n`);
  });
}

export function runServer(root: string): void {
  startServer(root);
}
