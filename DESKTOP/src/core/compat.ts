import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type ToolSource = 'builtin' | 'mcp' | 'codex-plugin' | 'claude-plugin' | 'opencode-plugin' | 'local';
export type ToolSideEffect = 'none' | 'read' | 'write' | 'network' | 'destructive';
export type PluginTrustLevel = 'metadata-only' | 'explicit-execution' | 'trusted';
export type PluginComponentKind =
  | 'skills'
  | 'agents'
  | 'tools'
  | 'hooks'
  | 'mcpServers'
  | 'lspServers'
  | 'monitors'
  | 'commands'
  | 'themes'
  | 'outputStyles'
  | 'dependencies'
  | 'config';

export interface NewmarkToolDefinition {
  name: string;
  namespace?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  source: ToolSource;
  sideEffects?: ToolSideEffect;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    requiresApproval?: boolean;
  };
}

export interface NewmarkToolResult {
  ok: boolean;
  output: string;
  data?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface NewmarkPluginManifest {
  id: string;
  ecosystem: 'newmark' | 'codex' | 'claude-code' | 'opencode';
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  root: string;
  enabled: boolean;
  trustLevel?: PluginTrustLevel;
  components: {
    skills?: string[];
    agents?: string[];
    tools?: string[];
    hooks?: string[];
    mcpServers?: string[];
    lspServers?: string[];
    monitors?: string[];
    commands?: string[];
    themes?: string[];
    outputStyles?: string[];
    dependencies?: string[];
    config?: string[];
  };
  warnings?: string[];
  rawManifest?: unknown;
}

export interface NewmarkPluginMarketplaceEntry {
  marketplace: string;
  marketplacePath: string;
  name: string;
  displayName?: string;
  description?: string;
  category?: string;
  ecosystem: 'codex' | 'claude-code' | 'newmark';
  sourceType: string;
  sourcePath?: string;
  sourceUrl?: string;
  version?: string;
  policy?: {
    installation?: string;
    authentication?: string;
  };
  installed: boolean;
  installPath?: string;
  rawEntry?: unknown;
}

export interface NewmarkAgentPreset {
  id: string;
  ecosystem: 'codex' | 'claude-code' | 'opencode' | 'newmark';
  name: string;
  description: string;
  path: string;
  model?: string;
  instructions?: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  mode?: string;
  inputMode?: string;
  maxTurns?: number;
  isolation?: string;
  rawMetadata?: Record<string, unknown>;
}

export interface OpenCodeToolMetadata {
  name: string;
  path: string;
  executable: boolean;
  reason?: string;
  source?: 'project' | 'user';
  exportStyle?: 'function' | 'execute-object' | 'metadata-only' | 'unknown';
}

type LegacyFunctionTool = {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

function readJson(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readJsonLoose(filePath: string): unknown | null {
  try {
    const withoutBom = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    const withoutComments = withoutBom
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    return JSON.parse(withoutComments);
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>);
  return [];
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function inferSideEffects(name: string): ToolSideEffect {
  if (['pwd', 'read', 'glob', 'grep', 'web_search', 'web_fetch', 'browser_snapshot', 'git_status', 'file_audit', 'automation_list', 'flow_list', 'subagent_result'].includes(name)) return 'read';
  if (['write', 'edit', 'flow_save', 'automation_create', 'automation_update', 'automation_toggle', 'automation_delete', 'subagent_close'].includes(name)) return 'write';
  if (['git_push', 'git_clone', 'git_branch', 'gh_fork', 'gh_pr_create'].includes(name)) return 'destructive';
  if (name.startsWith('browser_') || name.startsWith('gh_')) return 'network';
  return 'none';
}

export function legacyToolToNewmark(def: unknown, source: ToolSource = 'builtin'): NewmarkToolDefinition | null {
  const legacy = def as LegacyFunctionTool;
  const fn = legacy?.function;
  const name = String(fn?.name || '').trim();
  if (!name) return null;
  const sideEffects = inferSideEffects(name);
  return {
    name,
    description: String(fn?.description || ''),
    inputSchema: fn?.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {}, required: [] },
    source,
    sideEffects,
    annotations: {
      readOnly: sideEffects === 'none' || sideEffects === 'read',
      destructive: sideEffects === 'destructive',
      requiresApproval: sideEffects === 'destructive',
    },
  };
}

export function emitOpenAIChatTool(def: NewmarkToolDefinition): unknown {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.inputSchema,
    },
  };
}

export function emitOpenAIResponsesTool(def: NewmarkToolDefinition): unknown {
  return {
    type: 'function',
    name: def.name,
    description: def.description,
    parameters: def.inputSchema,
  };
}

export function emitAnthropicTool(def: NewmarkToolDefinition): unknown {
  return {
    name: def.name,
    description: def.description,
    input_schema: def.inputSchema,
  };
}

export function normalizeToolResult(output: string, metadata?: Record<string, unknown>): NewmarkToolResult {
  const error = /^\[[^\]]+(?: error|)\]/i.test(output) && !/\bOK\b/i.test(output)
    ? output.split(/\r?\n/)[0]
    : undefined;
  return { ok: !error, output, error, metadata };
}

