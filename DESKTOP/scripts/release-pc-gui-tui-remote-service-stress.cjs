'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const pty = require('node-pty');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const PORT = 47890;
const repoRoot = path.resolve(__dirname, '..', '..');
const installRoot = path.resolve(process.env.NEWMARK_PC_REMOTE_INSTALL_ROOT || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Newmark Agent'));
const guiExe = path.resolve(process.env.NEWMARK_PC_REMOTE_GUI_EXE || path.join(installRoot, 'Newmark Agent.exe'));
const cliExe = path.resolve(process.env.NEWMARK_PC_REMOTE_CLI_EXE || path.join(installRoot, 'Newmark.exe'));
const rounds = Math.max(1, Number(process.env.NEWMARK_PC_REMOTE_RESTART_ROUNDS || 3));
const concurrency = Math.max(1, Number(process.env.NEWMARK_PC_REMOTE_CONCURRENCY || 20));
const pressureRounds = Math.max(1, Number(process.env.NEWMARK_PC_REMOTE_PRESSURE_ROUNDS || 10));
const allowStopExisting = process.env.NEWMARK_PC_REMOTE_STOP_EXISTING === '1';
const restoreExistingGui = process.env.NEWMARK_PC_REMOTE_RESTORE_GUI !== '0';

function assert(condition, message) {
  if (!condition) throw new Error(`PC GUI/TUI remote service stress failed: ${message}`);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function scrub(value) {
  return String(value || '')
    .replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/(token|api[_-]?key|secret|password)(["'=:\s]+)[^\s,"']+/gi, '$1$2[REDACTED]');
}

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] || 0;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function request(host, pathname, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 10_000);
  return new Promise(resolve => {
    const started = performance.now();
    const req = http.request({
      host,
      port: PORT,
      path: pathname,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: timeoutMs,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode || 0, headers: res.headers, body, json, durationMs: performance.now() - started });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on('error', error => resolve({ status: 0, headers: {}, body: '', error: error.message, durationMs: performance.now() - started }));
    if (options.body !== undefined) req.end(JSON.stringify(options.body));
    else req.end();
  });
}

function mobilePath(endpoint, token, queryAuth = false) {
  if (!queryAuth) return endpoint;
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function bearer(token) { return { Authorization: `Bearer ${token}` }; }

function processInfo(pid) {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue; if($p){$p|Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine|ConvertTo-Json -Compress}`],
  { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  try { return JSON.parse(String(ps.stdout || '').trim()); } catch { return null; }
}

function listenerPids() {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-NetTCPConnection -State Listen -LocalPort ${PORT} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ','`],
  { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return String(ps.stdout || '').trim().split(',').map(Number).filter(pid => Number.isFinite(pid) && pid > 0);
}

async function waitForPortReleased(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!listenerPids().length) return;
    await sleep(200);
  }
  const remaining = listenerPids();
  if (!remaining.length) return;
  throw new Error(`port ${PORT} was not released; listeners=${remaining.join(',')}`);
}

function stopTree(pid) {
  if (!pid) return;
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20_000 });
}

function writeConfig(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    general: { close_behavior: { value: 'exit' } },
    remote: { touch_enabled: { value: true } },
    models: { providers: { value: [] }, default_model: { value: '' }, default_intelligence: { value: 'medium' } },
    agent: { default_mode: { value: 'build' }, run_in_wsl: { value: false } },
  }, null, 2));
}

async function waitForService(child, label) {
  const deadline = Date.now() + 60_000;
  let last;
  while (Date.now() < deadline) {
    assert(child.exitCode === null, `${label} exited before service became ready (exit=${child.exitCode})`);
    last = await request('127.0.0.1', '/api/state', { timeoutMs: 2_000 });
    if (last.status === 200 && last.json) return last;
    await sleep(200);
  }
  throw new Error(`${label} service did not become healthy: ${scrub(JSON.stringify(last))}`);
}

async function waitForToken(root) {
  const tokenPath = path.join(root, '.newmark-mobile-token');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const token = fs.readFileSync(tokenPath, 'utf8').trim();
      if (token) return token;
    } catch {}
    await sleep(100);
  }
  throw new Error('mobile token file was not created');
}

async function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject);
  });
}

