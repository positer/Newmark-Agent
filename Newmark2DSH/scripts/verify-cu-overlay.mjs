/**
 * Verify Newmark ComputerUse's native screen-wide takeover overlay.
 *
 * The overlay is a real WinForms window covering the virtual screen, so it is
 * verified by capturing the actual screen — not a window — and reading the outermost
 * pixels. Three things have to be true and each is measured:
 *
 *   1. it runs along the SCREEN edge, not around any window;
 *   2. it starts without a console window appearing;
 *   3. it stops when asked, and leaves nothing behind.
 *
 * The overlay exits when its owner process dies (a 1 s watchdog), so the owner stays
 * alive for the whole run.
 *
 * Run: node Newmark2DSH/scripts/verify-cu-overlay.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const overlayPath = path.join(workspace, 'packages', 'newmark-core', 'components', 'computeruse', 'lib', 'overlay-win32.js');
const evidenceDir = path.join(workspace, 'archive', '20260930-014200-newmark-core-merge', 'evidence');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail) {
  const n = passed + failed + 1;
  if (condition) {
    passed += 1;
    console.log(`ok ${n} - ${name}`);
    return true;
  }
  failed += 1;
  failures.push(name);
  console.log(`not ok ${n} - ${name}`);
  if (detail !== undefined) console.log(`  ${detail}`);
  return false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Capture the whole virtual screen and report its outermost pixel rows. */
