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
  bursts: 0,
};

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

async function emitRun(count, duplicateEvery = 10) {
  const runId = `stress-run-${Date.now()}-${metrics.bursts}`;
  let sequence = 0;
  broadcast(event({ id: `${runId}:start`, runId, type: 'start', sequence: sequence++, content: 'fixture start', status: 'running' }), true);
  for (let index = 0; index < count; index += 1) {
    const row = event({
      id: `${runId}:text:${index}`,
      runId,
      type: 'text',
      sequence: sequence++,
      content: `fixture event ${index + 1}/${count}`,
      status: 'running',
    });
    broadcast(row, duplicateEvery > 0 && index % duplicateEvery === 0);
  }
  broadcast(event({ id: `${runId}:final`, runId, type: 'final_response', sequence: sequence++, content: 'fixture terminal response', status: 'completed' }));
  broadcast(event({ id: `${runId}:done`, runId, type: 'done', sequence: sequence++, content: 'done', status: 'completed' }), true);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/__stress/stats') return writeJson(res, 200, metrics);
  if (url.pathname === '/__stress/burst') {
    const count = Math.min(1000, Math.max(1, Number(url.searchParams.get('count') || 120)));
    metrics.bursts += 1;
    await emitRun(count);
    return writeJson(res, 200, { ok: true, count, emittedEvents: metrics.emittedEvents });
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
  if (url.pathname === '/api/mobile/send' && req.method === 'POST') {
    metrics.sends += 1;
    await emitRun(12, 4);
    return writeJson(res, 200, { ok: true, conversationId, response: 'fixture terminal response', tokens: [], chatMessages: messages, status: 'idle' });
  }
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
