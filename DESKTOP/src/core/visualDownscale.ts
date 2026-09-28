import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';
import { visualDataUrlBytes } from './conversationVisualBudget';

/**
 * dev-0.6.6: shrink a screenshot data URL until it fits the conversation's
 * visual budget.
 *
 * ComputerUse / BrowserControl observations are what blow up a long
 * conversation's heap; dropping vision entirely would degrade the agent, so the
 * budget is met by downscaling instead. PNG keeps its format while it fits at a
 * reasonable scale; once it cannot, the image is re-encoded as JPEG (much
 * smaller for screen content) so the model still receives the picture.
 */

interface DecodedImage {
  width: number;
  height: number;
  data: Buffer | Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
}

const MAX_SOURCE_PIXELS = 12 * 1024 * 1024;
const MIN_SCALE = 0.08;

function decodeDataUrl(dataUrl: string): DecodedImage | null {
  const match = /^data:(image\/(?:png|jpe?g));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(String(dataUrl || ''));
  if (!match) return null;
  const mimeType = /^image\/png$/i.test(match[1]) ? 'image/png' : 'image/jpeg';
  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  } catch {
    return null;
  }
  try {
    if (mimeType === 'image/png') {
      const decoded = PNG.sync.read(bytes);
      if (!decoded?.width || !decoded?.height) return null;
      if (decoded.width * decoded.height > MAX_SOURCE_PIXELS) return null;
      return { width: decoded.width, height: decoded.height, data: decoded.data, mimeType };
    }
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 24, maxMemoryUsageInMB: 192 });
    if (!decoded?.width || !decoded?.height) return null;
    if (decoded.width * decoded.height > MAX_SOURCE_PIXELS) return null;
    return { width: decoded.width, height: decoded.height, data: decoded.data, mimeType };
  } catch {
    return null;
  }
}

function resample(source: DecodedImage, scale: number): { width: number; height: number; data: Buffer } {
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const output = Buffer.alloc(width * height * 4);
  const sourceData = Buffer.isBuffer(source.data) ? source.data : Buffer.from(source.data);
  const xRatio = source.width / width;
  const yRatio = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor(y * yRatio));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor(x * xRatio));
      const from = (sourceY * source.width + sourceX) * 4;
      const to = (y * width + x) * 4;
      output[to] = sourceData[from];
      output[to + 1] = sourceData[from + 1];
      output[to + 2] = sourceData[from + 2];
      output[to + 3] = sourceData[from + 3];
    }
  }
  return { width, height, data: output };
}

function encodePng(frame: { width: number; height: number; data: Buffer }): string {
  const png = new PNG({ width: frame.width, height: frame.height });
  frame.data.copy(png.data);
  return `data:image/png;base64,${PNG.sync.write(png, { deflateLevel: 6, colorType: 6 }).toString('base64')}`;
}

function encodeJpeg(frame: { width: number; height: number; data: Buffer }, quality: number): string {
  const encoded = jpeg.encode({ data: frame.data, width: frame.width, height: frame.height }, quality);
  return `data:image/jpeg;base64,${Buffer.from(encoded.data).toString('base64')}`;
}

/**
 * Returns a data URL within `maxBytes`, or `null` when the input is not a
 * decodable image (callers keep their existing path-based fallback then).
 */
export function downscaleDataUrlToBytes(dataUrl: string, maxBytes: number): string | null {
  // No artificial floor: a severe budget may legitimately ask for a very small
  // image, and the caller decides what is usable.
  const limit = Math.max(1024, Math.floor(Number(maxBytes) || 0));
  if (!limit) return null;
  if (visualDataUrlBytes(dataUrl) <= limit) return dataUrl;
  const source = decodeDataUrl(dataUrl);
  if (!source) return null;
  // Density scales with the allowed pixel area for this budget, then the result
  // is verified by re-encoding (encoder overhead differs between formats).
  let scale = Math.min(1, Math.sqrt(limit / Math.max(1, visualDataUrlBytes(dataUrl))));
  for (let attempt = 0; attempt < 4 && scale >= MIN_SCALE; attempt += 1) {
    const frame = resample(source, scale);
    const asPng = encodePng(frame);
    if (visualDataUrlBytes(asPng) <= limit) return asPng;
    const asJpeg = encodeJpeg(frame, attempt === 0 ? 72 : 60);
    if (visualDataUrlBytes(asJpeg) <= limit) return asJpeg;
    scale *= 0.6;
  }
  // Last resort: a very small JPEG still gives the model a usable overview.
  const tiny = resample(source, MIN_SCALE);
  const encoded = encodeJpeg(tiny, 45);
  return visualDataUrlBytes(encoded) <= limit ? encoded : null;
}
