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

export type ProviderProtocol = 'openai' | 'anthropic';
export type OpenAITransportMode = 'chat_stream' | 'chat' | 'responses';

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
};

export class LLMProvider {
  static nodeHttpTransport: ((method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: string) => Promise<{ status: number; body: string }>) | null = null;
  static powershellTransport: ((method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: string) => Promise<{ status: number; body: string }>) | null = null;

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

  private openAIHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  private async postJsonWithFetchFallback(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    timeoutMs = 120000
  ): Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }> {
    const abort = new AbortController();
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
      if (!this.shouldUseNodeHttpFallback(e)) throw e;
      const fallback = await this.nodeHttpJson('POST', url, headers, JSON.stringify(body));
      return {
        ok: fallback.status >= 200 && fallback.status < 300,
        status: fallback.status,
        text: async () => fallback.body,
        json: async () => JSON.parse(fallback.body || '{}'),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJsonWithFetchFallback(
    url: string,
    headers: Record<string, string>,
    timeoutMs = 30000
  ): Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }> {
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
    body = ''
  ): Promise<{ status: number; body: string }> {
    if (LLMProvider.nodeHttpTransport) {
      return LLMProvider.nodeHttpTransport(method, urlValue, headers, body).catch(error => {
        if (process.platform === 'win32') {
          return this.powershellJson(method, urlValue, headers, body);
        }
        throw error;
      });
    }
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
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
        res.on('data', chunk => { responseBody += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: responseBody }));
      });
      req.setTimeout(120000, () => {
        req.destroy(new Error('Node HTTP fallback timeout'));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    }).catch(error => {
      if (process.platform === 'win32') {
        return this.powershellJson(method, urlValue, headers, body);
      }
      throw error;
    });
  }

  private powershellJson(
    method: 'GET' | 'POST',
    urlValue: string,
    headers: Record<string, string>,
    body = ''
  ): Promise<{ status: number; body: string }> {
    if (LLMProvider.powershellTransport) {
      return LLMProvider.powershellTransport(method, urlValue, headers, body);
    }
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
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
        cleanup();
        reject(error);
      });
      child.on('close', code => {
        clearTimeout(timer);
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
      const normalizedRole = role === 'assistant' || role === 'system' ? role : 'user';
      out.push({ role: normalizedRole, content: this.stringifyContent(msg.content) });
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
    if (json.output_text) return String(json.output_text);
    const chunks: string[] = [];
    const output = Array.isArray(json.output) ? json.output : [];
    for (const itemRaw of output) {
      const item = itemRaw as Record<string, unknown>;
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const blockRaw of item.content) {
          const block = blockRaw as Record<string, unknown>;
          if ((block.type === 'output_text' || block.type === 'text') && block.text) {
            chunks.push(String(block.text));
          }
        }
      }
    }
    return chunks.join('');
  }

  private async *openAIResponsesWithTools(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    tools: unknown[]
  ): AsyncGenerator<StreamToken> {
    const response = await this.postJsonWithFetchFallback(
      `${this.cleanBaseUrl()}/responses`,
      this.openAIHeaders(),
      this.responsesBody(model, messages, systemPrompt, temperature, maxTokens, tools)
    );
    if (!response.ok) {
      const err = await response.text();
      yield { type: 'text', text: `[LLM Error: ${response.status}] ${err}` };
      return;
    }
    const json = await response.json() as Record<string, unknown>;
    const text = this.extractResponsesText(json);
    if (text) yield { type: 'text', text };
    const output = Array.isArray(json.output) ? json.output : [];
    for (const itemRaw of output) {
      const item = itemRaw as Record<string, unknown>;
      if (item.type !== 'function_call') continue;
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
  }

  private async openAIResponsesChat(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number
  ): Promise<string> {
    const response = await this.postJsonWithFetchFallback(
      `${this.cleanBaseUrl()}/responses`,
      this.openAIHeaders(),
      this.responsesBody(model, messages, systemPrompt, temperature, maxTokens)
    );
    if (!response.ok) {
      throw new Error(`LLM Error: ${response.status} ${await response.text()}`);
    }
    return this.extractResponsesText(await response.json() as Record<string, unknown>);
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

      out.push({ role: 'user', content: this.stringifyContent(msg.content) });
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
    tools: unknown[]
  ): AsyncGenerator<StreamToken> {
    if (this.protocol() === 'anthropic') {
      yield* this.anthropicChatWithTools(model, messages, systemPrompt, temperature, maxTokens, tools);
      return;
    }

    const url = `${this.cleanBaseUrl()}/chat/completions`;
    const body = {
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
      ],
      temperature,
      max_tokens: maxTokens,
      tools,
      tool_choice: 'auto',
      stream: true,
    };

    const mode = this.openAITransportMode();
    if (mode === 'responses') {
      yield* this.openAIResponsesWithTools(model, messages, systemPrompt, temperature, maxTokens, tools);
      return;
    }

    if (mode === 'chat') {
      yield* this.openAIChatWithToolsNodeFallback(url, body);
      return;
    }

    const abort = new AbortController();
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
        yield* this.openAIChatWithToolsNodeFallback(url, body);
        return;
      }

      if (!response.ok) {
        const err = await response.text();
        if (this.shouldUseResponsesFallback(response.status, err)) {
          clearTimeout(timeout);
          yield* this.openAIResponsesWithTools(model, messages, systemPrompt, temperature, maxTokens, tools);
          return;
        }
        yield { type: 'text', text: `[LLM Error: ${response.status}] ${err}` };
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

      while (true) {
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
            const delta = json.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.reasoning_content) {
              currentReasoningContent += delta.reasoning_content;
            }

            if (delta.content) {
              yield { type: 'text', text: delta.content, reasoningContent: currentReasoningContent || undefined };
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
      }
    } finally {
      reader?.releaseLock();
      clearTimeout(timeout);
    }
  }

  private async *openAIChatWithToolsNodeFallback(
    url: string,
    streamingBody: Record<string, unknown>
  ): AsyncGenerator<StreamToken> {
    const body: Record<string, unknown> = { ...streamingBody, stream: false };
    const response = await this.postJsonWithFetchFallback(url, this.openAIHeaders(), body);
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
          Array.isArray(body.tools) ? body.tools : []
        );
        return;
      }
      yield { type: 'text', text: `[LLM Error: ${response.status}] ${err}` };
      return;
    }
    const json = await response.json();
    const choice = json.choices?.[0];
    const message = choice?.message || {};
    if (message.reasoning_content) {
      yield { type: 'status', text: '', reasoningContent: String(message.reasoning_content) };
    }
    if (message.content) {
      yield { type: 'text', text: String(message.content), reasoningContent: message.reasoning_content ? String(message.reasoning_content) : undefined };
    }
    for (const tc of message.tool_calls || []) {
      yield {
        type: 'tool_call',
        text: '',
        toolCall: {
          id: String(tc.id || ''),
          name: String(tc.function?.name || ''),
          arguments: String(tc.function?.arguments || '{}'),
        },
      };
    }
  }

  private async *anthropicChatWithTools(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number,
    tools: unknown[]
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
    });

    if (!response.ok) {
      const err = await response.text();
      yield { type: 'text', text: `[LLM Error: ${response.status}] ${err}` };
      return;
    }

    const json = await response.json() as { content?: Array<Record<string, unknown>> };
    for (const block of json.content || []) {
      const type = String(block.type || '');
      if (type === 'text' && block.text) {
        yield { type: 'text', text: String(block.text) };
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

  async chat(
    model: string,
    messages: Array<Record<string, unknown>>,
    systemPrompt: string | null,
    temperature: number,
    maxTokens: number
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

      const response = await this.postJsonWithFetchFallback(`${this.cleanBaseUrl()}/messages`, this.anthropicHeaders(), body);

      if (!response.ok) {
        throw new Error(`LLM Error: ${response.status} ${await response.text()}`);
      }

      const json = await response.json() as { content?: Array<Record<string, unknown>> };
      return (json.content || [])
        .filter(block => block.type === 'text' && block.text)
        .map(block => String(block.text))
        .join('');
    }

    const url = `${this.cleanBaseUrl()}/chat/completions`;
    const body = {
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
      ],
      temperature,
      max_tokens: maxTokens,
    };

    if (this.openAITransportMode() === 'responses') {
      return await this.openAIResponsesChat(model, messages, systemPrompt, temperature, maxTokens);
    }

    const response = await this.postJsonWithFetchFallback(url, this.openAIHeaders(), body);

    if (!response.ok) {
      const err = await response.text();
      if (this.shouldUseResponsesFallback(response.status, err)) {
        return await this.openAIResponsesChat(model, messages, systemPrompt, temperature, maxTokens);
      }
      throw new Error(`LLM Error: ${response.status} ${err}`);
    }

    const json = await response.json();
    return json.choices?.[0]?.message?.content || '';
  }

  async listModels(): Promise<string[]> {
    const response = await this.getJsonWithFetchFallback(
      `${this.cleanBaseUrl()}/models`,
      this.protocol() === 'anthropic' ? this.anthropicHeaders() : { 'Authorization': `Bearer ${this.apiKey}` },
    );

    if (!response.ok) {
      throw new Error(`Model list error: ${response.status} ${await response.text()}`);
    }

    const json = await response.json() as { data?: Array<{ id?: string; name?: string } | string>; models?: Array<{ id?: string; name?: string } | string> };
    const rawModels = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
    return rawModels
      .map((entry) => typeof entry === 'string' ? entry : (entry.id || entry.name || ''))
      .map((name) => String(name).trim())
      .filter((name, index, all) => !!name && all.indexOf(name) === index);
  }

  async validate(model: string): Promise<{ ok: boolean; latency: number }> {
    const start = Date.now();
    try {
      const result = await this.chat(model, [{ role: 'user', content: 'Hi' }], null, 0.1, 50);
      const latency = (Date.now() - start) / 1000;
      return { ok: result.length > 0, latency };
    } catch {
      return { ok: false, latency: (Date.now() - start) / 1000 };
    }
  }
}

