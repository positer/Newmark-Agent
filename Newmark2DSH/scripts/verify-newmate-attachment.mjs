/**
 * verify-newmate-attachment — the files a USER hands NewMate, from either entrance.
 *
 * Two entrances, one store: the page posts bytes to /newmark-newmate/upload, the WeChat ClawBot
 * channel downloads and decrypts a media item, and both end in the same upload store, the same
 * chat() attachment argument and the same reader. This gate holds the four things that must stay
 * true, each against the code that runs rather than against a restatement of it:
 *
 *   1. the store      - one file per id directory, containment on the RESOLVED path, bounded
 *                       excerpts, and a text reader that cannot leave the store;
 *   2. chat()         - the durable message keeps the user's words, the TASK prompt carries the
 *                       file facts, and an empty message is legal only with a file;
 *   3. the channel    - a file sent from the phone is downloaded, decrypted and stored, and a file
 *                       that cannot be fetched still reaches NewMate as an honest notice;
 *   4. the plugin row - the real mounted core registers the reader tool and the byte route, and
 *                       the route is driven with real bytes through a real request object.
 *
 * Run: node scripts/verify-newmate-attachment.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNewMate, NEWMATE_RUN_TOOLS, NEWMATE_REQUEST_TOOLS } from '../packages/newmark-core/components/newmate/component.js';
import * as store from '../packages/newmark-core/components/newmate/lib/upload-store.js';
import { createWechatChannel } from '../packages/newmark-core/components/newmate/lib/wechat-channel.js';
import { createIlink, parseAesKey, decryptAesEcb, cdnDownloadUrl } from '../packages/newmark-core/components/newmate/lib/wechat-ilink.js';
import { mountCore } from './lib/mount-newmark-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const results = [];
const check = (name, value, detail) => {
  const pass = Boolean(value);
  results.push({ name, pass });
  if (pass) console.log('ok ' + results.length + ' - ' + name);
  else console.log('not ok ' + results.length + ' - ' + name + (detail === undefined ? '' : '  [' + String(detail) + ']'));
  return pass;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-attachment-gate-'));
const root = path.join(tempBase, 'root');
fs.mkdirSync(root, { recursive: true });

/* ============================ 1. THE STORE ============================ */
const TEXT = '# 笔记\n第一行\n第二行\n';
const textBytes = Buffer.from(TEXT, 'utf8');
const savedText = store.saveUpload({ root, name: '笔记.md', bytes: textBytes, source: 'page', at: 1700000000000 });
check('store: 保存文本附件成功', savedText.ok === true, JSON.stringify(savedText).slice(0, 200));
check('store: 附件落在 uploads/<id>/<name>', savedText.entry.path === path.join(root, 'newMate', 'uploads', savedText.entry.id, '笔记.md') && fs.existsSync(savedText.entry.path), savedText.entry.path);
check('store: 摘要与字节数可从磁盘核验', savedText.entry.sha256 === crypto.createHash('sha256').update(textBytes).digest('hex') && savedText.entry.bytes === textBytes.length, JSON.stringify({ bytes: savedText.entry.bytes }));
check('store: 记录来源，页面与微信不会混为一谈', savedText.entry.source === 'page' && savedText.entry.kind === 'text', savedText.entry.source + '/' + savedText.entry.kind);

check('store: 路径穿越的文件名被裁成裸名', store.sanitizeUploadName('../../etc/passwd') === 'passwd', store.sanitizeUploadName('../../etc/passwd'));
check('store: 反斜杠路径同样被裁', store.sanitizeUploadName('C:\\Windows\\a.txt') === 'a.txt', store.sanitizeUploadName('C:\\Windows\\a.txt'));
check('store: 控制字符与 Windows 非法字符被替换', store.sanitizeUploadName('a\u0000b<c>.txt') === 'ab_c_.txt', store.sanitizeUploadName('a\u0000b<c>.txt'));
check('store: 空名字有兜底', store.sanitizeUploadName('   ') === 'file.bin', store.sanitizeUploadName('   '));
check('store: 超长名字保留扩展名', (() => { const n = store.sanitizeUploadName('x'.repeat(400) + '.md'); return n.length === store.UPLOAD_MAX_NAME && n.endsWith('.md'); })(), store.sanitizeUploadName('x'.repeat(400) + '.md'));
check('store: 空文件被拒（有自己的错误码）', store.inspectUpload({ name: 'a.txt', bytes: 0 }).code === 'file_empty');
check('store: 超限被拒（自设上限）', store.inspectUpload({ name: 'a.bin', bytes: 2048, maxBytes: 1024 }).code === 'file_too_large');
check('store: 种类按扩展名分类', store.mediaKind('a.PDF') === 'document' && store.mediaKind('a.ts') === 'text' && store.mediaKind('a.png') === 'image' && store.mediaKind('a.mp4') === 'video');

