const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-27-release-ui-smoke-language.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_SMOKE === '1';

function log(message) {
  console.log(`[release-ui-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function captureOsScreenshot(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '$graphics = [System.Drawing.Graphics]::FromImage($bmp)',
    '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
    `$bmp.Save(${psQuote(filePath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$graphics.Dispose()',
    '$bmp.Dispose()',
    "Write-Output 'OS_SCREENSHOT_OK'",
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !fs.existsSync(filePath)) {
    throw new Error(`OS screenshot failed: ${result.stderr || result.stdout || result.status}`);
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

async function waitForTarget(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.url || '').includes('index.html'))
        || targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.title || '').includes('Newmark'))
        || targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview'))
        || targets.find(t => t.webSocketDebuggerUrl);
      if (target) return target;
    } catch {}
    await sleep(500);
  }
  fail('Timed out waiting for Electron CDP target');
}

function connectCdp(target) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  function call(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
    });
  }

  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const callbacks = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        callbacks.resolve(message.result);
      }
    };
  });

  return { ws, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const message = details.exception?.description || details.text || JSON.stringify(details);
    throw new Error(`Runtime.evaluate exception: ${message}`);
  }
  return result.result ? result.result.value : undefined;
}

async function captureScreenshot(cdp, filePath) {
  await cdp.call('Page.bringToFront', {}, 10000);
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  }, 10000).catch(() => undefined);
  await evaluate(cdp, `(() => { window.scrollTo(0, 0); return true; })()`);
  await sleep(300);
  const attempts = [
    { params: { format: 'png', fromSurface: true }, timeout: 15000, label: 'viewport-from-surface' },
    { params: { format: 'png', captureBeyondViewport: false, fromSurface: false }, timeout: 15000, label: 'viewport-no-surface' },
    { params: { format: 'png' }, timeout: 30000, label: 'default' },
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const screenshot = await cdp.call('Page.captureScreenshot', attempt.params, attempt.timeout);
      if (!screenshot?.data) throw new Error('empty screenshot data');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(screenshot.data, 'base64'));
      log(`screenshot ${filePath} (${attempt.label})`);
      return;
    } catch (error) {
      errors.push(`${attempt.label}: ${error.message}`);
    }
  }
  try {
    captureOsScreenshot(filePath);
    log(`screenshot ${filePath} (os-fallback after ${errors.join(' | ')})`);
    return;
  } catch (error) {
    errors.push(`os-fallback: ${error.message}`);
  }
  fail(`screenshot capture failed: ${errors.join(' | ')}`);
}

async function titleAfter(cdp, expression) {
  await evaluate(cdp, expression);
  await sleep(350);
  return evaluate(cdp, "document.querySelector('.sub-win-title')?.textContent || ''");
}

async function setLanguage(cdp, lang) {
  await evaluate(cdp, `(() => { window.setLanguage('${lang}'); return true; })()`);
  await sleep(900);
}

async function seedDynamicI18nState(cdp) {
  await evaluate(cdp, `(() => {
    state.contextCompression = { fallback: false, originalMessages: 8, compressedMessages: 2, at: '2026-06-27T00:00:00.000Z', summary: 'smoke' };
    state.nextQueue = ['queued follow-up'];
    state.autoSwitch = 'on';
    state.autoSwitchScope = 'all';
    state.providers = [{
      name: 'SmokeProvider',
      protocol: 'openai',
      base_url: 'http://127.0.0.1:1/v1',
      models: [
        { name: 'smoke-model-ok', display: 'Smoke Model OK', max_tokens: 8192, vision: true, thinking: false, evaluation: { status: 'available', cost_rating: 'low' } },
        { name: 'smoke-model-bad', display: 'Smoke Model Bad', max_tokens: 4096, vision: false, thinking: true, evaluation: { status: 'unavailable', cost_rating: 'unknown' } }
      ]
    }];
    applyLanguageToUi();
    return true;
  })()`);
  await sleep(300);
}

