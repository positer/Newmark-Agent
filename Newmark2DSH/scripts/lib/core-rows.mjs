/**
 * Discover Newmark Core's rows, components and composition from what is on disk.
 *
 * The bundle gains components over time, so nothing here may name a component. Every
 * gate and harness asks this module instead, and a new component is picked up by adding
 * `components/<name>/` and composing it from the core row — no gate edits.
 *
 * Two shapes matter here and they are not the same shape:
 *
 *   rows        — what `cordis.patch.yml` declares to the Loader. The bundle declares
 *                 one row for itself plus the harness-declared rows (the Dev preset).
 *   components  — the nested packages under `components/`, each with its own manifest so
 *                 the client-module registry still treats it as a package. They are
 *                 loaded by the core row, from paths, not addressed by rows.
 *
 * The patch is parsed with a deliberately small reader rather than a YAML library: the
 * only structure needed is the ordered list of `- id:` rows and the `name:` of each,
 * and a gate must not depend on a package that may not be resolvable from the
 * workspace.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROW_ID = /^ {4}- id: (.+)$/;
const ROW_NAME = /^ {6}name: '([^']+)'$/;

/** The bundle's Loader rows, in declaration order. */
export function readRows(pkgDir) {
  const text = fs.readFileSync(path.join(pkgDir, 'cordis.patch.yml'), 'utf8');
  const rows = [];
  let current = null;
  for (const line of text.split('\n')) {
    const id = line.match(ROW_ID);
    if (id) {
      current = { id: id[1].trim(), name: '' };
      rows.push(current);
      continue;
    }
    const name = line.match(ROW_NAME);
    if (name && current && !current.name) current.name = name[1];
  }
  return rows;
}

/** The bundle's own row: the one that names the package itself. */
export function readBundleRow(pkgDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  return readRows(pkgDir).find((row) => row.name === manifest.name);
}

/**
 * Every component package: a directory under `components/` that carries its own
 * manifest. That manifest is what keeps the client-module registry from seeing the
 * bundle's package twice.
 */
export function readComponents(pkgDir) {
  const root = path.join(pkgDir, 'components');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => fs.existsSync(path.join(root, name, 'package.json')))
    .sort()
    .map((name) => ({
      dir: name,
      path: path.join(root, name),
      manifest: JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8')),
    }));
}

/**
 * The rows that address a component package.
 *
 * Component packages are discovered by their manifests rather than by the bundle's
 * `dependencies`, because the bundle no longer declares any: addressing a component as a
 * dependency needed a `file:` link, and pnpm resolves those against the project root, so
 * a registry install failed with ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND. This bundle must
 * declare no such row, and this function is what proves it.
 */
export function readComponentRows(pkgDir) {
  const names = new Set(readComponents(pkgDir).map((component) => component.manifest.name));
  return readRows(pkgDir).filter((row) => names.has(row.name));
}

/**
 * The component modules the core row composes, as package-relative paths.
 *
 * Read from the row's own source, so a component that is added to `components/` but not
 * composed is visible as exactly that: a directory with no import.
 */
export function readComposedComponents(pkgDir) {
  const source = fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8');
  return [...source.matchAll(/import\(\s*'(\.\/components\/[^']+)'\s*\)/g)].map((match) => match[1]);
}

/** Every module a fresh install loads: the bundle entries, plus each component's entry. */
export function entryPoints(pkgDir) {
  const entries = ['index.js'];
  for (const candidate of ['client.js']) {
    if (fs.existsSync(path.join(pkgDir, candidate))) entries.push(candidate);
  }
  for (const component of readComponents(pkgDir)) entries.push(`components/${component.dir}/index.js`);
  return entries;
}

/** Every `.js` file under the bundle, relative and POSIX-separated. */
export function allSourceFiles(pkgDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) found.push(path.relative(pkgDir, full).replace(/\\/g, '/'));
    }
  };
  walk(pkgDir);
  return found.sort();
}
