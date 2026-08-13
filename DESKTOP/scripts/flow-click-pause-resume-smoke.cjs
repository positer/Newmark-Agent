'use strict';
// Real-backend smoke for the reported bug: clicking the Flow takeover bubble
// while a Flow is RUNNING pauses it (cooperative abort -> interrupted
// suspension), and clicking the paused bubble resumes it. Regression for
// dev-0.3.3 where a paused Flow kept its aborted AbortController so
// flow:resume rejected with "Flow is already running".
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const port = Number(process.env.NEWMARK_FLOW_CLICK_PAUSE_RESUME_PORT || '49391');

const flowName = 'ClickPauseResume';
const flowMarker = 'CLICK_PAUSE_RESUME_FLOW_PROMPT_20260805';
const flowReply = 'CLICK_PAUSE_RESUME_FLOW_REPLY_20260805';
const switchFlowName = 'SwitchMidRunFlow';
const switchFlowMarker = 'SWITCH_MID_RUN_FLOW_PROMPT_20260805';
const switchFlowReply = 'SWITCH_MID_RUN_FLOW_REPLY_20260805';

function log(message) {
  console.log(`[flow-click-pause-resume-smoke] ${message}`);
}
function fail(message) {
  throw new Error(message);
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function jsString(value) {
  return JSON.stringify(String(value));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitForTarget() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(400);
  }
  fail('Timed out waiting for Electron CDP target');
}

function connectCdp(target) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  function call(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
    });
  }
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
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 15000) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (result.exceptionDetails) {
    throw new Error(`Runtime.evaluate exception: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await evaluate(cdp, expression, 10000);
      if (lastValue) return lastValue;
    } catch (error) {
      lastValue = error.message;
    }
    await sleep(200);
  }
  fail(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)}`);
}

function sendSse(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

// The mock delays the first component request so the Flow stays RUNNING long
// enough to click the takeover bubble; the resumed component gets the reply.
function startMockServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const messagesText = JSON.stringify(parsed.messages || []);

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'flow-click-pause-resume-mock' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      if (messagesText.includes(flowMarker)) {
        // First send arrives while the Flow is running; hold it briefly so the
        // test can click the running bubble, then respond.
        setTimeout(() => {
          if (parsed.stream) sendSse(res, flowReply);
          else {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ choices: [{ message: { content: flowReply } }] }));
          }
        }, 1500);
        return;
      }
      if (messagesText.includes(switchFlowMarker)) {
        // Two-component Flow: each component request is held long enough for the
        // test to switch conversations mid-run.
        setTimeout(() => {
          if (parsed.stream) sendSse(res, switchFlowReply);
          else {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ choices: [{ message: { content: switchFlowReply } }] }));
          }
        }, 2500);
        return;
      }
      const reply = 'FLOW_DEFAULT_REPLY_20260805';
      if (parsed.stream) sendSse(res, reply);
      else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      }
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
        name: 'FlowClickPauseResumeMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'flow-click-pause-resume-mock',
          display: 'flow-click-pause-resume-mock',
          evaluation: { status: 'available', latency: 0.1 },
        }],
      }],
      default_model: 'flow-click-pause-resume-mock',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    general: { language: 'en' },
    workspace: {
      auto_create_timestamp_workspace: true,
      prompt_mode: 'both',
      access_permission: 'full_access',
      on_permission_violation: 'deny',
    },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function writeFlowWorkflow(root) {
  const flowDir = path.join(root, 'Flow');
  fs.mkdirSync(flowDir, { recursive: true });
  const workflow = {
    name: flowName,
    components: [
      { id: 0, type: 'dialog', mode: 'build', prompt: flowMarker },
    ],
  };
  fs.writeFileSync(path.join(flowDir, `${flowName}.Flow.json`), JSON.stringify(workflow, null, 2), 'utf8');
  const switchWorkflow = {
    name: switchFlowName,
    components: [
      { id: 0, type: 'dialog', mode: 'build', prompt: switchFlowMarker },
      { id: 1, type: 'dialog', mode: 'build', prompt: switchFlowMarker + ':step2' },
    ],
  };
  fs.writeFileSync(path.join(flowDir, `${switchFlowName}.Flow.json`), JSON.stringify(switchWorkflow, null, 2), 'utf8');
}

