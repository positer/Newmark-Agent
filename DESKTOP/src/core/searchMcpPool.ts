import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type SearchMcpTransport = 'stdio' | 'streamable_http' | 'sse' | 'template';

export interface SearchMcpEndpoint {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  transport: SearchMcpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  tool?: string;
  argument?: string;
  timeoutMs?: number;
  notes?: string;
}

export interface SearchMcpPoolConfig {
  version: 1;
  endpoints: SearchMcpEndpoint[];
}

export interface PublicSearchMcpEndpoint extends Omit<SearchMcpEndpoint, 'env' | 'headers' | 'command' | 'args' | 'cwd'> {
  envKeys: string[];
  headerKeys: string[];
  url?: string;
}

export interface SearchMcpAttempt {
  id: string;
  name: string;
  status: 'success' | 'empty' | 'error' | 'unconfigured';
  durationMs: number;
  error?: string;
}

export interface SearchMcpPoolResult {
  invocationId: string;
  checkedAt: string;
  ok: boolean;
  provider?: string;
  text?: string;
  attempts: SearchMcpAttempt[];
}

export interface SearchMcpPoolDependencies {
  callEndpoint?: (endpoint: SearchMcpEndpoint, query: string, signal?: AbortSignal) => Promise<string>;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
export const MAX_SEARCH_MCP_RESULT_CHARS = 60_000;
const SEARCH_MCP_HEALTH_FILE = 'search-mcp-health.json';
const SEARCH_TOOL_NAME = /^(?:web[_-]?search|search(?:_web)?|internet[_-]?search|duckduckgo(?:[_-](?:web[_-]?)?search)?)$/i;
const SEARCH_TOOL_DESCRIPTION = /\b(?:web|internet|duckduckgo|searxng)\b[\s\S]{0,80}\bsearch\b|\bsearch\b[\s\S]{0,80}\b(?:web|internet)\b/i;
const SEARCH_QUERY_ARGUMENTS = ['query', 'q', 'search_query', 'searchQuery', 'keywords', 'keyword', 'text'];
const SAFE_SEARCH_ARGUMENTS = new Set([
  ...SEARCH_QUERY_ARGUMENTS,
  'count', 'limit', 'max_results', 'maxResults', 'page', 'offset', 'rankingMode',
  'category', 'categories', 'language', 'locale', 'region', 'country', 'freshness',
  'time_range', 'timeRange', 'safe_search', 'safesearch',
]);
const DANGEROUS_SEARCH_ARGUMENT = /(?:^|_)(?:command|cmd|shell|path|file|write|delete|execute|script|code|cwd|env|headers|body|method|tool|action)(?:$|_)/i;
const EMPTY_SEARCH_TEXT = /^(?:\s*(?:\[(?:web[_-]?)?search\]\s*)?)(?:no\s+(?:search\s+)?results?(?:\s+(?:were\s+)?found)?(?=\s*(?:$|[.!。:：,;]|(?:for|matching|returned|available)\b))|0\s+(?:search\s+)?results?(?=\s*(?:$|[.!。:：,;]|(?:for|found|returned|matching)\b))|nothing\s+(?:was\s+)?found(?=\s*(?:$|[.!。:：,;]|(?:for|matching)\b))|(?:未找到(?:任何)?(?:搜索)?结果|无(?:可用)?搜索结果)(?=\s*(?:$|[。！!，,:：；;])))/i;

/**
 * Public protocol catalog. Only endpoints with evidence-backed launch metadata are runnable by default.
 * The remaining requested implementations are exposed as disabled templates until a distributor/user
 * supplies a concrete stdio command or Streamable HTTP/SSE URL in search-mcp.json.
 */
export const DEFAULT_SEARCH_MCP_MANIFEST: SearchMcpEndpoint[] = [
  {
    id: 'wuxing-search-mcp', name: 'Wuxing Search MCP', enabled: false, priority: 100,
    transport: 'stdio', command: process.execPath,
    args: [path.join(__dirname, '../../node_modules/@iflow-mcp/maeshughes-wuxing-search-mcp/src/index.js')],
    env: { ELECTRON_RUN_AS_NODE: '1', SEARXNG_URL: 'http://127.0.0.1:18080', MAX_RESULTS: '12', TIMEOUT: '7000' },
    tool: 'web_search', argument: 'query', timeoutMs: 8_000,
    notes: 'Bundled MCP adapter; requires a reachable SearXNG backend. Priority is configurable and is not privileged.',
  },
  { id: 'web-search-api', name: 'web-search-api', enabled: false, priority: 200, transport: 'template', notes: 'Set a verified stdio command or HTTP/SSE URL before enabling.' },
  { id: 'miyami-websearch-mcp', name: 'miyami-websearch-mcp', enabled: false, priority: 300, transport: 'template', notes: 'Protocol template; no runtime is downloaded implicitly.' },
  { id: 'searxng-mcp', name: 'searxng-mcp', enabled: false, priority: 400, transport: 'template', notes: 'Protocol template; configure a trusted SearXNG MCP deployment.' },
  { id: 'mcp-server-freesearch', name: 'MCP Server FreeSearch', enabled: false, priority: 500, transport: 'template', notes: 'Protocol template; concrete implementation is distributor-selected.' },
  {
    id: 'ignidor-web-search-mcp', name: '@ignidor/web-search-mcp', enabled: true, priority: 600,
    transport: 'stdio', command: process.execPath,
    args: [path.join(__dirname, '../../node_modules/@ignidor/web-search-mcp/dist/index.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    tool: 'search', argument: 'query', timeoutMs: 12_000,
    notes: 'Bundled after initialize/tools-list/tools-call verification; search-only invocation does not expose crawler or browser tools.',
  },
  { id: 'free-search-mcp', name: 'free-search-mcp', enabled: false, priority: 700, transport: 'template', notes: 'Protocol template; configure the intended package or remote service explicitly.' },
  { id: 'duckduckgo-mcp', name: 'DuckDuckGo MCP', enabled: false, priority: 800, transport: 'template', notes: 'MCP implementation is configurable; HTTP DuckDuckGo remains the absolute final fallback.' },
  { id: 'free-mcp-web-search-server', name: 'Free MCP Web Search Server', enabled: false, priority: 900, transport: 'template', notes: 'Protocol template; configure a verified endpoint before enabling.' },
];

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const clean = String(key || '').trim();
    if (!clean || /[\r\n\0]/.test(clean) || ['__proto__', 'prototype', 'constructor'].includes(clean)) continue;
    const text = String(item ?? '');
    if (/\0/.test(text) || /[\r\n]/.test(text) && /authorization|header/i.test(clean)) continue;
    output[clean] = text;
  }
  return output;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string')) return undefined;
  return value.map(item => String(item).slice(0, 4_000));
}

function safeEndpoint(value: unknown): SearchMcpEndpoint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const id = String(item.id || '').trim().slice(0, 160);
  const name = String(item.name || '').trim().slice(0, 160);
  const transport = ['stdio', 'streamable_http', 'sse', 'template'].includes(String(item.transport))
    ? String(item.transport) as SearchMcpTransport : 'template';
  if (!id || !name) return undefined;
  const priority = Number.isFinite(Number(item.priority)) ? Math.trunc(Number(item.priority)) : 1_000;
  const timeoutMs = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Number(item.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const endpoint: SearchMcpEndpoint = {
    id, name, transport, enabled: item.enabled === true, priority, timeoutMs,
    command: String(item.command || '').trim().slice(0, 2_000) || undefined,
    args: stringArray(item.args), cwd: String(item.cwd || '').trim().slice(0, 4_000) || undefined,
    env: stringRecord(item.env), url: String(item.url || '').trim().slice(0, 4_000) || undefined,
    headers: stringRecord(item.headers), tool: String(item.tool || '').trim().slice(0, 160) || undefined,
    argument: String(item.argument || '').trim().slice(0, 160) || undefined,
    notes: String(item.notes || '').trim().slice(0, 1_000) || undefined,
  };
  if (transport === 'stdio' && !endpoint.command) endpoint.transport = 'template';
  if (transport === 'streamable_http' || transport === 'sse') {
    try {
      const parsed = new URL(endpoint.url || '');
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) endpoint.transport = 'template';
    } catch { endpoint.transport = 'template'; }
  }
  return endpoint;
}