export function toolResultToText(result: NewmarkToolResult): string {
  if (result.output) return result.output;
  if (result.error) return `[tool error] ${result.error}`;
  return result.ok ? '[tool] OK' : '[tool] Failed';
}

function componentPaths(root: string, value: unknown): string[] {
  return asStringArray(value).map(item => path.resolve(root, item));
}

function manifestComponentPaths(root: string, manifest: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    if (manifest[key] !== undefined) return componentPaths(root, manifest[key]);
  }
  return [];
}

function discoverComponentFiles(root: string, relativeDirs: string[], extension: RegExp, maxDepth = 2): string[] {
  const files: string[] = [];
  for (const dir of relativeDirs) {
    files.push(...listFilesRecursive(path.join(root, dir), extension, maxDepth));
  }
  return Array.from(new Set(files)).sort();
}

function normalizeMcpServers(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item;
      const record = nestedRecord(item);
      return asString(record.name || record.id || record.command);
    }).filter(Boolean);
  }
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>);
  return [];
}

function collectMcpServers(...values: unknown[]): string[] {
  const servers: string[] = [];
  for (const value of values) servers.push(...normalizeMcpServers(value));
  return Array.from(new Set(servers)).sort();
}

function defaultComponentWarnings(kind: string, components: string[]): string[] {
  const warnings: string[] = [];
  for (const item of components) {
    if (path.isAbsolute(item) && !fs.existsSync(item)) warnings.push(`${kind} path does not exist: ${item}`);
  }
  return warnings;
}

function normalizeCodexPlugin(root: string, manifest: Record<string, unknown>): NewmarkPluginManifest {
  const name = asString(manifest.name) || path.basename(root);
  const components = {
    skills: manifestComponentPaths(root, manifest, 'skills'),
    agents: manifestComponentPaths(root, manifest, 'agents'),
    tools: manifestComponentPaths(root, manifest, 'tools'),
    hooks: manifestComponentPaths(root, manifest, 'hooks'),
    mcpServers: collectMcpServers(manifest.mcp_servers, manifest.mcpServers),
    commands: manifestComponentPaths(root, manifest, 'commands', 'slashCommands', 'slash_commands'),
    config: manifestComponentPaths(root, manifest, 'config'),
  };
  return {
    id: `codex:${name}`,
    ecosystem: 'codex',
    name,
    version: asString(manifest.version),
    description: asString(manifest.description),
    displayName: asString((manifest.interface as Record<string, unknown> | undefined)?.displayName),
    root,
    enabled: true,
    trustLevel: 'metadata-only',
    components,
    warnings: [
      ...defaultComponentWarnings('Codex skill', components.skills || []),
      ...defaultComponentWarnings('Codex agent', components.agents || []),
      ...(components.hooks?.length ? ['Codex plugin hooks are discovered as metadata only until a trust policy enables execution.'] : []),
      ...(components.mcpServers?.length ? ['Codex plugin MCP servers are discovered but not auto-started.'] : []),
    ],
    rawManifest: manifest,
  };
}

