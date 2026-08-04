import { ProviderResponseMetadata } from './provider-adapter';

/**
 * Header normalization and filtering. Only a safe allowlist of response
 * headers is preserved as metadata; credentials and private headers are
 * always dropped.
 */

const ALLOWED_HEADERS = new Set([
  'x-request-id',
  'request-id',
  'x-request-id',
  'x-correlation-id',
  'x-amzn-requestid',
  'x-amzn-trace-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
  'x-cache',
  'x-cache-status',
  'cf-cache-status',
  'x-vercel-cache',
]);

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
  headers: Headers | Record<string, string>,
  name: string,
): string | null {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name);
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : record[key];
}

export function normalizeProviderHeaders(
  headers: Headers | Record<string, string>,
): ProviderResponseMetadata {
  const result: ProviderResponseMetadata = {};

  const requestId =
    headerGet(headers, 'x-request-id') ||
    headerGet(headers, 'request-id') ||
    headerGet(headers, 'x-correlation-id') ||
    headerGet(headers, 'x-amzn-requestid');
  if (requestId) result.requestId = requestId;

  const traceId = headerGet(headers, 'x-amzn-trace-id');
  if (traceId) result.traceId = traceId;

  const limitRaw = headerGet(headers, 'x-ratelimit-limit');
  const remainingRaw = headerGet(headers, 'x-ratelimit-remaining');
  const resetRaw = headerGet(headers, 'x-ratelimit-reset');
  if (limitRaw && remainingRaw) {
    const limit = Number(limitRaw);
    const remaining = Number(remainingRaw);
    let resetAt = '';
    if (resetRaw) {
      const numeric = Number(resetRaw);
      if (Number.isFinite(numeric) && numeric > 1e10) resetAt = new Date(numeric).toISOString();
      else if (Number.isFinite(numeric)) resetAt = new Date(Date.now() + numeric * 1000).toISOString();
      else {
        const parsed = Date.parse(resetRaw);
        if (Number.isFinite(parsed)) resetAt = new Date(parsed).toISOString();
      }
    }
    if (Number.isFinite(limit) && Number.isFinite(remaining)) {
      result.rateLimit = { limit, remaining, resetAt };
    }
  }

  const retryAfter = headerGet(headers, 'retry-after');
  if (retryAfter) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter)) {
      result.retryAfterSeconds = Number(retryAfter);
    } else {
      const parsed = Date.parse(retryAfter);
      if (Number.isFinite(parsed)) {
        result.retryAfterSeconds = Math.max(0, Math.ceil((parsed - Date.now()) / 1000));
      }
    }
  }

  const cacheStateRaw =
    headerGet(headers, 'x-cache-status') ||
    headerGet(headers, 'cf-cache-status') ||
    headerGet(headers, 'x-cache') ||
    headerGet(headers, 'x-vercel-cache');
  if (cacheStateRaw) {
    const lower = cacheStateRaw.toLowerCase();
    result.cacheState = lower.includes('hit') ? 'hit' : lower.includes('miss') ? 'miss' : 'unknown';
  }

  return result;
}

/**
 * Filter a header record for request-side diagnostics: only explicitly allowed
 * non-sensitive fields are retained. Never returns cookies or credentials.
 */
export function filterRequestHeadersForDiagnostics(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) continue;
    if (!ALLOWED_HEADERS.has(lower)) continue;
    out[key] = value;
  }
  return out;
}