const excerpt = store.textExcerpt({ path: savedText.entry.path, maxChars: 8 });
check('excerpt: 文本按预算截断并自报被截断', excerpt.ok === true && excerpt.truncated === true && excerpt.text.length === 8, JSON.stringify(excerpt.text));
const binaryPath = path.join(tempBase, 'binary.bin');
fs.writeFileSync(binaryPath, Buffer.from([0x89, 0x50, 0x00, 0x00, 0x01]));
check('excerpt: 含 0 字节的文件不当作文本', store.textExcerpt({ path: binaryPath, maxChars: 100 }).reason === 'not_text');
check('excerpt: 非文本类型直接拒绝引用', store.textExcerpt({ path: path.join(tempBase, 'a.pdf'), maxChars: 100 }).reason === 'not_text');

check('normalize: 相对路径的附件记录被拒（没有可核验的位置）', (() => { try { store.normalizeAttachments([{ id: 'x', name: 'a.txt', path: 'a.txt' }]); return false; } catch { return true; } })());
check('normalize: 超过上限的附件列表被截到 8 个', store.normalizeAttachments(Array.from({ length: 12 }, (_, i) => ({ id: 'id-' + i, name: 'f' + i + '.txt', path: path.join(tempBase, 'f' + i + '.txt'), bytes: 1 }))).length === 8);

check('reader: 拒绝读上传目录之外的文件', store.readUploadContent({ root, path: binaryPath }).code === 'file_not_in_upload_store');
const window = store.readUploadContent({ root, path: savedText.entry.path, offset: 2, limit: 2 });
check('reader: 按行返回窗口并声明还有更多', window.ok === true && window.text === '第一行\n第二行' && window.more === true && window.truncatedBy === 'lines', JSON.stringify(window.text));
check('reader: 二进制附件被拒并说明类型', store.readUploadContent({ root, path: (() => { const s = store.saveUpload({ root, name: 'pic.png', bytes: fs.readFileSync(binaryPath) }); return s.entry.path; })() }).code === 'file_not_text');
const before = fs.readdirSync(store.uploadsRoot(root)).length;
store.pruneUploads({ root, keep: 1 });
check('retention: 只保留最新的 N 个附件目录', fs.readdirSync(store.uploadsRoot(root)).length === 1 && before > 1, before + ' -> ' + fs.readdirSync(store.uploadsRoot(root)).length);

/* ========================= 2. chat() WITH ATTACHMENTS ========================= */
const prompts = [];
const makeMate = (mateRoot) => createNewMate({
  root: mateRoot,
  now: () => 1700000000000,
  agents: () => null,
  tools: { execute: async (call) => { prompts.push(call.arguments.prompt); return { isError: false, value: { ok: true, result: { output: '收到' } } }; } },
});

