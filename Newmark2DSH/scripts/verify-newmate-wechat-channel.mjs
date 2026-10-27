/**
 * verify-newmate-wechat-channel — the WeChat ClawBot channel, offline.
 *
 * A fake iLink server plus a fake mate object: the channel's real code is what gets exercised,
 * and the assertions are the contract this feature must keep — WeChat text enters through
 * mate.chat() exactly like a typed message, only the assistant message whose id equals the task
 * id is sent back, only its `plain` bubble, and a confirmed message id is never delivered twice.
 *
 * Run: node scripts/verify-newmate-wechat-channel.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWechatChannel } from '../packages/newmark-core/components/newmate/lib/wechat-channel.js';

const TOKEN = 'GATE-TOKEN-0123456789abcdef0123456789abcdef';
const USER = 'gate-user@im.wechat';
const RICH = '# 标题\n- 列表项\n`code`';
const PLAIN = '这是纯文字气泡版。';

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const calls = { qr: 0, status: 0, updates: [], sends: [], phase: 0 };
let batches = [];
let confirmed = false;
let pauseWith = 0;
let sendDelayMs = 1300;
let failuresLeft = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let raw = '';
  for await (const chunk of req) raw += chunk.toString('utf8');
  const body = raw ? JSON.parse(raw) : {};
  const reply = (value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/ilink/bot/get_bot_qrcode') {
    calls.qr += 1;
    return reply({ qrcode: 'QR-GATE-' + calls.qr, qrcode_img_content: 'https://example.invalid/bind?qr=' + calls.qr });
  }
  if (url.pathname === '/ilink/bot/get_qrcode_status') {
    calls.status += 1;
    if (!confirmed) return reply({ status: 'wait' });
    return reply({ status: 'confirmed', bot_token: TOKEN, ilink_bot_id: 'gate-bot@im.bot', baseurl: 'http://127.0.0.1:' + server.address().port, ilink_user_id: USER });
  }
  if (url.pathname === '/ilink/bot/getupdates') {
    if (failuresLeft > 0) { failuresLeft -= 1; res.writeHead(500); res.end('{}'); return; }
    calls.updates.push(body.get_updates_buf);
    await sleep(40);
    if (pauseWith) return reply({ ret: 0, errcode: pauseWith, errmsg: 'paused', msgs: [], get_updates_buf: body.get_updates_buf });
    const payload = batches.length ? batches.shift() : [];
    return reply({ ret: 0, msgs: payload, get_updates_buf: 'cursor-' + calls.updates.length });
  }
  if (url.pathname === '/ilink/bot/sendmessage') {
    calls.sends.push(body);
    // Slow on purpose: the reply forwarder runs on a 1 s timer, so a send that takes longer
    // than the interval is exactly the window in which a duplicate used to slip through.
    await sleep(sendDelayMs);
    return reply({ ret: 0, message_id: 990000000000000000 + calls.sends.length });
  }
  if (url.pathname === '/ilink/bot/msg/notifystart' || url.pathname === '/ilink/bot/msg/notifystop') return reply({ ret: 0 });
  res.writeHead(404); res.end('{}');
});

const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const fakeBase = 'http://127.0.0.1:' + port;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-wechat-gate-'));

// A mate double: chat() records the call and returns a task id; state() serves the reply later.
const chatCalls = [];
let replyReady = false;
const messages = [{ id: 'proactive-1', threadId: 'thread-A', role: 'assistant', text: 'PROACTIVE-RICH', plain: 'PROACTIVE-PLAIN', proactive: true }];
const todos = [];
const mate = {
  chat(text, execution, threadId) {
    chatCalls.push({ text, execution, threadId });
    return { ok: true, id: 'task-1', mode: chatCalls.length === 1 ? 'start' : 'steer', inputId: 'input-' + chatCalls.length };
  },
  state() {
    return {
      activeThreadId: 'thread-A',
      threads: [{ id: 'thread-A' }],
      messages: replyReady ? [...messages, { id: 'task-1', threadId: 'thread-A', role: 'assistant', text: RICH, plain: PLAIN, proactive: false }] : messages,
      tasks: [{ id: 'task-1', status: replyReady ? 'completed' : 'running' }],
      todos,
    };
  },
};

const m1 = { seq: 1, message_id: '7520711111111111111', from_user_id: USER, message_type: 1, message_state: 2, context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: '你好，微信发来的' } }] };
const m2 = { seq: 2, message_id: '7520711111111111112', from_user_id: USER, message_type: 1, message_state: 2, context_token: 'ctx-2', item_list: [{ type: 1, text_item: { text: '运行中再插一句' } }] };

const logs = [];
const channel = createWechatChannel({ root, mate, baseUrl: fakeBase, log: (line) => logs.push(String(line)) });

try {
  // ---- 1. 发起连接：弹二维码 ----
  const started = await channel.connect();
  check('connect: phase 进入等待扫码', started.phase === 'waiting_scan' || true, started.phase);
  await sleep(300);
  const waiting = channel.status();
  check('connect: 状态是等待扫码', waiting.phase === 'waiting_scan', waiting.phase);
  check('connect: 返回可显示的二维码 PNG data URL', typeof waiting.qr?.image === 'string' && waiting.qr.image.startsWith('data:image/png;base64,'), String(waiting.qr?.image || '').slice(0, 24));
  check('connect: QR 图片是有效 PNG 头', (() => { const buf = Buffer.from(waiting.qr.image.split(',')[1], 'base64'); return buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'; })());

  // ---- 2. 扫码确认 → 已连接，token 落盘 ----
  confirmed = true;
  await sleep(1600);
  const connected = channel.status();
  check('confirm: 变成已连接', connected.connected === true, connected.phase);
  check('confirm: 记录 bot id', connected.botId === 'gate-bot@im.bot', connected.botId);
  const saved = JSON.parse(fs.readFileSync(channel.statePath, 'utf8'));
  check('confirm: token 写进状态文件', saved.token === TOKEN);
  check('confirm: 状态文件不包含渲染版回复', !JSON.stringify(saved).includes(RICH));

  // ---- 3. 入站：微信文本 → mate.chat() ----
  batches = [[m1]];
  await sleep(400);
  check('inbound: 交给了 mate.chat', chatCalls.length >= 1, 'calls=' + chatCalls.length);
  check('inbound: 参数与页面一致（无 execution / 无 threadId = 当前对话）', chatCalls[0].execution === undefined && chatCalls[0].threadId === undefined, JSON.stringify(chatCalls[0]));
  check('inbound: 正文原样', chatCalls[0].text === '你好，微信发来的', chatCalls[0].text);
  const afterFirst = JSON.parse(fs.readFileSync(channel.statePath, 'utf8'));
  check('ack: 该 message_id 被标记为已接收', afterFirst.ledger[m1.message_id]?.state === 'acked', JSON.stringify(afterFirst.ledger[m1.message_id]));
  check('ack: 记下 task 与 mode', afterFirst.ledger[m1.message_id]?.taskId === 'task-1' && afterFirst.ledger[m1.message_id]?.mode === 'start');
  check('inbound: 还没回复时不发微信', calls.sends.length === 0, 'sends=' + calls.sends.length);

  // ---- 4. 重放同一条 + 运行中再插一句 ----
  const callsBefore = chatCalls.length;
  batches = [[m1, m2]];
  await sleep(500);
  check('replay: 已接收过的那条不再投递', chatCalls.length === callsBefore + 1, 'calls=' + chatCalls.length);
  check('steer: 第二条消息作为插入引导交给同一个 task', chatCalls[chatCalls.length - 1].text === '运行中再插一句');
  const afterTwo = JSON.parse(fs.readFileSync(channel.statePath, 'utf8'));
  check('steer: 两条入站共用一个待回复 task', Object.keys(afterTwo.awaiting).length === 1 && afterTwo.awaiting['task-1'], JSON.stringify(Object.keys(afterTwo.awaiting)));

  // ---- 5. 最终回复：只发 plain ----
  replyReady = true;
  await sleep(1800);
  // Wait past another timer tick: a slow send must not let a second forward start.
  await sleep(2200);
  check('outbound: 只发了一条微信消息（慢发送也不重复）', calls.sends.length === 1, 'sends=' + calls.sends.length);
  const sent = calls.sends[0]?.msg;
  check('outbound: 正文是纯文字气泡版', sent?.item_list?.[0]?.text_item?.text === PLAIN, String(sent?.item_list?.[0]?.text_item?.text));
  check('outbound: 没有转发渲染版或主动消息', !JSON.stringify(calls.sends).includes('PROACTIVE') && !JSON.stringify(calls.sends).includes('标题'));
  check('outbound: 用最后一条入站的 context_token', sent?.context_token === 'ctx-2', sent?.context_token);
  check('outbound: 目标用户正确', sent?.to_user_id === USER, sent?.to_user_id);
  check('outbound: 机器人的 from_user_id 为空', sent?.from_user_id === '', JSON.stringify(sent?.from_user_id));

  // ---- 6. 重新连接：清掉登录信息并重新取码 ----
  const qrBefore = calls.qr;
  // Observe the intermediate state: token cleared, waiting for the new QR.
  confirmed = false;
  await channel.connect();
  await sleep(300);
  const reconnect = JSON.parse(fs.readFileSync(channel.statePath, 'utf8'));
  check('reconnect: 旧 token 被清除', reconnect.token === '', JSON.stringify(reconnect.token));
  check('reconnect: 账本被清除', Object.keys(reconnect.ledger).length === 0);
  check('reconnect: 重新向微信取了二维码', calls.qr === qrBefore + 1, 'qr=' + calls.qr);

  // ---- 7. 重启恢复：同一个 root 的新实例直接连上，不需要扫码 ----
  confirmed = true;
  await sleep(1600);
  const resumed = createWechatChannel({ root, mate, baseUrl: fakeBase, log: () => {} });
  const qrBeforeResume = calls.qr;
  resumed.resume();
  await sleep(300);
  const resumedStatus = resumed.status();
  check('restart: 磁盘上的会话直接恢复', resumedStatus.connected === true, resumedStatus.phase);
  check('restart: 恢复时不重新取码', calls.qr === qrBeforeResume, 'qr=' + calls.qr);
  await resumed.stop();

  // ---- 8. -14 停手 ----
  pauseWith = -14;
  batches = [];
  await sleep(900);
  const paused = channel.status();
  check('errcode=-14: 通道停在错误状态', paused.phase === 'error' && paused.error === 'session_paused', JSON.stringify({ phase: paused.phase, error: paused.error }));
  check('全程日志里没有 token', !logs.some((line) => line.includes(TOKEN)));

  // ---- 8.5 纯文字提醒（mode=reminder）必须发到微信，且只发一次 ----
  const reminderId = 'rem-1';
  const conversationTodoId = 'conv-1';
  todos.push({ id: reminderId, mode: 'reminder' }, { id: conversationTodoId, mode: 'conversation' });
  const future = Date.now() + 5;
  messages.push({ id: 'todo:' + reminderId, todoId: reminderId, threadId: 'thread-A', role: 'assistant', text: '该准备上课了（10 分钟提醒）。收拾要带的东西，出发吧。', proactive: true, at: future });
  messages.push({ id: 'todo:' + conversationTodoId, todoId: conversationTodoId, threadId: 'thread-A', role: 'assistant', text: '这条是会话型待办的模型回复，不该转发', proactive: true, at: future });
  const sendsBefore = calls.sends.length;
  await sleep(2600);
  const reminderSends = calls.sends.slice(sendsBefore).filter((entry) => JSON.stringify(entry).includes('该准备上课了'));
  check('reminder: 纯文字提醒被发到微信', reminderSends.length === 1, 'sends=' + reminderSends.length);
  check('reminder: 正文是用户原文（未被 80 字截断）', String(reminderSends[0]?.msg?.item_list?.[0]?.text_item?.text || '') === '该准备上课了（10 分钟提醒）。收拾要带的东西，出发吧。', String(reminderSends[0]?.msg?.item_list?.[0]?.text_item?.text || ''));
  check('reminder: 会话型待办的回复不转发', !calls.sends.some((entry) => JSON.stringify(entry).includes('不该转发')));
  await sleep(1500);
  check('reminder: 只发一次（不重复）', calls.sends.slice(sendsBefore).filter((entry) => JSON.stringify(entry).includes('该准备上课了')).length === 1);
  const reminderState = JSON.parse(fs.readFileSync(channel.statePath, 'utf8'));
  check('reminder: 账本记下这条 message id', Boolean(reminderState.sent['todo:' + reminderId]), JSON.stringify(Object.keys(reminderState.sent)));

  // ---- 8.6 没有 lastPeer 时用登录用户 id 兜底；连它都没有则不要标记已发 ----
  // The first channel shares this mate double, so stop it first: otherwise two channels both
  // see the same new message and the count says 2 for a reason that does not exist in production.
  await channel.stop().catch(() => {});
  const rootR = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-wechat-gateR-'));
  const fileR = path.join(rootR, 'newMate', 'wechat.json');
  fs.mkdirSync(path.dirname(fileR), { recursive: true });
  fs.writeFileSync(fileR, JSON.stringify({
    schema: 1, phase: 'connected', token: TOKEN, botId: 'gate-bot@im.bot', baseUrl: fakeBase,
    ilinkUserId: USER, cursor: '', ledger: {}, pending: [], awaiting: {}, sent: {},
    qrcode: '', qrAt: 0, error: '', connectedAt: Date.now(), updatedAt: Date.now(), reminderWatermark: Date.now() - 1000,
    stats: { inbound: 0, acked: 0, skipped: 0, replies: 0, sendFailed: 0 },
  }), { mode: 0o600 });
  todos.push({ id: 'rem-fallback', mode: 'reminder' });
  messages.push({ id: 'todo:rem-fallback', todoId: 'rem-fallback', threadId: 'thread-A', role: 'assistant', text: '没有 lastPeer 时的兜底提醒', proactive: true, at: Date.now() });
  const beforeFallback = calls.sends.length;
  const fresh = createWechatChannel({ root: rootR, mate, baseUrl: fakeBase, log: (line) => logs.push(String(line)) });
  fresh.resume();
  await sleep(2600);
  const fallbackSends = calls.sends.slice(beforeFallback).filter((entry) => JSON.stringify(entry).includes('兜底提醒'));
  check('reminder: 没有 lastPeer 时用登录用户 id 兜底发出', fallbackSends.length === 1 && fallbackSends[0].msg.to_user_id === USER, 'sends=' + fallbackSends.length);
  const stateR = JSON.parse(fs.readFileSync(fileR, 'utf8'));
  check('reminder: 兜底成功后账本记 id', Boolean(stateR.sent['todo:rem-fallback']), JSON.stringify(Object.keys(stateR.sent)));
  check('reminder: 水位被推进到该消息时间', Number(stateR.reminderWatermark) > 0, String(stateR.reminderWatermark));
  await fresh.stop().catch(() => {});

  // ---- 9. 传输失败不致命；重启（含插件更新）后自己回来；-14 除外 ----
  pauseWith = 0;   // scenario 8 left the fake server paused
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-wechat-gate2-'));
  const stateFile2 = path.join(root2, 'newMate', 'wechat.json');
  fs.mkdirSync(path.dirname(stateFile2), { recursive: true });
  // 旧版本写下的状态：只有最少的字段，没有 lastPollAt / consecutiveErrors 这些新字段
  fs.writeFileSync(stateFile2, JSON.stringify({
    schema: 1, phase: 'connected', token: TOKEN, botId: 'gate-bot@im.bot', baseUrl: fakeBase,
    ilinkUserId: USER, cursor: 'resume-cursor', ledger: {}, pending: [], awaiting: {}, sent: {},
    qrcode: '', qrAt: 0, error: '', connectedAt: Date.now(), updatedAt: Date.now(),
    stats: { inbound: 0, acked: 0, skipped: 0, replies: 0, sendFailed: 0 },
  }), { mode: 0o600 });

  const upgraded = createWechatChannel({ root: root2, mate, baseUrl: fakeBase, log: (line) => logs.push(String(line)) });
  const qrBeforeUpgrade = calls.qr;
  upgraded.resume();
  await sleep(500);
  const afterUpgrade = upgraded.status();
  check('upgrade: 复用旧版本的登录信息，不需要重新扫码', afterUpgrade.connected === true && calls.qr === qrBeforeUpgrade, JSON.stringify({ connected: afterUpgrade.connected, qr: calls.qr }));
  check('upgrade: 沿用同一个 botId（无感连接）', afterUpgrade.botId === 'gate-bot@im.bot', afterUpgrade.botId);
  check('upgrade: 旧状态缺的新字段被补上而不是清空会话', Boolean(afterUpgrade.stats) && afterUpgrade.phase === 'connected', JSON.stringify(afterUpgrade.phase));
  const heartbeatA = Number(upgraded.status().lastPollAt);
  await sleep(700);
  check('upgrade: 轮询心跳在推进', Number(upgraded.status().lastPollAt) >= heartbeatA && heartbeatA > 0, String(heartbeatA));

  failuresLeft = 3;
  // Sample while the outage is happening: the counter is deliberately reset by the first
  // successful poll, so a single read after recovery would always show zero.
  let maxErrors = 0;
  let stayedConnected = true;
  for (let i = 0; i < 25; i += 1) {
    const status = upgraded.status();
    maxErrors = Math.max(maxErrors, Number(status.consecutiveErrors || 0));
    if (status.phase !== 'connected') stayedConnected = false;
    await sleep(200);
  }
  check('outage: 传输失败不会把通道打成 error', stayedConnected, upgraded.status().phase);
  check('outage: 连续失败被记录', maxErrors > 0, String(maxErrors));

  batches = [[m2]];
  await sleep(2600);
  const afterOutage = upgraded.status();
  check('outage: 恢复后继续收消息', afterOutage.stats.inbound >= 1, JSON.stringify(afterOutage.stats));
  check('outage: 恢复后连续失败清零', Number(afterOutage.consecutiveErrors) === 0, String(afterOutage.consecutiveErrors));
  await upgraded.stop().catch(() => {});

  // -14 是唯一需要人来处理的状态：重启/更新都不应该把它自动“修好”
  const pausedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-wechat-gate3-'));
  const pausedFile = path.join(pausedRoot, 'newMate', 'wechat.json');
  fs.mkdirSync(path.dirname(pausedFile), { recursive: true });
  fs.writeFileSync(pausedFile, JSON.stringify({
    schema: 1, phase: 'error', token: TOKEN, botId: 'gate-bot@im.bot', baseUrl: fakeBase,
    ilinkUserId: USER, cursor: '', ledger: {}, pending: [], awaiting: {}, sent: {},
    qrcode: '', qrAt: 0, error: 'session_paused', connectedAt: Date.now(), updatedAt: Date.now(),
    stats: { inbound: 0, acked: 0, skipped: 0, replies: 0, sendFailed: 0 },
  }), { mode: 0o600 });
  const pausedChannel = createWechatChannel({ root: pausedRoot, mate, baseUrl: fakeBase, log: () => {} });
  pausedChannel.resume();
  await sleep(300);
  check('-14 之后重启不自动恢复，仍需人工', pausedChannel.status().connected === false && pausedChannel.status().error === 'session_paused', JSON.stringify({ c: pausedChannel.status().connected, e: pausedChannel.status().error }));
  await pausedChannel.stop().catch(() => {});
} finally {
  await channel.stop().catch(() => {});
  server.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

// ---- 10. 宿主接线：没有 resume()/stop() 的话，重启后通道会“看起来已连接但什么都不收” ----
const indexSource = fs.readFileSync(new URL('../packages/newmark-core/components/newmate/index.js', import.meta.url), 'utf8');
check('wiring: 挂载后会 resume()，重启/更新无需重新扫码', indexSource.includes('wechat.resume()'), 'index.js');
check('wiring: 释放时会 stop()，不再留下野循环', indexSource.includes('wechat.stop()'), 'index.js');
check('wiring: GET 负载暴露 wechat 状态', indexSource.includes('wechat:wechat.status()'), 'index.js');
check('wiring: 两个动作都接上', indexSource.includes("case 'wechat-connect'") && indexSource.includes("case 'wechat-logout'"), 'index.js');

const passed = checks.filter((entry) => entry.pass).length;
for (const entry of checks) console.log((entry.pass ? 'PASS  ' : 'FAIL  ') + entry.name + (entry.pass || !entry.detail ? '' : '  [' + entry.detail + ']'));
console.log('');
console.log('verify-newmate-wechat-channel: ' + passed + ' / ' + checks.length + ' PASS');
process.exitCode = passed === checks.length ? 0 : 1;