import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { decodeInspectionImage } from './imageInspect';
import type { ConversationImageAttachment } from './types';

export interface SubmittedConversationImage {
  dataUrl: string;
  name?: string;
  type?: string;
}

export const MAX_USER_IMAGE_COUNT = 6;
export const MAX_USER_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_USER_IMAGE_TOTAL_BYTES = 30 * 1024 * 1024;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MIME_EXTENSION: Record<ConversationImageAttachment['mimeType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

function safeDisplayName(value: unknown, index: number, extension: string): string {
  const leaf = String(value || '').split(/[\\/]/).pop() || '';
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\.{2,}/g, '.')
    .trim()
    .slice(0, 120);
  return cleaned && cleaned !== '.' ? cleaned : `submitted-image-${index + 1}.${extension}`;
}

function canonicalAssetPath(sha256: string, mimeType: ConversationImageAttachment['mimeType']): string {
  return ['conversation-media', 'user-images', sha256.slice(0, 2), `${sha256}.${MIME_EXTENSION[mimeType]}`].join('/');
}

function absoluteAssetPath(rootPath: string, sha256: string, mimeType: ConversationImageAttachment['mimeType']): string {
  return path.join(rootPath, ...canonicalAssetPath(sha256, mimeType).split('/'));
}

function decodeSubmittedDataUrl(value: unknown): {
  bytes: Buffer;
  dataUrl: string;
  mimeType: ConversationImageAttachment['mimeType'];
  width: number;
  height: number;
} {
  const match = /^data:(image\/(?:png|jpe?g));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(String(value || '').trim());
  if (!match) throw new Error('Only base64 PNG and JPEG user images are supported.');
  const encoded = match[2];
  if (encoded.length % 4 !== 0 || encoded.length > Math.ceil(MAX_USER_IMAGE_BYTES / 3) * 4 + 4) {
    throw new Error('Submitted image exceeds the 10 MiB limit or has invalid base64.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_USER_IMAGE_BYTES
    || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('Submitted image exceeds the 10 MiB limit or has invalid base64.');
  }
  const declaredMime = /^image\/png$/i.test(match[1]) ? 'image/png' : 'image/jpeg';
  const canonicalDataUrl = `data:${declaredMime};base64,${bytes.toString('base64')}`;
  const decoded = decodeInspectionImage(canonicalDataUrl);
  if (decoded.mimeType !== declaredMime) throw new Error('Submitted image MIME does not match its decoded content.');
  return { bytes, dataUrl: canonicalDataUrl, mimeType: declaredMime, width: decoded.width, height: decoded.height };
}

function writeContentAddressedAsset(filePath: string, bytes: Buffer, sha256: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath);
    if (crypto.createHash('sha256').update(existing).digest('hex') !== sha256) {
      throw new Error('Stored user image failed its content-addressed integrity check.');
    }
    return;
  }
  const temporary = path.join(path.dirname(filePath), `.${sha256}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    try {
      fs.renameSync(temporary, filePath);
    } catch (error) {
      if (!fs.existsSync(filePath)) throw error;
    }
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

export function persistSubmittedConversationImages(
  rootPath: string,
  input: SubmittedConversationImage[] | null | undefined,
  createdAt = new Date().toISOString(),
): ConversationImageAttachment[] {
  const images = Array.isArray(input) ? input : [];
  if (images.length > MAX_USER_IMAGE_COUNT) throw new Error(`At most ${MAX_USER_IMAGE_COUNT} user images can be submitted at once.`);
  const attachments: ConversationImageAttachment[] = [];
  let totalBytes = 0;
  for (let index = 0; index < images.length; index += 1) {
    const decoded = decodeSubmittedDataUrl(images[index]?.dataUrl);
    const declaredType = String(images[index]?.type || '').trim().toLowerCase().replace('image/jpg', 'image/jpeg');
    if (declaredType && declaredType !== decoded.mimeType) throw new Error('Submitted image type does not match the data URL.');
    totalBytes += decoded.bytes.length;
    if (totalBytes > MAX_USER_IMAGE_TOTAL_BYTES) throw new Error('Submitted images exceed the 30 MiB total limit.');
    const sha256 = crypto.createHash('sha256').update(decoded.bytes).digest('hex');
    const assetPath = canonicalAssetPath(sha256, decoded.mimeType);
    writeContentAddressedAsset(absoluteAssetPath(rootPath, sha256, decoded.mimeType), decoded.bytes, sha256);
    attachments.push({
      id: `user-image-${sha256}`,
      origin: 'user',
      name: safeDisplayName(images[index]?.name, index, MIME_EXTENSION[decoded.mimeType]),
      mimeType: decoded.mimeType,
      byteLength: decoded.bytes.length,
      width: decoded.width,
      height: decoded.height,
      sha256,
      assetPath,
      createdAt,
      dataUrl: decoded.dataUrl,
    });
  }
  return attachments;
}

export function hydrateConversationImageAttachments(
  rootPath: string,
  input: ConversationImageAttachment[] | null | undefined,
): ConversationImageAttachment[] {
  const raw = Array.isArray(input) ? input.slice(0, MAX_USER_IMAGE_COUNT) : [];
  const hydrated: ConversationImageAttachment[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index] as ConversationImageAttachment;
    const sha256 = String(item?.sha256 || '').toLowerCase();
    const mimeType = item?.mimeType === 'image/png' ? 'image/png' : item?.mimeType === 'image/jpeg' ? 'image/jpeg' : null;
    if (item?.origin !== 'user' || !HASH_PATTERN.test(sha256) || !mimeType || item.id !== `user-image-${sha256}`) continue;
    const expectedAssetPath = canonicalAssetPath(sha256, mimeType);
    const filePath = absoluteAssetPath(rootPath, sha256, mimeType);
    let decoded: ReturnType<typeof decodeSubmittedDataUrl>;
    try {
      if (fs.existsSync(filePath)) {
        const bytes = fs.readFileSync(filePath);
        if (bytes.length > MAX_USER_IMAGE_BYTES || crypto.createHash('sha256').update(bytes).digest('hex') !== sha256) continue;
        decoded = decodeSubmittedDataUrl(`data:${mimeType};base64,${bytes.toString('base64')}`);
      } else {
        decoded = decodeSubmittedDataUrl(item.dataUrl);
        if (crypto.createHash('sha256').update(decoded.bytes).digest('hex') !== sha256) continue;
        writeContentAddressedAsset(filePath, decoded.bytes, sha256);
      }
    } catch {
      continue;
    }
    hydrated.push({
      id: `user-image-${sha256}`,
      origin: 'user',
      name: safeDisplayName(item.name, index, MIME_EXTENSION[mimeType]),
      mimeType,
      byteLength: decoded.bytes.length,
      width: decoded.width,
      height: decoded.height,
      sha256,
      assetPath: expectedAssetPath,
      createdAt: String(item.createdAt || new Date().toISOString()),
      dataUrl: decoded.dataUrl,
    });
  }
  return hydrated;
}

export function persistAttachmentsFromHistoryContent(rootPath: string, content: unknown): ConversationImageAttachment[] {
  if (!Array.isArray(content)) return [];
  const images = (content as Array<Record<string, unknown>>).flatMap((part, index) => {
    if (part?.type !== 'image_url' || !part.image_url || typeof part.image_url !== 'object') return [];
    const url = String((part.image_url as Record<string, unknown>).url || '');
    return url ? [{ dataUrl: url, name: `submitted-image-${index + 1}` }] : [];
  });
  return persistSubmittedConversationImages(rootPath, images);
}

export function archiveConversationImageAttachment(
  rootPath: string,
  archiveDir: string,
  input: ConversationImageAttachment,
): { relativePath: string; name: string } | null {
  const attachment = hydrateConversationImageAttachments(rootPath, [input])[0];
  if (!attachment?.dataUrl) return null;
  const extension = MIME_EXTENSION[attachment.mimeType];
  const relativePath = ['assets', 'user-images', `${attachment.sha256}.${extension}`].join('/');
  const destination = path.join(archiveDir, ...relativePath.split('/'));
  const bytes = Buffer.from(attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1), 'base64');
  writeContentAddressedAsset(destination, bytes, attachment.sha256);
  return { relativePath, name: attachment.name };
}
