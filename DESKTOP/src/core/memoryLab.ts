import * as fs from 'fs';
import * as path from 'path';

export type MemoryLabComponentKind = 'file' | 'folder';

export interface MemoryLabTagNode {
  parents: string[];
  children: string[];
  components: string[];
}

export interface MemoryLabComponent {
  name: string;
  description: string;
  tags: string[];
  path: string;
  coreMd: string;
  kind: MemoryLabComponentKind;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryLabIndex {
  version: 1;
  updatedAt: string;
  tags: Record<string, MemoryLabTagNode>;
  components: Record<string, MemoryLabComponent>;
}

export interface MemoryLabUpdateInput {
  name: string;
  description?: string;
  tags: string[];
  content: string;
  kind?: MemoryLabComponentKind;
}

export interface MemoryLabPreparedUpdate extends MemoryLabUpdateInput {
  slug: string;
  description: string;
  tags: string[];
  content: string;
  kind: MemoryLabComponentKind;
}

export interface MemoryLabReadResult {
  ok: boolean;
  root: string;
  indexPath: string;
  componentsDir: string;
  instructions: string;
  index: MemoryLabIndex;
  component?: {
    slug: string;
    meta: MemoryLabComponent;
    content: string;
  };
  error?: string;
}

export interface MemoryLabWriteResult {
  ok: boolean;
  root: string;
  indexPath: string;
  componentsDir: string;
  instructions: string;
  index: MemoryLabIndex;
  component?: MemoryLabComponent;
  slug?: string;
  error?: string;
  rebuildReceipt?: {
    operation: 'update' | 'reindex';
    completed: true;
    indexUpdatedAt: string;
    verifiedAt: string;
    slug?: string;
  };
}

export class MemoryLabManager {
  public rootDir: string;
  public componentsDir: string;
  public indexPath: string;

  constructor(public rootPath: string) {
    this.rootDir = path.join(rootPath, 'Memory Lab');
    this.componentsDir = path.join(this.rootDir, 'components');
    this.indexPath = path.join(this.rootDir, 'index.json');
    this.ensure();
  }

  ensure(): void {
    fs.mkdirSync(this.componentsDir, { recursive: true });
    if (!fs.existsSync(this.indexPath)) {
      this.saveIndex(this.emptyIndex());
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
      this.normalizeIndex(raw);
    } catch {
      this.saveIndex(this.emptyIndex());
    }
  }

  instructions(): string {
    return [
      'Memory Lab stores persistent local memory for Newmark Agent.',
      `Root: ${this.rootDir}`,
      `Index: ${this.indexPath}`,
      `Components: ${this.componentsDir}`,
      'Use memory_lab_read to inspect index.json before deciding what memory is relevant.',
      'Use memory_lab_read with component/name/slug to read a component core markdown file.',
      'Use memory_lab_update only when the user asks to create or update durable memory, passing name, description, hierarchical tags, content, and optional kind=file|folder.',
      'Tags are hierarchical. For example #物理-理论物理 creates #物理 as parent and links #物理 -> #物理-理论物理. Components are linked only to the deepest tag supplied.',
      'Do not inject index content or memory component content into the system prompt; retrieve it through this tool only when needed.',
    ].join('\n');
  }

  read(componentSelector = ''): MemoryLabReadResult {
    this.ensure();
    const index = this.loadIndex();
    const result: MemoryLabReadResult = {
      ok: true,
      root: this.rootDir,
      indexPath: this.indexPath,
      componentsDir: this.componentsDir,
      instructions: this.instructions(),
      index,
    };
    const selector = String(componentSelector || '').trim();
    if (selector) {
      const slug = this.resolveComponentSlug(index, selector);
      if (!slug) return { ...result, ok: false, error: `Memory component not found: ${selector}` };
      const meta = index.components[slug];
      result.component = { slug, meta, content: this.readComponentContent(meta) };
    }
    return result;
  }

  prepareUpdate(input: MemoryLabUpdateInput): MemoryLabPreparedUpdate {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Memory component name is required.');
    const content = String(input.content || '').trim();
    if (!content) throw new Error('Memory component content is required.');
    const tags = this.normalizeTags(input.tags || []);
    if (!tags.length) throw new Error('At least one hierarchical tag is required.');
    return {
      name,
      slug: this.slugify(name),
      description: String(input.description || '').trim(),
      tags,
      content,
      kind: input.kind === 'folder' ? 'folder' : 'file',
    };
  }

