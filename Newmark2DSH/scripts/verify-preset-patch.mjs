/**
 * Newmark Core — the preset-declaration gate.
 *
 * What this gate is about, after 0.2.18
 * -------------------------------------
 * This bundle **declares** presets and **selects** one; it does not write the profile patch.
 * A "Dev preset" switch used to sit in the plugin config page and rewrite
 * `agent-preset-registry`'s `config.selectedDefault` in `~/.dsh/profiles/<p>/cordis.patch.yml`.
 * The user removed it, in these words: 去除插件配置中的预设dev preset插件开关行，不用插件配置页
 * 调控默认预设. So the switch, its route branch and its writer are gone, and this gate is
 * what is left — about declarations, not about a switch.
 *
 * Three mechanisms died on that switch, and none of them raised an error. They are recorded
 * here because the *absence* of the write path is now the property under test, and a
 * reintroduced write would look reasonable without them:
 *
 *   1. `configEditor.edit` wrote `disabled` inside the row's *config*, where no plugin Config
 *      has such a field. Accepted, persisted, did nothing.
 *   2. An id-targeted `disabled: true` on the declaring row (`preset-dev`) was written to the
 *      profile patch. It left the bundle layer still selecting `dev`, so the file contradicted
 *      itself. (This is also the origin of the four-space `config.disabled: true` that sat in
 *      the live profile from 2026-10-01 until 0.2.16 removed it — a key one level too deep to
 *      mean anything.)
 *   3. The panel's click was a **silent no-op**: the client row sent `component: 'presetDev'`
 *      while the route compared it against the Loader row id `preset-dev`, so every click
 *      answered `unknown_component`, wrote nothing, and logged nothing — that branch returned
 *      before the logger.
 *
 * What it asserts now
 * -------------------
 *   A. the LIVE profile patch parses under the Loader's own parser, and this gate does not
 *      touch it — its bytes and its mtime are the same at the end as at the start;
 *   B. the profile layer's copy of each declaration this bundle also declares states the
 *      same thing, because an id-targeted patch replaces `config` wholesale and the profile
 *      layer is applied last, so its copy is the one in force;
 *   C. the write path is ABSENT: no profile-patch writer module, no `profileContext`
 *      injection, no preset branch in the route, no preset row in the panel;
 *   D. every plugin row either preset declares names a package the INSTALLED host really
 *      ships — resolvable, not merely written down — because a row whose package is absent
 *      fails the preset's whole mount and the registry reports the preset `broken`;
 *   E. every session this bundle resumes ITSELF mounts the preset that session records. A
 *      resumed Agent takes its entire composition from the `setup` callback it is resumed
 *      with (`dsh-agent-loop/lib/index.js` `setup?.(prepared.agent.ctx, prepared.agent)`),
 *      so a resume whose setup does not mount the preset hands back an Agent running on the
 *      Host composition alone: no `run_code`, no read/write/edit/glob/grep/pwsh, and
 *      `presentation: native`. That is not a mount failure of the preset — the preset is
 *      simply never mounted — so D cannot see it and only E can.
 *
 * Run: node Newmark2DSH/scripts/verify-preset-patch.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  PRESET_ID,
  SELECTOR_ENTRY_ID,
  SELECTOR_ENTRY_NAME,
  SELECTOR_KEY,
  parsePatch,
  parsedRow,
  patchRows,
  yamlOrigin,
} from './lib/preset-patch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const pkgDir = path.join(workspace, 'packages', 'newmark-core');
const BUNDLE_PATCH = path.join(pkgDir, 'cordis.patch.yml');

/** The live profile patch. READ ONLY, and asserted to be read only. */
const LIVE_PROFILE_PATCH = 'C:\\Users\\12252\\.dsh\\profiles\\desktop\\cordis.patch.yml';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
function check(name, condition, detail) {
  const n = passed + failed + skipped + 1;
  if (condition) {
    passed += 1;
    console.log(`ok ${n} - ${name}`);
    return true;
  }
  failed += 1;
  failures.push(name);
  console.log(`not ok ${n} - ${name}`);
  if (detail !== undefined) console.log(`  ${detail}`);
  return false;
}

