import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';

export interface SkillInfo {
  name: string;
  path: string;
  enabled: boolean;
  installed: boolean;
  description: string;
  source: 'project' | 'user' | 'codex' | 'claude' | 'opencode' | 'plugin' | 'remote';
  url?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  pluginId?: string;
  marketSourceId?: string;
  marketSourceName?: string;
  warnings?: string[];
}

export type SkillMarketSourceType = 'json' | 'skill-url' | 'local-dir';

export interface SkillMarketSource {
  id: string;
  name: string;
  type: SkillMarketSourceType;
  enabled: boolean;
  url?: string;
  path?: string;
  builtin?: boolean;
  addedAt?: string;
  updatedAt?: string;
  warnings?: string[];
}

interface SkillsMeta {
  disabled: string[];
}

interface MarketSourcesFile {
  sources: SkillMarketSource[];
}

export class SkillsManager {
  private skillsDir: string;
  private metaPath: string;
  private marketSourcesPath: string;
  private metadataCache = new Map<string, { fingerprint: string; info: SkillInfo }>();

  constructor(root: string) {
    this.skillsDir = path.join(root, 'skills');
    this.metaPath = path.join(this.skillsDir, '.skills.json');
    this.marketSourcesPath = path.join(this.skillsDir, '.market-sources.json');
    fs.mkdirSync(this.skillsDir, { recursive: true });
  }

  list(): string[] {
    return fs.readdirSync(this.skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);
  }

  listDetailed(): SkillInfo[] {
    return this.list().map(name => this.infoFor(name, this.getPath(name), 'project', true));
  }

  active(): SkillInfo[] {
    return this.listDetailed().filter(s => s.enabled && this.has(s.name));
  }

