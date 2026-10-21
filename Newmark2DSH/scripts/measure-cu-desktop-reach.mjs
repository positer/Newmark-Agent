#!/usr/bin/env node
/**
 * measure-cu-desktop-reach.mjs - the measured evidence for desktop reach and for the
 * ownership a virtual desktop holds over what it hosts.
 *
 * =====================================================================================
 * WHY THIS IS NOT PART OF THE GATE
 * =====================================================================================
 *
 * It creates a real desktop, launches a real process onto it, posts real input at it and
 * hard-kills the process that owns it. That is only acceptable where the machine's owner has
 * asked for exactly that, so it is hand-invoked and never a gate step.
 * `verify-computeruse-output-boundary.mjs` asserts the component spawns nothing when the gate
 * runs unattended; this script is the deliberate opposite of that rule.
 *
 * WHAT IT MEASURES
 * ----------------
 *   reach          whether a lane that has never opened the target's desktop can read a valid
 *                  handle as valid, and whether that answer comes back after the handle is
 *                  closed. Both directions are measured, because a claim that cannot fail is
 *                  not a measurement.
 *   delivery       app_observe / app_click / app_type / app_scroll / app_key against a window
 *                  on ANOTHER desktop, with the application's OWN click counter, text field,
 *                  wheel total and key counter as the evidence - not the component's status.
 *   control        the identical sequence against the same application on the INTERACTIVE
 *                  desktop, which must still pass.
 *   removed reach  with the prelude removed from a copy of the lane, the same hidden-desktop
 *                  sequence must go back to failing. This is the check that says the reach is
 *                  what made it work.
 *   ownership      a Job Object with KILL_ON_JOB_CLOSE, assigned per hosted pid. The owner is
 *                  then hard-killed with TerminateProcess - no finally runs - and a SEPARATE
 *                  process reports whether every hosted pid is gone and the desktop name is
 *                  free. With the job assignment removed, the same kill must leave them alive.
 *   ledger         the pid + start time record written under the component's own state
 *                  directory, and the reaper that acts on it only when the start time matches.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 *   - It never names a process class in cleanup. Every process it starts is tracked by the pid
 *     its own create call returned and terminated by that pid from that root.
 *   - It closes every desktop handle it opened, in the lane that opened it, and destroys the
 *     desktop by name afterwards; the receipt says whether the name was free again.
 *   - It writes nothing under C:\Users\12252\.Newmark.
 *
 * Invoke:
 *     node Newmark2DSH/scripts/measure-cu-desktop-reach.mjs
 *     node Newmark2DSH/scripts/measure-cu-desktop-reach.mjs --keep
 *     node Newmark2DSH/scripts/measure-cu-desktop-reach.mjs --control-removed-reach
 *     node Newmark2DSH/scripts/measure-cu-desktop-reach.mjs --control-no-job
 *
 * Exit codes: 0 the measurement completed; 1 it could not run; 2 cleanup or safety did not
 *             verify, or an assertion the phase claims did not hold.
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
const CONTROL_REMOVED_REACH = process.argv.includes('--control-removed-reach');
const CONTROL_NO_JOB = process.argv.includes('--control-no-job');

/* The shell the component's lanes will use. Pinned to the real PowerShell 7 install: the
   WindowsApps entry on PATH is a 0-byte app-execution alias. */
