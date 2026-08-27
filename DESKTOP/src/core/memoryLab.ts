import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

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
  revision?: number;
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
  expectedUpdatedAt?: string;
  reason?: string;
  source?: string;
}

export interface MemoryLabPatchInput {
  component: string;
  name?: string;
  description?: string;
  tags?: string[];
  tagPaths?: string[][];
  content?: string;
  contentAppend?: string;
  oldText?: string;
  newText?: string;
  replaceAll?: boolean;
  kind?: MemoryLabComponentKind;
  expectedUpdatedAt?: string;
  reason?: string;
  source?: string;
}

export interface MemoryLabPreparedUpdate extends MemoryLabUpdateInput {
  slug: string;
  description: string;
  tags: string[];
  tagPaths: string[][];
  content: string;
  kind: MemoryLabComponentKind;
  expectedUpdatedAt: string;
  reason: string;
  source: string;
}

export interface MemoryLabQueryResult {
  ok: boolean;
  query: string;
  considered: number;
  selected: number;
  stoppedEarly: boolean;
  maxChars: number;
  hits: Array<{
    slug: string;
    score: number;
    matchedBy: string[];
    meta: MemoryLabComponent;
    content: string;
  }>;
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

export interface MemoryLabVisualizationResult extends MemoryLabReadResult {
  componentContents: Record<string, string>;
  relationVersion: string;
  loadedAt: string;
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
    operation: 'update' | 'delete' | 'reindex';
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
  public archiveDir: string;
  public policyLogPath: string;

  private preferredLanguage: 'auto' | 'en' | 'zh' = 'auto';
  private componentContentCache = new Map<string, { signature: string; content: string }>();
  private componentContentCacheChars = 0;
  private readonly componentContentCacheLimitChars = 32 * 1024 * 1024;
  private indexCache: MemoryLabIndex | null = null;
  private initialized = false;

  constructor(public rootPath: string, preferredLanguage: string = 'auto') {
    this.setPreferredLanguage(preferredLanguage);
    this.rootDir = path.join(rootPath, 'Memory Lab');
    this.componentsDir = path.join(this.rootDir, 'components');
    this.indexPath = path.join(this.rootDir, 'index.json');
    this.archiveDir = path.join(this.rootDir, 'archive');
    this.policyLogPath = path.join(this.rootDir, 'policy.jsonl');
    this.ensure();
  }

  setPreferredLanguage(language: string): void {
    this.preferredLanguage = language === 'zh' || language === 'en' ? language : 'auto';
  }

  ensure(): void {
    if (this.initialized) return;
    fs.mkdirSync(this.componentsDir, { recursive: true });
    fs.mkdirSync(this.archiveDir, { recursive: true });
    if (!fs.existsSync(this.indexPath)) {
      this.saveIndex(this.emptyIndex());
      this.initialized = true;
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
      this.indexCache = this.normalizeIndex(raw).index;
    } catch {
      this.saveIndex(this.emptyIndex());
    }
    this.initialized = true;
  }

  instructions(): string {
    return [
      'Memory Lab stores persistent local memory for Newmark Agent.',
      `Root: ${this.rootDir}`,
      `Index: ${this.indexPath}`,
      `Components: ${this.componentsDir}`,
      'Use memory_lab_read to inspect index.json before deciding what memory is relevant.',
      'Use memory_lab_query for bounded task-relevant retrieval; do not inject the complete index when a focused query is sufficient.',
      'Use memory_lab_read with component/name/slug to read a component core markdown file.',
      'Use memory_lab_update only when the user asks to create or update durable memory. Create with name, tags, and content; patch an existing component with component plus only changed fields.',
      'For small body edits prefer contentAppend or oldText/newText over resending the complete content.',
      'For an existing component, pass expectedUpdatedAt from the latest read/query result. A stale update is rejected instead of overwriting newer memory.',
      'Use memory_lab_delete only when the user explicitly asks to forget/remove durable memory. Delete moves the prior revision to Memory Lab/archive and records a policy event.',
      'Every mutation should include a concise reason and source. ADD, UPDATE, and DELETE decisions are append-only in policy.jsonl and are recoverable from archive.',
      'The memory_lab_read result includes the complete existing tag set, parent/child DAG, aliases, component memberships, and component tagPaths. Supply that structure when deciding an update.',
      'When reusing an existing tag that already has parents, preserve at least one established full parent path ending at that tag. Never submit that child as a new bare root unless the user explicitly changes its hierarchy.',
      'Tag names are independent labels. Express hierarchy with tagPaths, for example [["#物理", "#理论物理"], ["#数学", "#理论物理"]]. A tag may have multiple parents and children.',
      'Legacy path tags use slash separators: #A/B/C is migrated to #A -> #B -> #C during every rebuild. Hyphens remain part of one tag name and commonly replace spaces.',
      'Cross-language synonyms share one tag node. The current user language selects the primary tag name and other high-confidence synonyms remain in aliases.',
      'Every rebuild also migrates legacy tag names that contain parent/child direction wording or embedded path arrows into independent nodes and edges.',
      'Do not inject index content or memory component content into the system prompt; retrieve it through this tool only when needed.',
    ].join('\n');
  }

