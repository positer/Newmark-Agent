const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const releaseRoot = path.join(repoRoot, 'release', 'win-unpacked');
const guiExe = path.join(releaseRoot, 'Newmark Agent.exe');
const consoleExe = path.join(releaseRoot, 'Newmark.exe');
const consoleRuntimeExe = path.join(releaseRoot, 'Newmark Console Runtime.exe');
const portableLauncher = path.join(releaseRoot, 'Newmark.bat');
const userConfig = path.join(os.homedir(), '.Newmark', 'config.json');
const packageVersion = require('../package.json').version;
const packageVersionPattern = new RegExp(
  `\\b${packageVersion.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`,
);

function assert(condition, message) {
  if (!condition) throw new Error(`safe black-box gate failed: ${message}`);
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function run(exe, args, root) {
  const result = invoke(exe, args, root, 120_000);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert(!result.error, `${path.basename(exe)} ${args.join(' ')} spawn: ${result.error?.message || 'unknown error'}`);
  assert(result.status === 0, `${path.basename(exe)} ${args.join(' ')} exit=${result.status}; output=${output.trim().slice(0, 600)}`);
  return output;
}

function invoke(exe, args, root, timeout = 30_000) {
  // GUI subsystem failures must be read from the spawned process handle. A
  // PowerShell caller's $LASTEXITCODE is not a reliable release assertion for
  // a GUI executable launched through shell/application activation.
  return spawnSync(exe, [...args, '--root', root], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function invokeExact(exe, args, root, timeout = 30_000) {
  return spawnSync(exe, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function runExact(exe, args, root, expectedStatus = 0) {
  const result = invokeExact(exe, args, root);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert(!result.error, `${path.basename(exe)} ${args.join(' ')} exact spawn: ${result.error?.message || 'unknown error'}`);
  assert(result.status === expectedStatus, `${path.basename(exe)} ${args.join(' ')} exact exit=${result.status}; expected=${expectedStatus}; output=${output.trim().slice(0, 600)}`);
  return { result, output };
}

function runExpect(exe, args, root, expectedStatus, pattern) {
  const result = invoke(exe, args, root);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert(!result.error, `${path.basename(exe)} ${args.join(' ')} spawn: ${result.error?.message || 'unknown error'}`);
  assert(result.status === expectedStatus, `${path.basename(exe)} ${args.join(' ')} exit=${result.status}; expected=${expectedStatus}; output=${output.trim().slice(0, 600)}`);
  if (pattern) assert(pattern.test(output), `${path.basename(exe)} ${args.join(' ')} diagnostic missing; output=${output.trim().slice(0, 600)}`);
  return { result, output };
}

function runNodeGate(scriptName, args = []) {
  const scriptPath = path.join(__dirname, scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert(!result.error, `${scriptName} spawn: ${result.error?.message || 'unknown error'}`);
  assert(result.status === 0, `${scriptName} exit=${result.status}; output=${output.trim().slice(-1_200)}`);
  return output;
}

function remainingPackagedProcesses() {
  const ps = [
    '$paths=@(',
    `  '${guiExe.replace(/'/g, "''")}',`,
    `  '${consoleExe.replace(/'/g, "''")}',`,
    `  '${consoleRuntimeExe.replace(/'/g, "''")}'`,
    ')',
    ';',
    '@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ($paths -contains $_.ExecutablePath) }).Count',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return Number(String(result.stdout || '').trim()) || 0;
}

function profileProcessRows() {
  const ps = [
    '$paths=@(',
    `  '${guiExe.replace(/'/g, "''")}',`,
    `  '${consoleExe.replace(/'/g, "''")}',`,
    `  '${consoleRuntimeExe.replace(/'/g, "''")}'`,
    ')',
    ';',
    '$rows=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ($paths -contains $_.ExecutablePath) -and $_.CommandLine -and ($_.CommandLine -match \'--user-data-dir\') } | Select-Object ProcessId,ParentProcessId,CommandLine)',
    ';',
    'if ($rows.Count -eq 0) { "[]" } else { $rows | ConvertTo-Json -Compress }',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const text = String(result.stdout || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function sleepMs(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function snapshotLegacyElectronProfile() {
  const legacyRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Newmark Agent');
  const candidates = [
    'Preferences',
    'DIPS',
    'DIPS-wal',
    'DevToolsActivePort',
    'Session Storage',
    'blob_storage',
  ].map(item => path.join(legacyRoot, item));
  return new Map(candidates.map(file => {
    try {
      return [file, { exists: true, mtimeMs: fs.statSync(file).mtimeMs }];
    } catch {
      return [file, { exists: false, mtimeMs: 0 }];
    }
  }));
}

function assertLegacyElectronProfileUnchanged(before) {
  for (const [file, expected] of before.entries()) {
    let actual;
    try {
      actual = { exists: true, mtimeMs: fs.statSync(file).mtimeMs };
    } catch {
      actual = { exists: false, mtimeMs: 0 };
    }
    assert(actual.exists === expected.exists, `legacy Electron profile presence changed: ${file}`);
    if (expected.exists) assert(actual.mtimeMs === expected.mtimeMs, `legacy Electron profile was written: ${file}`);
  }
}

function stopProcessTree(pid) {
  if (!pid) return;
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
}

function verifyGuiUserDataIsolation(root) {
  const guiRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-safe-gui-root-'));
  const expectedUserData = path.join(guiRoot, 'Electron');
  const legacyProfileBefore = snapshotLegacyElectronProfile();
  let child = null;
  try {
    child = spawn(guiExe, ['--allow-multiple-instances', '--disable-gpu', '--root', guiRoot], {
      cwd: guiRoot,
      stdio: 'ignore',
      windowsHide: true,
    });
    const deadline = Date.now() + 45_000;
    let rows = [];
    while (Date.now() < deadline && !child.exitCode) {
      rows = profileProcessRows();
      if (rows.some(row => String(row.CommandLine || '').toLowerCase().includes(expectedUserData.toLowerCase()))) break;
      sleepMs(250);
    }
    const isolatedRows = rows.filter(row => String(row.CommandLine || '').toLowerCase().includes(expectedUserData.toLowerCase()));
    assert(isolatedRows.length > 0, `GUI did not bind Chromium user-data to ${expectedUserData}; rows=${JSON.stringify(rows).slice(0, 1200)}`);
    const legacyRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Newmark Agent');
    assert(
      !isolatedRows.some(row => String(row.CommandLine || '').toLowerCase().includes(legacyRoot.toLowerCase())),
      `GUI Chromium process still references the real legacy AppData profile: ${JSON.stringify(isolatedRows).slice(0, 1200)}`,
    );
    assert(fs.existsSync(expectedUserData), `isolated Electron user-data root was not created: ${expectedUserData}`);
    process.stdout.write(`[safe-blackbox] gui-user-data-isolation ok root=${expectedUserData}\n`);
  } finally {
    stopProcessTree(child?.pid);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && remainingPackagedProcesses() > 0) sleepMs(250);
    assert(remainingPackagedProcesses() === 0, 'GUI user-data isolation case left a packaged process behind');
    assertLegacyElectronProfileUnchanged(legacyProfileBefore);
    fs.rmSync(guiRoot, { recursive: true, force: true });
  }
}

function verifyConsoleWrapperUserDataIsolation() {
  const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-safe-wrapper-gui-root-'));
  const expectedUserData = path.join(wrapperRoot, 'Electron');
  const legacyProfileBefore = snapshotLegacyElectronProfile();
  let child = null;
  try {
    child = spawn(consoleExe, ['--allow-multiple-instances', '--disable-gpu', '--root', wrapperRoot], {
      cwd: wrapperRoot,
      stdio: 'ignore',
      windowsHide: true,
    });
    const deadline = Date.now() + 45_000;
    let rows = [];
    while (Date.now() < deadline && !child.exitCode) {
      rows = profileProcessRows();
      if (rows.some(row => String(row.CommandLine || '').toLowerCase().includes(expectedUserData.toLowerCase()))) break;
      sleepMs(250);
    }
    const isolatedRows = rows.filter(row => String(row.CommandLine || '').toLowerCase().includes(expectedUserData.toLowerCase()));
    assert(isolatedRows.length > 0, `console wrapper did not bind Chromium user-data to ${expectedUserData}; rows=${JSON.stringify(rows).slice(0, 1200)}`);
    const legacyRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Newmark Agent');
    assert(!isolatedRows.some(row => String(row.CommandLine || '').toLowerCase().includes(legacyRoot.toLowerCase())),
      `console wrapper Chromium process still references the real legacy AppData profile: ${JSON.stringify(isolatedRows).slice(0, 1200)}`);
    assert(fs.existsSync(expectedUserData), `console wrapper isolated Electron root was not created: ${expectedUserData}`);
    process.stdout.write(`[safe-blackbox] console-wrapper-user-data-isolation ok root=${expectedUserData}\n`);
  } finally {
    stopProcessTree(child?.pid);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && remainingPackagedProcesses() > 0) sleepMs(250);
    assert(remainingPackagedProcesses() === 0, 'console wrapper user-data isolation case left a packaged process behind');
    assertLegacyElectronProfileUnchanged(legacyProfileBefore);
    fs.rmSync(wrapperRoot, { recursive: true, force: true });
  }
}

function processStillExists(pid) {
  if (!pid) return false;
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `$p=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { '1' } else { '0' }`,
  ], { encoding: 'utf8', windowsHide: true });
  return String(ps.stdout || '').trim() === '1';
}

function closeMainWindow(pid) {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `$p=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow(); 'close-requested' } else { 'already-exited' }`,
  ], { encoding: 'utf8', windowsHide: true });
  assert(ps.status === 0, `GUI CloseMainWindow probe failed: ${ps.stderr || ps.stdout}`);
}

function verifyGuiCloseLifecycle() {
  const closeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-safe-gui-close-'));
  let child = null;
  try {
    child = spawn(guiExe, ['--gui', '--allow-multiple-instances', '--disable-gpu', '--root', closeRoot], {
      cwd: closeRoot,
      stdio: 'ignore',
      windowsHide: true,
    });
    const startupDeadline = Date.now() + 45_000;
    while (Date.now() < startupDeadline && !processStillExists(child.pid)) sleepMs(250);
    assert(processStillExists(child.pid), 'GUI close lifecycle process did not start');
    sleepMs(3_000);
    closeMainWindow(child.pid);
    const exitDeadline = Date.now() + 15_000;
    while (Date.now() < exitDeadline && processStillExists(child.pid)) sleepMs(250);
    assert(!processStillExists(child.pid), 'explicit --gui CloseMainWindow left the main process alive');
    const residueDeadline = Date.now() + 5_000;
    while (Date.now() < residueDeadline && remainingPackagedProcesses() > 0) sleepMs(250);
    assert(remainingPackagedProcesses() === 0, 'GUI close lifecycle left packaged child processes behind');
    process.stdout.write('[safe-blackbox] gui-close-lifecycle ok\n');
  } finally {
    if (child?.pid && processStillExists(child.pid)) stopProcessTree(child.pid);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && remainingPackagedProcesses() > 0) sleepMs(250);
    assert(remainingPackagedProcesses() === 0, 'GUI close lifecycle cleanup left a packaged process behind');
    fs.rmSync(closeRoot, { recursive: true, force: true });
  }
}

function verifyBatchExitCode() {
  assert(fs.existsSync(portableLauncher), `missing portable launcher ${portableLauncher}`);
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', 'call', portableLauncher, '--blackbox-unknown'], {
    cwd: releaseRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 512 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert(!result.error, `portable batch unknown-argument spawn: ${result.error?.message || 'unknown error'}`);
  assert(result.status === 2, `portable batch unknown-argument exit=${result.status}; output=${output.trim().slice(0, 600)}`);
  assert(/Invalid Newmark argument/i.test(output), `portable batch unknown-argument diagnostic missing; output=${output.trim().slice(0, 600)}`);
  process.stdout.write('[safe-blackbox] batch-exit-code ok exit=2\n');
}

function writeEmptyConfig(root) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: { providers: [], default_model: '', default_intelligence: 'low', agent_engine: 'builtin' },
    general: { language: 'en' },
    agent: { default_mode: 'build' },
    workspace: { prompt_mode: 'global_only' },
  }, null, 2), 'utf8');
}

