const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-07-01-release-ui-memory-lab-smoke.png');

function log(message) { console.log(`[release-ui-memory-lab-smoke] ${message}`); }
function fail(message) { throw new Error(message); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function psQuote(value) { return `'${String(value).replace(/'/g, "''")}'`; }

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
      const target = targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.url || '').includes('index.html'))
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
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
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
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
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
    try {
      lastValue = await evaluate(cdp, expression, 10000);
      if (lastValue) return lastValue;
    } catch (error) {
      lastValue = error.message;
    }
    await sleep(300);
  }
  fail(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)}`);
}

async function captureScreenshot(cdp) {
  await cdp.call('Page.bringToFront', {}, 10000);
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, 10000).catch(() => undefined);
  await evaluate(cdp, `(() => { window.scrollTo(0, 0); return true; })()`, 10000).catch(() => undefined);
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
  try {
    captureOsScreenshot(screenshotPath);
    log(`screenshot ${screenshotPath} (os-fallback after ${errors.join(' | ')})`);
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
      "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force; Write-Output 'STOP_RELEASE_PROCESSES_OK'",
    ], { encoding: 'utf8', windowsHide: true });
    fail('Memory Lab smoke left a packaged Newmark process running');
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
  const port = Number(process.env.NEWMARK_UI_MEMORY_LAB_SMOKE_PORT || '49364');
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

    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.api && !!window.showMemoryLab && !!window.api.memoryLabUpdate)()`, 30000, 'renderer ready with Memory Lab');
    const update = await evaluate(cdp, `window.api.memoryLabUpdate({
      name: 'release-ui-memory',
      description: 'Release UI Memory Lab smoke component.',
      tags: ['#Release-Smoke', '#Agent-Skill'],
      content: '# Release UI Memory\\n\\nReleaseMemoryNeedle core markdown.',
      kind: 'folder'
    })`, 30000);
    if (!update || update.ok !== true) fail(`memoryLabUpdate failed: ${JSON.stringify(update)}`);
    const siblingUpdate = await evaluate(cdp, `window.api.memoryLabUpdate({
      name: 'release-ui-root-memory',
      description: 'Release UI Memory Lab root overview component.',
      tags: ['#RootRelease', '#Agent-Skill'],
      content: '# Root Release Memory\\n\\nRootReleaseMemoryNeedle core markdown.',
      kind: 'file'
    })`, 30000);
    if (!siblingUpdate || siblingUpdate.ok !== true) fail(`root memoryLabUpdate failed: ${JSON.stringify(siblingUpdate)}`);
    if (!fs.existsSync(path.join(root, 'Memory Lab', 'index.json'))) fail('Memory Lab index was not created under root');
    if (!fs.existsSync(path.join(root, 'Memory Lab', 'components', 'release-ui-memory', 'memory.md'))) fail('Memory Lab folder component core md missing');
    log('Memory Lab update API ok');

    await evaluate(cdp, `window.showMemoryLab()`, 30000);
    await waitFor(cdp, `(() => {
      return !!document.querySelector('.memory-lab-overview-stage') &&
        !!document.querySelector('.memory-lab-view-menu button.active') &&
        document.body.innerText.includes('Overview') &&
        document.body.innerText.includes('Detail') &&
        !document.querySelector('.memory-lab-links');
    })()`, 30000, 'Memory Lab overview graph rendered without legacy connector container');
    await waitFor(cdp, `(() => {
      const nodes = Array.from(document.querySelectorAll('.memory-lab-overview-node')).map(n => n.innerText);
      return nodes.some(t => t.includes('#Release')) &&
        nodes.some(t => t.includes('#Release-Smoke')) &&
        nodes.some(t => t.includes('release-ui-memory'));
    })()`, 30000, 'Memory Lab overview graph contains real tag and component nodes');
    await evaluate(cdp, `window.selectMemoryLabTag('#Release')`, 30000);
    await waitFor(cdp, `(() => {
      const status = document.querySelector('#memory-lab-overview-status');
      return !!status && status.innerText.includes('#Release');
    })()`, 30000, 'Memory Lab overview search/tag selection focuses overview node');
    await evaluate(cdp, `window.switchMemoryLabView('detail')`, 30000);
    await waitFor(cdp, `(() => !!document.querySelector('.memory-lab-graph') && !document.querySelector('.memory-lab-links'))()`, 30000, 'Memory Lab detail graph rendered without connector lines');
    await waitFor(cdp, `(() => {
      const text = document.body.innerText;
      return text.includes('Root tags') && text.includes('#Release') && text.includes('#RootRelease');
    })()`, 30000, 'Memory Lab root tag overview visible when centered on a root tag');
    await evaluate(cdp, `(() => {
      const input = document.querySelector('#memory-lab-search-input');
      if (!input) return false;
      input.value = 'Smoke';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => {
      const results = document.querySelector('#memory-lab-search-results');
      return !!results && !results.hidden && results.innerText.includes('#Release-Smoke');
    })()`, 30000, 'Memory Lab tag search results visible');
    await evaluate(cdp, `window.selectMemoryLabTag('#Release-Smoke')`, 30000);
    await waitFor(cdp, `(() => {
      const text = document.body.innerText;
      return text.includes('Memory Lab') && text.includes('#Release') && text.includes('#Release-Smoke');
    })()`, 30000, 'Memory Lab search jump to child tag visible');
    await evaluate(cdp, `window.selectMemoryLabTag('#Release')`, 30000);
    await evaluate(cdp, `window.selectMemoryLabTag('#Release-Smoke')`, 30000);
    await waitFor(cdp, `(() => {
      const graph = document.querySelector('.memory-lab-graph');
      const text = document.body.innerText;
      return !!graph && graph.classList.contains('animate-from-right') && text.includes('#Release') && text.includes('#Release-Smoke') && text.includes('release-ui-memory');
    })()`, 30000, 'Memory Lab child navigation animation visible');
    await evaluate(cdp, `window.selectMemoryLabComponent('release-ui-memory')`, 30000);
    await waitFor(cdp, `(() => document.body.innerText.includes('ReleaseMemoryNeedle core markdown.'))()`, 30000, 'Memory Lab component markdown visible');
    await captureScreenshot(cdp);
    log('all Memory Lab UI checks passed');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiMemoryLab-'));
  try {
    writeConfig(root);
    await runUiCheck(root);
  } finally {
    if (process.env.NEWMARK_KEEP_UI_MEMORY_LAB_SMOKE !== '1') {
      fs.rmSync(root, { recursive: true, force: true });
    } else {
      log(`kept root ${root}`);
    }
  }
})().catch(error => {
  console.error(`[release-ui-memory-lab-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
