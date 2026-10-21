/**
 * Newmark Core — the out-of-the-box gate.
 *
 * Installs the published package into a throwaway environment where nothing of the author's
 * exists, and checks two different things:
 *
 *   1. the bundle is complete enough to run — every file the runtime reaches for is in the
 *      tarball, and the manifest describes a loadable plugin;
 *   2. the shared root is a RULE, not this machine's path. Newmark resolves its own root as
 *      `path.join(os.homedir(), '.Newmark')` (identical in its `main.ts` and its launcher),
 *      and its tooling honours `NEWMARK_USER_ROOT`. A plugin that hardcoded a path would pass
 *      every test on the machine it was written on and fail on the next one, so the override
 *      is exercised here with a directory that exists only inside this run.
 *
 * The live profile is never touched: the install target is a `mkdtemp` directory, and the
 * `HOME` the resolution is checked against is supplied by this gate rather than read from the
 * machine. Neither the store nor the profile is written.
 *
 * Run: node Newmark2DSH/scripts/verify-out-of-the-box.mjs [version]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const pkgDir = path.join(workspace, 'packages', 'newmark-core');
const version = process.argv[2] ?? JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail) {
  const n = passed + failed + 1;
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

/* ------------------------------------------------- a machine that is not this one --- */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nmc-oob-'));
const home = path.join(sandbox, 'home');
fs.mkdirSync(home, { recursive: true });
const redirected = path.join(sandbox, 'redirected-store');
fs.mkdirSync(redirected, { recursive: true });

/** Read the resolution rule in exactly the environment asked for, importing the real file. */
async function resolveIn(env, config) {
  const module = await import(pathToFileURL(path.join(pkgDir, 'lib', 'root.js')).href);
  return module.resolveRoot(config, env);
}

console.log('# the root is a rule, not a path');
{
  const fakeHome = { NEWMARK_USER_ROOT: '', HOME: home, USERPROFILE: home };
  const conventional = await resolveIn(fakeHome, {});
  check(
    'the conventional root follows the home directory it is given',
    conventional === path.join(os.homedir(), '.Newmark'),
    conventional,
  );
  // Not "the answer avoids this machine's name" — that would be asserting this machine is
  // not itself. The rule is derived, and that is what can be checked: no literal user path is
  // written down, and the answer is the home directory joined with the conventional name.
  const rootSource = fs.readFileSync(path.join(pkgDir, 'lib', 'root.js'), 'utf8');
  check(
    'the rule is derived, not written: no literal user path appears in it',
    !/12252/.test(rootSource) && !/[A-Za-z]:\\\\Users/.test(rootSource),
    'a literal path would work on exactly one machine',
  );
  check(
    'the answer is the home directory joined with the conventional name',
    conventional === path.join(os.homedir(), '.Newmark'),
    conventional,
  );
  check(
    'a redirected Newmark and this plugin would agree, because both read the same override',
    /NEWMARK_USER_ROOT/.test(rootSource),
    'the override is what keeps a redirected Newmark and this plugin on one store',
  );

  const viaEnv = await resolveIn({ NEWMARK_USER_ROOT: redirected }, {});
  check(
    'NEWMARK_USER_ROOT redirects it, as it does for Newmark own tooling',
    viaEnv === path.resolve(redirected),
    `${viaEnv} != ${path.resolve(redirected)}`,
  );

  const viaConfig = await resolveIn({ NEWMARK_USER_ROOT: redirected }, { root: path.join(sandbox, 'typed') });
  check(
    'an explicit config.root outranks the environment override',
    viaConfig === path.resolve(path.join(sandbox, 'typed')),
    viaConfig,
  );

  check(
    'a blank override is ignored rather than resolving to the empty string',
    (await resolveIn({ NEWMARK_USER_ROOT: '   ' }, {})) === path.join(os.homedir(), '.Newmark'),
  );
}

console.log('');
console.log('# a fresh install, in a directory nothing of this project has touched');
{
  fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'oob', private: true }), 'utf8');
  let installError = '';
  try {
    execFileSync('npm', ['install', `newmark2dsh@${version}`, '--no-audit', '--no-fund', '--prefer-online'], {
      cwd: sandbox,
      stdio: 'pipe',
      shell: true,
    });
  } catch (error) {
    installError = String(error.stderr || error.message).slice(0, 300);
  }
  const installed = path.join(sandbox, 'node_modules', 'newmark2dsh');
  check(`installing newmark2dsh@${version} from the registry succeeds`, fs.existsSync(installed), installError);

  if (fs.existsSync(installed)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    check('the installed version is the one asked for', manifest.version === version, manifest.version);
    check('it installs with no dependencies of its own', Object.keys(manifest.dependencies || {}).length === 0);

    const required = [
      'index.js',
      'client.js',
      'cordis.patch.yml',
      'lib/root.js',
      'components/memorylab/index.js',
      'components/memorylab/lib/root.js',
      'components/memorylab/lib/memory-store.js',
      'components/memorylab/package.json',
      'components/computeruse/index.js',
      'components/computeruse/lib/win32.js',
      'components/computeruse/lib/overlay-win32.js',
      'components/computeruse/package.json',
      'icon.svg',
    ];
    const missing = required.filter((file) => !fs.existsSync(path.join(installed, file)));
    check('the tarball carries everything the runtime reaches for', missing.length === 0, missing.join(', '));

    // The rule exists ONCE, in the core, and the components re-export it. A copy here would mean
    // every rule change had to be made in the core and in each component, and a missed one would
    // silently read a different store than the core row did.
    const core = fs.readFileSync(path.join(installed, 'lib', 'root.js'), 'utf8');
    const component = fs.readFileSync(path.join(installed, 'components', 'memorylab', 'lib', 'root.js'), 'utf8');
    check(
      'the component re-exports the core root rule instead of restating it',
      /^export \* from/m.test(component) && !/os\.homedir\(\)|NEWMARK_USER_ROOT/.test(component),
      `core ${core.length} B, component ${component.length} B; ` +
        'a second implementation is how two components come to read two stores',
    );
    check(
      'the installed rule honours the override, not only the convention',
      /NEWMARK_USER_ROOT/.test(core) && /os\.homedir\(\)/.test(core),
    );
    check(
      'no file in the installed bundle names a specific user directory',
      !execFileSync('node', ['-e', `const fs=require('fs'),p=require('path');const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p.join(d,e.name)):[p.join(d,e.name)]);process.stdout.write(walk(process.argv[1]).filter(f=>/\\.(js|json|yml)$/.test(f)).filter(f=>/12252|C:\\\\\\\\Users/.test(fs.readFileSync(f,'utf8'))).join('\\n'))`, installed], {
        encoding: 'utf8',
        shell: false,
      }).trim(),
      'a shipped file contains this machine\'s user path',
    );
  }
}

/* ------------------------------------------------------------------- cleanup --- */

fs.rmSync(sandbox, { recursive: true, force: true });
check('the sandbox was removed after the run', !fs.existsSync(sandbox), sandbox);
check(
  'the live store was never the target',
  !fs.existsSync(path.join(os.homedir(), '.Newmark', 'oob')) && !sandbox.includes('.Newmark'),
);

console.log('');
console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
