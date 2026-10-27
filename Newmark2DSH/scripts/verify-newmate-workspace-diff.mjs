import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MONITOR_DEFAULTS, enumerateDirectories, scanWorkspace, diffSnapshots, scoreDiff, settle, evaluateWorkspaces, attributeDiff, dedupeRoots } from '../packages/newmark-core/components/newmate/lib/workspace-diff.js';
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
const deduped = dedupeRoots([path.join(root, 'outer', 'inner'), path.join(root, 'outer'), path.join(root, 'sibling'), path.join(root, 'outer', 'inner')]);
check('a root nested inside another is dropped, so the same files are not counted twice', deduped.length === 2 && deduped.includes(path.join(root, 'outer')) && deduped.includes(path.join(root, 'sibling')) && !deduped.includes(path.join(root, 'outer', 'inner')));
check('siblings survive and duplicates collapse', dedupeRoots([path.join(root, 'a'), path.join(root, 'a')]).length === 1);
check('relative paths are never watched', dedupeRoots(['relative/path', '']).length === 0);

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
const evaluated = evaluateWorkspaces({ roots: [workspace, empty], previous: { [snap1.root]: snap1 }, settings: { threshold: 0.05 }, at: 2000 });
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
check('the DSH-attributed change scores lower than the same size of user change', attributedSweep.fileScore < userScore);
check('the sweep never claims to know who wrote a file, only when it was written', !JSON.stringify(attributedSweep).includes('written by the agent'));

console.log('SUMMARY passed=' + checks + ' failed=0 total=' + checks);
