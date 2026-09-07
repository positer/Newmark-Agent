/** Request construction shared by Chat, Responses and native protocol paths. */
export type RequestProtocol = 'openai' | 'anthropic' | 'github_models';

export function providerRequestHeaders(protocol: RequestProtocol, apiKey: string, stream = false): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : protocol === 'github_models' ? 'application/vnd.github+json' : 'application/json',
  };
  // Local compatible servers may intentionally have no authentication. Never
  // substitute a fake key or send an empty Bearer credential to such servers.
  if (apiKey) headers[protocol === 'anthropic' ? 'x-api-key' : 'Authorization'] = protocol === 'anthropic' ? apiKey : `Bearer ${apiKey}`;
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (protocol === 'github_models') headers['X-GitHub-Api-Version'] = '2022-11-28';
  return headers;
}

/** Preserve custom gateway prefixes and queries; replace only known endpoints. */
export function providerEndpoint(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl.trim());
  const suffix = '/' + endpoint.replace(/^\/+/, '');
  let base = url.pathname.replace(/\/+$/, '');
  if (/^\/(?:inference|catalog)\//.test(suffix)) {
    base = base.replace(/\/(?:inference\/chat\/completions|catalog\/models|inference)$/i, '');
  } else {
    base = base.replace(/\/(?:chat\/completions|responses|messages|models)$/i, '');
  }
  if (!base && /^(?:api\.openai\.com|api\.anthropic\.com)$/i.test(url.hostname)) base = '/v1';
  url.pathname = base + suffix;
  url.hash = '';
  return url.toString();
}
