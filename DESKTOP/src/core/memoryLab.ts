import * as fs from 'fs';
import * as path from 'path';

export type MemoryLabComponentKind = 'file' | 'folder';

export interface MemoryLabTagNode {
  parents: string[];
  children: string[];
  components: string[];
  aliases: string[];
}

export interface MemoryLabComponent {
  name: string;
  description: string;
  tags: string[];
  tagPaths: string[][];
  path: string;
  coreMd: string;
  kind: MemoryLabComponentKind;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryLabIndex {
  version: 2;
  updatedAt: string;
  preferredLanguage?: 'auto' | 'en' | 'zh';
  tags: Record<string, MemoryLabTagNode>;
  components: Record<string, MemoryLabComponent>;
}

export interface MemoryLabUpdateInput {
  name: string;
  description?: string;
  tags: string[];
  tagPaths?: string[][];
  content: string;
  kind?: MemoryLabComponentKind;
}

export interface MemoryLabPreparedUpdate extends MemoryLabUpdateInput {
  slug: string;
  description: string;
  tags: string[];
  tagPaths: string[][];
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
  migrationWarnings?: string[];
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

  private preferredLanguage: 'auto' | 'en' | 'zh' = 'auto';

  constructor(public rootPath: string, preferredLanguage: string = 'auto') {
    this.setPreferredLanguage(preferredLanguage);
    this.rootDir = path.join(rootPath, 'Memory Lab');
    this.componentsDir = path.join(this.rootDir, 'components');
    this.indexPath = path.join(this.rootDir, 'index.json');
    this.ensure();
  }

