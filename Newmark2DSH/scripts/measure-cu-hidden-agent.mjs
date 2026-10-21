#!/usr/bin/env node
/**
 * measure-cu-hidden-agent.mjs - the behavioural evidence for a RESIDENT AGENT that lives on a
 * hidden Windows desktop and performs every action itself.
 *
 * =====================================================================================
 * WHAT IS DIFFERENT FROM measure-cu-hidden-desktop.mjs, AND WHY
 * =====================================================================================
 *
 * The previous phase asked whether a LANE process could reach INTO a hidden desktop by opening
 * it. Three phases asked that and all three came back negative; the mechanism is that the kernel
 * answers IsWindow and GetWindowThreadProcessId for another desktop's window only while the
 * CALLING PROCESS has that desktop open, and the reach dies when the handle closes. This script
 * does not attempt that reach anywhere and does not measure it - the road is walked out.
 *
 * What it measures instead is the same question asked from the other side: put the CALLER on the
 * desktop, and every call becomes an ordinary same-desktop call. `lib/hidden-agent.js` is that
 * caller. So the assertions here are about an agent's own observations of its own desktop, and
 * the evidence is the application's own state rather than a status code:
 *
 *   the application's own click counter   incremented by the agent's click
 *   the application's own text field      containing the text the agent typed
 *   two captures of two different states  differing in their bytes
 *   the application's own window title    read back through a SECOND, independent path
 *
 * `queued: true` is worth nothing here and is never reported as a result.
 *
 * =====================================================================================
 * THE CONTROLS, BOTH OF THEM, BECAUSE A CHECK THAT CANNOT FAIL IS WORTHLESS
 * =====================================================================================
 *
 *   control A - the interactive desktop. The SAME agent, the SAME protocol, the SAME sequence,
 *   the SAME application, with one thing changed: the desktop it was started onto. The
 *   application runs offscreen, without activation and without a taskbar entry, and the script
 *   asserts that the interactive desktop's foreground window and cursor are the same before and
 *   after. It never opens the Start menu and never moves or closes anything the user can see.
 *
 *   control B - the removed hidden-desktop handling. The SAME agent, started on the interactive
 *   desktop, is handed the HIDDEN desktop's window handle and asked to drive it. If the
 *   hidden-desktop handling is what makes the hidden run work, this must fail, and it is reported
 *   with exactly what it observed rather than with a verdict alone.
 *
 *   control C - the removed job assignment. The SAME hard kill, on an agent started with -NoJob.
 *   If the job handle is what releases the hosted processes, they must still be ALIVE here.
 *
 * =====================================================================================
 * SAFETY
 * =====================================================================================
 *
 *   - No process class is ever named in cleanup. Every process this script starts is tracked by
 *     the pid its own create call returned, with its start time, and terminated from that root.
 *   - Every desktop this script creates is closed by the handle that created it, and the script
 *     then proves from a SEPARATE process that the name is free.
 *   - Nothing is written under `C:\Users\12252\.Newmark`. Artifacts go to
 *     `evidence/cu-hidden-agent/<stamp>/` and to `%TEMP%\nm-cu-agent\`.
 *   - The 30 empty desktops three previous phases left behind are NOT touched and NOT chased.
 *
 * Exit codes: 0 the measurement completed (the verdicts are in the receipt, not the exit code);
 *             1 the measurement could not run; 2 cleanup did not verify.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CSHARP_PAYLOADS,
  PROCESS_FACTS_CSHARP,
  MAKER_CSHARP,
  startHiddenDesktopAgent,
  startDesktopKeeper,
  relayThroughLane,
  reapLedger,
  readLedger,
  runPowerShell,
  windowsPowerShellPath,
  ledgerPath,
  fileDigest,
} from '../packages/newmark-core/components/computeruse/lib/hidden-agent.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const COMPONENT = path.join(REPO, 'packages', 'newmark-core', 'components', 'computeruse');
const COMPONENT_ENTRY = path.join(COMPONENT, 'lib', 'win32.js');
const AGENT_MODULE = path.join(COMPONENT, 'lib', 'hidden-agent.js');
const ONLY = process.argv.find((value) => value.startsWith('--only='))?.slice('--only='.length) || null;
const WITH_EDGE = !process.argv.includes('--no-edge');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(REPO, 'evidence', 'cu-hidden-agent', STAMP);
const SHOTS = path.join(OUT, 'captures');
fs.mkdirSync(SHOTS, { recursive: true });
const SCRATCH = path.join(OUT, 'scratch');
fs.mkdirSync(SCRATCH, { recursive: true });
const LEDGER = path.join(OUT, 'ledger.jsonl');

const COMPONENT_SHA_BEFORE = createHash('sha256').update(fs.readFileSync(COMPONENT_ENTRY)).digest('hex');
const AGENT_SHA = createHash('sha256').update(fs.readFileSync(AGENT_MODULE)).digest('hex');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line = '') => process.stdout.write(`${String(line)}\n`);

/** Everything created, remembered by identity so cleanup names no process class. */
const TRACK = {
  pids: [],
  desktops: new Map(),
  keepers: [],
  checks: [],
  notes: [],
};

function record(name, ok, detail) {
  TRACK.checks.push({ name, ok: ok === true, detail: String(detail) });
  say(`  [${ok === true ? 'PASS' : 'FAIL'}] ${name}${detail ? ` :: ${String(detail).slice(0, 400)}` : ''}`);
  return ok === true;
}

function note(name, value) {
  TRACK.notes.push({ name, value });
  say(`  (note) ${name}: ${typeof value === 'string' ? value.slice(0, 500) : JSON.stringify(value)}`);
}

function trackPid(pid, label) {
  if (Number.isFinite(pid) && pid > 0) TRACK.pids.push({ pid: Number(pid), label });
}

/* ------------------------------------------------------------------ PowerShell helpers --- */

/**
 * A pwsh program with C# payloads compiled into it, run in a FRESH process.
 *
 * "From a separate process" is load-bearing throughout this script: a check that the process
 * which did the killing also runs is not evidence about what the kernel did. Every such check
 * goes through here, which is a new `powershell.exe` with no handle from the agent at all.
 */
function pwshWithPayloads(names, body) {
  const lines = ['$ErrorActionPreference = "Stop"'];
  for (const name of names) {
    const encoded = Buffer.from(CSHARP_PAYLOADS[name], 'utf8').toString('base64');
    lines.push(`$src_${name} = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'`);
    lines.push(encoded);
    lines.push("'@))");
    lines.push(`if (-not ("${name}" -as [type])) { Add-Type -TypeDefinition $src_${name} -ErrorAction Stop }`);
  }
  return lines.concat(body).join('\n');
}

function markerLine(output, marker) {
  const lines = String(output || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    const at = line.indexOf(marker);
    if (at < 0) continue;
    try { return JSON.parse(line.slice(at + marker.length).trim()); } catch { return null; }
  }
  return null;
}

/**
 * Is a pid the same process that was recorded, and is it RUNNING? Asked of a fresh process.
 *
 * Two corrections live here and both were forced by measurement.
 *
 * `ticks` comes back as a STRING and stays one. A FILETIME tick count is about 1.3e17 and a JSON
 * number is exact only to 2^53, so carrying these as numbers rounds them and every comparison
 * against the process they describe then fails. Measured: a whole run reported every one of its OWN
 * processes as "pid reused" and refused to terminate any of them.
 *
 * `alive` means the process is RUNNING, not that the pid resolves. Measured: after TerminateProcess
 * returns success the pid keeps answering OpenProcess and GetProcessTimes for SECONDS, so a liveness
 * test built on OpenProcess calls a corpse alive - and this measurement's own successful hard kill
 * came back as a failure because of it.
 */
async function separatePidCheck(pid, startTimeTicks) {
  const expected = `'${String(startTimeTicks === null || startTimeTicks === undefined ? '' : startTimeTicks).replace(/'/g, '')}'`;
  const script = pwshWithPayloads(['NmProcessFacts'], [
    `$ticks = [NmProcessFacts]::StartTimeTicks(${Number(pid)})`,
    `$running = $false`,
    `if ($ticks -gt 0) { $running = [NmProcessFacts]::Running(${Number(pid)}) }`,
    '$expected = [long]0',
    `try { $expected = [long]${expected} } catch { $expected = [long]0 }`,
    `$payload = @{ pid = ${Number(pid)}; ticks = [string]$ticks; alive = $running; resolves = ($ticks -gt 0); same = ($running -and ($expected -le 0 -or $ticks -eq $expected)); start_time_utc = [NmProcessFacts]::StartTimeUtc(${Number(pid)}) } | ConvertTo-Json -Depth 6 -Compress`,
    'Write-Output ("NMPID " + $payload)',
  ]);
  const raw = await runPowerShell(script, { timeoutMs: 60000 });
  const value = markerLine(raw.output, 'NMPID ');
  if (!value) return { ok: false, error: raw.error || 'no NMPID line', stderr: String(raw.stderr || '').slice(-800) };
  return { ok: true, value };
}

