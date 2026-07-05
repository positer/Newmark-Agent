import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { spawnSync } from 'child_process';

export interface ComputerUseOptions {
  action: string;
  x?: number;
  y?: number;
  scrollX?: number;
  scrollY?: number;
  button?: string;
  text?: string;
  key?: string;
  targetId?: string;
  appTarget?: string;
  windowHandle?: string;
  durationMs?: number;
  duration_ms?: number;
  maxChars?: number;
  dryRun?: boolean;
  workspacePath: string;
  allowEphemeralVisionImage?: boolean;
  gradientColors?: string[];
  gradientSpeed?: number;
  gradientWidth?: number;
  gradient_colors?: string[];
  gradient_speed?: number;
  gradient_width?: number;
}

interface ObservedElement {
  name: string;
  automation_id: string;
  control_type: string;
  class_name: string;
  process_id: number;
  bbox: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
}

interface SemanticObject extends ObservedElement {
  target_id: string;
  stable_key: string;
  role: string;
  label: string;
  group: string;
  priority: number;
  allowed_actions: string[];
  risk: 'low' | 'medium';
  normalized_bbox: { x: number; y: number; width: number; height: number };
}

let lastObservation: { workspacePath: string; objects: SemanticObject[]; width: number; height: number; at: string } | null = null;
let takeoverOverlayPid: number | null = null;
let lastTakeoverOverlayStyle: { colors?: string[]; speed?: number; width?: number } = {};

interface AppWindowInfo {
  handle: string;
  title: string;
  process_id: number;
  process_name: string;
  class_name: string;
  bbox: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
}

function psQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(script: string, timeout = 30000): { ok: boolean; output: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-computer-use-ps-'));
  const scriptPath = path.join(tempDir, 'run.ps1');
  try {
    fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      encoding: 'utf-8',
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.error) return { ok: false, output: result.error.message + (output ? `\n${output}` : '') };
    if (result.status !== 0) return { ok: false, output: output || `Exit: ${result.status ?? -1}` };
    return { ok: true, output };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

function tempScreenshotDir(): string {
  const dir = path.join(os.tmpdir(), 'newmark-computer-use');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function gradientPalette(input?: string[]): string[] {
  const fallback = ['#00ff88', '#00ccff', '#aa44ff', '#ff4488'];
  const configured = Array.isArray(input) ? input : [];
  const raw = configured.length
    ? configured.map(v => String(v || '').trim()).filter(Boolean)
    : String(process.env.NEWMARK_COMPUTER_USE_GRADIENT || '').split(',').map(v => v.trim()).filter(Boolean);
  return raw.length >= 2 ? raw.slice(0, 6) : fallback;
}

function stopTakeoverOverlay(): void {
  const pid = takeoverOverlayPid;
  takeoverOverlayPid = null;
  const explicitPid = pid && Number.isFinite(pid) && pid > 0 ? Math.floor(pid) : 0;
  const script = [
    '$stopped = 0',
    explicitPid ? `try { Stop-Process -Id ${explicitPid} -Force -ErrorAction SilentlyContinue; $stopped++ } catch {}` : '',
    "$targets = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^powershell(\\.exe)?$' -and $_.CommandLine -like '*takeover-overlay-*.ps1*' }",
    'foreach ($p in $targets) {',
    '  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $stopped++ } catch {}',
    '}',
    'Write-Output "overlay-stopped:$stopped"',
  ].filter(Boolean).join('\r\n');
  runPowerShell(script, 7000);
}

function startTakeoverOverlay(durationMs = 0, input: { colors?: string[]; speed?: number; width?: number } = {}): Record<string, unknown> {
  if (process.platform !== 'win32') return { ok: false, action: 'takeover_start', error: 'Computer Use takeover overlay is Windows-only.' };
  stopTakeoverOverlay();
  lastTakeoverOverlayStyle = { colors: input.colors, speed: input.speed, width: input.width };
  const colors = gradientPalette(input.colors);
  const lifetime = Math.max(0, Math.floor(Number(durationMs || 0)));
  const width = Math.max(1, Math.min(24, Math.floor(Number(input.width || 2))));
  const speedSeconds = Math.max(0.25, Math.min(30, Number(input.speed || 2)));
  const ownerPid = Math.max(1, Math.floor(process.pid || 0));
  const scriptPath = path.join(tempScreenshotDir(), `takeover-overlay-${timestampName()}-${crypto.randomBytes(4).toString('hex')}.ps1`);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class NewmarkOverlayWin32 {',
    '  public const int GWL_EXSTYLE = -20;',
    '  public const int WS_EX_TRANSPARENT = 0x20;',
    '  public const int WS_EX_TOOLWINDOW = 0x80;',
    '  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);',
    '  public const UInt32 SWP_NOSIZE = 0x0001;',
    '  public const UInt32 SWP_NOMOVE = 0x0002;',
    '  public const UInt32 SWP_NOACTIVATE = 0x0010;',
    '  public const UInt32 SWP_SHOWWINDOW = 0x0040;',
    '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);',
    '  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);',
    '  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, UInt32 uFlags);',
    '}',
    '\'@',
    '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    `$colorHex = @(${colors.map(psQuote).join(',')})`,
    '$colors = New-Object System.Collections.Generic.List[System.Drawing.Color]',
    'foreach ($hex in $colorHex) { $colors.Add([System.Drawing.ColorTranslator]::FromHtml($hex)) | Out-Null }',
    `$thick = ${width}`,
    `$speedSeconds = ${speedSeconds.toFixed(3)}`,
    `$ownerPid = ${ownerPid}`,
    '$script:colors = $colors',
    '$script:thick = $thick',
    '$script:ownerPid = $ownerPid',
    '$script:form = New-Object System.Windows.Forms.Form',
    '$script:form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
    '$script:form.ShowInTaskbar = $false',
    '$script:form.TopMost = $true',
    '$script:form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual',
    '$script:form.Bounds = New-Object System.Drawing.Rectangle($bounds.Left, $bounds.Top, $bounds.Width, $bounds.Height)',
    '$regionPath = New-Object System.Drawing.Drawing2D.GraphicsPath',
    '$regionPath.AddRectangle((New-Object System.Drawing.Rectangle(0, 0, $bounds.Width, $script:thick)))',
    '$regionPath.AddRectangle((New-Object System.Drawing.Rectangle(($bounds.Width - $script:thick), 0, $script:thick, $bounds.Height)))',
    '$regionPath.AddRectangle((New-Object System.Drawing.Rectangle(0, ($bounds.Height - $script:thick), $bounds.Width, $script:thick)))',
    '$regionPath.AddRectangle((New-Object System.Drawing.Rectangle(0, 0, $script:thick, $bounds.Height)))',
    '$script:form.Region = New-Object System.Drawing.Region($regionPath)',
    '$regionPath.Dispose()',
    '$script:form.BackColor = [System.Drawing.Color]::Black',
    '$script:stopwatch = [System.Diagnostics.Stopwatch]::StartNew()',
    '$script:form.Add_Shown({',
    '  $style = [NewmarkOverlayWin32]::GetWindowLong($script:form.Handle, [NewmarkOverlayWin32]::GWL_EXSTYLE)',
    '  [NewmarkOverlayWin32]::SetWindowLong($script:form.Handle, [NewmarkOverlayWin32]::GWL_EXSTYLE, $style -bor [NewmarkOverlayWin32]::WS_EX_TRANSPARENT -bor [NewmarkOverlayWin32]::WS_EX_TOOLWINDOW) | Out-Null',
    '  [NewmarkOverlayWin32]::SetWindowPos($script:form.Handle, [NewmarkOverlayWin32]::HWND_TOPMOST, 0, 0, 0, 0, [NewmarkOverlayWin32]::SWP_NOMOVE -bor [NewmarkOverlayWin32]::SWP_NOSIZE -bor [NewmarkOverlayWin32]::SWP_NOACTIVATE -bor [NewmarkOverlayWin32]::SWP_SHOWWINDOW) | Out-Null',
    '  $script:form.Invalidate()',
    '  $script:form.Update()',
    '})',
    '$script:form.Add_Paint({',
    '  param($sender, $e)',
    '  $g = $e.Graphics',
    '  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None',
    '  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighSpeed',
    '  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor',
    '  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half',
    '  $w = [Math]::Max(1, $sender.ClientSize.Width)',
    '  $h = [Math]::Max(1, $sender.ClientSize.Height)',
    '  $count = [Math]::Max(2, $script:colors.Count)',
    '  function Newmark-LerpColor([double]$pos) {',
    '    $wrapped = $pos % $script:colors.Count',
    '    if ($wrapped -lt 0) { $wrapped += $script:colors.Count }',
    '    $idx = [int][Math]::Floor($wrapped)',
    '    $next = ($idx + 1) % $script:colors.Count',
    '    $t = $wrapped - $idx',
    '    $a = $script:colors[$idx]',
    '    $b = $script:colors[$next]',
    '    return [System.Drawing.Color]::FromArgb(',
    '      [int][Math]::Round($a.A + (($b.A - $a.A) * $t)),',
    '      [int][Math]::Round($a.R + (($b.R - $a.R) * $t)),',
    '      [int][Math]::Round($a.G + (($b.G - $a.G) * $t)),',
    '      [int][Math]::Round($a.B + (($b.B - $a.B) * $t))',
    '    )',
    '  }',
    '  $perimeter = [Math]::Max(1.0, (2.0 * $w) + (2.0 * $h))',
    '  $clockwiseOffset = (($script:stopwatch.Elapsed.TotalSeconds / $speedSeconds) * $perimeter) % $perimeter',
    '  function Newmark-ClockwiseBorderColor([double]$distance) {',
    '    $wrappedDistance = ($distance - $clockwiseOffset) % $perimeter',
    '    if ($wrappedDistance -lt 0) { $wrappedDistance += $perimeter }',
    '    return Newmark-LerpColor (($wrappedDistance / $perimeter) * $count)',
    '  }',
    '  $step = [Math]::Max(1, [int][Math]::Min(2, [Math]::Max(1, $script:thick)))',
    '  for ($distance = 0.0; $distance -lt $perimeter; $distance += $step) {',
    '    $color = Newmark-ClockwiseBorderColor ($distance + ($step / 2.0))',
    '    $brush = New-Object System.Drawing.SolidBrush($color)',
    '    try {',
    '      if ($distance -lt $w) {',
    '        $x = [int][Math]::Floor($distance)',
    '        $rw = [Math]::Min($step, $w - $x)',
    '        $g.FillRectangle($brush, $x, 0, $rw, $script:thick)',
    '      } elseif ($distance -lt ($w + $h)) {',
    '        $y = [int][Math]::Floor($distance - $w)',
    '        $rh = [Math]::Min($step, $h - $y)',
    '        $g.FillRectangle($brush, $w - $script:thick, $y, $script:thick, $rh)',
    '      } elseif ($distance -lt ((2.0 * $w) + $h)) {',
    '        $x = [int][Math]::Ceiling($w - ($distance - ($w + $h)))',
    '        $rw = [Math]::Min($step, [Math]::Max(1, $x))',
    '        $left = [Math]::Max(0, $x - $rw)',
    '        $g.FillRectangle($brush, $left, $h - $script:thick, $rw, $script:thick)',
    '      } else {',
    '        $y = [int][Math]::Ceiling($h - ($distance - ((2.0 * $w) + $h)))',
    '        $rh = [Math]::Min($step, [Math]::Max(1, $y))',
    '        $top = [Math]::Max(0, $y - $rh)',
    '        $g.FillRectangle($brush, 0, $top, $script:thick, $rh)',
    '      }',
    '    } finally { $brush.Dispose() }',
    '  }',
    '})',
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = 16',
    '$timer.Add_Tick({',
    '  $script:form.Invalidate()',
    '})',
    '$timer.Start()',
    '$ownerTimer = New-Object System.Windows.Forms.Timer',
    '$ownerTimer.Interval = 1000',
    '$ownerTimer.Add_Tick({',
    '  try {',
    '    if ($script:ownerPid -gt 0 -and -not (Get-Process -Id $script:ownerPid -ErrorAction SilentlyContinue)) {',
    '      $script:form.Close()',
    '      [System.Windows.Forms.Application]::ExitThread()',
    '    }',
    '  } catch {}',
    '})',
    '$ownerTimer.Start()',
    lifetime > 0 ? `$closeTimer = New-Object System.Windows.Forms.Timer; $closeTimer.Interval = ${lifetime}; $closeTimer.Add_Tick({ $script:form.Close(); [System.Windows.Forms.Application]::ExitThread() }); $closeTimer.Start()` : '',
    '$script:form.Show()',
    '[System.Windows.Forms.Application]::Run()',
    'try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue } catch {}',
  ].filter(Boolean).join('\r\n');
  fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');
  const createCommand = [
    `$cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ' + ${psQuote(`"${scriptPath}"`)}`,
    `$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()`,
    '$startup.ShowWindow = 0',
    `$created = ([wmiclass]'Win32_Process').Create($cmd, $null, $startup)`,
    'if ($created.ReturnValue -ne 0) { throw "Win32_Process.Create failed: $($created.ReturnValue)" }',
    '$created.ProcessId',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', createCommand], {
    encoding: 'utf-8',
    timeout: 10000,
    windowsHide: true,
  });
  const pid = Number(String(result.stdout || '').trim().split(/\r?\n/).pop() || 0);
  if (!Number.isFinite(pid) || pid <= 0 || result.status !== 0 || result.error) {
    try { fs.unlinkSync(scriptPath); } catch {}
    return { ok: false, action: 'takeover_start', error: result.error?.message || result.stderr || result.stdout || `overlay start exited ${result.status}` };
  }
  takeoverOverlayPid = pid;
  return { ok: true, action: 'takeover_start', takeover: true, overlay: { pid, owner_pid: ownerPid, duration_ms: lifetime, indicator: 'desktop-edge-dynamic-gradient', mode: 'single-click-through-virtual-screen-overlay', lifecycle: 'owner-process-bound', width_px: width, speed_s: speedSeconds, colors } };
}

function pulseTakeoverOverlay(): void {
  if (process.platform !== 'win32') return;
  if (!takeoverOverlayPid) startTakeoverOverlay(2500, lastTakeoverOverlayStyle);
}

function timestampName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseJsonArray<T>(text: string): T[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as T[];
    if (parsed && typeof parsed === 'object') return [parsed as T];
  } catch {
    // Best effort: UI Automation is advisory; screenshot capture remains authoritative.
  }
  return [];
}

