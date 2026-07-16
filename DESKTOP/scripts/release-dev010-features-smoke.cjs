const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const exePath = path.resolve(process.env.NEWMARK_TEST_EXE || path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function readAsarText(asarPath, entry) {
  // @electron/asar resolves nested archive entries with the host platform's
  // separator.  Keep call sites portable and normalize at the boundary so a
  // Windows artifact smoke does not mistake an existing file for a missing one.
  const archiveEntry = String(entry).split('/').join(path.sep);
  const value = asar.extractFile(asarPath, archiveEntry);
  return Buffer.isBuffer(value) ? value.toString('utf8') : Buffer.from(value).toString('utf8');
}

function runCli(args, runtimeRoot) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-dev010-cli-'));
  const stdoutPath = path.join(workDir, 'stdout.txt');
  const stderrPath = path.join(workDir, 'stderr.txt');
  const scriptPath = path.join(workDir, 'run.ps1');
  fs.writeFileSync(scriptPath, [
    '$ErrorActionPreference = "Stop"',
    `$exe = ${psQuote(exePath)}`,
    `$arguments = @(${args.map(psQuote).join(', ')})`,
    `$stdout = ${psQuote(stdoutPath)}`,
    `$stderr = ${psQuote(stderrPath)}`,
    '$process = Start-Process -FilePath $exe -ArgumentList $arguments -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr',
    'exit $process.ExitCode',
  ].join('\r\n'), 'utf8');
  try {
    const process = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: path.dirname(exePath),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 90000,
    });
    if (process.error) throw process.error;
    return {
      status: Number(process.status || 0),
      stdout: fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8').trim() : '',
      stderr: fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8').trim() : '',
      runtimeRoot,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function parseEnvelope(result, label) {
  assert(!result.stderr, `${label} wrote stderr: ${result.stderr}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON: ${result.stdout || '<empty>'}`);
  }
}

function verifiedModel(name, extra = {}) {
  const checkedAt = new Date().toISOString();
  return {
    name,
    enabled: true,
    max_tokens: 32768,
    preview: false,
    capabilities: ['text_input', 'text_output', 'streaming', 'json_schema', 'tool_use'],
    validation: {
      level: 'standard',
      status: 'verified',
      checked_at: checkedAt,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      capabilities: {
        text_input: true,
        text_output: true,
        streaming: true,
        json_schema: true,
        tool_use: true,
        image_input: false,
        image_output: false,
      },
    },
    ...extra,
  };
}

function writeRuntimeConfig(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: [{
        id: 'provider-dev010-a',
        name: 'Dev010A',
        base_url: 'http://127.0.0.1:9/v1',
        api_key: 'packaged-smoke-placeholder-a',
        protocol: 'openai',
        enabled: true,
        models: [verifiedModel('same-name')],
      }, {
        id: 'provider-dev010-b',
        name: 'Dev010B',
        base_url: 'http://127.0.0.1:9',
        api_key: 'packaged-smoke-placeholder-b',
        protocol: 'anthropic',
        enabled: true,
        models: [verifiedModel('same-name')],
      }],
      default_model: 'auto',
      auto_switch: true,
      auto_switch_scope: 'all',
      auto_switch_preference: 'balanced',
    },
    agent: { default_mode: 'build' },
    workspace: { auto_create_timestamp_workspace: false },
  }, null, 2), 'utf8');
}

