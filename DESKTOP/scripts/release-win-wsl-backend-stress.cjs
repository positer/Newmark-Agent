'use strict';

/**
 * dev-0.4.5 win 打包版 + WSL 后端表现压力测试（win-unpack）
 *
 * 驱动打包后的 Windows exe（WSL Agent 后端 = Ubuntu），在 Windows workspace 上做
 * 多轮压力，重点验证：
 *   1. WSL 后端跨环境写文件 → Windows workspace（/mnt/<drive> 路径映射）稳定；
 *   2. N 个对话隔离（每对话独立 WSL 工具执行 + 完成标记不串）；
 *   3. 同一对话连续多轮 send 稳定；
 *   4. mock provider 的请求/工具调用/工具结果计数精确匹配。
 *
 * 复用 release-ui-wsl-agent-backend-smoke 的 launch/CDP 机制与 wsl-mock-provider。
 * 运行：NEWMARK_TEST_EXE=<win-unpacked>\Newmark Agent.exe node scripts/release-win-wsl-backend-stress.cjs
 */

const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const desktopRoot = path.join(repoRoot, 'DESKTOP');
const packagedExePath = process.env.NEWMARK_TEST_EXE || path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const distro = process.env.NEWMARK_WSL_DISTRO || 'Ubuntu-24.04';
const N = Math.max(2, Number(process.env.NEWMARK_WSL_STRESS_CONVERSATIONS || 6));
const M = Math.max(1, Number(process.env.NEWMARK_WSL_STRESS_REPEATS || 4));
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
  source.agent.wsl_distro = { value: distro };
  source.workspace.auto_create_timestamp_workspace = { value: true };
  source.models.default_model = { value: 'WSL Mock/wsl-agent-test' };
  source.models.openai_api_mode = { value: 'chat' };
  source.models.providers = { value: [{ name: 'WSL Mock', url: `http://127.0.0.1:${port}/v1`, api_key: 'test-only', protocol: 'openai', models: [{ name: 'wsl-agent-test', vision: true, evaluation: { status: 'available' } }] }] };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(source, null, 2));
}

async function launch(root, port) {
  const userDataDir = path.join(root, `.electron-user-data-${port}`);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox',
    '--root',
    root,
  ];
  const child = spawn(packagedExePath, args, {
    cwd: undefined,
    stdio: process.env.NEWMARK_SMOKE_DEBUG === '1' ? 'inherit' : 'ignore',
    windowsHide: true,
  });
  const target = await waitTarget(port);
  const cdp = connect(target);
  await cdp.ready;
  await waitForPromotedMainUi(cdp, { timeoutMs: 120_000 });
  await cdp.call('Page.bringToFront', {}, 10000).catch(() => undefined);
  await cdp.call('Runtime.enable');
  return { child, cdp };
}

function stopSmokeProcesses() {
  spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force"], { windowsHide: true });
}

async function waitForFile(filePath, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return content;
    }
    await sleep(250);
  }
  fail(`${label} file did not appear: ${filePath}`);
}

async function waitForMessage(cdp, target, marker, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluate(cdp, `window.api.getState(${JSON.stringify(target)}).then(s => (s.chatMessages || []).some(m => String(m.content || '').includes(${JSON.stringify(marker)})))`);
    if (found) return true;
    await sleep(250);
  }
  fail(`${label} message marker missing: ${marker}`);
}

function assertIsolation(cdp, target, own, others, label) {
  return evaluate(cdp, `window.api.getState(${JSON.stringify(target)}).then(s => {
    const text = (s.chatMessages || []).map(m => String(m.content || '')).join('\\n');
    const leaked = ${JSON.stringify(others)}.filter(marker => text.includes(marker));
    return { own: text.includes(${JSON.stringify(own)}), leaked };
  })`).then(result => {
    if (!result.own || result.leaked.length) fail(`${label} isolation failed: ${JSON.stringify(result)}`);
  });
}

