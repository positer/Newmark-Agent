/**
 * Newmark MemoryLab — the functional test of all nine tools.
 *
 * Exercises `memory_lab_read`, `memory_lab_query`, `memory_lab_update`,
 * `memory_lab_delete`, `memory_lab_reindex`, `memory_lab_tag_review`,
 * `memory_lab_tag_apply`, `memory_lab_root_tags` and `memory_lab_subtag_tree`
 * through the tools' own `execute`, so what is tested is the surface a model
 * actually calls.
 *
 * The nine tools are reached the way they are reached in the app: by mounting the
 * bundle's one Loader row, which composes MemoryLab from inside itself. There is no
 * MemoryLab row any more, so a harness that mounted one would be mounting a component
 * the shipped patch cannot produce.
 *
 * **Everything runs against a temporary root.** The shared store at `~/.Newmark` is
 * the user's live memory, and a create/delete/update test would destroy it. The test
 * snapshots that store first and aborts if a single byte changes.
 *
 * Run: node Newmark2DSH/scripts/verify-memorylab-tools.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountCore, callRoute } from './lib/mount-newmark-core.mjs';
import { createMemoryLab } from '../packages/newmark-core/components/memorylab/component.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const packagesDir = path.join(workspace, 'packages');

const LIVE_ROOT = path.join(os.homedir(), '.Newmark');
const LIVE_INDEX = path.join(LIVE_ROOT, 'Memory Lab', 'index.json');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  const n = passed + failed + 1;
  if (condition) {
    passed += 1;
    console.log(`ok ${n} - ${name}`);
    return true;
  }
  failed += 1;
  failures.push(name);
  console.log(`not ok ${n} - ${name}`);
  if (detail !== undefined) console.log(`  ${detail}`);
  return false;
}

const digest = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '(absent)');
const liveBefore = digest(LIVE_INDEX);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-tools-'));
const labDir = path.join(tempRoot, 'Memory Lab');

/* The usage instructions `memory_lab_read` hands a model, captured where a model reads them (a
 * field of that tool's answer) so the pre-exposure checks below measure the surface a caller
 * really receives rather than a second call to `store.instructions()`. */
let navigationInstructions = '';