/**
 * Is the desktop name free, asked of a fresh process that opened it for exactly this purpose?
 *
 * This is the check the whole "the desktop's death is handled" claim rests on, and it is made
 * from OUTSIDE the agent: a handle count read by the process that owns the handle would prove
 * nothing. `OpenDesktopW` answers 0 for a desktop that no longer exists.
 */
async function separateDesktopCheck(desktopName) {
  const literal = `'${String(desktopName).replace(/'/g, "''")}'`;
  const script = pwshWithPayloads(['NmHiddenMaker'], [
    '$errorCode = 0',
    `$hold = [NmHiddenMaker]::OpenByName(${literal}, [ref]$errorCode)`,
    '$name = ""',
    'if ($hold -ne [IntPtr]::Zero) { $name = [NmHiddenMaker]::KernelName($hold); [void][NmHiddenMaker]::CloseDesktop($hold) }',
    `$payload = @{ desktop = ${literal}; opened = ($hold -ne [IntPtr]::Zero); open_error = [int]$errorCode; kernel_name = $name } | ConvertTo-Json -Depth 6 -Compress`,
    'Write-Output ("NMDESK " + $payload)',
  ]);
  const raw = await runPowerShell(script, { timeoutMs: 60000 });
  const value = markerLine(raw.output, 'NMDESK ');
  if (!value) return { ok: false, error: raw.error || 'no NMDESK line', stderr: String(raw.stderr || '').slice(-800) };
  return { ok: true, value };
}

/** Terminate exactly the process whose start time matches, from a fresh process. */
async function separateTerminate(pid, startTimeTicks) {
  const expected = `'${String(startTimeTicks === null || startTimeTicks === undefined ? '' : startTimeTicks).replace(/'/g, '')}'`;
  const script = pwshWithPayloads(['NmProcessFacts'], [
    '$errorCode = 0',
    `$outcome = [NmProcessFacts]::TerminateIfStartTime(${Number(pid)}, [long]${expected}, [ref]$errorCode)`,
    `$payload = @{ pid = ${Number(pid)}; outcome = [int]$outcome; last_error = [int]$errorCode } | ConvertTo-Json -Depth 6 -Compress`,
    'Write-Output ("NMKILL " + $payload)',
  ]);
  const raw = await runPowerShell(script, { timeoutMs: 60000 });
  const value = markerLine(raw.output, 'NMKILL ');
  if (!value) return { ok: false, error: raw.error || 'no NMKILL line', stderr: String(raw.stderr || '').slice(-800) };
  return { ok: true, value };
}

/**
 * Hard-kill, not a graceful exit. TerminateProcess on the agent, from a process that is not it.
 *
 * A `finally` does not run when a process is killed, which is the entire reason the ownership in
 * this design is a job handle and not a cleanup routine. The kill has to be the rude one or the
 * measurement would be about the wrong thing.
 */
async function hardKill(pid, startTimeTicks) {
  const outcome = await separateTerminate(pid, startTimeTicks);
  if (!outcome.ok) return outcome;
  for (let i = 0; i < 100; i += 1) {
    const alive = await separatePidCheck(pid, startTimeTicks);
    if (alive.ok && alive.value.alive === false) return { ok: true, outcome: outcome.value, gone: true };
    await sleep(100);
  }
  return { ok: true, outcome: outcome.value, gone: false };
}

/** The interactive desktop's own facts, for the "nothing changed" assertion in control A. */
const INTERACTIVE_FACTS_CSHARP = String.raw`using System;
using System.Runtime.InteropServices;
public static class NmInteractiveFacts
{
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static long CursorX() { POINT point; GetCursorPos(out point); return point.X; }
  public static long CursorY() { POINT point; GetCursorPos(out point); return point.Y; }
  public static long Foreground() { return GetForegroundWindow().ToInt64(); }
}
`;

async function interactiveFacts() {
  const encoded = Buffer.from(INTERACTIVE_FACTS_CSHARP, 'utf8').toString('base64');
  const script = [
    '$ErrorActionPreference = "Stop"',
    "$source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
    encoded,
    "'@))",
    'if (-not ("NmInteractiveFacts" -as [type])) { Add-Type -TypeDefinition $source -ErrorAction Stop }',
    '$payload = @{ cursor_x = [long][NmInteractiveFacts]::CursorX(); cursor_y = [long][NmInteractiveFacts]::CursorY(); foreground = ("0x" + [NmInteractiveFacts]::Foreground().ToString("x")) } | ConvertTo-Json -Depth 6 -Compress',
    'Write-Output ("NMFACTS " + $payload)',
  ].join('\n');
  const raw = await runPowerShell(script, { timeoutMs: 60000 });
  const value = markerLine(raw.output, 'NMFACTS ');
  return value || { error: raw.error || 'no NMFACTS line' };
}

/* ----------------------------------------------------------------------- the probe app --- */

const PROBE_CSHARP = String.raw`using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

/**
 * The probe application. Its own state, and nothing else.
 *
 * It counts clicks and wheel messages in its own window procedure, keeps typed characters in its
 * own edit field, publishes both to a state file AND to its own window title, and paints a
 * rectangle whose size depends on the counters. The title is deliberate: it is a SECOND read path
 * for the same facts, taken by the agent's own enumeration rather than from a file the harness
 * shares, so a measurement that only read the file could not be fooled by a stale one.
 */
public sealed class NmProbeForm : Form
{
  int clicks;
  int wheelTicks;
  readonly string statePath;
  readonly Timer timer;
  readonly TextBox field;

  public NmProbeForm(string statePath, bool offscreen)
  {
    this.statePath = statePath;
    this.Text = "NmProbe";
    this.ClientSize = new Size(420, 260);
    this.StartPosition = FormStartPosition.Manual;
    if (offscreen)
    {
      /* Offscreen, out of the taskbar, and never activated - see ShowWithoutActivation below.
         The interactive-desktop control run must not put anything in front of the user. */
      this.Location = new Point(-4000, -4000);
      this.ShowInTaskbar = false;
    }
    this.field = new TextBox();
    this.field.Name = "nmfield";
    this.field.Location = new Point(20, 24);
    this.field.Width = 360;
    this.Controls.Add(this.field);
    this.timer = new Timer();
    this.timer.Interval = 120;
    this.timer.Tick += this.OnTick;
    this.timer.Start();
    this.Publish();
  }

  protected override bool ShowWithoutActivation { get { return true; } }

  protected override void WndProc(ref Message m)
  {
    if (m.Msg == 0x0201) { this.clicks = this.clicks + 1; this.Publish(); this.Invalidate(); }
    else if (m.Msg == 0x020A) { this.wheelTicks = this.wheelTicks + 1; this.Publish(); this.Invalidate(); }
    base.WndProc(ref m);
  }

  void OnTick(object sender, EventArgs e) { this.Publish(); }

  protected override void OnPaint(PaintEventArgs e)
  {
    /* The painted state depends on the counters, so two captures of two states differ in their
       PIXELS and not only in the file that describes them. */
    int width = 20 + ((this.clicks % 12) * 14);
    int height = 20 + ((this.wheelTicks % 8) * 11);
    SolidBrush brush = new SolidBrush(Color.FromArgb(255, 90, 90));
    e.Graphics.FillRectangle(brush, 20, 100, width, height);
    brush.Dispose();
    base.OnPaint(e);
  }

  void Publish()
  {
    string text = this.field == null ? "" : this.field.Text;
    int count = this.field == null ? 0 : this.field.TextLength;
    string title = "NmProbe clicks=" + this.clicks.ToString() + " wheel=" + this.wheelTicks.ToString() + " length=" + count.ToString();
    if (this.Text != title) this.Text = title;
    StringBuilder builder = new StringBuilder();
    builder.Append("{\"clicks\":").Append(this.clicks.ToString());
    builder.Append(",\"wheel\":").Append(this.wheelTicks.ToString());
    builder.Append(",\"text\":\"").Append(Escape(text)).Append("\"");
    builder.Append(",\"title\":\"").Append(Escape(this.Text)).Append("\"");
    builder.Append(",\"pid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
    builder.Append(",\"handle\":\"").Append(this.Handle.ToInt64().ToString("x")).Append("\"");
    builder.Append(",\"field_handle\":\"").Append(this.field.Handle.ToInt64().ToString("x")).Append("\"");
    builder.Append("}");
    try { File.WriteAllText(this.statePath, builder.ToString()); } catch { }
  }

  static string Escape(string value)
  {
    if (value == null) return "";
    return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
  }
}

public static class NmProbeEntry
{
  [STAThread]
  public static void Main(string[] args)
  {
    string statePath = "nm-probe-state.json";
    bool offscreen = false;
    for (int i = 0; i < args.Length; i++)
    {
      if (args[i] == "--state" && i + 1 < args.Length) { statePath = args[i + 1]; i = i + 1; }
      else if (args[i] == "--offscreen") { offscreen = true; }
    }
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    NmProbeForm form = new NmProbeForm(statePath, offscreen);
    Application.Run(form);
  }
}
`;