/** A check this machine cannot make. Counted and printed, never silently green. */
function skip(name, why) {
  const n = passed + failed + skipped + 1;
  skipped += 1;
  console.log(`skip ${n} - ${name}`);
  console.log(`  ${why}`);
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The installed harness. Read only, and only its header: 4.7 MB of JSON, not 182 MB of app. */
const LIVE_HOST_ASAR = 'C:\\Users\\12252\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar';

/**
 * The entries of an Electron asar archive, from its header alone.
 *
 * `DATA_START` is `8 + headerBufLen` — the header string is padded to four bytes, so the
 * unpadded `jsonLen` (the 16-byte-offset reading) puts every entry two bytes out. Getting
 * that wrong once cost a whole extraction audit (see `evidence/20261017-preset-break/parity.md`
 * §0), so the arithmetic is spelled out here and nothing past the header is read.
 */
function asarArchive(archive) {
  const fd = fs.openSync(archive, 'r');
  {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerBufLen = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    if (!Number.isFinite(headerBufLen) || jsonLen <= 0 || jsonLen > headerBufLen || headerBufLen > 64 * 1024 * 1024) {
      throw new Error(`unexpected asar header: headerBufLen=${String(headerBufLen)} jsonLen=${String(jsonLen)}`);
    }
    const body = Buffer.alloc(jsonLen);
    fs.readSync(fd, body, 0, jsonLen, 16);
    const header = JSON.parse(body.toString('utf8').replace(/\0+$/, ''));
    const dataStart = 8 + headerBufLen;
    const files = new Map();
    const walk = (node, prefix) => {
      for (const [name, value] of Object.entries(node.files ?? {})) {
        const full = `${prefix}/${name}`;
        if (value.files) walk(value, full);
        else files.set(full, value);
      }
    };
    walk(header, '');
    return {
      has: (entry) => files.has(entry),
      read: (entry) => {
        const found = files.get(entry);
        if (found === undefined) return null;
        const start = dataStart + Number(found.offset);
        const buffer = Buffer.alloc(found.size);
        fs.readSync(fd, buffer, 0, found.size, start);
        return buffer.toString('utf8');
      },
      size: files.size,
      /* The descriptor stays open while the checks read manifests from it, so the caller
       * closes it. A `finally` here closed it before the first `read` and cost one EBADF. */
      close: () => fs.closeSync(fd),
    };
  }
}

/** A row `name` split the way Node resolves it: the package, and the subpath it exports. */
function rowNameParts(name) {
  const parts = name.split('/');
  const scoped = name.startsWith('@');
  const take = scoped ? 2 : 1;
  return { packageName: parts.slice(0, take).join('/'), subpath: parts.slice(take).join('/') };
}

/** Every child row of a preset's `plugins` list, group rows expanded, pseudo-names dropped. */
function presetRows(rows, found = []) {
  if (!Array.isArray(rows)) return found;
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    if (typeof row.name === 'string' && !row.name.includes(':')) found.push(row);
    if (row.group === true) presetRows(row.config, found);
  }
  return found;
}

/**
 * The stored-session resumes in `source` whose own `setup` never mounts a preset.
 *
 * The window is the call's brace-matched body, not a fixed slice: a fixed slice would either
 * reach a later unrelated `agentPresets.mount` and call a non-mounting setup covered, or
 * cut a long setup short and call a mounting one naked.
 */
