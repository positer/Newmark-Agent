// Generates a vector (SVG) version of the black-on-white Newmark app icon so the
// titlebar icon stays crisp at any DPI. The glyph is auto-traced from the
// supplied 1024x1024 PNG via imagetracerjs; the rounded-square background is a
// plain <rect>.
//
// Reproduce with:  npm install --no-save imagetracerjs   (then run this script)
// The generated assets/app-icon-dark.svg is committed, so this is a rebuild-only tool.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const ImageTracer = require('imagetracerjs');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'assets', 'app-icon-dark.png');
const out = path.join(root, 'assets', 'app-icon-dark.svg');

const img = PNG.sync.read(fs.readFileSync(src));
const W = img.width;
const H = img.height;

// Binarize: white glyph -> black, everything else -> white, so the tracer
// captures the glyph outline. Alpha is ignored; the rounded-square background is
// reconstructed geometrically below.
const data = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const a = img.data[i + 3];
    const lum = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    const white = a > 128 && lum > 150;
    const v = white ? 0 : 255;
    const o = (y * W + x) * 4;
    data[o] = v;
    data[o + 1] = v;
    data[o + 2] = v;
    data[o + 3] = 255;
  }
}

const options = {
  ltres: 1,
  qtres: 1,
  pathomit: 6,
  numberofcolors: 2,
  blurradius: 0,
  mincolorratio: 0,
  roundcoords: 1,
};
const svg = ImageTracer.imagedataToSVG({ width: W, height: H, data }, options);
// imagetracerjs emits a background layer as a full-canvas path with inner holes
// (e.g. "M 0 0 L 1024 0 ..."). Drop it; keep only the solid glyph paths.
const ds = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)]
  .map(m => m[1])
  .filter(d => !/^M\s*0\s+0\s+L\s*1024\s+0\b/.test(d.trim()));
if (!ds.length) throw new Error('no glyph paths traced');

// Rounded-square background measured from the source PNG opaque bbox.
const rx = 125;
const ry = 111;
const rw = 774;
const rh = 797;
const rr = 160;

const lines = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'];
lines.push(`  <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${rr}" fill="#000000"/>`);
for (const d of ds) lines.push(`  <path fill="#ffffff" d="${d}"/>`);
lines.push('</svg>');

fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${out} (${ds.length} glyph paths, ${Buffer.byteLength(lines.join('\n'))} bytes)`);