const PWSH = process.env.NM_REACH_PWSH || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'PowerShell', '7', 'pwsh.exe');
if (fs.existsSync(PWSH)) process.env.NEWMARK_CU_POWERSHELL = PWSH;
const CSC = path.join(process.env.WINDIR || 'C:\\WINDOWS', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(REPO, 'evidence', 'cu-desktop-reach', STAMP);
const CAPTURES = path.join(OUT, 'captures');
fs.mkdirSync(CAPTURES, { recursive: true });
const SCRATCH = path.join(process.env.TEMP || '.', 'nm-cu-reach');
fs.mkdirSync(SCRATCH, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line = '') => process.stdout.write(String(line) + '\n');
const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const COMPONENT_SHA_BEFORE = sha256(COMPONENT_ENTRY);
const DESKTOP_NAME = `NmReach${process.pid}`;

/* =====================================================================================
 * the lane, or a copy of it with one thing removed
 * ===================================================================================== */

/**
 * The removed-reach control, composed against the real file and asserted to hit.
 *
 * It rewrites exactly one function: `runInLaneWithReach` becomes a pass-through that calls
 * `runInLane` and ignores the target. Everything else - the helper, the prelude builder, the
 * plumbing that names the window, the lane routing - is untouched, so the two runs differ in
 * one variable and the difference between them is the reach and nothing else.
 */
const REMOVED_REACH_FROM = `  const prelude = desktopReachPrelude(targetHandle);
  if (!prelude) return await runInLane(lane, script, timeoutMs);`;
const REMOVED_REACH_TO = `  const prelude = '';
  if (!prelude) return await runInLane(lane, script, timeoutMs);`;

function composeVariant(source, mode) {
  const applied = [];
  let patched = source;
  if (mode === 'removed-reach') {
    const hits = patched.split(REMOVED_REACH_FROM).length - 1;
    if (hits !== 1) throw new Error(`the removed-reach control cannot be composed: ${hits} matches`);
    patched = patched.split(REMOVED_REACH_FROM).join(REMOVED_REACH_TO);
    applied.push('runInLaneWithReach: the reach prelude disabled');
  }
  return { patched, applied };
}

const VARIANT = CONTROL_REMOVED_REACH ? 'removed-reach' : 'shipped-lane';
let mod;
let VARIANT_REPORT = { mode: VARIANT, applied: [], dir: null, sha256: null };
if (CONTROL_REMOVED_REACH) {
  const { patched, applied } = composeVariant(fs.readFileSync(COMPONENT_ENTRY, 'utf8'), 'removed-reach');
  /* A copy of the whole component tree: the lane's imports are relative, and a lone file in
     a temp directory would resolve them against nothing. */
  const variant = path.join(OUT, 'variant-removed-reach');
  fs.cpSync(COMPUTERUSE_DIR, variant, { recursive: true });
  const variantEntry = path.join(variant, 'lib', 'win32.js');
  fs.writeFileSync(variantEntry, patched, 'utf8');
  VARIANT_REPORT = { mode: VARIANT, applied, dir: variant, sha256: sha256(variantEntry) };
  mod = await import(new URL(`file://${variantEntry.replace(/\\/g, '/')}`));
} else {
  mod = await import(new URL(`file://${COMPONENT_ENTRY.replace(/\\/g, '/')}`));
}
const COMPONENT_SHA_AFTER_LOAD = sha256(COMPONENT_ENTRY);
if (COMPONENT_SHA_BEFORE !== COMPONENT_SHA_AFTER_LOAD) {
  say('THE REPOSITORY LANE FILE WAS WRITTEN TO BY THIS RUN. Refusing to continue.');
  process.exit(2);
}

/* =====================================================================================
 * the C# this harness compiles into a lane: the parts the plugin deliberately does not own
 * ===================================================================================== */

/**
 * Creating a process on a named desktop is the launcher's job, not the component's, so it
 * lives here. What the component owns is the reach and the job object, and both are called
 * through `[NewmarkCuNative]` below rather than reimplemented - a harness that reimplemented
 * them could pass while the plugin was broken.
 */
const HARNESS_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

/* ------------------------------------------------------------------ *
 * the launcher: the desktop, the process on it, and the hard kill
 *
 * A class of its own, and that is a MEASURED requirement rather than tidiness. With the
 * desktop maker and the process launcher compiled into one type, the child starts on a
 * freshly created desktop and dies before its first instruction (0xC0000142 for a native
 * application, 0x8007008A for a managed one); with them in two types, the same calls on the
 * same newly created desktop run and the probe publishes its state. Both arrangements were
 * compiled and run in the same lane, in the same process, on the same desktop: one class
 * fails, two work. Nothing else differs between them, so this is what was measured.
 * ------------------------------------------------------------------ */
public static class NmReachLauncher
{
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumDesktopWindows(IntPtr desktop, EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumDesktops(IntPtr station, EnumDesktopProc callback, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "OpenDesktopW", SetLastError = true)] public static extern IntPtr OpenDesktopHandle(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  public delegate bool EnumDesktopProc(string name, IntPtr lParam);

  const uint DESKTOP_READOBJECTS = 0x0001;
  const uint DESKTOP_ENUMERATE = 0x0040;
  const uint DESKTOP_READATTRIBUTES = 0x0100;
  const uint DESKTOP_ALL = 0x0001 | 0x0002 | 0x0004 | 0x0008 | 0x0010 | 0x0020 | 0x0040 | 0x0080 | 0x0100 | 0x0200;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct STARTUPINFO
  {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION
  {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES
  {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    public bool bInheritHandle;
  }

  /* CreateProcess's application name is left null ON PURPOSE.
     
     Measured on this machine: the identical call, with the identical lpDesktop, the identical
     command line and the identical startup record, starts a process that runs when
     lpApplicationName is null and starts a process that dies before its first instruction
     (0xC0000142 STATUS_DLL_INIT_FAILED for a native application, 0x8007008A for a managed
     one) when it is the application path. The desktop is not at fault and neither is the
     launch: with lpApplicationName set for a desktop other than the caller's, the loader
     initialises the image against the WRONG desktop's window station, and the process cannot
     load its own user interface. Verified by running the same sequence both ways onto the
     same freshly created desktop. */
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateProcessW", SetLastError = true)]
  public static extern bool CreateProcess(string application, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION information);

  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "SetEnvironmentVariableW", SetLastError = true)] public static extern bool SetEnvironmentVariable(string name, string value);

  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint CREATE_NEW_CONSOLE = 0x00000010;


  /* The child's state path travels on the COMMAND LINE, not in the environment.
     
     Measured on this machine: the same launch, onto the same freshly created desktop, with the
     same command line, starts a probe that runs when the state path is an argument and a probe
     that dies before its first instruction when the path is handed over through
     SetEnvironmentVariableW and an inherited environment block. Setting the parent's variable
     and then passing a null environment block with CREATE_UNICODE_ENVIRONMENT is a
     combination that does not behave as it reads. The launch that works is the one the earlier
     phase's launcher already used, and it is the one kept here: a command line, and no
     environment block at all. */
  public static int Launch(string desktopQualified, string application, string statePath, string extraArgument)
  {
    string command = "\"" + application + "\" --state \"" + statePath + "\"";
    if (extraArgument != null && extraArgument.Length > 0) command = command + " " + extraArgument;
    STARTUPINFO startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    startup.lpDesktop = desktopQualified;
    PROCESS_INFORMATION information = new PROCESS_INFORMATION();
    bool created = CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref startup, out information);
    if (!created) return -1;
    int pid = information.dwProcessId;
    CloseHandle(information.hThread);
    CloseHandle(information.hProcess);
    return pid;
  }

  public static string ExitOf(int processId)
  {
    if (processId <= 0) return "n/a";
    IntPtr process = OpenProcess(0x1000, false, processId);
    if (process == IntPtr.Zero) return "no-open";
    try { uint code = 0; if (!GetExitCodeProcess(process, out code)) return "no-code"; return code.ToString(); }
    finally { CloseHandle(process); }
  }

  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  /* The DEVICE parameter is a POINTER, and that is measured rather than stylistic: the
     identical declaration with a string device and a null handed to it from PowerShell answers
     ERROR_INVALID_PARAMETER (87) and creates nothing, silently, so every later step then runs
     against whatever desktop the caller was already on. With an IntPtr it is handed
     IntPtr.Zero and the desktop is really created. The plugin's own helper declares it as a
     string and calls it from C#, where a null is a null pointer and the call is correct. */
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateDesktopW", SetLastError = true)]
  static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, uint flags, uint access, IntPtr attributes);

  /* Creates the desktop and KEEPS the handle, which is the whole reason this harness can
     launch onto it at all.
     
     A desktop object lives exactly as long as something holds a handle to it. Create it,
     close the handle, and the object is gone - the name is free again, OpenDesktopW answers
     2 (ERROR_FILE_NOT_FOUND), and CreateProcessW with that lpDesktop SUCCEEDS and returns a
     pid whose process dies before it can run a single line of its own code. That is the
     failure this harness spent a while staring at, and it is not a defect in the code under
     measurement: it is what the kernel does to an object nobody references. */
  public static string EnsureDesktop(string name)
  {
    IntPtr existing = OpenDesktopHandle(name, 0, false, DESKTOP_ALL);
    if (existing != IntPtr.Zero) return "{\"created_now\":false,\"present\":true,\"handle\":\"0x" + existing.ToInt64().ToString("X") + "\"}";
    int openError = Marshal.GetLastWin32Error();
    IntPtr created = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, DESKTOP_ALL, IntPtr.Zero);
    int createError = Marshal.GetLastWin32Error();
    bool present = created != IntPtr.Zero;
    return "{\"created_now\":\"" + (present ? "true" : "false") + "\",\"present\":" + (present ? "true" : "false") + ",\"open_last_error\":" + openError + ",\"create_last_error\":" + createError + ",\"handle\":\"0x" + (present ? created.ToInt64().ToString("X") : "0") + "\"}";
  }

  /* The handle a desktop read opened, given back. Separate from the read so a caller can say
     exactly which handle it closed. */
  public static bool CloseHandleValue(Int64 handle)
  {
    if (handle == 0) return false;
    return CloseDesktop(new IntPtr(handle));
  }
}

/* ------------------------------------------------------------------ *
 * the harness: everything that is NOT the launcher
 *
 * The job-object reads, the ledger check, the desktop reads and the process probes. None of
 * these creates a desktop or starts a process, which is what keeps the launcher's arrangement
 * the measured one.
 * ------------------------------------------------------------------ */
public static class NmReachHarness
{
  const uint DESKTOP_READOBJECTS = 0x0001;
  const uint DESKTOP_ENUMERATE = 0x0040;
  const uint DESKTOP_READATTRIBUTES = 0x0100;

  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  /* Ends one process by pid, from this harness and not from the plugin: the hard kill is the
     event under measurement, so it must not be the plugin's own helper doing it. */
  public static bool HardKill(int processId)
  {
    if (processId <= 0) return false;
    IntPtr process = OpenProcess(0x0001, false, processId);
    if (process == IntPtr.Zero) return false;
    try { return TerminateProcess(process, 1); }
    finally { CloseHandle(process); }
  }

  /* The ledger directory, asked of the component. The component exports its own writer
     (desktopHostLedger), so the message here is only checked, never used as the path. */
  public static string LedgerProperties(string nativeTypeName)
  {
    Type native = Type.GetType(nativeTypeName);
    if (native == null) return "";
    System.Reflection.PropertyInfo property = native.GetProperty("LedgerDirectory");
    if (property == null) return "";
    object value = property.GetValue(null, null);
    return value == null ? "" : (string)value;
  }

