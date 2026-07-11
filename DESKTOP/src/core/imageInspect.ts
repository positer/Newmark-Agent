import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';

export interface DecodedInspectionImage {
  width: number;
  height: number;
  data: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
}

const MAX_INPUT_PIXELS = 40_000_000;
const MAX_OUTPUT_SIDE = 2048;

export function decodeInspectionImage(dataUrl: string): DecodedInspectionImage {
  const match = /^data:(image\/(?:png|jpe?g));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(dataUrl);
  if (!match) throw new Error('Only base64 PNG and JPEG submitted images are supported.');
  const encoded = match[2].replace(/\s/g, '');
  if (encoded.length > 32 * 1024 * 1024) throw new Error('Submitted image exceeds the 24 MiB inspection limit.');
  const bytes = Buffer.from(encoded, 'base64');
  const mimeType = /^image\/png$/i.test(match[1]) ? 'image/png' : 'image/jpeg';
  const decoded = mimeType === 'image/png'
    ? PNG.sync.read(bytes, { skipRescale: false })
    : jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 });
  const width = Number(decoded.width || 0);
  const height = Number(decoded.height || 0);
  if (!width || !height || width * height > MAX_INPUT_PIXELS) throw new Error('Decoded image exceeds the 40 megapixel inspection limit.');
  return { width, height, data: decoded.data, mimeType };
}

export function cropAndMagnifyImage(
  source: DecodedInspectionImage,
  crop: { x: number; y: number; width: number; height: number },
  requestedScale: number,
): { dataUrl: string; width: number; height: number; scale: number } {
  const { x, y, width, height } = crop;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < 1 || height < 1) {
    throw new Error('crop requires finite x/y >= 0 and width/height >= 1 in source pixels.');
  }
  if (x + width > source.width || y + height > source.height) {
    throw new Error(`Crop (${x},${y},${width},${height}) exceeds source bounds ${source.width}x${source.height}.`);
  }
  const safeScale = Math.min(4, Math.max(1, Number.isFinite(requestedScale) ? requestedScale : 2));
  const scale = Math.min(safeScale, MAX_OUTPUT_SIDE / width, MAX_OUTPUT_SIDE / height);
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  const output = Buffer.allocUnsafe(outputWidth * outputHeight * 4);
  for (let outY = 0; outY < outputHeight; outY += 1) {
    const sourceY = Math.min(y + height - 1, Math.max(y, y + ((outY + 0.5) / outputHeight) * height - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(y + height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let outX = 0; outX < outputWidth; outX += 1) {
      const sourceX = Math.min(x + width - 1, Math.max(x, x + ((outX + 0.5) / outputWidth) * width - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(x + width - 1, x0 + 1);
      const fx = sourceX - x0;
      const target = (outY * outputWidth + outX) * 4;
      const p00 = (y0 * source.width + x0) * 4;
      const p10 = (y0 * source.width + x1) * 4;
      const p01 = (y1 * source.width + x0) * 4;
      const p11 = (y1 * source.width + x1) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = source.data[p00 + channel] * (1 - fx) + source.data[p10 + channel] * fx;
        const bottom = source.data[p01 + channel] * (1 - fx) + source.data[p11 + channel] * fx;
        output[target + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  const encoded = new PNG({ width: outputWidth, height: outputHeight, colorType: 6 });
  encoded.data = output;
  const png = PNG.sync.write(encoded);
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: outputWidth, height: outputHeight, scale };
}
