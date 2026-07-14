import * as assert from 'assert';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { app, BrowserWindow } from 'electron';
import { bindBrowserUseRequest, BrowserUseEngine, BrowserUseReceipt } from '../core/browserUse';
import { normalizeConversationTarget } from '../core/conversationTarget';
import {
  activeWindowsProcessHelperPidsForTest,
  ElectronUtilityAgentClient,
  snapshotWindowsProcessTree,
  terminateCapturedWindowsProcessTree,
  terminateWindowsUtilityProcessTree,
} from '../core/electronUtilityAgentClient';
import { ElectronBrowserUseHost } from '../core/electronBrowserUseHost';
import { NativeBrowserUsePageAdapter } from '../core/browserUsePageAdapter';
import { createUtilityHostToolHandler } from '../core/utilityHostToolRouter';

let assertions = 0;
let server: Server | null = null;
let window: BrowserWindow | null = null;
let host: ElectronBrowserUseHost | null = null;
let downloadDir = '';
let utilityRoot = '';
const externalUrls: string[] = [];
const utilityClients: ElectronUtilityAgentClient[] = [];
const utilityDescendantIdentities = new Map<number, string>();

function ok(value: unknown, message: string): asserts value {
  assert.ok(value, message);
  assertions += 1;
}

async function startFixture(): Promise<string> {
  server = createServer((request, response) => {
    if (request.url === '/file') {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="browser-use.txt"',
      });
      response.end('download blocked by Browser-Use');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>Browser Use Fixture</title><style>
      body{font-family:sans-serif;margin:30px} input,select,button,a{display:block;margin:16px;width:240px;height:38px}
    </style></head><body>
      <input aria-label="Name" value="before">
      <select aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select>
      <button aria-label="Mark" onclick="document.body.dataset.marked='yes'">Mark</button>
      <button aria-label="Popup" onclick="window.open('/popup','_blank')">Popup</button>
      <a aria-label="Download" href="/file" download>Download</a>
      <button aria-label="Delayed Popup" onclick="setTimeout(() => window.open('/popup-delayed','_blank'), 350)">Delayed Popup</button>
      <button aria-label="Delayed Download" onclick="setTimeout(() => document.getElementById('delayed-download-target').click(), 350)">Delayed Download</button>
      <a id="delayed-download-target" href="/file" download style="display:none">hidden download target</a>
      <div id="status">fixture ready</div>
    </body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}/`;
}

async function closeFixture(): Promise<void> {
  const cleanupErrors: Error[] = [];
  try {
    const retainedClients: ElectronUtilityAgentClient[] = [];
    for (const client of utilityClients) {
      try { await client.stop(); } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
      if (client.status().connected) retainedClients.push(client);
    }
    utilityClients.length = 0;
    utilityClients.push(...retainedClients);
    if (process.platform === 'win32' && utilityDescendantIdentities.size) {
      const entries = [...utilityDescendantIdentities].map(([pid, creationIdentity]) => ({
        pid,
        parentPid: 0,
        depth: 0,
        creationIdentity,
      }));
      try {
        await terminateCapturedWindowsProcessTree({ rootPid: entries[0].pid, entries });
        utilityDescendantIdentities.clear();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    } else if (process.platform !== 'win32') {
      for (const pid of utilityDescendantIdentities.keys()) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
        if (!processIsAlive(pid)) utilityDescendantIdentities.delete(pid);
      }
    }
    host?.dispose();
    if (window && !window.isDestroyed()) window.destroy();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  } finally {
    host = null;
    window = null;
    server = null;
    for (const temporaryRoot of [downloadDir, utilityRoot]) {
      if (!temporaryRoot) continue;
      try {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
        if (fs.existsSync(temporaryRoot)) cleanupErrors.push(new Error(`Temporary fixture root remained after cleanup: ${temporaryRoot}`));
      } catch (error) {
        cleanupErrors.push(new Error(`Could not remove temporary fixture root ${temporaryRoot}: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    downloadDir = '';
    utilityRoot = '';
    externalUrls.length = 0;
  }
  if (utilityClients.length || utilityDescendantIdentities.size || cleanupErrors.length) {
    const details = cleanupErrors.map(error => error.message).join('; ') || 'tracked process handles remain';
    throw new Error(`Browser-Use Electron fixture cleanup failed: ${details}`);
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(probe: () => T | null, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null) return value;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for utility descendant fixture`);
}

async function waitForAsync<T>(probe: () => Promise<T | null>, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for asynchronous utility fixture state`);
}

function readWindowsProcessPids(processName: string): Promise<number[]> {
  if (!/^[a-z0-9._-]+$/i.test(processName)) return Promise.reject(new Error('Invalid Windows process name'));
  const script = `$pids = @(Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id); Write-Output ('PIDS:' + ($pids -join ','))`;
  return new Promise<number[]>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const query = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try { query.kill(); } catch {}
      if (!settled) {
        settled = true;
        reject(new Error(`Timed out reading ${processName}.exe process ids`));
      }
    }, 5_000);
    query.stdout?.on('data', chunk => { stdout += String(chunk || ''); });
    query.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk || '')}`.slice(-2_000); });
    query.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    query.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Could not read ${processName}.exe process ids: ${stderr || `exit ${code}`}`));
        return;
      }
      const line = stdout.split(/\r?\n/).map(value => value.trim()).find(value => value.startsWith('PIDS:'));
      if (line === undefined) {
        reject(new Error(`PowerShell returned no explicit PIDS record for ${processName}.exe`));
        return;
      }
      resolve(line.slice('PIDS:'.length).split(',')
        .map(value => Number(value.trim()))
        .filter(pid => Number.isInteger(pid) && pid > 0));
    });
  });
}

async function trackDescendantIdentities(pids: number[]): Promise<void> {
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (process.platform !== 'win32') {
      utilityDescendantIdentities.set(pid, '');
      continue;
    }
    const snapshot = await snapshotWindowsProcessTree(pid);
    const root = snapshot.entries.find(entry => entry.pid === pid);
    if (!root?.creationIdentity) {
      // A late descendant may already be gone by the time its ready record is
      // consumed.  A confirmed-dead PID needs no cleanup registration; a live
      // PID without creation identity remains a fail-closed test error.
      if (!processIsAlive(pid)) continue;
      throw new Error(`Could not capture descendant creation identity for live PID ${pid}`);
    }
    utilityDescendantIdentities.set(pid, root.creationIdentity);
  }
}

