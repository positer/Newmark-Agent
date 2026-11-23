/**
 * NewMate — the DSH CONVERSATIONS DIGEST gate.
 *
 * The requirement (2026-11-24):「主动对话的检查流程新增检查最近10条DSH本体对话并整理建议」. The check-in
 * already reads what changed on disk; this gate holds the other half - that the ten most recent host
 * conversations are read (bounded), summarised with what was dropped, put in front of the model with an
 * explicit instruction to turn one of them into a suggestion, and read for NOTHING ELSE.
 *
 * Run: node Newmark2DSH/scripts/verify-newmate-dsh-digest.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewMate } from '../packages/newmark-core/components/newmate/component.js';
import { buildDshDigest, summariseConversations, DSH_DIGEST_DEFAULTS } from '../packages/newmark-core/components/newmate/lib/dsh-digest.js';
import { hostTools } from './lib/host-call.mjs';

let checks = 0;
const check = (label, value, detail) => {
  if (value) { checks += 1; console.log('ok ' + checks + ' - ' + label); return true; }
  console.log('not ok ' + (checks + 1) + ' - ' + label);
  if (detail !== undefined) console.log('  ' + detail);
  process.exitCode = 1;
  return false;
};

const now = Date.parse('2026-11-24T03:00:00Z');
const session = (index, minutesAgo, title, cwd = 'C:\\work\\proj') => ({
  sessionId: 'session-' + index,
  title,
  cwd,
  createdAt: now - minutesAgo * 60000 - 60000,
  live: index === 1,
  persisted: true,
});
const SESSIONS = [
  session(1, 5, '修 NewMate 的中间回复'),
  session(2, 40, 'MemoryLab 索引重建'),
  session(3, 120, '论文第三章的图'),
  session(4, 300, 'PigHub 版本地板'),
  session(5, 600, 'STM 数据清洗'),
  session(6, 900, 'Newmark 预设对齐'),
  session(7, 1500, '编译错误排查'),
  session(8, 2000, '环境变量'),
  session(9, 3000, '没有标题的会话'),
  session(10, 4000, '周报'),
  session(11, 5000, '更早的一条'),
  session(12, 6000, '更早的另一条'),
];
// A body with a tail marker: the marker can only appear if the transcript was carried WHOLE, so the
// "no whole transcript" assertions cannot be satisfied by a periodic string that repeats its own head.
const LONG = '这是一段很长的正文，'.repeat(40) + 'TAIL-MARKER-ONLY-IN-FULL';
const transcripts = {
  'session-1': [{ role: 'user', text: '中间回复的气泡没出来', at: now - 5 * 60000 }, { role: 'assistant', text: '我查一下静默开关', at: now - 4 * 60000 }],
  'session-2': [{ role: 'user', text: LONG, at: now - 40 * 60000 }, { role: 'assistant', text: '重建完成 109 标签', at: now - 39 * 60000 }],
  'session-3': [{ role: 'user', text: '图 3 的横轴标签重叠', at: now - 120 * 60000 }],
};
const seams = (readFails = new Set()) => ({
  list: async ({ limit }) => ({ ok: true, source: 'corpus', total: SESSIONS.length, returned: Math.min(limit, SESSIONS.length), truncated: SESSIONS.length > limit, conversations: SESSIONS.slice(0, limit).map((row) => ({ ...row, self: false })) }),
  read: async ({ sessionId }) => {
    if (readFails.has(sessionId)) throw Error('transcript unavailable');
    return { ok: true, messages: transcripts[sessionId] || [] };
  },
});

/* ---------------------------------------------------------------- the digest itself --- */