  /* Every live member of a job, straight from the kernel, as the plugin reports it.
     The plugin's type is compiled into the LANE by the component, not by this harness, and a
     C# block compiled here cannot name it at compile time. So it is reached by name at run
     time: the harness hands the lane the plugin's own answer, and the lane is the side that
     can see the type. */
  public static string JobMembers(string jobName, string nativeTypeName)
  {
    Type native = Type.GetType(nativeTypeName);
    if (native == null) return "";
    System.Reflection.MethodInfo method = native.GetMethod("JobMemberProcessIds");
    if (method == null) return "";
    object listed = method.Invoke(null, new object[] { jobName });
    return listed == null ? "" : (string)listed;
  }

  /* Whether one pid is alive right now, asked the only way that cannot be fooled by a pid
     being reused: by opening the process and asking for its exit code, with
     PROCESS_QUERY_LIMITED_INFORMATION, which is the only access a component should need. */
  public static bool Alive(int processId)
  {
    if (processId <= 0) return false;
    IntPtr process = OpenProcess(0x1000, false, processId);
    if (process == IntPtr.Zero) return false;
    try
    {
      uint code = 0;
      if (!GetExitCodeProcess(process, out code)) return false;
      return code == 259;
    }
    finally { CloseHandle(process); }
  }

  /* The windows on one desktop, and the pids that own them. Deliberately NOT the handle
     EnsureDesktop keeps: a close of the wrong handle would take the desktop with it, and this
     is the read used to say whether the hosted pids are really gone. */
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true)] static extern bool EnumDesktopWindows(IntPtr desktop, EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] static extern bool EnumDesktops(IntPtr station, EnumDesktopProc callback, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "OpenDesktopW", SetLastError = true)] static extern IntPtr OpenDesktopHandle(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  delegate bool EnumDesktopProc(string name, IntPtr lParam);



  /* The windows on a desktop, opened by name. Deliberately NOT the handle EnsureDesktop keeps:
     a close of the wrong handle would take the desktop with it, and this is the read used to
     say whether the hosted pids are really gone. */
  public static string DesktopState(string name)
  {
    int windows = 0;
    List<string> pids = new List<string>();
    IntPtr desktop = OpenDesktopHandle(name, 0, false, DESKTOP_READOBJECTS | DESKTOP_ENUMERATE | DESKTOP_READATTRIBUTES);
    if (desktop == IntPtr.Zero)
    {
      return "{\"present\":false,\"last_error\":" + Marshal.GetLastWin32Error() + "}";
    }
    try
    {
      EnumDesktopWindows(desktop, delegate(IntPtr hWnd, IntPtr lParam)
      {
        windows++;
        uint pid = 0;
        GetWindowThreadProcessId(hWnd, out pid);
        string text = pid.ToString();
        if (!pids.Contains(text)) pids.Add(text);
        return true;
      }, IntPtr.Zero);
    }
    finally { CloseDesktop(desktop); }
    StringBuilder json = new StringBuilder();
    json.Append("{\"present\":true,\"windows\":").Append(windows).Append(",\"pids\":[");
    for (int index = 0; index < pids.Count; index++)
    {
      if (index > 0) json.Append(",");
      json.Append(pids[index]);
    }
    json.Append("]}");
    return json.ToString();
  }


  /* Every desktop name on the station, walked rather than probed: EnumDesktops hands the
     names back, which is the honest way to answer "is a name free" without a probe list. */
  public static string DesktopNamesOnStation()
  {
    List<string> names = new List<string>();
    EnumDesktops(GetProcessWindowStation(), delegate(string name, IntPtr lParam)
    {
      names.Add(name);
      return true;
    }, IntPtr.Zero);
    StringBuilder json = new StringBuilder("[");
    for (int index = 0; index < names.Count; index++)
    {
      if (index > 0) json.Append(",");
      json.Append("\"").Append(names[index].Replace("\\", "\\\\")).Append("\"");
    }
    json.Append("]");
    return json.ToString();
  }
}
`;

/* =====================================================================================
 * the probe application: an ordinary WinForms window with its own counters
 * ===================================================================================== */

const APP_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class NmReachProbeForm : Form
{
  readonly string statePath;
  readonly TextBox input;
  readonly Panel pad;
  readonly Timer timer;
  int ticks;
  int clickCount;
  int wheelDelta;
  int keyCount;
  string lastMessage = "none";
  string lastClientPoint = "";
  string lastKey = "";

  public NmReachProbeForm(string path)
  {
    statePath = path;
    Text = "Newmark desktop-reach probe";
    ClientSize = new Size(640, 420);
    StartPosition = FormStartPosition.Manual;
    Location = new Point(40, 40);
    BackColor = Color.White;
    KeyPreview = true;

    Label banner = new Label();
    banner.Text = "DESKTOP REACH PROBE";
    banner.Font = new Font("Segoe UI", 15f, FontStyle.Bold);
    banner.SetBounds(10, 6, 620, 32);
    Controls.Add(banner);

    input = new TextBox();
    input.Name = "probeInput";
    input.Font = new Font("Consolas", 14f);
    input.SetBounds(10, 46, 620, 30);
    Controls.Add(input);

    pad = new Panel();
    pad.Name = "probePad";
    pad.SetBounds(10, 90, 620, 220);
    pad.BackColor = Color.FromArgb(240, 244, 250);
    pad.BorderStyle = BorderStyle.FixedSingle;
    Controls.Add(pad);

    pad.MouseDown += delegate(object sender, MouseEventArgs e) { OnPadDown(e); };
    pad.Paint += delegate(object sender, PaintEventArgs e) { DrawPad(e.Graphics); };
    input.TextChanged += delegate(object sender, EventArgs e) { Persist(); };
    input.KeyDown += delegate(object sender, KeyEventArgs e) { keyCount = keyCount + 1; lastKey = e.KeyData.ToString(); Persist(); };
    this.MouseDown += delegate(object sender, MouseEventArgs e) { lastMessage = "form-mousedown"; Persist(); };

    timer = new Timer();
    timer.Interval = 200;
    timer.Tick += delegate(object sender, EventArgs e) { OnTick(); };
    timer.Start();

    Load += delegate(object sender, EventArgs e) { Persist(); };
    Shown += delegate(object sender, EventArgs e) { Persist(); };
  }

  void OnTick()
  {
    ticks = ticks + 1;
    try { pad.Invalidate(); pad.Update(); } catch (Exception) { }
    if (ticks % 3 == 0) Persist();
  }

  void OnPadDown(MouseEventArgs e)
  {
    clickCount = clickCount + 1;
    lastMessage = "pad-mousedown";
    lastClientPoint = e.X + "," + e.Y;
    try { pad.Invalidate(); pad.Update(); } catch (Exception) { }
    Persist();
  }

  protected override void OnMouseWheel(MouseEventArgs e)
  {
    wheelDelta = wheelDelta + e.Delta;
    lastMessage = "mousewheel";
    Persist();
    base.OnMouseWheel(e);
  }

  void DrawPad(Graphics graphics)
  {
    graphics.Clear(Color.FromArgb(240, 244, 250));
    using (Font big = new Font("Segoe UI", 22f, FontStyle.Bold))
    using (Font small = new Font("Consolas", 13f))
    using (SolidBrush ink = new SolidBrush(Color.FromArgb(20, 30, 60)))
    using (SolidBrush red = new SolidBrush(Color.FromArgb(170, 30, 30)))
    {
      graphics.DrawString("CLICKS " + clickCount.ToString(), big, red, 14, 10);
      graphics.DrawString("TEXT   " + input.Text, small, ink, 14, 66);
      graphics.DrawString("KEYS   " + keyCount.ToString() + "  LAST " + lastKey, small, ink, 14, 94);
      graphics.DrawString("WHEEL  " + wheelDelta.ToString() + "  LAST " + lastMessage, small, ink, 14, 122);
      graphics.DrawString("AT     " + lastClientPoint, small, ink, 14, 150);
    }
  }

  void Persist()
  {
    try
    {
      StringBuilder json = new StringBuilder();
      json.Append("{");
      json.Append("\"pid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id).Append(",");
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
      json.Append("\"visible\":").Append(Visible ? "true" : "false").Append(",");
      json.Append("\"screen_rect\":{\"x\":").Append(Left).Append(",\"y\":").Append(Top).Append(",\"width\":").Append(Width).Append(",\"height\":").Append(Height).Append("},");
      json.Append("\"pad_screen\":");
      Point origin = pad.PointToScreen(new Point(0, 0));
      json.Append("{\"x\":").Append(origin.X).Append(",\"y\":").Append(origin.Y).Append(",\"width\":").Append(pad.Width).Append(",\"height\":").Append(pad.Height).Append("}");
      json.Append("}");
      File.WriteAllText(statePath, json.ToString(), Encoding.UTF8);
    }
    catch (Exception) { }
  }

  static string Escape(string value)
  {
    if (value == null) return "";
    return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
  }

  [STAThread]
  public static void Main(string[] args)
  {
    string statePath = null;
    for (int index = 0; index < args.Length - 1; index++)
    {
      if (args[index] == "--state") statePath = args[index + 1];
    }
    if (String.IsNullOrEmpty(statePath)) statePath = Environment.GetEnvironmentVariable("NM_STATE_OUT");
    if (String.IsNullOrEmpty(statePath)) statePath = Path.Combine(Path.GetTempPath(), "nm-cu-reach-state.json");
    /* Written BEFORE anything is created, so a probe that cannot build its window still says
       so from its own side rather than leaving a reader guessing whether it ever started. */
    try { File.WriteAllText(statePath + ".started", "pid=" + System.Diagnostics.Process.GetCurrentProcess().Id + " desktop-path=" + statePath, Encoding.UTF8); } catch (Exception) { }
    try
    {
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      Application.Run(new NmReachProbeForm(statePath));
    }
    catch (Exception error)
    {
      try { File.WriteAllText(statePath + ".failed", error.ToString(), Encoding.UTF8); } catch (Exception) { }
    }
  }
}
`;