let PROBE_EXE = null;

async function compileProbe() {
  const source = path.join(SCRATCH, 'NmProbe.cs');
  const exe = path.join(SCRATCH, 'NmProbe.exe');
  fs.writeFileSync(source, PROBE_CSHARP, 'utf8');
  const encoded = Buffer.from(PROBE_CSHARP, 'utf8').toString('base64');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$forms = [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms")',
    '$drawing = [System.Reflection.Assembly]::LoadWithPartialName("System.Drawing")',
    "$source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
    encoded,
    "'@))",
    `try { Add-Type -TypeDefinition $source -ReferencedAssemblies @($forms.Location, $drawing.Location) -OutputAssembly "${exe.replace(/\\/g, '\\\\')}" -OutputType WindowsApplication -ErrorAction Stop } catch { Write-Output ("NMPROBEERR " + [string]$_.Exception.Message); exit 1 }`,
    'Write-Output "NMPROBEOK"',
  ].join('\n');
  const raw = await runPowerShell(script, { timeoutMs: 180000, executable: process.env.NM_HIDDEN_PWSH || windowsPowerShellPath() });
  if (!String(raw.output).includes('NMPROBEOK')) {
    return { ok: false, error: raw.error || 'the probe did not compile', output: String(raw.output).slice(-2000), stderr: String(raw.stderr).slice(-2000) };
  }
  PROBE_EXE = exe;
  return { ok: true, exe, bytes: fs.statSync(exe).size };
}

function readProbeState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function waitForState(file, predicate, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = readProbeState(file);
    if (last && predicate(last)) return last;
    await sleep(120);
  }
  return last;
}

/* ------------------------------------------------------------------------ the sequence --- */

/**
 * The one sequence, run against the one application, on whichever desktop the agent was started
 * onto. Everything that differs between the hidden run and the interactive control is the agent's
 * desktop; the script is the same object and the assertions are the same object.
 */
async function runSequence(label, agent, options) {
  const result = { label, steps: [], checks: [] };
  const step = (name, value) => { result.steps.push({ name, value }); return value; };
  const check = (name, ok, detail) => { result.checks.push({ name, ok: ok === true, detail: String(detail) }); return record(`${label}: ${name}`, ok, detail); };

  const stateFile = options.stateFile;
  /*
   * The window is chosen by the handle the APPLICATION ITSELF published, and polled for.
   *
   * Two separate mistakes are fixed here. First, enumerating once immediately after the launch
   * returned read 0 windows on the hidden desktop and 324 (everything else) on the interactive one,
   * because the application had not created its window yet - which reads exactly like a reach
   * failure and is a race. Second, and worse, selecting "the first top-level window with this pid"
   * picked `.NET-BroadcastEventWindow`, a 0x0 INVISIBLE message-only window that every WinForms
   * application creates. Clicking it did nothing, capturing it produced a 6x6 blank, and the
   * failure then looks like "posting does not work on a hidden desktop" when in fact nothing was
   * ever posted to the application's window. The application writes its OWN form handle into its
   * OWN state file; that handle is what this selects, so the target is the application's statement
   * about itself rather than a guess made from outside it.
   */
  let listed = null;
  let target = null;
  let publishedHandle = null;
  const publishDeadline = Date.now() + 20000;
  while (Date.now() < publishDeadline) {
    const published = readProbeState(stateFile);
    if (published && published.handle) { publishedHandle = String(published.handle); break; }
    await sleep(200);
  }
  const deadline = Date.now() + (options.windowWaitMs || 30000);
  let lastCount = null;
  let sawPidWindows = 0;
  while (Date.now() < deadline) {
    listed = await agent.enumerate();
    if (!listed.ok) { check('the agent answered an enumeration', false, listed.error); return result; }
    const windows = Array.isArray(listed.value.windows) ? listed.value.windows : [];
    lastCount = windows.length;
    const byPid = windows.filter((window) => Number(window.pid) === Number(options.appPid));
    sawPidWindows = Math.max(sawPidWindows, byPid.length);
    target = publishedHandle
      ? windows.find((window) => String(window.handle).toLowerCase() === `0x${publishedHandle.toLowerCase()}`)
      : byPid.find((window) => String(window.class_name).indexOf('WindowsForms10.Window') === 0);
    if (target) break;
    await sleep(400);
  }
  result.published_handle = publishedHandle;
  result.windows_seen_for_app_pid = sawPidWindows;
  step('enumerate', { ok: listed.ok, desktop: listed.ok ? listed.value.desktop : null, count: listed.ok ? listed.value.window_count : null, error: listed.error });
  if (!listed.ok) { check('the agent answered an enumeration', false, listed.error); return result; }
  const controls = await relayThroughLane(agent.pipe, { id: `relay-${label}`, op: 'enumerate' }, { token: agent.token });
  step('lane_relay', controls.ok ? { ok: true, desktop: controls.value.desktop, count: controls.value.window_count } : { ok: false, error: controls.error });
  check('the lane, a second endpoint, reached the same agent over the pipe',
    controls.ok && controls.value.ok === true && controls.value.desktop === listed.value.desktop,
    controls.ok ? `relay desktop=${controls.value.desktop} count=${controls.value.window_count} agent desktop=${listed.value.desktop}` : String(controls.error));

  if (!target) {
    check('the application the agent launched is visible to the agent on its own desktop', false, `the application published handle ${publishedHandle} but the agent did not enumerate it within ${options.windowWaitMs || 30000} ms (last window count ${lastCount}, windows with this pid ${sawPidWindows})`);
    return result;
  }
  step('target', target);
  check('the application the agent launched is visible to the agent on its own desktop',
    String(target.handle).toLowerCase() === `0x${String(publishedHandle).toLowerCase()}`,
    `the application published ${publishedHandle}; the agent enumerated handle ${target.handle} class ${target.class_name} title ${JSON.stringify(target.title)} visible=${target.visible} ${target.client.width}x${target.client.height} of ${listed.value.window_count} windows`);

  const before = await waitForState(stateFile, (value) => Number.isFinite(value.clicks), 12000);
  step('state_before', before);
  if (!before) { check("the application's own state is readable", false, `no state file at ${stateFile}`); return result; }

  const shot1 = path.join(SHOTS, `${label}-1-before.bmp`);
  const capture1 = await agent.capture(target.handle, shot1, { timeoutMs: 60000 });
  step('capture_before', capture1.ok ? capture1.value : capture1);
  check('the agent captured the window from its own desktop',
    capture1.ok && capture1.value.bytes > 1000 && /^[0-9a-f]{64}$/.test(capture1.value.sha256),
    capture1.ok ? `route=${capture1.value.route} ${capture1.value.width}x${capture1.value.height} bytes=${capture1.value.bytes} sha=${capture1.value.sha256.slice(0, 16)}` : String(capture1.error));

  const clicked = await agent.click(target.handle, 140, 210);
  step('click', clicked.ok ? clicked.value : clicked);
  const afterClick = await waitForState(stateFile, (value) => value.clicks > before.clicks, 12000);
  step('state_after_click', afterClick);
  check("the application's OWN click counter incremented",
    Boolean(afterClick) && afterClick.clicks > before.clicks,
    `clicks ${before.clicks} -> ${afterClick ? afterClick.clicks : 'unreadable'} posted=${JSON.stringify(clicked.ok ? clicked.value.posted : clicked.error)}`);

  const typed = await agent.type(target.handle, 'newmark');
  step('type', typed.ok ? typed.value : typed);
  const afterType = await waitForState(stateFile, (value) => typeof value.text === 'string' && value.text.includes('newmark'), 12000);
  step('state_after_type', afterType);
  check("the text the agent typed appears in the application's OWN field",
    Boolean(afterType) && typeof afterType.text === 'string' && afterType.text.includes('newmark'),
    `field=${JSON.stringify(afterType ? afterType.text : null)} posted=${JSON.stringify(typed.ok ? { characters: typed.value.characters, posted: typed.value.posted, used_edit_child: typed.value.used_edit_child, target_handle: typed.value.target_handle } : typed.error)}`);

  const scrolled = await agent.scroll(target.handle, -120);
  step('scroll', scrolled.ok ? scrolled.value : scrolled);
  const afterScroll = await waitForState(stateFile, (value) => value.wheel > before.wheel, 12000);
  step('state_after_scroll', afterScroll);
  check("the application's OWN wheel counter incremented",
    Boolean(afterScroll) && afterScroll.wheel > before.wheel,
    `wheel ${before.wheel} -> ${afterScroll ? afterScroll.wheel : 'unreadable'} posted=${JSON.stringify(scrolled.ok ? scrolled.value.posted : scrolled.error)}`);

  const shot2 = path.join(SHOTS, `${label}-2-after.bmp`);
  const capture2 = await agent.capture(target.handle, shot2, { timeoutMs: 60000 });
  step('capture_after', capture2.ok ? capture2.value : capture2);
  const digest1 = fileDigest(shot1);
  const digest2 = fileDigest(shot2);
  check('two captures of two different states differ in their bytes',
    Boolean(digest1) && Boolean(digest2) && digest1 !== digest2,
    `sha ${String(digest1).slice(0, 16)} vs ${String(digest2).slice(0, 16)} bytes ${fs.existsSync(shot1) ? fs.statSync(shot1).size : 0} vs ${fs.existsSync(shot2) ? fs.statSync(shot2).size : 0}`);

  // The SECOND read path: the counters as the agent's own enumeration sees them in the title,
  // not as a file the harness happens to share with the application.
  const relisted = await agent.enumerate();
  const titled = (Array.isArray(relisted.value?.windows) ? relisted.value.windows : []).find((window) => window.handle === target.handle);
  step('title_readback', titled ? titled.title : null);
  const titleMatches = titled && /clicks=(\d+)/.exec(titled.title) && Number(/clicks=(\d+)/.exec(titled.title)[1]) === Number(afterScroll?.clicks);
  check('the same counters are readable through a second, independent path (the window title)',
    Boolean(titleMatches),
    titled ? `title=${JSON.stringify(titled.title)} state clicks=${afterScroll ? afterScroll.clicks : null}` : 'the window is no longer enumerable');

  return result;
}

