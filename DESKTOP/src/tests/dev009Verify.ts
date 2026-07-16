import * as fs from 'fs';
import * as path from 'path';

type Assertion = { ok: boolean; label: string };

function source(file: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', file), 'utf-8');
}

function hasAll(value: string, fragments: string[]): boolean {
  return fragments.every(fragment => value.includes(fragment));
}

function check(ok: boolean, label: string, results: Assertion[]): void {
  results.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
}

export function verifyDev009SourceContracts(): Assertion[] {
  const results: Assertion[] = [];
  const types = source('core/types.ts');
  const kernel = source('core/conversationKernel.ts');
  const agent = source('core/agent.ts');
  const runner = source('core/agentKernelRunner.ts');
  const main = source('main.ts');
  const preload = source('preload.ts');
  const ui = source('ui/index.html');
  const router = source('core/workspaceFileRouter.ts');
  const workspace = source('core/workspace.ts');
  const pdfServer = source('core/pdfPreviewServer.ts');
  const browserUse = source('core/browserUse.ts');
  const browserUseAdapter = source('core/browserUsePageAdapter.ts');
  const browserUseHost = source('core/electronBrowserUseHost.ts');
  const utilityProtocol = source('core/utilityAgentProtocol.ts');
  const utilityBridge = source('core/utilityHostToolBridge.ts');
  const utilityRouter = source('core/utilityHostToolRouter.ts');
  const wslBridge = source('core/wslHostToolBridge.ts');
  const toolExecutor = source('tools/index.ts');
  const subagents = source('core/subagent.ts');
  const browserControl = source('core/browserControl.ts');
  const browserUsePageAdapter = source('core/browserUsePageAdapter.ts');
  const electronUtilityClient = source('core/electronUtilityAgentClient.ts');
  const electronUtilityPool = source('core/electronUtilityRuntimePool.ts');
  const runtimeShutdown = source('core/runtimeShutdown.ts');
  const wslClient = source('core/wslAgentClient.ts');
  const wslPool = source('core/wslAgentRuntimePool.ts');
  const packageJson = fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8');
  const packageConfig = JSON.parse(packageJson) as {
    scripts?: Record<string, string>;
    build?: { asarUnpack?: string[] };
  };
  const windowsProcessTreeHelper = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'windows-process-tree-helper.cs'), 'utf-8');
  const windowsProcessTreeBuild = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'build-windows-process-tree-helper.cjs'), 'utf-8');
  const typeboxBuild = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'build-typebox-compile.cjs'), 'utf-8');
  const distPortable = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'dist-portable.cjs'), 'utf-8');
  const dev009Smoke = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'release-dev009-features-smoke.cjs'), 'utf-8');

  check(hasAll(types, [
    'interface ConversationTarget',
    'workspaceId',
    'conversationId',
    'interface ConversationInputEnvelope',
    'clientMessageId',
    'interface GuideReceipt',
    'interface ConversationWorkRun',
    'runId',
    'sequence',
  ]), 'dev009 contracts: composite target, Guide receipt, work run, run and event sequence are typed', results);

  check(hasAll(kernel, [
    'enqueueGuide',
    'checkpoint',
    'setWorkRunExpanded',
    'force',
    'runtimeKey',
  ]), 'dev009 kernel: Guide, checkpoint, persisted folding, and target-only force-stop paths exist', results);

  check(hasAll(agent, [
    'version: 3',
    'workRuns',
    'setConversationWorkRunExpanded',
  ]) && !/reasoningContent\s*:\s*input\./.test(agent), 'dev009 persistence: state v3 stores public work runs without hidden reasoning', results);

  check(hasAll(preload, [
    'enqueueGuide',
    'stopConversation',
    'setWorkRunExpanded',
    'checkpointConversation',
  ]), 'dev009 preload: target-bound Guide, stop, checkpoint, and fold APIs are exposed', results);

  check(hasAll(main, [
    "ipcMain.handle('agent:enqueueGuide'",
    "ipcMain.handle('agent:stopConversation'",
    "ipcMain.handle('agent:setWorkRunExpanded'",
    'workspaceSwitchGeneration',
  ]) && !/agent\.selectWorkspace\(id\);\s*await resetAgentRuntimes\(\)/m.test(main), 'dev009 main: target-bound IPC and non-resetting latest-wins workspace switch are wired', results);

  check(hasAll(ui, [
    'function runtimeKeyFor',
    'function formatWorkDuration',
    'renderConversationWorkRuns',
    'toggleConversationWorkRun',
    'enqueueGuide',
    'force_restarting',
    'showUiNotice',
    'clearUiNotice',
    'previousExpanded',
  ]) && hasAll(electronUtilityPool, ['setWorkRunExpanded', 'this.acquire(normalizeConversationTarget(target))'])
    && hasAll(wslPool, ['setWorkRunExpanded', 'this.acquire(normalized)'])
    && !ui.includes('Date.now() - 5000'),
  'dev009 UI: composite caches, persistent duration/folding after worker eviction, reliable Guide, two-stage stop, and notices are present', results);

  check(hasAll(ui, [
    'guideMessagesByTarget',
    'function recordGuideUiMessage',
    'function renderPendingGuideMessages',
    'function syncGuideMessagesFromWorkRuns',
    'data-client-message-id',
    "guideStatus: clientMessageId ? 'applied' : ''",
    'renderPendingGuideMessages(renderTarget, persistedGuideIds)',
  ]) && !ui.includes("optimisticGuide.setAttribute('data-guide-status'")
    && hasAll(dev009Smoke, [
      "window.sendMessage('guide')",
      'Guide disappeared after snapshot redraw',
      'Applied Guide was duplicated after snapshot reconciliation',
    ]),
  'dev009 Guide UI: optimistic receipts survive snapshot redraw and reconcile exactly once with the applied persisted message', results);

  check(hasAll(ui, [
    'class="conv-pin-btn',
    "iconOnly('pin', conv.pinned ? t('conversation.unpin') : t('conversation.pin'))",
    'class="conv-archive-btn"',
    "iconOnly('archive', t('conversation.archive'))",
  ]) && !ui.includes("title=\"' + escAttr(t('conversation.archive')) + '\">' + esc(t('conversation.archive')) + '</button>'"),
  'dev009 conversation actions: pin and archive retain compact Lucide icons instead of overflowing text', results);

  check(hasAll(ui, [
    'view._newmarkPendingUrl = url',
    "view.addEventListener('dom-ready'",
    "var pendingUrl = String(view._newmarkPendingUrl || '')",
    'view.loadURL(pendingUrl)',
  ]), 'dev009 browser UI: the latest pre-dom-ready navigation is replayed exactly once after guest attachment', results);

  check(hasAll(ui, [
    "if (!view.isConnected || guestId <= 0) throw new Error('Built-in Browser guest detached before registration settled')",
    "view.dataset.newmarkBrowserReadyUrl = readyUrl || 'about:blank'",
  ]) && !ui.includes('Built-in Browser guest did not settle at about:blank')
    && hasAll(dev009Smoke, [
      'window.ensureBrowserPanel({ activate: false }).then(view =>',
      'Cold Browser guest readiness was poisoned by immediate navigation',
    ]),
  'dev009 browser UI: accepted guest registration survives immediate navigation away from about:blank', results);

  check(hasAll(ui, [
    'The target runtime supervisor owns the checkpoint + cooperative-stop',
    'latestAfterStop',
    'latestAfterError',
  ]) && !ui.includes('if (!force && api.checkpointConversation) await api.checkpointConversation'),
  'dev009 stop UI: first stop reaches the supervisor directly and stale cooperative results cannot overwrite force restart', results);

  const forceStopImplementation = (electronUtilityClient.match(/async forceStop\(\): Promise<void>[\s\S]*?\n  async forceRestart\(\): Promise<void>/) || [''])[0];
  const snapshotTimeoutMatch = electronUtilityClient.match(/const WINDOWS_TREE_SNAPSHOT_TIMEOUT_MS\s*=\s*([\d_]+);/);
  const snapshotTimeoutMs = Number(String(snapshotTimeoutMatch?.[1] || '0').replace(/_/g, ''));
  check(hasAll(`${electronUtilityClient}\n${windowsProcessTreeHelper}`, [
    'snapshotWindowsProcessTree',
    'creationIdentity',
    'PID reuse detected',
    'runWindowsIdentityTermination(entries',
    'stable empty rescans',
    'anchorPids?: readonly number[]',
    'anchorCreationIdentities: ReadonlyMap<number, string>',
    "encodedAnchors.Split(new[] { ';' }",
    'known.entries.map(entry => entry.pid)',
    'rootHasBoundIdentity',
    'ERROR_INVALID_PARAMETER = 87',
    'parentOnlyWitnesses',
    'if (creationIdentity == PROCESS_ABSENT) continue',
    'throw new System.ComponentModel.Win32Exception(error)',
    'childCreation >= expectedCreation && childCreation < actualCreation',
    'WINDOWS_TREE_FORCE_STOP_DEADLINE_MS = 29_000',
    'const primaryKill = options.primaryKill || null',
    'default cleanup is identity-handle-bound from the first termination',
    'restartQuarantine',
    'childRootIdentity',
    'private startPromise: Promise<void> | null = null',
    'private forceStopPromise: Promise<void> | null = null',
    'private readyGeneration = 0',
    'private invalidGenerations = new Set<number>()',
    'generation: this.childGeneration',
    'rootCreationIdentity:',
    'throwIfRestartQuarantined()',
    'await this.requestTargetSnapshot()',
    'killChildHandleAndAwaitExit',
    'invalidateGeneration',
    'activeWindowsProcessHelperPidsForTest',
    'activeWindowsProcessHelpers = new Map',
    'windowsProcessHelperSequence',
    'ownerKey: string',
    'drainWindowsProcessHelpers(2_000, helperOwnerKey)',
    'drainWindowsProcessHelpers',
    'shutdownWindowsProcessHelpers',
    'failAfterDrain(new Error(\'Windows process-tree snapshot exceeded its output limit\'))',
    "stdout = '';",
    'WINDOWS_HELPER_CLOSE_GRACE_MS',
  ]) && hasAll(electronUtilityClient, [
    'windowsProcessTreeHelperLoadScript',
    'Add-Type -Path $helperPath',
    "'app.asar.unpacked', 'dist', 'windows-process-tree-helper.dll'",
    'Packaged Windows process-tree helper is missing',
    "kind: 'runtime_compile'",
  ]) && !electronUtilityClient.includes("spawn('taskkill.exe'")
    && snapshotTimeoutMs >= 10_000
    && forceStopImplementation.includes('rootIdentity.creationIdentity')
    && forceStopImplementation.includes('await terminateWindowsUtilityProcessTree(')
    && electronUtilityClient.includes('async forceRestart(): Promise<void> {\n    this.throwIfRestartQuarantined();\n    await this.forceStop();')
    && electronUtilityClient.includes('this.enterRestartQuarantine(failure);')
    && forceStopImplementation.includes('killing through it is identity-safe')
    && forceStopImplementation.includes('killChildHandleAndAwaitExit(child, 1_000)')
    && forceStopImplementation.indexOf('await terminateWindowsUtilityProcessTree(') < forceStopImplementation.indexOf('killChildHandleAndAwaitExit(child, 1_000)'),
  'dev009 utility force-stop: Windows uses creation identity, bounded quiescence, sticky quarantine, and transactional restart snapshot validation', results);

  const embeddedWindowsHelpers = [...electronUtilityClient.matchAll(/\$source = @'\r?\n([\s\S]*?)\r?\n'@/g)]
    .map(match => match[1])
    .join('\n');
  const normalizeWindowsHelperSource = (value: string): string => value
    .replace(/^using\s+[^;]+;\s*$/gm, '')
    .replace(/\s+/g, '');
  check(
    normalizeWindowsHelperSource(embeddedWindowsHelpers) === normalizeWindowsHelperSource(windowsProcessTreeHelper),
    'dev009 utility force-stop: the build-time helper preserves the exact controlled runtime-fallback C# semantics',
    results,
  );

  check(hasAll(electronUtilityPool, [
    'private quarantined = new Map<string, string>()',
    'this.rememberClientQuarantine(entry)',
    'if (entry.client.status().connected) throw error',
    'this.entries.delete(runtimeKey)',
    'A failed stop can leave a live child behind',
    'Electron utility runtime is quarantined until the app backend is restarted',
  ]),
  'dev009 utility pool: stop failure retains the live client entry while quarantine survives entry eviction for the pool lifetime', results);

  check(hasAll(electronUtilityPool, [
    'forceCleanupQuarantinedEntry',
    'await entry.client.forceStop()',
    'restarted: false',
    'await drainWindowsProcessHelpers(2_000)',
  ]) && hasAll(main, [
    'runRuntimeShutdownBarrier({',
    'shutdownHelpers: async () => await shutdownWindowsProcessHelpers(2_000)',
  ]) && hasAll(runtimeShutdown, [
    'await Promise.allSettled(operations)',
    'await options.shutdownHelpers()',
  ]) && runtimeShutdown.indexOf('await Promise.allSettled(operations)')
      < runtimeShutdown.indexOf('await options.shutdownHelpers()'),
  'dev009 shutdown safety: quarantined handles use cleanup-only retry and app exit drains retained Windows helpers after runtime settlement', results);

  check(hasAll(agent, ['sanitizeAssistantStreamingOutput', 'hidden[_-]?reasoning'])
    && hasAll(runner, ['sanitizeAssistantStreamingOutput(visible)', 'historyMessage.content = text']),
  'dev009 privacy: streamed whitespace is preserved while completed chat/history and structured tool args exclude hidden reasoning', results);

  const toolEventRenderer = (ui.match(/function renderToolEventContent[\s\S]*?\n}\n/) || [''])[0];
  check(hasAll(agent, [
    'sanitizePublicToolName',
    'publicToolEventContent',
    '? this.publicToolEventContent(type, toolName!)',
  ]) && hasAll(ui, [
    'function publicWorkEventForUi',
    'function publicToolNameForUi',
    'function flushPublicText',
    "type: terminalInterrupted ? 'partial_text' : 'public_text'",
    "if (type === 'tool_call') return publicToolNameForUi(event.toolName)",
  ]) && !runner.includes('agent.visibleToolArgs(args)')
    && !toolEventRenderer.includes('call.args')
    && !toolEventRenderer.includes('call.result')
    && !toolEventRenderer.includes('tool-event-content'),
  'dev009 work-run privacy: public tool activity exposes names and status only while natural-language text streaming remains enabled', results);

  check(hasAll(ui, [
    'currentWorkspaceId',
    'function workspaceIdentity',
    'function findWorkspaceByIdentity',
    'state.currentWorkspaceId = workspaceIdentity',
    'api.selectWorkspace(reference)',
  ]) && hasAll(workspace, [
    'stableWorkspaceId',
    'workspace.id === clean',
    'byName.length === 1',
  ]), 'dev009 workspace identity: UI/runtime caches and IPC use stable ids while ambiguous legacy names fail closed', results);

  check(hasAll(ui, [
    'resetEditorSurface',
    'requestEditorTransition',
    'editorOpenGeneration',
    'save',
    'discard',
    'cancel',
  ]), 'dev009 editor: unified reset, transition guard, generation ordering, and dirty choices are present', results);

  check(hasAll(router, [
    'PdfPreviewCapability',
    'resolvePdfCapability',
  ]) && hasAll(pdfServer, [
    'class PdfPreviewServer',
    '127.0.0.1',
    'Content-Range',
    'Accept-Ranges',
    'X-Content-Type-Options',
  ]), 'dev009 PDF: loopback capability transport exposes range and security handling', results);

  check(hasAll(browserUse, [
    'class BrowserUseEngine',
    'observationId',
    'pageGeneration',
    'clearRuntime',
    'stale_generation',
    'unsafe_navigation',
  ]) && hasAll(browserUseAdapter, [
    'class NativeBrowserUsePageAdapter',
    'evaluateFixed',
    'sameElement',
  ]), 'dev009 Browser-Use: native observe/ref/action engine uses scoped opaque capabilities and stale-page guards', results);

  check(hasAll(browserUseHost, [
    'executeJavaScriptInIsolatedWorld',
    'setWindowOpenHandler',
    'will-download',
    'will-navigate',
  ]) && !browserUseHost.includes('executeJavaScript(script'), 'dev009 Browser-Use: Electron host uses an isolated world and blocks popup/download/unsafe navigation side effects', results);

  check(hasAll(toolExecutor, [
    "case 'browser_use'",
    "requestWindowsHostTool('browser_use'",
    "requestUtilityHostTool('browser_use'",
  ]) && hasAll(utilityBridge, ['runtimeKey', 'targetProvider']) && hasAll(wslBridge, ['WslHostToolRequest', 'context']) && toolExecutor.includes('runtimeKey:'), 'dev009 Browser-Use: Native utility and WSL workers delegate target-bound actions to the main-process host', results);

  check(hasAll(utilityRouter, [
    'isToolEnabled?(toolName: string): boolean',
    'options.isToolEnabled(nativeToolName)',
  ]) && main.includes('isToolEnabled: toolName => !!agent && isNativeToolEnabled(toolName, agent.config.nativeToolEnabled())'),
  'dev009 Browser-Use: main-process host RPC rechecks the live Native Tools setting', results);

  check(hasAll(agent, [
    'runAsyncWindowsBatch',
    'activeProcessAbortController',
    'if (processSignal?.aborted)',
    "this.status = 'idle'",
    'activePeerAgents.values()',
    'subagents.pauseScheduling()',
    'subagents.resumeScheduling()',
  ]) && hasAll(kernel, ['settleCooperativeStop', "finishConversationWorkRun(runId, 'interrupted')"])
    && hasAll(subagents, ['schedulingPaused', 'pauseScheduling()', 'resumeScheduling()', 'if (!this.executor || this.schedulingPaused) return']), 'dev009 cancellation: cooperative stop settles interrupted without a false error while durable queued peers remain paused until the next root run', results);

  check(hasAll(runner, [
    'handleImageGeneration(args, signal)',
    'handleFlowRun(args, signal)',
    'handleMemoryLabTool(name, args, signal)',
    'handleAutomationTool(name, args, signal)',
  ]) && hasAll(toolExecutor, ['BrowserControl.run(request, signal)', "requestWindowsHostTool('computer_use'", "requestUtilityHostTool('terminal_takeover'"]) && browserControl.includes('backend.run(normalized.request, signal)'), 'dev009 cancellation: ordinary and special tools share the run AbortSignal through native and host-RPC paths', results);

  check(hasAll(utilityProtocol, ["event: 'host_tool_cancel'", 'requestId: string'])
    && hasAll(utilityBridge, ['cancelSender?.(requestId)', 'if (signal?.aborted)'])
    && hasAll(wslBridge, ['host_tool_cancel', "writer?.({ event: 'host_tool_cancel'", 'if (signal?.aborted)'])
    && electronUtilityClient.includes('hostToolHandler?.cancelTarget?.(this.target.runtimeKey)')
    && wslClient.includes('hostToolHandler?.cancelTarget?.(this.runtimeTarget.runtimeKey)'), 'dev009 cancellation: abort and timeout cancel exact pending host calls and revoke target-owned desktop resources', results);

  check(!browserUsePageAdapter.includes('textContent')
    && !browserUsePageAdapter.includes('value: option.value')
    && hasAll(browserUse, ['isPublicBrowserUseAttribute', 'PUBLIC_BROWSER_USE_ARIA_ATTRIBUTES'])
    && hasAll(main, ["workEvent.type === 'done'", 'electronBrowserUseHost?.clear']), 'dev009 Browser-Use privacy: only rendered text, visible option labels, and allowlisted public attributes escape; terminal runs release browser bindings', results);

  check(packageJson.includes('release:dev009-features-smoke') && packageJson.includes('release:dev010-features-smoke'), 'dev009 release: compatibility gates remain registered in the current package', results);

  check(
    String(packageConfig.scripts?.build || '').includes('node scripts/build-windows-process-tree-helper.cjs')
      && String(packageConfig.scripts?.build || '').includes('node scripts/build-typebox-compile.cjs')
      && Array.isArray(packageConfig.build?.asarUnpack)
      && packageConfig.build.asarUnpack.includes('dist/windows-process-tree-helper.dll')
      && packageConfig.build.asarUnpack.includes('dist/typebox-compile.bundle.cjs')
      && hasAll(windowsProcessTreeBuild, [
        "'windows-process-tree-helper.cs'",
        "'windows-process-tree-helper.dll'",
        '-OutputAssembly $outputPath',
        "bytes[0] !== 0x4d || bytes[1] !== 0x5a",
      ])
      && distPortable.includes("windows-process-tree-helper.dll'), 'precompiled Windows process-tree helper'")
      && hasAll(typeboxBuild, [
        "require.resolve('typebox/compile')",
        "dist', 'typebox-compile.bundle.cjs'",
        "format: 'cjs'",
      ]),
    'packaged utility startup: the build emits and asarUnpack carries the precompiled Windows process-tree and synchronous TypeBox helpers',
    results,
  );

  return results;
}

if (require.main === module) {
  const results = verifyDev009SourceContracts();
  const failed = results.filter(result => !result.ok);
  console.log(`dev-0.0.9 source contract checks: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) process.exitCode = 1;
}
