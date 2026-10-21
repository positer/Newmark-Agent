/**
 * Drive Newmark ComputerUse from Node, through the tool's own `execute`.
 *
 * The running DSH process still holds the component module it booted with, so the
 * in-app tool cannot be exercised until the next restart. This mounts the same core
 * row out of process — the row that composes ComputerUse from inside itself — so the
 * real Windows backend and the real tool definitions are what is driven.
 *
 * Usage: node scripts/drive-computeruse.mjs <workspace> <action> [k=v,...] [out.json]
 *
 * Arguments are `k=v` pairs because a Windows shell strips the quotes out of a JSON
 * argument. The result is written as UTF-8 JSON, so no caller depends on a shell's
 * default redirect encoding.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mountCore } from './lib/mount-newmark-core.mjs';

const workspace = path.resolve(process.argv[2]);
const packagesDir = path.join(workspace, 'packages');
const action = process.argv[3] || 'observe';

const extra = {};
for (const pair of (process.argv[4] || '').split(',').filter(Boolean)) {
  const at = pair.indexOf('=');
  if (at < 0) continue;
  const key = pair.slice(0, at).trim();
  const raw = pair.slice(at + 1).trim();
  const asNumber = Number(raw);
  extra[key] = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && Number.isFinite(asNumber) ? asNumber : raw;
}

const outPath = process.argv[5] || '';

/* ComputerUse is composed by the core row, with the config that row carries
 * (`leaseTtlMs: 120000`, which the component reports as inert — the lease has no TTL). A
 * per-caller override here would drive a component the app never builds. */
const mount = await mountCore({
  packagesDir,
  root: path.join(process.env.USERPROFILE || '', '.Newmark'),
  components: { memoryLab: false, computerUse: true },
});

const tool = mount.tools.get(process.argv[6] || 'computer_use');
if (!tool) {
  console.error('FATAL: the requested tool is not registered');
  process.exit(1);
}

const result = await tool.execute({ action, owner_id: 'newmark-visual-test', ...extra });
const text = JSON.stringify({ returnedType: typeof result, isArray: Array.isArray(result), result }, null, 2);

if (outPath) {
  fs.writeFileSync(outPath, text, 'utf8');
  console.log(`wrote ${text.length} bytes -> ${outPath}`);
  console.log('keys:', result && typeof result === 'object' ? Object.keys(result).join(', ') : '(not an object)');
} else {
  console.log(text);
}
