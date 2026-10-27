// The virtual desktop preview must not paint transparent overlays as black.
//
// Measured 2026-10-27 on this machine: the pet's viewer showed a pure black screen. The capture
// child reported "captured 13, failed 0" and every frame was 100% black, because three topmost,
// full-screen windows (CEF-OSC-WIDGET, Windows.UI.Core.CoreWindow, IslandWindow) are transparent
// overlays: PrintWindow returns true and an opaque black rectangle for each, and being painted last
// they covered the windows that had captured fine (DSH lum=31, taskbar 42).
//
// This gate reads the product source and the capture contract, so a future edit that removes the
// skip stops being green here instead of turning the user's preview black again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../packages/newmark-core/components/computeruse/lib/desktop-pet.cs'), 'utf8');
let checks = 0;
const check = (name, value) => { assert.ok(value, name); console.log(`ok ${++checks} - ${name}`); };

check('the capture counts windows it refuses to paint', /int captured=0, failed=0, transparent=0;/.test(source));
check('a window is skipped when it covers a quarter of the screen and captured as pure black', /width\*height>=screen\.Width\*screen\.Height\/4/.test(source) && /if \(blank\) transparent\+\+;/.test(source));
check('the skip happens instead of DrawImage, so nothing can paint over the desktop', /if \(blank\) transparent\+\+;\s*else \{ g\.DrawImage/.test(source));
check('the count is published, so a black preview is diagnosable rather than invisible', /transparent=transparent/.test(source));
check('the reason is recorded next to the code, not only in this gate', /PrintWindow cannot reproduce their transparency/.test(source));
const viewer = fs.readFileSync(path.join(here, '../packages/newmark-core/components/computeruse/lib/desktop-pet.js'), 'utf8');
check('the viewer keeps the capture contract it reports', /kind: 'virtual-desktop-pet'/.test(viewer));
console.log(`PASS ${checks} desktop pet capture transparency checks`);
