import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';

export const FILE_HEADER_BYTES = 64 * 1024;
export const MAX_EDITOR_BYTES = 5 * 1024 * 1024;

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const SCRIPT_EXTENSIONS = new Set([
  '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.sh', '.bash', '.zsh', '.fish', '.ksh', '.csh',
  '.py', '.pyw', '.rb', '.pl', '.php', '.lua', '.tcl', '.r', '.groovy', '.js', '.jse', '.mjs',
  '.cjs', '.ts', '.tsx', '.jsx', '.vbs', '.vbe', '.wsf', '.wsh', '.command',
]);
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.com', '.msi', '.msp', '.msix', '.msixbundle', '.appx', '.appxbundle', '.lnk', '.url',
  '.appref-ms', '.scr', '.cpl', '.gadget', '.reg', '.scf', '.application', '.hta', '.jar', '.apk',
  '.deb', '.rpm', '.pkg', '.dmg', '.appimage', '.desktop',
]);

export type TextEncoding =
  | 'utf8'
  | 'utf8-bom'
  | 'utf16le'
  | 'utf16be'
  | 'utf16le-nobom'
  | 'utf16be-nobom';

export type WorkspaceFileOpenResult =
  | {
      kind: 'editor';
      path: string;
      content: string;
      encoding: TextEncoding;
      size: number;
      token: string;
      revision: string;
    }
  | { kind: 'browser'; path: string; size: number; mime: 'application/pdf' | 'text/html'; url: string }
  | { kind: 'external'; path: string; size: number; reason: 'binary' | 'too-large' }
  | { kind: 'reveal'; path: string; size: number; reason: 'executable' | 'script-too-large' | 'script-non-text' }
  | { kind: 'rejected'; error: string };

export type WorkspaceFileSaveResult =
  | { ok: true; revision: string; size: number; token: string }
  | { ok: false; error: string; conflict?: boolean };

interface EditTokenRecord {
  token: string;
  ownerId: string;
  workspaceRoot: string;
  realWorkspaceRoot: string;
  filePath: string;
  realFilePath: string;
  encoding: TextEncoding;
  revision: string;
  device: bigint;
  inode: bigint;
  expiresAt: number;
}

interface PreviewTokenRecord {
  token: string;
  ownerId: string;
  workspaceRoot: string;
  realWorkspaceRoot: string;
  entryFilePath: string;
  entryMime: 'application/pdf' | 'text/html';
  allowRelativeResources: boolean;
  expiresAt: number;
}

interface TextProbe {
  encoding: TextEncoding;
  text: string;
}

export interface PreviewResource {
  filePath: string;
  mime: string;
  size: number;
  range?: { start: number; end: number };
}

function normalizeForComparison(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const root = normalizeForComparison(rootPath);
  const candidate = normalizeForComparison(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasPrefix(buffer: Buffer, prefix: number[]): boolean {
  return prefix.every((value, index) => buffer[index] === value);
}

function looksExecutable(buffer: Buffer, extension: string): boolean {
  if (hasPrefix(buffer, [0x4d, 0x5a])) return true; // PE / DOS executable.
  if (hasPrefix(buffer, [0x7f, 0x45, 0x4c, 0x46])) return true; // ELF.
  if (hasPrefix(buffer, [0xfe, 0xed, 0xfa, 0xce]) || hasPrefix(buffer, [0xce, 0xfa, 0xed, 0xfe])) return true;
  if (hasPrefix(buffer, [0xfe, 0xed, 0xfa, 0xcf]) || hasPrefix(buffer, [0xcf, 0xfa, 0xed, 0xfe])) return true;
  if (hasPrefix(buffer, [0xca, 0xfe, 0xba, 0xbe])) return true;
  if (hasPrefix(buffer, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])) return true; // Windows shortcut.
  if ((extension === '.msi' || extension === '.msp') && hasPrefix(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return true;
  return EXECUTABLE_EXTENSIONS.has(extension);
}

function looksScript(buffer: Buffer, extension: string): boolean {
  return SCRIPT_EXTENSIONS.has(extension) || hasPrefix(buffer, [0x23, 0x21]);
}

function looksPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 1024)).includes(Buffer.from('%PDF-', 'ascii'));
}

