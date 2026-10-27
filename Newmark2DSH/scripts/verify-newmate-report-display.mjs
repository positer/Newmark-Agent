// Two display defects measured on 2026-10-27, both about a NewMate message that the user never
// saw (or saw as gibberish):
//
//  1. The post-restart report is a task the restart pipeline ASKED for, but NewMate classified it
//     unsolicited (kind !== 'chat') and judged it by the proactive-message rule (240 chars, no
//     lists). Four real reports were suppressed as 'proactive_format'.
//  2. A run that answers with the notify/text protocol although it was not asked for it stored the
//     JSON object verbatim: on 2026-10-26 20:39 the chat showed {"notify":false,"text":""}.
//
// This gate drives the real component with a fake agent tool, so both are asserted where they
// happen rather than in prose.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewMate } from '../packages/newmark-core/components/newmate/component.js';

let checks = 0;
const check = (name, value) => { assert.ok(value, name); console.log(`ok ${++checks} - ${name}`); };
let serial = 0;

function fixture(output) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-report-'));
  fs.mkdirSync(path.join(root, 'newMate'));
  fs.writeFileSync(path.join(root, 'newMate/state.json'), JSON.stringify({ schema: 2, threads: [{ id: 'default', title: '对话', created: 1, updated: 1, archived: false }], activeThreadId: 'default', settings: { companion: true, notifications: false }, messages: [], tasks: [], measurements: {}, lastResponse: 0 }));
  const mate = createNewMate({
    root, now: () => 5000000 + (++serial),
    agents: () => null,
    environment: () => ({ ready: true, idleMs: 120000 }),
    tools: { execute: async () => ({ isError: false, value: { ok: true, result: { output, structured: undefined } } }) },
  });
  return { mate, root };
}

/** The heartbeat's delivery is a durable task with a kind, so the fixture writes exactly that. */
function enqueue(mate, root, prompt, kind) {
  const file = path.join(root, 'newMate/state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.tasks.push({ id: 'task-' + (++serial), prompt, destination: 'newmate', threadId: state.activeThreadId, status: 'pending', created: 5000000 + serial, kind });
  fs.writeFileSync(file, JSON.stringify(state));
}

// 1. a requested report with a list is shown, not dropped for its format
{
  const report = '更新后已重启。\n- 两条任务已完成\n- 一条等待下次启动\n- 其余已取消';
  const { mate, root } = fixture(report);
  enqueue(mate, root, '报告状态', 'update_report');
  await mate.tick();
  const messages = mate.state().messages;
  const task = mate.state().tasks[0];
  check('a requested post-restart report is displayed even though it has list lines', messages.length === 1 && messages[0].text === report && messages[0].proactive === true);
  check('the report task is not marked suppressed', !task.suppressed);
  mate.stop();
}

// 2. the protocol object is never stored as a message
{
  const { mate, root } = fixture('{"notify":false,"text":""}');
  enqueue(mate, root, '报告状态', 'update_report');
  await mate.tick();
  const messages = mate.state().messages, task = mate.state().tasks[0];
  check('a notify=false protocol answer stores no message', messages.length === 0 && task.suppressed === 'not_actionable');
  check('the raw JSON never becomes message text', !messages.some((m) => String(m.text).includes('"notify"')));
  mate.stop();
}

// 3. a protocol answer with notify=true contributes its text, not the object
{
  const { mate, root } = fixture('{"notify":true,"text":"已就绪"}');
  enqueue(mate, root, '报告状态', 'update_report');
  await mate.tick();
  const messages = mate.state().messages;
  check('a notify=true protocol answer is displayed as its text', messages.length === 1 && messages[0].text === '已就绪' && messages[0].proactive === true);
  mate.stop();
}

console.log(`PASS ${checks} NewMate report display checks`);
