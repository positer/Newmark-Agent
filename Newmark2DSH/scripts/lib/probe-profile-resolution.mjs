/**
 * CLI: report whether the active DSH profile can resolve named plugin packages.
 *
 * Read-only. Answers the question a cold boot answers — "would the Cordis Loader
 * be able to import this row?" — using the shipping overlay resolver, without
 * restarting the running Desktop app.
 *
 * Usage:
 *   node probe-profile-resolution.mjs <profileDir> <packageName> [<packageName> ...]
 *
 * Exit 0 when every package resolves, 1 when any does not, 2 on bad usage,
 * 3 when the profile manifest or the Desktop resolver is missing.
 */
import fs from 'node:fs';
import path from 'node:path';

import { desktopLibDir, overlayModulePath, resolveProfilePackages } from './profile-resolution.mjs';

const [profileDir, ...names] = process.argv.slice(2);
if (profileDir === undefined || names.length === 0) {
  console.error('usage: node probe-profile-resolution.mjs <profileDir> <packageName> [...]');
  process.exit(2);
}
if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
  console.error(`NOT-FOUND profile manifest: ${path.join(profileDir, 'package.json')}`);
  process.exit(3);
}
if (overlayModulePath() === undefined) {
  console.error(`NOT-FOUND overlay resolver under ${desktopLibDir()}`);
  process.exit(3);
}

const results = await resolveProfilePackages(profileDir, names);
let unresolved = 0;
for (const [name, result] of results) {
  if (result.resolved) {
    console.log(`RESOLVES   ${name} -> ${result.source}: ${result.packageDir}`);
  } else {
    unresolved += 1;
    console.log(`UNRESOLVED ${name} -> ${result.error.name}: ${result.error.message}`);
  }
}
console.log(`resolution-summary unresolved=${unresolved} total=${names.length}`);
process.exit(unresolved > 0 ? 1 : 0);
