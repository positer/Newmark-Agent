#!/usr/bin/env node
/**
 * clawbot-demo - standalone WeChat ClawBot (iLink Bot API) probe.
 *
 * WHAT IT PROVES: whether a machine can bind a WeChat ClawBot by QR code, receive a
 * message the user sends from WeChat, and have the user receive a message we send back.
 * It is a THROWAWAY probe, not a NewMate channel: it does not touch the DSH plugin,
 * it keeps its own state under ~/.Newmark/clawbot-demo, and it answers with a fixed
 * echo so that both directions are observable from the phone.
 *
 * WHAT IT DOES NOT PROVE: that the WeChat side accepts a third-party client at all
 * (the environment check happens on the phone, not in the API). A binding that the
 * phone rejects shows up as a status that never leaves 'wait'.
 *
 * Protocol reference: @tencent-weixin/openclaw-weixin@2.4.10 (src/api/api.ts,
 * src/auth/login-qr.ts, src/messaging/send.ts). Field names and header values are
 * copied from that source; see ../docs/16-wechat-clawbot-newmate-channel.md.
 *
 * Usage:
 *   node clawbot-demo.mjs selftest             offline self-test (no WeChat, no network)
 *   node clawbot-demo.mjs login                print a QR code, wait for the scan
 *   node clawbot-demo.mjs run                  receive + auto-echo until Ctrl+C
 *   node clawbot-demo.mjs run --typing         also send typing indicators
 *   node clawbot-demo.mjs send "text"          send one message to the last peer
 *   node clawbot-demo.mjs status               show the saved session (no token)
 *   node clawbot-demo.mjs logout               delete the saved session
 *
 *   --base-url <url>   override the API base (used by the self-test)
 *   --no-echo          receive only, never answer
 *   --limit <n>        stop after n inbound messages
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeQrPng } from './qr-png.mjs';

/** Values copied from the official channel; changing them changes what the server sees. */
export const DEFAULTS = {
  baseUrl: 'https://ilinkai.weixin.qq.com',
  appId: 'bot',
  // 0x00MMNNPP: 2.4.10 -> (2<<16)|(4<<8)|10
  appVersion: 132106,
  channelVersion: '2.4.10',
  botAgent: 'NewmarkClawbotDemo/0.1.0 (standalone bidirectional probe)',
  longPollMs: 35000,
  apiTimeoutMs: 15000,
  lightTimeoutMs: 10000,
  maxTextChars: 4000,
  echoLimit: 40,
};

export const ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);

/* ------------------------------------------------------------------ state */

