const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const IMAGE_COUNT = Math.max(1, Number(process.env.NEWMARK_IMAGE_STRESS_COUNT || 120));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error(message); };

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
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
  let lastPages = [];
  let lastError = '';
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) fail(`Electron exited before CDP target discovery: ${child.exitCode}`);
    try {
      const pages = await getJson(`http://127.0.0.1:${port}/json/list`);
      lastPages = pages.map(page => String(page.url || ''));
      const page = pages.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (page) return page;
    } catch (error) {
      lastError = String(error?.message || error);
    }
    await sleep(300);
  }
  fail(`CDP target timeout pages=${JSON.stringify(lastPages)} error=${lastError}`);
}

function connect(page) {
  let id = 0;
  const pending = new Map();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const opened = new Promise((resolve, reject) => {
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
  const ready = Promise.race([
    opened,
    new Promise((_, reject) => setTimeout(() => reject(new Error('CDP websocket timeout')), 10000)),
  ]);
  const call = (method, params = {}, timeoutMs = 180000) => new Promise((resolve, reject) => {
    const current = ++id;
    pending.set(current, { resolve, reject });
    ws.send(JSON.stringify({ id: current, method, params }));
    setTimeout(() => {
      if (pending.delete(current)) reject(new Error(`timeout ${method}`));
    }, timeoutMs);
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 180000) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function capture(cdp, targetPath) {
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(shot.data, 'base64'));
  const size = fs.statSync(targetPath).size;
  if (size < 10000) fail(`screenshot too small: ${targetPath} (${size} bytes)`);
  return size;
}

(async () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const desktopRoot = path.join(repoRoot, 'DESKTOP');
  const electron = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkImageDisplayStress-'));
  const archiveRoot = path.join(repoRoot, 'archive');
  const expandedScreenshot = path.join(archiveRoot, '20260801-image-display-stress-expanded.png');
  const collapsedScreenshot = path.join(archiveRoot, '20260801-image-display-stress-collapsed.png');
  const overviewScreenshot = path.join(archiveRoot, '20260801-image-display-stress-overview.png');
  const reportPath = path.join(archiveRoot, '20260801-image-display-stress-report.json');
  const port = await freeTcpPort();
  let child;
  let cdp;
  try {
    child = spawn(electron, [
      '.',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(testRoot, 'ElectronData')}`,
      '--no-sandbox',
      '--root', testRoot,
    ], {
      cwd: desktopRoot,
      stdio: process.env.NEWMARK_SMOKE_DEBUG === '1' ? 'inherit' : 'ignore',
      windowsHide: true,
    });
    cdp = connect(await discoverTarget(port, child));
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(cdp, `typeof window.applyAgentWorkEventToRun === 'function' && !!window.state && !!document.getElementById('chat-area')`)) break;
      await sleep(200);
      if (attempt === 99) fail('renderer init timeout');
    }

    const report = await evaluate(cdp, `(async () => {
      const imageCount = ${IMAGE_COUNT};
      const runId = 'image-display-stress-' + Date.now();
      const conversationId = window.activeConversationId();
      const startedAt = new Date().toISOString();
      const chat = document.getElementById('chat-area');
      const stableStyle = document.createElement('style');
      stableStyle.id = 'image-display-stress-style';
      stableStyle.textContent = '*{animation:none!important;transition:none!important}.image-display-stress-metrics{position:fixed;z-index:100000;right:18px;top:62px;width:285px;padding:12px 14px;border:1px solid rgba(99,102,241,.7);border-radius:10px;background:rgba(11,15,26,.94);box-shadow:0 12px 40px rgba(0,0,0,.35);color:#eef2ff;font:12px/1.55 ui-monospace,monospace}.image-display-stress-metrics strong{display:block;color:#a5b4fc;font-size:14px;margin-bottom:4px}';
      document.head.appendChild(stableStyle);

      const longTasks = [];
      let observer = null;
      if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        observer = new PerformanceObserver(list => list.getEntries().forEach(entry => longTasks.push(entry.duration)));
        observer.observe({ entryTypes: ['longtask'] });
      }
      let frames = 0;
      let frameActive = true;
      const tickFrame = () => { if (frameActive) { frames++; requestAnimationFrame(tickFrame); } };
      requestAnimationFrame(tickFrame);
      const heapBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
      const encodedBytes = [];
      const updateDurations = [];
      const overallStart = performance.now();

      function makeImage(index) {
        const sizes = [[320,180],[400,225],[480,270],[360,240]];
        const size = sizes[index % sizes.length];
        const canvas = document.createElement('canvas');
        canvas.width = size[0];
        canvas.height = size[1];
        const ctx = canvas.getContext('2d');
        const hue = (index * 47) % 360;
        const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, 'hsl(' + hue + ' 78% 42%)');
        gradient.addColorStop(1, 'hsl(' + ((hue + 70) % 360) + ' 72% 18%)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = 'rgba(255,255,255,.28)';
        ctx.lineWidth = 2;
        for (let x = 0; x < canvas.width; x += 48) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(canvas.width-x,canvas.height); ctx.stroke(); }
        ctx.fillStyle = '#fff';
        ctx.font = '700 28px system-ui';
        ctx.fillText('IMAGE ' + String(index + 1).padStart(3, '0'), 22, 48);
        ctx.font = '13px ui-monospace,monospace';
        ctx.fillText(size[0] + ' x ' + size[1] + '  |  Newmark batch return', 24, 72);
        ctx.fillStyle = 'rgba(255,255,255,.9)';
        for (let row = 0; row < 5; row++) ctx.fillRect(24, 96 + row * 25, Math.max(45, canvas.width - 55 - ((index * 23 + row * 31) % 130)), 6);
        const dataUrl = canvas.toDataURL('image/png');
        encodedBytes.push(Math.ceil((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4));
        return {
          id: 'stress-image-' + String(index + 1).padStart(3, '0'),
          origin: 'agent',
          name: '批量示意图 ' + String(index + 1).padStart(3, '0') + '.png',
          caption: '连续回传 ' + String(index + 1).padStart(3, '0') + ' / ' + imageCount,
          mimeType: 'image/png',
          dataUrl,
          width: size[0],
          height: size[1],
        };
      }

      for (let index = 0; index < imageCount; index++) {
        const toolCallId = 'image-call-' + String(index + 1).padStart(3, '0');
        const sequence = index * 2 + 1;
        let updateStart = performance.now();
        window.applyAgentWorkEventToRun({
          id: 'stress-call-' + index,
          runId,
          type: 'tool_call',
          toolName: 'image_display',
          toolCallId,
          toolArgs: JSON.stringify({ path: 'stress/generated-' + String(index + 1).padStart(3, '0') + '.png' }),
          status: 'running',
          sequence,
          conversationId,
          timestamp: new Date().toISOString(),
        });
        updateDurations.push(performance.now() - updateStart);
        const image = makeImage(index);
        updateStart = performance.now();
        window.applyAgentWorkEventToRun({
          id: 'stress-result-' + index,
          runId,
          type: 'tool_result',
          toolName: 'image_display',
          toolCallId,
          content: image.caption,
          displayImage: image,
          status: 'running',
          sequence: sequence + 1,
          conversationId,
          timestamp: new Date().toISOString(),
        });
        updateDurations.push(performance.now() - updateStart);
        if ((index + 1) % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      window.applyAgentWorkEventToRun({
        id: 'stress-done', runId, type: 'done', status: 'completed', sequence: imageCount * 2 + 1,
        conversationId, timestamp: new Date().toISOString(), content: imageCount + ' images returned',
      });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      frameActive = false;
      observer?.disconnect();
      const totalMs = performance.now() - overallStart;
      const heapAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
      const wrapper = chat.querySelector('.conversation-work-run[data-run-id="' + runId + '"]')?.closest('.work-run-message');
      if (!wrapper) throw new Error('stress work run was not rendered');
      wrapper.scrollIntoView({ block: 'start' });
      const collapsedNodes = Array.from(wrapper.querySelectorAll(':scope > .work-run-collapsed-images .conversation-work-display-image'));
      const collapsedIds = collapsedNodes.map(node => node.getAttribute('data-display-image-id'));
      const expectedIds = Array.from({ length: imageCount }, (_, i) => 'stress-image-' + String(i + 1).padStart(3, '0'));
      const sortedUpdates = updateDurations.slice().sort((a,b) => a-b);
      const percentile = value => sortedUpdates[Math.min(sortedUpdates.length - 1, Math.floor(sortedUpdates.length * value))] || 0;
      const result = {
        imageCount,
        runId,
        elapsedMs: Number(totalMs.toFixed(1)),
        updates: updateDurations.length,
        meanUpdateMs: Number((updateDurations.reduce((sum,value) => sum + value, 0) / updateDurations.length).toFixed(2)),
        p95UpdateMs: Number(percentile(.95).toFixed(2)),
        maxUpdateMs: Number(Math.max(...updateDurations).toFixed(2)),
        renderedFrames: frames,
        longTaskCount: longTasks.length,
        maxLongTaskMs: Number((longTasks.length ? Math.max(...longTasks) : 0).toFixed(2)),
        encodedBytes: encodedBytes.reduce((sum,value) => sum + value, 0),
        meanEncodedBytes: Math.round(encodedBytes.reduce((sum,value) => sum + value, 0) / encodedBytes.length),
        heapBefore,
        heapAfter,
        heapDelta: heapBefore !== null && heapAfter !== null ? heapAfter - heapBefore : null,
        domNodeCount: document.getElementsByTagName('*').length,
        collapsedImageCount: collapsedNodes.length,
        uniqueImageCount: new Set(collapsedIds).size,
        collapsedOrderMatches: collapsedIds.length === expectedIds.length && collapsedIds.every((id,index) => id === expectedIds[index]),
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      const metrics = document.createElement('div');
      metrics.className = 'image-display-stress-metrics';
      metrics.innerHTML = '<strong>IMAGE RETURN STRESS</strong>' +
        '<div>' + result.imageCount + ' target / ' + result.imageCount + ' rendered</div>' +
        '<div>' + result.uniqueImageCount + ' unique · order ' + (result.collapsedOrderMatches ? 'PASS' : 'FAIL') + '</div>' +
        '<div>' + result.elapsedMs + ' ms total · p95 ' + result.p95UpdateMs + ' ms</div>' +
        '<div>' + (result.encodedBytes / 1048576).toFixed(2) + ' MiB PNG payload</div>' +
        '<div>long tasks ' + result.longTaskCount + ' · frames ' + result.renderedFrames + '</div>';
      document.body.appendChild(metrics);
      window.__imageDisplayStress = { report: result, runId, wrapper };
      return result;
    })()`);

    if (report.imageCount !== IMAGE_COUNT || report.collapsedImageCount !== IMAGE_COUNT || report.uniqueImageCount !== IMAGE_COUNT) {
      fail(`image count mismatch: ${JSON.stringify(report)}`);
    }
    if (!report.collapsedOrderMatches) fail(`collapsed image order mismatch: ${JSON.stringify(report)}`);

    const collapsedBytes = await capture(cdp, collapsedScreenshot);
    const expandedState = await evaluate(cdp, `(() => {
      const wrapper = window.__imageDisplayStress.wrapper;
      wrapper.querySelector('.conversation-work-run-head').click();
      const details = wrapper.querySelector('details.conversation-work-activity');
      if (details) details.open = true;
      wrapper.scrollIntoView({ block: 'start' });
      const nodes = Array.from(wrapper.querySelectorAll('.conversation-work-run .conversation-work-display-image'));
      return { count: nodes.length, first: nodes[0]?.getAttribute('data-display-image-id'), last: nodes.at(-1)?.getAttribute('data-display-image-id'), detailsOpen: !!details?.open };
    })()`);
    await sleep(300);
    if (expandedState.count !== IMAGE_COUNT || !expandedState.detailsOpen) fail(`expanded render mismatch: ${JSON.stringify(expandedState)}`);
    const expandedBytes = await capture(cdp, expandedScreenshot);

    await evaluate(cdp, `(() => {
      const wrapper = window.__imageDisplayStress.wrapper;
      wrapper.querySelector('.conversation-work-run-head').click();
      document.body.style.zoom = '.34';
      wrapper.scrollIntoView({ block: 'start' });
      return true;
    })()`);
    await sleep(350);
    const overviewBytes = await capture(cdp, overviewScreenshot);

    const finalReport = {
      ...report,
      expandedState,
      screenshots: {
        expanded: { path: expandedScreenshot, bytes: expandedBytes },
        collapsed: { path: collapsedScreenshot, bytes: collapsedBytes },
        overview: { path: overviewScreenshot, bytes: overviewBytes, zoom: 0.34 },
      },
      verdict: 'PASS',
    };
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`);
    console.log(`[release-ui-image-display-stress] PASS ${JSON.stringify(finalReport)}`);
  } finally {
    try { cdp?.ws.close(); } catch {}
    if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        if (!fs.existsSync(testRoot)) break;
      } catch {}
      await sleep(300);
    }
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
