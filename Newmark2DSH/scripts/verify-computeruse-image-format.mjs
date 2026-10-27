/**
 * verify-computeruse-image-format — the capture format a caller asks for, offline.
 *
 * WHY THIS GATE EXISTS. The Windows hidden-desktop agent has no image encoder: it writes the
 * pixels PrintWindow/BitBlt produced into a BMP by hand. Handing a BMP to a vision model means
 * every caller converts it first, which is a second pass over the pixels nobody asked for. The
 * plugin now converts once, locally, and only when the caller asks (format: "png").
 *
 * The conversion is the part that must not be taken on faith: a decoder that mis-reads a row
 * stride or an upside-down bitmap produces a plausible picture of the wrong thing. So this gate
 * decodes its own PNG output back to pixels and compares them with what it put in, for both
 * orientations and both depths the agent can write.
 *
 * Run: node scripts/verify-computeruse-image-format.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { CAPTURE_FORMATS, bmpToPng, convertCaptureFile, decodeBmp, encodePng, requestedFormat } from '../packages/newmark-core/components/computeruse/lib/image-format.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPONENT = path.join(HERE, '..', 'packages/newmark-core/components/computeruse/component.js');
const WIN32 = path.join(HERE, '..', 'packages/newmark-core/components/computeruse/lib/win32.js');

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });

/** A BMP laid out the way hidden-agent.js WriteBmp writes one: BI_RGB, top-down when asked. */
function buildBmp({ width, height, bitCount = 32, topDown = true, pixels }) {
  const bytesPerPixel = bitCount / 8;
  const stride = Math.ceil((width * bytesPerPixel) / 4) * 4;
  const imageSize = stride * height;
  const header = Buffer.alloc(14 + 40);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(14 + 40 + imageSize, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(topDown ? -height : height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(bitCount, 28);
  header.writeUInt32LE(0, 30);
  header.writeUInt32LE(imageSize, 34);
  const body = Buffer.alloc(imageSize);
  for (let row = 0; row < height; row += 1) {
    const sourceRow = topDown ? row : height - 1 - row;
    for (let x = 0; x < width; x += 1) {
      const pixel = pixels[sourceRow * width + x];
      const at = row * stride + x * bytesPerPixel;
      body[at] = pixel[2];
      body[at + 1] = pixel[1];
      body[at + 2] = pixel[0];
      if (bytesPerPixel === 4) body[at + 3] = 255;
    }
  }
  return Buffer.concat([header, body]);
}

/** Decode the PNG this module produced back to RGBA rows, so the pixels can be compared. */
function decodePng(buffer) {
  if (buffer.length < 8 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { ok: false, code: 'not_a_png' };
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.subarray(at + 4, at + 8).toString('ascii');
    const data = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 2 ? 3 : 4;
  const rowLength = width * channels;
  const rows = [];
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (rowLength + 1)];
    if (filter !== 0) return { ok: false, code: 'unsupported_filter', filter };
    rows.push(raw.subarray(row * (rowLength + 1) + 1, (row + 1) * (rowLength + 1)));
  }
  return { ok: true, width, height, colorType, rows, channels };
}

const PIXELS = [
  [[255, 0, 0], [0, 255, 0], [0, 0, 255]],
  [[10, 20, 30], [40, 50, 60], [70, 80, 90]],
];
const FLAT = PIXELS.flat();
const FLAT_BYTES = FLAT.flat();
const ROW_BYTES = 3 * 3;
const samePixels = (decoded) => decoded.rows.every((row, y) => row.length === ROW_BYTES && [...row].every((value, i) => value === FLAT_BYTES[y * ROW_BYTES + i]));

/* ============================================================ format names ===== */
check('format: the two declared names are bmp and png', CAPTURE_FORMATS.join(',') === 'bmp,png');
check('format: asking for nothing keeps the untouched capture (bmp)', requestedFormat(undefined) === 'bmp' && requestedFormat('') === 'bmp' && requestedFormat(null) === 'bmp');
check('format: png is accepted in the spellings a caller might send', requestedFormat('png') === 'png' && requestedFormat('PNG') === 'png' && requestedFormat(' image/png ') === 'png');
check('format: an unknown name is NOT silently served as png', requestedFormat('jpeg') === 'bmp' && requestedFormat('webp') === 'bmp', requestedFormat('jpeg'));

/* ==================================================== the BMP the agent writes ===== */
const topDown32 = buildBmp({ width: 3, height: 2, bitCount: 32, topDown: true, pixels: FLAT });
const decoded32 = decodeBmp(topDown32);
check('bmp: a 32-bit top-down capture decodes to the right size', decoded32.ok === true && decoded32.width === 3 && decoded32.height === 2 && decoded32.topDown === true, JSON.stringify({ ...decoded32, rgb: undefined }));
check('bmp: BGRA is re-ordered to RGB', decoded32.ok === true && decoded32.rgb[0] === 255 && decoded32.rgb[1] === 0 && decoded32.rgb[2] === 0, [...decoded32.rgb.slice(0, 6)].join(','));

const bottomUp24 = buildBmp({ width: 3, height: 2, bitCount: 24, topDown: false, pixels: FLAT });
const decoded24 = decodeBmp(bottomUp24);
check('bmp: a 24-bit bottom-up capture is read in the right row order', decoded24.ok === true && decoded24.topDown === false && decoded24.rgb[0] === 255 && decoded24.rgb[1] === 0 && decoded24.rgb[2] === 0, [...decoded24.rgb.slice(0, 6)].join(','));
const oneRow24 = buildBmp({ width: 3, height: 1, bitCount: 24, topDown: true, pixels: PIXELS[0] });
check('bmp: the row stride is padded to four bytes, not assumed', oneRow24.length === 54 + 12, String(oneRow24.length));

/* ============================================================== the PNG out ===== */
const png = bmpToPng(topDown32);
check('png: a capture converts', png.ok === true, JSON.stringify(png).slice(0, 200));
check('png: the file starts with the PNG signature', png.ok === true && png.png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
const back = png.ok === true ? decodePng(png.png) : { ok: false };
check('png: IHDR carries the source dimensions and truecolour', back.ok === true && back.width === 3 && back.height === 2 && back.colorType === 2, JSON.stringify({ w: back.width, h: back.height, t: back.colorType }));
check('png: the pixels survive the round trip exactly', back.ok === true && samePixels(back), back.ok ? JSON.stringify(back.rows[0].slice(0, 6)) : back.code);
const png24 = bmpToPng(bottomUp24);
const back24 = png24.ok === true ? decodePng(png24.png) : { ok: false };
check('png: a bottom-up 24-bit capture converts to the same pixels', back24.ok === true && samePixels(back24), back24.ok ? JSON.stringify(back24.rows[0].slice(0, 6)) : back24.code);
check('png: the encoder is the inverse of the decoder, not a parallel guess', encodePng(decodeBmp(topDown32)).equals(png.png));

/* ================================================================ refusals ===== */
const sixteenBit = buildBmp({ width: 2, height: 1, bitCount: 16, topDown: true, pixels: [[0, 0, 0], [0, 0, 0]] });
check('refusal: a depth the agent never writes is refused by name', bmpToPng(sixteenBit).code === 'bmp_depth_unsupported', bmpToPng(sixteenBit).code);
const bitfields = Buffer.from(topDown32);
bitfields.writeUInt32LE(3, 30);
check('refusal: BI_BITFIELDS is refused rather than guessed at', bmpToPng(bitfields).code === 'bmp_compression_unsupported', bmpToPng(bitfields).code);
check('refusal: a truncated capture says so', bmpToPng(topDown32.subarray(0, 40)).code === 'bmp_truncated', bmpToPng(topDown32.subarray(0, 40)).code);
check('refusal: something that is not a BMP is not decoded as one', bmpToPng(Buffer.from('not a bitmap at all, but long enough to pass the length check............')).code === 'not_a_bmp');

/* ============================================================ file plumbing ===== */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-image-format-'));
const source = path.join(scratch, 'capture.bmp');
const target = path.join(scratch, 'capture.png');
fs.writeFileSync(source, topDown32);
const converted = convertCaptureFile({ sourcePath: source, targetPath: target });
check('file: the conversion writes the PNG next to the capture', converted.ok === true && fs.existsSync(target), JSON.stringify(converted).slice(0, 200));
check('file: the receipt hashes what it wrote', converted.ok === true && converted.sha256 === crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'), converted.sha256);
check('file: the receipt still names the source it came from', converted.ok === true && converted.source_sha256 === crypto.createHash('sha256').update(topDown32).digest('hex'));
check('file: a missing source is a named refusal, not a throw', convertCaptureFile({ sourcePath: path.join(scratch, 'nope.bmp'), targetPath: target }).code === 'capture_unreadable');
check('file: no half-written PNG is left behind on refusal', fs.readdirSync(scratch).filter((name) => name.endsWith('.tmp')).length === 0, fs.readdirSync(scratch).join(','));
fs.rmSync(scratch, { recursive: true, force: true });

/* ================================================================ wiring ===== */
const component = fs.readFileSync(COMPONENT, 'utf8');
const win32 = fs.readFileSync(WIN32, 'utf8');
check('wiring: computer_use and screen_capture both declare the format option', (component.match(/format: \{ type: 'string', enum: \['bmp', 'png'\]/g) || []).length === 2, String((component.match(/enum: \['bmp', 'png'\]/g) || []).length));
check('wiring: screen_capture passes the option to the backend', component.includes('format: args?.format,'));
check('wiring: the tool description tells the model the option exists', component.includes('format: \"png\"') && component.includes('image_format'));
check('wiring: the hidden lane imports the converter', win32.includes("from './image-format.js'"));
check('wiring: the conversion runs only when png was asked for', win32.includes('if (requested === \'png\') {') && win32.includes('requestedFormat(options.format)'));
check('wiring: the served mime follows the served bytes', win32.includes("imageMime = 'image/png'") && win32.includes("let imageMime = 'image/bmp'"));
check('wiring: the receipt reports requested vs served', win32.includes('image_format: imageFormat') && win32.includes('converted: false'));
check('wiring: a failed conversion keeps the BMP instead of inventing a path', win32.includes('error_code: converted.code') && win32.includes('imageFormat = { requested, served: '));

/* ================================================================ summary ===== */
const failed = checks.filter((entry) => entry.pass !== true);
for (const entry of checks) console.log((entry.pass ? 'ok   ' : 'not ok ') + entry.name + (entry.pass ? '' : '  [' + entry.detail + ']'));
console.log('');
console.log('image format: ' + (checks.length - failed.length) + '/' + checks.length + ' passed');
if (failed.length) {
  console.log('FAILED: ' + failed.map((entry) => entry.name).join('; '));
  process.exit(1);
}
console.log('PASS');
