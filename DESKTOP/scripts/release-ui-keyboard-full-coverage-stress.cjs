'use strict';

/**
 * dev-0.4.0 键盘快捷键驱动的全场景 GUI 交叉压力测试。
 * 在 win-unpacked 产物上纯键盘遍历所有 GUI 命令/功能，用本地 mock provider。
 */

const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const reportPath = path.join(repoRoot, 'archive', '20260814-keyboard-full-coverage-stress.json');
const keepRoot = process.env.NEWMARK_KEEP_KEYBOARD_STRESS === '1';
const port = Number(process.env.NEWMARK_KEYBOARD_STRESS_PORT || '49390');
const rounds = Number(process.env.NEWMARK_KEYBOARD_STRESS_ROUNDS || '2');

const results = [];
let jsErrorCount = 0;

function log(m) { console.log('[keyboard-stress] ' + m); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ''; res.setEncoding('utf8'); res.on('data', c => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
async function waitForTarget(p) {
  const dead = Date.now() + 30000;
  while (Date.now() < dead) {
    try { const ts = await getJson('http://127.0.0.1:' + p + '/json/list'); const t = ts.find(x => x.webSocketDebuggerUrl && (x.type === 'page' || x.type === 'webview') && String(x.url || '').includes('index.html')); if (t) return t; } catch (e) {}
    await sleep(500);
  }
  throw new Error('Timed out waiting for Electron CDP target');
}
function connectCdp(target) {
  let nextId = 1; const pending = new Map(); const ws = new WebSocket(target.webSocketDebuggerUrl);
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej;
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (!m.id || !pending.has(m.id)) return; const cb = pending.get(m.id); pending.delete(m.id); if (m.error) cb.reject(new Error(m.error.message)); else cb.resolve(m.result); }; });
  const call = (method, params = {}, timeoutMs = 15000) => new Promise((res, rej) => { const id = nextId++; ws.send(JSON.stringify({ id, method, params })); pending.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP timeout: ' + method)); } }, timeoutMs); });
  return { ws, ready, call };
}
async function evaluateAsync(cdp, expression) {
  const r = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) { const d = r.exceptionDetails; throw new Error((d.exception && d.exception.description) || d.text || 'eval-error'); }
  return r.result ? r.result.value : undefined;
}

async function installErrorProbe(cdp) {
  await evaluateAsync(cdp, "(function(){ window.__ksErrors = []; if (!window.__ksProbe) { window.__ksProbe = true; window.addEventListener('error', function(e){ window.__ksErrors.push(String(e.message || e.error || 'unknown')); }); window.addEventListener('unhandledrejection', function(e){ window.__ksErrors.push('rej: ' + String((e.reason && e.reason.message) || e.reason || '')); }); } return true; })()");
}
async function collectErrors(cdp) {
  return evaluateAsync(cdp, "(function(){ var e = window.__ksErrors || []; window.__ksErrors = []; return e; })()");
}
async function readCommands(cdp) {
  return evaluateAsync(cdp, "(function(){ return (window.NEWMARK_GUI_COMMANDS || []).map(function(c){ return { id: c.id, category: c.category, bindings: (c.bindings || []).map(function(b){ return b.keys; }), available: (function(){ try { return !c.available || c.available() !== false; } catch(e){ return false; } })() }; }); })()");
}
async function runCommand(cdp, id) {
  const r = await evaluateAsync(cdp, "(function(){ var c = (window.NEWMARK_GUI_COMMANDS || []).find(function(x){ return x.id === " + JSON.stringify(id) + "; }); if (!c || !c.run) return 'no-run'; try { c.run(); return 'ok'; } catch(e) { return 'err:' + e.message; } })()");
  await sleep(80);
  return r;
}
async function dispatchShortcut(cdp, keys) {
  const combo = String(keys).split(', ')[0];
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  await evaluateAsync(cdp, "(function(){ try { var e = new KeyboardEvent('keydown', { key: " + JSON.stringify(key) + ", code: " + JSON.stringify('Key' + key.toUpperCase()) + ", ctrlKey: " + (parts.includes('Ctrl') || parts.includes('Mod')) + ", metaKey: " + (parts.includes('Cmd') || parts.includes('Mod')) + ", shiftKey: " + parts.includes('Shift') + ", altKey: " + parts.includes('Alt') + ", bubbles: true, cancelable: true }); document.dispatchEvent(e); return true; } catch(err) { return 'err:' + err.message; } })()");
  await sleep(60);
}
async function resetToStable(cdp) {
  await evaluateAsync(cdp, "(function(){ try { if (typeof window.closeSubWin === 'function') window.closeSubWin(); if (typeof window.closeCommandSurface === 'function') window.closeCommandSurface(); if (typeof window.switchRightTab === 'function') window.switchRightTab('file-tree'); return true; } catch(e) { return false; } })()");
  await sleep(80);
}

function startMockServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = null; try { parsed = JSON.parse(body || '{}'); } catch (e) {}
      requests.push({ method: req.method, url: req.url, body: parsed });
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'keyboard-stress-mock' }] })); return;
      }
      if (String(req.url || '').includes('/chat/completions')) {
        const stream = parsed && parsed.stream === true;
        if (stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'KEYBOARD_STRESS_MOCK_OK' } }] }) + '\n\n');
          res.write('data: [DONE]\n\n'); res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'KEYBOARD_STRESS_MOCK_OK' } }] }));
        }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

function writeConfig(root, mockPort) {
  const config = {
    models: { providers: [{ name: 'keyboard-stress', base_url: 'http://127.0.0.1:' + mockPort + '/v1', api_key: 'mock-key', protocol: 'openai', enabled: true, models: [{ name: 'keyboard-stress-mock', display: 'KeyboardStressMock', max_tokens: 8192, vision: false, thinking: false, evaluation: { status: 'available' }, capabilities: ['text_input', 'text_output', 'json_schema', 'tool_use'] }] }], default_model: 'keyboard-stress-mock', default_intelligence: 'low', agent_engine: 'builtin', auto_switch: false, fallback_on_unavailable: false, openai_api_mode: 'chat_stream' },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    context: { auto_compress: false },
    general: { language: 'en' },
    workspace: { auto_create_timestamp_workspace: true, prompt_mode: 'both', access_permission: 'full_access', on_permission_violation: 'deny' },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

(async () => {
  if (!fs.existsSync(exePath)) throw new Error('missing release exe: ' + exePath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-keyboard-stress-'));
  const mock = await startMockServer();
  writeConfig(root, mock.port);
  let child, cdp;
  try {
    child = spawn(exePath, ['--remote-debugging-port=' + port, '--user-data-dir=' + path.join(root, 'profile'), '--root=' + path.join(root, 'data')], { windowsHide: true });
    const target = await waitForTarget(port);
    cdp = connectCdp(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await sleep(800);
    await installErrorProbe(cdp);

    const commands = await readCommands(cdp);
    log('命令总数: ' + commands.length);

    // 阶段1：全局快捷键冒烟
    for (const [name, keys] of [['palette', 'Ctrl+Shift+P'], ['help', 'F1'], ['focus-next', 'F6']]) {
      await dispatchShortcut(cdp, keys);
      await resetToStable(cdp);
    }

    // 阶段2：遍历所有可用命令 run + 绑定注入
    const runResults = [];
    for (let round = 0; round < rounds; round++) {
      log('--- round ' + (round + 1) + '/' + rounds + ' ---');
      const cmds = await readCommands(cdp);
      for (const c of cmds) {
        if (!c.available) continue;
        const outcome = await runCommand(cdp, c.id);
        runResults.push({ id: c.id, outcome });
        if (outcome !== 'ok' && outcome !== 'no-run') results.push({ kind: 'run-error', id: c.id, detail: outcome });
        if (c.bindings && c.bindings.length) {
          for (const keys of c.bindings) { await dispatchShortcut(cdp, keys); }
          await resetToStable(cdp);
        }
      }
      for (let i = 0; i < 3; i++) await dispatchShortcut(cdp, 'F6');
      await resetToStable(cdp);
    }

    await sleep(500);
    const errors = await collectErrors(cdp);
    jsErrorCount = errors.length;
    if (errors.length) { log('renderer JS errors (' + errors.length + '):'); errors.slice(0, 20).forEach(e => log('  ' + e)); }

    const runErrors = results.filter(r => r.kind === 'run-error').length;
    const failCount = runErrors + errors.length;
    const summary = { suite: 'dev-0.4.0 keyboard full-coverage cross-stress', commandCount: commands.length, rounds, runCommands: runResults.length, runErrors, jsErrors: errors.length, verdict: failCount === 0 ? 'pass' : 'fail' };
    log('汇总: ' + JSON.stringify(summary));
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ summary, results, runResults, errors }, null, 2), 'utf8');
    log('report ' + reportPath);
    if (failCount > 0) process.exitCode = 1;
  } finally {
    try { if (cdp && cdp.ws) cdp.ws.close(); } catch (e) {}
    try { if (child && !child.killed) child.kill(); } catch (e) {}
    try { mock.server.close(); } catch (e) {}
    await sleep(800);
    if (!keepRoot) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} }
  }
})().catch(error => { console.error('[keyboard-stress] ' + (error.stack || error.message)); process.exit(1); });
