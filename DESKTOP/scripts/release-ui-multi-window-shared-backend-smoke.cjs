const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const keepRoot = process.env.NEWMARK_KEEP_UI_MULTI_WINDOW_SHARED_BACKEND_SMOKE === '1';
const workspaceName = 'multi-window-shared-backend';

function log(message) { console.log(`[release-ui-multi-window-shared-backend-smoke] ${message}`); }
function fail(message) { throw new Error(message); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function js(value) { return JSON.stringify(String(value)); }

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

async function waitForTargets(port, minTargets) {
  const deadline = Date.now() + 45000;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      lastTargets = targets.filter(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview'));
      const appTargets = lastTargets.filter(t => String(t.url || '').includes('index.html'));
      if (appTargets.length >= minTargets) return appTargets.slice(0, minTargets);
    } catch {}
    await sleep(500);
  }
  fail(`Timed out waiting for ${minTargets} Electron CDP targets; last=${JSON.stringify(lastTargets.map(t => ({ title: t.title, url: t.url })))}`);
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
      pending.set(id, { resolve, reject, timer });
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
      clearTimeout(callbacks.timer);
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
    try {
      lastValue = await evaluate(cdp, expression, 10000);
      if (lastValue) return lastValue;
      const debug = await evaluate(cdp, `window.__multiWindowDebug || null`, 10000).catch(() => null);
      if (debug) lastValue = debug;
    } catch (error) {
      lastValue = error.message;
    }
    await sleep(250);
  }
  fail(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)}`);
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
    terminal: { interrupt_timeout_ms: 0 },
    general: { language: 'en' },
    workspace: {
      auto_create_timestamp_workspace: false,
      prompt_mode: 'both',
      access_permission: 'full_access',
      on_permission_violation: 'deny',
    },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

async function prepareWindow(cdp, label) {
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.api && !!window.refreshWorkspaceState && !!document.querySelector('#conversation-list'))()`, 30000, `${label} renderer ready`);
  await evaluate(cdp, `window.api.createWorkspace(${js(workspaceName)}).then(ws => window.api.selectWorkspace(ws.name)).then(() => window.refreshWorkspaceState()).then(() => { window.selectWorkspace(${js(workspaceName)}); return true; })`, 30000);
  await waitFor(cdp, `window.api.getState(activeConversationId()).then(s => s.workspaces && s.workspaces.current && s.workspaces.current.name === ${js(workspaceName)})`, 30000, `${label} workspace selected`);
}

function activeSummaryExpression(expectedId) {
  return `(() => {
    const active = document.querySelector('#conversation-list .conv-item.active .conv-summary');
    const activeId = activeConversationId();
    const ok = activeId === ${js(expectedId)} && !!active;
    if (!ok) window.__multiWindowDebug = {
      expectedId: ${js(expectedId)},
      actualId: activeId,
      activeSummary: active ? active.innerText : '',
      conversations: (window.state && window.state.conversations || []).map(c => ({ id: c.id, active: c.active, summary: c.summary })),
      chatTail: (document.querySelector('#chat-area')?.innerText || '').slice(-800),
    };
    return ok;
  })()`;
}