/* =====================================================================================
 * the real desktop, read from OUTSIDE the component
 * ===================================================================================== */

const REAL_READ_CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NmRealDesktop
{
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  public static string Read()
  {
    POINT point;
    GetCursorPos(out point);
    IntPtr foreground = GetForegroundWindow();
    StringBuilder title = new StringBuilder(512);
    GetWindowTextW(foreground, title, title.Capacity);
    StringBuilder windows = new StringBuilder();
    int count = 0;
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
    {
      if (!IsWindowVisible(hWnd)) return true;
      count++;
      if (windows.Length < 4000)
      {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        windows.Append("0x").Append(hWnd.ToInt64().ToString("X")).Append(":").Append(pid).Append("|");
      }
      return true;
    }, IntPtr.Zero);
    return "{\"x\":" + point.X + ",\"y\":" + point.Y
      + ",\"foreground\":\"0x" + foreground.ToInt64().ToString("X") + "\""
      + ",\"foreground_title\":\"" + title.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""
      + ",\"visible_window_count\":" + count
      + ",\"visible_windows\":\"" + windows.ToString() + "\"}";
  }
}
`;

/* =====================================================================================
 * helpers
 * ===================================================================================== */

const RECEIPT = {
  phase: 'desktop reach in the persistent lane, and the job object a virtual desktop holds over what it hosts',
  started_at: new Date().toISOString(),
  variant: VARIANT_REPORT,
  component_entry: COMPONENT_ENTRY,
  component_entry_sha256: COMPONENT_SHA_BEFORE,
  component_entry_sha256_after_load: COMPONENT_SHA_AFTER_LOAD,
  component_entry_bytes: fs.statSync(COMPONENT_ENTRY).size,
  lane_shell: PWSH,
  node: process.version,
  evidence_dir: OUT,
  desktop_name: DESKTOP_NAME,
  measurements: {},
};
const TRAP = { pids: [], desktopName: DESKTOP_NAME, errors: [], cleanup: null };

function writeReceipt() {
  RECEIPT.finished_at = new Date().toISOString();
  RECEIPT.trap = { pids: TRAP.pids, desktop_name: TRAP.desktopName, errors: TRAP.errors, cleanup: TRAP.cleanup };
  const file = path.join(OUT, 'receipt.json');
  fs.writeFileSync(file, JSON.stringify(RECEIPT, null, 2));
  say('');
  say(`receipt: ${file}`);
}

function lastJsonLine(output) {
  const lines = String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const brace = lines[index].indexOf('{');
    if (brace < 0) continue;
    try { return JSON.parse(lines[index].slice(brace)); } catch { /* next */ }
  }
  return null;
}

function readStateFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** One lane script with the harness C# preloaded, so a lane can create processes itself. */
function harnessScript(lines) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$__harness = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(${JSON.stringify(b64(HARNESS_CSHARP))}))`,
    'if (-not ("NmReachHarness" -as [type])) { Add-Type -TypeDefinition $__harness -ErrorAction Stop }',
    /* The plugin's compiled type, handed to the harness as the object the LANE sees, so a
       lookup by name cannot fail on an assembly identity this harness should not know. */
    '$__native = [NewmarkCuNative]',
    ...lines,
  ].join('\r\n');
}

/* =====================================================================================
 * the run
 * ===================================================================================== */

let exitCode = 0;

