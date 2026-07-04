const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const appRoot = path.resolve(__dirname, '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const reportPath = path.join(repoRoot, 'archive', '2026-07-03-release-computer-use-vision-smoke.json');

function log(message) {
  console.log(`[release-computer-use-vision-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function writeConfig(root, port) {
  const provider = {
    name: 'ComputerUseVisionMock',
    base_url: `http://127.0.0.1:${port}/v1`,
    api_key: 'sk-computer-use-vision-smoke',
    protocol: 'openai',
    enabled: true,
    models: [
      {
        name: 'mock-computer-vision',
        display: 'Mock Computer Vision',
        max_tokens: 8192,
        vision: true,
        thinking: false,
        description: 'Release smoke model with vision enabled',
        evaluation: { status: 'available', latency: 1 },
      },
      {
        name: 'mock-computer-text',
        display: 'Mock Computer Text',
        max_tokens: 8192,
        vision: false,
        thinking: false,
        description: 'Release smoke model without vision',
        evaluation: { status: 'available', latency: 1 },
      },
    ],
  };
  const config = {
    models: {
      providers: [provider],
      default_model: 'mock-computer-vision',
      default_intelligence: 'low',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
      openai_api_mode: 'chat',
    },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    general: { language: 'en' },
    workspace: {
      auto_create_timestamp_workspace: true,
      prompt_mode: 'both',
      access_permission: 'full_access',
      on_permission_violation: 'deny',
    },
    tools: {
      enabled: {
        computer_use: true,
      },
    },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function requestHasComputerUseText(body) {
  const text = JSON.stringify(body.messages || []);
  return text.includes('observe')
    && text.includes('native-screenshot-plus-windows-ui-automation')
    && text.includes('UI Automation')
    && text.includes('screenshot_path');
}

function requestHasImage(body) {
  const text = JSON.stringify(body.messages || []);
  return text.includes('"image_url"') && text.includes('data:image/png;base64,');
}

function requestSummary(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return {
    model: body.model,
    messageCount: messages.length,
    roles: messages.map(msg => msg && msg.role),
    tail: JSON.stringify(messages.slice(-3)).slice(0, 2400),
    hasObserve: JSON.stringify(messages).includes('observe'),
    hasNativeMode: JSON.stringify(messages).includes('native-screenshot-plus-windows-ui-automation'),
    hasUiAutomation: JSON.stringify(messages).includes('UI Automation'),
    hasScreenshotPath: JSON.stringify(messages).includes('screenshot_path'),
    leaksVisionImagePath: JSON.stringify(messages).includes('vision_image_path'),
    leaksTempPngPath: /newmark-computer-use[^"]+\.png/i.test(JSON.stringify(messages)),
    hasImage: requestHasImage(body),
  };
}

function requestLeaksTempScreenshotPath(body) {
  const text = JSON.stringify(body.messages || []);
  return text.includes('vision_image_path') || /newmark-computer-use[^"]+\.png/i.test(text);
}

function tempScreenshotResidue() {
  const dir = path.join(os.tmpdir(), 'newmark-computer-use');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(entry => /^observe-.*\.png$/i.test(entry))
    .map(entry => path.join(dir, entry));
}

function clearTempScreenshotResidue() {
  for (const item of tempScreenshotResidue()) {
    try { fs.unlinkSync(item); } catch {}
  }
}

function createMockProviderServer() {
  const requests = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-computer-vision' }, { id: 'mock-computer-text' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      const perModel = requests.filter(item => item.body.model === body.model).length;
      requests.push({ url: req.url, body });
      const isSecondRound = perModel > 0;
      const message = isSecondRound
        ? { role: 'assistant', content: `COMPUTER_USE_${body.model === 'mock-computer-vision' ? 'VISION' : 'TEXT'}_DONE` }
        : {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: `call-${body.model || 'model'}-observe`,
              type: 'function',
              function: { name: 'computer_use', arguments: JSON.stringify({ action: 'observe', max_chars: 12000 }) },
            }],
          };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `mock-${Date.now()}`, object: 'chat.completion', choices: [{ index: 0, finish_reason: isSecondRound ? 'stop' : 'tool_calls', message }] }));
    });
  });
  return {
    requests,
    async start() {
      port = await findFreePort();
      await new Promise((resolve, reject) => {
        server.listen(port, '127.0.0.1', resolve);
        server.on('error', reject);
      });
      return port;
    },
    stop() {
      return new Promise(resolve => server.close(resolve));
    },
  };
}