async function trackedProcessIdentityIsAlive(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') return processIsAlive(pid);
  const expectedIdentity = utilityDescendantIdentities.get(pid);
  if (!expectedIdentity) {
    if (!processIsAlive(pid)) return false;
    throw new Error(`Live fixture PID ${pid} has no captured creation identity`);
  }
  return await processIdentityIsAlive(pid, expectedIdentity);
}

async function processIdentityIsAlive(pid: number, expectedIdentity: string): Promise<boolean> {
  if (process.platform !== 'win32') return processIsAlive(pid);
  if (!expectedIdentity) throw new Error(`Missing expected creation identity for PID ${pid}`);
  const snapshot = await snapshotWindowsProcessTree(pid);
  return snapshot.entries.some(entry => entry.pid === pid && entry.creationIdentity === expectedIdentity);
}

async function readDescendantPids(readyPath: string): Promise<{ branchPid: number; leafPid: number }> {
  const pids = await waitFor(() => {
    if (!fs.existsSync(readyPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(readyPath, 'utf8')) as { branchPid?: number; leafPid?: number };
      return parsed.branchPid && parsed.leafPid ? { branchPid: parsed.branchPid, leafPid: parsed.leafPid } : null;
    } catch {
      return null;
    }
  });
  await trackDescendantIdentities([pids.branchPid, pids.leafPid]);
  return pids;
}

async function readLateDescendantPid(readyPath: string): Promise<number> {
  const lateLeafPid = await waitFor(() => {
    if (!fs.existsSync(readyPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(readyPath, 'utf8')) as { lateLeafPid?: number };
      return parsed.lateLeafPid ? parsed.lateLeafPid : null;
    } catch {
      return null;
    }
  }, 8_000);
  await trackDescendantIdentities([lateLeafPid]);
  return lateLeafPid;
}

function request(
  receipt: BrowserUseReceipt,
  action: 'click' | 'type' | 'select' | 'extract',
  ref: string,
  extra: Record<string, unknown> = {},
) {
  return {
    owner: receipt.owner,
    runtimeKey: receipt.runtimeKey,
    action,
    actionId: `${action}-${assertions}-${Date.now()}`,
    pageGeneration: receipt.pageGeneration,
    observationId: receipt.observationId,
    ref,
    ...extra,
  } as const;
}