function mergeManifest(configured: unknown, useDefaults = true): SearchMcpEndpoint[] {
  const overrides = Array.isArray(configured) ? configured.map(safeEndpoint).filter((item): item is SearchMcpEndpoint => !!item) : [];
  const byId = new Map((useDefaults ? DEFAULT_SEARCH_MCP_MANIFEST : []).map(item => [item.id, { ...item }]));
  for (const override of overrides) byId.set(override.id, { ...(byId.get(override.id) || {}), ...override });
  return [...byId.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

export function loadSearchMcpManifest(root: string): SearchMcpEndpoint[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'search-mcp.json'), 'utf8')) as Partial<SearchMcpPoolConfig>;
    return mergeManifest(parsed.endpoints, false);
  } catch {
    return mergeManifest([], true);
  }
}

export function publicSearchMcpManifest(root: string): PublicSearchMcpEndpoint[] {
  return loadSearchMcpManifest(root).map(endpoint => {
    const { env, headers, command: _command, args: _args, cwd: _cwd, ...rest } = endpoint;
    let publicUrl = endpoint.url;
    try {
      const parsed = new URL(endpoint.url || '');
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (/(?:api.?key|authorization|access.?token|secret|password|credential)/i.test(key)) parsed.searchParams.set(key, '<redacted>');
      }
      if (parsed.searchParams.size > 0 && parsed.searchParams.toString().length > 2_000) parsed.search = '';
      publicUrl = parsed.toString();
    } catch { /* template or stdio endpoint */ }
    return { ...rest, url: publicUrl, envKeys: Object.keys(env || {}).sort(), headerKeys: Object.keys(headers || {}).sort() };
  });
}

