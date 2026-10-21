#!/usr/bin/env node
/**
 * measure-cu-hidden-route.mjs - the PRODUCTION lane, routed to the resident hidden-desktop agent.
 *
 * =====================================================================================
 * WHAT IS BEING MEASURED, AND WHAT IS DELIBERATELY NOT USED TO MEASURE IT
 * =====================================================================================
 *
 * The deliverable is routing, not reach: `lib/win32.js` must send the ordinary app-scoped
 * actions of `computer_use` to the resident agent of `lib/hidden-agent.js` when a caller arms
 * a hidden desktop, and the APPLICATION'S OWN STATE must change as a result.
 *
 * So every action below goes through the real tool - `createComputerUse().tools()`, the same
 * object the model calls - with a real virtual lease. Nothing here calls `agent.click`,
 * `agent.type` or `endpoint.capture` to make an assertion pass; the agent is reached only
 * through `computer_use`, and the only place this script speaks to the agent module at all is
 * to compile the probe and, in the parent, to audit.
 *
 * The evidence for each action is the probe application's own statement about itself: a click
 * counter it increments in its own window procedure, a wheel counter, a key counter, and the
 * contents of its own edit field - published to a state file AND to its own window title, so
 * there are two independent read paths for the same facts.
 *
 * =====================================================================================
 * THE PHASES, AND WHY EACH ONE HAS TO BE ABLE TO FAIL
 * =====================================================================================
 *
 *   H    hidden, routed: takeover_start(desktop "hidden", launch the probe) then the sequence.
 *        Asserts the actions answer ok:true, that the application's own counters move, and
 *        that the interactive desktop is untouched (window set, foreground, pointer).
 *   HP   the COUNTERFACTUAL: the same sequence with the routing removed from `lib/win32.js`
 *        by an exact single-occurrence plant. It must go back to failing - if it passes with
 *        the routing gone, then H was never measuring the routing.
 *   HR   the same sequence again after the file is restored byte for byte, with the released
 *        sha256 verified. Green here is what makes the HP red meaningful.
 *   C    the INTERACTIVE control: the same probe, the same action list, a virtual lease that
 *        did NOT ask for a hidden desktop. It must still pass on this desktop, through the
 *        posted-message path that existed before any of this.
 *
 * Every child phase runs in its own process, so a phase cannot inherit a lease, a route, or a
 * loaded copy of a planted module from another one.
 *
 * =====================================================================================
 * SAFETY
 * =====================================================================================
 *
 *   - No process is ever selected by name. The probe is tracked by the pid `spawn` returned,
 *     and by the pid it publishes in its own state file; the agent and everything it launches
 *     are tracked by the pids their own launch calls returned.
 *   - The interactive desktop's probe runs `--offscreen` (out of the taskbar, never activated)
 *     so the control puts nothing in front of the person at the machine. Nothing here opens
 *     the Start menu, and nothing here sends a key to a window it did not create.
 *   - Cleanup terminates from each process's own root, and the desktop audit before and after
 *     is the outside check that nothing was left behind.
 *
 * Invoke: node Newmark2DSH/scripts/measure-cu-hidden-route.mjs [--skip-counterfactual]
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CSHARP_PAYLOADS,
  runPowerShell,
  windowsPowerShellPath,
} from '../packages/newmark-core/components/computeruse/lib/hidden-agent.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const COMPONENT = path.join(REPO, 'packages', 'newmark-core', 'components', 'computeruse');
const COMPONENT_ENTRY = path.join(COMPONENT, 'lib', 'win32.js');
/**
 * The released bytes this lane file is measured against, and the hash that names them.
 *
 * It is the copy that shipped in 0.2.11, verified against the installed profile
 * (`~/.dsh/profiles/desktop/node_modules/newmark2dsh/components/computeruse/lib/win32.js`) on
 * this station. The value here used to be `72370221...`, which was the PREVIOUS release's bytes
 * - so every receipt printed `is_released=false` against a baseline that had not been current
 * for two releases. A receipt that names the wrong baseline cannot tell a modified file from an
 * unmodified one, which is the same class of defect as the teardown boolean.
 */
const RELEASED_SHA256 = 'c780a63c59fbee7ac828b1ee49b91089247a88d3ea54290c1a77ccc6c229c4f6';

const PHASE = (() => {
  const at = process.argv.indexOf('--phase');
  return at >= 0 ? String(process.argv[at + 1] || '') : '';
})();
const SKIP_COUNTERFACTUAL = process.argv.includes('--skip-counterfactual');
/** The notepad phase touches a real application; it is on by default and can be skipped. */
const SKIP_NOTEPAD = process.argv.includes('--skip-notepad');
/** A child phase is handed the parent's evidence directory: the probe it must run is there. */
const OUT_ARGUMENT = (() => {
  const at = process.argv.indexOf('--out');
  return at >= 0 ? String(process.argv[at + 1] || '') : '';
})();

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = OUT_ARGUMENT ? path.resolve(OUT_ARGUMENT) : path.join(REPO, 'evidence', 'cu-hidden-route', STAMP);
const CAPTURES = path.join(OUT, 'captures');
const PROBE_EXE = path.join(OUT, 'NmProbe.exe');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line = '') => process.stdout.write(`${String(line)}\n`);
const sha256Of = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const TRACK = { checks: [], notes: [], facts: {} };
function record(name, ok, detail) {
  TRACK.checks.push({ name, ok: ok === true, detail: String(detail) });
  say(`  [${ok === true ? 'PASS' : 'FAIL'}] ${name}${detail ? ` :: ${String(detail).slice(0, 500)}` : ''}`);
  return ok === true;
}
function note(name, value) {
  TRACK.notes.push({ name, value });
  say(`  (note) ${name}: ${typeof value === 'string' ? value.slice(0, 600) : JSON.stringify(value)}`);
}

/* ------------------------------------------------------------------ the probe application --- */

/**
 * The probe, and the only difference from the one the hidden-agent phase used is a key
 * counter: `app_key` had no observable effect on that application at all, and an assertion
 * about a key that cannot change anything is an assertion that cannot fail.
 */
const PROBE_CSHARP = String.raw`using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

public sealed class NmRouteProbeForm : Form
{
  int clicks;
  int wheelTicks;
  int keys;
  readonly string statePath;
  readonly Timer timer;
  readonly TextBox field;

  public NmRouteProbeForm(string statePath, bool offscreen, int atX, int atY)
  {
    this.statePath = statePath;
    this.Text = "NmProbe";
    this.ClientSize = new Size(420, 260);
    this.StartPosition = FormStartPosition.Manual;
    if (offscreen)
    {
      /* Offscreen for the control, but the WINDOW RECTANGLE still intersects the virtual screen
         when a corner is asked for, because this lane's own enumeration ignores a window that
         does not. Measured: a fully offscreen window is invisible to app_list and the control
         then reads as app_target_not_found, which looks exactly like a broken posted-message
         path rather than like a placement mistake. (No backticks in this comment: it lives
         inside a JavaScript template literal, and one would end the literal here.) */
      this.Location = new Point(atX, atY);
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
    else if (m.Msg == 0x0100) { this.keys = this.keys + 1; this.Publish(); this.Invalidate(); }
    base.WndProc(ref m);
  }

  void OnTick(object sender, EventArgs e) { this.Publish(); }

  protected override void OnPaint(PaintEventArgs e)
  {
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
    string title = "NmProbe clicks=" + this.clicks.ToString() + " wheel=" + this.wheelTicks.ToString() + " keys=" + this.keys.ToString() + " length=" + count.ToString();
    if (this.Text != title) this.Text = title;
    StringBuilder builder = new StringBuilder();
    builder.Append("{\"clicks\":").Append(this.clicks.ToString());
    builder.Append(",\"wheel\":").Append(this.wheelTicks.ToString());
    builder.Append(",\"keys\":").Append(this.keys.ToString());
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

public static class NmRouteProbeEntry
{
  [STAThread]
  public static void Main(string[] args)
  {
    string statePath = "nm-probe-state.json";
    bool offscreen = false;
    int atX = -4000;
    int atY = -4000;
    for (int i = 0; i < args.Length; i++)
    {
      if (args[i] == "--state" && i + 1 < args.Length) { statePath = args[i + 1]; i = i + 1; }
      else if (args[i] == "--offscreen") { offscreen = true; }
      else if (args[i] == "--at" && i + 2 < args.Length) { atX = int.Parse(args[i + 1]); atY = int.Parse(args[i + 2]); i = i + 2; }
    }
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    NmRouteProbeForm form = new NmRouteProbeForm(statePath, offscreen, atX, atY);
    Application.Run(form);
  }
}
`;

