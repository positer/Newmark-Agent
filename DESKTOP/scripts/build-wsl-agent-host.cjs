const path = require('path');
const { buildSync } = require('esbuild');

buildSync({
  entryPoints: [path.resolve(__dirname, '..', 'src', 'wsl-agent-host.ts')],
  outfile: path.resolve(__dirname, '..', 'dist', 'wsl-agent-host.bundle.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: false,
  legalComments: 'none',
});

console.log('WSL Agent host bundled');
