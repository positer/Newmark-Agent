import { StreamToken } from '../core/types';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

export interface IntelligenceConfig {
  temperature: number;
  maxTokens: number;
}
export type ProviderProtocol = 'openai' | 'anthropic' | 'github_models';
export type OpenAITransportMode = 'chat_stream' | 'chat' | 'responses';

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

  constructor(
    public name: string,
    public baseUrl: string,
    public apiKey: string,
    public explicitProtocol?: ProviderProtocol,
    public openAIMode: OpenAITransportMode | boolean = 'chat_stream'
  ) {}

  intelligenceConfig(tier: string): IntelligenceConfig {
    switch (tier) {
      case 'low': return { temperature: 0.3, maxTokens: 2048 };
      case 'high': return { temperature: 0.8, maxTokens: 16384 };
      default: return { temperature: 0.7, maxTokens: 8192 };
    }
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
    return this.baseUrl.replace(/\/+$/, '');
  }

  private githubModelsBaseUrl(): string {
    const base = this.cleanBaseUrl();
    if (!base) return 'https://models.github.ai';
    if (/\/inference$/i.test(base)) return base.replace(/\/inference$/i, '');
    return base;
  }

  private githubModelsUrl(pathname: string): string {
    const base = this.githubModelsBaseUrl();
    const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return `${base}${path}`;
  }

  private openAIHeaders(): Record<string, string> {
    if (this.protocol() === 'github_models') return this.githubModelsHeaders();
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  private llmErrorText(response: Pick<ProviderHttpResponse, 'status' | 'headers'>, body: string): string {
    const rawRetryAfter = response.headers?.get('retry-after')?.trim() || '';
    let retryAfter = '';
    if (/^\d+(?:\.\d+)?$/.test(rawRetryAfter)) {
      retryAfter = ` Retry-After: ${rawRetryAfter}s`;
    } else if (rawRetryAfter) {
      const retryAt = Date.parse(rawRetryAfter);
      if (Number.isFinite(retryAt)) retryAfter = ` Retry-After: ${Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000))}s`;
    }
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

  private githubModelsHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private async postJsonWithFetchFallback(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    timeoutMs = 120000,
    signal?: AbortSignal,
  ): Promise<ProviderHttpResponse> {
    // Electron utility processes can leave an undici response body pending when
    // several isolated workers concurrently call a plain-HTTP local provider.
    // Node's HTTP client owns the full body lifecycle and is deterministic for
    // loopback transports, while remote HTTPS providers retain fetch semantics.
    if (this.isPlainHttpLoopback(url)) {
      const pathname = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
      this.transportDiagnostic('loopback:start', pathname);
      const local = await this.nodeHttpJson('POST', url, headers, JSON.stringify(body), signal);
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
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      return response;
    } catch (e) {
      if (signal?.aborted) throw abortFailure(signal);
      if (!this.shouldUseNodeHttpFallback(e)) throw e;
      const fallback = await this.nodeHttpJson('POST', url, headers, JSON.stringify(body), signal);
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
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: 'GET', headers, signal: abort.signal });
      return response;
    } catch (e) {
      if (!this.shouldUseNodeHttpFallback(e)) throw e;
      const fallback = await this.nodeHttpJson('GET', url, headers);
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
    return (
      (error instanceof TypeError && /fetch failed/i.test(error.message)) ||
      (error instanceof Error && /abort/i.test(error.name || error.message))
    );
  }

  private nodeHttpJson(
    method: 'GET' | 'POST',
    urlValue: string,
    headers: Record<string, string>,
    body = '',
    signal?: AbortSignal,
  ): Promise<NodeHttpResult> {
    if (LLMProvider.nodeHttpTransport) {
      return abortable(LLMProvider.nodeHttpTransport(method, urlValue, headers, body), signal).catch(error => {
        if (signal?.aborted) throw abortFailure(signal);
        if (process.platform === 'win32') {
          return this.powershellJson(method, urlValue, headers, body, signal);
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
      const req = client.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: requestHeaders,
      }, (res) => {
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
      req.setTimeout(120000, () => {
        req.destroy(new Error('Node HTTP fallback timeout'));
      });
      req.on('error', reject);
      const onAbort = () => req.destroy(abortFailure(signal));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      req.once('close', () => signal?.removeEventListener('abort', onAbort));
      if (body) req.write(body);
      req.end();
    }).catch(error => {
      if (signal?.aborted) throw abortFailure(signal);
      if (process.platform === 'win32') {
        return this.powershellJson(method, urlValue, headers, body, signal);
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
  ): Promise<NodeHttpResult> {
    if (LLMProvider.powershellTransport) {
      return LLMProvider.powershellTransport(method, urlValue, headers, body);
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
        '$params = @{ Uri = $uri; Method = $method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 120 }',
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
      const timer = setTimeout(() => {
        child.kill();
        cleanup();
        reject(new Error('PowerShell HTTP fallback timeout'));
      }, 130000);
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

  private anthropicHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  private stringifyContent(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
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
    if (!Array.isArray(value)) return this.stringifyContent(value);
    const parts: MessageContentPart[] = [];
    for (const partRaw of value) {
      const part = partRaw as Record<string, unknown>;
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text') {
        parts.push({ type: 'text', text: String(part.text || '') });
      } else if (part.type === 'image_url') {
        parts.push({ type: 'image_url', image_url: part.image_url });
      }
    }
    return parts.length ? parts : '';
  }

  private normalizeResponsesContent(value: unknown): string | MessageContentPart[] {
    if (!Array.isArray(value)) return this.stringifyContent(value);
    const parts: MessageContentPart[] = [];
    for (const partRaw of value) {
      const part = partRaw as Record<string, unknown>;
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text') {
        parts.push({ type: 'input_text', text: String(part.text || '') });
      } else if (part.type === 'image_url') {
        const image = part.image_url as Record<string, unknown> | undefined;
        const url = image && typeof image === 'object' ? String(image.url || '') : '';
        if (url) parts.push({ type: 'input_image', image_url: url });
      }
    }
    return parts.length ? parts : '';
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
    for (const msg of messages || []) {
      const role = String(msg.role || 'user');
      if (role === 'tool') {
        out.push({
          type: 'function_call_output',
          call_id: String(msg.tool_call_id || ''),
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
          const name = String(fn.name || '').trim();
          const callId = String(tc.id || tc.call_id || '');
          if (!name || !callId) continue;
          out.push({
            type: 'function_call',
            call_id: callId,
            name,
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
          });
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
    tools: unknown[] = []
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      input: this.responsesInput(messages),
      temperature,
      max_output_tokens: maxTokens,
    };
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

  private async *openAIResponsesWithTools(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    tools: unknown[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamToken> {
    const response = await this.postJsonWithFetchFallback(
      `${this.cleanBaseUrl()}/responses`,
      this.openAIHeaders(),
      this.responsesBody(model, messages, systemPrompt, temperature, maxTokens, tools),
      120000,
      signal,
    );
    if (!response.ok) {
      const err = await response.text();
      yield { type: 'text', text: this.llmErrorText(response, err) };
      return;
    }
    const json = this.normalizeResponsesPayload(await response.json());
    const text = this.extractResponsesText(json);
    let emitted = false;
    if (text) {
      emitted = true;
      yield { type: 'text', text };
    }
    const output = Array.isArray(json.output) ? json.output : [];
    for (const itemRaw of output) {
      const item = itemRaw as Record<string, unknown>;
      if (item.type !== 'function_call') continue;
      emitted = true;
      yield {
        type: 'tool_call',
        text: '',
        toolCall: {
          id: String(item.call_id || item.id || ''),
          name: String(item.name || ''),
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      };
    }
    if (!emitted && this.contentPolicyBlocked(json)) {
      yield { type: 'text', text: '[Error] Content policy refusal (content_filter).' };
    }
  }

  private async openAIResponsesChat(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.postJsonWithFetchFallback(
      `${this.cleanBaseUrl()}/responses`,
      this.openAIHeaders(),
      this.responsesBody(model, messages, systemPrompt, temperature, maxTokens),
      120000,
      signal,
    );
    if (!response.ok) {
      return this.llmErrorText(response, await response.text());
    }
    return this.extractResponsesText(this.normalizeResponsesPayload(await response.json()));
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

  async *chatStreamWithTools(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    tools: unknown[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamToken> {
    if (signal?.aborted) throw abortFailure(signal);
    if (this.protocol() === 'anthropic') {
      yield* this.anthropicChatWithTools(model, messages, systemPrompt, temperature, maxTokens, tools, signal);
      return;
    }

    const isGitHubModels = this.protocol() === 'github_models';
    const url = isGitHubModels
      ? this.githubModelsUrl('/inference/chat/completions')
      : `${this.cleanBaseUrl()}/chat/completions`;
    const body = {
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages.map(msg => ({ ...msg, content: this.normalizeOpenAIContent(msg.content) })),
      ],
      temperature,
      max_tokens: maxTokens,
      tools,
      tool_choice: 'auto',
      stream: true,
    };

    const mode = this.openAITransportMode();
    if (!isGitHubModels && mode === 'responses') {
      yield* this.openAIResponsesWithTools(model, messages, systemPrompt, temperature, maxTokens, tools, signal);
      return;
    }

    if (mode === 'chat') {
      yield* this.openAIChatWithToolsNodeFallback(url, body, signal);
      return;
    }

    const abort = new AbortController();
    const forwardAbort = () => abort.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => abort.abort(), 120000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: this.openAIHeaders(),
          body: JSON.stringify(body),
          signal: abort.signal,
        });
      } catch (e) {
        if (!this.shouldUseNodeHttpFallback(e)) throw e;
        clearTimeout(timeout);
        if (signal?.aborted) throw abortFailure(signal);
        yield* this.openAIChatWithToolsNodeFallback(url, body, signal);
        return;
      }

      if (!response.ok) {
        const err = await response.text();
        if (this.shouldUseResponsesFallback(response.status, err)) {
          clearTimeout(timeout);
          yield* this.openAIResponsesWithTools(model, messages, systemPrompt, temperature, maxTokens, tools, signal);
          return;
        }
        yield { type: 'text', text: this.llmErrorText(response, err) };
        return;
      }

      reader = response.body?.getReader() ?? null;
      if (!reader) {
        yield { type: 'text', text: '[Error] No response body' };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let currentToolCall: { id: string; name: string; arguments: string } | null = null;
      let currentReasoningContent = '';
      let contentPolicyBlocked = false;
      let emittedContent = false;

      while (true) {
        if (signal?.aborted) throw abortFailure(signal);
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ done: boolean; value?: Uint8Array }>((_, reject) =>
          setTimeout(() => reject(new Error('Stream read timeout')), 30000)
        );
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const json = JSON.parse(data);
            if (this.contentPolicyBlocked(json)) contentPolicyBlocked = true;
            const delta = json.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.reasoning_content) {
              currentReasoningContent += delta.reasoning_content;
            }

            const deltaText = this.extractTextValue(delta.content);
            if (deltaText) {
              emittedContent = true;
              yield { type: 'text', text: deltaText, reasoningContent: currentReasoningContent || undefined };
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  if (currentToolCall) {
                    yield { type: 'tool_call', text: '', toolCall: currentToolCall, reasoningContent: currentReasoningContent || undefined };
                  }
                  currentToolCall = { id: tc.id, name: tc.function?.name || '', arguments: tc.function?.arguments || '' };
                } else if (tc.function?.arguments && currentToolCall) {
                  currentToolCall.arguments += tc.function.arguments;
                }
              }
            }
          } catch { /* skip malformed JSON */ }
        }
      }

      if (currentToolCall && currentToolCall.arguments) {
        yield { type: 'tool_call', text: '', toolCall: currentToolCall, reasoningContent: currentReasoningContent || undefined };
      } else if (!emittedContent && contentPolicyBlocked) {
        yield { type: 'text', text: '[Error] Content policy refusal (content_filter).' };
      }
    } finally {
      reader?.releaseLock();
      clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async *openAIChatWithToolsNodeFallback(
    url: string,
    streamingBody: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamToken> {
    const body: Record<string, unknown> = { ...streamingBody, stream: false };
    this.transportDiagnostic('chat-tools:start');
    const response = await this.postJsonWithFetchFallback(url, this.openAIHeaders(), body, 120000, signal);
    this.transportDiagnostic('chat-tools:headers', `status=${response.status}`);
    if (!response.ok) {
      const err = await response.text();
      if (this.shouldUseResponsesFallback(response.status, err)) {
        const bodyMessages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
        const systemMessage = bodyMessages[0]?.role === 'system' ? bodyMessages[0] : null;
        yield* this.openAIResponsesWithTools(
          String(body.model || ''),
          bodyMessages.filter(m => m.role !== 'system'),
          systemMessage ? String(systemMessage.content || '') : null,
          Number(body.temperature || 0),
          Number(body.max_tokens || 0),
          Array.isArray(body.tools) ? body.tools : [],
          signal,
        );
        return;
      }
      yield { type: 'text', text: this.llmErrorText(response, err) };
      return;
    }
    const json = await response.json();
    this.transportDiagnostic('chat-tools:parsed', `tools=${Array.isArray(json?.choices?.[0]?.message?.tool_calls) ? json.choices[0].message.tool_calls.length : 0}`);
    const choice = json.choices?.[0];
    const message = choice?.message || {};
    if (message.reasoning_content) {
      yield { type: 'status', text: '', reasoningContent: String(message.reasoning_content) };
    }
    const messageText = this.extractTextValue(message.content) || this.extractTextValue(choice?.text);
    if (messageText) {
      yield { type: 'text', text: messageText, reasoningContent: message.reasoning_content ? String(message.reasoning_content) : undefined };
    }
    for (const tc of message.tool_calls || []) {
      this.transportDiagnostic('chat-tools:yield', `name=${String(tc.function?.name || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'tool'}`);
      yield {
        type: 'tool_call',
        text: '',
        toolCall: {
          id: String(tc.id || ''),
          name: String(tc.function?.name || ''),
          arguments: String(tc.function?.arguments || '{}'),
        },
      };
      this.transportDiagnostic('chat-tools:yield-returned');
    }
    if (!messageText && !(message.tool_calls || []).length && this.contentPolicyBlocked(json)) {
      yield { type: 'text', text: '[Error] Content policy refusal (content_filter).' };
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

    const response = await fetch(`${this.cleanBaseUrl()}/messages`, {
      method: 'POST',
      headers: this.anthropicHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const err = await response.text();
      yield { type: 'text', text: this.llmErrorText(response, err) };
      return;
    }

    const json = await response.json() as { content?: Array<Record<string, unknown>> };
    for (const block of json.content || []) {
      const type = String(block.type || '');
      if (type === 'text' && block.text) {
        const text = this.extractTextValue(block.text);
        if (text) yield { type: 'text', text };
      } else if (type === 'thinking' && block.thinking) {
        yield { type: 'status', text: '', reasoningContent: String(block.thinking) };
      } else if (type === 'tool_use') {
        yield {
          type: 'tool_call',
          text: '',
          toolCall: {
            id: String(block.id || ''),
            name: String(block.name || ''),
            arguments: JSON.stringify(block.input || {}),
          },
        };
      }
    }
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
      const response = await this.postJsonWithFetchFallback(`${this.cleanBaseUrl()}/messages`, this.anthropicHeaders(), body, 120000, signal);
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
      const response = await this.postJsonWithFetchFallback(`${this.cleanBaseUrl()}/responses`, this.openAIHeaders(), body, 120000, signal);
      if (!response.ok) throw new Error(this.llmErrorText(response, await response.text()));
      return this.extractResponsesText(this.normalizeResponsesPayload(await response.json()));
    }

    const isGitHubModels = this.protocol() === 'github_models';
    const url = isGitHubModels
      ? this.githubModelsUrl('/inference/chat/completions')
      : `${this.cleanBaseUrl()}/chat/completions`;
    const body = {
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages.map(message => ({ ...message, content: this.normalizeOpenAIContent(message.content) })),
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
        url = `${this.cleanBaseUrl()}/messages`;
        headers = this.anthropicHeaders();
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
        url = `${this.cleanBaseUrl()}/responses`;
        headers = this.openAIHeaders();
        body = { ...this.responsesBody(model, messages, systemPrompt, temperature, maxTokens), stream: true };
        family = 'openai_responses';
      } else {
        const isGitHubModels = this.protocol() === 'github_models';
        url = isGitHubModels
          ? this.githubModelsUrl('/inference/chat/completions')
          : `${this.cleanBaseUrl()}/chat/completions`;
        headers = isGitHubModels ? this.githubModelsHeaders() : this.openAIHeaders();
        body = {
          model,
          messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            ...messages.map(message => ({ ...message, content: this.normalizeOpenAIContent(message.content) })),
          ],
          temperature,
          max_tokens: maxTokens,
          stream: true,
        };
        family = 'openai_chat';
      }

      const response = await fetch(url, {
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

      const response = await this.postJsonWithFetchFallback(`${this.cleanBaseUrl()}/messages`, this.anthropicHeaders(), body, 120000, signal);

      if (!response.ok) {
        throw new Error(this.llmErrorText(response, await response.text()));
      }

      const json = await response.json() as { content?: Array<Record<string, unknown>> };
      return (json.content || [])
        .filter(block => block.type === 'text' && block.text)
        .map(block => this.extractTextValue(block.text))
        .join('');
    }

    const isGitHubModels = this.protocol() === 'github_models';
    const url = isGitHubModels
      ? this.githubModelsUrl('/inference/chat/completions')
      : `${this.cleanBaseUrl()}/chat/completions`;
    const body = {
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages.map(msg => ({ ...msg, content: this.normalizeOpenAIContent(msg.content) })),
      ],
      temperature,
      max_tokens: maxTokens,
    };

    if (!isGitHubModels && this.openAITransportMode() === 'responses') {
      return await this.openAIResponsesChat(model, messages, systemPrompt, temperature, maxTokens, signal);
    }

    const response = await this.postJsonWithFetchFallback(url, this.openAIHeaders(), body, 120000, signal);

    if (!response.ok) {
      const err = await response.text();
      if (!isGitHubModels && this.shouldUseResponsesFallback(response.status, err)) {
        return await this.openAIResponsesChat(model, messages, systemPrompt, temperature, maxTokens, signal);
      }
      throw new Error(this.llmErrorText(response, err));
    }

    const json = await response.json() as Record<string, unknown>;
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
      `${this.cleanBaseUrl()}/models`,
      this.protocol() === 'anthropic' ? this.anthropicHeaders() : { 'Authorization': `Bearer ${this.apiKey}` },
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
      const response = await this.postJsonWithFetchFallback(`${this.cleanBaseUrl()}/images/generations`, this.openAIHeaders(), {
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
    const response = await this.postJsonWithFetchFallback(`${this.cleanBaseUrl()}/images/generations`, this.openAIHeaders(), {
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