  search(query: string, limit = 8): SkillInfo[] {
    const terms = this.searchTerms(query);
    const active = this.active();
    if (!terms.length) return active.slice(0, Math.max(1, Math.min(limit, 20)));
    return active.map((skill, index) => {
      const name = skill.name.toLowerCase();
      const description = skill.description.toLowerCase();
      const score = terms.reduce((sum, term) => sum
        + (name === term ? 30 : name.includes(term) ? 14 : 0)
        + (description.includes(term) ? 5 : 0), 0);
      return { skill, score, index };
    }).filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, Math.max(1, Math.min(limit, 20)))
      .map(item => item.skill);
  }

  load(name: string): { skill: SkillInfo; content: string; files: string[] } | null {
    const reference = String(name || '').trim().toLowerCase();
    const skill = this.active().find(item => item.name.toLowerCase() === reference || path.basename(item.path).toLowerCase() === reference);
    if (!skill) return null;
    const skillPath = path.join(skill.path, 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf-8');
    const files = this.sampleSkillFiles(skill.path, 10);
    return { skill, content, files };
  }

  has(name: string): boolean {
    return fs.existsSync(path.join(this.skillsDir, name, 'SKILL.md'));
  }

  getPath(name: string): string {
    return path.join(this.skillsDir, name);
  }

  async download(name: string, url: string): Promise<string> {
    const dir = path.join(this.skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    if (!url.startsWith('http')) return `[skill] Not a URL: ${url}`;
    try {
      const resp = await fetch(url);
      const content = await resp.text();
      fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
      return `[skill] Downloaded '${name}'`;
    } catch (e) { return `[skill] ${e}`; }
  }

  installFromLocal(sourceDir: string, targetName?: string): boolean {
    const skillPath = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) return false;
    const info = this.parseSkillInfo(sourceDir);
    const cleanName = this.cleanName(targetName || info.name || path.basename(sourceDir));
    if (!cleanName) return false;
    const dest = path.join(this.skillsDir, cleanName);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(sourceDir, dest, { recursive: true });
    this.setEnabled(cleanName, true);
    return true;
  }

  remove(name: string): boolean {
    const dir = path.join(this.skillsDir, name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      const meta = this.loadMeta();
      meta.disabled = meta.disabled.filter(n => n !== name);
      this.saveMeta(meta);
      return true;
    }
    return false;
  }

  isEnabled(name: string): boolean {
    return !this.loadMeta().disabled.includes(name);
  }

  setEnabled(name: string, enabled: boolean): boolean {
    if (!this.has(name)) return false;
    const meta = this.loadMeta();
    const disabled = new Set(meta.disabled);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    meta.disabled = Array.from(disabled).sort();
    this.saveMeta(meta);
    return true;
  }

  listMarketSources(): SkillMarketSource[] {
    return [
      ...this.builtinMarketSources(),
      ...this.loadMarketSources(),
    ];
  }

  addMarketSource(input: {
    id?: string;
    name: string;
    type?: SkillMarketSourceType;
    url?: string;
    path?: string;
    enabled?: boolean;
  }): SkillMarketSource {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Market source name is required.');
    const url = String(input.url || '').trim();
    const sourcePath = String(input.path || '').trim();
    const type = input.type || (sourcePath ? 'local-dir' : 'json');
    if (!['json', 'skill-url', 'local-dir'].includes(type)) throw new Error(`Unsupported market source type: ${type}`);
    if ((type === 'json' || type === 'skill-url') && !url && !sourcePath) throw new Error(`${type} source requires --url or --path.`);
    if (type === 'local-dir' && !sourcePath) throw new Error('local-dir source requires --path.');
    if (url && !this.isSafeMarketUrl(url)) throw new Error('Market source URL must use http or https.');
    const id = this.cleanSourceId(input.id || name);
    if (!id) throw new Error('Market source id is invalid.');
    if (this.builtinMarketSources().some(s => s.id === id)) throw new Error(`Market source id is reserved: ${id}`);
    const sources = this.loadMarketSources().filter(s => s.id !== id && s.name.toLowerCase() !== name.toLowerCase());
    const now = new Date().toISOString();
    const existing = this.loadMarketSources().find(s => s.id === id || s.name.toLowerCase() === name.toLowerCase());
    const source: SkillMarketSource = {
      id,
      name,
      type,
      enabled: input.enabled !== false,
      url: url || undefined,
      path: sourcePath ? path.resolve(sourcePath) : undefined,
      addedAt: existing?.addedAt || now,
      updatedAt: now,
    };
    sources.push(source);
    this.saveMarketSources(sources);
    return source;
  }

  removeMarketSource(idOrName: string): boolean {
    const key = String(idOrName || '').trim().toLowerCase();
    if (!key || this.builtinMarketSources().some(s => s.id.toLowerCase() === key || s.name.toLowerCase() === key)) return false;
    const sources = this.loadMarketSources();
    const next = sources.filter(s => s.id.toLowerCase() !== key && s.name.toLowerCase() !== key);
    if (next.length === sources.length) return false;
    this.saveMarketSources(next);
    return true;
  }

  setMarketSourceEnabled(idOrName: string, enabled: boolean): boolean {
    const key = String(idOrName || '').trim().toLowerCase();
    if (!key || this.builtinMarketSources().some(s => s.id.toLowerCase() === key || s.name.toLowerCase() === key)) return false;
    let changed = false;
    const now = new Date().toISOString();
    const sources = this.loadMarketSources().map(s => {
      if (s.id.toLowerCase() === key || s.name.toLowerCase() === key) {
        changed = true;
        return { ...s, enabled, updatedAt: now };
      }
      return s;
    });
    if (!changed) return false;
    this.saveMarketSources(sources);
    return true;
  }

  discoverMarket(): SkillInfo[] {
    const installed = new Set(this.list());
    const items: SkillInfo[] = [];
    for (const info of this.listDetailed()) items.push(info);

    const roots: Array<{ root: string; source: SkillInfo['source'] }> = [
      { root: path.join(this.skillsDir, '..', '.agents', 'skills'), source: 'codex' },
      { root: path.join(this.skillsDir, '..', '.claude', 'skills'), source: 'claude' },
      { root: path.join(os.homedir(), '.agents', 'skills'), source: 'user' },
      { root: path.join(os.homedir(), '.codex', 'skills'), source: 'codex' },
      { root: path.join(os.homedir(), '.claude', 'skills'), source: 'claude' },
      { root: path.join(os.homedir(), '.config', 'opencode', 'skills'), source: 'opencode' },
    ];

    for (const entry of roots) {
      for (const dir of this.findSkillDirs(entry.root, 4, 240)) {
        const parsed = this.parseSkillInfo(dir);
        const name = this.cleanName(parsed.name || path.basename(dir));
        if (!name || items.some(i => i.name === name && i.source !== 'remote')) continue;
        items.push({
          name,
          path: dir,
          enabled: installed.has(name) ? this.isEnabled(name) : false,
          installed: installed.has(name),
          description: parsed.description,
          source: entry.source,
          license: parsed.license,
          compatibility: parsed.compatibility,
          metadata: parsed.metadata,
          allowedTools: parsed.allowedTools,
          warnings: parsed.warnings,
        });
      }
    }

    for (const dir of this.findPluginSkillDirs(path.join(this.skillsDir, '..'), 5, 240)) {
      const parsed = this.parseSkillInfo(dir);
      const name = this.cleanName(parsed.name || path.basename(dir));
      if (!name || items.some(i => i.name === name && i.source !== 'remote')) continue;
      items.push({
        name,
        path: dir,
        enabled: installed.has(name) ? this.isEnabled(name) : false,
        installed: installed.has(name),
        description: parsed.description,
        source: 'plugin',
        license: parsed.license,
        compatibility: parsed.compatibility,
        metadata: parsed.metadata,
        allowedTools: parsed.allowedTools,
        pluginId: this.pluginIdForSkill(dir),
        warnings: parsed.warnings,
      });
    }

    for (const source of this.listMarketSources()) {
      if (!source.enabled) continue;
      for (const item of this.discoverMarketSource(source, installed)) {
        if (!items.some(i => i.name === item.name)) items.push(item);
      }
    }

    return items.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
  }

  async discoverMarketAsync(): Promise<SkillInfo[]> {
    const installed = new Set(this.list());
    const items = this.discoverMarket();
    for (const source of this.listMarketSources()) {
      if (!source.enabled || source.type !== 'json' || !source.url?.startsWith('http')) continue;
      for (const item of await this.discoverJsonMarketSourceAsync(source, installed)) {
        if (!items.some(i => i.name === item.name)) items.push(item);
      }
    }
    return items.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
  }

  count(): number {
    return this.list().length;
  }

  private infoFor(name: string, dir: string, source: SkillInfo['source'], installed: boolean): SkillInfo {
    const parsed = this.parseSkillInfo(dir);
    return {
      name,
      path: dir,
      enabled: this.isEnabled(name),
      installed,
      description: parsed.description,
      source,
      license: parsed.license,
      compatibility: parsed.compatibility,
      metadata: parsed.metadata,
      allowedTools: parsed.allowedTools,
      warnings: parsed.warnings,
    };
  }

  private loadMeta(): SkillsMeta {
    try {
      if (fs.existsSync(this.metaPath)) {
        const raw = JSON.parse(fs.readFileSync(this.metaPath, 'utf-8')) as Partial<SkillsMeta>;
        return { disabled: Array.isArray(raw.disabled) ? raw.disabled.map(String) : [] };
      }
    } catch { /* ignore */ }
    return { disabled: [] };
  }

  private saveMeta(meta: SkillsMeta): void {
    fs.writeFileSync(this.metaPath, JSON.stringify({ disabled: meta.disabled }, null, 2), 'utf-8');
  }

  private builtinMarketSources(): SkillMarketSource[] {
    return [{
      id: 'builtin-design-taste-frontend',
      name: 'Built-in Design Taste Frontend',
      type: 'skill-url',
      enabled: true,
      builtin: true,
      url: 'https://raw.githubusercontent.com/Jonathan-Adly/taste-skill/main/skills/design-taste-frontend/SKILL.md',
    }];
  }

  private loadMarketSources(): SkillMarketSource[] {
    try {
      if (!fs.existsSync(this.marketSourcesPath)) return [];
      const raw = JSON.parse(fs.readFileSync(this.marketSourcesPath, 'utf-8')) as Partial<MarketSourcesFile>;
      if (!Array.isArray(raw.sources)) return [];
      return raw.sources
        .map(source => this.normalizeMarketSource(source))
        .filter((source): source is SkillMarketSource => !!source);
    } catch {
      return [];
    }
  }

  private saveMarketSources(sources: SkillMarketSource[]): void {
    const normalized = sources
      .filter(s => !s.builtin)
      .map(s => this.normalizeMarketSource(s))
      .filter((source): source is SkillMarketSource => !!source);
    fs.writeFileSync(this.marketSourcesPath, JSON.stringify({ sources: normalized }, null, 2), 'utf-8');
  }

  private normalizeMarketSource(raw: unknown): SkillMarketSource | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Partial<SkillMarketSource>;
    const name = String(source.name || '').trim();
    const type = String(source.type || '').trim() as SkillMarketSourceType;
    const url = String(source.url || '').trim();
    const sourcePath = String(source.path || '').trim();
    if (!name || !['json', 'skill-url', 'local-dir'].includes(type)) return null;
    if ((type === 'json' || type === 'skill-url') && !url && !sourcePath) return null;
    if (type === 'local-dir' && !sourcePath) return null;
    const id = this.cleanSourceId(source.id || name);
    if (!id) return null;
    return {
      id,
      name,
      type,
      enabled: source.enabled !== false,
      url: url || undefined,
      path: sourcePath ? path.resolve(sourcePath) : undefined,
      builtin: source.builtin === true,
      addedAt: source.addedAt ? String(source.addedAt) : undefined,
      updatedAt: source.updatedAt ? String(source.updatedAt) : undefined,
    };
  }

  private discoverMarketSource(source: SkillMarketSource, installed: Set<string>): SkillInfo[] {
    try {
      if (source.type === 'skill-url') {
        const name = this.cleanName(source.name.replace(/^Built-in\s+/i, '').replace(/\s+/g, '-').toLowerCase());
        const skillName = source.id === 'builtin-design-taste-frontend' ? 'design-taste-frontend' : name;
        return [{
          name: skillName,
          description: source.id === 'builtin-design-taste-frontend' ? 'Anti-slop frontend review and design taste rules.' : `Remote skill from ${source.name}.`,
          url: source.url,
          path: source.path || '',
          enabled: installed.has(skillName) ? this.isEnabled(skillName) : false,
          installed: installed.has(skillName),
          source: 'remote',
          marketSourceId: source.id,
          marketSourceName: source.name,
        }];
      }
      if (source.type === 'local-dir') {
        return this.findSkillDirs(source.path || '', 4, 240).map(dir => this.marketInfoFromLocalDir(dir, source, installed)).filter((item): item is SkillInfo => !!item);
      }
      return this.discoverJsonMarketSource(source, installed);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return [{
        name: source.id,
        path: source.path || '',
        enabled: false,
        installed: false,
        description: `Market source could not be read: ${message}`,
        source: 'remote',
        url: source.url,
        marketSourceId: source.id,
        marketSourceName: source.name,
        warnings: [message],
      }];
    }
  }

  private discoverJsonMarketSource(source: SkillMarketSource, installed: Set<string>): SkillInfo[] {
    const text = this.readCatalogText(source);
    if (!text) return [];
    const parsed = JSON.parse(text);
    const rawItems = this.catalogEntries(parsed);
    return rawItems
      .slice(0, 1000)
      .map((entry: unknown) => this.marketInfoFromCatalogEntry(entry, source, installed))
      .filter((item): item is SkillInfo => !!item);
  }

  private readCatalogText(source: SkillMarketSource): string {
    const catalogPath = source.path ? path.resolve(source.path) : '';
    if (catalogPath && fs.existsSync(catalogPath)) return fs.readFileSync(catalogPath, 'utf-8');
    const url = source.url || '';
    if (url.startsWith('file://')) return fs.readFileSync(new URL(url), 'utf-8');
    if (url && !url.startsWith('http')) return fs.readFileSync(path.resolve(url), 'utf-8');
    return '';
  }

  private async discoverJsonMarketSourceAsync(source: SkillMarketSource, installed: Set<string>): Promise<SkillInfo[]> {
    try {
      const resp = await fetch(source.url || '');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const parsed = JSON.parse(await resp.text());
      const rawItems = this.catalogEntries(parsed);
      return rawItems
        .slice(0, 1000)
        .map((entry: unknown) => this.marketInfoFromCatalogEntry(entry, source, installed))
        .filter((item): item is SkillInfo => !!item);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return [{
        name: source.id,
        path: '',
        enabled: false,
        installed: false,
        description: `Market source could not be fetched: ${message}`,
        source: 'remote',
        url: source.url,
        marketSourceId: source.id,
        marketSourceName: source.name,
        warnings: [message],
      }];
    }
  }

  private marketInfoFromCatalogEntry(entry: unknown, source: SkillMarketSource, installed: Set<string>): SkillInfo | null {
    if (!entry || typeof entry !== 'object') return null;
    const raw = entry as Record<string, unknown>;
    const name = this.cleanName(String(raw.name || raw.id || '').trim());
    if (!name) return null;
    const itemPath = String(raw.path || '').trim();
    const itemUrl = String(raw.url || raw.downloadUrl || raw.rawUrl || '').trim();
    const description = String(raw.description || raw.desc || '').trim().slice(0, 1000);
    if (itemUrl && !this.isSafeMarketUrl(itemUrl)) return null;
    return {
      name,
      path: itemPath,
      enabled: installed.has(name) ? this.isEnabled(name) : false,
      installed: installed.has(name),
      description,
      source: 'remote',
      url: itemUrl || undefined,
      license: raw.license ? String(raw.license).slice(0, 200) : undefined,
      compatibility: raw.compatibility ? String(raw.compatibility).slice(0, 200) : undefined,
      marketSourceId: source.id,
      marketSourceName: source.name,
      warnings: this.catalogWarnings(raw),
    };
  }

  private catalogEntries(parsed: unknown): unknown[] {
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || typeof parsed !== 'object') return [];
    const obj = parsed as { skills?: unknown; items?: unknown };
    if (Array.isArray(obj.skills)) return obj.skills;
    if (Array.isArray(obj.items)) return obj.items;
    return [];
  }

  private marketInfoFromLocalDir(dir: string, source: SkillMarketSource, installed: Set<string>): SkillInfo | null {
    const parsed = this.parseSkillInfo(dir);
    const name = this.cleanName(parsed.name || path.basename(dir));
    if (!name) return null;
    return {
      name,
      path: dir,
      enabled: installed.has(name) ? this.isEnabled(name) : false,
      installed: installed.has(name),
      description: parsed.description,
      source: 'user',
      license: parsed.license,
      compatibility: parsed.compatibility,
      metadata: parsed.metadata,
      allowedTools: parsed.allowedTools,
      marketSourceId: source.id,
      marketSourceName: source.name,
      warnings: parsed.warnings,
    };
  }

  private catalogWarnings(raw: Record<string, unknown>): string[] | undefined {
    const warnings: string[] = [];
    if (!raw.url && !raw.path && !raw.downloadUrl && !raw.rawUrl) warnings.push('Catalog entry has no install source.');
    return warnings.length ? warnings : undefined;
  }

  private parseSkillInfo(dir: string): {
    name: string;
    description: string;
    license?: string;
    compatibility?: string;
    metadata?: Record<string, string>;
    allowedTools?: string[];
    warnings?: string[];
  } {
    try {
      const skillPath = path.join(dir, 'SKILL.md');
      const stat = fs.statSync(skillPath);
      const content = fs.readFileSync(skillPath, 'utf-8');
      const digest = createHash('sha256').update(content).digest('hex');
      const fingerprint = `${stat.mtimeMs}:${stat.size}:${digest}`;
      const cached = this.metadataCache.get(skillPath);
      if (cached?.fingerprint === fingerprint) {
        const { info } = cached;
        return { name: info.name, description: info.description, license: info.license, compatibility: info.compatibility, metadata: info.metadata, allowedTools: info.allowedTools, warnings: info.warnings };
      }
      const front = content.match(/^---\s*([\s\S]*?)\s*---/);
      const block = front ? front[1] : content.slice(0, 1000);
      let name = (block.match(/^name:\s*(.+)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
      let description = (block.match(/^description:\s*(.+)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
      const license = (block.match(/^license:\s*(.+)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '') || undefined;
      const compatibility = (block.match(/^compatibility:\s*(.+)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '') || undefined;
      const allowedTools = this.parseInlineList(block.match(/^(?:allowed-tools|allowed_tools):\s*(.+)$/m)?.[1] || '');
      const heading = (content.match(/^#\s+(.+)$/m)?.[1] || '').trim();
      if (!name && heading) name = heading;
      if (!description) {
        const summary = content
          .replace(/^---\s*[\s\S]*?\s*---/, '')
          .split(/\r?\n/)
          .map(line => line.replace(/^#+\s*/, '').trim())
          .filter(Boolean)
          .slice(0, 4)
          .join(' ');
        description = summary.slice(0, 500);
      }
      const warnings = this.validateSkillInfo(name, description, dir);
      const parsed = {
        name,
        description,
        license,
        compatibility,
        metadata: this.parseFlatMetadata(block),
        allowedTools,
        warnings,
      };
      this.metadataCache.set(skillPath, {
        fingerprint,
        info: { ...parsed, path: dir, enabled: this.isEnabled(path.basename(dir)), installed: true, source: 'project' },
      });
      return parsed;
    } catch {
      return { name: '', description: '', warnings: ['SKILL.md could not be read.'] };
    }
  }

  private searchTerms(query: string): string[] {
    const expanded = String(query || '').toLowerCase()
      .replace(/代码|编程|仓库/g, ' code coding repository ')
      .replace(/前端|界面/g, ' frontend ui interface ')
      .replace(/测试|调试|错误/g, ' test debug error ')
      .replace(/论文|研究/g, ' paper research ');
    return Array.from(new Set(expanded.split(/[^a-z0-9_\-\u4e00-\u9fff]+/i).filter(term => term.length > 1)));
  }

  private sampleSkillFiles(root: string, limit: number): string[] {
    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (files.length >= limit || depth > 2) return;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (files.length >= limit || entry.name === 'SKILL.md' || entry.name.startsWith('.')) continue;
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(target, depth + 1);
        else if (entry.isFile()) files.push(target);
      }
    };
    walk(root, 0);
    return files;
  }

  private findSkillDirs(root: string, maxDepth: number, maxItems: number): string[] {
    const results: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (results.length >= maxItems || depth > maxDepth) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) {
        results.push(dir);
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.git') || e.name === 'node_modules') continue;
        walk(path.join(dir, e.name), depth + 1);
      }
    };
    walk(root, 0);
    return results;
  }

  private findPluginSkillDirs(root: string, maxDepth: number, maxItems: number): string[] {
    const results: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (results.length >= maxItems || depth > maxDepth) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const hasPluginManifest = entries.some(e => e.isDirectory() && (e.name === '.codex-plugin' || e.name === '.claude-plugin'));
      if (hasPluginManifest) {
        for (const skillsDir of ['skills', 'Skills']) {
          results.push(...this.findSkillDirs(path.join(dir, skillsDir), 3, maxItems - results.length));
        }
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.git') || e.name === 'node_modules' || e.name === 'release' || e.name.startsWith('release.locked-')) continue;
        walk(path.join(dir, e.name), depth + 1);
      }
    };
    walk(root, 0);
    return Array.from(new Set(results));
  }

  private parseInlineList(raw: string): string[] | undefined {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return trimmed.slice(1, -1).split(',').map(v => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    return trimmed.split(',').map(v => v.trim()).filter(Boolean);
  }

  private parseFlatMetadata(block: string): Record<string, string> | undefined {
    const metadata: Record<string, string> = {};
    for (const key of ['author', 'homepage', 'repository', 'version']) {
      const value = (block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1] || '').trim().replace(/^["']|["']$/g, '');
      if (value) metadata[key] = value;
    }
    return Object.keys(metadata).length ? metadata : undefined;
  }

  private validateSkillInfo(name: string, description: string, dir: string): string[] {
    const warnings: string[] = [];
    if (!name) warnings.push('Missing required frontmatter field: name.');
    if (!description) warnings.push('Missing required frontmatter field: description.');
    if (name && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(name)) warnings.push('Skill name contains characters outside the portable Agent Skills subset.');
    if (description && description.length > 1000) warnings.push('Description is longer than recommended for skill discovery.');
    const folderName = path.basename(dir);
    if (name && folderName && this.cleanName(name) !== this.cleanName(folderName)) warnings.push('Skill name does not match containing folder name.');
    return warnings;
  }

  private pluginIdForSkill(dir: string): string | undefined {
    let current = path.resolve(dir);
    for (let i = 0; i < 6; i++) {
      const codex = path.join(current, '.codex-plugin', 'plugin.json');
      const claude = path.join(current, '.claude-plugin', 'plugin.json');
      for (const filePath of [codex, claude]) {
        try {
          if (fs.existsSync(filePath)) {
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (raw?.name) return String(raw.name);
          }
        } catch { /* ignore */ }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return undefined;
  }

  private cleanName(name: string): string {
    return String(name || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').slice(0, 120);
  }

  private cleanSourceId(name: string): string {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
  }

  private isSafeMarketUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
  }
}
