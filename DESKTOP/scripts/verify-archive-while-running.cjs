'use strict';

/**
 * dev-0.6.6 gate: archiving the conversation the user is looking at while its
 * turn is still running.
 *
 * The user-visible defect ("归档行为触发后待机时间太长") is observed on the
 * archive button/row, which stays in its archiving state until the IPC request
 * answers. Before this change the request waited for the conversation's own run
 * to settle with no bound at all, so a run whose provider stream never ends held
 * the click forever. The fix releases the occupancy instead of truncating the
 * wait: the resident runtime is hard-stopped in parallel with the kernel's
 * archive preparation, which invalidates the in-flight request and lets the run
 * really settle.
 *
 * This harness drives the real renderer (Electron + CDP) against a local
 * OpenAI-compatible mock whose slow turn never finishes, then asserts the
 * archive completes, the provider stream was actually cancelled, the archive
 * payload holds the transcript, and no later write resurrects the conversation.
 *
 * Run: node scripts/verify-archive-while-running.cjs
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const desktopRoot = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function timestamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const MARKER = 'ARCHRUN_20260917';
const SLOW_TURN = `${MARKER}_SLOW_NEVER_ENDS`;
const ARCHIVE_DEADLINE_MS = Number(process.env.NEWMARK_ARCHRUN_DEADLINE_MS || 30_000);
const RESURRECTION_WINDOW_MS = Number(process.env.NEWMARK_ARCHRUN_RESURRECTION_MS || 4_000);

function textChunk(text) {
  return { choices: [{ delta: { content: text } }] };
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index] && messages[index].role || '') !== 'user') continue;
    const content = messages[index].content;
    return String(typeof content === 'string' ? content : JSON.stringify(content || ''));
  }
  return '';
}

function startMockServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'archrun-mock-model' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (_) { /* ignore */ }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const turn = lastUserText(messages);
      const record = { at: Date.now(), stream: !!parsed.stream, lastUser: turn, closedAt: 0, closedEarly: false, chunks: 0 };
      requests.push(record);
      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: `${MARKER}_VALIDATE_OK` } }] }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      if (!turn.includes(SLOW_TURN)) {
        res.write(`data: ${JSON.stringify(textChunk(`${MARKER}_TURN_DONE`))}\n\n`);
        res.end('data: [DONE]\n\n');
        record.closedAt = Date.now();
        return;
      }
      // A turn whose provider stream never ends on its own: the only way the
      // conversation can stop running is for its occupancy to be released.
      const pump = () => {
        if (res.writableEnded || res.destroyed) return;
        record.chunks += 1;
        res.write(`data: ${JSON.stringify(textChunk(`${SLOW_TURN}_part${record.chunks} `))}\n\n`);
        setTimeout(pump, 400);
      };
      res.on('close', () => {
        record.closedAt = Date.now();
        record.closedEarly = true;
      });
      pump();
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

function writeConfig(root, mockPort) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: [{
        name: 'ArchiveRunningMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'archrun-mock-model',
          display: 'archrun-mock-model',
          evaluation: { status: 'available', latency: 0.1 }
        }]
      }],
      default_model: 'archrun-mock-model',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false
    },
    agent: { default_mode: 'chat', option_feedback: 'default' },
    general: { language: 'en' },
    workspace: {
      auto_create_timestamp_workspace: true,
      prompt_mode: 'both',
      access_permission: 'full_access',
      on_permission_violation: 'deny'
    }
  }, null, 2), 'utf8');
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.setTimeout(2000, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function discover(port, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`app exited early: ${child.exitCode}`);
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = (pages || []).find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (page) return page;
    } catch (_) { /* retry */ }
    await sleep(200);
  }
  throw new Error('Electron main UI CDP target unavailable');
}

function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  return {
    socket,
    ready,
    call(method, params = {}, timeout = 30000) {
      return new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => { pending.delete(key); reject(new Error(`${method} timeout`)); }, timeout);
        pending.set(key, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: key, method, params }));
      });
    }
  };
}

/**
 * Resolve a workspace id to its store directory through the same index the
 * application uses (`Work/Local.json` / `Work/External.json`).
 */
function resolveWorkspaceDir(root, workspaceId) {
  for (const name of ['Local.json', 'External.json']) {
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(path.join(root, 'Work', name), 'utf-8')); } catch { continue; }
    if (!Array.isArray(entries)) continue;
    const match = entries.find(item => String(item && item.id || '') === String(workspaceId || ''));
    if (match && match.path) return String(match.path);
  }
  return '';
}

