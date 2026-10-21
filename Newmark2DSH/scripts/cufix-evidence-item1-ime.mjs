#!/usr/bin/env node
/**
 * cufix item 1 evidence: `type` delivers literal characters through an active Chinese IME.
 *
 * The recorded defect: typing the ASCII string `newmark2dsh-publish` on a machine with a
 * Chinese IME active put a composed string in the field, because the IME read "new" as a
 * pinyin syllable. This run measures, in order:
 *
 *   1. which input language / IME actually owns the target window's thread at type time
 *   2. the exact literal round trip for ASCII, for CJK, and for a string containing an
 *      astral character (a surrogate pair), read back out of the page itself
 *   3. what the retired keystroke path does under those same conditions, for comparison
 *
 * The page reports its own state through `document.title`, which the Win32 side can read
 * with GetWindowText - so every value below was read out of the page, not assumed.
 *
 * Usage: node Newmark2DSH/scripts/cufix-evidence-item1-ime.mjs <evidenceDir> [edgeExe]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const evidenceDir = path.resolve(process.argv[2] || '.');
const edgeExe = process.argv[3] || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const pagePath = path.join(evidenceDir, 'cufix-probe-page.html');
/* The workspace path contains a space ("Newmark Agent"), so the URL must be encoded: a raw
 * space makes the argument ambiguous and the browser loads a truncated path instead. */
const pageUrl = pathToFileURL(pagePath).href;
const READER = new URL('../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href;

const mod = await import(READER);
const { runComputerUse, runInLane, prepareLane, stopAll } = mod;

const ASCII_TEXT = 'newmark2dsh-publish';
const CJK_TEXT = '中文输入法测试';
const ASTRAL_TEXT = 'a\u{1F600}b'; // 4 UTF-16 units: a, surrogate pair, b

const evidence = {
  item: 1,
  claim: 'type delivers the literal characters even while a Chinese IME is the active input language',
  ascii_text: ASCII_TEXT,
  cjk_text: CJK_TEXT,
  astral_text: ASTRAL_TEXT,
  astral_utf16_units: ASTRAL_TEXT.length,
  started_at: new Date().toISOString(),
};
const call = async (options) => JSON.parse(await runComputerUse(options));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** The live IME fact for the target window's thread, read from Win32, not assumed. */
async function inputLanguageFor(handle) {
  await prepareLane('windows', 20000);
  const lines = [
    'if (-not ("CufixIme" -as [type])) {',
    '  Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public static class CufixIme {',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint threadId);',
    '  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern int GetLocaleInfoW(int locale, int type, StringBuilder data, int size);',
    '  public static string LayoutName(uint threadId) {',
    '    IntPtr layout = GetKeyboardLayout(threadId);',
    '    int lang = (int)(layout.ToInt64() & 0xFFFF);',
    '    StringBuilder name = new StringBuilder(128);',
    '    GetLocaleInfoW(lang, 0x00000002, name, 128); /* LOCALE_SLANGUAGE */',
    '    return name.ToString();',
    '  }',
    '}',
    '\'@',
    '}',
    `$hwnd = [IntPtr]::new([Convert]::ToInt64('${String(handle).replace(/^0x/i, '')}', 16))`,
    '$thread = [CufixIme]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)',
    '$layout = [CufixIme]::GetKeyboardLayout($thread)',
    'Write-Output (@{ thread_id=$thread; hkl=("0x{0:X8}" -f $layout.ToInt64()); lang_id=("0x{0:X4}" -f ($layout.ToInt64() -band 0xFFFF)); language=[CufixIme]::LayoutName($thread); current_thread_layout=("0x{0:X8}" -f [CufixIme]::GetKeyboardLayout(0).ToInt64()) } | ConvertTo-Json -Compress)',
  ];
  const result = await runInLane('windows', lines.join('\r\n'), 30000);
  if (!result || result.ok !== true) return { error: String(result && result.output).slice(0, 300) };
  const output = String(result.output).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = output.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(output[index]); } catch { /* keep looking */ }
  }
  return { error: `unreadable: ${String(result.output).slice(0, 300)}` };
}

/** The page's own state, parsed out of the window title it maintains. */
function parseProbeTitle(title) {
  const zoom = /z=([\d.]+)/.exec(title);
  const focus = / f=([^ ]*)/.exec(title);
  const keys = / k=(.*)$/.exec(title);
  const value = / v=("(?:[^"\\]|\\.)*")/.exec(title);
  let parsedValue = null;
  if (value) { try { parsedValue = JSON.parse(value[1]); } catch { parsedValue = null; } }
  return {
    raw_title: title,
    zoom: zoom ? Number(zoom[1]) : null,
    focus: focus ? focus[1] : null,
    keys: keys ? keys[1] : null,
    value: parsedValue,
  };
}

