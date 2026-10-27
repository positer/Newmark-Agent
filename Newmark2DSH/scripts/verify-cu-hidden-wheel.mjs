/**
 * verify-cu-hidden-wheel — where the hidden-desktop wheel is posted, and why.
 *
 * The page did not move: 46 app_scroll calls to the hidden desktop answered posted=true while the
 * document stayed where it was. The cause is the target, not the delta. WM_LBUTTONDOWN carries
 * client coordinates and a frame forwards it to the child it hit-tests; WM_MOUSEWHEEL carries
 * SCREEN coordinates and the system delivers it to the window under the cursor - and on a desktop
 * that is not the input desktop there is no cursor and no foreground window, so a wheel posted to
 * the frame is left to DefWindowProc and a Chromium frame does nothing with it.
 *
 * This gate holds the SHAPE of the fix: resolve the window at the point with WindowFromPoint (which
 * is scoped to the calling thread's desktop), post there, refuse to leave the window we were told to
 * drive (IsChild), keep the frame as an explicit fallback, and report where the wheel actually went.
 * It cannot prove the page scrolls - only a live hidden desktop can. That is stated in its own
 * output rather than implied.
 *
 * Run: node scripts/verify-cu-hidden-wheel.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, '..', 'packages/newmark-core/components/computeruse/lib/hidden-agent.js');
const source = fs.readFileSync(AGENT, 'utf8');
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });
const has = (needle) => source.includes(needle);

check('the agent can resolve the window under a screen point', has('WindowFromPoint(POINT point)') && has('public static IntPtr WindowAtScreenPoint(int x, int y)'));
check('the resolution is documented as desktop-scoped, not global', has("WindowFromPoint is scoped to the calling thread's desktop"));
check('the wheel is posted to the resolved window, not to the frame by default', has('$under = [NmAgentWindow]::WindowAtScreenPoint($screenX, $screenY)') && has('$posted = [NmAgentWindow]::Post($wheelTarget,'));
check('a wheel may only be routed to a descendant of the window we were told to drive', has('[NmAgentWindow]::IsChild($target, $under)'));
check('the frame is kept as an explicit fallback, not as the default', has('$frameFallback = [bool]') || has('$frameFallback = [NmAgentWindow]::Post($target,'));
check('the receipt says where the wheel went', has('wheel_target = ') && has('wheel_target_class = ') && has('wheel_target_is_child = '));
check('the receipt separates posted from the fallback', has('posted = [bool]$posted') && has('frame_fallback_posted = [bool]$frameFallback'));
check('the deltas are still packed in C#, where the message format is defined', has('public static long WheelWParam(int delta)') && has('public static long PointLParam(int x, int y)'));
check('the screen point still comes from the client centre', has('[NmAgentWindow]::ClientCenterOnScreen($target, [ref]$screenX, [ref]$screenY)'));
check('the op still reports whether the centre could be computed', has('centered = [bool]$centered'));

const failed = checks.filter((entry) => entry.pass !== true);
for (const entry of checks) console.log((entry.pass ? 'ok   ' : 'not ok ') + entry.name + (entry.pass ? '' : '  [' + entry.detail + ']'));
console.log('');
console.log('hidden wheel: ' + (checks.length - failed.length) + '/' + checks.length + ' passed (shape only - the page moving is a live-desktop fact, not a source fact)');
if (failed.length) { console.log('FAILED: ' + failed.map((entry) => entry.name).join('; ')); process.exit(1); }
console.log('PASS');