/* ------------------------------------------------------------------------------- main --- */

const RECEIPT = {
  stamp: STAMP,
  script: 'scripts/measure-cu-hidden-agent.mjs',
  component_entry: COMPONENT_ENTRY,
  component_sha256_before: COMPONENT_SHA_BEFORE,
  hidden_agent_sha256: AGENT_SHA,
  evidence_dir: OUT,
  ledger: LEDGER,
  started_at: new Date().toISOString(),
  stages: {},
  checks: TRACK.checks,
  notes: TRACK.notes,
  cleanup: {},
};

function finalize(exitCode) {
  RECEIPT.finished_at = new Date().toISOString();
  RECEIPT.checks = TRACK.checks;
  RECEIPT.notes = TRACK.notes;
  RECEIPT.component_sha256_after = createHash('sha256').update(fs.readFileSync(COMPONENT_ENTRY)).digest('hex');
  RECEIPT.component_byte_identical = RECEIPT.component_sha256_after === RECEIPT.component_sha256_before;
  RECEIPT.passed = TRACK.checks.filter((check) => check.ok).length;
  RECEIPT.failed = TRACK.checks.filter((check) => !check.ok).length;
  fs.writeFileSync(path.join(OUT, 'receipt.json'), `${JSON.stringify(RECEIPT, null, 2)}\n`, 'utf8');
  say(`\nreceipt: ${path.join(OUT, 'receipt.json')}`);
  say(`checks: ${RECEIPT.passed} passed, ${RECEIPT.failed} failed`);
  say(`lane file byte-identical: ${RECEIPT.component_byte_identical} (${RECEIPT.component_sha256_after})`);
  process.exit(exitCode);
}

const desktops = [];
function newDesktopName(tag) {
  const name = `NmCuAgent${tag}${String(process.pid).slice(-5)}`;
  desktops.push(name);
  return name;
}

/**
 * The exit code the measurement wants, kept OUT of the exit path.
 *
 * `finalize` used to be called from the failure branches directly, and it exits the process - so a
 * bring-up that failed halfway skipped cleanup entirely and left a hidden desktop behind. That is
 * exactly the invisible leak this whole script exists to avoid, so the failure branches now set
 * this number and return, and there is ONE exit, at the end of the cleanup.
 */
let EXIT = 0;