export function stateDir() {
  return path.join(os.homedir(), '.Newmark', 'clawbot-demo');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function sessionFile(dir = stateDir()) {
  return path.join(dir, 'session.json');
}

export function loadSession(dir = stateDir()) {
  try {
    const raw = fs.readFileSync(sessionFile(dir), 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Written 0600: the bot token is the ability to speak as this WeChat identity. */
export function saveSession(session, dir = stateDir()) {
  ensureDir(dir);
  const target = sessionFile(dir);
  const temporary = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

export function loadSeen(dir = stateDir()) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

export function saveSeen(list, dir = stateDir()) {
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'seen.json'), JSON.stringify(list.slice(-2000)), { mode: 0o600 });
}

/* --------------------------------------------------------------- parsing */

/**
 * Quote uint64 identifiers before JSON.parse sees them.
 *
 * message_id is a uint64 on the wire; JSON.parse rounds anything past 2^53, which turns
 * two different messages into the same id and breaks both dedupe and quoting. The
 * official client does the same rewrite (api.ts parseWeixinApiJson); this scanner only
 * touches real object keys, never text inside a JSON string.
 */
export function parseLossless(text) {
  let out = '';
  let i = 0;
  const isSpace = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';
  while (i < text.length) {
    if (text[i] !== '"') { out += text[i++]; continue; }
    // A string token: copy it verbatim, then decide whether it is an id FIELD name.
    const open = i;
    let j = i + 1;
    let escaped = false;
    while (j < text.length) {
      const c = text[j];
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') break;
      j++;
    }
    const token = text.slice(open + 1, j);
    out += text.slice(open, j + 1);
    i = j + 1;
    if (!ID_FIELDS.has(token)) continue;
    let k = i;
    while (k < text.length && isSpace(text[k])) k++;
    if (text[k] !== ':') continue;
    k++;
    while (k < text.length && isSpace(text[k])) k++;
    const digitsStart = k;
    while (k < text.length && text[k] >= '0' && text[k] <= '9') k++;
    const digits = text.slice(digitsStart, k);
    // Only a value too large for a double needs protection; shorter ids parse exactly.
    if (digits.length < 16) continue;
    out += text.slice(i, digitsStart) + '"' + digits + '"';
    i = k;
  }
  return JSON.parse(out);
}

export function mask(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return '(none)';
  return text.length <= 8 ? '****' : '****' + text.slice(-4);
}

export function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

export function newClientId() {
  return 'newmark-demo:' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}
/* --------------------------------------------------------------- headers */

/** Headers the server expects on every authenticated call (api.ts buildHeaders). */
export function buildHeaders(token) {
  const uin = crypto.randomBytes(4).readUInt32BE(0);
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(uin), 'utf8').toString('base64'),
    'iLink-App-Id': DEFAULTS.appId,
    'iLink-App-ClientVersion': String(DEFAULTS.appVersion),
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

export function buildBaseInfo() {
  return { channel_version: DEFAULTS.channelVersion, bot_agent: DEFAULTS.botAgent };
}

export function joinUrl(baseUrl, endpoint) {
  const base = String(baseUrl).endsWith('/') ? String(baseUrl) : String(baseUrl) + '/';
  return new URL(endpoint, base).toString();
}

/**
 * One HTTP call. Returns { status, ok, text, timedOut } and never throws on a timeout,
 * because a timed-out long poll is normal control flow (api.ts returns an empty reply).
 */
export async function request(options) {
  const { baseUrl, endpoint, method = 'POST', payload, token, timeoutMs = DEFAULTS.apiTimeoutMs } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const response = await fetch(joinUrl(baseUrl, endpoint), {
      method,
      headers: buildHeaders(token),
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text, timedOut: false };
  } catch (error) {
    if (error && error.name === 'AbortError') return { status: 0, ok: false, text: '', timedOut: true };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------- API */

export async function fetchQrCode({ baseUrl = DEFAULTS.baseUrl, localTokenList = [], timeoutMs } = {}) {
  const reply = await request({
    baseUrl,
    endpoint: 'ilink/bot/get_bot_qrcode?bot_type=3',
    payload: { local_token_list: localTokenList },
    timeoutMs: timeoutMs || DEFAULTS.apiTimeoutMs,
  });
  if (!reply.ok) throw new Error('get_bot_qrcode HTTP ' + reply.status + ': ' + reply.text.slice(0, 200));
  const body = parseLossless(reply.text);
  if (!body || typeof body.qrcode !== 'string') throw new Error('get_bot_qrcode: no qrcode in reply');
  return { qrcode: body.qrcode, qrcodeImgContent: String(body.qrcode_img_content || '') };
}

/** Long poll the scan status. A client timeout is reported as { status: 'wait' }. */
export async function pollQrStatus({ baseUrl = DEFAULTS.baseUrl, qrcode, verifyCode, timeoutMs } = {}) {
  let endpoint = 'ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode);
  if (verifyCode) endpoint += '&verify_code=' + encodeURIComponent(verifyCode);
  const reply = await request({ baseUrl, endpoint, method: 'GET', timeoutMs: timeoutMs || DEFAULTS.longPollMs });
  if (reply.timedOut) return { status: 'wait', timedOut: true };
  if (!reply.ok) return { status: 'wait', httpStatus: reply.status, error: reply.text.slice(0, 200) };
  return parseLossless(reply.text);
}

export async function getUpdates({ baseUrl, token, cursor = '', timeoutMs } = {}) {
  const reply = await request({
    baseUrl,
    endpoint: 'ilink/bot/getupdates',
    payload: { get_updates_buf: cursor || '', base_info: buildBaseInfo() },
    token,
    timeoutMs: timeoutMs || DEFAULTS.longPollMs,
  });
  if (reply.timedOut) return { ok: true, timedOut: true, resp: { ret: 0, msgs: [], get_updates_buf: cursor } };
  if (!reply.ok) return { ok: false, timedOut: false, status: reply.status, error: reply.text.slice(0, 300) };
  try {
    return { ok: true, timedOut: false, resp: parseLossless(reply.text) };
  } catch (error) {
    return { ok: false, timedOut: false, error: 'unparseable getupdates reply: ' + error.message };
  }
}

/** Mirrors the official judgement: a missing ret is NOT an error, a non-zero ret is. */
export async function sendText({ baseUrl, token, to, text, contextToken, clientId = newClientId() } = {}) {
  const value = String(text || '');
  if (!to) throw new Error('sendText needs a target user');
  if (value.length > DEFAULTS.maxTextChars) throw new Error('text longer than ' + DEFAULTS.maxTextChars);
  const payload = {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken || undefined,
      item_list: [{ type: 1, text_item: { text: value } }],
    },
    base_info: buildBaseInfo(),
  };
  const reply = await request({ baseUrl, endpoint: 'ilink/bot/sendmessage', payload, token, timeoutMs: DEFAULTS.apiTimeoutMs });
  if (!reply.ok) return { ok: false, clientId, httpStatus: reply.status, error: reply.text.slice(0, 300) };
  let body = null;
  try { body = parseLossless(reply.text); } catch { return { ok: false, clientId, error: 'unparseable sendmessage reply' }; }
  if (body && body.ret && body.ret !== 0) {
    return { ok: false, clientId, ret: body.ret, errmsg: body.errmsg || '', body };
  }
  return { ok: true, clientId, ret: body && body.ret, messageId: body && body.message_id, body, retMissing: !body || body.ret === undefined };
}

export async function getConfig({ baseUrl, token, ilinkUserId, contextToken } = {}) {
  const reply = await request({
    baseUrl,
    endpoint: 'ilink/bot/getconfig',
    payload: { ilink_user_id: ilinkUserId, context_token: contextToken || undefined, base_info: buildBaseInfo() },
    token,
    timeoutMs: DEFAULTS.lightTimeoutMs,
  });
  if (!reply.ok) return { ok: false, error: 'HTTP ' + reply.status };
  try { return { ok: true, ...parseLossless(reply.text) }; } catch (error) { return { ok: false, error: error.message }; }
}

export async function sendTyping({ baseUrl, token, ilinkUserId, typingTicket, status } = {}) {
  const reply = await request({
    baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    payload: { ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status, base_info: buildBaseInfo() },
    token,
    timeoutMs: DEFAULTS.lightTimeoutMs,
  });
  return { ok: reply.ok, status: reply.status, text: reply.text.slice(0, 200) };
}

export async function notifyChannel({ baseUrl, token, start = true } = {}) {
  const endpoint = start ? 'ilink/bot/msg/notifystart' : 'ilink/bot/msg/notifystop';
  const reply = await request({ baseUrl, endpoint, payload: { base_info: buildBaseInfo() }, token, timeoutMs: DEFAULTS.lightTimeoutMs });
  return { ok: reply.ok, status: reply.status };
}
/* ------------------------------------------------------------------- QR */

const require = createRequire(import.meta.url);

/** Render the QR in the terminal. Returns false when the vendored renderer is absent. */
export function renderQr(content, write = (s) => process.stdout.write(s)) {
  try {
    const qrcode = require('./vendor/qrcode-terminal/lib/main.js');
    return new Promise((resolve) => {
      qrcode.generate(String(content), { small: true }, (code) => {
        write(code + '\n');
        resolve(true);
      });
    });
  } catch (error) {
    return Promise.resolve(false);
  }
}

/* ---------------------------------------------------------------- login */

const LOGIN_DEADLINE_MS = 8 * 60 * 1000;
const MAX_QR_REFRESH = 3;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const value = await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();
  return String(value || '').trim();
}

/**
 * Bind this machine to a WeChat ClawBot.
 * Returns { ok, session } or { ok: false, reason }.
 * Every status is printed: a binding the phone rejects shows up as status 'wait' forever,
 * which is the honest outcome and must not be reported as success.
 */
export async function login(options = {}) {
  const out = options.out || ((line) => console.log(line));
  const dir = options.dir || stateDir();
  let baseUrl = options.baseUrl || DEFAULTS.baseUrl;
  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  let refreshCount = 0;
  const qrImage = options.qrImage || '';
  const paint = () => { if (!qrImage) return; try { const info = writeQrPng(qr.qrcodeImgContent, qrImage); out('   （二维码图片已写入 ' + info.file + '，' + info.side + 'px）'); } catch (error) { out('   （PNG 写入失败：' + error.message + '；用终端码或链接）'); } };
  let qr = await fetchQrCode({ baseUrl });
  paint();
  for (;;) {
    out('');
    out('[1/2] 二维码内容（也可把下面的链接用手机打开）：');
    out(qr.qrcodeImgContent || '(服务器没有返回 qrcode_img_content)');
    const rendered = await renderQr(qr.qrcodeImgContent, (chunk) => {
      if (options.write) options.write(chunk); else process.stdout.write(chunk);
    });
    if (!rendered) out('（终端二维码渲染器不可用；请用上面的链接）');
    out('扫码路径：微信 → 我 → 设置 → 插件 → 微信 ClawBot → 扫描二维码');
    out('[2/2] 等待扫码…（二维码 ' + Math.round(LOGIN_DEADLINE_MS / 60000) + ' 分钟内有效）');

    let pendingVerifyCode;
    let scanned = false;
    let expired = false;
    while (Date.now() < deadline) {
      const status = await pollQrStatus({ baseUrl, qrcode: qr.qrcode, verifyCode: pendingVerifyCode });
      const name = status && status.status;
      if (name === 'wait') { await sleep(options.pollIntervalMs === undefined ? 1000 : options.pollIntervalMs); continue; }
      if (name === 'scaned') {
        if (pendingVerifyCode) pendingVerifyCode = undefined;
        if (!scanned) { scanned = true; out('  已扫码，正在验证…'); }
        await sleep(1000);
        continue;
      }
      if (name === 'need_verifycode') {
        if (process.stdin.isTTY !== true) {
          out('  服务端要求配对码，但当前不是交互终端。请在前台终端运行 login 并输入数字。');
          return { ok: false, reason: 'verify_code_required', baseUrl };
        }
        pendingVerifyCode = await ask('  输入手机微信上显示的配对数字：');
        continue;
      }
      if (name === 'verify_code_blocked') { out('  多次输入错误，需要重新扫码。'); expired = true; break; }
      if (name === 'expired') { out('  二维码已过期。'); expired = true; break; }
      if (name === 'scaned_but_redirect') {
        if (status.redirect_host) { baseUrl = 'https://' + status.redirect_host; out('  服务端切换接入点：' + baseUrl); }
        await sleep(1000);
        continue;
      }
      if (name === 'binded_redirect') {
        out('  这个微信号已经绑定过本机（binded_redirect），本次不会再发凭据。');
        out('  若要重新绑定，请先在手机微信里解绑，或在删除本机会话后重试。');
        return { ok: false, reason: 'already_bound', baseUrl };
      }
      if (name === 'confirmed') {
        if (!status.ilink_bot_id) return { ok: false, reason: 'no_ilink_bot_id', body: status };
        const session = {
          savedAt: new Date().toISOString(),
          botToken: status.bot_token || '',
          botId: status.ilink_bot_id,
          ilinkUserId: status.ilink_user_id || '',
          baseUrl: status.baseurl || baseUrl,
          qrcode: qr.qrcode,
          cursor: '',
          lastPeer: null,
        };
        if (!session.botToken) return { ok: false, reason: 'no_bot_token', body: status };
        const file = saveSession(session, dir);
        out('');
        out('✅ 已绑定。');
        out('   bot_id       ' + session.botId);
        out('   bot_token    ' + mask(session.botToken) + '（已写入 ' + file + '，仅本人可读）');
        out('   api base     ' + session.baseUrl);
        out('   ilink user   ' + mask(session.ilinkUserId));
        return { ok: true, session, file };
      }
      await sleep(1000);
    }
    if (!expired) return { ok: false, reason: 'timeout', baseUrl };
    refreshCount += 1;
    if (refreshCount > MAX_QR_REFRESH) return { ok: false, reason: 'qr_refresh_limit', baseUrl };
    qr = await fetchQrCode({ baseUrl });
    paint();
  }
}

/* ------------------------------------------------------------------ run */

function textOf(message) {
  const items = Array.isArray(message && message.item_list) ? message.item_list : [];
  const textItem = items.find((item) => item && item.type === 1);
  return textItem && textItem.text_item && typeof textItem.text_item.text === 'string' ? textItem.text_item.text : '';
}

function shorter(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length <= limit ? value : value.slice(0, limit) + '…';
}

export function echoText(index, text) {
  return '收到第 ' + index + ' 条：「' + shorter(text, DEFAULTS.echoLimit) + '」（clawbot-demo 双向探测回执）';
}

/**
 * Receive loop with auto-echo. Stops on -14, on --limit, on three consecutive network
 * failures, or when shouldStop() returns true. Returns a summary of what was measured.
 */
export async function run(options = {}) {
  const out = options.out || ((line) => console.log(line));
  const session = options.session;
  const dir = options.dir || stateDir();
  const autoEcho = options.autoEcho !== false;
  const typing = options.typing === true;
  const limit = Number(options.limit || 0);
  const baseUrl = options.baseUrl || session.baseUrl || DEFAULTS.baseUrl;
  const longPollMs = options.longPollMs;
  const seen = new Set(options.seen || loadSeen(dir));
  let cursor = options.cursor !== undefined ? options.cursor : (session.cursor || '');
  let peer = session.lastPeer || null;
  let typingTicket = '';
  const summary = {
    started: new Date().toISOString(),
    inbound: 0, duplicates: 0, ignored: 0, echoed: 0,
    sendOk: 0, sendFailed: 0, polls: 0, timeouts: 0, networkErrors: 0,
    stopReason: 'running', lastCursor: cursor, peers: new Set(),
  };

  const started = await notifyChannel({ baseUrl, token: session.botToken, start: true }).catch(() => ({ ok: false }));
  out('恢复会话：savedAt=' + (session.savedAt || '(未知)') + '，bot_id=' + (session.botId || '(未知)') + '，从游标 ' + (cursor ? cursor.slice(0, 18) + '…' : '(空，从头开始)') + ' 继续');
  out('已去重 id：' + seen.size + ' 条（来自本地 seen.json，跨重启保留）');
  out('通知服务端上线（notifystart）：' + (started.ok ? 'ok' : '失败（不影响收发探测）'));
  out('开始长轮询 getupdates：' + baseUrl + '（Ctrl+C 停止）');
  out('提示：微信里给这个 ClawBot 发一句话，本机会打印并自动回一条纯文本回执。');

  let consecutiveErrors = 0;
  while (!options.shouldStop || !options.shouldStop()) {
    summary.polls += 1;
    const poll = await getUpdates({ baseUrl, token: session.botToken, cursor, timeoutMs: longPollMs });
    if (poll.timedOut) { summary.timeouts += 1; continue; }
    if (!poll.ok) {
      summary.networkErrors += 1;
      consecutiveErrors += 1;
      out('! getupdates 失败：' + (poll.error || ('HTTP ' + poll.status)));
      if (consecutiveErrors >= 3) { summary.stopReason = 'network'; break; }
      await sleep(1000 * consecutiveErrors);
      continue;
    }
    consecutiveErrors = 0;
    const resp = poll.resp || {};
    const code = resp.errcode !== undefined ? resp.errcode : resp.ret;
    if (code === -14) {
      out('! errcode=-14：账号被服务端暂停（官方口径 1 小时）。停止发送，避免加重风控。');
      summary.stopReason = 'session_paused';
      break;
    }
    if (code && code !== 0) {
      out('! getupdates 返回 ret=' + code + ' ' + (resp.errmsg || ''));
      await sleep(1000);
      continue;
    }
    if (typeof resp.get_updates_buf === 'string' && resp.get_updates_buf) cursor = resp.get_updates_buf;
    summary.lastCursor = cursor;

    const messages = Array.isArray(resp.msgs) ? resp.msgs : [];
    for (const message of messages) {
      const id = String(message.message_id !== undefined ? message.message_id : (message.seq !== undefined ? message.seq : ''));
      const from = String(message.from_user_id || '');
      const kind = Number(message.message_type);
      const state = Number(message.message_state);
      const text = textOf(message);
      if (kind !== 1) { summary.ignored += 1; continue; }
      if (!text) { summary.ignored += 1; out('  (跳过：非文本消息 id=' + id + ')'); continue; }
      if (id && seen.has(id)) { summary.duplicates += 1; out('  (重复投递，已忽略 id=' + id + ')'); continue; }
      if (id) { seen.add(id); saveSeen([...seen], dir); }
      summary.inbound += 1;
      summary.peers.add(from);
      peer = { to: from, contextToken: message.context_token || '', at: new Date().toISOString() };
      out('');
      out('⬇ 收到第 ' + summary.inbound + ' 条 ' + nowStamp() + '  from=' + mask(from) + ' state=' + state);
      out('   id=' + id);
      out('   内容：' + shorter(text, 200));
      out('   context_token=' + mask(message.context_token || ''));

      if (autoEcho) {
        if (typing) {
          if (!typingTicket) {
            const config = await getConfig({ baseUrl, token: session.botToken, ilinkUserId: session.ilinkUserId, contextToken: message.context_token });
            typingTicket = (config && config.typing_ticket) || '';
          }
          if (typingTicket) {
            await sendTyping({ baseUrl, token: session.botToken, ilinkUserId: session.ilinkUserId, typingTicket, status: 1 }).catch(() => ({}));
          }
        }
        const reply = echoText(summary.inbound, text);
        const sent = await sendText({
          baseUrl, token: session.botToken, to: from, text: reply,
          contextToken: message.context_token || '',
        }).catch((error) => ({ ok: false, error: error.message }));
        if (sent.ok) {
          summary.echoed += 1; summary.sendOk += 1;
          out('⬆ 已回执 ' + nowStamp() + '  client_id=' + sent.clientId + (sent.messageId ? ' message_id=' + sent.messageId : '') + (sent.retMissing ? '（注意：响应缺少 ret）' : ''));
        } else {
          summary.sendFailed += 1;
          out('⬆ 回执失败：ret=' + (sent.ret === undefined ? '(none)' : sent.ret) + ' ' + (sent.errmsg || sent.error || ''));
        }
        if (typing && typingTicket) {
          await sendTyping({ baseUrl, token: session.botToken, ilinkUserId: session.ilinkUserId, typingTicket, status: 2 }).catch(() => ({}));
        }
      }
      if (limit && summary.inbound >= limit) { summary.stopReason = 'limit'; break; }
    }
    if (limit && summary.inbound >= limit) break;
    if (options.onPeer) options.onPeer(peer);
  }

  if (session.lastPeer !== peer) { session.lastPeer = peer; session.cursor = cursor; try { saveSession(session, dir); } catch {} }
  await notifyChannel({ baseUrl, token: session.botToken, start: false }).catch(() => ({}));
  summary.finished = new Date().toISOString();
  return summary;
}
/* ------------------------------------------------------------- selftest */

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/**
 * Offline self-test: a fake iLink server on 127.0.0.1 exercises the real client code.
 * It proves the CLIENT, not WeChat: request shapes, cursor handling, dedupe, -14, ret=-2,
 * timeouts, and that the token never reaches stdout.
 */
export async function selftest(options = {}) {
  const out = options.out || ((line) => console.log(line));
  const calls = { qr: 0, status: 0, updates: 0, send: [], typing: 0, config: 0, start: 0, stop: 0, requests: [] };
  const TOKEN = 'DEMO-TOKEN-0123456789abcdef0123456789abcdef';
  const BOT_ID = 'demo-bot-id@im.bot';
  const USER_ID = 'demo-user-id@im.wechat';
  const BIG_ID = '17912345678901234567';
  const m1 = { seq: 1, message_id: BIG_ID, from_user_id: USER_ID, message_type: 1, message_state: 2, context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: '你好，这是来自微信的第一条测试消息' } }] };
  const m2 = { seq: 2, message_id: '17912345678901234567', from_user_id: USER_ID, message_type: 1, message_state: 2, context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: '重复投递' } }] };
  const m3 = { seq: 3, message_id: '17912345678901999999', from_user_id: USER_ID, message_type: 1, message_state: 2, context_token: 'ctx-2', item_list: [{ type: 1, text_item: { text: '第二条不同 id 的消息' } }] };
  let updateRound = 0;
  let sendRound = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = '';
    for await (const chunk of req) raw += chunk.toString('utf8');
    const body = raw ? JSON.parse(raw) : {};
    calls.requests.push({ path: url.pathname, method: req.method, headers: req.headers, body });
    const reply = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    try {
      if (url.pathname === '/ilink/bot/get_bot_qrcode') {
        calls.qr += 1;
        if (body.local_token_list === undefined) return reply({ ret: -1, errmsg: 'missing local_token_list' });
        return reply({ qrcode: 'QR-DEMO-1', qrcode_img_content: 'https://example.invalid/bind?qr=QR-DEMO-1' });
      }
      if (url.pathname === '/ilink/bot/get_qrcode_status') {
        calls.status += 1;
        if (url.searchParams.get('qrcode') !== 'QR-DEMO-1') return reply({ status: 'wait' });
        if (calls.status === 1) return reply({ status: 'wait' });
        if (calls.status === 2) return reply({ status: 'scaned' });
        return reply({ status: 'confirmed', bot_token: TOKEN, ilink_bot_id: BOT_ID, baseurl: 'http://127.0.0.1:' + server.address().port, ilink_user_id: USER_ID });
      }
      if (url.pathname === '/ilink/bot/getupdates') {
        calls.updates += 1;
        updateRound += 1;
        if (updateRound === 1) { await sleep(1200); return reply({ ret: 0, msgs: [], get_updates_buf: 'boot' }); }
        if (updateRound === 2) return reply({ ret: 0, msgs: [m1, m2], get_updates_buf: 'cur-1' });
        if (updateRound === 3) return reply({ ret: 0, msgs: [m1, m3], get_updates_buf: 'cur-2' });
        return reply({ ret: 0, errcode: -14, errmsg: 'session paused', msgs: [], get_updates_buf: 'cur-2' });
      }
      if (url.pathname === '/ilink/bot/sendmessage') {
        sendRound += 1;
        calls.send.push(body);
        if (sendRound === 1) return reply({ ret: -2, errmsg: 'rate limited' });
        return reply({ ret: 0, message_id: 900000000000000000 + sendRound });
      }
      if (url.pathname === '/ilink/bot/getconfig') { calls.config += 1; return reply({ ret: 0, typing_ticket: 'ticket-1' }); }
      if (url.pathname === '/ilink/bot/sendtyping') { calls.typing += 1; return reply({ ret: 0 }); }
      if (url.pathname === '/ilink/bot/msg/notifystart') { calls.start += 1; return reply({ ret: 0 }); }
      if (url.pathname === '/ilink/bot/msg/notifystop') { calls.stop += 1; return reply({ ret: 0 }); }
      return reply({ ret: -1, errmsg: 'unknown endpoint ' + url.pathname }, 404);
    } catch (error) {
      return reply({ ret: -1, errmsg: error.message }, 500);
    }
  });

  const port = await listen(server);
  const baseUrl = 'http://127.0.0.1:' + port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-selftest-'));
  const lines = [];
  const collect = (line) => { const text = String(line); lines.push(text); out(text); };
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });

  try {
    const logged = await login({ baseUrl, dir, out: collect, pollIntervalMs: 5, write: () => {} });
    check('login: confirmed and session saved', logged.ok === true, logged.ok ? '' : JSON.stringify(logged.reason));
    const saved = loadSession(dir);
    check('login: token stored', Boolean(saved && saved.botToken === TOKEN));
    check('login: qr content rendered from server payload', lines.some((line) => line.includes('example.invalid/bind')), 'link echoed');
    check('login: token never printed', !lines.some((line) => line.includes(TOKEN)), 'masked only');

    const summary = await run({
      session: saved, dir, baseUrl, out: collect, autoEcho: true, typing: true, longPollMs: 400,
      seen: [], cursor: '',
      shouldStop: () => false,
    });

    check('run: inbound counted (2 unique messages)', summary.inbound === 2, 'inbound=' + summary.inbound);
    check('run: duplicate message_id ignored', summary.duplicates >= 1, 'duplicates=' + summary.duplicates);
    check('run: long-poll timeout is not an error', summary.timeouts >= 1, 'timeouts=' + summary.timeouts);
    check('run: cursor advanced to last response', summary.lastCursor === 'cur-2', 'cursor=' + summary.lastCursor);
    check('run: one send rejected with ret=-2', summary.sendFailed === 1, 'failed=' + summary.sendFailed);
    check('run: second send succeeded', summary.sendOk === 1, 'ok=' + summary.sendOk);
    check('run: stopped on errcode=-14', summary.stopReason === 'session_paused', 'reason=' + summary.stopReason);
    check('run: notifystart / notifystop called', calls.start === 1 && calls.stop === 1);
    check('run: typing indicators sent', calls.typing >= 2, 'typing=' + calls.typing);

    const updateRequests = calls.requests.filter((entry) => entry.path === '/ilink/bot/getupdates');
    const firstKeys = Object.keys(updateRequests[0] && updateRequests[0].body || {}).sort();
    check('getupdates: request body has only cursor + base_info', firstKeys.join(',') === 'base_info,get_updates_buf', firstKeys.join(','));
    check('getupdates: first poll sends an empty cursor', (updateRequests[0] || {}).body.get_updates_buf === '', JSON.stringify((updateRequests[0] || {}).body.get_updates_buf));
    check('getupdates: a later poll resends the cursor the server returned', updateRequests.some((entry) => entry.body.get_updates_buf === 'cur-1'), updateRequests.map((entry) => JSON.stringify(entry.body.get_updates_buf)).join(' -> '));

    const first = calls.send[0] && calls.send[0].msg;
    check('sendmessage: from_user_id is empty', first && first.from_user_id === '', String(first && first.from_user_id));
    check('sendmessage: message_type=2 / state=2', first && first.message_type === 2 && first.message_state === 2);
    check('sendmessage: context_token echoed from inbound', first && first.context_token === 'ctx-1', String(first && first.context_token));
    check('sendmessage: exactly one text item', first && Array.isArray(first.item_list) && first.item_list.length === 1 && first.item_list[0].type === 1);
    check('sendmessage: reply is the plain echo', first && first.item_list[0].text_item.text.indexOf('收到第 1 条') === 0, first && first.item_list[0].text_item.text);
    check('sendmessage: base_info present', Boolean(calls.send[0] && calls.send[0].base_info && calls.send[0].base_info.channel_version));

    const authenticated = calls.requests.find((entry) => String(entry.headers.authorization || '').indexOf('Bearer ') === 0);
    const headerSample = authenticated ? authenticated.headers : {};
    check('headers: AuthorizationType + Bearer token', headerSample.authorizationtype === 'ilink_bot_token' && String(headerSample.authorization || '').indexOf('Bearer ') === 0);
    check('headers: X-WECHAT-UIN is base64 of a uint32', (() => {
      const value = String(headerSample['x-wechat-uin'] || '');
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      return /^[0-9]+$/.test(decoded) && Number(decoded) <= 4294967295;
    })(), String(headerSample['x-wechat-uin']));
    check('headers: iLink-App-Id = bot, ClientVersion = 132106', headerSample['ilink-app-id'] === 'bot' && headerSample['ilink-app-clientversion'] === '132106');

    const parsed = parseLossless(JSON.stringify({ message_id: BIG_ID, text: 'x', nested: { svr_id: BIG_ID } }));
    check('parseLossless: uint64 message_id kept exact', String(parsed.message_id) === BIG_ID && String(parsed.nested.svr_id) === BIG_ID, String(parsed.message_id));
    check('parseLossless: numbers inside strings untouched', (() => { try { return parseLossless('{"text":"a message_id: 17912345678901234567 b"}').text === 'a message_id: 17912345678901234567 b'; } catch { return false; } })());

    const overlong = 'x'.repeat(DEFAULTS.maxTextChars + 1);
    let refused = false;
    try { await sendText({ baseUrl, token: TOKEN, to: USER_ID, text: overlong }); } catch { refused = true; }
    check('sendText: refuses text over ' + DEFAULTS.maxTextChars + ' chars', refused);
  } finally {
    server.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  const passed = checks.filter((entry) => entry.pass).length;
  out('');
  for (const entry of checks) out((entry.pass ? 'PASS  ' : 'FAIL  ') + entry.name + (entry.pass || !entry.detail ? '' : '  [' + entry.detail + ']'));
  out('');
  out('selftest: ' + passed + ' / ' + checks.length + ' PASS');
  return { ok: passed === checks.length, passed, total: checks.length, checks };
}
/* ------------------------------------------------------------------- CLI */

