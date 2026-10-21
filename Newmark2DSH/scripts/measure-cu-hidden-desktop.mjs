#!/usr/bin/env node
/**
 * measure-cu-hidden-desktop.mjs 鈥?Phase 1: the measured usability evidence for a
 * hidden Windows desktop as a capability of the *shipped* ComputerUse component.
 *
 * =====================================================================================
 * WHY THIS IS NOT PART OF THE GATE
 * =====================================================================================
 *
 * It creates a real desktop, launches a real process onto it, and posts real input at it.
 * That is only acceptable where the machine's owner has asked for exactly that, so it is
 * hand-invoked and never a gate step. `verify-computeruse-output-boundary.mjs` asserts the
 * component spawns nothing when the gate runs unattended; this script is the deliberate
 * opposite of that rule and lives outside the gate for that reason.
 *
 * WHAT IT MEASURES, AND WHY EACH ONE IS A VALUE RATHER THAN A SENTENCE
 * -----------------------------------------------------------------------------------
 *
 *   geometry        the interactive desktop's screen metrics, so "the hidden desktop has
 *                   the same parameters as the current monitor" is a comparison and not a
 *                   belief.
 *   reachability    whether a lane process 鈥?not the creating process 鈥?can open the
 *                   desktop by name and enumerate what is on it.
 *   launch          create the desktop, launch a process onto it by `lpDesktop`, report the
 *                   window station and desktop the child really landed on.
 *   bind + capture  the target's handle, class and client rect as the component reports
 *                   them, and `PrintWindow(hwnd,hdc,2)` across desktops with the pixels
 *                   counted rather than assumed.
 *   delivery effect posted `WM_LBUTTONDOWN`/`WM_CHAR`/`WM_KEYDOWN`/`WM_MOUSEWHEEL` accepted
 *                   by the target, AND the effect read back two independent ways: the
 *                   application's own state file, and the pixels inside its rectangle.
 *   real desktop    window set, foreground handle and cursor position before and after,
 *                   taken from outside the component.
 *   surface         the whole hidden desktop, three ways, each labelled with whether the
 *                   call succeeded and what the bytes actually were.
 *   virtual cursor  where the component's own virtual pointer is after each action.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 *   - It never names a process class in cleanup. Every process it starts is tracked by the
 *     pid the launcher returned and terminated by that pid from that root; the desktop it
 *     creates is destroyed by name afterwards, and both are reported in the receipt.
 *   - It writes nothing under `C:\Users\12252\.Newmark`. Its artifacts go to
 *     `evidence/cu-hidden-desktop/<stamp>/` and to `%TEMP%\nm-cu-hidden\`.
 *   - It imports `packages/newmark-core/components/computeruse/lib/win32.js` from the
 *     repository, never `~/.dsh/profiles/desktop/node_modules/newmark2dsh`. The receipt
 *     records which file it loaded.
 *
 * Invoke:
 *     node Newmark2DSH/scripts/measure-cu-hidden-desktop.mjs
 *     node Newmark2DSH/scripts/measure-cu-hidden-desktop.mjs --keep   (leave the desktop up)
 *
 * Exit codes: 0 the measurement completed (the verdict is in the receipt, not the exit
 *             code); 1 the measurement could not run; 2 cleanup did not verify.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const COMPUTERUSE_DIR = path.join(REPO, 'packages', 'newmark-core', 'components', 'computeruse');
const COMPONENT_ENTRY = path.join(COMPUTERUSE_DIR, 'lib', 'win32.js');
const KEEP = process.argv.includes('--keep');

/**
 * The removed-handling control.
 *
 * `--control-old-read` loads the SAME lane with one thing put back: the desktop-scoped
 * validity read the port shipped before this phase (IsWindow inside the ownership state),
 * in place of the desktop-agnostic one that replaced it. Nothing else differs - same script,
 * same application, same desktop, same component - so the two runs are a single-variable
 * comparison and the difference between them is the desktop handling and nothing else.
 *
 * The patch is applied to a throwaway COPY of the component tree, in a directory this run
 * creates and reports; the repository file is never opened for writing. The receipt carries
 * its sha256 before and after precisely so that claim is checked rather than asserted.
 */
const CONTROL_OLD_READ = process.argv.includes('--control-old-read');
const MOUSE_LIVE_CALL = 'return WindowIsLive(hWnd) && PostMessage(hWnd, msg, new UIntPtr(wParam), new IntPtr(lParam));';
const MOUSE_OLD_CALL = 'return IsWindow(hWnd) && PostMessage(hWnd, msg, new UIntPtr(wParam), new IntPtr(lParam));';

/** The shell the component's lanes will use. Pinned to the real PowerShell 7 install: the
 *  WindowsApps entry on PATH is a 0-byte app-execution alias, and the component's own
 *  resolver takes the first pwsh.exe it finds on PATH. */
const PWSH = process.env.NM_HIDDEN_PWSH || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'PowerShell', '7', 'pwsh.exe');
if (fs.existsSync(PWSH)) process.env.NEWMARK_CU_POWERSHELL = PWSH;

const CSC = path.join(process.env.WINDIR || 'C:\\WINDOWS', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(REPO, 'evidence', 'cu-hidden-desktop', STAMP);
fs.mkdirSync(OUT, { recursive: true });
const CAPTURES = path.join(OUT, 'captures');
fs.mkdirSync(CAPTURES, { recursive: true });

/** The scratch the launched application writes its own state into (readable from both
 *  desktops: it is the same TEMP directory for the same user). */
const SCRATCH = path.join(process.env.TEMP || '.', 'nm-cu-hidden');
fs.mkdirSync(SCRATCH, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line = '') => process.stdout.write(String(line) + '\n');
const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

const COMPONENT_SHA_BEFORE = createHash('sha256').update(fs.readFileSync(COMPONENT_ENTRY)).digest('hex');

/**
 * Compose the one variant of the lane the normalizer has to keep byte-identical.
 *
 * Each substitution is asserted to have hit exactly once before it is applied. A patch that
 * silently matched nothing would load the FIXED lane under the control's name and the control
 * would then "pass" while measuring the opposite of what it claims - the exact failure this
 * whole line of work exists to avoid.
 */
function composeOldReadVariant(source) {
  const replacements = [
    ['if (!WindowIsLive(hWnd)) return 1;', 'if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return 1;'],
    [MOUSE_LIVE_CALL, MOUSE_OLD_CALL],
    ['if (!WindowIsLive(hWnd) || !GetClientRect(hWnd, out client)) return false;', 'if (!IsWindow(hWnd) || !GetClientRect(hWnd, out client)) return false;'],
    ['if ([NewmarkCuNative]::WindowIsLive($root)) {', 'if ([NewmarkCuNative]::IsWindow($root)) {'],
  ];
  let patched = source;
  const applied = [];
  for (const [from, to] of replacements) {
    const hits = patched.split(from).length - 1;
    if (hits !== 1) throw new Error(`the removed-handling control cannot be composed: ${hits} matches for ${JSON.stringify(from.slice(0, 60))}`);
    patched = patched.split(from).join(to);
    applied.push(from.slice(0, 48));
  }
  return { patched, applied };
}

let mod;
let CONTROL = { old_read: CONTROL_OLD_READ, applied: [], dir: null, composed_sha256: null };
if (CONTROL_OLD_READ) {
  const { patched, applied } = composeOldReadVariant(fs.readFileSync(COMPONENT_ENTRY, 'utf8'));
  /* A copy of the whole component tree, not one file: the lane's imports are relative, and a
     lone file in a temp directory would resolve them against nothing. */
  const variant = path.join(OUT, 'variant-old-read');
  fs.cpSync(COMPUTERUSE_DIR, variant, { recursive: true });
  const variantEntry = path.join(variant, 'lib', 'win32.js');
  fs.writeFileSync(variantEntry, patched, 'utf8');
  CONTROL.applied = applied;
  CONTROL.dir = variant;
  CONTROL.composed_sha256 = createHash('sha256').update(patched).digest('hex');
  mod = await import(new URL(`file://${variantEntry.replace(/\\/g, '/')}`));
} else {
  mod = await import(new URL(`file://${COMPONENT_ENTRY.replace(/\\/g, '/')}`));
}
const COMPONENT_SHA_AFTER_LOAD = createHash('sha256').update(fs.readFileSync(COMPONENT_ENTRY)).digest('hex');
/**
 * The System.Drawing a PowerShell 7 lane can actually compile against.
 *
 * On PowerShell 7 `Add-Type` is Roslyn, not the .NET Framework compiler: `System.Drawing`
 * is a type-forwarder to `System.Drawing.Common`, and a bare `Add-Type -TypeDefinition`
 * fails with CS1069 unless the real assembly is named. Both the framework assembly that
 * carries the primitives and the `Common` assembly that carries `Bitmap` are resolved here,
 * once, from the PowerShell installation itself so nothing is guessed.
 */
const DRAWING_REFS = (() => {
  const home = path.dirname(PWSH);
  const wanted = ['System.Drawing.Common.dll', 'System.Drawing.Primitives.dll'];
  const found = [];
  for (const name of wanted) {
    for (const candidate of [path.join(home, name), path.join(home, 'ref', name)]) {
      if (fs.existsSync(candidate)) { found.push(candidate); break; }
    }
  }
  return found;
})();

/**
 * The PowerShell that compiles one C# block in a lane, with the drawing assemblies named
 * when the block needs them.
 *
 * On PowerShell 7 Add-Type is Roslyn: System.Drawing is a type-forwarder to
 * System.Drawing.Common, and a bare Add-Type -TypeDefinition fails with CS1069 unless the
 * real assembly is on the reference list. Naming the assemblies costs nothing on Windows
 * PowerShell, which ignores a reference it already has.
 */
function addTypeLines(encoded, typeName, needsDrawing) {
  const referenceList = DRAWING_REFS.map((entry) => `"${entry}"`).join(', ');
  const lines = [`$__drawingRefs = @(${referenceList})`];
  if (needsDrawing) {
    lines.push(
      '$__forms = [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms")',
      '$__drawing = [System.Reflection.Assembly]::LoadWithPartialName("System.Drawing")',
      '$__refs = @($__forms.Location, $__drawing.Location) + $__drawingRefs',
    );
  } else {
    lines.push('$__refs = @()');
  }
  lines.push(
    "$__source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
    encoded,
    "'@))",
    /* A compile failure inside this block used to take the whole lane process with it, and the
       caller then saw only "lane exited (0)" - with the compiler's own words, which name the
       line and the reason, gone. Catching it here and rethrowing ONE string keeps them: a
       measurement that cannot say why its probe did not build cannot be debugged from its own
       receipt. */
    'try {',
    `  if (-not ("${typeName}" -as [type])) { Add-Type -TypeDefinition $__source -ReferencedAssemblies $__refs -ErrorAction Stop }`,
    '} catch {',
    `  throw ("${typeName} did not compile: " + [string]$_.Exception.Message)`,
    '}',
  );
  return lines;
}

/* =====================================================================================
 * the trap: everything created is remembered here, by identity, and taken down in a
 * `finally`. Nothing below ever names a process class or a window title.
 * ===================================================================================== */

const TRAP = {
  pids: [],
  /**
   * A desktop name unique to this process.
   *
   * A fixed name is a shared name: an earlier run that leaked its handle makes the next run's
   * `OpenDesktopW` succeed against a desktop it did not create, and then the two runs are
   * looking at each other's windows. The suffix costs nothing and removes the possibility.
   */
  desktopName: process.env.NM_HIDDEN_DESKTOP || `NmCuHidden${String(process.pid).slice(-6)}`,
  desktopCreated: false,
  killed: [],
  errors: [],
};

/**
 * Whether a desktop NAME is free, asked the only way that answers it.
 *
 * A desktop object dies when its last handle closes, so "is it still there" cannot be asked of
 * an open handle. It is asked by trying to CREATE the name: a create that succeeds means the
 * name was free and the desktop is gone, and a create that fails with ERROR_ACCESS_DENIED
 * (5, which is what a duplicate name answers) means it is still there. The first version of
 * this measurement reported a leaked desktop as a live one because it closed a handle it had
 * reopened and then asked whether a handle it still held was open.
 */
async function desktopExists(name) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    ...addTypeLines(b64(LAUNCHER_CSHARP), 'NmHidden', false),
    `$errorCode = 0`,
    `$probe = [NmHidden]::CreateByName("${name}", [ref]$errorCode)`,
    `$present = ($probe -eq [IntPtr]::Zero)`,
    `if (-not $present) { [void][NmHidden]::CloseDesktop($probe) }`,
    `Write-Output (@{ ok = $true; present = $present; create_last_error = $errorCode } | ConvertTo-Json -Compress)`,
  ].join('\r\n');
  const result = lastJsonLine((await mod.runInLane('windows', script, 40000).catch((error) => ({ output: String(error) }))).output);
  return result || { present: null, error: 'no answer' };
}

/**
 * The parent/child tree under one pid, computed HERE rather than in the lane.
 *
 * The first two spellings of this were lane scripts that recursed in PowerShell and then
 * tried to answer one JSON object; both answered `Argument types do not match`, which is why
 * the first run of this measurement killed nothing at all. One flat `Win32_Process` query and
 * the tree built in Node has no such failure mode and returns the same pids.
 */
async function processTree(rootPid) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$rows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId, Name)',
    '$items = @($rows | ForEach-Object { @{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; name = [string]$_.Name } })',
    'Write-Output ("NMTREE " + (@{ items = $items } | ConvertTo-Json -Compress -Depth 4))',
  ].join('\r\n');
  const result = await mod.runInLane('windows', script, 40000);
  const marker = String(result.output).split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('NMTREE '));
  if (!marker) return { error: String(result.output).slice(0, 300), targets: [Number(rootPid)] };
  const parsed = JSON.parse(marker.slice('NMTREE '.length));
  const items = Array.isArray(parsed.items) ? parsed.items : (parsed.items ? [parsed.items] : []);
  const byParent = new Map();
  for (const item of items) {
    if (!byParent.has(item.parent)) byParent.set(item.parent, []);
    byParent.get(item.parent).push(item.pid);
  }
  const collected = [];
  const walk = (pid) => {
    for (const child of byParent.get(pid) || []) { walk(child); collected.push(child); }
  };
  walk(Number(rootPid));
  collected.push(Number(rootPid));
  return { items, targets: collected };
}

