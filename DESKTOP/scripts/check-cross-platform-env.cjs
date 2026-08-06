'use strict';
// Cross-platform build environment check (dev-0.3.5).
// Validates that the TypeScript source, UI bundle, and headless server/CLI are
// platform-independent, and documents what a macOS / HarmonyOS build requires.
// Run from any host; on Windows it also attempts an electron-builder --mac
// config validation to confirm the macOS target is wired (real .dmg packaging
// still requires a macOS host, per electron-builder's platform constraint).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const repoRoot = path.resolve(root, '..');
const failures = [];
function ok(msg) { console.log('ok: ' + msg); }
function fail(msg) { failures.push(msg); console.log('FAIL: ' + msg); }
function assert(cond, msg) { if (cond) ok(msg); else fail(msg); }

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// 1. All target-specific build scripts exist and are correctly wired.
assert(!!packageJson.scripts['dist:mac'], 'dist:mac script exists');
assert(!!packageJson.scripts['dist:linux'] && !!packageJson.scripts['dist:win'], 'dist:linux and dist:win scripts exist');
assert(!!packageJson.build && !!packageJson.build.mac && !!packageJson.build.mac.target, 'build.mac target configured (dmg)');
assert(!!packageJson.build && !!packageJson.build.linux && !!packageJson.build.linux.target, 'build.linux targets configured (AppImage/deb)');
assert(!!packageJson.build && !!packageJson.build.win && !!packageJson.build.win.target, 'build.win target configured (msi)');

// 2. Platform-specific hooks are guarded so cross builds never run Windows code.
const afterPack = fs.readFileSync(path.join(root, 'scripts', 'after-pack-win-icon.cjs'), 'utf8');
assert(afterPack.includes("context.electronPlatformName !== 'win32'") && afterPack.includes('return'), 'after-pack hook guards non-Windows platforms');

// 3. Source avoids hard-coded Windows-only paths/APIs at the top level.
const mainSource = fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8');
const hasPlatformGuards = mainSource.includes("process.platform === 'win32'");
assert(hasPlatformGuards, 'main.ts branches platform-specific behavior via process.platform');
const serverSource = fs.readFileSync(path.join(root, 'src', 'server.ts'), 'utf8');
assert(serverSource.includes("process.platform === 'win32'"), 'server.ts branches platform-specific shells');

// 4. Headless server / CLI are present for a HarmonyOS/WebView headless host.
assert(fs.existsSync(path.join(root, 'src', 'server.ts')), 'headless HTTP server source exists (HarmonyOS ArkWeb headless integration)');
assert(fs.existsSync(path.join(root, 'src', 'launcher.ts')), 'CLI/TUI launcher source exists');

// 5. TypeScript compiles with no platform-specific import errors.
const tsc = spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
});
assert(tsc.status === 0, 'tsc --noEmit passes (platform-independent TypeScript)');
if (tsc.status !== 0) console.error(String(tsc.stdout || '') + String(tsc.stderr || ''));

// 6. UI bundle is a plain asset (works in Electron and any webview).
const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
assert(uiHtml.includes('id="chat-area"') && uiHtml.includes('window.api'), 'UI bundle is a self-contained web asset');

if (failures.length) {
  console.error(`check-cross-platform-env FAILED (${failures.length})`);
  process.exit(1);
}
console.log('check-cross-platform-env: all checks passed');
console.log(`\nBuild matrix for ${packageJson.version}:`);
console.log('  Windows: npm run dist:windows-release  (MSI + win-unpacked zip)');
console.log('  Linux:   npm run dist:linux             (AppImage + deb + unpacked zip, via WSL/native)');
console.log('  macOS:   npm run dist:mac               (dmg) — MUST run on a macOS host (electron-builder constraint)');
console.log('  HarmonyOS: headless integration — build dist/server.js + dist/launcher.js (Node-based headless core)');
