// The restart<->companion coupling, after 0.3.79.
//
// It used to cut both ways: heartBeat scheduled a 'update_report' task into NewMate so the
// companion would narrate an update restart, and NewMate displayed that report even when it was
// written as a list. The user asked for the two to be completely decoupled, so this gate now
// asserts the OPPOSITE contract:
//
//  1. a task of that kind left behind by an older version is retired at boot, by name
//     ('restart_report_decoupled'), and publishes nothing;
//  2. an ordinary run that answers with the notify/text protocol object still never stores the
//     object verbatim - that defect (2026-10-26 20:39, the chat showed {"notify":false,"text":""})
//     was real and is unrelated to the restart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewMate } from '../packages/newmark-core/components/newmate/component.js';

let checks = 0;
const check = (name, value) => { assert.ok(value, name); console.log(`ok ${++checks} - ${name}`); };
let serial = 0;

function fixture({ output = '好。', tasks = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-decoupling-'));
  fs.mkdirSync(path.join(root, 'newMate'));
  fs.writeFileSync(path.join(root, 'newMate/state.json'), JSON.stringify({ schema: 2, threads: [{ id: 'default', title: '对话', created: 1, updated: 1, archived: false }], activeThreadId: 'default', settings: { companion: true, notifications: false }, messages: [], tasks, measurements: {}, lastResponse: 0 }));
  const mate = createNewMate({
    root, now: () => 5000000 + (++serial),
    agents: () => null,
    environment: () => ({ ready: true, idleMs: 120000 }),
    tools: { execute: async () => ({ isError: false, value: { ok: true, result: { output } } }) },
  });
  return { mate, root };
}

// 1. a leftover restart report is retired, not narrated
{
  const leftover = { id: 'task-legacy', prompt: 'Newmark2DSH 更新后 DSH 已重启。请确认组件状态。', destination: 'newmate', threadId: 'default', status: 'pending', created: 5000000, kind: 'update_report' };
  const { mate } = fixture({ tasks: [leftover] });
  const task = mate.state().tasks.find((entry) => entry.id === 'task-legacy');
  check('a leftover restart report is cancelled at boot and says why', task.status === 'cancelled' && task.error === 'restart_report_decoupled');
  await mate.tick();
  check('the retired task never runs: no model turn, no message', mate.state().messages.length === 0);
  check('no restart narration can reach the companion conversation', !mate.state().messages.some((m) => String(m.text || '').includes('已重启')));
  mate.stop();
}

// 2. the protocol object is never stored as message text
{
  const { mate } = fixture({ output: '{"notify":false,"text":""}' });
  mate.chat('报告状态');
  await mate.tick();
  const messages = mate.state().messages.filter((m) => m.role === 'assistant');
  check('a notify=false protocol answer stores no message', messages.length === 0);
  check('the raw JSON never becomes message text', !messages.some((m) => String(m.text).includes('"notify"')));
  mate.stop();
}

// 3. a protocol answer with notify=true contributes its text, not the object
{
  const { mate } = fixture({ output: '{"notify":true,"text":"已就绪"}' });
  mate.chat('报告状态');
  await mate.tick();
  const messages = mate.state().messages.filter((m) => m.role === 'assistant');
  check('a notify=true protocol answer is displayed as its text', messages.length === 1 && messages[0].text === '已就绪');
  mate.stop();
}

console.log(`PASS ${checks} restart decoupling and protocol rendering checks`);
