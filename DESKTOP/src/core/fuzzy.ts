import { ProviderProtocol, inferProviderProtocol } from './config';

export type FuzzyDiscoverySource = 'models_endpoint' | 'suffix_probe' | 'heuristic';

export interface FuzzyProviderTokens {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  protocol?: ProviderProtocol;
}

export interface FuzzyDiscoveryResult extends FuzzyProviderTokens {
  protocol: ProviderProtocol;
  models: string[];
  source: FuzzyDiscoverySource;
  warning?: string;
}

const KNOWN_CHAT_SUFFIXES = [
  '/chat/completions',
  '/completions',
  '/responses',
  '/messages',
  '/models',
];

const BASE_PATH_SUFFIXES = [
  '',
  '/v1',
  '/api/v1',
  '/openai/v1',
  '/api/openai/v1',
  '/compatible-mode/v1',
  '/engines',
];

const MODEL_ENDPOINT_SUFFIXES = [
  '/models',
  '/v1/models',
  '/api/v1/models',
  '/openai/v1/models',
  '/api/openai/v1/models',
  '/compatible-mode/v1/models',
];

const OPENAI_CHAT_ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/v1/chat/completions',
  '/api/v1/chat/completions',
  '/openai/v1/chat/completions',
  '/api/openai/v1/chat/completions',
  '/compatible-mode/v1/chat/completions',
  '/completions',
  '/v1/completions',
  '/responses',
  '/v1/responses',
  '/api/v1/responses',
];

const ANTHROPIC_CHAT_ENDPOINT_SUFFIXES = [
  '/messages',
  '/v1/messages',
  '/api/v1/messages',
];

function unique(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

function normalizeUrlToken(raw: string): string {
  return raw.trim().replace(/[),;'"<>]+$/g, '');
}

function titleCaseDomainPart(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '')
    .join('');
}

export function providerNameFromUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'localhost') return 'Localhost';
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return 'LocalProvider';
    const parts = host.split('.').filter(Boolean);
    const filtered = parts.filter(part => !['api', 'gateway', 'openai', 'compatible', 'www'].includes(part));
    const core = filtered.length >= 2 ? filtered[filtered.length - 2] : (filtered[0] || parts[0] || 'provider');
    return titleCaseDomainPart(core) || 'Provider';
  } catch {
    return 'Provider';
  }
}

