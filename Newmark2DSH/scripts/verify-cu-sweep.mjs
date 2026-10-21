#!/usr/bin/env node
/**
 * Executable gate for the sweep behaviour - relative mouse motion - and, first of all, for the
 * physics that makes it necessary.
 *
 * Run from the workspace root:
 *   node Newmark2DSH/scripts/verify-cu-sweep.mjs              all checks
 *   node Newmark2DSH/scripts/verify-cu-sweep.mjs --only 1     one check, for a quick answer
 *   node Newmark2DSH/scripts/verify-cu-sweep.mjs --mutations  the falsification harness
 *
 * =====================================================================================
 * WHAT THIS GATE MEASURES, AND WHY A PROBE RATHER THAN THE RECEIPT
 * =====================================================================================
 *
 * The contract is docs/14-cu-sweep.md: a consumer that steers from RELATIVE mouse input
 * sees nothing from SetCursorPos, which is the only thing the old absolute 'drag' walks the
 * pointer with, and everything from a relative mouse_event(MOUSEEVENTF_MOVE) injection.
 * That is a claim about the operating system, not about this plugin, so the gate does not
 * ask the plugin whether it is true.
 *
 * It compiles a WinForms probe (NmSweepProbe) that registers for raw mouse input with
 * RIDEV_INPUTSINK and counts, in its own window procedure:
 *
 *   packets           WM_INPUT messages whose dwType is RIM_TYPEMOUSE
 *   motion_packets    those of them that carry a non-zero delta
 *   sum_dx / sum_dy   lLastX / lLastY summed over every packet
 *   absolute_packets  packets flagged MOUSE_MOVE_ABSOLUTE (a relative claim that is not one)
 *   raw_left_down ... button transitions decoded from the RAWMOUSE button flags
 *   wm_left_down  ... button transitions seen as WM_LBUTTONDOWN and friends
 *
 * and publishes them to a state file on every packet, so the counters are the probe's own
 * accounting of what reached it. Check 1 runs that accounting against SetCursorPos and
 * against a relative injection with NO plugin call in the process at all: if the physics
 * does not hold on this machine, everything below it is measuring the wrong thing, and the
 * gate must say so rather than pass.
 *
 * =====================================================================================
 * THE CHECKS
 * =====================================================================================
 *
 *   1  the physics, standalone: SetCursorPos twice -> 0 new WM_INPUT packets; a relative
 *      mouse_event of (120,-60) -> packets whose summed deltas are exactly (120,-60).
 *   2  the DEFECT, measured red: a real-mode 'drag' moves the pointer and injects no raw
 *      MOTION. The counters that say so are motion_packets=0 and sums of (0,0); its total
 *      packet count is 2 because a button transition IS a raw packet and the drag presses
 *      and releases its button - both transitions are asserted, so the drag really ran.
 *   3  the FIX: 'sweep' produces the raw deltas its arithmetic promised, the button is
 *      pressed once and released once, and the receipt agrees with all of it.
 *   4  the arithmetic contract over several triples: receipt dx/dy are the closed-form
 *      values and the INJECTED steps sum to exactly those numbers (the probe is the sum).
 *   5  the cursor comes back - measured with GetCursorPos, and measured to NOT come back
 *      when restore_cursor is false, so restored is a property and not a constant.
 *   6  every refusal answers its named code and delivers nothing.
 *   7  the hidden desktop: 'sweep' is REFUSED there BY NAME (sweep_unsupported_on_hidden_desktop),
 *      and the refusal cites this gate's measurement: a probe registered for raw input on
 *      that desktop and alive across the gesture received 0 raw packets from a 300 px,
 *      16-step injection the agent reported as fully delivered, while this desktop stayed
 *      untouched. The zero is asserted, so a build that really routes pointer motion to a
 *      hidden desktop turns this red instead of shipping a gesture nothing lands.
 *   8  the planted mutation (--mutations only): with the injection replaced by SetCursorPos
 *      the gate must go RED on check 3. A byte-exact recovery copy is written BEFORE the
 *      plant, the file is restored in a finally and the restore is verified by sha256, an
 *      exit/signal guard restores it even if the process is interrupted, and the gate FAILS
 *      loudly (naming the recovery file) if the entry did not come back.
 *   9  the action is advertised: the model-facing schema and the description carry sweep,
 *      so an action that exists cannot be unreachable.
 *
 * The real-mode checks move the physical pointer and take the foreground for a few hundred
 * milliseconds, which is what this project's existing CU gates already do. Each gesture is
 * short, the button is always released, and the run ends by restoring the cursor and the
 * foreground it found.
 *
 * =====================================================================================
 * HONESTY RULES THIS FILE KEEPS
 * =====================================================================================
 *
 *   - Every check is measured. No assertion reads a plan to decide whether delivery
 *     happened; the probe's counters are the delivery.
 *   - A receipt is kept exactly as it came back, so a red check can name the answer that
 *     failed rather than a summary of it.
 *   - A physical mouse used during the run adds raw input to the probe. The gate waits for
 *     a quiet window before each measurement (settle) and its boundaries say what that
 *     does and does not cover.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runPowerShell,
  windowsPowerShellPath,
} from '../packages/newmark-core/components/computeruse/lib/hidden-agent.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const COMPONENT = path.join(REPO, 'packages', 'newmark-core', 'components', 'computeruse');
const COMPONENT_ENTRY = path.join(COMPONENT, 'lib', 'win32.js');
const CONTRACT = path.join(REPO, 'docs', '14-cu-sweep.md');
const IS_WINDOWS = process.platform === 'win32';

const ONLY = (() => {
  const at = process.argv.indexOf('--only');
  if (at < 0) return null;
  const wanted = new Set();
  for (const piece of String(process.argv[at + 1] || '').split(',')) {
    const value = Number(piece.trim());
    if (Number.isInteger(value) && value > 0) wanted.add(value);
  }
  return wanted.size ? wanted : null;
})();
const MUTATIONS = process.argv.includes('--mutations');
const OUT = (() => {
  const at = process.argv.indexOf('--out');
  if (at >= 0 && process.argv[at + 1]) return path.resolve(process.argv[at + 1]);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(REPO, 'evidence', 'cu-sweep', stamp);
})();
const PROBE_EXE = path.join(OUT, 'NmSweepProbe.exe');
const PROBE_SOURCE = path.join(OUT, 'NmSweepProbe.cs');

const OWNER = 'nm-sweep-gate-' + process.pid;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const say = (line = '') => process.stdout.write(String(line) + '\n');
const sha256Of = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const compact = (value) => JSON.stringify(value);

const TRACK = { checks: [], notes: [], facts: {}, receipts: {} };
function note(name, value) {
  TRACK.notes.push({ name, value });
  say('  (note) ' + name + ': ' + (typeof value === 'string' ? value.slice(0, 700) : compact(value)).slice(0, 900));
}
function fact(name, value) { TRACK.facts[name] = value; }
function keepReceipt(name, value) { TRACK.receipts[name] = value; }

/* ------------------------------------------------------------------ the reporting --- */

const outcomes = [];
let current = { index: 0, name: '' };

function line(status, index, name, detail) {
  const suffix = detail ? ' -- ' + detail : '';
  say(status.padEnd(5) + ' ' + String(index).padStart(2) + '. ' + name + suffix);
}

function wanted(index) { return !ONLY || ONLY.has(index); }

async function check(index, name, body) {
  if (!wanted(index)) return undefined;
  current = { index, name };
  try {
    const detail = await body();
    /*
     * A check may answer { skip, detail } when the machine, rather than the code, prevented
     * the measurement - docs/00-governance.md D-2 keeps SKIP separate from PASS for exactly
     * this, and a guard that cannot measure must not look like a gate that passed.
     */
    if (detail && typeof detail === 'object' && detail.skip === true) {
      outcomes.push({ index, name, status: 'SKIP', message: String(detail.detail || 'not measured') });
      line('SKIP', index, name, String(detail.detail || 'not measured'));
      return detail;
    }
    outcomes.push({ index, name, status: 'PASS' });
    line('PASS', index, name, detail === undefined ? '' : String(detail));
    return detail;
  } catch (error) {
    if (error && error.blocked === true) {
      /* The machine refused the measurement; the code was never asked a question. docs/00-
       * governance.md D-2: this is SKIP, and the refusal receipt is kept so a reader can see
       * which slot, which owner. */
      keepReceipt(name + '-blocked', error.receipt || null);
      outcomes.push({ index, name, status: 'SKIP', message: String(error.message) });
      line('SKIP', index, name, String(error.message));
      return undefined;
    }
    const message = error && error.message ? String(error.message) : String(error);
    outcomes.push({ index, name, status: 'FAIL', message });
    line('FAIL', index, name, message.split('\n').slice(0, 3).join(' | '));
    return undefined;
  }
}

/**
 * A check that did not run, named as one.
 *
 * docs/00-governance.md D-2 keeps SKIP separate from PASS: nothing was measured, so nothing
 * is claimed. The mutation harness is the only check that lands here in a normal run, and it
 * has its own flag.
 */
function skipCheck(index, name, reason) {
  if (!wanted(index)) return;
  outcomes.push({ index, name, status: 'SKIP' });
  line('SKIP', index, name, reason);
}

/* ------------------------------------------------------------- the probe application --- */

/**
 * The probe: a form that counts raw mouse input and nothing else.
 *
 * Deliberately mode-less: it has no idea what a sweep is. It answers how many WM_INPUT
 * packets it received, what their deltas summed to, and whether a button changed state,
 * which is exactly the question a game's input loop answers for itself.
 *
 * The state file is replaced atomically (write beside it, then File.Replace) because a
 * reader can arrive between two publishes and a torn read would look like a zero. The JSON
 * is assembled field by field with the quote character appended by its code, so this
 * payload carries no backslash and no C# string escape at all.
 */