async function main() {
  say(`=== desktop reach measurement, variant="${VARIANT}" ===`);
  say(`  component: ${COMPONENT_ENTRY}`);
  say(`  sha256:    ${COMPONENT_SHA_BEFORE}`);
  say(`  desktop:   ${DESKTOP_NAME}`);
  say('');

  /* ---------------------------------------------------------- 0. baseline, before anything --- */
  say('=== 0. the interactive desktop, before anything is created ===');
  const baselineRaw = await mod.runInLane('windows', harnessScript([
    'Write-Output (@{ ok=$true; station=[NewmarkCuNative]::CurrentWindowStationName(); desktop=[NewmarkCuNative]::CurrentThreadDesktopName(); reach=[NewmarkCuNative]::DesktopReachReport(); desktops=([NmReachHarness]::DesktopNamesOnStation()) } | ConvertTo-Json -Compress -Depth 5)',
  ]), 60000);
  const baseline = lastJsonLine(baselineRaw.output);
  if (!baseline || baseline.ok !== true) {
    say(`  the baseline lane call did not answer: ${String(baselineRaw.output).slice(0, 800)}`);
    RECEIPT.measurements.baseline = { ok: false, raw: String(baselineRaw.output).slice(0, 2000) };
    return 1;
  }
  RECEIPT.measurements.baseline = baseline;
  say(`  lane runs on ${baseline.station}\\${baseline.desktop}; desktops on the station: ${JSON.parse(baseline.desktops).length}`);
  say(`  reach held at the start: ${baseline.reach}`);

  const realBefore = await readRealDesktop();

  /* ---------------------------------------------------------- 1. the probe executable ------- */
  say('');
  say('=== 1. compile the probe application ===');
  const appExe = path.join(SCRATCH, 'NmReachProbe.exe');
  const appSource = path.join(SCRATCH, 'NmReachProbe.cs');
  fs.writeFileSync(appSource, APP_CSHARP, 'utf8');
  const compile = await mod.runInLane('windows', [
    '$ErrorActionPreference = "Stop"',
    `& ${JSON.stringify(CSC)} /nologo /target:winexe /langversion:5 /out:${JSON.stringify(appExe)} /reference:System.Windows.Forms.dll /reference:System.Drawing.dll ${JSON.stringify(appSource)} 2>&1 | Out-String`,
    `Write-Output (@{ ok=(Test-Path -LiteralPath ${JSON.stringify(appExe)}); bytes=(Get-Item -LiteralPath ${JSON.stringify(appExe)} -ErrorAction SilentlyContinue).Length } | ConvertTo-Json -Compress)`,
  ].join('\r\n'), 180000);
  const compiled = lastJsonLine(compile.output);
  say(`  ${appExe} -> ${JSON.stringify(compiled)}`);
  if (!compiled || compiled.ok !== true) {
    say(`  the probe application did not compile: ${String(compile.output).slice(0, 1500)}`);
    return 1;
  }

  /* ---------------------------------------------------------- 2. the desktop + the launch ---- */
  say('');
  say('=== 2. create the desktop through the component, then launch onto it ===');
  const appState = path.join(SCRATCH, 'state.json');
  const controlState = path.join(SCRATCH, 'state-control.json');
  for (const file of [appState, controlState, `${appState}.started`, `${controlState}.started`, `${appState}.failed`, `${controlState}.failed`]) {
    try { fs.unlinkSync(file); } catch { /* absent */ }
  }

  const launchRaw = await mod.runInLane('windows', harnessScript([
    `$desktop = [NmReachLauncher]::EnsureDesktop(${JSON.stringify(DESKTOP_NAME)})`,
    `$reachName = [NewmarkCuNative]::EnsureDesktopReachForName(${JSON.stringify(DESKTOP_NAME)})`,
    `$pid1 = [NmReachLauncher]::Launch(${JSON.stringify(`winsta0\\${DESKTOP_NAME}`)}, ${JSON.stringify(appExe)}, ${JSON.stringify(appState)}, "")`,
    `$pid2 = [NmReachLauncher]::Launch("Default", ${JSON.stringify(appExe)}, ${JSON.stringify(controlState)}, "")`,
    'Start-Sleep -Milliseconds 3000',
    `Write-Output (@{ ok=$true; desktop=$desktop; reach_name_code=$reachName; hidden_pid=$pid1; control_pid=$pid2; reach=[NewmarkCuNative]::DesktopReachReport(); hidden_exit=[NmReachLauncher]::ExitOf([int]$pid1); control_exit=[NmReachLauncher]::ExitOf([int]$pid2); desktop_state=[NmReachHarness]::DesktopState(${JSON.stringify(DESKTOP_NAME)}) } | ConvertTo-Json -Compress)`,
  ]), 120000);
  const launched = lastJsonLine(launchRaw.output);
  if (!launched || launched.ok !== true) {
    say(`  the launch did not answer: ${String(launchRaw.output).slice(0, 1500)}`);
    return 1;
  }
  TRAP.pids.push(Number(launched.hidden_pid), Number(launched.control_pid));
  /* The harness's own handle on the desktop, kept for the run and given back at the end. A
     desktop lives only as long as something holds a handle to it. */
  const desktopHandle = JSON.parse(launched.desktop).handle;
  RECEIPT.desktop_handle_held_by_the_harness = desktopHandle;
  say(`  the desktop: ${launched.desktop}`);
  say(`  the desktop state right after the launch: ${launched.desktop_state}`);
  say(`  hidden child exit code ${launched.hidden_exit ?? '(none)'}    control child exit code ${launched.control_exit ?? '(none)'}`);
  say(`  reach by name -> code ${launched.reach_name_code}; lane now holds: ${launched.reach}`);
  say(`  hidden pid=${launched.hidden_pid}   interactive control pid=${launched.control_pid}`);

  const hiddenState = readStateFile(appState);
  const controlStateJson = readStateFile(controlState);
  say(`  the probe on the hidden desktop says pid=${hiddenState && hiddenState.pid} handle=${hiddenState && hiddenState.handle}`);
  say(`  the probe on the interactive desktop says pid=${controlStateJson && controlStateJson.pid} handle=${controlStateJson && controlStateJson.handle}`);
  RECEIPT.measurements.launch = {
    reach_name_code: launched.reach_name_code,
    hidden_pid: launched.hidden_pid,
    control_pid: launched.control_pid,
    hidden_state: hiddenState,
    control_state: controlStateJson,
  };
  if (!hiddenState || !controlStateJson) {
    const evidence = {};
    for (const [name, file] of [['hidden', appState], ['control', controlState]]) {
      for (const suffix of ['.started', '.failed', '']) {
        const target = `${file}${suffix}`;
        evidence[`${name}${suffix || '.state'}`] = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').slice(0, 400) : 'absent';
      }
    }
    say('  what the probe application left behind:');
    for (const [name, value] of Object.entries(evidence)) say(`    ${name}: ${value}`);
    say(`  THE PROBE APPLICATION DID NOT PUBLISH ITS STATE. There is nothing to measure: a delivery this phase cannot check against the application's own counters is not evidence.`);
    RECEIPT.measurements.blocked = 'the probe application published no state file, so no behavioural assertion could be made';
    RECEIPT.measurements.probe_evidence = evidence;
    return 1;
  }

  /* ---------------------------------------------------------- 3. the reach gap ---------------- */
  say('');
  say('=== 3. what a lane that has never opened the desktop can see ===');
  /* A FRESH lane that has never opened the desktop: this is the gap the whole phase is about,
     and it is measured before anything is pinned. */
  /* THE GAP, measured before anything is pinned anywhere: a lane that has never opened the
     target's desktop reads the target's live handle as invalid. This is the defect the whole
     phase is about, and it is taken from a lane that has done nothing else. */
  const gapRaw = await mod.runInLane('sparse', [
    '$ErrorActionPreference = "Stop"',
    `$probe = [IntPtr]::new([Convert]::ToInt64(${JSON.stringify(String((hiddenState || {}).handle || '0x0'))}, 16))`,
    '$before = [NewmarkCuNative]::IsWindow($probe)',
    '$pidBefore = [NewmarkCuNative]::GetProcessId($probe)',
    'Write-Output (@{ ok=$true; iswindow_before=$before; pid_before=$pidBefore; handle=$probe.ToInt64().ToString("X") } | ConvertTo-Json -Compress)',
  ].join('\r\n'), 60000);
  const gap = lastJsonLine(gapRaw.output);
  say(`  the sparse lane, which has never opened "${DESKTOP_NAME}": IsWindow=${gap && gap.iswindow_before} pid=${gap && gap.pid_before}`);
  RECEIPT.measurements.reach_gap = gap;

  /* ---------------------------------------------------------- 4. the plugin's own sequence ---- */
  say('');
  say('=== 4. the component drives the window on the other desktop ===');
  const owner = 'measure-desktop-reach';
  await mod.runComputerUse({ action: 'takeover_start', ownerId: owner, mouseMode: 'virtual', timeoutMs: 30000 });

  const hiddenDrive = await drive({
    label: 'hidden',
    handle: String(hiddenState.handle),
    text: 'nm-hidden',
    statePath: appState,
    owner,
  });
  RECEIPT.measurements.hidden_drive = hiddenDrive;

  const modeAfterHidden = JSON.parse(await mod.runComputerUse({ action: 'mode_report', ownerId: owner, timeoutMs: 60000 }));
  RECEIPT.measurements.reach_after_hidden = modeAfterHidden.desktop_reach;
  say('');
  say('  what each lane holds after the hidden-desktop sequence:');
  for (const lane of (modeAfterHidden.desktop_reach && modeAfterHidden.desktop_reach.lanes) || []) {
    if (lane.held_desktop_count) say(`    ${lane.lane.padEnd(16)} holds ${lane.desktops_held}   (last target ${lane.reach && lane.reach.window_handle})`);
  }

  /* ---------------------------------------------------------- 5. the interactive control ------ */
  say('');
  say('=== 5. CONTROL: the same sequence against the same application on the INTERACTIVE desktop ===');
  const controlDrive = await drive({
    label: 'interactive-control',
    handle: String(controlStateJson.handle),
    text: 'nm-control',
    statePath: controlState,
    owner,
  });
  RECEIPT.measurements.control_drive = controlDrive;

  await mod.runComputerUse({ action: 'takeover_stop', ownerId: owner, timeoutMs: 30000 });

  /* ---------------------------------------------------------- 6. the real desktop is untouched */
  say('');
  say('=== 6. the real desktop, read from outside the component ===');
  const realAfter = await readRealDesktop();
  const cursorMoved = Number(realBefore.x) !== Number(realAfter.x) || Number(realBefore.y) !== Number(realAfter.y);
  const foregroundChanged = String(realBefore.foreground).toLowerCase() !== String(realAfter.foreground).toLowerCase();
  const windowSetChanged = String(realBefore.visible_windows) !== String(realAfter.visible_windows);
  say(`  cursor ${realBefore.x},${realBefore.y} -> ${realAfter.x},${realAfter.y}  moved=${cursorMoved}`);
  say(`  foreground ${realBefore.foreground} -> ${realAfter.foreground}  changed=${foregroundChanged}`);
  say(`  visible window set changed=${windowSetChanged}`);
  RECEIPT.measurements.real_desktop = {
    before: { x: realBefore.x, y: realBefore.y, foreground: realBefore.foreground, count: realBefore.visible_window_count },
    after: { x: realAfter.x, y: realAfter.y, foreground: realAfter.foreground, count: realAfter.visible_window_count },
    cursor_moved: cursorMoved,
    foreground_changed: foregroundChanged,
    window_set_changed: windowSetChanged,
  };

  /* ---------------------------------------------------------- 7. ownership ------------------- */
  say('');
  say('=== 7. ownership: the job object, the ledger, and a hard kill ===');
  const ownership = await measureOwnership({
    desktopName: DESKTOP_NAME,
    appExe,
    statePath: appState,
    hiddenPid: Number(launched.hidden_pid),
    jobName: `newmark-cu-desktop-${DESKTOP_NAME}`,
    noJob: CONTROL_NO_JOB,
  });
  RECEIPT.measurements.ownership = ownership;

  return 0;
}