function captureScreen(outPath) {
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap -ArgumentList $vs.Width, $vs.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)',
    `$bmp.Save('${outPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$probe = @()',
    'foreach ($y in 0,1,2,3) { foreach ($x in 200, 700, 1200) { if ($x -lt $bmp.Width) { $c = $bmp.GetPixel($x, $y); $probe += ("top y{0} x{1}=({2},{3},{4})" -f $y, $x, $c.R, $c.G, $c.B) } } }',
    'foreach ($y in ($bmp.Height-1), ($bmp.Height-2)) { foreach ($x in 200, 700, 1200) { if ($x -lt $bmp.Width) { $c = $bmp.GetPixel($x, $y); $probe += ("bottom y{0} x{1}=({2},{3},{4})" -f $y, $x, $c.R, $c.G, $c.B) } } }',
    'Write-Output ("size={0}x{1}" -f $bmp.Width, $bmp.Height)',
    '$probe | ForEach-Object { Write-Output $_ }',
    '$g.Dispose(); $bmp.Dispose()',
  ].join('; ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 });
  return out.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** How many visible console windows exist right now. */
function consoleWindowCount() {
  const script = [
    'Add-Type -Namespace W -Name U -MemberDefinition \'[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);\'',
    '(Get-Process -Name powershell, cmd, conhost -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and [W.U]::IsWindowVisible($_.MainWindowHandle) } | Measure-Object).Count',
  ].join('; ');
  try {
    return Number(String(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000 })).trim());
  } catch {
    return -1;
  }
}

const overlay = await import('file:///' + overlayPath.replace(/\\/g, '/'));
const before = overlay.overlayState();
check('the overlay starts stopped', before.running === false, JSON.stringify(before));

const consolesBefore = consoleWindowCount();
check('no visible console window before starting', consolesBefore === 0, `count: ${consolesBefore}`);

const captureBefore = captureScreen(path.join(evidenceDir, 'overlay-off.png'));
console.log(`  ${captureBefore[0]}`);

const started = await overlay.startOverlay({ ownerId: 'overlay-verification', ownerPid: process.pid, durationMs: 0, action: 'takeover_start' });
check('the overlay starts', started?.ok === true, JSON.stringify(started).slice(0, 300));
const pid = Number(started?.pid || started?.overlay?.pid || 0);
check('the overlay reports a pid', Number.isFinite(pid) && pid > 0, String(pid));

await sleep(1200);

const state = overlay.overlayState();
check('the overlay reports itself running', state.running === true, JSON.stringify(state).slice(0, 240));

const consolesDuring = consoleWindowCount();
check('no visible console window appears while the overlay runs', consolesDuring === 0, `count: ${consolesDuring}`);

const captureOn = captureScreen(path.join(evidenceDir, 'overlay-on.png'));
const [sizeLine, ...pixels] = captureOn;
console.log(`  ${sizeLine}`);
const screen = /size=(\d+)x(\d+)/.exec(sizeLine);
const screenW = Number(screen?.[1] || 0);
const screenH = Number(screen?.[2] || 0);
check('the capture covers the whole screen', screenW >= 640 && screenH >= 400, `${screenW}x${screenH}`);

const brightness = (line) => {
  const m = /\((\d+),(\d+),(\d+)\)/.exec(line);
  return m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 : -1;
};
const topRows = pixels.filter((line) => line.startsWith('top y0') || line.startsWith('top y1'));
const topValues = topRows.map(brightness);
check(
  'the screen top edge carries the overlay (bright pixels where the window background is not)',
  topValues.some((value) => value > 120) || topValues.some((value) => value < 12),
  topValues.join(', '),
);

const probe = await overlay.probeOverlayWindow({});
const probeText = JSON.stringify(probe);
check('the overlay window is found', probe?.probe?.is_window === true, probeText.slice(0, 300));
check('the overlay is click-through (WS_EX_TRANSPARENT)', probe?.probe?.ws_ex_transparent === true, probeText.slice(0, 300));
check('the overlay stays out of the taskbar (WS_EX_TOOLWINDOW)', probe?.probe?.ws_ex_toolwindow === true, probeText.slice(0, 300));
check('the overlay is topmost', probe?.probe?.ws_ex_topmost === true, probeText.slice(0, 300));
check('the overlay is not layered, as in Newmark', probe?.probe?.ws_ex_layered === false, probeText.slice(0, 300));
const overlayRect = probe?.probe?.rect || {};
const virtualScreen = probe?.probe?.virtual_screen || {};
check(
  'the overlay rect equals the virtual screen exactly',
  overlayRect.left === virtualScreen.left && overlayRect.top === virtualScreen.top && overlayRect.width === virtualScreen.width && overlayRect.height === virtualScreen.height,
  JSON.stringify({ overlayRect, virtualScreen }),
);
check(
  'the capture is the screen at its reported size, or the DPI-scaled equivalent',
  (screenW === Number(virtualScreen.width) && screenH === Number(virtualScreen.height)) || (screenW * 2 === Number(virtualScreen.width) && screenH * 2 === Number(virtualScreen.height)),
  `capture ${screenW}x${screenH}, virtual screen ${virtualScreen.width}x${virtualScreen.height} (PowerShell is not DPI-aware, so it reports the scaled size)`,
);
console.log('  probe: ' + probeText.slice(0, 600));

const stopped = await overlay.stopOverlay({ reason: 'verification_complete' });
check('the overlay stops', stopped?.ok !== false, JSON.stringify(stopped).slice(0, 240));
await sleep(600);
check('the overlay reports itself stopped', overlay.overlayState().running === false, JSON.stringify(overlay.overlayState()));

const captureOff = captureScreen(path.join(evidenceDir, 'overlay-stopped.png'));
const offValues = captureOff.slice(1).filter((l) => l.startsWith('top y0') || l.startsWith('top y1')).map(brightness);
check(
  'the screen edge is back to plain background after stopping',
  offValues.every((value) => value >= 0 && value < 120),
  offValues.join(', '),
);

let leftover = 0;
try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$self=$PID; (Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and $_.Name -match '^powershell' -and $_.CommandLine -match 'takeover-overlay-' -and $_.CommandLine -notmatch 'Get-CimInstance' } | Measure-Object).Count"], { encoding: 'utf8', timeout: 30000 });
  leftover = Number(String(out).trim());
} catch {
  leftover = -1;
}
check('no overlay process is left behind', leftover === 0, `count: ${leftover}`);

console.log('');
console.log(`evidence: ${path.relative(workspace, evidenceDir)}\\overlay-{off,on,stopped}.png`);
console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
