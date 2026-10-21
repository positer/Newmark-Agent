// Read the two new navigation tools' real answers, myself, against the live store.
//
// The user's instruction: 核对由你自己读取并核对 — verify it by reading it yourself. So this
// mounts the component the way the gates do, calls the two tools through the same registry
// surface a model would reach, and prints what they answer. Nothing here is a copy of the
// crew's report: the numbers below are whatever the tools return on this machine right now.
//
// Both tools are READS. The script refuses to run if the index changes across the calls.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { mountCore } from './lib/mount-newmark-core.mjs';

const packagesDir = path.resolve('packages');
const ROOT = 'C:\\Users\\12252\\.Newmark';
const INDEX = path.join(ROOT, 'Memory Lab', 'index.json');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const before = sha(INDEX);
const statBefore = fs.statSync(INDEX);

const mount = await mountCore({
  packagesDir,
  root: ROOT,
  components: { memoryLab: true, computerUse: false },
});

const call = async (name, args) => {
  const def = mount.tools.get(name);
  if (!def) throw new Error(`tool ${name} is not registered`);
  return await def.execute(args);
};

const show = (label, value) => {
  console.log(`\n${'='.repeat(78)}\n${label}\n${'='.repeat(78)}`);
  console.log(JSON.stringify(value, null, 2));
};

// ---- 1. the tool list, as the registry holds it -------------------------------
const names = [...mount.tools.keys()].filter((n) => n.startsWith('memory_lab_')).sort();
console.log(`memory_lab_* registered: ${names.length}`);
for (const n of names) console.log(`  ${n}`);

// ---- 2. memory_lab_root_tags --------------------------------------------------
const roots = await call('memory_lab_root_tags', {});
show('memory_lab_root_tags({})', roots);

// ---- 3. memory_lab_subtag_tree on the largest root ----------------------------
const biggest = roots.roots?.[0]?.tag;
console.log(`\nlargest root by subtreeTags: ${biggest}`);
const tree = await call('memory_lab_subtag_tree', { tag: biggest, max_tags: 12, max_components: 5 });
show(`memory_lab_subtag_tree({ tag: "${biggest}", max_tags: 12, max_components: 5 })`, tree);

// ---- 4. a leaf, and an alias, and a refusal ----------------------------------
const leaf = 'AdS-CFT';   // deliberately WITHOUT the leading '#', to test normalization
show(`memory_lab_subtag_tree({ tag: "${leaf}" })  [leaf, no leading #]`,
  await call('memory_lab_subtag_tree', { tag: leaf }));

show('memory_lab_subtag_tree({ tag: "#编排模式" })  [an alias the store advertises]',
  await call('memory_lab_subtag_tree', { tag: '#编排模式' }));

show('memory_lab_subtag_tree({ tag: "#no-such-tag" })  [must be NOT_FOUND, returned not thrown]',
  await call('memory_lab_subtag_tree', { tag: '#no-such-tag' }));

// ---- 5. did anything write? ---------------------------------------------------
const after = sha(INDEX);
const statAfter = fs.statSync(INDEX);
console.log(`\n${'='.repeat(78)}`);
console.log(`index.json sha before : ${before}`);
console.log(`index.json sha after  : ${after}`);
console.log(`UNCHANGED             : ${before === after}`);
console.log(`mtime before/after    : ${statBefore.mtime.toISOString()} / ${statAfter.mtime.toISOString()}`);
console.log(`mtime unchanged       : ${statBefore.mtimeMs === statAfter.mtimeMs}`);
const policy = path.join(ROOT, 'Memory Lab', 'policy.jsonl');
console.log(`policy.jsonl lines    : ${fs.readFileSync(policy, 'utf8').split('\n').filter(Boolean).length}`);
console.log(`errors.jsonl lines    : ${fs.readFileSync(path.join(ROOT, 'errors.jsonl'), 'utf8').split('\n').filter(Boolean).length}`);
