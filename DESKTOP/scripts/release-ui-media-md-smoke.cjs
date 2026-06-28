const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-28-release-ui-media-md-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_MEDIA_MD_SMOKE === '1';

function log(message) {
  console.log(`[release-ui-media-md-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
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
      if (message.error) callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else callbacks.resolve(message.result);
    };
  });

  return { ws, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 15000) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const message = details.exception?.description || details.text || JSON.stringify(details);
    throw new Error(`Runtime.evaluate exception: ${message}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, expression, 10000);
    lastValue = value;
    if (value) return value;
    await sleep(500);
  }
  fail(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)}`);
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
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
  if (!screenshot?.data) fail('empty screenshot data');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(screenshot.data, 'base64'));
  log(`screenshot ${filePath}`);
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
      "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force",
    ], { windowsHide: true });
    fail('media/md smoke left a packaged Newmark process running');
  }
}

function writeConfig(root) {
  const config = {
    models: { providers: [], default_model: '', default_intelligence: 'low' },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    general: { language: 'en' },
    workspace: {
      prompt_mode: 'both',
      access_permission: 'full_access',
      on_permission_violation: 'deny',
    },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

async function runUiCheck(root) {
  const port = Number(process.env.NEWMARK_UI_MEDIA_MD_SMOKE_PORT || '49349');
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

    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.api && !!document.querySelector('#prompt'))()`, 30000, 'renderer ready');
    const workspace = await evaluate(cdp, `window.api.createWorkspace('media-md-workspace').then(ws => window.api.selectWorkspace(ws.name))`, 30000);
    if (!workspace || workspace.name !== 'media-md-workspace') fail(`workspace creation failed: ${JSON.stringify(workspace)}`);
    await evaluate(cdp, `window.selectWorkspace('media-md-workspace')`, 30000);
    await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.name === 'media-md-workspace')`, 30000, 'workspace selected');

    await evaluate(cdp, `Promise.all([
      window.api.saveFile('media-link-target.txt', 'EDITOR_LINK_TARGET_OK_20260628'),
      window.api.saveFile('media-doc.md', '# Media Smoke\\n\\n**MD_VIEWER_OK_20260628**\\n\\n- item')
    ])`, 30000);

    await evaluate(cdp, `(() => {
      const image = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
      addMsg('assistant', 'MEDIA_RENDER_MESSAGE_20260628\\n![tiny](' + image + ')\\n[Open target](media-link-target.txt)', 'build', 'media-md-smoke');
      return true;
    })()`, 30000);

    await waitFor(cdp, `(() => {
      const img = document.querySelector('.chat-msg .msg-image');
      const link = document.querySelector('.chat-msg .msg-file-link[data-path="media-link-target.txt"]');
      return !!img && img.getAttribute('src').startsWith('data:image/gif') && !!link && link.textContent.includes('Open target');
    })()`, 30000, 'message image and file link');
    log('message image and file link render ok');

    await evaluate(cdp, `document.querySelector('.chat-msg .msg-file-link[data-path="media-link-target.txt"]').click()`, 30000);
    await waitFor(cdp, `(() => {
      const panel = document.querySelector('#panel-editor');
      const file = document.querySelector('#editor-filename');
      const text = document.querySelector('#editor-textarea');
      return panel && panel.classList.contains('active') && file && file.textContent.includes('media-link-target.txt') && text && text.value.includes('EDITOR_LINK_TARGET_OK_20260628');
    })()`, 30000, 'linked file opens editor');
    log('linked file opens right editor ok');

    await evaluate(cdp, `window.openFile('media-doc.md')`, 30000);
    await waitFor(cdp, `(() => {
      const panel = document.querySelector('#panel-md-viewer');
      const md = document.querySelector('#md-viewer-content');
      return panel && panel.classList.contains('active') && md && md.innerText.includes('MD_VIEWER_OK_20260628') && !!md.querySelector('strong');
    })()`, 30000, 'markdown viewer content');
    log('markdown viewer ok');

    await evaluate(cdp, `window.switchRightTab('file-tree'); window.loadFileTree();`, 30000);
    await waitFor(cdp, `(() => {
      const names = Array.from(document.querySelectorAll('#file-tree-container .ft-name')).map(n => n.textContent || '').join('\\n');
      return names.includes('media-doc.md') && names.includes('media-link-target.txt');
    })()`, 30000, 'file tree lists smoke files');
    log('file tree lists smoke files ok');

    await captureScreenshot(cdp, screenshotPath);
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    try { if (child && !child.killed) child.kill(); } catch {}
    await sleep(1000);
    ensureNoReleaseProcess();
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkMediaMdSmoke-'));
  try {
    writeConfig(root);
    await runUiCheck(root);
    log('all media/md release UI smoke checks passed');
  } finally {
    if (keepRoot) log(`kept root: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(`[release-ui-media-md-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
