#!/usr/bin/env node
/**
 * Executable gate for the Newmark ComputerUse Win32 automation layer
 * (packages/newmark-core/components/computeruse/lib/win32.js).
 *
 * Run from the workspace root:
 *   node Newmark2DSH/scripts/verify-computeruse-win32.mjs
 *
 * It never performs real input: no assertion moves the cursor, clicks, or types. Every
 * mouse/keyboard assertion is a pure-function, source-text, or lease assertion. Only the
 * Windows-only assertions touch the desktop, and then only to read a window handle, list
 * top-level windows, capture a window that is already on screen, or dispatch an action
 * that refuses BEFORE it delivers anything - a `scroll` with no coordinates, or an
 * `app_activate` whose `app_target` cannot match any window title or class on this
 * machine (`'point_required'` and `'app_target_not_found'`, both asserted below).
 *
 * Checks 23-25 hold the `computer_use` tool description - read from the component that
 * ships it, not from a copy - against behaviour measured in this same run, because a
 * description that drifts from the code is worse than no description at all.
 *
 * On a platform other than Windows the desktop assertions skip explicitly and the
 * platform-independent part still reports PASS.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = fileURLToPath(new URL('../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url));
const SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');
const IS_WINDOWS = process.platform === 'win32';

/* ------------------------------------------------------------------ *
 * literal copies of the expected contract values
 * ------------------------------------------------------------------ */

const EXPECTED_LANES = ['action', 'uia', 'windows', 'uia_advisory', 'windows_advisory', 'window_capture', 'sparse'];

const EXPECTED_MODE_INVENTORY = {
  mouse: ['real', 'virtual'],
  observation: ['sparse', 'full'],
  lane: ['action', 'uia', 'windows', 'uia_advisory', 'windows_advisory', 'window_capture', 'sparse'],
  lease: ['takeover_start', 'takeover_stop'],
};

const EXPECTED_CONSTANTS = {
  MIN_ACTION_INTERVAL_MS: 350,
  MOVE_CURVE_MS: 50,
  SPARSE_MIN_INTERVAL_MS: 200,
  SPARSE_MAX_WAIT_MS: 5000,
};

/** Markers whose substring can never occur innocently in this module. */
const ANTI_COUPLING_MARKERS = ['newmark-cu-lab', 'CULab', 'NES-T', 'NMEP', 'onnx', 'IDLock', 'ryzenai'];

/**
 * The NPU marker, handled as its own rule. The contract requires the native helper to
 * expose AttachThreadInput, and that Win32 entry point itself contains the letters "npu",
 * so a raw case-insensitive substring search cannot be satisfied. The gate therefore
 * asserts the stronger, checkable property: NPU never appears as a standalone token, and
 * outside the mandated AttachThreadInput identifier the letters "npu" do not occur at all.
 */
const NPU_TOKEN = /(?<![A-Za-z0-9_])NPU(?![A-Za-z0-9_])/i;
const NPU_ALLOWED_IDENTIFIER = 'AttachThreadInput';

const VIRTUAL_BEGIN = '/* @virtual-mode-begin */';
const VIRTUAL_END = '/* @virtual-mode-end */';
const PHYSICAL_APIS = ['SetCursorPos', 'mouse_event', 'SendInput', 'SetForegroundWindow'];

const LEASE_OWNER_A = `ncu-gate-owner-a-${process.pid}`;
const LEASE_OWNER_B = `ncu-gate-owner-b-${process.pid}`;

/**
 * Text with its comments and quoted literals removed.
 *
 * Several assertions in this gate are about what the CODE does - how many places call a
 * primitive, whether a construct appears where a compiler would have to accept it - and the
 * module documents itself heavily. Without this, a sentence about `CloseDesktop` counts as a
 * call to it, and a note naming the one C# construct the helper may not use fails the rule it
 * explains. Handles `//`, block comments, `"..."`, `'...'` and C#'s `@"..."`, with escapes.
 */
function stripCommentsAndStrings(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const two = text.slice(index, index + 2);
    if (two === '//') {
      const stop = text.indexOf('\n', index);
      index = stop < 0 ? text.length : stop;
      continue;
    }
    if (two === '/*') {
      const stop = text.indexOf('*/', index + 2);
      index = stop < 0 ? text.length : stop + 2;
      continue;
    }
    if (two === '@"') {
      index += 2;
      while (index < text.length) {
        if (text[index] !== '"') { index += 1; continue; }
        if (text[index + 1] === '"') { index += 2; continue; }
        index += 1;
        break;
      }
      out += '""';
      continue;
    }
    const ch = text[index];
    if (ch === '"' || ch === "'") {
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue; }
        if (text[index] === ch) { index += 1; break; }
        index += 1;
      }
      out += ch + ch;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * reporting
 * ------------------------------------------------------------------ */

const outcomes = [];
let currentAssertion = { index: 0, name: '' };

function line(status, index, name, detail) {
  const suffix = detail ? ` -- ${detail}` : '';
  console.log(`${status.padEnd(5)} ${String(index).padStart(2)}. ${name}${suffix}`);
}

/**
 * The foreground window handle, resolved fresh.
 *
 * A desktop changes under a live probe, so a handle captured minutes earlier may
 * name a different window or a dead one. Probes resolve it immediately before use.
 */
async function currentForegroundHandle() {
  const result = await mod.runInLane('windows', '[NewmarkCuNative]::GetForegroundWindow().ToInt64()', 15000);
  if (!result || result.ok !== true) return 0;
  const value = Number(String(result.output).trim().split('\n').pop());
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The lowercase `0x` form that both the lane and app_list use. */
function hexHandle(handle) {
  return `0x${Number(handle).toString(16).toLowerCase()}`;
}

/**
 * The foreground window's class and visibility, read straight from the lane.
 *
 * Used by the app_list check to tell an ordinary application window - which must be listed -
 * from one of the shell's own windows, which app_list documents as excluded.
 */
async function foregroundWindowDetail(handleHexValue) {
  const script = [
    `$hwnd = [IntPtr]::new([Convert]::ToInt64('${String(handleHexValue).replace(/^0x/i, '')}', 16))`,
    'Write-Output (@{ class_name=[NewmarkCuNative]::ClassName($hwnd); visible=[NewmarkCuNative]::IsWindowVisible($hwnd); iconic=[NewmarkCuNative]::IsIconic($hwnd) } | ConvertTo-Json -Compress)',
  ].join('\r\n');
  const result = await mod.runInLane('windows', script, 15000);
  if (!result || result.ok !== true) return null;
  const lines = String(result.output).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* keep looking */ }
  }
  return null;
}

/**
 * The tool descriptions as they ship, read from the component that declares them.
 *
 * Deliberately not from a copy of the text pasted into this gate: `tools()` returns the
 * definition a caller is handed, so a description edited in the component cannot satisfy
 * a stale copy here, and the gate's own text cannot satisfy it either. No root is passed,
 * so the component's failure log resolves to "printed only" and this reads without
 * writing anything anywhere.
 */
async function shippedDescriptions() {
  const component = await import(new URL('../packages/newmark-core/components/computeruse/component.js', import.meta.url).href);
  return new Map(component.createComputerUse({}).tools().map(tool => [tool.name, tool]));
}

async function check(index, name, platform, body) {
  currentAssertion = { index, name };
  if (platform === 'win32' && !IS_WINDOWS) {
    outcomes.push({ index, name, status: 'SKIP' });
    line('SKIP', index, name, 'Windows-only assertion');
    return undefined;
  }
  try {
    const detail = await body();
    outcomes.push({ index, name, status: 'PASS' });
    line('PASS', index, name, detail === undefined ? '' : String(detail));
    return detail;
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error);
    outcomes.push({ index, name, status: 'FAIL', error, message });
    line('FAIL', index, name, message.split('\n')[0]);
    return undefined;
  }
}

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, Math.max(0, ms)); });
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

/* ------------------------------------------------------------------ *
 * the gate
 * ------------------------------------------------------------------ */

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ncu-verify-'));
const tempStatePath = path.join(tempDirectory, 'gate-state.json');
fs.writeFileSync(tempStatePath, JSON.stringify({ started_at: new Date().toISOString(), platform: process.platform, module: MODULE_PATH }, null, 2));

let mod;
let foregroundHandle = 0;

