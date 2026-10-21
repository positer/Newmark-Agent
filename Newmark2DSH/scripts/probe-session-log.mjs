// Read-only probe: decompress EVERY zstd frame of a DSH session log.
//
// DSH's session persistence appends one independently decodable, checksummed
// zstd frame per flush (see @deepseek-ai/dsh-session-persistence-jsonl
// `scanZstdFrames`), so `zstdDecompressSync(buffer)` — which decodes the first
// frame only — silently truncates the log to its header line. This script walks
// frames the same way the harness does and concatenates every decoded payload.
//
// Usage:
//   node probe-session-log.mjs <session.v4.jsonl.zstd> [headLines] [tailLines]
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

const [, , file, headArg, tailArg] = process.argv;
const head = Number(headArg ?? 0);
const tail = Number(tailArg ?? 12);

const buf = readFileSync(file);
const { frames, tornStart } = scanZstdFrames(buf);
const parts = [];
for (const frame of frames) {
  parts.push(zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)));
}
const text = Buffer.concat(parts).toString('utf8');
const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
console.log(
  JSON.stringify(
    {
      file,
      compressedBytes: buf.length,
      frames: frames.length,
      tornStart: tornStart ?? null,
      decompressedBytes: text.length,
      lines: lines.length,
    },
    null,
    2,
  ),
);
const wants = [];
if (head > 0) for (let i = 0; i < Math.min(head, lines.length); i++) wants.push(i);
if (tail > 0) for (let i = Math.max(0, lines.length - tail); i < lines.length; i++) wants.push(i);
for (const i of [...new Set(wants)]) {
  const line = lines[i];
  console.log(`--- line ${i}`);
  console.log(line.length > 1400 ? `${line.slice(0, 1400)} …[${line.length} chars]` : line);
}
