#!/usr/bin/env node
'use strict';

const http = require('node:http');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { spawn } = require('node:child_process');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 48765;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_QUERY_CHARS = 2000;
const MAX_RESULT_CHARS = 60000;
const UPSTREAM_TIMEOUT_MS = Math.max(3000, Number(process.env.NEWMARK_SEARCH_MCP_BRIDGE_UPSTREAM_TIMEOUT_MS) || 20000);
const PROTOCOL_VERSION = '2025-06-18';
const BRIDGE_TOKEN = String(process.env.NEWMARK_SEARCH_MCP_BRIDGE_TOKEN || '');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const SAFE_QUERY_KEYS = new Set(['query']);
const PUBLIC_URL = /https?:\/\/[^\s<>()\[\]{}\"']+/gi;
const EMPTY_SEARCH_TEXT = /^(?:\s*(?:\[(?:web[_-]?)?search\]\s*)?)(?:no\s+(?:search\s+)?results?(?:\s+(?:were\s+)?found)?(?=\s*(?:$|[.!。:：,;]|(?:for|matching|returned|available)\b))|0\s+(?:search\s+)?results?(?=\s*(?:$|[.!。:：,;]|(?:for|found|returned|matching)\b))|nothing\s+(?:was\s+)?found(?=\s*(?:$|[.!。:：,;]|(?:for|matching)\b))|(?:未找到(?:任何)?(?:搜索)?结果|无(?:可用)?搜索结果)(?=\s*(?:$|[。！!，,:：；;])))/i;

function parseArgs(argv) {
  let host = String(process.env.NEWMARK_SEARCH_MCP_BRIDGE_HOST || DEFAULT_HOST).trim();
  let port = Number(process.env.NEWMARK_SEARCH_MCP_BRIDGE_PORT || DEFAULT_PORT);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--host') host = String(argv[++index] || '').trim();
    else if (argv[index] === '--port') port = Number(argv[++index]);
    else if (argv[index] === '--help' || argv[index] === '-h') {
      process.stdout.write([
        'Usage: node scripts/android-search-mcp-bridge.cjs [--host 127.0.0.1] [--port 48765]',
        '',
        'The bridge deliberately binds only to loopback. For an Android emulator:',
        '  adb reverse tcp:48765 tcp:48765',
        '  Streamable HTTP: http://127.0.0.1:48765/mcp',
        '  Legacy SSE:     http://127.0.0.1:48765/sse',
        '',
      ].join('\n'));
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('The Android Search MCP test bridge may only bind to loopback');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer from 1024 to 65535');
  return { host, port };
}

function replaceLiteral(value, target, replacement) {
  if (!target) return value;
  return value.replace(new RegExp(String(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), replacement);
}

function redactLocalText(value) {
  let output = String(value || '');
  const roots = [
    process.cwd(), process.env.USERPROFILE, process.env.HOME, process.env.LOCALAPPDATA,
    process.env.APPDATA, process.env.TEMP, process.env.TMP, process.env.npm_config_cache,
  ].filter(Boolean).sort((left, right) => right.length - left.length);
  for (const root of roots) {
    for (const variant of new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\'), encodeURI(root), encodeURI(root.replace(/\\/g, '/'))])) {
      output = replaceLiteral(output, variant, '<local-path>');
    }
  }
  return output
    .replace(/file:\/\/\/[A-Za-z]:\/[^\s\"'<>|,;\r\n]+/gi, '<local-path>')
    .replace(/(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/][^\s\"'<>|,;\r\n]+/g, '<local-path>')
    .replace(/(?:file:\/\/)?\/(?:home|Users|tmp|var\/tmp)\/[^\s\"'<>|,;\r\n]+/g, '<local-path>')
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/ig, '$1[redacted]')
    .replace(/([?&](?:api[_-]?key|access_token|token|key)=)[^&\s]+/ig, '$1[redacted]')
    .slice(0, 500);
}

function safeError(error) {
  return redactLocalText(error instanceof Error ? error.message : String(error || 'unknown error'));
}

function semanticSearchFailure(text) {
  const clean = String(text || '').trim();
  if (!clean || EMPTY_SEARCH_TEXT.test(clean) || /^error\b/i.test(clean)) return true;
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === 'object' && (parsed.success === false || parsed.ok === false || parsed.error)) return true;
    if (parsed && Array.isArray(parsed.results) && parsed.results.length === 0 && !parsed.answer && !parsed.text) return true;
  } catch {}
  return false;
}

function publicHttpUrls(text) {
  const urls = [];
  for (const raw of String(text || '').match(PUBLIC_URL) || []) {
    try {
      const url = new URL(raw.replace(/[.,;:!?]+$/, ''));
      const host = url.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') continue;
      if (host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) continue;
      if (!urls.includes(url.toString())) urls.push(url.toString());
    } catch {}
  }
  return urls;
}

function extractSearchText(result) {
  if (!result || typeof result !== 'object' || result.isError === true) throw new Error('Ignidor search returned an MCP error');
  const chunks = [];
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (item && item.type === 'text' && String(item.text || '').trim()) chunks.push(String(item.text).trim());
  }
  if (chunks.length === 0 && result.structuredContent && typeof result.structuredContent === 'object') {
    chunks.push(JSON.stringify(result.structuredContent, null, 2));
  }
  const text = chunks.join('\n\n').trim().slice(0, MAX_RESULT_CHARS);
  if (semanticSearchFailure(text)) throw new Error('Ignidor search returned an empty or failed result');
  if (publicHttpUrls(text).length === 0) throw new Error('Ignidor search returned no public HTTP(S) evidence');
  return text;
}

class IgnidorSearchBackend {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.stderr = '';
    this.pending = new Map();
    this.sequence = 0;
    this.startPromise = null;
    this.ready = false;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.ready && this.child && !this.child.killed) return;
    this.startPromise = this.startFresh()
      .catch(error => {
        this.stopChild(error);
        throw error;
      })
      .finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async startFresh() {
    const entry = require.resolve('@ignidor/web-search-mcp/dist/index.js');
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.ready = false;
    this.buffer = '';
    this.stderr = '';
    child.stdout.on('data', chunk => this.consumeStdout(String(chunk)));
    child.stderr.on('data', chunk => { this.stderr = `${this.stderr}${String(chunk)}`.slice(-4000); });
    child.on('error', error => this.failAll(error));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.ready = false;
      this.failAll(new Error(`Ignidor MCP exited before completing the request (code=${code ?? 'none'}, signal=${signal || 'none'})`));
    });

    const initialized = await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'newmark-android-search-test-bridge', version: '0.5.13' },
    });
    if (!initialized || typeof initialized !== 'object') throw new Error('Ignidor MCP returned an invalid initialize response');
    this.notify('notifications/initialized', {});
    const listed = await this.rpc('tools/list', {});
    const tools = Array.isArray(listed && listed.tools) ? listed.tools : [];
    const search = tools.find(tool => tool && tool.name === 'search');
    const queryProperty = search && search.inputSchema && search.inputSchema.properties && search.inputSchema.properties.query;
    if (!search || !queryProperty || queryProperty.type !== 'string') {
      throw new Error('Ignidor MCP no longer exposes the expected search(query: string) tool');
    }
    this.ready = true;
  }

  consumeStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
        const pending = this.pending.get(String(message.id));
        if (!pending) continue;
        this.pending.delete(String(message.id));
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`Ignidor MCP error: ${String(message.error.message || 'unknown error')}`));
        else pending.resolve(message.result);
      }
    }
  }

  rpc(method, params) {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) return Promise.reject(new Error('Ignidor MCP is not running'));
    const id = `bridge-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Ignidor MCP ${method} timed out after ${UPSTREAM_TIMEOUT_MS}ms`));
      }, UPSTREAM_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  notify(method, params) {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) throw new Error('Ignidor MCP is not running');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async search(query) {
    await this.start();
    const result = await this.rpc('tools/call', { name: 'search', arguments: { query } });
    return extractSearchText(result);
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.stopChild(new Error('Ignidor MCP bridge stopped'));
  }

  stopChild(error) {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.failAll(error);
    if (!child) return;
    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
  }
}

