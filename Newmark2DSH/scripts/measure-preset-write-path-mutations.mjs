/**
 * Newmark Core — the removed-preset-switch mutation gate.
 *
 * The property this gate defends is an ABSENCE, and an absence is the easiest thing in a
 * repository to restore by accident: a branch that "might still be useful", a row left in a
 * list, a module nobody noticed was still shipped. Each rejected shape is planted, the
 * preset gate is run against it, and every file is restored **byte-identically**, verified by
 * hash rather than by hope.
 *
 * It also proves the checks are not vacuous in the other direction: the last case plants a
 * change that is NOT a reintroduction — a comment naming the removed mechanism — and requires
 * the gate to stay GREEN, because a check that fires on prose is a check that gets relaxed.
 *
 * Run: node Newmark2DSH/scripts/measure-preset-write-path-mutations.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const pkgDir = path.join(workspace, 'packages', 'newmark-core');
const GATE = path.join(here, 'verify-preset-patch.mjs');

const sha = (text) => createHash('sha256').update(text).digest('hex');

/** Every file a mutation may touch, with its original text. Restoring is not optional. */
const FILES = {
  index: path.join(pkgDir, 'index.js'),
  client: path.join(pkgDir, 'client.js'),
  writer: path.join(pkgDir, 'lib', 'preset-row.js'),
};
const original = new Map();
for (const [key, file] of Object.entries(FILES)) {
  original.set(key, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
}
const before = new Map([...original].map(([key, text]) => [key, text === null ? null : sha(text)]));

/** Write a mutation, run the gate, then put every file back exactly as it was. */
function run(label, apply, expect) {
  let output = '';
  let applied = false;
  try {
    applied = apply() === true;
    try {
      output = execFileSync(process.execPath, [GATE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      output = String(error.stdout ?? '');
    }
  } finally {
    for (const [key, file] of Object.entries(FILES)) {
      const text = original.get(key);
      if (text === null) {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      } else {
        fs.writeFileSync(file, text, 'utf8');
      }
    }
  }
  const restored = [...original].every(([key, text]) =>
    text === null ? !fs.existsSync(FILES[key]) : sha(fs.readFileSync(FILES[key], 'utf8')) === before.get(key),
  );
  const red = output.split('\n').filter((line) => line.startsWith('not ok'));
  const expected = Array.isArray(expect) ? expect : [expect];
  const caught = red.some((line) => expected.some((name) => line.includes(name)));
  const ok = applied && restored && caught;
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${label}`);
  console.log(`       applied=${applied} restored=${restored} gate-red=${red.length}`);
  for (const line of red) console.log(`       ${line}`);
  return ok;
}

/** Plant `needle` at the start of a marker line in a file. */
function plantAt(fileKey, marker, needle) {
  const text = fs.readFileSync(FILES[fileKey], 'utf8');
  if (!text.includes(marker)) throw new Error(`marker not found in ${fileKey}: ${JSON.stringify(marker)}`);
  fs.writeFileSync(FILES[fileKey], text.replace(marker, `${needle}${marker}`), 'utf8');
  return true;
}

/** Replace one exact fragment in a file. Throws when the fragment is not there. */
function replaceIn(fileKey, from, to) {
  const text = fs.readFileSync(FILES[fileKey], 'utf8');
  if (!text.includes(from)) throw new Error(`fragment not found in ${fileKey}: ${JSON.stringify(from)}`);
  fs.writeFileSync(FILES[fileKey], text.replace(from, to), 'utf8');
  return true;
}

const cases = [];

cases.push(
  run(
    'the panel row comes back, so the switch has something to click',
    () =>
      plantAt(
        'client',
        "            {\n              key: 'agentApi',",
        "            {\n              key: 'presetDev',\n              name: 'Dev preset',\n              role: 'the preset this bundle declares',\n              on: true,\n              note: 'x',\n              switchable: true,\n            },\n",
      ),
    'the panel has no preset row',
  ),
);

cases.push(
  run(
    'the profileContext injection comes back, which is what a writer needs first',
    () => replaceIn('index', "export const inject = ['webServer'];", "export const inject = ['webServer', 'profileContext'];"),
    'the core row no longer injects the service the writer needed',
  ),
);

cases.push(
  run(
    'the writer module is restored, and the package ships a write path again',
    () => {
      fs.writeFileSync(FILES.writer, '/** restored by the mutation gate */\nexport const setPresetSelected = () => {};\n', 'utf8');
      return true;
    },
    'the writer module is gone from the shipped package',
  ),
);

cases.push(
  run(
    'the preset branch is restored into the route',
    () => plantAt('index', '            if (name === MODEL_COMPONENT_KEY) {', '            if (name === PRESET_COMPONENT_KEY) { return; }\n'),
    'the route has no preset branch',
  ),
);

/* The other direction. A comment that names the removed mechanism is not a reintroduction,
 * and the three absence checks above must not fire on prose: this gate's own subject is
 * `client.js`, and `client.js` legitimately keeps a note about the mechanism it lost. If
 * this case ever goes red, the checks above have become text matches on comments and will be
 * relaxed until they mean nothing. */
let proseStayedGreen = false;
{
  let output = '';
  try {
    plantAt('index', 'export const inject = [', '// a note naming PRESET_COMPONENT_KEY and setPresetSelected, moved here on purpose\n');
    try {
      output = execFileSync(process.execPath, [GATE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      output = String(error.stdout ?? '');
    }
  } finally {
    for (const [key, file] of Object.entries(FILES)) {
      const text = original.get(key);
      if (text === null) {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      } else {
        fs.writeFileSync(file, text, 'utf8');
      }
    }
  }
  const restored = [...original].every(([key, text]) =>
    text === null ? !fs.existsSync(FILES[key]) : sha(fs.readFileSync(FILES[key], 'utf8')) === before.get(key),
  );
  const red = output.split('\n').filter((line) => line.startsWith('not ok'));
  proseStayedGreen = restored && red.length === 0;
  console.log(`${proseStayedGreen ? 'ok  ' : 'FAIL'} - prose naming the removed mechanism stays green, so the checks are structural`);
  console.log(`       restored=${restored} gate-red=${red.length}`);
  for (const line of red) console.log(`       ${line}`);
}
cases.push(proseStayedGreen);

const failed = cases.filter((ok) => !ok).length;
console.log('');
console.log(
  failed === 0
    ? `SUMMARY passed=${cases.length} failed=0 total=${cases.length}\nPASS — every rejected shape is caught, prose is not, and every file is byte-identical after every run`
    : `SUMMARY passed=${cases.length - failed} failed=${failed} total=${cases.length}\nFAILED: a planted shape was not caught, or a file was not restored`,
);
process.exit(failed === 0 ? 0 : 1);
