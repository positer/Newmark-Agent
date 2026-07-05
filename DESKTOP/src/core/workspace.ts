import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConfigManager } from '../core/config';

export interface WorkspaceInfo {
  name: string;
  path: string;
  isInternal: boolean;
  hostBinding: string;
  icon: string;
  pinned?: boolean;
  pinnedAt?: string;
  kind?: 'local' | 'ssh';
  sshConnectionId?: string;
  remotePath?: string;
  remotePcHash?: string;
  remoteUserHost?: string;
  status?: string;
}

interface WorkspaceState {
  current?: {
    name?: string;
    path?: string;
    isInternal?: boolean;
  } | null;
  updatedAt?: string;
}

export class WorkspaceManager {
  public current: WorkspaceInfo | null = null;
  public internal: WorkspaceInfo[] = [];
  public external: WorkspaceInfo[] = [];
  private pcHash: string;

  constructor(
    public rootPath: string,
    private config: ConfigManager
  ) {
    // Ensure Work directory exists
    const workDir = path.join(rootPath, 'Work');
    try { fs.mkdirSync(workDir, { recursive: true }); } catch {}
    for (const fn of ['Local.json', 'External.json']) {
      const p = path.join(workDir, fn);
      if (!fs.existsSync(p)) {
        try { fs.writeFileSync(p, '[]', 'utf-8'); } catch {}
      }
    }
    this.pcHash = this.loadPcHash();
    this.scan();
    this.validate();
    this.restoreCurrent();
    if (config.getBool('workspace', 'auto_create_timestamp_workspace') && !this.current) {
      this.createInternal();
    }
  }

  private loadPcHash(): string {
    try {
      const h = fs.readFileSync(path.join(this.rootPath, 'PC_Hash.config'), 'utf-8');
      return h.trim();
    } catch { return ''; }
  }

  private validate(): void {
    this.external = this.external.filter(w => {
      if (w.kind === 'ssh' || w.sshConnectionId) return !!w.remotePcHash;
      return !w.hostBinding || w.hostBinding === this.pcHash;
    });
    this.saveExternal();
  }

  private scan(): void {
    const w = path.join(this.rootPath, 'Work');
    if (!fs.existsSync(w)) return;
    try {
      const local = JSON.parse(fs.readFileSync(path.join(w, 'Local.json'), 'utf-8'));
      this.internal = local;
    } catch { /* empty */ }
    try {
      const ext = JSON.parse(fs.readFileSync(path.join(w, 'External.json'), 'utf-8'));
      this.external = ext;
    } catch { /* empty */ }
    // Scan for directories not in Local.json
    for (const entry of fs.readdirSync(w, { withFileTypes: true })) {
      if (entry.isDirectory() && !['Local.json', 'External.json', '.ssh'].includes(entry.name)) {
        if (!this.internal.find(wi => wi.name === entry.name)) {
          this.internal.push({
            name: entry.name,
            path: path.join(w, entry.name),
            isInternal: true,
            hostBinding: '',
            icon: entry.name.charAt(0).toUpperCase(),
          });
        }
      }
    }
    this.sortWorkspaces();
  }

