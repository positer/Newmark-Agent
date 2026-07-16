const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const srcHtml = path.join(root, 'src', 'ui', 'index.html');
const startupSrc = path.join(root, 'src', 'ui', 'startup.html');
const distUi = path.join(root, 'dist', 'ui');
const distHtml = path.join(distUi, 'index.html');
const startupDist = path.join(distUi, 'startup.html');
const spriteSrc = path.join(root, 'node_modules', 'lucide-static', 'sprite.svg');
const spriteDist = path.join(distUi, 'lucide-sprite.svg');
const distAssets = path.join(root, 'dist', 'assets');

function writeCompactPng(sourcePath, destinationPath, size = 64) {
  const source = PNG.sync.read(fs.readFileSync(sourcePath));
  const output = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * source.height / size);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * source.height / size));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * source.width / size);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * source.width / size));
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      let pixels = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const offset = ((sy * source.width) + sx) * 4;
          const a = source.data[offset + 3];
          alpha += a;
          red += source.data[offset] * a;
          green += source.data[offset + 1] * a;
          blue += source.data[offset + 2] * a;
          pixels += 1;
        }
      }
      const target = ((y * size) + x) * 4;
      output.data[target] = alpha > 0 ? Math.round(red / alpha) : 0;
      output.data[target + 1] = alpha > 0 ? Math.round(green / alpha) : 0;
      output.data[target + 2] = alpha > 0 ? Math.round(blue / alpha) : 0;
      output.data[target + 3] = Math.round(alpha / Math.max(1, pixels));
    }
  }
  fs.writeFileSync(destinationPath, PNG.sync.write(output));
}

let html = fs.readFileSync(srcHtml, 'utf8');
let sprite = fs.readFileSync(spriteSrc, 'utf8');

function spriteSymbolNames(svg) {
  return new Set([...svg.matchAll(/<symbol\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]));
}

function collectUsedIconNames(source, availableNames) {
  const names = new Set(['circle']);
  for (const match of source.matchAll(/lucide-sprite\.svg#([a-z0-9-]+)/g)) names.add(match[1]);
  // Dynamic icon helpers ultimately receive short literal names. Intersecting
  // all string literals with the Lucide catalogue keeps those branches safe
  // while still removing the overwhelming majority of the 1,700+ symbols.
  for (const match of source.matchAll(/['"]([a-z][a-z0-9-]{1,48})['"]/g)) {
    if (availableNames.has(match[1])) names.add(match[1]);
  }
  return new Set([...names].filter(name => availableNames.has(name)));
}

function filterLucideSprite(svg, usedNames) {
  const symbols = [...svg.matchAll(/\s*<symbol\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/symbol>/g)]
    .filter(match => usedNames.has(match[1]))
    .map(match => match[0].trim());
  if (symbols.length !== usedNames.size) {
    const found = new Set(symbols.map(symbol => (symbol.match(/\bid="([^"]+)"/) || [])[1]).filter(Boolean));
    const missing = [...usedNames].filter(name => !found.has(name));
    throw new Error(`Lucide sprite is missing referenced symbols: ${missing.join(', ')}`);
  }
  return svg.replace(/(<defs>)[\s\S]*?(<\/defs>)/, `$1\n    ${symbols.join('\n    ')}\n  $2`);
}

const availableIconNames = spriteSymbolNames(sprite);
const usedIconNames = collectUsedIconNames(html, availableIconNames);
sprite = filterLucideSprite(sprite, usedIconNames);

sprite = sprite.replace(/^\uFEFF/, '').replace(/^<\?xml[^>]*>\s*/i, '');
sprite = sprite.replace(
  /<svg\s+/, 
  '<svg id="lucide-sprite-root" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden" '
);

html = html.replace(/href="lucide-sprite\.svg#/g, 'href="#');
html = html.replace("var ICON_SPRITE_PATH = 'lucide-sprite.svg';", "var ICON_SPRITE_PATH = '';" );
if (!html.includes('id="lucide-sprite-root"')) {
  html = html.replace('<body>', '<body>\n' + sprite + '\n');
}

fs.mkdirSync(distUi, { recursive: true });
fs.mkdirSync(distAssets, { recursive: true });
fs.writeFileSync(distHtml, html, 'utf8');
fs.writeFileSync(spriteDist, sprite, 'utf8');
fs.copyFileSync(startupSrc, startupDist);
writeCompactPng(path.join(root, 'assets', 'app-icon-dark.png'), path.join(distAssets, 'app-icon-dark-64.png'));
writeCompactPng(path.join(root, 'assets', 'app-icon-light.png'), path.join(distAssets, 'app-icon-light-64.png'));
console.log(`ui icons embedded ${usedIconNames.size} used Lucide symbols from lucide-static`);