function normalizeClaudePlugin(root: string, manifest: Record<string, unknown>): NewmarkPluginManifest {
  const name = asString(manifest.name) || path.basename(root);
  const experimental = nestedRecord(manifest.experimental);
  const components = {
    skills: manifestComponentPaths(root, manifest, 'skills'),
    agents: manifestComponentPaths(root, manifest, 'agents'),
    tools: manifestComponentPaths(root, manifest, 'tools', 'commands'),
    hooks: manifestComponentPaths(root, manifest, 'hooks'),
    mcpServers: collectMcpServers(manifest.mcpServers, manifest.mcp_servers),
    lspServers: collectMcpServers(manifest.lspServers, manifest.lsp_servers),
    monitors: componentPaths(root, experimental.monitors),
    commands: manifestComponentPaths(root, manifest, 'commands'),
    themes: manifestComponentPaths(root, manifest, 'themes'),
    outputStyles: manifestComponentPaths(root, manifest, 'outputStyles', 'output_styles'),
    dependencies: asStringArray(manifest.dependencies),
    config: manifestComponentPaths(root, manifest, 'config', 'userConfig', 'user_config'),
  };
  return {
    id: `claude-code:${name}`,
    ecosystem: 'claude-code',
    name,
    version: asString(manifest.version),
    description: asString(manifest.description),
    displayName: asString(manifest.displayName || manifest.display_name),
    root,
    enabled: true,
    trustLevel: 'metadata-only',
    components,
    warnings: [
      ...defaultComponentWarnings('Claude skill', components.skills || []),
      ...defaultComponentWarnings('Claude agent', components.agents || []),
      ...(components.hooks?.length ? ['Claude Code hooks are discovered as metadata only until a trust policy enables execution.'] : []),
      ...(components.mcpServers?.length ? ['Claude Code MCP servers are discovered but not auto-started.'] : []),
      ...(components.lspServers?.length ? ['Claude Code LSP servers are discovered but not auto-started.'] : []),
    ],
    rawManifest: manifest,
  };
}

function normalizeNewmarkPlugin(root: string, manifest: Record<string, unknown>): NewmarkPluginManifest {
  const name = asString(manifest.name) || path.basename(root);
  return {
    id: `newmark:${name}`,
    ecosystem: 'newmark',
    name,
    version: asString(manifest.version),
    description: asString(manifest.description),
    displayName: asString(manifest.displayName || manifest.display_name),
    root,
    enabled: manifest.enabled !== false,
    trustLevel: manifest.trusted === true ? 'trusted' : 'metadata-only',
    components: {
      skills: manifestComponentPaths(root, manifest, 'skills'),
      agents: manifestComponentPaths(root, manifest, 'agents'),
      tools: manifestComponentPaths(root, manifest, 'tools'),
      hooks: manifestComponentPaths(root, manifest, 'hooks'),
      mcpServers: collectMcpServers(manifest.mcpServers, manifest.mcp_servers),
      config: manifestComponentPaths(root, manifest, 'config'),
    },
    rawManifest: manifest,
  };
}

function findPluginRoots(root: string, maxDepth = 5): string[] {
  const found = new Set<string>();
  const skip = new Set(['.git', 'node_modules', 'dist', 'release', 'release-icon-verify', 'release-icon-verify-2']);
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.isDirectory() && (e.name === '.codex-plugin' || e.name === '.claude-plugin' || e.name === '.newmark-plugin'))) {
      found.add(dir);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name) || entry.name.startsWith('release.locked-')) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return Array.from(found).sort();
}

export function discoverPluginManifests(root: string): NewmarkPluginManifest[] {
  const manifests: NewmarkPluginManifest[] = [];
  for (const pluginRoot of findPluginRoots(root)) {
    const codexPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const claudePath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    const newmarkPath = path.join(pluginRoot, '.newmark-plugin', 'plugin.json');
    const codex = fs.existsSync(codexPath) ? readJson(codexPath) : null;
    const claude = fs.existsSync(claudePath) ? readJson(claudePath) : null;
    const newmark = fs.existsSync(newmarkPath) ? readJson(newmarkPath) : null;
    if (codex && typeof codex === 'object') manifests.push(normalizeCodexPlugin(pluginRoot, codex as Record<string, unknown>));
    if (claude && typeof claude === 'object') manifests.push(normalizeClaudePlugin(pluginRoot, claude as Record<string, unknown>));
    if (newmark && typeof newmark === 'object') manifests.push(normalizeNewmarkPlugin(pluginRoot, newmark as Record<string, unknown>));
  }

  const projectOpencode = readOpenCodeManifest(root, 'project');
  if (projectOpencode) manifests.push(projectOpencode);
  const userOpenCodeRoot = path.join(os.homedir(), '.config', 'opencode');
  if (path.resolve(userOpenCodeRoot) !== path.resolve(path.join(root, '.opencode'))) {
    const userOpenCode = readOpenCodeManifest(userOpenCodeRoot, 'user');
    if (userOpenCode) manifests.push(userOpenCode);
  }
  return dedupeManifests(manifests);
}

