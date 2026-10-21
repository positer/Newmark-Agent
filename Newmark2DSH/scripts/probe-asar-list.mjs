// Read-only probe: list entries inside an Electron asar archive by parsing its
// header (8-byte pickle prefix + JSON directory). No extraction, no writes.
import { readFileSync } from 'node:fs';

const asarPath = process.argv[2];
const filter = process.argv[3] ? new RegExp(process.argv[3]) : null;

const fd = readFileSync(asarPath);
// asar header layout: [u32 4][u32 headerBufLen][u32 jsonLenWithPadding][u32 jsonLen] then JSON at 16
const headerBufLen = fd.readUInt32LE(4);
const jsonLen = fd.readUInt32LE(12);
if (!Number.isFinite(jsonLen) || jsonLen <= 0 || 16 + jsonLen > fd.length) {
  throw new Error(`unexpected asar header: headerBufLen=${headerBufLen} jsonLen=${jsonLen} fileLen=${fd.length}`);
}
const header = JSON.parse(fd.subarray(16, 16 + jsonLen).toString('utf8').replace(/\0+$/, ''));

const out = [];
function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const full = `${prefix}/${name}`;
    if (value.files) walk(value, full);
    else out.push({ path: full, size: value.size, offset: value.offset });
  }
}
walk(header, '');
const hits = filter ? out.filter((e) => filter.test(e.path)) : out;
console.log(JSON.stringify({ total: out.length, shown: hits.length, entries: hits.slice(0, 400) }, null, 2));