function resumesWithoutPreset(source) {
  const offenders = [];
  for (const match of source.matchAll(/\.resume\(\s*\{/g)) {
    const open = source.indexOf('{', match.index + match[0].length - 1);
    if (open < 0) continue;
    let depth = 0;
    let end = -1;
    for (let index = open; index < source.length; index += 1) {
      const character = source[index];
      if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    const body = source.slice(match.index, end < 0 ? Math.min(source.length, match.index + 900) : end);
    if (!body.includes('resumeSessionId')) continue;
    if (/agentPresets/.test(body) && /\.mount\s*\(/.test(body)) continue;
    offenders.push({
      line: source.slice(0, match.index).split('\n').length,
      body: body.replace(/\s+/g, ' ').slice(0, 240),
    });
  }
  return offenders;
}

/* --------------------------------------------------------------- the parser --- */

console.log('# the parser this gate reads the profiles with');
{
  const origin = yamlOrigin(path.dirname(LIVE_PROFILE_PATCH));
  check(
    'the Loader`s own parser resolves, so a patch is read the way the Loader reads it',
    typeof origin === 'string' && origin.length > 0,
    `resolved from ${String(origin)}`,
  );
  const parsed = parsePatch('- id: x\n  name: y\n', path.dirname(LIVE_PROFILE_PATCH));
  check('a plain sequence parses', parsed.ok === true, parsed.ok ? '' : String(parsed.reason));
  const broken = parsePatch('- id: x\n   name: y\n', path.dirname(LIVE_PROFILE_PATCH));
  check(
    'a mis-indented patch is refused with a line and a reason, not thrown',
    broken.ok === false && typeof broken.reason === 'string',
    JSON.stringify(broken),
  );
  /* `!!js` is the reason the custom tag exists: without it a patch the Loader reads fine is
   * an unresolved-tag error here, and a gate that rejects a good file is worse than none. */
  const withExpression = parsePatch('    - id: preset-dev\n      disabled: !!js "!ctx.get(\'x\')"\n', path.dirname(LIVE_PROFILE_PATCH));
  check(
    'a patch carrying `!!js` parses, because the Loader`s own custom tag is declared',
    withExpression.ok === true,
    withExpression.ok ? '' : String(withExpression.reason),
  );
}

/* ------------------------------------------------------------ the live patch --- */

console.log('');
console.log('# the live profile patch is READ, never written');

const liveExists = fs.existsSync(LIVE_PROFILE_PATCH);
const liveText = liveExists ? fs.readFileSync(LIVE_PROFILE_PATCH, 'utf8') : '';
const liveShaBefore = liveExists ? sha256(liveText) : null;
const liveMtimeBefore = liveExists ? fs.statSync(LIVE_PROFILE_PATCH).mtimeMs : null;
const liveParsed = liveExists ? parsePatch(liveText, path.dirname(LIVE_PROFILE_PATCH)) : null;
const liveReadable = liveExists && liveParsed !== null && liveParsed.ok === true;

if (liveExists) {
  check(
    'the live profile patch parses under the Loader`s parser',
    liveReadable,
    liveParsed === null ? 'absent' : liveParsed.ok ? '' : `line ${String(liveParsed.line)}: ${String(liveParsed.reason)}`,
  );
} else {
  /* This gate runs on a machine that has this profile; a checkout or a CI runner may not.
   * Absence is reported as a skip rather than as a pass or a failure, so the checks below
   * that need the file cannot be mistaken for coverage they did not have. */
  skip('the live profile patch parses under the Loader`s parser', `${LIVE_PROFILE_PATCH} is absent on this machine`);
}

/* --------------------------------------------------- the bundle's declarations --- */

console.log('');
console.log('# the bundle declares the presets and the selection');

const bundleText = fs.readFileSync(BUNDLE_PATCH, 'utf8');
const bundleRows = patchRows(bundleText, pkgDir);
check('the bundle patch parses', bundleRows !== null, BUNDLE_PATCH);

/** The bundle's inserted rows, keyed by id. Its patch is an `insert` list, so they are nested. */
const inserted = (() => {
  if (bundleRows === null) return new Map();
  const map = new Map();
  for (const row of bundleRows) {
    if (!Array.isArray(row?.insert)) continue;
    for (const entry of row.insert) if (entry !== null && typeof entry === 'object') map.set(entry.id, entry);
  }
  return map;
})();

check(
  'the bundle declares both preset rows',
  inserted.has('preset-dev') && inserted.has('preset-rdev'),
  [...inserted.keys()].join(', '),
);

const selector = (() => {
  if (bundleRows === null) return undefined;
  for (let index = bundleRows.length - 1; index >= 0; index -= 1) {
    if (bundleRows[index]?.id === SELECTOR_ENTRY_ID) return bundleRows[index];
  }
  return undefined;
})();
check(
  'the bundle declares the entry that selects a preset',
  selector !== undefined && selector.name === SELECTOR_ENTRY_NAME,
  JSON.stringify(selector ?? null),
);
check(
  `the bundle selects its own preset by default (${SELECTOR_KEY}: ${PRESET_ID})`,
  selector?.config?.[SELECTOR_KEY] === PRESET_ID,
  JSON.stringify(selector?.config ?? null),
);

/* --------------------------------------------- the profile copy is what runs --- */

console.log('');
console.log('# the profile layer and the bundle declaration say the same thing');

/* The profile layer's entry is an id-targeted patch, and an id-targeted patch replaces the
 * row's `config` WHOLESALE. So the profile's copy of a declaration is what the composition
 * really runs, and the bundle's copy is documentation the moment the two disagree. That is a
 * silent divergence — the file that reads as the source of truth is not the file in force —
 * which is why both declarations this bundle also states in the profile are compared here.
 *
 * Compared as capability markers rather than as whole entries: the two copies are
 * deliberately not byte-identical (the profile's persona is a folded block where the
 * bundle's is literal), so a byte comparison would report a difference on every run and be
 * switched off within a week. */
{
  /** The rows that carry the kernel-modification capability, keyed by row id. */
  const capability = (entry) => {
    const plugins = entry?.config?.plugins;
    if (!Array.isArray(plugins)) return null;
    const byId = new Map(plugins.filter((row) => row !== null && typeof row === 'object').map((row) => [row.id, row]));
    const manager = byId.get('tool-plugin-manager');
    return {
      inspector: byId.get('tool-cordis')?.name ?? null,
      skills: byId.get('skill-filesystem')?.config?.customSkillDirs ?? null,
      manager: manager === undefined ? null : { name: manager.name, disabled: manager.disabled ?? null },
      declaration: entry.config.disabled ?? null,
    };
  };

  /** The last top-level entry carrying `id` — the one the Loader applies last. */
  const liveEntry = (id) =>
    (liveParsed?.document?.toJS() ?? []).reduce(
      (found, entry) => (entry !== null && typeof entry === 'object' && entry.id === id ? entry : found),
      undefined,
    );

  if (liveReadable) {
    const declared = capability(inserted.get('preset-dev'));
    const live = capability(liveEntry('preset-dev'));
    check(
      'the live profile copy of preset-dev carries the capability rows the bundle declares',
      live !== null && JSON.stringify(live) === JSON.stringify(declared),
      `declared ${JSON.stringify(declared)} vs live ${JSON.stringify(live)}`,
    );
    check(
      'neither copy disables the declaration, so the row is enabled wherever it is composed',
      declared === null || (declared.declaration === null && live?.declaration === null),
      'the no-op `disabled` inside `config` is accepted, persisted and does nothing — an id-targeted `disabled: true` at row level is the one that would bite',
    );
    const liveSelector = liveEntry(SELECTOR_ENTRY_ID);
    /**
     * THE SELECTION IS USER STATE, AND ONLY ITS LEGALITY IS OURS.
     *
     * This check used to require the profile's `selectedDefault` to equal the preset the bundle
     * declares, and it passed while the two happened to agree. It went red at 0.2.18 because the
     * user picked rDev in the preset picker and the profile recorded it — which is exactly what the
     * layer order is FOR: the profile's patch applies after every bundle layer, so a choice made in
     * the app survives, and the bundle's `selectedDefault: dev` is a default rather than a lock (the
     * comment above the bundle's own declaration says so in those words).
     *
     * A gate that pins the coincidence would forbid the behaviour the bundle documents. What is
     * asserted instead is the part that IS ours: a selection the profile states must name a preset
     * that EXISTS — our two, or one the shell ships. A typo, a stale id or an empty string still
     * fails; a deliberate choice does not.
     */
    const LEGAL_PRESETS = ['dev', 'rdev', 'standard', 'ptc', 'minimal', 'cordis'];
    const statedSelection = liveSelector?.config?.[SELECTOR_KEY];
    check(
      'a selection the profile states names a preset that exists — the profile layer is where the user own choice lives, so it may differ from the bundle default',
      liveSelector === undefined || (typeof statedSelection === 'string' && LEGAL_PRESETS.includes(statedSelection)),
      `live states ${JSON.stringify(statedSelection ?? null)}; the bundle default is ${JSON.stringify(PRESET_ID)}${
        statedSelection === PRESET_ID ? '' : ' — differing here is the designed path, not a failure'
      }`,
    );
    check(
      'the live profile copy names the registry package, so it targets the entry it means to',
      liveSelector === undefined || liveSelector.name === SELECTOR_ENTRY_NAME,
      JSON.stringify(liveSelector?.name ?? null),
    );
    check(
      'the live profile patch carries no second copy of the preset this bundle declares alone',
      !/\n- id: preset-rdev\n/.test(liveText) && !/\n {4}- id: preset-rdev\n/.test(liveText),
      'preset-rdev is declared by the bundle only; a profile copy would be a second declaration that can disagree',
    );
  } else {
    skip(
      'the live profile copy of preset-dev carries the capability rows the bundle declares',
      `${LIVE_PROFILE_PATCH} is absent or does not parse, so there is no profile copy to compare`,
    );
    skip(
      'a selection the profile states names a preset that exists — the profile layer is where the user own choice lives, so it may differ from the bundle default',
      `${LIVE_PROFILE_PATCH} is absent or does not parse`,
    );
  }

  /* Reading the same entry twice must give the same answer: a lookup that walks the rows must
   * not depend on which call it is. A reduce that silently took the FIRST match would pass the
   * comparisons above while reading a shadowed declaration. */
  const doc = liveParsed?.document;
  if (doc !== undefined) {
    const first = parsedRow(doc);
    const second = parsedRow(doc);
    check(
      'the entry lookup is stable across calls and reads the LAST matching entry',
      JSON.stringify(first?.selected ?? null) === JSON.stringify(second?.selected ?? null),
      JSON.stringify({ first: first?.selected ?? null, selected: second?.selected ?? null, id: SELECTOR_ENTRY_ID }),
    );
  }
}

/* --------------------------------------------------- the write path is ABSENT --- */

console.log('');
console.log('# the plugin config page does not control the default preset');

const indexSource = fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(pkgDir, 'client.js'), 'utf8');
const patchSource = readSourceCommentsStripped(indexSource);
const clientCode = readSourceCommentsStripped(clientSource);

/** Source with whole-line comments removed, so a historical note cannot satisfy — or break — a check. */
function readSourceCommentsStripped(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

check(
  'the writer module is gone from the shipped package',
  !fs.existsSync(path.join(pkgDir, 'lib', 'preset-row.js')),
  'a writer nobody calls is a writer that can still be called',
);
check(
  'nothing in the shipped package addresses the profile patch',
  !/\bprofileContext\b/.test(patchSource) && !/cordis\.patch\.yml/.test(patchSource),
  'the profile patch was read and written for exactly one purpose, and that purpose is gone',
);
check(
  'the core row no longer injects the service the writer needed',
  !/export const inject = \[[^\]]*'profileContext'[^\]]*\]/.test(patchSource),
  'an unused injection is a dependency that can only stall the row',
);
check(
  'the route has no preset branch, so no POST can rewrite the selection',
  !/PRESET_COMPONENT_KEY/.test(patchSource) && !/setPresetSelected/.test(patchSource),
  'the switch answered on this route; the route must not still answer it',
);
check(
  'the panel has no preset row, so there is nothing to click',
  !/presetDev/.test(clientCode) && !/Dev preset/.test(clientCode),
  'a row with no working route was the shipped defect; a route with no row is the leftover',
);
check(
  'the panel still switches the two composed components',
  /key: 'memoryLab'/.test(clientCode) &&
    /key: 'computerUse'/.test(clientCode) &&
    /key: 'agentApi'/.test(clientCode),
  'the switch that was removed must not have taken the working ones with it',
);

/* ------------------------------------ the rows must RESOLVE, not just be written --- */

console.log('');
console.log('# a preset row must resolve in the host that mounts it, not merely be written down');

/**
 * Why resolvability and not mountability.
 *
 * These checks cannot mount a preset: mounting is an async registration against the live
 * Cordis tree, and the honest way to observe it is the host's own `agentPresets.list()`,
 * which a gate process does not have. What IS observable from here is the precondition the
 * mount fails on first — that each row's package is present in the installed host with the
 * export the row names — plus the PTC runtime the `tool-presentation` row hard-requires.
 * The mount itself is measured from session logs instead, by check E's recorded evidence.
 * Saying this here is the point: a gate that silently stopped one step short of the claim
 * in its own name would be the blindness this suite exists to remove.
 */
const host = (() => {
  if (!fs.existsSync(LIVE_HOST_ASAR)) return null;
  try {
    return asarArchive(LIVE_HOST_ASAR);
  } catch {
    return null;
  }
})();

if (host === null) {
  skip(
    'every plugin row either preset declares names a package the installed host ships',
    `${LIVE_HOST_ASAR} is absent or its header does not read on this machine, so the row packages cannot be looked for`,
  );
  skip(
    'the preset that asks for PTC presentation finds the PTC runtime in the installed host',
    `${LIVE_HOST_ASAR} is absent or its header does not read on this machine`,
  );
} else {
  const presets = [
    { loaderId: 'preset-dev', id: 'dev', row: inserted.get('preset-dev') },
    { loaderId: 'preset-rdev', id: 'rdev', row: inserted.get('preset-rdev') },
  ];
  const unresolved = [];
  const unexported = [];
  const subpathRows = [];
  for (const preset of presets) {
    for (const row of presetRows(preset.row?.config?.plugins)) {
      const { packageName, subpath } = rowNameParts(row.name);
      if (!host.has(`/dsh/node_modules/${packageName}/package.json`)) {
        unresolved.push(`${preset.id}:${row.id} -> ${packageName}`);
        continue;
      }
      if (subpath === '') continue;
      subpathRows.push(`${preset.id}:${row.id} -> ${row.name}`);
      const manifest = host.read(`/dsh/node_modules/${packageName}/package.json`);
      if (manifest === null) {
        unexported.push(`${preset.id}:${row.id} -> ${packageName} has no package.json`);
        continue;
      }
      let exportsMap;
      try {
        exportsMap = JSON.parse(manifest).exports;
      } catch {
        exportsMap = undefined;
      }
      const declared =
        exportsMap !== null &&
        typeof exportsMap === 'object' &&
        (exportsMap[`./${subpath}`] !== undefined || exportsMap[subpath] !== undefined);
      if (!declared) unexported.push(`${preset.id}:${row.id} -> ${row.name} is not an export`);
    }
  }
  check(
    'every plugin row either preset declares names a package the installed host ships',
    unresolved.length === 0,
    `a row whose package is absent fails the whole preset mount and the registry reports the preset broken; unresolved: ${unresolved.join(', ') || 'none'}`,
  );
  check(
    `every subpath row is an export of its package (${subpathRows.length} rows)`,
    unexported.length === 0,
    `unresolved subpaths: ${unexported.join(', ') || 'none'} — checked against each package's own \`exports\` map`,
  );
  /* The `tool-presentation` row is the one row in these presets whose mount can fail for a
   * reason that is not its package: a PTC mode needs a TypeScript PTC runtime, and the
   * plugin's own header says PTC mode against a deployment that composes no runtime "fails
   * at mount, named". The row is present and its package resolves either way, so the runtime
   * is checked separately — that is the precondition, not a wiring detail. */
  const ptcAskers = presets.filter((preset) =>
    presetRows(preset.row?.config?.plugins).some(
      (row) => row.name === '@deepseek-ai/dsh-agent-tool-presentation' && row.config?.mode === 'ptc',
    ),
  );
  check(
    `the preset that asks for PTC presentation finds the PTC runtime in the installed host (${ptcAskers.map((preset) => preset.id).join(', ') || 'none ask'})`,
    ptcAskers.every(() => host.has('/dsh/node_modules/@deepseek-ai/dsh-ptc-runtime-node/package.json')),
    'PTC mode against a deployment that composes no runtime fails at mount, named in the preset activation audit',
  );
  host.close();
}

/* -------------------------------------- a resumed session keeps the preset it records --- */

console.log('');
console.log('# a session this bundle resumes itself runs the preset that session records');

/**
 * The positive control first, so the predicate's discrimination is a measurement rather than
 * a claim: if the scan below reports no offender, that has to mean the shipped code mounts
 * the preset — not that the predicate cannot tell the two shapes apart.
 */
const GOOD_RESUME = "agent = (await agents.resume({ resumeSessionId: sessionId, signal, setup: async (agentCtx, resumed) => { const presets = agentCtx.get('agentPresets'); await presets.mount(agentCtx, presetId); } })).agent;";
const BAD_RESUME = 'agent = (await agents.resume({ resumeSessionId: sessionId, signal, setup: (_ctx, resumed) => { restoreModel(resumed); } })).agent;';
const goodHits = resumesWithoutPreset(GOOD_RESUME);
const badHits = resumesWithoutPreset(BAD_RESUME);
check(
  'the resume-preset predicate accepts a mounting setup and flags a non-mounting one',
  goodHits.length === 0 && badHits.length === 1,
  `positive control: mounting setup -> ${goodHits.length} offender(s), non-mounting setup -> ${badHits.length} offender(s) (expected 0 and 1)`,
);

/** Every runtime source the bundle ships, which is where a resume of a stored session can be. */
const runtimeSources = (() => {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) found.push(full);
    }
  };
  walk(pkgDir);
  return found;
})();

