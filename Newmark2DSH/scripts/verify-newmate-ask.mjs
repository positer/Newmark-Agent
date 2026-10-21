import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewMate, newMateRunTools, NEWMATE_RUN_TOOLS, NEWMATE_REQUEST_TOOLS } from '../packages/newmark-core/components/newmate/component.js';
import { createAskTool, NEWMATE_ASK_TOOL, ASK_MIN_OPTIONS, ASK_MAX_OPTIONS } from '../packages/newmark-core/components/newmate/lib/ask.js';

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('ok ' + passed + ' - ' + name); }
  else { failed += 1; console.log('not ok ' + (passed + failed) + ' - ' + name + (detail ? ' :: ' + detail : '')); }
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-ask-'));
const tools = { size: 0, get: () => undefined, execute: async () => ({ isError: false, value: {} }) };
const mate = createNewMate({ root, now: () => Date.now(), agents: () => null, tools });
const tool = createAskTool(mate);
const fresh = () => new AbortController();

check('the ask tool is in the NewMate group and is request-bound', NEWMATE_RUN_TOOLS.includes(NEWMATE_ASK_TOOL) && NEWMATE_REQUEST_TOOLS.includes(NEWMATE_ASK_TOOL));
check('a user turn is offered the ask tool and an autonomous check-in is not', newMateRunTools({}).includes(NEWMATE_ASK_TOOL) && !newMateRunTools({ automatic: true }).includes(NEWMATE_ASK_TOOL));
check('the tool schema names the question and 2..6 described options', tool.name === NEWMATE_ASK_TOOL && tool.parameters.required.join(',') === 'question,options' && tool.parameters.properties.options.minItems === ASK_MIN_OPTIONS && tool.parameters.properties.options.maxItems === ASK_MAX_OPTIONS);

const invalid = async (args) => (await tool.execute(args, { signal: fresh().signal })).code;
check('one option is refused by name', await invalid({ question: 'q', options: [{ label: 'A' }] }) === 'invalid_question');
check('seven options are refused by name', await invalid({ question: 'q', options: Array.from({ length: 7 }, (_, i) => ({ label: '标' + i })) }) === 'invalid_question');
check('an empty question is refused by name', await invalid({ question: '  ', options: [{ label: 'A' }, { label: 'B' }] }) === 'invalid_question');
check('duplicate option labels are refused by name', await invalid({ question: 'q', options: [{ label: 'A' }, { label: 'A' }] }) === 'invalid_question');
check('refused questions leave nothing pending', mate.pendingQuestion() === null);

const answerChoice = tool.execute({ question: '选哪个方向？', options: [{ label: '先做页面', description: '可见优先' }, { label: '先做内核' }] }, { signal: fresh().signal });
const pending = mate.pendingQuestion();
check('a valid question is exposed to the page while the run waits', pending && pending.question === '选哪个方向？' && pending.options.length === 2 && pending.options[0].description === '可见优先' && pending.allowsManual === true);
check('a second question cannot overlap the first', (await tool.execute({ question: 'again', options: [{ label: 'A' }, { label: 'B' }] }, { signal: fresh().signal })).code === 'question_already_pending');
check('choosing an option resolves the blocked call with that label', (() => { const r = mate.answerQuestion({ id: pending.id, label: '先做页面' }); return r.ok === true && r.answer.label === '先做页面'; })());
const chosen = await answerChoice;
check('the tool result is the chosen label and the question is gone', chosen.ok === true && chosen.answer.label === '先做页面' && mate.pendingQuestion() === null);

const answerManual = tool.execute({ question: '还有别的吗？', options: [{ label: '有' }, { label: '没有' }] }, { signal: fresh().signal });
const manualPending = mate.pendingQuestion();
check('a manual answer resolves the same blocked call with its text', (() => { const r = mate.answerQuestion({ id: manualPending.id, text: '  先确认一下  ' }); return r.ok === true && r.answer.text === '先确认一下'; })());
check('the manual answer is what the tool returns', (await answerManual).answer.text === '先确认一下');

const answerAbort = tool.execute({ question: '会被取消吗？', options: [{ label: '会' }, { label: '不会' }] }, { signal: (() => { const controller = fresh(); setTimeout(() => controller.abort(), 2); return controller.signal; })() });
check('an aborted run resolves the question as aborted, not as an answer', (await answerAbort).code === 'question_aborted' && mate.pendingQuestion() === null);
check('an unknown question id cannot answer anything', mate.answerQuestion({ id: 'missing', label: 'x' }).ok === false);

const stopped = tool.execute({ question: '会随 Companion 停止吗？', options: [{ label: '会' }, { label: '不会' }] }, { signal: fresh().signal });
mate.stop();
check('stopping the companion settles a waiting question as aborted', (await stopped).code === 'question_aborted' && mate.pendingQuestion() === null);

const indexSource = fs.readFileSync(new URL('../packages/newmark-core/components/newmate/index.js', import.meta.url), 'utf8');
const clientSource = fs.readFileSync(new URL('../packages/newmark-core/client.js', import.meta.url), 'utf8');
const persona = fs.readFileSync(new URL('../packages/newmark-core/components/newmate/lib/persona.js', import.meta.url), 'utf8');
check('the mounted row registers the ask tool and publishes the pending question', indexSource.includes('createAskTool(mate)') && indexSource.includes('question:mate.pendingQuestion()') && indexSource.includes("case 'answer-question'"));
check('the page draws the option block and posts the answer', clientSource.includes("className:'nm-question'") && clientSource.includes("className:'nm-option'") && clientSource.includes("action:'answer-question'") && clientSource.includes('renderQuestion(state.question)'));
check('the persona states the ask boundary', persona.includes('newmate_ask') && persona.includes('2–6'));

try { mate.stop(); } catch {}
console.log('\nSUMMARY passed=' + passed + ' failed=' + failed + ' total=' + (passed + failed));
if (failed) process.exitCode = 1;