  update(prepared: MemoryLabPreparedUpdate): MemoryLabWriteResult {
    this.ensure();
    const index = this.loadIndex();
    const now = new Date().toISOString();
    const existing = index.components[prepared.slug];
    const componentPath = prepared.kind === 'folder'
      ? path.join(this.componentsDir, prepared.slug)
      : path.join(this.componentsDir, `${prepared.slug}.md`);
    const coreMd = prepared.kind === 'folder'
      ? path.join(componentPath, 'memory.md')
      : componentPath;
    this.assertInside(this.componentsDir, componentPath);
    this.assertInside(this.componentsDir, coreMd);
    if (prepared.kind === 'folder') fs.mkdirSync(componentPath, { recursive: true });
    fs.mkdirSync(path.dirname(coreMd), { recursive: true });
    fs.writeFileSync(coreMd, prepared.content, 'utf-8');

    index.components[prepared.slug] = {
      name: prepared.name,
      description: prepared.description,
      tags: prepared.tags,
      path: componentPath,
      coreMd,
      kind: prepared.kind,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const normalized = this.normalizeIndex(index);
    this.saveIndex(normalized);
    return {
      ok: true,
      root: this.rootDir,
      indexPath: this.indexPath,
      componentsDir: this.componentsDir,
      instructions: this.instructions(),
      index: normalized,
      component: normalized.components[prepared.slug],
      slug: prepared.slug,
    };
  }

  reindex(): MemoryLabWriteResult {
    this.ensure();
    const index = this.normalizeIndex(this.loadIndex());
    this.saveIndex(index);
    return {
      ok: true,
      root: this.rootDir,
      indexPath: this.indexPath,
      componentsDir: this.componentsDir,
      instructions: this.instructions(),
      index,
    };
  }

  formatRead(result: MemoryLabReadResult): string {
    const payload = {
      ok: result.ok,
      root: result.root,
      indexPath: result.indexPath,
      componentsDir: result.componentsDir,
      instructions: result.instructions,
      index: result.index,
      component: result.component,
      error: result.error,
    };
    return `[memory_lab_read]\n${JSON.stringify(payload, null, 2)}`;
  }

  formatWrite(prefix: string, result: MemoryLabWriteResult): string {
    const payload = {
      ok: result.ok,
      root: result.root,
      indexPath: result.indexPath,
      componentsDir: result.componentsDir,
      instructions: result.instructions,
      slug: result.slug,
      component: result.component,
      index: result.index,
      error: result.error,
      rebuildReceipt: result.rebuildReceipt,
    };
    return `[${prefix}]\n${JSON.stringify(payload, null, 2)}`;
  }

  normalizeIndex(raw: Partial<MemoryLabIndex> | null | undefined): MemoryLabIndex {
    const source = raw && typeof raw === 'object' ? raw : {};
    const index: MemoryLabIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      tags: {},
      components: {},
    };
    const rawComponents = source.components && typeof source.components === 'object' ? source.components : {};
    for (const [rawSlug, rawMeta] of Object.entries(rawComponents)) {
      const meta = rawMeta as Partial<MemoryLabComponent>;
      const name = String(meta.name || rawSlug || '').trim();
      const slug = this.slugify(rawSlug || name);
      if (!slug || !name) continue;
      const kind = meta.kind === 'folder' ? 'folder' : 'file';
      const componentPath = kind === 'folder'
        ? path.join(this.componentsDir, slug)
        : path.join(this.componentsDir, `${slug}.md`);
      const coreMd = kind === 'folder' ? path.join(componentPath, 'memory.md') : componentPath;
      const tags = this.normalizeTags(Array.isArray(meta.tags) ? meta.tags : []);
      index.components[slug] = {
        name,
        description: String(meta.description || '').trim(),
        tags,
        path: this.safeComponentPath(String(meta.path || componentPath), componentPath),
        coreMd: this.safeComponentPath(String(meta.coreMd || coreMd), coreMd),
        kind,
        createdAt: String(meta.createdAt || new Date().toISOString()),
        updatedAt: String(meta.updatedAt || new Date().toISOString()),
      };
    }

    for (const [slug, component] of Object.entries(index.components)) {
      for (const tag of component.tags) this.addTagPath(index, tag);
      for (const tag of component.tags) this.addComponentToDeepestTag(index, tag, slug);
    }

    for (const tag of Object.keys(index.tags)) {
      index.tags[tag].parents = this.sortedUnique(index.tags[tag].parents);
      index.tags[tag].children = this.sortedUnique(index.tags[tag].children);
      index.tags[tag].components = this.sortedUnique(index.tags[tag].components);
    }
    index.tags = Object.fromEntries(Object.entries(index.tags).sort(([a], [b]) => a.localeCompare(b)));
    index.components = Object.fromEntries(Object.entries(index.components).sort(([a], [b]) => a.localeCompare(b)));
    return index;
  }

