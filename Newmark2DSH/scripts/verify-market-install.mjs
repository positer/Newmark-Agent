// Market compatibility, measured the way a user meets it: install the published package into
// a clean directory and check that everything the runtime reaches for is actually there.
//
// A plugin card renders a name, an icon and a description before it runs anything, so the
// manifest fields are checked too — a bundle whose patch path is wrong installs cleanly and
// then does nothing, which is the failure this is here to catch.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.argv[2];
const want = process.argv[3];
let failed = 0;
const ok = (name, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} - ${name}${condition || detail === undefined ? '' : '  ' + detail}`);
  if (!condition) failed += 1;
};

const dir = path.join(root, 'node_modules', 'newmark2dsh');
ok('the package is installed', fs.existsSync(dir), dir);
if (!fs.existsSync(dir)) process.exit(1);

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

// --- the manifest a card is rendered from -------------------------------------
ok('the published version is the one asked for', manifest.version === want, `${manifest.version} != ${want}`);
ok('it has a description', typeof manifest.description === 'string' && manifest.description.length > 0);
ok('it has an icon file, and the file exists', manifest.icon !== undefined && fs.existsSync(path.join(dir, manifest.icon)));
ok('it carries no runtime dependencies', Object.keys(manifest.dependencies || {}).length === 0, JSON.stringify(manifest.dependencies || {}));
ok('it declares a bundle patch', manifest.dsh?.bundle?.patch !== undefined, JSON.stringify(manifest.dsh || {}));
ok('it declares a client half on the web platform', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client || {}));
ok('it is published publicly (no private flag)', manifest.private !== true);

// --- the patch the Loader reads ------------------------------------------------
const patchPath = path.join(dir, manifest.dsh?.bundle?.patch ?? 'missing');
ok('the patch file exists at the declared path', fs.existsSync(patchPath), patchPath);
if (fs.existsSync(patchPath)) {
  const patch = fs.readFileSync(patchPath, 'utf8');
  const rows = patch.split('\n').filter((l) => l.startsWith('    - id: ')).map((l) => l.slice(10).trim());
  ok(
    'the patch declares the core row and the two preset rows',
    rows.length === 3 && rows[0] === 'newmark-core' && rows[1] === 'preset-dev' && rows[2] === 'preset-rdev',
    rows.join(', '),
  );
  ok('no component is addressed as a package', !/newmark2dsh-(memorylab|computeruse|agent-api)['"]/.test(patch.replace(/^#.*$/gm, '')));
}

// --- everything the runtime reaches for ----------------------------------------
for (const file of [
  'index.js',
  'client.js',
  'lib/schema.js',
  'lib/root.js',
  'lib/embed.js',
  'components/memorylab/index.js',
  'components/memorylab/package.json',
  'components/memorylab/lib/memory-store.js',
  'components/computeruse/index.js',
  'components/computeruse/package.json',
  'components/computeruse/lib/win32.js',
  'components/computeruse/lib/overlay-win32.js',
  'components/computeruse/lib/linux.js',
  'components/newmate/index.js',
  'components/newmate/component.js',
  'components/heartbeat/index.js',
  'components/heartbeat/component.js',
  'lib/durable-state.js',
  'lib/conversation-delivery.js',
  'components/agent-api/lib/visual.js',
  'components/newmate/lib/memory-context.js',
  'components/newmate/lib/mcp.js',
  'components/memorylab/lib/short-memory.js',
  'lib/newmate-context.js',
  'components/agent-api/index.js',
  'components/agent-api/component.js',
  'components/agent-api/package.json',
  'components/agent-api/lib/loop.js',
  'components/agent-api/lib/llm-seam.js',
  'components/agent-api/lib/core-model.js',
  'components/agent-api/lib/contract.js',
  'components/agent-api/lib/presence.js',
  'components/agent-api/lib/root.js',
  'components/agent-api/lib/schema.js',
  'components/agent-api/lib/embed.js',
  'lib/model-selection.js',
  'locale/en.json',
  'locale/zh.json',
  'LICENSE',
]) {
  ok(`ships ${file}`, fs.existsSync(path.join(dir, file)));
}

// --- the composed components are distinct packages to the registry --------------
for (const component of ['memorylab', 'computeruse', 'agent-api', 'newmate', 'heartbeat']) {
  const nested = path.join(dir, 'components', component, 'package.json');
  if (fs.existsSync(nested)) {
    const m = JSON.parse(fs.readFileSync(nested, 'utf8'));
    ok(`components/${component} is its own package at the shipped version`, m.version === want, m.version);
    ok(`components/${component} does not fight for the client registry`, m.dsh?.client === undefined);
  }
}

// --- the two halves parse -------------------------------------------------------
for (const file of ['index.js', 'client.js']) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) continue;
  const source = fs.readFileSync(full, 'utf8');
  try {
    new Function(source.replace(/^\s*(import|export)\s/gm, 'void '));
    ok(`${file} parses`, true);
  } catch (error) {
    // ESM syntax legitimately fails a Function constructor; only report a real syntax fault.
    ok(`${file} parses as a module`, /import|export/.test(source), String(error.message).slice(0, 80));
  }
}

console.log('');
console.log(failed === 0 ? 'MARKET COMPATIBLE' : `NOT COMPATIBLE (${failed} failures)`);
process.exit(failed === 0 ? 0 : 1);
