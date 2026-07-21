/**
 * Newmark Agent �?Comprehensive Feature Verification Tests
 * Tests every function without requiring a real LLM API.
 * Run: npm run build && node dist/tests/verify.js
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
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
import { WslAgentClient, windowsDrivePathToWsl } from '../core/wslAgentClient';
import { agentKernelRunnerInternals } from '../core/agentKernelRunner';
import { verifyWorkspaceFileRouter } from './workspaceFileRouterVerify';
import { verifyPdfPreviewServer } from './pdfPreviewServerVerify';
import { verifyEditorLifecycle } from './editorLifecycleVerify';
import { PNG } from 'pngjs';

const TEST_DIR = path.join(process.cwd(), 'test-tmp');
const PASS = '[PASS]';
const FAIL = '[FAIL]';
let passed = 0;
let failed = 0;
let externalTestDir = '';

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
  if (externalTestDir) {
    try { fs.rmSync(externalTestDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    externalTestDir = '';
  }
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

type ValidationProviderFixture = {
  validModels: ReadonlySet<string>;
  visionModels?: ReadonlySet<string>;
  catalogs?: Readonly<Record<string, readonly string[]>>;
  rejectedBaseUrls?: ReadonlySet<string>;
};

/**
 * Exercise Agent.validateModels through the same provider adapter used in
 * production while keeping the legacy integration suite provider-offline.
 */