let mount;
try {
  mount = await mountCore({
    packagesDir,
    root: tempRoot,
    // The core row's own composed config is what MemoryLab runs on here — the row that
    // used to receive `language` and `reindexOnRender` from the patch no longer exists,
    // and composing a component with a different config than the app does would test a
    // MemoryLab nobody runs.
    components: { memoryLab: true, computerUse: false },
  });

  const tool = (name) => {
    const definition = mount.tools.get(name);
    if (!definition) throw new Error(`tool ${name} is not registered`);
    return (args) => definition.execute(args);
  };
  const read = tool('memory_lab_read');
  const query = tool('memory_lab_query');
  const update = tool('memory_lab_update');
  const remove = tool('memory_lab_delete');
  const reindex = tool('memory_lab_reindex');

  /* ------------------------------------------------------------ the surface --- */

  check(
    'all nine memory_lab_* tools are registered',
    ['memory_lab_read', 'memory_lab_query', 'memory_lab_update', 'memory_lab_delete', 'memory_lab_reindex', 'memory_lab_tag_review', 'memory_lab_tag_apply', 'memory_lab_root_tags', 'memory_lab_subtag_tree'].every((name) => mount.tools.has(name)),
    [...mount.tools.keys()].join(', '),
  );
  check(
    'the composed bundle retains memory, Agent API, companion/todo and heartbeat tools when CU is off',
    // The core row composes every component, so this mount carries agent-api's four tools too
    // — `components: { computerUse: false }` switches off ComputerUse and nothing else. Asserted
    // as a partition rather than as one number: a count alone cannot tell "MemoryLab is complete"
    // from "something new arrived and MemoryLab lost a tool to make room for it".
    mount.tools.size === 32 && ['shortMemory_add','shortMemory_recall','shortMemory_where','shortMemory_size','heartbeat_restart_cancel'].every(name=>mount.tools.has(name)) &&
      mount.tools.has('newmate_task') && mount.tools.has('newmate_state') && mount.tools.has('heartbeat_after_restart') && mount.tools.has('heartbeat_restart') &&
      [...mount.tools.keys()].filter((name) => name.startsWith('memory_lab_')).length === 9 &&
      [...mount.tools.keys()].filter((name) => name.startsWith('agent_api_')).length === 4,
    `${mount.tools.size}: ${[...mount.tools.keys()].sort().join(', ')}`,
  );
  check(
    'the nine tools arrive because the core row composes MemoryLab',
    mount.rows.some((row) => row.key === 'memoryLab' && row.origin === 'composed'),
    mount.rows.map((row) => `${row.key}:${row.origin}`).join(', '),
  );

  /* ------------------------------------------------------------------ create --- */

  const empty = await read({});
  check('read on an empty store reports an index with no components', empty.ok === true && Object.keys(empty.index?.components || {}).length === 0, JSON.stringify(empty).slice(0, 200));
  check('read names the store it is using', typeof empty.indexPath === 'string' && empty.indexPath.length > 0, empty.indexPath);
  check('read ships usage instructions for the model', typeof empty.instructions === 'string' && empty.instructions.length > 40);

  const created = await update({
    name: 'Functional Probe',
    tags: ['#probe', '#functional'],
    content: '# Probe\n\nFirst body.',
    reason: 'functional test: create',
    source: 'gate-memorylab-tools',
  });
  check('update creates a component', created.ok === true, JSON.stringify(created).slice(0, 240));
  const slug = created.slug || created.component?.slug;
  check('the create reports the slug it wrote', typeof slug === 'string' && slug.length > 0, slug);
  check('the create reports a revision', Number(created.revision ?? created.component?.revision) >= 1, JSON.stringify(created.revision ?? created.component?.revision));
  check('the create reports a content hash', typeof (created.contentHash ?? created.component?.contentHash) === 'string');

  const indexPath = path.join(labDir, 'index.json');
  check('the store was created under <root>/Memory Lab', fs.existsSync(indexPath), indexPath);
  check('the component body is on disk as markdown', fs.existsSync(path.join(labDir, 'components')), 'components/');
  const indexOnDisk = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  check('the persisted index keys components by slug, like Newmark', indexOnDisk.components && !Array.isArray(indexOnDisk.components) && Object.keys(indexOnDisk.components).includes(slug));
  check('the tags were stored with their leading #', (indexOnDisk.tags && Object.keys(indexOnDisk.tags).length) >= 2, Object.keys(indexOnDisk.tags || {}).join(', '));

  /* ------------------------------------------------------------------- read --- */

  const one = await read({ component: slug });
  check('read by slug returns the component', one.ok === true, JSON.stringify(one).slice(0, 200));
  check('read by slug returns the body verbatim', typeof one.content === 'string' && one.content.includes('First body.'), JSON.stringify(one.content || '').slice(0, 120));
  const byName = await read({ name: 'Functional Probe' });
  check('read by name finds the same component', byName.ok === true && (byName.slug === slug || byName.component?.slug === slug));

  /* ------------------------------------------------------------------ query --- */

  const byTag = await query({ query: 'probe', limit: 5, max_chars: 4000 });
  check('query finds the component by tag', Array.isArray(byTag.matches) && byTag.matches.some((m) => m.slug === slug), JSON.stringify(byTag.matches?.map((m) => m.slug)));
  check('query reports how many components it considered', byTag.budget?.componentsConsidered >= 1, JSON.stringify(byTag.budget?.componentsConsidered));
  check('query reports the budget it respected', byTag.budget?.maxChars === 4000, JSON.stringify(byTag.budget?.maxChars));
  const noMatch = await query({ query: 'zzzz-nonexistent-topic-zzzz', limit: 3, max_chars: 2000 });
  check('query returns no matches for an unrelated term', Array.isArray(noMatch.matches) && noMatch.matches.length === 0);

  /* ----------------------------------------------------------------- update --- */

  /* Newmark's own implementation reads the selector from `component`
   * (memoryLab.ts:303) and defaults `name` to the existing name (321), so a patch
   * that changes only the body must work without re-sending the name. */
  const patchWithoutName = await update({ component: slug, content: 'Body replaced by a bare patch.', reason: 'functional test: patch without name' });
  check('a patch without name succeeds', patchWithoutName.ok === true, JSON.stringify(patchWithoutName).slice(0, 200));
  const afterPatch = await read({ component: slug });
  check('the patch kept the component name', afterPatch.name === 'Functional Probe' || afterPatch.component?.name === 'Functional Probe', String(afterPatch.name ?? afterPatch.component?.name));

  // Put a known body back so the append and replace checks below are unambiguous.
  await update({ component: slug, content: 'First body.\n\nSecond paragraph.', reason: 'functional test: reset body' });

  let staleError = null;
  try {
    await update({ component: slug, name: 'Functional Probe', content: 'should not land', expectedUpdatedAt: '2020-01-01T00:00:00.000Z', reason: 'stale write' });
  } catch (error) {
    staleError = error;
  }
  check('a stale expectedUpdatedAt fails closed by throwing', staleError !== null && String(staleError.code) === 'STALE_WRITE', JSON.stringify(staleError?.code ?? null));
  check(
    'the stale-write error names the slug and both timestamps',
    staleError?.details?.slug === slug && Boolean(staleError?.details?.storedUpdatedAt) && Boolean(staleError?.details?.expectedUpdatedAt),
    JSON.stringify(staleError?.details ?? null),
  );
  const afterStale = await read({ component: slug });
  check('the rejected write did not change the body', String(afterStale.content).includes('First body.') && !String(afterStale.content).includes('should not land'));

  const appended = await update({ component: slug, name: 'Functional Probe', contentAppend: '\n\nSecond paragraph.', reason: 'functional test: append' });
  check('contentAppend patches the body', appended.ok === true, JSON.stringify(appended).slice(0, 200));
  const afterAppend = await read({ component: slug });
  check('the appended text is in the body', String(afterAppend.content).includes('Second paragraph.'));
  check('the append kept the earlier text', String(afterAppend.content).includes('First body.'));

  let ambiguous = null;
  try {
    await update({ component: slug, oldText: 'Second paragraph.', newText: 'nope', reason: 'ambiguous probe' });
  } catch (error) {
    ambiguous = error;
  }
  check('an ambiguous oldText is refused rather than guessed', String(ambiguous?.code) === 'OLD_TEXT_AMBIGUOUS', JSON.stringify(ambiguous?.details ?? null));

  const swapped = await update({ component: slug, oldText: 'First body.', newText: 'First body, revised.', reason: 'functional test: oldText/newText' });
  check('oldText/newText replaces just that span', swapped.ok === true, JSON.stringify(swapped).slice(0, 200));
  const afterSwap = await read({ component: slug });
  check('the replacement landed and the rest of the body survived', String(afterSwap.content).includes('First body, revised.') && String(afterSwap.content).includes('Second paragraph.'));
  const persistedRevisions = Object.values(JSON.parse(fs.readFileSync(indexPath, 'utf8')).components).map((entry) => Number(entry.revision));
  check('the revision advanced with each write', persistedRevisions.length > 0 && persistedRevisions.every((revision) => revision >= 3), JSON.stringify(persistedRevisions));

  /* ---------------------------------------------------------------- archive --- */

  const archiveDir = path.join(labDir, 'archive');
  const archived = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir, { recursive: true }).filter((n) => String(n).endsWith('.md')) : [];
  check('every previous revision was archived as markdown', archived.length >= 2, `${archived.length} archived file(s)`);

  /* ----------------------------------------------------------- policy.jsonl --- */

  const policyPath = path.join(labDir, 'policy.jsonl');
  check('a policy log exists', fs.existsSync(policyPath), policyPath);
  const lines = fs.readFileSync(policyPath, 'utf8').split('\n').filter((line) => line.trim());
  check('the policy log has one line per mutation', lines.length >= 4, `${lines.length} lines`);
  const entries = lines.map((line) => JSON.parse(line));
  check('every policy line names its action, slug, reason and source', entries.every((e) => e.action && e.slug && e.reason && e.source), JSON.stringify(entries[0]));
  check('every policy line carries a timestamp and a content hash', entries.every((e) => e.timestamp || e.at || e.updatedAt) && entries.every((e) => e.contentHash || e.hash));
  check(
    'the policy log never contains memory content',
    !entries.some((entry) => JSON.stringify(entry).includes('First body.') || JSON.stringify(entry).includes('Second paragraph')),
  );

  /* ----------------------------------------------------------------- delete --- */

  const deleted = await remove({ component: slug, reason: 'functional test: delete', source: 'gate-memorylab-tools' });
  check('delete removes the component', deleted.ok === true, JSON.stringify(deleted).slice(0, 200));
  const afterDelete = await read({ component: slug });
  check('the deleted component is gone from the index', afterDelete.ok === false || !afterDelete.content, JSON.stringify(afterDelete).slice(0, 160));
  const indexAfterDelete = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  check('the persisted index no longer lists it', !Object.keys(indexAfterDelete.components || {}).includes(slug));
  check('the deletion was archived rather than lost', fs.readdirSync(archiveDir, { recursive: true }).length >= archived.length);

  /* ---------------------------------------------------------------- reindex --- */

  const again = await update({ name: 'Reindex Probe', tags: ['#probe'], content: 'Body for the reindex check.', reason: 'functional test: reindex fixture' });
  check('a second component can be created', again.ok === true, JSON.stringify(again).slice(0, 160));
  const before = fs.readFileSync(indexPath, 'utf8');
  const rebuilt = await reindex({});
  check('reindex succeeds', rebuilt.ok === true, JSON.stringify(rebuilt).slice(0, 200));
  const reindexed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const beforeIndex = JSON.parse(before);
  check(
    'reindex leaves tags, slugs and membership identical',
    JSON.stringify(Object.keys(reindexed.tags || {}).sort()) === JSON.stringify(Object.keys(beforeIndex.tags || {}).sort()) &&
      JSON.stringify(Object.keys(reindexed.components || {}).sort()) === JSON.stringify(Object.keys(beforeIndex.components || {}).sort()),
  );
  const second = await reindex({});
  const afterSecond = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  check(
    'reindex is graph-idempotent',
    JSON.stringify(Object.keys(afterSecond.tags || {}).sort()) === JSON.stringify(Object.keys(reindexed.tags || {}).sort()) &&
      afterSecond.relationshipVersion === reindexed.relationshipVersion,
    `${reindexed.relationshipVersion} -> ${afterSecond.relationshipVersion}`,
  );
  check('the rebuilt index carries a relationship version', typeof reindexed.relationshipVersion === 'string' && reindexed.relationshipVersion.length > 0);

  /* --------------------------------------------------------- the tag review --- */

  /* The three judgements the deterministic rebuild cannot make, each seeded as a
   * fixture a reader would recognise: a root whose memories are filed under another
   * tag, two spellings of one idea, and a name that may be a collapsed path. */
  const review = tool('memory_lab_tag_review');
  const applyTags = tool('memory_lab_tag_apply');

  await update({ name: 'Gate Tag Root', tags: ['#gate根', '#gate父'], content: 'root fixture', reason: 'functional test: tag review fixture' });
  await update({
    name: 'Gate Tag Parent',
    tags: ['#gate父', '#gate子'],
    tagPaths: [['#gate父'], ['#gate父', '#gate子']],
    content: 'parent fixture',
    reason: 'functional test: tag review fixture',
  });
  await update({ name: 'Gate Tag Synonym', tags: ['#gate同义'], content: 'synonym fixture', reason: 'functional test: tag review fixture' });
  await update({ name: 'Gate Tag Synonym Long', tags: ['#gate同义扩展'], content: 'synonym fixture', reason: 'functional test: tag review fixture' });
  await update({ name: 'Gate Tag Collapsed', tags: ['#gate根延伸'], content: 'collapsed fixture', reason: 'functional test: tag review fixture' });

  /* THE SWITCH IS THROWN BEFORE THE REVIEW, because the review is the thing whose two states are
   * being told apart. This is a correction rather than a rewording: the core row composes
   * agent-api here — the same composition the app builds — so before this block the judge really
   * was reachable, and the "no judge" checks below passed anyway. The harness's tools registry
   * answered `register` and had no `get`, which is the one method `agentApiPresence` asks, so
   * EVERY mount reported "no agent_api_send is registered" and the two states could not be told
   * apart. With `get` answered as the real registry answers it, the off-state has to be produced
   * the way the app produces it: by switching the component off, which disposes its fiber and
   * retires its tools. It is switched back on before the checks that need a judge. */
  const engineOff = await mount.switch('agentApi', false);
  check(
    'switching agent-api off really retires its tools, so the judge is unreachable rather than unread',
    engineOff.ok === true && engineOff.landed === true && !mount.tools.has('agent_api_send') && mount.composed.includes('memoryLab'),
    JSON.stringify({ ...engineOff, tools: [...mount.tools.keys()].length }),
  );

  const beforeReview = fs.readFileSync(indexPath, 'utf8');
  const reviewResult = await review({});
  const afterReview = fs.readFileSync(indexPath, 'utf8');
  check('memory_lab_tag_review reports findings', reviewResult.ok === true && Array.isArray(reviewResult.findings) && reviewResult.findings.length > 0, JSON.stringify(reviewResult).slice(0, 200));
  check(
    'the review reports the three judgement classes and names each finding kind it found',
    ['false-root', 'synonym-candidate', 'single-tag-path'].every((kind) => reviewResult.counts?.byKind?.[kind] > 0),
    JSON.stringify(reviewResult.counts),
  );
  check(
    'a review is read-only: the persisted index is byte-identical afterwards',
    beforeReview === afterReview,
    'the review rewrote the index',
  );
  check(
    'every finding carries the question, the evidence and the decision shape that answers it',
    reviewResult.findings.every(
      (finding) =>
        typeof finding.id === 'string' &&
        typeof finding.question === 'string' &&
        finding.evidence &&
        Array.isArray(finding.options) &&
        finding.options.length > 0,
    ),
    JSON.stringify(reviewResult.findings[0] || null).slice(0, 200),
  );
  const rootFinding = reviewResult.findings.find((finding) => finding.kind === 'false-root' && finding.evidence.tag === '#gate根');
  check(
    'the false-root finding names the candidate parent and why it is one',
    Boolean(rootFinding) && rootFinding.evidence.candidates.some((candidate) => candidate.tag === '#gate父') && rootFinding.evidence.why.length > 0,
    JSON.stringify(rootFinding || null).slice(0, 240),
  );
  const synonymFinding = reviewResult.findings.find((finding) => finding.kind === 'synonym-candidate');
  check(
    'the synonym finding names the stable canonical spelling a later rebuild would keep',
    Boolean(synonymFinding) && typeof synonymFinding.evidence.stableInto === 'string' && synonymFinding.evidence.stableInto.length > 1,
    JSON.stringify(synonymFinding?.evidence?.stableInto ?? null),
  );
  check(
    'the review is paged and says how many findings it left out',
    typeof reviewResult.window?.total === 'number' && reviewResult.window.returned === reviewResult.findings.length,
    JSON.stringify(reviewResult.window),
  );
  const filtered = await review({ kinds: ['single-tag-path'], limit: 1 });
  check(
    'a review can be narrowed to one kind and one page',
    filtered.findings.length <= 1 && filtered.findings.every((finding) => finding.kind === 'single-tag-path'),
    JSON.stringify(filtered.counts),
  );

  /* ------------------------------------------------- the judgement interface --- */

  /* MemoryLab owns the store, not a judge: the three judgements are UNAVAILABLE whenever
   * `agent_api_send` is not registered, and that is a different answer from "the judgement ran
   * and failed". The switch above is what makes that state real rather than assumed, and the
   * review taken just now is the one read with no run reachable. */
  check(
    'without the agent interface, a review still reports evidence and says no judge is reachable',
    reviewResult.ok === true && reviewResult.findings.length > 0 && reviewResult.judge?.status === 'unavailable' && reviewResult.judge?.judged === false,
    JSON.stringify(reviewResult.judge ?? null).slice(0, 240),
  );
  check(
    'the unavailable envelope names the interface and why, and emits no request',
    reviewResult.judge?.interface === 'agent-api' &&
      String(reviewResult.judge?.reason || '').includes('agent-api') &&
      reviewResult.request === null,
    JSON.stringify({ interface: reviewResult.judge?.interface, reason: reviewResult.judge?.reason, request: reviewResult.request }).slice(0, 240),
  );

  const beforeRefusal = fs.readFileSync(indexPath, 'utf8');
  let refusal = null;
  try {
    await applyTags({ decisions: [{ kind: 'reparent', tag: '#gate根', under: '#gate父' }], reason: 'refusal fixture' });
  } catch (error) {
    refusal = error;
  }
  check(
    'a judgement with the interface off is REFUSED, names the switch, and writes nothing',
    String(refusal?.code) === 'AGENT_UNAVAILABLE' &&
      String(refusal?.details?.interface) === 'agent-api' &&
      String(refusal?.message || '').includes('agent-api') &&
      fs.readFileSync(indexPath, 'utf8') === beforeRefusal,
    `${String(refusal?.code)} / index rewritten: ${fs.readFileSync(indexPath, 'utf8') !== beforeRefusal}`,
  );
  /* A CUT IS A JUDGEMENT TOO, and this is where that is measured rather than assumed. 解环判定
   * exists so that breaking a cycle is a decision, not something that happens on its own — so with
   * the judge switched off, a `cut` must be refused exactly like a reparent, and it must not be
   * quietly applied. The decision deliberately names tags this store does not have: the refusal
   * has to come from the GATE, before the store is touched, or the check could pass because the
   * store refused the tags instead. */
  const beforeCutRefusal = fs.readFileSync(indexPath, 'utf8');
  let cutRefusal = null;
  try {
    await applyTags({ decisions: [{ kind: 'cut', parent: '#no-such-parent', child: '#no-such-child' }], reason: 'cut refusal fixture' });
  } catch (error) {
    cutRefusal = error;
  }
  check(
    'a cut is refused with the interface off, exactly like the other judgements: breaking a cycle is a judgement',
    String(cutRefusal?.code) === 'AGENT_UNAVAILABLE' &&
      JSON.stringify(cutRefusal?.details?.judgementKinds) === JSON.stringify(['cut']) &&
      cutRefusal?.details?.knownJudgementKinds?.includes('cut') === true &&
      fs.readFileSync(indexPath, 'utf8') === beforeCutRefusal,
    `${String(cutRefusal?.code)} / kinds ${JSON.stringify(cutRefusal?.details?.judgementKinds)} / index rewritten: ${fs.readFileSync(indexPath, 'utf8') !== beforeCutRefusal}`,
  );

  const reversal = await applyTags({
    decisions: [{ kind: 'set-tags', slug: 'gate-tag-root', tags: ['#gate根', '#gate父'], tagPaths: [['#gate根'], ['#gate父']] }],
    reason: 'reversal fixture: switching agent-api off must not strand a recorded decision',
  });
  check(
    'a reversal still applies with the interface off, so a recorded decision is never stranded',
    reversal.ok === true && reversal.judge?.judged === false,
    JSON.stringify(reversal).slice(0, 200),
  );

  /* The deterministic entry point is unchanged: no arguments, and it still rebuilds. It is
   * asserted with the judge OFF here, which is the state this block is in; the same tool is
   * asserted again with the judge ON below, because "a deterministic rebuild never claims a
   * judgement" has to hold in both. */
  const stillDeterministic = await reindex({});
  check(
    'memory_lab_reindex still takes no arguments, still rebuilds, and never claims a judgement',
    stillDeterministic.ok === true &&
      typeof stillDeterministic.relationshipVersion === 'string' &&
      stillDeterministic.judge?.judged === false &&
      stillDeterministic.judge?.status === 'unavailable',
    JSON.stringify(stillDeterministic.judge ?? null).slice(0, 200),
  );

  /* The judge comes back the way it left: through the switch, which re-composes the component
   * and re-registers its tools. Everything that needs a reachable judge from here on runs in
   * this state — and the switch-off above is what makes this a state rather than a default. */
  const engineOn = await mount.switch('agentApi', true);
  check(
    'switching agent-api back on re-registers agent_api_send, so the same mount serves both states',
    engineOn.ok === true && engineOn.landed === true && mount.tools.has('agent_api_send'),
    JSON.stringify({ ...engineOn, active: mount.tools.has('agent_api_send') }),
  );
  const reviewWithJudge = await review({});
  check(
    'the same review now says the judge is reachable, and carries the prompt a run is handed',
    reviewWithJudge.judge?.status === 'available' && typeof reviewWithJudge.prompt?.text === 'string' && reviewWithJudge.prompt.text.length > 200,
    JSON.stringify({ judge: reviewWithJudge.judge?.status, prompt: reviewWithJudge.prompt?.status, chars: reviewWithJudge.prompt?.text?.length }),
  );

  /* With the interface reachable the same decision is allowed, and the receipt says the
   * decisions were judged and applied.
   *
   * READ THIS FIXTURE CAREFULLY, because it changed meaning with the constraint. A judgement is
   * now reached through the TOOLS REGISTRY and nothing else — `agent-api` is invoked only by tools
   * — so "the interface is present" is no longer "a service was handed in": it is
   * "`agent_api_send` is registered". The mock below therefore registers that name, which is
   * exactly what the real component does, and the probe reads it the same way it reads the real
   * registry. The old shape passed a fake `{ active, isActive, root }` service through a config
   * field; that service no longer exists and a fixture still supplying it would be testing a
   * component nobody ships. */
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-agent-'));
  const served = [];
  /** A registry that answers `get(name)` the way `ctx.tools` does, and registers what apply() gives it. */
  const servedRegistry = {
    register(definition) {
      served.push(definition);
      return () => {};
    },
    get(name) {
      return served.find((definition) => definition.name === name);
    },
  };
  const standaloneModule = path.join(packagesDir, 'newmark-core', 'components', 'memorylab', 'index.js');
  const standalone = await import(new URL('file:///' + standaloneModule.replace(/\\/g, '/')).href);
  // The name the probe looks for, registered BEFORE apply so the component sees a mounted judge —
  // the same order the real composition produces, where agent-api's tools are registered by its
  // own apply and MemoryLab reads the registry afterwards.
  servedRegistry.register({ name: 'agent_api_send', description: 'fixture: the judgement entry point', parameters: { type: 'object' } });
  standalone.apply(
    {
      logger: { info() {}, warn() {}, error() {} },
      tools: servedRegistry,
      webServer: { tapIndex: () => () => {}, register: () => () => {} },
      effect(callback) { const disposer = callback(); return typeof disposer === 'function' ? disposer : () => {}; },
      get() { return undefined; },
    },
    { root: agentRoot },
  );
  const servedTool = (name) => served.find((definition) => definition.name === name);
  await servedTool('memory_lab_update').execute({
    name: 'Judged Merge A',
    tags: ['#判定基准'],
    content: '# a\n',
    reason: 'judgement fixture',
  });
  await servedTool('memory_lab_update').execute({ name: 'Judged Merge B', tags: ['#判定基准扩展'], content: '# b\n', reason: 'judgement fixture' });
  const servedReview = await servedTool('memory_lab_tag_review').execute({});
  const servedApply = servedTool('memory_lab_tag_apply');
  check(
    'with the interface present, the review carries the request a judge is handed',
    servedReview.judge?.status === 'available' &&
      servedReview.request?.interface === 'agent-api' &&
      servedReview.request?.workspace === path.join(agentRoot, 'Work') &&
      servedReview.request?.answer?.applyWith === 'memory_lab_tag_apply' &&
      servedReview.request?.questions?.length === 4,
    JSON.stringify(servedReview.request ?? null).slice(0, 300),
  );
  check(
    'the request names all four judgements the user asked for, 解环判定 among them',
    ['false-root', 'synonym-merge', 'misparsed-tag', 'cycle-break'].every((id) => (servedReview.request?.questions || []).some((question) => question.id === id)),
    JSON.stringify((servedReview.request?.questions || []).map((question) => question.id)),
  );
  check(
    'the fourth question is 解环判定, and it says which evidence kind carries it',
    (() => {
      const question = (servedReview.request?.questions || []).find((entry) => entry.id === 'cycle-break');
      return Boolean(question) && String(question.ask || '').includes('解环判定') && JSON.stringify(question.evidence) === JSON.stringify(['cycle-candidate']);
    })(),
    JSON.stringify((servedReview.request?.questions || []).find((entry) => entry.id === 'cycle-break') ?? null).slice(0, 240),
  );
  check(
    'the decision vocabulary a judgement may use includes cut, which is what breaks a cycle',
    servedReview.request?.answer?.decisionKinds?.includes('cut') === true,
    JSON.stringify(servedReview.request?.answer?.decisionKinds ?? null),
  );
  const judged = await servedApply.execute({
    decisions: [{ kind: 'merge', tags: ['#判定基准扩展'], into: '#判定基准' }],
    reason: 'judgement fixture: fold two spellings',
    expectedRelationshipVersion: servedReview.relationshipVersion,
  });
  check(
    'with the interface present, a judgement applies and the receipt says it was judged',
    judged.ok === true && judged.changed === true && judged.judge?.status === 'available' && judged.judge?.judged === true && judged.judge?.applied >= 1,
    JSON.stringify(judged.judge ?? null).slice(0, 240),
  );
  const deterministicWithJudge = await servedTool('memory_lab_reindex').execute({});
  check(
    'a deterministic rebuild never claims a judgement, with or without a judge',
    deterministicWithJudge.judge?.judged === false && stillDeterministic.judge?.judged === false,
    JSON.stringify({ withJudge: deterministicWithJudge.judge?.status, withoutJudge: stillDeterministic.judge?.status }),
  );

  /* ------------------------------------------------------------ the prompt --- */

  /* The user's report was that 重建索引 finished instantly and the Agent was never in it. The
   * answer is not a prompt placed beside the button: pressing the button RUNS the judgement, on
   * the Host half, by dispatching the `agent_api_send` tool. The ask is still the thing these
   * checks are about — the three questions in the user's own words, the two-call sequence, the
   * relationship guard, and the prohibitions — every one of them a word in the text, because a
   * prompt is read by a model and not merely carried by a function signature. */
  const promptText = String(reviewWithJudge.prompt?.text || '');
  check(
    'the prompt asks the four judgements in the user’s own words, with the finding kinds as where-to-look',
    ['同义近义 tag 合并', '假根父节点接续', '未被正确解析的 tag 误读为单 tag', '解环判定'].every((name) => promptText.includes(name)) &&
      ['false-root', 'synonym-candidate', 'single-tag-path', 'cycle-candidate'].every((kind) => promptText.includes(kind)) &&
      promptText.includes('你要判定的是下面四类问题'),
    promptText.slice(0, 300),
  );
  check(
    'the prompt tells a run how to break a cycle, and that cut is the decision that does it',
    /* The 解环判定 constraint is the one thing a run cannot infer: `reparent` LOOKS like the
     * obvious repair for a cycle and is the one that cannot work (the store refuses moving a node
     * of a cycle under another node of it, and moving it outside leaves the cycle intact), so the
     * prompt has to say so and name `cut`, `edges`, `suggestedCut` and the two shapes.
     *
     * The sentences below are quoted from the prompt VERBATIM, and deliberately from the
     * CONSTRAINT rather than from step 2 — step 2 already names `cut` in the decision vocabulary,
     * so a check that only looked for the word would pass on a prompt that never says how to use
     * it. What is asserted is the instruction a run cannot infer: that breaking a stored cycle is
     * a `cut` because a cut NAMES the edge while a reparent only makes the ring disappear, and
     * that an undecided direction means applying nothing. */
    promptText.includes('用 cut 剪断环上的一条边') &&
      promptText.includes('回执里不会说是哪一条边没了') &&
      promptText.includes('shape = "stored-cycle"') &&
      promptText.includes('shape = "candidate-mutual"') &&
      promptText.includes('directionDecided') &&
      promptText.includes('把没有证据的方向说成结论，比不判定更糟'),
    promptText.slice(promptText.indexOf('解环判定：'), promptText.indexOf('解环判定：') + 400),
  );
  check(
    'the prompt states the two-call sequence: read the evidence, decide, then apply',
    promptText.includes('memory_lab_tag_review') &&
      promptText.includes('memory_lab_tag_apply') &&
      promptText.indexOf('memory_lab_tag_review') < promptText.indexOf('memory_lab_tag_apply') &&
      promptText.includes('不要跳步'),
  );
  check(
    'the prompt carries the guard: the relationship version it must be applied against',
    promptText.includes(`expectedRelationshipVersion = ${reviewWithJudge.relationshipVersion}`) &&
      promptText.includes(String(reviewWithJudge.relationshipVersion).slice(0, 16)),
    String(reviewWithJudge.relationshipVersion),
  );
  check(
    'the prompt says every apply archives the index and returns an undo',
    promptText.includes('归档') && promptText.includes('undo'),
  );
  check(
    'the prompt forbids the three things that must never happen to a real memory store',
    promptText.includes('不要发明任何新的 tag 名') &&
      promptText.includes('不要改写任何组件的正文') &&
      promptText.includes('证据没有点名的，不要合并') &&
      promptText.includes('不要直接改索引文件'),
  );
  check(
    'the prompt carries no local path, because a prompt is copied and pasted elsewhere',
    !promptText.includes(agentRoot) && !promptText.includes('index.json') && !promptText.includes('工作目录'),
    promptText.slice(-160),
  );
  /* ============================================ 重建索引 runs the judgement === */

  /* WHAT CHANGED, AND WHY THESE CHECKS LOOK DIFFERENT.
   *
   * Two checks used to live here: "the prompt the panel offers is the same prompt the tool hands a
   * run, character for character" and "a review with nothing to report produces a notice and not a
   * task, on both surfaces". Both were about a PROMPT CARRIED TO THE PAGE, where a person could
   * copy it — and the user has since removed that surface ("不是写一段提示词放那，给我去掉") and
   * replaced it with the real thing: the button runs the judgement itself.
   *
   * The property underneath each of them is not retired, so neither is the check. It is rewritten
   * against the surface that replaced them:
   *
   *   - "one wording, one source" is now THE ROUTE DISPATCHES THE SAME TEXT the review tool hands a
   *     run — asserted against what was really dispatched, not against what a snapshot carried;
   *   - "nothing to judge is a notice, not a task" is now asserted on BOTH surfaces that still
   *     have a judgement half: the review tool, and the route that would otherwise dispatch a run.
   */
  const routeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-route-judge-'));
  const routeMount = await mountCore({ packagesDir, root: routeRoot, components: { computerUse: false } });
  const routeTool = (name) => {
    const definition = routeMount.tools.get(name);
    if (!definition) throw new Error(`tool ${name} is not registered on the route mount`);
    return definition;
  };
  await routeTool('memory_lab_update').execute({ name: 'Route Probe A', tags: ['#路由探针'], content: '# a\n', reason: 'route fixture' });
  await routeTool('memory_lab_update').execute({ name: 'Route Probe B', tags: ['#路由探针扩展'], content: '# b\n', reason: 'route fixture' });
  const route = routeMount.routes.find((entry) => entry.path === '/newmark-memorylab/snapshot');
  check('the rebuild route is registered on the mount, so the checks below drive the real handler', typeof route?.handler === 'function', JSON.stringify(routeMount.routes.map((entry) => entry.path)));
  const REBUILD_URL = '/newmark-memorylab/snapshot?reindex=1';

  /* A PLAIN READ RUNS NOTHING. 重置 asks for the same route with no `reindex`, and it must not be
   * able to start a run — by the query string, by a header, or by anything else the caller sends. */
  const dispatchesBeforeRead = routeMount.dispatches.length;
  const readAnswer = await callRoute(route, 'GET');
  check(
    'a plain read of the snapshot route dispatches nothing: 重置 cannot start a run',
    readAnswer.status === 200 &&
      readAnswer.json.rebuild === false &&
      readAnswer.json.judgement === null &&
      routeMount.dispatches.length === dispatchesBeforeRead,
    JSON.stringify({ status: readAnswer.status, rebuild: readAnswer.json?.rebuild, judgement: readAnswer.json?.judgement, dispatches: routeMount.dispatches.length - dispatchesBeforeRead }),
  );

  /* THE ROUTE'S LAST-RESORT HANDLER, driven rather than described.
   *
   * A route handler runs with no caller above it, so a throw inside it does not become a failed
   * request — it ends the Host process. The handler is therefore written so its worst case is a
   * 500, and this is the only reachable way to make it take that path: `new URL('http://[', …)`
   * throws, and the throw happens inside the guarded body. What is asserted is both halves of the
   * instruction — the caller still gets its 500, AND the failure is persisted and printed. */
  const routeSnapshotsBefore = fs.existsSync(path.join(routeRoot, 'errors.jsonl'))
    ? fs.readFileSync(path.join(routeRoot, 'errors.jsonl'), 'utf8').split('\n').filter(Boolean).length
    : 0;
  const malformed = await callRoute(route, 'GET', undefined, 'http://[');
  const routeSnapshots = fs.existsSync(path.join(routeRoot, 'errors.jsonl'))
    ? fs.readFileSync(path.join(routeRoot, 'errors.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  check(
    'a route that throws answers 500 AND is recorded as memorylab/snapshot: the handler has no caller to report to',
    malformed.status === 500 &&
      malformed.json?.error === 'snapshot_failed' &&
      routeSnapshots.length === routeSnapshotsBefore + 1 &&
      routeSnapshots[routeSnapshots.length - 1]?.where === 'memorylab/snapshot' &&
      routeSnapshots[routeSnapshots.length - 1]?.code === 'snapshot_failed',
    JSON.stringify({ status: malformed.status, added: routeSnapshots.length - routeSnapshotsBefore, line: routeSnapshots[routeSnapshots.length - 1] ?? null }),
  );

  /* Press once to settle the graph (the rebuild is graph-idempotent), so the ask the NEXT press
   * dispatches can be compared against a review taken in between: if the two differ, it is the
   * route's doing and not a moving graph. */
  await callRoute(route, 'GET', undefined, REBUILD_URL);
  const routeReview = await routeTool('memory_lab_tag_review').execute({});
  const dispatchesBeforePress = routeMount.dispatches.length;
  const pressed = await callRoute(route, 'GET', undefined, REBUILD_URL);
  const dispatched = routeMount.dispatches.slice(dispatchesBeforePress);
  check(
    'pressing 重建索引 dispatches the judgement through the agent_api_send TOOL, exactly once',
    dispatched.length === 1 &&
      dispatched[0].name === 'agent_api_send' &&
      typeof dispatched[0].callId === 'string' &&
      dispatched[0].callId.length > 0 &&
      dispatched[0].signal instanceof AbortSignal &&
      pressed.json.judgement?.attempted === true,
    JSON.stringify({ dispatched: dispatched.map((exec) => exec.name), judgement: pressed.json?.judgement?.status, attempted: pressed.json?.judgement?.attempted }),
  );
  check(
    'and the ask it dispatches is the SAME text memory_lab_tag_review hands a run, character for character',
    typeof routeReview.prompt?.text === 'string' &&
      routeReview.prompt.text.length > 200 &&
      dispatched[0]?.arguments?.prompt === routeReview.prompt.text,
    JSON.stringify({ tool: routeReview.prompt?.text?.length, dispatched: dispatched[0]?.arguments?.prompt?.length }),
  );
  check(
    'the dispatch carries the ask, the workspace and the bound — and nothing else, so the run is never widened',
    JSON.stringify(Object.keys(dispatched[0]?.arguments ?? {}).sort()) === JSON.stringify(['prompt', 'timeout_ms', 'workspace']) &&
      dispatched[0].arguments.workspace === path.join(routeRoot, 'Work') &&
      !('tools' in dispatched[0].arguments) &&
      !('tool_filter' in dispatched[0].arguments) &&
      !('max_steps' in dispatched[0].arguments),
    JSON.stringify({ keys: Object.keys(dispatched[0]?.arguments ?? {}), workspace: dispatched[0]?.arguments?.workspace }),
  );
  check(
    'the two halves are reported separately, and the judgement carries the graph the rebuild produced',
    typeof pressed.json.result?.relationshipVersion === 'string' &&
      pressed.json.result.relationshipVersion.length > 0 &&
      pressed.json.judgement?.relationshipVersion === pressed.json.result.relationshipVersion &&
      pressed.json.reindexError === '',
    JSON.stringify({ rebuild: pressed.json.result?.relationshipVersion?.slice(0, 12), judgement: pressed.json.judgement?.relationshipVersion?.slice(0, 12), reindexError: pressed.json.reindexError }),
  );
  check(
    'with no model authorised the judgement says so in the user’s language, and the deterministic half still stands',
    // This mount carries the REAL agent-api and no llm/model selection, so the run is refused at
    // exit 3 `model_not_selected` — a real refusal through the real tool, which is exactly the
    // state a fresh profile is in. The rebuild beside it succeeded and is reported on its own.
    pressed.json.judgement?.status === 'unavailable' &&
      pressed.json.judgement?.exit === 3 &&
      pressed.json.judgement?.attempted === true &&
      String(pressed.json.judgement?.label || '').includes('还没有选定模型') &&
      pressed.json.result?.components >= 2,
    JSON.stringify({ judgement: pressed.json.judgement?.status, exit: pressed.json.judgement?.exit, code: pressed.json.judgement?.code, label: pressed.json.judgement?.label }),
  );

  /* NOTHING CALLER-SUPPLIED REACHES THE ASK. The route takes its two arguments from its own locals;
   * a query string that tries to name a prompt, a question or a judgement must change nothing. */
  const dispatchesBeforeInjection = routeMount.dispatches.length;
  const injected = await callRoute(route, 'GET', undefined, `${REBUILD_URL}&prompt=EVIL-CALLER-PROMPT&judgement=EVIL&q=EVIL&tools=EVIL`);
  const injectedDispatch = routeMount.dispatches[dispatchesBeforeInjection];
  check(
    'no caller-supplied text can reach the run: the query string cannot steer the ask',
    routeMount.dispatches.length === dispatchesBeforeInjection + 1 &&
      injectedDispatch?.arguments?.prompt === routeReview.prompt.text &&
      !JSON.stringify(injectedDispatch?.arguments ?? {}).includes('EVIL'),
    JSON.stringify({ prompt: String(injectedDispatch?.arguments?.prompt || '').slice(0, 60), judgement: injected.json.judgement?.status }),
  );

  /* THE JUDGE SWITCHED OFF. Everything above depends on `agent_api_send` being registered; with the
   * component switched off there is nothing to ask, and the route must say so rather than dispatch
   * into a name that is gone — or, worse, report an empty judgement. */
  const offSwitch = await routeMount.switch('agentApi', false);
  const dispatchesBeforeOff = routeMount.dispatches.length;
  const offAnswer = await callRoute(route, 'GET', undefined, REBUILD_URL);
  check(
    'with agent-api switched off the rebuild still runs and NO run is asked for',
    offSwitch.landed === true &&
      routeMount.dispatches.length === dispatchesBeforeOff &&
      offAnswer.json.judgement?.status === 'unavailable' &&
      offAnswer.json.judgement?.attempted === false &&
      typeof offAnswer.json.result?.relationshipVersion === 'string' &&
      offAnswer.json.result.relationshipVersion.length > 0,
    JSON.stringify({ switched: offSwitch.landed, dispatches: routeMount.dispatches.length - dispatchesBeforeOff, judgement: offAnswer.json.judgement?.status, attempt: offAnswer.json.judgement?.attempted }),
  );
  check(
    'and it says which half did not happen and why, in one clause the panel prints',
    String(offAnswer.json.judgement?.label || '').includes('未运行') &&
      String(offAnswer.json.judgement?.label || '').includes('agent-api 已停用') &&
      String(offAnswer.json.judgement?.label || '').includes('确定性重建不受影响'),
    String(offAnswer.json.judgement?.label || ''),
  );
  await routeMount.dispose();
  fs.rmSync(routeRoot, { recursive: true, force: true });

  /* And the state that must NEVER produce a run. An empty store is used because it has no findings
   * by construction: a review with nothing to report is a real answer, and the only honest
   * judgement for it is a notice. A run that was asked over an empty review would be asked to
   * invent repairs in a store holding real memory — which is the failure this branch prevents. */
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-prompt-none-'));
  const emptyMount = await mountCore({ packagesDir, root: emptyRoot, components: { computerUse: false } });
  const emptyReview = await emptyMount.tools.get('memory_lab_tag_review').execute({});
  const emptyRoute = emptyMount.routes.find((entry) => entry.path === '/newmark-memorylab/snapshot');
  const emptyAnswer = await callRoute(emptyRoute, 'GET', undefined, REBUILD_URL);
  check(
    'a review with nothing to report produces a notice and not a task, on both surfaces that can ask',
    emptyReview.counts?.findings === 0 &&
      emptyReview.prompt?.status === 'none' &&
      emptyReview.prompt?.text === '' &&
      emptyMount.dispatches.length === 0 &&
      emptyAnswer.json.judgement?.status === 'none' &&
      emptyAnswer.json.judgement?.attempted === false &&
      String(emptyAnswer.json.judgement?.label || '').includes('没有需要判定的事项'),
    JSON.stringify({ findings: emptyReview.counts?.findings, tool: emptyReview.prompt?.status, dispatches: emptyMount.dispatches.length, judgement: emptyAnswer.json.judgement?.status }),
  );
  check(
    'and the notice says it is the stable state after a rebuild, not a skipped or failed judgement — and the rebuild is reported anyway',
    String(emptyReview.prompt?.notice || '').includes('这不是跳过') &&
      String(emptyAnswer.json.judgement?.label || '').includes('这不是跳过') &&
      emptyAnswer.json.rebuild === true &&
      typeof emptyAnswer.json.result?.relationshipVersion === 'string',
    JSON.stringify({ label: emptyAnswer.json.judgement?.label, rebuild: emptyAnswer.json.rebuild, result: emptyAnswer.json.result?.relationshipVersion?.slice(0, 12) }),
  );
  await emptyMount.dispose();
  fs.rmSync(emptyRoot, { recursive: true, force: true });

  /* ========================================== the judgement half, classified === */

  /* Every status below is a state the app really reaches, and each must be reported as ITSELF: a
   * timeout is not a judgement, a missing model is not a skip, and a rebuild that threw does not
   * turn into an empty judgement. The registry here is a fixture that answers what each check
   * needs, so what is under test is MemoryLab's own classification and the order it runs in. */
  const judgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-judge-'));
  const judgeRegistry = { get: () => ({ name: 'agent_api_send' }), execute: null };
  const judgeLab = createMemoryLab({ root: judgeRoot, tools: judgeRegistry });
  judgeLab.store.update({ name: 'Judge A', tags: ['#判定探针'], content: '# a\n' });
  judgeLab.store.update({ name: 'Judge B', tags: ['#判定探针扩展'], content: '# b\n' });
  const judgeIndexPath = path.join(judgeRoot, 'Memory Lab', 'index.json');
  const judgeReview = await judgeLab.store.tagReview({ limit: 25 });
  const judgeAskText = judgeLab.judgementAsk().text;
  const dispatchedTo = [];
  const answerWith = (envelope) => {
    judgeRegistry.execute = async (exec) => {
      dispatchedTo.push(exec);
      return { content: [{ type: 'text', text: 'ok' }], isError: false, value: envelope };
    };
  };

  /* THE ORDER: a judgement is built from the graph the DETERMINISTIC rebuild produced, never from
   * whatever the index happened to hold. Asserted from the ask itself — the relationship version it
   * carries is the one `rebuild()` returns — and from the fact that `judge()` does not rebuild on
   * its own (the recorded version is the same before and after the judgement). */
  const beforeRebuild = judgeLab.snapshot().relationshipVersion;
  const rebuiltVersion = judgeLab.rebuild().relationshipVersion;
  const indexAfterRebuild = fs.readFileSync(judgeIndexPath, 'utf8');
  answerWith({ ok: true, tool: 'agent_api_send', route: 'loop', exit: 0, class: 'ok', result: { turns: 2, tool_calls: 3, stop_reason: 'stop' } });
  const answered = await judgeLab.judge({ timeoutMs: 4000 });
  check(
    'the ask is built from the graph the deterministic rebuild produced, after it ran',
    answered.status === 'judged' &&
      answered.relationshipVersion === rebuiltVersion &&
      typeof beforeRebuild === 'string' &&
      answered.relationshipVersion.length > 0,
    JSON.stringify({ before: beforeRebuild?.slice(0, 12), rebuilt: rebuiltVersion?.slice(0, 12), asked: answered.relationshipVersion?.slice(0, 12) }),
  );
  check(
    'a run that answers is the ONLY status that is a verdict, and it reports what the run did',
    answered.attempted === true &&
      answered.exit === 0 &&
      answered.turns === 2 &&
      answered.toolCalls === 3 &&
      answered.stopReason === 'stop' &&
      String(answered.label).startsWith('已运行：2 轮模型、3 次工具调用'),
    JSON.stringify({ status: answered.status, exit: answered.exit, turns: answered.turns, toolCalls: answered.toolCalls, label: answered.label }),
  );
  check(
    'the judgement itself rebuilds nothing: the index it read is the index the rebuild left',
    fs.readFileSync(judgeIndexPath, 'utf8') === indexAfterRebuild,
    'a judgement that rewrote the index would be doing the other half’s work',
  );

  /* exit 3 — NOTHING WAS ATTEMPTED, and the four codes that mean it are named in the user's
   * language, because a code is not an answer for the person who pressed the button. */
  answerWith({ ok: false, tool: 'agent_api_send', route: 'none', exit: 3, class: 'unavailable', code: 'model_not_selected', error: 'nothing is authorised yet' });
  const noModel = await judgeLab.judge({ timeoutMs: 4000 });
  answerWith({ ok: false, tool: 'agent_api_send', route: 'none', exit: 3, class: 'unavailable', code: 'llm_unavailable', error: 'the llm service is not reachable' });
  const noLlm = await judgeLab.judge({ timeoutMs: 4000 });
  check(
    'an exit-3 answer is "no judgement was made", named in the user’s language and never a verdict',
    noModel.status === 'unavailable' &&
      noModel.attempted === true &&
      noModel.label.includes('还没有选定模型') &&
      noLlm.label.includes('模型服务不可达') &&
      !noModel.label.includes('nothing is authorised yet'),
    JSON.stringify({ model: noModel.label, llm: noLlm.label }),
  );

  /* exit 4 — a run happened and did not deliver. Its own code and message travel through. */
  answerWith({ ok: false, tool: 'agent_api_send', route: 'loop', exit: 4, class: 'failed', code: 'run_failed', error: 'provider exploded' });
  const failed = await judgeLab.judge({ timeoutMs: 4000 });
  check(
    'a failed run is reported as failed, with the run’s own code and message, and is not a judgement',
    failed.status === 'failed' && failed.attempted === true && failed.exit === 4 && failed.code === 'run_failed' && failed.label.includes('provider exploded') && failed.label.startsWith('未完成：'),
    JSON.stringify({ status: failed.status, label: failed.label }),
  );

  /* A DISPATCH THAT NEVER REACHES THE TOOL — a name that is gone, a guard's denial — is its own
   * answer rather than an empty judgement. */
  judgeRegistry.execute = async () => ({ content: [{ type: 'text', text: 'Error: unknown tool' }], isError: true, error: { message: 'unknown tool "agent_api_send"', info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } } });
  const unreached = await judgeLab.judge({ timeoutMs: 4000 });
  check(
    'a dispatch that never reached the tool is a failure with the registry’s own code, not an empty judgement',
    unreached.status === 'failed' && unreached.attempted === true && unreached.code === 'UNKNOWN_TOOL' && unreached.label.includes('unknown tool'),
    JSON.stringify({ status: unreached.status, code: unreached.code, label: unreached.label }),
  );

  /* THE TIMEOUT. A run takes time — that was the whole complaint — and the request must not hang on
   * one. The dispatch below refuses to settle for far longer than the bound, which is the worst
   * case a bound has to survive.
   *
   * It gives up after 4 s ON PURPOSE, and the check asserts the call returned well inside that. A
   * fixture that never settled at all would make this the one check in the file that cannot fail:
   * with the bound removed from `judge()` the gate would not report a failed assertion, it would
   * hang, and a hang is not a report. With the fixture's own deadline, a missing bound produces a
   * `failed` answer after ~4000 ms and fails on both `status` and the elapsed time. */
  let hangingSignal = null;
  judgeRegistry.execute = (exec) => {
    hangingSignal = exec.signal;
    return new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('the fixture was never stopped: the bound did not settle this call')), 4000);
    });
  };
  const startedAt = Date.now();
  const timedOut = await judgeLab.judge({ timeoutMs: 150 });
  const waited = Date.now() - startedAt;
  check(
    'a run that does not settle is reported as a timeout, and the bound really ends it',
    timedOut.status === 'timeout' &&
      timedOut.attempted === true &&
      timedOut.code === 'timeout' &&
      timedOut.label.includes('超时未完成') &&
      waited < 3000,
    JSON.stringify({ status: timedOut.status, waited, label: timedOut.label }),
  );
  check(
    'and the run is told to stop: the signal the dispatch was handed is aborted at the bound',
    hangingSignal instanceof AbortSignal && hangingSignal.aborted === true,
    JSON.stringify({ aborted: hangingSignal?.aborted }),
  );

  /* NOTHING TO JUDGE, at the component: no dispatch at all. */
  const noneLab = createMemoryLab({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'nml-none-')), tools: judgeRegistry });
  noneLab.store.ensureLayout();
  judgeRegistry.execute = async () => {
    throw new Error('nothing should have been dispatched over an empty review');
  };
  const nothing = await noneLab.judge({ timeoutMs: 4000 });
  check(
    'an empty store dispatches nothing and says there is nothing to judge',
    nothing.status === 'none' && nothing.attempted === false && nothing.label.includes('没有需要判定的事项'),
    JSON.stringify({ status: nothing.status, label: nothing.label }),
  );

  /* HALF ONE FAILED. The judgement is not asked for over an index the deterministic half could not
   * write, and it is REPORTED rather than passed off as an empty judgement or a skip. */
  const blocked = await judgeLab.judge({ timeoutMs: 4000, rebuildError: 'the index could not be written' });
  check(
    'a failed deterministic rebuild blocks the judgement, and says which half failed',
    blocked.status === 'blocked' &&
      blocked.attempted === false &&
      blocked.label.includes('确定性重建失败') &&
      blocked.label.includes('the index could not be written'),
    JSON.stringify({ status: blocked.status, label: blocked.label }),
  );

  /* AND THE SWITCH, at the component: with `agent_api_send` unregistered there is no ask to make. */
  judgeRegistry.get = () => undefined;
  judgeRegistry.execute = async () => {
    throw new Error('nothing may be dispatched while the judge is off');
  };
  const judgeOff = await judgeLab.judge({ timeoutMs: 4000 });
  check(
    'with the judge off nothing is dispatched and the answer names the switch',
    judgeOff.status === 'unavailable' && judgeOff.attempted === false && judgeOff.label.includes('agent-api 已停用'),
    JSON.stringify({ status: judgeOff.status, label: judgeOff.label }),
  );
  judgeRegistry.get = () => ({ name: 'agent_api_send' });
  check(
    'the ask the judgement is built from is non-empty, so the checks above are about a real ask',
    typeof judgeAskText === 'string' && judgeAskText.length > 200 && judgeReview.counts.findings > 0 && dispatchedTo.every((exec) => exec.arguments.prompt === judgeAskText),
    JSON.stringify({ chars: judgeAskText?.length, findings: judgeReview.counts.findings, dispatches: dispatchedTo.length }),
  );

  /* ------------------------------------- every one of those is PERSISTED --- */

  /* 所有失败行为都要在.Newmark保存报错打印. The nine judgements above are the whole taxonomy,
   * driven once each against ONE root, so the file this module wrote is the evidence for the
   * rule rather than a restatement of it: seven of the nine statuses are failures, and the two
   * that are not — `judged` (a run answered) and `none` (the rebuild left nothing to judge) —
   * must be absent from it.
   *
   * The expected codes are the RUN'S OWN, in the order the calls were made. A recording that
   * collapsed them into one `judgement_failed` would be the disguise rule 2 forbids, and this
   * assertion is what makes that collapse fail loudly instead of looking tidy. */
  const judgeLogPath = path.join(judgeRoot, 'errors.jsonl');
  const judgeLogLines = fs.existsSync(judgeLogPath)
    ? fs.readFileSync(judgeLogPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const JUDGEMENT_LOG_CODES = [
    'model_not_selected', // exit 3: nothing was attempted
    'llm_unavailable', // exit 3
    'run_failed', // exit 4: a run happened and did not deliver
    'UNKNOWN_TOOL', // the dispatch never reached the tool
    'run_timeout', // the bound ended the call before any answer came back
    'judgement_blocked', // the deterministic half failed first
    'agent_api_off', // the switch, which is not "nothing to do"
  ];
  check(
    'every judgement that is not a verdict is persisted, with the run’s own code and not a summary of it',
    judgeLogLines.length === JUDGEMENT_LOG_CODES.length &&
      judgeLogLines.every((entry, index) => entry.code === JUDGEMENT_LOG_CODES[index]),
    `codes=${JSON.stringify(judgeLogLines.map((entry) => entry.code))} expected=${JSON.stringify(JUDGEMENT_LOG_CODES)}`,
  );
  check(
    'every line carries at, where, code and message, and every one names its half',
    judgeLogLines.length > 0 &&
      judgeLogLines.every(
        (entry) =>
          typeof entry.at === 'string' &&
          !Number.isNaN(Date.parse(entry.at)) &&
          entry.where === 'memorylab/judgement' &&
          typeof entry.code === 'string' &&
          entry.code.length > 0 &&
          typeof entry.message === 'string' &&
          entry.message.length > 0,
      ),
    JSON.stringify(judgeLogLines[0] ?? null),
  );
  const timeoutLine = judgeLogLines.find((entry) => entry.code === 'run_timeout');
  check(
    'a timeout is recorded as a timeout: its own status, its own code, and never as a judgement or a skip',
    timeoutLine !== undefined &&
      timeoutLine.status === 'timeout' &&
      timeoutLine.attempted === true &&
      String(timeoutLine.label).includes('超时未完成') &&
      timeoutLine.runCode === 'timeout',
    JSON.stringify(timeoutLine ?? null),
  );
  const switchLine = judgeLogLines.find((entry) => entry.code === 'agent_api_off');
  check(
    'agent-api switched off is its own code in the log, and says nothing was attempted',
    switchLine !== undefined && switchLine.status === 'unavailable' && switchLine.attempted === false && switchLine.exit === null,
    JSON.stringify(switchLine ?? null),
  );
  check(
    'a verdict and a clean store write nothing: no line carries judged or none',
    judgeLogLines.every((entry) => entry.status !== 'judged' && entry.status !== 'none') &&
      !fs.existsSync(path.join(noneLab.rootDir, 'errors.jsonl')),
    `statuses=${JSON.stringify(judgeLogLines.map((entry) => entry.status))}, none-root log=${fs.existsSync(path.join(noneLab.rootDir, 'errors.jsonl'))}`,
  );

  /* The empty-store fixture's own root is removed here rather than left in %TEMP%: this gate is
   * run by the mutation harness two dozen times in a row, and a fixture nobody cleans up turns
   * into a hundred directories nobody looks at. */
  fs.rmSync(noneLab.rootDir, { recursive: true, force: true });

  fs.rmSync(judgeRoot, { recursive: true, force: true });

  /* ============================== the failure log, as its own subject === */

  /* The four rules `lib/errors.js` states, each driven by a real failing operation rather than
   * asserted against the module's prose.
   *
   * Everything here runs against a THROWAWAY ROOT (`mkdtemp`). That is not tidiness: the log
   * lives at `<root>/errors.jsonl`, the user's live root is `~/.Newmark`, and a gate that drove
   * these failures against it would write into the user's home — which is the one thing this
   * task must not do. The live index is digested at the top of this file and compared at the
   * bottom for the same reason.
   *
   * The log is read through `logText`/`logLines`, which answer `''`/`[]` when there is no file:
   * this block exists to run against a log that is MISSING or wrong as often as a working one,
   * and a `readFileSync` that throws would abort the gate instead of reporting the assertion
   * that failed. A gate that crashes is not a report — and a mutation measurement needs the
   * named check to go red, not the process to die. */
  const logText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const logLines = (file) =>
    logText(file)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-faillog-'));
  const printed = [];
  const logRegistry = {
    get: () => ({ name: 'agent_api_send' }),
    execute: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      value: { ok: false, tool: 'agent_api_send', route: 'loop', exit: 4, class: 'failed', code: 'run_failed', error: 'the provider exploded' },
    }),
  };
  const logLab = createMemoryLab({
    root: logRoot,
    tools: logRegistry,
    logger: { info() {}, warn() {}, error: (message) => printed.push(String(message)) },
  });
  /* TWO components carrying near-synonym tags, because that is what gives the review something
   * to report and therefore a judgement that is actually ASKED FOR: against a clean store the
   * answer is `none`, nothing is dispatched, and there would be no failure to log at all — a
   * fixture that cannot fail is not evidence. */
  logLab.store.update({ name: 'Log A', tags: ['#日志探针'], content: '# a\n' });
  logLab.store.update({ name: 'Log B', tags: ['#日志探针扩展'], content: '# b\n' });
  const logPath = path.join(logRoot, 'errors.jsonl');

  const firstFailure = await logLab.judge({ timeoutMs: 4000 });
  const firstFileText = logText(logPath);
  check(
    'a failed judgement is written to <root>/errors.jsonl, the same root the store is under',
    firstFailure.status === 'failed' && fs.existsSync(logPath) && logLines(logPath).length === 1,
    JSON.stringify({ status: firstFailure.status, path: logPath, lines: logLines(logPath).length }),
  );
  check(
    'and the same failure is printed through ctx.logger.error: the file is for afterwards, the log is for now',
    printed.length === 1 &&
      printed[0].includes('where=memorylab/judgement') &&
      printed[0].includes('code=run_failed') &&
      printed[0].includes('the provider exploded') &&
      printed[0].includes(logPath),
    JSON.stringify(printed),
  );

  /* APPENDED, NEVER REWRITTEN. The second failure must leave the first line byte-for-byte as it
   * was: a logger that reopened and rewrote the file would pass every check above and still lose
   * the history it exists to keep. */
  logRegistry.execute = async () => ({
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    value: { ok: false, tool: 'agent_api_send', route: 'loop', exit: 4, class: 'failed', code: 'max_steps', error: 'the loop hit its cap' },
  });
  const secondFailure = await logLab.judge({ timeoutMs: 4000 });
  const secondFileText = logText(logPath);
  const secondLines = logLines(logPath);
  check(
    'a second failure is APPENDED: the first line is still there, unchanged, and both are readable',
    secondFailure.code === 'max_steps' &&
      secondLines.length === 2 &&
      secondFileText.startsWith(firstFileText) &&
      secondLines[1].code === 'max_steps' &&
      firstFileText !== '',
    JSON.stringify({ lines: secondLines.length, prefixKept: secondFileText.startsWith(firstFileText) }),
  );

  /* A LOGGER THAT THROWS MUST NOT TAKE THE OPERATION DOWN. `ctx.logger.error` is the other half
   * of the instruction and it belongs to somebody else's object; if it throws, the failure must
   * still be written and the judgement must still return its envelope. */
  const hostileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-faillog-hostile-'));
  const hostileLab = createMemoryLab({
    root: hostileRoot,
    tools: logRegistry,
    logger: {
      info() {},
      warn() {},
      error() {
        throw new Error('the host logger is down');
      },
    },
  });
  hostileLab.store.update({ name: 'Log A', tags: ['#日志探针'], content: '# a\n' });
  hostileLab.store.update({ name: 'Log B', tags: ['#日志探针扩展'], content: '# b\n' });
  let hostileThrew = null;
  let hostileVerdict = null;
  try {
    hostileVerdict = await hostileLab.judge({ timeoutMs: 4000 });
  } catch (error) {
    hostileThrew = error;
  }
  const hostilePath = path.join(hostileRoot, 'errors.jsonl');
  check(
    'a logger that throws does not take the operation down, and the failure is still written',
    hostileThrew === null &&
      hostileVerdict?.status === 'failed' &&
      fs.existsSync(hostilePath) &&
      logLines(hostilePath)[0]?.code === 'max_steps',
    JSON.stringify({ threw: String(hostileThrew?.message ?? ''), status: hostileVerdict?.status, written: fs.existsSync(hostilePath) }),
  );

  /* THE DETERMINISTIC HALF. `store.reindex()` is patched to throw, which is the one failure the
   * component cannot produce on demand: it must still throw to its caller — the behaviour every
   * call site already had — and it must be recorded as `memorylab/rebuild` on the way out. */
  const rebuildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-faillog-rebuild-'));
  const rebuildLab = createMemoryLab({ root: rebuildRoot, tools: logRegistry, logger: { info() {}, warn() {}, error: (message) => printed.push(String(message)) } });
  const realReindex = rebuildLab.store.reindex.bind(rebuildLab.store);
  rebuildLab.store.reindex = () => {
    throw new Error('the index could not be written', { cause: new Error('EACCES: permission denied') });
  };
  let rebuildThrew = null;
  try {
    rebuildLab.rebuild();
  } catch (error) {
    rebuildThrew = error;
  }
  rebuildLab.store.reindex = realReindex;
  const rebuildLines = logLines(path.join(rebuildRoot, 'errors.jsonl'));
  check(
    'a deterministic rebuild that throws is recorded as memorylab/rebuild, with its cause chain, and still throws',
    rebuildThrew !== null &&
      rebuildLines.length === 1 &&
      rebuildLines[0].where === 'memorylab/rebuild' &&
      rebuildLines[0].code === 'rebuild_failed' &&
      rebuildLines[0].detail.includes('the index could not be written') &&
      rebuildLines[0].detail.includes('EACCES'),
    JSON.stringify({ threw: String(rebuildThrew?.message ?? ''), lines: rebuildLines }),
  );
  check(
    'and the rebuild failure is printed as well as saved, both halves every time',
    printed.some((line) => line.includes('where=memorylab/rebuild') && line.includes('code=rebuild_failed')),
    JSON.stringify(printed.slice(-2)),
  );

  /* THE WRITE THAT DID NOT VERIFY. `store.read` is made unreadable, which is what a read-back
   * that disagrees looks like from inside `verifiedReceipt`: the component was written and the
   * index cannot confirm it. The tool still answers the caller with its structured failure — the
   * behaviour it always had — and the failure is persisted, because the caller is usually a model
   * that may say nothing about it. */
  const writeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-faillog-write-'));
  const writeLab = createMemoryLab({
    root: writeRoot,
    tools: logRegistry,
    logger: { info() {}, warn() {}, error: (message) => printed.push(String(message)) },
  });
  const realRead = writeLab.store.read.bind(writeLab.store);
  writeLab.store.read = () => null;
  const updateTool = writeLab.tools().find((definition) => definition.name === 'memory_lab_update');
  const unverified = await updateTool.execute({ name: 'Unverified', content: '# u\n', reason: 'failure-log fixture' });
  writeLab.store.read = realRead;
  const writeLines = logLines(path.join(writeRoot, 'errors.jsonl'));
  check(
    'a write that does not verify after the rebuild is recorded as memorylab/write, and still reported to the caller',
    unverified.ok === false &&
      String(unverified.error).includes('did not verify after rebuild') &&
      writeLines.length === 1 &&
      writeLines[0].where === 'memorylab/write' &&
      writeLines[0].code === 'write_not_verified' &&
      writeLines[0].slug === 'unverified',
    JSON.stringify({ answer: unverified, lines: writeLines }),
  );
  check(
    'and that one is printed too, so a model’s silent failed write is visible where a person is looking',
    printed.some((line) => line.includes('where=memorylab/write') && line.includes('code=write_not_verified')),
    JSON.stringify(printed.slice(-2)),
  );

  fs.rmSync(logRoot, { recursive: true, force: true });
  fs.rmSync(hostileRoot, { recursive: true, force: true });
  fs.rmSync(rebuildRoot, { recursive: true, force: true });
  fs.rmSync(writeRoot, { recursive: true, force: true });

  /* ------------------------------------------- a judgement, end to end --- */

  const agentLabDir = path.join(agentRoot, 'Memory Lab');
  const agentIndexPath = path.join(agentLabDir, 'index.json');
  const agentPolicyPath = path.join(agentLabDir, 'policy.jsonl');
  await servedTool('memory_lab_update').execute({
    name: 'Judged Root',
    tags: ['#判定假根', '#判定总目录'],
    tagPaths: [['#判定假根'], ['#判定总目录']],
    content: '# root\n',
    reason: 'judgement fixture',
  });
  const reparentReview = await servedTool('memory_lab_tag_review').execute({ kinds: ['false-root'] });
  const reparented = await servedApply.execute({
    decisions: [{ kind: 'reparent', tag: '#判定假根', under: '#判定总目录' }],
    reason: 'judgement fixture: continue a false root',
    source: 'gate-memorylab-tools',
    expectedRelationshipVersion: reparentReview.relationshipVersion,
  });
  const agentGraph = JSON.parse(fs.readFileSync(agentIndexPath, 'utf8'));
  check(
    'memory_lab_tag_apply re-parents a root tag and reports the version change',
    reparented.ok === true && reparented.changed === true && reparented.relationshipVersionAfter !== reparented.relationshipVersionBefore,
    JSON.stringify(reparented).slice(0, 240),
  );
  check(
    'the re-parented tag now sits under its parent in the index',
    (agentGraph.tags['#判定假根']?.parents || []).includes('#判定总目录'),
    JSON.stringify(agentGraph.tags['#判定假根'] || null),
  );
  check(
    'the apply archived the pre-change index verbatim under archive/',
    typeof reparented.archived === 'string' &&
      reparented.archived.includes('_tag-graph') &&
      fs.existsSync(reparented.archived) &&
      JSON.parse(fs.readFileSync(reparented.archived, 'utf8')).relationshipVersion === reparented.relationshipVersionBefore,
    String(reparented.archived),
  );
  const tagPolicy = fs.readFileSync(agentPolicyPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const tagEvent = tagPolicy[tagPolicy.length - 1];
  check(
    'the apply recorded the decision, the affected components and an undo list in policy.jsonl',
    tagEvent.action === 'TAG-EDIT' && Array.isArray(tagEvent.decisions) && tagEvent.decisions.length === 1 && Array.isArray(tagEvent.undo) && tagEvent.undo.length > 0,
    JSON.stringify(tagEvent).slice(0, 240),
  );
  check('the audit line names no memory content', !JSON.stringify(tagEvent).includes('# root'), JSON.stringify(tagEvent).slice(0, 160));

  const undone = await servedApply.execute({ decisions: reparented.undo, reason: 'judgement fixture: undo', source: 'gate-memorylab-tools' });
  check(
    'the undo restores the previous graph version exactly',
    undone.relationshipVersionAfter === reparented.relationshipVersionBefore,
    `${reparented.relationshipVersionBefore?.slice(0, 12)} -> ${undone.relationshipVersionAfter?.slice(0, 12)}`,
  );
  check('the undo left the re-parented tag a root again', (JSON.parse(fs.readFileSync(agentIndexPath, 'utf8')).tags['#判定假根']?.parents || []).length === 0);

  let staleError2 = null;
  try {
    await servedApply.execute({ decisions: [{ kind: 'merge', tags: ['#判定基准扩展'], into: '#判定基准' }], expectedRelationshipVersion: 'stale-version' });
  } catch (error) {
    staleError2 = error;
  }
  check('a judgement with a stale expectedRelationshipVersion fails closed', String(staleError2?.code) === 'STALE_WRITE', String(staleError2?.code ?? 'no error'));

  let unrepresentable = null;
  try {
    await servedApply.execute({ decisions: [{ kind: 'join', path: ['#判定假根', '#判定总目录'], into: '#判定假根/#判定总目录' }] });
  } catch (error) {
    unrepresentable = error;
  }
  check(
    'a join into a name the parser would split again is refused, naming the reason',
    String(unrepresentable?.code) === 'UNREPRESENTABLE_TAG_NAME',
    String(unrepresentable?.message ?? 'no error'),
  );

  let unknownDecision = null;
  try {
    await servedApply.execute({ decisions: [{ kind: 'make-it-nice' }] });
  } catch (error) {
    unknownDecision = error;
  }
  check('an unknown decision is refused and the known kinds are named', String(unknownDecision?.code) === 'UNKNOWN_DECISION' && Array.isArray(unknownDecision?.details?.known), JSON.stringify(unknownDecision?.details?.known ?? null));

  await servedTool('memory_lab_update').execute({ name: 'Dry Run A', tags: ['#判定干跑'], content: '# dry a\n', reason: 'dry-run fixture' });
  await servedTool('memory_lab_update').execute({ name: 'Dry Run B', tags: ['#判定干跑扩展'], content: '# dry b\n', reason: 'dry-run fixture' });
  const dry = await servedApply.execute({ decisions: [{ kind: 'merge', tags: ['#判定干跑扩展'], into: '#判定干跑' }], dryRun: true });
  const afterDry = JSON.parse(fs.readFileSync(agentIndexPath, 'utf8'));
  check(
    'a dry run reports the change and writes nothing',
    dry.ok === true && dry.dryRun === true && dry.changed === true && dry.relationshipVersionAfter !== dry.relationshipVersionBefore && afterDry.relationshipVersion === dry.relationshipVersionBefore,
    JSON.stringify({ dry: dry.relationshipVersionAfter, stored: afterDry.relationshipVersion }).slice(0, 200),
  );
  fs.rmSync(agentRoot, { recursive: true, force: true });
  check(
    'a reversal still applies while the interface is off: switching agent-api off must not strand a recorded decision',
    await (async () => {
      const disabledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nml-agentoff-'));
      const disabled = [];
      standalone.apply(
        {
          logger: { info() {}, warn() {}, error() {} },
          tools: { register(definition) { disabled.push(definition); return () => {}; } },
          webServer: { tapIndex: () => () => {}, register: () => () => {} },
          effect(callback) { const disposer = callback(); return typeof disposer === 'function' ? disposer : () => {}; },
          get() { return undefined; },
        },
        { root: disabledRoot, agentApi: { active: () => [], isActive: () => false, root: () => disabledRoot } },
      );
      const tool = (name) => disabled.find((definition) => definition.name === name);
      await tool('memory_lab_update').execute({ name: 'Stranded', tags: ['#搁置'], content: '# s\n', reason: 'fixture' });
      const before = await tool('memory_lab_reindex').execute({});
      const reversal = await tool('memory_lab_tag_apply').execute({
        decisions: [{ kind: 'set-tags', slug: 'stranded', tags: ['#搁置'], tagPaths: [['#搁置']] }],
        reason: 'reversal fixture',
      });
      fs.rmSync(disabledRoot, { recursive: true, force: true });
      return reversal.ok === true && before.ok === true;
    })(),
  );
  fs.rmSync(agentRoot, { recursive: true, force: true });

  /* ------------------------------------------- navigating the tag graph --- */

  /* THE TWO NAVIGATION READS. This section builds its OWN hierarchy instead of reusing the
   * tag-review fixtures above: those were shaped to make the REVIEW report something, and a
   * review fixture is not a tree. This one is small enough to hold every expected number by
   * hand, and it carries each shape the two tools have to tell apart:
   *
   *        #nav根 ──┬── #nav子 ──┬── #nav叶
   *                 │            ├── #nav孙      <- ALSO a child of #nav根: a DAG, not a cycle
   *                 │            └── #nav深叶
   *                 └── #nav孙
   *
   *   Nav Root Only        #nav根                     carries the tag itself, nothing beneath it
   *   Nav Deep Chain       #nav根 > #nav子 > #nav孙
   *   Nav Deep Leaf        #nav根 > #nav子 > #nav叶
   *   Nav Descendant Only  #nav子 > #nav深叶          carries NO tag the root itself names
   *   Nav Diamond          #nav根 > #nav孙
   *
   * plus an alias pair: two spellings of one synonym group, which the store folds onto ONE tag and
   * advertises the other as that tag's alias. */
  const rootTags = tool('memory_lab_root_tags');
  const subtagTree = tool('memory_lab_subtag_tree');
  const navFixtures = [
    { name: 'Nav Root Only', tagPaths: [['#nav根']] },
    { name: 'Nav Deep Chain', tagPaths: [['#nav根', '#nav子', '#nav孙']] },
    { name: 'Nav Deep Leaf', tagPaths: [['#nav根', '#nav子', '#nav叶']] },
    { name: 'Nav Descendant Only', tagPaths: [['#nav子', '#nav深叶']] },
    { name: 'Nav Diamond', tagPaths: [['#nav根', '#nav孙']] },
    { name: 'Nav Alias A', tags: ['#记忆'] },
    { name: 'Nav Alias B', tags: ['#memory'] },
    /* ONE CHAIN, 70 TAGS DEEP — deeper than the walk's own depth cap. `max_tags` and
     * `max_components` bound the PAGE; the walk itself is bounded by a visited set and by
     * `MAX_TREE_DEPTH`, and a bound nothing in the store ever reaches is a bound nothing has
     * measured. This fixture is what reaches it, so the cut and its report are exercised. */
    { name: 'Nav Depth Bound', tagPaths: [Array.from({ length: 70 }, (_, index) => `#deep${index + 1}`)] },
  ];
  for (const fixture of navFixtures) {
    await update({ ...fixture, content: `# ${fixture.name}\n`, reason: 'functional test: tag navigation fixture', source: 'gate-memorylab-tools' });
  }

  /* A READ IS A READ. Every navigation call below is bracketed by the store's own bytes: the
   * index, the policy log and the archive. `memory_lab_tag_review` already asserts this for
   * itself; these two are new, and "it is obviously read-only" is what the last one was too. */
  const navState = () => ({
    index: digest(indexPath),
    policy: digest(path.join(labDir, 'policy.jsonl')),
    archive: fs.readdirSync(path.join(labDir, 'archive'), { recursive: true }).length,
  });
  const navBefore = navState();
  navigationInstructions = String((await read({})).instructions || '');

  const rootsAnswer = await rootTags({});
  check(
    'memory_lab_root_tags answers the roots, and answers them for the store it is reading',
    rootsAnswer.ok === true && Array.isArray(rootsAnswer.roots) && rootsAnswer.roots.length > 0 && rootsAnswer.roots.length === rootsAnswer.window.total,
    JSON.stringify(rootsAnswer).slice(0, 240),
  );
  check(
    'every root row carries what decides a descent: children, direct components, and the subtree in tags and in components',
    rootsAnswer.roots.every(
      (root) =>
        typeof root.tag === 'string' &&
        typeof root.children === 'number' &&
        typeof root.components === 'number' &&
        typeof root.subtreeTags === 'number' &&
        typeof root.subtreeComponents === 'number' &&
        typeof root.depth === 'number' &&
        Array.isArray(root.aliases) &&
        root.subtreeTags >= 1 &&
        root.subtreeComponents >= root.components,
    ),
    JSON.stringify(rootsAnswer.roots.slice(0, 3)),
  );
  const navRoot = rootsAnswer.roots.find((root) => root.tag === '#nav根');
  check(
    'the fixture root is sized from the real graph: 2 direct children, 4 direct components, 5 tags and 5 components under it, 2 levels deep',
    Boolean(navRoot) &&
      navRoot.children === 2 &&
      navRoot.components === 4 &&
      navRoot.subtreeTags === 5 &&
      navRoot.subtreeComponents === 5 &&
      navRoot.depth === 2,
    JSON.stringify(navRoot ?? null),
  );
  const aliasRoot = rootsAnswer.roots.find((root) => root.tag === '#memory');
  check(
    'a root row carries the aliases the store has, and does not invent one where it has none',
    Boolean(aliasRoot) &&
      aliasRoot.aliases.includes('#记忆') &&
      aliasRoot.aliases.includes('#记忆库') &&
      navRoot.aliases.length === 0,
    JSON.stringify({ aliasRoot: aliasRoot?.aliases ?? null, navRoot: navRoot?.aliases ?? null }),
  );
  check(
    'the roots are ordered by subtree size, largest first — so the page leads with the branch worth descending into',
    // The property, not a transcription of the order: a sort that is a sort holds for every
    // adjacent pair. The fixture makes this able to fail — `#nav根` is created AFTER the small
    // tag-review roots, so the graph's own order puts it last, and only the sort can put it first.
    rootsAnswer.roots.every((root, index) => index === 0 || rootsAnswer.roots[index - 1].subtreeTags >= root.subtreeTags) &&
      rootsAnswer.roots[0].subtreeTags === Math.max(...rootsAnswer.roots.map((root) => root.subtreeTags)),
    rootsAnswer.roots.map((root) => `${root.tag}:${root.subtreeTags}`).join(' '),
  );
  const rootsPage = await rootTags({ limit: 2 });
  check(
    'the roots are paged, and the page says how many roots it left out',
    rootsPage.roots.length === 2 && rootsPage.window.total === rootsAnswer.window.total && rootsPage.window.omitted === rootsAnswer.window.total - 2,
    JSON.stringify(rootsPage.window),
  );

  const treeAnswer = await subtagTree({ tag: '#nav根' });
  check(
    'memory_lab_subtag_tree answers the structure, the components and the statistics of one subtree',
    treeAnswer.ok === true &&
      treeAnswer.tag === '#nav根' &&
      Array.isArray(treeAnswer.structure) &&
      Array.isArray(treeAnswer.components) &&
      treeAnswer.statistics.tags === 5 &&
      treeAnswer.statistics.components === 5 &&
      treeAnswer.statistics.depth === 2 &&
      treeAnswer.statistics.directComponents === 4,
    JSON.stringify({ tag: treeAnswer.tag, statistics: treeAnswer.statistics, error: treeAnswer.error ?? null }).slice(0, 300),
  );
  const rowOf = (answer, tag) => answer.structure.find((row) => row.tag === tag);
  check(
    "the structure is depth-first, level by level, and every row carries the tag's depth, parent, child count and direct components",
    // The whole table, because it is small and because a table is the one thing a spot check
    // cannot vouch for. Depth, parent, child count and direct-component count are exact; the
    // ORDER is asserted by the two-calls-agree check below and by the depth here.
    JSON.stringify(treeAnswer.structure.map((row) => [row.tag, row.depth, row.parent, row.children, row.components])) ===
      JSON.stringify([
        ['#nav根', 0, null, 2, 4],
        ['#nav子', 1, '#nav根', 3, 3],
        ['#nav叶', 2, '#nav子', 0, 1],
        ['#nav孙', 2, '#nav子', 0, 2],
        ['#nav深叶', 2, '#nav子', 0, 1],
      ]),
    JSON.stringify(treeAnswer.structure),
  );
  check(
    'the walk reports a tag reachable by two paths as a SHARED node, not as a cycle, and every child is still listed exactly once',
    treeAnswer.diamonds.length === 1 &&
      treeAnswer.diamonds[0].tag === '#nav孙' &&
      JSON.stringify(treeAnswer.diamonds[0].alsoUnder) === JSON.stringify(['#nav根']) &&
      treeAnswer.cycles.metByTheWalk.length === 0 &&
      treeAnswer.structure.filter((row) => row.tag === '#nav孙').length === 1,
    JSON.stringify({ diamonds: treeAnswer.diamonds, metByTheWalk: treeAnswer.cycles.metByTheWalk }).slice(0, 240),
  );
  const treeAgain = await subtagTree({ tag: '#nav根' });
  check(
    'two calls on an unchanged graph agree field for field',
    JSON.stringify({ ...treeAgain, loadedAt: null, relationshipVersion: null }) ===
      JSON.stringify({ ...treeAnswer, loadedAt: null, relationshipVersion: null }),
    'the second read of the same subtree differed from the first',
  );
  const viaOf = (answer, slug) => answer.components.find((component) => component.slug === slug)?.via ?? null;
  check(
    'every component in the subtree says WHY it is there: it carries the tag itself, a descendant, or both',
    treeAnswer.components.length === 5 &&
      viaOf(treeAnswer, 'nav-root-only') === 'self' &&
      viaOf(treeAnswer, 'nav-descendant-only') === 'descendant' &&
      viaOf(treeAnswer, 'nav-deep-chain') === 'both' &&
      viaOf(treeAnswer, 'nav-diamond') === 'both',
    JSON.stringify(treeAnswer.components),
  );
  const readable = await Promise.all(treeAnswer.components.map((component) => read({ component: component.slug })));
  check(
    'every component name in the subtree is reachable afterwards with memory_lab_read',
    readable.length === 5 && readable.every((answer, index) => answer.ok === true && answer.component?.slug === treeAnswer.components[index].slug),
    readable.map((answer) => `${answer.component?.slug ?? '(none)'}:${answer.ok}`).join(' '),
  );
  const leafAnswer = await subtagTree({ tag: '#nav叶' });
  check(
    'a leaf tag answers a subtree of one, at depth 0, with the component that carries it',
    leafAnswer.ok === true &&
      leafAnswer.statistics.tags === 1 &&
      leafAnswer.statistics.depth === 0 &&
      leafAnswer.statistics.components === 1 &&
      leafAnswer.structure.length === 1 &&
      leafAnswer.structure[0].parent === null &&
      leafAnswer.structure[0].children === 0 &&
      viaOf(leafAnswer, 'nav-deep-leaf') === 'self',
    JSON.stringify({ statistics: leafAnswer.statistics, structure: leafAnswer.structure }),
  );
  const noHash = await subtagTree({ tag: 'nav根' });
  const byAlias = await subtagTree({ tag: '#记忆' });
  check(
    'the leading # is optional, and an alias the store advertises resolves to the tag it is an alias OF',
    noHash.ok === true &&
      noHash.tag === '#nav根' &&
      noHash.matchedBy === 'normalized' &&
      byAlias.ok === true &&
      byAlias.tag === '#memory' &&
      byAlias.matchedBy === 'alias' &&
      byAlias.aliases.includes('#记忆'),
    JSON.stringify({ noHash: [noHash.tag, noHash.matchedBy], byAlias: [byAlias.tag, byAlias.matchedBy] }),
  );
  const unknownTag = await subtagTree({ tag: '#nav-no-such-tag' });
  check(
    'an unknown tag is NOT_FOUND, in the same envelope memory_lab_read answers a missing component with, and it names the tag',
    unknownTag.ok === false &&
      unknownTag.error?.code === 'NOT_FOUND' &&
      String(unknownTag.error?.message || '').includes('#nav-no-such-tag') &&
      unknownTag.error?.details?.tag === '#nav-no-such-tag' &&
      Array.isArray(unknownTag.error?.details?.rootTags) &&
      unknownTag.error.details.rootTags.includes('#nav根'),
    JSON.stringify(unknownTag.error ?? null).slice(0, 300),
  );
  let emptyTag = null;
  try {
    await subtagTree({ tag: '   ' });
  } catch (error) {
    emptyTag = error;
  }
  check('an empty tag is refused rather than answered with a subtree of the whole graph', String(emptyTag?.code) === 'INVALID_TAG', JSON.stringify(emptyTag?.toJSON?.() ?? String(emptyTag)));

  /* THE BOUND. A subtree larger than the page must not produce a page that looks like a small
   * subtree: the rows are cut, the STATISTICS still tell the truth, and `bounds` names the limit
   * and lists what went. */
  const bounded = await subtagTree({ tag: '#nav根', max_tags: 2, max_components: 1 });
  check(
    'the payload is bounded by max_tags and max_components, and the true totals survive the cut',
    bounded.ok === true &&
      bounded.structure.length === 2 &&
      bounded.components.length === 1 &&
      bounded.statistics.tags === 5 &&
      bounded.statistics.components === 5 &&
      bounded.bounds.tagsOmitted === 3 &&
      bounded.bounds.componentsOmitted === 4 &&
      bounded.bounds.truncated === true,
    JSON.stringify(bounded.bounds),
  );
  check(
    'the bound is STATED and what it dropped is LISTED, naming the parameter that cut it',
    bounded.bounds.maxTags === 2 &&
      bounded.bounds.maxComponents === 1 &&
      bounded.bounds.dropped.length === 2 &&
      bounded.bounds.dropped.some((line) => line.includes('max_tags=2')) &&
      bounded.bounds.dropped.some((line) => line.includes('max_components=1')),
    JSON.stringify(bounded.bounds.dropped),
  );
  const unbounded = await subtagTree({ tag: '#nav根' });
  check(
    'nothing is reported as dropped when nothing was',
    unbounded.bounds.truncated === false && unbounded.bounds.dropped.length === 0 && unbounded.bounds.tagsOmitted === 0,
    JSON.stringify(unbounded.bounds),
  );
  const depthCut = await subtagTree({ tag: '#deep1' });
  check(
    'a chain deeper than the walk allows is CUT at the depth cap, and the cut is reported rather than hidden',
    depthCut.ok === true &&
      depthCut.statistics.tags === 65 &&
      depthCut.statistics.depth === 64 &&
      depthCut.bounds.truncated === true &&
      depthCut.bounds.dropped.length === 1 &&
      depthCut.bounds.dropped[0].includes('maxDepth=64'),
    JSON.stringify({ statistics: depthCut.statistics, bounds: depthCut.bounds }).slice(0, 300),
  );

  /* A CYCLE IN THE STORE, and the walk that must not hang on it. The loaded graph cannot hold one
   * — `normalizeIndex()` refuses the closing edge — so the cycle is written into the throwaway
   * `index.json` by hand, exactly as `verify-tool-output-boundary.mjs` plants one. What is
   * measured is the pair: the call RETURNS (a loop would never answer), and the cycle it did not
   * follow is NAMED rather than silently repaired. */
  const navIndexPath = path.join(labDir, 'index.json');
  const pristineNavIndex = fs.readFileSync(navIndexPath);
  const cycledDocument = JSON.parse(pristineNavIndex.toString('utf8'));
  cycledDocument.tags['#nav根'].children = ['#nav子'];
  cycledDocument.tags['#nav子'].children = ['#nav根'];
  fs.writeFileSync(navIndexPath, JSON.stringify(cycledDocument, null, 2), 'utf8');
  const cycled = await subtagTree({ tag: '#nav根' });
  fs.writeFileSync(navIndexPath, pristineNavIndex);
  check(
    'a cycle the STORED graph really holds is named, and the walk answers instead of looping',
    cycled.ok === true &&
      cycled.cycles.read === true &&
      cycled.cycles.found.length === 1 &&
      cycled.cycles.found[0].includes('#nav根') &&
      cycled.cycles.found[0].includes('#nav子'),
    JSON.stringify({ cycles: cycled.cycles, statistics: cycled.statistics }).slice(0, 320),
  );
  /* THE READER'S OWN BOUND, reported rather than silent. This fixture store carries the 70-deep
   * chain the depth-cap check needs, and `storedCycles()` walks at most 32 levels — so its answer
   * IS truncated here, and the payload says so instead of presenting a partial walk as a clean
   * store. Asserted as `true` on purpose: this is the store the gate built, so a `false` here
   * would mean the deep fixture stopped being deep and the bound stopped being exercised. */
  check(
    "the stored-cycle walk's own depth bound is REPORTED, not silent: this store is deeper than it walks",
    cycled.cycles.truncated === true && cycled.cycles.elsewhere === 0,
    JSON.stringify(cycled.cycles).slice(0, 260),
  );
  check(
    'the structure under a stored cycle is still the whole repaired subtree, because the walk finished',
    cycled.statistics.tags === 5 && cycled.statistics.depth === 2 && cycled.structure.length === 5,
    JSON.stringify(cycled.statistics),
  );

  check(
    'both navigation tools are READS: the index, the policy log and the archive are byte-identical afterwards',
    JSON.stringify(navState()) === JSON.stringify(navBefore),
    JSON.stringify({ before: navBefore, after: navState() }),
  );

  /* The boundary itself: the judgement is not implemented here.
   *
   * MemoryLab reaches no model, starts no process and waits for none. What it does read is the
   * registry — whether `agent_api_send` is registered — through that component's own
   * `lib/presence.js`, whose header states the reason it is importable whether or not agent-api is
   * mounted: "MemoryLab resolving this path is not the components injecting each other's services;
   * it is one component reading another's declared identity."
   *
   * So the prohibition is split in two, because the two are not the same act:
   *
   *   - NO PRIVATE MECHANISM: nothing under `components/memorylab/**` may import agent-api's
   *     IMPLEMENTATION — its `component.js`, its loop, its seam, its model reader. That is the
   *     line that keeps a second agent runtime from growing here.
   *   - NO PROCESS, NO MODEL, NO WAITING: unchanged.
   *
   * The earlier form banned the substring `agent-api/` anywhere in this component, which also
   * banned the identity read the design explicitly permits — and would have failed on the import
   * that made "a judge is reachable" answerable at all after the move to registry-based presence. */
  const memorylabSource = ['component.js', 'index.js', path.join('lib', 'memory-store.js')]
    .map((file) => fs.readFileSync(path.join(packagesDir, 'newmark-core', 'components', 'memorylab', file), 'utf8'))
    .join('\n');
  const implementationImports = [...memorylabSource.matchAll(/from\s+'([^']*agent-api[^']*)'/g)].map((match) => match[1]);
  check(
    'MemoryLab implements no private agent mechanism: no process, no model, no waiting',
    !/child_process|spawn\s*\(|execFile|execSync|setInterval|while\s*\(.*await/.test(memorylabSource),
    'a process, a model call or a wait loop appeared in components/memorylab/**',
  );
  check(
    'MemoryLab imports none of the agent-api implementation, only its declared identity',
    implementationImports.length > 0 &&
      implementationImports.every((spec) => spec.endsWith('agent-api/lib/presence.js')),
    `imports reaching agent-api: ${implementationImports.join(', ') || '(none)'}`,
  );

  /* ------------------------------------------------------ the live store --- */

  check('the live store was never touched', digest(LIVE_INDEX) === liveBefore, `${liveBefore.slice(0, 16)} -> ${digest(LIVE_INDEX).slice(0, 16)}`);
  check('nothing was written under the live root', !fs.existsSync(path.join(LIVE_ROOT, 'Memory Lab', 'components', 'functional-probe.md')));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  const after = digest(LIVE_INDEX);
  if (after !== liveBefore) {
    console.log('');
    console.log(`ABORT: the live store changed during this test (${liveBefore.slice(0, 16)} -> ${after.slice(0, 16)})`);
    process.exit(2);
  }
}

/* ----------------------------------------------------- pre-exposure --- */

/* What the Agent sees before any call: the names, the prose and the parameter
 * schemas. A tool whose fields carry no description forces the model to guess, and a
 * description that overstates what the tool needs is how a good call becomes a
 * failed one. */
console.log('');
console.log('# pre-exposure');

const definitions = [
  'memory_lab_read',
  'memory_lab_query',
  'memory_lab_update',
  'memory_lab_delete',
  'memory_lab_reindex',
  'memory_lab_tag_review',
  'memory_lab_tag_apply',
  'memory_lab_root_tags',
  'memory_lab_subtag_tree',
].map((name) => mount.tools.get(name));

check('every tool declares an object parameter schema', definitions.every((d) => d.parameters?.type === 'object'));
check('every tool carries a description', definitions.every((d) => typeof d.description === 'string' && d.description.length > 60), definitions.map((d) => `${d.name}:${d.description.length}`).join(', '));
check(
  'every declared property carries a description',
  definitions.every((d) => Object.values(d.parameters.properties || {}).every((p) => typeof p.description === 'string' && p.description.length > 10)),
  definitions
    .map((d) => `${d.name}: ${Object.entries(d.parameters.properties || {}).filter(([, p]) => !p.description).map(([k]) => k).join(',') || 'ok'}`)
    .join(' | '),
);
/* Exactly three parameters in this tool set are required, and each is the one its
 * tool cannot work without: the query, the decision list, and the tag whose subtree
 * is being read. Every other field is optional on purpose, so a caller always reaches
 * the tool's own answer instead of a schema rejection. */
check(
  'the query, the decision list and the subtree tag are the only required parameters, each on its own tool',
  definitions.every((d) => {
    const required = JSON.stringify(d.parameters.required || []);
    if (d.name === 'memory_lab_query') return required === '["query"]';
    if (d.name === 'memory_lab_tag_apply') return required === '["decisions"]';
    if (d.name === 'memory_lab_subtag_tree') return required === '["tag"]';
    return (d.parameters.required || []).length === 0;
  }),
  definitions.map((d) => `${d.name}:${JSON.stringify(d.parameters.required || [])}`).join(', '),
);
check(
  'the update description states what creating and patching each need',
  mount.tools.get('memory_lab_update').description.includes('Creating requires') && mount.tools.get('memory_lab_update').description.includes('patching requires'),
);
check(
  'the delete description says a selector is required',
  Object.values(mount.tools.get('memory_lab_delete').parameters.properties).some((p) => String(p.description).includes('required')),
);
check('reindex takes no parameters', Object.keys(mount.tools.get('memory_lab_reindex').parameters.properties || {}).length === 0);
check(
  'the selector field is named component on read, update and delete, as in Newmark',
  ['memory_lab_read', 'memory_lab_update', 'memory_lab_delete'].every((name) => 'component' in mount.tools.get(name).parameters.properties),
);
check(
  'the aliases the store accepts are declared, not hidden',
  ['memory_lab_read', 'memory_lab_delete'].every((name) => 'name' in mount.tools.get(name).parameters.properties && 'slug' in mount.tools.get(name).parameters.properties),
);
check(
  'the optional bookkeeping fields are declared and explained',
  ['reason', 'source'].every((field) => typeof mount.tools.get('memory_lab_update').parameters.properties[field]?.description === 'string'),
);
/* THE TWO NAVIGATION READS SAY WHAT THEY ARE BEFORE THEY ARE CALLED. A caller that has to call a
 * tool to find out whether it writes is a caller who will call it to find out. */
check(
  'both navigation tools say in their own description that they are read-only and never judge',
  ['memory_lab_root_tags', 'memory_lab_subtag_tree'].every((name) => {
    const description = mount.tools.get(name).description;
    return description.includes('Read-only') || description.includes('read-only');
  }) &&
    mount.tools.get('memory_lab_subtag_tree').description.includes('writes nothing') &&
    mount.tools.get('memory_lab_subtag_tree').description.includes('judges nothing'),
  ['memory_lab_root_tags', 'memory_lab_subtag_tree'].map((name) => `${name}:${mount.tools.get(name).description.includes('read-only') || mount.tools.get(name).description.includes('Read-only')}`).join(' '),
);
check(
  'the usage instructions memory_lab_read hands a model name both navigation tools and say they never write',
  // Read through the tool a model reads them with, not from a copy of the string: `instructions`
  // reaches a caller as a field of `memory_lab_read`'s answer, and it is captured there.
  navigationInstructions.includes('memory_lab_root_tags') &&
    navigationInstructions.includes('memory_lab_subtag_tree') &&
    /Both are reads/.test(navigationInstructions),
  navigationInstructions.split('\n').filter((line) => line.includes('memory_lab_root_tags')).join(' | ').slice(0, 200),
);

console.log('');
console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
