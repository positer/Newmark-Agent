// Convert the installed PC Lucide assets to equivalent Compose paths.
// No icon artwork is invented here. Run --check to detect upstream drift.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const target = path.resolve(root, '../android/app/src/main/java/com/newmark/mobile/ui/components/LucideIcons.kt');
const icons = {
  Monitor: 'monitor', Laptop: 'laptop', Menu: 'menu', ChevronDown: 'chevron-down',
  ChevronUp: 'chevron-up', Play: 'play', Pause: 'pause', Upload: 'upload',
  ScanLine: 'scan-line', Image: 'image', Trash2: 'trash-2', Terminal: 'terminal',
};
function paths(svg) {
  return [...svg.matchAll(/<(path|rect|circle|line|polyline|polygon)\b([^>]*?)\/?\s*>/g)].map(([, tag, attrs]) => {
    const a = Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    const n = key => Number(a[key] || 0);
    if (tag === 'path') return a.d;
    if (tag === 'line') return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`;
    if (tag === 'polyline' || tag === 'polygon') {
      const points = a.points.trim().split(/[\s,]+/).map(Number);
      if (points.length % 2) throw Error('Unpaired SVG point');
      return points.map((v, i) => i % 2 ? ` ${v}` : `${i ? 'L' : 'M'}${v}`).join('') + (tag === 'polygon' ? 'z' : '');
    }
    if (tag === 'circle') {
      const x = n('cx'), y = n('cy'), r = n('r');
      return `M${x-r} ${y}a${r} ${r} 0 1 0 ${2*r} 0a${r} ${r} 0 1 0 ${-2*r} 0z`;
    }
    const x=n('x'), y=n('y'), w=n('width'), h=n('height'), rx=n('rx') || n('ry'), ry=n('ry') || rx;
    if (!rx) return `M${x} ${y}h${w}v${h}h${-w}z`;
    return `M${x+rx} ${y}H${x+w-rx}a${rx} ${ry} 0 0 1 ${rx} ${ry}V${y+h-ry}a${rx} ${ry} 0 0 1 ${-rx} ${ry}H${x+rx}a${rx} ${ry} 0 0 1 ${-rx} ${-ry}V${y+ry}a${rx} ${ry} 0 0 1 ${rx} ${-ry}z`;
  });
}
const start = '    // BEGIN generated navigation icons (lucide-static, ISC)';
const end = '    // END generated navigation icons';
const body = Object.entries(icons).map(([name, asset]) => {
  const svg = fs.readFileSync(path.join(root, 'node_modules/lucide-static/icons', asset + '.svg'), 'utf8');
  const data = paths(svg);
  if (!data.length) throw Error('Empty icon: ' + asset);
  return `    val ${name}: ImageVector by lazy {\n        icon(\n            "${asset}",\n${data.map(d => `            ${JSON.stringify(d)},`).join('\n')}\n        )\n    }`;
}).join('\n\n');
const block = `${start}\n${body}\n${end}\n`;
const original = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
const first = original.indexOf(start), last = original.indexOf(end);
const updated = first >= 0
  ? original.slice(0, first) + block + original.slice(last + end.length + 1)
  : original.replace(/}\s*$/, block + '}\n');
if (process.argv.includes('--check')) {
  if (updated !== original) throw Error('Mobile navigation icons differ from installed PC Lucide assets');
} else fs.writeFileSync(target, updated);
console.log(`${Object.keys(icons).length} mobile navigation icons match PC Lucide assets`);
