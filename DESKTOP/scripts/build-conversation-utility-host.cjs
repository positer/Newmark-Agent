const path = require('path');
const { buildSync } = require('esbuild');

buildSync({
  entryPoints: [path.resolve(__dirname, '..', 'src', 'conversation-utility-host.ts')],
  outfile: path.resolve(__dirname, '..', 'dist', 'conversation-utility-host.bundle.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['node-pty'],
  sourcemap: false,
  legalComments: 'none',
});

console.log('Electron utility Agent host bundled');
