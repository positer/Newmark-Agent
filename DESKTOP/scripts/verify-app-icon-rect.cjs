// Pure-Node sanity check that the rounded-rect background in app-icon-dark.svg
// matches the opaque black surface of the source PNG. The glyph paths are
// produced by imagetracerjs directly from the source pixels, so they reproduce
// the raster glyph by construction; the rect is the only hand-derived geometry.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const img = PNG.sync.read(fs.readFileSync(path.join(root, 'assets', 'app-icon-dark.png')));

const X = 125, Y = 111, W = 774, H = 797, R = 160;
function inRoundedRect(px, py) {
  if (px < X || px > X + W || py < Y || py > Y + H) return false;
  const cx = Math.min(Math.max(px, X + R), X + W - R);
  const cy = Math.min(Math.max(py, Y + R), Y + H - R);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= R * R;
}

let opaqueBlack = 0, rectHits = 0, agree = 0, falseRect = 0, falseBlack = 0;
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    const a = img.data[i + 3];
    const lum = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    const isBlack = a > 128 && lum < 60;
    const isOpaque = a > 128;
    const inRect = inRoundedRect(x, y);
    if (isBlack) opaqueBlack++;
    if (inRect) rectHits++;
    if (isOpaque === inRect) agree++;
    else if (inRect) falseRect++;
    else falseBlack++;
  }
}
const total = img.width * img.height;
console.log(`source opaque-black pixels: ${opaqueBlack}`);
console.log(`svg rect pixels: ${rectHits}`);
console.log(`opaque-surface agreement: ${(100 * agree / total).toFixed(3)}% (false-rect ${falseRect}, false-black ${falseBlack})`);
