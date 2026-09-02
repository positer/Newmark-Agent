import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  chooseSearchTool,
  DEFAULT_SEARCH_MCP_MANIFEST,
  MAX_SEARCH_MCP_RESULT_CHARS,
  publicSearchMcpManifest,
  redactSearchMcpLocalPaths,
  SearchMcpPool,
  SearchMcpPoolConfig,
} from '../core/searchMcpPool';
import { ConfigManager } from '../core/config';
import { ToolExecutor } from '../tools';

async function main(): Promise<void> {
  const names = DEFAULT_SEARCH_MCP_MANIFEST.map(endpoint => endpoint.name);
  for (const expected of [
    'Wuxing Search MCP',
    'web-search-api',
    'miyami-websearch-mcp',
    'searxng-mcp',
    'MCP Server FreeSearch',
    '@ignidor/web-search-mcp',
    'free-search-mcp',
    'DuckDuckGo MCP',
    'Free MCP Web Search Server',
  ]) assert.ok(names.includes(expected), `manifest exposes ${expected}`);
  assert.deepEqual(
    DEFAULT_SEARCH_MCP_MANIFEST.filter(endpoint => endpoint.enabled).map(endpoint => endpoint.name),
    ['@ignidor/web-search-mcp'],
    'only a candidate with a recorded initialize/tools-list/tools-call success is enabled by default',
  );
  assert.equal(
    DEFAULT_SEARCH_MCP_MANIFEST.filter(endpoint => endpoint.transport === 'stdio' && endpoint.command === process.execPath)
      .every(endpoint => endpoint.env?.ELECTRON_RUN_AS_NODE === '1'),
    true,
    'bundled stdio MCP nodes force packaged Electron to execute the server script as Node',
  );
  assert.deepEqual(
    chooseSearchTool([
      { name: 'filesystem_delete', description: 'Delete files', inputSchema: { properties: { path: {} } } },
      { name: 'lookup_online', description: 'Search the web for current sources', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
    ]),
    { name: 'lookup_online', argument: 'q' },
    'the compatibility layer discovers a search tool but never selects arbitrary MCP capabilities',
  );
  assert.equal(
    chooseSearchTool([
      { name: 'web_search', description: 'Search the public web', inputSchema: { type: 'object', properties: { query: { type: 'string' }, command: { type: 'string' } }, required: ['query'] } },
    ]),
    undefined,
    'a search-looking tool with command/file/script-style arguments is never callable',
  );
  assert.equal(
    chooseSearchTool([
      { name: 'web_search', description: 'Search the public web', inputSchema: { type: 'object', properties: { query: { type: 'string' }, requestBody: { type: 'string' }, filePath: { type: 'string' }, shellCommand: { type: 'string' } }, required: ['query'] } },
    ]),
    undefined,
    'camelCase request-body/file-path/shell-command fields remain outside the closed search-only allowlist',
  );
  assert.deepEqual(
    chooseSearchTool([
      { name: 'web_search', description: 'Search the public web', inputSchema: { type: 'object', properties: { searchQuery: { type: 'string' }, maxResults: { type: 'number' } }, required: ['searchQuery'] } },
    ]),
    { name: 'web_search', argument: 'searchQuery' },
    'documented safe camelCase search fields remain accepted',
  );
  assert.equal(
    chooseSearchTool([
      { name: 'web_search', description: 'Search the public web', inputSchema: { type: 'object', properties: { query: { type: 'object' } }, required: ['query'] } },
    ]),
    undefined,
    'the query field must be a declared string',
  );
  assert.equal(
    redactSearchMcpLocalPaths('at file:///C:/Users/developer/private/repo/index.js and /home/developer/cache/index.js; source https://example.test/result'),
    'at <local-path> and <local-path>; source https://example.test/result',
    'runtime diagnostics remove Windows/POSIX developer paths without corrupting HTTPS sources',
  );
  const defaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-search-mcp-default-'));
  try {
    const defaultPool = new SearchMcpPool(defaultRoot, {
      callEndpoint: async endpoint => `${endpoint.name}\nhttps://example.test/default`,
    });
    const defaultResult = await defaultPool.search('default manifest');
    assert.deepEqual(defaultResult.attempts.map(attempt => attempt.name), ['@ignidor/web-search-mcp']);
  } finally {
    fs.rmSync(defaultRoot, { recursive: true, force: true });
  }

  const fallbackBoundaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-search-mcp-fallback-boundary-'));
  const originalFetch = globalThis.fetch;
  try {
    fs.writeFileSync(path.join(fallbackBoundaryRoot, 'search-mcp.json'), JSON.stringify({ version: 1, endpoints: [] }), 'utf8');
    const fetchedUrls: string[] = [];
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (input: unknown) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown })?.url || input);
      fetchedUrls.push(url);
      if (url.startsWith('https://www.bing.com/search?')) {
        return new Response('<li class="b_algo"><h2><a href="https://example.test/bing">Bing fixture</a></h2><p>HTTP fallback fixture</p></li>');
      }
      return new Response('');
    }) as typeof fetch;

    const executor = new ToolExecutor(fallbackBoundaryRoot, new ConfigManager(fallbackBoundaryRoot));
    const mcpOnly = await executor.webSearchMcpOnly('fallback boundary');
    assert.equal(mcpOnly.ok, false, 'MCP-only execution returns a controlled miss when the MCP manifest has no runnable node');
    assert.equal(mcpOnly.provider, '');
    assert.equal(mcpOnly.text, '');
    assert.deepEqual(fetchedUrls, [], 'MCP-only execution never enters Bing or DuckDuckGo HTTP fallback');

    const complete = await executor.webSearchDetailed('fallback boundary');
    assert.equal(complete.ok, true);
    assert.equal(complete.provider, 'Bing HTTP', 'the complete web_search boundary still falls back to Bing after MCP exhaustion');
    assert.deepEqual(fetchedUrls.map(url => new URL(url).hostname), ['www.bing.com']);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(fallbackBoundaryRoot, { recursive: true, force: true });
  }

  const sourceRoot = path.resolve(__dirname, fs.existsSync(path.join(__dirname, '../../src/server.ts')) ? '../..' : '..');
  const repositoryRoot = path.resolve(sourceRoot, '..');
  const poolSource = fs.readFileSync(path.join(sourceRoot, 'src/core/searchMcpPool.ts'), 'utf8');
  assert.ok(
    poolSource.includes('client.connect(transport, { signal, timeout, maxTotalTimeout: timeout })'),
    'MCP initialize/connect shares the endpoint timeout so an unresponsive node cannot block HTTP fallbacks',
  );
  const serverSource = fs.readFileSync(path.join(sourceRoot, 'src/server.ts'), 'utf8');
  const mobileMcpRoute = serverSource
    .split("case '/api/mobile/web-search-mcp':", 2)[1]
    ?.split("case '/api/mobile/search-mcp-manifest':", 1)[0] || '';
  assert.ok(serverSource.includes("pathname.startsWith('/api/mobile/')"), 'all mobile routes remain behind the shared token authorization boundary');
  assert.ok(mobileMcpRoute.includes('agent.tools.webSearchMcpOnly(query)'), 'the authenticated mobile MCP route calls only the MCP pool');
  assert.equal(mobileMcpRoute.includes('agent.tools.webSearchDetailed(query)'), false, 'the mobile MCP route cannot invoke PC HTTP fallbacks');

  const mobileApiSource = fs.readFileSync(path.join(repositoryRoot, 'android/app/src/main/java/com/newmark/mobile/data/MobileApiClient.kt'), 'utf8');
  const mobilePoolSource = fs.readFileSync(path.join(repositoryRoot, 'android/app/src/main/java/com/newmark/mobile/data/MobileSearchMcp.kt'), 'utf8');
  assert.ok(mobileApiSource.includes('privatePost(pair, "/api/mobile/web-search-mcp"'), 'Android sends the desktop bridge query through the bearer-authenticated MCP-only endpoint');
  assert.ok(mobilePoolSource.includes('mobileApi.webSearchMcp(pair, query)'), 'Android desktop bridge calls the MCP-only client method');
  assert.equal(mobilePoolSource.includes('mobileApi.webSearch(pair, query)'), false, 'Android desktop bridge no longer calls the PC full-fallback route');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-search-mcp-'));
  try {
    const config: SearchMcpPoolConfig = {
      version: 1,
      endpoints: [
        { id: 'disabled', name: 'Disabled', enabled: false, priority: 0, transport: 'template' },
        { id: 'empty', name: 'Empty', enabled: true, priority: 10, transport: 'stdio', command: 'fixture' },
        { id: 'error', name: 'Error', enabled: true, priority: 20, transport: 'stdio', command: 'fixture' },
        { id: 'success', name: 'Success', enabled: true, priority: 30, transport: 'stdio', command: 'fixture' },
        { id: 'later', name: 'Later', enabled: true, priority: 40, transport: 'stdio', command: 'fixture' },
        { id: 'large', name: 'Large', enabled: true, priority: 50, transport: 'stdio', command: 'fixture', cwd: 'C:\\Users\\developer\\private' },
      ],
    };
    config.endpoints[1].headers = { Authorization: 'Bearer fixture-secret' };
    fs.writeFileSync(path.join(root, 'search-mcp.json'), JSON.stringify(config), 'utf8');
    const publicManifest = JSON.stringify(publicSearchMcpManifest(root));
    assert.equal(publicManifest.includes('fixture-secret'), false, 'public manifest exposes header names separately, never header values');
    for (const privateField of ['"command"', '"args"', '"cwd"']) {
      assert.equal(publicManifest.includes(privateField), false, `public manifest excludes ${privateField}`);
    }
    const calls: string[] = [];
    const pool = new SearchMcpPool(root, {
      callEndpoint: async endpoint => {
        calls.push(endpoint.id);
        if (endpoint.id === 'empty') return '';
        if (endpoint.id === 'error') throw new Error('fixture failed at C:\\Users\\developer\\private\\server.js and /home/developer/cache/server.js');
        if (endpoint.id === 'success') return 'Search result\nhttps://example.test/result\nA useful snippet';
        if (endpoint.id === 'large') return 'x'.repeat(MAX_SEARCH_MCP_RESULT_CHARS + 2_000);
        return 'later result';
      },
    });

    const first = await pool.search('newmark search');
    assert.equal(first.ok, true);
    assert.ok(first.invocationId && first.checkedAt, 'health attempts are scoped and timestamped for this invocation');
    assert.equal(first.provider, 'Success');
    assert.deepEqual(calls, ['empty', 'error', 'success', 'later', 'large'], 'every enabled endpoint is polled once, even after a success');
    assert.deepEqual(first.attempts.map(attempt => attempt.status), ['empty', 'error', 'success', 'success', 'success']);
    assert.equal(first.attempts[1].error?.includes('developer'), false, 'per-call errors never retain a local username/path');
    const firstHealth = JSON.parse(fs.readFileSync(path.join(root, 'search-mcp-health.json'), 'utf8')) as { invocationId?: string; checkedAt?: string; querySha256?: string; attempts?: unknown[]; text?: unknown };
    assert.equal(firstHealth.invocationId, first.invocationId, 'health file is an atomic snapshot of this invocation');
    assert.equal(firstHealth.checkedAt, first.checkedAt);
    assert.equal(Array.isArray(firstHealth.attempts), true);
    assert.equal(firstHealth.querySha256?.length, 64, 'health observation stores only a deterministic query hash');
    assert.equal(JSON.stringify(firstHealth).includes('newmark search'), false, 'health observation never stores the raw query');
    assert.equal('text' in firstHealth, false, 'health observation never persists search result content');

    calls.length = 0;
    const second = await pool.search('newmark search again');
    assert.notEqual(second.invocationId, first.invocationId, 'health state is recomputed for each invocation');
    assert.deepEqual(calls, ['empty', 'error', 'success', 'later', 'large'], 'a new web_search re-polls the complete enabled pool; failures are not circuit-broken across calls');
    const secondHealth = JSON.parse(fs.readFileSync(path.join(root, 'search-mcp-health.json'), 'utf8')) as { invocationId?: string };
    assert.equal(secondHealth.invocationId, second.invocationId, 'each invocation replaces the previous health snapshot');
    assert.notEqual(secondHealth.invocationId, firstHealth.invocationId, 'old health is never reused as a circuit breaker');

    const largeOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-search-mcp-large-'));
    try {
      fs.writeFileSync(path.join(largeOnlyRoot, 'search-mcp.json'), JSON.stringify({
        version: 1,
        endpoints: [{ id: 'large', name: 'Large', enabled: true, priority: 1, transport: 'stdio', command: 'fixture' }],
      }), 'utf8');
      const largeOnly = await new SearchMcpPool(largeOnlyRoot, { callEndpoint: async () => 'x'.repeat(MAX_SEARCH_MCP_RESULT_CHARS + 2_000) }).search('large');
      assert.equal(largeOnly.text?.length, MAX_SEARCH_MCP_RESULT_CHARS, 'MCP output is bounded before entering tool/model context');
    } finally {
      fs.rmSync(largeOnlyRoot, { recursive: true, force: true });
    }

    const fallbackCalls: string[] = [];
    const failing = new SearchMcpPool(root, {
      callEndpoint: async endpoint => {
        fallbackCalls.push(endpoint.id);
        throw new Error('all unavailable');
      },
    });
    const failed = await failing.search('fallback');
    assert.equal(failed.ok, false, 'MCP pool returns a controlled miss so the caller can use DuckDuckGo/Bing HTTP fallback');
    assert.deepEqual(fallbackCalls, ['empty', 'error', 'success', 'later', 'large']);

    const noResultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-search-mcp-no-results-'));
    try {
      const outputs = new Map<string, string>([
        ['no-results', 'No results found for "newmark". Try a different query.'],
        ['zero-results', '0 results returned for newmark.'],
        ['nothing-found', 'Nothing found for that request.'],
        ['zh-not-found', '未找到结果，请更换关键词。'],
        ['zh-no-search', '无搜索结果。'],
        ['json-ok-false', '{"ok":false,"error":"upstream unavailable"}'],
        ['valid-context', 'Result note: a provider may say "No results found"; evidence: https://example.test/result'],
      ]);
      fs.writeFileSync(path.join(noResultRoot, 'search-mcp.json'), JSON.stringify({
        version: 1,
        endpoints: [...outputs.keys()].map((id, index) => ({
          id, name: id, enabled: true, priority: index, transport: 'stdio', command: 'fixture',
        })),
      }), 'utf8');
      const noResultPool = new SearchMcpPool(noResultRoot, {
        callEndpoint: async endpoint => outputs.get(endpoint.id) || '',
      });
      const noResultResult = await noResultPool.search('no-result admission');
      assert.equal(noResultResult.provider, 'valid-context', 'anchored no-result receipts fall through while valid prose mentioning the phrase remains usable');
      assert.deepEqual(
        noResultResult.attempts.map(attempt => attempt.status),
        ['empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'success'],
      );
    } finally {
      fs.rmSync(noResultRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Search MCP pool verification passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