  setPreferredLanguage(language: string): void {
    this.preferredLanguage = language === 'zh' || language === 'en' ? language : 'auto';
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
      'Use memory_lab_update only when the user asks to create or update durable memory, passing name, description, tags, optional tagPaths, content, and optional kind=file|folder.',
      'Tag names are independent labels. Express hierarchy with tagPaths, for example [["#物理", "#理论物理"], ["#数学", "#理论物理"]]. A tag may have multiple parents and children.',
      'Legacy path tags use slash separators: #A/B/C is migrated to #A -> #B -> #C during every rebuild. Hyphens remain part of one tag name and commonly replace spaces.',
      'Cross-language synonyms share one tag node. The current user language selects the primary tag name and other high-confidence synonyms remain in aliases.',
      'Every rebuild also migrates legacy tag names that contain parent/child direction wording or embedded path arrows into independent nodes and edges.',
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
    const normalized = this.normalizeTagInput(input.tags || [], input.tagPaths || []);
    if (!normalized.tags.length) throw new Error('At least one tag is required.');
    this.assertAcyclicPaths(normalized.tagPaths);
    return {
      name,
      slug: this.slugify(name),
      description: String(input.description || '').trim(),
      tags: normalized.tags,
      tagPaths: normalized.tagPaths,
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
      tagPaths: prepared.tagPaths,
      path: componentPath,
      coreMd,
      kind: prepared.kind,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const normalized = this.normalizeIndex(index);
    this.saveIndex(normalized.index);
    return {
      ok: true,
      root: this.rootDir,
      indexPath: this.indexPath,
      componentsDir: this.componentsDir,
      instructions: this.instructions(),
      index: normalized.index,
      component: normalized.index.components[prepared.slug],
      slug: prepared.slug,
      migrationWarnings: normalized.warnings,
    };
  }

  reindex(): MemoryLabWriteResult {
    this.ensure();
    const normalized = this.normalizeIndex(this.loadIndex());
    this.saveIndex(normalized.index);
    return {
      ok: true,
      root: this.rootDir,
      indexPath: this.indexPath,
      componentsDir: this.componentsDir,
      instructions: this.instructions(),
      index: normalized.index,
      migrationWarnings: normalized.warnings,
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

  normalizeIndex(raw: Partial<MemoryLabIndex> | null | undefined): { index: MemoryLabIndex; warnings: string[] } {
    const source = raw && typeof raw === 'object' ? raw : {};
    const warnings: string[] = [];
    const index: MemoryLabIndex = {
      version: 2,
      updatedAt: new Date().toISOString(),
      tags: {},
      components: {},
    };
    const rawComponents = source.components && typeof source.components === 'object' ? source.components : {};
    const rawTags = source.tags && typeof source.tags === 'object' ? source.tags : {};
    const aliasGroups = this.collectAliasGroups(rawTags as Record<string, Partial<MemoryLabTagNode>>);
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
      const normalizedTags = this.normalizeTagInput(
        Array.isArray(meta.tags) ? meta.tags : [],
        Array.isArray(meta.tagPaths) ? meta.tagPaths : [],
      );
      const canonicalTags = this.canonicalizeTagInput(normalizedTags, aliasGroups);
      index.components[slug] = {
        name,
        description: String(meta.description || '').trim(),
        tags: canonicalTags.tags,
        tagPaths: canonicalTags.tagPaths,
        path: this.safeComponentPath(String(meta.path || componentPath), componentPath),
        coreMd: this.safeComponentPath(String(meta.coreMd || coreMd), coreMd),
        kind,
        createdAt: String(meta.createdAt || new Date().toISOString()),
        updatedAt: String(meta.updatedAt || new Date().toISOString()),
      };
    }

    for (const [slug, component] of Object.entries(index.components)) {
      for (const tag of component.tags) this.ensureTag(index, tag);
      for (const tagPath of component.tagPaths) this.addTagPath(index, tagPath, warnings);
      const pathChildren = new Set(component.tagPaths.flatMap(pathValue => pathValue.slice(0, -1)));
      const terminalTags = new Set(component.tagPaths.map(pathValue => pathValue.at(-1)).filter((tag): tag is string => !!tag));
      for (const tag of component.tags) {
        if (!pathChildren.has(tag) || terminalTags.has(tag)) index.tags[tag].components.push(slug);
      }
    }

    for (const tag of Object.keys(index.tags)) {
      index.tags[tag].parents = this.sortedUnique(index.tags[tag].parents);
      index.tags[tag].children = this.sortedUnique(index.tags[tag].children);
      index.tags[tag].components = this.sortedUnique(index.tags[tag].components);
      index.tags[tag].aliases = this.sortedUnique(aliasGroups.get(tag) || []).filter(alias => alias !== tag);
    }
    index.tags = Object.fromEntries(Object.entries(index.tags).sort(([a], [b]) => a.localeCompare(b)));
    index.components = Object.fromEntries(Object.entries(index.components).sort(([a], [b]) => a.localeCompare(b)));
    index.preferredLanguage = this.preferredLanguage;
    return { index, warnings: this.sortedUnique(warnings) };
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

  private normalizeTagInput(tags: unknown[], tagPaths: unknown[]): { tags: string[]; tagPaths: string[][] } {
    const independent = new Set<string>();
    const paths: string[][] = [];
    for (const rawPath of Array.isArray(tagPaths) ? tagPaths : []) {
      if (!Array.isArray(rawPath)) continue;
      const normalizedPath = rawPath.flatMap(value => this.normalizeTags([value]).flatMap(tag => this.legacyTagPath(tag)));
      if (!normalizedPath.length) continue;
      normalizedPath.forEach(tag => independent.add(tag));
      paths.push(normalizedPath);
    }
    for (const tag of this.normalizeTags(tags)) {
      const legacyPath = this.legacyTagPath(tag);
      legacyPath.forEach(node => independent.add(node));
      paths.push(legacyPath);
    }
    const uniquePaths = Array.from(new Map(paths.map(pathValue => [pathValue.join('\u0000'), pathValue])).values())
      .sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
    return { tags: this.sortedUnique([...independent]), tagPaths: uniquePaths };
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
    return { version: 2, updatedAt: new Date().toISOString(), preferredLanguage: this.preferredLanguage, tags: {}, components: {} };
  }

  private loadIndex(): MemoryLabIndex {
    try {
      return this.normalizeIndex(JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'))).index;
    } catch {
      return this.emptyIndex();
    }
  }

  private saveIndex(index: MemoryLabIndex): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.mkdirSync(this.componentsDir, { recursive: true });
    fs.writeFileSync(this.indexPath, JSON.stringify({ ...index, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
  }

  private addTagPath(index: MemoryLabIndex, chain: string[], warnings: string[]): void {
    for (const node of chain) this.ensureTag(index, node);
    for (let i = 1; i < chain.length; i++) {
      const parent = chain[i - 1];
      const child = chain[i];
      if (parent === child || this.hasPath(index, child, parent)) {
        warnings.push(`Skipped cyclic tag edge: ${parent} -> ${child}`);
        continue;
      }
      index.tags[parent].children.push(child);
      index.tags[child].parents.push(parent);
    }
  }

  private ensureTag(index: MemoryLabIndex, tag: string): void {
    if (!index.tags[tag]) index.tags[tag] = { parents: [], children: [], components: [], aliases: [] };
  }

  private legacyTagPath(tag: string): string[] {
    const body = tag.replace(/^#/, '');
    const directionNormalized = body
      .replace(/\s*(?:父(?:tag|标签)?|parent|子(?:tag|标签)?|child)\s*[:：=]\s*/gi, '')
      .replace(/\s*(?:父级|上级)\s*(?:到|至|->|→|>)\s*/g, '/')
      .replace(/\s*(?:到|至|->|→|=>|≫|>|::|\\)\s*/g, '/');
    const parts = directionNormalized.split('/').map(part => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts.map(part => `#${part}`) : [tag];
  }

  private canonicalizeTagInput(
    input: { tags: string[]; tagPaths: string[][] },
    aliasGroups: Map<string, string[]>,
  ): { tags: string[]; tagPaths: string[][] } {
    const aliases = new Map<string, string>();
    for (const [canonical, values] of aliasGroups) {
      aliases.set(this.tagComparisonKey(canonical), canonical);
      for (const value of values) aliases.set(this.tagComparisonKey(value), canonical);
    }
    const canonical = (tag: string): string => aliases.get(this.tagComparisonKey(tag)) || tag;
    return {
      tags: this.sortedUnique(input.tags.map(canonical)),
      tagPaths: Array.from(new Map(input.tagPaths.map(pathValue => {
        const value = pathValue.map(canonical).filter((tag, index, all) => index === 0 || tag !== all[index - 1]);
        return [value.join('\u0000'), value] as const;
      })).values()).filter(pathValue => pathValue.length),
    };
  }

  private collectAliasGroups(rawTags: Record<string, Partial<MemoryLabTagNode>>): Map<string, string[]> {
    const groups = new Map<string, Set<string>>();
    for (const [rawTag, node] of Object.entries(rawTags)) {
      const names = this.normalizeTags([rawTag, ...(Array.isArray(node.aliases) ? node.aliases : [])])
        .filter(name => this.legacyTagPath(name).length === 1);
      for (const name of names) {
        const key = this.synonymKey(name);
        if (!groups.has(key)) groups.set(key, new Set());
        names.forEach(value => groups.get(key)!.add(value));
      }
    }
    const result = new Map<string, string[]>();
    for (const values of groups.values()) {
      const all = this.sortedUnique([...values]);
      const canonical = this.choosePrimaryTag(all);
      result.set(canonical, all);
    }
    return result;
  }

  private synonymKey(tag: string): string {
    const key = this.tagComparisonKey(tag);
    const known: Record<string, string> = {
      physics: 'physics', '物理': 'physics', mathematics: 'mathematics', math: 'mathematics', '数学': 'mathematics',
      'theoretical-physics': 'theoretical-physics', '理论物理': 'theoretical-physics', agent: 'agent', '智能体': 'agent',
      skill: 'skill', skills: 'skill', '技能': 'skill', memory: 'memory', '记忆': 'memory', model: 'model', '模型': 'model',
      provider: 'provider', '供应商': 'provider', release: 'release', '发布': 'release', code: 'code', '代码': 'code', research: 'research', '研究': 'research',
    };
    return known[key] || key;
  }

  private tagComparisonKey(tag: string): string {
    return String(tag || '').replace(/^#/, '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  }

  private choosePrimaryTag(tags: string[]): string {
    const chinese = tags.filter(tag => /[\u3400-\u9fff]/.test(tag));
    const nonChinese = tags.filter(tag => !/[\u3400-\u9fff]/.test(tag));
    const pool = this.preferredLanguage === 'zh' ? chinese : this.preferredLanguage === 'en' ? nonChinese : [];
    return (pool.length ? pool : tags).sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  }

  private hasPath(index: MemoryLabIndex, from: string, target: string, seen = new Set<string>()): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (index.tags[from]?.children || []).some(child => this.hasPath(index, child, target, seen));
  }

  private assertAcyclicPaths(paths: string[][]): void {
    const index = this.emptyIndex();
    const warnings: string[] = [];
    for (const pathValue of paths) this.addTagPath(index, pathValue, warnings);
    if (warnings.length) throw new Error(warnings[0]);
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
