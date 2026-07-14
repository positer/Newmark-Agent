const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const sourceConfig = process.env.NEWMARK_REAL_CONFIG || path.join(repoRoot, '_local', 'real-ui-user-test', 'config.json');
const apiMode = process.env.NEWMARK_REAL_API_MODE || 'responses';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error(message); };

function getJson(url) {
  return new Promise((resolve, reject) => require('http').get(url, response => {
    let data = '';
    response.on('data', chunk => { data += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
  }).on('error', reject));
}

async function waitTarget(port) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(250);
  }
  fail('CDP target timeout');
}

function connect(target) {
  let sequence = 0;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    };
  });
  const call = (method, params = {}, timeoutMs = 240000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

function stopReleaseProcesses() {
  spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force"], { windowsHide: true });
}

(async () => {
  if (process.platform !== 'win32') fail('Windows packaged smoke only');
  if (!fs.existsSync(sourceConfig)) fail(`Real config missing: ${sourceConfig}`);
  if (!fs.existsSync(exePath)) fail(`Packaged executable missing: ${exePath}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkRealWsl-'));
  const config = JSON.parse(fs.readFileSync(sourceConfig, 'utf8'));
  if (!['chat', 'responses'].includes(apiMode)) fail(`Unsupported real API mode: ${apiMode}`);
  config.agent = config.agent || {};
  config.models = config.models || {};
  config.agent.run_in_wsl = { value: true };
  config.agent.wsl_distro = { value: process.env.NEWMARK_WSL_DISTRO || 'Ubuntu-24.04' };
  config.models.openai_api_mode = { value: apiMode };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2));

  const marker = `REAL_WSL_MODEL_OK_${Date.now()}`;
  const conversation = `real-wsl-${Date.now()}`;
  const port = 49416;
  let child;
  let cdp;
  try {
    stopReleaseProcesses();
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', `--user-data-dir=${path.join(root, 'electron-profile')}`, '--root', root], { stdio: 'ignore', windowsHide: true });
    cdp = connect(await waitTarget(port));
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    const state = await evaluate(cdp, `window.api.getState(${JSON.stringify(conversation)}).then(s => ({backend:s.agentBackend,model:s.model,apiMode:s.openAIApiMode,configured:s.configuredAgentBackend,restart:s.agentBackendRestartRequired}))`);
    if (!state.backend?.enabled || !state.backend?.connected || !state.backend?.pid || state.configured !== 'wsl' || state.restart) fail(`WSL backend not active: ${JSON.stringify(state)}`);
    if (state.apiMode !== apiMode) fail(`OpenAI API mode mismatch: expected=${apiMode} actual=${state.apiMode}`);

    const started = Date.now();
    const result = await evaluate(cdp, `window.api.sendMessage(${JSON.stringify(`Reply with exactly ${marker} and nothing else.`)}, ${JSON.stringify(conversation)})`);
    const elapsedMs = Date.now() - started;
    const content = (result.chatMessages || []).filter(message => message.role === 'assistant').map(message => String(message.content || '')).join('\n');
    if (!content.includes(marker)) fail(`Real model marker missing: ${content.slice(0, 500)}`);
    if (content.includes(String(config.models?.providers?.value?.[0]?.api_key || '___never___'))) fail('Provider key leaked into response');
    const persisted = await evaluate(cdp, `window.api.getState(${JSON.stringify(conversation)}).then(s => ({id:s.conversationId,model:s.model,messages:s.chatMessages,backend:s.agentBackend}))`);
    if (persisted.id !== conversation || !persisted.messages?.some(message => String(message.content || '').includes(marker))) fail('Real WSL conversation did not persist in its own id');
    console.log(`[release-real-wsl-provider-smoke] PASS apiMode=${apiMode} model=${persisted.model} linuxPid=${persisted.backend.pid} elapsedMs=${elapsedMs} marker=${marker}`);
  } finally {
    try { cdp?.ws.close(); } catch {}
    try { child?.kill(); } catch {}
    stopReleaseProcesses();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); stopReleaseProcesses(); process.exit(1); });
