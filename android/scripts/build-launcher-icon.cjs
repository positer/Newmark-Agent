// 把同事新绘制的 Newmark 矢量图（DESKTOP/assets/app-icon-dark.svg，viewBox 0 0 1024 1024）
// 转成 Android adaptive icon（Google 规范，适配亮色/暗色）：
//   - 居中基准 = 源 SVG 圆角背景 rect 的中心 (512, 509)（而非含四角星的 glyph bbox 中心，
//     避免 N 字形主体偏左）。
//   - drawable/ic_launcher_foreground.xml          亮色模式前景（深色 glyph）
//   - drawable-night/ic_launcher_foreground.xml     暗色模式前景（白色 glyph）
//   - drawable/ic_launcher_monochrome.xml           Android 13+ 主题图标单色图层
//   - values/colors.xml + values-night/colors.xml   亮/暗背景色
//   - mipmap-anydpi-v26/v33 adaptive icon
const fs = require('fs');
const path = require('path');

const svgPath = process.argv[2] || path.resolve(__dirname, '..', '..', 'DESKTOP', 'assets', 'app-icon-dark.svg');
const resDir = process.argv[3] || path.resolve(__dirname, '..', 'app', 'src', 'main', 'res');
const svg = fs.readFileSync(svgPath, 'utf8');

const ds = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(m => m[1]);
if (!ds.length) throw new Error('no glyph paths');

// glyph bbox（用于缩放比例）
function collectPoints(d) {
  const pts = [];
  const re = /(-?\d+(?:\.\d+)?)[, ]\s*(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(d))) pts.push([parseFloat(m[1]), parseFloat(m[2])]);
  return pts;
}
const all = ds.flatMap(collectPoints);
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const [x, y] of all) {
  if (x < minX) minX = x; if (y < minY) minY = y;
  if (x > maxX) maxX = x; if (y > maxY) maxY = y;
}
const w = maxX - minX, h = maxY - minY;

// 居中基准：源 SVG 圆角背景 rect 的中心（glyph 设计时相对它居中）
const cx = 512;
const cy = 509;

const viewport = 108;
const safe = 66;
const scale = safe / Math.max(w, h);
const tx = viewport / 2 - cx * scale;
const ty = viewport / 2 - cy * scale;

function scalePath(d) {
  return d.replace(/(-?\d+(?:\.\d+)?)[, ]\s*(-?\d+(?:\.\d+)?)/g, (m, x, y) => {
    const nx = +(parseFloat(x) * scale + tx).toFixed(2);
    const ny = +(parseFloat(y) * scale + ty).toFixed(2);
    return `${nx},${ny}`;
  });
}

function vectorXml(paths, fillColor) {
  const body = paths.map(d => `    <path android:fillColor="${fillColor}" android:pathData="${scalePath(d)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android"\n    android:width="108dp"\n    android:height="108dp"\n    android:viewportWidth="108"\n    android:viewportHeight="108">\n${body}\n</vector>\n`;
}

// 亮色模式（drawable/）：深色 glyph；暗色模式（drawable-night/）：白色 glyph
const fgLight = path.join(resDir, 'drawable', 'ic_launcher_foreground.xml');
const fgNight = path.join(resDir, 'drawable-night', 'ic_launcher_foreground.xml');
fs.mkdirSync(path.dirname(fgLight), { recursive: true });
fs.mkdirSync(path.dirname(fgNight), { recursive: true });
fs.writeFileSync(fgLight, vectorXml(ds, '#FF000000'));
fs.writeFileSync(fgNight, vectorXml(ds, '#FFFFFFFF'));

// 单色图层（Android 13+，系统按主题 tint）
const monoDir = path.join(resDir, 'drawable');
fs.writeFileSync(path.join(monoDir, 'ic_launcher_monochrome.xml'), vectorXml(ds, '#FFFFFFFF'));

// adaptive icon v26 / v33
const v26 = path.join(resDir, 'mipmap-anydpi-v26');
const v33 = path.join(resDir, 'mipmap-anydpi-v33');
fs.mkdirSync(v26, { recursive: true });
fs.mkdirSync(v33, { recursive: true });
const adaptive = `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@drawable/ic_launcher_foreground"/>\n</adaptive-icon>\n`;
const adaptiveMono = `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@drawable/ic_launcher_foreground"/>\n    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n</adaptive-icon>\n`;
fs.writeFileSync(path.join(v26, 'ic_launcher.xml'), adaptive);
fs.writeFileSync(path.join(v26, 'ic_launcher_round.xml'), adaptive);
fs.writeFileSync(path.join(v33, 'ic_launcher.xml'), adaptiveMono);
fs.writeFileSync(path.join(v33, 'ic_launcher_round.xml'), adaptiveMono);

// 背景色：亮色（values/）浅色，暗色（values-night/）深色
function writeColors(file, hex) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${hex}</color>\n</resources>\n`);
}
writeColors(path.join(resDir, 'values', 'colors.xml'), '#FFF2F2F7');
writeColors(path.join(resDir, 'values-night', 'colors.xml'), '#FF101014');

console.log(`glyph ${w.toFixed(0)}x${h.toFixed(0)}, center anchor (${cx},${cy}), scale=${scale.toFixed(4)}, translate=(${tx.toFixed(2)},${ty.toFixed(2)})`);
console.log('wrote light/night foreground + monochrome + adaptive icons');