const gateRoot = path.join(tempBase, 'chat');
fs.mkdirSync(gateRoot, { recursive: true });
const mate = makeMate(gateRoot);
const attachment = store.saveUpload({ root: gateRoot, name: 'design.md', bytes: Buffer.from('# 方案\n只有两行。\n', 'utf8'), source: 'page', at: 1700000000000 }).entry;
const accepted = mate.chat('看看这个文件', undefined, undefined, [attachment]);
await mate.tick();
check('chat: 带附件的消息被接收并返回 task id', accepted.ok === true && typeof accepted.id === 'string', JSON.stringify(accepted).slice(0, 160));
const taskPrompt = mate.state().tasks.at(-1).prompt;
check('chat: 任务提示里给出真实路径与内容片段', taskPrompt.includes(attachment.path) && taskPrompt.includes('# 方案') && taskPrompt.includes('用户随这条消息给了 1 个文件'), String(taskPrompt).slice(0, 300));
check('chat: 片段被截断时才提示用读取工具（不截断就不啰嗦）', !taskPrompt.includes('newmate_attachment_read'));
const durable = mate.state().messages.filter((m) => m.role === 'user').at(-1);
check('chat: 落库的用户消息保留原话，附件单独记录', durable.text === '看看这个文件' && durable.attachments?.[0]?.name === 'design.md', JSON.stringify({ text: durable.text, attachments: durable.attachments?.length }));
check('chat: 任务记录也带着附件（排队与重试不丢）', mate.state().tasks.at(-1).attachments?.[0]?.id === attachment.id, JSON.stringify(mate.state().tasks.at(-1).attachments?.length));
check('chat: 附件说明不进用户原话（气泡与微信仍只发原话）', !durable.text.includes(attachment.path));

const pendingFile = store.saveUpload({ root: gateRoot, name: 'pending.txt', bytes: Buffer.from('排队时带的文件\n', 'utf8'), source: 'page' }).entry;
mate.chat('先排队');
mate.chat('再补一句', undefined, undefined, [pendingFile]);
await mate.tick();
const merged = mate.state().tasks.filter((t) => t.kind === 'chat').at(-1);
check('chat: 排队的第二条并入同一任务，两条原话都在', merged.prompt.includes('先排队') && merged.prompt.includes('再补一句'), String(merged.prompt).slice(0, 160));
check('chat: 并入的附件挂在同一任务上', (merged.attachments || []).length === 1 && merged.attachments[0].name === 'pending.txt', JSON.stringify((merged.attachments || []).map((a) => a.name)));

const onlyFile = store.saveUpload({ root: gateRoot, name: '只有文件.txt', bytes: Buffer.from('x\n', 'utf8'), source: 'page' }).entry;
const threadId = mate.createThread().id;
const noWords = mate.chat('', undefined, undefined, [onlyFile]);
check('chat: 只发文件不写字是合法的（手机拍一张图没有说话）', noWords.ok === true, JSON.stringify(noWords).slice(0, 160));
check('chat: 只有附件时用文件名当新对话标题', mate.state().threads.find((t) => t.id === threadId).title.includes('只有文件'), mate.state().threads.find((t) => t.id === threadId).title);
let refusedEmpty = false;
try { mate.chat('   '); } catch { refusedEmpty = true; }
check('chat: 空消息且没有附件仍然被拒', refusedEmpty);
await mate.tick();

const pdfAttachment = store.saveUpload({ root: gateRoot, name: 'report.pdf', bytes: Buffer.from('%PDF-1.4 not really\n'), source: 'wechat' }).entry;
prompts.length = 0;
mate.chat('这个 PDF 说了什么', undefined, undefined, [pdfAttachment]);
await mate.tick();
check('chat: 非文本附件明说内容未读取（不许假装看过）', prompts[0].includes('内容未读取') && !prompts[0].includes('%PDF'), String(prompts[0] || '').slice(0, 400));
check('chat: 非文本附件的路径仍交给模型（可以转交或再问一句）', prompts[0].includes(pdfAttachment.path));
check('chat: 来源被记住（wechat 与 page 不混）', mate.state().messages.filter((m) => m.role === 'user').at(-1).attachments[0].source === 'wechat');

const longText = '很长的用户消息。'.repeat(900);
const longAttach = store.saveUpload({ root: gateRoot, name: 'long.txt', bytes: Buffer.from('y'.repeat(30000), 'utf8'), source: 'page' }).entry;
prompts.length = 0;
mate.chat(longText, undefined, undefined, [longAttach]);
await mate.tick();
// The 16000-character bound is the TASK prompt's, not the assembled agent prompt's (the run
// prompt also carries the time line, the recent history and the reply protocol around it).
const longTask = mate.state().tasks.filter((t) => t.kind === 'chat').at(-1);
check('chat: 长消息 + 长文件仍然装进 16000 字符的任务上限', longTask.prompt.length <= 16000, String(longTask.prompt.length));
check('chat: 预算被压缩时片段变短，而不是让整条消息失败', longTask.prompt.includes(longAttach.path) && longTask.prompt.length <= 16000, String(longTask.prompt.length));
check('chat: 压缩后的片段确实进了提示（是变短，不是丢掉）', prompts[0].includes('y'.repeat(50)), String(prompts[0].length));
mate.stop();

