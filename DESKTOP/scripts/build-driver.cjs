'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '..');
const node = process.execPath;
const timeoutValue = Number(process.env.NEWMARK_BUILD_STEP_TIMEOUT_MS || 180_000);
const stepTimeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0
  ? Math.min(timeoutValue, 3_600_000)
  : 180_000;
const packageTimeoutValue = Number(process.env.NEWMARK_PACKAGE_STEP_TIMEOUT_MS || 1_200_000);
const packageTimeoutMs = Number.isFinite(packageTimeoutValue) && packageTimeoutValue > 0
  ? Math.min(packageTimeoutValue, 3_600_000)
  : 600_000;
const cleanOnly = process.argv.includes('--clean-only');
const clean = process.argv.includes('--clean') || cleanOnly;
const packageOnly = process.argv.includes('--package-only');
let activeChild = null;
let interrupted = false;

const buildSteps = [
  ['TypeScript compile', [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')]],
  ['Windows process-tree helper', [path.join(root, 'scripts', 'build-windows-process-tree-helper.cjs')]],
  ['TypeBox compilation', [path.join(root, 'scripts', 'build-typebox-compile.cjs')]],
  ['UI icons', [path.join(root, 'scripts', 'build-ui-icons.cjs')]],
  ['WSL Agent host bundle', [path.join(root, 'scripts', 'build-wsl-agent-host.cjs')]],
  ['conversation utility host bundle', [path.join(root, 'scripts', 'build-conversation-utility-host.cjs')]],
  ['TUI copy', [path.join(root, 'scripts', 'build-tui.cjs')]],
];

function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.error || result.status !== 0) {
      try { child.kill('SIGKILL'); } catch { /* the child already exited */ }
    }
    return;
  }

  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* the process group already exited */ }
  const forceTimer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the process group already exited */ }
  }, 1_500);
  forceTimer.unref();
}

function formatTimeout(ms) {
  return ms < 1_000 ? `${ms}ms` : `${Math.ceil(ms / 1_000)}s`;
}

function runStep(label, args, timeoutMs = stepTimeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let timedOut = false;
    const timeoutLabel = formatTimeout(timeoutMs);
    console.log(`[build] starting: ${label} (timeout ${timeoutLabel})`);
    const child = spawn(node, args, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: false,
      detached: process.platform !== 'win32',
    });
    activeChild = child;

    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[build] TIMEOUT: ${label}; terminating process tree ${child.pid}`);
      stopProcessTree(child);
    }, timeoutMs);

    child.once('error', error => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = null;
      const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
      if (timedOut) {
        reject(new Error(`${label} exceeded ${timeoutLabel}; process tree terminated`));
      } else if (interrupted) {
        reject(new Error(`${label} was interrupted; process tree terminated`));
      } else if (code !== 0) {
        reject(new Error(`${label} exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`));
      } else {
        console.log(`[build] finished: ${label} (${elapsed}s)`);
        resolve();
      }
    });
  });
}

function interrupt(signal) {
  if (interrupted) return;
  interrupted = true;
  console.error(`[build] ${signal} received; terminating active process tree`);
  stopProcessTree(activeChild);
  if (!activeChild) process.exitCode = signal === 'SIGINT' ? 130 : 143;
}

process.on('SIGINT', () => interrupt('SIGINT'));
process.on('SIGTERM', () => interrupt('SIGTERM'));

async function main() {
  if (packageOnly) {
    await runStep('Windows release package', [path.join(root, 'scripts', 'dist-portable.cjs')], packageTimeoutMs);
    console.log('[build] Windows release package completed');
    return;
  }
  if (clean) {
    await runStep('TypeScript clean', [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--build', '--clean']);
    fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
    console.log('[build] removed dist output');
  }
  if (!cleanOnly) {
    for (const [label, args] of buildSteps) {
      if (interrupted) throw new Error('build interrupted');
      await runStep(label, args);
    }
  }
  console.log('[build] all requested phases completed');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[build] failed: ${error.message}`);
    process.exitCode = interrupted ? 130 : 1;
  });
}

module.exports = { formatTimeout, runStep, stopProcessTree };
