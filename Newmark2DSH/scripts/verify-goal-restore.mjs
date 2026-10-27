/**
 * verify-goal-restore — the plugin's one goal mutation, offline.
 *
 * The host refuses update_goal{action:"resume"} outside a direct human turn, so a restart
 * continuation could never re-arm a goal (measured live: the resumed conversation hit "requires a
 * direct human turn on a top-level agent" every time). goal_restore asks the goal service directly
 * and is deliberately narrow: resume a paused goal or re-arm a disarmed active one, never rewrite,
 * never un-block, never touch another conversation.
 *
 * This gate holds every one of those refusals against a fake service that records EVERY call, so
 * "it only calls resume" is measured rather than asserted in prose.
 *
 * Run: node scripts/verify-goal-restore.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTINUATION_GOAL_POLICY, CONTINUATION_PROMPT, createHeartBeat } from '../packages/newmark-core/components/heartbeat/component.js';

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });

/* A goal service that records every mutation a caller could possibly make. */
function fakeGoals(initial, options = {}) {
  const calls = { get: 0, resume: 0, edit: 0, create: 0, block: 0, pause: 0, disarm: 0 };
  let goal = initial ? { ...initial } : null;
  const service = {
    calls,
    get() { calls.get += 1; return goal ? { ...goal } : null; },
    resume(_agent, ref) {
      calls.resume += 1;
      if (options.throwOnResume) throw Error('goal resume has an invalid phase transition');
      if (!options.noop && goal) goal = { ...goal, phase: 'active', activation: 'armed', revision: goal.revision + 1, ref };
      return goal ? { ...goal } : null;
    },
    edit() { calls.edit += 1; throw Error('edit must never be called'); },
    create() { calls.create += 1; throw Error('create must never be called'); },
    block() { calls.block += 1; throw Error('block must never be called'); },
    pause() { calls.pause += 1; throw Error('pause must never be called'); },
    disarm() { calls.disarm += 1; throw Error('disarm must never be called'); },
  };
  return service;
}

function beatWith(goals) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-goal-restore-'));
  const beat = createHeartBeat({
    root,
    core: () => null,
    agents: () => null,
    goals: () => goals,
    controller: { prepare: async () => ({ ticket: 'x' }), restart: async () => ({ commit() {}, cancel() {} }) },
    probe: async () => ({ path: 'fixture', created: 1 }),
    pid: 4242,
    version: '0.0.0-fixture',
    logger: { warn() {}, info() {}, error() {} },
    now: () => 1793119000000,
  });
  return beat;
}

const agent = { session: { id: 'session-fixture' } };
const goal = (over) => ({ id: 'goal-1', revision: 7, phase: 'paused', activation: 'disarmed', roundsStarted: 3, maxGoalRounds: 10, objective: 'fixture objective', ...over });

/* ============================================================ the restore ==== */
const paused = fakeGoals(goal());
const restored = await beatWith(paused).restoreGoal({ agent });
check('paused: the paused goal is resumed', restored.ok === true && restored.code === 'restored' && restored.changed === true, JSON.stringify(restored).slice(0, 220));
check('paused: the ref names the exact goal and revision it read', paused.calls.resume === 1 && paused.calls.get >= 2, JSON.stringify(paused.calls));
check('paused: the receipt says which mode it was', restored.mode === 'paused_goal_resumed' && restored.action_taken === 'resume');
check('paused: it reports the state it found and the state it verified', restored.before?.phase === 'paused' && restored.after?.phase === 'active' && restored.verified === true, JSON.stringify({ before: restored.before, after: restored.after }));
check('paused: nothing but resume was called', paused.calls.edit === 0 && paused.calls.create === 0 && paused.calls.block === 0 && paused.calls.pause === 0 && paused.calls.disarm === 0, JSON.stringify(paused.calls));

const disarmed = fakeGoals(goal({ phase: 'active', activation: 'disarmed' }));
const rearmed = await beatWith(disarmed).restoreGoal({ agent });
check('disarmed: an active goal the host disarmed is re-armed', rearmed.ok === true && rearmed.code === 'rearmed' && rearmed.mode === 'disarmed_goal_rearmed', JSON.stringify(rearmed).slice(0, 200));
check('disarmed: it still only calls resume', disarmed.calls.resume === 1 && disarmed.calls.edit === 0 && disarmed.calls.block === 0);

const armed = fakeGoals(goal({ phase: 'active', activation: 'armed' }));
const running = await beatWith(armed).restoreGoal({ agent });
check('running: an armed goal is left alone and reported as unchanged', running.ok === true && running.code === 'not_restorable' && running.changed === false && armed.calls.resume === 0, JSON.stringify(running).slice(0, 200));

/* =========================================================== the refusals ==== */
const blocked = fakeGoals(goal({ phase: 'blocked', activation: 'armed' }));
const blockedAnswer = await beatWith(blocked).restoreGoal({ agent });
check('blocked: a blocked goal is refused by name and NOT revived', blockedAnswer.ok === false && blockedAnswer.code === 'goal_blocked' && blocked.calls.resume === 0, JSON.stringify(blockedAnswer).slice(0, 240));
check('blocked: the refusal says why, in the answer itself', String(blockedAnswer.error).includes('阻断'), String(blockedAnswer.error));

