/** Who holds the foreground right now, and does app_list legitimately exclude it? */
const mod = await import(new URL('../../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);
await mod.prepareLane('windows', 20000);
const probe = await mod.runInLane('windows', [
  '$fg = [NewmarkCuNative]::GetForegroundWindow()',
  'Write-Output (@{ handle=("0x{0:X}" -f $fg.ToInt64()); class_name=[NewmarkCuNative]::ClassName($fg); process_id=[NewmarkCuNative]::GetProcessId($fg); title=[NewmarkCuNative]::WindowTitle($fg); visible=[NewmarkCuNative]::IsWindowVisible($fg); iconic=[NewmarkCuNative]::IsIconic($fg) } | ConvertTo-Json -Compress)',
].join('\r\n'), 20000);
console.log('foreground:', String(probe.output).trim().split('\n').pop());

const list = JSON.parse(await mod.runComputerUse({ action: 'app_list' }));
console.log(`app_list ok=${list.ok} count=${list.count} scope=${list.scope} error=${list.error_code || 'none'}`);
const virtual = JSON.parse(await mod.runComputerUse({ action: 'app_list', includeOccluded: true }));
console.log(`virtual app_list ok=${virtual.ok} count=${virtual.count}`);
mod.stopAll();
process.exit(0);
