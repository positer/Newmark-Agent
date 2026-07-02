const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const asar = require('@electron/asar');
const { verifyExeIcon } = require('./patch-win-exe-icon.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const appAsar = path.join(repoRoot, 'release', 'win-unpacked', 'resources', 'app.asar');
const packageIcon = path.join(repoRoot, 'DESKTOP', 'assets', 'icon.ico');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-28-v1.0.2-ui-icon-smoke.png');
const windowIconPath = path.join(repoRoot, 'archive', '2026-06-28-v1.0.2-runtime-window-icon.png');

function fail(message) {
  throw new Error(message);
}

function ensureReleaseAssets() {
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  if (!fs.existsSync(appAsar)) fail(`missing app.asar: ${appAsar}`);
  const files = asar.listPackage(appAsar);
  for (const file of ['\\assets\\app-icon-dark.png', '\\assets\\app-icon-light.png', '\\assets\\icon.ico']) {
    if (!files.includes(file)) fail(`app.asar missing icon asset: ${file}`);
  }
  verifyExeIcon(exePath, packageIcon);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error(`timeout fetching ${url}`));
    });
  });
}

async function waitForCdp(port) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json`);
      const page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(500);
  }
  fail('timed out waiting for CDP page');
}

async function waitForRenderedUi(cdp) {
  const deadline = Date.now() + 45000;
  let last = null;
  while (Date.now() < deadline) {
    const state = await cdp.call('Runtime.evaluate', {
      expression: `(() => ({
        title: document.title,
        bodyText: document.body ? document.body.innerText.slice(0, 5000) : '',
        readyState: document.readyState,
        hasLeft: !!document.querySelector('#left'),
        hasMain: !!document.querySelector('#main'),
        hasInput: !!document.querySelector('#prompt'),
        hasTitleIcon: !!document.querySelector('#title-app-icon'),
      }))()`,
      returnByValue: true,
    });
    last = state.result && state.result.value;
    if (
      last &&
      last.title === 'Newmark Agent' &&
      last.readyState === 'complete' &&
      last.hasTitleIcon &&
      (last.hasLeft || last.hasMain || last.hasInput || String(last.bodyText || '').includes('New chat') || String(last.bodyText || '').includes('New conversation'))
    ) {
      return last;
    }
    await sleep(1000);
  }
  fail(`packaged UI did not finish rendering: ${JSON.stringify(last)}`);
}

async function verifyTitlebarIcon(cdp) {
  const result = await cdp.call('Runtime.evaluate', {
    expression: `(() => {
      const icon = document.querySelector('#title-app-icon');
      const logo = document.querySelector('#title-app-logo');
      if (!icon || !logo) return { missing: true };
      const rect = icon.getBoundingClientRect();
      const logoRect = logo.getBoundingClientRect();
      const before = getComputedStyle(logo, '::before');
      return {
        missing: false,
        iconSrc: icon.getAttribute('src'),
        resolvedSrc: icon.currentSrc || icon.src,
        complete: icon.complete,
        naturalWidth: icon.naturalWidth,
        naturalHeight: icon.naturalHeight,
        width: rect.width,
        height: rect.height,
        logoWidth: logoRect.width,
        logoHeight: logoRect.height,
        borderAnimationName: before.animationName,
        borderAnimationDuration: before.animationDuration,
        borderBackground: before.backgroundImage,
      };
    })()`,
    returnByValue: true,
  });
  const state = result.result && result.result.value;
  if (!state || state.missing) fail(`titlebar app icon missing in packaged renderer: ${JSON.stringify(state)}`);
  if (!String(state.iconSrc || '').includes('app-icon-dark.png')) fail(`titlebar app icon src mismatch: ${JSON.stringify(state)}`);
  if (!state.complete || state.naturalWidth < 16 || state.naturalHeight < 16) fail(`titlebar app icon did not decode: ${JSON.stringify(state)}`);
  if (state.width < 20 || state.height < 20 || state.logoWidth < 24 || state.logoHeight < 24) fail(`titlebar app icon layout too small: ${JSON.stringify(state)}`);
  if (state.borderAnimationName !== 'app-icon-border-spin') fail(`titlebar animated border missing animation: ${JSON.stringify(state)}`);
  if (!String(state.borderAnimationDuration || '').includes('3s')) fail(`titlebar animated border duration mismatch: ${JSON.stringify(state)}`);
  if (!String(state.borderBackground || '').includes('conic-gradient')) fail(`titlebar animated border gradient missing: ${JSON.stringify(state)}`);
  return state;
}

function cdpClient(wsUrl) {
  const WebSocket = global.WebSocket;
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const callbacks = new Map();
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && callbacks.has(msg.id)) {
      const cb = callbacks.get(msg.id);
      callbacks.delete(msg.id);
      clearTimeout(cb.timer);
      if (msg.error) cb.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else cb.resolve(msg.result);
    }
  });
  return {
    ready: new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    }),
    call(method, params = {}, timeout = 15000) {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          callbacks.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, timeout);
        callbacks.set(id, { resolve, reject, timer });
      });
    },
    close() {
      ws.close();
    },
  };
}

function saveRuntimeWindowIcon(pid) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    '$sig = @\'',
    '[DllImport("user32.dll", SetLastError=true)] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);',
    '[DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
    '[DllImport("user32.dll", SetLastError=true)] public static extern bool IsWindowVisible(IntPtr hWnd);',
    '[DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);',
    'public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
    '\'@',
    'Add-Type -MemberDefinition $sig -Name Win32Icon -Namespace NewmarkSmoke',
    `$targetPid = [uint32]${Number(pid)}`,
    '$script:hwnd = [IntPtr]::Zero',
    '$callback = [NewmarkSmoke.Win32Icon+EnumWindowsProc]{ param([IntPtr]$hWnd, [IntPtr]$lParam)',
    '  [uint32]$windowPid = 0',
    '  [void][NewmarkSmoke.Win32Icon]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)',
    '  if ($windowPid -eq $targetPid -and [NewmarkSmoke.Win32Icon]::IsWindowVisible($hWnd)) { $script:hwnd = $hWnd; return $false }',
    '  return $true',
    '}',
    '[void][NewmarkSmoke.Win32Icon]::EnumWindows($callback, [IntPtr]::Zero)',
    'if ($script:hwnd -eq [IntPtr]::Zero) { throw "Newmark Agent visible window not found for pid $targetPid" }',
    '$WM_GETICON = 0x7F',
    '$ICON_BIG = [IntPtr]1',
    '$ICON_SMALL2 = [IntPtr]2',
    '$hicon = [NewmarkSmoke.Win32Icon]::SendMessage($script:hwnd, $WM_GETICON, $ICON_BIG, [IntPtr]::Zero)',
    'if ($hicon -eq [IntPtr]::Zero) { $hicon = [NewmarkSmoke.Win32Icon]::SendMessage($script:hwnd, $WM_GETICON, $ICON_SMALL2, [IntPtr]::Zero) }',
    'if ($hicon -eq [IntPtr]::Zero) { throw "runtime window icon handle is empty" }',
    `$icon = [System.Drawing.Icon]::FromHandle($hicon)`,
    `$bmp = $icon.ToBitmap()`,
    `$out = '${windowIconPath.replace(/'/g, "''")}'`,
    '$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$bmp.Dispose()',
    '$icon.Dispose()',
    'Write-Output "RUNTIME_WINDOW_ICON_OK"',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) fail(`runtime window icon capture failed: ${result.stderr || result.stdout}`);
  if (!fs.existsSync(windowIconPath) || fs.statSync(windowIconPath).size <= 0) fail('runtime window icon capture is empty');
}

