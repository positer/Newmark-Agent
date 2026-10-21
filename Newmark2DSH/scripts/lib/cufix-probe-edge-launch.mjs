/** Launch Edge for a test with a per-run profile and report exactly what appears. */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const evidenceDir = path.resolve(process.argv[2]);
const pageUrl = pathToFileURL(path.join(evidenceDir, 'cufix-probe-page.html')).href;
const profileDir = path.join(os.tmpdir(), `cufix-edge-run-${Date.now()}`);
fs.mkdirSync(profileDir, { recursive: true });

console.log('pageUrl   =', pageUrl);
console.log('profileDir=', profileDir);

const child = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--no-service-autorun', '--disable-sync',
  '--new-window', pageUrl,
], { detached: true, stdio: 'ignore' });
child.on('error', (error) => console.log('SPAWN ERROR', error.code, error.message));
child.unref();
console.log('launcher pid', child.pid);

const mod = await import(new URL('../../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);
for (let i = 0; i < 20; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 1500));
  const listed = JSON.parse(await mod.runComputerUse({ action: 'app_list', includeOccluded: true }));
  const cufix = (listed.applications || []).filter(app => /cufix/i.test(String(app.title)));
  console.log(`t=${(i + 1) * 1.5}s app_list ok=${listed.ok} count=${listed.count} cufix=${cufix.length}${cufix.length ? ` -> ${cufix[0].handle} "${String(cufix[0].title).slice(0, 80)}"` : ''}`);
  if (cufix.length) break;
}
mod.stopAll();
process.exit(0);
