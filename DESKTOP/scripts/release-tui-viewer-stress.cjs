const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const WAVES = Math.max(1, Number(process.env.NEWMARK_VIEWER_STRESS_WAVES || 5));
const PER_TYPE_PER_WAVE = Math.max(1, Number(process.env.NEWMARK_VIEWER_STRESS_PER_TYPE || 3));
function fixtureImageDataUrl() {
  const png = new PNG({ width: 300, height: 150 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4;
      const stripe = Math.floor((x + y) / 24) % 2;
      png.data[offset] = stripe ? 92 : 31;
      png.data[offset + 1] = Math.round(70 + 150 * x / png.width);
      png.data[offset + 2] = Math.round(210 - 115 * y / png.height);
      png.data[offset + 3] = 255;
    }
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}
const FIXTURE_IMAGE = fixtureImageDataUrl();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error(message); };

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.setTimeout(800, () => request.destroy(new Error('CDP discovery timeout')));
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
  for (let attempt = 0; attempt < 160; attempt++) {
    if (child.exitCode !== null) fail(`viewer exited before CDP discovery: ${child.exitCode}`);
    try {
      const pages = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find(item => item.webSocketDebuggerUrl && String(item.url || '').startsWith('data:text/html'));
      if (page) return page;
    } catch {}
    await sleep(125);
  }
  fail(`viewer CDP target timeout on ${port}`);
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
  const call = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const current = ++id;
    pending.set(current, { resolve, reject });
    ws.send(JSON.stringify({ id: current, method, params }));
    setTimeout(() => { if (pending.delete(current)) reject(new Error(`timeout ${method}`)); }, timeoutMs);
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function capture(cdp, filePath) {
  await cdp.call('Page.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 760, height: 600, deviceScaleFactor: 1, mobile: false });
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
  if (fs.statSync(filePath).size < 2500) fail(`viewer screenshot too small: ${filePath}`);
}

function memorySnapshot(wave, index) {
  const tags = {};
  const components = {};
  for (let node = 0; node < 18; node++) {
    const tag = `#wave-${wave}-tag-${node}`;
    const slug = `component-${wave}-${index}-${node}`;
    tags[tag] = { parents: node ? [`#wave-${wave}-tag-${node - 1}`] : [], children: node < 17 ? [`#wave-${wave}-tag-${node + 1}`] : [], components: [slug] };
    components[slug] = { name: `Memory component ${wave}.${index}.${node}`, description: 'viewer stress fixture', tags: [tag] };
  }
  return { index: { tags, components }, relationshipVersion: `stress-${wave}-${index}` };
}

(async () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const desktopRoot = path.join(repoRoot, 'DESKTOP');
  const electron = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkTuiViewerStress-'));
  const requestRoot = path.join(testRoot, 'viewer-requests');
  const archiveRoot = path.join(repoRoot, 'archive');
  const imageScreenshot = path.join(archiveRoot, '20260801-tui-image-viewer-stress.png');
  const memoryScreenshot = path.join(archiveRoot, '20260801-tui-memory-overview-viewer-stress.png');
  const reportPath = path.join(archiveRoot, '20260801-tui-viewer-stress-report.json');
  fs.mkdirSync(requestRoot, { recursive: true });
  const allRecords = [];
  const activeLaunches = [];
  let peakConcurrent = 0;
  try {
    for (let wave = 0; wave < WAVES; wave++) {
      const launches = [];
      for (const type of ['image', 'memory-overview']) {
        for (let index = 0; index < PER_TYPE_PER_WAVE; index++) {
          const ordinal = wave * PER_TYPE_PER_WAVE + index + 1;
          const title = type === 'image' ? `TUI 图片弹窗 ${String(ordinal).padStart(2, '0')}` : `Memory Lab Overview ${String(ordinal).padStart(2, '0')}`;
          const request = type === 'image'
            ? { type, title, dataUrl: FIXTURE_IMAGE }
            : { type, title, snapshot: memorySnapshot(wave, index) };
          const requestPath = path.join(requestRoot, `viewer-${wave}-${type}-${index}.json`);
          fs.writeFileSync(requestPath, JSON.stringify(request), { encoding: 'utf8', flag: 'wx' });
          const port = await freeTcpPort();
          const startedAt = performance.now();
          const child = spawn(electron, ['.', '--newmark-viewer', `--viewer-request=${requestPath}`, `--root=${testRoot}`, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(testRoot, `profile-${wave}-${type}-${index}`)}`, '--no-sandbox'], { cwd: desktopRoot, stdio: 'ignore', windowsHide: true });
          launches.push({ wave, index, type, title, requestPath, port, child, startedAt, cdp: null });
          activeLaunches.push(launches.at(-1));
        }
      }
      peakConcurrent = Math.max(peakConcurrent, launches.length);
      await Promise.all(launches.map(async launch => {
        const page = await discoverTarget(launch.port, launch.child);
        launch.cdp = connect(page);
        await launch.cdp.ready;
        await launch.cdp.call('Runtime.enable');
        for (let attempt = 0; attempt < 80; attempt++) {
          if (await evaluate(launch.cdp, `document.readyState === 'complete' && !!document.body && !!document.querySelector('header')`)) break;
          await sleep(50);
          if (attempt === 79) fail(`viewer DOM ready timeout: ${launch.title}`);
        }
        const observed = await evaluate(launch.cdp, `(() => ({
          title: document.title,
          header: document.querySelector('header')?.textContent || '',
          imageCount: document.querySelectorAll('img').length,
          svgCount: document.querySelectorAll('svg[aria-label="Memory Lab Overview"]').length,
          circleCount: document.querySelectorAll('svg circle').length,
          mainCount: document.querySelectorAll('main').length,
          sectionCount: document.querySelectorAll('section').length,
          forbiddenShell: !!document.querySelector('#app,#center-stack,#left-nav,#editor-grid,.memory-detail'),
          bodyText: document.body?.textContent || ''
        }))()`);
        const isImage = launch.type === 'image';
        const valid = observed.title === launch.title && observed.header === launch.title
          && observed.mainCount === 1 && observed.sectionCount === 1 && !observed.forbiddenShell
          && (isImage ? observed.imageCount === 1 && observed.svgCount === 0 : observed.imageCount === 0 && observed.svgCount === 1 && observed.circleCount === 36)
          && !/Detail|Editor|Conversations|Settings/.test(observed.bodyText.replace(launch.title, ''));
        if (!valid) fail(`viewer isolation mismatch: ${JSON.stringify({ launch: { type: launch.type, title: launch.title }, observed })}`);
        if (fs.existsSync(launch.requestPath)) fail(`one-use viewer request was not consumed: ${launch.requestPath}`);
        if (wave === 0 && launch.index === 0 && launch.type === 'image') await capture(launch.cdp, imageScreenshot);
        if (wave === 0 && launch.index === 0 && launch.type === 'memory-overview') await capture(launch.cdp, memoryScreenshot);
        allRecords.push({ wave, index: launch.index, type: launch.type, title: launch.title, startupMs: Number((performance.now() - launch.startedAt).toFixed(1)), valid, requestConsumed: true });
      }));
      for (const launch of launches) {
        try { launch.cdp?.ws.close(); } catch {}
        if (launch.child.pid) spawnSync('taskkill.exe', ['/PID', String(launch.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
      }
      await sleep(250);
      const survivors = launches.filter(launch => launch.child.exitCode === null && launch.child.pid);
      for (const launch of survivors) {
        try { process.kill(launch.child.pid, 0); fail(`viewer process survived cleanup: ${launch.child.pid}`); } catch (error) { if (String(error?.message || '').includes('survived cleanup')) throw error; }
      }
      activeLaunches.length = 0;
    }
    const imageRecords = allRecords.filter(record => record.type === 'image');
    const memoryRecords = allRecords.filter(record => record.type === 'memory-overview');
    const sorted = allRecords.map(record => record.startupMs).sort((a, b) => a - b);
    const report = {
      verdict: 'PASS', waves: WAVES, perTypePerWave: PER_TYPE_PER_WAVE, totalWindows: allRecords.length,
      imageWindows: imageRecords.length, memoryOverviewWindows: memoryRecords.length, peakConcurrent,
      failures: allRecords.filter(record => !record.valid).length,
      startupMs: { p50: sorted[Math.floor(sorted.length * .5)] || 0, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] || 0, max: sorted.at(-1) || 0 },
      allRequestsConsumed: !fs.readdirSync(requestRoot).some(name => name.endsWith('.json')),
      screenshots: { imageScreenshot, memoryScreenshot }, records: allRecords,
    };
    if (!report.allRequestsConsumed) fail('viewer request files remain after stress');
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[release-tui-viewer-stress] PASS ${JSON.stringify({ ...report, records: undefined })}`);
  } finally {
    for (const launch of activeLaunches) {
      try { launch.cdp?.ws.close(); } catch {}
      if (launch.child?.pid) spawnSync('taskkill.exe', ['/PID', String(launch.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    }
    try { fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); } catch {}
  }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
