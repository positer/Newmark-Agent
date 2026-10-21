/**
 * Two questions the gate needs answered before it can assert either:
 *
 *  1. Does the split-string DllImport EntryPoint actually resolve to the real user32 export?
 *     If it did not, every `type` would fail at call time with EntryPointNotFoundException -
 *     and only at call time, which is exactly the kind of thing a gate should catch.
 *  2. Can an empty batch be sent, so the gate can prove the entry point resolves WITHOUT
 *     typing anything on the user's desktop? SendInput with a zero count sends nothing.
 */
const mod = await import(new URL('../../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);
await mod.prepareLane('windows', 20000);

const script = [
  '$ErrorActionPreference = "Stop"',
  'Write-Output ("empty_text_returns=" + [NewmarkCuNative]::SendUnicodeText(""))',
  '$eventType = [type]"NewmarkCuNative+CuEvent"',
  'Write-Output ("event_type_resolved=" + ($eventType -ne $null))',
  '$instance = [System.Activator]::CreateInstance($eventType)',
  '$size = [System.Runtime.InteropServices.Marshal]::SizeOf($instance)',
  'Write-Output ("event_size=" + $size)',
  '$expected = 40',
  'if ([IntPtr]::Size -eq 4) { $expected = 28 }',
  'Write-Output ("event_size_matches_win32=" + ($size -eq $expected) + " expected=" + $expected)',
  '$empty = [Array]::CreateInstance($eventType, 0)',
  '$sent = [NewmarkCuNative]::SendKeyEvents(0, $empty, $size)',
  'Write-Output ("zero_count_send_returns=" + $sent)',
].join('\r\n');

const result = await mod.runInLane('windows', script, 30000);
console.log(result.ok ? result.output : `LANE FAIL: ${result.output}`);
mod.stopAll();
process.exit(0);
