/**
 * What desktops and probe processes this line of work left behind.
 *
 * A leaked desktop is invisible to the person at the machine and therefore worse than a
 * leaked window, so the measurement's own claim ("nothing was left behind") is checked from
 * outside: this enumerates every desktop of the window station the probes were created on,
 * names the ones that carry this work's prefix, counts the top-level windows still on each,
 * and reports every process still attached to one.
 *
 * It writes nothing and closes only the handles it opens. Run it as the last step of a
 * measurement, or as the first step of the next one.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PWSH = process.env.NM_HIDDEN_PWSH || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'PowerShell', '7', 'pwsh.exe');
if (readFileSync) process.env.NEWMARK_CU_POWERSHELL = PWSH;

const PREFIX = process.env.NM_HIDDEN_DESKTOP_PREFIX || 'NmCuHidden';
const WINSTA = process.env.NM_HIDDEN_WINSTA || 'winsta0';

const mod = await import(new URL(`file://${path.join(REPO, 'packages', 'newmark-core', 'components', 'computeruse', 'lib', 'win32.js').replace(/\\/g, '/')}`));

const CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NmDeskAudit
{
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool EnumDesktopsW(IntPtr station, EnumDesktopProc callback, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenDesktopW(string name, int flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumDesktopWindows(IntPtr desktop, EnumWindowProc callback, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);

  public delegate bool EnumDesktopProc(IntPtr name, IntPtr lParam);
  public delegate bool EnumWindowProc(IntPtr hWnd, IntPtr lParam);

  const uint DESKTOP_ALL_ACCESS = 0x000F01FF;

  /* ArrayList throughout, and not by preference: Add-Type -ReferencedAssemblies REPLACES
     PowerShell's default reference set, so System.Runtime is not referenced and List<T> does
     not compile. See the same note in measure-cu-hidden-desktop.mjs. */
  public static string Audit()
  {
    System.Collections.ArrayList entries = new System.Collections.ArrayList();
    IntPtr station = GetProcessWindowStation();
    if (station == IntPtr.Zero) return "{\"ok\":false,\"error\":\"no window station\"}";
    EnumDesktopsW(station, delegate(IntPtr namePointer, IntPtr lParam)
    {
      /* The name is marshalled BY HAND. Declaring the callback parameter as a string under a
         CharSet.Unicode P/Invoke looked right and produced five desktops all named "N": the
         pointer was read as the wrong encoding, so OpenDesktopW could not open any of them and
         every one of them reported zero windows. A desktop audit that cannot name a desktop is
         worse than no audit, because it reports "nothing left behind" either way. */
      string name = namePointer == IntPtr.Zero ? "" : Marshal.PtrToStringUni(namePointer);
      if (String.IsNullOrEmpty(name)) name = "";
      StringBuilder row = new StringBuilder();
      IntPtr desktop = OpenDesktopW(name, 0, false, DESKTOP_ALL_ACCESS);
      int openError = Marshal.GetLastWin32Error();
      int windows = 0;
      System.Collections.ArrayList pids = new System.Collections.ArrayList();
      System.Collections.ArrayList classes = new System.Collections.ArrayList();
      if (desktop != IntPtr.Zero)
      {
        EnumDesktopWindows(desktop, delegate(IntPtr hWnd, IntPtr inner)
        {
          windows++;
          uint pid;
          GetWindowThreadProcessId(hWnd, out pid);
          string value = pid.ToString();
          if (!pids.Contains(value)) pids.Add(value);
          StringBuilder className = new StringBuilder(256);
          GetClassNameW(hWnd, className, className.Capacity);
          string cls = className.ToString();
          if (cls.Length > 0 && !classes.Contains(cls)) classes.Add(cls);
          return true;
        }, IntPtr.Zero);
        CloseDesktop(desktop);
      }
      row.Append("{\"name\":\"").Append(name).Append("\"")
        .Append(",\"opened\":").Append(desktop != IntPtr.Zero ? "true" : "false")
        .Append(",\"open_error\":").Append(openError)
        .Append(",\"windows\":").Append(windows)
        .Append(",\"pids\":[").Append(String.Join(",", (string[])pids.ToArray(typeof(string)))).Append("]")
        .Append(",\"classes\":[");
      string[] classList = (string[])classes.ToArray(typeof(string));
      for (int i = 0; i < classList.Length && i < 12; i++)
      {
        if (i > 0) row.Append(",");
        row.Append("\"").Append(classList[i].Replace("\\", "\\\\").Replace("\"", "\\\"")).Append("\"");
      }
      row.Append("]}");
      entries.Add(row.ToString());
      return true;
    }, IntPtr.Zero);
    string[] all = (string[])entries.ToArray(typeof(string));
    return "{\"ok\":true,\"station\":\"" + KernelName(station) + "\",\"desktops\":[" + String.Join(",", all) + "]}";
  }

  static string KernelName(IntPtr handle)
  {
    StringBuilder buffer = new StringBuilder(512);
    int needed;
    if (!GetUserObjectInformationW(handle, 2, buffer, buffer.Capacity * 2, out needed)) return "";
    return buffer.ToString();
  }
}
`;

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');
const pwshHome = path.dirname(PWSH);
const DRAWING_REFS = ['System.Drawing.Common.dll', 'System.Drawing.Primitives.dll']
  .map((name) => [path.join(pwshHome, name), path.join(pwshHome, 'ref', name)].find((candidate) => {
    try { readFileSync(candidate); return true; } catch { return false; }
  }))
  .filter(Boolean);

const script = [
  '$ErrorActionPreference = "Stop"',
  `$__drawingRefs = @(${DRAWING_REFS.map((entry) => `"${entry}"`).join(', ')})`,
  '$__refs = @() + $__drawingRefs',
  "$__source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
  b64(CSHARP),
  "'@))",
  'try {',
  '  if (-not ("NmDeskAudit" -as [type])) { Add-Type -TypeDefinition $__source -ReferencedAssemblies $__refs -ErrorAction Stop }',
  '} catch {',
  '  throw ("NmDeskAudit did not compile: " + [string]$_.Exception.Message)',
  '}',
  'Write-Output ([NmDeskAudit]::Audit())',
].join('\r\n');

const result = await mod.runInLane('windows', script, 60000);
const answer = String(result.output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse().find((line) => line.startsWith('{'));
if (!answer) {
  console.log(`the audit lane answered nothing readable (ok=${result.ok}): ${String(result.output).slice(0, 2000)}`);
} else {
  const audit = JSON.parse(answer);
  const desktops = audit.desktops || [];
  const mine = desktops.filter((entry) => String(entry.name).startsWith(PREFIX));
  console.log(`station ${audit.station}: ${desktops.length} desktops`);
  for (const entry of desktops) {
    const mark = String(entry.name).startsWith(PREFIX) ? '  <-- this work\'s prefix' : '';
    console.log(`  ${entry.name}  windows=${entry.windows} pids=[${entry.pids.join(',')}] opened=${entry.opened}${mark}`);
  }
  console.log('');
  console.log(`desktops carrying the prefix "${PREFIX}": ${mine.length}`);
  for (const entry of mine) console.log(`  LEFTOVER ${entry.name}: windows=${entry.windows} pids=[${entry.pids.join(',')}] classes=[${(entry.classes || []).join(', ')}]`);
  console.log(mine.length === 0 ? 'NOTHING LEFT BEHIND: no desktop with this work\'s prefix exists' : 'LEFTOVERS PRESENT');
}
mod.stopAll();