/* ===================== 3. INBOUND MEDIA THROUGH THE CHANNEL ===================== */
/* A real channel against a fake iLink server and a fake media CDN. The CDN serves AES-128-ECB
 * ciphertext, which is exactly what the real one serves, so the decrypt step is measured rather
 * than mocked. */
const encryptedFiles = new Map();
const downloadCalls = [];
let downloadsFailWith = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const reply = (value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/ilink/bot/get_bot_qrcode') return reply({ qrcode: 'QR-ATTACH', qrcode_img_content: 'https://example.invalid/x' });
  if (url.pathname === '/ilink/bot/get_qrcode_status') return reply({ status: 'confirmed', bot_token: 'ATTACH-TOKEN', ilink_bot_id: 'gate@im.bot', baseurl: 'http://127.0.0.1:' + server.address().port, ilink_user_id: 'u@im.wechat' });
  if (url.pathname === '/ilink/bot/getupdates') {
    const batch = batches.length ? batches.shift() : [];
    setTimeout(() => { if (res.writableEnded) return; reply({ ret: 0, msgs: batch, get_updates_buf: 'cursor-' + (++polls) }); }, 20);
    return;
  }
  if (url.pathname === '/ilink/bot/sendmessage') return reply({ ret: 0, message_id: 'mid-' + (++sends) });
  if (url.pathname === '/ilink/bot/msg/notifystart' || url.pathname === '/ilink/bot/msg/notifystop') return reply({ ret: 0 });
  if (url.pathname === '/download') {
    const param = url.searchParams.get('encrypted_query_param') || '';
    downloadCalls.push(param);
    const entry = encryptedFiles.get(param);
    if (downloadsFailWith) { res.writeHead(downloadsFailWith); res.end('gone'); return; }
    if (!entry) { res.writeHead(404); res.end('missing'); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': entry.length });
    res.end(entry);
    return;
  }
  res.writeHead(404); res.end('{}');
});
let polls = 0;
let sends = 0;
let batches = [];
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const fakeBase = 'http://127.0.0.1:' + port;

const chatCalls = [];
const channelRoot = path.join(tempBase, 'channel');
fs.mkdirSync(path.join(channelRoot, 'newMate'), { recursive: true });
const channelMate = {
  chat(text, execution, threadId, attachments) { chatCalls.push({ text, execution, threadId, attachments }); return { ok: true, id: 'task-' + chatCalls.length, mode: 'start' }; },
  state() { return { activeThreadId: 't', threads: [{ id: 't' }], messages: [], tasks: [], todos: [] }; },
};
const channel = createWechatChannel({ root: channelRoot, mate: channelMate, baseUrl: fakeBase, cdnBaseUrl: fakeBase, log: () => {} });
await channel.connect();
await sleep(400);

const USER = 'u@im.wechat';
const makeMessage = (id, items) => ({ seq: Number(id.slice(-4)), message_id: id, from_user_id: USER, message_type: 1, message_state: 2, context_token: 'ctx-' + id, item_list: items });
const KEY_A = crypto.randomBytes(16);
const KEY_B = crypto.randomBytes(16);
const encryptFor = (param, key, plain) => {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  encryptedFiles.set(param, Buffer.concat([cipher.update(plain), cipher.final()]));
  return encryptedFiles.get(param);
};

