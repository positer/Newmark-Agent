/** Read every top-level window, minimized included, so a filtered app_list can be explained. */
const mod = await import(new URL('../../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);
await mod.prepareLane('windows', 20000);
const script = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$rows = @()',
  'foreach ($p in Get-Process) {',
  '  if ($p.MainWindowHandle -eq 0) { continue }',
  '  $rows += ("{0}|{1}|{2}|{3}" -f $p.Id, $p.ProcessName, $p.MainWindowHandle, $p.MainWindowTitle)',
  '}',
  'Write-Output ($rows -join "`n")',
].join('\r\n');
const result = await mod.runInLane('windows', script, 30000);
console.log(result.ok ? result.output : `LANE FAIL: ${result.output}`);
const plain = JSON.parse(await mod.runComputerUse({ action: 'app_list' }));
console.log(`--- app_list count=${plain.count} ---`);
for (const app of plain.applications) console.log(`${app.handle} ${app.title}`);
mod.stopAll();
process.exit(0);
