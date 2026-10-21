/**
 * Hypothesis: `SendKeys` produces key events with no scan code, so Chromium routes them to
 * the active IME and the page sees VK_PROCESSKEY (`event.key === 'Process'`) instead of the
 * chord. Delivering the same chord as real virtual keys *with* scan codes should get through.
 *
 * This sends ctrl+0 / ctrl+- with VK+scan codes and reads the page's own key log and width.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const evidenceDir = path.resolve(process.argv[2]);
const pageUrl = pathToFileURL(path.join(evidenceDir, 'cufix-probe-page.html')).href;
const profileDir = path.join(os.tmpdir(), `cufix-edge-vk-${Date.now()}`);

const mod = await import(new URL('../../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);
const call = async (options) => JSON.parse(await mod.runComputerUse(options));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const VK_PROBE = [
  'if (-not ("CufixKeys" -as [type])) {',
  '  Add-Type -TypeDefinition @\'',
  'using System;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'public static class CufixKeys {',
  '  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }',
  '  [StructLayout(LayoutKind.Explicit)] public struct EventData { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct Event { public uint type; public EventData data; }',
  '  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, Event[] events, int size);',
  '  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint mapType);',
  '  const uint KEYBOARD = 1; const uint KEYUP = 0x0002; const uint EXTENDED = 0x0001;',
  '  static Event Make(ushort vk, bool up) {',
  '    Event e = new Event(); e.type = KEYBOARD;',
  '    e.data.ki.wVk = vk;',
  '    e.data.ki.wScan = (ushort)MapVirtualKeyW(vk, 0);',
  '    uint flags = up ? KEYUP : 0;',
  '    if (vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 || vk == 0x2D || vk == 0x2E || vk == 0x24 || vk == 0x23 || vk == 0x21 || vk == 0x22) flags |= EXTENDED;',
  '    e.data.ki.dwFlags = flags;',
  '    return e;',
  '  }',
  '  public static int Chord(ushort[] keys) {',
  '    List<Event> list = new List<Event>();',
  '    for (int i = 0; i < keys.Length; i++) list.Add(Make(keys[i], false));',
  '    for (int i = keys.Length - 1; i >= 0; i--) list.Add(Make(keys[i], true));',
  '    Event[] batch = list.ToArray();',
  '    return (int)SendInput((uint)batch.Length, batch, Marshal.SizeOf(typeof(Event)));',
  '  }',
  '}',
  '\'@',
  '}',
].join('\r\n');

const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--new-window', pageUrl,
], { detached: true, stdio: 'ignore' });
edge.unref();

try {
  let probe = null;
  for (let i = 0; i < 60 && !probe; i += 1) {
    const listed = await call({ action: 'app_list', includeOccluded: true });
    if (listed.ok === true) probe = (listed.applications || []).find(app => /cufix/i.test(String(app.title)));
    if (!probe) await sleep(700);
  }
  if (!probe) throw new Error('no probe window');

  await mod.prepareLane('action', 20000);
  await call({ action: 'app_activate', windowHandle: probe.handle });

  const readTitle = async () => {
    const listed = await call({ action: 'app_list', includeOccluded: true });
    const app = (listed.applications || []).find(candidate => candidate.handle.toLowerCase() === probe.handle.toLowerCase());
    return app ? String(app.title) : '';
  };

  const before = await readTitle();
  console.log(`before        : ${(/ w=(\d+)/.exec(before) || [])[1]} keys=${((/ k=(.*)$/.exec(before) || [])[1] || '').slice(-60)}`);

  /* ctrl+0 as VK 0x11 (CTRL) + 0x30 ('0'), with scan codes. */
  const chord = await mod.runInLane('action', `${VK_PROBE}\r\n$sent = [CufixKeys]::Chord([ushort[]]@(0x11, 0x30))\r\nWrite-Output "sent=$sent vk0scan=$([CufixKeys]::MapVirtualKeyW(0x30,0)) ctrlscan=$([CufixKeys]::MapVirtualKeyW(0x11,0))"`, 20000);
  console.log('vk chord send :', chord.ok ? String(chord.output).trim().split('\n').pop() : `FAIL ${chord.output}`);
  await sleep(900);
  const afterVk = await readTitle();
  console.log(`after vk ^0   : ${(/ w=(\d+)/.exec(afterVk) || [])[1]} keys=${((/ k=(.*)$/.exec(afterVk) || [])[1] || '').slice(-60)}`);

  /* Now the same chord through the tool's own `key`, which uses SendKeys. */
  const toolKey = await call({ action: 'key', windowHandle: probe.handle, key: 'ctrl+0' });
  await sleep(900);
  const afterTool = await readTitle();
  console.log(`after tool ^0 : ${(/ w=(\d+)/.exec(afterTool) || [])[1]} keys=${((/ k=(.*)$/.exec(afterTool) || [])[1] || '').slice(-60)}`);
  console.log(`tool key response: ok=${toolKey.ok} send_keys=${toolKey.send_keys} focus=${toolKey.focus_target_class}`);
} finally {
  try {
    execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(profileDir)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore', timeout: 30000 });
  } catch { /* disposable */ }
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* disposable */ }
  mod.stopAll();
}
process.exit(0);