function readOpenCodeConfig(root: string): { path: string; value: unknown } | null {
  const candidates = [
    path.join(root, 'opencode.json'),
    path.join(root, 'opencode.jsonc'),
    path.join(root, '.opencode', 'opencode.json'),
    path.join(root, '.opencode', 'opencode.jsonc'),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) return { path: filePath, value: readJsonLoose(filePath) };
  }
  return null;
}

function readOpenCodeManifest(root: string, scope: 'project' | 'user'): NewmarkPluginManifest | null {
  const localRoot = scope === 'project' ? path.join(root, '.opencode') : root;
  const opencodeToolsDir = path.join(localRoot, 'tools');
  const opencodePluginsDir = path.join(localRoot, 'plugins');
  const tools = listCodeFiles(opencodeToolsDir);
  const pluginFiles = listCodeFiles(opencodePluginsDir);
  const config = readOpenCodeConfig(root);
  const configRecord = nestedRecord(config?.value);
  const configPlugins = asStringArray(configRecord.plugin || configRecord.plugins);
  const mcpServers = collectMcpServers(configRecord.mcp, configRecord.mcpServers, configRecord.mcp_servers);
  const agents = discoverComponentFiles(localRoot, ['agents'], /\.md$/i, 1);
  const instructions = discoverOpenCodeInstructionFiles(root, localRoot);
  const permissions = asStringArray(configRecord.permission || configRecord.permissions);
  const disabledTools = asStringArray(configRecord.disabledTools || configRecord.disabled_tools);
  if (tools.length || pluginFiles.length || configPlugins.length || mcpServers.length || agents.length || instructions.length || config) {
    return {
      id: scope === 'project' ? 'opencode:project' : 'opencode:user',
      ecosystem: 'opencode',
      name: scope === 'project' ? 'project-opencode' : 'user-opencode',
      description: 'OpenCode-compatible local plugin, MCP, and custom tool metadata.',
      root: localRoot,
      enabled: true,
      trustLevel: 'explicit-execution',
      components: {
        tools,
        hooks: pluginFiles,
        agents,
        mcpServers,
        dependencies: configPlugins,
        config: [...(config ? [config.path] : []), ...instructions],
      },
      warnings: [
        ...(pluginFiles.length ? ['OpenCode plugin hooks are discovered as metadata only until a trust policy enables hook execution.'] : []),
        ...(mcpServers.length ? ['OpenCode MCP servers are discovered but not auto-started.'] : []),
        ...(configPlugins.length ? ['OpenCode npm/package plugins are listed as dependencies only; Newmark does not install or execute them automatically.'] : []),
        ...(permissions.length || disabledTools.length ? ['OpenCode permissions are exposed as metadata for policy planning; they are not automatically applied to Newmark tools.'] : []),
      ],
      rawManifest: config?.value || { plugin: configPlugins, mcp: mcpServers, agents, instructions },
    };
  }
  return null;
}

function discoverOpenCodeInstructionFiles(projectRoot: string, localRoot: string): string[] {
  const candidates = [
    path.join(projectRoot, 'AGENTS.md'),
    path.join(projectRoot, '.opencode', 'instructions.md'),
    path.join(projectRoot, '.opencode', 'AGENTS.md'),
    path.join(localRoot, 'instructions.md'),
    path.join(localRoot, 'AGENTS.md'),
  ];
  return Array.from(new Set(candidates.filter(filePath => fs.existsSync(filePath)))).sort();
}

