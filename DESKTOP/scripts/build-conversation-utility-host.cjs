const path = require('path');
const { build } = require('esbuild');

/**
 * dev-0.6.6: diagnostics and probes stay in source but must not ship. Passing
 * `--strip-diagnostics` (or NEWMARK_STRIP_DIAGNOSTICS=1) resolves the source-only
 * probe module to its neutral no-op stub, so the packaged utility host bundle
 * contains no probe code, no heap-snapshot capability, no probe file path and no
 * probe naming.
 * Release packaging (scripts/dist-portable.cjs) always uses this mode.
 */
const stripDiagnostics = process.argv.includes('--strip-diagnostics')
  || process.env.NEWMARK_STRIP_DIAGNOSTICS === '1';
const root = path.resolve(__dirname, '..');
const stripPlugin = {
  name: 'strip-diagnostics',
  setup(build) {
    build.onResolve({ filter: /(^|[\\/])memoryProbe$/ }, () => ({
      path: path.join(root, 'src', 'core', 'hostRuntimeHooks.ts'),
    }));
  },
};

build({
  entryPoints: [path.resolve(__dirname, '..', 'src', 'conversation-utility-host.ts')],
  outfile: process.env.NEWMARK_UTILITY_HOST_OUTFILE
    ? path.resolve(process.env.NEWMARK_UTILITY_HOST_OUTFILE)
    : path.resolve(__dirname, '..', 'dist', 'conversation-utility-host.bundle.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['node-pty'],
  sourcemap: false,
  legalComments: 'none',
  plugins: stripDiagnostics ? [stripPlugin] : [],
}).then(() => {
  console.log(`Electron utility Agent host bundled${stripDiagnostics ? ' (diagnostics stripped)' : ''}`);
}).catch(error => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
