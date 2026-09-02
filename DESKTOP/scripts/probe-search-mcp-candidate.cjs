#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');

const raw = process.env.SEARCH_MCP_CANDIDATE_JSON;
if (!raw) throw new Error('SEARCH_MCP_CANDIDATE_JSON is required');
const candidate = JSON.parse(raw);
const timeoutMs = Math.max(3000, Number(candidate.timeoutMs) || 60000);
const query = String(candidate.query || 'protocol interoperability');
const EMPTY_SEARCH_TEXT = /^(?:\s*(?:\[(?:web[_-]?)?search\]\s*)?)(?:no\s+(?:search\s+)?results?(?:\s+(?:were\s+)?found)?(?=\s*(?:$|[.!。:：,;]|(?:for|matching|returned|available)\b))|0\s+(?:search\s+)?results?(?=\s*(?:$|[.!。:：,;]|(?:for|found|returned|matching)\b))|nothing\s+(?:was\s+)?found(?=\s*(?:$|[.!。:：,;]|(?:for|matching)\b))|(?:未找到(?:任何)?(?:搜索)?结果|无(?:可用)?搜索结果)(?=\s*(?:$|[。！!，,:：；;])))/i;
const startedAt = Date.now();
const child = spawn(candidate.command, candidate.args || [], {
  env: { ...process.env, ...(candidate.env || {}) },
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdoutBuffer = '';
let stderr = '';
let initialize = null;
let tools = [];
let selectedTool = null;
let finished = false;

function redactText(value) {
  let output = String(value || '');
  const roots = [
    process.cwd(),
    process.env.USERPROFILE,
    process.env.HOME,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.TEMP,
    process.env.TMP,
  ].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const root of roots) output = output.split(root).join('<local-path>');
  for (const root of roots) {
    for (const variant of new Set([root.replace(/\\/g, '/'), root.replace(/\//g, '\\'), encodeURI(root), encodeURI(root.replace(/\\/g, '/'))])) {
      output = output.split(variant).join('<local-path>');
    }
  }
  output = output.replace(/file:\/\/\/[A-Za-z]:\/[^\s\"'<>|,;\r\n]+/gi, '<local-path>');
  output = output.replace(/[A-Za-z]:\\(?:[^\s"'<>|,;\r\n]+\\)*[^\s"'<>|,;\r\n]*/g, '<local-path>');
  output = output.replace(/(?<![A-Za-z0-9+.-])[A-Za-z]:\/[^\s\"'<>|,;\r\n]+/g, '<local-path>');
  output = output.replace(/\/(?:home|Users|tmp|var\/tmp)\/[^\s"'<>|,;\r\n]+/g, '<local-path>');
  return output
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/ig, '$1[redacted]')
    .replace(/([?&](?:api[_-]?key|access_token|token|key)=)[^&\s]+/ig, '$1[redacted]')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}\b/g, '[redacted]');
}

function redact(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  }
  return value;
}

function rpc(id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
}

function finish(payload) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try { child.kill(); } catch {}
  process.stdout.write(`${JSON.stringify(redact({
    candidate: candidate.id,
    command: candidate.displayCommand || [candidate.command, ...(candidate.args || [])].join(' '),
    elapsedMs: Date.now() - startedAt,
    initialize,
    tools: tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })),
    selectedTool,
    stderrTail: stderr.slice(-2000),
    ...payload,
  }), null, 2)}\n`);
  process.exitCode = payload.ok ? 0 : 2;
}

function chooseTool() {
  if (candidate.tool) return tools.find(tool => tool.name === candidate.tool);
  return tools.find(tool => /^(web[_-]?search|search|search[_-]?web|free[_-]?general[_-]?search|searxngsearch)$/i.test(String(tool.name || '')))
    || tools.find(tool => /search.*(?:web|internet)|(?:web|internet).*search/i.test(String(tool.description || '')));
}

function argumentsFor(tool) {
  if (candidate.callArguments) return candidate.callArguments;
  const properties = tool && tool.inputSchema && tool.inputSchema.properties || {};
  const key = ['query', 'q', 'search_query', 'keywords', 'text', 'question'].find(name => Object.prototype.hasOwnProperty.call(properties, name)) || 'query';
  return { [key]: query };
}

const timer = setTimeout(() => finish({ ok: false, phase: 'timeout', error: `>${timeoutMs}ms` }), timeoutMs);
child.on('error', error => finish({ ok: false, phase: 'spawn', error: error.message }));
child.on('exit', (code, signal) => {
  if (!finished) finish({ ok: false, phase: 'exit', error: `code=${code} signal=${signal}` });
});
child.stderr.on('data', chunk => { stderr += String(chunk); });
child.stdout.on('data', chunk => {
  stdoutBuffer += String(chunk);
  for (;;) {
    const newline = stdoutBuffer.indexOf('\n');
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === 1) {
      if (message.error) return finish({ ok: false, phase: 'initialize', error: message.error });
      initialize = message.result || null;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      rpc(2, 'tools/list', {});
    } else if (message.id === 2) {
      if (message.error) return finish({ ok: false, phase: 'tools/list', error: message.error });
      tools = Array.isArray(message.result && message.result.tools) ? message.result.tools : [];
      const tool = chooseTool();
      if (!tool) return finish({ ok: false, phase: 'tools/list', error: 'no matching search tool' });
      selectedTool = tool.name;
      rpc(3, 'tools/call', { name: tool.name, arguments: argumentsFor(tool) });
    } else if (message.id === 3) {
      if (message.error) return finish({ ok: false, phase: 'tools/call', error: message.error });
      const result = message.result || {};
      const text = Array.isArray(result.content)
        ? result.content.filter(item => item && item.type === 'text').map(item => item.text).join('\n')
        : '';
      const structuredError = Boolean(result.structuredContent && (
        result.structuredContent.error
        || result.structuredContent.success === false
        || result.structuredContent.ok === false
      ));
      const textualError = /^\s*(?:error\b|\{\s*"error"\s*:)/i.test(text)
        || /"success"\s*:\s*false|"ok"\s*:\s*false/i.test(text)
        || EMPTY_SEARCH_TEXT.test(text.trim());
      const successful = !result.isError && !structuredError && !textualError && Boolean(text.trim());
      finish({
        ok: successful,
        phase: 'tools/call',
        isError: Boolean(result.isError),
        contentTypes: Array.isArray(result.content) ? result.content.map(item => item && item.type) : [],
        text: text.slice(0, 12000),
        structuredContent: result.structuredContent || null,
        error: successful ? '' : 'MCP tool returned an error or empty text content',
      });
    }
  }
});

rpc(1, 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'newmark-search-candidate-probe', version: '0.5.13' },
});
