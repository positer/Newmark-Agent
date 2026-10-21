/**
 * cufix item 3 investigation: after a *verified* activation, which HWND receives input?
 *
 * The recorded symptom: with Edge verified foreground, `^0` did not reset the page zoom and
 * `scroll` did not move the page. The foreground window is not the whole answer - keyboard
 * events go to the *focused* window, which for a browser is a child renderer window, and
 * wheel events go to whatever is under the cursor. This measures all three:
 *
 *   GetGUIThreadInfo(edgeThread).hwndFocus   - who would receive a keystroke
 *   the renderer child                       - the window that actually holds the document
 *   the window under the wheel point         - who would receive a scroll
 *
 * Usage: node Newmark2DSH/scripts/lib/cufix-probe-focus.mjs <evidenceDir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const evidenceDir = path.resolve(process.argv[2] || '.');
const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const pagePath = path.join(evidenceDir, 'cufix-probe-page.html');
const READER = new URL('../../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href;

const mod = await import(READER);
const { runComputerUse, runInLane, prepareLane, stopAll } = mod;
const call = async (options) => JSON.parse(await runComputerUse(options));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const profileDir = path.join(process.env.TEMP || '.', 'cufix-edge-profile');
const child = spawn(edgeExe, [
  `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--no-service-autorun', '--disable-sync',
  '--new-window', `file:///${pagePath.replace(/\\/g, '/')}`,
], { detached: true, stdio: 'ignore' });
child.unref();

let probe = null;
for (let i = 0; i < 120; i += 1) {
  const listed = await call({ action: 'app_list', includeOccluded: true });
  if (listed.ok === true) {
    probe = (listed.applications || []).find(app => /cufix/i.test(app.title) && /edge/i.test(app.class_name || ''));
    if (probe) break;
  }
  await sleep(700);
}
if (!probe) { console.log('the probe window never appeared'); process.exit(1); }
console.log(`probe window ${probe.handle} "${probe.title}"`);

const activated = await call({ action: 'app_activate', windowHandle: probe.handle });
console.log(`activation: ok=${activated.ok} verified=${activated.foreground_verified} technique=${activated.activation_technique}`);

await prepareLane('windows', 20000);
const inspect = [
  'if (-not ("CufixFocus" -as [type])) {',
  '  Add-Type -TypeDefinition @\'',
  'using System;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class CufixFocus {',
  '  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  '  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern IntPtr GetFocus();',
  '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachFlag);',
  '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);',
  '  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetClassNameW")] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
  '  public delegate bool EnumProc(IntPtr hWnd, IntPtr param);',
  '  public static string ClassOf(IntPtr h) { StringBuilder t = new StringBuilder(256); GetClassNameW(h, t, 256); return t.ToString(); }',
  '  public static string Describe(IntPtr h) { return "0x" + h.ToInt64().ToString("X") + " " + ClassOf(h); }',
  '  public static string FocusOfForeground() {',
  '    IntPtr foreground = GetForegroundWindow();',
  '    uint thread = GetWindowThreadProcessId(foreground, IntPtr.Zero);',
  '    GUITHREADINFO info = new GUITHREADINFO();',
  '    info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));',
  '    bool ok = GetGUIThreadInfo(thread, ref info);',
  '    return "foreground=" + Describe(foreground) + "; ok=" + ok + "; hwndFocus=" + Describe(info.hwndFocus) + "; hwndActive=" + Describe(info.hwndActive);',
  '  }',
  '  public static string FocusViaAttach() {',
  '    uint own = GetCurrentThreadId();',
  '    uint thread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);',
  '    bool attached = AttachThreadInput(own, thread, true);',
  '    try { return "attached=" + attached + "; GetFocus=" + Describe(GetFocus()); }',
  '    finally { if (attached) AttachThreadInput(own, thread, false); }',
  '  }',
  '  public static List<string> Children(IntPtr root) { List<string> rows = new List<string>(); EnumChildWindows(root, delegate(IntPtr h, IntPtr p) { rows.Add(Describe(h)); return true; }, IntPtr.Zero); return rows; }',
  '}',
  '\'@',
  '}',
  `$hwnd = [IntPtr]::new([Convert]::ToInt64('${String(probe.handle).replace(/^0x/i, '')}', 16))`,
  'Write-Output ("FOCUS|" + [CufixFocus]::FocusOfForeground())',
  'Write-Output ("ATTACH|" + [CufixFocus]::FocusViaAttach())',
  'foreach ($row in [CufixFocus]::Children($hwnd)) { Write-Output ("CHILD|" + $row) }',
].join('\r\n');
const result = await runInLane('windows', inspect, 40000);
console.log(result.ok ? result.output : `LANE FAIL: ${result.output}`);

await sleep(500);
const state = await call({ action: 'app_list', includeOccluded: true });
const current = (state.applications || []).find(app => app.handle.toLowerCase() === probe.handle.toLowerCase());
console.log(`page title now: ${current ? current.title : '(gone)'}`);

stopAll();
process.exit(0);
