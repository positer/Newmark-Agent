// The shortcut whitelist the user asked for, checked against the SAME parser the desktop uses.
//
// The user supplied a picture of a shortcut card and asked for it to be available to Computer
// Use, plus Ctrl+Space for switching input methods. A list that only appears in the tool
// description would be prose; this gate proves each chord resolves, that Ctrl+Space is among
// them, and that the modifier-only pairs the card lists (Ctrl+Shift) are accepted while a
// single modifier is still refused.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CU_SHORTCUTS, shortcutTable, isWhitelisted } from '../packages/newmark-core/components/computeruse/lib/shortcuts.js';
import { resolveKeyChord, normalizeSendKeysKey } from '../packages/newmark-core/components/computeruse/lib/win32.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const component = fs.readFileSync(path.join(here, '../packages/newmark-core/components/computeruse/component.js'), 'utf8');
let checks = 0;
const check = (name, value) => { assert.ok(value, name); console.log(`ok ${++checks} - ${name}`); };

const unresolved = CU_SHORTCUTS.filter((entry) => resolveKeyChord(entry.chord).error);
check('every white-listed chord resolves through the delivery parser', unresolved.length === 0 && CU_SHORTCUTS.length >= 30);

const wanted = ['esc', 'ctrl+c', 'ctrl+x', 'ctrl+v', 'ctrl+a', 'ctrl+z', 'ctrl+s', 'ctrl+shift', 'ctrl+f',
  'win+up', 'win+down', 'alt+f4', 'win+d', 'alt+tab', 'ctrl+alt+del', 'ctrl+shift+esc', 'win+e', 'win+tab',
  'win+r', 'ctrl+plus', 'ctrl+minus', 'win+i', 'ctrl+up', 'ctrl+down', 'ctrl+tab', 'printscreen', 'delete',
  'shift+delete', 'ctrl+n', 'ctrl+w', 'ctrl+space'];
check('the card is covered item by item, plus Ctrl+Space', wanted.every((chord) => isWhitelisted(chord)));

const space = resolveKeyChord('ctrl+space');
check('Ctrl+Space switches input methods and resolves to ctrl+space', !space.error && space.names.join('+') === 'ctrl+space' && CU_SHORTCUTS.some((entry) => entry.chord === 'ctrl+space' && /输入法/.test(entry.note)));

const pair = resolveKeyChord('ctrl+shift');
check('Ctrl+Shift is accepted as a modifier pair (input-method switch)', !pair.error && pair.virtualKeys.length === 2);
check('a single modifier is still refused, so no key is left stuck down', Boolean(resolveKeyChord('ctrl').error));

check('the tool description quotes the same table, not a hand-written copy',
  component.includes('SHORTCUT WHITELIST') && component.includes('shortcutTable()') && shortcutTable().includes('ctrl+space'));
check('the action surface publishes the list as read-only JSON',
  component.includes("'mode_report', 'shortcuts'") && component.includes("if (action === 'shortcuts')") && component.includes('CU_SHORTCUTS.map'));

check('a chord outside the list still resolves, so the list is curated rather than a sandbox',
  !resolveKeyChord('ctrl+p').error && isWhitelisted('ctrl+p') === false);
check('Print Screen and the zoom chords are real keys, not just strings in a table',
  !resolveKeyChord('printscreen').error && !resolveKeyChord('ctrl+plus').error && !resolveKeyChord('ctrl+minus').error);

// Found by delivering the chords for real on 2026-10-27: SendKeys has no SPACE keyword, so
// Ctrl+Space answered "关键字“SPACE”无效" and never reached the input method. The chord must
// translate to a literal space, and the gate now refuses the broken form.
check('Ctrl+Space translates to SendKeys notation SendKeys actually accepts',
  normalizeSendKeysKey('ctrl+space') === '^ ' && !String(normalizeSendKeysKey('ctrl+space')).includes('SPACE'));
check('a bare space stays a literal space', normalizeSendKeysKey('space') === ' ');
check('Ctrl+Shift has no SendKeys form, which is why real delivery refuses it (documented, not hidden)',
  normalizeSendKeysKey('ctrl+shift') === undefined && CU_SHORTCUTS.find((entry) => entry.chord === 'ctrl+shift').note.includes('真实模式暂不支持'));

console.log(`PASS ${checks} Computer Use shortcut whitelist checks`);