const PUBLIC_TOOL = {
  name: 'web_search',
  description: 'Search the public web through the local Newmark Android test bridge. The only accepted input is a bounded query string.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_CHARS } },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message: String(message).slice(0, 500) } };
}

async function handleRpcMessage(message, backend) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return jsonRpcError(message && message.id, -32600, 'Invalid JSON-RPC request');
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const id = message.id;
  if (!hasId) {
    if (message.method === 'notifications/initialized' || message.method.startsWith('notifications/')) return null;
    return null;
  }
  if (message.method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'newmark-android-search-test-bridge', version: '0.5.13' },
      instructions: 'Search-only local interoperability bridge. Only web_search(query) is exposed.',
    });
  }
  if (message.method === 'ping') return jsonRpcResult(id, {});
  if (message.method === 'tools/list') return jsonRpcResult(id, { tools: [PUBLIC_TOOL] });
  if (message.method === 'tools/call') {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
    if (params.name !== 'web_search') return jsonRpcError(id, -32602, 'Only web_search is available');
    if (Object.keys(args).some(key => !SAFE_QUERY_KEYS.has(key))) return jsonRpcError(id, -32602, 'web_search accepts only the query field');
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query || query.length > MAX_QUERY_CHARS) return jsonRpcError(id, -32602, `query must contain 1-${MAX_QUERY_CHARS} characters`);
    try {
      const text = await backend.search(query);
      return jsonRpcResult(id, { content: [{ type: 'text', text }] });
    } catch (error) {
      return jsonRpcResult(id, { isError: true, content: [{ type: 'text', text: safeError(error) }] });
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${message.method}`);
}

function requestHostAllowed(req) {
  const raw = String(req.headers.host || '');
  try { return LOOPBACK_HOSTS.has(new URL(`http://${raw}`).hostname); } catch { return false; }
}

