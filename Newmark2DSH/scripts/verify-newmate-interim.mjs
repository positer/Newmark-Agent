/**
 * NewMate — the INTERIM REPLY gate.
 *
 * The requirement (2026-11-24):「newMate新增中间回复，即在loop中途可以输出中间回复，并继续自行loop直到最终回复」.
 * A run used to have one visible output; the loop's progress was only visible as a spinner and a live
 * status line. `newmate_progress` lets the model put a sentence INTO the conversation mid-turn, and the
 * properties that make that safe are what this gate measures:
 *
 *   1. only a turn a person started may speak (an autonomous check-in or a maintenance turn refuses);
 *   2. it is bounded per run (count, length, gap, no repetition) - narration cannot become spam;
 *   3. it is NOT the reply: its id is derived from the task id but never equal to it, which is what
 *      keeps `forwardReplies` (WeChat) and the todo settlement pointed at the final answer;
 *   4. the loop keeps going: the final answer is still the run's output.
 *
 * Run: node Newmark2DSH/scripts/verify-newmate-interim.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewMate, NEWMATE_RUN_TOOLS } from '../packages/newmark-core/components/newmate/component.js';
import { interimDefinition, NEWMATE_INTERIM_TOOL, INTERIM_MAX_CHARS, INTERIM_MAX_PER_RUN } from '../packages/newmark-core/components/newmate/lib/interim.js';
import { newMateContext, withNewMateContext } from '../packages/newmark-core/lib/newmate-context.js';
import { hostTools } from './lib/host-call.mjs';

let checks = 0;
const check = (label, value, detail) => {
  if (value) { checks += 1; console.log('ok ' + checks + ' - ' + label); return true; }
  console.log('not ok ' + (checks + 1) + ' - ' + label);
  if (detail !== undefined) console.log('  ' + detail);
  process.exitCode = 1;
  return false;
};
const guard = () => { if (process.exitCode) { console.log('SUMMARY passed=' + checks + ' failed=1'); process.exit(process.exitCode); } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-interim-'));
const clock = Date.parse('2026-11-24T02:00:00Z');
const now = () => clock;

check('the tool is part of NewMate\'s own run group', NEWMATE_RUN_TOOLS.includes(NEWMATE_INTERIM_TOOL));
check('the bounds are the ones the description promises', INTERIM_MAX_CHARS === 240 && INTERIM_MAX_PER_RUN === 3);

/* ------------------------------------------------ a chat turn may speak mid-loop --- */

let mate,
  calls = [],
  bubbles = [];
const tool = () => interimDefinition({ services: { mate: () => mate } });
const tools = hostTools(async (call) => {
  if (call.name !== 'agent_api_send') return { isError: false, value: { ok: true } };
  const speak = tool();
  // The model writes both renderings, like it already does for the final answer.
  const first = await speak.execute({ text: '**已经看完目录结构**，接下来核对最近的提交。', plain: '看完目录结构，接着核对最近的提交' });
  calls.push({ step: 'first', result: first, context: newMateContext()?.session?.taskId });
  // The tool is async (it awaits the bubble), so every call has to be awaited before its result is read.
  const again = await speak.execute({ text: '**已经看完目录结构**，接下来核对最近的提交。' });
  calls.push({ step: 'duplicate', result: again });
  const empty = await speak.execute({ text: '   ' });
  calls.push({ step: 'empty', result: empty });
  const long = await speak.execute({ text: 'x'.repeat(INTERIM_MAX_CHARS + 1) });
  calls.push({ step: 'long', result: long });
  return { isError: false, value: { ok: true, result: { output: '结论：仓库里最近动的是 NewMate 的工作区监控。' } } };
});
mate = createNewMate({ root, now, agents: () => null, tools, environment: () => ({ ready: true, idleMs: 120000 }), onNotify: async (message) => { bubbles.push(message); } });
// The bubble goes through notify(), which only speaks while the companion is on; initiative stays off so
// no autonomous check-in can appear in this fixture.
await mate.configure({ companion: true, initiative: false });
mate.chat('帮我看看仓库最近动了什么');
await mate.tick();