  private normalizeWorkspaceList(list: WorkspaceInfo[]): WorkspaceInfo[] {
    return [...list].sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      if (a.pinned && b.pinned) return String(b.pinnedAt || '').localeCompare(String(a.pinnedAt || ''));
      return a.name.localeCompare(b.name);
    });
  }

  private sortWorkspaces(): void {
    this.internal = this.normalizeWorkspaceList(this.internal);
    this.external = this.normalizeWorkspaceList(this.external);
  }

  private canonicalWorkspacePath(target: string): string {
    const resolved = path.resolve(target);
    let real = resolved;
    try {
      real = fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
    } catch {
      real = resolved;
    }
    const normalized = path.normalize(real).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  private isInsideRoot(target: string): boolean {
    const root = this.canonicalWorkspacePath(this.rootPath);
    const candidate = this.canonicalWorkspacePath(target);
    const rel = path.relative(root, candidate);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  }

  private canonicalRemotePath(target: string): string {
    let cleaned = String(target || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
    if (cleaned.length > 1) cleaned = cleaned.replace(/\/{2,}/g, '/');
    return cleaned;
  }

  private findSshWorkspaceByRemotePath(sshConnectionId: string, remotePath: string): WorkspaceInfo | null {
    const wanted = this.canonicalRemotePath(remotePath);
    return this.external.find(w =>
      (w.kind === 'ssh' || w.sshConnectionId) &&
      w.sshConnectionId === sshConnectionId &&
      this.canonicalRemotePath(w.remotePath || '') === wanted
    ) || null;
  }

  private findWorkspaceByPath(target: string): WorkspaceInfo | null {
    const wanted = this.canonicalWorkspacePath(target);
    return [...this.internal, ...this.external].find(w => this.canonicalWorkspacePath(w.path) === wanted) || null;
  }

  private dedupeByPath(list: WorkspaceInfo[]): WorkspaceInfo[] {
    const seen = new Set<string>();
    const deduped: WorkspaceInfo[] = [];
    for (const item of list) {
      const key = this.canonicalWorkspacePath(item.path);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
    return deduped;
  }

  private statePath(): string {
    return path.join(this.rootPath, 'Work', 'State.json');
  }

  private readState(): WorkspaceState {
    const p = this.statePath();
    if (!fs.existsSync(p)) return {};
    try {
      const raw = fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as WorkspaceState;
    } catch {
      return {};
    }
    return {};
  }

  private saveState(): void {
    const p = this.statePath();
    const state: WorkspaceState = {
      current: this.current ? {
        name: this.current.name,
        path: this.current.path,
        isInternal: this.current.isInternal,
      } : null,
      updatedAt: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf-8');
    } catch {}
  }

  private findWorkspace(ref: WorkspaceState['current']): WorkspaceInfo | null {
    if (!ref) return null;
    const all = [...this.internal, ...this.external];
    const refPath = ref.path ? path.resolve(ref.path) : '';
    return all.find(w => {
      if (typeof ref.isInternal === 'boolean' && w.isInternal !== ref.isInternal) return false;
      if (refPath && path.resolve(w.path) === refPath) return true;
      return !!ref.name && w.name === ref.name;
    }) || null;
  }

  private restoreCurrent(): void {
    const stored = this.findWorkspace(this.readState().current || null);
    if (stored) {
      this.current = stored;
      return;
    }

    const all = [...this.internal, ...this.external];
    const fallback = all.length ? all[all.length - 1] : null;
    if (fallback) {
      this.current = fallback;
      this.saveState();
    }
  }

  private saveInternal(): void {
    const p = path.join(this.rootPath, 'Work', 'Local.json');
    this.internal = this.dedupeByPath(this.internal);
    this.sortWorkspaces();
    fs.writeFileSync(p, JSON.stringify(this.internal, null, 2), 'utf-8');
  }

  private saveExternal(): void {
    const p = path.join(this.rootPath, 'Work', 'External.json');
    this.external = this.dedupeByPath(this.external);
    this.sortWorkspaces();
    fs.writeFileSync(p, JSON.stringify(this.external, null, 2), 'utf-8');
  }

  private sleepSync(ms: number): void {
    if (ms <= 0) return;
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
  }

  private isInternalWorkspacePath(target: string): boolean {
    const workRoot = path.resolve(this.rootPath, 'Work');
    const resolved = path.resolve(target);
    const rel = path.relative(workRoot, resolved);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  private clearReadOnlyRecursive(target: string): void {
    if (!fs.existsSync(target)) return;
    const stat = fs.lstatSync(target);
    try {
      fs.chmodSync(target, stat.mode | 0o700);
    } catch {}
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(target)) {
      this.clearReadOnlyRecursive(path.join(target, entry));
    }
  }

  private removeInternalDirectory(target: string): boolean {
    const resolved = path.resolve(target);
    if (!this.isInternalWorkspacePath(resolved)) return false;
    if (!fs.existsSync(resolved)) return true;

    const delays = [0, 50, 100, 200, 400, 800, 1200];
    for (const delay of delays) {
      this.sleepSync(delay);
      try {
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
      if (!fs.existsSync(resolved)) return true;

      try {
        this.clearReadOnlyRecursive(resolved);
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
      if (!fs.existsSync(resolved)) return true;
    }

    return false;
  }

  createInternal(name?: string): WorkspaceInfo {
    const n = name || new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
    const d = path.join(this.rootPath, 'Work', n);
    fs.mkdirSync(d, { recursive: true });
    const existing = this.findWorkspaceByPath(d);
    if (existing) {
      this.current = existing;
      this.saveState();
      return existing;
    }
    const ws: WorkspaceInfo = {
      name: n,
      path: d,
      isInternal: true,
      hostBinding: '',
      icon: n.charAt(0).toUpperCase(),
    };
    this.internal.push(ws);
    this.saveInternal();
    this.current = ws;
    this.saveState();
    return ws;
  }

  addExternal(p: string): WorkspaceInfo | null {
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved) || this.isInsideRoot(resolved)) return null;
    const existing = this.findWorkspaceByPath(resolved);
    if (existing) {
      this.current = existing;
      this.saveState();
      return existing;
    }
    const name = path.basename(resolved);
    const ws: WorkspaceInfo = {
      name,
      path: resolved,
      isInternal: false,
      hostBinding: this.pcHash,
      icon: name.charAt(0).toUpperCase(),
    };
    this.external.push(ws);
    this.saveExternal();
    this.current = ws;
    this.saveState();
    return ws;
  }

  addSshExternal(input: {
    name?: string;
    localPath?: string;
    sshConnectionId: string;
    remotePath: string;
    remotePcHash: string;
    remoteUserHost?: string;
  }): WorkspaceInfo | null {
    if (!input.sshConnectionId || !input.remotePath || !input.remotePcHash) return null;
    const remotePath = this.canonicalRemotePath(input.remotePath);
    const baseName = (input.name || path.basename(remotePath.replace(/[\\/]+$/, '')) || input.sshConnectionId || 'ssh-workspace').trim();
    const safeName = baseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, ' ').trim() || 'ssh-workspace';
    const shadowRoot = input.localPath
      ? path.resolve(input.localPath)
      : path.join(this.rootPath, 'Work', '.ssh', `${input.sshConnectionId}-${crypto.createHash('sha256').update(remotePath).digest('hex').slice(0, 16)}`);
    fs.mkdirSync(shadowRoot, { recursive: true });
    const existing = this.findSshWorkspaceByRemotePath(input.sshConnectionId, remotePath);
    const ws: WorkspaceInfo = {
      ...(existing || {}),
      name: existing?.name || safeName,
      path: shadowRoot,
      isInternal: false,
      hostBinding: this.pcHash,
      icon: safeName.charAt(0).toUpperCase(),
      kind: 'ssh',
      sshConnectionId: input.sshConnectionId,
      remotePath,
      remotePcHash: input.remotePcHash,
      remoteUserHost: input.remoteUserHost || existing?.remoteUserHost || '',
      status: 'linked',
    };
    if (existing) {
      Object.assign(existing, ws);
    } else {
      this.external.push(ws);
    }
    this.saveExternal();
    this.current = existing || ws;
    this.saveState();
    return this.current;
  }

  activateSshExternalByPcHash(sshConnectionId: string, remotePcHash: string): WorkspaceInfo[] {
    const matched = this.external.filter(w =>
      (w.kind === 'ssh' || w.sshConnectionId) &&
      (!sshConnectionId || w.sshConnectionId === sshConnectionId) &&
      w.remotePcHash === remotePcHash
    );
    for (const ws of matched) ws.status = 'linked';
    if (matched.length) this.saveExternal();
    return matched;
  }

  remove(name: string): boolean {
    const idxInt = this.internal.findIndex(w => w.name === name);
    if (idxInt >= 0) {
      const removedWorkspace = this.internal[idxInt];
      if (!this.removeInternalDirectory(removedWorkspace.path)) return false;
      this.internal.splice(idxInt, 1);
      this.saveInternal();
      if (this.current?.name === name) this.current = null;
      this.saveState();
      return true;
    }
    const idxExt = this.external.findIndex(w => w.name === name);
    if (idxExt >= 0) {
      this.external.splice(idxExt, 1);
      this.saveExternal();
      if (this.current?.name === name) this.current = null;
      this.saveState();
      return true;
    }
    return false;
  }

  select(id: string): WorkspaceInfo | null {
    const found = [...this.internal, ...this.external].find(
      w => w.name === id || w.path === id
    );
    this.current = found || null;
    this.saveState();
    return this.current;
  }

  setPinned(id: string, pinned: boolean): WorkspaceInfo | null {
    const found = [...this.internal, ...this.external].find(
      w => w.name === id || w.path === id
    );
    if (!found) return null;
    found.pinned = !!pinned;
    found.pinnedAt = found.pinned ? new Date().toISOString() : '';
    if (found.isInternal) this.saveInternal();
    else this.saveExternal();
    this.sortWorkspaces();
    return found;
  }

  clear(): void {
    this.current = null;
    this.saveState();
  }

  currentAgentPrompt(): string | null {
    if (!this.current) return null;
    try {
      return fs.readFileSync(path.join(this.current.path, 'agent.md'), 'utf-8');
    } catch { return null; }
  }

  checkAccess(target: string): boolean {
    const perm = this.config.getStr('workspace', 'access_permission');
    if (perm === 'full_access') return true;
    if (!this.current) return perm !== 'no_outside_access';
    const rel = path.relative(path.resolve(this.current.path), path.resolve(target));
    const inside = rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    if (inside) return true;
    return perm !== 'no_outside_access';
  }
}