function tokenAllowed(req) {
  if (!BRIDGE_TOKEN) return true;
  const expected = Buffer.from(`Bearer ${BRIDGE_TOKEN}`);
  const actual = Buffer.from(String(req.headers.authorization || ''));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function securityGate(req, res) {
  if (!requestHostAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Loopback Host header required' }));
    return false;
  }
  if (!tokenAllowed(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size <= MAX_BODY_BYTES) body += chunk;
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return reject(new Error('Request body is too large'));
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Request body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function createBridgeServer(backend) {
  const sseSessions = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (!securityGate(req, res)) return;
    if (url.pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        server: 'newmark-android-search-test-bridge',
        upstream: '@ignidor/web-search-mcp',
        transports: { streamableHttp: '/mcp', legacySse: '/sse' },
        tools: ['web_search'],
      });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (url.pathname === '/mcp') {
      if (req.method === 'GET') {
        res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      try {
        const body = await readJsonBody(req);
        const messages = Array.isArray(body) ? body : [body];
        const responses = [];
        for (const message of messages) {
          const response = await handleRpcMessage(message, backend);
          if (response) responses.push(response);
        }
        if (responses.length === 0) {
          res.writeHead(202, { 'Cache-Control': 'no-store' });
          return res.end();
        }
        return sendJson(res, 200, Array.isArray(body) ? responses : responses[0]);
      } catch (error) {
        return sendJson(res, 400, jsonRpcError(null, -32700, safeError(error)));
      }
    }
    if (url.pathname === '/sse' && req.method === 'GET') {
      const sessionId = randomUUID();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: endpoint\ndata: /messages?sessionId=${encodeURIComponent(sessionId)}\n\n`);
      const keepAlive = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 15000);
      sseSessions.set(sessionId, { res, keepAlive });
      req.on('close', () => {
        clearInterval(keepAlive);
        sseSessions.delete(sessionId);
      });
      return;
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId') || '';
      const session = sseSessions.get(sessionId);
      if (!session || session.res.destroyed) return sendJson(res, 404, { error: 'Unknown SSE session' });
      try {
        const message = await readJsonBody(req);
        const response = await handleRpcMessage(message, backend);
        if (response) session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        res.writeHead(202, { 'Cache-Control': 'no-store' });
        return res.end();
      } catch (error) {
        return sendJson(res, 400, jsonRpcError(null, -32700, safeError(error)));
      }
    }
    return sendJson(res, 404, { error: 'Not found' });
  });
  server.on('close', () => {
    for (const session of sseSessions.values()) {
      clearInterval(session.keepAlive);
      try { session.res.end(); } catch {}
    }
    sseSessions.clear();
  });
  return server;
}

async function main() {
  const { host, port } = parseArgs(process.argv.slice(2));
  const backend = new IgnidorSearchBackend();
  const server = createBridgeServer(backend);
  const close = () => {
    backend.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  server.on('error', error => {
    process.stderr.write(`Android Search MCP bridge failed: ${safeError(error)}\n`);
    backend.close();
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    process.stdout.write(`${JSON.stringify({
      status: 'ready',
      host,
      port,
      streamableHttp: `http://${host}:${port}/mcp`,
      legacySse: `http://${host}:${port}/sse`,
      adbReverse: `adb reverse tcp:${port} tcp:${port}`,
      tokenRequired: Boolean(BRIDGE_TOKEN),
      exposedTools: ['web_search'],
      upstream: '@ignidor/web-search-mcp',
    })}\n`);
  });
}

main().catch(error => {
  process.stderr.write(`Android Search MCP bridge failed: ${safeError(error)}\n`);
  process.exitCode = 1;
});
