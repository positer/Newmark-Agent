'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NEWMARK_BUILD_STEP_TIMEOUT_MS = '1000';
const { runStep } = require('./build-driver.cjs');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
}

async function main() {
  const pidFile = path.join(os.tmpdir(), `newmark-build-tree-${process.pid}.json`);
  let pids = [];
  const worker = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));`,
    'setInterval(() => {}, 1000);',
  ].join('\n');

  try {
    await assert.rejects(
      runStep('build cancellation regression', ['-e', worker]),
      /build cancellation regression exceeded 1s; process tree terminated/,
    );
    assert.ok(fs.existsSync(pidFile), 'timed worker recorded the parent and descendant PIDs');
    pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Array.isArray(pids) && pids.length === 2 && pids.every(Number.isInteger), 'worker recorded both process IDs');

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && pids.some(processExists)) await sleep(50);
    assert.ok(pids.every(pid => !processExists(pid)), `process tree was fully stopped (remaining: ${pids.filter(processExists).join(', ') || 'none'})`);
    console.log('build cancellation regression passed: timeout stopped the build child and its descendant');
  } finally {
    for (const pid of pids) {
      if (!processExists(pid)) continue;
      if (process.platform === 'win32') {
        const { stopProcessTree } = require('./build-driver.cjs');
        stopProcessTree({ pid });
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
    try { fs.rmSync(pidFile, { force: true }); } catch { /* best-effort temp cleanup */ }
  }
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
