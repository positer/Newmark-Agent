/** What does startOverlay hand back, and is that handle still a live window a moment later? */
const mod = await import(new URL('../../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);
const overlay = await import(new URL('../../packages/newmark-core/components/computeruse/lib/overlay-win32.js', import.meta.url).href);

const started = await overlay.startOverlay({ ownerId: 'cufix-hwnd-probe', ownerPid: process.pid, durationMs: 0, action: 'cufix_hwnd_probe' });
console.log('startOverlay ->', JSON.stringify(started));
console.log('overlayState ->', JSON.stringify(overlay.overlayState()));

await mod.prepareLane('windows', 20000);
for (const candidate of [started.hwnd, overlay.overlayState().hwnd]) {
  const script = [
    '$hwnd = [IntPtr]::new([Convert]::ToInt64(' + JSON.stringify(String(candidate).replace(/^0x/i, '')) + ', 16))',
    'Write-Output (@{ candidate=' + JSON.stringify(String(candidate)) + '; is_window=[NewmarkCuNative]::IsWindow($hwnd); title=[NewmarkCuNative]::WindowTitle($hwnd); class=[NewmarkCuNative]::ClassName($hwnd); visible=[NewmarkCuNative]::IsWindowVisible($hwnd) } | ConvertTo-Json -Compress)',
  ].join('\r\n');
  const result = await mod.runInLane('windows', script, 20000);
  console.log('probe ->', result.ok ? result.output.trim() : `FAIL ${result.output}`);
}

const activated = JSON.parse(await mod.runComputerUse({ action: 'app_activate', windowHandle: overlay.overlayState().hwnd }));
console.log('app_activate(overlay) ->', JSON.stringify(activated, null, 1));

await overlay.stopOverlay({ reason: 'cufix_hwnd_probe_done' });
mod.stopAll();
process.exit(0);