// --- 3.1 a FILE with the base64(hex string) key our own outbound path writes ---
const filePlain = Buffer.from('微信发来的表格\n第一行,第二行\n', 'utf8');
encryptFor('P-FILE', KEY_A, filePlain);
batches = [[makeMessage('7520900000000000001', [{ type: 4, file_item: { media: { encrypt_query_param: 'P-FILE', aes_key: Buffer.from(KEY_A.toString('hex'), 'utf8').toString('base64'), encrypt_type: 1 }, file_name: '表格.csv', len: String(filePlain.length) } }])]];
await sleep(900);
check('inbound: 微信发来的文件交给了 mate.chat', chatCalls.length === 1, 'calls=' + chatCalls.length);
const call1 = chatCalls[0] || {};
check('inbound: 文件消息没有文字时正文为空（附件才是内容）', call1.text === '');
check('inbound: 附件名称就是微信给的文件名', call1.attachments?.[0]?.name === '表格.csv', JSON.stringify(call1.attachments));
const storedFile = call1.attachments?.[0];
check('inbound: 附件真的落在上传目录里', Boolean(storedFile) && storedFile.path.startsWith(store.uploadsRoot(channelRoot)) && fs.existsSync(storedFile.path), storedFile && storedFile.path);
check('inbound: 解密后的字节与原文件一致', Boolean(storedFile) && fs.readFileSync(storedFile.path).equals(filePlain), storedFile && storedFile.bytes);
check('inbound: 记录来源 wechat（与页面区分）', storedFile?.source === 'wechat');
check('inbound: 用的就是 CDN 上那条引用', downloadCalls.includes('P-FILE'), JSON.stringify(downloadCalls));
const stateFile = path.join(channelRoot, 'newMate', 'wechat.json');
let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
check('inbound: 回执记下存了什么（名称/字节/种类/摘要）', state.ledger['7520900000000000001']?.attachment?.name === '表格.csv' && state.ledger['7520900000000000001']?.attachment?.sha256 === crypto.createHash('sha256').update(filePlain).digest('hex'), JSON.stringify(state.ledger['7520900000000000001'] || {}));
check('inbound: 统计计入 media 与字节数', state.stats.media === 1 && state.stats.mediaBytes === filePlain.length, JSON.stringify(state.stats));

// --- 3.2 an IMAGE whose bare hex aeskey WINS over media.aes_key ---
const imagePlain = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fake-png-body')]);
encryptFor('P-IMG', KEY_B, imagePlain);
batches = [[makeMessage('7520900000000000002', [{ type: 2, image_item: { media: { encrypt_query_param: 'P-IMG', aes_key: Buffer.from(KEY_A.toString('hex'), 'utf8').toString('base64') }, aeskey: KEY_B.toString('hex') } }])]];
await sleep(900);
const call2 = chatCalls[1] || {};
check('inbound: 图片用裸 32 位 hex aeskey 解密（它优先于 media.aes_key）', chatCalls.length === 2 && call2.attachments?.[0]?.bytes === imagePlain.length, JSON.stringify(call2.attachments?.map((a) => a.bytes)));
check('inbound: 图片扩展名按字节嗅探出来（.png）', call2.attachments?.[0]?.name?.endsWith('.png'), call2.attachments?.[0]?.name);
check('inbound: 图片被记成 image 类型（不会被当成文本引用）', call2.attachments?.[0]?.kind === 'image');

// --- 3.3 an image with NO key at all is served in the clear ---
const plainImage = Buffer.from('GIF89a-plain-bytes', 'utf8');
encryptedFiles.set('P-CLEAR', plainImage);
batches = [[makeMessage('7520900000000000003', [{ type: 2, image_item: { media: { encrypt_query_param: 'P-CLEAR' } } }])]];
await sleep(900);
const call3 = chatCalls[2] || {};
check('inbound: 没有密钥的图片按明文保存（官方客户端同样如此）', call3.attachments?.[0]?.bytes === plainImage.length && call3.attachments?.[0]?.name?.endsWith('.gif'), JSON.stringify(call3.attachments?.[0]));
state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
check('inbound: 明文回执自报 decrypted=false', state.lastInboundFile?.decrypted === false, JSON.stringify(state.lastInboundFile));

