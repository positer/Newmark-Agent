import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverDshCompatibility } from '../core/dshCompatibility';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-dsh-compat-'));
  const dshHome = path.join(root, 'DSH Home');
  const profile = path.join(dshHome, 'profiles', 'preview');
  const bin = path.join(root, 'bin');
  const marker = path.join(root, 'PLUGIN-WAS-EXECUTED');
  const secret = 'TOP-SECRET-SHOULD-NEVER-LEAK';
  try {
    writeText(path.join(bin, 'dsh.cmd'), '@echo off\r\necho should-not-run\r\n');
    writeJson(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), {
      name: '@deepseek-ai/dsh',
      version: '0.1.0-rc.fixture',
    });
    writeJson(path.join(profile, 'package.json'), {
      name: 'fixture-profile',
      version: '1.0.0',
      futureTopLevel: { secret },
      dsh: {
        profile: {
          bundles: ['fixture-bundle', { package: 'future-bundle' }, { futureShape: true }],
          futureProfileKey: { secret },
        },
        futureDshKey: { secret },
      },
      dependencies: {
        'fixture-bundle': '1.0.0',
        'future-bundle': '1.0.0',
      },
    });
    writeText(path.join(dshHome, 'cordis.patch.yml'), '[]\n');
    writeJson(path.join(profile, 'node_modules', 'fixture-bundle', 'package.json'), {
      name: 'fixture-bundle',
      version: '2.0.0-preview',
      main: 'malicious.js',
      futureBundleTopLevel: { secret },
      dsh: { bundle: { patch: 'cordis.patch.yml', futureBundleKey: { secret } } },
    });
    writeText(path.join(profile, 'node_modules', 'fixture-bundle', 'malicious.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`);
    writeText(path.join(profile, 'node_modules', 'fixture-bundle', 'cordis.patch.yml'), [
      '- id: mcp-static',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: fixture-static',
      '    transport: stdio',
      '    command: npx',
      "    args: ['-y', '@modelcontextprotocol/server-fixture']",
      '    env:',
      '      FIXTURE_TOKEN: !!js process.env.FIXTURE_TOKEN',
      '- id: mcp-sensitive-arg',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: fixture-sensitive-arg',
      '    transport: stdio',
      '    command: node',
      `    args: ['server.js', '--token', '${secret}']`,
      '- id: mcp-sensitive-url',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: fixture-sensitive-url',
      '    transport: streamable-http',
      `    url: https://fixture:${secret}@example.invalid/mcp`,
      '',
    ].join('\n'));
    writeJson(path.join(root, 'outside-bundle', 'package.json'), {
      name: 'outside-bundle',
      dsh: { bundle: { patch: '../../outside.patch.yml' } },
    });
    writeText(path.join(profile, 'cordis.patch.yml'), [
      '- id: mcp-dynamic',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: fixture-dynamic',
      '    transport: streamable-http',
      '    url: !!js process.env.MCP_URL',
      '    headers:',
      '      Authorization: !!js process.env.MCP_TOKEN',
      '',
    ].join('\n'));

    const snapshot = discoverDshCompatibility(root, {
      env: { DSH_HOME: dshHome, PATH: bin },
      homeDir: path.join(root, 'unused-home'),
      pathValue: bin,
      platform: 'win32',
    });

    assert.equal(snapshot.readOnly, true);
    assert.equal(snapshot.preservesUnknownFields, true);
    assert.equal(snapshot.developerPreview, true);
    assert.equal(snapshot.update.channel, 'latest');
    assert.equal(snapshot.update.locked, false, 'developer-preview channel remains explicitly unpinned');
    assert.equal(snapshot.update.package, '@deepseek-ai/dsh');
    assert.equal(snapshot.package.version, '0.1.0-rc.fixture');
    assert.equal(snapshot.cli.available, true);
    assert.equal(snapshot.home.source, 'DSH_HOME');
    assert.deepEqual(snapshot.profiles[0].bundles, ['fixture-bundle', 'future-bundle'], 'profile bundle order is preserved for recognized entries');
    assert.deepEqual(snapshot.profiles[0].layers.map(layer => layer.kind), ['bundle', 'profile'], 'profile layers preserve bundle then profile patch precedence');
    assert.equal(snapshot.homeConfigFiles.some(file => file.endsWith(path.join('DSH Home', 'cordis.patch.yml'))), true, 'home patch is exposed as an editable layer path');
    assert.equal(snapshot.profiles[0].unsupportedBundleEntries, 1, 'future bundle shapes are reported rather than rewritten');
    assert.equal(snapshot.bundles.some(bundle => bundle.name === 'fixture-bundle' && bundle.patchExists), true);
    assert.equal(snapshot.configFiles.some(file => file.endsWith(path.join('fixture-bundle', 'cordis.patch.yml'))), true, 'bundle patches are exposed as read-only configuration paths');
    assert.equal(snapshot.bundles.some(bundle => bundle.name === 'future-bundle' && !bundle.resolved), true);
    assert.equal(snapshot.unknownKeys.some(key => key.includes('future')), true, 'unknown manifest key names are retained as compatibility metadata');
    assert.equal(fs.existsSync(marker), false, 'DSH discovery never imports or executes a plugin main module');

    const staticCandidate = snapshot.mcpCandidates.find(candidate => candidate.name === 'fixture-static');
    assert.ok(staticCandidate);
    assert.equal(staticCandidate.importable, true, 'dynamic secret expressions do not block a static endpoint candidate');
    assert.equal(staticCandidate.template?.enabled, false);
    assert.equal(staticCandidate.template?.command, 'npx');
    assert.deepEqual(staticCandidate.template?.args, ['-y', '@modelcontextprotocol/server-fixture']);
    assert.deepEqual(staticCandidate.envKeys, ['FIXTURE_TOKEN']);
    const dynamicCandidate = snapshot.mcpCandidates.find(candidate => candidate.name === 'fixture-dynamic');
    assert.ok(dynamicCandidate);
    assert.equal(dynamicCandidate.importable, false, 'dynamic !!js values are never evaluated or imported');
    assert.equal(dynamicCandidate.template, undefined);
    const sensitiveArgCandidate = snapshot.mcpCandidates.find(candidate => candidate.name === 'fixture-sensitive-arg');
    assert.ok(sensitiveArgCandidate);
    assert.equal(sensitiveArgCandidate.importable, false, 'credential-bearing arguments never cross the discovery boundary');
    assert.equal(sensitiveArgCandidate.template, undefined);
    const sensitiveUrlCandidate = snapshot.mcpCandidates.find(candidate => candidate.name === 'fixture-sensitive-url');
    assert.ok(sensitiveUrlCandidate);
    assert.equal(sensitiveUrlCandidate.importable, false, 'credential-bearing URLs never cross the discovery boundary');
    assert.equal(sensitiveUrlCandidate.template, undefined);
    const outsideBundle = snapshot.bundles.find(bundle => bundle.name === 'outside-bundle');
    assert.ok(outsideBundle);
    assert.equal(outsideBundle.patchPath, undefined, 'bundle patch traversal cannot make discovery read outside the bundle');
    assert.equal(outsideBundle.patchExists, false);
    assert.equal(JSON.stringify(snapshot).includes(secret), false, 'snapshot never exposes DSH config or manifest values that may contain secrets');
    assert.equal(snapshot.warnings.some(warning => warning.includes('future or unsupported')), true);
    assert.equal(snapshot.warnings.some(warning => warning.includes('could not be resolved')), true);

    const defaultHome = path.join(root, 'default-user');
    const defaultSnapshot = discoverDshCompatibility(root, { env: {}, homeDir: defaultHome, pathValue: '', platform: 'linux' });
    assert.equal(defaultSnapshot.dshHome, path.join(defaultHome, '.dsh'));
    assert.equal(defaultSnapshot.home.source, 'default');
    assert.equal(defaultSnapshot.cli.available, false);
    assert.equal(defaultSnapshot.warnings.some(warning => warning.includes('not found on PATH')), true);

    console.log('DSH compatibility verification passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