function marketplacePaths(root: string): Array<{ ecosystem: NewmarkPluginMarketplaceEntry['ecosystem']; filePath: string }> {
  return [
    { ecosystem: 'codex', filePath: path.join(root, '.agents', 'plugins', 'marketplace.json') },
    { ecosystem: 'claude-code', filePath: path.join(root, '.claude-plugin', 'marketplace.json') },
    { ecosystem: 'newmark', filePath: path.join(root, '.newmark-plugin', 'marketplace.json') },
    { ecosystem: 'codex', filePath: path.join(os.homedir(), '.agents', 'plugins', 'marketplace.json') },
  ];
}

function marketplaceName(filePath: string, parsed: Record<string, unknown>): string {
  return asString(parsed.name || parsed.id) || path.basename(path.dirname(filePath)) || 'marketplace';
}

function normalizeMarketplaceEntry(
  root: string,
  marketplacePath: string,
  ecosystem: NewmarkPluginMarketplaceEntry['ecosystem'],
  marketplace: string,
  raw: unknown
): NewmarkPluginMarketplaceEntry | null {
  const entry = nestedRecord(raw);
  const name = asString(entry.name || entry.id);
  if (!name) return null;
  const source = nestedRecord(entry.source);
  const sourceType = asString(source.source || source.type || entry.sourceType || entry.source_type) || 'unknown';
  const sourcePathRaw = asString(source.path || entry.path);
  const sourceUrl = asString(source.url || source.git || entry.url);
  const base = path.dirname(marketplacePath);
  const sourcePath = sourcePathRaw ? path.resolve(base, sourcePathRaw) : undefined;
  const policy = nestedRecord(entry.policy);
  const installPath = sourceType === 'local' && sourcePath ? sourcePath : undefined;
  return {
    marketplace,
    marketplacePath,
    name,
    displayName: asString(entry.displayName || entry.display_name || entry.title),
    description: asString(entry.description),
    category: asString(entry.category),
    ecosystem,
    sourceType,
    sourcePath,
    sourceUrl,
    version: asString(entry.version || source.version || source.ref),
    policy: Object.keys(policy).length ? {
      installation: asString(policy.installation),
      authentication: asString(policy.authentication),
    } : undefined,
    installed: !!(installPath && fs.existsSync(path.join(installPath, '.codex-plugin', 'plugin.json'))),
    installPath,
    rawEntry: raw,
  };
}