function main() {
  assert(process.platform === 'win32', 'Windows packaged executable gate requires win32');
  assert(fs.existsSync(guiExe), `missing ${guiExe}`);
  assert(fs.existsSync(consoleExe), `missing ${consoleExe}`);
  assert(fs.existsSync(userConfig), `missing user config ${userConfig}`);
  const before = hashFile(userConfig);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-safe-blackbox-'));
  const cases = [
    ['console-help', consoleExe, ['--help']],
    ['console-help-word', consoleExe, ['help']],
    ['console-cli-help', consoleExe, ['--cli', '--help']],
    ['console-tui-help', consoleExe, ['--TUI', '--help']],
    ['gui-help', guiExe, ['--help']],
    ['gui-help-word', guiExe, ['help']],
  ];
  for (const executable of [['console', consoleExe], ['gui', guiExe]]) {
    for (const command of ['state', 'tool', 'send', 'validate-models', 'skills-market', 'memory-lab', 'install-update', 'fuzzy-inject', 'flow', 'edit', 'compat']) {
      cases.push([`${executable[0]}-${command}-help`, executable[1], [command, '--help']]);
    }
  }
  try {
    const installedHelp = runNodeGate('release-installed-readonly-validation-stress.cjs', ['--help']);
    assert(/Usage:/.test(installedHelp), 'installed read-only validation --help did not short-circuit with usage text');
    process.stdout.write('[safe-blackbox] installed-readonly-validation-help ok\n');
    for (const [name, exe, args] of cases) {
      run(exe, args, root);
      process.stdout.write(`[safe-blackbox] ${name} ok\n`);
    }
    const helpBoundaryRoot = path.join(root, 'Help Root With Spaces');
    fs.mkdirSync(helpBoundaryRoot, { recursive: true });
    for (const [surface, exe] of [['console', consoleExe], ['gui', guiExe]]) {
      const variants = [
        ['--help', '--root', helpBoundaryRoot],
        ['--root', helpBoundaryRoot, '--help'],
        ['send', '--help', '--root', helpBoundaryRoot],
        ['send', '--root', helpBoundaryRoot, '--help'],
      ];
      for (const args of variants) {
        const help = runExact(exe, args, helpBoundaryRoot);
        assert(/Usage:|Newmark CLI command:/i.test(help.output), `${surface} help boundary output mismatch: ${help.output.trim().slice(0, 600)}`);
      }
      assert(!fs.existsSync(path.join(helpBoundaryRoot, 'config.json')), `${surface} help boundary initialized its explicit root`);
      process.stdout.write(`[safe-blackbox] ${surface}-help-boundary-order ok variants=${variants.length}\n`);
    }
    for (const [name, exe] of [['console-version-alias', consoleExe], ['gui-version-alias', guiExe]]) {
    runExpect(exe, ['-version'], root, 0, packageVersionPattern);
      process.stdout.write(`[safe-blackbox] ${name} ok\n`);
    }
    for (const [name, exe] of [['console-unknown-command', consoleExe], ['gui-unknown-command', guiExe]]) {
      runExpect(exe, ['not-a-command'], root, 2, /Unknown Newmark command or argument/i);
      process.stdout.write(`[safe-blackbox] ${name} ok\n`);
    }
    writeEmptyConfig(root);
    const empty = spawnSync(consoleExe, ['send', 'black-box empty provider must fail', '--agent-only', '--root', root], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const emptyOutput = `${empty.stdout || ''}\n${empty.stderr || ''}`;
    assert(empty.status === 1, `empty provider send exit=${empty.status}; output=${emptyOutput.trim().slice(0, 600)}`);
    assert(/No LLM configured/i.test(emptyOutput), `empty provider diagnostic missing; output=${emptyOutput.trim().slice(0, 600)}`);
    const invalidValidation = runExpect(
      consoleExe,
      ['validate-models', '--selected', 'invalid/provider,invalid/model'],
      root,
      1,
      /No configured model deployments matched --selected/i,
    );
    process.stdout.write(`[safe-blackbox] invalid-model-selection-exit ok exit=${invalidValidation.result.status}\n`);
    runNodeGate('release-gui-no-model-smoke.cjs');
    process.stdout.write('[safe-blackbox] gui-no-model ok\n');
    const invalidModelConfig = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    invalidModelConfig.models.providers = [{
      id: 'cli-invalid-model-fixture',
      name: 'CLI invalid-model fixture',
      base_url: 'http://127.0.0.1:9/v1',
      api_key: 'fixture-key-not-a-secret',
      protocol: 'openai',
      enabled: true,
      models: [{ name: 'valid-fixture-model', display: 'Valid Fixture Model', description: 'Deterministic CLI contract model' }],
    }];
    invalidModelConfig.models.default_model = 'cli-invalid-model-fixture/valid-fixture-model';
    invalidModelConfig.models.fallback_on_unavailable = false;
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(invalidModelConfig, null, 2), 'utf8');
    const invalidModel = runExpect(
      consoleExe,
      ['send', 'black-box invalid model must fail closed', '--agent-only', '--model', 'MissingProvider/missing-model'],
      root,
      1,
      /unavailable|not configured|MissingProvider\/missing-model/i,
    );
    process.stdout.write(`[safe-blackbox] invalid-model-fail-closed ok exit=${invalidModel.result.status}\n`);
    verifyBatchExitCode();
    verifyGuiCloseLifecycle();
    verifyGuiUserDataIsolation(root);
    verifyConsoleWrapperUserDataIsolation();
    const after = hashFile(userConfig);
    assert(before === after, `user config changed before=${before} after=${after}`);
    assert(remainingPackagedProcesses() === 0, 'packaged GUI/console process remained after black-box matrix');
    process.stdout.write(`SAFE_BLACKBOX_GATES_PASS cases=${cases.length} versionAliases=2 unknownCommands=2 emptyProviderExit=${empty.status} invalidSelectionExit=${invalidValidation.result.status} invalidModelExit=${invalidModel.result.status} batchExitCode=true guiCloseLifecycle=true guiNoModel=true guiUserDataIsolation=true userConfigUnchanged=true\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exit(1);
}
