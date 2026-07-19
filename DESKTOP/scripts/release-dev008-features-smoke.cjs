const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const exePath = process.env.NEWMARK_TEST_EXE
  ? path.resolve(process.env.NEWMARK_TEST_EXE)
  : path.resolve(__dirname, '..', '..', 'release', 'win-unpacked', 'Newmark Agent.exe');
const keepRoot = process.env.NEWMARK_KEEP_DEV008_FEATURES_SMOKE === '1';
const modelName = 'release-dev008-features-mock';
const userDataDir = process.env.NEWMARK_TEST_USER_DATA_DIR
  ? path.resolve(process.env.NEWMARK_TEST_USER_DATA_DIR)
  : path.join(os.tmpdir(), `NewmarkDev008Electron-${process.pid}`);

function log(message) { console.log(`[release-dev008-features-smoke] ${message}`); }
function fail(message) { throw new Error(message); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function removeTreeWithRetry(target) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code) || attempt === 79) throw error;
      await sleep(250);
    }
  }
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitForTarget(port) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(400);
  }
  fail('Timed out waiting for packaged Electron CDP target');
}

function connectCdp(target) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const callbacks = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else callbacks.resolve(message.result);
    };
    ws.onclose = event => {
      for (const callbacks of pending.values()) callbacks.reject(new Error(`CDP socket closed: ${event.code} ${event.reason || ''}`.trim()));
      pending.clear();
    };
  });
  function call(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
    });
  }
  return { ws, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 60000) {
  let result;
  try {
    result = await cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
  } catch (error) {
    throw new Error(`Runtime.evaluate failed for ${expression.slice(0, 160)}: ${error.message}`);
  }
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    fail(details.exception?.description || details.text || JSON.stringify(details));
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await evaluate(cdp, expression, 15000);
      if (lastValue) return lastValue;
    } catch (error) {
      lastValue = error.message;
    }
    await sleep(300);
  }
  fail(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue).slice(0, 1000)}`);
}

async function waitForRootRun(cdp, mock, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    const run = await evaluate(cdp, 'window.__dev008RootRun || null', 15000);
    if (run?.done) return run;
    try {
      lastState = await evaluate(cdp, `window.api.getState().then(state => ({
        status: state.status,
        peers: (state.subagents || []).map(peer => ({ name: peer.name, status: peer.status, result: peer.result })),
        chatTail: (state.chatMessages || []).slice(-4).map(message => String(message.content || ''))
      }))`, 15000);
    } catch (error) {
      lastState = { stateError: error.message };
    }
    await sleep(500);
  }
  fail(`Timed out waiting for root Agent dev-0.0.8 sequence; state=${JSON.stringify(lastState).slice(0, 3000)} tools=${JSON.stringify(mock.rootToolOrder)} requests=${mock.requests.length}`);
}

function toolResponse(name, args) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  };
}

function textResponse(text) {
  return { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
}

function lastToolResult(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && message.role === 'tool') return String(message.content || '');
  }
  return '';
}

function messageText(message) {
  return typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content || '');
}

function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') return messageText(messages[index]);
  }
  return '';
}

function peerIdentity(messages) {
  const systemText = messages
    .filter(message => message?.role === 'system')
    .map(messageText)
    .join('\n');
  const name = systemText.match(/You are subagent "([^"]+)"/i)?.[1] || '';
  const actorId = name.match(/--([0-9a-f-]{36})$/i)?.[1] || '';
  return { name, actorId, systemText };
}

function startMockProvider() {
  const requests = [];
  const rootToolOrder = [];
  const rootInboxReplies = new Set();
  const rootSequence = [
    ['tool_provision', { names: ['linked_plan', 'task', 'subagent_list', 'subagent_read', 'subagent_send'] }],
    ['linked_plan', { action: 'update', markdown: '# dev-0.0.8 packaged plan\n\n- [x] Linked Plan live refresh\n- [ ] Parallel peer aggregation', expected_revision: 0 }],
    ['task', { nature: 'alpha-review', prompt: 'DEV008_ALPHA_PEER initial work', model: modelName, mode: 'build', input_mode: 'guide' }],
    ['task', { nature: 'beta-review', prompt: 'DEV008_BETA_PEER initial work', model: modelName, mode: 'build', input_mode: 'guide' }],
    ['subagent_list', {}],
    ['subagent_read', { id: 'alpha-review' }],
    ['subagent_send', { id: 'alpha-review', message: 'DEV008_REACTIVATE_ALPHA', kind: 'directive' }],
  ];

  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      requests.push({ method: request.method, url: request.url, parsed });
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ data: [{ id: modelName }] }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const latestUser = latestUserText(messages);
      const peer = peerIdentity(messages);
      const toolText = lastToolResult(messages);
      let payload;
      if (peer.name.includes('alpha-review') && peer.actorId) {
        payload = textResponse(latestUser.includes('DEV008_REACTIVATE_ALPHA')
          ? 'DEV008_ALPHA_REACTIVATED_RESULT'
          : 'DEV008_ALPHA_INITIAL_RESULT');
      } else if (peer.name.includes('beta-review') && peer.actorId) {
        payload = textResponse('DEV008_BETA_INITIAL_RESULT');
      } else if (latestUser.includes('[Root subagent inbox id=')) {
        const inboxId = latestUser.match(/\[Root subagent inbox id=([0-9a-f-]{36})/i)?.[1] || `unknown-${rootInboxReplies.size}`;
        if (rootInboxReplies.has(inboxId)) {
          payload = textResponse('DEV008_DUPLICATE_ROOT_INBOX_REJECTED');
        } else {
          rootInboxReplies.add(inboxId);
          payload = textResponse(`DEV008_ROOT_RESULT_FEEDBACK_OK ${latestUser.includes('DEV008_ALPHA') ? 'ALPHA' : ''} ${latestUser.includes('DEV008_BETA') ? 'BETA' : ''}`.trim());
        }
      } else if (rootToolOrder.length < rootSequence.length) {
        const [name, args] = rootSequence[rootToolOrder.length];
        rootToolOrder.push(name);
        payload = toolResponse(name, args);
      } else if (toolText.includes('alpha-review') && toolText.includes('mailbox')) {
        payload = textResponse('DEV008_SUBAGENT_READ_OK');
      } else {
        payload = textResponse('DEV008_ROOT_SEQUENCE_OK');
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    port: server.address().port,
    requests,
    rootToolOrder,
    rootInboxReplies,
  })));
}

function writeConfig(root, mockPort) {
  const config = {
    models: {
      providers: [{
        name: 'ReleaseDev008Mock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'test-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: modelName,
          display: modelName,
          evaluation: { status: 'available', latency: 0.1 },
        }],
      }],
      default_model: modelName,
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      openai_api_mode: 'chat',
      auto_switch: false,
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    general: { language: 'en' },
    workspace: { prompt_mode: 'both', access_permission: 'full_access', on_permission_violation: 'deny' },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function createFileFixtures(workspacePath) {
  fs.writeFileSync(path.join(workspacePath, 'dev008-text.txt'), 'DEV008_TEXT_EDITOR_OK\n', 'utf8');
  fs.writeFileSync(path.join(workspacePath, 'dev008-script.bat'), '@echo off\r\necho DEV008_BAT_EDITOR_ONLY\r\n', 'utf8');
  fs.writeFileSync(path.join(workspacePath, 'dev008-doc.pdf'), Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'ascii'));
  fs.writeFileSync(path.join(workspacePath, 'dev008-page.html'), '<!doctype html><html><body><h1>DEV008_HTML_BROWSER_OK</h1></body></html>', 'utf8');
  // External/reveal routes are covered by the side-effect-free router suite.
  // Packaged assertions must not open Explorer or a default application.
}

function stopProcessTree(child) {
  if (!child || !Number.isInteger(child.pid)) return;
  const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (result.error && result.error.code !== 'ENOENT') log(`warning: process cleanup failed: ${result.error.message}`);
}

async function stopPackagedRun(child, cdp) {
  if (cdp) {
    try { await cdp.call('Browser.close', {}, 2000); } catch {}
  }
  const gracefulDeadline = Date.now() + 4000;
  while (child && child.exitCode === null && child.signalCode === null && Date.now() < gracefulDeadline) {
    await sleep(100);
  }
  if (child && child.exitCode === null && child.signalCode === null) stopProcessTree(child);
  await sleep(1500);
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: Windows packaged smoke only');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`Missing packaged executable: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkDev008Features-'));
  const mock = await startMockProvider();
  const port = Number(process.env.NEWMARK_DEV008_FEATURES_PORT || await freeTcpPort());
  let child;
  let cdp;
  try {
    writeConfig(root, mock.port);
    child = spawn(exePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--no-sandbox', '--root', root], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const target = await waitForTarget(port);
    cdp = connectCdp(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');
    log('packaged renderer connected');
    await waitFor(cdp, `document.readyState === 'complete' && !!window.api && !!document.querySelector('#prompt')`, 40000, 'renderer readiness');
    log('packaged renderer ready');

    const created = await evaluate(cdp, `window.api.createWorkspace('dev008-features-smoke')`, 30000);
    if (!created || created.error) fail(`Workspace creation failed: ${JSON.stringify(created)}`);
    const workspaceId = created.id || created.name || 'dev008-features-smoke';
    const selected = await evaluate(cdp, `window.api.selectWorkspace(${JSON.stringify(workspaceId)})`, 30000);
    const workspacePath = selected?.path || created.path || path.join(root, 'Work', 'dev008-features-smoke');
    const conversationTarget = {
      workspaceId: String(selected?.id || created.id || workspaceId),
      conversationId: 'default',
    };
    const rendererTarget = await evaluate(cdp, `(async () => {
      if (window.refreshWorkspaceState) await window.refreshWorkspaceState();
      if (window.selectWorkspace) await window.selectWorkspace(${JSON.stringify(conversationTarget.workspaceId)});
      return window.currentConversationTarget ? window.currentConversationTarget() : null;
    })()`, 45000);
    if (!rendererTarget || rendererTarget.workspaceId !== conversationTarget.workspaceId || rendererTarget.conversationId !== conversationTarget.conversationId) {
      fail(`Renderer did not bind the explicit workspace/conversation target: ${JSON.stringify(rendererTarget)}`);
    }
    if (!workspacePath || !path.resolve(workspacePath).startsWith(path.resolve(root))) fail(`Workspace escaped isolated root: ${workspacePath}`);
    createFileFixtures(workspacePath);
    log('workspace and fixtures ready');

    const fileRoutes = {};
    for (const name of ['dev008-text.txt', 'dev008-script.bat', 'dev008-doc.pdf', 'dev008-page.html']) {
      fileRoutes[name] = await evaluate(cdp, `window.api.openWorkspaceFile(${JSON.stringify(name)})`, 30000);
    }
    if (fileRoutes['dev008-text.txt']?.kind !== 'editor' || !fileRoutes['dev008-text.txt']?.token) fail(`Text route failed: ${JSON.stringify(fileRoutes['dev008-text.txt'])}`);
    if (fileRoutes['dev008-script.bat']?.kind !== 'editor' || !String(fileRoutes['dev008-script.bat']?.content || '').includes('DEV008_BAT_EDITOR_ONLY')) fail(`BAT route failed: ${JSON.stringify(fileRoutes['dev008-script.bat'])}`);
    if (fileRoutes['dev008-doc.pdf']?.kind !== 'browser' || fileRoutes['dev008-doc.pdf']?.mime !== 'application/pdf' || !/^http:\/\/127\.0\.0\.1:\d+\/pdf\//.test(String(fileRoutes['dev008-doc.pdf']?.url || ''))) fail(`PDF loopback route failed: ${JSON.stringify(fileRoutes['dev008-doc.pdf'])}`);
    if (fileRoutes['dev008-page.html']?.kind !== 'browser' || fileRoutes['dev008-page.html']?.mime !== 'text/html' || !String(fileRoutes['dev008-page.html']?.url || '').startsWith('newmark-preview://')) fail(`HTML route failed: ${JSON.stringify(fileRoutes['dev008-page.html'])}`);
    log(`file routing ok: ${Object.entries(fileRoutes).map(([name, result]) => `${name}=${result.kind}`).join(', ')}`);

    await evaluate(cdp, `window.api.ensureConversation(${JSON.stringify(conversationTarget)})`, 45000);
    const startedAt = Date.now();
    await evaluate(cdp, `(() => {
      window.__dev008RootRun = { done: false, value: null, error: '' };
      Promise.resolve(window.api.sendMessage('DEV008_PACKAGED_FEATURES_BEGIN', ${JSON.stringify(conversationTarget)}))
        .then(value => { window.__dev008RootRun = { done: true, value, error: '' }; })
        .catch(error => { window.__dev008RootRun = { done: true, value: null, error: String(error?.stack || error) }; });
      return true;
    })()`, 30000);
    log('root Agent sequence dispatched');
    const rootRun = await waitForRootRun(cdp, mock, 90000);
    if (rootRun.error) fail(`Root Agent run threw: ${rootRun.error}`);
    const rootResult = rootRun.value;
    const elapsedMs = Date.now() - startedAt;
    if (!rootResult || rootResult.ok === false || rootResult.error) fail(`Root Agent run failed: ${JSON.stringify(rootResult)}`);
    const expectedOrder = 'tool_provision,linked_plan,task,task,subagent_list,subagent_read,subagent_send';
    if (mock.rootToolOrder.join(',') !== expectedOrder) fail(`Unexpected root tool order: ${mock.rootToolOrder.join(',')}`);
    const taskRequestIndexes = mock.requests
      .map((entry, index) => JSON.stringify(entry.parsed || {}).includes('"task"') ? index : -1)
      .filter(index => index >= 0);
    if (taskRequestIndexes.length < 2 || elapsedMs > 180000) fail(`task did not return through the non-blocking sequence: requests=${taskRequestIndexes.length}, elapsed=${elapsedMs}`);

    await evaluate(cdp, `(async () => { window.switchRightTab('plan'); await window.refreshConversationPlan(); return true; })()`, 30000);
    const linkedPlan = await waitFor(cdp, `(() => {
      const reader = document.querySelector('#linked-plan-content');
      const revision = document.querySelector('#linked-plan-revision');
      if (!reader || !reader.innerText.includes('dev-0.0.8 packaged plan') || !reader.querySelector('h1')) return null;
      return { text: reader.innerText, revision: revision?.innerText || '', editable: reader.matches('textarea,[contenteditable="true"]') || !!reader.querySelector('textarea,[contenteditable="true"]') };
    })()`, 30000, 'live read-only Linked Plan panel');
    if (linkedPlan.editable || !String(linkedPlan.revision).match(/1/)) fail(`Linked Plan panel is not read-only/revisioned: ${JSON.stringify(linkedPlan)}`);

    const peerState = await waitFor(cdp, `window.api.getState(${JSON.stringify(conversationTarget)}).then(state => {
      const peers = Array.isArray(state.subagents) ? state.subagents : [];
      const alpha = peers.find(peer => String(peer.natureSlug || peer.name || '').includes('alpha-review'));
      const beta = peers.find(peer => String(peer.natureSlug || peer.name || '').includes('beta-review'));
      if (!alpha || !beta) return null;
      const combined = JSON.stringify(peers);
      return combined.includes('DEV008_ALPHA_REACTIVATED_RESULT') && combined.includes('DEV008_BETA_INITIAL_RESULT')
        ? { peers, chat: (state.chatMessages || []).map(message => String(message.content || '')).join('\\n') }
        : null;
    })`, 120000, 'parallel peers, mailbox reactivation, and results');
    if (!peerState.chat.includes('DEV008_ROOT_RESULT_FEEDBACK_OK')) fail(`Root result feedback was not summarized into the conversation: ${peerState.chat.slice(-2000)}`);
    if (peerState.chat.includes('DEV008_DUPLICATE_ROOT_INBOX_REJECTED')) fail('The same persisted root inbox message was delivered more than once');
    if (!mock.requests.some(entry => JSON.stringify(entry.parsed || {}).includes('DEV008_REACTIVATE_ALPHA'))) fail('Peer mailbox reactivation did not reach the mock provider');
    if (!mock.requests.some(entry => {
      const messages = Array.isArray(entry.parsed?.messages) ? entry.parsed.messages : [];
      return messages.some(message => message?.role === 'tool' && String(message.content || '').includes('createdByAgentId'));
    })) fail('subagent_read result did not reach the root model context');

    await evaluate(cdp, `window.switchRightTab('subagent')`, 30000);
    await waitFor(cdp, `(() => {
      const text = document.querySelector('#subagent-list')?.innerText || '';
      return text.includes('alpha-review') && text.includes('beta-review') ? text : '';
    })()`, 30000, 'two peer rows in Subagent panel');

    log('Linked Plan live read-only panel ok');
    log('task immediate return and at least two parallel peers ok');
    log('subagent_read, mailbox persistence/reactivation, and root feedback ok');
    log('all packaged dev-0.0.8 feature smoke checks passed');
  } finally {
    await stopPackagedRun(child, cdp);
    try { cdp?.ws.close(); } catch {}
    await new Promise(resolve => mock.server.close(resolve));
    if (keepRoot) log(`kept isolated root: ${root}`);
    else await removeTreeWithRetry(root);
    try { await removeTreeWithRetry(userDataDir); }
    catch (error) { log(`profile cleanup deferred to parent: ${error?.message || error}`); }
  }
})().catch(error => {
  console.error(`[release-dev008-features-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