function extractUrlFromText(text: string): string {
  const urlMatch = text.match(/https?:\/\/[^\s"'<>),;]+/i);
  if (urlMatch) return normalizeUrlToken(urlMatch[0]);
  const hostMatch = text.match(/\b(?:api\.)?[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'<>),;]*)?/i);
  if (hostMatch) return normalizeUrlToken(`https://${hostMatch[0]}`);
  return '';
}

function extractKeyFromText(text: string): string {
  const named = text.match(/(?:api[_-]?key|auth[_-]?token|token|key)\s*[:=]\s*['"]?([A-Za-z0-9._~+/=-]{16,})['"]?/i);
  if (named) return named[1].trim();
  const known = text.match(/\b(sk-[A-Za-z0-9._-]{16,}|sk-ant-[A-Za-z0-9._-]{16,}|xai-[A-Za-z0-9._-]{16,}|gsk_[A-Za-z0-9._-]{16,}|[A-Za-z0-9_-]{32,})\b/);
  return known ? known[1].trim() : '';
}

function stripTerminalEndpoint(url: URL): URL {
  let pathname = url.pathname.replace(/\/+$/g, '');
  for (const suffix of KNOWN_CHAT_SUFFIXES) {
    if (pathname.toLowerCase().endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length).replace(/\/+$/g, '');
      break;
    }
  }
  url.pathname = pathname || '';
  url.search = '';
  url.hash = '';
  return url;
}

export function normalizeProviderBaseUrl(raw: string): string {
  const value = normalizeUrlToken(raw);
  if (!value) return '';
  try {
    const url = stripTerminalEndpoint(new URL(value));
    return url.toString().replace(/\/+$/g, '');
  } catch {
    return value.replace(/\/+$/g, '');
  }
}

export function tokenizeFuzzyProviderInput(input: string, explicit?: Partial<FuzzyProviderTokens>): FuzzyProviderTokens {
  const baseUrl = normalizeProviderBaseUrl(explicit?.baseUrl || extractUrlFromText(input));
  const apiKey = (explicit?.apiKey || extractKeyFromText(input)).trim();
  const providerName = (explicit?.providerName || (baseUrl ? providerNameFromUrl(baseUrl) : '') || 'Provider').trim();
  return {
    providerName,
    baseUrl,
    apiKey,
    protocol: explicit?.protocol,
  };
}

export function fuzzyCandidateModels(providerName: string, baseUrl: string, preferredModels: string[] = []): string[] {
  const marker = `${providerName} ${baseUrl}`.toLowerCase();
  const inferred: string[] = [];
  if (marker.includes('deepseek')) inferred.push('deepseek-chat', 'deepseek-reasoner');
  if (marker.includes('openai')) inferred.push('gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o');
  if (marker.includes('moonshot') || marker.includes('kimi')) inferred.push('kimi-k2-0711-preview', 'moonshot-v1-8k');
  if (marker.includes('dashscope') || marker.includes('qwen') || marker.includes('aliyun')) inferred.push('qwen-plus', 'qwen-turbo');
  if (marker.includes('openrouter')) inferred.push('openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet');
  if (marker.includes('anthropic') || marker.includes('claude')) inferred.push('claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest');
  return unique([...preferredModels, ...inferred, 'default', 'chat', 'model']);
}

function candidateBaseUrls(rawBaseUrl: string): string[] {
  const normalized = normalizeProviderBaseUrl(rawBaseUrl);
  if (!normalized) return [];
  try {
    const url = new URL(normalized);
    const root = `${url.protocol}//${url.host}`;
    const current = `${root}${url.pathname.replace(/\/+$/g, '')}`;
    return unique([
      current,
      ...BASE_PATH_SUFFIXES.map(suffix => `${root}${suffix}`),
    ]).map(value => value.replace(/\/+$/g, ''));
  } catch {
    return [normalized.replace(/\/+$/g, '')];
  }
}

function endpointBaseFromSuffix(inputBaseUrl: string, suffix: string): string {
  const base = inputBaseUrl.replace(/\/+$/g, '');
  const path = suffix.replace(/\/+$/g, '');
  for (const terminal of ['/chat/completions', '/completions', '/responses', '/messages', '/models']) {
    if (path.endsWith(terminal)) {
      const prefix = path.slice(0, -terminal.length).replace(/\/+$/g, '');
      return `${base}${prefix}`;
    }
  }
  return base;
}

function openAIHeaders(key: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${key}`,
  };
}

function anthropicHeaders(key: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  };
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 5000): Promise<{ status: number; ok: boolean; body: string; json?: any }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: abort.signal });
    const body = await response.text();
    let json: any = undefined;
    try {
      json = body ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, ok: response.ok, body, json };
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url: string, headers: Record<string, string>, body: Record<string, unknown>, timeoutMs = 5000): Promise<{ status: number; ok: boolean; text: string }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    return { status: response.status, ok: response.ok, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

function modelsFromJson(json: any): string[] {
  const raw = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : []);
  return unique(raw
    .map((entry: any) => typeof entry === 'string' ? entry : (entry?.id || entry?.name || ''))
    .map((name: unknown) => String(name || '').trim())
    .filter(Boolean));
}

function isEndpointLike(status: number, body: string): boolean {
  if (status >= 200 && status < 500 && status !== 404) return true;
  return /model|messages|prompt|authorization|api.?key|token|unsupported|required/i.test(body || '');
}

async function probeModelList(baseUrl: string, key: string, protocol: ProviderProtocol): Promise<{ baseUrl: string; models: string[] } | null> {
  const headers = protocol === 'anthropic' ? anthropicHeaders(key) : openAIHeaders(key);
  const bases = candidateBaseUrls(baseUrl);
  const suffixes = MODEL_ENDPOINT_SUFFIXES;
  for (const base of bases) {
    for (const suffix of suffixes) {
      try {
        const endpoint = `${base.replace(/\/+$/g, '')}${suffix}`;
        const result = await fetchJson(endpoint, headers);
        if (!isEndpointLike(result.status, result.body)) continue;
        const models = modelsFromJson(result.json);
        if (models.length) return { baseUrl: endpointBaseFromSuffix(base, suffix), models: models.slice(0, 12) };
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function probeChatEndpoint(baseUrl: string, key: string, protocol: ProviderProtocol, candidateModels: string[]): Promise<{ baseUrl: string; protocol: ProviderProtocol } | null> {
  const bases = candidateBaseUrls(baseUrl);
  const suffixes = protocol === 'anthropic' ? ANTHROPIC_CHAT_ENDPOINT_SUFFIXES : OPENAI_CHAT_ENDPOINT_SUFFIXES;
  for (const base of bases) {
    for (const suffix of suffixes) {
      const endpoint = `${base.replace(/\/+$/g, '')}${suffix}`;
      for (const model of candidateModels.slice(0, 4)) {
        try {
          const body = protocol === 'anthropic'
            ? { model, max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] }
            : suffix.endsWith('/responses')
              ? { model, input: 'Hi', max_output_tokens: 16 }
              : { model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 16 };
          const result = await postJson(endpoint, protocol === 'anthropic' ? anthropicHeaders(key) : openAIHeaders(key), body);
          if (result.ok || isEndpointLike(result.status, result.text)) {
            return { baseUrl: endpointBaseFromSuffix(base, suffix), protocol };
          }
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}

export async function fuzzyDiscoverWithoutGuide(
  input: string,
  explicit: Partial<FuzzyProviderTokens>,
  preferredModels: string[] = []
): Promise<FuzzyDiscoveryResult> {
  const tokens = tokenizeFuzzyProviderInput(input, explicit);
  if (!tokens.providerName || !tokens.baseUrl) {
    return {
      ...tokens,
      protocol: tokens.protocol || 'openai',
      models: [],
      source: 'heuristic',
      warning: 'Provider name and API URL are required.',
    };
  }
  if (!tokens.apiKey) {
    return {
      ...tokens,
      protocol: tokens.protocol || inferProviderProtocol(tokens.providerName, tokens.baseUrl),
      models: [],
      source: 'heuristic',
      warning: 'API key is required for new providers or existing providers without a saved key.',
    };
  }

  const protocolHints: ProviderProtocol[] = tokens.protocol
    ? [tokens.protocol]
    : unique([inferProviderProtocol(tokens.providerName, tokens.baseUrl), 'openai', 'anthropic'])
      .filter((value): value is ProviderProtocol => value === 'openai' || value === 'anthropic');
  for (const protocol of protocolHints) {
    const listed = await probeModelList(tokens.baseUrl, tokens.apiKey, protocol);
    if (listed) {
      return {
        ...tokens,
        baseUrl: normalizeProviderBaseUrl(listed.baseUrl),
        protocol,
        models: listed.models,
        source: 'models_endpoint',
      };
    }
  }

  const heuristicModels = fuzzyCandidateModels(tokens.providerName, tokens.baseUrl, preferredModels);
  for (const protocol of protocolHints) {
    const probed = await probeChatEndpoint(tokens.baseUrl, tokens.apiKey, protocol, heuristicModels);
    if (probed) {
      return {
        ...tokens,
        baseUrl: normalizeProviderBaseUrl(probed.baseUrl),
        protocol,
        models: heuristicModels.slice(0, 12),
        source: 'suffix_probe',
        warning: 'Provider endpoint was inferred by suffix probing because no guide model or model list was available.',
      };
    }
  }

  return {
    ...tokens,
    protocol: tokens.protocol || inferProviderProtocol(tokens.providerName, tokens.baseUrl),
    models: heuristicModels.slice(0, 12),
    source: 'heuristic',
    warning: 'Provider endpoint could not be confirmed by suffix probing. Falling back to heuristic candidates.',
  };
}