function swapUtf16Bytes(buffer: Buffer): Buffer {
  const evenLength = buffer.length - (buffer.length % 2);
  const swapped = Buffer.allocUnsafe(evenLength);
  for (let i = 0; i < evenLength; i += 2) {
    swapped[i] = buffer[i + 1];
    swapped[i + 1] = buffer[i];
  }
  return swapped;
}

function hasSuspiciousControls(text: string): boolean {
  if (!text) return false;
  let controls = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0) return true;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) || code === 0x7f) controls++;
  }
  return controls / text.length > 0.02;
}

function decodeUtf8(buffer: Buffer, streaming: boolean): string | null {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return decoder.decode(buffer, { stream: streaming });
  } catch {
    return null;
  }
}

function utf16Heuristic(buffer: Buffer): 'utf16le-nobom' | 'utf16be-nobom' | null {
  if (buffer.length < 4) return null;
  const sampleLength = Math.min(buffer.length - (buffer.length % 2), 4096);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < sampleLength; i += 2) {
    if (buffer[i] === 0) evenZeros++;
    if (buffer[i + 1] === 0) oddZeros++;
  }
  const pairs = sampleLength / 2;
  if (oddZeros / pairs > 0.3 && evenZeros / pairs < 0.05) return 'utf16le-nobom';
  if (evenZeros / pairs > 0.3 && oddZeros / pairs < 0.05) return 'utf16be-nobom';
  return null;
}

export function probeText(buffer: Buffer, streaming = false): TextProbe | null {
  let encoding: TextEncoding = 'utf8';
  let text: string | null = null;
  if (hasPrefix(buffer, [0xef, 0xbb, 0xbf])) {
    encoding = 'utf8-bom';
    text = decodeUtf8(buffer.subarray(3), streaming);
  } else if (hasPrefix(buffer, [0xff, 0xfe])) {
    if (!streaming && (buffer.length - 2) % 2 !== 0) return null;
    encoding = 'utf16le';
    text = buffer.subarray(2, buffer.length - ((buffer.length - 2) % 2)).toString('utf16le');
  } else if (hasPrefix(buffer, [0xfe, 0xff])) {
    if (!streaming && (buffer.length - 2) % 2 !== 0) return null;
    encoding = 'utf16be';
    text = swapUtf16Bytes(buffer.subarray(2)).toString('utf16le');
  } else {
    const heuristic = utf16Heuristic(buffer);
    if (heuristic === 'utf16le-nobom') {
      if (!streaming && buffer.length % 2 !== 0) return null;
      encoding = heuristic;
      text = buffer.subarray(0, buffer.length - (buffer.length % 2)).toString('utf16le');
    } else if (heuristic === 'utf16be-nobom') {
      if (!streaming && buffer.length % 2 !== 0) return null;
      encoding = heuristic;
      text = swapUtf16Bytes(buffer).toString('utf16le');
    } else {
      text = decodeUtf8(buffer, streaming);
    }
  }
  if (text === null || hasSuspiciousControls(text)) return null;
  return { encoding, text };
}

function encodeText(content: string, encoding: TextEncoding): Buffer {
  if (encoding === 'utf8') return Buffer.from(content, 'utf8');
  if (encoding === 'utf8-bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]);
  const littleEndian = Buffer.from(content, 'utf16le');
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]);
  if (encoding === 'utf16le-nobom') return littleEndian;
  const bigEndian = swapUtf16Bytes(littleEndian);
  return encoding === 'utf16be' ? Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]) : bigEndian;
}

function looksHtml(text: string, extension: string): boolean {
  if (extension === '.html' || extension === '.htm' || extension === '.xhtml') return true;
  const start = text.replace(/^\uFEFF/, '').trimStart().slice(0, 4096);
  return /^(?:<!doctype\s+html\b|<html\b)/i.test(start);
}

function mimeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': case '.htm': case '.xhtml': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': case '.mjs': case '.cjs': return 'text/javascript; charset=utf-8';
    case '.json': case '.map': return 'application/json; charset=utf-8';
    case '.pdf': return 'application/pdf';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.xml': return 'application/xml; charset=utf-8';
    case '.txt': case '.md': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function parseRange(value: string | null, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value || '').trim());
  if (!match || size <= 0) return null;
  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : NaN;
  if (!Number.isFinite(start) && Number.isFinite(end)) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    if (!Number.isFinite(start)) return null;
    if (!Number.isFinite(end)) end = size - 1;
  }
  start = Math.max(0, Math.floor(start));
  end = Math.min(size - 1, Math.floor(end));
  return start <= end && start < size ? { start, end } : null;
}

export class WorkspaceFileRouter {
  private readonly editTokens = new Map<string, EditTokenRecord>();
  private readonly previewTokens = new Map<string, PreviewTokenRecord>();

  constructor(private readonly workspaceRoot: () => string) {}

  private purgeExpiredTokens(): void {
    const now = Date.now();
    for (const [token, record] of this.editTokens) if (record.expiresAt <= now) this.editTokens.delete(token);
    for (const [token, record] of this.previewTokens) if (record.expiresAt <= now) this.previewTokens.delete(token);
  }

  private async resolveWorkspaceTarget(targetPath: string): Promise<{
    workspaceRoot: string;
    realWorkspaceRoot: string;
    filePath: string;
    realFilePath: string;
    stat: fs.Stats;
  }> {
    const workspaceRoot = path.resolve(this.workspaceRoot());
    const filePath = path.resolve(workspaceRoot, String(targetPath || ''));
    if (!isPathInside(workspaceRoot, filePath)) throw new Error('File path is outside the active workspace');
    const [realWorkspaceRoot, realFilePath] = await Promise.all([
      fs.promises.realpath(workspaceRoot),
      fs.promises.realpath(filePath),
    ]);
    if (!isPathInside(realWorkspaceRoot, realFilePath)) throw new Error('Linked file path is outside the active workspace');
    const stat = await fs.promises.stat(realFilePath);
    if (!stat.isFile()) throw new Error('Path is not a file');
    return { workspaceRoot, realWorkspaceRoot, filePath, realFilePath, stat };
  }