async function readLanguageSnapshot(cdp) {
  return evaluate(cdp, `({
    lang: document.documentElement.lang,
    prompt: document.querySelector('#prompt')?.getAttribute('placeholder') || '',
    languageState: state.language,
    leftNewChat: document.querySelector('#left-content .left-nav-icon span:last-child')?.textContent || '',
    leftWorkspaces: document.querySelector('#left-ws-header')?.textContent || '',
    secondaryNewChat: document.querySelector('.secondary-top button[onclick="window.newConversation()"] span:last-child')?.textContent || '',
    secondarySettingsTitle: document.querySelector('.secondary-top button[onclick="window.openWsSettings()"]')?.getAttribute('title') || '',
    rightCloseTitle: document.querySelector('button.tab-btn[onclick="window.toggleRight()"]')?.getAttribute('title') || '',
    rightRefreshText: document.querySelector('#panel-file-tree .archive-action-btn')?.textContent || '',
    editorCloseText: document.querySelector('button.et-btn[onclick="window.closeEditor()"] span:last-child')?.textContent || '',
    subWinCloseTitle: document.querySelector('.sub-win-close')?.getAttribute('title') || '',
    terminalConnected: Array.from(document.querySelectorAll('.terminal-output span')).map(el => el.textContent || '').find(text => text.startsWith('Terminal connected') || text.startsWith('终端已连接')) || '',
    contextCompression: (document.querySelector('#context-compression-pill')?.textContent || '').split(' | ').slice(0, 3).join(' | '),
    nextQueue: document.querySelector('#queue-header-label')?.textContent || '',
    modelAuto: document.querySelector('#model-select option[value="auto"]')?.textContent || ''
  })`);
}

async function readModelSettingsSnapshot(cdp) {
  return evaluate(cdp, `(() => {
    window.openSettings('models');
    const chips = Array.from(document.querySelectorAll('.model-chip')).map(el => ({
      text: el.textContent.replace(/\\s+/g, ' ').trim(),
      removeTitle: el.querySelector('.remove[onclick^="window.removeModel"]')?.getAttribute('title') || '',
      editTitle: el.querySelector('.remove[onclick^="window.editModel"]')?.getAttribute('title') || ''
    }));
    const providerEditTitle = document.querySelector('button[onclick="window.editProvider(0)"]')?.getAttribute('title') || '';
    const providerDeleteTitle = document.querySelector('button[onclick="window.removeProvider(0)"]')?.getAttribute('title') || '';
    window.editModel(0, 0);
    const editModelTitle = document.querySelector('.sub-win-title')?.textContent || '';
    const editModelLabels = Array.from(document.querySelectorAll('.sub-win-body label')).map(el => el.textContent.trim());
    window.openSettings('models');
    window.editProvider(0);
    const editProviderTitle = document.querySelector('.sub-win-title')?.textContent || '';
    const editProviderLabels = Array.from(document.querySelectorAll('.sub-win-body label')).map(el => el.textContent.trim());
    window.openSettings('models');
    return { chips, providerEditTitle, providerDeleteTitle, editModelTitle, editModelLabels, editProviderTitle, editProviderLabels };
  })()`);
}

function assertSnapshot(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) fail(`${label} ${key} mismatch: expected ${value}, got ${actual[key]}`);
  }
}

