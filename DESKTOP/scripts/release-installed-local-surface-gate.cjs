const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { smokeWindowsUnpacked } = require('./release-windows-package-smoke-lib.cjs');

const installRoot = path.resolve(process.env.NEWMARK_INSTALLED_ROOT || 'C:\\Program Files\\Newmark Agent');
const guiExe = path.join(installRoot, 'Newmark Agent.exe');
const cliExe = path.join(installRoot, 'Newmark.exe');

function assert(condition, message) {
  if (!condition) throw new Error(`installed local surface gate failed: ${message}`);
}

function runNode(script, env, label, timeout = 360000) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    windowsHide: true,
    timeout,
    env: { ...process.env, ...env },
  });
  if (result.error) throw new Error(`${label} spawn failed: ${result.error.message}`);
  assert(result.status === 0, `${label} exited ${result.status}`);
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('installed local surface gate skipped outside Windows');
    return;
  }
  assert(fs.existsSync(guiExe), `missing installed GUI: ${guiExe}`);
  assert(fs.existsSync(cliExe), `missing installed CLI/TUI wrapper: ${cliExe}`);
  assert(fs.existsSync(path.join(installRoot, 'Newmark Console Runtime.exe')), 'missing installed console runtime');

  await smokeWindowsUnpacked(installRoot, 'installed Windows directory');
  const screenshot = path.join(os.tmpdir(), `newmark-installed-cli-ui-sync-${process.pid}.png`);
  try {
    runNode('release-cli-ui-conversation-sync-smoke.cjs', {
      NEWMARK_TEST_EXE: guiExe,
      NEWMARK_TEST_CLI_EXE: cliExe,
      NEWMARK_CLI_UI_CONVERSATION_SYNC_SCREENSHOT: screenshot,
    }, 'installed GUI/CLI shared conversation sync');
  } finally {
    try { fs.rmSync(screenshot, { force: true }); } catch {}
  }
  runNode('release-ssh-tui-stress.cjs', { NEWMARK_SSH_TUI_EXE: cliExe }, 'installed TUI SSH/PTTY stress');
  runNode('release-context-compress-cli-stress.cjs', { NEWMARK_CONTEXT_COMPRESS_EXE: cliExe }, 'installed CLI context-compression stress');
  runNode('release-installed-readonly-validation-stress.cjs', {}, 'installed read-only real-model validation stress', 600000);
  console.log('INSTALLED_LOCAL_SURFACE_GATE_PASS gui=true cli=true tui=true guiCliSharedBackend=true contextCompression=true readOnlyValidation=true');
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