const PROBE_CSHARP = [
  'using System;',
  'using System.IO;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'using System.Windows.Forms;',
  '',
  'public sealed class NmSweepProbeForm : Form',
  '{',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  struct RAWINPUTDEVICE { public ushort UsagePage; public ushort Usage; public uint Flags; public IntPtr Target; }',
  '',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  struct RAWINPUTHEADER { public uint Kind; public uint Size; public IntPtr Device; public IntPtr Parameter; }',
  '',
  '  [StructLayout(LayoutKind.Explicit, Size = 48)]',
  '  struct NmRawInput',
  '  {',
  '    [FieldOffset(0)] public uint Kind;',
  '    [FieldOffset(4)] public uint Size;',
  '    [FieldOffset(8)] public IntPtr Device;',
  '    [FieldOffset(16)] public IntPtr Parameter;',
  '    [FieldOffset(24)] public ushort MouseFlags;',
  '    [FieldOffset(28)] public uint Buttons;',
  '    [FieldOffset(28)] public ushort ButtonFlags;',
  '    [FieldOffset(30)] public ushort ButtonData;',
  '    [FieldOffset(32)] public uint RawButtons;',
  '    [FieldOffset(36)] public int LastX;',
  '    [FieldOffset(40)] public int LastY;',
  '    [FieldOffset(44)] public uint ExtraInformation;',
  '  }',
  '',
  '  [DllImport("user32.dll", SetLastError = true)]',
  '  static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);',
  '',
  '  [DllImport("user32.dll")]',
  '  static extern uint GetRawInputData(IntPtr rawHandle, uint command, IntPtr data, ref uint size, uint headerSize);',
  '',
  '  const uint RID_INPUT = 0x10000003;',
  '  const uint RIDEV_INPUTSINK = 0x00000100;',
  '  const uint MOUSE_MOVE_ABSOLUTE = 0x0001;',
  '',
  '  int packets;',
  '  int motionPackets;',
  '  int absolutePackets;',
  '  int sumX;',
  '  int sumY;',
  '  int rawLeftDown;',
  '  int rawLeftUp;',
  '  int rawRightDown;',
  '  int rawRightUp;',
  '  int wmLeftDown;',
  '  int wmLeftUp;',
  '  int wmRightDown;',
  '  int wmRightUp;',
  '  bool registered;',
  '  int registerError;',
  '  int publishes;',
  '  readonly string statePath;',
  '  readonly Timer timer;',
  '',
  '  public NmSweepProbeForm(string statePath, bool offscreen, int atX, int atY)',
  '  {',
  '    this.statePath = statePath;',
  '    this.Text = "NmSweepProbe";',
  '    this.ClientSize = new System.Drawing.Size(440, 240);',
  '    this.StartPosition = FormStartPosition.Manual;',
  '    if (offscreen) { this.ShowInTaskbar = false; }',
  '    this.Location = new System.Drawing.Point(atX, atY);',
  '    RAWINPUTDEVICE[] devices = new RAWINPUTDEVICE[1];',
  '    devices[0].UsagePage = 1;',
  '    devices[0].Usage = 2;',
  '    devices[0].Flags = RIDEV_INPUTSINK;',
  '    devices[0].Target = this.Handle;',
  '    this.registered = RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));',
  '    if (!this.registered) { this.registerError = Marshal.GetLastWin32Error(); }',
  '    this.timer = new Timer();',
  '    this.timer.Interval = 100;',
  '    this.timer.Tick += this.OnTick;',
  '    this.timer.Start();',
  '    this.Publish();',
  '  }',
  '',
  '  protected override void WndProc(ref Message m)',
  '  {',
  '    if (m.Msg == 0x00FF) { this.ReadRawInput(m.LParam); }',
  '    else if (m.Msg == 0x0201) { this.wmLeftDown = this.wmLeftDown + 1; this.Publish(); }',
  '    else if (m.Msg == 0x0202) { this.wmLeftUp = this.wmLeftUp + 1; this.Publish(); }',
  '    else if (m.Msg == 0x0204) { this.wmRightDown = this.wmRightDown + 1; this.Publish(); }',
  '    else if (m.Msg == 0x0205) { this.wmRightUp = this.wmRightUp + 1; this.Publish(); }',
  '    base.WndProc(ref m);',
  '  }',
  '',
  '  void ReadRawInput(IntPtr rawHandle)',
  '  {',
  '    uint size = 0;',
  '    uint headerSize = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));',
  '    GetRawInputData(rawHandle, RID_INPUT, IntPtr.Zero, ref size, headerSize);',
  '    if (size == 0) { return; }',
  '    IntPtr buffer = Marshal.AllocHGlobal((int)size);',
  '    try',
  '    {',
  '      uint read = GetRawInputData(rawHandle, RID_INPUT, buffer, ref size, headerSize);',
  '      if (read == uint.MaxValue) { return; }',
  '      NmRawInput raw = (NmRawInput)Marshal.PtrToStructure(buffer, typeof(NmRawInput));',
  '      if (raw.Kind != 0) { return; }',
  '      this.packets = this.packets + 1;',
  '      if ((raw.MouseFlags & MOUSE_MOVE_ABSOLUTE) != 0) { this.absolutePackets = this.absolutePackets + 1; }',
  '      if ((raw.LastX != 0) || (raw.LastY != 0)) { this.motionPackets = this.motionPackets + 1; }',
  '      this.sumX = this.sumX + raw.LastX;',
  '      this.sumY = this.sumY + raw.LastY;',
  '      ushort flags = raw.ButtonFlags;',
  '      if ((flags & 0x0001) != 0) { this.rawLeftDown = this.rawLeftDown + 1; }',
  '      if ((flags & 0x0002) != 0) { this.rawLeftUp = this.rawLeftUp + 1; }',
  '      if ((flags & 0x0004) != 0) { this.rawRightDown = this.rawRightDown + 1; }',
  '      if ((flags & 0x0008) != 0) { this.rawRightUp = this.rawRightUp + 1; }',
  '    }',
  '    finally { Marshal.FreeHGlobal(buffer); }',
  '    this.Publish();',
  '  }',
  '',
  '  void OnTick(object sender, EventArgs e) { this.Publish(); }',
  '',
  '  static void NumberField(StringBuilder builder, string name, long value)',
  '  {',
  '    if (builder.Length > 1) { builder.Append((char)44); }',
  '    builder.Append((char)34).Append(name).Append((char)34).Append((char)58).Append(value.ToString());',
  '  }',
  '',
  '  static void TextField(StringBuilder builder, string name, string value)',
  '  {',
  '    if (builder.Length > 1) { builder.Append((char)44); }',
  '    builder.Append((char)34).Append(name).Append((char)34).Append((char)58);',
  '    builder.Append((char)34).Append(value).Append((char)34);',
  '  }',
  '',
  '  void Publish()',
  '  {',
  '    this.publishes = this.publishes + 1;',
  '    string title = "NmSweepProbe packets=" + this.packets.ToString() + " motion=" + this.motionPackets.ToString()',
  '      + " dx=" + this.sumX.ToString() + " dy=" + this.sumY.ToString()',
  '      + " left=" + this.rawLeftDown.ToString() + "/" + this.rawLeftUp.ToString();',
  '    try { if (this.Text != title) { this.Text = title; } } catch { }',
  '    StringBuilder builder = new StringBuilder();',
  '    builder.Append((char)123);',
  '    NumberField(builder, "packets", this.packets);',
  '    NumberField(builder, "motion_packets", this.motionPackets);',
  '    NumberField(builder, "absolute_packets", this.absolutePackets);',
  '    NumberField(builder, "sum_dx", this.sumX);',
  '    NumberField(builder, "sum_dy", this.sumY);',
  '    NumberField(builder, "raw_left_down", this.rawLeftDown);',
  '    NumberField(builder, "raw_left_up", this.rawLeftUp);',
  '    NumberField(builder, "raw_right_down", this.rawRightDown);',
  '    NumberField(builder, "raw_right_up", this.rawRightUp);',
  '    NumberField(builder, "wm_left_down", this.wmLeftDown);',
  '    NumberField(builder, "wm_left_up", this.wmLeftUp);',
  '    NumberField(builder, "wm_right_down", this.wmRightDown);',
  '    NumberField(builder, "wm_right_up", this.wmRightUp);',
  '    NumberField(builder, "publishes", this.publishes);',
  '    NumberField(builder, "registered", this.registered ? 1 : 0);',
  '    NumberField(builder, "register_error", this.registerError);',
  '    NumberField(builder, "pid", System.Diagnostics.Process.GetCurrentProcess().Id);',
  '    TextField(builder, "handle", this.Handle.ToInt64().ToString("x"));',
  '    TextField(builder, "title", title);',
  '    builder.Append((char)125);',
  '    string temp = this.statePath + ".tmp";',
  '    try { File.WriteAllText(temp, builder.ToString()); } catch { return; }',
  '    try',
  '    {',
  '      if (File.Exists(this.statePath)) { File.Replace(temp, this.statePath, null); }',
  '      else { File.Move(temp, this.statePath); }',
  '    }',
  '    catch { try { File.Copy(temp, this.statePath, true); File.Delete(temp); } catch { } }',
  '  }',
  '}',
  '',
  'public static class NmSweepProbeEntry',
  '{',
  '  [STAThread]',
  '  public static void Main(string[] args)',
  '  {',
  '    string statePath = "nm-sweep-probe-state.json";',
  '    bool offscreen = false;',
  '    int atX = -4000;',
  '    int atY = -4000;',
  '    for (int i = 0; i < args.Length; i++)',
  '    {',
  '      if (args[i] == "--state" && i + 1 < args.Length) { statePath = args[i + 1]; i = i + 1; }',
  '      else if (args[i] == "--offscreen") { offscreen = true; }',
  '      else if (args[i] == "--at" && i + 2 < args.Length) { atX = int.Parse(args[i + 1]); atY = int.Parse(args[i + 2]); i = i + 2; }',
  '    }',
  '    Application.EnableVisualStyles();',
  '    Application.SetCompatibleTextRenderingDefault(false);',
  '    NmSweepProbeForm form = new NmSweepProbeForm(statePath, offscreen, atX, atY);',
  '    Application.Run(form);',
  '  }',
  '}',
  '',
].join('\r\n');

/* ------------------------------------------------------------- the measurement gauge --- */

/**
 * The independent gauge: this desktop pointer, its foreground, and one relative injection.
 *
 * It is separate from the plugin on purpose. Check 1 - the physics - uses this and only
 * this, and every the-pointer-was-or-was-not-restored assertion is read here rather than
 * from the receipt that makes the claim.
 */
const GAUGE_CSHARP = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class NmSweepGauge',
  '{',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct POINT { public int X; public int Y; }',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);',
  '  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);',
  '  public static void Dpi() { SetProcessDPIAware(); }',
  '  public static long CursorX() { POINT point; GetCursorPos(out point); return point.X; }',
  '  public static long CursorY() { POINT point; GetCursorPos(out point); return point.Y; }',
  '  public static bool Move(int x, int y) { return SetCursorPos(x, y); }',
  '  public static bool Raise(long handle) { return SetForegroundWindow(new IntPtr(handle)); }',
  '  public static long Foreground() { return GetForegroundWindow().ToInt64(); }',
  '  public static void Inject(int dx, int dy) { mouse_event(0x0001, dx, dy, 0, UIntPtr.Zero); }',
  '  public static long VirtualLeft() { return GetSystemMetrics(76); }',
  '  public static long VirtualTop() { return GetSystemMetrics(77); }',
  '  public static long VirtualWidth() { return GetSystemMetrics(78); }',
  '  public static long VirtualHeight() { return GetSystemMetrics(79); }',
  '}',
  '',
].join('\r\n');

function psSingle(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

function markerLine(output, marker) {
  const lines = String(output || '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index].trim();
    const at = text.indexOf(marker);
    if (at < 0) continue;
    try { return JSON.parse(text.slice(at + marker.length).trim()); } catch { return null; }
  }
  return null;
}

/**
 * One gauge call.
 *
 * The payload is compiled per call rather than kept in a DLL: a fresh process cannot keep a
 * loaded type, and the measured cost of compiling this 22-line class is a fraction of the
 * gesture it measures, whereas a stale DLL on disk would be a second thing to get wrong.
 */
async function gauge(bodyLines, timeoutMs) {
  const encoded = Buffer.from(GAUGE_CSHARP, 'utf8').toString('base64');
  const script = [
    '$ErrorActionPreference = "Stop"',
    "$source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
    encoded,
    "'@))",
    'if (-not ("NmSweepGauge" -as [type])) { Add-Type -TypeDefinition $source -ErrorAction Stop }',
    '[NmSweepGauge]::Dpi()',
    ...bodyLines,
  ].join('\r\n');
  const raw = await runPowerShell(script, {
    timeoutMs: timeoutMs || 90000,
    executable: process.env.NM_HIDDEN_PWSH || windowsPowerShellPath(),
  });
  const value = markerLine(raw.output, 'NMSWEEP ');
  if (!value) throw new Error('the gauge answered nothing readable: ' + String(raw.output || raw.error || '').slice(-400));
  return value;
}

async function gaugeState() {
  return await gauge([
    '$payload = @{ cursor_x = [long][NmSweepGauge]::CursorX(); cursor_y = [long][NmSweepGauge]::CursorY(); foreground = ("0x" + [NmSweepGauge]::Foreground().ToString("x")); virtual_left = [long][NmSweepGauge]::VirtualLeft(); virtual_top = [long][NmSweepGauge]::VirtualTop(); virtual_width = [long][NmSweepGauge]::VirtualWidth(); virtual_height = [long][NmSweepGauge]::VirtualHeight() } | ConvertTo-Json -Depth 6 -Compress',
    'Write-Output ("NMSWEEP " + $payload)',
  ]);
}

async function gaugeMove(x, y) {
  return await gauge([
    '$moved = [NmSweepGauge]::Move(' + String(Math.round(x)) + ', ' + String(Math.round(y)) + ')',
    '$payload = @{ moved = $moved; cursor_x = [long][NmSweepGauge]::CursorX(); cursor_y = [long][NmSweepGauge]::CursorY() } | ConvertTo-Json -Compress',
    'Write-Output ("NMSWEEP " + $payload)',
  ]);
}

async function gaugeRaise(handleHex) {
  return await gauge([
    '$ok = [NmSweepGauge]::Raise([Convert]::ToInt64(' + psSingle(String(handleHex)) + ', 16))',
    '$payload = @{ raised = $ok; foreground = ("0x" + [NmSweepGauge]::Foreground().ToString("x")) } | ConvertTo-Json -Compress',
    'Write-Output ("NMSWEEP " + $payload)',
  ]);
}

async function gaugeInject(dx, dy) {
  return await gauge([
    '[NmSweepGauge]::Inject(' + String(Math.round(dx)) + ', ' + String(Math.round(dy)) + ')',
    '$payload = @{ injected_x = ' + String(Math.round(dx)) + '; injected_y = ' + String(Math.round(dy)) + '; cursor_x = [long][NmSweepGauge]::CursorX(); cursor_y = [long][NmSweepGauge]::CursorY() } | ConvertTo-Json -Compress',
    'Write-Output ("NMSWEEP " + $payload)',
  ]);
}

/* ------------------------------------------------------------------- the probe itself --- */

async function compileProbe() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(PROBE_SOURCE, PROBE_CSHARP, 'utf8');
  try { fs.rmSync(PROBE_EXE, { force: true }); } catch { /* nothing to remove */ }
  const encoded = Buffer.from(PROBE_CSHARP, 'utf8').toString('base64');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$forms = [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms")',
    '$drawing = [System.Reflection.Assembly]::LoadWithPartialName("System.Drawing")',
    "$source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
    encoded,
    "'@))",
    'try { Add-Type -TypeDefinition $source -ReferencedAssemblies @($forms.Location, $drawing.Location) -OutputAssembly ' + psSingle(PROBE_EXE) + ' -OutputType WindowsApplication -ErrorAction Stop } catch { Write-Output ("NMPROBEERR " + [string]$_.Exception.Message); exit 1 }',
    'Write-Output "NMPROBEOK"',
  ].join('\r\n');
  const raw = await runPowerShell(script, {
    timeoutMs: 240000,
    executable: process.env.NM_HIDDEN_PWSH || windowsPowerShellPath(),
  });
  if (!String(raw.output).includes('NMPROBEOK')) {
    throw new Error('the raw-input probe did not compile: ' + String(raw.output || raw.error || '').slice(-800));
  }
  return { exe: PROBE_EXE, bytes: fs.statSync(PROBE_EXE).size, sha256: sha256Of(PROBE_EXE) };
}