const complete = fakeGoals(goal({ phase: 'complete' }));
const completeAnswer = await beatWith(complete).restoreGoal({ agent });
check('complete: a finished goal is refused, not restarted', completeAnswer.ok === false && completeAnswer.code === 'goal_complete' && complete.calls.resume === 0, JSON.stringify(completeAnswer).slice(0, 200));

const none = fakeGoals(null);
const noGoal = await beatWith(none).restoreGoal({ agent });
check('no goal: answers no_goal without touching the service', noGoal.ok === false && noGoal.code === 'no_goal' && none.calls.resume === 0, JSON.stringify(noGoal).slice(0, 180));

const noService = await beatWith(null).restoreGoal({ agent });
check('no service: answers goal_service_unavailable instead of throwing', noService.ok === false && noService.code === 'goal_service_unavailable', JSON.stringify(noService).slice(0, 180));

const noAgent = await beatWith(fakeGoals(goal())).restoreGoal({});
check('no caller: answers agent_unavailable - it cannot target another conversation', noAgent.ok === false && noAgent.code === 'agent_unavailable', JSON.stringify(noAgent).slice(0, 180));

const throws = fakeGoals(goal(), { throwOnResume: true });
const failed = await beatWith(throws).restoreGoal({ agent });
check('resume throws: reported as resume_failed, not as a crash', failed.ok === false && failed.code === 'resume_failed' && String(failed.error).includes('invalid phase transition'), JSON.stringify(failed).slice(0, 220));

const noop = fakeGoals(goal(), { noop: true });
const unverified = await beatWith(noop).restoreGoal({ agent });
check('resume did not take: ok is false and the code says unverified', unverified.ok === false && unverified.code === 'resume_unverified' && unverified.verified === false, JSON.stringify(unverified).slice(0, 220));

/* ============================================================== the shape ==== */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPONENT = path.join(HERE, '..', 'packages/newmark-core/components/heartbeat/component.js');
const INDEX = path.join(HERE, '..', 'packages/newmark-core/components/heartbeat/index.js');
const componentSource = fs.readFileSync(COMPONENT, 'utf8');
const indexSource = fs.readFileSync(INDEX, 'utf8');
check('shape: the component never calls edit/create/block on the goal service', !/service\.(edit|create|block)\s*\(/.test(componentSource), 'the only mutation is service.resume');
check('shape: the identity comes from the execution, not from an argument', componentSource.includes('const agent = execution?.agent ?? null;') && componentSource.includes('service.resume(agent, ref)'));
const restoreTool = /name: 'goal_restore'[\s\S]{0,1400}?additionalProperties: false/.exec(indexSource);
check('shape: the tool takes no arguments at all', Boolean(restoreTool) && indexSource.includes("name: 'goal_restore'") && indexSource.includes("execute: (a, e) => beat.restoreGoal(e)"), restoreTool ? 'declared' : 'missing');
const restoreParameters = indexSource.slice(indexSource.indexOf("name: 'goal_restore'"), indexSource.indexOf("name: 'goal_restore'") + 1400);
check('shape: the tool cannot be pointed at another conversation or rewrite the goal', restoreParameters.includes("parameters: { type: 'object', properties: {}, additionalProperties: false }") && !/goal_id|session_id|agent_id|max_goal_rounds/.test(restoreParameters.split('parameters:')[1] || ''));
const heartbeatHits = (indexSource.match(/name: '(heartbeat_[a-z_]+)', description: '/g) || []).length;
const hintHits = (indexSource.match(/目标不需要手动设置：本组件在重启前记录/g) || []).length;
check('hint: every heartBeat tool description points at goal_restore', heartbeatHits > 0 && hintHits === heartbeatHits, JSON.stringify({ tools: heartbeatHits, hints: hintHits }));
check('hint: the continuation prompt tells the model to restore through goal_restore', CONTINUATION_PROMPT.includes('goal_restore') && CONTINUATION_PROMPT.includes('不要调用 create_goal') && !CONTINUATION_PROMPT.includes('update_goal{action'), CONTINUATION_PROMPT.slice(0, 200));
check('hint: the policy data and the prompt agree on goal_restore', CONTINUATION_GOAL_POLICY.allowed.includes('goal_restore') && CONTINUATION_GOAL_POLICY.resume_hint.includes('goal_restore'));

const failedChecks = checks.filter((entry) => entry.pass !== true);
for (const entry of checks) console.log((entry.pass ? 'ok   ' : 'not ok ') + entry.name + (entry.pass ? '' : '  [' + entry.detail + ']'));
console.log('');
console.log('goal restore: ' + (checks.length - failedChecks.length) + '/' + checks.length + ' passed');
if (failedChecks.length) { console.log('FAILED: ' + failedChecks.map((entry) => entry.name).join('; ')); process.exit(1); }
console.log('PASS');