/** Terminate one pid and its descendants, from that pid as the root, then verify. */
async function killTree(pid) {
  const tree = await processTree(pid);
  const targets = tree.targets;
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    /* The pid list is joined into a comma-separated literal: `@([1,2])` is not PowerShell,
       it is a type literal with a missing type name, which is how the first spelling of this
       killed nothing. */
    `$targets = @(${targets.join(',')})`,
    '$names = @{}',
    'foreach ($candidate in $targets) {',
    '  $process = Get-Process -Id $candidate -ErrorAction SilentlyContinue',
    '  if ($null -ne $process) { $names[[string]$candidate] = [string]$process.ProcessName; Stop-Process -Id $candidate -Force -ErrorAction SilentlyContinue }',
    '}',
    'Start-Sleep -Milliseconds 800',
    '$survivors = @()',
    'foreach ($candidate in $targets) { if ($null -ne (Get-Process -Id $candidate -ErrorAction SilentlyContinue)) { $survivors += $candidate } }',
    '$killed = @()',
    'foreach ($key in $names.Keys) { $killed += @{ pid = [int]$key; name = [string]$names[$key] } }',
    'Write-Output ("NMKILL " + (@{ killed = $killed; survivor_pids = $survivors; targets = $targets } | ConvertTo-Json -Compress -Depth 5))',
  ].join('\r\n');
  const result = await mod.runInLane('action', script, 40000);
  let parsed;
  try {
    const marker = String(result.output).split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('NMKILL '));
    parsed = marker ? JSON.parse(marker.slice('NMKILL '.length)) : { raw: String(result.output).slice(0, 600), tree_error: tree.error };
  } catch (error) {
    parsed = { raw: String(result.output).slice(0, 600), parse_error: String(error) };
  }
  TRAP.killed.push({ root_pid: Number(pid), lane_ok: result.ok === true, ...parsed });
  return parsed;
}

/**
 * The last JSON object in a lane's output.
 *
 * A lane script may print other lines first (a PowerShell error, a warning, an `Add-Type`
 * message), and it may prefix its own answer with a marker so a reader can find it among
 * them. Both spellings are accepted: `NMKILL {…}` and a bare line that starts with `{`.
 */
function lastJsonLine(output) {
  const lines = String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const brace = lines[index].indexOf('{');
    if (brace === -1) continue;
    try {
      const parsed = JSON.parse(lines[index].slice(brace));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* keep looking */ }
  }
  return null;
}

