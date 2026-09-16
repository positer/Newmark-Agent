/**
 * 源码构建实机队列测试：真实 provider（deepseek-v4.1-flash-expires-on-0910）。
 *
 * 使用隔离 root + 复制用户 config.json（含凭据），不污染现有会话：
 *   1. 首个真实 Build 运行中提交 Next（走输入框 + Next 模式）
 *   2. 队列面板出现该行（对话区不应提前出现）
 *   3. 暂停 / 恢复
 *   4. 出队后：用户输入 + 模型回复都出现在对话区
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const desktopRoot = path.resolve(__dirname, '..');
const archiveDir = path.join(desktopRoot, '..', 'archive', '20260915-dev065-popup-models');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MODEL = 'deployment:provider-deepseek-001:deepseek-v4.1-flash-expires-on-0910';

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(error => error ? reject(error) : resolve(address.port)); });
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.setTimeout(1500, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function discover(port, child) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null) throw new Error(`app exited: ${child.exitCode}`);
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error('CDP timeout');
}

function connect(page) {
  let sequence = 0;
  const pending = new Map();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  };
  const call = (method, params = {}) => {
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
    const id = ++sequence;
    // Keep the promise itself referenced while awaiting: V8 otherwise collects the
    // pending promise during long real-model runs and rejects with "Promise was collected".
    globalThis.__pending = globalThis.__pending || new Map();
    globalThis.__pending.set(id, promise);
    pending.set(id, { resolve: resolveFn, reject: rejectFn });
    ws.send(JSON.stringify({ id, method, params }));
    const timeout = setTimeout(() => {
      if (pending.delete(id)) {
        globalThis.__pending.delete(id);
        rejectFn(new Error(`timeout ${method}`));
      }
    }, 600000);
    return promise.finally(() => { clearTimeout(timeout); globalThis.__pending.delete(id); });
  };
  return { ready: Promise.race([opened, new Promise((_, reject) => setTimeout(() => reject(new Error('ws timeout')), 15000))]), call, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function shot(cdp, name) {
  const captured = await cdp.call('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(archiveDir, { recursive: true });
  const file = path.join(archiveDir, name);
  fs.writeFileSync(file, Buffer.from(captured.data, 'base64'));
  return file;
}

const snapshotExpr = `(async () => {
  const target = currentConversationTarget();
  const snapshot = await api.getState(target);
  window.renderInputStack();
  return {
    model: state.model,
    status: snapshot && snapshot.status,
    running: !!(snapshot && snapshot.runtime && snapshot.runtime.running),
    queuePaused: snapshot && snapshot.queuePaused,
    queueItems: (snapshot && snapshot.queueItems || []).map(item => item.text),
    chatMessages: (snapshot.chatMessages || []).map(message => '[' + String(message.role) + '] ' + String(message.content || '').replace(/\\s+/g, ' ').slice(0, 80)),
    renderedUserBubbles: Array.from(document.querySelectorAll('#chat-area .chat-msg.user')).map(node => String(node._newmarkMessageText || '').replace(/\\s+/g, ' ').slice(0, 60)),
    panelRows: Array.from(document.querySelectorAll('#queue-list .queue-item')).map(row => (row.querySelector('.queue-edit') || {}).value || ''),
    inlineQueuedBubbles: document.querySelectorAll('#chat-area .queue-pending-user').length,
    replySnippet: ((snapshot.chatMessages || []).filter(message => String(message.role) === 'assistant').pop() || {}).content || ''
  };
})()`;

(async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'NewmarkModelUi-'));
 const port=await freeTcpPort();
 const child=spawn(require(path.join(desktopRoot,'node_modules','electron')),[desktopRoot,`--remote-debugging-port=${port}`,'--root',root],{cwd:desktopRoot,stdio:'ignore',windowsHide:true});
 const cdp=connect(await discover(port,child));await cdp.ready;await waitForPromotedMainUi(cdp);
 await evaluate(cdp, `state.providers=[{id:'fixture-a',name:'Provider A',models:[{name:'same-api',display:'Alpha'}]},{id:'fixture-b',name:'Provider B',models:[{name:'same-api',display:'Beta'}]}]; window.addModel();`);
 await sleep(800);await shot(cdp,'pc-add-model.png');
 const results=await evaluate(cdp, `(async()=>{
 const saved=[];
 document.getElementById('new-model-name').value='new-api';document.getElementById('new-model-display').value='Friendly New';window.saveNewModel();
 if(state.providers[0].models[1].display!=='Friendly New')throw Error('new display lost');
 window.editModel(1,0);document.getElementById('edit-model-display').value='Friendly B';document.getElementById('edit-model-name').value='renamed-api';
 state.providers.reverse();window.saveModelEdit(1,0);await new Promise(r=>setTimeout(r,300));
 const a=state.providers.find(p=>p.id==='fixture-a'),b=state.providers.find(p=>p.id==='fixture-b');
 if(a.models[0].name!=='same-api'||a.models[0].display!=='Alpha'||b.models[0].name!=='renamed-api'||b.models[0].display!=='Friendly B')throw Error('provider isolation failed');
 b.models.push({name:'same-api',display:'Same B'});
 if(modelDeploymentValueForName('same-api','')!=='')throw Error('ambiguous fallback guessed provider');
 if(modelDeploymentValueForName('same-api','fixture-b')!=='deployment:fixture-b:same-api')throw Error('qualified fallback failed');
 return {passed:true,providers:state.providers};})()`);
 await evaluate(cdp, `window.editModel(0,0)`);await sleep(800);await shot(cdp,'pc-edit-model.png');fs.writeFileSync(path.join(archiveDir,'pc-evidence.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 await new Promise(r=>setTimeout(r,12000));cdp.close();child.kill();
})().catch(e=>{console.error(e);process.exitCode=1;});