async function compileProbe() {
  fs.mkdirSync(OUT, { recursive: true });
  const source = path.join(OUT, 'NmRouteProbe.cs');
  fs.writeFileSync(source, PROBE_CSHARP, 'utf8');
  const encoded = Buffer.from(PROBE_CSHARP, 'utf8').toString('base64');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$forms = [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms")',
    '$drawing = [System.Reflection.Assembly]::LoadWithPartialName("System.Drawing")',
    "$source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
    encoded,
    "'@))",
    `try { Add-Type -TypeDefinition $source -ReferencedAssemblies @($forms.Location, $drawing.Location) -OutputAssembly "${PROBE_EXE.replace(/\\/g, '\\\\')}" -OutputType WindowsApplication -ErrorAction Stop } catch { Write-Output ("NMPROBEERR " + [string]$_.Exception.Message); exit 1 }`,
    'Write-Output "NMPROBEOK"',
  ].join('\n');
  const raw = await runPowerShell(script, { timeoutMs: 180000, executable: process.env.NM_HIDDEN_PWSH || windowsPowerShellPath() });
  if (!String(raw.output).includes('NMPROBEOK')) {
    return { ok: false, error: raw.error || 'the probe did not compile', output: String(raw.output).slice(-2000) };
  }
  return { ok: true, exe: PROBE_EXE, bytes: fs.statSync(PROBE_EXE).size };
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

/* ------------------------------------------------------- the interactive desktop's facts --- */

const INTERACTIVE_FACTS_CSHARP = String.raw`using System;
using System.Runtime.InteropServices;
public static class NmRouteInteractiveFacts
{
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static long CursorX() { POINT point; GetCursorPos(out point); return point.X; }
  public static long CursorY() { POINT point; GetCursorPos(out point); return point.Y; }
  public static long Foreground() { return GetForegroundWindow().ToInt64(); }
  public static long VirtualLeft() { return GetSystemMetrics(76); }
  public static long VirtualTop() { return GetSystemMetrics(77); }
  public static long VirtualWidth() { return GetSystemMetrics(78); }
  public static long VirtualHeight() { return GetSystemMetrics(79); }
}
`;

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

/** The interactive desktop's foreground window and pointer, read from a fresh process. */
async function interactiveFacts() {
  const encoded = Buffer.from(INTERACTIVE_FACTS_CSHARP, 'utf8').toString('base64');
  const script = [
    '$ErrorActionPreference = "Stop"',
    "$source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
    encoded,
    "'@))",
    'if (-not ("NmRouteInteractiveFacts" -as [type])) { Add-Type -TypeDefinition $source -ErrorAction Stop }',
    '$payload = @{ cursor_x = [long][NmRouteInteractiveFacts]::CursorX(); cursor_y = [long][NmRouteInteractiveFacts]::CursorY(); foreground = ("0x" + [NmRouteInteractiveFacts]::Foreground().ToString("x")); virtual_left = [long][NmRouteInteractiveFacts]::VirtualLeft(); virtual_top = [long][NmRouteInteractiveFacts]::VirtualTop(); virtual_width = [long][NmRouteInteractiveFacts]::VirtualWidth(); virtual_height = [long][NmRouteInteractiveFacts]::VirtualHeight() } | ConvertTo-Json -Depth 6 -Compress',
    'Write-Output ("NMFACTS " + $payload)',
  ].join('\n');
  const raw = await runPowerShell(script, { timeoutMs: 60000 });
  return markerLine(raw.output, 'NMFACTS ') || { error: raw.error || 'no NMFACTS line' };
}

/** Is this exact pid RUNNING? A terminated process keeps answering OpenProcess for seconds. */
async function pidRunning(pid) {
  const script = pwshWithPayloads(['NmProcessFacts'], [
    `$ticks = [NmProcessFacts]::StartTimeTicks(${Number(pid)})`,
    '$running = $false',
    `if ($ticks -gt 0) { $running = [NmProcessFacts]::Running(${Number(pid)}) }`,
    `Write-Output ("NMPID " + (@{ pid = ${Number(pid)}; running = $running } | ConvertTo-Json -Compress))`,
  ].join('\n'));
  const raw = await runPowerShell(script, { timeoutMs: 30000 });
  const value = markerLine(raw.output, 'NMPID ');
  return value ? value.running === true : null;
}

/**
 * Is that desktop openable right now, asked from a FRESH process with the agent's own maker?
 *
 * Two facts this measures, and neither is available from the receipt alone:
 *
 *   1. that the probe closes the handle it opens. A probe that leaked it would hold the very
 *      desktop it is auditing, and the teardown's own "still openable" answer would then be
 *      about the probe rather than about the agent.
 *   2. that the desktop does NOT die when the only other handle closes while a process is still
 *      assigned to it. That is the correction this work was handed: a desktop is held by any
 *      handle OR any process on it, which is exactly why the job object is load-bearing rather
 *      than decorative.
 */
function psSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function desktopProbe(desktopName) {
  const encoded = Buffer.from(CSHARP_PAYLOADS.NmHiddenMaker, 'utf8').toString('base64');
  const script = [
    '$ErrorActionPreference = "Stop"',
    "$source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
    encoded,
    "'@))",
    'if (-not ("NmHiddenMaker" -as [type])) { Add-Type -TypeDefinition $source -ErrorAction Stop }',
    '$errorCode = 0',
    `$desktop = [NmHiddenMaker]::OpenByName(${psSingle(desktopName)}, [ref]$errorCode)`,
    '$openable = ($desktop -ne [IntPtr]::Zero)',
    '$closed = $false',
    'if ($openable) { $closed = [NmHiddenMaker]::CloseDesktop($desktop) }',
    `Write-Output ("NMDESK " + (@{ desktop = ${psSingle(desktopName)}; still_openable = $openable; open_error = [int]$errorCode; probe_handle_closed = $closed; probe_thread_desktop = [NmHiddenMaker]::DesktopName() } | ConvertTo-Json -Compress))`,
  ].join('\n');
  const raw = await runPowerShell(script, { timeoutMs: 60000 });
  return markerLine(raw.output, 'NMDESK ');
}

/* -------------------------------------------------------------- the component under test --- */

/**
 * The real tool, built exactly as the component builds it.
 *
 * `root` is redirected into this run's evidence directory on purpose: the failure log is part
 * of what this component writes, and nothing in a measurement may write under the user's
 * Newmark root.
 */
async function buildTool() {
  const mod = await import(new URL(`file://${path.join(COMPONENT, 'component.js').replace(/\\/g, '/')}`));
  const root = path.join(OUT, 'newmark-root');
  fs.mkdirSync(root, { recursive: true });
  const component = mod.createComputerUse({ captionDir: CAPTURES, root });
  const tool = component.tools().find((entry) => entry.name === 'computer_use');
  if (!tool) throw new Error('the component published no computer_use tool');
  return tool;
}

/**
 * The component's OTHER tool, and the one property that matters here: its dispatch sets
 * `skipLease`, so the hidden route cannot claim it. That makes it the one read in this
 * measurement that can ask THIS desktop a question while a hidden desktop is armed.
 */
async function buildScreenCaptureTool() {
  const mod = await import(new URL(`file://${path.join(COMPONENT, 'component.js').replace(/\\/g, '/')}`));
  const root = path.join(OUT, 'newmark-root');
  fs.mkdirSync(root, { recursive: true });
  const component = mod.createComputerUse({ captionDir: CAPTURES, root });
  const tool = component.tools().find((entry) => entry.name === 'screen_capture');
  if (!tool) throw new Error('the component published no screen_capture tool');
  return tool;
}

/* ------------------------------------------------------------------------ the sequence --- */

/**
 * One sequence, the same argument objects for both desktops.
 *
 * Every point is a FRACTION of the target's client area, which is the one coordinate spelling
 * both delivery paths accept: the interactive path resolves it against the client rectangle,
 * and the routed path resolves it against the client rectangle the agent reported. Nothing in
 * this list is desktop-specific, which is what makes the interactive run a control rather than
 * a different experiment.
 *
 * ---------------------------------------------------------------------------------------
 * `omitOwner`, AND WHY THE FIRST STEP OF THE SEQUENCE WEARS IT
 * ---------------------------------------------------------------------------------------
 *
 * The 45/0 version of this measurement passed `owner_id` on EVERY call - the loop below did
 * `tool.execute({ ...args, owner_id: ownerId })` - and the live model does not, because nothing
 * tells it to: `owner_id` is optional in the tool's schema, and the operating guide names it in
 * one sentence, about `takeover_stop`. So the measurement pinned an optional argument the
 * application omits, and the two were measuring different call shapes while appearing to measure
 * the same thing. The live result was `app_list` answering with the INTERACTIVE desktop (94
 * windows, `scope: "virtual-includes-occluded"`) while a hidden desktop was armed, and the
 * agent's `requests_served` never moving.
 *
 * The step below therefore sends exactly what the application sends - no owner id at all - and
 * the check that reads it asserts it still landed on the hidden desktop. It is a step of the
 * ordinary sequence rather than a phase of its own, so it is also exercised with the routing
 * removed, where it must fail along with everything else.
 */
const SEQUENCE = [
  { action: 'app_list', label: 'app_list (no owner_id - the shape the live application sends)', omitOwner: true },
  { action: 'app_list', label: 'app_list' },
  { action: 'app_observe', app_target: 'NmProbe', label: 'app_observe (before)' },
  { action: 'app_click', app_target: 'NmProbe', x: 0.5, y: 0.8, label: 'app_click (form area)' },
  { action: 'app_scroll', app_target: 'NmProbe', x: 0.5, y: 0.8, scroll_y: -120, label: 'app_scroll' },
  { action: 'app_key', app_target: 'NmProbe', key: 'a', label: 'app_key' },
  { action: 'app_click', app_target: 'NmProbe', x: 0.5, y: 0.15, label: 'app_click (edit area)' },
  { action: 'app_type', app_target: 'NmProbe', text: 'newmark', label: 'app_type' },
  { action: 'app_observe', app_target: 'NmProbe', label: 'app_observe (after)' },
  { action: 'app_list', label: 'app_list (second read path)' },
];

async function runSequence(tool, ownerId, stateFile, label, watchOwner) {
  const result = { label, steps: [], checks: [] };
  const check = (name, ok, detail) => {
    result.checks.push({ name, ok: ok === true, detail: String(detail) });
    return record(`${label}: ${name}`, ok, detail);
  };
  const step = (name, value) => { result.steps.push({ name, value }); return value; };

  const before = await waitForState(stateFile, (value) => Number.isFinite(value.clicks), 15000);
  if (!before) {
    check("the probe published its own state before the sequence", false, `no readable state at ${stateFile}`);
    return result;
  }
  step('state_before', before);
  const factsBefore = await interactiveFacts();
  /*
   * WHERE THE WATCH READS HAPPEN, AND WHY IT MATTERS NOW.
   *
   * While a hidden desktop is ARMED and the lease is virtual, an `app_list` this process serves is
   * routed to that desktop - deliberately, and that is the fix this run measures. So a read meant
   * to watch THIS desktop cannot be taken in the middle of a hidden phase: it would answer with
   * the hidden desktop's windows and the check built on it would be about the wrong list (which is
   * exactly what the first version of this change produced: "5 interactive window(s)" while the
   * hidden desktop held five windows, and the probe appeared to be on this desktop).
   *
   * These two reads are therefore taken only for the INTERACTIVE control, where no hidden desktop
   * is armed, and the probe-absence checks for the hidden phases live in `phaseHidden`, at the two
   * moments where the answer is unambiguous: while the hidden application is alive (through
   * `screen_capture`, which is dispatched with `skipLease` and cannot be routed), and after the
   * teardown, when the route is gone.
   */
  const windowsBefore = watchOwner ? await tool.execute({ action: 'app_list', owner_id: watchOwner }) : null;
  step('interactive_facts_before', factsBefore);
  step('interactive_window_count_before', windowsBefore ? windowsBefore.count : null);

  const answers = [];
  for (const call of SEQUENCE) {
    const { label: stepLabel, omitOwner, ...args } = call;
    /* THE CALL SHAPE IS PART OF WHAT IS MEASURED. A step marked `omitOwner` is sent exactly as
     * the application sends it - with no owner_id at all - and every other step keeps the owner
     * pinned, so both shapes are in the same run and the difference between them is visible. */
    const sent = omitOwner ? { ...args } : { ...args, owner_id: ownerId };
    /* eslint-disable no-await-in-loop */
    const answer = await tool.execute(sent);
    answers.push({ label: stepLabel, args: sent, answer });
    step(stepLabel, answer);
    /* eslint-enable no-await-in-loop */
  }
  result.answers = answers;

  const failed = answers.filter((entry) => entry.answer.ok !== true);
  check('every action in the sequence answered ok:true', failed.length === 0,
    failed.length === 0
      ? `${answers.length} actions: ${answers.map((entry) => entry.label).join(', ')}`
      : failed.map((entry) => `${entry.label}: ${entry.answer.error_code} ${entry.answer.error}`).join(' | '));

  /*
   * THE CHECK THE 45/0 RUN DID NOT HAVE.
   *
   * On the hidden phases this asserts that a call carrying NO owner id still reached the armed
   * desktop - `scope: "hidden-desktop"` and `delivery: "hidden-desktop-agent"` are produced only
   * by the routed branch, and `owner_resolved_from_lease` says the route was resolved from the
   * lease rather than from the owner the call named. On the interactive control the same step
   * must land on THIS desktop, because no hidden desktop is armed there - so the assertion is
   * written per phase rather than weakened to something both could satisfy.
   */
  const omitted = answers.filter((entry) => entry.label.includes('no owner_id'));
  if (label === 'hidden' || label === 'restored' || label === 'no-job') {
    check('app_list with NO owner_id still reached the armed hidden desktop',
      omitted.length === 1 && omitted[0].answer.ok === true && omitted[0].answer.scope === 'hidden-desktop'
        && omitted[0].answer.delivery === 'hidden-desktop-agent' && omitted[0].answer.owner_resolved_from_lease === true
        && omitted[0].answer.owner_id_declared !== null,
      omitted.map((entry) => `scope=${entry.answer.scope} delivery=${entry.answer.delivery} declared=${JSON.stringify(entry.answer.owner_id_declared)} routed=${JSON.stringify(entry.answer.owner_id_routed)} from_lease=${entry.answer.owner_resolved_from_lease} count=${entry.answer.count}`).join(' | ') || 'the sequence never sent a call without an owner id');
  }
  if (label === 'interactive') {
    check('the same owner-less call stays on THIS desktop when no hidden desktop is armed',
      omitted.length === 1 && omitted[0].answer.ok === true && omitted[0].answer.scope === 'virtual-includes-occluded'
        && omitted[0].answer.delivery === undefined,
      omitted.map((entry) => `scope=${entry.answer.scope} delivery=${String(entry.answer.delivery)}`).join(' | ') || 'no owner-less step');
  }

  const observed = answers.filter((entry) => entry.label.startsWith('app_observe'));
  const listed = answers.filter((entry) => entry.label.startsWith('app_list'));
  check('app_observe answered with a capture of the application',
    observed.length === 2 && observed.every((entry) => entry.answer.ok === true && Number(entry.answer.image_bytes) > 1000 && entry.answer.capture_scope === 'window'),
    observed.map((entry) => `${entry.answer.image_path} ${entry.answer.width}x${entry.answer.height} ${entry.answer.image_bytes}B ${entry.answer.capture && entry.answer.capture.capture_method}`).join(' | '));
  /* Three list steps, and every one of them must name the application the sequence acted on -
   * including the one that sent no owner id. */
  check('every app_list listed the application the sequence acted on',
    listed.length === 3 && listed.every((entry) => entry.answer.ok === true && (entry.answer.applications || []).some((app) => /NmProbe/i.test(app.title))),
    listed.map((entry) => `${entry.label}: ${entry.answer.count} window(s): ${(entry.answer.applications || []).map((app) => `${app.handle} ${JSON.stringify(app.title)}`).slice(0, 4).join(', ')}`).join(' | '));

  /* -------------------------------------------------- the application's own state --- */
  const after = await waitForState(stateFile, (value) => value.clicks > before.clicks && Number.isFinite(value.keys), 15000);
  step('state_after', after);
  check("the application's OWN click counter incremented", Boolean(after) && after.clicks > before.clicks,
    `clicks ${before.clicks} -> ${after ? after.clicks : 'unreadable'}`);
  check("the application's OWN wheel counter incremented", Boolean(after) && after.wheel > before.wheel,
    `wheel ${before.wheel} -> ${after ? after.wheel : 'unreadable'}`);
  check("the application's OWN key counter incremented", Boolean(after) && after.keys > before.keys,
    `keys ${before.keys} -> ${after ? after.keys : 'unreadable'}`);
  check("the text the sequence typed is in the application's OWN field",
    Boolean(after) && typeof after.text === 'string' && after.text.includes('newmark'),
    `field=${JSON.stringify(after ? after.text : null)}`);

  /* ------------------------------------------------- the second, independent read path --- */
  const finalList = listed[listed.length - 1];
  const titled = finalList && Array.isArray(finalList.answer.applications)
    ? finalList.answer.applications.find((app) => /NmProbe/i.test(app.title))
    : null;
  const titleMatch = titled ? /clicks=(\d+) wheel=(\d+) keys=(\d+)/.exec(titled.title) : null;
  check('the same counters are readable through a second, independent path (the window title)',
    Boolean(titleMatch) && after && Number(titleMatch[1]) === Number(after.clicks) && Number(titleMatch[2]) === Number(after.wheel) && Number(titleMatch[3]) === Number(after.keys),
    titled ? `title=${JSON.stringify(titled.title)} state clicks=${after ? after.clicks : null} wheel=${after ? after.wheel : null} keys=${after ? after.keys : null}` : 'the window is not in the app_list answer');

  /* --------------------------------------------------- two captures, two different states --- */
  /**
   * The two capture routes describe a picture differently and both descriptions are used here.
   *
   * The routed capture reports the sha256 of the FILE the agent wrote; the window_capture lane
   * reports a 32x18 luma digest computed inside the lane. Neither is available on the other
   * route, so the comparison takes whichever the answer carries and also compares the byte
   * counts - which are a property of the pixels on both routes.
   */
  const captureFingerprint = (answer) => {
    const digest = (answer && answer.capture && answer.capture.digest) || {};
    return {
      digest: String(digest.sha256 || digest.sha256_prefix || ''),
      bytes: Number(answer && answer.image_bytes) || 0,
    };
  };
  const fingerprints = observed.map((entry) => captureFingerprint(entry.answer));
  result.capture_fingerprints = fingerprints;
  check('two captures of two different states differ in their bytes',
    fingerprints.length === 2 && fingerprints.every((entry) => entry.digest !== '' || entry.bytes > 0)
      && (fingerprints[0].digest !== fingerprints[1].digest || fingerprints[0].bytes !== fingerprints[1].bytes),
    fingerprints.map((entry) => `${entry.digest.slice(0, 16) || '(no digest)'} ${entry.bytes}B`).join(' vs '));

  /* ------------------------------------------- what the receipts say about WHERE they acted --- */
  const postedActions = ['app_click', 'app_scroll', 'app_key', 'app_type'];
  const routedReceipts = answers.filter((entry) => postedActions.includes(entry.args.action));
  const expectedPosted = SEQUENCE.filter((call) => postedActions.includes(call.action)).length;
  if (label === 'hidden' || label === 'restored' || label === 'no-job') {
    check('every routed receipt names the hidden desktop it acted on and promises no real delivery',
      routedReceipts.length === expectedPosted && routedReceipts.every((entry) => entry.answer.target_desktop && entry.answer.delivery === 'hidden-desktop-agent' && entry.answer.physical_delivery_used === false && entry.answer.system_cursor_moved === false && entry.answer.fallback_to_real_delivery === false),
      routedReceipts.map((entry) => `${entry.label}: desktop=${entry.answer.target_desktop} delivery=${entry.answer.delivery} agent_pid=${entry.answer.routed_to ? entry.answer.routed_to.agent_pid : null} physical=${entry.answer.physical_delivery_used} cursor=${entry.answer.system_cursor_moved} fallback=${entry.answer.fallback_to_real_delivery}`).join(' | '));
    check('the posted receipts name what the agent posted, and claim no completion',
      routedReceipts.every((entry) => entry.answer.action_completed === false && (entry.answer.agent_posted !== undefined || entry.answer.posted !== undefined)),
      routedReceipts.map((entry) => `${entry.label}: queued=${entry.answer.queued} posted=${JSON.stringify(entry.answer.agent_posted || entry.answer.posted)}`).join(' | '));
  }
  if (label === 'interactive') {
    check('the interactive control acted through the posted-message path, not the hidden route',
      routedReceipts.length === expectedPosted && routedReceipts.every((entry) => entry.answer.target_desktop === undefined && entry.answer.delivery === 'posted-window-messages'),
      routedReceipts.map((entry) => `${entry.label}: delivery=${entry.answer.delivery} target_desktop=${String(entry.answer.target_desktop)}`).join(' | '));
  }

  /* ------------------------------------------- the interactive desktop, before and after --- */
  const factsAfter = await interactiveFacts();
  const windowsAfter = watchOwner ? await tool.execute({ action: 'app_list', owner_id: watchOwner }) : null;
  step('interactive_facts_after', factsAfter);
  step('interactive_window_count_after', windowsAfter ? windowsAfter.count : null);

  if (label === 'hidden' || label === 'no-job') {
    const watched = windowsAfter && Array.isArray(windowsAfter.applications) ? windowsAfter.applications : [];
    check('the foreground window on the interactive desktop did not change',
      Boolean(factsBefore.foreground) && factsBefore.foreground === factsAfter.foreground,
      `${factsBefore.foreground} -> ${factsAfter.foreground}`);
    check('the pointer on the interactive desktop did not move',
      Number.isFinite(Number(factsBefore.cursor_x)) && factsBefore.cursor_x === factsAfter.cursor_x && factsBefore.cursor_y === factsAfter.cursor_y,
      `(${factsBefore.cursor_x},${factsBefore.cursor_y}) -> (${factsAfter.cursor_x},${factsAfter.cursor_y})`);
    const beforeSet = windowsBefore && Array.isArray(windowsBefore.applications) ? windowsBefore.applications.map((app) => app.handle).sort() : [];
    const afterSet = watched.map((app) => app.handle).sort();
    const added = afterSet.filter((handle) => !beforeSet.includes(handle));
    note('interactive window set change during the hidden phase', {
      before: beforeSet.length, after: afterSet.length, added,
      detail: 'the station is live: the person at this machine may open or close windows during a run. These reads are taken through the tool, so while a hidden desktop is ARMED an app_list this process serves is routed to it - which is why the reads are taken before the arm and after the teardown, and why the probe-absence checks live in phaseHidden where the route state is known.',
    });
  }

  result.state_before = before;
  result.state_after = after;
  result.interactive = { before: factsBefore, after: factsAfter };
  return result;
}

/* ------------------------------------------------------------------------- the phases --- */

/**
 * THE TARGET THE LIVE APPLICATION USED, ASKED THE SAME QUESTION.
 *
 * The live run armed a hidden desktop and launched `notepad.exe`, and the arm's own answer was
 * `in_job: false` for pid 36744 while the agent that launched it reported `job_in_job: true` in
 * its ready file. Two readings could explain that - the child broke away, or the membership read
 * was wrong - and this phase decides between them by asking the same agent for BOTH readings of
 * the same launch, plus the job's own member list:
 *
 *   - `membership_before` is 1 (member), 0 (opened, not a member) or -1 (the handle would not
 *     open, with `membership_error` saying why). The shipped read could only answer false.
 *   - `member_listed` is the job's OWN list, which is a second, independent answer.
 *   - `assigned_after_launch` and `assign_error` say whether the fix could hold it after the fact.
 *   - `created_by_this_launch` says whether the pid that answered is a process this launch made
 *     at all, which is what keeps the route from adopting something that was already running.
 *
 * Nothing here is selected by name for termination: the probe and the notepad are tracked by the
 * pid each arm's own launch call returned, plus the pids the agent itself reported as owning
 * windows on its desktop, and every one of those is killed from its own pid.
 */
async function phaseNotepad() {
  const tool = await buildTool();
  const ownerId = 'nm-route-notepad';
  const started = await tool.execute({
    action: 'takeover_start',
    owner_id: ownerId,
    mouse_mode: 'virtual',
    desktop: 'hidden',
    launch: 'notepad.exe',
  });
  TRACK.facts.takeover_start_notepad = started;
  const launched = started.ok === true && started.hidden_desktop && started.hidden_desktop.launched[0] ? started.hidden_desktop.launched[0] : null;
  const agentPid = started.ok === true ? Number(started.hidden_desktop.agent_pid) || 0 : 0;
  const launchedPid = launched ? Number(launched.pid) || 0 : 0;
  const reportedPids = launchedPid > 0 ? [launchedPid] : [];
  const reap = () => {
    for (const pid of reportedPids) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
  };
  process.once('exit', reap);
  record('notepad: takeover_start armed a hidden desktop and answered ok:true', started.ok === true,
    started.ok === true ? `desktop=${started.target_desktop} agent_pid=${agentPid} ownership=${started.hidden_desktop.ownership} launched=${JSON.stringify(launched)}` : `${started.error_code}: ${started.error}`);
  if (started.ok !== true || !launched) return { failed_early: true, started };

  record('notepad: the membership read is THREE-VALUED, and it says which answer it got',
    Number.isFinite(launched.membership_before) && [-1, 0, 1].includes(Number(launched.membership_before)),
    `membership_before=${launched.membership_before} membership_error=${launched.membership_error} member_listed=${launched.member_listed} inherited=${launched.inherited} assigned_after_launch=${launched.assigned_after_launch} assign_error=${launched.assign_error} held=${launched.held} ownership=${launched.ownership}`);
  record('notepad: the two independent membership reads AGREE, so the answer is not a failed read',
    launched.member_listed === (Number(launched.membership_before) === 1),
    `IsProcessInJob=${launched.membership_before} (0 = opened and not a member, 1 = member, -1 = the handle would not open) job member list contains it=${launched.member_listed}`);
  record('notepad: the route states whether the pid that answered is one it created',
    typeof launched.created_by_this_launch === 'boolean' && typeof launched.started_before_this_launch === 'boolean',
    `created_by_this_launch=${launched.created_by_this_launch} started_before_this_launch=${launched.started_before_this_launch}`);
  /*
   * THE OTHER PROCESS, NAMED. `notepad.exe` on this build is a packaged application: the pid the
   * launch returns is the activation stub, and the real Notepad is created by the shell's
   * activation host a fraction of a second later - a process no create call of ours ever returned.
   * What matters for safety is that the DESKTOP names it: the arm settles and asks the agent which
   * pids own windows on its desktop without being held by the job, and those pids go into the
   * teardown's question. If this is empty the check below says so rather than being skipped.
   */
  const unheld = started.hidden_desktop.unheld_desktop_pids || [];
  const unheldNotLaunched = unheld.filter((entry) => Number(entry.pid) !== launchedPid);
  record('notepad: the desktop NAMES the processes it hosts that the job does not hold',
    unheld.length >= 1,
    `settle=${started.hidden_desktop.launched_settle_ms}ms unheld_desktop_pids=${JSON.stringify(unheld)} (of which not the launched pid: ${JSON.stringify(unheldNotLaunched.map((entry) => entry.pid))})`);
  note('notepad outcome', {
    verdict: launched.held === true
      ? `HELD, by ${launched.ownership}: the child either inherited the job or was assigned to it after the launch`
      : 'NOT HELD: reported as an unowned launch, with its reason, instead of being silently absent',
    membership_before: launched.membership_before,
    member_listed: launched.member_listed,
    assignment: { attempted: launched.assigned_after_launch, error: launched.assign_error },
    unowned_launches: started.hidden_desktop.unowned_launches,
  });

  /* What the desktop now hosts, read from the agent: the notepad may have handed its window to a
   * process this agent never created, and those pids are named here rather than guessed. */
  const listed = await tool.execute({ action: 'app_list', owner_id: ownerId });
  const windows = listed.ok === true && Array.isArray(listed.applications) ? listed.applications : [];
  const windowPids = [...new Set(windows.map((app) => Number(app.process_id)).filter((pid) => pid > 0))];
  const launchedWindow = windows.find((app) => Number(app.process_id) === launchedPid);
  record('notepad: the hidden desktop lists the launched pid as a window owner, or says it does not',
    listed.ok === true,
    `${windows.length} window(s), owner pids [${windowPids.join(',')}]; launched pid ${launchedPid} owns one=${launchedWindow !== undefined} ${launchedWindow ? JSON.stringify(launchedWindow.title) : ''}`);
  for (const pid of windowPids) if (!reportedPids.includes(pid)) reportedPids.push(pid);

  let stopped = null;
  try {
    stopped = await tool.execute({ action: 'takeover_stop', owner_id: ownerId });
  } finally {
    TRACK.facts.takeover_stop_notepad = stopped;
  }
  const hidden = stopped && stopped.hidden_desktop ? stopped.hidden_desktop : null;
  const checks = hidden && Array.isArray(hidden.pids_checked) ? hidden.pids_checked : [];
  note('notepad teardown', hidden ? {
    pids_checked: checks.map((entry) => `${entry.pid}[${entry.sources.join('+')}]=${entry.running}`),
    all_processes_gone: hidden.all_processes_gone,
    desktop_gone: hidden.desktop_gone,
    unaccounted_holder: hidden.unaccounted_holder,
  } : null);
  const survivors = checks.filter((entry) => entry.running === true).map((entry) => entry.pid);
  for (const pid of survivors) if (!reportedPids.includes(pid)) reportedPids.push(pid);
  record('notepad: every pid the teardown named as surviving is now tracked for cleanup',
    survivors.every((pid) => reportedPids.includes(pid)),
    `survivors=[${survivors.join(',')}] tracked=[${reportedPids.join(',')}]`);

  /* Cleanup, from each pid's own root, and then the measurement of what that released. */
  for (const pid of reportedPids) { try { process.kill(pid); } catch { /* already gone */ } }
  const deadline = Date.now() + 20000;
  let stillAlive = [];
  /* eslint-disable no-await-in-loop */
  do {
    await sleep(500);
    stillAlive = [];
    for (const pid of reportedPids) if (await pidRunning(pid) !== false) stillAlive.push(pid);
  } while (stillAlive.length && Date.now() < deadline);
  /* eslint-enable no-await-in-loop */
  record('notepad: every process this phase started is gone, each killed from its own pid',
    stillAlive.length === 0,
    `tracked=[${reportedPids.join(',')}] still running=[${stillAlive.join(',')}]`);
  const desktopAfter = await desktopProbe(started.target_desktop);
  record('notepad: the desktop is gone once those processes are',
    Boolean(desktopAfter) && desktopAfter.still_openable === false,
    desktopAfter ? `still_openable=${desktopAfter.still_openable} open_error=${desktopAfter.open_error}` : 'the desktop probe answered nothing readable');
  TRACK.facts.notepad_desktop_after = desktopAfter;
  return { started, launched, listed, stopped, tracked: reportedPids, still_alive_after_cleanup: stillAlive };
}

async function phaseHidden(mode) {
  const stateFile = path.join(OUT, `probe-state-${mode}.json`);
  try { fs.rmSync(stateFile, { force: true }); } catch { /* ignore */ }
  const tool = await buildTool();
  const ownerId = `nm-route-${mode}`;
  const commandLine = `"${PROBE_EXE}" --state "${stateFile}"`;
  /**
   * The last-resort reap for the planted phase, and it is registered BEFORE the arm.
   *
   * The `no-job` phase deliberately leaves a process running, so every path out of this phase -
   * including one that throws - has to end with that pid terminated. It is tracked by the pid the
   * arm's own launch call returns, never by name, and on the ordinary phases the variable is 0 and
   * this does nothing.
   */
  let survivorPid = 0;
  const reapSurvivor = () => {
    if (!survivorPid) return;
    try { process.kill(survivorPid); } catch { /* already gone */ }
  };
  process.once('exit', reapSurvivor);
  const started = await tool.execute({
    action: 'takeover_start',
    owner_id: ownerId,
    mouse_mode: 'virtual',
    desktop: 'hidden',
    launch: commandLine,
  });
  TRACK.facts[`takeover_start_${mode}`] = started;
  record(`${mode}: takeover_start armed a hidden desktop and answered ok:true`, started.ok === true,
    started.ok === true
      ? `desktop=${started.target_desktop} agent_pid=${started.hidden_desktop.agent_pid} job=${JSON.stringify(started.hidden_desktop.job)} ownership=${started.hidden_desktop.ownership} launched=${JSON.stringify(started.hidden_desktop.launched)}`
      : `${started.error_code}: ${started.error}`);
  if (started.ok !== true) return { mode, failed_early: true, started };

  /*
   * THE ARM SAYS WHETHER IT HOLDS WHAT IT STARTED.
   *
   * `job.self_in_job` is the kernel's answer to "is the agent a member of the job it created",
   * read from the agent's own ready file, and it is reported beside `self_assigned` because the
   * two are different questions. `ownership` and `unowned_launches` say whether the launched
   * application is held; on the normal phases it must be, and on the `no-job` plant it must NOT
   * be - and it must SAY so rather than being silently absent from the record.
   */
  const job = started.hidden_desktop.job || {};
  if (mode === 'no-job') {
    record(`${mode}: the arm reports an agent that holds NO job, and says so`, started.hidden_desktop.ownership === 'no-job' && job.created === false,
      `ownership=${started.hidden_desktop.ownership} job=${JSON.stringify(job)}`);
    record(`${mode}: the launch is reported as NOT held, with the reason`,
      started.hidden_desktop.unowned_launches.length === 1 && started.hidden_desktop.launched[0].held === false && started.hidden_desktop.launched[0].ownership === 'unowned',
      `unowned_launches=${JSON.stringify(started.hidden_desktop.unowned_launches)} launched=${JSON.stringify(started.hidden_desktop.launched[0])}`);
  } else {
    record(`${mode}: the agent is a MEMBER of the job it created (the kernel's answer, not the assign call's)`,
      job.created === true && job.self_assigned === true && job.self_in_job === true && job.kill_on_close === true,
      `job=${JSON.stringify(job)}`);
    record(`${mode}: the launched application is HELD by that job, and the arm says how`,
      started.hidden_desktop.launched[0] && started.hidden_desktop.launched[0].held === true
        && ['inherited', 'assigned'].includes(started.hidden_desktop.launched[0].ownership)
        && started.hidden_desktop.unowned_launches.length === 0,
      `launched=${JSON.stringify(started.hidden_desktop.launched[0])} unowned_launches=${JSON.stringify(started.hidden_desktop.unowned_launches)}`);
  }

  const launchedPid = started.hidden_desktop.launched && started.hidden_desktop.launched[0] ? Number(started.hidden_desktop.launched[0].pid) : 0;
  const agentPid = Number(started.hidden_desktop.agent_pid) || 0;
  if (mode === 'no-job') survivorPid = launchedPid;
  TRACK.facts[`pids_${mode}`] = { agent_pid: agentPid, launched_pid: launchedPid };

  /*
   * The desktop itself, while it is alive - asked from a fresh process twice.
   *
   * The second ask is the whole point: the first probe opened the desktop and CLOSED its own
   * handle, and a desktop that died with its last handle would then answer unopenable. It does
   * not, because the agent's process is still assigned to it - and that is the measured reason
   * the job object matters: without it a leaked process is a leaked desktop.
   */
  const probeAlive = await desktopProbe(started.target_desktop);
  record(`${mode}: the desktop is openable from a fresh process while the agent holds it`, Boolean(probeAlive) && probeAlive.still_openable === true,
    probeAlive ? `openable=${probeAlive.still_openable} open_error=${probeAlive.open_error} probe_thread_desktop=${probeAlive.probe_thread_desktop}` : 'the desktop probe answered nothing readable');
  record(`${mode}: that probe closed the handle it opened`, Boolean(probeAlive) && probeAlive.probe_handle_closed === true,
    probeAlive ? `probe_handle_closed=${probeAlive.probe_handle_closed}` : 'no answer');
  const probeAfterClose = await desktopProbe(started.target_desktop);
  record(`${mode}: the desktop survived that handle closing, because a process is still assigned to it`, Boolean(probeAfterClose) && probeAfterClose.still_openable === true,
    probeAfterClose ? `still_openable=${probeAfterClose.still_openable} - a desktop is held by any handle OR any process on it` : 'the second desktop probe answered nothing readable');
  TRACK.facts[`desktop_probe_${mode}`] = { while_held: probeAlive, after_probe_closed: probeAfterClose };

  let sequence = null;
  let stopped = null;
  let screenCapture = null;
  try {
    // The probe needs a moment to create its window; the sequence resolves it by title.
    await waitForState(stateFile, (value) => Boolean(value.handle), 20000);
    sequence = await runSequence(tool, ownerId, stateFile, mode, null);
  } finally {
    /*
     * THE UNAMBIGUOUS "IT IS NOT ON THIS DESKTOP" READ, TAKEN WHILE THE APPLICATION IS ALIVE.
     *
     * This is the `screen_capture` tool - the one the component dispatches with `skipLease`, which
     * is what keeps it on THIS desktop: a read that never touches the lease cannot be claimed by
     * the hidden route. So while the hidden application is running and findable on its own desktop,
     * asking this desktop for a window titled NmProbe must find none. If the hidden desktop's
     * application were also on this desktop, it would be found here.
     *
     * It is in the `finally` ON PURPOSE: if the sequence throws, the read still happens before the
     * desktop is torn down, so a broken run cannot skip the check that matters.
     */
    try {
      const screenTool = await buildScreenCaptureTool();
      screenCapture = await screenTool.execute({ target: 'application', app_target: 'NmProbe' });
    } catch (error) {
      screenCapture = { ok: false, error_code: 'capture_probe_threw', error: error instanceof Error ? error.message : String(error) };
    }
    stopped = await tool.execute({ action: 'takeover_stop', owner_id: ownerId });
    TRACK.facts[`takeover_stop_${mode}`] = stopped;
  }
  record(`${mode}: while the hidden application was alive, THIS desktop had no window of it`,
    Boolean(screenCapture) && screenCapture.ok === false && screenCapture.error_code === 'app_target_not_found',
    screenCapture ? `ok=${screenCapture.ok} code=${screenCapture.error_code} error=${String(screenCapture.error || '').slice(0, 160)}` : 'the read never ran');
  TRACK.facts[`screen_capture_${mode}`] = screenCapture;

  const hidden = stopped.hidden_desktop;
  if (mode === 'planted') {
    /* The plant removes the routing and nothing else: the arming still happens, so this phase
     * measures exactly what the routing contributes. */
    record('planted: the sequence FAILED once the routing was removed',
      Boolean(sequence) && sequence.checks.some((check) => check.name.includes('answered ok:true') && check.ok === false),
      sequence ? sequence.checks.filter((check) => check.name.includes('ok:true') || check.name.includes('OWN')).map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`).join(' | ').slice(0, 700) : 'the sequence never ran');
  }
  /*
   * THE TEARDOWN, ASKED TWO DIFFERENT WAYS.
   *
   * `no-job` is the PLANTED SURVIVOR: the arm is made against an agent that holds no job, so the
   * application this session launched is a process nothing will kill when the agent goes - the
   * same condition the live `notepad.exe` was in. The teardown MUST report it as surviving, and
   * these assertions are the ones that were impossible before: they require a per-pid record for
   * the launched pid, `all_processes_gone: false`, `desktop_gone: false`, and no
   * `unaccounted_holder` (the holder IS accounted for - it is in the list). Every other phase
   * requires the opposite, so a teardown that always answers `true` fails here and a teardown
   * that always answers `false` fails there.
   */
  const expectSurvivor = mode === 'no-job';
  const checks = hidden && Array.isArray(hidden.pids_checked) ? hidden.pids_checked : [];
  const launchedCheck = checks.find((entry) => Number(entry.pid) === launchedPid);
  const perPidComplete = checks.length > 0 && checks.every((entry) => entry && typeof entry.pid === 'number' && Array.isArray(entry.sources) && entry.sources.length > 0 && (entry.running === true || entry.running === false));
  record(`${mode}: the teardown answers PER PID, and every pid it asked about carries its own result`,
    Boolean(hidden) && perPidComplete && Number(hidden.pids_checked_count) === checks.length,
    hidden ? `${checks.length} pid record(s): ${checks.map((entry) => `${entry.pid}[${entry.sources.join('+')}]=${entry.running === null ? 'unreadable' : entry.running}`).join(' ')}` : 'no teardown block');
  record(`${mode}: the teardown asked about the pid THIS SESSION LAUNCHED, by name of its source`,
    Boolean(launchedCheck) && launchedCheck.sources.includes('launched-this-session'),
    launchedPid > 0 ? `launched pid ${launchedPid} -> ${JSON.stringify(launchedCheck || null)}` : 'the arm reported no launched pid');
  if (expectSurvivor) {
    record(`${mode}: the PLANTED SURVIVOR is reported as surviving, not as absent`,
      Boolean(hidden) && hidden.all_processes_gone === false && hidden.still_running.includes(launchedPid),
      hidden ? `all_processes_gone=${hidden.all_processes_gone} still_running=[${hidden.still_running.join(',')}] launched=${launchedPid}` : 'no teardown block');
    record(`${mode}: the desktop it holds is reported as still held`,
      Boolean(hidden) && hidden.desktop_gone === false && hidden.desktop_still_held === true,
      hidden ? `desktop_gone=${hidden.desktop_gone} still_openable=${hidden.desktop.still_openable}` : 'no teardown block');
    record(`${mode}: the survivor is ACCOUNTED FOR, so no unaccounted holder is claimed`,
      Boolean(hidden) && hidden.unaccounted_holder === false && hidden.nothing_holds_the_desktop === false,
      hidden ? `unaccounted_holder=${hidden.unaccounted_holder} nothing_holds_the_desktop=${hidden.nothing_holds_the_desktop}` : 'no teardown block');
  } else {
    record(`${mode}: the teardown measured that the desktop is gone`, Boolean(hidden) && hidden.desktop_gone === true,
      hidden ? `still_openable=${hidden.desktop.still_openable} checked=${hidden.desktop.checked} probe_handle_closed=${hidden.desktop.probe_handle_closed} open_error=${hidden.desktop.open_error}` : 'takeover_stop reported no hidden_desktop block');
    record(`${mode}: the teardown measured that every process it started is gone`,
      Boolean(hidden) && hidden.all_processes_gone === true && checks.length >= 2 && checks.every((entry) => entry.running === false),
      hidden ? `${checks.length} pid(s) asked about, every one false: ${checks.map((entry) => `${entry.pid}[${entry.sources.join('+')}]`).join(' ')}; still_running=[${hidden.still_running.join(',')}] waited=${hidden.exit_wait_ms}ms` : 'no teardown block');
    record(`${mode}: the pid answers and the desktop probe agree that nothing is left`,
      Boolean(hidden) && hidden.nothing_holds_the_desktop === true && hidden.unaccounted_holder === false,
      hidden ? `nothing_holds_the_desktop=${hidden.nothing_holds_the_desktop} unaccounted_holder=${hidden.unaccounted_holder}` : 'no teardown block');
  }
  record(`${mode}: the agent answered the exit request before it ended`, Boolean(hidden) && hidden.exit_answered === true,
    hidden ? `exit_answered=${hidden.exit_answered} state_answered=${hidden.state_answered}` : 'no teardown block');

  /*
   * THE SECOND UNAMBIGUOUS READ: AFTER THE TEARDOWN, THIS DESKTOP MUST NOT CARRY THE PROBE.
   *
   * The route is gone and the lease is released, so an `app_list` now answers about THIS desktop -
   * and the application that was on the hidden desktop must not be in it, by handle or by title.
   */
  const after = sequence && sequence.state_before ? sequence.state_before : null;
  const watchAfter = await tool.execute({ action: 'app_list', owner_id: `nm-watch-${mode}-after` });
  const watchedAfter = Array.isArray(watchAfter.applications) ? watchAfter.applications : [];
  const publishedHandle = after && after.handle ? `0x${String(after.handle).toLowerCase()}` : '';
  const intruder = publishedHandle ? watchedAfter.find((app) => String(app.handle).toLowerCase() === publishedHandle) : null;
  record(`${mode}: after the teardown, THIS desktop's window set does not carry the probe`,
    watchAfter.ok === true && watchAfter.scope !== 'hidden-desktop' && publishedHandle !== ''
      && intruder === undefined && !watchedAfter.some((app) => /NmProbe/i.test(app.title)),
    `${watchedAfter.length} window(s), scope=${watchAfter.scope}; probe handle ${publishedHandle} present=${intruder !== undefined}; by title: ${watchedAfter.filter((app) => /NmProbe/i.test(app.title)).map((app) => `${app.handle} ${app.title}`).join(', ') || 'none'}`);
  TRACK.facts[`interactive_after_${mode}`] = { scope: watchAfter.scope, count: watchedAfter.length };

  const probePid = sequence && sequence.state_after ? Number(sequence.state_after.pid) : 0;
  const tracked = [agentPid, launchedPid, probePid].filter((pid) => pid > 0);
  const running = [];
  for (const pid of tracked) {
    /* eslint-disable no-await-in-loop */
    const alive = await pidRunning(pid);
    if (alive !== false) running.push({ pid, alive });
    /* eslint-enable no-await-in-loop */
  }
  if (expectSurvivor) {
    /* The outside check for the planted phase: a process that is not the teardown, and not this
     * script's own bookkeeping, must agree that the launched application is STILL RUNNING. This
     * is what makes `all_processes_gone: false` a measurement rather than a claim. */
    record(`${mode}: an independent process agrees the launched application SURVIVED the teardown`,
      launchedPid > 0 && running.some((entry) => entry.pid === launchedPid),
      `checked [${tracked.join(',')}] (agent, launched, the probe's own pid); still running: ${JSON.stringify(running)}`);
    /* The station is left as it was found: the survivor is terminated from the pid the arm's own
     * launch call returned, and the desktop it was holding must then be gone. */
    let killed = false;
    try { process.kill(launchedPid); killed = true; } catch { killed = false; }
    let goneAfterKill = await pidRunning(launchedPid);
    const killDeadline = Date.now() + 15000;
    while (goneAfterKill !== false && Date.now() < killDeadline) { await sleep(250); goneAfterKill = await pidRunning(launchedPid); }
    if (goneAfterKill === false) survivorPid = 0;
    record(`${mode}: the survivor was terminated from its own root and is gone`, killed && goneAfterKill === false,
      `pid ${launchedPid} kill_issued=${killed} running=${String(goneAfterKill)}`);
    const desktopAfterKill = await desktopProbe(started.target_desktop);
    record(`${mode}: the desktop was released once the survivor it held was gone`,
      Boolean(desktopAfterKill) && desktopAfterKill.still_openable === false,
      desktopAfterKill ? `still_openable=${desktopAfterKill.still_openable} open_error=${desktopAfterKill.open_error}` : 'the desktop probe answered nothing readable');
    /* No handle was opened, so nothing was closed: `probe_handle_closed` is false here and that
     * is the correct answer, not a failure. The probe only closes a handle it actually opened. */
    record(`${mode}: the release probe opened no handle, because there was nothing left to open`,
      Boolean(desktopAfterKill) && desktopAfterKill.probe_handle_closed === false,
      desktopAfterKill ? `probe_handle_closed=${desktopAfterKill.probe_handle_closed} still_openable=${desktopAfterKill.still_openable}` : 'no answer');
    TRACK.facts[`survivor_${mode}`] = { launched_pid: launchedPid, running_after_teardown: running, killed, gone_after_kill: goneAfterKill, desktop_after_kill: desktopAfterKill };
  } else {
    record(`${mode}: an independent process agrees that every pid of this phase is gone`,
      tracked.length >= 2 && running.length === 0,
      `checked [${tracked.join(',')}] (agent, launched, the probe's own pid); still running: ${JSON.stringify(running)}`);
  }

  return { mode, started, sequence, stopped, tracked };
}

async function phaseInteractive() {
  const stateFile = path.join(OUT, 'probe-state-interactive.json');
  try { fs.rmSync(stateFile, { force: true }); } catch { /* ignore */ }
  /**
   * Where the control's application is put, and why it is not simply offscreen.
   *
   * The control has to be an application ON THIS desktop and it must be findable by `app_list`,
   * so it must not be rude about it: it is placed with its top-left corner 8 px inside the
   * bottom-right corner of the virtual screen, which leaves an 8 x 64 px sliver at the edge of
   * the screen for the length of the control - and it never activates (`ShowWithoutActivation`),
   * never appears in the taskbar, and is terminated from the pid its own spawn returned. A fully
   * offscreen window does not work here: this lane's enumeration ignores a window whose
   * rectangle does not intersect the virtual screen, and `app_target_not_found` then reads like
   * a broken posted-message path rather than like a placement mistake.
   */
  const facts = await interactiveFacts();
  const at = {
    x: Number(facts.virtual_left || 0) + Number(facts.virtual_width || 1920) - 8,
    y: Number(facts.virtual_top || 0) + Number(facts.virtual_height || 1080) - 64,
  };
  note('the control application is placed at the bottom-right corner of the virtual screen', { ...at, virtual: facts, placement: '8 px of its left edge and 64 px of its top edge are on-screen; it never activates' });
  const child = spawn(PROBE_EXE, ['--state', stateFile, '--offscreen', '--at', String(at.x), String(at.y)], { windowsHide: true, stdio: 'ignore', detached: false });
  const probePid = Number(child.pid);
  child.unref();
  TRACK.facts.pids_interactive = { probe_pid: probePid, at };
  const published = await waitForState(stateFile, (value) => Boolean(value.handle), 20000);
  record('the control application started on this desktop and published its own handle', Boolean(published && published.handle),
    published ? `pid=${probePid} handle=0x${published.handle} title=${JSON.stringify(published.title)} at ${at.x},${at.y}` : `pid ${probePid} published nothing`);

  const tool = await buildTool();
  const ownerId = 'nm-route-interactive';
  const started = await tool.execute({ action: 'takeover_start', owner_id: ownerId, mouse_mode: 'virtual' });
  TRACK.facts.takeover_start_interactive = started;
  record('the interactive control lease is virtual and armed NO hidden desktop',
    started.ok === true && started.hidden_desktop === undefined && started.delivery === 'posted-window-messages',
    `delivery=${started.delivery} mouse_mode=${started.mouse_mode} hidden_desktop=${JSON.stringify(started.hidden_desktop)}`);
  let sequence = null;
  try {
    sequence = await runSequence(tool, ownerId, stateFile, 'interactive', 'nm-watch-interactive');
  } finally {
    await tool.execute({ action: 'takeover_stop', owner_id: ownerId });
    try { process.kill(probePid); } catch { /* already gone */ }
  }
  const gone = await pidRunning(probePid);
  record('the control application was terminated from its own root and is gone', gone === false, `pid ${probePid} running=${String(gone)}`);
  return { ownerId, started, sequence, probe_pid: probePid };
}

/* ---------------------------------------------------------------- the counterfactual --- */

/**
 * The plant, and the reason it is an exact single-occurrence anchor.
 *
 * The routing decision is one line in `dispatchComputerUse`; replacing it with `null` removes
 * the routing and nothing else, so the counterfactual differs from the measured run in exactly
 * the thing under test. `applySeams`-style strictness applies: if the anchor does not occur
 * exactly once, this refuses rather than measuring something else.
 */
const ROUTE_ANCHOR = '  const hiddenRoute = hiddenRouteActive(options);';
const ROUTE_PLANTED = '  const hiddenRoute = null; /* planted: the routing is removed */';

function plantRouting() {
  const source = fs.readFileSync(COMPONENT_ENTRY, 'utf8');
  const hits = source.split(ROUTE_ANCHOR).length - 1;
  if (hits !== 1) throw new Error(`the routing anchor occurs ${hits} time(s) in win32.js, so the counterfactual cannot be planted exactly`);
  return source.replace(ROUTE_ANCHOR, ROUTE_PLANTED);
}

/**
 * The second plant: an agent that holds NO JOB, which is the condition the live application was
 * in when its launched `notepad.exe` survived the teardown.
 *
 * The agent payload already supports it (`-NoJob`), and the lane never asks for it - so the
 * plant is a one-line addition at the one call that starts an agent, anchored exactly, and
 * restored byte for byte afterwards with its sha256 checked. With no job there is nothing to
 * kill the launched application when the agent goes, so the launched pid is the survivor, and
 * the teardown's per-pid answer is the only thing that can name it.
 */
const NOJOB_ANCHOR = '  const endpoint = await mod.startHiddenDesktopAgent({';
const NOJOB_PLANTED = '  const endpoint = await mod.startHiddenDesktopAgent({\n    noJob: true, /* planted: the agent holds no job, so a launched application can survive */';

function plantNoJob() {
  const source = fs.readFileSync(COMPONENT_ENTRY, 'utf8');
  const hits = source.split(NOJOB_ANCHOR).length - 1;
  if (hits !== 1) throw new Error(`the agent-start anchor occurs ${hits} time(s) in win32.js, so the no-job plant cannot be applied exactly`);
  return source.replace(NOJOB_ANCHOR, NOJOB_PLANTED);
}

function runChildPhase(tag, extra = []) {
  const receipt = path.join(OUT, `phase-${tag}.json`);
  const args = [fileURLToPath(import.meta.url), '--phase', tag, '--out', OUT, ...extra];
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 900000, env: { ...process.env, NM_ROUTE_CHILD: '1' } });
  say(String(run.stdout || '').trimEnd());
  if (String(run.stderr || '').trim()) say(`  (stderr) ${String(run.stderr).trim().slice(0, 1200)}`);
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(receipt, 'utf8')); } catch { parsed = null; }
  return { status: run.status, receipt: parsed, receipt_file: receipt, stdout: String(run.stdout || ''), stderr: String(run.stderr || '') };
}