export function usage() {
  return [
    'clawbot-demo — 微信 ClawBot（iLink）双向探测 demo',
    '',
    '命令：',
    '  selftest            离线自检（假 iLink 服务端，不联网、不需要微信）',
    '  login               生成二维码并等待扫码绑定',
    '  run                 长轮询收消息，并自动回一条纯文本回执',
    '  send <文本>         给上一条入站消息的发送者发一条（需要已有 context_token）',
    '  status              查看本机会话（不打印 token）',
    '  logout              删除本机会话',
    '',
    '选项：',
    '  --base-url <url>    覆盖 API 基址（自检用）',
    '  --no-echo           run 时只收不回',
    '  --typing            run 时同时发“正在输入”',
    '  --limit <n>         收到 n 条后停止',
    '  --qr-png <路径>     login 时同时把二维码写成 PNG（给网页界面用）',
    '',
    '先在微信里完成：我 → 设置 → 插件 → 微信 ClawBot（若没有该入口，说明未灰度到，绑定不会成功）。',
  ].join('\n');
}

export function parseArgv(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-echo') flags.autoEcho = false;
    else if (arg === '--typing') flags.typing = true;
    else if (arg === '--limit') { flags.limit = Number(argv[i + 1] || 0); i += 1; }
    else if (arg === '--base-url') { flags.baseUrl = argv[i + 1]; i += 1; }
    else if (arg === '--qr-png') { flags.qrPng = argv[i + 1]; i += 1; }
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--')) flags[arg.slice(2)] = true;
    else rest.push(arg);
  }
  return { flags, rest };
}

