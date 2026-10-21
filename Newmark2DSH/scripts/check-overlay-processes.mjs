/**
 * Focused check: does `stopOverlay()` leave a powershell.exe behind?
 *
 * Usage: node Newmark2DSH/scripts/check-overlay-processes.mjs [evidence-dir]
 *
 * It lists every powershell.exe / pwsh.exe with its pid, parent and command line at four
 * moments - before anything starts, while the overlay runs, right after stopOverlay(),
 * and after the lanes are stopped - so the count before and after the stop is attributed
 * to a named process instead of being asserted from a bare number.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { prepareLane, runInLane, stopAll } from '../packages/newmark-core/components/computeruse/lib/win32.js';
import { overlayState, startOverlay, stopOverlay } from '../packages/newmark-core/components/computeruse/lib/overlay-win32.js';

const OVERLAY_MODULE_URL = new URL('../packages/newmark-core/components/computeruse/lib/overlay-win32.js', import.meta.url).href;
const evidenceDirectory = path.resolve(process.argv[2] || process.cwd());
const log = { started_at: new Date().toISOString(), moments: {} };

function lastJsonObject(output) {
  const lines = String(output === null || output === undefined ? '' : output).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try { return JSON.parse(lines[index]); } catch { /* keep looking */ }
  }
  return null;
}

async function inventory() {
  const script = [
    "function List-Processes([string]$name) { Get-CimInstance Win32_Process -Filter \"Name='$name'\" -ErrorAction SilentlyContinue | ForEach-Object { @{ pid = [int]$_.ProcessId; parent_pid = [int]$_.ParentProcessId; command_line = [string]$_.CommandLine } } }",
    '$powershell = @(List-Processes "powershell.exe")',
    '$pwsh = @(List-Processes "pwsh.exe")',
    "$overlay = @($powershell | Where-Object { $_.command_line -match 'newmark-cu-takeover-overlay-' })",
    'Write-Output (@{',
    '  powershell_exe = $powershell',
    '  powershell_exe_count = $powershell.Count',
    '  pwsh_exe_count = $pwsh.Count',
    '  overlay_hosts = $overlay',
    '  overlay_host_count = $overlay.Count',
    '} | ConvertTo-Json -Compress -Depth 6)',
  ].join('\r\n');
  const result = await runInLane('action', script, 25000);
  if (!result || result.ok !== true) return { error: String(result ? result.output : 'no result').slice(0, 400) };
  return lastJsonObject(result.output) || { error: 'unreadable inventory' };
}

async function moment(name) {
  const value = await inventory();
  log.moments[name] = value;
  console.log(`--- ${name} ---`);
  console.log(`  powershell.exe count: ${value.powershell_exe_count}, pwsh.exe count: ${value.pwsh_exe_count}, overlay hosts: ${value.overlay_host_count}`);
  for (const item of value.powershell_exe || []) {
    console.log(`  powershell.exe pid=${item.pid} parent=${item.parent_pid} cmd=${String(item.command_line).slice(0, 120)}`);
  }
  return value;
}

await prepareLane('action', 30000);
const before = await moment('before_anything');
const started = await startOverlay({ ownerId: 'process-check' });
await new Promise(resolve => setTimeout(resolve, 1200));
const during = await moment('overlay_running');
const stopped = await stopOverlay({ reason: 'process_check_stop' });
await new Promise(resolve => setTimeout(resolve, 800));
const after = await moment('after_stop_overlay');
stopAll();
await new Promise(resolve => setTimeout(resolve, 1200));
const afterLanes = await moment('after_stopall_lanes');

log.overlay = { started_pid: started.pid, started_ok: started.ok, stopped: { ok: stopped.ok, killed: stopped.killed, swept_stale: stopped.swept_stale }, state: overlayState() };
log.conclusion = {
  overlay_hosts_before: before.overlay_host_count,
  overlay_hosts_during: during.overlay_host_count,
  overlay_hosts_after_stop: after.overlay_host_count,
  powershell_exe_before: before.powershell_exe_count,
  powershell_exe_during: during.powershell_exe_count,
  powershell_exe_after_stop: after.powershell_exe_count,
  powershell_exe_after_stopall: afterLanes.powershell_exe_count,
  overlay_host_left_behind: after.overlay_host_count > 0,
  overlay_host_pid_was: during.overlay_hosts && during.overlay_hosts.length ? during.overlay_hosts[0].pid : null,
  overlay_host_pid_still_present: (after.powershell_exe || []).some(item => item.pid === (during.overlay_hosts && during.overlay_hosts.length ? during.overlay_hosts[0].pid : -1)),
};

/* --- the clean-exit path: the owning process ends, the overlay must go with it --- */

const childScript = path.join(os.tmpdir(), `nmc-overlay-exit-check-${process.pid}.mjs`);
fs.writeFileSync(childScript, [
  '/* Starts an overlay in a fresh process, then exits cleanly on the next tick. */',
  `import { startOverlay, overlayState } from ${JSON.stringify(OVERLAY_MODULE_URL)};`,
  'const started = await startOverlay({ ownerId: "exit-check-child" });',
  'console.log(JSON.stringify({ pid: started.pid, ok: started.ok, running: overlayState().running }));',
  'process.exit(0);',
].join('\n'), 'utf8');
const child = spawn(process.execPath, [childScript], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
let childOutput = '';
child.stdout.on('data', chunk => { childOutput += String(chunk); });
child.stderr.on('data', chunk => { childOutput += String(chunk); });
const childExited = await new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), 90000);
  child.once('exit', code => { clearTimeout(timer); resolve({ code, at: Date.now() }); });
});
const exitedAt = childExited ? childExited.at : Date.now();
let goneAfterMs = null;
let hostCountAfterExit = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  const snapshot = await inventory();
  hostCountAfterExit = snapshot.overlay_host_count;
  if (snapshot.overlay_host_count === 0) { goneAfterMs = Date.now() - exitedAt; break; }
  await new Promise(resolve => setTimeout(resolve, 100));
}
log.clean_exit = {
  child_exit_code: childExited ? childExited.code : null,
  child_output: childOutput.trim().slice(0, 400),
  overlay_hosts_after_owner_exited: hostCountAfterExit,
  ms_from_owner_exit_to_no_overlay_host: goneAfterMs,
  note: 'The window watchdog ticks once per second, so a disappearance well under 1000 ms is the synchronous process-exit hook, not the watchdog.',
};
console.log('--- clean exit ---');
console.log(JSON.stringify(log.clean_exit, null, 2));

log.finished_at = new Date().toISOString();
fs.writeFileSync(path.join(evidenceDirectory, 'overlay-process-check.json'), `${JSON.stringify(log, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(log.conclusion, null, 2));
process.exit(0);