/** Fallback: find any store that already owns this conversation. */
function findWorkspaceDir(root, conversationId) {
  const queue = [{ dir: root, depth: 0 }];
  const skip = new Set(['node_modules', '.git', 'dist', 'Electron', 'Memory Lab', 'skills']);
  const candidates = [];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > 5) continue;
    if (fs.existsSync(path.join(dir, 'conversations', 'state.json'))) candidates.push(dir);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  const owner = candidates.find(dir => conversationKeys(readStore(dir), conversationId).length > 0);
  return owner || '';
}

function readStore(workspaceDir) {
  const file = path.join(workspaceDir, 'conversations', 'state.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function conversationKeys(store, conversationId) {
  const keys = Object.keys((store && store.conversations) || {});
  return keys.filter(key => key === conversationId || key.endsWith(`-${conversationId}`));
}

function shardFiles(workspaceDir) {
  const dir = path.join(workspaceDir, 'conversations', 'shards');
  try { return fs.readdirSync(dir); } catch { return []; }
}

function newestArchive(workspaceDir) {
  const dir = path.join(workspaceDir, 'archive');
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith('.md')); } catch { return null; }
  if (!names.length) return null;
  const newest = names
    .map(name => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((left, right) => right.at - left.at)[0];
  const markdownPath = path.join(dir, newest.name);
  return {
    name: newest.name,
    markdownPath,
    manifestPath: `${markdownPath}.conversation.json`,
    text: fs.readFileSync(markdownPath, 'utf-8'),
    manifestExists: fs.existsSync(`${markdownPath}.conversation.json`)
  };
}

