import { app, BrowserWindow, ipcMain, dialog, utilityProcess, Tray, Menu, nativeImage, nativeTheme, webContents, shell, protocol, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { createHash, randomUUID } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { Agent, ConversationBranchLocator, FlowSuspensionRecord } from './core/agent';
import { AgentMode, AgentWorkEvent, ConversationInputEnvelope } from './core/types';
import { AgentPromptMessage, ConversationKernel, ConversationTargetInput } from './core/conversationKernel';
import { ConversationRuntimeTarget, NormalizedConversationTarget, conversationStateWorkspacePrefix, normalizeConversationTarget } from './core/conversationTarget';
import { AutomationManager } from './core/automation';
import { AutomationWakeScheduler, WakeSyncResult } from './core/automationWake';
import { BrowserControl, BrowserControlRequest, BrowserControlResult, BrowserControlTarget } from './core/browserControl';
import { bindBrowserUseRequest, BrowserUse, BrowserUseEngine, BrowserUseReceipt } from './core/browserUse';
import { NativeBrowserUsePageAdapter } from './core/browserUsePageAdapter';
import { ElectronBrowserUseHost } from './core/electronBrowserUseHost';
import { FlowEngine } from './core/flow';
import { FlowCompletedResult, FlowQuestionPendingError, runFlow } from './core/flow-runner';
import { CLI_COMMANDS, cliCommandHelp, cliHelpRequested, runCliCommand } from './cli-commands';
import { invalidTopLevelArgument, isVersionArgument, unknownTopLevelCommand } from './cli-discovery';
import { sanitizeProvidersForState } from './core/config';
import { MemoryLabManager } from './core/memoryLab';
import { applyGitHubUpdate, checkGitHubUpdate, currentAppVersion, executeManagedMsiInstall, installUpdate, planManagedMsiInstall } from './core/installUpdate';
import { pairingQrDataUrl, pairingStatus, pairingTokenPath, tailscaleIpv4 } from './core/mobilePairing';
import {
  detachTerminalTakeoverSession,
  normalizeTerminalTakeoverOwner,
  onTerminalTakeoverEvent,
  resizeTerminalTakeoverSession,
  ROOT_TERMINAL_ACTOR_ID,
  shutdownTerminalTakeoverSessions,
  spawnTakeoverPty,
  stopTerminalTakeoverSession,
  TakeoverPty,
  terminalTakeoverState,
  terminalTakeoverWorkspaceId,
  writeTerminalTakeoverSession,
} from './tools/terminalTakeover';
import { executeWorkspaceBash, NativeBashSession } from './core/nativeBash';
import { isNativeToolEnabled, nativeToolCatalogForState, normalizeNativeToolEnabled } from './tools/nativeTools';
import { LLMProvider } from './llm/provider';
import { WslAgentClient, WslHostToolHandler } from './core/wslAgentClient';
import { WslHostToolRequest } from './core/wslAgentProtocol';
import { previewResponse, WorkspaceFileRouter } from './core/workspaceFileRouter';
import { normalizeUiBackgroundColor, normalizeUiFontFamily, normalizeUiTheme } from './core/uiPreferences';
import { configPatchAffectsConversationRuntime } from './core/configRuntimeImpact';
import { PdfPreviewServer } from './core/pdfPreviewServer';
import { WorkspaceSelectionCoordinator } from './core/workspaceSelectionCoordinator';
import { ElectronUtilityRuntimePool } from './core/electronUtilityRuntimePool';
import { shutdownWindowsProcessHelpers } from './core/electronUtilityAgentClient';
import { WslAgentRuntimePool } from './core/wslAgentRuntimePool';
import { createUtilityHostToolHandler } from './core/utilityHostToolRouter';
import {
  runStartupPrewarmBarrier,
  scheduleDeferredStartupTasks,
  StartupPrewarmProgress,
  startupUpdatePromptContent,
} from './core/startupPrewarm';
import { runRuntimeShutdownBarrier } from './core/runtimeShutdown';
import { markRuntimeLifecycleClean } from './core/runtimeLifecycle';
import { discoverPluginManifests } from './core/compat';
import { discoverDshCompatibility, installDshBundle, setDshBundleEnabled, uninstallDshBundle } from './core/dshCompatibility';
import { McpManager } from './core/mcpManager';
import { WorkEventCoalescer } from './core/workEventCoalescer';
import { newmarkEditHelpText, newmarkFlowHelpText, newmarkHelpText } from './cli-help';

const APP_NAME = 'Newmark Agent';
const APP_ID = 'ai.newmark.agent';
const CONFIG_RELOAD_RUNTIME_TIMEOUT_MS = 6_000;

protocol.registerSchemesAsPrivileged([{
  scheme: 'newmark-preview',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

app.setName(APP_NAME);
for (const startupSwitch of [
  'disable-background-networking',
  'disable-component-update',
  'disable-default-apps',
  'disable-sync',
  'no-first-run',
]) {
  app.commandLine.appendSwitch(startupSwitch);
}
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

let mainWindow: BrowserWindow | null = null;
let agent: Agent | null = null;
let conversationKernel: ConversationKernel | null = null;

// Flow takeover is strictly conversation-local state. Every conversation owns
// its own running flow / suspension / abort controller, keyed by runtimeKey.
// Nothing about a Flow is global: switching conversations never surfaces or
// mutates another conversation's Flow state.
interface ActiveFlowState {
  workflow: NonNullable<Agent['flow']>;
  input: string;
  componentId: number;
  completedResults: FlowCompletedResult[];
  previousMode: AgentMode;
  previousFlow: Agent['flow'];
  previousPc: number;
  /** '' while running; 'question' or 'interrupted' only while suspended. */
  reason: '' | 'question' | 'interrupted';
  message?: string;
  target: ConversationRuntimeTarget;
  /** Non-null only while actively running; null while suspended. */
  abortController: AbortController | null;
  name: string;
  flowAgent: Agent | null;
  /** Archive won the lifecycle race; the settling Flow must not recreate state. */
  archiveRequested?: boolean;
}
const activeFlowsByRuntimeKey = new Map<string, ActiveFlowState>();

function activeFlowStateKey(target: ConversationRuntimeTarget): string {
  return normalizeConversationTarget(target).runtimeKey;
}

function activeFlowStateFor(target: ConversationRuntimeTarget): ActiveFlowState | null {
  return activeFlowsByRuntimeKey.get(activeFlowStateKey(target)) || null;
}
let wslAgentClient: WslAgentClient | null = null;
let electronUtilityRuntimePool: ElectronUtilityRuntimePool | null = null;
let wslAgentRuntimePool: WslAgentRuntimePool | null = null;
let activeAgentBackendMode: 'windows' | 'wsl' = 'windows';
let automation: AutomationManager | null = null;
let automationWake: AutomationWakeScheduler | null = null;
let lastWakeSync: WakeSyncResult | null = null;
let mcpManager: McpManager | null = null;
let tray: Tray | null = null;
let _forceQuit = false;
let forcedExitTimer: NodeJS.Timeout | null = null;
let electronBrowserUseHost: ElectronBrowserUseHost | null = null;
let browserUseEngine: BrowserUseEngine | null = null;
const mobileServerWorkEventSubscribers = new Set<(event: AgentWorkEvent) => void>();
// A single renderer can host several hidden conversation-bound guests. The
// legacy host map is retained for focused-window discovery, while this map is
// the authoritative Browser-Use/right-sidebar binding.
const browserGuestContentsByHost = new Map<number, number>();
const browserGuestBindingsByRuntime = new Map<string, { hostId: number; guestId: number; workspaceId: string; conversationId: string }>();
const browserGuestKeyboardBridgeIds = new Set<number>();

function browserGuestRuntimeKey(target: ConversationRuntimeTarget): string {
  return normalizeConversationTarget(target).runtimeKey;
}

function browserGuestBindingFor(runtimeKey: string): { hostId: number; guestId: number; workspaceId: string; conversationId: string } | null {
  const binding = browserGuestBindingsByRuntime.get(String(runtimeKey || ''));
  if (!binding) return null;
  const guest = webContents.fromId(binding.guestId);
  if (!guest || guest.isDestroyed() || guest.getType() !== 'webview' || guest.hostWebContents?.id !== binding.hostId) {
    browserGuestBindingsByRuntime.delete(String(runtimeKey || ''));
    if (browserGuestContentsByHost.get(binding.hostId) === binding.guestId) browserGuestContentsByHost.delete(binding.hostId);
    return null;
  }
  return binding;
}
let workspaceSwitchGeneration = 0;
let workspaceSelectionCoordinator: WorkspaceSelectionCoordinator<string, ReturnType<Agent['selectWorkspace']>> | null = null;

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

async function runShellCommand(command: string, shellId: string, cwd: string): Promise<{ output?: string; error?: string; engine?: string }> {
  const shellInfo = resolveTerminalShell(shellId || defaultTerminalShell());
  if (shellInfo.id === 'bash') {
    const result = await executeWorkspaceBash(command, cwd, { cwd, allowHostFallback: true });
    return { output: result.output, error: result.error, engine: result.engine };
  }
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

interface AsyncCommandResult {
  status: number;
  stdout: string;
  stderr: string;
  error: string;
}

function runCommandAsync(command: string, args: string[], cwd: string, timeoutMs = 30000): Promise<AsyncCommandResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (status: number, error = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        error,
      });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(-1, `${command} timed out after ${timeoutMs} ms`);
    }, timeoutMs);
    child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', error => finish(-1, error.message));
    child.once('close', code => finish(typeof code === 'number' ? code : -1));
  });
}

async function runJsonCommand(command: string, args: string[], cwd: string, timeoutMs = 30000): Promise<{ ok: boolean; data: unknown; error: string }> {
  const result = await runCommandAsync(command, args, cwd, timeoutMs);
  if (result.error || result.status !== 0) {
    return { ok: false, data: null, error: String(result.stderr || result.error || `${command} exited ${result.status}`).trim() };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout || 'null'), error: '' };
  } catch {
    return { ok: false, data: null, error: `${command} returned invalid JSON.` };
  }
}

let wslDistroCache: { at: number; items: string[] } = { at: 0, items: [] };
let wslDetection: Promise<string[]> | null = null;

function decodeWslDistros(raw: Buffer): string[] {
  const utf16 = raw.toString('utf16le').split('\0').join('').trim();
  const text = utf16 && /[A-Za-z0-9]/.test(utf16) ? utf16 : raw.toString('utf8').split('\0').join('').trim();
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

function availableWslDistros(): string[] {
  if (process.platform !== 'win32') return [];
  return wslDistroCache.items.slice();
}

async function resetWslAgentClient(): Promise<void> {
  if (wslAgentClient) await wslAgentClient.resetAgent();
}

function dispatchAgentWorkEvent(event: unknown, mirrorToMobile = true): void {
  const workEvent = event as Partial<AgentWorkEvent>;
  if ((workEvent.type === 'done' || workEvent.type === 'error') && workEvent.runtimeKey) {
    browserUseEngine?.clearRuntime(workEvent.runtimeKey);
    electronBrowserUseHost?.clear({ runtimeKey: workEvent.runtimeKey, owner: '' });
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('agent:workEvent', event);
  }
  if (mirrorToMobile) {
    for (const listener of mobileServerWorkEventSubscribers) {
      try { listener(event as AgentWorkEvent); } catch { /* ignore disconnected mobile bridge */ }
    }
  }
}

const workEventCoalescer = new WorkEventCoalescer(event => dispatchAgentWorkEvent(event, true));
const workEventNoMobileCoalescer = new WorkEventCoalescer(event => dispatchAgentWorkEvent(event, false));

function broadcastAgentWorkEvent(event: unknown, mirrorToMobile = true): void {
  const workEvent = event as AgentWorkEvent;
  // Response and thought deltas are coalesced at the IPC/SSE boundary; all
  // lifecycle/tool events retain immediate ordering.
  if (workEvent.type === 'text' || workEvent.type === 'thought_delta') {
    (mirrorToMobile ? workEventCoalescer : workEventNoMobileCoalescer).push(workEvent);
    return;
  }
  workEventCoalescer.flushAll();
  workEventNoMobileCoalescer.flushAll();
  dispatchAgentWorkEvent(event, mirrorToMobile);
}

function ensureConversationKernel(root: string): ConversationKernel | null {
  if (!agent) return null;
  if (!conversationKernel) {
    conversationKernel = new ConversationKernel(root, agent, automation);
    conversationKernel.subscribe(event => broadcastAgentWorkEvent(event));
  }
  return conversationKernel;
}

function persistedFlowSuspensionRecord(suspension: ActiveFlowState, message = ''): ReturnType<Agent['getStoredFlowSuspension']> {
  return {
    workflowName: suspension.workflow.name,
    componentId: suspension.componentId,
    input: String(suspension.input || ''),
    completedResults: Array.isArray(suspension.completedResults) ? suspension.completedResults : [],
    previousMode: suspension.previousMode,
    reason: suspension.reason === '' ? 'interrupted' : suspension.reason,
    message: String(message || suspension.message || ''),
    target: suspension.target ? {
      workspaceId: suspension.target.workspaceId,
      conversationId: suspension.target.conversationId,
      workspace: suspension.target.workspace ? {
        id: suspension.target.workspace.id,
        name: suspension.target.workspace.name,
        path: suspension.target.workspace.path,
        isInternal: suspension.target.workspace.isInternal,
        kind: suspension.target.workspace.kind,
        conversationStatePrefix: suspension.target.workspace.conversationStatePrefix,
      } : null,
    } : undefined,
    options: suspension.reason === 'question'
      ? (suspension.flowAgent?.pendingOptions || agent?.pendingOptions || []).map(question => ({
          question: String(question.question || ''),
          options: (question.options || []).map(option => ({ label: String(option.label || ''), description: option.description })),
        }))
      : undefined,
    updatedAt: new Date().toISOString(),
  };
}

function ensureWorkspaceSelectionCoordinator(): WorkspaceSelectionCoordinator<string, ReturnType<Agent['selectWorkspaceFromStorage']>> | null {
  if (!agent) return null;
  if (!workspaceSelectionCoordinator) {
    workspaceSelectionCoordinator = new WorkspaceSelectionCoordinator<string, ReturnType<Agent['selectWorkspaceFromStorage']>>({
      keyOf: value => String(value || '').trim(),
      // Utility/WSL runtimes own target conversation persistence. A renderer
      // switch must refresh the host view without saving its older snapshot.
      apply: async value => agent?.selectWorkspaceFromStorage(value) || null,
      failureThreshold: 2,
      failureWindowMs: 10_000,
      circuitOpenMs: 5_000,
    });
    if (agent.workspace.current) workspaceSelectionCoordinator.setCurrent(agent.workspace.current.id || agent.workspace.current.path || agent.workspace.current.name);
  }
  return workspaceSelectionCoordinator;
}

function conversationRuntimeTarget(requested?: ConversationTargetInput | { target?: ConversationTargetInput }): ConversationRuntimeTarget {
  let raw: ConversationTargetInput | undefined;
  if (requested && typeof requested === 'object' && 'target' in requested) raw = requested.target;
  else raw = requested as ConversationTargetInput | undefined;
  const requestedWorkspaceId = typeof raw === 'object' && raw ? String(raw.workspaceId || '').trim() : '';
  const allWorkspaces = agent
    ? [agent.workspace.current, ...agent.workspace.internal, ...agent.workspace.external].filter(Boolean)
    : [];
  const requestedMatches = requestedWorkspaceId
    ? allWorkspaces.filter(item => item!.id === requestedWorkspaceId || item!.path === requestedWorkspaceId || item!.name === requestedWorkspaceId)
    : [];
  const noWorkspaceRequested = requestedMatches.length === 0 && (requestedWorkspaceId === 'none' || requestedWorkspaceId === 'no-workspace');
  const identityMatch = requestedMatches.find(item => item!.id === requestedWorkspaceId || item!.path === requestedWorkspaceId);
  const workspace = (noWorkspaceRequested ? null : requestedWorkspaceId
    ? (identityMatch || (requestedMatches.length === 1 ? requestedMatches[0] : null))
    : agent?.workspace.current) || null;
  if (requestedWorkspaceId && !workspace && !noWorkspaceRequested) throw new Error(`Unknown workspace: ${requestedWorkspaceId}`);
  const conversationId = typeof raw === 'string'
    ? raw
    : (raw && typeof raw === 'object' ? raw.conversationId : '') || agent?.activeConversationId || 'default';
  return {
    workspaceId: workspace?.id || (noWorkspaceRequested ? 'none' : requestedWorkspaceId) || workspace?.path || 'none',
    conversationId: String(conversationId || 'default'),
    workspace: workspace ? {
      id: workspace.id || workspace.path,
      name: workspace.name || workspace.path,
      path: workspace.path,
      isInternal: workspace.isInternal,
      kind: workspace.kind,
      conversationStatePrefix: conversationStateWorkspacePrefix(workspace),
    } : undefined,
  };
}

const FALLBACK_TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAhklEQVQ4T2NkYPj/n4EBBJgYKAQMDAwM//79Y2RkZGQYmpqMgYGBgYEhJSWFgYGBAaoRAkZGRoZ///4x/Pr1CyrKwAhVwMDw798/BgYGBqgCRqgCBgaoKEYGBgYGqAJGqAIGSJQzMDAw/P79m4GRkZGBkZGRgaSADg0NZWBgYGCYOnUq8QENUQADAC3oSsHtAAAAAElFTkSuQmCC';

function appAssetPath(fileName: string): string {
  return path.join(__dirname, '..', 'assets', fileName);
}

function isStartupShellUrl(value: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'file:'
      && path.basename(new URL(value).pathname) === 'startup.html';
  } catch {
    return false;
  }
}

function relayFlowAgentWorkEvents(flowAgent: Agent, target: ConversationRuntimeTarget): () => void {
  return flowAgent.subscribeWorkEvents(event => {
    broadcastAgentWorkEvent({
      ...event,
      conversationId: target.conversationId,
      workspaceId: target.workspaceId,
      workspaceKey: target.workspaceKey,
      runtimeKey: target.runtimeKey,
    });
  });
}

function themedAppIconPath(): string {
  // Fixed black-on-white icon across every theme: the titlebar, taskbar, tray,
  // and Windows executable all share the same dark icon asset.
  const compactPath = path.join(__dirname, 'assets', 'app-icon-dark-64.png');
  return fs.existsSync(compactPath) ? compactPath : appAssetPath('app-icon-dark.png');
}

function createAppIconImage(size?: number) {
  const image = nativeImage.createFromPath(themedAppIconPath());
  const icon = image.isEmpty() ? nativeImage.createFromDataURL(FALLBACK_TRAY_ICON) : image;
  return size ? icon.resize({ width: size, height: size }) : icon;
}

