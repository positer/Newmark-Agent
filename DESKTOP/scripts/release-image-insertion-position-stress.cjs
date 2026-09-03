const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createState } = require('../../TUI/src/state');
const { render, stripAnsi, visibleLength } = require('../../TUI/src/render');

const IMAGE_COUNT = 24;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error(message); };

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.setTimeout(1000, () => request.destroy(new Error('CDP discovery timeout')));
    request.on('error', reject);
  });
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function discoverTarget(port, child) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) fail(`Electron exited before CDP discovery: ${child.exitCode}`);
    try {
      const pages = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  fail('CDP target timeout');
}

function connect(page) {
  let id = 0;
  const pending = new Map();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    };
  });
  const call = (method, params = {}, timeoutMs = 90000) => new Promise((resolve, reject) => {
    const current = ++id;
    pending.set(current, { resolve, reject });
    ws.send(JSON.stringify({ id: current, method, params }));
    setTimeout(() => { if (pending.delete(current)) reject(new Error(`timeout ${method}`)); }, timeoutMs);
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 90000) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function capture(cdp, filePath) {
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
  if (fs.statSync(filePath).size < 10000) fail(`screenshot too small: ${filePath}`);
}

function buildTuiRun() {
  const events = [];
  let sequence = 1;
  for (let index = 0; index < IMAGE_COUNT; index++) {
    const number = String(index + 1).padStart(3, '0');
    events.push({ type: 'tool_call', toolName: 'bash', toolCallId: `bash-${number}`, content: `echo checkpoint-${number}`, sequence: sequence++ });
    events.push({ type: 'tool_result', toolName: 'bash', toolCallId: `bash-${number}`, content: `checkpoint-${number} complete`, sequence: sequence++ });
    events.push({ type: 'tool_call', toolName: 'image_display', toolCallId: `image-${number}`, content: `diagram-${number}.png`, sequence: sequence++ });
    events.push({
      type: 'tool_result', toolName: 'image_display', toolCallId: `image-${number}`, content: `displayed-${number}`, sequence: sequence++,
      displayImage: { id: `position-image-${number}`, origin: 'agent', name: `diagram-${number}.png`, caption: `位置示意图 ${number}`, mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    });
    events.push({ type: 'status', content: `POSITION CHECKPOINT ${number}`, sequence: sequence++ });
  }
  events.push({ type: 'final_response', content: 'POSITION STRESS FINAL SUMMARY', sequence: sequence++ });
  return { runId: 'tui-image-position-stress', status: 'completed', sequence: 1, startedAt: '2026-08-01T05:00:00.000Z', endedAt: '2026-08-01T05:00:12.000Z', events };
}

function tuiFixture(expanded, columns, rows, scrollTop = true, selectedImageIndex = -1) {
  const state = createState();
  state.view = 'chat';
  state.focusRegion = 'content';
  state.inputMode = true;
  state.input = '';
  state.messages = [
    { role: 'user', content: 'CHECK IMAGE TOOL INSERTION POSITION', runId: 'tui-image-position-stress' },
    { role: 'assistant', content: 'POSITION STRESS FINAL SUMMARY', runId: 'tui-image-position-stress' },
  ];
  state.snapshot.workRuns = [buildTuiRun()];
  state.expandedBuildRuns = expanded ? new Set(['tui-image-position-stress']) : new Set();
  state.conversationHistoryFocus = selectedImageIndex >= 0;
  state.historySelectedIndex = 0;
  state.historySelectedImageIndex = selectedImageIndex;
  state.conversationScroll = scrollTop ? 100000 : 0;
  const output = stripAnsi(render(state, columns, rows));
  return { output, state };
}

function verifyTui() {
  const large = tuiFixture(true, 160, 220);
  const largeLines = large.output.split('\n');
  for (let index = 0; index < IMAGE_COUNT; index++) {
    const number = String(index + 1).padStart(3, '0');
    const tool = largeLines.findIndex(line => line.includes(`TOOL image_display  diagram-${number}.png`));
    const image = tool + 1;
    const result = tool + 2;
    const progress = tool + 3;
    if (!(tool >= 0 && largeLines[image]?.includes('[示意图]') && largeLines[result]?.includes(`RESULT image_display  displayed-${number}`) && largeLines[progress]?.includes(`POSITION CHECKPOINT ${number}`))) {
      fail(`TUI expanded insertion mismatch at ${number}: ${JSON.stringify({ tool, image: largeLines[image], result: largeLines[result], progress: largeLines[progress] })}`);
    }
  }
  const collapsed = tuiFixture(false, 160, 80);
  const firstBlock = collapsed.output.indexOf('Build Block 1');
  const firstImage = collapsed.output.indexOf('[示意图]');
  const summary = collapsed.output.indexOf('POSITION STRESS FINAL SUMMARY');
  if (!(firstBlock >= 0 && firstBlock < firstImage && firstImage < summary)) fail('TUI collapsed gallery is not at the beginning of the Build overview');
  const expectedPlaceholderCount = IMAGE_COUNT * 2;
  const placeholderCount = (collapsed.output.match(/\[示意图\]/g) || []).length;
  if (placeholderCount !== expectedPlaceholderCount) fail(`TUI collapsed placeholder count mismatch: expected ${expectedPlaceholderCount}, got ${placeholderCount}`);
  if (collapsed.output.lastIndexOf('[示意图]') >= summary) fail('TUI final summary placeholders must appear before the summary text');
  if (/位置示意图|Enter 打开/.test(collapsed.output)) fail('TUI unfocused image rows exposed title or Enter action');
  for (let index = 0; index < IMAGE_COUNT; index++) {
    const number = String(index + 1).padStart(3, '0');
    const focusedAtIndex = tuiFixture(false, 160, 80, true, index).output;
    if ((focusedAtIndex.match(/Enter 打开/g) || []).length !== 1 || !new RegExp(`位置示意图 ${number}.*Enter 打开`).test(focusedAtIndex)) fail(`TUI focused image order mismatch at ${number}`);
  }
  if (/TOOL image_display|RESULT image_display/.test(collapsed.output)) fail('TUI collapsed view leaked expanded tool rows');
  const focused = tuiFixture(false, 160, 80, true, 0);
  if ((focused.output.match(/Enter 打开/g) || []).length !== 1 || !/位置示意图 001.*Enter 打开/.test(focused.output)) fail('TUI focused image row did not exclusively expose the Enter action');
  const sizeReports = [[80,24],[100,30],[120,40],[160,50]].map(([columns, rows]) => {
    const fixture = tuiFixture(false, columns, rows);
    const lines = fixture.output.split('\n');
    const validWidth = lines.every(line => visibleLength(line) === columns);
    if (lines.length !== rows || !validWidth) fail(`TUI ${columns}x${rows} geometry mismatch`);
    return { columns, rows, outputRows: lines.length, validWidth, maxScroll: fixture.state.conversationMaxScroll };
  });
  return {
    imageCount: IMAGE_COUNT,
    expandedOrderMatches: true,
    collapsedOrderMatches: true,
    sizeReports,
    screenshotExpanded: tuiFixture(true, 120, 40, true, 0).output,
    screenshotCollapsed: tuiFixture(false, 120, 40, true, 0).output,
  };
}

(async () => {
  const tui = verifyTui();
  const repoRoot = path.resolve(__dirname, '..', '..');
  const desktopRoot = path.join(repoRoot, 'DESKTOP');
  const archiveRoot = path.join(repoRoot, 'archive');
  const guiExpandedPath = path.join(archiveRoot, '20260801-image-position-gui-expanded.png');
  const guiCollapsedPath = path.join(archiveRoot, '20260801-image-position-gui-collapsed.png');
  const tuiPath = path.join(archiveRoot, '20260801-image-position-tui-expanded-collapsed.png');
  const reportPath = path.join(archiveRoot, '20260801-image-position-stress-report.json');
  const electron = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkImagePositionStress-'));
  const port = await freeTcpPort();
  let child;
  let cdp;
  try {
    child = spawn(electron, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, 'ElectronData')}`, '--no-sandbox', '--root', root], { cwd: desktopRoot, stdio: 'ignore', windowsHide: true });
    cdp = connect(await discoverTarget(port, child));
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(cdp, `typeof window.applyAgentWorkEventToRun === 'function' && !!document.getElementById('chat-area')`)) break;
      await sleep(200);
      if (attempt === 99) fail('renderer initialization timeout');
    }

    const guiCollapsed = await evaluate(cdp, `(async () => {
      const count = ${IMAGE_COUNT};
      const runId = 'gui-image-position-stress-' + Date.now();
      const conversationId = window.activeConversationId();
      let sequence = 1;
      const stable = document.createElement('style');
      stable.textContent = '*{animation:none!important;transition:none!important}.image-position-badge{position:fixed;right:18px;top:62px;z-index:100000;padding:10px 13px;border:1px solid #6366f1;border-radius:9px;background:rgba(10,12,24,.94);color:#eef2ff;font:12px/1.55 ui-monospace,monospace}.image-position-badge strong{color:#a5b4fc}';
      document.head.appendChild(stable);
      function makeImage(index) {
        const canvas = document.createElement('canvas'); canvas.width=300; canvas.height=150;
        const ctx=canvas.getContext('2d'); const hue=(index*59)%360;
        const gradient=ctx.createLinearGradient(0,0,300,150); gradient.addColorStop(0,'hsl('+hue+' 78% 44%)'); gradient.addColorStop(1,'hsl('+((hue+60)%360)+' 72% 20%)');
        ctx.fillStyle=gradient;ctx.fillRect(0,0,300,150);ctx.fillStyle='#fff';ctx.font='700 26px system-ui';ctx.fillText('POSITION '+String(index+1).padStart(3,'0'),18,47);ctx.font='14px ui-monospace,monospace';ctx.fillText('image_display insertion',18,76);
        return {id:'position-image-'+String(index+1).padStart(3,'0'),origin:'agent',name:'diagram-'+String(index+1).padStart(3,'0')+'.png',caption:'位置示意图 '+String(index+1).padStart(3,'0'),mimeType:'image/png',dataUrl:canvas.toDataURL('image/png'),width:300,height:150};
      }
      const send = event => window.applyAgentWorkEventToRun(Object.assign({runId,conversationId,timestamp:new Date().toISOString(),status:'running',sequence:sequence++},event));
      for(let index=0;index<count;index++){
        const number=String(index+1).padStart(3,'0');
        send({id:'bash-call-'+number,type:'tool_call',toolName:'bash',toolCallId:'bash-'+number,toolArgs:'echo checkpoint-'+number});
        send({id:'bash-result-'+number,type:'tool_result',toolName:'bash',toolCallId:'bash-'+number,content:'checkpoint-'+number+' complete'});
        send({id:'image-call-'+number,type:'tool_call',toolName:'image_display',toolCallId:'image-'+number,toolArgs:JSON.stringify({path:'diagram-'+number+'.png'})});
        send({id:'image-result-'+number,type:'tool_result',toolName:'image_display',toolCallId:'image-'+number,content:'displayed-'+number,displayImage:makeImage(index)});
        send({id:'progress-'+number,type:'status',content:'POSITION CHECKPOINT '+number});
        if((index+1)%4===0) await new Promise(resolve=>setTimeout(resolve,0));
      }
      send({id:'done',type:'done',status:'completed',content:'POSITION STRESS COMPLETE'});
      window.renderAgentWorkEvent({
        runId, conversationId, type: 'final_response', content: 'POSITION STRESS FINAL SUMMARY',
        status: 'completed', sequence: sequence++, timestamp: new Date().toISOString()
      });
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const run=document.querySelector('.conversation-work-run[data-run-id="'+runId+'"]');
      const wrapper=run?.closest('.work-run-message');
      if(!wrapper) throw new Error('GUI stress run missing');
      const expected=Array.from({length:count},(_,i)=>'position-image-'+String(i+1).padStart(3,'0'));
      const finalMessage=document.querySelector('.chat-msg.run-final-response[data-run-id="'+runId+'"]');
      const finalBody=finalMessage?.querySelector('.msg-body');
      const finalGallery=finalBody?.querySelector(':scope > .conversation-work-display-images');
      const finalNodes=Array.from(finalGallery?.querySelectorAll('.conversation-work-display-image')||[]);
      const finalIds=finalNodes.map(node=>node.getAttribute('data-display-image-id'));
      const finalText=finalBody?.querySelector('.md-rendered')?.textContent||'';
      const finalResponse={
        count:finalIds.length,
        unique:new Set(finalIds).size,
        orderMatches:finalIds.length===count&&finalIds.every((id,index)=>id===expected[index]),
        galleryBeforeText:!!finalGallery&&!!finalBody&&finalBody.firstElementChild===finalGallery,
        text:finalText
      };
      const stack=wrapper.querySelector(':scope > .work-run-collapsed-images');
      const ids=Array.from(stack.querySelectorAll('.conversation-work-display-image')).map(node=>node.getAttribute('data-display-image-id'));
      const badge=document.createElement('div');badge.className='image-position-badge';badge.innerHTML='<strong>GUI INSERTION POSITION</strong><br>'+count+' images · collapsed order PASS<br>gallery immediately after Build: '+(stack.previousElementSibling===run?'PASS':'FAIL');document.body.appendChild(badge);
      wrapper.scrollIntoView({block:'start'});
      window.__imagePositionStress={runId,wrapper,badge};
      return {count:ids.length,unique:new Set(ids).size,orderMatches:ids.every((id,i)=>id===expected[i]),galleryImmediatelyAfterBuild:stack.previousElementSibling===run,finalResponse};
    })()`);
    if (guiCollapsed.count !== IMAGE_COUNT || guiCollapsed.unique !== IMAGE_COUNT || !guiCollapsed.orderMatches || !guiCollapsed.galleryImmediatelyAfterBuild) fail(`GUI collapsed position mismatch: ${JSON.stringify(guiCollapsed)}`);
    if (guiCollapsed.finalResponse.count !== IMAGE_COUNT || guiCollapsed.finalResponse.unique !== IMAGE_COUNT || !guiCollapsed.finalResponse.orderMatches || !guiCollapsed.finalResponse.galleryBeforeText || guiCollapsed.finalResponse.text !== 'POSITION STRESS FINAL SUMMARY') fail(`GUI final response image placement mismatch: ${JSON.stringify(guiCollapsed.finalResponse)}`);
    await sleep(250);
    await capture(cdp, guiCollapsedPath);

    const guiExpanded = await evaluate(cdp, `(async()=>{
      const wrapper=window.__imagePositionStress.wrapper;
      wrapper.querySelector('.conversation-work-run-head').click();
      await new Promise(resolve=>requestAnimationFrame(resolve));
      wrapper.querySelectorAll('details.conversation-work-activity').forEach(node=>{node.open=true});
      const images=Array.from(wrapper.querySelectorAll('.conversation-work-run .conversation-work-display-image'));
      const placements=images.map((image,index)=>{
        const item=image.closest('.conversation-work-activity-item');
        const label=item?.querySelector('.conversation-work-command-label')?.textContent||'';
        const prior=item?.previousElementSibling?.querySelector('.conversation-work-command-label')?.textContent||'';
        const id=image.getAttribute('data-display-image-id')||'';
        const number=id.slice(-3);
        return {id,label,prior,number,correct:label.includes('image_display')&&prior.includes('bash')&&number===String(index+1).padStart(3,'0')};
      });
      const rowsCorrect=placements.every(item=>item.correct);
      const details=wrapper.querySelectorAll('details.conversation-work-activity');
      let stable=true;
      for(let cycle=0;cycle<20;cycle++){
        wrapper.querySelector('.conversation-work-run-head').click();
        const collapsed=wrapper.querySelector('.conversation-work-run').classList.contains('collapsed');
        const count=collapsed?wrapper.querySelectorAll(':scope > .work-run-collapsed-images .conversation-work-display-image').length:wrapper.querySelectorAll('.conversation-work-run .conversation-work-display-image').length;
        if(count!==${IMAGE_COUNT})stable=false;
      }
      if(wrapper.querySelector('.conversation-work-run').classList.contains('collapsed'))wrapper.querySelector('.conversation-work-run-head').click();
      wrapper.querySelectorAll('details.conversation-work-activity').forEach(node=>{node.open=true});
      wrapper.scrollIntoView({block:'start'});
      window.__imagePositionStress.badge.innerHTML='<strong>GUI INSERTION POSITION</strong><br>${IMAGE_COUNT} images · own tool row PASS<br>prior Bash pairing PASS · 20 toggles PASS';
      return {count:images.length,rowsCorrect,groups:details.length,toggleStable:stable,placementFailures:placements.filter(item=>!item.correct).slice(0,5)};
    })()`);
    if (guiExpanded.count !== IMAGE_COUNT || !guiExpanded.rowsCorrect || guiExpanded.groups !== IMAGE_COUNT || !guiExpanded.toggleStable) fail(`GUI expanded position mismatch: ${JSON.stringify(guiExpanded)}`);
    await sleep(250);
    await capture(cdp, guiExpandedPath);

    await evaluate(cdp, `(() => {
      const expanded=${JSON.stringify(tui.screenshotExpanded)};
      const collapsed=${JSON.stringify(tui.screenshotCollapsed)};
      document.body.innerHTML='';document.documentElement.style.background='#090b18';document.body.style.cssText='margin:0;background:#090b18;color:#dbe4ff;overflow:hidden';
      const title=document.createElement('div');title.textContent='TUI IMAGE INSERTION POSITION · 24 interleaved images · PASS';title.style.cssText='padding:14px 18px;background:#11152a;color:#a5b4fc;font:700 15px ui-monospace,monospace';document.body.appendChild(title);
      const grid=document.createElement('div');grid.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px;height:calc(100vh - 68px)';document.body.appendChild(grid);
      for(const [label,text] of [['EXPANDED · image follows own tool call',expanded],['COLLAPSED · gallery starts after Build header',collapsed]]){const panel=document.createElement('section');panel.style.cssText='min-width:0;overflow:hidden;border:1px solid #30375f;border-radius:8px;background:#0b0e1d';const heading=document.createElement('div');heading.textContent=label;heading.style.cssText='padding:8px 10px;color:#8be9fd;border-bottom:1px solid #30375f;font:12px ui-monospace,monospace';const pre=document.createElement('pre');pre.textContent=text;pre.style.cssText='margin:0;padding:10px;font:10px/1.25 Consolas,monospace;white-space:pre;transform-origin:top left';panel.append(heading,pre);grid.appendChild(panel);}
      return true;
    })()`);
    await sleep(150);
    await capture(cdp, tuiPath);

    const finalReport = { verdict: 'PASS', imageCount: IMAGE_COUNT, gui: { collapsed: guiCollapsed, expanded: guiExpanded }, tui: { expandedOrderMatches: tui.expandedOrderMatches, collapsedOrderMatches: tui.collapsedOrderMatches, focusHintExclusive: true, sizeReports: tui.sizeReports }, screenshots: { guiExpandedPath, guiCollapsedPath, tuiPath } };
    fs.writeFileSync(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`);
    console.log(`[release-image-insertion-position-stress] PASS ${JSON.stringify(finalReport)}`);
  } finally {
    try { cdp?.ws.close(); } catch {}
    if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    for (let attempt = 0; attempt < 6; attempt++) {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); if (!fs.existsSync(root)) break; } catch {}
      await sleep(250);
    }
  }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