(async () => {
  const archiveRoot = path.join(desktopRoot, '..', 'archive', `${timestamp()}-archive-while-running`);
  const evidenceDir = path.join(archiveRoot, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-archive-running-'));
  const mock = await startMockServer();
  writeConfig(root, mock.port);
  const port = Number(process.env.NEWMARK_ARCHRUN_PORT || 49492);
  const child = spawn(require('electron'), [
    '.', `--remote-debugging-port=${port}`, '--allow-multiple-instances', '--no-sandbox', '--root', root
  ], { cwd: desktopRoot, stdio: 'ignore', windowsHide: true });

  const report = {
    marker: MARKER, deadlineMs: ARCHIVE_DEADLINE_MS, resurrectionWindowMs: RESURRECTION_WINDOW_MS,
    checks: [], failures: [], steps: {}, mockRequests: mock.requests
  };
  const check = (ok, message, detail) => {
    report.checks.push({ ok: !!ok, message, ...(detail === undefined ? {} : { detail }) });
    if (!ok) report.failures.push(message);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${message}${ok || detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
  };
  const writeReport = () => fs.writeFileSync(path.join(evidenceDir, 'archive-while-running.json'), JSON.stringify(report, null, 2));

  let cdp;
  const evaluate = async (expression, timeoutMs) => {
    const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs || 30000);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await evaluate(expression).catch(error => ({ __error: String(error && error.message || error) }));
      if (last) return last;
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${label} (last=${JSON.stringify(last)})`);
  };

  try {
    cdp = connect(await discover(port, child));
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await waitFor('(() => !!(window.state && window.state.currentWorkspaceId) && !!window.sendMessage)()', 45000, 'renderer ready');
    await evaluate(`window.api.createWorkspace('archrun-ws').then(() => window.refreshWorkspaceState()).then(() => true)`);
    await waitFor(`(() => !!(window.state && window.state.currentWorkspaceId))()`, 30000, 'workspace ready');
    await evaluate('window.api.setMode("chat").then(() => true)');

    const conversationId = await evaluate('String(activeConversationId())');
    report.steps.conversationId = conversationId;
    report.steps.workspace = await evaluate(`({
      name: String(state.currentWorkspace || ''),
      id: String(state.currentWorkspaceId || ''),
      conversations: currentWorkspaceConversations().map(item => String(item && item.id || 'default'))
    })`);
    check(report.steps.workspace.conversations.includes(conversationId),
      'the renderer lists the conversation that is about to be archived', report.steps.workspace.conversations);

    // Send a turn whose provider stream never ends, through the real composer.
    report.steps.send = await evaluate(`(async () => {
      const prompt = document.getElementById('prompt');
      prompt.value = ${JSON.stringify(SLOW_TURN)};
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      window.__archRunSend = window.sendMessage('guide', ${JSON.stringify(SLOW_TURN)}, { requestedMode: 'chat' });
      window.__archRunSend.catch(() => undefined);
      return { mode: String(state.mode || ''), inputMode: String(state.inputMode || '') };
    })()`);
    await waitFor(`(() => !!window.runningConversationRecord(${JSON.stringify(conversationId)}))()`, 30000, 'slow turn running');
    {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && !mock.requests.some(entry => entry.stream && entry.lastUser.includes(SLOW_TURN))) {
        await sleep(200);
      }
      if (!mock.requests.some(entry => entry.stream && entry.lastUser.includes(SLOW_TURN))) {
        throw new Error('the slow turn never reached the provider');
      }
    }
    const slowRequest = mock.requests.find(entry => entry.stream && entry.lastUser.includes(SLOW_TURN));
    check(slowRequest.chunks >= 1, 'the mock provider is streaming the running turn', { chunks: slowRequest.chunks });

    // The store exists once the running turn has been checkpointed.
    let workspaceDir = resolveWorkspaceDir(root, report.steps.workspace.id);
    if (workspaceDir && !fs.existsSync(path.join(workspaceDir, 'conversations', 'state.json'))) workspaceDir = '';
    {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !workspaceDir) {
        workspaceDir = resolveWorkspaceDir(root, report.steps.workspace.id)
          || findWorkspaceDir(root, conversationId);
        if (workspaceDir && !fs.existsSync(path.join(workspaceDir, 'conversations', 'state.json'))) workspaceDir = '';
        if (!workspaceDir) await sleep(250);
      }
    }
    report.steps.workspaceDir = workspaceDir;
    if (!workspaceDir) {
      report.steps.rootTree = (() => {
        const out = [];
        const walk = (dir, depth) => {
          if (depth > 3) return;
          let entries = [];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            out.push(`${'  '.repeat(depth)}${entry.name}${entry.isDirectory() ? '/' : ''}`);
            if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
          }
        };
        walk(root, 0);
        return out.slice(0, 120);
      })();
      throw new Error(`workspace store directory was not found under the isolated root (tree=${JSON.stringify(report.steps.rootTree)})`);
    }

    const storeBefore = readStore(workspaceDir);
    report.steps.storeBeforeKeys = conversationKeys(storeBefore, conversationId);
    report.steps.shardsBefore = shardFiles(workspaceDir).slice();
    check(conversationId ? conversationKeys(storeBefore, conversationId).length === 1 : true,
      'the running conversation is present in the store before archiving', report.steps.storeBeforeKeys);

    // Click archive while the turn is still streaming; the row clears only when
    // the IPC answers, so this timing is the user-visible standby time.
    const rowsBefore = await evaluate(`Array.from(document.querySelectorAll('#conversation-list .conv-item')).map(node => String(node.getAttribute('data-conversation-id') || ''))`);
    report.steps.rowsBefore = rowsBefore;
    check(rowsBefore.includes(conversationId), 'the conversation row is on screen before archiving', rowsBefore);
    const archiveStartedAt = Date.now();
    await evaluate(`window.archiveConv(${JSON.stringify(conversationId)}); true`);
    const cleared = await waitFor(`(() => {
      const row = Array.from(document.querySelectorAll('#conversation-list .conv-item'))
        .some(node => String(node.getAttribute('data-conversation-id') || '') === ${JSON.stringify(conversationId)});
      return row ? '' : 'cleared';
    })()`, ARCHIVE_DEADLINE_MS, 'archived row to leave the conversation list').then(() => true, error => ({ error: String(error.message || error) }));
    const archiveMs = Date.now() - archiveStartedAt;
    report.steps.archiveMs = archiveMs;
    check(cleared === true, 'the archived row leaves the conversation list while its turn was running', { archiveMs, cleared });

    // The provider stream must have been cancelled: proof the occupancy was
    // actually released rather than the wait being abandoned.
    {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !slowRequest.closedEarly) await sleep(200);
    }
    check(slowRequest.closedEarly === true, 'the running turn\'s provider stream was really cancelled', {
      chunks: slowRequest.chunks, closedAt: slowRequest.closedAt
    });

    const archive = newestArchive(workspaceDir);
    report.steps.archive = archive ? { name: archive.name, bytes: archive.text.length, manifestExists: archive.manifestExists } : null;
    report.steps.archivePreview = archive ? archive.text.slice(0, 400) : '';
    report.steps.manifestKeys = archive && archive.manifestExists
      ? Object.keys(JSON.parse(fs.readFileSync(archive.manifestPath, 'utf-8')).entry || {}).slice(0, 24)
      : [];
    check(!!archive && archive.manifestExists, 'the archive payload and manifest were written');
    check(!!archive && archive.text.includes(SLOW_TURN), 'the archive payload contains the running turn\'s user input');

    const storeAfter = readStore(workspaceDir);
    const remaining = conversationKeys(storeAfter, conversationId);
    const shardsAfter = shardFiles(workspaceDir);
    report.steps.storeAfterKeys = remaining;
    report.steps.shardsAfter = shardsAfter.slice();
    check(remaining.length === 0, 'the state index no longer lists the archived conversation', remaining);
    check(shardsAfter.length === Math.max(0, report.steps.shardsBefore.length - 1),
      'the archived conversation\'s transcript shard was removed with it',
      { before: report.steps.shardsBefore.length, after: shardsAfter.length });

    // No trailing write from the cancelled run may resurrect the entry.
    await sleep(RESURRECTION_WINDOW_MS);
    const storeSettled = readStore(workspaceDir);
    check(conversationKeys(storeSettled, conversationId).length === 0,
      'no later runtime write resurrects the archived conversation',
      conversationKeys(storeSettled, conversationId));

    // Control: an idle conversation must stay on the fast archive path. The
    // occupancy release is only awaited when there is something to settle, so
    // the destructive hard stop of a resident-but-idle runtime never becomes
    // part of the user's wait.
    const fastTurn = `${MARKER}_FAST`;
    await evaluate('window.newConversation(); true');
    const fastId = await waitFor(`(() => {
      const id = String(activeConversationId());
      return id && id !== ${JSON.stringify(conversationId)} ? id : '';
    })()`, 20000, 'a new conversation');
    report.steps.fastConversationId = fastId;
    await evaluate(`(async () => {
      const prompt = document.getElementById('prompt');
      prompt.value = ${JSON.stringify(fastTurn)};
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      await window.sendMessage('guide', ${JSON.stringify(fastTurn)}, { requestedMode: 'chat' });
      return true;
    })()`);
    await waitFor(`(() => window.runningConversationRecord(${JSON.stringify(fastId)}) ? '' : 'idle')()`, 60000, 'the control turn to finish');
    const idleArchiveStarted = Date.now();
    await evaluate(`window.archiveConv(${JSON.stringify(fastId)}); true`);
    const idleCleared = await waitFor(`(() => {
      const row = Array.from(document.querySelectorAll('#conversation-list .conv-item'))
        .some(node => String(node.getAttribute('data-conversation-id') || '') === ${JSON.stringify(fastId)});
      return row ? '' : 'cleared';
    })()`, ARCHIVE_DEADLINE_MS, 'the control row to leave the conversation list').then(() => true, error => ({ error: String(error.message || error) }));
    const idleArchiveMs = Date.now() - idleArchiveStarted;
    report.steps.idleArchive = { cleared: idleCleared, ms: idleArchiveMs };
    check(idleCleared === true && idleArchiveMs < 8_000,
      'archiving an idle conversation never pays for the runtime teardown', { idleArchiveMs, cleared: idleCleared });
    const idleArchive = newestArchive(workspaceDir);
    check(!!idleArchive && idleArchive.text.includes(fastTurn),
      'the idle conversation\'s archive keeps its transcript', { bytes: idleArchive ? idleArchive.text.length : 0 });

    report.steps.uiNotices = await evaluate(`(window.state && Array.isArray(window.state.uiNotices) ? window.state.uiNotices : []).slice(-4).map(n => ({ kind: String(n.kind || ''), text: String(n.text || '').slice(0, 120) }))`).catch(() => []);
    report.steps.rendererErrors = await evaluate('(window.__archRunErrors || [])').catch(() => []);
  } catch (error) {
    report.failures.push(String(error && error.stack ? error.stack : error));
    console.error(error && error.stack ? error.stack : error);
  } finally {
    try {
      if (cdp) {
        const shot = await cdp.call('Page.captureScreenshot', { format: 'png' }, 20000).catch(() => null);
        if (shot && shot.data) fs.writeFileSync(path.join(evidenceDir, 'archive-while-running.png'), Buffer.from(shot.data, 'base64'));
      }
    } catch (_) { /* best effort */ }
    try { child.kill(); } catch (_) { /* best effort */ }
    try { mock.server.close(); } catch (_) { /* best effort */ }
    report.passed = report.failures.length === 0;
    writeReport();
    if (process.env.NEWMARK_ARCHRUN_KEEP) {
      console.log(`[archive-while-running] isolated root kept: ${root}`);
    } else {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch (_) { /* best effort */ }
    }
    console.log(JSON.stringify({
      passed: report.passed,
      checks: report.checks.length,
      failures: report.failures,
      archiveMs: report.steps.archiveMs,
      evidence: archiveRoot
    }, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
})();
