import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2], 'utf8');
const marker = 'const NATIVE_CSHARP_TEMPLATE = ' + String.fromCharCode(96);
const start = src.indexOf(marker);
const end = src.indexOf(String.fromCharCode(96) + ';', start + 10);
console.log('template region:', start, end);
const before = src.slice(0, start).split('\n').length;
src.slice(start, end).split('\n').forEach((line, i) => {
  if (line.includes(String.fromCharCode(96))) console.log(`${before + i}: ${line.trim()}`);
});
console.log('template body line count:', src.slice(start, end).split('\n').length);
