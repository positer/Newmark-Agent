const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-28-release-ui-skills-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_SKILLS_SMOKE === '1';

function log(message) {
  console.log(`[release-ui-skills-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitForTarget(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(500);
  }
  fail('Timed out waiting for Electron CDP target');
}

function connectCdp(target) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  function call(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
    });
  }
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const callbacks = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else callbacks.resolve(message.result);
    };
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 15000) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const message = details.exception?.description || details.text || JSON.stringify(details);
    throw new Error(`Runtime.evaluate exception: ${message}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await evaluate(cdp, expression, 10000);
      if (lastValue) return lastValue;
    } catch (error) {
      lastValue = error.message;
    }
    await sleep(300);
  }
  fail(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)}`);
}

async function captureScreenshot(cdp) {
  await cdp.call('Page.bringToFront', {}, 10000);
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  }, 10000).catch(() => undefined);
  await evaluate(cdp, `(() => { window.scrollTo(0, 0); return true; })()`);
  await sleep(300);
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
  if (!screenshot?.data) fail('empty screenshot data');
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  log(`screenshot ${screenshotPath}`);
}

function ensureNoReleaseProcess() {
  const running = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "(@(Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' })).Count",
  ], { encoding: 'utf8', windowsHide: true });
  const count = Number(String(running.stdout || '').trim());
  if (count > 0) {
    spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force; Write-Output 'STOP_RELEASE_PROCESSES_OK'",
    ], { encoding: 'utf8', windowsHide: true });
    log('warning: cleaned packaged Newmark release process residue after smoke');
  }
}

function writeConfig(root) {
  const config = {
    models: { providers: [], default_model: '', default_intelligence: 'low' },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    general: { language: 'en' },
    workspace: {
      prompt_mode: 'both',
      access_permission: 'full_access',
      on_permission_violation: 'deny',
    },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function writeSkillSource(root) {
  const sourceDir = path.join(root, 'local-skill-source');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), [
    '---',
    'name: release-ui-local-skill',
    'description: Deterministic release UI skill management smoke item.',
    '---',
    '# Release UI Local Skill',
    '',
    'Use this skill only for packaged UI skill-management validation.',
    '',
  ].join('\n'), 'utf8');
  return sourceDir.replace(/\\/g, '\\\\');
}

async function runUiCheck(root) {
  const port = Number(process.env.NEWMARK_UI_SKILLS_SMOKE_PORT || '49350');
  const sourceDirForJs = writeSkillSource(root);
  let child;
  let cdp;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, 'ElectronData')}`, '--allow-multiple-instances', '--no-sandbox', '--root', root], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const target = await waitForTarget(port);
    log(`connected target: ${target.title || '(untitled)'} ${target.url || ''}`);
    cdp = connectCdp(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');

    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.api && !!window.showPluginList && !!document.querySelector('#prompt'))()`, 30000, 'renderer ready');

    await evaluate(cdp, `window.showPluginList()`, 30000);
    await waitFor(cdp, `(() => {
      const tabs = Array.from(document.querySelectorAll('.settings-tabs .stab-btn')).map(node => node.textContent.trim());
      return tabs[0] === 'MCP Management' && tabs[1] === 'Skills Management' && !!document.querySelector('#mcp-name');
    })()`, 30000, 'MCP management ordered before Skills');
    const addedMcp = await evaluate(cdp, `window.api.upsertMcpServer({ name:'Release MCP', transport:'stdio', command:'node', args:['server.js'], env:{ MCP_TOKEN:'secret-smoke-value' } })`, 30000);
    if (!addedMcp?.ok) fail(`MCP add failed: ${JSON.stringify(addedMcp)}`);
    await evaluate(cdp, `window.renderMcpManager()`, 30000);
    await waitFor(cdp, `(() => document.querySelector('#plugin-panel')?.innerText.includes('Release MCP'))()`, 30000, 'MCP server visible');
    const mcpSnapshot = await evaluate(cdp, `window.api.listMcpServers()`, 30000);
    const mcpServer = mcpSnapshot?.servers?.find(server => server.name === 'Release MCP');
    if (!mcpServer || JSON.stringify(mcpSnapshot).includes('secret-smoke-value')) fail(`MCP list leaked secret or omitted server: ${JSON.stringify(mcpSnapshot)}`);
    await evaluate(cdp, `window.api.setMcpServerEnabled(${JSON.stringify(String(mcpServer?.id || ''))}, false)`, 30000);
    await evaluate(cdp, `window.api.removeMcpServer(${JSON.stringify(String(mcpServer?.id || ''))})`, 30000);
    log('MCP management CRUD and secret-safe list ok');

    await evaluate(cdp, `(() => {
      window.__ghOverviewProbe = { ticks: 0, startedAt: Date.now(), done: false, result: null, error: '' };
      const timer = setInterval(() => { window.__ghOverviewProbe.ticks++; }, 25);
      window.api.githubOverview().then(result => {
        window.__ghOverviewProbe.result = result;
      }).catch(error => {
        window.__ghOverviewProbe.error = String(error && error.message || error);
      }).finally(() => {
        clearInterval(timer);
        window.__ghOverviewProbe.elapsedMs = Date.now() - window.__ghOverviewProbe.startedAt;
        window.__ghOverviewProbe.done = true;
      });
      return true;
    })()`, 30000);
    await waitFor(cdp, `window.__ghOverviewProbe && window.__ghOverviewProbe.done`, 90000, 'GitHub overview complete without renderer freeze');
    const githubProbe = await evaluate(cdp, `window.__ghOverviewProbe`, 30000);
    if (githubProbe?.error || !githubProbe?.result?.ok) fail(`GitHub overview failed: ${JSON.stringify(githubProbe)}`);
    if (githubProbe.elapsedMs >= 100 && githubProbe.ticks < 2) fail(`GitHub overview blocked renderer heartbeat: ${JSON.stringify(githubProbe)}`);
    const selectedRepo = githubProbe.result.selected || {};
    if (typeof selectedRepo.viewerHasStarred !== 'boolean' || !Number.isFinite(Number(selectedRepo.stargazerCount)) || !Number.isFinite(Number(selectedRepo.forkCount))) {
      fail(`GitHub overview omitted starred/fork information: ${JSON.stringify(selectedRepo)}`);
    }
    await evaluate(cdp, `window.showPluginList('github')`, 30000);
    await waitFor(cdp, `(() => {
      const text = document.querySelector('#gh-overview')?.innerText || '';
      return text.includes('Stars') && text.includes('Forks') && (text.includes('Starred') || text.includes('Not starred'));
    })()`, 90000, 'GitHub starred and fork badges visible');
    log(`GitHub async overview heartbeat ok: ${githubProbe.ticks} ticks in ${githubProbe.elapsedMs} ms`);

    await evaluate(cdp, `window.showPluginList('market')`, 30000);
    await waitFor(cdp, `(() => !!document.querySelector('#skill-market-search') && document.body.innerText.includes('Skills Market'))()`, 30000, 'skills market visible');
    await evaluate(cdp, `window.updateSkillMarketSearch('definitely-no-release-ui-skill-20260628')`, 30000);
    await waitFor(cdp, `(() => {
      const input = document.querySelector('#skill-market-search');
      return input && input.value === 'definitely-no-release-ui-skill-20260628' && document.body.innerText.includes('No matching skills.');
    })()`, 30000, 'skills market search no-match state');
    log('Skills Market search ok');

    const installed = await evaluate(cdp, `window.api.installLocalSkill('${sourceDirForJs}', 'release-ui-local-skill')`, 30000);
    if (!(installed === true || installed?.ok === true)) fail(`installLocalSkill returned ${JSON.stringify(installed)}`);
    await evaluate(cdp, `window.refreshSkillsRuntime(function(){ window.showPluginList('installed'); })`, 30000);
    await waitFor(cdp, `(() => {
      return window.api.listSkills().then(items => items.some(s => s.name === 'release-ui-local-skill' && s.enabled === true));
    })()`, 30000, 'installed skill listed by API');
    await waitFor(cdp, `(() => document.body.innerText.includes('release-ui-local-skill') && document.body.innerText.includes('Disable'))()`, 30000, 'installed skill visible enabled');
    log('local skill install and live refresh ok');

    await evaluate(cdp, `window.toggleSkillEnabled('release-ui-local-skill', false)`, 30000);
    await waitFor(cdp, `(() => {
      return window.api.listSkills().then(items => items.some(s => s.name === 'release-ui-local-skill' && s.enabled === false));
    })()`, 30000, 'skill disabled by API');
    await waitFor(cdp, `(() => document.body.innerText.includes('release-ui-local-skill') && document.body.innerText.includes('Enable'))()`, 30000, 'installed skill visible disabled');
    log('skill disable refresh ok');

    await evaluate(cdp, `window.toggleSkillEnabled('release-ui-local-skill', true)`, 30000);
    await waitFor(cdp, `(() => {
      return window.api.listSkills().then(items => items.some(s => s.name === 'release-ui-local-skill' && s.enabled === true));
    })()`, 30000, 'skill re-enabled by API');
    await waitFor(cdp, `(() => document.body.innerText.includes('release-ui-local-skill') && document.body.innerText.includes('Disable'))()`, 30000, 'installed skill visible re-enabled');
    log('skill enable refresh ok');

    await evaluate(cdp, `window.removeSkillFromUi('release-ui-local-skill')`, 30000);
    await waitFor(cdp, `(() => {
      return window.api.listSkills().then(items => !items.some(s => s.name === 'release-ui-local-skill'));
    })()`, 30000, 'skill removed by API');
    await waitFor(cdp, `(() => {
      const panel = document.querySelector('#plugin-panel');
      return panel && !panel.innerText.includes('release-ui-local-skill');
    })()`, 30000, 'removed skill no longer visible in installed panel');
    log('skill remove refresh ok');

    await evaluate(cdp, `window.showPluginList('market')`, 30000);
    await waitFor(cdp, `(() => !!document.querySelector('#skill-market-search') && document.body.innerText.includes('Skills Market'))()`, 30000, 'market visible after remove');
    await captureScreenshot(cdp);
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    try { if (child && !child.killed) child.kill(); } catch {}
    await sleep(1000);
    ensureNoReleaseProcess();
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkSkillsSmoke-'));
  try {
    writeConfig(root);
    await runUiCheck(root);
    log('all skills release UI smoke checks passed');
  } finally {
    if (keepRoot) log(`kept root: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(`[release-ui-skills-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
