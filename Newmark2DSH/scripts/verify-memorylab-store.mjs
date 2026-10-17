#!/usr/bin/env node
/**
 * Executable gate for Newmark2DSH Memory Lab store
 * (`packages/newmark-core/lib/memory-store.js`).
 *
 * Plain Node ESM, no test framework: `node:assert/strict` plus `node:fs`/`node:os`.
 * The store under test lives in a unique temp directory that is removed in a
 * `finally`. One line is printed per assertion, then `PASS n/n` or `FAIL n/n`.
 *
 * Every assertion is written to have discriminating power: it fails if the rule
 * it names is removed from the module (see the port report for the mutation runs).
 *
 * B-60: a runtime gate must load the exact bytes that ship. The PRIMARY subject
 * is therefore `packages/newmark-core/lib/memory-store.js` — the module the
 * `newmark-core` bundle installs and the one that reads and writes the live
 * `~/.Newmark` store. `packages/newmark-memorylab` is retired (nothing ships it),
 * so its copy is kept as a SECONDARY regression reference only: section 20b
 * observes the return-shape divergence that this repoint was made for instead of
 * dropping that coverage silently.
 *
 * Run: node Newmark2DSH/scripts/verify-memorylab-store.mjs
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The module under test: what the `newmark-core` bundle ships and what owns the
// live `~/.Newmark` store. Every section below except 20b exercises these bytes.
import {
  MemoryLabStore,
  MemoryLabStoreError,
  TAG_FINDING_KINDS,
  slugify,
} from '../packages/newmark-core/components/memorylab/lib/memory-store.js';
// The RETIRED mirror (`packages/newmark-memorylab` — no longer installed in the
// profile and shipped by nothing). Secondary regression reference only: it is
// imported so a divergence between what ships and the legacy copy stays observed
// (section 20b) rather than silently dropped. Never used as the subject of a
// rule assertion, because its bytes do not ship.
// Frozen reference, not shipped code: the retired copy is archived. §20d compares
// the shipped module against it so a drift back to the array shape is caught.
import { MemoryLabStore as LegacyMemoryLabStore } from '../archive/20260930-014200-newmark-core-merge/retired-newmark-memorylab/lib/memory-store.js';

const MODULE_PATH = fileURLToPath(new URL('../packages/newmark-core/components/memorylab/lib/memory-store.js', import.meta.url));
const LEGACY_MODULE_PATH = fileURLToPath(new URL('../archive/20260930-014200-newmark-core-merge/retired-newmark-memorylab/lib/memory-store.js', import.meta.url));

// ---------------------------------------------------------------------------
// tiny assertion harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name, fn) {
  const position = passed + failed + 1;
  try {
    fn();
    passed += 1;
    console.log(`ok ${position} - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok ${position} - ${name}`);
    const message = error && error.message ? String(error.message) : String(error);
    for (const line of message.split('\n')) console.log(`#   ${line}`);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * `index.json` stores components as a plain object keyed by slug (the real v2
 * store contract); older/legacy fixtures may still be an array. Normalize both
 * to `[{ slug, ...meta }]` so disk-level assertions can address one component.
 */
function componentsOf(index) {
  const field = index && index.components;
  if (Array.isArray(field)) return field.map((entry) => ({ ...entry }));
  if (field && typeof field === 'object') return Object.entries(field).map(([slug, meta]) => ({ slug, ...meta }));
  return [];
}

/**
 * The entries of the index a `read()`/`visualizationSnapshot()` hands back.
 *
 * The shipped contract is Newmark's persisted document shape: `components` is a
 * plain object keyed by slug, exactly what `index.json` holds. This helper
 * asserts that shape (so a regression back to the retired in-memory array shape
 * fails here, named) and returns `[{ slug, ...meta }]` for the assertions that
 * address one component as a record. The array branch of `componentsOf` above is
 * deliberately NOT reused: disk fixtures may hold legacy shapes, a read may not.
 */
function componentEntries(index) {
  const field = index ? index.components : undefined;
  assert.equal(
    Array.isArray(field),
    false,
    'read()/visualizationSnapshot() must hand back the persisted shape: components is an object keyed by slug, not an array',
  );
  assert.equal(
    field !== null && typeof field === 'object',
    true,
    `index.components must be a plain object keyed by slug, got ${field === undefined ? 'undefined' : typeof field}`,
  );
  return Object.entries(field).map(([slug, meta]) => ({ slug, ...meta }));
}

/** Sorted unique string list: the set comparison the compat checks use. */
function sortedList(values) {
  return Array.from(new Set((values || []).map(String))).sort();
}

/** First element of `expected` missing from `actual`, or extra in it. */
function firstSetDifference(expected, actual) {
  const want = new Set(expected);
  const got = new Set(actual);
  for (const value of expected) if (!got.has(value)) return `missing ${JSON.stringify(value)}`;
  for (const value of actual) if (!want.has(value)) return `unexpected ${JSON.stringify(value)}`;
  return null;
}

/** Keys of `keys` that are not in `allowed`. */
function unexpectedKeys(keys, allowed) {
  const allow = new Set(allowed);
  return keys.filter((key) => !allow.has(key));
}

/** First structural difference between two JSON values, reported as a path. */
function firstDifference(expected, actual, at = 'index') {
  if (expected === actual) return null;
  if (typeof expected !== typeof actual) return `${at}: type ${typeof actual} !== ${typeof expected}`;
  if (expected === null || actual === null || typeof expected !== 'object') {
    return `${at}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) return `${at}: array/object mismatch`;
  if (Array.isArray(expected)) {
    if (expected.length !== actual.length) return `${at}.length: ${actual.length} !== ${expected.length}`;
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(expected[index], actual[index], `${at}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  const keys = Array.from(new Set([...Object.keys(expected), ...Object.keys(actual)])).sort();
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) return `${at}.${key}: missing (expected ${JSON.stringify(expected[key])})`;
    if (!Object.prototype.hasOwnProperty.call(expected, key)) return `${at}.${key}: unexpected (${JSON.stringify(actual[key])})`;
    const difference = firstDifference(expected[key], actual[key], `${at}.${key}`);
    if (difference) return difference;
  }
  return null;
}

/**
 * The real-store projection: exactly the fields the real v2 store defines, with
 * every array normalized to a set. `path`/`coreMd` are excluded because the copy
 * lives at another root (they are asserted separately), and so are the module's
 * documented extra fields.
 */
function realIndexView(index) {
  return {
    version: index.version,
    preferredLanguage: index.preferredLanguage,
    tags: Object.fromEntries(
      Object.entries(index.tags || {}).map(([name, node]) => [
        name,
        {
          parents: sortedList(node.parents),
          children: sortedList(node.children),
          components: sortedList(node.components),
          aliases: sortedList(node.aliases),
        },
      ]),
    ),
    components: Object.fromEntries(
      componentsOf(index).map((component) => [
        component.slug,
        {
          name: component.name,
          description: component.description,
          tags: sortedList(component.tags),
          tagPaths: sortedList((component.tagPaths || []).map((chain) => chain.join(' > '))),
          kind: component.kind,
          createdAt: component.createdAt,
          updatedAt: component.updatedAt,
        },
      ]),
    ),
  };
}

/**
 * The two real-store slugs that do NOT reproduce from their component's current
 * `name`. Evidence, from `analyze` over the live index and from the archived
 * reference implementation itself (`MemoryLabManager.slugify`, Newmark 0.5.15 —
 * `archive/20260907-113605-dev-0.5.15-release/.../dist/core/memoryLab.js`):
 *
 *   - `AI Agent 多 Agent 协作` -> stored `ai-agent-多agent协作`; the reference
 *     slugify yields `ai-agent-多-agent-协作` as well, so the stored slug was
 *     minted by an older slugger that dropped separators adjacent to CJK.
 *   - `AI Agent 基础` -> stored `ai-agent-agent基础`; every name-derived rule
 *     yields `ai-agent-基础` (the reference included). The stored slug carries the
 *     token `agent` twice while the name carries it once, so the slug predates a
 *     rename of this component.
 *
 * Both are data facts about the store, not slug rules: 13 of the 15 slugs
 * reproduce exactly, including every CJK and mixed slug the contract names.
 */
const KNOWN_SLUG_DIVERGENCES = Object.freeze([
  Object.freeze({ name: 'AI Agent 多 Agent 协作', slug: 'ai-agent-多agent协作', produced: 'ai-agent-多-agent-协作' }),
  Object.freeze({ name: 'AI Agent 基础', slug: 'ai-agent-agent基础', produced: 'ai-agent-基础' }),
]);

/** Drop `updatedAt`-style timestamps so two rebuilds can be compared. */
function stripTimestamps(value) {
  return JSON.parse(
    JSON.stringify(value, (key, entry) => (key === 'updatedAt' ? undefined : entry)),
  );
}

/** relPath -> size:mtimeMs:sha256 for every file under `dir`. */
function snapshotTree(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = fs.statSync(full);
      out[path.relative(dir, full).split(path.sep).join('/')] = `${stat.size}:${stat.mtimeMs}:${sha256(fs.readFileSync(full))}`;
    }
  };
  walk(dir);
  return out;
}

function isMemoryLabError(code) {
  return (error) => error instanceof MemoryLabStoreError && error.code === code;
}

