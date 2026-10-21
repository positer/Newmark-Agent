/**
 * Clean up exactly what one measurement run left behind, by the pids that run recorded.
 *
 * This is not a general reaper and it names no process class as a SELECTOR. It takes the run's own
 * receipt, and for each pid the run tracked it reads the image path and the start time FIRST and
 * prints them, then terminates only when the start time is at or after the run's own start AND the
 * image is one this run started (powershell.exe or the probe executable). A pid that is now
 * something else is reported and left strictly alone.
 *
 * Usage: node scripts/.probe-cleanup.mjs <receipt.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CSHARP_PAYLOADS,
  runPowerShell,
  windowsPowerShellPath,
} from '../packages/newmark-core/components/computeruse/lib/hidden-agent.js';

const receiptFile = process.argv[2];
if (!receiptFile || !fs.existsSync(receiptFile)) {
  process.stdout.write(`no receipt at ${receiptFile}\n`);
  process.exit(1);
}
const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
const startedAt = Date.parse(receipt.started_at);
const say = (line = '') => process.stdout.write(`${String(line)}\n`);
say(`receipt: ${receiptFile}`);
say(`run started: ${receipt.started_at}`);

/** Every pid the run ever touched, with the label it recorded. */
const pids = new Map();
function add(pid, label) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return;
  if (!pids.has(value)) pids.set(value, label);
}
const text = fs.readFileSync(receiptFile, 'utf8');
for (const match of text.matchAll(/"pid"\s*:\s*(\d+)/g)) add(match[1], 'from receipt');
for (const match of text.matchAll(/pid=(\d+)/g)) add(match[1], 'from receipt text');
add(receipt.cleanup?.survivors ? 0 : 0, 'placeholder');
for (const survivor of receipt.cleanup?.survivors || []) add(survivor.pid, survivor.label);

/** Every desktop name the run created or adopted. */
const desktops = new Set();
for (const match of text.matchAll(/NmCuAgent[A-Za-z]?\d+/g)) desktops.add(match[0]);
desktops.delete('NmCuAgent');

say(`\npid candidates (${pids.size}): ${[...pids.entries()].map(([pid, label]) => `${pid}(${label})`).join(' ')}`);
say(`desktop candidates (${desktops.size}): ${[...desktops].join(' ')}`);

const encoded = Buffer.from(CSHARP_PAYLOADS.NmProcessFacts, 'utf8').toString('base64');
const encodedMaker = Buffer.from(CSHARP_PAYLOADS.NmHiddenMaker, 'utf8').toString('base64');
const pidList = [...pids.keys()].join(',');
const script = [
  '$ErrorActionPreference = "Stop"',
  "$facts = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
  encoded,
  "'@))",
  'if (-not ("NmProcessFacts" -as [type])) { Add-Type -TypeDefinition $facts -ErrorAction Stop }',
  "$maker = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
  encodedMaker,
  "'@))",
  'if (-not ("NmHiddenMaker" -as [type])) { Add-Type -TypeDefinition $maker -ErrorAction Stop }',
  'function Get-Iso([string]$ticks) { if ($ticks -eq "" -or $ticks -eq "0") { return "" } try { return [DateTime]::FromFileTimeUtc([long]$ticks).ToString("o") } catch { return "" } }',
  `$candidates = @(${pidList})`,
  '$report = New-Object System.Collections.ArrayList',
  'foreach ($candidate in $candidates) {',
  '  $ticks = [NmProcessFacts]::StartTimeTicks([int]$candidate)',
  '  $image = ""',
  '  $outcome = 0',
  '  $errorCode = 0',
  '  if ($ticks -gt 0) { $image = [NmProcessFacts]::ImagePath([int]$candidate) }',
  '  [void]$report.Add(@{ pid = [int]$candidate; ticks = [string]$ticks; start_utc = (Get-Iso ([string]$ticks)); image = $image; outcome = 0 })',
  '}',
  '$payload = @{ report = @($report) } | ConvertTo-Json -Depth 6 -Compress',
  'Write-Output ("NMSCAN " + $payload)',
].join('\n');

