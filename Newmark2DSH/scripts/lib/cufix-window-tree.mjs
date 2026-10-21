/**
 * The real child-window tree of a top-level window, plus the window that actually holds
 * keyboard focus. Both are needed: item 2 needs a child HWND as a refusal fixture, and
 * item 3 needs to know whether focus sits on the browser's render widget.
 *
 * Usage: node Newmark2DSH/scripts/lib/cufix-window-tree.mjs <handle-hex>
 */
const mod = await import(new URL('../../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);
const handle = process.argv[2];

await mod.prepareLane('windows', 20000);
const script = [
  'if (-not ("CufixTree" -as [type])) {',
  '  Add-Type -TypeDefinition @\'',
  'using System;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class CufixTree {',
  '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);',
  '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetClassNameW")] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetWindowTextW")] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
  '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] public static extern IntPtr GetFocus();',
  '  public delegate bool EnumProc(IntPtr hWnd, IntPtr param);',
  '  public static string Describe(IntPtr h) {',
  '    StringBuilder cls = new StringBuilder(256); GetClassNameW(h, cls, 256);',
  '    StringBuilder txt = new StringBuilder(256); GetWindowTextW(h, txt, 256);',
  '    uint pid; GetWindowThreadProcessId(h, out pid);',
  '    return "0x" + h.ToInt64().ToString("X") + "|" + cls.ToString() + "|" + txt.ToString().Replace("|", " ") + "|visible=" + IsWindowVisible(h) + "|pid=" + pid;',
  '  }',
  '  public static List<string> Children(IntPtr root) {',
  '    List<string> rows = new List<string>();',
  '    EnumChildWindows(root, delegate(IntPtr h, IntPtr p) { rows.Add(Describe(h)); return true; }, IntPtr.Zero);',
  '    return rows;',
  '  }',
  '}',
  '\'@',
  '}',
  `$root = [IntPtr]::new([Convert]::ToInt64('${String(handle).replace(/^0x/i, '')}', 16))`,
  'Write-Output ("ROOT|" + [CufixTree]::Describe($root))',
  'foreach ($row in [CufixTree]::Children($root)) { Write-Output ("CHILD|" + $row) }',
  /* Who holds keyboard focus: GetFocus() only answers for the calling thread, so the
     foreground thread is attached first - the same technique the backend needs. */
  '$fg = [CufixTree]::GetForegroundWindow()',
  '$fgThread = [CufixTree]::GetWindowThreadProcessId($fg, [ref]([uint32]0))',
  'Write-Output ("FOREGROUND|" + [CufixTree]::Describe($fg))',
  'foreach ($row in [CufixTree]::Children($fg)) { Write-Output ("FOREGROUND_CHILD|" + $row) }',
].join('\r\n');
const result = await mod.runInLane('windows', script, 60000);
console.log(result.ok ? result.output : `LANE FAIL: ${result.output}`);
mod.stopAll();
process.exit(0);