function cleanupReleaseProcesses() {
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    "$targets = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Newmark Agent.exe' -and (($_.ExecutablePath -like '*Newmark Agent*release*') -or ($_.CommandLine -like '*Newmark Agent*release*')) }; foreach ($p in $targets) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Output 'cleanup ok'",
  ], { encoding: 'utf8', windowsHide: true });
}

function tryRemoveRoot(root) {
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
      if (!fs.existsSync(root)) return;
    } catch (_) {}
  }
  console.warn(`[release-ui-icon-smoke] could not remove temp root: ${root}`);
}

async function main() {
  ensureReleaseAssets();
  cleanupReleaseProcesses();
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiIconSmoke-'));
  const port = Number(process.env.NEWMARK_UI_ICON_SMOKE_PORT || '49351');
  let child;
  let cdp;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const wsUrl = await waitForCdp(port);
    cdp = cdpClient(wsUrl);
    await cdp.ready;
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitForRenderedUi(cdp);
    const titlebarIcon = await verifyTitlebarIcon(cdp);
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    if (fs.statSync(screenshotPath).size < 1000) fail('UI screenshot is too small');
    saveRuntimeWindowIcon(child.pid);
    console.log(`[release-ui-icon-smoke] titlebarIcon=${JSON.stringify({
      iconSrc: titlebarIcon.iconSrc,
      naturalWidth: titlebarIcon.naturalWidth,
      naturalHeight: titlebarIcon.naturalHeight,
      borderAnimationName: titlebarIcon.borderAnimationName,
      borderAnimationDuration: titlebarIcon.borderAnimationDuration,
    })}`);
    console.log(`[release-ui-icon-smoke] screenshot=${screenshotPath}`);
    console.log(`[release-ui-icon-smoke] runtimeWindowIcon=${windowIconPath}`);
    console.log('[release-ui-icon-smoke] win-unpacked exe associated icon, app.asar icon assets, runtime window icon, titlebar UI icon, animated color border, and packaged UI screenshot verified');
  } finally {
    if (cdp) cdp.close();
    if (child && !child.killed) child.kill();
    cleanupReleaseProcesses();
    tryRemoveRoot(root);
  }
}

main().catch(err => {
  console.error(`[release-ui-icon-smoke] ${err.message}`);
  cleanupReleaseProcesses();
  process.exit(1);
});
