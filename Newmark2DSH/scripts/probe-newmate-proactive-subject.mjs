/**
 * Offline probe: what a topic-less proactive message is deduped against.
 *
 * Why it exists: on 2026-10-31 the scheduler tagged every proactive message that named no topic with
 * the TRIGGER (`check-in` / `file-change`), so a second, completely different sentence was rejected as
 * `duplicate_topic` - one topic-less message silenced every other for 24 hours. This probe prints the
 * two facts that showed it: how many messages were stored, and what the last outcome was.
 *
 * Expected after the fix: `messages: 2`, both `lastOutcome: "message"`.
 * Offline, no network, no model: the run is a stub.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewMate } from '../packages/newmark-core/components/newmate/component.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-proactive-subject-'));
const MINUTE = 60000, HOUR = 60 * MINUTE;
let time = Date.parse('2026-10-12T01:00:00Z');
let n = 0;
const calls = [];
const mate = createNewMate({ root, now: () => time, agents: () => null, environment: () => ({ ready: true, idleMs: 2 * MINUTE }), onNotify: async () => {},
  tools: { execute: async (call) => { calls.push(call); n += 1; return { isError: false, value: { ok: true, result: { structured: { notify: true, text: '第' + n + '条完全不同的内容：' + 'x'.repeat(n) } } } }; } } });
const run = async (minutes) => { time += minutes; await mate.tick(); };
await mate.configure({ companion: true });
await run(21 * MINUTE);
console.log('after 1st:', JSON.stringify({ messages: mate.state().messages.length, lastOutcome: mate.state().initiative.lastOutcome, lastTopic: mate.state().initiative.lastTopic }));
await run(9 * HOUR);
console.log('after 2nd:', JSON.stringify({ messages: mate.state().messages.length, lastOutcome: mate.state().initiative.lastOutcome, lastTopic: mate.state().initiative.lastTopic }));
console.log('calls:', calls.length, 'threads:', mate.state().threads.length);
