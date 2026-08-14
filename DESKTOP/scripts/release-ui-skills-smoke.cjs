const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const dshScreenshotPath = path.join(repoRoot, 'archive', '20260813-release-ui-dsh-plugin-smoke.png');
const mcpScreenshotPath = path.join(repoRoot, 'archive', '20260813-release-ui-mcp-management-smoke.png');
const skillsScreenshotPath = path.join(repoRoot, 'archive', '20260813-release-ui-skills-smoke.png');
const keyboardScreenshotPath = path.join(repoRoot, 'archive', '20260813-release-ui-keyboard-command-palette-smoke.png');
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

async function captureScreenshot(cdp, screenshotPath) {
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

function writeDshFixture(root) {
  const dshHome = path.join(root, 'DshHome');
  const profile = path.join(dshHome, 'profiles', 'release-preview');
  const bundle = path.join(profile, 'node_modules', 'release-dsh-bundle');
  const marker = path.join(root, 'DSH-PLUGIN-EXECUTED.txt');
  const secret = 'dsh-ui-secret-must-not-render';
  fs.mkdirSync(bundle, { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.ui-smoke' }, null, 2), 'utf8');
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'release-preview',
    futureProfileField: { secret },
    dsh: { profile: { bundles: ['release-dsh-bundle', 'missing-future-bundle'], futureProfileKey: true } },
    dependencies: { 'release-dsh-bundle': '1.0.0', 'missing-future-bundle': 'next' },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({
    name: 'release-dsh-bundle',
    version: '1.0.0-preview',
    main: 'malicious.js',
    dsh: { bundle: { patch: 'cordis.patch.yml', futureBundleKey: true } },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(bundle, 'malicious.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`, 'utf8');
  fs.writeFileSync(path.join(bundle, 'cordis.patch.yml'), [
    '- id: release-mcp',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: DSH Release MCP',
    '    transport: stdio',
    '    command: npx',
    "    args: ['-y', '@modelcontextprotocol/server-release']",
    '    env:',
    '      RELEASE_DSH_TOKEN: !!js process.env.RELEASE_DSH_TOKEN',
    '',
  ].join('\n'), 'utf8');
  return { dshHome, marker, secret };
}

async function runUiCheck(root) {
  const port = Number(process.env.NEWMARK_UI_SKILLS_SMOKE_PORT || '49350');
  const sourceDirForJs = writeSkillSource(root);
  const dshFixture = writeDshFixture(root);
  let child;
  let cdp;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, 'ElectronData')}`, '--allow-multiple-instances', '--no-sandbox', '--root', root], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, DSH_HOME: dshFixture.dshHome },
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

    const keyboardManifest = await evaluate(cdp, `window.getGuiCommandManifest && window.getGuiCommandManifest()`, 30000);
    if (!keyboardManifest || keyboardManifest.schemaVersion !== 1 || !/^fnv1a-[0-9a-f]{8}$/.test(String(keyboardManifest.revision || '')) || keyboardManifest.commands.length < 50 || keyboardManifest.errors.length) {
      fail(`invalid GUI command manifest: ${JSON.stringify(keyboardManifest)}`);
    }
    if (await evaluate(cdp, `document.documentElement.dataset.keyboardRegistry !== window.getGuiCommandManifest().revision`)) fail('GUI command registry was not initialized with its stable revision');
    await evaluate(cdp, `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key:'p', code:'KeyP', ctrlKey:true, shiftKey:true, bubbles:true, cancelable:true }));
      return true;
    })()`, 30000);
    await waitFor(cdp, `window.commandSurfaceIsOpen() && document.activeElement?.id === 'command-search'`, 30000, 'command palette opens from Ctrl+Shift+P and receives focus');
    await evaluate(cdp, `(() => {
      const input = document.querySelector('#command-search');
      input.value = 'DSH';
      input.dispatchEvent(new Event('input', { bubbles:true }));
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => {
      const options = [...document.querySelectorAll('#command-list .command-option')];
      return options.length === 1 && options[0].querySelector('.command-option-title')?.innerText.includes('DSH');
    })()`, 30000, 'command palette filters to the unambiguous DSH command');
    await captureScreenshot(cdp, keyboardScreenshotPath);
    await evaluate(cdp, `document.querySelector('#command-search').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }))`, 30000);
    await waitFor(cdp, `window.state?.pluginActiveTab === 'dsh' && document.querySelector('#plugin-tab-dsh')?.getAttribute('aria-selected') === 'true'`, 30000, 'keyboard command opens DSH plugin tab');
    await evaluate(cdp, `window.closeSubWin()`, 30000);
    await evaluate(cdp, `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key:'F1', code:'F1', bubbles:true, cancelable:true }));
      return true;
    })()`, 30000);
    await waitFor(cdp, `window.commandSurfaceIsOpen() && document.querySelector('#command-surface-title')?.innerText.includes('Keyboard')`, 30000, 'F1 opens keyboard help');
    await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', code:'Escape', bubbles:true, cancelable:true }))`, 30000);
    await waitFor(cdp, `!window.commandSurfaceIsOpen()`, 30000, 'Escape closes keyboard help');
    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      window.__imeSubmitProbe = 0;
      const prior = window.submitCurrentAction;
      window.submitCurrentAction = () => { window.__imeSubmitProbe++; };
      prompt.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', isComposing:true, bubbles:true, cancelable:true }));
      window.submitCurrentAction = prior;
      return true;
    })()`, 30000);
    if (await evaluate(cdp, `window.__imeSubmitProbe !== 0`)) fail('IME composition Enter submitted the prompt');
    log(`GUI keyboard manifest, command palette, F1 help, focus, and IME guard ok (${keyboardManifest.revision}, ${keyboardManifest.commands.length} commands)`);

    await evaluate(cdp, `window.showPluginList('mcp')`, 30000);
    await sleep(1000);
    const initialPluginState = await evaluate(cdp, `(() => ({
      tabs: Array.from(document.querySelectorAll('.settings-tabs .stab-btn')).map(node => node.textContent.trim()),
      activeTab: window.state && window.state.pluginActiveTab,
      activeView: window.state && window.state.activeSubWindowView,
      hasMcpAdd: !!document.querySelector('#mcp-add'),
      panelText: (document.querySelector('#plugin-panel')?.innerText || '').slice(0, 500),
    }))()`, 30000);
    log(`initial plugin state: ${JSON.stringify(initialPluginState)}`);
    await waitFor(cdp, `(() => {
      const tabs = Array.from(document.querySelectorAll('.settings-tabs .stab-btn')).map(node => node.textContent.trim());
      return JSON.stringify(tabs) === JSON.stringify(['MCP','DSH Plugin','Skills','Market','GitHub']) && !!document.querySelector('#mcp-add') && !document.querySelector('#mcp-form');
    })()`, 30000, 'MCP, DSH, Skills, Market, and GitHub tab order');

    await evaluate(cdp, `document.querySelector('#mcp-add').click()`, 30000);
    await waitFor(cdp, `!!document.querySelector('#mcp-form') && document.querySelector('#mcp-enabled').checked === false`, 30000, 'disabled-by-default MCP add form');
    await evaluate(cdp, `(() => {
      document.querySelector('#mcp-name').value = 'Release MCP';
      document.querySelector('#mcp-command').value = 'node';
      document.querySelector('#mcp-args').value = '["server.js"]';
      document.querySelector('#mcp-env').value = '{"MCP_TOKEN":"secret-smoke-value"}';
      document.querySelector('#mcp-save').click();
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => document.querySelector('#plugin-panel')?.innerText.includes('Release MCP'))()`, 30000, 'MCP server visible');
    const mcpSnapshot = await evaluate(cdp, `window.api.listMcpServers()`, 30000);
    const mcpServer = mcpSnapshot?.servers?.find(server => server.name === 'Release MCP');
    if (!mcpServer || mcpServer.enabled !== false || JSON.stringify(mcpSnapshot).includes('secret-smoke-value')) fail(`MCP list leaked secret, enabled an unreviewed server, or omitted it: ${JSON.stringify(mcpSnapshot)}`);
    await evaluate(cdp, `(() => {
      const row = Array.from(document.querySelectorAll('[data-mcp-index]')).find(node => node.innerText.includes('Release MCP'));
      row.querySelector('.mcp-row-actions button').click();
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => document.querySelector('#mcp-form')?.innerText.includes('MCP_TOKEN') && document.querySelector('#mcp-env').value === '')()`, 30000, 'saved secret key names shown without values');
    if (await evaluate(cdp, `document.body.innerText.includes('secret-smoke-value')`)) fail('MCP secret rendered in the packaged DOM');
    await evaluate(cdp, `document.querySelector('#mcp-cancel').click()`, 30000);
    await captureScreenshot(cdp, mcpScreenshotPath);
    await evaluate(cdp, `(() => {
      const row = Array.from(document.querySelectorAll('[data-mcp-index]')).find(node => node.innerText.includes('Release MCP'));
      row.querySelectorAll('.mcp-row-actions button')[1].click();
      return true;
    })()`, 30000);
    await waitFor(cdp, `window.api.listMcpServers().then(result => result.servers.some(server => server.name === 'Release MCP' && server.enabled === true))`, 30000, 'MCP enabled through real row action');
    await evaluate(cdp, `(() => {
      window.confirm = () => true;
      const row = Array.from(document.querySelectorAll('[data-mcp-index]')).find(node => node.innerText.includes('Release MCP'));
      row.querySelectorAll('.mcp-row-actions button')[2].click();
      return true;
    })()`, 30000);
    await waitFor(cdp, `window.api.listMcpServers().then(result => !result.servers.some(server => server.name === 'Release MCP'))`, 30000, 'MCP removed through real row action');
    log('MCP real-form CRUD, disabled import, and secret-safe list ok');

    await evaluate(cdp, `document.querySelector('#plugin-tab-dsh').click()`, 30000);
    await sleep(1000);
    const dshPanelState = await evaluate(cdp, `(() => ({
      activeTab: window.state && window.state.pluginActiveTab,
      hasRescan: !!document.querySelector('#dsh-rescan'),
      panelText: (document.querySelector('#plugin-panel')?.innerText || '').slice(0, 2000),
      snapshot: window.state && window.state.dshCompatibility,
    }))()`, 30000);
    log(`DSH panel state: ${JSON.stringify(dshPanelState)}`);
    await waitFor(cdp, `(() => {
      const text = document.querySelector('#plugin-panel')?.innerText || '';
      return !!document.querySelector('#dsh-rescan') && text.includes('release-preview') && text.includes('release-dsh-bundle') && text.includes('latest') && text.includes('DSH Release MCP');
    })()`, 30000, 'official DSH profile, bundle, update channel, and MCP candidate visible');
    if (await evaluate(cdp, `document.body.innerText.includes(${JSON.stringify(dshFixture.secret)})`)) fail('DSH fixture secret rendered in the packaged DOM');
    if (fs.existsSync(dshFixture.marker)) fail('DSH discovery executed a plugin module');
    await captureScreenshot(cdp, dshScreenshotPath);
    await evaluate(cdp, `(() => {
      const candidate = document.querySelector('[data-dsh-candidate-index] button');
      if (!candidate) return false;
      candidate.click();
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => document.querySelector('#mcp-form') && document.querySelector('#mcp-name').value === 'DSH Release MCP' && document.querySelector('#mcp-enabled').checked === false)()`, 30000, 'DSH MCP candidate opens disabled review form');
    await evaluate(cdp, `document.querySelector('#mcp-cancel').click()`, 30000);
    log('official DSH read-only discovery and review-only MCP candidate ok');

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
    await waitFor(cdp, `(() => !!document.querySelector('#skill-market-search') && document.querySelector('#plugin-tab-market')?.getAttribute('aria-selected') === 'true')()`, 30000, 'skills market visible');
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
    await waitFor(cdp, `(() => !!document.querySelector('#skill-market-search') && document.querySelector('#plugin-tab-market')?.getAttribute('aria-selected') === 'true')()`, 30000, 'market visible after remove');
    await captureScreenshot(cdp, skillsScreenshotPath);
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