function readProbeState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function waitForState(file, predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let last = null;
  while (Date.now() < deadline) {
    last = readProbeState(file);
    if (last && predicate(last)) return last;
    await sleep(120);
  }
  return last;
}

const probes = [];

async function startProbe(label, options) {
  const stateFile = path.join(OUT, 'probe-state-' + label + '.json');
  try { fs.rmSync(stateFile, { force: true }); } catch { /* nothing to remove */ }
  const args = ['--state', stateFile, '--at', String(options.at.x), String(options.at.y)];
  if (options.offscreen) args.push('--offscreen');
  const child = spawn(PROBE_EXE, args, { stdio: 'ignore', windowsHide: false });
  probes.push(child);
  const state = await waitForState(stateFile, (value) => Boolean(value && value.handle), 30000);
  if (!state || !state.handle) {
    throw new Error('the probe did not publish a window handle: ' + (state ? compact(state) : 'no state file'));
  }
  return { label, stateFile, handle: String(state.handle), pid: Number(state.pid) || child.pid, child, initial: state };
}

/* -------------------------------------------------------------- the probe counters --- */

const COUNTER_FIELDS = [
  'packets', 'motion_packets', 'absolute_packets', 'sum_dx', 'sum_dy',
  'raw_left_down', 'raw_left_up', 'raw_right_down', 'raw_right_up',
  'wm_left_down', 'wm_left_up', 'wm_right_down', 'wm_right_up',
];

function counters(state) {
  const out = {};
  for (const field of COUNTER_FIELDS) out[field] = Number(state && state[field]) || 0;
  return out;
}

function deltaCounters(before, after) {
  const left = counters(before);
  const right = counters(after);
  const out = {};
  for (const field of COUNTER_FIELDS) out[field] = right[field] - left[field];
  return out;
}

function sameCounters(a, b) {
  const left = counters(a);
  const right = counters(b);
  for (const field of COUNTER_FIELDS) if (left[field] !== right[field]) return false;
  return true;
}

/**
 * Wait for a window in which the probe received nothing.
 *
 * The probe registers RIDEV_INPUTSINK, so a physical mouse on this desk is also raw input it
 * counts. A measurement that began mid-gesture of a person would attribute their motion to
 * the plugin, so every measurement starts from a quiet window, and there is a named note when
 * none was found - the run continues, and the boundaries say what that means.
 */
async function settle(stateFile, quietMs) {
  const window = quietMs || 220;
  let previous = readProbeState(stateFile);
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await sleep(window);
    const next = readProbeState(stateFile);
    if (previous && next && sameCounters(previous, next)) return next;
    previous = next;
  }
  note('the probe never reported a quiet window', 'a physical mouse or other input is moving during this run; the deltas include it');
  return readProbeState(stateFile);
}

/* --------------------------------------------------------------- the component under test --- */

let tool = null;

/**
 * The real tool, built exactly as the component builds it.
 *
 * The root is redirected into this run's evidence directory: the component writes a failure
 * log, and no measurement may write under the user's real Newmark root.
 */
async function buildTool() {
  const url = new URL('file://' + path.join(COMPONENT, 'component.js').replace(/\\/g, '/'));
  const module = await import(url.href);
  const root = path.join(OUT, 'newmark-root');
  fs.mkdirSync(root, { recursive: true });
  const created = module.createComputerUse({ captionDir: path.join(OUT, 'captures'), root });
  const found = created.tools().find((entry) => entry.name === 'computer_use');
  if (!found) throw new Error('the component published no computer_use tool');
  return found;
}

let backendModule = null;

/**
 * The backend module this gate's tool actually loaded.
 *
 * stopAll() has to run on the SAME instance that took the lease, or it releases nothing; the
 * component loads the backend lazily, so this import resolves to the module cache entry the
 * tool is already using.
 */
async function loadBackendModule() {
  if (backendModule) return backendModule;
  const url = new URL('file://' + path.join(COMPONENT, 'lib', 'win32.js').replace(/\\/g, '/'));
  backendModule = await import(url.href);
  return backendModule;
}

function asReceipt(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return { unparsed: value }; }
  }
  return { value: value };
}

async function callComputerUse(name, args, keep) {
  const value = asReceipt(await tool.execute({ ...args, owner_id: OWNER }));
  if (keep) keepReceipt(name, value);
  return value;
}

/* ------------------------------------------------------------------ the arithmetic --- */

const DIRECTION_NAMES = {
  right: 0, 'down-right': 45, down: 90, 'down-left': 135,
  left: 180, 'up-left': 225, up: 270, 'up-right': 315,
  east: 0, southeast: 45, south: 90, southwest: 135,
  west: 180, northwest: 225, north: 270, northeast: 315,
};

/**
 * The closed form from the contract: dx = round(cos(theta) * speed * duration_ms / 1000).
 *
 * Recomputed here, independently of the plugin, so a receipt that reports a different number
 * disagrees with the contract rather than with itself.
 */
function expectedPlan(direction, speed, durationMs) {
  let degrees = direction;
  if (typeof direction === 'string') degrees = DIRECTION_NAMES[direction];
  const magnitude = speed * durationMs / 1000;
  const radians = degrees * Math.PI / 180;
  const steps = Math.min(240, Math.max(1, Math.round(durationMs / 16)));
  return {
    degrees: ((degrees % 360) + 360) % 360,
    magnitude,
    dx: Math.round(Math.cos(radians) * magnitude) || 0,
    dy: Math.round(Math.sin(radians) * magnitude) || 0,
    steps,
  };
}

/* ------------------------------------------------------------------ the desk facts --- */

const desk = { center: { x: 0, y: 0 }, cursor: { x: 0, y: 0 }, foreground: '0x0', recorded: false };
let interactive = null;
let hiddenOwner = '';

function pointerOf(state) { return { x: Number(state.cursor_x) || 0, y: Number(state.cursor_y) || 0 }; }

async function resetPointer() {
  await gaugeMove(desk.center.x, desk.center.y);
  await gaugeRaise(interactive.handle);
}

/**
 * Run one gesture and read the probe before and after it.
 *
 * The before snapshot is taken after the pointer is put where the gesture will start and
 * after the probe has been quiet for a window, so the delta that comes back belongs to the
 * gesture.
 */
function buttonTransitions(delta) {
  return delta.raw_left_down + delta.raw_left_up + delta.raw_right_down + delta.raw_right_up;
}

/**
 * Raw input this gesture cannot have produced.
 *
 * Deliberately narrow: only signatures that no sweep could generate are called pollution, so
 * that a defect in the gesture is never re-run until it looks clean. A relative injection
 * cannot set MOUSE_MOVE_ABSOLUTE, and a gesture never asks for the right button - MEASURED on
 * this station: a run overlapping another CU experiment produced exactly those two shapes.
 * A packet count larger than the steps, or an extra LEFT transition, is NOT classified here,
 * because those are the shapes a broken gesture would have too; they are left to fail.
 */
function pollutionOf(delta, args) {
  const reasons = [];
  if (delta.absolute_packets > 0) reasons.push('absolute_packets=' + String(delta.absolute_packets));
  if (delta.raw_right_down > 0 || delta.raw_right_up > 0) reasons.push('a right-button transition, which this gesture never asks for');
  if (args && args.button === 'none' && (delta.raw_left_down > 0 || delta.raw_left_up > 0)) {
    reasons.push('a left-button transition for a gesture that asks for no button');
  }
  return reasons;
}

const GESTURE_ATTEMPTS = 3;

async function measureGesture(label, args) {
  let last = null;
  for (let attempt = 1; attempt <= GESTURE_ATTEMPTS; attempt += 1) {
    await resetPointer();
    const before = await settle(interactive.stateFile);
    const pointerBefore = await gaugeState();
    const receipt = await callComputerUse(label, { mouse_mode: 'real', ...args }, label + '-attempt-' + String(attempt));
    const after = await settle(interactive.stateFile);
    const pointerAfter = await gaugeState();
    const delta = deltaCounters(before, after);
    const pollution = receipt.ok === true ? pollutionOf(delta, args) : [];
    last = { receipt, before, after, pointerBefore, pointerAfter, delta, attempt, pollution };
    if (receipt.ok !== true && String(receipt.error_code) === 'takeover_lease_occupied') {
      /*
       * Another process holds the REAL slot. A live holder is a session using this machine,
       * which is not a verdict about this code; a holder whose recorded owner is dead is a
       * stale lock, which is. The audit is re-read here because this can begin mid-run.
       */
      await auditTakeoverLocks();
      note('a gesture was refused because another process holds the real slot', {
        label, attempt, receipt, holders: slotHolders.real,
      });
      if (slotHolders.real.live.length > 0 && attempt >= GESTURE_ATTEMPTS) {
        throw new BlockedByLiveHolder(
          'NOT MEASURED: the real takeover slot is held by a live process (owner pid ' +
          String(slotHolders.real.live[0].owner_pid) + ', lock pid ' + String(slotHolders.real.live[0].lock_pid) +
          '), so the gesture was refused for occupancy before it could be delivered - this is somebody using ' +
          'this machine, not evidence about the code', receipt);
      }
      if (slotHolders.real.dead.length > 0 && attempt >= GESTURE_ATTEMPTS) return last;
      await sleep(1500);
      continue;
    }
    if (pollution.length === 0) return last;
    note('a gesture measurement was polluted and retried', { label, attempt, pollution, delta });
  }
  throw new Error('the desk was not quiet: ' + String(GESTURE_ATTEMPTS) + ' attempts of ' + label +
    ' were each polluted by raw input this gesture cannot produce (' + last.pollution.join('; ') +
    '), so no verdict about the plugin can be taken from them');
}

/* ------------------------------------------------------------------ the checks --- */

/**
 * Everything a check needs that another check may have established.
 *
 * The gate is runnable one check at a time (--only), and check 7 - the hidden-desktop
 * measurement - must be runnable on its own: it compiles the probe if it is not here yet and
 * records the desk facts the cleanup restores. Read paths only; nothing is measured twice.
 */
async function prepareEnvironment() {
  if (!fs.existsSync(PROBE_EXE)) {
    const compiled = await compileProbe();
    fact('probe', compiled);
  }
  const state = await gaugeState();
  desk.cursor = pointerOf(state);
  desk.foreground = String(state.foreground || '0x0');
  desk.recorded = true;
  desk.center = {
    x: Math.round(Number(state.virtual_left) + Number(state.virtual_width) / 2),
    y: Math.round(Number(state.virtual_top) + Number(state.virtual_height) / 2),
  };
  note('this desktop', {
    cursor: desk.cursor, foreground: desk.foreground, center: desk.center,
    screen: { width: state.virtual_width, height: state.virtual_height },
  });
  return state;
}

/**
 * The interactive-desktop probe, started if no earlier check started it.
 *
 * A one-check run (--only) and the mutation harness (which runs --only 3 twice) never reach
 * check 1, which is where the probe used to be created - so the gesture checks would measure
 * nothing, and the harness control run failed for a missing window instead of for the code
 * it planted. MEASURED, 2026-10-18: the first mutation run reported the restored control as
 * "Cannot read properties of null (reading handle)", which is this defect and not the plant.
 */
async function ensureInteractiveProbe() {
  if (interactive) return interactive;
  await prepareEnvironment();
  interactive = await startProbe('interactive', {
    offscreen: false,
    at: { x: desk.center.x - 220, y: desk.center.y - 120 },
  });
  await gaugeRaise(interactive.handle);
  const opened = await waitForState(interactive.stateFile, (value) => Boolean(value && value.handle), 15000);
  if (!opened || Number(opened.registered) !== 1) {
    throw new Error('the interactive probe did not register for raw input: ' + (opened ? compact(opened) : 'no state file'));
  }
  note('interactive probe started for a single-check run', { handle: interactive.handle, registered: Number(opened.registered) });
  return interactive;
}