export function discoverPluginMarketplaces(root: string): NewmarkPluginMarketplaceEntry[] {
  const entries: NewmarkPluginMarketplaceEntry[] = [];
  for (const { ecosystem, filePath } of marketplacePaths(root)) {
    if (!fs.existsSync(filePath)) continue;
    const parsed = readJsonLoose(filePath);
    const catalog = nestedRecord(parsed);
    const marketplace = marketplaceName(filePath, catalog);
    const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
    for (const raw of plugins) {
      const entry = normalizeMarketplaceEntry(root, filePath, ecosystem, marketplace, raw);
      if (entry) entries.push(entry);
    }
  }
  const seen = new Set<string>();
  return entries.filter(entry => {
    const key = `${entry.marketplacePath}:${entry.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeManifests(manifests: NewmarkPluginManifest[]): NewmarkPluginManifest[] {
  const seen = new Set<string>();
  return manifests.filter(item => {
    const key = `${item.id}:${path.resolve(item.root)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function listCodeFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && /\.(?:c?js|mjs|ts)$/.test(e.name))
      .map(e => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

export function discoverOpenCodeTools(root: string): OpenCodeToolMetadata[] {
  const candidates: Array<{ filePath: string; source: 'project' | 'user' }> = [
    ...listCodeFiles(path.join(root, '.opencode', 'tools')).map(filePath => ({ filePath, source: 'project' as const })),
    ...listCodeFiles(path.join(os.homedir(), '.config', 'opencode', 'tools')).map(filePath => ({ filePath, source: 'user' as const })),
  ];
  const seen = new Set<string>();
  return candidates.filter(({ filePath }) => {
    const key = path.resolve(filePath);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ filePath, source }) => {
    const ext = path.extname(filePath).toLowerCase();
    return {
      name: path.basename(filePath).replace(/\.(?:c?js|mjs|ts)$/i, ''),
      path: filePath,
      executable: ['.js', '.cjs', '.mjs'].includes(ext),
      reason: ext === '.ts' ? 'TypeScript OpenCode tools are discoverable but not executed without a transpilation step.' : undefined,
      source,
      exportStyle: ext === '.ts' ? 'metadata-only' : 'unknown',
    };
  });
}

export async function runOpenCodeTool(root: string, name: string, args: Record<string, unknown>): Promise<NewmarkToolResult> {
  const tool = discoverOpenCodeTools(root).find(item => item.name === name || path.basename(item.path) === name);
  if (!tool) return { ok: false, output: `[opencode_tool] Not found: ${name}`, error: `Not found: ${name}` };
  if (!tool.executable) return { ok: false, output: `[opencode_tool] ${tool.reason || 'Tool is not executable.'}`, error: tool.reason || 'Tool is not executable.', metadata: { tool } };
  try {
    const loaded = await import(pathToFileUrl(tool.path));
    const candidate = loaded.default || loaded.tool || loaded.execute || loaded;
    const registryCandidate = typeof loaded.tool === 'function' && !loaded.default
      ? loaded.tool
      : null;
    const execute = typeof candidate === 'function'
      ? candidate
      : candidate && typeof candidate.execute === 'function'
        ? candidate.execute.bind(candidate)
        : registryCandidate;
    if (!execute) {
      return { ok: false, output: `[opencode_tool] ${tool.name} does not export a function or execute(args).`, error: 'Missing execute export', metadata: { tool } };
    }
    const value = await execute(args);
    const output = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return { ok: true, output, data: value, metadata: { tool } };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, output: `[opencode_tool] ${message}`, error: message, metadata: { tool } };
  }
}

function pathToFileUrl(filePath: string): string {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');
  const prefix = resolved.startsWith('/') ? 'file://' : 'file:///';
  return prefix + resolved.replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function parseFrontmatterMarkdown(filePath: string): { metadata: Record<string, unknown>; body: string } {
  try {
    const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    const match = content.match(/^---\s*([\s\S]*?)\s*---\s*/);
    if (!match) return { metadata: {}, body: content };
    const metadata: Record<string, unknown> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const parsed = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
      if (!parsed) continue;
      const key = parsed[1];
      const raw = parsed[2].trim();
      metadata[key] = parseMetadataValue(raw);
    }
    return { metadata, body: content.slice(match[0].length).trim() };
  } catch {
    return { metadata: {}, body: '' };
  }
}

function parseMetadataValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1)
      .split(',')
      .map(v => v.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed.replace(/^["']|["']$/g, '');
}

function parseSimpleToml(filePath: string): Record<string, unknown> {
  try {
    const metadata: Record<string, unknown> = {};
    const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    const multiline: { key: string; lines: string[] } | null = null;
    if (multiline) return metadata;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#') || line.startsWith('[')) continue;
      const multi = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"""(.*)$/);
      if (multi) {
        const key = multi[1];
        const values = [multi[2]];
        while (i + 1 < lines.length) {
          i += 1;
          const next = lines[i];
          const end = next.indexOf('"""');
          if (end >= 0) {
            values.push(next.slice(0, end));
            break;
          }
          values.push(next);
        }
        metadata[key] = values.join('\n').trim();
        continue;
      }
      const parsed = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
      if (!parsed) continue;
      metadata[parsed[1]] = parseMetadataValue(parsed[2]);
    }
    return metadata;
  } catch {
    return {};
  }
}