function runPackagedSend(root, model, prompt, timeoutMs = 180000) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-computer-use-vision-cli-'));
  const stdoutPath = path.join(workDir, 'stdout.txt');
  const stderrPath = path.join(workDir, 'stderr.txt');
  const scriptPath = path.join(workDir, 'run.ps1');
  const args = ['send', prompt, '--mode', 'build', '--model', model, '--conversation', `computer-use-${model}`, '--root', root];
  fs.writeFileSync(scriptPath, [
    '$ErrorActionPreference = "Stop"',
    `$exe = ${psQuote(exePath)}`,
    `$argList = @(${args.map(psQuote).join(', ')})`,
    `$stdout = ${psQuote(stdoutPath)}`,
    `$stderr = ${psQuote(stderrPath)}`,
    '$p = Start-Process -FilePath $exe -ArgumentList $argList -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr',
    'exit $p.ExitCode',
  ].join('\r\n'), 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: appRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let psStdout = '';
    let psStderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { psStdout += chunk; });
    child.stderr.on('data', chunk => { psStderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`packaged send timed out for ${model}. stdout=${psStdout} stderr=${psStderr}`));
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : psStdout;
      const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : psStderr;
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      if (code !== 0) {
        reject(new Error(`packaged send exited ${code} for ${model}. stdout=${stdout} stderr=${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}

function runPackagedTool(root, tool, toolArgs, timeoutMs = 120000) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-computer-use-tool-'));
  const stdoutPath = path.join(workDir, 'stdout.txt');
  const stderrPath = path.join(workDir, 'stderr.txt');
  const scriptPath = path.join(workDir, 'run.ps1');
  const argsPath = writeJson(workDir, 'args.json', toolArgs);
  const args = ['tool', tool, '--args-file', argsPath, '--root', root];
  fs.writeFileSync(scriptPath, [
    '$ErrorActionPreference = "Stop"',
    `$exe = ${psQuote(exePath)}`,
    `$argList = @(${args.map(psQuote).join(', ')})`,
    `$stdout = ${psQuote(stdoutPath)}`,
    `$stderr = ${psQuote(stderrPath)}`,
    '$p = Start-Process -FilePath $exe -ArgumentList $argList -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr',
    'exit $p.ExitCode',
  ].join('\r\n'), 'utf8');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: appRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`packaged tool timed out for ${tool}`));
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
      const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      if (code !== 0) {
        reject(new Error(`packaged tool ${tool} exited ${code}. stdout=${stdout} stderr=${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

(async () => {
  if (!fs.existsSync(exePath)) fail(`Packaged release exe missing: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-release-computer-use-vision-'));
  fs.mkdirSync(path.join(root, 'Work'), { recursive: true });
  fs.mkdirSync(path.join(root, 'archive'), { recursive: true });

  const server = createMockProviderServer();
  const port = await server.start();
  clearTempScreenshotResidue();
  writeConfig(root, port);
  try {
    const vision = await runPackagedSend(root, 'mock-computer-vision', 'Call computer_use observe once, then finish with the marker.');
    if (!vision.stdout.includes('COMPUTER_USE_VISION_DONE')) fail(`vision model did not complete: ${vision.stdout}`);
    const textOnly = await runPackagedSend(root, 'mock-computer-text', 'Call computer_use observe once, then finish with the marker.');
    if (!textOnly.stdout.includes('COMPUTER_USE_TEXT_DONE')) fail(`text model did not complete: ${textOnly.stdout}`);
    const takeoverStop = await runPackagedTool(root, 'computer_use', { action: 'takeover_stop' });
    if (!takeoverStop.stdout.includes('"takeover_stop"') || !takeoverStop.stdout.includes('"ok": true')) fail(`takeover_stop failed: ${takeoverStop.stdout}`);
    const appList = await runPackagedTool(root, 'computer_use', { action: 'app_list', max_chars: 12000 });
    if (!appList.stdout.includes('"action": "app_list"') || !appList.stdout.includes('"applications"')) fail(`app_list failed: ${appList.stdout}`);
    const appObserveMissing = await runPackagedTool(root, 'computer_use', { action: 'app_observe', app_target: 'newmark-nonexistent-app-for-release-smoke' });
    if (!appObserveMissing.stdout.includes('"app_observe"') || !appObserveMissing.stdout.includes('No visible application window matched')) fail(`app_observe unmatched target failed: ${appObserveMissing.stdout}`);

    const visionRequests = server.requests.filter(item => item.body.model === 'mock-computer-vision');
    const textRequests = server.requests.filter(item => item.body.model === 'mock-computer-text');
    if (visionRequests.length < 2) fail(`expected two vision requests, got ${visionRequests.length}`);
    if (textRequests.length < 2) fail(`expected two text requests, got ${textRequests.length}`);
    const visionSecond = visionRequests[1].body;
    const textSecond = textRequests[1].body;

    if (!requestHasComputerUseText(visionSecond)) fail(`vision second request missing Computer Use UI Automation text result: ${JSON.stringify(requestSummary(visionSecond))}`);
    if (!requestHasImage(visionSecond)) fail(`vision second request missing screenshot image_url data URL: ${JSON.stringify(requestSummary(visionSecond))}`);
    if (requestLeaksTempScreenshotPath(visionSecond)) fail(`vision second request leaked temporary screenshot path: ${JSON.stringify(requestSummary(visionSecond))}`);
    if (!requestHasComputerUseText(textSecond)) fail(`text-only second request missing Computer Use UI Automation text result: ${JSON.stringify(requestSummary(textSecond))}`);
    if (requestHasImage(textSecond)) fail(`text-only second request unexpectedly included screenshot image_url: ${JSON.stringify(requestSummary(textSecond))}`);
    if (requestLeaksTempScreenshotPath(textSecond)) fail(`text-only second request leaked temporary screenshot path: ${JSON.stringify(requestSummary(textSecond))}`);

    const residue = tempScreenshotResidue();
    if (residue.length) fail(`Computer Use left temporary screenshot residue: ${residue.join(', ')}`);

    const report = {
      ok: true,
      root,
      requestCounts: {
        vision: visionRequests.length,
        text: textRequests.length,
      },
      evidence: {
        visionSecondHasUiAutomationText: requestHasComputerUseText(visionSecond),
        visionSecondHasImage: requestHasImage(visionSecond),
        textSecondHasUiAutomationText: requestHasComputerUseText(textSecond),
        textSecondHasImage: requestHasImage(textSecond),
        noTempScreenshotPathLeak: !requestLeaksTempScreenshotPath(visionSecond) && !requestLeaksTempScreenshotPath(textSecond),
        tempScreenshotsDeleted: true,
        takeoverStopOk: takeoverStop.stdout.includes('"takeover_stop"'),
        appScopedControlsOk: appList.stdout.includes('"applications"') && appObserveMissing.stdout.includes('No visible application window matched'),
      },
    };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    log(`vision=true sent UI Automation text plus screenshot image; vision=false sent UI Automation text without image`);
    log(`report ${reportPath}`);
  } finally {
    await server.stop();
  }
})().catch(error => {
  console.error(`[release-computer-use-vision-smoke] ${error.stack || error.message || error}`);
  process.exit(1);
});