const state = mate.state();
const task = state.tasks.find((entry) => entry.kind === 'chat');
const interimMessages = state.messages.filter((message) => message.interim === true);
const finalMessage = state.messages.find((message) => message.id === task.id);
check('a chat turn can publish a sentence while the loop is still running', calls[0].result.ok === true && calls[0].result.id.endsWith(':interim:1'));
check('the sentence is in the conversation, marked as interim and tied to the task', interimMessages.length === 1 && interimMessages[0].text.includes('已经看完目录结构') && interimMessages[0].taskId === task.id && interimMessages[0].threadId === task.threadId);
check('the iteration continues and still ends with the final answer', task.status === 'completed' && finalMessage && finalMessage.text === '结论：仓库里最近动的是 NewMate 的工作区监控。' && finalMessage.interim !== true);
check('the interim message is ordered before the final one', interimMessages[0].at <= finalMessage.at && interimMessages[0].id !== finalMessage.id);
check('the interim id is derived from the task but never equal to it, so the reply is still the reply', interimMessages[0].id === task.id + ':interim:1');
check('the plain rendering is stored beside the rich one, from the model when it supplies it', interimMessages[0].plain === '看完目录结构，接着核对最近的提交' && interimMessages[0].text.includes('**'));
const interimBubble = bubbles.find((bubble) => bubble && bubble.id === interimMessages[0].id);
check('the interim sentence is pushed to the bubble as PLAIN text, not markdown', Boolean(interimBubble) && interimBubble.text === '看完目录结构，接着核对最近的提交' && interimBubble.rich_text === interimMessages[0].text && !interimBubble.text.includes('**'), JSON.stringify(bubbles.map((b) => ({ id: b.id, text: b.text }))));
check('and the final answer keeps its own bubble, so the two are not confused', bubbles.some((bubble) => bubble && bubble.id === finalMessage.id));
check('the bubble is not a proactive message, so it is not mistaken for a check-in outside the chat', interimBubble.proactive !== true);
check('an identical sentence is refused rather than repeated', calls.find((entry) => entry.step === 'duplicate').result.code === 'interim_repeated');
check('an empty sentence is refused', calls.find((entry) => entry.step === 'empty').result.ok === false);
check('a sentence over the bound is refused with the number', calls.find((entry) => entry.step === 'long').result.code === 'interim_too_long');
guard();

/* ------------------------------------------------------------------ the hard bounds --- */

