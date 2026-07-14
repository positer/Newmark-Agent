const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
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

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
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
      const target = targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.url || '').includes('index.html'));
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
    log('warning: cleaned packaged Newmark release process residue after smoke');
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
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');

    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.api && !!document.querySelector('#prompt'))()`, 30000, 'renderer ready');
    const workspace = await evaluate(cdp, `window.api.createWorkspace('media-md-workspace').then(ws => window.api.selectWorkspace(ws.name))`, 30000);
    if (!workspace || workspace.name !== 'media-md-workspace') fail(`workspace creation failed: ${JSON.stringify(workspace)}`);
    await evaluate(cdp, `window.selectWorkspace('media-md-workspace')`, 30000);
    await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.name === 'media-md-workspace')`, 30000, 'workspace selected');

    fs.writeFileSync(path.join(workspace.path, 'media-link-target.txt'), 'EDITOR_LINK_TARGET_OK_20260628', 'utf8');
    fs.writeFileSync(path.join(workspace.path, 'media-doc.md'), '# Media Smoke\n\n**MD_VIEWER_OK_20260628**\n\n- item', 'utf8');

    await evaluate(cdp, `(() => {
      const image = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
      addMsg('assistant', '# MEDIA_RENDER_MESSAGE_20260628\\n\\n![tiny](' + image + ')\\n\\n[Open target](media-link-target.txt)\\n\\n| Metric | Value |\\n| --- | --- |\\n| Alpha | $a^2 + b^2$ |\\n\\n$$\\nG_{\\\\mu\\\\nu} + \\\\Lambda g_{\\\\mu\\\\nu} = \\\\frac{8\\\\pi G}{c^4} T_{\\\\mu\\\\nu}\\n$$', 'build', 'media-md-smoke');
      return true;
    })()`, 30000);

    await waitFor(cdp, `(() => {
      const img = document.querySelector('.chat-msg .msg-image');
      const link = document.querySelector('.chat-msg .msg-file-link[data-path="media-link-target.txt"]');
      const msg = document.querySelector('.chat-msg .msg-body');
      return !!img && img.getAttribute('src').startsWith('data:image/gif') &&
        !!link && link.textContent.includes('Open target') &&
        !!msg && !!msg.querySelector('.md-rendered h1') &&
        !!msg.querySelector('.md-table') &&
        !!msg.querySelector('.md-math-inline sup') &&
        !!msg.querySelector('.md-math-block .math-frac') &&
        !!msg.querySelector('.md-math-block sub') &&
        msg.querySelector('.md-math-block').innerText.includes('Λ') &&
        !msg.querySelector('.md-math-block').innerText.includes('\\\\frac');
    })()`, 30000, 'message image and file link');
    log('message markdown image, file link, table, and math render ok');

    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      const file = new File([bytes], 'rootless-paste.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      prompt.dispatchEvent(ev);
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => {
      const wrap = document.querySelector('#prompt-attachments');
      const img = wrap && wrap.querySelector('.prompt-attachment img');
      return wrap && wrap.classList.contains('has-items') &&
        wrap.textContent.includes('rootless-paste.png') &&
        img && img.getAttribute('src').startsWith('data:image/png;base64,') &&
        document.querySelector('#prompt').value.trim() === '';
    })()`, 30000, 'rootless pasted image attachment');
    log('rootless pasted image attachment preview ok');

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
      const panel = document.querySelector('#panel-editor');
      const toggle = document.querySelector('#editor-md-toggle');
      const text = document.querySelector('#editor-textarea');
      return panel && panel.classList.contains('active') && toggle && toggle.classList.contains('visible') && text && text.value.includes('MD_VIEWER_OK_20260628');
    })()`, 30000, 'markdown opens integrated editor');
    await evaluate(cdp, `window.toggleEditorMarkdownPreview()`, 30000);
    await waitFor(cdp, `(() => {
      const md = document.querySelector('#editor-md-preview');
      return md && md.classList.contains('open') && md.innerText.includes('MD_VIEWER_OK_20260628') && !!md.querySelector('strong') && !!md.querySelector('li');
    })()`, 30000, 'integrated markdown preview content');
    log('integrated markdown editor preview ok');

    await evaluate(cdp, `window.openFile('media-link-target.txt')`, 30000);
    await waitFor(cdp, `(() => {
      const main = document.querySelector('#native-editor-main');
      const md = document.querySelector('#editor-md-preview');
      const toggle = document.querySelector('#editor-md-toggle');
      const text = document.querySelector('#editor-textarea');
      return main && main.style.display === 'grid'
        && md && !md.classList.contains('open') && !md.textContent
        && toggle && !toggle.classList.contains('visible')
        && text && text.value.includes('EDITOR_LINK_TARGET_OK_20260628');
    })()`, 30000, 'markdown preview resets before non-markdown editor');
    log('markdown preview to text editor reset ok');

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