{
  const digest = await buildDshDigest(seams(new Set(['session-3'])), { now });
  check('the digest reads the ten most recent conversations, not everything', digest.ok === true && digest.sessions.length === DSH_DIGEST_DEFAULTS.maxSessions && DSH_DIGEST_DEFAULTS.maxSessions === 10);
  check('and it says how many it did not read', digest.omitted === SESSIONS.length - 10 && digest.total === SESSIONS.length);
  check('the newest activity leads, not the newest creation', digest.sessions[0].sessionId === 'session-1' && digest.sessions[1].sessionId === 'session-2');
  check('each row carries title, workspace and the two newest messages at most', digest.sessions[0].title === '修 NewMate 的中间回复' && digest.sessions[0].cwd.endsWith('proj') && digest.sessions[0].excerpt.length <= DSH_DIGEST_DEFAULTS.excerptMessages);
  check('a quoted message is clipped instead of carried whole', digest.sessions.find((row) => row.sessionId === 'session-2').excerpt[0].text.length <= DSH_DIGEST_DEFAULTS.excerptChars + 1);
  check('a transcript that cannot be read degrades to metadata instead of failing the check-in', digest.sessions.find((row) => row.sessionId === 'session-3').excerptState === 'read-failed' && digest.sessions.find((row) => row.sessionId === 'session-3').title === '论文第三章的图');
  const text = summariseConversations(digest, { now });
  check('the summary is a prompt-sized page, not a transcript', text.length <= DSH_DIGEST_DEFAULTS.maxChars + 120 && !text.includes('TAIL-MARKER-ONLY-IN-FULL'));
  check('the summary names the conversations and the workspace, newest first', text.indexOf('修 NewMate 的中间回复') >= 0 && text.indexOf('修 NewMate 的中间回复') < text.indexOf('MemoryLab 索引重建') && text.includes('工作区 proj'));
  check('the summary states where the reading stopped', text.includes('本次查看 10 条'));
  const tight = summariseConversations(digest, { now, maxChars: 260 });
  check('a tight budget states the rows it did not list', tight.includes('未列出') && tight.length <= 260 + 40);
  const empty = summariseConversations(await buildDshDigest({ list: async () => ({ ok: true, conversations: [], total: 0 }) }, { now }), { now });
  check('an empty host says so instead of pretending there is nothing to do', empty.includes('没有可读的对话'));
  const unavailable = summariseConversations(await buildDshDigest({}, { now }), { now });
  check('a host without the listing says "unreadable" and why', unavailable.includes('不可读') && unavailable.includes('dsh_digest_unavailable'));
}

/* ------------------------------------------------------- the check-in prompt gets it --- */

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-dsh-digest-'));
  const seed = path.join(root, 'check-in');
  fs.mkdirSync(path.join(seed, 'newMate'), { recursive: true });
  const initial = createNewMate({ root: seed, now: () => now, agents: () => null, tools: hostTools(async () => ({ isError: false, value: { ok: true } })) });
  const base = initial.state();
  base.settings.companion = true;
  base.settings.initiative = true;
  base.tasks.push({ id: 'check-1', kind: 'self_activation', reason: 'file-change', status: 'pending', prompt: '主动陪伴稀疏检查', destination: 'newmate', threadId: base.activeThreadId, created: now });
  fs.writeFileSync(path.join(seed, 'newMate', 'state.json'), JSON.stringify(base));
  initial.stop();
  let prompt = '';
  let seamCalls = 0;
  const mate = createNewMate({
    root: seed, now: () => now, agents: () => null,
    environment: () => ({ ready: true, idleMs: 120000 }),
    tools: hostTools(async (call) => { prompt = String(call.arguments?.prompt || prompt); return { isError: false, value: { ok: true, result: { structured: { notify: false, text: '' } } } }; }),
    dshConversations: () => { seamCalls += 1; const s = seams(); return { list: (a) => s.list(a), read: (a) => s.read(a) }; },
  });
  await mate.tick();
  check('a check-in reads the conversations through the bridge seams exactly once', seamCalls === 1);
  check('the check-in prompt carries the conversation digest', prompt.includes('最近 DSH 本体对话') && prompt.includes('修 NewMate 的中间回复'));
  check('the prompt tells the model what makes a suggestion worth making', prompt.includes('一条可以立刻执行的建议') && prompt.includes('停在中途'));
  check('the digest never carries a whole transcript, only quoted snippets', !prompt.includes('TAIL-MARKER-ONLY-IN-FULL') && prompt.includes('…'));
  mate.stop();

  let chatSeamCalls = 0;
  const chatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-dsh-digest-chat-'));
  const chatMate = createNewMate({
    root: chatRoot, now: () => now, agents: () => null,
    tools: hostTools(async () => ({ isError: false, value: { ok: true, result: { output: '好' } } })),
    dshConversations: () => { chatSeamCalls += 1; return seams(); },
  });
  chatMate.chat('普通对话');
  await chatMate.tick();
  check('a user-initiated turn does NOT read the host conversations (the digest belongs to the check-in)', chatSeamCalls === 0);
  chatMate.stop();
}

console.log('');
if (process.exitCode) console.log('SUMMARY passed=' + checks + ' failed=1');
else { console.log('SUMMARY passed=' + checks + ' failed=0 total=' + checks); console.log('PASS'); }