  tagPathsEndingAt(index: MemoryLabIndex, tag: string): string[][] {
    const target = String(tag || '');
    if (!target || !index.tags[target]) return [];
    const paths: string[][] = [];
    const visit = (current: string, suffix: string[], seen: Set<string>): void => {
      if (seen.has(current)) return;
      const nextSeen = new Set(seen);
      nextSeen.add(current);
      const parents = index.tags[current]?.parents || [];
      const nextSuffix = [current, ...suffix];
      if (!parents.length) {
        paths.push(nextSuffix);
        return;
      }
      for (const parent of parents) visit(parent, nextSuffix, nextSeen);
    };
    visit(target, [], new Set());
    return Array.from(new Map(paths.map(pathValue => [pathValue.join('>'), pathValue])).values());
  }

  read(componentSelector = ''): MemoryLabReadResult {
    this.ensure();
    const index = this.loadIndex(true);
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
      result.component = { slug, meta, content: this.readComponentContent(meta, true) };
    }
    return result;
  }

  visualizationSnapshot(): MemoryLabVisualizationResult {
    this.ensure();
    const index = this.loadIndex(true);
    const componentContents: Record<string, string> = {};
    for (const [slug, meta] of Object.entries(index.components)) {
      componentContents[slug] = this.readComponentContent(meta, true);
    }
    const relations = {
      tags: Object.entries(index.tags).map(([tag, node]) => [
        tag,
        node.parents,
        node.children,
        node.components,
      ]),
      components: Object.entries(index.components).map(([slug, meta]) => [
        slug,
        meta.name,
        meta.tags,
        meta.tagPaths,
        meta.updatedAt,
        Math.max(1, Number(meta.revision || 1)),
      ]),
    };
    return {
      ok: true,
      root: this.rootDir,
      indexPath: this.indexPath,
      componentsDir: this.componentsDir,
      instructions: this.instructions(),
      index,
      componentContents,
      relationVersion: this.sha256(JSON.stringify(relations)),
      loadedAt: new Date().toISOString(),
    };
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
      expectedUpdatedAt: String(input.expectedUpdatedAt || '').trim(),
      reason: String(input.reason || '').trim(),
      source: String(input.source || '').trim(),
    };
  }

  preparePatch(input: MemoryLabPatchInput): MemoryLabPreparedUpdate {
    const selector = String(input.component || '').trim();
    if (!selector) throw new Error('Memory component is required for a patch.');
    const current = this.read(selector);
    if (!current.ok || !current.component) throw new Error(current.error || `Memory component not found: ${selector}`);
    const existing = current.component.meta;
    const oldContent = current.component.content;
    let content = input.content !== undefined ? String(input.content) : oldContent;
    if (input.contentAppend !== undefined) content = `${oldContent}${String(input.contentAppend)}`;
    if (input.oldText !== undefined) {
      const oldText = String(input.oldText);
      if (!oldText) throw new Error('oldText must not be empty.');
      const matches = oldContent.split(oldText).length - 1;
      if (!matches) throw new Error('oldText was not found in the Memory Lab component.');
      if (matches > 1 && input.replaceAll !== true) throw new Error(`oldText matched ${matches} places; pass replaceAll=true or a unique fragment.`);
      content = input.replaceAll === true
        ? oldContent.split(oldText).join(String(input.newText || ''))
        : oldContent.replace(oldText, String(input.newText || ''));
    }
    const name = input.name === undefined ? existing.name : String(input.name);
    if (this.slugify(name) !== current.component.slug) {
      throw new Error('Renaming a Memory Lab component is not supported by incremental patch; create the new component then delete the old one.');
    }
    return this.prepareUpdate({
      name,
      description: input.description === undefined ? existing.description : String(input.description),
      tags: input.tags === undefined ? existing.tags : input.tags,
      tagPaths: input.tagPaths === undefined ? existing.tagPaths : input.tagPaths,
      content,
      kind: input.kind === undefined ? existing.kind : input.kind,
      expectedUpdatedAt: String(input.expectedUpdatedAt || existing.updatedAt),
      reason: input.reason,
      source: input.source,
    });
  }

  update(prepared: MemoryLabPreparedUpdate): MemoryLabWriteResult {
    this.ensure();
    const index = this.loadIndex();
    const now = new Date().toISOString();
    const existing = index.components[prepared.slug];
    if (existing && prepared.expectedUpdatedAt && prepared.expectedUpdatedAt !== existing.updatedAt) {
      throw new Error(`Memory component changed since it was read: ${prepared.slug}`);
    }
    const componentPath = prepared.kind === 'folder'
      ? path.join(this.componentsDir, prepared.slug)
      : path.join(this.componentsDir, `${prepared.slug}.md`);
    const coreMd = prepared.kind === 'folder'
      ? path.join(componentPath, 'memory.md')
      : componentPath;
    this.assertInside(this.componentsDir, componentPath);
    this.assertInside(this.componentsDir, coreMd);
    if (existing) {
      this.archiveComponentRevision(prepared.slug, existing);
      if (existing.kind !== prepared.kind) {
        const priorContainer = existing.kind === 'folder' ? existing.path : existing.coreMd;
        this.assertInside(this.componentsDir, priorContainer);
        if (fs.existsSync(priorContainer)) fs.rmSync(priorContainer, { recursive: existing.kind === 'folder', force: false });
      }
    }
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
      revision: Math.max(1, Number(existing?.revision || 0) + 1),
    };
    const normalized = this.normalizeIndex(index);
    this.saveIndex(normalized.index);
    const saved = normalized.index.components[prepared.slug];
    if (saved) this.rememberComponentContent(saved, prepared.content);
    this.appendPolicyEvent({
      operation: existing ? 'update' : 'add',
      slug: prepared.slug,
      reason: prepared.reason || (existing ? 'Replace an existing durable memory revision.' : 'Create a durable memory component.'),
      source: prepared.source || 'memory_lab_update',
      previousUpdatedAt: existing?.updatedAt || '',
      updatedAt: normalized.index.components[prepared.slug]?.updatedAt || now,
      revision: normalized.index.components[prepared.slug]?.revision || 1,
      contentSha256: this.sha256(prepared.content),
    });
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

  query(input: { query: string; limit?: number; maxChars?: number }): MemoryLabQueryResult {
    this.ensure();
    const index = this.loadIndex();
    const query = String(input.query || '').trim();
    if (!query) throw new Error('Memory query is required.');
    const limit = Math.max(1, Math.min(12, Math.floor(Number(input.limit || 5))));
    const maxChars = Math.max(1000, Math.min(48000, Math.floor(Number(input.maxChars || 12000))));
    const normalizedQuery = query.toLowerCase();
    const words = normalizedQuery.split(/[^\p{L}\p{N}_.#-]+/u).map(value => value.trim()).filter(value => value.length > 1);
    const cjkTerms = Array.from(normalizedQuery.matchAll(/[\u3400-\u9fff]{2,}/g))
      .flatMap(match => Array.from({ length: Math.max(0, match[0].length - 1) }, (_, index) => match[0].slice(index, index + 2)));
    const terms = Array.from(new Set([...words, ...cjkTerms]));
    const candidates = Object.entries(index.components).map(([slug, meta]) => {
      const content = this.readComponentContent(meta).slice(0, 64000);
      const fields = {
        name: meta.name.toLowerCase(),
        description: meta.description.toLowerCase(),
        tags: [...meta.tags, ...meta.tagPaths.flat()].join(' ').toLowerCase(),
        content: content.toLowerCase(),
      };
      let score = 0;
      const matchedBy: string[] = [];
      const add = (field: keyof typeof fields, weight: number): void => {
        const exact = fields[field].includes(normalizedQuery);
        const matches = terms.filter(term => fields[field].includes(term)).length;
        if (!exact && !matches) return;
        score += (exact ? weight * 2 : 0) + matches * weight;
        matchedBy.push(field);
      };
      add('name', 12);
      add('tags', 9);
      add('description', 6);
      add('content', 2);
      return { slug, score, matchedBy, meta, content };
    }).filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score || b.meta.updatedAt.localeCompare(a.meta.updatedAt) || a.slug.localeCompare(b.slug));
    const hits: MemoryLabQueryResult['hits'] = [];
    let chars = 0;
    const best = candidates[0]?.score || 0;
    let stoppedEarly = false;
    for (const candidate of candidates) {
      if (hits.length >= limit || (hits.length > 0 && candidate.score < best * 0.35)) {
        stoppedEarly = true;
        break;
      }
      const remaining = maxChars - chars;
      if (remaining < 200) {
        stoppedEarly = true;
        break;
      }
      const content = candidate.content.slice(0, remaining);
      hits.push({ ...candidate, content });
      chars += content.length;
    }
    return { ok: true, query, considered: Object.keys(index.components).length, selected: hits.length, stoppedEarly, maxChars, hits };
  }

  formatQuery(result: MemoryLabQueryResult): string {
    return `[memory_lab_query]\n${JSON.stringify(result, null, 2)}`;
  }

  delete(componentSelector: string, options: { expectedUpdatedAt?: string; reason?: string; source?: string } = {}): MemoryLabWriteResult {
    this.ensure();
    const index = this.loadIndex();
    const slug = this.resolveComponentSlug(index, String(componentSelector || ''));
    if (!slug) throw new Error(`Memory component not found: ${componentSelector}`);
    const existing = index.components[slug];
    if (options.expectedUpdatedAt && options.expectedUpdatedAt !== existing.updatedAt) {
      throw new Error(`Memory component changed since it was read: ${slug}`);
    }
    const archivedPath = this.archiveComponentRevision(slug, existing);
    const componentPath = existing.kind === 'folder' ? existing.path : existing.coreMd;
    this.forgetComponentContent(existing);
    this.assertInside(this.componentsDir, componentPath);
    if (fs.existsSync(componentPath)) fs.rmSync(componentPath, { recursive: existing.kind === 'folder', force: false });
    delete index.components[slug];
    const normalized = this.normalizeIndex(index);
    this.saveIndex(normalized.index);
    this.appendPolicyEvent({
      operation: 'delete',
      slug,
      reason: String(options.reason || '').trim() || 'Remove obsolete durable memory.',
      source: String(options.source || '').trim() || 'memory_lab_delete',
      previousUpdatedAt: existing.updatedAt,
      revision: existing.revision,
      archivedPath,
    });
    return {
      ok: true,
      root: this.rootDir,
      indexPath: this.indexPath,
      componentsDir: this.componentsDir,
      instructions: this.instructions(),
      index: normalized.index,
      slug,
      rebuildReceipt: {
        operation: 'delete',
        completed: true,
        indexUpdatedAt: normalized.index.updatedAt,
        verifiedAt: new Date().toISOString(),
        slug,
      },
    };
  }

  reindex(): MemoryLabWriteResult {
    this.ensure();
    const normalized = this.normalizeIndex(this.loadIndex(true));
    this.saveIndex(normalized.index);
    this.pruneComponentContentCache(normalized.index);
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
        revision: Math.max(1, Math.floor(Number(meta.revision || 1))),
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

  private loadIndex(forceDisk = false): MemoryLabIndex {
    if (!forceDisk && this.indexCache) return this.indexCache;
    try {
      this.indexCache = this.normalizeIndex(JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'))).index;
      return this.indexCache;
    } catch {
      this.indexCache = this.emptyIndex();
      return this.indexCache;
    }
  }

  private saveIndex(index: MemoryLabIndex): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.mkdirSync(this.componentsDir, { recursive: true });
    index.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
    this.indexCache = index;
  }

  private archiveComponentRevision(slug: string, component: MemoryLabComponent): string {
    fs.mkdirSync(this.archiveDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.archiveDir, `${stamp}-${slug}-r${Math.max(1, Number(component.revision || 1))}.md`);
    this.assertInside(this.archiveDir, target);
    const content = this.readComponentContent(component);
    const header = [
      '---',
      `slug: ${JSON.stringify(slug)}`,
      `name: ${JSON.stringify(component.name)}`,
      `revision: ${Math.max(1, Number(component.revision || 1))}`,
      `updatedAt: ${JSON.stringify(component.updatedAt)}`,
      `kind: ${component.kind}`,
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(target, `${header}${content}`, 'utf-8');
    return target;
  }

  private appendPolicyEvent(event: Record<string, unknown>): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const record = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      ...event,
    };
    fs.appendFileSync(this.policyLogPath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  private sha256(value: string): string {
    return crypto.createHash('sha256').update(String(value || ''), 'utf-8').digest('hex');
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

  private readComponentContent(meta: MemoryLabComponent, forceDisk = false): string {
    const core = this.safeComponentPath(meta.coreMd, meta.coreMd);
    this.assertInside(this.componentsDir, core);
    const signature = this.componentContentSignature(meta, core);
    const cached = this.componentContentCache.get(core);
    if (!forceDisk && cached?.signature === signature) {
      this.componentContentCache.delete(core);
      this.componentContentCache.set(core, cached);
      return cached.content;
    }
    if (cached) {
      this.componentContentCache.delete(core);
      this.componentContentCacheChars -= cached.content.length;
    }
    const content = fs.existsSync(core) ? fs.readFileSync(core, 'utf-8') : '';
    this.rememberComponentContent(meta, content, core);
    return content;
  }

  private componentContentSignature(meta: MemoryLabComponent, resolvedCore = path.resolve(meta.coreMd)): string {
    return `${resolvedCore}\u0000${meta.updatedAt}\u0000${Math.max(1, Number(meta.revision || 1))}`;
  }

  private rememberComponentContent(meta: MemoryLabComponent, content: string, resolvedCore?: string): void {
    const core = resolvedCore || this.safeComponentPath(meta.coreMd, meta.coreMd);
    const previous = this.componentContentCache.get(core);
    if (previous) {
      this.componentContentCache.delete(core);
      this.componentContentCacheChars -= previous.content.length;
    }
    if (content.length > this.componentContentCacheLimitChars) return;
    this.componentContentCache.set(core, {
      signature: this.componentContentSignature(meta, core),
      content,
    });
    this.componentContentCacheChars += content.length;
    while (this.componentContentCacheChars > this.componentContentCacheLimitChars && this.componentContentCache.size) {
      const oldest = this.componentContentCache.entries().next().value as [string, { signature: string; content: string }] | undefined;
      if (!oldest) break;
      this.componentContentCache.delete(oldest[0]);
      this.componentContentCacheChars -= oldest[1].content.length;
    }
  }

  private forgetComponentContent(meta: MemoryLabComponent): void {
    const core = this.safeComponentPath(meta.coreMd, meta.coreMd);
    const cached = this.componentContentCache.get(core);
    if (!cached) return;
    this.componentContentCache.delete(core);
    this.componentContentCacheChars -= cached.content.length;
  }

  private pruneComponentContentCache(index: MemoryLabIndex): void {
    const valid = new Set(Object.values(index.components).map(meta => this.safeComponentPath(meta.coreMd, meta.coreMd)));
    for (const [core, cached] of this.componentContentCache) {
      if (valid.has(core)) continue;
      this.componentContentCache.delete(core);
      this.componentContentCacheChars -= cached.content.length;
    }
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