function lastLine(output) {
  const lines = String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

/* =====================================================================================
 * the P/Invoke block that both the measurement and the eventual component need.
 * Compiling it in the lane proves the API surface is reachable without privileges, and
 * carrying it here first means Phase 2 is measured before it is written.
 * ===================================================================================== */

const LAUNCHER_CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NmHidden
{
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  /**
   * STARTUPINFO with the two string fields as raw pointers.
   *
   * Declaring them as a C# string in a struct passed by ref to a P/Invoke is what crashed the
   * first run of this measurement with an access violation inside CreateProcessW: the
   * default marshalling of a string member of a blittable-ish struct is ambiguous, and the
   * only spelling that is unambiguous is to marshal the pointer by hand.
   */
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFO
  {
    public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars;
    public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput;
    public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION
  {
    public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
  }

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateDesktopW(string name, string device, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenDesktopW(string name, int flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumDesktopWindows(IntPtr desktop, EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] public static extern int GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);

  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  /* Every pointer-shaped argument is declared as IntPtr: no string is marshalled by the
     framework on this call at all, so nothing about the layout is left to a default. */
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateProcessW(IntPtr application, IntPtr commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, IntPtr currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  public const uint DESKTOP_ALL_ACCESS = 0x000F01FF;
  public const uint GENERIC_ALL = 0x10000000;
  public const int UOI_NAME = 2;

  public static string KernelName(IntPtr handle)
  {
    StringBuilder buffer = new StringBuilder(512);
    int needed;
    if (GetUserObjectInformationW(handle, UOI_NAME, buffer, buffer.Capacity * 2, out needed) == 0) return "";
    return buffer.ToString();
  }

  public static string WindowStationName() { return KernelName(GetProcessWindowStation()); }
  public static string DesktopName() { return KernelName(GetThreadDesktop(GetCurrentThreadId())); }

  /** A desktop that is already there, opened for exactly the access the job needs. */
  public static IntPtr OpenByName(string name, out int error)
  {
    IntPtr desktop = OpenDesktopW(name, 0, false, DESKTOP_ALL_ACCESS);
    error = Marshal.GetLastWin32Error();
    return desktop;
  }

  public static IntPtr CreateByName(string name, out int error)
  {
    /* The desktop is created HERE rather than by the caller, and that is not a style choice.
       CreateDesktopW's second parameter must be a NULL pointer, and PowerShell converts both
       a null and an empty string at a string parameter into an empty BSTR - not a null pointer
       - so the call answers ERROR_INVALID_PARAMETER (87) and no desktop is created. Two probe
       runs and one whole measurement were lost to that: the create looked like a permissions
       failure and was a marshalling one. */
    IntPtr desktop = CreateDesktopW(name, null, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    error = Marshal.GetLastWin32Error();
    return desktop;
  }

  /** The pid of the process started onto the named desktop, or 0 with the Win32 error. */
  public static int RunOnDesktop(string desktopName, string commandLine, out int error)
  {
    return RunOnDesktopWithEnvironment(desktopName, commandLine, new string[0], out error);
  }

  /**
   * The same launch, with extra environment variables for the child only.
   *
   * This exists because a command line is a string and a path with a space in it is not: the
   * first version of this measurement passed the probe's state path as an argument, the quote
   * in the middle of it did not survive the round trip, and the application quietly wrote its
   * state to the default path instead - which read exactly like an application that never
   * wrote anything at all. The environment block has no such ambiguity.
   */
  public static int RunOnDesktopWithEnvironment(string desktopName, string commandLine, string[] environmentPairs, out int error)
  {
    STARTUPINFO info = new STARTUPINFO();
    info.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    IntPtr desktopPointer = Marshal.StringToHGlobalUni(desktopName);
    IntPtr commandPointer = Marshal.StringToHGlobalUni(commandLine);
    IntPtr environmentPointer = IntPtr.Zero;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    bool started = false;
    try
    {
      info.lpDesktop = desktopPointer;
      /* CREATE_UNICODE_ENVIRONMENT is not optional: CreateProcessW answers
         ERROR_INVALID_PARAMETER (87) for a Unicode environment block without it, which is how
         the first spelling of this failed with pid 0 and an empty desktop. */
      uint flags = 0x00000400;
      if (environmentPairs != null && environmentPairs.Length > 0) environmentPointer = BuildEnvironmentBlock(environmentPairs);
      started = CreateProcessW(IntPtr.Zero, commandPointer, IntPtr.Zero, IntPtr.Zero, false, flags, environmentPointer, IntPtr.Zero, ref info, out process) != IntPtr.Zero;
      error = Marshal.GetLastWin32Error();
    }
    finally
    {
      Marshal.FreeHGlobal(desktopPointer);
      Marshal.FreeHGlobal(commandPointer);
      if (environmentPointer != IntPtr.Zero) Marshal.FreeHGlobal(environmentPointer);
    }
    if (!started) return 0;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return process.dwProcessId;
  }

  /** A Unicode environment block: "NAME=VALUE\0" repeated, terminated by one more null. */
  static IntPtr BuildEnvironmentBlock(string[] pairs)
  {
    System.Text.StringBuilder builder = new System.Text.StringBuilder();
    for (int i = 0; i < pairs.Length; i++) builder.Append(pairs[i]).Append('\0');
    builder.Append('\0');
    return Marshal.StringToHGlobalUni(builder.ToString());
  }

  public sealed class WindowFact
  {
    public long Handle { get; set; }
    public string Title { get; set; }
    public string ClassName { get; set; }
    public int ProcessId { get; set; }
    public int Left { get; set; }
    public int Top { get; set; }
    public int Right { get; set; }
    public int Bottom { get; set; }
    public int ClientLeft { get; set; }
    public int ClientTop { get; set; }
    public int ClientWidth { get; set; }
    public int ClientHeight { get; set; }
    public bool Visible { get; set; }
    public bool Minimized { get; set; }
    public bool Foreground { get; set; }
  }

  public static WindowFact One(IntPtr hWnd)
  {
    RECT rect;
    RECT client;
    if (!GetWindowRect(hWnd, out rect)) return null;
    if (!GetClientRect(hWnd, out client)) { client.Left = 0; client.Top = 0; client.Right = 0; client.Bottom = 0; }
    WindowFact fact = new WindowFact();
    fact.Handle = hWnd.ToInt64();
    StringBuilder className = new StringBuilder(512);
    GetClassNameW(hWnd, className, className.Capacity);
    fact.ClassName = className.ToString();
    StringBuilder title = new StringBuilder(1024);
    GetWindowTextW(hWnd, title, title.Capacity);
    fact.Title = title.ToString();
    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    fact.ProcessId = (int)pid;
    fact.Left = rect.Left; fact.Top = rect.Top; fact.Right = rect.Right; fact.Bottom = rect.Bottom;
    fact.ClientLeft = client.Left; fact.ClientTop = client.Top; fact.ClientWidth = client.Right - client.Left; fact.ClientHeight = client.Bottom - client.Top;
    fact.Visible = IsWindowVisible(hWnd);
    fact.Minimized = IsIconic(hWnd);
    fact.Foreground = GetForegroundWindow() == hWnd;
    return fact;
  }

  /**
   * Every top-level window on a named desktop, whether or not this thread is on it.
   *
   * SetThreadDesktop is deliberately NOT used: a thread may only switch desktop once and
   * undoing it is unreliable, so a lane that switched would be poisoned for everything
   * after. The price of not switching is that a window's child controls are not reachable
   * from here - which is exactly what posting a message by handle does not need.
   */
  public static WindowFact[] Enumerate(IntPtr desktop)
  {
    /* ArrayList, not List of WindowFact, and that is not a style preference.
       This block is compiled by Add-Type -ReferencedAssemblies, which REPLACES PowerShell's
       default reference set instead of adding to it: the generic collections live in
       System.Runtime, which is then not referenced, and List<T> fails to compile with
       CS0246. The failure surfaces as an Add-Type exception inside the lane, which kills the
       lane process and reports "lane exited (0)" - the compiler's own words never reach the
       caller, so the symptom is a compile step that answers null for no visible reason.
       ArrayList is in mscorlib, which the replacement set does carry. */
    System.Collections.ArrayList found = new System.Collections.ArrayList();
    EnumDesktopWindows(desktop, delegate(IntPtr hWnd, IntPtr lParam)
    {
      try { WindowFact fact = One(hWnd); if (fact != null) found.Add(fact); }
      catch (Exception) { }
      return true;
    }, IntPtr.Zero);
    return (WindowFact[])found.ToArray(typeof(WindowFact));
  }

  /**
   * The same enumeration, addressed by desktop NAME.
   *
   * The interactive-desktop control needs the window facts of the Default desktop from a
   * thread that is already on it, and it needs them without the caller holding a desktop
   * handle open across the measurement. The handle is opened and closed inside this call.
   */
  public static WindowFact[] EnumerateDesktop(string desktopName, out int error)
  {
    IntPtr desktop = OpenDesktopW(desktopName, 0, false, DESKTOP_ALL_ACCESS);
    error = Marshal.GetLastWin32Error();
    if (desktop == IntPtr.Zero) return new WindowFact[0];
    try { return Enumerate(desktop); }
    finally { CloseDesktop(desktop); }
  }

  /** The screen metrics of the desktop the CALLING thread is on, as six numbers. */
  public static int[] Metrics()
  {
    return new int[] {
      GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79),
      GetSystemMetrics(0), GetSystemMetrics(1)
    };
  }

  public static int[] Cursor()
  {
    POINT point;
    GetCursorPos(out point);
    return new int[] { point.X, point.Y };
  }
}
`;

/** The P/Invoke block the desktop-surface probe uses, kept separate so each lane compiles
 *  only what it needs. */
const SURFACE_CSHARP = String.raw`
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class NmSurface
{
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dest, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint rop);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int max);

  public const uint SRCCOPY = 0x00CC0020;
  public const uint CAPTUREBLT = 0x40000000;

  /**
   * One whole-desktop copy from the screen DC of whichever desktop THIS process is on.
   *
   * The clone matters: a Bitmap holds its device context lazily, so writing through
   * Graphics.GetHdc() and then releasing can leave the saved file empty. The clone
   * materialises the pixels before the HDC is released, and the sampled counts say
   * whether the copy was of anything at all.
   */
  public static string Capture(string path)
  {
    int width = GetSystemMetrics(78);
    int height = GetSystemMetrics(79);
    if (width <= 0 || height <= 0) return "{\"ok\":false,\"error\":\"empty virtual screen\"}";
    IntPtr screen = GetDC(IntPtr.Zero);
    if (screen == IntPtr.Zero) return "{\"ok\":false,\"error\":\"GetDC(screen) returned null\",\"width\":" + width + ",\"height\":" + height + "}";
    Bitmap scratch = new Bitmap(width, height, PixelFormat.Format32bppArgb);
    Graphics graphics = Graphics.FromImage(scratch);
    IntPtr target = graphics.GetHdc();
    bool copied;
    int bitbltError;
    try
    {
      copied = BitBlt(target, 0, 0, width, height, screen, 0, 0, SRCCOPY | CAPTUREBLT);
      /* The error code is read BEFORE ReleaseDC: any later call overwrites the last error and
         the first version of this reported a bare ok:false with the code already gone. */
      bitbltError = Marshal.GetLastWin32Error();
    }
    finally { graphics.ReleaseHdc(target); }
    graphics.Dispose();
    ReleaseDC(IntPtr.Zero, screen);

    Bitmap final = scratch.Clone(new Rectangle(0, 0, width, height), PixelFormat.Format32bppArgb);
    scratch.Dispose();
    final.Save(path, ImageFormat.Png);

    int dark = 0, light = 0, other = 0;
    for (int y = 0; y < height; y += 16)
    {
      for (int x = 0; x < width; x += 16)
      {
        Color pixel = final.GetPixel(x, y);
        if (pixel.R < 16 && pixel.G < 16 && pixel.B < 16) dark++;
        else if (pixel.R > 239 && pixel.G > 239 && pixel.B > 239) light++;
        else other++;
      }
    }
    final.Dispose();

    POINT cursor; GetCursorPos(out cursor);
    IntPtr foreground = GetForegroundWindow();
    System.Text.StringBuilder title = new System.Text.StringBuilder(512);
    GetWindowTextW(foreground, title, title.Capacity);

    return "{\"ok\":" + (copied ? "true" : "false")
      + ",\"bitblt_last_error\":" + bitbltError
      + ",\"width\":" + width + ",\"height\":" + height
      + ",\"path\":\"" + path.Replace("\\", "\\\\") + "\""
      + ",\"sampled_dark\":" + dark + ",\"sampled_light\":" + light + ",\"sampled_other\":" + other
      + ",\"cursor\":{\"x\":" + cursor.X + ",\"y\":" + cursor.Y + "}"
      + ",\"foreground\":\"0x" + foreground.ToInt64().ToString("X") + "\""
      + ",\"foreground_title\":\"" + title.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}";
  }

  /** The rectangles of the windows on THIS desktop, so a "different surface" is a number. */
  public static string DesktopWindowRect()
  {
    RECT rect;
    IntPtr desktop = GetDesktopWindow();
    if (!GetWindowRect(desktop, out rect)) return "{\"ok\":false}";
    return "{\"ok\":true,\"left\":" + rect.Left + ",\"top\":" + rect.Top + ",\"right\":" + rect.Right + ",\"bottom\":" + rect.Bottom + "}";
  }
}
`;

/* =====================================================================================
 * the application launched onto the hidden desktop
 * ===================================================================================== */

const APP_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class NmProbeForm : Form
{
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  readonly string statePath;
  readonly List<string> log = new List<string>();
  readonly TextBox input;
  readonly Panel pad;
  readonly Timer timer;
  readonly bool quiet;
  int ticks;

  public NmProbeForm(string path, bool quiet)
  {
    statePath = path;
    this.quiet = quiet;
    Text = "Newmark hidden-desktop probe";
    ClientSize = new Size(640, 420);
    StartPosition = FormStartPosition.Manual;
    Location = new Point(60, 60);
    BackColor = Color.White;
    KeyPreview = true;

    Label banner = new Label();
    banner.Text = "HIDDEN DESKTOP PROBE";
    banner.Font = new Font("Segoe UI", 16f, FontStyle.Bold);
    banner.SetBounds(10, 8, 620, 34);
    Controls.Add(banner);

    input = new TextBox();
    input.Name = "probeInput";
    input.Font = new Font("Consolas", 14f);
    input.SetBounds(10, 48, 620, 30);
    Controls.Add(input);

    pad = new Panel();
    pad.Name = "probePad";
    pad.SetBounds(10, 92, 620, 220);
    pad.BackColor = Color.FromArgb(240, 244, 250);
    pad.BorderStyle = BorderStyle.FixedSingle;
    Controls.Add(pad);

    Label hint = new Label();
    hint.Text = "click the pad   |   type into the box   |   wheel";
    hint.SetBounds(10, 320, 620, 22);
    Controls.Add(hint);

    clickCount = 0;
    wheelDelta = 0;
    keyCount = 0;
    lastMessage = "none";
    lastClientPoint = "";
    lastKey = "";

    pad.MouseDown += delegate(object sender, MouseEventArgs e) { HandlePadDown(e); };
    pad.Paint += delegate(object sender, PaintEventArgs e) { DrawPad(e.Graphics); };
    input.TextChanged += delegate(object sender, EventArgs e) { Record("text-changed", "text=" + input.Text + ";caret=" + input.SelectionStart); };
    input.KeyDown += delegate(object sender, KeyEventArgs e) { keyCount = keyCount + 1; lastKey = e.KeyData.ToString(); Record("key-down", "key=" + lastKey); };
    this.MouseDown += delegate(object sender, MouseEventArgs e) { lastMessage = "form-mousedown"; Record("form-mousedown", "x=" + e.X + ";y=" + e.Y); };

    timer = new Timer();
    timer.Interval = 250;
    timer.Tick += delegate(object sender, EventArgs e) { OnTick(); };
    timer.Start();

    Load += delegate(object sender, EventArgs e) { Record("load", "shown"); if (quiet) MoveQuietly(); };
    Shown += delegate(object sender, EventArgs e) { Record("shown", "visible=" + Visible); };
    FormClosed += delegate(object sender, FormClosedEventArgs e) { Persist(); };
  }

  /**
   * The window is put out of the way of whoever is sitting at this machine.
   *
   * This instance is the interactive-desktop control, so the person using the computer can see
   * it. MoveQuietly places it in the bottom-right corner of the virtual screen and does it with
   * SWP_NOACTIVATE, so the window never becomes foreground and never takes the keyboard away
   * from the application that has it. ShowWithoutActivation covers the same ground for the
   * first Show(). Neither call touches any window other than this one.
   */
  protected override bool ShowWithoutActivation { get { return quiet; } }

  void MoveQuietly()
  {
    int left = GetSystemMetrics(76);
    int top = GetSystemMetrics(77);
    int width = GetSystemMetrics(78);
    int height = GetSystemMetrics(79);
    if (width <= 0 || height <= 0) return;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_NOZORDER = 0x0004;
    SetWindowPos(Handle, IntPtr.Zero, left + width - Width - 12, top + height - Height - 12, 0, 0,
      SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
  }

  public int clickCount;
  public int wheelDelta;
  public int keyCount;
  public string lastMessage;
  public string lastClientPoint;
  public string lastKey;

  /* A window on a desktop that never becomes the input desktop is not driven by the
     system's own paint loop, so this asks for the paint itself. It is what makes
     PrintWindow a picture of the current state rather than of the first frame. */
  void OnTick()
  {
    ticks = ticks + 1;
    try { pad.Invalidate(); pad.Update(); } catch (Exception) { }
    if (ticks % 4 == 0) Persist();
  }

  void HandlePadDown(MouseEventArgs e)
  {
    clickCount = clickCount + 1;
    lastMessage = "pad-mousedown";
    lastClientPoint = e.X + "," + e.Y;
    Record("pad-mousedown", "button=" + e.Button.ToString() + ";x=" + e.X + ";y=" + e.Y + ";clicks=" + clickCount);
    try { pad.Invalidate(); pad.Update(); } catch (Exception) { }
  }

  void Record(string kind, string detail)
  {
    log.Add(kind + " " + detail);
    Persist();
  }

  protected override void OnMouseWheel(MouseEventArgs e)
  {
    wheelDelta = wheelDelta + e.Delta;
    lastMessage = "mousewheel";
    Record("wheel", "delta=" + e.Delta + ";total=" + wheelDelta);
    base.OnMouseWheel(e);
  }

  void DrawPad(Graphics graphics)
  {
    graphics.SmoothingMode = SmoothingMode.AntiAlias;
    graphics.Clear(Color.FromArgb(240, 244, 250));
    using (Font big = new Font("Segoe UI", 24f, FontStyle.Bold))
    using (Font small = new Font("Consolas", 13f))
    using (SolidBrush ink = new SolidBrush(Color.FromArgb(20, 30, 60)))
    using (SolidBrush red = new SolidBrush(Color.FromArgb(170, 30, 30)))
    {
      graphics.DrawString("CLICKS " + clickCount.ToString(), big, red, 14, 10);
      graphics.DrawString("TEXT   " + input.Text, small, ink, 14, 68);
      graphics.DrawString("KEYS   " + keyCount.ToString() + "  LAST " + lastKey, small, ink, 14, 96);
      graphics.DrawString("WHEEL  " + wheelDelta.ToString() + "  LAST " + lastMessage, small, ink, 14, 124);
      graphics.DrawString("AT     " + lastClientPoint, small, ink, 14, 152);
    }
  }

  void Persist()
  {
    try
    {
      StringBuilder json = new StringBuilder();
      json.Append("{");
      json.Append("\"pid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id).Append(",");
      /* The application's own top-level handle, published by the application. A reader that
         has this does not have to guess which of the pid's windows is the form: the pid also
         owns IME, tooltip and overlay helper windows, and picking by "largest client area" is
         a heuristic that happens to work rather than a fact. */
      json.Append("\"handle\":\"0x").Append(Handle.ToInt64().ToString("X")).Append("\",");
      json.Append("\"ticks\":").Append(ticks).Append(",");
      json.Append("\"clicks\":").Append(clickCount).Append(",");
      json.Append("\"wheel_delta\":").Append(wheelDelta).Append(",");
      json.Append("\"key_events\":").Append(keyCount).Append(",");
      json.Append("\"last_key\":\"").Append(Escape(lastKey)).Append("\",");
      json.Append("\"last_message\":\"").Append(Escape(lastMessage)).Append("\",");
      json.Append("\"last_client_point\":\"").Append(Escape(lastClientPoint)).Append("\",");
      json.Append("\"text\":\"").Append(Escape(input.Text)).Append("\",");
      json.Append("\"caret\":").Append(input.SelectionStart).Append(",");
      json.Append("\"contains_focus\":").Append(ContainsFocus ? "true" : "false").Append(",");
      json.Append("\"input_focused\":").Append(input.Focused ? "true" : "false").Append(",");
      json.Append("\"visible\":").Append(Visible ? "true" : "false").Append(",");
      json.Append("\"screen_rect\":{\"x\":").Append(Left).Append(",\"y\":").Append(Top).Append(",\"width\":").Append(Width).Append(",\"height\":").Append(Height).Append("},");
      json.Append("\"pad_screen\":");
      Point origin = pad.PointToScreen(new Point(0, 0));
      json.Append("{\"x\":").Append(origin.X).Append(",\"y\":").Append(origin.Y).Append(",\"width\":").Append(pad.Width).Append(",\"height\":").Append(pad.Height).Append("},");
      json.Append("\"log\":[");
      int from = log.Count > 40 ? log.Count - 40 : 0;
      for (int i = from; i < log.Count; i++)
      {
        if (i > from) json.Append(",");
        json.Append("\"").Append(Escape(log[i])).Append("\"");
      }
      json.Append("]}");
      File.WriteAllText(statePath, json.ToString(), Encoding.UTF8);
    }
    catch (Exception) { }
  }

  static string Escape(string value)
  {
    if (value == null) return "";
    return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
  }
}

/**
 * One headless mode in the same executable, so the geometry question is asked by the SAME
 * binary in the SAME process shape: it reports the screen metrics it sees, twice - before
 * and after it makes itself per-monitor DPI aware - and the two reports plus the desktop
 * name it is on are the whole answer.
 */
public static class NmMetricMode
{
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dest, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint rop);
  [DllImport("user32.dll", SetLastError = true)] public static extern int GetUserObjectInformationW(IntPtr handle, int index, System.Text.StringBuilder info, int length, out int needed);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public const uint SRCCOPY = 0x00CC0020;
  public const uint CAPTUREBLT = 0x40000000;

  static string KernelName(IntPtr handle)
  {
    System.Text.StringBuilder buffer = new System.Text.StringBuilder(512);
    int needed;
    if (GetUserObjectInformationW(handle, 2, buffer, buffer.Capacity * 2, out needed) == 0) return "";
    return buffer.ToString();
  }

  static string Metrics()
  {
    return "[" + GetSystemMetrics(76) + "," + GetSystemMetrics(77) + "," + GetSystemMetrics(78) + ","
      + GetSystemMetrics(79) + "," + GetSystemMetrics(0) + "," + GetSystemMetrics(1) + "]";
  }

  public static void Run(string outputPath)
  {
    /* A switch with no path takes its path from the environment, which is the only spelling
       that carries a Windows path with a space in it without a quoting question. */
    if (String.IsNullOrEmpty(outputPath) || outputPath.StartsWith("--"))
    {
      string fromEnvironment = Environment.GetEnvironmentVariable("NM_METRICS_OUT");
      if (!String.IsNullOrEmpty(fromEnvironment)) outputPath = fromEnvironment;
    }
    string before = Metrics();
    bool aware = false;
    try { aware = SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
    string after = Metrics();
    string json = "{\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id
      + ",\"exe_is_dpi_aware\":" + (aware ? "true" : "false")
      + ",\"window_station\":\"" + KernelName(GetProcessWindowStation()) + "\""
      + ",\"desktop\":\"" + KernelName(GetThreadDesktop(GetCurrentThreadId())) + "\""
      + ",\"before_aware\":" + before
      + ",\"after_aware\":" + after + "}";
    File.WriteAllText(outputPath, json, Encoding.UTF8);
  }

  /**
   * The whole surface of whichever desktop THIS process is on.
   *
   * This is the mode the question "can the hidden desktop's own surface be captured" is
   * answered in, and it answers it in the same executable that was driven by the component, so
   * the answer is not a fact about a different helper. The ok field is the BitBlt return value
   * with the GetLastError that belongs to it, and the sampled counts are what say whether
   * anything was actually copied: an all-dark frame is a copy of nothing, and it says so.
   */
  public static void Capture(string outputPath)
  {
    if (String.IsNullOrEmpty(outputPath) || outputPath.StartsWith("--"))
    {
      string fromEnvironment = Environment.GetEnvironmentVariable("NM_SURFACE_OUT");
      if (!String.IsNullOrEmpty(fromEnvironment)) outputPath = fromEnvironment;
    }
    bool aware = false;
    try { aware = SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
    int width = GetSystemMetrics(78);
    int height = GetSystemMetrics(79);
    IntPtr screen = GetDC(IntPtr.Zero);
    bool copied = false;
    int bitbltError = -1;
    int dark = 0, light = 0, other = 0;
    string error = "";
    try
    {
      if (screen == IntPtr.Zero) { error = "GetDC(screen) returned null"; }
      else
      {
        Bitmap scratch = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        Graphics graphics = Graphics.FromImage(scratch);
        IntPtr target = graphics.GetHdc();
        try
        {
          copied = BitBlt(target, 0, 0, width, height, screen, 0, 0, SRCCOPY | CAPTUREBLT);
          bitbltError = Marshal.GetLastWin32Error();
        }
        finally { graphics.ReleaseHdc(target); }
        graphics.Dispose();
        Bitmap final = scratch.Clone(new Rectangle(0, 0, width, height), PixelFormat.Format32bppArgb);
        scratch.Dispose();
        final.Save(outputPath, ImageFormat.Png);
        for (int y = 0; y < height; y += 16)
        {
          for (int x = 0; x < width; x += 16)
          {
            Color pixel = final.GetPixel(x, y);
            if (pixel.R < 16 && pixel.G < 16 && pixel.B < 16) dark++;
            else if (pixel.R > 239 && pixel.G > 239 && pixel.B > 239) light++;
            else other++;
          }
        }
        final.Dispose();
      }
    }
    catch (Exception thrown) { error = thrown.Message; }
    finally { if (screen != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screen); }
    string report = "{\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id
      + ",\"desktop\":\"" + KernelName(GetThreadDesktop(GetCurrentThreadId())) + "\""
      + ",\"window_station\":\"" + KernelName(GetProcessWindowStation()) + "\""
      + ",\"exe_is_dpi_aware\":" + (aware ? "true" : "false")
      + ",\"ok\":" + (copied ? "true" : "false")
      + ",\"bitblt_last_error\":" + bitbltError
      + ",\"width\":" + width + ",\"height\":" + height
      + ",\"path\":\"" + outputPath.Replace("\\", "\\\\") + "\""
      + ",\"bytes\":" + (File.Exists(outputPath) ? new FileInfo(outputPath).Length : 0)
      + ",\"sampled_dark\":" + dark + ",\"sampled_light\":" + light + ",\"sampled_other\":" + other
      + ",\"foreground\":\"0x" + GetForegroundWindow().ToInt64().ToString("X") + "\""
      + ",\"error\":\"" + error.Replace("\"", "'") + "\"}";
    File.WriteAllText(outputPath + ".json", report, Encoding.UTF8);
  }
}

public static class Program
{
  [STAThread]
  public static void Main(string[] args)
  {
    /**
     * The switch is found ANYWHERE in the command line, and the dispatch writes down what it
     * was given before it decides.
     *
     * Two earlier spellings of this read a fixed position - args[0] == "--metrics" and then
     * args[1] == "--metrics" - and both ran the form instead of the probe, leaving a live
     * window on the desktop and a state file where the metric report should have been. A scan
     * has no position to get wrong, so a mismatch cannot hide in an argument index.
     */
    int switchAt = -1;
    for (int i = 0; i < args.Length; i++)
    {
      if (args[i] == "--metrics" || args[i] == "--surface") { switchAt = i; break; }
    }
    if (switchAt >= 0)
    {
      bool wantsSurface = args[switchAt] == "--surface";
      string path = "";
      for (int i = switchAt + 1; i < args.Length; i++)
      {
        if (!args[i].StartsWith("--")) { path = args[i]; break; }
      }
      if (String.IsNullOrEmpty(path)) path = Environment.GetEnvironmentVariable(wantsSurface ? "NM_SURFACE_OUT" : "NM_METRICS_OUT");
      if (wantsSurface) NmMetricMode.Capture(path);
      else NmMetricMode.Run(path);
      return;
    }
    /* No switch: the form runs, and its state path comes from the environment for the same
       reason the metric report does. */
    string statePath = Environment.GetEnvironmentVariable("NM_STATE_OUT");
    if (String.IsNullOrEmpty(statePath)) statePath = Path.Combine(Path.GetTempPath(), "nm-cu-hidden-state.json");
    /* The same scan has no position to get wrong, for the same reason as above. */
    bool quiet = false;
    for (int i = 0; i < args.Length; i++) { if (args[i] == "--quiet") { quiet = true; break; } }
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    Application.Run(new NmProbeForm(statePath, quiet));
  }
}`;

/* =====================================================================================
 * the receipt
 * ===================================================================================== */

const RECEIPT = {
  phase: 'Phase 2 - the lanes resolve a window that lives on another desktop, measured by the application\'s own state',
  started_at: new Date().toISOString(),
  component_entry: COMPONENT_ENTRY,
  component_entry_is_the_repo_copy: !COMPONENT_ENTRY.toLowerCase().includes(`${path.sep}.dsh${path.sep}`),
  component_entry_sha256: COMPONENT_SHA_BEFORE,
  component_entry_sha256_after_load: COMPONENT_SHA_AFTER_LOAD,
  component_entry_bytes: fs.statSync(COMPONENT_ENTRY).size,
  variant: CONTROL_OLD_READ ? 'removed-handling control: the desktop-scoped validity read put back, in a copy' : 'the shipped lane',
  variant_sources_patched: CONTROL.applied,
  variant_dir: CONTROL.dir,
  variant_entry_sha256: CONTROL.composed_sha256,
  not_the_installed_profile: 'imported packages/newmark-core/components/computeruse/lib/win32.js from the repository, never ~/.dsh/profiles/desktop/node_modules/newmark2dsh',
  lane_shell: PWSH,
  node: process.version,
  platform: process.platform,
  evidence_dir: OUT,
  measurements: {},
};

function writeReceipt() {
  RECEIPT.finished_at = new Date().toISOString();
  RECEIPT.trap = {
    pids: TRAP.pids,
    desktop_name: TRAP.desktopName,
    desktop_created: TRAP.desktopCreated,
    desktop_left_running: KEEP,
    killed: TRAP.killed,
    errors: TRAP.errors,
  };
  const file = path.join(OUT, 'receipt.json');
  fs.writeFileSync(file, JSON.stringify(RECEIPT, null, 2));
  say('');
  say(`receipt: ${file}`);
}

const readState = () => readStateAt(path.join(SCRATCH, 'state.json'));

/** The same read, for whichever state file an instance was told to write. */
function readStateAt(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The pixels inside a window rectangle, counted from a bitmap the component wrote. */
function pixelCensus(imagePath, rect) {
  if (!imagePath || !fs.existsSync(imagePath)) return { ok: false, error: 'no image' };
  const bytes = fs.statSync(imagePath).size;
  return {
    ok: bytes > 0,
    image_bytes: bytes,
    sha256_prefix: createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex').slice(0, 16),
    window_rect: rect,
  };
}

/* =====================================================================================
 * run
 * ===================================================================================== */

/** The window station the desktops live on. The interactive desktop is `Default` on it. */
const WINSTA = process.env.NM_HIDDEN_WINSTA || 'winsta0';

/* ---------------------------------------------------------------- the real desktop read --- */

const REAL_READ_CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NmRealRead
{
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  public static string Read()
  {
    POINT point; GetCursorPos(out point);
    IntPtr foreground = GetForegroundWindow();
    StringBuilder title = new StringBuilder(512);
    GetWindowTextW(foreground, title, title.Capacity);
    StringBuilder className = new StringBuilder(512);
    GetClassNameW(foreground, className, className.Capacity);
    StringBuilder windows = new StringBuilder();
    int count = 0;
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
    {
      if (!IsWindowVisible(hWnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      count++;
      if (windows.Length < 6000)
      {
        StringBuilder windowTitle = new StringBuilder(256);
        GetWindowTextW(hWnd, windowTitle, windowTitle.Capacity);
        windows.Append("0x").Append(hWnd.ToInt64().ToString("X")).Append(":").Append(pid).Append(":")
          .Append(windowTitle.ToString().Replace("|", " ").Replace("\"", "'")).Append("|");
      }
      return true;
    }, IntPtr.Zero);
    return "{\"x\":" + point.X + ",\"y\":" + point.Y
      + ",\"foreground\":\"0x" + foreground.ToInt64().ToString("X") + "\""
      + ",\"foreground_title\":\"" + title.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""
      + ",\"foreground_class\":\"" + className.ToString() + "\""
      + ",\"visible_window_count\":" + count
      + ",\"visible_windows\":\"" + windows.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}";
  }
}
`;

/**
 * The two reads about one handle, taken from ONE thread in ONE lane script.
 *
 * This is what says which of the two causes the phase was asked to distinguish. `IsWindow` is
 * scoped to the desktop the calling thread is attached to; `PostMessage` is not. If the first
 * answers false while the second succeeds, the handle was valid all along and the read was
 * the defect - and no amount of OpenDesktopW or SetThreadDesktop would have been needed.
 */
const SCOPE_PROBE_CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NmScope
{
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  const uint WM_NEWMARK_PROBE = 0x8000 + 0x02C4;
  const uint DESKTOP_READOBJECTS = 0x0001;

  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll", EntryPoint = "PostMessageW", SetLastError = true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] public static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  static string KernelName(IntPtr handle)
  {
    if (handle == IntPtr.Zero) return "";
    StringBuilder buffer = new StringBuilder(512);
    int needed;
    if (!GetUserObjectInformationW(handle, 2, buffer, buffer.Capacity * 2, out needed)) return "";
    return buffer.ToString();
  }

  public static string About(IntPtr hWnd)
  {
    StringBuilder className = new StringBuilder(512);
    GetClassNameW(hWnd, className, className.Capacity);
    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    bool isWindow = IsWindow(hWnd);
    int postError = 0;
    bool posted = PostMessage(hWnd, WM_NEWMARK_PROBE, UIntPtr.Zero, IntPtr.Zero);
    postError = Marshal.GetLastWin32Error();
    RECT rect;
    bool hasRect = GetWindowRect(hWnd, out rect);
    int ownership = (!posted) ? 1 : ((pid != 0) ? 0 : 1);
    return "{\"lane_desktop\":\"" + KernelName(GetThreadDesktop(GetCurrentThreadId())) + "\""
      + ",\"lane_window_station\":\"" + KernelName(GetProcessWindowStation()) + "\""
      + ",\"iswindow\":" + (isWindow ? "true" : "false")
      + ",\"postmessage_accepted\":" + (posted ? "true" : "false")
      + ",\"postmessage_last_error\":" + postError
      + ",\"ownership_probe\":" + ownership
      + ",\"window_rect_available\":" + (hasRect ? "true" : "false")
      + ",\"class_name\":\"" + className.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""
      + ",\"pid\":" + (int)pid + "}";
  }
}
`;

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  TRAP.errors.push(error && error.stack ? error.stack : String(error));
  say(`the measurement threw: ${error && error.message ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await cleanup();
}

async function main() {
  /* ------------------------------------------------------------ 0. the interactive desktop --- */
  say('=== 0. the interactive desktop, before anything is created ===');

  const baselineScript = [
    '$ErrorActionPreference = "Stop"',
    ...addTypeLines(b64(LAUNCHER_CSHARP), 'NmHidden', false),
    '$report = [ordered]@{}',
    '$report.window_station = [NmHidden]::WindowStationName()',
    '$report.desktop = [NmHidden]::DesktopName()',
    '$report.metrics = @([NmHidden]::Metrics())',
    '$report.cursor = @([NmHidden]::Cursor())',
    '$foreground = [NmHidden]::GetForegroundWindow()',
    '$fact = [NmHidden]::One($foreground)',
    '$report.foreground = @{ handle = ("0x{0:X}" -f $foreground.ToInt64()); title = if ($fact) { $fact.Title } else { "" }; class_name = if ($fact) { $fact.ClassName } else { "" }; process_id = if ($fact) { $fact.ProcessId } else { 0 } }',
    'Write-Output (@{ ok = $true; report = $report } | ConvertTo-Json -Compress -Depth 8)',
  ].join('\r\n');

  const baselineRaw = await mod.runInLane('windows', baselineScript, 60000);
  const baseline = lastJsonLine(baselineRaw.output);
  if (!baseline || baseline.ok !== true) {
    say(`the baseline lane call did not answer: ${String(baselineRaw.output).slice(0, 1200)}`);
    RECEIPT.measurements.baseline = { ok: false, raw: String(baselineRaw.output).slice(0, 4000) };
    return 1;
  }
  RECEIPT.measurements.baseline = baseline.report;
  say(`  the lane runs on ${baseline.report.window_station}\\${baseline.report.desktop}`);
  say(`  metrics [x,y,cx,cy,primary_cx,primary_cy] = ${JSON.stringify(baseline.report.metrics)}`);
  say(`  cursor ${JSON.stringify(baseline.report.cursor)}   foreground ${baseline.report.foreground.handle} "${baseline.report.foreground.title}" pid=${baseline.report.foreground.process_id}`);

  const realBefore = JSON.parse(await mod.runComputerUse({ action: 'app_list', ownerId: 'measure-phase1', timeoutMs: 40000 }));
  RECEIPT.measurements.real_desktop_before = {
    count: realBefore.count,
    scope: realBefore.scope,
    handles: (realBefore.applications || []).map((app) => `${app.handle} ${app.process_id} ${app.class_name}`).sort(),
  };
  say(`  the component's app_list on the real desktop: count=${realBefore.count} scope=${realBefore.scope}`);

  /* ------------------------------------------------------------ 1..3 the desktop and the launch --- */
  say('');
  say('=== 1-3. creating the hidden desktop and launching onto it ===');

  const appExe = path.join(SCRATCH, 'NmHiddenProbe.exe');
  if (!fs.existsSync(CSC)) {
    say(`  no C# compiler at ${CSC}; the probe application cannot be built`);
    RECEIPT.measurements.probe_app = { ok: false, error: `no compiler at ${CSC}` };
    return 1;
  }

  const sourcePath = path.join(SCRATCH, 'NmHiddenProbe.cs');
  fs.writeFileSync(sourcePath, APP_CSHARP, 'utf8');
  /* The executable is removed first: a compile that fails leaves the previous .exe in place,
     and the first version of this reported that stale binary's size as a successful build of
     the new source. Nothing downstream can then tell the two apart. */
  try { fs.rmSync(appExe, { force: true }); } catch { /* ignore */ }
  const compileScript = [
    '$ErrorActionPreference = "Stop"',
    `$arguments = @("/nologo", "/target:winexe", "/optimize+", "/out:${appExe}", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "${sourcePath}")`,
    `$output = & "${CSC}" @arguments 2>&1 | Out-String`,
    `if (-not (Test-Path -LiteralPath "${appExe}")) { Write-Output ("NMCOMPILE " + (@{ ok = $false; output = $output } | ConvertTo-Json -Compress)); exit 0 }`,
    `Write-Output ("NMCOMPILE " + (@{ ok = $true; exe = "${appExe}"; bytes = (Get-Item -LiteralPath "${appExe}").Length; output = $output } | ConvertTo-Json -Compress))`,
  ].join('\r\n');
  const compiled = lastJsonLine((await mod.runInLane('windows', compileScript, 120000)).output);
  RECEIPT.measurements.probe_app = compiled;
  if (!compiled || compiled.ok !== true) {
    say(`  the probe application did not compile: ${JSON.stringify(compiled)}`);
    /* The compiler's own words, kept in the receipt. A compile that fails with the answer
       "null" is a measurement that has thrown its evidence away. */
    const rawCompile = await mod.runInLane('windows', compileScript, 120000);
    RECEIPT.measurements.probe_app_raw = String(rawCompile.output).slice(0, 8000);
    say(`  the compiler said: ${String(rawCompile.output).slice(0, 4000)}`);
    return 1;
  }
  say(`  probe application compiled: ${compiled.exe} (${compiled.bytes} bytes)`);

  const { LAUNCH_MODE, LAUNCHER_SCRIPT } = buildLauncher({ appExe, captureDir: CAPTURES });
  RECEIPT.measurements.launch_mode = LAUNCH_MODE;

  const launchRaw = await mod.runInLane('windows', LAUNCHER_SCRIPT, 150000);
  const launched = lastJsonLine(launchRaw.output);
  if (!launched) {
    say(`  the launcher answered nothing readable (lane ok=${launchRaw.ok}).`);
    say(`  raw output:\n${String(launchRaw.output).slice(0, 3000)}`);
    RECEIPT.measurements.launch_raw = String(launchRaw.output).slice(0, 8000);
    RECEIPT.measurements.launch_lane_ok = launchRaw.ok === true;
    return 1;
  }
  RECEIPT.measurements.launch_raw_ok = launchRaw.ok === true;
  RECEIPT.measurements.launch = launched.report;
  if (launched.report && Number(launched.report.launch_pid) > 0) TRAP.pids.push(Number(launched.report.launch_pid));
  if (launched.report) TRAP.desktopCreated = launched.report.desktop_created_now === true;

  if (!launched.report || launched.report.desktop_opened !== true) {
    say(`  the desktop could not be opened or created: ${JSON.stringify(launched.report)}`);
    return 1;
  }
  say(`  desktop "${TRAP.desktopName}" opened=${launched.report.desktop_opened} created_now=${launched.report.desktop_created_now} handle=${launched.report.desktop_handle} last_error=${launched.report.open_last_error}`);
  say(`  launch: CreateProcessW lpDesktop="${launched.report.launch_qualified_name}" -> pid=${launched.report.launch_pid} last_error=${launched.report.launch_last_error}`);
  say(`  windows ON the hidden desktop, enumerated by a process that is NOT on it: ${launched.report.hidden_window_count}`);
  for (const window of launched.report.hidden_windows || []) {
    say(`    ${window.handle} ${window.class_name} "${window.title}" pid=${window.process_id} client=${window.client_rect.width}x${window.client_rect.height} visible=${window.visible} foreground=${window.foreground}`);
  }
  say(`  top-level windows on Default, read the same way: ${launched.report.interactive_window_count}`);
  say(`  whole-desktop BitBlt attempted from the interactive desktop: ${JSON.stringify(launched.report.surface_bitblt_here)}`);
  say(`  the probe app's own state file present: ${launched.report.app_state_present}`);

  /* ------------------------------------------------------------ 4. geometry --- */
  say('');
  say('=== 4. geometry: the hidden desktop against the current virtual screen ===');
  const geometry = {
    interactive_virtual_screen: {
      x: baseline.report.metrics[0], y: baseline.report.metrics[1],
      cx: baseline.report.metrics[2], cy: baseline.report.metrics[3],
      negative_origin: baseline.report.metrics[0] < 0 || baseline.report.metrics[1] < 0,
    },
    interactive_primary_screen: { cx: baseline.report.metrics[4], cy: baseline.report.metrics[5] },
    hidden_desktop_screen: launched.report.hidden_screen || null,
    desktop_window_rect_on_creating_thread: launched.report.desktop_rect_here || null,
  };
  RECEIPT.measurements.geometry = geometry;
  say(`  SM_XVIRTUALSCREEN=${geometry.interactive_virtual_screen.x} SM_YVIRTUALSCREEN=${geometry.interactive_virtual_screen.y} SM_CXVIRTUALSCREEN=${geometry.interactive_virtual_screen.cx} SM_CYVIRTUALSCREEN=${geometry.interactive_virtual_screen.cy}`);
  say(`  SM_CXSCREEN=${geometry.interactive_primary_screen.cx} SM_CYSCREEN=${geometry.interactive_primary_screen.cy}`);
  say(`  GetDesktopWindow() on the interactive desktop: ${JSON.stringify(geometry.desktop_window_rect_on_creating_thread)}`);

  const state0 = launched.report.app_state_raw ? JSON.parse(launched.report.app_state_raw) : null;
  if (state0) {
    RECEIPT.measurements.probe_app_initial_state = state0;
    say(`  the application on the hidden desktop reports its own rect: ${JSON.stringify(state0.screen_rect)} pad=${JSON.stringify(state0.pad_screen)} pid=${state0.pid}`);
  }

  /* ------------------------------------------------------------ 5. the component's own paths --- */
  say('');
  say("=== 5. the component's own paths against the hidden desktop ===");

  const owner = 'measure-hidden-desktop';
  /* The target is the application's own top-level window, taken from the handle the
     application publishes in its own state file. The earlier spelling picked "the largest
     client area window of the pid" out of the enumeration, which is a heuristic: the pid also
     owns IME, tooltip, GDI+ and overlay helpers. Both are recorded, so a disagreement between
     the application's answer and the heuristic is visible instead of silent. */
  const publishedHandle = state0 && state0.handle ? String(state0.handle) : null;
  const byArea = (launched.report.hidden_windows || [])
    .filter((window) => Number(window.process_id) === Number(launched.report.launch_pid))
    .sort((left, right) => (Number(right.client_rect.width) * Number(right.client_rect.height)) - (Number(left.client_rect.width) * Number(left.client_rect.height)))[0];
  const appHandle = (publishedHandle && (launched.report.hidden_windows || []).find((window) => String(window.handle).toLowerCase() === publishedHandle.toLowerCase()))
    || byArea;
  if (!appHandle) {
    say('  no window belonging to the launched pid was found on the hidden desktop');
    return 1;
  }
  RECEIPT.measurements.hidden_target = appHandle;
  RECEIPT.measurements.hidden_target_source = publishedHandle && String(appHandle.handle).toLowerCase() === publishedHandle.toLowerCase()
    ? 'the handle the application publishes in its own state file'
    : 'the largest-client-area window of the launched pid (the application published no handle)';
  RECEIPT.measurements.hidden_target_by_area_agrees = Boolean(byArea && String(byArea.handle).toLowerCase() === String(appHandle.handle).toLowerCase());
  say(`  target: ${appHandle.handle} ${appHandle.class_name} client=${JSON.stringify(appHandle.client_rect)} title="${appHandle.title}" visible=${appHandle.visible}`);
  say(`    chosen from ${RECEIPT.measurements.hidden_target_source}; the largest-client-area authority agrees: ${RECEIPT.measurements.hidden_target_by_area_agrees}`);

  const component = {};
  component.takeover_start = JSON.parse(await mod.runComputerUse({ action: 'takeover_start', ownerId: owner, mouseMode: 'virtual', timeoutMs: 20000 }));
  say(`  takeover_start(virtual): mouse_mode=${component.takeover_start.mouse_mode} delivery=${component.takeover_start.delivery} overlay_running=${component.takeover_start.overlay && component.takeover_start.overlay.running}`);

  component.app_list = JSON.parse(await mod.runComputerUse({ action: 'app_list', ownerId: owner, timeoutMs: 40000 }));
  const listed = (component.app_list.applications || []).some((app) => app.handle.toLowerCase() === appHandle.handle.toLowerCase());
  say(`  app_list: count=${component.app_list.count} scope=${component.app_list.scope} contains the hidden target=${listed}`);
  say(`    handles: ${(component.app_list.applications || []).map((app) => `${app.handle}:${app.class_name}:${app.process_id}`).slice(0, 12).join(' ')}`);

  component.observe = JSON.parse(await mod.runComputerUse({
    action: 'app_observe', ownerId: owner, windowHandle: appHandle.handle, captureMaxWidth: 2048, captureMaxHeight: 2048, timeoutMs: 90000,
  }));
  say(`  app_observe by handle: ok=${component.observe.ok} capture_scope=${component.observe.capture_scope} target_scope=${component.observe.target_scope} method=${component.observe.capture && component.observe.capture.capture_method}`);
  say(`    image=${component.observe.image_path} ${component.observe.width}x${component.observe.height} bytes=${component.observe.image_bytes} mime=${component.observe.image_mime}`);
  say(`    control_count=${component.observe.control_count} uia_visited=${component.observe.uia_visited} uia_error=${component.observe.telemetry && component.observe.telemetry.uia_error}`);
  if (component.observe.error) say(`    error=${component.observe.error_code} ${component.observe.error}`);
  RECEIPT.measurements.component_observe = summarise(component.observe);

  component.capture_screen = JSON.parse(await mod.runComputerUse({
    action: 'capture_screen', ownerId: 'measure-phase1', captureMaxWidth: 2048, captureMaxHeight: 2048, timeoutMs: 90000,
  }));
  say(`  capture_screen with a virtual lease held: ok=${component.capture_screen.ok} error_code=${component.capture_screen.error_code} ${component.capture_screen.error || ''}`);
  RECEIPT.measurements.component_capture_screen_under_virtual_lease = summarise(component.capture_screen);

  /* ------------------------------------------------------------ 6. delivery effect --- */
  say('');
  say('=== 6. does input posted at the hidden desktop actually DO anything ===');

  const rect = appHandle.client_rect;
  const padState = state0 || readState();
  const clickX = padState && padState.pad_screen ? padState.pad_screen.x + 140 : Math.round(rect.x + 140);
  const clickY = padState && padState.pad_screen ? padState.pad_screen.y + 110 : Math.round(rect.y + 200);
  RECEIPT.measurements.input_point = { x: clickX, y: clickY, source: padState && padState.pad_screen ? 'the application\'s own pad_screen report' : 'the client rect' };
  say(`  input point ${clickX},${clickY} (${RECEIPT.measurements.input_point.source})`);

  const beforeState = readState();
  const realCursorBefore = await readRealDesktop();
  const shotBefore = snapshot('1-before-input', component.observe && component.observe.image_path);

  /**
   * One component call, bracketed by a real-desktop cursor read on each side.
   *
   * The whole "did the real pointer move" question is unanswerable from a before/after pair
   * around the run if the person at the machine also moves the mouse - which they did, in the
   * first run of this measurement. A guard around each action attributes any movement to the
   * action that caused it.
   */
  const cursorGuarded = [];
  async function guarded(label, options) {
    const before = await readRealDesktop();
    const value = JSON.parse(await mod.runComputerUse(options));
    const after = await readRealDesktop();
    const moved = Number(before.x) !== Number(after.x) || Number(before.y) !== Number(after.y);
    const foregroundChanged = String(before.foreground).toLowerCase() !== String(after.foreground).toLowerCase();
    cursorGuarded.push({
      label,
      ok: value.ok === true,
      error_code: value.error_code, error: value.error,
      cursor_before: { x: before.x, y: before.y },
      cursor_after: { x: after.x, y: after.y },
      cursor_moved: moved,
      foreground_before: before.foreground,
      foreground_after: after.foreground,
      foreground_changed: foregroundChanged,
      receipt_system_cursor_moved: value.system_cursor_moved,
    });
    return value;
  }

  component.app_activate = await guarded('app_activate', { action: 'app_activate', ownerId: owner, windowHandle: appHandle.handle, timeoutMs: 60000 });
  say(`  app_activate: ok=${component.app_activate.ok} activated=${component.app_activate.activated} bound_handle=${component.app_activate.bound_handle}`);

  component.app_move = await guarded('move', { action: 'move', ownerId: owner, windowHandle: appHandle.handle, x: clickX, y: clickY, timeoutMs: 60000 });
  say(`  move (virtual cursor): ok=${component.app_move.ok} mouse_mode=${component.app_move.mouse_mode} x=${component.app_move.x} y=${component.app_move.y} target_control=${component.app_move.target_control} cursor_moved=${component.app_move.system_cursor_moved}`);
  if (component.app_move.ok !== true) say(`    ${component.app_move.error_code}: ${component.app_move.error}`);

  component.app_type = await guarded('app_type', { action: 'app_type', ownerId: owner, windowHandle: appHandle.handle, text: 'nm-hidden', timeoutMs: 60000 });
  say(`  app_type "nm-hidden": ok=${component.app_type.ok} queued=${component.app_type.queued} action_completed=${component.app_type.action_completed} chars=${component.app_type.chars} target_control=${component.app_type.target_control}`);
  if (component.app_type.ok !== true) say(`    ${component.app_type.error_code}: ${component.app_type.error}`);
  await sleep(900);
  const afterTypeState = readState();
  say(`    the application's own state: text="${afterTypeState && afterTypeState.text}" key_events=${afterTypeState && afterTypeState.key_events} caret=${afterTypeState && afterTypeState.caret}`);

  component.app_click = await guarded('app_click', { action: 'app_click', ownerId: owner, windowHandle: appHandle.handle, x: clickX, y: clickY, timeoutMs: 60000 });
  say(`  app_click at ${clickX},${clickY}: ok=${component.app_click.ok} queued=${component.app_click.queued} target_control=${component.app_click.target_control} client=${component.app_click.client_x},${component.app_click.client_y}`);
  if (component.app_click.ok !== true) say(`    ${component.app_click.error_code}: ${component.app_click.error}`);
  await sleep(1100);
  const afterClickState = readState();
  say(`    the application's own state: clicks=${afterClickState && afterClickState.clicks} last_message=${afterClickState && afterClickState.last_message} at=${afterClickState && afterClickState.last_client_point}`);

  component.app_scroll = await guarded('app_scroll', { action: 'app_scroll', ownerId: owner, windowHandle: appHandle.handle, x: clickX, y: clickY, scroll_y: 120, timeoutMs: 60000 });
  await sleep(700);
  const afterScrollState = readState();
  say(`  app_scroll: ok=${component.app_scroll.ok} queued=${component.app_scroll.queued} -> the application's wheel total ${afterScrollState && afterScrollState.wheel_delta}`);
  if (component.app_scroll.ok !== true) say(`    ${component.app_scroll.error_code}: ${component.app_scroll.error}`);

  component.app_key = await guarded('app_key', { action: 'app_key', ownerId: owner, windowHandle: appHandle.handle, key: 'ctrl+a', timeoutMs: 60000 });
  await sleep(700);
  const afterKeyState = readState();
  say(`  app_key ctrl+a: ok=${component.app_key.ok} queued=${component.app_key.queued} -> the application's key_events ${afterKeyState && afterKeyState.key_events} last=${afterKeyState && afterKeyState.last_key}`);
  if (component.app_key.ok !== true) say(`    ${component.app_key.error_code}: ${component.app_key.error}`);

  component.move_report = JSON.parse(await mod.runComputerUse({ action: 'mode_report', ownerId: owner, timeoutMs: 20000 }));
  say(`  mode_report: mouse_mode=${component.move_report.mouse_mode} lease_held=${component.move_report.lease && component.move_report.lease.held} virtual_pointer_field=${Object.prototype.hasOwnProperty.call(component.move_report, 'virtual_pointer')}`);

  /**
   * The lease is released BEFORE the real desktop is re-enumerated.
   *
   * The mode is per session, not per owner, so an `app_list` taken while any owner holds a
   * virtual lease answers with the virtual scope - every occluded window included. The first
   * version of this compared a 1-window real-scope listing with a 95-window virtual-scope one
   * and called the desktop changed. A comparison across two scopes is not a comparison.
   */
  component.takeover_stop = JSON.parse(await mod.runComputerUse({ action: 'takeover_stop', ownerId: owner, timeoutMs: 20000 }));
  say(`  takeover_stop at the end of the delivery: ok=${component.takeover_stop.ok} mouse_mode=${component.takeover_stop.mouse_mode}`);

  const shotAfter = snapshot('2-after-input');
  const realAfter = await readRealDesktop();
  const stateAfter = readState();
  const realListAfter = JSON.parse(await mod.runComputerUse({ action: 'app_list', ownerId: 'measure-phase1', timeoutMs: 40000 }));
  say(`  the real desktop re-listed with the lease released: count=${realListAfter.count} scope=${realListAfter.scope}`);
  RECEIPT.measurements.real_list_after_scope = realListAfter.scope;

  /* the two pictures, compared where the state changed */
  const windowShotBefore = await windowCapture('3-window-before', appHandle.handle);
  const windowShotAfter = await windowCapture('4-window-after', appHandle.handle);

  RECEIPT.measurements.delivery = {
    input_point: RECEIPT.measurements.input_point,
    app_state_before: beforeState,
    app_state_after_type: afterTypeState,
    app_state_after_click: afterClickState,
    app_state_after_scroll: afterScrollState,
    app_state_after_key: afterKeyState,
    app_state_after: stateAfter,
    receipts: {
      activate: component.app_activate,
      move: component.app_move,
      type: component.app_type,
      click: component.app_click,
      scroll: component.app_scroll,
      key: component.app_key,
    },
    real_desktop_before: realCursorBefore,
    real_desktop_after: realAfter,
    cursor_guards: cursorGuarded,
    real_list_after: {
      count: realListAfter.count,
      scope: realListAfter.scope,
      handles: (realListAfter.applications || []).map((app) => `${app.handle} ${app.process_id} ${app.class_name}`).sort(),
    },
    screenshots: [shotBefore, shotAfter, windowShotBefore, windowShotAfter].filter(Boolean),
  };

  /* ------------------------------------------------------------ 7. the whole hidden surface --- */
  say('');
  say('=== 7. the whole hidden desktop surface, three ways ===');
  const surface = await measureSurface(appExe);
  RECEIPT.measurements.surface = surface;
  say(`  (a) from the interactive desktop, screen DC of the interactive desktop: ok=${surface.a.ok} distinct=${surface.a.sampled_other} dark=${surface.a.sampled_dark} light=${surface.a.sampled_light} foreground=${surface.a.foreground}`);
  say(`  (b) from a helper process started ON the hidden desktop, its own screen DC: ${JSON.stringify(surface.b)}`);
  say(`  (c) the component's own capture_screen while the hidden desktop is not the input desktop: ${JSON.stringify(surface.c)}`);

  /* ------------------------------------------------------------ 8. the virtual cursor --- */
  say('');
  say('=== 8. the virtual cursor ===');
  const cursor = await measureVirtualCursor(owner, appHandle, stateAfter);
  RECEIPT.measurements.virtual_cursor = cursor;
  for (const line of cursor.lines) say(`  ${line}`);

  /* ------------------------------------------------------------ 9. desktop awareness --- */
  say('');
  say('=== 9. which desktop the lane was reading ===');

  /* The lane process is on the interactive desktop. The target is on the hidden one. The two
     numbers below are taken from that one thread, in that one lane, in one script: the
     desktop-scoped read and the desktop-agnostic read answering about the same handle. */
  const scopeScript = [
    '$ErrorActionPreference = "Stop"',
    ...addTypeLines(b64(SCOPE_PROBE_CSHARP), 'NmScope', false),
    `$target = [IntPtr]::new([Convert]::ToInt64("${appHandle.handle}", 16))`,
    'Write-Output ([NmScope]::About($target))',
  ].join('\r\n');
  const scopeRaw = await mod.runInLane('windows', scopeScript, 40000);
  const scope = lastJsonLine(scopeRaw.output);
  RECEIPT.measurements.desktop_scope_of_the_reads = scope;
  RECEIPT.measurements.desktop_scope_of_the_reads_raw = { lane_ok: scopeRaw.ok === true, output: String(scopeRaw.output).slice(0, 4000) };
  if (scope) {
    say(`  the lane's own thread sits on desktop "${scope.lane_desktop}" of station "${scope.lane_window_station}"`);
    say(`  about the target handle ${appHandle.handle}, FROM THAT THREAD:`);
    say(`    IsWindow             -> ${scope.iswindow}   <- this is the read that was gating every delivery`);
    say(`    the ownership probe  -> ${scope.ownership_probe}   (0 = usable)`);
    say(`    PostMessage accepted -> ${scope.postmessage_accepted}`);
    say(`    the window's pid is  -> ${scope.pid}  (expected ${appHandle.process_id})`);
    say(`    the class name is    -> "${scope.class_name}"`);
  } else {
    say(`  the scope probe answered nothing readable: ${JSON.stringify(scope)}`);
  }

  /* ------------------------------------------------------------ 10. the interactive control --- */
  say('');
  say('=== 10. the same sequence against the same application on the INTERACTIVE desktop ===');

  const interactiveStatePath = path.join(SCRATCH, 'state-interactive.json');
  try { fs.rmSync(interactiveStatePath, { force: true }); } catch { /* ignore */ }
  const controlLaunchScript = [
    '$ErrorActionPreference = "Stop"',
    ...addTypeLines(b64(LAUNCHER_CSHARP), 'NmHidden', false),
    `$errorCode = 0`,
    /* $appPid, never $pid: PowerShell's $PID is automatic and READ-ONLY, so assigning to it
       throws "Cannot overwrite variable PID because it is read-only or constant", the whole
       launch script dies at that line, and the lane answers nothing. It is spelled out here
       because the same trap is one keystroke away in every lane script in this file. */
    /* --quiet: the control's window is moved to the bottom-right corner of the virtual screen
       with SWP_NOACTIVATE and shows without activating, so it never takes the foreground or
       the keyboard from whoever is using this machine. No other window is touched. */
    `$appPid = [NmHidden]::RunOnDesktopWithEnvironment("Default", '"${appExe}" --quiet', @("NM_STATE_OUT=" + "${interactiveStatePath}"), [ref]$errorCode)`,
    'Start-Sleep -Milliseconds 3500',
    `$facts = @()`,
    `$errorCode = 0`,
    `$facts = @([NmHidden]::EnumerateDesktop("Default", [ref]$errorCode))`,
    `$mine = @($facts | Where-Object { $_.ProcessId -eq $appPid })`,
    `$target = $mine | Sort-Object { $_.ClientWidth * $_.ClientHeight } -Descending | Select-Object -First 1`,
    `$state = if (Test-Path -LiteralPath "${interactiveStatePath}") { [System.IO.File]::ReadAllText("${interactiveStatePath}") } else { "" }`,
    `$appHandle = ""`,
    `if ($state) { $parsed = $state | ConvertFrom-Json; $appHandle = [string]$parsed.handle }`,
    `Write-Output (@{ ok = $true; pid = $appPid; last_error = $errorCode; app_handle = $appHandle; published_state = $state; window_count_for_pid = $mine.Count; target = if ($target) { @{ handle = ("0x{0:X}" -f $target.Handle); class_name = $target.ClassName; title = $target.Title; rect = @{ x = $target.Left; y = $target.Top; width = ($target.Right - $target.Left); height = ($target.Bottom - $target.Top) }; client_rect = @{ x = $target.ClientLeft; y = $target.ClientTop; width = $target.ClientWidth; height = $target.ClientHeight }; visible = $target.Visible; minimized = $target.Minimized; foreground = $target.Foreground } } else { $null } } | ConvertTo-Json -Compress -Depth 8)`,
  ].join('\r\n');

  const controlRaw = await mod.runInLane('windows', controlLaunchScript, 90000);
  const controlLaunch = lastJsonLine(controlRaw.output);
  RECEIPT.measurements.interactive_control_launch = controlLaunch;
  RECEIPT.measurements.interactive_control_launch_raw = { lane_ok: controlRaw.ok === true, output: String(controlRaw.output).slice(0, 4000) };
  if (!controlLaunch) say(`  the interactive control's launch script answered nothing readable (lane ok=${controlRaw.ok}): ${String(controlRaw.output).slice(0, 2000)}`);
  if (controlLaunch && Number(controlLaunch.pid) > 0) TRAP.pids.push(Number(controlLaunch.pid));

  let interactiveControl = { ok: false, reason: 'the interactive control instance did not start' };
  if (controlLaunch && controlLaunch.target) {
    say(`  the same application on Default: pid=${controlLaunch.pid} handle=${controlLaunch.target.handle} client=${JSON.stringify(controlLaunch.target.client_rect)} foreground=${controlLaunch.target.foreground}`);
    const controlState = readStateAt(interactiveStatePath);
    const controlPad = controlState && controlState.pad_screen ? controlState.pad_screen : null;
    const controlPoint = controlPad
      ? { x: controlPad.x + 140, y: controlPad.y + 110 }
      : { x: controlLaunch.target.client_rect.x + 140, y: controlLaunch.target.client_rect.y + 110 };
    interactiveControl = await drive({
      label: 'interactive', handle: controlLaunch.target.handle, point: controlPoint, text: 'nm-interactive',
      statePath: interactiveStatePath, owner,
    });
    say(`  the application's own numbers: clicks ${JSON.stringify(interactiveControl.effect.clicks)} text ${JSON.stringify(interactiveControl.effect.text)}`);
    say(`  the interactive control's verdict: ${JSON.stringify(interactiveControl.verdict)}`);
  } else {
    say(`  ${interactiveControl.reason}: ${JSON.stringify(controlLaunch)}`);
  }
  RECEIPT.measurements.interactive_control = interactiveControl;

  /* The control instance is taken down FIRST, by its own pid, before anything else is
     measured; its desktop is the user's desktop, so it does not stay up for the rest of the
     run. */
  if (controlLaunch && Number(controlLaunch.pid) > 0) {
    const report = await killTree(Number(controlLaunch.pid)).catch((error) => ({ error: String(error) }));
    TRAP.killed.push(report);
    say(`  the interactive control instance, taken down by its own pid: ${JSON.stringify(report)}`);
  }

  /* ------------------------------------------------------------ 11. desktop awareness, measured --- */
  say('');
  say('=== 11. does the lane drive the window, and does the application say so ===');

  const awarenessPoint = state0 && state0.pad_screen
    ? { x: state0.pad_screen.x + 140, y: state0.pad_screen.y + 110 }
    : { x: appHandle.client_rect.x + 140, y: appHandle.client_rect.y + 110 };
  const hiddenDrive = await drive({
    label: 'hidden', handle: appHandle.handle, point: awarenessPoint, text: 'nm-hidden',
    statePath: path.join(SCRATCH, 'state.json'), owner,
  });
  RECEIPT.measurements.hidden_drive = hiddenDrive;
  say(`  the hidden target, driven by the component: ${JSON.stringify(hiddenDrive.verdict)}`);
  say(`  the application's own numbers: clicks ${JSON.stringify(hiddenDrive.effect.clicks)} text ${JSON.stringify(hiddenDrive.effect.text)} wheel ${JSON.stringify(hiddenDrive.effect.wheel_delta)} keys ${JSON.stringify(hiddenDrive.effect.key_events)}`);
  say(`  the two captures: ${JSON.stringify(hiddenDrive.captures.before && hiddenDrive.captures.before.sha256.slice(0, 16))} -> ${JSON.stringify(hiddenDrive.captures.after && hiddenDrive.captures.after.sha256.slice(0, 16))} differ=${hiddenDrive.captures_differ}`);
  for (const step of hiddenDrive.steps) {
    say(`    ${step.action}: ok=${step.ok} queued=${step.queued === undefined ? '-' : step.queued} code=${step.error_code || '-'} ${step.ok === true ? '' : JSON.stringify(step.error || '')}`);
  }

  /* ------------------------------------------------------------ verdict --- */
  const realForegroundUnchanged = String(realCursorBefore.foreground).toLowerCase() === String(realAfter.foreground).toLowerCase();
  /**
   * The two listings are compared only when they were taken in the same scope.
   *
   * The measurement's own PowerShell lanes are processes that appear and disappear while it
   * runs, so a raw count is not a statement about the user's desktop either. What is compared
   * is the set of handles in a listing of the same scope, and the scope is reported beside the
   * verdict so a reader can see whether the comparison was even legal.
   */
  const sameScope = RECEIPT.measurements.real_list_after_scope === realBefore.scope;
  const realWindowSetUnchanged = sameScope
    && JSON.stringify(RECEIPT.measurements.real_desktop_before.handles) === JSON.stringify(RECEIPT.measurements.delivery.real_list_after.handles);
  const guardMoved = (RECEIPT.measurements.delivery.cursor_guards || []).filter((entry) => entry.cursor_moved === true);
  const guardForegroundChanged = (RECEIPT.measurements.delivery.cursor_guards || []).filter((entry) => entry.foreground_changed === true);

  RECEIPT.verdict = {
    '1 the hidden desktop is created without administrator': launched.report.desktop_created_now === true || launched.report.desktop_opened === true,
    '1 its geometry is the interactive virtual screen': geometryStatement(geometry),
    '2 an application launched onto it is enumerable by a lane that is not on it': Number(launched.report.hidden_window_count) >= 1,
    '2 it is enumerable through the component app_list': listed,
    '2 it is capturable through the component app_observe': component.observe.ok === true && Number(component.observe.image_bytes) > 0,
    '3 typing reached the application (its own state file)': Boolean(afterTypeState && String(afterTypeState.text).includes('nm-hidden')),
    '3 a posted click reached it (its own click counter)': Boolean(afterClickState && Number(afterClickState.clicks) >= 1),
    '3 a posted wheel reached it (its own wheel total)': Boolean(afterScrollState && Number(afterScrollState.wheel_delta) !== 0),
    '3 a posted key reached it (its own key counter)': Boolean(afterKeyState && Number(afterKeyState.key_events) >= 1),
    '4 no component action moved the real cursor': guardMoved.length === 0,
    '4 no component action changed the real foreground': guardForegroundChanged.length === 0,
    '5 the real desktop window set is unchanged across the delivery': realWindowSetUnchanged,
    '5 the two real-desktop listings were taken in the same scope': sameScope,    '5 the real foreground is unchanged across the delivery': realForegroundUnchanged,
    '6 window capture across desktops produced bytes': component.observe.ok === true && Number(component.observe.image_bytes) > 0,
    '6 whole hidden-desktop surface captured by a helper ON the hidden desktop': surface.b && surface.b.ok === true,
  };

  /* The verdicts this phase exists for: the application's own state, against the two controls. */
  const sameVerdict = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  RECEIPT.verdict_phase2 = {
    'A the lane read a valid handle as invalid (the desktop-scoped read)': scope ? scope.iswindow === false : 'not measured',
    'A the same thread could deliver to that handle': scope ? scope.postmessage_accepted === true : 'not measured',
    'B app_observe on the hidden desktop returns a picture': hiddenDrive.verdict['app_observe returns a picture with bytes'],
    'B app_observe on the hidden desktop returns a picture that is not flat': hiddenDrive.verdict['app_observe returns a picture with two or more distinct byte values'],
    'B app_click on the hidden desktop returns ok': hiddenDrive.verdict['app_click returns ok'],
    'B the application counted the hidden-desktop click (its own counter)': hiddenDrive.verdict['the application counted the click'],
    'B app_type on the hidden desktop returns ok': hiddenDrive.verdict['app_type returns ok'],
    'B the application holds the typed text (its own field)': hiddenDrive.verdict['the application holds the typed text'],
    'B two captures of two different application states differ (hidden desktop)': hiddenDrive.captures_differ,
    'C CONTROL the same sequence on the INTERACTIVE desktop passes': interactiveControl.verdict
      ? Object.values(interactiveControl.verdict).every((value) => value === true) : false,
    'C CONTROL the interactive run and the hidden run reach the same verdicts': interactiveControl.verdict
      ? sameVerdict(interactiveControl.verdict, hiddenDrive.verdict) : false,
    'C CONTROL the interactive control actually changed the application state': interactiveControl.effect
      ? Number(interactiveControl.effect.clicks[1]) > Number(interactiveControl.effect.clicks[0])
        && String(interactiveControl.effect.text[1] || '').includes('nm-interactive') : false,
    'D the repository copy of the lane was not written to by this run': RECEIPT.component_entry_sha256 === RECEIPT.component_entry_sha256_after_load,
  };
  RECEIPT.metrics_phase2 = {
    variant: RECEIPT.variant,
    hidden_drive_ok_steps: hiddenDrive.steps.filter((step) => step.ok === true).length,
    hidden_drive_steps: hiddenDrive.steps.length,
    hidden_click_counter: hiddenDrive.effect.clicks,
    hidden_text_field: hiddenDrive.effect.text,
    hidden_captures_differ: hiddenDrive.captures_differ,
    interactive_click_counter: interactiveControl.effect ? interactiveControl.effect.clicks : null,
    interactive_text_field: interactiveControl.effect ? interactiveControl.effect.text : null,
    interactive_captures_differ: Boolean(interactiveControl.captures_differ),
  };
  RECEIPT.metrics = {
    system_cursor_moved_by_a_component_action: guardMoved.length > 0,
    component_actions_that_moved_the_cursor: guardMoved.map((entry) => entry.label),
    real_foreground_changed_by_a_component_action: guardForegroundChanged.length > 0,
    real_window_set_changed_across_the_delivery: !realWindowSetUnchanged,
    hidden_desktop_geometry_equals_interactive_virtual_screen: geometryStatement(geometry).same,
  };

  say('');
  say('=== VERDICT ===');
  for (const [name, value] of Object.entries(RECEIPT.verdict)) say(`  ${name}: ${JSON.stringify(value)}`);
  say('');
  say('=== VERDICT - this phase ===');
  for (const [name, value] of Object.entries(RECEIPT.verdict_phase2)) say(`  ${name}: ${JSON.stringify(value)}`);
  return 0;
}

/**
 * Drive one application window with the component's action lane and read the EFFECT back
 * from the application.
 *
 * The same function runs against the window on the hidden desktop and against the window on
 * the interactive desktop: same session, same component instance, same lease mode, same
 * coordinates, same text. The two runs therefore differ in exactly one variable, which is
 * which desktop the target window is on - and that is the variable under measurement.
 *
 * Every assertion in the answer is read from the application's own state file, never from the
 * receipt. `queued: true` is recorded because it is what the lane says, and it decides nothing.
 */
async function drive({ label, handle, point, text, statePath, owner }) {
  const before = readStateAt(statePath);
  const steps = [];
  const read = () => readStateAt(statePath);
  /* What the state file is, before anything is asked of the component. A null read has to be
     a fact about the file - absent, unreadable, not JSON - and not a fact about the reader. */
  const stateFacts = () => {
    try {
      const text = fs.readFileSync(statePath, 'utf8');
      return { path: statePath, present: true, bytes: Buffer.byteLength(text), parsed: Boolean(read()) };
    } catch (error) { return { path: statePath, present: false, error: String(error && error.code ? error.code : error) }; }
  };

  const modeBefore = JSON.parse(await mod.runComputerUse({ action: 'mode_report', ownerId: owner, timeoutMs: 20000 }));

  const observeA = JSON.parse(await mod.runComputerUse({
    action: 'app_observe', ownerId: owner, windowHandle: handle, captureMaxWidth: 2048, captureMaxHeight: 2048, timeoutMs: 90000,
  }));
  steps.push({
    action: 'app_observe (first)',
    ok: observeA.ok === true, error_code: observeA.error_code, error: observeA.error,
    mouse_mode: observeA.mouse_mode, lane: observeA.lane,
    image_path: observeA.image_path, image_bytes: observeA.image_bytes,
    capture_method: observeA.capture && observeA.capture.capture_method,
    app_state_after: read(),
    receipt: observeA,
  });

  const moveStep = JSON.parse(await mod.runComputerUse({ action: 'move', ownerId: owner, windowHandle: handle, x: point.x, y: point.y, timeoutMs: 60000 }));
  steps.push({
    action: 'move', ok: moveStep.ok === true, error_code: moveStep.error_code, error: moveStep.error,
    mouse_mode: moveStep.mouse_mode, lane: moveStep.lane,
    queued: moveStep.queued, x: moveStep.x, y: moveStep.y, target_control: moveStep.target_control,
    app_state_after: read(),
    receipt: moveStep,
  });

  const typeStep = JSON.parse(await mod.runComputerUse({ action: 'app_type', ownerId: owner, windowHandle: handle, text, timeoutMs: 60000 }));
  await sleep(1200);
  const afterType = read();
  steps.push({
    action: 'app_type', requested_text: text,
    ok: typeStep.ok === true, error_code: typeStep.error_code, error: typeStep.error,
    mouse_mode: typeStep.mouse_mode, lane: typeStep.lane,
    queued: typeStep.queued, chars: typeStep.chars, target_control: typeStep.target_control,
    /* the effect, read from the application */
    text_in_the_application: afterType && afterType.text,
    text_contains_the_requested_text: Boolean(afterType && String(afterType.text).includes(text)),
    app_state_after: afterType,
    receipt: typeStep,
  });

  const clickStep = JSON.parse(await mod.runComputerUse({ action: 'app_click', ownerId: owner, windowHandle: handle, x: point.x, y: point.y, timeoutMs: 60000 }));
  await sleep(1200);
  const afterClick = read();
  steps.push({
    action: 'app_click', requested_point: point,
    ok: clickStep.ok === true, error_code: clickStep.error_code, error: clickStep.error,
    mouse_mode: clickStep.mouse_mode, lane: clickStep.lane,
    queued: clickStep.queued, client_x: clickStep.client_x, client_y: clickStep.client_y, target_control: clickStep.target_control,
    /* the effect, read from the application */
    clicks_before: before && before.clicks, clicks_after: afterClick && afterClick.clicks,
    click_counter_moved: Boolean(before && afterClick && Number(afterClick.clicks) > Number(before.clicks)),
    last_message: afterClick && afterClick.last_message,
    last_client_point: afterClick && afterClick.last_client_point,
    app_state_after: afterClick,
    receipt: clickStep,
  });

  const scrollStep = JSON.parse(await mod.runComputerUse({ action: 'app_scroll', ownerId: owner, windowHandle: handle, x: point.x, y: point.y, scroll_y: 120, timeoutMs: 60000 }));
  await sleep(900);
  const afterScroll = read();
  steps.push({
    action: 'app_scroll', ok: scrollStep.ok === true, error_code: scrollStep.error_code, error: scrollStep.error,
    mouse_mode: scrollStep.mouse_mode, lane: scrollStep.lane,
    queued: scrollStep.queued,
    wheel_before: afterClick && afterClick.wheel_delta, wheel_after: afterScroll && afterScroll.wheel_delta,
    wheel_total_changed: Boolean(afterScroll && Number(afterScroll.wheel_delta) !== Number(afterClick && afterClick.wheel_delta)),
    app_state_after: afterScroll,
    receipt: scrollStep,
  });

  const keyStep = JSON.parse(await mod.runComputerUse({ action: 'app_key', ownerId: owner, windowHandle: handle, key: 'ctrl+a', timeoutMs: 60000 }));
  await sleep(900);
  const afterKey = read();
  steps.push({
    action: 'app_key', key: 'ctrl+a',
    ok: keyStep.ok === true, error_code: keyStep.error_code, error: keyStep.error,
    mouse_mode: keyStep.mouse_mode, lane: keyStep.lane,
    queued: keyStep.queued, key_delivery: keyStep.key_delivery,
    key_events_before: afterScroll && afterScroll.key_events, key_events_after: afterKey && afterKey.key_events,
    key_counter_moved: Boolean(afterKey && Number(afterKey.key_events) > Number(afterScroll && afterScroll.key_events)),
    app_state_after: afterKey,
    receipt: keyStep,
  });

  /* The second observation is taken AFTER the application's own state has changed, so the
     two pictures are of two different application states rather than two readings of one. */
  const observeB = JSON.parse(await mod.runComputerUse({
    action: 'app_observe', ownerId: owner, windowHandle: handle, captureMaxWidth: 2048, captureMaxHeight: 2048, timeoutMs: 90000,
  }));
  steps.push({
    action: 'app_observe (after the state changed)',
    ok: observeB.ok === true, error_code: observeB.error_code, error: observeB.error,
    mouse_mode: observeB.mouse_mode, lane: observeB.lane,
    image_path: observeB.image_path, image_bytes: observeB.image_bytes,
    capture_method: observeB.capture && observeB.capture.capture_method,
    app_state_after: read(),
    receipt: observeB,
  });

  const modeAfter = JSON.parse(await mod.runComputerUse({ action: 'mode_report', ownerId: owner, timeoutMs: 20000 }));

  const kept = {
    before: keepCapture(`${label}-state-before`, observeA.image_path),
    after: keepCapture(`${label}-state-after`, observeB.image_path),
  };
  const capturesDiffer = Boolean(kept.before && kept.after && kept.before.sha256 !== kept.after.sha256);

  const finalState = read();
  const byAction = (name) => steps.find((step) => step.action === name) || {};
  const verdict = {
    'app_observe returns ok': observeA.ok === true,
    'app_observe returns a picture with bytes': observeA.ok === true && Number(observeA.image_bytes) > 0,
    'app_observe returns a picture with two or more distinct byte values': Boolean(kept.before && kept.before.distinct_bytes > 1),
    'move returns ok': byAction('move').ok === true,
    'app_click returns ok': byAction('app_click').ok === true,
    'app_type returns ok': byAction('app_type').ok === true,
    'the application counted the click': byAction('app_click').click_counter_moved === true,
    'the application holds the typed text': byAction('app_type').text_contains_the_requested_text === true,
    'app_scroll returns ok': byAction('app_scroll').ok === true,
    'the application counted the wheel': byAction('app_scroll').wheel_total_changed === true,
    'app_key returns ok': byAction('app_key').ok === true,
    'the application counted the key': byAction('app_key').key_counter_moved === true,
    'two captures of two different application states differ': capturesDiffer,
  };
  return {
    label, handle, point, text, state_path: statePath,
    state_file_before: stateFacts(),
    state_file_after: stateFacts(),
    mouse_mode_before: modeBefore.mouse_mode, lease_before: modeBefore.lease, lease_held_before: modeBefore.lease && modeBefore.lease.held,
    mouse_mode_after: modeAfter.mouse_mode, lease_held_after: modeAfter.lease && modeAfter.lease.held,
    state_before: before, state_after: finalState,
    steps, captures: kept, captures_differ: capturesDiffer,
    verdict,
    /* What decides: the application's own numbers, not the status codes. */
    effect: {
      clicks: [before && before.clicks, finalState && finalState.clicks],
      text: [before && before.text, finalState && finalState.text],
      wheel_delta: [before && before.wheel_delta, finalState && finalState.wheel_delta],
      key_events: [before && before.key_events, finalState && finalState.key_events],
    },
  };
}

/** The picture the component wrote, copied under a name that says which state it is of. */
function keepCapture(label, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const target = path.join(CAPTURES, `${label}.png`);
  try { fs.copyFileSync(sourcePath, target); } catch { return null; }
  const buffer = fs.readFileSync(target);
  return {
    label, path: target, bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    distinct_bytes: countDistinctBytes(target),
  };
}

function geometryStatement(geometry) {
  const hidden = geometry.hidden_desktop_screen || {};
  const interactive = geometry.interactive_virtual_screen;
  const expected = [interactive.x, interactive.y, interactive.cx, interactive.cy];
  const onHidden = hidden.on_hidden || null;
  const onDefault = hidden.on_default || null;
  const probeOf = (record) => (record ? {
    desktop: record.desktop,
    window_station: record.window_station,
    exe_is_dpi_aware: record.exe_is_dpi_aware,
    before_aware: record.before_aware,
    after_aware: record.after_aware,
    after_aware_matches_the_interactive_virtual_screen: Array.isArray(record.after_aware)
      ? JSON.stringify(record.after_aware.slice(0, 4)) === JSON.stringify(expected) : 'not-measured',
  } : null);
  const same = Boolean(onHidden && Array.isArray(onHidden.after_aware)
    && JSON.stringify(onHidden.after_aware.slice(0, 4)) === JSON.stringify(expected));
  return {
    interactive_virtual_screen: expected,
    the_same_probe_on_the_hidden_desktop: probeOf(onHidden),
    the_same_probe_on_the_interactive_desktop: probeOf(onDefault),
    same,
  };
}

function summarise(result) {
  if (!result || typeof result !== 'object') return result;
  const { controls, ...rest } = result;
  return { ...rest, controls: Array.isArray(controls) ? `[${controls.length} controls]` : controls };
}

/** A screenshot of one window, through the component's own observe action, for comparison. */
async function windowCapture(label, handle) {
  try {
    const result = JSON.parse(await mod.runComputerUse({
      action: 'app_observe', ownerId: 'measure-phase1', windowHandle: handle, captureMaxWidth: 2048, captureMaxHeight: 2048, timeoutMs: 90000,
    }));
    if (result.ok !== true || !result.image_path) return { label, ok: false, error_code: result.error_code, error: result.error };
    const target = path.join(CAPTURES, `${label}.png`);
    fs.copyFileSync(result.image_path, target);
    return {
      label, ok: true, path: target, bytes: fs.statSync(target).size,
      sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
      distinct_bytes: countDistinctBytes(target),
    };
  } catch (error) {
    return { label, ok: false, error: String(error) };
  }
}

/** A crude but honest "is this a picture": how many distinct byte values a PNG contains. */
function countDistinctBytes(file) {
  const buffer = fs.readFileSync(file);
  const seen = new Set();
  const step = Math.max(1, Math.floor(buffer.length / 20000));
  for (let index = 0; index < buffer.length; index += step) seen.add(buffer[index]);
  return seen.size;
}

function snapshot(label, sourcePath) {
  if (!sourcePath) return null;
  const target = path.join(CAPTURES, `${label}.png`);
  try { fs.copyFileSync(sourcePath, target); } catch { return null; }
  return { label, path: target, bytes: fs.statSync(target).size, sha256_prefix: createHash('sha256').update(fs.readFileSync(target)).digest('hex').slice(0, 16) };
}

/* ---------------------------------------------------------------- the surface measurement --- */

async function measureSurface(appExe) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    ...addTypeLines(b64(SURFACE_CSHARP), 'NmSurface', true),
    '$pathA = Join-Path "@@CAPTURES@@" "surface-a-interactive.png"',
    '$a = [NmSurface]::Capture($pathA)',
    'Write-Output (@{ ok = $true; a = ($a | ConvertFrom-Json) } | ConvertTo-Json -Compress -Depth 8)',
  ].join('\r\n').replace('@@CAPTURES@@', CAPTURES);

  const a = lastJsonLine((await mod.runInLane('windows', script, 90000)).output);
  const result = {
    a: a && a.a ? a.a : { ok: false, raw: String(a) },
    a_note: 'the interactive desktop, captured by a process on the interactive desktop: the control',
    b: null,
    c: null,
  };

  /* (b) the probe executable itself, started ON the hidden desktop, capturing its own screen. */
  const surfacePath = path.join(CAPTURES, 'surface-b-hidden.png');
  try { fs.rmSync(`${surfacePath}.json`, { force: true }); } catch { /* ignore */ }
  const launch = [
    '$ErrorActionPreference = "Stop"',
    ...addTypeLines(b64(LAUNCHER_CSHARP), 'NmHidden', false),
    `$errorCode = 0`,
    `$surfacePid = [NmHidden]::RunOnDesktopWithEnvironment("${WINSTA}\\${TRAP.desktopName}", '"${appExe}" --surface', @("NM_SURFACE_OUT=" + "${surfacePath}"), [ref]$errorCode)`,
    'Start-Sleep -Milliseconds 5000',
    `$present = Test-Path -LiteralPath "${surfacePath}.json"`,
    `$body = if ($present) { [System.IO.File]::ReadAllText("${surfacePath}.json") } else { "" }`,
    'Write-Output (@{ ok = $true; pid = $surfacePid; last_error = $errorCode; present = $present; body = $body } | ConvertTo-Json -Compress -Depth 6)',
  ].join('\r\n');
  const ran = lastJsonLine((await mod.runInLane('windows', launch, 90000)).output);
  result.b_launch = ran;
  if (ran && Number(ran.pid) > 0) TRAP.pids.push(Number(ran.pid));
  if (ran && ran.present && ran.body) {
    try { result.b = JSON.parse(ran.body); } catch { result.b = { ok: false, raw: ran.body }; }
  } else {
    result.b = { ok: false, reason: 'the surface probe left no report', launch: ran };
  }

  /* (c) the component's own capture_screen, from inside a virtual lease. */
  const lease = JSON.parse(await mod.runComputerUse({ action: 'takeover_start', ownerId: 'surface-probe', mouseMode: 'virtual', timeoutMs: 20000 }));
  const c = JSON.parse(await mod.runComputerUse({ action: 'capture_screen', ownerId: 'surface-probe', captureMaxWidth: 2048, captureMaxHeight: 2048, timeoutMs: 90000 }));
  await mod.runComputerUse({ action: 'takeover_stop', ownerId: 'surface-probe', timeoutMs: 20000 });
  result.c = {
    ok: c.ok === true, error_code: c.error_code, error: c.error,
    target_scope: c.target_scope, image_path: c.image_path, width: c.width, height: c.height,
    lease_mouse_mode: lease.mouse_mode,
  };

  result.a_image = path.join(CAPTURES, 'surface-a-interactive.png');
  result.a_bytes = fs.existsSync(result.a_image) ? fs.statSync(result.a_image).size : 0;
  result.b_image = surfacePath;
  result.b_bytes = fs.existsSync(surfacePath) ? fs.statSync(surfacePath).size : 0;
  return result;
}

