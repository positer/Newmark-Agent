/** Why does the fixture not start when Node spawns it, while it works from a shell? */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const evidenceDir = path.resolve(process.argv[2]);
const fixtureScript = path.join(evidenceDir, 'cufix-noactivate-fixture.ps1');
const status = path.join(os.tmpdir(), 'cufix-noactivate-status.json');
if (fs.existsSync(status)) fs.unlinkSync(status);

const shell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
console.log('script exists:', fs.existsSync(fixtureScript), fixtureScript);
console.log('shell exists:', fs.existsSync(shell));

const child = spawn(shell, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript, status, '40000'], { stdio: 'ignore' });
child.on('error', (error) => console.log('spawn error:', error.message));
child.on('exit', (code, signal) => console.log(`child exit code=${code} signal=${signal}`));

for (let i = 0; i < 30; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 500));
  if (fs.existsSync(status)) {
    console.log('status after', i * 500, 'ms:', fs.readFileSync(status, 'utf8'));
    try { child.kill(); } catch { /* gone */ }
    process.exit(0);
  }
}
console.log('NO STATUS after 15s; child killed =', child.killed, 'pid =', child.pid);
try { child.kill(); } catch { /* gone */ }
process.exit(1);
