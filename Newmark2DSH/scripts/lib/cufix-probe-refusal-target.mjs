/**
 * Which valid window reliably refuses the foreground?
 *
 * The refusal path of `app_activate` needs a window that exists (so the handle resolves) but
 * cannot become the foreground window. Candidates are probed with the real tool, and the
 * one that answers `foreground_not_granted` is the fixture for the evidence run.
 */
const mod = await import(new URL('../../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);
const overlay = await import(new URL('../../packages/newmark-core/components/computeruse/lib/overlay-win32.js', import.meta.url).href);

await mod.prepareLane('windows', 20000);
const handleScript = [
  '$shell = [NewmarkCuNative]::GetShellWindow()',
  '$tray = [NewmarkCuNative]::FindWindowW("Shell_TrayWnd", $null)',
  'Write-Output ("shell=" + $shell.ToInt64() + " tray=" + $tray.ToInt64())',
].join('\r\n');
const handles = await mod.runInLane('windows', handleScript, 20000);
console.log('handles:', handles.ok ? handles.output.trim() : `FAIL ${handles.output}`);

async function tryActivate(label, hex) {
  const result = JSON.parse(await mod.runComputerUse({ action: 'app_activate', windowHandle: hex }));
  console.log(`${label} (${hex}) -> ok=${result.ok} code=${result.error_code || 'none'} expected=${result.expected_handle || 'none'} holder=${result.foreground ? result.foreground.handle : 'none'} technique=${result.activation_technique || 'none'}`);
  return result;
}

const started = await overlay.startOverlay({ ownerId: 'cufix-refusal-probe', ownerPid: process.pid, durationMs: 0, action: 'cufix_refusal_probe' });
const overlayHex = started.window && started.window.hwnd_hex ? started.window.hwnd_hex : `0x${Number(started.hwnd).toString(16)}`;
console.log(`overlay hwnd: decimal=${started.hwnd} hex=${overlayHex}`);
const overlayResult = await tryActivate('overlay', overlayHex);

const shellHex = /shell=(\d+)/.exec(handles.output || '');
if (shellHex) await tryActivate('shell(Progman)', `0x${Number(shellHex[1]).toString(16)}`);
const trayHex = /tray=(\d+)/.exec(handles.output || '');
if (trayHex) await tryActivate('taskbar(Shell_TrayWnd)', `0x${Number(trayHex[1]).toString(16)}`);

console.log(`overlay verdict: ${overlayResult.error_code || 'ACTIVATED'}`);
await overlay.stopOverlay({ reason: 'cufix_refusal_probe_done' });
mod.stopAll();
process.exit(0);
