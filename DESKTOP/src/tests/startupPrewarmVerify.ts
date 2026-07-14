import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { checkGitHubUpdate } from '../core/installUpdate';
import { runStartupPrewarmBarrier, startupUpdatePromptContent, withStartupTimeout } from '../core/startupPrewarm';

let assertions = 0;
function ok(value: unknown, message: string): void {
  assert.ok(value, message);
  assertions += 1;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function verifyBarrier(): Promise<void> {
  let releaseSlowTask: (() => void) | null = null;
  const slowTask = new Promise<void>(resolve => { releaseSlowTask = resolve; });
  let settled = false;
  const barrier = runStartupPrewarmBarrier([
    { id: 'kernel', label: 'Kernel', required: true, run: async () => 'ready' },
    { id: 'ui', label: 'UI', required: true, run: async () => { await slowTask; return 'ready'; } },
    { id: 'update', label: 'Update', required: false, run: async () => { throw new Error('offline'); } },
  ]).then(result => { settled = true; return result; });
  await Promise.resolve();
  ok(!settled, 'startup barrier does not release while a required UI prewarm task is pending');
  releaseSlowTask!();
  const result = await barrier;
  ok(result.ok && result.completed === 3, 'startup barrier waits for every required and optional task to settle');
  ok(result.warnings.length === 1 && result.warnings[0].id === 'update', 'optional update failure completes the barrier as a warning');

  const failed = await runStartupPrewarmBarrier([
    { id: 'worker', label: 'Worker', required: true, run: async () => { throw new Error('ping failed'); } },
  ]);
  ok(!failed.ok && failed.failures[0].id === 'worker', 'required worker failure blocks main UI reveal');
  const retried = await runStartupPrewarmBarrier([
    { id: 'worker', label: 'Worker', required: true, run: async () => 'pong' },
  ]);
  ok(retried.ok, 'a fresh retry can complete after the required worker recovers');

  const timed = await withStartupTimeout(new Promise<string>(() => undefined), 20, 'offline update check');
  ok(timed.ok === false && /timed out/i.test(timed.error || ''), 'startup timeout converts a hanging optional check into a settled result');
}

async function verifyReleaseSelection(): Promise<void> {
  const requests: string[] = [];
  const releaseList = [
    { tag_name: 'dev-9.9.9', draft: true, prerelease: true, assets: [] },
    { tag_name: 'dev-0.0.8', draft: false, prerelease: true, assets: [] },
    { tag_name: 'v0.0.9', draft: false, prerelease: false, assets: [] },
    {
      tag_name: 'dev-0.0.10',
      draft: false,
      prerelease: true,
      html_url: 'https://example.test/dev-0.0.10',
      assets: [{
        name: 'Newmark-Agent-0.0.10-win-unpacked-x64.zip',
        size: 123,
        browser_download_url: 'https://example.test/update.zip',
        content_type: 'application/zip',
      }],
    },
  ];
  const listFetch = async (input: RequestInfo | URL): Promise<Response> => {
    requests.push(String(input));
    return jsonResponse(releaseList);
  };
  const newer = await checkGitHubUpdate('', '', '', undefined, {
    fetchImpl: listFetch,
    apiBaseUrl: 'https://api.example.test',
    currentVersion: '0.0.9',
    timeoutMs: 100,
  });
  ok(requests[0].endsWith('/repos/positer/Newmark-Agent/releases?per_page=30'), 'automatic update check reads the finite releases list so prereleases are visible');
  ok(newer.ok && newer.tag === 'dev-0.0.10' && newer.version === '0.0.10', 'automatic update check selects the highest non-draft dev release');
  ok(newer.updateAvailable === true && newer.selectedAsset?.name.includes('0.0.10'), 'strictly newer dev release produces an update prompt and selected Windows zip');
  const zhPrompt = startupUpdatePromptContent(newer, 'zh', 'en-US');
  const enPrompt = startupUpdatePromptContent(newer, 'en', 'zh-CN');
  ok(zhPrompt?.buttons.join('/') === '查看更新/稍后' && zhPrompt.detail.includes('0.0.9') && zhPrompt.detail.includes('0.0.10'), 'new-version popup is localized in Chinese and shows current/remote versions');
  ok(enPrompt?.buttons.join('/') === 'View update/Later' && enPrompt.message.includes('0.0.10'), 'new-version popup is localized in English');

  const equal = await checkGitHubUpdate('', '', '', undefined, {
    fetchImpl: async () => jsonResponse([{ tag_name: 'dev-0.0.9', draft: false, prerelease: true, assets: [] }]),
    currentVersion: '0.0.9',
    timeoutMs: 100,
  });
  ok(equal.ok && equal.updateAvailable === false, 'equal dev version is not reported as an update');
  ok(startupUpdatePromptContent(equal, 'zh') === null, 'equal version does not create a startup update popup');

  const older = await checkGitHubUpdate('', '', '', undefined, {
    fetchImpl: async () => jsonResponse([{ tag_name: 'dev-0.0.8', draft: false, prerelease: true, assets: [] }]),
    currentVersion: '0.0.9',
    timeoutMs: 100,
  });
  ok(older.ok && older.updateAvailable === false, 'older dev version is not reported as an update');

  let explicitEndpoint = '';
  const explicit = await checkGitHubUpdate('', 'dev-0.0.8', '', undefined, {
    fetchImpl: async input => {
      explicitEndpoint = String(input);
      return jsonResponse({ tag_name: 'dev-0.0.8', draft: false, prerelease: true, assets: [] });
    },
    currentVersion: '0.0.9',
    timeoutMs: 100,
  });
  ok(explicit.ok && explicitEndpoint.endsWith('/releases/tags/dev-0.0.8'), 'manual tag checks preserve the release-by-tag API path');

  const started = Date.now();
  const offline = await checkGitHubUpdate('', '', '', undefined, {
    fetchImpl: (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
    currentVersion: '0.0.9',
    timeoutMs: 25,
  });
  ok(!offline.ok && Date.now() - started < 500 && /timed out/i.test(offline.error || ''), 'offline update check has a bounded timeout and cannot pin the splash forever');
}

function verifyDesktopContracts(): void {
  const mainTs = fs.readFileSync(path.join(process.cwd(), 'src', 'main.ts'), 'utf8');
  const preloadTs = fs.readFileSync(path.join(process.cwd(), 'src', 'preload.ts'), 'utf8');
  const uiHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'index.html'), 'utf8');
  const packagedStartupSmoke = fs.readFileSync(path.join(process.cwd(), 'scripts', 'release-ui-startup-recovery-smoke.cjs'), 'utf8');
  const packagedDev009Smoke = fs.readFileSync(path.join(process.cwd(), 'scripts', 'release-dev009-features-smoke.cjs'), 'utf8');
  const requiredHydrationKeys = ['state', 'fileTree', 'rightStatus', 'flows', 'terminal', 'browser', 'rendered'];
  ok(mainTs.includes('startupWindow') && mainTs.includes('uiPrewarmWindow') && mainTs.includes('promotePrewarmedUi'), 'main process keeps the visible startup shell separate from the hidden prewarmed UI');
  ok(mainTs.includes("show: false") && mainTs.includes("startup:uiReady") && mainTs.includes('runStartupPrewarmBarrier'), 'main window reveal is gated by the startup barrier and renderer readiness handshake');
  ok(mainTs.includes('devTools: loadUi'), 'startup shell disables DevTools/CDP exposure so existing packaged smokes cannot attach to the transient splash');
  ok(mainTs.includes('id="startup-icon"') && mainTs.includes("createAppIconImage(64).toDataURL()") && mainTs.includes("STARTUP_HTML.replace('__NEWMARK_STARTUP_ICON__'"), 'startup splash embeds the real local Newmark icon as a data URL in development and packaged builds');
  ok(mainTs.includes('runtime-prewarm') && mainTs.includes('.snapshot('), 'startup barrier performs an actual composite-target worker snapshot/ping');
  ok(mainTs.includes("requestedWorkspaceId === 'none'")
    && mainTs.includes("requestedWorkspaceId === 'no-workspace'")
    && mainTs.includes("noWorkspaceRequested ? 'none'"), 'startup snapshot accepts the canonical no-workspace target without weakening unknown-workspace rejection');
  ok(uiHtml.includes("state.currentWorkspace || 'none'")
    && !uiHtml.includes("state.currentWorkspace || 'no-workspace'"), 'renderer uses the canonical no-workspace runtime identity during first-run hydration');
  ok(preloadTs.includes('startupUiReady') && preloadTs.includes('startupRetry') && preloadTs.includes('onStartupStatus'), 'preload exposes narrow readiness, retry, and status startup APIs');
  ok(uiHtml.includes('startupUiReady') && uiHtml.includes('startupUiFailed') && uiHtml.includes('required: true'), 'renderer reports ready only after required initial hydration and reports failures');
  ok(uiHtml.includes('window.refreshRightStatus = function(options)')
    && uiHtml.includes('return api.getState(currentConversationTarget()).then'), 'right status hydration exposes its completion as an awaitable promise');
  ok(uiHtml.includes('window.loadFlows = function(options)')
    && uiHtml.includes('return api.listFlows().then')
    && uiHtml.includes('return Promise.all(flowNames.map'), 'Flow hydration resolves only after every initial Flow has been read');
  ok(uiHtml.includes('window.spawnTerminal = function(shellId, options)')
    && uiHtml.includes('return window.addTerminalTab(shellId, options)')
    && uiHtml.includes('return terminalReadyPromise'), 'initial terminal spawning exposes PTY connection completion as an awaitable promise');
  ok(uiHtml.includes('window.prewarmBrowserPanel = function(options)')
    && uiHtml.includes("view.setAttribute('src', 'about:blank')")
    && uiHtml.includes('api.browserRegisterGuest(view.getWebContentsId())'), 'UI prewarm creates and registers the built-in Browser guest at about:blank without an external startup navigation');
  const startupBarrierIndex = uiHtml.indexOf('await Promise.all([', uiHtml.indexOf('if (startupPrewarmRequired)'));
  const startupReadyIndex = uiHtml.indexOf('api.startupUiReady(', startupBarrierIndex);
  const startupBarrierSource = startupBarrierIndex >= 0 && startupReadyIndex > startupBarrierIndex
    ? uiHtml.slice(startupBarrierIndex, startupReadyIndex)
    : '';
  ok(startupBarrierSource.includes('startupRightStatusReady')
    && startupBarrierSource.includes('startupFlowsReady')
    && startupBarrierSource.includes('startupTerminalReady')
    && startupBarrierSource.includes('startupBrowserReady')
    && startupBarrierSource.includes('window.loadFileTree({ required: true })'), 'renderer readiness waits for right status, Flows, initial terminal, and file tree in one Promise barrier');
  const mainHydrationContractStart = mainTs.indexOf('const REQUIRED_STARTUP_UI_HYDRATION');
  const mainHydrationContractEnd = mainTs.indexOf('] as const', mainHydrationContractStart);
  const mainHydrationContract = mainHydrationContractStart >= 0 && mainHydrationContractEnd > mainHydrationContractStart
    ? mainTs.slice(mainHydrationContractStart, mainHydrationContractEnd)
    : '';
  const readyHandlerStart = mainTs.indexOf("ipcMain.handle('startup:uiReady'");
  const readyHandlerEnd = mainTs.indexOf("ipcMain.handle('startup:uiFailed'", readyHandlerStart);
  const readyHandlerSource = readyHandlerStart >= 0 && readyHandlerEnd > readyHandlerStart
    ? mainTs.slice(readyHandlerStart, readyHandlerEnd)
    : '';
  ok(requiredHydrationKeys.every(key => mainHydrationContract.includes(`'${key}'`))
    && readyHandlerSource.includes('payload?.hydrated?.[key] !== true')
    && readyHandlerSource.includes('waiter.reject(new Error(hydrationError))')
    && readyHandlerSource.includes('accepted: false'), 'main process rejects renderer readiness unless every required hydration field is explicitly true');
  const rendererReadyPayloadStart = uiHtml.indexOf('var readyAck = await api.startupUiReady({');
  const rendererReadyPayloadEnd = uiHtml.indexOf('});', rendererReadyPayloadStart);
  const rendererReadyPayload = rendererReadyPayloadStart >= 0 && rendererReadyPayloadEnd > rendererReadyPayloadStart
    ? uiHtml.slice(rendererReadyPayloadStart, rendererReadyPayloadEnd)
    : '';
  ok(requiredHydrationKeys.every(key => rendererReadyPayload.includes(`${key}: true`)), 'renderer readiness payload explicitly attests every required hydration field');
  ok(packagedStartupSmoke.includes('hydration: {')
    && requiredHydrationKeys.every(key => packagedStartupSmoke.includes(`${key}:`))
    && packagedStartupSmoke.includes('missingHydration'), 'packaged startup smoke verifies all six required hydration outcomes after promotion');
  ok(mainTs.indexOf('promotePrewarmedUi') < mainTs.indexOf('showStartupUpdatePrompt'), 'available-update prompt is scheduled only after the prewarmed main UI promotion path exists');
  const ensureBrowserStart = mainTs.indexOf('async function ensureBrowserWebContents');
  const ensureBrowserEnd = mainTs.indexOf('function ensureElectronBrowserUseHost', ensureBrowserStart);
  const ensureBrowserSource = ensureBrowserStart >= 0 && ensureBrowserEnd > ensureBrowserStart
    ? mainTs.slice(ensureBrowserStart, ensureBrowserEnd)
    : '';
  ok(ensureBrowserSource.includes("host.send('browser:ensureGuest')")
    && ensureBrowserSource.includes('waitForRegisteredBrowserGuest')
    && !ensureBrowserSource.includes('new BrowserWindow'), 'cold Browser-Use requests the registered built-in guest with a bounded wait and has no invisible BrowserWindow fallback');
  const coldBrowserUseIndex = packagedDev009Smoke.indexOf("action_id: 'dev009-cold-navigate'");
  const firstVisibleBrowserIndex = packagedDev009Smoke.indexOf("window.switchRightTab('browser')", coldBrowserUseIndex);
  ok(coldBrowserUseIndex >= 0
    && firstVisibleBrowserIndex > coldBrowserUseIndex
    && packagedDev009Smoke.includes('cold Browser-Use page survives first visible Browser activation'), 'packaged acceptance invokes Browser-Use before the Browser tab is ever visible and verifies the same guest survives activation');
  ok(mainTs.includes('const webContentsId = win.webContents.id')
    && mainTs.includes('rejectUiReadinessById(Number(fileRouterOwnerId)')
    && mainTs.includes('if (win.isDestroyed()) return;'), 'destroyed startup windows settle readiness by captured webContents id without dereferencing a destroyed Electron object');

  const scriptsDir = path.join(process.cwd(), 'scripts');
  const cdpReadyHelper = fs.readFileSync(path.join(scriptsDir, 'cdp-main-ui-ready.js'), 'utf8');
  ok(cdpReadyHelper.includes("document.visibilityState === 'visible'")
    && cdpReadyHelper.includes("document.readyState === 'complete'")
    && cdpReadyHelper.includes('!!window.api')
    && cdpReadyHelper.includes("!!document.querySelector('#prompt')"), 'shared CDP gate waits for a promoted, hydrated, visible main renderer');
  const cdpScripts = fs.readdirSync(scriptsDir)
    .filter(name => name.endsWith('.cjs'))
    .map(name => ({ name, text: fs.readFileSync(path.join(scriptsDir, name), 'utf8') }))
    .filter(entry => entry.text.includes('/json/list'));
  ok(cdpScripts.length === 38, 'startup contract audits every current CDP release script');
  const unsafeCdpTargets = cdpScripts.filter(entry => !entry.text.includes('index.html')
    || /\|\|\s*(?:targets|list|pages|lastTargets)\.find/.test(entry.text)
    || /String\([^\n]*title[^\n]*Newmark/.test(entry.text)
    || /if\s*\(lastTargets\.length\s*>=\s*minTargets\)/.test(entry.text));
  ok(unsafeCdpTargets.length === 0, `all CDP release scripts wait for final index.html only: ${unsafeCdpTargets.map(entry => entry.name).join(', ')}`);
  const ungatedCdpTargets = cdpScripts.filter(entry => {
    if (!entry.text.includes("require('./cdp-main-ui-ready')")) return true;
    const readyMatches = [...entry.text.matchAll(/await\s+([A-Za-z_$][\w$]*)\.ready\s*;/g)];
    const mainReadyMatches = readyMatches.filter(match => match[1] !== 'startupCdp');
    if (mainReadyMatches.length === 0) return true;
    return mainReadyMatches.some(match => {
      const following = entry.text.slice((match.index || 0) + match[0].length);
      return !new RegExp(`^\\s*await\\s+waitForPromotedMainUi\\(${match[1]}\\)\\s*;`).test(following);
    });
  });
  ok(ungatedCdpTargets.length === 0, `all CDP release connections gate on visible promoted UI immediately after socket readiness: ${ungatedCdpTargets.map(entry => entry.name).join(', ')}`);
}

async function main(): Promise<void> {
  await verifyBarrier();
  await verifyReleaseSelection();
  verifyDesktopContracts();
  console.log(`startup prewarm verification passed (${assertions} assertions)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
