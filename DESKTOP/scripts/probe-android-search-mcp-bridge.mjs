#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const baseUrl = String(process.env.NEWMARK_SEARCH_MCP_BRIDGE_URL || 'http://127.0.0.1:48765').replace(/\/$/, '');
const query = String(process.argv.slice(2).join(' ') || 'Newmark Agent GitHub').trim();
const token = String(process.env.NEWMARK_SEARCH_MCP_BRIDGE_TOKEN || '');
const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
const PUBLIC_URL = /https?:\/\/[^\s<>()\[\]{}\"']+/gi;

function publicUrls(text) {
  const urls = [];
  for (const raw of String(text || '').match(PUBLIC_URL) || []) {
    try {
      const url = new URL(raw.replace(/[.,;:!?]+$/, ''));
      const host = url.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('10.') || host.startsWith('192.168.')) continue;
      if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) continue;
      if (!urls.includes(url.toString())) urls.push(url.toString());
    } catch {}
  }
  return urls;
}

async function probe(name, endpoint, transportFactory) {
  const client = new Client({ name: `newmark-android-search-bridge-${name}-probe`, version: '0.5.13' });
  const startedAt = Date.now();
  try {
    await client.connect(transportFactory());
    const listed = await client.listTools();
    const tools = Array.isArray(listed.tools) ? listed.tools : [];
    const names = tools.map(tool => tool.name);
    const closedSurface = names.length === 1 && names[0] === 'web_search';
    const schema = tools[0] && tools[0].inputSchema || {};
    const properties = schema.properties && Object.keys(schema.properties) || [];
    const closedSchema = schema.type === 'object' && schema.additionalProperties === false &&
      properties.length === 1 && properties[0] === 'query' && schema.properties.query.type === 'string';
    if (!closedSurface || !closedSchema) throw new Error(`search-only boundary failed: ${JSON.stringify({ names, properties })}`);
    const result = await client.callTool({ name: 'web_search', arguments: { query } });
    const text = Array.isArray(result.content)
      ? result.content.filter(item => item.type === 'text').map(item => String(item.text || '')).join('\n')
      : '';
    const urls = publicUrls(text);
    const ok = result.isError !== true && text.trim().length > 0 && urls.length > 0;
    return {
      transport: name,
      endpoint,
      elapsedMs: Date.now() - startedAt,
      tools: names,
      closedSchema,
      ok,
      textChars: text.length,
      publicUrls: urls.slice(0, 5),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

const requestInit = headers ? { headers } : undefined;
const results = [];
results.push(await probe(
  'streamable_http',
  `${baseUrl}/mcp`,
  () => new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit,
    reconnectionOptions: { initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
  }),
));
results.push(await probe(
  'legacy_sse',
  `${baseUrl}/sse`,
  () => new SSEClientTransport(new URL(`${baseUrl}/sse`), { requestInit }),
));

const output = {
  checkedAt: new Date().toISOString(),
  bridge: baseUrl,
  upstream: '@ignidor/web-search-mcp',
  exposedTools: ['web_search'],
  results,
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.exitCode = results.every(result => result.ok) ? 0 : 2;
