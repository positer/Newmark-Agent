const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const desktopRoot = path.join(repoRoot, 'DESKTOP');
const sourceMode = process.env.NEWMARK_WSL_SMOKE_SOURCE === '1';
const packagedExePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const sourceElectronPath = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(message) { throw new Error(message); }

async function removeTreeWithRetry(target) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code) || attempt === 19) throw error;
      await sleep(250);
    }
  }
}

function freeTcpPort() {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function getJson(url) {
  const http = require('http');
  return new Promise((resolve, reject) => http.get(url, response => {
    let data = '';
    response.on('data', chunk => { data += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
  }).on('error', reject));
}

async function waitTarget(port) {
  for (let i = 0; i < 200; i++) {
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
  source.models.providers = { value: [{ name: 'WSL Mock', url: `http://127.0.0.1:${port}/v1`, api_key: 'test-only', protocol: 'openai', models: [{ name: 'wsl-agent-test', vision: true, evaluation: { status: 'available' } }] }] };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(source, null, 2));
}

async function launch(root, port) {
  const userDataDir = path.join(root, `.electron-user-data-${port}`);
  const executable = sourceMode ? sourceElectronPath : packagedExePath;
  const args = [
    ...(sourceMode ? ['.'] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--allow-multiple-instances',
    '--no-sandbox',
    '--no-devtools',
    '--root',
    root,
  ];
  const child = spawn(executable, args, {
    cwd: sourceMode ? desktopRoot : undefined,
    stdio: process.env.NEWMARK_SMOKE_DEBUG === '1' ? 'inherit' : 'ignore',
    windowsHide: true,
  });
  const target = await waitTarget(port);
  const cdp = connect(target);
  await cdp.ready;
  await waitForPromotedMainUi(cdp);
  await cdp.call('Page.bringToFront', {}, 10000).catch(() => undefined);
  await cdp.call('Runtime.enable');
  return { child, cdp };
}

function stopSmokeProcesses() {
  const command = sourceMode
    ? "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*Newmark Agent*DESKTOP*node_modules*electron*' } | Stop-Process -Force"
    : "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force";
  spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true });
}

function computerUseTempFiles() {
  const directory = path.join(os.tmpdir(), 'newmark-computer-use');
  try {
    return new Set(fs.readdirSync(directory).filter(name => /^(?:observe|app)-.*\.(?:jpg|jpeg|png)$/i.test(name)));
  } catch {
    return new Set();
  }
}

(async () => {
  if (process.platform !== 'win32') return;
  const launchExecutable = sourceMode ? sourceElectronPath : packagedExePath;
  if (!fs.existsSync(launchExecutable)) fail(`${sourceMode ? 'source Electron' : 'packaged executable'} is missing`);
  const mockPort = await freeTcpPort();
  const mockScript = path.join(repoRoot, 'DESKTOP', 'scripts', 'wsl-mock-provider.cjs').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`).replace(/\\/g, '/');
  const api = spawn('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'node', mockScript, String(mockPort)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let providerStderr = '';
  api.stderr.on('data', chunk => { providerStderr += String(chunk); });
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(new Error(`WSL mock provider startup timeout: ${providerStderr.slice(-1200)}`)), 30000);
      api.stdout.on('data', chunk => { if (String(chunk).includes('READY')) finish(); });
      api.on('error', error => finish(error));
      api.on('exit', code => finish(new Error(`WSL mock provider exited: ${code}: ${providerStderr.slice(-1200)}`)));
    });
  } catch (error) {
    api.kill();
    throw error;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkWslUi-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkWslExternal-'));
  const nativeCdpPort = await freeTcpPort();
  const wslCdpPort = await freeTcpPort();
  console.log(`[release-ui-wsl-agent-backend-smoke] mode=${sourceMode ? 'source' : 'packaged'} ports provider=${mockPort} nativeCdp=${nativeCdpPort} wslCdp=${wslCdpPort}`);
  let app;
  try {
    writeConfig(root, mockPort, false);
    app = await launch(root, nativeCdpPort);
    let before;
    for (let attempt = 0; attempt < 80; attempt++) {
      before = await evaluate(app.cdp, `window.api.getState().then(s => ({actual:s.agentBackend,configured:s.configuredAgentBackend,wslAvailable:s.wslAvailable,wslDistros:s.wslDistros}))`);
      if (before.wslAvailable) break;
      await sleep(250);
    }
    if (before.actual.enabled || before.configured !== 'windows' || !before.wslAvailable) fail(`native precondition failed: ${JSON.stringify(before)}`);
    await evaluate(app.cdp, `window.api.saveSetting('agent','run_in_wsl',true)`);
    const pending = await evaluate(app.cdp, `window.api.getState().then(s => ({actual:s.agentBackend,configured:s.configuredAgentBackend,restart:s.agentBackendRestartRequired}))`);
    if (pending.actual.enabled || pending.configured !== 'wsl' || !pending.restart) fail(`restart-required switch failed: ${JSON.stringify(pending)}`);
    app.cdp.ws.close(); app.child.kill(); await sleep(1000); stopSmokeProcesses();

    app = await launch(root, wslCdpPort);
    const backendTest = await evaluate(app.cdp, `window.api.wslBackendTest()`);
    const connected = await evaluate(app.cdp, `window.api.getState().then(s => ({backend:s.agentBackend,configured:s.configuredAgentBackend,restart:s.agentBackendRestartRequired}))`);
    if (!backendTest.ok || !connected.backend.enabled || !connected.backend.connected || connected.configured !== 'wsl' || connected.restart) fail(`WSL restart activation failed: ${JSON.stringify({ backendTest, connected })}`);
    const created = await evaluate(app.cdp, `window.api.createExternalWorkspace('wsl-external',${JSON.stringify(workspace)})`);
    if (!created || created.error) fail(`workspace create failed: ${JSON.stringify(created)}`);
    const selected = await evaluate(app.cdp, `window.api.selectWorkspace(${JSON.stringify(created.id || created.name)})`);
    const proofTarget = { workspaceId: String(selected?.id || created.id || created.name), conversationId: 'wsl-proof' };
    const otherTarget = { workspaceId: proofTarget.workspaceId, conversationId: 'wsl-other' };
    await evaluate(app.cdp, `window.api.ensureConversation(${JSON.stringify(proofTarget)})`);
    const response = await evaluate(app.cdp, `window.api.sendMessage('WSL_PROOF_SMOKE: Create the requested proof file now.',${JSON.stringify(proofTarget)})`);
    const proofPath = path.join(workspace, 'wsl-backend-proof.txt');
    if (!fs.existsSync(proofPath) || fs.readFileSync(proofPath, 'utf8') !== 'WSL_BACKEND_TOOL_OK') fail(`WSL tool did not create proof file: ${JSON.stringify(response)}`);
    const runtimeHost = sourceMode
      ? path.join(desktopRoot, 'dist', 'wsl-agent-host.bundle.cjs')
      : path.join(repoRoot, 'release', 'win-unpacked', 'resources', 'app.asar.unpacked', 'dist', 'wsl-agent-host.bundle.cjs');
    if (!fs.existsSync(runtimeHost)) fail(`${sourceMode ? 'source' : 'packaged'} WSL runtime bundle missing`);
    const snapshotA = await evaluate(app.cdp, `window.api.getState(${JSON.stringify(proofTarget)}).then(s => ({id:s.conversationId,messages:s.chatMessages,backend:s.agentBackend}))`);
    const snapshotB = await evaluate(app.cdp, `window.api.getState(${JSON.stringify(otherTarget)}).then(s => ({id:s.conversationId,messages:s.chatMessages}))`);
    if (snapshotA.id !== 'wsl-proof' || snapshotB.id !== 'wsl-other' || (snapshotB.messages || []).some(message => String(message.content || '').includes('WSL_BACKEND_AGENT_OK'))) fail('WSL conversation isolation failed');

    const visionTarget = { workspaceId: proofTarget.workspaceId, conversationId: 'wsl-vision' };
    await evaluate(app.cdp, `window.api.ensureConversation(${JSON.stringify(visionTarget)})`);
    const tempBeforeVision = computerUseTempFiles();
    await evaluate(app.cdp, `window.api.sendMessage('WSL_VISION_SMOKE: Observe the current desktop once, use the visual input, then finish.',${JSON.stringify(visionTarget)})`);
    await sleep(500);
    const providerStats = await getJson(`http://127.0.0.1:${mockPort}/stats`);
    const visionStats = providerStats?.vision || {};
    const secondRequest = visionStats.secondRequest || {};
    if (visionStats.requests !== 2 || visionStats.toolCallIssued !== 1 || visionStats.toolResultSeen !== 1) {
      fail(`WSL vision tool loop request count mismatch: ${JSON.stringify({ requests: visionStats.requests, toolCallIssued: visionStats.toolCallIssued, toolResultSeen: visionStats.toolResultSeen })}`);
    }
    if (secondRequest.toolMessageCount < 1 || secondRequest.imageUrlDataCount !== 1 || secondRequest.uiAutomationText !== true) {
      fail(`WSL vision second request did not contain one image plus UI Automation text: ${JSON.stringify(secondRequest)}`);
    }
    if (secondRequest.leakedTransportKey || secondRequest.leakedTempPath) fail('WSL vision second request exposed vision_image_path, vision_image_data_url, or a Computer Use temporary path');
    const visionSnapshot = await evaluate(app.cdp, `window.api.getState(${JSON.stringify(visionTarget)}).then(s => ({id:s.conversationId,messages:s.chatMessages}))`);
    if (visionSnapshot.id !== 'wsl-vision' || !(visionSnapshot.messages || []).some(message => String(message.content || '').includes('WSL_VISION_AGENT_OK'))) fail('WSL vision conversation did not complete independently');
    const newTempResidue = [...computerUseTempFiles()].filter(name => !tempBeforeVision.has(name));
    if (newTempResidue.length) fail(`WSL vision left ${newTempResidue.length} new Computer Use temporary frame(s)`);

    await evaluate(app.cdp, `window.api.saveSetting('agent','run_in_wsl',false)`);
    const switchBack = await evaluate(app.cdp, `window.api.getState().then(s => ({actual:s.agentBackend,configured:s.configuredAgentBackend,restart:s.agentBackendRestartRequired}))`);
    if (!switchBack.actual.enabled || switchBack.configured !== 'windows' || !switchBack.restart) fail(`switch-back restart contract failed: ${JSON.stringify(switchBack)}`);
    console.log(`[release-ui-wsl-agent-backend-smoke] PASS mode=${sourceMode ? 'source' : 'packaged'} backendPid=${connected.backend.pid} visionRequests=${visionStats.requests} visionImages=${secondRequest.imageUrlDataCount} tempResidue=0`);
  } finally {
    try { app?.cdp.ws.close(); } catch {}
    try { app?.child.kill(); } catch {}
    stopSmokeProcesses();
    api.kill();
    await sleep(750);
    try { await removeTreeWithRetry(root); } catch (error) { console.warn(`[release-ui-wsl-agent-backend-smoke] cleanup warning: ${error.message}`); }
    try { await removeTreeWithRetry(workspace); } catch (error) { console.warn(`[release-ui-wsl-agent-backend-smoke] cleanup warning: ${error.message}`); }
  }
})().catch(error => { console.error(error.stack || error); stopSmokeProcesses(); process.exit(1); });