function userArgs(): string[] {
  const args = process.argv.slice(1);
  // The native Windows console wrapper inserts Electron's `--` boundary before
  // user arguments. Electron leaves that boundary in process.argv; normalize it
  // before command discovery so the literal `Newmark.exe help` path terminates.
  return args[0] === '--' ? args.slice(1) : args;
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
function firstRunInit(root: string, options: { readOnly?: boolean } = {}): void {
  fs.mkdirSync(root, { recursive: true });
  for (const d of ['skills', 'Work', 'Flow', 'archive', 'Memory Lab']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  new MemoryLabManager(root);

  const configModule = require('./core/config');
  configModule.ensureRootConfig(root, options);
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

function ensureElectronUtilityRuntimeHost(): string {
  const packagedHost = path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'conversation-utility-host.bundle.cjs');
  const developmentHost = path.join(app.getAppPath(), 'dist', 'conversation-utility-host.bundle.cjs');
  const host = app.isPackaged ? packagedHost : developmentHost;
  if (!fs.existsSync(host)) throw new Error(`Electron utility Agent runtime host is missing: ${host}`);
  return host;
}

function legacyUserDataRoot(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Newmark Agent');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Newmark Agent');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Newmark Agent');
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

function resolveTuiWorkspacePath(args: string[], root: string): string {
  const explicitWorkspace = pathArgValue(args, '--workspace');
  if (explicitWorkspace) return explicitWorkspace;
  // An explicitly isolated runtime must not silently register the caller's
  // cwd as an external workspace. Keep the opt-in --workspace escape hatch,
  // while making the safe one-argument form fully self-contained.
  return pathArgValue(args, '--root') ? root : process.cwd();
}

// Set immediately after argument resolution so startup failures from an
// explicit temporary root are recorded beside that root instead of leaking a
// diagnostic file into the user's canonical runtime.
let startupRuntimeRoot = '';

function startupLogPath(): string {
  try {
    const userData = startupRuntimeRoot || userRuntimeRoot();
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

function setWindowsConsoleMode(mode?: number): number | null {
  if (process.platform !== 'win32') return null;
  const setMode = Number.isInteger(mode);
  const script = [
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class NewmarkConsoleMode { [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n); [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint mode); [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint mode); }\'',
    // 输出句柄（STD_OUTPUT_HANDLE = -11）必须启用 ENABLE_VIRTUAL_TERMINAL_PROCESSING(0x4)，
    // 否则 TUI 的备用屏 ?1049h / 清屏 2J 等 ANSI 序列在 ConHost/传统控制台下不被解析，
    // 主屏保留滚动历史（滚轮能滚回旧帧），光标追踪也随之错位。
    '$out = [NewmarkConsoleMode]::GetStdHandle(-11)',
    '$outMode = [uint32]0',
    'if (-not [NewmarkConsoleMode]::GetConsoleMode($out, [ref]$outMode)) { exit 2 }',
    setMode
      ? `$target = [uint32]${mode}; if (-not [NewmarkConsoleMode]::SetConsoleMode($out, $target)) { exit 3 }`
      : 'if (-not [NewmarkConsoleMode]::SetConsoleMode($out, ($outMode -bor 4))) { exit 3 }',
    // 输入句柄（STD_INPUT_HANDLE = -10）启用 ENABLE_VIRTUAL_TERMINAL_INPUT(0x200)，
    // 清除 line/echo 让方向键等原始序列可读。
    '$inp = [NewmarkConsoleMode]::GetStdHandle(-10)',
    '$inpMode = [uint32]0',
    'if ([NewmarkConsoleMode]::GetConsoleMode($inp, [ref]$inpMode)) { [NewmarkConsoleMode]::SetConsoleMode($inp, (($inpMode -band (-bnot 7)) -bor 512)) | Out-Null }',
    'Write-Output $outMode',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  if (setMode) return mode ?? null;
  const parsed = Number.parseInt(String(result.stdout || '').trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
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

function registeredBrowserGuest(hostContentsId?: number, runtimeKey?: string): Electron.WebContents | null {
  if (runtimeKey) {
    const binding = browserGuestBindingFor(runtimeKey);
    if (binding && (!hostContentsId || binding.hostId === hostContentsId)) {
      const guest = webContents.fromId(binding.guestId);
      if (guest && !guest.isDestroyed()) return guest;
    }
  }
  const hostIds = hostContentsId
    ? [hostContentsId]
    : [
      BrowserWindow.getFocusedWindow()?.webContents.id || 0,
      mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : 0,
      ...browserGuestContentsByHost.keys(),
    ];
  for (const hostId of hostIds) {
    if (!hostId) continue;
    const guestId = browserGuestContentsByHost.get(hostId);
    if (!guestId) continue;
    const guest = webContents.fromId(guestId);
    if (guest && !guest.isDestroyed() && guest.getType() === 'webview' && guest.hostWebContents?.id === hostId) {
      if (runtimeKey) {
        const bound = browserGuestBindingsByRuntime.get(runtimeKey);
        if (!bound || bound.hostId !== hostId || bound.guestId !== guest.id) continue;
      }
      return guest;
    }
    browserGuestContentsByHost.delete(hostId);
  }
  return null;
}

async function boundedOperation<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function registerBrowserGuest(host: Electron.WebContents, guest: Electron.WebContents, requestedTarget?: ConversationTargetInput): boolean {
  if (host.isDestroyed() || guest.isDestroyed() || guest.getType() !== 'webview' || guest.hostWebContents?.id !== host.id) return false;
  let target: NormalizedConversationTarget;
  try {
    target = normalizeConversationTarget(conversationRuntimeTarget(requestedTarget));
  } catch {
    return false;
  }
  const prior = browserGuestBindingsByRuntime.get(target.runtimeKey);
  if (prior && prior.guestId !== guest.id) {
    const priorGuest = webContents.fromId(prior.guestId);
    if (priorGuest && !priorGuest.isDestroyed()) priorGuest.hostWebContents?.send('browser:guestVisibility', { runtimeKey: target.runtimeKey, visible: false });
  }
  browserGuestBindingsByRuntime.set(target.runtimeKey, {
    hostId: host.id,
    guestId: guest.id,
    workspaceId: target.workspaceId,
    conversationId: target.conversationId,
  });
  browserGuestContentsByHost.set(host.id, guest.id);
  if (!browserGuestKeyboardBridgeIds.has(guest.id)) {
    browserGuestKeyboardBridgeIds.add(guest.id);
    // WebView keyboard events do not bubble to the host renderer. Reserve only
    // the two app-wide discovery surfaces and leave navigation/editing keys to
    // the page itself.
    guest.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat || host.isDestroyed()) return;
      const key = String(input.key || '').toLowerCase();
      const noSecondaryModifiers = !input.alt && !input.control && !input.meta && !input.shift;
      let commandId = '';
      if (key === 'f1' && noSecondaryModifiers) commandId = 'help.keyboardShortcuts';
      else if (key === 'p' && (input.control || input.meta) && input.shift && !input.alt) commandId = 'app.commandPalette';
      if (!commandId) return;
      event.preventDefault();
      host.send('keyboard:command', { id: commandId, source: 'browserGuest' });
    });
  }
  guest.once('destroyed', () => {
    browserGuestKeyboardBridgeIds.delete(guest.id);
    if (browserGuestContentsByHost.get(host.id) === guest.id) browserGuestContentsByHost.delete(host.id);
    const binding = browserGuestBindingsByRuntime.get(target.runtimeKey);
    if (binding?.guestId === guest.id) browserGuestBindingsByRuntime.delete(target.runtimeKey);
  });
  ensureElectronBrowserUseHost().attach(guest);
  return true;
}

async function waitForRegisteredBrowserGuest(host: Electron.WebContents, runtimeKey?: string, timeoutMs = 12_000): Promise<Electron.WebContents> {
  const deadline = Date.now() + Math.max(250, timeoutMs);
  while (!host.isDestroyed() && Date.now() < deadline) {
    const guest = registeredBrowserGuest(host.id, runtimeKey);
    if (guest) return guest;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Built-in Browser guest did not become ready before the Browser-Use timeout');
}

async function ensureBrowserWebContents(boundContentsId?: number, runtimeKey?: string): Promise<Electron.WebContents> {
  if (boundContentsId) {
    const bound = webContents.fromId(boundContentsId);
    if (bound && !bound.isDestroyed() && bound.getType() === 'webview'
      && browserGuestContentsByHost.get(bound.hostWebContents?.id || 0) === bound.id) {
      if (runtimeKey) {
        const binding = browserGuestBindingsByRuntime.get(runtimeKey);
        if (!binding || binding.guestId !== bound.id) return await ensureBrowserWebContents(undefined, runtimeKey);
      }
      bound.hostWebContents?.send('browser:ensureGuest');
      return bound;
    }
  }
  const registered = registeredBrowserGuest(undefined, runtimeKey);
  if (registered) {
    registered.hostWebContents?.send('browser:ensureGuest');
    return registered;
  }

  const hostWindow = BrowserWindow.getFocusedWindow()
    || (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
  const host = hostWindow?.webContents;
  if (!host || host.isDestroyed()) throw new Error('Built-in Browser UI is unavailable');
  host.send('browser:ensureGuest', runtimeKey ? { runtimeKey } : undefined);
  return await waitForRegisteredBrowserGuest(host, runtimeKey, 12_000);
}

function ensureElectronBrowserUseHost(): ElectronBrowserUseHost {
  if (!electronBrowserUseHost) {
    electronBrowserUseHost = new ElectronBrowserUseHost({
      resolveContents: async (scope, boundContentsId) => await ensureBrowserWebContents(boundContentsId, scope.runtimeKey),
      openExternal: async url => { await shell.openExternal(url); },
    });
  }
  return electronBrowserUseHost;
}

function ensureBrowserUseEngine(): BrowserUseEngine {
  if (!browserUseEngine) {
    const adapter = new NativeBrowserUsePageAdapter(scope => ensureElectronBrowserUseHost().resolve(scope));
    browserUseEngine = new BrowserUseEngine(adapter);
  }
  return browserUseEngine;
}

function currentBrowserUseContext(requestedTarget?: ConversationTargetInput): { runtimeKey: string; actorId: string } {
  const target = normalizeConversationTarget(conversationRuntimeTarget(requestedTarget));
  return { runtimeKey: target.runtimeKey, actorId: agent?.runtimeActorId || ROOT_TERMINAL_ACTOR_ID };
}

function browserControlTargetInput(input?: BrowserControlTarget): ConversationTargetInput | undefined {
  if (!input) return undefined;
  return {
    workspaceId: String(input.workspaceId || ''),
    conversationId: String(input.conversationId || 'default'),
  } as ConversationRuntimeTarget;
}

async function runBoundBrowserUse(input: unknown, context: { runtimeKey: string; actorId: string }, signal?: AbortSignal): Promise<BrowserUseReceipt> {
  return await ensureBrowserUseEngine().run(bindBrowserUseRequest(input, context), signal);
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
  const action = request.action;
  const requestedTarget = browserControlTargetInput(request.target);
  const target = normalizeConversationTarget(conversationRuntimeTarget(requestedTarget));
  if (action === 'use') {
    const receipt = await runBoundBrowserUse(request.browserUse, currentBrowserUseContext(requestedTarget));
    return {
      ok: receipt.ok,
      action,
      source: 'native-browser-use',
      url: receipt.url,
      title: receipt.title,
      data: receipt,
      error: receipt.error,
    };
  }
  const contents = await ensureBrowserWebContents(undefined, target.runtimeKey);
  try {
    if (action === 'open') {
      await contents.loadURL(request.url || 'about:blank');
      await waitForWebContentsLoad(contents);
      const snap = await executeInBrowser<{ url: string; title: string; text: string }>(contents, browserSnapshotScript(request.maxChars || 12000));
      return { ok: true, action, source: 'webview-cdp', ...snap };
    }
    if (action === 'snapshot') {
      await waitForWebContentsLoad(contents);
      const snap = await executeInBrowser<{ url: string; title: string; text: string }>(contents, browserSnapshotScript(request.maxChars || 12000));
      return { ok: true, action, source: 'webview-cdp', ...snap };
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
      return { ok: true, action, source: 'webview-cdp', url: contents.getURL(), data };
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
      return { ok: true, action, source: 'webview-cdp', url: contents.getURL(), data };
    }
    if (action === 'eval') {
      const data = await executeInBrowser(contents, request.script || 'undefined');
      return { ok: true, action, source: 'webview-cdp', url: contents.getURL(), data };
    }
    if (action === 'back') {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      await waitForWebContentsLoad(contents);
      return { ok: true, action, source: 'webview-cdp', url: contents.getURL() };
    }
    if (action === 'forward') {
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      await waitForWebContentsLoad(contents);
      return { ok: true, action, source: 'webview-cdp', url: contents.getURL() };
    }
    if (action === 'reload') {
      contents.reload();
      await waitForWebContentsLoad(contents);
      return { ok: true, action, source: 'webview-cdp', url: contents.getURL() };
    }
    if (action === 'cdp') {
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
      const data = await contents.debugger.sendCommand(request.method || '', (request.params || {}) as Record<string, unknown>);
      return { ok: true, action, source: 'webview-cdp', url: contents.getURL(), data };
    }
    return { ok: false, action, source: 'desktop', error: `Unsupported browser action: ${action}` };
  } catch (e) {
    return { ok: false, action, source: 'webview-cdp', url: contents.getURL(), error: e instanceof Error ? e.message : String(e) };
  }
}

function installBrowserControlBackend(): void {
  const engine = ensureBrowserUseEngine();
  BrowserUse.setBackend(engine);
  BrowserControl.setBackend({ run: runBrowserControl });
}
const args = userArgs();
const command = args.find(a => a === 'flow' || a === 'edit');
const isTuiArg = args.some(arg => arg.toLowerCase() === '--tui');
const hasCliCommand = args.some(a => (CLI_COMMANDS as readonly string[]).includes(a));
const cliCommand = args.find(a => (CLI_COMMANDS as readonly string[]).includes(a));
const isFlowArg = command === 'flow';
const isEditArg = command === 'edit';
const isHelpArg = !hasCliCommand && (args.some(arg => ['--help', '-h'].includes(arg.toLowerCase())) || args[0]?.toLowerCase() === 'help');
const isVersionArg = !hasCliCommand && isVersionArgument(args);
const isReadOnlyValidation = hasCliCommand && args.includes('validate-models') && !args.includes('--persist');
const isViewerArg = args.some(arg => arg.toLowerCase() === '--newmark-viewer');
const isCliArg = args.includes('--cli');
const isServerArg = args.includes('--server');

const invalidArgument = invalidTopLevelArgument(args);
if (invalidArgument) {
  console.error(`Invalid Newmark argument: ${invalidArgument}`);
  process.exit(2);
}

// Keep command-specific help on the same early-exit path as top-level help.
// This matters for the packaged Electron entry: a command such as
// `send --help` must never create a GUI window, start prewarm work, or touch a
// user-data profile merely to print its contract.
if (hasCliCommand && cliCommand && cliHelpRequested(args)) {
  console.log(cliCommandHelp(cliCommand));
  process.exit(0);
}

// Electron's Chromium profile is a separate state boundary from Newmark's
// business root. Bind both before any ready event so --root cannot leave
// Preferences, DIPS, DevTools ports, cookies, or session storage in the real
// default AppData directory. The dedicated subdirectories keep Chromium's
// files separate from the durable Newmark config/workspace files.
const runtimeRoot = resolveRoot(args);
startupRuntimeRoot = runtimeRoot;
const explicitElectronUserDataRoot = pathArgValue(args, '--user-data-dir');
const electronUserDataRoot = path.resolve(explicitElectronUserDataRoot || path.join(runtimeRoot, 'Electron'));
const electronSessionDataRoot = path.join(electronUserDataRoot, 'session-data');
try {
  fs.mkdirSync(electronSessionDataRoot, { recursive: true });
  app.setPath('userData', electronUserDataRoot);
  app.setPath('sessionData', electronSessionDataRoot);
  // app.setPath is the Electron API contract; the switch makes the same
  // boundary visible to Chromium children, including the console-wrapper
  // `--` forwarding path where an early child may otherwise retain the default
  // profile before the first BrowserWindow is created.
  app.commandLine.removeSwitch('user-data-dir');
  app.commandLine.appendSwitch('user-data-dir', electronUserDataRoot);
} catch (error) {
  console.error(`Unable to isolate Electron user-data directory: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// Help/version are terminating discovery commands. They must be handled
// before Electron's GUI/TUI/server branches can initialize runtime state or
// spawn a window, so a product-new tester can use them safely in any surface.
if (isHelpArg) {
  console.log(isFlowArg ? newmarkFlowHelpText() : isEditArg ? newmarkEditHelpText() : newmarkHelpText(currentAppVersion()));
  process.exit(0);
}
if (isVersionArg) {
  console.log(currentAppVersion());
  process.exit(0);
}
const unknownCommand = app.isPackaged && !hasCliCommand && !isTuiArg && !isCliArg && !isServerArg && !isViewerArg
  ? unknownTopLevelCommand(args)
  : undefined;
if (unknownCommand) {
  console.error(`Unknown Newmark command or argument: ${unknownCommand}. Run --help to see the supported entrypoints.`);
  process.exit(2);
}

function viewerEscape(value: unknown): string {
  return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || character);
}

function viewerDocument(request: any): string {
  const title = viewerEscape(request?.title || request?.caption || (request?.type === 'memory-overview' ? 'Memory Lab Overview' : '示意图'));
  const image = request?.type === 'image' && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/i.test(String(request?.dataUrl || ''))
    ? `<img src="${viewerEscape(request.dataUrl)}" alt="${title}">`
    : '<div class="empty">Image unavailable</div>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${title}</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#090d16;color:#dce8f7;font:12px system-ui,sans-serif}main{height:100%;display:grid;grid-template-rows:auto 1fr;padding:14px;gap:10px}header{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#a8bdd4}section{min-height:0;display:flex;align-items:center;justify-content:center;border:1px solid #233044;border-radius:10px;background:#0d1420}img{display:block;max-width:100%;max-height:100%;object-fit:contain}svg{width:100%;height:100%}.edges line{stroke:#30435b;stroke-width:1;opacity:.62}text{fill:#9fb2c7;font-size:9px}.empty{color:#6f8196}</style></head><body><main><header>${title}</header><section>${image}</section></main></body></html>`;
}

async function createViewerWindow(request: unknown): Promise<BrowserWindow> {
  const viewerRequest = request && typeof request === 'object' ? request as Record<string, unknown> : {};
  const windowTitle = String(viewerRequest.title || viewerRequest.caption || (viewerRequest.type === 'memory-overview' ? 'Memory Lab Overview' : '示意图')).trim().slice(0, 160) || '示意图';
  const win = new BrowserWindow({ width: 760, height: 600, minWidth: 420, minHeight: 320, show: false, autoHideMenuBar: true, title: windowTitle, backgroundColor: '#090d16', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  if (viewerRequest.type === 'memory-overview') {
    await win.loadFile(path.join(__dirname, 'ui', 'index.html'), {
      query: { newmarkViewer: 'memory-overview', viewerTitle: windowTitle },
    });
    const encodedRequest = Buffer.from(JSON.stringify(viewerRequest), 'utf8').toString('base64');
    await win.webContents.executeJavaScript(`window.openMemoryLabOverviewViewer(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encodedRequest}'), function(c) { return c.charCodeAt(0); }))));`);
  } else {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(viewerDocument(request))}`);
  }
  win.setTitle(windowTitle);
  win.show();
  return win;
}

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
if (isViewerArg) {
  app.whenReady().then(async () => {
    const root = resolveRoot(args);
    const requestPath = path.resolve(String(pathArgValue(args, '--viewer-request') || ''));
    const relative = path.relative(path.resolve(root), requestPath);
    if (!requestPath || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Viewer request must stay inside the Newmark runtime root.');
    const stat = fs.statSync(requestPath);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Viewer request is invalid or too large.');
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    try { fs.unlinkSync(requestPath); } catch {}
    await createViewerWindow(request);
  }).catch(error => { console.error(`Unable to open Newmark viewer: ${error instanceof Error ? error.message : String(error)}`); app.quit(); });
} else if (isTuiArg) {
  const isConsoleLauncher = app.isPackaged && (
    path.basename(process.execPath).toLowerCase() === 'newmark.exe'
    || path.basename(process.execPath).toLowerCase() === 'newmark console runtime.exe'
    || process.env.NEWMARK_CONSOLE_WRAPPER === '1'
  );
  if (isConsoleLauncher && process.env.NEWMARK_TUI_SIDECAR !== '1') {
    // Console mode is shared by every process attached to the same console:
    // enable output VT processing (and input VT) before spawning the sidecar so
    // the TUI's ?1049h alternate-screen sequence is actually parsed by ConHost /
    // traditional consoles. The sidecar also re-applies it defensively below.
    setWindowsConsoleMode();
    const tuiProcess = spawnSync(process.execPath, [path.join(__dirname, 'launcher.js'), ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NEWMARK_TUI_SIDECAR: '1',
        // The GUI Electron host does not expose the inherited ConPTY handles
        // as Node TTY streams. The console wrapper has already established
        // that this is the terminal entrypoint, so preserve the terminal
        // contract for the sidecar without weakening ordinary GUI launches.
        NEWMARK_FORCE_TTY: isConsoleLauncher ? '1' : process.env.NEWMARK_FORCE_TTY,
      },
      stdio: 'inherit',
      windowsHide: false,
    });
    if (tuiProcess.error) {
      console.error(`Unable to start packaged Newmark TUI: ${tuiProcess.error.message}`);
      process.exit(1);
    }
    process.exit(tuiProcess.status ?? 1);
  }
  const originalConsoleMode = app.isPackaged ? setWindowsConsoleMode() : null;
  if (originalConsoleMode !== null) {
    process.env.NEWMARK_FORCE_TTY = '1';
    process.once('exit', () => {
      setWindowsConsoleMode(originalConsoleMode);
    });
  }
  const root = resolveRoot(args);
  firstRunInit(root);
  const { start } = require('./tui/src/app');
  start({ root, workspacePath: resolveTuiWorkspacePath(args, root), desktopDist: __dirname });
} else if (hasCliCommand) {
  (async () => {
    const root = resolveRoot(args);
    firstRunInit(root, { readOnly: isReadOnlyValidation });
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
  let sidecarPort = 0;
  const sidecarPassword = randomUUID();
  let startupWindow: BrowserWindow | null = null;
  let startupAttempt = 0;
  let startupAttemptPromise: Promise<{ ok: boolean; error?: string }> | null = null;
  let createDesktopWindow: ((loadUi?: boolean, showWindow?: boolean, attemptId?: number) => BrowserWindow | null) | null = null;
  let showDesktopWindow: (() => void) | null = null;

  async function startSidecar(root: string): Promise<number> {
    if (sidecarProcess && sidecarPort > 0) return sidecarPort;
    const sidecarPath = path.join(__dirname, 'sidecar.js');
    if (!fs.existsSync(sidecarPath)) return 0;
    try {
      const spawnedSidecar = utilityProcess.fork(sidecarPath, [], {
        env: {
          ...process.env,
          SIDECAR_ROOT: root,
          SIDECAR_PASSWORD: sidecarPassword,
          SIDECAR_HOST: '127.0.0.1',
          SIDECAR_PORT: '0',
        },
      });
      sidecarProcess = spawnedSidecar;
      return await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          try { spawnedSidecar.kill(); } catch {}
          reject(new Error('Sidecar timeout'));
        }, 10000);
        let ready = false;
        spawnedSidecar.on('message', (msg: unknown) => {
          const data = msg as { type: string; method: string; result?: { port: number } };
          if (data.type === 'response' && data.method === 'ready' && data.result?.port) {
            clearTimeout(timeout);
            ready = true;
            sidecarPort = data.result.port;
            resolve(sidecarPort);
          }
        });
        spawnedSidecar.on('exit', (code: number) => {
          clearTimeout(timeout);
          if (sidecarProcess === spawnedSidecar) {
            sidecarProcess = null;
            sidecarPort = 0;
          }
          if (!ready && code !== 0) reject(new Error(`Sidecar exited: ${code}`));
        });
      });
    } catch {
      try { sidecarProcess?.kill(); } catch {}
      sidecarProcess = null;
      sidecarPort = 0;
      return 0;
    }
  }

  const allowMultipleInstances = args.includes('--allow-multiple-instances');
  // Test and isolated diagnostic windows must not participate in Electron's
  // global single-instance coordination at all. Requesting the lock and then
  // ignoring failure still notifies/focuses the production instance.
  const singleInstanceLock = allowMultipleInstances || app.requestSingleInstanceLock();
  if (!singleInstanceLock && !allowMultipleInstances) {
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
      if (win.webContents.isCrashed()) win.reload();
      return;
    }
    showDesktopWindow?.();
    if (!showDesktopWindow) {
      app.whenReady().then(() => showDesktopWindow?.()).catch(error => logStartupFailure('second-instance-window-recovery', error));
    }
  });

  app.whenReady().then(async () => {
    let root = resolveRoot(args);
    let workspaceRegistryWatcher: fs.FSWatcher | null = null;
    let workspaceRegistryWatchTimer: NodeJS.Timeout | null = null;
    const workspaceRegistryFiles = new Set(['Local.json', 'External.json', 'State.json']);
    const broadcastWorkspaceChanged = (files: string[]): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send('workspace:changed', { files, root });
      }
    };
    const refreshWorkspaceRegistryFromDisk = (files: string[]): void => {
      if (!agent) return;
      agent.refreshWorkspaceRegistryFromStorage();
      const current = agent.workspace.current;
      if (current) workspaceSelectionCoordinator?.setCurrent(current.id || current.path || current.name);
      broadcastWorkspaceChanged(files);
    };
    const ensureWorkspaceRegistryWatcher = (): void => {
      if (workspaceRegistryWatcher) return;
      const workDir = path.join(root, 'Work');
      try {
        workspaceRegistryWatcher = fs.watch(workDir, { persistent: false }, (_eventType, filename) => {
          const changed = String(filename || '');
          if (changed && !workspaceRegistryFiles.has(path.basename(changed))) return;
          if (workspaceRegistryWatchTimer) clearTimeout(workspaceRegistryWatchTimer);
          workspaceRegistryWatchTimer = setTimeout(() => {
            workspaceRegistryWatchTimer = null;
            try {
              refreshWorkspaceRegistryFromDisk(changed ? [path.basename(changed)] : ['Work']);
            } catch (error) {
              logStartupFailure('workspace-registry-refresh', error);
            }
          }, 90);
        });
      } catch (error) {
        logStartupFailure('workspace-registry-watch', error);
      }
    };
    const fileRouter = new WorkspaceFileRouter(() => path.resolve(agent?.workspace.current?.path || root));
    const pdfPreviewServer = new PdfPreviewServer((token, ownerId) => fileRouter.resolvePdfCapability(token, ownerId));
    await pdfPreviewServer.start();
    app.once('will-quit', () => {
      void pdfPreviewServer.close();
    });
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
    const REQUIRED_STARTUP_UI_HYDRATION = ['state', 'rendered'] as const;
    type StartupUiReadyPayload = { attemptId: number; hydrated?: Record<string, unknown>; error?: string };
    type StartupUiWaiter = {
      attemptId: number;
      promise: Promise<StartupUiReadyPayload>;
      resolve: (payload: StartupUiReadyPayload) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    };
    const startupUiWaiters = new Map<number, StartupUiWaiter>();
    type StartupAgentReadyBarrier = {
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: Error) => void;
    };
    const startupAgentReadyBarriers = new Map<number, StartupAgentReadyBarrier>();
    const startupAgentReadyBarrierFor = (attemptId: number): StartupAgentReadyBarrier => {
      const existing = startupAgentReadyBarriers.get(attemptId);
      if (existing) return existing;
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      // A failed navigation can leave no renderer awaiting this attempt. Keep
      // that case from becoming an unhandled rejection without changing the
      // original promise observed by a valid startup renderer.
      void promise.catch(() => undefined);
      const barrier = { promise, resolve, reject };
      startupAgentReadyBarriers.set(attemptId, barrier);
      return barrier;
    };
    let resolveStartupBackendReady!: () => void;
    const startupBackendReady = new Promise<void>(resolve => { resolveStartupBackendReady = resolve; });
    const STARTUP_SHELL_MIN_VISIBLE_MS = 120;
    let startupShellReady: Promise<void> = Promise.resolve();
    let startupShellLoadedAt = 0;
    let startupAgentReady: Promise<void> | null = null;
    let startupComplete = false;
    let automationStarted = false;
    let startupDeferredTasks: ReturnType<typeof scheduleDeferredStartupTasks> | null = null;
    let startupUpdateResult: Awaited<ReturnType<typeof checkGitHubUpdate>> | null = null;
    let promptedStartupVersion = '';

    const sendStartupStatus = (payload: Record<string, unknown>): void => {
      const shellWindow = startupWindow;
      if (!shellWindow || shellWindow.isDestroyed()) return;
      shellWindow.webContents.send('startup:status', payload);
    };
    const loadDesktopWindowUi = async (win: BrowserWindow, attemptId = 0): Promise<void> => {
      if (win.isDestroyed()) return;
      const url = win.webContents.getURL();
      if (url && url !== 'about:blank' && !isStartupShellUrl(url)) return;
      recordStartup('ui-load-started');
      await win.loadFile(path.join(__dirname, 'ui', 'index.html'), attemptId > 0 ? {
        query: { startupAttempt: String(attemptId), startupPrewarm: '1' },
      } : undefined);
    };
    const loadStartupShell = (win: BrowserWindow): void => {
      if (win.isDestroyed()) return;
      recordStartup('startup-shell-load-started');
      startupShellReady = win.loadFile(path.join(__dirname, 'ui', 'startup.html')).then(() => {
        startupShellLoadedAt = Date.now();
        recordStartup('startup-shell-loaded');
      });
      void startupShellReady.catch(error => {
        if (startupComplete || win.isDestroyed()) return;
        recordStartup('startup-shell-load-warning');
        logStartupFailure('startup-shell-load', error);
      });
    };
    const showMainWindow = (): void => {
      let win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      if (!win && createDesktopWindow) {
        win = createDesktopWindow(startupComplete, true);
        if (!startupComplete) startupWindow = win;
        mainWindow = win;
      }
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    };
    showDesktopWindow = showMainWindow;

    const registerUiReadiness = (win: BrowserWindow, attemptId: number): void => {
      const webContentsId = win.webContents.id;
      let resolve!: (payload: StartupUiReadyPayload) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<StartupUiReadyPayload>((res, rej) => { resolve = res; reject = rej; });
      const timer = setTimeout(() => {
        startupUiWaiters.delete(webContentsId);
        reject(new Error('Full UI readiness handshake timed out after 30000ms'));
      }, 30_000);
      startupUiWaiters.set(webContentsId, { attemptId, promise, resolve, reject, timer });
    };
    const rejectUiReadinessById = (webContentsId: number, error: Error): void => {
      const waiter = startupUiWaiters.get(webContentsId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      startupUiWaiters.delete(webContentsId);
      waiter.reject(error);
    };
    const rejectUiReadiness = (win: BrowserWindow, error: Error): void => {
      if (win.isDestroyed()) return;
      rejectUiReadinessById(win.webContents.id, error);
    };
    const waitForUiReadiness = (win: BrowserWindow): Promise<StartupUiReadyPayload> => {
      const waiter = startupUiWaiters.get(win.webContents.id);
      return waiter ? waiter.promise : Promise.reject(new Error('UI readiness waiter was not registered before navigation'));
    };
    const isStartupPrewarmSender = (event: Electron.IpcMainInvokeEvent): boolean => {
      const waiter = startupUiWaiters.get(event.sender.id);
      if (!waiter) return false;
      try {
        const senderUrl = new URL(event.sender.getURL());
        return senderUrl.protocol === 'file:'
          && /\/index\.html$/i.test(senderUrl.pathname)
          && senderUrl.searchParams.get('startupPrewarm') === '1'
          && Number(senderUrl.searchParams.get('startupAttempt') || 0) === waiter.attemptId;
      } catch {
        return false;
      }
    };

    ipcMain.handle('startup:uiReady', (event, payload: StartupUiReadyPayload) => {
      const waiter = startupUiWaiters.get(event.sender.id);
      if (!waiter || waiter.attemptId !== Number(payload?.attemptId || 0)) return { accepted: false };
      const missingHydration = REQUIRED_STARTUP_UI_HYDRATION.filter(key => payload?.hydrated?.[key] !== true);
      if (missingHydration.length > 0) {
        const hydrationError = `Full UI readiness rejected; required hydration is incomplete: ${missingHydration.join(', ')}`;
        clearTimeout(waiter.timer);
        startupUiWaiters.delete(event.sender.id);
        waiter.reject(new Error(hydrationError));
        return { accepted: false, error: hydrationError };
      }
      clearTimeout(waiter.timer);
      startupUiWaiters.delete(event.sender.id);
      waiter.resolve(payload || { attemptId: waiter.attemptId });
      return { accepted: true };
    });
    ipcMain.handle('startup:uiFailed', (event, payload: StartupUiReadyPayload) => {
      const waiter = startupUiWaiters.get(event.sender.id);
      if (!waiter || waiter.attemptId !== Number(payload?.attemptId || 0)) return { accepted: false };
      clearTimeout(waiter.timer);
      startupUiWaiters.delete(event.sender.id);
      waiter.reject(new Error(String(payload?.error || 'Full UI prewarm failed')));
      return { accepted: true };
    });
    // This handler is registered before the first BrowserWindow starts loading
    // index.html. It closes the IPC-registration race while preserving the
    // single-navigation startup path.
    ipcMain.handle('startup:waitForBackend', async event => {
      const waiter = startupUiWaiters.get(event.sender.id);
      if (!waiter || !isStartupPrewarmSender(event)) return { ready: false };
      await Promise.all([
        startupAgentReadyBarrierFor(waiter.attemptId).promise,
        startupBackendReady,
      ]);
      return { ready: true };
    });

    createDesktopWindow = (loadUi = true, showWindow = true, attemptId = 0) => {
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
          devTools: true,
        },
      });
      const fileRouterOwnerId = String(win.webContents.id);

      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = win;
      if (loadUi) {
        if (attemptId > 0) registerUiReadiness(win, attemptId);
        void loadDesktopWindowUi(win, attemptId).catch(error => rejectUiReadiness(win, error instanceof Error ? error : new Error(String(error))));
      }
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
        if (contents.session === session.fromPartition('persist:newmark-browser')) registerBrowserGuest(win.webContents, contents);
      });
      win.webContents.on('render-process-gone', (_event, details) => {
        if (_forceQuit || win.isDestroyed()) return;
        logStartupFailure('renderer-process-gone', new Error(`${details.reason} (exit ${details.exitCode})`));
        setTimeout(() => {
          if (win.isDestroyed()) return;
          if (startupComplete) win.reload();
          else void runStartupAttempt();
          win.show();
          win.focus();
        }, 150);
      });
      win.webContents.on('unresponsive', () => {
        logStartupFailure('renderer-unresponsive', new Error(`Window renderer became unresponsive (webContents ${win.webContents.id})`));
      });
      win.webContents.on('responsive', () => {
        recordStartup(`renderer-responsive-${win.webContents.id}`);
      });
      if (!automationWakeMode) win.maximize();
      if (!automationWakeMode && showWindow) {
        win.show();
        recordStartup('window-shown');
        if (loadUi && !app.isPackaged && !args.includes('--no-devtools')) win.webContents.openDevTools({ mode: 'bottom' });
      }

      win.on('close', (e) => {
        if (_forceQuit) return;
        if (!startupComplete) return;
        if (agent) {
          const closeBehavior = agent.config.getStr('general', 'close_behavior');
          recordStartup(`window-close-requested-${closeBehavior || 'exit'}`);
          if (closeBehavior === 'minimize') {
            e.preventDefault();
            win.hide();
            createTray();
            recordStartup('window-hidden-to-tray');
            return;
          }
          if (agent.config.getBool('general', 'auto_archive_on_close')) {
            agent.archiveSession();
          }
          recordStartup('window-close-exit');
        }
      });

      win.on('closed', () => {
        rejectUiReadinessById(Number(fileRouterOwnerId), new Error('Startup window closed before UI readiness'));
        fileRouter.revokeOwner(fileRouterOwnerId);
        pdfPreviewServer.revokeOwner(fileRouterOwnerId);
        const closedHostId = Number(fileRouterOwnerId);
        browserGuestContentsByHost.delete(closedHostId);
        for (const [runtimeKey, binding] of browserGuestBindingsByRuntime) {
          if (binding.hostId === closedHostId) browserGuestBindingsByRuntime.delete(runtimeKey);
        }
        const remaining = BrowserWindow.getAllWindows().filter(candidate => !candidate.isDestroyed() && candidate !== win);
        if (mainWindow === win) mainWindow = remaining[0] || null;
        if (!remaining.length && sidecarProcess) {
          sidecarProcess.kill();
          sidecarProcess = null;
          sidecarPort = 0;
        }
      });
      return win;
    };

    let firstRunInitialized = false;
    if (!automationWakeMode) {
      // Attempt one loads the real desktop immediately. The renderer keeps a
      // startup cover above it until the main-process readiness acknowledgement,
      // avoiding a startup.html -> index.html renderer navigation on the hot path.
      startupAttempt = 1;
      startupShellLoadedAt = Date.now();
      startupWindow = createDesktopWindow(true, true, startupAttempt);
      mainWindow = startupWindow;
      createTray();
    }

    const startupUsesChinese = (): boolean => {
      const language = String(agent?.config.getStr('general', 'language') || 'auto').toLowerCase();
      return language === 'zh' || (language === 'auto' && String(app.getLocale() || '').toLowerCase().startsWith('zh'));
    };
    const startupMessageForProgress = (progress: StartupPrewarmProgress): string => {
      return startupUsesChinese()
        ? `正在预热：${progress.label}`
        : `Prewarming: ${progress.label}`;
    };
    const isUserFlowAbort = (error: unknown): boolean => {
      return error instanceof Error && /Flow interrupted by user/i.test(error.message);
    };

    const restoreStoredFlowSuspension = (): void => {
      if (!agent) return;
      const stored = agent.getStoredFlowSuspension(agent.activeConversationId);
      if (!stored) return;
      const flowDir = path.join(agent.rootPath, 'Flow');
      const found = FlowEngine.findWorkflow(stored.workflowName, flowDir);
      const workflow = found ? FlowEngine.load(flowDir, found) : null;
      if (!workflow) {
        agent.clearStoredFlowSuspension(agent.activeConversationId);
        return;
      }
      const reason = stored.reason === 'interrupted' ? 'interrupted' : 'question';
      let suspensionTarget: ConversationRuntimeTarget;
      if (stored.target) {
        try {
          suspensionTarget = conversationRuntimeTarget(stored.target);
        } catch {
          suspensionTarget = conversationRuntimeTarget(agent.activeConversationId || 'default');
        }
      } else {
        suspensionTarget = conversationRuntimeTarget(agent.activeConversationId || 'default');
      }
      const flowKey = activeFlowStateKey(suspensionTarget);
      const restored: ActiveFlowState = {
        workflow,
        input: String(stored.input || ''),
        componentId: Math.max(0, Math.floor(Number(stored.componentId) || 0)),
        completedResults: Array.isArray(stored.completedResults) ? stored.completedResults : [],
        previousMode: stored.previousMode === 'plan' || stored.previousMode === 'goal' ? stored.previousMode : 'build',
        previousFlow: null,
        previousPc: 0,
        reason,
        message: String(stored.message || ''),
        target: suspensionTarget,
        abortController: null,
        name: workflow.name,
        flowAgent: null,
      };
      activeFlowsByRuntimeKey.set(flowKey, restored);
      agent.flow = workflow;
      agent.flowPc = restored.componentId;
      agent.mode = 'flow';
      agent.status = 'idle';
      agent.pendingOptions = reason === 'question' && Array.isArray(stored.options)
        ? stored.options.map(question => ({
            header: '',
            question: String(question.question || ''),
            options: (question.options || []).map(option => ({
              label: String(option.label || ''),
              description: String(option.description || ''),
            })),
            multiple: false,
          }))
        : [];
    };

    const ensureStartupAgent = async (): Promise<void> => {
      if (!firstRunInitialized) {
        try {
          firstRunInit(root);
        } catch (error) {
          logStartupFailure(`firstRunInit:${root}`, error);
          const explicitRoot = pathArgValue(args, '--root');
          const fallbackRoot = userRuntimeRoot();
          if (explicitRoot || path.resolve(root) === path.resolve(fallbackRoot)) throw error;
          root = fallbackRoot;
          firstRunInit(fallbackRoot);
        }
        firstRunInitialized = true;
        recordStartup('first-run-init');
      }
      if (!agent) {
        agent = new Agent(root);
        mcpManager = new McpManager(root);
        activeAgentBackendMode = process.platform === 'win32' && agent.config.getBool('agent', 'run_in_wsl') ? 'wsl' : 'windows';
        ensureWorkspaceRegistryWatcher();
        restoreStoredFlowSuspension();
        recordStartup('agent-ready');
        // GUI 始终注册 mobile server 的运行时桥接；开关打开时才开始监听。
        // 这样从关闭态切到开启态时也能在当前 GUI 进程中原地重启服务。
        try {
          const { configureHostedServer, runServer } = require('./server') as typeof import('./server');
          configureHostedServer(root, {
              agent,
              automation,
              onWorkEvent: event => broadcastAgentWorkEvent(event, false),
              subscribeWorkEvents: listener => {
                mobileServerWorkEventSubscribers.add(listener);
                return () => mobileServerWorkEventSubscribers.delete(listener);
              },
              conversationUiState: async requested => {
                const target = conversationRuntimeTarget(requested);
                const snapshot = wslBackendEnabled()
                  ? await ensureWslConversationPool()!.snapshot(target)
                  : await ensureElectronUtilityPool().snapshot(target);
                const flowRunning = flowRunningForTarget(target);
                const flowSuspension = flowSuspensionForTarget(target);
                return {
                  ...snapshot,
                  flow: flowRunning ? {
                    running: true,
                    paused: false,
                    name: flowRunning.name,
                    promptText: String(activeFlowStateFor(target)?.input || ''),
                    message: '',
                  } : flowSuspension ? {
                    running: true,
                    paused: true,
                    name: flowSuspension.workflowName || '',
                    promptText: String(flowSuspension.input || ''),
                    message: String(flowSuspension.message || ''),
                    reason: flowSuspension.reason || '',
                  } : null,
                };
              },
              conversationUiAction: async (requested, action, value, input) => {
                const target = conversationRuntimeTarget(requested);
                if (action.startsWith('queue_')) {
                  const queueAction = action === 'queue_enqueue' ? 'enqueue'
                    : action === 'queue_update' ? 'update'
                      : action === 'queue_delete' ? 'delete'
                        : action === 'queue_reorder' ? 'reorder'
                          : action === 'queue_toggle_pause' ? 'toggle_pause'
                            : 'guide';
                  const queueInput = {
                    id: String(input?.id || ''),
                    text: String(input?.text || value || ''),
                    requestedMode: String(input?.requestedMode || 'build'),
                    goalObjective: String(input?.goalObjective || ''),
                    createdAt: String(input?.createdAt || ''),
                    orderedIds: Array.isArray(input?.orderedIds)
                      ? input.orderedIds.map((id: unknown) => String(id || ''))
                      : undefined,
                  };
                  return wslBackendEnabled()
                    ? await ensureWslConversationPool()!.queueAction(target, queueAction, queueInput)
                    : await ensureElectronUtilityPool().queueAction(target, queueAction, queueInput);
                }
                if (action === 'goal_update') {
                  return { goal: await mutateTargetConversation(target, () => {
                    const isolated = isolatedConversationAgent(target);
                    isolated.updateGoal(String(value || '').trim());
                    isolated.setMode('goal');
                    isolated.saveWorkspaceConversationState(true);
                    return isolated.getConversationSnapshot(target.conversationId).goal;
                  }) };
                }
                if (action === 'goal_guide' || action === 'conversation_guide') {
                  const objective = action === 'goal_guide' ? String(value || '').trim() : '';
                  const guideText = String(value || '').trim();
                  const snapshot = wslBackendEnabled()
                    ? await ensureWslConversationPool()!.snapshot(target)
                    : await ensureElectronUtilityPool().snapshot(target);
                  const runtime = snapshot.runtime as { running?: boolean; runId?: string } | null | undefined;
                  // `running` may turn false one IPC task before a finalization-
                  // window Guide reaches the worker. Preserve the authoritative
                  // runId and let ConversationKernel decide whether that run can
                  // be reactivated or must reject a genuinely stale request.
                  if (!guideText || !runtime?.runId) {
                    return { ok: false, error: action === 'goal_guide'
                      ? 'There is no active Build for this Goal Guide.'
                      : 'Target conversation is not running.' };
                  }
                  const prefix = 'Goal for the current Build:\n';
                  const now = new Date().toISOString();
                  const envelope: ConversationInputEnvelope = {
                    clientMessageId: randomUUID(),
                    guideId: randomUUID(),
                    target: { workspaceId: target.workspaceId, conversationId: target.conversationId },
                    runId: runtime.runId,
                    deliveryMode: 'steer',
                    text: objective ? prefix + objective : guideText,
                    goalObjective: objective || undefined,
                    createdAt: now,
                  };
                  const receipt = wslBackendEnabled()
                    ? await ensureWslConversationPool()!.enqueueGuide(envelope)
                    : await ensureElectronUtilityPool().enqueueGuide(envelope);
                  return { ok: receipt.status !== 'rejected', receipt };
                }
                if (action === 'goal_toggle_pause') {
                  const resident = wslBackendEnabled()
                    ? await ensureWslConversationPool()!.toggleGoalPause(target)
                    : await ensureElectronUtilityPool().toggleGoalPause(target);
                  const paused = resident !== null ? resident : await mutateTargetConversation(target, () => isolatedConversationAgent(target).toggleGoalPause());
                  return { ok: true, paused };
                }
                if (action === 'goal_clear') {
                  const resident = wslBackendEnabled()
                    ? await ensureWslConversationPool()!.clearGoal(target)
                    : await ensureElectronUtilityPool().clearGoal(target);
                  if (resident === null) await mutateTargetConversation(target, () => isolatedConversationAgent(target).clearGoal());
                  return { ok: true, cleared: true };
                }
                if (action === 'flow_pause') return await stopFlowForTarget(target);
                if (action === 'flow_resume') return await resumeFlowForTarget(String(value || ''), target);
                if (action === 'conversation_stop') {
                  const snapshot = wslBackendEnabled()
                    ? await ensureWslConversationPool()!.snapshot(target)
                    : await ensureElectronUtilityPool().snapshot(target);
                  const runtime = snapshot.runtime as { runId?: string } | null | undefined;
                  return wslBackendEnabled()
                    ? await ensureWslConversationPool()!.requestStop(target, runtime?.runId)
                    : await ensureElectronUtilityPool().requestStop(target, runtime?.runId);
                }
                if (action === 'input_mode') {
                  const mode = String(value || '') === 'next' ? 'next' : 'guide';
                  const selected = wslBackendEnabled()
                    ? await ensureWslConversationPool()!.setInputMode(target, mode)
                    : await ensureElectronUtilityPool().setInputMode(target, mode);
                  return { ok: true, inputMode: selected || mode };
                }
                const flow = activeFlowStateFor(target);
                if (!flow?.abortController || !flow.flowAgent) return { ok: false, error: 'No active Flow accepts Guide input.' };
                const accepted = flow.flowAgent.queueActiveKernelMessage(String(value || '').trim(), 'steer') || false;
                return accepted ? { ok: true, accepted: true, flow: flow.name } : { ok: false, error: 'The current Flow Build is not accepting Guide input.' };
              },
              conversationPrompt: async (requested, message, requestedOptions) => {
                const target = conversationRuntimeTarget(requested);
                if (activeFlowStateFor(target)) clearFlowSuspensionForNewWork(target);
                const snapshot = wslBackendEnabled()
                  ? await ensureWslConversationPool()!.snapshot(target)
                  : await ensureElectronUtilityPool().snapshot(target);
                const requestedMode = String(requestedOptions?.requestedMode || '').toLowerCase();
                const goalObjective = String(requestedOptions?.goalObjective || '').trim();
                const mode = (goalObjective || requestedMode === 'goal') ? 'build' : String(snapshot.mode || 'build') as AgentMode;
                const inputMode: 'guide' | 'next' = String(requestedOptions?.inputMode || snapshot.inputMode || 'guide') === 'next' ? 'next' : 'guide';
                const options = {
                  mode,
                  model: String(snapshot.model || agent!.ensureUsableModelSelection()),
                  intelligence: String(snapshot.intelligence || agent!.intelligence),
                  inputMode,
                  engine: agent!.engine,
                };
                const queueMode = inputMode === 'guide' ? 'steer' : 'followUp';
                const promptMessage: string | AgentPromptMessage = goalObjective ? {
                  text: message,
                  visibleMode: 'goal',
                  goalObjective,
                } : message;
                const result = wslBackendEnabled()
                  ? await ensureWslConversationPool()!.prompt({
                    message: promptMessage,
                    target,
                    conversationId: target.conversationId,
                    options,
                    queueMode,
                    workspace: target.workspace ? {
                      id: target.workspace.id,
                      name: target.workspace.name,
                      path: target.workspace.path,
                      isInternal: target.workspace.isInternal,
                      kind: target.workspace.kind,
                    } : null,
                  })
                  : await ensureElectronUtilityPool().prompt({ message: promptMessage, target, options, queueMode });
                return { ...result } as Record<string, unknown>;
              },
          });
          if (agent.config.getBool('remote', 'touch_enabled')) {
            runServer(root);
            recordStartup('mobile-server-hosted');
          }
        } catch (error) {
          console.error('[Newmark] hosted mobile server failed:', error instanceof Error ? error.message : String(error));
        }
      }
    };
    const localConversationSnapshotForStartup = (target: ConversationRuntimeTarget): Record<string, unknown> => {
      const startupAgent = agent;
      if (!startupAgent) throw new Error('Agent is unavailable for startup conversation hydration');
      const normalizedTarget = normalizeConversationTarget(target);
      const currentTarget = normalizeConversationTarget(conversationRuntimeTarget());
      if (normalizedTarget.runtimeKey !== currentTarget.runtimeKey) {
        throw new Error('Startup hydration requested a conversation other than the current Agent conversation');
      }
      const conversationSnapshot = startupAgent.ensureConversationSnapshot(target.conversationId);
      if (conversationSnapshot.conversationId !== normalizedTarget.conversationId) {
        throw new Error('Startup conversation snapshot identity mismatch');
      }
      return {
        ...conversationSnapshot,
        target: normalizedTarget,
        workspaceId: normalizedTarget.workspaceId,
        conversationId: normalizedTarget.conversationId,
        workspaceKey: normalizedTarget.workspaceKey,
        runtimeKey: normalizedTarget.runtimeKey,
        runtime: null,
        runtimeStatus: 'deferred',
        queued: { steering: [], followUp: [] },
        workEvents: [],
        mode: startupAgent.mode,
        model: startupAgent.modelSelectionValue(),
        intelligence: startupAgent.intelligence,
        status: startupAgent.status,
        goal: startupAgent.goal ? { objective: startupAgent.goal.objective, paused: startupAgent.goal.paused } : null,
        fileDiffs: startupAgent.fileDiffs.map(diff => ({
          path: diff.path,
          oldLength: diff.oldContent.length,
          newLength: diff.newContent.length,
        })),
        pendingOptions: startupAgent.pendingOptions.map(question => ({
          ...question,
          options: question.options.map(option => ({ ...option })),
        })),
        contextCompression: startupAgent.lastCompression,
        contextWindow: startupAgent.contextWindow(),
        conversationLocked: false,
        routeDecision: startupAgent.lastRouteDecision,
        resolvedDeployment: startupAgent.activeDeployment(),
        autoRouteRatingAvailable: startupAgent.model === 'auto'
          && startupAgent.lastRouteDecision?.requestedSelection.kind === 'auto'
          && !!startupAgent.lastRouteDecision.resolvedDeployment,
      };
    };
    const ensureStartupAutomation = async (): Promise<void> => {
      if (!agent) await ensureStartupAgent();
      const startupAgent = agent;
      if (!startupAgent) throw new Error('Agent is unavailable for deferred automation startup');
      if (!automationWake) automationWake = new AutomationWakeScheduler(root, process.execPath);
      if (!automation) {
        automation = new AutomationManager(startupAgent.config, async (prompt, model, item) => {
          const targetConversationId = item.conversationMode === 'existing'
            ? item.conversationId
            : `automation-${item.id}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
          const target = conversationRuntimeTarget({ workspaceId: item.workspaceId, conversationId: targetConversationId });
          const kernel = ensureConversationKernel(root);
          if (!kernel) throw new Error('Conversation runtime is unavailable for automation.');
          await kernel.waitForIdle(target);
          automation?.update(item.id, { lastConversationId: targetConversationId });
          const result = await kernel.prompt({
            text: prompt,
            visibleMode: 'build',
          }, target, {
            mode: 'build',
            model: model || startupAgent.modelSelectionValue(),
            intelligence: startupAgent.intelligence,
            inputMode: 'next',
            engine: startupAgent.engine,
          });
          mainWindow?.webContents.send('automation:updated');
          return result.tokens.map(token => token.text).join('');
        });
        startupAgent.setAutomationManager(automation);
        const { setHostedServerAutomation } = require('./server') as typeof import('./server');
        setHostedServerAutomation(automation);
        automation.onChange(items => {
          setTimeout(() => {
            try {
              if (automationWake) lastWakeSync = automationWake.sync(items);
            } catch (error) {
              lastWakeSync = {
                platform: process.platform,
                active: false,
                nextRunAt: '',
                taskName: automationWake?.taskName() || '',
                registered: false,
                deleted: false,
                skippedReason: error instanceof Error ? error.message : String(error),
              };
            }
          }, 100);
        });
      }
      if (!automationWakeMode && !automationStarted) {
        automation.start();
        automationStarted = true;
        recordStartup('automation-started');
      }
    };

    const promoteStartupUi = (win: BrowserWindow): void => {
      if (win.isDestroyed()) throw new Error('Startup UI window was destroyed before readiness');
      mainWindow = win;
      startupComplete = true;
      startupWindow = null;
      win.maximize();
      win.show();
      win.focus();
      recordStartup('prewarmed-ui-shown');
      syncAutomationWakeSoon();
      if (!app.isPackaged && !args.includes('--no-devtools')) win.webContents.openDevTools({ mode: 'bottom' });
    };

    const showStartupUpdatePrompt = async (win: BrowserWindow): Promise<void> => {
      const release = startupUpdateResult;
      const content = startupUpdatePromptContent(
        release,
        agent?.config.getStr('general', 'language') || 'auto',
        app.getLocale(),
      );
      if (!content || promptedStartupVersion === content.version || win.isDestroyed()) return;
      promptedStartupVersion = content.version;
      const response = await dialog.showMessageBox(win, {
        type: 'info',
        title: content.title,
        message: content.message,
        detail: content.detail,
        buttons: content.buttons,
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response.response === 0 && /^https:\/\//i.test(content.url)) {
        await shell.openExternal(content.url);
      }
    };

    const scheduleDeferredDesktopStartup = (win: BrowserWindow): void => {
      startupDeferredTasks?.cancel();
      const deferredConversationTarget = conversationRuntimeTarget();
      const handle = scheduleDeferredStartupTasks([
        {
          id: 'conversation-runtime-prewarm',
          label: startupUsesChinese() ? '当前对话运行时' : 'current conversation runtime',
          // Start after the UI is interactive. Foreground prompts share the
          // same single-flight startup promise instead of launching twice.
          delayMs: 250,
          run: async signal => {
            if (signal.aborted) return;
            if (wslBackendEnabled()) {
              await ensureWslConversationPool()!.prewarm(deferredConversationTarget);
            }
            const snapshot = wslBackendEnabled()
              ? await ensureWslConversationPool()!.snapshot(deferredConversationTarget)
              : await ensureElectronUtilityPool().snapshot(deferredConversationTarget);
            if (signal.aborted) return;
            if (!snapshot || snapshot.runtimeStatus === 'unavailable') {
              throw new Error(String(snapshot?.runtimeError || 'Conversation runtime snapshot unavailable'));
            }
            // This is health/prewarm evidence only. Never reconcile this late
            // snapshot into renderer state, where it could overwrite a prompt,
            // workspace switch, queue, or newer conversation generation.
            recordStartup('runtime-prewarm-ready');
            return snapshot;
          },
        },
        {
          id: 'automation',
          label: startupUsesChinese() ? '自动化调度' : 'automation scheduler',
          delayMs: 500,
          run: async signal => {
            if (signal.aborted) return;
            await ensureStartupAutomation();
            if (!signal.aborted) syncAutomationWakeSoon();
          },
        },
        {
          id: 'wsl-detection',
          label: startupUsesChinese() ? '运行环境探测' : 'runtime environment detection',
          delayMs: 12_000,
          run: async signal => {
            if (signal.aborted) return;
            const distros = await detectWslDistrosAtStartup();
            if (!signal.aborted) recordStartup('wsl-detection-complete');
            return distros;
          },
        },
        {
          id: 'sidecar',
          label: startupUsesChinese() ? '本地辅助服务' : 'local sidecar',
          // The sidecar is not needed for first interaction or Browser use.
          // Keep its utility process outside startup/private-byte acceptance;
          // explicit sidecar restart still starts it immediately on demand.
          delayMs: 60_000,
          run: async signal => {
            if (signal.aborted) return;
            const port = await startSidecar(root);
            if (port <= 0) throw new Error('Sidecar is unavailable');
            if (!signal.aborted) {
              console.log(`[Newmark] Sidecar started on port ${port}`);
              recordStartup('sidecar-ready');
            }
            return port;
          },
        },
        {
          id: 'update-check',
          label: startupUsesChinese() ? '版本更新检查' : 'update check',
          delayMs: 15_000,
          run: async signal => {
            if (signal.aborted) return;
            const result = await checkGitHubUpdate('', '', '', undefined, { timeoutMs: 5_000 });
            if (signal.aborted) return;
            startupUpdateResult = result;
            recordStartup('update-check-complete');
            if (!result.ok) throw new Error(result.error || 'Update check unavailable');
            setTimeout(() => {
              if (!signal.aborted && !win.isDestroyed()) void showStartupUpdatePrompt(win);
            }, 250);
            return result;
          },
        },
      ], {
        onResult: result => {
          if (result.status === 'warning') console.warn(`[Newmark] Deferred startup ${result.id}: ${result.error || 'unavailable'}`);
        },
      });
      startupDeferredTasks = handle;
      win.once('closed', () => handle.cancel());
      void handle.done.finally(() => {
        if (startupDeferredTasks === handle) startupDeferredTasks = null;
      });
    };

    const runStartupAttempt = (): Promise<{ ok: boolean; error?: string }> => {
      if (startupComplete) return Promise.resolve({ ok: true });
      if (startupAttemptPromise) return startupAttemptPromise;
      const preloadedUiWindow = startupWindow;
      const preloadedUiUrl = preloadedUiWindow && !preloadedUiWindow.isDestroyed()
        ? preloadedUiWindow.webContents.getURL()
        : '';
      const attemptOneNavigationPreloaded = startupAttempt === 1
        && !!preloadedUiWindow
        && !preloadedUiWindow.isDestroyed()
        && !isStartupShellUrl(preloadedUiUrl)
        && (() => {
          if (!preloadedUiUrl || preloadedUiUrl === 'about:blank') return true;
          try {
            const url = new URL(preloadedUiUrl);
            return url.protocol === 'file:'
              && /\/index\.html$/i.test(url.pathname)
              && url.searchParams.get('startupPrewarm') === '1'
              && Number(url.searchParams.get('startupAttempt') || 0) === 1;
          } catch {
            return false;
          }
        })();
      let preloadedUiWaiter = preloadedUiWindow && !preloadedUiWindow.isDestroyed()
        ? startupUiWaiters.get(preloadedUiWindow.webContents.id)
        : undefined;
      if (attemptOneNavigationPreloaded && preloadedUiWindow && preloadedUiWaiter?.attemptId !== 1) {
        if (preloadedUiWaiter) {
          rejectUiReadinessById(preloadedUiWindow.webContents.id, new Error('Replacing stale startup UI readiness waiter'));
        }
        registerUiReadiness(preloadedUiWindow, 1);
        preloadedUiWaiter = startupUiWaiters.get(preloadedUiWindow.webContents.id);
        recordStartup('ui-readiness-waiter-restored-attempt-1');
      }
      const reusesPreloadedUi = attemptOneNavigationPreloaded
        || (!!preloadedUiWaiter && preloadedUiWaiter.attemptId === startupAttempt && startupAttempt > 0);
      const attemptId = reusesPreloadedUi ? startupAttempt : ++startupAttempt;
      const preloadedUiReadiness = reusesPreloadedUi ? preloadedUiWaiter!.promise : null;
      recordStartup(reusesPreloadedUi
        ? `ui-preload-reused-attempt-${attemptId}`
        : `ui-preload-navigation-required-attempt-${attemptId}`);
      const attemptAgentReadyBarrier = startupAgentReadyBarrierFor(attemptId);
      let startupUiNavigationStarted = reusesPreloadedUi;
      const promise = (async (): Promise<{ ok: boolean; error?: string }> => {
        try {
          startupDeferredTasks?.cancel();
          startupAgentReady = ensureStartupAgent();
          void startupAgentReady.then(
            () => attemptAgentReadyBarrier.resolve(),
            error => attemptAgentReadyBarrier.reject(error instanceof Error ? error : new Error(String(error))),
          );
          await Promise.all([startupShellReady, startupAgentReady]);
          if (!automationWakeMode && startupShellLoadedAt > 0) {
            const remainingShellTime = STARTUP_SHELL_MIN_VISIBLE_MS - (Date.now() - startupShellLoadedAt);
            if (remainingShellTime > 0) await new Promise<void>(resolve => setTimeout(resolve, remainingShellTime));
          }
          sendStartupStatus({
            phase: 'warming',
            message: startupUsesChinese() ? '正在预热内核与界面…' : 'Prewarming kernel and UI…',
            detail: '',
            completed: 0,
            total: 4,
            retry: false,
          });
          if (automationWakeMode) {
            await ensureStartupAutomation();
            await automation!.tick();
            lastWakeSync = automationWake!.sync(automation!.list());
            automation!.stop();
            app.quit();
            return { ok: true };
          }
          sendStartupStatus({
            phase: 'warming',
            message: startupUsesChinese() ? '内核配置已就绪' : 'Kernel configuration ready',
            detail: '',
            completed: 1,
            total: 4,
            retry: false,
          });
          const coreReportPromise = runStartupPrewarmBarrier([
            {
              id: 'core-services',
              label: startupUsesChinese() ? '对话内核与浏览器控制' : 'conversation kernel and browser control',
              required: true,
              run: async () => {
                installBrowserControlBackend();
                if (!ensureConversationKernel(root)) throw new Error('Conversation kernel did not initialize');
                recordStartup('core-services-ready');
              },
            },
            {
              id: 'conversation-state',
              label: startupUsesChinese() ? '当前对话状态' : 'current conversation state',
              required: true,
              run: () => {
                const target = conversationRuntimeTarget();
                const startupAgent = agent;
                if (!startupAgent) throw new Error('Agent is unavailable for startup conversation validation');
                const snapshot = startupAgent.ensureConversationSnapshot(target.conversationId);
                if (!snapshot || snapshot.conversationId !== target.conversationId) {
                  throw new Error('Current conversation snapshot is unavailable');
                }
                recordStartup('conversation-state-ready');
                return snapshot;
              },
            },
          ], progress => sendStartupStatus({
            phase: 'warming',
            message: startupMessageForProgress(progress),
            detail: progress.status === 'warning' || progress.status === 'failed' ? String(progress.id) : '',
            completed: 1 + progress.completed,
            total: 4,
            retry: false,
          }));
          const coreReport = await coreReportPromise;
          if (!coreReport.ok) {
            throw new Error(coreReport.failures.map(item => `${item.label}: ${item.error || 'failed'}`).join('\n'));
          }

          const startupUiWindow = startupWindow;
          if (!startupUiWindow || startupUiWindow.isDestroyed()) throw new Error('Startup window is unavailable for main UI navigation');
          const startupWebContentsId = startupUiWindow.webContents.id;
          let uiReadiness = preloadedUiReadiness;
          if (!uiReadiness) {
            rejectUiReadinessById(startupWebContentsId, new Error('Superseded startup UI readiness waiter'));
            registerUiReadiness(startupUiWindow, attemptId);
            uiReadiness = waitForUiReadiness(startupUiWindow);
          }
          const uiReportPromise = runStartupPrewarmBarrier([{
            id: 'ui-prewarm',
            label: startupUsesChinese() ? '首屏界面状态' : 'first-frame UI state',
            required: true,
            run: async () => await uiReadiness,
          }], progress => sendStartupStatus({
            phase: 'warming',
            message: startupMessageForProgress(progress),
            detail: '',
            completed: 3 + progress.completed,
            total: 4,
            retry: false,
          }));
          if (!reusesPreloadedUi) {
            startupUiNavigationStarted = true;
            void loadDesktopWindowUi(startupUiWindow, attemptId).catch(error => {
              rejectUiReadinessById(startupWebContentsId, error instanceof Error ? error : new Error(String(error)));
            });
          }
          const uiReport = await uiReportPromise;
          if (!uiReport.ok) {
            throw new Error(uiReport.failures.map(item => `${item.label}: ${item.error || 'failed'}`).join('\n'));
          }
          promoteStartupUi(startupUiWindow);
          scheduleDeferredDesktopStartup(startupUiWindow);
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logStartupFailure(`startup-prewarm-attempt-${attemptId}`, error);
          const failurePayload = {
            phase: 'failed',
            message: startupUsesChinese() ? '预热失败，主界面尚未打开' : 'Prewarm failed; the main UI remains closed',
            detail: `${message}\n${startupLogPath()}`,
            completed: 0,
            total: 4,
            retry: true,
          };
          const failedWindow = startupWindow;
          if (startupUiNavigationStarted && failedWindow && !failedWindow.isDestroyed()) {
            rejectUiReadinessById(failedWindow.webContents.id, new Error(`Startup UI attempt ${attemptId} failed`));
            loadStartupShell(failedWindow);
            void startupShellReady.then(() => sendStartupStatus(failurePayload)).catch(() => undefined);
          } else {
            sendStartupStatus(failurePayload);
          }
          return { ok: false, error: message };
        }
      })();
      startupAttemptPromise = promise;
      void promise.finally(() => {
        if (startupAttemptPromise === promise) startupAttemptPromise = null;
      });
      return promise;
    };

    ipcMain.handle('startup:retry', async () => await runStartupAttempt());
    // Publish startupAgentReady synchronously before the preloaded renderer can
    // request its initial state on the next event-loop turn.
    void runStartupAttempt();

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
    const armForcedExitDeadline = (reason: string): void => {
      if (forcedExitTimer) return;
      forcedExitTimer = setTimeout(() => {
        console.error(`[Newmark] Forced process exit after graceful shutdown deadline: ${reason}`);
        app.exit(0);
      }, 12_000);
      forcedExitTimer.unref?.();
    };
    const requestExplicitExit = (reason: string): void => {
      _forceQuit = true;
      armForcedExitDeadline(reason);
      if (tray) { tray.destroy(); tray = null; }
      app.quit();
    };
    const hasUnsettledGoalOrFlow = (): boolean => {
      const goalRunning = !!agent?.goal && !agent.goal.paused;
      const flowRunning = Array.from(activeFlowsByRuntimeKey.values()).some(state => !!state.abortController);
      return goalRunning || flowRunning;
    };
    const markMainLifecycleCleanIfSafe = (): void => {
      if (!hasUnsettledGoalOrFlow()) markRuntimeLifecycleClean(root, 'main');
    };
    app.on('will-quit', event => {
      recordStartup('will-quit');
      // Window-close and tray-exit both enter this path. The runtime pools
      // must get a bounded graceful-shutdown window regardless of which
      // surface initiated the close; otherwise a stuck child can keep the
      // Electron parent and its renderer tree alive indefinitely.
      if (_forceQuit || !appExitCleanupComplete) armForcedExitDeadline('will-quit');
      if (workspaceRegistryWatchTimer) clearTimeout(workspaceRegistryWatchTimer);
      workspaceRegistryWatchTimer = null;
      workspaceRegistryWatcher?.close();
      workspaceRegistryWatcher = null;
      startupDeferredTasks?.cancel();
      agent?.flushWorkspaceConversationState();
      conversationKernel?.flushPersistence();
      if (!appExitCleanupComplete && (wslAgentClient || wslAgentRuntimePool || electronUtilityRuntimePool)) {
        event.preventDefault();
        if (!appExitCleanupStarted) {
          appExitCleanupStarted = true;
          const legacyClient = wslAgentClient;
          const wslPool = wslAgentRuntimePool;
          const utilityPool = electronUtilityRuntimePool;
          wslAgentClient = null;
          wslAgentRuntimePool = null;
          electronUtilityRuntimePool = null;
          const legacyStop = legacyClient
            ? legacyClient.stop().catch(async error => {
              try { await legacyClient.shutdownNow(); } catch {}
              throw error;
            })
            : undefined;
          let shutdownFailed = false;
          void runRuntimeShutdownBarrier({
            operations: [
              legacyStop,
              wslPool?.stopAll(),
              utilityPool?.stopAll(),
            ],
            shutdownHelpers: async () => await shutdownWindowsProcessHelpers(2_000),
          }).catch(error => {
            shutdownFailed = true;
            console.error('[Newmark] Runtime shutdown cleanup failed:', error instanceof Error ? error.message : String(error));
          }).finally(() => {
            appExitCleanupComplete = true;
            if (!shutdownFailed) markMainLifecycleCleanIfSafe();
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
      BrowserUse.setBackend(null);
      browserUseEngine?.clear();
      browserUseEngine = null;
      electronBrowserUseHost?.dispose();
      electronBrowserUseHost = null;
      BrowserControl.setBackend(null);
      browserGuestContentsByHost.clear();
      browserGuestBindingsByRuntime.clear();
      if (sidecarProcess) { sidecarProcess.kill(); sidecarProcess = null; }
      shutdownTerminalTakeoverSessions('app-exit');
      markMainLifecycleCleanIfSafe();
      if (forcedExitTimer) {
        clearTimeout(forcedExitTimer);
        forcedExitTimer = null;
      }
    });

    function createTray() {
      if (tray) return;
      tray = new Tray(createAppIconImage(16));
      tray.setToolTip('Newmark Agent');
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Window', click: showMainWindow },
        { type: 'separator' },
        { label: 'Exit', click: () => requestExplicitExit('tray-exit') },
      ]);
      tray.setContextMenu(contextMenu);
      tray.on('click', showMainWindow);
      tray.on('double-click', showMainWindow);
      refreshNativeThemeIcons();
    }

    const wslBackendEnabled = (): boolean => process.platform === 'win32' && activeAgentBackendMode === 'wsl';

    const flowSuspensionForTarget = (target: ConversationRuntimeTarget): FlowSuspensionRecord | null => {
      const state = activeFlowStateFor(target);
      if (state && (state.reason === 'question' || state.reason === 'interrupted')) {
        return persistedFlowSuspensionRecord(state, state.message || '');
      }
      const stored = agent?.getStoredFlowSuspension(target.conversationId);
      if (!stored) return null;
      if (!stored.target) return target.conversationId === agent?.activeConversationId ? stored : null;
      return stored.target.workspaceId === target.workspaceId && stored.target.conversationId === target.conversationId
        ? stored
        : null;
    };

    const flowRunningForTarget = (target: ConversationRuntimeTarget): { name: string } | null => {
      const state = activeFlowStateFor(target);
      if (!state || state.reason === 'question' || state.reason === 'interrupted') return null;
      return { name: state.name || state.workflow.name || '' };
    };

    const flowAgentTarget = (owner: Agent): { workspaceId: string; conversationId: string } => ({
      workspaceId: owner.workspace.current?.id || 'none',
      conversationId: owner.activeConversationId || 'default',
    });

    const setTargetFlowMode = async (target: ConversationRuntimeTarget, mode: AgentMode): Promise<void> => {
      conversationKernel?.setMode(target, mode);
      if (wslBackendEnabled()) await ensureWslConversationPool()!.setMode(target, mode);
      else await ensureElectronUtilityPool()!.setMode(target, mode);
    };

    // Discards a paused Flow for exactly one conversation, restoring that
    // conversation's previous mode. Other conversations' Flow state is untouched.
    const discardFlowSuspensionForTarget = async (target: ConversationRuntimeTarget): Promise<void> => {
      const key = activeFlowStateKey(target);
      const suspension = activeFlowsByRuntimeKey.get(key) || null;
      if (!agent || !suspension) return;
      activeFlowsByRuntimeKey.delete(key);
      const owner = suspension.flowAgent;
      const ownerTarget = owner ? flowAgentTarget(owner) : null;
      if (owner && ownerTarget && ownerTarget.workspaceId === suspension.target.workspaceId && ownerTarget.conversationId === suspension.target.conversationId) {
        owner.pendingOptions = [];
        owner.flow = suspension.previousFlow;
        owner.flowPc = suspension.previousPc;
        owner.setMode(suspension.previousMode);
      }
      agent.clearStoredFlowSuspension(suspension.target.conversationId);
      await setTargetFlowMode(suspension.target, suspension.previousMode);
    };

    // Drops a paused Flow for exactly one conversation without restoring the
    // previous mode so a user's new Build/Plan/Goal/Flow instruction owns the
    // current mode. The renderer keeps the mode in sync through agent:setMode
    // before the send lands. Other conversations' Flow state is untouched.
    const clearFlowSuspensionForNewWork = (target: ConversationRuntimeTarget): void => {
      if (!agent) return;
      const key = activeFlowStateKey(target);
      const state = activeFlowsByRuntimeKey.get(key) || null;
      if (!state) return;
      activeFlowsByRuntimeKey.delete(key);
      agent.clearStoredFlowSuspension(state.target.conversationId);
    };

    // Archive is a destructive lifecycle boundary. It must cancel the Flow
    // owner itself before touching the runtime pool; Flow runs bypass the
    // ConversationKernel and therefore cannot be stopped by the pool alone.
    // Marking the state before aborting is important: the provider may reject
    // on the same turn, and its late catch/finally must not recreate a paused
    // conversation after archive has removed it.
    const interruptActiveFlowForArchive = (target: ConversationRuntimeTarget): void => {
      const key = activeFlowStateKey(target);
      const state = activeFlowsByRuntimeKey.get(key) || null;
      if (!state) return;
      state.archiveRequested = true;
      try {
        state.abortController?.abort(new Error(`Flow discarded because conversation was archived: ${state.name || state.workflow.name}`));
      } catch {}
      state.flowAgent?.abortActiveKernelRun();
      state.flowAgent?.interruptRunningConversationWorkRuns(state.target, 'force_interrupted');
      state.flowAgent?.clearStoredFlowSuspension(state.target.conversationId);
      if (agent?.workspace.current
        && target.workspace
        && path.resolve(agent.workspace.current.path) === path.resolve(target.workspace.path)) {
        agent.clearStoredFlowSuspension(target.conversationId);
      }
      activeFlowsByRuntimeKey.delete(key);
    };

    const utilityHostToolHandler = createUtilityHostToolHandler({
      persistenceRoot: root,
      isToolEnabled: toolName => !!agent && isNativeToolEnabled(toolName, agent.config.nativeToolEnabled()),
      runBrowserUse: async (request, signal) => await ensureBrowserUseEngine().run(request, signal),
      cancelBrowserUseTarget: runtimeKey => {
        browserUseEngine?.clearRuntime(runtimeKey);
        electronBrowserUseHost?.clear({ runtimeKey, owner: '' });
      },
      runAutomation: async (tool, payload, signal) => {
        if (!agent) throw new Error('Automation manager is unavailable');
        return await agent.handleAutomationTool(tool, payload, signal);
      },
    });
    const ensureElectronUtilityPool = (): ElectronUtilityRuntimePool => {
      if (!electronUtilityRuntimePool) {
        electronUtilityRuntimePool = new ElectronUtilityRuntimePool(root, ensureElectronUtilityRuntimeHost());
        electronUtilityRuntimePool.subscribe(event => broadcastAgentWorkEvent(event));
        electronUtilityRuntimePool.setHostToolHandler(utilityHostToolHandler);
      }
      return electronUtilityRuntimePool;
    };
    const prepareWslComputerUseVisionResult = (value: unknown): unknown => {
      const serialized = typeof value === 'string';
      let parsed: Record<string, unknown>;
      try {
        parsed = serialized ? JSON.parse(value) as Record<string, unknown> : { ...value as Record<string, unknown> };
      } catch {
        return value;
      }
      const screenshotPath = String(parsed.vision_image_path || '');
      if (!screenshotPath) return value;
      delete parsed.vision_image_path;
      const screenshotRoot = path.resolve(path.join(os.tmpdir(), 'newmark-computer-use'));
      const resolved = path.resolve(screenshotPath);
      const relative = path.relative(screenshotRoot, resolved);
      try {
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error('Ephemeral screenshot escaped the Computer Use temporary directory');
        }
        const stat = fs.lstatSync(resolved);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > 1024 * 1024) {
          throw new Error('Ephemeral screenshot failed the WSL transfer boundary check');
        }
        const extension = path.extname(resolved).toLowerCase();
        const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.png' ? 'image/png' : '';
        if (!mime) throw new Error('Ephemeral screenshot format is not allowed');
        const bytes = fs.readFileSync(resolved);
        const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
        const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        if ((mime === 'image/png' && !isPng) || (mime === 'image/jpeg' && !isJpeg)) {
          throw new Error('Ephemeral screenshot content does not match its file extension');
        }
        parsed.vision_image_data_url = `data:${mime};base64,${bytes.toString('base64')}`;
      } catch {
        parsed.screenshot_warning = parsed.screenshot_warning || 'Ephemeral screenshot was unavailable for the WSL vision input; semantic UI data remains available.';
      } finally {
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
          try { fs.unlinkSync(resolved); } catch {}
        }
      }
      return serialized ? JSON.stringify(parsed) : parsed;
    };
    const runWslHostTool: WslHostToolHandler = async (request: WslHostToolRequest, signal?: AbortSignal): Promise<unknown> => {
      const target = normalizeConversationTarget(conversationRuntimeTarget({
        workspaceId: request.context.workspaceId,
        conversationId: request.context.conversationId,
      }));
      if (!request.context.runtimeKey || request.context.runtimeKey !== target.runtimeKey) {
        throw new Error('WSL host tool target/context mismatch');
      }
      const routedTarget = {
        workspaceId: target.workspaceId,
        conversationId: target.conversationId,
        runtimeKey: target.runtimeKey,
        workspaceKey: target.workspaceKey,
        workspacePath: target.workspace?.path || root,
      };
      const routedContext = {
        conversationId: target.conversationId,
        workspaceId: target.workspaceId,
        actorId: request.context.actorId,
        workspacePath: target.workspace?.path || root,
        backend: 'wsl',
        mode: request.context.mode || agent?.mode || 'build',
        runtimeKey: target.runtimeKey,
        allowEphemeralVisionImage: request.context.allowEphemeralVisionImage === true,
      };
      if (request.tool === 'browser_control') {
        return await utilityHostToolHandler({ ...request, target: routedTarget }, signal);
      }
      if (request.tool === 'automation') {
        return await utilityHostToolHandler({ ...request, target: routedTarget, context: routedContext }, signal);
      }
      if (request.tool === 'terminal_takeover') {
        return await utilityHostToolHandler({ ...request, target: routedTarget, context: routedContext }, signal);
      }
      const result = await utilityHostToolHandler({ ...request, target: routedTarget, context: routedContext }, signal);
      return request.tool === 'computer_use' || request.tool === 'screen_capture' ? prepareWslComputerUseVisionResult(result) : result;
    };
    runWslHostTool.cancelTarget = (runtimeKey: string): void => utilityHostToolHandler.cancelTarget(runtimeKey);
    const ensureWslConversationPool = (): WslAgentRuntimePool | null => {
      if (!wslBackendEnabled() || !agent) return null;
      if (!wslAgentRuntimePool) {
        const distro = agent.config.getStr('agent', 'wsl_distro') || 'Ubuntu-24.04';
        wslAgentRuntimePool = new WslAgentRuntimePool(distro, root, ensureWslRuntimeBundle());
        wslAgentRuntimePool.subscribe(event => broadcastAgentWorkEvent(event));
        wslAgentRuntimePool.setHostToolHandler(runWslHostTool);
      }
      return wslAgentRuntimePool;
    };
    const ensureWslAgentClient = async (): Promise<WslAgentClient | null> => {
      if (!wslBackendEnabled() || !agent) return null;
      if (!wslAgentClient) {
        const distro = agent.config.getStr('agent', 'wsl_distro') || 'Ubuntu-24.04';
        wslAgentClient = new WslAgentClient(distro, root, ensureWslRuntimeBundle());
        wslAgentClient.subscribe(event => broadcastAgentWorkEvent(event));
        wslAgentClient.subscribeTerminal(event => broadcastTerminalTakeoverEvent(event));
        wslAgentClient.setHostToolHandler(runWslHostTool);
      }
      await wslAgentClient.start();
      return wslAgentClient;
    };

    const mutatingRuntimeKeys = new Set<string>();
    const mutatingWorkspaceKeys = new Set<string>();
    const activePromptLeases = new Map<string, number>();
    const activePromptWorkspaces = new Map<string, number>();
    const assertTargetNotMutating = (target: ConversationRuntimeTarget, allowPromptLease = false): void => {
      const normalized = normalizeConversationTarget(target);
      if (mutatingRuntimeKeys.has(normalized.runtimeKey)
        || mutatingWorkspaceKeys.has(normalized.workspaceKey)
        || (!allowPromptLease && (activePromptLeases.get(normalized.runtimeKey) || 0) > 0)) {
        throw new Error('This conversation or workspace is being mutated. Retry after the operation completes.');
      }
    };
    const runtimeSnapshotForTarget = async (target: ConversationRuntimeTarget): Promise<Record<string, unknown>> => {
      return wslBackendEnabled()
        ? await ensureWslConversationPool()!.snapshot(target)
        : await ensureElectronUtilityPool().snapshot(target) as unknown as Record<string, unknown>;
    };
    const runtimeIsRestarting = (target: ConversationRuntimeTarget): boolean => wslBackendEnabled()
      ? !!wslAgentRuntimePool?.isRestarting(target)
      : !!electronUtilityRuntimePool?.isRestarting(target);
    const runtimeIsStopping = (target: ConversationRuntimeTarget): boolean => wslBackendEnabled()
      ? !!wslAgentRuntimePool?.isStopping(target)
      : !!electronUtilityRuntimePool?.isStopping(target);
    const assertTargetRuntimeMutable = async (target: ConversationRuntimeTarget): Promise<void> => {
      if (runtimeIsRestarting(target)) throw new Error('Cannot mutate a conversation while its runtime is force restarting.');
      if (runtimeIsStopping(target)) throw new Error('Cannot mutate a conversation while its runtime is stopping.');
      const snapshot = await runtimeSnapshotForTarget(target);
      const runtime = snapshot.runtime as { running?: boolean; stopRequested?: boolean } | null | undefined;
      const events = Array.isArray(snapshot.workEvents) ? snapshot.workEvents as Array<{ status?: string }> : [];
      const lastStatus = String(events.at(-1)?.status || '');
      if (runtime?.running || runtime?.stopRequested || lastStatus === 'stopping' || lastStatus === 'force_restarting') {
        throw new Error('Cannot mutate a conversation while its runtime is running or stopping.');
      }
    };
    const peekTargetRuntime = (target: ConversationRuntimeTarget) => wslBackendEnabled()
      ? (wslAgentRuntimePool?.peek(target) || { resident: false, running: false, stopping: false, connected: false })
      : (electronUtilityRuntimePool?.peek(target) || { resident: false, running: false, stopping: false, connected: false });
    const stopTargetRuntime = async (target: ConversationRuntimeTarget): Promise<void> => {
      if (wslBackendEnabled()) await wslAgentRuntimePool?.stopTarget(target);
      else await electronUtilityRuntimePool?.stopTarget(target);
    };
    const forceStopTargetRuntime = async (target: ConversationRuntimeTarget): Promise<void> => {
      if (wslBackendEnabled()) await wslAgentRuntimePool?.forceStopTarget(target);
      else await electronUtilityRuntimePool?.forceStopTarget(target);
    };
    const archiveInFlight = new Map<string, Promise<{ ok: boolean; error?: string; fileName?: string; conversationId?: string; workspaceId?: string }>>();
    const isolatedConversationAgent = (target: ConversationRuntimeTarget): Agent => {
      const normalized = normalizeConversationTarget(target);
      const isolated = new Agent(root, { agentOnly: true });
      if (normalized.workspace) {
        isolated.workspace.current = {
          id: normalized.workspace.id,
          name: normalized.workspace.name,
          path: normalized.workspace.path,
          isInternal: normalized.workspace.isInternal,
          hostBinding: '',
          icon: '',
          kind: normalized.workspace.kind === 'ssh' ? 'ssh' : 'local',
        };
        isolated.config.loadWorkspaceConfig(normalized.workspace.path);
      } else {
        isolated.workspace.current = null;
        isolated.config.clearWorkspaceOverrides();
      }
      isolated.setConversation(normalized.conversationId);
      return isolated;
    };
    const mutateTargetConversation = async <T>(target: ConversationRuntimeTarget, mutation: () => T | Promise<T>): Promise<T> => {
      const normalized = normalizeConversationTarget(target);
      assertTargetNotMutating(normalized);
      mutatingRuntimeKeys.add(normalized.runtimeKey);
      try {
        await assertTargetRuntimeMutable(normalized);
        const result = await mutation();
        await stopTargetRuntime(normalized);
        return result;
      } finally {
        mutatingRuntimeKeys.delete(normalized.runtimeKey);
      }
    };

    ipcMain.handle('agent:send', async (_event, message: string | AgentPromptMessage, targetInput?: ConversationTargetInput) => {
      if (!agent) return { tokens: [], error: 'Agent not initialized' };
      let promptLeaseKey = '';
      let promptLeaseWorkspaceKey = '';
      try {
        const target = conversationRuntimeTarget(targetInput);
        assertTargetNotMutating(target, true);
        // A new Build/Plan/Goal instruction exits any paused Flow owned by THIS
        // conversation into the user's new process (Flow pause state exit rule).
        // flow:run already discards the suspension for a new Flow workflow.
        // Other conversations' paused Flows are never touched by this send.
        if (activeFlowStateFor(target)) clearFlowSuspensionForNewWork(target);
        const normalizedPromptTarget = normalizeConversationTarget(target);
        promptLeaseKey = normalizedPromptTarget.runtimeKey;
        promptLeaseWorkspaceKey = normalizedPromptTarget.workspaceKey;
        activePromptLeases.set(promptLeaseKey, (activePromptLeases.get(promptLeaseKey) || 0) + 1);
        activePromptWorkspaces.set(promptLeaseWorkspaceKey, (activePromptWorkspaces.get(promptLeaseWorkspaceKey) || 0) + 1);
        const targetConversation = target.conversationId;
        // 发送命令时锁定输入框选择的模型：接受命令后的整个运行过程都以该
        // 模型为准（唯一例外是显式的不可用回退，且回退会以结构化事件同步
        // 到前端输入框下方的选择区，而不是隐藏的参数回退）。
        const requestedModel = agent.model;
        const options = {
          mode: agent.mode,
          model: agent.ensureUsableModelSelection(),
          intelligence: agent.intelligence,
          inputMode: agent.inputMode,
          engine: agent.engine,
        };
        if (options.model && requestedModel && options.model !== requestedModel) {
          const usableConfig = agent.activeModelConfig();
          broadcastAgentWorkEvent({
            id: `model-fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            conversationId: target.conversationId,
            type: 'status',
            content: `[Model fallback] ${requestedModel} unavailable; switched to ${options.model}.`,
            mode: agent.modeName(),
            model: options.model,
            timestamp: new Date().toISOString(),
            workspaceId: target.workspaceId,
            workspaceKey: target.workspaceKey,
            fallback: { from: requestedModel, to: options.model, providerId: usableConfig?.provider_id || agent.activeDeployment()?.providerId },
          });
        }
        const queueMode = agent.inputMode === 'guide' ? 'steer' : 'followUp';
        let result;
        if (wslBackendEnabled()) {
          const pool = ensureWslConversationPool();
          if (!pool) return { error: 'WSL Agent backend is enabled but unavailable.' };
          result = await pool.prompt({
            message,
            target,
            conversationId: targetConversation,
            options,
            queueMode,
            workspace: target.workspace ? {
              id: target.workspace.id,
              name: target.workspace.name,
              path: target.workspace.path,
              isInternal: target.workspace.isInternal,
              kind: target.workspace.kind,
            } : null,
          });
        } else {
          result = await ensureElectronUtilityPool().prompt({ message, target, options, queueMode });
        }
        const previousConversation = agent.activeConversationId || 'default';
        // The isolated runtime owns conversation persistence for this prompt.
        // Calling setConversation() here first saves the host's stale snapshot
        // and can overwrite the plan, subagents, or messages just produced by
        // the Utility/WSL runtime. The prompt result already carries the fresh
        // target-scoped snapshot consumed by the renderer.
        return {
          ...result,
          conversationId: targetConversation,
          activeConversationId: agent.activeConversationId || previousConversation,
          conversationLocked: false,
          workspaceId: result.target.workspaceId,
        };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e) };
      } finally {
        if (promptLeaseKey) {
          const remaining = (activePromptLeases.get(promptLeaseKey) || 1) - 1;
          if (remaining > 0) activePromptLeases.set(promptLeaseKey, remaining);
          else activePromptLeases.delete(promptLeaseKey);
        }
        if (promptLeaseWorkspaceKey) {
          const remaining = (activePromptWorkspaces.get(promptLeaseWorkspaceKey) || 1) - 1;
          if (remaining > 0) activePromptWorkspaces.set(promptLeaseWorkspaceKey, remaining);
          else activePromptWorkspaces.delete(promptLeaseWorkspaceKey);
        }
      }
    });

    ipcMain.handle('browser:registerGuest', (event, guestContentsId: number, target?: ConversationTargetInput) => {
      const guest = webContents.fromId(Number(guestContentsId || 0));
      return { accepted: !!guest && registerBrowserGuest(event.sender, guest, target) };
    });
    ipcMain.handle('browser:control', async (_event, request: BrowserControlRequest) => {
      return await BrowserControl.run(request);
    });
    ipcMain.handle('flow:run', async (_event, name: string, input = '', start = 0) => {
      if (!agent) return { ok: false, error: 'Agent not initialized' };
      // Bind the Flow to the conversation that started it, exactly like resume.
      // Running on an isolated conversation agent keeps the Flow's builds pinned
      // to its owning conversation id and branch, so switching conversations
      // mid-run can never make the next component write into another
      // conversation or strand the running flag.
      const flowTarget = conversationRuntimeTarget(agent.activeConversationId || 'default');
      const flowKey = activeFlowStateKey(flowTarget);
      const existing = activeFlowsByRuntimeKey.get(flowKey) || null;
      if (existing && (existing.reason === 'question' || existing.reason === 'interrupted')) {
        await discardFlowSuspensionForTarget(flowTarget);
      } else if (existing?.abortController) {
        return { ok: false, error: `Flow is already running: ${existing.name || '(unnamed)'}` };
      }
      const flowDir = path.join(agent.rootPath, 'Flow');
      const found = FlowEngine.findWorkflow(String(name || ''), flowDir);
      if (!found) return { ok: false, error: `Workflow not found: ${name}` };
      const workflow = FlowEngine.load(flowDir, found);
      if (!workflow) return { ok: false, error: `Workflow failed to load: ${found}` };
      const flowAgent = isolatedConversationAgent(flowTarget);
      const previousMode = flowAgent.mode;
      const previousFlow = flowAgent.flow;
      const previousPc = flowAgent.flowPc;
      if (previousMode === 'plan') return { ok: false, error: 'Plan mode is fully read-only; Flow execution is blocked.' };
      const flowAbortController = new AbortController();
      const flowState: ActiveFlowState = {
        workflow,
        input: String(input || ''),
        componentId: 0,
        completedResults: [],
        previousMode,
        previousFlow,
        previousPc,
        reason: '',
        target: flowTarget,
        abortController: flowAbortController,
        name: workflow.name,
        flowAgent,
      };
      activeFlowsByRuntimeKey.set(flowKey, flowState);
      const stopRelayingFlowEvents = relayFlowAgentWorkEvents(flowAgent, flowTarget);
      let suspended = false;
      try {
        flowAgent.flow = workflow;
        const requestedStart = Number(start);
        flowAgent.flowPc = Number.isFinite(requestedStart) && workflow.components.some(component => component.id === requestedStart)
          ? requestedStart
          : (workflow.components[0]?.id ?? 0);
        await runFlow(flowAgent, workflow, {
          startInput: String(input || ''),
          startPc: flowAgent.flowPc,
          quiet: true,
          signal: flowAbortController.signal,
        });
        return {
          ok: true,
          name: workflow.name,
          mode: flowAgent.mode,
          status: flowAgent.status,
          chatMessages: flowAgent.chatMessages,
          workRuns: flowAgent.getConversationSnapshot(flowAgent.activeConversationId).workRuns,
          conversations: flowAgent.listConversationStates(),
          conversationId: flowAgent.activeConversationId,
          conversationPlan: flowAgent.getConversationPlan(),
          linkedPlan: flowAgent.getLinkedPlan(),
          subagents: flowAgent.subagents.listAll().map(record => flowAgent.subagents.toRecord(record.id)).filter(Boolean),
          diffs: flowAgent.fileDiffs.map(d => ({ path: d.path, old: d.oldContent ? d.oldContent.split(/\r?\n/).length : 0, new: d.newContent ? d.newContent.split(/\r?\n/).length : 0 })),
        };
      } catch (e) {
        if (flowState.archiveRequested) {
          // Archive already force-finalized the current Build ledger. Do not
          // persist an interrupted Flow suspension or return Flow ownership
          // to the renderer after the target has been removed.
          flowAgent.pendingOptions = [];
          suspended = false;
          return { ok: false, archived: true, error: 'Flow discarded because the conversation was archived.' };
        }
        if (e instanceof FlowQuestionPendingError) {
          suspended = true;
          flowAgent.flowPc = e.componentId;
          flowAgent.setMode('flow');
          await setTargetFlowMode(flowTarget, 'flow');
          flowState.componentId = e.componentId;
          flowState.completedResults = e.completedResults;
          flowState.reason = 'question';
          flowState.message = '';
          flowState.abortController = null;
          agent.saveStoredFlowSuspension(persistedFlowSuspensionRecord(flowState), flowTarget.conversationId);
          return {
            ok: true,
            pending: true,
            name: workflow.name,
            mode: 'flow',
            options: flowAgent.pendingOptions,
            chatMessages: flowAgent.chatMessages,
            workRuns: flowAgent.getConversationSnapshot(flowAgent.activeConversationId).workRuns,
          };
        }
        if (isUserFlowAbort(e)) {
          // First Stop/Esc or a system interruption: do not exit. Fall through
          // to the interrupted-suspension path so the renderer enters the Flow
          // pause state ("Flow 接管已暂停") instead of leaving the Flow takeover.
          // A second Stop/Esc force-stops and exits later.
        }
        suspended = true;
        const buildFailure = e as { componentId?: unknown; completedResults?: FlowCompletedResult[]; message?: unknown };
        const interruptedComponentId = typeof buildFailure.componentId === 'number'
          ? Math.max(0, Math.floor(buildFailure.componentId))
          : Math.max(0, flowAgent.flowPc);
        const interruptedMessage = String(
          typeof buildFailure.message === 'string' && buildFailure.message
            ? buildFailure.message
            : e instanceof Error
              ? e.message
              : String(e || 'Flow interrupted.')
        ).slice(0, 320);
        flowAgent.flowPc = interruptedComponentId;
        flowAgent.setMode('flow');
        await setTargetFlowMode(flowTarget, 'flow');
        flowState.componentId = interruptedComponentId;
        flowState.completedResults = Array.isArray(buildFailure.completedResults) ? buildFailure.completedResults : [];
        flowState.reason = 'interrupted';
        flowState.message = interruptedMessage;
        flowState.abortController = null;
        flowAgent.pendingOptions = [];
        agent.saveStoredFlowSuspension(persistedFlowSuspensionRecord(flowState), flowTarget.conversationId);
        return {
          ok: true,
          pending: true,
          interrupted: true,
          error: interruptedMessage,
          name: workflow.name,
          mode: 'flow',
          options: [],
          chatMessages: flowAgent.chatMessages,
          workRuns: flowAgent.getConversationSnapshot(flowAgent.activeConversationId).workRuns,
        };
      } finally {
        stopRelayingFlowEvents();
        if (!suspended) {
          flowAgent.flow = previousFlow;
          flowAgent.flowPc = previousPc;
          flowAgent.setMode(previousMode);
          activeFlowsByRuntimeKey.delete(flowKey);
        }
      }
    });
    const resumeFlowForTarget = async (response: string, targetInput?: ConversationTargetInput) => {
      if (!agent) return { ok: false, error: 'No suspended Flow is waiting for user input.' };
      const requestedTarget = targetInput ? conversationRuntimeTarget(targetInput) : null;
      const suspension = requestedTarget ? activeFlowStateFor(requestedTarget) : null;
      if (!suspension || (suspension.reason !== 'question' && suspension.reason !== 'interrupted')) {
        // No paused Flow exists for this conversation. If the Flow is already
        // running, tell the renderer so it keeps the running takeover instead
        // of tearing it down or showing a spurious error.
        if (suspension?.abortController) {
          return { ok: true, alreadyRunning: true, flow: suspension.name || suspension.workflow.name };
        }
        return { ok: false, error: 'No suspended Flow is waiting for user input.' };
      }
      if (suspension.abortController) {
        // The Flow is already running (a stale resume click from a bubble that
        // has not yet refreshed to the running takeover). Report the actual
        // state instead of an error so the renderer reconciles to "running".
        return { ok: true, alreadyRunning: true, flow: suspension.name || suspension.workflow.name };
      }
      const flowTarget = suspension.target;
      const flowKey = activeFlowStateKey(flowTarget);
      const flowAgent = isolatedConversationAgent(flowTarget);
      suspension.flowAgent = flowAgent;
      // A previous Flow may have been interrupted just before its isolated
      // Agent flushed the work ledger. Reconcile only this explicitly paused
      // target before starting the next component; the normal runner guard
      // remains intact for genuine concurrent Builds.
      flowAgent.interruptRunningConversationWorkRuns(flowTarget, 'interrupted');
      const flowAbortController = new AbortController();
      suspension.abortController = flowAbortController;
      activeFlowsByRuntimeKey.set(flowKey, suspension);
      agent.clearStoredFlowSuspension(flowTarget.conversationId);
      const stopRelayingFlowEvents = relayFlowAgentWorkEvents(flowAgent, flowTarget);
      let suspendedAgain = false;
      try {
        flowAgent.flow = suspension.workflow;
        flowAgent.flowPc = suspension.componentId;
        flowAgent.setMode('flow');
        await runFlow(flowAgent, suspension.workflow, {
          startInput: suspension.input,
          startPc: suspension.componentId,
          resumePrompt: suspension.reason === 'interrupted' ? '' : String(response || ''),
          completedResults: suspension.completedResults,
          quiet: true,
          signal: flowAbortController.signal,
        });
        return {
          ok: true,
          name: suspension.workflow.name,
          mode: flowAgent.mode,
          status: flowAgent.status,
          chatMessages: flowAgent.chatMessages,
          workRuns: flowAgent.getConversationSnapshot(flowAgent.activeConversationId).workRuns,
          conversations: flowAgent.listConversationStates(),
          conversationId: flowAgent.activeConversationId,
          conversationPlan: flowAgent.getConversationPlan(),
          linkedPlan: flowAgent.getLinkedPlan(),
          subagents: flowAgent.subagents.listAll().map(record => flowAgent.subagents.toRecord(record.id)).filter(Boolean),
          diffs: flowAgent.fileDiffs.map(d => ({ path: d.path, old: d.oldContent ? d.oldContent.split(/\r?\n/).length : 0, new: d.newContent ? d.newContent.split(/\r?\n/).length : 0 })),
        };
      } catch (error) {
        if (suspension.archiveRequested) {
          flowAgent.pendingOptions = [];
          suspendedAgain = false;
          return { ok: false, archived: true, error: 'Flow discarded because the conversation was archived.' };
        }
        if (error instanceof FlowQuestionPendingError) {
          suspendedAgain = true;
          flowAgent.flowPc = error.componentId;
          flowAgent.setMode('flow');
          await setTargetFlowMode(flowTarget, 'flow');
          suspension.componentId = error.componentId;
          suspension.completedResults = error.completedResults;
          suspension.reason = 'question';
          suspension.message = '';
          suspension.abortController = null;
          agent.saveStoredFlowSuspension(persistedFlowSuspensionRecord(suspension), flowTarget.conversationId);
          return {
            ok: true,
            pending: true,
            name: suspension.workflow.name,
            mode: 'flow',
            options: flowAgent.pendingOptions,
            chatMessages: flowAgent.chatMessages,
            workRuns: flowAgent.getConversationSnapshot(flowAgent.activeConversationId).workRuns,
          };
        }
        // A Stop/Esc during a resumed Flow is another pause, not a terminal
        // IPC failure. Fall through to the same interrupted-suspension path as
        // the initial Flow run so repeated pause/resume clicks remain valid.
        suspendedAgain = true;
        const resumeFailure = error as { componentId?: unknown; completedResults?: FlowCompletedResult[]; message?: unknown };
        const interruptedComponentId = typeof resumeFailure.componentId === 'number'
          ? Math.max(0, Math.floor(resumeFailure.componentId))
          : Math.max(0, suspension.componentId);
        const interruptedMessage = String(
          typeof resumeFailure.message === 'string' && resumeFailure.message
            ? resumeFailure.message
            : error instanceof Error
              ? error.message
              : String(error || 'Flow interrupted.')
        ).slice(0, 320);
        flowAgent.flowPc = interruptedComponentId;
        flowAgent.setMode('flow');
        await setTargetFlowMode(flowTarget, 'flow');
        suspension.componentId = interruptedComponentId;
        suspension.completedResults = Array.isArray(resumeFailure.completedResults) ? resumeFailure.completedResults : suspension.completedResults;
        suspension.reason = 'interrupted';
        suspension.message = interruptedMessage;
        suspension.abortController = null;
        flowAgent.pendingOptions = [];
        agent.saveStoredFlowSuspension(persistedFlowSuspensionRecord(suspension), flowTarget.conversationId);
        return {
          ok: true,
          pending: true,
          interrupted: true,
          error: interruptedMessage,
          name: suspension.workflow.name,
          mode: 'flow',
          options: [],
          chatMessages: flowAgent.chatMessages,
          workRuns: flowAgent.getConversationSnapshot(flowAgent.activeConversationId).workRuns,
        };
      } finally {
        stopRelayingFlowEvents();
        if (!suspendedAgain) {
          flowAgent.flow = suspension.previousFlow;
          flowAgent.flowPc = suspension.previousPc;
          flowAgent.setMode(suspension.previousMode);
          activeFlowsByRuntimeKey.delete(flowKey);
          await setTargetFlowMode(flowTarget, suspension.previousMode);
        }
      }
    };
    ipcMain.handle('flow:resume', async (_event, response: string, targetInput?: ConversationTargetInput) =>
      await resumeFlowForTarget(response, targetInput));
    ipcMain.handle('agent:setMode', async (_event, mode: string) => {
      if (agent) {
        const nextMode = mode as AgentMode;
        agent.setMode(nextMode);
        const target = conversationRuntimeTarget(agent.activeConversationId || 'default');
        // The target-bound runner owns conversation persistence. Updating only
        // the host Agent lets an existing/cold runner restore the stale Build
        // snapshot and silently erase Plan/Goal/Flow on the next send.
        ensureConversationKernel(root)?.setMode(target, nextMode);
        if (wslBackendEnabled()) await ensureWslConversationPool()!.setMode(target, nextMode);
        else await ensureElectronUtilityPool().setMode(target, nextMode);
      }
      return agent?.mode;
    });

    ipcMain.handle('agent:setModel', async (_event, model: string) => {
      if (agent) {
        // Compare the resolved selection (qualified deployment or 'auto')
        // rather than the bare model name, so switching between two
        // same-named models on different providers is still recognized as a
        // real change.
        const before = agent.modelSelectionValue();
        agent.setModel(model, true);
        const after = agent.modelSelectionValue();
        // Compression and kernel reset only make sense when the model actually
        // changed. The renderer sends this on every prompt, so an unchanged
        // selection must not trigger a context compression round (which can
        // run an extra model call on large histories).
        if (after !== before) {
          await agent.compressForModelSwitch();
          resetConversationKernel();
        }
        // Propagate the selection to the target-bound runtime. A running Build
        // block keeps its current model until the next Guide/Next re-enters it;
        // the runtime records the new selection as pending so the context
        // window and the next dequeue both follow the newly selected model.
        const target = conversationRuntimeTarget(agent.activeConversationId || 'default');
        ensureConversationKernel(root)?.setModel(target, model);
        if (wslBackendEnabled()) await ensureWslConversationPool()?.setModel(target, model);
        else await ensureElectronUtilityPool()?.setModel(target, model);
      }
      return agent?.model;
    });

    ipcMain.handle('agent:setIntelligence', async (_event, tier: string) => {
      if (agent) {
        agent.setIntelligence(tier, true);
        resetConversationKernel();
      }
      return agent?.intelligence;
    });

    ipcMain.handle('agent:setProviderEnabled', async (_event, providerId: string, enabled: boolean) => {
      if (!agent) return { ok: false, error: 'Agent not initialized' };
      const ok = agent.config.setProviderEnabled(String(providerId || ''), !!enabled);
      if (!ok) return { ok: false, error: 'Provider not found' };
      agent.config.save();
      agent.reconcileConversationModelSelection();
      agent.flushConversationState();
      resetConversationKernel();
      return {
        ok: true,
        enabled: !!enabled,
        model: agent.modelSelectionValue(),
        providers: sanitizeProvidersForState(agent.config.providers()),
        models: agent.allModelNames(),
      };
    });

    ipcMain.handle('agent:setInputMode', async (_event, mode: string, targetInput?: ConversationTargetInput) => {
      if (!agent) return mode === 'next' ? 'next' : 'guide';
      const target = normalizeConversationTarget(conversationRuntimeTarget(targetInput));
      const current = normalizeConversationTarget(conversationRuntimeTarget({
        workspaceId: agent.workspace.current?.id || '',
        conversationId: agent.activeConversationId,
      }));
      const persisted = target.runtimeKey === current.runtimeKey
        ? agent.setInputMode(mode)
        : isolatedConversationAgent(target).setInputMode(mode);
      if (wslBackendEnabled()) await ensureWslConversationPool()!.setInputMode(target, persisted);
      else await ensureElectronUtilityPool().setInputMode(target, persisted);
      return persisted;
    });
    ipcMain.handle('agent:setConversation', async (_event, id: string) => {
      return agent?.setConversationFromStorage(id);
    });
    ipcMain.handle('agent:ensureConversation', async (_event, targetInput: ConversationTargetInput) => {
      if (!agent) return {};
      const target = conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default');
      return await runtimeSnapshotForTarget(target);
    });
    ipcMain.handle('agent:activateConversation', async (_event, targetInput: ConversationTargetInput) => {
      if (!agent) return {};
      const target = conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default');
      const workspace = target.workspace ? {
        id: target.workspace.id,
        name: target.workspace.name,
        path: target.workspace.path,
        isInternal: target.workspace.isInternal,
        hostBinding: '',
        conversationStatePrefix: target.workspace.conversationStatePrefix,
        icon: '',
        kind: target.workspace.kind === 'ssh' ? 'ssh' as const : 'local' as const,
      } : agent.workspace.current;
      agent.persistActiveConversationSelection(target.conversationId, workspace);
      const resident = peekTargetRuntime(target).resident;
      if (!resident) {
        return {
          ...localConversationSnapshotForStartup(target),
          runtimeDeferred: true,
        };
      }
      return {
        ...await runtimeSnapshotForTarget(target),
        runtimeDeferred: false,
      };
    });
    ipcMain.handle('agent:setConversationBranchCommunication', async (_event, targetInput: ConversationTargetInput, enabled: boolean) => {
      if (!agent) return false;
      const target = conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default');
      return mutateTargetConversation(target, () => isolatedConversationAgent(target).setBranchCommunication(enabled !== false));
    });
    ipcMain.handle('agent:computerUseState', async (_event, targetInput?: ConversationTargetInput) => {
      if (!agent) return { enabled: false, occupied: false, runtimeKey: '' };
      const target = normalizeConversationTarget(conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default'));
      return utilityHostToolHandler.computerUseState(target.runtimeKey);
    });
    ipcMain.handle('agent:setComputerUseEnabled', async (_event, targetInput: ConversationTargetInput, enabled: boolean) => {
      if (!agent) return { ok: false, error: 'Agent not initialized' };
      const target = normalizeConversationTarget(conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default'));
      const result = utilityHostToolHandler.setComputerUseEnabled(target.runtimeKey, enabled !== false, `conversation:${target.conversationId}`);
      if (!result.ok) return result;
      if (enabled === false) {
        try {
          const { runComputerUse } = require('./tools/computerUse') as typeof import('./tools/computerUse');
          await runComputerUse({ action: 'takeover_stop', workspacePath: target.workspace?.path || root, ownerId: target.runtimeKey, invocation: 'agent' });
        } catch {}
      }
      return result;
    });
    ipcMain.handle('agent:updateGoal', async (_event, goal: string, targetInput?: ConversationTargetInput) => {
      if (!agent) return null;
      const target = conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default');
      return mutateTargetConversation(target, () => {
        const isolated = isolatedConversationAgent(target);
        isolated.updateGoal(goal);
        isolated.setMode('goal');
        isolated.saveWorkspaceConversationState(true);
        return isolated.getConversationSnapshot(target.conversationId).goal;
      });
    });

    ipcMain.handle('agent:toggleGoalPause', async (_event, targetInput?: ConversationTargetInput) => {
      if (!agent) return false;
      const target = conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default');
      const residentResult = wslBackendEnabled()
        ? await ensureWslConversationPool()!.toggleGoalPause(target)
        : await ensureElectronUtilityPool().toggleGoalPause(target);
      if (residentResult !== null) return residentResult;
      return mutateTargetConversation(target, () => isolatedConversationAgent(target).toggleGoalPause());
    });
    ipcMain.handle('agent:clearGoal', async (_event, targetInput?: ConversationTargetInput) => {
      if (!agent) return false;
      const target = conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default');
      const residentResult = wslBackendEnabled()
        ? await ensureWslConversationPool()!.clearGoal(target)
        : await ensureElectronUtilityPool().clearGoal(target);
      if (residentResult !== null) return residentResult;
      return mutateTargetConversation(target, () => {
        isolatedConversationAgent(target).clearGoal();
        return true;
      });
    });

    ipcMain.handle('agent:getState', async (event, targetInput?: ConversationTargetInput) => {
      const startupPrewarmRequest = isStartupPrewarmSender(event);
      if (startupPrewarmRequest && !agent && startupAgentReady) await startupAgentReady;
      if (!agent) return {};
      const wslDistros = availableWslDistros();
      const target = conversationRuntimeTarget(targetInput);
      // Renderer-side message windowing: a long-running conversation is never
      // transferred wholesale across IPC. The snapshot returns a window of the
      // most recent messages plus total count; the renderer fetches older
      // windows on demand. Full history remains persisted and intact.
      const windowInput = (targetInput && typeof targetInput === 'object' && !Array.isArray(targetInput)
        ? targetInput as { window?: number; before?: number }
        : {});
      const requestedWindow = Math.max(1, Math.floor(Number(windowInput.window) || 0) || 200);
      const requestedBefore = Math.max(0, Math.floor(Number(windowInput.before) || 0));
      let conversationSnapshot: Record<string, unknown>;
      try {
        conversationSnapshot = startupPrewarmRequest
          ? localConversationSnapshotForStartup(target)
          : wslBackendEnabled()
            ? await ensureWslConversationPool()!.snapshot(target)
            : await ensureElectronUtilityPool().snapshot(target);
      } catch (error) {
        conversationSnapshot = {
          target,
          workspaceId: target.workspaceId,
          conversationId: target.conversationId,
          runtimeStatus: 'unavailable',
          runtimeError: error instanceof Error ? error.message : String(error),
          queued: { steering: [], followUp: [] },
          workEvents: [],
          workRuns: [],
        };
      }
      const fullMessages = Array.isArray(conversationSnapshot.chatMessages) ? conversationSnapshot.chatMessages as Array<unknown> : [];
      const totalMessages = fullMessages.length;
      const before = requestedBefore > 0 ? Math.min(totalMessages, requestedBefore) : totalMessages;
      const windowStart = Math.max(0, before - requestedWindow);
      const windowedMessages = fullMessages.slice(windowStart, before);
      return {
        mode: agent.mode,
        model: agent.modelSelectionValue(),
        modelLabel: agent.modelLabel(),
        resolvedDeployment: agent.activeDeployment(),
        routeDecision: agent.lastRouteDecision,
        intelligence: agent.intelligence,
        ...conversationSnapshot,
        chatMessages: windowedMessages,
        totalMessages,
        windowStart,
        conversationLocked: conversationSnapshot.conversationLocked ?? false,
        status: conversationSnapshot.status ?? 'idle',
        goal: conversationSnapshot.goal ?? null,
        models: agent.allModelNames(),
        providers: sanitizeProvidersForState(agent.config.providers()),
        workspaces: { internal: agent.workspace.internal, external: agent.workspace.external, current: agent.workspace.current },
        skills: agent.skills.listDetailed(),
        subagents: conversationSnapshot.subagents,
        fileDiffs: conversationSnapshot.fileDiffs || [],
        pendingOptions: conversationSnapshot.pendingOptions || agent.pendingOptions,
        flowSuspension: flowSuspensionForTarget(target),
        flowRunning: flowRunningForTarget(target),
        computerUse: utilityHostToolHandler.computerUseState(normalizeConversationTarget(target).runtimeKey),
        draft: agent.getStoredConversationDraft(target.conversationId) || '',
        proxyEnabled: agent.config.getBool('proxy', 'enabled'),
        proxyUrl: agent.config.getStr('proxy', 'url'),
        proxyAuth: agent.config.getStr('proxy', 'auth'),
        glassAlpha: agent.config.getNum('ui', 'glass_alpha') ?? 0.85,
        leftPanelCollapsed: agent.config.getBool('ui', 'left_panel_collapsed'),
        rightPanelCollapsed: agent.config.getBool('ui', 'right_panel_collapsed'),
        bottomPanelCollapsed: agent.config.getBool('ui', 'bottom_panel_collapsed'),
        secondaryPanelCollapsed: agent.config.getBool('ui', 'secondary_panel_collapsed'),
        darkMode: agent.config.getStr('ui', 'dark_mode'),
        backgroundColor: normalizeUiBackgroundColor(agent.config.getStr('ui', 'background_color')),
        fontFamily: normalizeUiFontFamily(agent.config.getStr('ui', 'font_family')),
        minimizeToTray: agent.config.getBool('ui', 'minimize_to_tray'),
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
        expandToolsDefault: agent.config.getBool('general', 'expand_tools') ?? true,
        contextCompression: conversationSnapshot.contextCompression ?? null,
        contextWindow: conversationSnapshot.contextWindow || { estimatedTokens: 0, maxTokens: 1, ratio: 0, warning: 'ok', model: String(conversationSnapshot.model || agent.model) },
        agentBackend: wslBackendEnabled()
          ? (wslAgentRuntimePool?.status(target) || { enabled: true, connected: false, distro: agent.config.getStr('agent', 'wsl_distro') || 'Ubuntu-24.04', pid: 0, error: '' })
          : {
            ...(startupPrewarmRequest
              ? electronUtilityRuntimePool?.status(target) || {
                enabled: true,
                connected: false,
                pid: 0,
                error: '',
                runtimeKey: normalizeConversationTarget(target).runtimeKey,
                quarantined: false,
              }
              : ensureElectronUtilityPool().status(target)),
            enabled: false,
            distro: '',
          },
        configuredAgentBackend: agent.config.getBool('agent', 'run_in_wsl') ? 'wsl' : 'windows',
        agentBackendRestartRequired: (agent.config.getBool('agent', 'run_in_wsl') ? 'wsl' : 'windows') !== activeAgentBackendMode,
        remoteTouchEnabled: agent.config.getBool('remote', 'touch_enabled'),
        wslAvailable: wslDistros.length > 0,
        wslDistros,
      };
    });
    resolveStartupBackendReady();

    ipcMain.handle('conversation:saveDraft', async (_event, conversationId: string, draft: string | null) => {
      if (!agent) return false;
      agent.saveStoredConversationDraft(draft ?? null, String(conversationId || '') || agent.activeConversationId || 'default');
      return true;
    });

    ipcMain.handle('conversation:getDraft', async (_event, conversationId?: string) => {
      if (!agent) return '';
      return agent.getStoredConversationDraft(String(conversationId || '') || agent.activeConversationId || 'default') || '';
    });

    // Renderer pagination: fetch an earlier window of a conversation's chat
    // messages. Only the requested slice crosses IPC; full history stays
    // persisted and untouched.
    ipcMain.handle('conversation:loadEarlier', async (_event, targetInput: ConversationTargetInput & { window?: number; before?: number }) => {
      if (!agent) return { chatMessages: [], totalMessages: 0, windowStart: 0 };
      const target = conversationRuntimeTarget(targetInput);
      const windowInput = targetInput && typeof targetInput === 'object' ? targetInput as { window?: number; before?: number } : {};
      const requestedWindow = Math.max(1, Math.floor(Number(windowInput.window) || 0) || 200);
      const requestedBefore = Math.max(0, Math.floor(Number(windowInput.before) || 0));
      const snapshot = wslBackendEnabled()
        ? await ensureWslConversationPool()!.snapshot(target)
        : await ensureElectronUtilityPool().snapshot(target);
      const fullMessages = Array.isArray(snapshot.chatMessages) ? snapshot.chatMessages as Array<unknown> : [];
      const totalMessages = fullMessages.length;
      const before = Math.min(totalMessages, requestedBefore);
      const windowStart = Math.max(0, before - requestedWindow);
      return {
        chatMessages: fullMessages.slice(windowStart, before),
        totalMessages,
        windowStart,
        conversationId: target.conversationId,
        workspaceId: target.workspaceId,
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

    ipcMain.handle('agent:renameConversation', async (_event, id: string, title: string) => {
      if (!agent) return false;
      return agent.renameConversation(id, title);
    });

    ipcMain.handle('agent:reorderConversations', async (_event, ids: string[]) => {
      if (!agent) return false;
      return agent.reorderConversations(ids);
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
        workspaceId: String(item.workspaceId || ''),
        workspaceName: String(item.workspaceName || ''),
        conversationMode: item.conversationMode === 'existing' ? 'existing' : 'new',
        conversationId: String(item.conversationId || ''),
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
              case 'glassAlpha': agent.config.set('ui', 'glass_alpha', value); break;
              case 'theme': agent.config.set('ui', 'dark_mode', normalizeUiTheme(value)); break;
              case 'backgroundColor': agent.config.set('ui', 'background_color', normalizeUiBackgroundColor(value)); break;
              case 'fontFamily': agent.config.set('ui', 'font_family', normalizeUiFontFamily(value)); break;
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
              case 'clearLearnedAutoPreferences': if (value === true) agent.clearLearnedModelPreferences(); break;
              case 'openAIApiMode': agent.config.set('models', 'openai_api_mode', ['chat_stream', 'chat', 'responses'].includes(String(value)) ? value : 'chat_stream'); break;
              case 'nativeTools': agent.config.set('tools', 'enabled', normalizeNativeToolEnabled(value)); break;
              case 'providers': agent.updateProviders(value); break;
              case 'defaultFlow': agent.config.set('flow', 'default_flow', value); break;
              case 'dialogStyle': agent.config.set('ui', 'dialog_style', value); break;
              default: agent.config.set('ui', key, value);
            }
          }
          agent.config.save();
        }
        if (configPatchAffectsConversationRuntime(cfg)) resetConversationKernel();
        return true;
      }
      return false;
    });

    ipcMain.handle('agent:saveSetting', async (_event, section: string, key: string, value: unknown) => {
      if (agent) {
        if (section === 'models' && key === 'providers') agent.updateProviders(value);
        else agent.config.set(section, key, value);
        agent.config.save();
        conversationKernel?.updateSetting(section, key, value);
        await Promise.all([
          electronUtilityRuntimePool?.updateSetting(section, key, value),
          wslAgentRuntimePool?.updateSetting(section, key, value),
        ]);
        if (section === 'remote' && key === 'touch_enabled') {
          const { setHostedServerEnabled } = require('./server') as typeof import('./server');
          await setHostedServerEnabled(value === true || value === 'on');
        }
        return true;
      }
      return false;
    });

    ipcMain.handle('mobile:serverStatus', async () => {
      if (!agent) return { enabled: false, listening: false, reachable: false, state: 'off', host: '', port: 47890, error: 'Agent not initialized', checkedAt: new Date().toISOString(), startedAt: 0 };
      const enabled = agent.config.getBool('remote', 'touch_enabled');
      const { hostedServerStatus } = require('./server') as typeof import('./server');
      return await hostedServerStatus(enabled);
    });

    ipcMain.handle('mobile:setRemoteTouchEnabled', async (_event, value: boolean) => {
      if (!agent) return { ok: false, error: 'Agent not initialized' };
      const enabled = value === true;
      agent.config.set('remote', 'touch_enabled', enabled);
      agent.config.save();
      const { setHostedServerEnabled } = require('./server') as typeof import('./server');
      const status = await setHostedServerEnabled(enabled);
      return { ok: true, ...status };
    });

    ipcMain.handle('agent:openGlobalConfig', async () => {
      if (!agent) return { error: 'Agent is not initialized' };
      const configPath = path.join(agent.rootPath, 'config.json');
      const error = await shell.openPath(configPath);
      return error ? { error } : { ok: true, path: configPath };
    });

    ipcMain.handle('agent:reloadGlobalConfig', async () => {
      if (!agent) return { error: 'Agent is not initialized' };
      if (conversationKernel?.isAnyRunning()) return { error: 'Wait for the active Agent turn to finish before refreshing config.json.' };
      try {
        agent.config.reload();
        if (agent.workspace.current) agent.config.loadWorkspaceConfig(agent.workspace.current.path);
        agent.invalidateSystemPrompt();
        agent.reconcileConversationModelSelection();
        const pools = [electronUtilityRuntimePool?.stopAll(), wslAgentRuntimePool?.stopAll()].filter(
          (operation): operation is Promise<void> => !!operation,
        );
        if (pools.length) {
          await boundedOperation(
            Promise.allSettled(pools).then(results => {
              const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
              if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Runtime cleanup failed');
            }),
            CONFIG_RELOAD_RUNTIME_TIMEOUT_MS,
            'Config refresh runtime cleanup',
          );
        }
        conversationKernel = null;
        return { ok: true, path: path.join(agent.rootPath, 'config.json') };
      } catch (error) {
        return { error: String(error) };
      }
    });
    ipcMain.handle('flow:guide', async (_event, message: string, targetInput?: ConversationTargetInput) => {
      if (!agent) return { ok: false, error: 'No active Flow accepts Guide input.' };
      const target = targetInput ? conversationRuntimeTarget(targetInput) : conversationRuntimeTarget(agent.activeConversationId || 'default');
      const state = activeFlowStateFor(target);
      if (!state?.abortController || !state.flowAgent) return { ok: false, error: 'No active Flow accepts Guide input.' };
      const text = String(message || '').trim();
      if (!text) return { ok: false, error: 'Flow Guide input is empty.' };
      const accepted = state.flowAgent.queueActiveKernelMessage(text, 'steer') || false;
      return accepted ? { ok: true, accepted: true, flow: state.name } : { ok: false, error: 'The current Flow Build is not accepting Guide input.' };
    });
    const stopFlowForTarget = async (targetInput?: ConversationTargetInput) => {
      if (!agent) return { ok: true, action: 'not_running' };
      const target = targetInput
        ? conversationRuntimeTarget(targetInput)
        : conversationRuntimeTarget(agent.activeConversationId || 'default');
      const state = activeFlowStateFor(target);
      if (!state) return { ok: true, action: 'not_running' };
      if (state.reason === 'question' || state.reason === 'interrupted') {
        // A suspension exists: this is the second consecutive Stop/Esc (the Flow
        // is already paused from the first stop). Force stop: discard the
        // suspension, abort any hung kernel run, force-stop the run without
        // restarting the runtime, and exit the Flow takeover state.
        const flowName = state.name || state.workflow.name;
        const forceTarget = state.target;
        await discardFlowSuspensionForTarget(forceTarget);
        state.flowAgent?.abortActiveKernelRun();
        try {
          if (wslBackendEnabled()) await ensureWslConversationPool()!.requestStop(forceTarget);
          else await ensureElectronUtilityPool()!.requestStop(forceTarget);
        } catch {
          // The runtime supervisor owns hard-restart semantics; ignore failures.
        }
        return { ok: true, action: 'force_stopped_pending', flow: flowName };
      }
      if (!state.abortController) return { ok: true, action: 'not_running' };
      // First Stop/Esc while running: cooperative abort. The flow:run handler
      // converts this abort into an interrupted suspension (Flow pause state).
      const controller = state.abortController;
      const flowName = state.name || state.workflow.name;
      controller.abort(new Error(`Flow interrupted by user: ${flowName}`));
      state.flowAgent?.abortActiveKernelRun();
      return { ok: true, action: 'stopping', flow: flowName };
    };
    ipcMain.handle('flow:stop', async (_event, targetInput?: ConversationTargetInput) =>
      await stopFlowForTarget(targetInput));

    ipcMain.handle('agent:readGlobalPrompt', async () => {
      if (!agent) return { error: 'Agent is not initialized' };
      const promptPath = path.join(agent.rootPath, 'agent.md');
      try {
        const stat = await fs.promises.stat(promptPath);
        if (stat.size > 256 * 1024) return { error: 'Global Agent.md exceeds 256 KiB.' };
        return { content: (await fs.promises.readFile(promptPath, 'utf-8')).replace(/^\uFEFF/, '') };
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code || '') : '';
        return code === 'ENOENT' ? { content: '' } : { error: String(error) };
      }
    });

    ipcMain.handle('agent:saveGlobalPrompt', async (_event, content: string) => {
      if (!agent) return { error: 'Agent is not initialized' };
      if (Buffer.byteLength(String(content || ''), 'utf8') > 256 * 1024) return { error: 'Global Agent.md exceeds 256 KiB.' };
      try {
        await fs.promises.writeFile(path.join(agent.rootPath, 'agent.md'), String(content || ''), 'utf-8');
        agent.invalidateSystemPrompt();
        return { ok: true };
      } catch (error) {
        return { error: String(error) };
      }
    });

    ipcMain.handle('agent:enqueueGuide', async (_event, raw: ConversationInputEnvelope) => {
      if (!agent) throw new Error('Agent not initialized');
      const target = conversationRuntimeTarget({ target: raw?.target });
      if (activeFlowStateFor(target)) clearFlowSuspensionForNewWork(target);
      const envelope: ConversationInputEnvelope = {
        clientMessageId: String(raw?.clientMessageId || '').trim().slice(0, 200),
        target: { workspaceId: target.workspaceId, conversationId: target.conversationId },
        runId: String(raw?.runId || '').trim(),
        deliveryMode: raw?.deliveryMode === 'followUp' ? 'followUp' : 'steer',
        text: String(raw?.text || ''),
        goalObjective: String(raw?.goalObjective || '').trim(),
        images: Array.isArray(raw?.images) ? raw.images : [],
        createdAt: String(raw?.createdAt || new Date().toISOString()),
      };
      return wslBackendEnabled()
        ? await ensureWslConversationPool()!.enqueueGuide(envelope)
        : await ensureElectronUtilityPool().enqueueGuide(envelope);
    });

    ipcMain.handle('agent:checkpointConversation', async (_event, request: { target?: ConversationTargetInput }) => {
      if (!agent) throw new Error('Agent not initialized');
      const target = conversationRuntimeTarget(request);
      return wslBackendEnabled()
        ? await ensureWslConversationPool()!.checkpoint(target)
        : await ensureElectronUtilityPool().checkpoint(target);
    });

    ipcMain.handle('agent:compressContext', async (_event, request: { target?: ConversationTargetInput; keepRecent?: number; force?: boolean }) => {
      if (!agent) throw new Error('Agent not initialized');
      const target = conversationRuntimeTarget(request);
      const options = {
        keepRecent: Number.isFinite(Number(request?.keepRecent)) ? Math.floor(Number(request.keepRecent)) : undefined,
        force: request?.force !== false,
      };
      return wslBackendEnabled()
        ? await ensureWslConversationPool()!.contextCompress(target, options)
        : await ensureElectronUtilityPool()!.contextCompress(target, options);
    });

    ipcMain.handle('agent:rateAutoRoute', async (_event, request: { target?: ConversationTargetInput; score?: number; routeId?: string }) => {
      if (!agent) return { ok: false, reason: 'no_active_auto_route' };
      const target = conversationRuntimeTarget(request);
      const score = Number(request?.score);
      const routeId = String(request?.routeId || '');
      return wslBackendEnabled()
        ? await ensureWslConversationPool()!.rateAutoRoute(target, score, routeId)
        : await ensureElectronUtilityPool().rateAutoRoute(target, score, routeId);
    });

    ipcMain.handle('agent:stopConversation', async (_event, request: { target?: ConversationTargetInput; runId?: string; force?: boolean }) => {
      if (!agent) throw new Error('Agent not initialized');
      const target = conversationRuntimeTarget(request);
      const runId = String(request?.runId || '').trim() || undefined;
      // The runtime, not a renderer flag, decides whether this is the first
      // checkpointing stop or the second target-local hard restart.
      return wslBackendEnabled()
        ? await ensureWslConversationPool()!.requestStop(target, runId)
        : await ensureElectronUtilityPool().requestStop(target, runId);
    });

    ipcMain.handle('agent:setWorkRunExpanded', async (_event, request: { target?: ConversationTargetInput; runId?: string; expanded?: boolean }) => {
      if (!agent) return false;
      const target = conversationRuntimeTarget(request);
      const runId = String(request?.runId || '').trim();
      if (!runId) return false;
      return wslBackendEnabled()
        ? await ensureWslConversationPool()!.setWorkRunExpanded(target, runId, request?.expanded !== false)
        : await ensureElectronUtilityPool().setWorkRunExpanded(target, runId, request?.expanded !== false);
    });

    ipcMain.handle('agent:abortConversation', async (_event, targetInput?: ConversationTargetInput) => {
      if (!agent) return false;
      const target = conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default');
      const result = wslBackendEnabled()
        ? await ensureWslConversationPool()!.requestStop(target)
        : await ensureElectronUtilityPool().requestStop(target);
      return result.action !== 'not_running' && result.action !== 'stale';
    });

    ipcMain.handle('agent:rewindConversation', async (_event, targetInput: ConversationTargetInput, messageIndex: number) => {
      if (!agent) return { error: 'Agent not initialized' };
      const target = conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default');
      try {
        const snapshot = await mutateTargetConversation(target, () => wslBackendEnabled()
          ? ensureWslConversationPool()!.rewind(target, messageIndex)
          : ensureElectronUtilityPool().rewind(target, messageIndex));
        return { ...snapshot, queued: { steering: [], followUp: [] }, workEvents: [] };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle('agent:branchConversation', async (_event, targetInput: ConversationTargetInput, messageIndex: number, text: string, locator?: ConversationBranchLocator) => {
      if (!agent) return { error: 'Agent not initialized' };
      const target = conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default');
      try {
        const snapshot = await mutateTargetConversation(target, () => {
          const isolated = isolatedConversationAgent(target);
          return isolated.branchConversation(target.conversationId, messageIndex, text, locator);
        });
        return { ...snapshot, queued: { steering: [], followUp: [] }, workEvents: [] };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle('agent:inspectConversationBranch', async (_event, targetInput: ConversationTargetInput, branchId: string, branchGroupId?: string) => {
      if (!agent) return { error: 'Agent not initialized' };
      const target = conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default');
      try {
        const isolated = isolatedConversationAgent(target);
        const snapshot = isolated.inspectConversationBranch(target.conversationId, branchId, branchGroupId);
        if (snapshot.runtimeBranchId === snapshot.activeBranchId && peekTargetRuntime(target).resident) {
          const live = await runtimeSnapshotForTarget(target);
          return {
            ...live,
            activeBranchId: snapshot.activeBranchId,
            runtimeBranchId: snapshot.runtimeBranchId,
            viewedBranchNodePath: snapshot.viewedBranchNodePath,
            runtimeBranchNodePath: snapshot.runtimeBranchNodePath,
            branchGroupId: snapshot.branchGroupId,
            branchGroups: snapshot.branchGroups,
            branches: snapshot.branches,
          };
        }
        return { ...snapshot, target, workspaceId: target.workspaceId, queued: { steering: [], followUp: [] }, workEvents: [] };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle('agent:activateConversationBranch', async (_event, targetInput: ConversationTargetInput, branchId: string, branchGroupId?: string) => {
      if (!agent) return { error: 'Agent not initialized' };
      const target = conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default');
      try {
        if (peekTargetRuntime(target).running) await stopTargetRuntime(target);
        const snapshot = await mutateTargetConversation(target, () => {
          const isolated = isolatedConversationAgent(target);
          return isolated.switchConversationBranch(target.conversationId, branchId, branchGroupId);
        });
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

    ipcMain.handle('agent:archive', async (_event, targetInput?: ConversationTargetInput) => {
      if (!agent) return { ok: false, error: 'Agent not initialized' };
      const target = conversationRuntimeTarget(targetInput || agent.activeConversationId || 'default');
      const normalized = normalizeConversationTarget(target);
      const existing = archiveInFlight.get(normalized.runtimeKey);
      if (existing) return existing;
      const operation = (async () => {
        mutatingRuntimeKeys.add(normalized.runtimeKey);
        try {
          // Archive is a destructive lifecycle command. It intentionally
          // bypasses the normal mutation/active-prompt guard. Cancel the
          // conversation-local Flow synchronously, then start the resident
          // runtime hard-stop in the background so a stuck child cannot hold
          // the archive click hostage.
          interruptActiveFlowForArchive(normalized);
          void forceStopTargetRuntime(normalized).catch(error => {
            console.error('[Newmark] archive runtime force-stop failed:', error instanceof Error ? error.message : String(error));
          });
          const currentWorkspacePath = path.resolve(agent!.workspace.current?.path || '');
          const targetWorkspacePath = path.resolve(normalized.workspace?.path || '');
          const ownsTargetWorkspace = !!normalized.workspace
            && !!agent!.workspace.current
            && currentWorkspacePath === targetWorkspacePath;
          // The host Agent owns the current workspace persistence cache. An
          // isolated owner is used for another workspace. The archive writer
          // starts payload I/O in parallel and finalizes deletion against the
          // latest locked state snapshot, so rapid clicks do not serialize on
          // large Markdown bodies or lose a sibling deletion.
          const archiveOwner = ownsTargetWorkspace ? agent! : isolatedConversationAgent(normalized);
          archiveOwner.clearStoredFlowSuspension(normalized.conversationId);
          const archived = await archiveOwner.archiveConversationAsync(normalized.conversationId);
          if (!archived) return { ok: false, error: 'Conversation archive could not be written.' };
          return { ok: true, fileName: archived, conversationId: normalized.conversationId, workspaceId: normalized.workspaceId };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
          mutatingRuntimeKeys.delete(normalized.runtimeKey);
        }
      })();
      archiveInFlight.set(normalized.runtimeKey, operation);
      try {
        return await operation;
      } finally {
        if (archiveInFlight.get(normalized.runtimeKey) === operation) archiveInFlight.delete(normalized.runtimeKey);
      }
    });

    ipcMain.handle('agent:listArchives', async (_event, scope?: string) => {
      if (!agent) return [];
      // Async scan so a large archive directory never blocks the main process
      // and the renderer window stays responsive while archives load.
      return agent.listArchivesAsync(scope === 'all' ? 'all' : 'workspace');
    });

    ipcMain.handle('agent:deleteArchive', async (_event, name: string) => {
      return agent?.deleteArchive(name);
    });

    ipcMain.handle('agent:readArchive', async (_event, name: string) => {
      if (!agent) return null;
      return agent.readArchiveAsync(name);
    });

    ipcMain.handle('agent:restoreArchive', async (_event, name: string) => {
      if (!agent) return { ok: false, error: 'Agent not initialized' };
      const restored = agent.restoreArchivedConversation(name);
      if (!restored.ok || !restored.workspaceId || !restored.conversationId) return restored;
      agent.selectWorkspaceFromStorage(restored.workspaceId);
      agent.setConversationFromStorage(restored.conversationId);
      return { ...restored, snapshot: agent.getConversationSnapshot(restored.conversationId) };
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
      const ownerId = String(event.sender.id);
      const result = await fileRouter.open(filePath, ownerId);
      if (result.kind === 'browser' && result.mime === 'application/pdf') {
        return {
          kind: 'browser',
          path: result.path,
          size: result.size,
          mime: result.mime,
          url: pdfPreviewServer.urlFor(result.capability, ownerId),
          previewToken: result.capability.token,
        };
      }
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

    ipcMain.handle('agent:closeWorkspaceFile', (event, token: string) => ({
      ok: fileRouter.revokeEditToken(token, String(event.sender.id)),
    }));

    ipcMain.handle('agent:closeWorkspacePreview', (event, token: string) => {
      const ownerId = String(event.sender.id);
      const serverRevoked = pdfPreviewServer.revokeCapability(token, ownerId);
      const routerRevoked = fileRouter.revokePreviewToken(token, ownerId);
      return { ok: serverRevoked || routerRevoked };
    });

    ipcMain.handle('agent:confirmEditorClose', async (event, language: string, filePath: string) => {
      const chinese = String(language || '').toLowerCase().startsWith('zh');
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options = {
        type: 'warning',
        title: chinese ? '未保存的更改' : 'Unsaved changes',
        message: chinese ? '当前文件有未保存的更改。' : 'The current file has unsaved changes.',
        detail: String(filePath || ''),
        buttons: chinese ? ['保存', '丢弃', '取消'] : ['Save', 'Discard', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      } as const;
      const result = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      return result.response === 0 ? 'save' : result.response === 1 ? 'discard' : 'cancel';
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
        agent.invalidateSystemPrompt();
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
        return await runShellCommand(String(cmd || ''), shell, cwd || agent?.workspace.current?.path || root);
      } catch (e) { return { error: String(e) }; }
    });

    // === Native PTY Terminal ===
    type BottomTerminalSession =
      | { kind: 'pty'; proc: TakeoverPty; shell: string; buffer: string }
      | { kind: 'native-bash'; proc: NativeBashSession; shell: 'bash'; buffer: string; queue: Promise<void> };
    const ptySessions = new Map<string, BottomTerminalSession>();
    const sendTerminalData = (sessionId: string, session: BottomTerminalSession, text: string): void => {
      session.buffer = `${session.buffer}${text}`.slice(-256 * 1024);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:data', sessionId, text);
    };

    ipcMain.handle('pty:spawn', async (_event, shellId: string) => {
      const sessionId = randomUUID().slice(0, 8);
      const shell = resolveTerminalShell(shellId || agent?.config.getStr('terminal', 'default_shell') || defaultTerminalShell());
      const cwd = agent?.workspace.current?.path || root;
      if (shell.id === 'bash') {
        const session: BottomTerminalSession = {
          kind: 'native-bash',
          proc: new NativeBashSession(cwd, 30_000),
          shell: 'bash',
          buffer: '',
          queue: Promise.resolve(),
        };
        ptySessions.set(sessionId, session);
        return { sessionId, shell: shell.id, engine: 'native-bash' };
      }
      const proc = spawnTakeoverPty(shell, cwd, { ...process.env, TERM: 'xterm-256color' }, 120, 30);
      const session: BottomTerminalSession = { kind: 'pty', proc, shell: shell.id, buffer: '' };
      ptySessions.set(sessionId, session);

      proc.onData(text => sendTerminalData(sessionId, session, text));
      proc.onExit(event => {
        ptySessions.delete(sessionId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pty:exit', sessionId, event.exitCode);
        }
      });

      return { sessionId, shell: shell.id };
    });

    ipcMain.handle('pty:write', async (_event, sessionId: string, data: string) => {
      const session = ptySessions.get(sessionId);
      if (!session) return { error: 'Session not found' };
      if (session.kind === 'pty') {
        session.proc.write(data);
        return { ok: true };
      }
      const command = String(data || '').replace(/[\r\n]+$/, '');
      if (!command.trim()) return { ok: true };
      session.queue = session.queue.then(async () => {
        sendTerminalData(sessionId, session, `$ ${command}\r\n`);
        const result = await session.proc.execute(command);
        if (result.output) sendTerminalData(sessionId, session, result.output.replace(/(?<!\r)\n/g, '\r\n'));
        if (result.error && !result.output.includes(result.error)) {
          sendTerminalData(sessionId, session, `[native-bash] ${result.error}\r\n`);
        }
      }).catch(error => sendTerminalData(sessionId, session, `[native-bash] ${error instanceof Error ? error.message : String(error)}\r\n`));
      return { ok: true };
    });

    ipcMain.handle('pty:kill', async (_event, sessionId: string, timeoutMs?: number) => {
      const session = ptySessions.get(sessionId);
      if (session) {
        const waitMs = Math.max(0, Number(timeoutMs ?? agent?.config.getNum('terminal', 'interrupt_timeout_ms') ?? 0));
        if (session.kind === 'native-bash') {
          session.proc.interrupt();
          if (waitMs > 0) setTimeout(() => ptySessions.delete(sessionId), waitMs);
          return { ok: true };
        }
        if (waitMs === 0) {
          session.proc.kill('SIGINT');
        } else {
          session.proc.kill('SIGINT');
          setTimeout(() => {
            const stillRunning = ptySessions.get(sessionId);
            if (stillRunning?.kind === 'pty') stillRunning.proc.kill();
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

    ipcMain.handle('app:openWebUrl', async (_event, rawUrl: string) => {
      try {
        const target = new URL(String(rawUrl || ''));
        const allowedHosts = new Set(['github.com', 'www.github.com', 'npmjs.com', 'www.npmjs.com']);
        if (target.protocol !== 'https:' || !allowedHosts.has(target.hostname.toLowerCase()) || !!target.username || !!target.password || (!!target.port && target.port !== '443')) {
          return { ok: false, error: 'Only approved HTTPS documentation hosts can be opened.' };
        }
        await shell.openExternal(target.toString());
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.handle('agent:selectWorkspace', async (_event, id: string) => {
      if (agent) {
        const requested = String(id || '').trim();
        const current = agent.workspace.current;
        const uniqueNameMatch = current?.name === requested
          && [...agent.workspace.internal, ...agent.workspace.external].filter(item => item.name === requested).length === 1;
        if (current && (current.id === requested || current.path === requested || uniqueNameMatch)) return current;
        const generation = ++workspaceSwitchGeneration;
        const coordinator = ensureWorkspaceSelectionCoordinator();
        const result = coordinator ? await coordinator.select(requested) : null;
        if (generation !== workspaceSwitchGeneration) return agent.workspace.current;
        if (!result) return agent.workspace.current;
        if (result.status === 'failed') throw new Error(result.error || `Workspace selection failed: ${requested}`);
        if (result.status === 'circuit_open') throw new Error(`Workspace selection temporarily paused after repeated failures: ${requested}`);
        if (result.status === 'stale') return agent.workspace.current;
        const selected = result.value || agent.workspace.current;
        if (!selected) return null;
        // The host already loaded the selected workspace's persisted active
        // conversation. Return that local snapshot with the selection response
        // so the renderer can paint immediately while the runtime refreshes.
        const target = conversationRuntimeTarget({
          workspaceId: selected.id || selected.path || selected.name,
          conversationId: agent.activeConversationId || 'default',
        });
        return {
          ...selected,
          conversationSnapshot: localConversationSnapshotForStartup(target),
        };
      }
      return null;
    });

    ipcMain.handle('agent:createWorkspace', async (_event, name?: string) => {
      if (agent) {
        return agent.createInternalWorkspace(name);
      }
      return null;
    });

    ipcMain.handle('agent:createExternalWorkspace', async (_event, name: string, dirPath: string) => {
      if (agent) {
        return agent.addExternalWorkspace(dirPath);
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
      return result;
    });

    ipcMain.handle('agent:deleteWorkspace', async (_event, workspaceReference: string) => {
      if (!agent) return false;
      const target = conversationRuntimeTarget({ workspaceId: String(workspaceReference || ''), conversationId: 'default' });
      const normalized = normalizeConversationTarget(target);
      assertTargetNotMutating(normalized);
      if ((activePromptWorkspaces.get(normalized.workspaceKey) || 0) > 0) {
        throw new Error('Cannot delete a workspace while one of its conversations is starting or running.');
      }
      mutatingWorkspaceKeys.add(normalized.workspaceKey);
      try {
        const [nativeActive, wslActive] = await Promise.all([
          electronUtilityRuntimePool?.hasActiveWorkspace(normalized) || false,
          wslAgentRuntimePool?.hasActiveWorkspace(normalized) || false,
        ]);
        if (nativeActive || wslActive) throw new Error('Cannot delete a workspace while one of its conversations is running, stopping, or restarting.');
        await Promise.all([
          electronUtilityRuntimePool?.stopWorkspace(normalized),
          wslAgentRuntimePool?.stopWorkspace(normalized),
        ]);
        return agent.removeWorkspace(String(workspaceReference || ''));
      } finally {
        mutatingWorkspaceKeys.delete(normalized.workspaceKey);
      }
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

    ipcMain.handle('agent:modelValidationStatus', () => agent?.modelValidationStatus() || ({
      running: false,
      completedChecks: 0,
      totalChecks: 0,
      percent: 0,
      completedModels: 0,
      totalModels: 0,
      currentModel: '',
      currentCheck: '',
      recentChecks: [],
    }));

    ipcMain.handle('agent:fuzzyInject', async (_event, name: string, url: string, key: string, protocol?: string) => {
      if (agent) {
        return agent.fuzzyInject(
          name,
          url,
          key,
          protocol === 'anthropic' ? 'anthropic' : protocol === 'openai' ? 'openai' : undefined,
        );
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

    const editorCompletionControllers = new Map<number, AbortController>();
    ipcMain.handle('agent:editorComplete', async (event, request: Record<string, unknown>) => {
      const ownerId = event.sender.id;
      editorCompletionControllers.get(ownerId)?.abort(new Error('Superseded editor completion'));
      const controller = new AbortController();
      editorCompletionControllers.set(ownerId, controller);
      try {
        const requestId = String(request.requestId || '');
        const onTextDelta = requestId
          ? (text: string) => {
            if (!controller.signal.aborted && !event.sender.isDestroyed()) event.sender.send('agent:editorCompletionDelta', { requestId, text });
          }
          : undefined;
        return await (agent?.editorModelRequest({ ...request, completion: true, preferCopilot: true, onTextDelta } as any, controller.signal) || { ok: false, text: '', error: 'Agent not initialized' });
      } finally {
        if (editorCompletionControllers.get(ownerId) === controller) editorCompletionControllers.delete(ownerId);
      }
    });

    ipcMain.handle('agent:editorCompleteCancel', async (event) => {
      const ownerId = event.sender.id;
      editorCompletionControllers.get(ownerId)?.abort(new Error('Editor completion cancelled'));
      return { ok: true };
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

    ipcMain.handle('mcp:list', async () => {
      if (!mcpManager) return { servers: [], discovered: [] };
      const discovered = discoverPluginManifests(root).flatMap(plugin =>
        (plugin.components.mcpServers || []).map(name => ({
          id: `${plugin.id}:${name}`,
          name,
          plugin: plugin.displayName || plugin.name,
          ecosystem: plugin.ecosystem,
          root: plugin.root,
          enabled: plugin.enabled,
          readOnly: true,
        })));
      return { servers: mcpManager.list(), discovered };
    });

    ipcMain.handle('dsh:discover', async () => discoverDshCompatibility(root));

    ipcMain.handle('dsh:installBundle', async (_event, manifestPath: string) => {
      return installDshBundle(root, String(manifestPath || ''));
    });

    ipcMain.handle('dsh:uninstallBundle', async (_event, name: string) => {
      return uninstallDshBundle(root, String(name || ''));
    });

    ipcMain.handle('dsh:setBundleEnabled', async (_event, name: string, enabled: boolean) => {
      return setDshBundleEnabled(root, String(name || ''), enabled === true);
    });

    ipcMain.handle('mcp:upsert', async (_event, input: Record<string, unknown>) => {
      if (!mcpManager) return { ok: false, error: 'MCP manager is unavailable.' };
      try {
        mcpManager.upsert(input);
        return { ok: true, servers: mcpManager.list() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), servers: mcpManager.list() };
      }
    });

    ipcMain.handle('mcp:setEnabled', async (_event, id: string, enabled: boolean) => {
      if (!mcpManager) return { ok: false, error: 'MCP manager is unavailable.' };
      const ok = mcpManager.setEnabled(id, enabled);
      return { ok, error: ok ? undefined : 'MCP server was not found.', servers: mcpManager.list() };
    });

    ipcMain.handle('mcp:remove', async (_event, id: string) => {
      if (!mcpManager) return { ok: false, error: 'MCP manager is unavailable.' };
      const ok = mcpManager.remove(id);
      return { ok, error: ok ? undefined : 'MCP server was not found.', servers: mcpManager.list() };
    });

    ipcMain.handle('memoryLab:read', async (_event, selector?: string) => {
      if (!agent) return { ok: false, error: 'Agent not ready' };
      return agent.memoryLab.read(selector || '');
    });

    ipcMain.handle('memoryLab:visualization', async () => {
      if (!agent) return { ok: false, error: 'Agent not ready' };
      return agent.memoryLab.visualizationSnapshot();
    });

    ipcMain.handle('viewer:open', async (_event, request: Record<string, unknown>) => {
      await createViewerWindow(request);
      return { ok: true };
    });

    ipcMain.handle('viewer:openMemoryOverview', async () => {
      if (!agent) return { ok: false, error: 'Agent not ready' };
      await createViewerWindow({ type: 'memory-overview', title: 'Memory Lab Overview', snapshot: agent.memoryLab.visualizationSnapshot() });
      return { ok: true };
    });

    ipcMain.handle('memoryLab:update', async (_event, input: Record<string, unknown>) => {
      if (!agent) return { ok: false, error: 'Agent not ready' };
      try {
        return await agent.updateMemoryLab({
          name: String(input.name || ''),
          description: String(input.description || ''),
          tags: Array.isArray(input.tags) ? input.tags.map(String) : String(input.tags || '').split(/[,，\n]+/),
          tagPaths: Array.isArray(input.tagPaths)
            ? input.tagPaths.filter(Array.isArray).map(pathValue => pathValue.map(String))
            : [],
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

    ipcMain.handle('mobile:pairingQr', async () => {
      const qr = await pairingQrDataUrl(root);
      return {
        ok: true,
        url: qr.session.url,
        dataUrl: qr.dataUrl,
        pairingId: qr.session.pairingId,
        expiresAt: qr.session.expiresAt,
        tokenFile: pairingTokenPath(root),
        tailscaleIpv4: tailscaleIpv4(),
      };
    });

    ipcMain.handle('mobile:pairingStatus', async () => {
      return { ok: true, status: pairingStatus(root) };
    });

    ipcMain.handle('update:checkGithub', async (_event, input: Record<string, unknown> = {}) => {
      return checkGitHubUpdate(String(input.repo || ''), String(input.tag || ''), String(input.asset || ''));
    });

    ipcMain.handle('update:applyGithub', async (_event, input: Record<string, unknown> = {}) => {
      const result = await applyGitHubUpdate({
        repo: String(input.repo || ''),
        tag: String(input.tag || ''),
        asset: String(input.asset || ''),
        target: String(input.target || root),
        expectedVersion: String(input.expectedVersion || ''),
        dryRun: input.dryRun !== false,
      });
      if (result.ok && !result.dryRun && result.deferred) setTimeout(() => app.quit(), 150);
      return result;
    });

    ipcMain.handle('update:installLocal', async (_event, input: Record<string, unknown> = {}) => {
      const result = installUpdate({
        source: String(input.source || ''),
        target: String(input.target || root),
        targetFile: typeof input.targetFile === 'string' ? input.targetFile : undefined,
        expectedVersion: typeof input.expectedVersion === 'string' ? input.expectedVersion : undefined,
        preserve: Array.isArray(input.preserve) ? input.preserve.map(String) : undefined,
        dryRun: input.dryRun !== false,
      });
      if (result.ok && !result.dryRun && result.deferred) setTimeout(() => app.quit(), 150);
      return result;
    });

    ipcMain.handle('update:planMsi', async (_event, input: Record<string, unknown> = {}) => {
      return planManagedMsiInstall(String(input.msiPath || ''), {
        stopConfirmed: input.stopConfirmed === true,
        removeLegacyConfirmed: input.removeLegacyConfirmed === true,
        uninstallPrevious: input.uninstallPrevious !== false,
        allowElevate: input.allowElevate !== false,
        excludeRoots: Array.isArray(input.excludeRoots) ? input.excludeRoots.map(String) : undefined,
        logDir: typeof input.logDir === 'string' ? input.logDir : undefined,
      });
    });

    ipcMain.handle('update:executeMsi', async (_event, input: Record<string, unknown> = {}) => {
      const result = executeManagedMsiInstall(String(input.msiPath || ''), {
        stopConfirmed: input.stopConfirmed === true,
        removeLegacyConfirmed: input.removeLegacyConfirmed === true,
        uninstallPrevious: input.uninstallPrevious !== false,
        allowElevate: input.allowElevate !== false,
        excludeRoots: Array.isArray(input.excludeRoots) ? input.excludeRoots.map(String) : undefined,
        logDir: typeof input.logDir === 'string' ? input.logDir : undefined,
      });
      if (result.ok) setTimeout(() => app.quit(), 150);
      return result;
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
      // The title-bar minimize action always belongs to the OS taskbar.
      // Tray hiding remains an explicit close-behavior decision and must not
      // make an ordinary minimize click disappear from the taskbar.
      win?.minimize();
    });
    ipcMain.handle('glass:captureBackdrop', async (event, requestedSize?: { width?: number; height?: number }) => {
      const image = await event.sender.capturePage();
      const sourceSize = image.getSize();
      const width = Math.max(1, Math.min(sourceSize.width, Math.round(Number(requestedSize?.width) || sourceSize.width)));
      const height = Math.max(1, Math.min(sourceSize.height, Math.round(Number(requestedSize?.height) || sourceSize.height)));
      const resized = sourceSize.width === width && sourceSize.height === height
        ? image
        : image.resize({ width, height, quality: 'good' });
      return {
        bytes: resized.toJPEG(82),
        mimeType: 'image/jpeg',
        width,
        height,
      };
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
    ipcMain.handle('app:exit', () => {
      requestExplicitExit('renderer-exit');
      return { ok: true };
    });

    ipcMain.handle('github:overview', async (_event, requestedRepo?: string) => {
      const cwd = agent?.workspace.current?.path || root;
      const userResult = await runJsonCommand('gh', ['api', 'user'], cwd, 20000);
      if (!userResult.ok || !userResult.data) return { ok: false, error: userResult.error || 'GitHub authentication is unavailable.' };
      const user = userResult.data as Record<string, unknown>;
      const login = String(user.login || '').trim();
      if (!login) return { ok: false, error: 'GitHub authentication did not return an account.' };
      const repoFields = 'nameWithOwner,description,url,isPrivate,isFork,updatedAt,viewerHasStarred,stargazerCount,forkCount,parent,viewerPermission,viewerSubscription';
      const [reposResult, currentResult] = await Promise.all([
        runJsonCommand('gh', ['repo', 'list', login, '--limit', '100', '--json', repoFields], cwd, 30000),
        runJsonCommand('gh', ['repo', 'view', '--json', 'nameWithOwner'], cwd, 15000),
      ]);
      const repositories = reposResult.ok && Array.isArray(reposResult.data) ? reposResult.data as Array<Record<string, unknown>> : [];
      let repository = String(requestedRepo || '').trim();
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) repository = '';
      if (!repository) {
        const current = currentResult.ok && currentResult.data && typeof currentResult.data === 'object'
          ? String((currentResult.data as Record<string, unknown>).nameWithOwner || '') : '';
        repository = repositories.some(item => String(item.nameWithOwner || '') === current) ? current : String(repositories[0]?.nameWithOwner || '');
      }
      const selected = repositories.find(item => String(item.nameWithOwner || '') === repository) || null;
      if (!selected && repositories.length) repository = String(repositories[0]?.nameWithOwner || '');
      const [detailResult, issuesResult, prsResult] = repository ? await Promise.all([
        runJsonCommand('gh', ['repo', 'view', repository, '--json', repoFields], cwd, 20000),
        runJsonCommand('gh', ['issue', 'list', '--repo', repository, '--limit', '20', '--json', 'number,title,state,url,updatedAt,author'], cwd, 20000),
        runJsonCommand('gh', ['pr', 'list', '--repo', repository, '--limit', '20', '--json', 'number,title,state,url,updatedAt,author,isDraft'], cwd, 20000),
      ]) : [null, null, null];
      const resolvedSelected = detailResult?.ok && detailResult.data && typeof detailResult.data === 'object'
        ? detailResult.data as Record<string, unknown>
        : repositories.find(item => String(item.nameWithOwner || '') === repository) || null;
      return {
        ok: true,
        account: { login, name: String(user.name || ''), avatarUrl: String(user.avatar_url || ''), url: String(user.html_url || '') },
        repositories,
        repository,
        selected: resolvedSelected,
        issues: issuesResult?.ok && Array.isArray(issuesResult.data) ? issuesResult.data : [],
        prs: prsResult?.ok && Array.isArray(prsResult.data) ? prsResult.data : [],
        warning: [reposResult.ok ? '' : reposResult.error, detailResult && !detailResult.ok ? detailResult.error : ''].filter(Boolean).join(' '),
      };
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
        return { ok: !!client, ...client?.status() };
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
    // Initial and retry navigation are owned exclusively by runStartupAttempt.
    // An unconditional load here races the attempt-one index load once Agent
    // initialization becomes faster than IPC registration.
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