function observeUiAutomation(maxChars: number): { elements: ObservedElement[]; error?: string } {
  const limit = Math.min(Math.max(Math.floor(maxChars || 30000), 1000), 200000);
  const script = [
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    '$root = [System.Windows.Automation.AutomationElement]::RootElement',
    '$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
    '$queue = New-Object System.Collections.Queue',
    '$queue.Enqueue($root)',
    '$items = New-Object System.Collections.Generic.List[object]',
    '$visited = 0',
    'while ($queue.Count -gt 0 -and $items.Count -lt 160 -and $visited -lt 1200) {',
    '  $el = $queue.Dequeue(); $visited++',
    '  try {',
    '    if ($el -ne $root) {',
    '      $r = $el.Current.BoundingRectangle',
    '      $name = [string]$el.Current.Name',
    '      $auto = [string]$el.Current.AutomationId',
    '      if (($name -or $auto) -and $r.Width -gt 1 -and $r.Height -gt 1 -and -not $el.Current.IsOffscreen) {',
    '        $items.Add([pscustomobject]@{',
    '          name=$name;',
    '          automation_id=$auto;',
    '          control_type=$el.Current.ControlType.ProgrammaticName.Replace("ControlType.","");',
    '          class_name=[string]$el.Current.ClassName;',
    '          process_id=[int]$el.Current.ProcessId;',
    '          bbox=[pscustomobject]@{ x=[int]$r.X; y=[int]$r.Y; width=[int]$r.Width; height=[int]$r.Height };',
    '          center=[pscustomobject]@{ x=[int]($r.X + ($r.Width / 2)); y=[int]($r.Y + ($r.Height / 2)) }',
    '        }) | Out-Null',
    '      }',
    '    }',
    '    $child = $walker.GetFirstChild($el)',
    '    while ($child -ne $null) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }',
    '  } catch {}',
    '}',
    '$json = $items | ConvertTo-Json -Depth 5 -Compress',
    `if ($json.Length -gt ${limit}) { $json = $json.Substring(0, ${limit}) }`,
    'Write-Output $json',
  ].join('\r\n');
  const result = runPowerShell(script, 30000);
  if (!result.ok) return { elements: [], error: result.output };
  return { elements: parseJsonArray<ObservedElement>(result.output) };
}