async function runSmoke(root) {
  const mock = await startMockServer();
  writeConfig(root, mock.port);
  writeFlowWorkflow(root);
  let child;
  let cdp;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, 'ElectronData')}`, '--allow-multiple-instances', '--no-sandbox', '--root', root], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const target = await waitForTarget();
    log(`connected target: ${target.title || '(untitled)'}`);
    cdp = connectCdp(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');

    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.api && !!window.sendMessage && !!document.querySelector('#prompt'))()`, 30000, 'renderer ready');
    const smokeWorkspace = await evaluate(cdp, `window.api.createWorkspace('flow-click-pause-resume-workspace')`, 30000);
    if (!smokeWorkspace?.id) fail(`workspace creation failed: ${JSON.stringify(smokeWorkspace)}`);
    await evaluate(cdp, `window.api.selectWorkspace(${jsString(smokeWorkspace.id)})`, 30000);
    await evaluate(cdp, `window.selectWorkspace(${jsString(smokeWorkspace.id)})`, 30000);
    await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.id === ${jsString(smokeWorkspace.id)})`, 30000, 'workspace selected');

    // Start the Flow the same way the renderer's runFlowWork does: mark the
    // conversation's Flow record running and render the running takeover, then
    // await the backend run (which the mock holds open). This mirrors exactly
    // what a user sees when a Flow takes over a conversation.
    const runPromise = evaluate(cdp, `(async () => {
      await api.setMode('flow');
      state.mode = 'flow';
      const target = currentConversationTarget();
      if (window.currentFlowTakeoverRecord) {
        const rec = window.currentFlowTakeoverRecord();
        rec.running = true;
        rec.paused = false;
        const runId = 'flow-click-pause-resume-' + Date.now();
        rec.runtimeLease = { target: target, runId: runId };
        if (window.setConversationRuntimeState) setConversationRuntimeState(target, 'running', runId, { provisional: true, flow: true });
      }
      window.renderFlowTakeover(true, ${jsString(flowName)}, { target: target });
      const r = await api.runFlow(${jsString(flowName)}, '', 0);
      // Mirror the renderer's runFlowWork handling of a pending/interrupted
      // suspension: re-render the takeover as paused.
      if (r && r.pending && window.renderFlowTakeover) {
        window.renderFlowTakeover(true, r.name || ${jsString(flowName)}, { interrupted: !!r.interrupted, message: r.error, target: target });
      }
      return { ok: r && r.ok, pending: r && r.pending, interrupted: r && r.interrupted, error: r && r.error, name: r && r.name };
    })()`, 60000);
    await sleep(700);

    // The running takeover bubble must be visible.
    await waitFor(cdp, `(() => {
      const b = document.getElementById('flow-takeover');
      return b && b.classList.contains('active') && !b.classList.contains('paused');
    })()`, 30000, 'running takeover bubble visible');
    log('running takeover bubble visible');

    // Click the whole running bubble -> cooperative pause.
    await evaluate(cdp, `(() => {
      const b = document.getElementById('flow-takeover');
      if (!b || !b.onclick) throw new Error('running bubble has no click handler');
      b.onclick({ stopPropagation: function() {} });
      return true;
    })()`, 30000);

    // The Flow must transition to a PAUSED takeover (interrupted suspension),
    // and the backend must NOT reject resume as already-running.
    await waitFor(cdp, `(() => {
      const b = document.getElementById('flow-takeover');
      return b && b.classList.contains('active') && b.classList.contains('paused');
    })()`, 30000, 'paused takeover bubble after click');
    log('clicking the running bubble paused the takeover');

    // Click the paused bubble -> resume must reach the backend and succeed.
    await evaluate(cdp, `(() => {
      const b = document.getElementById('flow-takeover');
      if (!b || !b.onclick) throw new Error('paused bubble has no click handler');
      b.onclick({ stopPropagation: function() {} });
      return true;
    })()`, 30000);
    log('resume click dispatched');

    const runResult = await runPromise;
    log(`flow run settled: ${JSON.stringify(runResult)}`);

    // The Flow completes (resume succeeded -> the resumed component gets the
    // reply and the Flow finishes).
    await waitFor(cdp, `(() => {
      const body = document.querySelector('#chat-area')?.innerText || '';
      return body.includes(${jsString(flowReply)}) && !document.getElementById('flow-takeover')?.classList.contains('active');
    })()`, 45000, 'Flow resumed, completed, and left the takeover');
    log('Flow resumed after pause and completed');

    if (mock.requests.filter(r => r.method === 'POST' && r.url === '/v1/chat/completions' && r.body.includes(flowMarker)).length < 2) {
      fail(`Flow did not make a resumed component request after pause: ${mock.requests.length}`);
    }
    log('all flow click-pause-resume checks passed');

    // A running Flow is a separate main-process lifecycle from the utility
    // runtime. Archive must cancel both boundaries, remove the takeover on the
    // first click, and never let a late Flow catch recreate a suspension.
    await evaluate(cdp, `window.newConversation()`, 30000);
    const archiveTarget = await evaluate(cdp, `currentConversationTarget()`, 30000);
    const archiveRunPromise = evaluate(cdp, `(async () => {
      await api.setMode('flow');
      state.mode = 'flow';
      const target = currentConversationTarget();
      if (window.currentFlowTakeoverRecord) {
        const rec = window.currentFlowTakeoverRecord();
        rec.running = true;
        rec.paused = false;
        rec.runtimeLease = { target: target, runId: 'flow-archive-' + Date.now() };
        if (window.setConversationRuntimeState) setConversationRuntimeState(target, 'running', rec.runtimeLease.runId, { provisional: true, flow: true });
      }
      window.renderFlowTakeover(true, ${jsString(flowName)}, { target: target });
      const r = await api.runFlow(${jsString(flowName)}, '', 0);
      return { ok: r && r.ok, pending: r && r.pending, archived: r && r.archived, error: r && r.error };
    })()`, 60000);
    await sleep(650);
    await waitFor(cdp, `(() => {
      const b = document.getElementById('flow-takeover');
      return b && b.classList.contains('active') && !b.classList.contains('paused');
    })()`, 30000, 'running takeover before archive');
    const archiveClickStartedAt = Date.now();
    const archiveUiState = await evaluate(cdp, `(() => {
      const id = activeConversationId();
      window.archiveConv(id);
      return {
        removedImmediately: !currentWorkspaceConversations().some(item => String(item && item.id || '') === String(id)),
        takeoverHiddenImmediately: !document.getElementById('flow-takeover')?.classList.contains('active')
      };
    })()`, 30000);
    if (!archiveUiState.removedImmediately || !archiveUiState.takeoverHiddenImmediately) {
      fail(`archive did not remove the running target immediately: ${JSON.stringify(archiveUiState)}`);
    }
    const archiveReceipts = await evaluate(cdp, `(async () => {
      const target = ${JSON.stringify(archiveTarget)};
      return await Promise.all([api.archive(target), api.archive(target), api.archive(target)]);
    })()`, 30000);
    const archiveElapsedMs = Date.now() - archiveClickStartedAt;
    if (!Array.isArray(archiveReceipts) || archiveReceipts.some(receipt => !receipt || receipt.ok !== true)) {
      fail(`running Flow archive returned a failure: ${JSON.stringify(archiveReceipts)}`);
    }
    if (archiveElapsedMs > 5000) fail(`running Flow archive remained blocked for ${archiveElapsedMs}ms`);
    const archiveRunResult = await archiveRunPromise;
    if (!archiveRunResult || archiveRunResult.archived !== true) {
      fail(`settling Flow was not discarded by archive: ${JSON.stringify(archiveRunResult)}`);
    }
    const archivedState = await evaluate(cdp, `window.api.getState(${JSON.stringify(archiveTarget)})`, 30000);
    if (archivedState && (archivedState.flowSuspension || archivedState.flowRunning)) {
      fail(`archived target retained Flow lifecycle state: ${JSON.stringify({ flowSuspension: archivedState.flowSuspension, flowRunning: archivedState.flowRunning })}`);
    }
    const archiveList = await evaluate(cdp, `window.api.listArchives('workspace')`, 30000);
    const archivedConversation = Array.isArray(archiveList) && archiveList.some(item => String(item && item.conversationId || '') === String(archiveTarget.conversationId || ''));
    if (!archivedConversation) fail(`running Flow archive did not produce a restorable archive: ${JSON.stringify(archiveList)}`);
    log(`running Flow archive passed: immediate-ui=${archiveElapsedMs}ms receipts=${archiveReceipts.length}`);

    // A Flow that is still RUNNING when the user switches conversations must
    // stay bound to its owning conversation: the next build component keeps
    // writing to the owning conversation, the other conversation never shows a
    // takeover, and on completion the owning conversation's running flag clears.
    const ownerConversationId = await evaluate(cdp, `window.api.getState(activeConversationId()).then(s => s.conversationId)`, 30000);
    log(`switch-flow owner conversation: ${ownerConversationId}`);
    await evaluate(cdp, `window.newConversation()`, 30000);
    const otherConversationId = await evaluate(cdp, `window.api.getState(activeConversationId()).then(s => s.conversationId)`, 30000);
    log(`switch-flow other conversation: ${otherConversationId}`);
    await evaluate(cdp, `(async () => {
      const ownerIdx = currentWorkspaceConversations().findIndex(c => c.id === ${jsString(ownerConversationId)});
      window.switchConversation(ownerIdx);
      await new Promise(resolve => setTimeout(resolve, 500));
      return activeConversationId();
    })()`, 30000);

    const switchRunPromise = evaluate(cdp, `(async () => {
      await api.setMode('flow');
      state.mode = 'flow';
      const target = currentConversationTarget();
      if (window.currentFlowTakeoverRecord) {
        const rec = window.currentFlowTakeoverRecord();
        rec.running = true;
        rec.paused = false;
        const runId = 'flow-switch-mid-run-' + Date.now();
        rec.runtimeLease = { target: target, runId: runId };
        if (window.setConversationRuntimeState) setConversationRuntimeState(target, 'running', runId, { provisional: true, flow: true });
      }
      window.renderFlowTakeover(true, ${jsString(switchFlowName)}, { target: target });
      const r = await api.runFlow(${jsString(switchFlowName)}, '', 0);
      return { ok: r && r.ok, pending: r && r.pending, interrupted: r && r.interrupted, error: r && r.error, name: r && r.name, conversationId: r && r.conversationId };
    })()`, 90000);
    await sleep(600);
    await waitFor(cdp, `(() => {
      const b = document.getElementById('flow-takeover');
      return b && b.classList.contains('active') && !b.classList.contains('paused');
    })()`, 30000, 'switch-flow running takeover visible');

    // Switch to a different conversation while the Flow is running.
    await evaluate(cdp, `(async () => {
      const otherIdx = currentWorkspaceConversations().findIndex(c => c.id === ${jsString(otherConversationId)});
      window.switchConversation(otherIdx);
      await new Promise(resolve => setTimeout(resolve, 600));
      return activeConversationId();
    })()`, 30000);
    const switchedAway = await evaluate(cdp, `(() => {
      const active = activeConversationId();
      const body = document.querySelector('#chat-area')?.innerText || '';
      return {
        activeId: active,
        switched: active !== ${jsString(ownerConversationId)},
        takeoverOnOther: document.getElementById('flow-takeover')?.classList.contains('active') === true,
        leakedOwnerReply: body.includes(${jsString(switchFlowReply)}),
      };
    })()`, 30000);
    if (switchedAway.switched !== true) fail(`mid-run switch did not leave the owning conversation: ${JSON.stringify(switchedAway)}`);
    if (switchedAway.takeoverOnOther) fail(`Flow takeover leaked into the other conversation mid-run: ${JSON.stringify(switchedAway)}`);
    if (switchedAway.leakedOwnerReply) fail(`Flow build output leaked into the other conversation mid-run: ${JSON.stringify(switchedAway)}`);
    log('mid-run switch isolation ok: takeover and build output stay on the owning conversation');

    // Wait for the Flow to complete in the background, then switch back and
    // verify the owning conversation is not stuck running.
    const switchRunResult = await switchRunPromise;
    log(`switch-flow run settled: ${JSON.stringify(switchRunResult)}`);
    if (!switchRunResult || switchRunResult.ok !== true) fail(`switch-flow did not complete normally: ${JSON.stringify(switchRunResult)}`);
    await evaluate(cdp, `(async () => {
      const ownerIdx = currentWorkspaceConversations().findIndex(c => c.id === ${jsString(ownerConversationId)});
      window.switchConversation(ownerIdx);
      await new Promise(resolve => setTimeout(resolve, 600));
      return activeConversationId();
    })()`, 30000);
    await waitFor(cdp, `(async () => {
      const s = await api.getState(${jsString(ownerConversationId)});
      const body = document.querySelector('#chat-area')?.innerText || '';
      const flowTakeoverActive = document.getElementById('flow-takeover')?.classList.contains('active') === true;
      const record = state.flowTakeovers && state.flowTakeovers[window.runtimeKeyFor(${jsString(smokeWorkspace.id)}, ${jsString(ownerConversationId)})];
      const ok = !!record && record.running !== true && !flowTakeoverActive && body.includes(${jsString(switchFlowReply)});
      if (ok) return true;
      return {
        activeId: activeConversationId(),
        backendHasReply: ((s && s.chatMessages) || []).some(function(m) { return String(m && m.content || '').includes(${jsString(switchFlowReply)}); }),
        bodyHasReply: body.includes(${jsString(switchFlowReply)}),
        recordRunning: record && record.running,
        takeoverActive: flowTakeoverActive,
        chatTail: body.slice(-600),
        backendTail: (s && s.chatMessages || []).map(function(m) { return String(m && m.content || ''); }).slice(-4),
      };
    })()`, 45000, 'owning conversation Flow completed, running flag cleared, reply visible');
    log('mid-run switch completion ok: owning conversation Flow completed and cleared its running flag');
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    try { if (child && !child.killed) child.kill(); } catch {}
    await sleep(1000);
    try { mock.server.close(); } catch {}
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkFlowClickPauseResume-'));
  try {
    await runSmoke(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(`[flow-click-pause-resume-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
