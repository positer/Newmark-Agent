#!/usr/bin/env node
/**
 * clawbot-newmate - the WeChat ClawBot channel for NewMate.
 *
 * One sentence of behaviour, because the requirements are strict:
 *   a WeChat text message IS a message the user typed in the NewMate page, and the ONLY thing
 *   sent back to WeChat is the plain-text bubble version of NewMate's final reply.
 *
 * How each half achieves that WITHOUT touching NewMate's core code:
 *   in  - POST /newmark-newmate {action:'chat', text, threadId: <the page's active thread>}
 *         with the page's own header. That is byte-for-byte the request the page sends, so
 *         chat() decides start / steer / queue exactly as it does for a typed message.
 *   out - poll the run's task id and take message.plain (the bubble version) of the assistant
 *         message whose id === task.id. Never message.text (the rich UI version). Nothing else
 *         is ever forwarded: no typing, no tool progress, no proactive message, no other thread.
 *
 * Receipt confirmation (the user asked for it): the moment NewMate ACCEPTS a message, the
 * inbound message id is marked consumed in a persistent ledger and is never handed to NewMate
 * again - including after a restart, and including when iLink replays a batch because the
 * cursor went backwards. This is internal bookkeeping only: it is NOT a WeChat reply.
 *
 * Usage:
 *   node bridge.mjs                  run until Ctrl+C
 *   node bridge.mjs --limit 1        stop after one forwarded reply (handy for acceptance)
 *   node bridge.mjs --newmate-url http://127.0.0.1:<port>
 *   node bridge.mjs --status         show ledger counts (no message text)
 *   node bridge.mjs selftest         offline self-test, no WeChat and no DSH
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getUpdates, sendText, notifyChannel, mask, loadSession, stateDir as iLinkStateDir } from '../clawbot-demo/clawbot-demo.mjs';

export const BRIDGE_DIR_NAME = 'clawbot-newmate';
export const MAX_DELIVERY_ATTEMPTS = 2;   // one normal try + one retry after a crash/outage
export const REPLY_TIMEOUT_MS = 15 * 60 * 1000;
// A delivery retry waits this long, so a short NewMate outage does not burn the attempt budget
// in the first second of a long-poll loop.
export const DELIVERY_RETRY_MS = 2000;
export const REPLY_POLL_MS = 1000;

/* ------------------------------------------------------------------ state */

export function bridgeDir() {
  return path.join(os.homedir(), '.Newmark', BRIDGE_DIR_NAME);
}

export function stateFile(dir = bridgeDir()) {
  return path.join(dir, 'bridge.json');
}

export function emptyState() {
  return { schema: 1, cursor: '', ledger: {}, awaiting: {}, sent: {}, stats: { inbound: 0, acked: 0, skipped: 0, replies: 0, sendFailed: 0 } };
}

export function loadBridgeState(dir = bridgeDir()) {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));
    return { ...emptyState(), ...value, ledger: value.ledger || {}, awaiting: value.awaiting || {}, sent: value.sent || {} };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

/** One atomic write per batch: cursor and ledger move together, so a crash cannot advance one without the other. */
export function saveBridgeState(state, dir = bridgeDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = stateFile(dir);
  const temporary = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

/* ------------------------------------------------------- NewMate discovery */

function probe(url, timeoutMs = 400) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer.unref) timer.unref();
    fetch(url + '/newmark-newmate/loop', { signal: controller.signal })
      .then(async (response) => {
        const text = await response.text();
        resolve(response.ok && text.includes('agentLoop'));
      })
      .catch(() => resolve(false))
      .finally(() => clearTimeout(timer));
  });
}

/**
 * Candidate loopback ports for the NewMate host.
 *
 * Two sources, because neither is sufficient on its own: listener rows can be invisible to an
 * unelevated netstat (measured: this machine's DSH listener does not appear, while its
 * established connections do), and a foreign address only exists while a client is connected.
 * A wrong candidate costs one 400 ms probe, so collecting both is cheaper than being wrong.
 */
