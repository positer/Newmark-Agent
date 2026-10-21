#!/usr/bin/env node
/**
 * measure-cu-windows-key.mjs — the two Windows-key measurements, on request, by hand.
 *
 * =====================================================================================
 * WHY THIS IS NOT PART OF THE GATE
 * =====================================================================================
 *
 * `verify-computeruse-win32.mjs` asserts that the Windows keys resolve to the right virtual-key
 * codes and that the delivery script composes them - none of which touches the desktop. It
 * deliberately does NOT press a Windows key. This script is the other half: it presses one, so
 * it can only be run where a Start menu opening on the machine is acceptable. Both modes are
 * off unless asked for by name.
 *
 * WHAT IT MEASURED WHEN IT WAS RUN (2026-10-01, this machine, 2560x1600, one monitor):
 *
 *   `lone` - the delivery is right and the shell ignores it.
 *     The receipt reads `key_delivery: "virtual-keys-held-across-a-stroke"`,
 *     `resolved_virtual_keys: [91]`, `dummy_key: 255`, `stroke_events: 4`, and
 *     `windows_key_effect: "not-observed"`. Four independent deliveries were tried and all four
 *     report the key held (`GetAsyncKeyState(VK_LWIN) & 0x8000`) and released:
 *       1. VK_LWIN held across a VK 0xFF stroke;
 *       2. VK_LWIN held across a VK_CONTROL stroke;
 *       3. the older keybd_event entry point, held the same way;
 *       4. VK_RWIN, held the same way.
 *     In all four: the foreground window did not change, no window appeared, and of 62,832
 *     sampled pixels in the region the Start menu covers, 1 to 15 differed (the clock). The
 *     keys are delivered; the shell does not act on them. That is why the receipt reports the
 *     effect as `not-observed` instead of `ok: true` and nothing else.
 *
 *   `chord` - NOT RUN. Deliberately. `win+r` and `win+e` open or move things on the desktop of
 *     whoever is sitting at this machine, which is the one thing the brief for this work
 *     forbade. What IS asserted, structurally, is that the chord composes the right virtual
 *     keys in the right order and is never handed to SendKeys - which cannot express a Windows
 *     key and would type the letters `win` instead. Run this mode when opening the Run dialog
 *     is acceptable, and it will deliver it and report the receipt.
 *
 * Invoke:
 *     node Newmark2DSH/scripts/measure-cu-windows-key.mjs lone
 *     node Newmark2DSH/scripts/measure-cu-windows-key.mjs chord win+r
 *     node Newmark2DSH/scripts/measure-cu-windows-key.mjs sendkeys
 *
 * Exit codes: 0 the measurement completed (the verdict is in the output, not the exit code);
 *             1 the measurement could not run.
 */
import fs from 'node:fs';
import path from 'node:path';

const MODE = String(process.argv[2] || '').trim();
const KEYS = process.argv.slice(3);
const USAGE = 'usage: measure-cu-windows-key.mjs lone | chord <key> | sendkeys';

if (!['lone', 'chord', 'sendkeys'].includes(MODE)) {
  console.log(USAGE);
  process.exit(1);
}

const mod = await import(new URL('../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const outDir = path.join(process.env.TEMP || '.', `cu-windows-key-${Date.now()}`);
fs.mkdirSync(outDir, { recursive: true });

/** The keys' own state, so an unpaired keydown cannot hide: a stuck VK_LWIN breaks typing. */
const keyState = async () => {
  const result = await mod.runInLane('windows', [
    '$ErrorActionPreference = "Stop"',
    'Write-Output (@{ ok=$true; lwin=[NewmarkCuNative]::IsVirtualKeyDown(0x5B); rwin=[NewmarkCuNative]::IsVirtualKeyDown(0x5C); foreground=("0x{0:X}" -f [NewmarkCuNative]::GetForegroundWindow().ToInt64()) } | ConvertTo-Json -Compress)',
  ].join('\r\n'), 15000);
  if (!result.ok) return { error: String(result.output).slice(0, 200) };
  const lines = String(result.output).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
};

/** Every top-level window, including the shell's own, so nothing that appears is invisible. */
const census = async () => {
  const result = await mod.runInLane('windows', [
    '$ErrorActionPreference = "Stop"',
    '$items = New-Object System.Collections.Generic.List[object]',
    'foreach ($window in [NewmarkCuNative]::EnumTopLevelWindows($true, $true)) {',
    '  $items.Add([pscustomobject]@{ h=("0x{0:X}" -f $window.Handle); c=[string]$window.ClassName; t=[string]$window.Title; visible=[bool]$window.Visible }) | Out-Null',
    '}',
    'Write-Output (@{ ok=$true; items=$items.ToArray() } | ConvertTo-Json -Compress -Depth 5)',
  ].join('\r\n'), 25000);
  const lines = String(result.output).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]).items;
};