{
  let boundClock = clock;
  let results = [];
  let gapResults = [];
  let boundMate;
  const boundTools = hostTools(async (call) => {
    if (call.name !== 'agent_api_send') return { isError: false, value: { ok: true } };
    const speak = interimDefinition({ services: { mate: () => boundMate } });
    // A real turn's tool calls are seconds apart; the fake clock has to move, or the gap rule (correctly)
    // refuses the second sentence.
    results = [];
    for (const step of [1, 2, 3, 4]) {
      boundClock += 5000;
      results.push(await speak.execute({ text: '第 ' + step + ' 条进展：还在读文件' + '。'.repeat(step) }));
    }
    return { isError: false, value: { ok: true, result: { output: '最终回复' } } };
  });
  let boundedBubbles = [];
  boundMate = createNewMate({ root: path.join(root, 'bounds'), now: () => boundClock, agents: () => null, tools: boundTools, environment: () => ({ ready: true, idleMs: 120000 }), onNotify: async (message) => { boundedBubbles.push(message); } });
  await boundMate.configure({ companion: true, initiative: false });
  boundMate.chat('多步任务');
  await boundMate.tick();
  check('a run may speak at most ' + INTERIM_MAX_PER_RUN + ' times', results.slice(0, INTERIM_MAX_PER_RUN).every((result) => result.ok) && results[INTERIM_MAX_PER_RUN].ok === false && results[INTERIM_MAX_PER_RUN].code === 'interim_limit', JSON.stringify(results.map((r) => r.code || 'ok')));
  check('and the limit names the number it enforced', String(results[INTERIM_MAX_PER_RUN].error).includes(String(INTERIM_MAX_PER_RUN)));
  {
  // Only the interim bubbles: the final answer pushes its own bubble too.
  const interimBubbles = boundedBubbles.filter((bubble) => bubble && bubble.interim === true);
  check('a model that omits the plain rendering still produces one, with no markdown left in it', interimBubbles.length === INTERIM_MAX_PER_RUN && interimBubbles.every((bubble) => bubble.plain && !/[*_#`]/.test(bubble.plain) && bubble.plain.length <= 120), JSON.stringify(interimBubbles.map((b) => b.plain)));
}
  void gapResults;
}
{
  // The gap rule on its own run: two DIFFERENT sentences with the clock standing still.
  let gapClock = clock;
  let gapResults = [];
  let gapMate;
  const gapTools = hostTools(async (call) => {
    if (call.name !== 'agent_api_send') return { isError: false, value: { ok: true } };
    const speak = interimDefinition({ services: { mate: () => gapMate } });
    gapResults = [await speak.execute({ text: '先看目录结构。' }), await speak.execute({ text: '再看一次提交历史。' })];
    return { isError: false, value: { ok: true, result: { output: '最终回复' } } };
  });
  gapMate = createNewMate({ root: path.join(root, 'gap'), now: () => gapClock, agents: () => null, tools: gapTools });
  gapMate.chat('间隔检查');
  await gapMate.tick();
  check('two sentences inside the minimum gap are refused by the gap rule, not the repetition rule', gapResults[0].ok === true && gapResults[1].code === 'interim_too_soon', JSON.stringify(gapResults.map((r) => r.code || 'ok')));
  gapMate.stop();
}

/* ------------------------------------------------- it is not available to a robot --- */

{
  for (const [kind, label] of [['self_activation', 'an autonomous check-in'], ['session_refresh', 'a maintenance turn'], ['todo_activation', 'a scheduled activation']]) {
    let refusal = null;
    let robotMate;
    const seed = path.join(root, 'kind-' + kind);
    fs.mkdirSync(path.join(seed, 'newMate'), { recursive: true });
    const initial = createNewMate({ root: seed, now, agents: () => null, tools: hostTools(async () => ({ isError: false, value: { ok: true } })) });
    const base = initial.state();
    base.settings.companion = true;
    base.settings.initiative = true;
    base.tasks.push({ id: 'task-' + kind, kind, reason: 'file-change', status: 'pending', prompt: '内部任务', destination: 'newmate', threadId: base.activeThreadId, created: clock });
    fs.writeFileSync(path.join(seed, 'newMate', 'state.json'), JSON.stringify(base));
    initial.stop();
    const robotTools = hostTools(async (call) => {
      if (call.name !== 'agent_api_send') return { isError: false, value: { ok: true } };
      refusal = await interimDefinition({ services: { mate: () => robotMate } }).execute({ text: '我先处理一下。' });
      return { isError: false, value: { ok: true, result: kind === 'self_activation' ? { structured: { notify: false, text: '' } } : { output: '' } } };
    });
    robotMate = createNewMate({ root: seed, now, agents: () => null, tools: robotTools, environment: () => ({ ready: true, idleMs: 120000 }) });
    await robotMate.tick();
    check(label + ' cannot speak mid-loop', refusal && refusal.ok === false && refusal.code === 'interim_not_conversational', JSON.stringify(refusal));
    robotMate.stop();
  }
}

/* ---------------------------------------------------------- outside a run, and in the page --- */

{
  const outside = await interimDefinition({ services: { mate: () => ({ interim: () => ({ ok: true }) }) } }).execute({ text: '你好' });
  check('outside a NewMate run the tool refuses instead of publishing anything', outside && outside.code === 'interim_outside_newmate', JSON.stringify(outside));
}
{
  const noService = await withNewMateContext({ session: { id: 's' } }, async () => interimDefinition({}).execute({ text: '在吗' }));
  check('inside a run but with no companion to speak for, it refuses by name', noService && noService.code === 'interim_unavailable', JSON.stringify(noService));
}
const client = fs.readFileSync(new URL('../packages/newmark-core/client.js', import.meta.url), 'utf8');
check('the page marks an interim message instead of passing it off as the answer', client.includes("m.interim&&h('span'") && client.includes('进行中'));


/* ---------------------------------------- a turn that spoke and then died must say so --- */

{
  let deadMate;
  let interimResult = null;
  const deadTools = hostTools(async (call) => {
    if (call.name !== 'agent_api_send') return { isError: false, value: { ok: true } };
    interimResult = await interimDefinition({ services: { mate: () => deadMate } }).execute({ text: '我先查一下，然后给你结论。' });
    throw Error('Connection error. (TRANSPORT)');
  });
  deadMate = createNewMate({ root: path.join(root, 'dies'), now, agents: () => null, tools: deadTools, environment: () => ({ ready: true, idleMs: 120000 }), onNotify: async () => {} });
  await deadMate.configure({ companion: true, initiative: false });
  const started = deadMate.chat('会失败的验收');
  await deadMate.tick();
  const dead = deadMate.state();
  const task = dead.tasks.find((entry) => entry.id === started.id);
  const closing = dead.messages.filter((message) => String(message.id) === String(started.id));
  check('the interim sentence really went out before the failure', interimResult && interimResult.ok === true);
  check('a chat turn that died after speaking ends with ONE runtime sentence instead of a dangling promise', closing.length === 1 && closing[0].runtime === true && closing[0].failed === true && closing[0].text.startsWith('这一轮没有走完'));
  check('the closing sentence names a transport failure in words a person can act on', closing[0] && closing[0].text.includes('连接中断'));
  check('the closing message carries the task id, so it is the answer for the page and the phone', closing[0] && closing[0].id === started.id && closing[0].taskId === started.id);
  check('the task itself is still recorded as failed, with the provider error', task && task.status === 'failed' && /TRANSPORT/.test(String(task.error)));
  deadMate.stop();
}
{
  // The other direction: a failure with NO interim gets no extra sentence - nothing promised anything.
  let quietMate;
  const quietTools = hostTools(async (call) => {
    if (call.name !== 'agent_api_send') return { isError: false, value: { ok: true } };
    throw Error('Connection error. (TRANSPORT)');
  });
  quietMate = createNewMate({ root: path.join(root, 'dies-quiet'), now, agents: () => null, tools: quietTools, environment: () => ({ ready: true, idleMs: 120000 }), onNotify: async () => {} });
  await quietMate.configure({ companion: true, initiative: false });
  const quietStart = quietMate.chat('没有中间回复的失败');
  await quietMate.tick();
  const quietState = quietMate.state();
  check('a failure that never spoke adds no sentence to the conversation', quietState.messages.filter((message) => String(message.id) === String(quietStart.id)).length === 0 && quietState.tasks.find((entry) => entry.id === quietStart.id).status === 'failed');
  quietMate.stop();
}

console.log('');
if (process.exitCode) { console.log('SUMMARY passed=' + checks + ' failed=1'); }
else console.log('SUMMARY passed=' + checks + ' failed=0 total=' + checks);
if (!process.exitCode) console.log('PASS');
