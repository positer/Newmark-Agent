/**
 * Offline probe: does NewMate tidy a growing session WITHOUT anyone talking to it?
 *
 * Seeds a session already past the soft budget, last message three hours old, companion and
 * initiative on, then ticks once with a stub model that calls newmate_session_refresh. Prints the
 * four facts that matter: the maintenance task kind, whether a session switch happened, whether any
 * message was published, and what the new session carries.
 *
 * Expected:
 *   task kind: session_refresh   refreshed: true
 *   active changed: true         messages published by maintenance: 0
 *   new session carries: self    last rotation: self_refresh
 *
 * Offline, no network, no model: the run is a stub.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewMate } from '../packages/newmark-core/components/newmate/component.js';
import { createSessionBridge } from '../packages/newmark-core/components/newmate/lib/sessions.js';
import { SESSION_BUDGET } from '../packages/newmark-core/components/newmate/lib/session-refresh.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-proactive-refresh-'));
let time = Date.parse('2026-11-01T01:00:00Z');
const MINUTE = 60000;
fs.mkdirSync(path.join(root, 'newMate'), { recursive: true });
const thread = { id: 'long', title: '很长的会话', created: time - 100000, updated: time - 10, archived: false };
const messages = Array.from({ length: SESSION_BUDGET.messages + 2 }, (_, index) => ({ id: 'm' + index, threadId: 'long', role: index % 2 ? 'assistant' : 'user', text: '第' + index + '条', at: time - 3 * 60 * MINUTE - (messages0() - index) }));
function messages0() { return SESSION_BUDGET.messages + 2; }
const initiative = { enabledAt: time, nextAttemptAt: time + 30 * 24 * 60 * MINUTE, lastUserAt: time - 3 * 60 * MINUTE, lastMessageAt: 0, unanswered: 0, attempts: 0, sent: 0, day: '', signals: [] };
fs.writeFileSync(path.join(root, 'newMate', 'state.json'), JSON.stringify({ schema: 2, threads: [thread], activeThreadId: 'long', settings: { companion: true, initiative: true, notifications: false }, initiative, messages, tasks: [], measurements: {}, lastResponse: 0 }));
const calls = [];
const mate = createNewMate({ root, now: () => time, agents: () => null, environment: () => ({ ready: true, idleMs: 2 * MINUTE }), onNotify: async () => {},
  tools: { schemas: () => [], execute: async (call) => {
    calls.push(call);
    if (/会话维护/.test(String(call.arguments.prompt || ''))) {
      await createSessionBridge({ services: { sessions: () => mate } }).refresh({ summary: '目标：把主动刷新做完；已完成：维护轮；未完成：验收。', title: '主动交接' });
    }
    return { isError: false, value: { ok: true, result: { output: '已交接。' } } };
  } } });
const beforeMessages = mate.state().messages.length;
const beforeThread = mate.state().activeThreadId;
time += 5 * MINUTE;
await mate.tick();
const state = mate.state();
const active = state.threads.find((entry) => entry.id === state.activeThreadId);
console.log('calls:', calls.length, 'task kind:', state.tasks.at(-1)?.kind, 'refreshed:', state.tasks.at(-1)?.maintenance?.refreshed);
console.log('active changed:', state.activeThreadId !== beforeThread, 'messages published by maintenance:', state.messages.length - beforeMessages);
console.log('new session carries:', active.carried?.by, 'last rotation:', state.lastThreadRotation?.reason);
console.log('summary:', active.carried?.summary);