function observeAppWindows(maxChars: number): { apps: AppWindowInfo[]; error?: string } {
  const limit = Math.min(Math.max(Math.floor(maxChars || 30000), 1000), 200000);
  const script = [
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    '$root = [System.Windows.Automation.AutomationElement]::RootElement',
    '$children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)',
    '$items = New-Object System.Collections.Generic.List[object]',
    'foreach ($el in $children) {',
    '  try {',
    '    $r = $el.Current.BoundingRectangle',
    '    $pid = [int]$el.Current.ProcessId',
    '    $proc = ""; try { $proc = (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName } catch {}',
    '    $title = [string]$el.Current.Name',
    '    if ($pid -gt 0 -and ($title -or $proc) -and $r.Width -gt 40 -and $r.Height -gt 40 -and -not $el.Current.IsOffscreen) {',
    '      $items.Add([pscustomobject]@{',
    '        handle=("0x{0:X}" -f [int64]$el.Current.NativeWindowHandle);',
    '        title=$title;',
    '        process_id=$pid;',
    '        process_name=$proc;',
    '        class_name=[string]$el.Current.ClassName;',
    '        bbox=[pscustomobject]@{ x=[int]$r.X; y=[int]$r.Y; width=[int]$r.Width; height=[int]$r.Height };',
    '        center=[pscustomobject]@{ x=[int]($r.X + ($r.Width / 2)); y=[int]($r.Y + ($r.Height / 2)) }',
    '      }) | Out-Null',
    '    }',
    '  } catch {}',
    '}',
    '$json = $items | ConvertTo-Json -Depth 5 -Compress',
    `if ($json.Length -gt ${limit}) { $json = $json.Substring(0, ${limit}) }`,
    'Write-Output $json',
  ].join('\r\n');
  const result = runPowerShell(script, 30000);
  if (!result.ok) return { apps: [], error: result.output };
  return { apps: parseJsonArray<AppWindowInfo>(result.output) };
}

function appMatches(app: AppWindowInfo, target: string, handle?: string): boolean {
  const wantedHandle = String(handle || '').trim().toLowerCase();
  if (wantedHandle && String(app.handle || '').toLowerCase() === wantedHandle) return true;
  const q = normalizeText(target);
  if (!q) return false;
  return normalizeText(app.title).includes(q) || normalizeText(app.process_name).includes(q) || String(app.process_id) === q;
}

function selectAppWindow(target?: string, handle?: string): { app?: AppWindowInfo; apps: AppWindowInfo[]; error?: string } {
  const observed = observeAppWindows(60000);
  const apps = observed.apps;
  if (!target && !handle) return { apps, error: 'app_target, window_handle, process name, title, or process id is required.' };
  const app = apps.find(item => appMatches(item, String(target || ''), handle));
  if (!app) return { apps, error: `No visible application window matched: ${target || handle}.` };
  return { app, apps };
}