export function candidatePorts() {
  const ports = new Set();
  const add = (endpoint) => {
    const match = String(endpoint || '').match(/:(\d{2,5})$/);
    if (!match) return;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
  };
  try {
    const raw = process.platform === 'win32'
      ? execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
      : execFileSync('ss', ['-ltn'], { encoding: 'utf8', timeout: 4000 });
    for (const line of raw.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (process.platform === 'win32') {
        if (parts[0] !== 'TCP' || parts.length < 4) continue;
        const [, local, foreign, state] = parts;
        add(local);
        // A loopback peer means a local server is listening on that port.
        if (/^(127\.0\.0\.1|\[::1\]):/.test(foreign)) add(foreign);
        if (!/LISTEN/i.test(state) && !/^(127\.0\.0\.1|\[::1\])/.test(local)) { /* keep all: cheap */ }
      } else {
        const local = parts[3];
        add(local);
      }
    }
  } catch { /* discovery is best-effort; --newmate-url is the explicit path */ }
  return [...ports].slice(0, 400);
}

/** Probe candidates in parallel and return the first host that answers as NewMate. */
export async function discoverNewMate({ explicit, env = process.env } = {}) {
  const candidates = [];
  if (explicit) candidates.push(String(explicit).replace(/\/$/, ''));
  const fromEnv = env.DSH_WEB_URL || env.NEWMATE_URL;
  if (fromEnv) candidates.push(String(fromEnv).replace(/\/$/, ''));
  for (const url of candidates) if (await probe(url)) return url;
  const ports = candidatePorts();
  if (!ports.length) return '';
  const answers = await Promise.all(ports.map(async (port) => [port, await probe('http://127.0.0.1:' + port, 400)]));
  const hit = answers.find(([, ok]) => ok);
  return hit ? 'http://127.0.0.1:' + hit[0] : '';
}

/* ---------------------------------------------------------- NewMate client */

export function mcpTokenFile(dir) {
  return path.join(dir || path.join(os.homedir(), '.Newmark'), 'newMate', 'mcp-token');
}

