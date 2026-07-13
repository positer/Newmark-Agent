import { app, BrowserWindow, ipcMain, dialog, utilityProcess, Tray, Menu, nativeImage, nativeTheme, webContents, shell, protocol } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { createHash, randomUUID } from 'crypto';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { Agent } from './core/agent';
import { AgentMode } from './core/types';
import { AgentPromptMessage, ConversationKernel } from './core/conversationKernel';
import { AutomationManager } from './core/automation';
import { AutomationWakeScheduler, WakeSyncResult } from './core/automationWake';
import { BrowserControl, BrowserControlRequest, BrowserControlResult } from './core/browserControl';
import { FlowEngine } from './core/flow';
import { runFlow } from './core/flow-runner';
import { CLI_COMMANDS, runCliCommand } from './cli-commands';
import { mergeProviderSecrets, sanitizeProvidersForState } from './core/config';
import { MemoryLabManager } from './core/memoryLab';
import { applyGitHubUpdate, checkGitHubUpdate, currentAppVersion, installUpdate } from './core/installUpdate';
import {
  detachTerminalTakeoverSession,
  normalizeTerminalTakeoverOwner,
  onTerminalTakeoverEvent,
  resizeTerminalTakeoverSession,
  ROOT_TERMINAL_ACTOR_ID,
  shutdownTerminalTakeoverSessions,
  stopTerminalTakeoverSession,
  terminalTakeoverState,
  terminalTakeoverWorkspaceId,
  writeTerminalTakeoverSession,
} from './tools/terminalTakeover';
import { nativeToolCatalogForState, normalizeNativeToolEnabled } from './tools/nativeTools';
import { LLMProvider } from './llm/provider';
import { WslAgentClient } from './core/wslAgentClient';
import { previewResponse, WorkspaceFileRouter } from './core/workspaceFileRouter';
import { runComputerUse } from './tools/computerUse';

const APP_NAME = 'Newmark Agent';
const APP_ID = 'ai.newmark.agent';

protocol.registerSchemesAsPrivileged([{
  scheme: 'newmark-preview',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

app.setName(APP_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

let mainWindow: BrowserWindow | null = null;
let agent: Agent | null = null;
let conversationKernel: ConversationKernel | null = null;
let wslAgentClient: WslAgentClient | null = null;
let activeAgentBackendMode: 'windows' | 'wsl' = 'windows';
let automation: AutomationManager | null = null;
let automationWake: AutomationWakeScheduler | null = null;
let lastWakeSync: WakeSyncResult | null = null;
let tray: Tray | null = null;
let _forceQuit = false;
let browserControlWindow: BrowserWindow | null = null;

const STARTUP_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Newmark Agent</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#0a0a1a;color:#f8fafc;font-family:Segoe UI,Arial,sans-serif}
body{display:flex;align-items:center;justify-content:center;overflow:hidden}
.shell{min-width:320px;display:flex;gap:14px;align-items:center}
.mark{width:42px;height:42px;border-radius:10px;background:linear-gradient(135deg,#36d399,#60a5fa,#f472b6);box-shadow:0 18px 70px rgba(96,165,250,.24)}
.title{font-size:18px;font-weight:700;letter-spacing:0}
.status{margin-top:6px;color:#a7b0c0;font-size:12px}
</style>
</head>
<body>
<div class="shell"><div class="mark"></div><div><div class="title">Newmark Agent</div><div class="status">Starting workspace runtime...</div></div></div>
</body>
</html>`;

function defaultTerminalShell(): string {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

function availableTerminalShells(): string[] {
  return process.platform === 'win32' ? ['powershell', 'cmd', 'bash', 'pwsh'] : ['bash', 'sh', 'pwsh'];
}

function resolveTerminalShell(shellId: string): { id: string; exe: string; args: string[]; commandArgs: (command: string) => string[] } {
  const requested = String(shellId || '').toLowerCase();
  if (process.platform === 'win32') {
    if (requested === 'cmd') return { id: 'cmd', exe: 'cmd.exe', args: [], commandArgs: command => ['/d', '/s', '/c', command] };
    if (requested === 'bash') return { id: 'bash', exe: 'bash.exe', args: [], commandArgs: command => ['-lc', command] };
    if (requested === 'pwsh') return { id: 'pwsh', exe: 'pwsh.exe', args: [], commandArgs: command => ['-NoProfile', '-NonInteractive', '-Command', command] };
    return { id: 'powershell', exe: 'powershell.exe', args: [], commandArgs: command => ['-NoProfile', '-NonInteractive', '-Command', command] };
  }
  if (requested === 'sh') return { id: 'sh', exe: '/bin/sh', args: [], commandArgs: command => ['-c', command] };
  if (requested === 'pwsh') return { id: 'pwsh', exe: 'pwsh', args: [], commandArgs: command => ['-NoProfile', '-NonInteractive', '-Command', command] };
  const userShell = process.env.SHELL || '/bin/bash';
  return { id: 'bash', exe: userShell || '/bin/bash', args: [], commandArgs: command => ['-lc', command] };
}

function runShellCommand(command: string, shellId: string, cwd: string): { output?: string; error?: string } {
  const shellInfo = resolveTerminalShell(shellId || defaultTerminalShell());
  const result = spawnSync(shellInfo.exe, shellInfo.commandArgs(command), {
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

function resetConversationKernel(): void {
  if (conversationKernel?.isAnyRunning()) return;
  conversationKernel = null;
}

let wslDistroCache: { at: number; items: string[] } = { at: 0, items: [] };
let wslDetection: Promise<string[]> | null = null;

function decodeWslDistros(raw: Buffer): string[] {
  const utf16 = raw.toString('utf16le').replace(/\0/g, '').trim();
  const text = utf16 && /[A-Za-z0-9]/.test(utf16) ? utf16 : raw.toString('utf8').replace(/\0/g, '').trim();
  return text.split(/\r?\n/).map(line => line.replace(/\s*\(Default\)\s*$/i, '').trim()).filter(Boolean);
}

function detectWslDistrosAtStartup(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  if (wslDetection) return wslDetection;
  wslDetection = new Promise(resolve => {
    const child = spawn('wsl.exe', ['--list', '--quiet'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (items: string[]) => {
      if (settled) return;
      settled = true;
      wslDistroCache = { at: Date.now(), items };
      resolve(items.slice());
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish([]);
    }, 10000);
    child.stdout?.on('data', chunk => chunks.push(Buffer.from(chunk)));
    child.once('error', () => { clearTimeout(timer); finish([]); });
    child.once('close', code => {
      clearTimeout(timer);
      finish(code === 0 ? decodeWslDistros(Buffer.concat(chunks)) : []);
    });
  });
  return wslDetection;
}

async function availableWslDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  if (wslDistroCache.at) return wslDistroCache.items.slice();
  return detectWslDistrosAtStartup();
}

async function resetWslAgentClient(): Promise<void> {
  if (wslAgentClient) await wslAgentClient.resetAgent();
}

async function resetAgentRuntimes(): Promise<void> {
  resetConversationKernel();
  await resetWslAgentClient();
}

function broadcastAgentWorkEvent(event: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('agent:workEvent', event);
  }
}

function ensureConversationKernel(root: string): ConversationKernel | null {
  if (!agent) return null;
  if (!conversationKernel) {
    conversationKernel = new ConversationKernel(root, agent, automation);
    conversationKernel.subscribe(event => broadcastAgentWorkEvent(event));
  }
  return conversationKernel;
}

function stateConversationId(requested?: string): string {
  return String(requested || agent?.activeConversationId || 'default');
}

function backendConversationState(conversationId?: string): Record<string, unknown> {
  if (!agent) return {};
  const target = stateConversationId(conversationId);
  const snapshot = agent.getConversationSnapshot(target);
  return {
    ...snapshot,
    queued: conversationKernel?.queued(snapshot.conversationId || target) || { steering: [], followUp: [] },
    workEvents: conversationKernel?.events(snapshot.conversationId || target) || [],
    pendingOptions: conversationKernel?.pendingOptions(snapshot.conversationId || target) || [],
  };
}

const FALLBACK_TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAhklEQVQ4T2NkYPj/n4EBBJgYKAQMDAwM//79Y2RkZGQYmpqMgYGBgYEhJSWFgYGBAaoRAkZGRoZ///4x/Pr1CyrKwAhVwMDw798/BgYGBqgCRqgCBgaoKEYGBgYGqAJGqAIGSJQzMDAw/P79m4GRkZGBkZGRgaSADg0NZWBgYGCYOnUq8QENUQADAC3oSsHtAAAAAElFTkSuQmCC';

function appAssetPath(fileName: string): string {
  return path.join(__dirname, '..', 'assets', fileName);
}

function themedAppIconPath(): string {
  return appAssetPath(nativeTheme.shouldUseDarkColors ? 'app-icon-light.png' : 'app-icon-dark.png');
}

function createAppIconImage(size?: number) {
  const image = nativeImage.createFromPath(themedAppIconPath());
  const icon = image.isEmpty() ? nativeImage.createFromDataURL(FALLBACK_TRAY_ICON) : image;
  return size ? icon.resize({ width: size, height: size }) : icon;
}

function userArgs(): string[] {
  return process.argv.slice(1);
}

function argValue(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  if (idx >= 0) return args[idx + 1];
  const prefix = `${key}=`;
  const inline = args.find(a => a.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

function pathArgValue(args: string[], key: string): string | undefined {
  const prefix = `${key}=`;
  const inlineIdx = args.findIndex(a => a.startsWith(prefix));
  if (inlineIdx >= 0) {
    const parts = [args[inlineIdx].slice(prefix.length)];
    let best = fs.existsSync(parts[0]) ? parts[0] : '';
    for (let i = inlineIdx + 1; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('--')) break;
      parts.push(arg);
      const candidate = parts.join(' ');
      if (fs.existsSync(candidate)) best = candidate;
    }
    return best || parts.join(' ') || undefined;
  }
  const idx = args.indexOf(key);
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  const parts: string[] = [];
  let best = '';
  for (let i = idx + 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) break;
    parts.push(arg);
    const candidate = parts.join(' ');
    if (fs.existsSync(candidate)) best = candidate;
  }
  return best || parts.join(' ') || undefined;
}

function positionalAfter(args: string[], commandName: string): string[] {
  const start = args.indexOf(commandName);
  if (start < 0) return [];
  const values: string[] = [];
  for (let i = start + 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root' || arg === '--input') { i++; continue; }
    if (!arg.startsWith('--')) values.push(arg);
  }
  return values;
}

// First-run initialization
function firstRunInit(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  for (const d of ['skills', 'Work', 'Flow', 'archive', 'Memory Lab']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  new MemoryLabManager(root);

  const configModule = require('./core/config');
  configModule.ensureRootConfig(root);
  if (!fs.existsSync(path.join(root, 'agent.md'))) {
    fs.writeFileSync(path.join(root, 'agent.md'), '# Newmark Agent\n\nYou are a powerful coding assistant.\n', 'utf-8');
  }

  // PC_Hash.config
  const hostname = require('os').hostname();
  const pcId = `${hostname}|${process.platform}|${process.arch}`;
  const pcHashPath = path.join(root, 'PC_Hash.config');
  let existingPcId = '';
  try {
    existingPcId = fs.existsSync(pcHashPath) ? fs.readFileSync(pcHashPath, 'utf-8') : '';
  } catch {
    existingPcId = '';
  }
  if (existingPcId !== pcId) fs.writeFileSync(pcHashPath, pcId, 'utf-8');

  // Flow.md
  const fm = path.join(root, 'Flow', 'Flow.md');
  if (!fs.existsSync(fm)) {
    fs.writeFileSync(fm, `# Newmark Flow Format Guide

A Flow workflow is saved as \`name.Flow.json\` in the Flow/ folder.

## File Format
\`\`\`json
{
  "name": "my-workflow",
  "components": [
    {"id": 0, "type": "dialog", "mode": "build", "prompt": "Implement a web server"},
    {"id": 1, "type": "dialog", "mode": "plan", "prompt": "Review: {#prompt#}"},
    {"id": 2, "type": "logic", "prompt": "Is the review complete?", "goto_true": 0, "goto_false": 3},
    {"id": 3, "type": "dialog", "mode": "build", "prompt": "Apply fixes from review"}
  ]
}
\`\`\`

## Component Types
### dialog
- id: Sequential index, type: "dialog", mode: "build"/"plan"/"goal"
- prompt: Base prompt. Use \`{#prompt#}\` as placeholder for user input.

### logic
- id: Sequential index, type: "logic", prompt: Question for the agent to evaluate
- goto_true/goto_false: Component ID to jump to

## Execution
Components execute in order 0 -> 1 -> 2 -> ..., unless a logic component redirects.
`, 'utf-8');
  }

  // Local.json, External.json, State.json
  for (const fn of ['Local.json', 'External.json']) {
    const p = path.join(root, 'Work', fn);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '[]', 'utf-8');
  }
  const statePath = path.join(root, 'Work', 'State.json');
  if (!fs.existsSync(statePath)) fs.writeFileSync(statePath, '{}', 'utf-8');

}

function exeRoot(): string {
  return path.dirname(app.getPath('exe'));
}

function userRuntimeRoot(): string {
  return path.join(os.homedir(), '.Newmark');
}

function broadcastTerminalTakeoverEvent(event: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('agentTerminal:takeover', event);
  }
}

function ensureWslRuntimeBundle(): string {
  const packagedHost = path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'wsl-agent-host.bundle.cjs');
  const developmentHost = path.join(app.getAppPath(), 'dist', 'wsl-agent-host.bundle.cjs');
  const host = app.isPackaged ? packagedHost : developmentHost;
  if (!fs.existsSync(host)) throw new Error(`WSL Agent runtime host is missing: ${host}`);
  return host;
}

function legacyUserDataRoot(): string {
  try {
    return app.getPath('userData');
  } catch {
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, 'Newmark Agent');
    }
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Newmark Agent');
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Newmark Agent');
  }
}