try {
  mod = await import(new URL('../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);

  await check(1, 'lanes_and_mode_inventory', 'any', () => {
    assert.deepStrictEqual(mod.lanes(), EXPECTED_LANES, 'lanes() must equal the seven lane ids in contract order');
    assert.deepStrictEqual(mod.MODE_INVENTORY, EXPECTED_MODE_INVENTORY, 'MODE_INVENTORY must have exactly the four axes with the contract ids');
    assert.deepStrictEqual(mod.LANES, EXPECTED_LANES, 'LANES must equal the same seven lane ids');
    return `lanes=${EXPECTED_LANES.length}, axes=${Object.keys(mod.MODE_INVENTORY).join('/')}`;
  });

  await check(2, 'constants_exact', 'any', () => {
    for (const [name, expected] of Object.entries(EXPECTED_CONSTANTS)) {
      assert.strictEqual(mod[name], expected, `${name} must be exactly ${expected}`);
      assert.strictEqual(typeof mod[name], 'number', `${name} must be a number`);
    }
    /* The lease has no time limit, so there is no TTL constant left to export. Re-adding
     * one - or re-adding a timer that reads one - fails here. The source checks match a
     * declaration, not the retired constant's name in prose: the module documents why the
     * TTL is gone, and a comment must not be able to fail or satisfy a gate. */
    assert.strictEqual(mod.LEASE_TTL_MS, undefined, 'the lease TTL constant must be gone: the lease has no expiry');
    assert.strictEqual(mod.LEASE_EXPIRY, 'none', 'LEASE_EXPIRY must report that the lease never expires');
    assert.strictEqual(mod.LEASE_RELEASE_ACTION, 'takeover_stop', 'the lease release action must be takeover_stop');
    assert.ok(!/(^|\n)\s*(export\s+)?const\s+LEASE_TTL_MS\s*=/.test(SOURCE), 'win32.js must not declare a lease TTL');
    assert.ok(!/setTimeout\([^)]*releaseLease/.test(SOURCE), 'win32.js must not arm a lease-expiry timer');
    assert.ok(!/'expired'/.test(SOURCE), "win32.js must not carry an 'expired' lease reason");
    return `${Object.entries(EXPECTED_CONSTANTS).map(([name, value]) => `${name}=${value}`).join(' ')}; lease expiry=none, no TTL`;
  });

  await check(3, 'sendkeys_key_normalization', 'any', () => {
    assert.strictEqual(mod.normalizeSendKeysKey('ctrl+l'), '^l', 'ctrl+l must normalise to ^l');
    assert.strictEqual(mod.normalizeSendKeysKey('ctrl+shift+l'), '^+l', 'ctrl+shift+l must normalise to ^+l');
    assert.strictEqual(mod.normalizeSendKeysKey('alt+f4'), '%{F4}', 'alt+f4 must normalise to %{F4}');
    assert.strictEqual(mod.normalizeSendKeysKey('enter'), '{ENTER}', 'enter must normalise to {ENTER}');
    assert.strictEqual(mod.normalizeSendKeysKey('^s'), '^s', 'existing .NET notation must pass through unchanged');
    return 'ctrl+l=^l ctrl+shift+l=^+l alt+f4=%{F4} enter={ENTER} ^s=^s';
  });

  await check(4, 'sendkeys_text_encoding', 'any', () => {
    const input = 'https://newmark.test/?q=a+b%25~(){}';
    const expected = 'https://newmark.test/?q=a{+}b{%}25{~}{(}{)}{{}{}}';
    assert.strictEqual(mod.encodeSendKeysText(input), expected, 'SendKeys metacharacters must be escaped and the rest left literal');
    assert.ok(mod.encodeSendKeysText(input).startsWith('https://newmark.test/?q=a'), 'the literal URL prefix must survive untouched');
    assert.strictEqual(mod.encodeSendKeysText('a\nb\tc'), 'a{ENTER}b{TAB}c', 'newlines and tabs must become {ENTER} and {TAB}');
    return `escaped ${input.length} chars -> ${expected.length} chars`;
  });

  await check(5, 'anti_coupling_source_markers', 'any', () => {
    const found = [];
    for (const marker of ANTI_COUPLING_MARKERS) {
      const pattern = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const match = pattern.exec(SOURCE);
      if (match) found.push(`${marker} at offset ${match.index} :: ${JSON.stringify(SOURCE.slice(Math.max(0, match.index - 60), match.index + 60))}`);
    }
    assert.deepStrictEqual(found, [], `retired experimental marker present in win32.js: ${found.join(' | ')}`);

    const token = NPU_TOKEN.exec(SOURCE);
    if (token) found.push(`NPU token at offset ${token.index} :: ${JSON.stringify(SOURCE.slice(Math.max(0, token.index - 60), token.index + 60))}`);
    assert.deepStrictEqual(found, [], `on-device model marker present in win32.js: ${found.join(' | ')}`);

    // Every raw "npu" occurrence must live inside the contract-mandated AttachThreadInput.
    const stripped = SOURCE.split(NPU_ALLOWED_IDENTIFIER).join('');
    const raw = /npu/i.exec(stripped);
    if (raw) found.push(`npu outside ${NPU_ALLOWED_IDENTIFIER} at offset ${raw.index} :: ${JSON.stringify(stripped.slice(Math.max(0, raw.index - 60), raw.index + 60))}`);
    assert.deepStrictEqual(found, [], `the letters npu may only appear inside ${NPU_ALLOWED_IDENTIFIER}: ${found.join(' | ')}`);

    const occurrences = SOURCE.split(new RegExp(NPU_ALLOWED_IDENTIFIER, 'gi')).length - 1;
    return `${ANTI_COUPLING_MARKERS.length + 1} markers clean; ${occurrences} "npu" substrings, all inside ${NPU_ALLOWED_IDENTIFIER}`;
  });

  await check(6, 'virtual_region_excludes_physical_apis', 'any', () => {
    const begin = SOURCE.indexOf(VIRTUAL_BEGIN);
    const end = SOURCE.indexOf(VIRTUAL_END);
    assert.ok(begin >= 0, `the ${VIRTUAL_BEGIN} marker is missing from win32.js`);
    assert.ok(end > begin, `the ${VIRTUAL_END} marker must follow ${VIRTUAL_BEGIN}`);
    const region = SOURCE.slice(begin + VIRTUAL_BEGIN.length, end);
    assert.ok(region.length > 2000, `the virtual-mode region is only ${region.length} characters, so it cannot contain the virtual delivery path`);
    assert.ok(region.includes('PostMessage') || region.includes('PostWindowMessage'), 'the virtual-mode region must contain the posted-message path');
    const offenders = PHYSICAL_APIS.filter(api => region.includes(api));
    assert.deepStrictEqual(offenders, [], `virtual-mode region references physical input APIs: ${offenders.join(', ')}`);
    return `region ${region.length} chars; none of ${PHYSICAL_APIS.join('/')}`;
  });

  await check(7, 'takeover_lease_is_exclusive_and_releases_to_real', 'any', async () => {
    const started = JSON.parse(await mod.runComputerUse({ action: 'takeover_start', ownerId: LEASE_OWNER_A, mouseMode: 'virtual' }));
    assert.strictEqual(started.ok, true, 'the first takeover_start must succeed');
    assert.strictEqual(started.mouse_mode, 'virtual', 'takeover_start must report the requested mouse mode');
    /* The lease has no time limit: every duration field must say so rather than carry a
     * number a caller would read as a real deadline. */
    assert.strictEqual(started.lease.expiry, 'none', 'a held lease must report expiry "none"');
    assert.strictEqual(started.lease.ttl_ms, null, 'a held lease must report ttl_ms null, not a number');
    assert.strictEqual(started.lease.expires_at, null, 'a held lease must report expires_at null, not a timestamp');
    assert.strictEqual(started.lease.expires_in_ms, null, 'a held lease must report expires_in_ms null, not a countdown');
    assert.strictEqual(started.lease.released_by, 'takeover_stop', 'a held lease must name takeover_stop as its release');

    const occupied = JSON.parse(await mod.runComputerUse({ action: 'takeover_start', ownerId: LEASE_OWNER_B, mouseMode: 'virtual' }));
    assert.strictEqual(occupied.ok, false, 'a second owner must not steal the lease');
    assert.strictEqual(occupied.error_code, 'takeover_lease_occupied', 'the occupied response needs its own error code');
    assert.strictEqual(occupied.lock_owner, LEASE_OWNER_A, 'the occupied response must name the lock owner');
    assert.strictEqual(occupied.requested_owner, LEASE_OWNER_B, 'the occupied response must name the requesting owner');
    assert.strictEqual(occupied.expires_in_ms, null, 'a refusal must not hand back a bogus countdown either');

    /* A lease must survive the old 120 s deadline. The clock is not fast-forwarded here -
     * check 2 asserts the timer and the TTL constant are gone at the source level, and the
     * real past-120 s hold is measured by the cufix evidence run. */

    const stopped = JSON.parse(await mod.runComputerUse({ action: 'takeover_stop', ownerId: LEASE_OWNER_A }));
    assert.strictEqual(stopped.ok, true, 'takeover_stop must succeed for the lease owner');
    assert.strictEqual(stopped.mouse_mode, 'real', 'takeover_stop must report mouseMode real even though the lease was virtual');
    assert.strictEqual(stopped.lease.expiry, 'none', 'a released lease must still report expiry "none"');
    assert.strictEqual(stopped.lease.ttl_ms, null, 'a released lease must not report a TTL');

    const report = JSON.parse(await mod.runComputerUse({ action: 'mode_report' }));
    assert.strictEqual(report.mouse_mode, 'real', 'mode_report must report mouseMode real after the lease is released');
    assert.strictEqual(report.lease.held, false, 'the lease must be free after takeover_stop');
    assert.strictEqual(report.lease.expiry, 'none', 'mode_report must report the lease as never expiring');
    assert.strictEqual(report.constants.lease_expiry, 'none', 'mode_report constants must state the lease expiry as none');
    assert.strictEqual(report.constants.lease_release_action, 'takeover_stop', 'mode_report constants must name the release action');
    assert.strictEqual(report.constants.lease_ttl_ms, undefined, 'mode_report must not publish a lease TTL constant any more');
    /* The overlay contract must have dropped lease expiry and must still declare the one
     * non-explicit stop path that remains, with its reason. */
    assert.deepStrictEqual(
      report.overlay_contract.stop_paths,
      ['takeover_stop', 'stopAll', 'process_exit', 'owner watchdog'],
      'the overlay stop paths must no longer contain lease_expiry',
    );
    assert.deepStrictEqual(report.overlay_contract.explicit_stop_paths, ['takeover_stop'], 'takeover_stop is the only explicit stop path');
    assert.strictEqual(report.overlay_contract.implicit_stop_paths.length, 1, 'there must be exactly one non-explicit stop path');
    assert.strictEqual(report.overlay_contract.implicit_stop_paths[0].path, 'owner watchdog', 'the non-explicit stop path must be the owner watchdog');
    assert.strictEqual(report.overlay_contract.implicit_stop_paths[0].trigger, 'owner-process-death', 'the watchdog must be documented as owner-death triggered');
    assert.ok(report.overlay_contract.implicit_stop_paths[0].reason.length > 20, 'the non-explicit stop path must carry its reason');

    const reacquired = JSON.parse(await mod.runComputerUse({ action: 'takeover_start', ownerId: LEASE_OWNER_B, mouseMode: 'real' }));
    assert.strictEqual(reacquired.ok, true, 'the freed lease must be acquirable by another owner');
    const released = JSON.parse(await mod.runComputerUse({ action: 'takeover_stop', ownerId: LEASE_OWNER_B }));
    assert.strictEqual(released.mouse_mode, 'real', 'the second release must also restore mouseMode real');
    return `exclusive, no expiry reported, one non-explicit stop path (owner watchdog), release restores real`;
  });

  await check(8, 'action_cannot_change_lease_mouse_mode', 'any', async () => {
    const started = JSON.parse(await mod.runComputerUse({ action: 'takeover_start', ownerId: LEASE_OWNER_A, mouseMode: 'virtual' }));
    assert.strictEqual(started.ok, true, 'the lease must be acquirable for this assertion');
    assert.strictEqual(started.mouse_mode, 'virtual', 'the lease must hold the virtual mode');

    const waited = JSON.parse(await mod.runComputerUse({ action: 'wait', durationMs: 1, ownerId: LEASE_OWNER_A, mouseMode: 'real' }));
    assert.strictEqual(waited.ok, true, 'the wait action must succeed');
    assert.strictEqual(waited.mouse_mode, 'real', 'an explicit real-mode read uses the independent real slot');

    const report = JSON.parse(await mod.runComputerUse({ action: 'mode_report', ownerId: LEASE_OWNER_A, mouseMode: 'virtual' }));
    assert.strictEqual(report.mouse_mode, 'virtual', 'mode_report must still report the lease mode');
    assert.strictEqual(report.mouse_mode_mutable_by_action, false, 'mode_report must state that an action cannot mutate the mode');
    assert.strictEqual(report.lease.owner_id, LEASE_OWNER_A, 'the lease owner must be unchanged');
    assert.strictEqual(report.lease.mouse_mode, 'virtual', 'the lease must still report the original mode');

    const stopped = JSON.parse(await mod.runComputerUse({ action: 'takeover_stop', ownerId: LEASE_OWNER_A }));
    assert.strictEqual(stopped.mouse_mode, 'real', 'releasing must restore mouseMode real');
    return 'lease mode virtual survived an action requesting real';
  });

  await check(9, 'windows_lane_ready_foreground_handle_and_no_orphans', 'win32', async () => {
    const prepared = await mod.prepareLane('windows', 15000);
    assert.strictEqual(prepared.ready, true, `prepareLane('windows', 15000) must become ready (${JSON.stringify(prepared)}) ${JSON.stringify((mod.laneDiagnostics() || []).find(item => item.lane === 'windows') || {})}`);
    assert.strictEqual(typeof prepared.elapsedMs, 'number', 'prepareLane must report elapsedMs');
    assert.strictEqual(mod.laneReady('windows'), true, 'laneReady must report the windows lane ready');

    const foreground = await mod.runInLane('windows', '[NewmarkCuNative]::GetForegroundWindow().ToInt64()', 15000);
    assert.strictEqual(foreground.ok, true, `runInLane must succeed: ${foreground.output}`);
    foregroundHandle = Number(String(foreground.output).trim().split('\n').pop());
    assert.ok(Number.isFinite(foregroundHandle) && foregroundHandle > 0, `the windows lane must return the real foreground window handle, received ${JSON.stringify(foreground.output)}`);

    const livePids = (mod.laneDiagnostics() || [])
      .filter(item => item.live === true && Number.isInteger(item.child_pid) && item.child_pid > 0)
      .map(item => item.child_pid);
    assert.ok(livePids.length >= 1, 'at least one live lane child process must exist before stopAll');

    const second = await mod.runInLane('windows', '2 + 2', 15000);
    assert.strictEqual(second.ok, true, 'the same lane must still answer after the first script');
    assert.strictEqual(String(second.output).trim(), '4', 'the lane must return the script output');

    mod.stopAll();
    assert.strictEqual(mod.liveLaneCount(), 0, 'liveLaneCount() must be 0 immediately after stopAll()');
    const deadline = Date.now() + 5000;
    let orphans = livePids.filter(isProcessAlive);
    while (orphans.length && Date.now() < deadline) {
      await sleep(100);
      orphans = livePids.filter(isProcessAlive);
    }
    assert.deepStrictEqual(orphans, [], `lane child processes still alive after stopAll(): ${orphans.join(', ')}`);
    assert.strictEqual(mod.laneReady('windows'), false, 'the windows lane must not be ready after stopAll()');
    assert.strictEqual(mod.liveLaneCount(), 0, 'liveLaneCount() must stay 0 after stopAll()');
    return `foreground=0x${foregroundHandle.toString(16).toUpperCase()}, ${livePids.length} child process(es) terminated`;
  });

  await check(10, 'app_list_json_shape', 'win32', async () => {
    let parsed;
    let windows = [];
    let attempts = 0;
    for (attempts = 1; attempts <= 3; attempts += 1) {
      const raw = await mod.runComputerUse({ action: 'app_list' });
      parsed = JSON.parse(raw);
      assert.strictEqual(typeof raw, 'string', 'runComputerUse must return a JSON string');
      assert.strictEqual(parsed.ok, true, `app_list must succeed: ${parsed.error || ''}`);
      windows = Array.isArray(parsed.applications) ? parsed.applications : parsed.windows;
      assert.ok(Array.isArray(windows), 'app_list must return an applications array');
      if (windows.length > 0) break;
      await sleep(500);
    }
    for (const window of windows) {
      assert.strictEqual(typeof window.handle, 'string', 'every window needs a string handle');
      assert.match(window.handle, /^0x[0-9A-Fa-f]+$/, `window handle must be a hex string, received ${JSON.stringify(window.handle)}`);
      assert.strictEqual(typeof window.title, 'string', 'every window needs a string title');
      assert.strictEqual(typeof window.process_id, 'number', 'every window needs a numeric process_id');
      assert.ok(Number.isFinite(window.process_id) && window.process_id > 0, 'every window needs a positive process_id');
      assert.strictEqual(typeof window.rect, 'object', 'every window needs a rect');
      assert.strictEqual(typeof window.client_rect, 'object', 'every window needs a client_rect');
      assert.strictEqual(typeof window.visible, 'boolean', 'every window needs a visible flag');
      assert.strictEqual(typeof window.minimized, 'boolean', 'every window needs a minimized flag');
      assert.strictEqual(typeof window.foreground, 'boolean', 'every window needs a foreground flag');
    }
    // Re-resolve before asserting: the window captured during lane readiness may
    // have been replaced since, and a stale handle is not a defect in app_list.
    const foregroundNow = await currentForegroundHandle();
    let foregroundSkipReason = '';
    if (foregroundNow > 0) {
      assert.ok(windows.length > 0, 'a desktop with a foreground window must list at least one top-level window');
      /* An ordinary application window in the foreground must be listed. The shell's own
       * windows are a documented exception: the enumerator skips Shell_TrayWnd,
       * Shell_SecondaryTrayWnd, Progman and WorkerW, and it skips invisible or occluded
       * windows in real scope. When the taskbar or the desktop itself holds the foreground -
       * which happens whenever the last window is dismissed - "app_list must include the
       * foreground window" would demand the enumerator break its own contract. So the check
       * asserts the contract: an ordinary foreground window must appear, and a
       * documented-exclusion window must not be reported as a defect. */
      const skipClasses = ['Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Progman', 'WorkerW'];
      const detail = await foregroundWindowDetail(hexHandle(foregroundNow));
      if (detail && skipClasses.includes(String(detail.class_name))) {
        foregroundSkipReason = `the foreground window is the shell window ${detail.class_name}, which app_list documents as excluded`;
      } else if (detail && (detail.visible === false || detail.occluded === true)) {
        foregroundSkipReason = `the foreground window is ${detail.visible === false ? 'invisible' : 'occluded'}, which real scope documents as excluded`;
      } else {
        assert.ok(
          windows.some(window => window.handle.toLowerCase() === hexHandle(foregroundNow)),
          `app_list must include the foreground window (${hexHandle(foregroundNow)}${detail ? ` ${detail.class_name}` : ''})`,
        );
      }
    }
    return `${windows.length} window(s) listed after ${attempts} attempt(s), all with handle/title/process_id${foregroundSkipReason ? `; ${foregroundSkipReason}` : ''}`;
  });

  await check(11, 'dpi_rule_and_extra_info_rule', 'any', () => {
    const dpiWrapper = /SetCursorPosPhysical\s*\([^)]*\)\s*\{[\s\S]{0,400}?SetThreadDpiAwarenessContext\(new IntPtr\(-4\)\)[\s\S]{0,400}?finally/;
    assert.match(SOURCE, dpiWrapper, 'the physical cursor entry point must wrap SetCursorPos in SetThreadDpiAwarenessContext(new IntPtr(-4)) and restore it in a finally');
    // The C# carries the exported constant as a template token, so the file text shows
    // ${MOVE_CURVE_TOKEN}; assertion 2 pins the exported value to 50 and the lane readiness
    // in assertion 9 proves the interpolated C# still compiles.
    const durationToken = /\$\{MOVE_CURVE_TOKEN\}/g;
    const tokenUses = [...SOURCE.matchAll(durationToken)].length;
    assert.ok(tokenUses >= 3, `every interpolated cursor curve must use the exported MOVE_CURVE_MS token, found ${tokenUses}`);
    assert.strictEqual(mod.MOVE_CURVE_MS, 50, 'MOVE_CURVE_MS must be 50, the value interpolated into the curve');
    const smooth = /MoveCursorSmooth\s*\(int x, int y\)[\s\S]{0,4000}?const int duration = \$\{MOVE_CURVE_TOKEN\};/;
    assert.match(SOURCE, smooth, 'MoveCursorSmooth must interpolate the cursor over roughly 50 ms');
    const resolvedNative = SOURCE.split('${MOVE_CURVE_TOKEN}').join(String(mod.MOVE_CURVE_MS));
    assert.match(resolvedNative, /const int duration = 50;/, 'the interpolated helper must carry the 50 ms curve duration');
    assert.match(resolvedNative, /SetThreadDpiAwarenessContext\(new IntPtr\(-4\)\)/, 'the interpolated helper must install the physical DPI context');

    const allMouseEvent = [...SOURCE.matchAll(/mouse_event\(([^)]*)\)/g)].map(match => match[1].replace(/\s+/g, ' ').trim());
    const declarations = allMouseEvent.filter(args => args.includes('dwFlags'));
    const callSites = allMouseEvent.filter(args => !args.includes('dwFlags'));
    assert.deepStrictEqual(declarations, ['uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo'], 'mouse_event must be declared once with the UIntPtr dwExtraInfo parameter');
    assert.ok(callSites.length >= 6, `the real pointer path must call mouse_event from every button and wheel transition, found ${callSites.length}`);
    const bad = callSites.filter(args => !args.endsWith('[System.UIntPtr]::Zero'));
    assert.deepStrictEqual(bad, [], `every mouse_event call site must pass [System.UIntPtr]::Zero explicitly: ${bad.join(' | ')}`);
    return `${callSites.length} mouse_event call site(s), all ending in [System.UIntPtr]::Zero; DPI -4 wrapped in finally`;
  });

  await check(12, 'virtual_mode_refusals_and_posting_helpers', 'win32', async () => {
    const refusals = [];
    for (const request of [
      { action: 'observe', mouseMode: 'virtual' },
      { action: 'app_observe', mouseMode: 'virtual' },
      { action: 'sequence', mouseMode: 'virtual', steps: [{ action: 'wait', durationMs: 1 }] },
    ]) {
      const result = JSON.parse(await mod.runComputerUse(request));
      refusals.push({ action: request.action, result });
    }
    for (const { action, result } of refusals) {
      assert.strictEqual(result.ok, false, `${action} must be refused in virtual mode`);
      assert.strictEqual(result.error_code, 'virtual_mode_unsupported_action', `${action} must refuse with virtual_mode_unsupported_action, received ${result.error_code}`);
      assert.strictEqual(result.mouse_mode, 'virtual', `${action} must report mouse_mode virtual`);
      assert.strictEqual(result.fallback_to_real_delivery, false, `${action} must never fall back to real delivery`);
      assert.notStrictEqual(result.action_completed, true, `${action} must not report a completed action`);
    }
    const lease = JSON.parse(await mod.runComputerUse({ action: 'takeover_start', ownerId: LEASE_OWNER_A, mouseMode: 'virtual' }));
    assert.strictEqual(lease.mouse_mode, 'virtual', 'a virtual lease must report the virtual mode');
    const observeUnderLease = JSON.parse(await mod.runComputerUse({ action: 'observe', ownerId: LEASE_OWNER_A }));
    assert.strictEqual(observeUnderLease.error_code, 'virtual_mode_unsupported_action', 'observe under a virtual lease must be refused as well');
    const released = JSON.parse(await mod.runComputerUse({ action: 'takeover_stop', ownerId: LEASE_OWNER_A }));
    assert.strictEqual(released.mouse_mode, 'real', 'the virtual lease must release back to real');

    // Invariant 3 without any delivered message: a virtual point outside the target client
    // area is refused before anything is posted, so no window can receive a stray message.
    // The target is resolved fresh, and one retry is allowed. If the foreground
    // window closes between resolution and the post, the backend correctly reports
    // `target_window_invalid`; retrying against a new window keeps this probe's
    // point — the client-area refusal — while removing the race.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const target = await currentForegroundHandle();
      if (target === 0) break;
      const outside = JSON.parse(await mod.runComputerUse({ action: 'click', mouseMode: 'virtual', windowHandle: `0x${target.toString(16)}`, x: -4000, y: -4000 }));
      assert.strictEqual(outside.ok, false, 'a virtual click outside the client area must be refused');
      if (outside.error_code === 'target_window_invalid' && attempt === 1) {
        await sleep(300);
        continue;
      }
      assert.strictEqual(outside.error_code, 'virtual_point_outside_client_area', `the refusal must name the client-area limit, received ${outside.error_code}`);
      assert.strictEqual(outside.physical_delivery_used, false, 'the refusal must not have used physical delivery');
      assert.strictEqual(outside.mouse_mode, 'virtual', 'the refusal must stay in virtual mode');
      break;
    }

    // The posted-message helpers must exist and must refuse a null window without posting.
    const prepared = await mod.prepareLane('windows', 15000);
    assert.strictEqual(prepared.ready, true, 'the windows lane must be ready for the posting-helper probe');
    const probe = await mod.runInLane('windows', [
      '$path = [NewmarkCuNative]::PostMousePath([IntPtr]::Zero, 0, 0, 10, 10, $false, $false)',
      '$clickPath = [NewmarkCuNative]::PostMousePath([IntPtr]::Zero, 0, 0, 10, 10, $true, $true)',
      '$drag = [NewmarkCuNative]::PostMouseDrag([IntPtr]::Zero, 0, 0, 5, 5, 9, 9, $false)',
      '$wheel = [NewmarkCuNative]::PostWindowMessage([IntPtr]::Zero, 0x020A, 0, 0)',
      '$char = [NewmarkCuNative]::PostWindowMessage([IntPtr]::Zero, 0x0102, 65, 0)',
      '$client = [NewmarkCuNative]::IsClientPoint([IntPtr]::Zero, 5, 5)',
      '$lparam = [NewmarkCuNative]::KeyMessageLParam(13, $false)',
      'Write-Output (@{ path=$path; click_path=$clickPath; drag=$drag; wheel=$wheel; char=$char; client=$client; lparam=$lparam } | ConvertTo-Json -Compress)',
    ].join('\r\n'), 15000);
    assert.strictEqual(probe.ok, true, `the posting-helper probe must run: ${probe.output}`);
    const probed = JSON.parse(String(probe.output).trim().split('\n').pop());
    for (const field of ['path', 'click_path', 'drag', 'wheel', 'char', 'client']) {
      assert.strictEqual(probed[field], false, `the virtual helper ${field} must refuse a null window instead of posting`);
    }
    assert.ok(Number.isFinite(Number(probed.lparam)) && Number(probed.lparam) !== 0, 'KeyMessageLParam must build a real key lParam');
    mod.stopAll();
    return `${refusals.length} refusals + lease refusal + client-area refusal; posting helpers refuse a null window`;
  });

  await check(13, 'target_window_ownership_guard', 'win32', async () => {
    const prepared = await mod.prepareLane('windows', 15000);
    assert.strictEqual(prepared.ready, true, 'the windows lane must be ready for the ownership probe');
    const probe = await mod.runInLane('windows', [
      '$foreground = [NewmarkCuNative]::GetForegroundWindow()',
      '$ownerProcess = [NewmarkCuNative]::GetProcessId($foreground)',
      '$sameOwner = [NewmarkCuNative]::WindowOwnershipState($foreground, $ownerProcess)',
      '$otherOwner = [NewmarkCuNative]::WindowOwnershipState($foreground, ($ownerProcess + 1))',
      '$staleHandle = [NewmarkCuNative]::WindowOwnershipState([IntPtr]::new(4294901761), 0)',
      '$nullHandle = [NewmarkCuNative]::WindowOwnershipState([IntPtr]::Zero, 0)',
      '$unspecified = [NewmarkCuNative]::WindowOwnershipState($foreground, 0)',
      '$iconic = [NewmarkCuNative]::IsIconic($foreground)',
      'Write-Output (@{ same_owner=$sameOwner; other_owner=$otherOwner; stale_handle=$staleHandle; null_handle=$nullHandle; unspecified=$unspecified; iconic=$iconic; pid=$ownerProcess } | ConvertTo-Json -Compress)',
    ].join('\r\n'), 15000);
    assert.strictEqual(probe.ok, true, `the ownership probe must run: ${probe.output}`);
    const probed = JSON.parse(String(probe.output).trim().split('\n').pop());
    assert.strictEqual(probed.same_owner, 0, 'a live window owned by the expected process must verify as usable');
    assert.strictEqual(probed.other_owner, 2, 'a process id that no longer owns the window must be reported as ownership changed');
    assert.strictEqual(probed.stale_handle, 1, 'a stale handle must be reported as an invalid window');
    assert.strictEqual(probed.null_handle, 1, 'a null handle must be reported as an invalid window');
    assert.strictEqual(probed.unspecified, 0, 'an unspecified expected process id must still require a live window');
    assert.ok(Number.isFinite(Number(probed.pid)) && Number(probed.pid) > 0, 'the probe must resolve the foreground process id');

    // The same guard must reach the action surface as a structured refusal, never as an action.
    const refused = JSON.parse(await mod.runComputerUse({ action: 'app_click', mouseMode: 'virtual', windowHandle: '0xFFFF0001', x: 5, y: 5, dryRun: true }));
    assert.strictEqual(refused.ok, false, 'acting on a stale window handle must be refused');
    assert.strictEqual(refused.error_code, 'target_window_invalid', `the refusal must name the invalid window, received ${refused.error_code}`);
    mod.stopAll();
    return `ownership 0/2/1/1 verified in the lane; stale handle refused as ${refused.error_code}`;
  });

  await check(14, 'native_helper_surface', 'any', () => {
    const templateStart = SOURCE.indexOf('const NATIVE_CSHARP_TEMPLATE = `');
    const templateEnd = SOURCE.indexOf('`;', templateStart + 10);
    assert.ok(templateStart > 0 && templateEnd > templateStart, 'the C# native helper template must be present');
    const classText = SOURCE.slice(templateStart, templateEnd);
    assert.ok(classText.includes('public static class NewmarkCuNative'), 'the native helper class must be named NewmarkCuNative');
    const required = [
      'SetCursorPos', 'mouse_event', 'GetForegroundWindow', 'SetForegroundWindow', 'ShowWindow',
      'IsWindow', 'IsWindowVisible', 'IsIconic', 'GetWindowRect', 'GetClientRect', 'ClientToScreen',
      'ScreenToClient', 'WindowFromPoint', 'GetWindowThreadProcessId', 'GetCurrentThreadId',
      'AttachThreadInput', 'BringWindowToTop', 'SetActiveWindow', 'SetThreadDpiAwarenessContext',
      'GetSystemMetrics', 'PostMessage', 'PrintWindow', 'MoveCursorSmooth',
    ];
    const missing = required.filter(name => !new RegExp(`\\b${name}\\s*\\(`).test(classText));
    assert.deepStrictEqual(missing, [], `the native helper is missing mandated members: ${missing.join(', ')}`);
    for (const signature of [
      'GetWindowRect(IntPtr hWnd, out RECT rect)',
      'GetClientRect(IntPtr hWnd, out RECT rect)',
      'ClientToScreen(IntPtr hWnd, ref POINT point)',
      'ScreenToClient(IntPtr hWnd, ref POINT point)',
      'WindowFromPoint(POINT point)',
      'GetWindowThreadProcessId(IntPtr hWnd, out uint processId)',
      'SetThreadDpiAwarenessContext(IntPtr dpiContext)',
      'PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags)',
      'MoveCursorSmooth(int x, int y)',
      'SetCursorPos(int x, int y)',
    ]) {
      assert.ok(classText.includes(signature), `the native helper must declare ${signature}`);
    }
    assert.match(classText, /PostMessage\(IntPtr hWnd, uint msg, UIntPtr wParam, IntPtr lParam\)/, 'the posted-message entry point must take (IntPtr, uint, UIntPtr, IntPtr)');
    assert.match(classText, /mouse_event\(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo\)/, 'mouse_event must expose the dwExtraInfo pointer');

    const guard = `if (-not ("NewmarkCuNative" -as [type]))`;
    assert.ok(SOURCE.includes(guard), 'the helper must be compiled once per lane behind the type guard');
    assert.ok(SOURCE.includes('Add-Type -TypeDefinition'), 'the helper must be compiled with Add-Type -TypeDefinition');
    const laneLoads = /function createHostScript\(lane\)/.test(SOURCE) && SOURCE.includes('hostScript(this.lane)');
    assert.ok(laneLoads, 'every lane must build (and therefore compile) its own helper host');

    /* The helper must NOT travel on the command line. It used to be interpolated into the
     * `-Command` argument, which put it inside CreateProcess's ~32 KB command-line limit;
     * the unicode delivery path and the activation record pushed it past that and every lane
     * died with `spawn ENAMETOOLONG`. It now arrives on stdin, so this must stay true. */
    assert.ok(!/psQuote\(NATIVE_CSHARP\)/.test(SOURCE), 'the helper must never be quoted into the command line again: that reintroduces the command-line ceiling');
    assert.ok(/function helperBootstrap\(\)/.test(SOURCE), 'the helper must be handed over by a bootstrap envelope');
    assert.ok(SOURCE.includes('helperBootstrap()'), 'the bootstrap envelope must actually be written to the lane');
    assert.ok(SOURCE.includes('$newmarkBootstrap = [Console]::In.ReadLine()'), 'the host must read the helper from its first stdin line, before it reports readiness');
    assert.ok(/child\.stdin\.write\(helperBootstrap\(\)/.test(SOURCE), 'the bootstrap must be written immediately after the spawn, before any request is queued');
    return `${required.length} mandated members present behind the Add-Type guard; helper delivered on stdin, not on the command line`;
  });
  await check(15, 'capture_never_silently_empty_or_monochrome', 'win32', async () => {
    const imagePath = path.join(tempDirectory, 'observe.png');
    const result = JSON.parse(await mod.runComputerUse({ action: 'observe', observation: 'full', windowHandle: process.env.NEWMARK_TEST_WINDOW_HANDLE, imagePath, captureTimeoutMs: 30000, timeoutMs: 8000 }));
    if (result.ok === true) {
      assert.ok(Number.isFinite(result.width) && result.width > 0, `a successful capture needs a positive width, received ${result.width}`);
      assert.ok(Number.isFinite(result.height) && result.height > 0, `a successful capture needs a positive height, received ${result.height}`);
      assert.ok(result.capture && result.capture.digest, 'a successful capture needs a capture digest');
      assert.ok(result.capture.digest.distinct_luma > 1, `a monochrome capture must be a hard error, not a silent image (distinct_luma=${result.capture.digest.distinct_luma})`);
      assert.strictEqual(result.capture.capture_method, 'PrintWindow(hwnd,hdc,2)', 'full observation must use PrintWindow(hwnd, hdc, 2)');
      assert.ok(fs.existsSync(imagePath), 'the real desktop capture must be written to the requested path');
      assert.ok(fs.statSync(imagePath).size > 0, 'the capture file must not be empty');
      return `captured ${result.width}x${result.height}, ${result.capture.digest.distinct_luma} distinct luma levels, ${fs.statSync(imagePath).size} bytes`;
    }
    assert.strictEqual(typeof result.error_code, 'string', `a failed capture must carry a structured error code, received ${JSON.stringify(result)}`);
    assert.ok(result.error_code.length > 0 && typeof result.error === 'string', 'a failed capture must carry a structured error code and message');
    assert.notStrictEqual(result.error_code, 'capture_result_invalid', 'a capture must never come back as an unreadable empty image');
    return `structured hard error instead of an empty image: ${result.error_code}`;
  });

  /**
   * The activation contract, measured rather than asserted from prose.
   *
   * The recorded defect: `app_activate` answered `{"foreground_verified": true, "app": {...
   * "foreground": false}}` while `GetForegroundWindow()` held a different window. The two
   * halves of this check are (a) the source cannot build that answer any more and (b) the
   * measurement primitive itself never reports a window that is not the foreground window.
   */
  await check(16, 'app_activate_reports_only_a_measured_foreground', 'any', async () => {
    const activation = SOURCE.slice(SOURCE.indexOf('function activateScript('), SOURCE.indexOf('function foregroundHolder('));
    assert.ok(activation.length > 500, 'the activation script region must be present');
    assert.ok(activation.includes('ActivateWindowDetailed('), 'activation must use the detailed attempt that reports what it measured');
    assert.ok(activation.includes('ForegroundFacts('), 'the activation answer must come from a foreground read taken after the attempt');
    assert.ok(!/foreground_verified=\$true/.test(activation), 'the activation answer must never hard-code foreground_verified=$true');
    assert.ok(activation.includes('foreground_verified=$measured.ForegroundIsTarget'), 'foreground_verified must be the measured value');
    assert.ok(activation.includes('foreground_handle='), 'the answer must carry the handle that really holds the foreground');
    assert.ok(!SOURCE.includes('if (-not [NewmarkCuNative]::ActivateWindow($hwnd))'), 'the old unmeasured activation call must be gone');

    const classText = SOURCE.slice(SOURCE.indexOf('const NATIVE_CSHARP_TEMPLATE = `'), SOURCE.indexOf('`;', SOURCE.indexOf('const NATIVE_CSHARP_TEMPLATE = `') + 10));
    for (const member of ['CuActivationInfo', 'ActivateWindowDetailed', 'ForegroundFacts', 'TryForeground', 'SetWindowPos']) {
      assert.ok(classText.includes(member), `the native helper must carry ${member}`);
    }
    for (const technique of ['minimize+restore', 'topmost-toggle', 'restore+attach+SetForegroundWindow']) {
      assert.ok(classText.includes(technique), `the activation ladder must keep the ${technique} technique`);
    }

    const wrapper = SOURCE.slice(SOURCE.indexOf('async function activateWithVerification('), SOURCE.indexOf('async function appActivateAction('));
    assert.ok(/for \(let attempt = 1; attempt <= ACTIVATION_ATTEMPTS/.test(wrapper), 'activation must be retried, not attempted once');
    assert.ok(wrapper.includes("'foreground_not_granted'"), 'an activation that never lands must be a structured foreground_not_granted failure');
    assert.ok(wrapper.includes('foreground: holder'), 'the refusal must carry the window that really holds the foreground');
    assert.ok(wrapper.includes('foreground_verified: false'), 'the refusal must state foreground_verified false');
    const activateAction = SOURCE.slice(SOURCE.indexOf('async function appActivateAction('), SOURCE.indexOf('async function appActivateAction(') + 2000);
    assert.ok(/foreground: activated\.foreground_is_target === true/.test(activateAction), 'the app record must be refreshed from the measurement, never left stale');

    if (!IS_WINDOWS) return 'source contract verified; the desktop probe is Windows-only';

    /* The measurement primitive, exercised against a window that can never be the
     * foreground window: a child HWND. GetForegroundWindow() only ever returns a top-level
     * window, so ForegroundFacts must answer ForegroundIsTarget=false and still name the
     * real holder. Read-only: nothing is activated by this probe. */
    const prepared = await mod.prepareLane('windows', 20000);
    assert.strictEqual(prepared.ready, true, `the windows lane must be ready (${JSON.stringify((mod.laneDiagnostics() || []).find(item => item.lane === 'windows') || {})})`);
    const probe = await mod.runInLane('windows', [
      'if (-not ("CufixForegroundProbe" -as [type])) {',
      '  Add-Type -TypeDefinition @\'',
      'using System;',
      'using System.Collections.Generic;',
      'using System.Runtime.InteropServices;',
      'public static class CufixForegroundProbe {',
      '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);',
      '  public delegate bool EnumProc(IntPtr hWnd, IntPtr param);',
      '  public static List<IntPtr> Children(IntPtr root) { List<IntPtr> rows = new List<IntPtr>(); EnumChildWindows(root, delegate(IntPtr h, IntPtr p) { rows.Add(h); return true; }, IntPtr.Zero); return rows; }',
      '}',
      '\'@',
      '}',
      '$foreground = [NewmarkCuNative]::GetForegroundWindow()',
      '$children = [CufixForegroundProbe]::Children($foreground)',
      'if ($children.Count -eq 0) { Write-Output (@{ skipped=$true } | ConvertTo-Json -Compress) } else {',
      '  $child = $children[0]',
      '  $childFacts = [NewmarkCuNative]::ForegroundFacts($child)',
      '  $rootFacts = [NewmarkCuNative]::ForegroundFacts($foreground)',
      '  Write-Output (@{ skipped=$false; child_is_target=$childFacts.ForegroundIsTarget; child_granted=$childFacts.Granted; child_foreground_handle=("0x{0:X}" -f $childFacts.ForegroundHandle); root_is_target=$rootFacts.ForegroundIsTarget; root_handle=("0x{0:X}" -f $foreground.ToInt64()); child_handle=("0x{0:X}" -f $child.ToInt64()); child_title=$childFacts.ForegroundTitle; child_pid=$childFacts.ForegroundProcessId } | ConvertTo-Json -Compress)',
      '}',
    ].join('\r\n'), 20000);
    assert.strictEqual(probe.ok, true, `the foreground-facts probe must run: ${probe.output}`);
    const probed = JSON.parse(String(probe.output).trim().split('\n').pop());
    if (probed.skipped === true) return 'source contract verified; the foreground window had no child window to measure';

    assert.strictEqual(probed.child_is_target, false, 'a child HWND must never be reported as the foreground window');
    assert.strictEqual(probed.child_granted, false, 'a child HWND must never be reported as granted the foreground');
    assert.strictEqual(String(probed.child_foreground_handle).toLowerCase(), String(probed.root_handle).toLowerCase(), 'the measurement must name the window that really holds the foreground');
    assert.strictEqual(probed.root_is_target, true, 'the real foreground window must measure as the target when it is the target');

    /* And the same target through the action surface: a child handle can never leave itself
     * in the foreground, so this must be the structured refusal that names the real holder
     * - never ok:true, and never foreground_verified:true. */
    const refused = JSON.parse(await mod.runComputerUse({ action: 'app_activate', windowHandle: probed.child_handle }));
    assert.strictEqual(refused.ok, false, `activating a child window must be refused, received ${JSON.stringify(refused).slice(0, 400)}`);
    assert.strictEqual(refused.error_code, 'foreground_not_granted', `the refusal must be foreground_not_granted, received ${refused.error_code}`);
    assert.strictEqual(refused.foreground_verified, false, 'a refused activation must not report foreground_verified true');
    assert.strictEqual(refused.foreground_is_target, false, 'a refused activation must not report the target as the foreground');
    assert.strictEqual(String(refused.expected_handle).toLowerCase(), String(probed.child_handle).toLowerCase(), 'the refusal must name the handle it was asked to activate');
    assert.ok(refused.foreground && /^0x[0-9a-f]+$/i.test(String(refused.foreground.handle)), `the refusal must name the window that really holds the foreground, received ${JSON.stringify(refused.foreground)}`);
    assert.notStrictEqual(String(refused.foreground.handle).toLowerCase(), String(probed.child_handle).toLowerCase(), 'the named holder must not be the target that failed');
    assert.strictEqual(refused.activation_attempts, 3, 'the refusal must report the attempts it made');
    assert.ok(typeof refused.error === 'string' && refused.error.includes(String(refused.foreground.handle)), 'the refusal message must name the window that really holds the foreground');
    return `source contract verified; child ${probed.child_handle} refused as ${refused.error_code}, real holder ${refused.foreground.handle} named`;
  });

  /**
   * The literal-text contract for `type`.
   *
   * The recorded defect: typing `newmark2dsh-publish` with a Chinese IME active put a
   * composed string in the field, because the delivery path typed *keystrokes* and the IME
   * was free to read "new" as a pinyin syllable. `type` now delivers the characters
   * themselves as unicode key events. This check asserts the mechanism at the source level,
   * and proves the entry point and record size are real - without typing anything, because
   * this gate must never put characters on the user's desktop.
   */
  await check(17, 'type_delivers_literal_characters_not_keystrokes', 'any', async () => {
    const typeScript = SOURCE.slice(SOURCE.indexOf('function realTypeScript('), SOURCE.indexOf('function realKeyScript('));
    assert.ok(typeScript.length > 400, 'the type script region must be present');
    assert.ok(typeScript.includes('SendUnicodeText('), 'type must deliver through the unicode text path');
    assert.ok(!typeScript.includes('SendWait'), 'type must no longer type keystrokes: an IME composes those');
    assert.ok(!/Set-Clipboard|Get-Clipboard|Clipboard::|'\^v'|"\^v"/.test(typeScript), 'type must not touch the clipboard at all, so there is nothing to restore');
    assert.ok(typeScript.includes('text_delivery="unicode-key-events"'), 'the answer must name the delivery mechanism');
    assert.ok(typeScript.includes('clipboard_used=$false'), 'the answer must state that no clipboard was used');
    assert.ok(typeScript.includes('composed_by_ime=$false'), 'the answer must state that no IME composed the text');
    assert.ok(/unicode_delivery_failed/.test(typeScript), 'a short delivery must be a structured failure, not a silent success');

    /* `key` deliberately still sends real key names: the fix is for text, not for chords. */
    const keyScript = SOURCE.slice(SOURCE.indexOf('function realKeyScript('), SOURCE.indexOf('function activateScript('));
    assert.ok(keyScript.includes('SendWait('), 'key must keep sending real keys and chords');

    const classText = SOURCE.slice(SOURCE.indexOf('const NATIVE_CSHARP_TEMPLATE = `'), SOURCE.indexOf('`;', SOURCE.indexOf('const NATIVE_CSHARP_TEMPLATE = `') + 10));
    assert.ok(classText.includes('SendUnicodeText(string text)'), 'the native helper must expose the unicode text delivery');
    assert.ok(classText.includes('KEYEVENTF_UNICODE'), 'delivery must use unicode key events, which no IME composes');
    assert.ok(/for \(int i = 0; i < text\.Length; i\+\+\)/.test(classText), 'delivery must walk UTF-16 code units, so surrogate pairs are carried as their two halves');
    assert.ok(classText.includes('records.Add(UnicodeEvent(unit, false))') && classText.includes('records.Add(UnicodeEvent(unit, true))'), 'each unit must get its own press and release');
    assert.ok(!/SendWait/.test(classText), 'the native helper must not use the composer-prone keystroke path');

    if (!IS_WINDOWS) return 'source contract verified; the delivery probe is Windows-only';

    /* Prove the export really resolves and the record is the size Win32 demands, without
     * sending a single key: a zero-count call must return 0 rather than throw. A wrong
     * entry point name or a wrong struct layout would otherwise only fail at type time. */
    const prepared = await mod.prepareLane('windows', 20000);
    assert.strictEqual(prepared.ready, true, `the windows lane must be ready (${JSON.stringify((mod.laneDiagnostics() || []).find(item => item.lane === 'windows') || {})})`);
    const probe = await mod.runInLane('windows', [
      '$emptyText = [NewmarkCuNative]::SendUnicodeText("")',
      '$eventType = [type]"NewmarkCuNative+CuEvent"',
      '$instance = [System.Activator]::CreateInstance($eventType)',
      '$size = [System.Runtime.InteropServices.Marshal]::SizeOf($instance)',
      '$expected = 40',
      'if ([IntPtr]::Size -eq 4) { $expected = 28 }',
      '$empty = [Array]::CreateInstance($eventType, 0)',
      '$zeroCount = [NewmarkCuNative]::SendKeyEvents(0, $empty, $size)',
      'Write-Output (@{ empty_text=$emptyText; size=$size; expected=$expected; zero_count=$zeroCount } | ConvertTo-Json -Compress)',
    ].join('\r\n'), 20000);
    assert.strictEqual(probe.ok, true, `the unicode delivery probe must run: ${probe.output}`);
    const probed = JSON.parse(String(probe.output).trim().split('\n').pop());
    assert.strictEqual(probed.empty_text, 0, 'an empty string must deliver nothing rather than fail');
    assert.strictEqual(probed.size, probed.expected, `the key-event record must be exactly ${probed.expected} bytes, the size Win32 requires (got ${probed.size})`);
    assert.strictEqual(probed.zero_count, 0, 'the delivery entry point must resolve and accept a zero-count batch without throwing');
    return `source contract verified; entry point resolves, record is ${probed.size} bytes, no keys sent`;
  });

  /**
   * Input focus: a foreground window is not enough for a keystroke to reach a document.
   *
   * The recorded defect: with Edge verified as the foreground window, `^0` did not reset the
   * page zoom and a scroll did not move the page. Measured cause: keyboard focus sat on the
   * top-level frame window while the document lived in a child renderer window
   * (`Chrome_RenderWidgetHostHWND`), so the keystroke was delivered to the frame.
   *
   * This check asserts the wiring at the source level and exercises the *read-only* primitives
   * against the live desktop. It deliberately does not move focus: this gate must not change
   * what the user is doing.
   */
  await check(18, 'keystrokes_are_aimed_at_the_document_window', 'any', async () => {
    const classText = SOURCE.slice(SOURCE.indexOf('const NATIVE_CSHARP_TEMPLATE = `'), SOURCE.indexOf('`;', SOURCE.indexOf('const NATIVE_CSHARP_TEMPLATE = `') + 10));
    for (const member of ['EnsureKeyFocus', 'KeyTargetFor', 'FocusedWindowOfThread', 'ThreadOfWindow', 'GetGUIThreadInfo', 'SetFocus', 'EnumChildWindows', 'CuKeyFocus']) {
      assert.ok(classText.includes(member), `the native helper must carry ${member}`);
    }
    assert.ok(classText.includes('Chrome_RenderWidgetHostHWND'), 'the input target must prefer the browser renderer child');
    assert.ok(/AttachThreadInput\(own, thread, true\)[\s\S]{0,200}SetFocus\(target\)/.test(classText), 'SetFocus must run with the owning thread attached, or the browser thread refuses it');

    for (const builder of ['function realTypeScript(', 'function realKeyScript(']) {
      const region = SOURCE.slice(SOURCE.indexOf(builder), SOURCE.indexOf(builder) + 2600);
      assert.ok(region.includes('...focusEnsureLines()'), `${builder} must aim keyboard focus before it sends anything`);
      assert.ok(region.includes('focusResultFields()'), `${builder} must report the focus it measured`);
    }
    assert.ok(SOURCE.includes('function focusEnsureLines()') && SOURCE.includes('function focusResultFields()'), 'the focus step must be one shared implementation');
    const scrollBuilder = SOURCE.slice(SOURCE.indexOf('function realScrollScript('), SOURCE.indexOf('function realScrollScript(') + 1600);
    assert.ok(scrollBuilder.includes('...focusEnsureLines()'), 'scroll must point input at the document window too, and report the wheel target');
    assert.ok(scrollBuilder.includes('wheel_target'), 'scroll must report which window received the wheel');

    if (!IS_WINDOWS) return 'source contract verified; the focus probe is Windows-only';

    /* Read-only on the live desktop: which window would a keystroke reach, and which window
     * inside the foreground window is the input target? No SetFocus, no keys, no wheel. */
    const prepared = await mod.prepareLane('windows', 20000);
    assert.strictEqual(prepared.ready, true, `the windows lane must be ready (${JSON.stringify((mod.laneDiagnostics() || []).find(item => item.lane === 'windows') || {})})`);
    const probe = await mod.runInLane('windows', [
      '$foreground = [NewmarkCuNative]::GetForegroundWindow()',
      '$target = [NewmarkCuNative]::KeyTargetFor($foreground)',
      '$focused = [NewmarkCuNative]::FocusedWindowOfThread([NewmarkCuNative]::ThreadOfWindow($foreground))',
      '$noWindow = [NewmarkCuNative]::KeyTargetFor([IntPtr]::Zero)',
      'Write-Output (@{ foreground=("0x{0:X}" -f $foreground.ToInt64()); target=("0x{0:X}" -f $target.ToInt64()); target_class=[NewmarkCuNative]::ClassName($target); target_is_window=[NewmarkCuNative]::IsWindow($target); focused=("0x{0:X}" -f $focused.ToInt64()); null_target=("0x{0:X}" -f $noWindow.ToInt64()) } | ConvertTo-Json -Compress)',
    ].join('\r\n'), 20000);
    assert.strictEqual(probe.ok, true, `the focus probe must run: ${probe.output}`);
    const probed = JSON.parse(String(probe.output).trim().split('\n').pop());
    assert.ok(/^0x[0-9a-f]+$/i.test(probed.foreground) && probed.foreground !== '0x0', 'there must be a foreground window to reason about');
    assert.strictEqual(probed.target_is_window, true, 'the input target must be a real window');
    assert.strictEqual(probed.null_target, '0x0', 'a null window must have no input target rather than a fabricated one');
    assert.ok(/^0x[0-9a-f]+$/i.test(probed.focused), 'the focused window of the foreground thread must be readable');
    return `source contract verified; foreground target ${probed.target} (${probed.target_class}), keystroke window ${probed.focused}`;
  });

  /**
   * The virtual-mode advertisement must describe the *conditions* the code enforces.
   *
   * The recorded defect: `mode_report` published `virtual_mode.refuses` as
   * `['observe', 'app_observe', 'sequence']`, which claims virtual mode cannot observe at all.
   * It can: `app_observe` with `app_target`/`window_handle` is supported and does a background
   * capture. A model reading that list would abandon a path that works. The original refuses
   * `observe` of the foreground desktop and `sequence`, and supports `app_list` and a targeted
   * `app_observe` - so the advertisement must say exactly that, and each advertised entry must
   * correspond to a refusal the code really issues.
   */
  await check(19, 'virtual_mode_advertisement_matches_the_enforced_conditions', 'any', async () => {
    const refuses = [
      { entry: 'the foreground desktop observation', site: 'Virtual mode refuses the foreground desktop observation' },
      { entry: 'the foreground scene check', site: 'Virtual mode refuses the foreground scene check' },
      { entry: 'a desktop action with no scoped target', site: 'virtual_mode_requires_app_target' },
      { entry: 'a scene-checked sequence', site: 'Virtual mode refuses a scene-checked sequence' },
    ];
    for (const { entry, site } of refuses) {
      assert.ok(SOURCE.includes(site), `the advertised refusal of ${entry} must correspond to a real refusal site (${site})`);
    }
    const report = JSON.parse(await mod.runComputerUse({ action: 'mode_report' }));
    const advertised = report.virtual_mode;
    assert.ok(advertised && Array.isArray(advertised.refuses) && Array.isArray(advertised.supports), 'mode_report must advertise both what virtual mode refuses and what it supports');
    /* No bare action name may appear as a refused entry again: that is exactly the defect. */
    for (const bare of ['observe', 'app_observe', 'app_list', 'sequence', 'app_click', 'app_type']) {
      assert.ok(!advertised.refuses.includes(bare), `virtual_mode.refuses must name a condition, not the bare action "${bare}"`);
    }
    assert.ok(advertised.refuses.some(entry => /observe of the foreground desktop/.test(entry)), 'the foreground-desktop observation must still be advertised as refused');
    assert.ok(advertised.refuses.some(entry => /app_observe without app_target or window_handle/.test(entry)), 'the untargeted app_observe must be advertised as refused');
    assert.ok(advertised.refuses.some(entry => /sequence/.test(entry)), 'sequence must be advertised as refused');
    assert.ok(advertised.supports.some(entry => /^app_observe with app_target or window_handle/.test(entry)), 'the targeted app_observe - the capability that actually works - must be advertised as supported');
    assert.ok(advertised.supports.some(entry => /^app_list/.test(entry)), 'app_list must be advertised as supported in virtual mode');
    assert.deepStrictEqual(advertised.requires, ['app_target or window_handle'], 'the target requirement must be stated once');
    assert.strictEqual(advertised.never_falls_back_to_real_delivery, true, 'virtual mode must still promise no real fallback');

    if (!IS_WINDOWS) return 'advertisement verified against the refusal sites; the live probes are Windows-only';

    /* And the advertisement must match behaviour: a targeted app_observe is not refused as
     * unsupported, while a bare observe, an untargeted app_observe and a sequence all are. */
    const listed = JSON.parse(await mod.runComputerUse({ action: 'app_list' }));
    assert.strictEqual(listed.ok, true, `app_list must succeed (${listed.error_code || ''})`);
    const lease = JSON.parse(await mod.runComputerUse({ action: 'takeover_start', ownerId: LEASE_OWNER_A, mouseMode: 'virtual' }));
    assert.strictEqual(lease.ok, true, 'a virtual lease must be acquirable');
    try {
      const bare = JSON.parse(await mod.runComputerUse({ action: 'observe', ownerId: LEASE_OWNER_A }));
      assert.strictEqual(bare.ok, false, 'observe must be refused in virtual mode');
      assert.strictEqual(bare.error_code, 'virtual_mode_unsupported_action', `the refusal must be the advertised one, received ${bare.error_code}`);

      const untargeted = JSON.parse(await mod.runComputerUse({ action: 'app_observe', ownerId: LEASE_OWNER_A }));
      assert.strictEqual(untargeted.ok, false, 'an untargeted app_observe must be refused in virtual mode');

      const sequence = JSON.parse(await mod.runComputerUse({ action: 'sequence', ownerId: LEASE_OWNER_A, steps: [{ action: 'wait', durationMs: 1 }] }));
      assert.strictEqual(sequence.ok, false, 'sequence must be refused in virtual mode');

      if (listed.applications.length > 0) {
        const targeted = JSON.parse(await mod.runComputerUse({ action: 'app_observe', ownerId: LEASE_OWNER_A, windowHandle: listed.applications[0].handle, dryRun: true }));
        assert.notStrictEqual(targeted.error_code, 'virtual_mode_unsupported_action', `a targeted app_observe must not be refused as unsupported; received ${JSON.stringify(targeted).slice(0, 300)}`);
      }
    } finally {
      await mod.runComputerUse({ action: 'takeover_stop', ownerId: LEASE_OWNER_A });
    }
    return 'advertisement names conditions: targeted app_observe is not refused as unsupported, bare observe / untargeted app_observe / sequence are';
  });

  /**
   * The whole-desktop capture, as a capability and as a payload.
   *
   * The recorded defect: `screen_capture` with `target: "desktop"` resolved the FOREGROUND
   * WINDOW and captured it, answering `target_scope: "0x23054A"` and
   * `capture_method: "PrintWindow(hwnd,hdc,2)"` - a window capture presented as a screen
   * capture, with nothing in the payload saying so. So this check asserts both halves: that a
   * screen-scoped action exists and resolves no window, and that the action the desktop tool
   * routes a desktop request to is that action and not `observe`.
   */
  await check(20, 'whole_desktop_capture_is_its_own_scope', 'any', () => {
    assert.deepStrictEqual([...mod.INTERNAL_ACTIONS], ['capture_screen'], 'capture_screen must be the internal whole-desktop action, and the only one');
    assert.ok(!mod.ALL_ACTIONS.includes('capture_screen'), 'capture_screen must NOT be on the model-facing action list: it is behind screen_capture, not behind computer_use');
    assert.deepStrictEqual(mod.actionLanes('capture_screen'), ['window_capture'], 'the screen capture must reuse the window_capture lane, not add a lane of its own');
    assert.deepStrictEqual(mod.lanes(), EXPECTED_LANES, 'the screen capture must not have added a lane');

    const source = SOURCE.slice(SOURCE.indexOf('async function captureScreenAction('), SOURCE.indexOf('async function appObserveAction('));
    assert.ok(source.length > 800, 'the screen-capture action region must be present');
    assert.ok(!source.includes('resolveApplication('), 'the whole-desktop capture must resolve no window: resolving one is exactly how a screen request became a window capture');
    assert.ok(source.includes('fullScreenObservation('), 'the screen action must be carried by its own observation');
    assert.ok(SOURCE.includes("    target_scope: capture.target_scope,\n    capture_scope: capture.capture_scope,"), 'the observation must carry the capture scope through to the payload');

    /* The tool layer is what the caller actually reaches. It must dispatch the screen action
     * for `target: "desktop"` and the window action for `target: "application"`. */
    const component = fs.readFileSync(fileURLToPath(new URL('../packages/newmark-core/components/computeruse/component.js', import.meta.url)), 'utf8');
    assert.ok(component.includes("action: application ? 'app_observe' : 'capture_screen',"), "screen_capture with target \"desktop\" must dispatch capture_screen, not observe");
    assert.ok(!component.includes("action: application ? 'app_observe' : 'observe',"), 'the old routing, which answered the desktop request with the foreground window, must be gone');

    /* And the refactor must not have changed what the window path answers. */
    assert.deepStrictEqual([...mod.ACTION_LANES.observe], ['window_capture', 'uia'], 'observe must still route through window_capture and uia');
    return 'capture_screen is internal, reuses window_capture, resolves no window, and is what target "desktop" dispatches';
  });

  await check(21, 'screen_capture_covers_the_virtual_screen_not_a_window', 'win32', async () => {
    const virtualProbe = await mod.runInLane('windows', [
      '$v = [NewmarkCuNative]::VirtualScreenValues()',
      'Write-Output (@{ ok=$true; left=$v[0]; top=$v[1]; width=$v[2]; height=$v[3]; primary_width=[NewmarkCuNative]::GetSystemMetrics(0); primary_height=[NewmarkCuNative]::GetSystemMetrics(1) } | ConvertTo-Json -Compress)',
    ].join('\r\n'), 20000);
    assert.strictEqual(virtualProbe.ok, true, `the virtual-screen probe must run: ${virtualProbe.output}`);
    const virtualLines = String(virtualProbe.output).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const virtual = JSON.parse(virtualLines[virtualLines.length - 1]);
    assert.ok(Number(virtual.width) > 0 && Number(virtual.height) > 0, `the virtual screen must have a positive size, received ${virtual.width}x${virtual.height}`);

    const screenPath = path.join(tempDirectory, 'screen.png');
    const screen = JSON.parse(await mod.runComputerUse({
      action: 'capture_screen',
      imagePath: screenPath,
      captureMaxWidth: 640,
      captureMaxHeight: 400,
      captureTimeoutMs: 30000,
      timeoutMs: 20000,
    }));
    assert.strictEqual(screen.ok, true, `the whole-desktop capture must succeed: ${screen.error_code || ''} ${screen.error || ''}`);
    assert.strictEqual(screen.target_scope, 'screen', 'a screen capture must name its scope "screen", never a window handle');
    assert.strictEqual(screen.capture_scope, 'virtual-screen', 'a screen capture must say it covers the virtual screen');
    assert.strictEqual(screen.capture && screen.capture.capture_method, 'BitBlt(screen-dc,virtual-screen)', 'the screen capture must be a screen-DC BitBlt, not PrintWindow');
    assert.ok(!/^0x[0-9a-f]+$/i.test(String(screen.target_scope)), 'a screen capture must not report a window handle as its scope');
    assert.strictEqual(screen.width, Number(virtual.width), `the capture must be the virtual screen's width (${virtual.width}), received ${screen.width}`);
    assert.strictEqual(screen.height, Number(virtual.height), `the capture must be the virtual screen's height (${virtual.height}), received ${screen.height}`);
    assert.deepStrictEqual(
      { left: screen.screen.left, top: screen.screen.top, width: screen.screen.width, height: screen.screen.height },
      { left: Number(virtual.left), top: Number(virtual.top), width: Number(virtual.width), height: Number(virtual.height) },
      'the reported screen bounds must be the virtual screen bounds, multi-monitor union included',
    );
    /* A black or flat frame must fail, exactly as on the window path. */
    assert.ok(screen.capture.digest.distinct_luma > 1, `a monochrome screen capture must be a hard error (distinct_luma=${screen.capture.digest.distinct_luma})`);
    assert.ok(fs.existsSync(screenPath), 'the screen capture must be written to the requested path');
    assert.ok(fs.statSync(screenPath).size > 0, 'the screen capture file must not be empty');
    assert.deepStrictEqual([...mod.actionLanes('capture_screen')], ['window_capture'], 'the screen capture must have used the existing window_capture lane');

    /* The two scopes really are different pictures: the window capture of the same moment
     * covers a different rectangle, so its dimensions and its digest both differ. A window
     * dressed up as a screen, or a screen dressed up as a window, fails here. */
    const windowPath = path.join(tempDirectory, 'window.png');
    const window = JSON.parse(await mod.runComputerUse({
      action: 'observe',
      windowHandle: process.env.NEWMARK_TEST_WINDOW_HANDLE,
      observation: 'full',
      imagePath: windowPath,
      captureMaxWidth: 640,
      captureMaxHeight: 400,
      captureTimeoutMs: 30000,
      timeoutMs: 20000,
    }));
    assert.strictEqual(window.ok, true, `the window capture must succeed for the comparison: ${window.error_code || ''}`);
    assert.strictEqual(window.capture_scope, 'window', 'the window capture must say it covers a window');
    assert.ok(/^0x[0-9a-f]+$/i.test(String(window.target_scope)), `a window capture must name the window handle it covers, received ${window.target_scope}`);
    assert.strictEqual(window.capture.capture_method, 'PrintWindow(hwnd,hdc,2)', 'the window capture must still be PrintWindow');
    const differsBySize = window.width !== screen.width || window.height !== screen.height;
    const differsByDigest = window.capture.digest.sha256_prefix !== screen.capture.digest.sha256_prefix;
    assert.ok(differsBySize || differsByDigest, `a screen capture and a window capture of the same moment must differ: both reported ${screen.width}x${screen.height} with digest ${screen.capture.digest.sha256_prefix}`);

    /* And the virtual screen must be what the script copies: the region handed to BitBlt is
     * the virtual screen's rectangle, and the copy is measured against it. Requiring the exact
     * assignment, not merely the presence of the call, is what catches a capture that reads the
     * virtual screen and then answers with the primary monitor's rectangle instead. */
    const script = SOURCE.slice(SOURCE.indexOf('function screenCaptureScript('), SOURCE.indexOf('function sparseDigestScript('));
    assert.ok(script.length > 800, 'the screen capture script must be present');
    assert.ok(
      script.includes("$screenLeft = $virtual[0]; $screenTop = $virtual[1]; $screenWidth = $virtual[2]; $screenHeight = $virtual[3]"),
      'the copied rectangle must BE the virtual screen rect: its origin and its size, read from VirtualScreenValues in one assignment',
    );
    assert.ok(script.includes('[NewmarkCuNative]::VirtualScreenValues()'), 'and that rect must come from the virtual screen call, not from the primary monitor metrics');
    assert.ok(script.includes('[NewmarkCuNative]::ScreenCaptureValues()'), 'the screen capture must copy the screen device context');
    assert.ok(
      /if \(\$sourceWidth -ne \$screenWidth -or \$sourceHeight -ne \$screenHeight\)/.test(script),
      'a copy that is not the size of the virtual screen must be refused inside the script too',
    );
    assert.ok(!script.includes('PrintWindow'), 'the screen capture must not use PrintWindow: on the desktop window it returns a black or empty bitmap, which a careless check would accept');
    return `screen ${screen.width}x${screen.height} (virtual ${virtual.left},${virtual.top},${virtual.width},${virtual.height}) digest ${screen.capture.digest.sha256_prefix}; window ${window.width}x${window.height} digest ${window.capture.digest.sha256_prefix}; differs by ${differsBySize ? 'size' : 'digest'}`;
  });

  /**
   * The Windows keys.
   *
   * The recorded defect: `key: "win"` and `key: "win+r"` both answered `ok: true` with
   * `focus_changed: false` - the Start menu never opened and the Run dialog never opened -
   * because only ctrl/alt/shift existed as modifiers and a bare `win` was handed to SendKeys,
   * which cannot express the Windows key at all.
   *
   * Every assertion here is a pure resolution or a source contract. NOTHING in this file
   * DELIVERS a keystroke: the one live delivery of a lone Windows key is measured separately,
   * by hand, because it opens the Start menu on the machine the user is sitting at.
   */
  await check(22, 'windows_key_resolves_and_is_delivered_as_virtual_keys', 'any', () => {
    const noError = (key) => {
      const chord = mod.resolveKeyChord(key);
      assert.ok(!chord.error, `${key} must resolve, received ${chord.error}`);
      return chord;
    };
    for (const [key, code] of [['win', 0x5b], ['windows', 0x5b], ['lwin', 0x5b], ['meta', 0x5b], ['super', 0x5b], ['rwin', 0x5c]]) {
      const chord = noError(key);
      assert.deepStrictEqual(chord.virtualKeys, [code], `${key} must resolve to the single virtual key 0x${code.toString(16)}`);
      assert.strictEqual(chord.windowsKey, true, `${key} must be recognised as a Windows key`);
      assert.strictEqual(chord.lonelyWindowsKey, true, `${key} on its own is the case Windows swallows, so it must be marked`);
    }
    /* The chords the user could not send. Asserted structurally: the right virtual keys, in
     * the right order, with the Windows key held for the whole chord. */
    for (const [key, codes] of [['win+r', [0x5b, 0x52]], ['win+e', [0x5b, 0x45]], ['win+d', [0x5b, 0x44]]]) {
      const chord = noError(key);
      assert.deepStrictEqual(chord.virtualKeys, codes, `${key} must compose 0x${codes.map(code => code.toString(16)).join(' + 0x')}`);
      assert.strictEqual(chord.lonelyWindowsKey, false, `${key} is a chord, so it must not be treated as a lone Windows key`);
      assert.strictEqual(mod.normalizeSendKeysKey(key), undefined, `${key} must NOT be handed to SendKeys, which cannot express a Windows key`);
    }
    const multi = noError('win+shift+s');
    assert.deepStrictEqual(multi.virtualKeys, [0x5b, 0x10, 0x53], 'win+shift+s must compose the Windows key, shift and s in press order');
    assert.deepStrictEqual(noError('ctrl+a').virtualKeys, [0x11, 0x41], 'the non-Windows path must resolve the same codes it always did');
    assert.strictEqual(mod.normalizeSendKeysKey('ctrl+a'), '^a', 'a chord SendKeys CAN express must still go through SendKeys');

    /* The delivery script: every key armed, and the lone Windows key held across a stroke. */
    const built = mod.previewKeyScript('win');
    assert.ok(!built.error, `the lone Windows key must build a delivery script, received ${built.error}`);
    assert.ok(built.script.includes('[NewmarkCuNative]::SendVirtualKeysHeld([uint16[]]@(91), [uint16[]]@(255))'), 'a lone Windows key must be held across a dummy stroke (VK_LWIN 91 held, VK 255 stroked), or Windows swallows it');
    assert.ok(!built.script.includes('::SendVirtualKeys('), 'a lone Windows key must be delivered ONCE, by the held call: delivering it twice would press it twice');
    assert.ok(built.script.includes('key_delivery="virtual-keys-held-across-a-stroke"'), 'the receipt must name the delivery that was actually used');
    assert.ok(built.script.includes('foreground_changed_by_key=$changed'), 'the receipt must report whether the foreground really changed');
    assert.ok(built.script.includes('dummy_key=0xFF'), 'and must name the dummy key it used');

    const chordBuilt = mod.previewKeyScript('win+r');
    assert.ok(!chordBuilt.error, `win+r must build a delivery script, received ${chordBuilt.error}`);
    assert.ok(chordBuilt.script.includes('[NewmarkCuNative]::SendVirtualKeys([uint16[]]@([uint16]91,[uint16]82))'), 'win+r must press VK_LWIN (91) and VK_R (82)');
    /* A chord that silently fell back to SendKeys would TYPE THE LETTERS "win+r" into whatever
     * has focus - the failure mode this whole change exists to remove. Requiring the virtual
     * delivery is what makes the fallback impossible rather than merely unlikely. */
    assert.equal((chordBuilt.script.match(/SendVirtualKeys\(/g) || []).length, 1, 'a Windows chord must have exactly one virtual-key delivery call');
    assert.ok(chordBuilt.script.includes('dummy_key=none'), 'a chord must report that no dummy key was used');
    assert.ok(chordBuilt.script.includes('stroke_events=4'), 'win+r is four key events: two down, two up');
    assert.ok(!chordBuilt.script.includes('[System.Windows.Forms.SendKeys]'), 'no Windows chord may be delivered through SendKeys');

    /* The virtual (posted-message) path must refuse a Windows key rather than report a
     * pointless posted message as a delivered one. */
    const virtual = mod.previewVirtualKeyScript({ handle: String(0x23054a), process_id: 1 }, 'win+r');
    assert.ok(virtual.error, 'virtual app_key must refuse a Windows chord');
    assert.strictEqual(virtual.code, 'windows_key_requires_real_delivery', 'and must say why: posted messages cannot deliver a system-scoped key');
    assert.ok(!virtual.error.includes('undefined'), 'the refusal must name the chord, not print undefined');
    const virtualPlain = mod.previewVirtualKeyScript({ handle: String(0x23054a), process_id: 1 }, 'ctrl+l');
    assert.ok(!virtualPlain.error, `virtual app_key must still accept an ordinary chord: ${virtualPlain.error || ''}`);
    assert.ok(virtualPlain.script.includes('PostWindowMessage'), 'and must still deliver it as posted window messages');
    assert.ok(virtualPlain.script.includes('key_delivery="posted-window-messages"'), 'and must say so in its receipt');

    /* The one table: a key name means one code to every path. */
    assert.strictEqual(mod.keyNameToVirtualCode('win'), 0x5b, 'the shared key table must map win to VK_LWIN');
    assert.strictEqual(mod.keyNameToVirtualCode('enter'), 0x0d, 'and enter to VK_RETURN');
    assert.strictEqual(mod.keyNameToVirtualCode('F5'), 0x74, 'and F5 to its real code');

    /* The helper really is in the compiled C# the lane receives, and the real path uses it. */
    assert.ok(SOURCE.includes('public static int SendVirtualKeys(ushort[] keys)'), 'the native helper must carry the virtual-key chord entry point');
    assert.ok(SOURCE.includes('public static int SendVirtualKeysHeld(ushort[] held, ushort[] stroke)'), 'and the held entry point the lone Windows key needs');
    assert.ok(SOURCE.includes('record.U.ki.wVk = virtualKey;'), 'a virtual-key event must set wVk');
    assert.ok(SOURCE.includes('record.U.ki.wScan = (ushort)(MapVirtualKeyW(virtualKey, 0) & 0xffu);'), 'and must carry the scan code a real keyboard reports');
    /* The advertisement must also be honest about what happened, which is the whole point. */
    assert.ok(SOURCE.includes('windows_key_codes=@(${windowsKeyCodes});'), 'the receipt must name the Windows key codes delivered');
    assert.ok(SOURCE.includes('dummy_key='), 'the receipt must name the dummy key the lone-key delivery used, or say none');
    /* And a lone Windows key must report what was MEASURED, not just that keys were sent: a
     * caller told "delivered" for a key the shell ignored has been told nothing useful. */
    assert.ok(
      built.script.includes('windows_key_effect=$(if ($changed -or $backgroundChanged) { "foreground-or-window-changed" } else { "not-observed" })'),
      'a lone Windows key must report whether anything actually changed, and say "not-observed" when nothing did',
    );
    assert.ok(
      chordBuilt.script.includes('windows_key_effect="not-measured"'),
      'a chord must say its effect was not measured, rather than implying one was observed',
    );
    return 'win/lwin/rwin/meta/super + win+r/win+e/win+d compose the right virtual keys; lone win is held across a dummy; SendKeys is never used for them';
  });

  /**
   * The operating guide, part 1: how to open an application.
   *
   * The defect this closes is the one that cost the most time: `key: "win"` answers
   * `ok: true` with `focus_changed: true` and does nothing at all, so a caller that
   * trusted the return value concluded the Start menu had opened. The description now
   * names the chord that works (`ctrl+esc`), the steps that follow it, and the receipt
   * field that reports the truth. Each of those is asserted against the surface here:
   * `ctrl+esc` is measured to be an ordinary SendKeys chord, and the field the guide
   * names is measured to be the one the lone-Windows-key receipt really writes.
   */
  await check(23, 'guide_opens_an_application_with_ctrl_esc_not_the_windows_key', 'any', async () => {
    const guide = String((await shippedDescriptions()).get('computer_use').description);
    const opening = guide.slice(guide.indexOf('OPENING AN APPLICATION'), guide.indexOf('OPERATING HABITS'));
    assert.ok(opening.length > 200, 'the guide must carry an opening-an-application paragraph of its own');
    assert.ok(opening.includes('`key: "ctrl+esc"` opens the Start menu'), 'the guide must name ctrl+esc as what opens the Start menu');
    assert.ok(opening.includes('`key: "enter"` launches it'), 'and enter as what launches the match');
    assert.ok(/The Windows key does not work/.test(opening), 'and must say the Windows key does not work on this machine');
    assert.ok(/fails silently/.test(opening), 'and that it fails silently rather than erroring');
    assert.ok(opening.includes('`key: "win+r"`'), 'naming the chords that were measured failing, not only the lone key');
    assert.ok(opening.includes('windows_key_effect: "not-observed"'), 'and naming the receipt field that reports the failure, with the value it reports');

    /* The recipe the guide gives, measured: ctrl+esc is an ORDINARY chord. If it ever
     * became a Windows-key delivery, the shell would ignore it exactly as it ignores
     * `win`, and the guide would describe a recipe that does not work. */
    const chord = mod.resolveKeyChord('ctrl+esc');
    assert.ok(!chord.error, `ctrl+esc must resolve, received ${chord.error}`);
    assert.strictEqual(chord.windowsKey, false, 'ctrl+esc must not be a Windows key chord: those are the ones the shell ignores');
    assert.deepStrictEqual(chord.virtualKeys, [0x11, 0x1b], 'ctrl+esc must compose VK_CONTROL and VK_ESCAPE');
    assert.strictEqual(mod.normalizeSendKeysKey('ctrl+esc'), '^{ESC}', 'ctrl+esc must normalise to the ordinary SendKeys chord ^{ESC}');
    const delivered = mod.previewKeyScript('ctrl+esc');
    assert.ok(!delivered.error, `ctrl+esc must build a delivery script, received ${delivered.error}`);
    assert.ok(delivered.script.includes("[System.Windows.Forms.SendKeys]::SendWait('^{ESC}')"), 'and must be delivered through SendKeys like every other ordinary chord');
    assert.ok(!delivered.script.includes('SendVirtualKeys'), 'and must not go near the Windows-key delivery path');

    /* And the field the guide names is the field the receipt writes, on the very delivery
     * the guide warns about: the lone Windows key still answers `ok=$true`, next to an
     * effect field that says nothing was observed. */
    const lone = mod.previewKeyScript('win');
    assert.ok(lone.script.includes('ok=$true;'), 'the lone Windows key receipt must still be an ok:true shape');
    assert.ok(
      lone.script.includes('windows_key_effect=$(if ($changed -or $backgroundChanged) { "foreground-or-window-changed" } else { "not-observed" })'),
      'and must carry the windows_key_effect field the guide names, including the "not-observed" case',
    );
    return 'guide names ctrl+esc / enter / not-observed; ctrl+esc measured as an ordinary SendKeys chord ^{ESC}, and the warning field measured in the lone-win receipt';
  });

  /**
   * The operating guide, part 2: `app_activate` binds, and `ok: true` is not evidence.
   *
   * "Activate" reads like "start", and a caller that reads it that way will try to launch
   * an application with it and get a refusal it does not understand. The description says
   * it never launches, and that is measured three ways here: the module that implements it
   * carries no process-creation call at all, `mode_report` advertises it as bind-only, and
   * a live dispatch with a target that cannot match refuses instead of starting anything.
   */
  await check(24, 'guide_says_app_activate_binds_and_ok_true_is_not_evidence', 'any', async () => {
    const guide = String((await shippedDescriptions()).get('computer_use').description);
    assert.ok(/`app_activate` NEVER launches a process/.test(guide), 'the guide must say app_activate never launches a process, because the word reads like "start"');
    assert.ok(guide.includes('app_target_not_found'), 'and name the refusal a non-matching target produces');
    assert.ok(/`ok: true` does not mean it happened/.test(guide), 'and warn that ok:true is not evidence that the effect happened');
    for (const field of ['focus_changed', 'windows_key_effect', 'capture_scope', 'target_scope']) {
      assert.ok(guide.includes(`\`${field}\``), `the guide must name ${field} as a receipt field to read`);
      /* And it must be a field a receipt really writes: a guide that sends its reader looking
       * for a name the code never produces is the drift this check exists to prevent. */
      assert.ok(SOURCE.includes(`${field}=`) || SOURCE.includes(`${field}:`), `and ${field} must be a field the ComputerUse receipts really carry`);
    }
    assert.ok(/verify from outside/.test(guide), 'and say to verify from outside when the receipt is inconclusive');

    /* (a) The module that implements app_activate cannot start a process at all. */
    for (const primitive of [/Start-Process\s/, /ShellExecute/, /ProcessStartInfo/, /CreateProcess\(/, /Win32_Process/, /new Process\(/]) {
      assert.ok(!primitive.test(SOURCE), `app_activate is implemented in a module with no process-creation call, but ${primitive} is present in win32.js`);
    }
    const activateAction = SOURCE.slice(SOURCE.indexOf('async function appActivateAction('), SOURCE.indexOf('async function appActivateAction(') + 2000);
    assert.ok(activateAction.includes('resolveApplication('), 'app_activate must open by resolving a window that already exists');
    assert.ok(activateAction.includes("resolved.error_code || 'app_target_not_found'"), 'and must fail when there is none, rather than falling back to anything');

    /* (b) The advertisement a caller can read for itself. */
    const report = JSON.parse(await mod.runComputerUse({ action: 'mode_report' }));
    assert.ok(
      report.virtual_mode.supports.some(entry => /app_activate with app_target or window_handle \(binds the target; it never activates anything\)/.test(entry)),
      'mode_report must advertise app_activate as binding a target rather than activating anything',
    );

    /* (c) Live, and safe by construction: the target is a string no window title or class
     * name on this machine can carry, so the dispatch refuses before any activation and
     * starts nothing. That refusal IS the property being measured. */
    if (!IS_WINDOWS) return 'description and source contract verified; the live refusal is Windows-only';
    const missing = JSON.parse(await mod.runComputerUse({ action: 'app_activate', appTarget: `ncu-guide-no-such-window-${process.pid}` }));
    assert.strictEqual(missing.ok, false, `an unmatchable app_target must be refused, received ${JSON.stringify(missing).slice(0, 300)}`);
    assert.strictEqual(missing.error_code, 'app_target_not_found', `and refused as app_target_not_found, received ${missing.error_code}`);
    return 'app_activate: no process-creation call in win32.js, advertised as bind-only, and a live unmatchable target refused as app_target_not_found';
  });

  /**
   * The operating guide, part 3: the habits, each held to the surface it describes.
   *
   * These are the rules a caller gets wrong without being told - the lease that must be
   * released with its owner id, the window capture that is not the screen, the handle that
   * beats a title match, the error that means the Start menu is open, the scroll that needs
   * coordinates - plus the pointer to the full record. Every one of them is measured here
   * against the code or the live surface, so the description cannot drift from either.
   */
  await check(25, 'guide_habits_match_the_measured_surface', 'any', async () => {
    const guide = String((await shippedDescriptions()).get('computer_use').description);

    /* The lease. */
    assert.ok(/`takeover_start` before your first input/.test(guide), 'the guide must say when to take the lease');
    assert.ok(/`takeover_stop` in a `finally`/.test(guide), 'and that the release belongs in a finally, not on the happy path');
    assert.ok(guide.includes('takeover_lease_owned_by_another_owner'), 'and name the refusal a release without the owner id receives');
    assert.strictEqual(mod.LEASE_RELEASE_ACTION, 'takeover_stop', 'the release action the guide names must be the one the module implements');
    assert.strictEqual(SOURCE.split("'takeover_lease_owned_by_another_owner'").length - 1, 1, 'the refusal the guide names must exist as exactly one site');
    assert.ok(SOURCE.includes('lock_owner: existing.owner_id') && SOURCE.includes('requested_owner: ownerId'), 'and must name both owners, which is what makes the exact owner_id necessary');
    assert.ok(/`takeover_start`[^\n]*topmost click-through overlay/.test(guide), 'and say what a leaked lease leaves on the screen');
    const overlay = fs.readFileSync(fileURLToPath(new URL('../packages/newmark-core/components/computeruse/lib/overlay-win32.js', import.meta.url)), 'utf8');
    for (const fact of ['WS_EX_TRANSPARENT', 'WS_EX_TOPMOST', "'owner-process-bound'"]) {
      assert.ok(overlay.includes(fact), `the overlay the guide warns about must really carry ${fact}`);
    }

    /* The two capture scopes. */
    assert.ok(guide.includes('`observe` captures ONE WINDOW'), 'the guide must say what observe captures');
    for (const named of ['capture_scope: "window"', 'capture_scope: "virtual-screen"', 'PrintWindow(hwnd,hdc,2)', 'BitBlt(screen-dc,virtual-screen)']) {
      assert.ok(guide.includes(named), `the guide must name ${named}`);
    }
    assert.strictEqual(mod.INTERNAL_ACTIONS.includes('capture_screen'), true, 'the screen scope the guide names must be a real internal action');
    if (IS_WINDOWS) {
      const imagePath = path.join(tempDirectory, 'guide-window.png');
      const window = JSON.parse(await mod.runComputerUse({
        action: 'observe',
        windowHandle: process.env.NEWMARK_TEST_WINDOW_HANDLE,
        observation: 'full',
        imagePath,
        captureMaxWidth: 480,
        captureMaxHeight: 320,
        captureTimeoutMs: 30000,
        timeoutMs: 20000,
      }));
      assert.strictEqual(window.ok, true, `the window observation the guide describes must succeed: ${window.error_code || ''} ${window.error || ''}`);
      assert.strictEqual(window.capture_scope, 'window', 'observe must be the window scope the guide says it is, never the screen');
      assert.strictEqual(window.capture.capture_method, 'PrintWindow(hwnd,hdc,2)', 'with the capture method the guide names');
      assert.ok(/^0x[0-9a-f]+$/i.test(String(window.target_scope)), `and the window handle as its target_scope, received ${window.target_scope}`);
    }

    /* window_handle before app_target, in the resolver itself. */
    assert.ok(guide.includes('Prefer `window_handle` over `app_target`'), 'the guide must say to prefer the exact handle');
    const resolver = SOURCE.slice(SOURCE.indexOf('async function resolveApplication('), SOURCE.indexOf('async function resolveApplication(') + 3000);
    assert.ok(resolver.includes('handleHex(options.windowHandle || options.window_handle)'), 'the resolver must try an explicit handle first');
    assert.ok(
      resolver.indexOf('app.handle.toLowerCase() ===') < resolver.indexOf('app.title.toLowerCase().includes(wanted)'),
      'and must match the handle before the title, which is the substring match the guide warns about',
    );
    assert.ok(/matches = applications\.filter\(app => app\.class_name\.toLowerCase\(\)\.includes\(wanted\)\)/.test(resolver), 'with the class-name substring last');

    /* foreground_window_unavailable: one site, and the exclusions behind it. */
    assert.ok(guide.includes('foreground_window_unavailable'), 'the guide must name the error a caller will meet');
    assert.ok(/shell windows are not enumerated/.test(guide), 'and say what it means');
    assert.strictEqual(SOURCE.split("error_code: 'foreground_window_unavailable'").length - 1, 1, 'that error must have exactly one site, or the guide cannot say what it means');
    assert.ok(resolver.includes("error_code: 'foreground_window_unavailable'"), 'and that site must be the resolver reporting no foreground window');
    assert.ok(/applications\.find\(app => app\.foreground === true\)/.test(resolver), 'which it decides from the enumeration');
    const enumeration = SOURCE.slice(SOURCE.indexOf('public static CuWindowInfo[] EnumTopLevelWindows('), SOURCE.indexOf('public static CuWindowInfo[] EnumTopLevelWindows(') + 4000);
    for (const excluded of ['Shell_TrayWnd', 'Progman', 'WorkerW']) {
      assert.ok(enumeration.includes(excluded), `the enumeration the guide describes must exclude ${excluded}`);
    }
    assert.ok(/if \(width <= 40 \|\| height <= 40\) return true;/.test(enumeration), 'and windows 40px or smaller, one of the ways a real foreground window goes missing');
    assert.ok(/if \(!visible \|\| occluded\) return true;/.test(enumeration), 'and invisible or occluded windows in the real scope');

    /* scroll: the code the guide names, and the guard that makes it a refusal. */
    assert.ok(guide.includes('`point_required`'), 'the guide must name the refusal a coordinate-less scroll receives');
    const physical = SOURCE.slice(SOURCE.indexOf('async function desktopPhysicalAction('), SOURCE.indexOf('async function appPhysicalAction('));
    /* The guard is shared by move/click/scroll/drag and sits above all of their scripts, so
     * the assertion is positional: it must precede the scroll script, or a scroll with no
     * coordinates would reach the lane with NaN for a point instead of being refused. */
    const guardAt = physical.indexOf("if (!target && !Number.isFinite(Number(options.x))) return failure(action, 'point_required'");
    const scrollAt = physical.indexOf('realScrollScript(');
    assert.ok(guardAt >= 0, 'the real path must refuse a point-less action with point_required');
    assert.ok(scrollAt > guardAt, 'and that refusal must run BEFORE the scroll script is composed, or the refusal is not a refusal');
    assert.ok(/if \(action === 'scroll'\) \{[\s\S]{0,400}scroll_delta_required/.test(physical), 'and the scroll branch must still refuse a scroll with no delta of its own');

    /* type, and the Windows-key refusal in virtual mode. */
    assert.ok(guide.includes('text_delivery: "unicode-key-events"'), 'the guide must name the text delivery mechanism');
    assert.ok(SOURCE.includes('text_delivery="unicode-key-events"'), 'and the receipt must really carry that literal');
    assert.ok(guide.includes('windows_key_requires_real_delivery'), 'the guide must name the virtual-mode Windows-key refusal');
    assert.strictEqual(
      mod.previewVirtualKeyScript({ handle: String(0x23054a), process_id: 1 }, 'win+r').code,
      'windows_key_requires_real_delivery',
      'and that code must be the one the refusal really returns',
    );

    /* And the record the description points at. */
    assert.ok(guide.includes('docs/03-computer-use-playbook.md'), 'the description must point at the full record');
    const docPath = fileURLToPath(new URL('../docs/03-computer-use-playbook.md', import.meta.url));
    assert.ok(fs.existsSync(docPath), `the document the description points at must exist at ${docPath}`);
    const doc = fs.readFileSync(docPath, 'utf8');
    for (const anchor of ['ctrl+esc', 'app_activate', 'windows_key_effect', 'point_required', 'windows_key_requires_real_delivery', 'foreground_window_unavailable', 'takeover_lease_owned_by_another_owner']) {
      assert.ok(doc.includes(anchor), `the document must carry the rule it is the record for: ${anchor}`);
    }
    assert.ok(/## 4\. Boundaries/.test(doc), 'and must state what it does not claim (docs/00-governance.md B-26)');

    if (!IS_WINDOWS) return 'lease, scope, resolver, enumeration, type, virtual-key and document contracts verified; the live scroll/observe probes are Windows-only';
    const scroll = JSON.parse(await mod.runComputerUse({ action: 'scroll', scrollY: 120 }));
    assert.strictEqual(scroll.ok, false, 'a scroll with no coordinates must not be delivered somewhere unexpected');
    assert.strictEqual(scroll.error_code, 'point_required', `and must answer the code the guide names, received ${scroll.error_code}`);
    return `lease + capture scope + resolver + enumeration + type + virtual key + document verified; live scroll refused as ${scroll.error_code}, live observe scoped to the window`;
  });
} finally {
  try {
    if (mod) mod.stopAll();
  } catch { /* ignore */ }
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * summary
 * ------------------------------------------------------------------ */

const passed = outcomes.filter(item => item.status === 'PASS').length;
const failed = outcomes.filter(item => item.status === 'FAIL');
const skipped = outcomes.filter(item => item.status === 'SKIP');

console.log('----------------------------------------------------------------');
console.log(`SUMMARY platform=${process.platform} assertions=${outcomes.length} passed=${passed} failed=${failed.length} skipped=${skipped.length}`);
if (skipped.length) console.log(`SKIP  ${skipped.map(item => `${item.index}.${item.name}`).join(', ')}`);
for (const item of failed) console.log(`FAILED ${item.index}. ${item.name}: ${String(item.message).split('\n').slice(0, 4).join(' | ')}`);
console.log(failed.length === 0 ? 'PASS' : `FAIL ${failed.length} assertion(s)`);
process.exitCode = failed.length === 0 ? 0 : 1;
