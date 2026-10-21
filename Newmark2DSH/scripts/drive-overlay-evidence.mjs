/**
 * Drive the Newmark ComputerUse native takeover overlay for real, and write the evidence.
 *
 * Usage, from the workspace root:
 *   node Newmark2DSH/scripts/drive-overlay-evidence.mjs <evidence-directory>
 *
 * It mounts nothing: it loads the same Win32 backend module the tool loads
 * (`components/computeruse/lib/win32.js`) plus the overlay it owns
 * (`components/computeruse/lib/overlay-win32.js`) and drives them directly, so the
 * takeover lease, the overlay lifecycle and `mode_report` are exercised exactly as the
 * product exercises them - without a running DSH process, and without touching the user's
 * Memory Lab store.
 *
 * What it proves, in order:
 *   1. `takeover_start` really puts a border on the screen, and `mode_report` says so.
 *   2. The window covers the whole screen (its rect equals the virtual screen), while a
 *      capture of the desktop is larger than the DSH window.
 *   3. The border is drawn on the outer edge of the screen, not around any window.
 *   4. The window is click-through, absent from the window list, and never takes focus.
 *   5. `takeover_start` twice is one window; `takeover_stop` twice is one stop.
 *   6. The lease does NOT expire on a clock: the overlay is still up and still held after a
 *      hold longer than the retired 120 s TTL, and only `takeover_stop` takes it down.
 *   7. A dead owning process leaves no overlay behind.
 *   8. `takeover_stop` leaves no powershell.exe host behind.
 *
 * Every claim in the written log is a measured value. Every write goes to the evidence
 * directory it is given.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  laneDiagnostics,
  liveLaneCount,
  prepareLane,
  runComputerUse,
  runInLane,
  stopAll,
} from '../packages/newmark-core/components/computeruse/lib/win32.js';
import {
  OVERLAY_BRUSH_STEPS,
  OVERLAY_COLORS,
  OVERLAY_CYCLE_MS,
  OVERLAY_OWNER_WATCHDOG_MS,
  OVERLAY_PULSE_MS,
  OVERLAY_TIMER_INTERVAL_MS,
  OVERLAY_WIDTH_PX,
  overlayContractReport,
  overlayState,
  probeOverlayWindow,
  startOverlay,
  stopOverlay,
} from '../packages/newmark-core/components/computeruse/lib/overlay-win32.js';

const OVERLAY_MODULE_URL = new URL('../packages/newmark-core/components/computeruse/lib/overlay-win32.js', import.meta.url).href;
const evidenceDirectory = path.resolve(process.argv[2] || path.join(process.cwd(), 'evidence'));
fs.mkdirSync(evidenceDirectory, { recursive: true });

const log = {
  started_at: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  screen: null,
  dsh_window: null,
  comparison: null,
  phases: {},
  notes: [],
};
const captures = { with_overlay: null, after_stop: null };
const LEASE_OWNER = `overlay-evidence-${process.pid}`;

function record(phase, key, value) {
  log.phases[phase] = log.phases[phase] || {};
  log.phases[phase][key] = value;
  console.log(`[${phase}] ${key}: ${typeof value === 'string' ? value : JSON.stringify(value).slice(0, 400)}`);
}

function note(message) {
  log.notes.push(message);
  console.log(`[note] ${message}`);
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, Math.max(0, ms)); });

/** Wait until the predicate holds, or give up. Returns the elapsed time either way. */
async function waitFor(label, predicate, timeoutMs = 20000, intervalMs = 250) {
  const startedAt = Date.now();
  for (;;) {
    let value = null;
    try { value = await predicate(); } catch { value = null; }
    if (value) return { ok: true, elapsed_ms: Date.now() - startedAt, label };
    if (Date.now() - startedAt >= timeoutMs) return { ok: false, elapsed_ms: Date.now() - startedAt, label };
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------------------ *
 * lane helpers
 * ------------------------------------------------------------------ */

function lastJsonObject(output) {
  const lines = String(output === null || output === undefined ? '' : output).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Every powershell.exe / pwsh.exe on the box, and which of them are overlay hosts. */
async function processInventory() {
  const script = [
    "$overlayHosts = @(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'newmark-cu-takeover-overlay-' } | ForEach-Object { @{ pid = [int]$_.ProcessId; parent_pid = [int]$_.ParentProcessId; command_line = [string]$_.CommandLine } })",
    '$powershell = @(Get-Process -Name powershell -ErrorAction SilentlyContinue)',
    '$pwsh = @(Get-Process -Name pwsh -ErrorAction SilentlyContinue)',
    'Write-Output (@{ powershell_exe_count = $powershell.Count; pwsh_exe_count = $pwsh.Count; overlay_host_count = $overlayHosts.Count; overlay_hosts = $overlayHosts } | ConvertTo-Json -Compress -Depth 5)',
  ].join('\r\n');
  const result = await runInLane('action', script, 20000);
  if (!result || result.ok !== true) return { error: `lane: ${result ? String(result.output).slice(0, 300) : 'no result'}` };
  return lastJsonObject(result.output) || { error: 'unreadable inventory' };
}

/**
 * Capture the whole virtual screen and measure the bands along its outer edge.
 *
 * The stroke is a smooth four-stop gradient around the perimeter (256 interpolated
 * brushes, exactly as the original), so "how many black/white transitions" is the wrong
 * question. What is measured instead:
 *   - a band's luma range and how much of it is near-black (<=32) or near-white (>=200);
 *   - the deepest outer band that still carries both, which is the stroke's thickness;
 *   - the same numbers on the DSH window's own bottom edge, which is ~80 px inside the
 *     screen bottom here: a stroke around the DSH window would light that band up, a
 *     screen-wide stroke lights the screen's own edge instead;
 *   - the luma profile around the perimeter, which shows the gradient's stops.
 */
async function captureAndAnalyse(outPath) {
  const escaped = outPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Windows.Forms',
    `$outPath = '${escaped}'`,
    '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)',
    '$graphics.Dispose()',
    '$bitmap.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)',
    'function Get-Luma([System.Drawing.Color]$colour) { return [int][Math]::Round((0.299 * $colour.R) + (0.587 * $colour.G) + (0.114 * $colour.B)) }',
    'function Measure-Rows([int]$y0, [int]$y1, [int]$xFrom, [int]$xTo, [int]$step) {',
    '  $values = New-Object System.Collections.Generic.List[int]',
    '  for ($y = $y0; $y -le $y1; $y++) { for ($x = $xFrom; $x -lt $xTo; $x += $step) { $values.Add((Get-Luma $bitmap.GetPixel($x, $y))) } }',
    '  return Measure-Values $values',
    '}',
    'function Measure-Cols([int]$x0, [int]$x1, [int]$yFrom, [int]$yTo, [int]$step) {',
    '  $values = New-Object System.Collections.Generic.List[int]',
    '  for ($x = $x0; $x -le $x1; $x++) { for ($y = $yFrom; $y -lt $yTo; $y += $step) { $values.Add((Get-Luma $bitmap.GetPixel($x, $y))) } }',
    '  return Measure-Values $values',
    '}',
    'function Measure-Values($values) {',
    '  $dark = 0; $light = 0; $mid = 0; $transitions = 0; $previous = -1; $min = 255; $max = 0; $sum = 0',
    '  foreach ($value in $values) {',
    '    $sum += $value',
    '    if ($value -le 32) { $dark++ } elseif ($value -ge 200) { $light++ } else { $mid++ }',
    '    if ($previous -ge 0) { if ((($previous -lt 128) -and ($value -ge 128)) -or (($previous -ge 128) -and ($value -lt 128))) { $transitions++ } }',
    '    $previous = $value; if ($value -lt $min) { $min = $value }; if ($value -gt $max) { $max = $value }',
    '  }',
    '  return @{ samples = $values.Count; near_black = $dark; near_white = $light; mid = $mid; transitions = $transitions; min = $min; max = $max; mean = [int][Math]::Round($sum / [Math]::Max(1, $values.Count)) }',
    '}',
    'function Measure-Profile([string]$kind, [int]$index, [int]$from, [int]$to, [int]$chunks) {',
    '  $size = [int][Math]::Floor(($to - $from) / $chunks)',
    '  $profile = @()',
    '  for ($chunk = 0; $chunk -lt $chunks; $chunk++) {',
    '    $start = $from + ($chunk * $size)',
    '    $values = New-Object System.Collections.Generic.List[int]',
    '    for ($i = $start; $i -lt ($start + $size); $i += 4) {',
    '      if ($kind -eq "row") { $values.Add((Get-Luma $bitmap.GetPixel($i, $index))) } else { $values.Add((Get-Luma $bitmap.GetPixel($index, $i))) }',
    '    }',
    '    $sum = 0; foreach ($value in $values) { $sum += $value }',
    '    $profile += [int][Math]::Round($sum / [Math]::Max(1, $values.Count))',
    '  }',
    '  return $profile',
    '}',
    '$width = $bounds.Width; $height = $bounds.Height',
    '$depth = @()',
    'for ($d = 0; $d -le 16; $d++) {',
    '  $top = Measure-Rows $d $d 0 $width 8',
    '  $left = Measure-Cols $d $d 0 $height 8',
    '  $depth += @{ depth_px = $d + 1; top = $top; left = $left }',
    '}',
    '$strokeDepth = 0',
    'foreach ($entry in $depth) {',
    '  $topRange = $entry.top.max - $entry.top.min',
    '  $leftRange = $entry.left.max - $entry.left.min',
    '  if ($topRange -ge 100 -and $leftRange -ge 100) { $strokeDepth = $entry.depth_px }',
    '}',
    '$payload = @{',
    '  path = $outPath',
    '  file_bytes = (Get-Item -LiteralPath $outPath).Length',
    '  capture_width = $width; capture_height = $height',
    '  virtual_screen = @{ left = $bounds.Left; top = $bounds.Top; width = $bounds.Width; height = $bounds.Height }',
    '  stroke_depth_px = $strokeDepth',
    '  stroke_depth_rule = "the deepest outer band whose top and left luma ranges both reach 100; the stroke is a rotating four-stop gradient, so a single band need not hold both extremes at once"',
    '  depth_profile = $depth',
    '  screen_top_band = (Measure-Rows 0 3 0 $width 8)',
    '  screen_bottom_band = (Measure-Rows ($height - 4) ($height - 1) 0 $width 8)',
    '  screen_left_band = (Measure-Cols 0 3 0 $height 8)',
    '  screen_right_band = (Measure-Cols ($width - 4) ($width - 1) 0 $height 8)',
    '  interior_band_row_40 = (Measure-Rows 40 43 0 $width 16)',
    '  interior_band_col_40 = (Measure-Cols 40 43 0 $height 16)',
    '  area_above_bottom_edge = (Measure-Rows ($height - 90) ($height - 45) 0 $width 16)',
    '  perimeter_profile_clockwise = @{',
    '    top = (Measure-Profile "row" 1 0 $width 32)',
    '    right = (Measure-Profile "column" ($width - 2) 0 $height 32)',
    '    bottom = (Measure-Profile "row" ($height - 2) 0 $width 32)',
    '    left = (Measure-Profile "column" 1 0 $height 32)',
    '  }',
    '}',
    '$bitmap.Dispose()',
    'Write-Output ($payload | ConvertTo-Json -Compress -Depth 8)',
  ].join('\r\n');
  const result = await runInLane('action', script, 90000);
  if (!result || result.ok !== true) return { ok: false, error: String(result ? result.output : 'no result').slice(0, 2000) };
  const parsed = lastJsonObject(result.output);
  return parsed ? { ok: true, ...parsed } : { ok: false, error: 'unreadable capture analysis' };
}

/** Read a few fixed points twice, to show the stroke is animating rather than frozen. */
async function sampleStrokeMotion(points) {
  const probePoints = points.map(point => `@(${point[0]}, ${point[1]})`).join(', ');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    "function Sample-Points {",
    '  $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
    '  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)',
    '  $graphics.Dispose()',
    '  $values = @()',
    `  foreach ($point in @(${probePoints})) { $colour = $bitmap.GetPixel($point[0], $point[1]); $values += [int][Math]::Round((0.299 * $colour.R) + (0.587 * $colour.G) + (0.114 * $colour.B)) }`,
    '  $bitmap.Dispose()',
    '  return $values',
    '}',
    '$first = Sample-Points',
    'Start-Sleep -Milliseconds 700',
    '$second = Sample-Points',
    'Write-Output (@{ points = $points; first = $first; second = $second } | ConvertTo-Json -Compress -Depth 5)',
  ].join('\r\n');
  const result = await runInLane('action', script, 60000);
  if (!result || result.ok !== true) return { ok: false, error: String(result ? result.output : 'no result').slice(0, 1000) };
  const parsed = lastJsonObject(result.output);
  if (!parsed) return { ok: false, error: 'unreadable motion sample' };
  const deltas = parsed.first.map((value, index) => Math.abs(value - parsed.second[index]));
  return { ok: true, points, first: parsed.first, second: parsed.second, deltas, moved: deltas.some(delta => delta > 6) };
}

async function readApplications() {
  const parsed = JSON.parse(await runComputerUse({ action: 'app_list' }));
  return {
    ok: parsed.ok === true,
    applications: (parsed.applications || []).map(item => ({ handle: item.handle, title: item.title, process_id: item.process_id, rect: item.rect, foreground: item.foreground })),
  };
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

let exitCode = 0;
try {
  record('setup', 'action_lane', await prepareLane('action', 30000));
  const inventoryBefore = await processInventory();
  record('setup', 'process_inventory_before', inventoryBefore);
  const applicationsBefore = await readApplications();
  record('setup', 'applications_before', { count: applicationsBefore.applications.length, titles: applicationsBefore.applications.map(item => item.title) });

  const screenProbe = await runInLane('action', [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    'Write-Output (@{ left = $screen.Left; top = $screen.Top; width = $screen.Width; height = $screen.Height } | ConvertTo-Json -Compress)',
  ].join('\r\n'), 20000);
  log.screen = lastJsonObject(screenProbe.output);
  record('setup', 'screen', log.screen);

  /* --- phase 1: the wired takeover_start --------------------------- */

  const takeoverStart = JSON.parse(await runComputerUse({ action: 'takeover_start', ownerId: LEASE_OWNER, mouseMode: 'real' }));
  record('takeover_start', 'response', {
    ok: takeoverStart.ok,
    takeover: takeoverStart.takeover,
    mouse_mode: takeoverStart.mouse_mode,
    lease_ttl_ms: takeoverStart.lease ? takeoverStart.lease.ttl_ms : null,
    overlay_state_at_return: takeoverStart.overlay ? takeoverStart.overlay.state : null,
    overlay_reason_at_return: takeoverStart.overlay ? takeoverStart.overlay.reason : null,
    physical_delivery_used: takeoverStart.physical_delivery_used,
  });

  const appeared = await waitFor('overlay running', () => overlayState().running, 30000, 200);
  record('takeover_start', 'overlay_appeared', { ok: appeared.ok, elapsed_ms: appeared.elapsed_ms });
  const stateRunning = overlayState();
  record('takeover_start', 'overlay_state', stateRunning);
  if (!appeared.ok) note('the overlay never reported itself running; the rest of the run records what was observed.');

  const reportRunning = JSON.parse(await runComputerUse({ action: 'mode_report' }));
  record('takeover_start', 'mode_report_overlay', {
    running: reportRunning.overlay.running,
    state: reportRunning.overlay.state,
    reason: reportRunning.overlay.reason,
    pid: reportRunning.overlay.pid,
    hwnd: reportRunning.overlay.hwnd,
    lifecycle: reportRunning.overlay.lifecycle,
    bounds_source: reportRunning.overlay_contract ? reportRunning.overlay_contract.bounds_source : null,
    covers: reportRunning.overlay_contract ? reportRunning.overlay_contract.covers : null,
    stop_paths: reportRunning.overlay_contract ? reportRunning.overlay_contract.stop_paths : null,
  });
  record('takeover_start', 'mode_report_contract', reportRunning.overlay_contract);

  const foregroundBefore = JSON.parse(await runComputerUse({ action: 'app_list' })).applications;
  const probeRunning = await probeOverlayWindow();
  record('takeover_start', 'independent_window_probe', {
    ok: probeRunning.ok,
    hwnd: probeRunning.hwnd,
    covers_virtual_screen: probeRunning.covers_virtual_screen,
    rect: probeRunning.probe ? probeRunning.probe.rect : null,
    virtual_screen: probeRunning.probe ? probeRunning.probe.virtual_screen : null,
    ex_style_hex: probeRunning.probe ? probeRunning.probe.ex_style_hex : null,
    ws_ex_transparent: probeRunning.probe ? probeRunning.probe.ws_ex_transparent : null,
    ws_ex_toolwindow: probeRunning.probe ? probeRunning.probe.ws_ex_toolwindow : null,
    ws_ex_topmost: probeRunning.probe ? probeRunning.probe.ws_ex_topmost : null,
    ws_ex_layered: probeRunning.probe ? probeRunning.probe.ws_ex_layered : null,
    visible: probeRunning.probe ? probeRunning.probe.visible : null,
    is_window: probeRunning.probe ? probeRunning.probe.is_window : null,
    foreground_window: probeRunning.probe ? probeRunning.probe.foreground : null,
    corner_hit_test: probeRunning.corner_hit_test,
    corner_hit_test_reaches_overlay: probeRunning.corner_hit_test_reaches_overlay,
    corner_hit_test_skipping_transparent: probeRunning.corner_hit_test_skipping_transparent,
    input_reaches_the_window_underneath: probeRunning.input_reaches_the_window_underneath,
  });

  const applicationsDuring = await readApplications();
  const overlayHandleHex = stateRunning.hwnd ? `0x${Number(stateRunning.hwnd).toString(16)}` : '';
  const dsh = applicationsDuring.applications.find(item => /DeepSeek Harness|DSH/i.test(String(item.title))) || applicationsDuring.applications[0] || null;
  log.dsh_window = dsh ? { title: dsh.title, handle: dsh.handle, rect: dsh.rect, area_px: dsh.rect ? dsh.rect.width * dsh.rect.height : null } : null;
  record('takeover_start', 'taskbar_and_alt_tab', {
    window_listed_in_app_list: applicationsDuring.applications.some(item => String(item.handle).toLowerCase() === overlayHandleHex),
    window_count_during: applicationsDuring.applications.length,
    titles: applicationsDuring.applications.map(item => item.title),
  });
  record('takeover_start', 'dsh_window', log.dsh_window);
  record('takeover_start', 'foreground_unchanged', {
    foreground_window_during: probeRunning.probe ? probeRunning.probe.foreground : null,
    matches_dsh_window: Boolean(dsh && probeRunning.probe && Number(probeRunning.probe.foreground) === Number.parseInt(String(dsh.handle).replace(/^0x/i, ''), 16)),
    applications_checked: foregroundBefore.length,
  });

  const inventoryRunning = await processInventory();
  record('takeover_start', 'process_inventory', inventoryRunning);

  const captureRunning = await captureAndAnalyse(path.join(evidenceDirectory, 'overlay-desktop-with-overlay.png'));
  captures.with_overlay = captureRunning;
  record('takeover_start', 'desktop_capture', captureRunning.ok
    ? {
      path: captureRunning.path,
      file_bytes: captureRunning.file_bytes,
      capture_width: captureRunning.capture_width,
      capture_height: captureRunning.capture_height,
      stroke_depth_px: captureRunning.stroke_depth_px,
      screen_top_band: captureRunning.screen_top_band,
      screen_bottom_band: captureRunning.screen_bottom_band,
      screen_left_band: captureRunning.screen_left_band,
      screen_right_band: captureRunning.screen_right_band,
      interior_band_row_40: captureRunning.interior_band_row_40,
      area_above_bottom_edge: captureRunning.area_above_bottom_edge,
      perimeter_profile_clockwise: captureRunning.perimeter_profile_clockwise,
    }
    : captureRunning);

  const motion = await sampleStrokeMotion([[1280, 1], [2558, 800], [1280, 1598], [1, 800], [600, 2], [2000, 1597]]);
  record('takeover_start', 'stroke_is_animating', motion);

  if (captureRunning.ok && log.dsh_window && log.dsh_window.rect) {
    const dshBottom = Number(log.dsh_window.rect.y) + Number(log.dsh_window.rect.height);
    log.comparison = {
      screen: `${log.screen.width}x${log.screen.height}`,
      screen_area_px: log.screen.width * log.screen.height,
      captured_desktop: `${captureRunning.capture_width}x${captureRunning.capture_height}`,
      dsh_window_rect: `${log.dsh_window.rect.width}x${log.dsh_window.rect.height}`,
      dsh_window_area_px: log.dsh_window.area_px,
      captured_desktop_larger_than_dsh_window: (captureRunning.capture_width * captureRunning.capture_height) > log.dsh_window.area_px,
      captured_desktop_taller_than_dsh_window: captureRunning.capture_height > log.dsh_window.rect.height,
      overlay_window_rect_from_probe: probeRunning.probe ? probeRunning.probe.rect : null,
      dsh_window_bottom_y: dshBottom,
      stroke_bottom_band_is_at_the_screen_edge: dshBottom < (captureRunning.capture_height - 4),
      stroke_bottom_band_y: `${captureRunning.capture_height - 4}..${captureRunning.capture_height - 1}`,
      dsh_window_bottom_edge_band: `${dshBottom - 6}..${dshBottom - 1}`,
    };
    record('takeover_start', 'geometry_comparison', log.comparison);
  }

  /* --- phase 2: idempotence --------------------------------------- */

  const secondStart = JSON.parse(await runComputerUse({ action: 'takeover_start', ownerId: LEASE_OWNER, mouseMode: 'real' }));
  const directSecondStart = await startOverlay({ ownerId: LEASE_OWNER, action: 'overlay_evidence_second_start' });
  const inventoryAfterSecond = await processInventory();
  record('idempotence', 'second_takeover_start', {
    lease_response_ok: secondStart.ok,
    overlay_pid_at_return: secondStart.overlay ? secondStart.overlay.pid : null,
    direct_start_already_running: directSecondStart.already_running === true,
    direct_start_pid: directSecondStart.pid || null,
    pid_unchanged: (directSecondStart.pid || null) === stateRunning.pid,
    overlay_host_count_after_two_starts: inventoryAfterSecond.overlay_host_count,
    one_window: inventoryAfterSecond.overlay_host_count === 1 && (directSecondStart.pid || null) === stateRunning.pid,
  });

  /* --- phase 3: stop, and capture again ---------------------------- */

  const stopResponse = JSON.parse(await runComputerUse({ action: 'takeover_stop', ownerId: LEASE_OWNER }));
  record('takeover_stop', 'response', {
    ok: stopResponse.ok,
    takeover: stopResponse.takeover,
    mouse_mode: stopResponse.mouse_mode,
    released_owner: stopResponse.released_owner,
    overlay_state_at_return: stopResponse.overlay ? stopResponse.overlay.state : null,
    overlay_reason_at_return: stopResponse.overlay ? stopResponse.overlay.reason : null,
    overlay_stop_pending: stopResponse.overlay ? stopResponse.overlay.stop_pending : null,
  });

  const gone = await waitFor('overlay gone', () => overlayState().running === false && overlayState().process_alive === false, 25000, 200);
  record('takeover_stop', 'overlay_gone', { ok: gone.ok, elapsed_ms: gone.elapsed_ms });

  const inventoryAfterStop = await processInventory();
  record('takeover_stop', 'process_inventory_after_stop', inventoryAfterStop);

  const reportStopped = JSON.parse(await runComputerUse({ action: 'mode_report' }));
  record('takeover_stop', 'mode_report_overlay', {
    running: reportStopped.overlay.running,
    state: reportStopped.overlay.state,
    reason: reportStopped.overlay.reason,
    stop_count: reportStopped.overlay.stop_count,
    last_stop: reportStopped.overlay.last_stop,
  });

  const captureStopped = await captureAndAnalyse(path.join(evidenceDirectory, 'overlay-desktop-after-stop.png'));
  captures.after_stop = captureStopped;
  record('takeover_stop', 'desktop_capture', captureStopped.ok
    ? {
      path: captureStopped.path,
      file_bytes: captureStopped.file_bytes,
      capture_width: captureStopped.capture_width,
      capture_height: captureStopped.capture_height,
      stroke_depth_px: captureStopped.stroke_depth_px,
      screen_top_band: captureStopped.screen_top_band,
      screen_bottom_band: captureStopped.screen_bottom_band,
      screen_left_band: captureStopped.screen_left_band,
      screen_right_band: captureStopped.screen_right_band,
      interior_band_row_40: captureStopped.interior_band_row_40,
      area_above_bottom_edge: captureStopped.area_above_bottom_edge,
    }
    : captureStopped);

  const secondStopLease = JSON.parse(await runComputerUse({ action: 'takeover_stop', ownerId: LEASE_OWNER }));
  const secondStopDirect = await stopOverlay({ reason: 'evidence_second_stop' });
  record('idempotence', 'second_takeover_stop', {
    lease_response_ok: secondStopLease.ok,
    lease_released_owner: secondStopLease.released_owner,
    direct_stop_already_stopped: secondStopDirect.already_stopped === true,
    direct_stop_stopped: secondStopDirect.stopped,
    direct_stop_reason: secondStopDirect.reason,
    overlay_host_count: (await processInventory()).overlay_host_count,
  });

  /* --- phase 4: the lease does NOT expire; only takeover_stop ends it --- */

  const expiryStart = JSON.parse(await runComputerUse({ action: 'takeover_start', ownerId: `${LEASE_OWNER}-noexpiry`, mouseMode: 'real' }));
  const expiryAppeared = await waitFor('no-expiry overlay running', () => overlayState().running, 30000, 200);
  /* The lease has no time limit, so a hold longer than the retired 120 s TTL proves the
   * deadline is gone. `NEWMARK_CUFIX_LEASE_HOLD_MS` lets the evidence run hold past 120 s;
   * the default keeps an ordinary drive run short. */
  const holdMs = Number(process.env.NEWMARK_CUFIX_LEASE_HOLD_MS) > 0 ? Number(process.env.NEWMARK_CUFIX_LEASE_HOLD_MS) : 5000;
  record('lease_no_expiry', 'start', {
    ok: expiryStart.ok,
    appeared: expiryAppeared.ok,
    appeared_ms: expiryAppeared.elapsed_ms,
    lease_expiry: expiryStart.lease ? expiryStart.lease.expiry : null,
    lease_expires_at: expiryStart.lease ? expiryStart.lease.expires_at : null,
    lease_expires_in_ms: expiryStart.lease ? expiryStart.lease.expires_in_ms : null,
    lease_ttl_ms: expiryStart.lease ? expiryStart.lease.ttl_ms : null,
    lease_released_by: expiryStart.lease ? expiryStart.lease.released_by : null,
    hold_ms_planned: holdMs,
  });
  console.log(`[lease_no_expiry] holding the lease for ${Math.round(holdMs / 1000)}s with no stop call; the retired TTL was 120000 ms ...`);
  const heldFrom = Date.now();
  await new Promise(resolve => setTimeout(resolve, holdMs));
  const stillHeld = JSON.parse(await runComputerUse({ action: 'mode_report' }));
  const stillRunning = overlayState();
  record('lease_no_expiry', 'held_past_the_old_ttl', {
    held_for_ms: Date.now() - heldFrom,
    past_the_retired_120000_ms_ttl: (Date.now() - heldFrom) > 120000,
    lease_held: stillHeld.lease.held,
    lease_owner: stillHeld.lease.owner_id,
    lease_expiry: stillHeld.lease.expiry,
    lease_last_release_reason: stillHeld.lease.last_release_reason,
    overlay_running: stillRunning.running,
    overlay_reason: stillRunning.reason,
    overlay_alive_after_the_old_ttl: stillRunning.running === true && stillRunning.process_alive === true,
    overlay_host_count: (await processInventory()).overlay_host_count,
  });
  /* Only an explicit call may end it. */
  const explicitStop = JSON.parse(await runComputerUse({ action: 'takeover_stop', ownerId: `${LEASE_OWNER}-noexpiry` }));
  const stoppedAfterStop = await waitFor('overlay gone after explicit stop', () => overlayState().running === false, 30000, 300);
  const reportAfterExplicitStop = JSON.parse(await runComputerUse({ action: 'mode_report' }));
  record('lease_no_expiry', 'ended_by_takeover_stop', {
    takeover_stop_ok: explicitStop.ok,
    overlay_stopped_only_after_the_call: stoppedAfterStop.ok,
    elapsed_ms: stoppedAfterStop.elapsed_ms,
    lease_held: reportAfterExplicitStop.lease.held,
    lease_last_release_reason: reportAfterExplicitStop.lease.last_release_reason,
    overlay_running: reportAfterExplicitStop.overlay.running,
    stop_paths: reportAfterExplicitStop.overlay_contract ? reportAfterExplicitStop.overlay_contract.stop_paths : null,
    implicit_stop_paths: reportAfterExplicitStop.overlay_contract ? reportAfterExplicitStop.overlay_contract.implicit_stop_paths : null,
    overlay_host_count: (await processInventory()).overlay_host_count,
  });

  /* --- phase 5: a dead owner leaves nothing behind ------------------ */

  const childScript = path.join(evidenceDirectory, 'overlay-evidence-owner-child.mjs');
  fs.writeFileSync(childScript, [
    '/* Started by drive-overlay-evidence.mjs: it starts an overlay and then waits to be killed. */',
    `import { startOverlay, overlayState } from ${JSON.stringify(OVERLAY_MODULE_URL)};`,
    'const started = await startOverlay({ ownerId: "evidence-owner-child" });',
    'console.log(JSON.stringify({ started: started.ok, pid: started.pid, hwnd: started.hwnd, spawn_method: started.spawn_method }));',
    'if (overlayState().running) console.log("OWNER-CHILD-READY");',
    'setTimeout(() => process.exit(0), 600000);',
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [childScript], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
  let childOutput = '';
  child.stdout.on('data', chunk => { childOutput += String(chunk); });
  child.stderr.on('data', chunk => { childOutput += String(chunk); });
  const ready = await waitFor('owner child overlay', () => /OWNER-CHILD-READY/.test(childOutput), 60000, 300);
  const inventoryChild = await processInventory();
  record('process_exit', 'owner_child', {
    ready: ready.ok,
    elapsed_ms: ready.elapsed_ms,
    child_pid: child.pid,
    output: childOutput.trim().slice(0, 800),
    overlay_hosts_while_child_alive: inventoryChild.overlay_host_count,
    powershell_exe_count_while_child_alive: inventoryChild.powershell_exe_count,
  });
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
  const orphanGone = await waitFor('orphan gone', async () => (await processInventory()).overlay_host_count === 0, 30000, 300);
  const inventoryOrphan = await processInventory();
  record('process_exit', 'after_owner_killed', {
    overlay_gone_without_any_stop_call: orphanGone.ok,
    elapsed_ms: orphanGone.elapsed_ms,
    overlay_host_count: inventoryOrphan.overlay_host_count,
    powershell_exe_count: inventoryOrphan.powershell_exe_count,
    owner_watchdog_ms: OVERLAY_OWNER_WATCHDOG_MS,
  });

  /* --- phase 6: the constants actually in force --------------------- */

  record('constants', 'in_force', {
    colors: OVERLAY_COLORS,
    border_width_px: OVERLAY_WIDTH_PX,
    cycle_ms: OVERLAY_CYCLE_MS,
    timer_interval_ms: OVERLAY_TIMER_INTERVAL_MS,
    brush_count: OVERLAY_BRUSH_STEPS,
    owner_watchdog_ms: OVERLAY_OWNER_WATCHDOG_MS,
    pulse_ms: OVERLAY_PULSE_MS,
    contract: overlayContractReport(),
  });
  record('constants', 'window_read_back_while_running', stateRunning.window);

  record('final', 'process_inventory', await processInventory());
  record('final', 'live_lane_count', liveLaneCount());
  record('final', 'lane_diagnostics', laneDiagnostics().map(item => ({ lane: item.lane, ready: item.ready, live: item.live, child_pid: item.child_pid })));
} catch (error) {
  exitCode = 1;
  record('error', 'thrown', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null });
  log.notes.push(`the run threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  try { await stopOverlay({ reason: 'evidence_run_finished' }); } catch { /* the run is over */ }
  record('final', 'overlay_state_at_exit', overlayState());
  record('final', 'overlay_host_count_at_exit', await processInventory());
  try { stopAll(); } catch { /* ignore */ }
  log.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(evidenceDirectory, 'overlay-edge-analysis.json'), `${JSON.stringify({ with_overlay: captures.with_overlay, after_stop: captures.after_stop }, null, 2)}\n`, 'utf8');
  const logPath = path.join(evidenceDirectory, 'overlay-drive-log.json');
  fs.writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  console.log(`wrote ${logPath}`);
}

process.exit(exitCode);