const resumes = [];
for (const source of runtimeSources) {
  for (const offender of resumesWithoutPreset(fs.readFileSync(source, 'utf8'))) {
    resumes.push({ file: path.relative(pkgDir, source), ...offender });
  }
}

check(
  `every stored-session resume in the shipped bundle mounts the preset that session records (${runtimeSources.length} sources scanned)`,
  resumes.length === 0,
  resumes.length === 0
    ? ''
    : `${resumes.map((hit) => `${hit.file}:${String(hit.line)} ${hit.body}`).join(' | ')} — a resumed Agent takes its whole composition from this setup, so this one runs on the Host composition alone: measured as 45 tools, presentation native, no run_code and no read/write/edit/glob/grep/pwsh. The reference implementation is dsh-api-session-controller's composeAgent, whose setup awaits presets.mount(agentCtx, resolvedId); read the measurement in archive/20261017-231450-rdev-mount/RESULT.md`,
);

/* -------------------------------------------------- the live patch is untouched --- */

console.log('');
console.log('# the live profile patch survived this gate');

if (liveExists) {
  const after = fs.readFileSync(LIVE_PROFILE_PATCH, 'utf8');
  check(
    'the live profile patch is byte-identical after this gate ran',
    sha256(after) === liveShaBefore,
    `${LIVE_PROFILE_PATCH}: ${String(liveShaBefore)} -> ${sha256(after)}`,
  );
  check(
    'the live profile patch has the same mtime, so it was not rewritten with identical bytes',
    fs.statSync(LIVE_PROFILE_PATCH).mtimeMs === liveMtimeBefore,
    'a rewrite that changed nothing still changes the file, and that is a write this bundle must not do',
  );
} else {
  skip('the live profile patch is byte-identical after this gate ran', `${LIVE_PROFILE_PATCH} is absent`);
}

console.log('');
console.log(`SUMMARY passed=${passed} failed=${failed} skipped=${skipped} total=${passed + failed + skipped}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