/* ------------------------------------------------------------------------------ main --- */

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(CAPTURES, { recursive: true });
  say('=== the production lane, routed to the resident hidden-desktop agent ===');
  say(`evidence: ${OUT}`);
  const shaBefore = sha256Of(COMPONENT_ENTRY);
  say(`lib/win32.js sha256 before: ${shaBefore} (released: ${RELEASED_SHA256})`);

  const probe = await compileProbe();
  record('the probe application compiled', probe.ok === true, probe.ok ? `${probe.exe} ${probe.bytes} bytes` : `${probe.error} ${probe.output || ''}`);
  if (probe.ok !== true) return finalize(1);

  /* The station's desktop inventory, before anything of this run starts. */
  const auditBefore = spawnSync(process.execPath, [path.join(HERE, 'check-cu-hidden-leftovers.mjs')], { encoding: 'utf8', timeout: 180000 });
  const countPrefix = (text) => {
    const match = /desktops carrying the prefix "[^"]*": (\d+)/.exec(String(text));
    return match ? Number(match[1]) : null;
  };
  TRACK.facts.desktops_with_prefix_before = countPrefix(auditBefore.stdout);
  note('desktop audit before', String(auditBefore.stdout || '').trim().split(/\r?\n/).slice(-4).join(' | '));

  const hidden = await phaseHidden('hidden');
  const counterfactual = SKIP_COUNTERFACTUAL ? null : await (async () => {
    say('\n--- the counterfactual: the routing removed by an exact plant ---');
    const pristine = fs.readFileSync(COMPONENT_ENTRY);
    const shaBeforePlant = createHash('sha256').update(pristine).digest('hex');
    let result = null;
    let restore = null;
    try {
      fs.writeFileSync(COMPONENT_ENTRY, plantRouting(), 'utf8');
      note('planted sha256', sha256Of(COMPONENT_ENTRY));
      result = runChildPhase('planted');
    } finally {
      fs.writeFileSync(COMPONENT_ENTRY, pristine);
      const after = sha256Of(COMPONENT_ENTRY);
      restore = { sha256: after, sha_before_plant: shaBeforePlant, restored: after === shaBeforePlant, is_released_copy: after === RELEASED_SHA256 };
    }
    TRACK.facts.counterfactual_restore = restore;
    record('the lane file was restored byte for byte after the plant', restore.restored === true,
      `sha256=${restore.sha256} before-plant=${restore.sha_before_plant} identical-to-released=${restore.is_released_copy}`);
    return result;
  })();

  say('\n--- the same sequence again, with the file restored ---');
  const restored = SKIP_COUNTERFACTUAL ? null : runChildPhase('restored');

  /*
   * THE PLANTED SURVIVOR, AND IT IS THE SAME CONDITION THE LIVE `notepad.exe` WAS IN.
   *
   * A teardown check that has never gone red is not a check. This phase arms an agent that holds
   * no job, launches the ordinary probe, runs the ordinary sequence - which proves the ROUTING is
   * unaffected by the plant, so the only thing being measured is the ownership answer - and then
   * tears the desktop down. The launched probe is outside every job, so nothing kills it: the
   * teardown must name it, per pid, as still running, and must report the desktop as still held.
   * The phase then terminates it from the pid its own arm's launch call returned and measures
   * that the desktop is gone, so the station is left as it was found.
   */
  let survivor = null;
  if (!SKIP_COUNTERFACTUAL) {
    say('\n--- the planted survivor: an agent with no job, so a launched application outlives it ---');
    const pristine = fs.readFileSync(COMPONENT_ENTRY);
    const shaBeforePlant = createHash('sha256').update(pristine).digest('hex');
    let result = null;
    let restore = null;
    try {
      fs.writeFileSync(COMPONENT_ENTRY, plantNoJob(), 'utf8');
      note('no-job plant sha256', sha256Of(COMPONENT_ENTRY));
      result = runChildPhase('no-job');
    } finally {
      fs.writeFileSync(COMPONENT_ENTRY, pristine);
      const after = sha256Of(COMPONENT_ENTRY);
      restore = { sha256: after, sha_before_plant: shaBeforePlant, restored: after === shaBeforePlant, is_released_copy: after === RELEASED_SHA256 };
    }
    TRACK.facts.nojob_restore = restore;
    record('the lane file was restored byte for byte after the no-job plant', restore.restored === true,
      `sha256=${restore.sha256} before-plant=${restore.sha_before_plant} identical-to-released=${restore.is_released_copy}`);
    const sequence = result && result.receipt && result.receipt.facts ? result.receipt.facts.sequence : null;
    record('WITH A JOB THAT HOLDS NOTHING, THE HIDDEN SEQUENCE STILL ROUTED AND STILL PASSED',
      Boolean(sequence) && sequence.checks.length > 0 && sequence.checks.every((check) => check.ok === true),
      sequence ? `${sequence.checks.filter((check) => check.ok).length}/${sequence.checks.length} checks - the plant changes ownership, not routing` : 'the no-job phase produced no sequence');
    survivor = result;
  }

  say('\n--- the interactive control: the same probe, the same actions, no hidden desktop ---');
  const interactive = await phaseInteractive();

  /*
   * THE SAME TARGET THE LIVE APPLICATION USED, ASKED THE SAME QUESTION.
   *
   * This runs LAST and on its own desktop, because it is the one phase whose target is not this
   * measurement's own program: `notepad.exe` is a packaged application on this build, and the live
   * run's launched notepad ended up outside the job. The phase answers "breakaway, or a wrong
   * read?" with the agent's own three-valued membership answer, and it cleans up every pid it
   * learned about - by pid, from its own root, never by name.
   */
  let notepad = null;
  if (!SKIP_NOTEPAD) {
    say('\n--- the live target: what the agent can say about a launched notepad.exe ---');
    notepad = await phaseNotepad();
  }
  const auditAfter = spawnSync(process.execPath, [path.join(HERE, 'check-cu-hidden-leftovers.mjs')], { encoding: 'utf8', timeout: 180000 });
  TRACK.facts.desktops_with_prefix_after = countPrefix(auditAfter.stdout);
  note('desktop audit after', String(auditAfter.stdout || '').trim().split(/\r?\n/).slice(-4).join(' | '));
  record('this run added no desktop to the station',
    TRACK.facts.desktops_with_prefix_before !== null && TRACK.facts.desktops_with_prefix_before === TRACK.facts.desktops_with_prefix_after,
    `${TRACK.facts.desktops_with_prefix_before} desktop(s) with this work's prefix before, ${TRACK.facts.desktops_with_prefix_after} after`);
  const leftoverPids = /LEFTOVER [^\n]*pids=\[([^\]]*)\]/.exec(String(auditAfter.stdout || ''));
  record('no leftover desktop carries a process',
    !leftoverPids || String(leftoverPids[1]).trim() === '',
    leftoverPids ? `leftover pids: [${leftoverPids[1]}]` : 'no LEFTOVER lines at all');

  const shaAfter = sha256Of(COMPONENT_ENTRY);
  record('lib/win32.js ends this run byte-identical to the bytes it started with',
    shaAfter === shaBefore,
    `before=${shaBefore} after=${shaAfter} released=${RELEASED_SHA256} is_released=${shaAfter === RELEASED_SHA256}`);

  /* The three conclusions this measurement exists to support. */
  const hiddenSequence = hidden.sequence || { checks: [] };
  const hiddenGreen = hiddenSequence.checks.length > 0 && hiddenSequence.checks.every((check) => check.ok === true);
  record('THE ROUTED HIDDEN SEQUENCE PASSED END TO END', hiddenGreen,
    `${hiddenSequence.checks.filter((check) => check.ok).length}/${hiddenSequence.checks.length} checks in the hidden phase`);
  const plantedSequence = counterfactual && counterfactual.receipt && counterfactual.receipt.facts ? counterfactual.receipt.facts.sequence : null;
  if (!SKIP_COUNTERFACTUAL) {
    const plantedFailed = Boolean(plantedSequence) && plantedSequence.checks.some((check) => check.name.includes('answered ok:true') && check.ok === false);
    record('WITH THE ROUTING REMOVED THE HIDDEN SEQUENCE FAILED', plantedFailed, plantedSequence ? plantedSequence.checks.slice(0, 3).map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}`).join(' | ') : 'the planted phase produced no sequence');
    const restoredGreen = Boolean(restored && restored.receipt && restored.receipt.facts && restored.receipt.facts.sequence)
      && restored.receipt.facts.sequence.checks.every((check) => check.ok === true);
    record('WITH THE FILE RESTORED THE HIDDEN SEQUENCE PASSED AGAIN', restoredGreen,
      restored && restored.receipt && restored.receipt.facts && restored.receipt.facts.sequence
        ? `${restored.receipt.facts.sequence.checks.filter((check) => check.ok).length}/${restored.receipt.facts.sequence.checks.length} checks`
        : 'the restored phase produced no sequence');
  }
  const interactiveChecks = interactive.sequence ? interactive.sequence.checks : [];
  record('THE INTERACTIVE CONTROL STILL PASSES', interactiveChecks.length > 0 && interactiveChecks.every((check) => check.ok === true),
    `${interactiveChecks.filter((check) => check.ok).length}/${interactiveChecks.length} checks on this desktop`);

  /* The conclusion the planted survivor exists to support, stated on its own so a reader sees
   * that the teardown check has been observed BOTH ways in one run. It is recorded only when the
   * plant actually ran: `--skip-counterfactual` removes the phase, and a skipped phase is not a
   * failure - but it is also not a pass of this conclusion, so it is not recorded as one. */
  if (!SKIP_COUNTERFACTUAL) {
    const survivorChecks = survivor && survivor.receipt && survivor.receipt.checks ? survivor.receipt.checks : [];
    const survivorRed = survivorChecks.filter((check) => check.name.includes('PLANTED SURVIVOR') || check.name.includes('still held') || check.name.includes('SURVIVED'));
    record('THE TEARDOWN WENT RED ON A PLANTED SURVIVOR AND GREEN ON A HELD ONE IN THE SAME RUN',
      survivorRed.length >= 3 && survivorRed.every((check) => check.ok === true) && hidden.sequence
        && hidden.sequence.checks.filter((check) => check.name.includes('every process it started is gone')).every((check) => check.ok === true),
      survivorRed.map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}`).join(' | '));
  } else {
    note('the planted survivor was NOT run in this pass', '--skip-counterfactual removes the routing counterfactual AND the no-job plant, so the conclusion that the teardown has been observed red is not asserted here');
  }

  TRACK.facts.phases = { hidden, counterfactual, restored, survivor, interactive, notepad };
  return finalize(TRACK.checks.every((check) => check.ok) ? 0 : 1);
}

