#!/usr/bin/env node
'use strict';

/*
 * Isolated deterministic mobile API/SSE fixture.
 *
 * It deliberately contains no provider credentials, pairing QR, local paths,
 * or user conversation data.  Android reaches host loopback via 10.0.2.2.
 */
const http = require('http');
const { URL } = require('url');

const port = Number(process.env.NEWMARK_MOBILE_MOCK_PORT || 47991);
const token = process.env.NEWMARK_MOBILE_MOCK_TOKEN || 'mobile-stress-token';
const conversationId = 'mobile-stress-conversation';
const workspaceId = 'mobile-stress-workspace';
const startedAt = new Date().toISOString();
const clients = new Set();
const metrics = {
  startedAt,
  sseConnections: 0,
  sseDisconnects: 0,
  emittedEvents: 0,
  duplicateEvents: 0,
  sends: 0,
  queueActions: 0,
  bursts: 0,
  uiStateReads: 0,
  activeBursts: 0,
  completedBursts: 0,
  localChatCalls: 0,
  localToolResults: 0,
  localToolsRequested: [],
  uiActions: [],
  pcSends: 0,
  injectedForeignEvents: 0,
  injectedStaleEvents: 0,
};
let liveState = null;
let stopRequested = false;
let goalPaused = false;
let flowRunning = false;
let flowPaused = false;
let queuePaused = true;
let queueItems = [
  { id: 'stress-next-1', text: 'first authoritative Next', queueMode: 'followUp', requestedMode: 'build', createdAt: startedAt },
  { id: 'stress-next-2', text: 'second authoritative Next', queueMode: 'followUp', requestedMode: 'plan', createdAt: startedAt },
];