export function readMcpToken(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function pageHeaders() {
  return { 'content-type': 'application/json', 'x-newmark-newmate': '1' };
}

/** Read the live NewMate state (the page reads the same payload). */
export async function newmateState({ baseUrl, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const response = await fetch(baseUrl + '/newmark-newmate', { signal: controller.signal });
    if (!response.ok) return { ok: false, error: 'HTTP ' + response.status };
    return { ok: true, state: await response.json() };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally { clearTimeout(timer); }
}

/**
 * Hand one WeChat text to NewMate exactly the way the page does.
 * threadId must be the ACTIVE thread: chat() rejects any other thread, and passing the same one
 * is what makes a WeChat message steer a running turn instead of aborting it.
 */
export async function deliverToNewMate({ baseUrl, text, threadId, timeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const response = await fetch(baseUrl + '/newmark-newmate', {
      method: 'POST',
      headers: pageHeaders(),
      body: JSON.stringify({ action: 'chat', text, threadId }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { return { ok: false, error: 'unparseable NewMate reply: ' + raw.slice(0, 120) }; }
    if (!response.ok || body.ok !== true) return { ok: false, error: body.error || ('HTTP ' + response.status) };
    return { ok: true, taskId: String(body.id || ''), mode: body.mode, inputId: body.inputId };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally { clearTimeout(timer); }
}
/* ------------------------------------------------------------ reply lookup */

import { toPlain } from '../../Newmark2DSH/packages/newmark-core/components/newmate/lib/reply-format.js';

/**
 * What may be shown outside the NewMate UI: message.plain (the bubble version).
 * toPlain() is NewMate's own fallback, imported so the two never drift.
 * message.text is the rich rendering and must NEVER be forwarded.
 */
export function bubbleText(message) {
  const plain = typeof message?.plain === 'string' ? message.plain.trim() : '';
  if (plain) return plain;
  return toPlain(message?.text || '');
}

async function mcpCall({ baseUrl, token, name, args, timeoutMs = 8000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const response = await fetch(baseUrl + '/newmark-newmate/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + token,
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: 'HTTP ' + response.status };
    const body = await response.json();
    if (body.error) return { ok: false, error: body.error.message || 'mcp error' };
    const structured = body.result?.structuredContent;
    if (structured) return { ok: true, value: structured };
    const text = body.result?.content?.[0]?.text;
    if (typeof text === 'string') { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, error: 'unparseable mcp content' }; } }
    return { ok: false, error: 'empty mcp result' };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally { clearTimeout(timer); }
}

/**
 * Read back one run: its task record and the assistant message whose id === task.id.
 * Two paths, both read-only: MCP newmate_task_status (small) and GET /newmark-newmate (fallback).
 */
export async function findReply({ baseUrl, mcpToken, taskId }) {
  if (mcpToken) {
    const call = await mcpCall({ baseUrl, token: mcpToken, name: 'newmate_task_status', args: { id: taskId } });
    if (call.ok && call.value) {
      const messages = Array.isArray(call.value.messages) ? call.value.messages : [];
      const reply = messages.find((message) => message && String(message.id) === String(taskId) && message.role === 'assistant');
      return { ok: true, via: 'mcp', task: call.value.task, reply: reply || null };
    }
  }
  const snapshot = await newmateState({ baseUrl });
  if (!snapshot.ok) return { ok: false, error: snapshot.error };
  const messages = Array.isArray(snapshot.state.messages) ? snapshot.state.messages : [];
  const reply = messages.find((message) => message && String(message.id) === String(taskId) && message.role === 'assistant');
  const task = (snapshot.state.tasks || []).find((entry) => String(entry.id) === String(taskId));
  return { ok: true, via: 'state', task, reply: reply || null };
}

/* ------------------------------------------------------------------- loop */

const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'paused']);

function textOfMessage(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  const textItem = items.find((item) => item && item.type === 1);
  return textItem?.text_item?.text || '';
}

function mute() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

export async function runBridge(options = {}) {
  const out = options.out || ((line) => console.log(line));
  const dir = options.dir || bridgeDir();
  const session = options.session;
  const newmateUrl = options.newmateUrl;
  const limit = Number(options.limit || 0);
  const mcpToken = options.mcpToken !== undefined ? options.mcpToken : readMcpToken(mcpTokenFile(options.iLinkRoot));
  const baseUrlIlink = options.baseUrl || session.baseUrl;
  const withLock = mute();
  const state = loadBridgeState(dir);
  if (!Array.isArray(state.pending)) state.pending = [];
  state.stats = state.stats || emptyState().stats;
  const stats = state.stats;
  let stopping = false;
  let polls = 0;
  const maxPolls = Number(options.maxPolls || 0);
  let lastThread = '';
  const save = () => saveBridgeState(state, dir);
  // First run: start from the cursor the iLink client already reached, so the messages that
  // were already handled while testing are not replayed into NewMate's history. Never skip by
  // time: a message sent while this process was down MUST still be delivered.
  if (!state.cursor && session && session.cursor) {
    state.cursor = session.cursor;
    save();
    out('沿用 clawbot-demo 的游标 ' + String(session.cursor).slice(0, 18) + '…（避免重放此前已处理的消息）');
  }
  const acked = (id) => Boolean(id && state.ledger[id] && state.ledger[id].state === 'acked');

  const first = await newmateState({ baseUrl: newmateUrl });
  if (!first.ok) throw new Error('NewMate 不可达（' + newmateUrl + '）：' + first.error);
  async function activeThread() {
    // chat() only accepts the ACTIVE thread; reading it just before delivery keeps that true,
    // and passing the same thread the page would pass is what makes this a steer, not an abort.
    const snapshot = await newmateState({ baseUrl: newmateUrl });
    return snapshot.ok ? String(snapshot.state.activeThreadId || '') : '';
  }
  out('NewMate: ' + newmateUrl + '（活动对话 ' + (first.state.activeThreadId || '?') + '，线程 ' + ((first.state.threads || []).length) + ' 个）');
  out('已接收(acked) ' + Object.keys(state.ledger).filter((id) => state.ledger[id].state === 'acked').length + ' 条 · 待投递 ' + state.pending.length + ' 条 · 待回复 ' + Object.keys(state.awaiting).length + ' 个');
  if (!mcpToken) out('提示：读不到 NewMate MCP token，回复改用 GET /newmark-newmate 轮询（等价但更重）');

  /** Queue one iLink batch: a message that was already confirmed is never queued again. */
  function queueBatch(messages) {
    for (const message of messages) {
      const id = String(message.message_id !== undefined ? message.message_id : (message.seq !== undefined ? message.seq : ''));
      const text = textOfMessage(message);
      const peer = String(message.from_user_id || '');
      if (Number(message.message_type) !== 1 || !text) { stats.skipped += 1; continue; }
      if (acked(id)) { stats.skipped += 1; out('  · 已确认接收过（id=' + id + '），不再投递给 NewMate'); continue; }
      if (state.pending.some((item) => item.id === id)) { out('  · id=' + id + ' 已在待投递队列，跳过重复入队'); continue; }
      state.pending.push({ id, text, peer, contextToken: String(message.context_token || ''), at: new Date().toISOString(), attempts: 0 });
      stats.inbound += 1;
      out('⬇ 微信 → NewMate：id=' + id + ' from=' + mask(peer) + '，正文：' + (text.length > 60 ? text.slice(0, 60) + '…' : text));
    }
  }

  /**
   * Deliver everything queued. The ledger write is the receipt: once NewMate answers ok,
   * that inbound id is marked consumed and is never handed over again - which is exactly the
   * "接收确认" the user asked for, and it is internal bookkeeping, not a WeChat reply.
   */
  async function drainPending() {
    if (!state.pending.length) return;
    for (const item of [...state.pending]) {
      if (state.pending.length === 0) break;
      if (item.lastAttempt && Date.now() - item.lastAttempt < DELIVERY_RETRY_MS) continue;
      const threadId = lastThread || (await activeThread());
      if (!threadId) { out('  ! 读不到 NewMate 活动对话，暂停投递（消息保留在队列里）'); return; }
      lastThread = threadId;
      item.attempts = Number(item.attempts || 0) + 1;
      item.lastAttempt = Date.now();
      const delivered = await deliverToNewMate({ baseUrl: newmateUrl, text: item.text, threadId });
      if (!delivered.ok) {
        if (item.attempts >= MAX_DELIVERY_ATTEMPTS) {
          state.ledger[item.id] = { state: 'failed', attempts: item.attempts, error: delivered.error, at: new Date().toISOString() };
          state.pending = state.pending.filter((entry) => entry.id !== item.id);
          out('  ! id=' + item.id + ' 投递失败 ' + item.attempts + ' 次，放弃（' + delivered.error + '）');
        } else {
          out('  ! id=' + item.id + ' NewMate 未接受：' + delivered.error + '（保留在队列，下轮重试）');
        }
        save();
        continue;
      }
      state.ledger[item.id] = { state: 'acked', attempts: item.attempts, taskId: delivered.taskId, mode: delivered.mode, threadId, at: new Date().toISOString() };
      state.pending = state.pending.filter((entry) => entry.id !== item.id);
      stats.acked += 1;
      if (delivered.taskId) {
        const previous = state.awaiting[delivered.taskId];
        state.awaiting[delivered.taskId] = {
          peer: item.peer,
          contextToken: item.contextToken || (previous && previous.contextToken) || '',
          threadId,
          at: (previous && previous.at) || new Date().toISOString(),
          tries: (previous && previous.tries) || 0,
        };
      }
      save();
      out('  ✓ NewMate 已接收（task=' + delivered.taskId + '，mode=' + delivered.mode + '），已标记为已读取');
    }
  }

  /** Replies out: only the final assistant message of a tracked task, only its plain bubble. */
  async function egressOnce() {
    for (const taskId of Object.keys(state.awaiting)) {
      const entry = state.awaiting[taskId];
      if (!entry) continue;
      if (Date.now() - Date.parse(entry.at || 0) > REPLY_TIMEOUT_MS) {
        delete state.awaiting[taskId]; save();
        out('  ! task=' + taskId + ' 等待回复超时，放弃转发（NewMate 里仍可见）');
        continue;
      }
      const found = await findReply({ baseUrl: newmateUrl, mcpToken, taskId });
      if (!found.ok) { out('  ! 读取 task=' + taskId + ' 失败：' + found.error); continue; }
      if (!found.reply) {
        if (found.task && TERMINAL.has(String(found.task.status))) {
          delete state.awaiting[taskId]; save();
          out('  · task=' + taskId + ' 已结束（' + found.task.status + '）但没有最终回复，不转发');
        }
        continue;
      }
      const replyText = bubbleText(found.reply);
      const sent = await sendText({
        baseUrl: baseUrlIlink,
        token: session.botToken,
        to: entry.peer,
        text: replyText,
        contextToken: entry.contextToken,
      });
      if (sent.ok) {
        delete state.awaiting[taskId];
        stats.replies += 1;
        state.sent[taskId] = { at: new Date().toISOString(), messageId: sent.messageId || null, chars: replyText.length };
        save();
        out('⬆ NewMate → 微信：task=' + taskId + (sent.messageId ? ' message_id=' + sent.messageId : '') + '（' + replyText.length + ' 字，纯文字气泡版）');
        out('   ' + replyText);
        if (limit && stats.replies >= limit) stopping = true;
      } else {
        stats.sendFailed += 1;
        entry.tries = Number(entry.tries || 0) + 1;
        state.awaiting[taskId] = entry;
        save();
        out('  ! 转发失败 ret=' + (sent.ret === undefined ? '(none)' : sent.ret) + ' ' + (sent.errmsg || sent.error || '') + '，保留待重试');
        if (entry.tries >= 3) { delete state.awaiting[taskId]; save(); out('  ! task=' + taskId + ' 连续发送失败，放弃'); }
      }
    }
  }

  const started = await notifyChannel({ baseUrl: baseUrlIlink, token: session.botToken, start: true }).catch(() => ({ ok: false }));
  out('通知服务端上线（notifystart）：' + (started.ok ? 'ok' : '失败（不影响收发）'));
  out('从游标 ' + (state.cursor ? String(state.cursor).slice(0, 18) + '…' : '(空)') + ' 继续轮询');

  const egressLoop = (async () => {
    while (!stopping) {
      await new Promise((resolve) => setTimeout(resolve, REPLY_POLL_MS));
      if (stopping) break;
      if (!Object.keys(state.awaiting).length) continue;
      await withLock(egressOnce).catch((error) => out('  ! 回复轮询异常：' + error.message));
    }
  })();

  let consecutive = 0;
  try {
    while (!stopping) {
      // Retry whatever NewMate has not confirmed yet, even when no new message arrives.
      if (state.pending.length) await withLock(drainPending).catch((error) => out('  ! 投递重试异常：' + error.message));
      if (stopping) break;
      polls += 1;
      if (maxPolls && polls > maxPolls) { stopping = true; break; }
      const poll = await getUpdates({ baseUrl: baseUrlIlink, token: session.botToken, cursor: state.cursor || '' });
      if (poll.timedOut) continue;
      if (!poll.ok) {
        consecutive += 1;
        out('! getupdates 失败：' + (poll.error || 'HTTP ' + poll.status));
        if (consecutive >= 3) { out('! 连续三次失败，退出'); break; }
        await new Promise((resolve) => setTimeout(resolve, 1000 * consecutive));
        continue;
      }
      consecutive = 0;
      const resp = poll.resp || {};
      const code = resp.errcode !== undefined ? resp.errcode : resp.ret;
      if (code === -14) { out('! errcode=-14：账号被服务端暂停（约 1 小时），停止。'); break; }
      if (code && code !== 0) { out('! getupdates ret=' + code + ' ' + (resp.errmsg || '')); await new Promise((r) => setTimeout(r, 1000)); continue; }
      await withLock(async () => {
        queueBatch(Array.isArray(resp.msgs) ? resp.msgs : []);
        await drainPending();
        if (typeof resp.get_updates_buf === 'string' && resp.get_updates_buf) state.cursor = resp.get_updates_buf;
        save();
      });
    }
  } finally {
    stopping = true;
    await egressLoop.catch(() => {});
    saveBridgeState(state, dir);
    await notifyChannel({ baseUrl: baseUrlIlink, token: session.botToken, start: false }).catch(() => ({}));
  }

  return { ...stats, awaiting: Object.keys(state.awaiting).length, pending: state.pending.length };
}
/* ------------------------------------------------------------------- CLI */

export function usage() {
  return [
    'clawbot-newmate — 微信 ClawBot ↔ NewMate 信道（不改 NewMate 核心代码）',
    '',
    '命令：',
    '  run（默认）          长轮询收微信消息 → 交给 NewMate（等同页面发信）→ 只把最终回复的纯文字气泡发回微信',
    '  status               查看桥的账本（已接收 / 待投递 / 待回复 / 已转发）',
    '  selftest             离线自检（假 iLink + 假 NewMate，不联网、不需要微信）',
    '',
    '选项：',
    '  --newmate-url <url>  NewMate 的 HTTP 基址（默认自动发现回环端口）',
    '  --limit <n>          转发 n 条最终回复后退出（验收用）',
    '  --mcp-token <token>  NewMate MCP token（默认读 ~/.Newmark/newMate/mcp-token）',
  ].join('\n');
}

export function parseArgv(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--newmate-url') { flags.newmateUrl = argv[i + 1]; i += 1; }
    else if (arg === '--limit') { flags.limit = Number(argv[i + 1] || 0); i += 1; }
    else if (arg === '--mcp-token') { flags.mcpToken = argv[i + 1]; i += 1; }
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else rest.push(arg);
  }
  return { flags, rest };
}

export function ledgerSummary(state) {
  const entries = Object.values(state.ledger || {});
  return {
    acked: entries.filter((entry) => entry.state === 'acked').length,
    failed: entries.filter((entry) => entry.state === 'failed').length,
    pending: (state.pending || []).length,
    awaiting: Object.keys(state.awaiting || {}).length,
    forwarded: Object.keys(state.sent || {}).length,
    cursor: state.cursor ? 'set' : 'empty',
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, rest } = parseArgv(argv);
  const command = rest[0] || 'run';
  if (flags.help || command === 'help') { console.log(usage()); return 0; }
  if (command === 'selftest') return selftest();

  if (command === 'status') {
    const state = loadBridgeState();
    console.log(JSON.stringify(ledgerSummary(state), null, 2));
    const session = loadSession();
    console.log('微信绑定：' + (session ? session.botId + '（token ' + mask(session.botToken) + '）' : '未绑定，先跑 clawbot-demo 的 login'));
    return 0;
  }

  if (command !== 'run') { console.log('未知命令：' + command); console.log(usage()); return 1; }

  const session = loadSession();
  if (!session) { console.log('没有微信绑定：先运行 node SCRIPTS/clawbot-demo/clawbot-demo.mjs login'); return 1; }
  const newmateUrl = flags.newmateUrl || await discoverNewMate();
  if (!newmateUrl) {
    console.log('找不到 NewMate：请确认 DSH 正在运行，或用 --newmate-url http://127.0.0.1:<端口> 指定。');
    return 1;
  }
  const summary = await runBridge({
    session, newmateUrl, limit: flags.limit || 0, mcpToken: flags.mcpToken,
  });
  console.log('');
  console.log('=== 桥的结果 ===');
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

/* -------------------------------------------------------------- selftest */

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function selftest() {
  const TOKEN = 'BRIDGE-TOKEN-0123456789abcdef0123456789abcdef';
  const USER = 'bridge-user@im.wechat';
  const RICH = '# 标题\n- 列表项\n`code`';
  const PLAIN = '好的，这是纯文字气泡版。';
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });
  const chatPosts = [];
  const sends = [];
  const ilink = { cursors: [], qr: 0 };
  let script = [];
  let cursor = 'cur-1';
  let replyReady = false;
  let newmateDown = false;
  let chatCounter = 0;
  let mode = 'start';

  const m1 = { seq: 1, message_id: '7520700000000000001', from_user_id: USER, message_type: 1, message_state: 2, context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: '第一条' } }] };
  const m2 = { seq: 2, message_id: '7520700000000000002', from_user_id: USER, message_type: 1, message_state: 2, context_token: 'ctx-2', item_list: [{ type: 1, text_item: { text: '第二条' } }] };
  const m3 = { seq: 3, message_id: '7520700000000000003', from_user_id: USER, message_type: 1, message_state: 2, context_token: 'ctx-3', item_list: [{ type: 1, text_item: { text: '第三条' } }] };

  const ilinkServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = '';
    for await (const chunk of req) raw += chunk.toString('utf8');
    const body = raw ? JSON.parse(raw) : {};
    const reply = (value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/ilink/bot/getupdates') {
      ilink.cursors.push(body.get_updates_buf);
      await sleep(60);
      const payload = script.length ? script.shift() : [];
      return reply({ ret: 0, msgs: payload, get_updates_buf: cursor });
    }
    if (url.pathname === '/ilink/bot/sendmessage') { sends.push(body); return reply({ ret: 0, message_id: 730000000000000000 + sends.length }); }
    if (url.pathname === '/ilink/bot/msg/notifystart' || url.pathname === '/ilink/bot/msg/notifystop') return reply({ ret: 0 });
    res.writeHead(404); res.end('{}');
  });

  const newmateServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = '';
    for await (const chunk of req) raw += chunk.toString('utf8');
    const body = raw ? JSON.parse(raw) : {};
    const reply = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/newmark-newmate/loop') return reply({ ok: true, agentLoop: { running: false } });
    if (url.pathname === '/newmark-newmate' && req.method === 'GET') {
      return reply({
        ok: true,
        activeThreadId: 'thread-A',
        threads: [{ id: 'thread-A', archived: false }],
        messages: [
          { id: 'proactive-1', threadId: 'thread-A', role: 'assistant', text: 'PROACTIVE-RICH', plain: 'PROACTIVE-PLAIN', proactive: true },
        ],
        tasks: [],
        settings: { companion: true },
      });
    }
    if (url.pathname === '/newmark-newmate' && req.method === 'POST') {
      if (req.headers['x-newmark-newmate'] !== '1') return reply({ ok: false, error: '请求来源无效' }, 400);
      chatPosts.push(body);
      if (newmateDown) return reply({ ok: false, error: 'down' }, 500);
      chatCounter += 1;
      const id = chatCounter <= 2 ? 'task-1' : 'task-' + chatCounter;
      if (chatCounter === 2) replyReady = true;
      // The real chat() reports 'steer' when a run is already in flight for that thread.
      const answer = { ok: true, id, mode: chatCounter === 1 ? 'start' : 'steer', inputId: 'input-' + chatCounter };
      return reply(answer);
    }
    if (url.pathname === '/newmark-newmate/mcp') {
      const name = body.params?.name;
      if (name !== 'newmate_task_status') return reply({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'unknown' } });
      const messages = [
        { id: 'proactive-1', threadId: 'thread-A', role: 'assistant', text: 'PROACTIVE-RICH', plain: 'PROACTIVE-PLAIN', proactive: true },
      ];
      if (replyReady) messages.push({ id: 'task-1', threadId: 'thread-A', role: 'assistant', text: RICH, plain: PLAIN, proactive: false });
      return reply({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { ok: true, task: { id: 'task-1', status: replyReady ? 'completed' : 'running' }, messages } } });
    }
    res.writeHead(404); res.end('{}');
  });

  const ilinkPort = await listen(ilinkServer);
  const newmatePort = await listen(newmateServer);
  const ilinkUrl = 'http://127.0.0.1:' + ilinkPort;
  const newmateUrl = 'http://127.0.0.1:' + newmatePort;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-bridge-selftest-'));
  const lines = [];
  const out = (line) => { const text = String(line); lines.push(text); console.log(text); };
  const session = { botToken: TOKEN, botId: 'bridge-bot@im.bot', baseUrl: ilinkUrl, ilinkUserId: USER, cursor: '', lastPeer: null };

  try {
    // ---- A：正常一轮（含 steer 与去重） —— 只转发 plain ----
    script = [[m1], [m2]];
    const a = await runBridge({ session, newmateUrl, dir, out, mcpToken: 't', limit: 1, maxPolls: 60 });
    check('A: 两条微信消息都交给了 NewMate', chatPosts.length === 2, 'posts=' + chatPosts.length);
    check('A: 用页面同款请求（action=chat + 页面头 + 活动对话）', chatPosts.every((post) => post.action === 'chat' && post.threadId === 'thread-A'), JSON.stringify(chatPosts[0]));
    check('A: 正文原样传递', chatPosts[0]?.text === '第一条' && chatPosts[1]?.text === '第二条');
    const stateA = loadBridgeState(dir);
    check('A: 两条都在账本里被标记已接收', stateA.ledger[m1.message_id]?.state === 'acked' && stateA.ledger[m2.message_id]?.state === 'acked');
    check('A: 账本记住 task 与 mode（steer 被识别）', stateA.ledger[m2.message_id]?.taskId === 'task-1' && stateA.ledger[m2.message_id]?.mode === 'steer', JSON.stringify(stateA.ledger[m2.message_id]));
    check('A: 只转发了一条微信消息', sends.length === 1, 'sends=' + sends.length);
    check('A: 转发的是纯文字气泡版（不是渲染版）', sends[0]?.msg?.item_list?.[0]?.text_item?.text === PLAIN, JSON.stringify(sends[0]?.msg?.item_list?.[0]?.text_item?.text));
    check('A: 没有把渲染版或主动消息发出去', !JSON.stringify(sends).includes('PROACTIVE') && !JSON.stringify(sends).includes('标题'));
    check('A: 用最后一条入站的 context_token 回复', sends[0]?.msg?.context_token === 'ctx-2', sends[0]?.msg?.context_token);
    check('A: 两条入站共用一个 task（steer 语义）', Object.keys(stateA.sent).length === 1 && stateA.sent['task-1']);
    check('A: 游标已推进', stateA.cursor === 'cur-1', stateA.cursor);
    check('A: 输出里没有 token', !lines.some((line) => line.includes(TOKEN)));
    check('A: 按 limit 停止', a.replies === 1, JSON.stringify({ replies: a.replies }));

    // ---- B：重启 + 服务端重放同一条 —— 不再投递 ----
    const postsBefore = chatPosts.length;
    script = [[m1]];
    cursor = 'cur-1';
    const b = await runBridge({ session, newmateUrl, dir, out, mcpToken: 't', maxPolls: 8 });
    check('B: 重启后重放的那条不再交给 NewMate', chatPosts.length === postsBefore, 'posts=' + chatPosts.length);
    check('B: 日志明确说"已确认接收过"', lines.some((line) => line.includes('已确认接收过')));
    check('B: 重启后账本仍在', loadBridgeState(dir).ledger[m1.message_id]?.state === 'acked');

    // ---- C：NewMate 暂时不可用 —— 保留待投递、恢复后确认 ----
    newmateDown = true;
    script = [[m3]];
    chatCounter = 10;
    const c1 = await runBridge({ session, newmateUrl, dir, out, mcpToken: 't', maxPolls: 4 });
    const stateC1 = loadBridgeState(dir);
    check('C: NewMate 拒绝时不算已接收', !stateC1.ledger[m3.message_id] || stateC1.ledger[m3.message_id].state !== 'acked');
    check('C: 消息留在待投递队列', stateC1.pending.some((item) => item.id === m3.message_id), JSON.stringify(stateC1.pending.map((item) => item.id)));
    newmateDown = false;
    // Long enough to clear DELIVERY_RETRY_MS (2 s) with the fake server's 60 ms polls.
    await sleep(2100);
    const c2 = await runBridge({ session, newmateUrl, dir, out, mcpToken: 't', maxPolls: 30 });
    const stateC2 = loadBridgeState(dir);
    check('C: 恢复后被接收并标记已读取', stateC2.ledger[m3.message_id]?.state === 'acked');
    check('C: 队列被清空', stateC2.pending.filter((item) => item.id === m3.message_id).length === 0);
    check('C: 重试次数被记录（>=2）', Number(stateC2.ledger[m3.message_id]?.attempts || 0) >= 2, String(stateC2.ledger[m3.message_id]?.attempts));
    check('C: 没有因为一次失败就重复投递已确认的消息', chatPosts.filter((post) => post.text === '第一条').length === 1);
  } finally {
    ilinkServer.close();
    newmateServer.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  const passed = checks.filter((entry) => entry.pass).length;
  console.log('');
  for (const entry of checks) console.log((entry.pass ? 'PASS  ' : 'FAIL  ') + entry.name + (entry.pass || !entry.detail ? '' : '  [' + entry.detail + ']'));
  console.log('');
  console.log('bridge selftest: ' + passed + ' / ' + checks.length + ' PASS');
  return passed === checks.length ? 0 : 1;
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error('bridge 失败：' + (error && error.stack || error));
    process.exitCode = 1;
  });
}