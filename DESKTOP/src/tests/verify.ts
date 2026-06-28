/**
 * Newmark Agent �?Comprehensive Feature Verification Tests
 * Tests every function without requiring a real LLM API.
 * Run: npm run build && node dist/tests/verify.js
 */
import * as fs from 'fs';
import * as path from 'path';
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
  fs.writeFileSync(path.join(TEST_DIR, 'PC_Hash.config'), 'test-pc|win32|x64');
  fs.writeFileSync(path.join(TEST_DIR, 'Work', 'Local.json'), '[]');
  fs.writeFileSync(path.join(TEST_DIR, 'Work', 'External.json'), '[]');
  fs.writeFileSync(path.join(TEST_DIR, 'test.txt'), 'Hello World\nLine 2\nLine 3\nFind me here\nEnd');
}

function cleanup() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
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
  assert(uiHtml.includes("window.openSubWin(t('model.addProvider')") && uiHtml.includes("window.openSubWin(t('model.addModel')") && uiHtml.includes("window.openSubWin(t('model.fuzzy')"), 'ui html: model secondary windows use i18n titles');
  assert(uiHtml.includes("window.openSubWin(t('automation.newTitle')") && uiHtml.includes("window.openSubWin(t('flow.title')") && uiHtml.includes("window.openSubWin(t('plugins.title')") && uiHtml.includes("window.openSubWin(t('workspace.new')"), 'ui html: automation flow plugins workspace secondary windows use i18n titles');
  assert(uiHtml.includes("t('plugins.marketHelp')") && uiHtml.includes("t('plugins.search')") && uiHtml.includes("t('archive.workspaceEmpty')") && uiHtml.includes("t('status.noPendingOptions')"), 'ui html: secondary panels use i18n body labels');
  assert(uiHtml.includes("window.openSubWin(t('model.validationTitle')") && uiHtml.includes("window.openSubWin(t('archive.titlePrefix') + ': '") && uiHtml.includes("window.openSubWin(t('workspace.requiredTitle')") && uiHtml.includes("window.openSubWin(t('workspace.newConversation')"), 'ui html: legacy secondary windows use i18n titles');
  assert(uiHtml.includes("t('workspace.selectOrCreate')") && uiHtml.includes("t('conversation.locked')") && uiHtml.includes("t('flow.runningPlaceholder')") && uiHtml.includes("t('subagent.empty')") && uiHtml.includes("t('fileTree.unavailable')"), 'ui html: workspace gate, conversation, Flow, subagent, and file-tree labels use i18n');
  assert(uiHtml.includes("badge.textContent = t('queue.next')") && uiHtml.includes("t('status.contextCompressed')") && uiHtml.includes("t('model.noValidationModels')") && uiHtml.includes("prompt(t('todo.addPrompt'))"), 'ui html: runtime dynamic text uses i18n helpers');
  assert(!uiHtml.includes("window.openSubWin('Model validation'") && !uiHtml.includes("window.openSubWin('Workspace required'") && !uiHtml.includes("window.openSubWin('New conversation'") && !uiHtml.includes("window.openSubWin('Plugin manager'"), 'ui html: dynamic window titles are not hard-coded English');
  assert(!/(^|[^<])\/(span|button|option|label|div)>/.test(uiHtml), 'ui html: no broken inline closing tags');
  assert(uiHtml.includes('New workspace'), 'ui html: new workspace label present');
  assert(uiHtml.includes('Flow editor'), 'ui html: flow editor label present');
  assert(uiHtml.includes('Ctrl+Enter uses the opposite mode.'), 'ui html: Ctrl+Enter setting text present');
  assert(uiHtml.includes("'model.fuzzy': 'Fuzzy inject model'") && uiHtml.includes("t('model.fuzzy')"), 'ui html: fuzzy injection label present through i18n');
  assert(uiHtml.includes('function redactSensitiveText(value)') && uiHtml.includes("replace(/sk-[A-Za-z0-9_\\-.]{8,}/g, 'sk-redacted')"), 'ui html: redacts API keys from visible messages');
  assert(uiHtml.includes("redactSensitiveText('[System] Fuzzy injection did not pass validation:") && uiHtml.includes("redactSensitiveText('[Error] Fuzzy injection failed:"), 'ui html: fuzzy injection messages are redacted');
  assert(uiHtml.includes('WORKFLOW TIMELINE') && uiHtml.includes('function renderChatMessages(messages)') && uiHtml.includes("addMsg('workflow running', 'Agent is working...'"), 'ui html: conversation renders as immediate workflow timeline');
  assert(uiHtml.includes('background: transparent;') && uiHtml.includes('border-radius: 0;') && uiHtml.includes('.chat-msg::before') && uiHtml.includes('.chat-msg::after'), 'ui html: chat messages are not bubble cards');
  assert(uiHtml.includes('return api.setConversation(conv.id).then(function(id)') && uiHtml.includes('return loadActiveConversationMessages();') && uiHtml.includes('if (s.chatMessages) renderChatMessages(s.chatMessages);'), 'ui html: workspace conversation switching reloads isolated backend messages');
  assert(uiHtml.includes("{ id: 'default', summary: t('workspace.defaultConversation')") && !uiHtml.includes("'conv-' + key + '-default'") && !uiHtml.includes("'conv-default-' + currentWorkspaceKey()"), 'ui html: default conversation id matches backend default id');
  assert(uiHtml.includes('function applyBackendConversations(items, activeId)') && uiHtml.includes('applyBackendConversations(s.conversations || [], s.conversationId'), 'ui html: reloads persisted conversation list from backend state');
  assert(uiHtml.includes('var lockedConversationId = activeConv && activeConv.id') && uiHtml.includes('api.sendMessage(text, lockedConversationId)') && uiHtml.includes('body.conversation = conversationId'), 'ui html: sends initiating conversation id with each agent turn');
  assert(uiHtml.includes('if (api.setMode) await api.setMode(state.mode)') && uiHtml.includes('if (api.setModel && state.model) await api.setModel(state.model)'), 'ui html: send synchronizes current mode and model before backend turn');
  assert(uiHtml.includes('renderConversations();') && uiHtml.includes('r.conversations') && uiHtml.includes('r.conversationId || lockedConversationId'), 'ui html: refreshes conversation titles from send response');
  assert(uiHtml.includes('Current conversation is locked while the agent is working') && uiHtml.includes('summary: item.title ||'), 'ui html: locks conversation switching while running and uses backend titles');
  assert(uiHtml.includes('function applyWorkspaceStateFromBackend(s)') && uiHtml.includes('window.openWorkspaceManager = async function()') && uiHtml.includes('await window.refreshWorkspaceState().catch(function(){})'), 'ui html: workspace manager refreshes backend workspace state before rendering');
  assert(uiHtml.includes('id="skill-market-search"') && uiHtml.includes('window.updateSkillMarketSearch') && uiHtml.includes('window.filteredSkillMarket') && uiHtml.includes('window.renderSkillsMarketList'), 'ui html: Skills Market has searchable filtered list');
  assert(uiHtml.includes("item.description || item.desc || ''") && uiHtml.includes("item.path || ''") && uiHtml.includes("item.url || ''") && uiHtml.includes('No matching skills.'), 'ui html: Skills Market search covers skill metadata and empty results');
  assert(uiHtml.includes('--right-width: 380px;') && uiHtml.includes('var rightSize = Math.max(340, Math.min(680, newSize2));'), 'ui html: right sidebar has larger default and resize range');
  assert(uiHtml.includes('lucide-sprite.svg#square-pen') && uiHtml.includes("iconOnly('square-pen', t('right.editor'))") && !uiHtml.includes('lucide-sprite.svg#edit'), 'ui html: Editor tab uses available open-source icon sprite symbol');
  assert(uiHtml.includes('function renderMessageContent(text)') && uiHtml.includes('class="msg-image"') && uiHtml.includes('normalizeImageSrc(imageUrl)') && uiHtml.includes("if (/^data:image\\//i.test(url)) return true;"), 'ui html: conversation renders returned markdown images, including data URLs');
  assert(uiHtml.includes('class="msg-file-link"') && uiHtml.includes('window.openLinkedFile = async function(path)') && uiHtml.includes("window.switchRightTab('editor');"), 'ui html: conversation file links open the right editor');
  assert(uiHtml.includes("els['md-viewer-content'] = nextMd;") && uiHtml.includes('window.getMarkdownContentNode = function()') && uiHtml.includes("var mc = window.getMarkdownContentNode();") && uiHtml.includes("window.switchRightTab('md-viewer');"), 'ui html: markdown viewer writes to the rebuilt live panel node');
  assert(uiHtml.includes('function optionLabel(option)') && uiHtml.includes('function renderPendingOptionsInChat(options)') && uiHtml.includes("state.renderedOptionKeys[key] = true"), 'ui html: pending option feedback renders into chat once');
  assert(uiHtml.includes('if (r && r.options)') && uiHtml.includes('renderPendingOptionsInChat(state.pendingOptions)') && uiHtml.includes("optionDescription(opt)"), 'ui html: send result and right status render structured option labels');
  assert(uiHtml.includes('window.runFlowWork = async function(workIdx)') && uiHtml.includes("await api.saveFile('Flow/' + normalized.name + '.Flow.json'") && uiHtml.includes('api.runFlow(normalized.name, flowInput, 0)') && uiHtml.includes('renderChatMessages(r.chatMessages)'), 'ui html: Flow Run uses backend core runner and renders returned messages');
  assert(uiHtml.includes('function stopFlowRunInternal()') && uiHtml.includes('window.stopFlowRun = function()') && uiHtml.includes('stopFlowRunInternal();') && !uiHtml.includes('window.stopFlowRun = function() {\n  stopFlowRun();'), 'ui html: Flow stop handler avoids global recursive self-call');
  assert(uiHtml.includes("(effectiveInputMode === 'next' || state._sendInFlight) && !opts.fromQueue") && uiHtml.includes('[Queue] Current turn is locked; prompt will run after it completes.'), 'ui html: input during running agent turn is queued instead of dropped');
  assert(uiHtml.includes('id="terminal-timeout-input"') && uiHtml.includes('Max ms') && uiHtml.includes('Terminal timeout cap') && uiHtml.includes('window.setTerminalInterruptTimeout = function(value)') && uiHtml.includes("api.saveSetting('terminal', 'interrupt_timeout_ms', n)"), 'ui html: terminal timeout cap is editable and persisted');
  assert(uiHtml.includes('window.refreshSkillsRuntime = function(next)') && uiHtml.includes('api.refreshSkills().then(done)') && uiHtml.includes('window.refreshSkillsRuntime(function(){ window.showPluginList'), 'ui html: skills changes refresh runtime without restart');
  assert(uiHtml.includes('api.updateGoal(state.goalText)') && uiHtml.includes('api.toggleGoalPause().then'), 'ui html: Goal edits and pause are synchronized to Agent backend');
  assert(uiHtml.includes('window.setRightWidthPx = function(px)') && uiHtml.includes("document.documentElement.style.setProperty('--right-width', rightSize + 'px')") && uiHtml.includes('if (els.right) els.right.style.width = \'\';'), 'ui html: right resize stores width in CSS variable and clears inline width');
  assert(uiHtml.includes('window.setRightCollapsed = function(collapsed)') && uiHtml.includes('els.right.style.width = \'\';') && uiHtml.includes("els.right.classList.toggle('open', !state.rightCollapsed);"), 'ui html: right collapse releases inline width and open class');
  assert(uiHtml.includes('window.toggleRight = function()') && uiHtml.includes('window.setRightCollapsed(!state.rightCollapsed);'), 'ui html: right toggle uses unified collapse state');
  assert(uiHtml.includes('window.setRightWidthPx(rightSize);') && !uiHtml.includes("el.style.width = rightSize + 'px';"), 'ui html: right resize does not pin layout with inline width');
  assert(/if \(state\.rightCollapsed\) \{\s*window\.setRightCollapsed\(false\);\s*\}/.test(uiHtml), 'ui html: right tab switching reopens through unified collapse state');
  assert(uiHtml.includes('data-tab="plan"') && uiHtml.includes('Conversation plan') && uiHtml.includes("iconOnly('list-checks', t('right.plan'))"), 'ui html: right sidebar has current conversation plan tab');
  assert(uiHtml.includes('window.refreshConversationPlan = function()') && uiHtml.includes('window.persistConversationPlan = function()') && uiHtml.includes('window.addConversationPlanItem = function()'), 'ui html: conversation plan panel has refresh, persist, and add handlers');
  assert(uiHtml.includes('window.cycleConversationPlanItem = function(idx)') && uiHtml.includes('window.editConversationPlanItem = function(idx)') && uiHtml.includes('window.deleteConversationPlanItem = function(idx)'), 'ui html: conversation plan supports status cycle, edit, and delete');
  assert(uiHtml.includes('if (s && s.conversationPlan)') && uiHtml.includes('state.conversationPlan = normalizeConversationPlan(s.conversationPlan)') && uiHtml.includes("if (state.rightTab === 'plan') window.renderConversationPlan();"), 'ui html: conversation plan refreshes from backend state');
  const distUiHtmlPath = path.join(process.cwd(), 'dist', 'ui', 'index.html');
  assert(fs.existsSync(distUiHtmlPath), 'ui dist html: generated index exists');
  const distUiHtml = fs.readFileSync(distUiHtmlPath, 'utf-8');
  assert(distUiHtml.includes('id="lucide-sprite-root"'), 'ui dist html: embeds lucide sprite');
  assert(!distUiHtml.includes('href="lucide-sprite.svg#'), 'ui dist html: no external lucide hrefs');
  assert(distUiHtml.includes('href="#message-square') && distUiHtml.includes('href="#send'), 'ui dist html: local icon hrefs present');
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
  const preloadPath = path.join(process.cwd(), 'dist', 'preload.js');
  const preloadJs = fs.existsSync(preloadPath) ? fs.readFileSync(preloadPath, 'utf-8') : '';
  assert(preloadJs.includes('runFlow') && preloadJs.includes('flow:run'), 'preload: exposes core Flow runner IPC');
  const launcherTs = fs.readFileSync(path.join(process.cwd(), 'src', 'launcher.ts'), 'utf-8');
  const mainTs = fs.readFileSync(path.join(process.cwd(), 'src', 'main.ts'), 'utf-8');
  const serverTs = fs.readFileSync(path.join(process.cwd(), 'src', 'server.ts'), 'utf-8');
  const preloadTs = fs.readFileSync(path.join(process.cwd(), 'src', 'preload.ts'), 'utf-8');
  const toolsTs = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'index.ts'), 'utf-8');
  const agentTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agent.ts'), 'utf-8');
  const workspaceTs = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'workspace.ts'), 'utf-8');
  const cliCommandsTs = fs.readFileSync(path.join(process.cwd(), 'src', 'cli-commands.ts'), 'utf-8');
  const releaseCliSmokePath = path.join(process.cwd(), 'scripts', 'release-cli-smoke.cjs');
  const releaseCliSmoke = fs.existsSync(releaseCliSmokePath) ? fs.readFileSync(releaseCliSmokePath, 'utf-8') : '';
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
  const releaseUiFlowSubagentSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-flow-subagent-smoke.cjs');
  const releaseUiFlowSubagentSmoke = fs.existsSync(releaseUiFlowSubagentSmokePath) ? fs.readFileSync(releaseUiFlowSubagentSmokePath, 'utf-8') : '';
  const releaseUiMediaMdSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-media-md-smoke.cjs');
  const releaseUiMediaMdSmoke = fs.existsSync(releaseUiMediaMdSmokePath) ? fs.readFileSync(releaseUiMediaMdSmokePath, 'utf-8') : '';
  const releaseUiSkillsSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-skills-smoke.cjs');
  const releaseUiSkillsSmoke = fs.existsSync(releaseUiSkillsSmokePath) ? fs.readFileSync(releaseUiSkillsSmokePath, 'utf-8') : '';
  const releaseUiConversationQueuePlanSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-conversation-queue-plan-smoke.cjs');
  const releaseUiConversationQueuePlanSmoke = fs.existsSync(releaseUiConversationQueuePlanSmokePath) ? fs.readFileSync(releaseUiConversationQueuePlanSmokePath, 'utf-8') : '';
  const releaseUiGoalContinuationSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-goal-continuation-smoke.cjs');
  const releaseUiGoalContinuationSmoke = fs.existsSync(releaseUiGoalContinuationSmokePath) ? fs.readFileSync(releaseUiGoalContinuationSmokePath, 'utf-8') : '';
  const releaseUiWorkspaceLifecycleSmokePath = path.join(process.cwd(), 'scripts', 'release-ui-workspace-lifecycle-smoke.cjs');
  const releaseUiWorkspaceLifecycleSmoke = fs.existsSync(releaseUiWorkspaceLifecycleSmokePath) ? fs.readFileSync(releaseUiWorkspaceLifecycleSmokePath, 'utf-8') : '';
  const releaseUiStartupRecoverySmokePath = path.join(process.cwd(), 'scripts', 'release-ui-startup-recovery-smoke.cjs');
  const releaseUiStartupRecoverySmoke = fs.existsSync(releaseUiStartupRecoverySmokePath) ? fs.readFileSync(releaseUiStartupRecoverySmokePath, 'utf-8') : '';
  const releaseRealProviderSmokePath = path.join(process.cwd(), 'scripts', 'release-real-provider-smoke.cjs');
  const releaseRealProviderSmoke = fs.existsSync(releaseRealProviderSmokePath) ? fs.readFileSync(releaseRealProviderSmokePath, 'utf-8') : '';
  const releaseRealProviderStressPath = path.join(process.cwd(), 'scripts', 'release-real-provider-stress.cjs');
  const releaseRealProviderStress = fs.existsSync(releaseRealProviderStressPath) ? fs.readFileSync(releaseRealProviderStressPath, 'utf-8') : '';
  const releaseRealClaudeEnvPreviewSmokePath = path.join(process.cwd(), 'scripts', 'release-real-claude-env-preview-smoke.cjs');
  const releaseRealClaudeEnvPreviewSmoke = fs.existsSync(releaseRealClaudeEnvPreviewSmokePath) ? fs.readFileSync(releaseRealClaudeEnvPreviewSmokePath, 'utf-8') : '';
  const distPortableScript = fs.readFileSync(path.join(process.cwd(), 'scripts', 'dist-portable.cjs'), 'utf-8');
  const packageJson = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8');
  const electronBuilderConfigTs = fs.readFileSync(path.join(process.cwd(), 'electron-builder.config.ts'), 'utf-8');
  const appIconIcoPath = path.join(process.cwd(), 'assets', 'icon.ico');
  const appIconIco = fs.existsSync(appIconIcoPath) ? fs.readFileSync(appIconIcoPath) : Buffer.alloc(0);
  assert(launcherTs.includes('drainCliNetworkHandles') && mainTs.includes('drainCliNetworkHandles') && launcherTs.includes('getGlobalDispatcher') && mainTs.includes('getGlobalDispatcher'), 'cli entrypoints: drain async network handles before exit');
  assert(fs.existsSync(path.join(process.cwd(), 'assets', 'app-icon-dark.png')) && fs.existsSync(path.join(process.cwd(), 'assets', 'app-icon-light.png')) && appIconIco.length > 6 && appIconIco.readUInt16LE(2) === 1 && appIconIco.readUInt16LE(4) >= 1, 'app icons: themed PNG assets and Windows ICO exist');
  assert(packageJson.includes('"icon": "assets/icon.ico"') && electronBuilderConfigTs.includes("icon: 'assets/icon.ico'"), 'app icons: Windows package uses generated ICO');
  assert(mainTs.includes('nativeTheme') && mainTs.includes("app-icon-light.png") && mainTs.includes("app-icon-dark.png") && mainTs.includes('createAppIconImage(16)') && mainTs.includes('icon: themedAppIconPath()'), 'app icons: runtime windows and tray use themed assets');
  assert(packageJson.includes('"release:cli-smoke"') && releaseCliSmoke.includes('Start-Process') && releaseCliSmoke.includes('-RedirectStandardOutput'), 'release cli smoke: uses stable redirected packaged exe invocation');
  assert(releaseCliSmoke.includes("['state', '--root', root]") && releaseCliSmoke.includes("['tool', 'write'") && releaseCliSmoke.includes("'--args-file'") && releaseCliSmoke.includes("['send', '--input-file'") && releaseCliSmoke.includes("['validate-models', '--selected', 'ReleaseCliMock/release-cli-mock'") && releaseCliSmoke.includes("['skills-market'"), 'release cli smoke: covers state, tool, send, validate-models, and skills-market');
  assert(releaseCliSmoke.includes('RELEASE_CLI_SEND_OK 做了什么 验证 文件') && releaseCliSmoke.includes('"stream":true'), 'release cli smoke: covers UTF-8 streaming send output');
  assert(packageJson.includes('"release:ui-smoke"') && releaseUiSmoke.includes('--remote-debugging-port=') && releaseUiSmoke.includes('window.fuzzyInject()') && releaseUiSmoke.includes('window.showPluginList()') && releaseUiSmoke.includes('window.showFlowEditor()') && releaseUiSmoke.includes('window.showNewConversationPage()') && releaseUiSmoke.includes('window.showWorkspaceRequired()'), 'release ui smoke: validates real packaged secondary windows through CDP');
  assert(releaseUiSmoke.includes("'zh-CN'") && releaseUiSmoke.includes("'输入指令...'") && releaseUiSmoke.includes("'模糊注入模型'") && releaseUiSmoke.includes("'需要工作区'") && releaseUiSmoke.includes('language en/zh switch ok'), 'release ui smoke: validates Chinese language switching in packaged UI');
  assert(releaseUiSmoke.includes("leftNewChat: 'New chat'") && releaseUiSmoke.includes("leftNewChat: '新对话'") && releaseUiSmoke.includes("secondarySettingsTitle: '工作区设置'") && releaseUiSmoke.includes("english-after"), 'release ui smoke: validates bidirectional language switching in packaged UI');
  assert(releaseUiSmoke.includes("await setLanguage(cdp, 'auto')") && releaseUiSmoke.includes('auto-before persisted language mismatch') && releaseUiSmoke.includes("['Input instruction...', '输入指令...']"), 'release ui smoke: validates auto language switching and persistence in packaged UI');
  assert(releaseUiSmoke.includes('function seedDynamicI18nState') && releaseUiSmoke.includes("contextCompression: '上下文已压缩 | 模型 | 8 -> 2 条消息'") && releaseUiSmoke.includes("nextQueue: '下一轮 1'") && releaseUiSmoke.includes("modelAuto: '自动'"), 'release ui smoke: validates dynamic language switching in packaged UI');
  assert(releaseUiSmoke.includes('function readModelSettingsSnapshot') && releaseUiSmoke.includes("englishModels.chips.some(chip => chip.text.includes('available'))") && releaseUiSmoke.includes("chineseModels.chips.some(chip => chip.text.includes('不可用'))"), 'release ui smoke: validates model settings bilingual status/action labels');
  assert(releaseUiSmoke.includes('activeSubWindowAfterSwitch') && releaseUiSmoke.includes('Workspace required') && releaseUiSmoke.includes('Conversations are bound to a workspace.'), 'release ui smoke: validates active secondary window rerenders after language switch');
  assert(releaseUiSmoke.includes('function captureScreenshot') && releaseUiSmoke.includes('Emulation.setDeviceMetricsOverride') && releaseUiSmoke.includes('viewport-from-surface') && releaseUiSmoke.includes('screenshot capture failed'), 'release ui smoke: requires hardened screenshot capture evidence');
  assert(releaseUiSmoke.includes('function captureOsScreenshot') && releaseUiSmoke.includes('System.Windows.Forms.Screen') && releaseUiSmoke.includes('os-fallback'), 'release ui smoke: falls back to OS screenshot when CDP screenshot stalls');
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
  assert(packageJson.includes('"release:ui-flow-subagent-smoke"') && releaseUiFlowSubagentSmoke.includes('--remote-debugging-port=') && releaseUiFlowSubagentSmoke.includes('window.sendMessage()') && releaseUiFlowSubagentSmoke.includes('release-ui-flow-subagent-mock'), 'release ui Flow/subagent smoke: drives real packaged renderer send path through CDP mock provider');
  assert(releaseUiFlowSubagentSmoke.includes('flow_save') && releaseUiFlowSubagentSmoke.includes('flow_list') && releaseUiFlowSubagentSmoke.includes('flow_run') && releaseUiFlowSubagentSmoke.includes('FLOW_COMPONENT_RUNTIME_INPUT'), 'release ui Flow/subagent smoke: covers agent-designed Flow save, list, and trigger');
  assert(releaseUiFlowSubagentSmoke.includes('task') && releaseUiFlowSubagentSmoke.includes('subagent_send') && releaseUiFlowSubagentSmoke.includes('subagent_result') && releaseUiFlowSubagentSmoke.includes('subagent_close'), 'release ui Flow/subagent smoke: covers subagent create, continue, result, and close');
  assert(releaseUiFlowSubagentSmoke.includes("window.switchRightTab('subagent')") && releaseUiFlowSubagentSmoke.includes("window.openSubagentHistory('release-child')") && releaseUiFlowSubagentSmoke.includes('Subagent history is read-only'), 'release ui Flow/subagent smoke: validates retained read-only subagent history UI');
  assert(packageJson.includes('"release:ui-media-md-smoke"') && releaseUiMediaMdSmoke.includes('--remote-debugging-port=') && releaseUiMediaMdSmoke.includes('window.api.createWorkspace') && releaseUiMediaMdSmoke.includes('addMsg('), 'release ui media/md smoke: drives real packaged renderer without model spend');
  assert(releaseUiMediaMdSmoke.includes('data:image/gif;base64') && releaseUiMediaMdSmoke.includes('.msg-image') && releaseUiMediaMdSmoke.includes('.msg-file-link'), 'release ui media/md smoke: validates markdown image and file-link rendering');
  assert(releaseUiMediaMdSmoke.includes("window.openFile('media-doc.md')") && releaseUiMediaMdSmoke.includes('#panel-md-viewer') && releaseUiMediaMdSmoke.includes('MD_VIEWER_OK_20260628'), 'release ui media/md smoke: validates markdown viewer rendering');
  assert(releaseUiMediaMdSmoke.includes('#editor-textarea') && releaseUiMediaMdSmoke.includes('EDITOR_LINK_TARGET_OK_20260628') && releaseUiMediaMdSmoke.includes("window.switchRightTab('file-tree')"), 'release ui media/md smoke: validates linked file editor and file tree');
  assert(releaseUiMediaMdSmoke.includes('Page.captureScreenshot') && releaseUiMediaMdSmoke.includes('2026-06-28-release-ui-media-md-smoke.png'), 'release ui media/md smoke: captures visual evidence');
  assert(packageJson.includes('"release:ui-skills-smoke"') && releaseUiSkillsSmoke.includes('--remote-debugging-port=') && releaseUiSkillsSmoke.includes("window.showPluginList('market')") && releaseUiSkillsSmoke.includes('#skill-market-search'), 'release ui skills smoke: drives real packaged Plugins Skills Market through CDP');
  assert(releaseUiSkillsSmoke.includes('installLocalSkill') && releaseUiSkillsSmoke.includes('release-ui-local-skill') && releaseUiSkillsSmoke.includes('window.refreshSkillsRuntime'), 'release ui skills smoke: installs local skill and refreshes runtime without restart');
  assert(releaseUiSkillsSmoke.includes("window.toggleSkillEnabled('release-ui-local-skill', false)") && releaseUiSkillsSmoke.includes("window.toggleSkillEnabled('release-ui-local-skill', true)") && releaseUiSkillsSmoke.includes("window.removeSkillFromUi('release-ui-local-skill')"), 'release ui skills smoke: covers skill disable, enable, and remove');
  assert(releaseUiSkillsSmoke.includes('No matching skills.') && releaseUiSkillsSmoke.includes('Page.captureScreenshot') && releaseUiSkillsSmoke.includes('2026-06-28-release-ui-skills-smoke.png'), 'release ui skills smoke: covers market search empty state and screenshot evidence');
  assert(packageJson.includes('"release:ui-conversation-queue-plan-smoke"') && releaseUiConversationQueuePlanSmoke.includes('--remote-debugging-port=') && releaseUiConversationQueuePlanSmoke.includes('QUEUE_FIRST_LOCK_TEST') && releaseUiConversationQueuePlanSmoke.includes('QUEUE_SECOND_AUTO_BUILD'), 'release ui conversation queue/plan smoke: drives real packaged queued conversation path through CDP');
  assert(releaseUiConversationQueuePlanSmoke.includes("window.switchRightTab('plan')") && releaseUiConversationQueuePlanSmoke.includes('PLAN_ITEM_CONV1_20260628') && releaseUiConversationQueuePlanSmoke.includes('PLAN_ITEM_CONV2_20260628'), 'release ui conversation queue/plan smoke: covers right sidebar plan isolation');
  assert(releaseUiConversationQueuePlanSmoke.includes('Current conversation is locked while the agent is working') && releaseUiConversationQueuePlanSmoke.includes('#next-queue-count') && releaseUiConversationQueuePlanSmoke.includes('QUEUE_SECOND_DONE_20260628'), 'release ui conversation queue/plan smoke: covers active-turn conversation lock and queue drain');
  assert(releaseUiConversationQueuePlanSmoke.includes('Page.captureScreenshot') && releaseUiConversationQueuePlanSmoke.includes('2026-06-28-release-ui-conversation-queue-plan-smoke.png'), 'release ui conversation queue/plan smoke: captures visual evidence');
  assert(packageJson.includes('"release:ui-goal-continuation-smoke"') && releaseUiGoalContinuationSmoke.includes('RELEASE_UI_GOAL_CONTINUATION') && releaseUiGoalContinuationSmoke.includes('mock.getGoalCalls() < 3'), 'release ui goal continuation smoke: covers repeated autonomous Goal model calls');
  assert(releaseUiGoalContinuationSmoke.includes('max[- ]?depth') && releaseUiGoalContinuationSmoke.includes('2026-06-28-release-ui-goal-continuation-smoke.png'), 'release ui goal continuation smoke: rejects max-depth warnings and captures visual evidence');
  assert(packageJson.includes('"release:ui-workspace-lifecycle-smoke"') && releaseUiWorkspaceLifecycleSmoke.includes("window.api.createWorkspace('lifecycle-alpha')") && releaseUiWorkspaceLifecycleSmoke.includes("window.api.selectWorkspace('lifecycle-beta')"), 'release ui workspace lifecycle smoke: covers internal workspace create and switch');
  assert(releaseUiWorkspaceLifecycleSmoke.includes("window.api.deleteWorkspace('lifecycle-alpha')") && releaseUiWorkspaceLifecycleSmoke.includes('Local.json still contains deleted workspace') && releaseUiWorkspaceLifecycleSmoke.includes('deleted internal workspace directory still exists'), 'release ui workspace lifecycle smoke: covers internal workspace deletion registry and directory');
  assert(releaseUiWorkspaceLifecycleSmoke.includes('clearTimeout(callbacks.timer)') && releaseUiWorkspaceLifecycleSmoke.includes('Promise.resolve(window.openWorkspaceManager()).then(() => true)'), 'release ui workspace lifecycle smoke: cleans CDP timers and awaits async workspace manager refresh');
  assert(packageJson.includes('"release:ui-startup-recovery-smoke"') && releaseUiStartupRecoverySmoke.includes('--remote-debugging-port=') && releaseUiStartupRecoverySmoke.includes('NewmarkReleaseStartupRecovery-'), 'release ui startup recovery smoke: drives real packaged startup through CDP with a fresh root');
  assert(releaseUiStartupRecoverySmoke.includes("['skills', 'Work', 'Flow', 'archive', 'config.json', 'agent.md', 'PC_Hash.config']") && releaseUiStartupRecoverySmoke.includes("path.join('Flow', 'Flow.md')") && releaseUiStartupRecoverySmoke.includes("path.join('Work', 'State.json')"), 'release ui startup recovery smoke: verifies required companion files');
  assert(releaseUiStartupRecoverySmoke.includes('auto_create_timestamp_workspace') && releaseUiStartupRecoverySmoke.includes('Local.json did not contain one default internal workspace') && releaseUiStartupRecoverySmoke.includes('default workspace is not timestamp-like'), 'release ui startup recovery smoke: verifies default timestamp internal workspace');
  assert(releaseUiStartupRecoverySmoke.includes('window.api.getState()') && releaseUiStartupRecoverySmoke.includes('Page.captureScreenshot') && releaseUiStartupRecoverySmoke.includes('2026-06-28-release-ui-startup-recovery-smoke.png'), 'release ui startup recovery smoke: verifies renderer state and captures visual evidence');
  assert(packageJson.includes('"release:real-provider-smoke"') && releaseRealProviderSmoke.includes('NEWMARK_APINEBULA_KEY') && releaseRealProviderSmoke.includes('REAL_PROVIDER_CLI_OK_20260627') && releaseRealProviderSmoke.includes('REAL_PROVIDER_UI_OK_20260627'), 'release real provider smoke: opt-in APInebula CLI and UI path exists');
  assert(releaseRealProviderSmoke.includes('real-provider UI idle after marker') && releaseRealProviderSmoke.includes("state.status !== 'idle'"), 'release real provider smoke: waits for UI idle after visible marker');
  assert(releaseRealProviderSmoke.includes('NEWMARK_REAL_UTF8') && releaseRealProviderSmoke.includes('真实UTF8_CLI_通过') && releaseRealProviderSmoke.includes('真实UTF8_UI_通过'), 'release real provider smoke: has opt-in real UTF-8 CLI and UI checks');
  assert(releaseRealProviderSmoke.includes('NEWMARK_REAL_INCLUDE_CLAUDE_ENV') && releaseRealProviderSmoke.includes('NEWMARK_REAL_CLAUDE_ENV_FILE') && releaseRealProviderSmoke.includes('Claude env fuzzy-inject skipped'), 'release real provider smoke: Claude env injection is explicit opt-in');
  assert(releaseRealProviderSmoke.includes('sanitize(error.message)') && releaseRealProviderSmoke.includes('renderer state leaked API key') && releaseRealProviderSmoke.includes('validate-models leaked API key'), 'release real provider smoke: redacts and guards API keys');
  assert(packageJson.includes('"release:real-provider-stress"') && releaseRealProviderStress.includes('NEWMARK_REAL_STRESS_BASE_URL') && releaseRealProviderStress.includes('NEWMARK_REAL_STRESS_KEY') && releaseRealProviderStress.includes('ANTHROPIC_AUTH_TOKEN'), 'release real provider stress: npm entry and credential fallback exist');
  assert(releaseRealProviderStress.includes('cliRounds') && releaseRealProviderStress.includes('uiRounds') && releaseRealProviderStress.includes('goalRounds') && releaseRealProviderStress.includes('timeoutMs'), 'release real provider stress: configurable rounds and timeout exist');
  assert(releaseRealProviderStress.includes('runCliStress') && releaseRealProviderStress.includes('runUiStress') && releaseRealProviderStress.includes('runGoalStress') && releaseRealProviderStress.includes('runQueueStress') && releaseRealProviderStress.includes('runConversationIsolationStress') && releaseRealProviderStress.includes('runLongContextStress'), 'release real provider stress: covers CLI UI Goal queue conversation-isolation and long-context scenarios');
  assert(releaseRealProviderStress.includes('conversation-isolation') && releaseRealProviderStress.includes('conversation histories isolated') && releaseRealProviderStress.includes('state leaked B marker') && releaseRealProviderStress.includes('state leaked A marker'), 'release real provider stress: verifies conversation histories do not leak across real-provider conversations');
  assert(releaseRealProviderStress.includes('tokens: sendA && sendA.tokens') && releaseRealProviderStress.includes('chatMessages: sendB && sendB.chatMessages'), 'release real provider stress: conversation response leak checks ignore cross-conversation title lists');
  assert(releaseRealProviderStress.includes('release-process-cleanup') && releaseRealProviderStress.includes('renderer state leaked API key') && releaseRealProviderStress.includes('未执行真实重压：缺少凭据') && releaseRealProviderStress.includes('real-provider-stress-debug.md'), 'release real provider stress: records cleanup, secret guards, skip path, and archive report');
  assert(!releaseRealProviderStress.includes('baseUrlHost'), 'release real provider stress: report omits provider host/private URL');
  assert(releaseRealProviderStress.includes('clearTimeout(callbacks.timer)'), 'release real provider stress: clears CDP timeout handles after responses');
  assert(cliCommandsTs.includes("args.includes('--preview-only')") && cliCommandsTs.includes('preview: true') && cliCommandsTs.includes('has_api_key') && cliCommandsTs.includes('redactUrlSecret'), 'cli commands: fuzzy-inject preview-only redacts and avoids provider calls');
  assert(packageJson.includes('"release:real-claude-env-preview-smoke"') && releaseRealClaudeEnvPreviewSmoke.includes('NEWMARK_REAL_CLAUDE_ENV_FILE') && releaseRealClaudeEnvPreviewSmoke.includes('--preview-only'), 'release real Claude env preview smoke: uses explicit env file in preview-only mode');
  assert(releaseRealClaudeEnvPreviewSmoke.includes('DeepSeekAnthropic') && releaseRealClaudeEnvPreviewSmoke.includes('deepseek-v4-pro[1m]') && releaseRealClaudeEnvPreviewSmoke.includes('deepseek-v4-flash') && releaseRealClaudeEnvPreviewSmoke.includes('preview leaked Claude env API key/token'), 'release real Claude env preview smoke: validates DeepSeek env parsing without leaking secrets');
  assert(distPortableScript.includes('verifyReleaseCliSmoke()') && distPortableScript.includes('release-cli-smoke.cjs'), 'dist portable: runs release CLI smoke after packaging');
  assert(mainTs.includes('if (automationWakeMode)') && mainTs.includes('await automation.tick()') && mainTs.includes('app.quit();') && mainTs.indexOf('if (automationWakeMode)') < mainTs.indexOf('void startSidecar(root)'), 'main automation wake: runs due schedules headless and exits before sidecar/window setup');
  assert(preloadTs.includes("refreshSkills: () => ipcRenderer.invoke('skills:refresh')") && preloadTs.includes('terminalKill: (sessionId: string, timeoutMs?: number)'), 'preload: exposes skills refresh and terminal kill timeout');
  assert(preloadTs.includes('saveConfig: (cfg: string | Record<string, unknown>)'), 'preload: saveConfig accepts structured config patches');
  assert(preloadTs.includes("getConversationPlan: () => ipcRenderer.invoke('agent:getConversationPlan')") && preloadTs.includes("updateConversationPlan: (plan: Record<string, unknown>) => ipcRenderer.invoke('agent:updateConversationPlan', plan)"), 'preload: exposes conversation plan IPC');
  assert(mainTs.includes("language: agent.config.getStr('general', 'language')") && mainTs.includes("case 'language': agent.config.set('general', 'language', value); break;"), 'main ipc: exposes and persists language setting');
  assert(serverTs.includes("language: agent.config.getStr('general', 'language')") && serverTs.includes("case 'language': agent.config.set('general', 'language', value); break;"), 'server api: exposes and persists language setting');
  assert(cliCommandsTs.includes("language: agent.config.getStr('general', 'language') || 'auto'") && cliCommandsTs.includes("const language = argValue(args, '--language')") && cliCommandsTs.includes("[--language auto|en|zh]"), 'cli commands: expose and accept language switching');
  assert(mainTs.includes('sanitizeProvidersForState(agent.config.providers())') && mainTs.includes('mergeProviderSecrets(value, agent.config.providers())'), 'main ipc: redacts provider keys and preserves secrets on provider save');
  assert(serverTs.includes('sanitizeProvidersForState(agent.config.providers())') && serverTs.includes('mergeProviderSecrets(value, agent.config.providers())'), 'server api: redacts provider keys and preserves secrets on provider save');
  assert(mainTs.includes("ipcMain.handle('skills:refresh'") && mainTs.includes('agent.refreshSkills();') && mainTs.includes('terminalInterruptTimeoutMs'), 'main ipc: refreshes skills runtime and returns terminal timeout state');
  assert(mainTs.includes("ipcMain.handle('agent:getConversationPlan'") && mainTs.includes("ipcMain.handle('agent:updateConversationPlan'") && mainTs.includes('conversationPlan: agent.getConversationPlan()'), 'main ipc: exposes and returns conversation plan state');
  assert(mainTs.includes("ipcMain.handle('flow:run'") && mainTs.includes('chatMessages: agent.chatMessages') && mainTs.includes('conversations: agent.listConversationStates()'), 'main ipc: Flow run returns rendered conversation state');
  assert(mainTs.includes("ipcMain.handle('pty:kill'") && mainTs.includes('waitMs === 0') && mainTs.includes("session.proc.kill('SIGINT')"), 'main ipc: terminal interrupt timeout supports unlimited mode');
  assert(mainTs.includes('agent.subagents.listAll().map') && mainTs.includes("active: s.status !== 'closed'") && uiHtml.includes("t('subagent.empty')"), 'main ipc/ui: closed subagents remain visible as retained history');
  assert(toolsTs.includes('timeout_ms') && toolsTs.includes('resolveBashTimeout') && toolsTs.includes("this.config.getNum('terminal', 'interrupt_timeout_ms')"), 'tools: agent bash accepts per-call timeout and reads config cap');
  assert(agentTs.includes('Agent terminal timeout: bash accepts per-call timeout_ms') && agentTs.includes('is a nonzero upper cap'), 'agent prompt: discloses bash timeout_ms and settings cap semantics');
  assert(agentTs.includes('refreshSkills(): void') && agentTs.includes('this.skills = new SkillsManager(this.rootPath);'), 'agent core: skills manager can be refreshed without restart');
  assert(workspaceTs.includes('removeInternalDirectory') && workspaceTs.includes('if (!this.removeInternalDirectory(removedWorkspace.path)) return false;') && workspaceTs.includes('clearReadOnlyRecursive'), 'workspace core: internal delete verifies directory removal before returning success');
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

  // Test save
  cfg.save();
  const cfg2 = new ConfigManager(TEST_DIR);
  assert(cfg2.providers().length === 2, 'config persisted');

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

  // ---- 2. Tool Executor Tests ----
  console.log('\n🔧 Tool Executor');
  const tools = new ToolExecutor(TEST_DIR, cfg);

  // bash
  const bashResult = await tools.execute('bash', '{"command":"echo hello"}', TEST_DIR);
  assert(bashResult.includes('hello'), 'bash: echo hello');
  const bashPWSH = await tools.execute('bash', '{"command":"Get-Location"}', TEST_DIR);
  assert(bashPWSH.length > 0, 'bash: powershell works');
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
  const outsideBashReadAllowed = await tools.execute('bash', JSON.stringify({ command: `Get-Content "${outsideFile}"` }), TEST_DIR, { workspacePath: TEST_DIR });
  assert(outsideBashReadAllowed.includes('outside'), 'permissions: outside_readonly allows read-only bash outside workspace');
  const outsideBashWriteDenied = await tools.execute('bash', JSON.stringify({ command: `Set-Content "${outsideFile}" blocked` }), TEST_DIR, { workspacePath: TEST_DIR });
  assert(outsideBashWriteDenied.includes('[permission]'), 'permissions: outside_readonly blocks mutating bash outside workspace');
  cfg.set('workspace', 'access_permission', 'no_outside_access');
  const outsideBashReadDenied = await tools.execute('bash', JSON.stringify({ command: `Get-Content "${outsideFile}"` }), TEST_DIR, { workspacePath: TEST_DIR });
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
  assert(tools.definitions().some((tool: any) => tool.function?.name === 'browser_open'), 'definitions: exposes browser_open');
  assert(tools.definitions().some((tool: any) => tool.function?.name === 'browser_cdp'), 'definitions: exposes browser_cdp');
  assert(tools.definitions('plan').some((tool: any) => tool.function?.name === 'browser_snapshot'), 'definitions: plan exposes browser_snapshot');
  assert(!tools.definitions('plan').some((tool: any) => tool.function?.name === 'browser_click'), 'definitions: plan hides browser_click');

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
  assert(!cliStateOut.includes('test-key-123') && !cliStateOut.includes('test-key-456'), 'cli state: redacts provider API keys');
  const cliZhStateOut = await captureStdout(() => runCliCommand(TEST_DIR, ['state', '--language', 'zh', '--root', TEST_DIR]));
  assert(JSON.parse(cliZhStateOut).language === 'zh', 'cli state: supports --language zh override');
  const cliToolFile = path.join(TEST_DIR, 'cli-tool-write.txt');
  const cliToolOut = await captureStdout(() => runCliCommand(TEST_DIR, ['tool', 'write', JSON.stringify({ path: cliToolFile, content: 'cli wrote file' }), '--root', TEST_DIR]));
  assert(cliToolOut.includes('[write] OK') && fs.existsSync(cliToolFile), 'cli tool: executes ToolExecutor command');
  assert(fs.readFileSync(cliToolFile, 'utf-8') === 'cli wrote file', 'cli tool: writes expected content');
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
    return { ok: modelName === 'gpt-test' || modelName === 'cli-fast' || modelName === 'claude-cli' || modelName === 'env-claude', latency: modelName === 'cli-fast' ? 0.3 : 0.8 };
  };
  try {
    const cliValidateOut = await captureStdout(() => runCliCommand(TEST_DIR, ['validate-models', '--selected', 'test-prov/gpt-test', '--root', TEST_DIR]));
    const cliValidate = JSON.parse(cliValidateOut);
    assert(Array.isArray(cliValidate) && cliValidate.some((r: any) => r.name === 'test-prov/gpt-test' && r.status === 'available'), 'cli validate-models: validates selected model');
    assert(!cliValidateOut.includes('test-key-123') && !cliValidateOut.includes('test-key-456'), 'cli validate-models: redacts provider API keys');
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
  fs.rmSync(cliMarketDir, { recursive: true, force: true });

  // ---- 3. Workspace Tests ----
  console.log('\n📁 Workspace Manager');
  const wsMgr = new WorkspaceManager(TEST_DIR, cfg);
  assert(wsMgr.internal.length >= 1, 'workspace: has auto-created internal');
  assert(wsMgr.current !== null, 'workspace: current is set');

  const ws1 = wsMgr.createInternal('test-ws-manual');
  assert(ws1.name === 'test-ws-manual', 'createInternal: correct name');
  assert(wsMgr.internal.length >= 2, 'createInternal: added to list');

  wsMgr.select('test-ws-manual');
  assert(wsMgr.current?.name === 'test-ws-manual', 'select: switches workspace');
  const wsMgrReloaded = new WorkspaceManager(TEST_DIR, cfg);
  assert(wsMgrReloaded.current?.name === 'test-ws-manual', 'workspace: restores last selected workspace');

  // Write workspace agent.md
  fs.writeFileSync(path.join(ws1.path, 'agent.md'), '# Workspace prompt\nTest prompt.');
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
  assert(lockThrown, 'conversation chat: blocks switching conversation while agent is working');
  (scopedAgentReloaded as unknown as { processingConversationId: string | null }).processingConversationId = null;
  scopedAgent.workspace.clear();
  const noWorkspaceTokens = await scopedAgent.process('should be blocked');
  assert(noWorkspaceTokens.map(t => t.text).join('').includes('Workspace required'), 'workspace chat: process requires selected workspace');

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

  // Goal mode prompt
  agent.setMode('goal');
  const goalPrompt = agent.buildSystemPrompt();
  assert(goalPrompt.includes('GOAL MODE'), 'buildSystemPrompt: goal mode');
  assert(goalPrompt.includes('Goal Complete') && goalPrompt.includes('remaining concrete gap'), 'buildSystemPrompt: goal prompt defines completion and incomplete reporting');
  assert(agent.buildSystemPrompt().includes('Automation:'), 'buildSystemPrompt: discloses automation tools and restrictions');

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

  // ---- 11. Model Validation Tests ----
  console.log('\n🔍 Model Validation');
  agent.config.upsertProvider('model-prov', 'https://api.model.test/v1', 'test-key-model');
  agent.config.addModelToProvider('model-prov', 'bad-model', 'Bad Model', 'Unavailable model');
  agent.config.addModelToProvider('model-prov', 'fast-mini', 'Fast Mini', 'Fast economical model');
  agent.config.addModelToProvider('model-prov', 'deep-opus', 'Deep Opus', 'High capability model');
  const originalValidate = LLMProvider.prototype.validate;
  LLMProvider.prototype.validate = async function(modelName: string) {
    return { ok: modelName !== 'bad-model', latency: modelName === 'fast-mini' ? 0.4 : 2.2 };
  };
  const validation = await agent.validateModels();
  assert(Array.isArray(validation), 'validateModels: returns array');
  assert(validation.some(v => v.name === 'model-prov/fast-mini' && v.status === 'available'), 'validateModels: records available model');
  assert(validation.some(v => v.speed_rating === 'fast'), 'validateModels: records response speed');
  assert(validation.every(v => !(v as unknown as Record<string, unknown>).api_key), 'validateModels: does not leak API keys');
  const evaluatedFast = agent.config.findModel('fast-mini');
  assert(evaluatedFast?.evaluation?.status === 'available', 'validateModels: persists evaluation into config');
  agent.config.set('models', 'auto_switch', true);
  agent.config.set('models', 'auto_switch_preference', 'speed');
  agent.setModel('deep-opus');
  const switchedForSpeed = await agent.evaluateAndSwitch('list files');
  assert(switchedForSpeed && agent.model === 'fast-mini', 'auto model: switches using speed preference');
  agent.config.set('models', 'auto_switch_preference', 'performance');
  const switchedForPerformance = await agent.evaluateAndSwitch('implement a complex refactor across modules');
  assert(switchedForPerformance && agent.model === 'deep-opus', 'auto model: switches using performance preference');
  agent.config.set('models', 'auto_switch', false);
  agent.config.set('models', 'auto_switch_preference', 'speed');
  agent.config.set('models', 'fallback_on_unavailable', true);
  agent.config.updateModel('model-prov', 'bad-model', {
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
  agent.setModel('bad-model');
  const precheckedFallback = await agent.process('check fallback preflight');
  assert(agent.model === 'fast-mini', 'model fallback: pre-switches away from known unavailable model');
  assert(precheckedFallback.some(t => t.text?.includes('FALLBACK_PRECHECK_OK')), 'model fallback: completes after pre-switch');
  agent.config.updateModel('model-prov', 'bad-model', {
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
  agent.setModel('bad-model');
  const runtimeFallback = await agent.process('check runtime fallback');
  assert(agent.model === 'fast-mini', 'model fallback: switches after runtime LLM error');
  assert(runtimeFallback.some(t => t.text?.includes('[Model fallback] bad-model unavailable; switched to fast-mini.')), 'model fallback: emits visible switch notice');
  assert(runtimeFallback.some(t => t.text?.includes('FALLBACK_PRECHECK_OK')), 'model fallback: retries request on fallback model');
  LLMProvider.prototype.chatStreamWithTools = originalChatStream;

  // ---- 12. Fuzzy Injection Tests ----
  console.log('\n💉 Fuzzy Injection');
  const isolatedFuzzyAgent = new Agent(path.join(TEST_DIR, 'fuzzy-empty'));
  const blockedFuzzy = await isolatedFuzzyAgent.fuzzyInject('OpenAI', 'https://api.openai.com/v1', 'test-key-blocked');
  assert(blockedFuzzy.ok === false, 'fuzzy injection: requires an available guiding model');
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
  assert(agent.config.findModel('nebula-fast')?.description.includes('/models endpoint'), 'fuzzy injection: marks listed model source');
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

  const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'llm', 'provider.ts'), 'utf-8');
  assert(providerSource.includes('[System.IO.File]::ReadAllText($bodyPath, $utf8NoBom)'), 'LLMProvider fallback: PowerShell reads request body as UTF-8 file');
  assert(providerSource.includes('[System.IO.File]::WriteAllText($responsePath, [string]$resp.Content, $utf8NoBom)'), 'LLMProvider fallback: PowerShell writes response body as UTF-8 file');
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
  const psFallbackText = await fallbackProvider.chat('gpt-5.4-mini', [{ role: 'user', content: 'Hi' }], null, 0, 20);
  globalThis.fetch = originalFetch;
  LLMProvider.nodeHttpTransport = null;
  LLMProvider.powershellTransport = null;
  assert(psFallbackText === 'powershell fallback ok 做了什么 验证 文件', 'LLMProvider fallback: PowerShell transport recovers after Node HTTP failure with UTF-8 text');

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