  normalizeTags(tags: unknown[]): string[] {
    const out: string[] = [];
    for (const value of tags) {
      const raw = String(value || '').trim();
      if (!raw) continue;
      for (const part of raw.split(/[,，\n]+/)) {
        const clean = part.trim();
        if (!clean) continue;
        const tag = clean.startsWith('#') ? clean : `#${clean}`;
        const normalized = tag.replace(/\s+/g, '-').replace(/-+/g, '-');
        if (normalized.length > 1) out.push(normalized);
      }
    }
    return this.sortedUnique(out);
  }

  slugify(name: string): string {
    const cleaned = String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_.\-\u4e00-\u9fff]+/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
    if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('Memory component slug is invalid.');
    return cleaned;
  }

  private emptyIndex(): MemoryLabIndex {
    return { version: 1, updatedAt: new Date().toISOString(), tags: {}, components: {} };
  }

  private loadIndex(): MemoryLabIndex {
    try {
      return this.normalizeIndex(JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')));
    } catch {
      return this.emptyIndex();
    }
  }

  private saveIndex(index: MemoryLabIndex): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.mkdirSync(this.componentsDir, { recursive: true });
    fs.writeFileSync(this.indexPath, JSON.stringify({ ...index, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
  }

  private addTagPath(index: MemoryLabIndex, tag: string): void {
    const chain = this.tagChain(tag);
    for (const node of chain) this.ensureTag(index, node);
    for (let i = 1; i < chain.length; i++) {
      const parent = chain[i - 1];
      const child = chain[i];
      index.tags[parent].children.push(child);
      index.tags[child].parents.push(parent);
    }
  }

  private addComponentToDeepestTag(index: MemoryLabIndex, tag: string, slug: string): void {
    this.addTagPath(index, tag);
    index.tags[tag].components.push(slug);
  }

  private ensureTag(index: MemoryLabIndex, tag: string): void {
    if (!index.tags[tag]) index.tags[tag] = { parents: [], children: [], components: [] };
  }

  private tagChain(tag: string): string[] {
    const body = tag.replace(/^#/, '');
    const parts = body.split('-').filter(Boolean);
    const chain: string[] = [];
    for (let i = 1; i <= parts.length; i++) chain.push(`#${parts.slice(0, i).join('-')}`);
    return chain.length ? chain : [tag];
  }

  private resolveComponentSlug(index: MemoryLabIndex, selector: string): string | null {
    const cleaned = selector.trim();
    if (index.components[cleaned]) return cleaned;
    let slug = '';
    try { slug = this.slugify(cleaned); } catch { slug = ''; }
    if (slug && index.components[slug]) return slug;
    const lower = cleaned.toLowerCase();
    return Object.entries(index.components).find(([, meta]) => meta.name.toLowerCase() === lower)?.[0] || null;
  }

  private readComponentContent(meta: MemoryLabComponent): string {
    const core = this.safeComponentPath(meta.coreMd, meta.coreMd);
    this.assertInside(this.componentsDir, core);
    return fs.existsSync(core) ? fs.readFileSync(core, 'utf-8') : '';
  }

  private safeComponentPath(candidate: string, fallback: string): string {
    const resolved = path.resolve(candidate || fallback);
    return this.isInside(this.componentsDir, resolved) ? resolved : path.resolve(fallback);
  }

  private assertInside(parent: string, child: string): void {
    if (!this.isInside(parent, child)) throw new Error(`Path escapes Memory Lab components directory: ${child}`);
  }

  private isInside(parent: string, child: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  }

  private sortedUnique(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }
}