function cropScreenshot(workspacePath: string, allowEphemeralVisionImage: boolean, app: AppWindowInfo): Record<string, unknown> {
  const outPath = path.join(tempScreenshotDir(), `app-${timestampName()}-${crypto.randomBytes(4).toString('hex')}.png`);
  const b = app.bbox;
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$x=${Math.floor(b.x)}; $y=${Math.floor(b.y)}; $w=${Math.max(1, Math.floor(b.width))}; $h=${Math.max(1, Math.floor(b.height))}`,
    '$bmp = New-Object System.Drawing.Bitmap $w, $h',
    '$graphics = [System.Drawing.Graphics]::FromImage($bmp)',
    '$graphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w,$h)))',
    `$bmp.Save(${psQuote(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$graphics.Dispose()',
    '$bmp.Dispose()',
    `Write-Output (@{ ok=$true; left=$x; top=$y; width=$w; height=$h } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
  const result = runPowerShell(script, 30000);
  if (!result.ok) return { ok: false, action: 'app_observe', error: result.output, app };
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(result.output); } catch { parsed = { raw: result.output }; }
  const ui = observeUiAutomation(30000);
  const elements = ui.elements.filter(el => {
    const cx = el.center?.x ?? el.bbox.x;
    const cy = el.center?.y ?? el.bbox.y;
    return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
  });
  const objects = semanticObjects(elements, Number(parsed.width || b.width || 1), Number(parsed.height || b.height || 1), workspacePath);
  for (const obj of objects) {
    obj.normalized_bbox = {
      x: Number(((obj.bbox.x - b.x) / Math.max(1, b.width)).toFixed(4)),
      y: Number(((obj.bbox.y - b.y) / Math.max(1, b.height)).toFixed(4)),
      width: Number((obj.bbox.width / Math.max(1, b.width)).toFixed(4)),
      height: Number((obj.bbox.height / Math.max(1, b.height)).toFixed(4)),
    };
  }
  lastObservation = { workspacePath, objects, width: Number(parsed.width || b.width || 1), height: Number(parsed.height || b.height || 1), at: new Date().toISOString() };
  const payload: Record<string, unknown> = {
    ok: true,
    action: 'app_observe',
    app,
    screenshot_path: '[ephemeral application screenshot attached to this tool result when the selected model supports vision; deleted immediately after model input is prepared]',
    screenshot_retention: allowEphemeralVisionImage ? 'ephemeral-delete-after-vision-input' : 'ephemeral-deleted-before-tool-return',
    coordinate_system: 'virtual-screen-pixels',
    perception: {
      mode: 'native-application-screenshot-plus-windows-ui-automation',
      application_scope: 'single-visible-window',
      element_count: elements.length,
      scene_summary: buildSceneSummary(objects, Number(parsed.width || b.width || 1), Number(parsed.height || b.height || 1)),
      elements,
      objects,
      warning: ui.error || undefined,
    },
    ...parsed,
  };
  if (allowEphemeralVisionImage) {
    payload.vision_image_path = outPath;
  } else {
    try { fs.unlinkSync(outPath); } catch {}
  }
  return payload;
}

function activateApp(app: AppWindowInfo, dryRun = false): Record<string, unknown> {
  if (dryRun) return { ok: true, action: 'app_activate', dry_run: true, app };
  pulseTakeoverOverlay();
  const script = [
    'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NativeWindow { [DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\\"user32.dll\\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }"',
    `$h = [IntPtr]${Number.parseInt(String(app.handle || '0').replace(/^0x/i, ''), 16) || 0}`,
    '[NativeWindow]::ShowWindow($h, 9) | Out-Null',
    '[NativeWindow]::SetForegroundWindow($h) | Out-Null',
    `Write-Output (@{ ok=$true; action='app_activate'; handle=${psQuote(app.handle)} } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
  const result = runPowerShell(script, 10000);
  if (!result.ok) return { ok: false, action: 'app_activate', error: result.output, app };
  try {
    const parsed = JSON.parse(result.output);
    parsed.app = app;
    return parsed;
  } catch { return { ok: true, action: 'app_activate', raw: result.output, app }; }
}

function scopedPoint(app: AppWindowInfo, x?: number, y?: number): { x: number; y: number; error?: string } {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    return { x: app.center.x, y: app.center.y };
  }
  const px = nx >= 0 && nx <= 1 ? app.bbox.x + Math.round(app.bbox.width * nx) : app.bbox.x + Math.round(nx);
  const py = ny >= 0 && ny <= 1 ? app.bbox.y + Math.round(app.bbox.height * ny) : app.bbox.y + Math.round(ny);
  if (px < app.bbox.x || px > app.bbox.x + app.bbox.width || py < app.bbox.y || py > app.bbox.y + app.bbox.height) {
    return { x: px, y: py, error: 'app-scoped x/y is outside the selected application window.' };
  }
  return { x: px, y: py };
}

function semanticRole(controlType: string): string {
  const type = String(controlType || '').toLowerCase();
  if (type.includes('button')) return 'button';
  if (type.includes('edit') || type.includes('document')) return 'text';
  if (type.includes('menu')) return 'menu';
  if (type.includes('tab')) return 'tab';
  if (type.includes('list')) return 'list';
  if (type.includes('checkbox')) return 'checkbox';
  if (type.includes('radio')) return 'radio';
  return type || 'control';
}

function allowedActions(role: string): string[] {
  if (role === 'text') return ['click', 'type', 'key', 'scroll'];
  if (role === 'list') return ['click', 'move', 'scroll'];
  if (role === 'checkbox' || role === 'radio' || role === 'button' || role === 'tab' || role === 'menu') return ['click'];
  return ['click', 'move', 'scroll'];
}

function objectRisk(element: ObservedElement): 'low' | 'medium' {
  const marker = `${element.name} ${element.automation_id} ${element.control_type}`.toLowerCase();
  return /delete|remove|format|reset|shutdown|close|付款|支付|删除|移除|重置/.test(marker) ? 'medium' : 'low';
}

function normalizeText(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
}

function bucket(value: number, size = 48): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n / size) : 0;
}

function stableKey(element: ObservedElement, role: string): string {
  const parts = [
    role,
    normalizeText(element.name),
    normalizeText(element.automation_id),
    normalizeText(element.class_name),
    String(element.process_id || 0),
    String(bucket(element.center?.x || element.bbox?.x || 0)),
    String(bucket(element.center?.y || element.bbox?.y || 0)),
  ];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

function intersectionOverUnion(left: ObservedElement['bbox'], right: ObservedElement['bbox']): number {
  const lx2 = left.x + left.width;
  const ly2 = left.y + left.height;
  const rx2 = right.x + right.width;
  const ry2 = right.y + right.height;
  const ix = Math.max(0, Math.min(lx2, rx2) - Math.max(left.x, right.x));
  const iy = Math.max(0, Math.min(ly2, ry2) - Math.max(left.y, right.y));
  const intersection = ix * iy;
  const union = (left.width * left.height) + (right.width * right.height) - intersection;
  return union > 0 ? intersection / union : 0;
}

function reusableTargetId(element: ObservedElement, role: string, key: string, workspacePath: string): string {
  const previous = lastObservation?.workspacePath === workspacePath ? lastObservation.objects : [];
  const label = normalizeText(element.name || element.automation_id);
  for (const candidate of previous) {
    if (candidate.stable_key === key) return candidate.target_id;
    if (candidate.role !== role) continue;
    if (normalizeText(candidate.name || candidate.automation_id) !== label) continue;
    if (intersectionOverUnion(candidate.bbox, element.bbox) >= 0.55) return candidate.target_id;
  }
  return `ui-${key}`;
}

function objectGroup(element: ObservedElement, role: string): string {
  const className = normalizeText(element.class_name);
  if (className) return className;
  const type = normalizeText(element.control_type);
  return type || role || 'control';
}

function objectPriority(element: ObservedElement, role: string, risk: 'low' | 'medium'): number {
  let score = 0;
  if (role === 'text') score += 50;
  if (role === 'button' || role === 'tab' || role === 'menu') score += 35;
  if (role === 'list') score += 25;
  if (element.name) score += 15;
  if (element.automation_id) score += 10;
  if (risk === 'medium') score += 20;
  const area = Math.max(0, element.bbox.width * element.bbox.height);
  if (area > 5000) score += 5;
  return score;
}

function semanticObjects(elements: ObservedElement[], screenWidth: number, screenHeight: number, workspacePath: string): SemanticObject[] {
  const width = Math.max(1, screenWidth || 1);
  const height = Math.max(1, screenHeight || 1);
  return elements.slice(0, 120).map((element, index) => {
    const role = semanticRole(element.control_type);
    const risk = objectRisk(element);
    const key = stableKey(element, role);
    return {
      ...element,
      target_id: reusableTargetId(element, role, key, workspacePath),
      stable_key: key,
      role,
      label: element.name || element.automation_id || `${role}-${index + 1}`,
      group: objectGroup(element, role),
      priority: objectPriority(element, role, risk),
      allowed_actions: allowedActions(role),
      risk,
      normalized_bbox: {
        x: Number((element.bbox.x / width).toFixed(4)),
        y: Number((element.bbox.y / height).toFixed(4)),
        width: Number((element.bbox.width / width).toFixed(4)),
        height: Number((element.bbox.height / height).toFixed(4)),
      },
    };
  });
}

function buildSceneSummary(objects: SemanticObject[], screenWidth: number, screenHeight: number): Record<string, unknown> {
  const roleCounts: Record<string, number> = {};
  for (const obj of objects) roleCounts[obj.role] = (roleCounts[obj.role] || 0) + 1;
  const highPriorityObjects = objects
    .slice()
    .sort((a, b) => b.priority - a.priority || a.label.localeCompare(b.label))
    .slice(0, 12)
    .map(obj => ({
      target_id: obj.target_id,
      label: obj.label,
      role: obj.role,
      group: obj.group,
      risk: obj.risk,
      priority: obj.priority,
      allowed_actions: obj.allowed_actions,
      normalized_bbox: obj.normalized_bbox,
    }));
  return {
    scene_name: 'Windows desktop snapshot',
    screen: { width: screenWidth, height: screenHeight },
    role_counts: roleCounts,
    high_priority_objects: highPriorityObjects,
    action_hint: 'Call observe after actions that may change focus, layout, menus, or dialogs; target_id values are stable across similar consecutive observations when possible.',
  };
}

function resolveTarget(targetId: string, workspacePath: string): { x: number; y: number; target?: SemanticObject; error?: string } | null {
  const id = String(targetId || '').trim();
  if (!id) return null;
  if (!lastObservation || lastObservation.workspacePath !== workspacePath) return { x: 0, y: 0, error: `No observation cache for target_id=${id}. Call computer_use observe first.` };
  const target = lastObservation.objects.find(obj => obj.target_id === id);
  if (!target) return { x: 0, y: 0, error: `target_id not found in latest observation: ${id}.` };
  return { x: target.center.x, y: target.center.y, target };
}

function screenshot(workspacePath: string, allowEphemeralVisionImage: boolean): Record<string, unknown> {
  const outPath = path.join(tempScreenshotDir(), `observe-${timestampName()}-${crypto.randomBytes(4).toString('hex')}.png`);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '$graphics = [System.Drawing.Graphics]::FromImage($bmp)',
    '$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)',
    `$bmp.Save(${psQuote(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$graphics.Dispose()',
    '$bmp.Dispose()',
    'Write-Output (@{ ok=$true; left=$bounds.Left; top=$bounds.Top; width=$bounds.Width; height=$bounds.Height } | ConvertTo-Json -Compress)',
  ].join('\r\n');
  const result = runPowerShell(script, 30000);
  if (!result.ok) return { ok: false, action: 'observe', error: result.output };
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(result.output); } catch { parsed = { raw: result.output }; }
  const ui = observeUiAutomation(30000);
  const screenWidth = Number(parsed.width || 1);
  const screenHeight = Number(parsed.height || 1);
  const objects = semanticObjects(ui.elements, screenWidth, screenHeight, workspacePath);
  lastObservation = { workspacePath, objects, width: screenWidth, height: screenHeight, at: new Date().toISOString() };
  const payload: Record<string, unknown> = {
    ok: true,
    action: 'observe',
    screenshot_path: '[ephemeral screenshot attached to this tool result when the selected model supports vision; deleted immediately after model input is prepared]',
    screenshot_retention: allowEphemeralVisionImage ? 'ephemeral-delete-after-vision-input' : 'ephemeral-deleted-before-tool-return',
    coordinate_system: 'virtual-screen-pixels',
    perception: {
      mode: 'native-screenshot-plus-windows-ui-automation',
      vision_assist: {
        when_model_supports_vision: 'The Agent sends this screenshot as image input together with the UI Automation element tree, so visual recognition and control bounding boxes can be used in the same decision step.',
        fallback_without_vision: 'Use the UI Automation element tree, bbox, center coordinates, and semantic target IDs only; no screenshot file path is retained or exposed.',
      },
      element_count: ui.elements.length,
      scene_summary: buildSceneSummary(objects, screenWidth, screenHeight),
      elements: ui.elements,
      objects,
      object_usage: 'Prefer target_id from scene_summary.high_priority_objects or objects for click/move/scroll when available; it resolves to the latest observed center coordinate and keeps actions tied to a semantic UI object.',
      warning: ui.error || undefined,
      note: 'Inspired by capture-parse-decide-act and MCP-style Computer Control agents: screenshot capture plus native Windows UI Automation text/control bounding boxes, semantic target objects, stable target IDs, high-priority object summaries, normalized bboxes, allowed actions, and risk hints. It does not copy third-party code.',
    },
    ...parsed,
  };
  if (allowEphemeralVisionImage) {
    payload.vision_image_path = outPath;
  } else {
    try { fs.unlinkSync(outPath); } catch {}
  }
  return payload;
}

function wait(durationMs: number): Record<string, unknown> {
  const ms = Math.min(Math.max(Math.floor(durationMs || 1000), 0), 60000);
  const start = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  return { ok: true, action: 'wait', duration_ms: Date.now() - start };
}

function moveOrClick(action: string, x: number, y: number, button: string, dryRun: boolean, target?: SemanticObject): Record<string, unknown> {
  const safeX = Math.floor(Number(x));
  const safeY = Math.floor(Number(y));
  if (!Number.isFinite(safeX) || !Number.isFinite(safeY)) return { ok: false, action, error: 'x and y are required pixel coordinates.' };
  if (dryRun) return { ok: true, action, dry_run: true, x: safeX, y: safeY, button: button || 'left', target: target ? { target_id: target.target_id, label: target.label, role: target.role, risk: target.risk } : undefined };
  const isRight = String(button || 'left').toLowerCase() === 'right';
  const down = isRight ? '0x0008' : '0x0002';
  const up = isRight ? '0x0010' : '0x0004';
  const clickScript = action === 'click'
    ? `[NativeMouse]::mouse_event(${down},0,0,0,0); Start-Sleep -Milliseconds 40; [NativeMouse]::mouse_event(${up},0,0,0,0);`
    : '';
  const script = [
    'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NativeMouse { [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int X, int Y); [DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo); }"',
    `[NativeMouse]::SetCursorPos(${safeX}, ${safeY}) | Out-Null`,
    clickScript,
    `Write-Output (@{ ok=$true; action=${psQuote(action)}; x=${safeX}; y=${safeY}; button=${psQuote(button || 'left')} } | ConvertTo-Json -Compress)`,
  ].filter(Boolean).join('\r\n');
  const result = runPowerShell(script, 15000);
  if (!result.ok) return { ok: false, action, error: result.output };
  try {
    const parsed = JSON.parse(result.output);
    if (target) parsed.target = { target_id: target.target_id, label: target.label, role: target.role, risk: target.risk };
    return parsed;
  } catch { return { ok: true, action, raw: result.output }; }
}

function scrollAt(x: number, y: number, scrollX: number, scrollY: number, dryRun: boolean, target?: SemanticObject): Record<string, unknown> {
  const safeX = Math.floor(Number(x));
  const safeY = Math.floor(Number(y));
  const deltaY = Math.floor(Number(scrollY || 0));
  const deltaX = Math.floor(Number(scrollX || 0));
  if (!Number.isFinite(safeX) || !Number.isFinite(safeY)) return { ok: false, action: 'scroll', error: 'x and y are required pixel coordinates or provide target_id.' };
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (deltaX === 0 && deltaY === 0)) return { ok: false, action: 'scroll', error: 'scroll_x or scroll_y is required.' };
  if (dryRun) return { ok: true, action: 'scroll', dry_run: true, x: safeX, y: safeY, scroll_x: deltaX, scroll_y: deltaY, target: target ? { target_id: target.target_id, label: target.label, role: target.role, risk: target.risk } : undefined };
  const wheel = -deltaY;
  const hwheel = deltaX;
  const script = [
    'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NativeMouse { [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int X, int Y); [DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo); }"',
    `[NativeMouse]::SetCursorPos(${safeX}, ${safeY}) | Out-Null`,
    wheel ? `[NativeMouse]::mouse_event(0x0800,0,0,${wheel},0);` : '',
    hwheel ? `[NativeMouse]::mouse_event(0x1000,0,0,${hwheel},0);` : '',
    `Write-Output (@{ ok=$true; action='scroll'; x=${safeX}; y=${safeY}; scroll_x=${deltaX}; scroll_y=${deltaY} } | ConvertTo-Json -Compress)`,
  ].filter(Boolean).join('\r\n');
  const result = runPowerShell(script, 15000);
  if (!result.ok) return { ok: false, action: 'scroll', error: result.output };
  try {
    const parsed = JSON.parse(result.output);
    if (target) parsed.target = { target_id: target.target_id, label: target.label, role: target.role, risk: target.risk };
    return parsed;
  } catch { return { ok: true, action: 'scroll', raw: result.output }; }
}

function typeText(text: string, dryRun: boolean): Record<string, unknown> {
  const value = String(text || '');
  if (!value) return { ok: false, action: 'type', error: 'text is required.' };
  if (dryRun) return { ok: true, action: 'type', dry_run: true, chars: value.length };
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `[System.Windows.Forms.SendKeys]::SendWait(${psQuote(value)})`,
    `Write-Output (@{ ok=$true; action='type'; chars=${value.length} } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
  const result = runPowerShell(script, 15000);
  if (!result.ok) return { ok: false, action: 'type', error: result.output };
  try { return JSON.parse(result.output); } catch { return { ok: true, action: 'type', raw: result.output }; }
}

function sendKey(key: string, dryRun: boolean): Record<string, unknown> {
  const value = String(key || '').trim();
  if (!value) return { ok: false, action: 'key', error: 'key is required.' };
  if (dryRun) return { ok: true, action: 'key', dry_run: true, key: value };
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `[System.Windows.Forms.SendKeys]::SendWait(${psQuote(value)})`,
    `Write-Output (@{ ok=$true; action='key'; key=${psQuote(value)} } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
  const result = runPowerShell(script, 15000);
  if (!result.ok) return { ok: false, action: 'key', error: result.output };
  try { return JSON.parse(result.output); } catch { return { ok: true, action: 'key', raw: result.output }; }
}

export function runComputerUse(options: ComputerUseOptions): string {
  const action = String(options.action || 'observe').toLowerCase();
  let result: Record<string, unknown>;
  if (process.platform !== 'win32') {
    result = { ok: false, action, error: 'computer_use currently supports native desktop control on Windows only.' };
  } else if (action === 'takeover_start') {
    result = startTakeoverOverlay(Number(options.durationMs || options.duration_ms || 0), {
      colors: options.gradientColors || options.gradient_colors,
      speed: options.gradientSpeed ?? options.gradient_speed,
      width: options.gradientWidth ?? options.gradient_width,
    });
  } else if (action === 'takeover_stop') {
    stopTakeoverOverlay();
    result = { ok: true, action: 'takeover_stop', takeover: false };
  } else if (action === 'observe') {
    result = screenshot(options.workspacePath, !!options.allowEphemeralVisionImage);
  } else if (action === 'app_list') {
    const apps = observeAppWindows(Number(options.maxChars || 60000));
    result = { ok: true, action, applications: apps.apps, count: apps.apps.length, warning: apps.error || undefined };
  } else if (action === 'app_observe') {
    const selected = selectAppWindow(options.appTarget, options.windowHandle);
    result = selected.app
      ? cropScreenshot(options.workspacePath, !!options.allowEphemeralVisionImage, selected.app)
      : { ok: false, action, error: selected.error, applications: selected.apps.slice(0, 20) };
  } else if (action === 'app_activate') {
    const selected = selectAppWindow(options.appTarget, options.windowHandle);
    result = selected.app ? activateApp(selected.app, !!options.dryRun) : { ok: false, action, error: selected.error, applications: selected.apps.slice(0, 20) };
  } else if (action === 'wait') {
    result = wait(Number(options.durationMs || 1000));
  } else if (action === 'move' || action === 'click') {
    const target = resolveTarget(String(options.targetId || ''), options.workspacePath);
    if (target?.error) {
      result = { ok: false, action, error: target.error };
    } else {
      if (!options.dryRun) pulseTakeoverOverlay();
      result = moveOrClick(action, target ? target.x : Number(options.x), target ? target.y : Number(options.y), String(options.button || 'left'), !!options.dryRun, target?.target);
    }
  } else if (action === 'app_click') {
    const selected = selectAppWindow(options.appTarget, options.windowHandle);
    if (!selected.app) result = { ok: false, action, error: selected.error, applications: selected.apps.slice(0, 20) };
    else {
      const point = scopedPoint(selected.app, options.x, options.y);
      if (point.error) result = { ok: false, action, error: point.error, app: selected.app };
      else {
        activateApp(selected.app, !!options.dryRun);
        result = moveOrClick('click', point.x, point.y, String(options.button || 'left'), !!options.dryRun);
        result.action = action;
        result.app = selected.app;
      }
    }
  } else if (action === 'scroll') {
    const target = resolveTarget(String(options.targetId || ''), options.workspacePath);
    if (target?.error) {
      result = { ok: false, action, error: target.error };
    } else {
      if (!options.dryRun) pulseTakeoverOverlay();
      result = scrollAt(target ? target.x : Number(options.x), target ? target.y : Number(options.y), Number(options.scrollX || 0), Number(options.scrollY || 0), !!options.dryRun, target?.target);
    }
  } else if (action === 'app_scroll') {
    const selected = selectAppWindow(options.appTarget, options.windowHandle);
    if (!selected.app) result = { ok: false, action, error: selected.error, applications: selected.apps.slice(0, 20) };
    else {
      const point = scopedPoint(selected.app, options.x, options.y);
      if (point.error) result = { ok: false, action, error: point.error, app: selected.app };
      else {
        activateApp(selected.app, !!options.dryRun);
        result = scrollAt(point.x, point.y, Number(options.scrollX || 0), Number(options.scrollY || 0), !!options.dryRun);
        result.action = action;
        result.app = selected.app;
      }
    }
  } else if (action === 'type') {
    if (!options.dryRun) pulseTakeoverOverlay();
    result = typeText(String(options.text || ''), !!options.dryRun);
  } else if (action === 'app_type') {
    const selected = selectAppWindow(options.appTarget, options.windowHandle);
    if (!selected.app) result = { ok: false, action, error: selected.error, applications: selected.apps.slice(0, 20) };
    else {
      activateApp(selected.app, !!options.dryRun);
      result = typeText(String(options.text || ''), !!options.dryRun);
      result.action = action;
      result.app = selected.app;
    }
  } else if (action === 'key') {
    if (!options.dryRun) pulseTakeoverOverlay();
    result = sendKey(String(options.key || ''), !!options.dryRun);
  } else if (action === 'app_key') {
    const selected = selectAppWindow(options.appTarget, options.windowHandle);
    if (!selected.app) result = { ok: false, action, error: selected.error, applications: selected.apps.slice(0, 20) };
    else {
      activateApp(selected.app, !!options.dryRun);
      result = sendKey(String(options.key || ''), !!options.dryRun);
      result.action = action;
      result.app = selected.app;
    }
  } else {
    result = { ok: false, action, error: `Unknown computer_use action: ${action}` };
  }
  return JSON.stringify(result, null, 2);
}
