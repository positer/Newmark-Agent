/**
 * 跨重启信息保持测试：证明"登录信息 / 游标 / 去重表 / 收件人"都在磁盘上，
 * 一个新进程（等价于重启）不需要重新扫码就能继续收与发。
 *
 * 两个阶段用同一个目录 + 同一个假 iLink 服务端，但**不共享内存**：第二阶段只从磁盘
 * loadSession(dir) / loadSeen(dir) 取状态，等价于进程重启。
 *
 * 运行：node SCRIPTS/clawbot-demo/cross-restart-test.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { login, run, loadSession, loadSeen, sendText, stateDir } from './clawbot-demo.mjs';

const TOKEN = 'RESTART-TOKEN-0123456789abcdef0123456789abcdef';
const BOT_ID = 'restart-bot@im.bot';
const USER = 'restart-user@im.wechat';
const BIG = '17912345678901234567';

const m1 = { seq: 1, message_id: BIG, from_user_id: USER, message_type: 1, message_state: 2, context_token: 'ctx-r1', item_list: [{ type: 1, text_item: { text: '重启前第一条' } }] };
const m2 = { seq: 2, message_id: '17912345678901999999', from_user_id: USER, message_type: 1, message_state: 2, context_token: 'ctx-r2', item_list: [{ type: 1, text_item: { text: '重启后第二条' } }] };

const calls = { qr: 0, updates: [], sends: [], auth: [] };
let round = 0;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let raw = '';
  for await (const chunk of req) raw += chunk.toString('utf8');
  const body = raw ? JSON.parse(raw) : {};
  const reply = (value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  calls.auth.push({ path: url.pathname, authorization: String(req.headers.authorization || '') });
  if (url.pathname === '/ilink/bot/get_bot_qrcode') { calls.qr += 1; return reply({ qrcode: 'QR-R1', qrcode_img_content: 'https://example.invalid/r1' }); }
  if (url.pathname === '/ilink/bot/get_qrcode_status') {
    calls.qrStatus = (calls.qrStatus || 0) + 1;
    if (calls.qrStatus < 2) return reply({ status: 'scaned' });
    return reply({ status: 'confirmed', bot_token: TOKEN, ilink_bot_id: BOT_ID, baseurl: 'http://127.0.0.1:' + server.address().port, ilink_user_id: USER });
  }
  if (url.pathname === '/ilink/bot/getupdates') {
    calls.updates.push(body.get_updates_buf);
    round += 1;
    if (round === 1) return reply({ ret: 0, msgs: [m1], get_updates_buf: 'c1' });
    if (round === 2) return reply({ ret: 0, msgs: [m1, m2], get_updates_buf: 'c2' });
    return reply({ ret: 0, msgs: [], get_updates_buf: 'c2' });
  }
  if (url.pathname === '/ilink/bot/sendmessage') { calls.sends.push(body); return reply({ ret: 0, message_id: 910000000000000000 + calls.sends.length }); }
  if (url.pathname === '/ilink/bot/getconfig') return reply({ ret: 0, typing_ticket: 't' });
  if (url.pathname === '/ilink/bot/sendtyping') return reply({ ret: 0 });
  if (url.pathname === '/ilink/bot/msg/notifystart' || url.pathname === '/ilink/bot/msg/notifystop') return reply({ ret: 0 });
  res.writeHead(404); res.end('{}');
});

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });

const port = await listen(server);
const baseUrl = 'http://127.0.0.1:' + port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-restart-'));
const quiet = () => {};

try {
  // ---- 阶段 1：进程 A 登录 + 收第 1 条 ----
  const logged = await login({ baseUrl, dir, out: quiet, pollIntervalMs: 5, write: () => {} });
  check('进程A：登录成功并落盘', logged.ok === true);
  const beforeRestart = loadSession(dir);
  check('进程A：会话含 token/botId/baseUrl', Boolean(beforeRestart.botToken === TOKEN && beforeRestart.botId === BOT_ID && beforeRestart.baseUrl === baseUrl));

  const runA = await run({ session: beforeRestart, dir, baseUrl, out: quiet, autoEcho: true, limit: 1, seen: [], cursor: '' });
  check('进程A：收到 1 条并回执', runA.inbound === 1 && runA.sendOk === 1, JSON.stringify({ inbound: runA.inbound, ok: runA.sendOk }));
  check('进程A：游标已持久化', runA.lastCursor === 'c1', runA.lastCursor);

  const afterA = loadSession(dir);
  check('进程A：lastPeer 已持久化（含 context_token）', Boolean(afterA.lastPeer && afterA.lastPeer.to === USER && afterA.lastPeer.contextToken === 'ctx-r1'));
  check('进程A：seen 表已持久化', loadSeen(dir).includes(BIG));
  const qrCallsAfterA = calls.qr;

  // ---- 阶段 2：进程 B（模拟重启）只从磁盘取状态 ----
  const freshSession = loadSession(dir);          // 没有任何内存状态被传递
  const freshSeen = loadSeen(dir);
  check('进程B：从磁盘恢复会话，无需重新扫码', Boolean(freshSession && freshSession.botToken === TOKEN && calls.qr === qrCallsAfterA), 'qr calls=' + calls.qr);
  check('进程B：恢复的游标是重启前那一个', freshSession.cursor === 'c1', freshSession.cursor);

  calls.updates.length = 0;
  const runB = await run({ session: freshSession, dir, baseUrl, out: quiet, autoEcho: true, limit: 1, seen: freshSeen, cursor: freshSession.cursor });
  check('进程B：第一次轮询带的是持久化游标 c1', calls.updates[0] === 'c1', JSON.stringify(calls.updates[0]));
  check('进程B：重启前那条被去重（不重复投递）', runB.duplicates >= 1 && runB.inbound === 1, JSON.stringify({ inbound: runB.inbound, duplicates: runB.duplicates }));
  check('进程B：只回了重启后的那条', runB.sendOk === 1 && calls.sends.length === 2, 'sends=' + calls.sends.length);
  const secondSend = calls.sends[calls.sends.length - 1].msg;
  check('进程B：回执用的是重启后那条的 context_token', secondSend.context_token === 'ctx-r2', secondSend.context_token);

  // ---- 阶段 3：新进程直接发信（不需要新入站、不需要重新登录） ----
  const afterB = loadSession(dir);
  const sent = await sendText({ baseUrl, token: afterB.botToken, to: afterB.lastPeer.to, text: '重启后直接发信', contextToken: afterB.lastPeer.contextToken });
  check('重启后：用磁盘凭据直接发信成功', sent.ok === true, JSON.stringify({ ok: sent.ok, ret: sent.ret }));
  check('重启后：发送仍用同一个 Bearer token', calls.auth.filter((entry) => entry.path === '/ilink/bot/sendmessage').every((entry) => entry.authorization === 'Bearer ' + TOKEN));
  check('全程只登录过一次（qr 取码 1 次）', calls.qr === 1, 'qr=' + calls.qr);

  // ---- 文件面 ----
  const sessionFile = path.join(dir, 'session.json');
  const seenFile = path.join(dir, 'seen.json');
  check('session.json 与 seen.json 都在状态目录', fs.existsSync(sessionFile) && fs.existsSync(seenFile));
  const sessionText = fs.readFileSync(sessionFile, 'utf8');
  check('token 只出现在 session.json，不在 seen.json', sessionText.includes(TOKEN) && !fs.readFileSync(seenFile, 'utf8').includes(TOKEN));
  check('状态目录默认不在仓库内', !path.resolve(dir).startsWith(path.resolve(process.cwd())), dir);
  check('默认状态目录是用户目录下的 .Newmark', stateDir().includes('.Newmark'), stateDir());
} finally {
  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

const passed = checks.filter((entry) => entry.pass).length;
for (const entry of checks) console.log((entry.pass ? 'PASS  ' : 'FAIL  ') + entry.name + (entry.pass || !entry.detail ? '' : '  [' + entry.detail + ']'));
console.log('');
console.log('cross-restart: ' + passed + ' / ' + checks.length + ' PASS');
process.exitCode = passed === checks.length ? 0 : 1;