async function readProbe(handle) {
  const listed = await call({ action: 'app_list', includeOccluded: true });
  if (listed.ok !== true) return { error_code: listed.error_code || null, error: listed.error || null };
  const app = (listed.applications || []).find(candidate => String(candidate.handle).toLowerCase() === String(handle).toLowerCase());
  if (!app) return { error: 'the probe window is no longer listed' };
  return parseProbeTitle(String(app.title));
}

function check(name, value, detail) {
  evidence.checks = evidence.checks || {};
  evidence.checks[name] = value === true;
  if (value !== true) evidence.check_details = { ...(evidence.check_details || {}), [name]: detail === undefined ? null : detail };
  console.log(`[item1] ${value === true ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` -- ${JSON.stringify(detail)}`}`);
}

let edge = null;
let failure = null;
let probeHandle = '';

try {
  /* A profile directory per run: a reused one carries a stale Chromium singleton lock after a
   * forced kill, and the launch then silently never produces a window. It is removed below. */
  const profileDir = path.join(os.tmpdir(), `cufix-edge-item1-${process.pid}-${Date.now()}`);
  evidence.edge_profile_dir = profileDir;
  edge = spawn(edgeExe, [
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--no-service-autorun', '--disable-sync',
    '--new-window', pageUrl,
  ], { detached: true, stdio: 'ignore' });
  edge.unref();

  let probe = null;
  const from = Date.now();
  while (Date.now() - from < 90000) {
    const listed = await call({ action: 'app_list', includeOccluded: true });
    if (listed.ok === true) {
      probe = (listed.applications || []).find(app => /cufix/i.test(app.title) && /edge/i.test(app.class_name || ''))
        || (listed.applications || []).find(app => /cufix/i.test(app.title));
      if (probe) break;
    }
    await sleep(700);
  }
  evidence.probe_window = probe;
  if (!probe) throw new Error('the Edge probe window never appeared in app_list');
  probeHandle = probe.handle;
  console.log(`[item1] probe window ${probe.handle}`);

  /* --- activate and focus the field --- */
  const activated = await call({ action: 'app_activate', windowHandle: probe.handle });
  evidence.activation = { ok: activated.ok, foreground_verified: activated.foreground_verified, foreground_handle: activated.foreground_handle, technique: activated.activation_technique };
  let state = await readProbe(probe.handle);
  evidence.before_focus = state;
  console.log(`[item1] after activate: focus=${state.focus} value=${JSON.stringify(state.value)}`);

  if (state.focus !== 'field') {
    const tabbed = await call({ action: 'app_key', windowHandle: probe.handle, key: 'tab' });
    evidence.tab_key = { ok: tabbed.ok, error_code: tabbed.error_code || null, send_keys: tabbed.send_keys || null };
    await sleep(400);
    state = await readProbe(probe.handle);
  }
  evidence.after_focus = state;
  check('the probe page reports its input field as focused', state.focus === 'field', { focus: state.focus });

  /* --- the IME that is actually active for this window's thread --- */
  evidence.input_language = await inputLanguageFor(probe.handle);
  console.log(`[item1] input language: ${JSON.stringify(evidence.input_language)}`);
  const langId = parseInt(String(evidence.input_language.lang_id || '').replace(/^0x/i, ''), 16);
  check('a Chinese input language is active for the target window thread',
    langId === 0x0804,
    { lang_id: evidence.input_language.lang_id, parsed: langId });

  /* --- 1. the reported defect: ASCII through the IME --- */
  const typedAscii = await call({ action: 'type', windowHandle: probe.handle, text: ASCII_TEXT });
  await sleep(500);
  const asciiState = await readProbe(probe.handle);
  evidence.ascii = {
    response: { ok: typedAscii.ok, delivery: typedAscii.delivery || null, text_delivery: typedAscii.text_delivery || null, chars: typedAscii.chars || null, utf16_units: typedAscii.utf16_units || null, events: typedAscii.events || null, composed_by_ime: typedAscii.composed_by_ime === undefined ? null : typedAscii.composed_by_ime, clipboard_used: typedAscii.clipboard_used === undefined ? null : typedAscii.clipboard_used, error_code: typedAscii.error_code || null },
    field_value: asciiState.value,
    field_title: asciiState.raw_title,
  };
  console.log(`[item1] typed ASCII -> field=${JSON.stringify(asciiState.value)}`);
  check('the ASCII string arrives literally with a Chinese IME active',
    asciiState.value === ASCII_TEXT,
    { expected: ASCII_TEXT, received: asciiState.value });
  check('the type response reports unicode key events rather than keystrokes',
    typedAscii.ok === true && typedAscii.text_delivery === 'unicode-key-events' && typedAscii.composed_by_ime === false && typedAscii.clipboard_used === false,
    { text_delivery: typedAscii.text_delivery, composed: typedAscii.composed_by_ime, clipboard: typedAscii.clipboard_used });

  /* --- 2. CJK appended literally --- */
  await call({ action: 'type', windowHandle: probe.handle, text: CJK_TEXT });
  await sleep(500);
  const cjkState = await readProbe(probe.handle);
  evidence.cjk = { appended: CJK_TEXT, field_value: cjkState.value };
  console.log(`[item1] typed CJK -> field=${JSON.stringify(cjkState.value)}`);
  check('CJK characters arrive literally',
    cjkState.value === `${ASCII_TEXT}${CJK_TEXT}`,
    { expected: `${ASCII_TEXT}${CJK_TEXT}`, received: cjkState.value });

  /* --- 3. an astral character (surrogate pair) --- */
  const astralStart = cjkState.value;
  await call({ action: 'type', windowHandle: probe.handle, text: ASTRAL_TEXT });
  await sleep(500);
  const astralState = await readProbe(probe.handle);
  evidence.astral = {
    appended: ASTRAL_TEXT,
    appended_utf16_units: ASTRAL_TEXT.length,
    codepoints: [...ASTRAL_TEXT].map(character => `U+${character.codePointAt(0).toString(16).toUpperCase()}`),
    field_value: astralState.value,
    field_value_utf16_units: typeof astralState.value === 'string' ? astralState.value.length : null,
  };
  console.log(`[item1] typed astral -> field=${JSON.stringify(astralState.value)}`);
  check('a surrogate pair arrives as one astral character, not two broken halves',
    astralState.value === `${astralStart}${ASTRAL_TEXT}`,
    { expected: `${astralStart}${ASTRAL_TEXT}`, received: astralState.value });
  check('the literal round trip is byte-for-byte over the whole session',
    astralState.value === `${ASCII_TEXT}${CJK_TEXT}${ASTRAL_TEXT}`,
    { expected: `${ASCII_TEXT}${CJK_TEXT}${ASTRAL_TEXT}`, received: astralState.value });

  /* --- 4. the retired keystroke path, under the same conditions --- */
  await prepareLane('action', 20000);
  const clearAndTypeOldWay = [
    '$ErrorActionPreference = "Stop"',
    '[System.Windows.Forms.SendKeys]::SendWait("^a")',
    'Start-Sleep -Milliseconds 120',
    '[System.Windows.Forms.SendKeys]::SendWait("{DEL}")',
    'Start-Sleep -Milliseconds 120',
    `[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(ASCII_TEXT)})`,
    'Write-Output "sent"',
  ].join('\r\n');
  const oldWay = await runInLane('action', clearAndTypeOldWay, 20000);
  await sleep(700);
  const oldState = await readProbe(probe.handle);
  evidence.retired_keystroke_path = {
    mechanism: 'System.Windows.Forms.SendKeys::SendWait, the delivery `type` used before this fix',
    lane_ok: oldWay.ok === true,
    lane_output: String(oldWay.output || '').slice(0, 200),
    field_value: oldState.value,
    matches_literally: oldState.value === ASCII_TEXT,
    /* Recorded, not asserted: whether the IME composes in this exact run depends on its
     * conversion mode, which is the user's own input-method state. The recorded defect was
     * reproduced here (a pinyin syllable replaced the first three letters), and the point of
     * the fix is that the new path cannot be composed at all. */
    corrupted_by_the_ime: oldState.value !== ASCII_TEXT,
  };
  console.log(`[item1] retired SendKeys path -> field=${JSON.stringify(oldState.value)} literal=${oldState.value === ASCII_TEXT}`);

  evidence.finished_at = new Date().toISOString();
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
} finally {
  /* Never leave a browser window behind: this run's profile directory identifies its own
   * processes, so the cleanup cannot touch any other browser the user has open. */
  try {
    execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(profileDir)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore', timeout: 30000 });
    evidence.edge_closed = true;
  } catch (closeError) {
    evidence.edge_closed = false;
    evidence.edge_close_error = closeError instanceof Error ? closeError.message : String(closeError);
  }
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* disposable */ }
}

evidence.outcome = failure ? 'ERROR' : Object.values(evidence.checks || {}).every(Boolean) ? 'PASS' : 'FAIL';
if (failure) evidence.error = failure;
evidence.failed_checks = Object.entries(evidence.checks || {}).filter(([, value]) => value !== true).map(([name]) => name);

fs.mkdirSync(evidenceDir, { recursive: true });
const outPath = path.join(evidenceDir, 'cufix-item1-ime-literal-text.json');
fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`[item1] outcome=${evidence.outcome} failed_checks=${evidence.failed_checks.join(',') || 'none'}`);
console.log(`[item1] wrote ${outPath}`);

stopAll();
process.exit(evidence.outcome === 'PASS' ? 0 : 1);
