const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const repoRoot = path.resolve(__dirname, '..', '..');
const asarPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'release', 'win-unpacked', 'resources', 'app.asar');
const LIMIT = 10 * 1024 * 1024;
const roots = [
  '/node_modules/tesseract.js/',
  '/node_modules/tesseract.js-core/',
  '/node_modules/@tesseract.js-data/eng/',
  '/node_modules/@tesseract.js-data/chi_sim/',
  '/node_modules/bmp-js/',
  '/node_modules/is-url/',
  '/node_modules/opencollective-postinstall/',
  '/node_modules/regenerator-runtime/',
  '/node_modules/wasm-feature-detect/',
];

if (!fs.existsSync(asarPath)) throw new Error(`Missing packaged app.asar: ${asarPath}`);
const archiveEntries = asar.listPackage(asarPath).map(original => ({
  original,
  normalized: String(original).replace(/\\/g, '/'),
}));
const allFiles = archiveEntries.map(entry => entry.normalized);
const files = allFiles.filter(file => roots.some(root => file.startsWith(root)));
let bytes = 0;
for (const file of files) {
  const original = String(archiveEntries.find(entry => entry.normalized === file)?.original || file)
    .replace(/^[\\/]+/, '');
  try {
    const stat = asar.statFile(asarPath, original);
    if (!stat.files) bytes += Number(stat.size || 0);
  } catch {
    // asar.listPackage includes directory entries; only leaf files contribute.
  }
}
const required = [
  '/node_modules/tesseract.js-core/tesseract-core-simd.js',
  '/node_modules/tesseract.js-core/tesseract-core-simd.wasm',
  '/node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
  '/node_modules/@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz',
];
for (const file of required) {
  if (!files.includes(file)) throw new Error(`Required compact OCR asset is missing: ${file}`);
}
const forbidden = allFiles.filter(file =>
  file.startsWith('/node_modules/zlibjs/')
  || file.startsWith('/node_modules/idb-keyval/')
  || file.includes('/@tesseract.js-data/eng/4.0.0/')
  || file.includes('/@tesseract.js-data/chi_sim/4.0.0/')
  || /tesseract-core(?:-lstm|-simd-lstm)?\.wasm/.test(file)
  || file.endsWith('tesseract-core-simd.wasm.js'));
if (forbidden.length) throw new Error(`Forbidden OCR payload escaped pruning: ${forbidden.slice(0, 20).join(', ')}`);
if (bytes > LIMIT) throw new Error(`Packaged OCR increment ${bytes} bytes exceeds the hard 10 MiB budget.`);

console.log(JSON.stringify({
  ok: true,
  asarPath,
  bytes,
  mebibytes: Number((bytes / 1024 / 1024).toFixed(3)),
  limitBytes: LIMIT,
  languages: ['chi_sim', 'eng'],
  core: 'tesseract-core-simd',
  recognitionOrder: 'text>vision>local_ocr',
}));
