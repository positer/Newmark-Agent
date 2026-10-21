#!/usr/bin/env node
/**
 * cufix item 2 evidence: `app_activate` may not report a window as foreground that is not.
 *
 * The run measures three things and writes each one:
 *   1. what `app_activate` reported (`foreground_verified`, `foreground_handle`, `app.foreground`)
 *   2. what an *independent* fresh lane request reads back from `GetForegroundWindow()`
 *      immediately afterwards - handle, title, class, pid, read over the `windows` lane, so
 *      the reading does not come from the same lane request that did the activating
 *   3. what the tool says when the activation genuinely cannot succeed: a structured failure
 *      that names the window which really holds the foreground
 *
 * Usage: node Newmark2DSH/scripts/cufix-evidence-item2-foreground.mjs <evidenceDir> [edgeExe]
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
const overlay = await import(new URL('../packages/newmark-core/components/computeruse/lib/overlay-win32.js', import.meta.url).href);
const { runComputerUse, stopAll, runInLane, prepareLane } = mod;

const evidence = {
  item: 2,
  claim: 'app_activate reports the foreground it measured, never a window that is not foreground',
  started_at: new Date().toISOString(),
  steps: [],
};
const call = async (options) => JSON.parse(await runComputerUse(options));

/** Who really holds the foreground, read over the windows lane, independently of the tool. */
async function realForeground() {
  await prepareLane('windows', 20000);
  const script = [
    '$fg = [NewmarkCuNative]::GetForegroundWindow()',
    'Write-Output (@{ handle=("0x{0:X}" -f $fg.ToInt64()); title=[NewmarkCuNative]::WindowTitle($fg); class_name=[NewmarkCuNative]::ClassName($fg); process_id=[NewmarkCuNative]::GetProcessId($fg); minimized=[NewmarkCuNative]::IsIconic($fg) } | ConvertTo-Json -Compress)',
  ].join('\r\n');
  const result = await runInLane('windows', script, 20000);
  if (!result || result.ok !== true) return { error: result ? String(result.output).slice(0, 400) : 'lane call failed' };
  const lines = String(result.output).split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* keep looking */ }
  }
  return { error: `unreadable: ${String(result.output).slice(0, 400)}` };
}

/**
 * The Edge window this run owns, matched on the probe page's own title channel.
 *
 * `include_occluded` is on so the probe window is still found when the DSH window is in
 * front of it, and a failed listing is reported instead of being read as "no windows".
 */
async function findProbeWindow() {
  const listed = await call({ action: 'app_list', includeOccluded: true });
  if (listed.ok !== true) {
    evidence.app_list_failures = [...(evidence.app_list_failures || []), { error_code: listed.error_code || null, error: listed.error || null }];
    return null;
  }
  const applications = listed.applications || [];
  evidence.app_list_seen = applications.map(app => ({ handle: app.handle, title: app.title, class_name: app.class_name, foreground: app.foreground }));
  return applications.find(app => /cufix/i.test(app.title) && /edge/i.test(app.class_name || ''))
    || applications.find(app => /cufix/i.test(app.title))
    || null;
}

