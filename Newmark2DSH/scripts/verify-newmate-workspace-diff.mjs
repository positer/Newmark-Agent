import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MONITOR_DEFAULTS, enumerateDirectories, scanWorkspace, diffSnapshots, scoreDiff, settle, evaluateWorkspaces, attributeDiff, uniqueRoots, planWorkspaces, heatOf } from '../packages/newmark-core/components/newmate/lib/workspace-diff.js';
import { DIGEST_DEFAULTS, classifyPath, directoryOf, surveyChanges, summariseChanges, digestBlock } from '../packages/newmark-core/components/newmate/lib/change-digest.js';
import { createNewMate } from '../packages/newmark-core/components/newmate/component.js';

let checks = 0;
const check = (label, value) => { assert.ok(value, label); checks += 1; console.log('ok ' + checks + ' - ' + label); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-diff-'));
const workspace = path.join(root, 'ws');
fs.mkdirSync(path.join(workspace, 'src', 'deep'), { recursive: true });
fs.mkdirSync(path.join(workspace, 'node_modules', 'dep'), { recursive: true });
fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), 'one');
fs.writeFileSync(path.join(workspace, 'src', 'a.js'), 'a');
fs.writeFileSync(path.join(workspace, 'src', 'deep', 'b.js'), 'b');
fs.writeFileSync(path.join(workspace, 'node_modules', 'dep', 'index.js'), 'x');

// ---- the snapshot: the user's three quantities -----------------------------------------
const snap1 = scanWorkspace(workspace, { at: 1000, depth: 3 });
check('a snapshot carries the file COUNT, the NAMES and the LATEST MODIFICATION TIME', snap1.count === 3 && Object.keys(snap1.files).length === 3 && snap1.maxMtime > 0);
check('names are workspace-relative with forward slashes', snap1.files['src/a.js'] !== undefined && snap1.files['README.md'] !== undefined);
check('the walk never enters dependency trees or VCS internals', !Object.keys(snap1.files).some((name) => name.includes('node_modules') || name.includes('.git')));
check('contents are never read: only a timestamp per name is stored', Object.values(snap1.files).every((value) => typeof value === 'number'));
const capped = scanWorkspace(workspace, { at: 1000, depth: 3, maxFiles: 1 });
check('a file cap is reported instead of silently shrinking the workspace', capped.count === 3 && Object.keys(capped.files).length === 1 && capped.truncated.files === 2);
const shallow = scanWorkspace(workspace, { at: 1000, depth: 0 });
check('depth limits the walk and the omission is stated', shallow.count === 1 && shallow.files['README.md'] !== undefined);
const linked = path.join(root, 'linked');
try { fs.symlinkSync(path.join(root, 'elsewhere'), linked, 'dir'); } catch { /* Windows may need privileges */ }
check('a symlinked directory is not followed', !enumerateDirectories(root, { depth: 3 }).directories.some((dir) => dir.includes('linked')));

// ---- nested registered workspaces (measured on this machine: Code and Code/Newmark Agent) -----
/**
 * THE COLLAPSE IS GONE, AND THESE ASSERTIONS CHANGED MEANING WITH IT (2026-11-23).
 *
 * The old contract was "a root nested inside another is DROPPED". It stopped double counting, which was
 * right, and it starved the nested workspace, which was not: measured under "…/Files/Code", the user's
 * main repository (64 sessions) had ZERO files in the snapshot and the proactive brief said "新增 0".
 * The contract now is a CARVE-OUT: every registered workspace keeps its own scan and budget, and a
 * parent simply does not descend into a child that is a workspace of its own. The property that matters
 * is unchanged - no file is counted twice - and the new assertions say so directly.
 */
