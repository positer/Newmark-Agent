/**
 * Offline probe: is a finished proactive sentence thrown away when the moment is wrong?
 *
 * Super-agent's "speculative execution" says the expensive half (the model call) is already spent when
 * the delivery gate answers, so a sentence refused only because the person is typing should be kept and
 * delivered when the moment fits. This probe prints the three facts that show it:
 *
 *   while typing:   {"messages":0,"calls":1,"lastOutcome":"prepared:typing","prepared":true}
 *   typing stopped: {"messages":1,"calls":1,"lastOutcome":"message","prepared":false} notices: 1
 *
 * The second line is the point: the message arrived and `calls` did not move - no second model call.
 * Offline, no network, no model: the run is a stub.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewMate } from '../packages/newmark-core/components/newmate/component.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-prepared-'));
const MINUTE = 60000;
let time = Date.parse('2026-10-12T01:00:00Z');
const env = { ready: true, idleMs: 2 * MINUTE };
let calls = 0;
const notices = [];
const mate = createNewMate({ root, now: () => time, agents: () => null, environment: () => env, onNotify: async (m) => notices.push(m),
  tools: { execute: async () => { calls += 1; env.idleMs = 20000; return { isError: false, value: { ok: true, result: { structured: { notify: true, text: '刚看到你把周报补完了，需要我顺手核对一下数字吗？', topic: '周报数字' } } } }; } } });
const state = () => ({ messages: mate.state().messages.length, calls, lastOutcome: mate.state().initiative.lastOutcome, prepared: Boolean(mate.state().initiative.prepared) });
await mate.configure({ companion: true });
time += 21 * MINUTE;                      // the run starts while the person is still
await mate.tick();                        // typing begins while the run is in flight
console.log('while typing:', JSON.stringify(state()));
env.idleMs = 2 * MINUTE;                  // typing stopped
await mate.tick();
console.log('typing stopped:', JSON.stringify(state()), 'notices:', notices.length, 'preparedAt:', mate.state().messages[0]?.preparedAt !== undefined);
console.log('text:', mate.state().messages[0]?.text);