/* =====================================================================================
 * the delivery sequence
 * ===================================================================================== */

async function drive({ label, handle, text, statePath, owner }) {
  const before = readStateFile(statePath);
  const steps = [];
  const read = () => readStateFile(statePath);

  const step = async (name, options) => {
    const started = Date.now();
    let parsed;
    try {
      parsed = JSON.parse(await mod.runComputerUse({ ownerId: owner, timeoutMs: 90000, ...options }));
    } catch (error) {
      parsed = { ok: false, error_code: 'harness_exception', error: String(error && error.message ? error.message : error) };
    }
    const after = read();
    const record = {
      action: name,
      ok: parsed.ok === true,
      error_code: parsed.error_code || null,
      lane: parsed.lane || (parsed.telemetry && parsed.telemetry.lane) || null,
      desktop_reach: (parsed.telemetry && parsed.telemetry.desktop_reach) || null,
      elapsed_ms: Date.now() - started,
      state_after: after,
      receipt_keys: Object.keys(parsed).slice(0, 30),
    };
    steps.push(record);
    return { parsed, after, record };
  };

  const padPoint = before && before.pad_screen
    ? { x: before.pad_screen.x + 140, y: before.pad_screen.y + 110 }
    : null;

  say(`  --- ${label}: handle ${handle} ---`);

  const observeA = await mod.runComputerUse({ action: 'app_observe', ownerId: owner, windowHandle: handle, timeoutMs: 90000 });
  const observeAParsed = JSON.parse(observeA);
  steps.push({ action: 'app_observe (first)', ok: observeAParsed.ok === true, error_code: observeAParsed.error_code || null, image_path: observeAParsed.image_path || null, image_bytes: observeAParsed.image_bytes || null, capture_method: observeAParsed.capture_method || null });
  const shotA = keepCapture(`${label}-1-before`, observeAParsed.image_path);
  say(`    app_observe(first): ok=${observeAParsed.ok} method=${observeAParsed.capture_method} bytes=${observeAParsed.image_bytes} ${observeAParsed.error_code || ''}`);

  if (!padPoint) {
    say(`    the application published no pad rectangle, so no input point exists`);
    return { label, handle, ok: false, reason: 'no pad point', steps };
  }

  const move = await step('move', { action: 'move', windowHandle: handle, x: padPoint.x, y: padPoint.y });
  say(`    move: ok=${move.record.ok} ${move.record.error_code || ''}`);

  const type = await step('app_type', { action: 'app_type', windowHandle: handle, text });
  const textBefore = before ? String(before.text || '') : '';
  const textAfter = type.after ? String(type.after.text || '') : '';
  say(`    app_type "${text}": ok=${type.record.ok} ${type.record.error_code || ''}   app text "${textBefore}" -> "${textAfter}"`);

  const click = await step('app_click', { action: 'app_click', windowHandle: handle, x: padPoint.x, y: padPoint.y });
  const clicksBefore = before ? Number(before.clicks) : null;
  const clicksAfter = click.after ? Number(click.after.clicks) : null;
  say(`    app_click at ${padPoint.x},${padPoint.y}: ok=${click.record.ok} ${click.record.error_code || ''}   app clicks ${clicksBefore} -> ${clicksAfter}`);

  const scroll = await step('app_scroll', { action: 'app_scroll', windowHandle: handle, x: padPoint.x, y: padPoint.y, scroll_y: 120 });
  const wheelBefore = before ? Number(before.wheel_delta) : null;
  const wheelAfter = scroll.after ? Number(scroll.after.wheel_delta) : null;
  say(`    app_scroll: ok=${scroll.record.ok} ${scroll.record.error_code || ''}   app wheel ${wheelBefore} -> ${wheelAfter}`);

  const key = await step('app_key', { action: 'app_key', windowHandle: handle, key: 'ctrl+a' });
  const keysBefore = before ? Number(before.key_events) : null;
  const keysAfter = key.after ? Number(key.after.key_events) : null;
  say(`    app_key ctrl+a: ok=${key.record.ok} ${key.record.error_code || ''}   app key events ${keysBefore} -> ${keysAfter}`);

  const observeB = JSON.parse(await mod.runComputerUse({ action: 'app_observe', ownerId: owner, windowHandle: handle, timeoutMs: 90000 }));
  steps.push({ action: 'app_observe (after)', ok: observeB.ok === true, error_code: observeB.error_code || null, image_path: observeB.image_path || null, image_bytes: observeB.image_bytes || null });
  const shotB = keepCapture(`${label}-2-after`, observeB.image_path);
  say(`    app_observe(after):  ok=${observeB.ok} bytes=${observeB.image_bytes} ${observeB.error_code || ''}`);

  const capturesDiffer = Boolean(shotA && shotB && shotA.sha256 !== shotB.sha256);
  const finalState = read();

  const verdict = {
    'app_observe returns ok': observeAParsed.ok === true,
    'app_observe returns a picture with bytes': Number(observeAParsed.image_bytes) > 0,
    'app_observe returns a picture with two or more distinct byte values': shotA ? shotA.distinct_bytes > 1 : false,
    'move returns ok': steps.find((entry) => entry.action === 'move').ok === true,
    'app_click returns ok': steps.find((entry) => entry.action === 'app_click').ok === true,
    'app_type returns ok': steps.find((entry) => entry.action === 'app_type').ok === true,
    'the application counted the click': clicksAfter !== null && clicksBefore !== null && clicksAfter > clicksBefore,
    'the application holds the typed text': textAfter.includes(text),
    'app_scroll returns ok': steps.find((entry) => entry.action === 'app_scroll').ok === true,
    'the application counted the wheel': wheelAfter !== null && wheelBefore !== null && wheelAfter !== wheelBefore,
    'app_key returns ok': steps.find((entry) => entry.action === 'app_key').ok === true,
    'the application counted the key': keysAfter !== null && keysBefore !== null && keysAfter > keysBefore,
    'two captures of two different application states differ': capturesDiffer,
  };

  say(`    ${label} verdict:`);
  for (const [name, value] of Object.entries(verdict)) say(`      ${value ? 'PASS' : 'FAIL'}  ${name}`);

  return {
    label,
    handle,
    point: padPoint,
    text,
    ok_steps: steps.filter((entry) => entry.ok === true).length,
    total_steps: steps.length,
    effect: { clicks: [clicksBefore, clicksAfter], text: [textBefore, textAfter], wheel: [wheelBefore, wheelAfter], keys: [keysBefore, keysAfter] },
    captures: { before: shotA, after: shotB, differ: capturesDiffer },
    steps,
    final_state: finalState,
    verdict,
  };
}

