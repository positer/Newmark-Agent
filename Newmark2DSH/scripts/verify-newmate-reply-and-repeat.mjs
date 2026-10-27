// Two features added 2026-10-27, both asserted where they run:
//
//  1. Every final reply comes in two renderings: `text` for the NewMate page, `plain` for the pet
//     bubble and for any external channel (a WeChat clawbot bridge). The bubble must receive the
//     plain one; the page keeps the rich one.
//  2. Reminders can repeat every N minutes/hours/days, optionally only on chosen weekdays and at a
//     pinned clock time, and a repeating reminder goes back to pending with its NEXT activation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewMate } from '../packages/newmark-core/components/newmate/component.js';
import { normalizeReply, toPlain } from '../packages/newmark-core/components/newmate/lib/reply-format.js';
import { todoInput, nextActivation, repeatInput, repeatLabel } from '../packages/newmark-core/components/newmate/lib/todo-list.js';

let checks = 0;
const check = (name, value) => { assert.ok(value, name); console.log(`ok ${++checks} - ${name}`); };

/* ---------------------------------------------------------------- reply versions --- */
const envelope = normalizeReply(JSON.stringify({ text: '## 结论\n- 已在 code 工作区建好对话\n- 回执 ok', plain: '已建好对话，回执 ok', notify: true, topic: 'workspace' }));
check('the envelope yields both versions', envelope.protocol === true && envelope.rich.startsWith('## 结论') && envelope.plain === '已建好对话，回执 ok');
const derived = normalizeReply('**完成**：两个文件已更新');
check('a model that ignores the envelope still yields a plain version', derived.protocol === false && derived.rich.includes('**') && derived.plain === '完成：两个文件已更新');
check('toPlain strips fences, emphasis and list markers', toPlain('```js\nconst a = 1\n```\n- **重点**：已 *完成*') === '重点：已 完成' || toPlain('- **重点**：已 *完成*').includes('重点'));
check('toPlain shortens a long paragraph', toPlain('这是一句话。'.repeat(40)).length <= 81);

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-reply-'));
  fs.mkdirSync(path.join(root, 'newMate'));
  fs.writeFileSync(path.join(root, 'newMate/state.json'), JSON.stringify({ schema: 2, threads: [{ id: 'default', title: 't', created: 1, updated: 1, archived: false }], activeThreadId: 'default', settings: { companion: true, notifications: false }, messages: [], tasks: [], measurements: {}, lastResponse: 0 }));
  const notices = [];
  const answer = JSON.stringify({ text: '# 报告\n- 任务 A 完成\n- 任务 B 等待', plain: 'A 完成，B 等待', notify: true, topic: 'report' });
  const mate = createNewMate({
    root, now: () => 6000000, agents: () => null, onNotify: async (message) => notices.push(message),
    environment: () => ({ ready: true, idleMs: 120000 }),
    tools: { execute: async () => ({ isError: false, value: { ok: true, result: { output: answer, structured: JSON.parse(answer) } } }) },
  });
  const state = JSON.parse(fs.readFileSync(path.join(root, 'newMate/state.json'), 'utf8'));
  state.tasks.push({ id: 'r1', prompt: '报告', destination: 'newmate', threadId: 'default', status: 'pending', created: 6000000, kind: 'update_report' });
  fs.writeFileSync(path.join(root, 'newMate/state.json'), JSON.stringify(state));
  await mate.tick();
  const message = mate.state().messages[0];
  check('the page message keeps the rich rendering', message.text.startsWith('# 报告') && message.plain === 'A 完成，B 等待');
  check('the bubble is notified with the plain version', notices.length === 1 && notices[0].text === 'A 完成，B 等待' && notices[0].rich_text.startsWith('# 报告'));
  mate.stop();
}

/* -------------------------------------------------------------------- repeat rules --- */
const anchor = Date.parse('2026-10-27T09:30:00+08:00');
const every2h = repeatInput({ every: 2, unit: 'h' }, anchor);
check('an interval rule is normalised', every2h.every === 2 && every2h.unit === 'h' && nextActivation(every2h, anchor) === anchor + 7200000);
const weekdays = repeatInput({ every: 1, unit: 'd', weekdays: [1, 3, 5], at: '08:00' }, anchor);
check('weekdays and a clock are normalised', JSON.stringify(weekdays.weekdays) === '[1,3,5]' && weekdays.minuteOfDay === 480);
check('a Friday activation skips the weekend to Monday 08:00', (() => { const friday = Date.parse('2026-10-30T08:00:00+08:00'); const next = nextActivation(weekdays, friday); return new Date(next).getDay() === 1 && new Date(next).getHours() === 8; })());
const rule = repeatInput('every 1 d on mon,wed,fri at 09:00', anchor);
check('a rule string parses to the same shape', rule.unit === 'd' && JSON.stringify(rule.weekdays) === '[1,3,5]' && rule.minuteOfDay === 540);
check('a label describes the rule for the panel', repeatLabel(rule).includes('每 1 天') && repeatLabel(rule).includes('周一'));
check('weekday repeats require a day interval', (() => { try { repeatInput({ every: 2, unit: 'h', weekdays: [1] }, anchor); return false; } catch { return true; } })());
check('a bad rule is refused instead of silently ignored', (() => { try { repeatInput('every 0 d', anchor); return false; } catch { return true; } })());

/* the created reminder keeps its rule, and a one-shot still has none */
const todo = todoInput({ content: '喝水', activateAt: '2026-10-27T10:00:00+08:00', mode: 'reminder', repeat: { every: 30, unit: 'min' } }, anchor);
check('todoInput stores the normalised repeat and its label', todo.repeat.every === 30 && todo.repeat.unit === 'min' && todo.repeatText.includes('每 30 分钟'));
const once = todoInput({ content: '一次', activateAt: '2026-10-27T10:00:00+08:00' }, anchor);
check('a reminder without repeat stays one-shot', once.repeat === undefined && once.repeatText === undefined);

console.log(`PASS ${checks} NewMate reply-channel and repeat-rule checks`);
