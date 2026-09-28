'use strict';

/**
 * dev-0.6.6 gate: normal queue sequencing, queue blocked-state truth and
 * conversation drag landing.
 *
 * Reported defects (user report 2026-09-16):
 *   1. 正常排队的下下个被提示被前置阻断 / a normal queued row is labelled
 *      "blocked by a failed predecessor" even though the first row simply
 *      entered the running turn and the rest are waiting their turn.
 *   2. 拖动对话排序的落地没有正确落地顺序到避让出的位置 / dropping a dragged
 *      conversation row does not land in the slot the other rows opened for it.
 *
 * The harness drives the real packaged renderer (Electron + CDP) against a
 * local OpenAI-compatible mock provider. It never reimplements renderer logic.
 *
 * Run: node scripts/verify-queue-sequencing-and-drag-landing.cjs
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

const MARKER = 'QSEQ_20260916';
const SLOW_TURN = `${MARKER}_SLOW`;
const QUEUED_TURNS = [`${MARKER}_Q1`, `${MARKER}_Q2`, `${MARKER}_Q3`];

function textChunk(text) {
  return { choices: [{ delta: { content: text } }] };
}

function sendSse(res, chunks, close = true) {
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  if (close) res.end('data: [DONE]\n\n');
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
        res.end(JSON.stringify({ data: [{ id: 'qseq-mock-model' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (_) {}
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const turn = lastUserText(messages);
      const record = {
        at: Date.now(),
        stream: !!parsed.stream,
        messageCount: messages.length,
        lastUser: turn,
        model: String(parsed.model || ''),
        finishedAt: 0
      };
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
      if (turn.includes(SLOW_TURN)) {
        // A long turn: the queue is filled while it is still running.
        const total = 40;
        let index = 0;
        const pump = () => {
          if (index >= total) {
            record.finishedAt = Date.now();
            res.end('data: [DONE]\n\n');
            return;
          }
          index += 1;
          sendSse(res, [textChunk(`${SLOW_TURN}_part${index} `)], false);
          setTimeout(pump, 700);
        };
        pump();
        return;
      }
      const label = QUEUED_TURNS.find(item => turn.includes(item)) || `${MARKER}_TURN`;
      sendSse(res, [textChunk(`${label}_DONE`)]);
      record.finishedAt = Date.now();
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

function writeConfig(root, mockPort) {
  const config = {
    models: {
      providers: [{
        name: 'QueueSequenceMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'qseq-mock-model',
          display: 'qseq-mock-model',
          evaluation: { status: 'available', latency: 0.1 }
        }]
      }],
      default_model: 'qseq-mock-model',
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
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
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
    } catch (_) {}
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

(async () => {
  const archiveRoot = path.join(desktopRoot, '..', 'archive', `${timestamp()}-queue-sequencing-and-drag-landing`);
  const evidenceDir = path.join(archiveRoot, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-queue-sequence-'));
  const mock = await startMockServer();
  writeConfig(root, mock.port);

  const port = Number(process.env.NEWMARK_QSEQ_PORT || 49481);
  const child = spawn(require('electron'), [
    '.', `--remote-debugging-port=${port}`, '--allow-multiple-instances', '--no-sandbox', '--root', root
  ], { cwd: desktopRoot, stdio: 'ignore', windowsHide: true });

  const report = { marker: MARKER, steps: {}, checks: [], failures: [], mockRequests: mock.requests };
  const check = (ok, message) => {
    report.checks.push({ ok: !!ok, message });
    if (!ok) report.failures.push(message);
  };

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
    await waitFor('(() => !!(window.state && window.state.currentWorkspaceId) && !!window.sendMessage && !!window.switchConversation)()', 45000, 'renderer ready');
    await cdp.call('Runtime.evaluate', {
      expression: 'window.__qseqErrors = []; addEventListener("error", e => window.__qseqErrors.push(String((e.error && e.error.stack) || e.message))); true',
      returnByValue: true
    });

    await evaluate(`window.api.createWorkspace('qseq-workspace').then(() => window.refreshWorkspaceState()).then(() => true)`);
    await waitFor(`(() => !!(window.state && window.state.currentWorkspaceId))()`, 30000, 'workspace ready');
    report.steps.workspaceId = await evaluate('String(state.currentWorkspaceId)');
    report.steps.workspaceState = await evaluate(`({
      currentWorkspace: String(state.currentWorkspace || ''),
      currentWorkspaceId: String(state.currentWorkspaceId || ''),
      gated: window.requireWorkspace('probe')
    })`);
    await evaluate('window.api.setMode("chat").then(() => true)');
    const conversationA = await evaluate('String(activeConversationId())');
    report.steps.conversationA = conversationA;
    await evaluate(`(() => {
      window.__qseqTimeline = [];
      window.__qseqBackend = [];
      window.__qseqSampler = setInterval(() => {
        const target = currentConversationTarget();
        const key = runtimeKeyFor(target.workspaceId, target.conversationId);
        const record = window.runningConversationRecord(activeConversationId());
        window.__qseqTimeline.push({
          ms: Math.round(performance.now()),
          record: record ? { status: String(record.status || ''), provisional: !!record.provisional, runId: String(record.runId || '').slice(0, 8) } : null,
          nextQueue: (state.nextQueue || []).length,
          items: ((state.queueItemsByTarget || {})[key] || []).length,
          rows: document.querySelectorAll('#queue-list .queue-item').length,
          messages: (state.renderedChatMessages || []).length
        });
      }, 500);
      const poll = async () => {
        const target = currentConversationTarget();
        try {
          const snapshot = await window.api.getState(target);
          window.__qseqBackend.push({
            ms: Math.round(performance.now()),
            status: String(snapshot && snapshot.status || ''),
            runId: String(snapshot && snapshot.runId || '').slice(0, 8),
            followUp: ((snapshot.queued && snapshot.queued.followUp) || []).map(text => String(text).slice(-34)),
            queueItems: (snapshot.queueItems || []).map(item => ({ text: String(item.text).slice(-34), blocked: !!item.blocked, waitingReason: String(item.waitingReason || '') })),
            messages: (snapshot.chatMessages || []).length
          });
        } catch (error) {
          window.__qseqBackend.push({ ms: Math.round(performance.now()), error: String(error && error.message || error) });
        }
        window.__qseqBackendTimer = setTimeout(poll, 700);
      };
      poll();
      return true;
    })()`);

    // ---------------------------------------------------------------- defect 1
    // A long turn runs while three normal follow-ups are queued behind it.
    report.steps.slowSend = await evaluate(`(async () => {
      const prompt = document.getElementById('prompt');
      prompt.value = ${JSON.stringify(SLOW_TURN)};
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      // Fire and forget: the returned promise only settles when the whole turn
      // (and therefore the queue) has drained.
      window.__qseqSlowSend = window.sendMessage('guide', ${JSON.stringify(SLOW_TURN)}, { requestedMode: 'chat' });
      return {
        mode: String(state.mode || ''),
        inputMode: String(state.inputMode || ''),
        dispatched: true
      };
    })()`);
    report.steps.slowRunning = await waitFor(`(() => {
      const running = !!window.runningConversationRecord(${JSON.stringify(conversationA)});
      return running ? { running: true, status: String(state.conversationRuntimeStates ? JSON.stringify(state.conversationRuntimeStates) : '') } : '';
    })()`, 30000, 'slow turn running').catch(async error => {
      report.steps.slowDebug = {
        state: await evaluate(`({
          mode: String(state.mode || ''), inputMode: String(state.inputMode || ''),
          runningKeys: Object.keys(state.runningConversations || {}),
          runtimeStates: state.conversationRuntimeStates || {},
          renderedMessages: (state.renderedChatMessages || []).length,
          lastError: (window.__qseqErrors || []).slice(-3)
        })`),
        backend: await evaluate(`window.api.getState(currentConversationTarget()).then(s => ({
          status: s && s.status, mode: s && s.mode,
          messages: (s && s.chatMessages || []).map(m => ({ role: m.role, content: String(m.content || '').slice(0, 80) }))
        }))`),
        mockRequests: mock.requests.map(entry => ({ stream: entry.stream, lastUser: String(entry.lastUser).slice(0, 60) }))
      };
      throw error;
    });

    // The renderer's record is optimistic; the mock request is the proof that the
    // long turn really owns the conversation before the queue is filled.
    {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && !mock.requests.some(entry => entry.stream && entry.lastUser.includes(SLOW_TURN))) {
        await sleep(200);
      }
      if (!mock.requests.some(entry => entry.stream && entry.lastUser.includes(SLOW_TURN))) {
        throw new Error('the long turn never reached the provider');
      }
      report.steps.slowTurnAtProvider = true;
    }

    // Queue through the shared `queue_enqueue` command: this is the same
    // authoritative path the desktop row editor and the paired mobile client
    // use, and it returns the projected rows (blocked / waitingReason) the
    // queue panel paints from.
    report.steps.queueSends = [];
    const queuedTurnsToSend = process.env.NEWMARK_QSEQ_SKIP_QUEUE === '1' ? [] : QUEUED_TURNS;
    for (const text of queuedTurnsToSend) {
      const outcome = await evaluate(`window.api.queueAction('queue_enqueue', {
        id: 'qseq-' + Math.random().toString(16).slice(2),
        text: ${JSON.stringify(text)},
        requestedMode: 'chat',
        createdAt: new Date().toISOString()
      }, currentConversationTarget()).then(result => ({
        ok: !result || result.ok !== false,
        error: String((result && result.error) || ''),
        items: ((result && result.queueItems) || []).map(item => ({
          text: String(item.text).slice(-34),
          blocked: item.blocked === true,
          waitingReason: String(item.waitingReason || '')
        }))
      }))`);
      await evaluate(`window.api.getState(currentConversationTarget()).then(snapshot => {
        applyConversationCommandSnapshot(snapshot, currentConversationTarget());
        if (window.renderInputStack) window.renderInputStack();
        return true;
      })`);
      report.steps.queueSends.push({ text, ...outcome });
      await sleep(350);
    }

    report.steps.queueObservation = await evaluate(`(async () => {
      const samples = [];
      for (let index = 0; index < 6; index += 1) {
        const target = currentConversationTarget();
        const key = runtimeKeyFor(target.workspaceId, target.conversationId);
        const snapshot = await window.api.getState(target);
        samples.push({
          index,
          rows: Array.from(document.querySelectorAll('#queue-list .queue-item')).map(row => ({
            text: String((row.querySelector('.queue-edit') || {}).value || '').slice(-34),
            blocked: row.getAttribute('data-queue-blocked')
          })),
          nextQueue: (state.nextQueue || []).map(text => String(text).slice(-34)),
          items: ((state.queueItemsByTarget || {})[key] || []).map(item => ({
            text: String(item.text).slice(-34), blocked: !!item.blocked, waitingReason: String(item.waitingReason || '')
          })),
          panelDisplay: document.getElementById('queue-panel') ? document.getElementById('queue-panel').style.display : null,
          collapsed: !!state.queueCollapsed,
          backendFollowUp: ((snapshot.queued && snapshot.queued.followUp) || []).map(text => String(text).slice(-34)),
          backendItems: (snapshot.queueItems || []).map(item => ({
            text: String(item.text).slice(-34), blocked: !!item.blocked, waitingReason: String(item.waitingReason || '')
          }))
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return samples;
    })()`);

    report.steps.queuedRowsRendered = await waitFor(`(() => {
      const rows = document.querySelectorAll('#queue-list .queue-item');
      return rows.length >= ${QUEUED_TURNS.length} ? true : '';
    })()`, 20000, 'queued rows rendered').catch(() => false);
    await sleep(600);

    report.steps.queueWhileRunning = await evaluate(`(() => {
      const target = currentConversationTarget();
      const key = runtimeKeyFor(target.workspaceId, target.conversationId);
      const rows = Array.from(document.querySelectorAll('#queue-list .queue-item'));
      return {
        rows: rows.map(row => ({
          index: row.getAttribute('data-queue-index'),
          id: row.getAttribute('data-queue-id'),
          blockedFlag: row.getAttribute('data-queue-blocked'),
          title: row.getAttribute('title'),
          text: (row.querySelector('.queue-edit') || {}).value || ''
        })),
        panelHtml: (document.getElementById('queue-list') || {}).innerHTML ? true : false,
        queueItems: ((window.state.queueItemsByTarget || {})[key] || []).map(item => ({
          id: item.id, text: item.text, blocked: item.blocked, waitingReason: item.waitingReason
        }))
      };
    })()`);
    const queueWhileRunning = report.steps.queueWhileRunning;
    const blockedRows = queueWhileRunning.rows.filter(row => row.blockedFlag === '1');
    const blockedItems = queueWhileRunning.queueItems.filter(item => item.blocked || item.waitingReason);
    check(queueWhileRunning.rows.length === QUEUED_TURNS.length,
      `all queued rows are visible while the turn runs (rows=${queueWhileRunning.rows.length})`);
    check(blockedRows.length === 0,
      `a normally queued row is never labelled blocked (blockedRows=${JSON.stringify(blockedRows.map(row => row.text))})`);
    check(blockedItems.length === 0,
      `no queue item carries a dependency-failed marker (blockedItems=${JSON.stringify(blockedItems.map(item => item.waitingReason))})`);

    const backendQueueState = await evaluate(`window.api.getState(currentConversationTarget()).then(s => ({
      queueItems: (s.queueItems || []).map(item => ({ id: item.id, text: item.text, blocked: item.blocked, waitingReason: item.waitingReason })),
      followUp: (s.queued && s.queued.followUp) || []
    }))`);
    report.steps.backendQueueWhileRunning = backendQueueState;
    check(backendQueueState.queueItems.every(item => !item.blocked && !item.waitingReason),
      `backend queue projection reports no blocked rows (${JSON.stringify(backendQueueState.queueItems.map(item => item.waitingReason))})`);

    const shotQueue = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(evidenceDir, 'queue-while-running.png'), Buffer.from(shotQueue.data, 'base64'));

    // The queue must drain one row at a time, in submission order.
    await waitFor(`(() => {
      const target = currentConversationTarget();
      const key = runtimeKeyFor(target.workspaceId, target.conversationId);
      const items = (window.state.queueItemsByTarget || {})[key] || [];
      return items.length === 0 && !window.runningConversationRecord(activeConversationId());
    })()`, 180000, 'queue drained');
    const drained = mock.requests
      .filter(entry => entry.stream && QUEUED_TURNS.some(item => entry.lastUser.includes(item)))
      .map(entry => ({ at: entry.at, finishedAt: entry.finishedAt, text: QUEUED_TURNS.find(item => entry.lastUser.includes(item)) }));
    report.steps.drainedSequence = drained;
    check(drained.length === QUEUED_TURNS.length,
      `every queued turn reached the provider exactly once (${drained.length})`);
    check(drained.map(entry => entry.text).join('|') === QUEUED_TURNS.join('|'),
      `queued turns executed in submission order (${drained.map(entry => entry.text).join(',')})`);
    const slowRequest = mock.requests.find(entry => entry.stream && entry.lastUser.includes(SLOW_TURN));
    check(!!slowRequest && !!drained.length && drained[0].at >= slowRequest.finishedAt,
      `the first queued turn only started after the running turn finished (slowFinished=${slowRequest && slowRequest.finishedAt}, firstQueuedStart=${drained[0] && drained[0].at})`);

    // ---------------------------------------------------------------- defect 2
    await evaluate(`(async () => {
      const workspaceId = state.currentWorkspaceId;
      for (const id of ['alpha', 'beta', 'gamma']) {
        await window.api.ensureConversation({ workspaceId, conversationId: id });
      }
      const snapshot = await window.api.getState(currentConversationTarget());
      applyWorkspaceStateFromBackend(snapshot);
      renderConversations();
      return true;
    })()`);
    await waitFor(`(() => document.querySelectorAll('#conversation-list .conv-item').length >= 4)()`, 30000, 'conversation rows');

    report.steps.dragBefore = await evaluate(`Array.from(document.querySelectorAll('#conversation-list .conv-item')).map(row => row.getAttribute('data-conversation-id'))`);
    // The renderer only starts moving rows after the carried glass has arrived
    // (the row gets `.dragging`). Wait for that instead of a fixed delay so the
    // synthetic drag behaves exactly like a held pointer drag.
    await evaluate(`window.__qseqStartDrag = async function (rowIndex) {
      const rows = Array.from(document.querySelectorAll('#conversation-list .conv-item'));
      const from = rows[rowIndex || 0];
      const to = rows[(rowIndex || 0) + 2];
      // The renderer only starts reordering after the carried glass has landed
      // on the row (the glass animation depends on an async backdrop capture, so
      // under load the first attempt can take a while). Retry instead of
      // measuring a half-started drag.
      let dataTransfer = null;
      for (let attempt = 0; attempt < 2 && !from.classList.contains('dragging'); attempt += 1) {
        window.cancelConversationGlassFlight();
        dataTransfer = new DataTransfer();
        const startRect = from.getBoundingClientRect();
        from.dispatchEvent(new DragEvent('dragstart', {
          bubbles: true, cancelable: true, dataTransfer,
          clientX: startRect.left + 12, clientY: startRect.top + startRect.height / 2
        }));
        const deadline = performance.now() + 12000;
        while (performance.now() < deadline && !from.classList.contains('dragging')) {
          await new Promise(resolve => setTimeout(resolve, 60));
        }
      }
      return {
        from, to, dataTransfer,
        arrived: from.classList.contains('dragging'),
        floatMounted: !!document.querySelector('.conversation-selection-float'),
        diagnostics: {
          rowConnected: from.isConnected,
          rowClasses: String(from.className || ''),
          rowCount: document.querySelectorAll('#conversation-list .conv-item').length,
          activeRow: (document.querySelector('#conversation-list .conv-item.active') || {}).getAttribute
            ? document.querySelector('#conversation-list .conv-item.active').getAttribute('data-conversation-id') : '',
          flightGeneration: window.conversationGlassFlight ? conversationGlassFlight.generation : null,
          flightFloatConnected: !!(window.conversationGlassFlight && conversationGlassFlight.float && conversationGlassFlight.float.isConnected),
          flightSourceConnected: !!(window.conversationGlassFlight && conversationGlassFlight.source && conversationGlassFlight.source.isConnected),
          nativeDragRow: !!conversationNativeDrag.row,
          nativeDragArrived: !!conversationNativeDrag.arrived,
          nativeDragFloat: !!conversationNativeDrag.float
        }
      };
    };
    window.__qseqDragTo = function (session, options) {
      const targetRect = session.to.getBoundingClientRect();
      const dropY = targetRect.top + targetRect.height * 0.75;
      const dropX = targetRect.left + 12;
      session.to.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: session.dataTransfer, clientX: dropX, clientY: dropY
      }));
      if (options && options.drop) {
        session.to.dispatchEvent(new DragEvent('drop', {
          bubbles: true, cancelable: true, dataTransfer: session.dataTransfer, clientX: dropX, clientY: dropY
        }));
        session.from.dispatchEvent(new DragEvent('dragend', {
          bubbles: true, cancelable: true, dataTransfer: session.dataTransfer, clientX: dropX, clientY: dropY
        }));
      }
      return { dropX, dropY };
    };
    window.__qseqConversationOrder = function () {
      return Array.from(document.querySelectorAll('#conversation-list .conv-item'))
        .map(row => row.getAttribute('data-conversation-id'));
    };
    true`);

    report.steps.dragRun = await evaluate(`(async () => {
      const session = await window.__qseqStartDrag(0);
      if (!session.arrived) return { arrived: false, previewOrder: window.__qseqConversationOrder(), diagnostics: session.diagnostics };
      window.__qseqDragTo(session);
      await new Promise(resolve => setTimeout(resolve, 140));
      const previewOrder = window.__qseqConversationOrder();
      // An authoritative conversation-list push while the user still holds the
      // row (rename/other window/mobile): it must not rearrange the rows the
      // user is currently arranging.
      await window.api.renameConversation(session.to.getAttribute('data-conversation-id'), 'renamed during drag');
      await new Promise(resolve => setTimeout(resolve, 1200));
      const orderAfterPush = window.__qseqConversationOrder();
      window.__qseqDragTo(session, { drop: true });
      await new Promise(resolve => setTimeout(resolve, 2400));
      const persisted = await window.api.getState(currentConversationTarget());
      return {
        arrived: true,
        previewOrder,
        orderAfterPush,
        landedOrder: window.__qseqConversationOrder(),
        stateOrder: currentWorkspaceConversations().map(item => String(item.id)),
        persistedOrder: (persisted.conversations || []).map(item => String(item.id)),
        floatStillMounted: !!document.querySelector('.conversation-selection-float')
      };
    })()`, 120000);
    const dragRun = report.steps.dragRun;
    const before = report.steps.dragBefore;
    check(dragRun.arrived === true, 'the carried glass arrives and the dragged row is held before the drop');
    if (dragRun.arrived !== true) {
      report.steps.dragAborted = { previewOrder: dragRun.previewOrder, floatMounted: dragRun.floatMounted };
      throw new Error('the synthetic drag never carried the row; the drop assertions are not measurable in this run');
    }
    const expectedOrder = [before[1], before[2], before[0], ...before.slice(3)];
    check(dragRun.previewOrder.join('|') === expectedOrder.join('|'),
      `dragging row 1 past row 3 opens the slot after row 3 (preview=${dragRun.previewOrder.join(',')})`);
    check(dragRun.orderAfterPush.join('|') === expectedOrder.join('|'),
      `an authoritative list push during the drag keeps the opened slot (afterPush=${dragRun.orderAfterPush.join(',')})`);
    check(dragRun.landedOrder.join('|') === expectedOrder.join('|'),
      `the drop lands in the opened slot (landed=${dragRun.landedOrder.join(',')}, expected=${expectedOrder.join(',')})`);
    check(dragRun.stateOrder.join('|') === expectedOrder.join('|'),
      `the local conversation order keeps the dropped position (state=${dragRun.stateOrder.join(',')})`);
    check(dragRun.persistedOrder.slice(0, 4).join('|') === expectedOrder.join('|'),
      `the persisted conversation order matches the drop (persisted=${dragRun.persistedOrder.join(',')})`);
    check(dragRun.floatStillMounted === false, 'the carried glass float is released after the drop');

    const shotDrag = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(evidenceDir, 'conversation-drag-landed.png'), Buffer.from(shotDrag.data, 'base64'));

    // Negative control: restore the pre-fix behaviour (the row order always
    // follows the authoritative list) and prove the reported defect is what the
    // guard removes. Without the guard the mid-drag push collapses the opened
    // slot and the drop commits the reset order.
    report.steps.dragControl = await evaluate(`(async () => {
      const original = window.conversationRowOrderDuringDrag;
      window.conversationRowOrderDuringDrag = function (rows) { return rows; };
      try {
        const before = window.__qseqConversationOrder();
        const session = await window.__qseqStartDrag(0);
        if (!session.arrived) return { before, arrived: false, previewOrder: window.__qseqConversationOrder() };
        window.__qseqDragTo(session);
        await new Promise(resolve => setTimeout(resolve, 140));
        const previewOrder = window.__qseqConversationOrder();
        await window.api.renameConversation(session.to.getAttribute('data-conversation-id'), 'control rename during drag');
        await new Promise(resolve => setTimeout(resolve, 1200));
        const orderAfterPush = window.__qseqConversationOrder();
        window.__qseqDragTo(session, { drop: true });
        await new Promise(resolve => setTimeout(resolve, 2400));
        return {
          before,
          arrived: true,
          expectedOrder: [before[1], before[2], before[0], ...before.slice(3)],
          previewOrder,
          orderAfterPush,
          landedOrder: window.__qseqConversationOrder()
        };
      } finally {
        window.conversationRowOrderDuringDrag = original;
      }
    })()`, 120000);
    const dragControl = report.steps.dragControl;
    check(dragControl.arrived === true, 'control: the dragged row is held before the drop too');
    if (dragControl.arrived === true) {
      check(dragControl.previewOrder.join('|') === dragControl.expectedOrder.join('|'),
        `control: the drag still opens the slot before the push (preview=${dragControl.previewOrder.join(',')})`);
      check(dragControl.orderAfterPush.join('|') === dragControl.before.join('|'),
        `control: without the guard the authoritative push resets the opened slot (afterPush=${dragControl.orderAfterPush.join(',')})`);
      check(dragControl.landedOrder.join('|') !== dragControl.expectedOrder.join('|'),
        `control: without the guard the drop misses the opened slot (landed=${dragControl.landedOrder.join(',')})`);
    }

    // ---------------------------------------------------------------- defect 3
    // Transcript render cost must stay linear while rounds accumulate.
    report.steps.renderCost = await evaluate(`(() => {
      const target = currentConversationTarget();
      const samples = [];
      for (const roundCount of [40, 80, 160, 320]) {
        const messages = [];
        for (let index = 0; index < roundCount; index += 1) {
          messages.push({ role: 'user', content: 'round ' + index + ' question ' + 'x'.repeat(220) });
          messages.push({ role: 'assistant', content: 'round ' + index + ' answer ' + 'y'.repeat(320) });
        }
        const started = performance.now();
        renderChatMessages(messages, target);
        samples.push({ messages: messages.length, ms: Math.round(performance.now() - started) });
      }
      return samples;
    })()`);
    const renderCost = report.steps.renderCost;
    const lastSample = renderCost[renderCost.length - 1];
    const firstSample = renderCost[0];
    const growth = firstSample.ms > 0 ? (lastSample.ms / firstSample.ms) : 0;
    report.steps.renderCostGrowth = { firstMs: firstSample.ms, lastMs: lastSample.ms, messageGrowth: lastSample.messages / firstSample.messages, timeGrowth: growth };
    check(lastSample.ms < 4000,
      `rendering ${lastSample.messages} messages stays interactive (${lastSample.ms} ms)`);
    check(growth <= (lastSample.messages / firstSample.messages) * 2.5,
      `render cost grows about linearly with rounds (x${growth.toFixed(2)} time for x${(lastSample.messages / firstSample.messages).toFixed(1)} messages)`);

    // Round latency: a turn must not get slower just because the conversation
    // already has more rounds in it.
    report.steps.roundLatency = await evaluate(`(async () => {
      const samples = [];
      for (let index = 0; index < 12; index += 1) {
        const started = performance.now();
        await window.sendMessage('guide', 'RLT_' + index, { requestedMode: 'chat' });
        samples.push({
          index,
          ms: Math.round(performance.now() - started),
          messages: (window.state.renderedChatMessages || []).length
        });
      }
      return samples;
    })()`);
    const roundLatency = report.steps.roundLatency;
    const earlyTurns = roundLatency.slice(1, 4).map(sample => sample.ms).sort((a, b) => a - b)[1];
    const lateTurns = roundLatency.slice(-3).map(sample => sample.ms).sort((a, b) => a - b)[1];
    report.steps.roundLatencyGrowth = { earlyMedianMs: earlyTurns, lateMedianMs: lateTurns };
    check(roundLatency.length === 12 && roundLatency.every(sample => sample.ms < 30000),
      `every round completes (${roundLatency.map(sample => sample.ms).join(',')} ms)`);
    check(lateTurns <= Math.max(4000, earlyTurns * 4),
      `round latency stays bounded as rounds accumulate (early ${earlyTurns} ms → late ${lateTurns} ms)`);

    report.steps.rendererErrors = await evaluate('window.__qseqErrors.slice()');
    check(report.steps.rendererErrors.length === 0, `no renderer errors (${report.steps.rendererErrors.length})`);
    report.steps.timeline = await evaluate('window.__qseqTimeline || []');
    report.steps.backendTimeline = await evaluate('window.__qseqBackend || []');
  } catch (error) {
    report.failures.push(String((error && error.stack) || error));
  } finally {
    try { if (cdp) cdp.socket.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  report.passed = report.failures.length === 0;
  fs.writeFileSync(path.join(evidenceDir, 'verify-queue-sequencing-and-drag-landing.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    passed: report.passed,
    failures: report.failures,
    checks: report.checks.map(item => `${item.ok ? 'PASS' : 'FAIL'} ${item.message}`),
    steps: report.steps,
    evidenceDir
  }, null, 2));
  if (!report.passed) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
