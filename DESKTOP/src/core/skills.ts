import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SkillInfo {
  name: string;
  path: string;
  enabled: boolean;
  installed: boolean;
  description: string;
  source: 'project' | 'codex' | 'remote';
  url?: string;
}

interface SkillsMeta {
  disabled: string[];
}

export class SkillsManager {
  private skillsDir: string;
  private metaPath: string;

  constructor(root: string) {
    this.skillsDir = path.join(root, 'skills');
    this.metaPath = path.join(this.skillsDir, '.skills.json');
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

  discoverMarket(): SkillInfo[] {
    const installed = new Set(this.list());
    const items: SkillInfo[] = [];
    for (const info of this.listDetailed()) items.push(info);

    const codexRoot = path.join(os.homedir(), '.codex', 'skills');
    for (const dir of this.findSkillDirs(codexRoot, 4, 240)) {
      const parsed = this.parseSkillInfo(dir);
      const name = this.cleanName(parsed.name || path.basename(dir));
      if (!name || items.some(i => i.name === name && i.source !== 'remote')) continue;
      items.push({
        name,
        path: dir,
        enabled: installed.has(name) ? this.isEnabled(name) : false,
        installed: installed.has(name),
        description: parsed.description,
        source: 'codex',
      });
    }

    const remotes: SkillInfo[] = [
      {
        name: 'design-taste-frontend',
        description: 'Anti-slop frontend review and design taste rules.',
        url: 'https://raw.githubusercontent.com/Jonathan-Adly/taste-skill/main/skills/design-taste-frontend/SKILL.md',
        path: '',
        enabled: installed.has('design-taste-frontend') ? this.isEnabled('design-taste-frontend') : false,
        installed: installed.has('design-taste-frontend'),
        source: 'remote',
      },
    ];
    for (const r of remotes) {
      if (!items.some(i => i.name === r.name)) items.push(r);
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

  private parseSkillInfo(dir: string): { name: string; description: string } {
    try {
      const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
      const front = content.match(/^---\s*([\s\S]*?)\s*---/);
      const block = front ? front[1] : content.slice(0, 1000);
      let name = (block.match(/^name:\s*(.+)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
      let description = (block.match(/^description:\s*(.+)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
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
      return { name, description };
    } catch {
      return { name: '', description: '' };
    }
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

  private cleanName(name: string): string {
    return String(name || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').slice(0, 120);
  }
}
