import { StreamToken } from '../core/types';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { extractProviderUsage } from '../core/agentKernelDiagnostics';
import { providerEndpoint, providerRequestHeaders } from '../providers/provider-request-compat';
import { normalizeProviderHeaders } from '../providers/provider-headers';
import {
  openAIToolName as normalizeOpenAIToolName,
  stringifyContent as serializeContentValue,
  normalizeOpenAIContent as serializeOpenAIContent,
  normalizeResponsesContent as serializeResponsesContent,
  openAIChatMessages as buildOpenAIChatMessages,
} from '../providers/chat-messages';
import {
  ActualApiUsage,
  createProviderAdapter,
  ModelProviderAdapter,
  NormalizedAgentRequest,
  NormalizedMessage,
  NormalizedTool,
  ProviderTransport,
  SerializedProviderRequest,
  TransportResponse,
  providerStreamingDispatcher,
  setDefaultProviderDispatcher,
} from '../providers';
import { Dispatcher, ProxyAgent } from 'undici';

export interface IntelligenceConfig {
  temperature: number;
  maxTokens: number;
  reasoningEffort: IntelligenceTier;
}
export type IntelligenceTier = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ProviderProtocol = 'openai' | 'anthropic' | 'github_models';
export type OpenAITransportMode = 'chat_stream' | 'chat' | 'responses';

export interface ProviderProxyOptions {
  enabled?: boolean;
  url?: string;
  auth?: string;
}

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
};

type MessageContentPart = Record<string, unknown>;

export interface ProviderModelCatalogEntry {
  id: string;
  raw: Record<string, unknown>;
}

export type ProviderStreamCompletionEvent =
  | 'openai_done'
  | 'openai_response_completed'
  | 'anthropic_message_stop';

export interface ProviderStreamProbeResult {
  chunks: string[];
  completionEvent?: ProviderStreamCompletionEvent;
}

interface ProviderHttpResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
}

interface NodeHttpResult {
  status: number;
  body: string;
  headers?: Record<string, string | string[] | undefined>;
}

// Provider responses are intentionally unbounded. User cancellation, transport
// errors, and tool-specific limits remain the only automatic stop conditions.
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 0;
const MIN_PROVIDER_REQUEST_TIMEOUT_MS = 50;

function providerTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Provider request timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  return error;
}

function isProviderTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function abortFailure(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  const error = reason instanceof Error ? reason : new Error(reason ? String(reason) : 'LLM request aborted');
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  return error;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortFailure(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortFailure(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function parseProviderSse(raw: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  for (const block of String(raw || '').replace(/\r\n/g, '\n').split(/\n\n+/)) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return events;
}

export class LLMProvider {
  static nodeHttpTransport: ((method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: string) => Promise<NodeHttpResult>) | null = null;
  static powershellTransport: ((method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: string) => Promise<NodeHttpResult>) | null = null;
  private readonly temperatureUnsupported = new Set<string>();
  private proxyDispatcher: ProxyAgent | null | undefined;
  private nodeProxyAgent: unknown | null | undefined;

  constructor(
    public name: string,
    public baseUrl: string,
    public apiKey: string,
    public explicitProtocol?: ProviderProtocol,
    public openAIMode: OpenAITransportMode | boolean = 'chat_stream',
    public useProviderAdaptersV2 = false,
    public requestTimeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
    /** dev-0.4.3 模型原生思考强度档位映射（模型名 → { 模型原生档位: Newmark 档位 }）。 */
    public thinkingTierMaps?: Record<string, Record<string, string>>,
    /** dev-0.5.14 Agent 模型传输也走用户配置的 HTTP/HTTPS 代理，与 web 工具一致。 */
    public proxy: ProviderProxyOptions = {},
  ) {}

  private effectiveProxyUrl(): string {
    const configured = String(this.proxy?.url || '').trim();
    if (this.proxy?.enabled === false) return '';
    if (configured) return configured;
    return process.env.HTTPS_PROXY || process.env.HTTP_PROXY
      || process.env.https_proxy || process.env.http_proxy || '';
  }

  private proxyAuthValue(proxyUrl: string): string {
    if (this.proxy?.enabled === true || this.proxy?.url) {
      return String(this.proxy?.auth || '').trim();
    }
    try {
      const parsed = new URL(proxyUrl);
      if (!parsed.username && !parsed.password) return '';
      return decodeURIComponent(parsed.username) + ':' + decodeURIComponent(parsed.password);
    } catch {
      return '';
    }
  }

  private resolveProxyDispatcher(): ProxyAgent | null {
    if (this.proxyDispatcher !== undefined) return this.proxyDispatcher;
    const proxyUrl = this.effectiveProxyUrl();
    if (!proxyUrl) {
      this.proxyDispatcher = null;
      return null;
    }
    try {
      const auth = this.proxyAuthValue(proxyUrl);
      this.proxyDispatcher = auth
        ? new ProxyAgent({
            uri: proxyUrl,
            token: `Basic ${Buffer.from(auth, 'utf8').toString('base64')}`,
          })
        : new ProxyAgent(proxyUrl);
    } catch {
      this.proxyDispatcher = null;
    }
    setDefaultProviderDispatcher(this.proxyDispatcher);
    return this.proxyDispatcher;
  }

  private resolveNodeProxyAgent(): unknown | null {
    if (this.nodeProxyAgent !== undefined) return this.nodeProxyAgent;
    const proxyUrl = this.effectiveProxyUrl();
    if (!proxyUrl) {
      this.nodeProxyAgent = null;
      return null;
    }
    const auth = this.proxyAuthValue(proxyUrl);
    try {
      const { HttpsProxyAgent } = require('https-proxy-agent') as {
        HttpsProxyAgent: new (url: string, options?: { headers?: Record<string, string> }) => unknown;
      };
      this.nodeProxyAgent = auth
        ? new HttpsProxyAgent(proxyUrl, {
            headers: { 'Proxy-Authorization': `Basic ${Buffer.from(auth, 'utf8').toString('base64')}` },
          })
        : new HttpsProxyAgent(proxyUrl);
    } catch {
      this.nodeProxyAgent = null;
    }
    return this.nodeProxyAgent;
  }

  private async providerFetch(input: string | URL | Request, init: RequestInit = {}, streaming = false): Promise<Response> {
    const proxyDispatcher = this.resolveProxyDispatcher();
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : String(input.url || '');
    const selectedDispatcher = this.isPlainHttpLoopback(url) ? null : proxyDispatcher;
    const dispatcher = streaming ? providerStreamingDispatcher(selectedDispatcher) : selectedDispatcher;
    if (!dispatcher) return fetch(input, init);
    return fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher });
  }

  private effectiveRequestTimeout(timeoutMs: number): number {
    const requested = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
    const configured = Number.isFinite(this.requestTimeoutMs) && this.requestTimeoutMs > 0
      ? this.requestTimeoutMs
      : 0;
    if (requested <= 0 || configured <= 0) return 0;
    return Math.max(MIN_PROVIDER_REQUEST_TIMEOUT_MS, Math.min(requested, configured));
  }

  private async withRequestTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (timeoutMs <= 0) return await abortable(promise, signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(providerTimeoutError(timeoutMs)), timeoutMs);
    });
    try {
      return await abortable(Promise.race([promise, timeoutPromise]), signal);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  intelligenceConfig(tier: string): IntelligenceConfig {
    switch (tier) {
      case 'low': return { temperature: 0.3, maxTokens: 2048, reasoningEffort: 'low' };
      case 'high': return { temperature: 0.8, maxTokens: 16384, reasoningEffort: 'high' };
      case 'xhigh': return { temperature: 0.8, maxTokens: 32768, reasoningEffort: 'xhigh' };
      case 'max': return { temperature: 0.8, maxTokens: 65536, reasoningEffort: 'max' };
      case 'ultra': return { temperature: 0.8, maxTokens: 131072, reasoningEffort: 'max' };
      default: return { temperature: 0.7, maxTokens: 8192, reasoningEffort: 'medium' };
    }
  }

  private reasoningEffort(model: string, tier?: string): string | undefined {
    const mapped = this.mappedNativeEffort(model, tier);
    if (mapped !== undefined) return mapped;
    if (!/^(?:gpt-5|o[134](?:-|$)|codex)|(?:reasoner|reasoning|deepseek-r1|deepseek-reasoner|\br1\b)/i.test(model)) return undefined;
    const effort: IntelligenceTier = tier === 'low' || tier === 'high' || tier === 'xhigh' || tier === 'max'
      ? tier
      : tier === 'ultra' ? 'max'
      : 'medium';
    // OpenAI currently accepts xhigh as its highest public API effort. Custom
    // OpenAI-compatible/Codex gateways may expose the user-facing max tier.
    return effort === 'max' && /^https:\/\/(?:api\.)?openai\.com(?:\/|$)/i.test(this.cleanBaseUrl()) ? 'xhigh' : effort;
  }

  /**
   * dev-0.4.3 模型原生思考强度档位映射。不同模型的原生 reasoning_effort
   * 档位配置可能不同（档位数量或档位命名不同）。模型配置 `thinking_tier_map`
   * 以「模型原生档位名 → Newmark 档位」声明映射，这里把 Newmark 档位反查为
   * 模型原生档位名；未配置映射（或映射为空）时返回 undefined，由调用方
   * 维持默认透传行为（默认不变动映射）。
   */
  private mappedNativeEffort(model: string, tier?: string): string | undefined {
    const map = this.thinkingTierMaps?.[model];
    if (!map || typeof map !== 'object') return undefined;
    const order = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    const entries = Object.entries(map)
      .filter((entry): entry is [string, (typeof order)[number]] => order.includes(entry[1] as (typeof order)[number]))
      .sort((a, b) => order.indexOf(a[1]) - order.indexOf(b[1]));
    if (!entries.length) return undefined;
    const normalized: (typeof order)[number] = tier === 'ultra'
      ? 'max'
      : (order.includes(tier as (typeof order)[number]) ? tier as (typeof order)[number] : 'medium');
    const exact = entries.find(([, newmark]) => newmark === normalized);
    if (exact) return exact[0];
    // 就近降级：取强度不超过目标档位的最高已映射档位
    const targetIndex = order.indexOf(normalized);
    for (let i = targetIndex; i >= 0; i--) {
      const candidate = entries.find(([, newmark]) => newmark === order[i]);
      if (candidate) return candidate[0];
    }
    // 全部高于目标档位：取最低档位
    return entries[0]?.[0];
  }

  private applyChatReasoningEffort(body: Record<string, unknown>, model: string, tier?: string): void {
    const effort = this.reasoningEffort(model, tier);
    if (effort) body.reasoning_effort = effort;
  }

  private protocol(): ProviderProtocol {
    if (this.explicitProtocol) return this.explicitProtocol;
    const marker = `${this.name} ${this.baseUrl}`.toLowerCase();
    if (marker.includes('github models') || marker.includes('github copilot') || marker.includes('models.github.ai') || marker.includes('api.githubcopilot.com')) return 'github_models';
    if (marker.includes('anthropic') || marker.includes('/anthropic') || marker.includes('claude')) return 'anthropic';
    return 'openai';
  }

  private openAITransportMode(): OpenAITransportMode {
    if (this.openAIMode === false) return 'chat';
    if (this.openAIMode === true) return 'chat_stream';
    if (this.openAIMode === 'chat' || this.openAIMode === 'responses') return this.openAIMode;
    return 'chat_stream';
  }

  private cleanBaseUrl(): string {
    return this.baseUrl.trim();
  }

  private githubModelsBaseUrl(): string {
    const base = this.cleanBaseUrl();
    if (!base) return 'https://models.github.ai';
    return base;
  }

  private githubModelsUrl(pathname: string): string {
    return providerEndpoint(this.githubModelsBaseUrl(), pathname);
  }

  private openAIHeaders(stream = false): Record<string, string> {
    return providerRequestHeaders(this.protocol() === 'github_models' ? 'github_models' : 'openai', this.apiKey, stream);
  }

  private llmErrorText(response: Pick<ProviderHttpResponse, 'status' | 'headers'>, body: string): string {
    const seconds = response.headers ? normalizeProviderHeaders(response.headers).retryAfterSeconds : undefined;
    const retryAfter = seconds === undefined ? '' : ` Retry-After: ${seconds}s`;
    return `[LLM Error: ${response.status}]${retryAfter} ${body}`;
  }

  private headerReader(headers?: NodeHttpResult['headers']): ProviderHttpResponse['headers'] | undefined {
    if (!headers) return undefined;
    return {
      get(name: string): string | null {
        const value = headers[String(name || '').toLowerCase()];
        if (Array.isArray(value)) return value.join(', ');
        return value === undefined ? null : String(value);
      },
    };
  }

  private isPlainHttpLoopback(urlValue: string): boolean {
    try {
      const parsed = new URL(urlValue);
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      return parsed.protocol === 'http:'
        && (hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname));
    } catch {
      return false;
    }
  }

  private transportDiagnostic(stage: string, detail = ''): void {
    if (process.env.NEWMARK_PROVIDER_DIAGNOSTICS !== '1') return;
    console.error(`[NewmarkProvider] ${stage}${detail ? ` ${detail}` : ''}`);
  }

  private githubModelsHeaders(stream = false): Record<string, string> {
    return providerRequestHeaders('github_models', this.apiKey, stream);
  }

  private temperatureCapabilityKey(url: string, body: Record<string, unknown>): string {
    return `${url}|${String(body.model || '')}`;
  }

  private unsupportedTemperatureError(status: number, raw: string): boolean {
    if (status !== 400) return false;
    try {
      const parsed = JSON.parse(String(raw || '')) as { error?: { param?: unknown; message?: unknown } };
      if (String(parsed?.error?.param || '').toLowerCase() === 'temperature') return true;
      return /unsupported parameter[^\n]*temperature|temperature[^\n]*not supported/i.test(String(parsed?.error?.message || ''));
    } catch {
      return /unsupported parameter[^\n]*temperature|temperature[^\n]*not supported/i.test(String(raw || ''));
    }
  }

  private requestBodyForTemperatureCapability(url: string, body: Record<string, unknown>): Record<string, unknown> {
    const prepared = { ...body };
    if (this.temperatureUnsupported.has(this.temperatureCapabilityKey(url, body))) delete prepared.temperature;
    return prepared;
  }

  private async postJsonWithFetchFallback(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    timeoutMs = 120000,
    signal?: AbortSignal,
  ): Promise<ProviderHttpResponse> {
    const prepared = this.requestBodyForTemperatureCapability(url, body);
    const response = await this.postJsonOnce(url, headers, prepared, timeoutMs, signal);
    if (prepared.temperature === undefined || response.status !== 400) return response;
    const cloneable = typeof (response as Response).clone === 'function';
    const errorText = await (cloneable ? (response as Response).clone() : response).text();
    if (!this.unsupportedTemperatureError(response.status, errorText)) {
      if (cloneable) return response;
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        text: async () => errorText,
        json: async () => JSON.parse(errorText || '{}'),
      };
    }
    this.temperatureUnsupported.add(this.temperatureCapabilityKey(url, body));
    const retryBody = { ...body };
    delete retryBody.temperature;
    return this.postJsonOnce(url, headers, retryBody, timeoutMs, signal);
  }

  private async postJsonOnce(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    timeoutMs = 120000,
    signal?: AbortSignal,
  ): Promise<ProviderHttpResponse> {
    const effectiveTimeout = this.effectiveRequestTimeout(timeoutMs);
    // Electron utility processes can leave an undici response body pending when
    // several isolated workers concurrently call a plain-HTTP local provider.
    // Node's HTTP client owns the full body lifecycle and is deterministic for
    // loopback transports, while remote HTTPS providers retain fetch semantics.
    if (this.isPlainHttpLoopback(url)) {
      const pathname = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
      this.transportDiagnostic('loopback:start', pathname);
      const local = await this.nodeHttpJson('POST', url, headers, JSON.stringify(body), signal, effectiveTimeout);
      this.transportDiagnostic('loopback:complete', `status=${local.status} bytes=${Buffer.byteLength(local.body || '')}`);
      return {
        ok: local.status >= 200 && local.status < 300,
        status: local.status,
        headers: this.headerReader(local.headers),
        text: async () => local.body,
        json: async () => JSON.parse(local.body || '{}'),
      };
    }
    const abort = new AbortController();
    const forwardAbort = () => abort.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = effectiveTimeout > 0
      ? setTimeout(() => abort.abort(providerTimeoutError(effectiveTimeout)), effectiveTimeout)
      : undefined;
    try {
      const response = await this.providerFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      }, true);
      // Keep the caller's cancellation and explicit deadline attached through
      // the JSON body, not just until response headers arrive.
      const responseText = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        text: async () => responseText,
        json: async () => JSON.parse(responseText || '{}'),
      };
    } catch (e) {
      if (signal?.aborted) throw abortFailure(signal);
      if (abort.signal.aborted) throw abortFailure(abort.signal);
      if (!this.shouldUseNodeHttpFallback(e)) throw e;
      const fallback = await this.nodeHttpJson('POST', url, headers, JSON.stringify(body), signal, effectiveTimeout);
      return {
        ok: fallback.status >= 200 && fallback.status < 300,
        status: fallback.status,
        headers: this.headerReader(fallback.headers),
        text: async () => fallback.body,
        json: async () => JSON.parse(fallback.body || '{}'),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async getJsonWithFetchFallback(
    url: string,
    headers: Record<string, string>,
    timeoutMs = 30000
  ): Promise<ProviderHttpResponse> {
    const effectiveTimeout = this.effectiveRequestTimeout(timeoutMs);
    const abort = new AbortController();
    const timer = effectiveTimeout > 0
      ? setTimeout(() => abort.abort(providerTimeoutError(effectiveTimeout)), effectiveTimeout)
      : undefined;
    try {
      const response = await this.providerFetch(url, { method: 'GET', headers, signal: abort.signal });
      return response;
    } catch (e) {
      if (abort.signal.aborted) throw abortFailure(abort.signal);
      if (!this.shouldUseNodeHttpFallback(e)) throw e;
      const fallback = await this.nodeHttpJson('GET', url, headers, '', undefined, effectiveTimeout);
      return {
        ok: fallback.status >= 200 && fallback.status < 300,
        status: fallback.status,
        headers: this.headerReader(fallback.headers),
        text: async () => fallback.body,
        json: async () => JSON.parse(fallback.body || '{}'),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private shouldUseNodeHttpFallback(error: unknown): boolean {
    // Abort is a completed control decision (user cancellation or our own
    // deadline), not evidence that a second transport can succeed. Retrying it
    // on Windows used to create a second 120s request after the first timeout.
    return error instanceof TypeError && /fetch failed/i.test(error.message);
  }

  private nodeHttpJson(
    method: 'GET' | 'POST',
    urlValue: string,
    headers: Record<string, string>,
    body = '',
    signal?: AbortSignal,
    timeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
  ): Promise<NodeHttpResult> {
    const effectiveTimeout = this.effectiveRequestTimeout(timeoutMs);
    if (LLMProvider.nodeHttpTransport) {
      return this.withRequestTimeout(LLMProvider.nodeHttpTransport(method, urlValue, headers, body), effectiveTimeout, signal).catch(error => {
        if (signal?.aborted) throw abortFailure(signal);
        if (isProviderTimeoutError(error)) throw error;
        if (process.platform === 'win32') {
          return this.powershellJson(method, urlValue, headers, body, signal, effectiveTimeout);
        }
        throw error;
      });
    }
    return new Promise<NodeHttpResult>((resolve, reject) => {
      const parsed = new URL(urlValue);
      const client = parsed.protocol === 'http:' ? http : https;
      const requestHeaders: Record<string, string | number> = { ...headers };
      if (body) {
        requestHeaders['Content-Length'] = Buffer.byteLength(body);
      }
      const proxyAgent = this.isPlainHttpLoopback(urlValue) ? null : this.resolveNodeProxyAgent();
      const requestOptions: http.RequestOptions = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: requestHeaders,
        ...(proxyAgent ? { agent: proxyAgent as http.Agent } : {}),
      };
      const req = client.request(requestOptions, (res) => {
        res.setEncoding('utf8');
        let responseBody = '';
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode || 0, body: responseBody, headers: res.headers });
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        res.on('data', chunk => { responseBody += chunk; });
        res.once('end', finish);
        res.once('aborted', () => fail(new Error('Node HTTP response aborted before completion')));
        res.once('error', error => fail(error));
        res.once('close', () => {
          if (settled) return;
          if (res.complete) finish();
          else fail(new Error('Node HTTP response closed before completion'));
        });
      });
      if (effectiveTimeout > 0) {
        req.setTimeout(effectiveTimeout, () => {
          req.destroy(providerTimeoutError(effectiveTimeout));
        });
      }
      req.on('error', reject);
      const onAbort = () => req.destroy(abortFailure(signal));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      req.once('close', () => signal?.removeEventListener('abort', onAbort));
      if (body) req.write(body);
      req.end();
    }).catch(error => {
      if (signal?.aborted) throw abortFailure(signal);
      if (isProviderTimeoutError(error)) throw error;
      if (process.platform === 'win32') {
        return this.powershellJson(method, urlValue, headers, body, signal, effectiveTimeout);
      }
      throw error;
    });
  }

  private powershellJson(
    method: 'GET' | 'POST',
    urlValue: string,
    headers: Record<string, string>,
    body = '',
    signal?: AbortSignal,
    timeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
  ): Promise<NodeHttpResult> {
    const effectiveTimeout = this.effectiveRequestTimeout(timeoutMs);
    if (LLMProvider.powershellTransport) {
      return this.withRequestTimeout(LLMProvider.powershellTransport(method, urlValue, headers, body), effectiveTimeout, signal);
    }
    return new Promise<NodeHttpResult>((resolve, reject) => {
      const headerJson = JSON.stringify(headers);
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-llm-'));
      const bodyPath = path.join(tempDir, 'body.json');
      const responsePath = path.join(tempDir, 'response.json');
      fs.writeFileSync(bodyPath, body || '', 'utf8');
      const cleanup = () => {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      };
      const script = [
        '$ErrorActionPreference = "Stop"',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$uri = [Console]::In.ReadLine()',
        '$method = [Console]::In.ReadLine()',
        '$headerJson = [Console]::In.ReadLine()',
        '$bodyPath = [Console]::In.ReadLine()',
        '$responsePath = [Console]::In.ReadLine()',
        '$utf8NoBom = New-Object System.Text.UTF8Encoding($false)',
        '$bodyJson = if ($bodyPath -and (Test-Path -LiteralPath $bodyPath)) { [System.IO.File]::ReadAllText($bodyPath, $utf8NoBom) } else { "" }',
        '$headers = @{}',
        'if ($headerJson) {',
        '  $raw = $headerJson | ConvertFrom-Json',
        '  foreach ($p in $raw.PSObject.Properties) { $headers[$p.Name] = [string]$p.Value }',
        '}',
        effectiveTimeout > 0
          ? `$params = @{ Uri = $uri; Method = $method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = ${Math.ceil(effectiveTimeout / 1000)} }`
          : '$params = @{ Uri = $uri; Method = $method; Headers = $headers; UseBasicParsing = $true }',
        'if ($method -eq "POST") { $params["Body"] = $bodyJson }',
        'if ($method -eq "POST") { $params["ContentType"] = "application/json; charset=utf-8" }',
        '$resp = Invoke-WebRequest @params',
        'if ($resp.RawContentStream -ne $null) {',
        '  $resp.RawContentStream.Position = 0',
        '  $out = [System.IO.File]::Open($responsePath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)',
        '  try { $resp.RawContentStream.CopyTo($out) } finally { $out.Dispose() }',
        '} else {',
        '  [System.IO.File]::WriteAllText($responsePath, [string]$resp.Content, $utf8NoBom)',
        '}',
        'Write-Output ([int]$resp.StatusCode)',
      ].join('; ');
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const onAbort = () => {
        try { child.kill(); } catch {}
        cleanup();
        reject(abortFailure(signal));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      const timer = effectiveTimeout > 0 ? setTimeout(() => {
          child.kill();
          cleanup();
          reject(providerTimeoutError(effectiveTimeout));
        }, effectiveTimeout + 5000) : undefined;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        cleanup();
        reject(error);
      });
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (code !== 0) {
          cleanup();
          reject(new Error(`PowerShell HTTP fallback failed: ${this.redactSecret(stderr || stdout)}`));
          return;
        }
        if (!fs.existsSync(responsePath)) {
          cleanup();
          reject(new Error('PowerShell HTTP fallback did not write response body'));
          return;
        }
        const statusText = stdout.trim().split(/\r?\n/).pop() || '0';
        const bodyText = fs.readFileSync(responsePath, 'utf8');
        cleanup();
        resolve({ status: Number(statusText) || 0, body: bodyText });
      });
      child.stdin.end(`${urlValue}\n${method}\n${headerJson}\n${bodyPath}\n${responsePath}\n`);
    });
  }

  private redactSecret(value: string): string {
    if (!value) return value;
    let out = value;
    if (this.apiKey) out = out.split(this.apiKey).join('sk-***REDACTED***');
    return out.replace(/sk-[A-Za-z0-9_\-.]{8,}/g, 'sk-***REDACTED***');
  }

  private anthropicHeaders(stream = false): Record<string, string> {
    return providerRequestHeaders('anthropic', this.apiKey, stream);
  }

  private stringifyContent(value: unknown): string {
    return serializeContentValue(value);
  }

  private extractTextValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map(item => this.extractTextValue(item)).join('');
    if (typeof value !== 'object') return String(value);
    const record = value as Record<string, unknown>;
    if (typeof record.value === 'string') return record.value;
    if (typeof record.text === 'string') return record.text;
    if (record.text && typeof record.text === 'object') return this.extractTextValue(record.text);
    if (typeof record.output_text === 'string') return record.output_text;
    if (typeof record.refusal === 'string') return record.refusal;
    if (record.content !== undefined) return this.extractTextValue(record.content);
    return '';
  }

  private extractChatCompletionText(json: Record<string, unknown>): string {
    const choices = Array.isArray(json.choices) ? json.choices as Array<Record<string, unknown>> : [];
    const choice = choices[0] || {};
    const message = choice.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : {};
    return this.extractTextValue(message.content)
      || this.extractTextValue(message.refusal)
      || this.extractTextValue(choice.text)
      || this.extractTextValue(json.output_text)
      || this.extractTextValue(json.output);
  }

  private contentPolicyBlocked(json: Record<string, unknown>): boolean {
    const choices = Array.isArray(json.choices) ? json.choices as Array<Record<string, unknown>> : [];
    const choice = choices[0] || {};
    if (String(choice.finish_reason || '').toLowerCase() === 'content_filter') return true;
    const incomplete = json.incomplete_details && typeof json.incomplete_details === 'object'
      ? json.incomplete_details as Record<string, unknown>
      : {};
    if (String(incomplete.reason || '').toLowerCase().includes('content_filter')) return true;
    const error = json.error && typeof json.error === 'object' ? json.error as Record<string, unknown> : {};
    if (/content[_ -]?filter|safety|moderation/i.test(String(error.code || error.type || ''))) return true;
    const filterEvidence = JSON.stringify(choice.content_filter_results || json.prompt_filter_results || {});
    return /"filtered"\s*:\s*true/i.test(filterEvidence);
  }

  private normalizeOpenAIContent(value: unknown): string | MessageContentPart[] {
    return serializeOpenAIContent(value);
  }

  private openAIToolName(value: unknown): string {
    return normalizeOpenAIToolName(value);
  }

  private openAIChatMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return buildOpenAIChatMessages(messages);
  }

  private normalizeResponsesContent(value: unknown): string | MessageContentPart[] {
    return serializeResponsesContent(value);
  }

  private normalizeAnthropicContent(value: unknown): string | MessageContentPart[] {
    if (!Array.isArray(value)) return this.stringifyContent(value);
    const parts: MessageContentPart[] = [];
    for (const partRaw of value) {
      const part = partRaw as Record<string, unknown>;
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text') {
        parts.push({ type: 'text', text: String(part.text || '') });
      } else if (part.type === 'image_url') {
        const image = part.image_url as Record<string, unknown> | undefined;
        const url = image && typeof image === 'object' ? String(image.url || '') : '';
        const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          parts.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
        }
      }
    }
    return parts.length ? parts : '';
  }

  private parseToolInput(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return {};
      try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      } catch {
        return {};
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    return {};
  }

  private shouldUseResponsesFallback(status: number, errorText: string): boolean {
    if (status < 400 || status >= 500) return false;
    return /unsupported_api_for_model|responses api|use.*responses|not supported.*chat|chat.*not.*support/i.test(errorText || '');
  }

  private responsesTools(tools: unknown[]): Array<Record<string, unknown>> {
    const converted: Array<Record<string, unknown>> = [];
    for (const tool of tools || []) {
      const fn = (tool as { function?: Record<string, unknown> }).function || {};
      const name = String(fn.name || '').trim();
      if (!name) continue;
      converted.push({
        type: 'function',
        name,
        description: String(fn.description || ''),
        parameters: fn.parameters || { type: 'object', properties: {} },
      });
    }
    return converted;
  }

  private responsesInput(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const emittedCallIds = new Set<string>();
    for (const [index, msg] of (messages || []).entries()) {
      const role = String(msg.role || 'user');
      if (role === 'tool') {
        const callId = String(msg.tool_call_id || msg.call_id || `call_newmark_recovered_${index}`);
        const name = this.openAIToolName(msg.name);
        // Chat-compatible gateways and migrated history can retain the tool
        // result while losing the preceding assistant tool_calls envelope.
        // Responses requires the matching function_call to precede output.
        if (!emittedCallIds.has(callId)) {
          out.push({ type: 'function_call', call_id: callId, name, arguments: '{}' });
          emittedCallIds.add(callId);
        }
        out.push({
          type: 'function_call_output',
          call_id: callId,
          output: this.stringifyContent(msg.content),
        });
        continue;
      }
      if (role === 'assistant') {
        const content = this.normalizeResponsesContent(msg.content);
        const hasText = (typeof content === 'string' && content.trim()) || (Array.isArray(content) && content.length);
        if (hasText) out.push({ role: 'assistant', content });
        const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        for (const tcRaw of toolCalls) {
          const tc = tcRaw as Record<string, unknown>;
          const fn = (tc.function || {}) as Record<string, unknown>;
          const name = this.openAIToolName(fn.name);
          const callId = String(tc.id || tc.call_id || `call_newmark_${index}_${out.length}`);
          out.push({
            type: 'function_call',
            call_id: callId,
            name,
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
          });
          emittedCallIds.add(callId);
        }
        continue;
      }
      const normalizedRole = role === 'assistant' || role === 'system' ? role : 'user';
      out.push({ role: normalizedRole, content: this.normalizeResponsesContent(msg.content) });
    }
    return out.length ? out : [{ role: 'user', content: '' }];
  }

  private responsesBody(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    tools: unknown[] = [],
    reasoningTier?: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      input: this.responsesInput(messages),
      temperature,
      max_output_tokens: maxTokens,
    };
    const effort = this.reasoningEffort(model, reasoningTier);
    if (effort) body.reasoning = { effort, summary: 'auto' };
    if (systemPrompt) body.instructions = systemPrompt;
    const convertedTools = this.responsesTools(tools);
    if (convertedTools.length) {
      body.tools = convertedTools;
      body.tool_choice = 'auto';
    }
    return body;
  }

  private extractResponsesText(json: Record<string, unknown>): string {
    const direct = this.extractTextValue(json.output_text);
    if (direct) return direct;
    const chunks: string[] = [];
    const output = Array.isArray(json.output) ? json.output : [];
    for (const itemRaw of output) {
      const item = itemRaw as Record<string, unknown>;
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const blockRaw of item.content) {
          const block = blockRaw as Record<string, unknown>;
          if (block.type === 'output_text' || block.type === 'text' || block.type === 'refusal') {
            const text = this.extractTextValue(block.text || block.refusal || block.content);
            if (text) chunks.push(text);
          }
        }
      }
    }
    return chunks.join('') || this.extractChatCompletionText(json);
  }

  private normalizeResponsesPayload(payload: unknown): Record<string, unknown> {
    // Some OpenAI-compatible gateways wrap the standard Responses object in a
    // single-element array. Normalize that transport quirk once so plain chat
    // and tool-stream consumers share the same response shape.
    let current = payload;
    while (Array.isArray(current) && current.length === 1) current = current[0];
    return current && typeof current === 'object' && !Array.isArray(current)
      ? current as Record<string, unknown>
      : {};
  }

  private async openAIResponsesChat(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    signal?: AbortSignal,
    reasoningTier?: string,
    onUsage?: (usage: NonNullable<StreamToken['usage']>) => void,
  ): Promise<string> {
    const response = await this.postJsonWithFetchFallback(
      providerEndpoint(this.cleanBaseUrl(), '/responses'),
      this.openAIHeaders(),
      this.responsesBody(model, messages, systemPrompt, temperature, maxTokens, [], reasoningTier),
      120000,
      signal,
    );
    if (!response.ok) {
      return this.llmErrorText(response, await response.text());
    }
    const json = this.normalizeResponsesPayload(await response.json());
    onUsage?.(extractProviderUsage(json));
    const failure = this.nativeJsonCompletionError(json, 'responses');
    if (failure) return failure;
    return this.extractResponsesText(json);
  }

  private anthropicTools(tools: unknown[]): Array<Record<string, unknown>> {
    const converted: Array<Record<string, unknown>> = [];
    for (const tool of tools || []) {
      const fn = (tool as { function?: Record<string, unknown> }).function || {};
      const name = String(fn.name || '').trim();
      if (!name) continue;
      converted.push({
        name,
        description: String(fn.description || ''),
        input_schema: fn.parameters || { type: 'object', properties: {} },
      });
    }
    return converted;
  }

  private anthropicMessages(
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null
  ): { system?: string; messages: AnthropicMessage[] } {
    const out: AnthropicMessage[] = [];
    const systemParts: string[] = [];
    if (systemPrompt) systemParts.push(systemPrompt);

    for (const msg of messages || []) {
      const role = String(msg.role || 'user');
      if (role === 'system') {
        const content = this.stringifyContent(msg.content);
        if (content) systemParts.push(content);
        continue;
      }

      if (role === 'tool') {
        out.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: String(msg.tool_call_id || ''),
            content: this.stringifyContent(msg.content),
          }],
        });
        continue;
      }

      if (role === 'assistant') {
        const blocks: Array<Record<string, unknown>> = [];
        const content = this.stringifyContent(msg.content);
        if (content) blocks.push({ type: 'text', text: content });
        const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        for (const tcRaw of toolCalls) {
          const tc = tcRaw as Record<string, unknown>;
          const fn = (tc.function || {}) as Record<string, unknown>;
          const id = String(tc.id || 'toolu_newmark');
          const name = String(fn.name || '');
          if (!name) continue;
          blocks.push({
            type: 'tool_use',
            id,
            name,
            input: this.parseToolInput(fn.arguments),
          });
        }
        out.push({ role: 'assistant', content: blocks.length ? blocks : content });
        continue;
      }

      out.push({ role: 'user', content: this.normalizeAnthropicContent(msg.content) });
    }

    return {
      system: systemParts.length ? systemParts.join('\n\n') : undefined,
      messages: out.length ? out : [{ role: 'user', content: '' }],
    };
  }

  /**
   * dev-0.3.0 Layer C adapter-backed chat path, gated by the
   * `provider_adapters_v2` context flag. Request serialization and SSE
   * normalization are delegated to the shared provider adapters while the
   * transport orchestration (loopback node-http, fetch -> node-http fallback,
   * cancellation-only streaming and the 4xx Chat -> Responses downgrade) stay here.
   * The emitted request body and StreamToken stream are byte-equivalent to
   * the legacy inlined path.
   */
  private async *chatStreamWithToolsV2(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    tools: unknown[],
    signal?: AbortSignal,
    reasoningTier?: string,
    sessionId?: string,
  ): AsyncGenerator<StreamToken> {
    const mode = this.openAITransportMode();
    if (mode === 'responses') {
      yield* this.adapterResponsesBridge(model, messages, systemPrompt, temperature, maxTokens, tools, signal, reasoningTier);
      return;
    }

    const adapter = createProviderAdapter(this.name, 'chat_completions');
    const request: NormalizedAgentRequest = {
      providerId: this.name,
      model,
      apiMode: 'chat_completions',
      systemPrompt,
      messages: this.toNormalizedMessages(messages),
      tools: this.toNormalizedTools(tools),
      temperature,
      maxOutputTokens: maxTokens,
      reasoningEffort: this.reasoningEffort(model, reasoningTier),
      apiKey: this.apiKey,
      baseUrl: this.cleanBaseUrl(),
      ...(sessionId ? { sessionId } : {}),
    };
    const serialized = await adapter.serializeRequest(request);
    serialized.body.stream = mode === 'chat' ? false : true;
    serialized.headers = this.openAIHeaders(serialized.body.stream === true);

    const execSignal = signal ?? new AbortController().signal;
    const transport = this.buildProviderAdapterTransport();
    const streaming = mode === 'chat_stream';
    const reasoningState = { current: '' };

    for await (const event of adapter.execute(serialized, execSignal, transport)) {
      if (event.type === 'response.started' || event.type === 'response.completed') continue;
      if (event.type === 'tool_call.started' || event.type === 'tool_call.arguments.delta') continue;
      if (event.type === 'reasoning.summary.delta') {
        reasoningState.current += event.delta;
        yield { type: 'status', text: '', reasoningContent: reasoningState.current };
        continue;
      }
      if (event.type === 'text.delta') {
        yield { type: 'text', text: event.delta, reasoningContent: reasoningState.current || undefined };
        continue;
      }
      if (event.type === 'tool_call.completed') {
        const token: StreamToken = {
          type: 'tool_call',
          text: '',
          toolCall: { id: event.id, name: event.name, arguments: event.arguments },
        };
        if (streaming) token.reasoningContent = reasoningState.current || undefined;
        yield token;
        continue;
      }
      if (event.type === 'usage.updated') {
        yield { type: 'usage', text: '', usage: this.toStreamUsage(event.usage) };
        continue;
      }
      if (event.type === 'response.failed') {
        if (this.shouldDowngradeToResponses(event.error)) {
          const downgradeTier = streaming ? reasoningTier : '';
          yield* this.adapterResponsesBridge(model, messages, systemPrompt, temperature, maxTokens, tools, signal, downgradeTier);
          return;
        }
        yield { type: 'text', text: event.error, providerError: true };
        return;
      }
    }
  }

  private async *adapterResponsesBridge(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    tools: unknown[],
    signal?: AbortSignal,
    reasoningTier?: string,
  ): AsyncGenerator<StreamToken> {
    const adapter = createProviderAdapter(this.name, 'responses');
    const request: NormalizedAgentRequest = {
      providerId: this.name,
      model,
      apiMode: 'responses',
      systemPrompt,
      messages: this.toNormalizedMessages(messages),
      tools: this.toNormalizedTools(tools),
      temperature,
      maxOutputTokens: maxTokens,
      reasoningEffort: this.reasoningEffort(model, reasoningTier) as NormalizedAgentRequest['reasoningEffort'],
      apiKey: this.apiKey,
      baseUrl: this.cleanBaseUrl(),
    };
    const serialized = await adapter.serializeRequest(request);
    serialized.body.stream = true;
    serialized.headers = this.openAIHeaders(true);

    const execSignal = signal ?? new AbortController().signal;
    const transport = this.buildProviderAdapterTransport();
    let reasoningSummary = '';
    for await (const event of adapter.execute(serialized, execSignal, transport)) {
      if (event.type === 'response.started' || event.type === 'response.completed') continue;
      if (event.type === 'tool_call.started' || event.type === 'tool_call.arguments.delta') continue;
      if (event.type === 'reasoning.summary.delta') {
        reasoningSummary += event.delta;
        yield { type: 'status', text: '', reasoningContent: reasoningSummary };
        continue;
      }
      if (event.type === 'reasoning.summary.done') {
        if (event.summary && event.summary !== reasoningSummary) {
          reasoningSummary = event.summary;
          yield { type: 'status', text: '', reasoningContent: reasoningSummary };
        }
        continue;
      }
      if (event.type === 'text.delta') {
        yield { type: 'text', text: event.delta };
        continue;
      }
      if (event.type === 'tool_call.completed') {
        yield { type: 'tool_call', text: '', toolCall: { id: event.id, name: event.name, arguments: event.arguments } };
        continue;
      }
      if (event.type === 'usage.updated') {
        yield { type: 'usage', text: '', usage: this.toStreamUsage(event.usage) };
        continue;
      }
      if (event.type === 'response.failed') {
        yield { type: 'text', text: event.error, providerError: true };
        return;
      }
    }
  }

  private toStreamUsage(usage: ActualApiUsage): StreamToken['usage'] {
    return {
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
      reported: usage.reported,
    };
  }

  private shouldDowngradeToResponses(errorText: string): boolean {
    const match = /\[LLM Error: (\d+)\]/.exec(errorText || '');
    if (!match) return false;
    return this.shouldUseResponsesFallback(Number(match[1]), errorText);
  }

  /**
   * Loopback-aware transport injected into adapter `execute`. Streaming
   * requests retain the fetch-to-node fallback for transport failures. They
   * have no response deadline; only caller cancellation or a concrete
   * transport/provider failure may end the request.
   */
  private buildProviderAdapterTransport(): ProviderTransport {
    return async (request: SerializedProviderRequest, signal: AbortSignal): Promise<TransportResponse> => {
      request.body = this.requestBodyForTemperatureCapability(request.url, request.body);
      if (request.body?.stream === true) {
        const abort = new AbortController();
        const forwardAbort = () => abort.abort(signal?.reason);
        if (signal?.aborted) forwardAbort();
        else signal?.addEventListener('abort', forwardAbort, { once: true });
        // Streaming provider responses are intentionally unbounded. Only
        // caller cancellation or an explicit provider failure may end them.
        const effectiveTimeout = 0;
        const timer = effectiveTimeout > 0
          ? setTimeout(() => abort.abort(providerTimeoutError(effectiveTimeout)), effectiveTimeout)
          : undefined;
        try {
          try {
            let response = await this.providerFetch(request.url, {
              method: 'POST',
              headers: request.headers,
              body: JSON.stringify(request.body),
              signal: abort.signal,
            }, true);
            if (request.body.temperature !== undefined && response.status === 400) {
              const buffered = await this.bufferTransportResponse(response);
              const errorText = await buffered.text();
              if (this.unsupportedTemperatureError(response.status, errorText)) {
                this.temperatureUnsupported.add(this.temperatureCapabilityKey(request.url, request.body));
                const retryBody = { ...request.body };
                delete retryBody.temperature;
                response = await this.providerFetch(request.url, {
                  method: 'POST',
                  headers: request.headers,
                  body: JSON.stringify(retryBody),
                  signal: abort.signal,
                }, true);
              } else {
                return buffered;
              }
            }
            // Compatible providers can answer a stream request with JSON or
            // an error body. Read those once while cancellation still owns
            // the socket; only SSE readers take ownership after this returns.
            if (!response.ok || !/text\/event-stream/i.test(response.headers.get('content-type') || '')) {
              return await this.bufferTransportResponse(response);
            }
            return response;
          } catch (error) {
            if (signal?.aborted) throw abortFailure(signal);
            if (abort.signal.aborted) throw abortFailure(abort.signal);
            if (!this.shouldUseNodeHttpFallback(error)) throw error;
            const fallbackHeaders = { ...request.headers };
            fallbackHeaders.Accept = providerRequestHeaders(this.protocol(), this.apiKey).Accept;
            const fallback = await this.postJsonWithFetchFallback(
              request.url,
              fallbackHeaders,
              { ...request.body, stream: false },
              effectiveTimeout,
              signal,
            );
            return this.toTransportResponse(fallback);
          }
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', forwardAbort);
        }
      }
      const response = await this.postJsonWithFetchFallback(request.url, request.headers, request.body, 120000, signal);
      return this.toTransportResponse(response);
    };
  }

  private async bufferTransportResponse(response: Response): Promise<TransportResponse> {
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      body: null,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  }

  private toTransportResponse(response: ProviderHttpResponse): TransportResponse {
    if ((response as Response).body !== undefined) {
      return response as unknown as TransportResponse;
    }
    return {
      ok: response.ok,
      status: response.status,
      headers: { get: (name) => response.headers?.get(name) ?? null },
      text: () => response.text(),
      json: () => response.json(),
      body: null,
    };
  }

  private toNormalizedMessages(messages: Array<Record<string, unknown>>): NormalizedMessage[] {
    return (messages || []).map((msg, index) => {
      const role = String(msg.role || 'user');
      if (role === 'tool') {
        return {
          role: 'tool',
          content: msg.content as NormalizedMessage['content'],
          toolCallId: String(msg.tool_call_id || msg.call_id || `call_newmark_recovered_${index}`),
          name: String(msg.name || ''),
        };
      }
      if (role === 'assistant') {
        const rawToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        return {
          role: 'assistant',
          content: msg.content as NormalizedMessage['content'],
          toolCalls: rawToolCalls.map((rawCall) => {
            const tc = rawCall as Record<string, unknown>;
            const fn = tc.function && typeof tc.function === 'object' ? tc.function as Record<string, unknown> : {};
            return {
              id: String(tc.id || tc.call_id || ''),
              name: String(fn.name || ''),
              arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
            };
          }),
        };
      }
      return { role: role === 'system' ? 'system' : 'user', content: msg.content as NormalizedMessage['content'] };
    });
  }

  private toNormalizedTools(tools: unknown[]): NormalizedTool[] {
    return (tools || []).map((tool) => {
      const fn = (tool as { function?: Record<string, unknown> }).function || {};
      return {
        type: 'function',
        function: {
          name: String(fn.name || ''),
          description: String(fn.description || ''),
          parameters: fn.parameters && typeof fn.parameters === 'object'
            ? fn.parameters as Record<string, unknown>
            : { type: 'object', properties: {} },
        },
      };
    });
  }

  async *chatStreamWithTools(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    tools: unknown[],
    signal?: AbortSignal,
    reasoningTier?: string,
    sessionId?: string,
  ): AsyncGenerator<StreamToken> {
    if (signal?.aborted) throw abortFailure(signal);
    // A non-positive value means "provider owns the output limit". Protocols
    // whose wire format requires a positive max_tokens (Anthropic, GitHub
    // Models) fall back to the selected reasoning tier's budget; OpenAI-style
    // adapters omit the field entirely so the endpoint decides.
    const requiredMaxTokens = maxTokens > 0
      ? maxTokens
      : this.intelligenceConfig(reasoningTier || 'medium').maxTokens;
    if (this.protocol() === 'anthropic') {
      yield* this.anthropicChatWithTools(model, messages, systemPrompt, temperature, requiredMaxTokens, tools, signal);
      return;
    }
    if (this.protocol() === 'github_models') {
      yield* this.githubModelsChatStreamWithTools(model, messages, systemPrompt, temperature, requiredMaxTokens, tools, signal);
      return;
    }
    if (this.useProviderAdaptersV2) {
      yield* this.chatStreamWithToolsV2(model, messages, systemPrompt, temperature, maxTokens, tools, signal, reasoningTier, sessionId);
      return;
    }
    throw new Error('LLMProvider legacy OpenAI streaming was removed in dev-0.3.0: enable provider_adapters_v2 (useProviderAdaptersV2).');
  }

  /**
   * GitHub Models keeps its dedicated URL, headers and request serialization.
   * Response parsing shares the Chat adapter's completion validation.
   */
  private async *githubModelsChatStreamWithTools(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    tools: unknown[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamToken> {
    const url = this.githubModelsUrl('/inference/chat/completions');
    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...this.openAIChatMessages(messages),
      ],
      temperature,
      max_tokens: maxTokens,
      tools,
      tool_choice: 'auto',
      stream: true,
    };

    // Keep GitHub's endpoint, headers and payload, while sharing the validated
    // Chat Completions parser and fetch-to-node transport fallback.
    const adapter = createProviderAdapter(this.name, 'chat_completions');
    const request = { url, headers: this.openAIHeaders(true), body };
    let currentReasoningContent = '';
    for await (const event of adapter.execute(request, signal || new AbortController().signal, this.buildProviderAdapterTransport())) {
      if (event.type === 'reasoning.summary.delta') {
        currentReasoningContent += event.delta;
        yield { type: 'status', text: '', reasoningContent: currentReasoningContent };
      } else if (event.type === 'text.delta') {
        yield { type: 'text', text: event.delta, reasoningContent: currentReasoningContent || undefined };
      } else if (event.type === 'tool_call.completed') {
        yield { type: 'tool_call', text: '', toolCall: { id: event.id, name: event.name, arguments: event.arguments }, reasoningContent: currentReasoningContent || undefined };
      } else if (event.type === 'usage.updated') {
        yield { type: 'usage', text: '', usage: this.toStreamUsage(event.usage) };
      } else if (event.type === 'response.failed') {
        yield { type: 'text', text: event.error, providerError: true };
        return;
      }
    }
  }
  private async *anthropicChatWithTools(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    tools: unknown[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamToken> {
    const { system, messages: anthropicMessages } = this.anthropicMessages(messages, systemPrompt);
    const body: Record<string, unknown> = {
      model,
      messages: anthropicMessages,
      temperature,
      max_tokens: maxTokens,
    };
    if (system) body.system = system;
    const convertedTools = this.anthropicTools(tools);
    if (convertedTools.length) body.tools = convertedTools;

    // A Build reuses its cancellation signal across many tool turns. Keep the
    // native JSON exchange request-local so completed fetches cannot accumulate
    // their abort followers on that long-lived signal until a later GC.
    const response = await this.postJsonOnce(
      providerEndpoint(this.cleanBaseUrl(), '/messages'), this.anthropicHeaders(), body, 0, signal,
    );

    if (!response.ok) {
      const err = await response.text();
      yield { type: 'text', text: this.llmErrorText(response, err) };
      return;
    }

    const json = await response.json() as Record<string, unknown>;
    yield { type: 'usage', text: '', usage: extractProviderUsage(json, { protocol: 'anthropic' }) };
    const blocks = Array.isArray(json.content) ? json.content as Array<Record<string, unknown>> : [];
    const completeCalls = blocks.filter(block => block.type === 'tool_use');
    const failure = this.nativeJsonCompletionError(json, 'anthropic');
    for (const block of blocks) {
      const type = String(block.type || '');
      if (type === 'text' && block.text) {
        const text = this.extractTextValue(block.text);
        if (text) yield { type: 'text', text };
      } else if (type === 'thinking' && block.thinking) {
        yield { type: 'status', text: '', reasoningContent: String(block.thinking) };
      }
    }
    if (failure) { yield { type: 'text', text: failure }; return; }
    if (completeCalls.some(block => !block.id || !block.name || !block.input || typeof block.input !== 'object' || Array.isArray(block.input))) {
      yield { type: 'text', text: '[LLM Error] Provider returned incomplete or invalid tool-call arguments.', providerError: true };
      return;
    }
    for (const block of completeCalls) {
      yield { type: 'tool_call', text: '', toolCall: {
        id: String(block.id), name: String(block.name), arguments: JSON.stringify(block.input),
      } };
    }
  }

  private nativeJsonCompletionError(json: Record<string, unknown>, protocol: 'anthropic' | 'chat' | 'responses'): string {
    if (json.error || json.type === 'error') {
      const error = json.error && typeof json.error === 'object' ? json.error as Record<string, unknown> : {};
      return '[LLM Error] ' + (this.extractTextValue(error.message || error.type || json.error) || 'Provider returned an error response.');
    }
    const choice = Array.isArray(json.choices) ? json.choices[0] as Record<string, unknown> | undefined : undefined;
    const reason = protocol === 'anthropic' ? json.stop_reason : choice?.finish_reason;
    if (reason === 'max_tokens' || reason === 'length') return '[LLM Error] Provider response was truncated by the output token limit.';
    if (reason === 'content_filter') return '[Error] Content policy refusal (content_filter).';
    if (protocol === 'responses' && json.status && json.status !== 'completed') {
      const details = json.incomplete_details && typeof json.incomplete_details === 'object' ? json.incomplete_details as Record<string, unknown> : {};
      return `[LLM Error] Responses response was ${json.status}${details.reason ? ': ' + details.reason : ''}.`;
    }
    return '';
  }

  /**
   * Deterministic capability probe that sends the schema through the native
   * protocol field. Prompt-only JSON requests must not be treated as evidence
   * that a deployment supports structured output.
   */
  async chatStrictJson(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    schema: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<string> {
    const schemaName = 'newmark_validation_probe';
    if (this.protocol() === 'anthropic') {
      const { system, messages: anthropicMessages } = this.anthropicMessages(messages, systemPrompt);
      const body: Record<string, unknown> = {
        model,
        messages: anthropicMessages,
        temperature,
        max_tokens: maxTokens,
        output_config: {
          format: { type: 'json_schema', schema },
        },
      };
      if (system) body.system = system;
      const response = await this.postJsonWithFetchFallback(providerEndpoint(this.cleanBaseUrl(), '/messages'), this.anthropicHeaders(), body, 120000, signal);
      if (!response.ok) throw new Error(this.llmErrorText(response, await response.text()));
      const json = await response.json() as { content?: Array<Record<string, unknown>> };
      return (json.content || [])
        .filter(block => block.type === 'text' && block.text)
        .map(block => this.extractTextValue(block.text))
        .join('');
    }

    if (this.protocol() !== 'github_models' && this.openAITransportMode() === 'responses') {
      const body = this.responsesBody(model, messages, systemPrompt, temperature, maxTokens);
      body.text = {
        format: { type: 'json_schema', name: schemaName, strict: true, schema },
      };
      const response = await this.postJsonWithFetchFallback(providerEndpoint(this.cleanBaseUrl(), '/responses'), this.openAIHeaders(), body, 120000, signal);
      if (!response.ok) throw new Error(this.llmErrorText(response, await response.text()));
      return this.extractResponsesText(this.normalizeResponsesPayload(await response.json()));
    }

    const isGitHubModels = this.protocol() === 'github_models';
    const url = isGitHubModels
      ? this.githubModelsUrl('/inference/chat/completions')
      : providerEndpoint(this.cleanBaseUrl(), '/chat/completions');
    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...this.openAIChatMessages(messages),
      ],
      temperature,
      max_tokens: maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: true, schema },
      },
    };
    const response = await this.postJsonWithFetchFallback(
      url,
      isGitHubModels ? this.githubModelsHeaders() : this.openAIHeaders(),
      body,
      120000,
      signal,
    );
    if (!response.ok) throw new Error(this.llmErrorText(response, await response.text()));
    return this.extractChatCompletionText(await response.json() as Record<string, unknown>);
  }

  /**
   * Small streaming probe with explicit terminal-event evidence. Reading until
   * the socket closes is insufficient: truncated SSE must not validate.
   */
  async probeStreamCompletion(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<ProviderStreamProbeResult> {
    const abort = new AbortController();
    const forwardAbort = () => abort.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => abort.abort(), 30_000);
    try {
      let url: string;
      let headers: Record<string, string>;
      let body: Record<string, unknown>;
      let family: 'openai_chat' | 'openai_responses' | 'anthropic';
      if (this.protocol() === 'anthropic') {
        const prepared = this.anthropicMessages(messages, systemPrompt);
        url = providerEndpoint(this.cleanBaseUrl(), '/messages');
        headers = this.anthropicHeaders(true);
        body = {
          model,
          messages: prepared.messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
        };
        if (prepared.system) body.system = prepared.system;
        family = 'anthropic';
      } else if (this.protocol() !== 'github_models' && this.openAITransportMode() === 'responses') {
        url = providerEndpoint(this.cleanBaseUrl(), '/responses');
        headers = this.openAIHeaders(true);
        body = { ...this.responsesBody(model, messages, systemPrompt, temperature, maxTokens), stream: true };
        family = 'openai_responses';
      } else {
        const isGitHubModels = this.protocol() === 'github_models';
        url = isGitHubModels
          ? this.githubModelsUrl('/inference/chat/completions')
          : providerEndpoint(this.cleanBaseUrl(), '/chat/completions');
        headers = isGitHubModels ? this.githubModelsHeaders(true) : this.openAIHeaders(true);
        body = {
          model,
          messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            ...this.openAIChatMessages(messages),
          ],
          temperature,
          max_tokens: maxTokens,
          stream: true,
        };
        family = 'openai_chat';
      }

      const response = await this.providerFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(this.llmErrorText(response, await response.text()));
      const events = parseProviderSse(await response.text());
      const chunks: string[] = [];
      let completionEvent: ProviderStreamCompletionEvent | undefined;
      for (const event of events) {
        if (family === 'openai_chat' && event.data === '[DONE]') {
          completionEvent = 'openai_done';
          continue;
        }
        let payload: Record<string, any>;
        try { payload = JSON.parse(event.data) as Record<string, any>; } catch { continue; }
        const eventType = String(event.event || payload.type || '');
        if (family === 'anthropic') {
          if (eventType === 'message_stop') completionEvent = 'anthropic_message_stop';
          const deltaText = eventType === 'content_block_delta' && payload.delta?.type === 'text_delta'
            ? this.extractTextValue(payload.delta.text)
            : '';
          if (deltaText) chunks.push(deltaText);
        } else if (family === 'openai_responses') {
          if (eventType === 'response.completed') completionEvent = 'openai_response_completed';
          if (eventType === 'response.output_text.delta') {
            const deltaText = this.extractTextValue(payload.delta);
            if (deltaText) chunks.push(deltaText);
          }
        } else {
          const deltaText = this.extractTextValue(payload.choices?.[0]?.delta?.content);
          if (deltaText) chunks.push(deltaText);
        }
      }
      return { chunks, completionEvent };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  async chat(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    signal?: AbortSignal,
    reasoningTier?: string,
    onUsage?: (usage: NonNullable<StreamToken['usage']>) => void,
  ): Promise<string> {
    if (this.protocol() === 'anthropic') {
      const { system, messages: anthropicMessages } = this.anthropicMessages(messages, systemPrompt);
      const body: Record<string, unknown> = {
        model,
        messages: anthropicMessages,
        temperature,
        max_tokens: maxTokens,
      };
      if (system) body.system = system;

      const response = await this.postJsonWithFetchFallback(providerEndpoint(this.cleanBaseUrl(), '/messages'), this.anthropicHeaders(), body, 120000, signal);

      if (!response.ok) {
        throw new Error(this.llmErrorText(response, await response.text()));
      }

      const json = await response.json() as { content?: Array<Record<string, unknown>> };
      onUsage?.(extractProviderUsage(json, { protocol: 'anthropic' }));
      const failure = this.nativeJsonCompletionError(json, 'anthropic');
      if (failure) throw new Error(failure);
      return (json.content || [])
        .filter(block => block.type === 'text' && block.text)
        .map(block => this.extractTextValue(block.text))
        .join('');
    }

    const isGitHubModels = this.protocol() === 'github_models';
    const url = isGitHubModels
      ? this.githubModelsUrl('/inference/chat/completions')
      : providerEndpoint(this.cleanBaseUrl(), '/chat/completions');
    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...this.openAIChatMessages(messages),
      ],
      temperature,
      max_tokens: maxTokens,
    };
    if (!isGitHubModels) this.applyChatReasoningEffort(body, model, reasoningTier);

    if (!isGitHubModels && this.openAITransportMode() === 'responses') {
      return await this.openAIResponsesChat(model, messages, systemPrompt, temperature, maxTokens, signal, reasoningTier, onUsage);
    }

    const response = await this.postJsonWithFetchFallback(url, this.openAIHeaders(), body, 120000, signal);

    if (!response.ok) {
      const err = await response.text();
      if (!isGitHubModels && this.shouldUseResponsesFallback(response.status, err)) {
        return await this.openAIResponsesChat(model, messages, systemPrompt, temperature, maxTokens, signal, reasoningTier, onUsage);
      }
      throw new Error(this.llmErrorText(response, err));
    }

    const json = await response.json() as Record<string, unknown>;
    onUsage?.(extractProviderUsage(json));
    const failure = this.nativeJsonCompletionError(json, 'chat');
    if (failure) throw new Error(failure);
    return this.extractChatCompletionText(json);
  }

  async modelCatalog(): Promise<ProviderModelCatalogEntry[]> {
    if (this.protocol() === 'github_models') {
      const response = await this.getJsonWithFetchFallback(
        this.githubModelsUrl('/catalog/models'),
        this.githubModelsHeaders(),
      );

      if (!response.ok) {
        throw new Error(`GitHub Models catalog error: ${response.status} ${await response.text()}`);
      }

      const json = await response.json() as { data?: Array<{ id?: string; name?: string } | string>; models?: Array<{ id?: string; name?: string } | string> } | Array<{ id?: string; name?: string } | string>;
      const rawModels = Array.isArray(json)
        ? json
        : (Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []));
      return rawModels.map(entry => ({
        id: String(typeof entry === 'string' ? entry : (entry.id || entry.name || '')).trim(),
        raw: typeof entry === 'string' ? { id: entry } : entry,
      })).filter((entry, index, all) => !!entry.id && all.findIndex(candidate => candidate.id === entry.id) === index);
    }
    const response = await this.getJsonWithFetchFallback(
      providerEndpoint(this.cleanBaseUrl(), '/models'),
      this.protocol() === 'anthropic' ? this.anthropicHeaders() : this.openAIHeaders(),
    );

    if (!response.ok) {
      throw new Error(`Model list error: ${response.status} ${await response.text()}`);
    }

    const json = await response.json() as { data?: Array<{ id?: string; name?: string } | string>; models?: Array<{ id?: string; name?: string } | string> };
    const rawModels = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
    return rawModels.map(entry => ({
      id: String(typeof entry === 'string' ? entry : (entry.id || entry.name || '')).trim(),
      raw: typeof entry === 'string' ? { id: entry } : entry,
    })).filter((entry, index, all) => !!entry.id && all.findIndex(candidate => candidate.id === entry.id) === index);
  }

  async listModels(): Promise<string[]> {
    return (await this.modelCatalog()).map(entry => entry.id);
  }

  async validate(model: string): Promise<{ ok: boolean; latency: number }> {
    const start = Date.now();
    try {
      const result = await this.chat(model, [{ role: 'user', content: 'Hi' }], null, 0.1, 50);
      const latency = (Date.now() - start) / 1000;
      return { ok: result.length > 0 && !/^\s*\[(?:LLM Error|Error)(?::|\])/i.test(result), latency };
    } catch {
      return { ok: false, latency: (Date.now() - start) / 1000 };
    }
  }

  async validateVision(model: string): Promise<{ ok: boolean; latency: number; error?: string }> {
    const start = Date.now();
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACHSURBVHhe7dAhAQAADITA719681QAcQbJbjuzMdg0gMGmAQw2DWCwaQCDTQMYbBrAYNMABpsGMNg0gMGmAQw2DWCwaQCDTQMYbBrAYNMABpsGMNg0gMGmAQw2DWCwaQCDTQMYbBrAYNMABpsGMNg0gMGmAQw2DWCwaQCDTQMYbBrAYNMABpsHQ4jh0hEeUY0AAAAASUVORK5CYII=';
    try {
      const result = await this.chat(model, [{
        role: 'user',
        content: [
          { type: 'text', text: 'Identify the dominant color and shape in the attached image. Reply with exactly RED_SQUARE and no other text.' },
          { type: 'image_url', image_url: { url: image } },
        ],
      }], null, 0, 30);
      const ok = /\bRED_SQUARE\b/i.test(result);
      return { ok, latency: (Date.now() - start) / 1000, error: ok ? undefined : `unexpected answer: ${result.slice(0, 120)}` };
    } catch (error) {
      return { ok: false, latency: (Date.now() - start) / 1000, error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160) };
    }
  }

  async validateImageOutput(model: string): Promise<{ ok: boolean; latency: number; error?: string }> {
    if (this.protocol() !== 'openai') return { ok: false, latency: 0 };
    const start = Date.now();
    try {
      const response = await this.postJsonWithFetchFallback(providerEndpoint(this.cleanBaseUrl(), '/images/generations'), this.openAIHeaders(), {
        model,
        prompt: 'A single solid blue square on a white background.',
        size: '256x256',
        n: 1,
        response_format: 'b64_json',
      }, 120000);
      if (!response.ok) return { ok: false, latency: (Date.now() - start) / 1000, error: `HTTP ${response.status}: ${(await response.text()).slice(0, 120)}` };
      const json = await response.json() as { data?: Array<{ b64_json?: string; url?: string }> };
      const item = json.data?.[0];
      const ok = !!(item?.b64_json || item?.url);
      return { ok, latency: (Date.now() - start) / 1000, error: ok ? undefined : 'response contained no image URL or base64 data' };
    } catch (error) {
      return { ok: false, latency: (Date.now() - start) / 1000, error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160) };
    }
  }

  async generateImage(model: string, prompt: string, size = '1024x1024', signal?: AbortSignal): Promise<{ dataUrl?: string; url?: string }> {
    if (this.protocol() !== 'openai') throw new Error('Image generation requires an OpenAI-compatible provider.');
    const response = await this.postJsonWithFetchFallback(providerEndpoint(this.cleanBaseUrl(), '/images/generations'), this.openAIHeaders(), {
      model,
      prompt,
      size,
      n: 1,
      response_format: 'b64_json',
    }, 180000, signal);
    if (!response.ok) throw new Error(`Image generation failed: HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
    const json = await response.json() as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
    const item = json.data?.[0];
    if (item?.b64_json) return { dataUrl: `data:image/png;base64,${item.b64_json}` };
    if (item?.url) return { url: item.url };
    throw new Error('Image generation response contained no image.');
  }
}
