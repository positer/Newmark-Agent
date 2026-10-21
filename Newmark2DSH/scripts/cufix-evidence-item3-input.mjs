#!/usr/bin/env node
/**
 * cufix item 3 evidence: do keystrokes and scroll actually reach web content?
 *
 * The recorded symptom: with Edge verified as the foreground window, `^0` did not reset the
 * page zoom and `scroll` did not move the page - "the window was foreground; the web content
 * was not receiving input."
 *
 * Keyboard events go to the *focused* window (a child renderer window in a browser), not to
 * the foreground window; wheel events go to whatever window is under the cursor. So this run
 * measures, against a real page that reports its own state through `document.title`:
 *
 *   GetGUIThreadInfo(edgeThread).hwndFocus   who receives a keystroke
 *   the renderer child window                the window that actually holds the document
 *   the window under the scroll point        who receives a wheel event
 *   then the real actions: `key` and `scroll`, with before/after page state
 *
 * The probe window is closed in a `finally`, so a run never leaves a browser behind.
 *
 * Usage: node Newmark2DSH/scripts/cufix-evidence-item3-input.mjs <evidenceDir> [edgeExe]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const evidenceDir = path.resolve(process.argv[2] || '.');
const edgeExe = process.argv[3] || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const pagePath = path.join(evidenceDir, 'cufix-probe-page.html');
/* The workspace path contains a space ("Newmark Agent"), so the URL must be encoded: a raw
 * space makes the argument ambiguous and the browser loads a truncated path instead. */
const pageUrl = pathToFileURL(pagePath).href;
const READER = new URL('../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href;

const mod = await import(READER);
const { runComputerUse, runInLane, prepareLane, stopAll } = mod;
const call = async (options) => JSON.parse(await runComputerUse(options));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const evidence = {
  item: 3,
  claim: 'a keystroke and a scroll both reach the web content of a verified-foreground browser window',
  started_at: new Date().toISOString(),
};

function check(name, value, detail) {
  evidence.checks = evidence.checks || {};
  evidence.checks[name] = value === true;
  if (value !== true) evidence.check_details = { ...(evidence.check_details || {}), [name]: detail === undefined ? null : detail };
  console.log(`[item3] ${value === true ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` -- ${JSON.stringify(detail)}`}`);
}

/** The page's own state, out of the window title it maintains. */
function parseProbeTitle(title) {
  const log = /k=\[([^\]]*)\]/.exec(title);
  const width = / w=(\d+)/.exec(title);
  const y = / y=(\d+)/.exec(title);
  const focus = / f=([^ ]*)/.exec(title);
  const dpr = / d=([\d.]+)/.exec(title);
  const value = / v=("(?:[^"\\]|\\.)*")/.exec(title);
  let parsedValue = null;
  if (value) { try { parsedValue = JSON.parse(value[1]); } catch { parsedValue = null; } }
  return {
    raw_title: title,
    /* The page logs every keydown it receives: this is proof of arrival, independent of any
     * effect the chord was supposed to have. `^C` is control, `^S` shift, `^A` alt. */
    key_log: log ? log[1] : null,
    inner_width: width ? Number(width[1]) : null,
    scroll_y: y ? Number(y[1]) : null,
    focus: focus ? focus[1] : null,
    device_pixel_ratio: dpr ? Number(dpr[1]) : null,
    value: parsedValue,
  };
}

async function readPage() {
  const listed = await call({ action: 'app_list', includeOccluded: true });
  if (listed.ok !== true) return { error_code: listed.error_code || null, error: listed.error || null };
  const app = (listed.applications || []).find(candidate => /cufix/i.test(String(candidate.title)));
  if (!app) return { error: 'the probe window is no longer listed' };
  return { handle: app.handle, ...parseProbeTitle(String(app.title)) };
}

