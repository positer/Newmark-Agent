import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface SshConnectionInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  identityFile?: string;
  remoteRoot?: string;
  enabled?: boolean;
  remotePcHash?: string;
  lastStatus?: 'unknown' | 'ok' | 'failed';
  lastError?: string;
  lastValidatedAt?: string;
  lastLinkedWorkspace?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SshValidateResult {
  ok: boolean;
  connection: SshConnectionInfo;
  remotePcHash?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  command?: string;
  args?: string[];
}

export interface SshCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  args: string[];
}

export type SshRunner = (command: string, args: string[], cwd?: string, timeoutMs?: number) => SshCommandResult;

function defaultSshRunner(command: string, args: string[], cwd?: string, timeoutMs = 12000): SshCommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : undefined,
    args,
  };
}

function stableId(input: string): string {
  const clean = input.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return clean || `ssh-${Date.now()}`;
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function redactedConnection(conn: SshConnectionInfo): SshConnectionInfo {
  return {
    ...conn,
    identityFile: conn.identityFile ? '<identity-file-configured>' : '',
  };
}

export class SshManager {
  constructor(
    private rootPath: string,
    private runner: SshRunner = defaultSshRunner
  ) {
    this.ensureStore();
  }

  private storePath(): string {
    return path.join(this.rootPath, 'Work', 'SSH.json');
  }

  private ensureStore(): void {
    try {
      fs.mkdirSync(path.join(this.rootPath, 'Work'), { recursive: true });
      if (!fs.existsSync(this.storePath())) fs.writeFileSync(this.storePath(), '[]', 'utf-8');
    } catch {}
  }

  private readRaw(): SshConnectionInfo[] {
    this.ensureStore();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath(), 'utf-8').replace(/^\uFEFF/, ''));
      if (!Array.isArray(parsed)) return [];
      return parsed.map(item => this.normalize(item)).filter((item): item is SshConnectionInfo => !!item);
    } catch {
      return [];
    }
  }

  private writeRaw(items: SshConnectionInfo[]): void {
    this.ensureStore();
    fs.writeFileSync(this.storePath(), JSON.stringify(items, null, 2), 'utf-8');
  }

  private normalize(raw: unknown): SshConnectionInfo | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const host = String(item.host || '').trim();
    const user = String(item.user || '').trim();
    if (!host || !user) return null;
    const portRaw = Number(item.port || 22);
    const name = String(item.name || `${user}@${host}`).trim();
    const id = String(item.id || stableId(`${user}@${host}:${Number.isFinite(portRaw) ? portRaw : 22}`)).trim();
    return {
      id,
      name,
      host,
      user,
      port: Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : 22,
      identityFile: String(item.identityFile || '').trim() || undefined,
      remoteRoot: String(item.remoteRoot || '').trim() || undefined,
      enabled: item.enabled !== false,
      remotePcHash: String(item.remotePcHash || '').trim() || undefined,
      lastStatus: item.lastStatus === 'ok' || item.lastStatus === 'failed' ? item.lastStatus : 'unknown',
      lastError: String(item.lastError || '').trim() || undefined,
      lastValidatedAt: String(item.lastValidatedAt || '').trim() || undefined,
      lastLinkedWorkspace: String(item.lastLinkedWorkspace || '').trim() || undefined,
      createdAt: String(item.createdAt || '').trim() || undefined,
      updatedAt: String(item.updatedAt || '').trim() || undefined,
    };
  }

  list(redact = false): SshConnectionInfo[] {
    const items = this.readRaw();
    return redact ? items.map(redactedConnection) : items;
  }

  get(idOrName: string): SshConnectionInfo | null {
    const key = String(idOrName || '').trim();
    if (!key) return null;
    return this.readRaw().find(item => item.id === key || item.name === key || `${item.user}@${item.host}` === key) || null;
  }

  upsert(input: Partial<SshConnectionInfo>): SshConnectionInfo {
    const now = new Date().toISOString();
    const normalized = this.normalize({
      ...input,
      id: input.id || stableId(`${input.user || ''}@${input.host || ''}:${input.port || 22}`),
      name: input.name || `${input.user || ''}@${input.host || ''}`,
      port: input.port || 22,
      enabled: input.enabled !== false,
    });
    if (!normalized) throw new Error('host and user are required for SSH connection');
    const items = this.readRaw();
    const idx = items.findIndex(item => item.id === normalized.id);
    const merged: SshConnectionInfo = {
      ...(idx >= 0 ? items[idx] : {}),
      ...normalized,
      createdAt: idx >= 0 ? items[idx].createdAt || now : now,
      updatedAt: now,
    };
    if (!merged.identityFile) delete merged.identityFile;
    if (!merged.remoteRoot) delete merged.remoteRoot;
    if (idx >= 0) items[idx] = merged;
    else items.push(merged);
    this.writeRaw(items);
    return redactedConnection(merged);
  }

  remove(idOrName: string): boolean {
    const items = this.readRaw();
    const next = items.filter(item => item.id !== idOrName && item.name !== idOrName);
    if (next.length === items.length) return false;
    this.writeRaw(next);
    return true;
  }

  private buildSshArgs(conn: SshConnectionInfo, remoteCommand: string): string[] {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(conn.port || 22),
    ];
    if (conn.identityFile) args.push('-i', conn.identityFile);
    args.push(`${conn.user}@${conn.host}`, remoteCommand);
    return args;
  }

  private pcHashCommand(remoteRoot: string): string {
    const root = remoteRoot || '~/.newmark-agent';
    const qRoot = shellQuote(root);
    return `mkdir -p ${qRoot} && if [ ! -f ${qRoot}/PC_Hash.config ]; then printf "%s|%s|%s" "$(hostname)" "$(uname -s 2>/dev/null || echo unknown)" "$(uname -m 2>/dev/null || echo unknown)" > ${qRoot}/PC_Hash.config; fi && cat ${qRoot}/PC_Hash.config`;
  }

  validate(idOrName: string, remoteRoot?: string): SshValidateResult {
    const conn = this.get(idOrName);
    if (!conn) {
      return { ok: false, connection: { id: idOrName, name: idOrName, host: '', port: 22, user: '', enabled: false }, error: 'SSH connection not found' };
    }
    const root = remoteRoot || conn.remoteRoot || '~/.newmark-agent';
    const args = this.buildSshArgs(conn, this.pcHashCommand(root));
    const result = this.runner('ssh', args, this.rootPath, 15000);
    const remotePcHash = (result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    const ok = result.status === 0 && !!remotePcHash && !result.error;
    const updated: SshConnectionInfo = {
      ...conn,
      remoteRoot: root,
      remotePcHash: ok ? remotePcHash : conn.remotePcHash,
      lastStatus: ok ? 'ok' : 'failed',
      lastError: ok ? '' : (result.error || result.stderr || `ssh exited ${result.status}`),
      lastValidatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const items = this.readRaw();
    const idx = items.findIndex(item => item.id === conn.id);
    if (idx >= 0) {
      items[idx] = updated;
      this.writeRaw(items);
    }
    return {
      ok,
      connection: redactedConnection(updated),
      remotePcHash: ok ? remotePcHash : undefined,
      stdout: ok ? remotePcHash : '',
      stderr: result.stderr,
      error: ok ? undefined : (result.error || result.stderr || `ssh exited ${result.status}`),
      command: 'ssh',
      args: result.args.map(arg => arg === conn.identityFile ? '<identity-file>' : arg),
    };
  }

  ensureRemoteWorkspace(idOrName: string, remotePath: string): SshValidateResult {
    const conn = this.get(idOrName);
    if (!conn) {
      return { ok: false, connection: { id: idOrName, name: idOrName, host: '', port: 22, user: '', enabled: false }, error: 'SSH connection not found' };
    }
    const cleanRemotePath = remotePath || conn.remoteRoot || '~/.newmark-agent/workspaces/default';
    const command = `mkdir -p ${shellQuote(cleanRemotePath)} && ${this.pcHashCommand(cleanRemotePath)}`;
    const args = this.buildSshArgs(conn, command);
    const result = this.runner('ssh', args, this.rootPath, 15000);
    const remotePcHash = (result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    const ok = result.status === 0 && !!remotePcHash && !result.error;
    if (!ok) {
      this.validate(conn.id, conn.remoteRoot);
      return {
        ok: false,
        connection: redactedConnection(conn),
        stderr: result.stderr,
        error: result.error || result.stderr || `ssh exited ${result.status}`,
        command: 'ssh',
        args: result.args.map(arg => arg === conn.identityFile ? '<identity-file>' : arg),
      };
    }
    const updated = this.upsert({ ...conn, remotePcHash, lastStatus: 'ok', lastError: '', lastValidatedAt: new Date().toISOString() });
    return {
      ok: true,
      connection: updated,
      remotePcHash,
      stdout: remotePcHash,
      stderr: result.stderr,
      command: 'ssh',
      args: result.args.map(arg => arg === conn.identityFile ? '<identity-file>' : arg),
    };
  }

  markLinkedWorkspace(idOrName: string, workspaceName: string): void {
    const conn = this.get(idOrName);
    if (!conn) return;
    this.upsert({ ...conn, lastLinkedWorkspace: workspaceName });
  }
}
