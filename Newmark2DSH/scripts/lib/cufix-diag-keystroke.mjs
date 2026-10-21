/**
 * Does `ctrl+-` reach the page at all, or does it reach the page and do nothing?
 *
 * The page logs every keydown into its own title (`k=...`), so the answer is visible without
 * guessing. The window geometry is recorded too, because another ComputerUse owner is active
 * on this desktop and can move windows underneath a measurement.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const evidenceDir = path.resolve(process.argv[2]);
const pageUrl = pathToFileURL(path.join(evidenceDir, 'cufix-probe-page.html')).href;
const profileDir = path.join(os.tmpdir(), `cufix-edge-diag-${Date.now()}`);

const mod = await import(new URL('../../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);
const call = async (options) => JSON.parse(await mod.runComputerUse(options));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--new-window', pageUrl,
], { detached: true, stdio: 'ignore' });
edge.unref();

try {
  let probe = null;
  for (let i = 0; i < 60 && !probe; i += 1) {
    const listed = await call({ action: 'app_list', includeOccluded: true });
    if (listed.ok === true) probe = (listed.applications || []).find(app => /cufix/i.test(String(app.title)));
    if (!probe) await sleep(700);
  }
  if (!probe) throw new Error('no probe window');
  console.log(`window ${probe.handle} rect=${JSON.stringify(probe.client_rect)}`);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const activated = await call({ action: 'app_activate', windowHandle: probe.handle });
    const before = await call({ action: 'app_list', includeOccluded: true });
    const beforeApp = (before.applications || []).find(app => app.handle.toLowerCase() === probe.handle.toLowerCase());
    const beforeTitle = beforeApp ? String(beforeApp.title) : '';
    const beforeWidth = (/ w=(\d+)/.exec(beforeTitle) || [])[1];

    const key = await call({ action: 'key', windowHandle: probe.handle, key: 'ctrl+-' });
    await sleep(800);
    const after = await call({ action: 'app_list', includeOccluded: true });
    const afterApp = (after.applications || []).find(app => app.handle.toLowerCase() === probe.handle.toLowerCase());
    const afterTitle = afterApp ? String(afterApp.title) : '';
    const afterWidth = (/ w=(\d+)/.exec(afterTitle) || [])[1];
    const keys = (/ k=(.*)$/.exec(afterTitle) || [])[1] || '';

    console.log(`attempt ${attempt}: foreground_verified=${activated.foreground_verified} focus=${key.focus_target_class}@${key.focus_target} changed=${key.focus_changed} width ${beforeWidth} -> ${afterWidth} | page key log: ${keys.slice(-90)}`);
  }
} finally {
  try {
    execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(profileDir)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore', timeout: 30000 });
  } catch { /* disposable */ }
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* disposable */ }
  mod.stopAll();
}
process.exit(0);