async function run(): Promise<void> {
  const baseUrl = await startFixture();
  window = new BrowserWindow({
    width: 900,
    height: 700,
    show: true,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  window.focus();
  downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-browser-use-download-'));
  window.webContents.session.setDownloadPath(downloadDir);
  host = new ElectronBrowserUseHost({
    resolveContents: async () => window!.webContents,
    guardSettleMs: 200,
    openExternal: async url => { externalUrls.push(url); },
  });
  host.attach(window.webContents);
  await window.loadURL(baseUrl);

  const engine = new BrowserUseEngine(new NativeBrowserUsePageAdapter(scope => host!.resolve(scope)));
  const bound = bindBrowserUseRequest({ action: 'observe', owner: 'spoof', runtimeKey: 'spoof' }, {
    runtimeKey: 'workspace:test::conversation:default',
    actorId: 'root-test',
  });
  ok(bound.runtimeKey === 'workspace:test::conversation:default' && !bound.owner.includes('spoof'), 'host binding replaces untrusted owner/runtimeKey');
  const isolatedPage = await host.resolve(bound);
  ok(await isolatedPage.evaluateFixed(`globalThis.__newmarkBrowserUseProbe = 'isolated'; globalThis.__newmarkBrowserUseProbe`) === 'isolated', 'fixed program executes in the Browser-Use isolated world');
  ok(await window.webContents.executeJavaScript(`globalThis.__newmarkBrowserUseProbe`) === undefined, 'Browser-Use globals are invisible to the page main world');
  const secondRuntimeBound = bindBrowserUseRequest({ action: 'observe' }, {
    runtimeKey: 'workspace:test-two::conversation:default',
    actorId: 'root-test-two',
  });
  const secondRuntimePage = await host.resolve(secondRuntimeBound);
  ok(typeof isolatedPage.serialized === 'function' && typeof secondRuntimePage.serialized === 'function', 'shared WebContents exposes a physical-page action serializer to every runtime');
  const sharedPageOrder: string[] = [];
  let releaseFirstPageAction: () => void = () => undefined;
  let markFirstPageActionStarted: (() => void) | null = null;
  const firstPageActionStarted = new Promise<void>(resolve => { markFirstPageActionStarted = resolve; });
  const firstPageAction = isolatedPage.serialized!('test-first', async () => {
    sharedPageOrder.push('first:start');
    markFirstPageActionStarted?.();
    await new Promise<void>(resolve => { releaseFirstPageAction = resolve; });
    sharedPageOrder.push('first:end');
  });
  await firstPageActionStarted;
  const secondPageAction = secondRuntimePage.serialized!('test-second', async () => {
    sharedPageOrder.push('second:start');
    sharedPageOrder.push('second:end');
  });
  await new Promise<void>(resolve => setTimeout(resolve, 40));
  ok(sharedPageOrder.join(',') === 'first:start', 'two runtimes sharing one physical page cannot interleave observe/action transactions');
  releaseFirstPageAction();
  await Promise.all([firstPageAction, secondPageAction]);
  ok(sharedPageOrder.join(',') === 'first:start,first:end,second:start,second:end', 'shared-page transaction queue preserves cross-runtime arrival order');

  utilityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-browser-use-utility-'));
  const utilityScript = path.join(__dirname, 'browserUseUtilityFixture.js');
  const utilityHandler = createUtilityHostToolHandler({
    persistenceRoot: utilityRoot,
    runAutomation: async () => '',
    runBrowserUse: async (request, signal) => await engine.run(request, signal),
    cancelBrowserUseTarget: runtimeKey => engine.clearRuntime(runtimeKey),
  });
  const target = (workspaceId: string) => normalizeConversationTarget({
    workspaceId,
    conversationId: 'default',
    workspace: {
      id: workspaceId,
      name: workspaceId,
      path: path.join(utilityRoot, workspaceId),
      isInternal: false,
      kind: 'local',
    },
  });
  const alphaTarget = target('Alpha');
  const betaTarget = target('Beta');
  fs.mkdirSync(alphaTarget.workspace!.path, { recursive: true });
  fs.mkdirSync(betaTarget.workspace!.path, { recursive: true });
  let forcedPrimaryKillFailures = 0;
  let alphaLateTriggerPath = '';
  const alphaClient = new ElectronUtilityAgentClient(alphaTarget.workspace!.path, utilityScript, alphaTarget, {
    windowsProcessTree: {
      primaryKill: async () => {
        forcedPrimaryKillFailures += 1;
        if (alphaLateTriggerPath) fs.writeFileSync(alphaLateTriggerPath, 'spawn after initial snapshot', 'utf8');
        return false;
      },
    },
  });
  const betaClient = new ElectronUtilityAgentClient(betaTarget.workspace!.path, utilityScript, betaTarget);
  utilityClients.push(alphaClient, betaClient);
  alphaClient.setHostToolHandler(utilityHandler);
  betaClient.setHostToolHandler(utilityHandler);
  const options = { mode: 'build' as const, model: 'fixture', intelligence: 'medium', inputMode: 'guide' as const, engine: 'builtin' };
  const [alphaResult, betaResult] = await Promise.all([
    alphaClient.prompt({ message: 'observe', target: alphaTarget, options, queueMode: 'followUp' }),
    betaClient.prompt({ message: 'observe', target: betaTarget, options, queueMode: 'followUp' }),
  ]) as unknown as Array<{ receipt: BrowserUseReceipt }>;
  ok(alphaResult.receipt.ok && betaResult.receipt.ok, 'two real Electron utility processes complete Browser-Use host RPC');
  ok(alphaResult.receipt.runtimeKey === alphaTarget.runtimeKey && betaResult.receipt.runtimeKey === betaTarget.runtimeKey, 'real utility bridge preserves two background workspace targets with the same conversation id');
  ok(alphaResult.receipt.owner.endsWith(':actor:utility-fixture-actor') && betaResult.receipt.owner.endsWith(':actor:utility-fixture-actor'), 'real utility router replaces spoofed worker owner with the trusted actor scope');
  ok(alphaResult.receipt.observation?.title === 'Browser Use Fixture' && (betaResult.receipt.observation?.refs.length || 0) >= 7, 'real utility receipts contain the native built-in-browser observation');

  if (process.platform === 'win32') {
    const cscBaseline = new Set(await readWindowsProcessPids('csc'));
    let helperTimeoutError = '';
    try {
      await snapshotWindowsProcessTree(process.pid, 100);
    } catch (error) {
      helperTimeoutError = error instanceof Error ? error.message : String(error);
    }
    await waitFor(() => activeWindowsProcessHelperPidsForTest().length === 0 ? true : null, 3_000);
    const cscAfterTimeout = await waitForAsync(async () => {
      const current = await readWindowsProcessPids('csc');
      return current.every(pid => cscBaseline.has(pid)) ? current : null;
    }, 3_000);
    const newCscPids = cscAfterTimeout.filter(pid => !cscBaseline.has(pid));
    ok(/process-tree snapshot timed out/i.test(helperTimeoutError)
      && activeWindowsProcessHelperPidsForTest().length === 0
      && newCscPids.length === 0,
    'a real 100 ms snapshot timeout kills its PowerShell helper, waits for close, and leaves no new csc compiler process');

    const concurrentStartTarget = target('ConcurrentColdStart');
    fs.mkdirSync(concurrentStartTarget.workspace!.path, { recursive: true });
    let enterStartupGate!: () => void;
    let releaseStartupGate!: () => void;
    const startupGateEntered = new Promise<void>(resolve => { enterStartupGate = resolve; });
    const startupGate = new Promise<void>(resolve => { releaseStartupGate = resolve; });
    const concurrentStartClient = new ElectronUtilityAgentClient(
      concurrentStartTarget.workspace!.path,
      utilityScript,
      concurrentStartTarget,
      { startupGate: async () => { enterStartupGate(); await startupGate; } },
    );
    concurrentStartClient.setHostToolHandler(utilityHandler);
    utilityClients.push(concurrentStartClient);
    const coldStart = concurrentStartClient.start();
    await startupGateEntered;
    let concurrentPromptSettled = false;
    const concurrentPrompt = concurrentStartClient.prompt({
      message: 'observe', target: concurrentStartTarget, options, queueMode: 'followUp',
    });
    void concurrentPrompt.then(
      () => { concurrentPromptSettled = true; },
      () => { concurrentPromptSettled = true; },
    );
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    ok(!concurrentPromptSettled
      && concurrentStartClient.status().readyGeneration === 0
      && !concurrentStartClient.status().rootCreationIdentity,
    'concurrent cold-start callers remain gated before root creation identity and ping readiness');
    releaseStartupGate();
    const [, concurrentPromptResult] = await Promise.all([coldStart, concurrentPrompt]) as unknown as [void, { receipt: BrowserUseReceipt }];
    ok(concurrentPromptResult.receipt.ok
      && concurrentStartClient.status().readyGeneration === concurrentStartClient.status().generation
      && !!concurrentStartClient.status().rootCreationIdentity,
    'all concurrent cold-start callers proceed only after one shared identity-and-ping readiness transaction');

    const forceStopSingleFlightTarget = target('ForceStopSingleFlight');
    fs.mkdirSync(forceStopSingleFlightTarget.workspace!.path, { recursive: true });
    let singleFlightPrimaryCalls = 0;
    const forceStopSingleFlightClient = new ElectronUtilityAgentClient(
      forceStopSingleFlightTarget.workspace!.path,
      utilityScript,
      forceStopSingleFlightTarget,
      { windowsProcessTree: { primaryKill: async () => { singleFlightPrimaryCalls += 1; return false; } } },
    );
    utilityClients.push(forceStopSingleFlightClient);
    await forceStopSingleFlightClient.start();
    const singleFlightPid = forceStopSingleFlightClient.status().pid;
    await Promise.all([
      forceStopSingleFlightClient.forceStop(),
      forceStopSingleFlightClient.forceStop(),
    ]);
    await waitFor(() => !processIsAlive(singleFlightPid) ? true : null);
    ok(singleFlightPrimaryCalls === 1
      && forceStopSingleFlightClient.status().pid === 0
      && !forceStopSingleFlightClient.status().connected,
    'concurrent forceStop callers for one target share exactly one identity-tree transaction');

    const [alphaTree, betaTree] = await Promise.all([
      alphaClient.prompt({ message: '__spawn_descendant_tree__', target: alphaTarget, options, queueMode: 'followUp' }),
      betaClient.prompt({ message: '__spawn_descendant_tree__', target: betaTarget, options, queueMode: 'followUp' }),
    ]) as unknown as Array<{
      pid: number;
      branchPid: number;
      readyPath: string;
      markerPath: string;
      markerDelayMs: number;
      lateTriggerPath: string;
      lateReadyPath: string;
    }>;
    const [alphaPids, betaPids] = await Promise.all([
      readDescendantPids(alphaTree.readyPath),
      readDescendantPids(betaTree.readyPath),
    ]);
    ok(processIsAlive(alphaTree.pid) && processIsAlive(alphaPids.branchPid) && processIsAlive(alphaPids.leafPid),
      'utility force-stop fixture starts a real worker -> branch -> leaf process tree');
    alphaLateTriggerPath = alphaTree.lateTriggerPath;
    const oldAlphaPid = alphaClient.status().pid;
    const oldAlphaRootIdentity = alphaClient.status().rootCreationIdentity;
    const oldAlphaGeneration = alphaClient.status().generation;
    const oldBetaPid = betaClient.status().pid;
    const oldBetaGeneration = betaClient.status().generation;
    const alphaRestartStartedAt = Date.now();
    await alphaClient.forceRestart();
    const alphaRestartMs = Date.now() - alphaRestartStartedAt;
    const alphaLateLeafPid = await readLateDescendantPid(alphaTree.lateReadyPath);
    ok(alphaClient.status().pid > 0 && alphaClient.status().generation > oldAlphaGeneration,
      'forceRestart returns only after a new utility generation answers ping and target-bound snapshot');
    const alphaTreeState = {
      replacementPid: alphaClient.status().pid,
      oldRootAlive: alphaClient.status().pid !== oldAlphaPid && await processIdentityIsAlive(oldAlphaPid, oldAlphaRootIdentity),
      branchAlive: await trackedProcessIdentityIsAlive(alphaPids.branchPid),
      leafAlive: await trackedProcessIdentityIsAlive(alphaPids.leafPid),
      lateLeafAlive: await trackedProcessIdentityIsAlive(alphaLateLeafPid),
      markerExists: fs.existsSync(alphaTree.markerPath),
    };
    ok(!alphaTreeState.oldRootAlive
      && !alphaTreeState.branchAlive
      && !alphaTreeState.leafAlive
      && !alphaTreeState.lateLeafAlive
      && !alphaTreeState.markerExists,
      `forceRestart returns with the selected utility worker process tree already dead: ${JSON.stringify(alphaTreeState)}`);
    ok(alphaLateLeafPid > 0 && !alphaTreeState.lateLeafAlive,
      'fallback quiescence captures and terminates a real child spawned by an identity-confirmed branch after the initial snapshot');
    const markerDeadline = fs.statSync(alphaTree.readyPath).mtimeMs + alphaTree.markerDelayMs + 300;
    await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, markerDeadline - Date.now())));
    ok(!fs.existsSync(alphaTree.markerPath),
      'a descendant delayed marker never appears after forceRestart returns');
    ok(forcedPrimaryKillFailures === 1,
      'real descendant regression forces the primary taskkill failure path exactly once');
    ok(betaClient.status().pid === oldBetaPid && processIsAlive(betaPids.branchPid) && processIsAlive(betaPids.leafPid) && fs.existsSync(betaTree.markerPath),
      'force-stopping one target leaves another target worker and descendant tree running');

    const primaryLateTarget = target('PrimaryLate');
    fs.mkdirSync(primaryLateTarget.workspace!.path, { recursive: true });
    let primaryLateTriggerPath = '';
    let primaryReportedSuccessCalls = 0;
    const primaryLateClient = new ElectronUtilityAgentClient(
      primaryLateTarget.workspace!.path,
      utilityScript,
      primaryLateTarget,
      {
        windowsProcessTree: {
          primaryKill: async rootPid => {
            primaryReportedSuccessCalls += 1;
            if (primaryLateTriggerPath) fs.writeFileSync(primaryLateTriggerPath, 'spawn during primary cleanup', 'utf8');
            // Deliberately report success while leaving the real tree alive.
            // The production gate must trust post-kill identity rescans rather
            // than the taskkill exit code and clean the late branch child.
            void rootPid;
            return true;
          },
        },
      },
    );
    utilityClients.push(primaryLateClient);
    await primaryLateClient.start();
    const primaryLateTree = await primaryLateClient.prompt({
      message: '__spawn_descendant_tree__',
      target: primaryLateTarget,
      options,
      queueMode: 'followUp',
    }) as unknown as {
      readyPath: string;
      markerPath: string;
      lateTriggerPath: string;
      lateReadyPath: string;
    };
    const primaryLatePids = await readDescendantPids(primaryLateTree.readyPath);
    primaryLateTriggerPath = primaryLateTree.lateTriggerPath;
    const oldPrimaryLateGeneration = primaryLateClient.status().generation;
    const primaryLateRestartStartedAt = Date.now();
    await primaryLateClient.forceRestart();
    const primaryLateRestartMs = Date.now() - primaryLateRestartStartedAt;
    const primaryLateLeafPid = await readLateDescendantPid(primaryLateTree.lateReadyPath);
    ok(primaryReportedSuccessCalls === 1
      && primaryLateClient.status().pid > 0
      && primaryLateClient.status().generation > oldPrimaryLateGeneration
      && !processIsAlive(primaryLatePids.branchPid)
      && !processIsAlive(primaryLatePids.leafPid)
      && !processIsAlive(primaryLateLeafPid)
      && !fs.existsSync(primaryLateTree.markerPath),
    'primary-success reports still require identity-aware late-child cleanup and stable empty rescans before replacement');
    ok(betaClient.status().pid === oldBetaPid
      && betaClient.status().generation === oldBetaGeneration
      && processIsAlive(betaPids.branchPid)
      && processIsAlive(betaPids.leafPid),
      'primary and fallback quiescence for other targets leave the Beta runtime tree alive');

    const betaRestartStartedAt = Date.now();
    await betaClient.forceRestart();
    const betaIdentityRestartMs = Date.now() - betaRestartStartedAt;
    await waitFor(() => !processIsAlive(betaPids.branchPid) && !processIsAlive(betaPids.leafPid) ? true : null);
    ok(betaClient.status().pid > 0 && betaClient.status().generation > oldBetaGeneration,
      'the default identity-handle cleanup starts a replacement generation only after tree confirmation');
    console.log(`UTILITY_FORCE_RESTART_TIMING alphaFallbackMs=${alphaRestartMs} primaryReportedSuccessMs=${primaryLateRestartMs} betaIdentityMs=${betaIdentityRestartMs}`);

    const reusedPid = 2_000_000_011;
    let reusedSnapshotCalls = 0;
    const reusedTerminationAttempts: number[] = [];
    let reusedPidError = '';
    try {
      await terminateWindowsUtilityProcessTree(reusedPid, '3001', {
        snapshot: async rootPid => {
          reusedSnapshotCalls += 1;
          return {
            rootPid,
            entries: [{
              pid: rootPid,
              parentPid: 0,
              depth: 0,
              creationIdentity: reusedSnapshotCalls === 1 ? '3001' : '3002',
            }],
          };
        },
        primaryKill: async () => true,
        terminatePid: pid => { reusedTerminationAttempts.push(pid); },
        maxRescans: 3,
        stableEmptyRescans: 2,
        rescanDelayMs: 0,
        rescanTimeoutMs: 50,
        forceStopDeadlineMs: 500,
      });
    } catch (error) {
      reusedPidError = error instanceof Error ? error.message : String(error);
    }
    ok(/PID reuse detected/i.test(reusedPidError) && reusedTerminationAttempts.length === 0,
      'creation-identity mismatch fails closed before any termination can target a reused PID');

    const rootIdentityMismatchTarget = target('RootIdentityMismatch');
    fs.mkdirSync(rootIdentityMismatchTarget.workspace!.path, { recursive: true });
    let expectedMismatchRootIdentity = '';
    let mismatchPrimaryCalls = 0;
    const mismatchTerminationAttempts: number[] = [];
    const rootIdentityMismatchClient = new ElectronUtilityAgentClient(
      rootIdentityMismatchTarget.workspace!.path,
      utilityScript,
      rootIdentityMismatchTarget,
      {
        windowsProcessTree: {
          snapshot: async rootPid => ({
            rootPid,
            entries: [{
              pid: rootPid,
              parentPid: 0,
              depth: 0,
              creationIdentity: (BigInt(expectedMismatchRootIdentity) + 1n).toString(),
            }],
          }),
          primaryKill: async () => { mismatchPrimaryCalls += 1; return true; },
          terminatePid: pid => { mismatchTerminationAttempts.push(pid); },
        },
      },
    );
    utilityClients.push(rootIdentityMismatchClient);
    await rootIdentityMismatchClient.start();
    expectedMismatchRootIdentity = rootIdentityMismatchClient.status().rootCreationIdentity;
    const mismatchOldPid = rootIdentityMismatchClient.status().pid;
    let rootIdentityMismatchError = '';
    try { await rootIdentityMismatchClient.forceRestart(); } catch (error) { rootIdentityMismatchError = error instanceof Error ? error.message : String(error); }
    await waitFor(() => !processIsAlive(mismatchOldPid) ? true : null);
    ok(/root creation identity mismatch/i.test(rootIdentityMismatchError)
      && mismatchPrimaryCalls === 0
      && mismatchTerminationAttempts.length === 0
      && rootIdentityMismatchClient.status().quarantined
      && rootIdentityMismatchClient.status().pid === 0,
    'an initial root identity mismatch performs zero PID-based cleanup, kills through the UtilityProcess handle, and quarantines replacement');

    const killFailureTarget = target('KillFailureRetainsHandle');
    fs.mkdirSync(killFailureTarget.workspace!.path, { recursive: true });
    let allowKillFailureRecovery = false;
    const killFailureClient = new ElectronUtilityAgentClient(
      killFailureTarget.workspace!.path,
      utilityScript,
      killFailureTarget,
      {
        windowsProcessTree: {
          snapshot: async () => { throw new Error('injected process-tree uncertainty before child-handle kill'); },
          snapshotTimeoutMs: 100,
          rescanTimeoutMs: 100,
        },
        killChild: defaultKill => allowKillFailureRecovery ? defaultKill() : false,
      },
    );
    utilityClients.push(killFailureClient);
    let lateWorkEvents = 0;
    let lateHostToolCalls = 0;
    killFailureClient.subscribe(() => { lateWorkEvents += 1; });
    killFailureClient.setHostToolHandler(Object.assign(
      async () => { lateHostToolCalls += 1; return {}; },
      { cancelTarget: () => undefined },
    ));
    await killFailureClient.start();
    const killFailureInternals = killFailureClient as unknown as {
      child: unknown;
      childGeneration: number;
      pending: Map<string, unknown>;
      handleMessage(child: unknown, generation: number, message: unknown): void;
    };
    const pendingHungPrompt = killFailureClient.prompt({
      message: '__hang_prompt__', target: killFailureTarget, options, queueMode: 'followUp',
    }).then(
      () => '',
      error => error instanceof Error ? error.message : String(error),
    );
    await waitFor(() => killFailureInternals.pending.size > 0 ? true : null);
    const retainedKillFailurePid = killFailureClient.status().pid;
    let retainedKillFailureError = '';
    try { await killFailureClient.forceRestart(); } catch (error) { retainedKillFailureError = error instanceof Error ? error.message : String(error); }
    const pendingHungPromptError = await pendingHungPrompt;
    killFailureInternals.handleMessage(killFailureInternals.child, killFailureInternals.childGeneration, {
      event: 'work',
      data: { id: 'late-work', conversationId: 'default', type: 'status', content: 'late', mode: 'build', model: '', timestamp: new Date().toISOString() },
    });
    killFailureInternals.handleMessage(killFailureInternals.child, killFailureInternals.childGeneration, {
      event: 'host_tool_request',
      data: { requestId: 'late-host-tool', tool: 'browser_use' },
    });
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    let retainedPromptError = '';
    try { await killFailureClient.prompt({ message: 'must stay blocked', target: killFailureTarget, options, queueMode: 'followUp' }); } catch (error) { retainedPromptError = error instanceof Error ? error.message : String(error); }
    let retainedUpdateError = '';
    try { await killFailureClient.updateSetting('agent', 'process_timeout_ms', 1); } catch (error) { retainedUpdateError = error instanceof Error ? error.message : String(error); }
    ok(/injected process-tree uncertainty/i.test(retainedKillFailureError)
      && killFailureClient.status().quarantined
      && killFailureClient.status().connected
      && killFailureClient.status().pid === retainedKillFailurePid
      && processIsAlive(retainedKillFailurePid)
      && /force-restarted/i.test(pendingHungPromptError)
      && /quarantined until the app backend is restarted/i.test(retainedPromptError)
      && /quarantined until the app backend is restarted/i.test(retainedUpdateError)
      && lateWorkEvents === 0
      && lateHostToolCalls === 0,
    'a failed child-handle kill rejects pending work, retains the live handle, and makes the quarantined generation inert to late work, host tools, and direct requests');
    allowKillFailureRecovery = true;
    try { await killFailureClient.forceStop(); } catch {}
    await waitFor(() => !processIsAlive(retainedKillFailurePid) ? true : null);
    ok(killFailureClient.status().quarantined && !killFailureClient.status().connected && killFailureClient.status().pid === 0,
      'a later explicit forceStop can retry the retained UtilityProcess handle without clearing sticky quarantine');

    const orphanAnchorTarget = target('OrphanAnchor');
    fs.mkdirSync(orphanAnchorTarget.workspace!.path, { recursive: true });
    const orphanBranchPid = 2_000_000_021;
    const orphanChildPid = 2_000_000_022;
    let orphanSnapshotCalls = 0;
    let orphanRescanAnchors: readonly number[] = [];
    const orphanTerminationAttempts: number[] = [];
    let orphanRootIdentity = '';
    const orphanAnchorClient = new ElectronUtilityAgentClient(
      orphanAnchorTarget.workspace!.path,
      utilityScript,
      orphanAnchorTarget,
      {
        windowsProcessTree: {
          snapshot: async (rootPid, _timeoutMs, anchorPids = []) => {
            orphanSnapshotCalls += 1;
            if (orphanSnapshotCalls === 1) {
              const rootCreation = orphanRootIdentity;
              return {
                rootPid,
                entries: [
                  { pid: rootPid, parentPid: 0, depth: 0, creationIdentity: rootCreation },
                  { pid: orphanBranchPid, parentPid: rootPid, depth: 1, creationIdentity: (BigInt(rootCreation) + 1n).toString() },
                ],
              };
            }
            orphanRescanAnchors = [...anchorPids];
            return {
              rootPid,
              entries: [{
                pid: orphanChildPid,
                parentPid: orphanBranchPid,
                depth: 1,
                creationIdentity: (BigInt(orphanRootIdentity) + 2n).toString(),
              }],
            };
          },
          primaryKill: async rootPid => {
            try { process.kill(rootPid, 'SIGKILL'); } catch {}
            await waitFor(() => !processIsAlive(rootPid) ? true : null);
            return true;
          },
          terminatePid: pid => { orphanTerminationAttempts.push(pid); },
          maxRescans: 3,
          stableEmptyRescans: 2,
          rescanDelayMs: 0,
          rescanTimeoutMs: 100,
        },
      },
    );
    utilityClients.push(orphanAnchorClient);
    await orphanAnchorClient.start();
    orphanRootIdentity = orphanAnchorClient.status().rootCreationIdentity;
    const orphanWorkerPid = orphanAnchorClient.status().pid;
    let orphanAnchorError = '';
    try { await orphanAnchorClient.forceRestart(); } catch (error) { orphanAnchorError = error instanceof Error ? error.message : String(error); }
    let orphanRetryError = '';
    try { await orphanAnchorClient.snapshot(); } catch (error) { orphanRetryError = error instanceof Error ? error.message : String(error); }
    ok(/appeared after parent identity could no longer be proven/i.test(orphanAnchorError)
      && orphanRescanAnchors.includes(orphanBranchPid)
      && orphanTerminationAttempts.length === 0
      && orphanAnchorClient.status().quarantined
      && orphanAnchorClient.status().pid === 0
      && !processIsAlive(orphanWorkerPid)
      && /quarantined until the app backend is restarted/i.test(orphanRetryError),
    'rescans anchor every known PID so a child of a now-missing branch is detected and quarantined instead of becoming a false empty tree');

    const rootSnapshotFailureTarget = target('RootSnapshotFailure');
    fs.mkdirSync(rootSnapshotFailureTarget.workspace!.path, { recursive: true });
    let rootSnapshotFailureCalls = 0;
    const rootSnapshotFailureClient = new ElectronUtilityAgentClient(
      rootSnapshotFailureTarget.workspace!.path,
      utilityScript,
      rootSnapshotFailureTarget,
      {
        windowsProcessTree: {
          snapshot: async () => {
            rootSnapshotFailureCalls += 1;
            throw new Error('injected root snapshot failure without primary hook');
          },
          snapshotTimeoutMs: 100,
          rescanTimeoutMs: 100,
        },
      },
    );
    utilityClients.push(rootSnapshotFailureClient);
    await rootSnapshotFailureClient.start();
    const rootSnapshotFailurePid = rootSnapshotFailureClient.status().pid;
    let rootSnapshotFailureError = '';
    try { await rootSnapshotFailureClient.forceRestart(); } catch (error) { rootSnapshotFailureError = error instanceof Error ? error.message : String(error); }
    await waitFor(() => !processIsAlive(rootSnapshotFailurePid) ? true : null);
    let rootSnapshotRetryError = '';
    try { await rootSnapshotFailureClient.snapshot(); } catch (error) { rootSnapshotRetryError = error instanceof Error ? error.message : String(error); }
    ok(/injected root snapshot failure without primary hook/i.test(rootSnapshotFailureError)
      && rootSnapshotFailureCalls === 2
      && rootSnapshotFailureClient.status().quarantined
      && rootSnapshotFailureClient.status().pid === 0
      && !processIsAlive(rootSnapshotFailurePid)
      && /quarantined until the app backend is restarted/i.test(rootSnapshotRetryError),
    'an initial snapshot failure without a primary hook kills the original UtilityProcess handle before detach and permanently blocks replacement');

    const residualTarget = target('Residual');
    fs.mkdirSync(residualTarget.workspace!.path, { recursive: true });
    const residualPid = 2_000_000_001;
    let residualRootIdentity = '';
    const residualClient = new ElectronUtilityAgentClient(residualTarget.workspace!.path, utilityScript, residualTarget, {
      windowsProcessTree: {
        snapshot: async rootPid => ({
          rootPid,
          entries: [
            { pid: rootPid, parentPid: 0, depth: 0, creationIdentity: residualRootIdentity },
            { pid: residualPid, parentPid: rootPid, depth: 1, creationIdentity: (BigInt(residualRootIdentity) + 1n).toString() },
          ],
        }),
        primaryKill: async () => false,
        terminatePid: pid => {
          if (pid === residualPid) return;
          try { process.kill(pid, 'SIGKILL'); } catch {}
        },
        maxRescans: 4,
        stableEmptyRescans: 2,
        rescanDelayMs: 10,
      },
    });
    utilityClients.push(residualClient);
    await residualClient.start();
    residualRootIdentity = residualClient.status().rootCreationIdentity;
    const residualWorkerPid = residualClient.status().pid;
    let residualError = '';
    try { await residualClient.forceRestart(); } catch (error) { residualError = error instanceof Error ? error.message : String(error); }
    await waitFor(() => residualClient.status().pid === 0 ? true : null);
    ok(/surviv|did not reach .*stable empty rescans/i.test(residualError) && !processIsAlive(residualWorkerPid),
      'a captured residual PID rejects forceRestart after killing the old worker instead of starting a new generation');
    let residualSnapshotError = '';
    let residualPromptError = '';
    try { await residualClient.snapshot(); } catch (error) { residualSnapshotError = error instanceof Error ? error.message : String(error); }
    try { await residualClient.prompt({ message: 'observe', target: residualTarget, options, queueMode: 'followUp' }); } catch (error) { residualPromptError = error instanceof Error ? error.message : String(error); }
    const residualOtherErrors: string[] = [];
    for (const attempt of [
      async () => await residualClient.enqueueGuide({
        clientMessageId: 'quarantine-guide',
        target: residualTarget,
        deliveryMode: 'steer' as const,
        text: 'must not restart',
        createdAt: new Date().toISOString(),
      }),
      async () => await residualClient.checkpoint(),
      async () => await residualClient.setWorkRunExpanded('quarantined-run', true),
      async () => await residualClient.forceRestart(),
    ]) {
      try { await attempt(); } catch (error) { residualOtherErrors.push(error instanceof Error ? error.message : String(error)); }
    }
    ok(residualClient.status().quarantined
      && residualClient.status().pid === 0
      && /quarantined until the app backend is restarted/i.test(residualSnapshotError)
      && /quarantined until the app backend is restarted/i.test(residualPromptError)
      && residualOtherErrors.length === 4
      && residualOtherErrors.every(error => /quarantined until the app backend is restarted/i.test(error)),
    'force-stop uncertainty permanently blocks snapshot, prompt, Guide, checkpoint, fold, and another forceRestart from auto-starting');

    const replacementSnapshotTarget = target('ReplacementSnapshotFailure');
    fs.mkdirSync(replacementSnapshotTarget.workspace!.path, { recursive: true });
    const replacementSnapshotClient = new ElectronUtilityAgentClient(
      replacementSnapshotTarget.workspace!.path,
      utilityScript,
      replacementSnapshotTarget,
    );
    utilityClients.push(replacementSnapshotClient);
    await replacementSnapshotClient.start();
    const oldReplacementSnapshotPid = replacementSnapshotClient.status().pid;
    const oldReplacementSnapshotGeneration = replacementSnapshotClient.status().generation;
    fs.writeFileSync(
      path.join(replacementSnapshotTarget.workspace!.path, 'inject-replacement-snapshot-failure'),
      'fail replacement snapshot',
      'utf8',
    );
    let replacementSnapshotError = '';
    try { await replacementSnapshotClient.forceRestart(); } catch (error) { replacementSnapshotError = error instanceof Error ? error.message : String(error); }
    await waitFor(() => replacementSnapshotClient.status().pid === 0 ? true : null);
    const failedCandidatePid = Number(replacementSnapshotError.match(/pid=(\d+)/)?.[1] || 0);
    let replacementRetryError = '';
    try { await replacementSnapshotClient.snapshot(); } catch (error) { replacementRetryError = error instanceof Error ? error.message : String(error); }
    ok(/injected replacement target snapshot failure/i.test(replacementSnapshotError)
      && replacementSnapshotClient.status().quarantined
      && replacementSnapshotClient.status().pid === 0
      && !processIsAlive(oldReplacementSnapshotPid)
      && failedCandidatePid > 0
      && replacementSnapshotClient.status().generation > oldReplacementSnapshotGeneration
      && !processIsAlive(failedCandidatePid)
      && /quarantined until the app backend is restarted/i.test(replacementRetryError),
    'forceRestart owns target snapshot validation and quarantines a failed candidate without allowing a later auto-start');

    const snapshotFailureTarget = target('SnapshotFailure');
    fs.mkdirSync(snapshotFailureTarget.workspace!.path, { recursive: true });
    let snapshotFailureCalls = 0;
    let snapshotFailurePrimaryKills = 0;
    const snapshotFailureClient = new ElectronUtilityAgentClient(
      snapshotFailureTarget.workspace!.path,
      utilityScript,
      snapshotFailureTarget,
      {
        windowsProcessTree: {
          snapshot: async rootPid => {
            snapshotFailureCalls += 1;
            if (snapshotFailureCalls === 1) throw new Error('injected initial Toolhelp snapshot failure');
            return { rootPid, entries: [{ pid: rootPid, parentPid: 0, depth: 0, creationIdentity: '2001' }] };
          },
          primaryKill: async rootPid => {
            snapshotFailurePrimaryKills += 1;
            try { process.kill(rootPid, 'SIGKILL'); } catch {}
            await waitFor(() => !processIsAlive(rootPid) ? true : null);
            return true;
          },
          snapshotTimeoutMs: 100,
          rescanTimeoutMs: 100,
        },
      },
    );
    utilityClients.push(snapshotFailureClient);
    await snapshotFailureClient.start();
    const snapshotFailureWorkerPid = snapshotFailureClient.status().pid;
    let snapshotFailureError = '';
    try { await snapshotFailureClient.forceRestart(); } catch (error) { snapshotFailureError = error instanceof Error ? error.message : String(error); }
    await waitFor(() => snapshotFailureClient.status().pid === 0 ? true : null);
    ok(/initial Toolhelp snapshot failure/i.test(snapshotFailureError)
      && snapshotFailureCalls === 2
      && snapshotFailurePrimaryKills === 1
      && !processIsAlive(snapshotFailureWorkerPid)
      && snapshotFailureClient.status().pid === 0,
    'an initial process-tree snapshot failure blocks replacement even when primary kill succeeds and the root is already dead');
  }

  const observed = await engine.run({ ...bound, actionId: 'observe-1' });
  ok(observed.ok && !!observed.observationId && observed.pageGeneration > 0, 'real WebContents observation succeeds');
  ok(observed.observation?.title === 'Browser Use Fixture' && observed.observation.refs.length >= 5, 'real DOM title and visible refs are returned');
  const ref = (name: string) => observed.observation!.refs.find(item => item.name === name)?.ref || '';
  ok(!!ref('Name') && !!ref('Color') && !!ref('Mark') && !!ref('Popup') && !!ref('Download') && !!ref('Delayed Popup') && !!ref('Delayed Download'), 'fixture controls receive opaque refs');

  const typed = await engine.run(request(observed, 'type', ref('Name'), { text: 'native input' }));
  ok(typed.ok, 'type uses trusted WebContents input');
  ok(await window.webContents.executeJavaScript(`document.querySelector('input').value === 'native input'`) === true, 'typed value reached the real page');

  const selected = await engine.run(request(observed, 'select', ref('Color'), { value: 'Blue' }));
  ok(selected.ok, 'native select action succeeds');
  ok(await window.webContents.executeJavaScript(`document.querySelector('select').value === 'blue'`) === true, 'selected value reached the real page');

  const clicked = await engine.run(request(observed, 'click', ref('Mark')));
  ok(clicked.ok, 'click uses trusted WebContents mouse input');
  ok(await window.webContents.executeJavaScript(`document.body.dataset.marked === 'yes'`) === true, 'click reached the real page');

  const popup = await engine.run(request(observed, 'click', ref('Popup')));
  ok(popup.ok && popup.effects?.popupBlocked === true, 'automation popup is denied and recorded in the receipt');
  ok(BrowserWindow.getAllWindows().filter(item => !item.isDestroyed()).length === 1, 'blocked popup creates no window');

  const download = await engine.run(request(observed, 'click', ref('Download')));
  ok(download.ok && download.effects?.downloadBlocked === true, 'automation download is denied and recorded in the receipt');

  const delayedPopup = await engine.run(request(observed, 'click', ref('Delayed Popup')));
  ok(delayedPopup.ok, 'delayed popup trigger click completes before its timer fires');
  await new Promise<void>(resolve => setTimeout(resolve, 550));
  ok(externalUrls.length === 0 && BrowserWindow.getAllWindows().filter(item => !item.isDestroyed()).length === 1, 'runtime-bound WebContents keeps delayed popups denied after the action guard settles and never opens the system browser');

  let delayedDownloadAttempts = 0;
  const countDelayedDownload = () => { delayedDownloadAttempts += 1; };
  window.webContents.session.on('will-download', countDelayedDownload);
  const delayedDownload = await engine.run(request(observed, 'click', ref('Delayed Download')));
  ok(delayedDownload.ok, 'delayed download trigger click completes before its timer fires');
  await new Promise<void>(resolve => setTimeout(resolve, 750));
  window.webContents.session.removeListener('will-download', countDelayedDownload);
  ok(delayedDownloadAttempts === 1 && fs.readdirSync(downloadDir).length === 0, 'runtime-bound WebContents keeps delayed downloads denied after the action guard settles');

  const extracted = await engine.run(request(observed, 'extract', ref('Name'), { attribute: 'aria-label' }));
  ok(extracted.ok && (extracted.data as { text?: string })?.text === 'Name', 'bounded extraction works on a real page');

  const survivorBound = bindBrowserUseRequest({ action: 'observe' }, {
    runtimeKey: 'workspace:survivor::conversation:default',
    actorId: 'survivor-test',
  });
  const survivorObserved = await engine.run({ ...survivorBound, actionId: 'survivor-observe' });
  const waitStartedAt = Date.now();
  const cancelledWait = engine.run({
    ...bound,
    action: 'wait',
    actionId: 'cancel-real-wait',
    pageGeneration: observed.pageGeneration,
    observationId: observed.observationId,
    durationMs: 10_000,
  });
  await new Promise<void>(resolve => setTimeout(resolve, 75));
  const survivorExtract = engine.run({
    ...survivorBound,
    action: 'extract',
    actionId: 'survivor-extract',
    pageGeneration: survivorObserved.pageGeneration,
    observationId: survivorObserved.observationId,
    maxChars: 2_000,
  });
  engine.clearRuntime(bound.runtimeKey);
  let waitRejected = false;
  try { await cancelledWait; } catch { waitRejected = true; }
  const survivorReceipt = await survivorExtract;
  ok(waitRejected, 'target clear aborts a real in-flight Browser-Use wait');
  ok(Date.now() - waitStartedAt < 1_500, 'aborted real wait exits promptly instead of continuing in the Electron host');
  ok(survivorReceipt.ok && JSON.stringify(survivorReceipt.data).includes('fixture ready'), 'clearing one runtime releases the page mutex without cancelling another runtime queued on the same WebContents');

  host.clear();
  engine.clear();
  await window.webContents.executeJavaScript(`window.open('/manual-popup','_blank')`);
  await new Promise<void>(resolve => setTimeout(resolve, 100));
  ok(externalUrls.some(url => url.endsWith('/manual-popup')), 'clearing the final runtime binding restores user popup/external-link handling');
  let restoredDownloadAttempts = 0;
  let restoredDownloadPrevented = false;
  const observeRestoredDownload = (event: Electron.Event) => {
    restoredDownloadAttempts += 1;
    restoredDownloadPrevented = (event as Electron.Event & { defaultPrevented?: boolean }).defaultPrevented === true;
  };
  window.webContents.session.on('will-download', observeRestoredDownload);
  const manualDownloadPoint = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector('a[aria-label="Download"]').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`) as { x: number; y: number };
  window.webContents.focus();
  window.webContents.sendInputEvent({ type: 'mouseMove', x: manualDownloadPoint.x, y: manualDownloadPoint.y });
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: manualDownloadPoint.x, y: manualDownloadPoint.y });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: manualDownloadPoint.x, y: manualDownloadPoint.y });
  await new Promise<void>(resolve => setTimeout(resolve, 750));
  window.webContents.session.removeListener('will-download', observeRestoredDownload);
  const restoredDownloadFiles = fs.readdirSync(downloadDir);
  ok(restoredDownloadAttempts === 1 && !restoredDownloadPrevented, `clearing the final runtime binding stops Browser-Use from preventing ordinary user downloads (files=${restoredDownloadFiles.join(',')})`);

  const unsafe = await engine.run({ ...bound, action: 'navigate', actionId: 'unsafe', url: 'javascript:alert(1)' });
  ok(!unsafe.ok && unsafe.code === 'unsafe_navigation', 'unsafe navigation is rejected before WebContents');
  const navigated = await engine.run({ ...bound, action: 'navigate', actionId: 'navigate', url: 'about:blank' });
  ok(navigated.ok && navigated.effects?.pageChanged === true, 'real main-frame navigation advances page identity');
  const stale = await engine.run(request(observed, 'click', ref('Mark')));
  ok(!stale.ok && stale.code === 'observation_required' && stale.nextAction === 'observe', 'old real-page capability is rejected after navigation');

  console.log(`BROWSER_USE_ELECTRON_HOST_OK assertions=${assertions}`);
}

app.disableHardwareAcceleration();
void app.whenReady()
  .then(run)
  .then(async () => {
    await closeFixture();
    app.exit(0);
  })
  .catch(async error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    await closeFixture().catch(() => undefined);
    app.exit(1);
  });
