import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PdfPreviewCapability, PreviewResource } from './workspaceFileRouter';

const LOOPBACK_HOST = '127.0.0.1';

type RangeResult =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'invalid' };

export type PdfPreviewResolver = (token: string, ownerId: string) => Promise<PreviewResource | null>;

export interface PdfPreviewServerOptions {
  now?: () => number;
}

interface RegisteredCapability {
  ownerId: string;
  sourceFileName: string;
  urlFileName: string;
  expiresAt: number;
}

function parseSingleRange(value: string | string[] | undefined, size: number): RangeResult {
  if (value === undefined) return { kind: 'none' };
  if (Array.isArray(value)) return { kind: 'invalid' };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return { kind: 'invalid' };

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'invalid' };
    return { kind: 'range', start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
    || start < 0 || requestedEnd < start || start >= size) return { kind: 'invalid' };
  return { kind: 'range', start, end: Math.min(requestedEnd, size - 1) };
}

function inlineDisposition(filePath: string): string {
  const fileName = path.basename(filePath).replace(/[\r\n"]/g, '_') || 'preview.pdf';
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_');
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function status(response: http.ServerResponse, code: number, headers: Record<string, string> = {}): void {
  response.writeHead(code, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Length': '0',
    ...headers,
  });
  response.end();
}

export class PdfPreviewServer {
  private readonly secret = randomUUID().replace(/-/g, '');
  private readonly server: http.Server;
  private port = 0;
  private starting: Promise<void> | null = null;
  private readonly capabilities = new Map<string, RegisteredCapability>();
  private readonly now: () => number;

  constructor(private readonly resolveCapability: PdfPreviewResolver, options: PdfPreviewServerOptions = {}) {
    this.now = options.now || Date.now;
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.maxHeadersCount = 32;
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
  }

  async start(): Promise<void> {
    if (this.port) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('PDF preview server did not expose a TCP address'));
          return;
        }
        this.port = address.port;
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  urlFor(capability: PdfPreviewCapability, ownerIdValue: string): string {
    if (!this.port) throw new Error('PDF preview server is not running');
    const token = String(capability?.token || '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Invalid PDF preview capability');
    const ownerId = String(ownerIdValue || '').trim();
    if (!ownerId) throw new Error('PDF preview capability owner is required');
    const expiresAt = Number(capability.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error('PDF preview capability is expired');
    const sourceFileName = String(capability.fileName || '');
    if (!sourceFileName || sourceFileName !== path.basename(sourceFileName)
      || sourceFileName.includes('/') || sourceFileName.includes('\\') || /[\r\n]/.test(sourceFileName)) {
      throw new Error('Invalid PDF preview filename');
    }
    const urlFileName = sourceFileName.toLowerCase().endsWith('.pdf') ? sourceFileName : `${sourceFileName}.pdf`;
    const registered = this.capabilities.get(token);
    if (registered && (registered.ownerId !== ownerId
      || registered.sourceFileName !== sourceFileName || registered.urlFileName !== urlFileName
      || registered.expiresAt !== expiresAt)) {
      throw new Error('PDF preview capability is already bound to another owner or filename');
    }
    this.capabilities.set(token, { ownerId, sourceFileName, urlFileName, expiresAt });
    return `http://${LOOPBACK_HOST}:${this.port}/pdf/${this.secret}/${token}/${encodeURIComponent(urlFileName)}`;
  }

  revokeOwner(ownerIdValue: string): void {
    const ownerId = String(ownerIdValue || '');
    for (const [token, capability] of this.capabilities) {
      if (capability.ownerId === ownerId) this.capabilities.delete(token);
    }
  }

  revokeCapability(tokenValue: string, ownerIdValue: string): boolean {
    const token = String(tokenValue || '').toLowerCase();
    const ownerId = String(ownerIdValue || '');
    const capability = this.capabilities.get(token);
    if (!capability || capability.ownerId !== ownerId) return false;
    this.capabilities.delete(token);
    return true;
  }

  async close(): Promise<void> {
    if (!this.server.listening) {
      this.port = 0;
      this.capabilities.clear();
      return;
    }
    this.server.closeIdleConnections?.();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    this.port = 0;
    this.capabilities.clear();
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const expectedHost = `${LOOPBACK_HOST}:${this.port}`;
    if (request.headers.host !== expectedHost) {
      status(response, 421);
      return;
    }
    const method = String(request.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      status(response, 405, { Allow: 'GET, HEAD' });
      return;
    }

    let token = '';
    try {
      const url = new URL(request.url || '/', `http://${expectedHost}`);
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length !== 4 || segments[0] !== 'pdf' || segments[1] !== this.secret) {
        status(response, 404);
        return;
      }
      token = segments[2].toLowerCase();
      const requestedName = decodeURIComponent(segments[3]);
      let registered = this.capabilities.get(token);
      if (registered && registered.expiresAt <= this.now()) {
        this.capabilities.delete(token);
        registered = undefined;
      }
      if (!/^[a-f0-9]{32}$/.test(token) || !requestedName || requestedName === '.' || requestedName === '..'
        || requestedName.includes('/') || requestedName.includes('\\')
        || !registered || requestedName !== registered.urlFileName) {
        status(response, 404);
        return;
      }
    } catch {
      status(response, 404);
      return;
    }

    let resource: PreviewResource | null = null;
    try {
      const registered = this.capabilities.get(token);
      resource = registered ? await this.resolveCapability(token, registered.ownerId) : null;
    } catch {
      resource = null;
    }
    if (!resource || resource.mime !== 'application/pdf') {
      status(response, 404);
      return;
    }
    const registered = this.capabilities.get(token);
    if (!registered || registered.expiresAt <= this.now() || path.basename(resource.filePath) !== registered.sourceFileName) {
      if (registered?.expiresAt && registered.expiresAt <= this.now()) this.capabilities.delete(token);
      status(response, 404);
      return;
    }

    const range = parseSingleRange(request.headers.range, resource.size);
    if (range.kind === 'invalid') {
      status(response, 416, { 'Content-Range': `bytes */${resource.size}`, 'Accept-Ranges': 'bytes' });
      return;
    }
    const start = range.kind === 'range' ? range.start : 0;
    const end = range.kind === 'range' ? range.end : Math.max(0, resource.size - 1);
    const contentLength = resource.size ? end - start + 1 : 0;
    const headers: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Disposition': inlineDisposition(resource.filePath),
      'Content-Length': String(contentLength),
      'Content-Type': 'application/pdf',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    };
    if (range.kind === 'range') headers['Content-Range'] = `bytes ${start}-${end}/${resource.size}`;
    response.writeHead(range.kind === 'range' ? 206 : 200, headers);
    if (method === 'HEAD' || resource.size === 0) {
      response.end();
      return;
    }

    const stream = fs.createReadStream(resource.filePath, { start, end });
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  }
}
