'use strict';
// Sustained real Electron GUI/IPC usage against an owned, local HTTP provider.
// --duration-seconds 1800 is an actual 30-minute activity period; setup and cold
// restart are measured separately. No user root or installed process is touched.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const desktop = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('Usage: node scripts/test-user-soak-gui.cjs [--calibration] [--duration-seconds 1800] [--exe PATH] [--asar-sha256 SHA256] [--evidence NEW_DIRECTORY]\nSeeds 1200/240/80 messages in a fresh temporary root, uses one real Electron at a time, then cold-restarts it. The duration measures the activity loop only. Evidence defaults to a fresh timestamped archive. Loopback HTTP only; no real credentials.');
  process.exit(0);
}
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const durationSeconds = Number(option('--duration-seconds', argv.includes('--calibration') ? '120' : '1800'));
const exe = path.resolve(option('--exe', path.join(desktop, 'node_modules/electron/dist/electron.exe')));
const packaged = fs.existsSync(path.join(path.dirname(exe), 'resources/app.asar'));
const appRoot = packaged ? path.join(path.dirname(exe), 'resources/app.asar') : desktop;
const evidence = path.resolve(option('--evidence', path.join(desktop, '../archive', new Date().toISOString().replace(/[:.]/g, '-') + '-gui-soak')));
const expectedAsar = option('--asar-sha256', '').toUpperCase();
const historyCount = Math.max(1200, Number(option('--history-count', '1200')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((values.length - 1) * p))] : null;
const distribution = values => ({ count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), max: values.length ? Math.max(...values) : null });
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
async function until(read, accept, label, timeout = 30000) {
  const started = performance.now(); let value;
  do { value = await read(); if (accept(value)) return value; await sleep(80); } while (performance.now() - started < timeout);
  throw Error(label + ' timeout; last=' + JSON.stringify(value)?.slice(0, 1000));
}
function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(); let id = 0;
  const ready = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => { const message = JSON.parse(event.data), item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result); };
  return { socket, ready, call(method, params = {}, timeout = 15000) { return new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject, timer: setTimeout(() => { pending.delete(requestId); reject(Error('CDP timeout: ' + method)); }, timeout) }); socket.send(JSON.stringify({ id: requestId, method, params })); }); } };
}
const seedSource = String.raw`
const fs=require('node:fs'),path=require('node:path');
const [root,appRoot,out,countText]=process.argv.slice(2),count=Number(countText);
if(!path.basename(root).startsWith('newmark-user-soak-'))throw Error('Owned fresh root required');
const {Agent}=require(path.join(appRoot,'dist/core/agent.js'));
const {markRuntimeLifecycleClean}=require(path.join(appRoot,'dist/core/runtimeLifecycle.js'));
const agent=new Agent(root,{agentOnly:true}),workspace=agent.createInternalWorkspace('User soak fixture'),targets={},messages={};
for(const [name,size]of [['A',count],['B',240],['C',80]]){
 const c=agent.createConversationInWorkspace(workspace,'Soak '+name);agent.setConversation(c.id);
 messages[name]=Array.from({length:size},(_,i)=>({messageId:'SOAK_HISTORY_'+name+'_'+String(i).padStart(5,'0'),role:i%2?'assistant':'user',content:'SOAK_HISTORY_'+name+'_'+String(i).padStart(5,'0')+' Persisted historical message: the user can browse this conversation without duplicating, losing or reordering messages. '+(i%12===1?'\n\n## Example\n- first item\n- second item\n\n| Name | Value |\n| --- | --- |\n| Test | '+i+' |\n\n~~~js\nconst answer = '+i+';\n~~~':'The preceding context remains available across workspaces and restarted sessions.'),mode:'chat',model:'soak-loopback',timestamp:'2026-09-01T10:'+String(Math.floor(i/60)%60).padStart(2,'0')+':'+String(i%60).padStart(2,'0')+'.000Z',runId:'history-'+name+'-'+Math.floor(i/2)}));
 agent.chatMessages=messages[name];agent.history=messages[name].map(m=>({role:m.role,content:m.content,run_id:m.runId}));agent.saveWorkspaceConversationState(true);agent.saveStoredConversationDraft('SOAK_SEEDED_DRAFT_'+name,c.id);if(agent.getStoredConversationDraft(c.id)!=='SOAK_SEEDED_DRAFT_'+name)throw Error('Seed draft write/read mismatch '+name);agent.renameConversation(c.id,'Soak '+name);targets[name]={workspaceId:workspace.id,conversationId:c.id};
}
agent.setConversation(targets.A.conversationId);agent.saveWorkspaceConversationState(true);agent.flushWorkspaceConversationState();markRuntimeLifecycleClean(root,'main');
fs.writeFileSync(out,JSON.stringify({targets,messages},null,2));console.log('Clean isolated history seeded: '+count+'/240/80.');process.exit(0);
`;
let root, report, child, renderer, mainCdp, logFd, seed, heartbeatTimer, sampleBusy = false, diagnosticsBusy = false;
const latency = {}, sockets = new Set(), held = new Set();
const save = () => { if (!report) return; report.metrics = Object.fromEntries(Object.entries(latency).map(([name, values]) => [name, distribution(values)])); fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2)); };
const append = (file, value) => fs.appendFileSync(path.join(evidence, file), JSON.stringify(value) + '\n');
function check(name, pass, detail) { report.checks.push({ name, pass: !!pass, detail, at: new Date().toISOString() }); save(); if (!pass) throw Error(name); }
async function measured(name, operation) { const start = performance.now(); try { return await operation(); } finally { const elapsedMs = performance.now() - start; (latency[name] ||= []).push(elapsedMs); append('actions.jsonl', { name, elapsedMs, at: new Date().toISOString() }); } }
async function evaluate(expression, client = renderer, timeout = 15000) { const result = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; }
const ipc = (method, ...args) => measured('ipc:' + method, () => evaluate('window.api[' + JSON.stringify(method) + '](...' + JSON.stringify(args) + ')'));
async function screenshot(name) { const shot = await renderer.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 5000); const file = path.join(evidence, name + '.png'); fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); report.screenshots.push(file); }
async function processMetrics() {
  const ownPid = child?.pid; if (!Number.isInteger(ownPid)) return [];
  // Numeric exact PID and descendants only. No user process command lines or
  // other app memory are copied into the report. This works with the real
  // packaged launcher, which intentionally rejects a Node --inspect argument.
  const command = `$all=Get-CimInstance Win32_Process; $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${ownPid}); do { $n=$ids.Count; foreach($x in $all){if($ids.Contains([int]$x.ParentProcessId)){[void]$ids.Add([int]$x.ProcessId)}} } while($ids.Count -gt $n); @($all | Where-Object {$ids.Contains([int]$_.ProcessId)} | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; $role=if($_.ProcessId -eq ${ownPid}){'main'}elseif($_.CommandLine -match '--type=([a-z-]+)'){$Matches[1]}else{'child'}; [PSCustomObject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;role=$role;workingSetBytes=[double]$p.WorkingSet64;privateBytes=[double]$p.PrivateMemorySize64;cpuSeconds=[double]$p.CPU;responding=$p.Responding} }) | ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',command], { windowsHide: true, timeout: 12000, maxBuffer: 1024*1024 }, (error, stdout) => { if (error) reject(error); else { const value=JSON.parse(stdout||'[]');resolve(Array.isArray(value)?value:[value]); } }));
}
async function diagnose(reason) {
  if (diagnosticsBusy || !renderer) return; diagnosticsBusy = true;
  const note = { reason, at: new Date().toISOString(), cycle: report.cycles, ownedPid: child?.pid };
  try {
    note.processes = await processMetrics().catch(error => ({error:String(error)}));
    note.rendererVisibility = await evaluate('({visibility:document.visibilityState,focused:document.hasFocus(),frameWait:window.__soakFrameWait})').catch(error=>({error:String(error)}));
    note.mainStackBoundary = 'Real packaged launcher has no main inspector; preserve process response/memory/CPU and renderer stack without changing launch semantics.';
    for (const [name, client] of [['renderer', renderer]]) {
      let pauseEvent,resolvePaused,pauseTrigger;
      const paused=new Promise(resolve=>{resolvePaused=resolve;});
      const listener = event => { const message = JSON.parse(event.data); if (message.method === 'Debugger.paused') { pauseEvent = message.params;resolvePaused(); } };
      client.socket.addEventListener('message', listener);
      try { await client.call('Debugger.enable', {}, 4000); await client.call('Debugger.pause', {}, 4000); pauseTrigger=client.call('Runtime.evaluate',{expression:'performance.now()',returnByValue:true},5000).catch(()=>{});await Promise.race([paused,sleep(1500)]); note[name + 'Stack'] = pauseEvent; }
      catch (error) { note[name + 'StackError'] = String(error); }
      finally { await client.call('Debugger.resume', {}, 4000).catch(() => {});await client.call('Debugger.disable',{},4000).catch(()=>{});await pauseTrigger;client.socket.removeEventListener('message', listener); }
    }
    await screenshot('diagnostic-' + report.diagnostics.length);
  } catch (error) { note.error = String(error); }
  finally { report.diagnostics.push(note); append('diagnostics.jsonl', note); save(); diagnosticsBusy = false; }
}
async function sample() {
  if (sampleBusy || diagnosticsBusy || !renderer) return; sampleBusy = true;
  const start = performance.now();
  try {
    const value = await measured('heartbeat', () => evaluate(`(()=>{const count=o=>Object.keys(o||{}).length,rows=o=>Object.values(o||{}).reduce((n,a)=>n+(Array.isArray(a)?a.length:0),0);return{now:performance.now(),visibility:document.visibilityState,focused:document.hasFocus(),frameWait:window.__soakFrameWait,target:currentConversationTarget(),prompt:document.getElementById('prompt').value.length,rendered:(state.renderedChatMessages||[]).length,domNodes:document.getElementsByTagName('*').length,chatNodes:document.getElementById('chat-area').getElementsByTagName('*').length,cache:{messageTargets:count(state.conversationMessagesByTarget),messages:rows(state.conversationMessagesByTarget),eventTargets:count(state.agentWorkEventsByConversation),events:rows(state.agentWorkEventsByConversation),workTargets:count(state.workRunsByTarget),runs:rows(state.workRunsByTarget),drafts:count(state.conversationDrafts)},longTasks:window.__soakLongTasks.splice(0),inputPaints:window.__soakInputPaints.splice(0),unhandled:window.__soakUnhandled.splice(0)};})()`));
    value.heap = await renderer.call('Runtime.getHeapUsage');
    for(const paint of value.inputPaints)(latency[paint.trusted ? 'trusted-input-event-to-paint' : 'programmatic-input-event-to-paint'] ||= []).push(paint.elapsedMs);
    if (report.sampleCount % 5 === 0) report.lastProcessMetrics = await processMetrics();
    value.processes = report.lastProcessMetrics;
    value.at = new Date().toISOString(); value.sinceSoakStartMs = report.activityStartedMs ? Date.now() - report.activityStartedMs : null;
    append('samples.jsonl', value); report.lastSample = value; report.sampleCount++;
    if (value.unhandled.length || value.processes?.some(p=>p.responding===false)) { report.runtimeProblems.push(value); await diagnose('unhandled rejection or owned process not responding'); }
    if (latency.heartbeat.at(-1) > 2000) await diagnose('renderer heartbeat slower than 2000 ms');
    save();
  } catch (error) { if(diagnosticsBusy){append('diagnostic-observer-interruptions.jsonl',{at:new Date().toISOString(),error:String(error)});return;} report.runtimeProblems.push({ at: new Date().toISOString(), error: String(error) }); save(); await diagnose('sample failure: ' + error); }
  finally { sampleBusy = false; }
}
function emit(response, delta, finishReason = null) { response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] }) + '\n\n'); }
function finish(response, text) { if (response.destroyed) return; emit(response, { content: text }); emit(response, {}, 'stop'); response.end('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 4000, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 3200 } } }) + '\n\ndata: [DONE]\n\n'); }
const provider = http.createServer(async (request, response) => {
  try {
    let raw = ''; for await (const data of request) raw += data;
    const body = JSON.parse(raw || '{}'), messages = body.messages || [], latest = messages.findLastIndex(m => m.role === 'user');
    const input = typeof messages[latest]?.content === 'string' ? messages[latest].content : JSON.stringify(messages[latest]?.content || '');
    const marker = input.match(/SOAK_(?:BUILD|HOLD|NEXT|EDIT|GUIDE)_\d+/)?.[0] || 'SOAK_REPLY';
    const title = messages.some(m => m.role === 'system' && String(m.content).includes('conversation title generator'));
    const entry = { at: new Date().toISOString(), marker, title, stream: body.stream, messageCount: messages.length, requestBytes: Buffer.byteLength(raw) }; report.requests.push(entry); append('requests.jsonl', entry); save();
    if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: title ? 'Soak conversation' : marker + '_DONE' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } })); return; }
    response.setHeader('content-type', 'text/event-stream'); response.flushHeaders();
    if (/SOAK_(?:HOLD|GUIDE)_/.test(marker)) { emit(response, { content: marker + ' publicly visible partial reply. This is a deliberately held local request so that ordinary user Guide, Next queue management and Stop can be exercised while the actual Build is running. Retain this text on interruption.' }); held.add(response); response.on('close', () => held.delete(response)); return; }
    if (/SOAK_BUILD_/.test(marker) && !messages.slice(latest + 1).some(m => m.role === 'tool')) { emit(response, { content: marker + ' checking current directory. ' }); emit(response, { tool_calls: [{ index: 0, id: 'pwd-' + marker, type: 'function', function: { name: 'pwd', arguments: '{}' } }] }); emit(response, {}, 'tool_calls'); response.end('data: [DONE]\n\n'); return; }
    for (const text of [marker + ' response ', 'is streaming through the normal provider, ', 'kernel and IPC boundary. ']) { if (response.destroyed) return; emit(response, { content: text }); await sleep(35); }
    finish(response, marker + '_DONE');
  } catch (error) { report.providerErrors.push(String(error)); response.destroy(); save(); }
});
provider.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
async function launch(round) {
  const cdpPort = await freePort();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const entryArgs = packaged ? [] : [desktop];
  logFd = fs.openSync(path.join(evidence, round + '-electron.log'), 'wx');
  child = spawn(exe, [...entryArgs, '--allow-multiple-instances', '--remote-debugging-port=' + cdpPort, '--root', root, '--user-data-dir=' + path.join(root, 'ElectronData')], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', logFd, logFd] });
  const receipt = { round, pid: child.pid, cdpPort, startedAt: new Date().toISOString() }; report.launches.push(receipt); save();
  const getTargets = async port => { try { return await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) })).json(); } catch { return []; } };
  const target = await until(async () => { if (child.exitCode !== null) throw Error('Owned Electron exited ' + child.exitCode); return (await getTargets(cdpPort)).find(t => t.type === 'page' && t.url.includes('index.html')); }, Boolean, 'Promoted owned GUI', 60000);
  renderer = connect(target); await renderer.ready; await waitForPromotedMainUi(renderer); await renderer.call('Runtime.enable');
  renderer.socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Runtime.exceptionThrown') { report.rendererErrors.push(message.params.exceptionDetails); save(); } });
  check('Owned launched UI identity: ' + round, target.url.includes(packaged ? 'app.asar' : 'dist/ui/index.html'), {pid:child.pid,url:target.url});
  await renderer.call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`(()=>{window.__soakLongTasks=[];window.__soakUnhandled=[];window.__soakInputPaints=[];window.__soakClicks=[];document.getElementById('prompt').addEventListener('input',e=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__soakInputPaints.push({elapsedMs:performance.now()-start,trusted:e.isTrusted})));},true);document.addEventListener('click',e=>{const row={at:performance.now(),id:e.target.id,tag:e.target.tagName,cls:String(e.target.className),trusted:e.isTrusted,gen:state.conversationLoadGeneration,before:state.conversationLoadedBefore[runtimeKeyFor(currentConversationTarget().workspaceId,currentConversationTarget().conversationId)]};window.__soakClicks.push(row);if(window.__soakClicks.length>120)window.__soakClicks.shift();queueMicrotask(()=>row.prevented=e.defaultPrevented);},true);try{new PerformanceObserver(list=>{for(const e of list.getEntries())window.__soakLongTasks.push({start:e.startTime,duration:e.duration});}).observe({entryTypes:['longtask']});}catch{}window.addEventListener('unhandledrejection',e=>window.__soakUnhandled.push(String(e.reason)));if(!state.bottomCollapsed)window.toggleBottom();return true;})()`);
}
async function close() {
  if (!child) return; const owned = child;
  const ownedTree = await processMetrics();
  try { await evaluate('window.api.exitApplication()', renderer, 3000); } catch {}
  await until(() => owned.exitCode, value => value !== null, 'Owned normal exit', 18000);
  const ownedIds = ownedTree.map(p=>Number(p.pid)).filter(Number.isInteger);
  const remaining = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command', '$ids=@('+ownedIds.join(',')+'); @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress'], { windowsHide:true,timeout:12000 }, (error,stdout)=>{if(error&&stdout.trim())reject(error);else {const ids=JSON.parse(stdout||'[]');resolve(Array.isArray(ids)?ids:[ids]);}}));
  Object.assign(report.launches.at(-1), { exitCode: owned.exitCode, finishedAt: new Date().toISOString(), ownedProcessIds:ownedIds, remainingProcessIds:remaining });
  renderer?.socket.close(); renderer = null; fs.closeSync(logFd); logFd = undefined; child = null; save();
}
async function click(selector) {
  await renderer.call('Page.bringToFront');
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing click target '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',behavior:'instant'});return true;})()`);
  await painted('click '+selector);
  const point = await until(()=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,hitId:hit?.id,hitTag:hit?.tagName,hitClass:String(hit?.className),hit:e===hit||e.contains(hit)};})()`),v=>v.hit,'Clickable hit target '+selector,5000);
  append('pointer-targets.jsonl',{selector,point,at:new Date().toISOString()});
  await renderer.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await renderer.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await renderer.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function painted(label) {
  const frame = await evaluate(`new Promise(resolve=>{const started=performance.now();let done=false;window.__soakFrameWait={label:${JSON.stringify(label)},started,visibility:document.visibilityState,focused:document.hasFocus()};const finish=ok=>{if(done)return;done=true;clearTimeout(timer);const value={...window.__soakFrameWait,ok,elapsedMs:performance.now()-started,endVisibility:document.visibilityState};window.__soakFrameWait=value;resolve(value);};const timer=setTimeout(()=>finish(false),2200);requestAnimationFrame(()=>requestAnimationFrame(()=>finish(true)));})`);
  if(!frame.ok){append('frame-waits.jsonl',frame);throw Error('Animation frames did not advance: '+JSON.stringify(frame));}
}
async function type(text) {
  return measured('input-full-command', async () => {
    await click('#prompt');
    await renderer.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await renderer.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await measured('text-insertion-to-paint',async()=>{
      if (text) await renderer.call('Input.insertText', { text });
      else { await renderer.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await renderer.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); }
      await painted('insert text');const value = await evaluate('document.getElementById("prompt").value');
      if (value !== text) throw Error('Input text mismatch: ' + JSON.stringify(value));
    });
  });
}
async function select(name) {
  await measured('conversation-switch', async () => {
    await evaluate(`(()=>{const i=state.conversations.findIndex(c=>c.id===${JSON.stringify(seed.targets[name].conversationId)});if(i<0)throw Error('Missing seed conversation');window.switchConversation(i);return true;})()`);
    await until(() => evaluate(`(()=>{const t=currentConversationTarget(),key=runtimeKeyFor(t.workspaceId,t.conversationId);return{target:t,ids:(state.renderedChatMessages||[]).map(m=>m.messageId||''),before:state.conversationLoadedBefore[key],button:!!document.querySelector('.conversation-load-earlier')};})()`), value => value.target.conversationId === seed.targets[name].conversationId && value.ids.some(id => id.startsWith('SOAK_HISTORY_' + name + '_')) && (value.button || value.before === 0), 'Conversation hydrated ' + name);
  });
}
async function pageAll(name, full = true) {
  let pages = 0;
  while (true) {
    const ready=await until(()=>evaluate(`(()=>{const t=currentConversationTarget(),b=document.querySelector('.conversation-load-earlier');return{before:state.conversationLoadedBefore[runtimeKeyFor(t.workspaceId,t.conversationId)],button:!!b,disabled:b?.disabled};})()`),v=>v.before===0||(v.button&&!v.disabled),'Pagination affordance');
    if(ready.before===0)break;
    const before = await evaluate('(state.renderedChatMessages||[]).length');
    await measured('history-page', async () => { await click('.conversation-load-earlier'); try{await until(() => evaluate('(state.renderedChatMessages||[]).length'), count => count > before, 'Earlier page');}catch(error){report.paginationFailure=await evaluate(`({target:currentConversationTarget(),gen:state.conversationLoadGeneration,cursors:state.conversationLoadedBefore,clicks:window.__soakClicks,rendered:(state.renderedChatMessages||[]).map(m=>m.messageId)})`);save();throw error;} });
    if (!full && ++pages >= 2) break;
  }
  const ids = await evaluate(`(state.renderedChatMessages||[]).map(m=>m.messageId).filter(id=>String(id).startsWith('SOAK_HISTORY_'))`);
  const expected = seed.messages[name].map(m => m.messageId);
  check('History identity/order after pagination ' + report.cycles, new Set(ids).size === ids.length && ids.every((id, i) => id === expected[expected.length - ids.length + i]) && (!full || ids.length === expected.length), { name, count: ids.length, full });
}
async function submit(text, mode = 'next', wait = false) {
  await type(text);
  await evaluate(`(()=>{window.__soakSendDone=false;window.__soakSendError=null;window.sendMessage(${JSON.stringify(mode)}).then(()=>window.__soakSendDone=true,e=>{window.__soakSendError=String(e);window.__soakSendDone=true;});return true;})()`);
  if (wait) await until(() => evaluate('({done:window.__soakSendDone,error:window.__soakSendError,running:!!runningConversationRecord(activeConversationId())})'), value => value.done && !value.running, 'Completed user send');
}
async function regularBuild(cycle) {
  await type(''); await evaluate(`window.queueAction('queue_set_pause',{paused:false},currentConversationTarget())`);
  await measured('complete-build', () => submit('SOAK_BUILD_' + cycle + ': use pwd then reply.', 'next', true));
  const snapshot = await ipc('getState', seed.targets.A);
  check('Real HTTP tool/text Build completed ' + cycle, JSON.stringify(snapshot).includes('SOAK_BUILD_' + cycle + '_DONE'), { requests: report.requests.length, workRuns: snapshot.workRuns?.length });
}
async function queueBuild(cycle) {
  await type(''); await evaluate(`window.queueAction('queue_set_pause',{paused:false},currentConversationTarget())`);
  await submit('SOAK_HOLD_' + cycle + ': keep the public reply streaming.', 'next');
  await until(() => evaluate(`(()=>{const run=runningConversationRecord(activeConversationId()),work=run&&workRunsForTarget(currentConversationTarget()).find(r=>r.runId===run.runId);return{run,publicText:(work?.events||[]).filter(e=>e.type==='text'||e.type==='response').map(e=>e.content).join('')};})()`), value => value.run && !value.run.provisional && value.publicText.includes('SOAK_HOLD_' + cycle + ' publicly visible partial reply.') && value.publicText.includes('Retain this text on interruption.'), 'Current held public Build identity');
  const runId = await evaluate('runningConversationRecord(activeConversationId()).runId');
  await submit('SOAK_NEXT_' + cycle + ': first queued message.', 'next'); await until(() => evaluate('(state.nextQueueRequests||[]).length'), n => n >= 1, 'First Next queue');
  await submit('SOAK_NEXT_' + (cycle + 10000) + ': second queued message.', 'next'); await until(() => evaluate('(state.nextQueueRequests||[]).length'), n => n >= 2, 'Second Next queue');
  await evaluate('window.toggleQueuePause()');
  const prior = await ipc('getState', seed.targets.A); const firstId = prior.queueItems?.[0]?.id;
  await evaluate('window.focusQueueItem(0);true'); await submit('SOAK_EDIT_' + cycle + ': edited first queue item.', 'next');
  const edited = await ipc('getState', seed.targets.A);
  check('Queue edit preserves item identity ' + cycle, !!firstId && edited.queueItems?.some(item => item.id === firstId && item.text.includes('SOAK_EDIT_' + cycle)), { firstId, items: edited.queueItems });
  await submit('SOAK_GUIDE_' + cycle + ': retain the previous output and follow this instruction.', 'guide');
  await measured('stop', () => evaluate('window.stopCurrentConversation()'));
  await until(() => evaluate('({running:!!runningConversationRecord(activeConversationId()),locks:Object.keys(state.activeSendCallsByTarget||{}).length})'), value => !value.running && !value.locks, 'Stopped held run');
  const stopped = await ipc('getState', seed.targets.A), run = stopped.workRuns?.find(r => r.runId === runId);
  check('Stop persists the public partial response ' + cycle, !!run && ['interrupted','force_interrupted'].includes(run.status) && run.events.some(e => e.type === 'response' && e.content.includes('Retain this text on interruption.')), { runId, status: run?.status });
  await evaluate(`window.queueAction('queue_set_pause',{paused:false},currentConversationTarget())`);
  await until(() => ipc('getState', seed.targets.A), value => !value.runtime?.running && !(value.queueItems||[]).length && JSON.stringify(value).includes('SOAK_EDIT_' + cycle + '_DONE') && JSON.stringify(value).includes('SOAK_NEXT_' + (cycle + 10000) + '_DONE'), 'Shared queue resumed and drained', 45000);
  check('Guide, Stop, edited Next queue and resume complete ' + cycle, true, { runId });
}
async function browsingCycle(cycle) {
  await select('A'); await type('SOAK_DRAFT_A_' + cycle + ' 用户草稿');
  await select('B'); await type('SOAK_DRAFT_B_' + cycle);
  await select('A');
  check('Draft target isolation ' + cycle, await evaluate('document.getElementById("prompt").value') === 'SOAK_DRAFT_A_' + cycle + ' 用户草稿');
  if(cycle%4===0){await select('C');await type('SOAK_DRAFT_C_'+cycle);await select('A');check('Third conversation draft isolation '+cycle,await evaluate('document.getElementById("prompt").value')==='SOAK_DRAFT_A_'+cycle+' 用户草稿');}
  const rect = await evaluate(`(()=>{const r=document.getElementById('chat-area').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await measured('scroll-to-paint', async () => { await renderer.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...rect, deltaY: -1600, deltaX: 0 }); await painted('scroll'); });
  for (const selector of ['#model-select-button', '#context-token-ring']) {
    await measured('popup-open-close', async () => { await click(selector); await sleep(110); await click(selector); await sleep(90); });
  }
  await measured('sidebar-toggle', async () => { await click('#left-collapse-btn'); await sleep(180); await click('#left-collapse-btn'); await evaluate('window.toggleRight();true'); await sleep(180); await evaluate('window.toggleRight();true'); });
  if (cycle % 6 === 0) await pageAll('A', cycle % 18 === 0);
  await renderer.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...rect, deltaY: 100000, deltaX: 0 });
}
async function main() {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 15 || durationSeconds > 43200) throw Error('Duration must be 15..43200 seconds');
  if (fs.existsSync(path.join(evidence, 'report.json'))) throw Error('Evidence directory already used');
  fs.mkdirSync(evidence, { recursive: true }); root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-user-soak-'));
  fs.copyFileSync(__filename, path.join(evidence, 'driver.cjs'));
  report = { startedAt: new Date().toISOString(), durationSecondsRequested: durationSeconds, evidence, root, exe, packaged, exeSha256: hash(exe), appAsarSha256: packaged ? hash(appRoot) : null, sourceUiSha256: hash(path.join(desktop, 'src/ui/index.html')), distUiSha256: hash(path.join(desktop, 'dist/ui/index.html')), harnessSha256: hash(__filename), boundary: 'Real Electron UI/preload/Agent and loopback HTTP. CDP trusted pointer/keyboard input plus existing UI entrypoints; fixtures seed persisted data only. Exact owned process tree memory/CPU/response observed through Windows. No production handlers or snapshots replaced.', checks: [], launches: [], requests: [], screenshots: [], rendererErrors: [], providerErrors: [], runtimeProblems: [], diagnostics: [], cycles: 0, sampleCount: 0 };
  if (packaged && expectedAsar) check('Packaged ASAR identity matches caller', report.appAsarSha256 === expectedAsar);
  save(); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const models = Array.from({ length: 32 }, (_, i) => ({ name: i ? 'soak-model-' + i : 'soak-loopback', max_tokens: 256000, enabled: true, capabilities: ['text_input','text_output','tool_use'] }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ models: { providers: [{ id: 'soak-loopback', name: 'Soak loopback', base_url: 'http://127.0.0.1:' + provider.address().port + '/v1', api_key: 'fixture-only', protocol: 'openai', enabled: true, models }], default_model: 'soak-loopback', auto_switch: false, fallback_on_unavailable: false, agent_engine: 'builtin', openai_api_mode: 'chat_stream' }, context: { auto_compress: false }, agent: { engine: 'builtin', default_mode: 'build' }, general: { language: 'zh', close_behavior: 'exit' }, workspace: { auto_create_timestamp_workspace: false }, remote: { touch_enabled: false } }));
  const seedFile = path.join(root, 'seed.cjs'), receiptFile = path.join(evidence, 'seed.json'); fs.writeFileSync(seedFile, seedSource);
  const seedFd = fs.openSync(path.join(evidence, 'seed.log'), 'wx');
  await new Promise((resolve, reject) => { const p = spawn(packaged ? exe : process.execPath, [seedFile, root, appRoot, receiptFile, String(historyCount)], { env: { ...process.env, ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, windowsHide: true, stdio: ['ignore', seedFd, seedFd] }); p.on('error', reject); p.on('close', code => { fs.closeSync(seedFd); code === 0 ? resolve() : reject(Error('Seed exit ' + code)); }); }); seed = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  try {
    await launch('activity'); heartbeatTimer = setInterval(() => { void sample(); }, 3000); await sample();
    report.initialDraft = { snapshot: (await ipc('getState', seed.targets.A)).draft, prompt: await evaluate('document.getElementById("prompt").value') };
    check('Initial persisted draft is visible before selecting a conversation', report.initialDraft.snapshot === 'SOAK_SEEDED_DRAFT_A' && report.initialDraft.prompt === 'SOAK_SEEDED_DRAFT_A', report.initialDraft);
    await select('A'); await pageAll('A'); await screenshot('01-full-history');
    report.activityStartedAt = new Date().toISOString(); report.activityStartedMs = Date.now(); save();
    while (Date.now() - report.activityStartedMs < durationSeconds * 1000) {
      const cycle = ++report.cycles; await browsingCycle(cycle);
      if (cycle % 5 === 1) await regularBuild(cycle);
      if (cycle % 10 === 2) await queueBuild(cycle);
      await ipc('getState', seed.targets.A); if (cycle % 10 === 0) { await screenshot('cycle-' + cycle); console.log(JSON.stringify({ cycle, elapsedSeconds: (Date.now() - report.activityStartedMs)/1000, lastSample: report.lastSample?.heap, metrics: report.metrics })); }
      await sleep(650); save();
    }
    report.activityElapsedSeconds = (Date.now() - report.activityStartedMs) / 1000; report.activityFinishedAt = new Date().toISOString();
    await type('SOAK_FINAL_DRAFT');
    await until(() => ipc('getState', seed.targets.A), snapshot => snapshot.draft === 'SOAK_FINAL_DRAFT', 'Draft is persisted without switching');
    check('Typing draft persists without a conversation switch', true); await screenshot('02-activity-complete');
    const before = await ipc('getState', seed.targets.A); report.preCold = { messageCount: before.totalMessages, runIds: before.workRuns?.map(r => r.runId), usage: before.contextWindow, draft: before.draft };
    report.preCold.drafts = {};
    for (const [name,target] of Object.entries(seed.targets)) report.preCold.drafts[name] = (await ipc('getState', target)).draft;
    const diskState = path.join(root, 'Work', 'User soak fixture', 'conversations', 'state.json');
    fs.copyFileSync(diskState, path.join(evidence, 'state-before-close.json'));
    clearInterval(heartbeatTimer); while (sampleBusy) await sleep(50); await close();
    await launch('cold');
    report.coldArrival = { snapshot: (await ipc('getState', seed.targets.A)).draft, prompt: await evaluate('document.getElementById("prompt").value') };
    check('Cold startup draft is already restored before selecting current conversation', report.coldArrival.snapshot === 'SOAK_FINAL_DRAFT' && report.coldArrival.prompt === 'SOAK_FINAL_DRAFT', report.coldArrival);
    await select('A'); await pageAll('A'); const cold = await ipc('getState', seed.targets.A);
    check('Cold restart keeps all recorded Build identities', JSON.stringify(cold.workRuns?.map(r=>r.runId)) === JSON.stringify(report.preCold.runIds));
    check('Cold restart retains the active conversation draft', await evaluate('document.getElementById("prompt").value') === 'SOAK_FINAL_DRAFT');
    check('Cold context usage counters equal pre-exit values', cold.contextWindow?.providerInputTokens === report.preCold.usage?.providerInputTokens && cold.contextWindow?.providerCacheReadTokens === report.preCold.usage?.providerCacheReadTokens);
    for (const name of ['B','C','A']) { await select(name); const prompt=await evaluate('document.getElementById("prompt").value'); check('Cold draft remains target-bound for '+name, prompt === report.preCold.drafts[name], {prompt,expected:report.preCold.drafts[name]}); }
    await screenshot('03-cold-history'); check('No renderer errors or runtime unresponsive events', !report.rendererErrors.length && !report.runtimeProblems.length, { rendererErrors: report.rendererErrors, runtimeProblems: report.runtimeProblems });
    check('Requested real activity duration elapsed', report.activityElapsedSeconds >= durationSeconds, report.activityElapsedSeconds); report.passed = true;
  } catch (error) { report.passed = false; report.error = String(error.stack || error); process.exitCode = 1; save(); await diagnose('test failure: ' + error); }
  finally {
    clearInterval(heartbeatTimer); for (const response of held) response.destroy();
    while (sampleBusy) await sleep(50);
    try { await close(); } catch (error) { report.cleanupError = String(error); if (child) { report.forcedCleanup = { pid: child.pid, root }; child.kill(); await sleep(300); } }
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => provider.close(resolve)); report.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ passed: report.passed, cycles: report.cycles, activityElapsedSeconds: report.activityElapsedSeconds, evidence, error: report.error, metrics: report.metrics }));
  }
}
main().catch(async error => { console.error(error.stack || error); process.exitCode = 1; if(report){report.passed=false;report.setupError=String(error.stack||error);save();}for(const socket of sockets)socket.destroy();if(provider.listening)await new Promise(resolve=>provider.close(resolve)); });
