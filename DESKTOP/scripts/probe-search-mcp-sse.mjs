#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const endpoint = process.env.SEARCH_MCP_SSE_URL;
if (!endpoint) throw new Error('SEARCH_MCP_SSE_URL is required');
const query = process.argv.slice(2).join(' ') || 'protocol interoperability';
const client = new Client({ name: 'newmark-search-sse-probe', version: '0.5.13' });
const transport = new SSEClientTransport(new URL(endpoint));
const startedAt = Date.now();

function redactText(value) {
  let output = String(value || '');
  const roots = [
    process.cwd(), process.env.USERPROFILE, process.env.HOME, process.env.LOCALAPPDATA,
    process.env.APPDATA, process.env.TEMP, process.env.TMP, process.env.npm_config_cache,
  ].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const root of roots) {
    for (const variant of new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\'), encodeURI(root), encodeURI(root.replace(/\\/g, '/'))])) {
      output = output.split(variant).join('<local-path>');
    }
  }
  return output
    .replace(/file:\/\/\/[A-Za-z]:\/[^\s\"'<>|\r\n]+/gi, '<local-path>')
    .replace(/(?<![A-Za-z0-9+.-]:\/\/)(?<![A-Za-z])[A-Za-z]:[\\/][^\s\"'<>|\r\n]+/g, '<local-path>')
    .replace(/(?<!:)(?:file:\/\/)?\/(?:home|Users|tmp|var\/tmp)\/[^\s\"'<>|\r\n]+/g, '<local-path>')
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/ig, '$1[redacted]')
    .replace(/([?&](?:api[_-]?key|access_token|token|key)=)[^&\s]+/ig, '$1[redacted]');
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const tools = listed.tools || [];
  const tool = tools.find(item => item.name === 'quick_search')
    || tools.find(item => /search/i.test(item.name));
  if (!tool) throw new Error('no search tool');
  const result = await client.callTool({ name: tool.name, arguments: { query } });
  const text = Array.isArray(result.content)
    ? result.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
    : '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  const semanticError = Boolean(parsed && (parsed.ok === false || parsed.success === false || parsed.error));
  const ok = !result.isError && !semanticError && Boolean(text.trim()) && !/^\s*(?:error\b|\{\s*"error"\s*:)/i.test(text);
  process.stdout.write(`${JSON.stringify({
    elapsedMs: Date.now() - startedAt,
    tools: tools.map(item => item.name),
    selectedTool: tool.name,
    ok,
    isError: Boolean(result.isError),
    text: redactText(text).slice(0, 12000),
  }, null, 2)}\n`);
  process.exitCode = ok ? 0 : 2;
} finally {
  await client.close().catch(() => {});
}