// --- 3.4 a file whose key does not match: retried, then an honest notice ---
const wrong = crypto.randomBytes(16);
encryptFor('P-BADKEY', wrong, Buffer.from('这段密文用声明里的钥匙解不开\n', 'utf8'));
batches = [[makeMessage('7520900000000000004', [{ type: 4, file_item: { media: { encrypt_query_param: 'P-BADKEY', aes_key: Buffer.from(KEY_A.toString('hex'), 'utf8').toString('base64') }, file_name: '打不开的.txt', len: '999' } }])]];
await sleep(3000);
const notice = chatCalls[3] || {};
check('inbound: 密钥不匹配时先重试，第二次仍失败则交回一条说明', chatCalls.length === 4 && /本机没能取回/.test(String(notice.text)) && !notice.attachments, JSON.stringify(String(notice.text).slice(0, 80)));
check('inbound: 说明里带上了文件名与错误码，用户能据此重发', /打不开的\.txt/.test(String(notice.text)) && /media_decrypt_failed/.test(String(notice.text)), String(notice.text));
state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
check('inbound: 回执标成 mediaFailure + notice，而不是静默丢弃', state.ledger['7520900000000000004']?.state === 'acked' && state.ledger['7520900000000000004']?.mediaFailure === 'media_decrypt_failed', JSON.stringify(state.ledger['7520900000000000004'] || {}));
check('inbound: 失败的媒体计入 mediaFailed', state.stats.mediaFailed === 1 && state.stats.media === 3 && state.stats.mediaBytes === filePlain.length + imagePlain.length + plainImage.length, JSON.stringify(state.stats));

// --- 3.5 the object is gone from the CDN ---
downloadsFailWith = 404;
batches = [[makeMessage('7520900000000000005', [{ type: 4, file_item: { media: { encrypt_query_param: 'P-GONE', aes_key: Buffer.from(KEY_A.toString('hex'), 'utf8').toString('base64') }, file_name: '已过期.txt', len: '10' } }])]];
await sleep(3000);
check('inbound: CDN 404 也交回说明而不是吞掉消息', chatCalls.length === 5 && /cdn_download_failed/.test(String(chatCalls[4].text)), String(chatCalls[4]?.text || '').slice(0, 120));
state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
check('inbound: 第二次失败计入 mediaFailed', state.stats.mediaFailed === 2, JSON.stringify(state.stats.mediaFailed));
downloadsFailWith = 0;

// --- 3.6 voice: the server transcript is used, a bare SILK is counted ---
batches = [[makeMessage('7520900000000000006', [{ type: 3, voice_item: { text: '这是服务端的转写' } }])]];
await sleep(800);
check('inbound: 语音自带转写时按文字交给 NewMate', chatCalls.length === 6 && chatCalls[5].text === '这是服务端的转写' && !chatCalls[5].attachments, JSON.stringify(chatCalls[5]));
batches = [[makeMessage('7520900000000000007', [{ type: 3, voice_item: { media: { encrypt_query_param: 'P-SILK', aes_key: 'x' } } }])]];
await sleep(800);
state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
check('inbound: 没有转写的语音被单独计数（本机没有 SILK 解码器）', chatCalls.length === 6 && state.stats.voiceUnsupported === 1, JSON.stringify({ calls: chatCalls.length, voice: state.stats.voiceUnsupported }));

// --- 3.7 a crafted file name stays inside the store, and a replay is not delivered twice ---
const evilPlain = Buffer.from('不该跑出去的字节\n', 'utf8');
encryptFor('P-EVIL', KEY_A, evilPlain);
batches = [[makeMessage('7520900000000000008', [{ type: 4, file_item: { media: { encrypt_query_param: 'P-EVIL', aes_key: Buffer.from(KEY_A.toString('hex'), 'utf8').toString('base64') }, file_name: '../../evil.txt', len: String(evilPlain.length) } }])]];
await sleep(900);
const evilCall = chatCalls[6] || {};
check('inbound: 恶意的文件名被裁成裸名', evilCall.attachments?.[0]?.name === 'evil.txt', JSON.stringify(evilCall.attachments?.[0]?.name));
check('inbound: 文件仍然只落在上传目录里', Boolean(evilCall.attachments?.[0]) && evilCall.attachments[0].path.startsWith(store.uploadsRoot(channelRoot)), evilCall.attachments?.[0]?.path);
const callsBeforeReplay = chatCalls.length;
batches = [[makeMessage('7520900000000000008', [{ type: 4, file_item: { media: { encrypt_query_param: 'P-EVIL', aes_key: Buffer.from(KEY_A.toString('hex'), 'utf8').toString('base64') }, file_name: '../../evil.txt', len: String(evilPlain.length) } }])]];
await sleep(900);
check('inbound: 同一条媒体消息重放不会二次投递', chatCalls.length === callsBeforeReplay, callsBeforeReplay + ' -> ' + chatCalls.length);
await channel.stop().catch(() => {});
await new Promise((resolve) => server.close(resolve));