(async () => {
  if (process.platform !== 'win32') {
    console.log('[release-win-wsl-backend-stress] skipped outside Windows');
    return;
  }
  if (!fs.existsSync(packagedExePath)) fail(`packaged executable is missing: ${packagedExePath}`);

  const mockPort = await freeTcpPort();
  const mockScript = path.join(repoRoot, 'DESKTOP', 'scripts', 'wsl-mock-provider.cjs').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`).replace(/\\/g, '/');
  const api = spawn('wsl.exe', ['-d', distro, '--', 'node', mockScript, String(mockPort)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkWslStress-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkWslStressWs-'));
  const nativeCdpPort = await freeTcpPort();
  const wslCdpPort = await freeTcpPort();
  console.log(`[release-win-wsl-backend-stress] distro=${distro} conversations=${N} repeats=${M} provider=${mockPort} nativeCdp=${nativeCdpPort} wslCdp=${wslCdpPort}`);
  let app;
  try {
    // 两阶段启动：先 native 预热（检测并缓存 WSL distro），再切 WSL 重启，
    // 对齐 release-ui-wsl-agent-backend-smoke 的成熟启动顺序，避免 WSL 冷启动竞态。
    writeConfig(root, mockPort, false);
    app = await launch(root, nativeCdpPort);
    let before;
    for (let attempt = 0; attempt < 80; attempt++) {
      before = await evaluate(app.cdp, `window.api.getState().then(s => ({wslAvailable:s.wslAvailable}))`);
      if (before.wslAvailable) break;
      await sleep(250);
    }
    if (!before.wslAvailable) fail(`WSL distro unavailable: ${JSON.stringify(before)}`);
    await evaluate(app.cdp, `window.api.saveSetting('agent','run_in_wsl',true)`);
    const pending = await evaluate(app.cdp, `window.api.getState().then(s => ({configured:s.configuredAgentBackend,restart:s.agentBackendRestartRequired}))`);
    if (pending.configured !== 'wsl' || !pending.restart) fail(`restart-required switch failed: ${JSON.stringify(pending)}`);
    app.cdp.ws.close(); app.child.kill(); await sleep(1000); stopSmokeProcesses();

    app = await launch(root, wslCdpPort);
    const connected = await evaluate(app.cdp, `window.api.getState().then(s => ({backend:s.agentBackend,configured:s.configuredAgentBackend}))`);
    if (!connected.backend?.enabled || !connected.backend?.connected || connected.configured !== 'wsl') {
      fail(`WSL backend not connected: ${JSON.stringify(connected)}`);
    }
    const created = await evaluate(app.cdp, `window.api.createExternalWorkspace('wsl-stress', ${JSON.stringify(workspace)})`);
    if (!created || created.error) fail(`workspace create failed: ${JSON.stringify(created)}`);
    const selected = await evaluate(app.cdp, `window.api.selectWorkspace(${JSON.stringify(created.id || created.name)})`);
    const workspaceId = String(selected?.id || created.id || created.name);

    const markers = [];
    for (let i = 1; i <= N + M; i++) markers.push(`WSL_STRESS_AGENT_OK_${i}`);

    // 压力 A：N 个独立对话，各执行一次 WSL 后端 write（写入 Windows workspace）。
    for (let i = 1; i <= N; i++) {
      const conversationId = `wsl-stress-${i}`;
      const target = { workspaceId, conversationId };
      await evaluate(app.cdp, `window.api.ensureConversation(${JSON.stringify(target)})`);
      await evaluate(app.cdp, `window.api.sendMessage(${JSON.stringify(`WSL_STRESS_${i}: use the write tool to create the requested file now.`)}, ${JSON.stringify(target)})`);
      const filePath = path.join(workspace, `wsl-stress-${i}.txt`);
      const content = await waitForFile(filePath, `conversation ${i}`);
      if (content !== `WSL_STRESS_TOOL_OK_${i}`) fail(`conversation ${i} tool content mismatch: ${content}`);
      await waitForMessage(app.cdp, target, `WSL_STRESS_AGENT_OK_${i}`, `conversation ${i} completion`);
      const others = markers.filter(marker => marker !== `WSL_STRESS_AGENT_OK_${i}`);
      await assertIsolation(app.cdp, target, `WSL_STRESS_AGENT_OK_${i}`, others, `conversation ${i}`);
      fs.rmSync(filePath, { force: true });
    }

    // 压力 B：同一对话连续多轮 send（序号 N+1..N+M）。
    const repeatTarget = { workspaceId, conversationId: 'wsl-stress-repeat' };
    await evaluate(app.cdp, `window.api.ensureConversation(${JSON.stringify(repeatTarget)})`);
    for (let j = 1; j <= M; j++) {
      const seq = N + j;
      await evaluate(app.cdp, `window.api.sendMessage(${JSON.stringify(`WSL_STRESS_${seq}: use the write tool to create the requested file now.`)}, ${JSON.stringify(repeatTarget)})`);
      const filePath = path.join(workspace, `wsl-stress-${seq}.txt`);
      const content = await waitForFile(filePath, `repeat ${j}`);
      if (content !== `WSL_STRESS_TOOL_OK_${seq}`) fail(`repeat ${j} tool content mismatch: ${content}`);
      await waitForMessage(app.cdp, repeatTarget, `WSL_STRESS_AGENT_OK_${seq}`, `repeat ${j} completion`);
      fs.rmSync(filePath, { force: true });
    }

    const expectedRounds = N + M;
    const stats = await getJson(`http://127.0.0.1:${mockPort}/stats`);
    const proof = stats.proof || {};
    if (proof.requests !== expectedRounds * 2 || proof.toolCallIssued !== expectedRounds || proof.toolResultSeen !== expectedRounds) {
      fail(`mock stats mismatch: ${JSON.stringify(proof)} expected ${expectedRounds * 2}/${expectedRounds}/${expectedRounds}`);
    }

    console.log(JSON.stringify({ ok: true, version: require(path.join(repoRoot, 'DESKTOP', 'package.json')).version, conversations: N, repeats: M, rounds: expectedRounds, requests: proof.requests, toolCalls: proof.toolCallIssued, toolResults: proof.toolResultSeen }));
  } finally {
    try { app?.cdp.ws.close(); } catch {}
    try { app?.child.kill(); } catch {}
    stopSmokeProcesses();
    api.kill();
    await sleep(750);
    try { await removeTreeWithRetry(root); } catch (error) { console.warn(`[release-win-wsl-backend-stress] cleanup root warning: ${error.message}`); }
    try { await removeTreeWithRetry(workspace); } catch (error) { console.warn(`[release-win-wsl-backend-stress] cleanup workspace warning: ${error.message}`); }
  }
})().catch(error => {
  console.error(error.stack || error);
  stopSmokeProcesses();
  process.exit(1);
});