function agentPresetFromMetadata(filePath: string, ecosystem: NewmarkAgentPreset['ecosystem'], metadata: Record<string, unknown>, body = ''): NewmarkAgentPreset | null {
  const name = asString(metadata.name) || path.basename(filePath).replace(/\.(?:toml|md)$/i, '');
  const description = asString(metadata.description);
  const instructions = asString(metadata.developer_instructions || metadata.instructions || metadata.prompt) || body.trim();
  if (!name || !description) return null;
  return {
    id: `${ecosystem}:${name}`,
    ecosystem,
    name,
    description,
    path: filePath,
    model: asString(metadata.model),
    instructions,
    tools: asStringArray(metadata.tools),
    disallowedTools: asStringArray(metadata.disallowedTools || metadata.disallowed_tools),
    skills: asStringArray(metadata.skills),
    mode: asString(metadata.mode),
    inputMode: asString(metadata.inputMode || metadata.input_mode),
    maxTurns: typeof metadata.maxTurns === 'number' ? metadata.maxTurns : typeof metadata.max_turns === 'number' ? metadata.max_turns : undefined,
    isolation: asString(metadata.isolation),
    rawMetadata: metadata,
  };
}

function listFilesRecursive(root: string, extension: RegExp, maxDepth = 4): string[] {
  const results: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && extension.test(entry.name)) results.push(full);
      if (entry.isDirectory() && !entry.name.startsWith('.git') && entry.name !== 'node_modules') walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return results.sort();
}

export function discoverAgentPresets(root: string): NewmarkAgentPreset[] {
  const presets: NewmarkAgentPreset[] = [];
  const codexDirs = [
    path.join(root, '.codex', 'agents'),
    path.join(root, '.agents', 'agents'),
    path.join(os.homedir(), '.codex', 'agents'),
    path.join(os.homedir(), '.agents', 'agents'),
  ];
  for (const dir of codexDirs) {
    for (const filePath of listFilesRecursive(dir, /\.toml$/i, 1)) {
      const preset = agentPresetFromMetadata(filePath, 'codex', parseSimpleToml(filePath));
      if (preset) presets.push(preset);
    }
  }
  const claudeDirs = [
    path.join(root, '.claude', 'agents'),
    path.join(os.homedir(), '.claude', 'agents'),
    path.join(os.homedir(), '.config', 'opencode', 'agents'),
  ];
  for (const dir of claudeDirs) {
    for (const filePath of listFilesRecursive(dir, /\.md$/i, 1)) {
      const parsed = parseFrontmatterMarkdown(filePath);
      const ecosystem = filePath.includes(`${path.sep}.config${path.sep}opencode${path.sep}`) ? 'opencode' : 'claude-code';
      const preset = agentPresetFromMetadata(filePath, ecosystem, parsed.metadata, parsed.body);
      if (preset) presets.push(preset);
    }
  }
  for (const plugin of discoverPluginManifests(root)) {
    for (const agentDir of plugin.components.agents || []) {
      for (const filePath of listFilesRecursive(agentDir, /\.(?:toml|md)$/i, 2)) {
        const ecosystem = plugin.ecosystem === 'codex' ? 'codex' : plugin.ecosystem === 'claude-code' ? 'claude-code' : plugin.ecosystem === 'opencode' ? 'opencode' : 'newmark';
        const parsed = filePath.endsWith('.toml')
          ? { metadata: parseSimpleToml(filePath), body: '' }
          : parseFrontmatterMarkdown(filePath);
        const preset = agentPresetFromMetadata(filePath, ecosystem, parsed.metadata, parsed.body);
        if (preset) presets.push(preset);
      }
    }
  }
  for (const filePath of discoverComponentFiles(root, ['.opencode/agents'], /\.md$/i, 1)) {
    const parsed = parseFrontmatterMarkdown(filePath);
    const preset = agentPresetFromMetadata(filePath, 'opencode', parsed.metadata, parsed.body);
    if (preset) presets.push(preset);
  }
  const seen = new Set<string>();
  return presets.filter(preset => {
    const key = `${preset.ecosystem}:${preset.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function findAgentPreset(root: string, selector: string): NewmarkAgentPreset | null {
  const wanted = String(selector || '').trim();
  if (!wanted) return null;
  const normalized = wanted.toLowerCase();
  return discoverAgentPresets(root).find(preset => {
    const keys = [
      preset.id,
      preset.name,
      `${preset.ecosystem}:${preset.name}`,
      path.basename(preset.path),
    ].map(value => String(value || '').toLowerCase());
    return keys.includes(normalized) || path.resolve(preset.path).toLowerCase() === path.resolve(wanted).toLowerCase();
  }) || null;
}
