/**
 * Why does app_list return nothing? Print the raw lane output side by side with the parsed
 * action result, plus the occlusion verdict for every enumerated window.
 */
const mod = await import(new URL('../../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);

const plain = JSON.parse(await mod.runComputerUse({ action: 'app_list' }));
console.log(`app_list count=${plain.count} warning=${plain.warning || 'none'}`);
console.log(`telemetry=${JSON.stringify(plain.telemetry)}`);
console.log(`lane_routing=${JSON.stringify(plain.lane_routing)}`);

await mod.prepareLane('windows', 20000);
const script = [
  '$ErrorActionPreference = "Continue"',
  '$rows = [NewmarkCuNative]::EnumTopLevelWindows($false, $false)',
  'Write-Output ("RAW_COUNT=" + $rows.Count)',
  'foreach ($w in $rows) { Write-Output ("W|" + ("0x{0:X}" -f $w.Handle) + "|" + $w.ClassName + "|" + $w.Title + "|occluded=" + $w.Occluded + "|visible=" + $w.Visible) }',
  '$all = [NewmarkCuNative]::EnumTopLevelWindows($false, $true)',
  'Write-Output ("ALL_COUNT_WITH_MINIMIZED=" + $all.Count)',
].join('\r\n');
const result = await mod.runInLane('windows', script, 30000);
console.log(`--- raw lane (ok=${result.ok}) ---`);
console.log(result.output);

const virtual = JSON.parse(await mod.runComputerUse({ action: 'app_list', mouseModeVirtual: true }));
console.log(`--- app_list with includeOccluded (virtual scope) count=${virtual.count} ---`);
for (const app of virtual.applications) console.log(`${app.handle} ${app.title} occluded=${app.occluded} visible=${app.visible}`);

mod.stopAll();
process.exit(0);