async function waitForCdpTarget(port) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl && (item.type === 'page' || item.type === 'webview') && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timed out waiting for GUI CDP target on ${port}`);
}

function connectCdp(target) {
  const WebSocketImpl = globalThis.WebSocket || require('ws');
  let nextId = 1;
  const pending = new Map();
  const socket = new WebSocketImpl(target.webSocketDebuggerUrl);
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      const callbacks = pending.get(message.id);
      if (!callbacks) return;
      pending.delete(message.id);
      clearTimeout(callbacks.timer);
      if (message.error) callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else callbacks.resolve(message.result);
    };
  });
  function call(method, params = {}, timeoutMs = 15_000) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
  }
  return { socket, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'CDP evaluation failed');
  return result.result?.value;
}

function networkAddresses() {
  const rows = [{ label: 'loopback', host: '127.0.0.1' }, { label: 'localhost', host: 'localhost' }];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) rows.push({ label: item.address.startsWith('100.') ? 'tailscale-or-cgnat' : 'lan', host: item.address });
    }
  }
  const unique = new Map(rows.map(row => [row.host, row]));
  return [...unique.values()];
}

function conversationIds(value) {
  return (Array.isArray(value) ? value : []).map(item => String(item?.id || '')).filter(Boolean).sort();
}

function assertCoreParity(state, hello, mobile, label) {
  assert(state.platform === hello.platform, `${label}: platform mismatch state=${state.platform} hello=${hello.platform}`);
  assert(state.conversationId === hello.activeConversationId, `${label}: active conversation mismatch between state and hello`);
  assert(state.conversationId === mobile.activeConversationId, `${label}: active conversation mismatch between state and mobile state`);
  assert(state.mode === mobile.mode, `${label}: mode mismatch`);
  assert(state.model === mobile.model, `${label}: model mismatch`);
  assert(state.modelLabel === mobile.modelLabel, `${label}: model label mismatch`);
  assert(state.intelligence === mobile.intelligence, `${label}: intelligence mismatch`);
  assert(state.status === mobile.status, `${label}: status mismatch`);
  assert(JSON.stringify(conversationIds(state.conversations)) === JSON.stringify(conversationIds(mobile.conversations)), `${label}: conversation id set mismatch`);
  assert(Number(hello.conversationCount) === conversationIds(state.conversations).length, `${label}: hello conversation count mismatch`);
  assert(String(state.workspaces?.current?.id || '') === String(hello.workspace?.id || ''), `${label}: workspace id mismatch`);
  assert(String(state.workspaces?.current?.path || '') === String(hello.workspace?.path || ''), `${label}: workspace path mismatch`);
  assert(JSON.stringify(state.goal || null) === JSON.stringify(mobile.goal || null), `${label}: goal mismatch`);
  assert((state.chatMessages || []).length === (mobile.chatMessages || []).length, `${label}: chat message count mismatch`);
  const stateProviders = state.providers || [];
  const mobileProviders = mobile.providers || [];
  assert(stableHash(stateProviders) === stableHash(mobileProviders), `${label}: sanitized provider catalog mismatch`);
  const serialized = JSON.stringify({ stateProviders, mobileProviders });
  assert(!/api[_-]?key[^}]*:[^}\]]*[A-Za-z0-9]{8}/i.test(serialized), `${label}: provider response may contain credentials`);
}

async function assertAuthAndReachability(token, label) {
  const noToken = await request('127.0.0.1', '/api/mobile/hello');
  const wrongToken = await request('127.0.0.1', '/api/mobile/hello', { headers: bearer('wrong-token-for-stress') });
  const queryToken = await request('127.0.0.1', mobilePath('/api/mobile/hello', token, true));
  const bearerToken = await request('127.0.0.1', '/api/mobile/hello', { headers: bearer(token) });
  const preflight = await request('127.0.0.1', '/api/mobile/hello', { method: 'OPTIONS', headers: { Origin: 'http://pc-remote-stress.local', 'Access-Control-Request-Method': 'GET' } });
  assert(noToken.status === 401, `${label}: mobile endpoint without token returned ${noToken.status}`);
  assert(wrongToken.status === 401, `${label}: mobile endpoint with wrong token returned ${wrongToken.status}`);
  assert(queryToken.status === 200, `${label}: query token returned ${queryToken.status}`);
  assert(bearerToken.status === 200, `${label}: bearer token returned ${bearerToken.status}`);
  assert(preflight.status === 204, `${label}: OPTIONS returned ${preflight.status}`);
  assert(preflight.headers['access-control-allow-origin'] === '*', `${label}: CORS allow-origin missing`);

  const reachability = [];
  for (const address of networkAddresses()) {
    const result = await request(address.host, '/api/mobile/hello', { headers: bearer(token), timeoutMs: 5_000 });
    reachability.push({ ...address, status: result.status, durationMs: Math.round(result.durationMs), error: result.error || '' });
    assert(result.status === 200, `${label}: ${address.label} ${address.host} is not reachable (${result.status || result.error})`);
  }
  const ipv6 = await request('::1', '/api/state', { timeoutMs: 2_000 });
  return { reachability, ipv6: { status: ipv6.status, error: ipv6.error || '', expectedOptional: true } };
}

async function assertSse(token, label) {
  const unauthorized = await request('127.0.0.1', '/api/mobile/events', { timeoutMs: 3_000 });
  assert(unauthorized.status === 401, `${label}: unauthorized SSE returned ${unauthorized.status}`);
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/mobile/events', headers: bearer(token) });
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`${label}: authorized SSE did not produce retry prelude`)); }, 5_000);
    req.on('response', res => {
      assert(res.statusCode === 200, `${label}: authorized SSE returned ${res.statusCode}`);
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.includes('retry: 3000')) { clearTimeout(timer); req.destroy(); resolve(); }
      });
    });
    req.on('error', error => { if (error.code !== 'ECONNRESET') { clearTimeout(timer); reject(error); } });
    req.end();
  });
}

async function pressure(token, endpoints, label) {
  const durations = [];
  const statusCounts = new Map();
  const hashes = new Map();
  for (let round = 0; round < pressureRounds; round += 1) {
    for (let offset = 0; offset < endpoints.length; offset += concurrency) {
      const batch = endpoints.slice(offset, offset + concurrency).map(endpoint => request('127.0.0.1', endpoint.path, { headers: endpoint.mobile ? bearer(token) : {}, timeoutMs: 15_000 })
        .then(result => ({ endpoint, result })));
      for (const { endpoint, result } of await Promise.all(batch)) {
        durations.push(result.durationMs);
        statusCounts.set(result.status, (statusCounts.get(result.status) || 0) + 1);
        assert(result.status === 200, `${label}: pressure request ${endpoint.path} returned ${result.status || result.error}`);
        const hashTarget = endpoint.hash(result.json || {});
        if (!hashes.has(endpoint.name)) hashes.set(endpoint.name, new Set());
        hashes.get(endpoint.name).add(stableHash(hashTarget));
      }
    }
  }
  return {
    requests: durations.length,
    successRate: (statusCounts.get(200) || 0) / durations.length,
    p50Ms: Math.round(percentile(durations, 0.50)),
    p95Ms: Math.round(percentile(durations, 0.95)),
    maxMs: Math.round(Math.max(...durations)),
    statusCounts: Object.fromEntries(statusCounts),
    stableHashes: Object.fromEntries([...hashes].map(([name, set]) => [name, set.size])),
  };
}

function endpointSet(state, selectedTarget) {
  const ws = state.workspaces?.current;
  const conversationId = selectedTarget?.conversationId || state.conversationId;
  const query = `workspaceId=${encodeURIComponent(String(ws?.id || ''))}&conversationId=${encodeURIComponent(String(conversationId || ''))}`;
  return [
    { name: 'state', path: '/api/state', mobile: false, hash: value => ({ mode: value.mode, model: value.model, status: value.status, conversationId: value.conversationId, conversations: conversationIds(value.conversations) }) },
    { name: 'hello', path: '/api/mobile/hello', mobile: true, hash: value => value },
    { name: 'mobile-state', path: '/api/mobile/state', mobile: true, hash: value => ({ mode: value.mode, model: value.model, status: value.status, activeConversationId: value.activeConversationId, conversations: conversationIds(value.conversations) }) },
    { name: 'conversation', path: `/api/mobile/conversation?${query}`, mobile: true, hash: value => ({ conversationId: value.conversationId, totalMessages: value.totalMessages, mode: value.mode, status: value.status }) },
    { name: 'conversation-ui-state', path: `/api/mobile/conversation-ui-state?${query}`, mobile: true, hash: value => ({ mode: value.mode, status: value.status, inputMode: value.inputMode, goal: value.goal, runtime: value.runtime }) },
    { name: 'right-sidebar-state', path: `/api/mobile/right-sidebar-state?${query}`, mobile: true, hash: value => ({ conversationId: value.conversationId, workspaceId: value.workspace?.id, conversationPlan: value.conversationPlan, linkedPlan: value.linkedPlan }) },
  ];
}

async function workspaceTarget(token, state, label) {
  const ws = state.workspaces?.current;
  assert(ws?.id, `${label}: no current workspace`);
  const result = await request('127.0.0.1', `/api/mobile/workspace-conversations?workspaceId=${encodeURIComponent(ws.id)}`, { headers: bearer(token) });
  assert(result.status === 200, `${label}: workspace conversation listing returned ${result.status}`);
  let rows = Array.isArray(result.json?.conversations) ? result.json.conversations : [];
  if (!rows.length) {
    const created = await request('127.0.0.1', '/api/mobile/conversation-create', {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: { workspaceId: ws.id, title: `PC remote service stress ${label}` },
    });
    assert(created.status === 200 && created.json?.conversation?.id,
      `${label}: unable to seed isolated-root conversation; response=${scrub(JSON.stringify({ status: created.status, body: created.json || created.body }))}`);
    rows = Array.isArray(created.json?.conversations) ? created.json.conversations : [created.json.conversation];
  }
  const active = rows.find(row => String(row?.id || '') === String(state.conversationId || ''));
  const selected = active || rows[0];
  assert(selected?.id, `${label}: current workspace has no addressable conversation; stateConversation=${state.conversationId} rows=${scrub(JSON.stringify(rows))}`);
  return { workspaceId: ws.id, conversationId: String(selected.id) };
}

async function collectCore(token, label) {
  const stateResult = await request('127.0.0.1', '/api/state');
  const helloResult = await request('127.0.0.1', '/api/mobile/hello', { headers: bearer(token) });
  const mobileResult = await request('127.0.0.1', '/api/mobile/state', { headers: bearer(token) });
  assert(stateResult.status === 200 && helloResult.status === 200 && mobileResult.status === 200, `${label}: core read failed`);
  assertCoreParity(stateResult.json, helloResult.json, mobileResult.json, label);
  return { state: stateResult.json, hello: helloResult.json, mobile: mobileResult.json };
}

async function launchGui(root, cdpPort) {
  const child = spawn(guiExe, [`--remote-debugging-port=${cdpPort}`, '--allow-multiple-instances', '--disable-gpu', '--no-sandbox', '--root', root], {
    cwd: installRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    await waitForService(child, 'GUI');
    const target = await waitForCdpTarget(cdpPort);
    const cdp = connectCdp(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp, { timeoutMs: 60_000 });
    return { child, cdp, output: () => scrub(output) };
  } catch (error) {
    stopTree(child.pid);
    throw new Error(`${error.message}; GUI output=${scrub(output).slice(-2000)}`);
  }
}

async function launchTui(root) {
  const terminal = pty.spawn(cliExe, ['--TUI', '--root', root], {
    name: 'xterm-256color', cols: 110, rows: 35, cwd: installRoot,
    env: { ...process.env, TERM: 'xterm-256color' }, useConpty: true, useConptyDll: true,
  });
  let output = '';
  let exited = false;
  terminal.onData(chunk => { output += chunk; });
  const exit = new Promise(resolve => terminal.onExit(event => { exited = true; resolve(event); }));
  const child = { get exitCode() { return exited ? 0 : null; } };
  try {
    await waitForService(child, 'TUI');
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !/WORKSPACES|Type a message/i.test(output)) await sleep(100);
    assert(/WORKSPACES|Type a message/i.test(output), `TUI surface did not render; output=${scrub(output).slice(-1600)}`);
    return { terminal, exit, output: () => scrub(output), exited: () => exited };
  } catch (error) {
    try { terminal.kill(); } catch {}
    throw error;
  }
}

async function stopTui(tui) {
  if (!tui || tui.exited()) return;
  tui.terminal.write('\u0003');
  const event = await Promise.race([tui.exit, sleep(15_000).then(() => null)]);
  if (!event) { try { tui.terminal.kill(); } catch {} }
  assert(event && event.exitCode === 0, `TUI did not exit cleanly: ${JSON.stringify(event)} output=${tui.output().slice(-1200)}`);
}

function runCliState(root) {
  const result = spawnSync(cliExe, ['state', '--root', root], { cwd: installRoot, windowsHide: true, encoding: 'utf8', timeout: 60_000 });
  assert(result.status === 0, `CLI state failed: ${scrub(result.stderr || result.stdout)}`);
  return JSON.parse(String(result.stdout || '').trim());
}

async function runGuiPhase(root, cycle) {
  const gui = await launchGui(root, 49300 + ((process.pid + cycle) % 200));
  try {
    const token = await waitForToken(root);
    const auth = await assertAuthAndReachability(token, `GUI cycle ${cycle}`);
    await assertSse(token, `GUI cycle ${cycle}`);
    const core = await collectCore(token, `GUI cycle ${cycle}`);
    const ws = core.state.workspaces.current;
    const target = await workspaceTarget(token, core.state, `GUI cycle ${cycle}`);
    const renderer = await evaluate(gui.cdp, `window.api.getState(${JSON.stringify(target)})`);
    assert(renderer.mode === core.state.mode, `GUI cycle ${cycle}: renderer/server mode mismatch`);
    assert(renderer.model === core.state.model, `GUI cycle ${cycle}: renderer/server model mismatch`);
    assert(renderer.intelligence === core.state.intelligence, `GUI cycle ${cycle}: renderer/server intelligence mismatch`);
    assert(renderer.status === core.state.status, `GUI cycle ${cycle}: renderer/server status mismatch`);
    assert(String(renderer.conversationId || '') === String(target.conversationId || ''), `GUI cycle ${cycle}: renderer/target conversation mismatch`);
    const uiRemote = await request('127.0.0.1', `/api/mobile/conversation-ui-state?workspaceId=${encodeURIComponent(target.workspaceId)}&conversationId=${encodeURIComponent(target.conversationId)}`, { headers: bearer(token) });
    assert(uiRemote.status === 200, `GUI cycle ${cycle}: conversation UI state returned ${uiRemote.status}`);
    assert(uiRemote.json.mode === renderer.mode && uiRemote.json.status === renderer.status && uiRemote.json.inputMode === renderer.inputMode, `GUI cycle ${cycle}: hosted runtime UI state mismatch`);
    const endpoints = endpointSet(core.state, target);
    const expanded = Array.from({ length: concurrency }, (_, index) => endpoints[index % endpoints.length]);
    const load = await pressure(token, expanded, `GUI cycle ${cycle}`);
    return { kind: 'GUI', cycle, auth, load, listenerPids: listenerPids(), conversationId: target.conversationId, workspaceId: target.workspaceId };
  } finally {
    try { gui.cdp.socket.close(); } catch {}
    stopTree(gui.child.pid);
    await waitForPortReleased();
  }
}

async function runTuiPhase(root, cycle) {
  const tui = await launchTui(root);
  try {
    const token = await waitForToken(root);
    const auth = await assertAuthAndReachability(token, `TUI cycle ${cycle}`);
    await assertSse(token, `TUI cycle ${cycle}`);
    const core = await collectCore(token, `TUI cycle ${cycle}`);
    const cli = runCliState(root);
    assert(path.resolve(cli.root).toLowerCase() === path.resolve(root).toLowerCase(), `TUI cycle ${cycle}: CLI root mismatch`);
    assert(cli.mode === core.state.mode && cli.model === core.state.model && cli.intelligence === core.state.intelligence, `TUI cycle ${cycle}: CLI/server kernel mismatch`);
    const ws = core.state.workspaces.current;
    const target = await workspaceTarget(token, core.state, `TUI cycle ${cycle}`);
    const uiState = await request('127.0.0.1', `/api/mobile/conversation-ui-state?workspaceId=${encodeURIComponent(target.workspaceId)}&conversationId=${encodeURIComponent(target.conversationId)}`, { headers: bearer(token) });
    assert(uiState.status === 200 && uiState.json?.runtime === null && uiState.json?.flow === null,
      `TUI cycle ${cycle}: standalone UI state did not expose null runtime/flow; response=${scrub(JSON.stringify({ status: uiState.status, body: uiState.json || uiState.body }))}`);
    const mutation = await request('127.0.0.1', '/api/mobile/conversation-ui-action', { method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: { workspaceId: target.workspaceId, conversationId: target.conversationId, action: 'conversation_stop' } });
    assert(mutation.status === 409, `TUI cycle ${cycle}: GUI-only mutation did not fail closed (status=${mutation.status})`);
    const endpoints = endpointSet(core.state, target);
    const expanded = Array.from({ length: concurrency }, (_, index) => endpoints[index % endpoints.length]);
    const load = await pressure(token, expanded, `TUI cycle ${cycle}`);
    return { kind: 'TUI', cycle, auth, load, listenerPids: listenerPids(), conversationId: target.conversationId, workspaceId: target.workspaceId, guiMutationStatus: mutation.status };
  } finally {
    await stopTui(tui);
    await waitForPortReleased();
  }
}

async function inspectExisting() {
  const pids = listenerPids();
  if (!pids.length) return { existed: false, healthy: null, processes: [] };
  const processes = pids.map(processInfo);
  const health = await request('127.0.0.1', '/api/state', { timeoutMs: 10_000 });
  return { existed: true, healthy: health.status === 200, healthStatus: health.status, healthError: health.error || '', healthDurationMs: Math.round(health.durationMs), processes };
}

function restoreGui() {
  const child = spawn(guiExe, [], { cwd: installRoot, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

async function main() {
  assert(process.platform === 'win32', 'this runtime gate requires Windows');
  assert(fs.existsSync(guiExe), `missing GUI executable: ${guiExe}`);
  assert(fs.existsSync(cliExe), `missing CLI executable: ${cliExe}`);
  const existing = await inspectExisting();
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-pc-remote-service-'));
  const report = { startedAt: new Date().toISOString(), version: `dev-${require('../package.json').version}`, executables: { guiExe, cliExe }, configuration: { rounds, concurrency, pressureRounds, port: PORT }, existing, cycles: [] };
  try {
    if (existing.existed) {
      const allNewmark = existing.processes.every(item => /Newmark Agent\.exe$/i.test(String(item?.ExecutablePath || '')));
      assert(allowStopExisting && allNewmark, `port ${PORT} is occupied; set NEWMARK_PC_REMOTE_STOP_EXISTING=1 only after confirming it is safe. observation=${scrub(JSON.stringify(existing))}`);
      for (const item of existing.processes) stopTree(item.ProcessId);
      await waitForPortReleased();
    }
    for (let cycle = 1; cycle <= rounds; cycle += 1) {
      const guiRoot = path.join(tempBase, `gui-${cycle}`);
      const tuiRoot = path.join(tempBase, `tui-${cycle}`);
      writeConfig(guiRoot);
      writeConfig(tuiRoot);
      report.cycles.push(await runGuiPhase(guiRoot, cycle));
      report.cycles.push(await runTuiPhase(tuiRoot, cycle));
      console.log(`[pc-remote-service] cycle=${cycle}/${rounds} gui=true tui=true portReleased=true`);
    }
    report.finishedAt = new Date().toISOString();
    report.pass = true;
    const reportPath = path.resolve(process.env.NEWMARK_PC_REMOTE_REPORT || path.join(repoRoot, 'archive', `${new Date().toISOString().replace(/[:.]/g, '-')}-pc-gui-tui-remote-service-stress.json`));
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`PC_GUI_TUI_REMOTE_SERVICE_STRESS_PASS cycles=${rounds} requestsPerPhase=${concurrency * pressureRounds} report=${reportPath} existingHealthy=${existing.healthy}`);
  } finally {
    try { fs.rmSync(tempBase, { recursive: true, force: true }); } catch {}
    if (existing.existed && restoreExistingGui && !listenerPids().length) restoreGui();
  }
}

main().then(
  () => process.exit(0),
  error => {
    console.error(scrub(error.stack || error.message || String(error)));
    process.exit(1);
  },
);
