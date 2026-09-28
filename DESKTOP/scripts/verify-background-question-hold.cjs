'use strict';

/**
 * dev-0.6.6 gate: a background conversation's question must be held and shown
 * when the user returns to it.
 *
 * Scenario (the reported defect):
 *   1. Conversation A starts a Build that ends in a `question` tool call.
 *   2. Before the question arrives the user switches to conversation B.
 *   3. A's question must NOT leak into B (existing dev-0.6.4 contract).
 *   4. When the user switches back to A the held question MUST be displayed.
 *
 * Step 4 used to fail: applyConversationSnapshot paints the transcript (which is
 * the only place that renders the option block, from `state.pendingOptions`)
 * *before* syncQueueItemsFromSnapshot runs, and that later call is what updates
 * `state.pendingOptions` for the newly activated conversation. The backend keeps
 * the question, the renderer stores it per target, but no paint happens because
 * the run is already settled and no further transcript render is scheduled.
 *
 * Run: node scripts/verify-background-question-hold.cjs
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

const MARKER = 'BGQ_SCOPE_20260916';

function sendSse(res, chunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

function toolCallChunk(id, name, args) {
  return {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
      }
    }]
  };
}

function textChunk(text) {
  return { choices: [{ delta: { content: text } }] };
}

function startMockServer(options) {
  const requests = [];
  const questionDelayMs = Math.max(0, Number(options && options.questionDelayMs) || 3000);
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'bgq-mock-model' }] }));
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
      requests.push({
        stream: !!parsed.stream,
        marker: markerFromMessages(messages),
        lastRole: String((messages[messages.length - 1] || {}).role || ''),
        messageCount: messages.length,
        model: String(parsed.model || ''),
        url: String(req.url || ''),
        lastToolText: (() => {
          for (let index = messages.length - 1; index >= 0; index -= 1) {
            if (String(messages[index].role || '') === 'tool') {
              const content = messages[index].content;
              return String(typeof content === 'string' ? content : JSON.stringify(content || '')).slice(0, 500);
            }
          }
          return '';
        })(),
        assistantToolNames: messages
          .filter(message => String(message.role || '') === 'assistant' && Array.isArray(message.tool_calls))
          .flatMap(message => message.tool_calls.map(call => String((call.function || {}).name || ''))),
        advertisedTools: (Array.isArray(parsed.tools) ? parsed.tools : []).map(tool => String((tool.function || {}).name || ''))
      });

      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'BGQ_VALIDATE_OK' } }] }));
        return;
      }

      const last = messages.length ? messages[messages.length - 1] : {};
      const lastContent = typeof last.content === 'string' ? last.content : JSON.stringify(last.content || '');
      if (last.role === 'tool') {
        if (lastContent.includes('Waiting for actual user selection')) {
          // Terminating tool result: the runner stops and the run waits for the
          // user. No further provider request is expected.
          sendSse(res, [textChunk(`${MARKER}_QUESTION_RECORDED`)]);
          return;
        }
        // The provisioning subturn returned the question schema. Call it now.
        sendSse(res, [toolCallChunk('call_bgq_question', 'question', {
          questions: [{
            header: 'Scope',
            question: `${MARKER} choose the scope`,
            options: [
              { label: `${MARKER}_ALLOW`, description: 'Approve this scope' },
              { label: `${MARKER}_DENY`, description: 'Reject this scope' }
            ]
          }]
        })]);
        return;
      }
      if (lastContent.includes('Answer:')) {
        sendSse(res, [textChunk(`${MARKER}_FINAL answered`)]);
        return;
      }
      const marker = markerFromMessages(messages);
      const emitProvision = () => sendSse(res, [toolCallChunk('call_bgq_provision', 'tool_provision', { names: ['question'] })]);
      if (marker === MARKER) {
        // Hold the first subturn until the harness has switched away from the
        // conversation that will ask the question.
        setTimeout(() => { try { emitProvision(); } catch (_) {} }, questionDelayMs);
        return;
      }
      sendSse(res, [textChunk(`${MARKER}_UNEXPECTED ${marker}`)]);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

function markerFromMessages(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role !== 'user') continue;
    const content = typeof messages[index].content === 'string'
      ? messages[index].content
      : JSON.stringify(messages[index].content || '');
    if (content.includes(MARKER)) return MARKER;
  }
  return 'BGQ_UNKNOWN';
}

function writeConfig(root, mockPort) {
  const config = {
    models: {
      providers: [{
        name: 'BackgroundQuestionHoldMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'bgq-mock-model',
          display: 'bgq-mock-model',
          evaluation: { status: 'available', latency: 0.1 }
        }]
      }],
      default_model: 'bgq-mock-model',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false
    },
    agent: { default_mode: 'build', option_feedback: 'default' },
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
  const archiveRoot = path.join(desktopRoot, '..', 'archive', `${timestamp()}-background-question-hold`);
  const evidenceDir = path.join(archiveRoot, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-background-question-hold-'));
  const mock = await startMockServer({ questionDelayMs: Number(process.env.NEWMARK_BGQ_DELAY_MS || 3500) });
  writeConfig(root, mock.port);

  const port = Number(process.env.NEWMARK_BGQ_PORT || 49472);
  const child = spawn(require('electron'), [
    '.', `--remote-debugging-port=${port}`, '--allow-multiple-instances', '--no-sandbox', '--root', root
  ], { cwd: desktopRoot, stdio: 'ignore', windowsHide: true });

  const report = {
    marker: MARKER,
    questionDelayMs: Number(process.env.NEWMARK_BGQ_DELAY_MS || 3500),
    steps: {},
    checks: [],
    failures: [],
    mockRequests: mock.requests
  };
  const check = (ok, message) => {
    report.checks.push({ ok: !!ok, message });
    if (!ok) report.failures.push(message);
  };

  let cdp;
  const evaluate = async expression => {
    const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
    await cdp.call('Runtime.evaluate', { expression: 'window.__bgqErrors = []; addEventListener("error", e => window.__bgqErrors.push(String((e.error && e.error.stack) || e.message))); true', returnByValue: true });
    if (process.env.NEWMARK_BGQ_TRACE === '1') {
      await cdp.call('Runtime.evaluate', {
        expression: `(() => {
          window.__bgqTrace = [];
          function snapshot(label) {
            return {
              label: label,
              at: Math.round(performance.now()),
              active: String(activeConversationId()),
              statePendings: (window.state.pendingOptions || []).length,
              blocks: document.querySelectorAll('#chat-area [data-option-question]').length
            };
          }
          ['renderChatMessages', 'renderPendingOptionsInChat', 'applyConversationSnapshot', 'syncQueueItemsFromSnapshot', 'setPendingOptionsForTarget', 'renderConversationHistoryFirst'].forEach(function (name) {
            const original = window[name];
            if (typeof original !== 'function') return;
            window[name] = function () {
              window.__bgqTrace.push(snapshot(name + ' <<'));
              const result = original.apply(this, arguments);
              window.__bgqTrace.push(snapshot(name + ' >>'));
              return result;
            };
          });
          return true;
        })()`,
        returnByValue: true
      });
    }

    const conversationA = await evaluate('activeConversationId()');
    report.steps.conversationA = conversationA;
    await evaluate('window.api.setMode("build")');

    // 1) Start the Build in A. The mock holds the question for several seconds.
    await evaluate(`(() => {
      const prompt = document.getElementById('prompt');
      prompt.value = ${JSON.stringify(`${MARKER} trigger question`)};
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      window.sendMessage();
      return true;
    })()`);
    await waitFor(`(() => !!window.runningConversationRecord(${JSON.stringify(conversationA)}))()`, 20000, 'conversation A running');
    report.steps.startedA = true;

    // 2) Switch to a brand-new conversation B before the question arrives.
    await evaluate('window.newConversation()');
    const conversationB = await waitFor(`(() => { const id = activeConversationId(); return id && id !== ${JSON.stringify(conversationA)} ? id : ''; })()`, 30000, 'conversation B activated');
    report.steps.conversationB = conversationB;
    report.steps.switchedAwayBeforeQuestion = !mock.requests.some(entry => entry.marker === MARKER && entry.stream);

    // 3) The question lands in A while B is focused.
    const pendingInA = await waitFor(`window.api.getState(${JSON.stringify(conversationA)}).then(s => (Array.isArray(s.pendingOptions) ? s.pendingOptions.length : 0))`, 60000, 'conversation A pending question in backend').catch(async error => {
      report.steps.debugSnapshotA = await evaluate(`window.api.getState(${JSON.stringify(conversationA)}).then(s => ({
        status: s && s.status, mode: s && s.mode,
        pendingOptions: s && s.pendingOptions,
        messages: (s && s.chatMessages || []).map(m => ({ role: m.role, mode: m.mode, content: String(m.content || '').slice(0, 200) }))
      }))`);
      report.steps.debugRenderer = await evaluate(`({
        activeConversationId: activeConversationId(),
        runningKeys: Object.keys((window.state && window.state.runningConversations) || {}),
        pendingOptionsByTarget: window.state && window.state.pendingOptionsByTarget
      })`);
      throw error;
    });
    report.steps.backendPendingOptionsForA = pendingInA;
    check(pendingInA >= 1, `backend keeps A's question (pendingOptions=${pendingInA})`);
    await sleep(1200);

    report.steps.leakIntoB = await evaluate(`(() => ({
      activeConversationId: activeConversationId(),
      blocksInChatArea: document.querySelectorAll('#chat-area [data-option-question]').length,
      blockText: Array.from(document.querySelectorAll('#chat-area [data-option-question] .option-question')).map(n => n.textContent),
      pendingOptions: (window.state.pendingOptions || []).length
    }))()`);
    check(report.steps.leakIntoB.blocksInChatArea === 0,
      `A's question does not leak into the focused conversation B (blocks=${report.steps.leakIntoB.blocksInChatArea})`);
    check(report.steps.leakIntoB.activeConversationId === conversationB,
      `still focused on conversation B (${report.steps.leakIntoB.activeConversationId})`);
    const shotB = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(evidenceDir, 'focused-B-no-leak.png'), Buffer.from(shotB.data, 'base64'));

    // 4) Return to A: the held question must be displayed.
    await evaluate(`(() => {
      const index = (window.state.conversations || []).findIndex(item => String(item.id) === ${JSON.stringify(conversationA)});
      if (index < 0) throw new Error('conversation A is not in the list');
      window.switchConversation(index);
      return true;
    })()`);
    await waitFor(`(() => String(activeConversationId()) === ${JSON.stringify(conversationA)} ? true : '')()`, 30000, 'back on conversation A');
    await sleep(2500);

    report.steps.afterReturn = await evaluate(`(() => {
      const blocks = Array.from(document.querySelectorAll('#chat-area [data-option-question]'));
      const first = blocks[0] || null;
      return {
        activeConversationId: activeConversationId(),
        blocks: blocks.length,
        questions: blocks.map(node => (node.querySelector('.option-question') || {}).textContent || ''),
        labels: first ? Array.from(first.querySelectorAll('.option-btn')).map(button => button.dataset.optionLabel) : [],
        owner: first ? {
          workspace: first.getAttribute('data-option-owner-workspace') || '',
          conversation: first.getAttribute('data-option-owner-conversation') || ''
        } : null,
        statePendings: (window.state.pendingOptions || []).length,
        storedForA: (window.state.pendingOptionsByTarget || {})[runtimeKeyFor(runtimeWorkspaceId(''), ${JSON.stringify(conversationA)})] || null,
        answerableOwner: first && typeof optionBlockOwner === 'function'
          ? { conversationId: optionBlockOwner(first).conversationId, workspaceId: optionBlockOwner(first).workspaceId }
          : null
      };
    })()`);
    const afterReturn = report.steps.afterReturn;
    check(afterReturn.blocks === 1, `exactly one held question block is displayed after returning to A (blocks=${afterReturn.blocks})`);
    check(afterReturn.questions.length === 1 && String(afterReturn.questions[0]).includes(MARKER),
      `the displayed block is A's question (${JSON.stringify(afterReturn.questions)})`);
    check(Array.isArray(afterReturn.labels) && afterReturn.labels.length === 2 && afterReturn.labels[0] === `${MARKER}_ALLOW`,
      `both answer options are rendered (${JSON.stringify(afterReturn.labels)})`);
    check(afterReturn.owner && afterReturn.owner.conversation === conversationA,
      `the block is owned by conversation A (${JSON.stringify(afterReturn.owner)})`);
    check(afterReturn.answerableOwner && afterReturn.answerableOwner.conversationId === conversationA,
      `answering resolves to conversation A (${JSON.stringify(afterReturn.answerableOwner)})`);
    check(afterReturn.statePendings === 1, `state.pendingOptions holds A's question (${afterReturn.statePendings})`);
    check(Array.isArray(afterReturn.storedForA) && afterReturn.storedForA.length === 1,
      `per-target store holds A's question (${JSON.stringify(afterReturn.storedForA && afterReturn.storedForA.length)})`);

    const shotA = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(evidenceDir, 'returned-A-held-question.png'), Buffer.from(shotA.data, 'base64'));

    // 5) The held question must still be answerable end to end.
    await evaluate(`(() => {
      const block = document.querySelector('#chat-area [data-option-question]');
      const button = block && block.querySelector('[data-option-label="${MARKER}_ALLOW"]');
      if (!button) throw new Error('answer button missing');
      button.click();
      return true;
    })()`);
    const answered = await waitFor(`window.api.getState(${JSON.stringify(conversationA)}).then(s => {
      const pending = Array.isArray(s.pendingOptions) ? s.pendingOptions.length : 0;
      const text = (s.chatMessages || []).map(m => String(m.content || '')).join('\\n');
      return pending === 0 && text.includes(${JSON.stringify(MARKER + '_FINAL')}) ? { pending, answered: true } : null;
    })`, 90000, 'answer submitted and run resumed');
    report.steps.answered = answered;
    check(answered && answered.answered === true, 'the held question can still be answered and resumes the Build');

    report.steps.rendererErrors = await evaluate('window.__bgqErrors.slice()');
    check(report.steps.rendererErrors.length === 0, `no renderer errors (${report.steps.rendererErrors.length})`);

    // 6) Deterministic reproduction of the ordering defect itself: one snapshot
    //    that carries both the transcript and the held question must leave the
    //    option block painted. The transcript is rendered before the per-target
    //    pending-option store is updated, so without the repaint the block is
    //    silently dropped whenever this is the only snapshot for the target.
    report.steps.singleSnapshot = await evaluate(`(() => {
      const target = currentConversationTarget();
      const key = runtimeKeyFor(target.workspaceId, target.conversationId);
      const holder = document.getElementById('chat-area');
      Array.prototype.forEach.call(holder.querySelectorAll('[data-option-question]'), node => node.remove());
      window.state.pendingOptions = [];
      if (!window.state.pendingOptionsByTarget) window.state.pendingOptionsByTarget = {};
      window.state.pendingOptionsByTarget[key] = [];
      window.state.renderedOptionKeys = {};
      const chatMessages = (window.state.renderedChatMessages || []).slice(0, 40);
      applyConversationSnapshot({
        workspaceId: target.workspaceId,
        conversationId: target.conversationId,
        chatMessages: chatMessages,
        pendingOptions: [{
          id: 'single-snapshot-probe',
          question: 'SNAPSHOT_HELD_QUESTION_PROBE',
          options: [{ label: 'PROBE_A', description: '' }, { label: 'PROBE_B', description: '' }]
        }]
      }, target.conversationId, {});
      const blocks = Array.from(holder.querySelectorAll('[data-option-question]'));
      const result = {
        blocks: blocks.length,
        questions: blocks.map(node => (node.querySelector('.option-question') || {}).textContent || ''),
        labels: blocks[0] ? Array.from(blocks[0].querySelectorAll('.option-btn')).map(button => button.dataset.optionLabel) : [],
        statePendings: (window.state.pendingOptions || []).length,
        storedForTarget: (window.state.pendingOptionsByTarget[key] || []).length
      };
      Array.prototype.forEach.call(holder.querySelectorAll('[data-option-question]'), node => node.remove());
      window.state.pendingOptions = [];
      window.state.pendingOptionsByTarget[key] = [];
      return result;
    })()`);
    const single = report.steps.singleSnapshot;
    check(single.blocks === 1,
      `one snapshot carrying the held question paints exactly one option block (blocks=${single.blocks})`);
    check(single.questions.length === 1 && String(single.questions[0]).includes('SNAPSHOT_HELD_QUESTION_PROBE'),
      `the painted block is the snapshot's question (${JSON.stringify(single.questions)})`);
    check(single.storedForTarget === 1, `the snapshot also stores the question per target (${single.storedForTarget})`);

    // 7) An answered question must never be resurrected by leaving and returning.
    await evaluate(`(() => {
      const index = (window.state.conversations || []).findIndex(item => String(item.id) === ${JSON.stringify(conversationB)});
      if (index >= 0) window.switchConversation(index);
      return true;
    })()`);
    await waitFor(`(() => String(activeConversationId()) === ${JSON.stringify(conversationB)} ? true : '')()`, 30000, 'back on conversation B');
    await evaluate(`(() => {
      const index = (window.state.conversations || []).findIndex(item => String(item.id) === ${JSON.stringify(conversationA)});
      if (index < 0) throw new Error('conversation A is not in the list');
      window.switchConversation(index);
      return true;
    })()`);
    await waitFor(`(() => String(activeConversationId()) === ${JSON.stringify(conversationA)} ? true : '')()`, 30000, 'back on conversation A again');
    await sleep(2500);
    report.steps.afterAnsweredRoundTrip = await evaluate(`(() => ({
      activeConversationId: activeConversationId(),
      blocks: document.querySelectorAll('#chat-area [data-option-question]').length,
      statePendings: (window.state.pendingOptions || []).length,
      resumedText: (window.state.renderedChatMessages || []).map(m => String(m.content || '')).join('\\n').includes(${JSON.stringify(MARKER + '_FINAL')})
    }))()`);
    const roundTrip = report.steps.afterAnsweredRoundTrip;
    check(roundTrip.blocks === 0, `an answered question is not resurrected after leaving and returning (blocks=${roundTrip.blocks})`);
    check(roundTrip.statePendings === 0, `no stale pending option survives the round trip (state.pendingOptions=${roundTrip.statePendings})`);
    check(roundTrip.resumedText === true, 'the resumed Build transcript is still the visible one');

    if (process.env.NEWMARK_BGQ_TRACE === '1') {
      report.steps.trace = await evaluate('window.__bgqTrace');
    }
  } catch (error) {
    report.failures.push(String((error && error.stack) || error));
  } finally {
    try { if (cdp) cdp.socket.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
  }

  report.passed = report.failures.length === 0;
  fs.writeFileSync(path.join(evidenceDir, 'verify-background-question-hold.json'), JSON.stringify(report, null, 2));
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