/* ---------------------------------------------------------------- the virtual cursor --- */

async function measureVirtualCursor(owner, appHandle, stateAfter) {
  const lines = [];
  const reads = [];
  const pad = stateAfter && stateAfter.pad_screen ? stateAfter.pad_screen : null;
  const points = pad
    ? [
      { x: pad.x + 80, y: pad.y + 60, note: 'inside the pad' },
      { x: pad.x + 300, y: pad.y + 150, note: 'inside the pad again' },
    ]
    : [];

  /* mode_report carries no virtual pointer today; record exactly what it does carry so
     the receipt can say the field is absent rather than imply it was read. */
  const report = JSON.parse(await mod.runComputerUse({ action: 'mode_report', ownerId: owner, timeoutMs: 20000 }));
  reads.push({
    action: 'mode_report',
    virtual_pointer_field_present: Object.prototype.hasOwnProperty.call(report, 'virtual_pointer'),
    value: report.virtual_pointer === undefined ? null : report.virtual_pointer,
  });
  lines.push(`mode_report carries a virtual_pointer field: ${reads[0].virtual_pointer_field_present}`);

  for (const point of points) {
    const moved = JSON.parse(await mod.runComputerUse({ action: 'move', ownerId: owner, windowHandle: appHandle.handle, x: point.x, y: point.y, timeoutMs: 60000 }));
    reads.push({
      action: 'move', requested: point, note: point.note,
      ok: moved.ok === true, error_code: moved.error_code, error: moved.error,
      reported: { x: moved.x, y: moved.y, client_x: moved.client_x, client_y: moved.client_y, target_control: moved.target_control },
      app_state: readState(),
    });
    lines.push(`move -> ${point.x},${point.y}: ok=${moved.ok} receipt x=${moved.x} y=${moved.y} client=${moved.client_x},${moved.client_y} control=${moved.target_control}`);
  }

  /* Two clicks at the same point: the second one must not be a first-ever move, which is
     what tells a pointer that persists from a pointer that is recomputed each time. */
  if (points.length) {
    const first = JSON.parse(await mod.runComputerUse({ action: 'app_click', ownerId: owner, windowHandle: appHandle.handle, x: points[0].x, y: points[0].y, timeoutMs: 60000 }));
    await sleep(600);
    const afterFirst = readState();
    const second = JSON.parse(await mod.runComputerUse({ action: 'app_click', ownerId: owner, windowHandle: appHandle.handle, x: points[0].x, y: points[0].y, timeoutMs: 60000 }));
    await sleep(800);
    const afterSecond = readState();
    reads.push({
      action: 'app_click x2 at one point',
      first: { ok: first.ok === true, target_control: first.target_control, client: [first.client_x, first.client_y] },
      second: { ok: second.ok === true, target_control: second.target_control, client: [second.client_x, second.client_y] },
      clicks_after_first: afterFirst && afterFirst.clicks,
      clicks_after_second: afterSecond && afterSecond.clicks,
    });
    lines.push(`two clicks at ${points[0].x},${points[0].y}: the application counted ${afterFirst && afterFirst.clicks} then ${afterSecond && afterSecond.clicks}`);
  }

  /* A point outside the client area must be refused in Node, before anything is posted. */
  const outside = JSON.parse(await mod.runComputerUse({
    action: 'app_click', ownerId: owner, windowHandle: appHandle.handle,
    x: appHandle.client_rect.x + appHandle.client_rect.width + 500,
    y: appHandle.client_rect.y + 10, timeoutMs: 40000,
  }));
  reads.push({ action: 'app_click outside the client area', ok: outside.ok, error_code: outside.error_code, error: outside.error });
  lines.push(`a point outside the client area: ok=${outside.ok} code=${outside.error_code}`);

  return { reads, lines };
}