async function runChecks() {
  await check(1, 'raw input: SetCursorPos injects none, a relative mouse_event does', async () => {
    const state = await gaugeState();
    desk.cursor = pointerOf(state);
    desk.foreground = String(state.foreground || '0x0');
    desk.recorded = true;
    desk.center = {
      x: Math.round(Number(state.virtual_left) + Number(state.virtual_width) / 2),
      y: Math.round(Number(state.virtual_top) + Number(state.virtual_height) / 2),
    };
    const compiled = await compileProbe();
    fact('probe', compiled);
    note('virtual screen', {
      left: state.virtual_left, top: state.virtual_top, width: state.virtual_width, height: state.virtual_height,
      center: desk.center, cursor: desk.cursor, foreground: desk.foreground,
    });

    interactive = await startProbe('interactive', {
      offscreen: false,
      at: { x: desk.center.x - 220, y: desk.center.y - 120 },
    });
    await gaugeRaise(interactive.handle);
    const opened = await waitForState(interactive.stateFile, (value) => Boolean(value && value.handle), 15000);
    assert.ok(opened && Number(opened.registered) === 1,
      'the probe must have registered for raw input; its own answer is registered=' +
      String(opened && opened.registered) + ' register_error=' + String(opened && opened.register_error));

    /*
     * A POLLUTED MEASUREMENT IS RETRIED, NOT REPORTED AS THE PLUGIN.
     *
     * This probe registers RIDEV_INPUTSINK, so it counts EVERY raw mouse event on this
     * desktop, including one injected by another process. MEASURED on this station: a run
     * that overlapped another ComputerUse experiment read 56 motion packets summing to
     * (407,-103) for a single injected (120,-60), and one measurement carried 2 packets
     * flagged MOUSE_MOVE_ABSOLUTE with an x sum of 128393 - an ABSOLUTE injection, which no
     * relative gesture can produce. Attributing that to the plugin would be a fabricated
     * failure, and attributing a clean run to a dirty desk would be a fabricated pass, so
     * the measurement is repeated from a quiet baseline and the pollution is named.
     */
    const setCursorProbe = async () => {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await gaugeMove(desk.center.x - 200, desk.center.y - 60);
        const before = await settle(interactive.stateFile);
        const moved = await gaugeMove(desk.center.x + 200, desk.center.y + 60);
        const after = await settle(interactive.stateFile);
        const delta = deltaCounters(before, after);
        if (delta.packets === 0) return { delta, moved, attempts: attempt, before: counters(before), after: counters(after) };
        note('a SetCursorPos measurement was polluted and retried', { attempt, delta });
      }
      throw new Error('the desk was not quiet: four SetCursorPos attempts each carried raw input, so this gate cannot measure what SetCursorPos does on this desktop');
    };
    const injectedProbe = async () => {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await gaugeMove(desk.center.x, desk.center.y);
        const before = await settle(interactive.stateFile);
        const injectedAt = await gaugeInject(120, -60);
        const after = await settle(interactive.stateFile);
        const delta = deltaCounters(before, after);
        /* One mouse_event call is one packet (measured both clean runs), and a relative
         * injection never carries MOUSE_MOVE_ABSOLUTE. Anything else on this desk is not
         * this measurement. */
        if (delta.absolute_packets === 0 && delta.motion_packets >= 1 && delta.motion_packets <= 2) {
          return { delta, injectedAt, attempts: attempt, before: counters(before), after: counters(after) };
        }
        note('a relative-injection measurement was polluted and retried', { attempt, delta });
      }
      throw new Error('the desk was not quiet: four injection attempts were each polluted, so this gate cannot measure what a relative mouse_event does on this desktop');
    };

    /* (a) SetCursorPos, twice: the pointer moves, the raw-input queue hears nothing. */
    const setHalf = await setCursorProbe();
    const setDelta = setHalf.delta;
    const movedOne = setHalf.moved;
    fact('set_cursor', { before: setHalf.before, after: setHalf.after, delta: setDelta, cursor: movedOne, attempts: setHalf.attempts });

    /* (b) one relative injection of the same order of magnitude. */
    const injectHalf = await injectedProbe();
    const injectDelta = injectHalf.delta;
    const injected = injectHalf.injectedAt;
    fact('relative_inject', { before: injectHalf.before, after: injectHalf.after, delta: injectDelta, cursor: injected, attempts: injectHalf.attempts });
    await gaugeMove(desk.cursor.x, desk.cursor.y);

    assert.ok(Math.abs(Number(movedOne.cursor_x) - (desk.center.x + 200)) <= 1,
      'the gauge must really have moved the pointer, or the SetCursorPos half measures nothing: cursor_x=' + String(movedOne.cursor_x));
    assert.strictEqual(setDelta.packets, 0,
      'SetCursorPos must produce NO WM_INPUT packets; measured ' + compact(setDelta));
    assert.strictEqual(setDelta.motion_packets, 0,
      'and no packet carrying a delta; measured ' + compact(setDelta));
    assert.ok(injectDelta.packets > 0,
      'a relative mouse_event must produce WM_INPUT packets; measured ' + compact(injectDelta));
    assert.strictEqual(injectDelta.absolute_packets, 0,
      'the injected motion must be reported as RELATIVE, not absolute; measured ' + compact(injectDelta));
    assert.strictEqual(injectDelta.sum_dx, 120,
      'the injected x delta must be reported as 120; measured ' + compact(injectDelta));
    assert.strictEqual(injectDelta.sum_dy, -60,
      'the injected y delta must be reported as -60; measured ' + compact(injectDelta));

    return 'SetCursorPos: packets=' + setDelta.packets + ' d=(' + setDelta.sum_dx + ',' + setDelta.sum_dy + ')' +
      ' || relative (120,-60): packets=' + injectDelta.packets + ' motion=' + injectDelta.motion_packets +
      ' absolute=' + injectDelta.absolute_packets + ' d=(' + injectDelta.sum_dx + ',' + injectDelta.sum_dy + ')';
  });

  await check(2, 'the defect: a real-mode drag moves the pointer and injects no raw motion', async () => {
    await ensureInteractiveProbe();
    const startX = desk.center.x - 100;
    const endX = desk.center.x + 100;
    /**
     * One drag, read on FOUR sides: the probe before, the pointer before, the pointer
     * IMMEDIATELY after the call, and the pointer again after the probe has settled.
     *
     * The immediate read is the one that matters. MEASURED 2026-10-18 in the umbrella run: the
     * drag answered ok:true with start_x 1180 and end_x 1380 and a lane that really ran its
     * two 50 ms paths (lane_elapsed_ms 232), while the pointer read 1280 before AND after -
     * and 1280 is this gate's own reset point, not the drag's start or end. The same check
     * passed standalone on the same bytes twice that day, which is what a poisoned ambient
     * read looks like: the umbrella runs 200+ pointer-moving checks, and this gate's readings
     * are the only place that pollution surfaces.
     */
    const cycle = async (label, extra) => {
      await resetPointer();
      const probeBefore = await settle(interactive.stateFile);
      const pointerBefore = await gaugeState();
      const receipt = await callComputerUse(label, {
        mouse_mode: 'real',
        action: 'drag',
        start_x: startX,
        start_y: desk.center.y,
        end_x: endX,
        end_y: desk.center.y,
        button: 'left',
        ...extra,
      }, label);
      const pointerImmediate = await gaugeState();
      const probeAfter = await settle(interactive.stateFile);
      const pointerAfter = await gaugeState();
      return {
        receipt,
        delta: deltaCounters(probeBefore, probeAfter),
        before: pointerOf(pointerBefore),
        immediate: pointerOf(pointerImmediate),
        after: pointerOf(pointerAfter),
      };
    };

    const documented = await cycle('drag-defect');
    fact('drag_defect', documented);

    /*
     * THE DOCUMENTED SHAPE, AND WHAT IT REALLY ANSWERS.
     *
     * docs/14-cu-sweep.md section 1 describes drag as walking the pointer from start_x/start_y
     * to end_x/end_y, which is the call above. It USED to be refused with 'point_required',
     * because desktopPhysicalAction guarded x/y above the drag branch; that was fixed and this
     * branch now records the history rather than a live defect, so the success message below
     * does not claim a refusal that no longer happens.
     */
    let delivery = documented;
    let attempts = 1;
    const documentedShapeRefused = documented.receipt.ok !== true;
    if (documentedShapeRefused) {
      note('the documented drag argument shape is refused', {
        call: 'action:drag, start_x/start_y/end_x/end_y, button:left',
        answer: { ok: documented.receipt.ok, error_code: documented.receipt.error_code, error: documented.receipt.error },
        then_measured_with: 'the same drag plus x/y, which is what the guard above the drag branch used to require',
      });
      delivery = await cycle('drag-defect-with-xy', { x: startX, y: desk.center.y });
      fact('drag_defect_with_xy', delivery);
    }

    /*
     * THE OBSERVATION, RETRIED WHEN IT DISAGREES WITH THE RECEIPT IT IS CHECKING.
     *
     * The two instruments are different in kind: receipt.start_x/end_x is what the drag was
     * asked to do and its own report of having done it, and GetCursorPos either side of the
     * call is an outside reading of the same pointer every other gate in the chain also moves.
     * When they disagree the outside reading is repeated from a fresh quiet baseline, at most
     * three times, and every retry is named here and in the report. A drag that deterministically
     * fails to move the pointer is retried three times and then FAILS - a retry is a guard
     * against a transient poisoned reading, never a way to turn a real non-movement into a pass.
     */
    const claim = Number(delivery.receipt.ok === true ? delivery.receipt.end_x : endX) - Number(delivery.receipt.ok === true ? delivery.receipt.start_x : startX);
    const observedOf = (value) => value.immediate.x - value.before.x;
    /*
     * The landing tolerance: a real-mode drag ends with SetCursorPos(end_x, end_y) as the last
     * write of its own script (MoveCursorSmooth's final set), so the pointer must be AT the end
     * point afterwards. Four pixels is one wheel notch of jitter from a physical mouse being
     * used during the run; anything larger is a pointer that did not get there.
     */
    const landed = (value) => Math.abs(value.immediate.x - endX) <= 4 && Math.abs(value.immediate.y - desk.center.y) <= 4;
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      if (delivery.receipt.ok !== true) break;
      if (landed(delivery)) break;
      note('the pointer observation disagreed with the drag receipt and is retried from a quiet baseline', {
        attempt: attempt - 1,
        claimed_dx: claim,
        observed_dx: observedOf(delivery),
        pointer_before: delivery.before,
        pointer_immediately_after: delivery.immediate,
        pointer_after_settle: delivery.after,
      });
      delivery = await cycle('drag-defect-retry-' + String(attempt), documentedShapeRefused ? { x: startX, y: desk.center.y } : {});
      attempts = attempt;
    }
    fact('drag_delivery', { ...delivery, attempts, claimed_dx: claim });

    assert.strictEqual(delivery.receipt.ok, true,
      'a real-mode drag must succeed against an idle desktop' +
      (documentedShapeRefused ? ' (measured with x/y supplied, because the documented shape was refused above)' : '') +
      ': ' + compact(delivery.receipt));
    assert.strictEqual(delivery.receipt.delivery, 'physical-desktop', 'the drag must report physical delivery: ' + compact(delivery.receipt));
    /* The receipt is the authoritative claim about what the drag did. */
    assert.strictEqual(Number(delivery.receipt.start_x), startX,
      'the receipt must report the start it was given (' + String(startX) + '): ' + compact(delivery.receipt));
    assert.strictEqual(Number(delivery.receipt.end_x), endX,
      'and the end it was given (' + String(endX) + '): ' + compact(delivery.receipt));
    assert.ok(Number.isFinite(claim) && Math.abs(claim) > 0,
      'the drag rectangle must be nonzero: ' + compact(delivery.receipt));
    /* And this is the outside observation of the same gesture, taken either side of the call. */
    const observed = observedOf(delivery);
    assert.ok(landed(delivery),
      'GetCursorPos, read immediately after the call, must show the pointer AT the end of the drag rectangle (' +
      String(endX) + ',' + String(desk.center.y) + '), because the drag own last write is SetCursorPos(end_x, end_y); measured (' +
      String(delivery.immediate.x) + ',' + String(delivery.immediate.y) + ') after starting from (' +
      String(delivery.before.x) + ',' + String(delivery.before.y) + '), ' + String(attempts) + ' attempt(s), settled at (' +
      String(delivery.after.x) + ',' + String(delivery.after.y) + '): ' + compact(delivery.receipt));
    assert.ok(Math.abs(observed) >= 50,
      'the pointer must also have TRAVELLED to get there, or the landing says nothing: from ' +
      String(delivery.before.x) + ' to ' + String(delivery.immediate.x) + ' (' + String(observed) + ' px): ' + compact(delivery.receipt));
    /*
     * The drag presses and releases a button, and a button transition IS raw input - MEASURED
     * here as packets=2, motion_packets=0, sums of (0,0). So the assertion is about MOTION: no
     * packet may carry a delta. Asserting on the total packet count would fail on the button
     * this drag legitimately presses, and a gate that fails for a correct reason is as useless
     * as one that passes for the wrong one. The button transitions are asserted instead, which
     * is what proves the drag really ran its own path rather than refusing early.
     */
    assert.strictEqual(delivery.delta.motion_packets, 0,
      'the drag walks the pointer with SetCursorPos and must deliver no raw MOTION packet; measured ' + compact(delivery.delta));
    assert.strictEqual(delivery.delta.sum_dx + delivery.delta.sum_dy, 0,
      'and the summed deltas must be zero; measured ' + compact(delivery.delta));
    assert.strictEqual(delivery.delta.raw_left_down, 1,
      'the drag must have pressed the button once, or it never reached its drag script: ' + compact(delivery.delta));
    assert.strictEqual(delivery.delta.raw_left_up, 1,
      'and released it once: ' + compact(delivery.delta));
    await gaugeMove(desk.center.x, desk.center.y);

    if (documentedShapeRefused) {
      assert.fail('the documented drag argument shape (start_x/start_y/end_x/end_y, no x/y) must reach the drag, but it was refused ' +
        String(documented.receipt.error_code) + ': ' + String(documented.receipt.error) +
        ' - while the delivery property behind it measured ' + compact(delivery.delta));
    }
    return 'receipt claims dx=' + String(claim) + ' (' + String(delivery.receipt.start_x) + ' -> ' + String(delivery.receipt.end_x) + ')' +
      '; pointer measured ' + String(delivery.before.x) + ' -> ' + String(delivery.immediate.x) +
      ' (' + String(observed) + ' px, after settle ' + String(delivery.after.x) + ', ' + String(attempts) + ' attempt(s))' +
      '; raw motion packets=' + String(delivery.delta.motion_packets) +
      ' (of ' + String(delivery.delta.packets) + ' packets, the other two being the button it pressed and released)' +
      ' d=(' + String(delivery.delta.sum_dx) + ',' + String(delivery.delta.sum_dy) + ')';
  });


  await check(3, 'the fix: a real-mode sweep injects the relative motion it promised', async () => {
    await ensureInteractiveProbe();
    const first = await measureGesture('sweep-left-held', {
      action: 'sweep', direction: 0, speed: 1200, duration_ms: 250, button: 'left',
    });
    const receiptA = first.receipt;
    const planA = expectedPlan(0, 1200, 250);
    fact('sweep_left_held', first);

    assert.strictEqual(receiptA.ok, true, 'the sweep must succeed: ' + compact(receiptA));
    assert.strictEqual(receiptA.action, 'sweep', 'the receipt must name the action: ' + compact(receiptA));
    assert.strictEqual(receiptA.mouse_mode, 'real', 'the receipt must report the real mode: ' + compact(receiptA));
    assert.strictEqual(receiptA.delivery, 'physical-desktop', 'the delivery must be this desktop: ' + compact(receiptA));
    assert.strictEqual(receiptA.mouse_motion, 'relative-injection', 'the motion must be relative injection: ' + compact(receiptA));
    /* The contract (docs/14-cu-sweep.md section 5) called this field raw_input_delivery; the
     * code writes raw_motion_delivery. The code wins (docs/00-governance.md A2), the conflict
     * is recorded in this run's report, and the assertion reads what a caller really gets. */
    assert.strictEqual(receiptA.raw_motion_delivery, 'relative-mouse-event', 'the receipt must name the mechanism: ' + compact(receiptA));
    assert.strictEqual(receiptA.dx, planA.dx, 'receipt dx must be round(cos * speed * duration / 1000) = ' + String(planA.dx) + ': ' + compact(receiptA));
    assert.strictEqual(receiptA.dy, planA.dy, 'receipt dy must be 0 for direction 0: ' + compact(receiptA));
    assert.strictEqual(receiptA.steps, planA.steps, 'the default steps must be clamp(round(250/16),1,240) = ' + String(planA.steps) + ': ' + compact(receiptA));
    assert.strictEqual(receiptA.injected_steps, receiptA.steps, 'every step must be injected: ' + compact(receiptA));
    assert.strictEqual(receiptA.button, 'left', 'the receipt must report the held button: ' + compact(receiptA));
    assert.ok(Number(receiptA.button_held_ms) > 0, 'a held button must report a measured hold: ' + compact(receiptA));
    assert.ok(Number(receiptA.elapsed_ms) >= 0.6 * 250,
      'the motion must be spread over the duration it was asked for; duration_ms=250 elapsed_ms=' + String(receiptA.elapsed_ms));
    assert.ok(Number(receiptA.elapsed_ms) <= 250 + 2500,
      'and must not take an unbounded time; elapsed_ms=' + String(receiptA.elapsed_ms));
    assert.strictEqual(first.delta.sum_dx, planA.dx,
      'the probe must receive exactly ' + String(planA.dx) + ' px of x raw motion; measured ' + compact(first.delta));
    assert.strictEqual(first.delta.sum_dy, planA.dy,
      'and ' + String(planA.dy) + ' px of y; measured ' + compact(first.delta));
    assert.ok(first.delta.motion_packets > 0,
      'the motion must arrive as raw packets; measured ' + compact(first.delta));
    assert.strictEqual(first.delta.raw_left_down, 1,
      'the held button must be pressed exactly once; measured ' + compact(first.delta));
    assert.strictEqual(first.delta.raw_left_up, 1,
      'and released exactly once - that is 2 transitions in total; measured ' + compact(first.delta));

    const second = await measureGesture('sweep-down-nobutton', {
      action: 'sweep', direction: 'down', speed: 800, duration_ms: 200, button: 'none',
    });
    const receiptB = second.receipt;
    const planB = expectedPlan('down', 800, 200);
    fact('sweep_down_nobutton', second);

    assert.strictEqual(receiptB.ok, true, 'the unheld sweep must succeed: ' + compact(receiptB));
    assert.strictEqual(receiptB.dx, planB.dx, 'receipt dx must be 0 for direction down: ' + compact(receiptB));
    assert.strictEqual(receiptB.dy, planB.dy, 'receipt dy must be round(sin(90) * 800 * 200 / 1000) = ' + String(planB.dy) + ': ' + compact(receiptB));
    assert.strictEqual(receiptB.button, 'none', 'the receipt must report no held button: ' + compact(receiptB));
    assert.ok(!Number(receiptB.button_held_ms), 'no button means no hold to report: ' + compact(receiptB));
    assert.strictEqual(second.delta.sum_dx, planB.dx, 'the probe must receive x=0 raw motion; measured ' + compact(second.delta));
    assert.strictEqual(second.delta.sum_dy, planB.dy, 'and y=' + String(planB.dy) + '; measured ' + compact(second.delta));
    assert.strictEqual(second.delta.raw_left_down + second.delta.raw_left_up + second.delta.raw_right_down + second.delta.raw_right_up, 0,
      'a sweep with button none must inject no button transition at all; measured ' + compact(second.delta));

    return 'held: raw (' + String(first.delta.sum_dx) + ',' + String(first.delta.sum_dy) + ') packets=' + String(first.delta.packets) +
      ' transitions=' + String(first.delta.raw_left_down) + '+' + String(first.delta.raw_left_up) +
      ' receipt dx=' + String(receiptA.dx) + ' dy=' + String(receiptA.dy) + ' steps=' + String(receiptA.steps) +
      ' elapsed=' + String(receiptA.elapsed_ms) + 'ms || none: raw (' + String(second.delta.sum_dx) + ',' + String(second.delta.sum_dy) + ') transitions=0';
  });

  await check(4, 'the arithmetic contract: dx/dy are the closed form and the injected steps sum to them', async () => {
    await ensureInteractiveProbe();
    const triples = [
      { direction: 'down-right', speed: 1000, duration_ms: 300 },
      { direction: 30, speed: 500, duration_ms: 200 },
      { direction: 270, speed: 2000, duration_ms: 150 },
      { direction: 135, speed: 600, duration_ms: 250 },
    ];
    const seen = [];
    for (let index = 0; index < triples.length; index += 1) {
      const asked = triples[index];
      const plan = expectedPlan(asked.direction, asked.speed, asked.duration_ms);
      const measured = await measureGesture('sweep-arithmetic-' + String(index + 1), {
        action: 'sweep', direction: asked.direction, speed: asked.speed, duration_ms: asked.duration_ms,
      });
      const receipt = measured.receipt;
      fact('sweep_arithmetic_' + String(index + 1), { asked, plan, measured });
      const label = compact(asked);

      assert.strictEqual(receipt.ok, true, 'the sweep must succeed for ' + label + ': ' + compact(receipt));
      assert.strictEqual(receipt.dx, plan.dx, 'receipt dx must equal ' + String(plan.dx) + ' for ' + label + ': ' + compact(receipt));
      assert.strictEqual(receipt.dy, plan.dy, 'receipt dy must equal ' + String(plan.dy) + ' for ' + label + ': ' + compact(receipt));
      assert.strictEqual(receipt.steps, plan.steps, 'steps must be clamp(round(duration/16),1,240) = ' + String(plan.steps) + ' for ' + label + ': ' + compact(receipt));
      assert.strictEqual(receipt.injected_steps, receipt.steps, 'every step must be injected for ' + label + ': ' + compact(receipt));
      assert.strictEqual(receipt.direction_deg, plan.degrees,
        'the receipt must report the normalised direction ' + String(plan.degrees) + ' for ' + label + ': ' + compact(receipt));
      assert.strictEqual(measured.delta.sum_dx, plan.dx,
        'the INJECTED steps must sum to exactly dx=' + String(plan.dx) + ' for ' + label + ' (the last step carries the remainder); measured ' + compact(measured.delta));
      assert.strictEqual(measured.delta.sum_dy, plan.dy,
        'and to exactly dy=' + String(plan.dy) + ' for ' + label + '; measured ' + compact(measured.delta));
      seen.push(label + ' -> (' + String(receipt.dx) + ',' + String(receipt.dy) + ') steps=' + String(receipt.steps) +
        ' raw=(' + String(measured.delta.sum_dx) + ',' + String(measured.delta.sum_dy) + ')');
    }
    return seen.join(' | ');
  });

  await check(5, 'the cursor comes back, and only when it was asked to', async () => {
    await ensureInteractiveProbe();
    const restored = await measureGesture('sweep-restore-default', {
      action: 'sweep', direction: 'right', speed: 1000, duration_ms: 300,
    });
    fact('sweep_restore_default', restored);
    const beforePoint = pointerOf(restored.pointerBefore);
    const afterPoint = pointerOf(restored.pointerAfter);
    assert.strictEqual(restored.receipt.ok, true, 'the sweep must succeed: ' + compact(restored.receipt));
    assert.strictEqual(restored.receipt.cursor_restored, true,
      'the receipt must report the cursor as restored: ' + compact(restored.receipt));
    const driftX = Math.abs(afterPoint.x - beforePoint.x);
    const driftY = Math.abs(afterPoint.y - beforePoint.y);
    assert.ok(driftX <= 1 && driftY <= 1,
      'GetCursorPos must agree that the pointer came back: before (' + String(beforePoint.x) + ',' + String(beforePoint.y) +
      ') after (' + String(afterPoint.x) + ',' + String(afterPoint.y) + '), drift (' + String(driftX) + ',' + String(driftY) + ')');
    /*
     * The cursor DISPLACEMENT is not the injected delta on a machine with pointer
     * acceleration: MEASURED on this station in the same session, a sweep of dx=300 displaces
     * the cursor by 923 px while the raw delta stays 300, because the OS applies the
     * acceleration curve between the raw packet and the pointer. So a lower bound is
     * asserted - acceleration amplifies, it never shrinks - and the number is reported as it
     * was measured rather than compared to a value the contract never promised.
     */
    const movement = Number(restored.receipt.cursor_displacement && restored.receipt.cursor_displacement.x);
    /* NOT an exactness assertion: this station has pointer acceleration (MouseSpeed=1) and the
     * measured gain on a 300 px injection was 2.68 here and 3.08 in the Lead's own run, so the
     * cursor travels further than the injected delta. Exactness belongs to the raw sum (checks
     * 3 and 4); here the claim is only that the pointer really left, so that "restored" is not
     * a statement about a pointer that never moved. */
    assert.ok(movement > 0,
      'the receipt must report a nonzero cursor displacement, or restored describes a pointer that never moved: cursor_displacement.x=' + String(movement));
    note('cursor displacement vs injected delta', {
      injected_dx: 300,
      cursor_displacement_x: movement,
      why: 'pointer acceleration: the raw delta is 300 and the cursor travels further; the probe raw sum is the instrument for the injected delta, not the cursor',
    });

    const unrestored = await measureGesture('sweep-restore-off', {
      action: 'sweep', direction: 'right', speed: 1000, duration_ms: 300, restore_cursor: false,
    });
    fact('sweep_restore_off', unrestored);
    assert.strictEqual(unrestored.receipt.ok, true, 'the sweep with restore_cursor false must succeed: ' + compact(unrestored.receipt));
    const left = pointerOf(unrestored.pointerAfter);
    const started = pointerOf(unrestored.pointerBefore);
    const leftBy = left.x - started.x;
    assert.ok(leftBy >= 250,
      'with restore_cursor false the pointer must be LEFT where the gesture put it, so restored is a property and not a constant; before x=' +
      String(started.x) + ' after x=' + String(left.x));
    await gaugeMove(desk.center.x, desk.center.y);

    return 'default: drift=(' + String(driftX) + ',' + String(driftY) + ') displacement.x=' + String(movement) +
      ' || restore_cursor=false: left at dx=' + String(leftBy) + ' (not restored)';
  });

  await check(6, 'every refusal answers its named code and delivers nothing', async () => {
    await ensureInteractiveProbe();
    /* The six real-mode refusals come first, so a machine whose virtual slot is busy still
     * measures them; the virtual case is last and is the only one that can be unmeasurable. */
    const cases = [
      { label: 'speed 0', expect: 'sweep_speed_out_of_range', args: { action: 'sweep', direction: 0, speed: 0, duration_ms: 100 } },
      { label: 'speed 9000', expect: 'sweep_speed_out_of_range', args: { action: 'sweep', direction: 0, speed: 9000, duration_ms: 100 } },
      { label: 'duration 0', expect: 'sweep_duration_out_of_range', args: { action: 'sweep', direction: 0, speed: 1000, duration_ms: 0 } },
      { label: 'duration 16000', expect: 'sweep_duration_out_of_range', args: { action: 'sweep', direction: 0, speed: 1000, duration_ms: 16000 } },
      { label: 'direction sideways', expect: 'sweep_direction_unsupported', args: { action: 'sweep', direction: 'sideways', speed: 1000, duration_ms: 100 } },
      { label: 'button middle', expect: 'sweep_button_unsupported', args: { action: 'sweep', direction: 0, speed: 1000, duration_ms: 100, button: 'middle' } },
      { label: 'virtual without a hidden desktop', expect: 'sweep_requires_physical_delivery', slot: 'virtual', args: { action: 'sweep', mouse_mode: 'virtual', direction: 0, speed: 1000, duration_ms: 100 } },
    ];
    const seen = [];
    const unmeasured = [];
    for (let index = 0; index < cases.length; index += 1) {
      const one = cases[index];
      if (one.slot === 'virtual' && virtualSlotHeldByLiveProcess) {
        /* The virtual slot is held by a live process: the refusal this case asks for cannot be
         * reached, because the lease is refused first. Not measured, so not claimed. */
        unmeasured.push(one);
        note('a refusal case was NOT MEASURED because another session holds the virtual slot', one.label);
        continue;
      }
      await resetPointer();
      const before = await settle(interactive.stateFile);
      const receipt = await callComputerUse('refusal-' + String(index + 1), { mouse_mode: 'real', ...one.args }, 'refusal-' + String(index + 1));
      const after = await settle(interactive.stateFile);
      const delta = deltaCounters(before, after);
      fact('refusal_' + String(index + 1), { label: one.label, expect: one.expect, receipt, delta });
      assert.strictEqual(receipt.ok, false, 'the ' + one.label + ' case must be refused: ' + compact(receipt));
      assert.strictEqual(String(receipt.error_code), one.expect,
        'the ' + one.label + ' case must answer ' + one.expect + ': ' + compact(receipt));
      assert.strictEqual(delta.packets, 0,
        'a refusal must deliver nothing; the ' + one.label + ' case produced packets=' + String(delta.packets) + ': ' + compact(delta));
      assert.strictEqual(delta.sum_dx + delta.sum_dy, 0,
        'and no pointer delta; the ' + one.label + ' case produced ' + compact(delta));
      assert.strictEqual(delta.raw_left_down + delta.raw_left_up + delta.raw_right_down + delta.raw_right_up + delta.wm_left_down + delta.wm_left_up, 0,
        'and no button transition; the ' + one.label + ' case produced ' + compact(delta));
      seen.push(one.label + ' -> ' + one.expect);
    }
    if (unmeasured.length) {
      return {
        skip: true,
        detail: 'measured ' + String(seen.length) + ' of ' + String(cases.length) + ' refusals, each as its named code (' +
          seen.join(' | ') + '); NOT MEASURED: ' + unmeasured.map((one) => one.label + ' -> ' + one.expect).join(', ') +
          ' - the virtual takeover slot is held by a live process, so the request is refused for occupancy before the case is reached',
      };
    }
    return seen.join(' | ');
  });

  await check(7, 'the hidden desktop: sweep is refused there by name, and the refusal cites this measurement', async () => {
    await prepareEnvironment();
    if (virtualSlotHeldByLiveProcess) {
      return {
        skip: true,
        detail: 'NOT MEASURED: the virtual takeover slot is held by a live process (see the audit note at the top of this run), ' +
          'so a hidden desktop cannot be armed and this check claims nothing. It is not a failure: killing that holder would ' +
          'take a running session down with it, and the slot being refused is the plugin behaving correctly',
      };
    }
    const stateFile = path.join(OUT, 'probe-state-hidden.json');
    try { fs.rmSync(stateFile, { force: true }); } catch { /* nothing to remove */ }
    hiddenOwner = OWNER + '-hidden';
    const commandLine = '"' + PROBE_EXE + '" --state "' + stateFile + '" --at 200 200 --offscreen';
    const armed = asReceipt(await tool.execute({
      action: 'takeover_start',
      owner_id: hiddenOwner,
      mouse_mode: 'virtual',
      desktop: 'hidden',
      launch: commandLine,
    }));
    keepReceipt('hidden-takeover-start', armed);
    fact('hidden_takeover_start', armed);
    assert.strictEqual(armed.ok, true, 'the hidden desktop must arm: ' + compact(armed));

    const opened = await waitForState(stateFile, (value) => Boolean(value && value.handle), 30000);
    assert.ok(opened && opened.handle,
      'the launched probe must publish a window handle on the hidden desktop: ' + (opened ? compact(opened) : 'no state file'));
    assert.strictEqual(Number(opened.registered), 1,
      'the hidden probe must have registered for raw input too; registered=' + String(opened.registered) +
      ' register_error=' + String(opened.register_error));

    const hostBefore = await gaugeState();
    const before = await settle(stateFile);
    /*
     * LIVENESS, because this check can answer ZERO and a zero from a dead probe would be a
     * fabricated negative. The probe increments a publish counter on every write (100 ms
     * timer, plus every WM_INPUT), so a probe that was alive and republishing across the
     * gesture is something the state file proves, not something this script assumes; the
     * state file mtime is the second, independent read of the same fact.
     */
    const beforePublishes = Number(before && before.publishes) || 0;
    const beforeMtime = fs.existsSync(stateFile) ? fs.statSync(stateFile).mtimeMs : 0;
    const swept = asReceipt(await tool.execute({
      action: 'sweep',
      owner_id: hiddenOwner,
      direction: 0,
      speed: 1200,
      duration_ms: 250,
      button: 'none',
    }));
    keepReceipt('hidden-sweep', swept);
    const after = await settle(stateFile);
    const afterPublishes = Number(after && after.publishes) || 0;
    const afterMtime = fs.existsSync(stateFile) ? fs.statSync(stateFile).mtimeMs : 0;
    const hostAfter = await gaugeState();
    const delta = deltaCounters(before, after);
    const liveness = {
      publishes_before: beforePublishes,
      publishes_after: afterPublishes,
      advanced: afterPublishes > beforePublishes,
      mtime_advanced: afterMtime > beforeMtime,
      registered: Number(before && before.registered),
    };
    fact('hidden_sweep', { receipt: swept, delta, host_before: hostBefore, host_after: hostAfter, liveness });
    note('hidden probe liveness across the gesture', liveness);

    /*
     * THE CONTRACT THIS CHECK HOLDS: THE HIDDEN ROUTE REFUSES sweep BY NAME.
     *
     * It used to hold the DELIVERY contract - a routed sweep makes raw motion land on that
     * desktop. That was MEASURED FALSE here on 2026-10-18: with this probe registered for raw
     * input on that desktop (registered=1) and provably alive across the gesture (15 -> 38
     * publishes, state-file mtime advancing), a routed 300 px / 16-step sweep that the agent
     * reported as fully injected produced 0 raw packets and sums of (0,0). The refusal that
     * replaced it is only honest while that measurement stands, so it is what this check
     * asserts: the zero is required, not tolerated. A build whose hidden desktop DOES route
     * pointer motion would turn this red, which is exactly the review it deserves.
     */
    assert.strictEqual(swept.ok, false,
      'the hidden route must REFUSE sweep rather than report a gesture nothing lands: ' + compact(swept));
    assert.strictEqual(String(swept.error_code), 'sweep_unsupported_on_hidden_desktop',
      'and must name the refusal sweep_unsupported_on_hidden_desktop: ' + compact(swept));
    assert.strictEqual(swept.physical_delivery_used, false,
      'a refusal injects nothing, so physical_delivery_used must be false: ' + compact(swept));
    assert.strictEqual(swept.fallback_to_real_delivery, false,
      'and it must not quietly fall back to delivering on this desktop instead: ' + compact(swept));
    assert.strictEqual(swept.action_completed, false,
      'and must not claim the gesture completed: ' + compact(swept));
    assert.strictEqual(Number(swept.measured_raw_packets), 0,
      'the refusal must carry the measurement it cites, measured_raw_packets=0; got ' +
      String(swept.measured_raw_packets) + ': ' + compact(swept));
    assert.ok(liveness.advanced && liveness.mtime_advanced,
      'the hidden probe must have been ALIVE and republishing across the call, or its zero says nothing: ' + compact(liveness));
    assert.strictEqual(liveness.registered, 1,
      'the probe must have registered for raw input on that desktop, or it was never an instrument: ' + compact(liveness));
    assert.strictEqual(delta.packets, 0,
      'the hidden probe must receive NO raw packet at all; measured ' + compact(delta));
    assert.strictEqual(delta.motion_packets, 0, 'no motion packet; measured ' + compact(delta));
    assert.strictEqual(delta.absolute_packets, 0, 'no absolute packet; measured ' + compact(delta));
    assert.strictEqual(delta.sum_dx + delta.sum_dy, 0, 'and no delta; measured ' + compact(delta));
    assert.strictEqual(delta.raw_left_down + delta.raw_left_up + delta.raw_right_down + delta.raw_right_up, 0,
      'and no button transition; measured ' + compact(delta));

    /*
     * THE REFUSAL IS ADVERTISED, not only implemented: a caller that reads mode_report before
     * it acts has to be able to see that this route does not carry sweep, and why.
     */
    const modeReport = asReceipt(await tool.execute({ action: 'mode_report', owner_id: hiddenOwner }));
    keepReceipt('hidden-mode-report', modeReport);
    const hiddenCapability = modeReport.hidden_desktop || {};
    fact('hidden_mode_report', { not_routed: hiddenCapability.not_routed, refused_by_name: hiddenCapability.refused_by_name });
    assert.ok(Array.isArray(hiddenCapability.not_routed) && hiddenCapability.not_routed.includes('sweep'),
      'mode_report must say the hidden route does not carry sweep: ' + compact(hiddenCapability.not_routed));
    assert.ok(Array.isArray(hiddenCapability.refused_by_name) &&
      hiddenCapability.refused_by_name.some((line) => String(line).includes('sweep_unsupported_on_hidden_desktop')),
      'and must name the refusal code: ' + compact(hiddenCapability.refused_by_name));

    const hostCursorBefore = pointerOf(hostBefore);
    const hostCursorAfter = pointerOf(hostAfter);
    assert.deepStrictEqual(hostCursorAfter, hostCursorBefore,
      'THIS desktop pointer must be untouched by a hidden-desktop sweep: before ' + compact(hostCursorBefore) +
      ' after ' + compact(hostCursorAfter));
    assert.strictEqual(String(hostAfter.foreground), String(hostBefore.foreground),
      'and so must THIS desktop foreground: before ' + String(hostBefore.foreground) + ' after ' + String(hostAfter.foreground));
    if (swept.host_desktop && swept.host_desktop.untouched !== undefined) {
      assert.strictEqual(swept.host_desktop.untouched, true,
        'and the receipt must agree that the host desktop was measured untouched: ' + compact(swept.host_desktop));
    } else {
      note('the hidden sweep receipt carries no host_desktop.untouched',
        'the outside measurement above is the evidence for this check');
    }
    return 'refused by name (' + String(swept.error_code) + ', measured_raw_packets=' + String(swept.measured_raw_packets) +
      '); hidden probe registered=' + String(liveness.registered) + ' alive ' + String(beforePublishes) + '->' +
      String(afterPublishes) + ' publishes and saw packets=' + String(delta.packets) + ' d=(' +
      String(delta.sum_dx) + ',' + String(delta.sum_dy) + '); host cursor and foreground unchanged';
  });

  await check(9, 'the action is advertised where a model can reach it', async () => {
    const url = new URL('file://' + path.join(COMPONENT, 'component.js').replace(/\\/g, '/'));
    const module = await import(url.href);
    const created = module.createComputerUse({});
    const definition = created.tools().find((entry) => entry.name === 'computer_use');
    assert.ok(definition, 'the component must publish the computer_use tool');
    const property = definition.parameters && definition.parameters.properties
      ? definition.parameters.properties.action
      : null;
    const actions = property && Array.isArray(property.enum) ? property.enum : [];
    assert.ok(actions.includes('sweep'),
      'the action enum must carry sweep, or the action exists and no model can call it; enum=' + compact(actions));
    const description = String(definition.description || '');
    assert.ok(description.includes('sweep'),
      'the tool description must name sweep, or a model will never choose it');
    const source = fs.readFileSync(COMPONENT_ENTRY, 'utf8');
    assert.ok(/ALL_ACTIONS\s*=/.test(source), 'the backend must declare its action list');
    assert.ok(source.includes("'sweep'"), 'the backend action list must include sweep');
    return 'enum entries=' + String(actions.length) + '; description names sweep; the backend action list carries it';
  });
}