function finalize(exitCode) {
  const failed = TRACK.checks.filter((check) => check.ok !== true);
  const receipt = {
    stamp: STAMP,
    script: 'scripts/measure-cu-hidden-route.mjs',
    component_entry: COMPONENT_ENTRY,
    released_sha256: RELEASED_SHA256,
    component_sha256: (() => { try { return sha256Of(COMPONENT_ENTRY); } catch { return null; } })(),
    evidence_dir: OUT,
    finished_at: new Date().toISOString(),
    passed: TRACK.checks.length - failed.length,
    failed: failed.length,
    checks: TRACK.checks,
    notes: TRACK.notes,
    facts: TRACK.facts,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  if (PHASE) {
    /* A child phase leaves its own receipt where the parent expects to find it. */
    fs.writeFileSync(path.join(OUT, `phase-${PHASE}.json`), `${JSON.stringify({ phase: PHASE, checks: TRACK.checks, notes: TRACK.notes, facts: TRACK.facts }, null, 2)}\n`, 'utf8');
  }
  say(`\nreceipt: ${path.join(OUT, PHASE ? `phase-${PHASE}.json` : 'receipt.json')}`);
  say(`\nCU HIDDEN ROUTE: ${receipt.passed} passed, ${receipt.failed} failed (of ${TRACK.checks.length})`);
  say(receipt.failed === 0 ? 'HIDDEN ROUTE MEASUREMENT PASS' : 'HIDDEN ROUTE MEASUREMENT FAIL');
  process.exit(exitCode);
}

if (PHASE === 'hidden' || PHASE === 'planted' || PHASE === 'restored' || PHASE === 'no-job') {
  const result = await phaseHidden(PHASE);
  TRACK.facts.phase = PHASE;
  TRACK.facts.sequence = result.sequence;
  TRACK.facts.stopped = result.stopped;
  TRACK.facts.started = result.started;
  finalize(TRACK.checks.every((check) => check.ok) ? 0 : 1);
} else {
  await main();
}
