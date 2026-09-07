import { ProviderResponseMetadata } from './provider-adapter';

/**
 * Header normalization and filtering. Only a safe allowlist of response
 * headers is preserved as metadata; credentials and private headers are
 * always dropped.
 */

const ALLOWED_HEADERS = new Set([
  'x-request-id',
  'request-id',
  'x-correlation-id',
  'x-amzn-requestid',
  'x-amzn-trace-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
  'retry-after-ms',
  'x-cache',
  'x-cache-status',
  'cf-cache-status',
  'x-vercel-cache',
]);

/** Native, cross-realm and custom transport Headers share the same get shape. */
export type ProviderHeaderInput = Headers | Record<string, string> | { get(name: string): string | null };

const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'proxy-authorization',
  'x-goog-api-key',
  'x-github-token',
]);

export function headerGet(
  headers: ProviderHeaderInput,
  name: string,
): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    try {
      const value: unknown = getter.call(headers, name.toLowerCase());
      if (typeof value === 'string') return value;
    } catch { /* A malformed custom container can still expose a plain record. */ }
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined || typeof record[key] !== 'string' ? null : record[key];
}

function nonNegativeNumber(value: string | null): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const numeric = Number(value.trim());
  return Number.isFinite(numeric) && numeric <= Number.MAX_SAFE_INTEGER ? numeric : undefined;
}

function validIso(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return '';
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function durationMilliseconds(value: string): number | undefined {
  const text = value.trim().toLowerCase();
  if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(text)) return undefined;
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  let duration = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) duration += Number(match[1]) * units[match[2]];
  return Number.isFinite(duration) && duration <= Number.MAX_SAFE_INTEGER ? duration : undefined;
}

function resetTime(value: string | null, kind: 'duration' | 'epoch' | 'date', now: number): string {
  if (value === null || !value.trim()) return '';
  const numeric = nonNegativeNumber(value);
  if (kind === 'duration') {
    const duration = durationMilliseconds(value) ?? (numeric === undefined ? undefined : numeric * 1000);
    return duration === undefined ? '' : validIso(now + duration);
  }
  if (kind === 'epoch' && numeric !== undefined) {
    // GitHub's x-ratelimit-reset is epoch seconds. Some compatible gateways
    // publish epoch milliseconds; neither format is a relative duration.
    return validIso(numeric >= 1e12 ? numeric : numeric * 1000);
  }
  if (numeric !== undefined || !/[A-Za-z]|\d[Tt]\d/.test(value)) return '';
  return validIso(Date.parse(value));
}

function retryAfterSeconds(headers: ProviderHeaderInput, now: number): number | undefined {
  // Matches the official OpenAI SDK's precedence for the nonstandard precise
  // millisecond extension. A real zero remains authoritative.
  const milliseconds = nonNegativeNumber(headerGet(headers, 'retry-after-ms'));
  if (milliseconds !== undefined) return milliseconds / 1000;
  const raw = headerGet(headers, 'retry-after');
  const seconds = nonNegativeNumber(raw);
  if (seconds !== undefined) return seconds;
  // Reject malformed numeric values instead of letting Date.parse interpret
  // values such as "-1" as an unrelated calendar date.
  if (!raw || !/[A-Za-z]/.test(raw)) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.ceil((parsed - now) / 1000)) : undefined;
}

export function normalizeProviderHeaders(
  headers: ProviderHeaderInput,
): ProviderResponseMetadata {
  const result: ProviderResponseMetadata = {};
  const now = Date.now();

  const requestId =
    headerGet(headers, 'x-request-id') ||
    headerGet(headers, 'request-id') ||
    headerGet(headers, 'x-correlation-id') ||
    headerGet(headers, 'x-amzn-requestid');
  if (requestId) result.requestId = requestId;

  const traceId = headerGet(headers, 'x-amzn-trace-id');
  if (traceId) result.traceId = traceId;

  const families = [
    ['x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'duration'],
    ['anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-requests-reset', 'date'],
    ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'epoch'],
    ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'duration'],
  ] as const;
  for (const [limitName, remainingName, resetName, resetKind] of families) {
    const limit = nonNegativeNumber(headerGet(headers, limitName));
    const remaining = nonNegativeNumber(headerGet(headers, remainingName));
    if (limit === undefined || remaining === undefined || !Number.isInteger(limit) || !Number.isInteger(remaining)) continue;
    result.rateLimit = { limit, remaining, resetAt: resetTime(headerGet(headers, resetName), resetKind, now) };
    break;
  }

  const retryAfter = retryAfterSeconds(headers, now);
  if (retryAfter !== undefined) result.retryAfterSeconds = retryAfter;

  const cacheStateRaw =
    headerGet(headers, 'x-cache-status') ||
    headerGet(headers, 'cf-cache-status') ||
    headerGet(headers, 'x-cache') ||
    headerGet(headers, 'x-vercel-cache');
  if (cacheStateRaw) {
    // This is HTTP/CDN cache metadata only. It cannot establish model token
    // cache usage or a prompt-cache hit ratio; those require response usage.
    const lower = cacheStateRaw.toLowerCase();
    result.cacheState = lower.includes('hit') ? 'hit' : lower.includes('miss') ? 'miss' : 'unknown';
  }

  return result;
}

/**
 * Filter a header record for request-side diagnostics: only explicitly allowed
 * non-sensitive fields are retained. Never returns cookies or credentials.
 */
export function filterRequestHeadersForDiagnostics(headers: ProviderHeaderInput): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers && typeof (headers as { get?: unknown }).get === 'function') {
    for (const key of ALLOWED_HEADERS) {
      const value = headerGet(headers, key);
      if (value !== null) out[key] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) continue;
    if (!ALLOWED_HEADERS.has(lower)) continue;
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