/* ------------------------------------------------------- the planted-mutation harness --- */

/**
 * The one state this gate must never leave behind: a planted entry on disk.
 *
 * MEASURED, 2026-10-18: the first harness run blocked inside spawnSync because its child
 * printed a verdict and never exited, so the finally that restores the file never ran and the
 * working tree held a MUTATED lib/win32.js for ten minutes. The explicit exit fixed the
 * cause; this guard is the same protection for every other way a process can stop - a
 * normal exit, Ctrl-C, or a kill signal - because restore is not optional and a verification
 * script must never be able to leave the source it measures modified.
 */
const MUTATION_GUARD = { file: '', original: null, planted: false };

function restoreMutationNow(reason) {
  if (!MUTATION_GUARD.planted || !MUTATION_GUARD.original) return true;
  try {
    fs.writeFileSync(MUTATION_GUARD.file, MUTATION_GUARD.original);
    const expected = createHash('sha256').update(MUTATION_GUARD.original).digest('hex');
    const actual = sha256Of(MUTATION_GUARD.file);
    const ok = actual === expected;
    if (ok) MUTATION_GUARD.planted = false;
    if (!ok) say('MUTATION GUARD: the entry did not come back byte for byte (' + reason + '): expected ' + expected + ', found ' + actual);
    return ok;
  } catch (error) {
    say('MUTATION GUARD: the entry could not be rewritten (' + reason + '): ' + String(error && error.message ? error.message : error));
    return false;
  }
}

