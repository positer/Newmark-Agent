import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { decodeInspectionImage } from './imageInspect';
import type { DisplayImageAttachment } from './types';

const MAX_DISPLAY_IMAGE_BYTES = 10 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MIME_EXTENSION: Record<DisplayImageAttachment['mimeType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

function inside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function assetPathFor(sha256: string, mimeType: DisplayImageAttachment['mimeType']): string {
  return ['conversation-media', 'display-images', sha256.slice(0, 2), `${sha256}.${MIME_EXTENSION[mimeType]}`].join('/');
}

function absoluteAssetPath(rootPath: string, sha256: string, mimeType: DisplayImageAttachment['mimeType']): string {
  return path.join(rootPath, ...assetPathFor(sha256, mimeType).split('/'));
}

function safeLabel(value: unknown, fallback: string): string {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .slice(0, 160);
  return cleaned || fallback;
}

function decodeFile(filePath: string): {
  bytes: Buffer;
  dataUrl: string;
  mimeType: DisplayImageAttachment['mimeType'];
  width: number;
  height: number;
} {
  const bytes = fs.readFileSync(filePath);
  if (!bytes.length || bytes.length > MAX_DISPLAY_IMAGE_BYTES) throw new Error('Display image must be between 1 byte and 10 MiB.');
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = extension === '.png' ? 'image/png' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : null;
  if (!mimeType) throw new Error('Only PNG and JPEG display images are supported.');
  const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
  const decoded = decodeInspectionImage(dataUrl);
  if (decoded.mimeType !== mimeType) throw new Error('Display image extension does not match its decoded content.');
  return { bytes, dataUrl, mimeType, width: decoded.width, height: decoded.height };
}

export interface WorkspaceImageObservation {
  path: string;
  name: string;
  byteLength: number;
  dataUrl: string;
  mimeType: DisplayImageAttachment['mimeType'];
  width: number;
  height: number;
}

export function readWorkspaceImageForVision(
  workspacePath: string,
  requestedPath: string,
): WorkspaceImageObservation {
  const workspace = fs.realpathSync(path.resolve(workspacePath));
  const candidate = path.resolve(workspace, String(requestedPath || '').trim());
  if (!inside(workspace, candidate)) throw new Error('Workspace images must stay inside the active workspace.');
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error(`Workspace image not found: ${requestedPath}`);
  const realCandidate = fs.realpathSync(candidate);
  if (!inside(workspace, realCandidate)) throw new Error('Workspace images must stay inside the active workspace.');
  const decoded = decodeFile(realCandidate);
  return {
    path: path.relative(workspace, realCandidate).split(path.sep).join('/'),
    name: path.basename(realCandidate),
    byteLength: decoded.bytes.length,
    dataUrl: decoded.dataUrl,
    mimeType: decoded.mimeType,
    width: decoded.width,
    height: decoded.height,
  };
}

function writeAsset(filePath: string, bytes: Buffer, sha256: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath);
    if (crypto.createHash('sha256').update(existing).digest('hex') !== sha256) throw new Error('Stored display image failed its integrity check.');
    return;
  }
  const temporary = path.join(path.dirname(filePath), `.${sha256}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    try { fs.renameSync(temporary, filePath); } catch (error) { if (!fs.existsSync(filePath)) throw error; }
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

export function persistWorkspaceDisplayImage(
  rootPath: string,
  workspacePath: string,
  requestedPath: string,
  caption = '',
  createdAt = new Date().toISOString(),
): DisplayImageAttachment {
  const source = readWorkspaceImageForVision(workspacePath, requestedPath);
  const realCandidate = path.resolve(fs.realpathSync(path.resolve(workspacePath)), ...source.path.split('/'));
  const decoded = {
    bytes: Buffer.from(source.dataUrl.slice(source.dataUrl.indexOf(',') + 1), 'base64'),
    dataUrl: source.dataUrl,
    mimeType: source.mimeType,
    width: source.width,
    height: source.height,
  };
  const sha256 = crypto.createHash('sha256').update(decoded.bytes).digest('hex');
  writeAsset(absoluteAssetPath(rootPath, sha256, decoded.mimeType), decoded.bytes, sha256);
  return {
    id: `display-image-${sha256}`,
    origin: 'agent',
    name: safeLabel(path.basename(realCandidate), `display-image.${MIME_EXTENSION[decoded.mimeType]}`),
    caption: safeLabel(caption, path.basename(realCandidate)),
    mimeType: decoded.mimeType,
    byteLength: decoded.bytes.length,
    width: decoded.width,
    height: decoded.height,
    sha256,
    assetPath: assetPathFor(sha256, decoded.mimeType),
    createdAt,
    dataUrl: decoded.dataUrl,
  };
}

export function hydrateDisplayImage(rootPath: string, input: unknown): DisplayImageAttachment | undefined {
  const item = input && typeof input === 'object' ? input as Partial<DisplayImageAttachment> : {};
  const sha256 = String(item.sha256 || '').toLowerCase();
  const mimeType = item.mimeType === 'image/png' ? 'image/png' : item.mimeType === 'image/jpeg' ? 'image/jpeg' : null;
  if (item.origin !== 'agent' || !HASH_PATTERN.test(sha256) || !mimeType || item.id !== `display-image-${sha256}`) return undefined;
  const filePath = absoluteAssetPath(rootPath, sha256, mimeType);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const decoded = decodeFile(filePath);
    if (decoded.mimeType !== mimeType || crypto.createHash('sha256').update(decoded.bytes).digest('hex') !== sha256) return undefined;
    return {
      id: `display-image-${sha256}`,
      origin: 'agent',
      name: safeLabel(item.name, `display-image.${MIME_EXTENSION[mimeType]}`),
      caption: safeLabel(item.caption, String(item.name || 'Display image')),
      mimeType,
      byteLength: decoded.bytes.length,
      width: decoded.width,
      height: decoded.height,
      sha256,
      assetPath: assetPathFor(sha256, mimeType),
      createdAt: String(item.createdAt || new Date().toISOString()),
      dataUrl: decoded.dataUrl,
    };
  } catch {
    return undefined;
  }
}

export function durableDisplayImage(input: DisplayImageAttachment | undefined): DisplayImageAttachment | undefined {
  if (!input) return undefined;
  const { dataUrl: _dataUrl, ...reference } = input;
  return reference;
}
