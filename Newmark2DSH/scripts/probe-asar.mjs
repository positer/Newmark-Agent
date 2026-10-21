// Read-only probe: list or extract entries inside an Electron asar archive
// by parsing its header. Never writes to the archive.
//
// Usage:
//   node probe-asar.mjs <asar> list <regex> [max]
//   node probe-asar.mjs <asar> cat <exact/path>
//   node probe-asar.mjs <asar> grep <regex> <entryPathRegex> [maxMatches]
import { readFileSync } from 'node:fs';

const [asarPath, mode, arg1, arg2, arg3] = process.argv.slice(2);
if (!asarPath || !mode) {
  console.error('usage: probe-asar.mjs <asar> list|cat|grep ...');
  process.exit(2);
}

const fd = readFileSync(asarPath);
// asar layout: [u32 4][u32 headerBufLen] then the header pickle [u32 paddedLen][u32 jsonLen][json].
// The JSON starts at 16; file data starts right after the whole header buffer.
const headerBufLen = fd.readUInt32LE(4);
const jsonLen = fd.readUInt32LE(12);
if (!Number.isFinite(headerBufLen) || !Number.isFinite(jsonLen) || jsonLen <= 0 || jsonLen > headerBufLen) {
  throw new Error(`unexpected asar header: headerBufLen=${headerBufLen} jsonLen=${jsonLen}`);
}
const header = JSON.parse(fd.subarray(16, 16 + jsonLen).toString('utf8').replace(/\0+$/, ''));
const DATA_START = 8 + headerBufLen;

const files = new Map();
function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const full = `${prefix}/${name}`;
    if (value.files) walk(value, full);
    else files.set(full, value);
  }
}
walk(header, '');

function readEntry(entry) {
  const start = DATA_START + Number(entry.offset);
  return fd.subarray(start, start + entry.size);
}

if (mode === 'list') {
  const re = new RegExp(arg1);
  const max = Number(arg2 ?? 400);
  const hits = [...files.keys()].filter((p) => re.test(p)).slice(0, max);
  console.log(JSON.stringify({ total: files.size, shown: hits.length, paths: hits }, null, 2));
} else if (mode === 'cat') {
  const entry = files.get(arg1) ?? files.get(`/${arg1}`);
  if (!entry) {
    console.error(`not found: ${arg1}`);
    process.exit(1);
  }
  process.stdout.write(readEntry(entry).toString('utf8'));
} else if (mode === 'grep') {
  const re = new RegExp(arg1);
  const fileRe = new RegExp(arg2 ?? '.');
  const max = Number(arg3 ?? 60);
  const out = [];
  for (const [path, entry] of files) {
    if (entry.size > 4_000_000 || !fileRe.test(path)) continue;
    let text;
    try {
      text = readEntry(entry).toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push({ path, line: i + 1, text: lines[i].slice(0, 400) });
        if (out.length >= max) break;
      }
    }
    if (out.length >= max) break;
  }
  console.log(JSON.stringify({ matches: out.length, out }, null, 2));
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