function migrateLegacyRuntimeRoot(root: string): void {
  const targetRoot = path.resolve(root);
  const legacyRoot = path.resolve(legacyUserDataRoot());
  if (targetRoot === legacyRoot || !fs.existsSync(legacyRoot)) return;
  const items = ['config.json', 'agent.md', 'PC_Hash.config', 'Work', 'Flow', 'skills', 'archive', 'Memory Lab', 'Roots'];
  for (const item of items) {
    const from = path.join(legacyRoot, item);
    const to = path.join(targetRoot, item);
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true, errorOnExist: false });
    } catch {}
  }
}

function hasPortableRootState(candidate: string): boolean {
  return ['config.json', 'agent.md', 'PC_Hash.config', 'Work'].some(item => fs.existsSync(path.join(candidate, item)));
}

function canWriteDirectory(candidate: string): boolean {
  const probeName = `.newmark-write-test-${process.pid}-${Date.now()}`;
  const probePath = path.join(candidate, probeName);
  try {
    fs.mkdirSync(candidate, { recursive: true });
    fs.writeFileSync(probePath, 'ok', 'utf-8');
    fs.unlinkSync(probePath);
    return true;
  } catch {
    try { if (fs.existsSync(probePath)) fs.unlinkSync(probePath); } catch {}
    return false;
  }
}

function isPathInside(parent: string, child: string): boolean {
  try {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

function isProtectedInstallRoot(candidate: string): boolean {
  if (process.platform !== 'win32') return false;
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432,
  ].filter((value): value is string => !!value);
  return roots.some(root => isPathInside(root, candidate));
}

function shadowRootFor(candidate: string): string {
  const resolved = path.resolve(candidate || userRuntimeRoot());
  const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '_') || 'root';
  const hash = createHash('sha256').update(resolved.toLowerCase()).digest('hex').slice(0, 16);
  return path.join(userRuntimeRoot(), 'Roots', `${base}-${hash}`);
}

function writableRuntimeRoot(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (isPathInside(exeRoot(), resolved)) return userRuntimeRoot();
  if (isProtectedInstallRoot(resolved)) return shadowRootFor(resolved);
  if (!canWriteDirectory(resolved)) return shadowRootFor(resolved);
  return resolved;
}

function getRoot(): string {
  return userRuntimeRoot();
}

function resolveRoot(args: string[]): string {
  const explicitRoot = pathArgValue(args, '--root');
  if (explicitRoot) return writableRuntimeRoot(explicitRoot);
  return getRoot();
}

function startupLogPath(): string {
  try {
    const userData = userRuntimeRoot();
    fs.mkdirSync(userData, { recursive: true });
    return path.join(userData, 'startup.log');
  } catch {
    return path.join(require('os').tmpdir(), 'newmark-agent-startup.log');
  }
}

function logStartupFailure(stage: string, error: unknown): void {
  const message = error instanceof Error ? `${error.stack || error.message}` : String(error);
  const line = `[${new Date().toISOString()}] ${stage}\n${message}\n`;
  try {
    fs.appendFileSync(startupLogPath(), line, 'utf-8');
  } catch {
    try { fs.appendFileSync(path.join(require('os').tmpdir(), 'newmark-agent-startup.log'), line, 'utf-8'); } catch {}
  }
}

process.on('uncaughtException', error => {
  logStartupFailure('uncaughtException', error);
});

process.on('unhandledRejection', reason => {
  logStartupFailure('unhandledRejection', reason);
});

function resolveAppPath(root: string, targetPath: string): string {
  if (!targetPath) return root;
  return path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
}

function isTerminal(): boolean {
  return !!process.stdin.isTTY;
}


async function waitForWebContentsLoad(contents: Electron.WebContents, timeoutMs = 15000): Promise<void> {
  if (!contents.isLoadingMainFrame()) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      contents.removeListener('did-finish-load', finish);
      contents.removeListener('did-fail-load', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    contents.once('did-finish-load', finish);
    contents.once('did-fail-load', finish);
  });
}