/**
 * One planted defect, and the two verdicts it has to produce.
 *
 * The mutation replaces the sweep relative injection with a SetCursorPos along the same
 * path: the pointer still travels, the receipt still reports dx/dy/steps, and NOTHING
 * reaches the raw-input queue. Check 3 must go RED, and after the file is restored byte for
 * byte it must go GREEN again - otherwise the red was a property of the run rather than of
 * the plant.
 */
const MUTATION = {
  id: 'S1',
  name: 'the sweep injection is replaced by SetCursorPos',
  find: '[NewmarkCuNative]::mouse_event(0x0001, $stepX, $stepY, 0, [System.UIntPtr]::Zero)',
  replace: '[NewmarkCuNative]::SetCursorPosPhysical([int]$cursorBefore[0] + $wantX, [int]$cursorBefore[1] + $wantY)',
  expectCheck: 3,
  why: 'The gesture keeps its arithmetic and its pointer travel; what it loses is the raw-input delivery that is the entire reason the action exists. Only a probe that counts WM_INPUT can see the difference, which is what makes check 3 fatal to the mutation and every receipt-shaped check blind to it.',
};

function runChildGate(label, out) {
  const result = spawnSync(process.execPath, [process.argv[1], '--only', '3', '--out', out], {
    cwd: path.dirname(REPO),
    encoding: 'utf8',
    /* Five minutes is well past a check-3 run (measured: about 40 s, probe compile included),
     * and it is short enough that a child which does not exit is reported as a named failure
     * rather than holding a mutated working tree for a quarter of an hour. */
    timeout: 300000,
  });
  const output = String(result.stdout || '') + '\n' + String(result.stderr || '');
  const failed = [];
  const failLines = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const text = rawLine.trim();
    const found = /^FAIL\s+(\d+)\.\s+(.*)$/.exec(text);
    if (found) { failed.push(Number(found[1])); failLines.push(text); }
  }
  return { label, out, status: result.status, failed, failLines, output: output.slice(-4000) };
}

