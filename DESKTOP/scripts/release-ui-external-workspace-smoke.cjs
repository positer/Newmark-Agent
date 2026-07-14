const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-27-release-ui-external-workspace-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_EXTERNAL_WORKSPACE_SMOKE === '1';

function log(message) {
  console.log(`[release-ui-external-workspace-smoke] ${message}`);
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
  fail(`Timed out waiting for ${label}; last value: ${String(lastValue || '').slice(0, 500)}`);
}

function writeConfig(root) {
  const config = {
    models: {
      providers: [],
      default_model: '',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    general: { language: 'en' },
    workspace: {
      auto_create_timestamp_workspace: true,
      prompt_mode: 'both',
      access_permission: 'full_access',
      on_permission_violation: 'deny',
    },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  fs.writeFileSync(path.join(root, 'PC_Hash.config'), 'release-ui-external-seed|win32|x64', 'utf8');
}

async function launch(root, port) {
  const child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const target = await waitForTarget(port);
  log(`connected target: ${target.title || '(untitled)'} ${target.url || ''}`);
  const cdp = connectCdp(target);
  await cdp.ready;
    await waitForPromotedMainUi(cdp);
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  await cdp.call('Page.bringToFront');
  return { child, cdp };
}

function stopChild(child) {
  try { if (child && !child.killed) child.kill(); } catch {}
}

async function captureScreenshot(cdp) {
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
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
      log(`screenshot ${screenshotPath} (${attempt.label})`);
      return;
    } catch (error) {
      errors.push(`${attempt.label}: ${error.message}`);
    }
  }
  const fallback = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height; $gfx=[System.Drawing.Graphics]::FromImage($bmp); $gfx.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size); $dir=${JSON.stringify(path.dirname(screenshotPath))}; New-Item -ItemType Directory -Force -Path $dir | Out-Null; $file=${JSON.stringify(screenshotPath)}; $bmp.Save($file,[System.Drawing.Imaging.ImageFormat]::Png); $gfx.Dispose(); $bmp.Dispose(); Write-Output 'SCREEN_CAPTURE_OK'`,
  ], { encoding: 'utf8', windowsHide: true });
  if (fallback.status === 0 && fs.existsSync(screenshotPath)) {
    log(`screenshot ${screenshotPath} (windows-screen-fallback after ${errors.join(' | ')})`);
    return;
  }
  fail(`screenshot capture failed: ${errors.join(' | ')} | fallback: ${fallback.stderr || fallback.stdout || 'no output'}`);
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
      "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force; Write-Output 'STOP_RELEASE_PROCESSES_OK'",
    ], { windowsHide: true, encoding: 'utf8' });
    log('warning: cleaned packaged Newmark release process residue after smoke');
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI external workspace smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiExternalRoot-'));
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkExternalWorkspace-'));
  const externalName = path.basename(externalDir);
  writeConfig(root);

  const port = Number(process.env.NEWMARK_UI_EXTERNAL_WORKSPACE_PORT || '49350');
  let child;
  let cdp;
  let completed = false;
  try {
    ({ child, cdp } = await launch(root, port));
    await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.isInternal === true)`, 30000, 'initial internal workspace');

    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.showNewWorkspaceDialog && !!window.doCreateWorkspace && !!window.api.createExternalWorkspace)()`, 30000, 'workspace dialog functions');
    const created = await evaluate(cdp, `new Promise(resolve => {
      window.showNewWorkspaceDialog();
      setTimeout(() => {
        const external = Array.from(document.getElementsByName('ws-type')).find(el => el.value === 'external');
        if (external) {
          external.checked = true;
          external.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const pathInput = document.getElementById('ws-ext-path-input');
        if (pathInput) {
          pathInput.value = ${JSON.stringify(externalDir)};
          pathInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        window.doCreateWorkspace();
        setTimeout(async () => {
          const state = await window.api.getState();
          resolve(state.workspaces && state.workspaces.current ? state.workspaces.current : null);
        }, 1500);
      }, 300);
    })`, 30000);

    if (!created || created.isInternal !== false || path.resolve(created.path) !== path.resolve(externalDir)) {
      fail(`external workspace was not created and selected: ${JSON.stringify(created)}`);
    }
    const expectedHostBinding = created.hostBinding;
    if (!expectedHostBinding || typeof expectedHostBinding !== 'string') {
      fail(`external workspace host binding mismatch: ${JSON.stringify(created)}`);
    }
    log(`external workspace ok: ${created.name}; host=${expectedHostBinding}`);

    const externalJson = JSON.parse(fs.readFileSync(path.join(root, 'Work', 'External.json'), 'utf8'));
    if (!Array.isArray(externalJson) || !externalJson.some(w => w.path === externalDir && w.hostBinding === expectedHostBinding)) {
      fail(`External.json missing bound workspace: ${JSON.stringify(externalJson)}`);
    }
    const stateJson = JSON.parse(fs.readFileSync(path.join(root, 'Work', 'State.json'), 'utf8'));
    if (!stateJson.current || stateJson.current.isInternal !== false || stateJson.current.path !== externalDir) {
      fail(`State.json did not select external workspace: ${JSON.stringify(stateJson)}`);
    }

    const archiveName = await evaluate(cdp, `window.api.archive()`, 30000);
    const archiveFile = path.join(externalDir, 'archive', archiveName || '');
    if (!archiveName || !fs.existsSync(archiveFile)) fail(`external workspace archive missing: ${archiveFile}`);
    log('external workspace archive ok');

    await captureScreenshot(cdp);
    cdp.ws.close();
    stopChild(child);
    await sleep(1500);

    const mismatchedExternalJson = externalJson.map(w => w.path === externalDir ? { ...w, hostBinding: 'different-pc|win32|x64' } : w);
    fs.writeFileSync(path.join(root, 'Work', 'External.json'), JSON.stringify(mismatchedExternalJson, null, 2), 'utf8');
    ({ child, cdp } = await launch(root, port + 1));
    const hidden = await waitFor(cdp, `window.api.getState().then(s => {
      const external = (s.workspaces && s.workspaces.external) || [];
      const current = s.workspaces && s.workspaces.current;
      return external.length === 0 && (!current || current.path !== ${JSON.stringify(externalDir)});
    })`, 30000, 'external workspace hidden after PC hash mismatch');
    if (!hidden) fail('external workspace was not hidden after PC hash mismatch');

    const filteredExternalJson = JSON.parse(fs.readFileSync(path.join(root, 'Work', 'External.json'), 'utf8'));
    if (Array.isArray(filteredExternalJson) && filteredExternalJson.some(w => w.path === externalDir)) {
      fail(`mismatched external workspace remained in External.json: ${JSON.stringify(filteredExternalJson)}`);
    }
    log('pc binding hide ok');
    log('all release UI external workspace checks passed');
    completed = true;
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    stopChild(child);
    await sleep(1000);
    if (keepRoot) log(`kept root: ${root}; external: ${externalDir}`);
    else {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
    ensureNoReleaseProcess();
    if (!completed) log('cleanup complete after failed external workspace smoke');
  }
})().catch(error => {
  console.error(`[release-ui-external-workspace-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