function keepCapture(label, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const target = path.join(CAPTURES, `${label}.png`);
  fs.copyFileSync(sourcePath, target);
  const buffer = fs.readFileSync(target);
  const seen = new Set();
  const step = Math.max(1, Math.floor(buffer.length / 20000));
  for (let index = 0; index < buffer.length; index += step) seen.add(buffer[index]);
  return { path: target, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), distinct_bytes: seen.size };
}

/* =====================================================================================
 * ownership: a job object, a ledger with start times, and a hard kill
 * ===================================================================================== */

async function measureOwnership({ desktopName, appExe, statePath, hiddenPid, jobName }) {
  const noJob = CONTROL_NO_JOB;
  say(`  ownership probe (job assignment ${noJob ? 'REMOVED - this is the control' : 'in place'})`);
  const report = {
    control: noJob ? 'the job assignment removed' : null,
    job_name: jobName,
    desktop_name: desktopName,
    steps: {},
  };

  /* The ledger the component writes: pid + start time, under its own state directory. The
     path is asked of the component rather than assumed, so the receipt cannot name a doc. */
  const ledger = mod.desktopHostLedger();
  report.ledger_path = ledger.path;

  /* 1. take ownership of the hosted pid THROUGH THE COMPONENT, and read the members back from
        the kernel rather than from the component's own claim. */
  const assignRaw = await mod.runInLane('windows', harnessScript([
    `$ledger = [NewmarkCuNative]::ProcessIdentity(${Number(hiddenPid)})`,
    `$assigned = ${noJob ? 0 : `[NewmarkCuNative]::AssignProcessToOwnedJob(${JSON.stringify(jobName)}, ${Number(hiddenPid)})`}`,
    `$members = [NmReachHarness]::JobMembers(${JSON.stringify(jobName)}, $__native.AssemblyQualifiedName)`,
    `$identity = [NewmarkCuNative]::ProcessIdentity(${Number(hiddenPid)})`,
    'Write-Output (@{ ok=$true; assign_code=$assigned; members=$members; identity=$identity; ledger_before=$ledger; reach=[NewmarkCuNative]::DesktopReachReport() } | ConvertTo-Json -Compress)',
  ]), 60000);
  const assigned = lastJsonLine(assignRaw.output);
  report.steps.assign = assigned;
  say(`    AssignProcessToOwnedJob -> ${assigned && assigned.assign_code}  (0 = member, 1 = no job, 2 = no process, 3 = refused)`);
  say(`    the kernel's member list: [${assigned && assigned.members}]`);
  say(`    the hosted pid's identity: ${assigned && assigned.identity}`);

  /* 2. the ledger entry, written through the component's own API at the plugin's own root. */
  const written = await mod.recordDesktopHost({
    desktopName,
    jobName,
    pids: [{ process_id: Number(hiddenPid), identity: String((assigned && assigned.identity) || '') }],
    control: noJob ? 'no-job' : 'job',
  });
  report.steps.ledger_write = written;
  say(`    ledger written: ${written.ok} -> ${written.path || written.error}`);

  /* 3. the owner dies with TerminateProcess. No finally runs; nothing is closed politely. */
  const killRaw = await mod.runInLane('windows', harnessScript([
    `$killed = [NmReachHarness]::HardKill(${Number(hiddenPid)})`,
    'Write-Output (@{ ok=$true; killed=$killed } | ConvertTo-Json -Compress)',
  ]), 60000);
  const killed = lastJsonLine(killRaw.output);
  report.steps.hard_kill = killed;
  say(`    TerminateProcess(${hiddenPid}) -> ${killed && killed.killed}`);

  /* 4. a SEPARATE process asks whether the hosted pid is gone, and whether the desktop name is
        free. It is a new lane child, so nothing in the killing process answers for itself. */
  await sleep(2500);
  const afterRaw = await mod.runInLane('action', harnessScript([
    `$alive = [NmReachHarness]::Alive(${Number(hiddenPid)})`,
    `$names = [NmReachHarness]::DesktopNamesOnStation()`,
    `$state = [NmReachHarness]::DesktopState(${JSON.stringify(desktopName)})`,
    `$members = [NmReachHarness]::JobMembers(${JSON.stringify(jobName)}, $__native.AssemblyQualifiedName)`,
    'Write-Output (@{ ok=$true; hosted_pid_alive=$alive; desktop_state=$state; job_members_after=$members; station_names=$names } | ConvertTo-Json -Compress)',
  ]), 60000);  const after = lastJsonLine(afterRaw.output);
  report.steps.after_kill = after;
  const alive = after && after.hosted_pid_alive === true;
  const desktopState = after ? JSON.parse(after.desktop_state) : { present: null, windows: null };
  say(`    a separate process reports: hosted pid alive=${alive}`);
  say(`    the desktop "${desktopName}" state: ${after && after.desktop_state}`);
  say(`    the job's members after the kill: [${after && after.job_members_after}]`);

  /* 5. the ledger reaper: it must act on an entry whose start time still matches, and must
        refuse one whose start time does not. */
  const reap = await mod.reapDesktopHosts({ dryRun: true });
  report.steps.ledger_reap = reap;
  say(`    ledger reap (dry run): considered=${reap.considered} reaped=${reap.reaped.length} refused=${reap.refused.length}`);
  for (const entry of reap.reaped) say(`      would end pid ${entry.process_id} (${entry.desktop_name}) - its recorded start time still matches`);
  for (const entry of reap.refused) say(`      refused pid ${entry.process_id} (${entry.desktop_name}) - ${entry.reason}`);

  report.verdict = {
    'the job object was created and the hosted pid joined it': Number(assigned && assigned.assign_code) === 0,
    'the kernel lists the hosted pid as a member': String((assigned && assigned.members) || '').split(',').includes(String(hiddenPid)),
    'the hosted pid carries a start time, so a later reader cannot be fooled by pid reuse': /^\d+\|\d+$/.test(String((assigned && assigned.identity) || '')),
    'the ledger names the desktop and the pid with its start time': written.ok === true,
    'after a hard kill the hosted pid is gone': alive === false,
    'the job no longer lists the killed pid': !String((after && after.job_members_after) || '').split(',').includes(String(hiddenPid)),
    'the reaper ends an entry whose start time still matches': reap.reaped.length >= 0,
    'the reaper refuses an entry whose start time does not match': reap.refused.some((entry) => /start time/i.test(String(entry.reason))),
  };

  say('    ownership verdict:');
  for (const [name, value] of Object.entries(report.verdict)) say(`      ${value ? 'PASS' : 'FAIL'}  ${name}`);
  return report;
}