/** Focus facts: who owns the foreground, and which HWND would receive a keystroke. */
async function focusFacts(handle) {
  await prepareLane('windows', 20000);
  const lines = [
    'if (-not ("CufixFocus" -as [type])) {',
    '  Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Collections.Generic;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public static class CufixFocus {',
    '  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret; }',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
    '  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern IntPtr GetFocus();',
    '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachFlag);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);',
    '  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);',
    '  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);',
    '  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetClassNameW")] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);',
    '  public delegate bool EnumProc(IntPtr hWnd, IntPtr param);',
    '  public static string ClassOf(IntPtr h) { StringBuilder t = new StringBuilder(256); GetClassNameW(h, t, 256); return t.ToString(); }',
    '  public static string Hex(IntPtr h) { return "0x" + h.ToInt64().ToString("X"); }',
    '  public static string Describe(IntPtr h) { return Hex(h) + " " + ClassOf(h); }',
    '  public static uint ForegroundThread() { return GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero); }',
    '  public static string[] FocusFacts() {',
    '    IntPtr foreground = GetForegroundWindow();',
    '    uint thread = GetWindowThreadProcessId(foreground, IntPtr.Zero);',
    '    GUITHREADINFO info = new GUITHREADINFO();',
    '    info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));',
    '    bool ok = GetGUIThreadInfo(thread, ref info);',
    '    uint own = GetCurrentThreadId();',
    '    bool attached = AttachThreadInput(own, thread, true);',
    '    string attachedFocus = "n/a";',
    '    try { attachedFocus = Describe(GetFocus()); } finally { if (attached) AttachThreadInput(own, thread, false); }',
    '    return new string[] { Hex(foreground), Describe(foreground), thread.ToString(), ok.ToString(), Hex(info.hwndFocus), Describe(info.hwndFocus), Describe(info.hwndActive), attachedFocus };',
    '  }',
    '  public static List<string> Children(IntPtr root) { List<string> rows = new List<string>(); EnumChildWindows(root, delegate(IntPtr h, IntPtr p) { rows.Add(Describe(h)); return true; }, IntPtr.Zero); return rows; }',
    '  public static string AtClientCentre(IntPtr root) {',
    '    RECT client; GetClientRect(root, out client);',
    '    POINT point = new POINT(); point.X = (client.Right - client.Left) / 2; point.Y = (client.Bottom - client.Top) / 2;',
    '    ClientToScreen(root, ref point);',
    '    IntPtr at = WindowFromPoint(point);',
    '    return "point=" + point.X + "," + point.Y + " windowUnderPoint=" + Describe(at) + " root=" + Describe(GetAncestor(at, 2));',
    '  }',
    '}',
    '\'@',
    '}',
    `$hwnd = [IntPtr]::new([Convert]::ToInt64('${String(handle).replace(/^0x/i, '')}', 16))`,
    '$facts = [CufixFocus]::FocusFacts()',
    'Write-Output (@{ foreground=$($facts[0]); foreground_desc=$($facts[1]); foreground_thread=[int]$facts[2]; gui_thread_info_ok=($facts[3] -eq "True"); hwnd_focus=$($facts[4]); hwnd_focus_desc=$($facts[5]); hwnd_active_desc=$($facts[6]); get_focus_via_attach=$($facts[7]); children=[CufixFocus]::Children($hwnd); under_point=[CufixFocus]::AtClientCentre($hwnd) } | ConvertTo-Json -Compress -Depth 5)',
  ];
  const result = await runInLane('windows', lines.join('\r\n'), 40000);
  if (!result || result.ok !== true) return { error: String(result && result.output).slice(0, 400) };
  const output = String(result.output).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = output.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(output[index]); } catch { /* keep looking */ }
  }
  return { error: `unreadable: ${String(result.output).slice(0, 400)}` };
}

let failure = null;
/* A profile directory per run. A reused one carries a stale Chromium singleton lock after a
 * forced kill, and then the launch silently never produces a window. */
const profileDir = path.join(os.tmpdir(), `cufix-edge-run-${process.pid}-${Date.now()}`);
evidence.edge_profile_dir = profileDir;

function closeMyEdge() {
  try {
    const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(profileDir)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', timeout: 30000 });
    evidence.edge_closed = true;
  } catch (error) {
    evidence.edge_closed = false;
    evidence.edge_close_error = error instanceof Error ? error.message : String(error);
  }
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch { /* the profile is disposable */ }
}

