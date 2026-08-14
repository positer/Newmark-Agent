import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface McpState {
  version: 1;
  servers: McpServerConfig[];
}

export interface McpServerInput {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  transport?: unknown;
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  url?: unknown;
  env?: unknown;
  headers?: unknown;
}

function stringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey || cleanKey.includes('\r') || cleanKey.includes('\n') || cleanKey.includes(String.fromCharCode(0)) || ['__proto__', 'prototype', 'constructor'].includes(cleanKey)) throw new Error(`${label} contains an invalid key.`);
    const cleanValue = String(item ?? '');
    if (cleanValue.includes(String.fromCharCode(0)) || (label === 'headers' && /[\r\n]/.test(cleanValue))) throw new Error(`${label} contains an invalid value.`);
    output[cleanKey] = cleanValue;
  }
  return output;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('args must be a JSON array of strings.');
  if (value.length > 100 || value.some(item => typeof item !== 'string' || item.length > 4000 || item.includes(String.fromCharCode(0)))) {
    throw new Error('args must contain at most 100 strings, each no longer than 4000 characters.');
  }
  return [...value] as string[];
}

function publicHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = '<redacted>';
    if (parsed.password) parsed.password = '<redacted>';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/(?:api.?key|authorization|access.?token|secret|password|credential)/i.test(key)) parsed.searchParams.set(key, '<redacted>');
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function parseHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('An HTTP MCP server requires an http(s) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('An HTTP MCP server requires an http(s) URL.');
  if (parsed.username || parsed.password) throw new Error('Put HTTP credentials in headers, not in the MCP URL.');
  return value;
}

function safeLoadedServer(value: unknown): McpServerConfig | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    const id = String(item.id || '').trim();
    const name = String(item.name || '').trim();
    const transport = item.transport === 'http' ? 'http' : item.transport === 'stdio' ? 'stdio' : undefined;
    if (!id || !name || !transport) return undefined;
    const command = String(item.command || '').trim();
    const url = String(item.url || '').trim();
    if (transport === 'stdio' && !command) return undefined;
    if (transport === 'http') parseHttpUrl(url);
    return {
      id: id.slice(0, 200),
      name: name.slice(0, 120),
      enabled: item.enabled === true,
      transport,
      command: transport === 'stdio' ? command.slice(0, 2000) : undefined,
      args: transport === 'stdio' ? (stringArray(item.args) || []) : undefined,
      cwd: transport === 'stdio' ? String(item.cwd || '').trim().slice(0, 4000) || undefined : undefined,
      url: transport === 'http' ? url.slice(0, 4000) : undefined,
      env: transport === 'stdio' ? (stringRecord(item.env, 'env') || {}) : undefined,
      headers: transport === 'http' ? (stringRecord(item.headers, 'headers') || {}) : undefined,
      createdAt: String(item.createdAt || new Date(0).toISOString()),
      updatedAt: String(item.updatedAt || item.createdAt || new Date(0).toISOString()),
    };
  } catch {
    return undefined;
  }
}

export class McpManager {
  private readonly filePath: string;
  private state: McpState;
  private preserveCorruptSource = false;

  constructor(root: string) {
    this.filePath = path.join(root, 'MCP.json');
    this.state = this.load();
  }

  list(): Array<Omit<McpServerConfig, 'env' | 'headers'> & { envKeys: string[]; headerKeys: string[] }> {
    return this.state.servers.map(server => {
      const { env, headers, ...publicServer } = server;
      return {
        ...publicServer,
        args: [...(server.args || [])],
        url: publicHttpUrl(server.url),
        envKeys: Object.keys(env || {}).sort(),
        headerKeys: Object.keys(headers || {}).sort(),
      };
    });
  }

  upsert(input: McpServerInput): McpServerConfig {
    const id = String(input.id || '').trim();
    if (input.transport !== undefined && input.transport !== 'stdio' && input.transport !== 'http') throw new Error('transport must be stdio or http.');
    let existing = this.state.servers.find(server => server.id === id);
    const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 120);
    if (!name) throw new Error('MCP server name is required.');
    if (/[\r\n\0]/.test(name)) throw new Error('MCP server name contains invalid characters.');
    const transport: McpTransport = input.transport === 'http' ? 'http' : (input.transport === 'stdio' ? 'stdio' : existing?.transport || 'stdio');
    const command = String(input.command ?? existing?.command ?? '').trim();
    let url = String(input.url ?? existing?.url ?? '').trim();
    if (transport === 'stdio' && !command) throw new Error('A stdio MCP server requires a command.');
    if (transport === 'stdio' && /[\r\n\0]/.test(command)) throw new Error('command contains an invalid value.');
    if (transport === 'http') url = parseHttpUrl(url);
    if (!existing && !id) {
      existing = this.state.servers.find(server => server.name.toLocaleLowerCase() === name.toLocaleLowerCase()
        && server.transport === transport
        && (transport === 'stdio' ? server.command === command : server.url === url));
    }
    const now = new Date().toISOString();
    const server: McpServerConfig = {
      id: existing?.id || `mcp-${randomUUID()}`,
      name,
      enabled: typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled === true,
      transport,
      command: transport === 'stdio' ? command.slice(0, 2000) : undefined,
      args: transport === 'stdio' ? (stringArray(input.args) ?? existing?.args ?? []) : undefined,
      cwd: transport === 'stdio' ? String(input.cwd ?? existing?.cwd ?? '').trim().slice(0, 4000) || undefined : undefined,
      url: transport === 'http' ? url.slice(0, 4000) : undefined,
      env: transport === 'stdio' ? (stringRecord(input.env, 'env') ?? existing?.env ?? {}) : undefined,
      headers: transport === 'http' ? (stringRecord(input.headers, 'headers') ?? existing?.headers ?? {}) : undefined,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (existing) this.state.servers[this.state.servers.indexOf(existing)] = server;
    else this.state.servers.push(server);
    this.save();
    return server;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const server = this.state.servers.find(item => item.id === String(id || ''));
    if (!server) return false;
    server.enabled = !!enabled;
    server.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  remove(id: string): boolean {
    const before = this.state.servers.length;
    this.state.servers = this.state.servers.filter(server => server.id !== String(id || ''));
    if (this.state.servers.length === before) return false;
    this.save();
    return true;
  }

  private load(): McpState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<McpState>;
      return { version: 1, servers: Array.isArray(parsed.servers) ? parsed.servers.map(safeLoadedServer).filter((server): server is McpServerConfig => !!server) : [] };
    } catch {
      this.preserveCorruptSource = fs.existsSync(this.filePath);
      return { version: 1, servers: [] };
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (this.preserveCorruptSource) {
      const backupPath = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(this.filePath, backupPath);
      this.preserveCorruptSource = false;
    }
    const tempPath = `${this.filePath}.${process.pid}-${randomUUID()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }
}
