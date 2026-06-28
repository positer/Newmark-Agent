const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcHtml = path.join(root, 'src', 'ui', 'index.html');
const distUi = path.join(root, 'dist', 'ui');
const distHtml = path.join(distUi, 'index.html');
const spriteSrc = path.join(root, 'node_modules', 'lucide-static', 'sprite.svg');
const spriteDist = path.join(distUi, 'lucide-sprite.svg');

let html = fs.readFileSync(srcHtml, 'utf8');
let sprite = fs.readFileSync(spriteSrc, 'utf8');

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
fs.writeFileSync(distHtml, html, 'utf8');
fs.copyFileSync(spriteSrc, spriteDist);
console.log('ui icons embedded from lucide-static');