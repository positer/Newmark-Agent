/**
 * Read a Cordis patch the way the Loader reads it — for the GATES only.
 *
 * This module used to be `packages/newmark-core/lib/preset-row.js`, 734 lines of parse +
 * plan + write that backed a "Dev preset" switch in the plugin config page. That switch is
 * gone: which preset a new task starts in is a value in the patch layers, not something a
 * plugin's config page rewrites in the user's profile. With its only runtime consumer gone,
 * the writer went with it and what remains — a parser — moved here, where its only readers
 * are the gates. A `lib/` file with no runtime caller reads as part of the shipped plugin;
 * this is not.
 *
 * What is deliberately NOT here any more: `planPresetWrite`, `setPresetSelected`,
 * `writeAtomicSync`, `readPresetFromProfile` (the write path), and `entryBounds`,
 * `configBlock`, `readSelectedLine`, `patchPathOf` (the line-level editing machinery the
 * writer needed, together with the corruption tests built on it). Deleting them is the
 * point of the change: a writer nobody calls is a writer that can still be called.
 *
 * What remains is the part the gates genuinely need — the Loader's own parser, with the
 * `!!js` tag the Loader declares, so a patch carrying `!!js` expressions is not mistaken for
 * a corrupt file, plus the one entry lookup the comparison reads.
 */
import path from 'node:path';
import { createRequire } from 'node:module';

/** The preset this bundle ships as its default. */
export const PRESET_ID = 'dev';

/** The entry that SELECTS a preset. */
export const SELECTOR_ENTRY_ID = 'agent-preset-registry';

/** The package that entry names. */
export const SELECTOR_ENTRY_NAME = '@deepseek-ai/dsh-agent-preset-registry';

/** The field that decides which preset a new session starts in. */
export const SELECTOR_KEY = 'selectedDefault';

/**
 * Resolve the Loader's own `yaml` parser, from an anchor that names where the process is
 * looking from.
 *
 * The anchor is the profile first when a caller has one, and that is not a guess: resolving
 * from `<profile>/` finds `@deepseek-ai/dsh-app-boot` and `yaml` in the **running harness**.
 * Every other candidate is a fallback for the checkout, where the profile does not exist:
 *
 *   1. the caller's anchor directory,
 *   2. this module's own location,
 *   3. the standard DSH Desktop installation directories, which are what is left when the
 *      profile has no dependency tree at all.
 *
 * `null` means no candidate answered, and the caller reports that rather than working
 * around it: an unparsed patch compared against another one is not a comparison.
 */
function resolveYaml(anchor) {
  const tried = [];

  const candidates = [];
  if (process.env.DSH_APP_ROOT) candidates.push(path.join(process.env.DSH_APP_ROOT, 'package.json'));
  if (typeof anchor === 'string' && anchor.length > 0) {
    candidates.push(anchor.endsWith(path.sep) ? anchor : anchor + path.sep);
  }
  candidates.push(import.meta.url);
  for (const root of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env.DSH_HOME]) {
    if (typeof root === 'string' && root.length > 0) {
      candidates.push(path.join(root, 'Programs', 'DSH Desktop', 'resources', 'app') + path.sep);
      candidates.push(path.join(root, 'resources', 'app') + path.sep);
    }
  }

  for (const candidate of candidates) {
    try {
      // The shell's own package is asked for first, because it is what proves the candidate
      // is a harness installation rather than any directory that happens to sit near a
      // package called `yaml`.
      createRequire(candidate).resolve('@deepseek-ai/dsh-app-boot/package.json');
    } catch {
      tried.push(`${candidate} (no harness)`);
      continue;
    }
    for (const specifier of ['yaml', '@deepseek-ai/dsh-app-boot']) {
      try {
        const resolved = createRequire(candidate).resolve(specifier);
        const entry = createRequire(candidate)(specifier);
        if (specifier === 'yaml') return { parser: entry, from: resolved };
        // `dsh-app-boot` re-exports the same parser the Loader uses; asking it is a second
        // chance, not a different implementation.
        if (entry && typeof entry.parseDocument === 'function') {
          return { parser: entry, from: resolved };
        }
      } catch {
        tried.push(`${candidate} -> ${specifier}`);
      }
    }
  }

  // A package source directory is outside the installed host dependency tree.
  // Reuse a parser already resolved from a verified dsh-app-boot anchor in this process.
  const verified = [...yamlCache.values()].find(value => value.parser);
  if (verified) return { parser: verified.parser, from: verified.from, tried };
  return { parser: null, from: null, tried };
}

/** The custom tag the Loader declares, so `!!js` resolves rather than fails. */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value) => value };

/** Resolution is per anchor, and an anchor does not change within a process. */
const yamlCache = new Map();

/**
 * DSH's own YAML parser, and the custom tag declared exactly as the Loader declares it.
 *
 * `!!js` is the reason this exists at all: without that tag declaration every `!!js` scalar
 * is an unresolved-tag error, and a perfectly good patch looks corrupt — which is how a
 * validation step ends up rejecting a file the Loader would have read.
 */
export function dshYaml(anchor) {
  const key = typeof anchor === 'string' ? anchor : '';
  if (!yamlCache.has(key)) yamlCache.set(key, resolveYaml(anchor));
  return yamlCache.get(key).parser;
}

/** Where the parser was loaded from, for diagnostics. `null` when it was not found. */
export function yamlOrigin(anchor) {
  const key = typeof anchor === 'string' ? anchor : '';
  if (!yamlCache.has(key)) yamlCache.set(key, resolveYaml(anchor));
  return yamlCache.get(key).from;
}

/**
 * Parse patch text the way the Loader does.
 *
 * Returns either `{ ok: true, document }` or `{ ok: false, line, reason }`, so a caller can
 * report which line and why rather than throwing a message that names neither.
 */
export function parsePatch(text, anchor) {
  const YAML = dshYaml(anchor);
  if (!YAML) {
    return {
      ok: false,
      line: null,
      reason:
        'the `yaml` parser the Loader uses could not be found, so the patch cannot be read and is ' +
        'reported rather than guessed at',
    };
  }
  const lineCounter = new YAML.LineCounter();
  const document = YAML.parseDocument(text, { customTags: [JS_TAG], lineCounter });
  const error = document.errors[0];
  if (error !== undefined) {
    const at = error.linePos?.[0];
    return { ok: false, line: at === undefined ? null : at.line, reason: String(error.message || error) };
  }
  if (document.contents === null || document.contents === undefined) {
    return { ok: false, line: null, reason: 'the patch is empty' };
  }
  if (document.contents.items === undefined) {
    return { ok: false, line: null, reason: 'the patch must be a YAML sequence of entries' };
  }
  return { ok: true, document };
}

/** Plain data for a parsed patch, or `null` when it does not parse at all. */
export function patchRows(text, anchor) {
  const parsed = parsePatch(text, anchor);
  if (!parsed.ok) return null;
  const rows = parsed.document.toJS();
  return Array.isArray(rows) ? rows : null;
}

/**
 * The LAST entry carrying `id`, which is the one the Loader applies last, with the value of
 * the field the registry reads.
 *
 * `last` and not `first`: an id-targeted patch replaces the matched row, so when the same id
 * appears twice the later entry is the one in force. Reading the first would compare the
 * wrong declaration and call the result a match.
 */
export function parsedRow(document, id = SELECTOR_ENTRY_ID) {
  const items = document?.contents?.items;
  if (!Array.isArray(items)) return null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (document.getIn([index, 'id']) === id) {
      return { index, node: items[index], selected: document.getIn([index, 'config', SELECTOR_KEY]) };
    }
  }
  return null;
}