async function runUiCheck(root) {
  writeConfig(root);
  const port = Number(process.env.NEWMARK_UI_MULTI_WINDOW_SHARED_BACKEND_PORT || '49391');
  let first;
  let second;
  let cdpA;
  let cdpB;
  try {
    first = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let targets = await waitForTargets(port, 1);
    const firstTargetId = targets[0].id;
    cdpA = connectCdp(targets[0]);
    await cdpA.ready;
    await waitForPromotedMainUi(cdpA);
    await prepareWindow(cdpA, 'window A');

    second = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
      stdio: 'ignore',
      windowsHide: true,
    });
    targets = await waitForTargets(port, 2);
    const secondTarget = targets.find(t => t.id !== firstTargetId) || targets[1];
    if (!secondTarget || secondTarget.id === firstTargetId) fail(`second launch did not expose a distinct CDP target; targets=${JSON.stringify(targets.map(t => ({ id: t.id, title: t.title, url: t.url })))}`);
    cdpB = connectCdp(secondTarget);
    await cdpB.ready;
    await waitForPromotedMainUi(cdpB);
    await prepareWindow(cdpB, 'window B');

    await evaluate(cdpA, `window.api.getState('default').then(s => {
      window.__multiWindowMainPid = s && s.pid;
      return true;
    })`, 10000).catch(() => undefined);

    const defaultA = await evaluate(cdpA, `activeConversationId()`);
    const defaultB = await evaluate(cdpB, `activeConversationId()`);
    if (defaultA !== 'default' || defaultB !== 'default') fail(`expected both windows to start on default: A=${defaultA} B=${defaultB}`);

    const convA = await evaluate(cdpA, `new Promise(resolve => {
      window.newConversation();
      setTimeout(() => resolve(activeConversationId()), 900);
    })`, 10000);
    if (!String(convA).startsWith('conv-')) fail(`window A did not create a new conversation: ${convA}`);
    await waitFor(cdpA, activeSummaryExpression(convA), 10000, 'window A active conversation after create');

    await evaluate(cdpB, `window.refreshWorkspaceState().then(() => { window.renderConversations(); return true; })`, 30000);
    await waitFor(cdpB, activeSummaryExpression('default'), 10000, 'window B remains default after A creates conversation');

    const convB = await evaluate(cdpB, `new Promise(resolve => {
      window.newConversation();
      setTimeout(() => resolve(activeConversationId()), 900);
    })`, 10000);
    if (!String(convB).startsWith('conv-') || convB === convA) fail(`window B did not create a distinct new conversation: A=${convA} B=${convB}`);
    await waitFor(cdpB, activeSummaryExpression(convB), 10000, 'window B active conversation after create');

    await evaluate(cdpA, `window.refreshWorkspaceState().then(() => { window.renderConversations(); return true; })`, 30000);
    await waitFor(cdpA, activeSummaryExpression(convA), 10000, 'window A remains on its own conversation after B creates conversation');

    const processSummary = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "$all = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*Newmark Agent.exe' }); $main = @($all | Where-Object { $_.CommandLine -like '*--root*' -and $_.CommandLine -notlike '*--type=*' }); $mainIds = @($main | ForEach-Object { $_.ProcessId }); $children = @($all | Where-Object { $mainIds -contains $_.ParentProcessId }); $renderers = @($children | Where-Object { $_.CommandLine -like '*--type=renderer*' }); [pscustomobject]@{ main=$main.Count; renderer=$renderers.Count; child=$children.Count; total=$all.Count } | ConvertTo-Json -Compress",
    ], { encoding: 'utf8', windowsHide: true });
    const processJson = JSON.parse(String(processSummary.stdout || '{}'));
    if (processJson.main !== 1) fail(`expected one Electron main/backend process after second launch, got ${JSON.stringify(processJson)}`);
    if (targets.length < 2) fail(`expected at least two CDP page targets after second launch, got ${targets.length}`);
    log(`single shared backend verified: ${JSON.stringify(processJson)}; cdpTargets=${targets.length}; windowA=${convA}; windowB=${convB}`);
  } finally {
    try { if (cdpA?.ws) cdpA.ws.close(); } catch {}
    try { if (cdpB?.ws) cdpB.ws.close(); } catch {}
    try { if (second && !second.killed) second.kill(); } catch {}
    try { if (first && !first.killed) first.kill(); } catch {}
    await sleep(1000);
    const cleanup = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force; Write-Output 'STOP_RELEASE_PROCESSES_OK'",
    ], { encoding: 'utf8', windowsHide: true });
    if (cleanup.status !== 0) log(`warning: cleanup failed: ${cleanup.stderr || cleanup.stdout}`);
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkMultiWindowSharedBackendSmoke-'));
  try {
    await runUiCheck(root);
    log('all multi-window shared-backend isolation checks passed');
  } finally {
    if (keepRoot) log(`kept root: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(`[release-ui-multi-window-shared-backend-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