function checkErrorCode(code) {
  return (error) => error instanceof MemoryLabStoreError && (Array.isArray(code) ? code.includes(error.code) : error.code === code);
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

let tmpRoot = null;
// real-store compatibility fixtures (declared here so the `finally` can clean up)
let realPresent = false;
let realBefore = null;
let realOriginal = null;
let realTreeBefore = null;
let compatRoot = null;
let compatCopyDir = null;
let compatStore = null;
let realIndexPath = '';
let realStoreRoot = '';
try {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-store-'));
  console.log(`# module under test (shipped): ${MODULE_PATH}`);
  console.log(`# retired mirror (regression reference only): ${LEGACY_MODULE_PATH}`);
  console.log(`# temp store root: ${tmpRoot}`);

  const main = new MemoryLabStore(path.join(tmpRoot, 'main'), { language: 'en' });
  const alphaContent = '# Alpha\n\nAlpha keeps the release checklist.\nPOLICY-CANARY-BODY-9f3a\n';
  let alphaSlug = '';

  // 1 -----------------------------------------------------------------------
  check('1. ADD creates a component and read() returns contentHash + bytes', () => {
    main.ensureLayout();
    const plan = main.prepareUpdate({
      name: 'Alpha Release Notes',
      description: 'release checklist',
      tags: ['工具', 'tool'],
      content: alphaContent,
      reason: 'seed the store',
      source: 'gate',
    });
    assert.equal(plan.operation, 'ADD');
    assert.equal(plan.brand, 'memorylab-plan-v1');
    const result = main.update(plan);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'ADD');
    assert.equal(result.revision, 1);
    assert.equal(result.archived, null);
    alphaSlug = result.slug;
    assert.equal(alphaSlug, slugify('Alpha Release Notes'));

    const readBack = main.read(alphaSlug);
    assert.equal(readBack.ok, true);
    assert.equal(readBack.content, alphaContent);
    assert.equal(readBack.component.slug, alphaSlug);
    assert.equal(readBack.component.revision, 1);
    assert.equal(readBack.component.kind, 'file');
    assert.equal(readBack.component.path, path.join(main.componentsDir, `${alphaSlug}.md`), 'an absolute path, as the real store stores it');
    assert.equal(readBack.component.coreMd, readBack.component.path, 'kind:file keeps its core markdown at path');
    assert.equal(path.isAbsolute(readBack.component.path), true, 'stored component paths are absolute');
    assert.equal(readBack.component.contentHash, sha256(alphaContent));
    assert.equal(readBack.component.bytes, Buffer.byteLength(alphaContent, 'utf8'));
    assert.equal(typeof readBack.instructions, 'string');
    assert.ok(readBack.instructions.length > 0);
    assert.equal(fs.readFileSync(path.resolve(readBack.root, readBack.component.coreMd), 'utf8'), alphaContent);

    // selector forms: slug, name, component path
    assert.equal(main.read('Alpha Release Notes').component.slug, alphaSlug);
    assert.equal(main.read(`components/${alphaSlug}.md`).component.slug, alphaSlug);
    assert.equal(main.read(readBack.component.coreMd).component.slug, alphaSlug);
    assert.equal(main.read('').component, undefined);

    const disk = readJson(main.indexPath);
    assert.equal(disk.version, 2, 'the real store schema version is 2');
    assert.equal(Array.isArray(disk.components), false, 'components is a plain object keyed by slug on disk');
    assert.equal(Object.keys(disk.components).length, 1);
    const diskEntry = disk.components[alphaSlug];
    assert.ok(diskEntry, 'the component is keyed by its slug');
    assert.equal(Object.prototype.hasOwnProperty.call(diskEntry, 'slug'), false, 'the slug is the key, not a field');
    assert.deepEqual(
      Object.keys(diskEntry).slice(0, 9),
      ['name', 'description', 'tags', 'tagPaths', 'path', 'coreMd', 'kind', 'createdAt', 'updatedAt'],
      'real store component field names, in the real order',
    );
    assert.equal(diskEntry.name, 'Alpha Release Notes');
    assert.equal(diskEntry.kind, 'file');
    assert.equal(diskEntry.path, readBack.component.path);
    assert.equal(diskEntry.coreMd, diskEntry.path);
    assert.equal(diskEntry.contentHash, sha256(alphaContent));
    assert.equal(diskEntry.bytes, Buffer.byteLength(alphaContent, 'utf8'));
    assert.equal(disk.preferredLanguage, 'en', 'the configured language preference is persisted');
    assert.match(disk.relationshipVersion, /^[0-9a-f]{64}$/);

    // tag names keep exactly one leading '#'
    assert.ok(disk.tags['#tool'], 'tag names are stored with their leading #');
    assert.equal(Object.prototype.hasOwnProperty.call(disk.tags, 'tool'), false, 'no unprefixed duplicate node');
    assert.equal(Object.prototype.hasOwnProperty.call(disk.tags, '#工具'), false, '#工具 folded onto the en canonical');
    assert.deepEqual(disk.tags['#tool'].components, [alphaSlug]);
    assert.equal(disk.tags['#tool'].aliases.includes('#工具'), true, 'the folded spelling is preserved as an alias');
    assert.equal(Array.isArray(diskEntry.tagPaths), true);
    assert.equal(diskEntry.tagPaths.every((chain) => Array.isArray(chain)), true);
    assert.equal(diskEntry.tagPaths.length >= 1, true);
  });

  // 2 -----------------------------------------------------------------------
  check('2. UPDATE advances revision and archives the previous markdown', () => {
    assert.ok(alphaSlug, 'prerequisite: component from assertion 1');
    const appended = '\nSecond line.\nThird line.\n';
    const updated = main.update(
      main.prepareUpdate({ slug: alphaSlug, contentAppend: appended, reason: 'append a line', source: 'gate' }),
    );
    assert.equal(updated.ok, true);
    assert.equal(updated.action, 'UPDATE');
    assert.equal(updated.revision, 2);
    assert.equal(typeof updated.archived, 'string');

    const archiveDir = path.join(main.archiveDir, alphaSlug);
    const files = fs.readdirSync(archiveDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /-\d+\.md$/);
    assert.ok(files[0].endsWith('-1.md'), `archive name carries the archived revision: ${files[0]}`);
    const archivedText = fs.readFileSync(path.join(archiveDir, files[0]), 'utf8');
    assert.equal(archivedText, alphaContent);
    assert.equal(sha256(archivedText), sha256(alphaContent));
    assert.equal(updated.archived, path.join(archiveDir, files[0]));
    assert.equal(main.read(alphaSlug).content, alphaContent + appended);

    // unique-fragment replace, then a non-unique fragment without replaceAll
    const patched = main.update(main.prepareUpdate({ slug: alphaSlug, oldText: 'Second line.', newText: 'Second line edited.' }));
    assert.equal(patched.revision, 3);
    assert.equal(main.read(alphaSlug).content, alphaContent + '\nSecond line edited.\nThird line.\n');
    assert.equal(fs.readdirSync(archiveDir).length, 2);

    assert.throws(
      () => main.prepareUpdate({ slug: alphaSlug, oldText: 'line', newText: 'LINE' }),
      checkErrorCode('OLD_TEXT_AMBIGUOUS'),
    );
    assert.throws(
      () => main.prepareUpdate({ slug: alphaSlug, oldText: 'no-such-fragment', newText: 'x' }),
      checkErrorCode('OLD_TEXT_NOT_FOUND'),
    );
    const replaced = main.update(main.prepareUpdate({ slug: alphaSlug, oldText: 'line', newText: 'LINE', replaceAll: true }));
    assert.equal(replaced.revision, 4);
    assert.equal(main.read(alphaSlug).content.includes('line.'), false);
    assert.equal(main.read(alphaSlug).content.split('LINE').length - 1, 2);
  });

  // 3 -----------------------------------------------------------------------
  check('3. a stale expectedUpdatedAt UPDATE is rejected without mutating anything', () => {
    const before = {
      index: fs.readFileSync(main.indexPath),
      policy: fs.readFileSync(main.policyPath),
      content: fs.readFileSync(path.join(main.componentsDir, `${alphaSlug}.md`)),
      archive: fs.readdirSync(path.join(main.archiveDir, alphaSlug)).length,
      component: main.read(alphaSlug).component,
      updatedAt: main.read(alphaSlug).component.updatedAt,
    };
    const stalePlan = main.prepareUpdate({
      slug: alphaSlug,
      content: 'STALE-WRITE-MUST-NOT-LAND',
      expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
    });
    assert.equal(stalePlan.expectedUpdatedAt, '2000-01-01T00:00:00.000Z');
    assert.throws(() => main.update(stalePlan), isMemoryLabError('STALE_WRITE'));

    const after = main.read(alphaSlug).component;
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal(after.revision, before.component.revision);
    assert.equal(after.contentHash, before.component.contentHash);
    assert.deepEqual(fs.readFileSync(main.indexPath), before.index);
    assert.deepEqual(fs.readFileSync(main.policyPath), before.policy);
    assert.deepEqual(fs.readFileSync(path.join(main.componentsDir, `${alphaSlug}.md`)), before.content);
    assert.equal(fs.readFileSync(path.join(main.componentsDir, `${alphaSlug}.md`), 'utf8').includes('STALE-WRITE-MUST-NOT-LAND'), false);
    assert.equal(fs.readdirSync(path.join(main.archiveDir, alphaSlug)).length, before.archive);
  });

  // 4 -----------------------------------------------------------------------
  check('4. a stale DELETE is rejected', () => {
    const before = snapshotTree(main.root);
    assert.throws(
      () => main.delete(alphaSlug, { expectedUpdatedAt: '2000-01-01T00:00:00.000Z', reason: 'stale delete' }),
      isMemoryLabError('STALE_WRITE'),
    );
    assert.equal(main.read(alphaSlug).ok, true);
    assert.deepEqual(snapshotTree(main.root), before);
  });

  // 5 -----------------------------------------------------------------------
  check('5. DELETE archives the final revision and removes the active component', () => {
    const betaContent = '# Beta\n\nbeta body text\n';
    const beta = main.update(main.prepareUpdate({ name: 'Beta Projects', tags: ['项目'], content: betaContent }));
    const betaSlug = beta.slug;
    const stale = main.read(betaSlug).component.updatedAt;
    const removed = main.delete(betaSlug, { reason: 'forget beta', source: 'gate-delete', expectedUpdatedAt: stale });
    assert.equal(removed.ok, true);
    assert.equal(removed.action, 'DELETE');
    assert.equal(removed.slug, betaSlug);
    assert.equal(typeof removed.archived, 'string');
    assert.ok(removed.archived.startsWith(path.join(main.archiveDir, betaSlug) + path.sep));
    assert.equal(fs.readFileSync(removed.archived, 'utf8'), betaContent);
    assert.equal(fs.existsSync(path.join(main.componentsDir, `${betaSlug}.md`)), false);
    assert.equal(main.read(betaSlug).ok, false);
    assert.equal(main.read(betaSlug).error.code, 'NOT_FOUND');
    const afterDeleteIndex = main.read('').index;
    assert.equal(Array.isArray(afterDeleteIndex.components), false, 'a read hands back the persisted object keyed by slug');
    assert.equal(
      Object.prototype.hasOwnProperty.call(afterDeleteIndex.components, betaSlug),
      false,
      'the deleted slug is gone from the persisted object, not merely from an array of records',
    );
    assert.equal(componentEntries(afterDeleteIndex).some((component) => component.slug === betaSlug), false);
    assert.equal(Object.prototype.hasOwnProperty.call(readJson(main.indexPath).components, betaSlug), false);
    assert.equal(fs.readdirSync(path.join(main.archiveDir, betaSlug)).length, 1);
    assert.equal(removed.receipt.operation, 'delete');
  });

  // 6 -----------------------------------------------------------------------
  check('6. reindex() is graph-idempotent (tag graph + relationshipVersion)', () => {
    main.update(
      main.prepareUpdate({
        name: 'Gamma Theory',
        tags: ['研究/理论物理'],
        tagPaths: [['物理', '理论物理']],
        content: 'gamma body about theory',
      }),
    );
    const first = main.reindex();
    const firstIndex = readJson(main.indexPath);
    const second = main.reindex();
    const secondIndex = readJson(main.indexPath);

    assert.equal(first.ok, true);
    assert.equal(first.relationshipVersion, second.relationshipVersion);
    assert.equal(firstIndex.relationshipVersion, secondIndex.relationshipVersion);
    assert.deepEqual(firstIndex.tags, secondIndex.tags);
    assert.deepEqual(firstIndex.components, secondIndex.components);
    assert.equal(
      JSON.stringify(stripTimestamps(firstIndex)),
      JSON.stringify(stripTimestamps(secondIndex)),
      'index.json is byte-identical across two reindex runs apart from timestamps',
    );
    assert.ok(Object.keys(firstIndex.tags).length >= 3);
    assert.ok(Object.keys(firstIndex.components).length >= 2);
    assert.equal(first.components, Object.keys(firstIndex.components).length);
    assert.equal(first.tags, Object.keys(firstIndex.tags).length);
    assert.equal(first.receipt.operation, 'reindex');
    // the graph really is a graph, not a flat tag list
    assert.ok(firstIndex.tags['#theory'] === undefined);
    assert.ok(Array.isArray(firstIndex.tags['#理论物理'].parents));
    assert.ok(firstIndex.tags['#理论物理'].parents.length >= 1);
    // every tag that stands alone keeps its own single-node tagPath
    const gamma = componentsOf(firstIndex).find((component) => component.name === 'Gamma Theory');
    assert.ok(gamma.tagPaths.some((chain) => chain.length === 1), 'a length-1 tagPath survives the round trip');
    assert.equal(gamma.tagPaths.length >= 1, true);
  });

  // 6b ----------------------------------------------------------------------
  check('6b. relationshipVersion changes with the graph and returns when it does', () => {
    const base = main.reindex().relationshipVersion;
    const extra = main.update(main.prepareUpdate({ name: 'Delta Temporary', tags: ['临时标签'], content: 'temporary' }));
    const changed = main.reindex().relationshipVersion;
    assert.notEqual(changed, base);
    main.delete(extra.slug, { reason: 'remove temporary graph change' });
    const restored = main.reindex().relationshipVersion;
    assert.equal(restored, base);
  });

  // 7 -----------------------------------------------------------------------
  check('7. bilingual synonyms fold onto ONE canonical tag chosen by options.language', () => {
    const zh = new MemoryLabStore(path.join(tmpRoot, 'zh'), { language: 'zh' });
    const zhOne = zh.update(zh.prepareUpdate({ name: '记忆一', tags: ['记忆'], content: 'zh one' }));
    const zhTwo = zh.update(zh.prepareUpdate({ name: 'Memory Two', tags: ['memory'], content: 'zh two' }));
    const zhIndex = zh.read('').index;
    assert.ok(zhIndex.tags['#记忆'], 'zh: canonical Chinese spelling exists');
    assert.equal(Object.prototype.hasOwnProperty.call(zhIndex.tags, '#memory'), false, 'zh: the English spelling is not a second node');
    assert.deepEqual(zhIndex.tags['#记忆'].aliases, ['#memory', '#记忆库'], 'the other spellings of the group are preserved as aliases');
    assert.deepEqual(zhIndex.tags['#记忆'].components.slice().sort(), [zhOne.slug, zhTwo.slug].sort());
    const zhEntries = componentEntries(zhIndex);
    assert.deepEqual(zhEntries.map((component) => component.slug).sort(), [zhOne.slug, zhTwo.slug].sort());
    for (const component of zhEntries) {
      assert.deepEqual(component.tags, ['#记忆']);
    }

    const en = new MemoryLabStore(path.join(tmpRoot, 'en'), { language: 'en' });
    const enOne = en.update(en.prepareUpdate({ name: 'Memory One', tags: ['记忆'], content: 'en one' }));
    const enTwo = en.update(en.prepareUpdate({ name: 'Memory Two', tags: ['memory'], content: 'en two' }));
    const enIndex = en.read('').index;
    assert.ok(enIndex.tags['#memory'], 'en: canonical English spelling exists');
    assert.equal(Object.prototype.hasOwnProperty.call(enIndex.tags, '#记忆'), false, 'en: the Chinese spelling is not a second node');
    assert.deepEqual(enIndex.tags['#memory'].aliases, ['#记忆', '#记忆库']);
    assert.deepEqual(enIndex.tags['#memory'].components.slice().sort(), [enOne.slug, enTwo.slug].sort());
    const enEntries = componentEntries(enIndex);
    assert.deepEqual(enEntries.map((component) => component.slug).sort(), [enOne.slug, enTwo.slug].sort());
    for (const component of enEntries) {
      assert.deepEqual(component.tags, ['#memory']);
    }
    // the default language is 'en'
    assert.equal(new MemoryLabStore(path.join(tmpRoot, 'default-lang')).language, 'en');
  });

  // 7b ----------------------------------------------------------------------
  check('7b. reindexing the same root under the other language re-canonicalizes the fold', () => {
    const zhRoot = path.join(tmpRoot, 'zh');
    const flipped = new MemoryLabStore(zhRoot, { language: 'en' });
    flipped.reindex();
    const flippedIndex = readJson(flipped.indexPath);
    assert.ok(flippedIndex.tags['#memory'], 'en reindex moved the fold to memory');
    assert.equal(Object.prototype.hasOwnProperty.call(flippedIndex.tags, '#记忆'), false, 'the old synonym node was deleted');
    assert.equal(flippedIndex.tags['#memory'].components.length, 2);
    assert.deepEqual(flippedIndex.tags['#memory'].aliases, ['#记忆', '#记忆库']);

    const back = new MemoryLabStore(zhRoot, { language: 'zh' });
    back.reindex();
    const backIndex = readJson(back.indexPath);
    assert.ok(backIndex.tags['#记忆']);
    assert.equal(Object.prototype.hasOwnProperty.call(backIndex.tags, '#memory'), false);
    assert.equal(backIndex.tags['#记忆'].components.length, 2);
  });

  // 8 -----------------------------------------------------------------------
  check('8. the 35% adaptive early stop drops a weak match', () => {
    const floorStore = new MemoryLabStore(path.join(tmpRoot, 'floor'));
    const strong = floorStore.update(
      floorStore.prepareUpdate({ name: 'Zebrafish Colony', description: 'tank log', tags: ['biology'], content: 'strong match body' }),
    );
    const weak = floorStore.update(
      floorStore.prepareUpdate({
        name: 'Habitat Notes',
        description: 'field log',
        tags: ['fieldwork'],
        content: 'a note that mentions zebrafish once in the body',
      }),
    );
    const result = floorStore.query({ query: 'zebrafish', limit: 12, maxChars: 48000 });
    assert.equal(result.matches.length, 1, 'only the strong match survives the floor');
    assert.equal(result.matches[0].slug, strong.slug);
    assert.equal(result.matches.some((match) => match.slug === weak.slug), false);
    assert.equal(result.budget.stopReason, 'floor');
    assert.equal(result.budget.stoppedEarly, true);
    assert.equal(result.truncated, true);
    assert.equal(result.budget.floor, 0.35);
    assert.deepEqual(result.budget.droppedByFloor, [weak.slug]);
    assert.ok(result.matches[0].score >= 36, `strong score: ${result.matches[0].score}`);
    assert.ok(result.budget.candidates === 2, 'the weak component was a scored candidate, then dropped by the floor');

    // control: the dropped component is genuinely retrievable when it is the best
    const control = new MemoryLabStore(path.join(tmpRoot, 'floor-control'));
    control.update(
      control.prepareUpdate({
        name: 'Habitat Notes',
        description: 'field log',
        tags: ['fieldwork'],
        content: 'a note that mentions zebrafish once in the body',
      }),
    );
    const controlResult = control.query({ query: 'zebrafish', limit: 12, maxChars: 48000 });
    assert.equal(controlResult.matches.length, 1);
    assert.equal(controlResult.budget.stopReason, null);
    assert.equal(controlResult.budget.candidates, 1);
  });

  // 9 -----------------------------------------------------------------------
  check('9. maxChars clamps to [1000, 48000] and limit to [1, 12]', () => {
    const clampStore = new MemoryLabStore(path.join(tmpRoot, 'clamp'));
    for (let index = 1; index <= 14; index += 1) {
      clampStore.update(
        clampStore.prepareUpdate({
          name: `Clamp Target ${index}`,
          description: 'clamp probe',
          content: `clampterm ${'x'.repeat(500)}`,
        }),
      );
    }
    const low = clampStore.query({ query: 'clampterm', limit: 999, maxChars: 10 });
    assert.equal(low.budget.maxChars, 1000, 'maxChars raised to the lower bound');
    assert.equal(low.budget.limit, 12, 'limit lowered to the upper bound');
    assert.ok(low.matches.length >= 2, `the clamped floor still returns matches: ${low.matches.length}`);
    assert.ok(low.matches.length < 14, 'the clamped limit really caps the list');
    assert.ok(low.budget.usedChars <= 1000);
    assert.ok(low.budget.remainingChars >= 0);
    assert.equal(low.budget.stopReason, 'chars');

    const high = clampStore.query({ query: 'clampterm', limit: -5, maxChars: 999999 });
    assert.equal(high.budget.maxChars, 48000, 'maxChars lowered to the upper bound');
    assert.equal(high.budget.limit, 1, 'limit raised to the lower bound');
    assert.equal(high.matches.length, 1);
    assert.ok(high.budget.usedChars <= 48000);

    const zero = clampStore.query({ query: 'clampterm', limit: 0, maxChars: 0 });
    assert.equal(zero.budget.limit, 1);
    assert.equal(zero.budget.maxChars, 1000);

    const defaults = clampStore.query({ query: 'clampterm' });
    assert.equal(defaults.budget.limit, 5);
    assert.equal(defaults.budget.maxChars, 12000);
  });

  // 10 ----------------------------------------------------------------------
  check('10. the 64000-character per-component scan cap is enforced', () => {
    const capStore = new MemoryLabStore(path.join(tmpRoot, 'cap'));
    const filler = 'filler '.repeat(20000); // 140000 characters
    const huge = `capstart marker\n${filler}\ndeepneedle marker\n${filler}`;
    assert.ok(huge.length > 64000 + 1000, 'fixture is far larger than the cap');
    assert.ok(huge.indexOf('deepneedle') > 64000, 'the deep needle sits beyond the cap');
    capStore.update(capStore.prepareUpdate({ name: 'Huge Memory', tags: ['bulk'], content: huge }));

    const near = capStore.query({ query: 'capstart', limit: 12, maxChars: 48000 });
    assert.equal(near.scanned, 64000, 'exactly the cap is scanned from one component');
    assert.equal(near.budget.scanCapped, true);
    assert.equal(near.budget.maxComponentScan, 64000);
    assert.equal(near.truncated, true);
    assert.equal(near.matches.length, 1);
    assert.deepEqual(near.matches[0].matched, ['content']);

    const deep = capStore.query({ query: 'deepneedle', limit: 12, maxChars: 48000 });
    assert.equal(deep.scanned, 64000);
    assert.equal(deep.matches.length, 0, 'text past the cap is never scanned');
    assert.equal(deep.budget.candidates, 0);

    const plain = capStore.query({ query: 'nothingmatchesthis' });
    assert.equal(plain.scanned, 64000);
    assert.equal(plain.matches.length, 0);
  });

  // 11 ----------------------------------------------------------------------
  check('11. query() reports matched field names and deduplicates by slug', () => {
    const matchStore = new MemoryLabStore(path.join(tmpRoot, 'matched'));
    const descriptionOnly = matchStore.update(
      matchStore.prepareUpdate({ name: 'Field Report', description: 'needlefield appears only here', tags: ['audit'], content: 'body without the term' }),
    );
    const byDescription = matchStore.query({ query: 'needlefield' });
    assert.equal(byDescription.matches.length, 1);
    assert.deepEqual(byDescription.matches[0].matched, ['description']);
    assert.equal(byDescription.matches[0].slug, descriptionOnly.slug);

    const byTags = matchStore.query({ query: 'audit' });
    assert.deepEqual(byTags.matches[0].matched, ['tags']);

    matchStore.update(matchStore.prepareUpdate({ name: 'Sable Needlework Log', tags: ['craft'], content: 'a sable needle in the body' }));
    const byNameAndContent = matchStore.query({ query: 'sable' });
    assert.deepEqual(byNameAndContent.matches[0].matched, ['name', 'content']);
    assert.equal(byNameAndContent.matches[0].score, 36 + 6);
    assert.ok(byNameAndContent.matches[0].excerpt.includes('sable'));

    const withContent = matchStore.query({ query: 'needle' });
    assert.deepEqual(withContent.matches.find((match) => match.slug === descriptionOnly.slug).matched, ['description']);

    // duplicate slugs on disk must not produce duplicate matches or duplicate read entries.
    // The real store keys components by slug, so a duplicate can only arrive through the
    // legacy array shape — which is still tolerated on read and repaired by reindex.
    const raw = readJson(matchStore.indexPath);
    const legacyArray = componentsOf(raw);
    legacyArray.push({ ...legacyArray[0], revision: legacyArray[0].revision + 5 });
    fs.writeFileSync(matchStore.indexPath, JSON.stringify({ ...raw, components: legacyArray }, null, 2));
    const duplicated = matchStore.query({ query: 'needlefield' });
    const matchSlugs = duplicated.matches.map((match) => match.slug);
    assert.equal(new Set(matchSlugs).size, matchSlugs.length, 'matches are deduplicated by slug');
    const readSlugs = componentEntries(matchStore.read('').index).map((component) => component.slug);
    assert.equal(new Set(readSlugs).size, readSlugs.length, 'the normalized index holds one entry per slug');
    assert.equal(readSlugs.length, 2);
    matchStore.reindex();
    const repaired = componentsOf(readJson(matchStore.indexPath)).map((component) => component.slug);
    assert.equal(new Set(repaired).size, repaired.length);
    assert.equal(repaired.length, 2);
    assert.equal(Array.isArray(readJson(matchStore.indexPath).components), false, 'reindex writes the real object shape');
  });

  // 12 ----------------------------------------------------------------------
  check('12. policy.jsonl is append-only, carries archive path + hash, never body text', () => {
    const policyStore = new MemoryLabStore(path.join(tmpRoot, 'policy'));
    const canary = 'POLICY-CANARY-BODY-9f3a';
    const created = policyStore.update(
      policyStore.prepareUpdate({
        name: 'Policy Target',
        tags: ['audit'],
        content: `# Policy\n${canary}\nbody line\n`,
        reason: 'create for policy check',
        source: 'gate-policy',
      }),
    );
    const beforeLines = fs.readFileSync(policyStore.policyPath);
    const updated = policyStore.update(
      policyStore.prepareUpdate({ slug: created.slug, contentAppend: '\nmore body\n', reason: 'append for policy check', source: 'gate-policy' }),
    );
    const removed = policyStore.delete(created.slug, { reason: 'delete for policy check', source: 'gate-policy' });
    const afterBuffer = fs.readFileSync(policyStore.policyPath);

    assert.deepEqual(afterBuffer.subarray(0, beforeLines.length), beforeLines, 'earlier lines are untouched');
    assert.ok(afterBuffer.length > beforeLines.length, 'the log only grows');
    const text = afterBuffer.toString('utf8');
    assert.equal(text.endsWith('\n'), true);
    const records = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(records.length, 3);
    assert.ok(records.every((record) => record.id && record.at && record.action && record.slug && record.source));
    assert.ok(records.every((record) => Number.isFinite(Date.parse(record.at))), 'ISO timestamps');

    const updateRecord = records.find((record) => record.action === 'UPDATE');
    assert.equal(updateRecord.reason, 'append for policy check');
    assert.equal(updateRecord.source, 'gate-policy');
    assert.equal(updateRecord.slug, created.slug);
    assert.equal(updateRecord.revision, 2);
    assert.equal(updateRecord.archivePath, updated.archived);
    assert.ok(updateRecord.archivePath.startsWith(path.join(policyStore.archiveDir, created.slug)));
    assert.match(updateRecord.contentHash, /^[0-9a-f]{64}$/);

    const deleteRecord = records.find((record) => record.action === 'DELETE');
    assert.equal(deleteRecord.archivePath, removed.archived);
    assert.match(deleteRecord.contentHash, /^[0-9a-f]{64}$/);

    assert.equal(text.includes(canary), false, 'no memory body text in the audit log');
    assert.equal(text.includes('body line'), false);
    assert.equal(text.includes('more body'), false);
    for (const record of records) {
      assert.equal(Object.prototype.hasOwnProperty.call(record, 'content'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(record, 'body'), false);
    }
    assert.equal(fs.statSync(policyStore.policyPath).size, afterBuffer.length);
  });

  // 13 ----------------------------------------------------------------------
  check('13. path containment rejects a traversal slug instead of escaping the root', () => {
    const escapeRoot = path.join(tmpRoot, 'escape');
    const escapeStore = new MemoryLabStore(escapeRoot);
    escapeStore.ensureLayout();
    const outsideFile = path.join(tmpRoot, 'escaped.md');
    assert.equal(fs.existsSync(outsideFile), false);

    const traversalRead = escapeStore.read('../../escaped.md');
    assert.equal(traversalRead.ok, false);
    assert.equal(traversalRead.error.code, 'PATH_ESCAPE');
    assert.equal(traversalRead.component, undefined);
    assert.equal(escapeStore.read('..\\..\\escaped.md').error.code, 'PATH_ESCAPE');

    assert.throws(() => escapeStore.prepareUpdate({ slug: '../../escaped.md', name: 'Escape', content: 'nope' }), isMemoryLabError('PATH_ESCAPE'));
    assert.throws(() => escapeStore.prepareUpdate({ slug: '..\\..\\escaped', name: 'Escape', content: 'nope' }), isMemoryLabError('PATH_ESCAPE'));
    assert.throws(
      () => escapeStore.prepareUpdate({ slug: 'components/../../escaped.md', name: 'Escape', content: 'nope' }),
      isMemoryLabError('PATH_ESCAPE'),
    );
    assert.throws(() => escapeStore.delete('../../escaped.md'), isMemoryLabError('PATH_ESCAPE'));
    assert.throws(() => escapeStore.delete(outsideFile), isMemoryLabError('PATH_ESCAPE'));
    const outsideRead = escapeStore.read(outsideFile);
    assert.equal(outsideRead.ok, false);
    assert.equal(outsideRead.error.code, 'PATH_ESCAPE');
    assert.equal(outsideRead.content, undefined);
    assert.equal(fs.existsSync(outsideFile), false);

    // tag names are labels, not filesystem paths: nothing outside the root is touched
    const labelled = escapeStore.update(
      escapeStore.prepareUpdate({ name: 'Label Store', tags: ['..'], tagPaths: [['a/../b', 'c']], content: 'label body' }),
    );
    assert.ok(Object.keys(escapeStore.read('').index.tags).length >= 1);
    assert.ok(path.resolve(escapeStore.root, labelled.component.path).startsWith(path.resolve(escapeStore.root) + path.sep));
    assert.equal(fs.readdirSync(tmpRoot).includes('escaped.md'), false);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'b')), false);

    // a traversal NAME is neutralized into a contained slug, not written outside
    const neutral = escapeStore.update(escapeStore.prepareUpdate({ name: '../../escaped.md', content: 'contained' }));
    const neutralFile = path.resolve(escapeStore.root, neutral.component.path);
    assert.ok(neutralFile.startsWith(path.resolve(escapeStore.root) + path.sep));
    assert.equal(fs.existsSync(neutralFile), true);
    assert.equal(fs.existsSync(outsideFile), false);
    assert.equal(fs.readdirSync(tmpRoot).includes('escaped.md'), false);
    assert.equal(neutral.slug.includes('/'), false);
    assert.equal(neutral.slug.includes('..'), false);
  });

  // 14 ----------------------------------------------------------------------
  check('14. an unreadable index.json recovers from .bak and quarantines the bad file', () => {
    const corruptStore = new MemoryLabStore(path.join(tmpRoot, 'corrupt'));
    const first = corruptStore.update(corruptStore.prepareUpdate({ name: 'Recoverable Memory', tags: ['恢复'], content: 'revision one body' }));
    const second = corruptStore.update(corruptStore.prepareUpdate({ slug: first.slug, content: 'revision two body' }));
    assert.equal(second.revision, 2);
    const bakIndex = readJson(corruptStore.bakPath);
    assert.equal(componentsOf(bakIndex).length, 1);
    assert.equal(componentsOf(bakIndex)[0].revision, 1, '.bak holds the previous good index');

    const badText = '{ this is not valid json';
    fs.writeFileSync(corruptStore.indexPath, badText);
    const recovered = corruptStore.read('');
    assert.equal(recovered.ok, true);
    assert.equal(recovered.status, 'recovered');
    const recoveredEntries = componentEntries(recovered.index);
    assert.equal(recoveredEntries.length, 1, 'the store was not emptied');
    assert.equal(recoveredEntries[0].revision, 1);
    assert.equal(recoveredEntries[0].slug, first.slug, 'the recovered index is keyed by the component slug');
    assert.ok(recovered.warnings.some((warning) => warning.startsWith('recovered-from:')));

    const corruptFiles = fs.readdirSync(corruptStore.root).filter((name) => name.includes('.corrupt'));
    assert.equal(corruptFiles.length, 1);
    assert.equal(fs.readFileSync(path.join(corruptStore.root, corruptFiles[0]), 'utf8'), badText, 'the bad file is preserved');
    assert.equal(componentsOf(readJson(corruptStore.indexPath))[0].revision, 1);
    assert.equal(corruptStore.read(first.slug).component.revision, 1, 'the recovered index is authoritative again');
    assert.equal(
      corruptStore.read(first.slug).content,
      'revision two body',
      'recovery restores the index only; component bodies were never touched',
    );
    assert.equal(fs.readdirSync(corruptStore.root).some((name) => name.endsWith('.tmp')), false);
    assert.match(corruptStore.reindex().relationshipVersion, /^[0-9a-f]{64}$/);
    assert.equal(componentsOf(readJson(corruptStore.indexPath))[0].contentHash, sha256('revision two body'), 'reindex re-hashes the file on disk');
  });

  // 14b ---------------------------------------------------------------------
  check('14b. an unreadable index with no .bak is a structured error, never a silent empty store', () => {
    const orphanRoot = path.join(tmpRoot, 'orphan');
    fs.mkdirSync(orphanRoot, { recursive: true });
    const brokenText = '{"version":1,"components":[{"slug":"ghost-component"';
    fs.writeFileSync(path.join(orphanRoot, 'index.json'), brokenText);
    const orphan = new MemoryLabStore(orphanRoot);

    const orphanRead = orphan.read('');
    assert.equal(orphanRead.ok, false);
    assert.equal(orphanRead.index, null);
    assert.equal(orphanRead.error.code, 'INDEX_MALFORMED');
    assert.ok(orphanRead.error.message.length > 0);
    assert.throws(() => orphan.query({ query: 'ghost' }), checkErrorCode(['INDEX_MALFORMED', 'INDEX_UNREADABLE']));
    assert.throws(() => orphan.update(orphan.prepareUpdate({ name: 'Ghost', content: 'x' })), checkErrorCode(['INDEX_MALFORMED', 'INDEX_UNREADABLE']));
    assert.throws(() => orphan.reindex(), checkErrorCode(['INDEX_MALFORMED', 'INDEX_UNREADABLE']));
    assert.equal(fs.readFileSync(path.join(orphanRoot, 'index.json'), 'utf8'), brokenText, 'the unreadable file is left alone');
    assert.deepEqual(fs.readdirSync(orphanRoot), ['index.json']);

    // parseable but structurally wrong is also a structured error
    fs.writeFileSync(path.join(orphanRoot, 'index.json'), '[1,2,3]');
    const arrayRead = orphan.read('');
    assert.equal(arrayRead.ok, false);
    assert.equal(arrayRead.error.code, 'INDEX_MALFORMED');

    // the legacy record shape (components as an object) is still accepted
    const legacySlug = 'legacy-record';
    fs.writeFileSync(
      path.join(orphanRoot, 'index.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        tags: { '#记忆': { parents: [], children: [], components: [legacySlug], aliases: ['memory'] } },
        components: {
          [legacySlug]: {
            name: 'Legacy Record',
            description: 'ported record shape',
            tags: ['#记忆'],
            tagPaths: [],
            kind: 'file',
            path: `components/${legacySlug}.md`,
            revision: 2,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            contentHash: 'b'.repeat(64),
            bytes: 3,
          },
        },
      }),
    );
    const legacyRead = orphan.read('');
    assert.equal(legacyRead.ok, true);
    const legacyEntries = componentEntries(legacyRead.index);
    assert.equal(legacyEntries.length, 1);
    assert.equal(legacyEntries[0].slug, legacySlug);
    assert.equal(legacyEntries[0].revision, 2);
    assert.deepEqual(legacyEntries[0].tags, ['#memory'], 'legacy #记忆 folds to the en canonical tag');
    assert.equal(Object.prototype.hasOwnProperty.call(legacyRead.index.tags, '#记忆'), false);
  });

  // 15 ----------------------------------------------------------------------
  check('15. read paths perform zero writes', () => {
    const quiet = new MemoryLabStore(path.join(tmpRoot, 'quiet'));
    quiet.update(quiet.prepareUpdate({ name: 'Quiet Memory', tags: ['audit'], content: 'quiet body' }));
    const before = snapshotTree(quiet.root);
    quiet.read('');
    quiet.read('quiet-memory');
    quiet.query({ query: 'quiet' });
    const snapshot = quiet.visualizationSnapshot();
    assert.equal(snapshot.ok, true);
    assert.deepEqual(snapshotTree(quiet.root), before, 'no file bytes or mtimes changed');

    const missingRoot = path.join(tmpRoot, 'missing-store');
    const missing = new MemoryLabStore(missingRoot);
    const missingRead = missing.read('');
    assert.equal(missingRead.ok, true);
    assert.equal(missingRead.status, 'missing');
    assert.equal(Array.isArray(missingRead.index.components), false, 'even a missing store reads as the persisted object shape');
    assert.equal(componentEntries(missingRead.index).length, 0, 'a missing store reads as an empty index, never an array of records');
    assert.equal(fs.existsSync(missingRoot), false, 'reading a missing store creates nothing');
  });

  // 16 ----------------------------------------------------------------------
  check('16. writes are atomic, keep a .bak, and ensureLayout never rewrites a valid index', () => {
    const atomic = new MemoryLabStore(path.join(tmpRoot, 'atomic'));
    const layout = atomic.ensureLayout();
    assert.equal(layout.indexCreated, true);
    assert.equal(fs.existsSync(atomic.componentsDir), true);
    assert.equal(fs.existsSync(atomic.archiveDir), true);
    const createdText = fs.readFileSync(atomic.indexPath, 'utf8');
    const createdMtime = fs.statSync(atomic.indexPath).mtimeMs;
    assert.equal(readJson(atomic.indexPath).preferredLanguage, 'auto', 'preferredLanguage defaults to auto, exactly like the real store');
    const again = atomic.ensureLayout();
    assert.equal(again.indexCreated, false);
    assert.equal(fs.readFileSync(atomic.indexPath, 'utf8'), createdText);
    assert.equal(fs.statSync(atomic.indexPath).mtimeMs, createdMtime, 'an existing valid index is not rewritten');
    assert.equal(fs.existsSync(atomic.bakPath), false);

    atomic.update(atomic.prepareUpdate({ name: 'Atomic Memory', tags: ['audit'], content: 'atomic body' }));
    assert.equal(fs.existsSync(atomic.bakPath), true);
    assert.equal(componentsOf(readJson(atomic.bakPath)).length, 0, '.bak holds the previous good index');
    assert.equal(componentsOf(readJson(atomic.indexPath)).length, 1);
    assert.equal(readJson(atomic.bakPath).version, 2);
    const leftovers = [...fs.readdirSync(atomic.root), ...fs.readdirSync(atomic.componentsDir)].filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'no .tmp files survive a write');

    // observe the write seam: every write must be <file>.tmp -> rename(same directory)
    const realRenameSync = fs.renameSync;
    const renames = [];
    fs.renameSync = (from, to) => {
      renames.push({ from: String(from), to: String(to) });
      return realRenameSync(from, to);
    };
    try {
      atomic.update(atomic.prepareUpdate({ slug: 'atomic-memory', contentAppend: ' plus more' }));
    } finally {
      fs.renameSync = realRenameSync;
    }
    assert.ok(renames.length >= 2, `observed atomic renames: ${renames.length}`);
    assert.ok(renames.some((entry) => entry.to === atomic.indexPath), 'index.json is renamed into place');
    assert.ok(renames.some((entry) => entry.to === atomic.bakPath), '.bak is written atomically too');
    assert.ok(renames.some((entry) => entry.to === path.join(atomic.componentsDir, 'atomic-memory.md')));
    for (const entry of renames) {
      assert.equal(entry.from, `${entry.to}.tmp`, 'the temporary file is <file>.tmp');
      assert.equal(path.dirname(entry.from), path.dirname(entry.to), 'the temporary file lives in the same directory');
    }
    const afterRenames = [...fs.readdirSync(atomic.root), ...fs.readdirSync(atomic.componentsDir)].filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(afterRenames, []);
  });

  // 17 ----------------------------------------------------------------------
  check('17. public API surface and model-facing formatters', () => {
    const store = new MemoryLabStore(path.join(tmpRoot, 'surface'));
    for (const method of [
      'ensureLayout',
      'read',
      'query',
      'prepareUpdate',
      'update',
      'delete',
      'reindex',
      'visualizationSnapshot',
      'formatRead',
      'formatQuery',
      'formatWrite',
      'relationshipVersion',
    ]) {
      assert.equal(typeof store[method], 'function', `MemoryLabStore.${method}`);
    }
    assert.equal(typeof slugify, 'function');
    store.update(store.prepareUpdate({ name: 'Surface Memory', tags: ['audit'], content: 'surface body' }));
    const readResult = store.read('surface-memory');
    const queryResult = store.query({ query: 'surface' });
    const writeResult = store.update(store.prepareUpdate({ slug: 'surface-memory', contentAppend: ' more' }));
    assert.ok(store.formatRead(readResult).startsWith('[memory_lab_read]\n'));
    assert.ok(store.formatQuery(queryResult).startsWith('[memory_lab_query]\n'));
    assert.ok(store.formatWrite(writeResult).startsWith('[memory_lab_write]\n'));
    assert.equal(JSON.parse(store.formatRead(readResult).split('\n').slice(1).join('\n')).component.slug, 'surface-memory');
    assert.equal(JSON.parse(store.formatQuery(queryResult).split('\n').slice(1).join('\n')).matches.length >= 1, true);
    assert.equal(JSON.parse(store.formatWrite(writeResult).split('\n').slice(1).join('\n')).action, 'UPDATE');

    const snapshot = store.visualizationSnapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), ['contents', 'index', 'loadedAt', 'ok', 'relationshipVersion']);
    assert.equal(typeof snapshot.contents['surface-memory'], 'string');
    assert.equal(snapshot.contents['surface-memory'], 'surface body more');
    assert.equal(snapshot.index.relationshipVersion, snapshot.relationshipVersion);
    assert.ok(Number.isFinite(Date.parse(snapshot.loadedAt)));
    assert.equal(typeof slugify('Plain Name'), 'string');
  });

  // 18 ----------------------------------------------------------------------
  check('18. slugify is deterministic, filesystem-safe, hyphenated, CJK-preserving', () => {
    assert.equal(slugify('Hello World!'), 'hello-world');
    assert.equal(slugify('  Mixed   CASE  '), 'mixed-case');
    assert.equal(slugify('Alpha Release Notes'), 'alpha-release-notes');
    assert.equal(slugify('v1.2 Notes'), 'v1.2-notes');
    assert.equal(slugify('a/b\\c'), 'a-b-c');
    // CJK survives: the real store has CJK slugs, so a hash fallback there would
    // rename every non-ASCII component.
    assert.equal(slugify('记忆库'), '记忆库');
    assert.equal(slugify('用户专业方向与研究背景'), '用户专业方向与研究背景');
    assert.equal(slugify('AI Agent 评估'), 'ai-agent-评估');
    assert.equal(slugify('记忆库'), slugify('记忆库'), 'deterministic');
    assert.notEqual(slugify('记忆库'), slugify('记忆'));
    assert.match(slugify('***'), /^m-[0-9a-f]{16}$/, 'hash fallback when nothing usable survives');
    assert.equal(slugify('***'), 'm-' + sha256('***').slice(0, 16));
    assert.match(slugify('../../etc/passwd'), /^[a-z0-9._-]+$/, 'ASCII-safe');
    assert.equal(slugify('../../etc/passwd').includes('..'), false, 'no traversal segment survives');
    assert.equal(slugify('..'), 'm-' + sha256('..').slice(0, 16));
    assert.ok(slugify('A'.repeat(400)).length <= 120);
  });

  // 19 ----------------------------------------------------------------------
  check('19. query() matches Chinese bigrams as well as English-like word tokens', () => {
    const cjk = new MemoryLabStore(path.join(tmpRoot, 'cjk'));
    cjk.update(
      cjk.prepareUpdate({
        name: '发布节奏',
        description: '每周五发布版本',
        tags: ['约定'],
        content: '项目约定：每周五发布版本，工具链固定。',
      }),
    );
    const byBigram = cjk.query({ query: '约定' });
    assert.equal(byBigram.matches.length, 1);
    assert.ok(byBigram.matches[0].matched.includes('content'));
    assert.ok(byBigram.budget.terms.includes('约定'), 'the Chinese term is tokenized as a bigram');

    const splitPhrase = cjk.query({ query: '项目发布' });
    assert.equal(splitPhrase.matches.length, 1, 'a phrase that never appears verbatim still matches');
    assert.ok(splitPhrase.budget.terms.includes('项目'));
    assert.ok(splitPhrase.budget.terms.includes('发布'));
    assert.ok(splitPhrase.budget.terms.includes('目发'), 'bigrams cross word boundaries instead of relying on segmentation');

    const secondPhrase = cjk.query({ query: '工具链固定' });
    assert.equal(secondPhrase.matches.length, 1);

    const byTag = cjk.query({ query: 'convention' });
    assert.deepEqual(byTag.matches[0].matched, ['tags'], 'English word tokens still match canonical tags');

    const miss = cjk.query({ query: '不存在的记忆' });
    assert.equal(miss.matches.length, 0);
  });

  // 20 ----------------------------------------------------------------------
  check('20. kind:"folder" keeps its core markdown at components/<slug>/memory.md', () => {
    const folders = new MemoryLabStore(path.join(tmpRoot, 'folder'));
    const created = folders.update(
      folders.prepareUpdate({ name: 'Folder Memory', kind: 'folder', tags: ['audit'], content: 'folder core body' }),
    );
    assert.equal(created.component.kind, 'folder');
    assert.equal(created.component.path, path.join(folders.componentsDir, created.slug), 'the container is the slug directory');
    assert.equal(created.component.coreMd, path.join(folders.componentsDir, created.slug, 'memory.md'));
    const coreFile = path.join(folders.componentsDir, created.slug, 'memory.md');
    assert.equal(fs.readFileSync(coreFile, 'utf8'), 'folder core body');
    assert.equal(folders.read(created.slug).content, 'folder core body');
    assert.equal(folders.read(`components/${created.slug}/memory.md`).component.slug, created.slug);
    assert.equal(folders.read(`components/${created.slug}`).component.slug, created.slug);

    const updated = folders.update(folders.prepareUpdate({ slug: created.slug, contentAppend: ' plus' }));
    assert.equal(updated.revision, 2);
    assert.equal(updated.component.coreMd, path.join(folders.componentsDir, created.slug, 'memory.md'), 'the stored core path survives an update');
    assert.equal(fs.readFileSync(updated.archived, 'utf8'), 'folder core body');
    assert.ok(updated.archived.startsWith(path.join(folders.archiveDir, created.slug) + path.sep));

    // switching kind replaces the container rather than leaving both behind
    const flipped = folders.update(folders.prepareUpdate({ slug: created.slug, kind: 'file' }));
    assert.equal(flipped.component.kind, 'file');
    assert.equal(flipped.component.path, path.join(folders.componentsDir, `${created.slug}.md`));
    assert.equal(flipped.component.coreMd, flipped.component.path);
    assert.equal(fs.existsSync(path.join(folders.componentsDir, created.slug)), false);
    assert.equal(fs.existsSync(path.join(folders.componentsDir, `${created.slug}.md`)), true);
    const removed = folders.delete(created.slug, { reason: 'folder fixture cleanup' });
    assert.equal(fs.existsSync(path.join(folders.componentsDir, `${created.slug}.md`)), false);
    assert.equal(typeof removed.archived, 'string');

    // deleting a folder-kind component removes its directory
    const second = folders.update(folders.prepareUpdate({ name: 'Folder Two', kind: 'folder', content: 'two' }));
    const secondDir = path.join(folders.componentsDir, second.slug);
    assert.equal(fs.existsSync(secondDir), true);
    const deletedFolder = folders.delete(second.slug, { reason: 'folder fixture cleanup' });
    assert.equal(fs.existsSync(secondDir), false);
    assert.equal(fs.readFileSync(deletedFolder.archived, 'utf8'), 'two');
    assert.equal(componentEntries(folders.read('').index).length, 0);

    // a legacy core.md folder component still round-trips: stored paths win
    const legacy = folders.update(
      folders.prepareUpdate({ name: 'Legacy Folder', kind: 'folder', tags: ['audit'], content: 'legacy core' }),
    );
    const legacyCore = path.join(folders.componentsDir, legacy.slug, 'memory.md');
    const legacyOld = path.join(folders.componentsDir, legacy.slug, 'core.md');
    fs.renameSync(legacyCore, legacyOld);
    const raw = readJson(folders.indexPath);
    raw.components[legacy.slug].coreMd = legacyOld;
    fs.writeFileSync(folders.indexPath, JSON.stringify(raw, null, 2));
    assert.equal(componentEntries(folders.read('').index).length, 1);
    const legacyRead = folders.read(legacy.slug);
    assert.equal(legacyRead.content, 'legacy core');
    assert.equal(legacyRead.component.coreMd, legacyOld, 'a stored core.md path is preserved, not rewritten');
    const legacyAppended = folders.update(folders.prepareUpdate({ slug: legacy.slug, contentAppend: ' more' }));
    assert.equal(legacyAppended.component.coreMd, legacyOld, 'the legacy path survives an update');
    assert.equal(fs.readFileSync(legacyOld, 'utf8'), 'legacy core more');
    assert.equal(fs.existsSync(legacyCore), false, 'no duplicate core file is created');
    folders.reindex();
    const reindexedFolders = componentEntries(folders.read('').index);
    assert.equal(reindexedFolders.length, 1);
    assert.equal(reindexedFolders[0].slug, legacy.slug, 'the reindexed index stays keyed by slug');
    assert.equal(reindexedFolders[0].coreMd, legacyOld, 'a reindex inside components/ preserves the path');
  });

  // 20b ---------------------------------------------------------------------
  check('20b. shipped contract: the persisted index shape a read()/snapshot() hands back', () => {
    const shapeRoot = path.join(tmpRoot, 'shape');
    const shape = new MemoryLabStore(shapeRoot, { language: 'zh' });
    assert.equal(shape.userRoot, path.resolve(shapeRoot), 'userRoot keeps the configured root');
    assert.equal(shape.root, path.join(path.resolve(shapeRoot), 'Memory Lab'), 'a fresh user root resolves to its Memory Lab folder');
    assert.equal(new MemoryLabStore(shape.root).root, shape.root, 'a root that already is a Memory Lab is used as it is');

    const one = shape.update(shape.prepareUpdate({ name: 'Shape One', tags: ['形状'], content: 'shape one body' }));
    const two = shape.update(shape.prepareUpdate({ name: 'Shape Two', tags: ['形状'], content: 'shape two body' }));

    // read('') -> index.components is a PLAIN OBJECT KEYED BY SLUG (B-60 contract)
    const readIndex = shape.read('').index;
    assert.equal(readIndex.version, 2, 'the read index is schema version 2');
    assert.equal(readIndex.preferredLanguage, 'zh', 'preferredLanguage survives a read');
    assert.equal(Array.isArray(readIndex.components), false, 'read("").index.components must not be an array');
    assert.equal(Object.getPrototypeOf(readIndex.components), Object.prototype, 'components is a plain object, not a Map or array subclass');
    assert.deepEqual(
      Object.keys(readIndex.components).sort(),
      [one.slug, two.slug].sort(),
      'the object keys are exactly the component slugs',
    );
    for (const slug of [one.slug, two.slug]) {
      assert.equal(readIndex.components[slug].name, slug === one.slug ? 'Shape One' : 'Shape Two');
      assert.equal(readIndex.components[slug].tags[0], '#形状');
    }
    assert.deepEqual(
      componentEntries(readIndex).map((component) => component.slug).sort(),
      Object.keys(readIndex.components).sort(),
      'componentEntries() reads the persisted object back to the same slugs',
    );

    // visualizationSnapshot() -> same shape, and contents keys are exactly those slugs
    const snapshot = shape.visualizationSnapshot();
    assert.equal(snapshot.ok, true);
    assert.equal(Array.isArray(snapshot.index.components), false, 'snapshot().index.components must not be an array');
    assert.deepEqual(
      Object.keys(snapshot.index.components).sort(),
      Object.keys(readIndex.components).sort(),
      'snapshot().index keys equal read("").index keys',
    );
    assert.deepEqual(
      Object.keys(snapshot.contents).sort(),
      Object.keys(snapshot.index.components).sort(),
      'snapshot().contents is keyed by exactly the persisted slugs',
    );
    assert.equal(snapshot.contents[one.slug], 'shape one body');
    assert.equal(snapshot.contents[two.slug], 'shape two body');

    // version 2 and preferredLanguage survive a reindex too
    const rebuilt = shape.reindex();
    assert.equal(rebuilt.ok, true);
    const afterReindex = shape.read('').index;
    assert.equal(afterReindex.version, 2, 'the reindexed index is still version 2');
    assert.equal(afterReindex.preferredLanguage, 'zh', 'preferredLanguage survives a reindex');
    assert.equal(readJson(shape.indexPath).version, 2, 'and version 2 is what lands on disk');
    assert.equal(readJson(shape.indexPath).preferredLanguage, 'zh', 'and preferredLanguage is what lands on disk');
    assert.deepEqual(
      Object.keys(afterReindex.components).sort(),
      [one.slug, two.slug].sort(),
      'the reindexed read is still the persisted object with every slug',
    );
    assert.equal(
      shape.visualizationSnapshot().contents[two.slug],
      'shape two body',
      'the snapshot still resolves content after a reindex',
    );
  });

  // 20c ---------------------------------------------------------------------
  check('20c. shipped contract: a component with a missing core markdown is kept and warned about', () => {
    const missingCoreStore = new MemoryLabStore(path.join(tmpRoot, 'missing-core'), { language: 'en' });
    missingCoreStore.ensureLayout();
    const present = missingCoreStore.update(
      missingCoreStore.prepareUpdate({ name: 'Present Core', tags: ['audit'], content: 'present body' }),
    );
    const absent = missingCoreStore.update(
      missingCoreStore.prepareUpdate({ name: 'Absent Core', tags: ['audit'], content: 'absent body' }),
    );
    assert.equal(fs.existsSync(path.join(missingCoreStore.componentsDir, `${absent.slug}.md`)), true, 'the fixture wrote both cores');

    fs.rmSync(path.join(missingCoreStore.componentsDir, `${absent.slug}.md`));
    assert.equal(fs.existsSync(path.join(missingCoreStore.componentsDir, `${absent.slug}.md`)), false);

    const read = missingCoreStore.read('');
    assert.equal(read.ok, true, 'a missing core markdown does not fail the read');
    assert.deepEqual(
      Object.keys(read.index.components).sort(),
      [absent.slug, present.slug].sort(),
      'the component with the missing core is still present in the persisted index, not dropped',
    );
    assert.equal(Object.prototype.hasOwnProperty.call(read.index.components, absent.slug), true, 'its slug key survives');
    assert.deepEqual(
      Object.keys(read.index.tags).sort(),
      ['#audit'],
      'the tag graph still carries its membership',
    );
    assert.deepEqual(read.index.tags['#audit'].components.slice().sort(), [absent.slug, present.slug].sort());

    const snapshot = missingCoreStore.visualizationSnapshot();
    assert.deepEqual(sortedList(Object.keys(snapshot.contents)), sortedList([absent.slug, present.slug]), 'the snapshot keeps both keys');
    assert.equal(snapshot.contents[absent.slug], '', 'the missing core is an empty body, never a missing key');
    assert.equal(snapshot.contents[present.slug], 'present body');

    const rebuilt = missingCoreStore.reindex();
    assert.equal(rebuilt.ok, true, 'a rebuild tolerates the missing core');
    assert.ok(
      rebuilt.warnings.includes(`missing-core:${absent.slug}`),
      `the missing core must be reported as a warning, got ${JSON.stringify(rebuilt.warnings)}`,
    );
    assert.deepEqual(
      Object.keys(readJson(missingCoreStore.indexPath).components).sort(),
      [absent.slug, present.slug].sort(),
      'the rebuild keeps it in the persisted index too',
    );
    assert.deepEqual(
      Object.keys(missingCoreStore.read('').index.components).sort(),
      [absent.slug, present.slug].sort(),
      'and the store still reads it back afterwards',
    );
  });

  // 20d ---------------------------------------------------------------------
  check('20d. retired mirror: the divergence this repoint was made for stays observed', () => {
    // The retired `newmark-memorylab` copy returns the in-memory ARRAY shape from
    // read()/visualizationSnapshot(); the shipped `newmark-core` copy returns
    // Newmark's persisted object keyed by slug. Both are pointed at the SAME store
    // directory so the divergence is measured on identical bytes: the shipped
    // module resolves `<root>/Memory Lab`, the retired mirror takes the lab
    // directory itself. This keeps the secondary reference covered instead of
    // dropping sections 1-27's old subject silently.
    const mirrorConfiguredRoot = path.join(tmpRoot, 'mirror');
    const shipped = new MemoryLabStore(mirrorConfiguredRoot, { language: 'en' });
    const created = shipped.update(shipped.prepareUpdate({ name: 'Mirror Probe', tags: ['audit'], content: 'mirror body' }));
    assert.equal(shipped.root, path.join(path.resolve(mirrorConfiguredRoot), 'Memory Lab'));

    const legacy = new LegacyMemoryLabStore(shipped.root, { language: 'en' });
    assert.equal(legacy.root, shipped.root, 'the retired mirror takes the lab directory itself as its root');

    const shippedRead = shipped.read('');
    const legacyRead = legacy.read('');
    assert.equal(shippedRead.ok, true);
    assert.equal(legacyRead.ok, true);

    // the divergence itself, named: array of records vs object keyed by slug
    assert.equal(Array.isArray(shippedRead.index.components), false, 'the shipped module returns the persisted object');
    assert.equal(Array.isArray(legacyRead.index.components), true, 'the retired mirror returns the retired array shape');
    assert.equal(legacyRead.index.components[0].slug, created.slug, 'the retired record carries its slug as a field');
    assert.equal(
      Object.prototype.hasOwnProperty.call(shippedRead.index.components, created.slug),
      true,
      'the shipped document carries its slug as the key',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(shippedRead.index.components[created.slug], 'slug'),
      false,
      'the shipped document does not repeat the slug inside the record',
    );

    // ...but both copies describe the same store
    assert.deepEqual(
      sortedList(legacyRead.index.components.map((component) => component.slug)),
      sortedList(Object.keys(shippedRead.index.components)),
      'both copies describe the same component set',
    );
    assert.equal(legacyRead.index.components[0].name, shippedRead.index.components[created.slug].name);
    assert.equal(legacyRead.index.components[0].revision, shippedRead.index.components[created.slug].revision);
    assert.equal(legacyRead.index.version, shippedRead.index.version);
    assert.equal(legacyRead.index.preferredLanguage, shippedRead.index.preferredLanguage);
    assert.deepEqual(Object.keys(legacyRead.index.tags), Object.keys(shippedRead.index.tags));

    const legacySnapshot = legacy.visualizationSnapshot();
    const shippedSnapshot = shipped.visualizationSnapshot();
    assert.equal(Array.isArray(legacySnapshot.index.components), true, 'the retired snapshot also keeps the array shape');
    assert.equal(Array.isArray(shippedSnapshot.index.components), false, 'the shipped snapshot hands back the persisted object');
    assert.deepEqual(
      sortedList(Object.keys(legacySnapshot.contents)),
      sortedList(Object.keys(shippedSnapshot.contents)),
      'contents keys are the slugs in both copies',
    );
    assert.equal(legacySnapshot.contents[created.slug], shippedSnapshot.contents[created.slug]);
  });

  // =========================================================================
  // real-store compatibility
  //
  // The live store at %USERPROFILE%\.Newmark\Memory Lab is the user's production
  // data: it is read only. Every mutation below happens on a throwaway copy under
  // os.tmpdir(), and the last check proves the live index.json is byte-identical.
  // =========================================================================

  realStoreRoot = path.join(process.env.USERPROFILE || os.homedir(), '.Newmark', 'Memory Lab');
  realIndexPath = path.join(realStoreRoot, 'index.json');
  realPresent = fs.existsSync(realIndexPath);
  if (!realPresent) {
    console.log('SKIP real-store (not present)');
  } else {
    const stat = fs.statSync(realIndexPath);
    realBefore = { size: stat.size, mtimeMs: stat.mtimeMs, bytes: fs.readFileSync(realIndexPath) };
    realOriginal = JSON.parse(realBefore.bytes.toString('utf8'));
    realTreeBefore = snapshotTree(realStoreRoot);
    compatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-compat-'));
    compatCopyDir = path.join(compatRoot, 'Memory Lab');
    fs.cpSync(realStoreRoot, compatCopyDir, { recursive: true });
    console.log(`# real store: ${realStoreRoot}`);
    console.log(`# real store copy: ${compatCopyDir}`);
  }

  // 21 ---------------------------------------------------------------------
  check('21. real store: read-only inspection never writes to the live store', () => {
    if (!realPresent) return;
    const store = new MemoryLabStore(realStoreRoot);
    assert.equal(store.root, realStoreRoot, 'a root that already is a Memory Lab is used as it is');
    const read = store.read('');
    assert.equal(read.ok, true);
    assert.equal(read.index.version, 2, 'the real index is version 2');
    assert.equal(read.index.preferredLanguage, realOriginal.preferredLanguage, 'preferredLanguage is preserved by a read');
    assert.equal(
      Array.isArray(read.index.components),
      false,
      'a read of the live store hands back the persisted shape: components keyed by slug',
    );
    assert.equal(Object.keys(read.index.components).length, Object.keys(realOriginal.components).length);
    assert.deepEqual(
      sortedList(Object.keys(read.index.components)),
      sortedList(Object.keys(realOriginal.components)),
      'the read keys are exactly the stored component slugs',
    );
    assert.deepEqual(
      sortedList(Object.keys(read.index.tags)),
      sortedList(Object.keys(realOriginal.tags)),
      'a read must not rename a single tag',
    );
    for (const [slug, meta] of Object.entries(realOriginal.components)) {
      const component = read.index.components[slug];
      assert.ok(component, `component ${slug} is indexed under its own slug key`);
      assert.equal(component.path, meta.path, 'a read preserves the stored absolute path byte-exactly');
      assert.equal(component.coreMd, meta.coreMd, 'a read preserves the stored coreMd byte-exactly');
    }
    const snapshot = store.visualizationSnapshot();
    assert.equal(snapshot.ok, true);
    assert.equal(Object.keys(snapshot.contents).length, Object.keys(realOriginal.components).length);
    assert.equal(Array.isArray(snapshot.index.components), false, 'the live snapshot hands back components keyed by slug too');
    assert.deepEqual(
      sortedList(Object.keys(snapshot.contents)),
      sortedList(Object.keys(snapshot.index.components)),
      'the live snapshot contents keys are exactly the persisted slugs',
    );
    store.query({ query: '论文', limit: 5, maxChars: 12000 });
    assert.deepEqual(snapshotTree(realStoreRoot), realTreeBefore, 'no file byte or mtime changed under the live store');
  });

  // 22 ---------------------------------------------------------------------
  check('22. real store copy: a reindex() round trip is set-identical to the original', () => {
    if (!realPresent) return;
    compatStore = new MemoryLabStore(compatCopyDir);
    const result = compatStore.reindex();
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, [], 'a real-store reindex needs no repairs');
    const after = readJson(path.join(compatCopyDir, 'index.json'));

    assert.equal(after.version, 2);
    assert.equal(after.preferredLanguage, realOriginal.preferredLanguage, 'preferredLanguage is preserved');

    // tag names: no renames, no additions, no removals
    const before = sortedList(Object.keys(realOriginal.tags));
    const now = sortedList(Object.keys(after.tags));
    assert.equal(now.length, before.length, `tag count changed: ${before.length} -> ${now.length}`);
    assert.deepEqual(now, before, `first tag-name difference: ${firstSetDifference(before, now) || 'none'}`);

    // component slugs
    const slugsBefore = sortedList(Object.keys(realOriginal.components));
    const slugsNow = sortedList(Object.keys(after.components));
    assert.deepEqual(slugsNow, slugsBefore, `first slug difference: ${firstSetDifference(slugsBefore, slugsNow) || 'none'}`);

    // every tag node: parents / children / components / aliases identical as sets
    for (const name of before) {
      const expected = realOriginal.tags[name];
      const actual = after.tags[name];
      assert.ok(actual, `tag ${name} survived the rebuild`);
      for (const field of ['parents', 'children', 'components', 'aliases']) {
        const want = sortedList(expected[field] || []);
        const got = sortedList(actual[field] || []);
        assert.deepEqual(got, want, `tag ${name}.${field}: ${firstSetDifference(want, got) || 'none'}`);
      }
    }

    // every component: tags (set) and tagPaths (set of joined strings) identical
    for (const slug of slugsBefore) {
      const expected = realOriginal.components[slug];
      const actual = after.components[slug];
      assert.deepEqual(sortedList(actual.tags || []), sortedList(expected.tags || []), `component ${slug}.tags`);
      assert.deepEqual(
        sortedList((actual.tagPaths || []).map((chain) => chain.join(' > '))),
        sortedList((expected.tagPaths || []).map((chain) => chain.join(' > '))),
        `component ${slug}.tagPaths`,
      );
      assert.equal(
        (actual.tagPaths || []).some((chain) => chain.length === 1),
        (expected.tagPaths || []).some((chain) => chain.length === 1),
        `component ${slug} keeps its single-node tagPaths`,
      );
      assert.equal(actual.name, expected.name);
      assert.equal(actual.createdAt, expected.createdAt, `component ${slug}.createdAt`);
      assert.equal(actual.updatedAt, expected.updatedAt, `component ${slug}.updatedAt is not rewritten by a reindex`);
      assert.equal(actual.kind, expected.kind);
    }
    const singleNodePaths = Object.values(after.components).reduce(
      (total, meta) => total + (meta.tagPaths || []).filter((chain) => chain.length === 1).length,
      0,
    );
    assert.ok(singleNodePaths > 0, `length-1 tagPaths survive on disk (${singleNodePaths} of them)`);
    console.log(
      `# round trip: ${now.length} tags, ${slugsNow.length} components, 0 renamed, 0 membership change, ` +
        `${singleNodePaths} single-node tagPaths kept, first difference: none`,
    );
  });

  // 23 ---------------------------------------------------------------------
  check('23. real store copy: the written index uses the real v2 schema and nothing else', () => {
    if (!realPresent) return;
    const after = readJson(path.join(compatCopyDir, 'index.json'));

    // top level: the real five keys, in the real order, then this module's one extra
    assert.deepEqual(
      Object.keys(after).slice(0, 5),
      ['version', 'updatedAt', 'tags', 'components', 'preferredLanguage'],
      'real top-level key order',
    );
    assert.deepEqual(unexpectedKeys(Object.keys(after).slice(5), ['relationshipVersion']), [], 'only relationshipVersion is added');
    assert.equal(Array.isArray(after.components), false, 'components is a plain object keyed by slug');
    assert.ok(Number.isFinite(Date.parse(after.updatedAt)), 'the index timestamp is ISO');
    assert.ok(Number.isFinite(Date.parse(realOriginal.updatedAt)), 'the original index timestamp is ISO');

    // tag nodes: exactly the real four fields, in the real order
    for (const [name, node] of Object.entries(after.tags)) {
      assert.deepEqual(Object.keys(node), ['parents', 'children', 'components', 'aliases'], `tag ${name} field order`);
    }

    // component entries: the real nine fields first, then this module's integrity fields
    const realFields = ['name', 'description', 'tags', 'tagPaths', 'path', 'coreMd', 'kind', 'createdAt', 'updatedAt'];
    for (const [slug, meta] of Object.entries(after.components)) {
      assert.deepEqual(Object.keys(meta).slice(0, 9), realFields, `component ${slug} field order`);
      assert.deepEqual(unexpectedKeys(Object.keys(meta).slice(9), ['revision', 'contentHash', 'bytes']), [], `component ${slug} extra fields`);
      // The real store holds BOTH kinds: a folder-kind component's container IS the slug
      // directory (the module's own folder contract, asserted at check 20 in this file).
      const expectedPath = meta.kind === 'folder'
        ? path.join(compatCopyDir, 'components', slug)
        : path.join(compatCopyDir, 'components', `${slug}.md`);
      assert.equal(meta.path, expectedPath, `component ${slug}.path is absolute inside the copy`);
      assert.equal(path.isAbsolute(meta.path), true, `component ${slug}.path is absolute`);
      if (path.sep === '\\') {
        assert.equal(meta.path.includes('/'), false, `component ${slug}.path is written Windows-style on win32`);
      }
      assert.equal(meta.coreMd, meta.kind === 'folder' ? path.join(meta.path, 'memory.md') : meta.path, `kind:${meta.kind} keeps coreMd where the module documents it`);
      assert.equal(
        path.relative(path.join(compatCopyDir, 'components'), meta.path),
        path.relative(path.join(realStoreRoot, 'components'), path.resolve(realStoreRoot, realOriginal.components[slug].path)),
        `component ${slug} keeps the same position under components/`,
      );
    }

    // key order is preserved, so a rebuild reorders nothing
    assert.deepEqual(Object.keys(after.tags), Object.keys(realOriginal.tags), 'tag order preserved');
    assert.deepEqual(Object.keys(after.components), Object.keys(realOriginal.components), 'component order preserved');

    // the ONLY differences from the original file are the documented ones
    const difference = firstDifference(realIndexView(realOriginal), realIndexView(after));
    assert.equal(difference, null, `unexpected difference after a no-op rebuild: ${difference}`);
    console.log(
      `# written schema: version ${after.version}, preferredLanguage ${JSON.stringify(after.preferredLanguage)}, ` +
        `${Object.keys(after.tags).length} tag nodes, ${Object.keys(after.components).length} components, ` +
        `first structural difference vs the live index: none`,
    );
  });

  // 24 ---------------------------------------------------------------------
  check('24. real store copy: a contentAppend update archives, audits and reindexes cleanly on a USED store', () => {
    if (!realPresent) return;
    const slug = Object.keys(realOriginal.components).find((name) => name.startsWith('wu-yueliang')) || Object.keys(realOriginal.components)[0];
    const before = compatStore.read(slug);
    assert.equal(before.ok, true);
    const revisionBefore = before.component.revision;
    const updatedAtBefore = before.component.updatedAt;
    const archivedBefore = fs.existsSync(path.join(compatStore.archiveDir, slug))
      ? fs.readdirSync(path.join(compatStore.archiveDir, slug)).length
      : 0;
    /* The premise is not "the copy is pristine". The real store HAS been used: it
     * carries an audit log, an archive and components this gate never wrote, and a
     * gate whose premise is "the user has not used the product" fails the moment the
     * product works. What is asserted instead is the invariant that holds for a store
     * in any state: the existing log is appended to and never truncated, and the
     * mutation adds exactly one line to it. */
    const policyBefore = fs.existsSync(compatStore.policyPath) ? fs.readFileSync(compatStore.policyPath, 'utf8') : '';
    const auditBefore = policyBefore.split('\n').filter((line) => line.trim()).length;

    const canary = 'POLICY-COMPAT-CANARY-7c21';
    const appended = `\n- ${canary}\n`;
    const updated = compatStore.update(
      compatStore.prepareUpdate({
        slug,
        contentAppend: appended,
        reason: 'gate compatibility probe',
        source: 'gate-compat',
        expectedUpdatedAt: updatedAtBefore,
      }),
    );

    assert.equal(updated.ok, true);
    assert.equal(updated.action, 'UPDATE');
    assert.equal(updated.revision, revisionBefore + 1, 'the revision advanced');
    assert.notEqual(updated.updatedAt, updatedAtBefore);
    assert.equal(typeof updated.archived, 'string');
    assert.ok(updated.archived.startsWith(path.join(compatStore.archiveDir, slug) + path.sep), 'archived under the copy');
    assert.equal(fs.readFileSync(updated.archived, 'utf8'), before.content, 'the previous core markdown is archived verbatim');
    assert.equal(fs.readdirSync(path.join(compatStore.archiveDir, slug)).length, archivedBefore + 1);
    assert.equal(fs.readFileSync(updated.receipt.componentFile, 'utf8'), before.content + appended);

    const policyText = fs.readFileSync(compatStore.policyPath, 'utf8');
    assert.equal(policyText.endsWith('\n'), true);
    assert.equal(policyText.startsWith(policyBefore), true, 'an existing audit log is appended to, never truncated or rewritten');
    const records = policyText.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(records.length, auditBefore + 1, 'a used store keeps every earlier audit line and gains exactly one');
    const last = records[records.length - 1];
    assert.equal(last.action, 'UPDATE');
    assert.equal(last.slug, slug);
    assert.match(last.contentHash, /^[0-9a-f]{64}$/, 'the audit line carries a content hash');
    assert.equal(last.contentHash, sha256(before.content + appended));
    assert.equal(JSON.stringify(last).includes(canary), false, 'no memory body text in the audit line this mutation wrote');
    assert.equal(JSON.stringify(last).includes('- '), false, 'not even the appended fragment leaks into the audit line');

    // a second reindex leaves the tag graph intact and preserves every stored path
    const beforeSecond = readJson(path.join(compatCopyDir, 'index.json'));
    const pathsBeforeSecondReindex = Object.fromEntries(
      Object.entries(beforeSecond.components).map(([name, meta]) => [name, `${meta.path}\u0000${meta.coreMd}`]),
    );
    const second = compatStore.reindex();
    assert.equal(second.ok, true);
    const after = readJson(path.join(compatCopyDir, 'index.json'));
    for (const [name, meta] of Object.entries(after.components)) {
      assert.equal(
        `${meta.path}\u0000${meta.coreMd}`,
        pathsBeforeSecondReindex[name],
        `component ${name} path/coreMd is preserved verbatim by an in-place reindex`,
      );
    }
    assert.deepEqual(Object.keys(after.tags), Object.keys(realOriginal.tags), 'tag names still identical after the update');
    for (const name of Object.keys(realOriginal.tags)) {
      assert.deepEqual(
        sortedList(after.tags[name].components),
        sortedList(realOriginal.tags[name].components),
        `membership of ${name} changed`,
      );
      assert.deepEqual(sortedList(after.tags[name].parents), sortedList(realOriginal.tags[name].parents), `${name}.parents changed`);
      assert.deepEqual(sortedList(after.tags[name].children), sortedList(realOriginal.tags[name].children), `${name}.children changed`);
      assert.deepEqual(sortedList(after.tags[name].aliases), sortedList(realOriginal.tags[name].aliases), `${name}.aliases changed`);
    }
    const mutated = after.components[slug];
    assert.deepEqual(sortedList(mutated.tags), sortedList(realOriginal.components[slug].tags), 'the updated component keeps its tags');
    assert.deepEqual(
      sortedList(mutated.tagPaths.map((chain) => chain.join(' > '))),
      sortedList(realOriginal.components[slug].tagPaths.map((chain) => chain.join(' > '))),
      'the updated component keeps its tagPaths',
    );
    assert.equal(mutated.revision, revisionBefore + 1);
    assert.equal(mutated.createdAt, realOriginal.components[slug].createdAt, 'createdAt is preserved');
    for (const other of Object.keys(realOriginal.components)) {
      if (other === slug) continue;
      assert.equal(after.components[other].updatedAt, realOriginal.components[other].updatedAt, `${other} was not touched`);
    }
  });

  // 25 ---------------------------------------------------------------------
  check('25. real store: a USED store holds slugs today\'s slugify does not reproduce, and nothing migrates them', () => {
    if (!realPresent) return;
    const mismatches = [];
    for (const [slug, meta] of Object.entries(realOriginal.components)) {
      const produced = slugify(meta.name);
      if (produced !== slug) mismatches.push({ name: meta.name, slug, produced });
    }
    for (const mismatch of mismatches) {
      console.log(`# slug mismatch: name=${JSON.stringify(mismatch.name)} stored=${mismatch.slug} slugify->${mismatch.produced}`);
    }
    const produced = mismatches.map((mismatch) => `${mismatch.name} => ${mismatch.slug} (slugify: ${mismatch.produced})`);
    const expected = KNOWN_SLUG_DIVERGENCES.map((entry) => `${entry.name} => ${entry.slug} (slugify: ${entry.produced})`);
    /* A used store legitimately contains slugs an older slugger minted, so the
     * invariant is NOT "every slug reproduces from its name" — that premise fails as
     * soon as the product is used, exactly as it has here. What must hold is:
     *   (1) the divergences are exactly the documented ones, and every other slug
     *       does reproduce (so a NEW migration would be caught);
     *   (2) a read keeps each stored slug and its name verbatim;
     *   (3) a rebuild keeps them too: a used store is never silently migrated. */
    assert.deepEqual(produced, expected, 'the slug divergences must be exactly the two documented stale slugs');
    assert.ok(
      Object.keys(realOriginal.components).length > mismatches.length,
      `a used store still holds slugs that reproduce (${Object.keys(realOriginal.components).length} components, ${mismatches.length} divergences)`,
    );
    const read = new MemoryLabStore(realStoreRoot).read('');
    assert.equal(read.ok, true);
    for (const entry of KNOWN_SLUG_DIVERGENCES) {
      const stored = read.index.components[entry.slug];
      assert.ok(stored, `${entry.slug} is indexed under its stored slug, not a re-derived one`);
      assert.equal(stored.name, entry.name, `${entry.slug} keeps the name that diverges from it`);
      assert.equal(slugify(stored.name), entry.produced, `${entry.slug} still diverges from its name, unchanged`);
    }
    const rebuilt = readJson(path.join(compatCopyDir, 'index.json'));
    for (const entry of KNOWN_SLUG_DIVERGENCES) {
      assert.ok(rebuilt.components[entry.slug], `${entry.slug} survives a rebuild on the copy instead of being migrated`);
    }
    // the CJK and mixed slugs named by the contract
    assert.equal(slugify('用户专业方向-理论物理与AI交叉'), '用户专业方向-理论物理与ai交叉');
    assert.equal(slugify('4维微分流形-Exotic-R4-论文知识库'), '4维微分流形-exotic-r4-论文知识库');
    assert.equal(slugify('用户专业方向与研究背景'), '用户专业方向与研究背景');
    assert.equal(slugify('Coding Agent 与代码生成'), 'coding-agent-与代码生成');
    assert.equal(slugify('AI Agent 多模态与实时交互'), 'ai-agent-多模态与实时交互');
    assert.equal(slugify('wu-yueliang-latest-hep-papers-2026-07'), 'wu-yueliang-latest-hep-papers-2026-07');
  });

  // 26 ---------------------------------------------------------------------
  check('26. interior tag-path nodes still list their component (real store membership rule)', () => {
    // The real store lists a component under an interior path node as well as under
    // the leaf (`#研究` is interior to ["#研究","#论文"] and still a member of
    // wu-yueliang-latest-hep-papers-2026-07). A hand-written legacy index where a
    // tag has no single-node tagPath is the one shape that can tell the two
    // membership rules apart.
    const membershipRoot = compatRoot
      ? path.join(compatRoot, 'membership')
      : fs.mkdtempSync(path.join(os.tmpdir(), 'nml-membership-'));
    const membershipStore = new MemoryLabStore(membershipRoot);
    membershipStore.ensureLayout();
    const slug = 'interior-probe';
    const core = path.join(membershipStore.componentsDir, `${slug}.md`);
    fs.writeFileSync(core, 'interior probe body');
    fs.writeFileSync(
      membershipStore.indexPath,
      JSON.stringify(
        {
          version: 2,
          updatedAt: '2026-01-01T00:00:00.000Z',
          preferredLanguage: 'auto',
          tags: {
            '#研究': { parents: [], children: ['#论文'], components: [], aliases: [] },
            '#论文': { parents: ['#研究'], children: [], components: [slug], aliases: [] },
          },
          components: {
            [slug]: {
              name: 'Interior Probe',
              description: '',
              tags: ['#研究', '#论文'],
              tagPaths: [['#研究', '#论文']],
              path: core,
              coreMd: core,
              kind: 'file',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        },
        null,
        2,
      ),
    );
    const read = membershipStore.read('');
    assert.deepEqual(read.index.tags['#研究'].components, [slug], 'an interior path node keeps its membership');
    assert.deepEqual(read.index.tags['#论文'].components, [slug]);
    assert.deepEqual(read.index.tags['#论文'].parents, ['#研究']);
    assert.deepEqual(read.index.tags['#研究'].children, ['#论文']);
    membershipStore.reindex();
    const reindexed = readJson(membershipStore.indexPath);
    assert.deepEqual(reindexed.tags['#研究'].components, [slug], 'a rebuild keeps the interior membership');
    assert.deepEqual(reindexed.tags['#论文'].components, [slug]);
  });

  // 27 ---------------------------------------------------------------------
  check('27. real store: the live index.json is byte-identical after the whole run', () => {
    if (!realPresent) return;
    const stat = fs.statSync(realIndexPath);
    assert.equal(stat.size, realBefore.size, 'index.json byte size is unchanged');
    assert.equal(stat.mtimeMs, realBefore.mtimeMs, 'index.json mtime is unchanged');
    assert.equal(sha256(fs.readFileSync(realIndexPath)), sha256(realBefore.bytes), 'index.json content is unchanged');
    assert.deepEqual(snapshotTree(realStoreRoot), realTreeBefore, 'the whole live store is untouched');
  });
  // =========================================================================
  // the shipped module against the real Newmark user root
  //
  // `packages/newmark-core/lib/memory-store.js` — the primary subject of this
  // gate — is handed Newmark's own user root (`~/.Newmark`), where the store
  // lives in the `Memory Lab` folder, so it must resolve that folder and then
  // describe everything the index describes. The live store is the user's
  // production data and is only ever read; every check below runs on throwaway
  // copies under os.tmpdir(), removed in this block's `finally`.
  // =========================================================================

  let coreRealRoot = '';
  let coreStoreRoot = '';
  let coreIndexPath = '';
  let corePresent = false;
  let coreBefore = null;
  let coreOriginal = null;
  let coreTreeBefore = null;
  let coreCompatRoot = null;
  let coreFixtureRoot = null;
  let coreRewritten = null;
  let coreAsIs = null;
  let coreStore = null;

  try {
    coreRealRoot = path.join(process.env.USERPROFILE || os.homedir(), '.Newmark');
    coreStoreRoot = path.join(coreRealRoot, 'Memory Lab');
    coreIndexPath = path.join(coreStoreRoot, 'index.json');
    corePresent = fs.existsSync(coreIndexPath);
    if (!corePresent) {
      console.log('SKIP real-store (not present)');
    } else {
      const stat = fs.statSync(coreIndexPath);
      coreBefore = { size: stat.size, mtimeMs: stat.mtimeMs, bytes: fs.readFileSync(coreIndexPath) };
      coreOriginal = JSON.parse(coreBefore.bytes.toString('utf8'));
      coreTreeBefore = snapshotTree(coreStoreRoot);
      coreCompatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-compat-'));
      console.log(`# shipped module under test: ${MODULE_PATH}`);
      console.log(`# real Newmark user root: ${coreRealRoot}`);
      console.log(`# real store: ${coreStoreRoot}`);
      console.log(`# real store copies: ${coreCompatRoot}`);

      /**
       * Copy the live store to `<dest>/.Newmark/Memory Lab`. With `rewrite` the
       * stored absolute `path`/`coreMd` fields are re-pointed into the copy (the
       * reproduction probe's shape); without it they keep naming the live store.
       */
      const stage = (dest, rewrite) => {
        const lab = path.join(dest, '.Newmark', 'Memory Lab');
        fs.mkdirSync(lab, { recursive: true });
        fs.cpSync(coreStoreRoot, lab, { recursive: true });
        if (rewrite) {
          const index = JSON.parse(coreBefore.bytes.toString('utf8'));
          for (const entry of Object.values(index.components || {})) {
            for (const field of ['path', 'coreMd']) {
              if (typeof entry[field] === 'string') entry[field] = entry[field].split(coreStoreRoot).join(lab);
            }
          }
          fs.writeFileSync(path.join(lab, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
        }
        return { userRoot: path.join(dest, '.Newmark'), lab, indexPath: path.join(lab, 'index.json') };
      };

      coreRewritten = stage(path.join(coreCompatRoot, 'rewritten'), true);
      coreAsIs = stage(path.join(coreCompatRoot, 'as-is'), false);
    }

    // 28 -------------------------------------------------------------------
    check('28. newmark-core real store: read("") returns every component and every tag', () => {
      if (!corePresent) return;
      coreStore = new MemoryLabStore(coreRewritten.userRoot, { language: 'auto' });
      assert.equal(coreStore.root, coreRewritten.lab, 'the user root resolves to its Memory Lab folder, not to a sibling index.json');
      const read = coreStore.read('');
      assert.equal(read.ok, true, `the copied index reads (${read.status})`);
      assert.equal(read.status, 'ok');
      assert.equal(Array.isArray(read.index.components), false, 'a read hands back the persisted shape: components keyed by slug');

      const wantSlugs = sortedList(Object.keys(coreOriginal.components));
      const gotSlugs = sortedList(Object.keys(read.index.components));
      assert.equal(gotSlugs.length, wantSlugs.length, `component count changed: ${wantSlugs.length} -> ${gotSlugs.length}`);
      assert.deepEqual(gotSlugs, wantSlugs, `first component difference: ${firstSetDifference(wantSlugs, gotSlugs) || 'none'}`);

      const wantTags = sortedList(Object.keys(coreOriginal.tags));
      const gotTags = sortedList(Object.keys(read.index.tags));
      assert.equal(gotTags.length, wantTags.length, `tag count changed: ${wantTags.length} -> ${gotTags.length}`);
      assert.deepEqual(gotTags, wantTags, `first tag difference: ${firstSetDifference(wantTags, gotTags) || 'none'}`);

      assert.equal(read.index.version, 2, 'the read keeps the real schema version');
      assert.equal(read.index.preferredLanguage, coreOriginal.preferredLanguage, 'preferredLanguage survives a read');

      for (const slug of wantSlugs) {
        const entry = read.index.components[slug];
        assert.ok(entry, `component ${slug} is indexed`);
        assert.ok(
          String(entry.path).startsWith(coreRewritten.lab + path.sep),
          `component ${slug}.path stays inside the copy (${entry.path})`,
        );
        assert.ok(fs.existsSync(entry.path), `component ${slug}.path resolves to a real file`);
        assert.equal(entry.coreMd, entry.kind === 'folder' ? path.join(entry.path, 'memory.md') : entry.path, `component ${slug} keeps coreMd where kind:${entry.kind} documents it`);
      }
    });

    // 29 -------------------------------------------------------------------
    check('29. newmark-core real store: visualizationSnapshot() carries every component with markdown', () => {
      if (!corePresent) return;
      const snapshot = coreStore.visualizationSnapshot();
      assert.equal(snapshot.ok, true);
      const wantSlugs = sortedList(Object.keys(coreOriginal.components));

      const indexSlugs = sortedList(Object.keys(snapshot.index.components));
      assert.equal(indexSlugs.length, wantSlugs.length, `snapshot index: ${indexSlugs.length} components`);
      assert.deepEqual(indexSlugs, wantSlugs, `snapshot index difference: ${firstSetDifference(wantSlugs, indexSlugs) || 'none'}`);

      const contentSlugs = sortedList(Object.keys(snapshot.contents));
      assert.equal(contentSlugs.length, wantSlugs.length, `snapshot contents: ${contentSlugs.length} of ${wantSlugs.length} components`);
      assert.deepEqual(contentSlugs, wantSlugs, `snapshot contents difference: ${firstSetDifference(wantSlugs, contentSlugs) || 'none'}`);
      assert.deepEqual(sortedList(Object.keys(snapshot.index.tags)), sortedList(Object.keys(coreOriginal.tags)), 'every tag node is in the snapshot');
      for (const slug of wantSlugs) {
        assert.equal(typeof snapshot.contents[slug], 'string', `component ${slug} content is a string`);
        assert.ok(snapshot.contents[slug].trim().length > 0, `component ${slug} renders non-empty markdown in the snapshot`);
      }
    });

    // 30 -------------------------------------------------------------------
    check('30. newmark-core real store: reindex() leaves tags, slugs, membership and tagPaths identical', () => {
      if (!corePresent) return;
      const result = coreStore.reindex();
      assert.equal(result.ok, true);
      assert.deepEqual(result.warnings, [], 'a real-store rebuild needs no repairs');
      const after = readJson(coreRewritten.indexPath);

      assert.equal(after.version, 2);
      assert.equal(after.preferredLanguage, coreOriginal.preferredLanguage, 'preferredLanguage is preserved by a rebuild');
      assert.deepEqual(Object.keys(after.tags), Object.keys(coreOriginal.tags), 'tag names are identical, in the same order');
      assert.deepEqual(Object.keys(after.components), Object.keys(coreOriginal.components), 'component slugs are identical, in the same order');

      for (const [name, node] of Object.entries(coreOriginal.tags)) {
        const now = after.tags[name];
        assert.ok(now, `tag ${name} survived the rebuild`);
        for (const field of ['parents', 'children', 'components', 'aliases']) {
          assert.deepEqual(sortedList(now[field]), sortedList(node[field]), `tag ${name}.${field}: ${firstSetDifference(sortedList(node[field]), sortedList(now[field])) || 'changed'}`);
        }
      }

      for (const [slug, meta] of Object.entries(coreOriginal.components)) {
        const now = after.components[slug];
        assert.ok(now, `component ${slug} survived the rebuild`);
        assert.deepEqual(sortedList(now.tags), sortedList(meta.tags), `component ${slug}.tags changed`);
        assert.deepEqual(
          sortedList((now.tagPaths || []).map((chain) => chain.join(' > '))),
          sortedList((meta.tagPaths || []).map((chain) => chain.join(' > '))),
          `component ${slug}.tagPaths changed`,
        );
        assert.equal(now.name, meta.name, `component ${slug}.name changed`);
        assert.equal(now.kind, meta.kind, `component ${slug}.kind changed`);
        assert.equal(now.createdAt, meta.createdAt, `component ${slug}.createdAt changed`);
        assert.equal(now.updatedAt, meta.updatedAt, `component ${slug}.updatedAt was rewritten`);
      }

      const singleNodePaths = Object.values(after.components).reduce(
        (total, meta) => total + (meta.tagPaths || []).filter((chain) => chain.length === 1).length,
        0,
      );
      assert.ok(singleNodePaths > 0, `length-1 tagPaths survive on disk (${singleNodePaths} of them)`);
    });

    // 31 -------------------------------------------------------------------
    check('31. newmark-core real store: a root whose stored paths point elsewhere still describes everything', () => {
      if (!corePresent) return;
      const rawBefore = fs.readFileSync(coreAsIs.indexPath, 'utf8');
      assert.equal(rawBefore, coreBefore.bytes.toString('utf8'), 'the as-is copy keeps the live index byte-for-byte, no path rewrite');

      const store = new MemoryLabStore(coreAsIs.userRoot, { language: 'auto' });
      const read = store.read('');
      assert.equal(read.ok, true, `the unrewritten copy still reads (${read.status})`);
      const wantSlugs = sortedList(Object.keys(coreOriginal.components));
      const gotSlugs = sortedList(Object.keys(read.index.components));
      assert.deepEqual(gotSlugs, wantSlugs, `a path that fails containment must not drop a component: ${firstSetDifference(wantSlugs, gotSlugs) || 'none'}`);
      assert.deepEqual(
        sortedList(Object.keys(read.index.tags)),
        sortedList(Object.keys(coreOriginal.tags)),
        'every tag node survives an unmatched root',
      );
      assert.equal(read.index.version, 2);
      assert.equal(read.index.preferredLanguage, coreOriginal.preferredLanguage);

      const snapshot = store.visualizationSnapshot();
      const contentSlugs = sortedList(Object.keys(snapshot.contents));
      assert.deepEqual(contentSlugs, wantSlugs, `the snapshot keeps every component: ${firstSetDifference(wantSlugs, contentSlugs) || 'none'}`);
      for (const slug of wantSlugs) {
        assert.ok(snapshot.contents[slug].trim().length > 0, `component ${slug} still resolves to readable markdown from the new root`);
      }

      assert.equal(fs.readFileSync(coreAsIs.indexPath, 'utf8'), rawBefore, 'reading a store never rewrites its index');
      assert.deepEqual(snapshotTree(coreStoreRoot), coreTreeBefore, 'an unmatched root never makes the read fall back to the live files');
    });

    // 32 -------------------------------------------------------------------
    check('32. newmark-core real store: one targeted mutation archives, audits and leaves the rest alone', () => {
      if (!corePresent) return;
      const slug =
        Object.keys(coreOriginal.components).find((name) => name.startsWith('wu-yueliang')) ||
        Object.keys(coreOriginal.components)[0];
      const before = coreStore.read(slug);
      assert.equal(before.ok, true, `component ${slug} reads before the mutation`);
      const revisionBefore = before.component.revision;
      const updatedAtBefore = before.component.updatedAt;
      /* Same premise as check 24, and for the same reason: the live store has been
       * used, so what is asserted is the invariant that survives use — an existing
       * audit log is appended to, never replaced, and one mutation adds one line. */
      const policyBefore = fs.existsSync(coreStore.policyPath) ? fs.readFileSync(coreStore.policyPath, 'utf8') : '';
      const auditBefore = policyBefore.split('\n').filter((line) => line.trim()).length;

      const canary = 'CORE-COMPAT-CANARY-4d17';
      const appended = `\n- ${canary}\n`;
      const updated = coreStore.update(
        coreStore.prepareUpdate({
          slug,
          contentAppend: appended,
          reason: 'gate newmark-core compatibility probe',
          source: 'gate-newmark-core',
          expectedUpdatedAt: updatedAtBefore,
        }),
      );

      assert.equal(updated.ok, true);
      assert.equal(updated.action, 'UPDATE');
      assert.equal(updated.revision, revisionBefore + 1, 'the revision advanced');
      assert.notEqual(updated.updatedAt, updatedAtBefore, 'updatedAt advanced');
      assert.equal(typeof updated.archived, 'string', 'the previous revision is archived');
      assert.ok(
        updated.archived.startsWith(path.join(coreStore.archiveDir, slug) + path.sep),
        `the archive lives under the copy (${updated.archived})`,
      );
      assert.equal(fs.readFileSync(updated.archived, 'utf8'), before.content, 'the previous core markdown is archived verbatim');
      assert.equal(fs.readFileSync(updated.receipt.componentFile, 'utf8'), before.content + appended, 'the append landed in the core markdown');

      const policyText = fs.readFileSync(coreStore.policyPath, 'utf8');
      assert.equal(policyText.endsWith('\n'), true, 'the audit log stays append-only line oriented');
      assert.equal(policyText.startsWith(policyBefore), true, 'the existing audit log is appended to, never truncated or rewritten');
      const records = policyText.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(records.length, auditBefore + 1, `a used store gains exactly one audit line (${auditBefore} -> ${records.length})`);
      const last = records[records.length - 1];
      assert.equal(last.action, 'UPDATE');
      assert.equal(last.slug, slug);
      assert.match(last.contentHash, /^[0-9a-f]{64}$/, 'the audit line carries a content hash');
      assert.equal(last.contentHash, sha256(before.content + appended), 'the hash is the new revision hash');
      assert.equal(JSON.stringify(last).includes(canary), false, 'no body text in the audit line this mutation wrote');
      assert.equal(JSON.stringify(last).includes(before.content.slice(0, 24)), false, 'not even the previous body leaks into it');

      const second = coreStore.reindex();
      assert.equal(second.ok, true);
      const after = readJson(coreRewritten.indexPath);
      assert.equal(after.version, 2);
      assert.equal(after.preferredLanguage, coreOriginal.preferredLanguage, 'preferredLanguage survives the update + rebuild');
      assert.deepEqual(Object.keys(after.tags), Object.keys(coreOriginal.tags), 'tag names are identical after the update');

      for (const [name, node] of Object.entries(coreOriginal.tags)) {
        assert.deepEqual(sortedList(after.tags[name].components), sortedList(node.components), `membership of ${name} changed`);
        assert.deepEqual(sortedList(after.tags[name].parents), sortedList(node.parents), `${name}.parents changed`);
        assert.deepEqual(sortedList(after.tags[name].children), sortedList(node.children), `${name}.children changed`);
        assert.deepEqual(sortedList(after.tags[name].aliases), sortedList(node.aliases), `${name}.aliases changed`);
      }
      for (const [other, meta] of Object.entries(coreOriginal.components)) {
        assert.deepEqual(sortedList(after.components[other].tags), sortedList(meta.tags), `${other}.tags changed`);
        assert.deepEqual(
          sortedList((after.components[other].tagPaths || []).map((chain) => chain.join(' > '))),
          sortedList((meta.tagPaths || []).map((chain) => chain.join(' > '))),
          `${other}.tagPaths changed`,
        );
        if (other !== slug) assert.equal(after.components[other].updatedAt, meta.updatedAt, `${other} was not touched`);
      }
      assert.equal(after.components[slug].revision, revisionBefore + 1);
      assert.equal(after.components[slug].createdAt, coreOriginal.components[slug].createdAt, 'createdAt is preserved by an update');
    });

    // 33 -------------------------------------------------------------------
    check('33. newmark-core: a component whose core markdown is missing is kept and reported', () => {
      coreFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-compat-'));
      const store = new MemoryLabStore(path.join(coreFixtureRoot, '.Newmark'), { language: 'en' });
      assert.equal(store.root, path.join(coreFixtureRoot, '.Newmark', 'Memory Lab'), 'a fresh user root creates the store in its Memory Lab folder');
      store.ensureLayout();
      const present = 'kept-present';
      const absent = 'kept-missing';
      fs.writeFileSync(path.join(store.componentsDir, `${present}.md`), '# Present\n\nA body that exists.\n', 'utf8');
      const entry = (name) => ({
        name,
        description: '',
        tags: ['#记忆'],
        tagPaths: [['#记忆'], ['#记忆', '#保留']],
        path: '',
        coreMd: '',
        kind: 'file',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const components = { [present]: entry('Kept Present'), [absent]: entry('Kept Missing') };
      for (const slug of [present, absent]) {
        const core = path.join(store.componentsDir, `${slug}.md`);
        components[slug].path = core;
        components[slug].coreMd = core;
      }
      fs.writeFileSync(
        store.indexPath,
        JSON.stringify(
          {
            version: 2,
            updatedAt: '2026-01-01T00:00:00.000Z',
            preferredLanguage: 'auto',
            tags: {
              '#记忆': { parents: [], children: ['#保留'], components: [absent, present], aliases: [] },
              '#保留': { parents: ['#记忆'], children: [], components: [absent, present], aliases: [] },
            },
            components,
          },
          null,
          2,
        ),
        'utf8',
      );

      const read = store.read('');
      assert.equal(read.ok, true);
      assert.deepEqual(
        sortedList(Object.keys(read.index.components)),
        [absent, present],
        'a missing core markdown file never drops a component from the index',
      );
      assert.deepEqual(sortedList(Object.keys(read.index.tags)), ['#保留', '#记忆'], 'its tags stay in the graph');

      const snapshot = store.visualizationSnapshot();
      assert.deepEqual(sortedList(Object.keys(snapshot.contents)), [absent, present], 'the snapshot keeps both keys');
      assert.ok(snapshot.contents[present].trim().length > 0, 'the present component carries markdown');
      assert.equal(snapshot.contents[absent], '', 'the missing component is an empty body, not a missing key');

      const rebuilt = store.reindex();
      assert.equal(rebuilt.ok, true);
      assert.ok(
        rebuilt.warnings.includes(`missing-core:${absent}`),
        `the missing core must be reported in warnings, got ${JSON.stringify(rebuilt.warnings)}`,
      );
      assert.deepEqual(
        sortedList(Object.keys(readJson(store.indexPath).components)),
        [absent, present],
        'the rebuild keeps it too',
      );
    });

    // 34 -------------------------------------------------------------------
    check('34. newmark-core real store: the live index.json and store are byte-identical after the whole run', () => {
      if (!corePresent) return;
      const stat = fs.statSync(coreIndexPath);
      assert.equal(stat.size, coreBefore.size, 'index.json byte size is unchanged');
      assert.equal(stat.mtimeMs, coreBefore.mtimeMs, 'index.json mtime is unchanged');
      assert.equal(sha256(fs.readFileSync(coreIndexPath)), sha256(coreBefore.bytes), 'index.json content is unchanged');
      assert.deepEqual(snapshotTree(coreStoreRoot), coreTreeBefore, 'the whole live store is untouched');
    });

    /* =======================================================================
     * the tag-graph judgement surface
     *
     * `reindex()` is a rule. These checks hold the line between the rule and the
     * judgement: a review must decide nothing and write nothing, an applied decision
     * must be recorded and reversible, and the deterministic rebuild must be exactly
     * what it was before any of this existed.
     * ===================================================================== */

    // 35 -------------------------------------------------------------------
    check('35. tag review: reports candidates and their evidence, and writes nothing at all', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-tagreview-'));
      try {
        const store = new MemoryLabStore(path.join(root, 'Memory Lab'));
        store.ensureLayout();
        const seed = (name, tags, tagPaths) =>
          store.update(store.prepareUpdate({ name, tags, tagPaths, content: `# ${name}\n`, reason: 'tag review fixture', source: 'gate' }));
        /* Names are deliberately distinctive: the review flags names that differ by at
         * most two characters, and a fixture of one-character suffixes would be one
         * giant cluster by that rule — correctly, and uselessly. */
        seed('Tag Root', ['#gate物理研究', '#gate总目录'], [['#gate物理研究'], ['#gate总目录']]);
        seed('Tag Parent', ['#gate总目录', '#gate子课题'], [['#gate总目录'], ['#gate总目录', '#gate子课题']]);
        seed('Tag Synonym', ['#gate协作机制'], [['#gate协作机制']]);
        seed('Tag Synonym Long', ['#gate协作机制扩展'], [['#gate协作机制扩展']]);
        seed('Tag Collapsed', ['#gate协作机制扩展版'], [['#gate协作机制扩展版']]);
        /* A chain whose joined spelling exists: the legacy `#检索/增强` the parser split
         * into two nodes, beside a component that carries `#检索增强` as one tag. */
        seed('Tag Chain', ['#检索'], [['#检索'], ['#检索', '#增强']]);
        seed('Tag Chain One Word', ['#检索增强'], [['#检索增强']]);

        const tree = snapshotTree(store.root);
        const before = readJson(store.indexPath);
        const review = store.tagReview({ limit: 100 });
        assert.deepEqual(snapshotTree(store.root), tree, 'a review must not create, delete or rewrite a single file');
        assert.equal(readJson(store.indexPath).relationshipVersion, before.relationshipVersion, 'a review must not change the graph');

        assert.equal(review.ok, true);
        assert.equal(review.counts.tags, Object.keys(before.tags).length, 'the review counts the tags it read');
        for (const kind of TAG_FINDING_KINDS) assert.equal(typeof review.counts.byKind[kind], 'number', `the review counts ${kind} findings`);
        assert.ok(review.findings.length > 0, 'the fixture raises findings');
        for (const finding of review.findings) {
          assert.ok(finding.id && finding.kind && finding.question, `finding ${finding.id} is named and asks something`);
          assert.ok(finding.evidence && typeof finding.evidence === 'object', `finding ${finding.id} carries its evidence`);
          assert.ok(Array.isArray(finding.options) && finding.options.length > 0, `finding ${finding.id} names the decisions that answer it`);
        }

        const falseRoot = review.findings.find((finding) => finding.kind === 'false-root' && finding.evidence.tag === '#gate物理研究');
        assert.ok(falseRoot, 'a root whose memories are filed elsewhere is reported');
        assert.ok(
          falseRoot.evidence.candidates.some((candidate) => candidate.tag === '#gate总目录'),
          `the candidate parent is named: ${JSON.stringify(falseRoot.evidence.candidates)}`,
        );
        assert.deepEqual(
          falseRoot.options,
          falseRoot.evidence.candidates.map((candidate) => ({ kind: 'reparent', tag: '#gate物理研究', under: candidate.tag })),
          'the options are exactly the re-parent decisions its evidence supports',
        );

        const synonym = review.findings.find(
          (finding) => finding.kind === 'synonym-candidate' && finding.evidence.tags.some((entry) => entry.tag === '#gate协作机制扩展版'),
        );
        assert.ok(synonym, 'two spellings of one idea are reported');
        assert.equal(synonym.evidence.stableInto, '#gate协作机制', 'the spelling a later rebuild would keep is named');
        assert.ok(synonym.evidence.why.length > 0, 'and why they look like one tag');

        const collapsed = review.findings.find((finding) => finding.kind === 'single-tag-path' && finding.evidence.tag === '#gate协作机制扩展版');
        assert.ok(collapsed, 'a name that may be a collapsed path is reported');
        assert.equal(collapsed.evidence.prefixTag, '#gate协作机制扩展', 'the part that is already a tag is named');
        assert.ok(
          collapsed.options.some((option) => option.kind === 'split' && option.into[0] === '#gate协作机制扩展'),
          `the split that would repair it is offered: ${JSON.stringify(collapsed.options)}`,
        );

        const oneTag = review.findings.find((finding) => finding.kind === 'path-might-be-one-tag');
        assert.ok(oneTag, 'a chain whose joined spelling exists is reported');
        assert.deepEqual(oneTag.evidence.chain, ['#检索', '#增强']);
        assert.deepEqual(oneTag.evidence.existingTags, ['#检索增强']);

        const windowed = store.tagReview({ kinds: ['single-tag-path'], limit: 1, offset: 0 });
        assert.equal(windowed.findings.length, 1, 'a review honours the page size');
        assert.equal(windowed.window.total, windowed.counts.byKind['single-tag-path'], 'and says how many there are in total');
        assert.equal(windowed.window.omitted, windowed.window.total - 1, 'and how many it left out');
        assert.ok(
          windowed.findings.every((finding) => finding.kind === 'single-tag-path'),
          'a kind filter returns only that kind',
        );
        assert.throws(() => store.tagReview({ kinds: ['no-such-kind'] }), isMemoryLabError('UNKNOWN_FINDING_KIND'));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    // 36 -------------------------------------------------------------------
    check('36. tag apply: a decision is archived, recorded, applied — and reversing it restores the graph', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-tagapply-'));
      try {
        const store = new MemoryLabStore(path.join(root, 'Memory Lab'));
        store.ensureLayout();
        const seed = (name, tags, tagPaths) =>
          store.update(store.prepareUpdate({ name, tags, tagPaths, content: `# ${name}\n`, reason: 'tag apply fixture', source: 'gate' }));
        seed('Harness', ['#Harness'], [['#Harness']]);
        seed('Harness Engineering', ['#Harness工程', '#工具'], [['#Harness工程'], ['#Harness工程', '#工具']]);
        seed('Math Root', ['#gate数学', '#gate研究'], [['#gate数学'], ['#gate研究']]);
        const versionBefore = readJson(store.indexPath).relationshipVersion;
        const policyEventsBefore = store.policyLog().length;

        /* A merge in the direction the store's own spelling rule keeps: linked, so the
         * fold survives every later rebuild. */
        const merged = store.applyTagDecisions({
          decisions: [{ kind: 'merge', tags: ['#Harness工程'], into: '#Harness' }],
          reason: 'gate: fold two spellings',
          source: 'gate',
        });
        assert.equal(merged.ok, true);
        assert.equal(merged.changed, true);
        assert.equal(merged.applied[0].linked, true, 'the merge recorded a fold link, because the spelling rule keeps it');
        assert.equal(merged.relationshipVersionBefore, versionBefore);
        assert.notEqual(merged.relationshipVersionAfter, versionBefore, 'the graph version moved');

        const mergedIndex = readJson(store.indexPath);
        assert.ok(!mergedIndex.tags['#Harness工程'], 'the folded spelling is no longer a node of its own');
        assert.ok(mergedIndex.tags['#Harness'].aliases.includes('#Harness工程'), 'it is preserved as an alias of the canonical tag');
        assert.ok(mergedIndex.components['harness-engineering'].tags.includes('#Harness'), 'the component was re-spelled');

        assert.equal(typeof merged.archived, 'string', 'the pre-change index is archived');
        assert.ok(merged.archived.startsWith(path.join(store.archiveDir, '_tag-graph') + path.sep), `the archive lives under archive/_tag-graph (${merged.archived})`);
        const archivedIndex = readJson(merged.archived);
        assert.equal(archivedIndex.relationshipVersion, versionBefore, 'the archived document is the graph as it was, verbatim');
        assert.ok(archivedIndex.tags['#Harness工程'], 'including the node the merge folded away');

        const events = store.policyLog();
        assert.equal(events.length, policyEventsBefore + 1, 'one decision batch is one audit line');
        const event = events[events.length - 1];
        assert.equal(event.action, 'TAG-EDIT');
        assert.deepEqual(event.kinds, ['merge']);
        assert.equal(event.archivePath, merged.archived);
        assert.equal(event.previousRelationshipVersion, versionBefore);
        assert.equal(event.relationshipVersion, merged.relationshipVersionAfter);
        assert.deepEqual(event.undo, merged.undo, 'the audit line carries the same undo the receipt does');
        assert.ok(
          event.affected.some((entry) => entry.slug === 'harness-engineering' && entry.before.tags.includes('#Harness工程')),
          'the audit line records the previous tags of every component it touched',
        );
        assert.equal(
          event.affected.some((entry) => JSON.stringify(entry).includes('# Harness Engineering')),
          false,
          'and never the memory body',
        );

        /* Reversal is mechanical: the receipt's own decision list, passed back. */
        const undone = store.applyTagDecisions({ decisions: merged.undo, reason: 'gate: undo the merge', source: 'gate' });
        assert.equal(undone.relationshipVersionAfter, versionBefore, 'the undo returns relationshipVersion to exactly what it was');
        const reindexed = store.reindex();
        assert.equal(reindexed.relationshipVersion, versionBefore, 'and a later plain rebuild agrees: the fold link is gone');

        /* A re-parent, the same contract. */
        const reparented = store.applyTagDecisions({
          decisions: [{ kind: 'reparent', tag: '#gate数学', under: '#gate研究' }],
          reason: 'gate: continue a false root',
          source: 'gate',
        });
        assert.equal(reparented.changed, true);
        const reparentedIndex = readJson(store.indexPath);
        assert.deepEqual(reparentedIndex.tags['#gate数学'].parents, ['#gate研究'], 'the tag now sits under its parent');
        assert.equal(
          reparentedIndex.components['math-root'].tagPaths.some((chain) => chain[0] === '#gate研究' && chain[1] === '#gate数学'),
          true,
          'the chain that rooted it was rewritten to continue under the parent',
        );
        const reparentUndone = store.applyTagDecisions({ decisions: reparented.undo, source: 'gate' });
        assert.equal(reparentUndone.relationshipVersionAfter, reparented.relationshipVersionBefore, 'a re-parent is reversible too');

        /* A split: one stored name that is really a chain. */
        seed('Collapsed', ['#gate根延伸'], [['#gate根延伸']]);
        seed('Root For Split', ['#gate根'], [['#gate根']]);
        const split = store.applyTagDecisions({
          decisions: [{ kind: 'split', tag: '#gate根延伸', into: ['#gate根', '#延伸'] }],
          reason: 'gate: a name that is a chain',
          source: 'gate',
        });
        assert.equal(split.changed, true);
        const splitIndex = readJson(store.indexPath);
        assert.ok(!splitIndex.tags['#gate根延伸'], 'the collapsed name is gone');
        assert.deepEqual(splitIndex.tags['#gate根'].children, ['#延伸'], 'and the chain it really was is in the graph');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    // 37 -------------------------------------------------------------------
    check('37. tag apply: refuses what cannot work, changes nothing on a dry run, and leaves reindex() alone', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-tagrefuse-'));
      try {
        const store = new MemoryLabStore(path.join(root, 'Memory Lab'));
        store.ensureLayout();
        store.update(store.prepareUpdate({ name: 'Chain', tags: ['#检索'], tagPaths: [['#检索'], ['#检索', '#增强']], content: '# chain\n', reason: 'gate', source: 'gate' }));
        store.update(store.prepareUpdate({ name: 'One Word', tags: ['#检索增强'], content: '# one word\n', reason: 'gate', source: 'gate' }));
        const version = readJson(store.indexPath).relationshipVersion;
        const tree = snapshotTree(store.root);

        assert.throws(
          () => store.applyTagDecisions({ decisions: [{ kind: 'join', path: ['#检索', '#增强'], into: '#检索/#增强' }] }),
          isMemoryLabError('UNREPRESENTABLE_TAG_NAME'),
          'a name the parser would split again is refused by name, because a rebuild would undo it',
        );
        assert.throws(() => store.applyTagDecisions({ decisions: [{ kind: 'nonsense' }] }), isMemoryLabError('UNKNOWN_DECISION'));
        assert.throws(() => store.applyTagDecisions({ decisions: [] }), isMemoryLabError('INVALID_DECISION'));
        assert.throws(() => store.applyTagDecisions({ decisions: [{ kind: 'merge', tags: ['#检索'], into: '#nothing-here' }] }), isMemoryLabError('NOT_FOUND'));
        assert.throws(
          () => store.applyTagDecisions({ decisions: [{ kind: 'merge', tags: ['#检索'], into: '#检索增强' }], expectedRelationshipVersion: 'not-the-current-version' }),
          isMemoryLabError('STALE_WRITE'),
          'a decision batch reviews a graph version and fails closed if it moved',
        );
        assert.deepEqual(snapshotTree(store.root), tree, 'every refusal above wrote nothing at all');

        const dry = store.applyTagDecisions({ decisions: [{ kind: 'join', path: ['#检索', '#增强'], into: '#检索增强' }], dryRun: true });
        assert.equal(dry.ok, true);
        assert.equal(dry.changed, true);
        assert.notEqual(dry.relationshipVersionAfter, version, 'a dry run reports the version the change would produce');
        assert.deepEqual(snapshotTree(store.root), tree, 'and writes nothing: no index, no archive, no audit line');

        const joined = store.applyTagDecisions({ decisions: [{ kind: 'join', path: ['#检索', '#增强'], into: '#检索增强' }], reason: 'gate: one tag', source: 'gate' });
        assert.equal(joined.changed, true);
        const joinedIndex = readJson(store.indexPath);
        assert.ok(!joinedIndex.tags['#检索'] && !joinedIndex.tags['#增强'], 'the chain nodes are gone');
        assert.deepEqual(joinedIndex.components.chain.tagPaths, [['#检索增强']], 'and the component carries the single tag');

        /* The deterministic entry point is untouched: still no arguments, still a
         * rebuild, still idempotent in the graph. */
        const before = readJson(store.indexPath);
        const rebuilt = store.reindex();
        assert.equal(rebuilt.ok, true);
        assert.deepEqual(rebuilt.warnings, [], 'a rebuild after a decision batch needs no repairs');
        assert.equal(readJson(store.indexPath).relationshipVersion, before.relationshipVersion, 'and it is still graph-idempotent');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    // 38 -------------------------------------------------------------------
    check('38. 解环判定: a cycle in the stored graph is reported with its path and a cut that breaks it', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-cycle-'));
      try {
        const store = new MemoryLabStore(path.join(root, 'Memory Lab'));
        store.ensureLayout();
        const componentFile = path.join(store.componentsDir, 'cycle-fixture.md');
        fs.writeFileSync(componentFile, '# cycle fixture\n', 'utf8');
        /* A genuine cycle, written the way a hand-edited, restored or foreign index carries one:
         * the `children` list of each node names the other, AND the component asserts both
         * directions. Nothing about this document is derived — it is the state this finding exists
         * for. Measured below: the load repairs the graph, the file keeps the cycle. */
        const component = {
          name: 'Cycle Fixture',
          description: '',
          tags: ['#cycA', '#cycB'],
          tagPaths: [['#cycA'], ['#cycB'], ['#cycA', '#cycB'], ['#cycB', '#cycA']],
          path: componentFile,
          coreMd: componentFile,
          kind: 'file',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          revision: 1,
        };
        fs.writeFileSync(
          store.indexPath,
          JSON.stringify(
            {
              version: 2,
              updatedAt: '2026-01-01T00:00:00.000Z',
              tags: {
                '#cycA': { parents: ['#cycB'], children: ['#cycB'], components: ['cycle-fixture'], aliases: [] },
                '#cycB': { parents: ['#cycA'], children: ['#cycA'], components: ['cycle-fixture'], aliases: [] },
              },
              components: { 'cycle-fixture': component },
              preferredLanguage: 'auto',
            },
            null,
            2,
          ),
          'utf8',
        );
        const tree = snapshotTree(store.root);
        const loaded = store.loadIndex();
        /* The load is where the cycle disappears, and this is the measurement that matters: the
         * FILE holds both directions and the graph a review is handed holds one, because the
         * normalizer rebuilds it from the component tagPaths and refuses the edge that would close
         * the ring. A reader that looked only at the graph would report nothing while the file
         * stays broken — which is why the finding reads the document. */
        assert.equal(
          loaded.warnings.includes('cyclic-tag-edge-skipped:#cycB->#cycA'),
          true,
          `the normalizer drops the second edge on the way in: ${JSON.stringify(loaded.warnings)}`,
        );
        assert.equal(
          loaded.index.tags['#cycA'].children.includes('#cycB') && loaded.index.tags['#cycB'].children.includes('#cycA'),
          false,
          'so the in-memory graph holds no cycle at all',
        );

        const review = store.tagReview({ kinds: ['cycle-candidate'], limit: 50 });
        assert.deepEqual(snapshotTree(store.root), tree, 'the review still writes nothing');
        const finding = review.findings.find((entry) => entry.kind === 'cycle-candidate');
        assert.ok(finding, `the cycle is reported: ${JSON.stringify(review.counts.byKind)}`);
        assert.equal(finding.evidence.shape, 'stored-cycle', 'and the finding says WHICH shape it is');
        assert.deepEqual(finding.evidence.cycle, ['#cycB', '#cycA', '#cycB'], 'the exact path of the cycle, in order and closed');
        assert.deepEqual(finding.evidence.tags, ['#cycA', '#cycB'], 'with the nodes it runs through');
        assert.equal(finding.evidence.edges.length, 2, 'and every edge of it');
        const asserting = finding.evidence.edges.find((edge) => edge.parent === '#cycA');
        const storedOnly = finding.evidence.edges.find((edge) => edge.parent === '#cycB');
        assert.deepEqual(asserting.assertedBy, ['cycle-fixture'], 'each edge names the component tagPath that asserts it');
        assert.deepEqual(storedOnly.assertedBy, ['cycle-fixture'], 'including the one the rebuild refuses');
        assert.equal(storedOnly.agreed, true, 'both ends of the stored edge claim it');
        assert.ok(
          finding.evidence.normalizerDrops.some((edge) => edge.parent === '#cycB' && edge.child === '#cycA'),
          `the evidence names the edge the normalizer drops: ${JSON.stringify(finding.evidence.normalizerDrops)}`,
        );
        assert.equal(finding.evidence.direction.moreGeneral, null, 'a cycle between two unrelated tags has no more-general side');
        assert.equal(finding.evidence.direction.coOccurrenceOnly, true, 'and the evidence says the direction is not decided');
        assert.equal(finding.evidence.direction.directionDecided, false, 'rather than guessing one');
        assert.ok(
          finding.evidence.direction.why.some((line) => line.includes('no fact in the store decides a direction')),
          `the finding admits it cannot choose: ${JSON.stringify(finding.evidence.direction.why)}`,
        );
        assert.deepEqual(
          finding.options,
          [
            { kind: 'cut', parent: '#cycB', child: '#cycA' },
            { kind: 'cut', parent: '#cycA', child: '#cycB' },
          ],
          'the options are the cuts that would break it — one per edge, in the order of the reported ring',
        );

        /* The cut: the edge the COMPONENT asserts, which is the one a decision can really remove. */
        const cut = store.applyTagDecisions({
          decisions: [{ kind: 'cut', parent: '#cycA', child: '#cycB' }],
          reason: 'gate: break the stored cycle',
          source: 'gate',
          expectedRelationshipVersion: review.relationshipVersion,
        });
        assert.equal(cut.ok, true);
        assert.equal(cut.changed, true);
        assert.deepEqual(cut.applied[0], {
          kind: 'cut',
          parent: '#cycA',
          child: '#cycB',
          removedFrom: [{ slug: 'cycle-fixture', chain: ['#cycA > #cycB'] }],
          assertedBy: ['cycle-fixture'],
          storedOnly: false,
        });
        const afterCut = readJson(store.indexPath);
        const afterCutChains = afterCut.components['cycle-fixture'].tagPaths.map((chain) => chain.join('>')).sort();
        assert.equal(
          JSON.stringify(afterCutChains),
          JSON.stringify(['#cycA', '#cycB', '#cycB>#cycA']),
          'the chain that carried the cut edge is gone, both tags are still DECLARED by the component, and the other direction is untouched — cutting one edge does not undeclare a tag or take the rest of the hierarchy with it',
        );
        assert.deepEqual(afterCut.components['cycle-fixture'].tags, ['#cycA', '#cycB'], 'so the tags themselves survive the cut');
        /* THE MEASUREMENT THAT SAYS WHAT A CUT REALLY DOES: the rebuild that follows it derives
         * the tags dictionary from the components, so the direction that is no longer asserted is
         * gone from the graph too. The cut does not leave the cycle half-stored. */
        assert.equal(
          afterCut.tags['#cycA'].children.includes('#cycB') && afterCut.tags['#cycB'].children.includes('#cycA'),
          false,
          `the written graph holds no cycle either: ${JSON.stringify({ A: afterCut.tags['#cycA'].children, B: afterCut.tags['#cycB'].children })}`,
        );
        const afterCutFindings = store.tagReview({ kinds: ['cycle-candidate'], limit: 50 }).findings;
        assert.equal(
          afterCutFindings.filter((entry) => entry.evidence.shape === 'stored-cycle').length,
          0,
          `the cycle the review reported is gone from the file it reads: ${JSON.stringify(afterCutFindings.map((entry) => entry.id))}`,
        );
        /* Nothing of this kind is left, and that is worth asserting rather than assuming: with the
         * edge gone, `#cycA` parents `#cycB`, so they are not two roots mirroring each other any
         * more either. The two shapes are different questions about the same pair, and a fix for
         * one is not automatically a fix for the other. */
        assert.deepEqual(
          afterCutFindings,
          [],
          `the pair raises neither shape once the cycle is gone: ${JSON.stringify(afterCutFindings.map((entry) => entry.id))}`,
        );
        assert.equal(
          store.tagReview({ limit: 50 }).warnings.some((warning) => warning.startsWith('cyclic-tag-edge-skipped')),
          false,
          'so the rebuild no longer has an edge to skip',
        );

        /* Reversal: a `set-tags` per component, and it restores the assertion — and with it the
         * cycle, which the components are what put there in the first place. */
        assert.ok(
          cut.undo.every((decision) => decision.kind === 'set-tags'),
          `a cut is reversed by restoring the component tags exactly: ${JSON.stringify(cut.undo)}`,
        );
        /* The undo restores the CHAINS, which are a set rather than a sequence — the store sorts
         * tagPaths on every read, so comparing list order would assert the sort rather than the
         * restore. */
        const undoTagsPaths = JSON.stringify(cut.undo[0].tagPaths.map((chain) => chain.join('>')).sort());
        assert.equal(undoTagsPaths, JSON.stringify(['#cycA', '#cycA>#cycB', '#cycB', '#cycB>#cycA']), 'with the previous chains recorded verbatim');
        const undone = store.applyTagDecisions({ decisions: cut.undo, reason: 'gate: undo the cut', source: 'gate' });
        assert.equal(undone.changed, true, 'the undo is a real change, not a no-op');
        const restoredComponent = readJson(store.indexPath).components['cycle-fixture'];
        assert.deepEqual(restoredComponent.tags, ['#cycA', '#cycB'], 'the component carries the same tags it did before the cut');
        assert.equal(
          JSON.stringify(restoredComponent.tagPaths.map((chain) => chain.join('>')).sort()),
          JSON.stringify(['#cycA', '#cycA>#cycB', '#cycB', '#cycB>#cycA']),
          'and the same chains, including the one the cut removed',
        );
        const restoredPolicy = store.policyLog().filter((event) => event.action === 'TAG-EDIT').pop();
        assert.deepEqual(
          restoredPolicy.affected.map((entry) => entry.before.tagPaths.map((chain) => chain.join('>')).sort()),
          [['#cycA', '#cycB', '#cycB>#cycA']],
          'and the audit line records exactly what that component looked like immediately before the undo — the state the cut left',
        );
        const restoredFindings = store.tagReview({ kinds: ['cycle-candidate'], limit: 50 }).findings.filter((entry) => entry.evidence.shape === 'stored-cycle');
        /* Measured, and it is the honest boundary of what an undo is: the undo restores the
         * COMPONENT exactly — both directions are in its tagPaths again, as asserted above — and
         * the file it writes derives its `tags` dictionary from those tagPaths, refusing the edge
         * that would close the ring. So the file is left acyclic, and the warning above is the
         * rebuild saying which edge it refused.
         *
         * The cut's effect is undone; the document the NEXT cut would read is the acyclic one this
         * write produced. That is what this store can promise, and asserting more would be
         * asserting a property no write can have: a cycle cannot survive a rebuild, and an undo IS
         * a write. */
        assert.equal(restoredFindings.length, 0, 'the derived graph the undo writes is acyclic again, and the review reads that');
        assert.deepEqual(
          undone.applied[0],
          { kind: 'set-tags', slug: 'cycle-fixture', reintroduced: [], affected: ['cycle-fixture'] },
          'the undo applied, and it created no tag that did not already exist',
        );

        /* A cut is fail-closed on a self edge. (The other refusal — an edge no index holds — needs
         * two tags that both EXIST, so it is measured in the bare fixture below where such a pair
         * is available; a nonexistent tag is refused by `requireTag`, which is a different check.) */
        assert.throws(
          () => store.applyTagDecisions({ decisions: [{ kind: 'cut', parent: '#cycA', child: '#cycA' }] }),
          isMemoryLabError('TAG_CYCLE'),
          'a tag cannot be its own parent, and the cut says so by name',
        );
        const beforeDryCut = fs.readFileSync(store.indexPath);
        const dryCut = store.applyTagDecisions({ decisions: [{ kind: 'cut', parent: '#cycA', child: '#cycB' }], dryRun: true });
        assert.equal(dryCut.changed, true, 'a dry run of the cut reports the change it would make');
        assert.deepEqual(dryCut.applied[0].removedFrom, [{ slug: 'cycle-fixture', chain: ['#cycA > #cycB'] }], 'and what it would remove');
        assert.ok(fs.readFileSync(store.indexPath).equals(beforeDryCut), 'and writes nothing: no index, no archive, no audit line');

        /* WHY THE CUT IS A DECISION OF ITS OWN, measured rather than asserted in prose — and the
         * measurement is NOT the one this comment first predicted. What it shows:
         *
         *   * the reparent that would make `#cycB` continue under `#cycA` is REFUSED, because
         *     `#cycB` already is inside `#cycA`: accepting it would make `#cycA` its own ancestor;
         *   * the other direction IS accepted, and it DOES clear the ring — the chains starting at
         *     `#cycA` are rewritten to `[#cycB, #cycA]`, and the rebuild that follows derives the
         *     tags dictionary from them, where one of the two directions must be refused.
         *
         * So "reparent cannot break a cycle" is FALSE, and this check is where that was found. What
         * is left is the honest reason `cut` exists: a reparent clears a ring only as a side effect
         * of the normalizer, the edge goes silently, and the receipt says the component moved rather
         * than which edge of the cycle was lost. A cut names the edge, on the record. */
        assert.throws(
          () => store.applyTagDecisions({ decisions: [{ kind: 'reparent', tag: '#cycB', under: '#cycA' }], dryRun: true }),
          isMemoryLabError('TAG_CYCLE'),
          'the reparent that would close the ring is refused, because that node is already inside the other',
        );
        const reparentWithinCycle = store.applyTagDecisions({
          decisions: [{ kind: 'reparent', tag: '#cycA', under: '#cycB' }],
          reason: 'gate: what a reparent inside the cycle really does',
          source: 'gate',
        });
        assert.equal(reparentWithinCycle.applied.length, 1, 'the other direction is accepted');
        assert.deepEqual(reparentWithinCycle.applied[0].affected, ['cycle-fixture'], 'it rewrites the component, so it really was applied');
        assert.equal(
          store.tagReview({ kinds: ['cycle-candidate'], limit: 50 }).findings.filter((entry) => entry.evidence.shape === 'stored-cycle').length,
          0,
          'and it clears the ring — through the normalizer, which is the side effect a cut replaces',
        );
        assert.equal(
          JSON.stringify(reparentWithinCycle.applied[0]).includes('removedFrom'),
          false,
          'and its receipt does not say which edge went: that is the difference a cut makes',
        );
        const reparentUndo = store.applyTagDecisions({ decisions: reparentWithinCycle.undo, reason: 'gate: undo that reparent', source: 'gate' });
        assert.equal(reparentUndo.changed, true, 'and the reparent inside the cycle is itself reversible');

        /* An asymmetric leftover is NOT a cycle, and building the case that proves it took two
         * attempts. The first was a `children` chain with a `parents` claim pointing back along it,
         * and it proved nothing: the walk reads the `children` projection, and the two directions
         * land on one vertex set, so the second walk is deduplicated away before it can be seen.
         * What reaches it is a cycle stored in the `parents` list and NOWHERE else — no `children`
         * edge at all — which is exactly what a hand-edited or foreign index can carry, because
         * `parents` is the list nothing rebuilds from. Measured: reading both projections, the
         * review reported `#cycA -> #cycB -> #cycA` for these bytes; reading `children`, the
         * relation the normalizer's own `tagPathExists()` follows, it reports nothing. */
        const leftoverRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-cycle-leftover-'));
        try {
          const leftover = new MemoryLabStore(path.join(leftoverRoot, 'Memory Lab'));
          leftover.ensureLayout();
          const leftoverFile = path.join(leftover.componentsDir, 'leftover.md');
          fs.writeFileSync(leftoverFile, '# leftover\n', 'utf8');
          fs.writeFileSync(
            leftover.indexPath,
            JSON.stringify(
              {
                version: 2,
                updatedAt: '2026-01-01T00:00:00.000Z',
                tags: {
                  '#cycA': { parents: ['#cycB'], children: [], components: ['leftover'], aliases: [] },
                  '#cycB': { parents: ['#cycA'], children: [], components: ['leftover'], aliases: [] },
                },
                components: {
                  leftover: {
                    name: 'Leftover',
                    description: '',
                    tags: ['#cycA', '#cycB'],
                    tagPaths: [['#cycA'], ['#cycB']],
                    path: leftoverFile,
                    coreMd: leftoverFile,
                    kind: 'file',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    revision: 1,
                  },
                },
                preferredLanguage: 'auto',
              },
              null,
              2,
            ),
            'utf8',
          );
          const leftoverRelations = leftover.storedGraphRelations();
          assert.deepEqual(
            leftoverRelations.names.map((name) => `${name}:children=${JSON.stringify(leftoverRelations.edges.get(name).fromChildren)}`),
            ['#cycA:children=[]', '#cycB:children=[]'],
            'the fixture really holds no children edge at all',
          );
          assert.deepEqual(
            leftoverRelations.names.map((name) => `${name}:parents=${JSON.stringify(leftoverRelations.edges.get(name).fromParents)}`),
            ['#cycA:parents=["#cycB"]', '#cycB:parents=["#cycA"]'],
            'and a two-node cycle in the parents list, which is the leftover under test',
          );
          const leftoverReview = leftover.tagReview({ kinds: ['cycle-candidate'], limit: 50 });
          assert.equal(
            leftoverReview.findings.filter((entry) => entry.evidence.shape === 'stored-cycle').length,
            0,
            `a one-sided leftover claim is not a cycle: ${JSON.stringify(leftoverReview.counts.byKind)}`,
          );
          assert.deepEqual(leftoverReview.warnings, [], 'and the normalizer has nothing to skip, because the relation it reads is acyclic');
        } finally {
          fs.rmSync(leftoverRoot, { recursive: true, force: true });
        }

        /* ---- the two guards the mutation harness found unguarded, each with its own fixture ---- */

        /* (a) A cycle NOTHING asserts. Both edges live only in the tags dictionary, so no component
         * chain carries either one and the cut's suggestion can only come from the edge the
         * normalizer would drop. That is the reachable case for that fallback: a hand-edited index
         * whose components were never updated. */
        const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-cycle-bare-'));
        try {
          const bare = new MemoryLabStore(path.join(bareRoot, 'Memory Lab'));
          bare.ensureLayout();
          /* `#cycD` is a real tag of this store and NOTHING links it to `#cycB`, so a cut of that
           * pair is the refusal under test: both tags exist, the edge does not. */
          const bareFile = path.join(bare.componentsDir, 'bare-tag.md');
          fs.writeFileSync(bareFile, '# bare tag\n', 'utf8');
          const bareCycleFile = path.join(bare.componentsDir, 'bare-cycle.md');
          fs.writeFileSync(bareCycleFile, '# bare cycle\n', 'utf8');
          const bareComponent = (name, tags, tagPaths, file) => ({
            name,
            description: '',
            tags,
            tagPaths,
            path: file,
            coreMd: file,
            kind: 'file',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            revision: 1,
          });
          fs.writeFileSync(
            bare.indexPath,
            JSON.stringify(
              {
                version: 2,
                updatedAt: '2026-01-01T00:00:00.000Z',
                tags: {
                  /* A three-node ring, because a TWO-node one cannot be stored-only: a component can
                   * only carry a tag by naming it in a tagPath, and the two-node path IS the edge.
                   * `bare-cycle` declares `#cycA`, `#cycB` and `#cycC` as single tags, so none of
                   * the ring's three edges is in any component chain — every one of them lives in
                   * the tags dictionary alone. This is the reachable state for the cut's fallback:
                   * a hand-edited index whose components were never updated. */
                  '#cycA': { parents: ['#cycC'], children: ['#cycB'], components: ['bare-cycle'], aliases: [] },
                  '#cycB': { parents: ['#cycA'], children: ['#cycC'], components: ['bare-cycle'], aliases: [] },
                  '#cycC': { parents: ['#cycB'], children: ['#cycA'], components: ['bare-cycle'], aliases: [] },
                  '#cycD': { parents: [], children: [], components: ['bare-tag'], aliases: [] },
                },
                components: {
                  'bare-cycle': bareComponent('Bare Cycle', ['#cycA', '#cycB', '#cycC'], [['#cycA'], ['#cycB'], ['#cycC']], bareCycleFile),
                  'bare-tag': bareComponent('Bare Tag', ['#cycD'], [['#cycD']], bareFile),
                },
                preferredLanguage: 'auto',
              },
              null,
              2,
            ),
            'utf8',
          );
          const missingEdge = (() => {
            try {
              bare.applyTagDecisions({ decisions: [{ kind: 'cut', parent: '#cycB', child: '#cycD' }] });
              return null;
            } catch (error) {
              return error;
            }
          })();
          assert.equal(missingEdge?.code, 'NOT_FOUND', 'a cut of an edge no index holds is refused rather than reported as a repair');
          assert.ok(
            String(missingEdge?.message || '').includes('does not hold the edge'),
            `and it says which edge the index does not hold: ${String(missingEdge?.message || '')}`,
          );
          const bareFinding = bare.tagReview({ kinds: ['cycle-candidate'], limit: 50 }).findings.find((entry) => entry.evidence.shape === 'stored-cycle');
          assert.ok(bareFinding, 'a cycle that only the tags dictionary holds is still reported');
          assert.deepEqual(bareFinding.evidence.cycle, ['#cycB', '#cycC', '#cycA', '#cycB'], 'with the ring its three edges close');
          assert.deepEqual(
            bareFinding.evidence.edges.map((edge) => `${edge.parent}>${edge.child}:${edge.assertedBy.join(',') || 'stored-only'}`),
            ['#cycB>#cycC:stored-only', '#cycC>#cycA:stored-only', '#cycA>#cycB:stored-only'],
            'every edge of it saying no component asserts it, which is what makes this the fallback case',
          );
          assert.ok(
            bareFinding.evidence.normalizerDrops.some(
              (edge) => edge.parent === bareFinding.evidence.suggestedCut.parent && edge.child === bareFinding.evidence.suggestedCut.child,
            ),
            `the suggested cut is the edge the normalizer would drop, which is the only direction the evidence offers: ${JSON.stringify(
              bareFinding.evidence.normalizerDrops,
            )} vs ${JSON.stringify(bareFinding.evidence.suggestedCut)}`,
          );
          assert.equal(bareFinding.evidence.suggestedCut.assertedBy.length, 0, 'the suggested cut is a stored claim, and the evidence says so');
          const bareCut = bare.applyTagDecisions({ decisions: [bareFinding.options[0]], reason: 'gate: stored-only cut', source: 'gate' });
          assert.equal(bareCut.changed, true, 'cutting it is still reported as a change, because the stored graph changes');
          assert.equal(bareCut.applied[0].storedOnly, true, 'and the receipt says no component was rewritten');
          assert.equal(bareCut.applied[0].affected.length, 0, 'because none asserts the edge');
          assert.ok(
            bareCut.warnings.some((warning) => warning.startsWith('cut:')),
            `and a warning says so rather than leaving it to be discovered: ${JSON.stringify(bareCut.warnings)}`,
          );
          assert.equal(
            bare.tagReview({ kinds: ['cycle-candidate'], limit: 50 }).findings.filter((entry) => entry.evidence.shape === 'stored-cycle').length,
            0,
            'the cycle the review reported is gone from the file it reads',
          );
        } finally {
          fs.rmSync(bareRoot, { recursive: true, force: true });
        }

        /* (b) A cut does NOT silently undeclare the parent tag, and the reason is measured here
         * rather than assumed: `normalizeTagInput()` materialises a single-node path for every node
         * of every chain, so `#cycC`'s own `[#cycC]` path carries no edge and survives any cut. A
         * guard that re-declared the parent was written, measured (unreachable on two fixtures),
         * and deleted — so what this check protects is the PROPERTY, not a guard. */
        const undeclareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-cycle-undeclare-'));
        try {
          const undeclare = new MemoryLabStore(path.join(undeclareRoot, 'Memory Lab'));
          undeclare.ensureLayout();
          const file = path.join(undeclare.componentsDir, 'chain-only.md');
          fs.writeFileSync(file, '# chain only\n', 'utf8');
          fs.writeFileSync(
            undeclare.indexPath,
            JSON.stringify(
              {
                version: 2,
                updatedAt: '2026-01-01T00:00:00.000Z',
                tags: {
                  '#cycC': { parents: ['#cycA'], children: ['#cycA'], components: ['chain-only'], aliases: [] },
                  '#cycA': { parents: ['#cycC'], children: ['#cycC'], components: ['chain-only'], aliases: [] },
                },
                components: {
                  'chain-only': {
                    name: 'Chain Only',
                    description: '',
                    tags: ['#cycA', '#cycC'],
                    tagPaths: [['#cycA'], ['#cycC', '#cycA']],
                    path: file,
                    coreMd: file,
                    kind: 'file',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    revision: 1,
                  },
                },
                preferredLanguage: 'auto',
              },
              null,
              2,
            ),
            'utf8',
          );
          const undeclareCut = undeclare.applyTagDecisions({
            decisions: [{ kind: 'cut', parent: '#cycC', child: '#cycA' }],
            reason: 'gate: the parent must stay declared',
            source: 'gate',
          });
          assert.equal(undeclareCut.changed, true);
          const cutComponent = readJson(undeclare.indexPath).components['chain-only'];
          assert.deepEqual(cutComponent.tags, ['#cycA', '#cycC'], 'the component still declares both tags after the cut');
          assert.equal(
            JSON.stringify(cutComponent.tagPaths.map((chain) => chain.join('>')).sort()),
            JSON.stringify(['#cycA', '#cycC']),
            'and the parent tag keeps a path of its own, so the cut removed the EDGE and not the tag',
          );
          assert.deepEqual(
            undeclareCut.applied[0],
            {
              kind: 'cut',
              parent: '#cycC',
              child: '#cycA',
              removedFrom: [{ slug: 'chain-only', chain: ['#cycC > #cycA'] }],
              assertedBy: ['chain-only'],
              storedOnly: false,
            },
            'and the receipt carries exactly the removal, with no other field to explain',
          );
        } finally {
          fs.rmSync(undeclareRoot, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    // 39 -------------------------------------------------------------------
    check('39. 解环判定: two roots that are each other candidate parent are reported as EVIDENCE, not as a defect', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-mutual-'));
      try {
        const store = new MemoryLabStore(path.join(root, 'Memory Lab'));
        store.ensureLayout();
        const seed = (name, tags, tagPaths) =>
          store.update(store.prepareUpdate({ name, tags, tagPaths, content: `# ${name}\n`, reason: 'cycle fixture', source: 'gate' }));
        /* The shape the Agent met on the live store: two roots, one memory carrying both, so each
         * names the other as a candidate parent. `#gate研究` parents a tag of its own and
         * `#gate作者` parents one of its own, so nothing decides a direction between them. */
        seed('Mutual One', ['#gate作者', '#gate研究', '#gate论文'], [['#gate作者'], ['#gate吴岳良'], ['#gate研究'], ['#gate研究', '#gate论文']]);
        seed('Mutual Two', ['#gate作者', '#gate研究'], [['#gate作者'], ['#gate研究']]);

        const graph = readJson(store.indexPath);
        assert.deepEqual(graph.tags['#gate作者'].parents, [], 'both are roots, which is what makes either move arbitrary');
        assert.deepEqual(graph.tags['#gate研究'].parents, [], 'and the other one too');

        const review = store.tagReview({ kinds: ['cycle-candidate'], limit: 50 });
        const finding = review.findings.find(
          (entry) => entry.evidence.shape === 'candidate-mutual' && entry.evidence.pair.join('|') === '#gate作者|#gate研究',
        );
        assert.ok(finding, `the mutual pair is reported: ${JSON.stringify(review.counts.byKind)}`);
        assert.deepEqual(finding.evidence.pair, ['#gate作者', '#gate研究'], 'with the two tags that mirror each other');
        assert.deepEqual(finding.evidence.cycle, ['#gate作者', '#gate研究', '#gate作者'], 'and the ring the evidence forms');
        assert.equal(finding.evidence.candidates[0].namesAsParent, '#gate研究', 'one side names the other as a candidate parent');
        assert.equal(finding.evidence.candidates[1].namesAsParent, '#gate作者', 'and the relation mirrors');
        assert.deepEqual(
          finding.evidence.storedEdgesBetween,
          [false, false],
          'while the STORED graph holds no edge between them at all — this is a decision, not a defect',
        );
        /* The direction facts, read from the store and measured: `#gate研究` carries two components
         * to `#gate作者`'s two, so the component counts do NOT decide; what decides is that the
         * shared component already files tags under `#gate研究` and nothing under `#gate作者`, so
         * the level exists on one side only. Every fact travels in `basis`, and the one that
         * decided says so. */
        assert.equal(finding.evidence.direction.decisiveBy, 'structure', 'the fact that decided this direction is named');
        assert.equal(finding.evidence.direction.moreGeneral, '#gate研究', 'and it is the side that already parents other tags');
        assert.equal(finding.evidence.direction.directionDecided, true, 'so a direction IS decided here, from the store');
        assert.ok(
          finding.evidence.direction.basis.some((entry) => entry.signal === 'structure' && entry.decisive === true),
          `the deciding fact is on the record, marked decisive: ${JSON.stringify(finding.evidence.direction.basis)}`,
        );
        assert.ok(
          finding.evidence.direction.basis.some((entry) => entry.signal === 'generality' && entry.decisive === false),
          'and the raw counts travel beside it, marked as the facts they are rather than the verdict',
        );
        assert.ok(
          finding.options.some((option) => option.kind === 'reparent' && option.under === '#gate研究'),
          `the direction the evidence supports is offered: ${JSON.stringify(finding.options)}`,
        );
        assert.equal(
          finding.options[finding.options.length - 1].kind,
          'none',
          'and leaving both as roots stays an option, because a mutual candidate is not by itself a reason to move a tag',
        );

        /* A DIRECTION THAT IS DECIDED, on the same kind: one name is contained in the other, which
         * is a fact the store can read, so the finding names the more general side and offers the
         * reparent in that direction. */
        seed('Directional One', ['#gate学科', '#gate学科物理'], [['#gate学科'], ['#gate学科物理']]);
        seed('Directional Two', ['#gate学科', '#gate学科物理'], [['#gate学科'], ['#gate学科物理']]);
        const directed = store
          .tagReview({ kinds: ['cycle-candidate'], limit: 50 })
          .findings.find((entry) => entry.evidence.shape === 'candidate-mutual' && entry.evidence.pair.includes('#gate学科'));
        assert.ok(directed, 'a mutual pair whose names nest is reported too');
        assert.equal(directed.evidence.direction.moreGeneral, '#gate学科', 'and the more general name is named from the containment fact');
        assert.equal(directed.evidence.direction.decisiveBy, 'name-containment', 'with the store fact that decided it');
        assert.equal(directed.evidence.direction.directionDecided, true, 'so this one IS decided');
        assert.ok(
          directed.options.some((option) => option.kind === 'reparent' && option.tag === '#gate学科物理' && option.under === '#gate学科'),
          `and the supported direction is offered: ${JSON.stringify(directed.options)}`,
        );

        /* AND THE HONEST CASE, on this gate rather than only in the comment: a mutual pair where
         * the counts are EQUAL, neither name contains the other (or is near enough for the
         * near-duplicate rule), the fold table has no opinion, and both are leaves. Nothing decides
         * a direction, so the finding says so and offers no reparent — a finding that admits it
         * cannot choose is the whole point of 解环判定. */
        seed('Undecidable Left', ['#gate东方'], [['#gate东方']]);
        seed('Undecidable Right', ['#gate西方'], [['#gate西方']]);
        seed('Undecidable Bridge', ['#gate东方', '#gate西方'], [['#gate东方'], ['#gate西方']]);
        const undecided = store
          .tagReview({ kinds: ['cycle-candidate'], limit: 100 })
          .findings.find((entry) => entry.evidence.shape === 'candidate-mutual' && entry.evidence.pair.join('|') === '#gate东方|#gate西方');
        assert.ok(undecided, 'the equal pair is reported as mutual');
        assert.equal(undecided.evidence.direction.moreGeneral, null, 'and nothing in the store makes one of them the general tag');
        assert.equal(undecided.evidence.direction.coOccurrenceOnly, true, 'so the relation is co-occurrence and nothing else');
        assert.equal(undecided.evidence.direction.directionDecided, false, 'and the finding says the direction is NOT decided');
        assert.ok(
          undecided.evidence.direction.why.some((line) => line.includes('no fact in the store decides a direction')),
          `it admits it cannot choose: ${JSON.stringify(undecided.evidence.direction.why)}`,
        );
        assert.deepEqual(
          undecided.options.map((option) => option.kind),
          ['none'],
          'and it offers no reparent the evidence does not support — only the option to leave them alone',
        );

        /* (c) The pair test is asserted by BUILDING the pairs rather than by trusting the list: for
         * every pair this review reports as `candidate-mutual`, each side must really be among the
         * other's false-root candidates, and no pair may be reported twice. The one-way case cannot
         * be built as a fixture, and that is a fact about the rule rather than a gap in the check:
         * for two roots that share a component the relation is necessarily symmetric, because each
         * side's shared set contains the other's, so the ratio that admits one admits the other.
         * The guard is therefore unreachable while the rule stands — it is written down in
         * `mutualCandidatePairs()` as a guard against that rule changing. */
        const mutualFindings = store
          .tagReview({ kinds: ['cycle-candidate'], limit: 200 })
          .findings.filter((entry) => entry.evidence.shape === 'candidate-mutual');
        const candidateMap = new Map(
          store
            .tagReview({ kinds: ['false-root'], limit: 200 })
            .findings.map((entry) => [entry.evidence.tag, entry.evidence.candidates.map((candidate) => candidate.tag)]),
        );
        const unbacked = mutualFindings.filter((entry) => {
          const [left, right] = entry.evidence.pair;
          return !(candidateMap.get(left) || []).includes(right) || !(candidateMap.get(right) || []).includes(left);
        });
        assert.deepEqual(
          unbacked.map((entry) => entry.evidence.pair),
          [],
          `every pair reported as mutual is named by BOTH sides' false-root evidence: ${JSON.stringify(
            mutualFindings.map((entry) => entry.evidence.pair),
          )}`,
        );
        assert.ok(mutualFindings.length > 0, `and the fixture really produces mutual pairs to check: ${mutualFindings.length}`);
        assert.equal(
          new Set(mutualFindings.map((entry) => entry.evidence.pair.join('|'))).size,
          mutualFindings.length,
          'and no pair is reported twice',
        );
        for (const entry of mutualFindings) {
          assert.deepEqual(
            entry.evidence.candidates.map((side) => side.namesAsParent),
            [entry.evidence.pair[1], entry.evidence.pair[0]],
            `each reported pair names the other side in its own candidate evidence: ${JSON.stringify(entry.evidence.pair)}`,
          );
          assert.equal(entry.evidence.storedEdgesBetween.includes(true), false, 'and holds no stored edge between the two, or it would be the other shape');
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    // 40 -------------------------------------------------------------------
    check('40. 解环判定: an acyclic store produces no cycle finding at all', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-nocycle-'));
      try {
        const store = new MemoryLabStore(path.join(root, 'Memory Lab'));
        store.ensureLayout();
        store.update(
          store.prepareUpdate({ name: 'Chain', tags: ['#gate链'], tagPaths: [['#gate链'], ['#gate链', '#gate子']], content: '# chain\n', reason: 'gate', source: 'gate' }),
        );
        store.update(store.prepareUpdate({ name: 'Other', tags: ['#gate其他'], content: '# other\n', reason: 'gate', source: 'gate' }));
        const review = store.tagReview({ limit: 100 });
        assert.equal(typeof review.counts.byKind['cycle-candidate'], 'number', 'the count exists and is zero, rather than absent');
        assert.equal(review.counts.byKind['cycle-candidate'], 0, `an acyclic store produces no cycle finding: ${JSON.stringify(review.counts.byKind)}`);
        assert.equal(
          review.findings.some((finding) => finding.kind === 'cycle-candidate'),
          false,
          'and no page of it carries one',
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  } finally {
    if (coreCompatRoot) fs.rmSync(coreCompatRoot, { recursive: true, force: true });
    if (coreFixtureRoot) fs.rmSync(coreFixtureRoot, { recursive: true, force: true });
  }
} catch (error) {
  failed += 1;
  console.log('not ok - harness');
  for (const line of String((error && error.stack) || error).split('\n')) console.log(`#   ${line}`);
} finally {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (compatRoot) fs.rmSync(compatRoot, { recursive: true, force: true });
  // last line of defence: the live store must never be modified by this gate
  if (realPresent) {
    const stat = fs.statSync(realIndexPath);
    const changed =
      stat.size !== realBefore.size ||
      stat.mtimeMs !== realBefore.mtimeMs ||
      sha256(fs.readFileSync(realIndexPath)) !== sha256(realBefore.bytes);
    if (changed) {
      failed += 1;
      console.log('not ok - the live Memory Lab index.json was modified by this gate');
    }
  }
}

const total = passed + failed;
console.log(failed === 0 && total > 0 ? `PASS ${passed}/${total}` : `FAIL ${passed}/${total}`);
process.exitCode = failed === 0 && total > 0 ? 0 : 1;