const messages = Array.from({ length: 200 }, (_, index) => ({
  messageId: `fixture-message-${index + 1}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: index % 2 === 0
    ? `fixture request ${index / 2 + 1}`
    : `fixture response ${index / 2 + 1}: stable mobile history payload`,
  timestamp: new Date(Date.now() - (200 - index) * 1000).toISOString(),
  runId: index % 2 === 1 ? `fixture-run-${Math.floor(index / 2)}` : '',
}));

function event({ id, runId, type, sequence, content = '', status = '', toolCallId = '', toolName = '' }) {
  return {
    id,
    runId,
    conversationId,
    workspaceId,
    runtimeKey: `${workspaceId}::${conversationId}`,
    type,
    sequence,
    content,
    status,
    toolCallId,
    toolName,
    timestamp: new Date().toISOString(),
  };
}

function persistedRun() {
  const runId = 'fixture-completed-run';
  const base = new Date(Date.now() - 60_000).toISOString();
  return {
    runId,
    status: 'completed',
    startedAt: base,
    endedAt: new Date(Date.now() - 50_000).toISOString(),
    primaryPrompt: 'fixture persisted public work history',
    anchorMessageId: 'fixture-message-199',
    events: [
      { ...event({ id: 'fixture-start', runId, type: 'start', sequence: 0, content: 'started', status: 'running' }), timestamp: base },
      { ...event({ id: 'fixture-thought', runId, type: 'thought', sequence: 1, content: 'public progress', status: 'running' }), timestamp: base },
      { ...event({ id: 'fixture-tool', runId, type: 'tool_call', sequence: 2, toolCallId: 'tool-1', toolName: 'read', status: 'running' }), timestamp: base },
      { ...event({ id: 'fixture-tool-result', runId, type: 'tool_result', sequence: 3, toolCallId: 'tool-1', toolName: 'read', content: 'complete', status: 'running' }), timestamp: base },
      { ...event({ id: 'fixture-final', runId, type: 'final_response', sequence: 4, content: 'fixture completed output', status: 'completed' }), timestamp: base },
      { ...event({ id: 'fixture-done', runId, type: 'done', sequence: 5, content: 'done', status: 'completed' }), timestamp: base },
    ],
  };
}

function snapshot() {
  return {
    mode: 'build',
    model: 'mock-mobile-model',
    modelLabel: 'Mock / mobile stress model',
    models: ['mock-mobile-model', 'mock-mobile-long'],
    intelligence: 'medium',
    providers: [{
      id: 'mock-mobile-provider',
      name: 'Mock',
      base_url: 'http://127.0.0.1',
      api_key: '',
      has_api_key: true,
      protocol: 'openai',
      enabled: true,
      models: [
        { name: 'mock-mobile-model', display: 'mobile stress model', enabled: true },
        { name: 'mock-mobile-long', display: 'mobile long context', enabled: true },
      ],
    }],
    status: 'idle',
    activeConversationId: conversationId,
    conversations: [{ id: conversationId, title: 'Mobile stress fixture', messageCount: messages.length, active: true, updatedAt: startedAt }],
    chatMessages: messages,
    workRuns: [persistedRun()],
    workspaces: {
      internal: [{ id: workspaceId, name: 'Mobile stress fixture', path: 'fixture', isInternal: true }],
      external: [],
      current: { id: workspaceId, name: 'Mobile stress fixture', path: 'fixture', isInternal: true },
    },
  };
}

function writeJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function authorized(url) {
  return url.searchParams.get('token') === token;
}

function broadcast(work, duplicate = false) {
  const payload = `event: work\ndata: ${JSON.stringify(work)}\n\n`;
  for (const client of clients) client.write(payload);
  metrics.emittedEvents += 1;
  if (duplicate) {
    for (const client of clients) client.write(payload);
    metrics.emittedEvents += 1;
    metrics.duplicateEvents += 1;
  }
}

async function emitRun(count, duplicateEvery = 10, withFlow = true) {
  metrics.activeBursts += 1;
  const runId = `stress-run-${Date.now()}-${metrics.bursts}`;
  let sequence = 0;
  const anchorMessageId = `stress-user-${runId}`;
  const liveEvents = [];
  messages.push({ messageId: anchorMessageId, role: 'user', content: `stress request ${metrics.bursts}`, timestamp: new Date().toISOString(), runId });
  const start = event({ id: `${runId}:start`, runId, type: 'start', sequence: sequence++, content: 'fixture start', status: 'running' });
  start.anchorMessageId = anchorMessageId;
  liveEvents.push(start);
  liveState = {
    runId,
    anchorMessageId,
    events: liveEvents,
    startedAt: start.timestamp,
    status: 'running',
  };
  stopRequested = false;
  flowRunning = withFlow;
  flowPaused = false;
  broadcast(start, true);
  for (let index = 0; index < count; index += 1) {
    if (stopRequested) {
      const interrupted = event({ id: `${runId}:interrupted`, runId, type: 'interrupted', sequence: sequence++, content: 'stopped by mobile', status: 'interrupted' });
      interrupted.anchorMessageId = anchorMessageId;
      liveEvents.push(interrupted);
      liveState = { ...liveState, status: 'interrupted', endedAt: interrupted.timestamp };
      flowRunning = false;
      broadcast(interrupted);
      metrics.activeBursts -= 1;
      metrics.completedBursts += 1;
      return;
    }
    const row = event({
      id: `${runId}:text:${index}`,
      runId,
      type: 'text',
      sequence: sequence++,
      content: `fixture event ${index + 1}/${count}`,
      status: 'running',
    });
    row.anchorMessageId = anchorMessageId;
    liveEvents.push(row);
    broadcast(row, duplicateEvery > 0 && index % duplicateEvery === 0);
    // Android uiautomator hierarchy capture takes ~5s on the target emulator.
    // Keep the Build live long enough for multiple independent in-flight UI
    // observations rather than racing the terminal boundary.
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  const final = event({ id: `${runId}:final`, runId, type: 'final_response', sequence: sequence++, content: 'fixture terminal response', status: 'completed' });
  final.anchorMessageId = anchorMessageId;
  liveEvents.push(final);
  broadcast(final);
  messages.push({ messageId: `stress-assistant-${runId}`, role: 'assistant', content: 'fixture terminal response', timestamp: new Date().toISOString(), runId });
  const done = event({ id: `${runId}:done`, runId, type: 'done', sequence: sequence++, content: 'done', status: 'completed' });
  done.anchorMessageId = anchorMessageId;
  liveEvents.push(done);
  liveState = { ...liveState, status: 'completed', endedAt: done.timestamp };
  flowRunning = false;
  broadcast(done, true);
  metrics.activeBursts -= 1;
  metrics.completedBursts += 1;
}

function conversationUiSnapshot() {
  metrics.uiStateReads += 1;
  const running = liveState && liveState.status === 'running';
  return {
    goal: { objective: 'Stress Goal: preserve the authoritative remote state', paused: goalPaused, verified: false, goalRounds: 3 },
    flowSelection: { name: 'Mobile realtime stress', componentId: 1, componentType: 'dialog' },
    flow: { running: flowRunning, paused: flowPaused, name: 'Mobile realtime stress', promptText: flowRunning ? 'Flow prompt remains visible during Build streaming' : '', message: '' },
    queued: { steering: [], followUp: ['legacy fallback must not replace authoritative queue'] },
    queueItems,
    queuePaused,
    runtime: liveState ? { running, stopRequested, status: stopRequested ? 'stopping' : (running ? 'running' : liveState.status), runId: liveState.runId } : null,
    mode: 'goal',
    status: running ? 'working' : 'idle',
    inputMode: 'next',
    chatMessages: messages,
    workRuns: liveState ? [{ ...liveState }] : [persistedRun()],
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/__stress/page') {
    const body = '<!doctype html><html><head><title>Newmark local tool fixture</title></head><body><main>LOCAL_WEB_FIXTURE_CONTENT stable readable text</main></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    return res.end(body);
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const input = body ? JSON.parse(body) : {};
    const rows = Array.isArray(input.messages) ? input.messages : [];
    const toolRows = rows.filter(item => item && item.role === 'tool');
    const latestUserText = [...rows].reverse().find(item => item && item.role === 'user')?.content || '';
    metrics.localChatCalls += 1;
    metrics.localToolResults = toolRows.length;
    const requested = [];
    const call = (name, args) => {
      requested.push(name);
      return { id: `local-${metrics.localChatCalls}-${requested.length}-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
    };
    let message;
    if (String(latestUserText).includes('QUEUE_STRESS')) {
      await new Promise(resolve => setTimeout(resolve, 20_000));
      message = { role: 'assistant', content: 'QUEUE_PRIMARY_COMPLETE' };
      metrics.localToolsRequested.push(...requested);
      return writeJson(res, 200, { id: `local-chat-${metrics.localChatCalls}`, choices: [{ index: 0, message, finish_reason: 'stop' }] });
    }
    if (toolRows.length === 0) {
      message = {
        role: 'assistant',
        content: '正在执行第一阶段本地全工具验证。',
        tool_calls: [
          call('write_file', { path: 'stress/all-tools.txt', content: 'LOCAL_FILE_FIXTURE_CONTENT' }),
          call('memory_lab_update', { name: 'local-runtime-stress', tags: 'stress,runtime', content: 'LOCAL_MEMORY_FIXTURE_CONTENT' }),
          call('settings_read', {}),
          call('task_create', { action: 'create', task: 'local runtime fixture task' }),
          call('browser_use', { action: 'navigate', url: `http://10.0.2.2:${port}/__stress/page` }),
          call('web_fetch', { url: `http://10.0.2.2:${port}/__stress/page` }),
          call('web_search', { query: 'Newmark Agent runtime stress fixture' }),
        ],
      };
    } else if (toolRows.length < 14) {
      message = {
        role: 'assistant',
        content: '正在验证第一阶段副作用并执行第二阶段。',
        tool_calls: [
          call('list_dir', { path: 'stress' }),
          call('read_file', { path: 'stress/all-tools.txt' }),
          call('memory_lab_query', { query: 'stress' }),
          call('memory_lab_read', { component: 'local-runtime-stress' }),
          call('memory_lab_reindex', {}),
          call('settings_update', { json: JSON.stringify({ active: { provider_id: 'local-stress', model_name: 'local-stress-model', intelligence: 'medium' } }) }),
          call('task_read', {}),
          call('task_create', { action: 'update', index: 0, status: 'done' }),
          call('browser_use', { action: 'wait', duration_ms: 1500 }),
          call('browser_use', { action: 'extract', max_chars: 12000 }),
        ],
      };
    } else {
      message = { role: 'assistant', content: 'LOCAL_ALL_TOOLS_COMPLETE' };
    }
    metrics.localToolsRequested.push(...requested);
    return writeJson(res, 200, { id: `local-chat-${metrics.localChatCalls}`, choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] });
  }
  if (url.pathname === '/__stress/stats') return writeJson(res, 200, metrics);
  if (url.pathname === '/__stress/burst') {
    const count = Math.min(1000, Math.max(1, Number(url.searchParams.get('count') || 120)));
    metrics.bursts += 1;
    void emitRun(count).catch(error => { metrics.lastBurstError = String(error && error.message || error); metrics.activeBursts = Math.max(0, metrics.activeBursts - 1); });
    return writeJson(res, 202, { ok: true, count, accepted: true });
  }
  if (url.pathname === '/__stress/pc-send') {
    metrics.pcSends += 1;
    const text = String(url.searchParams.get('text') || `pc-originated-${metrics.pcSends}`);
    messages.push({ messageId: `pc-user-${Date.now()}`, role: 'user', content: text, timestamp: new Date().toISOString(), runId: '' });
    metrics.bursts += 1;
    const withFlow = url.searchParams.get('flow') !== '0';
    void emitRun(Math.min(1000, Math.max(4, Number(url.searchParams.get('count') || 16))), 0, withFlow)
      .catch(error => { metrics.lastBurstError = String(error && error.message || error); metrics.activeBursts = Math.max(0, metrics.activeBursts - 1); });
    return writeJson(res, 202, { ok: true, text });
  }
  if (url.pathname === '/__stress/inject-foreign') {
    metrics.injectedForeignEvents += 1;
    const foreign = {
      ...event({ id: `foreign-${Date.now()}`, runId: `foreign-run-${Date.now()}`, type: 'text', sequence: 1, content: 'FOREIGN_WORKSPACE_EVENT_MUST_NOT_RENDER', status: 'running' }),
      workspaceId: 'foreign-workspace',
      conversationId: 'foreign-conversation',
      runtimeKey: 'foreign-workspace::foreign-conversation',
    };
    broadcast(foreign);
    return writeJson(res, 202, { ok: true, event: foreign });
  }
  if (url.pathname === '/__stress/inject-stale') {
    if (!liveState || !liveState.runId) return writeJson(res, 409, { error: 'No completed run is available' });
    metrics.injectedStaleEvents += 1;
    const stale = event({
      id: `stale-${Date.now()}`,
      runId: liveState.runId,
      type: 'text',
      sequence: Math.max(0, ...liveState.events.map(item => Number(item.sequence || 0))) - 1,
      content: 'STALE_COMPLETED_RUN_EVENT_MUST_NOT_REOPEN',
      status: 'running',
    });
    stale.anchorMessageId = liveState.anchorMessageId;
    broadcast(stale);
    return writeJson(res, 202, { ok: true, event: stale });
  }
  if (url.pathname === '/api/mobile/events') {
    if (!authorized(url)) return writeJson(res, 401, { error: 'Unauthorized' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    metrics.sseConnections += 1;
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 1_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      metrics.sseDisconnects += 1;
    });
    return;
  }
  if (!authorized(url)) return writeJson(res, 401, { error: 'Unauthorized' });
  if (url.pathname === '/api/mobile/pair-confirm' && req.method === 'POST') return writeJson(res, 200, { ok: true });
  if (url.pathname === '/api/mobile/hello') return writeJson(res, 200, { ok: true, hostname: 'Mobile Stress Mock', version: 'fixture' });
  if (url.pathname === '/api/mobile/state') return writeJson(res, 200, snapshot());
  if (url.pathname === '/api/mobile/conversation') {
    return writeJson(res, 200, {
      ...snapshot(),
      windowStart: 0,
      branchGroups: [],
      activeBranchId: '',
      runtimeBranchId: '',
      branchGroupId: '',
      viewedBranchNodePath: [],
      runtimeBranchNodePath: [],
    });
  }
  if (url.pathname === '/api/mobile/conversation-ui-state') {
    const delayMs = Math.min(3_000, Math.max(0, Number(url.searchParams.get('delayMs') || 0)));
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    return writeJson(res, 200, conversationUiSnapshot());
  }
  if (url.pathname === '/api/mobile/conversation-ui-action' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const input = body ? JSON.parse(body) : {};
    metrics.queueActions += 1;
    metrics.uiActions.push({ action: String(input.action || ''), id: String(input.id || ''), value: String(input.value || ''), at: new Date().toISOString() });
    if (input.action === 'queue_enqueue') {
      queueItems = queueItems.concat({
        id: String(input.id || `stress-next-${Date.now()}`),
        text: String(input.text || ''),
        queueMode: 'followUp',
        requestedMode: String(input.requestedMode || 'build'),
        goalObjective: String(input.goalObjective || ''),
        createdAt: new Date().toISOString(),
      });
    } else if (input.action === 'queue_toggle_pause') {
      queuePaused = !queuePaused;
    } else if (input.action === 'queue_delete' || input.action === 'queue_guide') {
      queueItems = queueItems.filter(item => item.id !== String(input.id || ''));
    } else if (input.action === 'queue_update') {
      queueItems = queueItems.map(item => item.id === String(input.id || '') ? { ...item, text: String(input.text || item.text) } : item);
    } else if (input.action === 'goal_toggle_pause') {
      goalPaused = !goalPaused;
    } else if (input.action === 'flow_pause') {
      flowPaused = true;
    } else if (input.action === 'flow_resume') {
      flowPaused = false;
    } else if (input.action === 'conversation_stop') {
      stopRequested = true;
    }
    return writeJson(res, 200, {
      ok: true,
      queueItems,
      queuePaused,
      goal: { objective: 'Stress Goal: preserve the authoritative remote state', paused: goalPaused, verified: false, goalRounds: 3 },
      flow: { running: flowRunning, paused: flowPaused, name: 'Mobile realtime stress', promptText: flowRunning ? 'Flow prompt remains visible during Build streaming' : '' },
      runtime: conversationUiSnapshot().runtime,
      queued: { steering: [], followUp: queueItems.map(item => item.text) },
    });
  }
  if (url.pathname === '/api/mobile/send' && req.method === 'POST') {
    metrics.sends += 1;
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const input = body ? JSON.parse(body) : {};
    messages.push({ messageId: `mobile-user-${Date.now()}`, role: 'user', content: String(input.message || ''), timestamp: new Date().toISOString(), runId: '' });
    metrics.bursts += 1;
    await emitRun(12, 4);
    return writeJson(res, 200, { ok: true, conversationId, response: 'fixture terminal response', tokens: [], chatMessages: messages, status: 'idle' });
  }
  if (url.pathname === '/api/mobile/model' && req.method === 'POST') return writeJson(res, 200, { ok: true, model: 'mock-mobile-model' });
  if (url.pathname === '/api/mobile/intelligence' && req.method === 'POST') return writeJson(res, 200, { ok: true, intelligence: 'medium' });
  return writeJson(res, 404, { error: 'Unknown API' });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ ok: true, port, fixture: 'mobile-stress' })}\n`);
});

function shutdown() {
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