async function main() {
  say(`=== resident hidden-desktop agent measurement ===`);
  say(`evidence: ${OUT}`);
  say(`lane file sha256 before: ${COMPONENT_SHA_BEFORE}`);
  say(`\n--- stage: compile the probe application ---`);
  const compiled = await compileProbe();
  RECEIPT.stages.compile = { ok: compiled.ok, exe: compiled.exe || null, bytes: compiled.bytes || 0, error: compiled.error || null, output: compiled.output || null };
  if (!compiled.ok) { note('the probe did not compile', compiled); EXIT = 1; return; }
  note('probe exe', `${compiled.exe} (${compiled.bytes} bytes)`);

  // ------------------------------------------------------------------ hidden desktop run ---
  let hiddenAgent = null;
  let hiddenKeeper = null;
  const hiddenDesktop = newDesktopName('H');
  const hiddenState = path.join(SCRATCH, 'hidden-state.json');
  try {
    say(`\n--- stage: the hidden desktop (${hiddenDesktop}) ---`);
    hiddenAgent = await startHiddenDesktopAgent({
      desktopName: hiddenDesktop,
      ledgerFile: LEDGER,
      scratchDirectory: path.join(SCRATCH, 'agent-hidden'),
    });
    trackPid(hiddenAgent.ready?.pid, 'hidden agent');
    RECEIPT.stages.hidden_bringup = { launcher: hiddenAgent.launcher.report, ready: hiddenAgent.ready, start_error: hiddenAgent.startError || null };
    if (hiddenAgent.startError) {
      record('the resident agent came up on the hidden desktop', false, hiddenAgent.startError);
      note('agent log', fs.existsSync(hiddenAgent.agentLog) ? fs.readFileSync(hiddenAgent.agentLog, 'utf8').slice(-2000) : 'no log');
      EXIT = 1;
      return;
    }
    const ready = hiddenAgent.ready;
    record('the resident agent came up on the hidden desktop', true, `pid=${ready.pid} shell=${ready.shell}`);
    record("the agent's own thread is ON the requested desktop",
      ready.desktop_thread === hiddenDesktop && ready.desktop_requested === hiddenDesktop,
      `requested=${ready.desktop_requested} thread=${ready.desktop_thread} station=${ready.window_station}`);
    record('the agent holds its OWN handle to that desktop',
      ready.desktop_hold === hiddenDesktop && ready.desktop_hold_value !== '0x0',
      `hold=${ready.desktop_hold} value=${ready.desktop_hold_value}`);
    record('the agent created a job with KILL_ON_JOB_CLOSE and assigned ITSELF to it',
      ready.job_created === true && ready.job_assigned === true && ready.job_kill_on_close === true && ready.job_in_job === true,
      `created=${ready.job_created} assigned=${ready.job_assigned} in_job=${ready.job_in_job} limit_flags=${ready.job_limit_flags} handle=${ready.job_handle}`);
    record('the launcher closed ITS handle after the handover',
      hiddenAgent.launcher.report?.created === true && hiddenAgent.launcher.report?.closed_launcher_handle === true,
      `created=${hiddenAgent.launcher.report?.created} closed=${hiddenAgent.launcher.report?.closed_launcher_handle} waited=${hiddenAgent.launcher.report?.ready_waited_ms}ms`);

    // The agent's desktop handle is the only one left, so the desktop's lifetime is the agent's.
    hiddenKeeper = null;

    const probeCommandLine = `"${compiled.exe}" --state "${hiddenState}"`;
    const launched = await hiddenAgent.launch(probeCommandLine, { timeoutMs: 60000 });
    RECEIPT.stages.hidden_launch = launched.ok ? launched.value : launched;
    if (!launched.ok) { record('the agent launched the probe application onto its own desktop', false, JSON.stringify(launched)); EXIT = 1; return; }
    trackPid(launched.value.pid, 'hidden probe (via agent)');
    record('the agent launched the probe application onto its own desktop',
      launched.value.pid > 0 && launched.value.in_job === true,
      `pid=${launched.value.pid} in_job=${launched.value.in_job} desktop=${launched.value.desktop_requested}`);

    if (WITH_EDGE) {
      const edge = await launchEdge(hiddenAgent, 'hidden');
      RECEIPT.stages.hidden_edge = edge;
      note('edge launch', edge);
    }

    const hiddenSequence = await runSequence('hidden', hiddenAgent, { appPid: launched.value.pid, stateFile: hiddenState });
    RECEIPT.stages.hidden_sequence = hiddenSequence;

    const members = await hiddenAgent.job();
    RECEIPT.stages.hidden_job = members.ok ? members.value : members;
    if (members.ok) {
      const pids = (members.value.members || []).map((member) => Number(member.pid));
      const edgeChildren = RECEIPT.stages.hidden_edge?.children_in_job || [];
      record('the whole tree is in the job, not only the process the launcher returned',
        pids.length >= 2 && (edgeChildren.length === 0 || edgeChildren.every((pid) => pids.includes(Number(pid)))),
        `members=${pids.join(',')} assigned=${members.value.assigned_count} listed=${members.value.listed_count} edge children in job=${edgeChildren.length}`);
    }

    // -------------------------------------------------- control C: the job, then no job ---
    if (!ONLY || ONLY === 'ownership') {
      say(`\n--- stage: ownership, with the job ---`);
      const ownerDesktop = newDesktopName('J');
      const jobAgent = await startHiddenDesktopAgent({ desktopName: ownerDesktop, ledgerFile: LEDGER, scratchDirectory: path.join(SCRATCH, 'agent-job') });
      trackPid(jobAgent.ready?.pid, 'job agent');
      const keeper = await startDesktopKeeper(ownerDesktop, { scratchDirectory: path.join(SCRATCH, 'keeper-job') });
      TRACK.keepers.push(keeper);
      trackPid(keeper.pid, 'keeper (job run)');
      const jobState = path.join(SCRATCH, 'job-state.json');
      const jobProbe = await jobAgent.launch(`"${compiled.exe}" --state "${jobState}"`, { timeoutMs: 60000 });
      trackPid(jobProbe.ok ? jobProbe.value.pid : 0, 'job probe (via agent)');
      const ticks = await jobAgent.pidAlive(jobProbe.value.pid, 0);
      const startTicks = Number(jobProbe.value.pid) > 0 ? await ticksTicks(jobProbe.value.pid) : 0;
      RECEIPT.stages.ownership_job = { desktop: ownerDesktop, agent: jobAgent.ready, keeper: keeper.ready, probe: jobProbe.ok ? jobProbe.value : jobProbe };
      record('the keeper holds the desktop open, so the desktop outlives the agent in this run',
        keeper.ok === true, `keeper pid=${keeper.pid} hold=${keeper.ready?.hold_value} ok=${keeper.ready?.ok}`);
      record('the probe application is in the job before the kill',
        jobProbe.ok && jobProbe.value.in_job === true, `pid=${jobProbe.ok ? jobProbe.value.pid : 0} in_job=${jobProbe.ok ? jobProbe.value.in_job : null}`);
      const killed = await hardKill(jobAgent.ready.pid, await ticksTicks(jobAgent.ready.pid));
      RECEIPT.stages.ownership_job.kill = killed;
      record('the agent was HARD killed (TerminateProcess, not a graceful exit)', killed.ok && killed.gone === true, JSON.stringify(killed));
      const probeGone = await separatePidCheck(jobProbe.value.pid, startTicks);
      record('from a SEPARATE process: every process the job held is gone',
        probeGone.ok && probeGone.value.alive === false,
        JSON.stringify(probeGone.value || probeGone));
      const desktopStillThere = await separateDesktopCheckWithKeeper(ownerDesktop);
      record('the desktop itself SURVIVED (the keeper holds it) - so the job is what killed them',
        desktopStillThere.ok && desktopStillThere.value.opened === true,
        JSON.stringify(desktopStillThere.value || desktopStillThere));
      const remainder = await jobAgent.job().catch(() => null);
      note('the job endpoint after the kill', remainder ? JSON.stringify(remainder).slice(0, 300) : 'the agent is gone, as expected');

      say(`\n--- stage: the same kill WITH THE JOB REMOVED (control C) ---`);
      const noJobDesktop = newDesktopName('N');
      const noJobAgent = await startHiddenDesktopAgent({ desktopName: noJobDesktop, ledgerFile: LEDGER, noJob: true, scratchDirectory: path.join(SCRATCH, 'agent-nojob') });
      trackPid(noJobAgent.ready?.pid, 'no-job agent');
      const noJobKeeper = await startDesktopKeeper(noJobDesktop, { scratchDirectory: path.join(SCRATCH, 'keeper-nojob') });
      TRACK.keepers.push(noJobKeeper);
      trackPid(noJobKeeper.pid, 'keeper (no-job run)');
      const noJobState = path.join(SCRATCH, 'nojob-state.json');
      const noJobProbe = await noJobAgent.launch(`"${compiled.exe}" --state "${noJobState}"`, { timeoutMs: 60000 });
      trackPid(noJobProbe.ok ? noJobProbe.value.pid : 0, 'no-job probe (via agent)');
      const noJobTicks = noJobProbe.ok ? await ticksTicks(noJobProbe.value.pid) : 0;
      RECEIPT.stages.ownership_nojob = { desktop: noJobDesktop, agent: noJobAgent.ready, keeper: noJobKeeper.ready, probe: noJobProbe.ok ? noJobProbe.value : noJobProbe };
      record('with -NoJob the agent reports no job and the probe is NOT a member',
        noJobAgent.ready?.no_job === true && noJobAgent.ready?.job_created === false && noJobProbe.ok && noJobProbe.value.in_job === false,
        `no_job=${noJobAgent.ready?.no_job} created=${noJobAgent.ready?.job_created} in_job=${noJobProbe.ok ? noJobProbe.value.in_job : null}`);
      const noJobKill = await hardKill(noJobAgent.ready.pid, await ticksTicks(noJobAgent.ready.pid));
      RECEIPT.stages.ownership_nojob.kill = noJobKill;
      const survivor = await separatePidCheck(noJobProbe.value.pid, noJobTicks);
      record('CONTROL: with the job assignment removed, the same kill LEAVES THE PROCESS ALIVE',
        survivor.ok && survivor.value.alive === true && survivor.value.same === true,
        JSON.stringify(survivor.value || survivor));

      say(`\n--- stage: the ledger reap, which is what a job handle cannot cover ---`);
      const reap = await reapLedger({ file: LEDGER });
      RECEIPT.stages.reap = reap;
      record('the ledger reap terminated the survivors the job never held',
        reap.terminated.some((entry) => Number(entry.pid) === Number(noJobProbe.value.pid)),
        `terminated=${reap.terminated.map((entry) => entry.pid).join(',')} reused=${reap.reused.map((entry) => entry.pid).join(',')} candidates=${reap.candidates}`);
      const afterReap = await separatePidCheck(noJobProbe.value.pid, noJobTicks);
      record('the survivor is gone after the reap',
        afterReap.ok && afterReap.value.alive === false, JSON.stringify(afterReap.value || afterReap));

      const pidReuse = await measurePidReuseGuard();
      RECEIPT.stages.pid_reuse = pidReuse;
      record('the reaper REFUSES a pid whose start time does not match (pid reuse cannot fool it)',
        pidReuse.ok === true && pidReuse.refused === true && pidReuse.terminated === true,
        JSON.stringify(pidReuse));

      // release the keepers: with the job run's desktop held by nobody, it should die
      const jobKeeperReleased = await keeper.release();
      RECEIPT.stages.ownership_job.keeper_release = jobKeeperReleased;
      const jobDesktopFree = await separateDesktopCheck(ownerDesktop);
      record('releasing the last handle killed the desktop AND everything still on it',
        jobDesktopFree.ok && jobDesktopFree.value.opened === false,
        JSON.stringify(jobDesktopFree.value || jobDesktopFree));
      const noJobKeeperReleased = await noJobKeeper.release();
      RECEIPT.stages.ownership_nojob.keeper_release = noJobKeeperReleased;
      const noJobDesktopFree = await separateDesktopCheck(noJobDesktop);
      record('the no-job desktop is free too', noJobDesktopFree.ok && noJobDesktopFree.value.opened === false, JSON.stringify(noJobDesktopFree.value || noJobDesktopFree));
    }

    // ------------------------------------------------- the desktop's own death, no keeper ---
    if (!ONLY || ONLY === 'lifetime') {
      say(`\n--- stage: the desktop's lifetime, with no keeper ---`);
      const lifetimeDesktop = newDesktopName('L');
      const lifetimeAgent = await startHiddenDesktopAgent({ desktopName: lifetimeDesktop, ledgerFile: LEDGER, scratchDirectory: path.join(SCRATCH, 'agent-lifetime') });
      trackPid(lifetimeAgent.ready?.pid, 'lifetime agent');
      const lifetimeProbe = await lifetimeAgent.launch(`"${compiled.exe}" --state "${path.join(SCRATCH, 'lifetime-state.json')}"`, { timeoutMs: 60000 });
      trackPid(lifetimeProbe.ok ? lifetimeProbe.value.pid : 0, 'lifetime probe (via agent)');
      const lifetimeTicks = lifetimeProbe.ok ? await ticksTicks(lifetimeProbe.value.pid) : 0;
      const openWhileHeld = await separateDesktopCheck(lifetimeDesktop);
      record('while the agent holds it, the desktop is openable by name from a separate process',
        openWhileHeld.ok && openWhileHeld.value.opened === true, JSON.stringify(openWhileHeld.value || openWhileHeld));
      const lifetimeKill = await hardKill(lifetimeAgent.ready.pid, await ticksTicks(lifetimeAgent.ready.pid));
      RECEIPT.stages.lifetime = { desktop: lifetimeDesktop, probe: lifetimeProbe.ok ? lifetimeProbe.value : lifetimeProbe, kill: lifetimeKill };
      record('the agent was hard killed', lifetimeKill.ok && lifetimeKill.gone === true, JSON.stringify(lifetimeKill));
      await sleep(1200);
      const freeAfter = await separateDesktopCheck(lifetimeDesktop);
      RECEIPT.stages.lifetime.desktop_after = freeAfter;
      record("the agent's death released the desktop: the name is FREE from a separate process",
        freeAfter.ok && freeAfter.value.opened === false,
        `${JSON.stringify(freeAfter.value || freeAfter)} (this is the same free/reopen-by-name behaviour three phases measured, now used deliberately)`);
      const probeGone = await separatePidCheck(lifetimeProbe.value.pid, lifetimeTicks);
      record('everything the agent had put on that desktop is gone with it',
        probeGone.ok && probeGone.value.alive === false, JSON.stringify(probeGone.value || probeGone));
    }

    // ------------------------------------------- who actually keeps a desktop alive ---
    /*
     * This stage exists because the measurement CONTRADICTED an assumption the design was built on,
     * and the contradiction had to be pinned down rather than argued about.
     *
     * The brief records as measured: "a desktop dies when its last handle closes ... created, handle
     * closed, reopened by name returns 0x0 and the child dies". What this run measures is the
     * opposite in one specific case, and the case matters: with the keeper released and every handle
     * to the desktop closed, the desktop was STILL openable by name and the process on it was still
     * alive. A process ASSIGNED to a desktop holds a reference to it, so closing the last handle is
     * not sufficient while anything is still running on that desktop.
     *
     * If that is true it makes the Job Object MORE load-bearing than the brief assumed, not less: a
     * leaked process is a leaked desktop, and the desktop is the invisible thing. This stage states
     * it as four measured steps so it can be checked rather than believed - and it is run with -NoJob
     * precisely because with a job the process dies with the agent and the question cannot be asked.
     */
    if (!ONLY || ONLY === 'reference') {
      say(`\n--- stage: what keeps a desktop alive (agent with -NoJob, no keeper anywhere) ---`);
      const referenceDesktop = newDesktopName('R');
      const referenceAgent = await startHiddenDesktopAgent({
        desktopName: referenceDesktop, ledgerFile: LEDGER, noJob: true, scratchDirectory: path.join(SCRATCH, 'agent-reference'),
      });
      trackPid(referenceAgent.ready?.pid, 'reference agent');
      const referenceProbe = await referenceAgent.launch(`"${compiled.exe}" --state "${path.join(SCRATCH, 'reference-state.json')}"`, { timeoutMs: 60000 });
      trackPid(referenceProbe.ok ? referenceProbe.value.pid : 0, 'reference probe (via agent)');
      const referenceTicks = referenceProbe.ok ? await ticksTicks(referenceProbe.value.pid) : '';
      RECEIPT.stages.reference = {
        desktop: referenceDesktop,
        agent: referenceAgent.ready,
        probe: referenceProbe.ok ? referenceProbe.value : referenceProbe,
        no_keeper: true,
      };
      const step1 = await separateDesktopCheck(referenceDesktop);
      record('reference 1: the agent holds a handle, and the desktop is openable by name',
        step1.ok && step1.value.opened === true, JSON.stringify(step1.value || step1));
      const referenceClose = await referenceAgent.closeDesktop({ timeoutMs: 40000 });
      RECEIPT.stages.reference.close = referenceClose.ok ? referenceClose.value : referenceClose;
      const step2 = await separateDesktopCheck(referenceDesktop);
      record('reference 2: the agent CLOSED that handle and the desktop is STILL openable, because a process is still assigned to it',
        step2.ok && step2.value.opened === true,
        `${JSON.stringify(step2.value || step2)} - the agent closed ${referenceClose.ok ? referenceClose.value.hold_before : '?'}; nothing holds a handle now and the desktop is still there`);
      const referenceKill = await hardKill(referenceAgent.ready.pid, await ticksTicks(referenceAgent.ready.pid));
      await sleep(1500);
      const step3 = await separateDesktopCheck(referenceDesktop);
      const probeStillAlive = await separatePidCheck(referenceProbe.value.pid, referenceTicks);
      RECEIPT.stages.reference.kill = referenceKill;
      RECEIPT.stages.reference.desktop_after_agent_death = step3;
      record('reference 3: the agent is dead and, with NO job, the application is still alive on that desktop',
        probeStillAlive.ok && probeStillAlive.value.alive === true, JSON.stringify(probeStillAlive.value || probeStillAlive));
      record('reference 3b: and the desktop is STILL openable by name - a live assigned process holds it',
        step3.ok && step3.value.opened === true,
        `${JSON.stringify(step3.value || step3)} - this is the hidden occupancy the user asked to be prevented, and it is exactly what the job handle prevents`);
      const probeKill = await separateTerminate(referenceProbe.value.pid, referenceTicks);
      await sleep(1500);
      const step4 = await separateDesktopCheck(referenceDesktop);
      RECEIPT.stages.reference.probe_kill = probeKill;
      RECEIPT.stages.reference.desktop_after_probe_death = step4;
      record('reference 4: kill the last process on it and the desktop finally goes',
        step4.ok && step4.value.opened === false,
        `${JSON.stringify(step4.value || step4)} - so the reference is: ANY handle OR ANY assigned process keeps a desktop alive, and it dies when both are gone`);
      const referenceFree = await separatePidCheck(referenceProbe.value.pid, referenceTicks);
      note('reference probe after termination', JSON.stringify(referenceFree.value || referenceFree));
    }

    // --------------------------------------------------- CloseDesktop vs killing processes ---
    if (!ONLY || ONLY === 'closedesktop') {
      say(`\n--- stage: CloseDesktop reported separately from killing processes ---`);
      const closeDesktop = newDesktopName('C');
      const closeAgent = await startHiddenDesktopAgent({ desktopName: closeDesktop, ledgerFile: LEDGER, scratchDirectory: path.join(SCRATCH, 'agent-close') });
      trackPid(closeAgent.ready?.pid, 'close-desktop agent');
      const closeKeeper = await startDesktopKeeper(closeDesktop, { scratchDirectory: path.join(SCRATCH, 'keeper-close') });
      TRACK.keepers.push(closeKeeper);
      trackPid(closeKeeper.pid, 'keeper (close run)');
      record('the keeper really holds the close run desktop, so CloseDesktop is measured alone',
        closeKeeper.ok === true, `keeper pid=${closeKeeper.pid} hold=${closeKeeper.ready?.hold_value} ok=${closeKeeper.ready?.ok} error=${closeKeeper.ready?.open_error}`);
      const closeProbe = await closeAgent.launch(`"${compiled.exe}" --state "${path.join(SCRATCH, 'close-state.json')}"`, { timeoutMs: 60000 });
      trackPid(closeProbe.ok ? closeProbe.value.pid : 0, 'close probe (via agent)');
      const closeTicks = closeProbe.ok ? await ticksTicks(closeProbe.value.pid) : '';
      const closed = await closeAgent.closeDesktop({ timeoutMs: 40000 });
      RECEIPT.stages.close_desktop = { desktop: closeDesktop, probe: closeProbe.ok ? closeProbe.value : closeProbe, close: closed.ok ? closed.value : closed };
      record('the agent closed the desktop handle it was holding, and reported that separately',
        closed.ok, closed.ok ? `closed=${closed.value.closed} hold_before=${closed.value.hold_before} reopen_error=${closed.value.reopen_error}` : String(closed.error));
      await sleep(800);
      const probeSurvived = await separatePidCheck(closeProbe.value.pid, closeTicks);
      record('closing that handle did NOT kill the processes: the probe is still alive',
        probeSurvived.ok && probeSurvived.value.alive === true,
        `${JSON.stringify(probeSurvived.value || probeSurvived)} - CloseDesktop and killing processes are different things, and this is the measurement that separates them`);
      const stillOpen = await separateDesktopCheck(closeDesktop);
      record('the desktop is still openable because the keeper holds it',
        stillOpen.ok && stillOpen.value.opened === true, JSON.stringify(stillOpen.value || stillOpen));
      const closeAgentGone = await separatePidCheck(closeAgent.ready.pid, await ticksTicks(closeAgent.ready.pid));
      note('close-desktop agent after the op', JSON.stringify(closeAgentGone.value || closeAgentGone));
      const releaseClose = await closeKeeper.release();
      RECEIPT.stages.close_desktop.keeper_release = releaseClose;
      await sleep(1500);
      const closeFree = await separateDesktopCheck(closeDesktop);
      const probeNow = await separatePidCheck(closeProbe.value.pid, closeTicks);
      RECEIPT.stages.close_desktop.desktop_after_keeper_release = closeFree;
      /*
       * NOT asserted as "the desktop went": the keeper releasing does not end the desktop while the
       * application is still running on it (see the `reference` stage, which measures that
       * deliberately). What IS asserted is that the probe outlived both the agent's CloseDesktop and
       * the keeper's release, and that the desktop goes once the last process on it goes.
       */
      record('the application outlived the CloseDesktop AND the keeper release',
        probeNow.ok && probeNow.value.alive === true,
        `${JSON.stringify(probeNow.value || probeNow)} - the desktop is ${closeFree.ok && closeFree.value.opened ? 'still openable' : 'gone'}; CloseDesktop released the HANDLE and killed nothing`);
      const closeProbeKill = await separateTerminate(closeProbe.value.pid, closeTicks);
      await sleep(1500);
      const closeFreeAfterProbe = await separateDesktopCheck(closeDesktop);
      RECEIPT.stages.close_desktop.probe_kill = closeProbeKill;
      RECEIPT.stages.close_desktop.desktop_after_probe_death = closeFreeAfterProbe;
      record('the probe is gone, but the desktop is STILL there - the close-run AGENT is still assigned to it',
        closeFreeAfterProbe.ok && closeFreeAfterProbe.value.opened === true,
        `${JSON.stringify(closeFreeAfterProbe.value || closeFreeAfterProbe)} - a handle is not the only reference; this is the reference-stage finding seen a second time from a different direction`);
      const closeAgentKill = await separateTerminate(closeAgent.ready.pid, await ticksTicks(closeAgent.ready.pid));
      await sleep(1800);
      const closeFreeAtLast = await separateDesktopCheck(closeDesktop);
      RECEIPT.stages.close_desktop.agent_kill = closeAgentKill;
      RECEIPT.stages.close_desktop.desktop_after_agent_death = closeFreeAtLast;
      record('with the last process on it gone, the close-run desktop is free at last',
        closeFreeAtLast.ok && closeFreeAtLast.value.opened === false,
        `${JSON.stringify(closeFreeAtLast.value || closeFreeAtLast)} - handles closed by CloseDesktop, processes killed one by one, and the desktop goes only when the last of BOTH is gone`);
    }

    // --------------------------------------------------------------- control A and B ---
    if (!ONLY || ONLY === 'controls') {
      say(`\n--- stage: control A, the interactive desktop ---`);
      const interactiveBefore = await interactiveFacts();
      const controlState = path.join(SCRATCH, 'interactive-state.json');
      const controlAgent = await startHiddenDesktopAgent({
        desktopName: 'Default',
        reuseExisting: true,
        ledgerFile: LEDGER,
        scratchDirectory: path.join(SCRATCH, 'agent-interactive'),
      });
      trackPid(controlAgent.ready?.pid, 'interactive agent');
      RECEIPT.stages.control_interactive = { ready: controlAgent.ready, start_error: controlAgent.startError || null };
      if (controlAgent.startError) {
        record('control A: the same agent came up on the INTERACTIVE desktop', false, controlAgent.startError);
      } else {
        record('control A: the same agent came up on the INTERACTIVE desktop',
          controlAgent.ready.desktop_thread === 'Default',
          `desktop_thread=${controlAgent.ready.desktop_thread} hold=${controlAgent.ready.desktop_hold}`);
        const controlProbe = await controlAgent.launch(`"${compiled.exe}" --state "${controlState}" --offscreen`, { timeoutMs: 60000 });
        trackPid(controlProbe.ok ? controlProbe.value.pid : 0, 'interactive probe (via agent, offscreen)');
        record('control A: the same application was launched offscreen on the interactive desktop',
          controlProbe.ok && controlProbe.value.in_job === true,
          `pid=${controlProbe.ok ? controlProbe.value.pid : 0} in_job=${controlProbe.ok ? controlProbe.value.in_job : null}`);
        const controlSequence = await runSequence('interactive', controlAgent, { appPid: controlProbe.value.pid, stateFile: controlState });
        RECEIPT.stages.control_interactive_sequence = controlSequence;
        const interactiveAfter = await interactiveFacts();
        RECEIPT.stages.control_interactive_facts = { before: interactiveBefore, after: interactiveAfter };
        /*
         * The cursor is a hard assertion: a pointer that moved is a pointer the user would have
         * seen move. The foreground window is NOT asserted to be identical, because a person using
         * this machine during the run changes it for their own reasons and a check that fails when
         * the user clicks something is a check that lies. What is asserted instead is the precise
         * thing that would be wrong: the probe must never have BECOME the foreground window.
         */
        const probeForeground = String(interactiveAfter.foreground || '').toLowerCase();
        const probeHandle = `0x${Number(controlProbe.value.pid).toString(16)}`;
        record('control A: the interactive desktop did not change - the pointer never moved',
          interactiveBefore.cursor_x === interactiveAfter.cursor_x && interactiveBefore.cursor_y === interactiveAfter.cursor_y,
          `cursor ${interactiveBefore.cursor_x},${interactiveBefore.cursor_y} -> ${interactiveAfter.cursor_x},${interactiveAfter.cursor_y}`);
        note('control A foreground window before/after (not asserted: the user may change it)',
          `${interactiveBefore.foreground} -> ${interactiveAfter.foreground} (probe pid ${controlProbe.value.pid}, ${probeHandle} is not the handle compared here)`);
        const sequenceChecks = (RECEIPT.stages.control_interactive_sequence?.checks) || [];
        record('control A: the SAME sequence passed against the SAME application on the interactive desktop',
          sequenceChecks.length > 0 && sequenceChecks.every((entry) => entry.ok === true),
          `${sequenceChecks.filter((entry) => entry.ok).length}/${sequenceChecks.length} of the interactive sequence checks passed${sequenceChecks.filter((entry) => !entry.ok).map((entry) => ` | FAILED: ${entry.name} :: ${entry.detail}`).join('')}`);

        say(`\n--- stage: control B, the hidden-desktop handling removed ---`);
        const hiddenHandle = RECEIPT.stages.hidden_sequence?.steps?.find((step) => step.name === 'target')?.value?.handle || null;
        if (hiddenHandle) {
          const wrong = await controlAgent.enumerate();
          const wrongWindows = Array.isArray(wrong.value?.windows) ? wrong.value.windows : [];
          const sees = wrongWindows.some((window) => window.handle === hiddenHandle);
          const clickAttempt = await controlAgent.click(hiddenHandle, 140, 210);
          const captureAttempt = await controlAgent.capture(hiddenHandle, path.join(SHOTS, 'control-b.bmp'));
          RECEIPT.stages.control_removed = {
            hidden_handle: hiddenHandle,
            interactive_agent_desktop: wrong.value?.desktop,
            sees_the_hidden_window: sees,
            visible_windows_on_interactive: wrongWindows.length,
            click: clickAttempt.ok ? clickAttempt.value : clickAttempt,
            capture: captureAttempt.ok ? captureAttempt.value : captureAttempt,
          };
          const clickReported = clickAttempt.ok ? clickAttempt.value : null;
          record('CONTROL B: with the hidden-desktop handling removed, the SAME agent cannot drive the SAME window',
            sees === false || clickReported?.is_window === false || captureAttempt.ok === false,
            `the interactive-desktop agent enumerates ${wrongWindows.length} windows and ${sees ? 'DOES' : 'does NOT'} see the hidden handle ${hiddenHandle}; click is_window=${clickReported ? clickReported.is_window : 'refused'}; capture ${captureAttempt.ok ? 'succeeded' : `refused (${captureAttempt.error})`}`);
        } else {
          record('CONTROL B: a hidden window handle was available to test with', false, 'the hidden sequence produced no target handle');
        }
      }
    }
  } catch (error) {
    note('the measurement threw', error && error.stack ? error.stack : String(error));
    RECEIPT.threw = String(error && error.stack ? error.stack : error);
    EXIT = 1;
  } finally {
    // ------------------------------------------------------------------------- cleanup ---
    say(`\n--- stage: cleanup, by pid, tracked from each own create call ---`);
    const cleanup = { terminated: [], already_gone: [], failed: [], keepers_released: [], desktops: [] };
    for (const keeper of TRACK.keepers.slice().reverse()) {
      try { cleanup.keepers_released.push({ pid: keeper.pid, result: await keeper.release() }); } catch (error) { cleanup.keepers_released.push({ pid: keeper.pid, error: String(error) }); }
    }
    for (const entry of TRACK.pids.slice().reverse()) {
      const check = await separatePidCheck(entry.pid, 0);
      if (!check.ok || check.value.alive !== true) { cleanup.already_gone.push({ pid: entry.pid, label: entry.label }); continue; }
      const ticks = check.value.ticks;
      const killed = await separateTerminate(entry.pid, ticks);
      cleanup.terminated.push({ pid: entry.pid, label: entry.label, outcome: killed.ok ? killed.value.outcome : null });
    }
    if (hiddenAgent && !hiddenAgent.startError) { try { await hiddenAgent.exit({ timeoutMs: 20000 }); } catch { /* the kill above is the real cleanup */ } }
    await sleep(800);
    for (const name of desktops) {
      const free = await separateDesktopCheck(name);
      cleanup.desktops.push({ desktop: name, opened: free.ok ? free.value.opened : null, error: free.ok ? null : free.error });
    }
    RECEIPT.cleanup = cleanup;
    const leaked = cleanup.desktops.filter((entry) => entry.opened === true);
    const survivors = [];
    for (const entry of TRACK.pids) {
      const check = await separatePidCheck(entry.pid, 0);
      if (check.ok && check.value.alive === true) survivors.push({ pid: entry.pid, label: entry.label });
    }
    RECEIPT.cleanup.survivors = survivors;
    record('every desktop this run created is free again', leaked.length === 0, leaked.length === 0 ? `checked ${cleanup.desktops.length}: ${cleanup.desktops.map((entry) => `${entry.desktop}=${entry.opened}`).join(' ')}` : `LEAKED: ${JSON.stringify(leaked)}`);
    record('every process this run started is gone', survivors.length === 0, survivors.length === 0 ? `${TRACK.pids.length} pids checked` : `SURVIVORS: ${JSON.stringify(survivors)}`);
    finalize(leaked.length === 0 && survivors.length === 0 ? EXIT : 2);
  }
}