/* ---------------------------------------------------------------- the launcher --- */

function buildLauncher({ appExe, captureDir }) {
  const mode = process.env.NM_HIDDEN_LAUNCH_MODE || 'CreateDesktopW';
  const appState = path.join(SCRATCH, 'state.json');
  const surfacePath = path.join(captureDir, 'surface-a-interactive.png');

  const script = [
    '$ErrorActionPreference = "Stop"',
    ...addTypeLines(b64(LAUNCHER_CSHARP), 'NmHidden', false),
    ...addTypeLines(b64(SURFACE_CSHARP), 'NmSurface', true),
    `$desktopName = "${TRAP.desktopName}"`,
    `$qualified = "${WINSTA}\\" + $desktopName`,
    `$errorCode = 0`,
    `$handle = [NmHidden]::OpenByName($desktopName, [ref]$errorCode)`,
    `$created = $false`,
    `if ($handle -eq [IntPtr]::Zero) { $handle = [NmHidden]::CreateByName($desktopName, [ref]$errorCode); $created = $true }`,
    `$report = [ordered]@{}`,
    `$report.create_mode = "${mode}"`,
    `$report.desktop_opened = ($handle -ne [IntPtr]::Zero)`,
    `$report.desktop_created_now = $created`,
    `$report.open_last_error = $errorCode`,
    `$report.lane_window_station = [NmHidden]::WindowStationName()`,
    `$report.lane_desktop = [NmHidden]::DesktopName()`,
    `$report.desktop_rect_here = ([NmSurface]::DesktopWindowRect() | ConvertFrom-Json)`,
    `if ($handle -eq [IntPtr]::Zero) { Write-Output (@{ ok = $false; report = $report } | ConvertTo-Json -Compress -Depth 10); exit 0 }`,
    `$report.desktop_handle = ("0x{0:X}" -f $handle.ToInt64())`,
    `$report.surface_bitblt_here = ([NmSurface]::Capture("${surfacePath}") | ConvertFrom-Json)`,
    /* The metric helper is launched BEFORE the application, so its report is about the
       desktop itself and not about anything the application may have changed. It runs twice:
       once as a default-DPI process, once after SetProcessDpiAwarenessContext(-4), because
       the screen metrics a process reads depend on its own DPI awareness. */
    /* The geometry question, asked by the SAME executable that will be driven later, on BOTH
       desktops: the screen metrics a process reads are those of the desktop its thread is
       attached to, and they depend on that process's own DPI awareness. */
    `$metricDir = Join-Path $env:TEMP "nm-cu-hidden-metrics"`,
    `New-Item -ItemType Directory -Path $metricDir -Force | Out-Null`,
    `$geometryOnHidden = Join-Path $metricDir "on-hidden.json"`,
    `$geometryOnDefault = Join-Path $metricDir "on-default.json"`,
    `Remove-Item -LiteralPath $geometryOnHidden -Force -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath $geometryOnDefault -Force -ErrorAction SilentlyContinue`,
    `$errorCode = 0`,
    /* The report path travels in the child's ENVIRONMENT, not on the command line: a command
       line is one string and a Windows path with a space in it does not survive quoting
       reliably, which is how the first version of this wrote its report somewhere else and
       looked like it had not written one at all. */
    `$report.metric_hidden_pid = [NmHidden]::RunOnDesktopWithEnvironment($qualified, '"${appExe}" --metrics', @("NM_METRICS_OUT=" + $geometryOnHidden), [ref]$errorCode)`,
    `$report.metric_hidden_last_error = $errorCode`,
    `$errorCode = 0`,
    `$report.metric_default_pid = [NmHidden]::RunOnDesktopWithEnvironment("Default", '"${appExe}" --metrics', @("NM_METRICS_OUT=" + $geometryOnDefault), [ref]$errorCode)`,
    `$report.metric_default_last_error = $errorCode`,
    `Start-Sleep -Milliseconds 3000`,
    `$report.metrics_on_hidden_raw = if (Test-Path -LiteralPath $geometryOnHidden) { [System.IO.File]::ReadAllText($geometryOnHidden) } else { "" }`,
    `$report.metrics_on_default_raw = if (Test-Path -LiteralPath $geometryOnDefault) { [System.IO.File]::ReadAllText($geometryOnDefault) } else { "" }`,
    `$report.hidden_screen = @{ on_hidden = ($report.metrics_on_hidden_raw | ConvertFrom-Json); on_default = ($report.metrics_on_default_raw | ConvertFrom-Json) }`,
    `$errorCode = 0`,
    `$launchPid = [NmHidden]::RunOnDesktopWithEnvironment($qualified, '"${appExe}"', @("NM_STATE_OUT=" + "${appState}"), [ref]$errorCode)`,
    `$report.launch_qualified_name = $qualified`,
    `$report.launch_pid = $launchPid`,
    `$report.launch_last_error = $errorCode`,
    `Start-Sleep -Milliseconds 3500`,
    `$windows = @([NmHidden]::Enumerate($handle))`,
    `$report.hidden_window_count = $windows.Count`,
    `$report.hidden_windows = @($windows | ForEach-Object { @{ handle = ("0x{0:X}" -f $_.Handle); title = $_.Title; class_name = $_.ClassName; process_id = $_.ProcessId; rect = @{ x = $_.Left; y = $_.Top; width = ($_.Right - $_.Left); height = ($_.Bottom - $_.Top) }; client_rect = @{ x = $_.ClientLeft; y = $_.ClientTop; width = $_.ClientWidth; height = $_.ClientHeight }; visible = $_.Visible; minimized = $_.Minimized; foreground = $_.Foreground } })`,
    `$interactiveHandle = [NmHidden]::OpenByName("Default", [ref]$errorCode)`,
    `$interactive = @()`,
    `if ($interactiveHandle -ne [IntPtr]::Zero) { $interactive = @([NmHidden]::Enumerate($interactiveHandle) | Where-Object { $_.Title.Length -gt 0 -or $_.ClassName.Length -gt 0 }); [void][NmHidden]::CloseDesktop($interactiveHandle) }`,
    `$report.interactive_window_count = $interactive.Count`,
    `$report.interactive_windows = @($interactive | ForEach-Object { @{ handle = ("0x{0:X}" -f $_.Handle); title = $_.Title; class_name = $_.ClassName; process_id = $_.ProcessId } })`,
    `$report.app_state_path = "${appState}"`,
    `$report.app_state_present = (Test-Path -LiteralPath "${appState}")`,
    `if ($report.app_state_present) { $report.app_state_raw = [System.IO.File]::ReadAllText("${appState}") }`,
    `$report.desktop_left_open = $true`,
    `Write-Output (@{ ok = $true; report = $report } | ConvertTo-Json -Compress -Depth 14)`,
  ].join('\r\n');

  return { LAUNCH_MODE: mode, LAUNCHER_SCRIPT: script };
}


