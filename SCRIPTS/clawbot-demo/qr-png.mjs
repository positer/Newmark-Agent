/**
 * Render a QR payload to a PNG, so a QR can be shown in a UI that cannot draw block
 * characters (the terminal renderer still exists for CLI users).
 *
 * Why hand-rolled: the vendored qrcode-terminal only prints half-block glyphs. Turning its
 * module matrix into a PNG needs zlib + a CRC32 table, both of which node ships - so this
 * stays dependency-free instead of pulling an image library into a throwaway probe.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** QR module matrix (true = dark) for a payload, using the vendored encoder. */
export function qrMatrix(text) {
  const QRCode = require('./vendor/qrcode-terminal/vendor/QRCode/index.js');
  const QRErrorCorrectLevel = require('./vendor/qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js');
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(String(text));
  qr.make();
  const count = qr.getModuleCount();
  const rows = [];
  for (let row = 0; row < count; row += 1) {
    const cells = [];
    for (let col = 0; col < count; col += 1) cells.push(qr.isDark(row, col) === true);
    rows.push(cells);
  }
  return rows;
}

export function qrPngBuffer(text, { scale = 8, margin = 4 } = {}) {
  const matrix = qrMatrix(text);
  const modules = matrix.length;
  const side = (modules + margin * 2) * scale;
  const bytesPerRow = side * 3 + 1;
  const raw = Buffer.alloc(bytesPerRow * side, 0xff);
  for (let y = 0; y < side; y += 1) raw[y * bytesPerRow] = 0; // filter byte: none
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!matrix[row][col]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        const y = (row + margin) * scale + dy;
        for (let dx = 0; dx < scale; dx += 1) {
          const x = (col + margin) * scale + dx;
          const offset = y * bytesPerRow + 1 + x * 3;
          raw[offset] = 0; raw[offset + 1] = 0; raw[offset + 2] = 0;
        }
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Write the PNG and return { file, bytes, modules, side }. */
export function writeQrPng(text, file, options = {}) {
  const buffer = qrPngBuffer(text, options);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  return { file: path.resolve(file), bytes: buffer.length, modules: qrMatrix(text).length, side: (qrMatrix(text).length + (options.margin ?? 4) * 2) * (options.scale ?? 8) };
}

export { here };