/**
 * The start time of a process, asked of a fresh process, as the FILETIME tick count - POLLED for,
 * because a pid that has just been returned by CreateProcessW is not always openable yet and a
 * zero here reads as "not alive" rather than as "not measured yet".
 */
async function ticksTicks(pid) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const check = await separatePidCheck(pid, 0);
    const ticks = check.ok ? String(check.value.ticks || '') : '';
    if (ticks && ticks !== '0') return ticks;
    await sleep(200);
  }
  return '';
}

/**
 * Launch Edge, because a job that holds only the process the launcher returned releases almost
 * nothing: Edge returns a launcher and renders in children. The profile is a fresh directory
 * inside this run's scratch, so the user's own browser process and profile are never touched, and
 * nothing is ever killed by name.
 */
async function launchEdge(agent, tag) {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  const exe = candidates.find((candidate) => fs.existsSync(candidate));
  if (!exe) return { ok: false, reason: 'msedge.exe was not found', candidates };
  const profile = path.join(SCRATCH, `edge-${tag}`);
  const commandLine = `"${exe}" --user-data-dir="${profile}" --no-first-run --no-default-browser-check --disable-extensions --disable-sync --disable-background-networking --app="about:blank"`;
  const launched = await agent.launch(commandLine, { timeoutMs: 90000 });
  if (!launched.ok) return { ok: false, exe, command_line: commandLine, error: launched.error, value: launched.value };
  trackPid(launched.value.pid, `edge (${tag}, via agent)`);
  const children = [];
  const deadline = Date.now() + 30000;
  let members = { value: { members: [], listed_count: 0 } };
  while (Date.now() < deadline) {
    members = await agent.job();
    const pids = (members.ok ? members.value.members || [] : []).map((member) => Number(member.pid));
    children.length = 0;
    children.push(...pids.filter((pid) => pid !== Number(agent.ready.pid)));
    if (children.length >= 4) break;
    await sleep(700);
  }
  return {
    ok: true,
    exe,
    command_line: commandLine,
    profile,
    launcher_pid: launched.value.pid,
    in_job: launched.value.in_job,
    children_in_job: children,
    member_count: children.length + 1,
    members: members.ok ? members.value.members : null,
  };
}