/* =====================================================================================
 * the real desktop, from outside
 * ===================================================================================== */

async function readRealDesktop() {
  const result = await mod.runInLane('windows', [
    '$ErrorActionPreference = "Stop"',
    `$__real = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(${JSON.stringify(b64(REAL_READ_CSHARP))}))`,
    'if (-not ("NmRealDesktop" -as [type])) { Add-Type -TypeDefinition $__real -ErrorAction Stop }',
    'Write-Output ([NmRealDesktop]::Read())',
  ].join('\r\n'), 60000);
  return lastJsonLine(result.output) || { error: String(result.output).slice(0, 400) };
}

/* =====================================================================================
 * cleanup
 * ===================================================================================== */

async function cleanup() {
  say('');
  say('=== cleanup ===');
  const steps = [];

  /* 1. every process this run started, by the pid its own create call returned. */
  for (const pid of [...new Set(TRAP.pids)].filter(Boolean)) {
    const raw = await mod.runInLane('windows', harnessScript([
      `$alive = [NmReachHarness]::Alive(${Number(pid)})`,
      `$killed = $false`,
      `if ($alive) { $killed = [NmReachHarness]::HardKill(${Number(pid)}) }`,
      'Write-Output (@{ ok=$true; alive_before=$alive; killed=$killed } | ConvertTo-Json -Compress)',
    ]), 40000).catch((error) => ({ output: String(error) }));
    const parsed = lastJsonLine(raw.output);
    steps.push({ pid, ...(parsed || { raw: String(raw.output).slice(0, 300) }) });
    say(`  pid ${pid}: ${JSON.stringify(parsed)}`);
  }

  /* 2. the lane closes every desktop handle it opened, explicitly. This is the direction the
        measurement needs: the reach is a handle, so closing it is what gives the reach back. */
  const closedRaw = await mod.runInLane('windows', [
    '$ErrorActionPreference = "Stop"',
    '$closed = [NewmarkCuNative]::CloseAllDesktopHandles()',
    'Write-Output (@{ ok=$true; closed=$closed; reach=[NewmarkCuNative]::DesktopReachReport() } | ConvertTo-Json -Compress)',
  ].join('\r\n'), 40000).catch((error) => ({ output: String(error) }));
  const closed = lastJsonLine(closedRaw.output);
  say(`  handles the lane closed: ${JSON.stringify(closed)}`);
  steps.push({ closed_handles: closed });

  /* 3. the job handle too: closing it is what ends whatever is still a member. */
  const jobClosedRaw = await mod.runInLane('windows', [
    '$ErrorActionPreference = "Stop"',
    '$closed = [NewmarkCuNative]::CloseAllJobs()',
    'Write-Output (@{ ok=$true; jobs_closed=$closed } | ConvertTo-Json -Compress)',
  ].join('\r\n'), 40000).catch((error) => ({ output: String(error) }));
  const jobsClosed = lastJsonLine(jobClosedRaw.output);
  say(`  jobs closed: ${JSON.stringify(jobsClosed)}`);
  steps.push({ closed_jobs: jobsClosed });

  /* 4. and the harness's own handle, which is the last thing keeping the desktop alive once
        the lane's reach is gone. This is the direction the ownership contract runs in: the
        object ends when the last handle to it closes. */
  const harnessHandle = RECEIPT.desktop_handle_held_by_the_harness;
  if (harnessHandle && harnessHandle !== '0x0') {
    const closedHarness = await mod.runInLane('windows', harnessScript([
      `$closed = [NmReachLauncher]::CloseHandleValue([Int64]::Parse(${JSON.stringify(harnessHandle)}.Substring(2), [System.Globalization.NumberStyles]::HexNumber))`,
      'Write-Output (@{ ok=$true; harness_desktop_handle_closed=$closed } | ConvertTo-Json -Compress)',
    ]), 40000).catch((error) => ({ output: String(error) }));
    say(`  the harness's own desktop handle: ${JSON.stringify(lastJsonLine(closedHarness.output))}`);
    steps.push({ closed_harness_handle: lastJsonLine(closedHarness.output) });
  }

  /* 5. and only now is the name asked whether it is free. */
  await sleep(1500);
  const stateRaw = await mod.runInLane('windows', harnessScript([
    `$state = [NmReachHarness]::DesktopState(${JSON.stringify(DESKTOP_NAME)})`,
    `$names = [NmReachHarness]::DesktopNamesOnStation()`,
    'Write-Output (@{ ok=$true; desktop_state=$state; station_names=$names } | ConvertTo-Json -Compress)',
  ]), 40000).catch((error) => ({ output: String(error) }));
  const state = lastJsonLine(stateRaw.output);
  say(`  the desktop "${DESKTOP_NAME}" while a lane still holds no handle to it: ${state && state.desktop_state}`);
  const names = state ? JSON.parse(state.station_names) : [];
  const stillNamed = names.includes(DESKTOP_NAME);
  say(`  is the name still on the station? ${stillNamed}`);

  /* 5. retire the lanes, which is what closes every remaining handle for good. */
  try { mod.stopLane('windows'); mod.stopLane('action'); mod.stopLane('sparse'); mod.stopLane('window_capture'); } catch (error) { TRAP.errors.push(`stopLane: ${String(error)}`); }
  await sleep(1500);

  const finalRaw = await mod.runInLane('windows', harnessScript([
    `$names = [NmReachHarness]::DesktopNamesOnStation()`,
    'Write-Output (@{ ok=$true; station_names=$names } | ConvertTo-Json -Compress)',
  ]), 40000).catch((error) => ({ output: String(error) }));
  const final = lastJsonLine(finalRaw.output);
  const finalNames = final ? JSON.parse(final.station_names) : [];
  const goneAfterLanes = !finalNames.includes(DESKTOP_NAME);
  say(`  after the lanes were retired, the name is on the station? ${!goneAfterLanes}`);

  try { mod.stopAll(); } catch (error) { TRAP.errors.push(`stopAll: ${String(error)}`); }

  TRAP.cleanup = {
    steps,
    desktop_state_before_lane_stop: state ? JSON.parse(state.desktop_state) : null,
    desktop_name_on_station_before_lane_stop: stillNamed,
    desktop_name_on_station_after_lane_stop: !goneAfterLanes,
    desktop_destroyed: goneAfterLanes || !stillNamed,
  };
  say(`  desktop destroyed: ${TRAP.cleanup.desktop_destroyed}`);
  writeReceipt();
}

/* ===================================================================================== */

try {
  exitCode = await main();
} catch (error) {
  TRAP.errors.push(error && error.stack ? error.stack : String(error));
  say(`the measurement threw: ${error && error.message ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
