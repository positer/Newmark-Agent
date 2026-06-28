import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../core/config';

export interface WorkspaceInfo {
  name: string;
  path: string;
  isInternal: boolean;
  hostBinding: string;
  icon: string;
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
    this.external = this.external.filter(
      w => !w.hostBinding || w.hostBinding === this.pcHash
    );
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
      if (entry.isDirectory() && !['Local.json', 'External.json'].includes(entry.name)) {
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
    fs.writeFileSync(p, JSON.stringify(this.internal, null, 2), 'utf-8');
  }

  private saveExternal(): void {
    const p = path.join(this.rootPath, 'Work', 'External.json');
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
    if (!fs.existsSync(resolved) || resolved.startsWith(this.rootPath)) return null;
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
