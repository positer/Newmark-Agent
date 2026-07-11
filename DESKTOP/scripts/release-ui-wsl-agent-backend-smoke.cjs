const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(message) { throw new Error(message); }

function getJson(url) {
  const http = require('http');
  return new Promise((resolve, reject) => http.get(url, response => {
    let data = '';
    response.on('data', chunk => { data += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
  }).on('error', reject));
}

async function waitTarget(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = list.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(300);
  }
  fail('CDP target timeout');
}

function connect(target) {
  let id = 1;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
    };
  });
  const call = (method, params = {}, timeout = 120000) => new Promise((resolve, reject) => {
    const current = id++;
    pending.set(current, { resolve, reject });
    ws.send(JSON.stringify({ id: current, method, params }));
    setTimeout(() => { if (pending.delete(current)) reject(new Error(`timeout ${method}`)); }, timeout);
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

function writeConfig(root, port, runInWsl) {
  const source = JSON.parse(fs.readFileSync(path.join(repoRoot, 'DESKTOP', 'config.example.json'), 'utf8'));
  source.agent = source.agent || {};
  source.models = source.models || {};
  source.workspace = source.workspace || {};
  source.agent.run_in_wsl = { value: runInWsl };
  source.agent.wsl_distro = { value: 'Ubuntu-24.04' };
  source.workspace.auto_create_timestamp_workspace = { value: false };
  source.models.default_model = { value: 'WSL Mock/wsl-agent-test' };
  source.models.openai_api_mode = { value: 'chat' };
  source.models.providers = { value: [{ name: 'WSL Mock', url: `http://127.0.0.1:${port}/v1`, api_key: 'test-only', protocol: 'openai', models: [{ name: 'wsl-agent-test', evaluation: { status: 'available' } }] }] };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(source, null, 2));
}

async function launch(root, port) {
  const child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], { stdio: 'ignore', windowsHide: true });
  const target = await waitTarget(port);
  const cdp = connect(target);
  await cdp.ready;
  await cdp.call('Runtime.enable');
  return { child, cdp };
}

function stopReleaseProcesses() {
  spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force"], { windowsHide: true });
}

(async () => {
  if (process.platform !== 'win32') return;
  const mockPort = 61908;
  const mockScript = path.join(repoRoot, 'DESKTOP', 'scripts', 'wsl-mock-provider.cjs').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`).replace(/\\/g, '/');
  const api = spawn('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'node', mockScript, String(mockPort)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WSL mock provider startup timeout')), 10000);
    api.stdout.on('data', chunk => { if (String(chunk).includes('READY')) { clearTimeout(timer); resolve(); } });
    api.on('exit', code => reject(new Error(`WSL mock provider exited: ${code}`)));
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkWslUi-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkWslExternal-'));
  let app;
  try {
    writeConfig(root, mockPort, false);
    app = await launch(root, 49410);
    const before = await evaluate(app.cdp, `window.api.getState().then(s => ({actual:s.agentBackend,configured:s.configuredAgentBackend,wslAvailable:s.wslAvailable,wslDistros:s.wslDistros}))`);
    if (before.actual.enabled || before.configured !== 'windows' || !before.wslAvailable) fail(`native precondition failed: ${JSON.stringify(before)}`);
    await evaluate(app.cdp, `window.api.saveSetting('agent','run_in_wsl',true)`);
    const pending = await evaluate(app.cdp, `window.api.getState().then(s => ({actual:s.agentBackend,configured:s.configuredAgentBackend,restart:s.agentBackendRestartRequired}))`);
    if (pending.actual.enabled || pending.configured !== 'wsl' || !pending.restart) fail(`restart-required switch failed: ${JSON.stringify(pending)}`);
    app.cdp.ws.close(); app.child.kill(); await sleep(1000); stopReleaseProcesses();

    app = await launch(root, 49411);
    const backendTest = await evaluate(app.cdp, `window.api.wslBackendTest()`);
    const connected = await evaluate(app.cdp, `window.api.getState().then(s => ({backend:s.agentBackend,configured:s.configuredAgentBackend,restart:s.agentBackendRestartRequired}))`);
    if (!backendTest.ok || !connected.backend.enabled || !connected.backend.connected || connected.configured !== 'wsl' || connected.restart) fail(`WSL restart activation failed: ${JSON.stringify({ backendTest, connected })}`);
    const created = await evaluate(app.cdp, `window.api.createExternalWorkspace('wsl-external',${JSON.stringify(workspace)})`);
    if (!created || created.error) fail(`workspace create failed: ${JSON.stringify(created)}`);
    await evaluate(app.cdp, `window.api.selectWorkspace(${JSON.stringify(created.id || created.name)})`);
    const response = await evaluate(app.cdp, `window.api.sendMessage('Create the requested proof file now.','wsl-proof')`);
    const proofPath = path.join(workspace, 'wsl-backend-proof.txt');
    if (!fs.existsSync(proofPath) || fs.readFileSync(proofPath, 'utf8') !== 'WSL_BACKEND_TOOL_OK') fail(`WSL tool did not create proof file: ${JSON.stringify(response)}`);
    const runtimeHost = path.join(repoRoot, 'release', 'win-unpacked', 'resources', 'app.asar.unpacked', 'dist', 'wsl-agent-host.bundle.cjs');
    if (!fs.existsSync(runtimeHost)) fail(`packaged WSL runtime bundle missing: ${runtimeHost}`);
    const snapshotA = await evaluate(app.cdp, `window.api.getState('wsl-proof').then(s => ({id:s.conversationId,messages:s.chatMessages,backend:s.agentBackend}))`);
    const snapshotB = await evaluate(app.cdp, `window.api.getState('wsl-other').then(s => ({id:s.conversationId,messages:s.chatMessages}))`);
    if (snapshotA.id !== 'wsl-proof' || snapshotB.id !== 'wsl-other' || (snapshotB.messages || []).some(message => String(message.content || '').includes('WSL_BACKEND_AGENT_OK'))) fail('WSL conversation isolation failed');
    await evaluate(app.cdp, `window.api.saveSetting('agent','run_in_wsl',false)`);
    const switchBack = await evaluate(app.cdp, `window.api.getState().then(s => ({actual:s.agentBackend,configured:s.configuredAgentBackend,restart:s.agentBackendRestartRequired}))`);
    if (!switchBack.actual.enabled || switchBack.configured !== 'windows' || !switchBack.restart) fail(`switch-back restart contract failed: ${JSON.stringify(switchBack)}`);
    console.log(`[release-ui-wsl-agent-backend-smoke] PASS backendPid=${connected.backend.pid}`);
  } finally {
    try { app?.cdp.ws.close(); } catch {}
    try { app?.child.kill(); } catch {}
    stopReleaseProcesses();
    api.kill();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); stopReleaseProcesses(); process.exit(1); });
