/**
 * Newmark Agent �?Comprehensive Feature Verification Tests
 * Tests every function without requiring a real LLM API.
 * Run: npm run build && node dist/tests/verify.js
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Agent, AgentMode, StreamToken } from '../core/agent';
import { ConfigManager, defaultConfig, mergeProviderSecrets, sanitizeProvidersForState } from '../core/config';
import { ToolExecutor } from '../tools/index';
import { WorkspaceManager } from '../core/workspace';
import { SubagentManager } from '../core/subagent';
import { SkillsManager } from '../core/skills';
import { AutomationManager } from '../core/automation';
import { AutomationWakeScheduler } from '../core/automationWake';
import { FlowEngine, FlowWorkflow } from '../core/flow';
import { runFlow } from '../core/flow-runner';
import { LLMProvider } from '../llm/provider';
import { BrowserControl } from '../core/browserControl';
import { runCliCommand } from '../cli-commands';
import { providerNameFromUrl } from '../core/fuzzy';
import { discoverAgentPresets, discoverOpenCodeTools, discoverPluginManifests, discoverPluginMarketplaces, runOpenCodeTool } from '../core/compat';
import { MemoryLabManager } from '../core/memoryLab';
import { checkGitHubUpdate, currentAppVersion, installUpdate } from '../core/installUpdate';
import { ConversationKernel } from '../core/conversationKernel';
import { SshManager, SshRunner } from '../core/ssh';

const TEST_DIR = path.join(process.cwd(), 'test-tmp');
const PASS = '[PASS]';
const FAIL = '[FAIL]';
let passed = 0;
let failed = 0;

function assert(cond: boolean | undefined | null, name: string, detail?: string): void {
  if (cond) { passed++; console.log(`  ${PASS} ${name}`); }
  else { failed++; console.log(`  ${FAIL} ${name}${detail ? ': ' + detail : ''}`); }
}

class FakeProvider {
  public calls = 0;

  constructor(private responses: string[]) {}

  intelligenceConfig(): { temperature: number; maxTokens: number } {
    return { temperature: 0, maxTokens: 100 };
  }

  async *chatStreamWithTools(): AsyncGenerator<StreamToken> {
    const response = this.responses[Math.min(this.calls, this.responses.length - 1)] || '';
    this.calls++;
    yield { type: 'text', text: response };
  }

  async chat(): Promise<string> {
    const response = this.responses[Math.min(this.calls, this.responses.length - 1)] || '';
    this.calls++;
    return response;
  }
}

// ===== Setup test environment =====
function setup() {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'Work'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'Flow'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'archive'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'Memory Lab'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'PC_Hash.config'), 'test-pc|win32|x64');
  fs.writeFileSync(path.join(TEST_DIR, 'Work', 'Local.json'), '[]');
  fs.writeFileSync(path.join(TEST_DIR, 'Work', 'External.json'), '[]');
  fs.writeFileSync(path.join(TEST_DIR, 'test.txt'), 'Hello World\nLine 2\nLine 3\nFind me here\nEnd');
}

function cleanup() {
  if (!fs.existsSync(TEST_DIR)) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch {
      try {
        chmodTree(TEST_DIR);
      } catch {}
    }
  }
  if (process.platform !== 'win32') {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
      return;
    } catch (e) {
      console.warn(`  [WARN] cleanup: could not remove ${TEST_DIR}: ${e}`);
      return;
    }
  }
  const ps = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$p = ${JSON.stringify(TEST_DIR)}; if (Test-Path -LiteralPath $p) { Get-ChildItem -LiteralPath $p -Recurse -Force | ForEach-Object { try { $_.Attributes = 'Normal' } catch {} }; Remove-Item -LiteralPath $p -Recurse -Force; Write-Output 'TEST_TMP_CLEANUP_OK' } else { Write-Output 'TEST_TMP_ALREADY_GONE' }`,
  ], { encoding: 'utf8', windowsHide: true });
  if (ps.status !== 0 || fs.existsSync(TEST_DIR)) {
    console.warn(`  [WARN] cleanup: could not remove ${TEST_DIR}: ${(ps.stderr || ps.stdout || '').trim()}`);
  }
}

function chmodTree(target: string) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  fs.chmodSync(target, 0o666);
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(target)) {
    chmodTree(path.join(target, entry));
  }
}

// ===== Main test suite =====
async function main() {
  console.log('\n======================================');
  console.log('   Newmark Agent - Feature Verify');
  console.log('======================================\n');

  setup();

  // ---- 0. UI HTML Regression Tests ----
  console.log('\nUI HTML');
  const uiHtmlPath = path.join(process.cwd(), 'src', 'ui', 'index.html');
  assert(fs.existsSync(uiHtmlPath), 'ui html: index.html exists');
  const uiHtml = fs.readFileSync(uiHtmlPath, 'utf-8');
  const mainSource = fs.readFileSync(path.join(process.cwd(), 'src', 'main.ts'), 'utf-8');
  const preloadSource = fs.readFileSync(path.join(process.cwd(), 'src', 'preload.ts'), 'utf-8');
  const scriptMatch = uiHtml.match(/<script>([\s\S]*)<\/script>/);
  assert(!!scriptMatch, 'ui html: inline script exists');
  let scriptParses = false;
  try {
    if (scriptMatch) new Function(scriptMatch[1]);
    scriptParses = true;
  } catch (e) {
    scriptParses = false;
  }
  assert(scriptParses, 'ui html: inline script parses');
  assert(Buffer.from(uiHtml, 'utf8').toString('utf8') === uiHtml, 'ui html: UTF-8 source is readable');
  let parsedI18n: { en: Record<string, string>; zh: Record<string, string> } | null = null;
  try {
    const i18nMatch = uiHtml.match(/var NEWMARK_I18N = ([\s\S]*?\n};)/);
    if (i18nMatch) parsedI18n = new Function(`return (${i18nMatch[1].replace(/;\s*$/, '')});`)();
  } catch {
    parsedI18n = null;
  }
  assert(uiHtml.includes('var NEWMARK_I18N = {') && uiHtml.includes('中文') && uiHtml.includes('当前对话计划') && uiHtml.includes("'left.collapseSecondary': '折叠工作区面板'"), 'ui html: bilingual i18n dictionary present');
  const enI18nKeys = parsedI18n ? Object.keys(parsedI18n.en || {}).sort() : [];
  const zhI18nKeys = parsedI18n ? Object.keys(parsedI18n.zh || {}).sort() : [];
  assert(!!parsedI18n && enI18nKeys.length > 300 && enI18nKeys.join('\n') === zhI18nKeys.join('\n'), 'ui html: English and Chinese i18n dictionaries have identical keys');
  assert(!!parsedI18n && enI18nKeys.every(k => String(parsedI18n!.en[k] || '').trim()) && zhI18nKeys.every(k => String(parsedI18n!.zh[k] || '').trim()), 'ui html: bilingual i18n dictionary values are non-empty');
  assert(uiHtml.includes("'queue.next': '下一轮'") && uiHtml.includes("'model.noValidationModels': '没有可校验的模型。'") && uiHtml.includes("'terminal.notConnected': '终端未连接'"), 'ui html: dynamic UI labels have Chinese translations');
  assert(uiHtml.includes('window.setLanguage = function(value)') && uiHtml.includes("api.saveSetting('general', 'language', lang)") && uiHtml.includes("api.saveConfig({ language: lang })"), 'ui html: language switch persists to config');
  assert(uiHtml.includes('id="language-select"') && uiHtml.includes("state.language = normalizeLanguage(s.language || state.language)") && uiHtml.includes('applyLanguageToUi();'), 'ui html: language setting initializes and reapplies UI text');
  assert(uiHtml.includes("document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en')") && uiHtml.includes("if (els.prompt) els.prompt.setAttribute('placeholder', t('input.placeholder'))"), 'ui html: language switch updates document lang and prompt placeholder');
  assert(uiHtml.includes('function uiLocale()') && uiHtml.includes('toLocaleTimeString(uiLocale())') && uiHtml.includes('toLocaleDateString(uiLocale())'), 'ui html: date/time rendering follows active UI locale');
  assert(uiHtml.includes('function formatModelStatus(status)') && uiHtml.includes("if (raw === 'available') return t('model.available')") && uiHtml.includes("if (raw === 'unavailable' || raw === 'failed' || raw === 'error') return t('model.unavailable')"), 'ui html: model validation statuses are localized');
  assert(uiHtml.includes("title=\"' + escAttr(t('common.remove')) + '\"") && !uiHtml.includes("iconSvg('x', 'Remove model'"), 'ui html: model remove action uses localized title/icon label');
  assert(uiHtml.includes('function setTitleAndTrailingLabel(selector, label)') && uiHtml.includes('setTitleAndTrailingLabel(\'.secondary-top button[onclick="window.newConversation()"]\'') && uiHtml.includes('setTitleAndTrailingLabel(\'button.et-btn[onclick="window.closeEditor()"]\''), 'ui html: language switch updates secondary sidebar and editor labels');
  assert(uiHtml.includes('function rerenderActiveSubWindowForLanguage()') && uiHtml.includes("state.activeSubWindowView = { name: 'workspaceRequired' }") && uiHtml.includes("state.activeSubWindowView = { name: 'plugins'"), 'ui html: language switch rerenders active secondary windows');
  assert(uiHtml.includes('window.showMemoryLab = function()') && uiHtml.includes("state.activeSubWindowView = { name: 'memoryLab'") && uiHtml.includes("t('memoryLab.title')"), 'ui html: Memory Lab left toolbar entry and panel renderer exist');
  assert(uiHtml.includes('api.memoryLabRead') && uiHtml.includes('memoryLabReindex') && uiHtml.includes("lucide-sprite.svg#brain"), 'ui html: Memory Lab preload API and icon are wired');
  assert(uiHtml.includes('.memory-lab-graph') && uiHtml.includes("t('memoryLab.parents')") && uiHtml.includes("t('memoryLab.children')") && uiHtml.includes("t('memoryLab.rootTags')") && !uiHtml.includes('memoryLabConnectionSvg') && !uiHtml.includes('memory-lab-links'), 'ui html: Memory Lab renders centered parent-child tag graph without connector lines and shows root tags at top-level');
  assert(uiHtml.includes('memory-lab-search-input') && uiHtml.includes('window.updateMemoryLabSearch') && uiHtml.includes("t('memoryLab.search')"), 'ui html: Memory Lab exposes tag search and jump controls');
  assert(uiHtml.includes('memory-lab-view-menu') && uiHtml.includes('window.switchMemoryLabView = function(view)') && uiHtml.includes("t('memoryLab.overview')") && uiHtml.includes("t('memoryLab.detail')") && uiHtml.includes('memory-lab-overview-stage') && uiHtml.includes('window.buildMemoryLabOverviewGraph'), 'ui html: Memory Lab has switchable overview/detail views with overview graph renderer');
  assert(uiHtml.includes('animate-from-left') && uiHtml.includes('animate-from-right') && uiHtml.includes('@keyframes memory-lab-enter-left') && uiHtml.includes('memoryLabNavDirection'), 'ui html: Memory Lab tag navigation has smooth directional animation');
  assert(uiHtml.includes("window.openSubWin(t('model.addProvider')") && uiHtml.includes("window.openSubWin(t('model.addModel')") && uiHtml.includes("window.openSubWin(t('model.fuzzy')"), 'ui html: model secondary windows use i18n titles');
  assert(uiHtml.includes('window.setAutoSwitchMode') && uiHtml.includes("t('model.autoSwitchOff')") && uiHtml.includes("t('model.autoSwitchAll')") && uiHtml.includes("t('model.autoSwitchProvider')"), 'ui html: model settings expose off/full/provider Auto switch modes');
  assert(uiHtml.includes('window.setOpenAIApiMode') && uiHtml.includes("t('model.openAIApiMode')") && uiHtml.includes('value="chat_stream"') && uiHtml.includes('value="responses"'), 'ui html: model settings expose OpenAI-compatible Chat streaming and Responses API modes');
  assert(uiHtml.includes("if (state.autoSwitch === 'on') modelOpts += '<option value=\"auto\"") && uiHtml.includes("state.model === 'auto' && state.autoSwitch !== 'on'"), 'ui html: Auto model option is hidden and corrected when auto switching is off');
  assert(uiHtml.includes('class="context-token-wrap"') && uiHtml.indexOf('id="model-select"') < uiHtml.indexOf('id="context-token-ring"') && uiHtml.includes('id="context-token-ring"') && uiHtml.includes('window.renderContextWindow') && uiHtml.includes('width: 16px') && uiHtml.includes('radial-gradient(farthest-side, transparent 58%, #000 60%)') && !uiHtml.includes('context-token-ring-label'), 'ui html: context token ring renders as a small unlabeled donut beside model select');
  assert(uiHtml.includes("data-stab=\"updates\"") && uiHtml.includes('function renderUpdateSettings()') && uiHtml.includes('window.checkGithubUpdate') && uiHtml.includes('window.applyGithubUpdate') && uiHtml.includes("t('updates.note')"), 'ui html: settings expose GitHub release update check and apply controls');
  assert(uiHtml.includes("window.openSubWin(t('automation.newTitle')") && uiHtml.includes("window.openSubWin(t('flow.title')") && uiHtml.includes("window.openSubWin(t('plugins.title')") && uiHtml.includes("window.openSubWin(t('workspace.new')"), 'ui html: automation flow plugins workspace secondary windows use i18n titles');
  assert(uiHtml.includes("t('plugins.marketHelp')") && uiHtml.includes("t('plugins.search')") && uiHtml.includes("t('archive.workspaceEmpty')") && uiHtml.includes("t('status.noPendingOptions')"), 'ui html: secondary panels use i18n body labels');
  assert(uiHtml.includes("window.openSubWin(t('model.validationTitle')") && uiHtml.includes("window.openSubWin(t('archive.titlePrefix') + ': '") && uiHtml.includes("window.openSubWin(t('workspace.requiredTitle')") && uiHtml.includes("window.openSubWin(t('workspace.newConversation')"), 'ui html: legacy secondary windows use i18n titles');
  assert(uiHtml.includes("t('workspace.selectOrCreate')") && uiHtml.includes("t('conversation.archive')") && uiHtml.includes("t('flow.runningPlaceholder')") && uiHtml.includes("t('subagent.empty')") && uiHtml.includes("t('fileTree.unavailable')"), 'ui html: workspace gate, conversation, Flow, subagent, and file-tree labels use i18n');
  assert(uiHtml.includes("label.textContent = t('queue.title')") && uiHtml.includes("t('status.contextCompressed')") && uiHtml.includes("t('model.noValidationModels')") && uiHtml.includes("prompt(t('todo.addPrompt'))"), 'ui html: runtime dynamic text uses i18n helpers');
  assert(uiHtml.includes('id="input-stack"') && uiHtml.includes('id="queue-panel"') && uiHtml.includes('window.renderQueuePanel = function()') && uiHtml.includes('window.editQueueItem = function(idx, value)') && uiHtml.includes('window.dropQueueDrag = function(event, idx)') && uiHtml.includes('window.renderScrollBottomAffordance = renderScrollBottomAffordance') && uiHtml.includes('state.conversationPlan.items.push') && uiHtml.includes('state.todoCollapsed = false'), 'ui html: bottom input stack exposes editable queue, draggable ordering, scroll affordance, Goal bar, and Plan-backed checklist');
  assert(!uiHtml.includes("window.openSubWin('Model validation'") && !uiHtml.includes("window.openSubWin('Workspace required'") && !uiHtml.includes("window.openSubWin('New conversation'") && !uiHtml.includes("window.openSubWin('Plugin manager'"), 'ui html: dynamic window titles are not hard-coded English');
  assert(!/(^|[^<])\/(span|button|option|label|div)>/.test(uiHtml), 'ui html: no broken inline closing tags');
  assert(uiHtml.includes('New workspace'), 'ui html: new workspace label present');
  assert(uiHtml.includes('Flow editor'), 'ui html: flow editor label present');
  assert(uiHtml.includes('Ctrl+Enter uses the opposite mode.'), 'ui html: Ctrl+Enter setting text present');
  assert(uiHtml.includes("'model.fuzzy': 'Fuzzy inject model'") && uiHtml.includes("t('model.fuzzy')"), 'ui html: fuzzy injection label present through i18n');
  assert(uiHtml.includes('function redactSensitiveText(value)') && uiHtml.includes("replace(/sk-[A-Za-z0-9_\\-.]{8,}/g, 'sk-redacted')"), 'ui html: redacts API keys from visible messages');
  assert(uiHtml.includes("redactSensitiveText('[System] Fuzzy injection did not pass validation:") && uiHtml.includes("redactSensitiveText('[Error] Fuzzy injection failed:"), 'ui html: fuzzy injection messages are redacted');
  assert(uiHtml.includes('WORKFLOW TIMELINE') && uiHtml.includes('function renderChatMessages(messages)') && uiHtml.includes('function currentLang()') && uiHtml.includes('function conversationWorkUiState(conversationId)') && uiHtml.includes('agentWorkUiByConversation') && uiHtml.includes('function ensureActiveAssistantMsg(mode, model, conversationId)') && uiHtml.includes('function upsertToolEvent(event, resultText)') && uiHtml.includes('function toolBatchSummary(batch)') && uiHtml.includes('function renderToolBatch(batch)') && uiHtml.includes('function finishToolBatch(conversationId)') && uiHtml.includes('function findCompletedWorkflowMsg(conversationId, text)') && uiHtml.includes('function markFinalResponseMsg(conversationId, text, msg)') && uiHtml.includes('function findPendingFinalResponseMsg(conversationId, streamText)') && uiHtml.includes('function responseTextLooksLikeCompactPrefix(prefix, full)') && uiHtml.includes('conversationWorkUiState(conversationId).lastCompletedWorkflow') && uiHtml.includes('findCompletedWorkflowMsg(lockedConversationId, fullText)') && uiHtml.includes('markFinalResponseMsg(lockedConversationId, fullText, responseMsg)') && uiHtml.includes('正在编辑 ') && uiHtml.includes('已编辑 ') && uiHtml.includes('class="tool-event-details"') && !uiHtml.includes("addMsg('workflow running', 'Preparing request...'") && !uiHtml.includes('Agent is working'), 'ui html: conversation renders live assistant text and folded batched tool details without workflow placeholders or duplicate final echoes');
  assert(!uiHtml.includes('state._activeWorkflowMsg') && !uiHtml.includes('state._activeWorkflowText') && !uiHtml.includes('state._toolEventMsgs') && !uiHtml.includes('state._toolEventBatch') && !uiHtml.includes('state._lastCompletedWorkflow'), 'ui html: live workflow feedback state is conversation-scoped, not a global singleton');
  assert(uiHtml.includes('function isHiddenWorkflowMessage(message)') && uiHtml.includes('Preparing model request and available tools') && uiHtml.includes('Executing \\d+ tool call') && uiHtml.includes('renderPersistedToolMessage(m)'), 'ui html: hides internal workflow status rows and folds persisted tool workflow messages');
  assert(uiHtml.includes('background: transparent;') && uiHtml.includes('border-radius: 0;') && uiHtml.includes('.chat-msg::before') && uiHtml.includes('.chat-msg::after'), 'ui html: chat messages are not bubble cards');
  assert(uiHtml.includes('if (conv && api.ensureConversation)') && uiHtml.includes('return api.ensureConversation(conv.id).then(function(s)') && uiHtml.includes('return loadActiveConversationMessages(id);') && uiHtml.includes('api.getState(requestedConversationId)') && uiHtml.includes('if (s && s.chatMessages) renderChatMessages(s.chatMessages);'), 'ui html: workspace conversation switching reloads isolated backend messages by conversation id without mutating global backend active conversation');
  assert(uiHtml.includes("{ id: 'default', summary: t('workspace.defaultConversation')") && !uiHtml.includes("'conv-' + key + '-default'") && !uiHtml.includes("'conv-default-' + currentWorkspaceKey()"), 'ui html: default conversation id matches backend default id');
  assert(uiHtml.includes('function applyBackendConversations(items, activeId)') && uiHtml.includes('var preferredActiveId = hasLocalActive ? localActiveId') && uiHtml.includes('applyBackendConversations(backendConversations, preferredActiveId)'), 'ui html: reloads persisted conversation list from backend state while preserving each window-local active conversation');
  assert(uiHtml.includes('function activeConversationId()') && uiHtml.includes('api.sendMessage(text, lockedConversationId)'), 'ui html: sends initiating conversation id with each agent turn');
  assert(uiHtml.includes('window.submitCurrentAction = function()') && uiHtml.includes('window.stopCurrentConversation = async function()') && uiHtml.includes("api.abortConversation(conversationId)") && uiHtml.includes("e.key === 'Escape' && isCurrentConversationRunning() && !promptHasText()"), 'ui html: current running conversation with empty prompt shows a Stop action bound to Esc and abortConversation');
  assert(uiHtml.includes('function updateSubmitButtonState()') && uiHtml.includes("setSubmitButtonVisual('square', t('input.stop'), true, true)") && uiHtml.includes("setSubmitButtonVisual('send', t('input.send'), running, false)") && uiHtml.includes("els.prompt.addEventListener('input'"), 'ui html: submit button switches between Newmark marquee Stop and Send based on current conversation running state and prompt text');
  assert(uiHtml.includes('if (api.setMode) await api.setMode(state.mode)') && uiHtml.includes('if (api.setModel && state.model) await api.setModel(state.model)'), 'ui html: send synchronizes current mode and model before backend turn');
  assert(uiHtml.includes('renderConversations();') && uiHtml.includes('r.conversations') && uiHtml.includes('r.conversationId || lockedConversationId'), 'ui html: refreshes conversation titles from send response');
  assert(uiHtml.includes('runningConversations') && uiHtml.includes('setupAgentWorkEvents()') && uiHtml.includes('appendAgentWorkEvent(payload)') && uiHtml.includes('var id = String(event.conversationId ||') && uiHtml.includes('renderAgentWorkEvent(event)') && uiHtml.includes('summary: item.title ||'), 'ui html: supports per-conversation running state, conversation-bound live work events, and backend titles');
  assert(uiHtml.includes("type === 'queue_update'") && uiHtml.includes('state.backendQueue = event.queue') && uiHtml.includes('if (s && s.queued) {') && uiHtml.includes('window.syncNextQueueFromBackend(state.backendQueue)'), 'ui html: caches backend queue_update events for foreground/background conversation debugging');
  assert(uiHtml.includes('if (s && Array.isArray(s.workEvents))') && uiHtml.includes('var mergedEvents = existingEvents.concat(s.workEvents || [])') && uiHtml.includes('dedupedEvents.slice(-Number(state.agentWorkEventLimit || 240))'), 'ui html: merges backend work-event snapshots when foregrounding a conversation');
  assert(mainSource.includes('function broadcastAgentWorkEvent(event: unknown)') && mainSource.includes('BrowserWindow.getAllWindows()') && mainSource.includes("win.webContents.send('agent:workEvent', event)") && mainSource.includes("ipcMain.handle('agent:getState', async (_event, conversationId?: string)") && mainSource.includes("ipcMain.handle('agent:ensureConversation'") && mainSource.includes('backendConversationState(conversationId)') && mainSource.includes('agent.getConversationSnapshot(target)') && preloadSource.includes('ensureConversation: (id: string)') && preloadSource.includes('getState: (conversationId?: string)'), 'backend sharing: all desktop windows receive one backend event stream and can request read-only conversation-scoped snapshots without forcing window-local active conversation');
  assert(mainSource.includes('const singleInstanceLock = app.requestSingleInstanceLock()') && mainSource.includes("app.on('second-instance'") && mainSource.includes('createDesktopWindow = (loadUi = true)') && mainSource.includes('BrowserWindow.getAllWindows().filter'), 'main process: repeated desktop launches route into one shared backend process and create additional windows instead of duplicate runners');
  assert(uiHtml.includes('function loadActiveConversationMessages(conversationId)') && uiHtml.includes('var requestedConversationId = String(conversationId || activeConversationId() ||') && uiHtml.includes('api.getState(lockedConversationId)') && !uiHtml.includes('api.getState().then(function(s) {\n      if (s && s.contextCompression'), 'ui html: active window refreshes are bound to the owning conversation to prevent cross-window spillover');
  assert(uiHtml.includes('function setActiveWorkspaceConversationById(id)') && uiHtml.includes('var activeBeforeRender = (conversations.find(function(c)') && uiHtml.includes('if (activeBeforeRender) setActiveWorkspaceConversationById(activeBeforeRender);'), 'ui html: conversation list rerender preserves active conversation by id instead of stale cross-window index');
  assert(uiHtml.includes('function applyWorkspaceStateFromBackend(s)') && uiHtml.includes('var localActiveId = activeConversationId();') && uiHtml.includes('var hasLocalActive = backendConversations.some(function(item)') && uiHtml.includes('window.openWorkspaceManager = async function()') && uiHtml.includes('await window.refreshWorkspaceState().catch(function(){})'), 'ui html: workspace manager refresh keeps each window-local active conversation before rendering');
  assert(uiHtml.includes('window.selectWorkspace = function(name)') && uiHtml.includes('renderChatMessages([]);') && uiHtml.includes('state.backendQueue = { steering: [], followUp: [] };') && uiHtml.includes('syncBackendConversation().then(function()'), 'ui html: workspace switching clears stale conversation UI and reloads the workspace-bound backend conversation');
  assert(uiHtml.includes('function canonicalUiWorkspaceKey(ws)') && uiHtml.includes('window.upsertWorkspaceState = function(ws)') && !uiHtml.includes('state.workspaces.push(ws);'), 'ui html: workspace creation upserts exact folder bindings instead of showing temporary duplicates');
  assert(uiHtml.includes('id="skill-market-search"') && uiHtml.includes('window.updateSkillMarketSearch') && uiHtml.includes('window.filteredSkillMarket') && uiHtml.includes('window.renderSkillsMarketList'), 'ui html: Skills Market has searchable filtered list');
  assert(uiHtml.includes('window.renderSkillMarketSources') && uiHtml.includes('id="skill-market-source-name"') && uiHtml.includes('window.addSkillMarketSourceFromUi') && uiHtml.includes('window.setSkillMarketSourceEnabledFromUi'), 'ui html: Skills Market lets users add and manage market sources');
  assert(uiHtml.includes("item.description || item.desc || ''") && uiHtml.includes("item.marketSourceName || ''") && uiHtml.includes("item.path || ''") && uiHtml.includes("item.url || ''") && uiHtml.includes('No matching skills.'), 'ui html: Skills Market search covers skill metadata, source metadata, and empty results');
  assert(uiHtml.includes('--right-width: 380px;') && uiHtml.includes('var rightSize = Math.max(340, Math.min(680, newSize2));'), 'ui html: right sidebar has larger default and resize range');
  assert(uiHtml.includes('lucide-sprite.svg#square-pen') && uiHtml.includes("iconOnly('square-pen', t('right.editor'))") && !uiHtml.includes('lucide-sprite.svg#edit'), 'ui html: Editor tab uses available open-source icon sprite symbol');
  assert(uiHtml.includes('function renderMessageContent(text)') && uiHtml.includes('function renderMarkdownBlocks(text)') && uiHtml.includes('function renderMarkdownInline(text)') && uiHtml.includes('class="msg-image"') && uiHtml.includes('normalizeImageSrc(imageUrl)') && uiHtml.includes("if (/^data:image\\//i.test(url)) return true;"), 'ui html: conversation renders returned markdown images, including data URLs');
  assert(uiHtml.includes('class="md-table"') && uiHtml.includes('function renderMarkdownTable(lines, start)') && uiHtml.includes('class="md-math-inline"') && uiHtml.includes('class="md-math-block"') && uiHtml.includes('function renderMathFormula(tex)') && uiHtml.includes('class="math-frac"') && uiHtml.includes('"Cambria Math"') && uiHtml.includes('white-space: normal;'), 'ui html: conversation message markdown supports tables and rendered TeX-style formula blocks without pre-wrap text fallback');
  assert(uiHtml.includes('class="msg-file-link"') && uiHtml.includes('window.openLinkedFile = async function(path)') && uiHtml.includes("window.switchRightTab('editor');"), 'ui html: conversation file links open the right editor');
  assert(uiHtml.includes("els['md-viewer-content'] = nextMd;") && uiHtml.includes('window.getMarkdownContentNode = function()') && uiHtml.includes("var mc = window.getMarkdownContentNode();") && uiHtml.includes("window.switchRightTab('md-viewer');"), 'ui html: markdown viewer writes to the rebuilt live panel node');
  assert(uiHtml.includes('function optionLabel(option)') && uiHtml.includes('function renderPendingOptionsInChat(options)') && uiHtml.includes("state.renderedOptionKeys[key] = true"), 'ui html: pending option feedback renders into chat once');
  assert(uiHtml.includes('if (r && r.options)') && uiHtml.includes('renderPendingOptionsInChat(state.pendingOptions)') && uiHtml.includes("optionDescription(opt)"), 'ui html: send result and right status render structured option labels');
  assert(uiHtml.includes('window.runFlowWork = async function(workIdx)') && uiHtml.includes("await api.saveFile('Flow/' + normalized.name + '.Flow.json'") && uiHtml.includes('api.runFlow(normalized.name, flowInput, 0)') && uiHtml.includes('renderChatMessages(r.chatMessages)'), 'ui html: Flow Run uses backend core runner and renders returned messages');
  assert(uiHtml.includes('function stopFlowRunInternal()') && uiHtml.includes('window.stopFlowRun = function()') && uiHtml.includes('stopFlowRunInternal();') && !uiHtml.includes('window.stopFlowRun = function() {\n  stopFlowRun();'), 'ui html: Flow stop handler avoids global recursive self-call');
  assert(uiHtml.includes("conversationRunning && effectiveInputMode === 'guide'") && uiHtml.includes("effectiveInputMode === 'next' && !opts.fromQueue") && uiHtml.includes('state.nextQueue.push(text)') && uiHtml.includes('state.queueCollapsed = false') && !uiHtml.includes('[Queue] Current turn is locked; prompt will run after it completes.'), 'ui html: Guide steers active turns while Next queues future work in the bottom queue');
  assert(uiHtml.includes('id="terminal-timeout-input"') && uiHtml.includes('Max ms') && uiHtml.includes('Terminal timeout cap') && uiHtml.includes('window.setTerminalInterruptTimeout = function(value)') && uiHtml.includes("api.saveSetting('terminal', 'interrupt_timeout_ms', n)"), 'ui html: terminal timeout cap is editable and persisted');
  const agentKernelSource = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agent.ts'), 'utf-8');
  const piKernelSource = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agentKernelRunner.ts'), 'utf-8');
  const conversationKernelSource = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'conversationKernel.ts'), 'utf-8');
  const mainKernelSource = fs.readFileSync(path.join(process.cwd(), 'src', 'main.ts'), 'utf-8');
  const packageJsonForKernel = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
  assert(!packageJsonForKernel.dependencies?.['@earendil-works/pi-agent-core'] && !packageJsonForKernel.dependencies?.['@earendil-works/pi-ai'], 'kernel: no external pi runtime dependencies remain');
  assert(piKernelSource.includes("import('./agentKernel/index.js')") && piKernelSource.includes("import('./agentKernel/stream-types.js')"), 'kernel: adapter imports Newmark native agent kernel modules');
  assert(fs.existsSync(path.join(process.cwd(), 'src', 'core', 'agentKernel', 'agent.ts')) && fs.existsSync(path.join(process.cwd(), 'src', 'core', 'agentKernel', 'agent-loop.ts')) && fs.existsSync(path.join(process.cwd(), 'src', 'core', 'agentKernel', 'types.ts')) && !fs.existsSync(path.join(process.cwd(), 'src', 'vendor')), 'kernel: agent loop source is native core code and src/vendor is absent');
  assert(agentKernelSource.includes("import { runAgentKernel } from './agentKernelRunner'") && agentKernelSource.includes('await runAgentKernel(this)') && !agentKernelSource.includes('processLegacyForMigrationOnly'), 'kernel: Agent.process routes builtin turns through pi and has no legacy loop sentinel');
  assert(conversationKernelSource.includes('runner.queueActiveKernelMessage(prompt, queueMode)') && conversationKernelSource.includes('runner.subscribeAgentKernelUserMessageStart') && !conversationKernelSource.includes("runtime.runner.history.push({ role: 'user', content: prompt })"), 'kernel: same-session queue is handed to native kernel and consumed on user message start without duplicating history');
  assert(agentKernelSource.includes('queue: input.queue') && agentKernelSource.includes('notifyAgentKernelUserMessageStart') && piKernelSource.includes("case 'message_start'") && piKernelSource.includes('agent.notifyAgentKernelUserMessageStart'), 'kernel: backend queue snapshots survive work events and native message_start notifies conversation runtime');
  assert(mainKernelSource.includes("ipcMain.handle('agent:send'") && mainKernelSource.includes('const kernel = ensureConversationKernel(root)') && mainKernelSource.includes('kernel.prompt(message, targetConversation'), 'kernel: desktop send path uses the shared native conversation backend');
  assert(mainKernelSource.includes('ensureConversationKernel(root') && mainKernelSource.includes('conversationKernel.subscribe(event => broadcastAgentWorkEvent(event))') && mainKernelSource.includes('workEvents: conversationKernel?.events') && conversationKernelSource.includes('isAnyRunning()'), 'kernel: desktop IPC subscribes one backend event stream and exposes cached event snapshots');
  assert(!piKernelSource.includes("tokens.push({ type: 'text', text });\n      agent.recordToolResult") && piKernelSource.includes("type: 'tool_result'") && piKernelSource.includes('toolCallId: event.toolCallId') && piKernelSource.includes("agent.appendWorkflowMessage(`Tool ${event.toolName} result:"), 'kernel: tool results are streamed and persisted as folded work events, not appended to assistant text tokens');
  assert(agentKernelSource.includes('appendWorkflowMessage(content: string, toolName?: string, toolArgs?: string, persist = true)') && piKernelSource.includes("agent.appendWorkflowMessage(`Calling tool ${event.toolName}`, event.toolName, agent.visibleToolArgs(args), false)") && piKernelSource.includes("agent.appendWorkflowMessage(`Tool ${event.toolName} result:\\n${display}`, event.toolName, undefined, false)"), 'kernel: high-frequency workflow tool rows defer full conversation-state writes until turn persistence points');
  assert(piKernelSource.includes('const newmarkTools = agent.subagentToolDefinitions(agent.tools.definitions(agent.mode))') && piKernelSource.includes('streamWithNewmarkProvider(agent, provider, KernelStreamCompat, newmarkTools)') && piKernelSource.includes('kernel.state.tools = toKernelTools(agent, newmarkTools)') && piKernelSource.includes('cachedTools'), 'kernel: per-turn tool schemas are built once and reused by streaming and execution adapters');
  const streamProviderBody = (piKernelSource.match(/function streamWithNewmarkProvider[\s\S]*?async function transformContext/) || [''])[0];
  assert(!streamProviderBody.includes('currentAgent.tools.definitions(currentAgent.mode)'), 'kernel: streaming provider does not rebuild tool schemas on every model round');
  assert(piKernelSource.includes("if (!agent.config.getBool('context', 'auto_compress')) return messages;"), 'kernel: transformContext skips conversion and JSON comparison when auto compression is disabled');
  assert(mainKernelSource.includes("ipcMain.handle('agent:abortConversation'") && mainKernelSource.includes('conversationKernel?.abort(target)') && uiHtml.includes('api.archive(targetId)') && uiHtml.includes('delete state.runningConversations[targetId]'), 'kernel/ui: archiving a running conversation interrupts and archives directly');
  assert(uiHtml.includes('foregroundConversationHoldId') && uiHtml.includes('holdForegroundConversation(activeId, 4500)') && uiHtml.includes('Date.now() < Number(state.foregroundConversationHoldUntil'), 'ui html: foregrounded background conversations stay active briefly during backend refresh');
  assert(uiHtml.includes('trackedConversationUntil') && uiHtml.includes('conversationTrackMs: 300000') && uiHtml.includes('markConversationTracked(previousId') && uiHtml.includes('markConversationTracked(activeId'), 'ui html: conversations keep a five-minute tracking window after foreground switches without aborting background work');
  assert(conversationKernelSource.includes("getNum('agent', 'process_timeout_ms')") && conversationKernelSource.includes('if (timeoutMs <= 0) return runtime.runner.process(message)') && conversationKernelSource.includes('clearTimeout(timeout)'), 'kernel: desktop conversation turns have configurable outer timeout disabled by default');
  assert(conversationKernelSource.includes("options.mode === 'goal' && this.host.goal") && conversationKernelSource.includes('agent.updateGoal(this.host.goal.objective)'), 'kernel: per-conversation Goal runners inherit the active Goal objective');
  assert(mainKernelSource.includes('if (conversationKernel?.isAnyRunning()) return;'), 'kernel: desktop settings changes do not discard running conversation kernels');
  assert(mainKernelSource.includes('queued: result.queued') && mainKernelSource.includes('conversationKernel?.queued(snapshot.conversationId || target)'), 'kernel: desktop IPC exposes scoped backend conversation queue snapshots');
  assert(uiHtml.includes('window.refreshSkillsRuntime = function(next)') && uiHtml.includes('api.refreshSkills().then(done)') && uiHtml.includes('window.refreshSkillsRuntime(function(){ window.showPluginList'), 'ui html: skills changes refresh runtime without restart');
  assert(uiHtml.includes('api.updateGoal(state.goalText)') && uiHtml.includes('api.toggleGoalPause().then'), 'ui html: Goal edits and pause are synchronized to Agent backend');
  assert(uiHtml.includes('window.setRightWidthPx = function(px)') && uiHtml.includes("document.documentElement.style.setProperty('--right-width', rightSize + 'px')") && uiHtml.includes('if (els.right) els.right.style.width = \'\';'), 'ui html: right resize stores width in CSS variable and clears inline width');
  assert(uiHtml.includes('window.setRightCollapsed = function(collapsed)') && uiHtml.includes('els.right.style.width = \'\';') && uiHtml.includes("els.right.classList.toggle('open', !state.rightCollapsed);"), 'ui html: right collapse releases inline width and open class');
  assert(uiHtml.includes('window.toggleRight = function()') && uiHtml.includes('window.setRightCollapsed(!state.rightCollapsed);'), 'ui html: right toggle uses unified collapse state');
  assert(uiHtml.includes('window.setRightWidthPx(rightSize);') && !uiHtml.includes("el.style.width = rightSize + 'px';"), 'ui html: right resize does not pin layout with inline width');
  assert(/if \(state\.rightCollapsed\) \{\s*window\.setRightCollapsed\(false\);\s*\}/.test(uiHtml), 'ui html: right tab switching reopens through unified collapse state');
  assert(uiHtml.includes('data-tab="plan"') && uiHtml.includes('Conversation plan') && uiHtml.includes("iconOnly('list-checks', t('right.plan'))"), 'ui html: right sidebar has current conversation plan tab');
  assert(uiHtml.includes('window.refreshConversationPlan = function()') && uiHtml.includes('api.getConversationPlan(activeConversationId())') && uiHtml.includes('window.persistConversationPlan = function()') && uiHtml.includes('api.updateConversationPlan(state.conversationPlan, activeConversationId())') && uiHtml.includes('window.addConversationPlanItem = function()'), 'ui html: conversation plan panel has conversation-bound refresh, persist, and add handlers');
  assert(uiHtml.includes('window.cycleConversationPlanItem = function(idx)') && uiHtml.includes('window.editConversationPlanItem = function(idx)') && uiHtml.includes('window.deleteConversationPlanItem = function(idx)'), 'ui html: conversation plan supports status cycle, edit, and delete');
  assert(uiHtml.includes('if (s && s.conversationPlan)') && uiHtml.includes('state.conversationPlan = normalizeConversationPlan(s.conversationPlan)') && uiHtml.includes("if (state.rightTab === 'plan') window.renderConversationPlan();"), 'ui html: conversation plan refreshes from backend state');
  const distUiHtmlPath = path.join(process.cwd(), 'dist', 'ui', 'index.html');
  assert(fs.existsSync(distUiHtmlPath), 'ui dist html: generated index exists');
  const distUiHtml = fs.readFileSync(distUiHtmlPath, 'utf-8');
  assert(distUiHtml.includes('id="lucide-sprite-root"'), 'ui dist html: embeds lucide sprite');
  assert(!distUiHtml.includes('href="lucide-sprite.svg#'), 'ui dist html: no external lucide hrefs');
  assert(distUiHtml.includes('href="#message-square') && distUiHtml.includes('href="#send'), 'ui dist html: local icon hrefs present');
  class QueueProbeAgent extends Agent {
    public queued: Array<{ content: string; queueMode: 'steer' | 'followUp' }> = [];
    public processCalls: string[] = [];
    override queueActiveKernelMessage(content: string, queueMode: 'steer' | 'followUp'): boolean {
      this.queued.push({ content, queueMode });
      return true;
    }
    override recordWorkStatus(_content: string): void {}
    override setConversation(id: string): string { this.activeConversationId = id; return id; }
    override async process(input: string): Promise<StreamToken[]> {
      this.processCalls.push(input);
      await new Promise(resolve => setTimeout(resolve, 25));
      return [{ type: 'text', text: `done:${input}` }];
    }
  }
  const kernelHost = new Agent(path.join(TEST_DIR, 'pi-kernel-host'));
  const kernel = new ConversationKernel(TEST_DIR, kernelHost, null);
  const runtimeMap = (kernel as unknown as { runtimes: Map<string, { runner: Agent }> }).runtimes;
  const probe = new QueueProbeAgent(TEST_DIR, { agentOnly: true });
  runtimeMap.set('parallel-a', { id: 'parallel-a', runner: probe, activePromise: null, events: [], pendingNextTurn: [] } as any);
  const firstPrompt = kernel.prompt('first', 'parallel-a', { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'guide', engine: 'builtin' }, 'steer');
  await new Promise(resolve => setTimeout(resolve, 1));
  const samePromise = kernel.prompt('second', 'parallel-a', { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'guide', engine: 'builtin' }, 'steer');
  await Promise.all([firstPrompt, samePromise]);
  assert(probe.processCalls.length === 1 && probe.processCalls[0] === 'first', 'kernel: same-conversation active prompt keeps one active process');
  assert(probe.queued.length === 1 && probe.queued[0].content.includes('second') && probe.queued[0].queueMode === 'steer', 'kernel: same-conversation active prompt queues to active Agent kernel');
  assert(kernel.queued('parallel-a').steering.length === 0 && kernel.queued('parallel-a').followUp.length === 0, 'kernel: queued snapshot clears after active steering message is consumed');
  const eventProbe = new QueueProbeAgent(TEST_DIR, { agentOnly: true });
  const eventRuntime: any = { id: 'parallel-events', runner: eventProbe, activePromise: null, events: [], pendingNextTurn: [], queued: { steering: [], followUp: [] } };
  eventProbe.subscribeWorkEvents(event => {
    eventRuntime.events.push(event);
    for (const listener of ((kernel as any).listeners as Set<(event: any) => void>)) listener(event);
  });
  eventProbe.subscribeAgentKernelUserMessageStart(content => {
    (kernel as any).consumeQueuedMessage(eventRuntime, content);
  });
  runtimeMap.set('parallel-events', eventRuntime);
  const queueEvents: any[] = [];
  kernel.subscribe(event => {
    if (event.conversationId === 'parallel-events' && event.type === 'queue_update') queueEvents.push(event);
  });
  const eventRun = kernel.prompt('event-first', 'parallel-events', { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'guide', engine: 'builtin' }, 'steer');
  await new Promise(resolve => setTimeout(resolve, 1));
  const eventQueuedRun = kernel.prompt('event-second', 'parallel-events', { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'guide', engine: 'builtin' }, 'steer');
  const eventRunner = (runtimeMap.get('parallel-events') as any).runner as Agent;
  eventRunner.notifyAgentKernelUserMessageStart('event-second');
  await Promise.all([eventRun, eventQueuedRun]);
  assert(eventProbe.queued.some(item => item.content === 'event-second' && item.queueMode === 'steer') && queueEvents.every(event => !(event.queue?.steering || []).length), 'kernel: Guide steering is delivered to active kernel without entering the visible queue');
  const fallbackProbe = new QueueProbeAgent(TEST_DIR, { agentOnly: true });
  fallbackProbe.queueActiveKernelMessage = () => false;
  runtimeMap.set('parallel-fallback', { id: 'parallel-fallback', runner: fallbackProbe, activePromise: null, events: [], pendingNextTurn: [], queued: { steering: [], followUp: [] } } as any);
  const fallbackPrompt = kernel.prompt('fallback-first', 'parallel-fallback', { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'next', engine: 'builtin' }, 'followUp');
  await new Promise(resolve => setTimeout(resolve, 1));
  const fallbackSame = kernel.prompt('fallback-second', 'parallel-fallback', { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'next', engine: 'builtin' }, 'followUp');
  const duringFallbackQueue = kernel.queued('parallel-fallback');
  assert(duringFallbackQueue.followUp.some(item => item.includes('fallback-second')), 'kernel: queued snapshot records pending next-turn follow-up messages');
  await Promise.all([fallbackPrompt, fallbackSame]);
  assert(kernel.queued('parallel-fallback').followUp.length === 0 && fallbackProbe.processCalls.length === 2, 'kernel: queued snapshot clears after fallback next-turn follow-up drains');
  const parallelProbeA = new QueueProbeAgent(TEST_DIR, { agentOnly: true });
  const parallelProbeB = new QueueProbeAgent(TEST_DIR, { agentOnly: true });
  runtimeMap.set('parallel-b', { id: 'parallel-b', runner: parallelProbeA, activePromise: null, events: [], pendingNextTurn: [] } as any);
  runtimeMap.set('parallel-c', { id: 'parallel-c', runner: parallelProbeB, activePromise: null, events: [], pendingNextTurn: [] } as any);
  const t0 = Date.now();
  await Promise.all([
    kernel.prompt('one', 'parallel-b', { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'next', engine: 'builtin' }, 'followUp'),
    kernel.prompt('two', 'parallel-c', { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'next', engine: 'builtin' }, 'followUp'),
  ]);
  assert(Date.now() - t0 < 250 && parallelProbeA.processCalls[0] === 'one' && parallelProbeB.processCalls[0] === 'two', 'kernel: different conversations run through independent parallel runtimes');
  assert(uiHtml.includes('window.setLeftCollapsed = function(collapsed)'), 'ui html: left collapse uses unified state function');
  assert(uiHtml.includes('function animateLeftWidth(startWidth, targetWidth, finalCollapsed, token)') && uiHtml.includes('requestAnimationFrame(step)') && uiHtml.includes('easeOutCubic') && uiHtml.includes('var duration = reduceMotion ? 320 : 620;'), 'ui html: left collapse uses visible frame-driven width animation');
  assert(uiHtml.includes('function clearLeftWidthAnimation()') && uiHtml.includes('cancelAnimationFrame(state.leftAnimationFrame)') && uiHtml.includes('cancelAnimationFrame(state.leftAnimationQueuedFrame)') && uiHtml.includes('leftAnimationToken'), 'ui html: left collapse cancels stale animation frames');
  assert(uiHtml.includes('#left.width-animating') && uiHtml.includes('transition: background var(--duration-normal) var(--ease-out-expo) !important;'), 'ui html: left width animation disables coalesced CSS width transition');
  assert(uiHtml.includes("window.matchMedia('(prefers-reduced-motion: reduce)')") && uiHtml.includes('var duration = reduceMotion ? 320 : 620;'), 'ui html: left collapse keeps reduced-motion path animated but shorter');
  assert(uiHtml.includes('flex: 0 0 200px;') && uiHtml.includes('flex-basis: 48px;'), 'ui html: left collapse animates flex-basis with width');
  assert(uiHtml.includes('function queueLeftWidthAnimation(startWidth, targetWidth, finalCollapsed, token)') && uiHtml.includes('state.leftAnimationQueuedFrame = requestAnimationFrame(function() {') && uiHtml.includes('animateLeftWidth(startWidth, targetWidth, finalCollapsed, token);'), 'ui html: left collapse queues the visible width animation with one token');
  assert(uiHtml.includes('#left.collapsing .left-nav-icon') && uiHtml.includes('#left.collapsing .left-ws-item') && uiHtml.includes('width: 36px;'), 'ui html: left collapse uses collapsing icon geometry');
  assert(uiHtml.includes('#left.collapsing #left-ws-section') && uiHtml.includes('margin-top: 4px;'), 'ui html: left collapse re-centers the collapsing workspace section');
  assert(uiHtml.includes("left.classList.toggle('collapsing', collapsed);") && uiHtml.includes('queueLeftWidthAnimation(startWidth, targetWidth, collapsed, state.leftAnimationToken);') && uiHtml.includes("left.setAttribute('data-left-motion', finalCollapsed ? 'collapsing' : 'expanding');"), 'ui html: left collapse uses a pre-final motion state before animated width');
  assert(uiHtml.includes("left.classList.toggle('collapsed', !!finalCollapsed);") && uiHtml.indexOf("left.classList.toggle('collapsed', !!finalCollapsed);") < uiHtml.indexOf("left.classList.remove('collapsing');"), 'ui html: final collapsed class is applied only when width animation finishes');
  assert(!uiHtml.includes("left.classList.toggle('collapsed', collapsed);\n  animateLeftWidth(startWidth, targetWidth);"), 'ui html: left collapse does not apply final collapsed layout before animation starts');
  assert(uiHtml.includes('#left.collapsing .left-nav-icon span:not(.icon)') && uiHtml.includes('#left.collapsing #left-ws-header'), 'ui html: left collapse has an animated intermediate content state');
  assert(uiHtml.includes("els.left.style.flexBasis = px;") && uiHtml.includes('setLeftWidthPx(leftSize);'), 'ui html: left width setter covers flex-basis and resize');
  assert(!uiHtml.includes('#left.collapsed .left-nav-icon span:not(.icon),\n#left.collapsed #left-ws-header'), 'ui html: left collapse labels are not hard-hidden by grouped display rule');
  assert(uiHtml.includes('#left.collapsed .left-nav-icon span:not(.icon)') && uiHtml.includes('max-width: 0;'), 'ui html: left labels animate closed with max-width');
  assert(uiHtml.includes('#left-secondary.open') && uiHtml.includes('opacity: 1;') && uiHtml.includes('translateX(0) translateZ(0)'), 'ui html: left secondary panel animates width opacity transform');
  assert(uiHtml.includes("left.removeAttribute('data-left-motion');") && uiHtml.includes('panel-left-open'), 'ui html: collapsed left button uses open panel icon and clears motion marker');
  assert(uiHtml.includes('id="new-provider-protocol"') && uiHtml.includes('id="fuzzy-protocol"') && uiHtml.includes("t('model.protocol')"), 'ui html: provider protocol is editable and visible');
  assert(uiHtml.includes('window.editProvider = function(idx)') && uiHtml.includes('window.saveProviderEdit = function(idx)') && uiHtml.includes('window.removeProvider = function(idx)') && uiHtml.includes('_previous_name: p.name || name'), 'ui html: provider settings support edit/delete and renamed-key preservation');
  assert(uiHtml.includes('window.editModel = function(provIdx, modelIdx)') && uiHtml.includes('window.saveModelEdit = function(oldProvIdx, modelIdx)') && uiHtml.includes("id=\"edit-model-ctx\""), 'ui html: model settings support editing context, vision, thinking, and description');
  assert(uiHtml.includes('data-stab="tools"') && uiHtml.includes('function renderToolSettings()') && uiHtml.includes('window.setNativeToolEnabled') && uiHtml.includes("t('tools.title')"), 'ui html: Settings exposes native built-in tool switches');
  const preloadPath = path.join(process.cwd(), 'dist', 'preload.js');
  const preloadJs = fs.existsSync(preloadPath) ? fs.readFileSync(preloadPath, 'utf-8') : '';
  assert(preloadJs.includes('runFlow') && preloadJs.includes('flow:run'), 'preload: exposes core Flow runner IPC');
  const launcherTs = fs.readFileSync(path.join(process.cwd(), 'src', 'launcher.ts'), 'utf-8');
  const mainTs = fs.readFileSync(path.join(process.cwd(), 'src', 'main.ts'), 'utf-8');
  const serverTs = fs.readFileSync(path.join(process.cwd(), 'src', 'server.ts'), 'utf-8');
  const preloadTs = fs.readFileSync(path.join(process.cwd(), 'src', 'preload.ts'), 'utf-8');
  const toolsTs = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'index.ts'), 'utf-8');
  const nativeToolsTs = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'nativeTools.ts'), 'utf-8');
  const agentTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agent.ts'), 'utf-8');
  const configTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'config.ts'), 'utf-8');
  const fuzzyTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'fuzzy.ts'), 'utf-8');
  const providerTs = fs.readFileSync(path.join(process.cwd(), 'src', 'llm', 'provider.ts'), 'utf-8');
  const agentKernelRunnerTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agentKernelRunner.ts'), 'utf-8');
  const workspaceTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'workspace.ts'), 'utf-8');
  const memoryLabTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'memoryLab.ts'), 'utf-8');
  const installUpdateTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'installUpdate.ts'), 'utf-8');
  assert(uiHtml.includes('function scheduleLayoutStateSave()') && uiHtml.includes('layoutState: {') && uiHtml.includes('leftCollapsed: !!state.leftCollapsed') && uiHtml.includes('rightCollapsed: !!state.rightCollapsed') && uiHtml.includes('bottomCollapsed: !!state.bottomCollapsed') && uiHtml.includes('secondaryCollapsed: !!state.secondaryCollapsed') && uiHtml.includes('function applySavedLayoutState(input)') && mainTs.includes('leftPanelCollapsed') && mainTs.includes("case 'layoutState'") && configTs.includes('bottom_panel_collapsed') && configTs.includes('secondary_panel_collapsed'), 'ui layout memory: persists only sidebar collapsed booleans and restores them from config');
  assert(workspaceTs.includes('setPinned(id: string, pinned: boolean)') && agentTs.includes('setConversationPinned(id: string, pinned: boolean)') && preloadTs.includes('setWorkspacePinned') && preloadTs.includes('setConversationPinned') && mainTs.includes("agent:setWorkspacePinned") && mainTs.includes("agent:setConversationPinned") && uiHtml.includes('window.toggleWorkspacePinned') && uiHtml.includes('window.toggleConversationPinned') && uiHtml.includes('conv-pin-btn') && uiHtml.includes('ws-pin-btn'), 'pinning: workspace and conversation pin state is persisted and exposed in the UI');
  assert(agentTs.includes("listArchives(scope: 'workspace' | 'all' = 'workspace')") && agentTs.includes('archiveRoots()') && agentTs.includes('resolveArchivePath') && preloadTs.includes('listArchives: (scope?: string)') && mainTs.includes("scope === 'all' ? 'all' : 'workspace'") && uiHtml.includes("api.listArchives('workspace')") && uiHtml.includes("api.listArchives('all')") && uiHtml.includes('state.workspaceArchives') && uiHtml.includes('state.allArchives'), 'archives: right sidebar lists current workspace archives while Settings archive can list all archives');
  const cliCommandsTs = fs.readFileSync(path.join(process.cwd(), 'src', 'cli-commands.ts'), 'utf-8');
  const releaseCliSmokePath = path.join(process.cwd(), 'scripts', 'release-cli-smoke.cjs');
  const releaseCliSmoke = fs.existsSync(releaseCliSmokePath) ? fs.readFileSync(releaseCliSmokePath, 'utf-8') : '';
  const releaseCliUiConversationSyncSmokePath = path.join(process.cwd(), 'scripts', 'release-cli-ui-conversation-sync-smoke.cjs');
  const releaseCliUiConversationSyncSmoke = fs.existsSync(releaseCliUiConversationSyncSmokePath) ? fs.readFileSync(releaseCliUiConversationSyncSmokePath, 'utf-8') : '';
  const releaseUiSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-smoke.cjs');
  const releaseUiSmoke = fs.existsSync(releaseUiSmokePath) ? fs.readFileSync(releaseUiSmokePath, 'utf-8') : '';
  const releaseUiAgentSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-agent-smoke.cjs');
  const releaseUiAgentSmoke = fs.existsSync(releaseUiAgentSmokePath) ? fs.readFileSync(releaseUiAgentSmokePath, 'utf-8') : '';
  const releaseUiAcceptanceSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-acceptance-smoke.cjs');
  const releaseUiAcceptanceSmoke = fs.existsSync(releaseUiAcceptanceSmokePath) ? fs.readFileSync(releaseUiAcceptanceSmokePath, 'utf-8') : '';
  const releaseUiIntegrationSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-integration-smoke.cjs');
  const releaseUiIntegrationSmoke = fs.existsSync(releaseUiIntegrationSmokePath) ? fs.readFileSync(releaseUiIntegrationSmokePath, 'utf-8') : '';
  const releaseUiExternalWorkspaceSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-external-workspace-smoke.cjs');
  const releaseUiExternalWorkspaceSmoke = fs.existsSync(releaseUiExternalWorkspaceSmokePath) ? fs.readFileSync(releaseUiExternalWorkspaceSmokePath, 'utf-8') : '';
  const releaseUiOptionFeedbackSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-option-feedback-smoke.cjs');
  const releaseUiOptionFeedbackSmoke = fs.existsSync(releaseUiOptionFeedbackSmokePath) ? fs.readFileSync(releaseUiOptionFeedbackSmokePath, 'utf-8') : '';
  const releaseUiModelSettingsSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-model-settings-smoke.cjs');
  const releaseUiModelSettingsSmoke = fs.existsSync(releaseUiModelSettingsSmokePath) ? fs.readFileSync(releaseUiModelSettingsSmokePath, 'utf-8') : '';
  const releaseUiModelAutoContextSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-model-auto-context-smoke.cjs');
  const releaseUiModelAutoContextSmoke = fs.existsSync(releaseUiModelAutoContextSmokePath) ? fs.readFileSync(releaseUiModelAutoContextSmokePath, 'utf-8') : '';
  const releaseUiGemmaRemovalSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-gemma-removal-smoke.cjs');
  const releaseUiGemmaRemovalSmoke = fs.existsSync(releaseUiGemmaRemovalSmokePath) ? fs.readFileSync(releaseUiGemmaRemovalSmokePath, 'utf-8') : '';
  const releaseUiFlowSubagentSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-flow-subagent-smoke.cjs');
  const releaseUiFlowSubagentSmoke = fs.existsSync(releaseUiFlowSubagentSmokePath) ? fs.readFileSync(releaseUiFlowSubagentSmokePath, 'utf-8') : '';
  const releaseUiMediaMdSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-media-md-smoke.cjs');
  const releaseUiMediaMdSmoke = fs.existsSync(releaseUiMediaMdSmokePath) ? fs.readFileSync(releaseUiMediaMdSmokePath, 'utf-8') : '';
  const releaseUiSkillsSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-skills-smoke.cjs');
  const releaseUiSkillsSmoke = fs.existsSync(releaseUiSkillsSmokePath) ? fs.readFileSync(releaseUiSkillsSmokePath, 'utf-8') : '';
  const releaseUiMemoryLabSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-memory-lab-smoke.cjs');
  const releaseUiMemoryLabSmoke = fs.existsSync(releaseUiMemoryLabSmokePath) ? fs.readFileSync(releaseUiMemoryLabSmokePath, 'utf-8') : '';
  const releaseUiConversationQueuePlanSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-conversation-queue-plan-smoke.cjs');
  const releaseUiConversationQueuePlanSmoke = fs.existsSync(releaseUiConversationQueuePlanSmokePath) ? fs.readFileSync(releaseUiConversationQueuePlanSmokePath, 'utf-8') : '';
  const releaseUiFastConversationSwitchSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-fast-conversation-switch-smoke.cjs');
  const releaseUiFastConversationSwitchSmoke = fs.existsSync(releaseUiFastConversationSwitchSmokePath) ? fs.readFileSync(releaseUiFastConversationSwitchSmokePath, 'utf-8') : '';
  const releaseUiWorkspaceConversationIsolationSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-workspace-conversation-isolation-smoke.cjs');
  const releaseUiWorkspaceConversationIsolationSmoke = fs.existsSync(releaseUiWorkspaceConversationIsolationSmokePath) ? fs.readFileSync(releaseUiWorkspaceConversationIsolationSmokePath, 'utf-8') : '';
  const releaseUiMultiWindowSharedBackendSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-multi-window-shared-backend-smoke.cjs');
  const releaseUiMultiWindowSharedBackendSmoke = fs.existsSync(releaseUiMultiWindowSharedBackendSmokePath) ? fs.readFileSync(releaseUiMultiWindowSharedBackendSmokePath, 'utf-8') : '';
  const releaseUiGoalContinuationSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-goal-continuation-smoke.cjs');
  const releaseUiGoalContinuationSmoke = fs.existsSync(releaseUiGoalContinuationSmokePath) ? fs.readFileSync(releaseUiGoalContinuationSmokePath, 'utf-8') : '';
  const releaseUiWorkspaceLifecycleSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-workspace-lifecycle-smoke.cjs');
  const releaseUiWorkspaceLifecycleSmoke = fs.existsSync(releaseUiWorkspaceLifecycleSmokePath) ? fs.readFileSync(releaseUiWorkspaceLifecycleSmokePath, 'utf-8') : '';
  const releaseUiStartupRecoverySmokePath = path.join(process.cwd(), 'scripts', 'release-ui-startup-recovery-smoke.cjs');
  const releaseUiStartupRecoverySmoke = fs.existsSync(releaseUiStartupRecoverySmokePath) ? fs.readFileSync(releaseUiStartupRecoverySmokePath, 'utf-8') : '';
  const releaseUiIconSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-icon-smoke.cjs');
  const releaseUiIconSmoke = fs.existsSync(releaseUiIconSmokePath) ? fs.readFileSync(releaseUiIconSmokePath, 'utf-8') : '';
  const release111CliSmokePath = path.join(process.cwd(), 'scripts', 'release-111-cli-smoke.cjs');
  const release111CliSmoke = fs.existsSync(release111CliSmokePath) ? fs.readFileSync(release111CliSmokePath, 'utf-8') : '';
  const release111UiSmokePath = path.join(process.cwd(), 'scripts', 'release-111-ui-smoke.cjs');
  const release111UiSmoke = fs.existsSync(release111UiSmokePath) ? fs.readFileSync(release111UiSmokePath, 'utf-8') : '';
  const releaseComputerUseVisionSmokePath = path.join(process.cwd(), 'scripts', 'release-computer-use-vision-smoke.cjs');
  const releaseComputerUseVisionSmoke = fs.existsSync(releaseComputerUseVisionSmokePath) ? fs.readFileSync(releaseComputerUseVisionSmokePath, 'utf-8') : '';
  const releaseRealUiCopilotComputerUseSmokePath = path.join(process.cwd(), 'scripts', 'release-real-ui-copilot-computeruse-smoke.cjs');
  const releaseRealUiCopilotComputerUseSmoke = fs.existsSync(releaseRealUiCopilotComputerUseSmokePath) ? fs.readFileSync(releaseRealUiCopilotComputerUseSmokePath, 'utf-8') : '';
  const releaseRealProviderSmokePath = path.join(process.cwd(), 'scripts', 'release-real-provider-smoke.cjs');
  const releaseRealProviderSmoke = fs.existsSync(releaseRealProviderSmokePath) ? fs.readFileSync(releaseRealProviderSmokePath, 'utf-8') : '';
  const releaseRealApiNebulaMemorySwitchSmokePath = path.join(process.cwd(), 'scripts', 'release-real-apinebula-memory-switch-smoke.cjs');
  const releaseRealApiNebulaMemorySwitchSmoke = fs.existsSync(releaseRealApiNebulaMemorySwitchSmokePath) ? fs.readFileSync(releaseRealApiNebulaMemorySwitchSmokePath, 'utf-8') : '';
  const releaseRealProviderStressPath = path.join(process.cwd(), 'scripts', 'release-real-provider-stress.cjs');
  const releaseRealProviderStress = fs.existsSync(releaseRealProviderStressPath) ? fs.readFileSync(releaseRealProviderStressPath, 'utf-8') : '';
  const releaseRealClaudeEnvPreviewSmokePath = path.join(process.cwd(), 'scripts', 'release-real-claude-env-preview-smoke.cjs');
  const releaseRealClaudeEnvPreviewSmoke = fs.existsSync(releaseRealClaudeEnvPreviewSmokePath) ? fs.readFileSync(releaseRealClaudeEnvPreviewSmokePath, 'utf-8') : '';
  const distPortableScript = fs.readFileSync(path.join(process.cwd(), 'scripts', 'dist-portable.cjs'), 'utf-8');
  const packageJson = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8');
  const electronBuilderConfigTs = fs.readFileSync(path.join(process.cwd(), 'electron-builder.config.ts'), 'utf-8');
  const automationWakeTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'automationWake.ts'), 'utf-8');
  const appIconIcoPath = path.join(process.cwd(), 'assets', 'icon.ico');
  const appIconIco = fs.existsSync(appIconIcoPath) ? fs.readFileSync(appIconIcoPath) : Buffer.alloc(0);
  assert(launcherTs.includes('drainCliNetworkHandles') && mainTs.includes('drainCliNetworkHandles') && launcherTs.includes('getGlobalDispatcher') && mainTs.includes('getGlobalDispatcher'), 'cli entrypoints: drain async network handles before exit');
  assert(cliCommandsTs.includes("process.stdout.on('error'") && cliCommandsTs.includes("process.stderr.on('error'") && cliCommandsTs.includes('stdoutBrokenPipe = true') && cliCommandsTs.includes('stderrBrokenPipe = true'), 'cli entrypoints: suppress asynchronous EPIPE errors from closed stdout/stderr pipes');
  assert(mainTs.includes('function pathArgValue') && mainTs.includes("const prefix = `${key}=`") && mainTs.includes("let best = fs.existsSync(parts[0]) ? parts[0] : ''") && mainTs.includes("if (fs.existsSync(candidate)) best = candidate") && mainTs.includes("return best || parts.join(' ') || undefined") && mainTs.includes("pathArgValue(args, '--root')"), 'main entrypoint: supports --root paths with spaces, --root=path form, and longest existing path matching');
  assert(launcherTs.includes('function pathArgValue') && launcherTs.includes('function cliUserDataRoot') && launcherTs.includes('function isProtectedInstallRoot') && launcherTs.includes('function writableRuntimeRoot') && launcherTs.includes("path.join(cliUserDataRoot(), 'Roots'") && launcherTs.includes("const explicitRoot = pathArgValue(args, '--root')") && launcherTs.includes('const root = explicitRoot ? writableRuntimeRoot(explicitRoot) : process.cwd()'), 'launcher entrypoint: CLI --root supports spaces and remaps protected or unwritable roots to a user-data shadow root');
  assert(mainTs.includes('function hasPortableRootState') && mainTs.includes('function canWriteDirectory') && mainTs.includes('function isProtectedInstallRoot') && mainTs.includes('function shadowRootFor') && mainTs.includes('function writableRuntimeRoot') && mainTs.includes("process.env.ProgramFiles") && mainTs.includes("return app.getPath('userData')") && mainTs.includes("path.join(app.getPath('userData'), 'Roots'") && mainTs.includes('if (explicitRoot) return writableRuntimeRoot(explicitRoot)') && mainTs.includes('const explicitRoot = pathArgValue(args,') && mainTs.includes('firstRunInit(root);') && mainTs.includes('firstRunInit(fallbackRoot)') && mainTs.includes('logStartupFailure(`firstRunInit:${root}`'), 'main startup: packaged default root falls back from protected/unwritable install directories, and explicit protected --root is remapped to a writable userData shadow root');
  assert(mainTs.includes('existingPcId = fs.existsSync(pcHashPath)') && mainTs.includes('if (existingPcId !== pcId) fs.writeFileSync(pcHashPath, pcId') && memoryLabTs.includes('if (!fs.existsSync(this.indexPath))') && memoryLabTs.includes('this.normalizeIndex(raw);') && !memoryLabTs.includes('else this.saveIndex(this.normalizeIndex(this.loadIndex()))') && configTs.includes('if (fs.existsSync(configPath))') && workspaceTs.includes('if (this.external.length !== before) this.saveExternal();'), 'startup initialization: avoids rewriting config.json, PC_Hash.config, Memory Lab index, and External.json on every launch');
  assert(mainTs.includes('const STARTUP_HTML') && mainTs.includes('loadStartupShell(win)') && mainTs.includes("recordStartup('startup-shell-loaded')") && mainTs.includes('createDesktopWindow(false)') && mainTs.includes("recordStartup('window-shown')") && mainTs.includes("recordStartup('agent-ready')") && mainTs.includes('for (const win of BrowserWindow.getAllWindows())') && mainTs.includes('loadDesktopWindowUi(win)') && mainTs.includes('}, 80);') && mainTs.indexOf('createDesktopWindow(false)') < mainTs.indexOf('agent = new Agent(root)') && mainTs.indexOf('agent = new Agent(root)') < mainTs.lastIndexOf('loadDesktopWindowUi(win)'), 'main startup: shows and paints a lightweight desktop shell before heavy Agent initialization, then loads UI after IPC handlers are ready');
  assert(mainTs.includes("const APP_NAME = 'Newmark Agent'") && mainTs.includes("const APP_ID = 'ai.newmark.agent'") && mainTs.includes('app.setName(APP_NAME)') && mainTs.includes('app.setAppUserModelId(APP_ID)'), 'main entrypoint: registers Newmark process/app identity instead of Electron');
  assert(packageJson.includes('"productName": "Newmark Agent"') && packageJson.includes('"executableName": "Newmark Agent"') && packageJson.includes('"signAndEditExecutable": false') && packageJson.includes('"resedit": "^1.7.2"') && electronBuilderConfigTs.includes("productName: 'Newmark Agent'") && electronBuilderConfigTs.includes("executableName: 'Newmark Agent'") && electronBuilderConfigTs.includes("productName: 'Newmark Agent'"), 'package metadata: product and executable names are fixed to Newmark Agent and Windows resource editing is handled by local resedit patching');
  assert(fs.existsSync(path.join(process.cwd(), 'assets', 'app-icon-dark.png')) && fs.existsSync(path.join(process.cwd(), 'assets', 'app-icon-light.png')) && appIconIco.length > 6 && appIconIco.readUInt16LE(2) === 1 && appIconIco.readUInt16LE(4) >= 1, 'app icons: themed PNG assets and Windows ICO exist');
  assert(packageJson.includes('"icon": "assets/icon.ico"') && electronBuilderConfigTs.includes("icon: 'assets/icon.ico'"), 'app icons: Windows package uses generated ICO');
  assert(mainTs.includes('nativeTheme') && mainTs.includes("app-icon-light.png") && mainTs.includes("app-icon-dark.png") && mainTs.includes('createAppIconImage(16)') && mainTs.includes('icon: themedAppIconPath()'), 'app icons: runtime windows and tray use themed assets');
  assert(nativeToolsTs.includes('NATIVE_TOOL_CATALOG') && nativeToolsTs.includes("name: 'computer_use'") && nativeToolsTs.includes("name: 'terminal_takeover'") && nativeToolsTs.includes('normalizeNativeToolEnabled') && configTs.includes('defaultNativeToolEnabled()') && configTs.includes("tools:") && toolsTs.includes('isNativeToolEnabled') && mainTs.includes('nativeToolCatalogForState') && mainTs.includes("case 'nativeTools'"), 'native tools settings: catalog, defaults, backend state, and ToolExecutor gating are wired');
  assert(nativeToolsTs.includes("name: 'ssh_workspace'") && toolsTs.includes("t('ssh_workspace'") && toolsTs.includes('new SshManager') && preloadTs.includes('createSshWorkspace') && mainTs.includes("ssh:createWorkspace") && uiHtml.includes('ws-ssh-host') && uiHtml.includes('validateSshWorkspaceForm'), 'OpenSSH workspace: native tool, IPC, preload, and new-workspace UI are wired');
  assert(uiHtml.includes('id="title-app-logo"') && uiHtml.includes('id="title-app-icon"') && uiHtml.includes('../../assets/app-icon-dark.png') && uiHtml.includes('../../assets/app-icon-light.png'), 'app icons: custom titlebar renders themed icon assets');
  assert(uiHtml.includes('#topbar .logo::before') && uiHtml.includes('animation: marquee-rotate var(--marquee-speed) linear infinite') && uiHtml.includes('var(--g1), var(--g2), var(--g3), var(--g4), var(--g1)') && uiHtml.includes('calc(-2 * var(--marquee-width))'), 'app icons: custom titlebar border uses shared adjustable marquee settings');
  assert(fs.existsSync(path.join(process.cwd(), 'scripts', 'patch-win-exe-icon.cjs')) && distPortableScript.includes("require('./patch-win-exe-icon.cjs')") && distPortableScript.includes('patchExeIdentity(unpackedExe)') && distPortableScript.includes('patchAndVerify(unpackedExe, packageIcon)') && distPortableScript.includes('verifyExeIcon(unpackedExe, packageIcon)') && distPortableScript.includes('verifyExeIdentity(unpackedExe)') && distPortableScript.includes('ProductName') && distPortableScript.includes('FileDescription') && distPortableScript.includes('electron.exe'), 'app icons: dist-portable patches/verifies win-unpacked exe associated icon and Newmark Windows resource identity before zipping');
  assert(packageJson.includes('"release:cli-smoke"') && releaseCliSmoke.includes('Start-Process') && releaseCliSmoke.includes('-RedirectStandardOutput'), 'release cli smoke: uses stable redirected packaged exe invocation');
  assert(releaseCliSmoke.includes("['state', '--root', root]") && releaseCliSmoke.includes('parsedState.autoSwitch') && releaseCliSmoke.includes('parsedState.autoSwitchScope') && releaseCliSmoke.includes('parsedState.openAIApiMode') && releaseCliSmoke.includes('parsedState.contextWindow') && releaseCliSmoke.includes("['tool', 'write'") && releaseCliSmoke.includes("'--args-file'") && releaseCliSmoke.includes("['send', '--input-file'") && releaseCliSmoke.includes("['validate-models', '--selected', 'ReleaseCliMock/release-cli-mock'") && releaseCliSmoke.includes("['skills-market'") && releaseCliSmoke.includes("'memory-lab'") && releaseCliSmoke.includes('ReleaseCliMemoryNeedle') && releaseCliSmoke.includes("log('memory-lab ok')") && releaseCliSmoke.includes("'install-update'") && releaseCliSmoke.includes("log('install-update ok')"), 'release cli smoke: covers state, model auto/context fields, tool, send, validate-models, skills-market, memory-lab, and install-update');
  assert(releaseCliSmoke.includes('RELEASE_CLI_SEND_OK 做了什么 验证 文件') && releaseCliSmoke.includes('"stream":true'), 'release cli smoke: covers UTF-8 streaming send output');
  assert(packageJson.includes('"release:111-cli-smoke"') && release111CliSmoke.includes('file_audit') && release111CliSmoke.includes('git_branch') && release111CliSmoke.includes('gh_fork') && release111CliSmoke.includes('repo_security_audit') && release111CliSmoke.includes('computer_use') && release111CliSmoke.includes('terminal_takeover') && release111CliSmoke.includes('ssh_workspace'), 'release 1.1.1 cli smoke: covers packaged audit, GitHub, Computer Use, SSH workspace, and terminal takeover tools');
  assert(release111CliSmoke.includes('positer/Newmark-Agent') && release111CliSmoke.includes('git-remote-fallback') && release111CliSmoke.includes('visibility') && release111CliSmoke.includes('Call computer_use observe first') && release111CliSmoke.includes('NEWMARK_RELEASE_SSH_HOST') && release111CliSmoke.includes('remotePcHash') && release111CliSmoke.includes('RELEASE_111_CLI_TERMINAL_TAKEOVER_DONE') && release111CliSmoke.includes('stateHasTakeoverChain') && release111CliSmoke.includes('TAKEOVER_WRITE_OK'), 'release 1.1.1 cli smoke: validates public remote review, GitHub fallback, target_id guard, optional VM SSH link, and same-session takeover output');
  assert(packageJson.includes('"release:computer-use-vision-smoke"') && releaseComputerUseVisionSmoke.includes('mock-computer-vision') && releaseComputerUseVisionSmoke.includes('mock-computer-text') && releaseComputerUseVisionSmoke.includes('computer_use') && releaseComputerUseVisionSmoke.includes("action: 'observe'") && releaseComputerUseVisionSmoke.includes('data:image/png;base64,') && releaseComputerUseVisionSmoke.includes('text-only second request unexpectedly included screenshot image_url') && releaseComputerUseVisionSmoke.includes('tempScreenshotsDeleted') && releaseComputerUseVisionSmoke.includes('requestLeaksTempScreenshotPath'), 'release Computer Use vision smoke: packaged release verifies vision models receive image plus UI text, text-only models receive UI text only, and screenshots are deleted after one use');
  assert(packageJson.includes('"release:real-ui-copilot-computeruse-smoke"') && releaseRealUiCopilotComputerUseSmoke.includes("_local', 'real-ui-user-test") && releaseRealUiCopilotComputerUseSmoke.includes('window.api.githubCopilotLogin()') && releaseRealUiCopilotComputerUseSmoke.includes('GitHub Copilot imported') && releaseRealUiCopilotComputerUseSmoke.includes('2026-07-03-real-ui-copilot-computeruse-followup.png') && releaseRealUiCopilotComputerUseSmoke.includes('gpt-5.4-mini') && releaseRealUiCopilotComputerUseSmoke.includes('GitHub token leaked'), 'release real UI Copilot/ComputerUse smoke: validates real root model, GitHub Copilot import, screenshot evidence, and secret guard');
  assert(packageJson.includes('"release:cli-ui-conversation-sync-smoke"') && releaseCliUiConversationSyncSmoke.includes('--agent-only') && releaseCliUiConversationSyncSmoke.includes('--conversation') && releaseCliUiConversationSyncSmoke.includes('window.switchConversation') && releaseCliUiConversationSyncSmoke.includes('window.newConversation()'), 'release cli/ui conversation sync smoke: drives packaged pure Agent, CLI workspace conversation, and UI conversation paths');
  assert(releaseCliUiConversationSyncSmoke.includes('CLI_UI_SYNC_FROM_CLI') && releaseCliUiConversationSyncSmoke.includes('CLI_UI_SYNC_REPLY_FROM_CLI') && releaseCliUiConversationSyncSmoke.includes('CLI_UI_SYNC_FROM_UI') && releaseCliUiConversationSyncSmoke.includes('CLI_UI_SYNC_REPLY_FROM_UI'), 'release cli/ui conversation sync smoke: verifies CLI-created and UI-created transcripts round-trip');
  assert(releaseCliUiConversationSyncSmoke.includes('pure Agent CLI mode does not depend on workspace') && releaseCliUiConversationSyncSmoke.includes('2026-07-01-release-cli-ui-conversation-sync-smoke.png') && releaseCliUiConversationSyncSmoke.includes('messageCount >= 2') && releaseCliUiConversationSyncSmoke.includes('workspace: {') && releaseCliUiConversationSyncSmoke.includes('agentOnlyState.workspace !== null'), 'release cli/ui conversation sync smoke: captures evidence and validates pure Agent plus persisted workspace conversation state');
  assert(packageJson.includes('"release:ui-smoke"') && releaseUiSmoke.includes('--remote-debugging-port=') && releaseUiSmoke.includes('window.fuzzyInject()') && releaseUiSmoke.includes('window.showPluginList()') && releaseUiSmoke.includes('window.showFlowEditor()') && releaseUiSmoke.includes('window.showNewConversationPage()') && releaseUiSmoke.includes('window.showWorkspaceRequired()'), 'release ui smoke: validates real packaged secondary windows through CDP');
  assert(releaseUiSmoke.includes("'zh-CN'") && releaseUiSmoke.includes("'输入指令...'") && releaseUiSmoke.includes("'模糊注入模型'") && releaseUiSmoke.includes("'需要工作区'") && releaseUiSmoke.includes('language en/zh switch ok'), 'release ui smoke: validates Chinese language switching in packaged UI');
  assert(releaseUiSmoke.includes("leftNewChat: 'New chat'") && releaseUiSmoke.includes("leftNewChat: '新对话'") && releaseUiSmoke.includes("secondarySettingsTitle: '工作区设置'") && releaseUiSmoke.includes("english-after"), 'release ui smoke: validates bidirectional language switching in packaged UI');
  assert(releaseUiSmoke.includes("await setLanguage(cdp, 'auto')") && releaseUiSmoke.includes('auto-before persisted language mismatch') && releaseUiSmoke.includes("['Input instruction...', '输入指令...']"), 'release ui smoke: validates auto language switching and persistence in packaged UI');
  assert(releaseUiSmoke.includes('function seedDynamicI18nState') && releaseUiSmoke.includes("contextCompression: '上下文已压缩 | 模型 | 8 -> 2 条消息'") && releaseUiSmoke.includes("nextQueue: '队列 1'") && releaseUiSmoke.includes("modelAuto: '自动'"), 'release ui smoke: validates dynamic language switching in packaged UI');
  assert(releaseUiSmoke.includes('function readModelSettingsSnapshot') && releaseUiSmoke.includes("englishModels.chips.some(chip => chip.text.includes('available'))") && releaseUiSmoke.includes("chineseModels.chips.some(chip => chip.text.includes('不可用'))"), 'release ui smoke: validates model settings bilingual status/action labels');
  assert(releaseUiSmoke.includes('activeSubWindowAfterSwitch') && releaseUiSmoke.includes('Workspace required') && releaseUiSmoke.includes('Conversations are bound to a workspace.'), 'release ui smoke: validates active secondary window rerenders after language switch');
  assert(releaseUiSmoke.includes('function captureScreenshot') && releaseUiSmoke.includes('Emulation.setDeviceMetricsOverride') && releaseUiSmoke.includes('viewport-from-surface') && releaseUiSmoke.includes('screenshot capture failed'), 'release ui smoke: requires hardened screenshot capture evidence');
  assert(releaseUiSmoke.includes('function captureOsScreenshot') && releaseUiSmoke.includes('System.Windows.Forms.Screen') && releaseUiSmoke.includes('os-fallback'), 'release ui smoke: falls back to OS screenshot when CDP screenshot stalls');
  assert(packageJson.includes('"release:111-ui-smoke"') && release111UiSmoke.includes("window.openSettings('models')") && release111UiSmoke.includes('#new-provider-protocol') && release111UiSmoke.includes('github_models') && release111UiSmoke.includes('fuzzyGithubOption') && release111UiSmoke.includes('window.githubCopilotLogin'), 'release 1.1.1 ui smoke: validates packaged GitHub Models exact-login UI and fuzzy exclusion');
  assert(release111UiSmoke.includes('window.applyTerminalTakeoverEvent') && release111UiSmoke.includes('terminal-tab.agent-takeover.marquee-border') && release111UiSmoke.includes('terminal-pane.agent-takeover.marquee-border') && release111UiSmoke.includes('2026-07-03-release-111-ui-smoke.png'), 'release 1.1.1 ui smoke: validates packaged bottom terminal takeover mirror with marquee border');
  assert(packageJson.includes('"release:ui-icon-smoke"') && fs.existsSync(path.join(process.cwd(), 'scripts', 'release-ui-icon-smoke.cjs')) && releaseUiIconSmoke.includes('verifyExeIcon(exePath, packageIcon)') && releaseUiIconSmoke.includes('verifyTitlebarIcon') && releaseUiIconSmoke.includes('marquee-rotate') && releaseUiIconSmoke.includes('rootGradientColor') && releaseUiIconSmoke.includes('rootMarqueeSpeed') && releaseUiIconSmoke.includes('rootMarqueeWidth'), 'release ui icon smoke: npm entry validates win-unpacked exe icon, runtime titlebar icon, and shared adjustable animated border');
  assert(packageJson.includes('"release:ui-agent-smoke"') && releaseUiAgentSmoke.includes('window.sendMessage()') && releaseUiAgentSmoke.includes('release-ui-agent-mock') && releaseUiAgentSmoke.includes('ACTIVE_TOOLCHAIN_RESULT_OK_20260627_SCRIPT'), 'release ui agent smoke: drives real packaged renderer send path with mock model');
  assert(releaseUiAgentSmoke.includes("'write,bash,edit,read'") && releaseUiAgentSmoke.includes('"timeout_ms":10000') && releaseUiAgentSmoke.includes('terminal timeout cap ok') && releaseUiAgentSmoke.includes('[write] OK') && releaseUiAgentSmoke.includes('[edit] OK'), 'release ui agent smoke: validates write bash edit read tools and terminal timeout cap');
  assert(packageJson.includes('"release:ui-acceptance-smoke"') && releaseUiAcceptanceSmoke.includes("window.api.createWorkspace('acceptance-workspace')") && releaseUiAcceptanceSmoke.includes("window.api.sendMessage('ACCEPTANCE_BUILD_WRITE") && releaseUiAcceptanceSmoke.includes("window.api.sendMessage('ACCEPTANCE_PLAN_BLOCK"), 'release ui acceptance smoke: covers workspace creation, Build send, and Plan send in packaged UI');
  assert(releaseUiAcceptanceSmoke.includes("window.api.updateGoal('ACCEPTANCE_GOAL") && releaseUiAcceptanceSmoke.includes('window.api.toggleGoalPause()') && releaseUiAcceptanceSmoke.includes("window.api.runFlow('acceptance-flow'") && releaseUiAcceptanceSmoke.includes('window.api.archive()'), 'release ui acceptance smoke: covers Goal pause/resume, Flow run, and workspace archive');
  assert(releaseUiAcceptanceSmoke.includes('restart restore ok') && releaseUiAcceptanceSmoke.includes("s.workspaces.current.name === 'acceptance-workspace'") && releaseUiAcceptanceSmoke.includes('conversationId') && releaseUiAcceptanceSmoke.includes('release-ui-acceptance-mock'), 'release ui acceptance smoke: covers restart restore and mock model path');
  assert(packageJson.includes('"release:ui-integration-smoke"') && releaseUiIntegrationSmoke.includes('--remote-debugging-port=') && releaseUiIntegrationSmoke.includes('window.sendMessage()') && releaseUiIntegrationSmoke.includes('release-ui-integration-mock'), 'release ui integration smoke: drives real packaged renderer send path through CDP mock provider');
  assert(releaseUiIntegrationSmoke.includes('browser_open') && releaseUiIntegrationSmoke.includes('browser_snapshot') && releaseUiIntegrationSmoke.includes('browser_type') && releaseUiIntegrationSmoke.includes('browser_click') && releaseUiIntegrationSmoke.includes('browser_eval'), 'release ui integration smoke: covers browser open snapshot type click eval tools');
  assert(releaseUiIntegrationSmoke.includes('gh_auth_status') && releaseUiIntegrationSmoke.includes('automation_create') && releaseUiIntegrationSmoke.includes('automation_list'), 'release ui integration smoke: covers GitHub CLI status and automation tools');
  assert(releaseUiIntegrationSmoke.includes('RELEASE_UI_INTEGRATION_OK') && releaseUiIntegrationSmoke.includes('BROWSER_INTERACTION_OK') && releaseUiIntegrationSmoke.includes('RELEASE_UI_INTEGRATION_AUTOMATION_PROMPT'), 'release ui integration smoke: validates visible browser result and persisted automation marker');
  assert(packageJson.includes('"release:ui-external-workspace-smoke"') && releaseUiExternalWorkspaceSmoke.includes('--remote-debugging-port=') && releaseUiExternalWorkspaceSmoke.includes('window.showNewWorkspaceDialog()') && releaseUiExternalWorkspaceSmoke.includes('window.doCreateWorkspace()'), 'release ui external workspace smoke: drives real packaged external workspace UI through CDP');
  assert(releaseUiExternalWorkspaceSmoke.includes('ws-ext-path-input') && releaseUiExternalWorkspaceSmoke.includes('createExternalWorkspace') && releaseUiExternalWorkspaceSmoke.includes('PC_Hash.config') && releaseUiExternalWorkspaceSmoke.includes('External.json') && releaseUiExternalWorkspaceSmoke.includes('hostBinding'), 'release ui external workspace smoke: covers external workspace creation and host binding persistence');
  assert(releaseUiExternalWorkspaceSmoke.includes('archive()') && releaseUiExternalWorkspaceSmoke.includes('external workspace archive ok') && releaseUiExternalWorkspaceSmoke.includes('different-pc|win32|x64') && releaseUiExternalWorkspaceSmoke.includes('external workspace hidden after PC hash mismatch'), 'release ui external workspace smoke: covers workspace-local archive and PC mismatch hiding');
  assert(packageJson.includes('"release:ui-option-feedback-smoke"') && releaseUiOptionFeedbackSmoke.includes('--remote-debugging-port=') && releaseUiOptionFeedbackSmoke.includes('window.sendMessage()') && releaseUiOptionFeedbackSmoke.includes('release-ui-option-feedback-mock'), 'release ui option feedback smoke: drives real packaged renderer send path through CDP mock provider');
  assert(releaseUiOptionFeedbackSmoke.includes('OPTION_SMOKE_DEFAULT') && releaseUiOptionFeedbackSmoke.includes('OPTION_SMOKE_ASK_MORE') && releaseUiOptionFeedbackSmoke.includes('OPTION_SMOKE_ASK_LESS') && releaseUiOptionFeedbackSmoke.includes('OPTION_SMOKE_FULLY_AUTONOMOUS'), 'release ui option feedback smoke: covers all four option feedback levels');
  assert(releaseUiOptionFeedbackSmoke.includes("window.switchRightTab('status')") && releaseUiOptionFeedbackSmoke.includes('Pending options') && releaseUiOptionFeedbackSmoke.includes('Disabled by fully_autonomous option feedback'), 'release ui option feedback smoke: covers visible options and fully autonomous disable result');
  assert(releaseUiOptionFeedbackSmoke.includes('OPTION_SMOKE_PERMISSION_ASK') && releaseUiOptionFeedbackSmoke.includes('outside_readonly') && releaseUiOptionFeedbackSmoke.includes('ask_user') && releaseUiOptionFeedbackSmoke.includes('User approval required'), 'release ui option feedback smoke: covers ask_user permission violation through real agent send path');
  assert(packageJson.includes('"release:ui-model-settings-smoke"') && releaseUiModelSettingsSmoke.includes('--remote-debugging-port=') && releaseUiModelSettingsSmoke.includes("window.openSettings('models')"), 'release ui model settings smoke: drives real packaged Models settings UI through CDP');
  assert(releaseUiModelSettingsSmoke.includes('window.addProvider()') && releaseUiModelSettingsSmoke.includes('window.addModel()') && releaseUiModelSettingsSmoke.includes('window.editProvider(providerIdx)') && releaseUiModelSettingsSmoke.includes('window.editModel(providerIdx, 0)'), 'release ui model settings smoke: covers provider/model create and update');
  assert(releaseUiModelSettingsSmoke.includes('window.removeModel(providerIdx, 0)') && releaseUiModelSettingsSmoke.includes('window.removeProvider(providerIdx)') && releaseUiModelSettingsSmoke.includes('test-key-crud-secret'), 'release ui model settings smoke: covers provider/model delete and key preservation');
  assert(releaseUiModelSettingsSmoke.includes('max_tokens === 8192') && releaseUiModelSettingsSmoke.includes('vision === false') && releaseUiModelSettingsSmoke.includes('thinking === true') && releaseUiModelSettingsSmoke.includes('Edited CRUD model description'), 'release ui model settings smoke: verifies model context, vision, thinking, and description fields');
  assert(packageJson.includes('"release:ui-model-auto-context-smoke"') && releaseUiModelAutoContextSmoke.includes('--remote-debugging-port=') && releaseUiModelAutoContextSmoke.includes("window.openSettings('models')"), 'release ui model auto/context smoke: drives real packaged Models settings UI through CDP');
  assert(releaseUiModelAutoContextSmoke.includes("window.setAutoSwitchMode('all')") && releaseUiModelAutoContextSmoke.includes("window.setAutoSwitchMode('provider')") && releaseUiModelAutoContextSmoke.includes("window.setOpenAIApiMode('responses')"), 'release ui model auto/context smoke: validates full/provider Auto modes and Responses API mode');
  assert(releaseUiModelAutoContextSmoke.includes('context-token-ring') && releaseUiModelAutoContextSmoke.includes('ringWidth !== 16') && releaseUiModelAutoContextSmoke.includes('tooltipText.includes') && releaseUiModelAutoContextSmoke.includes('2026-07-01-release-ui-model-auto-context-smoke.png'), 'release ui model auto/context smoke: validates small context token ring placement, hover tooltip, and screenshot evidence');
  assert(packageJson.includes('"release:ui-gemma-removal-smoke"') && releaseUiGemmaRemovalSmoke.includes('--remote-debugging-port=') && releaseUiGemmaRemovalSmoke.includes("window.openSettings('models')"), 'release ui Gemma removal smoke: drives real packaged Models settings UI through CDP');
  assert(releaseUiGemmaRemovalSmoke.includes('typeof window.api.downloadGemma') && releaseUiGemmaRemovalSmoke.includes('Gemma download UI absent') && releaseUiGemmaRemovalSmoke.includes('Fuzzy inject model'), 'release ui Gemma removal smoke: verifies removed download bridge/UI and retained fuzzy entry');
  assert(releaseUiGemmaRemovalSmoke.includes('LocalRuntimeCheck') && releaseUiGemmaRemovalSmoke.includes('http://127.0.0.1:11434/v1') && releaseUiGemmaRemovalSmoke.includes('local-runtime-manual-model'), 'release ui Gemma removal smoke: verifies manual local OpenAI-compatible provider/model path');
  assert(releaseUiGemmaRemovalSmoke.includes('2026-06-29-release-gemma-removal-visual.png') && releaseUiGemmaRemovalSmoke.includes('Page.captureScreenshot'), 'release ui Gemma removal smoke: captures visual evidence');
  assert(packageJson.includes('"release:ui-flow-subagent-smoke"') && releaseUiFlowSubagentSmoke.includes('--remote-debugging-port=') && releaseUiFlowSubagentSmoke.includes('window.sendMessage()') && releaseUiFlowSubagentSmoke.includes('release-ui-flow-subagent-mock'), 'release ui Flow/subagent smoke: drives real packaged renderer send path through CDP mock provider');
  assert(releaseUiFlowSubagentSmoke.includes('flow_save') && releaseUiFlowSubagentSmoke.includes('flow_list') && releaseUiFlowSubagentSmoke.includes('flow_run') && releaseUiFlowSubagentSmoke.includes('FLOW_COMPONENT_RUNTIME_INPUT'), 'release ui Flow/subagent smoke: covers agent-designed Flow save, list, and trigger');
  assert(releaseUiFlowSubagentSmoke.includes('task') && releaseUiFlowSubagentSmoke.includes('subagent_send') && releaseUiFlowSubagentSmoke.includes('subagent_result') && releaseUiFlowSubagentSmoke.includes('subagent_close'), 'release ui Flow/subagent smoke: covers subagent create, continue, result, and close');
  assert(releaseUiFlowSubagentSmoke.includes("window.switchRightTab('subagent')") && releaseUiFlowSubagentSmoke.includes("window.openSubagentHistory('release-child')") && releaseUiFlowSubagentSmoke.includes('Subagent history is read-only'), 'release ui Flow/subagent smoke: validates retained read-only subagent history UI');
  assert(packageJson.includes('"release:ui-media-md-smoke"') && releaseUiMediaMdSmoke.includes('--remote-debugging-port=') && releaseUiMediaMdSmoke.includes('window.api.createWorkspace') && releaseUiMediaMdSmoke.includes('addMsg('), 'release ui media/md smoke: drives real packaged renderer without model spend');
  assert(releaseUiMediaMdSmoke.includes('data:image/gif;base64') && releaseUiMediaMdSmoke.includes('.msg-image') && releaseUiMediaMdSmoke.includes('.msg-file-link') && releaseUiMediaMdSmoke.includes('.md-table') && releaseUiMediaMdSmoke.includes('.md-math-inline') && releaseUiMediaMdSmoke.includes('.md-math-block'), 'release ui media/md smoke: validates conversation markdown image, file-link, table, and math rendering');
  assert(releaseUiMediaMdSmoke.includes("window.openFile('media-doc.md')") && releaseUiMediaMdSmoke.includes('#panel-md-viewer') && releaseUiMediaMdSmoke.includes('MD_VIEWER_OK_20260628'), 'release ui media/md smoke: validates markdown viewer rendering');
  assert(releaseUiMediaMdSmoke.includes('#editor-textarea') && releaseUiMediaMdSmoke.includes('EDITOR_LINK_TARGET_OK_20260628') && releaseUiMediaMdSmoke.includes("window.switchRightTab('file-tree')"), 'release ui media/md smoke: validates linked file editor and file tree');
  assert(releaseUiMediaMdSmoke.includes('Page.captureScreenshot') && releaseUiMediaMdSmoke.includes('2026-06-28-release-ui-media-md-smoke.png'), 'release ui media/md smoke: captures visual evidence');
  assert(packageJson.includes('"release:ui-skills-smoke"') && releaseUiSkillsSmoke.includes('--remote-debugging-port=') && releaseUiSkillsSmoke.includes("window.showPluginList('market')") && releaseUiSkillsSmoke.includes('#skill-market-search'), 'release ui skills smoke: drives real packaged Plugins Skills Market through CDP');
  assert(releaseUiSkillsSmoke.includes('installLocalSkill') && releaseUiSkillsSmoke.includes('release-ui-local-skill') && releaseUiSkillsSmoke.includes('window.refreshSkillsRuntime'), 'release ui skills smoke: installs local skill and refreshes runtime without restart');
  assert(releaseUiSkillsSmoke.includes("window.toggleSkillEnabled('release-ui-local-skill', false)") && releaseUiSkillsSmoke.includes("window.toggleSkillEnabled('release-ui-local-skill', true)") && releaseUiSkillsSmoke.includes("window.removeSkillFromUi('release-ui-local-skill')"), 'release ui skills smoke: covers skill disable, enable, and remove');
  assert(releaseUiSkillsSmoke.includes('No matching skills.') && releaseUiSkillsSmoke.includes('Page.captureScreenshot') && releaseUiSkillsSmoke.includes('2026-06-28-release-ui-skills-smoke.png'), 'release ui skills smoke: covers market search empty state and screenshot evidence');
  assert(packageJson.includes('"release:ui-memory-lab-smoke"') && releaseUiMemoryLabSmoke.includes('--remote-debugging-port=') && releaseUiMemoryLabSmoke.includes('window.api.memoryLabUpdate') && releaseUiMemoryLabSmoke.includes('window.showMemoryLab()'), 'release ui Memory Lab smoke: drives real packaged Memory Lab UI through CDP');
  assert(releaseUiMemoryLabSmoke.includes('ReleaseMemoryNeedle') && releaseUiMemoryLabSmoke.includes('Memory Lab') && releaseUiMemoryLabSmoke.includes('.memory-lab-graph') && releaseUiMemoryLabSmoke.includes('memory-lab-search-input') && releaseUiMemoryLabSmoke.includes('Root tags') && releaseUiMemoryLabSmoke.includes('!document.querySelector(\'.memory-lab-links\')') && releaseUiMemoryLabSmoke.includes('animate-from-right') && releaseUiMemoryLabSmoke.includes('Page.captureScreenshot') && releaseUiMemoryLabSmoke.includes('captureOsScreenshot'), 'release ui Memory Lab smoke: validates animated no-line tag graph, root tag overview, tag search, component markdown, and hardened screenshot evidence');
  assert(packageJson.includes('"release:ui-conversation-queue-plan-smoke"') && releaseUiConversationQueuePlanSmoke.includes('--remote-debugging-port=') && releaseUiConversationQueuePlanSmoke.includes('QUEUE_FIRST_LOCK_TEST') && releaseUiConversationQueuePlanSmoke.includes('QUEUE_SECOND_AUTO_BUILD'), 'release ui conversation queue/plan smoke: drives real packaged queued conversation path through CDP');
  assert(releaseUiConversationQueuePlanSmoke.includes("window.switchRightTab('plan')") && releaseUiConversationQueuePlanSmoke.includes('PLAN_ITEM_CONV1_20260628') && releaseUiConversationQueuePlanSmoke.includes('PLAN_ITEM_CONV2_20260628'), 'release ui conversation queue/plan smoke: covers right sidebar plan isolation');
  assert(releaseUiConversationQueuePlanSmoke.includes('PARALLEL_CONV_A_20260701') && releaseUiConversationQueuePlanSmoke.includes('PARALLEL_CONV_B_20260701') && releaseUiConversationQueuePlanSmoke.includes('#queue-panel') && releaseUiConversationQueuePlanSmoke.includes('#queue-header-label') && releaseUiConversationQueuePlanSmoke.includes('QUEUE_SECOND_DONE_20260628'), 'release ui conversation queue/plan smoke: covers parallel conversation execution and same-conversation queue drain');
  assert(uiHtml.includes('state.queueCollapsed = false') && !uiHtml.includes("addMsg('user', '[Next queued] ' + text") && releaseUiConversationQueuePlanSmoke.includes("#queue-list .queue-edit") && releaseUiConversationQueuePlanSmoke.includes("!chat.includes('[Next queued] QUEUE_SECOND_AUTO_BUILD')"), 'release ui conversation queue/plan smoke: verifies queued input stays in the bottom editable queue instead of the chat stream');
  assert(releaseUiConversationQueuePlanSmoke.includes('background conversation A live text events cached while B is foreground') && releaseUiConversationQueuePlanSmoke.includes('foreground conversation B shows its own live text without A leakage') && releaseUiConversationQueuePlanSmoke.includes('background conversation A live feedback replayed when opened') && releaseUiConversationQueuePlanSmoke.includes('LONG_PARALLEL_CONV_A_STREAM_MID_20260701') && releaseUiConversationQueuePlanSmoke.includes('LONG_PARALLEL_CONV_B_STREAM_MID_20260701'), 'release ui conversation queue/plan smoke: verifies live feedback is bound to the owning conversation while another conversation is foregrounded');
  assert(releaseUiConversationQueuePlanSmoke.includes('Page.captureScreenshot') && releaseUiConversationQueuePlanSmoke.includes('2026-06-28-release-ui-conversation-queue-plan-smoke.png'), 'release ui conversation queue/plan smoke: captures visual evidence');
  assert(packageJson.includes('"release:ui-fast-conversation-switch-smoke"') && releaseUiFastConversationSwitchSmoke.includes('--remote-debugging-port=') && releaseUiFastConversationSwitchSmoke.includes('FAST_SWITCH_CONV_A_PROMPT_20260704') && releaseUiFastConversationSwitchSmoke.includes('FAST_SWITCH_CONV_B_REPLY_20260704'), 'release ui fast conversation switch smoke: drives real packaged A/B conversation markers through CDP');
  assert(releaseUiFastConversationSwitchSmoke.includes("document.querySelector('#chat-area')") && releaseUiFastConversationSwitchSmoke.includes("!body.includes") && !releaseUiFastConversationSwitchSmoke.includes('document.body.innerText.includes'), 'release ui fast conversation switch smoke: leakage checks are scoped to the visible chat area, not sidebar/global body text');
  assert(releaseUiFastConversationSwitchSmoke.includes('for (let i = 0; i < 20; i++)') && releaseUiFastConversationSwitchSmoke.includes('rapid switch-back visual isolation ok') && releaseUiFastConversationSwitchSmoke.includes('#conversation-list .conv-item.active'), 'release ui fast conversation switch smoke: repeatedly switches A/B/A/B and verifies single active conversation item');
  assert(releaseUiFastConversationSwitchSmoke.includes('2026-07-04-release-ui-fast-conversation-switch-a.png') && releaseUiFastConversationSwitchSmoke.includes('2026-07-04-release-ui-fast-conversation-switch-b.png') && releaseUiFastConversationSwitchSmoke.includes('assertPngScreenshot'), 'release ui fast conversation switch smoke: captures nonblank visual evidence for both final conversations');
  assert(packageJson.includes('"release:ui-workspace-conversation-isolation-smoke"') && releaseUiWorkspaceConversationIsolationSmoke.includes('--remote-debugging-port=') && releaseUiWorkspaceConversationIsolationSmoke.includes('WS_ALPHA_CONV_PROMPT_20260705') && releaseUiWorkspaceConversationIsolationSmoke.includes('WS_BETA_CONV_REPLY_20260705'), 'release ui workspace/conversation isolation smoke: drives real packaged workspace A/B markers through CDP');
  assert(releaseUiWorkspaceConversationIsolationSmoke.includes('window.api.getState(${js(conversationId)})') && releaseUiWorkspaceConversationIsolationSmoke.includes('#conversation-list .conv-item.active') && releaseUiWorkspaceConversationIsolationSmoke.includes('rapid workspace switch') && releaseUiWorkspaceConversationIsolationSmoke.includes('!body.includes'), 'release ui workspace/conversation isolation smoke: repeatedly switches workspaces and verifies scoped conversation snapshots without visible leakage');
  assert(releaseUiWorkspaceConversationIsolationSmoke.includes('2026-07-05-release-ui-workspace-conversation-isolation-alpha.png') && releaseUiWorkspaceConversationIsolationSmoke.includes('2026-07-05-release-ui-workspace-conversation-isolation-beta.png') && releaseUiWorkspaceConversationIsolationSmoke.includes('screenshot appears blank or truncated'), 'release ui workspace/conversation isolation smoke: captures nonblank visual evidence for both final workspaces');
  assert(packageJson.includes('"release:ui-multi-window-shared-backend-smoke"') && releaseUiMultiWindowSharedBackendSmoke.includes('waitForTargets(port, 2)') && releaseUiMultiWindowSharedBackendSmoke.includes('const firstTargetId = targets[0].id') && releaseUiMultiWindowSharedBackendSmoke.includes('secondTarget.id === firstTargetId') && releaseUiMultiWindowSharedBackendSmoke.includes('multi-window-shared-backend'), 'release ui multi-window shared-backend smoke: launches a second packaged window through single-instance routing and targets a distinct renderer');
  assert(releaseUiMultiWindowSharedBackendSmoke.includes("processJson.main !== 1") && releaseUiMultiWindowSharedBackendSmoke.includes('cdpTargets=') && releaseUiMultiWindowSharedBackendSmoke.includes('expected one Electron main/backend process'), 'release ui multi-window shared-backend smoke: verifies one backend main process and multiple CDP renderer targets');
  assert(releaseUiMultiWindowSharedBackendSmoke.includes("activeSummaryExpression('default')") && releaseUiMultiWindowSharedBackendSmoke.includes('activeSummaryExpression(convA)') && releaseUiMultiWindowSharedBackendSmoke.includes('activeSummaryExpression(convB)'), 'release ui multi-window shared-backend smoke: verifies window A and B active conversations do not overwrite each other');
  assert(packageJson.includes('"release:ui-goal-continuation-smoke"') && releaseUiGoalContinuationSmoke.includes('RELEASE_UI_GOAL_CONTINUATION') && releaseUiGoalContinuationSmoke.includes('mock.getGoalCalls() < 3'), 'release ui goal continuation smoke: covers repeated autonomous Goal model calls');
  assert(releaseUiGoalContinuationSmoke.includes('max[- ]?depth') && releaseUiGoalContinuationSmoke.includes('2026-06-28-release-ui-goal-continuation-smoke.png'), 'release ui goal continuation smoke: rejects max-depth warnings and captures visual evidence');
  assert(packageJson.includes('"release:ui-workspace-lifecycle-smoke"') && releaseUiWorkspaceLifecycleSmoke.includes("window.api.createWorkspace('lifecycle-alpha')") && releaseUiWorkspaceLifecycleSmoke.includes("window.api.selectWorkspace('lifecycle-beta')"), 'release ui workspace lifecycle smoke: covers internal workspace create and switch');
  assert(releaseUiWorkspaceLifecycleSmoke.includes("window.api.deleteWorkspace('lifecycle-alpha')") && releaseUiWorkspaceLifecycleSmoke.includes('Local.json still contains deleted workspace') && releaseUiWorkspaceLifecycleSmoke.includes('deleted internal workspace directory still exists'), 'release ui workspace lifecycle smoke: covers internal workspace deletion registry and directory');
  assert(releaseUiWorkspaceLifecycleSmoke.includes('clearTimeout(callbacks.timer)') && releaseUiWorkspaceLifecycleSmoke.includes('Promise.resolve(window.openWorkspaceManager()).then(() => true)'), 'release ui workspace lifecycle smoke: cleans CDP timers and awaits async workspace manager refresh');
  assert(packageJson.includes('"release:ui-startup-recovery-smoke"') && releaseUiStartupRecoverySmoke.includes('--remote-debugging-port=') && releaseUiStartupRecoverySmoke.includes('NewmarkReleaseStartupRecovery-'), 'release ui startup recovery smoke: drives real packaged startup through CDP with a fresh root');
  assert(releaseUiStartupRecoverySmoke.includes("['skills', 'Work', 'Flow', 'archive', 'config.json', 'agent.md', 'PC_Hash.config']") && releaseUiStartupRecoverySmoke.includes("path.join('Flow', 'Flow.md')") && releaseUiStartupRecoverySmoke.includes("path.join('Work', 'State.json')"), 'release ui startup recovery smoke: verifies required companion files');
  assert(releaseUiStartupRecoverySmoke.includes('auto_create_timestamp_workspace') && releaseUiStartupRecoverySmoke.includes('Local.json did not contain one default internal workspace') && releaseUiStartupRecoverySmoke.includes('default workspace is not timestamp-like'), 'release ui startup recovery smoke: verifies default timestamp internal workspace');
  assert(releaseUiStartupRecoverySmoke.includes('window.api.getState()') && releaseUiStartupRecoverySmoke.includes('Page.captureScreenshot') && releaseUiStartupRecoverySmoke.includes('2026-06-28-release-ui-startup-recovery-smoke.png'), 'release ui startup recovery smoke: verifies renderer state and captures visual evidence');
  assert(fs.existsSync(path.join(process.cwd(), 'config.example.json')) && packageJson.includes('"config.example.json"') && distPortableScript.includes("app.asar missing config.example.json"), 'config recovery: config.example.json exists in source and is required in packaged app.asar');
  const configExampleText = fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8');
  assert(configExampleText.includes('ExampleOpenAICompatible') && configExampleText.includes('"api_key": ""') && !/sk-[A-Za-z0-9]{20,}/.test(configExampleText), 'config recovery: example config contains no real provider key');
  assert(packageJson.includes('"release:real-provider-smoke"') && releaseRealProviderSmoke.includes('NEWMARK_APINEBULA_KEY') && releaseRealProviderSmoke.includes('REAL_PROVIDER_CLI_OK_20260627') && releaseRealProviderSmoke.includes('REAL_PROVIDER_UI_OK_20260627'), 'release real provider smoke: opt-in APInebula CLI and UI path exists');
  assert(releaseRealProviderSmoke.includes('real-provider UI idle after marker') && releaseRealProviderSmoke.includes("state.status !== 'idle'"), 'release real provider smoke: waits for UI idle after visible marker');
  assert(releaseRealProviderSmoke.includes('function waitForAssistantMarker') && releaseRealProviderSmoke.includes('assistantMarkerStatsExpression') && releaseRealProviderSmoke.includes('backendAssistantTexts') && releaseRealProviderSmoke.includes('duplicated assistant marker count'), 'release real provider smoke: UI marker validation is assistant-scoped, duplicate-aware, and debuggable');
  assert(releaseRealProviderSmoke.includes('NEWMARK_REAL_UTF8') && releaseRealProviderSmoke.includes('真实UTF8_CLI_通过') && releaseRealProviderSmoke.includes('真实UTF8_UI_通过'), 'release real provider smoke: has opt-in real UTF-8 CLI and UI checks');
  assert(releaseRealProviderSmoke.includes('NEWMARK_REAL_INCLUDE_CLAUDE_ENV') && releaseRealProviderSmoke.includes('NEWMARK_REAL_CLAUDE_ENV_FILE') && releaseRealProviderSmoke.includes('Claude env fuzzy-inject skipped'), 'release real provider smoke: Claude env injection is explicit opt-in');
  assert(releaseRealProviderSmoke.includes('sanitize(error.message)') && releaseRealProviderSmoke.includes('renderer state leaked API key') && releaseRealProviderSmoke.includes('validate-models leaked API key'), 'release real provider smoke: redacts and guards API keys');
  assert(packageJson.includes('"release:real-apinebula-memory-switch-smoke"') && releaseRealApiNebulaMemorySwitchSmoke.includes('NEWMARK_APINEBULA_KEY') && releaseRealApiNebulaMemorySwitchSmoke.includes('memory_lab_read') && releaseRealApiNebulaMemorySwitchSmoke.includes('memory_lab_update'), 'release real APInebula Memory Lab/model-switch smoke: npm entry and tool-use prompts exist');
  assert(releaseRealApiNebulaMemorySwitchSmoke.includes('REAL_APINEBULA_MEMORY_CREATE_OK_20260701') && releaseRealApiNebulaMemorySwitchSmoke.includes('REAL_APINEBULA_MODEL_SWITCH_OK_20260701') && releaseRealApiNebulaMemorySwitchSmoke.includes('findConversationAssistantModel'), 'release real APInebula Memory Lab/model-switch smoke: validates memory creation and persisted fallback model');
  assert(releaseRealApiNebulaMemorySwitchSmoke.includes('validate-models') && releaseRealApiNebulaMemorySwitchSmoke.includes('release smoke pre-marked unavailable') && releaseRealApiNebulaMemorySwitchSmoke.includes('fallback_on_unavailable: true'), 'release real APInebula Memory Lab/model-switch smoke: validates selected real model and unavailable-model switching');
  assert(releaseRealApiNebulaMemorySwitchSmoke.includes('sanitize(error.message)') && releaseRealApiNebulaMemorySwitchSmoke.includes('leaked API key') && releaseRealApiNebulaMemorySwitchSmoke.includes('set NEWMARK_APINEBULA_KEY or NEWMARK_REAL_API_KEY'), 'release real APInebula Memory Lab/model-switch smoke: redacts secrets and has explicit skip path');
  assert(packageJson.includes('"release:real-provider-stress"') && releaseRealProviderStress.includes('NEWMARK_REAL_STRESS_BASE_URL') && releaseRealProviderStress.includes('NEWMARK_REAL_STRESS_KEY') && releaseRealProviderStress.includes('ANTHROPIC_AUTH_TOKEN'), 'release real provider stress: npm entry and credential fallback exist');
  assert(releaseRealProviderStress.includes('cliRounds') && releaseRealProviderStress.includes('uiRounds') && releaseRealProviderStress.includes('goalRounds') && releaseRealProviderStress.includes('timeoutMs'), 'release real provider stress: configurable rounds and timeout exist');
  assert(releaseRealProviderStress.includes('runCliStress') && releaseRealProviderStress.includes('runUiStress') && releaseRealProviderStress.includes('runGoalStress') && releaseRealProviderStress.includes('runQueueStress') && releaseRealProviderStress.includes('runConversationIsolationStress') && releaseRealProviderStress.includes('runLongContextStress'), 'release real provider stress: covers CLI UI Goal queue conversation-isolation and long-context scenarios');
  assert(releaseRealProviderStress.includes("window.setInputMode ? window.setInputMode('guide')") && releaseRealProviderStress.includes('queued prompt visible') && releaseRealProviderStress.includes('queued prompt drained through UI') && releaseRealProviderStress.includes('__realProviderQueueStressDebug'), 'release real provider stress: queue drain uses real UI input queue and records debug state');
  assert(releaseRealProviderStress.includes('conversation-isolation') && releaseRealProviderStress.includes('conversation histories isolated') && releaseRealProviderStress.includes('state leaked B marker') && releaseRealProviderStress.includes('state leaked A marker'), 'release real provider stress: verifies conversation histories do not leak across real-provider conversations');
  assert(releaseRealProviderStress.includes('tokens: sendA && sendA.tokens') && releaseRealProviderStress.includes('chatMessages: sendB && sendB.chatMessages'), 'release real provider stress: conversation response leak checks ignore cross-conversation title lists');
  assert(releaseRealProviderStress.includes('assistantMarkerExpression') && !releaseRealProviderStress.includes("document.body.innerText || '').includes"), 'release real provider stress: UI marker checks use assistant backend messages instead of echoed prompts');
  assert(releaseRealProviderStress.includes('release-process-cleanup') && releaseRealProviderStress.includes('renderer state leaked API key') && releaseRealProviderStress.includes('未执行真实重压：缺少凭据') && releaseRealProviderStress.includes('real-provider-stress-debug.md'), 'release real provider stress: records cleanup, secret guards, skip path, and archive report');
  assert(!releaseRealProviderStress.includes('baseUrlHost'), 'release real provider stress: report omits provider host/private URL');
  assert(releaseRealProviderStress.includes('clearTimeout(callbacks.timer)'), 'release real provider stress: clears CDP timeout handles after responses');
  assert(cliCommandsTs.includes("args.includes('--preview-only')") && cliCommandsTs.includes('preview: true') && cliCommandsTs.includes('has_api_key') && cliCommandsTs.includes('redactUrlSecret'), 'cli commands: fuzzy-inject preview-only redacts and avoids provider calls');
  assert(packageJson.includes('"release:real-claude-env-preview-smoke"') && releaseRealClaudeEnvPreviewSmoke.includes('NEWMARK_REAL_CLAUDE_ENV_FILE') && releaseRealClaudeEnvPreviewSmoke.includes('--preview-only'), 'release real Claude env preview smoke: uses explicit env file in preview-only mode');
  assert(releaseRealClaudeEnvPreviewSmoke.includes('DeepSeekAnthropic') && releaseRealClaudeEnvPreviewSmoke.includes('deepseek-v4-pro[1m]') && releaseRealClaudeEnvPreviewSmoke.includes('deepseek-v4-flash') && releaseRealClaudeEnvPreviewSmoke.includes('preview leaked Claude env API key/token'), 'release real Claude env preview smoke: validates DeepSeek env parsing without leaking secrets');
  assert(distPortableScript.includes('verifyReleaseCliSmoke()') && distPortableScript.includes('release-cli-smoke.cjs'), 'dist portable: runs release CLI smoke after packaging');
  assert(distPortableScript.includes('win-unpacked-x64.zip') && distPortableScript.includes('Compress-Archive') && distPortableScript.includes('verifyZipPack()'), 'dist portable: creates and verifies compiled win-unpacked zip pack');
  assert(installUpdateTs.includes('writeDeferredWindowsUpdate') && installUpdateTs.includes('runningExecutableTarget(target)') && installUpdateTs.includes('deferred: true') && installUpdateTs.includes('Wait-Process -Id $pidToWait') && installUpdateTs.includes('Start-Process -FilePath "powershell.exe"') && installUpdateTs.includes("spawn('powershell.exe'"), 'install update: Windows self-update defers copying the running executable until the current process exits');
  assert(mainTs.includes('if (automationWakeMode)') && mainTs.includes('await automation.tick()') && mainTs.includes('app.quit();') && mainTs.indexOf('if (automationWakeMode)') < mainTs.indexOf('void startSidecar(root)'), 'main automation wake: runs due schedules headless and exits before sidecar/window setup');
  assert(mainTs.includes('const syncAutomationWakeSoon = () =>') && mainTs.includes('syncAutomationWakeSoon();') && mainTs.indexOf('mainWindow = createDesktopWindow(false)') < mainTs.indexOf("app.on('will-quit'"), 'main startup: desktop window is created before noncritical automation wake sync can block startup');
  assert(automationWakeTs.includes('timeout: 5000') && automationWakeTs.includes('result.error?.message'), 'automation wake: Windows Task Scheduler calls are timeout-bounded so first desktop launch cannot hang indefinitely');
  assert(preloadTs.includes("refreshSkills: () => ipcRenderer.invoke('skills:refresh')") && preloadTs.includes("marketSkillSources: () => ipcRenderer.invoke('skills:marketSources')") && preloadTs.includes("memoryLabRead: (selector?: string) => ipcRenderer.invoke('memoryLab:read'") && preloadTs.includes('updateCheckGithub') && preloadTs.includes('updateApplyGithub') && preloadTs.includes('terminalKill: (sessionId: string, timeoutMs?: number)'), 'preload: exposes skills refresh, market source management, Memory Lab, updates, and terminal kill timeout');
  assert(preloadTs.includes("terminalTakeoverState: () => ipcRenderer.invoke('agentTerminal:takeoverState')") && preloadTs.includes("terminalTakeoverWrite: (sessionId: string, data: string) => ipcRenderer.invoke('agentTerminal:takeoverWrite'") && preloadTs.includes('onTerminalTakeover'), 'preload: exposes independent Agent terminal takeover IPC');
  assert(preloadTs.includes("githubCopilotLogin: () => ipcRenderer.invoke('github:copilotLogin')"), 'preload: exposes GitHub Copilot browser login bridge');
  assert(preloadTs.includes('webUtils') && preloadTs.includes('filePathForFile') && uiHtml.includes('function promptInsertText(text)') && uiHtml.includes('function clipboardFilePaths(dataTransfer)') && uiHtml.includes('function imageFilesFromDataTransfer(dataTransfer)') && uiHtml.includes('function attachPromptImagesFromDataTransfer(dataTransfer)') && uiHtml.includes('id="prompt-attachments"') && uiHtml.includes("els.prompt.addEventListener('paste'") && uiHtml.includes("els.prompt.addEventListener('drop'") && uiHtml.includes("paths.join('\\n')") && uiHtml.includes('composePromptTextForSend(rawText)'), 'ui html/preload: pasted or dropped files insert filesystem paths, and rootless pasted images render as prompt attachments');
  assert(preloadTs.includes('saveConfig: (cfg: string | Record<string, unknown>)'), 'preload: saveConfig accepts structured config patches');
  assert(preloadTs.includes("getConversationPlan: (conversationId?: string) => ipcRenderer.invoke('agent:getConversationPlan', conversationId)") && preloadTs.includes("updateConversationPlan: (plan: Record<string, unknown>, conversationId?: string) => ipcRenderer.invoke('agent:updateConversationPlan', plan, conversationId)"), 'preload: exposes conversation-bound plan IPC');
  assert(mainTs.includes("language: agent.config.getStr('general', 'language')") && mainTs.includes("case 'language': agent.config.set('general', 'language', value); break;"), 'main ipc: exposes and persists language setting');
  assert(serverTs.includes("language: agent.config.getStr('general', 'language')") && serverTs.includes("case 'language': agent.config.set('general', 'language', value); break;"), 'server api: exposes and persists language setting');
  assert(cliCommandsTs.includes("language: agent.config.getStr('general', 'language') || 'auto'") && cliCommandsTs.includes("const language = argValue(args, '--language')") && cliCommandsTs.includes("[--language auto|en|zh]"), 'cli commands: expose and accept language switching');
  assert(mainTs.includes('sanitizeProvidersForState(agent.config.providers())') && mainTs.includes('mergeProviderSecrets(value, agent.config.providers())'), 'main ipc: redacts provider keys and preserves secrets on provider save');
  assert(serverTs.includes('sanitizeProvidersForState(agent.config.providers())') && serverTs.includes('mergeProviderSecrets(value, agent.config.providers())'), 'server api: redacts provider keys and preserves secrets on provider save');
  assert(mainTs.includes("ipcMain.handle('skills:refresh'") && mainTs.includes('agent.refreshSkills();') && mainTs.includes("ipcMain.handle('skills:addMarketSource'") && mainTs.includes("ipcMain.handle('memoryLab:read'") && mainTs.includes('agent.updateMemoryLab') && mainTs.includes('agent.reindexMemoryLab') && mainTs.includes('terminalInterruptTimeoutMs'), 'main ipc: refreshes skills runtime, manages market sources and Memory Lab through Agent organizer, and returns terminal timeout state');
  assert(mainTs.includes("ipcMain.handle('agent:getConversationPlan', async (_event, conversationId?: string)") && mainTs.includes("ipcMain.handle('agent:updateConversationPlan', async (_event, plan: Record<string, unknown>, conversationId?: string)") && mainTs.includes('conversationPlan: agent.getConversationPlan()'), 'main ipc: exposes and returns conversation-bound plan state');
  assert(mainTs.includes("ipcMain.handle('flow:run'") && mainTs.includes('chatMessages: agent.chatMessages') && mainTs.includes('conversations: agent.listConversationStates()'), 'main ipc: Flow run returns rendered conversation state');
  assert(mainTs.includes("ipcMain.handle('pty:kill'") && mainTs.includes('waitMs === 0') && mainTs.includes("session.proc.kill('SIGINT')"), 'main ipc: terminal interrupt timeout supports unlimited mode');
  assert(mainTs.includes("ipcMain.handle('agentTerminal:takeoverState'") && mainTs.includes("ipcMain.handle('agentTerminal:takeoverWrite'") && mainTs.includes("webContents.send('agentTerminal:takeover'"), 'main ipc: broadcasts Agent terminal takeover state to bottom terminal UI');
  assert(mainTs.includes('function defaultTerminalShell()') && mainTs.includes("process.platform === 'win32' ? 'powershell' : 'bash'") && mainTs.includes('function resolveTerminalShell') && mainTs.includes('commandArgs: command => [\'-lc\', command]') && mainTs.includes('function availableTerminalShells()') && mainTs.includes('terminalShells: availableTerminalShells()') && mainTs.includes('runShellCommand(String(cmd || \'\')') && !mainTs.includes('const SHELL_MAP: Record<string, string>'), 'main ipc: built-in terminal and executeBash use platform-aware shell defaults instead of hard-coded Windows shells');
  assert(serverTs.includes('function runShellCommand') && serverTs.includes("process.platform === 'win32' ? 'powershell' : 'bash'") && serverTs.includes("String(command || cmd || '')") && serverTs.includes('terminalShells: availableTerminalShells()') && serverTs.includes("requested === 'sh' ? ['-c', command]") && !serverTs.includes('powershell.exe -Command "${(cmd||\'\')'), 'server api: bash endpoint is platform-aware and accepts command/cmd payloads');
  assert(uiHtml.includes('function normalizeTerminalShell(shellId)') && uiHtml.includes('function syncTerminalShellOptions()') && uiHtml.includes("spawnTerminal(normalizeTerminalShell(state._terminalShell))") && !uiHtml.includes("spawnTerminal('powershell')") && uiHtml.includes('data-platform-shell="win32"'), 'ui html: bottom terminal defaults to backend platform shell instead of hard-coded PowerShell');
  assert(mainTs.includes("ipcMain.handle('github:copilotLogin'") && mainTs.includes("'auth', 'status'") && mainTs.includes("const tokenFromGh = () =>") && mainTs.includes("const importToken = (token: string") && mainTs.includes("'auth', 'refresh', '--scopes', 'models:read'") && !mainTs.includes("'auth', 'refresh', '--web', '--scopes', 'models:read'") && mainTs.includes("'auth', 'login', '--web', '--scopes', 'models:read'") && mainTs.includes("shell.openExternal('https://github.com/login/device')") && mainTs.includes("currentAgent.config.upsertProvider('GitHub Copilot', 'https://models.github.ai'") && mainTs.includes("protocol === 'openai' ? 'openai' : undefined"), 'main ipc: GitHub Copilot login imports GitHub CLI token, uses refresh without unsupported --web, falls back to browser login, and fuzzy injection remains openai/anthropic only');
  assert(mainTs.includes('agent.subagents.listAll().map') && mainTs.includes("active: s.status !== 'closed'") && uiHtml.includes("t('subagent.empty')"), 'main ipc/ui: closed subagents remain visible as retained history');
  assert(toolsTs.includes('timeout_ms') && toolsTs.includes('resolveBashTimeout') && toolsTs.includes("this.config.getNum('terminal', 'interrupt_timeout_ms')"), 'tools: agent bash accepts per-call timeout and reads config cap');
  assert(toolsTs.includes("t('terminal_takeover'") && toolsTs.includes('runTerminalTakeover') && toolsTs.includes("tool === 'terminal_takeover' && g('action') === 'write'"), 'tools: terminal_takeover is an independent persistent shell tool with bash-grade command permission checks');
  assert(toolsTs.includes("t('computer_use'") && toolsTs.includes("'app_observe'") && toolsTs.includes("'takeover_start'") && toolsTs.includes('app_target') && toolsTs.includes('window_handle') && toolsTs.includes("'scroll'") && toolsTs.includes('scroll_x') && toolsTs.includes('runComputerUse') && toolsTs.includes('allowEphemeralVisionImage') && toolsTs.includes("invocation?: 'agent' | 'cli'") && toolsTs.includes('invocation: context.invocation') && cliCommandsTs.includes("invocation: 'cli'") && toolsTs.includes('conversationId?: string') && toolsTs.includes('COMPUTER_USE_LOCK_TTL_MS') && toolsTs.includes('computerUseOwner(context, wsPath)') && toolsTs.includes('ComputerUse is already active') && toolsTs.includes('releaseComputerUseLock(action, owner)') && agentKernelRunnerTs.includes("conversationId: agent.activeConversationId || 'default'") && !toolsTs.includes('archive/computer-use') && agentTs.includes('observe -> decide -> act -> observe') && agentTs.includes('takeover_start') && agentTs.includes('app_list/app_observe/app_*'), 'tools/agent prompt: exposes native Computer Use observe/action loop, takeover border, app scoping, single-conversation lock, and ephemeral-only screenshot handling');
  const computerUseTs = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'computerUse.ts'), 'utf-8');
  assert(computerUseTs.includes('System.Windows.Forms') && computerUseTs.includes('CopyFromScreen') && computerUseTs.includes('SetCursorPos') && computerUseTs.includes('UIAutomationClient') && computerUseTs.includes('BoundingRectangle') && computerUseTs.includes('vision_assist') && computerUseTs.includes('target_id') && computerUseTs.includes('stable_key') && computerUseTs.includes('high_priority_objects') && computerUseTs.includes('intersectionOverUnion') && computerUseTs.includes('normalized_bbox') && computerUseTs.includes('allowed_actions') && computerUseTs.includes('scrollAt') && computerUseTs.includes('startTakeoverOverlay') && computerUseTs.includes('lastTakeoverOverlayStyle') && computerUseTs.includes('colors: options.gradientColors || options.gradient_colors') && computerUseTs.includes('speed: options.gradientSpeed ?? options.gradient_speed') && computerUseTs.includes('width: options.gradientWidth ?? options.gradient_width') && computerUseTs.includes("options.invocation === 'cli' && durationMs > 0 ? 0 : process.pid") && computerUseTs.includes("const lifecycle = ownerPid > 0 ? 'owner-process-bound' : 'duration-bound'") && computerUseTs.includes('desktop-edge-dynamic-gradient') && computerUseTs.includes('single-click-through-virtual-screen-overlay') && computerUseTs.includes('WS_EX_TRANSPARENT') && !computerUseTs.includes('WS_EX_LAYERED') && !computerUseTs.includes('TransparencyKey') && computerUseTs.includes('public class NewmarkOverlayForm : Form') && computerUseTs.includes('this.DoubleBuffered = true') && computerUseTs.includes('ControlStyles.Opaque') && computerUseTs.includes('OnPaintBackground(PaintEventArgs e)') && computerUseTs.includes('Add-Type -ReferencedAssemblies @("System.Windows.Forms", "System.Drawing") -TypeDefinition') && computerUseTs.includes('$frame = New-Object System.Drawing.Bitmap($w, $h)') && computerUseTs.includes('$target.DrawImageUnscaled($frame, 0, 0)') && computerUseTs.includes('New-Object System.Drawing.Drawing2D.GraphicsPath') && computerUseTs.includes('$regionPath.FillMode = [System.Drawing.Drawing2D.FillMode]::Winding') && computerUseTs.includes('[System.Drawing.Rectangle]::new($bounds.Left, $bounds.Top, $bounds.Width, $bounds.Height)') && computerUseTs.includes('$regionPath.AddRectangle([System.Drawing.Rectangle]::new') && computerUseTs.includes('$script:form.Region = New-Object System.Drawing.Region($regionPath)') && computerUseTs.includes('function Newmark-LerpColor') && computerUseTs.includes('function Newmark-ClockwiseBorderColor') && computerUseTs.includes('$perimeter = [Math]::Max(1.0, (2.0 * $w) + (2.0 * $h))') && computerUseTs.includes('$clockwiseOffset = (($script:stopwatch.Elapsed.TotalSeconds / $speedSeconds) * $perimeter) % $perimeter') && computerUseTs.includes('$wrappedDistance = ($distance - $clockwiseOffset) % $perimeter') && computerUseTs.includes('$segment = [Math]::Min($step, $perimeter - $distance)') && computerUseTs.includes('for ($distance = 0.0; $distance -lt $perimeter; $distance += $step)') && computerUseTs.includes('if ($distance -lt $w)') && computerUseTs.includes('elseif ($distance -lt ($w + $h))') && computerUseTs.includes('elseif ($distance -lt ((2.0 * $w) + $h))') && computerUseTs.includes('$ownerTimer = New-Object System.Windows.Forms.Timer') && computerUseTs.includes('Get-Process -Id $script:ownerPid') && computerUseTs.includes('overlay process exited during startup') && computerUseTs.includes("Get-Process -Id ${pid}") && computerUseTs.includes('lifecycle') && computerUseTs.includes('$overlayPattern =') && computerUseTs.includes('takeover-overlay-') && computerUseTs.includes('$_.CommandLine -match $overlayPattern') && computerUseTs.includes('$_.ProcessId -ne $selfPid') && computerUseTs.includes('$g.FillRectangle($brush') && !computerUseTs.includes('$script:phase = ($script:phase + 1)') && computerUseTs.includes('[System.Drawing.Color]::FromArgb') && computerUseTs.includes('SetWindowPos($script:form.Handle') && computerUseTs.includes("([wmiclass]'Win32_Process').Create") && !computerUseTs.includes('Start-Process -FilePath powershell.exe') && computerUseTs.includes('observeAppWindows') && computerUseTs.includes('app_observe') && computerUseTs.includes('app_click') && computerUseTs.includes('NativeWindow') && computerUseTs.includes('tempScreenshotDir') && computerUseTs.includes('screenshot_retention') && computerUseTs.includes('ephemeral-deleted-before-tool-return') && computerUseTs.includes('fs.unlinkSync(outPath)') && toolsTs.includes('gradient_colors) ?') && toolsTs.includes("this.config.get<string[]>('ui', 'gradient_colors')") && toolsTs.includes('gradient_width !== undefined') && toolsTs.includes("this.config.getNum('ui', 'gradient_width')") && !computerUseTs.includes("archive', 'computer-use") && !computerUseTs.includes('github.com/gtt116/enikk') && !computerUseTs.includes('RapidOCR') && !computerUseTs.includes('ultralytics'), 'computer_use: native Windows screenshot/action/UI Automation implementation uses ephemeral screenshots, region-cut click-through owner-bound double-buffered closed-loop clockwise perimeter takeover indicator, app scoping, CLI-compatible gradient settings, and no copied Enikk detector/OCR code');
  assert(agentKernelRunnerTs.includes('computerUseVisionImagePath') && agentKernelRunnerTs.includes('sanitizeComputerUseToolText') && agentKernelRunnerTs.includes('imagePathToOpenAIContentPart') && agentKernelRunnerTs.includes('fs.unlinkSync(imagePath)') && agentKernelRunnerTs.includes('allowEphemeralVisionImage: name === \'computer_use\'') && providerTs.includes('normalizeOpenAIContent') && providerTs.includes('normalizeAnthropicContent') && providerTs.includes('input_image'), 'computer_use: vision-capable models receive screenshot image input synchronized with UI Automation text and delete the ephemeral image after preparation');
  assert(agentTs.includes('Agent terminal timeout: bash accepts per-call timeout_ms') && agentTs.includes('is a nonzero upper cap'), 'agent prompt: discloses bash timeout_ms and settings cap semantics');
  assert(agentTs.includes('repo_security_audit') && agentTs.includes('Remote repository safety') && agentTs.includes('public/private visibility') && agentTs.includes('private URLs, secrets, local runtime state'), 'agent prompt: proactively drives remote repository security and privacy review');
  assert(agentTs.includes('GitHub Copilot') && agentTs.includes('https://models.github.ai'), 'agent core: GitHub Copilot/Models provider is inferred to the official GitHub Models endpoint');
  assert(providerTs.includes("ProviderProtocol = 'openai' | 'anthropic' | 'github_models'") && providerTs.includes("githubModelsUrl('/inference/chat/completions')") && providerTs.includes("githubModelsUrl('/catalog/models')") && providerTs.includes("'X-GitHub-Api-Version': '2022-11-28'"), 'llm provider: GitHub Copilot/Models uses official GitHub Models inference and catalog APIs');
  assert(configTs.includes("github_models") && configTs.includes("models.github.ai") && configTs.includes('defaultProviderBaseUrl') && cliCommandsTs.includes('--protocol openai|anthropic') && !cliCommandsTs.includes('--protocol openai|anthropic|github_models') && agentTs.includes('GitHub/Copilot providers require precise browser login') && cliCommandsTs.includes('GitHub/Copilot providers require precise browser login') && fuzzyTs.includes("value === 'openai' || value === 'anthropic'"), 'config/cli/core: GitHub Models protocol is normalized/defaulted but excluded from fuzzy-inject');
  assert(uiHtml.includes("t('model.githubModelsCompat')") && uiHtml.includes('value="github_models"') && uiHtml.includes('window.githubCopilotLogin') && uiHtml.includes('window.syncProviderProtocolDefaults') && uiHtml.includes('https://models.github.ai') && uiHtml.includes('id="fuzzy-protocol"><option value="auto">') && uiHtml.includes('<option value="anthropic">') && !uiHtml.includes('id="fuzzy-protocol"><option value="auto"><option value="github_models"') && !uiHtml.includes('id="fuzzy-protocol"><option value="auto">' + '<option value="github_models"') && uiHtml.includes("var protocol = protocolEl && protocolEl.value !== 'auto' ? protocolEl.value : undefined;") && uiHtml.includes('window.applyTerminalTakeoverEvent') && uiHtml.includes('data-takeover-session') && uiHtml.includes('terminal-pane active agent-takeover marquee-border'), 'ui html: exposes GitHub Models exact login while excluding GitHub from fuzzy injection');
  assert(agentTs.includes('refreshSkills(): void') && agentTs.includes('this.skills = new SkillsManager(this.rootPath);'), 'agent core: skills manager can be refreshed without restart');
  assert(agentTs.includes("'- Memory Lab exists and provides persistent memory.'") && !agentTs.includes('Memory Lab stores persistent local memory for Newmark Agent') && agentTs.includes('handleMemoryLabTool') && agentTs.includes('async updateMemoryLab') && agentTs.includes('async reindexMemoryLab'), 'agent core: Memory Lab prompt is only a one-line existence signal and tool gated through Agent organizer');
  assert(cliCommandsTs.includes("command === 'memory-lab'") && cliCommandsTs.includes('await agent.updateMemoryLab') && cliCommandsTs.includes('await agent.reindexMemoryLab'), 'cli commands: memory-lab update and reindex route through Agent organizer');
  assert(cliCommandsTs.includes("command === 'install-update'") && cliCommandsTs.includes('installUpdate({') && cliCommandsTs.includes('--expected-version') && cliCommandsTs.includes('--dry-run'), 'cli commands: install-update supports version-checked preserved-data updates');
  assert(cliCommandsTs.includes('--check-github') && cliCommandsTs.includes('--from-github') && cliCommandsTs.includes('checkGitHubUpdate') && cliCommandsTs.includes('applyGitHubUpdate'), 'cli commands: install-update can check and apply GitHub release zip updates');
  assert(mainTs.includes("ipcMain.handle('update:checkGithub'") && mainTs.includes("ipcMain.handle('update:applyGithub'") && mainTs.includes("ipcMain.handle('update:installLocal'"), 'main ipc: exposes GitHub and local update install APIs');
  assert(workspaceTs.includes('removeInternalDirectory') && workspaceTs.includes('if (!this.removeInternalDirectory(removedWorkspace.path)) return false;') && workspaceTs.includes('clearReadOnlyRecursive'), 'workspace core: internal delete verifies directory removal before returning success');
  assert(workspaceTs.includes('canonicalWorkspacePath(target: string)') && workspaceTs.includes('canonicalRemotePath(target: string)') && workspaceTs.includes('isInsideRoot(target: string)') && workspaceTs.includes('path.relative(root, candidate)') && workspaceTs.includes('findWorkspaceByPath(target: string)') && workspaceTs.includes('findSshWorkspaceByRemotePath(sshConnectionId: string, remotePath: string)') && workspaceTs.includes('dedupeByPath(list: WorkspaceInfo[])') && workspaceTs.includes('const existing = this.findWorkspaceByPath(d)') && workspaceTs.includes('const existing = this.findWorkspaceByPath(resolved)') && workspaceTs.includes('const existing = this.findSshWorkspaceByRemotePath(input.sshConnectionId, remotePath)') && workspaceTs.includes("crypto.createHash('sha256').update(remotePath)"), 'workspace core: prevents duplicate workspaces for the same exact folder path while allowing distinct parent/child paths');
  // ---- 1. Config Manager Tests ----
  console.log('\n📋 Config Manager');
  const cfg = new ConfigManager(TEST_DIR);
  assert(cfg.getStr('agent', 'default_mode') === 'build', 'default_mode = build');
  assert(cfg.getStr('models', 'default_intelligence') === 'medium', 'default_intel = medium');
  assert(cfg.getStr('general', 'tone') === 'strict_simple', 'default tone');
  assert(cfg.getStr('general', 'language') === 'auto', 'default language = auto');
  assert(cfg.getBool('models', 'auto_switch') === false, 'auto_switch disabled');
  assert(cfg.getBool('context', 'auto_compress') === true, 'auto_compress enabled');
  assert(cfg.getStr('ui', 'dark_mode') === 'dark', 'dark_mode default');
  assert(cfg.getNum('agent', 'process_timeout_ms') === 0, 'agent process outer timeout default is unlimited');
  assert(cfg.getNum('agent', 'goal_max_continuations') === 25, 'goal continuation default has a diagnostic limit');
  assert(cfg.getNum('terminal', 'interrupt_timeout_ms') === 0, 'terminal timeout cap default is unlimited');
  assert(Array.isArray(cfg.get('ui', 'gradient_colors')), 'gradient_colors is array');
  assert(cfg.providers().length === 0, 'no providers by default');
  assert(cfg.allModels().length === 0, 'no models');

  // Test set & get
  cfg.set('test-section', 'test-key', 'test-value');
  assert(cfg.getStr('test-section', 'test-key') === 'test-value', 'set/get works');

  // Test provider management
  cfg.upsertProvider('test-prov', 'https://api.test.com/v1', 'test-key-123');
  const providers = cfg.providers();
  assert(providers.length === 1, 'provider added');
  assert(providers[0].name === 'test-prov', 'provider name correct');
  assert(providers[0].base_url === 'https://api.test.com/v1', 'provider url correct');
  assert(providers[0].protocol === 'openai', 'provider protocol defaults to openai');
  cfg.upsertProvider('test-prov', '', '');
  assert(cfg.providers().find(p => p.name === 'test-prov')?.api_key === 'test-key-123', 'provider upsert: empty key preserves saved key');
  assert(cfg.providers().find(p => p.name === 'test-prov')?.base_url === 'https://api.test.com/v1', 'provider upsert: empty url preserves saved endpoint');
  cfg.upsertProvider('anthropic-prov', 'https://api.example.com/v1', 'test-key-456', 'anthropic');
  assert(cfg.providers().find(p => p.name === 'anthropic-prov')?.protocol === 'anthropic', 'provider protocol can be explicit anthropic');
  cfg.upsertProvider('GitHub Copilot', '', 'ghp-test-token', 'github_models');
  assert(cfg.providers().find(p => p.name === 'GitHub Copilot')?.base_url === 'https://models.github.ai' && cfg.providers().find(p => p.name === 'GitHub Copilot')?.protocol === 'github_models', 'provider protocol can default GitHub Models endpoint');
  const publicProviders = sanitizeProvidersForState(cfg.providers());
  assert(publicProviders.every(p => p.api_key === '') && publicProviders.some(p => p.name === 'test-prov' && p.has_api_key), 'provider state: redacts API keys and exposes has_api_key');
  const mergedProviders = mergeProviderSecrets([{ name: 'test-prov', base_url: 'https://api.test.com/v1', api_key: '', protocol: 'openai', enabled: true, models: [] }], cfg.providers()) as Array<{ name: string; api_key?: string }>;
  assert(mergedProviders.find(p => p.name === 'test-prov')?.api_key === 'test-key-123', 'provider save: redacted/empty UI state preserves existing API key');
  const renamedProviders = mergeProviderSecrets([{ name: 'test-prov-renamed', _previous_name: 'test-prov', base_url: 'https://api.test.com/v1', api_key: '', protocol: 'openai', enabled: true, models: [] }], cfg.providers()) as Array<{ name: string; api_key?: string; _previous_name?: string }>;
  assert(renamedProviders.find(p => p.name === 'test-prov-renamed')?.api_key === 'test-key-123' && !renamedProviders.find(p => p.name === 'test-prov-renamed')?._previous_name, 'provider save: renamed provider preserves existing API key without persisting temporary previous name');

  // Test model addition
  cfg.addModelToProvider('test-prov', 'gpt-test', 'GPT Test', 'Test model');
  const models = cfg.allModels();
  assert(models.length === 1, 'model added');
  assert(models[0].name === 'gpt-test', 'model name correct');
  assert(models[0].provider === 'test-prov', 'model provider bound');
  assert(models[0].provider_protocol === 'openai', 'model carries provider protocol');
  cfg.addModelToProvider('test-prov', 'gpt-5.5', 'GPT 5.5', 'Provider-listed frontier GPT model');
  assert(cfg.findModel('gpt-5.5')?.vision === true, 'model config: infers GPT-5.5 vision capability when model is added');

  // Test save
  cfg.save();
  const cfg2 = new ConfigManager(TEST_DIR);
  assert(cfg2.providers().length === 3 && cfg2.providers().some(p => p.name === 'GitHub Copilot' && p.protocol === 'github_models'), 'config persisted');

  const bomDir = path.join(TEST_DIR, 'bom-config');
  fs.mkdirSync(bomDir, { recursive: true });
  const bomGlobal = defaultConfig();
  bomGlobal.models.default_model.value = 'bom-model';
  fs.writeFileSync(path.join(bomDir, 'config.json'), '\uFEFF' + JSON.stringify(bomGlobal, null, 2), 'utf-8');
  const bomCfg = new ConfigManager(bomDir);
  assert(bomCfg.getStr('models', 'default_model') === 'bom-model', 'config: tolerates UTF-8 BOM');
  const bomWs = path.join(bomDir, 'workspace-bom');
  fs.mkdirSync(bomWs, { recursive: true });
  fs.writeFileSync(path.join(bomWs, 'config.json'), '\uFEFF' + JSON.stringify({
    workspace: {
      prompt_mode: { value: 'workspace_only' },
    },
  }), 'utf-8');
  bomCfg.loadWorkspaceConfig(bomWs);
  assert(bomCfg.getStr('workspace', 'prompt_mode') === 'workspace_only', 'workspace config: tolerates UTF-8 BOM');
  const plainWs = path.join(bomDir, 'workspace-plain');
  fs.mkdirSync(plainWs, { recursive: true });
  fs.writeFileSync(path.join(plainWs, 'config.json'), JSON.stringify({
    workspace: {
      prompt_mode: 'global_only',
      access_permission: 'no_outside_access',
    },
  }), 'utf-8');
  bomCfg.loadWorkspaceConfig(plainWs);
  assert(bomCfg.getStr('workspace', 'prompt_mode') === 'global_only', 'workspace config: accepts plain JSON overrides');
  assert(bomCfg.getStr('workspace', 'access_permission') === 'no_outside_access', 'workspace config: plain JSON overrides permissions');

  const plainConfigRoot = path.join(TEST_DIR, 'plain-config-root');
  fs.mkdirSync(plainConfigRoot, { recursive: true });
  fs.writeFileSync(path.join(plainConfigRoot, 'config.json'), JSON.stringify({
    models: {
      providers: [{ name: 'PlainProvider', base_url: 'https://example.invalid/v1', api_key: 'test-key-basic', protocol: 'openai', models: ['plain-model'] }],
      default_model: 'plain-model',
      default_intelligence: 'low',
    },
    workspace: { auto_create_timestamp_workspace: true, prompt_mode: 'workspace_only' },
  }), 'utf-8');
  const plainConfig = new ConfigManager(plainConfigRoot);
  assert(plainConfig.providers()[0]?.name === 'PlainProvider', 'config: accepts plain JSON providers');
  assert(plainConfig.getStr('models', 'default_model') === 'plain-model', 'config: accepts plain JSON scalar values');
  assert(plainConfig.getStr('workspace', 'prompt_mode') === 'workspace_only', 'config: accepts plain JSON workspace settings');
  const brokenConfigRoot = path.join(TEST_DIR, 'broken-config-root');
  fs.mkdirSync(brokenConfigRoot, { recursive: true });
  fs.writeFileSync(path.join(brokenConfigRoot, 'config.json'), JSON.stringify({
    models: {
      providers: [{ name: '', base_url: 'https://broken.invalid/v1', api_key: 'sk-redacted-test-secret-value', models: [{ display: 'nameless' }] }],
      default_model: 'broken-model',
    },
  }), 'utf-8');
  const recoveredConfig = new ConfigManager(brokenConfigRoot);
  assert(recoveredConfig.providers().some(p => p.name === 'ExampleOpenAICompatible') && recoveredConfig.providers()[0]?.api_key === '', 'config recovery: invalid provider shape is replaced with safe example config');
  assert(fs.readdirSync(brokenConfigRoot).some(f => f.startsWith('config.broken-invalid-shape-') && f.endsWith('.json')), 'config recovery: invalid provider shape is backed up before replacement');
  const invalidJsonRoot = path.join(TEST_DIR, 'invalid-json-config-root');
  fs.mkdirSync(invalidJsonRoot, { recursive: true });
  fs.writeFileSync(path.join(invalidJsonRoot, 'config.json'), '{ invalid json', 'utf-8');
  const invalidJsonRecovered = new ConfigManager(invalidJsonRoot);
  assert(invalidJsonRecovered.providers().some(p => p.name === 'ExampleOpenAICompatible') && fs.readdirSync(invalidJsonRoot).some(f => f.startsWith('config.broken-invalid-json-')), 'config recovery: invalid JSON is backed up and replaced with safe example config');

  // ---- 2. Tool Executor Tests ----
  console.log('\n🔧 Tool Executor');
  const tools = new ToolExecutor(TEST_DIR, cfg);

  // bash
  const bashResult = await tools.execute('bash', '{"command":"echo hello"}', TEST_DIR);
  assert(bashResult.includes('hello'), 'bash: echo hello');
  const bashPlatformCommand = process.platform === 'win32' ? 'Get-Location' : 'pwd';
  const bashPWSH = await tools.execute('bash', JSON.stringify({ command: bashPlatformCommand }), TEST_DIR);
  assert(bashPWSH.length > 0, 'bash: platform shell works');
  const timeoutCfg = new ConfigManager(path.join(TEST_DIR, 'bash-timeout-cap'));
  const timeoutTools = new ToolExecutor(TEST_DIR, timeoutCfg);
  assert((timeoutTools as any).resolveBashTimeout(undefined) === undefined, 'bash timeout: default 0 has no cap and no timeout');
  assert((timeoutTools as any).resolveBashTimeout(0) === undefined, 'bash timeout: requested 0 is unlimited when uncapped');
  assert((timeoutTools as any).resolveBashTimeout(2500) === 2500, 'bash timeout: agent can request per-command timeout when uncapped');
  timeoutCfg.set('terminal', 'interrupt_timeout_ms', 60000);
  assert((timeoutTools as any).resolveBashTimeout(undefined) === 60000, 'bash timeout: nonzero setting is default cap');
  assert((timeoutTools as any).resolveBashTimeout(0) === 60000, 'bash timeout: requested unlimited is capped by nonzero setting');
  assert((timeoutTools as any).resolveBashTimeout(120000) === 60000, 'bash timeout: requested timeout is clipped to cap');
  assert((timeoutTools as any).resolveBashTimeout(5000) === 5000, 'bash timeout: shorter requested timeout is preserved under cap');
  const bashRequestedTimeout = await timeoutTools.execute('bash', JSON.stringify({ command: 'echo timeout-ok', timeout_ms: 10000 }), TEST_DIR);
  assert(bashRequestedTimeout.includes('timeout-ok'), 'bash timeout: execute accepts timeout_ms argument');
  const takeoverShell = process.platform === 'win32' ? 'powershell' : 'bash';
  const takeoverCommand = process.platform === 'win32' ? 'Write-Output takeover-ok' : 'printf "takeover-ok\\n"';
  const takeoverStart = await tools.execute('terminal_takeover', JSON.stringify({ action: 'start', name: 'verify', shell: takeoverShell }), TEST_DIR);
  assert(takeoverStart.includes('"ok": true') && takeoverStart.includes('"name": "verify"'), 'terminal_takeover: starts independent named session');
  const takeoverWrite = await tools.execute('terminal_takeover', JSON.stringify({ action: 'write', name: 'verify', command: takeoverCommand }), TEST_DIR);
  assert(takeoverWrite.includes('wrote to verify'), 'terminal_takeover: writes to persistent session without using bash');
  let takeoverRead = '';
  for (let attempt = 0; attempt < 24; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    takeoverRead = await tools.execute('terminal_takeover', JSON.stringify({ action: 'read', name: 'verify', max_chars: 5000 }), TEST_DIR);
    if (takeoverRead.includes('takeover-ok')) break;
  }
  assert(takeoverRead.includes('takeover-ok'), 'terminal_takeover: reads output from the same persistent shell environment');
  const takeoverStop = await tools.execute('terminal_takeover', JSON.stringify({ action: 'stop', name: 'verify' }), TEST_DIR);
  assert(takeoverStop.includes('stopped verify'), 'terminal_takeover: stops named session');
  if (process.platform === 'win32') {
    const computerDryMove = await tools.execute('computer_use', JSON.stringify({ action: 'move', x: 10, y: 20, dry_run: true }), TEST_DIR);
    assert(computerDryMove.includes('"action": "move"') && computerDryMove.includes('"dry_run": true'), 'computer_use: supports dry-run native desktop move action');
    const computerTargetBeforeObserve = await tools.execute('computer_use', JSON.stringify({ action: 'click', target_id: 'ui-1', dry_run: true }), TEST_DIR);
    assert(computerTargetBeforeObserve.includes('Call computer_use observe first') || computerTargetBeforeObserve.includes('target_id not found'), 'computer_use: target_id actions require latest semantic observation');
    const computerDryType = await tools.execute('computer_use', JSON.stringify({ action: 'type', text: 'hello', dry_run: true }), TEST_DIR);
    assert(computerDryType.includes('"action": "type"') && computerDryType.includes('"chars": 5'), 'computer_use: supports dry-run native desktop type action');
    const computerDryScroll = await tools.execute('computer_use', JSON.stringify({ action: 'scroll', x: 10, y: 20, scroll_y: 240, dry_run: true }), TEST_DIR);
    assert(computerDryScroll.includes('"action": "scroll"') && computerDryScroll.includes('"scroll_y": 240'), 'computer_use: supports dry-run native desktop scroll action');
    const computerTakeoverStop = await tools.execute('computer_use', JSON.stringify({ action: 'takeover_stop' }), TEST_DIR);
    assert(computerTakeoverStop.includes('"action": "takeover_stop"') && computerTakeoverStop.includes('"ok": true'), 'computer_use: takeover_stop is safe and clears desktop takeover indicator');
    const computerLockA1 = await tools.execute('computer_use', JSON.stringify({ action: 'move', x: 1, y: 1, dry_run: true }), TEST_DIR, { conversationId: 'conv-a' });
    assert(computerLockA1.includes('"action": "move"') && computerLockA1.includes('"dry_run": true'), 'computer_use lock: first conversation acquires control');
    const computerLockBBlocked = await tools.execute('computer_use', JSON.stringify({ action: 'move', x: 2, y: 2, dry_run: true }), TEST_DIR, { conversationId: 'conv-b' });
    assert(computerLockBBlocked.includes('"ok": false') && computerLockBBlocked.includes('ComputerUse is already active') && computerLockBBlocked.includes('conversation:conv-a') && computerLockBBlocked.includes('conversation:conv-b'), 'computer_use lock: second conversation is blocked while another conversation owns ComputerUse');
    const computerLockA2 = await tools.execute('computer_use', JSON.stringify({ action: 'scroll', x: 1, y: 1, scroll_y: 120, dry_run: true }), TEST_DIR, { conversationId: 'conv-a' });
    assert(computerLockA2.includes('"action": "scroll"') && computerLockA2.includes('"scroll_y": 120'), 'computer_use lock: owning conversation can continue sequential actions');
    const computerLockBStopBlocked = await tools.execute('computer_use', JSON.stringify({ action: 'takeover_stop' }), TEST_DIR, { conversationId: 'conv-b' });
    assert(computerLockBStopBlocked.includes('"ok": false') && computerLockBStopBlocked.includes('ComputerUse is already active') && computerLockBStopBlocked.includes('conversation:conv-a'), 'computer_use lock: non-owner conversation cannot clear the active takeover');
    const computerLockAStop = await tools.execute('computer_use', JSON.stringify({ action: 'takeover_stop' }), TEST_DIR, { conversationId: 'conv-a' });
    assert(computerLockAStop.includes('"action": "takeover_stop"') && computerLockAStop.includes('"ok": true'), 'computer_use lock: owner releases control with takeover_stop');
    const computerLockBAllowed = await tools.execute('computer_use', JSON.stringify({ action: 'move', x: 3, y: 3, dry_run: true }), TEST_DIR, { conversationId: 'conv-b' });
    assert(computerLockBAllowed.includes('"action": "move"') && computerLockBAllowed.includes('"dry_run": true'), 'computer_use lock: another conversation can acquire after release');
    await tools.execute('computer_use', JSON.stringify({ action: 'takeover_stop' }), TEST_DIR, { conversationId: 'conv-b' });
    const computerAppList = await tools.execute('computer_use', JSON.stringify({ action: 'app_list', max_chars: 12000 }), TEST_DIR);
    assert(computerAppList.includes('"action": "app_list"') && computerAppList.includes('"applications"'), 'computer_use: lists visible taskbar/application windows for app-scoped control');
    const computerAppMissing = await tools.execute('computer_use', JSON.stringify({ action: 'app_observe', app_target: 'newmark-nonexistent-app-for-test', dry_run: true }), TEST_DIR);
    assert(computerAppMissing.includes('"action": "app_observe"') && computerAppMissing.includes('No visible application window matched'), 'computer_use: app_observe reports unmatched taskbar/application targets');
    await tools.execute('computer_use', JSON.stringify({ action: 'takeover_stop' }), TEST_DIR);
  } else {
    const computerLinuxUnsupported = await tools.execute('computer_use', JSON.stringify({ action: 'move', x: 10, y: 20, dry_run: true }), TEST_DIR);
    assert(computerLinuxUnsupported.includes('"ok": false') && computerLinuxUnsupported.includes('Windows only'), 'computer_use: Linux reports explicit unsupported native desktop control instead of crashing');
  }
  const disabledToolCfg = new ConfigManager(path.join(TEST_DIR, 'disabled-native-tools'));
  disabledToolCfg.set('tools', 'enabled', { ...disabledToolCfg.nativeToolEnabled(), computer_use: false });
  const disabledTools = new ToolExecutor(TEST_DIR, disabledToolCfg);
  assert(!disabledTools.definitions().some((tool: any) => tool.function?.name === 'computer_use'), 'native tool settings: disabled tools are hidden from definitions');
  const disabledComputerUse = await disabledTools.execute('computer_use', JSON.stringify({ action: 'move', x: 10, y: 20, dry_run: true }), TEST_DIR);
  assert(disabledComputerUse.includes('[tool disabled] computer_use'), 'native tool settings: disabled tools are blocked at execution');
  const sshRoot = path.join(TEST_DIR, 'ssh-runtime');
  fs.mkdirSync(path.join(sshRoot, 'Work'), { recursive: true });
  fs.writeFileSync(path.join(sshRoot, 'PC_Hash.config'), 'local-pc|win32|x64', 'utf-8');
  fs.writeFileSync(path.join(sshRoot, 'Work', 'Local.json'), '[]', 'utf-8');
  fs.writeFileSync(path.join(sshRoot, 'Work', 'External.json'), '[]', 'utf-8');
  const sshCalls: Array<{ command: string; args: string[] }> = [];
  const mockSshRunner: SshRunner = (command, runArgs) => {
    sshCalls.push({ command, args: runArgs });
    const argsText = runArgs.join(' ');
    return {
      status: argsText.includes('bad-host') ? 255 : 0,
      stdout: argsText.includes('bad-host') ? '' : 'remote-vm|Linux|x86_64\n',
      stderr: argsText.includes('bad-host') ? 'connect failed' : '',
      args: runArgs,
    };
  };
  const sshManager = new SshManager(sshRoot, mockSshRunner);
  const sshWorkspaceManager = new WorkspaceManager(sshRoot, new ConfigManager(sshRoot));
  const sshTools = new ToolExecutor(sshRoot, new ConfigManager(sshRoot), sshManager, sshWorkspaceManager);
  const sshUpsert = await sshTools.execute('ssh_workspace', JSON.stringify({ action: 'upsert', name: 'Local VM', host: '127.0.0.1', port: 2222, user: 'tester', identity_file: 'C:\\Users\\tester\\.ssh\\id_ed25519', remote_root: '~/.newmark-agent' }), sshRoot);
  assert(sshUpsert.includes('"ok": true') && sshUpsert.includes('<identity-file-configured>') && !sshUpsert.includes('id_ed25519'), 'ssh_workspace: saves redacted OpenSSH connection metadata without exposing identity path');
  const sshConnectionId = JSON.parse(sshUpsert).connection.id;
  const sshValidate = await sshTools.execute('ssh_workspace', JSON.stringify({ action: 'validate', id: sshConnectionId, remote_root: '~/.newmark-agent' }), sshRoot);
  assert(sshValidate.includes('"ok": true') && sshValidate.includes('remote-vm|Linux|x86_64'), 'ssh_workspace: validates native OpenSSH link and reads remote PC_Hash');
  assert(sshCalls[0]?.command === 'ssh' && sshCalls[0].args.includes('BatchMode=yes') && sshCalls[0].args.includes('ConnectTimeout=8') && sshCalls[0].args.includes('tester@127.0.0.1'), 'ssh_workspace: invokes OpenSSH through argv array with noninteractive options');
  const sshCreate = await sshTools.execute('ssh_workspace', JSON.stringify({ action: 'create_workspace', id: sshConnectionId, name: 'vm-project', remote_path: '~/.newmark-agent/workspaces/project' }), sshRoot);
  const parsedSshCreate = JSON.parse(sshCreate);
  assert(parsedSshCreate.ok === true && parsedSshCreate.workspace.kind === 'ssh' && parsedSshCreate.workspace.remotePcHash === 'remote-vm|Linux|x86_64' && fs.existsSync(parsedSshCreate.workspace.path), 'ssh_workspace: creates SSH external shadow workspace with remote PC_Hash metadata');
  const sshReloaded = new WorkspaceManager(sshRoot, new ConfigManager(sshRoot));
  assert(sshReloaded.external.some(w => w.kind === 'ssh' && w.remotePcHash === 'remote-vm|Linux|x86_64'), 'workspace: preserves SSH external workspaces by remote PC_Hash');
  const localExternalDir = path.join(TEST_DIR, 'external-host-binding-check');
  fs.mkdirSync(localExternalDir, { recursive: true });
  fs.writeFileSync(path.join(sshRoot, 'Work', 'External.json'), JSON.stringify([{ name: 'old-local', path: localExternalDir, isInternal: false, hostBinding: 'different-pc|win32|x64', icon: 'O' }], null, 2), 'utf-8');
  const hostFiltered = new WorkspaceManager(sshRoot, new ConfigManager(sshRoot));
  assert(!hostFiltered.external.some(w => w.name === 'old-local'), 'workspace: still filters mismatched local external hostBinding');

  // read
  const readResult = await tools.execute('read', '{"path":"test.txt"}', TEST_DIR);
  assert(readResult.includes('Hello World'), 'read: file contents');
  assert(readResult.includes('Line 2'), 'read: multiple lines');
  const readMissing = await tools.execute('read', '{"path":"nonexist.txt"}', TEST_DIR);
  assert(readMissing.startsWith('[read]'), 'read: missing file reports error');

  // write
  const writeResult = await tools.execute('write', '{"path":"write-test.txt","content":"Written content"}', TEST_DIR);
  assert(writeResult.includes('OK'), 'write: succeeds');
  assert(fs.existsSync(path.join(TEST_DIR, 'write-test.txt')), 'write: file exists');
  assert(fs.readFileSync(path.join(TEST_DIR, 'write-test.txt'), 'utf-8') === 'Written content', 'write: content correct');

  // edit
  const editResult = await tools.execute('edit', '{"path":"test.txt","old_str":"Hello World","new_str":"Hi Earth"}', TEST_DIR);
  assert(editResult.includes('OK'), 'edit: succeeds');
  const edited = fs.readFileSync(path.join(TEST_DIR, 'test.txt'), 'utf-8');
  assert(edited.includes('Hi Earth') && !edited.includes('Hello World'), 'edit: replaced text');
  const editMissing = await tools.execute('edit', '{"path":"test.txt","old_str":"NOTFOUND","new_str":"XXX"}', TEST_DIR);
  assert(editMissing.includes('not found'), 'edit: missing string reports');

  // glob
  const globResult = await tools.execute('glob', '{"pattern":"*.txt"}', TEST_DIR);
  assert(globResult.includes('test.txt'), 'glob: finds file');
  assert(globResult.includes('write-test.txt'), 'glob: finds written file');
  const globNoMatch = await tools.execute('glob', '{"pattern":"*.xyz"}', TEST_DIR);
  assert(globNoMatch.includes('No matches'), 'glob: no match reports');

  // grep
  const grepResult = await tools.execute('grep', '{"pattern":"Find","path":"."}', TEST_DIR);
  assert(grepResult.includes('Find me here'), 'grep: finds text');

  // web_search (will fail gracefully without network)
  const searchResult = await tools.execute('web_search', '{"query":"test"}', TEST_DIR);
  assert(searchResult.length > 0, 'web_search: returns something');

  // web_fetch
  const fetchResult = await tools.execute('web_fetch', '{"url":"https://example.com"}', TEST_DIR);
  assert(fetchResult.length > 0 || fetchResult.includes('truncated') || fetchResult.includes('error'), 'web_fetch: handles response');

  // git_status (likely not in git repo, but shouldn't crash)
  const gsResult = await tools.execute('git_status', '{}', TEST_DIR);
  assert(gsResult.length > 0, 'git_status: returns result');
  const auditSource = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'index.ts'), 'utf-8');
  assert(auditSource.includes("case 'file_audit'") && auditSource.includes("repos/${repo}/commits?path=") && auditSource.includes("repos/${repo}/contents/") && auditSource.includes("repos/${repo}/branches/"), 'file_audit: native GitHub REST paths are wired through gh api for commits, contents, and branches');
  assert(auditSource.includes("case 'repo_security_audit'") && auditSource.includes('scanRepositorySecrets') && auditSource.includes('releaseExcludedPathFindings') && auditSource.includes('withRemoteSecurityPreamble'), 'repo_security_audit: remote safety, privacy, and remote-write preflight paths are wired');
  assert(auditSource.includes("spawnSync('git', args") && auditSource.includes("spawnTool('gh', args"), 'git/github tools: use native spawn argument arrays instead of shell string concatenation for new audit flows');
  const auditRepo = path.join(TEST_DIR, 'audit-repo');
  fs.mkdirSync(auditRepo, { recursive: true });
  fs.writeFileSync(path.join(auditRepo, 'tracked.txt'), 'audit v1', 'utf-8');
  spawnSync('git', ['init'], { cwd: auditRepo, encoding: 'utf-8', windowsHide: true });
  spawnSync('git', ['config', 'user.email', 'newmark@example.test'], { cwd: auditRepo, encoding: 'utf-8', windowsHide: true });
  spawnSync('git', ['config', 'user.name', 'Newmark Test'], { cwd: auditRepo, encoding: 'utf-8', windowsHide: true });
  spawnSync('git', ['add', 'tracked.txt'], { cwd: auditRepo, encoding: 'utf-8', windowsHide: true });
  spawnSync('git', ['commit', '-m', 'audit baseline'], { cwd: auditRepo, encoding: 'utf-8', windowsHide: true });
  fs.writeFileSync(path.join(auditRepo, 'tracked.txt'), 'audit v2', 'utf-8');
  const auditResult = await tools.execute('file_audit', JSON.stringify({ path: path.join(auditRepo, 'tracked.txt'), include_remote: false }), auditRepo);
  const auditJson = JSON.parse(auditResult);
  assert(auditJson.local.sha256 && auditJson.git.tracked === true && String(auditJson.git.status).includes('M tracked.txt') && auditJson.remote.provider === 'local-only', 'file_audit: reports local hash, git tracking/status, and local-only remote mode');
  fs.mkdirSync(path.join(auditRepo, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(auditRepo, 'archive', 'private-note.md'), 'local only', 'utf-8');
  fs.writeFileSync(path.join(auditRepo, 'config.json'), '{"api_key":"sk-testsecret12345678901234567890"}', 'utf-8');
  spawnSync('git', ['add', 'config.json'], { cwd: auditRepo, encoding: 'utf-8', windowsHide: true });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/example/public-audit.git'], { cwd: auditRepo, encoding: 'utf-8', windowsHide: true });
  const securityAuditResult = await tools.execute('repo_security_audit', JSON.stringify({ path: auditRepo }), auditRepo);
  const securityAudit = JSON.parse(securityAuditResult);
  assert(securityAudit.remote_repository_detected === true && securityAudit.remote.repository === 'example/public-audit' && securityAudit.security_review.required === true, 'repo_security_audit: detects remote GitHub repository and requires safety review');
  assert(securityAudit.security_review.secret_findings.some((f: any) => f.path === 'config.json') && securityAudit.security_review.release_excluded_local_files.some((p: string) => p === 'archive' || p.startsWith('archive/')), 'repo_security_audit: reports secret-like tracked material and release-excluded local files');
  const pushSource = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'index.ts'), 'utf-8');
  assert(pushSource.includes("case 'git_push': return this.withRemoteSecurityPreamble") && pushSource.includes("case 'gh_pr_create': return this.withRemoteSecurityPreamble"), 'repo_security_audit: git_push and gh_pr_create include remote safety preflight summary');
  const branchResult = await tools.execute('git_branch', '{"action":"current"}', auditRepo);
  assert(branchResult.trim().length > 0, 'git_branch: current branch returns local branch name');

  // task (subagent placeholder)
  const taskResult = await tools.execute('task', '{"name":"test-sub","prompt":"do work"}', TEST_DIR);
  assert(taskResult.includes('Subagent'), 'task: returns placeholder');

  // question
  const qResult = await tools.execute('question', '{"questions":[{"header":"Test","question":"Q?","options":[{"label":"A","description":"a"}]}]}', TEST_DIR);
  assert(qResult.includes('Options'), 'question: acknowledges');
  cfg.set('agent', 'option_feedback', 'fully_autonomous');
  const qDisabled = await tools.execute('question', '{"questions":[]}', TEST_DIR);
  assert(qDisabled.includes('Disabled'), 'question: fully autonomous disables options');
  assert(!tools.definitions().some((tool: any) => tool.function?.name === 'question'), 'definitions: fully autonomous hides question tool');
  cfg.set('agent', 'option_feedback', 'default');

  // permissions
  const outsideFile = path.join(process.cwd(), 'outside-permission-test.txt');
  fs.writeFileSync(outsideFile, 'outside');
  cfg.set('workspace', 'access_permission', 'no_outside_access');
  const outsideReadDenied = await tools.execute('read', JSON.stringify({ path: outsideFile }), TEST_DIR, { workspacePath: TEST_DIR });
  assert(outsideReadDenied.includes('[permission]'), 'permissions: no_outside_access blocks outside read');
  cfg.set('workspace', 'access_permission', 'outside_readonly');
  const outsideReadAllowed = await tools.execute('read', JSON.stringify({ path: outsideFile }), TEST_DIR, { workspacePath: TEST_DIR });
  assert(outsideReadAllowed.includes('outside'), 'permissions: outside_readonly allows outside read');
  const outsideWriteDenied = await tools.execute('write', JSON.stringify({ path: outsideFile, content: 'blocked' }), TEST_DIR, { workspacePath: TEST_DIR });
  assert(outsideWriteDenied.includes('[permission]'), 'permissions: outside_readonly blocks outside write');
  const outsideReadCommand = process.platform === 'win32' ? `Get-Content "${outsideFile}"` : `cat "${outsideFile}"`;
  const outsideWriteCommand = process.platform === 'win32' ? `Set-Content "${outsideFile}" blocked` : `echo blocked > "${outsideFile}"`;
  const outsideBashReadAllowed = await tools.execute('bash', JSON.stringify({ command: outsideReadCommand }), TEST_DIR, { workspacePath: TEST_DIR });
  assert(outsideBashReadAllowed.includes('outside'), 'permissions: outside_readonly allows read-only bash outside workspace');
  const outsideBashWriteDenied = await tools.execute('bash', JSON.stringify({ command: outsideWriteCommand }), TEST_DIR, { workspacePath: TEST_DIR });
  assert(outsideBashWriteDenied.includes('[permission]'), 'permissions: outside_readonly blocks mutating bash outside workspace');
  cfg.set('workspace', 'access_permission', 'no_outside_access');
  const outsideBashReadDenied = await tools.execute('bash', JSON.stringify({ command: outsideReadCommand }), TEST_DIR, { workspacePath: TEST_DIR });
  assert(outsideBashReadDenied.includes('[permission]'), 'permissions: no_outside_access blocks bash outside read');
  cfg.set('workspace', 'access_permission', 'outside_readonly');
  const planWriteDenied = await tools.execute('write', '{"path":"not-readme.txt","content":"blocked"}', TEST_DIR, { mode: 'plan', workspacePath: TEST_DIR });
  assert(planWriteDenied.includes('fully read-only'), 'plan permissions: blocks arbitrary writes');
  const planReadmeDenied = await tools.execute('write', '{"path":"README.md","content":"plan blocked"}', TEST_DIR, { mode: 'plan', workspacePath: TEST_DIR });
  assert(planReadmeDenied.includes('fully read-only'), 'plan permissions: blocks README writes');
  fs.rmSync(outsideFile, { force: true });
  cfg.set('workspace', 'access_permission', 'full_access');

  // skill_download
  const sdResult = await tools.execute('skill_download', '{"name":"test-skill","source":"not-a-url"}', TEST_DIR);
  assert(sdResult.includes('Not a URL'), 'skill_download: handles non-URL');

  const flowSaveTool = await tools.execute('flow_save', JSON.stringify({
    name: 'tool-made-flow',
    components: [
      { type: 'dialog', mode: 'plan', prompt: 'Plan {#prompt#}' },
      { type: 'logic', prompt: 'Is it done?', goto_true: 2, goto_false: 0 },
      { type: 'dialog', mode: 'build', prompt: 'Finish' },
    ],
  }), TEST_DIR);
  assert(flowSaveTool.includes('OK'), 'flow_save: writes workflow');
  assert(fs.existsSync(path.join(TEST_DIR, 'Flow', 'tool-made-flow.Flow.json')), 'flow_save: file exists');
  const flowListTool = await tools.execute('flow_list', '{}', TEST_DIR);
  assert(flowListTool.includes('tool-made-flow'), 'flow_list: finds saved workflow');
  assert(tools.definitions().some((tool: any) => tool.function?.name === 'flow_run'), 'definitions: exposes flow_run');
  assert(tools.definitions().some((tool: any) => tool.function?.name === 'automation_create'), 'definitions: exposes automation_create');
  assert(tools.definitions('plan').some((tool: any) => tool.function?.name === 'automation_list'), 'definitions: Plan exposes automation_list');
  assert(!tools.definitions('plan').some((tool: any) => tool.function?.name === 'automation_create'), 'definitions: Plan hides automation_create');
  const ghAuthTool = await tools.execute('gh_auth_status', '{}', TEST_DIR);
  assert(ghAuthTool.length > 0, 'gh_auth_status: returns output or graceful error');
  assert(tools.definitions().some((tool: any) => tool.function?.name === 'gh_repo_view'), 'definitions: exposes GitHub CLI tools');
  assert(tools.definitions().some((tool: any) => tool.function?.name === 'file_audit') && tools.definitions('plan').some((tool: any) => tool.function?.name === 'file_audit'), 'definitions: exposes file_audit including Plan read-only mode');
  assert(tools.definitions().some((tool: any) => tool.function?.name === 'repo_security_audit') && tools.definitions('plan').some((tool: any) => tool.function?.name === 'repo_security_audit'), 'definitions: exposes repo_security_audit including Plan read-only mode');
  assert(tools.definitions().some((tool: any) => tool.function?.name === 'git_branch') && tools.definitions().some((tool: any) => tool.function?.name === 'gh_fork') && tools.definitions().some((tool: any) => tool.function?.name === 'gh_pr_create'), 'definitions: exposes branch, fork, and PR GitHub workflows');
  assert(tools.definitions().some((tool: any) => tool.function?.name === 'browser_open'), 'definitions: exposes browser_open');
  assert(tools.definitions().some((tool: any) => tool.function?.name === 'browser_cdp'), 'definitions: exposes browser_cdp');
  assert(tools.definitions().some((tool: any) => tool.function?.name === 'computer_use'), 'definitions: exposes native computer_use desktop tool');
  assert(tools.definitions('plan').some((tool: any) => tool.function?.name === 'browser_snapshot'), 'definitions: plan exposes browser_snapshot');
  assert(!tools.definitions('plan').some((tool: any) => tool.function?.name === 'browser_click'), 'definitions: plan hides browser_click');
  const canonicalTools = tools.canonicalDefinitions();
  const writeCanonical = canonicalTools.find(t => t.name === 'write');
  assert(!!writeCanonical && writeCanonical.inputSchema.type === 'object' && writeCanonical.sideEffects === 'write', 'compat tools: canonical definitions preserve schema and side effects');
  const openAiResponsesTool = tools.openAIResponsesDefinitions().find((t: any) => t.name === 'write') as any;
  assert(openAiResponsesTool?.type === 'function' && openAiResponsesTool.parameters?.type === 'object', 'compat tools: emits OpenAI Responses function shape');
  const openAiChatTool = tools.openAIChatDefinitions().find((t: any) => t.function?.name === 'write') as any;
  assert(openAiChatTool?.function?.parameters?.type === 'object', 'compat tools: emits OpenAI Chat Completions function shape');
  const anthropicTool = tools.anthropicDefinitions().find((t: any) => t.name === 'write') as any;
  assert(anthropicTool?.input_schema?.type === 'object', 'compat tools: emits Anthropic input_schema shape');
  const envelope = await tools.executeEnvelope('write', JSON.stringify({ path: path.join(TEST_DIR, 'tool-envelope.txt'), content: 'enveloped' }), TEST_DIR);
  assert(envelope.ok === true && envelope.output.includes('[write] OK') && envelope.metadata?.tool === 'write', 'compat tools: executeEnvelope returns structured result');

  BrowserControl.setBackend(null);
  const browserNoBackend = await tools.execute('browser_snapshot', '{}', TEST_DIR);
  assert(browserNoBackend.includes('backend is not connected'), 'browser control: reports missing desktop backend');
  const unsafeBrowserUrl = await tools.execute('browser_open', JSON.stringify({ url: 'javascript:alert(1)' }), TEST_DIR);
  assert(unsafeBrowserUrl.includes('requires a safe'), 'browser control: blocks unsafe URL schemes');
  const browserCalls: string[] = [];
  BrowserControl.setBackend({
    async run(req) {
      browserCalls.push(req.action);
      if (req.action === 'snapshot') return { ok: true, action: req.action, source: 'mock-cdp', url: 'https://example.test/', title: 'Example', text: 'snapshot text' };
      if (req.action === 'click') return { ok: true, action: req.action, source: 'mock-cdp', url: 'https://example.test/', data: { clicked: true, selector: req.selector } };
      if (req.action === 'type') return { ok: true, action: req.action, source: 'mock-cdp', url: 'https://example.test/', data: { typed: true, selector: req.selector, text: req.text } };
      if (req.action === 'cdp') return { ok: true, action: req.action, source: 'mock-cdp', url: 'https://example.test/', data: { method: req.method, params: req.params } };
      return { ok: true, action: req.action, source: 'mock-cdp', url: req.url || 'https://example.test/', title: 'Opened', text: 'opened text' };
    },
  });
  const browserOpen = await tools.execute('browser_open', JSON.stringify({ url: 'example.test' }), TEST_DIR);
  assert(browserOpen.includes('[browser:open] OK') && browserOpen.includes('https://example.test/'), 'browser control: opens normalized URL through backend');
  const browserSnapshot = await tools.execute('browser_snapshot', '{}', TEST_DIR);
  assert(browserSnapshot.includes('snapshot text'), 'browser control: formats snapshot text');
  const planBrowserOpen = await tools.execute('browser_open', JSON.stringify({ url: 'example.test' }), TEST_DIR, { mode: 'plan', workspacePath: TEST_DIR });
  assert(planBrowserOpen.includes('[browser:open] OK'), 'browser control: Plan mode allows read-only browser_open execution');
  const planBrowserSnapshot = await tools.execute('browser_snapshot', '{}', TEST_DIR, { mode: 'plan', workspacePath: TEST_DIR });
  assert(planBrowserSnapshot.includes('snapshot text'), 'browser control: Plan mode allows read-only browser_snapshot execution');
  const planBrowserClick = await tools.execute('browser_click', JSON.stringify({ selector: '#run' }), TEST_DIR, { mode: 'plan', workspacePath: TEST_DIR });
  assert(planBrowserClick.includes('fully read-only'), 'browser control: Plan mode blocks mutating browser_click execution');
  const planBrowserType = await tools.execute('browser_type', JSON.stringify({ selector: '#q', text: 'blocked' }), TEST_DIR, { mode: 'plan', workspacePath: TEST_DIR });
  assert(planBrowserType.includes('fully read-only'), 'browser control: Plan mode blocks mutating browser_type execution');
  const planBrowserEval = await tools.execute('browser_eval', JSON.stringify({ script: 'location.href' }), TEST_DIR, { mode: 'plan', workspacePath: TEST_DIR });
  assert(planBrowserEval.includes('fully read-only'), 'browser control: Plan mode blocks browser_eval execution');
  const browserClick = await tools.execute('browser_click', JSON.stringify({ selector: '#run' }), TEST_DIR);
  assert(browserClick.includes('[browser:click] OK') && browserClick.includes('"clicked": true'), 'browser control: formats click result data');
  const browserType = await tools.execute('browser_type', JSON.stringify({ selector: '#q', text: 'typed value' }), TEST_DIR);
  assert(browserType.includes('[browser:type] OK') && browserType.includes('"typed": true') && browserType.includes('typed value'), 'browser control: formats type result data');
  const browserCdp = await tools.execute('browser_cdp', JSON.stringify({ method: 'Runtime.evaluate', params: { expression: '1+1' } }), TEST_DIR);
  assert(browserCdp.includes('Runtime.evaluate'), 'browser control: formats CDP result');
  assert(browserCalls.includes('open') && browserCalls.includes('snapshot') && browserCalls.includes('click') && browserCalls.includes('type') && browserCalls.includes('cdp'), 'browser control: routes actions to backend');
  BrowserControl.setBackend(null);

  // ---- 2b. Non-interactive CLI Command Tests ----
  console.log('\nCLI Commands');
  const captureStdout = async (fn: () => Promise<void | boolean>): Promise<string> => {
    const original = process.stdout.write;
    let out = '';
    (process.stdout.write as unknown as (chunk: unknown) => boolean) = (chunk: unknown) => {
      out += String(chunk);
      return true;
    };
    try {
      await fn();
    } finally {
      process.stdout.write = original;
    }
    return out;
  };
  const cliStateOut = await captureStdout(() => runCliCommand(TEST_DIR, ['state', '--root', TEST_DIR]));
  const cliState = JSON.parse(cliStateOut);
  assert(cliState.mode === 'build' && cliState.workspace, 'cli state: returns agent state');
  assert(cliState.language === 'auto', 'cli state: returns current language');
  assert(cliState.platform === process.platform && cliState.runtimeDefaultTerminalShell === (process.platform === 'win32' ? 'powershell' : 'bash') && Array.isArray(cliState.terminalShells) && cliState.terminalShells.includes(cliState.defaultTerminalShell), 'cli state: exposes platform-aware terminal shell defaults');
  assert(!cliStateOut.includes('test-key-123') && !cliStateOut.includes('test-key-456'), 'cli state: redacts provider API keys');
  const agentOnlyRoot = path.join(TEST_DIR, 'cli-agent-only-root');
  fs.mkdirSync(agentOnlyRoot, { recursive: true });
  fs.writeFileSync(path.join(agentOnlyRoot, 'config.json'), JSON.stringify({
    workspace: { auto_create_timestamp_workspace: false, prompt_mode: 'global_only' },
    models: { providers: [], default_model: '' },
  }, null, 2), 'utf-8');
  const cliAgentOnlyStateOut = await captureStdout(() => runCliCommand(agentOnlyRoot, ['state', '--agent-only', '--root', agentOnlyRoot]));
  const cliAgentOnlyState = JSON.parse(cliAgentOnlyStateOut);
  assert(cliAgentOnlyState.agentOnly === true && cliAgentOnlyState.workspace === null && cliAgentOnlyState.conversations.length === 0, 'cli state: --agent-only does not depend on workspace conversation state');
  const cliAgentOnlySendOut = await captureStdout(() => runCliCommand(agentOnlyRoot, ['send', 'pure agent cli prompt', '--agent-only', '--root', agentOnlyRoot]));
  assert(cliAgentOnlySendOut.includes('[Error] No LLM configured') && !cliAgentOnlySendOut.includes('Workspace required'), 'cli send: --agent-only runs pure Agent path without workspace requirement');
  assert(!fs.existsSync(path.join(agentOnlyRoot, 'Work')) || !fs.existsSync(path.join(agentOnlyRoot, 'Work', 'Local.json')) || JSON.parse(fs.readFileSync(path.join(agentOnlyRoot, 'Work', 'Local.json'), 'utf-8')).length === 0, 'cli send: --agent-only does not create an internal workspace');
  const cliAgentOnlyValidateOut = await captureStdout(() => runCliCommand(agentOnlyRoot, ['validate-models', '--agent-only', '--root', agentOnlyRoot]));
  assert(Array.isArray(JSON.parse(cliAgentOnlyValidateOut)), 'cli validate-models: --agent-only can run as pure Agent validation base');
  const cliAgentOnlyPreviewOut = await captureStdout(() => runCliCommand(agentOnlyRoot, ['fuzzy-inject', '--agent-only', '--name', 'PreviewOnly', '--endpoint', 'https://preview-only.test/v1', '--key', 'sk-preview-only', '--preview-only', '--root', agentOnlyRoot]));
  assert(JSON.parse(cliAgentOnlyPreviewOut).preview === true, 'cli fuzzy-inject: --agent-only can run as pure Agent fuzzy base');
  const cliZhStateOut = await captureStdout(() => runCliCommand(TEST_DIR, ['state', '--language', 'zh', '--root', TEST_DIR]));
  assert(JSON.parse(cliZhStateOut).language === 'zh', 'cli state: supports --language zh override');
  const cliCompatToolsOut = await captureStdout(() => runCliCommand(TEST_DIR, ['compat', '--target', 'tools', '--root', TEST_DIR]));
  const cliCompatTools = JSON.parse(cliCompatToolsOut);
  assert(cliCompatTools.tools.canonical.some((t: any) => t.name === 'write') && cliCompatTools.tools.openai_responses.some((t: any) => t.name === 'write'), 'cli compat: exposes canonical and provider-specific tool definitions');
  const cliToolFile = path.join(TEST_DIR, 'cli-tool-write.txt');
  const cliToolOut = await captureStdout(() => runCliCommand(TEST_DIR, ['tool', 'write', JSON.stringify({ path: cliToolFile, content: 'cli wrote file' }), '--root', TEST_DIR]));
  assert(cliToolOut.includes('[write] OK') && fs.existsSync(cliToolFile), 'cli tool: executes ToolExecutor command');
  assert(fs.readFileSync(cliToolFile, 'utf-8') === 'cli wrote file', 'cli tool: writes expected content');
  const cliToolArgsFile = path.join(TEST_DIR, 'cli-tool-args-bom.json');
  const cliToolBomFile = path.join(TEST_DIR, 'cli-tool-write-bom.txt');
  fs.writeFileSync(cliToolArgsFile, `\uFEFF${JSON.stringify({ path: cliToolBomFile, content: 'cli wrote from bom args file' })}`, 'utf-8');
  const cliToolBomOut = await captureStdout(() => runCliCommand(TEST_DIR, ['tool', 'write', '--args-file', cliToolArgsFile, '--root', TEST_DIR]));
  assert(cliToolBomOut.includes('[write] OK') && fs.readFileSync(cliToolBomFile, 'utf-8') === 'cli wrote from bom args file', 'cli tool: accepts UTF-8 BOM JSON args files from Windows PowerShell');
  const cliKvFile = path.join(TEST_DIR, 'cli-tool-kv.txt');
  const cliKvOut = await captureStdout(() => runCliCommand(TEST_DIR, ['tool', 'write', `path=${cliKvFile}`, 'content=cli kv wrote file', '--root', TEST_DIR]));
  assert(cliKvOut.includes('[write] OK') && fs.readFileSync(cliKvFile, 'utf-8') === 'cli kv wrote file', 'cli tool: supports key=value args');
  const cliArgsFileTarget = path.join(TEST_DIR, 'cli-tool-args-file.txt');
  const cliArgsFile = path.join(TEST_DIR, 'cli-tool-args.json');
  fs.writeFileSync(cliArgsFile, JSON.stringify({ path: cliArgsFileTarget, content: 'cli args-file wrote file' }), 'utf-8');
  const cliArgsFileOut = await captureStdout(() => runCliCommand(TEST_DIR, ['tool', 'write', '--args-file', cliArgsFile, '--root', TEST_DIR]));
  assert(cliArgsFileOut.includes('[write] OK') && fs.readFileSync(cliArgsFileTarget, 'utf-8') === 'cli args-file wrote file', 'cli tool: supports args-file JSON input');
  let cliBadJsonErr = '';
  const originalErr = process.stderr.write;
  (process.stderr.write as unknown as (chunk: unknown) => boolean) = (chunk: unknown) => {
    cliBadJsonErr += String(chunk);
    return true;
  };
  try {
    process.exitCode = 0;
    await runCliCommand(TEST_DIR, ['tool', 'write', '{bad-json', '--root', TEST_DIR]);
  } finally {
    process.stderr.write = originalErr;
  }
  assert(cliBadJsonErr.includes('Invalid JSON object') && process.exitCode === 1, 'cli tool: invalid JSON reports explicit error');
  process.exitCode = 0;
  const cliSendOut = await captureStdout(() => runCliCommand(TEST_DIR, ['send', 'hello from cli', '--root', TEST_DIR]));
  assert(cliSendOut.includes('[Error] No LLM configured'), 'cli send: routes through Agent process and reports missing provider');
  const cliLanguageSendOut = await captureStdout(() => runCliCommand(TEST_DIR, ['send', 'hello with language override', '--language', 'en', '--conversation', 'cli-language-input', '--root', TEST_DIR]));
  assert(cliLanguageSendOut.includes('[Error] No LLM configured'), 'cli send: accepts language override without treating it as prompt text');
  const cliLanguageStateOut = await captureStdout(() => runCliCommand(TEST_DIR, ['state', '--conversation', 'cli-language-input', '--root', TEST_DIR]));
  const cliLanguageState = JSON.parse(cliLanguageStateOut);
  assert(cliLanguageState.chatMessages >= 1 && cliLanguageState.conversations.some((c: any) => c.id === 'cli-language-input'), 'cli send: language override conversation persists normally');
  process.env.NEWMARK_TEST_CLI_PROMPT = 'hello from cli env prompt';
  const cliEnvSendOut = await captureStdout(() => runCliCommand(TEST_DIR, ['send', '--input-env', 'NEWMARK_TEST_CLI_PROMPT', '--conversation', 'cli-env-input', '--root', TEST_DIR]));
  assert(cliEnvSendOut.includes('[Error] No LLM configured'), 'cli send: accepts prompt from environment variable');
  delete process.env.NEWMARK_TEST_CLI_PROMPT;
  const cliInputFile = path.join(TEST_DIR, 'cli-input-prompt.txt');
  fs.writeFileSync(cliInputFile, 'hello from cli input file', 'utf-8');
  const cliFileSendOut = await captureStdout(() => runCliCommand(TEST_DIR, ['send', '--input-file', cliInputFile, '--conversation', 'cli-file-input', '--root', TEST_DIR]));
  assert(cliFileSendOut.includes('[Error] No LLM configured'), 'cli send: accepts prompt from input file');
  await captureStdout(() => runCliCommand(TEST_DIR, ['send', 'cli persistent turn one', '--conversation', 'cli-continuation', '--root', TEST_DIR]));
  const cliContinuationStateOut = await captureStdout(() => runCliCommand(TEST_DIR, ['state', '--conversation', 'cli-continuation', '--root', TEST_DIR]));
  const cliContinuationState = JSON.parse(cliContinuationStateOut);
  assert(cliContinuationState.conversationId === 'cli-continuation', 'cli state: accepts conversation id');
  assert(cliContinuationState.chatMessages >= 1 && cliContinuationState.historyMessages >= 1, 'cli conversation: persists send state across CLI invocations');
  assert(cliContinuationState.conversations.some((c: any) => c.id === 'cli-continuation'), 'cli conversation: lists persisted conversation');
  const cliEnvStateOut = await captureStdout(() => runCliCommand(TEST_DIR, ['state', '--conversation', 'cli-env-input', '--root', TEST_DIR]));
  assert(JSON.parse(cliEnvStateOut).chatMessages >= 1, 'cli send: env prompt persists to requested conversation');
  const cliFileStateOut = await captureStdout(() => runCliCommand(TEST_DIR, ['state', '--conversation', 'cli-file-input', '--root', TEST_DIR]));
  assert(JSON.parse(cliFileStateOut).chatMessages >= 1, 'cli send: input-file prompt persists to requested conversation');
  const originalCliValidate = LLMProvider.prototype.validate;
  const originalCliListModels = LLMProvider.prototype.listModels;
  const originalAgentFuzzyInject = Agent.prototype.fuzzyInject;
  LLMProvider.prototype.validate = async function(modelName: string) {
    return { ok: modelName === 'gpt-test' || modelName === 'gpt-5.5' || modelName === 'cli-fast' || modelName === 'claude-cli' || modelName === 'env-claude', latency: modelName === 'cli-fast' ? 0.3 : 0.8 };
  };
  try {
    const cliValidateOut = await captureStdout(() => runCliCommand(TEST_DIR, ['validate-models', '--selected', 'test-prov/gpt-test', '--root', TEST_DIR]));
    const cliValidate = JSON.parse(cliValidateOut);
    assert(Array.isArray(cliValidate) && cliValidate.some((r: any) => r.name === 'test-prov/gpt-test' && r.status === 'available'), 'cli validate-models: validates selected model');
    assert(!cliValidateOut.includes('test-key-123') && !cliValidateOut.includes('test-key-456'), 'cli validate-models: redacts provider API keys');
    new ConfigManager(TEST_DIR).updateModel('test-prov', 'gpt-5.5', { vision: false, description: 'CLI stale text-only validation metadata' });
    const cliVisionValidateOut = await captureStdout(() => runCliCommand(TEST_DIR, ['validate-models', '--selected', 'test-prov/gpt-5.5', '--root', TEST_DIR]));
    const cliVisionValidate = JSON.parse(cliVisionValidateOut);
    const cliVisionModel = new ConfigManager(TEST_DIR).findModel('gpt-5.5');
    assert(Array.isArray(cliVisionValidate) && cliVisionValidate.some((r: any) => r.name === 'test-prov/gpt-5.5' && r.vision_input === true), 'cli validate-models: infers GPT-5.5 vision input from model identity');
    assert(cliVisionModel?.vision === true && cliVisionModel?.evaluation?.vision_input === true, 'cli validate-models: persists inferred GPT-5.5 vision capability');
    LLMProvider.prototype.listModels = async function() {
      if (this.baseUrl.includes('cli-nebula.local')) return ['cli-fast', 'cli-pro'];
      if (this.baseUrl.includes('cli-anthropic.local')) return ['claude-cli'];
      return [];
    };
    Agent.prototype.fuzzyInject = async function() {
      throw new Error('CLI fuzzy-inject must use the release-safe lightweight path');
    };
    process.env.NEWMARK_TEST_FUZZY_ENDPOINT = 'https://cli-nebula.local/v1';
    process.env.NEWMARK_TEST_FUZZY_KEY = 'test-key-cli-redacted';
    const cliFuzzyOut = await captureStdout(() => runCliCommand(TEST_DIR, ['fuzzy-inject', '--name', 'CLINebula', '--endpoint-env', 'NEWMARK_TEST_FUZZY_ENDPOINT', '--key-env', 'NEWMARK_TEST_FUZZY_KEY', '--root', TEST_DIR]));
    const cliFuzzy = JSON.parse(cliFuzzyOut);
    assert(cliFuzzy.ok === true && cliFuzzy.provider === 'CLINebula' && cliFuzzy.models.includes('cli-fast'), 'cli fuzzy-inject: imports and validates listed model');
    assert(!cliFuzzyOut.includes('test-key-cli-redacted'), 'cli fuzzy-inject: does not print API key');
    const cliExistingFuzzyOut = await captureStdout(() => runCliCommand(TEST_DIR, ['fuzzy-inject', '--name', 'CLINebula', '--root', TEST_DIR]));
    const cliExistingFuzzy = JSON.parse(cliExistingFuzzyOut);
    assert(cliExistingFuzzy.ok === true && cliExistingFuzzy.models.includes('cli-fast'), 'cli fuzzy-inject: existing provider reuses saved endpoint and key');
    assert(!cliExistingFuzzyOut.includes('test-key-cli-redacted'), 'cli fuzzy-inject: existing provider does not print saved API key');
    process.env.NEWMARK_TEST_ANTHROPIC_ENDPOINT = 'https://cli-anthropic.local/anthropic';
    process.env.NEWMARK_TEST_ANTHROPIC_KEY = 'test-key-cli-anthropic';
    const cliAnthropicFuzzyOut = await captureStdout(() => runCliCommand(TEST_DIR, ['fuzzy-inject', '--name', 'CLIAnthropic', '--endpoint-env', 'NEWMARK_TEST_ANTHROPIC_ENDPOINT', '--key-env', 'NEWMARK_TEST_ANTHROPIC_KEY', '--protocol', 'anthropic', '--root', TEST_DIR]));
    const cliAnthropicFuzzy = JSON.parse(cliAnthropicFuzzyOut);
    const cliAnthropicProvider = new ConfigManager(TEST_DIR).providers().find(p => p.name === 'CLIAnthropic');
    assert(cliAnthropicFuzzy.ok === true && cliAnthropicFuzzy.models.includes('claude-cli'), 'cli fuzzy-inject: explicit anthropic protocol imports listed model');
    assert(cliAnthropicProvider?.protocol === 'anthropic', 'cli fuzzy-inject: persists explicit anthropic protocol');
    assert(!cliAnthropicFuzzyOut.includes('test-key-cli-anthropic'), 'cli fuzzy-inject: anthropic path does not print API key');
    const originalCliFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url) === 'https://api.cli-noguide.test/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'cli-noguide-fast' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    LLMProvider.prototype.validate = async function(modelName: string) {
      return { ok: modelName === 'cli-noguide-fast', latency: 0.5 };
    };
    process.env.NEWMARK_TEST_CLI_NOGUIDE_ENDPOINT = 'https://api.cli-noguide.test/v1/chat/completions';
    process.env.NEWMARK_TEST_CLI_NOGUIDE_KEY = 'sk-cli-noguide-redacted-12345678901234567890';
    const cliNoGuideRoot = path.join(TEST_DIR, 'cli-fuzzy-empty-root');
    const cliNoGuideOut = await captureStdout(() => runCliCommand(cliNoGuideRoot, ['fuzzy-inject', '--endpoint-env', 'NEWMARK_TEST_CLI_NOGUIDE_ENDPOINT', '--key-env', 'NEWMARK_TEST_CLI_NOGUIDE_KEY', '--root', cliNoGuideRoot]));
    const cliNoGuide = JSON.parse(cliNoGuideOut);
    const cliNoGuideProvider = new ConfigManager(cliNoGuideRoot).providers().find(p => p.name === 'CliNoguide');
    assert(cliNoGuide.ok === true && cliNoGuide.provider === 'CliNoguide' && cliNoGuide.models.includes('cli-noguide-fast'), 'cli fuzzy-inject: no-guide tokenizer infers provider and imports /models result');
    assert(cliNoGuideProvider?.base_url === 'https://api.cli-noguide.test/v1' && !cliNoGuideOut.includes('sk-cli-noguide-redacted'), 'cli fuzzy-inject: no-guide path normalizes endpoint and redacts key');
    globalThis.fetch = originalCliFetch;
    LLMProvider.prototype.validate = async function(modelName: string) {
      return { ok: modelName === 'gpt-test' || modelName === 'gpt-5.5' || modelName === 'cli-fast' || modelName === 'claude-cli' || modelName === 'env-claude', latency: modelName === 'cli-fast' ? 0.3 : 0.8 };
    };
    const cliEnvFile = path.join(TEST_DIR, 'claude code env.ps1');
    fs.writeFileSync(cliEnvFile, [
      '$env:ANTHROPIC_BASE_URL="https://cli-env-anthropic.local/anthropic"',
      '$env:ANTHROPIC_AUTH_TOKEN="test-key-cli-env"',
      '$env:ANTHROPIC_MODEL="env-claude"',
      '$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="env-claude"',
    ].join('\n'), 'utf-8');
    process.env.NEWMARK_TEST_CLAUDE_ENV_FILE = cliEnvFile;
    const cliEnvFuzzyOut = await captureStdout(() => runCliCommand(TEST_DIR, ['fuzzy-inject', '--env-file-env', 'NEWMARK_TEST_CLAUDE_ENV_FILE', '--root', TEST_DIR]));
    const cliEnvFuzzy = JSON.parse(cliEnvFuzzyOut);
    const cliEnvProvider = new ConfigManager(TEST_DIR).providers().find(p => p.name === 'ClaudeAnthropic');
    assert(cliEnvFuzzy.ok === true && cliEnvFuzzy.provider === 'ClaudeAnthropic' && cliEnvFuzzy.models.includes('env-claude'), 'cli fuzzy-inject: imports Anthropic env-file provider and candidate model');
    assert(cliEnvProvider?.protocol === 'anthropic' && cliEnvProvider?.api_key === 'test-key-cli-env', 'cli fuzzy-inject: persists env-file endpoint key and protocol');
    assert(!cliEnvFuzzyOut.includes('test-key-cli-env'), 'cli fuzzy-inject: env-file path does not print API key');
    const cliPreviewEnvFile = path.join(TEST_DIR, 'Claude code preview.txt');
    fs.writeFileSync(cliPreviewEnvFile, [
      '$env:ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"',
      '$env:ANTHROPIC_AUTH_TOKEN="test-key-cli-preview"',
      '$env:ANTHROPIC_MODEL="deepseek-v4-pro[1m]"',
      '$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-flash"',
    ].join('\r\n'), 'utf-8');
    process.env.NEWMARK_TEST_PREVIEW_CLAUDE_ENV_FILE = cliPreviewEnvFile;
    const providersBeforePreview = JSON.stringify(new ConfigManager(TEST_DIR).providers().map((p: any) => p.name));
    const cliPreviewOut = await captureStdout(() => runCliCommand(TEST_DIR, ['fuzzy-inject', '--env-file-env', 'NEWMARK_TEST_PREVIEW_CLAUDE_ENV_FILE', '--preview-only', '--root', TEST_DIR]));
    const cliPreview = JSON.parse(cliPreviewOut);
    const providersAfterPreview = JSON.stringify(new ConfigManager(TEST_DIR).providers().map((p: any) => p.name));
    assert(cliPreview.preview === true && cliPreview.provider === 'DeepSeekAnthropic' && cliPreview.protocol === 'anthropic', 'cli fuzzy-inject preview: parses real-style Claude env metadata');
    assert(cliPreview.has_api_key === true && cliPreview.models.includes('deepseek-v4-pro[1m]') && cliPreview.models.includes('deepseek-v4-flash'), 'cli fuzzy-inject preview: reports candidate models and key presence');
    assert(!cliPreviewOut.includes('test-key-cli-preview') && providersBeforePreview === providersAfterPreview, 'cli fuzzy-inject preview: does not leak key or persist provider');
    delete process.env.NEWMARK_TEST_PREVIEW_CLAUDE_ENV_FILE;
    const cliBadEnvFile = path.join(TEST_DIR, 'claude bad env.ps1');
    fs.writeFileSync(cliBadEnvFile, [
      '$env:NEWMARK_PROVIDER="BrokenAnthropic"',
      '$env:ANTHROPIC_BASE_URL="https://cli-bad-anthropic.local/anthropic"',
      '$env:ANTHROPIC_AUTH_TOKEN="test-key-cli-bad-env"',
      '$env:ANTHROPIC_MODEL="bad-env-claude"',
    ].join('\n'), 'utf-8');
    process.env.NEWMARK_TEST_BAD_CLAUDE_ENV_FILE = cliBadEnvFile;
    const cliBadEnvFuzzyOut = await captureStdout(() => runCliCommand(TEST_DIR, ['fuzzy-inject', '--env-file-env', 'NEWMARK_TEST_BAD_CLAUDE_ENV_FILE', '--root', TEST_DIR]));
    const cliBadEnvFuzzy = JSON.parse(cliBadEnvFuzzyOut);
    assert(cliBadEnvFuzzy.ok === false && cliBadEnvFuzzy.models.includes('bad-env-claude'), 'cli fuzzy-inject: imports env-file candidates even when validation fails');
    assert(cliBadEnvFuzzy.warning.includes('none validated as available') && cliBadEnvFuzzy.warning.includes('bad-env-claude: unavailable') && cliBadEnvFuzzy.warning.includes('Discovery:'), 'cli fuzzy-inject: failed validation warning includes model status and discovery context');
    assert(!cliBadEnvFuzzyOut.includes('test-key-cli-bad-env'), 'cli fuzzy-inject: failed env-file path does not print API key');
  } finally {
    delete process.env.NEWMARK_TEST_FUZZY_ENDPOINT;
    delete process.env.NEWMARK_TEST_FUZZY_KEY;
    delete process.env.NEWMARK_TEST_ANTHROPIC_ENDPOINT;
    delete process.env.NEWMARK_TEST_ANTHROPIC_KEY;
    delete process.env.NEWMARK_TEST_CLI_NOGUIDE_ENDPOINT;
    delete process.env.NEWMARK_TEST_CLI_NOGUIDE_KEY;
    delete process.env.NEWMARK_TEST_CLAUDE_ENV_FILE;
    delete process.env.NEWMARK_TEST_PREVIEW_CLAUDE_ENV_FILE;
    delete process.env.NEWMARK_TEST_BAD_CLAUDE_ENV_FILE;
    Agent.prototype.fuzzyInject = originalAgentFuzzyInject;
    LLMProvider.prototype.validate = originalCliValidate;
    LLMProvider.prototype.listModels = originalCliListModels;
  }
  const cliMarketDir = path.join(TEST_DIR, 'skills', 'cli-market-skill');
  fs.mkdirSync(cliMarketDir, { recursive: true });
  fs.writeFileSync(path.join(cliMarketDir, 'SKILL.md'), '# CliMarketNeedle\n\nSearchable skill body without frontmatter.\n', 'utf-8');
  const cliMarketOut = await captureStdout(() => runCliCommand(TEST_DIR, ['skills-market', '--query', 'CliMarketNeedle', '--root', TEST_DIR]));
  const cliMarket = JSON.parse(cliMarketOut);
  assert(cliMarket.query === 'CliMarketNeedle' && cliMarket.count >= 1 && cliMarket.items.some((s: any) => s.name === 'cli-market-skill'), 'cli skills-market: filters marketplace by query');
  const cliCatalogPath = path.join(TEST_DIR, 'cli-skill-market.json');
  fs.writeFileSync(cliCatalogPath, JSON.stringify({
    skills: [{
      name: 'cli-catalog-skill',
      description: 'CliCatalogNeedle market source entry',
      url: 'https://example.com/cli-catalog-skill/SKILL.md',
      license: 'MIT',
    }],
  }), 'utf-8');
  const cliAddSourceOut = await captureStdout(() => runCliCommand(TEST_DIR, ['skills-market', '--add-source', '--name', 'Cli Catalog', '--type', 'json', '--path', cliCatalogPath, '--root', TEST_DIR]));
  const cliAddSource = JSON.parse(cliAddSourceOut);
  assert(cliAddSource.ok === true && cliAddSource.sources.some((s: any) => s.id === 'cli-catalog'), 'cli skills-market sources: adds user JSON catalog source');
  const cliCatalogMarketOut = await captureStdout(() => runCliCommand(TEST_DIR, ['skills-market', '--query', 'CliCatalogNeedle', '--root', TEST_DIR]));
  const cliCatalogMarket = JSON.parse(cliCatalogMarketOut);
  assert(cliCatalogMarket.count === 1 && cliCatalogMarket.items[0].name === 'cli-catalog-skill' && cliCatalogMarket.items[0].marketSourceId === 'cli-catalog', 'cli skills-market sources: discovers skills from user catalog source');
  const cliDisableSourceOut = await captureStdout(() => runCliCommand(TEST_DIR, ['skills-market', '--disable-source', 'cli-catalog', '--root', TEST_DIR]));
  const cliDisableSource = JSON.parse(cliDisableSourceOut);
  assert(cliDisableSource.ok === true && cliDisableSource.sources.some((s: any) => s.id === 'cli-catalog' && s.enabled === false), 'cli skills-market sources: disables user source');
  const cliDisabledMarketOut = await captureStdout(() => runCliCommand(TEST_DIR, ['skills-market', '--query', 'CliCatalogNeedle', '--root', TEST_DIR]));
  const cliDisabledMarket = JSON.parse(cliDisabledMarketOut);
  assert(cliDisabledMarket.count === 0, 'cli skills-market sources: disabled source is not searched');
  const cliRemoveSourceOut = await captureStdout(() => runCliCommand(TEST_DIR, ['skills-market', '--remove-source', 'cli-catalog', '--root', TEST_DIR]));
  const cliRemoveSource = JSON.parse(cliRemoveSourceOut);
  assert(cliRemoveSource.ok === true && !cliRemoveSource.sources.some((s: any) => s.id === 'cli-catalog'), 'cli skills-market sources: removes user source');
  fs.rmSync(cliMarketDir, { recursive: true, force: true });

  // ---- 2b. Memory Lab Tests ----
  console.log('\nMemory Lab');
  const memoryLab = new MemoryLabManager(TEST_DIR);
  const memoryReadEmpty = memoryLab.read();
  assert(memoryReadEmpty.ok === true && fs.existsSync(memoryReadEmpty.indexPath) && memoryReadEmpty.instructions.includes('Memory Lab stores persistent local memory'), 'memory lab: initializes index and returns instructions');
  const memoryUpdate = memoryLab.update(memoryLab.prepareUpdate({
    name: '用于分析理论物理与数学的Skill',
    description: 'A theory and math analysis skill memory.',
    tags: ['#数学', '#物理-理论物理', '#Agent-Skill'],
    content: '# Theory Skill\n\nUse rigorous derivations.',
    kind: 'folder',
  }));
  assert(memoryUpdate.ok === true && !!memoryUpdate.slug && fs.existsSync(memoryUpdate.component?.coreMd || ''), 'memory lab: writes folder memory component core markdown');
  const memoryIndex = memoryUpdate.index;
  assert(!!memoryIndex.tags['#物理'] && memoryIndex.tags['#物理'].children.includes('#物理-理论物理'), 'memory lab: creates hierarchical parent tag link');
  assert(memoryIndex.tags['#物理-理论物理'].parents.includes('#物理') && memoryIndex.tags['#物理-理论物理'].components.includes(memoryUpdate.slug || ''), 'memory lab: links component only to deepest hierarchical tag');
  assert(memoryIndex.tags['#数学'].components.includes(memoryUpdate.slug || '') && memoryIndex.tags['#Agent-Skill'].components.includes(memoryUpdate.slug || ''), 'memory lab: links independent deepest tags to component');
  const readComponent = memoryLab.read(memoryUpdate.slug || '');
  assert(readComponent.ok === true && readComponent.component?.content.includes('rigorous derivations'), 'memory lab: reads component core markdown by slug');
  const duplicateTagUpdate = memoryLab.update(memoryLab.prepareUpdate({
    name: '用于分析理论物理与数学的Skill',
    description: 'Updated description.',
    tags: ['物理-理论物理', '#物理-理论物理', '#数学'],
    content: '# Theory Skill\n\nUpdated content.',
    kind: 'file',
  }));
  assert(duplicateTagUpdate.index.tags['#物理-理论物理'].components.filter((slug: string) => slug === duplicateTagUpdate.slug).length === 1, 'memory lab: reuses tags and avoids duplicate component links');
  const reindexedMemory = memoryLab.reindex();
  assert(reindexedMemory.ok === true && reindexedMemory.index.tags['#物理'].children.includes('#物理-理论物理'), 'memory lab: reindex preserves repaired tag graph');
  let traversalBlocked = false;
  try { memoryLab.prepareUpdate({ name: '..', tags: ['#bad'], content: 'bad' }); } catch { traversalBlocked = true; }
  assert(traversalBlocked, 'memory lab: rejects traversal-like invalid slug');
  const memoryCliContentPath = path.join(TEST_DIR, 'memory-cli-content.md');
  fs.writeFileSync(memoryCliContentPath, '# CLI Memory\n\nCliMemoryNeedle', 'utf-8');
  const cliMemoryUpdateOut = await captureStdout(() => runCliCommand(TEST_DIR, ['memory-lab', '--update', '--name', 'cli-memory', '--description', 'CLI memory', '--tags', '#CLI,#Agent-Skill', '--content-file', memoryCliContentPath, '--root', TEST_DIR]));
  const cliMemoryUpdate = JSON.parse(cliMemoryUpdateOut);
  assert(cliMemoryUpdate.ok === true && cliMemoryUpdate.index.tags['#CLI'].components.includes('cli-memory'), 'cli memory-lab: updates memory component from content file');
  const cliMemoryReadOut = await captureStdout(() => runCliCommand(TEST_DIR, ['memory-lab', '--component', 'cli-memory', '--root', TEST_DIR]));
  const cliMemoryRead = JSON.parse(cliMemoryReadOut);
  assert(cliMemoryRead.ok === true && cliMemoryRead.component.content.includes('CliMemoryNeedle') && cliMemoryRead.instructions.includes('index'), 'cli memory-lab: reads index instructions and component content');

  const updateSource = path.join(TEST_DIR, 'update-source');
  const updateTarget = path.join(TEST_DIR, 'update-target');
  fs.mkdirSync(path.join(updateSource, 'resources'), { recursive: true });
  fs.mkdirSync(path.join(updateTarget, 'Work'), { recursive: true });
  fs.writeFileSync(path.join(updateSource, 'Newmark Agent.exe'), 'new binary', 'utf-8');
  fs.writeFileSync(path.join(updateSource, 'resources', 'app.asar'), 'new asar', 'utf-8');
  fs.writeFileSync(path.join(updateSource, 'config.json'), 'source config must not overwrite', 'utf-8');
  fs.writeFileSync(path.join(updateTarget, 'config.json'), 'target local config', 'utf-8');
  fs.writeFileSync(path.join(updateTarget, 'Work', 'local.txt'), 'target workspace state', 'utf-8');
  const updateDryRun = installUpdate({ source: updateSource, target: updateTarget, expectedVersion: currentAppVersion(), dryRun: true });
  assert(updateDryRun.ok === true && updateDryRun.dryRun === true && updateDryRun.copied.includes('Newmark Agent.exe') && updateDryRun.preserved.includes('config.json'), 'install update: dry-run reports copied app files and preserved local state');
  const updateRun = installUpdate({ source: updateSource, target: updateTarget, expectedVersion: currentAppVersion() });
  assert(updateRun.ok === true && fs.readFileSync(path.join(updateTarget, 'Newmark Agent.exe'), 'utf-8') === 'new binary' && fs.readFileSync(path.join(updateTarget, 'resources', 'app.asar'), 'utf-8') === 'new asar', 'install update: copies app files into target');
  assert(fs.readFileSync(path.join(updateTarget, 'config.json'), 'utf-8') === 'target local config' && fs.readFileSync(path.join(updateTarget, 'Work', 'local.txt'), 'utf-8') === 'target workspace state', 'install update: preserves config and workspace data');
  const updateVersionFail = installUpdate({ source: updateSource, target: updateTarget, expectedVersion: '0.0.0' });
  assert(updateVersionFail.ok === false && String(updateVersionFail.error || '').includes('Version check failed'), 'install update: rejects unexpected version');
  const cliInstallVersionOut = await captureStdout(() => runCliCommand(TEST_DIR, ['install-update', '--version', '--root', TEST_DIR]));
  const cliInstallVersion = JSON.parse(cliInstallVersionOut);
  assert(cliInstallVersion.ok === true && cliInstallVersion.version === currentAppVersion(), 'cli install-update: reports current version');
  const cliInstallDryRunOut = await captureStdout(() => runCliCommand(TEST_DIR, ['install-update', '--source', updateSource, '--target', updateTarget, '--expected-version', currentAppVersion(), '--dry-run', '--root', TEST_DIR]));
  const cliInstallDryRun = JSON.parse(cliInstallDryRunOut);
  assert(cliInstallDryRun.ok === true && cliInstallDryRun.dryRun === true && cliInstallDryRun.preserved.includes('config.json'), 'cli install-update: dry-run preserves local state');
  const originalUpdateFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    tag_name: `v${currentAppVersion()}`,
    html_url: 'https://github.example/release',
    assets: [
      { name: `Newmark-Agent-${currentAppVersion()}-portable-x64.exe`, size: 10, browser_download_url: 'https://download.example/portable.exe', content_type: 'application/octet-stream' },
      { name: `Newmark-Agent-${currentAppVersion()}-win-unpacked-x64.zip`, size: 20, browser_download_url: 'https://download.example/win-unpacked.zip', content_type: 'application/zip' },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const githubUpdate = await checkGitHubUpdate('owner/repo');
  assert(githubUpdate.ok === true && githubUpdate.selectedAsset?.name.includes('win-unpacked') && githubUpdate.assets.length === 2, 'install update: GitHub release check selects compiled zip pack asset');
  const cliGithubCheckOut = await captureStdout(() => runCliCommand(TEST_DIR, ['install-update', '--check-github', '--repo', 'owner/repo', '--root', TEST_DIR]));
  const cliGithubCheck = JSON.parse(cliGithubCheckOut);
  assert(cliGithubCheck.ok === true && cliGithubCheck.selectedAsset?.name.includes('win-unpacked'), 'cli install-update: checks GitHub release and selects zip pack');
  globalThis.fetch = originalUpdateFetch;

  // ---- 3. Workspace Tests ----
  console.log('\n📁 Workspace Manager');
  const wsMgr = new WorkspaceManager(TEST_DIR, cfg);
  assert(wsMgr.internal.length >= 1, 'workspace: has auto-created internal');
  assert(wsMgr.current !== null, 'workspace: current is set');

  const ws1 = wsMgr.createInternal('test-ws-manual');
  assert(ws1.name === 'test-ws-manual', 'createInternal: correct name');
  assert(wsMgr.internal.length >= 2, 'createInternal: added to list');
  const internalBeforeDuplicate = wsMgr.internal.length;
  const wsDuplicate = wsMgr.createInternal('test-ws-manual');
  assert(wsDuplicate.path === ws1.path && wsMgr.internal.length === internalBeforeDuplicate, 'createInternal: same internal folder returns existing workspace instead of duplicating');

  wsMgr.select('test-ws-manual');
  assert(wsMgr.current?.name === 'test-ws-manual', 'select: switches workspace');
  const wsMgrReloaded = new WorkspaceManager(TEST_DIR, cfg);
  assert(wsMgrReloaded.current?.name === 'test-ws-manual', 'workspace: restores last selected workspace');
  const extBase = path.join(path.dirname(TEST_DIR), `${path.basename(TEST_DIR)}-external-unique`);
  const extChild = path.join(extBase, 'child');
  fs.mkdirSync(extChild, { recursive: true });
  const extWs = wsMgr.addExternal(extBase);
  const externalBeforeDuplicate = wsMgr.external.length;
  const extWsDuplicate = wsMgr.addExternal(extBase);
  assert(extWs && extWsDuplicate && extWsDuplicate.path === extWs.path && wsMgr.external.length === externalBeforeDuplicate, 'addExternal: same folder returns existing workspace instead of duplicating');
  const extChildWs = wsMgr.addExternal(extChild);
  assert(extChildWs && extChildWs.path !== extWs!.path && wsMgr.external.length === externalBeforeDuplicate + 1, 'addExternal: parent and child folders can be separate workspaces');
  const sshWs = wsMgr.addSshExternal({
    sshConnectionId: 'ssh-test-unique',
    remotePath: '/srv/newmark/project',
    remotePcHash: 'remote-pc-unique',
    remoteUserHost: 'user@example.local',
  });
  const sshBeforeDuplicate = wsMgr.external.length;
  const sshWsDuplicate = wsMgr.addSshExternal({
    name: 'renamed-duplicate',
    sshConnectionId: 'ssh-test-unique',
    remotePath: '/srv/newmark/project/',
    remotePcHash: 'remote-pc-unique',
    remoteUserHost: 'user@example.local',
  });
  assert(sshWs && sshWsDuplicate && sshWsDuplicate.path === sshWs.path && wsMgr.external.length === sshBeforeDuplicate, 'addSshExternal: same remote folder returns existing workspace instead of duplicating');
  const sshChildWs = wsMgr.addSshExternal({
    sshConnectionId: 'ssh-test-unique',
    remotePath: '/srv/newmark/project/child',
    remotePcHash: 'remote-pc-unique',
    remoteUserHost: 'user@example.local',
  });
  assert(sshChildWs && sshChildWs.path !== sshWs!.path && wsMgr.external.length === sshBeforeDuplicate + 1, 'addSshExternal: remote parent and child folders can be separate workspaces');

  // Write workspace agent.md
  fs.writeFileSync(path.join(ws1.path, 'agent.md'), '# Workspace prompt\nTest prompt.');
  wsMgr.select(ws1.name);
  const prompt = wsMgr.currentAgentPrompt();
  assert(prompt?.includes('Test prompt'), 'currentAgentPrompt: reads workspace prompt');

  // Access check
  const wsAccess = wsMgr.checkAccess(path.join(ws1.path, 'file.txt'));
  assert(wsAccess === true, 'checkAccess: inside workspace OK');
  cfg.set('workspace', 'access_permission', 'no_outside_access');
  wsMgr.select(ws1.name);
  const siblingPath = path.join(path.dirname(ws1.path), path.basename(ws1.path) + '-sibling', 'file.txt');
  assert(wsMgr.checkAccess(siblingPath) === false, 'checkAccess: sibling prefix path is outside workspace');
  cfg.set('workspace', 'access_permission', 'full_access');

  // Remove workspace
  const removed = wsMgr.remove(ws1.name);
  assert(removed === true, 'remove: returns true');
  assert(wsMgr.internal.find(w => w.name === ws1.name) === undefined, 'remove: removed from list');
  assert(!fs.existsSync(ws1.path), 'remove: deleted internal workspace directory');
  const wsNested = wsMgr.createInternal('test-ws-delete-nested');
  const wsNestedStateDir = path.join(wsNested.path, 'conversations');
  fs.mkdirSync(wsNestedStateDir, { recursive: true });
  const wsNestedStateFile = path.join(wsNestedStateDir, 'state.json');
  fs.writeFileSync(wsNestedStateFile, '{"ok":true}', 'utf-8');
  try { fs.chmodSync(wsNestedStateFile, 0o400); } catch {}
  const removedNested = wsMgr.remove(wsNested.name);
  assert(removedNested === true, 'remove: deletes workspace with nested conversation state');
  assert(!fs.existsSync(wsNested.path), 'remove: nested conversation state directory removed');
  const removedMissing = wsMgr.remove('nonexistent');
  assert(removedMissing === false, 'remove: nonexistent returns false');

  // ---- 4. Subagent Tests ----
  console.log('\n🤖 Subagent Manager');
  const subMgr = new SubagentManager();
  const subId = subMgr.create('test-sub', 'Do something', 'gpt-4', 'guide', 'build');
  assert(subId.length > 0, 'create: returns ID');
  assert(subMgr.listActive().length === 1, 'listActive: 1 active');

  const sub = subMgr.get(subId);
  assert(sub?.name === 'test-sub', 'get: correct name');
  assert(sub?.status === 'working', 'get: status working');

  const sent = subMgr.send(subId, 'Continue work');
  assert(sent === true && sub?.messages.length === 3, 'send: adds message');

  subMgr.complete(subId, 'Subagent completed result');
  assert(sub?.status === 'completed', 'complete: marks completed');
  assert(subMgr.getResult(subId).includes('completed result'), 'complete: stores result');
  const subRecord = subMgr.toRecord(subId);
  assert(subRecord?.active === true && subRecord.mode === 'build' && !!subRecord.startedAt && !!subRecord.completedAt, 'subagent compat: record exposes stable structured fields');
  const subEnvelope = subMgr.toToolResult(subId, 'subagent envelope output');
  assert(subEnvelope.ok === true && subEnvelope.data?.id === subId && subEnvelope.output.includes('envelope'), 'subagent compat: tool result envelope carries record data');

  const resent = subMgr.send(subId, 'Continue after result');
  assert(resent === true && sub?.status === 'working', 'send: can continue completed subagent');

  subMgr.close(subId);
  assert(subMgr.listActive().length === 0, 'close: becomes inactive');
  assert(subMgr.listAll().length === 1, 'listAll: still exists');
  assert(subMgr.send(subId, 'Blocked after close') === false, 'send: refuses closed subagent');

  const result = subMgr.getResult(subId);
  assert(typeof result === 'string', 'getResult: returns string');

  // Second subagent - different mode
  subMgr.create('plan-sub', 'Plan something', 'gpt-4', 'next', 'plan');
  assert(subMgr.listAll().length === 2, 'multiple subagents coexist');

  subMgr.remove(subId);
  assert(subMgr.listAll().length === 1, 'remove: deletes subagent');

  const taskAgent = new Agent(TEST_DIR);
  const subProvider = new FakeProvider(['subagent first result', 'subagent continued result']);
  (taskAgent as unknown as { engineModel: () => FakeProvider }).engineModel = () => subProvider;
  const createdSub = await (taskAgent as unknown as { handleSubagent: (args: string) => Promise<string> })
    .handleSubagent(JSON.stringify({ name: 'worker', prompt: 'Do delegated work', model: 'test-model', input_mode: 'next', mode: 'plan' }));
  const worker = taskAgent.subagents.get('worker');
  assert(createdSub.includes('subagent first result'), 'Agent task: runs subagent through provider');
  assert(worker?.status === 'completed', 'Agent task: completed status recorded');
  assert(worker?.model === 'test-model' && worker?.inputMode === 'next' && worker?.agentMode === 'plan', 'Agent task: preserves requested model/input/mode');
  const continuedSub = await (taskAgent as unknown as { handleSubagentContinue: (args: string) => Promise<string> })
    .handleSubagentContinue(JSON.stringify({ name: 'worker', prompt: 'Continue delegated work' }));
  assert(continuedSub.includes('subagent continued result'), 'Agent subagent_send: continues existing subagent');
  const subResult = (taskAgent as unknown as { handleSubagentResult: (args: string) => string })
    .handleSubagentResult(JSON.stringify({ name: 'worker' }));
  assert(subResult.includes('get.subagent("worker")') && subResult.includes('subagent continued result'), 'Agent subagent_result: returns result and transcript');
  const closeSub = (taskAgent as unknown as { handleSubagentClose: (args: string) => string })
    .handleSubagentClose(JSON.stringify({ name: 'worker' }));
  assert(closeSub.includes('closed') && taskAgent.subagents.get('worker')?.status === 'closed', 'Agent subagent_close: closes subagent');
  const workerRecord = taskAgent.subagents.toRecord('worker');
  assert(workerRecord?.active === false && !!workerRecord.closedAt && !!workerRecord.result?.includes('subagent continued result'), 'Agent subagent compat: retained closed record has result and closedAt');

  const subagentToolFile = path.join(taskAgent.workspace.current?.path || TEST_DIR, 'subagent-tool.txt');
  let toolCallRound = 0;
  const toolProvider = {
    modelsSeen: [] as string[],
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 100 }),
    async *chatStreamWithTools(modelName: string): AsyncGenerator<StreamToken> {
      this.modelsSeen.push(modelName);
      if (toolCallRound++ === 0) {
        yield {
          type: 'tool_call',
          text: '',
          toolCall: {
            id: 'sub-write-1',
            name: 'write',
            arguments: JSON.stringify({ path: subagentToolFile, content: 'from isolated subagent' }),
          },
        };
      } else {
        yield { type: 'text', text: 'subagent used write tool and verified work' };
      }
    },
    async chat(): Promise<string> { return 'unused'; },
  };
  (taskAgent as unknown as { engineModel: () => typeof toolProvider }).engineModel = () => toolProvider;
  const toolSub = await (taskAgent as unknown as { handleSubagent: (args: string) => Promise<string> })
    .handleSubagent(JSON.stringify({ name: 'tool-worker', prompt: 'Write a delegated file', model: 'fixed-child-model', mode: 'build' }));
  assert(fs.existsSync(subagentToolFile), 'Agent task sandbox: subagent can execute allowed file tools');
  assert(fs.readFileSync(subagentToolFile, 'utf-8') === 'from isolated subagent', 'Agent task sandbox: tool writes into active workspace');
  assert(toolSub.includes('subagent used write tool'), 'Agent task sandbox: returns child agent result');
  assert(toolProvider.modelsSeen.every(m => m === 'fixed-child-model'), 'Agent task sandbox: uses parent-assigned fixed model');

  const blockedPlanFile = path.join(taskAgent.workspace.current?.path || TEST_DIR, 'blocked-plan-subagent.txt');
  let planRound = 0;
  const planProvider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 100 }),
    async *chatStreamWithTools(): AsyncGenerator<StreamToken> {
      if (planRound++ === 0) {
        yield {
          type: 'tool_call',
          text: '',
          toolCall: {
            id: 'sub-plan-write-1',
            name: 'write',
            arguments: JSON.stringify({ path: blockedPlanFile, content: 'should not write' }),
          },
        };
      } else {
        yield { type: 'text', text: 'plan subagent observed the guard' };
      }
    },
    async chat(): Promise<string> { return 'unused'; },
  };
  (taskAgent as unknown as { engineModel: () => typeof planProvider }).engineModel = () => planProvider;
  const planSub = await (taskAgent as unknown as { handleSubagent: (args: string) => Promise<string> })
    .handleSubagent(JSON.stringify({ name: 'plan-tool-worker', prompt: 'Try plan write', model: 'fixed-child-model', mode: 'plan' }));
  assert(!fs.existsSync(blockedPlanFile), 'Agent task sandbox: Plan subagent cannot write non-README files');
  assert(planSub.includes('Plan mode') || planSub.includes('observed the guard'), 'Agent task sandbox: Plan guard result returns to parent');

  let blockedToolRound = 0;
  const blockedToolProvider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 100 }),
    async *chatStreamWithTools(): AsyncGenerator<StreamToken> {
      if (blockedToolRound++ === 0) {
        yield {
          type: 'tool_call',
          text: '',
          toolCall: {
            id: 'sub-skill-1',
            name: 'skill_download',
            arguments: JSON.stringify({ name: 'blocked-sub-skill', source: 'https://example.com/SKILL.md' }),
          },
        };
      } else {
        yield { type: 'text', text: 'blocked tool was rejected' };
      }
    },
    async chat(): Promise<string> { return 'unused'; },
  };
  (taskAgent as unknown as { engineModel: () => typeof blockedToolProvider }).engineModel = () => blockedToolProvider;
  const blockedToolSub = await (taskAgent as unknown as { handleSubagent: (args: string) => Promise<string> })
    .handleSubagent(JSON.stringify({ name: 'blocked-tool-worker', prompt: 'Try installing skill', model: 'fixed-child-model', mode: 'build' }));
  assert(blockedToolSub.includes('disabled for subagents') || blockedToolSub.includes('blocked tool was rejected'), 'Agent task sandbox: management tools are blocked for subagents');
  assert(!fs.existsSync(path.join(TEST_DIR, 'skills', 'blocked-sub-skill')), 'Agent task sandbox: blocked skill tool does not install files');

  const presetAgentDir = path.join(TEST_DIR, '.codex', 'agents');
  fs.mkdirSync(presetAgentDir, { recursive: true });
  fs.writeFileSync(path.join(presetAgentDir, 'preset-worker.toml'), 'name = "preset-worker"\ndescription = "Preset-backed worker."\nmodel = "preset-model"\nmode = "plan"\ninput_mode = "next"\ntools = ["read", "grep"]\ndisallowed_tools = ["write"]\ndeveloper_instructions = """\nUse the preset instructions.\n"""\n', 'utf-8');
  const presetProvider = new FakeProvider(['preset subagent result']);
  (taskAgent as unknown as { engineModel: () => FakeProvider }).engineModel = () => presetProvider;
  const presetSub = await (taskAgent as unknown as { handleSubagent: (args: string) => Promise<string> })
    .handleSubagent(JSON.stringify({ preset: 'preset-worker', prompt: 'Run with preset' }));
  const presetWorker = taskAgent.subagents.get('preset-worker');
  assert(presetSub.includes('preset subagent result'), 'Agent task preset: runs normalized agent preset as subagent');
  assert(presetWorker?.model === 'preset-model' && presetWorker?.agentMode === 'plan' && presetWorker?.inputMode === 'next', 'Agent task preset: maps preset model mode and input mode');
  assert(JSON.stringify(presetWorker?.metadata || {}).includes('disallowedTools') && presetWorker?.prompt.includes('Use the preset instructions.'), 'Agent task preset: preserves preset metadata and instructions');

  // ---- 5. Skills Tests ----
  console.log('\n📦 Skills Manager');
  const skMgr = new SkillsManager(TEST_DIR);
  assert(skMgr.list().length === 0, 'skills: empty initially');
  assert(skMgr.count() === 0, 'count: 0');

  // Create a skill directory manually
  fs.mkdirSync(path.join(TEST_DIR, 'skills', 'test-skill'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'skills', 'test-skill', 'SKILL.md'), '# Test Skill');
  const skMgr2 = new SkillsManager(TEST_DIR);
  assert(skMgr2.count() === 1, 'skills: detects skill');
  assert(skMgr2.has('test-skill'), 'has: finds skill');
  assert(skMgr2.listDetailed()[0].enabled === true, 'skills: enabled by default');
  assert(skMgr2.setEnabled('test-skill', false) === true, 'skills: can disable skill');
  assert(skMgr2.active().length === 0, 'skills: disabled skill not active');
  assert(skMgr2.setEnabled('test-skill', true) === true, 'skills: can re-enable skill');
  assert(skMgr2.active().some(s => s.name === 'test-skill'), 'skills: enabled skill is active');
  const localSkillSource = path.join(TEST_DIR, 'local-source-skill');
  fs.mkdirSync(localSkillSource, { recursive: true });
  fs.writeFileSync(path.join(localSkillSource, 'SKILL.md'), '---\nname: local-copy-skill\ndescription: Local copy test\n---\n# Local');
  assert(skMgr2.installFromLocal(localSkillSource) === true, 'skills: install from local source');
  assert(skMgr2.has('local-copy-skill'), 'skills: local install exists');
  const userMarketSkillRoot = path.join(TEST_DIR, 'user-market-source');
  const userMarketSkillDir = path.join(userMarketSkillRoot, 'user-market-skill');
  fs.mkdirSync(userMarketSkillDir, { recursive: true });
  fs.writeFileSync(path.join(userMarketSkillDir, 'SKILL.md'), '---\nname: user-market-skill\ndescription: User managed market source skill.\n---\n# User Market Skill', 'utf-8');
  const userSource = skMgr2.addMarketSource({ name: 'User Local Market', type: 'local-dir', path: userMarketSkillRoot });
  assert(userSource.id === 'user-local-market' && skMgr2.listMarketSources().some(s => s.id === 'user-local-market'), 'skills market sources: adds and lists user local-dir source');
  assert(skMgr2.discoverMarket().some(s => s.name === 'user-market-skill' && s.marketSourceId === 'user-local-market'), 'skills market sources: discovers skills from user local-dir source');
  assert(skMgr2.setMarketSourceEnabled('user-local-market', false) === true, 'skills market sources: disables user source');
  assert(!skMgr2.discoverMarket().some(s => s.name === 'user-market-skill'), 'skills market sources: disabled source is hidden');
  assert(skMgr2.setMarketSourceEnabled('user-local-market', true) === true && skMgr2.removeMarketSource('user-local-market') === true, 'skills market sources: re-enables and removes user source');
  assert(!skMgr2.listMarketSources().some(s => s.id === 'user-local-market'), 'skills market sources: removed user source is not listed');
  const codexSkillDir = path.join(TEST_DIR, '.agents', 'skills', 'codex-style-skill');
  fs.mkdirSync(codexSkillDir, { recursive: true });
  fs.writeFileSync(path.join(codexSkillDir, 'SKILL.md'), '---\nname: codex-style-skill\ndescription: Codex compatible skill.\nlicense: MIT\nallowed-tools: [read, grep]\n---\n# Codex Skill', 'utf-8');
  const claudeSkillDir = path.join(TEST_DIR, '.claude', 'skills', 'claude-style-skill');
  fs.mkdirSync(claudeSkillDir, { recursive: true });
  fs.writeFileSync(path.join(claudeSkillDir, 'SKILL.md'), '---\nname: claude-style-skill\ndescription: Claude compatible skill.\n---\n# Claude Skill', 'utf-8');
  const codexPluginRoot = path.join(TEST_DIR, 'fixture-codex-plugin');
  fs.mkdirSync(path.join(codexPluginRoot, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(codexPluginRoot, 'skills', 'plugin-skill'), { recursive: true });
  fs.writeFileSync(path.join(codexPluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'fixture-codex-plugin',
    version: '1.0.0',
    description: 'Codex fixture',
    skills: './skills',
    hooks: './hooks',
    mcpServers: { codexDocs: { command: 'node' } },
  }), 'utf-8');
  fs.writeFileSync(path.join(codexPluginRoot, 'skills', 'plugin-skill', 'SKILL.md'), '---\nname: plugin-skill\ndescription: Plugin packaged skill.\n---\n# Plugin Skill', 'utf-8');
  fs.mkdirSync(path.join(TEST_DIR, '.agents', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
    name: 'fixture-marketplace',
    plugins: [
      {
        name: 'fixture-codex-plugin',
        displayName: 'Fixture Codex Plugin',
        description: 'Marketplace fixture.',
        category: 'testing',
        source: { type: 'local', path: '../../fixture-codex-plugin' },
        policy: { installation: 'manual-review' },
      },
    ],
  }), 'utf-8');
  const claudePluginRoot = path.join(TEST_DIR, 'fixture-claude-plugin');
  fs.mkdirSync(path.join(claudePluginRoot, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(claudePluginRoot, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(claudePluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'fixture-claude-plugin',
    description: 'Claude fixture',
    agents: './agents',
    commands: './commands',
    hooks: './hooks',
    mcpServers: { docs: { command: 'node' } },
    lspServers: { tsserver: { command: 'typescript-language-server' } },
    themes: './themes',
    outputStyles: './styles',
    dependencies: ['@example/claude-plugin'],
  }), 'utf-8');
  fs.writeFileSync(path.join(claudePluginRoot, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Review code.\nmodel: sonnet\n---\nReview.', 'utf-8');
  const newmarkPluginRoot = path.join(TEST_DIR, 'fixture-newmark-plugin');
  fs.mkdirSync(path.join(newmarkPluginRoot, '.newmark-plugin'), { recursive: true });
  fs.writeFileSync(path.join(newmarkPluginRoot, '.newmark-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture-newmark-plugin', version: '0.1.0', tools: './tools', trusted: false }), 'utf-8');
  const codexAgentDir = path.join(TEST_DIR, '.codex', 'agents');
  fs.mkdirSync(codexAgentDir, { recursive: true });
  fs.writeFileSync(path.join(codexAgentDir, 'worker.toml'), 'name = "worker"\ndescription = "Implementation worker."\nmodel = "gpt-5-codex"\ndeveloper_instructions = """\nImplement carefully.\n"""\n', 'utf-8');
  const claudeAgentDir = path.join(TEST_DIR, '.claude', 'agents');
  fs.mkdirSync(claudeAgentDir, { recursive: true });
  fs.writeFileSync(path.join(claudeAgentDir, 'debugger.md'), '---\nname: debugger\ndescription: Debug failures.\nmodel: sonnet\nmaxTurns: 5\ntools: [read, grep]\n---\nDebug with evidence.', 'utf-8');
  fs.mkdirSync(path.join(TEST_DIR, '.opencode', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, '.opencode', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, '.opencode', 'tools', 'hello.ts'), 'export default {};\n', 'utf-8');
  fs.writeFileSync(path.join(TEST_DIR, '.opencode', 'tools', 'echo.cjs'), 'module.exports = { execute: async (args) => ({ echoed: args.text || "", count: Number(args.count || 0) }) };\n', 'utf-8');
  fs.writeFileSync(path.join(TEST_DIR, '.opencode', 'plugins', 'hook.ts'), 'export default {};\n', 'utf-8');
  fs.writeFileSync(path.join(TEST_DIR, 'opencode.json'), JSON.stringify({
    plugin: ['@opencode/plugin-example'],
    mcp: { context7: { type: 'local', command: ['npx', '-y', '@upstash/context7-mcp'] } },
  }), 'utf-8');
  const marketSkills = skMgr2.discoverMarket();
  assert(marketSkills.some(s => s.name === 'codex-style-skill' && s.source === 'codex' && s.allowedTools?.includes('read')), 'skills compat: discovers repo .agents skills with metadata');
  assert(marketSkills.some(s => s.name === 'claude-style-skill' && s.source === 'claude'), 'skills compat: discovers repo .claude skills');
  assert(marketSkills.some(s => s.name === 'plugin-skill' && s.source === 'plugin' && s.pluginId === 'fixture-codex-plugin'), 'skills compat: discovers plugin-packaged skills');
  const pluginManifests = discoverPluginManifests(TEST_DIR);
  assert(pluginManifests.some(p => p.ecosystem === 'codex' && p.name === 'fixture-codex-plugin' && p.components.skills?.some(s => s.endsWith('skills')) && p.components.mcpServers?.includes('codexDocs')), 'plugins compat: normalizes Codex plugin manifest and MCP metadata');
  assert(pluginManifests.some(p => p.ecosystem === 'claude-code' && p.name === 'fixture-claude-plugin' && p.components.agents?.some(a => a.endsWith('agents')) && p.components.lspServers?.includes('tsserver') && p.components.dependencies?.includes('@example/claude-plugin')), 'plugins compat: normalizes Claude Code plugin components');
  assert(pluginManifests.some(p => p.ecosystem === 'newmark' && p.name === 'fixture-newmark-plugin' && p.trustLevel === 'metadata-only'), 'plugins compat: normalizes Newmark-native plugin manifest');
  assert(pluginManifests.some(p => p.ecosystem === 'opencode' && p.components.tools?.some(t => t.endsWith('hello.ts')) && p.components.mcpServers?.includes('context7') && p.components.dependencies?.includes('@opencode/plugin-example')), 'plugins compat: discovers OpenCode tool, MCP, and package metadata');
  assert(pluginManifests.some(p => p.warnings?.some(w => w.includes('not auto-started') || w.includes('metadata only'))), 'plugins compat: reports non-executed hooks/MCP as warnings');
  const marketplaceEntries = discoverPluginMarketplaces(TEST_DIR);
  assert(marketplaceEntries.some(entry => entry.name === 'fixture-codex-plugin' && entry.marketplace === 'fixture-marketplace' && entry.installed === true), 'plugins compat: discovers Codex-style plugin marketplace entries');
  const openCodeTools = discoverOpenCodeTools(TEST_DIR);
  assert(openCodeTools.some(t => t.name === 'echo' && t.executable === true && t.source === 'project') && openCodeTools.some(t => t.name === 'hello' && t.executable === false && t.exportStyle === 'metadata-only'), 'opencode compat: distinguishes executable JS tools from TS metadata');
  const openCodeToolRun = await runOpenCodeTool(TEST_DIR, 'echo', { text: 'hi', count: 2 });
  assert(openCodeToolRun.ok === true && (openCodeToolRun.data as any).echoed === 'hi' && openCodeToolRun.output.includes('"count": 2'), 'opencode compat: executes explicit local JS custom tool');
  const openCodeToolTsRun = await runOpenCodeTool(TEST_DIR, 'hello', {});
  assert(openCodeToolTsRun.ok === false && openCodeToolTsRun.error?.includes('TypeScript'), 'opencode compat: refuses TS tool execution without transpilation');
  const agentPresets = discoverAgentPresets(TEST_DIR);
  assert(agentPresets.some(a => a.ecosystem === 'codex' && a.name === 'worker' && a.instructions?.includes('Implement carefully')), 'agents compat: normalizes Codex TOML agent preset');
  assert(agentPresets.some(a => a.ecosystem === 'claude-code' && a.name === 'debugger' && a.tools?.includes('read') && a.maxTurns === 5), 'agents compat: normalizes Claude markdown agent preset');
  assert(agentPresets.some(a => a.ecosystem === 'claude-code' && a.name === 'reviewer' && a.path.endsWith('reviewer.md')), 'agents compat: normalizes plugin-packaged agent preset');
  const cliCompatPluginsOut = await captureStdout(() => runCliCommand(TEST_DIR, ['compat', '--target', 'plugins', '--root', TEST_DIR]));
  assert(JSON.parse(cliCompatPluginsOut).plugins.some((p: any) => p.name === 'fixture-codex-plugin'), 'cli compat: exposes normalized plugin manifests');
  const cliCompatAllOut = await captureStdout(() => runCliCommand(TEST_DIR, ['compat', '--target', 'all', '--root', TEST_DIR]));
  const cliCompatAll = JSON.parse(cliCompatAllOut);
  assert(cliCompatAll.tools && cliCompatAll.plugins && cliCompatAll.skills && cliCompatAll.agents && cliCompatAll.subagent_schema, 'cli compat: target all exposes every compatibility surface');
  assert(cliCompatAll.marketplaces.some((entry: any) => entry.name === 'fixture-codex-plugin'), 'cli compat: target all exposes plugin marketplace entries');
  assert(cliCompatAll.plugins.some((p: any) => p.ecosystem === 'opencode' && p.components.mcpServers?.includes('context7')), 'cli compat: target all includes OpenCode MCP metadata');
  const cliCompatMarketplacesOut = await captureStdout(() => runCliCommand(TEST_DIR, ['compat', '--target', 'marketplaces', '--root', TEST_DIR]));
  assert(JSON.parse(cliCompatMarketplacesOut).marketplaces.some((entry: any) => entry.marketplace === 'fixture-marketplace'), 'cli compat: exposes plugin marketplace target');
  const cliCompatToolListOut = await captureStdout(() => runCliCommand(TEST_DIR, ['compat-tool', '--list', '--root', TEST_DIR]));
  assert(JSON.parse(cliCompatToolListOut).tools.some((t: any) => t.name === 'echo' && t.executable === true), 'cli compat-tool: lists OpenCode custom tools');
  const cliCompatToolRunOut = await captureStdout(() => runCliCommand(TEST_DIR, ['compat-tool', '--name', 'echo', JSON.stringify({ text: 'cli', count: 3 }), '--root', TEST_DIR]));
  const cliCompatToolRun = JSON.parse(cliCompatToolRunOut);
  assert(cliCompatToolRun.ok === true && cliCompatToolRun.data.echoed === 'cli' && cliCompatToolRun.data.count === 3, 'cli compat-tool: executes explicit OpenCode JS custom tool');
  const cliCompatAgentsOut = await captureStdout(() => runCliCommand(TEST_DIR, ['compat', '--target', 'agents', '--root', TEST_DIR]));
  assert(JSON.parse(cliCompatAgentsOut).agents.some((a: any) => a.name === 'worker'), 'cli compat: exposes normalized agent presets');
  const cliCompatSkillsOut = await captureStdout(() => runCliCommand(TEST_DIR, ['compat', '--target', 'skills', '--root', TEST_DIR]));
  assert(JSON.parse(cliCompatSkillsOut).skills.some((s: any) => s.name === 'codex-style-skill'), 'cli compat: exposes compatible skill discovery');
  const cliCompatSubagentsOut = await captureStdout(() => runCliCommand(TEST_DIR, ['compat', '--target', 'subagents', '--root', TEST_DIR]));
  assert(JSON.parse(cliCompatSubagentsOut).subagent_schema.record_fields.includes('closedAt'), 'cli compat: exposes subagent return schema');

  skMgr2.remove('test-skill');
  skMgr2.remove('local-copy-skill');
  assert(skMgr2.count() === 0, 'remove: skill deleted');

  // ---- 5b. Automation Tests ----
  console.log('\n�?Automation Manager');
  const autoCfg = new ConfigManager(TEST_DIR);
  autoCfg.set('automation', 'schedules', []);
  autoCfg.save();
  const autoRuns: string[] = [];
  const autoMgr = new AutomationManager(autoCfg, async (prompt, model) => {
    autoRuns.push(`${model}:${prompt}`);
    if (prompt === 'Fail task') throw new Error('planned automation failure');
    return `ran ${prompt}`;
  }, 50);
  const onceAuto = autoMgr.create({ prompt: 'Run once', model: 'm1', condition: 'once', active: true });
  assert(onceAuto.active === true && onceAuto.status === 'scheduled', 'automation: create active schedule');
  await autoMgr.tick(new Date(Date.now() + 1000));
  const onceAfter = autoMgr.list().find(a => a.id === onceAuto.id);
  assert(autoRuns.includes('m1:Run once'), 'automation: once executes runner');
  assert(onceAfter?.status === 'completed' && onceAfter.active === false, 'automation: once completes and deactivates');
  assert(onceAfter?.lastResult.includes('ran Run once'), 'automation: stores last result');

  const loopAuto = autoMgr.create({ prompt: 'Loop task', model: 'm2', condition: 'loop', intervalSec: 10, active: true });
  await autoMgr.tick(new Date(Date.now() + 2000));
  const loopAfter = autoMgr.list().find(a => a.id === loopAuto.id);
  assert(loopAfter?.active === true && loopAfter?.status === 'scheduled', 'automation: loop remains scheduled');
  assert(!!loopAfter?.nextRunAt, 'automation: loop calculates next run');
  const toggledAuto = autoMgr.toggle(loopAuto.id);
  assert(toggledAuto?.active === false && toggledAuto?.status === 'paused', 'automation: toggle pauses');
  assert(autoMgr.delete(loopAuto.id) === true, 'automation: delete removes schedule');
  const persistedAuto = new ConfigManager(TEST_DIR).get<any[]>('automation', 'schedules') || [];
  assert(persistedAuto.length === 1 && persistedAuto[0].id === onceAuto.id, 'automation: persists schedules to config');

  const failAuto = autoMgr.create({ prompt: 'Fail task', model: 'm-fail', condition: 'once', active: true });
  await autoMgr.tick(new Date(Date.now() + 3000));
  const failAfter = autoMgr.list().find(a => a.id === failAuto.id);
  assert(failAfter?.status === 'error' && failAfter?.active === false, 'automation: runner failure deactivates schedule');
  assert(failAfter?.lastError.includes('planned automation failure'), 'automation: runner failure stores error message');

  let releaseSlowRun!: () => void;
  let slowRunCount = 0;
  const slowRoot = path.join(TEST_DIR, 'automation-slow');
  fs.mkdirSync(slowRoot, { recursive: true });
  const slowCfg = new ConfigManager(slowRoot);
  slowCfg.set('automation', 'schedules', []);
  slowCfg.save();
  const slowMgr = new AutomationManager(slowCfg, async () => {
    slowRunCount += 1;
    await new Promise<void>(resolve => { releaseSlowRun = resolve; });
    return 'slow complete';
  }, 50);
  const slowAuto = slowMgr.create({ prompt: 'Slow task', model: 'm-slow', condition: 'once', active: true });
  const firstSlowTick = slowMgr.tick(new Date(Date.now() + 4000));
  await new Promise(resolve => setTimeout(resolve, 20));
  await slowMgr.tick(new Date(Date.now() + 5000));
  assert(slowRunCount === 1, 'automation: running schedule is not re-entered by concurrent tick');
  releaseSlowRun();
  await firstSlowTick;
  const slowAfter = slowMgr.list().find(a => a.id === slowAuto.id);
  assert(slowAfter?.runCount === 1 && slowAfter?.lastResult === 'slow complete', 'automation: concurrent tick leaves one completed run');

  const wakeCalls: Array<{ command: string; args: string[] }> = [];
  const wake = new AutomationWakeScheduler(TEST_DIR, 'C:\\Newmark\\Newmark Agent.exe', (command, args) => {
    wakeCalls.push({ command, args });
    return { ok: true, command, args };
  });
  const futureA = autoMgr.create({ prompt: 'Wake later', model: 'm3', condition: 'loop', intervalSec: 60, startAt: '2030-01-01T12:00', active: true });
  const futureB = autoMgr.create({ prompt: 'Wake sooner', model: 'm4', condition: 'loop', intervalSec: 60, startAt: '2030-01-01T11:00', active: true });
  const nextWake = wake.nextActiveRun(autoMgr.list(), new Date('2029-01-01T00:00:00Z'));
  assert(nextWake?.id === futureB.id, 'automation wake: chooses earliest active next run');
  const xmlPath = wake.writeWindowsTaskXml(wake.taskName(), futureA.nextRunAt);
  const xmlContent = fs.readFileSync(xmlPath, 'utf16le');
  assert(xmlContent.includes('--automation-wake'), 'automation wake: XML launches automation wake mode');
  assert(xmlContent.includes('WakeToRun'), 'automation wake: XML enables wake-to-run');
  const syncResult = wake.sync(autoMgr.list(), new Date('2029-01-01T00:00:00Z'));
  if (process.platform === 'win32') {
    assert(syncResult.registered === true && wakeCalls.some(c => c.args.includes('/Create')), 'automation wake: registers Windows scheduled task');
  } else {
    assert(syncResult.skippedReason.includes('Windows Task Scheduler'), 'automation wake: non-Windows skip is explicit');
  }
  autoMgr.toggle(futureA.id);
  autoMgr.toggle(futureB.id);
  const deleteSync = wake.sync(autoMgr.list(), new Date('2029-01-01T00:00:00Z'));
  if (process.platform === 'win32') {
    assert(deleteSync.deleted === true && wakeCalls.some(c => c.args.includes('/Delete')), 'automation wake: deletes task when no active automations');
  } else {
    assert(deleteSync.active === false, 'automation wake: remains inactive on non-Windows');
  }

  // ---- 6. Flow Engine Tests ----
  console.log('\n🔄 Flow Engine');
  const flowDir = path.join(TEST_DIR, 'Flow');
  const testFlow: FlowWorkflow = {
    name: 'test-flow',
    components: [
      { type: 'dialog', id: 0, mode: 'build', prompt: 'Implement {#prompt#}' },
      { type: 'dialog', id: 1, mode: 'plan', prompt: 'Review work' },
      { type: 'logic', id: 2, prompt: 'Is it done?', goto_true: 0, goto_false: 3 },
      { type: 'dialog', id: 3, mode: 'build', prompt: 'Final polish' },
    ],
  };

  FlowEngine.save(flowDir, testFlow);
  const loaded = FlowEngine.load(flowDir, 'test-flow');
  assert(loaded !== null, 'save/load: flow persists');
  assert(!!loaded?.components && loaded.components.length === 4, 'flow: 4 components');

  const flows = FlowEngine.listAll(flowDir);
  assert(flows.includes('test-flow'), 'listAll: finds flow');

  // Generate sequence
  const seq = FlowEngine.generateSequence(testFlow, 0, 'my task');
  assert(seq.length >= 2, 'generateSequence: produces steps');
  assert(seq[0].prompt.includes('my task'), 'generateSequence: placeholder expanded');
  assert(seq[0].mode === 'build', 'generateSequence: correct mode');
  assert(seq[1].mode === 'plan', 'generateSequence: second step has mode');

  // Resolve goto
  const gotoTrue = FlowEngine.resolveGoto(testFlow, 2, true);
  assert(gotoTrue === 0, 'resolveGoto: true -> goto_true');
  const gotoFalse = FlowEngine.resolveGoto(testFlow, 2, false);
  assert(gotoFalse === 3, 'resolveGoto: false -> goto_false');
  const forwardGotoValidation = FlowEngine.validate(testFlow);
  assert(!forwardGotoValidation.some(e => e.message.includes('goto_false=3 not found')), 'validate: allows forward goto addresses');

  const uiSavedFlow: FlowWorkflow = {
    name: 'ui-saved-flow',
    components: [
      { id: 0, type: 'dialog', mode: 'build', prompt: 'Build {#prompt#}' },
      { id: 1, type: 'logic', prompt: 'Is {#prompt#} done?', goto_true: 2, goto_false: 0 },
      { id: 2, type: 'dialog', mode: 'plan', prompt: 'Review' },
    ],
  };
  const uiFlowErrors = FlowEngine.validate(uiSavedFlow);
  assert(uiFlowErrors.length === 0, 'validate: UI saved Flow schema is accepted');
  assert(FlowEngine.generateSequence(uiSavedFlow, 0, 'task')[0].prompt === 'Build task', 'generateSequence: UI schema placeholder works');
  fs.writeFileSync(path.join(flowDir, 'bom-flow.Flow.json'), '\uFEFF' + JSON.stringify(uiSavedFlow), 'utf-8');
  assert(FlowEngine.load(flowDir, 'bom-flow') !== null, 'load: tolerates UTF-8 BOM Flow files');

  FlowEngine.delete(flowDir, 'test-flow');
  assert(FlowEngine.load(flowDir, 'test-flow') === null, 'delete: flow removed');

  const continuationFlow: FlowWorkflow = {
    name: 'continuation-flow',
    components: [
      { type: 'dialog', id: 0, mode: 'build', prompt: 'Step zero {#prompt#}' },
      { type: 'dialog', id: 1, mode: 'plan', prompt: 'Step one {#prompt#}' },
      { type: 'dialog', id: 2, mode: 'build', prompt: 'Step two' },
    ],
  };
  const continuationPrompts: string[] = [];
  const continuationModes: AgentMode[] = [];
  const continuationAgent = {
    setMode: (mode: AgentMode) => { continuationModes.push(mode); },
    process: async (prompt: string): Promise<StreamToken[]> => {
      continuationPrompts.push(prompt);
      return [{ type: 'text', text: 'ok' }];
    },
  } as unknown as Agent;
  await runFlow(continuationAgent, continuationFlow, { startPc: 1, startInput: 'resume input', quiet: true });
  assert(continuationPrompts.length === 2, 'runFlow: startPc resumes from selected component');
  assert(continuationPrompts[0] === 'Step one resume input', 'runFlow: resumed step expands start input');
  assert(!continuationPrompts.some(p => p.includes('Step zero')), 'runFlow: resumed flow skips earlier steps');
  assert(continuationModes[0] === 'plan' && continuationModes[1] === 'build', 'runFlow: resumed flow preserves modes');

  const retryFlow: FlowWorkflow = {
    name: 'goal-retry-flow',
    components: [
      { type: 'dialog', id: 0, mode: 'goal', prompt: 'Finish important goal' },
      { type: 'dialog', id: 1, mode: 'build', prompt: 'Continue after goal' },
    ],
  };
  const retryPrompts: string[] = [];
  let verificationCalls = 0;
  const retryAgent = {
    setMode: (_mode: AgentMode) => {},
    process: async (prompt: string): Promise<StreamToken[]> => {
      retryPrompts.push(prompt);
      if (prompt.includes('## Goal Verification')) {
        verificationCalls++;
        return [{ type: 'text', text: verificationCalls === 1 ? 'false' : 'true' }];
      }
      return [{ type: 'text', text: prompt.includes('Finish important goal') ? 'goal work' : 'after goal' }];
    },
  } as unknown as Agent;
  await runFlow(retryAgent, retryFlow, { quiet: true });
  assert(retryPrompts.filter(p => p === 'Finish important goal').length === 2, 'runFlow: goal verification failure re-executes component');
  assert(verificationCalls === 2, 'runFlow: verifies retried goal again');
  assert(retryPrompts.includes('Continue after goal'), 'runFlow: advances after goal verification succeeds');

  const agentFlow: FlowWorkflow = {
    name: 'agent-trigger-flow',
    components: [
      { type: 'dialog', id: 0, mode: 'build', prompt: 'Flow component {#prompt#}' },
    ],
  };
  FlowEngine.save(flowDir, agentFlow);

  // ---- 7. Agent Mode Tests ----
  console.log('\n🧠 Agent Engine (modes, goal, prompts)');
  const agent = new Agent(TEST_DIR);

  // Default mode
  assert(agent.mode === 'build', 'agent: default Build mode');
  assert(agent.modeName() === 'Build', 'agent: modeName()');
  assert(agent.status === 'idle', 'agent: initial idle');
  assert(agent.inputMode === 'guide', 'agent: default Guide');

  // Mode switching
  agent.setMode('plan');
  assert(agent.mode === 'plan', 'agent: switch to Plan');
  assert(agent.goal === null, 'agent: Plan clears goal');

  agent.setMode('goal');
  assert(agent.mode === 'goal', 'agent: switch to Goal');
  assert(agent.goal !== null, 'agent: Goal creates goal state');
  assert(agent.goal!.objective === 'Set your objective', 'agent: Goal has default objective');

  agent.setMode('flow');
  assert(agent.mode === 'flow', 'agent: switch to Flow');
  assert(agent.goal === null, 'agent: Flow clears goal');

  agent.setMode('build');
  assert(agent.mode === 'build', 'agent: switch back to Build');

  // Goal management
  agent.updateGoal('Create a web app');
  assert(agent.goal?.objective === 'Create a web app', 'updateGoal: sets objective');
  assert(agent.mode === 'goal', 'updateGoal: forces goal mode');

  agent.updateGoal('Create a REST API');
  assert(agent.goal?.objective === 'Create a REST API', 'updateGoal: updates objective');
  assert(agent.goal!.changes.length === 1, 'updateGoal: tracks change history');
  assert(agent.goal!.history().includes('Create a web app'), 'history: includes old goal');

  // Goal pause/resume
  assert(agent.isGoalPaused() === false, 'goalPaused: initially not paused');
  agent.toggleGoalPause();
  assert(agent.isGoalPaused() === true, 'goalPaused: paused after toggle');
  assert(agent.status === 'goal_paused', 'status: goal_paused');
  agent.toggleGoalPause();
  assert(agent.isGoalPaused() === false, 'goalPaused: resumed');

  // Goal completion check
  assert(!!agent.goal && agent.goal.checkComplete('Goal Complete!'), 'checkComplete: detects "Goal Complete"');
  assert(!!agent.goal && agent.goal.checkComplete('Objective achieved'), 'checkComplete: detects "Objective achieved"');
  assert(!!agent.goal && !agent.goal.checkComplete('Not done yet'), 'checkComplete: ignores plain text');

  const scopedAgent = new Agent(TEST_DIR);
  const wsChatA = scopedAgent.createInternalWorkspace('chat-scope-a');
  scopedAgent.chatMessages = [{ role: 'user', content: 'message in A', mode: 'Build', model: scopedAgent.model, timestamp: 't1' }];
  scopedAgent.history = [{ role: 'user', content: 'history in A' }];
  scopedAgent.updateConversationPlan({ items: [{ id: 'plan-a', text: 'plan item in workspace A', status: 'pending' }] });
  const wsChatB = scopedAgent.createInternalWorkspace('chat-scope-b');
  assert(scopedAgent.chatMessages.length === 0 && scopedAgent.history.length === 0, 'workspace chat: new workspace starts empty');
  assert(scopedAgent.getConversationPlan().items.length === 0, 'workspace plan: new workspace starts with empty conversation plan');
  scopedAgent.chatMessages = [{ role: 'user', content: 'message in B', mode: 'Build', model: scopedAgent.model, timestamp: 't2' }];
  scopedAgent.history = [{ role: 'user', content: 'history in B' }];
  scopedAgent.updateConversationPlan({ items: [{ id: 'plan-b', text: 'plan item in workspace B', status: 'in_progress' }] });
  scopedAgent.selectWorkspace(wsChatA.name);
  assert(scopedAgent.chatMessages[0]?.content === 'message in A', 'workspace chat: restores selected workspace messages');
  assert(String(scopedAgent.history[0]?.content) === 'history in A', 'workspace chat: restores selected workspace history');
  assert(scopedAgent.getConversationPlan().items[0]?.text === 'plan item in workspace A', 'workspace plan: restores selected workspace conversation plan');
  scopedAgent.selectWorkspace(wsChatB.name);
  assert(scopedAgent.chatMessages[0]?.content === 'message in B', 'workspace chat: keeps workspaces isolated');
  assert(scopedAgent.getConversationPlan().items[0]?.text === 'plan item in workspace B', 'workspace plan: keeps workspaces isolated');
  scopedAgent.setConversation('conv-one');
  scopedAgent.chatMessages = [{ role: 'user', content: 'message in conv one', mode: 'Build', model: scopedAgent.model, timestamp: 't3' }];
  scopedAgent.history = [{ role: 'user', content: 'history in conv one' }];
  scopedAgent.updateConversationPlan({ items: [{ id: 'plan-one', text: 'plan item in conv one', status: 'done' }] });
  scopedAgent.setConversation('conv-two');
  assert(scopedAgent.chatMessages.length === 0 && scopedAgent.history.length === 0, 'conversation chat: new conversation starts empty within workspace');
  assert(scopedAgent.getConversationPlan().items.length === 0, 'conversation plan: new conversation starts empty within workspace');
  scopedAgent.chatMessages = [{ role: 'user', content: 'message in conv two', mode: 'Build', model: scopedAgent.model, timestamp: 't4' }];
  scopedAgent.history = [{ role: 'user', content: 'history in conv two' }];
  scopedAgent.updateConversationPlan({ items: [{ id: 'plan-two', text: 'plan item in conv two', status: 'in_progress' }] });
  scopedAgent.setConversation('conv-one');
  assert(scopedAgent.chatMessages[0]?.content === 'message in conv one', 'conversation chat: restores same-workspace conversation history');
  assert(scopedAgent.getConversationPlan().items[0]?.text === 'plan item in conv one', 'conversation plan: restores same-workspace conversation plan');
  scopedAgent.setConversation('conv-two');
  assert(scopedAgent.chatMessages[0]?.content === 'message in conv two', 'conversation chat: isolates same-workspace conversations');
  assert(scopedAgent.getConversationPlan().items[0]?.status === 'in_progress', 'conversation plan: isolates same-workspace conversation plans');
  scopedAgent.flushConversationState();
  const scopedAgentReloaded = new Agent(TEST_DIR);
  assert(scopedAgentReloaded.workspace.current?.name === wsChatB.name, 'workspace chat: restores active workspace across Agent instances');
  assert(scopedAgentReloaded.activeConversationId === 'conv-two', 'conversation chat: restores active conversation id across Agent instances');
  assert(scopedAgentReloaded.chatMessages[0]?.content === 'message in conv two', 'conversation chat: restores active conversation on startup');
  scopedAgentReloaded.selectWorkspace(wsChatB.name);
  scopedAgentReloaded.setConversation('conv-two');
  assert(scopedAgentReloaded.chatMessages[0]?.content === 'message in conv two', 'conversation chat: persists same-workspace conversation messages across Agent instances');
  assert(String(scopedAgentReloaded.history[0]?.content) === 'history in conv two', 'conversation chat: persists same-workspace conversation history across Agent instances');
  assert(scopedAgentReloaded.getConversationPlan().items[0]?.text === 'plan item in conv two', 'conversation plan: persists across Agent instances');
  const persistedConvs = scopedAgentReloaded.listConversationStates();
  assert(persistedConvs.some(c => c.id === 'conv-two' && c.messageCount === 1), 'conversation chat: lists persisted conversation state');
  assert(persistedConvs.some(c => c.id === 'conv-two' && c.title.includes('message in conv two')), 'conversation chat: derives persisted conversation title');
  scopedAgentReloaded.setConversation('empty-title-first');
  scopedAgentReloaded.flushConversationState();
  const emptyTitleBefore = scopedAgentReloaded.listConversationStates().find(c => c.id === 'empty-title-first')?.title || '';
  scopedAgentReloaded.chatMessages = [{ role: 'user', content: 'Summarize this conversation title now', mode: 'Build', model: scopedAgentReloaded.model, timestamp: 't5' }];
  scopedAgentReloaded.flushConversationState();
  const emptyTitleAfter = scopedAgentReloaded.listConversationStates().find(c => c.id === 'empty-title-first')?.title || '';
  assert(emptyTitleBefore.includes('empty-title-first'), 'conversation title: empty saved conversation starts with generated id title');
  assert(emptyTitleAfter.includes('Summarize this conversation title now') && !emptyTitleAfter.includes('empty-title-first'), 'conversation title: first user message replaces generated id title');
  scopedAgentReloaded.setConversation('conv-one');
  const activeSwitchReloaded = new Agent(TEST_DIR);
  assert(activeSwitchReloaded.activeConversationId === 'conv-one', 'conversation chat: setConversation persists active conversation immediately');
  (scopedAgentReloaded as unknown as { processingConversationId: string | null }).processingConversationId = 'conv-two';
  let lockThrown = false;
  try { scopedAgentReloaded.setConversation('conv-one'); } catch { lockThrown = true; }
  assert(!lockThrown && scopedAgentReloaded.activeConversationId === 'conv-one', 'conversation chat: allows switching visible conversation while another conversation is working');
  (scopedAgentReloaded as unknown as { processingConversationId: string | null }).processingConversationId = null;
  scopedAgent.workspace.clear();
  const noWorkspaceTokens = await scopedAgent.process('should be blocked');
  assert(noWorkspaceTokens.map(t => t.text).join('').includes('Workspace required'), 'workspace chat: process requires selected workspace');
  const pureAgent = new Agent(path.join(TEST_DIR, 'pure-agent-runtime'), { agentOnly: true });
  const pureProvider = new FakeProvider(['PURE_AGENT_NO_WORKSPACE_OK']);
  (pureAgent as unknown as { engineModel: () => FakeProvider }).engineModel = () => pureProvider;
  const pureTokens = await pureAgent.process('run without workspace');
  assert(pureTokens.map(t => t.text).join('').includes('PURE_AGENT_NO_WORKSPACE_OK') && pureAgent.workspace.current === null, 'pure Agent mode: process runs without workspace dependency');

  const formatAgent = new Agent(TEST_DIR);
  const formatProvider = new FakeProvider(['<think>hidden reasoning</think>\n做了什么\n- visible result\n</think>\nfinal']);
  (formatAgent as unknown as { engineModel: () => FakeProvider }).engineModel = () => formatProvider;
  const formatTokens = await formatAgent.process('test response cleanup');
  const formatText = formatTokens.map(t => t.text).join('');
  assert(formatText.includes('visible result') && !formatText.includes('<think>') && !formatText.includes('</think>') && !formatText.includes('hidden reasoning'), 'agent output: strips think tags and hidden reasoning from visible tokens');
  assert(!formatAgent.chatMessages.some(m => m.content.includes('</think>') || m.content.includes('hidden reasoning')), 'agent output: stores sanitized assistant messages');

  const reactivatingAgent = new Agent(TEST_DIR);
  const reactivatingProvider = new FakeProvider(['Not done yet.', 'Goal Complete!']);
  (reactivatingAgent as unknown as { engineModel: () => FakeProvider }).engineModel = () => reactivatingProvider;
  reactivatingAgent.updateGoal('Finish the deterministic goal test');
  const reactivationTokens = await reactivatingAgent.process('Start goal test');
  const reactivationText = reactivationTokens.map(t => t.text).join('');
  assert(reactivatingProvider.calls === 2, 'goal process: unfinished response triggers reactivation');
  assert(reactivationText.includes('[Goal Complete]'), 'goal process: retried response completes goal');
  assert(reactivatingAgent.history.some(m => String(m.content).includes('Continue working toward this goal')), 'goal process: continuation prompt recorded');

  const continuingAgent = new Agent(TEST_DIR);
  const continuingProvider = new FakeProvider(['Still incomplete.', 'Goal Complete!']);
  (continuingAgent as unknown as { engineModel: () => FakeProvider }).engineModel = () => continuingProvider;
  continuingAgent.updateGoal('Exercise unlimited goal continuation');
  const continuingTokens = await continuingAgent.process('Start continuing goal');
  const continuingText = continuingTokens.map(t => t.text).join('');
  assert(continuingProvider.calls === 2, 'goal process: continues without max-depth guard until complete');
  assert(!continuingText.includes('max depth'), 'goal process: no max-depth warning');

  // Model management
  agent.setModel('test-model');
  assert(agent.model === 'test-model', 'setModel: updates model');
  agent.setIntelligence('high');
  assert(agent.intelligence === 'high', 'setIntelligence: updates tier');

  // System prompt
  agent.setMode('build'); // ensure build mode for prompt test
  const sysPrompt = agent.buildSystemPrompt();
  assert(sysPrompt.includes('Newmark Agent'), 'buildSystemPrompt: includes identity');
  assert(sysPrompt.includes('Enabled Newmark Features And Implementation'), 'buildSystemPrompt: includes feature disclosure');
  assert(sysPrompt.includes('做了什么') && sysPrompt.includes('验证') && sysPrompt.includes('文件') && sysPrompt.includes('问题/下一步'), 'buildSystemPrompt: enforces Chinese structured reply format');
  assert(sysPrompt.includes('What changed') && sysPrompt.includes('Verification') && sysPrompt.includes('Files') && sysPrompt.includes('Issues/Next'), 'buildSystemPrompt: enforces English structured reply format');
  assert(sysPrompt.includes('non-overridable') && sysPrompt.includes('must not weaken these rules'), 'buildSystemPrompt: protects intrinsic rules from user prompts');
  assert(sysPrompt.includes('no <think>, </think>') && sysPrompt.includes('hidden-reasoning markers'), 'buildSystemPrompt: forbids hidden reasoning markers in visible replies');
  assert(sysPrompt.includes('Visible output contract') && sysPrompt.includes('sanitized before display'), 'buildSystemPrompt: discloses output sanitization implementation');
  assert(sysPrompt.includes('BUILD MODE'), 'buildSystemPrompt: includes mode instructions');
  assert(sysPrompt.includes('bash:'), 'buildSystemPrompt: lists tools');
  assert(sysPrompt.includes('Memory Lab exists and provides persistent memory.'), 'buildSystemPrompt: includes only Memory Lab existence signal');
  assert(!sysPrompt.includes('Memory Lab/index.json') && !sysPrompt.includes('Memory Lab stores persistent local memory') && !sysPrompt.includes('CliMemoryNeedle'), 'buildSystemPrompt: does not include Memory Lab paths, instructions, index, or component content');
  fs.mkdirSync(path.join(TEST_DIR, 'skills', 'prompt-skill'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'skills', 'prompt-skill', 'SKILL.md'), '---\nname: prompt-skill\ndescription: Prompt visible skill\n---\n# Prompt Skill');
  assert(agent.skills.setEnabled('prompt-skill', true), 'buildSystemPrompt: test skill enabled');
  assert(agent.buildSystemPrompt().includes('prompt-skill'), 'buildSystemPrompt: includes enabled skills');
  assert(agent.skills.setEnabled('prompt-skill', false), 'buildSystemPrompt: test skill disabled');
  assert(!agent.buildSystemPrompt().includes('prompt-skill'), 'buildSystemPrompt: excludes disabled skills');
  fs.writeFileSync(path.join(TEST_DIR, 'agent.md'), 'GLOBAL_PROMPT');
  if (agent.workspace.current) fs.writeFileSync(path.join(agent.workspace.current.path, 'agent.md'), 'WORKSPACE_PROMPT');
  agent.config.set('workspace', 'prompt_mode', 'both');
  const layeredPrompt = agent.buildSystemPrompt();
  assert(layeredPrompt.includes('Language policy') && layeredPrompt.includes('general.language=auto'), 'buildSystemPrompt: discloses selected language policy');
  assert(layeredPrompt.includes("choose the section-header language from the user's dominant input language"), 'buildSystemPrompt: auto language chooses reply format from user input');
  agent.config.set('general', 'language', 'en');
  const englishPrompt = agent.buildSystemPrompt();
  assert(englishPrompt.includes('general.language=en') && englishPrompt.includes('Use English section headers when replying in English'), 'buildSystemPrompt: English language setting selects English visible format');
  agent.config.set('general', 'language', 'zh');
  const chinesePrompt = agent.buildSystemPrompt();
  assert(chinesePrompt.includes('general.language=zh') && chinesePrompt.includes('Use Simplified Chinese section headers when replying in Chinese'), 'buildSystemPrompt: Chinese language setting selects Chinese visible format');
  agent.config.set('general', 'language', 'auto');
  const coreIdx = layeredPrompt.indexOf('You are Newmark Agent');
  const featureIdx = layeredPrompt.indexOf('Enabled Newmark Features And Implementation');
  const globalIdx = layeredPrompt.indexOf('GLOBAL_PROMPT');
  const workspaceIdx = layeredPrompt.indexOf('WORKSPACE_PROMPT');
  assert(coreIdx >= 0 && featureIdx > coreIdx && globalIdx > featureIdx && workspaceIdx > globalIdx, 'buildSystemPrompt: prompt layering order');
  agent.config.set('workspace', 'prompt_mode', 'global_only');
  assert(agent.buildSystemPrompt().includes('GLOBAL_PROMPT') && !agent.buildSystemPrompt().includes('WORKSPACE_PROMPT'), 'buildSystemPrompt: global_only excludes workspace prompt');
  agent.config.set('workspace', 'prompt_mode', 'workspace_only');
  assert(!agent.buildSystemPrompt().includes('GLOBAL_PROMPT') && agent.buildSystemPrompt().includes('WORKSPACE_PROMPT'), 'buildSystemPrompt: workspace_only excludes global prompt');
  agent.config.set('workspace', 'prompt_mode', 'both');

  // Plan mode prompt
  agent.setMode('plan');
  const planPrompt = agent.buildSystemPrompt();
  assert(planPrompt.includes('PLAN MODE'), 'buildSystemPrompt: plan mode');
  assert(planPrompt.includes('READ-ONLY'), 'buildSystemPrompt: plan mentions read-only');
  assert(planPrompt.includes('Do NOT modify any files, including README.md'), 'buildSystemPrompt: plan forbids all file modifications');
  const planMemoryBlocked = await (agent as unknown as { handleMemoryLabTool: (tool: string, args: string) => Promise<string> })
    .handleMemoryLabTool('memory_lab_update', JSON.stringify({ name: 'blocked-plan-memory', tags: ['#Plan'], content: 'blocked' }));
  assert(planMemoryBlocked.includes('Plan mode') && !fs.existsSync(path.join(TEST_DIR, 'Memory Lab', 'components', 'blocked-plan-memory.md')), 'memory_lab_update: blocked in Plan mode');
  const planMemoryRead = await (agent as unknown as { handleMemoryLabTool: (tool: string, args: string) => Promise<string> })
    .handleMemoryLabTool('memory_lab_read', JSON.stringify({ component: 'cli-memory' }));
  assert(planMemoryRead.includes('indexPath') && planMemoryRead.includes('instructions') && planMemoryRead.includes('CliMemoryNeedle'), 'memory_lab_read: allowed in Plan mode and returns index instructions plus component content');

  // Goal mode prompt
  agent.setMode('goal');
  const goalPrompt = agent.buildSystemPrompt();
  assert(goalPrompt.includes('GOAL MODE'), 'buildSystemPrompt: goal mode');
  assert(goalPrompt.includes('Goal Complete') && goalPrompt.includes('remaining concrete gap'), 'buildSystemPrompt: goal prompt defines completion and incomplete reporting');
  assert(agent.buildSystemPrompt().includes('Automation:'), 'buildSystemPrompt: discloses automation tools and restrictions');

  agent.setMode('build');
  const memoryModelAgent = new Agent(TEST_DIR);
  let memoryModelCalled = false;
  const memoryModelProvider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 100 }),
    async *chatStreamWithTools(): AsyncGenerator<StreamToken> { yield { type: 'text', text: 'unused' }; },
    async chat(): Promise<string> {
      memoryModelCalled = true;
      return JSON.stringify({
        name: 'model-organized-memory',
        description: 'Organized by MemoryLabIndexAgent',
        tags: ['#模型整理-测试'],
        content: '# Organized Memory\n\nModel organized content.',
        kind: 'file',
      });
    },
  };
  (memoryModelAgent as unknown as { engineModel: () => typeof memoryModelProvider }).engineModel = () => memoryModelProvider;
  memoryModelAgent.setMode('build');
  const memoryToolUpdate = await (memoryModelAgent as unknown as { handleMemoryLabTool: (tool: string, args: string) => Promise<string> })
    .handleMemoryLabTool('memory_lab_update', JSON.stringify({ name: 'raw-memory', description: 'raw', tags: ['#Raw'], content: 'raw content' }));
  assert(memoryModelCalled && memoryToolUpdate.includes('model-organized-memory') && fs.existsSync(path.join(TEST_DIR, 'Memory Lab', 'components', 'model-organized-memory.md')), 'memory_lab_update: uses current working model through MemoryLabIndexAgent');

  // Flow mode prompt
  agent.setMode('flow');
  const flowPrompt = agent.buildSystemPrompt();
  assert(flowPrompt.includes('FLOW MODE'), 'buildSystemPrompt: flow mode');
  assert(flowPrompt.includes('logic components') && flowPrompt.includes('true/false'), 'buildSystemPrompt: flow prompt constrains logic routing replies');

  const flowTriggerCalls: string[] = [];
  const flowTriggerProvider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 100 }),
    async *chatStreamWithTools(_model: string, messages: Array<Record<string, unknown>>): AsyncGenerator<StreamToken> {
      const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
      flowTriggerCalls.push(String(lastUser));
      if (flowTriggerCalls.length === 1) {
        yield {
          type: 'tool_call',
          text: '',
          toolCall: {
            id: 'call-flow',
            name: 'flow_run',
            arguments: JSON.stringify({ name: 'agent-trigger-flow', input: 'runtime input' }),
          },
        };
      } else if (flowTriggerCalls.length === 2) {
        yield { type: 'text', text: 'FLOW_COMPONENT_DONE' };
      } else {
        yield { type: 'text', text: 'PARENT_DONE' };
      }
    },
    async chat(): Promise<string> { return 'true'; },
  };
  (agent as any).forcedProvider = flowTriggerProvider;
  agent.setMode('build');
  const flowToolTokens = await agent.process('Trigger saved workflow');
  const flowToolText = flowToolTokens.map(t => t.text || '').join('');
  assert(flowToolText.includes('[Flow] Completed: agent-trigger-flow'), 'agent flow_run: executes saved workflow through Agent runtime');
  assert(flowTriggerCalls.includes('Flow component runtime input'), 'agent flow_run: expands and runs Flow dialog component');
  assert(agent.mode === 'build', 'agent flow_run: restores parent mode after workflow');
  (agent as any).forcedProvider = null;

  const agentAutoCfg = agent.config;
  agentAutoCfg.set('automation', 'schedules', []);
  agentAutoCfg.save();
  const agentAutoMgr = new AutomationManager(agentAutoCfg, async (prompt, model) => `agent automation runner ${model}:${prompt}`, 50);
  agent.setAutomationManager(agentAutoMgr);
  let autoToolRound = 0;
  const autoToolProvider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 100 }),
    async *chatStreamWithTools(): AsyncGenerator<StreamToken> {
      autoToolRound++;
      if (autoToolRound === 1) {
        yield {
          type: 'tool_call',
          text: '',
          toolCall: {
            id: 'call-auto-create',
            name: 'automation_create',
            arguments: JSON.stringify({
              prompt: 'agent scheduled prompt',
              model: 'agent-auto-model',
              condition: 'loop',
              interval_sec: 30,
              active: true,
            }),
          },
        };
      } else {
        yield { type: 'text', text: 'AUTO_TOOL_DONE' };
      }
    },
    async chat(): Promise<string> { return 'ok'; },
  };
  (agent as any).forcedProvider = autoToolProvider;
  agent.setMode('build');
  const autoToolTokens = await agent.process('Create an automation');
  const autoToolText = autoToolTokens.map(t => t.text || '').join('');
  const createdAutomation = agentAutoMgr.list()[0];
  assert(autoToolText.includes('[automation_create] Created'), 'agent automation_create: returns created schedule');
  assert(createdAutomation?.prompt === 'agent scheduled prompt' && createdAutomation?.condition === 'loop', 'agent automation_create: persists schedule through manager');
  assert(createdAutomation?.model === 'agent-auto-model' && createdAutomation?.intervalSec === 30, 'agent automation_create: stores model and interval');
  (agent as any).forcedProvider = null;
  agent.setMode('plan');
  const planBlockedAutomation = (agent as any).handleAutomationTool('automation_create', JSON.stringify({ prompt: 'blocked' }));
  assert(String(planBlockedAutomation).includes('Plan mode'), 'agent automation_create: Plan mode blocks mutation');
  const planListedAutomation = (agent as any).handleAutomationTool('automation_list', '{}');
  assert(String(planListedAutomation).includes('agent scheduled prompt'), 'agent automation_list: Plan mode can inspect automations');
  (agent as any).forcedProvider = null;
  agent.setMode('build');

  const visionAgent = new Agent(TEST_DIR);
  visionAgent.config.upsertProvider('VisionMock', 'https://vision.mock/v1', 'sk-vision-test', 'openai');
  visionAgent.config.addModelToProvider('VisionMock', 'vision-computer', 'Vision Computer', 'Vision-capable Computer Use mock');
  visionAgent.config.updateModel('VisionMock', 'vision-computer', { vision: true, max_tokens: 8192 });
  visionAgent.setModel('vision-computer');
  const computerUseScreenshot = path.join(TEST_DIR, 'computer-use-vision.png');
  fs.writeFileSync(computerUseScreenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(computerUseScreenshot, Buffer.from('89504e470d0a1a0a', 'hex'));
  const originalVisionExecute = visionAgent.tools.execute.bind(visionAgent.tools);
  visionAgent.tools.execute = async (toolName: string) => {
    if (toolName === 'computer_use') {
      return JSON.stringify({
        ok: true,
        action: 'observe',
        screenshot_path: '[ephemeral screenshot attached]',
        vision_image_path: computerUseScreenshot,
        perception: {
          mode: 'native-screenshot-plus-windows-ui-automation',
          elements: [{ name: 'Save', control_type: 'Button', bbox: { x: 8, y: 9, width: 40, height: 20 }, center: { x: 28, y: 19 } }],
        },
      });
    }
    return originalVisionExecute(toolName, '{}', TEST_DIR);
  };
  const visionMessagesSeen: Array<Array<Record<string, unknown>>> = [];
  let visionRound = 0;
  const visionComputerProvider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 100 }),
    async *chatStreamWithTools(_model: string, messages: Array<Record<string, unknown>>): AsyncGenerator<StreamToken> {
      visionMessagesSeen.push(messages);
      if (visionRound++ === 0) {
        yield { type: 'tool_call', text: '', toolCall: { id: 'call-computer-observe', name: 'computer_use', arguments: JSON.stringify({ action: 'observe' }) } };
      } else {
        yield { type: 'text', text: 'COMPUTER_VISION_DONE' };
      }
    },
    async chat(): Promise<string> { return 'unused'; },
  };
  (visionAgent as any).forcedProvider = visionComputerProvider;
  const visionComputerTokens = await visionAgent.process('Use Computer Use with vision');
  const postObserveMessages = visionMessagesSeen[1] || [];
  const computerToolMessage = postObserveMessages.find(m => m.role === 'tool' && Array.isArray(m.content));
  const computerToolContent = Array.isArray(computerToolMessage?.content) ? computerToolMessage.content as Array<Record<string, any>> : [];
  assert(visionComputerTokens.map(t => t.text || '').join('').includes('COMPUTER_VISION_DONE'), 'computer_use vision: completes second model turn after observe');
  assert(computerToolContent.some(p => p.type === 'text' && String(p.text || '').includes('"Save"')) && computerToolContent.some(p => p.type === 'image_url' && String(p.image_url?.url || '').startsWith('data:image/png;base64,')), 'computer_use vision: sends screenshot image and UI Automation controls together to vision model', JSON.stringify(computerToolContent).slice(0, 500));
  assert(!fs.existsSync(computerUseScreenshot), 'computer_use vision: deletes ephemeral screenshot after preparing image input');
  (visionAgent as any).forcedProvider = null;

  // ---- 8. Input Mode Tests ----
  console.log('\n⌨️  Input Modes');
  agent.setMode('build');
  agent.inputMode = 'guide';
  assert(agent.inputMode === 'guide', 'inputMode: guide');
  agent.inputMode = 'next';
  assert(agent.inputMode === 'next', 'inputMode: next');
  agent.nextPrompt = 'Queued task';
  assert(agent.nextPrompt === 'Queued task', 'nextPrompt: stores queued prompt');

  // ---- 9. Archiving Tests ----
  console.log('\n📦 Archiving');
  const archiveName = agent.archiveSession();
  assert(archiveName.endsWith('.md'), 'archiveSession: creates .md file');
  const expectedArchiveDir = agent.workspace.current ? path.join(agent.workspace.current.path, 'archive') : path.join(TEST_DIR, 'archive');
  assert(fs.existsSync(path.join(expectedArchiveDir, archiveName)), 'archiveSession: file exists in current workspace');

  const archives = agent.listArchives();
  assert(archives.length >= 1, 'listArchives: finds archives');
  assert(archives[0].name === archiveName, 'listArchives: correct name');

  const archivedContent = agent.readArchive(archiveName);
  assert(archivedContent?.includes('# Newmark Session'), 'readArchive: reads content');
  assert(archivedContent?.includes('**Mode**'), 'readArchive: has mode info');

  agent.deleteArchive(archiveName);
  assert(agent.listArchives().length === 0, 'deleteArchive: removes file');

  // ---- 10. Context Compression Tests ----
  console.log('\n📐 Context Compression');
  agent.setMode('build');
  // Build large history
  agent.history = Array(50).fill(null).map((_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(2000), // 2000 chars each = 100K total
  }));

  const msgs = [...agent.history];
  // @ts-expect-error accessing private method for testing
  await agent.maybeCompress(msgs, new FakeProvider(['## Preserved State\nWorkspace: test\nGoal: keep state\n## Pending Work\nContinue.']));
  assert(msgs.length < 50, 'maybeCompress: reduces messages');
  assert(String(msgs[1]?.content || '').includes('Context Compression Model Summary'), 'maybeCompress: uses model-generated summary');
  assert(String(msgs[1]?.content || '').includes('Preserved State'), 'maybeCompress: preserves structured summary');
  assert(agent.lastCompression?.fallback === false, 'maybeCompress: records model compression metadata');
  assert(agent.history.some(m => String(m.content || '').includes('Context Compression Model Summary')), 'maybeCompress: persists compressed history');
  agent.config.upsertProvider('context-prov', 'https://api.context.test/v1', 'test-key-context');
  agent.config.addModelToProvider('context-prov', 'tiny-context', 'Tiny Context', 'Small context test model');
  agent.config.updateModel('context-prov', 'tiny-context', { max_tokens: 1000 });
  agent.setModel('tiny-context');
  agent.history = [{ role: 'user', content: 'x'.repeat(3600) }];
  const contextNearLimit = agent.contextWindow();
  assert(contextNearLimit.warning === 'near_limit' && contextNearLimit.estimatedTokens >= 900, 'context window: warns when estimated tokens approach model limit');
  agent.history = [{ role: 'user', content: 'x'.repeat(5000) }];
  const contextOverLimit = agent.contextWindow();
  assert(contextOverLimit.warning === 'over_limit', 'context window: warns when estimated tokens exceed model limit');

  // ---- 11. Model Validation Tests ----
  console.log('\n🔍 Model Validation');
  const modelAgent = new Agent(path.join(TEST_DIR, 'model-validation-agent'));
  modelAgent.config.upsertProvider('model-prov', 'https://api.model.test/v1', 'test-key-model');
  modelAgent.config.addModelToProvider('model-prov', 'bad-model', 'Bad Model', 'Unavailable model');
  modelAgent.config.addModelToProvider('model-prov', 'fast-mini', 'Fast Mini', 'Fast economical model');
  modelAgent.config.addModelToProvider('model-prov', 'deep-opus', 'Deep Opus', 'High capability reasoning model for complex work');
  modelAgent.config.addModelToProvider('model-prov', 'gpt-5.5', 'GPT 5.5', 'Frontier GPT model imported from provider');
  modelAgent.config.updateModel('model-prov', 'gpt-5.5', { vision: false, description: 'Previously validated text-only model' });
  modelAgent.config.addModelToProvider('model-prov', 'gpt5.5', 'GPT5.5', 'Frontier GPT model imported from provider');
  modelAgent.config.updateModel('model-prov', 'gpt5.5', { vision: false, description: 'Provider-listed model without multimodal metadata' });
  const originalValidate = LLMProvider.prototype.validate;
  LLMProvider.prototype.validate = async function(modelName: string) {
    return { ok: modelName !== 'bad-model', latency: modelName === 'fast-mini' ? 0.4 : 2.2 };
  };
  const validation = await modelAgent.validateModels();
  assert(Array.isArray(validation), 'validateModels: returns array');
  assert(validation.some(v => v.name === 'model-prov/fast-mini' && v.status === 'available'), 'validateModels: records available model');
  assert(validation.some(v => v.speed_rating === 'fast'), 'validateModels: records response speed');
  assert(validation.every(v => !(v as unknown as Record<string, unknown>).api_key), 'validateModels: does not leak API keys');
  const evaluatedFast = modelAgent.config.findModel('fast-mini');
  assert(evaluatedFast?.evaluation?.status === 'available', 'validateModels: persists evaluation into config');
  assert(String(evaluatedFast?.description || '').includes('capability=') && String(evaluatedFast?.description || '').includes('speed=') && String(evaluatedFast?.description || '').includes('cost=') && String(evaluatedFast?.description || '').includes('multimodal='), 'validateModels: generates model description with capability speed cost and multimodal metadata');
  const evaluatedGpt55 = modelAgent.config.findModel('gpt-5.5');
  const evaluatedGpt55Compact = modelAgent.config.findModel('gpt5.5');
  assert(validation.some(v => v.name === 'model-prov/gpt-5.5' && v.vision_input === true), 'validateModels: infers GPT-5.5 vision input even when stale config says text-only');
  assert(validation.some(v => v.name === 'model-prov/gpt5.5' && v.vision_input === true), 'validateModels: infers compact GPT5.5 vision input naming');
  assert(evaluatedGpt55?.vision === true && evaluatedGpt55?.evaluation?.vision_input === true, 'validateModels: persists inferred GPT-5.5 vision capability into config');
  assert(String(evaluatedGpt55?.description || '').includes('vision-input') && String(evaluatedGpt55Compact?.description || '').includes('vision-input'), 'validateModels: generated descriptions reflect inferred GPT-5.5 multimodal support');
  modelAgent.history = [{ role: 'user', content: 'x'.repeat(3600) }];
  const nearWindow = modelAgent.contextWindow('fast-mini');
  assert(nearWindow.estimatedTokens >= 900 && nearWindow.warning === 'ok', 'context window: estimates conversation tokens against model max context');
  modelAgent.config.upsertProvider('other-prov', 'https://api.other-model.test/v1', 'test-key-other');
  modelAgent.config.addModelToProvider('other-prov', 'other-flash', 'Other Flash', 'Fast cheap text-only model on another provider');
  modelAgent.config.updateModel('other-prov', 'other-flash', {
    speed_rating: 'fast',
    capability_rating: 'medium',
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
    evaluation: {
      status: 'available',
      latency: 0.2,
      checked_at: new Date().toISOString(),
      text_input: true,
      text_output: true,
      vision_input: false,
      image_output: false,
      cost_rating: 'free',
      performance_rating: 'medium',
      speed_rating: 'fast',
      notes: 'available cross-provider Auto test model',
    },
  });
  modelAgent.config.updateModel('other-prov', 'other-flash', { max_tokens: 512 });
  modelAgent.config.set('models', 'auto_switch', true);
  modelAgent.config.set('models', 'auto_switch_scope', 'all');
  modelAgent.config.set('models', 'auto_switch_preference', 'speed');
  modelAgent.setModel('auto');
  const contextSafeSwitch = await modelAgent.evaluateAndSwitch('list files');
  assert(contextSafeSwitch && modelAgent.model === 'fast-mini', 'auto model: skips faster candidate when its context window is too small');
  modelAgent.history = [];
  modelAgent.config.updateModel('other-prov', 'other-flash', { max_tokens: 128000 });
  modelAgent.config.set('models', 'auto_switch', true);
  modelAgent.config.set('models', 'auto_switch_scope', 'all');
  modelAgent.config.set('models', 'auto_switch_preference', 'speed');
  modelAgent.setModel('deep-opus');
  const concreteDidNotSwitch = await modelAgent.evaluateAndSwitch('list files');
  assert(!concreteDidNotSwitch && modelAgent.model === 'deep-opus', 'auto model: concrete models do not autonomously switch');
  assert(modelAgent.allModelNames()[0] === 'auto', 'auto model: Auto is listed only while autonomous switching is enabled');
  modelAgent.setModel('auto');
  const switchedForSpeed = await modelAgent.evaluateAndSwitch('list files');
  assert(switchedForSpeed && modelAgent.model === 'other-flash', 'auto model: full autonomous mode may switch across providers');
  modelAgent.setModel('deep-opus');
  modelAgent.config.set('models', 'auto_switch_scope', 'provider');
  modelAgent.setModel('auto');
  const providerScopedSwitch = await modelAgent.evaluateAndSwitch('list files');
  assert(providerScopedSwitch && modelAgent.model === 'fast-mini', 'auto model: provider-scoped mode stays within the anchor provider');
  modelAgent.config.set('models', 'auto_switch_preference', 'default');
  modelAgent.config.set('models', 'auto_switch_scope', 'all');
  modelAgent.setModel('auto');
  const switchedForDefault = await modelAgent.evaluateAndSwitch('list files');
  assert(switchedForDefault && modelAgent.model === 'other-flash', 'auto model: default preference chooses fast model for simple tasks');
  modelAgent.config.set('models', 'auto_switch_preference', 'performance');
  modelAgent.config.set('models', 'auto_switch_scope', 'all');
  modelAgent.setModel('auto');
  const switchedForPerformance = await modelAgent.evaluateAndSwitch('implement a complex refactor across modules');
  assert(switchedForPerformance && modelAgent.model === 'deep-opus', 'auto model: switches using quality/performance preference');
  modelAgent.config.set('models', 'auto_switch_preference', 'cheap_save');
  modelAgent.setModel('auto');
  const switchedForCost = await modelAgent.evaluateAndSwitch('list files');
  assert(switchedForCost && modelAgent.model === 'other-flash', 'auto model: switches using cost-saving preference');
  modelAgent.config.addModelToProvider('other-prov', 'vision-pro', 'Vision Pro', 'High capability multimodal vision model');
  modelAgent.config.updateModel('other-prov', 'vision-pro', {
    vision: true,
    speed_rating: 'medium',
    capability_rating: 'high',
    cost_per_1k_input: 0.01,
    cost_per_1k_output: 0.03,
    evaluation: {
      status: 'available',
      latency: 1.2,
      checked_at: new Date().toISOString(),
      text_input: true,
      text_output: true,
      vision_input: true,
      image_output: false,
      cost_rating: 'standard',
      performance_rating: 'high',
      speed_rating: 'medium',
      notes: 'available multimodal Auto test model',
    },
  });
  modelAgent.config.set('models', 'auto_switch_preference', 'speed');
  modelAgent.config.set('models', 'auto_switch_scope', 'all');
  modelAgent.setModel('auto');
  const switchedForVision = await modelAgent.evaluateAndSwitch('analyze this screenshot ![shot](C:/tmp/shot.png)');
  assert(switchedForVision && modelAgent.config.findModel(modelAgent.model)?.vision === true, 'auto model: multimodal input switches to a vision-capable model within allowed scope');
  modelAgent.config.set('models', 'auto_switch', false);
  assert(!modelAgent.allModelNames().includes('auto'), 'auto model: Auto is unavailable when autonomous switching is disabled');
  modelAgent.setModel('auto');
  assert(modelAgent.model !== 'auto', 'auto model: setModel refuses Auto while autonomous switching is disabled');
  const offModel = modelAgent.model;
  const offSwitch = await modelAgent.evaluateAndSwitch('list files');
  assert(!offSwitch && modelAgent.model === offModel, 'auto model: disabled autonomous switching performs no Auto selection');
  modelAgent.config.set('models', 'auto_switch_preference', 'speed');
  modelAgent.config.set('models', 'auto_switch_scope', 'provider');
  modelAgent.config.set('models', 'auto_switch_anchor_provider', 'model-prov');
  modelAgent.config.set('models', 'fallback_on_unavailable', true);
  modelAgent.config.updateModel('model-prov', 'bad-model', {
    evaluation: {
      status: 'unavailable',
      latency: -1,
      checked_at: new Date().toISOString(),
      text_input: false,
      text_output: false,
      vision_input: false,
      image_output: false,
      cost_rating: 'cheap',
      performance_rating: 'medium',
      speed_rating: 'unknown',
      notes: 'forced unavailable for fallback test',
    },
  });
  const originalChatStream = LLMProvider.prototype.chatStreamWithTools;
  LLMProvider.prototype.chatStreamWithTools = async function* (modelName: string) {
    yield { type: 'text', text: modelName === 'fast-mini' ? 'FALLBACK_PRECHECK_OK' : '[LLM Error: 404] bad model' };
  };
  modelAgent.setModel('bad-model');
  const precheckedFallback = await modelAgent.process('check fallback preflight');
  assert(modelAgent.model === 'fast-mini', 'model fallback: pre-switches away from known unavailable model');
  assert(precheckedFallback.some(t => t.text?.includes('FALLBACK_PRECHECK_OK')), 'model fallback: completes after pre-switch');
  modelAgent.config.updateModel('model-prov', 'bad-model', {
    evaluation: {
      status: 'available',
      latency: 1,
      checked_at: new Date().toISOString(),
      text_input: true,
      text_output: true,
      vision_input: false,
      image_output: false,
      cost_rating: 'cheap',
      performance_rating: 'medium',
      speed_rating: 'fast',
      notes: 'available before runtime failure test',
    },
  });
  modelAgent.setModel('bad-model');
  const runtimeFallback = await modelAgent.process('check runtime fallback');
  assert(modelAgent.model === 'fast-mini', 'model fallback: switches after runtime LLM error');
  assert(runtimeFallback.some(t => t.text?.includes('[Model fallback] bad-model unavailable; switched to fast-mini.')), 'model fallback: emits visible switch notice');
  assert(runtimeFallback.some(t => t.text?.includes('FALLBACK_PRECHECK_OK')), 'model fallback: retries request on fallback model');
  LLMProvider.prototype.chatStreamWithTools = originalChatStream;

  // ---- 12. Fuzzy Injection Tests ----
  console.log('\n💉 Fuzzy Injection');
  assert(providerNameFromUrl('http://127.0.0.1:55128/v1/chat/completions') === 'LocalProvider' && providerNameFromUrl('http://localhost:55128/v1') === 'Localhost', 'fuzzy injection: tokenizer names local IP and localhost providers safely');
  const isolatedFuzzyAgent = new Agent(path.join(TEST_DIR, 'fuzzy-empty'));
  const originalFetchForFuzzy = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const endpoint = String(url);
    if (endpoint === 'https://api.noguide.test/v1/models') {
      return new Response(JSON.stringify({ data: [{ id: 'noguide-fast' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (endpoint === 'https://probe-only.test/v1/models') {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (endpoint === 'https://probe-only.test/v1/chat/completions' && init?.method === 'POST') {
      return new Response(JSON.stringify({ error: { message: 'model required' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
  LLMProvider.prototype.validate = async function(modelName: string) {
    return { ok: modelName === 'noguide-fast' || modelName === 'model', latency: 0.7 };
  };
  const noGuideFuzzy = await isolatedFuzzyAgent.fuzzyInject('', 'https://api.noguide.test/v1/chat/completions', 'sk-noguide-token-12345678901234567890');
  assert(noGuideFuzzy.ok === true && noGuideFuzzy.provider === 'Noguide' && noGuideFuzzy.models?.includes('noguide-fast'), 'fuzzy injection: no-guide tokenizer infers provider and imports /models result');
  const noGuideProvider = isolatedFuzzyAgent.config.providers().find(p => p.name === 'Noguide');
  assert(noGuideProvider?.base_url === 'https://api.noguide.test/v1' && noGuideProvider?.api_key === 'sk-noguide-token-12345678901234567890', 'fuzzy injection: no-guide tokenizer normalizes endpoint and preserves key');
  const suffixProbeAgent = new Agent(path.join(TEST_DIR, 'fuzzy-suffix-empty'));
  const suffixProbeFuzzy = await suffixProbeAgent.fuzzyInject('ProbeOnly', 'https://probe-only.test', 'sk-probe-token-12345678901234567890');
  const suffixProbeProvider = suffixProbeAgent.config.providers().find(p => p.name === 'ProbeOnly');
  assert(suffixProbeFuzzy.ok === true && suffixProbeProvider?.models.some(m => m.name === 'model' && m.description.includes('source=model validation')), 'fuzzy injection: no-guide path confirms endpoint and records validation-generated model description');
  assert(suffixProbeProvider?.base_url === 'https://probe-only.test/v1', 'fuzzy injection: suffix probing saves inferred versioned base URL');
  globalThis.fetch = originalFetchForFuzzy;
  const fuzzyResult = await agent.fuzzyInject('DeepSeek', 'https://api.deepseek.com/v1', 'test-key-fuzzy');
  assert(fuzzyResult.ok === true, 'fuzzy injection: validates imported candidate');
  assert(agent.config.providers().some(p => p.name === 'DeepSeek'), 'fuzzy injection: provider added or merged');
  assert(agent.config.findModel('deepseek-chat') !== undefined, 'fuzzy injection: candidate model imported');
  const originalListModels = LLMProvider.prototype.listModels;
  LLMProvider.prototype.listModels = async function() {
    return this.baseUrl.includes('nebula.local') ? ['nebula-fast', 'nebula-pro'] : [];
  };
  LLMProvider.prototype.validate = async function(modelName: string) {
    return { ok: modelName === 'nebula-fast', latency: 0.6 };
  };
  const nebulaFuzzy = await agent.fuzzyInject('APInebula', 'https://nebula.local/v1', 'test-key-nebula');
  assert(nebulaFuzzy.ok === true, 'fuzzy injection: custom provider validates listed model');
  assert(nebulaFuzzy.models?.includes('nebula-fast') && nebulaFuzzy.models?.includes('nebula-pro'), 'fuzzy injection: imports provider /models listing');
  assert(agent.config.findModel('nebula-fast')?.description.includes('source=model validation'), 'fuzzy injection: listed models receive validation-generated description metadata');
  assert(!JSON.stringify(nebulaFuzzy).includes('test-key-nebula'), 'fuzzy injection: result does not leak API key');
  const nebulaExistingFuzzy = await agent.fuzzyInject('APInebula', '', '');
  assert(nebulaExistingFuzzy.ok === true && nebulaExistingFuzzy.models?.includes('nebula-fast'), 'fuzzy injection: existing provider reuses saved endpoint and key');
  assert(agent.config.providers().find(p => p.name === 'APInebula')?.api_key === 'test-key-nebula', 'fuzzy injection: empty key does not overwrite saved provider key');
  LLMProvider.prototype.listModels = async function() { return []; };
  LLMProvider.prototype.validate = async function() { return { ok: false, latency: 1.1 }; };
  const failedFuzzy = await agent.fuzzyInject('BrokenProvider', 'https://broken.local/v1', 'test-key-broken');
  assert(failedFuzzy.ok === false && failedFuzzy.warning?.includes('none validated as available'), 'fuzzy injection: failed validation reports no available models');
  assert(failedFuzzy.warning?.includes('model: unavailable') && failedFuzzy.warning?.includes('Discovery:'), 'fuzzy injection: failed validation warning includes model status and discovery context');
  assert(!JSON.stringify(failedFuzzy).includes('test-key-broken'), 'fuzzy injection: failed validation result does not leak API key');
  const githubFuzzy = await agent.fuzzyInject('GitHub Copilot', 'https://models.github.ai', 'ghp-test-token');
  assert(githubFuzzy.ok === false && githubFuzzy.warning?.includes('precise browser login'), 'fuzzy injection: GitHub/Copilot requires exact browser login and is rejected');
  LLMProvider.prototype.listModels = originalListModels;
  LLMProvider.prototype.validate = originalValidate;

  // ---- 13. LLM Provider Tests ----
  console.log('\n🤖 LLM Provider');
  const llm = new LLMProvider('test', 'https://api.example.com/v1', 'test-key-basic');
  assert(llm.name === 'test', 'LLMProvider: stores name');
  assert(llm.baseUrl === 'https://api.example.com/v1', 'LLMProvider: stores url');

  const lowInt = llm.intelligenceConfig('low');
  assert(lowInt.temperature === 0.3, 'intelligenceConfig: low temp = 0.3');
  assert(lowInt.maxTokens === 2048, 'intelligenceConfig: low maxTokens');

  const medInt = llm.intelligenceConfig('medium');
  assert(medInt.temperature === 0.7, 'intelligenceConfig: medium temp = 0.7');

  const highInt = llm.intelligenceConfig('high');
  assert(highInt.temperature === 0.8, 'intelligenceConfig: high temp = 0.8');
  assert(highInt.maxTokens === 16384, 'intelligenceConfig: high maxTokens');
  const originalFetch = globalThis.fetch;
  let anthropicRequest: { url: string; headers: Record<string, string>; body: Record<string, any> } | null = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    anthropicRequest = {
      url,
      headers: (init?.headers || {}) as Record<string, string>,
      body: JSON.parse(String(init?.body || '{}')),
    };
    return new Response(JSON.stringify({
      content: [
        { type: 'text', text: 'anthropic ok' },
        { type: 'tool_use', id: 'toolu_1', name: 'write', input: { path: 'README.md', content: 'ok' } },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const anthropicProvider = new LLMProvider('deepseek-anthropic', 'https://api.deepseek.com/anthropic', 'test-key');
  const anthropicTokens: StreamToken[] = [];
  for await (const tok of anthropicProvider.chatStreamWithTools(
    'deepseek-v4-flash',
    [
      { role: 'user', content: 'Use a tool' },
      { role: 'assistant', tool_calls: [{ id: 'toolu_prev', type: 'function', function: { name: 'read', arguments: '{"path":"README.md"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_prev', name: 'read', content: 'read result' },
    ],
    'system prompt',
    0.2,
    100,
    [{ type: 'function', function: { name: 'write', description: 'Write file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]
  )) {
    anthropicTokens.push(tok);
  }
  const capturedAnthropicRequest = anthropicRequest as { url: string; headers: Record<string, string>; body: Record<string, any> } | null;
  globalThis.fetch = originalFetch;
  assert(!!capturedAnthropicRequest && capturedAnthropicRequest.url === 'https://api.deepseek.com/anthropic/messages', 'LLMProvider Anthropic: uses messages endpoint');
  assert(!!capturedAnthropicRequest && capturedAnthropicRequest.headers['x-api-key'] === 'test-key' && !!capturedAnthropicRequest.headers['anthropic-version'], 'LLMProvider Anthropic: uses Anthropic headers');
  assert(!!capturedAnthropicRequest && capturedAnthropicRequest.body.system === 'system prompt', 'LLMProvider Anthropic: sends system prompt separately');
  assert(!!capturedAnthropicRequest && Array.isArray(capturedAnthropicRequest.body.tools) && capturedAnthropicRequest.body.tools[0].input_schema.type === 'object', 'LLMProvider Anthropic: converts tools to input_schema');
  assert(!!capturedAnthropicRequest && JSON.stringify(capturedAnthropicRequest.body.messages).includes('tool_result'), 'LLMProvider Anthropic: converts tool results');
  assert(anthropicTokens.some(t => t.type === 'text' && t.text === 'anthropic ok'), 'LLMProvider Anthropic: parses text blocks');
  assert(anthropicTokens.some(t => t.type === 'tool_call' && t.toolCall?.name === 'write' && t.toolCall.arguments.includes('README.md')), 'LLMProvider Anthropic: parses tool_use blocks');

  let explicitAnthropicUrl = '';
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    explicitAnthropicUrl = String(url);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'explicit ok' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const explicitAnthropicProvider = new LLMProvider('custom-provider', 'https://api.example.com/v1', 'test-key', 'anthropic');
  await explicitAnthropicProvider.chat('custom-model', [{ role: 'user', content: 'Hi' }], null, 0.1, 50);
  globalThis.fetch = originalFetch;
  assert(explicitAnthropicUrl === 'https://api.example.com/v1/messages', 'LLMProvider Anthropic: explicit protocol overrides URL heuristic');

  let fallbackRequestBody = '';
  let fallbackRequestPath = '';
  LLMProvider.nodeHttpTransport = async (_method, url, _headers, body) => {
    fallbackRequestPath = new URL(url).pathname;
    fallbackRequestBody = body || '';
    return {
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: 'fallback ok' } }],
      }),
    };
  };
  globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const fallbackProvider = new LLMProvider('api-nebula', 'https://apinebula.com/v1', 'test-key', 'openai');
  const fallbackText = await fallbackProvider.chat('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], null, 0, 20);
  const fallbackTokens: StreamToken[] = [];
  for await (const tok of fallbackProvider.chatStreamWithTools('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], null, 0, 20, [])) {
    fallbackTokens.push(tok);
  }
  globalThis.fetch = originalFetch;
  LLMProvider.nodeHttpTransport = null;
  assert(fallbackRequestPath === '/v1/chat/completions', 'LLMProvider fallback: uses chat completions path');
  assert(fallbackText === 'fallback ok', 'LLMProvider fallback: chat returns content after fetch failed');
  assert(fallbackTokens.some(t => t.type === 'text' && t.text === 'fallback ok'), 'LLMProvider fallback: stream path falls back to non-stream content');
  assert(fallbackRequestBody.includes('"stream":false'), 'LLMProvider fallback: disables stream for HTTP fallback');

  const responsesPaths: string[] = [];
  const responsesBodies: any[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    responsesPaths.push(pathname);
    responsesBodies.push(JSON.parse(String(init?.body || '{}')));
    if (pathname.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ error: { code: 'unsupported_api_for_model', message: 'Use the Responses API for this model.' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      output_text: 'responses fallback ok 做了什么 验证 文件',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'responses fallback ok 做了什么 验证 文件' }] },
        { type: 'function_call', call_id: 'call_write', name: 'write', arguments: '{"path":"README.md","content":"ok"}' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const responsesProvider = new LLMProvider('api-nebula', 'https://apinebula.example/v1', 'test-key', 'openai');
  const responsesText = await responsesProvider.chat('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], 'system text', 0, 20);
  const responsesTokens: StreamToken[] = [];
  for await (const tok of responsesProvider.chatStreamWithTools(
    'gpt-5.4-mini',
    [{ role: 'user', content: 'Use tool' }],
    'system text',
    0,
    20,
    [{ type: 'function', function: { name: 'write', description: 'Write file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]
  )) {
    responsesTokens.push(tok);
  }
  globalThis.fetch = originalFetch;
  assert(responsesPaths.filter(p => p.endsWith('/chat/completions')).length === 2, 'LLMProvider responses fallback: tries chat completions first');
  assert(responsesPaths.filter(p => p.endsWith('/responses')).length === 2, 'LLMProvider responses fallback: falls back to responses endpoint');
  assert(responsesText === 'responses fallback ok 做了什么 验证 文件', 'LLMProvider responses fallback: chat parses output_text');
  assert(responsesTokens.some(t => t.type === 'text' && t.text?.includes('responses fallback ok')), 'LLMProvider responses fallback: stream parses response text');
  assert(responsesTokens.some(t => t.type === 'tool_call' && t.toolCall?.name === 'write' && t.toolCall.arguments.includes('README.md')), 'LLMProvider responses fallback: parses function_call tools');
  assert(responsesBodies.some(b => b.instructions === 'system text' && b.max_output_tokens === 20), 'LLMProvider responses fallback: maps instructions and max_output_tokens');
  assert(responsesBodies.some(b => Array.isArray(b.tools) && b.tools[0]?.type === 'function' && b.tools[0]?.name === 'write'), 'LLMProvider responses fallback: converts chat tools to responses tools');
  responsesBodies.length = 0;
  responsesPaths.length = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    responsesPaths.push(pathname);
    responsesBodies.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify({ output_text: 'responses tool result ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const responsesToolResultProvider = new LLMProvider('direct-responses-tool-result', 'https://responses.example/v1', 'test-key', 'openai', 'responses');
  await responsesToolResultProvider.chatStreamWithTools('gpt-5.4-mini', [
    { role: 'user', content: 'Use a tool' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_prev', type: 'function', function: { name: 'write', arguments: '{"path":"README.md"}' } }] },
    { role: 'tool', tool_call_id: 'call_prev', name: 'write', content: 'write result' },
  ], 'system text', 0, 20, []).next();
  globalThis.fetch = originalFetch;
  const toolResultBody = responsesBodies[0] || {};
  assert(Array.isArray(toolResultBody.input) && toolResultBody.input.some((item: any) => item.type === 'function_call' && item.call_id === 'call_prev' && item.name === 'write') && toolResultBody.input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'call_prev'), 'LLMProvider Responses mode: includes prior function_call before function_call_output');
  assert(toolResultBody.input.findIndex((item: any) => item.type === 'function_call' && item.call_id === 'call_prev') < toolResultBody.input.findIndex((item: any) => item.type === 'function_call_output' && item.call_id === 'call_prev'), 'LLMProvider Responses mode: orders function_call before matching function_call_output');

  const directResponsesPaths: string[] = [];
  globalThis.fetch = (async (url: string) => {
    directResponsesPaths.push(new URL(String(url)).pathname);
    return new Response(JSON.stringify({ output_text: 'direct responses ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const directResponsesProvider = new LLMProvider('direct-responses', 'https://responses.example/v1', 'test-key', 'openai', 'responses');
  const directResponsesText = await directResponsesProvider.chat('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], null, 0, 20);
  const directResponsesTokens: StreamToken[] = [];
  for await (const tok of directResponsesProvider.chatStreamWithTools('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], null, 0, 20, [])) directResponsesTokens.push(tok);
  globalThis.fetch = originalFetch;
  assert(directResponsesText === 'direct responses ok' && directResponsesTokens.some(t => t.text === 'direct responses ok'), 'LLMProvider Responses mode: parses direct Responses API output');
  assert(directResponsesPaths.length === 2 && directResponsesPaths.every(p => p.endsWith('/responses')), 'LLMProvider Responses mode: uses /responses directly without chat-completions probe');

  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: { message: 'response mode rejected' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const directResponsesErrorProvider = new LLMProvider('direct-responses-error', 'https://responses.example/v1', 'test-key', 'openai', 'responses');
  const directResponsesErrorText = await directResponsesErrorProvider.chat('bad-model', [{ role: 'user', content: 'Hi' }], null, 0, 20);
  const directResponsesValidation = await directResponsesErrorProvider.validate('bad-model');
  globalThis.fetch = originalFetch;
  assert(directResponsesErrorText.startsWith('[LLM Error: 400]') && directResponsesValidation.ok === false, 'LLMProvider Responses mode: failed direct responses calls return controlled error text and validate as unavailable');

  const directChatPaths: string[] = [];
  const directChatBodies: any[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    directChatPaths.push(new URL(String(url)).pathname);
    directChatBodies.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'direct chat ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const directChatProvider = new LLMProvider('direct-chat', 'https://chat.example/v1', 'test-key', 'openai', 'chat');
  const directChatTokens: StreamToken[] = [];
  for await (const tok of directChatProvider.chatStreamWithTools('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], null, 0, 20, [])) directChatTokens.push(tok);
  globalThis.fetch = originalFetch;
  assert(directChatPaths.length === 1 && directChatPaths[0].endsWith('/chat/completions'), 'LLMProvider Chat mode: uses chat completions directly');
  assert(directChatBodies[0]?.stream === false && directChatTokens.some(t => t.text === 'direct chat ok'), 'LLMProvider Chat mode: disables streaming and yields text');

  const githubModelsRequests: Array<{ path: string; auth: string; apiVersion: string; body: any }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const headerValue = (key: string) => {
      const headers = init?.headers as Headers | Record<string, string> | undefined;
      if (!headers) return '';
      if (typeof (headers as Headers).get === 'function') return String((headers as Headers).get(key) || '');
      return String((headers as Record<string, string>)[key] || '');
    };
    githubModelsRequests.push({
      path: parsed.pathname,
      auth: headerValue('Authorization'),
      apiVersion: headerValue('X-GitHub-Api-Version'),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    if (parsed.pathname.endsWith('/catalog/models')) {
      return new Response(JSON.stringify({ models: [{ id: 'openai/gpt-4.1' }, { id: 'mistral-ai/mistral-large-2411' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'github models ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const githubProvider = new LLMProvider('GitHub Copilot', 'https://models.github.ai', 'ghp-test-token', 'github_models', 'responses');
  const githubModels = await githubProvider.listModels();
  const githubChat = await githubProvider.chat('openai/gpt-4.1', [{ role: 'user', content: 'Hi' }], null, 0, 20);
  globalThis.fetch = originalFetch;
  assert(githubModels.includes('openai/gpt-4.1') && githubModels.includes('mistral-ai/mistral-large-2411'), 'LLMProvider GitHub Models: lists catalog model ids');
  assert(githubChat === 'github models ok', 'LLMProvider GitHub Models: chats through inference endpoint');
  assert(githubModelsRequests.some(r => r.path === '/catalog/models') && githubModelsRequests.some(r => r.path === '/inference/chat/completions'), 'LLMProvider GitHub Models: uses catalog and inference paths');
  assert(githubModelsRequests.every(r => r.auth === 'Bearer ghp-test-token' && r.apiVersion === '2022-11-28'), 'LLMProvider GitHub Models: sends GitHub token and API version headers');

  const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'llm', 'provider.ts'), 'utf-8');
  assert(providerSource.includes('[System.IO.File]::ReadAllText($bodyPath, $utf8NoBom)'), 'LLMProvider fallback: PowerShell reads request body as UTF-8 file');
  assert(providerSource.includes('$resp.RawContentStream.CopyTo($out)') && providerSource.includes('[System.IO.File]::WriteAllText($responsePath, [string]$resp.Content, $utf8NoBom)'), 'LLMProvider fallback: PowerShell writes raw response bytes before UTF-8 fallback');
  assert(providerSource.includes("fs.readFileSync(responsePath, 'utf8')"), 'LLMProvider fallback: Node reads PowerShell response file as UTF-8');
  assert(!providerSource.includes('$bodyJson = [Console]::In.ReadToEnd()'), 'LLMProvider fallback: PowerShell does not stream JSON body through command stdin');
  assert(!providerSource.includes('Write-Output $resp.Content'), 'LLMProvider fallback: PowerShell does not stream response body through console stdout');

  LLMProvider.nodeHttpTransport = async () => { throw new Error('node fallback failed'); };
  LLMProvider.powershellTransport = async (_method, url, _headers, body) => {
    fallbackRequestPath = new URL(url).pathname;
    fallbackRequestBody = body || '';
    return {
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: 'powershell fallback ok 做了什么 验证 文件' } }],
      }),
    };
  };
  globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  if (process.platform === 'win32') {
    const psFallbackText = await fallbackProvider.chat('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], null, 0, 20);
    assert(psFallbackText === 'powershell fallback ok 做了什么 验证 文件', 'LLMProvider fallback: PowerShell transport recovers after Node HTTP failure with UTF-8 text');
  } else {
    let nonWindowsError = '';
    try {
      await fallbackProvider.chat('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], null, 0, 20);
    } catch (e) {
      nonWindowsError = e instanceof Error ? e.message : String(e);
    }
    assert(nonWindowsError.includes('node fallback failed'), 'LLMProvider fallback: non-Windows does not call Windows-only PowerShell transport');
  }
  globalThis.fetch = originalFetch;
  LLMProvider.nodeHttpTransport = null;
  LLMProvider.powershellTransport = null;

  // ---- 14. Workspace Goal Items Tests ----
  console.log('\n📋 Goal Items');
  agent.workspaceGoalItems = [
    { text: 'Task 1', done: false },
    { text: 'Task 2', done: true },
    { text: 'Task 3', done: false },
  ];
  assert(agent.workspaceGoalItems.length === 3, 'goalItems: 3 items');
  assert(agent.workspaceGoalItems[1].done === true, 'goalItems: second is done');

  // ---- 15. OpenCode Engine Fallback ----
  console.log('\n🔗 OpenCode Integration');
  agent.engine = 'opencode';
  const ocTokens = await agent.process('test');
  assert(ocTokens.length >= 1, 'opencode engine: produces output');
  assert(ocTokens[0].text.includes('Error') || ocTokens[0].text.includes('built-in'),
    'opencode: graceful fallback when CLI not found');
  agent.engine = 'builtin'; // restore

  // ---- Final Summary ----
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  ${PASS} ${passed} passed  ${FAIL} ${failed} failed`);
  console.log(`  Total: ${passed + failed} assertions`);
  console.log(`═══════════════════════════════════════\n`);

  cleanup();

  if (failed > 0) {
    console.log('⚠️  Some tests FAILED. Check output above.');
    process.exit(1);
  } else {
    console.log('🎉 All tests passed!');
    process.exit(0);
  }
}

main().catch(e => {
  console.error('Test suite error:', e);
  cleanup();
  process.exit(1);
});
