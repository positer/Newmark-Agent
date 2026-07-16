const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const appRoot = path.resolve(__dirname, '..');
const output = path.join(appRoot, 'dist', 'typebox-compile.bundle.cjs');

fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  entryPoints: [require.resolve('typebox/compile')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
});

console.log('TypeBox compiler bundled for Electron Node 20');
