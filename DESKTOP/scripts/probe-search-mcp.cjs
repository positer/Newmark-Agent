#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');

const query = String(process.argv.slice(2).join(' ') || 'Newmark Agent GitHub').trim();
const timeoutMs = Math.max(3000, Number(process.env.NEWMARK_SEARCH_MCP_PROBE_TIMEOUT_MS) || 15000);
const EMPTY_SEARCH_TEXT = /^(?:\s*(?:\[(?:web[_-]?)?search\]\s*)?)(?:no\s+(?:search\s+)?results?(?:\s+(?:were\s+)?found)?(?=\s*(?:$|[.!。:：,;]|(?:for|matching|returned|available)\b))|0\s+(?:search\s+)?results?(?=\s*(?:$|[.!。:：,;]|(?:for|found|returned|matching)\b))|nothing\s+(?:was\s+)?found(?=\s*(?:$|[.!。:：,;]|(?:for|matching)\b))|(?:未找到(?:任何)?(?:搜索)?结果|无(?:可用)?搜索结果)(?=\s*(?:$|[。！!，,:：；;])))/i;
const candidates = [
  { id: 'wuxing-search-mcp', name: 'Wuxing Search MCP', command: process.execPath, args: [require.resolve('@iflow-mcp/maeshughes-wuxing-search-mcp/src/index.js')], env: { SEARXNG_URL: process.env.SEARXNG_URL || 'http://127.0.0.1:18080', TIMEOUT: '7000' }, prerequisite: 'SearXNG on SEARXNG_URL' },
  { id: 'miyami-websearch-mcp', name: 'miyami-websearch-mcp', command: process.platform === 'win32' ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : 'npx', args: process.platform === 'win32' ? ['/d', '/s', '/c', 'npx.cmd', '-y', 'miyami-websearch-mcp'] : ['-y', 'miyami-websearch-mcp'] },
  { id: 'ignidor-web-search-mcp', name: '@ignidor/web-search-mcp', command: process.execPath, args: [require.resolve('@ignidor/web-search-mcp/dist/index.js')] },
  { id: 'duckduckgo-mcp', name: 'DuckDuckGo MCP', command: process.platform === 'win32' ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : 'npx', args: process.platform === 'win32' ? ['/d', '/s', '/c', 'npx.cmd', '-y', '@ericthered926/duckduckgo-mcp-server'] : ['-y', '@ericthered926/duckduckgo-mcp-server'] },
];

function replaceLiteral(value, target, replacement) {
  if (!target) return value;
  return value.replace(new RegExp(String(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), replacement);
}

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
    process.env.npm_config_cache,
  ].filter(Boolean).sort((a, b) => b.length - a.length);
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
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}\b/g, '[redacted]');
}

function redact(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
}

function emptyOrErrorSearchText(value) {
  const clean = String(value || '').trim();
  if (!clean) return true;
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === 'object' && (parsed.success === false || parsed.ok === false || parsed.error)) return true;
    if (parsed && Array.isArray(parsed.results) && parsed.results.length === 0 && !parsed.answer) return true;
  } catch {}
  return /^error\b/i.test(clean) || EMPTY_SEARCH_TEXT.test(clean);
}

function rpc(child, id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
}

function probe(candidate) {
  return new Promise(resolve => {
    const child = spawn(candidate.command, candidate.args, { env: { ...process.env, ...(candidate.env || {}) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    let tools = [];
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(redact({ id: candidate.id, name: candidate.name, prerequisite: candidate.prerequisite || '', ...result, stderr: stderr.slice(-500) }));
    };
    const timer = setTimeout(() => finish({ ok: false, phase: 'timeout', error: `>${timeoutMs}ms` }), timeoutMs);
    child.on('error', error => finish({ ok: false, phase: 'spawn', error: error.message }));
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdout.on('data', chunk => {
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          rpc(child, 2, 'tools/list', {});
        } else if (message.id === 2 && message.result) {
          tools = Array.isArray(message.result.tools) ? message.result.tools : [];
          const tool = tools.find(item => /^(web[_-]?search|search|duckduckgo(?:[_-](?:web[_-]?)?search)?)$/i.test(String(item.name || '')))
            || tools.find(item => /search.*(?:web|internet)|(?:web|internet).*search/i.test(String(item.description || '')));
          if (!tool) return finish({ ok: false, phase: 'tools/list', tools: tools.map(item => item.name), error: 'no search-only tool' });
          const properties = tool.inputSchema && tool.inputSchema.properties || {};
          const argument = ['query', 'q', 'search_query', 'keywords', 'text'].find(key => Object.prototype.hasOwnProperty.call(properties, key)) || 'query';
          rpc(child, 3, 'tools/call', { name: tool.name, arguments: { [argument]: query } });
        } else if (message.id === 3) {
          const result = message.result || {};
          const text = Array.isArray(result.content) ? result.content.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';
          const successful = !result.isError && !emptyOrErrorSearchText(text);
          finish({ ok: !!successful, phase: 'tools/call', tools: tools.map(item => item.name), text: text.slice(0, 1000), error: successful ? '' : 'empty/error result' });
        }
      }
    });
    rpc(child, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'newmark-search-probe', version: '0.5.13' } });
  });
}

(async () => {
  const results = [];
  for (const candidate of candidates) results.push(await probe(candidate));
  process.stdout.write(`${JSON.stringify(redact({ checkedAt: new Date().toISOString(), query, results }), null, 2)}\n`);
  process.exitCode = results.some(result => result.ok) ? 0 : 2;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
