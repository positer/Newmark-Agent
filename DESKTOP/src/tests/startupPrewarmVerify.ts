import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { checkGitHubUpdate } from '../core/installUpdate';
import {
  runStartupPrewarmBarrier,
  scheduleDeferredStartupTasks,
  startupUpdatePromptContent,
  withStartupTimeout,
} from '../core/startupPrewarm';

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

  let cancelledTaskRuns = 0;
  const cancelled = scheduleDeferredStartupTasks([{
    id: 'cancelled-after-promotion',
    label: 'cancelled after promotion',
    delayMs: 30,
    run: async () => { cancelledTaskRuns += 1; },
  }]);
  cancelled.cancel();
  const cancelledResults = await cancelled.done;
  ok(cancelledTaskRuns === 0 && cancelledResults[0]?.status === 'cancelled', 'deferred startup work can be cancelled before it consumes post-promotion resources');

  const warnings = scheduleDeferredStartupTasks([{
    id: 'post-promotion-warning',
    label: 'post promotion warning',
    run: async () => { throw new Error('optional offline'); },
  }]);
  const warningResults = await warnings.done;
  ok(warningResults[0]?.status === 'warning' && /optional offline/.test(warningResults[0]?.error || ''), 'deferred startup failures settle as warnings and cannot reject the first-frame path');
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
  const startupHtmlPath = path.join(process.cwd(), 'src', 'ui', 'startup.html');
  const startupHtml = fs.existsSync(startupHtmlPath) ? fs.readFileSync(startupHtmlPath, 'utf8') : '';
  const buildUiIcons = fs.readFileSync(path.join(process.cwd(), 'scripts', 'build-ui-icons.cjs'), 'utf8');
  const promotedMainUiProbe = fs.readFileSync(path.join(process.cwd(), 'scripts', 'cdp-main-ui-ready.js'), 'utf8');
  const packagedStartupSmoke = fs.readFileSync(path.join(process.cwd(), 'scripts', 'release-ui-startup-recovery-smoke.cjs'), 'utf8');
  const packagedDev009Smoke = fs.readFileSync(path.join(process.cwd(), 'scripts', 'release-dev009-features-smoke.cjs'), 'utf8');
  const requiredHydrationKeys = ['state', 'rendered'];
  const deferredHydrationKeys = ['fileTree', 'rightStatus', 'flows', 'terminal', 'browser'];
  ok(mainTs.includes('startupWindow')
    && !mainTs.includes('uiPrewarmWindow')
    && mainTs.includes('promoteStartupUi'), 'startup shell and hydrated desktop share one BrowserWindow without a hidden candidate');
  ok(mainTs.includes("'disable-background-networking'")
    && mainTs.includes("'disable-component-update'")
    && mainTs.includes("'disable-default-apps'")
    && mainTs.includes("'disable-sync'")
    && mainTs.includes("'no-first-run'")
    && mainTs.includes('app.commandLine.appendSwitch(startupSwitch)'), 'Electron disables only built-in background services while Newmark keeps its explicit deferred update path');
  ok(mainTs.includes('startupAttempt = 1')
    && mainTs.includes('startupWindow = createDesktopWindow(true, true, startupAttempt)')
    && !mainTs.includes('createDesktopWindow!(true, false, attemptId)')
    && mainTs.includes('const startupUiWindow = startupWindow'), 'startup creates exactly one visible BrowserWindow and loads attempt-one index.html directly');
  ok(mainTs.includes("show: false") && mainTs.includes("startup:uiReady") && mainTs.includes('runStartupPrewarmBarrier'), 'same-window UI readiness remains gated by the startup barrier and renderer handshake');
  ok(mainTs.includes('devTools: true'), 'the single startup webContents remains inspectable after navigating from splash to the final UI');
  ok(startupHtml.includes('id="startup-icon"')
    && startupHtml.includes('src="../../assets/icon.ico"')
    && startupHtml.includes('window.api.onStartupStatus')
    && startupHtml.includes('window.api.startupRetry'), 'static startup splash keeps the real local icon plus status and retry preload behavior');
  ok(mainTs.includes("win.loadFile(path.join(__dirname, 'ui', 'startup.html'))")
    && mainTs.includes("path.basename(new URL(value).pathname) === 'startup.html'")
    && !mainTs.includes('const STARTUP_HTML')
    && !mainTs.includes('createAppIconImage(64).toDataURL()')
    && !mainTs.includes('encodeURIComponent(startupHtml)'), 'startup failure fallback is a small local file and contains no generated HTML, PNG data URL, or percent encoding');
  ok(buildUiIcons.includes("const startupSrc = path.join(root, 'src', 'ui', 'startup.html')")
    && buildUiIcons.includes('fs.copyFileSync(startupSrc, startupDist)'), 'normal UI build copies the static splash into dist/ui for development and packaging');
  ok(mainTs.includes("id: 'conversation-state'")
    && mainTs.includes('startupAgent.ensureConversationSnapshot(target.conversationId)'), 'startup barrier validates the current local/persisted Agent conversation snapshot');
  ok(mainTs.includes("requestedWorkspaceId === 'none'")
    && mainTs.includes("requestedWorkspaceId === 'no-workspace'")
    && mainTs.includes("noWorkspaceRequested ? 'none'"), 'startup snapshot accepts the canonical no-workspace target without weakening unknown-workspace rejection');
  ok(uiHtml.includes("state.currentWorkspace || 'none'")
    && !uiHtml.includes("state.currentWorkspace || 'no-workspace'"), 'renderer uses the canonical no-workspace runtime identity during first-run hydration');
  ok(preloadTs.includes('startupUiReady')
    && preloadTs.includes('startupRetry')
    && preloadTs.includes("startupWaitForBackend: () => ipcRenderer.invoke('startup:waitForBackend')")
    && preloadTs.includes('onStartupStatus'), 'preload exposes narrow backend barrier, readiness, retry, and status startup APIs');
  ok(uiHtml.includes('startupUiReady') && uiHtml.includes('startupUiFailed'), 'renderer reports required initial hydration and reports failures');
  const startupBackendWaitIndex = uiHtml.indexOf('var backendReadyAck = await api.startupWaitForBackend()');
  const startupInitialStateIndex = uiHtml.indexOf('var s = await api.getState(startupPrewarmRequired ? undefined : activeConversationId())');
  ok(startupBackendWaitIndex >= 0
    && startupInitialStateIndex > startupBackendWaitIndex
    && uiHtml.includes("backendReadyAck.ready !== true"), 'startup renderer crosses the backend registration barrier before its first Agent state invocation');
  const startupCoverAckIndex = uiHtml.indexOf("if (!readyAck || readyAck.accepted !== true) throw new Error('Main process rejected the UI readiness handshake')");
  const startupCoverRemovalIndex = uiHtml.indexOf("startupCover.remove()", startupCoverAckIndex);
  const startupCoverCatchIndex = uiHtml.indexOf('} catch (startupError)', startupCoverAckIndex);
  ok(uiHtml.includes("document.documentElement.classList.add('startup-prewarm')")
    && uiHtml.includes('id="startup-cover"')
    && startupCoverAckIndex >= 0
    && startupCoverRemovalIndex > startupCoverAckIndex
    && startupCoverCatchIndex > startupCoverRemovalIndex, 'attempt-one index keeps a fixed startup cover until the readiness acknowledgement succeeds');
  ok(promotedMainUiProbe.includes("!document.documentElement.classList.contains('startup-prewarm')")
    && promotedMainUiProbe.includes("!document.querySelector('#startup-cover')")
    && promotedMainUiProbe.includes('!prompt.disabled')
    && promotedMainUiProbe.includes('!prompt.readOnly'), 'packaged readiness waits for the same-window cover to be removed and the prompt to be writable after acknowledgement');
  ok(uiHtml.includes('window.refreshRightStatus = function(options)')
    && uiHtml.includes('return api.getState(currentConversationTarget()).then'), 'right status hydration exposes its completion as an awaitable promise');
  ok(uiHtml.includes('window.loadFlows = function(options)')
    && uiHtml.includes('return api.listFlows().then')
    && uiHtml.includes('return Promise.all(flowNames.map'), 'Flow hydration resolves only after every initial Flow has been read');
  ok(uiHtml.includes('window.spawnTerminal = function(shellId, options)')
    && uiHtml.includes('return window.addTerminalTab(shellId, options)')
    && uiHtml.includes('return terminalReadyPromise'), 'terminal spawning exposes PTY connection completion as an awaitable promise');
  ok(!uiHtml.includes('<webview id="browser-webview"')
    && uiHtml.includes("document.createElement('webview')")
    && uiHtml.includes("view.setAttribute('partition', NEWMARK_BROWSER_PARTITION)")
    && uiHtml.includes('api.browserRegisterGuest(view.getWebContentsId())'), 'Browser guest is absent from first-frame DOM and is created dynamically with the retained partition');
  ok(uiHtml.includes('NEWMARK_BROWSER_MIN_CREATE_DELAY_MS = 5000')
    && uiHtml.includes('NEWMARK_BROWSER_IDLE_DESTROY_MS = 60000')
    && uiHtml.includes('browserGuestCreatePromise')
    && uiHtml.includes('destroyIdleBrowserGuest'), 'Browser creation has a five-second floor, a single-flight guest, and a sixty-second idle-destroy path');
  ok(uiHtml.includes('window.browserGuestLifecycleSnapshot = function()')
    && uiHtml.includes('browserGuestCreateCount += 1')
    && uiHtml.includes('browserGuestFirstCreatedAtMs = Date.now() - newmarkRendererStartedAt'), 'Browser lifecycle exposes auditable creation count and first-create timing without creating a guest');
  ok(uiHtml.includes("if (tab === 'browser')")
    && uiHtml.includes('window.ensureBrowserPanel({ activate: true })')
    && uiHtml.includes('api.onBrowserEnsureGuest'), 'the first visible Browser activation or Browser tool demand is the only guest creation trigger');
  ok(uiHtml.includes("var targetUrl = browserRetainedUrl || 'about:blank'")
    && uiHtml.includes("if (targetUrl !== 'about:blank'")
    && !uiHtml.includes("browserRetainedUrl !== 'about:blank' ? browserRetainedUrl : 'https://github.com'"), 'first Browser activation creates only a blank guest and never loads a remote default page');
  const startupBarrierIndex = uiHtml.lastIndexOf('if (startupPrewarmRequired)');
  const startupReadyIndex = uiHtml.indexOf('api.startupUiReady(', startupBarrierIndex);
  const startupBarrierSource = startupBarrierIndex >= 0 && startupReadyIndex > startupBarrierIndex
    ? uiHtml.slice(startupBarrierIndex, startupReadyIndex)
    : '';
  ok(deferredHydrationKeys.every(key => !startupBarrierSource.includes(key))
    && !startupBarrierSource.includes('window.loadFileTree(')
    && !startupBarrierSource.includes('window.prewarmBrowserPanel('), 'renderer readiness no longer blocks on deferred panels, terminal, file tree, or Browser guest creation');
  ok(!startupBarrierSource.includes('requestAnimationFrame(')
    && startupBarrierSource.includes('setTimeout(resolve, 0)')
    && startupBarrierSource.includes('document.documentElement.offsetWidth'), 'hidden renderer readiness yields and verifies layout without waiting for a throttled animation frame');
  ok(!uiHtml.includes('scheduleDeferredUiHydration')
    && !uiHtml.includes('_deferredUiHydration'), 'renderer startup has no background hydration queue that can create Flow, PTY, or file-tree work after promotion');
  const postStartupSchedulerStart = uiHtml.indexOf('function schedulePostStartupUiRendering()');
  const postStartupSchedulerEnd = uiHtml.indexOf('// Start JS marquee', postStartupSchedulerStart);
  const postStartupSchedulerSource = postStartupSchedulerStart >= 0 && postStartupSchedulerEnd > postStartupSchedulerStart
    ? uiHtml.slice(postStartupSchedulerStart, postStartupSchedulerEnd)
    : '';
  const startupCoverClassRemovalIndex = uiHtml.indexOf("document.documentElement.classList.remove('startup-prewarm')");
  const postStartupScheduleIndex = uiHtml.indexOf('schedulePostStartupUiRendering();', startupCoverClassRemovalIndex);
  ok(postStartupSchedulerSource.includes('window.upgradeRightSidebar()')
    && postStartupSchedulerSource.includes('window.refreshModelSelect()')
    && postStartupSchedulerSource.includes('renderConversations()')
    && postStartupSchedulerSource.includes('applyLanguageToUi()')
    && postStartupSchedulerSource.includes('window.renderSubagentList()')
    && postStartupSchedulerSource.includes('window.renderLeftWsList()')
    && postStartupSchedulerSource.includes('requestIdleCallback')
    && !postStartupSchedulerSource.includes('loadFileTree')
    && !postStartupSchedulerSource.includes('loadFlows')
    && !postStartupSchedulerSource.includes('spawnTerminal')
    && !postStartupSchedulerSource.includes('ensureTerminalStarted')
    && !postStartupSchedulerSource.includes('ensureBrowserPanel'), 'post-startup scheduler contains only cancellable pure UI rendering and cannot create deferred runtimes or I/O');
  ok(uiHtml.includes('window.refreshModelSelect = function(options)')
    && uiHtml.includes('if (options.minimal === true)')
    && uiHtml.includes('window.refreshModelSelect(startupPrewarmRequired ? { minimal: true } : undefined)'), 'startup acknowledgement builds only the selected model option and defers the full provider catalogue');
  ok(startupCoverClassRemovalIndex >= 0
    && postStartupScheduleIndex > startupCoverClassRemovalIndex
    && uiHtml.includes("state._postStartupUiRendering.cancel")
    && uiHtml.includes("window.addEventListener('beforeunload'"), 'secondary UI rendering starts only after same-window acknowledgement and is cancelled on navigation');
  const languageUiStart = uiHtml.indexOf('function applyLanguageToUi()');
  const languageUiEnd = uiHtml.indexOf('function escAttr', languageUiStart);
  const languageUiSource = languageUiStart >= 0 && languageUiEnd > languageUiStart
    ? uiHtml.slice(languageUiStart, languageUiEnd)
    : '';
  const rightTabStart = uiHtml.indexOf('window.switchRightTab = function(tab)');
  const rightTabEnd = uiHtml.indexOf('window.ensureEditorPanel', rightTabStart);
  const rightTabSource = rightTabStart >= 0 && rightTabEnd > rightTabStart
    ? uiHtml.slice(rightTabStart, rightTabEnd)
    : '';
  ok(!languageUiSource.includes('window.loadFileTree(')
    && rightTabSource.includes("if (tab === 'file-tree') window.loadFileTree()")
    && uiHtml.includes("if (opening && state.rightTab === 'file-tree') window.loadFileTree()"), 'file tree does no startup/language-change I/O and loads on explicit tab or sidebar activation');
  const flowEditorStart = uiHtml.indexOf('window.showFlowEditor = function()');
  const flowEditorEnd = uiHtml.indexOf('function renderFlowItem', flowEditorStart);
  const flowEditorSource = flowEditorStart >= 0 && flowEditorEnd > flowEditorStart
    ? uiHtml.slice(flowEditorStart, flowEditorEnd)
    : '';
  ok(uiHtml.includes('window.ensureFlowsLoaded = function(options)')
    && uiHtml.includes('if (state._flowLoadPromise) return state._flowLoadPromise')
    && flowEditorSource.includes('return window.ensureFlowsLoaded().then')
    && uiHtml.includes('await window.ensureFlowsLoaded()'), 'Flow catalog is single-flight and loads only when the editor, Flow mode, or Flow-dependent settings are opened');
  const terminalSendStart = uiHtml.indexOf('window.terminalSend = function()');
  const terminalSendEnd = uiHtml.indexOf('window.clearTerminal = function()', terminalSendStart);
  const terminalSendSource = terminalSendStart >= 0 && terminalSendEnd > terminalSendStart
    ? uiHtml.slice(terminalSendStart, terminalSendEnd)
    : '';
  ok(uiHtml.includes('window.ensureTerminalStarted = function()')
    && uiHtml.includes('if (state._terminalStartPromise) return state._terminalStartPromise')
    && uiHtml.includes('onfocus="window.ensureTerminalStarted&&window.ensureTerminalStarted()"')
    && uiHtml.includes('if (!state.bottomCollapsed && window.ensureTerminalStarted) window.ensureTerminalStarted()')
    && uiHtml.includes('sourceInput.value && !targetInput.value')
    && uiHtml.includes("if (inp) inp.focus();\n  }, 0);")
    && terminalSendSource.includes('return window.ensureTerminalStarted().then')
    && terminalSendSource.includes("api.terminalWrite(resp.sessionId, cmd + '\\r\\n')"), 'PTY starts only on terminal demand and a command entered before connection is forwarded exactly after the lazy session resolves');
  const bottomClosedCssStart = uiHtml.indexOf('#bottom {');
  const bottomOpenCssStart = uiHtml.indexOf('#bottom.open {', bottomClosedCssStart);
  const bottomHeaderCssStart = uiHtml.indexOf('#bottom-header {', bottomOpenCssStart);
  const bottomClosedCss = uiHtml.slice(bottomClosedCssStart, bottomOpenCssStart);
  const bottomOpenCss = uiHtml.slice(bottomOpenCssStart, bottomHeaderCssStart);
  const bottomHeaderCss = uiHtml.slice(bottomHeaderCssStart, uiHtml.indexOf('}', bottomHeaderCssStart) + 1);
  ok(bottomClosedCss.includes('height: 34px;')
    && bottomOpenCss.includes('height: var(--bottom-height);')
    && bottomHeaderCss.includes('min-height: 33px;'), 'collapsed terminal retains its header and reopen control while only the terminal body disappears');
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
    && deferredHydrationKeys.every(key => !mainHydrationContract.includes(`'${key}'`))
    && readyHandlerSource.includes('payload?.hydrated?.[key] !== true')
    && readyHandlerSource.includes('waiter.reject(new Error(hydrationError))')
    && readyHandlerSource.includes('accepted: false'), 'main process rejects renderer readiness unless every required hydration field is explicitly true');
  const rendererReadyPayloadStart = uiHtml.indexOf('var readyAck = await api.startupUiReady({');
  const rendererReadyPayloadEnd = uiHtml.indexOf('});', rendererReadyPayloadStart);
  const rendererReadyPayload = rendererReadyPayloadStart >= 0 && rendererReadyPayloadEnd > rendererReadyPayloadStart
    ? uiHtml.slice(rendererReadyPayloadStart, rendererReadyPayloadEnd)
    : '';
  ok(requiredHydrationKeys.every(key => rendererReadyPayload.includes(`${key}: true`))
    && deferredHydrationKeys.every(key => !rendererReadyPayload.includes(`${key}: true`)), 'renderer readiness payload explicitly attests only state and first render');
  ok(packagedStartupSmoke.includes('hydration: {')
    && requiredHydrationKeys.every(key => packagedStartupSmoke.includes(`${key}:`))
    && packagedStartupSmoke.includes('missingHydration'), 'packaged startup smoke verifies the minimal required hydration outcomes after promotion');
  const coreBarrierStart = mainTs.indexOf('const coreReportPromise = runStartupPrewarmBarrier([');
  const coreBarrierEnd = mainTs.indexOf('], progress => sendStartupStatus({', coreBarrierStart);
  const coreBarrierSource = coreBarrierStart >= 0 && coreBarrierEnd > coreBarrierStart
    ? mainTs.slice(coreBarrierStart, coreBarrierEnd)
    : '';
  ok(coreBarrierSource.includes("id: 'core-services'")
    && coreBarrierSource.includes("id: 'conversation-state'")
    && coreBarrierSource.includes('ensureConversationSnapshot')
    && !coreBarrierSource.includes('ensureWslConversationPool')
    && !coreBarrierSource.includes('ensureElectronUtilityPool')
    && !coreBarrierSource.includes('.snapshot(')
    && !coreBarrierSource.includes("id: 'wsl-detection'")
    && !coreBarrierSource.includes("id: 'sidecar'")
    && !coreBarrierSource.includes("id: 'update-check'"), 'startup critical barrier contains only core services and the current local conversation state, never a utility worker');
  const promotionIndex = mainTs.indexOf('promoteStartupUi(startupUiWindow)');
  const deferredScheduleIndex = mainTs.indexOf('scheduleDeferredDesktopStartup(startupUiWindow)', promotionIndex);
  ok(promotionIndex >= 0 && deferredScheduleIndex > promotionIndex
    && mainTs.includes('scheduleDeferredStartupTasks([')
    && mainTs.includes("id: 'conversation-runtime-prewarm'")
    && mainTs.includes("recordStartup('runtime-prewarm-ready')")
    && mainTs.includes("id: 'wsl-detection'")
    && mainTs.includes("id: 'sidecar'")
    && mainTs.includes('delayMs: 60_000')
    && mainTs.includes("id: 'update-check'"), 'conversation worker, WSL discovery, sidecar, and update work are warning-only deferred tasks scheduled after UI promotion');
  const startupAttemptStart = mainTs.indexOf('const runStartupAttempt =');
  const startupAttemptEnd = mainTs.indexOf("ipcMain.handle('startup:retry'", startupAttemptStart);
  const startupAttemptSource = startupAttemptStart >= 0 && startupAttemptEnd > startupAttemptStart
    ? mainTs.slice(startupAttemptStart, startupAttemptEnd)
    : '';
  ok(startupAttemptSource.includes('startupAgentReady = ensureStartupAgent()')
    && startupAttemptSource.includes('const attemptAgentReadyBarrier = startupAgentReadyBarrierFor(attemptId)')
    && startupAttemptSource.includes('attemptAgentReadyBarrier.resolve()')
    && startupAttemptSource.includes('attemptAgentReadyBarrier.reject(')
    && startupAttemptSource.includes('await Promise.all([startupShellReady, startupAgentReady])')
    && mainTs.includes('STARTUP_SHELL_MIN_VISIBLE_MS = 120')
    && startupAttemptSource.includes('remainingShellTime')
    && startupAttemptSource.includes('const attemptOneNavigationPreloaded = startupAttempt === 1')
    && startupAttemptSource.includes("if (!preloadedUiUrl || preloadedUiUrl === 'about:blank') return true")
    && startupAttemptSource.includes("url.searchParams.get('startupPrewarm') === '1'")
    && startupAttemptSource.includes("Number(url.searchParams.get('startupAttempt') || 0) === 1")
    && startupAttemptSource.includes('if (attemptOneNavigationPreloaded && preloadedUiWindow && preloadedUiWaiter?.attemptId !== 1)')
    && startupAttemptSource.includes("recordStartup('ui-readiness-waiter-restored-attempt-1')")
    && startupAttemptSource.includes('const reusesPreloadedUi = attemptOneNavigationPreloaded')
    && startupAttemptSource.includes('const attemptId = reusesPreloadedUi ? startupAttempt : ++startupAttempt')
    && startupAttemptSource.includes('const preloadedUiReadiness = reusesPreloadedUi ? preloadedUiWaiter!.promise : null')
    && startupAttemptSource.includes('ui-preload-reused-attempt-${attemptId}')
    && startupAttemptSource.includes('const coreReportPromise = runStartupPrewarmBarrier([')
    && startupAttemptSource.indexOf('await coreReportPromise') < startupAttemptSource.indexOf('loadDesktopWindowUi(startupUiWindow, attemptId)')
    && startupAttemptSource.includes('const startupWebContentsId = startupUiWindow.webContents.id')
    && startupAttemptSource.includes('rejectUiReadinessById(startupWebContentsId')
    && startupAttemptSource.includes('registerUiReadiness(startupUiWindow, attemptId)')
    && startupAttemptSource.includes('loadDesktopWindowUi(startupUiWindow, attemptId)')
    && startupAttemptSource.includes('if (!reusesPreloadedUi)')
    && startupAttemptSource.includes('const uiReportPromise = runStartupPrewarmBarrier([')
    && startupAttemptSource.includes('uiReadiness = waitForUiReadiness(startupUiWindow)')
    && !startupAttemptSource.includes('createDesktopWindow!(true, false, attemptId)'), 'attempt one reuses the pre-registered index readiness promise; retries alone navigate the same webContents after core state settles');
  ok(startupAttemptSource.includes('loadStartupShell(failedWindow)')
    && startupAttemptSource.includes('startupShellReady.then(() => sendStartupStatus(failurePayload))'), 'failed same-window UI navigation clears its waiter, restores the splash, and preserves retry feedback');
  const desktopUiLoadReferences = mainTs.match(/loadDesktopWindowUi\(/g) || [];
  ok(desktopUiLoadReferences.length === 2
    && !mainTs.includes('if (agent && mainWindow && !mainWindow.isDestroyed()) loadDesktopWindowUi(mainWindow)'),
  'desktop UI loading has one window-creation call and one retry call, with no legacy unconditional navigation after IPC registration');
  ok(mainTs.includes("startupShellReady.catch(error =>")
    && mainTs.includes("recordStartup('startup-shell-load-warning')"), 'startup shell navigation rejection is absorbed when promotion destroys the splash');
  const backendBarrierStart = mainTs.indexOf("ipcMain.handle('startup:waitForBackend'");
  const backendBarrierEnd = mainTs.indexOf('createDesktopWindow =', backendBarrierStart);
  const backendBarrierSource = backendBarrierStart >= 0 && backendBarrierEnd > backendBarrierStart
    ? mainTs.slice(backendBarrierStart, backendBarrierEnd)
    : '';
  const firstWindowCreateIndex = mainTs.indexOf('startupWindow = createDesktopWindow(true, true, startupAttempt)');
  ok(backendBarrierStart >= 0
    && backendBarrierStart < firstWindowCreateIndex
    && backendBarrierSource.includes('await Promise.all([')
    && backendBarrierSource.includes('startupAgentReadyBarrierFor(waiter.attemptId).promise')
    && backendBarrierSource.includes('startupBackendReady'), 'backend barrier is registered before the first window and waits for both attempt-scoped Agent readiness and IPC registration');
  const getStateStart = mainTs.indexOf("ipcMain.handle('agent:getState'");
  const getStateEnd = mainTs.indexOf("ipcMain.handle('agent:getConversationPlan'", getStateStart);
  const getStateSource = getStateStart >= 0 && getStateEnd > getStateStart
    ? mainTs.slice(getStateStart, getStateEnd)
    : '';
  ok(getStateSource.includes('const wslDistros = availableWslDistros()')
    && !getStateSource.includes('await availableWslDistros()'), 'initial renderer state consumes only cached WSL discovery and never blocks first interaction on wsl.exe');
  const backendReadyResolveIndex = mainTs.indexOf('resolveStartupBackendReady()', getStateStart);
  ok(backendReadyResolveIndex > getStateStart
    && backendReadyResolveIndex < getStateEnd, 'backend barrier resolves only after the Agent state handler has been registered');
  ok(getStateSource.includes('isStartupPrewarmSender(event)')
    && getStateSource.includes('if (startupPrewarmRequest && !agent && startupAgentReady) await startupAgentReady')
    && getStateSource.indexOf('await startupAgentReady') < getStateSource.indexOf('if (!agent) return {}')
    && getStateSource.includes('localConversationSnapshotForStartup(target)')
    && getStateSource.includes('startupPrewarmRequest')
    && getStateSource.indexOf('localConversationSnapshotForStartup(target)') < getStateSource.indexOf('ensureWslConversationPool()!.snapshot(target)')
    && uiHtml.includes('api.getState(startupPrewarmRequired ? undefined : activeConversationId())'), 'covered startup UI waits for the attempt Agent promise, then hydrates from its local snapshot without starting a runtime worker');
  ok(mainTs.indexOf('promoteStartupUi') < mainTs.indexOf('showStartupUpdatePrompt'), 'available-update prompt is scheduled only after the same-window main UI promotion path exists');
  const ensureBrowserStart = mainTs.indexOf('async function ensureBrowserWebContents');
  const ensureBrowserEnd = mainTs.indexOf('function ensureElectronBrowserUseHost', ensureBrowserStart);
  const ensureBrowserSource = ensureBrowserStart >= 0 && ensureBrowserEnd > ensureBrowserStart
    ? mainTs.slice(ensureBrowserStart, ensureBrowserEnd)
    : '';
  ok(ensureBrowserSource.includes("host.send('browser:ensureGuest')")
    && ensureBrowserSource.includes('waitForRegisteredBrowserGuest')
    && ensureBrowserSource.includes("registered.hostWebContents?.send('browser:ensureGuest')")
    && !ensureBrowserSource.includes('new BrowserWindow'), 'cold Browser-Use requests the registered built-in guest with a bounded wait and has no invisible BrowserWindow fallback');
  const coldBrowserUseIndex = packagedDev009Smoke.indexOf("action_id: 'dev009-cold-navigate'");
  const firstVisibleBrowserIndex = packagedDev009Smoke.indexOf("window.switchRightTab('browser')", coldBrowserUseIndex);
  ok(coldBrowserUseIndex >= 0
    && firstVisibleBrowserIndex > coldBrowserUseIndex
    && packagedDev009Smoke.includes('cold Browser-Use page survives first visible Browser activation'), 'packaged acceptance invokes Browser-Use before the Browser tab is ever visible and verifies the same guest survives activation');
  ok(mainTs.includes('const webContentsId = win.webContents.id')
    && mainTs.includes('rejectUiReadinessById(Number(fileRouterOwnerId)')
    && mainTs.includes('if (win.isDestroyed()) return;'), 'destroyed startup windows settle readiness by captured webContents id without dereferencing a destroyed Electron object');
  const promotionFunctionStart = mainTs.indexOf('const promoteStartupUi =');
  const promotionFunctionEnd = mainTs.indexOf('const showStartupUpdatePrompt', promotionFunctionStart);
  const promotionFunctionSource = promotionFunctionStart >= 0 && promotionFunctionEnd > promotionFunctionStart
    ? mainTs.slice(promotionFunctionStart, promotionFunctionEnd)
    : '';
  ok(promotionFunctionSource.includes('mainWindow = win')
    && promotionFunctionSource.includes('startupWindow = null')
    && !promotionFunctionSource.includes('.destroy()')
    && !promotionFunctionSource.includes('.hide()'), 'promotion marks and focuses the same BrowserWindow without hiding, destroying, or swapping a second window');

  const scriptsDir = path.join(process.cwd(), 'scripts');
  const cdpReadyHelper = fs.readFileSync(path.join(scriptsDir, 'cdp-main-ui-ready.js'), 'utf8');
  ok(cdpReadyHelper.includes("document.visibilityState === 'visible'")
    && cdpReadyHelper.includes("document.readyState === 'complete'")
    && cdpReadyHelper.includes('!!window.api')
    && cdpReadyHelper.includes("const prompt = document.querySelector('#prompt')")
    && cdpReadyHelper.includes('!!prompt')
    && cdpReadyHelper.includes('!prompt.disabled')
    && cdpReadyHelper.includes('!prompt.readOnly'), 'shared CDP gate waits for a promoted, hydrated, visible, writable main renderer');
  const cdpScripts = fs.readdirSync(scriptsDir)
    .filter(name => name.endsWith('.cjs'))
    .map(name => ({ name, text: fs.readFileSync(path.join(scriptsDir, name), 'utf8') }))
    .filter(entry => entry.text.includes('/json/list'));
  ok(cdpScripts.length >= 38, 'startup contract audits every current CDP release script');
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