  private issuePreviewToken(
    ownerId: string,
    workspaceRoot: string,
    realWorkspaceRoot: string,
    realFilePath: string,
    entryMime: 'application/pdf' | 'text/html',
    allowRelativeResources: boolean,
  ): string {
    const token = randomUUID().replace(/-/g, '');
    this.previewTokens.set(token, {
      token,
      ownerId,
      workspaceRoot,
      realWorkspaceRoot,
      entryFilePath: realFilePath,
      entryMime,
      allowRelativeResources,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    const relative = path.relative(realWorkspaceRoot, realFilePath).split(path.sep).map(encodeURIComponent).join('/');
    return `newmark-preview://${token}/${relative}`;
  }

  async open(targetPath: string, ownerId: string): Promise<WorkspaceFileOpenResult> {
    this.purgeExpiredTokens();
    try {
      const resolved = await this.resolveWorkspaceTarget(targetPath);
      const extension = path.extname(resolved.filePath).toLowerCase();
      const headerSize = Math.min(resolved.stat.size, FILE_HEADER_BYTES);
      const handle = await fs.promises.open(resolved.realFilePath, 'r');
      let header: Buffer;
      try {
        header = Buffer.alloc(headerSize);
        if (headerSize) await handle.read(header, 0, headerSize, 0);
      } finally {
        await handle.close();
      }

      if (looksExecutable(header, extension)) {
        return { kind: 'reveal', path: resolved.realFilePath, size: resolved.stat.size, reason: 'executable' };
      }
      if (looksPdf(header)) {
        return {
          kind: 'browser',
          path: resolved.realFilePath,
          size: resolved.stat.size,
          mime: 'application/pdf',
          url: this.issuePreviewToken(ownerId, resolved.workspaceRoot, resolved.realWorkspaceRoot, resolved.realFilePath, 'application/pdf', false),
        };
      }

      const headerProbe = probeText(header, resolved.stat.size > header.length);
      const script = looksScript(header, extension);
      if (script && !headerProbe) {
        return { kind: 'reveal', path: resolved.realFilePath, size: resolved.stat.size, reason: 'script-non-text' };
      }
      if (script && resolved.stat.size > MAX_EDITOR_BYTES) {
        return { kind: 'reveal', path: resolved.realFilePath, size: resolved.stat.size, reason: 'script-too-large' };
      }
      if (headerProbe && looksHtml(headerProbe.text, extension)) {
        return {
          kind: 'browser',
          path: resolved.realFilePath,
          size: resolved.stat.size,
          mime: 'text/html',
          url: this.issuePreviewToken(ownerId, resolved.workspaceRoot, resolved.realWorkspaceRoot, resolved.realFilePath, 'text/html', true),
        };
      }
      if (!headerProbe) {
        return { kind: 'external', path: resolved.realFilePath, size: resolved.stat.size, reason: 'binary' };
      }
      if (resolved.stat.size > MAX_EDITOR_BYTES) {
        return { kind: 'external', path: resolved.realFilePath, size: resolved.stat.size, reason: 'too-large' };
      }

      const contentHandle = await fs.promises.open(resolved.realFilePath, 'r');
      let contentBuffer: Buffer;
      let identity: fs.BigIntStats;
      try {
        identity = await contentHandle.stat({ bigint: true });
        if (identity.size > BigInt(MAX_EDITOR_BYTES)) {
          return script
            ? { kind: 'reveal', path: resolved.realFilePath, size: Number(identity.size), reason: 'script-too-large' }
            : { kind: 'external', path: resolved.realFilePath, size: Number(identity.size), reason: 'too-large' };
        }
        contentBuffer = await contentHandle.readFile();
      } finally {
        await contentHandle.close();
      }
      const fullProbe = probeText(contentBuffer, false);
      if (!fullProbe) {
        return script
          ? { kind: 'reveal', path: resolved.realFilePath, size: resolved.stat.size, reason: 'script-non-text' }
          : { kind: 'external', path: resolved.realFilePath, size: resolved.stat.size, reason: 'binary' };
      }
      const token = randomUUID();
      const revision = hashBuffer(contentBuffer);
      this.editTokens.set(token, {
        token,
        ownerId,
        workspaceRoot: resolved.workspaceRoot,
        realWorkspaceRoot: resolved.realWorkspaceRoot,
        filePath: resolved.filePath,
        realFilePath: resolved.realFilePath,
        encoding: fullProbe.encoding,
        revision,
        device: identity.dev,
        inode: identity.ino,
        expiresAt: Date.now() + TOKEN_TTL_MS,
      });
      return {
        kind: 'editor',
        path: resolved.filePath,
        content: fullProbe.text,
        encoding: fullProbe.encoding,
        size: contentBuffer.length,
        token,
        revision,
      };
    } catch (error) {
      return { kind: 'rejected', error: error instanceof Error ? error.message : String(error) };
    }
  }

  async save(token: string, content: string, expectedRevision: string, ownerId: string): Promise<WorkspaceFileSaveResult> {
    this.purgeExpiredTokens();
    const record = this.editTokens.get(String(token || ''));
    if (!record || record.ownerId !== ownerId) return { ok: false, error: 'Editor token is invalid or expired' };
    if (record.revision !== String(expectedRevision || '')) return { ok: false, error: 'Editor revision is stale', conflict: true };
    try {
      const currentWorkspaceRoot = path.resolve(this.workspaceRoot());
      const currentRealWorkspaceRoot = await fs.promises.realpath(currentWorkspaceRoot);
      if (normalizeForComparison(currentRealWorkspaceRoot) !== normalizeForComparison(record.realWorkspaceRoot)) {
        return { ok: false, error: 'Active workspace changed' };
      }
      const currentRealFilePath = await fs.promises.realpath(record.filePath);
      if (normalizeForComparison(currentRealFilePath) !== normalizeForComparison(record.realFilePath)
        || !isPathInside(currentRealWorkspaceRoot, currentRealFilePath)) {
        return { ok: false, error: 'File link target changed' };
      }
      const nextBuffer = encodeText(String(content ?? ''), record.encoding);
      if (nextBuffer.length > MAX_EDITOR_BYTES) return { ok: false, error: 'Editor content exceeds the 5 MiB limit' };

      const handle = await fs.promises.open(record.realFilePath, 'r+');
      try {
        const currentStat = await handle.stat({ bigint: true });
        if (currentStat.dev !== record.device || currentStat.ino !== record.inode) {
          return { ok: false, error: 'File identity changed', conflict: true };
        }
        if (currentStat.size > BigInt(MAX_EDITOR_BYTES)) {
          return { ok: false, error: 'File changed on disk and now exceeds the 5 MiB limit', conflict: true };
        }
        const currentBuffer = await handle.readFile();
        if (hashBuffer(currentBuffer) !== record.revision) {
          return { ok: false, error: 'File changed on disk', conflict: true };
        }
        await handle.truncate(0);
        let offset = 0;
        while (offset < nextBuffer.length) {
          const { bytesWritten } = await handle.write(nextBuffer, offset, nextBuffer.length - offset, offset);
          if (bytesWritten <= 0) throw new Error('Unable to write the complete file');
          offset += bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      record.revision = hashBuffer(nextBuffer);
      record.expiresAt = Date.now() + TOKEN_TTL_MS;
      return { ok: true, revision: record.revision, size: nextBuffer.length, token: record.token };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async resolvePreview(urlValue: string, rangeHeader?: string | null): Promise<PreviewResource | null> {
    this.purgeExpiredTokens();
    try {
      const url = new URL(urlValue);
      if (url.protocol !== 'newmark-preview:') return null;
      const token = url.hostname.toLowerCase();
      const record = this.previewTokens.get(token);
      if (!record) return null;
      const currentRealWorkspaceRoot = await fs.promises.realpath(path.resolve(this.workspaceRoot()));
      if (normalizeForComparison(currentRealWorkspaceRoot) !== normalizeForComparison(record.realWorkspaceRoot)) return null;
      const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const candidate = path.resolve(record.realWorkspaceRoot, ...relative.split('/'));
      if (!isPathInside(record.realWorkspaceRoot, candidate)) return null;
      const realCandidate = await fs.promises.realpath(candidate);
      if (!isPathInside(record.realWorkspaceRoot, realCandidate)) return null;
      if (!record.allowRelativeResources && normalizeForComparison(realCandidate) !== normalizeForComparison(record.entryFilePath)) return null;
      const stat = await fs.promises.stat(realCandidate);
      if (!stat.isFile()) return null;
      return {
        filePath: realCandidate,
        mime: normalizeForComparison(realCandidate) === normalizeForComparison(record.entryFilePath)
          ? record.entryMime
          : mimeForPath(realCandidate),
        size: stat.size,
        range: parseRange(rangeHeader || null, stat.size) || undefined,
      };
    } catch {
      return null;
    }
  }

  revokeOwner(ownerId: string): void {
    for (const [token, record] of this.editTokens) if (record.ownerId === ownerId) this.editTokens.delete(token);
    for (const [token, record] of this.previewTokens) if (record.ownerId === ownerId) this.previewTokens.delete(token);
  }
}

export function setPreviewSecurityHeaders(headers: Record<string, string>, resource: PreviewResource): void {
  if (!resource.mime.startsWith('text/html')) return;
  headers['Content-Security-Policy'] = [
    "default-src 'self' data: blob: https: http:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: http:",
    "style-src 'self' 'unsafe-inline' data: blob: https: http:",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data: blob: https: http:",
    "connect-src 'self' https: http: ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

export async function previewResponse(resource: PreviewResource | null, method = 'GET'): Promise<Response> {
  if (!resource) return new Response('Preview resource not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const range = resource.range;
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, resource.size - 1);
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': resource.mime,
    'Content-Length': String(resource.size ? end - start + 1 : 0),
    'X-Content-Type-Options': 'nosniff',
  });
  const securityHeaders: Record<string, string> = {};
  setPreviewSecurityHeaders(securityHeaders, resource);
  for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${resource.size}`);
  if (method.toUpperCase() === 'HEAD' || resource.size === 0) {
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  const stream = fs.createReadStream(resource.filePath, { start, end });
  return new Response(Readable.toWeb(stream) as unknown as BodyInit, { status: range ? 206 : 200, headers });
}