async function ensureBrowserWebContents(): Promise<Electron.WebContents> {
  const guests = webContents.getAllWebContents().filter(wc => wc.getType() === 'webview' && !wc.isDestroyed());
  const visibleGuest = guests.find(wc => wc.getURL() !== '') || guests[0];
  if (visibleGuest) return visibleGuest;

  if (!browserControlWindow || browserControlWindow.isDestroyed()) {
    browserControlWindow = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      title: 'Newmark Browser Control',
      icon: themedAppIconPath(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    browserControlWindow.on('closed', () => { browserControlWindow = null; });
    await browserControlWindow.loadURL('about:blank');
  }
  return browserControlWindow.webContents;
}

async function executeInBrowser<T>(contents: Electron.WebContents, script: string): Promise<T> {
  return await contents.executeJavaScript(script, true) as T;
}

function browserSnapshotScript(maxChars: number): string {
  return `(() => {
    const clone = document.body ? document.body.cloneNode(true) : null;
    if (clone) clone.querySelectorAll('script,style,noscript,svg,canvas').forEach((node) => node.remove());
    const text = (clone ? clone.innerText : document.documentElement.innerText || '')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, ${Math.max(500, Math.min(maxChars, 50000))});
    return { url: location.href, title: document.title || '', text };
  })()`;
}

async function runBrowserControl(request: BrowserControlRequest): Promise<BrowserControlResult> {
  const contents = await ensureBrowserWebContents();
  const action = request.action;
  try {
    if (action === 'open') {
      await contents.loadURL(request.url || 'about:blank');
      await waitForWebContentsLoad(contents);
      const snap = await executeInBrowser<{ url: string; title: string; text: string }>(contents, browserSnapshotScript(request.maxChars || 12000));
      return { ok: true, action, source: contents.getType() === 'webview' ? 'webview-cdp' : 'hidden-cdp', ...snap };
    }
    if (action === 'snapshot') {
      await waitForWebContentsLoad(contents);
      const snap = await executeInBrowser<{ url: string; title: string; text: string }>(contents, browserSnapshotScript(request.maxChars || 12000));
      return { ok: true, action, source: contents.getType() === 'webview' ? 'webview-cdp' : 'hidden-cdp', ...snap };
    }
    if (action === 'click') {
      const data = await executeInBrowser(contents, `(() => {
        const el = document.querySelector(${JSON.stringify(request.selector || '')});
        if (!el) return { clicked: false, error: 'selector not found' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 200) };
      })()`);
      return { ok: true, action, source: contents.getType() === 'webview' ? 'webview-cdp' : 'hidden-cdp', url: contents.getURL(), data };
    }
    if (action === 'type') {
      const data = await executeInBrowser(contents, `(() => {
        const el = document.querySelector(${JSON.stringify(request.selector || '')});
        if (!el) return { typed: false, error: 'selector not found' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        if ('value' in el) {
          el.value = ${JSON.stringify(request.text || '')};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.textContent = ${JSON.stringify(request.text || '')};
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(request.text || '')} }));
        }
        return { typed: true, tag: el.tagName };
      })()`);
      return { ok: true, action, source: contents.getType() === 'webview' ? 'webview-cdp' : 'hidden-cdp', url: contents.getURL(), data };
    }
    if (action === 'eval') {
      const data = await executeInBrowser(contents, request.script || 'undefined');
      return { ok: true, action, source: contents.getType() === 'webview' ? 'webview-cdp' : 'hidden-cdp', url: contents.getURL(), data };
    }
    if (action === 'back') {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      await waitForWebContentsLoad(contents);
      return { ok: true, action, source: contents.getType() === 'webview' ? 'webview-cdp' : 'hidden-cdp', url: contents.getURL() };
    }
    if (action === 'forward') {
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      await waitForWebContentsLoad(contents);
      return { ok: true, action, source: contents.getType() === 'webview' ? 'webview-cdp' : 'hidden-cdp', url: contents.getURL() };
    }
    if (action === 'reload') {
      contents.reload();
      await waitForWebContentsLoad(contents);
      return { ok: true, action, source: contents.getType() === 'webview' ? 'webview-cdp' : 'hidden-cdp', url: contents.getURL() };
    }
    if (action === 'cdp') {
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
      const data = await contents.debugger.sendCommand(request.method || '', (request.params || {}) as Record<string, unknown>);
      return { ok: true, action, source: contents.getType() === 'webview' ? 'webview-cdp' : 'hidden-cdp', url: contents.getURL(), data };
    }
    return { ok: false, action, source: 'desktop', error: `Unsupported browser action: ${action}` };
  } catch (e) {
    return { ok: false, action, source: contents.getType() === 'webview' ? 'webview-cdp' : 'hidden-cdp', url: contents.getURL(), error: e instanceof Error ? e.message : String(e) };
  }
}

function installBrowserControlBackend(): void {
  BrowserControl.setBackend({ run: runBrowserControl });
}
const args = userArgs();
const command = args.find(a => a === 'flow' || a === 'edit');
const isCliArg = args.includes('--cli');
const isServerArg = args.includes('--server');
const isFlowArg = command === 'flow';
const isEditArg = command === 'edit';
const hasCliCommand = args.some(a => (CLI_COMMANDS as readonly string[]).includes(a));

async function drainCliNetworkHandles(): Promise<void> {
  try {
    const { stopComputerUsePowerShellHost } = require('./tools/computerUsePowerShellHost');
    stopComputerUsePowerShellHost();
  } catch {}
  try {
    const undici = require('undici');
    const dispatcher = undici.getGlobalDispatcher?.();
    if (dispatcher?.close) {
      await Promise.race([
        dispatcher.close(),
        new Promise(resolve => setTimeout(resolve, 500)),
      ]);
    }
  } catch {
    // Older Electron/Node builds may not expose undici as a require-able module.
  }
}

function exitCli(code: number): void {
  drainCliNetworkHandles()
    .catch(() => undefined)
    .finally(() => process.exit(code));
}

// CLI/utility mode entry. These paths must work in the packaged exe too.
if (hasCliCommand) {
  (async () => {
    const root = resolveRoot(args);
    firstRunInit(root);
    const handled = await runCliCommand(root, args);
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    exitCli(handled ? code : 1);
  })().catch((e: Error) => {
    console.error('CLI command error:', e.message);
    exitCli(1);
  });
} else if (isFlowArg) {
  (async () => {
    const root = resolveRoot(args);
    firstRunInit(root);
    const { FlowEngine } = require('./core/flow');
    const { runFlow } = require('./core/flow-runner');
    const flowPositionals = positionalAfter(args, 'flow');
    const workflowName = flowPositionals[0];
    if (!workflowName) {
      console.log('Usage: Newmark.exe flow <workflow-name> [start-pc] [--input "text"] [--root <dir>]');
      console.log('Available flows:');
      FlowEngine.listAll(path.join(root, 'Flow')).forEach((n: string) => console.log(`  ${n}`));
      process.exit(1);
    }
    const flowDir = path.join(root, 'Flow');
    const found = FlowEngine.findWorkflow(workflowName, flowDir);
    const workflow = found ? FlowEngine.load(flowDir, found) : null;
    if (!workflow) {
      console.error(`Flow '${workflowName}' not found in ${flowDir}`);
      process.exit(1);
    }
    const agentForFlow = new Agent(root);
    const pcArg = flowPositionals[1];
    const parsedStartPc = pcArg && !pcArg.startsWith('--') ? parseInt(pcArg, 10) : 0;
    const startInput = argValue(args, '--input') || '';
    await runFlow(agentForFlow, workflow, { startPc: Number.isFinite(parsedStartPc) ? parsedStartPc : 0, startInput });
    process.exit(0);
  })().catch((e: Error) => {
    console.error('Flow error:', e.message);
    process.exit(1);
  });
} else if (isEditArg) {
  const fileToEdit = args[args.indexOf('edit') + 1];
  if (!fileToEdit) {
    console.error('Usage: Newmark.exe edit <file.txt|.json|.tex|.md>');
    process.exit(1);
  }
  const { runCliEditor } = require('./cli-editor');
  runCliEditor(fileToEdit);
} else if (isServerArg) {
  app.whenReady().then(() => {
    const root = resolveRoot(args);
    firstRunInit(root);
    const { runServer } = require('./server');
    runServer(root);
  });
} else if (isCliArg || (!app.isPackaged && isTerminal() && !args.includes('--gui'))) {
  (async () => {
    const root = resolveRoot(args);
    firstRunInit(root);
    const { runCli } = require('./cli');
    await runCli(root);
    process.exit(0);
  })();
} else {
  let sidecarProcess: ReturnType<typeof utilityProcess.fork> | null = null;
  const sidecarPassword = randomUUID();
  let createDesktopWindow: ((loadUi?: boolean) => BrowserWindow | null) | null = null;

  async function startSidecar(root: string): Promise<number> {
    const sidecarPath = path.join(__dirname, 'sidecar.js');
    if (!fs.existsSync(sidecarPath)) return 0;
    try {
      sidecarProcess = utilityProcess.fork(sidecarPath, [], {
        env: {
          ...process.env,
          SIDECAR_ROOT: root,
          SIDECAR_PASSWORD: sidecarPassword,
          SIDECAR_HOST: '127.0.0.1',
          SIDECAR_PORT: '0',
        },
      });
      return await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Sidecar timeout')), 10000);
        sidecarProcess!.on('message', (msg: unknown) => {
          const data = msg as { type: string; method: string; result?: { port: number } };
          if (data.type === 'response' && data.method === 'ready' && data.result?.port) {
            clearTimeout(timeout);
            resolve(data.result.port);
          }
        });
        sidecarProcess!.on('exit', (code: number) => {
          clearTimeout(timeout);
          if (code !== 0) reject(new Error(`Sidecar exited: ${code}`));
        });
      });
    } catch {
      return 0;
    }
  }

  const singleInstanceLock = app.requestSingleInstanceLock();
  if (!singleInstanceLock) {
    app.quit();
  } else {
  app.on('second-instance', () => {
    const win = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed()) || null;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    let root = resolveRoot(args);
    const fileRouter = new WorkspaceFileRouter(() => path.resolve(agent?.workspace.current?.path || root));
    protocol.handle('newmark-preview', async request => {
      const resource = await fileRouter.resolvePreview(request.url, request.headers.get('range'));
      return previewResponse(resource, request.method);
    });
    const automationWakeMode = args.includes('--automation-wake');
    const startupMark = Date.now();
    const recordStartup = (stage: string): void => {
      if (!app.isPackaged && process.env.NEWMARK_STARTUP_LOG !== '1') return;
      try {
        fs.appendFileSync(startupLogPath(), `[${new Date().toISOString()}] startup:${stage}:${Date.now() - startupMark}ms\n`, 'utf-8');
      } catch {}
    };
    const syncAutomationWakeSoon = () => {
      setTimeout(() => {
        try {
          if (automationWake && automation) lastWakeSync = automationWake.sync(automation.list());
        } catch (e) {
          lastWakeSync = {
            platform: process.platform,
            active: false,
            nextRunAt: '',
            taskName: automationWake?.taskName() || '',
            registered: false,
            deleted: false,
            skippedReason: e instanceof Error ? e.message : String(e),
          };
        }
      }, 100);
    };
    let startupShellReady: Promise<void> = Promise.resolve();
    const loadDesktopWindowUi = (win: BrowserWindow): void => {
      if (win.isDestroyed()) return;
      const url = win.webContents.getURL();
      if (url && url !== 'about:blank' && !url.startsWith('data:text/html')) return;
      void win.loadFile(path.join(__dirname, 'ui', 'index.html'));
      recordStartup('ui-load-started');
    };
    const loadStartupShell = (win: BrowserWindow): void => {
      if (win.isDestroyed()) return;
      recordStartup('startup-shell-load-started');
      startupShellReady = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(STARTUP_HTML)}`).then(() => {
        recordStartup('startup-shell-loaded');
      });
    };
    const showMainWindow = (): void => {
      const win = mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : (createDesktopWindow ? createDesktopWindow(!!agent) : null);
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    };

    createDesktopWindow = (loadUi = true) => {
      const win = new BrowserWindow({
        width: 1600,
        height: 1000,
        minWidth: 1000,
        minHeight: 650,
        show: false,
        frame: false,
        title: 'Newmark Agent',
        icon: themedAppIconPath(),
        backgroundColor: '#0a0a1a',
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          webviewTag: true,
        },
      });
      const fileRouterOwnerId = String(win.webContents.id);

      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = win;
      if (loadUi) loadDesktopWindowUi(win);
      else loadStartupShell(win);
      win.webContents.on('will-attach-webview', (event, webPreferences) => {
        delete webPreferences.preload;
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.javascript = true;
        webPreferences.allowRunningInsecureContent = false;
      });
      win.webContents.on('did-attach-webview', (_event, contents) => {
        contents.on('will-prevent-unload', event => event.preventDefault());
        contents.setWindowOpenHandler(details => {
          const localPreview = contents.getURL().startsWith('newmark-preview:');
          if (!localPreview && /^https?:/i.test(details.url)) void shell.openExternal(details.url);
          return { action: 'deny' };
        });
        contents.on('will-navigate', (event, url) => {
          if (/^(?:https?:|about:blank|newmark-preview:)/i.test(url)) return;
          event.preventDefault();
        });
      });
      if (!automationWakeMode) {
        win.maximize();
        win.show();
        recordStartup('window-shown');
        syncAutomationWakeSoon();
        if (!app.isPackaged && !args.includes('--no-devtools')) win.webContents.openDevTools({ mode: 'bottom' });
      }

      win.on('close', (e) => {
        if (_forceQuit) return;
        if (agent) {
          const closeBehavior = agent.config.getStr('general', 'close_behavior');
          if (closeBehavior === 'minimize') {
            e.preventDefault();
            win.hide();
            createTray();
            return;
          }
          if (agent.config.getBool('general', 'auto_archive_on_close')) {
            agent.archiveSession();
          }
        }
      });

      win.on('closed', () => {
        fileRouter.revokeOwner(fileRouterOwnerId);
        const remaining = BrowserWindow.getAllWindows().filter(candidate => !candidate.isDestroyed() && candidate !== browserControlWindow);
        if (mainWindow === win) mainWindow = remaining[0] || null;
        if (!remaining.length && sidecarProcess) {
          sidecarProcess.kill();
          sidecarProcess = null;
        }
      });
      return win;
    };

    try {
      firstRunInit(root);
    } catch (e) {
      logStartupFailure(`firstRunInit:${root}`, e);
      const explicitRoot = pathArgValue(args, '--root');
      const fallbackRoot = userRuntimeRoot();
      if (explicitRoot || path.resolve(root) === path.resolve(fallbackRoot)) throw e;
      root = fallbackRoot;
      firstRunInit(fallbackRoot);
    }
    recordStartup('first-run-init');
    if (!automationWakeMode) {
      mainWindow = createDesktopWindow(false);
      createTray();
    }
    void detectWslDistrosAtStartup();

    setTimeout(async () => {
      try {
        await startupShellReady;
        agent = new Agent(root);
        activeAgentBackendMode = process.platform === 'win32' && agent.config.getBool('agent', 'run_in_wsl') ? 'wsl' : 'windows';
        recordStartup('agent-ready');
        automationWake = new AutomationWakeScheduler(root, process.execPath);
        automation = new AutomationManager(agent.config, async (prompt, model) => {
          if (!agent) return '';
          const previousModel = agent.model;
          if (model) agent.setModel(model);
          try {
            const tokens = await agent.process(prompt);
            const text = tokens.map(t => t.text).join('');
            mainWindow?.webContents.send('automation:updated');
            return text;
          } finally {
            if (model) agent.setModel(previousModel);
          }
        });
        agent.setAutomationManager(automation);
        automation.onChange(items => {
          setTimeout(() => {
            try {
              if (automationWake) lastWakeSync = automationWake.sync(items);
            } catch (e) {
              lastWakeSync = {
                platform: process.platform,
                active: false,
                nextRunAt: '',
                taskName: automationWake?.taskName() || '',
                registered: false,
                deleted: false,
                skippedReason: e instanceof Error ? e.message : String(e),
              };
            }
          }, 100);
        });
        if (automationWakeMode) {
          await automation.tick();
          lastWakeSync = automationWake.sync(automation.list());
          automation.stop();
          app.quit();
          return;
        }
        automation.start();
        recordStartup('automation-started');
        syncAutomationWakeSoon();

        try {
          installBrowserControlBackend();
          ensureConversationKernel(root);
          recordStartup('deferred-backends-ready');
        } catch (e) {
          logStartupFailure('deferred-backends', e);
        }
        void startSidecar(root).then(port => {
          if (port > 0) {
            console.log(`[Newmark] Sidecar started on port ${port}`);
          }
          recordStartup('sidecar-ready');
        }).catch(e => logStartupFailure('sidecar-start', e));
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) loadDesktopWindowUi(win);
        }
      } catch (e) {
        logStartupFailure('deferred-desktop-startup', e);
        try {
          const message = e instanceof Error ? e.message : String(e);
          dialog.showErrorBox('Newmark Agent startup failed', `${message}\n\nSee ${startupLogPath()}`);
        } catch {}
        app.exit(1);
      }
    }, 80);

    function refreshNativeThemeIcons(): void {
      const windowIcon = createAppIconImage();
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.setIcon(windowIcon);
      }
      if (tray && !tray.isDestroyed()) tray.setImage(createAppIconImage(16));
    }
    nativeTheme.on('updated', refreshNativeThemeIcons);

    let appExitCleanupStarted = false;
    let appExitCleanupComplete = false;
    app.on('will-quit', event => {
      if (!appExitCleanupComplete && wslAgentClient) {
        event.preventDefault();
        if (!appExitCleanupStarted) {
          appExitCleanupStarted = true;
          const client = wslAgentClient;
          wslAgentClient = null;
          void Promise.race([
            client.stop(),
            new Promise<void>(resolve => setTimeout(() => { client.shutdownNow(); resolve(); }, 2200)),
          ]).finally(() => {
            appExitCleanupComplete = true;
            app.quit();
          });
        }
        return;
      }
      nativeTheme.removeListener('updated', refreshNativeThemeIcons);
      try {
        if (automationWake && automation) lastWakeSync = automationWake.sync(automation.list());
      } catch {}
      automation?.stop();
      if (tray) { tray.destroy(); tray = null; }
      BrowserControl.setBackend(null);
      if (browserControlWindow && !browserControlWindow.isDestroyed()) browserControlWindow.destroy();
      if (sidecarProcess) { sidecarProcess.kill(); sidecarProcess = null; }
      shutdownTerminalTakeoverSessions('app-exit');
    });

    function createTray() {
      if (tray) return;
      tray = new Tray(createAppIconImage(16));
      tray.setToolTip('Newmark Agent');
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Window', click: showMainWindow },
        { type: 'separator' },
        { label: 'Exit', click: () => { _forceQuit = true; tray?.destroy(); tray = null; app.quit(); } },
      ]);
      tray.setContextMenu(contextMenu);
      tray.on('click', showMainWindow);
      tray.on('double-click', showMainWindow);
      refreshNativeThemeIcons();
    }

    const wslBackendEnabled = (): boolean => process.platform === 'win32' && activeAgentBackendMode === 'wsl';
    const ensureWslAgentClient = async (): Promise<WslAgentClient | null> => {
      if (!wslBackendEnabled() || !agent) return null;
      if (!wslAgentClient) {
        const distro = agent.config.getStr('agent', 'wsl_distro') || 'Ubuntu-24.04';
        wslAgentClient = new WslAgentClient(distro, root, ensureWslRuntimeBundle());
        wslAgentClient.subscribe(event => broadcastAgentWorkEvent(event));
        wslAgentClient.subscribeTerminal(event => broadcastTerminalTakeoverEvent(event));
        wslAgentClient.setHostToolHandler(async request => {
          if (request.tool !== 'computer_use') throw new Error(`WSL host tool is not allowed: ${String(request.tool)}`);
          const args = request.args || {};
          const result = await runComputerUse({
            action: String(args.action || ''),
            x: Number(args.x),
            y: Number(args.y),
            scrollX: Number(args.scroll_x || args.scrollX || 0),
            scrollY: Number(args.scroll_y || args.scrollY || 0),
            targetId: String(args.target_id || args.targetId || ''),
            button: String(args.button || ''),
            text: String(args.text || ''),
            key: String(args.key || ''),
            appTarget: String(args.app_target || args.appTarget || ''),
            windowHandle: String(args.window_handle || args.windowHandle || ''),
            durationMs: Number(args.duration_ms || args.durationMs || 0),
            maxChars: Number(args.max_chars || args.maxChars || 30000),
            dryRun: args.dry_run === true || args.dryRun === true,
            allowEphemeralVisionImage: args.allow_ephemeral_vision_image === true || args.allowEphemeralVisionImage === true,
            includeRawUi: args.include_raw_ui === true || args.includeRawUi === true,
            gradientColors: Array.isArray(args.gradient_colors) ? args.gradient_colors.map(String) : undefined,
            gradientSpeed: Number(args.gradient_speed || 0) || undefined,
            gradientWidth: Number(args.gradient_width || 0) || undefined,
            steps: Array.isArray(args.steps) ? args.steps.slice(0, 3).map(stepRaw => {
              const step = stepRaw && typeof stepRaw === 'object' ? stepRaw as Record<string, unknown> : {};
              return {
                action: String(step.action || '') as 'move' | 'click' | 'scroll' | 'wait' | 'app_activate',
                x: Number(step.x),
                y: Number(step.y),
                scrollX: Number(step.scroll_x || step.scrollX || 0),
                scrollY: Number(step.scroll_y || step.scrollY || 0),
                button: String(step.button || 'left'),
                targetId: String(step.target_id || step.targetId || ''),
                appTarget: String(step.app_target || step.appTarget || ''),
                windowHandle: String(step.window_handle || step.windowHandle || ''),
                durationMs: Number(step.duration_ms || step.durationMs || 0),
              };
            }) : undefined,
            workspacePath: agent?.workspace.current?.path || root,
            ownerId: `wsl:${request.context.workspaceId}:${request.context.conversationId}:${request.context.actorId}`,
          });
          try { return JSON.parse(result); } catch { return result; }
        });
      }
      await wslAgentClient.start();
      return wslAgentClient;
    };

    ipcMain.handle('agent:send', async (_event, message: string | AgentPromptMessage, conversationId?: string) => {
      if (!agent) return { tokens: [], error: 'Agent not initialized' };
      try {
        const targetConversation = String(conversationId || agent.activeConversationId || 'default');
        if (wslBackendEnabled()) {
          const client = await ensureWslAgentClient();
          if (!client) return { error: 'WSL Agent backend is enabled but unavailable.' };
          const result = await client.prompt({
            message,
            conversationId: targetConversation,
            options: {
              mode: agent.mode,
              model: agent.model,
              intelligence: agent.intelligence,
              inputMode: agent.inputMode,
              engine: agent.engine,
            },
            queueMode: agent.inputMode === 'guide' ? 'steer' : 'followUp',
            workspace: agent.workspace.current ? {
              name: agent.workspace.current.name,
              path: agent.workspace.current.path,
              isInternal: agent.workspace.current.isInternal,
              kind: agent.workspace.current.kind,
            } : null,
          });
          if ((agent.activeConversationId || 'default') === targetConversation) agent.setConversation(targetConversation);
          return result;
        }
        const kernel = ensureConversationKernel(root);
        if (!kernel) return { tokens: [], error: 'Conversation kernel not initialized' };
        const queueMode = agent.inputMode === 'guide' ? 'steer' : 'followUp';
        const result = await kernel.prompt(message, targetConversation, {
          mode: agent.mode,
          model: agent.model,
          intelligence: agent.intelligence,
          inputMode: agent.inputMode,
          engine: agent.engine,
        }, queueMode);
        const previousConversation = agent.activeConversationId || 'default';
        if (previousConversation === targetConversation) {
          agent.setConversation(targetConversation);
        }
        return {
          tokens: result.tokens,
          diffs: result.diffs,
          mode: result.mode,
          model: result.model,
          status: result.status,
          goal: result.goal,
          options: result.options,
          contextCompression: result.contextCompression,
          contextWindow: result.contextWindow,
          conversationId: targetConversation,
          activeConversationId: agent.activeConversationId || previousConversation,
          conversations: agent.listConversationStates(),
          conversationPlan: result.conversationPlan,
          linkedPlan: result.linkedPlan,
          subagents: result.subagents,
          chatMessages: result.chatMessages,
          historyMessages: result.historyMessages,
          conversationLocked: false,
          queued: result.queued,
        };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    });

    ipcMain.handle('browser:control', async (_event, request: BrowserControlRequest) => {
      return await BrowserControl.run(request);
    });
    ipcMain.handle('flow:run', async (_event, name: string, input = '', start = 0) => {
      if (!agent) return { ok: false, error: 'Agent not initialized' };
      if (agent.mode === 'plan') return { ok: false, error: 'Plan mode is fully read-only; Flow execution is blocked.' };
      const flowDir = path.join(agent.rootPath, 'Flow');
      const found = FlowEngine.findWorkflow(String(name || ''), flowDir);
      if (!found) return { ok: false, error: `Workflow not found: ${name}` };
      const workflow = FlowEngine.load(flowDir, found);
      if (!workflow) return { ok: false, error: `Workflow failed to load: ${found}` };
      const previousMode = agent.mode;
      const previousFlow = agent.flow;
      const previousPc = agent.flowPc;
      try {
        agent.flow = workflow;
        agent.flowPc = Number.isFinite(Number(start)) ? Number(start) : 0;
        await runFlow(agent, workflow, {
          startInput: String(input || ''),
          startPc: agent.flowPc,
          quiet: true,
        });
        return {
          ok: true,
          name: workflow.name,
          mode: agent.mode,
          status: agent.status,
          chatMessages: agent.chatMessages,
          conversations: agent.listConversationStates(),
          conversationId: agent.activeConversationId,
          conversationPlan: agent.getConversationPlan(),
          linkedPlan: agent.getLinkedPlan(),
          subagents: agent.subagents.listAll().map(record => agent!.subagents.toRecord(record.id)).filter(Boolean),
          diffs: agent.fileDiffs.map(d => ({ path: d.path, old: d.oldContent ? d.oldContent.split(/\r?\n/).length : 0, new: d.newContent ? d.newContent.split(/\r?\n/).length : 0 })),
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        agent.flow = previousFlow;
        agent.flowPc = previousPc;
        agent.setMode(previousMode);
      }
    });
    ipcMain.handle('agent:setMode', async (_event, mode: string) => {
      if (agent) {
        agent.setMode(mode as AgentMode);
        resetConversationKernel();
      }
      return agent?.mode;
    });

    ipcMain.handle('agent:setModel', async (_event, model: string) => {
      if (agent) {
        agent.setModel(model);
        resetConversationKernel();
      }
      return agent?.model;
    });

    ipcMain.handle('agent:setIntelligence', async (_event, tier: string) => {
      if (agent) {
        agent.setIntelligence(tier);
        resetConversationKernel();
      }
      return agent?.intelligence;
    });

    ipcMain.handle('agent:setInputMode', async (_event, mode: string) => {
      if (agent) agent.inputMode = mode === 'next' ? 'next' : 'guide';
      return agent?.inputMode;
    });
    ipcMain.handle('agent:setConversation', async (_event, id: string) => {
      return agent?.setConversation(id);
    });
    ipcMain.handle('agent:ensureConversation', async (_event, id: string) => {
      if (!agent) return {};
      return agent.ensureConversationSnapshot(id || agent.activeConversationId || 'default');
    });
    ipcMain.handle('agent:updateGoal', async (_event, goal: string) => {
      if (agent) agent.updateGoal(goal);
      return agent?.goal;
    });

    ipcMain.handle('agent:toggleGoalPause', async () => {
      return agent?.toggleGoalPause();
    });

    ipcMain.handle('agent:getState', async (_event, conversationId?: string) => {
      if (!agent) return {};
      const wslDistros = await availableWslDistros();
      const targetConversation = stateConversationId(conversationId);
      let conversationSnapshot = backendConversationState(targetConversation);
      if (wslBackendEnabled()) {
        try {
          const client = await ensureWslAgentClient();
          if (client) conversationSnapshot = await client.snapshot(targetConversation, agent.workspace.current ? {
            name: agent.workspace.current.name,
            path: agent.workspace.current.path,
            isInternal: agent.workspace.current.isInternal,
            kind: agent.workspace.current.kind,
          } : null);
        } catch (error) {
          conversationSnapshot = { ...conversationSnapshot, wslBackendError: error instanceof Error ? error.message : String(error) };
        }
      }
      return {
        mode: agent.mode,
        model: agent.model,
        modelLabel: agent.modelLabel(),
        intelligence: agent.intelligence,
        ...conversationSnapshot,
        conversationLocked: agent.isConversationLocked(),
        status: agent.status,
        goal: agent.goal,
        models: agent.allModelNames(),
        providers: sanitizeProvidersForState(agent.config.providers()),
        workspaces: { internal: agent.workspace.internal, external: agent.workspace.external, current: agent.workspace.current },
        skills: agent.skills.listDetailed(),
        subagents: conversationSnapshot.subagents,
        fileDiffs: agent.fileDiffs.map(d => ({
          path: d.path,
          oldLength: d.oldContent.length,
          newLength: d.newContent.length,
        })),
        pendingOptions: conversationKernel?.pendingOptions(targetConversation) || agent.pendingOptions,
        proxyEnabled: agent.config.getBool('proxy', 'enabled'),
        proxyUrl: agent.config.getStr('proxy', 'url'),
        proxyAuth: agent.config.getStr('proxy', 'auth'),
        gradientColors: agent.config.get<string[]>('ui', 'gradient_colors') || [],
        gradientSpeed: agent.config.getNum('ui', 'gradient_speed'),
        gradientWidth: agent.config.getNum('ui', 'gradient_width'),
        glassAlpha: agent.config.getNum('ui', 'glass_alpha') || 0.85,
        leftPanelCollapsed: agent.config.getBool('ui', 'left_panel_collapsed'),
        rightPanelCollapsed: agent.config.getBool('ui', 'right_panel_collapsed'),
        bottomPanelCollapsed: agent.config.getBool('ui', 'bottom_panel_collapsed'),
        secondaryPanelCollapsed: agent.config.getBool('ui', 'secondary_panel_collapsed'),
        darkMode: agent.config.getStr('ui', 'dark_mode'),
        minimizeToTray: agent.config.getBool('ui', 'minimize_to_tray'),
        tone: agent.config.getStr('general', 'tone'),
        language: agent.config.getStr('general', 'language'),
        feedback: agent.config.getStr('agent', 'option_feedback'),
        accessPerm: agent.config.getStr('workspace', 'access_permission'),
        promptMode: agent.config.getStr('workspace', 'prompt_mode'),
        skillPolicy: agent.config.getStr('skills', 'auto_download'),
        autoSwitch: agent.config.getBool('models', 'auto_switch'),
        autoSwitchScope: agent.config.getStr('models', 'auto_switch_scope') || 'all',
        fallbackOnUnavailable: agent.config.getBool('models', 'fallback_on_unavailable'),
        openAIApiMode: agent.config.openAIApiMode(),
        autoAdjust: agent.config.getBool('agent', 'auto_adjust_settings'),
        inputMode: agent.inputMode,
        terminalInterruptTimeoutMs: agent.config.getNum('terminal', 'interrupt_timeout_ms'),
        platform: process.platform,
        defaultTerminalShell: resolveTerminalShell(agent.config.getStr('terminal', 'default_shell') || defaultTerminalShell()).id,
        runtimeDefaultTerminalShell: defaultTerminalShell(),
        terminalShells: availableTerminalShells(),
        nativeTools: nativeToolCatalogForState(agent.config.nativeToolEnabled()),
        nativeToolEnabled: agent.config.nativeToolEnabled(),
        automations: automation?.list() || [],
        closeBehavior: agent.config.getStr('general', 'close_behavior'),
        contextCompression: agent.lastCompression,
        contextWindow: agent.contextWindow(),
        agentBackend: wslBackendEnabled()
          ? (wslAgentClient?.status() || { enabled: true, connected: false, distro: agent.config.getStr('agent', 'wsl_distro') || 'Ubuntu-24.04', pid: 0, error: '' })
          : { enabled: false, connected: true, distro: '', pid: process.pid, error: '' },
        configuredAgentBackend: agent.config.getBool('agent', 'run_in_wsl') ? 'wsl' : 'windows',
        agentBackendRestartRequired: (agent.config.getBool('agent', 'run_in_wsl') ? 'wsl' : 'windows') !== activeAgentBackendMode,
        wslAvailable: wslDistros.length > 0,
        wslDistros,
      };
    });

    ipcMain.handle('agent:getConversationPlan', async (_event, conversationId?: string) => {
      if (!agent) return { items: [] };
      return agent.getConversationPlan(conversationId || agent.activeConversationId || 'default');
    });

    ipcMain.handle('agent:updateConversationPlan', async (_event, plan: Record<string, unknown>, conversationId?: string) => {
      if (!agent) return { items: [] };
      await resetWslAgentClient();
      return agent.updateConversationPlan(plan as any, conversationId || agent.activeConversationId || 'default');
    });

    ipcMain.handle('agent:setConversationPinned', async (_event, id: string, pinned: boolean) => {
      if (!agent) return false;
      return agent.setConversationPinned(id, pinned);
    });

    ipcMain.handle('automation:list', async () => {
      return automation?.list() || [];
    });

    ipcMain.handle('automation:wakeStatus', async () => {
      if (automationWake && automation) lastWakeSync = automationWake.sync(automation.list());
      return lastWakeSync;
    });

    ipcMain.handle('automation:create', async (_event, item: Record<string, unknown>) => {
      if (!automation) return { error: 'Automation manager not initialized' };
      const created = automation.create({
        prompt: String(item.prompt || ''),
        model: String(item.model || ''),
        condition: (['once', 'loop', 'schedule'].includes(String(item.condition)) ? String(item.condition) : 'once') as 'once' | 'loop' | 'schedule',
        intervalSec: Number(item.intervalSec || item.interval || 0),
        startAt: String(item.startAt || ''),
        endAt: String(item.endAt || ''),
        active: item.active !== false,
      });
      return created;
    });

    ipcMain.handle('automation:toggle', async (_event, id: string) => {
      return automation?.toggle(id);
    });

    ipcMain.handle('automation:delete', async (_event, id: string) => {
      return automation?.delete(id) || false;
    });

    ipcMain.handle('agent:sendPrompt', async (_event, message: string) => {
      if (!agent) return '';
      const result = await agent.process(message);
      return result.map(t => t.text).join('');
    });

    ipcMain.handle('agent:saveConfig', async (_event, cfg: string | Record<string, unknown>) => {
      if (agent) {
        if (typeof cfg === 'string') {
          fs.writeFileSync(path.join(agent.rootPath, 'config.json'), cfg, 'utf-8');
        } else {
          for (const [key, value] of Object.entries(cfg || {})) {
            switch (key) {
              case 'gradientColors': agent.config.set('ui', 'gradient_colors', value); break;
              case 'gradientSpeed': agent.config.set('ui', 'gradient_speed', value); break;
              case 'gradientWidth': agent.config.set('ui', 'gradient_width', value); break;
              case 'layoutState':
                if (value && typeof value === 'object') {
                  const layout = value as Record<string, unknown>;
                  if (typeof layout.leftCollapsed === 'boolean') agent.config.set('ui', 'left_panel_collapsed', layout.leftCollapsed);
                  if (typeof layout.rightCollapsed === 'boolean') agent.config.set('ui', 'right_panel_collapsed', layout.rightCollapsed);
                  if (typeof layout.bottomCollapsed === 'boolean') agent.config.set('ui', 'bottom_panel_collapsed', layout.bottomCollapsed);
                  if (typeof layout.secondaryCollapsed === 'boolean') agent.config.set('ui', 'secondary_panel_collapsed', layout.secondaryCollapsed);
                }
                break;
              case 'feedbackLevel': agent.config.set('agent', 'option_feedback', value); break;
              case 'language': agent.config.set('general', 'language', value); break;
              case 'autoSwitch': agent.config.set('models', 'auto_switch', value === true || value === 'on'); break;
              case 'autoSwitchScope': agent.config.set('models', 'auto_switch_scope', value === 'provider' ? 'provider' : 'all'); break;
              case 'fallbackOnUnavailable': agent.config.set('models', 'fallback_on_unavailable', value === true || value === 'on'); break;
              case 'switchTendency': agent.config.set('models', 'auto_switch_preference', value); break;
              case 'openAIApiMode': agent.config.set('models', 'openai_api_mode', ['chat_stream', 'chat', 'responses'].includes(String(value)) ? value : 'chat_stream'); break;
              case 'nativeTools': agent.config.set('tools', 'enabled', normalizeNativeToolEnabled(value)); break;
              case 'providers': agent.config.set('models', 'providers', mergeProviderSecrets(value, agent.config.providers())); break;
              case 'defaultFlow': agent.config.set('flow', 'default_flow', value); break;
              case 'dialogStyle': agent.config.set('ui', 'dialog_style', value); break;
              default: agent.config.set('ui', key, value);
            }
          }
          agent.config.save();
        }
        resetConversationKernel();
        return true;
      }
      return false;
    });

    ipcMain.handle('agent:saveSetting', async (_event, section: string, key: string, value: unknown) => {
      if (agent) {
        agent.config.set(section, key, value);
        agent.config.save();
        conversationKernel?.updateSetting(section, key, value);
        return true;
      }
      return false;
    });

    ipcMain.handle('agent:abortConversation', async (_event, conversationId?: string) => {
      if (!agent) return false;
      const target = String(conversationId || agent.activeConversationId || 'default');
      if (wslBackendEnabled()) return !!await wslAgentClient?.abort(target);
      return !!conversationKernel?.abort(target);
    });

    ipcMain.handle('agent:rewindConversation', async (_event, conversationId: string, messageIndex: number) => {
      if (!agent) return { error: 'Agent not initialized' };
      const target = String(conversationId || agent.activeConversationId || 'default');
      try {
        if (wslBackendEnabled()) await resetWslAgentClient();
        const snapshot = conversationKernel
          ? conversationKernel.rewind(target, messageIndex)
          : agent.rewindConversation(target, messageIndex);
        return { ...snapshot, queued: { steering: [], followUp: [] }, workEvents: [] };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle('flow:list', async () => {
      if (!agent) return [];
      return FlowEngine.listAll(path.join(agent.rootPath, 'Flow'));
    });
    ipcMain.handle('flow:read', async (_event, name: string) => {
      if (!agent) return { error: 'Agent not initialized' };
      const cleanName = String(name || '').trim();
      if (!cleanName || cleanName !== path.basename(cleanName) || /[\\/]/.test(cleanName)) return { error: 'Invalid workflow name' };
      const workflow = FlowEngine.load(path.join(agent.rootPath, 'Flow'), cleanName);
      return workflow ? { ok: true, workflow } : { error: `Workflow not found: ${cleanName}` };
    });
    ipcMain.handle('flow:save', async (_event, workflowInput: Record<string, unknown>) => {
      if (!agent) return { error: 'Agent not initialized' };
      if (agent.mode === 'plan') return { error: 'Plan mode is fully read-only; Flow save is blocked.' };
      const name = String(workflowInput?.name || '').trim();
      if (!name || name !== path.basename(name) || /[<>:"/\\|?*]/.test(name)) return { error: 'Invalid workflow name' };
      const workflow = { name, components: Array.isArray(workflowInput?.components) ? workflowInput.components : [] } as any;
      const validation = FlowEngine.validate(workflow);
      if (validation.length) return { error: validation.map(item => item.message).join('; ') };
      const flowDir = path.join(agent.rootPath, 'Flow');
      fs.mkdirSync(flowDir, { recursive: true });
      FlowEngine.save(flowDir, workflow);
      return { ok: true, workflow };
    });

    ipcMain.handle('agent:archive', async (_event, conversationId?: string) => {
      if (!agent) return null;
      const target = String(conversationId || agent.activeConversationId || 'default');
      conversationKernel?.abort(target);
      if (wslBackendEnabled()) await resetWslAgentClient();
      return agent.archiveConversation(target);
    });

    ipcMain.handle('agent:listArchives', async (_event, scope?: string) => {
      return agent?.listArchives(scope === 'all' ? 'all' : 'workspace');
    });

    ipcMain.handle('agent:deleteArchive', async (_event, name: string) => {
      return agent?.deleteArchive(name);
    });

    ipcMain.handle('agent:readArchive', async (_event, name: string) => {
      return agent?.readArchive(name);
    });

    async function listTreeLevel(current: string): Promise<any[]> {
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      const nodes: any[] = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.name.startsWith('node_modules')) continue;
        const fullPath = path.join(current, e.name);
        if (e.isDirectory()) {
          nodes.push({
            name: e.name,
            type: 'directory',
            path: fullPath,
          });
        } else {
          nodes.push({ name: e.name, type: 'file', path: fullPath });
        }
      }
      return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }

    ipcMain.handle('agent:openWorkspaceFile', async (event, filePath: string) => {
      const result = await fileRouter.open(filePath, String(event.sender.id));
      if (result.kind === 'external') {
        const error = await shell.openPath(result.path);
        return error ? { kind: 'rejected', error } : result;
      }
      if (result.kind === 'reveal') {
        shell.showItemInFolder(result.path);
      }
      return result;
    });

    ipcMain.handle('agent:saveWorkspaceFile', async (event, token: string, content: string, expectedRevision: string) => {
      if (agent?.mode === 'plan') return { ok: false, error: 'Plan mode is fully read-only; saveFile is blocked.' };
      return fileRouter.save(token, content, expectedRevision, String(event.sender.id));
    });

    ipcMain.handle('workspace:readPrompt', async () => {
      if (!agent?.workspace.current) return { error: 'No active workspace' };
      const promptPath = path.join(agent.workspace.current.path, 'agent.md');
      try {
        const stat = await fs.promises.stat(promptPath);
        if (stat.size > 256 * 1024) return { error: 'Workspace prompt exceeds 256 KiB.' };
        return { content: await fs.promises.readFile(promptPath, 'utf-8') };
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code || '') : '';
        return code === 'ENOENT' ? { content: '' } : { error: String(error) };
      }
    });

    ipcMain.handle('workspace:savePrompt', async (_event, content: string) => {
      if (!agent?.workspace.current) return { error: 'No active workspace' };
      if (agent.mode === 'plan') return { error: 'Plan mode is fully read-only; workspace prompt save is blocked.' };
      if (Buffer.byteLength(String(content || ''), 'utf8') > 256 * 1024) return { error: 'Workspace prompt exceeds 256 KiB.' };
      const promptPath = path.join(agent.workspace.current.path, 'agent.md');
      try {
        await fs.promises.writeFile(promptPath, String(content || ''), 'utf-8');
        return { ok: true };
      } catch (error) { return { error: String(error) }; }
    });

    ipcMain.handle('agent:getFileTree', async (_event, dirPath: string) => {
      try {
        const workspaceRoot = path.resolve(agent?.workspace.current?.path || root);
        const treeRoot = dirPath ? path.resolve(resolveAppPath(workspaceRoot, dirPath)) : workspaceRoot;
        if (!isPathInside(workspaceRoot, treeRoot)) return { error: 'File tree path is outside the active workspace' };
        const [realWorkspaceRoot, realTreeRoot] = await Promise.all([
          fs.promises.realpath(workspaceRoot).catch(() => workspaceRoot),
          fs.promises.realpath(treeRoot).catch(() => treeRoot),
        ]);
        if (!isPathInside(realWorkspaceRoot, realTreeRoot)) return { error: 'File tree path is outside the active workspace' };
        return await listTreeLevel(treeRoot);
      } catch (e) { return { error: String(e) }; }
    });

    ipcMain.handle('agent:executeBash', async (_event, cmd: string, shell: string, cwd: string) => {
      try {
        return runShellCommand(String(cmd || ''), shell, cwd || agent?.workspace.current?.path || root);
      } catch (e) { return { error: String(e) }; }
    });

    // === Native PTY Terminal ===
    const ptySessions = new Map<string, { proc: ChildProcess; shell: string; buffer: string }>();

    ipcMain.handle('pty:spawn', async (_event, shellId: string) => {
      const sessionId = randomUUID().slice(0, 8);
      const shell = resolveTerminalShell(shellId || agent?.config.getStr('terminal', 'default_shell') || defaultTerminalShell());
      const cwd = agent?.workspace.current?.path || root;
      const proc = spawn(shell.exe, shell.args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TERM: 'xterm-256color' },
        windowsHide: true,
      });
      const session = { proc, shell: shell.id, buffer: '' };
      ptySessions.set(sessionId, session);

      // Wake the PTY without injecting a Windows carriage return into POSIX shells.
      proc.stdin?.write(process.platform === 'win32' && ['powershell', 'pwsh', 'cmd'].includes(shell.id) ? '\r\n' : '\n');

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        session.buffer += text;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pty:data', sessionId, text);
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pty:data', sessionId, text);
        }
      });
      proc.on('exit', (code) => {
        ptySessions.delete(sessionId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pty:exit', sessionId, code);
        }
      });

      return { sessionId, shell: shell.id };
    });

    ipcMain.handle('pty:write', async (_event, sessionId: string, data: string) => {
      const session = ptySessions.get(sessionId);
      if (!session || !session.proc.stdin) return { error: 'Session not found' };
      session.proc.stdin.write(data);
      return { ok: true };
    });

    ipcMain.handle('pty:kill', async (_event, sessionId: string, timeoutMs?: number) => {
      const session = ptySessions.get(sessionId);
      if (session) {
        const waitMs = Math.max(0, Number(timeoutMs ?? agent?.config.getNum('terminal', 'interrupt_timeout_ms') ?? 0));
        if (waitMs === 0) {
          session.proc.kill('SIGINT');
        } else {
          session.proc.kill('SIGINT');
          setTimeout(() => {
            const stillRunning = ptySessions.get(sessionId);
            if (stillRunning && !stillRunning.proc.killed) stillRunning.proc.kill();
            ptySessions.delete(sessionId);
          }, waitMs);
        }
      }
      return { ok: true };
    });

    ipcMain.handle('pty:getBuffer', async (_event, sessionId: string) => {
      const session = ptySessions.get(sessionId);
      if (!session) return { buffer: '' };
      return { buffer: session.buffer };
    });

    const terminalOwnerFor = (conversationId?: string, actorId?: string) => normalizeTerminalTakeoverOwner({
      backend: wslBackendEnabled() ? 'wsl' : (process.platform === 'win32' ? 'windows' : process.platform),
      workspaceId: terminalTakeoverWorkspaceId(agent?.workspace.current?.path || root),
      conversationId: String(conversationId || agent?.activeConversationId || 'default'),
      actorId: String(actorId || ROOT_TERMINAL_ACTOR_ID),
    }, agent?.workspace.current?.path || root);
    const terminalOwnerFilterFor = (conversationId?: string, actorId?: string) => {
      const owner = terminalOwnerFor(conversationId, actorId);
      return actorId ? owner : {
        backend: owner.backend,
        workspaceId: owner.workspaceId,
        conversationId: owner.conversationId,
      };
    };
    const visibleTerminalSessions = (items: ReturnType<typeof terminalTakeoverState>) => items.filter(session =>
      !!session.active || (String(session.stoppedAt || session.updatedAt) && Date.now() - Date.parse(String(session.stoppedAt || session.updatedAt)) < 24 * 60 * 60 * 1000)
    );
    ipcMain.handle('agentTerminal:takeoverState', async (_event, conversationId?: string, actorId?: string) => {
      const owner = terminalOwnerFilterFor(conversationId, actorId);
      if (wslBackendEnabled()) {
        const client = await ensureWslAgentClient();
        return client ? visibleTerminalSessions(await client.terminalState(owner, root)) : [];
      }
      return visibleTerminalSessions(terminalTakeoverState(owner, root));
    });
    ipcMain.handle('agentTerminal:takeoverWrite', async (_event, sessionId: string, data: string, conversationId?: string, actorId?: string) => {
      const owner = terminalOwnerFilterFor(conversationId, actorId);
      if (wslBackendEnabled()) {
        const client = await ensureWslAgentClient();
        return client ? client.terminalWrite(owner, sessionId, data, root) : { ok: false, error: 'WSL Agent backend is unavailable' };
      }
      return writeTerminalTakeoverSession(sessionId, data, owner);
    });
    ipcMain.handle('agentTerminal:takeoverResize', async (_event, sessionId: string, cols: number, rows: number, conversationId?: string, actorId?: string) => {
      const owner = terminalOwnerFilterFor(conversationId, actorId);
      if (wslBackendEnabled()) {
        const client = await ensureWslAgentClient();
        return client ? client.terminalResize(owner, sessionId, cols, rows, root) : { ok: false, error: 'WSL Agent backend is unavailable' };
      }
      return resizeTerminalTakeoverSession(sessionId, cols, rows, owner);
    });
    ipcMain.handle('agentTerminal:takeoverStop', async (_event, sessionId: string, conversationId?: string, actorId?: string) => {
      const owner = terminalOwnerFilterFor(conversationId, actorId);
      if (wslBackendEnabled()) {
        const client = await ensureWslAgentClient();
        return client ? client.terminalStop(owner, sessionId, root) : { ok: false, error: 'WSL Agent backend is unavailable' };
      }
      return stopTerminalTakeoverSession(sessionId, owner);
    });
    ipcMain.handle('agentTerminal:takeoverDetach', async (_event, sessionId: string, conversationId?: string, actorId?: string) => {
      const owner = terminalOwnerFilterFor(conversationId, actorId);
      if (wslBackendEnabled()) {
        const client = await ensureWslAgentClient();
        return client ? client.terminalDetach(owner, sessionId, root) : { ok: false, error: 'WSL Agent backend is unavailable' };
      }
      return detachTerminalTakeoverSession(sessionId, owner);
    });
    onTerminalTakeoverEvent(event => {
      broadcastTerminalTakeoverEvent(event);
    });

    ipcMain.handle('agent:openExternal', async (_event, targetPath: string) => {
      if (agent) {
        try {
          const resolved = path.resolve(targetPath);
          if (fs.existsSync(resolved) && !resolved.startsWith(agent.rootPath)) {
            agent.addExternalWorkspace(resolved);
            return { success: true };
          }
          return { error: 'Path is inside root or does not exist' };
        } catch (e) { return { error: String(e) }; }
      }
      return { error: 'Agent not initialized' };
    });

    ipcMain.handle('agent:selectWorkspace', async (_event, id: string) => {
      if (agent) {
        agent.selectWorkspace(id);
        await resetAgentRuntimes();
        return agent.workspace.current;
      }
      return null;
    });

    ipcMain.handle('agent:createWorkspace', async (_event, name?: string) => {
      if (agent) {
        const created = agent.createInternalWorkspace(name);
        await resetAgentRuntimes();
        return created;
      }
      return null;
    });

    ipcMain.handle('agent:createExternalWorkspace', async (_event, name: string, dirPath: string) => {
      if (agent) {
        const created = agent.addExternalWorkspace(dirPath);
        await resetAgentRuntimes();
        return created;
      }
      return null;
    });

    ipcMain.handle('ssh:listConnections', async () => {
      if (!agent) return [];
      return agent.listSshConnections();
    });

    ipcMain.handle('ssh:saveConnection', async (_event, input: Record<string, unknown>) => {
      if (!agent) return { ok: false, error: 'Agent not initialized' };
      try {
        const connection = agent.saveSshConnection({
          id: String(input.id || '').trim() || undefined,
          name: String(input.name || '').trim() || undefined,
          host: String(input.host || '').trim() || undefined,
          port: Number(input.port || 22),
          user: String(input.user || '').trim() || undefined,
          identityFile: String(input.identity_file || input.identityFile || '').trim() || undefined,
          remoteRoot: String(input.remote_root || input.remoteRoot || '').trim() || undefined,
          enabled: input.enabled !== false,
        });
        return { ok: true, connection };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });

    ipcMain.handle('ssh:deleteConnection', async (_event, id: string) => {
      if (!agent) return false;
      return agent.deleteSshConnection(id);
    });

    ipcMain.handle('ssh:validateConnection', async (_event, id: string, remoteRoot?: string) => {
      if (!agent) return { ok: false, error: 'Agent not initialized' };
      return agent.validateSshConnection(id, remoteRoot);
    });

    ipcMain.handle('ssh:createWorkspace', async (_event, input: Record<string, unknown>) => {
      if (!agent) return { ok: false, error: 'Agent not initialized' };
      const result = agent.createSshWorkspace({
        connectionId: String(input.connection_id || input.connectionId || '').trim() || undefined,
        name: String(input.name || '').trim() || undefined,
        remotePath: String(input.remote_path || input.remotePath || input.remote_root || input.remoteRoot || '').trim(),
        connection: {
          id: String(input.connection_id || input.connectionId || input.id || '').trim() || undefined,
          name: String(input.connection_name || input.connectionName || input.name || '').trim() || undefined,
          host: String(input.host || '').trim() || undefined,
          port: Number(input.port || 22),
          user: String(input.user || '').trim() || undefined,
          identityFile: String(input.identity_file || input.identityFile || '').trim() || undefined,
          remoteRoot: String(input.remote_root || input.remoteRoot || '').trim() || undefined,
          enabled: true,
        },
      });
      if (result.ok) await resetAgentRuntimes();
      return result;
    });

    ipcMain.handle('agent:deleteWorkspace', async (_event, name: string) => {
      if (agent) {
        const removed = agent.removeWorkspace(name);
        await resetAgentRuntimes();
        return removed;
      }
      return false;
    });

    ipcMain.handle('agent:setWorkspacePinned', async (_event, id: string, pinned: boolean) => {
      if (!agent) return null;
      return agent.workspace.setPinned(id, pinned);
    });

    ipcMain.handle('dialog:selectFolder', async () => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select workspace folder',
      });
      if (result.canceled || !result.filePaths.length) return null;
      return result.filePaths[0];
    });

    ipcMain.handle('agent:validateModels', async (_event, selected?: string[]) => {
      if (agent) return agent.validateModels(selected);
      return [];
    });

    ipcMain.handle('agent:fuzzyInject', async (_event, name: string, url: string, key: string, protocol?: string) => {
      if (agent) {
        return agent.fuzzyInject(name, url, key, protocol === 'anthropic' ? 'anthropic' : protocol === 'openai' ? 'openai' : undefined);
      }
      return { ok: false, warning: 'Agent not ready' };
    });

    ipcMain.handle('github:copilotLogin', async () => {
      if (!agent) return { ok: false, error: 'Agent not ready' };
      const currentAgent = agent;
      const cwd = agent.workspace.current?.path || root;
      const runGh = (args: string[], timeout: number, windowsHide: boolean) => {
        const result = spawnSync('gh', args, {
          cwd,
          encoding: 'utf-8',
          timeout,
          windowsHide,
          env: process.env,
        });
        return {
          args,
          status: result.status,
          error: result.error,
          output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
        };
      };
      const tokenFromGh = () => {
        const tokenResult = spawnSync('gh', ['auth', 'token'], {
          cwd,
          encoding: 'utf-8',
          timeout: 30000,
          windowsHide: true,
          env: process.env,
        });
        const token = String(tokenResult.stdout || '').trim();
        return {
          status: tokenResult.status,
          error: tokenResult.error,
          output: `${tokenResult.stdout || ''}${tokenResult.stderr || ''}`.trim(),
          token,
        };
      };
      const importToken = async (token: string, authOutput = '') => {
        currentAgent.config.upsertProvider('GitHub Copilot', 'https://models.github.ai', token, 'github_models');
        let catalogModels = 0;
        let savedModels = 0;
        let fallbackAdded = false;
        let catalogWarning = '';
        try {
          const listed = await new LLMProvider('GitHub Copilot', 'https://models.github.ai', token, 'github_models', currentAgent.config.openAIApiMode()).listModels();
          catalogModels = listed.length;
          for (const modelName of listed) {
            if (currentAgent.config.addModelToProvider('GitHub Copilot', modelName, modelName, 'Listed by GitHub Models catalog after browser login.')) {
              savedModels += 1;
            }
          }
        } catch (error) {
          catalogWarning = error instanceof Error ? error.message : String(error);
        }
        if (catalogModels === 0) {
          currentAgent.config.addModelToProvider('GitHub Copilot', 'openai/gpt-4.1', 'GPT-4.1 (GitHub Models)', 'GitHub Models fallback candidate; catalog refresh failed during login.');
          fallbackAdded = true;
        }
        currentAgent.config.save();
        return {
          ok: true,
          provider: 'GitHub Copilot',
          endpoint: 'https://models.github.ai',
          hasToken: true,
          imported: catalogModels > 0,
          catalogModels,
          modelsImported: savedModels,
          fallbackAdded,
          warning: catalogWarning,
          output: authOutput,
        };
      };
      const ghStatus = runGh(['auth', 'status'], 30000, true);
      if (ghStatus.status === 0) {
        const existingToken = tokenFromGh();
        if (!existingToken.error && existingToken.status === 0 && existingToken.token) {
          return await importToken(existingToken.token, 'Imported existing GitHub CLI token. If GitHub Models rejects the token, run GitHub Copilot login again to refresh models:read scope.');
        }
      }
      const authAttempts = ghStatus.status === 0
        ? [
            ['auth', 'refresh', '--scopes', 'models:read'],
            ['auth', 'login', '--web', '--scopes', 'models:read'],
          ]
        : [
            ['auth', 'login', '--web', '--scopes', 'models:read'],
          ];
      const authResults: ReturnType<typeof runGh>[] = [];
      let authOk = false;
      for (const authArgs of authAttempts) {
        const authResult = runGh(authArgs, 300000, false);
        authResults.push(authResult);
        if (!authResult.error && authResult.status === 0) {
          authOk = true;
          break;
        }
      }
      if (!authOk) {
        await shell.openExternal('https://github.com/login/device');
        const last = authResults[authResults.length - 1];
        const output = authResults.map(r => `gh ${r.args.join(' ')} exited ${r.error ? r.error.message : r.status}\n${r.output}`.trim()).join('\n\n');
        return {
          ok: false,
          webFallback: true,
          error: last?.error?.message || `gh ${last?.args.join(' ') || 'auth'} exited ${last?.status ?? 'unknown'}`,
          output,
        };
      }

      const tokenResult = tokenFromGh();
      const token = tokenResult.token;
      if (tokenResult.error) {
        await shell.openExternal('https://github.com/login/device');
        return { ok: false, webFallback: true, error: tokenResult.error.message };
      }
      if (tokenResult.status !== 0 || !token) {
        await shell.openExternal('https://github.com/login/device');
        return { ok: false, webFallback: true, error: `gh auth token exited ${tokenResult.status}` };
      }

      return await importToken(token);
    });

    ipcMain.handle('agent:editorComplete', async (_event, request: Record<string, unknown>) => {
      return agent?.editorModelRequest({ ...request, completion: true, preferCopilot: false } as any) || { ok: false, text: '', error: 'Agent not initialized' };
    });

    ipcMain.handle('agent:editorAssist', async (_event, request: Record<string, unknown>) => {
      return agent?.editorModelRequest({ ...request, completion: false } as any) || { ok: false, text: '', error: 'Agent not initialized' };
    });

    ipcMain.handle('skills:list', async () => {
      if (!agent) return [];
      return agent.skills.listDetailed();
    });

    ipcMain.handle('skills:market', async () => {
      if (!agent) return [];
      return agent.skills.discoverMarketAsync();
    });

    ipcMain.handle('skills:marketSources', async () => {
      if (!agent) return [];
      return agent.skills.listMarketSources();
    });

    ipcMain.handle('skills:addMarketSource', async (_event, input: Record<string, unknown>) => {
      if (!agent) return { ok: false, error: 'Agent not ready' };
      try {
        const source = agent.skills.addMarketSource({
          id: typeof input?.id === 'string' ? input.id : undefined,
          name: typeof input?.name === 'string' ? input.name : '',
          type: typeof input?.type === 'string' ? input.type as any : undefined,
          url: typeof input?.url === 'string' ? input.url : undefined,
          path: typeof input?.path === 'string' ? input.path : undefined,
          enabled: typeof input?.enabled === 'boolean' ? input.enabled : undefined,
        });
        return { ok: true, source, sources: agent.skills.listMarketSources() };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });

    ipcMain.handle('skills:removeMarketSource', async (_event, idOrName: string) => {
      if (!agent) return { ok: false, error: 'Agent not ready' };
      const ok = agent.skills.removeMarketSource(idOrName);
      return { ok, sources: agent.skills.listMarketSources() };
    });

    ipcMain.handle('skills:setMarketSourceEnabled', async (_event, idOrName: string, enabled: boolean) => {
      if (!agent) return { ok: false, error: 'Agent not ready' };
      const ok = agent.skills.setMarketSourceEnabled(idOrName, enabled);
      return { ok, sources: agent.skills.listMarketSources() };
    });

    ipcMain.handle('skills:download', async (_event, name: string, url: string) => {
      if (!agent) return { error: 'Agent not ready' };
      const result = await agent.skills.download(name, url);
      agent.refreshSkills();
      return { ok: result.includes('Downloaded'), result };
    });

    ipcMain.handle('skills:installLocal', async (_event, sourceDir: string, targetName?: string) => {
      if (!agent) return { ok: false, error: 'Agent not ready' };
      const ok = agent.skills.installFromLocal(sourceDir, targetName);
      agent.refreshSkills();
      return { ok };
    });

    ipcMain.handle('skills:setEnabled', async (_event, name: string, enabled: boolean) => {
      if (!agent) return false;
      const ok = agent.skills.setEnabled(name, enabled);
      agent.refreshSkills();
      return ok;
    });

    ipcMain.handle('skills:remove', async (_event, name: string) => {
      if (!agent) return false;
      const ok = agent.skills.remove(name);
      agent.refreshSkills();
      return ok;
    });

    ipcMain.handle('skills:refresh', async () => {
      if (!agent) return [];
      agent.refreshSkills();
      return agent.skills.listDetailed();
    });

    ipcMain.handle('memoryLab:read', async (_event, selector?: string) => {
      if (!agent) return { ok: false, error: 'Agent not ready' };
      return agent.memoryLab.read(selector || '');
    });

    ipcMain.handle('memoryLab:update', async (_event, input: Record<string, unknown>) => {
      if (!agent) return { ok: false, error: 'Agent not ready' };
      try {
        return await agent.updateMemoryLab({
          name: String(input.name || ''),
          description: String(input.description || ''),
          tags: Array.isArray(input.tags) ? input.tags.map(String) : String(input.tags || '').split(/[,，\n]+/),
          content: String(input.content || ''),
          kind: input.kind === 'folder' ? 'folder' : 'file',
        });
      } catch (e) {
        const read = agent.memoryLab.read();
        return { ...read, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });

    ipcMain.handle('memoryLab:reindex', async () => {
      if (!agent) return { ok: false, error: 'Agent not ready' };
      return agent.reindexMemoryLab();
    });

    ipcMain.handle('update:version', async () => {
      return { ok: true, version: currentAppVersion(), root };
    });

    ipcMain.handle('update:checkGithub', async (_event, input: Record<string, unknown> = {}) => {
      return checkGitHubUpdate(String(input.repo || ''), String(input.tag || ''), String(input.asset || ''));
    });

    ipcMain.handle('update:applyGithub', async (_event, input: Record<string, unknown> = {}) => {
      return applyGitHubUpdate({
        repo: String(input.repo || ''),
        tag: String(input.tag || ''),
        asset: String(input.asset || ''),
        target: String(input.target || root),
        expectedVersion: String(input.expectedVersion || ''),
        dryRun: input.dryRun !== false,
      });
    });

    ipcMain.handle('update:installLocal', async (_event, input: Record<string, unknown> = {}) => {
      return installUpdate({
        source: String(input.source || ''),
        target: String(input.target || root),
        targetFile: typeof input.targetFile === 'string' ? input.targetFile : undefined,
        expectedVersion: typeof input.expectedVersion === 'string' ? input.expectedVersion : undefined,
        preserve: Array.isArray(input.preserve) ? input.preserve.map(String) : undefined,
        dryRun: input.dryRun !== false,
      });
    });

    ipcMain.handle('github:gh', async (_event, argv: string[] = []) => {
      const safeArgs = Array.isArray(argv) ? argv.map(String).filter(a => a.length < 400) : [];
      try {
        const result = spawnSync('gh', safeArgs, {
          cwd: agent?.workspace.current?.path || root,
          encoding: 'utf-8',
          timeout: 60000,
          windowsHide: true,
          env: { ...process.env },
        });
        return {
          ok: result.status === 0,
          status: result.status,
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          command: `gh ${safeArgs.join(' ')}`,
        };
      } catch (e) {
        return { ok: false, status: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e), command: `gh ${safeArgs.join(' ')}` };
      }
    });

    ipcMain.handle('sidecar:status', async () => {
      return { running: sidecarProcess !== null };
    });

    ipcMain.handle('sidecar:restart', async () => {
      if (sidecarProcess) {
        sidecarProcess.kill();
        sidecarProcess = null;
      }
      const root = resolveRoot(args);
      const port = await startSidecar(root);
      return { port, status: port > 0 ? 'started' : 'failed' };
    });

    ipcMain.handle('app:minimize', () => {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      const minimizeToTray = agent?.config.getBool('ui', 'minimize_to_tray') ?? true;
      if (minimizeToTray) {
        win?.hide();
      } else {
        win?.minimize();
      }
    });
    ipcMain.handle('app:maximize', () => {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      if (win?.isMaximized()) win.unmaximize();
      else win?.maximize();
    });
    ipcMain.handle('app:close', () => {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      const closeBehavior = agent?.config.getStr('general', 'close_behavior');
      if (closeBehavior === 'minimize') {
        win?.hide();
      } else {
        win?.close();
      }
    });
    ipcMain.handle('wsl:backendStatus', async () => {
      if (!agent) return { enabled: false, connected: false, distro: '', pid: 0, error: 'Agent not initialized' };
      if (!wslBackendEnabled()) return { enabled: false, connected: false, distro: agent.config.getStr('agent', 'wsl_distro') || 'Ubuntu-24.04', pid: 0, error: '' };
      try {
        const client = await ensureWslAgentClient();
        return client?.status();
      } catch (error) {
        return { enabled: true, connected: false, distro: agent.config.getStr('agent', 'wsl_distro') || 'Ubuntu-24.04', pid: 0, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle('wsl:backendTest', async () => {
      if (!agent) return { ok: false, error: 'Agent not initialized' };
      try {
        const client = await ensureWslAgentClient();
        return { ok: !!client, ...(client?.status() || {}) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle('app:lifecycleState', () => ({
      trayActive: !!tray && !tray.isDestroyed(),
      windowExists: !!mainWindow && !mainWindow.isDestroyed(),
      windowVisible: !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible(),
      windowMinimized: !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized(),
    }));
    ipcMain.handle('app:drag', () => {
      // Window drag is handled by the renderer
    });
    if (agent && mainWindow && !mainWindow.isDestroyed()) loadDesktopWindowUi(mainWindow);
  }).catch((e: Error) => {
    logStartupFailure('desktop-startup', e);
    try {
      dialog.showErrorBox('Newmark Agent startup failed', `${e.message}\n\nSee ${startupLogPath()}`);
    } catch {}
    app.exit(1);
  });
  }
}

app.on('window-all-closed', () => {
  if (isServerArg) return;
  if (process.platform !== 'darwin') app.quit();
});
