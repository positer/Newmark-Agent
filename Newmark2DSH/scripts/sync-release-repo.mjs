// Sync the release repository from the package source, preserving the repo's own files.
//
// Recreated after the temp copy was cleaned up. Copies exactly what the manifest's
// `files` patterns cover (plus package.json, which npm always ships and never lists),
// then points the manifest at this repository.
//
// It also REMOVES: a file the package no longer has must leave the stage, or the release
// ships a file the source deleted. That is not hypothetical — 0.2.16 deleted
// `lib/preset-row.js`, and the first run of this flow would have published it anyway,
// because copying is all this script did. The sweep is restricted to the same `files`
// patterns, so the repository's own files (README.md, .github/, .gitignore) are never the
// package's to delete.
import fs from 'node:fs';
import path from 'node:path';

const workspace = process.argv[2];
const pkgDir = path.join(workspace, 'packages', 'newmark-core');
const stage = process.argv[3];

const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const patterns = manifest.files.map(
  (p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$'),
);
const covered = (relative) => relative === 'package.json' || patterns.some((rx) => rx.test(relative));

const collected = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      const relative = path.relative(pkgDir, full).replace(/\\/g, '/');
      if (covered(relative)) collected.push(relative);
    }
  }
};
walk(pkgDir);

let changed = 0;
for (const relative of collected) {
  const target = path.join(stage, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const source = fs.readFileSync(path.join(pkgDir, relative));
  const before = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (!before || !before.equals(source)) {
    changed += 1;
    console.log(`  updated ${relative}`);
  }
  fs.writeFileSync(target, source);
}

/* The deletion pass. `collected` is the whole source-side set, so anything in the stage that
 * the manifest's patterns cover and that is not in it was deleted from the package. */
const present = new Set(collected);
const removed = [];
const sweep = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sweep(full);
      continue;
    }
    const relative = path.relative(stage, full).replace(/\\/g, '/');
    if (!covered(relative) || present.has(relative)) continue;
    fs.rmSync(full);
    removed.push(relative);
  }
};
sweep(stage);
for (const relative of removed) console.log(`  removed ${relative}`);

const stagedPath = path.join(stage, 'package.json');
const staged = JSON.parse(fs.readFileSync(stagedPath, 'utf8'));
staged.repository = { type: 'git', url: 'git+https://github.com/positer/newmark2dsh.git' };
fs.writeFileSync(stagedPath, JSON.stringify(staged, null, 2) + '\n', 'utf8');

console.log(`copied ${collected.length}, changed ${changed}, removed ${removed.length}`);
console.log(`version ${staged.version}`);
console.log(`dependencies ${JSON.stringify(staged.dependencies || {})}`);
for (const component of ['memorylab', 'computeruse', 'agent-api', 'newmate', 'heartbeat']) {
  const m = JSON.parse(fs.readFileSync(path.join(stage, 'components', component, 'package.json'), 'utf8'));
  console.log(`  ${component}: ${m.version}`);
}