function report(summary) {
  console.log('');
  console.log('=== 探测结果 ===');
  console.log('收到入站消息      ' + summary.inbound + ' 条');
  console.log('重复投递（已忽略）' + summary.duplicates + ' 条');
  console.log('非文本/跳过       ' + summary.ignored + ' 条');
  console.log('回执成功 / 失败   ' + summary.sendOk + ' / ' + summary.sendFailed);
  console.log('轮询次数          ' + summary.polls + '（其中客户端超时 ' + summary.timeouts + ' 次，属正常）');
  console.log('停止原因          ' + summary.stopReason);
  console.log('最后游标          ' + (summary.lastCursor || '(空)'));
  let verdict = '没有收到任何消息：请确认已扫码绑定成功，并在微信里给这个 ClawBot 发一条文本。';
  if (summary.inbound > 0 && summary.sendOk > 0) verdict = '双向连通：收到了微信消息，且我们的回执也发出成功（请在微信里确认能看到回执）。';
  else if (summary.inbound > 0) verdict = '只收不发：收到了消息，但回执全部失败（看上面的 ret/errmsg）。';
  else if (summary.stopReason === 'session_paused') verdict = '账号被服务端暂停（-14），需要等冷却后重新扫码。';
  console.log('判定              ' + verdict);
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, rest } = parseArgv(argv);
  const command = rest[0] || 'help';
  if (flags.help || command === 'help' || command === '--help') { console.log(usage()); return 0; }

  if (command === 'selftest') {
    const result = await selftest();
    return result.ok ? 0 : 1;
  }

  if (command === 'login') {
    const result = await login({ baseUrl: flags.baseUrl, qrImage: flags.qrPng });
    if (!result.ok) {
      console.log('绑定未完成：' + result.reason);
      return 1;
    }
    return 0;
  }

  if (command === 'status') {
    const session = loadSession();
    if (!session) { console.log('没有会话：先运行 node clawbot-demo.mjs login'); return 1; }
    console.log('bot_id      ' + session.botId);
    console.log('bot_token   ' + mask(session.botToken));
    console.log('api base    ' + session.baseUrl);
    console.log('ilink user  ' + mask(session.ilinkUserId));
    console.log('saved at    ' + session.savedAt);
    console.log('cursor      ' + (session.cursor || '(空)'));
    console.log('last peer   ' + (session.lastPeer ? mask(session.lastPeer.to) : '(无)'));
    console.log('seen ids    ' + loadSeen().length);
    return 0;
  }

  if (command === 'logout') {
    const dir = stateDir();
    let removed = 0;
    for (const name of ['session.json', 'seen.json']) {
      const target = path.join(dir, name);
      if (fs.existsSync(target)) { fs.rmSync(target, { force: true }); removed += 1; }
    }
    console.log('已删除本机会话文件 ' + removed + ' 个（服务端绑定仍需在手机微信里解除）');
    return 0;
  }

  if (command === 'send') {
    const session = loadSession();
    if (!session) { console.log('没有会话：先运行 login'); return 1; }
    const text = rest.slice(1).join(' ').trim();
    if (!text) { console.log('用法：node clawbot-demo.mjs send "要发送的文本"'); return 1; }
    const peer = session.lastPeer;
    if (!peer || !peer.to) {
      console.log('还没有入站消息，因此没有收件人和 context_token。请先 run 一次，等微信发来一句。');
      return 1;
    }
    const sent = await sendText({ baseUrl: session.baseUrl || DEFAULTS.baseUrl, token: session.botToken, to: peer.to, text, contextToken: peer.contextToken });
    if (sent.ok) { console.log('已发出 client_id=' + sent.clientId + (sent.messageId ? ' message_id=' + sent.messageId : '')); return 0; }
    console.log('发送失败：ret=' + (sent.ret === undefined ? '(none)' : sent.ret) + ' ' + (sent.errmsg || sent.error || ''));
    return 1;
  }

  if (command === 'run') {
    const session = loadSession();
    if (!session) { console.log('没有会话：先运行 node clawbot-demo.mjs login'); return 1; }
    let stopping = false;
    const interactive = process.stdin.isTTY === true;
    let rl = null;
    if (interactive) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log('交互：s <文本>=发一条  t=发一次正在输入  q=退出（Ctrl+C 立即退出）');
      rl.on('line', async (line) => {
        const value = String(line || '').trim();
        if (!value) return;
        if (value === 'q') { stopping = true; return; }
        if (value === 't') {
          const current = loadSession();
          const peer = current && current.lastPeer;
          if (!peer) { console.log('还没有收件人，先等一条微信消息。'); return; }
          const config = await getConfig({ baseUrl: current.baseUrl, token: current.botToken, ilinkUserId: current.ilinkUserId, contextToken: peer.contextToken }).catch(() => ({}));
          console.log('typing:', JSON.stringify(await sendTyping({ baseUrl: current.baseUrl, token: current.botToken, ilinkUserId: current.ilinkUserId, typingTicket: (config && config.typing_ticket) || '', status: 1 })));
          return;
        }
        if (value.startsWith('s ')) {
          const current = loadSession();
          const peer = current && current.lastPeer;
          if (!peer) { console.log('还没有收件人，先等一条微信消息。'); return; }
          const sent = await sendText({ baseUrl: current.baseUrl, token: current.botToken, to: peer.to, text: value.slice(2).trim(), contextToken: peer.contextToken });
          console.log(sent.ok ? '已发出 client_id=' + sent.clientId : '发送失败 ret=' + sent.ret + ' ' + (sent.errmsg || sent.error || ''));
        }
      });
    }
    const onSigint = () => { stopping = true; };
    process.once('SIGINT', onSigint);
    try {
      const summary = await run({
        session, autoEcho: flags.autoEcho !== false, typing: flags.typing === true,
        limit: flags.limit || 0, baseUrl: flags.baseUrl, shouldStop: () => stopping,
      });
      report(summary);
      return summary.stopReason === 'network' ? 1 : 0;
    } finally {
      process.removeListener('SIGINT', onSigint);
      if (rl) rl.close();
    }
  }

  console.log('未知命令：' + command + '\n');
  console.log(usage());
  return 1;
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error('demo 失败：' + (error && error.stack || error));
    process.exitCode = 1;
  });
}