function verifyPackagedSources() {
  const asarPath = path.join(path.dirname(exePath), 'resources', 'app.asar');
  assert(fs.existsSync(asarPath), `packaged app.asar is missing: ${asarPath}`);
  const packaged = JSON.parse(readAsarText(asarPath, 'package.json'));
  assert(packaged.version === packageJson.version, `packaged version mismatch: expected ${packageJson.version}, got ${packaged.version}`);

  const auto = readAsarText(asarPath, 'dist/core/autoRouter.js');
  assert(auto.includes('catalogSnapshotHash') && auto.includes('maxQualityLoss') && auto.includes('rankedCandidates'), 'packaged Auto router lacks auditable decision fields');
  assert(auto.includes("kind: 'provider'") || auto.includes('scope.providerId'), 'packaged Auto router lacks provider-scope enforcement');

  const validation = readAsarText(asarPath, 'dist/core/modelValidation.js');
  assert(validation.includes('MODEL_VALIDATION_TTL_MS') && validation.includes('strict_json') && validation.includes('tool_result'), 'packaged Standard validation service is incomplete');
  assert(validation.includes('auth_error') && validation.includes('rate_limited') && validation.includes('invalid_config'), 'packaged validation status taxonomy is incomplete');

  const kernelRunner = readAsarText(asarPath, 'dist/core/agentKernelRunner.js');
  assert(kernelRunner.includes("TOOL_PROVISION_NAME = 'tool_provision'")
    && kernelRunner.includes('INITIAL_TOOL_SCHEMA_LIMIT = 8')
    && kernelRunner.includes('TOOL_PROVISION_BATCH_LIMIT = 8')
    && kernelRunner.includes('provisionedNames'), 'packaged Agent lacks bounded on-demand tool provisioning');

  const ui = readAsarText(asarPath, 'dist/ui/index.html');
  assert(!/<webview\b[^>]*id=["']browser-webview/i.test(ui), 'packaged UI still creates a static Browser guest');
  assert(ui.includes("document.createElement('webview')") && ui.includes('persist:newmark-browser'), 'packaged UI lacks demand-created persistent Browser guest');
  assert(ui.includes('20 * transparencyPercent / 100') && ui.includes("--glass-blur-3"), 'packaged glass opacity-to-width inversion is missing');
  assert(ui.includes('queue-guide-btn')
    && ui.includes("'queue.guideAction': '引导'")
    && ui.includes('restoreQueueItemAfterGuideFailure')
    && ui.includes('!outcome.guideReceipt'), 'packaged queue lacks visible Guide delivery and failure recovery');
  assert(ui.includes('--control-hover-bg')
    && ui.includes('settings-action-btn')
    && ui.includes('settings-terminal-timeout-input')
    && ui.includes('color-scheme: var(--select-color-scheme)'), 'packaged settings controls lack theme-consistent states');
}

function verifyPackagedCli(root) {
  const state = runCli(['state', '--root', root], root);
  assert(state.status === 0, `packaged state exited ${state.status}: ${state.stderr || state.stdout}`);
  const parsedState = parseEnvelope(state, 'state');
  assert(parsedState.model === 'auto' && parsedState.autoSwitch === true && parsedState.autoSwitchScope === 'all', `packaged Auto intent/scope mismatch: ${state.stdout}`);

  const missingContentArgs = path.join(root, 'missing-content-args.json');
  fs.writeFileSync(missingContentArgs, JSON.stringify({ path: path.join(root, 'must-not-exist.txt') }), 'utf8');
  const missingContent = runCli(['tool', 'write', '--args-file', missingContentArgs, '--root', root], root);
  const missingEnvelope = parseEnvelope(missingContent, 'schema rejection');
  assert(missingContent.status === 2 && missingEnvelope.ok === false && missingEnvelope.tool === 'write', `schema rejection exit/envelope mismatch: ${JSON.stringify(missingContent)}`);
  assert(!fs.existsSync(path.join(root, 'must-not-exist.txt')), 'schema-invalid write caused a side effect');

  const planPath = path.join(root, 'plan-must-not-exist.txt');
  const planArgs = path.join(root, 'plan-write-args.json');
  fs.writeFileSync(planArgs, JSON.stringify({ path: planPath, content: 'blocked' }), 'utf8');
  const planWrite = runCli(['tool', 'write', '--args-file', planArgs, '--mode', 'plan', '--root', root], root);
  const planEnvelope = parseEnvelope(planWrite, 'Plan policy rejection');
  assert(planWrite.status === 3 && planEnvelope.ok === false && planEnvelope.tool === 'write', `Plan policy exit/envelope mismatch: ${JSON.stringify(planWrite)}`);
  assert(!fs.existsSync(planPath), 'Plan-denied write caused a side effect');

  const browserArgs = path.join(root, 'browser-open-args.json');
  fs.writeFileSync(browserArgs, JSON.stringify({ url: 'https://example.com' }), 'utf8');
  const browser = runCli(['tool', 'browser_open', '--args-file', browserArgs, '--root', root], root);
  const browserEnvelope = parseEnvelope(browser, 'CLI Browser capability rejection');
  assert(browser.status === 3 && browserEnvelope.ok === false, `pure CLI exposed Electron Browser capability: ${JSON.stringify(browser)}`);

  const pwd = runCli(['tool', 'pwd', '{}', '--mode', 'build', '--root', root], root);
  const pwdEnvelope = parseEnvelope(pwd, 'pwd');
  assert(pwd.status === 0 && pwdEnvelope.ok === true && pwdEnvelope.tool === 'pwd' && pwdEnvelope.result, `successful tool envelope mismatch: ${pwd.stdout}`);
}

(async () => {
  if (process.platform !== 'win32') {
    console.log('[release-dev010-features-smoke] skipped outside Windows');
    return;
  }
  assert(fs.existsSync(exePath), `release executable is missing: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-dev010-features-'));
  try {
    writeRuntimeConfig(root);
    verifyPackagedSources();
    verifyPackagedCli(root);
    console.log(JSON.stringify({ ok: true, version: packageJson.version, assertions: 22, real_api_called: false }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
})().catch(error => {
  console.error(`[release-dev010-features-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