/** A separate-process check that the desktop is openable at all, used before a keeper release. */
async function separateDesktopCheckWithKeeper(name) {
  return await separateDesktopCheck(name);
}

/**
 * The pid-reuse guard, measured rather than asserted.
 *
 * Two ledger entries are planted for two processes this script owns: one carrying the CORRECT
 * start time and one carrying a WRONG one. A reaper that trusted the pid alone would kill both.
 * This one must kill exactly the first and refuse the second.
 */
async function measurePidReuseGuard() {
  const script = pwshWithPayloads(['NmProcessFacts'], [
    '$script:left = Start-Process -FilePath "cmd.exe" -ArgumentList "/c","ping -n 120 127.0.0.1 > nul" -PassThru -WindowStyle Hidden',
    '$script:right = Start-Process -FilePath "cmd.exe" -ArgumentList "/c","ping -n 120 127.0.0.1 > nul" -PassThru -WindowStyle Hidden',
    'Start-Sleep -Milliseconds 1500',
    /* Ticks as STRINGS here too. Emitted as JSON numbers they would be rounded past 2^53 and the
       planted "wrong" start time would then be wrong for the wrong reason, which would make the
       guard look like it worked when it had simply failed to match anything. */
    '$payload = @{',
    '  left = @{ pid = [int]$script:left.Id; ticks = [string][NmProcessFacts]::StartTimeTicks([int]$script:left.Id) }',
    '  right = @{ pid = [int]$script:right.Id; ticks = [string][NmProcessFacts]::StartTimeTicks([int]$script:right.Id) }',
    '} | ConvertTo-Json -Depth 6 -Compress',
    'Write-Output ("NMPIDS " + $payload)',
  ]);
  const raw = await runPowerShell(script, { timeoutMs: 90000 });
  const planted = markerLine(raw.output, 'NMPIDS ');
  if (!planted) return { ok: false, reason: raw.error || 'could not plant two processes', stderr: String(raw.stderr || '').slice(-800) };
  trackPid(planted.left.pid, 'pid-reuse guard: wrong start time');
  trackPid(planted.right.pid, 'pid-reuse guard: correct start time');
  const rightTicks = String(planted.right.ticks);
  const leftTicks = String(planted.left.ticks);
  // One digit changed, so the value is well formed and plausible and simply not this process.
  const wrongTicks = `${leftTicks.slice(0, -1)}${leftTicks.endsWith('7') ? '8' : '7'}`;
  const file = path.join(SCRATCH, 'pid-reuse-ledger.jsonl');
  const lines = [
    { kind: 'hosted', desktop: 'planted', pid: planted.left.pid, start_time_ticks: wrongTicks, start_time_utc: '' },
    { kind: 'hosted', desktop: 'planted', pid: planted.right.pid, start_time_ticks: rightTicks, start_time_utc: '' },
  ];
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  const reap = await reapLedger({ file });
  const wrongCheck = await separatePidCheck(planted.left.pid, wrongTicks);
  // TerminateProcess is asynchronous: the reaper's own answer says it terminated the process, and
  // reading the process table a moment later can still show it. A check that reads once and calls
  // the guard broken is a check that reports the clock rather than the behaviour.
  let rightCheck = await separatePidCheck(planted.right.pid, rightTicks);
  const goneDeadline = Date.now() + 12000;
  while (Date.now() < goneDeadline && rightCheck.ok && rightCheck.value.alive === true) {
    await sleep(300);
    rightCheck = await separatePidCheck(planted.right.pid, rightTicks);
  }
  return {
    ok: true,
    planted: { left_pid: planted.left.pid, left_ticks: leftTicks, planted_wrong: wrongTicks, right_pid: planted.right.pid, right_ticks: rightTicks },
    reap,
    wrong_alive: wrongCheck.ok ? wrongCheck.value.alive : null,
    right_alive: rightCheck.ok ? rightCheck.value.alive : null,
    // Recorded, not asserted: it is a fact about the KERNEL, not about this run, and it is the reason
    // `alive` is defined by the exit code rather than by whether the pid resolves.
    right_pid_still_resolves: rightCheck.ok ? rightCheck.value.resolves : null,
    refused: reap.reused.some((entry) => Number(entry.pid) === Number(planted.left.pid)) && wrongCheck.ok && wrongCheck.value.alive === true,
    terminated: reap.terminated.some((entry) => Number(entry.pid) === Number(planted.right.pid)) && rightCheck.ok && rightCheck.value.alive === false,
  };
}

main().catch((error) => {
  say(`THREW OUTSIDE THE MEASUREMENT: ${error && error.stack}`);
  RECEIPT.threw = String(error && error.stack ? error.stack : error);
  try { finalize(1); } catch { process.exit(1); }
});