async function waitForProbeWindow(timeoutMs) {
  const from = Date.now();
  while (Date.now() - from < timeoutMs) {
    const found = await findProbeWindow();
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  return null;
}

function check(name, value, detail) {
  evidence.checks = evidence.checks || {};
  evidence.checks[name] = value === true;
  if (value !== true) evidence.check_details = { ...(evidence.check_details || {}), [name]: detail === undefined ? null : detail };
  console.log(`[item2] ${value === true ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` -- ${JSON.stringify(detail)}`}`);
}

let edge = null;
let fixture = null;
let failure = null;

/* An isolated profile directory on purpose, one per run. Launching the probe in the user's own
 * profile reuses their window (and therefore their tabs), and the probe types and scrolls - it
 * must never be able to reach a page the user has open. A *fresh* directory also matters: a
 * reused one carries a stale Chromium singleton lock after a forced kill, and the launch then
 * silently never produces a window. The finally below removes it. */
const profileDir = path.join(os.tmpdir(), `cufix-edge-item2-${process.pid}-${Date.now()}`);

try {
  evidence.edge_profile_dir = profileDir;
  edge = spawn(edgeExe, [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-sync',
    '--new-window',
    pageUrl,
  ], { detached: true, stdio: 'ignore' });
  edge.unref();
  evidence.edge_launched = { pid: edge.pid, page: pagePath };

  const probe = await waitForProbeWindow(90000);
  evidence.probe_window = probe;
  if (!probe) throw new Error('the Edge probe window never appeared in app_list');
  console.log(`[item2] probe window ${probe.handle} "${probe.title}"`);

  /* --- 1. put the DSH window in front, so the target is genuinely NOT foreground --- */
  const dsh = (await call({ action: 'app_list', includeOccluded: true })).applications.find(app => /DeepSeek Harness/i.test(app.title));
  evidence.dsh_window = dsh ? { handle: dsh.handle, title: dsh.title } : null;
  if (dsh) await call({ action: 'app_activate', windowHandle: dsh.handle, dryRun: false });
  evidence.foreground_before = await realForeground();
  console.log(`[item2] foreground before: ${JSON.stringify(evidence.foreground_before)}`);

  /* --- 2. activate the Edge probe window and compare the claim with the reading --- */
  const activated = await call({ action: 'app_activate', windowHandle: probe.handle });
  const readingRightAfter = await realForeground();
  evidence.activation = {
    reported: {
      ok: activated.ok,
      error_code: activated.error_code || null,
      error: activated.error || null,
      foreground_verified: activated.foreground_verified,
      foreground_is_target: activated.foreground_is_target,
      foreground_handle: activated.foreground_handle,
      foreground_title: activated.foreground_title,
      foreground_process_id: activated.foreground_process_id,
      activation_technique: activated.activation_technique,
      activation_attempts: activated.activation_attempts,
      activation_verified_attempts: activated.activation_verified_attempts,
      app_foreground: activated.app ? activated.app.foreground : null,
      expected_handle: activated.expected_handle || null,
      foreground: activated.foreground || null,
    },
    independent_reading_right_after: readingRightAfter,
    target_handle: String(probe.handle),
  };
  console.log(`[item2] reported=${JSON.stringify(evidence.activation.reported)}`);
  console.log(`[item2] independent read=${JSON.stringify(readingRightAfter)}`);

  const reported = evidence.activation.reported;
  const readingIsTarget = String(readingRightAfter.handle || '').toLowerCase() === String(probe.handle).toLowerCase();
  check('the tool never claims foreground_verified for a window that is not foreground',
    reported.foreground_verified !== true || readingIsTarget,
    { reported_foreground_verified: reported.foreground_verified, reading: readingRightAfter.handle, target: probe.handle });
  check('the reported foreground handle equals the independently read GetForegroundWindow handle',
    reported.ok === true && String(reported.foreground_handle || '').toLowerCase() === String(readingRightAfter.handle || '').toLowerCase(),
    { reported: reported.foreground_handle, read: readingRightAfter.handle });
  check('a successful app_activate leaves app.foreground and foreground_verified in agreement',
    !(reported.ok === true) || reported.app_foreground === reported.foreground_verified,
    { app_foreground: reported.app_foreground, foreground_verified: reported.foreground_verified });
  check('a successful app_activate really put the target in the foreground',
    !(reported.ok === true) || (readingIsTarget && reported.foreground_verified === true),
    { reading: readingRightAfter.handle, target: probe.handle, verified: reported.foreground_verified });

  /* --- 3. the failure path: a target that can never be the foreground window --- */
  /* A child HWND is the right fixture. `GetForegroundWindow()` only ever returns a
   * top-level window, so activating a child raises its root instead and the measured
   * foreground can never equal the child handle. That is a realistic mistake too: a model
   * holding a control handle from a window listing can pass it to `app_activate`. */
  const childHandle = await (async () => {
    await prepareLane('windows', 20000);
    const lines = [
      'if (-not ("CufixChildProbe" -as [type])) {',
      '  Add-Type -TypeDefinition @\'',
      'using System;',
      'using System.Collections.Generic;',
      'using System.Runtime.InteropServices;',
      'using System.Text;',
      'public static class CufixChildProbe {',
      '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);',
      '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);',
      '  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);',
      '  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetClassNameW")] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);',
      '  public delegate bool EnumProc(IntPtr hWnd, IntPtr param);',
      '  public static List<IntPtr> Children(IntPtr root) {',
      '    List<IntPtr> rows = new List<IntPtr>();',
      '    EnumChildWindows(root, delegate(IntPtr h, IntPtr p) { rows.Add(h); return true; }, IntPtr.Zero);',
      '    return rows;',
      '  }',
      '  public static string ClassOf(IntPtr h) { StringBuilder t = new StringBuilder(256); GetClassNameW(h, t, 256); return t.ToString(); }',
      '}',
      '\'@',
      '}',
      `$root = [IntPtr]::new([Convert]::ToInt64('${String(probe.handle).replace(/^0x/i, '')}', 16))`,
      '$children = [CufixChildProbe]::Children($root)',
      '$picked = [IntPtr]::Zero',
      '$pickedClass = ""',
      'foreach ($child in $children) {',
      '  $cls = [CufixChildProbe]::ClassOf($child)',
      '  if ($cls -eq "Chrome_RenderWidgetHostHWND") { $picked = $child; $pickedClass = $cls; break }',
      '  if ($picked -eq [IntPtr]::Zero) { $picked = $child; $pickedClass = $cls }',
      '}',
      'Write-Output (@{ child=("0x{0:X}" -f $picked.ToInt64()); child_class=$pickedClass; child_is_window=[CufixChildProbe]::IsWindow($picked); child_count=$children.Count; child_is_not_root=($picked -ne $root); child_root=("0x{0:X}" -f ([CufixChildProbe]::GetAncestor($picked, 2)).ToInt64()); root=("0x{0:X}" -f $root.ToInt64()) } | ConvertTo-Json -Compress)',
    ];
    const result = await runInLane('windows', lines.join('\r\n'), 40000);
    if (!result || result.ok !== true) return { error: String(result && result.output).slice(0, 400) };
    const output = String(result.output).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let index = output.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(output[index]); } catch { /* keep looking */ }
    }
    return { error: `unreadable: ${String(result.output).slice(0, 400)}` };
  })();
  evidence.refusal_target = childHandle;
  if (childHandle && childHandle.child && childHandle.child_is_window === true && childHandle.child_is_not_root === true) {
    if (dsh) await call({ action: 'app_activate', windowHandle: dsh.handle });
    const holderBefore = await realForeground();
    const refused = await call({ action: 'app_activate', windowHandle: childHandle.child });
    const readingAfterRefusal = await realForeground();
    evidence.refusal = {
      reported: {
        ok: refused.ok,
        error_code: refused.error_code || null,
        error: refused.error || null,
        foreground_verified: refused.foreground_verified,
        foreground_is_target: refused.foreground_is_target === undefined ? null : refused.foreground_is_target,
        expected_handle: refused.expected_handle || null,
        foreground: refused.foreground || null,
        activation_attempts: refused.activation_attempts === undefined ? null : refused.activation_attempts,
        activation_technique: refused.activation_technique === undefined ? null : refused.activation_technique,
      },
      holder_before_the_attempt: holderBefore,
      independent_reading_after: readingAfterRefusal,
      target_handle: String(childHandle.child),
      target_is_a_child_window_of: String(childHandle.root),
      why_it_cannot_succeed: 'GetForegroundWindow() never returns a child window, so the measured foreground cannot equal the child handle',
    };
    console.log(`[item2] refusal=${JSON.stringify(evidence.refusal.reported)}`);
    check('an activation that cannot leave the target in the foreground is a structured failure, not a success',
      refused.ok === false && refused.error_code === 'foreground_not_granted',
      { ok: refused.ok, error_code: refused.error_code });
    check('the refusal never carries foreground_verified: true',
      refused.foreground_verified !== true,
      { foreground_verified: refused.foreground_verified });
    check('the refusal names the window that really holds the foreground',
      Boolean(refused.foreground) && String(refused.foreground.handle || '').toLowerCase() === String(readingAfterRefusal.handle || '').toLowerCase(),
      { named: refused.foreground ? refused.foreground.handle : null, read: readingAfterRefusal.handle });
    check('the refusal names the expected target handle',
      String(refused.expected_handle || '').toLowerCase() === String(childHandle.child).toLowerCase(),
      { expected: refused.expected_handle, target: childHandle.child });
    check('the refusal reports the foreground it measured, not the target it wanted',
      Boolean(refused.foreground) && String(refused.foreground.handle || '').toLowerCase() !== String(childHandle.child).toLowerCase(),
      { named: refused.foreground ? refused.foreground.handle : null, target: childHandle.child });
  } else {
    evidence.refusal = { skipped: 'no child window of the probe window could be resolved', probe: childHandle };
    console.log('[item2] no child window fixture, the refusal path was not measured');
    check('the refusal fixture resolved a child window', false, { probe: childHandle });
  }
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
} finally {
  try { if (fixture && fixture.pid) process.kill(fixture.pid); } catch { /* already gone */ }
  try { await overlay.stopOverlay({ reason: 'cufix_item2_done' }); } catch { /* nothing to stop */ }
  /* Never leave a browser window behind. The profile directory identifies this run's own
   * processes, so the cleanup cannot touch any other browser the user has open. */
  try {
    execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(profileDir)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore', timeout: 30000 });
    evidence.edge_closed = true;
  } catch (closeError) {
    evidence.edge_closed = false;
    evidence.edge_close_error = closeError instanceof Error ? closeError.message : String(closeError);
  }
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* disposable */ }
  evidence.finished_at = new Date().toISOString();
}

evidence.outcome = failure ? 'ERROR' : Object.values(evidence.checks || {}).every(Boolean) ? 'PASS' : 'FAIL';
if (failure) evidence.error = failure;
evidence.failed_checks = Object.entries(evidence.checks || {}).filter(([, value]) => value !== true).map(([name]) => name);

fs.mkdirSync(evidenceDir, { recursive: true });
const outPath = path.join(evidenceDir, 'cufix-item2-foreground.json');
fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`[item2] outcome=${evidence.outcome}`);
console.log(`[item2] wrote ${outPath}`);

stopAll();
process.exit(evidence.outcome === 'PASS' ? 0 : 1);