function ensureNoReleaseProcess() {
  const running = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "(@(Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' })).Count",
  ], { encoding: 'utf8', windowsHide: true });
  const count = Number(String(running.stdout || '').trim());
  if (count > 0) {
    spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force; Write-Output 'stopped release UI smoke residue'",
    ], { windowsHide: true });
    log(`warning: cleaned ${count} packaged Newmark release process(es) after smoke`);
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiSmoke-'));
  const port = Number(process.env.NEWMARK_UI_SMOKE_PORT || '49335');
  let child;
  let cdp;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const target = await waitForTarget(port);
    log(`connected target: ${target.title || '(untitled)'} ${target.url || ''}`);
    cdp = connectCdp(target);
    await cdp.ready;
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');
    await sleep(2500);

    await seedDynamicI18nState(cdp);
    await setLanguage(cdp, 'auto');
    const autoBefore = await readLanguageSnapshot(cdp);
    if (autoBefore.languageState !== 'auto') {
      fail(`auto-before languageState mismatch: ${autoBefore.languageState}`);
    }
    if (!['en', 'zh-CN'].includes(autoBefore.lang)) {
      fail(`auto-before document lang mismatch: ${autoBefore.lang}`);
    }
    if (!['Input instruction...', '输入指令...'].includes(autoBefore.prompt)) {
      fail(`auto-before prompt mismatch: ${autoBefore.prompt}`);
    }
    const autoConfig = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    if (autoConfig.general?.language?.value !== 'auto') {
      fail(`auto-before persisted language mismatch: ${autoConfig.general?.language?.value}`);
    }

    await setLanguage(cdp, 'en');
    const englishBefore = await readLanguageSnapshot(cdp);
    assertSnapshot(englishBefore, {
      lang: 'en',
      prompt: 'Input instruction...',
      languageState: 'en',
      leftNewChat: 'New chat',
      leftWorkspaces: 'Workspaces',
      secondaryNewChat: 'New chat',
      secondarySettingsTitle: 'Workspace settings',
      rightCloseTitle: 'Close right sidebar',
      rightRefreshText: 'Refresh',
      editorCloseText: 'Close',
      subWinCloseTitle: 'Close',
      terminalConnected: 'Terminal connected (powershell)',
      contextCompression: 'Context compressed | model | 8 -> 2 messages',
      nextQueue: 'Next 1',
      modelAuto: 'Auto',
    }, 'english-before');
    const englishModels = await readModelSettingsSnapshot(cdp);
    if (!englishModels.chips.some(chip => chip.text.includes('available')) || !englishModels.chips.some(chip => chip.text.includes('unavailable'))) {
      fail(`english model status did not render translated statuses: ${JSON.stringify(englishModels.chips)}`);
    }
    if (!englishModels.chips.every(chip => chip.removeTitle === 'Remove' && chip.editTitle === 'Edit')) {
      fail(`english model chip titles mismatch: ${JSON.stringify(englishModels.chips)}`);
    }
    if (englishModels.providerEditTitle !== 'Edit' || englishModels.providerDeleteTitle !== 'Delete') {
      fail(`english provider action titles mismatch: ${JSON.stringify(englishModels)}`);
    }
    if (englishModels.editModelTitle !== 'Edit' || englishModels.editProviderTitle !== 'Edit') {
      fail(`english model/provider edit title mismatch: ${JSON.stringify(englishModels)}`);
    }
    for (const label of ['Model name', 'Provider', 'Context size', 'Vision', 'Thinking', 'Description']) {
      if (!englishModels.editModelLabels.includes(label)) fail(`english edit model label missing: ${label}`);
    }
    for (const label of ['Provider name', 'Protocol', 'API endpoint', 'API key']) {
      if (!englishModels.editProviderLabels.includes(label)) fail(`english edit provider label missing: ${label}`);
    }

    await setLanguage(cdp, 'zh');

    const fuzzyTitle = await titleAfter(cdp, "window.closeSubWin(); window.fuzzyInject(); 'ok'");
    const pluginsTitle = await titleAfter(cdp, "window.closeSubWin(); window.showPluginList(); 'ok'");
    const flowTitle = await titleAfter(cdp, "window.closeSubWin(); window.showFlowEditor(); 'ok'");
    const newConversationTitle = await titleAfter(cdp, "window.closeSubWin(); window.showNewConversationPage(); 'ok'");
    const workspaceRequiredTitle = await titleAfter(cdp, "window.closeSubWin(); window.showWorkspaceRequired(); 'ok'");
    const state = await readLanguageSnapshot(cdp);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

    const expected = {
      fuzzyTitle: '模糊注入模型',
      pluginsTitle: '插件',
      flowTitle: '工作流编辑器',
      newConversationTitle: '新对话',
      workspaceRequiredTitle: '需要工作区',
    };
    const actual = { fuzzyTitle, pluginsTitle, flowTitle, newConversationTitle, workspaceRequiredTitle };
    for (const [key, value] of Object.entries(expected)) {
      if (actual[key] !== value) fail(`${key} mismatch: expected ${value}, got ${actual[key]}`);
    }
    assertSnapshot(state, {
      lang: 'zh-CN',
      prompt: '输入指令...',
      languageState: 'zh',
      leftNewChat: '新对话',
      leftWorkspaces: '工作区',
      secondaryNewChat: '新对话',
      secondarySettingsTitle: '工作区设置',
      rightCloseTitle: '关闭右侧栏',
      rightRefreshText: '刷新',
      editorCloseText: '关闭',
      subWinCloseTitle: '关闭',
      terminalConnected: '终端已连接 (powershell)',
      contextCompression: '上下文已压缩 | 模型 | 8 -> 2 条消息',
      nextQueue: '下一轮 1',
      modelAuto: '自动',
    }, 'chinese');
    const chineseModels = await readModelSettingsSnapshot(cdp);
    if (!chineseModels.chips.some(chip => chip.text.includes('可用')) || !chineseModels.chips.some(chip => chip.text.includes('不可用'))) {
      fail(`chinese model status did not render translated statuses: ${JSON.stringify(chineseModels.chips)}`);
    }
    if (!chineseModels.chips.every(chip => chip.removeTitle === '移除' && chip.editTitle === '编辑')) {
      fail(`chinese model chip titles mismatch: ${JSON.stringify(chineseModels.chips)}`);
    }
    if (chineseModels.providerEditTitle !== '编辑' || chineseModels.providerDeleteTitle !== '删除') {
      fail(`chinese provider action titles mismatch: ${JSON.stringify(chineseModels)}`);
    }
    if (chineseModels.editModelTitle !== '编辑' || chineseModels.editProviderTitle !== '编辑') {
      fail(`chinese model/provider edit title mismatch: ${JSON.stringify(chineseModels)}`);
    }
    for (const label of ['模型名称', '供应商', '上下文规模', '视觉', '思考', '描述']) {
      if (!chineseModels.editModelLabels.includes(label)) fail(`chinese edit model label missing: ${label}`);
    }
    for (const label of ['供应商名称', '协议', 'API 接口', 'API key']) {
      if (!chineseModels.editProviderLabels.includes(label)) fail(`chinese edit provider label missing: ${label}`);
    }
    await evaluate(cdp, "window.closeSubWin(); window.showWorkspaceRequired(); 'ok'");
    await sleep(300);
    if (config.general?.language?.value !== 'zh') fail(`persisted language mismatch: ${config.general?.language?.value}`);

    await setLanguage(cdp, 'en');
    const englishAfter = await readLanguageSnapshot(cdp);
    const activeSubWindowAfterSwitch = await evaluate(cdp, `({
      title: document.querySelector('.sub-win-title')?.textContent || '',
      body: document.querySelector('.sub-win-body')?.textContent || ''
    })`);
    assertSnapshot(englishAfter, {
      lang: 'en',
      prompt: 'Input instruction...',
      languageState: 'en',
      leftNewChat: 'New chat',
      leftWorkspaces: 'Workspaces',
      secondaryNewChat: 'New chat',
      secondarySettingsTitle: 'Workspace settings',
      rightCloseTitle: 'Close right sidebar',
      rightRefreshText: 'Refresh',
      editorCloseText: 'Close',
      subWinCloseTitle: 'Close',
      terminalConnected: 'Terminal connected (powershell)',
      contextCompression: 'Context compressed | model | 8 -> 2 messages',
      nextQueue: 'Next 1',
      modelAuto: 'Auto',
    }, 'english-after');
    if (activeSubWindowAfterSwitch.title !== 'Workspace required') {
      fail(`english-after subwindow title mismatch: ${activeSubWindowAfterSwitch.title}`);
    }
    if (!activeSubWindowAfterSwitch.body.includes('Conversations are bound to a workspace.')) {
      fail(`english-after subwindow body did not rerender: ${activeSubWindowAfterSwitch.body}`);
    }
    const rightTextAfterSwitch = await evaluate(cdp, `document.querySelector('#right-content')?.textContent || ''`);
    if (rightTextAfterSwitch.includes('空目录')) {
      fail(`english-after right sidebar retained Chinese empty-state text: ${rightTextAfterSwitch}`);
    }

    await captureScreenshot(cdp, screenshotPath);

    log('language en/zh switch ok');
    log('secondary windows ok');
    log('all release UI smoke checks passed');
  } finally {
    try {
      if (cdp?.ws) cdp.ws.close();
    } catch {}
    try {
      if (child && !child.killed) child.kill();
    } catch {}
    await sleep(1000);
    if (keepRoot) {
      log(`kept root: ${root}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
    ensureNoReleaseProcess();
  }
})().catch(error => {
  console.error(`[release-ui-smoke] ${error.message}`);
  process.exit(1);
});
