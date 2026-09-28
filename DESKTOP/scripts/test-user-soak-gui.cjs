'use strict';
// Sustained real Electron GUI/IPC usage against an owned, local HTTP provider.
// --duration-seconds 1800 is an actual 30-minute activity period; setup and cold
// restart are measured separately. No user root or installed process is touched.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const desktop = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('Usage: node scripts/test-user-soak-gui.cjs [--calibration] [--parallel-only|--cu-sparse-only|--history-profile-only] [--real-provider DeepSeek|APInebula] [--profile-history-pages] [--frame-monitor] [--duration-seconds 1800] [--history-count 1200] [--viewport-width 1366 --viewport-height 900] [--target-refresh-hz 60] [--exe PATH] [--asar-sha256 SHA256] [--evidence NEW_DIRECTORY]\nSeeds an isolated root and uses one real Electron at a time. --real-provider runs the sparse CU GUI scenario against that provider from the existing user config through an in-memory credential-injecting evidence proxy; keys are never written to the test root or report. Other scenarios use the local fixture. --frame-monitor captures renderer RAF intervals, long tasks, and GPU engines belonging to the owned Electron process tree.');
  process.exit(0);
}
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const durationSeconds = Number(option('--duration-seconds', argv.includes('--calibration') ? '120' : '1800'));
const exe = path.resolve(option('--exe', path.join(desktop, 'node_modules/electron/dist/electron.exe')));
const packaged = fs.existsSync(path.join(path.dirname(exe), 'resources/app.asar'));
const appRoot = packaged ? path.join(path.dirname(exe), 'resources/app.asar') : desktop;
const evidence = path.resolve(option('--evidence', path.join(desktop, '../archive', new Date().toISOString().replace(/[:.]/g, '-') + '-gui-soak')));
const expectedAsar = option('--asar-sha256', '').toUpperCase();
const parallelOnly = argv.includes('--parallel-only');
const cuSparseOnly = argv.includes('--cu-sparse-only');
const realProviderName = String(option('--real-provider', '')).trim();
const historyProfileOnly = argv.includes('--history-profile-only');
const fixtureModelId = cuSparseOnly ? 'gpt-5.1-soak-loopback' : 'soak-loopback';
const profileHistoryPages = argv.includes('--profile-history-pages');
const frameMonitor = argv.includes('--frame-monitor');
const viewportWidth = Math.max(800, Number(option('--viewport-width', '1366')));
const viewportHeight = Math.max(600, Number(option('--viewport-height', '900')));
const targetRefreshHz = Math.max(30, Number(option('--target-refresh-hz', '60')));
const historyMinimum = parallelOnly || cuSparseOnly ? 80 : 1200;
const historyCount = Math.max(historyMinimum, Number(option('--history-count', String(historyMinimum))));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((values.length - 1) * p))] : null;
const distribution = values => ({ count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), max: values.length ? Math.max(...values) : null });
function unwrapConfigValue(value) {
  let current = value;
  for (let i = 0; i < 5 && current && typeof current === 'object' && !Array.isArray(current)
    && Object.prototype.hasOwnProperty.call(current, 'value'); i += 1) current = current.value;
  return current;
}
function loadRealProvider(name) {
  if (!name) return null;
  const configPath = path.join(os.homedir(), '.Newmark', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const models = unwrapConfigValue(config.models) || {};
  const providers = unwrapConfigValue(models.providers) || [];
  const wanted = name.toLowerCase();
  const provider = providers.map(raw => {
    const result = {};
    for (const [key, value] of Object.entries(raw || {})) result[key] = unwrapConfigValue(value);
    return result;
  }).find(candidate => `${candidate.name || ''} ${candidate.id || ''}`.toLowerCase().includes(wanted));
  if (!provider) throw new Error(`No configured provider matched --real-provider ${name}`);
  const protocol = String(provider.protocol || 'openai').toLowerCase();
  const baseUrl = String(provider.base_url || provider.baseUrl || '').trim();
  const apiKey = String(provider.api_key || provider.apiKey || '').trim();
  if (!/^https:\/\//i.test(baseUrl) || !apiKey || !['openai', 'openai_compatible', 'chat_completions'].includes(protocol)) {
    throw new Error(`Configured provider ${provider.name || provider.id} is missing HTTPS, an API key, or an OpenAI-compatible protocol`);
  }
  const modelRows = unwrapConfigValue(provider.models) || [];
  const model = modelRows.map(raw => {
    const result = {};
    for (const [key, value] of Object.entries(raw || {})) result[key] = unwrapConfigValue(value);
    return result;
  }).find(candidate => /deepseek/i.test(String(provider.name || provider.id))
    ? String(candidate.name || candidate.id) === 'deepseek-flash'
    : /APInebula/i.test(String(provider.name || provider.id))
      ? String(candidate.name || candidate.id) === 'gpt-5.6-sol'
      : false);
  if (!model) throw new Error(`No tested CU vision model is configured for ${provider.name || provider.id}`);
  return {
    id: String(provider.id || provider.name),
    name: String(provider.name || provider.id),
    protocol,
    baseUrl,
    apiKey,
    model: String(model.name || model.id),
    configuredVision: model.vision === true || model.capabilities?.includes?.('vision') === true,
    imageLabel: 'CU_REMOTE_IMAGE_PROBE_926',
    completionMarker: `REAL_CU_${String(provider.name || provider.id).replace(/[^A-Z0-9]+/gi, '_').toUpperCase()}_SPARSE_OK_926`,
  };
}
const realProvider = loadRealProvider(realProviderName);
function frameDistribution(intervals, sampleWindowMs, refreshHz = targetRefreshHz) {
  const values = intervals.filter(value => Number.isFinite(value) && value > 0);
  const budgetMs = 1000 / refreshHz;
  const overOneBudget = values.filter(value => value > budgetMs).length;
  const overOneAndHalfBudgets = values.filter(value => value > budgetMs * 1.5).length;
  const overTwoBudgets = values.filter(value => value > budgetMs * 2).length;
  return {
    sampledFrames: values.length,
    sampleWindowMs: Number(sampleWindowMs.toFixed(2)),
    targetRefreshHz: refreshHz,
    targetFrameBudgetMs: Number(budgetMs.toFixed(3)),
    rendererCadenceFps: sampleWindowMs > 0 ? Number((values.length * 1000 / sampleWindowMs).toFixed(2)) : null,
    meanFrameIntervalMs: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)) : null,
    p50FrameIntervalMs: percentile(values, .5) === null ? null : Number(percentile(values, .5).toFixed(3)),
    p90FrameIntervalMs: percentile(values, .9) === null ? null : Number(percentile(values, .9).toFixed(3)),
    p95FrameIntervalMs: percentile(values, .95) === null ? null : Number(percentile(values, .95).toFixed(3)),
    p99FrameIntervalMs: percentile(values, .99) === null ? null : Number(percentile(values, .99).toFixed(3)),
    maxFrameIntervalMs: values.length ? Number(Math.max(...values).toFixed(3)) : null,
    rafIntervalsOverOneBudgetCount: overOneBudget,
    rafIntervalsOverOneBudgetPercent: values.length ? Number((overOneBudget * 100 / values.length).toFixed(2)) : null,
    rafIntervalsOverOneAndHalfBudgetsCount: overOneAndHalfBudgets,
    rafIntervalsOverOneAndHalfBudgetsPercent: values.length ? Number((overOneAndHalfBudgets * 100 / values.length).toFixed(2)) : null,
    rafIntervalsOverTwoBudgetsCount: overTwoBudgets,
    rafIntervalsOverTwoBudgetsPercent: values.length ? Number((overTwoBudgets * 100 / values.length).toFixed(2)) : null,
    rafStallIntervals50msCount: values.filter(value => value >= 50).length,
  };
}
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
let root, report, child, renderer, mainCdp, logFd, seed, heartbeatTimer, displayAwakeProcess, displayAwakeLockPath, displayAwakeReadyPath, displayAwakeLogFd, sampleBusy = false, diagnosticsBusy = false, frameCaptureActive = false;
const latency = {}, sockets = new Set(), held = new Set(), heldByMarker = new Map();
const motionIntervals = Object.create(null), motionWindows = Object.create(null);
let cuSparseObservationCount = 0;
let cuSparseVisualPulseScheduled = false;
let historyPageActionIndex = 0;
const save = () => { if (!report) return; report.metrics = Object.fromEntries(Object.entries(latency).map(([name, values]) => [name, distribution(values)])); fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2)); };
const append = (file, value) => fs.appendFileSync(path.join(evidence, file), JSON.stringify(value) + '\n');
function check(name, pass, detail) { report.checks.push({ name, pass: !!pass, detail, at: new Date().toISOString() }); save(); if (!pass) throw Error(name); }
async function measured(name, operation) {
  const profileIndex = name === 'history-page' ? historyPageActionIndex++ : -1;
  const captureProfile = profileHistoryPages && [0, 4, 9, 13].includes(profileIndex);
  let profileStarted = false, profileError = '';
  if (captureProfile) {
    try {
      await renderer.call('Profiler.enable');
      await renderer.call('Profiler.setSamplingInterval', { interval: 1000 });
      await renderer.call('Profiler.start');
      profileStarted = true;
    } catch (error) { profileError = String(error && error.message || error); }
  }
  const start = performance.now();
  try { return await operation(); }
  finally {
    const elapsedMs = performance.now() - start;
    if (profileStarted) {
      try {
        const result = await renderer.call('Profiler.stop', {}, 30000);
        const filename = `history-page-${String(profileIndex + 1).padStart(2, '0')}.cpuprofile`;
        fs.writeFileSync(path.join(evidence, filename), JSON.stringify(result.profile));
        (report.cpuProfiles ||= []).push({ action: name, pageIndex: profileIndex + 1, elapsedMs, filename, samples: (result.profile.samples || []).length, nodes: (result.profile.nodes || []).length });
      } catch (error) { profileError = String(error && error.message || error); }
      await renderer.call('Profiler.disable').catch(() => {});
    } else if (captureProfile) {
      (report.cpuProfiles ||= []).push({ action: name, pageIndex: profileIndex + 1, elapsedMs, error: profileError });
    }
    (latency[name] ||= []).push(elapsedMs);
    append('actions.jsonl', { name, elapsedMs, ...(captureProfile ? { cpuProfile: profileStarted, profileError: profileError || undefined, profileIndex: profileIndex + 1 } : {}), at: new Date().toISOString() });
  }
}
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
async function gpuMetrics() {
  const ownPid = child?.pid; if (!Number.isInteger(ownPid)) return { queryAvailable: false, queryError: 'Electron process is not running', engineInstances: [] };
  const command = "$rootPid=" + ownPid + ";$all=Get-CimInstance Win32_Process;$ids=[System.Collections.Generic.HashSet[int]]::new();[void]$ids.Add($rootPid);do{$n=$ids.Count;foreach($x in $all){if($ids.Contains([int]$x.ParentProcessId)){[void]$ids.Add([int]$x.ProcessId)}}}while($ids.Count -gt $n);$gpuRows=@();$queryError=$null;try{$c=Get-Counter -Counter '\\GPU Engine(*)\\Utilization Percentage' -MaxSamples 1 -ErrorAction Stop;foreach($s in $c.CounterSamples){if($s.InstanceName -match '^pid_(\\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\\d+)_eng_(\\d+)_engtype_(.+)$'){$gpuPid=[int]$Matches[1];if($ids.Contains($gpuPid)){$gpuRows += [PSCustomObject]@{pid=$gpuPid;adapter=$Matches[2];physicalIndex=[int]$Matches[3];engineIndex=[int]$Matches[4];engineType=$Matches[5].ToLowerInvariant();utilizationPercent=[double]$s.CookedValue}}}}}catch{$queryError=$_.Exception.Message};[PSCustomObject]@{queryAvailable=($null -eq $queryError);queryError=$queryError;engineInstances=$gpuRows}|ConvertTo-Json -Depth 5 -Compress";
  return new Promise((resolve) => execFile('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',command], { windowsHide: true, timeout: 30000, maxBuffer: 2*1024*1024 }, (error, stdout) => {
    if (error) { resolve({ queryAvailable: false, queryError: String(error), engineInstances: [] }); return; }
    try {
      const value=JSON.parse(stdout||'{}');
      const rows=Array.isArray(value.engineInstances)?value.engineInstances:value.engineInstances?[value.engineInstances]:[];
      const sum=pattern=>Number(rows.filter(row=>pattern.test(String(row.engineType||''))).reduce((total,row)=>total+Number(row.utilizationPercent||0),0).toFixed(2));
      resolve({
        queryAvailable: value.queryAvailable === true,
        queryError: value.queryError || null,
        sampledEngineInstances: rows.length,
        threeDPercentSum: sum(/^3d$/),
        threeDPercentMax: Number(Math.max(0,...rows.filter(row=>/^3d$/.test(String(row.engineType||''))).map(row=>Number(row.utilizationPercent||0))).toFixed(2)),
        copyPercentSum: sum(/^copy$/),
        computePercentSum: sum(/^compute/),
        videoPercentSum: sum(/^video/),
        adapters: [...new Set(rows.map(row=>row.adapter).filter(Boolean))],
        engineInstances: rows,
      });
    } catch (parseError) { resolve({ queryAvailable: false, queryError: String(parseError), engineInstances: [] }); }
  }));
}
async function maximizeOwnedWindow() {
  const ownPid = child?.pid;
  if (!Number.isInteger(ownPid)) throw Error('Electron process is not running');
  const command = "$ErrorActionPreference='Stop';Add-Type -Namespace NewmarkFrame -Name WindowApi -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(System.IntPtr hWnd,int nCmdShow); [System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr hWnd); [System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool IsZoomed(System.IntPtr hWnd);';$rootPid=" + ownPid + ";$all=Get-CimInstance Win32_Process;$ids=[System.Collections.Generic.HashSet[int]]::new();[void]$ids.Add($rootPid);do{$n=$ids.Count;foreach($x in $all){if($ids.Contains([int]$x.ParentProcessId)){[void]$ids.Add([int]$x.ProcessId)}}}while($ids.Count -gt $n);$target=$ids|ForEach-Object{Get-Process -Id $_ -ErrorAction SilentlyContinue}|Where-Object{$_.MainWindowHandle -ne [IntPtr]::Zero}|Select-Object -First 1;if($null -eq $target){throw 'Owned Electron has no native window handle'};[void][NewmarkFrame.WindowApi]::ShowWindowAsync($target.MainWindowHandle,3);[void][NewmarkFrame.WindowApi]::SetForegroundWindow($target.MainWindowHandle);Start-Sleep -Milliseconds 350;$target.Refresh();$maximized=[NewmarkFrame.WindowApi]::IsZoomed($target.MainWindowHandle);[PSCustomObject]@{pid=$target.Id;title=$target.MainWindowTitle;nativeWindowHandle=$target.MainWindowHandle.ToInt64();maximized=$maximized}|ConvertTo-Json -Compress";
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',command], { windowsHide: true, timeout: 15000, maxBuffer: 256*1024 }, (error, stdout) => {
    if (error) { reject(Error(String(error) + (stdout ? ': ' + stdout : ''))); return; }
    try { const result=JSON.parse(stdout); if (result.maximized !== true) reject(Error('Owned Electron native window did not enter maximized state: ' + stdout)); else resolve(result); }
    catch (parseError) { reject(parseError); }
  }));
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
    if (report.sampleCount % 5 === 0) {
      report.lastProcessMetrics = await processMetrics();
      if (frameCaptureActive) report.processSamples.push({ at: new Date().toISOString(), sinceActivityStartMs: Date.now() - report.activityStartedMs, processes: report.lastProcessMetrics });
    }
    if (frameCaptureActive && value.longTasks.length) {
      for (const task of value.longTasks) report.longTaskEvents.push({ sinceActivityStartMs: Date.now() - report.activityStartedMs, durationMs: task.duration, rendererStartMs: task.start });
    }
    if (frameCaptureActive && report.sampleCount % 3 === 0) {
      const at = new Date().toISOString();
      const sinceActivityStartMs = report.activityStartedMs ? Date.now() - report.activityStartedMs : null;
      const gpu = await gpuMetrics();
      report.gpuSamples.push({ at, sinceActivityStartMs, ...gpu });
    }
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
function providerToolNames(body) { return (Array.isArray(body?.tools) ? body.tools : []).map(item => String(item?.function?.name || item?.name || '')).filter(Boolean); }
function providerTextContent(messages) {
  const parts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = message?.content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) for (const item of content) if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n');
}
function containsImageInput(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsImageInput);
  const type = String(value.type || '').toLowerCase();
  const imageUrl = value.image_url?.url || value.image_url;
  if ((type.includes('image') || imageUrl) && (typeof imageUrl === 'string' ? imageUrl.startsWith('data:image/') : typeof imageUrl?.url === 'string' && imageUrl.url.startsWith('data:image/'))) return true;
  return Object.values(value).some(containsImageInput);
}
function firstImageDataUrl(value) {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) { for (const item of value) { const found = firstImageDataUrl(item); if (found) return found; } return ''; }
  const imageUrl = value.image_url?.url || value.image_url || value.url;
  if (typeof imageUrl === 'string' && /^data:image\/(?:png|jpe?g|webp);base64,/i.test(imageUrl)) return imageUrl;
  for (const item of Object.values(value)) { const found = firstImageDataUrl(item); if (found) return found; }
  return '';
}
function sparseMeasurementIn(messages) {
  const visit = value => {
    if (!value || typeof value !== 'object') return null;
    let latest = null;
    if (Array.isArray(value)) { for (const item of value) latest = visit(item) || latest; return latest; }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'sparse_measurement' && item && typeof item === 'object') latest = item;
      else latest = visit(item) || latest;
    }
    return latest;
  };
  let latest = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = message?.content;
    if (content && typeof content === 'object') latest = visit(content) || latest;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(item => item?.type === 'text').map(item => String(item.text || '')) : [];
    for (const text of texts) {
      try { latest = visit(JSON.parse(text)) || latest; } catch {}
      const match = text.match(/\"sparse_measurement\"\s*:\s*(\{[^{}]*\})/);
      if (match) { try { latest = JSON.parse(match[1]); } catch {} }
    }
  }
  return latest;
}
async function scheduleRealVisualPulse() {
  if (!realProvider || report.computerUseVisualPulse?.scheduled) return;
  const pulse = await evaluate(`(()=>{if(window.__soakSparseVisualPulseState)return window.__soakSparseVisualPulseState;const state=window.__soakSparseVisualPulseState={scheduled:true,visible:false,everVisible:false,changes:0,intervalMs:350,durationMs:60000,label:${JSON.stringify(realProvider.imageLabel)}};setTimeout(()=>{const marker=document.createElement('div');marker.id='soak-sparse-cu-visual-pulse';marker.setAttribute('aria-hidden','true');marker.style.cssText='position:fixed;top:16px;left:16px;width:560px;height:150px;box-sizing:border-box;z-index:2147483647;display:flex;align-items:center;justify-content:center;border:8px solid #ffffff;border-radius:16px;pointer-events:none;box-shadow:0 0 0 4px #000000';const label=document.createElement('span');label.textContent=state.label;label.style.cssText='display:block;padding:12px 16px;border:4px solid #000000;border-radius:10px;background:#ffea00;color:#000000;font:900 22px/1.15 Arial,sans-serif;letter-spacing:1px;white-space:nowrap;text-shadow:none';marker.appendChild(label);document.body.appendChild(marker);const rect=marker.getBoundingClientRect();state.visible=rect.right>0&&rect.bottom>0&&rect.left<innerWidth&&rect.top<innerHeight;state.everVisible=state.visible;state.labelText=label.innerText;state.bounds={x:rect.x,y:rect.y,width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight};let phase=0;const paint=()=>{marker.style.backgroundColor=phase++%2?'#000000':'#ffffff';state.changes++;};paint();const pulseTimer=setInterval(paint,state.intervalMs);setTimeout(()=>{clearInterval(pulseTimer);marker.remove();state.visible=false;state.finished=true;},state.durationMs);},250);return state;})()`);
  const visiblePulse = await until(
    () => evaluate('window.__soakSparseVisualPulseState || null'),
    value => value?.everVisible === true && value.labelText === realProvider.imageLabel,
    'synthetic CU label visible inside the isolated Electron viewport',
    5000,
  );
  report.computerUseVisualPulse = { scheduled: pulse?.scheduled === true, visibleBeforeProviderCall: true, delayMs: 250, intervalMs: 350, durationMs: 60000, label: realProvider.imageLabel, bounds: visiblePulse.bounds, purpose: 'synthetic visible label and high-contrast pulse for real-provider CU screenshot validation' };
  save();
}
function captureProviderResponseEvent(record, event, toolCalls) {
  const choices = Array.isArray(event?.choices) ? event.choices : [];
  for (const choice of choices) {
    if (choice?.finish_reason) record.finishReason = String(choice.finish_reason).slice(0, 80);
    const deltas = choice?.delta?.tool_calls || choice?.message?.tool_calls || [];
    for (const delta of deltas) {
      const index = Number.isFinite(Number(delta?.index)) ? Number(delta.index) : toolCalls.length;
      const call = toolCalls[index] || { name: '' };
      call.name += String(delta?.function?.name || '');
      toolCalls[index] = call;
    }
  }
  const usage = event?.usage || event?.response?.usage;
  if (usage) record.responseUsage = {
    promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
    completionTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
  };
  if (event?.model) record.responseModel = String(event.model).slice(0, 160);
}
function forwardToRealProvider(incoming, outgoing, rawBody, record) {
  return new Promise(resolve => {
    const upstream = new URL(realProvider.baseUrl);
    const incomingUrl = new URL(incoming.url || '/', 'http://127.0.0.1');
    const localSuffix = incomingUrl.pathname.replace(/^\/v1(?=\/|$)/, '') || '/';
    const upstreamPrefix = upstream.pathname.replace(/\/+$/, '');
    const headers = { ...incoming.headers };
    for (const key of ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding']) delete headers[key];
    headers.authorization = `Bearer ${realProvider.apiKey}`;
    headers['accept-encoding'] = 'identity';
    headers['content-length'] = String(rawBody.length);
    const toolCalls = [];
    const remote = https.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || 443,
      method: incoming.method || 'POST',
      path: `${upstreamPrefix}${localSuffix}${incomingUrl.search}` || '/',
      headers,
    }, response => {
      record.statusCode = Number(response.statusCode || 0);
      record.contentType = String(response.headers['content-type'] || '').split(';')[0];
      const responseHeaders = { ...response.headers };
      for (const key of ['connection', 'transfer-encoding', 'content-length']) delete responseHeaders[key];
      if (!outgoing.destroyed) outgoing.writeHead(record.statusCode || 502, responseHeaders);
      let pending = '';
      const chunks = [];
      response.on('data', chunk => {
        chunks.push(Buffer.from(chunk));
        if (record.contentType === 'text/event-stream') {
          pending += Buffer.from(chunk).toString('utf8');
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try { captureProviderResponseEvent(record, JSON.parse(data), toolCalls); } catch {}
          }
        }
        if (!outgoing.destroyed) outgoing.write(chunk);
      });
      response.on('end', () => {
        if (pending.startsWith('data:')) {
          const data = pending.slice(5).trim();
          if (data && data !== '[DONE]') { try { captureProviderResponseEvent(record, JSON.parse(data), toolCalls); } catch {} }
        }
        if (record.contentType !== 'text/event-stream') {
          try { captureProviderResponseEvent(record, JSON.parse(Buffer.concat(chunks).toString('utf8')), toolCalls); } catch {}
        }
        record.responseToolNames = [...new Set(toolCalls.map(call => call.name).filter(Boolean))];
        record.finishedAt = new Date().toISOString();
        if (!outgoing.destroyed) outgoing.end();
        save();
        resolve();
      });
      response.on('error', error => {
        record.errorClass = error?.name || 'UpstreamResponseError';
        if (!outgoing.destroyed) outgoing.destroy();
        save();
        resolve();
      });
    });
    remote.on('error', error => {
      record.errorClass = error?.name || 'UpstreamRequestError';
      if (!outgoing.headersSent && !outgoing.destroyed) outgoing.writeHead(502, { 'content-type': 'text/plain' });
      if (!outgoing.destroyed) outgoing.end('real provider request failed');
      report.providerErrors.push(`Real provider request failed (${record.errorClass})`);
      save();
      resolve();
    });
    outgoing.on('close', () => { if (!outgoing.writableFinished && !remote.destroyed) remote.destroy(); });
    remote.setTimeout(180000, () => remote.destroy(new Error('timeout')));
    remote.end(rawBody);
  });
}
const provider = http.createServer(async (request, response) => {
  try {
    let raw = ''; for await (const data of request) raw += data;
    const body = JSON.parse(raw || '{}'), messages = body.messages || [], latest = messages.findLastIndex(m => m.role === 'user');
    const latestContent = messages[latest]?.content;
    const input = typeof latestContent === 'string' ? latestContent : Array.isArray(latestContent) ? latestContent.filter(item => item?.type === 'text').map(item => String(item.text || '')).join('\n') : '';
    const markers = [...providerTextContent(messages).matchAll(/SOAK_(?:BUILD|HOLD|NEXT|EDIT|GUIDE|CU_SPARSE)_\d+/g)].map(match => match[0]);
    const marker = markers.at(-1) || input.match(/SOAK_(?:BUILD|HOLD|NEXT|EDIT|GUIDE|CU_SPARSE)_\d+/)?.[0] || 'SOAK_REPLY';
    const title = messages.some(m => m.role === 'system' && String(m.content).includes('conversation title generator'));
    const toolNames = providerToolNames(body), sparseMeasurement = sparseMeasurementIn(messages);
    const isCuSparseRequest = /SOAK_CU_SPARSE_/.test(marker);
    const entry = { at: new Date().toISOString(), marker, title, stream: body.stream, messageCount: messages.length, requestBytes: Buffer.byteLength(raw), ...(isCuSparseRequest || realProvider ? { model: String(body.model || ''), toolNames, toolResultCount: messages.filter(m => m.role === 'tool' || m.role === 'function').length, sparseMeasurement: sparseMeasurement ? { method: sparseMeasurement.method, reason: sparseMeasurement.reason, elapsed_ms: sparseMeasurement.elapsed_ms, wall_elapsed_ms: sparseMeasurement.wall_elapsed_ms, sample_count: sparseMeasurement.sample_count, changed_cells: sparseMeasurement.changed_cells, fresh_full_observation_follows: sparseMeasurement.fresh_full_observation_follows } : null, visionImageAttached: containsImageInput(messages) } : {}) }; report.requests.push(entry); append('requests.jsonl', entry); save();
    if (isCuSparseRequest && !report.computerUseSparseImage) {
      const imageDataUrl = firstImageDataUrl(messages);
      if (imageDataUrl) {
        const match = imageDataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i);
        if (match) {
          const extension = match[1].toLowerCase().replace('image/', '').replace('jpeg', 'jpg');
          const filename = `computer-use-full-observation.${extension}`;
          const bytes = Buffer.from(match[2], 'base64');
          fs.writeFileSync(path.join(evidence, filename), bytes);
          report.computerUseSparseImage = { file: path.join(evidence, filename), mimeType: match[1], bytes: bytes.length, at: new Date().toISOString() };
          save();
        }
      }
    }
    if (realProvider) {
      if (isCuSparseRequest && !title && body.stream === true) await scheduleRealVisualPulse();
      await forwardToRealProvider(request, response, Buffer.from(raw, 'utf8'), entry);
      return;
    }
    if (body.response_format?.json_schema?.name === 'newmark_jev_route_decision') {
      let routeRequest = null;
      try { routeRequest = JSON.parse(input); } catch {}
      const candidates = Array.isArray(routeRequest?.candidates) ? routeRequest.candidates : [];
      const primary = candidates.find(item => item?.deployment?.modelId === fixtureModelId) || candidates[0];
      if (!primary?.deployment?.providerId || !primary?.deployment?.modelId) throw Error('JEV fixture request contained no eligible candidate');
      const alternates = candidates.filter(item => item !== primary).slice(0, 2).map(item => ({
        providerId: item.deployment.providerId,
        modelId: item.deployment.modelId,
        logicalModelGroupId: item.deployment.logicalModelGroupId || '',
      }));
      const content = JSON.stringify({
        primary: { providerId: primary.deployment.providerId, modelId: primary.deployment.modelId, logicalModelGroupId: primary.deployment.logicalModelGroupId || '' },
        alternates,
        reasonCodes: ['loopback_current_model_fixture'],
        confidence: null,
        modelVersion: 'current-model-jev-1.0',
      });
      report.jevDecisionRequests ||= [];
      report.jevDecisionRequests.push({ model: body.model, reasoningEffort: body.reasoning_effort || null, schemaName: body.response_format.json_schema.name, schemaStrict: body.response_format.json_schema.strict === true, candidateCount: candidates.length, selected: primary.deployment, modelVersion: 'current-model-jev-1.0' });
      save();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }));
      return;
    }
    if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: title ? 'Soak conversation' : marker + '_DONE' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } })); return; }
    response.setHeader('content-type', 'text/event-stream'); response.flushHeaders();
    if (/SOAK_(?:HOLD|GUIDE)_/.test(marker)) { emit(response, { content: marker + ' publicly visible partial reply. This is a deliberately held local request so that ordinary user Guide, Next queue management and Stop can be exercised while the actual Build is running. Retain this text on interruption.' }); held.add(response); if (marker === 'SOAK_HOLD_91001' || marker === 'SOAK_HOLD_91002') heldByMarker.set(marker, response); response.on('close', () => { held.delete(response); if (heldByMarker.get(marker) === response) heldByMarker.delete(marker); }); return; }
    if (/SOAK_CU_SPARSE_/.test(marker)) {
      if (title) { finish(response, 'Soak Computer Use title'); return; }
      if (sparseMeasurement) {
        cuSparseObservationCount++;
        if (cuSparseObservationCount === 1 && toolNames.includes('computer_use')) {
          emit(response, { tool_calls: [{ index: 0, id: 'cu-observe-warm-' + marker, type: 'function', function: { name: 'computer_use', arguments: JSON.stringify({ action: 'observe', max_chars: 6000, sparse_wait_ms: 900 }) } }] });
          emit(response, {}, 'tool_calls'); response.end('data: [DONE]\n\n'); return;
        }
        finish(response, marker + '_DONE'); return;
      }
      if (messages.some(m => (m.role === 'tool' || m.role === 'function') && String(m.name || '') === 'computer_use')) { finish(response, marker + '_DONE'); return; }
      if (toolNames.includes('computer_use')) {
        if (isCuSparseRequest && !cuSparseVisualPulseScheduled) {
          cuSparseVisualPulseScheduled = true;
          const pulse = await evaluate(`(()=>{if(window.__soakSparseVisualPulseState)return window.__soakSparseVisualPulseState;const state=window.__soakSparseVisualPulseState={scheduled:true,visible:false,changes:0,intervalMs:170,durationMs:12000};setTimeout(()=>{const marker=document.createElement('div');marker.id='soak-sparse-cu-visual-pulse';marker.textContent='CU sparse frame probe';marker.setAttribute('aria-hidden','true');marker.style.cssText='position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:520px;height:400px;z-index:2147483647;display:grid;place-items:center;border:8px solid white;border-radius:16px;color:#ff00ff;font:700 24px sans-serif;text-shadow:0 1px 3px white;pointer-events:none;box-shadow:0 0 0 3px black';document.body.appendChild(marker);state.visible=true;let phase=0;const paint=()=>{marker.style.backgroundColor=phase++%2?'#000000':'#ffffff';state.changes++;};paint();const pulseTimer=setInterval(paint,state.intervalMs);setTimeout(()=>{clearInterval(pulseTimer);marker.remove();state.visible=false;state.finished=true;},state.durationMs);},500);return state;})()`);
          report.computerUseVisualPulse = { scheduled: pulse?.scheduled === true, delayMs: 500, intervalMs: 170, durationMs: 12000, purpose: 'visible high-contrast test-only color pulse during the real packaged Computer Use sparse observation' };
          save();
        }
        emit(response, { tool_calls: [{ index: 0, id: 'cu-observe-' + marker, type: 'function', function: { name: 'computer_use', arguments: JSON.stringify({ action: 'observe', max_chars: 6000, sparse_wait_ms: 5000 }) } }] });
        emit(response, {}, 'tool_calls'); response.end('data: [DONE]\n\n'); return;
      }
      if (toolNames.includes('tool_provision')) {
        emit(response, { tool_calls: [{ index: 0, id: 'cu-provision-' + marker, type: 'function', function: { name: 'tool_provision', arguments: JSON.stringify({ names: ['computer_use'] }) } }] });
        emit(response, {}, 'tool_calls'); response.end('data: [DONE]\n\n'); return;
      }
      report.providerErrors.push('Computer Use Build request did not expose tool_provision or computer_use.');
      finish(response, marker + '_TOOL_NOT_ADVERTISED'); return;
    }
    if (/SOAK_BUILD_/.test(marker) && !messages.slice(latest + 1).some(m => m.role === 'tool')) { emit(response, { content: marker + ' checking current directory. ' }); emit(response, { tool_calls: [{ index: 0, id: 'pwd-' + marker, type: 'function', function: { name: 'pwd', arguments: '{}' } }] }); emit(response, {}, 'tool_calls'); response.end('data: [DONE]\n\n'); return; }
    for (const text of [marker + ' response ', 'is streaming through the normal provider, ', 'kernel and IPC boundary. ']) { if (response.destroyed) return; emit(response, { content: text }); await sleep(35); }
    finish(response, marker + '_DONE');
  } catch (error) { report.providerErrors.push(String(error)); response.destroy(); save(); }
});
provider.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
async function launch(round) {
  const cdpPort = await freePort();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  delete env.NEWMARK_WSL_DISTRO;
  delete env.NEWMARK_ISOLATED_RUNTIME;
  if (realProvider && cuSparseOnly) env.NEWMARK_TEST_CU_OBSERVE_ONLY = '1';
  else delete env.NEWMARK_TEST_CU_OBSERVE_ONLY;
  const entryArgs = packaged ? [] : [desktop];
  logFd = fs.openSync(path.join(evidence, round + '-electron.log'), 'wx');
  child = spawn(exe, [...entryArgs, '--allow-multiple-instances', '--remote-debugging-port=' + cdpPort, '--root', root, '--user-data-dir=' + path.join(root, 'ElectronData')], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', logFd, logFd] });
  const receipt = { round, pid: child.pid, cdpPort, startedAt: new Date().toISOString() }; report.launches.push(receipt); save();
  const getTargets = async port => { try { return await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) })).json(); } catch { return []; } };
  const target = await until(async () => { if (child.exitCode !== null) throw Error('Owned Electron exited ' + child.exitCode); return (await getTargets(cdpPort)).find(t => t.type === 'page' && t.url.includes('index.html')); }, Boolean, 'Promoted owned GUI', 60000);
  renderer = connect(target); await renderer.ready; await waitForPromotedMainUi(renderer); await renderer.call('Runtime.enable');
  renderer.socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Runtime.exceptionThrown') { report.rendererErrors.push(message.params.exceptionDetails); save(); } });
  check('Owned launched UI identity: ' + round, target.url.includes(packaged ? 'app.asar' : 'dist/ui/index.html'), {pid:child.pid,url:target.url});
  if (frameMonitor) {
    report.frameMonitor.windowControl = await maximizeOwnedWindow();
    await sleep(250);
  } else {
    await renderer.call('Emulation.setDeviceMetricsOverride', { width: viewportWidth, height: viewportHeight, deviceScaleFactor: 1, mobile: false });
    if (historyProfileOnly && profileHistoryPages) {
      report.historyProfileWindowControl = await maximizeOwnedWindow();
      await sleep(250);
    } else if (cuSparseOnly) {
      report.computerUseWindowControl = await maximizeOwnedWindow();
      await sleep(250);
    }
  }
  await evaluate(`(()=>{window.__soakLongTasks=[];window.__soakUnhandled=[];window.__soakInputPaints=[];window.__soakClicks=[];document.getElementById('prompt').addEventListener('input',e=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__soakInputPaints.push({elapsedMs:performance.now()-start,trusted:e.isTrusted})));},true);document.addEventListener('click',e=>{const row={at:performance.now(),id:e.target.id,tag:e.target.tagName,cls:String(e.target.className),trusted:e.isTrusted,gen:state.conversationLoadGeneration,before:state.conversationLoadedBefore[runtimeKeyFor(currentConversationTarget().workspaceId,currentConversationTarget().conversationId)]};window.__soakClicks.push(row);if(window.__soakClicks.length>120)window.__soakClicks.shift();queueMicrotask(()=>row.prevented=e.defaultPrevented);},true);try{new PerformanceObserver(list=>{for(const e of list.getEntries())window.__soakLongTasks.push({start:e.startTime,duration:e.duration});}).observe({entryTypes:['longtask']});}catch{}window.addEventListener('unhandledrejection',e=>window.__soakUnhandled.push(String(e.reason)));if(!state.bottomCollapsed)window.toggleBottom();return true;})()`);
  if (frameMonitor) await evaluate("(()=>{const m={active:false,startedAt:0,previous:0,intervals:[],section:null};const tick=now=>{if(!m.active)return;if(m.previous>0){const delta=now-m.previous;if(delta>0){m.intervals.push(delta);if(m.section)m.section.intervals.push(delta);}}m.previous=now;requestAnimationFrame(tick);};m.start=()=>{m.active=true;m.startedAt=performance.now();m.previous=0;m.intervals=[];m.section=null;requestAnimationFrame(tick);return{startedAt:m.startedAt};};m.stop=()=>{m.active=false;return{sampleWindowMs:performance.now()-m.startedAt,intervals:m.intervals};};m.beginSection=name=>{if(!m.active)return false;m.section={name,startedAt:performance.now(),intervals:[]};return true;};m.endSection=()=>{if(!m.section)return null;const s=m.section;m.section=null;return{name:s.name,sampleWindowMs:performance.now()-s.startedAt,intervals:s.intervals};};window.__soakFrameMonitor=m;return true;})()");
}
async function close() {
  if (!child) return; const owned = child;
  const ownedTree = await processMetrics();
  try { await evaluate('window.api.exitApplication()', renderer, 3000); } catch {}
  await until(() => owned.exitCode, value => value !== null, 'Owned normal exit', 18000);
  const ownedIds = ownedTree.map(p=>Number(p.pid)).filter(Number.isInteger);
  const remaining = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command', '$ids=@('+ownedIds.join(',')+'); @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress'], { windowsHide:true,timeout:12000 }, (error,stdout)=>{if(error&&stdout.trim())reject(error);else {const ids=JSON.parse(stdout||'[]');resolve(Array.isArray(ids)?ids:[ids]);}}));
  Object.assign(report.launches.at(-1), { exitCode: owned.exitCode, finishedAt: new Date().toISOString(), ownedProcessIds:ownedIds, remainingProcessIds:remaining });
  renderer?.socket.close(); renderer = null; mainCdp?.socket.close(); mainCdp = null; fs.closeSync(logFd); logFd = undefined; child = null; save();
}
async function startDisplayAwakeGuard() {
  if (!frameMonitor) return;
  const scriptFile = path.join(evidence, 'display-awake-guard.ps1');
  displayAwakeLockPath = path.join(evidence, 'display-awake-guard.lock');
  displayAwakeReadyPath = path.join(evidence, 'display-awake-guard.ready');
  fs.writeFileSync(scriptFile, String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class NewmarkSoakExecutionState {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SetThreadExecutionState(uint flags);
}
'@
$flags = [uint32]::Parse('2147483651')
if ([NewmarkSoakExecutionState]::SetThreadExecutionState($flags) -eq 0) { throw 'SetThreadExecutionState failed' }
Set-Content -LiteralPath $env:NEWMARK_SOAK_DISPLAY_READY -Value ([DateTime]::UtcNow.ToString('o'))
while (Test-Path -LiteralPath $env:NEWMARK_SOAK_DISPLAY_LOCK) {
  [void][NewmarkSoakExecutionState]::SetThreadExecutionState($flags)
  Start-Sleep -Seconds 10
}
[void][NewmarkSoakExecutionState]::SetThreadExecutionState([uint32]::Parse('2147483648'))
`);
  fs.writeFileSync(displayAwakeLockPath, 'hold while the packaged GUI frame test is active\n');
  displayAwakeLogFd = fs.openSync(path.join(evidence, 'display-awake-guard.log'), 'w');
  let startupError = '';
  displayAwakeProcess = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
    env: { ...process.env, NEWMARK_SOAK_DISPLAY_LOCK: displayAwakeLockPath, NEWMARK_SOAK_DISPLAY_READY: displayAwakeReadyPath },
    windowsHide: true,
    stdio: ['ignore', displayAwakeLogFd, displayAwakeLogFd],
  });
  displayAwakeProcess.on('error', error => { startupError = String(error); });
  const startup = await until(() => ({ ready: fs.existsSync(displayAwakeReadyPath), exitCode: displayAwakeProcess.exitCode, error: startupError }), value => value.ready || value.exitCode !== null || !!value.error, 'Display awake guard readiness', 10000);
  if (!startup.ready) throw Error('Display awake guard failed to start: ' + (startup.error || 'PowerShell exit ' + startup.exitCode));
  report.frameMonitor.displayAwakeGuard = {
    active: true,
    helperPid: displayAwakeProcess.pid,
    mechanism: 'SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)',
    settingsChanged: false,
    startedAt: new Date().toISOString(),
  };
  save();
}
async function stopDisplayAwakeGuard() {
  if (displayAwakeLockPath) {
    try { fs.rmSync(displayAwakeLockPath, { force: true }); } catch {}
  }
  const processToStop = displayAwakeProcess;
  if (processToStop && processToStop.exitCode === null) {
    const stopped = await Promise.race([
      new Promise(resolve => processToStop.once('close', resolve)),
      sleep(8000).then(() => null),
    ]);
    if (stopped === null && processToStop.exitCode === null) processToStop.kill();
  }
  if (displayAwakeLogFd !== undefined) {
    try { fs.closeSync(displayAwakeLogFd); } catch {}
    displayAwakeLogFd = undefined;
  }
  displayAwakeProcess = undefined;
  if (report?.frameMonitor?.displayAwakeGuard) {
    report.frameMonitor.displayAwakeGuard.active = false;
    report.frameMonitor.displayAwakeGuard.finishedAt = new Date().toISOString();
    save();
  }
}
async function click(selector) {
  await renderer.call('Page.bringToFront');
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing click target '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',behavior:'instant'});return true;})()`);
  await painted('click '+selector);
  const point = await until(()=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,hitId:hit?.id,hitTag:hit?.tagName,hitClass:String(hit?.className),hit:e===hit||e.contains(hit)};})()`),v=>v.hit,'Clickable hit target '+selector,5000);
  append('pointer-targets.jsonl',{selector,point,at:new Date().toISOString()});
    await renderer.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  if (selector === '.conversation-load-earlier') {
    await evaluate(`(()=>{const area=document.getElementById('chat-area'),anchor=area&&Array.from(area.children).find(node=>node.classList.contains('chat-msg'));window.__soakHistoryAnchorBefore=anchor?{node:anchor,id:anchor.getAttribute('data-message-id'),index:Number(anchor.getAttribute('data-message-index')),top:anchor.getBoundingClientRect().top}:null;return true;})()`);
  }
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
    const binding = await evaluate(`(()=>{const i=state.conversations.findIndex(c=>c.id===${JSON.stringify(seed.targets[name].conversationId)});if(i<0)throw Error('Missing seed conversation');window.switchConversation(i);const target=currentConversationTarget();return{target,bound:state._promptBoundKey,expected:conversationDraftKey(target)};})()`);
    check('Composer binds to selected target synchronously ' + name, binding.bound === binding.expected, binding);
    await until(() => evaluate(`(()=>{const t=currentConversationTarget(),key=runtimeKeyFor(t.workspaceId,t.conversationId);return{target:t,ids:(state.renderedChatMessages||[]).map(m=>m.messageId||''),before:state.conversationLoadedBefore[key],button:!!document.querySelector('.conversation-load-earlier')};})()`), value => value.target.conversationId === seed.targets[name].conversationId && value.ids.some(id => id.startsWith('SOAK_HISTORY_' + name + '_')) && (value.button || value.before === 0), 'Conversation hydrated ' + name);
  });
}
async function pageAll(name, full = true) {
  let pages = 0;
  while (true) {
    const ready=await until(()=>evaluate(`(()=>{const t=currentConversationTarget(),b=document.querySelector('.conversation-load-earlier');return{before:state.conversationLoadedBefore[runtimeKeyFor(t.workspaceId,t.conversationId)],button:!!b,disabled:b?.disabled};})()`),v=>v.before===0||(v.button&&!v.disabled),'Pagination affordance');
    if(ready.before===0)break;
    const before = await evaluate('(state.renderedChatMessages||[]).length');
    const pageContext = await evaluate(`(()=>{const target=currentConversationTarget(),messages=state.renderedChatMessages||[],runs=workRunsForTarget(target);return{stableWorkRunCount:runs.filter(run=>['completed','interrupted','force_interrupted','error'].includes(String(run.status||''))).length,allWorkRunsStable:runs.every(run=>['completed','interrupted','force_interrupted','error'].includes(String(run.status||''))),plainExistingMessages:messages.every(message=>{const mode=String(message?.mode||'').trim().toLowerCase();return message&&(message.role==='user'||message.role==='assistant')&&(!mode||mode==='chat'||mode==='build')&&!message.clientMessageId&&!message.guideId&&!(Array.isArray(message.attachments)&&message.attachments.length);}),hasPendingReview:!!(state.agentWorkUiByConversation&&state.agentWorkUiByConversation[runtimeKeyFor(target.workspaceId,target.conversationId)]&&(state.agentWorkUiByConversation[runtimeKeyFor(target.workspaceId,target.conversationId)].pendingWorkReview||(state.agentWorkUiByConversation[runtimeKeyFor(target.workspaceId,target.conversationId)].workReviews||[]).length)),target:target};})()`);
    await measured('history-page', async () => {
      await click('.conversation-load-earlier');
      const clickState = await evaluate(`(()=>{const b=document.querySelector('.conversation-load-earlier');return{count:(state.renderedChatMessages||[]).length,disabled:!!b?.disabled};})()`);
      if (clickState.count <= before && !clickState.disabled) {
        const fallback = await evaluate(`(()=>{const b=document.querySelector('.conversation-load-earlier');if(!b||b.disabled)return{clicked:false,disabled:!!b?.disabled};b.click();return{clicked:true,disabled:!!b.disabled};})()`);
        append('history-page-click-fallbacks.jsonl', { before, clickState, fallback, at: new Date().toISOString() });
      }
      try {
        const after = await until(() => evaluate('(state.renderedChatMessages||[]).length'), count => count > before, 'Earlier page', 30000);
        const anchor = await evaluate(`(()=>{const prior=window.__soakHistoryAnchorBefore,area=document.getElementById('chat-area'),sameId=prior&&Array.from(area?.querySelectorAll('.chat-msg')||[]).find(node=>node.getAttribute('data-message-id')===prior.id);return{beforeCount:${before},afterCount:${after},id:prior?.id||null,nodeRetained:!!prior?.node?.isConnected,sameIdFound:!!sameId,beforeIndex:prior?.index??null,afterIndex:sameId?Number(sameId.getAttribute('data-message-index')):null,pixelDelta:prior?.node?.isConnected?Number((prior.node.getBoundingClientRect().top-prior.top).toFixed(3)):null};})()`);
        report.historyAnchorMeasurements ||= [];
        report.historyAnchorMeasurements.push({ ...anchor, stableWorkRunCount: pageContext.stableWorkRunCount, allWorkRunsStable: pageContext.allWorkRunsStable, plainExistingMessages: pageContext.plainExistingMessages, hasPendingReview: pageContext.hasPendingReview });
        if (historyProfileOnly) {
          check('Incremental history retains the prior anchor node, index and viewport position', anchor.nodeRetained
            && anchor.afterIndex - anchor.beforeIndex === anchor.afterCount - anchor.beforeCount
            && Math.abs(anchor.pixelDelta) <= 2, anchor);
        }
        if (pageContext.stableWorkRunCount > 0 && pageContext.allWorkRunsStable && pageContext.plainExistingMessages && !pageContext.hasPendingReview) {
          const editBindings = await evaluate(`(()=>{const target=currentConversationTarget(),nodes=Array.from(document.querySelectorAll('#chat-area .chat-msg.user[data-message-index]')),mismatches=[];nodes.forEach(node=>{const button=node.querySelector('.msg-action-btn[onclick^="window.editUserMessage(this,"]'),match=button&&String(button.getAttribute('onclick')||'').match(/window\\.editUserMessage\\(this,\\s*(\\d+)\\)/),index=Number(node.getAttribute('data-message-index')),bound=node._newmarkMessageTarget;if(!match||Number(match[1])!==index||!bound||bound.workspaceId!==target.workspaceId||bound.conversationId!==target.conversationId)mismatches.push({index,onclick:button&&button.getAttribute('onclick'),bound:bound||null});});return{target,userNodes:nodes.length,mismatches:mismatches.slice(0,8),mismatchCount:mismatches.length};})()`);
          check('Stable WorkRun history paging preserves existing message nodes and bindings', anchor.nodeRetained
            && anchor.sameIdFound
            && anchor.afterIndex - anchor.beforeIndex === anchor.afterCount - anchor.beforeCount
            && Math.abs(anchor.pixelDelta) <= 2 && editBindings.userNodes > 0 && editBindings.mismatchCount === 0, { ...anchor, ...pageContext, editBindings });
        }
      }
      catch (error) { report.paginationFailure=await evaluate(`({target:currentConversationTarget(),gen:state.conversationLoadGeneration,cursors:state.conversationLoadedBefore,clicks:window.__soakClicks,rendered:(state.renderedChatMessages||[]).map(m=>m.messageId)})`);save();throw error; }
    });
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
async function measuredMotion(name, operation) {
  if (!frameMonitor) return measured(name, operation);
  await evaluate('window.__soakFrameMonitor.beginSection(' + JSON.stringify(name) + ')');
  try { await measured(name, operation); }
  finally {
    const section = await evaluate('window.__soakFrameMonitor.endSection()').catch(() => null);
    if (section) {
      const result = frameDistribution(section.intervals, section.sampleWindowMs);
      const row = { name, ...result };
      report.motionFrames.push(row); append('motion-frames.jsonl', row);
      (motionIntervals[name] ||= []).push(...section.intervals);
      motionWindows[name] = (motionWindows[name] || 0) + section.sampleWindowMs;
    }
  }
}
async function browsingCycle(cycle) {
  await select('A'); await type('SOAK_DRAFT_A_' + cycle + ' 用户草稿');
  await select('B'); await type('SOAK_DRAFT_B_' + cycle);
  await select('A');
  check('Draft target isolation ' + cycle, await evaluate('document.getElementById("prompt").value') === 'SOAK_DRAFT_A_' + cycle + ' 用户草稿');
  if(cycle%4===0){await select('C');await type('SOAK_DRAFT_C_'+cycle);await select('A');check('Third conversation draft isolation '+cycle,await evaluate('document.getElementById("prompt").value')==='SOAK_DRAFT_A_'+cycle+' 用户草稿');}
  const rect = await evaluate(`(()=>{const r=document.getElementById('chat-area').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await measuredMotion('scroll-to-paint', async () => { await renderer.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...rect, deltaY: -1600, deltaX: 0 }); await painted('scroll'); });
  for (const selector of ['#model-select-button', '#context-token-ring']) {
    await measuredMotion('popup-open-close', async () => { await click(selector); await sleep(110); await click(selector); await sleep(90); });
  }
  await measuredMotion('sidebar-toggle', async () => { await click('#left-collapse-btn'); await sleep(180); await click('#left-collapse-btn'); await evaluate('window.toggleRight();true'); await sleep(180); await evaluate('window.toggleRight();true'); });
  if (cycle % 6 === 0) await pageAll('A', cycle % 18 === 0);
  await renderer.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...rect, deltaY: 100000, deltaX: 0 });
}
async function concurrentTargetSwitchStress() {
  const cases = [
    { name: 'A', target: seed.targets.A, marker: 'SOAK_HOLD_91001', forbidden: 'SOAK_HOLD_91002' },
    { name: 'B', target: seed.targets.B, marker: 'SOAK_HOLD_91002', forbidden: 'SOAK_HOLD_91001' },
  ];
  const started = await evaluate(`(()=>{const cases=${JSON.stringify(cases.map(({ target, marker }) => ({ target, marker })))};window.__parallelConversationPromises=cases.map(item=>window.api.sendMessage(item.marker+': reply with the matching marker after the test releases this stream.',item.target,{requestedMode:'build',inputMode:'guide'}).then(state=>{const transcript=JSON.stringify({chatMessages:state?.chatMessages||[],workRuns:state?.workRuns||[]});return{ok:!!state&&!state.error&&state.ok!==false,conversationId:state?.conversationId||'',hasExpected:transcript.includes(item.marker+'_DONE'),hasForbidden:transcript.includes(item.marker==='SOAK_HOLD_91001'?'SOAK_HOLD_91002_DONE':'SOAK_HOLD_91001_DONE'),workRuns:(state?.workRuns||[]).map(run=>({runId:run.runId,status:run.status,targetConversationId:run.target?.conversationId||''}))};},error=>({ok:false,error:String(error?.message||error)})));return true;})()`);
  if (!started) throw Error('Could not start target-bound sends');
  const waitingFor = cases.map(item => item.marker);
  await until(() => Promise.resolve([...heldByMarker.keys()]), keys => waitingFor.every(marker => keys.includes(marker)), 'Both target streams held concurrently by local provider', 45000);

  async function snapshotPair() {
    await Promise.all(cases.map(item => ipc('ackTranscript', item.target, '')));
    return await Promise.all(cases.map(item => ipc('getState', item.target)));
  }
  function summarizePair(states) {
    return cases.map((item, index) => {
      const state = states[index];
      const serialized = JSON.stringify({ chatMessages: state?.chatMessages || [], workRuns: state?.workRuns || [] });
      const run = (state?.workRuns || []).find(entry => entry.runId === state?.runtime?.runId);
      return {
        expectedConversationId: item.target.conversationId,
        conversationId: state?.conversationId || '',
        runtimeStatus: state?.runtimeStatus || '',
        runtimeError: state?.runtimeError || '',
        running: state?.runtime?.running === true,
        runId: state?.runtime?.runId || '',
        runStatus: run?.status || '',
        runTargetConversationId: run?.target?.conversationId || '',
        runPromptHasExpectedMarker: String(run?.primaryPrompt || '').includes(item.marker),
        hasExpectedMarker: serialized.includes(item.marker),
        hasForbiddenMarker: serialized.includes(item.forbidden),
      };
    });
  }
  const firstSnapshots = await snapshotPair();
  const firstSummary = summarizePair(firstSnapshots);
  const firstValid = firstSummary.every(row => row.conversationId === row.expectedConversationId
    && row.running && row.runStatus === 'running'
    && row.runTargetConversationId === row.expectedConversationId
    && row.runPromptHasExpectedMarker && row.hasExpectedMarker && !row.hasForbiddenMarker);
  if (!firstValid) throw Error('Initial parallel target snapshots were invalid: ' + JSON.stringify(firstSummary));
  const runIds = Object.fromEntries(firstSummary.map(row => [row.expectedConversationId, row.runId]));
  const simultaneousStreams = [...heldByMarker.keys()];

  const switches = [];
  for (let index = 0; index < 10; index++) {
    const item = cases[index % 2];
    const switchStarted = performance.now();
    await select(item.name);
    const states = await snapshotPair();
    const summary = summarizePair(states);
    const selected = await evaluate('currentConversationTarget()');
    const bothSameRuns = summary.every(row => row.running
      && row.runStatus === 'running'
      && row.runTargetConversationId === row.expectedConversationId
      && row.runId === runIds[row.expectedConversationId]);
    const target = summary.find(row => row.expectedConversationId === item.target.conversationId);
    const valid = selected?.conversationId === item.target.conversationId
      && target?.conversationId === item.target.conversationId
      && target?.hasExpectedMarker === true && target?.hasForbiddenMarker === false
      && bothSameRuns;
    const receipt = { index: index + 1, selectedConversationId: selected?.conversationId || '', elapsedMs: performance.now() - switchStarted, bothSameRuns, snapshots: summary };
    switches.push(receipt);
    check('Parallel running target switch and IPC binding ' + (index + 1), valid, receipt);
    if (!valid) throw Error('Parallel target switch failed: ' + JSON.stringify(receipt));
  }

  for (const item of cases) {
    const response = heldByMarker.get(item.marker);
    if (!response || response.destroyed) throw Error('Held provider response disappeared before release: ' + item.marker);
    heldByMarker.delete(item.marker);
    held.delete(response);
    finish(response, item.marker + '_DONE');
  }
  const settlements = await evaluate('Promise.all(window.__parallelConversationPromises)', renderer, 60000);
  if (!Array.isArray(settlements) || settlements.length !== 2) throw Error('The two target sends did not both settle: ' + JSON.stringify(settlements));
  cases.forEach((item, index) => {
    const result = settlements[index];
    const boundRuns = (result?.workRuns || []).filter(run => run.targetConversationId !== item.target.conversationId);
    if (!result?.ok || result.conversationId !== item.target.conversationId || !result.hasExpected || result.hasForbidden || boundRuns.length) {
      throw Error('Parallel completion returned on the wrong target for ' + item.name + ': ' + JSON.stringify(result));
    }
  });

  const finalSnapshots = await snapshotPair();
  const finalSummary = summarizePair(finalSnapshots);
  const finalValid = finalSummary.every((row, index) => {
    const item = cases[index];
    const state = finalSnapshots[index];
    const serialized = JSON.stringify({ chatMessages: state?.chatMessages || [], workRuns: state?.workRuns || [] });
    const run = (state?.workRuns || []).find(entry => entry.runId === runIds[item.target.conversationId]);
    return row.conversationId === item.target.conversationId
      && !row.running
      && run?.status === 'completed'
      && run?.target?.conversationId === item.target.conversationId
      && serialized.includes(item.marker + '_DONE')
      && !serialized.includes(item.forbidden);
  });
  if (!finalValid) throw Error('Completed target snapshots failed persistence/binding checks: ' + JSON.stringify(finalSummary));
  report.parallelConversationStress = {
    mode: 'local-loopback-provider; exact packaged app; no external credentials',
    conversations: cases.map(item => item.target.conversationId),
    markers: cases.map(item => item.marker),
    runIds,
    simultaneousStreams,
    switches,
    settlements,
    finalSnapshots: finalSummary,
    localProviderRequests: report.requests.filter(request => cases.some(item => item.marker === request.marker)),
  };
  check('Both parallel conversations complete and persist to their own target', true, { conversations: report.parallelConversationStress.conversations, runIds, markers: cases.map(item => item.marker) });
}
async function computerUseSparseGuiSmoke() {
  await select('A');
  const target = seed.targets.A, marker = 'SOAK_CU_SPARSE_91003';
  if (!realProvider) {
    const autoSelection = await evaluate(`(()=>{const selector=document.getElementById('model-select');const available=!!selector&&Array.from(selector.options).some(option=>option.value==='auto');if(available)window.selectModelFromMenu('auto');return{available,model:state.model,autoSwitch:state.autoSwitch};})()`);
    check('The GUI selects Auto before the packaged current-model decision', autoSelection.available
      && autoSelection.model === 'auto' && autoSelection.autoSwitch === 'on', autoSelection);
  } else {
    check('Real-provider test pins the configured remote model and disables Auto routing',
      await evaluate(`(()=>({model:state.model,autoSwitch:state.autoSwitch}))()`).then(value => value.autoSwitch !== 'on'),
      { provider: realProvider.name, model: realProvider.model, autoSwitch: await evaluate('state.autoSwitch') });
  }
  const enable = await ipc('setComputerUseEnabled', target, true);
  const session = await ipc('computerUseState', target);
  report.computerUseSession = { enableOk: enable?.ok === true, enabled: session?.enabled === true, occupiedBeforeBuild: session?.occupied === true };
  check('Computer Use explicitly enabled for the isolated GUI target', enable?.ok === true && session?.enabled === true, report.computerUseSession);
  const completionMarker = realProvider ? realProvider.completionMarker : marker + '_DONE';
  const prompt = realProvider
    ? `${marker}: Use the computer_use tool exactly once with action observe and sparse_wait_ms 5000. Do not click or type. Inspect the returned screenshot and report the exact visible label ${realProvider.imageLabel}. End with the exact marker ${completionMarker}.`
    : marker + ': observe the current desktop once and report what is visible.';
  await evaluate(`(()=>{window.__cuSparseDone=false;window.__cuSparseResult=null;window.__cuSparsePromise=window.api.sendMessage(${JSON.stringify(prompt)},${JSON.stringify(target)},{requestedMode:'build',inputMode:'guide'}).then(state=>{window.__cuSparseResult={ok:!!state&&!state.error&&state.ok!==false,conversationId:state?.conversationId||'',runtimeError:state?.runtimeError||'',markerVisible:JSON.stringify({chatMessages:state?.chatMessages||[],workRuns:state?.workRuns||[]}).includes(${JSON.stringify(completionMarker)})};window.__cuSparseDone=true;return window.__cuSparseResult;},error=>{window.__cuSparseResult={ok:false,error:String(error?.message||error)};window.__cuSparseDone=true;return window.__cuSparseResult;});return true;})()`);
  await until(() => report.requests.filter(item => item.marker === marker), items => items.some(item => item.stream === true), 'GUI Build reached the isolated loopback provider', 60000);
  const settled = await until(() => evaluate('window.__cuSparseDone ? window.__cuSparseResult : null'), value => value !== null, 'Computer Use sparse Build settled', realProvider ? 300000 : 120000);
  await ipc('ackTranscript', target, '');
  const state = await ipc('getState', target);
  const transcript = JSON.stringify({ chatMessages: state?.chatMessages || [], workRuns: state?.workRuns || [] });
  const requests = report.requests.filter(item => item.marker === marker);
  const sparseRequests = requests.filter(item => item.sparseMeasurement);
  const visualPulse = await evaluate('window.__soakSparseVisualPulseState || null');
  const toolRequest = requests.find(item => item.toolNames?.includes('computer_use'));
  const sparse = sparseRequests.map(item => item.sparseMeasurement);
  const validReason = measurement => ['wait_elapsed', 'coarse_change', 'screen_geometry_changed'].includes(String(measurement?.reason || ''));
  const run = (state?.workRuns || []).find(item => String(item.primaryPrompt || '').includes(marker));
  const assistantText = (run?.events || []).filter(event => event.type === 'text' || event.type === 'response' || event.type === 'final_response').map(event => String(event.content || '')).join('\n');
  const modelCalledComputerUse = requests.some(item => item.responseToolNames?.includes('computer_use'));
  const modelRequestedProvision = requests.some(item => item.responseToolNames?.includes('tool_provision'));
  const allProviderRequestsUseConfiguredModel = requests.filter(item => item.stream).every(item => item.model === (realProvider?.model || fixtureModelId));
  const sparseHasVision = sparseRequests.some(item => item.visionImageAttached === true);
  const hasFreshSparseResult = sparse.some(item => item?.method === 'coarse-grid-luminance-change-wakeup'
    && validReason(item) && Number(item?.sample_count) >= 1 && item?.fresh_full_observation_follows === true
    && Number(item?.wall_elapsed_ms) > 0 && Number(item?.wall_elapsed_ms) <= 5500);
  const wakesOnChange = sparse.some(item => item?.reason === 'coarse_change' && Number(item.changed_cells) > 0);
  const completionInAssistantText = realProvider
    ? assistantText.includes(completionMarker) && assistantText.toLowerCase().includes(realProvider.imageLabel.toLowerCase())
    : transcript.includes(completionMarker);
  const observationOnlyGuardHit = JSON.stringify(run?.events || []).includes('[computer_use test guard]');
  report.computerUseSparseGui = {
    mode: realProvider ? 'packaged GUI with live remote provider through local evidence proxy' : 'packaged GUI with loopback fixture provider',
    marker,
    completionMarker,
    realProvider: realProvider ? { id: realProvider.id, name: realProvider.name, model: realProvider.model, upstreamHost: new URL(realProvider.baseUrl).host, configuredVision: realProvider.configuredVision, testVisionOverride: true } : null,
    conversationId: target.conversationId,
    completed: !!settled?.ok && settled.conversationId === target.conversationId && completionInAssistantText,
    assistantText: assistantText.slice(-1600),
    modelCalledComputerUse,
    modelRequestedProvision,
    observationOnlyGuardEnabled: !!realProvider && cuSparseOnly,
    observationOnlyGuardHit,
    run: run ? { runId: run.runId, status: run.status, targetConversationId: run.target?.conversationId || '', primaryPromptContainsMarker: String(run.primaryPrompt || '').includes(marker) } : null,
    sparseMeasurements: sparse,
    visualPulse: visualPulse,
    visionImagesAttached: sparseRequests.map(item => item.visionImageAttached === true),
    allProviderRequestsUseConfiguredModel,
    providerRequestCount: requests.length,
    providerStages: requests.map(item => ({ model: item.model || '', stream: item.stream, statusCode: item.statusCode || null, responseModel: item.responseModel || '', finishReason: item.finishReason || '', responseToolNames: item.responseToolNames || [], toolNames: item.toolNames || [], toolResultCount: item.toolResultCount || 0, sparseMeasurement: item.sparseMeasurement, visionImageAttached: item.visionImageAttached === true, errorClass: item.errorClass || '' })),
    errors: { settledError: settled?.error || null, runtimeError: settled?.runtimeError || state?.runtimeError || null, providerErrors: report.providerErrors.filter(error => String(error).includes('Computer Use')) },
  };
  if (realProvider) {
    check('Live-model Electron only permits read-only ComputerUse actions', report.computerUseSparseGui.observationOnlyGuardEnabled && !observationOnlyGuardHit, { observationOnlyGuardEnabled: report.computerUseSparseGui.observationOnlyGuardEnabled, observationOnlyGuardHit });
    const bounds = visualPulse?.bounds || {};
    const labelInsideCapturedViewport = visualPulse?.everVisible === true
      && visualPulse?.labelText === realProvider.imageLabel
      && Number(bounds.x) >= 0 && Number(bounds.y) >= 0
      && Number(bounds.x) + Number(bounds.width) <= Number(bounds.viewportWidth)
      && Number(bounds.y) + Number(bounds.height) <= Number(bounds.viewportHeight);
    check('Synthetic CU label is positioned fully inside the captured viewport', labelInsideCapturedViewport, visualPulse);
    check('Real model itself returned a computer_use tool call', modelCalledComputerUse, { stages: report.computerUseSparseGui.providerStages });
    check('The model used the sparse-wait argument through the production Computer Use tool result', hasFreshSparseResult, { sparse, stages: report.computerUseSparseGui.providerStages });
    check('Sparse sensing woke on the visible synthetic change and then produced a fresh full observation', wakesOnChange && visualPulse?.scheduled && Number(visualPulse.changes) > 0 && !!report.computerUseSparseImage?.file, { sparse, visualPulse, computerUseSparseImage: report.computerUseSparseImage || null });
    check('The next real-provider request contained the full observation image', sparseHasVision && report.computerUseSparseImage?.bytes > 0 && allProviderRequestsUseConfiguredModel, { visionImagesAttached: report.computerUseSparseGui.visionImagesAttached, allProviderRequestsUseConfiguredModel, stages: report.computerUseSparseGui.providerStages });
    check('The real model described the visible synthetic label and returned its completion marker', completionInAssistantText, report.computerUseSparseGui.assistantText);
  } else {
    check('Loopback Build provisioned and called Computer Use observe', !!toolRequest && requests.some(item => item.toolNames?.includes('tool_provision')), { providerStages: report.computerUseSparseGui.providerStages });
    const currentModelDecision = (report.jevDecisionRequests || []).find(item => item.model === fixtureModelId && item.schemaName === 'newmark_jev_route_decision');
    check('Packaged Auto selects through current-model no-thinking strict JSON before Computer Use', !!currentModelDecision
      && currentModelDecision.reasoningEffort === 'none'
      && currentModelDecision.schemaStrict
      && currentModelDecision.selected?.providerId === 'soak-loopback'
      && currentModelDecision.selected?.modelId === fixtureModelId,
    currentModelDecision || report.jevDecisionRequests || []);
    check('Packaged sparse sensing wakes on a real visible coarse-grid change and returns a fresh full observation', sparse.length === 2 && hasFreshSparseResult && wakesOnChange && Number(sparse[1]?.wall_elapsed_ms) >= 150 && Number(sparse[1]?.wall_elapsed_ms) <= 1200 && visualPulse?.scheduled && Number(visualPulse.changes) > 0 && !!report.computerUseSparseImage?.file, { sparse, visualPulse, computerUseSparseImage: report.computerUseSparseImage || null });
    check('Both full observations include an image for the configured vision model', sparseRequests.length === 2 && sparseRequests.every(item => item.visionImageAttached === true) && allProviderRequestsUseConfiguredModel, { visionImagesAttached: report.computerUseSparseGui.visionImagesAttached, allProviderRequestsUseConfiguredModel });
  }
  check('CU Build completes and persists to its originating conversation', report.computerUseSparseGui.completed && run?.status === 'completed' && run?.target?.conversationId === target.conversationId, { settled: { ok: settled?.ok, conversationId: settled?.conversationId }, conversationId: state?.conversationId, run: report.computerUseSparseGui.run, completionInAssistantText, completionMarker });
  const missingComputerUseToolResult = (run?.events || [])
    .filter(event => event.type === 'tool_result')
    .some(event => /computer_use.*not found/i.test(String(event.content || '')));
  check('No missing-tool or provider harness errors in packaged CU path', !report.computerUseSparseGui.errors.settledError && !report.providerErrors.some(error => String(error).includes('Computer Use')) && !missingComputerUseToolResult, {
    ...report.computerUseSparseGui.errors,
    missingComputerUseToolResult,
  });
  const disable = await ipc('setComputerUseEnabled', target, false);
  const afterDisable = await ipc('computerUseState', target);
  report.computerUseSession.disableOk = disable?.ok === true;
  report.computerUseSession.enabledAfterDisable = afterDisable?.enabled === true;
  check('Computer Use lease is disabled after the isolated test', disable?.ok === true && afterDisable?.enabled === false, { disableOk: disable?.ok === true, enabled: afterDisable?.enabled === true, occupied: afterDisable?.occupied === true });
}
function readPersistedWorkRun(target, runId) {
  const directory = path.join(root, 'Work', 'User soak fixture', 'conversations');
  const index = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
  const [key, entry] = Object.entries(index.conversations || {}).find(([candidate]) => candidate.endsWith('-' + target.conversationId)) || [];
  if (!key || !entry?.shard) return null;
  const shard = JSON.parse(fs.readFileSync(path.join(directory, 'shards', entry.shard), 'utf8'));
  const run = (shard.workRuns || []).find(item => item.runId === runId);
  const expected = target.conversationId === seed.targets.A.conversationId ? 'SOAK_HOLD_91001_DONE' : 'SOAK_HOLD_91002_DONE';
  const forbidden = target.conversationId === seed.targets.A.conversationId ? 'SOAK_HOLD_91002_DONE' : 'SOAK_HOLD_91001_DONE';
  const transcript = JSON.stringify({ chatMessages: shard.chatMessages || [], workRuns: shard.workRuns || [] });
  return {
    conversationId: run?.target?.conversationId || '',
    runId: run?.runId || '',
    runStatus: run?.status || '',
    endedAt: run?.endedAt || '',
    hasExpectedMarker: transcript.includes(expected),
    hasForbiddenMarker: transcript.includes(forbidden),
  };
}
async function main() {
  if ([parallelOnly, cuSparseOnly, historyProfileOnly].filter(Boolean).length > 1) throw Error('Select only one focused gate');
  if (realProvider && !cuSparseOnly) throw Error('--real-provider is supported only together with --cu-sparse-only');
  if (realProviderName && !realProvider) throw Error('Real provider configuration could not be loaded');
  if (!parallelOnly && !cuSparseOnly && !historyProfileOnly && (!Number.isFinite(durationSeconds) || durationSeconds < 15 || durationSeconds > 43200)) throw Error('Duration must be 15..43200 seconds');
  if (fs.existsSync(path.join(evidence, 'report.json'))) throw Error('Evidence directory already used');
  fs.mkdirSync(evidence, { recursive: true }); root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-user-soak-'));
  fs.copyFileSync(__filename, path.join(evidence, 'driver.cjs'));
  report = { startedAt: new Date().toISOString(), durationSecondsRequested: durationSeconds, historyCountRequested: historyCount, evidence, root, exe, packaged, exeSha256: hash(exe), appAsarSha256: packaged ? hash(appRoot) : null, sourceUiSha256: hash(path.join(desktop, 'src/ui/index.html')), distUiSha256: hash(path.join(desktop, 'dist/ui/index.html')), harnessSha256: hash(__filename), boundary: realProvider ? 'Exact packaged Electron GUI/Agent with real remote provider behind a local evidence proxy. The API key is read in memory from the existing user config, replaced into the upstream Authorization header, and never written to the isolated app root or report. Synthetic visible test label only; no user conversation or screenshot content is sent.' : 'Real Electron UI/preload/Agent and loopback HTTP. CDP input plus existing UI entrypoints; fixtures seed persisted data and a transient visible pulse for the sparse Computer Use change-wakeup gate only. No production handlers or snapshots replaced.', checks: [], launches: [], requests: [], screenshots: [], rendererErrors: [], providerErrors: [], runtimeProblems: [], diagnostics: [], cycles: 0, sampleCount: 0 };
  if (realProvider) report.realProviderTestConfiguration = { id: realProvider.id, name: realProvider.name, model: realProvider.model, upstreamHost: new URL(realProvider.baseUrl).host, source: 'existing user config; key not logged or written to test root', configuredVision: realProvider.configuredVision, isolatedTestVisionOverride: true };
  report.gpuSamples = []; report.processSamples = []; report.longTaskEvents = []; report.motionFrames = [];
  if (frameMonitor) report.frameMonitor = { metric: 'renderer requestAnimationFrame callback cadence; not compositor presents', targetRefreshHz, targetFrameBudgetMs: Number((1000 / targetRefreshHz).toFixed(3)), nativeWindow: 'maximized Electron window on the active desktop display', gpuAttribution: 'GPU Engine counters filtered to the owned Electron PID and its descendant process IDs' };
  if (packaged && expectedAsar) check('Packaged ASAR identity matches caller', report.appAsarSha256 === expectedAsar);
  save(); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const models = realProvider
    ? [{ name: realProvider.model, display: realProvider.model, max_tokens: 128000, enabled: true, vision: true, capabilities: ['text_input', 'text_output', 'tool_use', 'vision'] }]
    : Array.from({ length: 32 }, (_, i) => ({ name: i ? 'soak-model-' + i : 'soak-loopback', max_tokens: 256000, enabled: true, vision: i === 0, capabilities: ['text_input','text_output','tool_use', ...(i === 0 ? ['vision'] : [])] }));
  if (cuSparseOnly && !realProvider) models[0].thinking = true;
  if (cuSparseOnly && !realProvider) models[0].name = fixtureModelId;
  const selectedModel = realProvider?.model || fixtureModelId;
  const selectedProvider = realProvider
    ? { id: realProvider.id, name: `${realProvider.name} isolated test proxy`, base_url: 'http://127.0.0.1:' + provider.address().port + '/v1', api_key: 'fixture-only', protocol: 'openai', enabled: true, models }
    : { id: 'soak-loopback', name: 'Soak loopback', base_url: 'http://127.0.0.1:' + provider.address().port + '/v1', api_key: 'fixture-only', protocol: 'openai', enabled: true, models };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ models: { providers: [selectedProvider], default_model: selectedModel, auto_switch: cuSparseOnly && !realProvider, fallback_on_unavailable: false, agent_engine: 'builtin', openai_api_mode: 'chat_stream' }, context: { auto_compress: false }, agent: { engine: 'builtin', default_mode: 'build' }, general: { language: 'zh', close_behavior: 'exit' }, workspace: { auto_create_timestamp_workspace: false }, remote: { touch_enabled: false } }));
  const seedFile = path.join(root, 'seed.cjs'), receiptFile = path.join(evidence, 'seed.json'); fs.writeFileSync(seedFile, seedSource);
  const seedFd = fs.openSync(path.join(evidence, 'seed.log'), 'wx');
  await new Promise((resolve, reject) => { const p = spawn(packaged ? exe : process.execPath, [seedFile, root, appRoot, receiptFile, String(historyCount)], { env: { ...process.env, ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, windowsHide: true, stdio: ['ignore', seedFd, seedFd] }); p.on('error', reject); p.on('close', code => { fs.closeSync(seedFd); code === 0 ? resolve() : reject(Error('Seed exit ' + code)); }); }); seed = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  try {
    await startDisplayAwakeGuard();
    await launch('activity'); heartbeatTimer = setInterval(() => { void sample(); }, 3000); await sample();
    report.initialDraft = { snapshot: (await ipc('getState', seed.targets.A)).draft, prompt: await evaluate('document.getElementById("prompt").value') };
    check('Initial persisted draft is visible before selecting a conversation', report.initialDraft.snapshot === 'SOAK_SEEDED_DRAFT_A' && report.initialDraft.prompt === 'SOAK_SEEDED_DRAFT_A', report.initialDraft);
    if (historyProfileOnly) {
      await select('A');
      if (profileHistoryPages) {
        const wrapped = await evaluate(`(()=>{if(typeof window.renderChatMessages!=='function')return false;const original=window.renderChatMessages;window.__soakPageRenderCalls=0;window.renderChatMessages=function(){window.__soakPageRenderCalls++;return original.apply(this,arguments);};return true;})()`);
        check('Full transcript renderer can be monitored during history paging', wrapped === true, { wrapped });
      }
      await pageAll('A');
      await screenshot('01-profile-full-history');
      const historyMotion = await evaluate(`(()=>{const rows=Array.from(document.querySelectorAll('#chat-area .chat-msg[data-message-index]'));const target=currentConversationTarget(),probe=addMsg('user','SOAK_LIVE_ANIMATION_PROBE','chat','',rows.length,{target,skipAutoScroll:true});const liveAnimation=getComputedStyle(probe).animationName;probe.remove();return{rows:rows.length,staticRows:rows.filter(node=>node.classList.contains('history-static')).length,animatedHistoryRows:rows.filter(node=>getComputedStyle(node).animationName!=='none'||getComputedStyle(node).transform!=='none').length,liveAnimation};})()`);
      check('Restored history skips entrance layers while live messages keep their motion', historyMotion.rows === historyCount && historyMotion.staticRows === historyCount && historyMotion.animatedHistoryRows === 0 && historyMotion.liveAnimation === 'msg-in', historyMotion);
      if (profileHistoryPages) {
        const fullRenderCalls = await evaluate('window.__soakPageRenderCalls');
        check('History paging avoids full transcript rebuilds for simple history', fullRenderCalls === 0, { fullRenderCalls });
      }
      const indexBinding = await evaluate(`(()=>{const messages=state.renderedChatMessages||[],nodes=Array.from(document.querySelectorAll('#chat-area .chat-msg[data-message-index]'));const mismatches=[];nodes.forEach((node,index)=>{const message=messages[index]||{};if(Number(node.getAttribute('data-message-index'))!==index||String(node.getAttribute('data-message-id')||'')!==String(message.messageId||''))mismatches.push({index,nodeIndex:node.getAttribute('data-message-index'),nodeId:node.getAttribute('data-message-id'),messageId:message.messageId});});const users=nodes.filter(node=>node.classList.contains('user'));const editMismatches=users.flatMap(node=>{const button=node.querySelector('.msg-action-btn[onclick^="window.editUserMessage(this,"]'),match=button&&String(button.getAttribute('onclick')||'').match(/window\\.editUserMessage\\(this,\\s*(\\d+)\\)/),expected=Number(node.getAttribute('data-message-index'));return !match||Number(match[1])!==expected?[{expected,onclick:button&&button.getAttribute('onclick')}]:[];});return{messageCount:messages.length,nodeCount:nodes.length,indexMismatches:mismatches.slice(0,8),userEditButtons:users.length,editMismatches:editMismatches.slice(0,8),editMismatchCount:editMismatches.length};})()`);
      check('Paginated message identity and edit actions stay index-bound', indexBinding.messageCount === historyCount && indexBinding.nodeCount === historyCount && indexBinding.indexMismatches.length === 0 && indexBinding.editMismatchCount === 0, indexBinding);
      const editActionBinding = await evaluate(`(()=>{const target=currentConversationTarget(),indices=[0,200,${historyCount - 2}],captured=[],checked=[],originalSubmit=window.submitUserMessageEdit;window.submitUserMessageEdit=function(button,index,text,editTarget){captured.push({index:Number(index),text:String(text||''),target:editTarget||null});};try{for(const index of indices){const node=document.querySelector('#chat-area .chat-msg.user[data-message-index="'+index+'"]'),button=node&&node.querySelector('.msg-action-btn[onclick^="window.editUserMessage(this,"]');if(!node||!button)throw Error('Missing user message edit binding at '+index);const targetForNode=node._newmarkMessageTarget,marker='SOAK_CAPTURED_EDIT_INDEX_'+index;button.click();const body=node.querySelector('.msg-body'),editor=body&&body.querySelector('.message-inline-editor textarea'),submit=body&&body.querySelector('.message-edit-submit');if(!editor||!submit)throw Error('Inline editor did not open at '+index);editor.value=marker;submit.click();const item=captured[captured.length-1]||{};checked.push({index,actualIndex:item.index,text:item.text,target:item.target,nodeTarget:targetForNode,messageId:node.getAttribute('data-message-id')||''});const cancel=body.querySelector('.message-edit-cancel');if(cancel)cancel.click();}}finally{window.submitUserMessageEdit=originalSubmit;}return{checked,target};})()`);
      check('Edit submission binds to the correct target and new, boundary and tail messages', editActionBinding.checked.length === 3 && editActionBinding.checked.every(item => item.actualIndex === item.index && item.text === 'SOAK_CAPTURED_EDIT_INDEX_' + item.index && item.target && item.nodeTarget && item.target.workspaceId === editActionBinding.target.workspaceId && item.target.conversationId === editActionBinding.target.conversationId && item.nodeTarget.workspaceId === editActionBinding.target.workspaceId && item.nodeTarget.conversationId === editActionBinding.target.conversationId), editActionBinding);
      const profileCount = (report.cpuProfiles || []).length;
      const expectedProfileCount = [0, 4, 9, 13].filter(pageIndex => pageIndex < historyPageActionIndex).length;
      check('Selected history pages produced CPU profiles', !profileHistoryPages || (expectedProfileCount > 0 && profileCount === expectedProfileCount), { profileCount, expectedProfileCount, pageActions: historyPageActionIndex, profiles: report.cpuProfiles || [] });
      report.passed = true;
      return;
    }
    if (parallelOnly) {
      await select('A');
      await concurrentTargetSwitchStress();
      const preCloseDisk = ['A', 'B'].map(name => {
        const target = seed.targets[name];
        const runId = report.parallelConversationStress.runIds[target.conversationId];
        return { name, ...readPersistedWorkRun(target, runId) };
      });
      const preCloseDurable = preCloseDisk.every(row => row.conversationId === seed.targets[row.name].conversationId
        && row.runId === report.parallelConversationStress.runIds[row.conversationId]
        && row.runStatus === 'completed' && !!row.endedAt && row.hasExpectedMarker && !row.hasForbiddenMarker);
      report.parallelConversationStress.preCloseDisk = preCloseDisk;
      check('Both terminal target-bound runs are on disk before closing the GUI', preCloseDurable, preCloseDisk);
      clearInterval(heartbeatTimer); heartbeatTimer = undefined;
      while (sampleBusy) await sleep(50);
      await close();
      await launch('parallel-cold');
      const coldTargets = [];
      for (const name of ['A', 'B']) {
        const target = seed.targets[name];
        await ipc('ackTranscript', target, '');
        const state = await ipc('getState', target);
        const runId = report.parallelConversationStress.runIds[target.conversationId];
        const run = (state?.workRuns || []).find(item => item.runId === runId);
        const marker = name === 'A' ? 'SOAK_HOLD_91001_DONE' : 'SOAK_HOLD_91002_DONE';
        const otherMarker = name === 'A' ? 'SOAK_HOLD_91002_DONE' : 'SOAK_HOLD_91001_DONE';
        const transcript = JSON.stringify({ chatMessages: state?.chatMessages || [], workRuns: state?.workRuns || [] });
        const valid = state?.conversationId === target.conversationId
          && run?.status === 'completed'
          && run?.target?.conversationId === target.conversationId
          && transcript.includes(marker)
          && !transcript.includes(otherMarker);
        const receipt = { name, conversationId: state?.conversationId || '', runId: run?.runId || '', runStatus: run?.status || '', runTargetConversationId: run?.target?.conversationId || '', hasExpectedMarker: transcript.includes(marker), hasOtherMarker: transcript.includes(otherMarker), runtimeStatus: state?.runtimeStatus || '', runtimeError: state?.runtimeError || '' };
        coldTargets.push(receipt);
        check('Cold restart retains completed target-bound run ' + name, valid, receipt);
        if (!valid) throw Error('Cold restart target binding failed: ' + JSON.stringify(receipt));
      }
      report.parallelConversationStress.coldRestart = coldTargets;
      report.passed = true;
      return;
    }
    if (cuSparseOnly) {
      await computerUseSparseGuiSmoke();
      clearInterval(heartbeatTimer); heartbeatTimer = undefined;
      while (sampleBusy) await sleep(50);
      check('No renderer/runtime heartbeat failures during sparse CU activity', !report.rendererErrors.length && !report.runtimeProblems.length && !report.lastSample?.processes?.some(process => process.responding === false), { rendererErrors: report.rendererErrors.length, runtimeProblems: report.runtimeProblems, sampleCount: report.sampleCount, processHealth: report.lastSample?.processes?.map(process => ({ role: process.role, responding: process.responding })) });
      await close();
      report.passed = true;
      return;
    }
    await select('A'); await pageAll('A'); await screenshot('01-full-history');
    report.activityStartedAt = new Date().toISOString(); report.activityStartedMs = Date.now();
    if (frameMonitor) {
      report.frameMonitor.displayAtCaptureStart = await evaluate('({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight}})');
      report.frameMonitor.startedAt = new Date().toISOString();
      await evaluate('window.__soakFrameMonitor.start()'); frameCaptureActive = true;
    }
    save();
    while (Date.now() - report.activityStartedMs < durationSeconds * 1000) {
      const cycle = ++report.cycles; await browsingCycle(cycle);
      if (cycle % 5 === 1) await regularBuild(cycle);
      if (cycle % 10 === 2) await queueBuild(cycle);
      await ipc('getState', seed.targets.A); if (cycle % 10 === 0) { await screenshot('cycle-' + cycle); console.log(JSON.stringify({ cycle, elapsedSeconds: (Date.now() - report.activityStartedMs)/1000, lastSample: report.lastSample?.heap, metrics: report.metrics })); }
      await sleep(650); save();
    }
    report.activityElapsedSeconds = (Date.now() - report.activityStartedMs) / 1000; report.activityFinishedAt = new Date().toISOString();
    if (frameMonitor) {
      frameCaptureActive = false;
      const capture = await evaluate('window.__soakFrameMonitor.stop()');
      report.frameMonitor.activityWindowMs = Number(capture.sampleWindowMs.toFixed(2));
      report.frameMonitor.rendererCadence = frameDistribution(capture.intervals, capture.sampleWindowMs);
      report.frameMonitor.motionComponents = Object.fromEntries(Object.keys(motionIntervals).map(name => [name, frameDistribution(motionIntervals[name], motionWindows[name])]));
      const longTasks = report.longTaskEvents.map(task => task.durationMs);
      report.frameMonitor.longTasks = { sampled: longTasks.length, over50ms: longTasks.filter(value => value >= 50).length, over100ms: longTasks.filter(value => value >= 100).length, maximumMs: longTasks.length ? Number(Math.max(...longTasks).toFixed(2)) : null, p95Ms: percentile(longTasks, .95) };
      report.frameMonitor.finishedAt = new Date().toISOString();
      save();
    }
    await type('SOAK_FINAL_DRAFT');
    await until(() => ipc('getState', seed.targets.A), snapshot => snapshot.draft === 'SOAK_FINAL_DRAFT', 'Draft is persisted without switching');
    check('Typing draft persists without a conversation switch', true); await screenshot('02-activity-complete');
    // Clear the delta acknowledgement first so this baseline is a complete snapshot.
    // Otherwise getState may legitimately return transcriptUnchanged without workRuns,
    // leaving the cold-restart identity comparison with an empty expected set.
    await ipc('ackTranscript', seed.targets.A, '');
    const before = await ipc('getState', seed.targets.A); report.preCold = { messageCount: before.totalMessages, runIds: before.workRuns?.map(r => r.runId), usage: before.contextWindow, draft: before.draft };
    report.preCold.drafts = {};
    for (const [name,target] of Object.entries(seed.targets)) report.preCold.drafts[name] = (await ipc('getState', target)).draft;
    const diskState = path.join(root, 'Work', 'User soak fixture', 'conversations', 'state.json');
    fs.copyFileSync(diskState, path.join(evidence, 'state-before-close.json'));
    clearInterval(heartbeatTimer); while (sampleBusy) await sleep(50); await close();
    await launch('cold');
    report.coldArrival = { snapshot: (await ipc('getState', seed.targets.A)).draft, prompt: await evaluate('document.getElementById("prompt").value') };
    check('Cold startup draft is already restored before selecting current conversation', report.coldArrival.snapshot === 'SOAK_FINAL_DRAFT' && report.coldArrival.prompt === 'SOAK_FINAL_DRAFT', report.coldArrival);
    await select('A'); await pageAll('A');
    const coldRendererRuns = await evaluate(`(()=>{const target=currentConversationTarget(),key=runtimeKeyFor(target.workspaceId,target.conversationId);return{target,runIds:(state.workRunsByTarget[key]||[]).map(r=>r.runId)};})()`);
    report.coldRendererWorkRuns = coldRendererRuns;
    check('Cold renderer retains all recorded Build identities', JSON.stringify(coldRendererRuns.runIds) === JSON.stringify(report.preCold.runIds), coldRendererRuns);
    // `getState` may legally return a transcriptUnchanged delta after this
    // renderer acknowledged the exact painted revision. Clear that acknowledgement
    // before inspecting the raw IPC result so omitted workRuns are not mistaken
    // for missing persisted Build records.
    report.coldSnapshotAckCleared = await ipc('ackTranscript', seed.targets.A, '');
    const cold = await ipc('getState', seed.targets.A);
    report.coldWorkRuns = (cold.workRuns || []).map(r => ({ runId: r.runId, status: r.status, prompt: r.primaryPrompt }));
    const coldRunIds = report.coldWorkRuns.map(r => r.runId);
    report.coldSnapshot = { transcriptUnchanged: cold.transcriptUnchanged === true, totalMessages: cold.totalMessages, runIds: coldRunIds };
    check('Cold restart full snapshot keeps all recorded Build identities', cold.transcriptUnchanged !== true && JSON.stringify(coldRunIds) === JSON.stringify(report.preCold.runIds), {
      preColdRunIds: report.preCold.runIds,
      coldRunIds,
      transcriptUnchanged: cold.transcriptUnchanged === true,
      coldWorkRuns: report.coldWorkRuns,
      coldTotalMessages: cold.totalMessages,
    });
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
    await stopDisplayAwakeGuard().catch(error => { report.displayAwakeGuardCleanupError = String(error); });
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => provider.close(resolve)); report.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ passed: report.passed, cycles: report.cycles, activityElapsedSeconds: report.activityElapsedSeconds, evidence, error: report.error, metrics: report.metrics }));
  }
}
main().catch(async error => { console.error(error.stack || error); process.exitCode = 1; if(report){report.passed=false;report.setupError=String(error.stack||error);save();}for(const socket of sockets)socket.destroy();if(provider.listening)await new Promise(resolve=>provider.close(resolve)); });
