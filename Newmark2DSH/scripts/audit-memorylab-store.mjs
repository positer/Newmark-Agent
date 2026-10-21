/**
 * MemoryLab — a read-only census of the live store.
 *
 * Strictly read-only: nothing is written, and the store's size and hash are compared
 * before and after so a write would abort the run rather than pass unnoticed.
 *
 * It answers two questions:
 *   1. Is the store healthy — index shape, tag graph, per-component bodies, the
 *      archive, and the policy log's own integrity?
 *   2. Did the `contentAppend`/`oldText` selector defect ever damage it? That defect
 *      appended to an empty base, so a damaged component's body would be a small
 *      fragment with its earlier, longer revisions still in `archive/`.
 *
 * Run: node Newmark2DSH/scripts/audit-memorylab-store.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const labDir = path.join(os.homedir(), '.Newmark', 'Memory Lab');
const indexPath = path.join(labDir, 'index.json');

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const before = fs.existsSync(indexPath) ? fs.statSync(indexPath) : null;
const beforeHash = before ? sha(fs.readFileSync(indexPath)) : null;

console.log(`# Memory Lab census`);
console.log(`store: ${labDir}`);
console.log('');

/* ------------------------------------------------------------- the index --- */

const raw = fs.readFileSync(indexPath, 'utf8');
const index = JSON.parse(raw);
const entries = Object.entries(index.components || {});

console.log('# index');
console.log(`  version:              ${index.version}`);
console.log(`  preferredLanguage:    ${index.preferredLanguage}`);
console.log(`  relationshipVersion:  ${String(index.relationshipVersion || '').slice(0, 16)}`);
console.log(`  updatedAt:            ${index.updatedAt}`);
console.log(`  tags:                 ${Object.keys(index.tags || {}).length}`);
console.log(`  components:           ${entries.length}`);
console.log(`  bytes:                ${Buffer.byteLength(raw, 'utf8')}`);
console.log('');

/* --------------------------------------------------------- per component --- */

const tagPathCounts = [];
const anomalies = [];
const rows = [];

for (const [slug, meta] of entries) {
  const corePath = meta.coreMd || meta.path;
  let body = '';
  let readable = false;
  try {
    body = fs.readFileSync(corePath, 'utf8');
    readable = true;
  } catch {
    /* reported below */
  }
  const bytes = Buffer.byteLength(body, 'utf8');
  const hash = readable ? sha(Buffer.from(body, 'utf8')) : null;
  const hashMatches = readable && meta.contentHash ? hash === meta.contentHash : null;
  const bytesMatch = readable && Number.isFinite(meta.bytes) ? meta.bytes === bytes : null;

  const tagPaths = Array.isArray(meta.tagPaths) ? meta.tagPaths : [];
  tagPathCounts.push(tagPaths.length);

  if (!readable) anomalies.push(`${slug}: core markdown is not readable (${corePath})`);
  if (readable && bytes === 0) anomalies.push(`${slug}: body is EMPTY`);
  if (hashMatches === false) anomalies.push(`${slug}: contentHash does not match the body`);
  if (bytesMatch === false) anomalies.push(`${slug}: recorded bytes ${meta.bytes} != actual ${bytes}`);
  if (readable && bytes < 200) anomalies.push(`${slug}: body is only ${bytes} bytes — check for truncation`);

  rows.push({ slug, revision: meta.revision, bytes, tags: (meta.tags || []).length, tagPaths: tagPaths.length, createdAt: meta.createdAt, updatedAt: meta.updatedAt });
}

rows.sort((a, b) => a.bytes - b.bytes);
console.log('# components, smallest body first');
for (const row of rows) {
  console.log(`  ${String(row.bytes).padStart(6)} B  rev ${String(row.revision).padStart(2)}  tags ${String(row.tags).padStart(2)}  paths ${String(row.tagPaths).padStart(3)}  ${row.slug}`);
}
console.log('');

/* ------------------------------------------------------------- archive --- */

const archiveDir = path.join(labDir, 'archive');
const archived = [];
if (fs.existsSync(archiveDir)) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else archived.push({ file: path.relative(archiveDir, full), bytes: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs });
    }
  };
  walk(archiveDir);
}

const bySlug = new Map();
for (const item of archived) {
  const slug = item.file.split(/[\\/]/)[0];
  if (!bySlug.has(slug)) bySlug.set(slug, []);
  bySlug.get(slug).push(item);
}

console.log('# archive');
console.log(`  files:    ${archived.length}`);
console.log(`  folders:  ${bySlug.size}`);
console.log(`  bytes:    ${archived.reduce((sum, item) => sum + item.bytes, 0)}`);
console.log('');

/* ------------------------------- the defect-1 damage pattern, looked for --- */

console.log('# defect-1 scan (a body emptied by an append to an empty base)');
let damaged = 0;
for (const [slug, items] of bySlug) {
  const sizes = items.map((item) => item.bytes).sort((a, b) => b - a);
  const current = entries.find(([key]) => key === slug)?.[1];
  const currentBytes = current ? fs.statSync(current.coreMd || current.path).size : 0;
  // A drop to a small fraction of the largest archived revision is the signature.
  if (sizes.length > 0 && sizes[0] >= 500 && currentBytes > 0 && currentBytes < sizes[0] * 0.25) {
    console.log(`  SUSPECT ${slug}: largest archived revision ${sizes[0]} B, current ${currentBytes} B`);
    damaged += 1;
  }
}
if (damaged === 0) console.log(`  no component has lost most of its body relative to its own history`);
console.log('');

/* --------------------------------------------------------- policy.jsonl --- */

const policyPath = path.join(labDir, 'policy.jsonl');
console.log('# policy log');
if (!fs.existsSync(policyPath)) {
  console.log('  absent');
} else {
  const lines = fs.readFileSync(policyPath, 'utf8').split('\n').filter((line) => line.trim());
  const parsed = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  const actions = parsed.reduce((acc, entry) => {
    const key = String(entry.action || '?');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const withHash = parsed.filter((entry) => entry.contentHash || entry.hash).length;
  const leak = parsed.filter((entry) => JSON.stringify(entry).includes('# ')).length;
  console.log(`  lines:            ${lines.length}`);
  console.log(`  malformed:        ${malformed}`);
  console.log(`  actions:          ${JSON.stringify(actions)}`);
  console.log(`  with a hash:      ${withHash}/${parsed.length}`);
  console.log(`  look like content:${leak}`);
  console.log(`  oldest:           ${parsed[0]?.timestamp || parsed[0]?.at || '(none)'}`);
  console.log(`  newest:           ${parsed[parsed.length - 1]?.timestamp || parsed[parsed.length - 1]?.at || '(none)'}`);
}
console.log('');

/* ------------------------------------------------------------ verdict --- */

console.log('# verdict');
console.log(`  anomalies: ${anomalies.length}`);
for (const line of anomalies) console.log(`    - ${line}`);
console.log('');

const after = fs.statSync(indexPath);
const afterHash = sha(fs.readFileSync(indexPath));
if (afterHash !== beforeHash || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
  console.log('ABORT: the census itself changed the store');
  process.exit(2);
}
console.log('the store was read only; size, hash and mtime are unchanged');