async function readRealDesktop() {
  const script = [
    '$ErrorActionPreference = "Stop"',
    ...addTypeLines(b64(REAL_READ_CSHARP), 'NmRealRead', false),
    'Write-Output ([NmRealRead]::Read())',
  ].join('\r\n');
  const result = await mod.runInLane('windows', script, 40000);
  const parsed = lastJsonLine(result.output);
  return parsed || { error: String(result.output).slice(0, 400) };
}

/* ---------------------------------------------------------------- cleanup --- */

async function cleanup() {
  say('');
  say('=== cleanup ===');

  /* 1. every process, by the pid the launcher returned, from that root. */
  for (const pid of [...TRAP.pids].reverse()) {
    const report = await killTree(pid).catch((error) => ({ error: String(error) }));
    say(`  pid ${pid}: ${JSON.stringify(report)}`);
  }

  /* 2. what is still on the desktop, and every handle this lane can close, closed. */
  const destroyScript = [
    '$ErrorActionPreference = "Stop"',
    ...addTypeLines(b64(LAUNCHER_CSHARP), 'NmHidden', false),
    `$errorCode = 0`,
    `$handle = [NmHidden]::OpenByName("${TRAP.desktopName}", [ref]$errorCode)`,
    `$windowsLeft = 0`,
    `$processesLeft = @()`,
    `if ($handle -ne [IntPtr]::Zero) {`,
    `  $facts = @([NmHidden]::Enumerate($handle))`,
    `  $windowsLeft = $facts.Count`,
    `  $processesLeft = @($facts | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)`,
    `  [void][NmHidden]::CloseDesktop($handle)`,
    `}`,
    `Write-Output (@{ ok = $true; windows_left_on_the_desktop = $windowsLeft; processes_left_on_the_desktop = $processesLeft; open_last_error = $errorCode } | ConvertTo-Json -Compress -Depth 5)`,
  ].join('\r\n');
  const gone = lastJsonLine((await mod.runInLane('windows', destroyScript, 40000).catch((error) => ({ output: String(error) }))).output);
  say(`  the desktop "${TRAP.desktopName}" enumerated before teardown: ${JSON.stringify(gone)}`);

  /* 3. anything still on it is killed by the pid the enumeration gave. A process that is still
        on a desktop holds one of its handles, so this is the step that lets the desktop die. */
  if (gone && Array.isArray(gone.processes_left_on_the_desktop) && gone.processes_left_on_the_desktop.length) {
    const pids = gone.processes_left_on_the_desktop.map(Number).filter(Boolean);
    say(`  processes still on the desktop: ${JSON.stringify(pids)} - killing them by pid`);
    for (const pid of pids) await killTree(pid).catch((error) => say(`    pid ${pid}: ${String(error)}`));
  }

  /* 4. the lane itself goes next: it is one of the processes that can hold a desktop handle,
        and a handle held by THIS process's lane is a handle this process leaked. */
  try { mod.stopAll(); } catch (error) { TRAP.errors.push(`stopAll: ${String(error)}`); }
  await sleep(1200);

  /* 5. and only now is the name asked whether it is free, by trying to create it. */
  const existsAfter = await desktopExists(TRAP.desktopName);
  say(`  the desktop "${TRAP.desktopName}" after teardown: ${JSON.stringify(existsAfter)}`);

  RECEIPT.cleanup = {
    desktop_before_teardown: gone,
    desktop_after_teardown: existsAfter,
    desktop_destroyed: existsAfter.present === false,
    kill_report: TRAP.killed,
  };
  writeReceipt();
}

const survivors = [
  ...(RECEIPT.trap && RECEIPT.trap.killed ? RECEIPT.trap.killed : []).flatMap((entry) => entry.survivor_pids || []),
];
if (RECEIPT.cleanup && RECEIPT.cleanup.desktop_destroyed !== true) {
  say(`THE DESKTOP "${TRAP.desktopName}" WAS NOT DESTROYED: ${JSON.stringify(RECEIPT.cleanup.desktop_after_teardown)}`);
  process.exit(2);
}
if (survivors.length) {
  say(`SURVIVORS after cleanup: ${JSON.stringify(survivors)}`);
  process.exit(2);
}
process.exit(exitCode);
