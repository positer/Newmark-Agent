import { app, BrowserWindow, ipcMain, dialog, utilityProcess, Tray, Menu, nativeImage, webContents } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { Agent } from './core/agent';
import { AgentMode } from './core/types';
import { AutomationManager } from './core/automation';
import { AutomationWakeScheduler, WakeSyncResult } from './core/automationWake';
import { BrowserControl, BrowserControlRequest, BrowserControlResult } from './core/browserControl';
import { FlowEngine } from './core/flow';
import { runFlow } from './core/flow-runner';
import { CLI_COMMANDS, runCliCommand } from './cli-commands';
import { mergeProviderSecrets, sanitizeProvidersForState } from './core/config';

let mainWindow: BrowserWindow | null = null;
let agent: Agent | null = null;
let automation: AutomationManager | null = null;
let automationWake: AutomationWakeScheduler | null = null;
let lastWakeSync: WakeSyncResult | null = null;
let tray: Tray | null = null;
let _forceQuit = false;
let browserControlWindow: BrowserWindow | null = null;

function userArgs(): string[] {
  return process.argv.slice(1);
}

function argValue(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  return idx >= 0 ? args[idx + 1] : undefined;
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
  for (const d of ['skills', 'Work', 'Flow', 'archive']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }

  const cp = path.join(root, 'config.json');
  if (!fs.existsSync(cp)) {
    const configModule = require('./core/config');
    fs.writeFileSync(cp, JSON.stringify(configModule.defaultConfig(), null, 2), 'utf-8');
    fs.writeFileSync(path.join(root, 'agent.md'), '# Newmark Agent\n\nYou are a powerful coding assistant.\n', 'utf-8');
  }

  // PC_Hash.config
  const hostname = require('os').hostname();
  const pcId = `${hostname}|${process.platform}|${process.arch}`;
  fs.writeFileSync(path.join(root, 'PC_Hash.config'), pcId, 'utf-8');

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

function getRoot(): string {
  // Use the directory where the executable is located
  return path.dirname(app.getPath('exe'));
}

function resolveRoot(args: string[]): string {
  return argValue(args, '--root') || (app.isPackaged ? getRoot() : process.cwd());
}

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

  app.whenReady().then(async () => {
    const root = resolveRoot(args);
    const automationWakeMode = args.includes('--automation-wake');
    firstRunInit(root);
    installBrowserControlBackend();
    agent = new Agent(root);
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
      if (automationWake) lastWakeSync = automationWake.sync(items);
    });
    lastWakeSync = automationWake.sync(automation.list());
    if (automationWakeMode) {
      await automation.tick();
      lastWakeSync = automationWake.sync(automation.list());
      automation.stop();
      app.quit();
      return;
    }
    automation.start();

    void startSidecar(root).then(port => {
      if (port > 0) {
        console.log(`[Newmark] Sidecar started on port ${port}`);
      }
    });

    mainWindow = new BrowserWindow({
      width: 1600,
      height: 1000,
      minWidth: 1000,
      minHeight: 650,
      show: false,
      frame: false,
      title: 'Newmark Agent',
      backgroundColor: '#0a0a1a',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
      },
    });

    mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
    mainWindow.webContents.on('will-attach-webview', (event, webPreferences) => {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
    });
    if (!automationWakeMode) {
      mainWindow.maximize();
      mainWindow.show();
      if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'bottom' });
    }

    mainWindow.on('close', (e) => {
      if (_forceQuit) return;
      if (agent) {
        const closeBehavior = agent.config.getStr('general', 'close_behavior');
        if (closeBehavior === 'minimize') {
          e.preventDefault();
          mainWindow?.hide();
          createTray();
          return;
        }
        if (agent.config.getBool('general', 'auto_archive_on_close')) {
          agent.archiveSession();
        }
      }
    });

    mainWindow.on('closed', () => {
      if (sidecarProcess) {
        sidecarProcess.kill();
        sidecarProcess = null;
      }
      mainWindow = null;
    });

    app.on('will-quit', () => {
      if (automationWake && automation) lastWakeSync = automationWake.sync(automation.list());
      automation?.stop();
      if (tray) { tray.destroy(); tray = null; }
      BrowserControl.setBackend(null);
      if (browserControlWindow && !browserControlWindow.isDestroyed()) browserControlWindow.destroy();
      if (sidecarProcess) { sidecarProcess.kill(); sidecarProcess = null; }
    });

    function createTray() {
      if (tray) return;
      const trayIcon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAhklEQVQ4T2NkYPj/n4EBBJgYKAQMDAwM//79Y2RkZGQYmpqMgYGBgYEhJSWFgYGBAaoRAkZGRoZ///4x/Pr1CyrKwAhVwMDw798/BgYGBqgCRqgCBgaoKEYGBgYGqAJGqAIGSJQzMDAw/P79m4GRkZGBkZGRgaSADg0NZWBgYGCYOnUq8QENUQADAC3oSsHtAAAAAElFTkSuQmCC');
      tray = new Tray(trayIcon);
      tray.setToolTip('Newmark Agent');
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Window', click: () => { mainWindow?.show(); mainWindow?.focus(); tray?.destroy(); tray = null; } },
        { type: 'separator' },
        { label: 'Exit', click: () => { _forceQuit = true; tray?.destroy(); tray = null; app.quit(); } },
      ]);
      tray.setContextMenu(contextMenu);
      tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); tray?.destroy(); tray = null; });
    }

    ipcMain.handle('agent:send', async (_event, message: string, conversationId?: string) => {
      if (!agent) return { tokens: [], error: 'Agent not initialized' };
      try {
        if (conversationId) agent.setConversation(String(conversationId));
        const result = await Promise.race([
          agent.process(message),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Process timeout (300s)')), 300000)),
        ]);
        return {
          tokens: result.map(t => ({ type: t.type, text: t.text })),
          diffs: agent.fileDiffs.map(d => ({ path: d.path, old: d.oldContent.length, new: d.newContent.length })),
          mode: agent.mode,
          model: agent.model,
          status: agent.status,
          goal: agent.goal ? { objective: agent.goal.objective, paused: agent.goal.paused } : null,
          options: agent.pendingOptions,
          contextCompression: agent.lastCompression,
          conversationId: agent.activeConversationId,
          conversations: agent.listConversationStates(),
          conversationPlan: agent.getConversationPlan(),
          chatMessages: agent.chatMessages,
          historyMessages: agent.history.length,
          conversationLocked: agent.isConversationLocked(),
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
          diffs: agent.fileDiffs.map(d => ({ path: d.path, old: d.oldContent.length, new: d.newContent.length })),
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
      if (agent) agent.setMode(mode as AgentMode);
      return agent?.mode;
    });

    ipcMain.handle('agent:setModel', async (_event, model: string) => {
      if (agent) agent.setModel(model);
      return agent?.model;
    });

    ipcMain.handle('agent:setIntelligence', async (_event, tier: string) => {
      if (agent) agent.setIntelligence(tier);
      return agent?.intelligence;
    });

    ipcMain.handle('agent:setInputMode', async (_event, mode: string) => {
      if (agent) agent.inputMode = mode === 'next' ? 'next' : 'guide';
      return agent?.inputMode;
    });
    ipcMain.handle('agent:setConversation', async (_event, id: string) => {
      return agent?.setConversation(id);
    });
    ipcMain.handle('agent:updateGoal', async (_event, goal: string) => {
      if (agent) agent.updateGoal(goal);
      return agent?.goal;
    });

    ipcMain.handle('agent:toggleGoalPause', async () => {
      return agent?.toggleGoalPause();
    });

    ipcMain.handle('agent:getState', async () => {
      if (!agent) return {};
      return {
        mode: agent.mode,
        model: agent.model,
        modelLabel: agent.modelLabel(),
        intelligence: agent.intelligence,
        conversationId: agent.activeConversationId,
        conversations: agent.listConversationStates(),
        conversationPlan: agent.getConversationPlan(),
        historyMessages: agent.history.length,
        conversationLocked: agent.isConversationLocked(),
        status: agent.status,
        goal: agent.goal,
        models: agent.allModelNames(),
        providers: sanitizeProvidersForState(agent.config.providers()),
        workspaces: { internal: agent.workspace.internal, external: agent.workspace.external, current: agent.workspace.current },
        skills: agent.skills.listDetailed(),
        subagents: agent.subagents.listAll().map(s => ({
          id: s.id,
          name: s.name,
          status: s.status,
          active: s.status !== 'closed',
          model: s.model,
          mode: s.agentMode,
          inputMode: s.inputMode,
          result: s.result,
          messageCount: s.messages.length,
          messages: s.messages.slice(-20),
        })),
        fileDiffs: agent.fileDiffs.map(d => ({
          path: d.path,
          oldLength: d.oldContent.length,
          newLength: d.newContent.length,
        })),
        pendingOptions: agent.pendingOptions,
        proxyEnabled: agent.config.getBool('proxy', 'enabled'),
        proxyUrl: agent.config.getStr('proxy', 'url'),
        proxyAuth: agent.config.getStr('proxy', 'auth'),
        gradientColors: agent.config.get<string[]>('ui', 'gradient_colors') || [],
        gradientSpeed: agent.config.getNum('ui', 'gradient_speed'),
        gradientWidth: agent.config.getNum('ui', 'gradient_width'),
        glassAlpha: agent.config.getNum('ui', 'glass_alpha') || 0.85,
        darkMode: agent.config.getStr('ui', 'dark_mode'),
        minimizeToTray: agent.config.getBool('ui', 'minimize_to_tray'),
        tone: agent.config.getStr('general', 'tone'),
        language: agent.config.getStr('general', 'language'),
        feedback: agent.config.getStr('agent', 'option_feedback'),
        accessPerm: agent.config.getStr('workspace', 'access_permission'),
        promptMode: agent.config.getStr('workspace', 'prompt_mode'),
        skillPolicy: agent.config.getStr('skills', 'auto_download'),
        autoSwitch: agent.config.getBool('models', 'auto_switch'),
        fallbackOnUnavailable: agent.config.getBool('models', 'fallback_on_unavailable'),
        autoAdjust: agent.config.getBool('agent', 'auto_adjust_settings'),
        inputMode: agent.inputMode,
        terminalInterruptTimeoutMs: agent.config.getNum('terminal', 'interrupt_timeout_ms'),
        chatMessages: agent.chatMessages,
        automations: automation?.list() || [],
        closeBehavior: agent.config.getStr('general', 'close_behavior'),
        contextCompression: agent.lastCompression,
      };
    });

    ipcMain.handle('agent:getConversationPlan', async () => {
      if (!agent) return { items: [] };
      return agent.getConversationPlan();
    });

    ipcMain.handle('agent:updateConversationPlan', async (_event, plan: Record<string, unknown>) => {
      if (!agent) return { items: [] };
      return agent.updateConversationPlan(plan as any);
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
              case 'feedbackLevel': agent.config.set('agent', 'option_feedback', value); break;
              case 'language': agent.config.set('general', 'language', value); break;
              case 'autoSwitch': agent.config.set('models', 'auto_switch', value === true || value === 'on'); break;
              case 'fallbackOnUnavailable': agent.config.set('models', 'fallback_on_unavailable', value === true || value === 'on'); break;
              case 'switchTendency': agent.config.set('models', 'auto_switch_preference', value); break;
              case 'providers': agent.config.set('models', 'providers', mergeProviderSecrets(value, agent.config.providers())); break;
              case 'defaultFlow': agent.config.set('flow', 'default_flow', value); break;
              case 'dialogStyle': agent.config.set('ui', 'dialog_style', value); break;
              default: agent.config.set('ui', key, value);
            }
          }
          agent.config.save();
        }
        return true;
      }
      return false;
    });

    ipcMain.handle('agent:saveSetting', async (_event, section: string, key: string, value: unknown) => {
      if (agent) {
        agent.config.set(section, key, value);
        agent.config.save();
        return true;
      }
      return false;
    });

    ipcMain.handle('agent:archive', async () => {
      return agent?.archiveSession();
    });

    ipcMain.handle('agent:listArchives', async () => {
      return agent?.listArchives();
    });

    ipcMain.handle('agent:deleteArchive', async (_event, name: string) => {
      return agent?.deleteArchive(name);
    });

    ipcMain.handle('agent:readArchive', async (_event, name: string) => {
      return agent?.readArchive(name);
    });

    function walkTree(_root: string, current: string): any {
      const entries = fs.readdirSync(current, { withFileTypes: true });
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
            children: walkTree(root, fullPath),
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

    ipcMain.handle('agent:readFile', async (_event, filePath: string) => {
      try {
        return { content: fs.readFileSync(resolveAppPath(root, filePath), 'utf-8') };
      } catch (e) { return { error: String(e) }; }
    });

    ipcMain.handle('agent:saveFile', async (_event, filePath: string, content: string) => {
      try {
        if (agent?.mode === 'plan') return { error: 'Plan mode is fully read-only; saveFile is blocked.' };
        const resolved = resolveAppPath(root, filePath);
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolved, content, 'utf-8');
        return { ok: true };
      } catch (e) { return { error: String(e) }; }
    });

    ipcMain.handle('agent:listFiles', async (_event, dirPath: string) => {
      try {
        const resolved = resolveAppPath(root, dirPath);
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        return entries
          .filter(e => !e.name.startsWith('.'))
          .map(e => ({
            name: e.name,
            isDir: e.isDirectory(),
            path: path.join(resolved, e.name),
          }))
          .sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
      } catch (e) { return { error: String(e) }; }
    });

    ipcMain.handle('agent:getFileTree', async (_event, dirPath: string) => {
      try {
        const treeRoot = resolveAppPath(root, dirPath || '');
        return walkTree(treeRoot, treeRoot);
      } catch (e) { return { error: String(e) }; }
    });

    ipcMain.handle('agent:executeBash', async (_event, cmd: string, shell: string, cwd: string) => {
      try {
        const { execSync } = require('child_process');
        const sh = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
        const arg = process.platform === 'win32' ? '-Command' : '-c';
        const result = execSync(`"${sh}" ${arg} "${cmd.replace(/"/g, '\\"')}"`, {
          cwd, encoding: 'utf-8', timeout: 30000,
        });
        return { output: result };
      } catch (e) { return { error: String(e) }; }
    });

    // === Native PTY Terminal ===
    const ptySessions = new Map<string, { proc: ChildProcess; shell: string; buffer: string }>();

    const SHELL_MAP: Record<string, string> = {
      powershell: 'powershell.exe',
      cmd: 'cmd.exe',
      bash: 'bash.exe',
    };

    ipcMain.handle('pty:spawn', async (_event, shellId: string) => {
      const sessionId = randomUUID().slice(0, 8);
      const shellExe = SHELL_MAP[shellId] || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
      const cwd = agent?.workspace.current?.path || root;
      const proc = spawn(shellExe, [], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TERM: 'xterm-256color' },
        windowsHide: true,
      });
      const session = { proc, shell: shellId, buffer: '' };
      ptySessions.set(sessionId, session);

      // Force line-buffered output by sending an initial echo
      proc.stdin?.write('\r\n');

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

      return { sessionId, shell: shellId };
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
        return agent.workspace.current;
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

    ipcMain.handle('agent:deleteWorkspace', async (_event, name: string) => {
      if (agent) {
        return agent.removeWorkspace(name);
      }
      return false;
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

    ipcMain.handle('skills:list', async () => {
      if (!agent) return [];
      return agent.skills.listDetailed();
    });

    ipcMain.handle('skills:market', async () => {
      if (!agent) return [];
      return agent.skills.discoverMarket();
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

    ipcMain.handle('wsl:detect', async () => {
      try {
        const { execSync } = require('child_process');
        execSync('wsl.exe --status', { timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    });

    ipcMain.handle('agent:downloadGemma', async () => {
      if (!agent) return { error: 'Agent not ready' };
      try {
        const ollamaPath = spawnSync('where', ['ollama'], { shell: true, timeout: 5000 });
        if (ollamaPath.status !== 0) {
          return { error: 'Ollama not found. Install it first: https://ollama.com/download' };
        }
        const existing = agent.config.providers().find((p: any) => p.name === 'Ollama');
        if (!existing) {
          agent.config.upsertProvider('Ollama', 'http://localhost:11434', '');
          agent.config.save();
        }
        const pull = spawnSync('ollama', ['pull', 'gemma2:2b'], { shell: true, timeout: 300000, stdio: 'pipe' });
        if (pull.status !== 0) {
          return { error: 'Gemma download failed: ' + (pull.stderr?.toString() || pull.stdout?.toString() || '') };
        }
        if (!existing) {
          agent.config.addModelToProvider('Ollama', 'gemma2:2b', 'Gemma 2 2B', 'Google Gemma 2 2B local model');
          agent.config.addModelToProvider('Ollama', 'gemma2:9b', 'Gemma 2 9B', 'Google Gemma 2 9B local model');
          agent.config.save();
        }
        return { ok: true, models: ['gemma2:2b', 'gemma2:9b'] };
      } catch (e: any) {
        return { error: 'Gemma download failed: ' + e.message };
      }
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
      const closeBehavior = agent?.config.getStr('general', 'close_behavior');
      if (closeBehavior === 'minimize') {
        mainWindow?.hide();
        createTray();
      } else {
        mainWindow?.minimize();
      }
    });
    ipcMain.handle('app:maximize', () => {
      if (mainWindow?.isMaximized()) mainWindow.unmaximize();
      else mainWindow?.maximize();
    });
    ipcMain.handle('app:close', () => {
      const closeBehavior = agent?.config.getStr('general', 'close_behavior');
      if (closeBehavior === 'minimize') {
        mainWindow?.hide();
        createTray();
      } else {
        _forceQuit = true;
        app.quit();
      }
    });
    ipcMain.handle('app:drag', () => {
      // Window drag is handled by the renderer
    });
  });
}

app.on('window-all-closed', () => {
  if (isServerArg) return;
  if (process.platform !== 'darwin') app.quit();
});
