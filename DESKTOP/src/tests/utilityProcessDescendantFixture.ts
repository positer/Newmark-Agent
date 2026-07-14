import { spawn } from 'child_process';
import * as fs from 'fs';

const readyPath = String(process.env.NEWMARK_DESCENDANT_READY || '');
const markerPath = String(process.env.NEWMARK_DESCENDANT_MARKER || '');
const lateTriggerPath = String(process.env.NEWMARK_DESCENDANT_LATE_TRIGGER || '');
const lateReadyPath = String(process.env.NEWMARK_DESCENDANT_LATE_READY || '');
const markerDelayMs = Math.max(100, Number(process.env.NEWMARK_DESCENDANT_MARKER_DELAY_MS || 900));

if (process.argv.includes('--leaf') || process.argv.includes('--late-leaf')) {
  const branchPid = Number(process.env.NEWMARK_DESCENDANT_BRANCH_PID || 0);
  setTimeout(() => {
    fs.writeFileSync(markerPath, JSON.stringify({
      branchPid,
      leafPid: process.pid,
      late: process.argv.includes('--late-leaf'),
      writtenAt: Date.now(),
    }), 'utf8');
  }, markerDelayMs);
  setInterval(() => undefined, 1_000);
} else {
  const leaf = spawn(process.execPath, [__filename, '--leaf'], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NEWMARK_DESCENDANT_BRANCH_PID: String(process.pid),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  leaf.unref();
  fs.writeFileSync(readyPath, JSON.stringify({ branchPid: process.pid, leafPid: Number(leaf.pid || 0) }), 'utf8');
  let lateSpawned = false;
  const triggerTimer = setInterval(() => {
    if (lateSpawned || !lateTriggerPath || !fs.existsSync(lateTriggerPath)) return;
    lateSpawned = true;
    const lateLeaf = spawn(process.execPath, [__filename, '--late-leaf'], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NEWMARK_DESCENDANT_BRANCH_PID: String(process.pid),
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    lateLeaf.unref();
    fs.writeFileSync(lateReadyPath, JSON.stringify({
      branchPid: process.pid,
      lateLeafPid: Number(lateLeaf.pid || 0),
      spawnedAt: Date.now(),
    }), 'utf8');
    clearInterval(triggerTimer);
  }, 10);
  setInterval(() => undefined, 1_000);
}
