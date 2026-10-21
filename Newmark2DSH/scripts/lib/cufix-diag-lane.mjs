/** Surface the lane's own initialisation error, which is where an Add-Type failure lands. */
const mod = await import(new URL('../../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);
const prepared = await mod.prepareLane('windows', 20000);
console.log('prepared:', JSON.stringify(prepared));
console.log('laneDiagnostics:', JSON.stringify(mod.laneDiagnostics(), null, 2).slice(0, 4000));
const probe = await mod.runInLane('windows', 'Write-Output "PING"', 15000);
console.log('ping:', JSON.stringify(probe).slice(0, 2000));
mod.stopAll();
process.exit(0);