/* ================= 4. THE REAL PLUGIN ROW: TOOL + BYTE ROUTE ================= */
const mountRoot = path.join(tempBase, 'mounted');
fs.mkdirSync(mountRoot, { recursive: true });
const core = await mountCore({ root: mountRoot, packagesDir: path.join(repo, 'packages') });
try {
  const readerTool = core.tools.get('newmate_attachment_read');
  check('mount: 读取工具进了共享注册表（任何对话都能看见）', Boolean(readerTool), [...core.tools.keys()].filter((n) => n.startsWith('newmate')).sort().join(','));
  check('mount: 读取工具只有 path 一个必填参数', JSON.stringify(readerTool?.parameters?.required) === JSON.stringify(['path']) && readerTool?.parameters?.additionalProperties === false, JSON.stringify(readerTool?.parameters?.required));
  check('mount: 读取工具在 NewMate 自己的运行工具组里', NEWMATE_RUN_TOOLS.includes('newmate_attachment_read'));
  check('mount: 它不属于“必须用户明确要求”的那一类（只能读用户给过的文件）', NEWMATE_REQUEST_TOOLS.includes('newmate_attachment_read') === false);

  const uploadRoute = core.routes.find((route) => route.path === '/newmark-newmate/upload');
  check('mount: 字节上传路由已注册（与 JSON 动作分开）', Boolean(uploadRoute), core.routes.map((r) => r.path).join(','));

  /* Both the upload route and the JSON action read their body with for-await, so the gate hands
   * them an async-iterable request: that is the shape the real server provides. */
  const driveRoute = (route, method, headers, chunks) => new Promise((resolve, reject) => {
    const req = {
      method, headers, url: route.path, destroyed: false,
      destroy() { req.destroyed = true; },
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
    };
    let status = 0;
    const res = {
      writeHead(code) { status = code; },
      end(body) { const text = String(body || ''); try { resolve({ status, json: text ? JSON.parse(text) : null }); } catch (error) { reject(error); } },
    };
    route.handler(req, res).catch(reject);
  });

  const bytes = Buffer.from('页面拖进来的内容\n第二行\n', 'utf8');
  const uploaded = await driveRoute(uploadRoute, 'POST', { 'x-newmark-newmate': '1', 'x-newmate-filename': encodeURIComponent('拖入的文件.md') }, [bytes.subarray(0, 7), bytes.subarray(7)]);
  check('route: 二进制体被接收并保存', uploaded.status === 200 && uploaded.json?.ok === true, JSON.stringify(uploaded.json).slice(0, 200));
  const pageEntry = uploaded.json?.attachment;
  check('route: 回执带 id/name/bytes/kind/sha256', Boolean(pageEntry) && pageEntry.name === '拖入的文件.md' && pageEntry.bytes === bytes.length && pageEntry.sha256 === crypto.createHash('sha256').update(bytes).digest('hex'), JSON.stringify(pageEntry).slice(0, 200));
  check('route: 落盘字节与请求体完全一致', Boolean(pageEntry) && fs.readFileSync(pageEntry.path).equals(bytes));
  check('route: 来源标成 page', pageEntry?.source === 'page');

  const readViaTool = await readerTool.execute({ path: pageEntry.path, offset: 1, limit: 5 }, {});
  check('tool: 读到刚上传的文本并带行数信息', readViaTool.ok === true && readViaTool.text.includes('页面拖进来的内容') && readViaTool.text.includes('第二行') && readViaTool.lines >= 2, JSON.stringify(readViaTool).slice(0, 220));
  const outsideRead = await readerTool.execute({ path: path.join(tempBase, 'chat', 'newMate', 'state.json') }, {});
  check('tool: 上传目录之外一律拒绝（连 state.json 也不行）', outsideRead.ok === false && outsideRead.code === 'file_not_in_upload_store', JSON.stringify(outsideRead).slice(0, 200));
  const noPath = await readerTool.execute({}, {});
  check('tool: 没有 path 时是有码的拒绝而不是崩溃', noPath.ok === false && noPath.code === 'path_required', JSON.stringify(noPath));

  const wrongMethod = await driveRoute(uploadRoute, 'GET', { 'x-newmark-newmate': '1' }, []);
  check('route: 只接受 POST', wrongMethod.status === 405, String(wrongMethod.status));
  const noHeader = await driveRoute(uploadRoute, 'POST', {}, [Buffer.from('x')]);
  check('route: 没有 x-newmark-newmate 头就拒绝', noHeader.status === 400 && /请求来源无效/.test(String(noHeader.json?.error)), JSON.stringify(noHeader.json));
  const emptyBody = await driveRoute(uploadRoute, 'POST', { 'x-newmark-newmate': '1', 'x-newmate-filename': 'a.txt' }, []);
  check('route: 空体给出 file_empty 而不是存一个空文件', emptyBody.status === 400 && emptyBody.json?.code === 'file_empty', JSON.stringify(emptyBody.json));
  const huge = await driveRoute(uploadRoute, 'POST', { 'x-newmark-newmate': '1', 'x-newmate-filename': 'big.bin' }, [Buffer.alloc(store.UPLOAD_MAX_BYTES + 1)]);
  check('route: 超过自设上限返回 413 且不落盘', huge.status === 413 && huge.json?.code === 'file_too_large', JSON.stringify(huge.json));

  const jsonRoute = core.routes.find((route) => route.path === '/newmark-newmate');
  const bad = await driveRoute(jsonRoute, 'POST', { 'x-newmark-newmate': '1' }, [Buffer.from(JSON.stringify({ action: 'chat', text: '带坏附件的消息', attachments: [{ id: 'x', name: 'a.txt', path: 'relative.txt' }] }), 'utf8')]);
  check('route: chat 动作把附件交给 chat()（相对路径的记录被拒且带原因）', bad.status === 400 && /附件记录无效/.test(String(bad.json?.error)), JSON.stringify(bad.json));
} finally {
  await core.dispose();
}