function installValidationProviderFixture(fixture: ValidationProviderFixture): () => void {
  const originalChat = LLMProvider.prototype.chat;
  const originalChatStreamWithTools = LLMProvider.prototype.chatStreamWithTools;
  const originalChatStrictJson = LLMProvider.prototype.chatStrictJson;
  const originalProbeStreamCompletion = LLMProvider.prototype.probeStreamCompletion;
  const originalModelCatalog = LLMProvider.prototype.modelCatalog;
  const expectedVisionAnswer = '{"left":"red_square","right":"blue_circle","bottom":"green_triangle","marker":"NM7"}';
  const nonceFrom = (value: unknown): string => {
    const matches = JSON.stringify(value).match(/NMK-[a-z0-9-]+/gi) || [];
    return matches[matches.length - 1] || '';
  };
  const rejects = (provider: LLMProvider, modelName: string): boolean =>
    !fixture.validModels.has(modelName) || [...(fixture.rejectedBaseUrls || [])].some(baseUrl => provider.baseUrl.includes(baseUrl));

  LLMProvider.prototype.modelCatalog = async function() {
    const entry = Object.entries(fixture.catalogs || {}).find(([baseUrl]) => this.baseUrl.includes(baseUrl));
    return (entry?.[1] || []).map(id => ({ id, raw: { id } }));
  };
  LLMProvider.prototype.chat = async function(modelName: string, messages: Array<Record<string, unknown>>, systemPrompt?: string | null) {
    if (rejects(this, modelName)) return '[LLM Error: 404] deterministic validation fixture rejected model';
    const serialized = JSON.stringify(messages);
    if (serialized.includes('NEWMARK_HEALTH_OK')) return 'NEWMARK_HEALTH_OK';
    if (String(systemPrompt || '').includes('visual capability probe')) {
      return fixture.visionModels?.has(modelName) ? expectedVisionAnswer : '{"vision":"probe_failed"}';
    }
    const nonce = nonceFrom(messages);
    if (serialized.includes('strict JSON object') || serialized.includes('Schema:')) return JSON.stringify({ nonce });
    return nonce || 'DETERMINISTIC_VALIDATION_TEXT';
  };
  LLMProvider.prototype.chatStreamWithTools = async function* (
    modelName: string,
    messages: Array<Record<string, unknown>>,
    _systemPrompt: string | null,
    _temperature: number,
    _maxTokens: number,
    tools: unknown[],
  ) {
    if (rejects(this, modelName)) {
      yield { type: 'text', text: '[LLM Error: 404] deterministic validation fixture rejected model' } as StreamToken;
      return;
    }
    const nonce = nonceFrom(messages);
    if (tools.length > 0) {
      if (messages.some(message => message.role === 'tool')) {
        yield { type: 'text', text: nonce } as StreamToken;
        return;
      }
      yield {
        type: 'tool_call',
        toolCall: {
          id: `validation-${modelName}`,
          name: 'newmark_validation_echo',
          arguments: JSON.stringify({ nonce }),
        },
      } as StreamToken;
      return;
    }
    yield { type: 'text', text: nonce } as StreamToken;
  };
  LLMProvider.prototype.chatStrictJson = async function(modelName: string, messages: Array<Record<string, unknown>>) {
    if (rejects(this, modelName)) return '[LLM Error: 404] deterministic validation fixture rejected model';
    return JSON.stringify({ nonce: nonceFrom(messages) });
  };
  LLMProvider.prototype.probeStreamCompletion = async function(modelName: string, messages: Array<Record<string, unknown>>) {
    if (rejects(this, modelName)) throw new Error('[LLM Error: 404] deterministic validation fixture rejected model');
    return {
      chunks: [nonceFrom(messages)],
      completionEvent: 'openai_done' as const,
    };
  };

  return () => {
    LLMProvider.prototype.chat = originalChat;
    LLMProvider.prototype.chatStreamWithTools = originalChatStreamWithTools;
    LLMProvider.prototype.chatStrictJson = originalChatStrictJson;
    LLMProvider.prototype.probeStreamCompletion = originalProbeStreamCompletion;
    LLMProvider.prototype.modelCatalog = originalModelCatalog;
  };
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

  cleanup();
  setup();

  console.log('\nSafe Workspace File Router');
  await verifyWorkspaceFileRouter(TEST_DIR, assert);
  await verifyPdfPreviewServer(TEST_DIR, assert);

  // ---- 0. UI HTML Regression Tests ----
  console.log('\nUI HTML');
  const uiHtmlPath = path.join(process.cwd(), 'src', 'ui', 'index.html');
  assert(fs.existsSync(uiHtmlPath), 'ui html: index.html exists');
  const uiHtml = fs.readFileSync(uiHtmlPath, 'utf-8');
  await verifyEditorLifecycle(uiHtml, assert);
  const mainSource = fs.readFileSync(path.join(process.cwd(), 'src', 'main.ts'), 'utf-8');
  const preloadSource = fs.readFileSync(path.join(process.cwd(), 'src', 'preload.ts'), 'utf-8');
  const fileRouterSource = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'workspaceFileRouter.ts'), 'utf-8');
  const conversationAttachmentsSource = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'conversationAttachments.ts'), 'utf-8');
  const uiPreferencesSource = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'uiPreferences.ts'), 'utf-8');
  const inlineScripts = Array.from(uiHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g), match => match[1])
    .filter(source => source.trim().length > 0);
  assert(inlineScripts.length > 0, 'ui html: inline script exists');
  let scriptParseError = '';
  for (const source of inlineScripts) {
    try {
      new Function(source);
    } catch (error) {
      scriptParseError = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  assert(!scriptParseError, 'ui html: inline script parses', scriptParseError);
  assert(Buffer.from(uiHtml, 'utf8').toString('utf8') === uiHtml, 'ui html: UTF-8 source is readable');
  assert(preloadSource.includes("ipcRenderer.invoke('agent:openWorkspaceFile'") && preloadSource.includes("ipcRenderer.invoke('agent:saveWorkspaceFile'")
    && preloadSource.includes("ipcRenderer.invoke('agent:closeWorkspaceFile'") && preloadSource.includes("ipcRenderer.invoke('agent:confirmEditorClose'")
    && mainSource.includes("protocol.handle('newmark-preview'") && mainSource.includes('new PdfPreviewServer(')
    && mainSource.includes('pdfPreviewServer.urlFor(result.capability, ownerId)') && mainSource.includes('pdfPreviewServer.revokeOwner(fileRouterOwnerId)')
    && mainSource.includes("shell.showItemInFolder(result.path)") && mainSource.includes("shell.openPath(result.path)"),
  'safe file router: preload/main expose controlled editor, preview, external, and reveal routes');
  assert(preloadSource.includes("ipcRenderer.invoke('flow:list'") && preloadSource.includes("ipcRenderer.invoke('workspace:readPrompt'")
    && !preloadSource.includes("ipcRenderer.invoke('agent:readFile'") && !preloadSource.includes("ipcRenderer.invoke('agent:saveFile'") && !preloadSource.includes("ipcRenderer.invoke('agent:listFiles'")
    && !mainSource.includes("ipcMain.handle('agent:readFile'") && !mainSource.includes("ipcMain.handle('agent:saveFile'") && !mainSource.includes("ipcMain.handle('agent:listFiles'"),
  'renderer file access: arbitrary read/write/list IPC is removed in favor of purpose-scoped APIs');
  assert(uiHtml.includes('api.openWorkspaceFile(path)') && uiHtml.includes('api.saveWorkspaceFile(state.editorToken, content, state.editorRevision)')
    && uiHtml.includes('newmark-preview:\\/\\/') && !uiHtml.includes('partition="persist:newmark-browser" allowpopups'),
  'safe file router: tree and linked files use token-bound routing while browser popups stay disabled');
  assert(uiHtml.includes('window.resetEditorSurface = function')
    && uiHtml.includes('window.requestEditorTransition = async function')
    && uiHtml.includes("api.confirmEditorClose(currentLang(), state.editorPath)")
    && uiHtml.includes('state.editorOpenGeneration')
    && uiHtml.includes('window.resetEditorSurface({ revoke: true });')
    && uiHtml.includes('window.resetEditorSurface({ revoke: false });')
    && uiHtml.includes('generation !== state.editorOpenGeneration')
    && uiHtml.includes("result.kind === 'editor' && result.token && api.closeWorkspaceFile")
    && uiHtml.includes("preview.classList.remove('open')")
    && uiHtml.includes('preview.replaceChildren()')
    && uiHtml.includes("main.style.display = 'grid'")
    && uiHtml.includes("toggle.classList.remove('visible')"),
  'native editor: every transition resets Markdown DOM and serializes dirty save/discard/cancel decisions');
  assert(uiHtml.includes('--editor-bg: #0b0d14') && uiHtml.includes('--editor-bg: #f7f8fc')
    && uiHtml.includes('background:var(--editor-bg)') && uiHtml.includes('caret-color:var(--editor-caret)')
    && uiHtml.includes('.tok-keyword{color:var(--editor-keyword)}') && uiHtml.includes('background:var(--editor-completion-bg)'),
  'native editor: dark and light themes use separate editor, caret, syntax, prediction, and completion palettes');
  assert(uiHtml.includes("iconSvg('image', 'Open image', 'tiny')") && !uiHtml.includes("return 'file:///' + url.replace"),
  'safe file router: local Markdown images no longer bypass workspace routing with direct file URLs');
  assert(fileRouterSource.includes('FILE_HEADER_BYTES = 64 * 1024') && fileRouterSource.includes('MAX_EDITOR_BYTES = 5 * 1024 * 1024')
    && fileRouterSource.includes("'.bat', '.cmd', '.ps1'") && fileRouterSource.includes("reason: 'script-too-large'")
    && fileRouterSource.includes("reason: 'executable'") && fileRouterSource.includes("fs.promises.realpath"),
  'safe file router: header detection, size caps, script/executable safety, and realpath confinement are source-locked');
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
  assert(uiHtml.includes('function formatModelStatus(status)') && uiHtml.includes("if (raw === 'available' || raw === 'verified') return t('model.available')") && uiHtml.includes("if (raw === 'degraded') return t('model.degraded')") && uiHtml.includes("if (raw === 'unavailable' || raw === 'failed' || raw === 'error') return t('model.unavailable')"), 'ui html: model validation statuses are localized');
  assert(uiHtml.includes("title=\"' + escAttr(t('common.remove')) + '\"") && !uiHtml.includes("iconSvg('x', 'Remove model'"), 'ui html: model remove action uses localized title/icon label');
  assert(uiHtml.includes('function setTitleAndTrailingLabel(selector, label)') && uiHtml.includes('setTitleAndTrailingLabel(\'.secondary-top button[onclick="window.newConversation()"]\'') && uiHtml.includes('setTitleAndTrailingLabel(\'button.et-btn[onclick="window.closeEditor()"]\''), 'ui html: language switch updates secondary sidebar and editor labels');
  assert(uiHtml.includes('function rerenderActiveSubWindowForLanguage()') && uiHtml.includes("state.activeSubWindowView = { name: 'workspaceRequired' }") && uiHtml.includes("state.activeSubWindowView = { name: 'plugins'"), 'ui html: language switch rerenders active secondary windows');
  assert(uiHtml.includes('window.showMemoryLab = function()') && uiHtml.includes("state.activeSubWindowView = { name: 'memoryLab'") && uiHtml.includes("t('memoryLab.title')"), 'ui html: Memory Lab left toolbar entry and panel renderer exist');
  assert(uiHtml.includes('api.memoryLabRead') && uiHtml.includes('memoryLabReindex') && uiHtml.includes("lucide-sprite.svg#brain"), 'ui html: Memory Lab preload API and icon are wired');
  assert(uiHtml.includes('window.setInputMode = function(mode, persist)') && uiHtml.includes('api.setInputMode(state.inputMode)') && uiHtml.includes('window.setInputMode(s.inputMode, false)'), 'ui html: Guide/Next mode persists through backend and restores without write-back on state hydration');
  assert(uiHtml.includes('function renderWorkRunGuideMessage(event)') && uiHtml.includes('function workRunGuideEvents(run)') && uiHtml.includes('work-run-collapsed-guides') && uiHtml.includes('work-run-guide-message chat-msg') === false && uiHtml.includes('chat-msg user work-run-guide-message'), 'ui html: Guide renders as a right-aligned user message, interleaves by work-event sequence when expanded, and lists below the Build header when collapsed');
  assert(uiHtml.includes("name === 'context_compression'") && uiHtml.includes("'已完成上下文压缩'") && uiHtml.includes("'Completed context compression'"), 'ui html: completed context compression renders as a Build activity alongside tool work');
  assert(uiHtml.includes('window.setMemoryLabReindexing = function(running)') && uiHtml.includes("panel.classList.toggle('marquee-border', state.memoryLabReindexing)") && uiHtml.includes('window.setMemoryLabReindexing(true);') && uiHtml.includes('.finally(function()') && uiHtml.includes('window.setMemoryLabReindexing(false);') && !uiHtml.includes('id="memory-lab-panel" class="provider-card marquee-border"'), 'ui html: Memory Lab animated border is shown only while reindex is pending and always clears afterward');
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
  const modelValidationGuard = uiHtml.indexOf('if (!hasBaseModel) {');
  assert(modelValidationGuard >= 0
    && uiHtml.indexOf("t('model.validationRequiresBaseModel')", modelValidationGuard) < uiHtml.indexOf("document.body.classList.add('model-evaluating')", modelValidationGuard)
    && uiHtml.indexOf("document.body.classList.add('model-evaluating')", modelValidationGuard) < uiHtml.indexOf('api.validateModels()', modelValidationGuard),
  'ui model validation: missing base models show actionable feedback before animation or backend validation starts');
  assert(uiHtml.includes('id="input-stack"') && uiHtml.includes('id="queue-panel"') && uiHtml.includes('window.renderQueuePanel = function()') && uiHtml.includes('window.editQueueItem = function(idx, value)') && uiHtml.includes('window.dropQueueDrag = function(event, idx)') && uiHtml.includes('window.renderScrollBottomAffordance = renderScrollBottomAffordance') && uiHtml.includes('state.conversationPlan.items.push') && uiHtml.includes('state.todoCollapsed = false'), 'ui html: bottom input stack exposes editable queue, draggable ordering, scroll affordance, Goal bar, and Plan-backed checklist');
  assert(uiHtml.includes('.work-review-head') && uiHtml.includes('function addWorkReview(diffs)') && uiHtml.includes('window.openWorkReview') && uiHtml.includes('window.toggleWorkReviewFiles') && uiHtml.includes('lockedUi.pendingWorkReview = r.diffs') && uiHtml.indexOf('lockedUi.pendingWorkReview = r.diffs') < uiHtml.indexOf('if (stillActive && !responseOwnedByRun)'), 'work completion review: Build-owned and legacy final responses both retain conversation-bound changed files with expandable rows and a review action');
  assert(uiHtml.includes('.work-review-detail .file-row {') && uiHtml.includes('.work-review-detail .file-row:hover') && uiHtml.includes('.work-review-detail .file-row:focus-visible') && uiHtml.includes('<button type="button" class="file-row"'), 'work completion review: detail rows use themed button, hover, and keyboard-focus states');
  assert(uiHtml.includes('--review-bg: rgba(255,255,255,.82)') && uiHtml.includes('background:var(--review-bg)') && uiHtml.includes('background:var(--review-row-hover)'), 'work completion review: uses explicit light-theme surfaces instead of hard-coded dark cards');
  assert(uiHtml.includes('window.openWorkReviewFile') && uiHtml.includes('editor-review-deletions') && uiHtml.includes('editor-review-added-line') && uiHtml.includes('window.reviewAddedLineIndexes') && uiHtml.includes('state.editorReviewDiff.addedLines'), 'work completion review: opens an editable green-added-line diff while rendering red deleted lines in a separate read-only layer');
  assert(uiHtml.includes('#goal-bar .stack-row::before') && uiHtml.includes('#goal-bar.goal-paused') && uiHtml.includes('width: calc(100% - 40px)') && uiHtml.includes("bar.classList.toggle('goal-paused'"), 'task/queue/goal bars: use a compact restrained control-band hierarchy with explicit goal state');
  assert(!uiHtml.includes("window.openSubWin('Model validation'") && !uiHtml.includes("window.openSubWin('Workspace required'") && !uiHtml.includes("window.openSubWin('New conversation'") && !uiHtml.includes("window.openSubWin('Plugin manager'"), 'ui html: dynamic window titles are not hard-coded English');
  assert(!/(^|[^<])\/(span|button|option|label|div)>/.test(uiHtml), 'ui html: no broken inline closing tags');
  assert(uiHtml.includes('New workspace'), 'ui html: new workspace label present');
  assert(uiHtml.includes('Flow editor'), 'ui html: flow editor label present');
  assert(uiHtml.includes('Ctrl+Enter uses the opposite mode.'), 'ui html: Ctrl+Enter setting text present');
  assert(uiHtml.includes("'model.fuzzy': 'Fuzzy inject model'") && uiHtml.includes("t('model.fuzzy')"), 'ui html: fuzzy injection label present through i18n');
  assert(uiHtml.includes('function redactSensitiveText(value)') && uiHtml.includes("replace(/sk-[A-Za-z0-9_\\-.]{8,}/g, 'sk-redacted')"), 'ui html: redacts API keys from visible messages');
  assert(uiHtml.includes("redactSensitiveText('[System] Fuzzy injection did not pass validation:") && uiHtml.includes("redactSensitiveText('[Error] Fuzzy injection failed:"), 'ui html: fuzzy injection messages are redacted');
  assert(uiHtml.includes('WORKFLOW TIMELINE') && uiHtml.includes('function renderChatMessages(messages)') && uiHtml.includes('function currentLang()') && uiHtml.includes('function conversationWorkUiState(conversationId, workspaceId)') && uiHtml.includes('agentWorkUiByConversation') && uiHtml.includes('function ensureActiveAssistantMsg(mode, model, conversationId)') && uiHtml.includes('function upsertToolEvent(event, resultText)') && uiHtml.includes('function toolBatchSummary(batch)') && uiHtml.includes('function renderToolBatch(batch)') && uiHtml.includes('function finishToolBatch(conversationId)') && uiHtml.includes('function renderConversationWorkRuns(runs, target)') && uiHtml.includes('function findCompletedWorkflowMsg(conversationId, text)') && uiHtml.includes('function markFinalResponseMsg(conversationId, text, msg)') && uiHtml.includes('function findPendingFinalResponseMsg(conversationId, streamText)') && uiHtml.includes('function responseTextLooksLikeCompactPrefix(prefix, full)') && uiHtml.includes('conversationWorkUiState(conversationId).lastCompletedWorkflow') && uiHtml.includes('findCompletedWorkflowMsg(lockedConversationId, fullText)') && uiHtml.includes('markFinalResponseMsg(lockedConversationId, fullText, responseMsg)') && uiHtml.includes('正在编辑 ') && uiHtml.includes('已编辑 ') && uiHtml.includes('class="tool-event-details"') && !uiHtml.includes("addMsg('workflow running', 'Preparing request...'") && !uiHtml.includes('Agent is working'), 'ui html: conversation renders live assistant text, public work runs, and folded tool details without duplicate final echoes');
  assert(uiHtml.includes("events[priorEventIndex] = Object.assign({}, priorEvent, { completed: true })")
    && uiHtml.includes("event.completed ? (currentLang() === 'zh' ? ' · 已完成' : ' · completed')")
    && !uiHtml.includes("element.classList.contains('running')")
    && uiHtml.includes('var expanded = run.expanded === undefined ? live : !!run.expanded'), 'ui html: completed tools update their original row and running Build blocks remain collapsible with a default-expanded state');
  assert(!uiHtml.includes('state._activeWorkflowMsg') && !uiHtml.includes('state._activeWorkflowText') && !uiHtml.includes('state._toolEventMsgs') && !uiHtml.includes('state._toolEventBatch') && !uiHtml.includes('state._lastCompletedWorkflow'), 'ui html: live workflow feedback state is conversation-scoped, not a global singleton');
  assert(uiHtml.includes('function isHiddenWorkflowMessage(message)') && uiHtml.includes('Preparing model request and available tools') && uiHtml.includes('Executing \\d+ tool call') && uiHtml.includes("if (String(m.role || '') === 'workflow' && /^tool:/.test(String(m.mode || ''))) continue;"), 'ui html: hides internal workflow status rows and suppresses legacy persisted tool chat rows now owned by Build runs');
  assert(uiHtml.includes('background: transparent;') && uiHtml.includes('border-radius: 0;') && uiHtml.includes('#chat-area:has(> .chat-msg)') && uiHtml.includes('background-position: left 32px top, right 32px top;') && uiHtml.includes('background-attachment: local;') && !uiHtml.includes('.chat-msg::before') && uiHtml.includes('.chat-msg::after'), 'ui html: chat messages are not bubble cards and the scrolling conversation owns continuous left/right timeline rails');
  assert(uiHtml.includes('if (conv && api.ensureConversation)') && uiHtml.includes('return loadActiveConversationMessages(id);') && uiHtml.includes('api.getState(requestedTarget)') && uiHtml.includes('requestedWorkspaceKey === currentWorkspaceKey()') && uiHtml.includes('if (s && s.chatMessages) renderChatMessages(s.chatMessages);'), 'ui html: workspace conversation switching reloads a composite-target snapshot without mutating another runtime');
  assert(uiHtml.includes('guideMessagesByTarget') && uiHtml.includes('function recordGuideUiMessage') && uiHtml.includes('function renderPendingGuideMessages') && uiHtml.includes('function syncGuideMessagesFromWorkRuns') && uiHtml.includes('renderPendingGuideMessages(renderTarget, persistedGuideIds)') && uiHtml.includes("guideStatus: clientMessageId ? 'applied' : ''") && uiHtml.includes('renderWorkRunEvents(run, expanded)') && uiHtml.includes("guideStack.innerHTML = expanded ? '' :") && !uiHtml.includes("optimisticGuide.setAttribute('data-guide-status'"), 'ui html: Guide receipts are target-scoped, snapshot redraw reconciles by clientMessageId, and expanded/collapsed Build rendering keeps exactly one Guide row');
  assert(uiHtml.includes("{ id: 'default', summary: t('workspace.defaultConversation')") && !uiHtml.includes("'conv-' + key + '-default'") && !uiHtml.includes("'conv-default-' + currentWorkspaceKey()"), 'ui html: default conversation id matches backend default id');
  assert(uiHtml.includes('function applyBackendConversations(items, activeId, workspaceId)') && uiHtml.includes('var preferredActiveId = hasLocalActive ? localActiveId') && uiHtml.includes('applyBackendConversations(backendConversations, preferredActiveId)'), 'ui html: reloads persisted conversation list into a workspace-scoped cache while preserving each window-local active conversation');
  assert(uiHtml.includes("runWrapper.insertAdjacentElement('afterend', div)") && uiHtml.includes("addMsg('assistant', content, event.mode || state.mode") && uiHtml.includes("{ runId: event.runId || ''"), 'Build transcript: live and restored final replies remain immediately adjacent to their owning runId block');
  assert(uiHtml.includes('function activeConversationId()') && uiHtml.includes('api.sendMessage(requestMessage, lockedTarget)') && uiHtml.includes('composePromptRequestForSend(rawText)'), 'ui html: sends the initiating composite target with structured text and image attachments');
  assert(uiHtml.includes('window.submitCurrentAction = function()') && uiHtml.includes('window.stopCurrentConversation = async function()') && uiHtml.includes('api.stopConversation({ target: target, runId: runId, force: force })') && uiHtml.includes("e.key === 'Escape' && isCurrentConversationRunning() && !promptHasText()"), 'ui html: current running conversation with empty prompt shows target-bound graceful/force Stop bound to Esc');
  assert(uiHtml.includes('function updateSubmitButtonState()') && uiHtml.includes("setSubmitButtonVisual(escalating ? 'octagon-x' : 'square', label, true, true)") && uiHtml.includes("setSubmitButtonVisual('send', t('input.send'), running, false)") && uiHtml.includes("els.prompt.addEventListener('input'") && uiHtml.includes("['stopping', 'force_restarting']"), 'ui html: submit button switches between Send, Stop, and Force stop from the target runtime state');
  assert(uiHtml.includes("window.setAgentBackendMode = async function(mode)") && uiHtml.includes('id="agent-runtime-environment"') && uiHtml.includes("state.wslAvailable ? '' : ' disabled'") && uiHtml.includes("t('settings.restartRequired')") && !uiHtml.includes('window.setAgentWslBackend'), 'ui html: Windows native/WSL backend is a restart-required list choice and WSL mode is disabled when unavailable');
  assert(uiHtml.includes('if (api.setMode) await api.setMode(state.mode)') && uiHtml.includes('if (api.setModel && state.model) await api.setModel(state.model)'), 'ui html: send synchronizes current mode and model before backend turn');
  assert(uiHtml.includes('renderConversations();') && uiHtml.includes('r.conversations') && uiHtml.includes('applyBackendConversations(r.conversations || [], stillActive ? lockedConversationId : activeConversationId(), lockedTarget.workspaceId)'), 'ui html: refreshes the initiating workspace conversation cache without changing the foreground target');
  assert(uiHtml.includes('runningConversations') && uiHtml.includes('setupAgentWorkEvents()') && uiHtml.includes('appendAgentWorkEvent(payload)') && uiHtml.includes('var id = String(event.conversationId ||') && uiHtml.includes('renderAgentWorkEvent(event)') && uiHtml.includes('summary: item.title ||'), 'ui html: supports per-conversation running state, conversation-bound live work events, and backend titles');
  assert(uiHtml.includes("type === 'queue_update'") && uiHtml.includes('backendQueuesByTarget') && uiHtml.includes('setBackendQueueForTarget(event.queue || { steering: [], followUp: [] }, eventQueueTarget)') && uiHtml.includes('window.syncNextQueueFromBackend(state.backendQueue, eventQueueTarget)') && uiHtml.includes('setBackendQueueForTarget(s.queued, snapshotTarget)') && uiHtml.includes('window.syncNextQueueFromBackend(state.backendQueue, snapshotTarget)'), 'ui html: caches backend queue_update events by composite target for foreground/background conversation debugging');
  assert(uiHtml.includes('if (s && Array.isArray(s.workEvents))') && uiHtml.includes('var mergedEvents = existingEvents.concat(s.workEvents || [])') && uiHtml.includes('dedupedEvents.slice(-Number(state.agentWorkEventLimit || 240))'), 'ui html: merges backend work-event snapshots when foregrounding a conversation');
  assert(mainSource.includes('function broadcastAgentWorkEvent(event: unknown)') && mainSource.includes('BrowserWindow.getAllWindows()') && mainSource.includes("win.webContents.send('agent:workEvent', event)") && mainSource.includes("ipcMain.handle('agent:getState', async (event, targetInput?: ConversationTargetInput)") && mainSource.includes('const startupPrewarmRequest = isStartupPrewarmSender(event)') && mainSource.includes("ipcMain.handle('agent:ensureConversation'") && mainSource.includes("ipcMain.handle('agent:activateConversation'") && mainSource.includes('persistActiveConversationSelection(target.conversationId, workspace)') && mainSource.includes('ensureWslConversationPool()!.snapshot(target)') && mainSource.includes('ensureElectronUtilityPool().snapshot(target)') && preloadSource.includes('ensureConversation: (target: string | Record<string, unknown>)') && preloadSource.includes('activateConversation: (target: string | Record<string, unknown>)') && preloadSource.includes('getState: (target?: string | Record<string, unknown>)'), 'backend sharing: all desktop windows receive one composite-target event stream, request read-only isolated snapshots, and explicitly persist foreground conversation activation');
  assert(mainSource.includes('const peek = peekTargetRuntime(normalized)') && mainSource.includes('if (peek.resident) await stopTargetRuntime(normalized)') && mainSource.indexOf('if (peek.resident) await stopTargetRuntime(normalized)') < mainSource.indexOf('const archiveOwner = ownsTargetWorkspace ? agent : isolatedConversationAgent(normalized)'), 'archive IPC: observes cold targets without allocation and stops resident writers before deleting persisted state');
  assert(mainSource.includes('const archiveOwner = ownsTargetWorkspace ? agent : isolatedConversationAgent(normalized)') && mainSource.includes('archiveOwner.archiveConversation(normalized.conversationId)'), 'archive IPC: current workspace uses the host persistence owner so delayed cache flushes cannot resurrect deleted conversations');
  assert(mainSource.includes('const singleInstanceLock = allowMultipleInstances || app.requestSingleInstanceLock()') && mainSource.includes("app.on('second-instance'") && mainSource.includes('const win = mainWindow && !mainWindow.isDestroyed()') && !mainSource.includes('const win = createDesktopWindow ? createDesktopWindow(!!agent) : mainWindow'), 'main process: production launches focus the existing window while explicitly isolated test instances skip lock coordination');
  assert(uiHtml.includes('function loadActiveConversationMessages(conversationId)') && uiHtml.includes('var requestedConversationId = String(conversationId || activeConversationId() ||') && uiHtml.includes('var requestedTarget = currentConversationTarget(requestedConversationId)') && uiHtml.includes('api.getState(lockedTarget)') && !uiHtml.includes('api.getState().then(function(s) {\n      if (s && s.contextCompression'), 'ui html: active window refreshes are bound to the owning workspace and conversation target');
  assert(uiHtml.includes('function setActiveWorkspaceConversationById(id)') && uiHtml.includes('var activeBeforeRender = (conversations.find(function(c)') && uiHtml.includes('if (activeBeforeRender) setActiveWorkspaceConversationById(activeBeforeRender);'), 'ui html: conversation list rerender preserves active conversation by id instead of stale cross-window index');
  assert(uiHtml.includes('function applyWorkspaceStateFromBackend(s)') && uiHtml.includes('var localActiveId = activeConversationId();') && uiHtml.includes('var hasLocalActive = backendConversations.some(function(item)') && uiHtml.includes('window.openWorkspaceManager = async function()') && uiHtml.includes('await window.refreshWorkspaceState().catch(function(){})'), 'ui html: workspace manager refresh keeps each window-local active conversation before rendering');
  assert(uiHtml.includes('window.selectWorkspace = function(reference)') && uiHtml.includes('renderChatMessages([]);') && uiHtml.includes('state.backendQueue = backendQueueForTarget(currentConversationTarget());') && uiHtml.includes('state.backendQueue = backendQueueForTarget(currentConversationTarget(activeId));') && uiHtml.includes('syncBackendConversation().then(function()'), 'ui html: workspace switching clears stale conversation UI, restores only the composite-target queue cache, and reloads the workspace-bound backend conversation');
  assert(uiHtml.includes('function canonicalUiWorkspaceKey(ws)') && uiHtml.includes('window.upsertWorkspaceState = function(ws)') && !uiHtml.includes('state.workspaces.push(ws);'), 'ui html: workspace creation upserts exact folder bindings instead of showing temporary duplicates');
  assert(uiHtml.includes('id="skill-market-search"') && uiHtml.includes('window.updateSkillMarketSearch') && uiHtml.includes('window.filteredSkillMarket') && uiHtml.includes('window.renderSkillsMarketList'), 'ui html: Skills Market has searchable filtered list');
  assert(uiHtml.includes('window.renderSkillMarketSources') && uiHtml.includes('id="skill-market-source-name"') && uiHtml.includes('window.addSkillMarketSourceFromUi') && uiHtml.includes('window.setSkillMarketSourceEnabledFromUi'), 'ui html: Skills Market lets users add and manage market sources');
  assert(uiHtml.includes("item.description || item.desc || ''") && uiHtml.includes("item.marketSourceName || ''") && uiHtml.includes("item.path || ''") && uiHtml.includes("item.url || ''") && uiHtml.includes('No matching skills.'), 'ui html: Skills Market search covers skill metadata, source metadata, and empty results');
  assert(uiHtml.includes('--right-width: 380px;') && uiHtml.includes('var rightSize = Math.max(340, Math.min(680, newSize2));'), 'ui html: right sidebar has larger default and resize range');
  assert(uiHtml.includes('lucide-sprite.svg#square-pen') && uiHtml.includes("iconOnly('square-pen', t('right.editor'))") && !uiHtml.includes('lucide-sprite.svg#edit'), 'ui html: Editor tab uses available open-source icon sprite symbol');
  assert(uiHtml.includes("if (depth === 0) parent.innerHTML = '<div style=\"font-size:11px;color:var(--text-dim);padding:8px;\">' + esc(t('fileTree.empty'))"), 'ui html: file tree shows the empty label only for an empty root, not expanded empty directories');
  assert(mainSource.includes('async function listTreeLevel(current: string)') && mainSource.includes('await fs.promises.readdir(current, { withFileTypes: true })') && !mainSource.includes('children: walkTree(root, fullPath)') && mainSource.includes('fs.promises.realpath(workspaceRoot)') && mainSource.includes('fs.promises.realpath(treeRoot)') && mainSource.includes("return { error: 'File tree path is outside the active workspace' }"), 'file tree: backend returns one async directory level and confines lexical and linked paths to the active workspace');
  assert(uiHtml.includes("var result = await api.getFileTree(node.path)") && uiHtml.includes("children.getAttribute('data-loaded') === 'true'") && uiHtml.includes("childContainer.style.display = 'none'") && !uiHtml.includes('id="ft-toggle-\' + depth + \'-\' + i'), 'file tree: renderer loads children only on first expansion and uses branch-local DOM references');
  const postStartupUiSource = uiHtml.match(/function schedulePostStartupUiRendering\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert(uiHtml.includes("if (opening && state.rightTab === 'file-tree') window.loadFileTree();")
    && uiHtml.includes("if (tab === 'file-tree') window.loadFileTree();")
    && !postStartupUiSource.includes('loadFileTree')
    && !uiHtml.includes('// Load file tree (async, non-blocking)'), 'file tree: startup and language refresh avoid hidden duplicate workspace scans');
  assert(uiHtml.includes('function renderMessageContent(text)') && uiHtml.includes('function renderMarkdownBlocks(text)') && uiHtml.includes('function renderMarkdownInline(text)') && uiHtml.includes('class="msg-image"') && uiHtml.includes('normalizeImageSrc(imageUrl)') && uiHtml.includes("if (/^data:image\\//i.test(url)) return true;"), 'ui html: conversation renders returned markdown images, including data URLs');
  assert(uiHtml.includes('class="md-table"') && uiHtml.includes('function renderMarkdownTable(lines, start)') && uiHtml.includes('class="md-math-inline"') && uiHtml.includes('class="md-math-block"') && uiHtml.includes('function renderMathFormula(tex)') && uiHtml.includes('class="math-frac"') && uiHtml.includes('"Cambria Math"') && uiHtml.includes('white-space: normal;'), 'ui html: conversation message markdown supports tables and rendered TeX-style formula blocks without pre-wrap text fallback');
  assert(uiHtml.includes('function normalizeCodeLanguage(language)') && uiHtml.includes('function highlightCodeByLanguage(code, language)') && uiHtml.includes('class="md-code-block language-'), 'ui html: fenced Markdown code blocks reuse the themed editor tokenizer according to their language tag');
  assert(uiHtml.includes('--modal-surface: rgba(248,250,255,0.76);') && uiHtml.includes('--modal-shadow:') && uiHtml.includes('brightness(1.12)'), 'ui light theme: translucent sub-windows add dedicated foreground glow and brightness above the dimmed backdrop');
  assert(uiHtml.includes('[data-theme="light"] #submit-btn.running-action') && uiHtml.includes('background: rgba(255,255,255,0.72)') && uiHtml.includes('var(--marquee-width)') && uiHtml.includes('var(--g1), var(--g2), var(--g3), var(--g4), var(--g1)'), 'ui light theme: submit/stop surface is light while the shared configurable marquee colors and width remain authoritative');
  assert(uiHtml.includes('[data-theme="light"] .linked-plan-reader') && uiHtml.includes('[data-theme="light"] .right-empty') && uiHtml.includes('box-shadow: none;'), 'ui light theme: ordinary plan and empty-state panels avoid heavy dark shadows');
  assert(uiHtml.includes('[data-theme="light"] #right.open') && /\[data-theme="light"\] #right\.open\s*\{\s*box-shadow:\s*none;\s*\}/.test(uiHtml), 'ui light theme: right sidebar removes the dark left-edge shadow');
  assert(uiHtml.includes('[data-theme="light"] .stack-card') && uiHtml.includes('[data-theme="light"] #queue-panel') && uiHtml.includes('[data-theme="light"] .queue-item:hover') && uiHtml.includes('[data-theme="light"] .queue-edit'), 'ui light theme: queue stack, rows, controls, and editable text use readable light surfaces');
  assert(uiHtml.includes('[data-theme="light"] #goal-bar') && uiHtml.includes('rgba(255,255,255,0.82) 36%') && uiHtml.includes('[data-theme="light"] #goal-bar.goal-paused'), 'ui light theme: Goal emphasis fades into a white glass mask instead of the dark stack surface');
  assert(uiHtml.includes('[data-theme="light"] .memory-lab-overview-node') && uiHtml.includes('[data-theme="light"] .memory-lab-overview-title') && uiHtml.includes('[data-theme="light"] .memory-lab-node.selected') && uiHtml.includes('[data-theme="light"] .memory-lab-overview-grid'), 'ui light theme: Memory Lab controls, nodes, status pills, and graph grid use harmonious light surfaces');
  assert(uiHtml.includes("activity.key === 'memory_lab'") && uiHtml.includes('更新了记忆') && uiHtml.includes('Updated memory'), 'ui work run: Memory Lab rebuild receipt is rendered only as an in-block tool activity completion');
  assert(uiHtml.includes('state.subWindowStack.push') && uiHtml.includes('state.subWindowStack && state.subWindowStack.pop') && uiHtml.includes("header.addEventListener('pointerdown'") && uiHtml.includes('Math.min(window.innerWidth - rect.width - padding') && uiHtml.includes('Math.min(window.innerHeight - rect.height - padding'), 'ui sub-windows: nested views restore their parent and pointer dragging is clamped to the visible viewport');
  assert(uiHtml.includes("state.activeSubWindowView.name === 'plugins'") && uiHtml.includes('if (refreshingPlugins) state.restoringSubWindow = true;'), 'ui Skills Market: sibling plugin tabs refresh in place instead of polluting the parent navigation stack');
  assert(uiHtml.includes('window.showFlowEditor = function(expandedIndex)') && uiHtml.includes("renderFlowItem(state.flowWorks[i], i, Number(expandedIndex) === i)") && uiHtml.includes("state.activeSubWindowView = { name: 'flowNew' }") && uiHtml.includes('window.showFlowEditor(workIdx)'), 'ui Flow editor: same-level rerenders do not stack windows and newly added controls remain expanded');
  assert(uiHtml.includes('class="msg-file-link"') && uiHtml.includes('onclick="window.openLinkedFile(')
    && uiHtml.includes('window.openLinkedFile = async function(path)') && uiHtml.includes('var result = await api.openWorkspaceFile(path);')
    && !/window\.openLinkedFile = async function\(path\)[\s\S]{0,500}?api\.readFile\(/.test(uiHtml),
  'ui html: conversation and Markdown local-file links use the safe workspace file router');
  assert(!uiHtml.includes('data-tab="md-viewer"') && uiHtml.includes('id="editor-md-toggle"') && uiHtml.includes('window.toggleEditorMarkdownPreview') && uiHtml.includes("window.editorLanguageForPath(state.editorPath) === 'markdown'") && uiHtml.includes('.editor-toolbar .editor-view-btn { display:none; }'), 'ui html: Markdown preview is integrated as an editor-only toggle shown only for Markdown files with sufficient CSS specificity');
  assert(uiHtml.includes('window.highlightEditorCode') && uiHtml.includes('window.handleEditorVimKey') && uiHtml.includes('window.requestEditorCompletion') && uiHtml.includes('window.requestEditorAssist') && uiHtml.includes('editor-completion'), 'ui html: native code editor provides file-aware highlighting, Vim keyboard state, model completion, and Agent assist internals');
  assert(uiHtml.includes('wrap="soft"') && uiHtml.includes('window.editorVisualRowsForLine') && uiHtml.includes('window.renderEditorGutter') && uiHtml.includes('white-space:pre-wrap') && uiHtml.includes('overflow-wrap:anywhere'), 'ui editor wrapping: long logical lines soft-wrap while the gutter keeps one number spanning all visual rows');
  assert(uiHtml.includes('editorPredictionEnabled: true') && uiHtml.includes('window.toggleEditorPrediction') && uiHtml.includes('window.scheduleEditorCompletion') && uiHtml.includes('}, 180);') && uiHtml.includes('beforeStart = Math.max(0, pos - 6000)') && uiHtml.includes('class="editor-ghost"') && uiHtml.includes('window.highlightEditorCode(combined, language)') && uiHtml.includes('editor-ghost-text') && uiHtml.includes("state.editorCompletionText && e.key === 'Tab'"), 'ui html: Copilot prediction defaults on, retriggers after a short idle window, sends bounded cursor-local context, reflows pale insertion text, and accepts with Tab');
  assert(uiHtml.includes('editorCompletionAnchor: null') && uiHtml.includes('window.editorAnchorMatches = function(anchor)') && uiHtml.includes('window.handleEditorCaretChange = function()') && uiHtml.includes("addEventListener('select', window.handleEditorCaretChange)"), 'ui editor prediction: binds candidates to path, content, and caret selection, then invalidates and restarts after caret movement');
  assert(uiHtml.includes('.editor-ghost { display:none;') && uiHtml.includes('.editor-ghost.visible { display:block; }') && uiHtml.includes("ghost.classList.remove('visible')") && uiHtml.includes("ghost.classList.add('visible')"), 'ui editor highlighting: opaque completion overlay is visible only while an anchored prediction exists');
  assert(uiHtml.includes('width: 30px;') && uiHtml.includes('aria-label="Copilot prediction"') && uiHtml.includes('aria-pressed="true"') && !uiHtml.includes('title="Vim mode">Vim</button>') && !uiHtml.includes('title="Agent assist">Agent</button>') && !uiHtml.includes('<span>Preview</span>'), 'ui editor toolbar: uses fixed icon-only controls with tooltips and explicit Copilot state without Vim or Agent buttons');
  assert(uiHtml.includes("var key = [file.name || '', file.type || '', file.size || 0, file.lastModified || 0].join('|')") && uiHtml.includes('item.dataUrl === dataUrl'), 'ui prompt paste: deduplicates clipboard images across DataTransfer items/files and decoded content');
  const agentSourceForEditor = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agent.ts'), 'utf-8');
  assert(mainSource.includes("completion: true, preferCopilot: true") && mainSource.includes('editorCompletionControllers.get(ownerId)?.abort') && agentSourceForEditor.includes("model.provider_protocol === 'github_models'") && agentSourceForEditor.includes('input.completion ? 192 : 1800'), 'editor prediction: prefers configured Copilot, cancels superseded requests, and uses a bounded low-latency completion budget');
  assert(uiHtml.includes("if (providerOpts) modelOpts += '<optgroup") && uiHtml.includes("if (!state.model || (state.model === 'auto'") && uiHtml.includes("availableValues.indexOf(state.model) < 0"), 'ui model selector: skips empty provider groups and recovers an empty or unavailable saved model to the first usable model');
  assert(uiHtml.includes('function messageActionsHtml(role, text, messageIndex)') && uiHtml.includes('window.copyMessageText = async function(button)') && uiHtml.includes('window.editUserMessage = async function(button, messageIndex)') && uiHtml.includes('api.rewindConversation(target, Number(messageIndex))') && uiHtml.includes('message._newmarkMessageTarget') && uiHtml.includes('pendingConversationRewinds[rewindKey]') && !uiHtml.includes("addMsg('assistant', '[Error] ' + ((result && result.error) || 'Unable to edit message.')"), 'ui html: user messages retain their rendered composite target, suppress duplicate rewinds, and report failures outside the chat timeline');
  assert(preloadSource.includes("rewindConversation: (target: string | Record<string, unknown>, messageIndex: number) => ipcRenderer.invoke('agent:rewindConversation'") && mainSource.includes("ipcMain.handle('agent:rewindConversation'") && mainSource.includes('mutateTargetConversation(target') && mainSource.includes('ensureWslConversationPool()!.rewind(target, messageIndex)') && mainSource.includes('ensureElectronUtilityPool().rewind(target, messageIndex)'), 'main/preload: conversation rewind is target-bound, mutation-guarded, and executes inside the selected WSL or Utility runtime');
  assert(uiHtml.includes('function optionLabel(option)') && uiHtml.includes('function renderPendingOptionsInChat(options)') && uiHtml.includes("state.renderedOptionKeys[key] = true"), 'ui html: pending option feedback renders into chat once');
  assert(uiHtml.includes('if (r && r.options)') && uiHtml.includes('renderPendingOptionsInChat(state.pendingOptions)') && uiHtml.includes("optionDescription(opt)"), 'ui html: send result and right status render structured option labels');
  assert(uiHtml.includes('pendingOptionAnswers: {}') && uiHtml.includes('window.optionSelected = function(questionKey, opt, button)') && uiHtml.includes("answered.some(function(item) { return item.answer === undefined; })") && uiHtml.includes("window.sendMessage();"), 'ui option feedback: records each question selection and resumes only after every simultaneous question is answered');
  assert(uiHtml.includes("'settings.runInWsl': 'Agent runtime environment'") && uiHtml.includes("'settings.runInWsl': 'Agent 运行环境'") && uiHtml.includes('id="agent-runtime-environment"') && uiHtml.includes('<option value="windows"') && uiHtml.includes('<option value="wsl"'), 'settings: Agent runtime environment uses a Windows native/WSL select list with localized title');
  assert(uiHtml.includes('#input-tools {') && uiHtml.includes('overflow: visible;'), 'input toolbar: permits submit hover and running marquee pixels outside the fixed button box without clipping');
  assert(uiHtml.includes('window.runFlowWork = async function(workIdx)') && uiHtml.includes('await api.saveFlow(normalized)') && uiHtml.includes('api.runFlow(normalized.name, flowInput, 0)') && uiHtml.includes('renderChatMessages(r.chatMessages)'), 'ui html: Flow Run uses the constrained Flow API and backend core runner');
  assert(uiHtml.includes('function stopFlowRunInternal()') && uiHtml.includes('window.stopFlowRun = function()') && uiHtml.includes('stopFlowRunInternal();') && !uiHtml.includes('window.stopFlowRun = function() {\n  stopFlowRun();'), 'ui html: Flow stop handler avoids global recursive self-call');
  assert(uiHtml.includes("conversationRunning && effectiveInputMode === 'guide'") && uiHtml.includes("effectiveInputMode === 'next' && !opts.fromQueue && conversationRunning") && uiHtml.includes("idleNextImmediate = effectiveInputMode === 'next' && !opts.fromQueue && !conversationRunning") && uiHtml.includes('state.nextQueue.push(displayText)') && uiHtml.includes('bindQueuedRequestToTarget(requestMessage, rawText, lockedTarget)') && uiHtml.includes('queuedRequestMatchesTarget') && uiHtml.includes('queueMicrotask(function()') && !uiHtml.includes('}, 250);') && !uiHtml.includes('}, 80);') && uiHtml.includes('state.queueCollapsed = false'), 'ui html: idle Next starts immediately while active-run Next stays target-bound and terminal events drain without fixed timer latency');
  assert(uiHtml.includes('id="terminal-timeout-input"') && uiHtml.includes('Max ms') && uiHtml.includes('Terminal timeout cap') && uiHtml.includes('window.setTerminalInterruptTimeout = function(value)') && uiHtml.includes("api.saveSetting('terminal', 'interrupt_timeout_ms', n)"), 'ui html: terminal timeout cap is editable and persisted');
  const agentKernelSource = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agent.ts'), 'utf-8');
  const piKernelSource = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agentKernelRunner.ts'), 'utf-8');
  const conversationKernelSource = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'conversationKernel.ts'), 'utf-8');
  assert(conversationKernelSource.includes('function changedLineCount(value: string)') && conversationKernelSource.includes('old: changedLineCount(d.oldContent)') && conversationKernelSource.includes('new: changedLineCount(d.newContent)') && conversationKernelSource.includes('oldContent: d.oldContent') && conversationKernelSource.includes('newContent: d.newContent'), 'work completion review: backend reports changed-line counts and bounded review content');
  assert(conversationKernelSource.includes('pendingOptions(target: ConversationTargetInput)') && mainSource.includes('conversationSnapshot.pendingOptions || agent.pendingOptions'), 'conversation options: state refresh reads pending questions from the requested composite runtime snapshot');
  assert(conversationKernelSource.includes('updateSetting(section: string, key: string, value: unknown)') && mainSource.includes('conversationKernel?.updateSetting(section, key, value)'), 'conversation settings: saved settings propagate to existing isolated runners without destroying their runtime state');
  const mainKernelSource = fs.readFileSync(path.join(process.cwd(), 'src', 'main.ts'), 'utf-8');
  const packageJsonForKernel = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
  assert(!packageJsonForKernel.dependencies?.['@earendil-works/pi-agent-core'] && !packageJsonForKernel.dependencies?.['@earendil-works/pi-ai'], 'kernel: no external pi runtime dependencies remain');
  assert(piKernelSource.includes("import('./agentKernel/index.js')") && piKernelSource.includes("import('./agentKernel/stream-types.js')"), 'kernel: adapter imports Newmark native agent kernel modules');
  assert(fs.existsSync(path.join(process.cwd(), 'src', 'core', 'agentKernel', 'agent.ts')) && fs.existsSync(path.join(process.cwd(), 'src', 'core', 'agentKernel', 'agent-loop.ts')) && fs.existsSync(path.join(process.cwd(), 'src', 'core', 'agentKernel', 'types.ts')) && !fs.existsSync(path.join(process.cwd(), 'src', 'vendor')), 'kernel: agent loop source is native core code and src/vendor is absent');
  assert(agentKernelSource.includes("import { runAgentKernel } from './agentKernelRunner'") && agentKernelSource.includes('await runAgentKernel(this)') && !agentKernelSource.includes('processLegacyForMigrationOnly'), 'kernel: Agent.process routes builtin turns through pi and has no legacy loop sentinel');
  assert(conversationKernelSource.includes('runner.queueActiveKernelMessage(prompt, queueMode)') && conversationKernelSource.includes('runner.subscribeAgentKernelUserMessageStart') && !conversationKernelSource.includes("runtime.runner.history.push({ role: 'user', content: prompt })"), 'kernel: same-session queue is handed to native kernel and consumed on user message start without duplicating history');
  assert(agentKernelSource.includes('queue: isToolEvent ? undefined : input.queue') && agentKernelSource.includes('notifyAgentKernelUserMessageStart') && piKernelSource.includes("case 'message_start'") && piKernelSource.includes('agent.notifyAgentKernelUserMessageStart'), 'kernel: backend queue snapshots survive public non-tool work events and native message_start notifies conversation runtime');
  assert(mainKernelSource.includes("ipcMain.handle('agent:send'") && mainKernelSource.includes('ensureElectronUtilityPool().prompt({ message, target, options, queueMode })') && mainKernelSource.includes('ensureWslConversationPool()') && mainKernelSource.includes('conversationRuntimeTarget(targetInput)'), 'kernel: desktop send path routes every composite target through its isolated native runtime pool');
  assert(!mainKernelSource.includes('agent.setConversation(targetConversation)') && mainKernelSource.includes('The isolated runtime owns conversation persistence for this prompt.'), 'kernel: desktop send does not overwrite completed runtime state with the host stale snapshot');
  assert(mainKernelSource.includes('agent?.setConversationFromStorage(id)') && mainKernelSource.includes('agent?.selectWorkspaceFromStorage(value)'), 'kernel: renderer conversation and workspace switches refresh runtime-owned state without saving a stale host snapshot');
  assert(mainKernelSource.includes('electronUtilityRuntimePool.subscribe(event => broadcastAgentWorkEvent(event))') && mainKernelSource.includes('wslAgentRuntimePool.subscribe(event => broadcastAgentWorkEvent(event))') && mainKernelSource.includes('ensureElectronUtilityPool().snapshot(target)') && conversationKernelSource.includes('runtimeKey'), 'kernel: desktop IPC subscribes isolated runtime pools and exposes target-scoped event snapshots');
  assert(!piKernelSource.includes("tokens.push({ type: 'text', text });\n      agent.recordToolResult") && piKernelSource.includes("type: 'tool_result'") && piKernelSource.includes('toolCallId: event.toolCallId') && piKernelSource.includes("content: `Tool ${event.toolName} ${outcome}.`"), 'kernel: tool results stay available to the model while public work events contain only outcome metadata');
  assert(agentKernelSource.includes('appendWorkflowMessage(content: string, toolName?: string, toolArgs?: string, persist = true)') && !piKernelSource.includes('agent.appendWorkflowMessage(`Calling tool') && !piKernelSource.includes('agent.appendWorkflowMessage(`Tool ${event.toolName}') && piKernelSource.includes('toolArgs: JSON.stringify(event.args || {})'), 'kernel: tool activity belongs only to the Build run, with sanitized expandable arguments instead of duplicate workflow chat rows');
  assert(piKernelSource.includes('new ToolProvisionSession([], [])')
    && piKernelSource.includes('const catalog = agent.subagentToolDefinitions(agent.tools.definitions(agent.mode))')
    && piKernelSource.includes('toolProvisioning.reconcile(catalog, surface.definitions)')
    && piKernelSource.includes('resolveTools: () =>')
    && piKernelSource.includes('refreshToolSurface().definitions')
    && piKernelSource.includes('toProviderToolDefinitions(context.tools || [])')
    && !piKernelSource.includes('cachedTools'),
  'kernel: each run builds one policy-filtered catalog and refreshes only provisioned schemas between model subturns');
  const streamProviderBody = (piKernelSource.match(/function streamWithNewmarkProvider[\s\S]*?async function transformContext/) || [''])[0];
  assert(!streamProviderBody.includes('currentAgent.tools.definitions(currentAgent.mode)'), 'kernel: streaming provider does not rebuild tool schemas on every model round');
  assert(piKernelSource.includes("if (!agent.config.getBool('context', 'auto_compress')) return messages;"), 'kernel: transformContext skips conversion and JSON comparison when auto compression is disabled');
  assert(piKernelSource.includes("toolExecution: 'parallel'") && piKernelSource.includes('continuationToolLaunchReceipt') && agentKernelSource.includes('Multiple tool calls emitted in one provider turn run concurrently'), 'kernel: enables concurrent tool batches and documents continuation-tool launch receipts');
  assert(mainKernelSource.includes("ipcMain.handle('agent:abortConversation'") && mainKernelSource.includes("ipcMain.handle('agent:stopConversation'") && uiHtml.includes('api.archive(targetRuntime)') && uiHtml.includes("['running', 'stopping', 'force_restarting']"), 'kernel/ui: target stop state is authoritative and running conversations cannot be archived from the UI');
  assert(uiHtml.includes('var seenIds = {};') && uiHtml.includes('if (seenIds[id]) continue;') && uiHtml.includes("displaySummary += ' · ' + String(conv.id || '').slice(-8);"), 'ui conversations: duplicate ids are ignored and distinct conversations with matching titles are disambiguated');
  assert(uiHtml.includes('#model-select {') && uiHtml.includes('flex: 1 1 160px;') && uiHtml.includes('width: 0;') && uiHtml.includes('min-width: 72px;') && uiHtml.includes('container-type: inline-size;') && uiHtml.includes('@container (max-width: 430px)') && uiHtml.includes('@media (max-width: 720px)') && uiHtml.includes('#left, #left-secondary, #right, .right-open-btn { display: none !important; }') && uiHtml.includes('#input-tools {') && uiHtml.includes('overflow: hidden;'), 'ui input toolbar: model selector keeps readable minimum width and narrow-window layout preserves submit without changing saved sidebar state');
  assert(uiHtml.includes("validationStatus !== 'verified' && validationStatus !== 'degraded'") && agentKernelSource.includes("validationStatus === 'verified' || validationStatus === 'degraded'"), 'model selectors: keep fixed unvalidated models visible while accepting Standard verified or degraded evidence');
  const modelValidationSource = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'modelValidation.ts'), 'utf-8');
  assert(agentKernelSource.includes('const service = new ModelValidationService({ cache })') && agentKernelSource.includes('await p.modelCatalog()') && agentKernelSource.includes('createProviderValidationAdapter(p, m.name)') && agentKernelSource.includes('visionChallenge: declaredVision') && modelValidationSource.includes("'strict_json'") && modelValidationSource.includes("'unknown_tool_exclusion'") && modelValidationSource.includes("'tool_result'") && modelValidationSource.includes('validateImageOutput('), 'model validation: uses the shared Standard/Extended service for catalog hypotheses and real text, stream, JSON, tool, vision, and image-byte probes');
  assert(uiHtml.includes('foregroundConversationHoldId') && uiHtml.includes('holdForegroundConversation(activeId, 4500)') && uiHtml.includes('Date.now() < Number(state.foregroundConversationHoldUntil'), 'ui html: foregrounded background conversations stay active briefly during backend refresh');
  assert(uiHtml.includes('existingConversations.find(function(item)') && uiHtml.includes('holdForegroundConversation(id, 30000)') && uiHtml.includes('state.activeBackendConversationId = id;'), 'ui html: a newly created foreground conversation survives stale backend list responses and owns immediate sends before activation settles');
  assert(uiHtml.includes("messageMeta && messageMeta.recovered") && uiHtml.includes("timestamp: run.startedAt || ''") && uiHtml.includes("timestamp: m.timestamp || ''"), 'ui html: restored and recovered conversation rows retain their original timestamps and identify synthetic historical boundaries');
  assert(uiHtml.includes('function renderOrphanRunsBefore(runId)') && uiHtml.includes('if (associatedRun) renderOrphanRunsBefore(messageRunId);'), 'ui html: orphaned historical Builds are inserted before the next owned message instead of displacing the latest completed reply at the bottom');
  assert(uiHtml.includes('trackedConversationUntil') && uiHtml.includes('conversationTrackMs: 300000') && uiHtml.includes('markConversationTracked(previousId') && uiHtml.includes('markConversationTracked(activeId'), 'ui html: conversations keep a five-minute tracking window after foreground switches without aborting background work');
  assert(conversationKernelSource.includes("getNum('agent', 'process_timeout_ms')") && conversationKernelSource.includes('if (timeoutMs <= 0)') && conversationKernelSource.includes('const tokens = await runtime.runner.process(message)') && conversationKernelSource.includes('if (timeout) clearTimeout(timeout)'), 'kernel: desktop conversation turns have configurable outer timeout disabled by default');
  assert(conversationKernelSource.includes("options.mode === 'goal' && this.host.goal") && conversationKernelSource.includes('agent.updateGoal(this.host.goal.objective)'), 'kernel: per-conversation Goal runners inherit the active Goal objective');
  assert(mainKernelSource.includes('if (conversationKernel?.isAnyRunning()) return;'), 'kernel: desktop settings changes do not discard running conversation kernels');
  assert(mainKernelSource.includes('...conversationSnapshot') && mainKernelSource.includes('ensureElectronUtilityPool().snapshot(target)') && mainKernelSource.includes('ensureWslConversationPool()!.snapshot(target)'), 'kernel: desktop IPC exposes queue state from the requested isolated runtime snapshot');
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
  const queueProbes = new Map<string, QueueProbeAgent>();
  const kernel = new ConversationKernel(TEST_DIR, kernelHost, null, {
    createRunner(target) {
      const probe = queueProbes.get(target.conversationId);
      if (!probe) throw new Error(`Missing queue probe for ${target.conversationId}`);
      return probe;
    },
  });
  const target = (conversationId: string, workspaceId = 'verify-workspace') => ({ workspaceId, conversationId });
  const probe = new QueueProbeAgent(TEST_DIR, { agentOnly: true });
  queueProbes.set('parallel-a', probe);
  const firstPrompt = kernel.prompt('first', target('parallel-a'), { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'guide', engine: 'builtin' }, 'steer');
  await new Promise(resolve => setTimeout(resolve, 1));
  const samePromise = kernel.prompt('second', target('parallel-a'), { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'guide', engine: 'builtin' }, 'steer');
  await Promise.all([firstPrompt, samePromise]);
  assert(probe.processCalls.length === 1 && probe.processCalls[0] === 'first', 'kernel: same-conversation active prompt keeps one active process');
  assert(probe.queued.length === 1 && probe.queued[0].content.includes('second') && probe.queued[0].queueMode === 'steer', 'kernel: same-conversation active prompt queues to active Agent kernel');
  assert(kernel.queued(target('parallel-a')).steering.length === 0 && kernel.queued(target('parallel-a')).followUp.length === 0, 'kernel: queued snapshot clears after active steering message is consumed');
  const eventProbe = new QueueProbeAgent(TEST_DIR, { agentOnly: true });
  queueProbes.set('parallel-events', eventProbe);
  const queueEvents: any[] = [];
  kernel.subscribe(event => {
    if (event.conversationId === 'parallel-events' && event.type === 'queue_update') queueEvents.push(event);
  });
  const eventRun = kernel.prompt('event-first', target('parallel-events'), { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'guide', engine: 'builtin' }, 'steer');
  await new Promise(resolve => setTimeout(resolve, 1));
  const eventQueuedRun = kernel.prompt('event-second', target('parallel-events'), { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'guide', engine: 'builtin' }, 'steer');
  eventProbe.notifyAgentKernelUserMessageStart('event-second');
  await Promise.all([eventRun, eventQueuedRun]);
  assert(eventProbe.queued.some(item => item.content === 'event-second' && item.queueMode === 'steer') && queueEvents.every(event => !(event.queue?.steering || []).length), 'kernel: Guide steering is delivered to active kernel without entering the visible queue');
  const fallbackProbe = new QueueProbeAgent(TEST_DIR, { agentOnly: true });
  fallbackProbe.queueActiveKernelMessage = () => false;
  queueProbes.set('parallel-fallback', fallbackProbe);
  const fallbackPrompt = kernel.prompt('fallback-first', target('parallel-fallback'), { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'next', engine: 'builtin' }, 'followUp');
  await new Promise(resolve => setTimeout(resolve, 1));
  const fallbackSame = kernel.prompt('fallback-second', target('parallel-fallback'), { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'next', engine: 'builtin' }, 'followUp');
  const duringFallbackQueue = kernel.queued(target('parallel-fallback'));
  assert(duringFallbackQueue.followUp.some(item => item.includes('fallback-second')), 'kernel: queued snapshot records pending next-turn follow-up messages');
  await Promise.all([fallbackPrompt, fallbackSame]);
  assert(kernel.queued(target('parallel-fallback')).followUp.length === 0 && fallbackProbe.processCalls.length === 2, 'kernel: queued snapshot clears after fallback next-turn follow-up drains');
  const parallelProbeA = new QueueProbeAgent(TEST_DIR, { agentOnly: true });
  const parallelProbeB = new QueueProbeAgent(TEST_DIR, { agentOnly: true });
  queueProbes.set('parallel-b', parallelProbeA);
  queueProbes.set('parallel-c', parallelProbeB);
  const t0 = Date.now();
  await Promise.all([
    kernel.prompt('one', target('parallel-b'), { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'next', engine: 'builtin' }, 'followUp'),
    kernel.prompt('two', target('parallel-c'), { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'next', engine: 'builtin' }, 'followUp'),
  ]);
  assert(Date.now() - t0 < 250 && parallelProbeA.processCalls[0] === 'one' && parallelProbeB.processCalls[0] === 'two', 'kernel: different conversations run through independent parallel runtimes');
  assert(uiHtml.includes('window.setLeftCollapsed = function(collapsed)'), 'ui html: left collapse uses unified state function');
  assert(uiHtml.includes('conversationLoadGeneration: 0') && uiHtml.includes('var loadGeneration = ++state.conversationLoadGeneration') && uiHtml.includes('loadGeneration === state.conversationLoadGeneration') && uiHtml.includes('requestedWorkspaceKey === currentWorkspaceKey()') && uiHtml.includes("requestedConversationId === String(activeConversationId() || 'default')"), 'ui html: stale conversation loads cannot overwrite a newer same-workspace conversation selection');
  assert(uiHtml.includes('function requestIsCurrent()') && uiHtml.includes('if (!requestIsCurrent() || String(id) !== requestedConversationId) return;'), 'ui html: delayed ensureConversation chains cannot start a stale conversation load after switching');
  assert(uiHtml.includes('var activation = api.activateConversation ? api.activateConversation(target)') && uiHtml.includes('return activation.then(function(s)') && uiHtml.includes('state.activeBackendConversationId = String((s && s.conversationId) || id)'), 'ui html: creating a conversation awaits durable foreground activation before rendering the new chat');
  assert(uiHtml.includes('applyBackendConversations(r.conversations || [], stillActive ? lockedConversationId : activeConversationId(), lockedTarget.workspaceId)') && uiHtml.includes('applyBackendConversations(s.conversations || [], stillActiveAfterRefresh ? lockedConversationId : activeConversationId(), lockedTarget.workspaceId)') && uiHtml.includes('var stillActiveAfterRefresh = isActiveConversationTarget(lockedTarget)') && uiHtml.includes('if (stillActiveAfterRefresh && s && s.contextCompression !== undefined)'), 'ui html: background target completions update only their workspace cache and preserve foreground scoped details');
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
  const leftSecondaryBaseCss = uiHtml.match(/#left-secondary\s*\{([\s\S]*?)\}/)?.[1] || '';
  const leftSecondaryOpenCss = uiHtml.match(/#left-secondary\.open\s*\{([\s\S]*?)\}/)?.[1] || '';
  assert(
    leftSecondaryBaseCss.includes('width: 0;')
      && leftSecondaryBaseCss.includes('opacity: 0;')
      && leftSecondaryBaseCss.includes('transform: translateX(-8px);')
      && leftSecondaryBaseCss.includes('transition: width ')
      && leftSecondaryBaseCss.includes('opacity var(--duration-normal)')
      && leftSecondaryBaseCss.includes('transform var(--duration-normal)')
      && leftSecondaryOpenCss.includes('width: var(--left-secondary-width);')
      && leftSecondaryOpenCss.includes('opacity: 1;')
      && leftSecondaryOpenCss.includes('transform: translateX(0);')
      && leftSecondaryOpenCss.includes('transition: width ')
      && leftSecondaryOpenCss.includes('opacity var(--duration-normal)')
      && leftSecondaryOpenCss.includes('transform var(--duration-normal)')
      && !leftSecondaryBaseCss.includes('translateZ(')
      && !leftSecondaryOpenCss.includes('translateZ('),
    'ui html: left secondary panel animates width opacity transform'
  );
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
  assert(preloadTs.includes("ipcRenderer.invoke('agent:editorComplete'") && preloadTs.includes("ipcRenderer.invoke('agent:editorAssist'") && mainTs.includes("ipcMain.handle('agent:editorComplete'") && mainTs.includes("ipcMain.handle('agent:editorAssist'"), 'editor IPC: completion and Agent assist use dedicated conversation-independent model requests');
  const wslClientTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'wslAgentClient.ts'), 'utf-8');
  const wslHostTs = fs.readFileSync(path.join(process.cwd(), 'src', 'wsl-agent-host.ts'), 'utf-8');
  const wslProtocolTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'wslAgentProtocol.ts'), 'utf-8');
  const wslHostToolBridgeTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'wslHostToolBridge.ts'), 'utf-8');
  assert(mainTs.includes("activeAgentBackendMode: 'windows' | 'wsl'") && mainTs.includes("configuredAgentBackend") && mainTs.includes('agentBackendRestartRequired') && !mainTs.includes("if (key === 'run_in_wsl' && value === true) await ensureWslAgentClient()"), 'main WSL backend: configured backend changes only after restart and does not hot-switch active conversations');
  assert(mainTs.includes('function detectWslDistrosAtStartup(): Promise<string[]>') && mainTs.includes("id: 'wsl-detection'") && mainTs.includes('delayMs: 500') && mainTs.includes('const distros = await detectWslDistrosAtStartup()') && mainTs.includes('function availableWslDistros(): string[]') && mainTs.includes('return wslDistroCache.items.slice()') && mainTs.includes('const wslDistros = availableWslDistros()') && mainTs.includes('wslAvailable: wslDistros.length > 0') && mainTs.includes('wslDistros,'), 'main WSL backend: detects distributions only after promotion and reports the non-blocking cached result for UI gating');
  const wslPackageConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
  assert(mainTs.includes('function ensureWslRuntimeBundle()') && mainTs.includes("'app.asar.unpacked', 'dist', 'wsl-agent-host.bundle.cjs'") && !mainTs.includes("path.join(userRuntimeRoot(), 'Runtime', 'wsl'") && wslPackageConfig.build?.asarUnpack?.includes('dist/wsl-agent-host.bundle.cjs'), 'main WSL backend: loads one read-only unpacked Agent bundle without copying runtime code into .Newmark');
  assert(wslClientTs.includes("spawn('wsl.exe'") && wslClientTs.includes('windowsDrivePathToWsl') && wslClientTs.includes("message.event === 'work'") && wslHostTs.includes('return new ConversationKernel(root, agent, null, {') && wslHostTs.includes("backend: 'wsl'"), 'WSL backend bridge: persistent JSONL RPC host runs a lifecycle-configured ConversationKernel in WSL and streams conversation events');
  assert(wslClientTs.includes("['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']") && wslClientTs.includes('runtimeEnv.push(`${key}=${value}`)'), 'WSL backend bridge: forwards explicit host proxy variables into the Linux runtime without persisting secrets or network settings');
  assert(wslProtocolTs.includes("method: 'terminal_state'") && wslProtocolTs.includes("method: 'terminal_write'") && wslProtocolTs.includes("method: 'terminal_stop'") && wslProtocolTs.includes("method: 'terminal_detach'") && wslProtocolTs.includes("event: 'terminal'") && wslClientTs.includes('subscribeTerminal') && wslHostTs.includes('onTerminalTakeoverEvent'), 'WSL terminal bridge: state/write/stop/detach requests and terminal events cross the persistent JSONL host');
  assert(wslProtocolTs.includes("event: 'host_tool_request'") && wslProtocolTs.includes("method: 'host_tool_result'") && wslHostToolBridgeTs.includes('requestWindowsHostTool') && wslClientTs.includes('setHostToolHandler') && wslClientTs.includes("'computer_use', 'browser_use', 'automation', 'terminal_takeover'") && toolsTs.includes("requestWindowsHostTool('computer_use'") && toolsTs.includes("requestWindowsHostTool('terminal_takeover'"), 'WSL host-tool bridge: desktop-global browser/computer/automation/terminal requests are allowlisted and settled through Electron main');
  assert(wslProtocolTs.includes("method: 'reset'") && wslClientTs.includes('resetAgent()') && wslHostTs.includes('resetAgentRuntime()') && mainTs.includes('await wslAgentClient.resetAgent()') && mainTs.includes("shutdownTerminalTakeoverSessions('app-exit')"), 'WSL lifecycle: Agent resets preserve the host terminal registry while app exit shuts down terminal sessions');
  assert(preloadTs.includes("wslBackendStatus: () => ipcRenderer.invoke('wsl:backendStatus')") && preloadTs.includes("wslBackendTest: () => ipcRenderer.invoke('wsl:backendTest')") && !preloadTs.includes('wslDetect:') && !uiHtml.includes('window.testAgentWslBackend') && !uiHtml.includes('settings.testWslBackend'), 'WSL detection: remains a startup backend concern without a settings-page detect/test control');
  assert(windowsDrivePathToWsl('C:\\Users\\Test User\\repo') === '/mnt/c/Users/Test User/repo' && windowsDrivePathToWsl('D:/work/project') === '/mnt/d/work/project', 'WSL path mapping: converts Windows drive paths without shell escaping loss');
  if (process.platform === 'win32') {
    const wslProbe = spawnSync('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'true'], { windowsHide: true, timeout: 10000 });
    if (!wslProbe.error && wslProbe.status === 0) {
      const wslRoot = path.join(TEST_DIR, 'wsl-client');
      fs.mkdirSync(wslRoot, { recursive: true });
      const wslClient = new WslAgentClient('Ubuntu-24.04', wslRoot, path.join(process.cwd(), 'dist', 'wsl-agent-host.bundle.cjs'));
      try {
        await wslClient.start();
        const wslA = await wslClient.snapshot('wsl-conv-a', { name: 'wsl-workspace', path: TEST_DIR, isInternal: false, kind: 'local' });
        const wslB = await wslClient.snapshot('wsl-conv-b', { name: 'wsl-workspace', path: TEST_DIR, isInternal: false, kind: 'local' });
        assert(wslClient.status().connected && wslClient.status().distro === 'Ubuntu-24.04' && wslA.backend === 'wsl', 'WSL backend client: starts persistent Linux Agent host and reports connected backend');
        assert(wslA.conversationId === 'wsl-conv-a' && wslB.conversationId === 'wsl-conv-b', 'WSL backend client: keeps requested conversation snapshots isolated');
      } finally {
        await wslClient.stop();
      }
    }
  }
  const nativeToolsTs = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'nativeTools.ts'), 'utf-8');
  const agentTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agent.ts'), 'utf-8');
  assert(!agentTs.includes('public getConversationSnapshot(conversationId = this.activeConversationId): ConversationSnapshot {\n    this.saveWorkspaceConversationState();') && !agentTs.includes('public ensureConversationSnapshot(conversationId = this.activeConversationId): ConversationSnapshot {\n    this.saveWorkspaceConversationState();') && agentTs.includes('const isActiveConversation = clean === this.safeConversationId') && agentTs.includes('const sourceChatMessages = isActiveConversation') && agentTs.includes('? this.chatMessages') && agentTs.includes(': (persisted?.chatMessages ?? memory?.chatMessages ?? [])') && agentTs.includes('const chatMessages = isActiveConversation') && agentTs.includes(': this.normalizeConversationChatMessages(sourceChatMessages, history)') && agentTs.includes('isActiveConversation ? this.workRuns : (persisted?.workRuns || memory?.workRuns)') && agentTs.includes('mirrorConversationStateFrom(id: string') && agentTs.includes('const stateKey = this.workspaceConversationStateKey(clean);') && agentTs.includes("this.safeConversationId(this.activeConversationId || 'default') === clean"), 'agent conversation snapshots are read-only, active target state is live, cold target state is persisted and attachment-normalized, and runner mirrors synchronize active host memory');
  const configTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'config.ts'), 'utf-8');
  const getStateHandler = mainTs.slice(mainTs.indexOf("ipcMain.handle('agent:getState'"), mainTs.indexOf("ipcMain.handle('agent:getConversationPlan'"));
  assert(getStateHandler.includes('...conversationSnapshot') && !getStateHandler.includes('chatMessages: agent.chatMessages'), 'main process: conversation-scoped getState does not overwrite target messages with shared host messages');
  const fuzzyTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'fuzzy.ts'), 'utf-8');
  const providerTs = fs.readFileSync(path.join(process.cwd(), 'src', 'llm', 'provider.ts'), 'utf-8');
  const agentKernelRunnerTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agentKernelRunner.ts'), 'utf-8');
  const workspaceTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'workspace.ts'), 'utf-8');
  const memoryLabTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'memoryLab.ts'), 'utf-8');
  const installUpdateTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'installUpdate.ts'), 'utf-8');
  assert(uiHtml.includes('function scheduleLayoutStateSave()') && uiHtml.includes('layoutState: {') && uiHtml.includes('leftCollapsed: !!state.leftCollapsed') && uiHtml.includes('rightCollapsed: !!state.rightCollapsed') && uiHtml.includes('bottomCollapsed: !!state.bottomCollapsed') && uiHtml.includes('secondaryCollapsed: !!state.secondaryCollapsed') && uiHtml.includes('function applySavedLayoutState(input)') && mainTs.includes('leftPanelCollapsed') && mainTs.includes("case 'layoutState'") && configTs.includes('bottom_panel_collapsed') && configTs.includes('secondary_panel_collapsed'), 'ui layout memory: persists only sidebar collapsed booleans and restores them from config');
  assert(workspaceTs.includes('setPinned(id: string, pinned: boolean)') && agentTs.includes('setConversationPinned(id: string, pinned: boolean)') && preloadTs.includes('setWorkspacePinned') && preloadTs.includes('setConversationPinned') && mainTs.includes("agent:setWorkspacePinned") && mainTs.includes("agent:setConversationPinned") && uiHtml.includes('window.toggleWorkspacePinned') && uiHtml.includes('window.toggleConversationPinned') && uiHtml.includes('conv-pin-btn') && uiHtml.includes('ws-pin-btn'), 'pinning: workspace and conversation pin state is persisted and exposed in the UI');
  assert(uiHtml.includes('.ws-pin-btn {') && uiHtml.includes('.conv-pin-btn {') && (uiHtml.match(/margin-left: auto;/g) || []).length >= 2, 'pinning layout: workspace and conversation pin actions occupy the rightmost flex slot');
  assert(uiHtml.includes('#left.collapsed .left-ws-item .ws-pin-btn {') && (uiHtml.match(/margin-left: 0;/g) || []).length >= 2, 'collapsed workspace rail: hidden pin actions release auto margin so thumbnails stay centered');
  assert(preloadTs.includes('githubOverview') && mainTs.includes("ipcMain.handle('github:overview'") && mainTs.includes("['repo', 'list', login") && uiHtml.includes('window.renderGithubOverview') && uiHtml.includes('window.loadGithubOverview') && !uiHtml.includes("window.runGhUi = function"), 'GitHub CLI panel: account-owned repositories, issues, and PRs are queried as structured data and rendered as UI instead of raw commands');
  assert(mainTs.includes('function runCommandAsync(') && mainTs.includes("runJsonCommand('gh'") && mainTs.includes('Promise.all([') && !mainTs.slice(mainTs.indexOf("ipcMain.handle('github:overview'"), mainTs.indexOf("ipcMain.handle('wsl:backendStatus'")).includes("spawnSync('gh'"), 'GitHub CLI panel: overview refresh uses bounded asynchronous child processes and cannot block the Electron main loop');
  assert(mainTs.includes('viewerHasStarred,stargazerCount,forkCount,parent,viewerPermission,viewerSubscription') && uiHtml.includes('selected.viewerHasStarred') && uiHtml.includes('selected.stargazerCount') && uiHtml.includes('selected.forkCount') && uiHtml.includes('selected.parent'), 'GitHub CLI panel: selected repository shows viewer starred state, star/fork counts, fork ancestry, permission, and subscription');
  assert(uiHtml.includes('class="newmark-list"') && uiHtml.includes('class="newmark-list-row"') && uiHtml.includes('newmark-list-row newmark-list-empty') && !uiHtml.includes('class="settings-list-row"'), 'GitHub CLI panel: populated and empty issues and PRs use the Newmark native list surface');
  assert(uiHtml.includes("'plugins.runningGh': 'Communicating'") && uiHtml.includes("'plugins.runningGh': '正在通信'") && uiHtml.includes('githubOverviewHash') && uiHtml.includes('if (signature === state.githubOverviewHash) return') && uiHtml.includes("{ initial: !state.githubOverviewLoaded }"), 'GitHub CLI panel: communication status appears only on first entry and unchanged data does not repaint the page');
  assert(uiHtml.includes('githubOverviewPendingRepo') && uiHtml.includes('if (state.githubOverviewLoading)') && uiHtml.includes('window.loadGithubOverview(pendingRepo)') && uiHtml.includes("data.repository || (repos[0] && repos[0].nameWithOwner)"), 'GitHub CLI panel: selections made during communication are queued and the details card resolves to the visible repository');
  assert(uiHtml.includes('.github-repo-select {') && uiHtml.includes('border-radius:var(--radius-md)') && uiHtml.includes('appearance:none') && uiHtml.includes('github-repo-select-icon') && uiHtml.includes("iconSvg('chevron-down'"), 'GitHub CLI panel: repository selector uses a rounded Newmark control with a Lucide dropdown icon');
  assert(preloadTs.includes('listMcpServers') && preloadTs.includes('upsertMcpServer') && mainTs.includes("ipcMain.handle('mcp:list'") && mainTs.includes("ipcMain.handle('mcp:upsert'") && mainTs.includes("ipcMain.handle('mcp:setEnabled'") && mainTs.includes("ipcMain.handle('mcp:remove'") && uiHtml.indexOf("showPluginList(\\'mcp\\')") < uiHtml.indexOf("showPluginList(\\'installed\\')") && uiHtml.includes('window.renderMcpManager') && uiHtml.includes('window.saveMcpServer'), 'Plugins UI: MCP management is live, persistent, and ordered before Skills management');
  assert(agentKernelRunnerTs.includes("realToolCalls.length ? 'response' : 'final_response'") && agentTs.includes("event.type !== 'text'") && agentTs.includes("'final_response'") && uiHtml.includes("'start', 'text', 'response', 'final_response'") && uiHtml.includes("rawType === 'final_response'") && uiHtml.includes("type === 'final_response' && workRun"), 'Build transcript: public tool-phase replies stay in the Build process while the final response is persisted separately and rendered once below the block');
  assert(!agentKernelRunnerTs.includes("|| name.startsWith('memory_lab_')"), 'Memory Lab tools: read/update/reindex results continue through the same model turn instead of terminating before the next tool or final response');
  assert(uiHtml.includes('.conversation-work-run::before') && uiHtml.includes('padding-left: 24px') && uiHtml.includes('border: 0;') && uiHtml.includes('#chat-area:has(> .chat-msg)') && uiHtml.includes('background-size: 1px 100%, 1px 100%;') && uiHtml.includes('.chat-msg.user .meta { justify-content: flex-end') && uiHtml.includes('.chat-msg.user .msg-body { text-align: right; }') && uiHtml.includes('.chat-msg.user::after') && uiHtml.includes('right: 3px;') && uiHtml.includes('.chat-msg.user .msg-actions { margin-left: 4px; }') && uiHtml.includes('.conversation-work-activity-list') && uiHtml.includes('conversation-work-activity-detail') && uiHtml.includes('data-activity-key=') && uiHtml.includes('activityOpenStates') && uiHtml.includes('function updateConversationWorkRunDuration(run)') && uiHtml.includes('updateConversationWorkRunDuration(runs[i])') && uiHtml.includes('function guideWorkEventKey(event)') && uiHtml.includes('function mergeGuideWorkEvent(previous, incoming)') && uiHtml.includes('rank = { accepted: 1, deferred: 2, rejected: 3, applied: 4 }') && uiHtml.includes('event.clientMessageId || (event.guide && event.guide.clientMessageId)') && !uiHtml.includes("addMsg('user', displayText, 'guide'") && uiHtml.includes('if (workRun) return;') && uiHtml.includes("if (String(m.role || '') === 'workflow' && /^tool:/.test"), 'Build transcript layout: continuous rails survive inter-message content, expanded tool activities survive live refresh, one Guide id upgrades accepted to applied without downgrade, and legacy tool chat rows stay hidden');
  assert(uiHtml.includes('function renderWorkToolGroup(event, eventIndex)')
    && uiHtml.includes("presentedEvents.push({ type: 'tool_group'")
    && uiHtml.includes("if (type === 'tool_group') return renderWorkToolGroup(event, eventIndex)")
    && uiHtml.includes('conversation-work-command-label')
    && uiHtml.includes('conversation-work-files')
    && uiHtml.includes('conversation-work-file-stats')
    && uiHtml.includes('conversation-work-file-line del')
    && uiHtml.includes('conversation-work-file-line add')
    && uiHtml.includes('data-work-detail-key=')
    && uiHtml.includes('activityOpenStates[refreshedKey]')
    && uiHtml.includes("'已编辑的文件'")
    && uiHtml.includes("return (currentLang() === 'zh' ? 'Ran ' : 'Ran ') + command"), 'Build transcript tool group: renders one expandable command/edit summary, chronological command rows, edited-file stats, and nested red/green line diffs');
  assert(agentTs.includes('expanded: raw.expanded === undefined ? true : !!raw.expanded') && agentTs.includes('activeRun.expanded = true') && uiHtml.includes("run.status = 'completed'; run.endedAt") && !uiHtml.includes("run.status = 'completed'; run.endedAt = event.endedAt || event.timestampIso || new Date().toISOString(); run.expanded = false"), 'Build transcript visibility: completed, errored, and interrupted runs remain expanded by default while preserving manual collapse state');
  assert(agentTs.includes("listArchives(scope: 'workspace' | 'all' = 'workspace')") && agentTs.includes('archiveRoots()') && agentTs.includes('resolveArchivePath') && preloadTs.includes('listArchives: (scope?: string)') && mainTs.includes("scope === 'all' ? 'all' : 'workspace'") && uiHtml.includes("api.listArchives('workspace')") && uiHtml.includes("api.listArchives('all')") && uiHtml.includes('state.workspaceArchives') && uiHtml.includes('state.allArchives'), 'archives: right sidebar lists current workspace archives while Settings archive can list all archives');
  assert(agentTs.includes('restoreArchivedConversation(nameOrId: string)') && agentTs.includes("kind: 'newmark-conversation-archive'") && preloadTs.includes('restoreArchive: (name: string)') && mainTs.includes("ipcMain.handle('agent:restoreArchive'") && uiHtml.includes('window.restoreArchive = function') && uiHtml.includes("t('archive.restore')"), 'archives: structured conversation manifests support conflict-safe restore from workspace and global archive UI');
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
  const releaseDev010FeaturesSmoke = fs.readFileSync(path.join(process.cwd(), 'scripts', 'release-dev010-features-smoke.cjs'), 'utf-8');
  const dev010PerformanceBenchmark = fs.readFileSync(path.join(process.cwd(), 'scripts', 'benchmark-dev010-startup-memory.cjs'), 'utf-8');
  const releaseUiGemmaRemovalSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-gemma-removal-smoke.cjs');
  const releaseUiGemmaRemovalSmoke = fs.existsSync(releaseUiGemmaRemovalSmokePath) ? fs.readFileSync(releaseUiGemmaRemovalSmokePath, 'utf-8') : '';
  const releaseUiFlowSubagentSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-flow-subagent-smoke.cjs');
  const releaseUiFlowSubagentSmoke = fs.existsSync(releaseUiFlowSubagentSmokePath) ? fs.readFileSync(releaseUiFlowSubagentSmokePath, 'utf-8') : '';
  const releaseUiMediaMdSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-media-md-smoke.cjs');
  const releaseUiMediaMdSmoke = fs.existsSync(releaseUiMediaMdSmokePath) ? fs.readFileSync(releaseUiMediaMdSmokePath, 'utf-8') : '';
  const releaseUiRuntimeLayoutSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-runtime-layout-smoke.cjs');
  const releaseUiRuntimeLayoutSmoke = fs.existsSync(releaseUiRuntimeLayoutSmokePath) ? fs.readFileSync(releaseUiRuntimeLayoutSmokePath, 'utf-8') : '';
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
  const releaseLinuxRealProviderSmoke = fs.readFileSync(path.join(process.cwd(), 'scripts', 'release-linux-real-provider-smoke.cjs'), 'utf-8');
  const releaseLinuxGuiSmoke = fs.readFileSync(path.join(process.cwd(), 'scripts', 'release-linux-gui-smoke.cjs'), 'utf-8');
  const releaseUiWslAgentBackendSmoke = fs.readFileSync(path.join(process.cwd(), 'scripts', 'release-ui-wsl-agent-backend-smoke.cjs'), 'utf-8');
  assert(releaseLinuxGuiSmoke.includes('NEWMARK_BASH_ROUNDTRIP_OK') && releaseLinuxGuiSmoke.includes('NEWMARK_SH_ISOLATION_OK') && releaseLinuxGuiSmoke.includes('terminalGetBuffer') && releaseLinuxGuiSmoke.includes('terminalKill') && releaseLinuxGuiSmoke.includes('isolated'), 'Linux packaged GUI smoke: bash/sh command round trips, session isolation, buffer reads, and process stops are exercised');
  assert(releaseUiWslAgentBackendSmoke.includes("'--allow-multiple-instances'") && releaseUiWslAgentBackendSmoke.includes("cdp.call('Page.bringToFront'") && releaseUiWslAgentBackendSmoke.includes('await waitForPromotedMainUi(cdp);') && releaseUiWslAgentBackendSmoke.includes('window.api.selectWorkspace'), 'WSL backend smoke: isolated no-workspace startup checks visible promotion before selecting a target workspace through the backend API');
  const distPortableScript = fs.readFileSync(path.join(process.cwd(), 'scripts', 'dist-portable.cjs'), 'utf-8');
  const distLinuxScript = fs.readFileSync(path.join(process.cwd(), 'scripts', 'dist-linux.cjs'), 'utf-8');
  const releaseLinuxZipSmoke = fs.readFileSync(path.join(process.cwd(), 'scripts', 'release-linux-unpacked-zip-smoke.cjs'), 'utf-8');
  const releaseLinuxDebSmoke = fs.readFileSync(path.join(process.cwd(), 'scripts', 'release-linux-deb-smoke.cjs'), 'utf-8');
  const packageJson = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8');
  const electronBuilderConfigTs = fs.readFileSync(path.join(process.cwd(), 'electron-builder.config.ts'), 'utf-8');
  const automationWakeTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'automationWake.ts'), 'utf-8');
  const appIconIcoPath = path.join(process.cwd(), 'assets', 'icon.ico');
  const appIconIco = fs.existsSync(appIconIcoPath) ? fs.readFileSync(appIconIcoPath) : Buffer.alloc(0);
  const appIconDark = fs.readFileSync(path.join(process.cwd(), 'assets', 'app-icon-dark.png'));
  const appIconLight = fs.readFileSync(path.join(process.cwd(), 'assets', 'app-icon-light.png'));
  assert(launcherTs.includes('drainCliNetworkHandles') && mainTs.includes('drainCliNetworkHandles') && launcherTs.includes('stopComputerUsePowerShellHost') && mainTs.includes('stopComputerUsePowerShellHost') && launcherTs.includes('getGlobalDispatcher') && mainTs.includes('getGlobalDispatcher'), 'cli entrypoints: stop persistent Computer Use helpers and drain async network handles before exit');
  assert(cliCommandsTs.includes("process.stdout.on('error'") && cliCommandsTs.includes("process.stderr.on('error'") && cliCommandsTs.includes('stdoutBrokenPipe = true') && cliCommandsTs.includes('stderrBrokenPipe = true'), 'cli entrypoints: suppress asynchronous EPIPE errors from closed stdout/stderr pipes');
  assert(mainTs.includes('function pathArgValue') && mainTs.includes("const prefix = `${key}=`") && mainTs.includes("let best = fs.existsSync(parts[0]) ? parts[0] : ''") && mainTs.includes("if (fs.existsSync(candidate)) best = candidate") && mainTs.includes("return best || parts.join(' ') || undefined") && mainTs.includes("pathArgValue(args, '--root')"), 'main entrypoint: supports --root paths with spaces, --root=path form, and longest existing path matching');
  assert(mainTs.includes('const singleInstanceLock = allowMultipleInstances || app.requestSingleInstanceLock()'), 'main entrypoint: explicit multi-instance test windows skip Electron single-instance coordination entirely');
  assert(launcherTs.includes('function pathArgValue') && launcherTs.includes('function userRuntimeRoot') && launcherTs.includes("path.join(os.homedir(), '.Newmark')") && launcherTs.includes('function legacyUserDataRoot') && launcherTs.includes('function migrateLegacyRuntimeRoot') && launcherTs.includes('function writableRuntimeRoot') && launcherTs.includes('const installRoot = path.dirname(process.execPath)') && launcherTs.includes('if (isPathInside(installRoot, resolved)) return userRuntimeRoot()') && launcherTs.includes("path.join(userRuntimeRoot(), 'Roots'") && launcherTs.includes("const explicitRoot = pathArgValue(args, '--root')") && launcherTs.includes('const root = explicitRoot ? writableRuntimeRoot(explicitRoot) : userRuntimeRoot()'), 'launcher entrypoint: every install location resolves settings to user home .Newmark while isolated explicit roots remain supported');
  assert(mainTs.includes('function userRuntimeRoot') && mainTs.includes("path.join(os.homedir(), '.Newmark')") && mainTs.includes('function legacyUserDataRoot') && mainTs.includes('function migrateLegacyRuntimeRoot') && mainTs.includes('function canWriteDirectory') && mainTs.includes('function isProtectedInstallRoot') && mainTs.includes('function shadowRootFor') && mainTs.includes('function writableRuntimeRoot') && mainTs.includes('if (isPathInside(exeRoot(), resolved)) return userRuntimeRoot()') && mainTs.includes("process.env.ProgramFiles") && mainTs.includes("path.join(userRuntimeRoot(), 'Roots'") && mainTs.includes('if (explicitRoot) return writableRuntimeRoot(explicitRoot)') && mainTs.includes('return getRoot();') && mainTs.includes('firstRunInit(root);') && mainTs.includes('firstRunInit(fallbackRoot)') && mainTs.includes('logStartupFailure(`firstRunInit:${root}`'), 'main startup: every packaged install location resolves settings to user home .Newmark and never treats its executable directory as mutable state');
  assert(mainTs.includes('existingPcId = fs.existsSync(pcHashPath)') && mainTs.includes('if (existingPcId !== pcId) fs.writeFileSync(pcHashPath, pcId') && memoryLabTs.includes('if (!fs.existsSync(this.indexPath))') && memoryLabTs.includes('this.normalizeIndex(raw);') && !memoryLabTs.includes('else this.saveIndex(this.normalizeIndex(this.loadIndex()))') && configTs.includes('if (fs.existsSync(configPath))') && workspaceTs.includes('if (this.external.length !== before) this.saveExternal();'), 'startup initialization: avoids rewriting config.json, PC_Hash.config, Memory Lab index, and External.json on every launch');
  assert(workspaceTs.includes('normalizeInternalWorkspace') && workspaceTs.includes("const expectedPath = path.join(this.rootPath, 'Work', name)") && workspaceTs.includes('normalizeHostWorkspacePath(String(input?.path') && workspaceTs.includes('if (internalChanged) this.saveInternal();') && workspaceTs.includes('!stateCurrent?.id || stateCurrent.id !== stored.id') && workspaceTs.includes('normalizeHostWorkspacePath(stateCurrent.path) !== normalizeHostWorkspacePath(stored.path)') && wslHostTs.includes("workspaceRegistryMode: 'detached'") && wslHostTs.includes('createRunner: () => createWslAgent(agent.runtimeActorId)'), 'workspace migration: Windows/WSL aliases and damaged mixed-host paths normalize under the owning host while every WSL worker layer remains detached from the shared registry');
  assert(mainTs.includes('startupAttempt = 1') && mainTs.includes('startupWindow = createDesktopWindow(true, true, startupAttempt)') && mainTs.includes("ipcMain.handle('startup:waitForBackend'") && mainTs.includes('runStartupPrewarmBarrier') && mainTs.includes('const reusesPreloadedUi = attemptOneNavigationPreloaded') && mainTs.includes('if (!reusesPreloadedUi)') && mainTs.includes('waitForUiReadiness(startupUiWindow)') && mainTs.includes('promoteStartupUi(startupUiWindow)') && uiHtml.includes('id="startup-cover"') && uiHtml.indexOf('startupCover.remove()') > uiHtml.indexOf('readyAck.accepted !== true') && !mainTs.includes('createDesktopWindow!(true, false, attemptId)') && !mainTs.includes('shellWindow.destroy()') && !mainTs.includes('win.webContents.stop();'), 'main startup: keeps the in-window startup cover until readiness acknowledgement and atomically promotes that same hydrated window');
  assert(uiHtml.includes('id="todo-wrap" class="stack-card collapsed" style="display:none"') && uiHtml.includes('id="queue-panel" class="stack-card collapsed" style="display:none"'), 'input stack: task and queue bars stay hidden before state-driven rendering to avoid empty startup flashes');
  assert(mainTs.includes("const APP_NAME = 'Newmark Agent'") && mainTs.includes("const APP_ID = 'ai.newmark.agent'") && mainTs.includes('app.setName(APP_NAME)') && mainTs.includes('app.setAppUserModelId(APP_ID)'), 'main entrypoint: registers Newmark process/app identity instead of Electron');
  assert(packageJson.includes('"productName": "Newmark Agent"') && packageJson.includes('"executableName": "Newmark Agent"') && packageJson.includes('"signAndEditExecutable": false') && packageJson.includes('"afterPack": "scripts/after-pack-win-icon.cjs"') && packageJson.includes('"target": "msi"') && packageJson.includes('"msi"') && packageJson.includes('Newmark-Agent-${version}-${arch}.${ext}') && packageJson.includes('"dist:windows-release"') && packageJson.includes('"resedit": "^1.7.2"') && electronBuilderConfigTs.includes("productName: 'Newmark Agent'") && electronBuilderConfigTs.includes("executableName: 'Newmark Agent'") && electronBuilderConfigTs.includes("afterPack: 'scripts/after-pack-win-icon.cjs'"), 'package metadata: product and executable names are fixed to Newmark Agent, every Windows pack patches and verifies executable resources, and releases target MSI');
  assert(fs.existsSync(path.join(process.cwd(), 'assets', 'app-icon-dark.png')) && fs.existsSync(path.join(process.cwd(), 'assets', 'app-icon-light.png')) && appIconIco.length > 6 && appIconIco.readUInt16LE(2) === 1 && appIconIco.readUInt16LE(4) >= 1, 'app icons: themed PNG assets and Windows ICO exist');
  assert(createHash('sha256').update(appIconDark).digest('hex').toUpperCase() === 'D07F670051677EEF1BD4B60EF186E8ADB81A37202BE49F929DA84D38C54E4305' && createHash('sha256').update(appIconLight).digest('hex').toUpperCase() === 'E8482757BC5AB5BD4C9A4589A878170C0D3DAE25A8F27A5461CEC45F2EFCB3CA', 'app icons: source assets exactly match the supplied dark and light finished PNGs');
  assert(packageJson.includes('"icon": "assets/icon.ico"') && electronBuilderConfigTs.includes("icon: 'assets/icon.ico'"), 'app icons: Windows package uses generated ICO');
  assert(mainTs.includes('nativeTheme') && mainTs.includes("const themeName = nativeTheme.shouldUseDarkColors ? 'light' : 'dark'") && mainTs.includes("`app-icon-${themeName}-64.png`") && mainTs.includes("appAssetPath(`app-icon-${themeName}.png`)") && mainTs.includes('createAppIconImage(16)') && mainTs.includes('icon: themedAppIconPath()') && mainTs.includes("nativeTheme.on('updated', refreshNativeThemeIcons)") && mainTs.includes('win.setIcon(windowIcon)') && mainTs.includes('tray.setImage(createAppIconImage(16))'), 'app icons: runtime windows, taskbar, and tray update compact themed assets with full-resolution fallback when the system theme changes');
  assert(mainTs.includes('function refreshNativeThemeIcons(): void') && !mainTs.includes('const refreshNativeThemeIcons ='), 'app icons: theme refresh is hoisted so early tray creation cannot hit a temporal-dead-zone startup failure');
  assert(mainTs.includes('startupWindow = createDesktopWindow(true, true, startupAttempt)') && mainTs.includes('mainWindow = startupWindow') && mainTs.includes('createTray();') && mainTs.includes("tray.on('click', showMainWindow)") && mainTs.includes("tray.on('double-click', showMainWindow)") && mainTs.includes('if (tray) return;'), 'tray lifecycle: creates one tray with the single startup window and reuses it while showing the promoted main window');
  assert(mainTs.includes("path.resolve(agent?.workspace.current?.path || root)") && mainTs.includes("ipcMain.handle('agent:getFileTree'"), 'file tree: defaults to the active workspace instead of exposing the ~/.Newmark runtime root and nested Roots shadows');
  assert(mainTs.includes("agent?.config.getBool('ui', 'minimize_to_tray') ?? true") && mainTs.includes("agent?.config.getStr('general', 'close_behavior')") && mainTs.includes("ipcMain.handle('app:lifecycleState'"), 'window lifecycle: separates minimize-to-tray from close behavior and exposes a smoke-test state');
  assert(preloadTs.includes("lifecycleState: () => ipcRenderer.invoke('app:lifecycleState')") && !uiHtml.includes("if (s.minimizeToTray) state.closeBehavior = 'minimize';"), 'window lifecycle: preload exposes lifecycle state without overwriting close behavior from minimize settings');
  assert(nativeToolsTs.includes('NATIVE_TOOL_CATALOG') && nativeToolsTs.includes("name: 'computer_use'") && nativeToolsTs.includes("name: 'terminal_takeover'") && nativeToolsTs.includes("name: 'subagent_read'") && nativeToolsTs.includes(".filter(tool => (tool.availability || 'configurable') === 'configurable')") && nativeToolsTs.includes('normalizeNativeToolEnabled') && configTs.includes('defaultNativeToolEnabled()') && configTs.includes("tools:") && toolsTs.includes('isNativeToolEnabled') && mainTs.includes('nativeToolCatalogForState') && mainTs.includes("case 'nativeTools'"), 'native tools settings: configurable catalog is exposed while required/mode-scoped tools stay system-managed and runtime-gated');
  assert(nativeToolsTs.includes("name: 'ssh_workspace'") && toolsTs.includes("t('ssh_workspace'") && toolsTs.includes('new SshManager') && preloadTs.includes('createSshWorkspace') && mainTs.includes("ssh:createWorkspace") && uiHtml.includes('ws-ssh-host') && uiHtml.includes('validateSshWorkspaceForm'), 'OpenSSH workspace: native tool, IPC, preload, and new-workspace UI are wired');
  assert(uiHtml.includes('id="title-app-logo"') && uiHtml.includes('id="title-app-icon"') && uiHtml.includes('src="../assets/app-icon-dark-64.png"') && uiHtml.includes('window.refreshTitlebarThemeIcon') && uiHtml.includes("state.theme === 'system' ? systemColorScheme.matches : state.theme !== 'light'") && uiHtml.includes("useDarkTheme ? '../assets/app-icon-dark-64.png' : '../assets/app-icon-light-64.png'") && uiHtml.includes("if (state.theme === 'system') applyUiAppearance()"), 'app icons: custom titlebar uses compact build-derived dark/light icons and reapplies appearance when the system scheme changes');
  assert(uiHtml.includes('#topbar .logo::before') && uiHtml.includes('animation: marquee-rotate var(--marquee-speed) linear infinite') && uiHtml.includes('var(--g1), var(--g2), var(--g3), var(--g4), var(--g1)') && uiHtml.includes('calc(-2 * var(--marquee-width))'), 'app icons: custom titlebar border uses shared adjustable marquee settings');
  assert(fs.existsSync(path.join(process.cwd(), 'scripts', 'patch-win-exe-icon.cjs')) && distPortableScript.includes("require('./patch-win-exe-icon.cjs')") && distPortableScript.includes('patchExeIdentity(unpackedExe)') && distPortableScript.includes('patchAndVerify(unpackedExe, packageIcon)') && distPortableScript.includes('verifyExeIcon(unpackedExe, packageIcon)') && distPortableScript.includes('verifyExeIdentity(unpackedExe)') && distPortableScript.includes('ProductName') && distPortableScript.includes('FileDescription') && distPortableScript.includes('electron.exe'), 'app icons: dist-portable patches/verifies win-unpacked exe associated icon and Newmark Windows resource identity before zipping');
  assert(packageJson.includes('"release:cli-smoke"') && releaseCliSmoke.includes('Start-Process') && releaseCliSmoke.includes('-RedirectStandardOutput'), 'release cli smoke: uses stable redirected packaged exe invocation');
  assert(distLinuxScript.includes('mktemp -d /tmp/newmark-linux-build.XXXXXX') && distLinuxScript.includes("--exclude='node_modules/'") && distLinuxScript.includes('npm ci --include=dev --no-audit --no-fund') && distLinuxScript.includes('node scripts/dist-linux.cjs --native') && distLinuxScript.includes("['-d', distro, '--', 'bash', '-s']") && distLinuxScript.includes('input: `${script}\\n`') && distLinuxScript.includes("stdio: ['pipe', 'inherit', 'inherit']") && distLinuxScript.includes('rsync -a --delete "$build_root/repo/release/linux-unpacked/"'), 'Linux release build: Windows streams an isolated WSL build script over stdin and uses Linux-native dependencies instead of reusing Windows node_modules');
  assert(releaseLinuxZipSmoke.includes("require(path.join(repoRoot, 'DESKTOP', 'package.json')).version") && releaseLinuxZipSmoke.includes('Newmark-Agent-${version}-linux-unpacked-x64.zip') && releaseLinuxDebSmoke.includes("require(path.join(repoRoot, 'DESKTOP', 'package.json')).version") && releaseLinuxDebSmoke.includes('Newmark-Agent-${version}-amd64.deb'), 'Linux release smokes: derive artifact names from the current package version');
  assert(releaseLinuxGuiSmoke.includes("String(t.url || '').includes('index.html')") && !releaseLinuxGuiSmoke.includes("|| targets.find(t => t.webSocketDebuggerUrl"), 'Linux GUI smoke: waits for the final index renderer instead of attaching to a transient AppImage startup target');
  assert(releaseLinuxRealProviderSmoke.includes("path.join(releaseRoot, 'linux-unpacked', 'newmark-agent')") && releaseLinuxRealProviderSmoke.includes("path.join(releaseRoot, 'linux-unpacked', 'Newmark Agent')") && releaseLinuxRealProviderSmoke.includes('fs.existsSync(defaultExePath) ? defaultExePath : productExePath'), 'Linux real-provider smoke: supports both legacy and product executable names');
  assert(releaseCliSmoke.includes("['state', '--root', root]") && releaseCliSmoke.includes('parsedState.autoSwitch') && releaseCliSmoke.includes('parsedState.autoSwitchScope') && releaseCliSmoke.includes('parsedState.openAIApiMode') && releaseCliSmoke.includes('parsedState.contextWindow') && releaseCliSmoke.includes("['tool', 'write'") && releaseCliSmoke.includes("'--args-file'") && releaseCliSmoke.includes("['send', '--input-file'") && releaseCliSmoke.includes("['validate-models', '--selected', 'ReleaseCliMock/release-cli-mock'") && releaseCliSmoke.includes("['skills-market'") && releaseCliSmoke.includes("'memory-lab'") && releaseCliSmoke.includes('ReleaseCliMemoryNeedle') && releaseCliSmoke.includes("log('memory-lab ok')") && releaseCliSmoke.includes("'install-update'") && releaseCliSmoke.includes('release update source with spaces') && releaseCliSmoke.includes('release update target with spaces') && releaseCliSmoke.includes("log('install-update ok')"), 'release cli smoke: covers state, model auto/context fields, tool, send, validate-models, skills-market, memory-lab, and space-containing install-update paths');
  assert(releaseCliSmoke.includes('RELEASE_CLI_SEND_OK 做了什么 验证 文件') && releaseCliSmoke.includes('"stream":true'), 'release cli smoke: covers UTF-8 streaming send output');
  assert(packageJson.includes('"release:111-cli-smoke"') && release111CliSmoke.includes('file_audit') && release111CliSmoke.includes('git_branch') && release111CliSmoke.includes('gh_fork') && release111CliSmoke.includes('repo_security_audit') && release111CliSmoke.includes('computer_use') && release111CliSmoke.includes('terminal_takeover') && release111CliSmoke.includes('ssh_workspace'), 'release 1.1.1 cli smoke: covers packaged audit, GitHub, Computer Use, SSH workspace, and terminal takeover tools');
  assert(release111CliSmoke.includes('positer/Newmark-Agent') && release111CliSmoke.includes('git-remote-fallback') && release111CliSmoke.includes('visibility') && release111CliSmoke.includes('Call computer_use observe first') && release111CliSmoke.includes('NEWMARK_RELEASE_SSH_HOST') && release111CliSmoke.includes('remotePcHash') && release111CliSmoke.includes('RELEASE_111_CLI_TERMINAL_TAKEOVER_DONE') && release111CliSmoke.includes('stateHasTakeoverChain') && release111CliSmoke.includes('TAKEOVER_WRITE_OK'), 'release 1.1.1 cli smoke: validates public remote review, GitHub fallback, target_id guard, optional VM SSH link, and same-session takeover output');
  assert(packageJson.includes('"release:computer-use-vision-smoke"') && releaseComputerUseVisionSmoke.includes('mock-computer-vision') && releaseComputerUseVisionSmoke.includes('mock-computer-text') && releaseComputerUseVisionSmoke.includes('computer_use') && releaseComputerUseVisionSmoke.includes("action: 'observe'") && releaseComputerUseVisionSmoke.includes('data:image\\/(?:png|jpeg|webp);base64,') && releaseComputerUseVisionSmoke.includes('text-only second request unexpectedly included screenshot image_url') && releaseComputerUseVisionSmoke.includes('tempScreenshotsDeleted') && releaseComputerUseVisionSmoke.includes('requestLeaksTempScreenshotPath'), 'release Computer Use vision smoke: packaged release verifies bounded image formats plus UI text for vision models, text-only UI text, and one-use screenshot deletion');
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
  assert(packageJson.includes('"msi"') && packageJson.includes('"perMachine": true') && packageJson.includes('"runAfterFinish": false') && packageJson.includes('patch-msi-project.cjs'), 'windows MSI: installs per-machine, does not auto-launch, and cleans running Newmark processes before file replacement');
  assert(releaseUiAgentSmoke.includes("'write,bash,edit,read'") && releaseUiAgentSmoke.includes('"timeout_ms":10000') && releaseUiAgentSmoke.includes('terminal timeout cap ok') && releaseUiAgentSmoke.includes("document.querySelector('.conversation-work-run')") && releaseUiAgentSmoke.includes("document.querySelectorAll('.run-final-response')") && releaseUiAgentSmoke.includes("waitFor(cdp, `!!document.querySelector('.work-review-btn')"), 'release ui agent smoke: validates write bash edit read tools, Build-owned final output, completion review, and terminal timeout cap without depending on sidebar casing or raw tool receipts');
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
  assert(releaseUiModelAutoContextSmoke.includes('context-token-ring') && releaseUiModelAutoContextSmoke.includes('ringWidth !== 16') && releaseUiModelAutoContextSmoke.includes('tooltipText.includes') && releaseUiModelAutoContextSmoke.includes('2026-07-15-dev-0.0.10-model-auto-context-smoke.png'), 'release ui model auto/context smoke: validates small context token ring placement, hover tooltip, and dev-0.0.10 screenshot evidence');
  assert(releaseUiModelAutoContextSmoke.includes("level: 'standard'") && releaseUiModelAutoContextSmoke.includes("status: 'verified'") && releaseUiModelAutoContextSmoke.includes('NEWMARK_TEST_EXE'), 'release ui model auto/context smoke: uses Standard-eligible fixtures and the artifact-selected executable');
  assert(packageJson.includes('"test:dev010"') && packageJson.includes('"release:dev010-features-smoke"') && packageJson.includes('"benchmark:dev010-startup"'), 'dev-0.0.10: package scripts register focused, packaged, and performance gates');
  assert(releaseDev010FeaturesSmoke.includes('dist/core/autoRouter.js') && releaseDev010FeaturesSmoke.includes('dist/core/modelValidation.js') && releaseDev010FeaturesSmoke.includes('NEWMARK_TEST_EXE') && releaseDev010FeaturesSmoke.includes('real_api_called: false'), 'dev-0.0.10 packaged smoke: inspects Auto/validation and remains provider-offline');
  assert(dev010PerformanceBenchmark.includes('MINIMUM_ACCEPTANCE_RUNS = 20') && dev010PerformanceBenchmark.includes('setCPUThrottlingRate') && dev010PerformanceBenchmark.includes('privateMiBBeforeBrowser') && dev010PerformanceBenchmark.includes('browserOpenMs'), 'dev-0.0.10 benchmark: enforces twenty runs and records low-performance, pre-Browser private-byte, and Browser metrics');
  assert(dev010PerformanceBenchmark.includes('STARTUP_ABSOLUTE_PRIVATE_MIB_LIMIT = 525')
    && dev010PerformanceBenchmark.includes('BROWSER_ON_DEMAND_TOTAL_PRIVATE_MIB_LIMIT = 696')
    && dev010PerformanceBenchmark.includes('BROWSER_ON_DEMAND_DELTA_PRIVATE_MIB_LIMIT = 300')
    && dev010PerformanceBenchmark.includes('startupMemoryAcceptance')
    && dev010PerformanceBenchmark.includes('browserOnDemandMemoryAcceptance')
    && dev010PerformanceBenchmark.includes('startupBeforeBrowser: startupMemoryGate')
    && dev010PerformanceBenchmark.includes('browserOnDemand: browserMemoryGate')
    && !dev010PerformanceBenchmark.includes('afterMemoryGate = memoryAcceptance'), 'dev-0.0.10 benchmark: keeps the 525 MiB/25% startup gate while auditing Browser-on-demand total and delta with separate runaway limits');
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
  assert(releaseUiMediaMdSmoke.includes("window.openFile('media-doc.md')") && releaseUiMediaMdSmoke.includes("window.openFile('media-link-target.txt')")
    && releaseUiMediaMdSmoke.includes('markdown preview resets before non-markdown editor')
    && releaseUiMediaMdSmoke.includes('#editor-md-toggle') && releaseUiMediaMdSmoke.includes('#editor-md-preview') && releaseUiMediaMdSmoke.includes('MD_VIEWER_OK_20260628'),
  'release ui media/md smoke: validates integrated Markdown preview and its reset before a non-Markdown editor');
  assert(releaseUiMediaMdSmoke.includes('.msg-file-link[data-path="media-link-target.txt"]') && releaseUiMediaMdSmoke.includes('.click()')
    && releaseUiMediaMdSmoke.includes('#editor-textarea') && releaseUiMediaMdSmoke.includes('EDITOR_LINK_TARGET_OK_20260628'),
  'release ui media/md smoke: clicks a rendered Markdown local-file link through the safe linked-file route');
  assert(releaseUiRuntimeLayoutSmoke.includes("find(item => item.querySelector('.ft-name')?.textContent === 'child.txt')")
    && releaseUiRuntimeLayoutSmoke.includes('await lazyItem.onclick()') && releaseUiRuntimeLayoutSmoke.includes('if (child) await child.onclick()')
    && releaseUiRuntimeLayoutSmoke.includes('LAZY_TREE_CHILD_OK'),
  'release ui runtime layout smoke: expands the file tree and clicks a file through the safe file-open route');
  assert(releaseUiRuntimeLayoutSmoke.includes("document.querySelector('#left-ws-list .left-ws-item.active')")
    && releaseUiRuntimeLayoutSmoke.includes('focused workspace did not reopen its conversation menu')
    && releaseUiRuntimeLayoutSmoke.includes('beforeConversationId !== workspaceFocusMenu.afterConversationId'),
  'release ui runtime layout smoke: clicking the focused conversation workspace reopens the secondary menu without changing conversation');
  assert(releaseUiRuntimeLayoutSmoke.includes("window.setBackgroundColor('#123456')")
    && releaseUiRuntimeLayoutSmoke.includes("window.setFontFamily('Segoe UI')")
    && releaseUiRuntimeLayoutSmoke.includes('visual preferences were not applied and persisted')
    && releaseUiRuntimeLayoutSmoke.includes('2026-07-14-visual-preferences.png'),
  'release ui runtime layout smoke: applies, persists, resets, and captures General visual preferences');
  assert(releaseUiRuntimeLayoutSmoke.includes('A durable submitted diagram')
    && releaseUiRuntimeLayoutSmoke.includes('.conversation-image-attachment')
    && releaseUiRuntimeLayoutSmoke.includes('2026-07-14-durable-user-image-ui.png'),
  'release ui runtime layout smoke: renders a revisitable user-image card and captures ordinary CDP UI evidence');
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
  assert(releaseUiConversationQueuePlanSmoke.includes('Page.captureScreenshot') && releaseUiConversationQueuePlanSmoke.includes('2026-07-16-dev-0.0.11-queue-guide-smoke.png'), 'release ui conversation queue/plan smoke: captures visual evidence');
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
  assert(distPortableScript.includes("runBuilder(['--win', 'dir']") && distPortableScript.includes("runBuilder(['--win', 'msi', '--prepackaged', unpackedDir]") && distPortableScript.includes('verifyMsiInstaller()') && distPortableScript.includes('ELECTRON_BUILDER_CACHE') && distPortableScript.includes('.electron-builder-cache') && distPortableScript.includes('MSI installer and win-unpacked zip pack verified'), 'dist windows release: builds patched win-unpacked first, then packages MSI from the prepackaged directory');
  assert(distPortableScript.includes('verifyReleaseCliSmoke()') && distPortableScript.includes('release-cli-smoke.cjs') && distPortableScript.includes('ensureNodePtyConptyAssets(nodePtyRoot)') && distPortableScript.includes("'conpty.dll', 'OpenConsole.exe'"), 'dist windows release: restores node-pty ConPTY assets after ABI rebuild and runs release CLI smoke after packaging');
  assert(distPortableScript.includes('win-unpacked-x64.zip') && distPortableScript.includes('Compress-Archive') && distPortableScript.includes('verifyZipPack()'), 'dist windows release: creates and verifies compiled win-unpacked zip update pack');
  assert(installUpdateTs.includes('writeDeferredWindowsUpdate') && installUpdateTs.includes('runningExecutableTarget(target)') && installUpdateTs.includes('deferred: true') && installUpdateTs.includes('Wait-Process -Id $pidToWait') && installUpdateTs.includes("$_.Name -eq 'Newmark Agent.exe'") && installUpdateTs.includes('Stop-Process -Id $_.ProcessId -Force') && installUpdateTs.includes('Start-Process -FilePath "powershell.exe"') && installUpdateTs.includes("spawn('powershell.exe'"), 'install update: Windows self-update exits the app, clears sibling Newmark processes, and then replaces running files');
  assert(mainTs.includes('if (!automationWakeMode)') && mainTs.includes('startupWindow = createDesktopWindow(true, true, startupAttempt)') && mainTs.includes('if (automationWakeMode)') && mainTs.includes('await ensureStartupAutomation()') && mainTs.includes('await automation!.tick()') && mainTs.includes('automation!.stop();') && mainTs.includes('app.quit();') && mainTs.indexOf('await automation!.tick()') < mainTs.indexOf('scheduleDeferredDesktopStartup(startupUiWindow)'), 'main automation wake: skips desktop-window creation, runs due schedules headless, and exits before deferred sidecar prewarm');
  assert(mainTs.includes('const syncAutomationWakeSoon = () =>') && mainTs.includes('syncAutomationWakeSoon();') && mainTs.indexOf('mainWindow = createDesktopWindow(false)') < mainTs.indexOf("app.on('will-quit'"), 'main startup: desktop window is created before noncritical automation wake sync can block startup');
  assert(automationWakeTs.includes('timeout: 5000') && automationWakeTs.includes('result.error?.message'), 'automation wake: Windows Task Scheduler calls are timeout-bounded so first desktop launch cannot hang indefinitely');
  assert(preloadTs.includes("refreshSkills: () => ipcRenderer.invoke('skills:refresh')") && preloadTs.includes("marketSkillSources: () => ipcRenderer.invoke('skills:marketSources')") && preloadTs.includes("memoryLabRead: (selector?: string) => ipcRenderer.invoke('memoryLab:read'") && preloadTs.includes('updateCheckGithub') && preloadTs.includes('updateApplyGithub') && preloadTs.includes('terminalKill: (sessionId: string, timeoutMs?: number)'), 'preload: exposes skills refresh, market source management, Memory Lab, updates, and terminal kill timeout');
  assert(preloadTs.includes("terminalTakeoverState: (conversationId?: string, actorId?: string) => ipcRenderer.invoke('agentTerminal:takeoverState'") && preloadTs.includes("terminalTakeoverWrite: (sessionId: string, data: string, conversationId?: string, actorId?: string) => ipcRenderer.invoke('agentTerminal:takeoverWrite'") && preloadTs.includes("terminalTakeoverStop: (sessionId: string") && preloadTs.includes("terminalTakeoverDetach: (sessionId: string") && preloadTs.includes('onTerminalTakeover'), 'preload: exposes owner-scoped Agent terminal state, write, stop, detach, and event IPC');
  assert(preloadTs.includes("githubCopilotLogin: () => ipcRenderer.invoke('github:copilotLogin')"), 'preload: exposes GitHub Copilot browser login bridge');
  assert(preloadTs.includes('webUtils') && preloadTs.includes('filePathForFile') && uiHtml.includes('function promptInsertText(text)') && uiHtml.includes('function clipboardFilePaths(dataTransfer)') && uiHtml.includes('function imageFilesFromDataTransfer(dataTransfer)') && uiHtml.includes('function attachPromptImagesFromDataTransfer(dataTransfer)') && uiHtml.includes('id="prompt-attachments"') && uiHtml.includes("els.prompt.addEventListener('paste'") && uiHtml.includes("els.prompt.addEventListener('drop'") && uiHtml.includes("paths.join('\\n')") && uiHtml.includes('composePromptTextForSend(rawText)'), 'ui html/preload: pasted or dropped files insert filesystem paths, and rootless pasted images render as prompt attachments');
  assert(conversationAttachmentsSource.includes('MAX_USER_IMAGE_COUNT = 6') && conversationAttachmentsSource.includes('MAX_USER_IMAGE_BYTES = 10 * 1024 * 1024')
    && conversationAttachmentsSource.includes('decodeInspectionImage') && conversationAttachmentsSource.includes('conversation-media')
    && conversationAttachmentsSource.includes('archiveConversationImageAttachment'),
  'user image persistence: validates bounded PNG/JPEG input, stores content-addressed assets, and exports portable archive copies');
  assert(uiHtml.includes('conversation-image-attachments') && uiHtml.includes('normalizeConversationImageAttachments')
    && uiHtml.includes('promptAttachmentsForConversation') && uiHtml.includes('nextQueueRequests')
    && uiHtml.includes('attachments: m.attachments || []'),
  'user image UI: durable attachments remain visible across snapshots, Guide reconciliation, edits, and queued sends');
  assert(uiPreferencesSource.includes('normalizeUiBackgroundColor') && uiPreferencesSource.includes('normalizeUiFontFamily')
    && mainTs.includes("case 'backgroundColor'") && mainTs.includes("case 'fontFamily'")
    && serverTs.includes('backgroundColor: normalizeUiBackgroundColor') && uiHtml.includes('applyUiAppearance()')
    && uiHtml.includes('settings-background-color') && uiHtml.includes('settings-font-family'),
  'visual preferences: background and font use validated shared persistence plus accessible General settings controls');
  assert(preloadTs.includes('saveConfig: (cfg: string | Record<string, unknown>)'), 'preload: saveConfig accepts structured config patches');
  assert(preloadTs.includes('openGlobalConfig') && preloadTs.includes('reloadGlobalConfig') && preloadTs.includes('readGlobalPrompt') && preloadTs.includes('saveGlobalPrompt'), 'preload: exposes global config open/refresh and Agent.md live-edit bridges');
  assert(mainTs.includes("ipcMain.handle('agent:openGlobalConfig'") && mainTs.includes("ipcMain.handle('agent:reloadGlobalConfig'") && mainTs.includes("ipcMain.handle('agent:readGlobalPrompt'") && mainTs.includes("ipcMain.handle('agent:saveGlobalPrompt'"), 'main ipc: owns global config refresh and bounded Agent.md persistence');
  assert(uiHtml.includes('window.openGlobalConfigFile') && uiHtml.includes('window.refreshGlobalConfigFile') && uiHtml.includes('global-agent-prompt') && uiHtml.includes('window.scheduleGlobalAgentPromptSave'), 'settings UI: provides adjacent config open/refresh controls and live global Agent.md editor');
  assert(uiHtml.includes("raw === 'available' || raw === 'verified'") && uiHtml.includes("raw === 'degraded'") && uiHtml.includes("normalizedStatus === 'degraded'"), 'model settings: verified and degraded validation results remain visibly available instead of rendering as failures');
  assert(preloadTs.includes("getConversationPlan: (conversationId?: string) => ipcRenderer.invoke('agent:getConversationPlan', conversationId)") && preloadTs.includes("updateConversationPlan: (plan: Record<string, unknown>, conversationId?: string) => ipcRenderer.invoke('agent:updateConversationPlan', plan, conversationId)"), 'preload: exposes conversation-bound plan IPC');
  assert(mainTs.includes("language: agent.config.getStr('general', 'language')") && mainTs.includes("case 'language': agent.config.set('general', 'language', value); break;"), 'main ipc: exposes and persists language setting');
  assert(serverTs.includes("language: agent.config.getStr('general', 'language')") && serverTs.includes("case 'language': agent.config.set('general', 'language', value); break;"), 'server api: exposes and persists language setting');
  assert(cliCommandsTs.includes("language: agent.config.getStr('general', 'language') || 'auto'") && cliCommandsTs.includes("const language = argValue(args, '--language')") && cliCommandsTs.includes("[--language auto|en|zh]"), 'cli commands: expose and accept language switching');
  assert(mainTs.includes('sanitizeProvidersForState(agent.config.providers())') && mainTs.includes('agent.updateProviders(value)') && agentTs.includes('mergeProviderSecrets(value, before)'), 'main ipc: redacts provider keys and preserves secrets on provider save');
  assert(mainTs.includes("ipcMain.handle('agent:setProviderEnabled'") && preloadTs.includes('setProviderEnabled:') && uiHtml.includes('window.toggleProviderEnabled') && uiHtml.includes("iconSvg(providerEnabled ? 'power' : 'power-off'"), 'provider settings: expose accessible enable/disable controls while retaining delete separately');
  assert(mainTs.includes('armForcedExitDeadline') && mainTs.includes("requestExplicitExit('tray-exit')") && mainTs.includes("ipcMain.handle('app:exit'") && preloadTs.includes('exitApplication:'), 'application exit: tray and renderer exits share a bounded graceful shutdown that cannot leave a single-instance ghost process');
  assert(packageJson.includes('"release:linux-exit-lifecycle-smoke"') && fs.existsSync(path.join(process.cwd(), 'scripts', 'release-linux-exit-lifecycle-smoke.cjs')), 'release: Linux exit lifecycle smoke is registered for ghost-process and same-root relaunch verification');
  assert(uiHtml.includes("if (p.enabled === false || !p.models || !p.models.length) continue") && uiHtml.includes("if (!confirm(t('model.deleteProviderConfirm')"), 'provider settings: disabled providers are excluded from model selection and permanent deletion remains confirmed');
  assert(serverTs.includes('sanitizeProvidersForState(agent.config.providers())') && serverTs.includes("cfg.section === 'models' && cfg.key === 'providers'") && serverTs.includes('agent.updateProviders(cfg.value)') && !serverTs.includes('jsonResponse(res, agent.config)') && !serverTs.includes("Access-Control-Allow-Origin', '*'") && serverTs.includes("server.listen(PORT, '127.0.0.1'"), 'server api: redacts provider keys, preserves secrets on provider save, disables raw config export, and binds without wildcard CORS');
  assert(mainTs.includes("ipcMain.handle('skills:refresh'") && mainTs.includes('agent.refreshSkills();') && mainTs.includes("ipcMain.handle('skills:addMarketSource'") && mainTs.includes("ipcMain.handle('memoryLab:read'") && mainTs.includes('agent.updateMemoryLab') && mainTs.includes('agent.reindexMemoryLab') && mainTs.includes('terminalInterruptTimeoutMs'), 'main ipc: refreshes skills runtime, manages market sources and Memory Lab through Agent organizer, and returns terminal timeout state');
  assert(mainTs.includes("ipcMain.handle('agent:getConversationPlan', async (_event, conversationId?: string)") && mainTs.includes("ipcMain.handle('agent:updateConversationPlan', async (_event, plan: Record<string, unknown>, conversationId?: string)") && mainTs.includes('conversationPlan: agent.getConversationPlan()'), 'main ipc: exposes and returns conversation-bound plan state');
  assert(mainTs.includes("ipcMain.handle('flow:run'") && mainTs.includes('chatMessages: agent.chatMessages') && mainTs.includes('conversations: agent.listConversationStates()'), 'main ipc: Flow run returns rendered conversation state');
  assert(mainTs.includes("ipcMain.handle('pty:kill'") && mainTs.includes('waitMs === 0') && mainTs.includes("session.proc.kill('SIGINT')"), 'main ipc: terminal interrupt timeout supports unlimited mode');
  assert(mainTs.includes("ipcMain.handle('agentTerminal:takeoverState'") && mainTs.includes("ipcMain.handle('agentTerminal:takeoverWrite'") && mainTs.includes("ipcMain.handle('agentTerminal:takeoverStop'") && mainTs.includes("ipcMain.handle('agentTerminal:takeoverDetach'") && mainTs.includes("webContents.send('agentTerminal:takeover'"), 'main ipc: routes owner-scoped Agent terminal controls and broadcasts takeover events to every desktop window');
  assert(mainTs.includes('function defaultTerminalShell()') && mainTs.includes("process.platform === 'win32' ? 'powershell' : 'bash'") && mainTs.includes('function resolveTerminalShell') && mainTs.includes('commandArgs: command => [\'-lc\', command]') && mainTs.includes('function availableTerminalShells()') && mainTs.includes('terminalShells: availableTerminalShells()') && mainTs.includes('runShellCommand(String(cmd || \'\')') && !mainTs.includes('const SHELL_MAP: Record<string, string>'), 'main ipc: built-in terminal and executeBash use platform-aware shell defaults instead of hard-coded Windows shells');
  assert(serverTs.includes('function runShellCommand') && serverTs.includes("process.platform === 'win32' ? 'powershell' : 'bash'") && serverTs.includes("String(command || cmd || '')") && serverTs.includes('terminalShells: availableTerminalShells()') && serverTs.includes("requested === 'sh' ? ['-c', command]") && !serverTs.includes('powershell.exe -Command "${(cmd||\'\')'), 'server api: bash endpoint is platform-aware and accepts command/cmd payloads');
  assert(uiHtml.includes('function normalizeTerminalShell(shellId)') && uiHtml.includes('function syncTerminalShellOptions()') && uiHtml.includes("spawnTerminal(normalizeTerminalShell(state._terminalShell))") && !uiHtml.includes("spawnTerminal('powershell')") && uiHtml.includes('data-platform-shell="win32"'), 'ui html: bottom terminal defaults to backend platform shell instead of hard-coded PowerShell');
  assert(mainTs.includes("ipcMain.handle('github:copilotLogin'") && mainTs.includes("'auth', 'status'") && mainTs.includes("const tokenFromGh = () =>") && mainTs.includes("const importToken = async (token: string") && mainTs.includes("new LLMProvider('GitHub Copilot', 'https://models.github.ai', token, 'github_models'") && mainTs.includes('.listModels()') && mainTs.includes('catalogModels = listed.length') && mainTs.includes('modelsImported: savedModels') && mainTs.includes('fallbackAdded') && mainTs.includes("'auth', 'refresh', '--scopes', 'models:read'") && !mainTs.includes("'auth', 'refresh', '--web', '--scopes', 'models:read'") && mainTs.includes("'auth', 'login', '--web', '--scopes', 'models:read'") && mainTs.includes("shell.openExternal('https://github.com/login/device')") && mainTs.includes("currentAgent.config.upsertProvider('GitHub Copilot', 'https://models.github.ai'") && mainTs.includes("protocol === 'openai' ? 'openai' : undefined"), 'main ipc: GitHub Copilot login imports GitHub CLI token, reports real catalog models separately from fallback, uses refresh without unsupported --web, falls back to browser login, and fuzzy injection remains openai/anthropic only');
  assert(uiHtml.includes("var modelCount = Number(result.catalogModels || result.modelsImported || 0)") && uiHtml.includes("modelsPanel.innerHTML = renderModelSettings()"), 'ui html: GitHub login reports the real catalog count and redraws the models panel after backend refresh');
  assert(conversationKernelSource.includes('subagents: runtime.runner.subagents.listAll()') && fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'subagent.ts'), 'utf-8').includes("active: record.status !== 'closed'") && uiHtml.includes("t('subagent.empty')"), 'main ipc/ui: closed subagents remain visible as retained history');
  assert(toolsTs.includes('timeout_ms') && toolsTs.includes('resolveBashTimeout') && toolsTs.includes("this.config.getNum('terminal', 'interrupt_timeout_ms')"), 'tools: agent bash accepts per-call timeout and reads config cap');
  assert(toolsTs.includes("t('terminal_takeover'") && toolsTs.includes('runTerminalTakeover') && toolsTs.includes("tool === 'terminal_takeover' && g('action') === 'write'") && toolsTs.includes('terminalTakeoverWorkspaceId') && toolsTs.includes('actorId: context.actorId') && toolsTs.includes("'detach'"), 'tools: terminal_takeover is an owner-scoped persistent shell with bash-grade write guards and detach support');
  assert(toolsTs.includes("t('computer_use'") && toolsTs.includes("'app_observe'") && toolsTs.includes("'takeover_start'") && toolsTs.includes('app_target') && toolsTs.includes('window_handle') && toolsTs.includes("'scroll'") && toolsTs.includes('scroll_x') && toolsTs.includes('runComputerUse') && toolsTs.includes('allowEphemeralVisionImage') && toolsTs.includes("invocation?: 'agent' | 'cli'") && toolsTs.includes('invocation: context.invocation') && cliCommandsTs.includes("invocation: 'cli'") && toolsTs.includes('conversationId?: string') && toolsTs.includes('COMPUTER_USE_LOCK_TTL_MS') && toolsTs.includes('computerUseOwner(context, wsPath)') && toolsTs.includes('ComputerUse is already active') && toolsTs.includes('releaseComputerUseLock(action, owner)') && agentKernelRunnerTs.includes("conversationId: agent.activeConversationId || 'default'") && !toolsTs.includes('archive/computer-use') && agentTs.includes('observe -> decide -> act -> observe') && agentTs.includes('takeover_start') && agentTs.includes('app_list/app_observe/app_*'), 'tools/agent prompt: exposes native Computer Use observe/action loop, takeover border, app scoping, single-conversation lock, and ephemeral-only screenshot handling');
  const computerUseTs = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'computerUse.ts'), 'utf-8');
  const computerUseHostTs = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'computerUsePowerShellHost.ts'), 'utf-8');
  const utilityHostToolRouterTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'utilityHostToolRouter.ts'), 'utf-8');
  assert(toolsTs.includes('capture_max_width') && toolsTs.includes('capture_max_height') && toolsTs.includes('minimum: 320') && toolsTs.includes('minimum: 240') && toolsTs.includes('maximum: 2048') && computerUseTs.includes('DEFAULT_CAPTURE_MAX_WIDTH = 1280') && computerUseTs.includes('DEFAULT_CAPTURE_MAX_HEIGHT = 960') && computerUseTs.includes('MAX_CAPTURE_DIMENSION = 2048') && computerUseTs.includes('[Math]::Min(1.0') && computerUseTs.includes('removeEphemeralScreenshot(outPath)'), 'computer_use: observe and app_observe support bounded variable-size, aspect-preserving, no-upscale ephemeral captures');
  assert(toolsTs.includes('trustedComputerUseContext') && toolsTs.includes('allowEphemeralVisionImage: context.allowEphemeralVisionImage === true') && utilityHostToolRouterTs.includes('trustedComputerUseContext.allowEphemeralVisionImage === true') && !utilityHostToolRouterTs.includes('allowEphemeralVisionImage: args.allow_ephemeral_vision_image === true'), 'computer_use: utility host screenshot retention is granted by trusted runtime context rather than model-authored arguments');
  assert(computerUseTs.includes('System.Windows.Forms') && computerUseTs.includes('CopyFromScreen') && computerUseHostTs.includes('SetCursorPos') && computerUseHostTs.includes('UIAutomationClient') && computerUseTs.includes('CacheRequest') && computerUseTs.includes('BoundingRectangle') && computerUseTs.includes('vision_assist') && computerUseTs.includes('target_id') && computerUseTs.includes('stable_key') && computerUseTs.includes('high_priority_objects') && computerUseTs.includes('intersectionOverUnion') && computerUseTs.includes('normalized_bbox') && computerUseTs.includes('allowed_actions') && computerUseTs.includes('compactSemanticObjects') && computerUseTs.includes('scrollAt') && computerUseTs.includes('executeSequence') && computerUseTs.includes('requires_observe') && computerUseTs.includes('startTakeoverOverlay') && computerUseTs.includes('lastTakeoverOverlayStyle') && computerUseTs.includes('colors: options.gradientColors || options.gradient_colors') && computerUseTs.includes('speed: options.gradientSpeed ?? options.gradient_speed') && computerUseTs.includes('width: options.gradientWidth ?? options.gradient_width') && computerUseTs.includes("options.invocation === 'cli' && durationMs > 0 ? 0 : process.pid") && computerUseTs.includes("const lifecycle = ownerPid > 0 ? 'owner-process-bound' : 'duration-bound'") && computerUseTs.includes('desktop-edge-dynamic-gradient') && computerUseTs.includes('single-click-through-virtual-screen-overlay') && computerUseTs.includes('WS_EX_TRANSPARENT') && !computerUseTs.includes('WS_EX_LAYERED') && !computerUseTs.includes('TransparencyKey') && computerUseTs.includes('public class NewmarkOverlayForm : Form') && computerUseTs.includes('this.DoubleBuffered = true') && computerUseTs.includes('ControlStyles.Opaque') && computerUseTs.includes('OnPaintBackground(PaintEventArgs e)') && computerUseTs.includes('Add-Type -ReferencedAssemblies @("System.Windows.Forms", "System.Drawing") -TypeDefinition') && computerUseTs.includes('$script:brushes') && computerUseTs.includes('$timer.Interval = 33') && computerUseTs.includes('New-Object System.Drawing.Drawing2D.GraphicsPath') && computerUseTs.includes('$regionPath.FillMode = [System.Drawing.Drawing2D.FillMode]::Winding') && computerUseTs.includes('[System.Drawing.Rectangle]::new($bounds.Left, $bounds.Top, $bounds.Width, $bounds.Height)') && computerUseTs.includes('$regionPath.AddRectangle([System.Drawing.Rectangle]::new') && computerUseTs.includes('$script:form.Region = New-Object System.Drawing.Region($regionPath)') && computerUseTs.includes('$perimeter = [Math]::Max(1.0, (2.0 * $w) + (2.0 * $h))') && computerUseTs.includes('$clockwiseOffset = (($script:stopwatch.Elapsed.TotalSeconds / $speedSeconds) * $perimeter) % $perimeter') && computerUseTs.includes('$wrappedDistance = (($distance + ($segment / 2.0)) - $clockwiseOffset) % $perimeter') && computerUseTs.includes('$segment = [Math]::Min($step, $perimeter - $distance)') && computerUseTs.includes('for ($distance = 0.0; $distance -lt $perimeter; $distance += $step)') && computerUseTs.includes('if ($distance -lt $w)') && computerUseTs.includes('elseif ($distance -lt ($w + $h))') && computerUseTs.includes('elseif ($distance -lt ((2.0 * $w) + $h))') && computerUseTs.includes('$ownerTimer = New-Object System.Windows.Forms.Timer') && computerUseTs.includes('Get-Process -Id $script:ownerPid') && computerUseTs.includes('Overlay exited during startup') && computerUseTs.includes('lifecycle') && computerUseTs.includes('$overlayPattern =') && computerUseTs.includes('takeover-overlay-') && computerUseTs.includes('$_.CommandLine -match $overlayPattern') && computerUseTs.includes('$_.ProcessId -ne $selfPid') && computerUseTs.includes('$target.FillRectangle($brush') && !computerUseTs.includes('$script:phase = ($script:phase + 1)') && computerUseTs.includes('[System.Drawing.Color]::FromArgb') && computerUseTs.includes('SetWindowPos($script:form.Handle') && computerUseTs.includes("([wmiclass]'Win32_Process').Create") && computerUseHostTs.includes("spawn('powershell.exe'") && !computerUseTs.includes('spawnSync') && !computerUseTs.includes('Atomics.wait') && computerUseTs.includes('observeAppWindows') && computerUseTs.includes('app_observe') && computerUseTs.includes('app_click') && computerUseTs.includes('NewmarkComputerUseNative') && computerUseTs.includes('tempScreenshotDir') && computerUseTs.includes('screenshot_retention') && computerUseTs.includes('ephemeral-deleted-before-tool-return') && computerUseTs.includes('fs.unlinkSync(outPath)') && toolsTs.includes('gradient_colors) ?') && toolsTs.includes("this.config.get<string[]>('ui', 'gradient_colors')") && toolsTs.includes('gradient_width !== undefined') && toolsTs.includes("this.config.getNum('ui', 'gradient_width')") && !computerUseTs.includes("archive', 'computer-use") && !computerUseTs.includes('github.com/gtt116/enikk') && !computerUseTs.includes('RapidOCR') && !computerUseTs.includes('ultralytics'), 'computer_use: uses persistent async PowerShell lanes, cached UIA, compact semantic results, adaptive sequences, ephemeral screenshots, and a cached 30fps click-through takeover border');
  assert(agentKernelRunnerTs.includes('computerUseVisionImageInput') && agentKernelRunnerTs.includes('sanitizeVisualToolText') && agentKernelRunnerTs.includes('delete parsed.vision_image_path') && agentKernelRunnerTs.includes('delete parsed.vision_image_data_url') && agentKernelRunnerTs.includes('imagePathToOpenAIContentPart') && agentKernelRunnerTs.includes('fs.unlinkSync(imagePath)') && agentKernelRunnerTs.includes('allowEphemeralVisionImage: name === \'computer_use\'') && providerTs.includes('normalizeOpenAIContent') && providerTs.includes('normalizeAnthropicContent') && providerTs.includes('input_image'), 'computer_use: vision-capable direct, utility, and WSL runtimes receive one-use screenshot input synchronized with UI Automation text, strip it from public tool output, and delete filesystem captures after preparation');
  assert(agentTs.includes('Agent terminal timeout: bash accepts per-call timeout_ms') && agentTs.includes('is a nonzero upper cap'), 'agent prompt: discloses bash timeout_ms and settings cap semantics');
  assert(agentTs.includes('repo_security_audit') && agentTs.includes('Remote repository safety') && agentTs.includes('public/private visibility') && agentTs.includes('private URLs, secrets, local runtime state'), 'agent prompt: proactively drives remote repository security and privacy review');
  assert(agentTs.includes('GitHub Copilot') && agentTs.includes('https://models.github.ai'), 'agent core: GitHub Copilot/Models provider is inferred to the official GitHub Models endpoint');
  assert(providerTs.includes("ProviderProtocol = 'openai' | 'anthropic' | 'github_models'") && providerTs.includes("githubModelsUrl('/inference/chat/completions')") && providerTs.includes("githubModelsUrl('/catalog/models')") && providerTs.includes("'X-GitHub-Api-Version': '2022-11-28'"), 'llm provider: GitHub Copilot/Models uses official GitHub Models inference and catalog APIs');
  assert(configTs.includes("github_models") && configTs.includes("models.github.ai") && configTs.includes('defaultProviderBaseUrl') && cliCommandsTs.includes('--protocol openai|anthropic') && !cliCommandsTs.includes('--protocol openai|anthropic|github_models') && agentTs.includes('GitHub/Copilot providers require precise browser login') && cliCommandsTs.includes('GitHub/Copilot providers require precise browser login') && fuzzyTs.includes("value === 'openai' || value === 'anthropic'"), 'config/cli/core: GitHub Models protocol is normalized/defaulted but excluded from fuzzy-inject');
  assert(uiHtml.includes("t('model.githubModelsCompat')") && uiHtml.includes('value="github_models"') && uiHtml.includes('window.githubCopilotLogin') && uiHtml.includes('window.syncProviderProtocolDefaults') && uiHtml.includes('https://models.github.ai') && uiHtml.includes('id="fuzzy-protocol"><option value="auto">') && uiHtml.includes('<option value="anthropic">') && !uiHtml.includes('id="fuzzy-protocol"><option value="auto"><option value="github_models"') && !uiHtml.includes('id="fuzzy-protocol"><option value="auto">' + '<option value="github_models"') && uiHtml.includes("var protocol = protocolEl && protocolEl.value !== 'auto' ? protocolEl.value : undefined;") && uiHtml.includes('window.applyTerminalTakeoverEvent') && uiHtml.includes('data-takeover-session') && uiHtml.includes('terminal-pane active agent-takeover marquee-border'), 'ui html: exposes GitHub Models exact login while excluding GitHub from fuzzy injection');
  assert(uiHtml.includes('window.currentTerminalTakeoverScope') && uiHtml.includes('window.portableTerminalWorkspacePath') && uiHtml.includes('window.terminalTakeoverMatchesCurrent') && uiHtml.includes('session.conversationId') && uiHtml.includes('state.currentWorkspacePath') && uiHtml.includes('if (!currentPath) return false;'), 'terminal takeover UI: filters sessions by hydrated current workspace path and conversation');
  assert(uiHtml.includes("if (payload.type === 'detached') return;") && uiHtml.includes('_terminalTakeoverDetached[session.id]') && uiHtml.includes('terminalTakeoverDetach(takeoverSession, takeoverConversation)') && uiHtml.includes('window.removeTerminalTabDom(tabId)'), 'terminal takeover UI: closing a tab detaches without stopping and detached events do not recreate the pane');
  assert(uiHtml.includes('window.expandBottomForTerminalTakeover') && uiHtml.includes("if (payload.type === 'started') window.expandBottomForTerminalTakeover();") && uiHtml.includes("pane.classList.toggle('marquee-border', active)") && uiHtml.includes("tab.classList.toggle('marquee-border', active)"), 'terminal takeover UI: started events expand the bottom panel and active state owns the dynamic border lifecycle');
  assert(uiHtml.includes('window.stopTerminalTakeover') && uiHtml.includes('api.terminalTakeoverStop(sessionId, conversationId)') && uiHtml.includes("stopButton.style.display = active ? '' : 'none'") && uiHtml.includes('input.disabled = !active'), 'terminal takeover UI: explicit Stop controls active sessions and stopped panes become read-only');
  assert(uiHtml.includes('_terminalTakeoverRefreshToken') && uiHtml.includes('requestedScope.workspacePath !== currentScope.workspacePath') && uiHtml.includes('matching.filter(function(session) { return session.active !== false; })') && uiHtml.includes('.slice(0, 1)') && uiHtml.includes('ended.concat(active)') && uiHtml.includes('window.pruneTerminalTakeoverEndedPanes'), 'terminal takeover UI: stale multi-window refreshes are rejected, only the latest ended session remains visible, and active sessions receive final focus');
  assert(agentTs.includes('refreshSkills(): void') && agentTs.includes('this.skills = new SkillsManager(this.rootPath);'), 'agent core: skills manager can be refreshed without restart');
  assert(agentTs.includes("'- Memory Lab exists and provides persistent memory.'") && !agentTs.includes('Memory Lab stores persistent local memory for Newmark Agent') && agentTs.includes('handleMemoryLabTool') && agentTs.includes('async updateMemoryLab') && agentTs.includes('async reindexMemoryLab'), 'agent core: Memory Lab prompt is only a one-line existence signal and tool gated through Agent organizer');
  assert(cliCommandsTs.includes("command === 'memory-lab'") && cliCommandsTs.includes('await agent.updateMemoryLab') && cliCommandsTs.includes('await agent.reindexMemoryLab'), 'cli commands: memory-lab update and reindex route through Agent organizer');
  assert(cliCommandsTs.includes("command === 'install-update'") && cliCommandsTs.includes('installUpdate({') && cliCommandsTs.includes("pathArgValue(args, '--source')") && cliCommandsTs.includes("pathArgValue(args, '--target')") && cliCommandsTs.includes("pathArgValue(args, '--target-file')") && cliCommandsTs.includes('--expected-version') && cliCommandsTs.includes('--dry-run'), 'cli commands: install-update supports version-checked preserved-data updates and space-containing source/target paths');
  assert(installUpdateTs.includes('assertTargetWritableBeforeCopy') && installUpdateTs.includes('Update target is not writable') && installUpdateTs.includes('Install the MSI or rerun the update with administrator privileges'), 'install update: preflights target writability before copying into protected install directories');
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
  assert(cfg.setProviderEnabled(providers[0].id, false) && cfg.allModels().every(model => model.provider_id !== providers[0].id), 'provider disable: preserves provider while excluding all deployments');
  assert(cfg.setProviderEnabled(providers[0].id, true), 'provider disable: provider can be re-enabled without reconfiguration');
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
  assert(cfg.findModel('gpt-5.5')?.vision === false, 'model config: newly added models remain capability-unvalidated until task validation');

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
  const providerOverrideWs = path.join(bomDir, 'workspace-empty-providers');
  fs.mkdirSync(providerOverrideWs, { recursive: true });
  fs.writeFileSync(path.join(providerOverrideWs, 'config.json'), JSON.stringify({
    models: { providers: { value: [] } },
  }), 'utf-8');
  bomCfg.upsertProvider('GlobalProvider', 'https://global.example/v1', 'global-test-key');
  bomCfg.loadWorkspaceConfig(providerOverrideWs);
  assert(bomCfg.providers().some(p => p.name === 'GlobalProvider'), 'workspace config: empty providers cannot hide user-level providers');
  assert(bomCfg.addModelToProvider('GlobalProvider', 'global-model', 'Global Model', 'User-level catalog model'), 'workspace config: model import updates the user-level provider');
  bomCfg.save();
  const persistedGlobalProvider = new ConfigManager(bomDir).providers().find(p => p.name === 'GlobalProvider');
  assert(persistedGlobalProvider?.models.some(m => m.name === 'global-model') === true, 'workspace config: imported provider models persist globally');
  const layoutOverrideWs = path.join(bomDir, 'workspace-layout-overrides');
  fs.mkdirSync(layoutOverrideWs, { recursive: true });
  bomCfg.set('ui', 'left_panel_collapsed', false);
  bomCfg.set('ui', 'right_panel_collapsed', true);
  bomCfg.set('ui', 'bottom_panel_collapsed', false);
  bomCfg.set('ui', 'secondary_panel_collapsed', false);
  fs.writeFileSync(path.join(layoutOverrideWs, 'config.json'), JSON.stringify({
    ui: {
      left_panel_collapsed: { value: true },
      right_panel_collapsed: { value: false },
      bottom_panel_collapsed: { value: true },
      secondary_panel_collapsed: { value: true },
    },
  }), 'utf-8');
  bomCfg.loadWorkspaceConfig(layoutOverrideWs);
  assert(
    bomCfg.getBool('ui', 'left_panel_collapsed') === false
      && bomCfg.getBool('ui', 'right_panel_collapsed') === true
      && bomCfg.getBool('ui', 'bottom_panel_collapsed') === false
      && bomCfg.getBool('ui', 'secondary_panel_collapsed') === false,
    'workspace config: stale layout values cannot override user-level panel state',
  );
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
    assert(computerLinuxUnsupported.includes('[tool unsupported]') && computerLinuxUnsupported.includes('linux'), 'computer_use: Linux reports explicit unsupported native desktop control instead of crashing');
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
  assert(auditSource.includes("runAsyncProcess('git', args") && auditSource.includes("spawnTool('gh', args") && !auditSource.includes("spawnSync('git', args"), 'git/github tools: use cancellable asynchronous spawn with native argument arrays');
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
  assert(pushSource.includes("case 'git_push': return await this.withRemoteSecurityPreamble") && pushSource.includes("case 'gh_pr_create': return await this.withRemoteSecurityPreamble") && pushSource.includes('action: () => Promise<string>') && pushSource.indexOf('const actionOutput = await action();') > pushSource.indexOf('await this.repoSecurityAudit('), 'repo_security_audit: git_push and gh_pr_create defer their write actions until the remote safety preflight completes');
  const remoteWriteTools = new ToolExecutor(TEST_DIR, cfg) as any;
  const remoteWriteOrder: string[] = [];
  remoteWriteTools.findGitRoot = async () => auditRepo;
  remoteWriteTools.gitExecAt = async () => 'origin\thttps://github.com/example/public-audit.git (fetch)';
  remoteWriteTools.repoSecurityAudit = async () => {
    remoteWriteOrder.push('audit');
    return JSON.stringify({
      remote: { provider: 'github', repository: 'example/public-audit' },
      security_review: { verdict: 'review', risks: [], secret_findings: [], release_excluded_local_files: [] },
    });
  };
  remoteWriteTools.gpush = async () => { remoteWriteOrder.push('git_push'); return '[git push] complete'; };
  remoteWriteTools.ghPrCreate = async () => { remoteWriteOrder.push('gh_pr_create'); return '[gh pr create] complete'; };
  const orderedPush = await remoteWriteTools.execute('git_push', '{"message":"ordered preflight"}', auditRepo);
  assert(remoteWriteOrder.join(',') === 'audit,git_push' && orderedPush.startsWith('[repo_security_audit]'), 'repo_security_audit: git_push executes only after the preflight summary is ready');
  remoteWriteOrder.length = 0;
  const orderedPr = await remoteWriteTools.execute('gh_pr_create', '{"title":"ordered","body":"preflight"}', auditRepo);
  assert(remoteWriteOrder.join(',') === 'audit,gh_pr_create' && orderedPr.startsWith('[repo_security_audit]'), 'repo_security_audit: gh_pr_create executes only after the preflight summary is ready');
  remoteWriteOrder.length = 0;
  remoteWriteTools.repoSecurityAudit = async () => { remoteWriteOrder.push('audit_error'); throw new Error('planned audit failure'); };
  const fallbackPush = await remoteWriteTools.execute('git_push', '{"message":"fallback preflight"}', auditRepo);
  assert(remoteWriteOrder.join(',') === 'audit_error,git_push' && fallbackPush.includes('Remote repository safety review should be considered') && fallbackPush.includes('[git push] complete'), 'repo_security_audit: an unavailable summary preserves the established nonblocking remote-write behavior and reports a generic warning');
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
  assert(qDisabled.includes('[permission]') && qDisabled.includes('disabled'), 'question: fully autonomous disables options');
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
  assert(planWriteDenied.includes('[permission]'), 'plan permissions: blocks arbitrary writes');
  const planReadmeDenied = await tools.execute('write', '{"path":"README.md","content":"plan blocked"}', TEST_DIR, { mode: 'plan', workspacePath: TEST_DIR });
  assert(planReadmeDenied.includes('[permission]'), 'plan permissions: blocks README writes');
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
  assert(tools.definitions().some((tool: any) => tool.function?.name === 'computer_use') === (process.platform === 'win32'), 'definitions: exposes native computer_use desktop tool only on a Windows-capable host');
  const buildComputerUse = tools.definitions().find((tool: any) => tool.function?.name === 'computer_use') as any;
  assert(process.platform !== 'win32' || (buildComputerUse?.function?.parameters?.properties?.capture_max_width?.maximum === 2048 && buildComputerUse?.function?.parameters?.properties?.capture_max_height?.maximum === 2048 && !buildComputerUse?.function?.parameters?.properties?.allow_ephemeral_vision_image), 'definitions: Computer Use exposes bounded capture dimensions but no model-controlled retention permission when available');
  assert(tools.definitions().some((tool: any) => tool.function?.name === 'image_inspect') && tools.definitions('plan').some((tool: any) => tool.function?.name === 'image_inspect'), 'definitions: exposes read-only image_inspect in Build and Plan modes');
  assert(tools.definitions('plan').some((tool: any) => tool.function?.name === 'browser_snapshot'), 'definitions: plan exposes browser_snapshot');
  assert(!tools.definitions('plan').some((tool: any) => tool.function?.name === 'browser_click'), 'definitions: plan hides browser_click');
  const planComputerUse = tools.definitions('plan').find((tool: any) => tool.function?.name === 'computer_use') as any;
  assert(process.platform !== 'win32' || (JSON.stringify(planComputerUse?.function?.parameters?.properties?.action?.enum) === JSON.stringify(['observe', 'app_list', 'app_observe']) && !!planComputerUse.function.parameters.properties.capture_max_width && !!planComputerUse.function.parameters.properties.capture_max_height && !planComputerUse.function.parameters.properties.x && !planComputerUse.function.parameters.properties.steps), 'definitions: Plan exposes only observation-class Computer Use schema, including bounded capture dimensions when available');
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
  assert(planBrowserClick.includes('[permission]'), 'browser control: Plan mode blocks mutating browser_click execution');
  const planBrowserType = await tools.execute('browser_type', JSON.stringify({ selector: '#q', text: 'blocked' }), TEST_DIR, { mode: 'plan', workspacePath: TEST_DIR });
  assert(planBrowserType.includes('[permission]'), 'browser control: Plan mode blocks mutating browser_type execution');
  const planBrowserEval = await tools.execute('browser_eval', JSON.stringify({ script: 'location.href' }), TEST_DIR, { mode: 'plan', workspacePath: TEST_DIR });
  assert(planBrowserEval.includes('[permission]'), 'browser control: Plan mode blocks browser_eval execution');
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
  process.exitCode = 0;
  const cliBadJsonOut = await captureStdout(() => runCliCommand(TEST_DIR, ['tool', 'write', '{bad-json', '--root', TEST_DIR]));
  const cliBadJson = JSON.parse(cliBadJsonOut);
  assert(cliBadJson.ok === false && cliBadJson.tool === 'write' && String(cliBadJson.error || '').includes('Invalid JSON object') && process.exitCode === 2, 'cli tool: invalid JSON uses the common validation envelope and exit 2');
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
  const originalAgentFuzzyInject = Agent.prototype.fuzzyInject;
  const restoreCliValidationProviderFixture = installValidationProviderFixture({
    validModels: new Set(['gpt-test', 'gpt-5.5', 'cli-fast', 'claude-cli', 'env-claude', 'cli-noguide-fast']),
    visionModels: new Set(['gpt-5.5']),
    catalogs: {
      'api.test.com': ['gpt-test', 'gpt-5.5'],
      'cli-nebula.local': ['cli-fast', 'cli-pro'],
      'cli-anthropic.local': ['claude-cli'],
      'api.cli-noguide.test': ['cli-noguide-fast'],
      'cli-env-anthropic.local': ['env-claude'],
    },
  });
  try {
    const cliValidateOut = await captureStdout(() => runCliCommand(TEST_DIR, ['validate-models', '--selected', 'test-prov/gpt-test', '--root', TEST_DIR]));
    const cliValidate = JSON.parse(cliValidateOut);
    assert(Array.isArray(cliValidate) && cliValidate.some((r: any) => r.name === 'test-prov/gpt-test' && r.status === 'verified'), 'cli validate-models: records selected model only after Standard probes pass');
    assert(!cliValidateOut.includes('test-key-123') && !cliValidateOut.includes('test-key-456'), 'cli validate-models: redacts provider API keys');
    new ConfigManager(TEST_DIR).updateModel('test-prov', 'gpt-5.5', { vision: false, description: 'CLI stale text-only validation metadata' });
    const cliVisionValidateOut = await captureStdout(() => runCliCommand(TEST_DIR, ['validate-models', '--selected', 'test-prov/gpt-5.5', '--root', TEST_DIR]));
    const cliVisionValidate = JSON.parse(cliVisionValidateOut);
    const cliVisionModel = new ConfigManager(TEST_DIR).findModel('gpt-5.5');
    assert(Array.isArray(cliVisionValidate) && cliVisionValidate.some((r: any) => r.name === 'test-prov/gpt-5.5' && r.vision_input === true), 'cli validate-models: confirms GPT-5.5 vision input through a vision task probe');
    assert(cliVisionModel?.vision === true && cliVisionModel?.evaluation?.vision_input === true, 'cli validate-models: persists task-confirmed GPT-5.5 vision capability');
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
    process.env.NEWMARK_TEST_CLI_NOGUIDE_ENDPOINT = 'https://api.cli-noguide.test/v1/chat/completions';
    process.env.NEWMARK_TEST_CLI_NOGUIDE_KEY = 'sk-cli-noguide-redacted-12345678901234567890';
    const cliNoGuideRoot = path.join(TEST_DIR, 'cli-fuzzy-empty-root');
    const cliNoGuideOut = await captureStdout(() => runCliCommand(cliNoGuideRoot, ['fuzzy-inject', '--endpoint-env', 'NEWMARK_TEST_CLI_NOGUIDE_ENDPOINT', '--key-env', 'NEWMARK_TEST_CLI_NOGUIDE_KEY', '--root', cliNoGuideRoot]));
    const cliNoGuide = JSON.parse(cliNoGuideOut);
    const cliNoGuideProvider = new ConfigManager(cliNoGuideRoot).providers().find(p => p.name === 'CliNoguide');
    assert(cliNoGuide.ok === true && cliNoGuide.provider === 'CliNoguide' && cliNoGuide.models.includes('cli-noguide-fast'), 'cli fuzzy-inject: no-guide tokenizer infers provider and imports /models result');
    assert(cliNoGuideProvider?.base_url === 'https://api.cli-noguide.test/v1' && !cliNoGuideOut.includes('sk-cli-noguide-redacted'), 'cli fuzzy-inject: no-guide path normalizes endpoint and redacts key');
    globalThis.fetch = originalCliFetch;
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
    assert(cliBadEnvFuzzy.warning.includes('none validated as available') && cliBadEnvFuzzy.warning.includes('bad-env-claude: invalid_config') && cliBadEnvFuzzy.warning.includes('Discovery:'), 'cli fuzzy-inject: failed Standard validation warning includes classified model status and discovery context');
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
    restoreCliValidationProviderFixture();
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
    tags: ['#数学', '#物理/理论物理', '#Agent-Skill'],
    content: '# Theory Skill\n\nUse rigorous derivations.',
    kind: 'folder',
  }));
  assert(memoryUpdate.ok === true && !!memoryUpdate.slug && fs.existsSync(memoryUpdate.component?.coreMd || ''), 'memory lab: writes folder memory component core markdown');
  const memoryIndex = memoryUpdate.index;
  assert(memoryIndex.version === 2 && !!memoryIndex.tags['#物理'] && memoryIndex.tags['#物理'].children.includes('#理论物理'), 'memory lab: migrates legacy slash paths into independent v2 nodes');
  assert(memoryIndex.tags['#理论物理'].parents.includes('#物理') && memoryIndex.tags['#理论物理'].components.includes(memoryUpdate.slug || ''), 'memory lab: links component only to the terminal independent tag');
  assert(memoryIndex.tags['#数学'].components.includes(memoryUpdate.slug || '') && memoryIndex.tags['#Agent-Skill'].components.includes(memoryUpdate.slug || ''), 'memory lab: links independent and legacy-migrated terminal tags while preserving hyphenated tag names');
  const readComponent = memoryLab.read(memoryUpdate.slug || '');
  assert(readComponent.ok === true && readComponent.component?.content.includes('rigorous derivations'), 'memory lab: reads component core markdown by slug');
  const duplicateTagUpdate = memoryLab.update(memoryLab.prepareUpdate({
    name: '用于分析理论物理与数学的Skill',
    description: 'Updated description.',
    tags: ['物理/理论物理', '#物理/理论物理', '#数学'],
    content: '# Theory Skill\n\nUpdated content.',
    kind: 'file',
  }));
  assert(duplicateTagUpdate.index.tags['#理论物理'].components.filter((slug: string) => slug === duplicateTagUpdate.slug).length === 1, 'memory lab: reuses migrated tags and avoids duplicate component links');
  const reindexedMemory = memoryLab.reindex();
  assert(reindexedMemory.ok === true && reindexedMemory.index.tags['#物理'].children.includes('#理论物理'), 'memory lab: reindex preserves repaired tag graph');
  const malformedLegacyIndex = memoryLab.normalizeIndex({
    version: 2,
    updatedAt: new Date().toISOString(),
    tags: {
      '#用户画像/专业方向/理论物理/弦论': { parents: [], children: [], components: ['legacy-result'], aliases: [] },
      '#research/downloads': { parents: [], children: [], components: ['legacy-result'], aliases: [] },
    },
    components: {
      'legacy-result': {
        name: 'legacy-result', description: '',
        tags: ['#用户画像/专业方向/理论物理/弦论', '#research/downloads'],
        tagPaths: [['#用户画像/专业方向/理论物理/弦论'], ['#research/downloads']],
        path: path.join(memoryLab.componentsDir, 'legacy-result.md'), coreMd: path.join(memoryLab.componentsDir, 'legacy-result.md'),
        kind: 'file', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    },
  }).index;
  assert(Object.keys(malformedLegacyIndex.tags).every(tag => !tag.includes('/')) && malformedLegacyIndex.tags['#用户画像'].children.includes('#专业方向') && malformedLegacyIndex.tags['#专业方向'].children.includes('#理论物理') && malformedLegacyIndex.tags['#理论物理'].children.includes('#弦论') && malformedLegacyIndex.tags['#research'].children.includes('#downloads'), 'memory lab: reindex inspects final v2 tag names and splits slash paths found inside legacy tags and single-node tagPaths');
  assert(malformedLegacyIndex.components['legacy-result'].tags.every(tag => !tag.includes('/')) && malformedLegacyIndex.components['legacy-result'].tagPaths.flat().every(tag => !tag.includes('/')), 'memory lab: rebuilt component metadata contains no slash-bearing tag results');
  const multiParentMemory = memoryLab.update(memoryLab.prepareUpdate({
    name: 'multi-parent-memory',
    description: 'Tag DAG test.',
    tags: ['#理论物理'],
    tagPaths: [['#物理', '#理论物理'], ['#数学', '#理论物理']],
    content: '# Multi parent',
  }));
  assert(multiParentMemory.index.tags['#理论物理'].parents.includes('#物理') && multiParentMemory.index.tags['#理论物理'].parents.includes('#数学'), 'memory lab: one independent tag supports multiple parents');
  const literalHyphenMemory = memoryLab.update(memoryLab.prepareUpdate({
    name: 'literal-hyphen-memory',
    description: 'Literal hyphen tag test.',
    tags: [],
    tagPaths: [['#Agent-Skill']],
    content: '# Literal hyphen',
  }));
  assert(literalHyphenMemory.index.tags['#Agent-Skill'].components.includes(literalHyphenMemory.slug || ''), 'memory lab: single-node tagPaths preserves a literal hyphenated tag name');
  const legacyDirectionMemory = memoryLab.update(memoryLab.prepareUpdate({
    name: 'legacy-direction-tag',
    tags: ['#父tag:物理 -> 子tag:理论物理'],
    content: 'legacy direction migration',
  }));
  assert(legacyDirectionMemory.index.tags['#物理'].children.includes('#理论物理') && !legacyDirectionMemory.index.tags['#父tag:物理 -> 子tag:理论物理'], 'memory lab: rebuild migrates legacy parent/child direction wording into independent nodes and edges');
  memoryLab.setPreferredLanguage('en');
  const synonymIndex = memoryLab.normalizeIndex({
    version: 2,
    updatedAt: new Date().toISOString(),
    preferredLanguage: 'en',
    tags: {
      '#Physics': { parents: [], children: [], components: [], aliases: ['#物理'] },
      '#物理': { parents: [], children: [], components: [], aliases: ['#Physics'] },
    },
    components: {
      bilingual: {
        name: 'bilingual', description: '', tags: ['#Physics', '#物理'], tagPaths: [['#Physics']],
        path: path.join(memoryLab.componentsDir, 'bilingual.md'), coreMd: path.join(memoryLab.componentsDir, 'bilingual.md'),
        kind: 'file', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    },
  });
  assert(!!synonymIndex.index.tags['#Physics'] && synonymIndex.index.tags['#Physics'].aliases.includes('#物理') && !synonymIndex.index.tags['#物理'], 'memory lab: English user language merges bilingual synonyms under the English primary name');
  memoryLab.setPreferredLanguage('zh');
  const chineseSynonymIndex = memoryLab.normalizeIndex(synonymIndex.index);
  assert(!!chineseSynonymIndex.index.tags['#物理'] && chineseSynonymIndex.index.tags['#物理'].aliases.includes('#Physics') && !chineseSynonymIndex.index.tags['#Physics'], 'memory lab: language switch updates the primary tag name while preserving aliases');
  let cyclicTagBlocked = false;
  try { memoryLab.prepareUpdate({ name: 'cycle', tags: ['#A'], tagPaths: [['#A', '#B', '#A']], content: 'bad' }); } catch { cyclicTagBlocked = true; }
  assert(cyclicTagBlocked, 'memory lab: rejects cyclic tag paths on new writes');
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
  const readonlyTarget = path.join(TEST_DIR, 'readonly-target');
  fs.writeFileSync(readonlyTarget, 'not a writable directory', 'utf-8');
  const updateReadonlyFail = installUpdate({ source: updateSource, target: readonlyTarget, expectedVersion: currentAppVersion() });
  assert(updateReadonlyFail.ok === false && updateReadonlyFail.copied.length === 0 && String(updateReadonlyFail.error || '').includes('Update target is not writable'), 'install update: fails before partial copy when target is not writable');
  const cliInstallVersionOut = await captureStdout(() => runCliCommand(TEST_DIR, ['install-update', '--version', '--root', TEST_DIR]));
  const cliInstallVersion = JSON.parse(cliInstallVersionOut);
  assert(cliInstallVersion.ok === true && cliInstallVersion.version === currentAppVersion(), 'cli install-update: reports current version');
  const cliInstallDryRunOut = await captureStdout(() => runCliCommand(TEST_DIR, ['install-update', '--source', updateSource, '--target', updateTarget, '--expected-version', currentAppVersion(), '--dry-run', '--root', TEST_DIR]));
  const cliInstallDryRun = JSON.parse(cliInstallDryRunOut);
  assert(cliInstallDryRun.ok === true && cliInstallDryRun.dryRun === true && cliInstallDryRun.preserved.includes('config.json'), 'cli install-update: dry-run preserves local state');
  const updateSourceWithSpaces = path.join(TEST_DIR, 'update source with spaces');
  const updateTargetWithSpaces = path.join(TEST_DIR, 'update target with spaces');
  fs.mkdirSync(path.join(updateSourceWithSpaces, 'resources'), { recursive: true });
  fs.mkdirSync(path.join(updateTargetWithSpaces, 'Work'), { recursive: true });
  fs.writeFileSync(path.join(updateSourceWithSpaces, 'Newmark Agent.exe'), 'space path binary', 'utf-8');
  fs.writeFileSync(path.join(updateTargetWithSpaces, 'config.json'), 'space target config', 'utf-8');
  const splitPathArgs = ['install-update', '--source', ...updateSourceWithSpaces.split(' '), '--target', ...updateTargetWithSpaces.split(' '), '--expected-version', currentAppVersion(), '--dry-run', '--root', TEST_DIR];
  const cliInstallSpacePathOut = await captureStdout(() => runCliCommand(TEST_DIR, splitPathArgs));
  const cliInstallSpacePath = JSON.parse(cliInstallSpacePathOut);
  assert(cliInstallSpacePath.ok === true && cliInstallSpacePath.source === updateSourceWithSpaces && cliInstallSpacePath.target === updateTargetWithSpaces && cliInstallSpacePath.dryRun === true, 'cli install-update: reconstructs source and target paths split by Start-Process ArgumentList');
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
  externalTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-external-unique-'));
  const extBase = externalTestDir;
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
  assert(sub?.natureSlug === 'test-sub' && /^test-sub-[0-9a-f]{8}--[0-9a-f-]{36}$/.test(sub.name), 'get: nature plus short and full UUID name');
  assert(sub?.status === 'working', 'get: status working');

  const sent = subMgr.send(subId, 'Continue work');
  assert(sent === true && sub?.messages.length === 3, 'send: adds message');

  subMgr.complete(subId, 'Subagent completed result');
  assert(sub?.status === 'completed', 'complete: marks completed');
  assert(subMgr.getResult(subId).includes('completed result'), 'complete: stores result');
  const subRecord = subMgr.toRecord(subId);
  assert(subRecord?.active === true && subRecord.mode === 'build' && !!subRecord.startedAt && !!subRecord.completedAt && subRecord.conversationId === 'default', 'subagent compat: record exposes stable structured fields');
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
  taskAgent.subagents.reset();
  const subProvider = new FakeProvider(['subagent first result', 'subagent continued result']);
  (taskAgent as unknown as { engineModel: () => FakeProvider }).engineModel = () => subProvider;
  const createdSub = await (taskAgent as unknown as { handleSubagent: (args: string) => Promise<string> })
    .handleSubagent(JSON.stringify({ name: 'worker', prompt: 'Do delegated work', model: 'test-model', input_mode: 'next', mode: 'plan' }));
  const worker = taskAgent.subagents.get('worker');
  assert(createdSub.includes('subagent first result') && createdSub.includes('[Subagent accepted]'), 'Agent task compatibility: accepts immediately then awaits peer result for direct API callers');
  assert(worker?.status === 'completed', 'Agent task: completed status recorded');
  assert(worker?.model === 'test-model' && worker?.inputMode === 'next' && worker?.agentMode === 'plan', 'Agent task: preserves requested model/input/mode');
  const continuedSub = await (taskAgent as unknown as { handleSubagentContinue: (args: string) => Promise<string> })
    .handleSubagentContinue(JSON.stringify({ name: 'worker', prompt: 'Continue delegated work' }));
  assert(continuedSub.includes('subagent continued result'), 'Agent subagent_send: continues existing subagent');
  const subRead = taskAgent.handleSubagentReadEnvelope(JSON.stringify({ name: 'worker', max_chars: 8000 }));
  assert(subRead.ok === true && subRead.output.includes('subagent continued result') && subRead.output.includes('mailbox'), 'Agent subagent_read: returns bounded status, feedback, result, and mailbox summary');
  assert(fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'subagent.ts'), 'utf-8').includes('replaceContext') && fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agent.ts'), 'utf-8').includes('subagentContextPersist'), 'Agent subagent context: compressed history and metadata persist back to the peer record');
  assert(fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agent.ts'), 'utf-8').includes('this.notifyAgentKernelUserMessageStart(text, clientMessageId || undefined);') && fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agent.ts'), 'utf-8').includes("return this.queueActiveKernelMessage(prompt, 'followUp')") && fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'conversationKernel.ts'), 'utf-8').includes("runtime.pendingNextTurn.push({ message, queueMode: 'followUp' });"), 'Agent subagent result delivery: initial process boundaries acknowledge persisted inbox messages and conversation-owned routing appends one next turn without feedback loops');
  const subResult = (taskAgent as unknown as { handleSubagentResult: (args: string) => string })
    .handleSubagentResult(JSON.stringify({ name: 'worker' }));
  assert(subResult.includes('get.subagent("') && subResult.includes('subagent continued result'), 'Agent subagent_result: returns result and transcript');
  const closeSub = (taskAgent as unknown as { handleSubagentClose: (args: string) => string })
    .handleSubagentClose(JSON.stringify({ name: 'worker' }));
  assert(closeSub.includes('closed') && taskAgent.subagents.get('worker')?.status === 'closed', 'Agent subagent_close: closes subagent');
  const workerRecord = taskAgent.subagents.toRecord('worker');
  assert(workerRecord?.active === false && !!workerRecord.closedAt && !!workerRecord.result?.includes('subagent continued result'), 'Agent subagent compat: retained closed record has result and closedAt');

  const subagentToolFile = path.join(taskAgent.workspace.current?.path || TEST_DIR, 'subagent-tool.txt');
  taskAgent.config.addModelToProvider('test-prov', 'fixed-child-model', 'Fixed Child Model', 'Registered deterministic subagent fixture model');
  taskAgent.setModel('fixed-child-model');
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
  assert(fs.existsSync(subagentToolFile) && fs.readFileSync(subagentToolFile, 'utf-8') === 'from isolated subagent', 'Agent task sandbox: tool writes into active workspace');
  assert(toolSub.includes('subagent used write tool'), 'Agent task sandbox: returns child agent result');
  assert(toolProvider.modelsSeen.every(m => m === 'fixed-child-model'), 'Agent task sandbox: uses parent-assigned fixed model', JSON.stringify(toolProvider.modelsSeen));

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
  for (let skillIndex = 0; skillIndex < 105; skillIndex++) {
    const name = `bulk-skill-${skillIndex}`;
    const dir = path.join(TEST_DIR, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${skillIndex === 77 ? 'Special frontend regression workflow' : 'Generic bulk fixture'}\n---\n# ${name}`);
  }
  const bulkSkills = new SkillsManager(TEST_DIR);
  assert(bulkSkills.search('frontend regression', 8)[0]?.name === 'bulk-skill-77' && bulkSkills.search('frontend regression', 8).length <= 8, 'skills: large catalogs return a bounded relevant metadata shortlist');
  assert(bulkSkills.load('bulk-skill-77')?.content.includes('Special frontend regression workflow'), 'skills: exact load returns one selected SKILL.md body on demand');
  const digestSkillPath = path.join(TEST_DIR, 'skills', 'bulk-skill-77', 'SKILL.md');
  const digestSkillBefore = '---\nname: bulk-skill-77\ndescription: Special frontend regression workflow\n---\n# bulk-skill-77';
  fs.writeFileSync(digestSkillPath, digestSkillBefore, 'utf-8');
  const digestSkillStat = fs.statSync(digestSkillPath);
  bulkSkills.search('frontend regression', 8);
  const digestSkillAfter = digestSkillBefore.replace('Special frontend regression workflow', 'Updated frontend regression workflow');
  assert(Buffer.byteLength(digestSkillBefore) === Buffer.byteLength(digestSkillAfter), 'skills: digest invalidation fixture preserves file size');
  fs.writeFileSync(digestSkillPath, digestSkillAfter, 'utf-8');
  fs.utimesSync(digestSkillPath, digestSkillStat.atime, digestSkillStat.mtime);
  assert(bulkSkills.search('updated frontend', 8)[0]?.name === 'bulk-skill-77', 'skills: content digest invalidates cached metadata even when mtime and size are unchanged');
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
  assert(!skMgr2.has('test-skill') && !skMgr2.has('local-copy-skill'), 'remove: selected skills deleted without affecting the large catalog fixture');

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
  const completedSummaryRun = agent.beginConversationWorkRun('completed-summary-run', { workspaceId: 'summary-workspace', conversationId: 'default' });
  agent.finishConversationWorkRun(completedSummaryRun.runId, 'completed');
  assert(completedSummaryRun.events.filter(event => event.type === 'final_response').length === 1
    && agent.chatMessages.filter(message => message.role === 'assistant' && message.runId === completedSummaryRun.runId).length === 1,
  'Build completion: a normally completed run always persists exactly one final result');
  const failedSummaryRun = agent.beginConversationWorkRun('failed-summary-run', { workspaceId: 'summary-workspace', conversationId: 'default' });
  agent.finishConversationWorkRun(failedSummaryRun.runId, 'error');
  assert(failedSummaryRun.events.every(event => event.type !== 'final_response')
    && !agent.chatMessages.some(message => message.role === 'assistant' && message.runId === failedSummaryRun.runId),
  'Build completion: failed runs do not synthesize a final result summary');
  const interruptedSummaryRun = agent.beginConversationWorkRun('interrupted-summary-run', { workspaceId: 'summary-workspace', conversationId: 'default' });
  agent.finishConversationWorkRun(interruptedSummaryRun.runId, 'interrupted');
  assert(interruptedSummaryRun.events.every(event => event.type !== 'final_response')
    && !agent.chatMessages.some(message => message.role === 'assistant' && message.runId === interruptedSummaryRun.runId),
  'Build completion: interrupted runs do not synthesize a final result summary');
  const crashedRun = agent.beginConversationWorkRun('crashed-reload-run', { workspaceId: 'summary-workspace', conversationId: 'default' }, '2026-07-19T10:00:00.000Z');
  // @ts-expect-error exercising the persisted-state recovery boundary
  const recoveredRuns = agent.recoverPersistedWorkRuns([crashedRun], '2026-07-19T10:05:00.000Z');
  assert(recoveredRuns.changed && recoveredRuns.runs[0]?.status === 'interrupted'
    && recoveredRuns.runs[0]?.endedAt === '2026-07-19T10:05:00.000Z',
  'Build recovery: a persisted running run becomes interrupted at the last persisted update so its timer cannot grow after restart');

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
  scopedAgentReloaded.ensureConversationSnapshot('empty-new-conversation');
  scopedAgentReloaded.persistActiveConversationSelection('empty-new-conversation');
  const emptyConversationReloaded = new Agent(TEST_DIR);
  assert(emptyConversationReloaded.activeConversationId === 'empty-new-conversation'
    && emptyConversationReloaded.chatMessages.length === 0
    && emptyConversationReloaded.listConversationStates().some(c => c.id === 'empty-new-conversation'),
  'conversation activation: a newly created empty conversation remains selected and visible after restart');
  emptyConversationReloaded.persistActiveConversationSelection('conv-two');
  scopedAgentReloaded.setConversationFromStorage('conv-two');
  scopedAgentReloaded.chatMessages = [
    { role: 'user', content: 'keep prompt', mode: 'Build', model: scopedAgentReloaded.model, timestamp: 'rw1' },
    { role: 'assistant', content: 'keep reply', mode: 'Build', model: scopedAgentReloaded.model, timestamp: 'rw2' },
    { role: 'user', content: 'edit prompt', mode: 'Build', model: scopedAgentReloaded.model, timestamp: 'rw3' },
    { role: 'assistant', content: 'remove reply', mode: 'Build', model: scopedAgentReloaded.model, timestamp: 'rw4' },
  ];
  scopedAgentReloaded.history = [
    { role: 'user', content: 'keep prompt' },
    { role: 'assistant', content: 'keep reply' },
    { role: 'user', content: 'edit prompt' },
    { role: 'assistant', content: 'remove reply' },
  ];
  scopedAgentReloaded.retainConversationContinuations([{
    content: 'stale follow-up from removed branch',
    queueMode: 'followUp',
    clientMessageId: 'rewind-stale-continuation',
  }]);
  scopedAgentReloaded.saveWorkspaceConversationState();
  const rewound = scopedAgentReloaded.rewindConversation('conv-two', 2);
  assert(rewound.chatMessages.length === 2 && rewound.chatMessages[0]?.content === 'keep prompt' && scopedAgentReloaded.history.length === 2, 'conversation rewind: removes the edited user node and all later display/model history');
  assert(rewound.continuations.length === 0 && scopedAgentReloaded.conversationContinuations().length === 0, 'conversation rewind: clears continuations from the removed branch');
  const rewindRoot = scopedAgentReloaded.rootPath;
  const rewoundReloaded = new Agent(rewindRoot);
  rewoundReloaded.workspace.select(scopedAgentReloaded.workspace.current?.name || '');
  rewoundReloaded.setConversation('conv-two');
  assert(rewoundReloaded.chatMessages.length === 2 && rewoundReloaded.chatMessages[1]?.content === 'keep reply', 'conversation rewind: persists the retained prefix across restart');
  assert(rewoundReloaded.conversationContinuations().length === 0, 'conversation rewind: stale continuations stay cleared across restart');
  let rewindRejected = false;
  try { scopedAgentReloaded.rewindConversation('conv-two', 1); } catch { rewindRejected = true; }
  assert(rewindRejected, 'conversation rewind: rejects assistant nodes as edit targets');
  scopedAgentReloaded.setConversation('mirror-active');
  const mirroredSource: Parameters<Agent['mirrorConversationStateFrom']>[1] = {
    chatMessages: [{ role: 'user' as const, content: 'runner-owned message', mode: 'Build', model: scopedAgentReloaded.model, timestamp: 'tm' }],
    history: [{ role: 'user' as const, content: 'runner-owned history' }],
    conversationPlan: { items: [{ id: 'mirror-plan', text: 'runner-owned plan', status: 'done' as const }] },
  };
  scopedAgentReloaded.mirrorConversationStateFrom('mirror-active', mirroredSource);
  scopedAgentReloaded.setConversation('mirror-active');
  assert(scopedAgentReloaded.chatMessages[0]?.content === 'runner-owned message' && String(scopedAgentReloaded.history[0]?.content) === 'runner-owned history', 'conversation mirror: active host memory cannot overwrite completed runner messages');
  assert(scopedAgentReloaded.getConversationPlan().items[0]?.id === 'mirror-plan', 'conversation mirror: active host memory preserves completed runner plan');
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
  pureAgent.setModel('pure-agent-test-model');
  const pureProvider = new FakeProvider(['PURE_AGENT_NO_WORKSPACE_OK']);
  (pureAgent as unknown as { engineModel: () => FakeProvider }).engineModel = () => pureProvider;
  const pureTokens = await pureAgent.process('run without workspace');
  assert(pureTokens.map(t => t.text).join('').includes('PURE_AGENT_NO_WORKSPACE_OK') && pureAgent.workspace.current === null, 'pure Agent mode: process runs without workspace dependency');

  const formatAgent = new Agent(path.join(TEST_DIR, 'format-agent-runtime'), { agentOnly: true });
  formatAgent.setModel('format-agent-test-model');
  const formatProvider = new FakeProvider(['<think>hidden reasoning</think>\n做了什么\n- visible result\n</think>\nfinal']);
  (formatAgent as unknown as { engineModel: () => FakeProvider }).engineModel = () => formatProvider;
  const formatTokens = await formatAgent.process('test response cleanup');
  const formatText = formatTokens.map(t => t.text).join('');
  assert(formatText.includes('visible result') && !formatText.includes('<think>') && !formatText.includes('</think>') && !formatText.includes('hidden reasoning'), 'agent output: strips think tags and hidden reasoning from visible tokens');
  assert(!formatAgent.chatMessages.some(m => m.content.includes('</think>') || m.content.includes('hidden reasoning')), 'agent output: stores sanitized assistant messages');

  const reactivatingAgent = new Agent(path.join(TEST_DIR, 'reactivating-agent-runtime'), { agentOnly: true });
  reactivatingAgent.setModel('reactivating-agent-test-model');
  const reactivatingProvider = new FakeProvider(['Not done yet.', 'Goal Complete!']);
  (reactivatingAgent as unknown as { engineModel: () => FakeProvider }).engineModel = () => reactivatingProvider;
  reactivatingAgent.updateGoal('Finish the deterministic goal test');
  const reactivationTokens = await reactivatingAgent.process('Start goal test');
  const reactivationText = reactivationTokens.map(t => t.text).join('');
  assert(reactivatingProvider.calls === 2, 'goal process: unfinished response triggers reactivation');
  assert(reactivationText.includes('[Goal Complete]'), 'goal process: retried response completes goal');
  assert(reactivatingAgent.history.some(m => String(m.content).includes('Continue working toward this goal')), 'goal process: continuation prompt recorded');

  const continuingAgent = new Agent(path.join(TEST_DIR, 'continuing-agent-runtime'), { agentOnly: true });
  continuingAgent.setModel('continuing-agent-test-model');
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
  agent.config.addModelToProvider('test-prov', 'conversation-model-a', 'Conversation A', 'Conversation model fixture A');
  agent.config.addModelToProvider('test-prov', 'conversation-model-b', 'Conversation B', 'Conversation model fixture B');
  agent.config.upsertProvider('conversation-fallback-provider', 'https://fallback.example/v1', 'fallback-key');
  agent.config.addModelToProvider('conversation-fallback-provider', 'conversation-fallback-model', 'Conversation fallback', 'Conversation fallback fixture');
  agent.config.save();
  agent.setConversation('model-memory-a');
  agent.setModel('conversation-model-a', true);
  agent.setConversation('model-memory-b');
  agent.setModel('conversation-model-b', true);
  agent.setConversation('model-memory-a');
  assert(agent.activeModelName() === 'conversation-model-a', 'conversation model: switching back restores the conversation-specific deployment');
  agent.setConversation('model-memory-b');
  assert(agent.activeModelName() === 'conversation-model-b', 'conversation model: each conversation keeps an independent deployment selection');
  const conversationModelReloaded = new Agent(TEST_DIR);
  conversationModelReloaded.setConversation('model-memory-a');
  assert(conversationModelReloaded.activeModelName() === 'conversation-model-a', 'conversation model: application restart restores the last selected deployment');
  const conversationProviderA = agent.config.findModel('conversation-model-a')?.provider_id || '';
  assert(!!conversationProviderA && agent.config.setProviderEnabled(conversationProviderA, false), 'conversation model: preferred provider can be temporarily disabled');
  agent.setConversation('model-memory-a');
  agent.reconcileConversationModelSelection();
  assert(agent.activeModelName() !== 'conversation-model-a', 'conversation model: disabled preferred provider temporarily falls back to an available deployment');
  assert(agent.config.setProviderEnabled(conversationProviderA, true), 'conversation model: preferred provider can be re-enabled');
  agent.reconcileConversationModelSelection();
  assert(agent.activeModelName() === 'conversation-model-a', 'conversation model: re-enabling the provider restores the preserved conversation preference');
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
  agent.history.push({ role: 'user', content: 'Use prompt-skill for this task.' });
  assert(agent.buildSystemPrompt().includes('prompt-skill'), 'buildSystemPrompt: includes enabled skills');
  assert((agent.buildSystemPrompt().match(/bulk-skill-/g) || []).length <= 8 && !agent.buildSystemPrompt().includes(path.join(TEST_DIR, 'skills')), 'buildSystemPrompt: large skill catalogs stay bounded and omit filesystem paths');
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
  assert(layeredPrompt.includes('Global Agent Prompt - user baseline') && layeredPrompt.includes('Workspace Agent Prompt - workspace-specific refinement'), 'buildSystemPrompt: labels global baseline before workspace refinement');
  if (agent.workspace.current) fs.writeFileSync(path.join(agent.workspace.current.path, 'agent.md'), '\uFEFF  GLOBAL_PROMPT\r\n');
  agent.invalidateSystemPrompt();
  const deduplicatedPrompt = agent.buildSystemPrompt();
  assert((deduplicatedPrompt.match(/GLOBAL_PROMPT/g) || []).length === 1 && !deduplicatedPrompt.includes('Workspace Agent Prompt - workspace-specific refinement'), 'buildSystemPrompt: normalizes BOM/line endings and skips exact duplicate prompt layers');
  if (agent.workspace.current) fs.writeFileSync(path.join(agent.workspace.current.path, 'agent.md'), 'WORKSPACE_PROMPT');
  agent.invalidateSystemPrompt();
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
  const memoryUpdatePayload = JSON.parse(memoryToolUpdate.slice(memoryToolUpdate.indexOf('{'))) as Record<string, any>;
  assert(memoryUpdatePayload.rebuildReceipt?.completed === true
    && memoryUpdatePayload.rebuildReceipt?.operation === 'update'
    && memoryUpdatePayload.index?.components?.['model-organized-memory'],
  'memory_lab_update: waits for deterministic index rebuild and returns a verified completion receipt to the Agent');
  const memoryReindexReceipt = await (memoryModelAgent as unknown as { handleMemoryLabTool: (tool: string, args: string) => Promise<string> })
    .handleMemoryLabTool('memory_lab_reindex', '{}');
  const memoryReindexPayload = JSON.parse(memoryReindexReceipt.slice(memoryReindexReceipt.indexOf('{'))) as Record<string, any>;
  assert(memoryReindexPayload.rebuildReceipt?.completed === true && memoryReindexPayload.rebuildReceipt?.operation === 'reindex', 'memory_lab_reindex: returns an awaited verified rebuild receipt');

  const memoryReceiptAgent = new Agent(TEST_DIR, { agentOnly: true, conversationId: 'memory-receipt-success' });
  let memoryReceiptRound = 0;
  const memoryReceiptProvider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 500 }),
    async *chatStreamWithTools(): AsyncGenerator<StreamToken> {
      if (memoryReceiptRound++ === 0) {
        yield { type: 'tool_call', text: '', toolCall: { id: 'call-memory-receipt', name: 'memory_lab_update', arguments: JSON.stringify({ name: 'receipt-gated-memory', description: 'receipt gate', tags: ['#Receipt-Gate'], content: 'Receipt gated content.' }) } };
      } else {
        yield { type: 'text', text: 'MEMORY_RECEIPT_FINAL' };
      }
    },
    async chat(): Promise<string> {
      return JSON.stringify({ name: 'receipt-gated-memory', description: 'receipt gate', tags: ['#Receipt-Gate'], content: 'Receipt gated content.', kind: 'file' });
    },
  };
  (memoryReceiptAgent as any).forcedProvider = memoryReceiptProvider;
  memoryReceiptAgent.setMode('build');
  const memoryReceiptTokens = await memoryReceiptAgent.process('Update Memory Lab and wait for the rebuilt index receipt.');
  const memoryReceiptRun = memoryReceiptAgent.workRuns.at(-1);
  assert(memoryReceiptTokens.some(token => token.text.includes('MEMORY_RECEIPT_FINAL'))
    && memoryReceiptAgent.history.some(message => String(message.name || '') === 'memory_lab_update' && String(message.content || '').includes('"completed": true'))
    && memoryReceiptRun?.status === 'completed',
  'memory_lab_update Agent run: provider receives completed rebuild receipt before the run can finish',
  JSON.stringify({ tokens: memoryReceiptTokens, history: memoryReceiptAgent.history.slice(-4), run: memoryReceiptRun }).slice(0, 2000));

  const memoryFailureAgent = new Agent(TEST_DIR, { agentOnly: true, conversationId: 'memory-receipt-failure' });
  let memoryFailureRound = 0;
  const memoryFailureProvider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 500 }),
    async *chatStreamWithTools(): AsyncGenerator<StreamToken> {
      if (memoryFailureRound++ === 0) {
        yield { type: 'tool_call', text: '', toolCall: { id: 'call-memory-failure', name: 'memory_lab_reindex', arguments: '{}' } };
      } else {
        yield { type: 'text', text: 'MUST_NOT_COMPLETE_WITHOUT_RECEIPT' };
      }
    },
    async chat(): Promise<string> { return '{}'; },
  };
  (memoryFailureAgent as any).forcedProvider = memoryFailureProvider;
  (memoryFailureAgent as any).reindexMemoryLab = async () => { throw new Error('simulated rebuild failure'); };
  let memoryFailureRejected = false;
  try {
    await memoryFailureAgent.process('Reindex Memory Lab and do not finish without a rebuild receipt.');
  } catch (error) {
    memoryFailureRejected = String(error).includes('Memory Lab index rebuild failed');
  }
  assert(memoryFailureRejected && memoryFailureAgent.workRuns.at(-1)?.status === 'error', 'memory_lab_reindex Agent run: missing rebuild receipt blocks completion and leaves the Build run in error state');

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
  // This is a host-independent provider/serialization fixture. Declare the
  // simulated Windows host explicitly so Linux CI still provisions the mocked
  // Computer Use call while real Linux hosts keep the tool hidden.
  visionAgent.tools.setHostProfile({ kind: 'cli', platform: 'win32', electronBrowser: false, windowsComputerUse: true });
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
  const computerToolMessage = [...postObserveMessages].reverse().find(m => m.role === 'tool' && m.name === 'computer_use');
  const computerVisionMessage = postObserveMessages.find(m => m.role === 'user' && Array.isArray(m.content) && m.content.some((part: Record<string, any>) => part?.type === 'image_url'));
  const computerVisionContent = Array.isArray(computerVisionMessage?.content) ? computerVisionMessage.content as Array<Record<string, any>> : [];
  assert(visionComputerTokens.map(t => t.text || '').join('').includes('COMPUTER_VISION_DONE'), 'computer_use vision: completes second model turn after observe');
  assert(String(computerToolMessage?.content || '').includes('"Save"') && computerVisionContent.some(p => p.type === 'image_url' && String(p.image_url?.url || '').startsWith('data:image/png;base64,')), 'computer_use vision: sends protocol-valid tool text followed by a synchronized screenshot observation', JSON.stringify(postObserveMessages).slice(0, 700));
  assert(!fs.existsSync(computerUseScreenshot), 'computer_use vision: deletes ephemeral screenshot after preparing image input');
  const computerUseJpeg = path.join(TEST_DIR, 'computer-use-vision.jpg');
  fs.writeFileSync(computerUseJpeg, Buffer.from('ffd8ffd9', 'hex'));
  const jpegComputerPart = (agentKernelRunnerInternals as any).imagePathToOpenAIContentPart(computerUseJpeg) as Record<string, any>;
  assert(String(jpegComputerPart?.image_url?.url || '').startsWith('data:image/jpeg;base64,'), 'computer_use vision: preserves adaptive JPEG MIME for bounded screenshots');
  assert(!fs.existsSync(computerUseJpeg), 'computer_use vision: deletes adaptive JPEG after preparing image input');
  (visionAgent as any).forcedProvider = null;

  const inspectFixture = new PNG({ width: 100, height: 80, colorType: 6 });
  inspectFixture.data.fill(255);
  for (let y = 15; y < 25; y += 1) for (let x = 20; x < 40; x += 1) {
    const offset = (y * 100 + x) * 4;
    inspectFixture.data[offset] = 0;
    inspectFixture.data[offset + 1] = 0;
    inspectFixture.data[offset + 2] = 255;
    inspectFixture.data[offset + 3] = 255;
  }
  const inspectPng = PNG.sync.write(inspectFixture);
  const inspectDataUrl = `data:image/png;base64,${inspectPng.toString('base64')}`;
  const wslVisionInput = (agentKernelRunnerInternals as any).computerUseVisionImageInput(visionAgent, 'computer_use', JSON.stringify({ action: 'observe', vision_image_data_url: inspectDataUrl }));
  const sanitizedWslVisionText = (agentKernelRunnerInternals as any).sanitizeVisualToolText('computer_use', JSON.stringify({ action: 'observe', vision_image_data_url: inspectDataUrl }));
  assert(wslVisionInput.image === inspectDataUrl && !sanitizedWslVisionText.includes('vision_image_data_url') && !sanitizedWslVisionText.includes('data:image/'), 'computer_use WSL vision: transfers a one-use in-memory image while removing it from visible tool text');
  const providerImageCount = (messages: Array<Record<string, any>>): number => messages.reduce((count, message) => (
    count + (Array.isArray(message.content)
      ? message.content.filter((part: Record<string, any>) => part?.type === 'image_url').length
      : 0)
  ), 0);
  for (const toolName of ['computer_use', 'image_inspect']) {
    const ephemeralToolResult: any = {
      role: 'toolResult',
      toolCallId: `call-${toolName}-one-use`,
      toolName,
      content: [
        { type: 'text', text: `${toolName} visual result` },
        { type: 'image', image: inspectDataUrl, mimeType: 'image/png' },
      ],
      isError: false,
      timestamp: Date.now(),
    };
    const persistenceView = (agentKernelRunnerInternals as any).fromKernelMessages([ephemeralToolResult], false);
    assert(providerImageCount(persistenceView) === 0 && ephemeralToolResult.content.some((part: Record<string, unknown>) => part.type === 'image'), `${toolName} privacy: non-provider serialization never persists or prematurely consumes the ephemeral image`);
    const firstProviderView = (agentKernelRunnerInternals as any).fromKernelMessages([ephemeralToolResult], true);
    assert(providerImageCount(firstProviderView) === 1 && !ephemeralToolResult.content.some((part: Record<string, unknown>) => part.type === 'image'), `${toolName} privacy: first provider serialization includes and consumes exactly one ephemeral image`);
    const secondProviderView = (agentKernelRunnerInternals as any).fromKernelMessages([ephemeralToolResult], true);
    assert(providerImageCount(secondProviderView) === 0, `${toolName} privacy: later model rounds cannot replay the consumed ephemeral image`);
  }
  const durableUserImageMessage: any = {
    role: 'user',
    content: [
      { type: 'text', text: 'durable user image' },
      { type: 'image', image: inspectDataUrl, mimeType: 'image/png' },
    ],
    timestamp: Date.now(),
  };
  const firstUserProviderView = (agentKernelRunnerInternals as any).fromKernelMessages([durableUserImageMessage], true);
  const secondUserProviderView = (agentKernelRunnerInternals as any).fromKernelMessages([durableUserImageMessage], true);
  assert(providerImageCount(firstUserProviderView) === 1 && providerImageCount(secondUserProviderView) === 1
    && durableUserImageMessage.content.some((part: Record<string, unknown>) => part.type === 'image'),
  'user image privacy: provider serialization never consumes intentionally durable user-role images');
  visionAgent.history.push({ role: 'user', content: [{ type: 'text', text: 'inspect attachment' }, { type: 'image_url', image_url: { url: inspectDataUrl } }] });
  const inspectInfo = JSON.parse(await visionAgent.handleImageInspect(JSON.stringify({ action: 'source_info', image_index: 1 })));
  assert(inspectInfo.width === 100 && inspectInfo.height === 80, 'image_inspect: reports submitted source dimensions before pixel cropping');
  const inspectCrop = JSON.parse(await visionAgent.handleImageInspect(JSON.stringify({ action: 'crop', image_index: 1, x: 20, y: 15, width: 20, height: 10, scale: 3 })));
  const croppedImage = PNG.sync.read(Buffer.from(String(inspectCrop.image_data_url).split(',')[1], 'base64'));
  assert(croppedImage.width === 60 && croppedImage.height === 30 && inspectCrop.output.scale === 3, 'image_inspect: crops exact source pixels and magnifies with bounded dimensions');
  const inspectOutOfBounds = await visionAgent.handleImageInspect(JSON.stringify({ action: 'crop', x: 95, y: 70, width: 20, height: 20 }));
  assert(inspectOutOfBounds.includes('exceeds source bounds 100x80'), 'image_inspect: rejects crop rectangles outside the submitted image');

  const inspectMessagesSeen: Array<Array<Record<string, unknown>>> = [];
  let inspectRound = 0;
  const inspectProvider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 100 }),
    async *chatStreamWithTools(_model: string, messages: Array<Record<string, unknown>>): AsyncGenerator<StreamToken> {
      inspectMessagesSeen.push(messages);
      if (inspectRound++ === 0) {
        yield { type: 'tool_call', text: '', toolCall: { id: 'provision-image-inspect', name: 'tool_provision', arguments: JSON.stringify({ names: ['image_inspect'] }) } };
      } else if (inspectRound === 2) {
        yield { type: 'tool_call', text: '', toolCall: { id: 'call-image-inspect', name: 'image_inspect', arguments: JSON.stringify({ action: 'crop', image_index: 1, x: 20, y: 15, width: 20, height: 10, scale: 2 }) } };
      } else {
        yield { type: 'text', text: 'IMAGE_INSPECT_DONE' };
      }
    },
    async chat(): Promise<string> { return 'unused'; },
  };
  (visionAgent as any).forcedProvider = inspectProvider;
  const beforeInspectDataUrls = (JSON.stringify(visionAgent.history).match(/data:image\//g) || []).length;
  const inspectTokens = await visionAgent.process({ text: 'Actively crop the submitted image', images: [{ dataUrl: inspectDataUrl, name: 'geometry.png', type: 'image/png' }] });
  const inspectProviderMessages = inspectMessagesSeen[2] || [];
  const inspectToolMessage = [...inspectProviderMessages].reverse().find(message => message.role === 'tool' && message.name === 'image_inspect');
  const inspectVisionMessage = [...inspectProviderMessages].reverse().find(message => message.role === 'user' && Array.isArray(message.content) && message.content.some((part: Record<string, any>) => part?.type === 'image_url'));
  const inspectVisionContent = Array.isArray(inspectVisionMessage?.content) ? inspectVisionMessage.content as Array<Record<string, any>> : [];
  const afterInspectDataUrls = (JSON.stringify(visionAgent.history).match(/data:image\//g) || []).length;
  assert(inspectTokens.map(token => token.text || '').join('').includes('IMAGE_INSPECT_DONE'), 'image_inspect kernel: model can actively inspect and continue the same turn');
  assert(inspectVisionContent.some(part => part.type === 'image_url' && String(part.image_url?.url || '').startsWith('data:image/png;base64,')), 'image_inspect kernel: returns the crop as a synchronized structured vision observation');
  assert(String(inspectToolMessage?.content || '').includes('"crop"') && !String(inspectToolMessage?.content || '').includes('image_data_url'), 'image_inspect kernel: exposes crop metadata without leaking base64 into visible tool text');
  assert(afterInspectDataUrls === beforeInspectDataUrls + 1 && !JSON.stringify(visionAgent.history).includes('image_data_url'), 'image_inspect privacy: persists only the user attachment, not the derived crop data URL');
  (visionAgent as any).forcedProvider = null;

  // ---- 8. Input Mode Tests ----
  console.log('\n⌨️  Input Modes');
  agent.setMode('build');
  agent.inputMode = 'guide';
  assert(agent.inputMode === 'guide', 'inputMode: guide');
  agent.inputMode = 'next';
  assert(agent.inputMode === 'next', 'inputMode: next');
  const inputModeConversation = `input-mode-${Date.now()}`;
  agent.setConversation(inputModeConversation);
  agent.setInputMode('next');
  agent.setConversation('default');
  agent.setInputMode('guide');
  agent.setConversation(inputModeConversation);
  assert(agent.inputMode === 'next' && agent.getConversationSnapshot(inputModeConversation).inputMode === 'next', 'inputMode: persists Guide/Next selection per conversation');
  const inputModeReloaded = new Agent(TEST_DIR);
  inputModeReloaded.setConversationFromStorage(inputModeConversation);
  assert(inputModeReloaded.inputMode === 'next', 'inputMode: restores the selected conversation mode after application restart');
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

  const archiveIsolationRoot = path.join(TEST_DIR, 'archive-conversation-isolation');
  const archiveAgent = new Agent(archiveIsolationRoot);
  archiveAgent.createInternalWorkspace('archive-targets');
  archiveAgent.setConversation('keep-active');
  archiveAgent.chatMessages = [
    { role: 'user', content: 'same title', mode: 'Build', model: archiveAgent.model, timestamp: 'ta' },
    { role: 'assistant', content: 'keep response', mode: 'Build', model: archiveAgent.model, timestamp: 'ta2' },
  ];
  archiveAgent.flushConversationState();
  archiveAgent.setConversation('archive-target');
  archiveAgent.chatMessages = [
    { role: 'user', content: 'same title', mode: 'Build', model: archiveAgent.model, timestamp: 'tb' },
    { role: 'assistant', content: 'duplicate response', mode: 'Build', model: archiveAgent.model, timestamp: 'tb2' },
  ];
  archiveAgent.flushConversationState();
  archiveAgent.setConversation('archive-target-duplicate');
  archiveAgent.chatMessages = [
    { role: 'user', content: 'same title', mode: 'Build', model: archiveAgent.model, timestamp: 'tc' },
    { role: 'assistant', content: 'duplicate response', mode: 'Build', model: archiveAgent.model, timestamp: 'tc2' },
  ];
  archiveAgent.flushConversationState();
  const sameTitleConversations = archiveAgent.listConversationStates().filter(c => c.title === 'same title');
  assert(sameTitleConversations.length === 2 && sameTitleConversations.some(c => c.id === 'keep-active') && sameTitleConversations.some(c => c.id === 'archive-target-duplicate'), 'conversation registry: exact duplicate content registers only the newest id while different same-title content remains');
  archiveAgent.setConversation('keep-active');
  const archivedTargetName = archiveAgent.archiveConversation('archive-target');
  assert(!!archivedTargetName && fs.existsSync(path.join(archiveAgent.workspace.current!.path, 'archive', archivedTargetName)), 'archiveConversation: writes the selected conversation archive');
  assert(archiveAgent.activeConversationId === 'keep-active' && archiveAgent.chatMessages[1]?.content === 'keep response', 'archiveConversation: archiving a background conversation preserves the active conversation');
  assert(!archiveAgent.listConversationStates().some(c => c.id === 'archive-target'), 'archiveConversation: removes the target id from persisted active conversation state');
  assert(!archiveAgent.listConversationStates().some(c => c.id === 'archive-target-duplicate'), 'archiveConversation: removes exact duplicate registrations with the archived target');
  const archiveAgentReloaded = new Agent(archiveIsolationRoot);
  assert(!archiveAgentReloaded.listConversationStates().some(c => c.id === 'archive-target'), 'archiveConversation: removed target does not return after restart');
  const restorableArchive = archiveAgentReloaded.listArchives().find(item => item.name === archivedTargetName);
  assert(restorableArchive?.restorable === true && restorableArchive.conversationId === 'archive-target', 'archiveConversation: new archives advertise restorable structured state');
  const restoredArchive = archiveAgentReloaded.restoreArchivedConversation(restorableArchive!.id);
  assert(restoredArchive.ok && restoredArchive.conversationId === 'archive-target', 'restoreArchivedConversation: restores the original conversation id after restart');
  assert(archiveAgentReloaded.chatMessages.some(message => message.content === 'duplicate response'), 'restoreArchivedConversation: restores the original structured conversation history');
  assert(!archiveAgentReloaded.listArchives().find(item => item.name === archivedTargetName)?.restorable, 'restoreArchivedConversation: consumes the restore manifest while retaining the readable Markdown archive');
  const restoreConflict = archiveAgentReloaded.restoreArchivedConversation(restorableArchive!.id);
  assert(!restoreConflict.ok, 'restoreArchivedConversation: cannot overwrite an existing conversation or reuse a consumed manifest');
  archiveAgentReloaded.deleteArchive(archivedTargetName!);

  // ---- 10. Context Compression Tests ----
  console.log('\n📐 Context Compression');
  agent.setMode('build');
  agent.config.upsertProvider('compression-test-provider', 'https://api.compression-test.invalid/v1', 'compression-test-key');
  agent.config.addModelToProvider('compression-test-provider', 'compression-test-model', 'Compression Test Model', 'Compression budget test model');
  agent.config.updateModel('compression-test-provider', 'compression-test-model', { max_tokens: 20_000 });
  agent.setModel('compression-test-model');
  // Build large history
  agent.history = Array(50).fill(null).map((_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(2000), // 2000 chars each = 100K total
  }));

  const msgs = [...agent.history];
  // @ts-expect-error accessing private method for testing
  await agent.maybeCompress(msgs, new FakeProvider(['## Preserved State\nWorkspace: test\nGoal: keep state\n## Pending Work\nContinue.']));
  assert(msgs.length < 50, 'maybeCompress: reduces messages');
  assert(String(msgs[0]?.content || '').includes('Context Compression Model Summary'), 'maybeCompress: uses model-generated summary');
  assert(String(msgs[0]?.content || '').includes('Preserved State'), 'maybeCompress: preserves structured summary');
  assert(msgs.filter(message => String(message.content || '').includes('[Post-Compression Task Continuation]')).length === 1
    && String(msgs[1]?.content || '').includes('latest retained real user-role message'),
  'maybeCompress: injects exactly one immediate continuation anchor after the summary');
  assert(agent.lastCompression?.fallback === false, 'maybeCompress: records model compression metadata');
  assert(agent.history.some(m => String(m.content || '').includes('Context Compression Model Summary')), 'maybeCompress: persists compressed history');
  const repeatCompressionCallsBefore = (agent as any).lastCompression?.at;
  let repeatedProviderCalls = 0;
  const repeatedProvider = new FakeProvider(['SHOULD_NOT_RUN']) as unknown as LLMProvider;
  repeatedProvider.chat = async () => { repeatedProviderCalls += 1; return 'SHOULD_NOT_RUN'; };
  msgs.push({ role: 'tool', name: 'read', content: 'small post-compression receipt' });
  await agent.maybeCompress(msgs, repeatedProvider);
  assert(repeatedProviderCalls === 0 && agent.lastCompression?.at === repeatCompressionCallsBefore,
    'maybeCompress: a small tool-result growth after compression cannot immediately recompress the same retained context');
  agent.config.updateModel('compression-test-provider', 'compression-test-model', { max_tokens: 10_000 });
  agent.setModel('compression-test-model');
  agent.history = [
    { role: 'user', content: 'LEGACY_FIRST_TASK_MUST_NOT_STAY_PINNED ' + 'l'.repeat(6000) },
    ...Array.from({ length: 18 }, (_, index) => ({
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: `historical-${index} ` + 'h'.repeat(2000),
    })),
    { role: 'user', content: 'CURRENT_TASK_MUST_REMAIN_AUTHORITATIVE' },
  ];
  const taskFocusCompressionMessages = agent.history.map(message => ({ ...message }));
  await agent.maybeCompress(taskFocusCompressionMessages, new FakeProvider(['## Active Or Unfinished Work\nPreserve only evidenced continuity.']) as unknown as LLMProvider);
  assert(!JSON.stringify(taskFocusCompressionMessages.slice(2)).includes('LEGACY_FIRST_TASK_MUST_NOT_STAY_PINNED')
    && JSON.stringify(taskFocusCompressionMessages.at(-1)).includes('CURRENT_TASK_MUST_REMAIN_AUTHORITATIVE'),
  'maybeCompress: the first historical user task is summarized instead of pinned forever while the latest current task remains verbatim');
  assert(String(taskFocusCompressionMessages[1]?.role || '') === 'system'
    && !String(taskFocusCompressionMessages[1]?.content || '').includes('CURRENT_TASK_MUST_REMAIN_AUTHORITATIVE')
    && String(taskFocusCompressionMessages.at(-1)?.role || '') === 'user',
  'maybeCompress: continuation anchor preserves instruction hierarchy without copying user text into system role');
  agent.history = Array(50).fill(null).map((_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'z'.repeat(2000) }));
  const compressionModelMessages = [...agent.history];
  let requestedCompressionModel = '';
  let compressionSystemPrompt = '';
  let compressionUserPrompt = '';
  const compressionModelProvider = new FakeProvider(['## Active Or Unfinished Work\nUse the request-scoped model.']) as unknown as LLMProvider;
  compressionModelProvider.chat = async (modelName: string, messages: Array<Record<string, unknown>>, systemPrompt: string) => {
    requestedCompressionModel = modelName;
    compressionSystemPrompt = systemPrompt;
    compressionUserPrompt = String(messages[0]?.content || '');
    return '## Active Or Unfinished Work\nUse the request-scoped model.';
  };
  await agent.maybeCompress(compressionModelMessages, compressionModelProvider, undefined, 'current-session-model');
  assert(requestedCompressionModel === 'current-session-model' && agent.lastCompression?.model === 'current-session-model', 'maybeCompress: binds provider request and metadata to the current session model snapshot');
  assert(compressionSystemPrompt.includes('Completed Or Background Work')
    && compressionSystemPrompt.includes('must not be revived as the current objective')
    && compressionSystemPrompt.includes('newest to oldest')
    && compressionUserPrompt.includes('Latest retained user instruction'),
  'maybeCompress: model prompt classifies historical task state and orders unfinished tasks newest-to-oldest');
  const oversizedImage = `data:image/png;base64,${'A'.repeat(40000)}`;
  agent.history = Array.from({ length: 12 }, (_, index) => index === 0
    ? { role: 'user', content: [{ type: 'text', text: 'old image' }, { type: 'image_url', image_url: { url: oversizedImage } }] }
    : { role: index % 2 ? 'assistant' : 'user', content: `message-${index}` });
  const imageCompressionMessages = agent.history.map(message => ({ ...message }));
  assert(agent.estimateContextTokens(imageCompressionMessages) > 8000, 'maybeCompress images: structured base64 is counted instead of collapsing to object string text');
  await agent.maybeCompress(imageCompressionMessages, new FakeProvider(['## Preserved State\nThe historical image was inspected.']) as unknown as LLMProvider);
  assert(!JSON.stringify(imageCompressionMessages).includes(oversizedImage) && JSON.stringify(imageCompressionMessages).includes('Historical image attachment omitted'), 'maybeCompress images: historical image payloads become bounded textual records before the next provider request');
  agent.history = Array(50).fill(null).map((_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'y'.repeat(2000) }));
  const errorCompressionMessages = [...agent.history];
  await agent.maybeCompress(errorCompressionMessages, new FakeProvider(['[LLM Error: 400] unsupported response shape']) as unknown as LLMProvider);
  assert(agent.lastCompression?.fallback === true && String(errorCompressionMessages[0]?.content || '').includes('Context Compression Fallback'), 'maybeCompress: empty/error provider summaries use local fallback instead of persisting a false model summary');
  agent.config.upsertProvider('context-prov', 'https://api.context.test/v1', 'test-key-context');
  agent.config.addModelToProvider('context-prov', 'near-limit-context', 'Near Limit Context', 'Near-limit compression model');
  agent.config.updateModel('context-prov', 'near-limit-context', { max_tokens: 1000 });
  agent.setModel('near-limit-context');
  agent.config.set('context', 'compress_threshold_chars', 80000);
  agent.config.set('context', 'keep_recent_messages', 10);
  agent.history = [
    { role: 'system', content: 'system root' },
    ...Array(14).fill(null).flatMap((_, i) => [
      { role: 'user', content: `user-${i} ` + 'u'.repeat(180) },
      { role: 'assistant', content: `assistant-${i} ` + 'a'.repeat(180) },
    ]),
  ];
  const nearLimitMessages = [...agent.history];
  const nearLimitBefore = agent.estimateContextTokens(nearLimitMessages);
  assert(nearLimitBefore < 20000 && nearLimitBefore >= 800, 'maybeCompress near limit: fixture crosses 80% of the current model context window');
  await agent.maybeCompress(nearLimitMessages, new FakeProvider(['## Preserved State\nKeep the active implementation and pending verification.']) as unknown as LLMProvider);
  const nearLimitAfter = agent.estimateContextTokens(nearLimitMessages);
  assert(nearLimitMessages.length < 29 && nearLimitAfter < nearLimitBefore && nearLimitAfter <= 300, 'maybeCompress near limit: compacts toward 20% of the model context window');
  assert(String(nearLimitMessages[2]?.role || '') === 'user', 'maybeCompress near limit: retained recent context starts at a complete user turn after the summary and continuation records');
  assert(agent.lastCompression?.originalMessages === 29 && agent.lastCompression?.compressedMessages === nearLimitMessages.length, 'maybeCompress near limit: records exact original and compacted message counts');
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
  const restoreModelValidationProviderFixture = installValidationProviderFixture({
    validModels: new Set([
      'fast-mini', 'deep-opus', 'gpt-5.5', 'gpt5.5', 'other-flash', 'vision-pro',
      'noguide-fast', 'model', 'deepseek-chat', 'deepseek-reasoner', 'nebula-fast',
    ]),
    visionModels: new Set(['gpt-5.5', 'vision-pro']),
    catalogs: {
      'api.model.test': ['bad-model', 'fast-mini', 'deep-opus', 'gpt-5.5', 'gpt5.5'],
      'api.other-model.test': ['other-flash', 'vision-pro'],
      'api.noguide.test': ['noguide-fast'],
      'probe-only.test': ['model'],
      'api.deepseek.com': ['deepseek-chat', 'deepseek-reasoner'],
      'nebula.local': ['nebula-fast', 'nebula-pro'],
    },
    rejectedBaseUrls: new Set(['broken.local']),
  });
  const validation = await modelAgent.validateModels();
  assert(Array.isArray(validation), 'validateModels: returns array');
  assert(validation.some(v => v.name === 'model-prov/fast-mini' && v.status === 'verified'), 'validateModels: records a model only after Standard probes pass');
  assert(validation.some(v => v.name === 'model-prov/bad-model' && v.status === 'invalid_config'), 'validateModels: deterministic provider rejection keeps a bad model unavailable');
  assert(validation.some(v => v.speed_rating === 'fast'), 'validateModels: records response speed');
  assert(validation.every(v => !(v as unknown as Record<string, unknown>).api_key), 'validateModels: does not leak API keys');
  const evaluatedFast = modelAgent.config.findModel('fast-mini');
  assert(evaluatedFast?.evaluation?.status === 'verified' && evaluatedFast.validation?.level === 'standard', 'validateModels: persists Standard evaluation into config');
  assert(String(evaluatedFast?.description || '').includes('capability=') && String(evaluatedFast?.description || '').includes('speed=') && String(evaluatedFast?.description || '').includes('cost=') && String(evaluatedFast?.description || '').includes('multimodal='), 'validateModels: generates model description with capability speed cost and multimodal metadata');
  const evaluatedGpt55 = modelAgent.config.findModel('gpt-5.5');
  const evaluatedGpt55Compact = modelAgent.config.findModel('gpt5.5');
  assert(validation.some(v => v.name === 'model-prov/gpt-5.5' && v.status === 'verified' && v.vision_input === true), 'validateModels: confirms GPT-5.5 vision input only through the deterministic visual probe');
  assert(validation.some(v => v.name === 'model-prov/gpt5.5' && v.status === 'degraded' && v.vision_input === false), 'validateModels: catalog/name hypotheses alone cannot mark vision available when the visual probe fails');
  assert(evaluatedGpt55?.vision === true && evaluatedGpt55?.evaluation?.vision_input === true, 'validateModels: persists task-confirmed GPT-5.5 vision capability into config');
  assert(String(evaluatedGpt55?.description || '').includes('vision-input') && !String(evaluatedGpt55Compact?.description || '').includes('vision-input'), 'validateModels: generated descriptions include only task-confirmed multimodal support');
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
    quality_by_task: { tool_use: { successes: 8, attempts: 10 } },
    validation: {
      level: 'standard',
      status: 'verified',
      checked_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      capabilities: { text_input: true, text_output: true, streaming: true, json_schema: true, tool_use: true, image_input: false, image_output: false },
    },
    evaluation: {
      status: 'verified',
      latency: 0,
      checked_at: new Date().toISOString(),
      text_input: true,
      text_output: true,
      vision_input: false,
      image_output: false,
      cost_rating: 'free',
      performance_rating: 'medium',
      speed_rating: 'fast',
      notes: 'Standard-verified cross-provider Auto test model',
    },
  });
  const fastEvaluation = modelAgent.config.findModel('fast-mini')?.evaluation;
  const deepEvaluation = modelAgent.config.findModel('deep-opus')?.evaluation;
  assert(!!fastEvaluation && !!deepEvaluation, 'auto model fixture: Standard validation produced routable baseline models');
  modelAgent.config.updateModel('model-prov', 'fast-mini', {
    speed_rating: 'slow',
    cost_per_1k_input: 0.001,
    cost_per_1k_output: 0.002,
    quality_by_task: { tool_use: { successes: 9, attempts: 11 }, coding: { successes: 9, attempts: 11 } },
    evaluation: { ...fastEvaluation!, latency: 1, speed_rating: 'slow' },
  });
  modelAgent.config.updateModel('model-prov', 'deep-opus', {
    speed_rating: 'slow',
    cost_per_1k_input: 0.02,
    cost_per_1k_output: 0.06,
    quality_by_task: { tool_use: { successes: 10, attempts: 12 }, coding: { successes: 10, attempts: 12 } },
    evaluation: { ...deepEvaluation!, latency: 2.2, speed_rating: 'slow' },
  });
  modelAgent.config.updateModel('other-prov', 'other-flash', { max_tokens: 512 });
  modelAgent.config.set('models', 'auto_switch', true);
  modelAgent.config.set('models', 'auto_switch_scope', 'all');
  modelAgent.config.set('models', 'auto_switch_preference', 'speed');
  modelAgent.setModel('auto');
  const contextSafeSwitch = await modelAgent.evaluateAndSwitch('list files');
  assert(contextSafeSwitch && modelAgent.model === 'auto' && modelAgent.activeModelName() === 'fast-mini', 'auto model: preserves Auto intent and skips a faster candidate whose context window is too small');
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
  assert(switchedForSpeed && modelAgent.model === 'auto' && modelAgent.activeModelName() === 'other-flash', 'auto model: global scope resolves across providers without replacing Auto intent');
  modelAgent.setModel('deep-opus');
  modelAgent.config.set('models', 'auto_switch_scope', 'provider');
  modelAgent.setModel('auto');
  const providerScopedSwitch = await modelAgent.evaluateAndSwitch('list files');
  assert(providerScopedSwitch && modelAgent.model === 'auto' && modelAgent.activeModelName() === 'fast-mini', 'auto model: provider-scoped mode stays within the anchor provider');
  modelAgent.config.set('models', 'auto_switch_preference', 'default');
  modelAgent.config.set('models', 'auto_switch_scope', 'all');
  modelAgent.setModel('auto');
  const switchedForDefault = await modelAgent.evaluateAndSwitch('list files');
  assert(switchedForDefault && modelAgent.model === 'auto' && modelAgent.activeModelName() === 'fast-mini', 'auto model: Balanced quality band excludes a cheaper candidate beyond the 2% loss budget');
  modelAgent.config.set('models', 'auto_switch_preference', 'performance');
  modelAgent.config.set('models', 'auto_switch_scope', 'all');
  modelAgent.setModel('auto');
  const switchedForPerformance = await modelAgent.evaluateAndSwitch('implement a complex refactor across modules');
  assert(switchedForPerformance && modelAgent.model === 'auto' && modelAgent.activeModelName() === 'deep-opus', 'auto model: Quality mode selects the highest task-domain quality candidate');
  modelAgent.config.set('models', 'auto_switch_preference', 'cheap_save');
  modelAgent.setModel('auto');
  const switchedForCost = await modelAgent.evaluateAndSwitch('list files');
  assert(switchedForCost && modelAgent.model === 'auto' && modelAgent.activeModelName() === 'other-flash', 'auto model: Cost mode selects the cheapest candidate inside its 6% quality band');
  modelAgent.config.addModelToProvider('other-prov', 'vision-pro', 'Vision Pro', 'High capability multimodal vision model');
  modelAgent.config.updateModel('other-prov', 'vision-pro', {
    vision: true,
    speed_rating: 'medium',
    capability_rating: 'high',
    cost_per_1k_input: 0.01,
    cost_per_1k_output: 0.03,
    validation: {
      level: 'standard',
      status: 'verified',
      checked_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      capabilities: { text_input: true, text_output: true, streaming: true, json_schema: true, tool_use: true, image_input: true, image_output: false },
    },
    evaluation: {
      status: 'verified',
      latency: 1.2,
      checked_at: new Date().toISOString(),
      text_input: true,
      text_output: true,
      vision_input: true,
      image_output: false,
      cost_rating: 'standard',
      performance_rating: 'high',
      speed_rating: 'medium',
      notes: 'Standard-verified multimodal Auto test model',
    },
  });
  modelAgent.config.set('models', 'auto_switch_preference', 'speed');
  modelAgent.config.set('models', 'auto_switch_scope', 'all');
  modelAgent.setModel('auto');
  const switchedForVision = await modelAgent.evaluateAndSwitch('analyze this screenshot ![shot](C:/tmp/shot.png)');
  assert(switchedForVision && modelAgent.model === 'auto' && modelAgent.activeModelConfig()?.vision === true, 'auto model: multimodal input resolves to a Standard-validated vision model within scope');
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
  const fallbackFastEvaluation = modelAgent.config.findModel('fast-mini')?.evaluation;
  modelAgent.config.updateModel('model-prov', 'fast-mini', {
    speed_rating: 'fast',
    capability_rating: 'high',
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
    evaluation: { ...fallbackFastEvaluation!, latency: 0.1, speed_rating: 'fast', performance_rating: 'high', cost_rating: 'free' },
  });
  modelAgent.config.updateModel('model-prov', 'bad-model', {
    validation: {
      level: 'standard',
      status: 'unavailable',
      checked_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      capabilities: {},
      error: { code: 'fixture_unavailable', message: 'forced unavailable for fallback test' },
    },
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
  const validationFixtureChatStream = LLMProvider.prototype.chatStreamWithTools;
  LLMProvider.prototype.chatStreamWithTools = async function* (modelName: string) {
    yield { type: 'text', text: modelName === 'fast-mini' ? 'FALLBACK_PRECHECK_OK' : '[LLM Error: 503] retryable provider failure' };
  };
  modelAgent.setModel('bad-model');
  const precheckedFallback = await modelAgent.process('check fallback preflight');
  assert(modelAgent.model === 'fast-mini', 'model fallback: pre-switches away from known unavailable model');
  assert(precheckedFallback.some(t => t.text?.includes('FALLBACK_PRECHECK_OK')), 'model fallback: completes after pre-switch');
  modelAgent.config.updateModel('model-prov', 'bad-model', {
    validation: {
      level: 'standard',
      status: 'verified',
      checked_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      capabilities: { text_input: true, text_output: true, streaming: true, json_schema: true, tool_use: true, image_input: false, image_output: false },
    },
    evaluation: {
      status: 'verified',
      latency: 1,
      checked_at: new Date().toISOString(),
      text_input: true,
      text_output: true,
      vision_input: false,
      image_output: false,
      cost_rating: 'cheap',
      performance_rating: 'medium',
      speed_rating: 'fast',
      notes: 'Standard-verified before runtime failure test',
    },
  });
  modelAgent.setModel('bad-model');
  const runtimeFallback = await modelAgent.process('check runtime fallback');
  assert(modelAgent.model === 'fast-mini', 'model fallback: switches after runtime LLM error');
  assert(runtimeFallback.some(t => t.text?.includes('[Model fallback] bad-model unavailable; switched to fast-mini.')), 'model fallback: emits visible switch notice');
  assert(runtimeFallback.some(t => t.text?.includes('FALLBACK_PRECHECK_OK')), 'model fallback: retries request on fallback model');
  LLMProvider.prototype.chatStreamWithTools = validationFixtureChatStream;

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
  const nebulaFuzzy = await agent.fuzzyInject('APInebula', 'https://nebula.local/v1', 'test-key-nebula');
  assert(nebulaFuzzy.ok === true, 'fuzzy injection: custom provider validates listed model');
  assert(nebulaFuzzy.models?.includes('nebula-fast') && nebulaFuzzy.models?.includes('nebula-pro'), 'fuzzy injection: imports provider /models listing');
  assert(agent.config.findModel('nebula-fast')?.description.includes('source=model validation'), 'fuzzy injection: listed models receive validation-generated description metadata');
  assert(!JSON.stringify(nebulaFuzzy).includes('test-key-nebula'), 'fuzzy injection: result does not leak API key');
  const nebulaExistingFuzzy = await agent.fuzzyInject('APInebula', '', '');
  assert(nebulaExistingFuzzy.ok === true && nebulaExistingFuzzy.models?.includes('nebula-fast'), 'fuzzy injection: existing provider reuses saved endpoint and key');
  assert(agent.config.providers().find(p => p.name === 'APInebula')?.api_key === 'test-key-nebula', 'fuzzy injection: empty key does not overwrite saved provider key');
  const failedFuzzy = await agent.fuzzyInject('BrokenProvider', 'https://broken.local/v1', 'test-key-broken');
  assert(failedFuzzy.ok === false && failedFuzzy.warning?.includes('none validated as available'), 'fuzzy injection: failed validation reports no available models');
  assert(failedFuzzy.warning?.includes('model: invalid_config') && failedFuzzy.warning?.includes('Discovery:'), 'fuzzy injection: failed Standard validation warning includes classified model status and discovery context');
  assert(!JSON.stringify(failedFuzzy).includes('test-key-broken'), 'fuzzy injection: failed validation result does not leak API key');
  const githubFuzzy = await agent.fuzzyInject('GitHub Copilot', 'https://models.github.ai', 'ghp-test-token');
  assert(githubFuzzy.ok === false && githubFuzzy.warning?.includes('precise browser login'), 'fuzzy injection: GitHub/Copilot requires exact browser login and is rejected');
  restoreModelValidationProviderFixture();

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

  globalThis.fetch = (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: { value: 'anthropic nested text' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const anthropicNestedText = await anthropicProvider.chat('deepseek-v4-flash', [{ role: 'user', content: 'Hi' }], null, 0.1, 50);
  globalThis.fetch = originalFetch;
  assert(anthropicNestedText === 'anthropic nested text', 'LLMProvider Anthropic: normalizes nested text values through the shared native extractor');

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
  responsesBodies.length = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    responsesBodies.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify({ output_text: 'memory continuation repaired' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  await responsesToolResultProvider.chatStreamWithTools('gpt-5.4-mini', [
    { role: 'user', content: 'Read memory' },
    { role: 'tool', tool_call_id: 'call_memory_read', name: 'memory_lab_read', content: '[memory_lab_read] index' },
  ], 'system text', 0, 20, []).next();
  globalThis.fetch = originalFetch;
  const repairedMemoryBody = responsesBodies[0] || {};
  const repairedCallIndex = repairedMemoryBody.input.findIndex((item: any) => item.type === 'function_call' && item.call_id === 'call_memory_read' && item.name === 'memory_lab_read');
  const repairedOutputIndex = repairedMemoryBody.input.findIndex((item: any) => item.type === 'function_call_output' && item.call_id === 'call_memory_read');
  assert(repairedCallIndex >= 0 && repairedCallIndex < repairedOutputIndex, 'LLMProvider Responses mode: repairs a migrated Memory Lab tool result with its required preceding function_call');

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

  let responsesStreamBody: any = null;
  let responsesStreamAccept = '';
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    responsesStreamBody = JSON.parse(String(init?.body || '{}'));
    responsesStreamAccept = new Headers(init?.headers).get('accept') || '';
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","item_id":"reasoning-1","summary_index":0,"delta":"Checking the "}\n\n'));
        controller.enqueue(encoder.encode('event: response.reasoning_summary_text.done\ndata: {"type":"response.reasoning_summary_text.done","item_id":"reasoning-1","summary_index":0,"text":"Checking the workspace"}\n\n'));
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"first "}\n\n'));
        controller.enqueue(encoder.encode('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"id":"item_write","type":"function_call","call_id":"call_write","name":"write","arguments":""}}\n\n'));
        controller.enqueue(encoder.encode('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_write","delta":"{\\"path\\":\\"README.md\\"}"}\n\n'));
        controller.enqueue(encoder.encode('event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"id":"item_write","type":"function_call","call_id":"call_write","name":"write","arguments":"{\\"path\\":\\"README.md\\"}"}}\n\n'));
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  const streamedResponsesTokens: StreamToken[] = [];
  for await (const tok of directResponsesProvider.chatStreamWithTools('gpt-5.4-mini', [{ role: 'user', content: 'Stream and use tool' }], null, 0, 20, [])) streamedResponsesTokens.push(tok);
  globalThis.fetch = originalFetch;
  assert(responsesStreamBody?.stream === true && responsesStreamAccept === 'text/event-stream', 'LLMProvider Responses stream: requests SSE with stream=true and Accept text/event-stream');
  assert(responsesStreamBody?.reasoning?.summary === 'auto', 'LLMProvider Responses stream: requests a readable reasoning summary when the provider supports it');
  assert(streamedResponsesTokens.some(token => token.type === 'status' && token.text === 'Checking the workspace'), 'LLMProvider Responses stream: yields provider-authored readable reasoning summaries without exposing encrypted reasoning');
  assert(streamedResponsesTokens.some(token => token.type === 'text' && token.text === 'first '), 'LLMProvider Responses stream: yields output_text deltas as they arrive');
  assert(streamedResponsesTokens.some(token => token.type === 'tool_call' && token.toolCall?.id === 'call_write' && token.toolCall.arguments.includes('README.md')), 'LLMProvider Responses stream: assembles and yields function call arguments');

  globalThis.fetch = (async () => new Response(JSON.stringify([{
    output: [{ type: 'message', content: [{ type: 'output_text', text: { value: 'nested responses text' } }] }],
  }]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const nestedResponsesText = await directResponsesProvider.chat('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], null, 0, 20);
  const nestedResponsesTokens: StreamToken[] = [];
  for await (const tok of directResponsesProvider.chatStreamWithTools('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], null, 0, 20, [])) nestedResponsesTokens.push(tok);
  globalThis.fetch = originalFetch;
  assert(nestedResponsesText === 'nested responses text' && nestedResponsesTokens.some(token => token.text === 'nested responses text'), 'LLMProvider Responses mode: normalizes single-element gateway arrays and parses nested output_text in chat and tool-stream paths');

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

  directChatBodies.length = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    directChatBodies.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'chat memory continuation repaired' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  for await (const _tok of directChatProvider.chatStreamWithTools('gpt-5.4-mini', [
    { role: 'user', content: 'Read memory' },
    { role: 'tool', tool_call_id: 'call_chat_memory_read', name: 'memory_lab_read', content: '[memory_lab_read] index' },
  ], null, 0, 20, [])) { /* drain */ }
  globalThis.fetch = originalFetch;
  const repairedChatMessages = directChatBodies[0]?.messages || [];
  const repairedChatCallIndex = repairedChatMessages.findIndex((message: any) => message.role === 'assistant'
    && message.tool_calls?.some((call: any) => call.id === 'call_chat_memory_read' && call.function?.name === 'memory_lab_read'));
  const repairedChatResultIndex = repairedChatMessages.findIndex((message: any) => message.role === 'tool'
    && message.tool_call_id === 'call_chat_memory_read');
  assert(repairedChatCallIndex >= 0 && repairedChatCallIndex < repairedChatResultIndex, 'LLMProvider Chat mode: repairs a migrated Memory Lab tool result with its required preceding assistant tool_calls message');

  directChatBodies.length = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    directChatBodies.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'partial tool group repaired' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  for await (const _tok of directChatProvider.chatStreamWithTools('gpt-5.4-mini', [
    { role: 'user', content: 'Run both checks' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_present', type: 'function', function: { name: 'read', arguments: '{"path":"README.md"}' } },
      { id: 'call_missing', type: 'function', function: { name: 'git_status', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_present', name: 'read', content: 'real read result' },
    { role: 'user', content: 'Continue' },
  ], null, 0, 20, [])) { /* drain */ }
  globalThis.fetch = originalFetch;
  const repairedPartialMessages = directChatBodies[0]?.messages || [];
  const partialAssistantIndex = repairedPartialMessages.findIndex((message: any) => message.role === 'assistant'
    && message.tool_calls?.some((call: any) => call.id === 'call_missing'));
  const presentResultIndex = repairedPartialMessages.findIndex((message: any) => message.role === 'tool'
    && message.tool_call_id === 'call_present' && message.content === 'real read result');
  const missingResultIndex = repairedPartialMessages.findIndex((message: any) => message.role === 'tool'
    && message.tool_call_id === 'call_missing' && String(message.content).includes('Tool result unavailable'));
  const continuedUserIndex = repairedPartialMessages.findIndex((message: any) => message.role === 'user' && message.content === 'Continue');
  assert(partialAssistantIndex >= 0
    && presentResultIndex === partialAssistantIndex + 1
    && missingResultIndex === partialAssistantIndex + 2
    && continuedUserIndex > missingResultIndex,
  'LLMProvider Chat mode: completes a partially persisted multi-tool call group before the next conversation message');

  let loopbackFetchCalls = 0;
  let loopbackNodePath = '';
  globalThis.fetch = (async () => {
    loopbackFetchCalls += 1;
    throw new Error('loopback chat must not use undici fetch');
  }) as typeof fetch;
  LLMProvider.nodeHttpTransport = async (_method, url) => {
    loopbackNodePath = new URL(url).pathname;
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'loopback chat ok' } }] }) };
  };
  const loopbackProvider = new LLMProvider('loopback-chat', 'http://127.0.0.1:45678/v1', 'test-key', 'openai', 'chat');
  const loopbackTokens: StreamToken[] = [];
  for await (const tok of loopbackProvider.chatStreamWithTools('local-model', [{ role: 'user', content: 'Hi' }], null, 0, 20, [])) loopbackTokens.push(tok);
  LLMProvider.nodeHttpTransport = null;
  globalThis.fetch = originalFetch;
  assert(loopbackFetchCalls === 0 && loopbackNodePath === '/v1/chat/completions' && loopbackTokens.some(t => t.text === 'loopback chat ok'), 'LLMProvider Chat mode: plain HTTP loopback uses deterministic Node transport for concurrent utility workers');
  const providerTransportSource = fs.readFileSync(path.join(process.cwd(), 'src', 'llm', 'provider.ts'), 'utf8');
  assert(providerTransportSource.includes("res.once('end', finish)")
    && providerTransportSource.includes("res.once('close'")
    && providerTransportSource.includes('if (res.complete) finish()')
    && providerTransportSource.includes("res.once('aborted'"), 'LLMProvider fallback: Node response lifecycle settles complete close and rejects incomplete or aborted bodies');

  const multimodalChatBodies: any[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    multimodalChatBodies.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'VISION_BODY_OK' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  await directChatProvider.chat('vision-model', [{ role: 'user', content: [{ type: 'text', text: 'inspect' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }] }], null, 0, 20);
  globalThis.fetch = originalFetch;
  assert(multimodalChatBodies[0]?.messages?.[0]?.content?.some((part: any) => part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/png;base64,')), 'LLMProvider Chat mode: sends pasted images as structured image_url content instead of Markdown text');

  const multimodalResponsesBodies: any[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    multimodalResponsesBodies.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify({ output_text: 'VISION_RESPONSES_OK' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const multimodalResponsesProvider = new LLMProvider('multimodal-responses', 'https://responses.example/v1', 'test-key', 'openai', 'responses');
  await multimodalResponsesProvider.chat('vision-model', [{ role: 'user', content: [{ type: 'text', text: 'inspect' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }] }], null, 0, 20);
  globalThis.fetch = originalFetch;
  assert(multimodalResponsesBodies[0]?.input?.[0]?.content?.some((part: any) => part.type === 'input_image' && part.image_url?.startsWith('data:image/png;base64,')), 'LLMProvider Responses mode: converts pasted images to input_image content');

  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'array chat text' }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const arrayChatText = await directChatProvider.chat('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], null, 0, 20);
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ text: 'legacy completion text' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const legacyChatText = await directChatProvider.chat('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], null, 0, 20);
  globalThis.fetch = originalFetch;
  assert(arrayChatText === 'array chat text' && legacyChatText === 'legacy completion text', 'LLMProvider Chat mode: parses content-part arrays and legacy choices text responses');

  globalThis.fetch = (async () => new Response('data: {"choices":[{"delta":{"content":[{"type":"text","text":"stream array text"}]}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
  const arrayStreamProvider = new LLMProvider('stream-array', 'https://chat.example/v1', 'test-key', 'openai', 'chat_stream');
  const arrayStreamTokens: StreamToken[] = [];
  for await (const tok of arrayStreamProvider.chatStreamWithTools('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], null, 0, 20, [])) arrayStreamTokens.push(tok);
  globalThis.fetch = originalFetch;
  assert(arrayStreamTokens.some(token => token.type === 'text' && token.text === 'stream array text'), 'LLMProvider Chat streaming: normalizes content-part delta arrays through the shared native extractor');

  const capabilityPaths: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    capabilityPaths.push(pathname);
    if (pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'vision-image-model', capabilities: ['vision', 'image_generation'] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (pathname.endsWith('/images/generations')) {
      return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const hasImage = String(init?.body || '').includes('data:image/png;base64');
    return new Response(JSON.stringify({ choices: [{ message: { content: hasImage ? 'RED_SQUARE' : 'TEXT_OK' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const capabilityProvider = new LLMProvider('capabilities', 'https://capabilities.example/v1', 'test-key', 'openai', 'chat');
  const capabilityCatalog = await capabilityProvider.modelCatalog();
  const capabilityVision = await capabilityProvider.validateVision('vision-image-model');
  const capabilityImage = await capabilityProvider.validateImageOutput('vision-image-model');
  const generatedImage = await capabilityProvider.generateImage('vision-image-model', 'A blue square', '256x256');
  globalThis.fetch = originalFetch;
  assert(capabilityCatalog[0]?.id === 'vision-image-model' && JSON.stringify(capabilityCatalog[0]?.raw).includes('image_generation'), 'LLMProvider capability validation: preserves provider catalog metadata');
  assert(capabilityVision.ok && capabilityImage.ok && generatedImage.dataUrl === 'data:image/png;base64,aW1hZ2U=' && capabilityPaths.filter(p => p.endsWith('/images/generations')).length >= 2, 'LLMProvider image generation: validation and real generation both call the native images endpoint');

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