async function runMutationHarness() {
  fs.mkdirSync(OUT, { recursive: true });
  const original = fs.readFileSync(COMPONENT_ENTRY);
  const originalSha = createHash('sha256').update(original).digest('hex');
  const text = original.toString('utf8');
  const occurrences = text.split(MUTATION.find).length - 1;
  if (occurrences !== 1) {
    throw new Error('the mutation anchor occurs ' + String(occurrences) + ' times in ' + COMPONENT_ENTRY +
      ', so this harness cannot plant the defect at exactly one site; the anchor is ' + JSON.stringify(MUTATION.find));
  }

  /*
   * A RECOVERY COPY, WRITTEN BEFORE THE PLANT.
   *
   * MEASURED, 2026-10-18: the first run of this harness blocked inside spawnSync - the child
   * printed its verdict and never exited - so the finally that restores the file did not run
   * and the working tree sat with a MUTATED lib/win32.js on disk while the harness was
   * "running". The explicit exit in the child fixes the cause; this copy is the guarantee
   * for the consequence, because a harness that can leave the tree modified for any reason
   * has to have put the clean bytes somewhere first.
   */
  const recovery = path.join(OUT, 'win32.js.original');
  fs.writeFileSync(recovery, original);
  const recoverySha = sha256Of(recovery);
  if (recoverySha !== originalSha) {
    throw new Error('the recovery copy does not match the file it was copied from: ' + recoverySha + ' vs ' + originalSha);
  }
  note('a byte-exact recovery copy of the entry is on disk', { path: recovery, sha256: recoverySha });

  let red = null;
  let green = null;
  MUTATION_GUARD.file = COMPONENT_ENTRY;
  MUTATION_GUARD.original = original;
  MUTATION_GUARD.planted = true;
  try {
    fs.writeFileSync(COMPONENT_ENTRY, text.split(MUTATION.find).join(MUTATION.replace));
    const plantedSha = sha256Of(COMPONENT_ENTRY);
    note('the plant is in place', { sha256_planted: plantedSha, differs_from_released: plantedSha !== originalSha });
    red = runChildGate('mutated', path.join(OUT, 'mutated'));
  } finally {
    /* Restore, then verify the restore on disk. If the in-memory write did not take, the
     * recovery copy written before the plant is the second source and it is tried too - the
     * gate fails rather than leaving a mutant behind, and it fails AFTER trying both. */
    try { fs.writeFileSync(COMPONENT_ENTRY, original); } catch { /* the recovery copy is next */ }
    if (sha256Of(COMPONENT_ENTRY) !== originalSha) {
      try { fs.copyFileSync(recovery, COMPONENT_ENTRY); } catch { /* reported below */ }
    }
    if (sha256Of(COMPONENT_ENTRY) === originalSha) MUTATION_GUARD.planted = false;
  }
  const restoredSha = sha256Of(COMPONENT_ENTRY);
  if (restoredSha !== originalSha) {
    throw new Error('the entry was NOT restored - THIS TREE IS MODIFIED, restore it from ' + recovery +
      ': expected sha256 ' + originalSha + ', found ' + restoredSha);
  }
  green = runChildGate('restored', path.join(OUT, 'restored'));
  const afterRunSha = sha256Of(COMPONENT_ENTRY);

  fact('mutation', {
    id: MUTATION.id,
    name: MUTATION.name,
    find: MUTATION.find,
    replace: MUTATION.replace,
    expect_check: MUTATION.expectCheck,
    restored: {
      expected: originalSha, actual: restoredSha, after_run: afterRunSha,
      restored: restoredSha === originalSha && afterRunSha === originalSha,
    },
    red: { status: red.status, failed: red.failed, fail_lines: red.failLines },
    green: { status: green.status, failed: green.failed, fail_lines: green.failLines },
  });

  assert.ok(red.failed.includes(MUTATION.expectCheck),
    'with the injection replaced by SetCursorPos the gate must go RED on check ' + String(MUTATION.expectCheck) +
    '; the mutated run failed checks ' + compact(red.failed) + ' and printed: ' + (red.failLines.join(' | ') || '(no FAIL line)'));
  assert.deepStrictEqual(green.failed, [],
    'after the file was restored byte for byte the same check must be GREEN; the restored run failed ' + compact(green.failed) +
    ' and printed: ' + (green.failLines.join(' | ') || '(no FAIL line)'));
  assert.strictEqual(afterRunSha, originalSha,
    'the entry must still be the released bytes after the harness ran: expected ' + originalSha + ', found ' + afterRunSha);

  return 'mutated -> check ' + String(MUTATION.expectCheck) + ' RED (' + (red.failLines[0] || 'no line').slice(0, 150) +
    ') || restored -> GREEN || sha256 ' + originalSha.slice(0, 16) + ' verified before, after and after the control';
}

/* --------------------------------------------------------------------- the lock slot --- */

/**
 * Who holds a Windows takeover slot, and whether that owner still exists.
 *
 * `acquireTakeoverLock` (lib/takeover-lock.js) spawns `takeover-lock.exe <owner-pid> <mode>`
 * and the kernel handle in that child is the slot. MEASURED 2026-10-18: a full run answered
 * `takeover_lease_occupied` on the virtual mode from checks 6 and 7 while the recorded owner
 * was the live DSH host process - so the slot can be held by a process that believes it
 * released it, and nothing in the plugin notices while the owner lives. The gate cannot fix
 * another process's leak, but it must not present that leak as a product verdict, so it is
 * named before anything is measured.
 */
let virtualSlotHeldByLiveProcess = false;

/**
 * Who holds which slot, as of the last audit.
 *
 * The virtual slot is audited once, before measuring, because a hidden desktop cannot be armed
 * while it is taken. The REAL slot can be taken at any moment by another session - MEASURED
 * 2026-10-18: check 5s second gesture was refused 'takeover_lease_occupied: Another DSH host
 * owns this mode' while the audit at start-up had found the slots free - so the real slot is
 * re-audited at the moment a gesture is refused for occupancy, and the question asked then is
 * whether the holder is a LIVE session (blocked, nothing claimed) or a dead owner (a stale
 * lock, which is a defect and is reported as one).
 */
const slotHolders = { real: { live: [], dead: [] }, virtual: { live: [], dead: [] } };

/** A check that the machine prevented, rather than the code failing. */
class BlockedByLiveHolder extends Error {
  constructor(message, receipt) {
    super(message);
    this.name = 'BlockedByLiveHolder';
    this.blocked = true;
    this.receipt = receipt;
  }
}

async function auditTakeoverLocks() {
  const script = [
    '$mine = ' + String(process.pid),
    '$name = "takeover-lock.exe"',
    '$locks = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq $name })',
    '$out = @()',
    'foreach ($lock in $locks) {',
    '  $tokens = ([string]$lock.CommandLine) -split " +"',
    '  $owner = 0',
    '  foreach ($token in $tokens) { if ($token -match "^[0-9]+$") { $owner = [int]$token; break } }',
    '  $alive = $false',
    '  if ($owner -gt 0) { $process = Get-Process -Id $owner -ErrorAction SilentlyContinue; if ($process) { $alive = $true } }',
    '  $mode = "unknown"',
    '  foreach ($token in $tokens) { if ($token -eq "real" -or $token -eq "virtual") { $mode = $token } }',
    '  $out += @{ lock_pid = [int]$lock.ProcessId; owner_pid = $owner; owner_alive = $alive; mode = $mode }',
    '}',
    'Write-Output ("NMLOCKS " + (@{ mine = $mine; locks = @($out) } | ConvertTo-Json -Depth 6 -Compress))',
  ].join('\r\n');
  const raw = await runPowerShell(script, { timeoutMs: 60000, executable: process.env.NM_HIDDEN_PWSH || windowsPowerShellPath() });
  const value = markerLine(raw.output, 'NMLOCKS ');
  if (!value) {
    note('the takeover slots could not be audited', String(raw.output || raw.error || '').slice(-300));
    return null;
  }
  const locks = Array.isArray(value.locks) ? value.locks : [];
  fact('takeover_locks', value);
  const foreign = locks.filter((entry) => Number(entry.owner_pid) !== process.pid);
  const foreignLive = foreign.filter((entry) => entry.owner_alive === true);
  const foreignDead = foreign.filter((entry) => entry.owner_alive !== true);
  for (const mode of ['real', 'virtual']) {
    slotHolders[mode] = {
      live: foreignLive.filter((entry) => String(entry.mode) === mode),
      dead: foreignDead.filter((entry) => String(entry.mode) === mode),
    };
  }
  virtualSlotHeldByLiveProcess = slotHolders.virtual.live.length > 0;
  if (foreign.length === 0) {
    note('the takeover slots are free', 'no takeover-lock.exe is running for a process other than this one');
  } else {
    note('A TAKEOVER SLOT IS HELD BY ANOTHER PROCESS',
      foreign.map((entry) => ({ mode: entry.mode, owner_pid: entry.owner_pid, owner_alive: entry.owner_alive, lock_pid: entry.lock_pid })));
    if (foreignLive.length) {
      /* MEASURED 2026-10-18: the virtual slot was held by owner pid 102604 - the live DSH
       * host - whose own mode_report showed an ACTIVE hidden-desktop route (agent alive,
       * requests_served climbing) while its lease said held:false. A live owner means somebody
       * is using this machine: the checks that need that slot are NOT MEASURED, never failed,
       * so a busy desk cannot be reported as a product defect. */
      note('the slot is held by a LIVE process, so the checks that need it will report SKIP',
        'a live holder is a session using this machine, not evidence against the code');
    }
    if (foreignDead.length) {
      note('the slot is held by a DEAD owner: that is a stale lock and the checks will say so',
        'a lock whose recorded owner no longer exists holds a slot nobody can use');
    }
  }
  return value;
}

