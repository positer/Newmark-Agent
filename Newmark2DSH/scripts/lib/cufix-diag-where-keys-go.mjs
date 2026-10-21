/**
 * Where does a keystroke actually go?
 *
 * The `key` action reached no page in the previous probe, yet reported focus on a
 * Chrome_RenderWidgetHostHWND. DSH is Electron, so its own render widget has that class too:
 * this records the foreground window and the focus target by NAME, not just by handle, so the
 * destination is unambiguous.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const evidenceDir = path.resolve(process.argv[2]);
const pageUrl = pathToFileURL(path.join(evidenceDir, 'cufix-probe-page.html')).href;
const profileDir = path.join(os.tmpdir(), `cufix-edge-where-${Date.now()}`);

const mod = await import(new URL('../../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);
const call = async (options) => JSON.parse(await mod.runComputerUse(options));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--new-window', pageUrl,
], { detached: true, stdio: 'ignore' });
edge.unref();

const foregroundNow = async () => {
  await mod.prepareLane('windows', 20000);
  const result = await mod.runInLane('windows', [
    '$fg = [NewmarkCuNative]::GetForegroundWindow()',
    'Write-Output (@{ handle=("0x{0:X}" -f $fg.ToInt64()); title=[NewmarkCuNative]::WindowTitle($fg); class=[NewmarkCuNative]::ClassName($fg); pid=[NewmarkCuNative]::GetProcessId($fg) } | ConvertTo-Json -Compress)',
  ].join('\r\n'), 20000);
  const lines = String(result.output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch { /* keep looking */ } }
  return { error: String(result.output).slice(0, 200) };
};

const pageTitle = async (handle) => {
  const listed = await call({ action: 'app_list', includeOccluded: true });
  const app = (listed.applications || []).find(candidate => candidate.handle.toLowerCase() === handle.toLowerCase());
  return app ? String(app.title) : '(gone)';
};

try {
  let probe = null;
  for (let i = 0; i < 60 && !probe; i += 1) {
    const listed = await call({ action: 'app_list', includeOccluded: true });
    if (listed.ok === true) probe = (listed.applications || []).find(app => /cufix/i.test(String(app.title)));
    if (!probe) await sleep(700);
  }
  if (!probe) throw new Error('no probe window');
  console.log(`probe window ${probe.handle}`);

  const activated = await call({ action: 'app_activate', windowHandle: probe.handle });
  console.log(`activate: ok=${activated.ok} verified=${activated.foreground_verified} handle=${activated.foreground_handle}`);
  console.log(`foreground after activate: ${JSON.stringify(await foregroundNow())}`);
  console.log(`page title: ${(await pageTitle(probe.handle)).slice(0, 90)}`);

  for (const [label, options] of [
    ['desktop key ctrl+0 (window_handle only)', { action: 'key', windowHandle: probe.handle, key: 'ctrl+0' }],
    ['app_key ctrl+0 (app target)', { action: 'app_key', windowHandle: probe.handle, key: 'ctrl+0' }],
    ['desktop key ctrl+- (zoom out)', { action: 'key', windowHandle: probe.handle, key: 'ctrl+-' }],
    ['app_key ctrl+- (zoom out)', { action: 'app_key', windowHandle: probe.handle, key: 'ctrl+-' }],
    ['desktop key ctrl+0 (zoom reset)', { action: 'key', windowHandle: probe.handle, key: 'ctrl+0' }],
  ]) {
    const before = await foregroundNow();
    const result = await call(options);
    await sleep(900);
    const after = await foregroundNow();
    console.log(`--- ${label}`);
    console.log(`    response: ok=${result.ok} error=${result.error_code || 'none'} foreground_verified=${result.foreground_verified} focus=${result.focus_target_class}@${result.focus_target} changed=${result.focus_changed}`);
    console.log(`    foreground before: ${before.handle} ${before.class} pid=${before.pid} "${String(before.title).slice(0, 40)}"`);
    console.log(`    foreground after : ${after.handle} ${after.class} pid=${after.pid} "${String(after.title).slice(0, 40)}"`);
    console.log(`    page title       : ${(await pageTitle(probe.handle)).slice(0, 90)}`);
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
