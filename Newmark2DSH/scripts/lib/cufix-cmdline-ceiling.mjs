/**
 * What is the actual `-Command` ceiling on this machine?
 *
 * The lane host script - which embeds the whole C# helper - is passed on the command line,
 * so the helper's size is bounded by CreateProcess's command-line limit. This finds the
 * limit by experiment instead of guessing, because the fix has to fit inside it.
 */
import { spawn } from 'node:child_process';

const shell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function attempt(payloadLength) {
  return new Promise((resolve) => {
    const payload = `Write-Output 1${' '.repeat(Math.max(0, payloadLength - 14))}`;
    /* Node throws ENAMETOOLONG synchronously, so the call itself needs the guard. */
    let child;
    try {
      child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', payload], { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      resolve({ ok: false, error: error.code || error.message });
      return;
    }
    let settled = false;
    child.on('error', (error) => { if (!settled) { settled = true; resolve({ ok: false, error: error.code || error.message }); } });
    child.on('exit', () => { if (!settled) { settled = true; resolve({ ok: true }); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch { /* gone */ } resolve({ ok: true, note: 'timeout' }); } }, 4000);
  });
}

let low = 1000;
let high = 40000;
console.log(`probe 40000 -> ${JSON.stringify(await attempt(40000))}`);
while (high - low > 8) {
  const mid = Math.floor((low + high) / 2);
  const result = await attempt(mid);
  if (result.ok) low = mid; else high = mid;
  console.log(`probe ${mid} -> ${result.ok ? 'ok' : 'FAIL ' + result.error}   (window ${low}..${high})`);
}
console.log(`CEILING: a -Command payload of ${low} chars spawns; ${high} does not.`);
process.exit(0);