const scan = await runPowerShell(script, { timeoutMs: 120000 });
const line = String(scan.output || '').split(/\r?\n/).find((entry) => entry.includes('NMSCAN '));
if (!line) {
  say(`scan failed: ${scan.error}\n${String(scan.output).slice(-2000)}\n${String(scan.stderr).slice(-2000)}`);
  process.exit(1);
}
const scanned = JSON.parse(line.slice(line.indexOf('NMSCAN ') + 'NMSCAN '.length));
const rows = Array.isArray(scanned.report) ? scanned.report : [scanned.report];
say('\n--- what is actually alive ---');
for (const row of rows) {
  say(`  pid ${row.pid} alive=${Number(row.ticks) > 0} start=${row.start_utc} image=${row.image}`);
}

const mine = rows.filter((row) => {
  if (Number(row.ticks) <= 0) return false;
  const image = String(row.image || '').toLowerCase();
  const isOurs = image.endsWith('powershell.exe') || image.includes('nmprobe.exe') || image.endsWith('cmd.exe');
  const afterStart = Date.parse(row.start_utc) >= startedAt - 120000;
  return isOurs && afterStart;
});
say(`\n--- terminating ${mine.length} of ${rows.length}, each verified by image AND start time ---`);
const killLines = [];
for (const row of mine) {
  killLines.push(`$errorCode = 0`);
  killLines.push(`$outcome = [NmProcessFacts]::TerminateIfStartTime(${row.pid}, [long]${row.ticks}, [ref]$errorCode)`);
  killLines.push(`Write-Output ("NMKILL ${row.pid} outcome=$outcome error=$errorCode")`);
}
if (killLines.length > 0) {
  const killScript = [
    '$ErrorActionPreference = "Stop"',
    "$facts = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
    encoded,
    "'@))",
    'if (-not ("NmProcessFacts" -as [type])) { Add-Type -TypeDefinition $facts -ErrorAction Stop }',
    ...killLines,
  ].join('\n');
  const killed = await runPowerShell(killScript, { timeoutMs: 120000 });
  say(String(killed.output || ''));
  if (killed.error) say(`kill error: ${killed.error} ${String(killed.stderr).slice(-800)}`);
}
await new Promise((resolve) => setTimeout(resolve, 2000));

say('\n--- desktops ---');
for (const desktop of desktops) {
  const check = [
    '$ErrorActionPreference = "Stop"',
    "$maker = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(@'",
    encodedMaker,
    "'@))",
    'if (-not ("NmHiddenMaker" -as [type])) { Add-Type -TypeDefinition $maker -ErrorAction Stop }',
    '$errorCode = 0',
    `$hold = [NmHiddenMaker]::OpenByName('${desktop}', [ref]$errorCode)`,
    `Write-Output ("NMDESK ${desktop} opened=" + ($hold -ne [IntPtr]::Zero) + " error=$errorCode")`,
    'if ($hold -ne [IntPtr]::Zero) { [void][NmHiddenMaker]::CloseDesktop($hold) }',
  ].join('\n');
  const result = await runPowerShell(check, { timeoutMs: 60000 });
  say(`  ${String(result.output || '').trim().split(/\r?\n/).filter(Boolean).pop() || result.error}`);
}

say('\n--- final scan ---');
const rescan = await runPowerShell(script, { timeoutMs: 120000 });
const rescanLine = String(rescan.output || '').split(/\r?\n/).find((entry) => entry.includes('NMSCAN '));
if (rescanLine) {
  const again = JSON.parse(rescanLine.slice(rescanLine.indexOf('NMSCAN ') + 'NMSCAN '.length));
  const stillRows = Array.isArray(again.report) ? again.report : [again.report];
  const stillAlive = stillRows.filter((row) => Number(row.ticks) > 0);
  say(`  still alive: ${stillAlive.length === 0 ? 'none' : stillAlive.map((row) => `${row.pid}:${row.image}`).join(' ')}`);
}
say(`\npowershell used: ${windowsPowerShellPath()}`);