const outer = path.join(root, 'outer');
const inner = path.join(outer, 'inner');
const sibling = path.join(root, 'sibling');
const planned = planWorkspaces([inner, outer, sibling, inner]);
check('every registered workspace is planned, including one nested inside another', planned.length === 3 && planned.some((entry) => entry.root === inner) && planned.some((entry) => entry.root === outer));
const outerPlan = planned.find((entry) => entry.root === outer);
check('the parent does not descend into the nested workspace, so nothing is counted twice', outerPlan.skip.length === 1 && outerPlan.skip[0] === inner);
check('duplicates collapse and relative paths are never watched', uniqueRoots([path.join(root, 'a'), path.join(root, 'a')]).length === 1 && uniqueRoots(['relative/path', '']).length === 0);
{
  const carveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-diff-carve-'));
  const parent = path.join(carveRoot, 'parent');
  const child = path.join(parent, 'child');
  fs.mkdirSync(path.join(parent, 'own'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(parent, 'own', 'p.js'), 'p');
  fs.writeFileSync(path.join(child, 'c.js'), 'c');
  const parentSnap = scanWorkspace(parent, { at: 1000, depth: 4, skip: [child] });
  const childSnap = scanWorkspace(child, { at: 1000, depth: 4 });
  check('a carved-out parent sees its own files and none of the child\'s', Object.keys(parentSnap.files).join(',') === 'own/p.js' && parentSnap.truncated.skipped === 1);
  check('the nested workspace is scanned as itself, with its own files', Object.keys(childSnap.files).join(',') === 'c.js');
  check('coverage is reported per scan, including what a cap left out', parentSnap.coverage.directories === 2 && parentSnap.coverage.sampledFiles === 1 && parentSnap.coverage.omittedFiles === 0);
  fs.rmSync(carveRoot, { recursive: true, force: true });
}

// ---- the diff: exactly what the user asked to compare ------------------------------------
const snap2 = JSON.parse(JSON.stringify(snap1));
snap2.files['src/a.js'] = snap1.files['src/a.js'] + 5000;
snap2.files['src/new.js'] = snap1.maxMtime + 9000;
delete snap2.files['README.md'];
snap2.count = 3;
snap2.maxMtime = snap1.maxMtime + 9000;
const diff = diffSnapshots(snap1, snap2);
check('the diff names additions, removals and modifications separately', diff.added === 1 && diff.removed === 1 && diff.changed === 1);
check('the diff reports the count change and the newest-mtime advance', diff.countDelta === 0 && diff.timeDelta === 9000);
check('the first comparison against nothing is marked as such and scores nothing', diffSnapshots(undefined, snap1).first === true && scoreDiff(diffSnapshots(undefined, snap1)).score === 0);

// ---- the weighted score ------------------------------------------------------------------
const quiet = scoreDiff(diffSnapshots(snap1, JSON.parse(JSON.stringify(snap1))));
check('an unchanged workspace scores zero', quiet.score === 0 && quiet.parts.count === 0 && quiet.parts.names === 0 && quiet.parts.time === 0);
const loud = scoreDiff(diff, { countScale: 5, nameScale: 8, weightCount: 0.3, weightName: 0.5, weightTime: 0.2 }, 30 * 60000);
check('the score is a weighted sum of the three normalized parts', Math.abs(loud.score - (0.3 * 0 + 0.5 * (3 / 8) + 0.2 * Math.min(1, 9000 / (30 * 60000)))) < 1e-9);
check('the weights are normalized even when the user gives them raw numbers', Math.abs(scoreDiff(diff, { weightCount: 3, weightName: 5, weightTime: 2 }).score - loud.score) < 1e-9);
const nameOnly = scoreDiff({ countDelta: 0, added: 0, removed: 0, changed: 8, timeDelta: 0, names: [] }, {}, 30 * 60000);
check('eight changed names reach the name component ceiling', Math.abs(nameOnly.parts.names - 1) < 1e-9);

// ---- accumulation and the threshold -------------------------------------------------------
let acc = 0;
const small = 0.1;
acc = settle(acc, small).accumulated;
check('a small change accumulates instead of firing', acc > 0 && settle(acc, small).fire === false);
let fire = null;
for (let i = 0; i < 10 && !fire; i += 1) { const step = settle(acc, small); acc = step.accumulated; fire = step.fire ? step : null; }
check('enough small changes add up to one fire and the accumulator resets', Boolean(fire) && acc === 0);
check('one large change fires immediately', settle(0, 0.9).fire === true);
check('the threshold is configurable and is what decides', settle(0.5, 0.1, { threshold: 0.61 }).fire === false && settle(0.5, 0.1, { threshold: 0.6 }).fire === true);

// ---- who caused the change: DSH turns vs the user ----------------------------------------
// The only per-file evidence is the modification time, so a window during which a DSH turn ran is
// what decides attribution. These four checks are the whole rule.
const windowFrom = snap1.at;
const inWindow = { root: snap1.root, from: windowFrom, to: windowFrom + 10000 };
const caused = { first: false, countDelta: 2, added: 2, removed: 0, changed: 1, from: windowFrom, to: windowFrom + 30000, timeDelta: 5000,
  changes: [
    { name: 'src/a.js', kind: 'change', mtime: windowFrom + 5000 },
    { name: 'src/b.js', kind: 'add', mtime: windowFrom + 6000 },
    { name: 'src/c.js', kind: 'add', mtime: windowFrom + 120000 },
  ] };
const split = attributeDiff(caused, [inWindow], { dshWeight: 0.1, dshGraceMs: 20000 });
check('a change whose mtime falls in a DSH window is attributed to DSH', split.dsh.added === 1 && split.dsh.changed === 1);
check('a change outside every window is attributed to the user', split.user.added === 1 && split.user.changed === 0);
check('the effective counts are the user counts plus the discounted DSH counts', Math.abs(split.effective.added - (1 + 0.1 * 1)) < 1e-9 && Math.abs(split.effective.changed - 0.1) < 1e-9);
const dshOnly = attributeDiff(caused, [{ root: snap1.root, from: windowFrom, to: windowFrom + 200000 }], { dshWeight: 0.1, dshGraceMs: 0 });
check('with every change inside a turn, almost nothing is left for the user', dshOnly.user.added === 0 && dshOnly.effective.countDelta <= 0.3 + 1e-9);
check('the weight is what decides, and it is bounded to 0..1', attributeDiff(caused, [inWindow], { dshWeight: 5 }).weight === 1 && attributeDiff(caused, [inWindow], { dshWeight: -2 }).weight === 0);
const asUser = scoreDiff(attributeDiff(caused, [], { dshWeight: 0.1 }).effective, {}, 30 * 60000);
const asDsh = scoreDiff(attributeDiff(caused, [{ root: snap1.root, from: 0, to: windowFrom + 200000 }], { dshWeight: 0.1, dshGraceMs: 0 }).effective, {}, 30 * 60000);
check('the same edits score far lower when a DSH turn explains them', asDsh.score < asUser.score / 3);

// ---- evaluation across workspaces --------------------------------------------------------
const empty = path.join(root, 'empty');
fs.mkdirSync(empty, { recursive: true });
fs.writeFileSync(path.join(workspace, 'src', 'extra.js'), 'SECRET_MARKER');
// snap1 was taken at depth 3, so the comparison must be made at depth 3 as well: a different walk shape
// is a baseline (see the shape section below), not a diff.
const evaluated = evaluateWorkspaces({ roots: [workspace, empty], previous: { [snap1.root]: snap1 }, settings: { threshold: 0.05, depth: 3 }, at: 2000 });
check('every workspace is snapshotted and diffed in one pass', evaluated.perWorkspace.length === 2 && evaluated.snapshots[snap1.root]?.count === 4);
check('a quieter workspace cannot add its score to a noisier one', Math.abs(evaluated.score - Math.max(...evaluated.perWorkspace.map((entry) => entry.score))) < 1e-9);
check('the description states facts about counts and names, never content', /新增 1/.test(evaluated.description) && !evaluated.description.includes('SECRET_MARKER'));

// ---- the companion half: start-up comparison, persistence, one proactive response --------
const mateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-diff-mate-'));
let clock = 5000000;
const mate = createNewMate({ root: mateRoot, now: () => clock, agents: () => null, tools: { execute: async () => ({ isError: false, value: { ok: true, result: { structured: { notify: false, text: '' } } } }) } });
// The threshold is no longer its own setting: it is derived from the initiative level, and the
// quota-style "N per day" text is gone. That is what the user asked for - one active choice.
// A state file written before the change still carries watchThreshold; it must be dropped, not
// surfaced as a setting nothing reads.
const legacyRoot = path.join(mateRoot, 'legacy-threshold');
fs.mkdirSync(path.join(legacyRoot, 'newMate'), { recursive: true });
fs.writeFileSync(path.join(legacyRoot, 'newMate', 'state.json'), JSON.stringify({ schema: 2, threads: [{ id: 'default', title: 't', created: 1, updated: 1, archived: false }], activeThreadId: 'default', settings: { companion: false, notifications: false, watchThreshold: 0.77 }, messages: [], tasks: [], measurements: {}, lastResponse: 0 }));
const legacyMate = createNewMate({ root: legacyRoot, now: () => clock, agents: () => null, tools: { execute: async () => ({ isError: false, value: {} }) } });
check('a threshold left in an old state file is removed instead of exposed', legacyMate.state().settings.watchThreshold === undefined && legacyMate.watchStatus().threshold === 0.6);
check('the monitor is configurable in settings and its threshold follows the initiative level', mate.state().settings.watchEnabled === true && mate.state().settings.watchIntervalMinutes === 30 && mate.state().settings.watchDepth === MONITOR_DEFAULTS.depth && mate.state().settings.watchThreshold === undefined && mate.watchStatus().threshold === 0.6 && mate.watchStatus().thresholdFromPace === true);
check('nothing is compared while the companion switch is off', mate.sweepWorkspaces([workspace]).skipped === 'companion_off');
await mate.configure({ companion: true, pace: 'active' });
check('the initiative level decides the threshold the sweep uses', mate.watchStatus().threshold === 0.4 && mate.watchStatus().pace === 'active');
const first = mate.sweepWorkspaces([workspace]);
check('the first comparison establishes a baseline and scores nothing', first.score === 0 && first.fired === false && first.workspaces.length === 1 && first.workspaces[0].first === true);
fs.writeFileSync(path.join(workspace, 'src', 'new.js'), 'created');
fs.writeFileSync(path.join(workspace, 'README.md'), 'changed');
fs.writeFileSync(path.join(workspace, 'src', 'a.js'), 'changed again');
// The "active" level needs a threshold of 0.4 of accumulated evidence, so the fixture produces a
// realistic burst (five names) rather than the three that used to be enough for a 0.2 threshold.
fs.writeFileSync(path.join(workspace, 'src', 'b.js'), 'b');
fs.writeFileSync(path.join(workspace, 'src', 'c.js'), 'c');
fs.writeFileSync(path.join(workspace, 'notes.md'), 'notes');
clock += 30 * 60000;
const second = mate.sweepWorkspaces([workspace]);
check('the next comparison sees the real change', second.workspaces[0].added >= 1 && second.workspaces[0].changed >= 2 && second.score > 0);
check('a score above the threshold fires exactly one proactive response', second.fired === true && typeof second.description === 'string' && second.description.length > 0);
// The signal is handed to the initiative gate, which consumes it when it enqueues a check-in: the
// array may therefore already be empty here, and asserting "exactly one" would test the gate's
// appetite rather than the monitor's behaviour. What must hold is that the monitor never leaves two.
check('the fired signal is handed to the initiative gate and never duplicated', mate.state().initiative.signals.filter((signal) => signal.kind === 'workspace-diff').length <= 1);
check('the fired payload carries facts, not a claim about file content', JSON.stringify(second).includes('score') && !JSON.stringify(second).includes('changed again'));
check('the accumulator is reset after firing', mate.watchStatus().acc === 0);
const third = mate.sweepWorkspaces([workspace]);
check('a comparison with no file change does not fire again (quiet time alone stays under the threshold)', third.fired === false && third.fileScore === 0);
check('the status route can say what the monitor is doing', mate.watchStatus().runs === 3 && mate.watchStatus().workspaces.length === 1 && mate.watchStatus().lastRunAt > 0);
// Requirement 1 in earnest: a NEW companion on the same root compares against the persisted snapshot.
const revived = createNewMate({ root: mateRoot, now: () => clock + 1, agents: () => null, tools: { execute: async () => ({ isError: false, value: { ok: true, result: { structured: { notify: false, text: '' } } } }) } });
const startup = revived.sweepWorkspaces([workspace]);
check('a restart compares against the previous run instead of starting blank', startup.workspaces[0].first === false && Array.isArray(revived.watchStatus().workspaces) && revived.watchStatus().workspaces.length === 1);
const invalid = await mate.configure({ watchIntervalMinutes: 1 }).then(() => null).catch((error) => error);
check('an invalid interval is refused rather than clamped silently', invalid instanceof Error && /5–1440/.test(invalid.message));
await mate.configure({ pace: 'quiet', watchIntervalMinutes: 10, watchDepth: 2, watchEnabled: false });
check('the knobs round-trip and the quiet level maps to the strictest threshold', mate.watchStatus().threshold === 0.85 && mate.watchStatus().intervalMinutes === 10 && mate.watchStatus().depth === 2 && mate.watchStatus().enabled === false);
const badWeight = await mate.configure({ watchDshWeight: 2 }).then(() => null).catch((error) => error);
check('an out-of-range DSH weight is refused', badWeight instanceof Error && /0–1/.test(badWeight.message));
await mate.configure({ watchDshWeight: 0.1 });
check('the DSH weight is part of the settings surface and defaults low', mate.watchStatus().dshWeight === 0.1 && MONITOR_DEFAULTS.dshWeight === 0.1);
check('disabled means no comparison at all', mate.sweepWorkspaces([workspace]).skipped === 'disabled');
// A DSH-attributed change must not reach the same score as a user change of the same size.
await mate.configure({ watchEnabled: true, pace: 'active', watchDshWeight: 0.05 });
// The depth changed above (6 -> 2), which makes the next pass a BASELINE by design (a sample taken
// through a different window is not comparable). One pass re-establishes it, so the two scores below
// measure the same shape.
mate.sweepWorkspaces([workspace]);
fs.writeFileSync(path.join(workspace, 'src', 'agent.js'), 'written by the agent');
const dshSweep = mate.sweepWorkspaces([workspace]);
const userScore = dshSweep.fileScore;
// The fixture clock is a small synthetic number while mtimes are real wall-clock times, so the
// window is recorded on the same clock the files carry. That is a property of the TEST, not of the
// monitor: in the host both come from Date.now().
mate.noteDshActivity([workspace], Date.now());
fs.writeFileSync(path.join(workspace, 'src', 'agent2.js'), 'written by the agent again');
clock += 30 * 60000;
const attributedSweep = mate.sweepWorkspaces([workspace]);
check('a change recorded inside a DSH turn is reported as DSH-caused', (attributedSweep.workspaces[0].dsh?.added || 0) >= 1);
check('the DSH-attributed change scores lower than the same size of user change', attributedSweep.fileScore < userScore, JSON.stringify({ userScore, attributed: attributedSweep.fileScore, user: attributedSweep.workspaces[0] && attributedSweep.workspaces[0].user, dsh: attributedSweep.workspaces[0] && attributedSweep.workspaces[0].dsh, rebased: attributedSweep.workspaces[0] && attributedSweep.workspaces[0].rebased }));
check('the sweep never claims to know who wrote a file, only when it was written', !JSON.stringify(attributedSweep).includes('written by the agent'));


// ---- the change BRIEF: read the overview, then summarise it -------------------------------
/**
 * The user's proactive instruction has three steps, and these are the first two: survey what changed
 * in the trusted workspaces, then turn the survey into a reading order. Both are pure functions here,
 * so "what would it have seen" is reproducible without a clock, a filesystem or a model.
 */
check('a changed path is classified by name and extension only, never by opening it',
  classifyPath('README.md') === 'docs' && classifyPath('src/app.ts') === 'code' && classifyPath('package.json') === 'config'
  && classifyPath('tests/thing.js') === 'test' && classifyPath('assets/logo.png') === 'asset' && classifyPath('data/rows.csv') === 'data'
  && classifyPath('LICENSE') === 'docs' && classifyPath('Makefile') === 'other');
check('the overview groups by the changed file\'s own directory', directoryOf('src/deep/a.ts') === 'src/deep' && directoryOf('a.ts') === '.');

const digestChanges = [
  { name: 'src/a.js', kind: 'add', mtime: 3000 },
  { name: 'README.md', kind: 'change', mtime: 2000 },
  { name: 'docs/old.md', kind: 'remove', mtime: 0 },
  { name: 'src/deep/b.ts', kind: 'add', mtime: 1000 },
];
const digestSurvey = surveyChanges([{ root: path.join(root, 'app'), added: 2, removed: 1, changed: 1, countDelta: 1, timeDelta: 1000, first: false, dsh: { added: 0, removed: 0, changed: 0 }, user: { added: 2, removed: 1, changed: 1 }, dshWeight: 0.1, changes: digestChanges }], { at: 10000, stat: () => 1234 });
check('every changed file is carried with its kind, age and size', digestSurvey.workspaces[0].files.length === 4 && digestSurvey.workspaces[0].files.every((file) => file.kind && typeof file.at === 'number' && (file.change === 'remove' ? file.bytes === null : typeof file.bytes === 'number')));
check('the newest change is listed first', digestSurvey.workspaces[0].files[0].name === 'src/a.js');
check('a removal carries no size, because there is no file left to measure', digestSurvey.workspaces[0].files.find((file) => file.change === 'remove').bytes === null);
check('the directory roll-up counts every change, not just the sample', digestSurvey.workspaces[0].dirs.find((dir) => dir.directory === 'src').added === 1 && digestSurvey.workspaces[0].dirs.find((dir) => dir.directory === 'src/deep').added === 1 && digestSurvey.workspaces[0].dirs.length === 4);
check('the kind roll-up says what sort of work moved', digestSurvey.workspaces[0].byKind.code === 2 && digestSurvey.workspaces[0].byKind.docs === 2);
const boundedSurvey = surveyChanges([{ root: path.join(root, 'app'), changes: digestChanges }], { at: 10000, stat: () => 1, limits: { maxFiles: 2 } });
check('a bounded sample states how many names it left out instead of reading as a small change', boundedSurvey.workspaces[0].files.length === 2 && boundedSurvey.truncated.files === 2 && boundedSurvey.workspaces[0].omittedFiles === 2);

const digestText = summariseChanges(digestSurvey, { now: 10000 });
check('the summary names the project, the directory roll-up and the kinds', digestText.includes('app：新增 2') && digestText.includes('目录：') && digestText.includes('其中 代码 2') && digestText.includes('文档 2'));
check('the summary is deterministic: the same survey reads the same way twice', digestText === summariseChanges(digestSurvey, { now: 10000 }));
const tinyText = summariseChanges(digestSurvey, { now: 10000, maxChars: 160 });
check('a tight character budget drops the file list first and still states the project and the counts', tinyText.length <= 160 && tinyText.includes('app：新增 2') && !tinyText.includes('文件：'));
check('the brief states its own age, so a late reader cannot mistake it for this minute', digestText.includes('扫描于') && digestText.includes('距现在'));
check('an empty survey renders no brief at all', digestBlock(null) === null && digestBlock({ at: 1, workspaces: [] }) === null);
check('a survey older than the bound is marked stale rather than presented as news', digestBlock(digestSurvey, { now: 10000 + DIGEST_DEFAULTS.maxAgeMs + 1 }).stale === true && digestBlock(digestSurvey, { now: 10000 + 60000 }).stale === false);

// The companion half: the survey is persisted with the monitor state and survives a quiet pass.
{
  const briefRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-diff-brief-'));
  const briefWs = path.join(briefRoot, 'ws');
  fs.mkdirSync(path.join(briefWs, 'src'), { recursive: true });
  fs.writeFileSync(path.join(briefWs, 'src', 'kept.js'), 'x');
  let clock = 9000000;
  const briefMate = createNewMate({ root: path.join(briefRoot, 'root'), now: () => clock, agents: () => null, tools: { execute: async () => ({ results: [] }) } });
  await briefMate.configure({ companion: true, pace: 'active' });
  briefMate.sweepWorkspaces([briefWs]);
  fs.writeFileSync(path.join(briefWs, 'src', 'one.js'), 'PRIVATE-BODY');
  fs.writeFileSync(path.join(briefWs, 'src', 'two.js'), 'PRIVATE-BODY');
  fs.writeFileSync(path.join(briefWs, 'NOTES.md'), '# notes');
  clock += 6 * 60000;
  const surveyed = briefMate.sweepWorkspaces([briefWs]);
  check('a pass that moves the score also stores the survey it was measured from', surveyed.brief.surveyed === true && surveyed.brief.files >= 3 && surveyed.brief.chars > 0);
  const stored = briefMate.state().watch.digest.workspaces[0];
  check('the stored survey carries names and kinds, and no file content at all', stored.files.some((file) => file.name === 'src/one.js') && !JSON.stringify(stored).includes('PRIVATE-BODY'));
  check('the monitor status exposes the survey as data, with its age', briefMate.watchStatus().brief.at > 0 && briefMate.watchStatus().brief.stale === false && briefMate.watchStatus().brief.files >= 3);
  clock += 30 * 60000;
  const quietPass = briefMate.sweepWorkspaces([briefWs]);
  check('a pass with nothing to survey keeps the previous overview instead of erasing it', quietPass.brief.surveyed === false && briefMate.watchStatus().brief.at > 0 && briefMate.state().watch.digest.workspaces[0].files.length > 0);
  briefMate.stop();
}


// ---- visibility: own budget per workspace, recency decides what a short budget sees -----------
/**
 * Measured 2026-11-23, and this is why the defaults moved: depth 3 could not reach
 * <project>/<pkg>/<lib>/<file>; the directory budget was spent breadth-first, so which project was
 * visible depended on filesystem order; and a nested workspace was collapsed into its parent, where it
 * had ZERO files in the snapshot while the brief said "新增 0".
 */
check('the defaults were raised: depth 6, 512 directories, 4096 files, each reported when hit',
  MONITOR_DEFAULTS.depth === 6 && MONITOR_DEFAULTS.maxDirectories === 512 && MONITOR_DEFAULTS.maxFiles === 4096 && MONITOR_DEFAULTS.branchShare === 0.25);
{
  const visRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-diff-vis-'));
  fs.mkdirSync(path.join(visRoot, 'proj', 'src', 'lib', 'leaf'), { recursive: true });
  fs.writeFileSync(path.join(visRoot, 'proj', 'src', 'lib', 'leaf', 'deep.js'), 'x');
  const at6 = scanWorkspace(visRoot, { at: 1000, depth: 6 });
  const at3 = scanWorkspace(visRoot, { at: 1000, depth: 3 });
  check('depth 6 reaches code at <project>/<pkg>/<lib>/<sub>/<file>', Object.keys(at6.files).includes('proj/src/lib/leaf/deep.js'));
  check('and depth 3 is the blind spot it replaced: the same file is out of reach', !Object.keys(at3.files).includes('proj/src/lib/leaf/deep.js'));

  fs.mkdirSync(path.join(visRoot, 'cold'), { recursive: true });
  fs.mkdirSync(path.join(visRoot, 'hot'), { recursive: true });
  fs.writeFileSync(path.join(visRoot, 'cold', 'c.js'), 'c');
  fs.writeFileSync(path.join(visRoot, 'hot', 'h.js'), 'h');
  // The heat values are real mtimes (same epoch as the directories'), so the fixture uses a real clock:
  // a synthetic small number would rank below every directory's own mtime and prove nothing.
  const heat = new Map([['hot', Date.now() + 60_000]]);
  const short = scanWorkspace(visRoot, { at: Date.now(), depth: 2, maxDirectories: 2, heat });
  check('a short budget is spent on the branch that moved last time, not on filesystem order', Object.keys(short.files).includes('hot/h.js') && !Object.keys(short.files).includes('cold/c.js'));
  check('and what the cap left out is reported, never silently dropped', short.truncated.directories >= 1 && short.coverage.omittedDirectories >= 1);

  const carveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-diff-carve2-'));
  const parent = path.join(carveRoot, 'parent');
  const child = path.join(parent, 'child');
  fs.mkdirSync(path.join(parent, 'own'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(parent, 'own', 'p.js'), 'p');
  fs.writeFileSync(path.join(child, 'c.js'), 'c');
  const first = evaluateWorkspaces({ roots: [parent, child], previous: {}, settings: { threshold: 0.05 }, at: 1000 });
  check('a nested workspace and its parent are BOTH monitored, each as itself', first.perWorkspace.length === 2 && first.perWorkspace.some((entry) => entry.root === child));
  const parentEntry = first.perWorkspace.find((entry) => entry.root === parent);
  const childEntry = first.perWorkspace.find((entry) => entry.root === child);
  check('the parent does not count the child\'s files as its own', Object.keys(first.snapshots[parent].files).join(',') === 'own/p.js' && Object.keys(first.snapshots[child].files).join(',') === 'c.js');
  check('each snapshot states its own coverage', parentEntry.coverage.sampledFiles === 1 && childEntry.coverage.sampledFiles === 1 && parentEntry.coverage.skippedWorkspaces === 1);
  fs.writeFileSync(path.join(child, 'c.js'), 'changed');
  fs.writeFileSync(path.join(child, 'new.js'), 'n');
  const second = evaluateWorkspaces({ roots: [parent, child], previous: first.snapshots, settings: { threshold: 0.05 }, at: 5000 });
  const secondParent = second.perWorkspace.find((entry) => entry.root === parent);
  const secondChild = second.perWorkspace.find((entry) => entry.root === child);
  check('a change in the nested workspace is seen there and not double counted in the parent', secondChild.changed === 1 && secondChild.added === 1 && secondParent.changed === 0 && secondParent.added === 0);
  fs.rmSync(carveRoot, { recursive: true, force: true });
  fs.rmSync(visRoot, { recursive: true, force: true });
}

// ---- what the brief says about a partial or quiet view ---------------------------------------
{
  const quiet = { root: path.join(root, 'quiet-ws'), name: 'quiet-ws', added: 0, removed: 0, changed: 0, countDelta: 0, timeDelta: 0, dirs: [], files: [], byKind: { code: 0 }, coverage: { directories: 40, omittedDirectories: 0, sampledFiles: 90 } };
  const partialEntry = { root: path.join(root, 'big-ws'), name: 'big-ws', added: 3, removed: 1, changed: 0, countDelta: 2, timeDelta: 60000, dirs: [], files: [{ name: 'src/a.js', change: 'add', kind: 'code', at: 9000, bytes: 10 }], byKind: { code: 3 }, coverage: { directories: 512, omittedDirectories: 481, sampledFiles: 4096, omittedFiles: 5135 } };
  const text = summariseChanges({ at: 10000, workspaces: [quiet, partialEntry] }, { now: 10000 });
  check('a workspace with nothing to describe is counted, not given a line of its own', text.includes('另有 1 个可信工作区本次没有变动') && !/quiet-ws：/.test(text));
  check('a partly walked workspace says so in the brief, so "0 changes" cannot be read as "nothing happened"', text.includes('big-ws') && text.includes('这次只走了 512 个目录') && text.includes('还有 481 个目录没走'));
  const quietPartial = { ...quiet, name: 'quiet-partial', coverage: { directories: 512, omittedDirectories: 300, sampledFiles: 4096, omittedFiles: 0 } };
  const allQuiet = summariseChanges({ at: 10000, workspaces: [quietPartial] }, { now: 10000 });
  check('when every workspace is quiet the brief says it once, and flags a partial walk as the reason it may be wrong', allQuiet.includes('本次都没有可描述的变动') && allQuiet.includes('部分遍历'));
  const complete = summariseChanges({ at: 10000, workspaces: [quiet] }, { now: 10000 });
  check('and a complete walk with no changes does not hedge', complete.includes('本次都没有可描述的变动') && !complete.includes('部分遍历'));
  check('digestBlock carries the partial flag for callers that need to weigh the overview', digestBlock({ at: 10000, workspaces: [partialEntry] }, { now: 10000 }).partial === true && digestBlock({ at: 10000, workspaces: [quiet] }, { now: 10000 }).partial === false);
}


// ---- a changed window is not a changed file ------------------------------------------------
{
  const shapeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-diff-shape-'));
  fs.mkdirSync(path.join(shapeRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(shapeRoot, 'src', 'a.js'), 'a');
  const shallow = scanWorkspace(shapeRoot, { at: 1000, depth: 2 });
  fs.writeFileSync(path.join(shapeRoot, 'src', 'b.js'), 'b');
  const sameShape = evaluateWorkspaces({ roots: [shapeRoot], previous: { [shapeRoot]: shallow }, settings: { depth: 2 }, at: 2000 });
  check('a change is a change while the walk parameters hold', sameShape.perWorkspace[0].added === 1 && sameShape.perWorkspace[0].rebased === false);
  const wider = evaluateWorkspaces({ roots: [shapeRoot], previous: { [shapeRoot]: shallow }, settings: { depth: 5 }, at: 2000 });
  check('a snapshot taken at a different depth is a BASELINE, not a difference', wider.perWorkspace[0].rebased === true && wider.perWorkspace[0].first === true && wider.perWorkspace[0].added === 0);
  const snapshotShape = Object.keys(wider.snapshots[shapeRoot]).includes('scanVersion') && wider.snapshots[shapeRoot].scanShape.depth === 5;
  check('the snapshot records the shape it was taken under, which is what makes that judgement possible', snapshotShape);
  const briefText = summariseChanges({ at: 2000, workspaces: [{ name: 'shape', added: 3, removed: 1, changed: 0, first: false, rebased: true, dirs: [], files: [], byKind: {} }] }, { now: 2000 });
  check('and a rebaselined workspace is not announced as a change in the brief', briefText.includes('重新建立了基线') && !briefText.includes('新增 3'));
  fs.rmSync(shapeRoot, { recursive: true, force: true });
}


// ---- a rebase must replace the stored overview, not preserve an incomparable one --------------
{
  const rebaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-diff-rebase-'));
  const ws = path.join(rebaseRoot, 'ws');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'a.js'), 'a');
  let clock = 7000000;
  const rebaseMate = createNewMate({ root: path.join(rebaseRoot, 'root'), now: () => clock, agents: () => null, tools: { execute: async () => ({ results: [] }) } });
  await rebaseMate.configure({ companion: true, pace: 'active', watchDepth: 1 });
  rebaseMate.sweepWorkspaces([ws]);
  fs.writeFileSync(path.join(ws, 'src', 'b.js'), 'b');
  clock += 5 * 60000;
  const changedPass = rebaseMate.sweepWorkspaces([ws]);
  check('with an unchanged window a real change still produces a survey', changedPass.brief.surveyed === true);
  await rebaseMate.configure({ watchDepth: 4 });
  clock += 5 * 60000;
  const rebasePass = rebaseMate.sweepWorkspaces([ws]);
  check('changing the window reports a rebase, not a change', rebasePass.fired === false || rebasePass.brief.surveyed === false);
  const afterRebase = rebaseMate.watchStatus().brief;
  check('and the stored overview is replaced, so the previous (incomparable) numbers cannot be quoted again', rebaseMate.state().watch.digest.workspaces.every((entry) => entry.rebased === true || entry.files.length === 0));
  check('the status still says when the stored overview was taken', typeof afterRebase.at === 'number' && afterRebase.at === clock);
  rebaseMate.stop();
  fs.rmSync(rebaseRoot, { recursive: true, force: true });
}

console.log('SUMMARY passed=' + checks + ' failed=0 total=' + checks);
// The umbrella gate judges a child by a verdict LINE (`PASS`), not by a substring or by exit 0
// alone: measured 2026-11-23, this gate exited 0 here and the umbrella still called it "exited 0
// without printing a verdict", so its 69 green assertions counted as one red.
console.log('PASS ' + checks + ' workspace monitor, change survey and brief checks');