/**
 * Kill the takeover-lock children THIS process started, synchronously.
 *
 * `stopAll()` is called first, because the released path (writing "release" to the lock
 * child) is the correct one; this is the belt for the case where it did not run - a throw
 * between an action and its finally, or a signal. The lock helper also watches its parent
 * (takeover-lock.cs waits on the parent handle and exits when it dies), so this should rarely
 * find anything: it is here because a verification script must not rely on somebody else's
 * watchdog for a slot it took, and because a kill that leaves a slot held blocks every later
 * measurement on the machine.
 *
 * Only locks whose ARGUMENT names this process are touched. A lock held by another host is
 * reported by auditTakeoverLocks and left alone - killing it would corrupt someone else's run.
 */
function killOwnTakeoverLocks(reason) {
  const script = [
    '$mine = ' + String(process.pid),
    '$name = "takeover-lock.exe"',
    '$killed = @()',
    '$locks = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq $name })',
    'foreach ($lock in $locks) {',
    '  $tokens = ([string]$lock.CommandLine) -split " +"',
    '  $owner = 0',
    '  foreach ($token in $tokens) { if ($token -match "^[0-9]+$") { $owner = [int]$token; break } }',
    '  if ($owner -eq $mine) { Stop-Process -Id $lock.ProcessId -Force -ErrorAction SilentlyContinue; $killed += [int]$lock.ProcessId }',
    '}',
    'Write-Output ("NMOWNLOCKS " + (@{ reason = "REASON"; mine = $mine; killed = @($killed) } | ConvertTo-Json -Compress))',
  ].join('\r\n').replace('REASON', String(reason));
  try {
    const raw = spawnSync(process.env.NM_HIDDEN_PWSH || windowsPowerShellPath(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 15000, encoding: 'utf8', windowsHide: true });
    const value = markerLine(raw.stdout, 'NMOWNLOCKS ');
    if (value) fact('own_lock_children_killed_' + String(reason).replace(/[^a-z]/gi, '_'), value);
    return value;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------- cleanup --- */

async function cleanup() {
  try {
    if (hiddenOwner && tool) {
      const stopped = asReceipt(await tool.execute({ action: 'takeover_stop', owner_id: hiddenOwner }));
      keepReceipt('hidden-takeover-stop', stopped);
      fact('hidden_takeover_stop', stopped);
    }
  } catch { /* the receipt is what reports a teardown; a throw here must not hide it */ }
  hiddenOwner = '';
  /*
   * The backend OWN teardown, and then the slots.
   *
   * stopAll() is the released path: it stops every lane child, stops the resident hidden
   * agents synchronously and releases the in-process lease through the same function
   * takeover_stop uses. It runs HERE, in the finally of every path - pass, fail, throw - so a
   * failing check cannot leave a lane, an agent or a lease behind. killOwnTakeoverLocks is
   * the belt for a lock whose release write did not happen, and it only ever touches locks
   * this process started.
   */
  try {
    const backend = await loadBackendModule();
    if (backend && typeof backend.stopAll === 'function') {
      const stopped = backend.stopAll();
      fact('backend_stop_all', stopped);
    }
  } catch (error) {
    note('the backend teardown threw', String(error && error.message ? error.message : error));
  }
  killOwnTakeoverLocks('cleanup');
  for (const child of probes) {
    try { child.kill(); } catch { /* already gone */ }
  }
  try {
    if (desk.recorded) await gaugeMove(desk.cursor.x, desk.cursor.y);
    if (desk.recorded && desk.foreground && desk.foreground !== '0x0') {
      await gaugeRaise(String(desk.foreground).replace(/^0x/i, ''));
    }
  } catch { /* restoring the desk is best effort; the report says what was measured */ }
}

/* --------------------------------------------------------------------- the report --- */

function writeReport(verdict) {
  fs.mkdirSync(OUT, { recursive: true });
  const report = {
    gate: 'verify-cu-sweep',
    ranAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    contract: CONTRACT,
    component: COMPONENT_ENTRY,
    componentSha256: fs.existsSync(COMPONENT_ENTRY) ? sha256Of(COMPONENT_ENTRY) : null,
    script: fileURLToPath(import.meta.url),
    scriptSha256: sha256Of(fileURLToPath(import.meta.url)),
    only: ONLY ? [...ONLY] : null,
    mutations: MUTATIONS,
    verdict,
    outcomes,
    notes: TRACK.notes,
    facts: TRACK.facts,
    receipts: TRACK.receipts,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const lines = [
    '# verify-cu-sweep - the relative-motion gate',
    '',
    'Ran at ' + report.ranAt + ' on ' + report.platform + ' (node ' + report.node + ').',
    'Contract: ' + CONTRACT,
    'Component under test: ' + COMPONENT_ENTRY + ' (sha256 ' + String(report.componentSha256) + ')',
    '',
    '## Checks',
    '',
  ];
  for (const item of outcomes) {
    lines.push('- ' + item.status + ' ' + String(item.index) + '. ' + item.name +
      (item.message ? ' -- ' + String(item.message).split('\n')[0] : ''));
  }
  lines.push('', '## Notes taken during the run', '');
  for (const item of TRACK.notes) {
    lines.push('- ' + item.name + ': ' + (typeof item.value === 'string' ? item.value : compact(item.value)));
  }
  lines.push('', '## Boundaries', '');
  lines.push('This gate measured a WinForms raw-input probe on this station and the ComputerUse backend in this working tree. It did NOT verify:');
  lines.push('');
  lines.push('- a real game or any third-party consumer of raw input. The probe is the only raw-input consumer here; a game that ignores injected input, or that runs at a higher integrity level than the agent, is out of scope (docs/14-cu-sweep.md section 7).');
  lines.push('- the mapping from injected delta to cursor travel on a machine with pointer acceleration. MEASURED here: dx=300 in the receipt, raw sum 300, cursor displacement 923 - acceleration amplifies the pointer movement, so cursor displacement is never used as the instrument for the injected delta.');
  lines.push('- pointer acceleration settings other than this station, other DPI scalings, or other Windows builds; check 7 answers the hidden-desktop input stack here, for this build, and nowhere else.');
  lines.push('- the absence of a physical mouse on the desk. A person moving the mouse during a gesture adds raw input the probe cannot attribute to anyone; settle() only keeps the BASELINE quiet.');
  lines.push('- anti-cheat, game-specific input stacks, or any consumer that filters synthetic input.');
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), lines.join('\n') + '\n');
  const manifestFiles = [
    path.join(OUT, 'report.json'),
    path.join(OUT, 'REPORT.md'),
    PROBE_SOURCE,
    PROBE_EXE,
    fileURLToPath(import.meta.url),
    COMPONENT_ENTRY,
  ].filter((file) => fs.existsSync(file));
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify({
    gate: 'verify-cu-sweep',
    ranAt: report.ranAt,
    files: manifestFiles.map((file) => ({ path: file, bytes: fs.statSync(file).size, sha256: sha256Of(file) })),
  }, null, 2));
}

/* --------------------------------------------------------------------- the run --- */

if (!IS_WINDOWS) {
  say('PREMISE ABSENT: verify-cu-sweep measures Windows raw mouse input (WM_INPUT) and the Win32 backend; this platform is ' + process.platform + '.');
  process.exit(2);
}

fs.mkdirSync(OUT, { recursive: true });
/**
 * The last-resort teardown, for the paths where a finally does not run.
 *
 * Two things must not outlive this process: a probe window it started, and a planted entry.
 * A normal error runs the finally in the runner; this covers a kill, a Ctrl-C and a crash.
 * Both restores are synchronous on purpose - an event-loop handler that awaited a PowerShell
 * round trip would not finish before the process died.
 */
function lastResortTeardown(reason) {
  restoreMutationNow(reason);
  killOwnTakeoverLocks(String(reason));
  for (const child of probes) { try { child.kill(); } catch { /* already gone */ } }
}
process.once('exit', () => lastResortTeardown('process exit'));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    lastResortTeardown(signal);
    process.exit(1);
  });
}
say('verify-cu-sweep -- evidence: ' + OUT);

let failureToReport = null;
try {
  await auditTakeoverLocks();
  if (MUTATIONS) {
    await check(8, 'planted mutation: the gate goes RED on check 3 when injection becomes SetCursorPos', runMutationHarness);
  } else {
    /* The ordinary run: every check that measures the shipped behaviour, with the falsification
     * harness left to --mutations so that a release chain run cannot plant a defect. Check 7
     * does arm a hidden desktop (that is the only way to ask a hidden-desktop question), and it
     * tears the lease and the probe down in the finally below whether it passes or fails. */
    tool = await buildTool();
    await runChecks();
    skipCheck(8, 'planted mutation: the gate goes RED on check 3 when injection becomes SetCursorPos',
      'opt-in: run this gate with --mutations, which plants the defect, requires the red and restores the file');
  }
} catch (error) {
  failureToReport = error;
} finally {
  try { await cleanup(); } catch { /* the report carries the outcome */ }
}

const passed = outcomes.filter((item) => item.status === 'PASS').length;
const failed = outcomes.filter((item) => item.status === 'FAIL');
const skipped = outcomes.filter((item) => item.status === 'SKIP');

say('');
say('  Not verified (docs/00-governance.md B-26): a real game consuming raw input; pointer acceleration and DPI on other machines; the hidden-desktop input stack on another Windows build.');
say('----------------------------------------------------------------');
say('SUMMARY platform=' + process.platform + ' assertions=' + String(outcomes.length) + ' passed=' + String(passed) +
  ' failed=' + String(failed.length) + ' skipped=' + String(skipped.length));
if (skipped.length) say('SKIP  ' + skipped.map((item) => String(item.index) + '.' + item.name).join(', '));
for (const item of failed) {
  say('FAILED ' + String(item.index) + '. ' + item.name + ': ' + String(item.message).split('\n').slice(0, 4).join(' | '));
}

/*
 * A SKIPPED CHECK IS NOT A PASSED GATE.
 *
 * docs/00-governance.md D-2 keeps SKIP separate from PASS, and the umbrella chain reads this
 * gate the way it reads every child: exit 0 plus a PASS line is a pass. So a run in which any
 * check could not be measured (a live session holding the virtual takeover slot is the real
 * case: measured 2026-10-18) must NOT exit 0 with PASS - it exits 2 with a PREMISE ABSENT
 * line, which is the convention this repository already uses for "the machine could not be
 * measured" (verify-tool-output-boundary.mjs), and the chain then counts the gate as skipped
 * rather than passed. Everything that WAS measured is still printed above and written to the
 * report; nothing is claimed for what was not.
 */
let verdict;
if (failureToReport) verdict = 'FAIL ' + String(failureToReport.message).split('\n')[0];
else if (failed.length) verdict = 'FAIL ' + String(failed.length) + ' of ' + String(outcomes.length) + ' checks';
else if (skipped.length) verdict = 'SKIP ' + String(skipped.length) + ' not measured of ' + String(outcomes.length) + ' checks (' + String(passed) + ' measured and passed)';
else verdict = 'PASS ' + String(passed) + ' checks';
try { writeReport(verdict); } catch (error) { say('  (note) the report could not be written: ' + String(error && error.message ? error.message : error)); }

say('');
say(verdict);
const exitCode = failureToReport || failed.length ? 1 : (skipped.length ? 2 : 0);
process.exitCode = exitCode;
if (skipped.length && !failureToReport && !failed.length) {
  say('PREMISE ABSENT: ' + skipped.map((item) => String(item.index) + '.' + item.name).join(', ') +
    ' could not be measured on this machine (' + String((skipped[0] && skipped[0].message) || '').split(' - ')[0] +
    '); nothing is claimed for them, so this gate counts as skipped, not passed.');
}
/*
 * AN EXPLICIT EXIT, AND WHY THIS GATE NEEDS ONE.
 *
 * MEASURED on this station, 2026-10-18: after printing its verdict this process stayed
 * ALIVE - the ComputerUse component arms handles of its own (the overlay renderer and the
 * resident-agent plumbing), so the event loop never drained. Three consequences, all real:
 * running the gate by hand left a node process behind; the release chain's execFileSync
 * waits the whole 15-minute child budget and reports the pass as "unreturned"; and the
 * mutation harness, whose spawnSync waits for its child to EXIT, blocked forever while a
 * MUTATED lib/win32.js was still on disk - the one state a mutation harness must never leave
 * the tree in. So the exit is explicit, and it waits for stdout to flush first so no verdict
 * line is ever truncated by it.
 */
process.stdout.write('', () => process.exit(exitCode));
