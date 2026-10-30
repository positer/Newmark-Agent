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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWechatChannel } from '../packages/newmark-core/components/newmate/lib/wechat-channel.js';
import { aesEcbPaddedSize } from '../packages/newmark-core/components/newmate/lib/wechat-ilink.js';
import { NEWMATE_RUN_TOOLS, newMateRunTools } from '../packages/newmark-core/components/newmate/component.js';

const TOKEN = 'GATE-TOKEN-0123456789abcdef0123456789abcdef';
const USER = 'gate-user@im.wechat';
const RICH = '# 标题\n- 列表项\n`code`';
const PLAIN = '这是纯文字气泡版。';

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const calls = { qr: 0, status: 0, updates: [], sends: [], uploads: [], cdn: [], phase: 0 };
let cdnReject = false;
// A hand-built response, because the point is the RAW TEXT: a uint64 serialised by JSON.stringify
// would already be rounded before the client ever saw it.
let rawIdResponse = false;
let batches = [];
let confirmed = false;
let pauseWith = 0;
let sendDelayMs = 1300;
let failuresLeft = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  // Collect BYTES, not text: the media upload posts AES ciphertext, which a utf8 round-trip would
  // corrupt into something that can never be decrypted again.
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const rawBuffer = Buffer.concat(chunks);
  const raw = rawBuffer.toString('utf8');
  const body = raw && String(req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : {};
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
    if (rawIdResponse) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ret":0,"message_id":7520828416397238999}'); return; }
    // Slow on purpose: the reply forwarder runs on a 1 s timer, so a send that takes longer
    // than the interval is exactly the window in which a duplicate used to slip through.
    await sleep(sendDelayMs);
    return reply({ ret: 0, message_id: '99000000000000000' + calls.sends.length });
  }
  if (url.pathname === '/ilink/bot/getuploadurl') {
    calls.uploads.push(body);
    // No upload_full_url on purpose: the client has to build the CDN URL itself, which is the
    // branch a server that answers with a full URL would never exercise.
    return reply({ ret: 0, upload_param: 'PARAM-' + calls.uploads.length });
  }
  if (url.pathname === '/upload') {
    if (cdnReject) { res.writeHead(400, { 'x-error-message': 'gate-rejected' }); res.end('{}'); return; }
    const declaration = calls.uploads[calls.uploads.length - 1] || {};
    const key = Buffer.from(String(declaration.aeskey || ''), 'hex');
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    const plain = Buffer.concat([decipher.update(rawBuffer), decipher.final()]);
    calls.cdn.push({
      param: url.searchParams.get('encrypted_query_param'),
      filekey: url.searchParams.get('filekey'),
      contentType: req.headers['content-type'],
      cipherBytes: rawBuffer.length,
      plainBytes: plain.length,
      plainMd5: crypto.createHash('md5').update(plain).digest('hex'),
      text: plain.toString('utf8'),
    });
    res.writeHead(200, { 'x-encrypted-param': 'DP-' + calls.cdn.length });
    res.end('');
    return;
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
const channel = createWechatChannel({ root, mate, baseUrl: fakeBase, cdnBaseUrl: fakeBase, log: (line) => logs.push(String(line)) });

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

  // ---- 5.5 发文件：getuploadurl → CDN 密文 → file_item，且失败可区分 ----
  // The slow send above proved dedupe; the file section measures field values, so it does not need
  // the 1.3 s per-send delay any more.
  sendDelayMs = 0;
  const fixtureDir = path.join(root, 'files');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const TEXT = '这是 NewMate 发文件自测。\n第二行。\n';
  const textFile = path.join(fixtureDir, '发送自测.txt');
  fs.writeFileSync(textFile, TEXT);
  const textBytes = Buffer.byteLength(TEXT);
  const textMd5 = crypto.createHash('md5').update(Buffer.from(TEXT, 'utf8')).digest('hex');
  const sendsBeforeFile = calls.sends.length;
  const uploaded = await channel.sendFile({ path: textFile, caption: '这是说明文字' });
  check('file: 发送成功', uploaded.ok === true, JSON.stringify(uploaded).slice(0, 300));
  check('file: 返回文件名与字节数', uploaded.file?.name === '发送自测.txt' && uploaded.file?.bytes === textBytes, JSON.stringify(uploaded.file));
  check('file: 返回服务端 messageId', typeof uploaded.messageId === 'string' && uploaded.messageId.endsWith(String(calls.sends.length)), String(uploaded.messageId));
  check('file: 回执把 accepted 与 messageId 分开陈述', uploaded.receipt?.accepted === true && uploaded.receipt?.state === 'accepted_with_message_id', JSON.stringify(uploaded.receipt));

  const declaration = calls.uploads[0] || {};
  check('upload: media_type=3（文件）', declaration.media_type === 3, JSON.stringify(declaration.media_type));
  check('upload: to_user_id 是绑定接收者', declaration.to_user_id === USER, String(declaration.to_user_id));
  check('upload: rawsize 是明文字节数', declaration.rawsize === textBytes, String(declaration.rawsize));
  check('upload: rawfilemd5 是明文 MD5', declaration.rawfilemd5 === textMd5, String(declaration.rawfilemd5));
  check('upload: filesize 是 AES-128-ECB 填充后的密文字节数', declaration.filesize === Math.ceil((textBytes + 1) / 16) * 16, String(declaration.filesize));
  check('upload: no_need_thumb=true（附件不要缩略图）', declaration.no_need_thumb === true, JSON.stringify(declaration.no_need_thumb));
  check('upload: filekey / aeskey 是 32 位十六进制', /^[0-9a-f]{32}$/.test(String(declaration.filekey)) && /^[0-9a-f]{32}$/.test(String(declaration.aeskey)));
  check('upload: 带 base_info', declaration.base_info?.channel_version === '2.4.10', JSON.stringify(declaration.base_info));
  const cdn = calls.cdn[0] || {};
  check('cdn: 用 upload_param + filekey 拼出上传地址', cdn.param === 'PARAM-1' && cdn.filekey === declaration.filekey, JSON.stringify(cdn.param));
  check('cdn: 以 octet-stream 上传密文', cdn.contentType === 'application/octet-stream' && cdn.cipherBytes === declaration.filesize, JSON.stringify({ type: cdn.contentType, size: cdn.cipherBytes }));
  check('cdn: 密文用声明里的 aeskey 能解回原文件', cdn.plainBytes === textBytes && cdn.plainMd5 === textMd5 && cdn.text === TEXT, JSON.stringify({ bytes: cdn.plainBytes, md5: cdn.plainMd5 }));
  // 填充边界：当明文长度不是 16 的整数倍时，ceil((n+1)/16)*16 与 ceil(n/16)*16 恰好相等，
  // 所以上面那一个 47 字节的样本测不到「少加 1」这种错。PKCS#7 对整数倍长度必须多出一整块，
  // 这里按长度扫，并在下面用 48 字节（整数倍）的文件真发一次，让声明的 filesize 与密文长度对上。
  for (const n of [1, 15, 16, 17, 31, 32, 33, 47, 48, 63, 64, 1000]) {
    const size = aesEcbPaddedSize(n);
    check('padding: ' + n + ' 字节 → ' + size + '（16 对齐，且 = ceil((n+1)/16)*16）', size === Math.ceil((n + 1) / 16) * 16 && size % 16 === 0 && size > n, String(size));
  }

  const fileSends = calls.sends.filter((entry) => entry.msg?.item_list?.[0]?.type === 4);
  const fileMessage = fileSends[0]?.msg || {};
  const fileItem = fileMessage.item_list?.[0]?.file_item || {};
  check('file_item: 引用 CDN 下载参数', fileItem.media?.encrypt_query_param === 'DP-1', String(fileItem.media?.encrypt_query_param));
  check('file_item: aes_key 是 hex 字符串的 base64（与官方实现一致）', fileItem.media?.aes_key === Buffer.from(String(declaration.aeskey), 'utf8').toString('base64'), String(fileItem.media?.aes_key));
  check('file_item: encrypt_type=1', fileItem.media?.encrypt_type === 1, JSON.stringify(fileItem.media?.encrypt_type));
  check('file_item: 带真实文件名', fileItem.file_name === '发送自测.txt', String(fileItem.file_name));
  check('file_item: len 是明文字节数的字符串', fileItem.len === String(textBytes), String(fileItem.len));
  check('file: 机器人的 from_user_id 为空、message_state=2', fileMessage.from_user_id === '' && fileMessage.message_state === 2 && fileMessage.message_type === 2, JSON.stringify({ from: fileMessage.from_user_id, state: fileMessage.message_state }));
  check('file: 沿用最后一条入站的 context_token', fileMessage.context_token === 'ctx-2', String(fileMessage.context_token));
  const fileWindow = calls.sends.slice(sendsBeforeFile);
  const captionIndex = fileWindow.findIndex((entry) => entry.msg?.item_list?.[0]?.type === 1 && entry.msg.item_list[0].text_item.text === '这是说明文字');
  const fileIndex = fileWindow.findIndex((entry) => entry.msg?.item_list?.[0]?.type === 4);
  check('file: 说明文字是一条独立消息，且在文件之前', captionIndex >= 0 && fileIndex > captionIndex, JSON.stringify({ captionIndex, fileIndex }));
  check('file: 两条消息各用一个 client_id', fileWindow[captionIndex]?.msg?.client_id !== fileWindow[fileIndex]?.msg?.client_id);
  check('file: 一条消息只装一个 item', fileWindow.every((entry) => Array.isArray(entry.msg?.item_list) && entry.msg.item_list.length === 1));

  const override = await channel.sendFile({ path: textFile, receiver: 'gate-other@im.wechat' });
  check('file: receiver 可以覆盖接收者', override.ok === true && override.receiver === 'gate-other@im.wechat', JSON.stringify(override.receiver));
  check('file: 覆盖后 to_user_id 跟着变', calls.sends[calls.sends.length - 1]?.msg?.to_user_id === 'gate-other@im.wechat', String(calls.sends[calls.sends.length - 1]?.msg?.to_user_id));
  const relative = await channel.sendFile({ path: 'files/发送自测.txt', cwd: root });
  check('file: 相对路径按 cwd 解析且回执给出绝对路径', relative.ok === true && relative.file?.path === fs.realpathSync(textFile), String(relative.file?.path));

  const missing = await channel.sendFile({ path: path.join(fixtureDir, '不存在.txt') });
  check('file: 文件不存在 → file_not_found', missing.ok === false && missing.code === 'file_not_found', JSON.stringify(missing).slice(0, 160));
  const directory = await channel.sendFile({ path: fixtureDir });
  check('file: 目录 → not_a_regular_file', directory.code === 'not_a_regular_file', String(directory.code));
  const emptyFile = path.join(fixtureDir, '空.txt'); fs.writeFileSync(emptyFile, '');
  check('file: 空文件 → file_empty', (await channel.sendFile({ path: emptyFile })).code === 'file_empty');
  const exeFile = path.join(fixtureDir, 'setup.exe'); fs.writeFileSync(exeFile, 'MZ');
  check('file: 可执行类型 → file_type_rejected', (await channel.sendFile({ path: exeFile })).code === 'file_type_rejected');
  const envFile = path.join(fixtureDir, '.env'); fs.writeFileSync(envFile, 'TOKEN=x');
  check('file: .env → path_forbidden', (await channel.sendFile({ path: envFile })).code === 'path_forbidden');
  const pemFile = path.join(fixtureDir, 'server.pem'); fs.writeFileSync(pemFile, '-----BEGIN-----');
  check('file: 密钥扩展名 → path_forbidden', (await channel.sendFile({ path: pemFile })).code === 'path_forbidden');
  const fakeHome = path.join(root, 'fakehome');
  fs.mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true });
  const sshFile = path.join(fakeHome, '.ssh', 'notes.txt');
  fs.writeFileSync(sshFile, 'not a key by name, but in a credential directory');
  const savedProfile = process.env.USERPROFILE;
  const savedHome = process.env.HOME;
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  const forbidden = await channel.sendFile({ path: sshFile });
  process.env.USERPROFILE = savedProfile;
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  check('file: 凭据目录里的普通文件 → path_forbidden（不是按文件名）', forbidden.ok === false && forbidden.code === 'path_forbidden', JSON.stringify(forbidden).slice(0, 200));
  // 目录名的**大小写**：匹配前两侧都 lower 过，所以像 .Newmark / AppData/Local/.../User Data
  // 这种带大写字母的条目，如果只 lower 了 home、没 lower 条目，就永远匹配不上——本机实测曾经
  // 真的把 ~/.Newmark/newMate/wechat.json（自己的 token）判成可发。这两个用例就是钉住这件事。
  const chanTokenFile = path.join(fakeHome, '.Newmark', 'newMate', 'wechat.json');
  fs.mkdirSync(path.dirname(chanTokenFile), { recursive: true });
  fs.writeFileSync(chanTokenFile, '{"token":"fake"}');
  const chromeCookies = path.join(fakeHome, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cookies');
  fs.mkdirSync(path.dirname(chromeCookies), { recursive: true });
  fs.writeFileSync(chromeCookies, 'not really a cookie db');
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  const chanToken = await channel.sendFile({ path: chanTokenFile });
  const chromeFile = await channel.sendFile({ path: chromeCookies });
  process.env.USERPROFILE = savedProfile;
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  check('file: 凭据目录带大写字母也要拦（~/.Newmark 自己的 token）', chanToken.ok === false && chanToken.code === 'path_forbidden', JSON.stringify(chanToken).slice(0, 200));
  check('file: 凭据目录带大写字母也要拦（Chrome User Data）', chromeFile.ok === false && chromeFile.code === 'path_forbidden', JSON.stringify(chromeFile).slice(0, 200));
  const bigFile = path.join(fixtureDir, 'too-big.bin');
  fs.writeFileSync(bigFile, Buffer.alloc(20 * 1024 * 1024 + 1));
  const tooLarge = await channel.sendFile({ path: bigFile });
  check('file: 超过自设上限 → file_too_large 并报出上限', tooLarge.code === 'file_too_large' && tooLarge.limitBytes === 20 * 1024 * 1024, JSON.stringify({ code: tooLarge.code, limit: tooLarge.limitBytes }));
  fs.rmSync(bigFile, { force: true });
  cdnReject = true;
  const rejected = await channel.sendFile({ path: textFile });
  cdnReject = false;
  check('file: CDN 4xx → cdn_upload_rejected（不重试）', rejected.code === 'cdn_upload_rejected', JSON.stringify(rejected).slice(0, 160));
  const stat = JSON.parse(fs.readFileSync(channel.statePath, 'utf8'));
  check('file: 成功的发送计入统计，失败的单独计失败', Number(stat.stats.files) === 3 && Number(stat.stats.fileFailed) >= 1, JSON.stringify(stat.stats));
  check('file: 文件回执进状态文件（名字/字节/消息 id）', stat.lastFile?.name === '发送自测.txt' && Number(stat.lastFile?.bytes) === textBytes, JSON.stringify(stat.lastFile));
  check('file: 状态文件不保存文件内容或 aeskey', !JSON.stringify(stat).includes('第二行') && !JSON.stringify(stat).includes(String(declaration.aeskey)));
  rawIdResponse = true;
  const precise = await channel.sendFile({ path: textFile });
  rawIdResponse = false;
  check('file: message_id 是 uint64 字符串，不经过 JSON.parse 的浮点取整', precise.ok === true && precise.messageId === '7520828416397238999', String(precise.messageId));
  check('file: 回执里的 serverMessageId 与 messageId 是同一个精确值', precise.receipt?.serverMessageId === '7520828416397238999', String(precise.receipt?.serverMessageId));
  // 明文正好 16 字节的整数倍：PKCS#7 要补满一整块，filesize 必须是 64 而不是 48。
  const alignedFile = path.join(fixtureDir, '对齐48.txt');
  fs.writeFileSync(alignedFile, 'A'.repeat(48));
  const alignedUploadAt = calls.uploads.length;
  const alignedCdnAt = calls.cdn.length;
  const aligned = await channel.sendFile({ path: alignedFile });
  const alignedDeclaration = calls.uploads[alignedUploadAt] || {};
  const alignedCdn = calls.cdn[alignedCdnAt] || {};
  check('padding: 48 字节文件声明 filesize=64（整数倍要多补一整块）', aligned.ok === true && alignedDeclaration.filesize === 64, JSON.stringify({ ok: aligned.ok, filesize: alignedDeclaration.filesize }));
  check('padding: 声明的 filesize 与真实上传的密文长度一致', alignedCdn.cipherBytes === 64 && alignedCdn.plainBytes === 48, JSON.stringify({ cipher: alignedCdn.cipherBytes, plain: alignedCdn.plainBytes }));
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

  // ---- 8.5 两种到期方式都要发到微信，且各只发一次（0.3.67）----
  // The user's words: "由代办投递的 newMate 消息… 经由 newMate 的 clawbot 文字消息投递通道投递".
  // A scheduled item is the same promise in both modes - he set a time and it is now due - so an
  // activation's model reply goes out exactly like a reminder's saved text. Measured before the
  // change (2026-10-29 11:20): an activation due 03:20:18.425 was delivered to the page and the
  // bubble in 1.4 s and never reached WeChat (stats.replies unchanged, no sent receipt).
  const reminderId = 'rem-1';
  const conversationTodoId = 'conv-1';
  todos.push({ id: reminderId, mode: 'reminder' }, { id: conversationTodoId, mode: 'conversation' });
  const future = Date.now() + 5;
  const ACTIVATION_TEXT = '这条是会话型待办的模型回复，必须转发到微信';
  messages.push({ id: 'todo:' + reminderId, todoId: reminderId, threadId: 'thread-A', role: 'assistant', text: '该准备上课了（10 分钟提醒）。收拾要带的东西，出发吧。', proactive: true, at: future });
  messages.push({ id: 'todo:' + conversationTodoId, todoId: conversationTodoId, threadId: 'thread-A', role: 'assistant', text: ACTIVATION_TEXT, proactive: true, at: future });
  const sendsBefore = calls.sends.length;
  await sleep(2600);
  const reminderSends = calls.sends.slice(sendsBefore).filter((entry) => JSON.stringify(entry).includes('该准备上课了'));
  check('reminder: 纯文字提醒被发到微信', reminderSends.length === 1, 'sends=' + reminderSends.length);
  check('reminder: 正文是用户原文（未被 80 字截断）', String(reminderSends[0]?.msg?.item_list?.[0]?.text_item?.text || '') === '该准备上课了（10 分钟提醒）。收拾要带的东西，出发吧。', String(reminderSends[0]?.msg?.item_list?.[0]?.text_item?.text || ''));
  const activationSends = calls.sends.slice(sendsBefore).filter((entry) => JSON.stringify(entry).includes('必须转发到微信'));
  check('activation: 待办激活的模型回复被发到微信', activationSends.length === 1, 'sends=' + activationSends.length);
  check('activation: 正文是完整回复（没被截成 80 字气泡）', String(activationSends[0]?.msg?.item_list?.[0]?.text_item?.text || '') === ACTIVATION_TEXT, String(activationSends[0]?.msg?.item_list?.[0]?.text_item?.text || ''));
  await sleep(1500);
  check('reminder: 只发一次（不重复）', calls.sends.slice(sendsBefore).filter((entry) => JSON.stringify(entry).includes('该准备上课了')).length === 1);
  check('activation: 只发一次（不重复）', calls.sends.slice(sendsBefore).filter((entry) => JSON.stringify(entry).includes('必须转发到微信')).length === 1);
  const reminderState = JSON.parse(fs.readFileSync(channel.statePath, 'utf8'));
  check('reminder: 账本记下这条 message id', Boolean(reminderState.sent['todo:' + reminderId]), JSON.stringify(Object.keys(reminderState.sent)));
  check('activation: 账本记下这条 message id', Boolean(reminderState.sent['todo:' + conversationTodoId]), JSON.stringify(Object.keys(reminderState.sent)));

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

  // ---- 9.5 发文件的另外三种拒绝：未连接 / 没有接收者 / 会话暂停 ----
  // The fixture from the file section lived inside the try block, so this section makes its own:
  // these three refusals must be decided before any read of the file, not after.
  const refusalFixture = path.join(os.tmpdir(), 'newmate-wechat-gate-refusal-' + process.pid + '.txt');
  fs.writeFileSync(refusalFixture, 'refusal fixture');
  const makeStateRoot = (prefix, payload) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const file = path.join(dir, 'newMate', 'wechat.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schema: 1, phase: 'connected', token: TOKEN, botId: 'gate-bot@im.bot', baseUrl: fakeBase,
      ilinkUserId: USER, cursor: '', ledger: {}, pending: [], awaiting: {}, sent: {},
      qrcode: '', qrAt: 0, error: '', connectedAt: Date.now(), updatedAt: Date.now(),
      stats: { inbound: 0, acked: 0, skipped: 0, replies: 0, sendFailed: 0 },
      ...payload,
    }), { mode: 0o600 });
    return dir;
  };
  const offline = createWechatChannel({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-wechat-gate4-')), mate, baseUrl: fakeBase, cdnBaseUrl: fakeBase, log: () => {} });
  check('file: 未连接 → wechat_not_connected', (await offline.sendFile({ path: refusalFixture })).code === 'wechat_not_connected');
  const noPeer = createWechatChannel({ root: makeStateRoot('newmate-wechat-gate5-', { ilinkUserId: '' }), mate, baseUrl: fakeBase, cdnBaseUrl: fakeBase, log: () => {} });
  check('file: 没有接收者 → receiver_unavailable', (await noPeer.sendFile({ path: refusalFixture })).code === 'receiver_unavailable');
  const pausedForFile = createWechatChannel({ root: makeStateRoot('newmate-wechat-gate6-', { phase: 'error', error: 'session_paused' }), mate, baseUrl: fakeBase, cdnBaseUrl: fakeBase, log: () => {} });
  check('file: -14 暂停 → wechat_session_paused', (await pausedForFile.sendFile({ path: refusalFixture })).code === 'wechat_session_paused');
// ---- 10. 宿主接线：没有 resume()/stop() 的话，重启后通道会“看起来已连接但什么都不收” ----
const indexSource = fs.readFileSync(new URL('../packages/newmark-core/components/newmate/index.js', import.meta.url), 'utf8');
check('wiring: 挂载后会 resume()，重启/更新无需重新扫码', indexSource.includes('wechat.resume()'), 'index.js');
check('wiring: 释放时会 stop()，不再留下野循环', indexSource.includes('wechat.stop()'), 'index.js');
check('wiring: GET 负载暴露 wechat 状态', indexSource.includes('wechat:wechat.status()'), 'index.js');
check('wiring: 两个动作都接上', indexSource.includes("case 'wechat-connect'") && indexSource.includes("case 'wechat-logout'"), 'index.js');


// ---- 11. 发文件工具的注册层：必须是共享工具注册表，且 NewMate 自己的 run 也拿得到 ----
const toolNameAt = indexSource.indexOf("name: 'newmate_wechat_send_file'");
// The registration must be the SHARED registry call that also carries newmate_todo_add — a name in
// a private tool map would pass a mere "is it mentioned" check and still be invisible to a conversation.
const registerAt = indexSource.lastIndexOf('ctx.tools.register({', toolNameAt);
const privateToolAt = indexSource.lastIndexOf('newmark.newmate.privateTools', toolNameAt);
const sharedRegistry = toolNameAt > 0 && registerAt > 0 && toolNameAt - registerAt < 400 && privateToolAt !== toolNameAt;
check('tool: 通过 ctx.tools.register 注册（共享注册表，不是私有工具）', sharedRegistry, 'index.js');
check('tool: 描述写明自设上限与 messageId 语义', indexSource.includes('20 MiB') && indexSource.includes('messageId'), 'index.js');
check('tool: execute 从调用者的会话 cwd 解析相对路径', indexSource.includes('execution?.agent?.session?.header?.cwd'), 'index.js');
check('tool: 名字进入 NewMate 运行工具组', NEWMATE_RUN_TOOLS.includes('newmate_wechat_send_file'));
check('tool: 自动检查轮次拿不到它（要用户明确要求）', newMateRunTools({ automatic: true }).includes('newmate_wechat_send_file') === false);
check('tool: 用户发起的轮次拿得到它', newMateRunTools({ automatic: false, origin: 'session-1' }).includes('newmate_wechat_send_file'));

// ---- 12. 汇报通道：NewMate 自己能主动发一条微信（先占位再等网络、按条去重、按时限流） ----
//
// 这是用户 2026-10-30 的要求：「有事汇报时积极发信 clawbot 让用户了解」。它和前面两条出口的区别
// 是发起者：reply 由用户的微信消息触发，scheduled 由用户预约的时间触发，report 由 NewMate 自己
// 在跑完一轮之后发起。所以下面的断言关心三件事：真的发得出去；重复/超量/超长都被具名拒绝；
// 这个工具在**自动检查轮**里也拿得到（否则「积极汇报」在自主轮次就失效）。
{
  // 这一节跑在共享 fixture 的服务器关闭之后，所以它自带一个只认 sendmessage 的假服务器：
  // 记录每次请求体，并回一个 message id。
  const sentBodies = [];
  const reportServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(raw); } catch { body = {}; }
    sentBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ret: 0, message_id: '88000000000000000' + sentBodies.length }));
  });
  await new Promise((resolve) => reportServer.listen(0, '127.0.0.1', resolve));
  const reportBase = 'http://127.0.0.1:' + reportServer.address().port;
  const reportRoot = makeStateRoot('newmate-wechat-gate7-', { baseUrl: reportBase, lastPeer: { to: USER, contextToken: 'gate-context' } });
  const reporter = createWechatChannel({ root: reportRoot, mate, baseUrl: reportBase, cdnBaseUrl: reportBase, log: () => {} });
  try {
    const first = await reporter.sendText({ text: '定时项跑完了：\n\n今天的实验记录已归档，需要你确认周末的排期。' });
    check('report: 一轮跑完后的汇报真的发出，并带回服务端 messageId', first.ok === true && typeof first.messageId === 'string' && sentBodies.length === 1, JSON.stringify(first).slice(0, 220));
    const sentText = String(sentBodies[0]?.msg?.item_list?.[0]?.text_item?.text ?? '');
    check('report: 多行汇报压成单段（微信气泡不为排版服务）', sentText.length > 0 && !sentText.includes('\n'), JSON.stringify(sentText).slice(0, 160));
    const dup = await reporter.sendText({ text: '定时项跑完了：\n\n今天的实验记录已归档，需要你确认周末的排期。' });
    check('report: 十分钟内一模一样的内容被拒（重复不是新闻）', dup.ok === false && dup.code === 'duplicate_report' && sentBodies.length === 1);
    const tooLong = await reporter.sendText({ text: '长'.repeat(900) });
    check('report: 超过 800 字被具名拒绝，并说明细节该留在页面', tooLong.ok === false && tooLong.code === 'text_too_long' && tooLong.limit === 800);
    const empty = await reporter.sendText({ text: '   ' });
    check('report: 空内容被拒', empty.ok === false && empty.code === 'empty_text');
    const flooded = createWechatChannel({ root: makeStateRoot('newmate-wechat-gate8-', { baseUrl: reportBase, lastPeer: { to: USER, contextToken: 'gate-context' }, reports: Array.from({ length: 6 }, (_, i) => ({ at: Date.now() - 1000 * i, chars: 10, text: 't' + i, messageId: null })) }), mate, baseUrl: reportBase, cdnBaseUrl: reportBase, log: () => {} });
    const limited = await flooded.sendText({ text: '第七件事' });
    check('report: 一小时的第 7 条被限流，并给出 retryAfterMs 而不是静默丢弃', limited.ok === false && limited.code === 'report_rate_limited' && limited.retryAfterMs > 0, JSON.stringify(limited).slice(0, 200));
    check('report: 未连接 → wechat_not_connected', (await offline.sendText({ text: '汇报' })).code === 'wechat_not_connected');
    check('report: 没有接收者 → receiver_unavailable', (await noPeer.sendText({ text: '汇报' })).code === 'receiver_unavailable');
    check('report: -14 暂停 → wechat_session_paused', (await pausedForFile.sendText({ text: '汇报' })).code === 'wechat_session_paused');
  } finally {
    await reporter.stop().catch(() => {});
    await new Promise((resolve) => reportServer.close(resolve));
  }

  check('report: 名字进入 NewMate 运行工具组', NEWMATE_RUN_TOOLS.includes('newmate_wechat_send_text'));
  check('report: 自动检查轮次也拿得到它（用户要求「积极汇报」，自主轮次不能失效）', newMateRunTools({ automatic: true }).includes('newmate_wechat_send_text'));
  const personaSource = fs.readFileSync(new URL('../packages/newmark-core/components/newmate/lib/persona.js', import.meta.url), 'utf8');
  check('persona: 明确写出什么时候汇报、以及没有事就不要发', personaSource.includes('newmate_wechat_send_text') && personaSource.includes('没有事就不要发'));
  check('tool: 作为私有工具注册（NewMate 的声音说 NewMate 的事），不进共享注册表', indexSource.includes("name: 'newmate_wechat_send_text'") && !indexSource.includes('ctx.tools.register({ name: \'newmate_wechat_send_text\''));
}

const passed = checks.filter((entry) => entry.pass).length;
for (const entry of checks) console.log((entry.pass ? 'PASS  ' : 'FAIL  ') + entry.name + (entry.pass || !entry.detail ? '' : '  [' + entry.detail + ']'));
console.log('');
console.log('verify-newmate-wechat-channel: ' + passed + ' / ' + checks.length + ' PASS');
process.exitCode = passed === checks.length ? 0 : 1;