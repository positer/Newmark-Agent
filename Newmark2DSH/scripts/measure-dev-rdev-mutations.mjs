/**
 * Newmark Core — the Dev/rDev mutation gate.
 *
 * The claim this gate defends is a **difference**: `rDev` is `preset-dev` minus exactly the
 * three kernel-modification changes and nothing else. A difference is the one thing two
 * hand-maintained declarations get wrong in silence — add a tool to Dev and forget rDev, or
 * hand rDev a capability back, and both files still read as correct. So each rejected shape
 * is planted here, the release gate is run against it, and the patch is restored
 * **byte-identically**, verified by hash rather than by hope.
 *
 * This gate already earned its place once. Its first version planted "rDev given the
 * composition skills back" and the release gate stayed GREEN: the assertion was a presence
 * regex, and `- id: skill-filesystem` followed by its `name:` line is still present when a
 * `config: customSkillDirs:` is appended below it. The assertion is now whole-row equality,
 * and the third case below is why.
 *
 * What it does NOT do: it never writes to the live profile and never runs the destructive
 * reinstall cycle. It mutates this workspace's `cordis.patch.yml` and restores it.
 *
 * Run: node Newmark2DSH/scripts/measure-dev-rdev-mutations.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const PATCH = path.join(workspace, 'packages', 'newmark-core', 'cordis.patch.yml');
const GATE = path.join(here, 'verify-newmark-core.mjs');

const sha = (text) => createHash('sha256').update(text).digest('hex');

const original = fs.readFileSync(PATCH, 'utf8');
const before = sha(original);

/** One plugin row, as it would be written into a preset's `plugins:` list. */
const row = (id, name) => `          - id: ${id}\n            name: '${name}'\n`;

const mutations = [
  {
    name: 'a plugin added to Dev only — the drift this difference exists to catch',
    apply: (text) => {
      const anchor = "          - id: tool-cordis\n            name: '@deepseek-ai/dsh-tool-cordis'\n";
      if (!text.includes(anchor)) throw new Error('Dev anchor not found');
      return text.replace(anchor, anchor + row('tool-drift', '@deepseek-ai/dsh-tool-drift'));
    },
    expect: ['rDev mounts every row Dev mounts except tool-cordis', 'Dev carries all twenty-one plugins'],
  },
  {
    name: 'rDev given the runtime inspector back',
    apply: (text) => {
      const anchor =
        "          - id: tool-web\n            name: '@deepseek-ai/dsh-tool-web'\n            config:\n              fetch: true\n              searchTimeoutMs: 60000\n          # --- PTC mode: the model sees `run_code` plus a generated SDK ------";
      if (!text.includes(anchor)) throw new Error('rDev tool-web anchor not found');
      return text.replace(
        anchor,
        anchor.replace('          # --- PTC mode', `${row('tool-cordis', '@deepseek-ai/dsh-tool-cordis')}          # --- PTC mode`),
      );
    },
    expect: ['rDev adds no row of its own', 'rDev mounts every row Dev mounts except tool-cordis', 'rDev carries all twenty'],
  },
  {
    name: 'rDev given the composition skills back — the case a presence regex missed',
    apply: (text) => {
      const anchor =
        "          - id: skill-filesystem\n            name: '@deepseek-ai/dsh-skill-filesystem'\n          - id: tool-skill";
      if (!text.includes(anchor)) throw new Error('rDev skill-filesystem anchor not found');
      return text.replace(
        anchor,
        "          - id: skill-filesystem\n            name: '@deepseek-ai/dsh-skill-filesystem'\n            config:\n              customSkillDirs:\n                - !!js process.getBuiltinModule('node:path').join('x')\n          - id: tool-skill",
      );
    },
    expect: ['rDev keeps skill-filesystem as a plain two-line row', 'exactly three rows differ'],
  },
];

let failures = 0;
for (const mutation of mutations) {
  let output = '';
  let applied = false;
  try {
    const mutated = mutation.apply(original);
    applied = mutated !== original;
    fs.writeFileSync(PATCH, mutated, 'utf8');
    try {
      output = execFileSync(process.execPath, [GATE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      output = String(error.stdout ?? '');
    }
  } finally {
    fs.writeFileSync(PATCH, original, 'utf8');
  }
  const restored = sha(fs.readFileSync(PATCH, 'utf8')) === before;
  const red = output.split('\n').filter((line) => line.startsWith('not ok'));
  const expected = Array.isArray(mutation.expect) ? mutation.expect : [mutation.expect];
  const hit = red.some((line) => expected.some((name) => line.includes(name)));
  const ok = applied && restored && hit;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${mutation.name}`);
  console.log(`       applied=${applied} restored=${restored} gate-red=${red.length}`);
  for (const line of red) console.log(`       ${line}`);
}

console.log('');
console.log(
  failures === 0
    ? `SUMMARY passed=${mutations.length} failed=0 total=${mutations.length}\nPASS — every planted shape is caught, and the patch is byte-identical after every run`
    : `SUMMARY passed=${mutations.length - failures} failed=${failures} total=${mutations.length}\nFAILED: a planted shape was not caught, or the patch was not restored`,
);
process.exit(failures === 0 ? 0 : 1);
