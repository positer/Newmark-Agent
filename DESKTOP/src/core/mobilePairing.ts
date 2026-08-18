import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import * as QRCode from 'qrcode';

export const MOBILE_TOKEN_FILENAME = '.newmark-mobile-token';
export const MOBILE_PAIRING_FILENAME = '.newmark-mobile-pairing.json';
export const MOBILE_PORT = 47890;
export const MOBILE_PAIRING_TTL_MS = 120_000;

export interface PairingSession {
  pairingId: string;
  token: string;
  host: string;
  hostname: string;
  port: number;
  issuedAt: number;
  expiresAt: number;
  url: string;
  confirmed?: boolean;
  confirmedAt?: number;
}

export interface PairingStatus {
  pairingId: string;
  issuedAt: number;
  expiresAt: number;
  confirmed: boolean;
  confirmedAt: number;
  active: boolean;
  expired: boolean;
}

function pairingStatePath(root: string): string {
  return path.join(root, MOBILE_PAIRING_FILENAME);
}

function readPairingState(root: string): PairingSession | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pairingStatePath(root), 'utf-8'));
    if (!parsed || !parsed.pairingId || !parsed.token) return null;
    return parsed as PairingSession;
  } catch {
    return null;
  }
}

function writePairingState(root: string, state: PairingSession): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(pairingStatePath(root), JSON.stringify(state, null, 2), 'utf-8');
}

export function ensureMobileToken(root: string): string {
  const tokenPath = path.join(root, MOBILE_TOKEN_FILENAME);
  try {
    const existing = fs.readFileSync(tokenPath, 'utf-8').replace(/\s+/g, '').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // first start: no token file yet
  }
  const generated = randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // keep the generated token for this process even if persistence fails
  }
  return generated;
}

export function tailscaleIpv4(): string | null {
  const exe = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale';
  try {
    const result = spawnSync(exe, ['ip', '-4'], { encoding: 'utf-8', windowsHide: true, timeout: 3000 });
    if (result.error || result.status !== 0) return null;
    const lines = String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return lines[0] || null;
  } catch {
    return null;
  }
}

export function lanIpv4(): string | null {
  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(info.address)) candidates.push(info.address);
    }
  }
  return candidates.sort()[0] || null;
}

export function pairingHost(): string {
  return tailscaleIpv4() || lanIpv4() || '127.0.0.1';
}

function buildPairingUrl(session: PairingSession): string {
  const query = new URLSearchParams({
    token: session.token,
    host: session.hostname,
    port: String(session.port),
    pairingId: session.pairingId,
    issuedAt: String(session.issuedAt),
    expiresAt: String(session.expiresAt),
  });
  return `newmark-pair://${session.host}:${session.port}?${query.toString()}`;
}

export function createPairingSession(root: string, ttlMs: number = MOBILE_PAIRING_TTL_MS): PairingSession {
  const token = ensureMobileToken(root);
  const host = pairingHost();
  const now = Date.now();
  const session: PairingSession = {
    pairingId: randomBytes(12).toString('hex'),
    token,
    host,
    hostname: os.hostname(),
    port: MOBILE_PORT,
    issuedAt: now,
    expiresAt: now + Math.max(1000, Number(ttlMs) || MOBILE_PAIRING_TTL_MS),
    url: '',
    confirmed: false,
    confirmedAt: 0,
  };
  session.url = buildPairingUrl(session);
  writePairingState(root, session);
  return session;
}

export function pairingUrl(root: string): string {
  return createPairingSession(root).url;
}

export function pairingTokenPath(root: string): string {
  return path.join(root, MOBILE_TOKEN_FILENAME);
}

export function pairingStatus(root: string): PairingStatus {
  const state = readPairingState(root);
  if (!state) {
    return { pairingId: '', issuedAt: 0, expiresAt: 0, confirmed: false, confirmedAt: 0, active: false, expired: true };
  }
  const now = Date.now();
  const confirmed = state.confirmed === true;
  const expired = now >= Number(state.expiresAt || 0);
  return {
    pairingId: state.pairingId,
    issuedAt: Number(state.issuedAt || 0),
    expiresAt: Number(state.expiresAt || 0),
    confirmed,
    confirmedAt: Number(state.confirmedAt || 0),
    active: !confirmed && !expired,
    expired: !confirmed && expired,
  };
}

export function confirmPairing(root: string, pairingId: string, token: string): { ok: boolean; error?: string; status: PairingStatus } {
  const state = readPairingState(root);
  const status = pairingStatus(root);
  if (!state || !state.pairingId) {
    return { ok: false, error: 'No pairing window is active.', status };
  }
  if (state.token !== token) {
    return { ok: false, error: 'Pairing token does not match.', status };
  }
  if (state.pairingId !== pairingId) {
    return { ok: false, error: 'Pairing window is stale.', status };
  }
  if (status.expired) {
    return { ok: false, error: 'Pairing window expired.', status };
  }
  if (status.confirmed) {
    return { ok: true, status };
  }
  const updated = { ...state, confirmed: true, confirmedAt: Date.now() };
  writePairingState(root, updated);
  return { ok: true, status: pairingStatus(root) };
}

export async function pairingQrDataUrl(root: string, ttlMs?: number): Promise<{ dataUrl: string; session: PairingSession }> {
  const session = createPairingSession(root, ttlMs);
  const dataUrl = await QRCode.toDataURL(session.url, {
    width: 420,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#101828', light: '#FFFFFF' },
  });
  return { dataUrl, session };
}

export async function pairingQrAscii(root: string, ttlMs?: number): Promise<{ ascii: string; session: PairingSession }> {
  const session = createPairingSession(root, ttlMs);
  const ascii = await QRCode.toString(session.url, {
    type: 'terminal',
    small: true,
    errorCorrectionLevel: 'M',
  });
  return { ascii, session };
}