/** A full-resolution capture, which is the evidence a reader can look at. */
const shot = async (label) => {
  const imagePath = path.join(outDir, `${label}.png`);
  const result = JSON.parse(await mod.runComputerUse({
    action: 'capture_screen', imagePath, captureMaxWidth: 2048, captureMaxHeight: 2048, captureTimeoutMs: 30000, timeoutMs: 20000,
  }));
  return { label, ok: result.ok === true, image_path: imagePath, width: result.width, height: result.height, digest: result.capture && result.capture.digest && result.capture.digest.sha256_prefix };
};

const before = { keys: await keyState(), windows: await census() };
const beforeShot = await shot('1-before');
console.log(`before: ${JSON.stringify(before.keys)} windows=${before.windows.length}`);

let delivered = null;
if (MODE === 'lone') {
  console.log('\n=== delivering ONE lone `win` (this opens the Start menu if the shell accepts it) ===');
  delivered = JSON.parse(await mod.runComputerUse({ action: 'key', key: 'win', timeoutMs: 15000 }));
} else if (MODE === 'chord') {
  const key = KEYS[0] || 'win+r';
  console.log(`\n=== delivering ONE chord \`${key}\` (this opens or moves something on the desktop) ===`);
  delivered = JSON.parse(await mod.runComputerUse({ action: 'key', key, timeoutMs: 15000 }));
} else {
  console.log('\n=== delivering a SendKeys chord, to show the non-Windows path is unchanged ===');
  delivered = JSON.parse(await mod.runComputerUse({ action: 'key', key: KEYS[0] || 'escape', timeoutMs: 15000 }));
}
console.log(JSON.stringify(delivered, null, 2));

await sleep(900);
const after = { keys: await keyState(), windows: await census() };
const afterShot = await shot('2-after');
const beforeSet = new Set(before.windows.map(item => `${item.h} ${item.c}`));
const appeared = after.windows.filter(item => !beforeSet.has(`${item.h} ${item.c}`));
console.log(`\nafter: ${JSON.stringify(after.keys)} windows=${after.windows.length}`);
console.log(`windows that appeared: ${JSON.stringify(appeared.map(item => `${item.h} ${item.c} "${item.t}" visible=${item.visible}`))}`);

/* Leave the machine as it was found: close what a Windows key opens, and verify the key is up. */
let closed = null;
if (MODE !== 'sendkeys') {
  console.log('\n=== closing with escape ===');
  closed = JSON.parse(await mod.runComputerUse({ action: 'key', key: 'escape', timeoutMs: 15000 }));
  await sleep(600);
}
const finalKeys = await keyState();
const finalShot = await shot('3-after-escape');

const verdict = {
  mode: MODE,
  delivered_ok: delivered.ok === true,
  key_delivery: delivered.key_delivery,
  resolved_virtual_keys: delivered.resolved_virtual_keys,
  resolved_key_names: delivered.resolved_key_names,
  dummy_key: delivered.dummy_key,
  stroke_events: delivered.stroke_events,
  windows_key_effect: delivered.windows_key_effect,
  foreground_changed_by_key: delivered.foreground_changed_by_key,
  foreground_before: delivered.foreground_before,
  foreground_after: delivered.foreground_after,
  windows_appeared: appeared.map(item => `${item.h} ${item.c} "${item.t}" visible=${item.visible}`),
  /* The two things that must be true whatever the shell does. */
  no_key_left_held: finalKeys.lwin === false && finalKeys.rwin === false,
  escape_delivered: closed ? closed.ok === true : 'not-sent',
  screenshots: [beforeShot, afterShot, finalShot],
  out_dir: outDir,
};
console.log('\n=== VERDICT ===');
console.log(JSON.stringify(verdict, null, 2));
fs.writeFileSync(path.join(outDir, 'verdict.json'), JSON.stringify({ verdict, delivered, before, after }, null, 2));

mod.stopAll();
process.exit(0);