/* ========================= 5. THE PAGE AND THE ROW SOURCE ========================= */
const clientSource = fs.readFileSync(path.join(repo, 'packages/newmark-core/client.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(repo, 'packages/newmark-core/components/newmate/index.js'), 'utf8');
check('page: 有隐藏的文件选择控件', clientSource.includes("h('input',{type:'file',multiple:true,ref:fileInput"));
check('page: 字节发到 /newmark-newmate/upload，而不是塞进 JSON 动作', clientSource.includes('/newmark-newmate/upload') && clientSource.includes('x-newmate-filename'));
check('page: 发送时把附件记录随 chat 一起提交', clientSource.includes('attachments:attached.length?attached:undefined'));
check('page: 用户消息里渲染附件标签', clientSource.includes('(Array.isArray(m.attachments)?m.attachments:[])') && clientSource.includes('.nm-attach{'));
check('page: 发完清空待发附件（不会跟着下一条再发一次）', clientSource.includes('setFiles([])'));
check('row: 上传路由与读取工具都真的注册了', indexSource.includes("path: '/newmark-newmate/upload'") && indexSource.includes("name: 'newmate_attachment_read'"));
check('row: JSON 的 chat 动作把附件透传', indexSource.includes('mate.chat(input.text,undefined,input.threadId,input.attachments)'));

/* ================================ 6. VERDICT ================================ */
const failed = results.filter((r) => !r.pass);
console.log('');
if (failed.length) {
  console.log('FAIL ' + failed.length + ' / ' + results.length + ' attachment checks failed:');
  for (const item of failed) console.log('  - ' + item.name);
  process.exitCode = 1;
} else {
  console.log('PASS ' + results.length + ' NewMate attachment checks (store, chat, channel, route, page)');
}
fs.rmSync(tempBase, { recursive: true, force: true });