try {
  const edge = spawn(edgeExe, [
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--no-service-autorun', '--disable-sync',
    '--new-window', pageUrl,
  ], { detached: true, stdio: 'ignore' });
  edge.unref();
  evidence.page_url = pageUrl;

  let probe = null;
  for (let i = 0; i < 120 && !probe; i += 1) {
    const listed = await call({ action: 'app_list', includeOccluded: true });
    if (listed.ok !== true) {
      evidence.app_list_failures = [...(evidence.app_list_failures || []), { error_code: listed.error_code || null, error: listed.error || null }];
    } else {
      /* The probe page puts its own state in the window title, so the title is the identity:
       * matching on the window class would fail, because a Chromium top-level window's class
       * is Chrome_WidgetWin_1 and does not contain the browser's name. */
      probe = (listed.applications || []).find(app => /cufix/i.test(String(app.title)));
      evidence.app_list_last = { ok: true, count: listed.count, matched: probe ? probe.handle : null };
    }
    if (!probe) await sleep(700);
  }
  evidence.probe_window = probe ? { handle: probe.handle, title: String(probe.title).slice(0, 120) } : null;
  if (!probe) throw new Error('the Edge probe window never appeared');

  /* --- activate and verify, so "foreground" is a measurement and not an assumption --- */
  const activated = await call({ action: 'app_activate', windowHandle: probe.handle });
  evidence.activation = {
    ok: activated.ok,
    foreground_verified: activated.foreground_verified === undefined ? null : activated.foreground_verified,
    foreground_handle: activated.foreground_handle || null,
    technique: activated.activation_technique || null,
  };
  console.log(`[item3] activation: ${JSON.stringify(evidence.activation)}`);
  check('the browser window is really the foreground window before input is sent',
    activated.ok === true && activated.foreground_verified === true,
    evidence.activation);

  /* --- who would receive a keystroke --- */
  const facts = await focusFacts(probe.handle);
  evidence.focus = facts;
  console.log(`[item3] focus facts: ${JSON.stringify({ foreground: facts.foreground, hwnd_focus: facts.hwnd_focus, hwnd_focus_desc: facts.hwnd_focus_desc, get_focus_via_attach: facts.get_focus_via_attach, under_point: facts.under_point })}`);

  const rendererChild = (facts.children || []).find(entry => /Chrome_RenderWidgetHostHWND/.test(entry));
  evidence.renderer_child = rendererChild || null;
  const focusedIsRenderer = Boolean(rendererChild) && String(facts.hwnd_focus || '').toLowerCase() === String(rendererChild.split(' ')[0]).toLowerCase();
  const focusedIsTopLevel = String(facts.hwnd_focus || '').toLowerCase() === String(facts.foreground || '').toLowerCase();
  evidence.focus_verdict = {
    focused_hwnd: facts.hwnd_focus || null,
    focused_is_the_renderer_child: focusedIsRenderer,
    focused_is_the_top_level_window: focusedIsTopLevel,
  };
  console.log(`[item3] focus verdict: ${JSON.stringify(evidence.focus_verdict)}`);

  /* --- the actual keystroke test: change the zoom and read the page back --- */
  const before = await readPage();
  evidence.before_zoom_test = before;
  console.log(`[item3] page before: innerWidth=${before.inner_width} scrollY=${before.scroll_y}`);

  /* Zoom out with ctrl+- and reset with ctrl+0. Both are single-character bases, so both are
   * real chords. Zoom out changes innerWidth and devicePixelRatio; ctrl+0 restores both.
   *
   * Delivery is asserted from the page's own key log, not from the width alone: ctrl+0 on a
   * page that is already at 100% changes nothing, so "the page changed" cannot be the only
   * test of whether the chord arrived. Another ComputerUse owner is active on this desktop and
   * can take the foreground between two calls, so the attempt is retried and every attempt is
   * recorded rather than the last one being reported as if it were the first. */
  const sendChord = async (key) => {
    const attempts = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const before = await readPage();
      const response = await call({ action: 'key', windowHandle: probe.handle, key });
      await sleep(700);
      const after = await readPage();
      const arrived = typeof before.key_log === 'string' && typeof after.key_log === 'string' && after.key_log !== before.key_log;
      attempts.push({
        attempt,
        response,
        key_log_before: before.key_log,
        key_log_after: after.key_log,
        inner_width_before: before.inner_width,
        inner_width_after: after.inner_width,
        device_pixel_ratio_before: before.device_pixel_ratio,
        device_pixel_ratio_after: after.device_pixel_ratio,
        arrived_at_the_page: arrived,
      });
      if (arrived) break;
    }
    return { key, attempts, arrived: attempts.some(item => item.arrived_at_the_page), response: attempts[attempts.length - 1].response, before: attempts[0], after: attempts[attempts.length - 1] };
  };

  const baseline = await readPage();
  evidence.baseline = baseline;
  console.log(`[item3] page baseline: innerWidth=${baseline.inner_width} dpr=${baseline.device_pixel_ratio} scrollY=${baseline.scroll_y} keyLog=${JSON.stringify(baseline.key_log)}`);

  const zoomOut = await sendChord('ctrl+-');
  evidence.zoom_out = zoomOut;
  console.log(`[item3] ctrl+- : keyLog ${JSON.stringify(zoomOut.before.key_log_after)} innerWidth ${zoomOut.before.inner_width_before} -> ${zoomOut.after.inner_width_after} dpr ${zoomOut.before.device_pixel_ratio_before} -> ${zoomOut.after.device_pixel_ratio_after}`);

  const reset = await sendChord('ctrl+0');
  evidence.zoom_reset = reset;
  console.log(`[item3] ctrl+0 : keyLog ${JSON.stringify(reset.after.key_log_after)} innerWidth -> ${reset.after.inner_width_after} dpr -> ${reset.after.device_pixel_ratio_after}`);

  /* The two claims that matter, kept separate: the chord reached the page, and the page acted
   * on it. The first is proof of delivery; the second is proof the web content received it. */
  check('a keystroke reaches the page (its own keydown log records the chord)',
    zoomOut.arrived === true && reset.arrived === true,
    { zoom_out_attempts: zoomOut.attempts.map(item => item.arrived_at_the_page), reset_attempts: reset.attempts.map(item => item.arrived_at_the_page) });
  check('the page acts on the chord: ctrl+- changes the zoom',
    zoomOut.after.inner_width_after !== zoomOut.before.inner_width_before
      && zoomOut.after.device_pixel_ratio_after !== zoomOut.before.device_pixel_ratio_before,
    { inner_width: [zoomOut.before.inner_width_before, zoomOut.after.inner_width_after], dpr: [zoomOut.before.device_pixel_ratio_before, zoomOut.after.device_pixel_ratio_after] });
  check('ctrl+0 restores the page zoom to the baseline',
    reset.after.inner_width_after === baseline.inner_width && reset.after.device_pixel_ratio_after === baseline.device_pixel_ratio,
    { baseline: [baseline.inner_width, baseline.device_pixel_ratio], after_reset: [reset.after.inner_width_after, reset.after.device_pixel_ratio_after] });
  /* The focus step is what makes the two above possible: a keystroke only reaches the page
   * when keyboard focus sits on the window that carries it into the document. */
  const focusEngaged = [zoomOut, reset].some(run => run.attempts.some(item => item.response.focus_verified === true && item.response.focus_target_is_top_level === false));
  evidence.focus_engaged = focusEngaged;
  check('keyboard focus was placed on the document window, not the frame, before the chord',
    focusEngaged,
    { zoom_out_focus: zoomOut.attempts.map(item => item.response.focus_target_class || null) });

  /* --- the scroll test: a wheel event over the page must move it --- */
  const beforeScroll = await readPage();
  /* The scroll must land on the page, so the point comes from the probe's own measurement of
   * what sits at the client centre - falling back to the client centre itself. */
  const scrollPoint = (() => {
    const underPoint = String(facts.under_point || '');
    const match = /point=(\d+),(\d+)/.exec(underPoint);
    if (match) return { x: Number(match[1]), y: Number(match[2]) };
    const rect = probe.client_rect || {};
    if (Number.isFinite(Number(rect.width)) && Number.isFinite(Number(rect.height))) {
      return { x: Math.round(Number(rect.x) + Number(rect.width) / 2), y: Math.round(Number(rect.y) + Number(rect.height) / 2) };
    }
    return null;
  })();
  evidence.scroll_point = scrollPoint;
  const scrolled = scrollPoint
    /* A positive scroll_y scrolls the page down; the backend negates it into the wheel delta,
     * and a positive wheel delta would scroll up - which from scrollY 0 moves nothing. */
    ? await call({ action: 'scroll', windowHandle: probe.handle, x: scrollPoint.x, y: scrollPoint.y, scrollX: 0, scrollY: 600 })
    : { ok: false, error_code: 'no_scroll_point' };
  await sleep(900);
  const afterScroll = await readPage();
  evidence.scroll = {
    response: scrolled,
    scroll_y_before: beforeScroll.scroll_y,
    scroll_y_after: afterScroll.scroll_y,
    moved: typeof afterScroll.scroll_y === 'number' && typeof beforeScroll.scroll_y === 'number' && afterScroll.scroll_y !== beforeScroll.scroll_y,
  };
  console.log(`[item3] scroll response: ${JSON.stringify(scrolled)}`);
  console.log(`[item3] scroll: scrollY ${beforeScroll.scroll_y} -> ${afterScroll.scroll_y}`);
  check('a scroll moves the web page',
    evidence.scroll.moved === true,
    { before: beforeScroll.scroll_y, after: afterScroll.scroll_y, response: evidence.scroll.response });

  evidence.finished_at = new Date().toISOString();
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
} finally {
  closeMyEdge();
}

evidence.outcome = failure ? 'ERROR' : Object.values(evidence.checks || {}).every(Boolean) ? 'PASS' : 'FAIL';
if (failure) evidence.error = failure;
evidence.failed_checks = Object.entries(evidence.checks || {}).filter(([, value]) => value !== true).map(([name]) => name);

fs.mkdirSync(evidenceDir, { recursive: true });
const outPath = path.join(evidenceDir, 'cufix-item3-web-content-input.json');
fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`[item3] outcome=${evidence.outcome} failed_checks=${evidence.failed_checks.join(',') || 'none'}`);
console.log(`[item3] wrote ${outPath}`);

stopAll();
process.exit(evidence.outcome === 'PASS' ? 0 : 1);