function replaceLiteral(value: string, target: string, replacement: string): string {
  if (!target) return value;
  return value.replace(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), replacement);
}

export function redactSearchMcpLocalPaths(value: string, additionalRoots: string[] = []): string {
  let output = String(value || '');
  const roots = [
    ...additionalRoots,
    process.cwd(),
    process.env.USERPROFILE,
    process.env.HOME,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.TEMP,
    process.env.TMP,
    process.env.npm_config_cache,
  ].filter((item): item is string => !!item).sort((a, b) => b.length - a.length);
  for (const root of roots) {
    const variants = new Set([
      root,
      root.replace(/\\/g, '/'),
      root.replace(/\//g, '\\'),
      encodeURI(root),
      encodeURI(root.replace(/\\/g, '/')),
    ]);
    for (const variant of variants) output = replaceLiteral(output, variant, '<local-path>');
  }
  return output
    .replace(/file:\/\/\/[A-Za-z]:\/[^\s\"'<>|,;\r\n]+/gi, '<local-path>')
    .replace(/(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/][^\s\"'<>|,;\r\n]+/g, '<local-path>')
    .replace(/(?:file:\/\/)?\/(?:home|Users|tmp|var\/tmp)\/[^\s\"'<>|,;\r\n]+/g, '<local-path>');
}

function cleanError(error: unknown, roots: string[] = []): string {
  return redactSearchMcpLocalPaths(error instanceof Error ? error.message : String(error || 'unknown error'), roots)
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/ig, '$1[redacted]')
    .replace(/([?&](?:api[_-]?key|access_token|token|key)=)[^&\s]+/ig, '$1[redacted]')
    .slice(0, 300);
}

function resultText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const chunks: string[] = [];
  let length = 0;
  for (const item of content) {
    if (!item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'text') continue;
    const value = String((item as { text?: unknown }).text || '').trim();
    if (!value) continue;
    const separator = chunks.length ? 2 : 0;
    const remaining = MAX_SEARCH_MCP_RESULT_CHARS - length - separator;
    if (remaining <= 0) break;
    chunks.push(value.slice(0, remaining));
    length += separator + Math.min(value.length, remaining);
  }
  const text = chunks.join('\n\n').slice(0, MAX_SEARCH_MCP_RESULT_CHARS);
  if (text) return text;
  const structured = result.structuredContent;
  return structured && typeof structured === 'object'
    ? JSON.stringify(structured, null, 2).slice(0, MAX_SEARCH_MCP_RESULT_CHARS)
    : '';
}

function looksLikeEmptyOrError(text: string): boolean {
  const clean = String(text || '').trim();
  if (!clean) return true;
  try {
    const parsed = JSON.parse(clean) as Record<string, unknown>;
    if (parsed.success === false || parsed.ok === false || Boolean(parsed.error)) return true;
    if (Array.isArray(parsed.results) && parsed.results.length === 0 && !parsed.answer) return true;
  } catch { /* plain text results are valid */ }
  return EMPTY_SEARCH_TEXT.test(clean);
}

function dangerousSearchArgument(key: string): boolean {
  const normalized = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
  return DANGEROUS_SEARCH_ARGUMENT.test(normalized);
}

export function chooseSearchTool(
  tools: Array<{ name: string; description?: string; inputSchema?: { type?: string; properties?: Record<string, { type?: string }>; required?: string[]; additionalProperties?: boolean } }>,
  preferred?: string,
): { name: string; argument: string } | undefined {
  const safeTool = (tool: typeof tools[number]): { name: string; argument: string } | undefined => {
    const properties = tool.inputSchema?.properties;
    if (!properties || tool.inputSchema?.type && tool.inputSchema.type !== 'object') return undefined;
    const propertyNames = Object.keys(properties);
    if (propertyNames.some(key => dangerousSearchArgument(key) || !SAFE_SEARCH_ARGUMENTS.has(key))) return undefined;
    const argument = SEARCH_QUERY_ARGUMENTS.find(key => properties[key]?.type === 'string');
    if (!argument) return undefined;
    const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
    if (required.some(key => key !== argument && !SAFE_SEARCH_ARGUMENTS.has(key))) return undefined;
    return { name: tool.name, argument };
  };
  if (preferred) {
    const exact = tools.find(tool => tool.name === preferred);
    if (exact && (SEARCH_TOOL_NAME.test(exact.name) || SEARCH_TOOL_DESCRIPTION.test(String(exact.description || '')))) {
      return safeTool(exact);
    }
  }
  for (const tool of tools) {
    if (!SEARCH_TOOL_NAME.test(tool.name) && !SEARCH_TOOL_DESCRIPTION.test(String(tool.description || ''))) continue;
    const selected = safeTool(tool);
    if (selected) return selected;
  }
  return undefined;
}

function writeSearchMcpHealthSnapshot(root: string, result: SearchMcpPoolResult, query: string): void {
  const target = path.join(root, SEARCH_MCP_HEALTH_FILE);
  const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const attempts = result.attempts.map(attempt => ({
    ...attempt,
    error: attempt.error ? cleanError(attempt.error, [root]) : undefined,
  }));
  const payload = JSON.stringify({
    version: 1,
    invocationId: result.invocationId,
    checkedAt: result.checkedAt,
    querySha256: createHash('sha256').update(query, 'utf8').digest('hex'),
    ok: result.ok,
    provider: result.provider || '',
    attempts,
  }, null, 2);
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

async function callRealEndpoint(endpoint: SearchMcpEndpoint, query: string, signal?: AbortSignal): Promise<string> {
  if (endpoint.transport === 'template') throw new Error('endpoint has no configured transport');
  const timeout = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, endpoint.timeoutMs || DEFAULT_TIMEOUT_MS));
  const requestInit = endpoint.headers ? { headers: endpoint.headers } : undefined;
  const transport = endpoint.transport === 'stdio'
    ? new StdioClientTransport({
        command: endpoint.command || '', args: endpoint.args || [], cwd: endpoint.cwd,
        env: { ...process.env, ...(endpoint.env || {}) } as Record<string, string>, stderr: 'pipe',
      })
    : endpoint.transport === 'sse'
      ? new SSEClientTransport(new URL(endpoint.url || ''), { requestInit })
      : new StreamableHTTPClientTransport(new URL(endpoint.url || ''), {
          requestInit,
          reconnectionOptions: { initialReconnectionDelay: 250, maxReconnectionDelay: 500, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
        });
  const client = new Client({ name: 'newmark-search-only', version: '0.5.13' }, { capabilities: {} });
  try {
    // Initialization is part of the endpoint probe and must obey the same
    // bounded timeout as tools/list and tools/call. Without request options a
    // launched-but-unresponsive MCP can hold the complete web_search fallback
    // chain at Client.connect() until the SDK's much longer default timeout.
    await client.connect(transport, { signal, timeout, maxTotalTimeout: timeout });
    const listed = await client.listTools(undefined, { signal, timeout, maxTotalTimeout: timeout });
    const selected = chooseSearchTool(listed.tools, endpoint.tool);
    if (!selected) throw new Error('server exposes no recognized search-only tool');
    const argument = endpoint.argument || selected.argument;
    if (!SEARCH_QUERY_ARGUMENTS.includes(argument)) throw new Error('configured MCP query argument is outside the search-only boundary');
    const selectedTool = listed.tools.find(tool => tool.name === selected.name);
    if (!selectedTool || chooseSearchTool([selectedTool], selected.name)?.argument !== argument) {
      throw new Error('configured MCP query argument does not match a declared string search field');
    }
    const result = await client.callTool({ name: selected.name, arguments: { [argument]: query } }, undefined, {
      signal, timeout, maxTotalTimeout: timeout,
    });
    if (result.isError === true) throw new Error(resultText(result as Record<string, unknown>) || 'MCP search returned isError');
    return resultText(result as Record<string, unknown>);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export class SearchMcpPool {
  private readonly callEndpoint: NonNullable<SearchMcpPoolDependencies['callEndpoint']>;
  private readonly now: () => number;

  constructor(private readonly root: string, dependencies: SearchMcpPoolDependencies = {}) {
    this.callEndpoint = dependencies.callEndpoint || callRealEndpoint;
    this.now = dependencies.now || Date.now;
  }

  manifest(): SearchMcpEndpoint[] {
    return loadSearchMcpManifest(this.root).map(endpoint => ({ ...endpoint }));
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchMcpPoolResult> {
    const invocationId = `search-${process.pid}-${this.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const checkedAt = new Date(this.now()).toISOString();
    const attempts: SearchMcpAttempt[] = [];
    const successes: Array<{ endpoint: SearchMcpEndpoint; text: string }> = [];
    for (const endpoint of this.manifest().filter(item => item.enabled)) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Agent run aborted');
      const started = this.now();
      if (endpoint.transport === 'template') {
        attempts.push({ id: endpoint.id, name: endpoint.name, status: 'unconfigured', durationMs: Math.max(0, this.now() - started) });
        continue;
      }
      try {
        const text = String(await this.callEndpoint(endpoint, query, signal) || '').trim().slice(0, MAX_SEARCH_MCP_RESULT_CHARS);
        const empty = looksLikeEmptyOrError(text);
        attempts.push({ id: endpoint.id, name: endpoint.name, status: empty ? 'empty' : 'success', durationMs: Math.max(0, this.now() - started) });
        if (!empty) successes.push({ endpoint, text });
      } catch (error) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
        attempts.push({ id: endpoint.id, name: endpoint.name, status: 'error', durationMs: Math.max(0, this.now() - started), error: cleanError(error, [this.root, endpoint.cwd || '']) });
      }
    }
    const selected = successes.sort((a, b) => a.endpoint.priority - b.endpoint.priority || a.endpoint.id.localeCompare(b.endpoint.id))[0];
    const result: SearchMcpPoolResult = selected
      ? { invocationId, checkedAt, ok: true, provider: selected.endpoint.name, text: selected.text, attempts }
      : { invocationId, checkedAt, ok: false, attempts };
    writeSearchMcpHealthSnapshot(this.root, result, query);
    return result;
  }
}
