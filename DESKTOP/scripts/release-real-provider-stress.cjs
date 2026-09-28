const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const https = require('https');

const repoRoot = path.resolve(__dirname, '..', '..');
const appRoot = path.resolve(__dirname, '..');
const exePath = path.resolve(process.env.NEWMARK_TEST_EXE
  || path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe'));
const keepRoot = process.env.NEWMARK_KEEP_REAL_PROVIDER_STRESS === '1';

const cliRounds = numberEnv('NEWMARK_REAL_STRESS_CLI_ROUNDS', 8);
const uiRounds = numberEnv('NEWMARK_REAL_STRESS_UI_ROUNDS', 6);
const goalRounds = numberEnv('NEWMARK_REAL_STRESS_GOAL_ROUNDS', 3);
const timeoutMs = numberEnv('NEWMARK_REAL_STRESS_TIMEOUT_MS', 180000);
const port = numberEnv('NEWMARK_REAL_STRESS_PORT', 49373);
const contextMaxTokens = numberEnv('NEWMARK_REAL_STRESS_CONTEXT_MAX_TOKENS', 128000);
const longContextTurns = numberEnv('NEWMARK_REAL_STRESS_LONG_CONTEXT_TURNS', 12);
const queueFirstResponseHoldMs = numberEnv('NEWMARK_REAL_STRESS_QUEUE_HOLD_MS', 0);
const concurrentResponseHoldMs = numberEnv('NEWMARK_REAL_STRESS_CONCURRENT_HOLD_MS', 0);
const escapeLineCount = numberEnv('NEWMARK_REAL_STRESS_ESCAPE_LINES', 20000);
const selectedScenarios = new Set(String(process.env.NEWMARK_REAL_STRESS_SCENARIOS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean));

const results = [];
let activeSecretValues = [];
let childDiagnostics = '';
let activeReleaseProcessId = 0;
let providerEvidence = { upstreamHost: '', upstreamBasePath: '', requests: [] };

function extractRequestMarker(payload) {
  const messages = Array.isArray(payload?.messages)
    ? payload.messages
    : Array.isArray(payload?.input)
      ? payload.input
      : [];
  const latestUser = [...messages].reverse().find(message => message && message.role === 'user');
  const content = latestUser?.content ?? payload?.input ?? payload?.prompt ?? '';
  const fragments = [];
  collectResponseText(content, fragments);
  const text = fragments.join('\n');
  const markers = text.match(/(?:NM_STRESS|真实_STRESS)_[A-Z0-9_]+_OK/g) || [];
  return markers.at(-1) || '';
}

function collectResponseText(value, output, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResponseText(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const key of ['delta', 'content', 'text', 'output_text', 'message', 'choices', 'output', 'data', 'parts', 'response']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) collectResponseText(value[key], output, depth + 1);
  }
}

function inspectSseRecord(line, record) {
  const value = String(line || '').trim();
  if (!value.startsWith('data:')) return;
  const data = value.slice(5).trim();
  if (!data || data === '[DONE]') return;
  try {
    const event = JSON.parse(data);
    if (typeof event.type === 'string') record.responseEventTypes.add(event.type.slice(0, 120));
    for (const choice of Array.isArray(event.choices) ? event.choices : []) {
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        record.finishReason = String(choice.finish_reason).slice(0, 80);
      }
    }
    const response = event.response && typeof event.response === 'object' ? event.response : {};
    if ((event.id || response.id) && !record.responseId) record.responseId = String(event.id || response.id).slice(0, 200);
    if (event.model || response.model) record.responseModel = String(event.model || response.model).slice(0, 160);
    if (event.type === 'response.completed' && response.status) record.finishReason = String(response.status).slice(0, 80);
    const usageRecord = event.usage ?? response.usage;
    if (usageRecord && typeof usageRecord === 'object') {
      const usage = usageRecord;
      record.responseUsage = {
        input: Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0) || 0,
        output: Number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0) || 0,
        total: Number(usage.total_tokens ?? usage.totalTokens ?? 0) || 0,
      };
    }
    const fragments = [];
    if (typeof event.type === 'string') {
      if (event.type.endsWith('.delta')) collectResponseText(event.delta ?? event.choices ?? '', fragments);
      else if (event.type === 'response.output_text.delta') collectResponseText(event.delta ?? '', fragments);
    } else {
      collectResponseText(event, fragments);
    }
    const text = fragments.join('\n');
    record.markerScanBuffer = `${record.markerScanBuffer || ''}${text}`.slice(-1024);
    const markers = record.markerScanBuffer.match(/(?:NM_STRESS|真实_STRESS)_[A-Z0-9_]+_OK/g) || [];
    for (const marker of markers) record.responseMarkers.add(marker);
  } catch {}
}

async function createProviderEvidenceProxy(provider) {
  const upstream = new URL(provider.baseUrl);
  if (upstream.protocol !== 'https:') throw new Error(`real provider evidence proxy requires HTTPS upstream, received ${upstream.protocol}`);
  const upstreamBasePath = upstream.pathname.replace(/\/+$/, '') || '';
  const requests = [];
  const server = http.createServer(async (incoming, outgoing) => {
    const startMs = Date.now();
    const requestId = crypto.randomUUID();
    const record = {
      requestId,
      startedAtMs: startMs,
      upstreamHost: upstream.host,
      method: incoming.method || 'POST',
      requestModel: '',
      requestMarker: '',
      requestStream: false,
      responseHoldMs: 0,
      statusCode: 0,
      responseId: '',
      responseModel: '',
      responseUsage: null,
      responseMarkers: new Set(),
      responseEventTypes: new Set(),
      finishReason: '',
      firstByteMs: null,
      clientFirstByteMs: null,
      upstreamElapsedMs: null,
      completedAtMs: null,
      elapsedMs: null,
      errorClass: '',
    };
    requests.push(record);
    const finishProxyResponse = () => {
      if (record.elapsedMs !== null) return;
      record.completedAtMs = Date.now();
      record.elapsedMs = record.completedAtMs - startMs;
    };
    outgoing.once('finish', finishProxyResponse);
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const requestBody = Buffer.concat(chunks);
      let parsed = {};
      try { parsed = JSON.parse(requestBody.toString('utf8')); } catch {}
      record.requestModel = String(parsed.model || '').slice(0, 160);
      record.requestMarker = extractRequestMarker(parsed);
      record.requestStream = parsed.stream === true;
      if (queueFirstResponseHoldMs > 0 && record.requestStream && record.requestMarker === 'NM_STRESS_QUEUE_FIRST_OK') {
        record.responseHoldMs = queueFirstResponseHoldMs;
      } else if (concurrentResponseHoldMs > 0 && record.requestStream && /^NM_STRESS_RUNNING_[AB]_[12]_OK$/.test(record.requestMarker)) {
        record.responseHoldMs = concurrentResponseHoldMs;
      }
      const incomingUrl = new URL(incoming.url || '/', 'http://127.0.0.1');
      const prefix = incomingUrl.pathname.startsWith(upstreamBasePath)
        ? incomingUrl.pathname.slice(upstreamBasePath.length)
        : incomingUrl.pathname;
      const remotePath = `${upstreamBasePath}${prefix || '/'}${incomingUrl.search}`;
      const headers = { ...incoming.headers };
      for (const key of ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding']) delete headers[key];
      headers['accept-encoding'] = 'identity';
      headers['content-length'] = String(requestBody.length);
      const remoteRequest = https.request({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || 443,
        method: incoming.method || 'POST',
        path: remotePath,
        headers,
      }, remoteResponse => {
        record.statusCode = Number(remoteResponse.statusCode || 0);
        const responseHoldMs = record.statusCode >= 200 && record.statusCode < 300 ? record.responseHoldMs : 0;
        if (record.firstByteMs === null) record.firstByteMs = Date.now() - startMs;
        const responseHeaders = { ...remoteResponse.headers };
        for (const key of ['connection', 'transfer-encoding']) delete responseHeaders[key];
        outgoing.writeHead(record.statusCode || 502, responseHeaders);
        let pendingLines = '';
        let responseEnded = false;
        let heldChunks = responseHoldMs > 0 ? [] : null;
        let holdTimer = null;
        const releaseHeldResponse = () => {
          if (!heldChunks) return;
          const chunksToWrite = heldChunks;
          heldChunks = null;
          if (holdTimer) clearTimeout(holdTimer);
          if (chunksToWrite.length && record.clientFirstByteMs === null) {
            record.clientFirstByteMs = Date.now() - startMs;
          }
          for (const chunk of chunksToWrite) {
            if (outgoing.destroyed) break;
            outgoing.write(chunk);
          }
          if (responseEnded && !outgoing.destroyed) outgoing.end();
        };
        if (responseHoldMs > 0) holdTimer = setTimeout(releaseHeldResponse, responseHoldMs);
        remoteResponse.on('data', chunk => {
          if (record.firstByteMs === null) record.firstByteMs = Date.now() - startMs;
          const text = Buffer.from(chunk).toString('utf8');
          pendingLines += text;
          const lines = pendingLines.split(/\r?\n/);
          pendingLines = lines.pop() || '';
          for (const line of lines) inspectSseRecord(line, record);
          if (heldChunks) heldChunks.push(Buffer.from(chunk));
          else if (!outgoing.destroyed) {
            if (record.clientFirstByteMs === null) record.clientFirstByteMs = Date.now() - startMs;
            outgoing.write(chunk);
          }
        });
        remoteResponse.on('end', () => {
          if (pendingLines) inspectSseRecord(pendingLines, record);
          record.upstreamElapsedMs = Date.now() - startMs;
          responseEnded = true;
          if (!heldChunks && !outgoing.destroyed) outgoing.end();
        });
        remoteResponse.on('error', error => {
          if (record.elapsedMs !== null) return;
          record.errorClass = error?.name || 'UpstreamResponseError';
          record.upstreamElapsedMs = Date.now() - startMs;
          if (holdTimer) clearTimeout(holdTimer);
          heldChunks = null;
          if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' });
          if (!outgoing.destroyed) outgoing.end('upstream response stream failed');
        });
      });
      remoteRequest.on('error', error => {
        if (record.elapsedMs !== null) return;
        record.errorClass = error?.name || 'UpstreamRequestError';
        record.upstreamElapsedMs = Date.now() - startMs;
        if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' });
        if (!outgoing.destroyed) outgoing.end('upstream request failed');
      });
      outgoing.on('close', () => {
        if (!outgoing.writableFinished) finishProxyResponse();
        if (!outgoing.writableFinished && remoteRequest.destroy) remoteRequest.destroy();
      });
      remoteRequest.end(requestBody);
    } catch (error) {
      record.errorClass = error?.name || 'ProxyRequestError';
      record.upstreamElapsedMs = Date.now() - startMs;
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' });
      if (!outgoing.destroyed) outgoing.end('provider evidence proxy failed');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('provider evidence proxy did not bind a TCP port');
  const localBaseUrl = `http://127.0.0.1:${address.port}${upstreamBasePath}`;
  providerEvidence = {
    upstreamHost: upstream.host,
    upstreamBasePath,
    expectedProviderId: provider.name,
    expectedModelId: provider.model,
    requests,
  };
  return {
    localBaseUrl,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

function serializableProviderEvidence() {
  return providerEvidence.requests.map(record => ({
    requestId: record.requestId,
    startedAtMs: record.startedAtMs,
    completedAtMs: record.completedAtMs,
    elapsedMs: record.elapsedMs,
    upstreamElapsedMs: record.upstreamElapsedMs,
    firstByteMs: record.firstByteMs,
    clientFirstByteMs: record.clientFirstByteMs,
    upstreamHost: record.upstreamHost,
    method: record.method,
    requestModel: record.requestModel,
    requestMarker: record.requestMarker,
    statusCode: record.statusCode,
    responseId: record.responseId,
    responseModel: record.responseModel,
    responseUsage: record.responseUsage,
    responseMarkers: [...record.responseMarkers],
    responseEventTypes: [...record.responseEventTypes],
    requestStream: record.requestStream,
    responseHoldMs: record.responseHoldMs,
    finishReason: record.finishReason,
    errorClass: record.errorClass,
  }));
}

function numberEnv(name, fallback) {
  const raw = Number(process.env[name] || '');
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function log(message) {
  console.log(`[release-real-provider-stress] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function redact(text) {
  let out = String(text || '');
  for (const secret of activeSecretValues) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  out = out.replace(/sk-[A-Za-z0-9_\-.]{8,}/g, 'sk-***REDACTED***');
  out = out.replace(/Bearer\s+[A-Za-z0-9_\-.=:/+]{8,}/gi, 'Bearer <redacted>');
  return out;
}

function providerFromEnv() {
  const stressKey = process.env.NEWMARK_REAL_STRESS_KEY || '';
  const stressBaseUrl = process.env.NEWMARK_REAL_STRESS_BASE_URL || '';
  const stressModel = process.env.NEWMARK_REAL_STRESS_MODEL || '';
  const stressProtocol = normalizeProtocol(process.env.NEWMARK_REAL_STRESS_PROTOCOL || '');
  if (stressKey && stressBaseUrl && stressModel) {
    const normalizedStressBaseUrl = stressBaseUrl.replace(/^https:\/\/api\.apinebula\.com\/v1\/?$/i, 'https://apinebula.com/v1');
    return {
      source: 'NEWMARK_REAL_STRESS_*',
      name: process.env.NEWMARK_REAL_STRESS_PROVIDER || 'RealStressProvider',
      baseUrl: normalizedStressBaseUrl,
      apiKey: stressKey,
      model: stressModel,
      protocol: stressProtocol || inferProtocol(normalizedStressBaseUrl, 'RealStressProvider'),
    };
  }

  const anthropicKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
  const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || '';
  const anthropicModel = process.env.ANTHROPIC_MODEL
    || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    || '';
  if (anthropicKey && anthropicBaseUrl && anthropicModel) {
    return {
      source: 'ANTHROPIC_*',
      name: 'AnthropicRealStress',
      baseUrl: anthropicBaseUrl,
      apiKey: anthropicKey,
      model: anthropicModel,
      protocol: 'anthropic',
    };
  }

  const apiNebulaKey = process.env.NEWMARK_APINEBULA_KEY || process.env.NEWMARK_REAL_API_KEY || '';
  const apiNebulaBaseUrl = process.env.NEWMARK_APINEBULA_BASE_URL || 'https://apinebula.com/v1';
  const apiNebulaModel = process.env.NEWMARK_APINEBULA_MODEL || '';
  if (apiNebulaKey && apiNebulaModel) {
    return {
      source: 'NEWMARK_APINEBULA_*',
      name: process.env.NEWMARK_APINEBULA_PROVIDER || 'APInebulaRealStress',
      baseUrl: apiNebulaBaseUrl,
      apiKey: apiNebulaKey,
      model: apiNebulaModel,
      protocol: 'openai',
    };
  }

  return null;
}

function normalizeProtocol(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (raw === 'openai' || raw === 'openai-compatible') return 'openai';
  if (raw === 'anthropic' || raw === 'claude') return 'anthropic';
  return '';
}

function inferProtocol(baseUrl, name) {
  const marker = `${baseUrl} ${name}`.toLowerCase();
  return marker.includes('anthropic') || marker.includes('claude') ? 'anthropic' : 'openai';
}

function classifyFailure(error) {
  const text = String(error && (error.stack || error.message || error) || '');
  if (error && error.failureClass) return error.failureClass;
  if (/conversation title generation failed|first Agent request was not started/i.test(text)) return 'conversation-title-failed';
  if (providerEvidence.requests.some(request => Number(request.statusCode) === 429)
    || /rate.?limit|quota|balance|insufficient|too many requests/i.test(text)
    || /\b(?:HTTP\s+(?:status(?:\s+code)?\s*)?|status(?:\s+code)?\s*[:=]?\s*)429\b/i.test(text)) return 'provider-limit';
  if (/\b(?:HTTP|status(?: code)?)\s*[:=]?\s*(?:401|403|5\d\d)\b|service unavailable|bad gateway/i.test(text)) return 'provider-http-error';
  if (/timed out|timeout|CDP timeout|waiting for/i.test(text)) return 'app-timeout-or-provider-timeout';
  if (/conversation [AB] (?:response contained [AB] marker|state leaked [AB] marker|response id mismatch)|backend send conversation mismatch|conversation[- ]leak|串话/i.test(text)) return 'conversation-leak';
  if (/UTF-8|UTF8|encoding/i.test(text)) return 'encoding-error';
  if (/process[- ]leak|left a packaged|remaining (?:packaged )?process/i.test(text)) return 'process-leak';
  if (activeSecretValues.some(secret => secret && text.includes(secret))
    || /\b(?:api[ _-]?key|secret(?:[ _-]?(?:key|value))?|access[ _-]?token|bearer|token[ _-]?leak(?:ed)?|key[ _-]?leak(?:ed)?)\b/i.test(text)) return 'secret-leak';
  return 'app-or-provider-error';
}

async function recordScenario(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const elapsedMs = Date.now() - started;
    const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail || {});
    results.push({ name, status: 'pass', elapsedMs, detail: redact(detailText) });
    log(`${name} ok (${elapsedMs} ms)`);
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const rootCause = classifyFailure(error);
    results.push({
      name,
      status: 'fail',
      elapsedMs,
      rootCause,
      detail: redact(error && (error.stack || error.message) || error),
    });
    log(`${name} failed (${rootCause}, ${elapsedMs} ms): ${redact(error && (error.stack || error.message) || error).replace(/\r?\n/g, ' ').slice(0, 3000)}`);
  }
}

function writeConfig(root, provider) {
  const config = {
    models: {
      providers: [{
        name: provider.name,
        base_url: provider.baseUrl,
        api_key: provider.apiKey,
        protocol: provider.protocol,
        enabled: true,
        models: [{
          name: provider.model,
          display: provider.model,
          description: 'Opt-in real provider stress model',
           max_tokens: contextMaxTokens,
           evaluation: { status: 'available', latency: 0 },
        }],
      }],
      default_model: provider.model,
      default_intelligence: 'low',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
      openai_api_mode: 'chat_stream',
    },
    agent: {
      default_mode: 'build',
      option_feedback: 'fully_autonomous',
      goal_max_continuations: Math.max(2, goalRounds + 2),
    },
    terminal: { interrupt_timeout_ms: 0 },
    context: { auto_compress: true },
    general: { language: 'en' },
    workspace: {
      auto_create_timestamp_workspace: true,
      prompt_mode: 'both',
      access_permission: 'full_access',
      on_permission_violation: 'deny',
    },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function runPowerShellCli(args, root, extraEnv = {}, commandTimeoutMs = timeoutMs) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-real-stress-cli-'));
  const stdoutPath = path.join(workDir, 'stdout.txt');
  const stderrPath = path.join(workDir, 'stderr.txt');
  const scriptPath = path.join(workDir, 'run.ps1');
  const argList = args.map(psQuote).join(', ');
  fs.writeFileSync(scriptPath, [
    '$ErrorActionPreference = "Stop"',
    `$exe = ${psQuote(exePath)}`,
    `$argList = @(${argList})`,
    `$stdout = ${psQuote(stdoutPath)}`,
    `$stderr = ${psQuote(stderrPath)}`,
    '$p = Start-Process -FilePath $exe -ArgumentList $argList -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr',
    'exit $p.ExitCode',
  ].join('\r\n'), 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: appRoot,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let psStdout = '';
    let psStderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { psStdout += chunk; });
    child.stderr.on('data', chunk => { psStderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`PowerShell timed out for ${args[0]}. stdout=${redact(psStdout)} stderr=${redact(psStderr)}`));
    }, commandTimeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`PowerShell failed for ${args[0]}: ${error.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
      const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
      fs.rmSync(workDir, { recursive: true, force: true });
      if (code !== 0) {
        reject(new Error(`CLI ${args[0]} exited ${code}. stdout=${redact(stdout || psStdout)} stderr=${redact(stderr || psStderr)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function markerPrompt(marker, index) {
  if (index % 3 === 1) return `Reply with this exact marker as the first line: ${marker}\nNo tools.`;
  if (index % 3 === 2) return `请将这个精确标记作为第一行回复：${marker}\n不要使用工具。`;
  return [
    `Reply with this exact marker as the first line: ${marker}\nNo tools.`,
    'Context block:',
    'Newmark release real provider stress '.repeat(120),
  ].join('\n');
}

async function runCliStress(root, provider) {
  const state = await runPowerShellCli(['state', '--root', root], root);
  if (state.stdout.includes(provider.apiKey)) throw new Error('state leaked API key');
  const parsedState = JSON.parse(state.stdout);
  if (parsedState.model !== provider.model) throw new Error(`state loaded ${parsedState.model}, expected ${provider.model}`);

  for (let i = 1; i <= cliRounds; i++) {
    const marker = i % 3 === 2 ? `真实_STRESS_CLI_${i}_OK` : `NM_STRESS_CLI_${i}_OK`;
    const promptFile = path.join(root, `stress-cli-${i}.txt`);
    fs.writeFileSync(promptFile, markerPrompt(marker, i), 'utf8');
    const args = ['send', '--input-file', promptFile, '--mode', 'build', '--model', provider.model, '--conversation', `stress-cli-${i}`, '--root', root];
    if (i % 3 === 2) args.splice(args.length - 2, 0, '--language', 'zh');
    log(`cli-round ${i}/${cliRounds} start`);
    let send;
    try {
      send = await runPowerShellCli(args, root, {}, timeoutMs);
    } catch (error) {
      throw new Error(`CLI round ${i}/${cliRounds} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (send.stdout.includes(provider.apiKey)) throw new Error(`CLI round ${i} leaked API key`);
    if (!send.stdout.includes(marker)) throw new Error(`CLI round ${i} missing marker ${marker}: ${redact(send.stdout).slice(0, 1000)}`);
    log(`cli-round ${i}/${cliRounds} ok`);
  }
  return `rounds=${cliRounds}`;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitForTarget() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(500);
  }
  throw new Error('Timed out waiting for Electron CDP target');
}

function connectCdp(target) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  function call(method, params = {}, callTimeoutMs = 15000) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, callTimeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
  }
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const callbacks = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(callbacks.timer);
      if (message.error) callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else callbacks.resolve(message.result);
    };
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression, callTimeoutMs = 15000) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, callTimeoutMs);
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const message = details.exception?.description || details.text || JSON.stringify(details);
    throw new Error(`Runtime.evaluate exception: ${message}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, waitTimeoutMs, label, pollIntervalMs = 500) {
  const deadline = Date.now() + waitTimeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await evaluate(cdp, expression, 10000);
    } catch (error) {
      lastValue = error.message;
      await sleep(Math.max(10, Number(pollIntervalMs) || 500));
      continue;
    }
    // Keep terminal application errors outside the transient CDP retry catch.
    if (lastValue && lastValue.__newmarkStressTerminal) {
      const failure = lastValue.__newmarkStressTerminal;
      const error = new Error(`Tested run ${failure.runId} terminated (${failure.status}) before ${label}: ${failure.message}`);
      error.failureClass = classifyFailure(new Error(failure.message));
      if (error.failureClass === 'app-or-provider-error') error.failureClass = failure.status === 'error' ? 'run-terminal-error' : 'run-interrupted';
      error.terminalRun = failure;
      throw error;
    }
    if (lastValue) return lastValue;
    await sleep(Math.max(10, Number(pollIntervalMs) || 500));
  }
  throw new Error(`Timed out waiting for ${label}; last=${redact(JSON.stringify(lastValue)).slice(0, 1000)}`);
}

function jsString(value) {
  return JSON.stringify(String(value));
}

function capturePromptAttempt(state, requestedTarget, prompt) {
  const target = {
    workspaceId: String(requestedTarget?.workspaceId || state?.target?.workspaceId || state?.workspaceId || state?.workspaces?.current?.id || ''),
    conversationId: String(requestedTarget?.conversationId || state?.conversationId || state?.target?.conversationId || ''),
  };
  if (!target.workspaceId || !target.conversationId) throw new Error('Cannot capture the tested prompt target');
  return {
    target,
    prompt: String(prompt),
    previousRunIds: [...new Set([...(state?.workRuns || []), ...(state?.chatMessages || []), state?.runtime].map(item => item?.runId).filter(Boolean))],
  };
}

// This pure function also runs in the renderer expression below. Never infer a
// failure from an old run, another target, or a transient error while still busy.
function terminalPromptFailure(state, attempt) {
  if (!state || !attempt || state.runtime?.running !== false) return null;
  const workspaceId = String(state.target?.workspaceId || state.workspaceId || state.workspaces?.current?.id || '');
  const conversationId = String(state.conversationId || state.target?.conversationId || '');
  if (workspaceId !== attempt.target.workspaceId || conversationId !== attempt.target.conversationId) return null;
  const previous = new Set(attempt.previousRunIds || []);
  const run = (state.workRuns || []).find(item => {
    if (!item?.runId || previous.has(item.runId) || state.runtime.runId !== item.runId) return false;
    if (item.target && (item.target.workspaceId !== workspaceId || item.target.conversationId !== conversationId)) return false;
    const promptMatches = String(item.primaryPrompt || '') === attempt.prompt
      || (state.chatMessages || []).some(message => message?.role === 'user' && message.runId === item.runId && String(message.content || '') === attempt.prompt);
    return promptMatches && ['error', 'interrupted', 'force_interrupted'].includes(item.status);
  });
  if (!run) return null;
  const errors = (run.events || []).filter(event => event?.type === 'error').map(event => String(event.content || '')).filter(Boolean);
  return { runId: run.runId, target: attempt.target, status: run.status, message: errors.join('\n').slice(-6000) || `Run ended with status ${run.status}` };
}

function terminalAttemptExpression(attempt) {
  return attempt ? `const terminal = (${terminalPromptFailure.toString()})(s, ${JSON.stringify(attempt)});
    if (terminal) return { __newmarkStressTerminal: terminal };` : '';
}

function assistantMarkerExpression(marker, conversationId = '', attempt = null) {
  const conv = conversationId ? jsString(conversationId) : 'null';
  return `window.api.getState(${attempt ? JSON.stringify(attempt.target) : ''}).then(async s => {
    ${terminalAttemptExpression(attempt)}
    const target = ${conv};
    if (target && s && s.conversationId !== target && window.api.setConversation) {
      await window.api.setConversation(target);
      s = await window.api.getState();
    }
    const messages = (s && Array.isArray(s.chatMessages)) ? s.chatMessages : [];
    const persisted = messages.some(m => m && m.role === 'assistant' && String(m.content || '').includes(${jsString(marker)}));
    const rendered = Array.from(document.querySelectorAll('.run-final-response, .conversation-work-run')).some(node => String(node.innerText || '').includes(${jsString(marker)}));
    return persisted || rendered ? s : null;
  })`;
}

function stateIdleExpression(conversationId = '', attempt = null) {
  const conv = conversationId ? jsString(conversationId) : 'null';
  return `window.api.getState(${attempt ? JSON.stringify(attempt.target) : ''}).then(async s => {
    ${terminalAttemptExpression(attempt)}
    const target = ${conv};
    if (target && s && s.conversationId !== target && window.api.setConversation) {
      await window.api.setConversation(target);
      s = await window.api.getState();
    }
    return s && s.status === 'idle' ? s : null;
  })`;
}

async function launchUi(root) {
  const child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  activeReleaseProcessId = child.pid || 0;
  const capture = chunk => {
    childDiagnostics = `${childDiagnostics}${String(chunk || '')}`.slice(-24000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const target = await waitForTarget();
  log(`connected target: ${target.title || '(untitled)'} ${target.url || ''}`);
  const cdp = connectCdp(target);
  await cdp.ready;
    await waitForPromotedMainUi(cdp);
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  await cdp.call('Page.bringToFront');
  await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.api && !!window.sendMessage && !!document.querySelector('#prompt'))()`, 30000, 'renderer ready');
  await evaluate(cdp, `window.api.createWorkspace('real-provider-stress-workspace').then(ws => window.api.selectWorkspace(ws.name))`, 30000);
  await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.name === 'real-provider-stress-workspace')`, 30000, 'workspace selected');
  return { child, cdp };
}

async function sendUiPrompt(cdp, prompt, marker, waitTimeoutMs = timeoutMs, conversationId = '') {
  const attempt = await evaluate(cdp, `(async () => {
    const target = typeof currentConversationTarget === 'function' ? currentConversationTarget() : null;
    const before = await window.api.getState(target || undefined);
    const attempt = (${capturePromptAttempt.toString()})(before, target, ${jsString(prompt)});
    if (${jsString(conversationId)} && attempt.target.conversationId !== ${jsString(conversationId)}) throw new Error('backend send conversation mismatch before UI prompt');
    const prompt = document.querySelector('#prompt');
    if (!prompt) throw new Error('missing #prompt');
    prompt.focus();
    prompt.value = ${jsString(prompt)};
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    window.sendMessage();
    return attempt;
  })()`, 30000);
  try {
    await waitFor(cdp, assistantMarkerExpression(marker, conversationId, attempt), waitTimeoutMs, `assistant marker ${marker}`);
    // A rendered prompt may already contain the marker. Continue monitoring the
    // same run for a terminal error while retaining the existing idle check.
    const state = await waitFor(cdp, stateIdleExpression(conversationId, attempt), 60000, `idle after ${marker}`);
    const stateText = JSON.stringify(state || {});
    if (stateText.includes(activeSecretValues[0])) throw new Error('renderer state leaked API key');
    return state;
  } catch (error) {
    const debug = await evaluate(cdp, `(async () => {
      const state = window.state || {};
      const target = typeof currentConversationTarget === 'function' ? currentConversationTarget() : null;
      const backend = window.api && window.api.getState ? await window.api.getState(target || undefined) : null;
      const body = document.querySelector('#chat-area')?.innerText || '';
      const run = document.querySelector('.conversation-work-run')?.innerText || '';
      const finals = Array.from(document.querySelectorAll('.run-final-response')).map(node => node.innerText || '').join(' ');
      const backendSummary = backend ? {
        status: backend.status,
        mode: backend.mode,
        target,
        conversationId: backend.conversationId,
        chatMessages: (backend.chatMessages || []).slice(-4).map(message => ({ role: message.role, runId: message.runId, content: String(message.content || '').slice(-1600) })),
        workRuns: (backend.workRuns || []).slice(-3).map(item => ({ runId: item.runId, status: item.status, primaryPrompt: String(item.primaryPrompt || '').slice(-800), finalResponse: String(item.finalResponse || '').slice(-1800), events: (item.events || []).slice(-24).map(event => ({ type: event.type, toolName: event.toolName, content: String(event.content || '').slice(-700) })) })),
        pendingOptions: backend.pendingOptions || [],
        queued: backend.queued,
        runtime: backend.runtime ? { running: backend.runtime.running, stopRequested: backend.runtime.stopRequested, runId: backend.runtime.runId } : null,
      } : null;
      return {
        backend: backendSummary,
        promptValue: document.querySelector('#prompt')?.value || '',
        status: state.status,
        model: state.model,
        mode: state.mode,
        sendInFlight: state._sendInFlight,
        currentWorkspace: !!state.currentWorkspace,
        bodyTail: body.slice(-1600),
        runTail: run.slice(-1600),
        finalText: finals.slice(-1600),
        chatMessages: (state.chatMessages || []).slice(-4).map(message => ({ role: message.role, content: String(message.content || '').slice(-600) })),
        workRuns: (state.workRuns || []).slice(-2).map(item => ({ runId: item.runId, status: item.status, events: (item.events || []).slice(-4).map(event => ({ type: event.type, content: String(event.content || '').slice(-300) })) })),
        pendingOptions: state.pendingOptions || [],
        childDiagnostics: ${jsString(childDiagnostics.slice(-8000))},
      };
    })()`, 30000).catch(debugError => ({ debugError: debugError.message }));
    const detailedError = new Error(`${error.message}; uiDebug=${redact(JSON.stringify(debug)).slice(0, 5000)}`);
    detailedError.failureClass = classifyFailure(error);
    if (error.terminalRun) detailedError.terminalRun = error.terminalRun;
    throw detailedError;
  }
}

async function sendBackendPrompt(cdp, prompt, marker, conversationId, waitTimeoutMs = timeoutMs) {
  const result = await evaluate(cdp, `window.api.sendMessage(${jsString(prompt)}, ${jsString(conversationId)})`, waitTimeoutMs);
  const resultText = JSON.stringify({
    conversationId: result && result.conversationId,
    tokens: result && result.tokens,
    chatMessages: (result && result.chatMessages || []).filter(m => m && m.role === 'assistant'),
  });
  if (result?.conversationId && result.conversationId !== conversationId) {
    throw new Error(`backend send conversation mismatch: expected=${conversationId}; actual=${result.conversationId}`);
  }
  if (!result?.conversationId) {
    const attempts = providerEvidence.requests
      .filter(request => request.requestMarker === marker)
      .map(request => ({ statusCode: request.statusCode, requestId: request.requestId, errorClass: request.errorClass }));
    if (attempts.some(request => request.statusCode === 429)) {
      const error = new Error(`provider rate limit HTTP 429 prevented completion for ${marker}; upstreamStatuses=${attempts.map(request => request.statusCode).join(',') || 'unknown'}`);
      error.failureClass = 'provider-limit';
      throw error;
    }
    if (attempts.some(request => request.statusCode >= 500)) {
      const error = new Error(`provider HTTP failure prevented completion for ${marker}; upstreamStatuses=${attempts.map(request => request.statusCode).join(',') || 'unknown'}`);
      error.failureClass = 'provider-http-error';
      throw error;
    }
    throw new Error(`backend send returned no completion for ${marker}; expected conversation=${conversationId}; upstreamStatuses=${attempts.map(request => request.statusCode).join(',') || 'none'}`);
  }
  if (!resultText.includes(marker)) throw new Error(`backend assistant marker missing ${marker}: ${redact(resultText).slice(0, 1200)}`);
  if (resultText.includes(activeSecretValues[0])) throw new Error('backend send leaked API key');
  return result;
}

async function runUiStress(cdp) {
  await evaluate(cdp, `window.api.setMode ? window.api.setMode('build') : Promise.resolve()`, 30000);
  await waitFor(cdp, `window.api.getState().then(s => s && s.status === 'idle' ? true : false)`, 60000, 'ui stress initial idle');
  for (let i = 1; i <= uiRounds; i++) {
    const marker = i % 2 === 0 ? `真实_STRESS_UI_${i}_OK` : `NM_STRESS_UI_${i}_OK`;
    await sendUiPrompt(cdp, markerPrompt(marker, i), marker);
  }
  return `rounds=${uiRounds}`;
}

async function runUiEscapeStopStress(cdp) {
  const recoveryMarker = 'NM_STRESS_ESCAPE_RECOVERY_OK';
  await evaluate(cdp, `window.api.setMode ? window.api.setMode('build') : Promise.resolve()`, 30000);
  await waitFor(cdp, `window.api.getState().then(s => s && s.status === 'idle' ? true : false)`, 60000, 'Escape stress initial idle');
  await evaluate(cdp, `(() => {
    if (window.__newmarkStressStopTraceInstalled) return true;
    window.__newmarkStressStopTraceInstalled = true;
    window.__newmarkStressStopTrace = [];
    const trace = window.__newmarkStressStopTrace;
    if (window.api && window.api.stopConversation) {
      const originalApiStop = window.api.stopConversation.bind(window.api);
      window.api.stopConversation = async function(request) {
        trace.push({ phase: 'api-call', request: request || null, at: Date.now() });
        try {
          const result = await originalApiStop(request);
          trace.push({ phase: 'api-result', result: result || null, at: Date.now() });
          return result;
        } catch (error) {
          trace.push({ phase: 'api-error', error: String(error && error.message || error), at: Date.now() });
          throw error;
        }
      };
    }
    if (window.stopCurrentConversation) {
      const originalUiStop = window.stopCurrentConversation;
      window.stopCurrentConversation = async function() {
        trace.push({ phase: 'ui-call', at: Date.now() });
        try {
          const result = await originalUiStop.apply(this, arguments);
          trace.push({ phase: 'ui-result', result: result || null, at: Date.now() });
          return result;
        } catch (error) {
          trace.push({ phase: 'ui-error', error: String(error && error.message || error), at: Date.now() });
          throw error;
        }
      };
    }
    return true;
  })()`, 30000);
  await evaluate(cdp, `(() => {
    const prompt = document.querySelector('#prompt');
    if (!prompt) throw new Error('missing #prompt');
    prompt.focus();
    prompt.value = ${jsString(`Generate ${escapeLineCount} numbered lines. Begin with NM_STRESS_ESCAPE_LONG_START. Do not use tools.`)};
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    void window.sendMessage();
    return true;
  })()`, 30000);
  const runningObservation = await waitFor(cdp, `(async () => {
    const uiState = window.state || {};
    const uiRunning = typeof isCurrentConversationRunning === 'function' && isCurrentConversationRunning();
    const sendInFlight = uiState._sendInFlight === true;
    // Do not request a full work-run snapshot while the renderer is streaming
    // thousands of events: that observation can itself delay the Escape event.
    if (uiRunning || sendInFlight) return { backendStatus: 'pending', uiRunning, sendInFlight };
    const s = await window.api.getState();
    const backendRunning = s && ['working', 'stopping'].includes(String(s.status || ''));
    return backendRunning ? { backendStatus: s.status, uiRunning, sendInFlight } : null;
  })()`, 30000, 'GUI running state before global Escape', 50);
  const escapeResult = await evaluate(cdp, `(() => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const dispatched = document.body.dispatchEvent(event);
    return { dispatched, defaultPrevented: event.defaultPrevented };
  })()`, 30000);
  if (!escapeResult || escapeResult.defaultPrevented !== true) {
    throw new Error(`global Escape was not consumed: ${JSON.stringify(escapeResult)}`);
  }
  let stopped;
  try {
    stopped = await waitFor(cdp, `(async () => {
    const uiState = window.state || {};
    const target = typeof currentConversationTarget === 'function' ? currentConversationTarget() : null;
    const key = target && typeof runtimeKeyFor === 'function' ? runtimeKeyFor(target.workspaceId, target.conversationId) : '';
    const localRuntime = key && uiState.conversationRuntimeStates ? uiState.conversationRuntimeStates[key] : null;
    const localTerminal = localRuntime
      && ['interrupted', 'force_interrupted'].includes(String(localRuntime.status || ''))
      && uiState._sendInFlight !== true;
    if (localTerminal) {
      return { backendStatus: 'deferred', localStatus: localRuntime.status, backendStopped: false, provisionalCancelled: true };
    }
    const s = await window.api.getState();
    const runs = Array.isArray(s && s.workRuns) ? s.workRuns : [];
    const interrupted = runs.some(run => ['interrupted', 'force_interrupted'].includes(String(run && run.status || '')));
    const backendIdle = !s || !s.runtime || (s.runtime.running !== true && s.runtime.stopRequested !== true);
    const provisionalCancelled = localRuntime
      && String(localRuntime.status || '') === 'interrupted'
      && uiState._sendInFlight !== true
      && backendIdle;
    const backendStopped = s
      && ['idle', 'interrupted', 'force_interrupted'].includes(String(s.status || ''))
      && interrupted;
    return backendStopped || provisionalCancelled
      ? { backendStatus: s && s.status, localStatus: localRuntime && localRuntime.status, backendStopped: !!backendStopped, provisionalCancelled: !!provisionalCancelled }
      : null;
    })()`, 60000, 'GUI global Escape interruption');
  } catch (error) {
    const postEscape = await evaluate(cdp, `(() => {
      const uiState = window.state || {};
      const target = typeof currentConversationTarget === 'function' ? currentConversationTarget() : null;
      const key = target && typeof runtimeKeyFor === 'function' ? runtimeKeyFor(target.workspaceId, target.conversationId) : '';
      return {
        target,
        localRuntime: key && uiState.conversationRuntimeStates ? uiState.conversationRuntimeStates[key] : null,
        sendInFlight: uiState._sendInFlight,
        pendingProvisionalStops: uiState.pendingProvisionalStops || {},
        activeSendCalls: uiState.activeSendCallsByTarget || {},
        stopTrace: window.__newmarkStressStopTrace || []
      };
    })()`, 30000).catch(debugError => ({ debugError: debugError.message }));
    const debug = await evaluate(cdp, `(async () => {
      const uiState = window.state || {};
      const target = typeof currentConversationTarget === 'function' ? currentConversationTarget() : null;
      const key = target && typeof runtimeKeyFor === 'function' ? runtimeKeyFor(target.workspaceId, target.conversationId) : '';
      const snapshot = window.api && window.api.getState ? await window.api.getState(target || undefined) : null;
      return {
        target,
        key,
        snapshot: snapshot ? {
          status: snapshot.status,
          runtime: snapshot.runtime,
          workRuns: (snapshot.workRuns || []).slice(-4).map(run => ({ runId: run.runId, status: run.status, events: (run.events || []).slice(-6).map(event => ({ type: event.type, status: event.status, content: String(event.content || '').slice(-300) })) }))
        } : null,
        localRuntime: key && uiState.conversationRuntimeStates ? uiState.conversationRuntimeStates[key] : null,
        sendInFlight: uiState._sendInFlight,
        activeSendCalls: uiState.activeSendCallsByTarget || {},
        runningConversations: uiState.runningConversations || {},
        uiWorkRuns: key && uiState.workRunsByTarget ? (uiState.workRunsByTarget[key] || []).slice(-4).map(run => ({ runId: run.runId, status: run.status })) : []
      };
    })()`, 30000).catch(debugError => ({ debugError: debugError.message }));
    throw new Error(`${error.message}; observed=${redact(JSON.stringify(runningObservation))}; escape=${redact(JSON.stringify(escapeResult))}; postEscape=${redact(JSON.stringify(postEscape))}; stopDebug=${redact(JSON.stringify(debug)).slice(0, 5000)}`);
  }
  await sendUiPrompt(cdp, markerPrompt(recoveryMarker, 1), recoveryMarker);
  return `defaultPrevented=${escapeResult.defaultPrevented}; observed=${JSON.stringify(runningObservation)}; stop=${JSON.stringify(stopped)}`;
}

async function runGoalStress(cdp) {
  const marker = 'NM_STRESS_GOAL_COMPLETE_OK';
  const objective = [
    `Real provider Goal stress must continue for ${goalRounds} model calls.`,
    `For all non-final calls, do not include "[Goal Complete]".`,
    `On the final call, include exactly "[Goal Complete] ${marker}".`,
    `Use no tools.`,
  ].join(' ');
  await evaluate(cdp, `window.api.updateGoal(${jsString(objective)})`, 30000);
  await evaluate(cdp, `window.api.setMode ? window.api.setMode('goal') : Promise.resolve()`, 30000);
  const result = await evaluate(cdp, `window.api.sendMessage(${jsString(`Start real Goal stress. Target final marker: ${marker}`)})`, timeoutMs * Math.max(1, goalRounds + 2));
  const initialResultText = JSON.stringify({
    tokens: result && result.tokens,
    chatMessages: (result && result.chatMessages || []).filter(m => m && m.role === 'assistant'),
  });
  if (/max[- ]?depth/i.test(initialResultText)) throw new Error(`Goal stress exposed max-depth warning: ${redact(initialResultText).slice(0, 1200)}`);
  const finalState = await waitFor(cdp, `window.api.getState().then(s => {
    const assistants = (s && Array.isArray(s.chatMessages) ? s.chatMessages : []).filter(m => m && m.role === 'assistant');
    const text = JSON.stringify(assistants);
    return s && s.status === 'idle' && !s.goal && text.includes(${jsString(marker)}) ? s : null;
  })`, timeoutMs * Math.max(1, goalRounds + 2), 'Goal continuation completion marker');
  const finalText = JSON.stringify((finalState && finalState.chatMessages || []).filter(m => m && m.role === 'assistant'));
  if (/max[- ]?depth/i.test(finalText)) throw new Error(`Goal stress exposed max-depth warning: ${redact(finalText).slice(0, 1200)}`);
  const assistantCalls = (finalState && finalState.chatMessages || []).filter(m => m && m.role === 'assistant').length;
  if (assistantCalls < goalRounds) {
    const debug = {
      status: finalState && finalState.status,
      mode: finalState && finalState.mode,
      goal: finalState && finalState.goal,
      conversationId: finalState && finalState.conversationId,
      assistants: (finalState && finalState.chatMessages || [])
        .filter(m => m && m.role === 'assistant')
        .map(m => ({ runId: m.runId, content: String(m.content || '').slice(-1200) })),
      workRuns: (finalState && finalState.workRuns || []).map(run => ({
        runId: run.runId,
        status: run.status,
        primaryPrompt: String(run.primaryPrompt || '').slice(-500),
        finalResponse: String(run.finalResponse || '').slice(-1200),
        events: (run.events || []).slice(-6).map(event => ({ type: event.type, content: String(event.content || '').slice(-400) })),
      })),
    };
    throw new Error(`Goal stress stopped early: assistantCalls=${assistantCalls}; expected>=${goalRounds}; debug=${redact(JSON.stringify(debug)).slice(0, 7000)}`);
  }
  await evaluate(cdp, `window.api.setMode ? window.api.setMode('build') : Promise.resolve()`, 30000);
  await waitFor(cdp, stateIdleExpression(), 60000, 'build mode restored after Goal stress');
  return `goalRounds=${goalRounds}; assistantCalls=${assistantCalls}`;
}

async function runGoalManageToolStress(cdp) {
  const enterMarker = 'NM_STRESS_GOAL_MANAGE_ENTER_OK';
  const completeMarker = 'NM_STRESS_GOAL_MANAGE_COMPLETE_OK';
  await evaluate(cdp, 'window.api.setMode ? window.api.setMode(\'build\') : Promise.resolve()', 30000);
  await evaluate(cdp, 'window.api.clearGoal ? window.api.clearGoal() : Promise.resolve(true)', 30000);
  await waitFor(cdp, stateIdleExpression(), 60000, 'goal-manage initial idle');
  await evaluate(cdp, `(() => { const p = document.querySelector('#prompt'); if (!p) throw new Error('missing #prompt'); p.focus(); p.value = ${jsString('Call the goal_manage tool with action=enter and objective: Stress verify goal management entry. Then reply done.')}; p.dispatchEvent(new Event('input', { bubbles: true })); window.sendMessage(); return true; })()`, 30000);
  // 状态验证：等 goal 状态真正 active（模型成功调用工具后），而非等 marker。
  const entered = await waitFor(cdp, `window.api.getState().then(s => (s && s.mode === 'goal' && s.goal && String((s.goal.objective) || '').indexOf('Stress verify goal management entry') >= 0) ? s : null)`, 120000, 'goal_manage enter sets goal state');
  if (!entered) throw new Error('goal_manage enter did not set goal mode');
  await sendUiPrompt(cdp, [
    'The objective is now genuinely achieved and verified. Use the goal_manage tool with action=complete.',
    'After the tool returns, reply with this exact marker as the first line: ' + completeMarker,
    'Do not use any tool other than goal_manage.',
  ].join('\n'), completeMarker);
  const cleared = await evaluate(cdp, 'window.api.getState().then(s => ({ mode: s.mode, goal: s.goal }))', 30000);
  await evaluate(cdp, 'window.api.setMode ? window.api.setMode(\'build\') : Promise.resolve()', 30000);
  await waitFor(cdp, stateIdleExpression(), 60000, 'goal-manage return to build');
  return 'enteredMode=' + entered.mode + '; objectiveSet=' + String((entered.goal && entered.goal.objective) || '').slice(0, 40) + '; exitedMode=' + cleared.mode + '; goalAfter=' + (cleared.goal ? 'present' : 'cleared');
}

async function runConversationRenameToolStress(cdp) {
  const marker = 'NM_STRESS_CONVERSATION_RENAME_OK';
  await evaluate(cdp, 'window.api.setMode ? window.api.setMode(\'build\') : Promise.resolve()', 30000);
  await waitFor(cdp, stateIdleExpression(), 60000, 'conversation-rename initial idle');
  const before = await evaluate(cdp, 'window.api.getState().then(s => ({ conversationId: s.conversationId, conversations: s.conversations && Object.keys(s.conversations).length }))', 30000);
  await sendUiPrompt(cdp, [
    'This is the first task of this conversation. Pick a short noun-phrase title and call the conversation_rename tool with it.',
    'For this stress run use the title exactly: NM Rename Probe',
    'After the tool returns, reply with this exact marker as the first line: ' + marker,
    'Do not use any tool other than conversation_rename.',
  ].join('\n'), marker);
  const after = await evaluate(cdp, 'window.api.getState().then(s => ({ conversationId: s.conversationId, conversations: s.conversations && Object.keys(s.conversations).length }))', 30000);
  return 'conversationIdBefore=' + (before && before.conversationId) + '; conversationsBefore=' + (before && before.conversations) + '; conversationsAfter=' + (after && after.conversations);
}

async function runMultiModeSwitchStress(cdp) {
  const markers = ['NM_STRESS_MM_BUILD_OK', 'NM_STRESS_MM_PLAN_OK', 'NM_STRESS_MM_GOAL_OK', 'NM_STRESS_MM_BACK_OK'];
  await waitFor(cdp, stateIdleExpression(), 60000, 'multi-mode initial idle');
  await evaluate(cdp, 'window.api.setMode ? window.api.setMode(\'build\') : Promise.resolve()', 30000);
  await sendUiPrompt(cdp, 'Reply with this exact marker as the first line: ' + markers[0] + '\nNo tools.', markers[0]);
  await evaluate(cdp, 'window.api.setMode ? window.api.setMode(\'plan\') : Promise.resolve()', 30000);
  await waitFor(cdp, stateIdleExpression(), 60000, 'plan idle');
  await sendUiPrompt(cdp, 'Reply with this exact marker as the first line: ' + markers[1] + '\nDo not modify any files. No tools.', markers[1]);
  await evaluate(cdp, 'window.api.setMode ? window.api.setMode(\'goal\') : Promise.resolve()', 30000);
  await waitFor(cdp, stateIdleExpression(), 60000, 'goal mode idle before updateGoal');
  await evaluate(cdp, 'window.api.updateGoal ? window.api.updateGoal(\'Multi-mode goal stress probe\') : Promise.resolve()', 30000);
  await sendUiPrompt(cdp, 'Reply with this exact marker as the first line: ' + markers[2] + '\nNo tools.', markers[2]);
  // goal 语义是持续追求目标，回复 marker 不标记完成会触发 auto-continue 而不 idle；
  // 这里显式 clearGoal 打断 auto-continue，再切 build 验证 round-trip。
  await evaluate(cdp, 'window.api.setMode ? window.api.setMode(\'build\') : Promise.resolve()', 30000);
  await evaluate(cdp, 'window.api.clearGoal ? window.api.clearGoal() : Promise.resolve(true)', 30000);
  await waitFor(cdp, stateIdleExpression(), 60000, 'multi-mode final idle');
  await sendUiPrompt(cdp, 'Reply with this exact marker as the first line: ' + markers[3] + '\nNo tools.', markers[3]);
  return 'build+plan+goal+build all round-tripped';
}

async function runWebFetchReachabilityStress(cdp) {
  const marker = 'NM_STRESS_WEB_FETCH_OK';
  await evaluate(cdp, 'window.api.setMode ? window.api.setMode(\'build\') : Promise.resolve()', 30000);
  await waitFor(cdp, stateIdleExpression(), 60000, 'web-fetch initial idle');
  const prompt = 'Use the web_fetch tool to read https://example.com and report the domain name shown on that page. If the page is reachable and shows Example Domain, reply with this exact marker as the first line: ' + marker + '. Then on a new line write the domain name you found. Use only the web_fetch tool.';
  await sendUiPrompt(cdp, prompt, marker);
  return 'web_fetch reached example.com and reported Example Domain';
}

async function runArchiveStress(cdp) {
  // 归档响应：连续快速归档多个会话 + 测量点击/后端响应速度（本地操作，不依赖模型）。
  await evaluate(cdp, 'window.api.setMode ? window.api.setMode(\'build\') : Promise.resolve()', 30000);
  await waitFor(cdp, stateIdleExpression(), 30000, 'archive initial idle');
  // 创建 4 个新会话（直接后端切换 + UI 新建）。
  const created = await evaluate(cdp, `(async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      if (window.newConversation) {
        await window.newConversation();
        const s = await window.api.getState();
        if (s && s.conversationId) ids.push(String(s.conversationId));
      } else break;
    }
    return ids;
  })()`, 60000);
  const ids = Array.isArray(created) ? created.map(String) : [];
  if (ids.length < 2) throw new Error('archive stress could not create conversations: ' + redact(JSON.stringify(created)));
  // 连续快速归档每个会话，测量 UI 同步响应 + 后端异步完成。
  const timings = await evaluate(cdp, `(async () => {
    const rows = [];
    for (const id of ${JSON.stringify(ids)}) {
      const started = Date.now();
      let uiRemoved = false;
      try {
        if (window.archiveConv) {
          window.archiveConv(id);
          // 同步执行后立即检查该会话行是否已从 UI 移除（乐观移除）。
          const convs = currentWorkspaceConversations ? currentWorkspaceConversations() : [];
          uiRemoved = !convs.some(c => String(c && c.id || 'default') === id);
        }
      } catch (e) {}
      rows.push({ id, uiSyncMs: Date.now() - started, uiRemoved });
    }
    return rows;
  })()`, 30000);
  const fastest = timings.reduce((a, b) => Math.min(a, b.uiSyncMs), Infinity);
  const slowest = timings.reduce((a, b) => Math.max(a, b.uiSyncMs), 0);
  const allRemoved = timings.every(r => r.uiRemoved);
  if (!allRemoved) throw new Error('archive rows not optimistically removed: ' + redact(JSON.stringify(timings)));
  // 等后端异步归档落盘。
  await sleep(1500);
  return 'archived=' + ids.length + '; uiSyncMs=' + fastest + '..' + slowest + '; allRemoved=' + allRemoved;
}

async function runQueueStress(cdp) {
  const conversationId = 'stress-queue';
  await evaluate(cdp, `window.api.setMode ? window.api.setMode('build') : Promise.resolve()`, 30000);
  await waitFor(cdp, stateIdleExpression(), 60000, 'queue stress initial idle');
  await evaluate(cdp, `(() => {
     const conversations = typeof currentWorkspaceConversations === 'function' ? currentWorkspaceConversations() : [];
     if (!conversations.some(c => c && c.id === ${jsString(conversationId)})) {
       conversations.push({ id: ${jsString(conversationId)}, summary: 'Stress queue', messages: [], archived: false, active: false });
     }
     const index = conversations.findIndex(c => c && c.id === ${jsString(conversationId)});
     if (typeof window.switchConversation === 'function') window.switchConversation(index);
     else if (typeof setActiveWorkspaceConversationById === 'function') setActiveWorkspaceConversationById(${jsString(conversationId)});
     return activeConversationId();
  })()`, 30000);
  await waitFor(cdp, `(() => typeof activeConversationId === 'function' && activeConversationId() === ${jsString(conversationId)})()`, 30000, 'queue conversation activation');
  await evaluate(cdp, `window.setInputMode ? window.setInputMode('guide') : undefined`, 30000);
  const firstMarker = 'NM_STRESS_QUEUE_FIRST_OK';
  const queuedMarkers = ['NM_STRESS_QUEUE_SECOND_OK', 'NM_STRESS_QUEUE_THIRD_OK', 'NM_STRESS_QUEUE_FOURTH_OK'];
  await evaluate(cdp, `(() => {
    const prompt = document.querySelector('#prompt');
    if (!prompt) throw new Error('prompt input missing');
    prompt.focus();
    prompt.value = ${jsString(`Reply with exactly ${firstMarker}. Do not use tools.`)};
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    window.sendMessage();
    return true;
  })()`, 30000);
  await waitFor(cdp, `(() => window.state && window.state._sendInFlight === true)()`, 10000, 'first queue stress send in flight');
  for (let index = 0; index < queuedMarkers.length; index++) {
    const marker = queuedMarkers[index];
    await evaluate(cdp, `(() => {
      window.setInputMode && window.setInputMode('next');
      const prompt = document.querySelector('#prompt');
      if (!prompt) throw new Error('prompt input missing for queued send');
      prompt.focus();
      prompt.value = ${jsString(`Reply exactly ${marker}. No tools.`)};
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      window.sendMessage();
      return true;
    })()`, 30000);
    try {
      const observation = await waitFor(cdp, `(() => {
        const queue = window.state && (window.state.nextQueue || []);
        const requests = window.state && (window.state.nextQueueRequests || []);
        const backendQueue = window.state && window.state.backendQueue && window.state.backendQueue.followUp || [];
        const text = JSON.stringify({ queue, requests, backendQueue });
        const markers = ${JSON.stringify(queuedMarkers.slice(0, index + 1))};
        const retained = markers.filter(item => text.includes(item)).length;
        const label = document.querySelector('#queue-header-label');
        const count = Number((String(label?.textContent || '').match(/\\d+/) || ['0'])[0]);
        return retained >= markers.length && label && count >= markers.length
          ? { retained, count, firstStillInFlight: window.state?._sendInFlight === true } : null;
      })()`, 15000, `queued prompt ${index + 1} visible`);
      if (index === queuedMarkers.length - 1 && (!observation.firstStillInFlight || observation.count !== queuedMarkers.length)) {
        throw new Error(`queue did not hold all prompts concurrently before first completion: ${redact(JSON.stringify(observation))}`);
      }
    } catch (error) {
      const debug = await evaluate(cdp, `(() => ({
        nextQueue: (window.state && window.state.nextQueue) || [],
        nextQueueRequests: (window.state && window.state.nextQueueRequests || []).map(item => item && { text: String(item.text || '').slice(-600), target: item.target }),
        backendQueue: (window.state && window.state.backendQueue) || null,
        queueLabel: document.querySelector('#queue-header-label')?.textContent || '',
        bodyTail: (document.querySelector('#chat-area')?.innerText || '').slice(-1200),
      }))()`, 30000).catch(debugError => ({ debugError: debugError.message }));
      throw new Error(`${error.message}; queueDebug=${redact(JSON.stringify(debug)).slice(0, 4000)}`);
    }
  }
  try {
    await waitFor(cdp, `(() => {
      const body = document.querySelector('#chat-area')?.innerText || '';
      const panel = document.querySelector('#queue-panel');
      const label = document.querySelector('#queue-header-label');
      const state = window.state || {};
      const allMarkers = [${[firstMarker, ...queuedMarkers].map(jsString).join(', ')}];
      const bodyMarkers = allMarkers.filter(marker => body.includes(marker));
      const bodyPositions = allMarkers.map(marker => body.indexOf(marker));
      const queueVisible = panel && panel.style.display !== 'none' && label && /[1-9]/.test(label.textContent || '');
      const queueArrays = [state.nextQueue, state.nextQueueRequests, state.backendQueue?.followUp, state.backendQueue?.steering].filter(Array.isArray);
      const queueCount = queueArrays.reduce((sum, items) => sum + items.length, 0);
      const ok = bodyMarkers.length === allMarkers.length
        && bodyPositions.every((position, index) => position >= 0 && (index === 0 || bodyPositions[index - 1] < position))
        && queueCount === 0
        && !queueVisible && state._sendInFlight === false;
      if (!ok) {
        window.__realProviderQueueStressDebug = {
          allMarkers,
          bodyPositions,
          queueLabel: label ? label.textContent : '',
          sendInFlight: state._sendInFlight,
          runningKeys: Object.keys(state.runningConversations || {}),
          backendQueue: state.backendQueue || null,
          nextQueue: state.nextQueue || [],
          bodyMarkers,
          queueCount,
        };
      }
      return ok;
    })()`, timeoutMs, 'queued prompt drained through UI');
  } catch (error) {
    const debug = await evaluate(cdp, 'window.__realProviderQueueStressDebug || null', 30000).catch(debugError => ({ debugError: debugError.message }));
    const backend = await evaluate(cdp, `(async () => {
      await window.api.ackTranscript(${jsString(conversationId)}, '');
      const state = await window.api.getState(${jsString(conversationId)});
      const markers = ${JSON.stringify([firstMarker, ...queuedMarkers])};
      return {
        conversationId: state?.conversationId || '',
        status: state?.status || '',
        runtime: state?.runtime ? { running: state.runtime.running, stopRequested: state.runtime.stopRequested, runId: state.runtime.runId } : null,
        chatMessages: (state?.chatMessages || []).slice(-10).map(item => ({ role: item.role, runId: item.runId || '', marker: markers.find(marker => String(item.content || '').includes(marker)) || '', contentChars: String(item.content || '').length })),
        workRuns: (state?.workRuns || []).slice(-8).map(run => ({
          runId: run.runId,
          status: run.status,
          targetConversationId: run.target?.conversationId || '',
          promptMarker: markers.find(marker => String(run.primaryPrompt || '').includes(marker)) || '',
          finalMarker: markers.find(marker => String(run.finalResponse || '').includes(marker)) || '',
          eventTypes: (run.events || []).slice(-12).map(event => ({ type: event.type, toolName: event.toolName || '' })),
          error: String(run.error || '').slice(0, 500),
        })),
      };
    })()`, 30000).catch(debugError => ({ debugError: debugError.message }));
    throw new Error(`${error.message}; queueDebug=${redact(JSON.stringify({ renderer: debug, backend })).slice(0, 5000)}`);
  }
  await waitFor(cdp, stateIdleExpression(conversationId), 60000, 'queue idle');
  await evaluate(cdp, `window.api.ackTranscript(${jsString(conversationId)}, '')`, 10000);
  const finalState = await evaluate(cdp, `window.api.getState(${jsString(conversationId)})`, 20000);
  const allMarkers = [firstMarker, ...queuedMarkers];
  const completedQueueRuns = allMarkers.map(marker => {
    const run = (finalState.workRuns || []).find(item => String(item.primaryPrompt || '').includes(marker));
    if (!run || run.status !== 'completed' || run.target?.conversationId !== conversationId) {
      throw new Error(`queued marker ${marker} did not finish on ${conversationId}: ${redact(JSON.stringify(run || null))}`);
    }
    return { marker, runId: run.runId, status: run.status, targetConversationId: run.target.conversationId };
  });
  const assistantMessages = (finalState.chatMessages || []).filter(message => message && message.role === 'assistant');
  const assistantMarkerOrder = assistantMessages
    .map(message => allMarkers.findIndex(marker => String(message.content || '').includes(marker)))
    .filter(index => index >= 0);
  if (assistantMarkerOrder.length !== allMarkers.length || assistantMarkerOrder.some((value, index) => value !== index)) {
    throw new Error(`backend transcript assistant markers are not complete and ordered: ${redact(JSON.stringify({ conversationId, assistantMarkerOrder, messages: assistantMessages.map(message => ({ runId: message.runId, marker: allMarkers.find(marker => String(message.content || '').includes(marker)) || '' })) }))}`);
  }
  const followUpQueue = finalState.queued?.followUp || finalState.backendQueue?.followUp || [];
  const steeringQueue = finalState.queued?.steering || finalState.backendQueue?.steering || [];
  if (followUpQueue.length || steeringQueue.length || finalState.status !== 'idle' || finalState.runtime?.running === true) {
    throw new Error(`queue state did not fully settle after transcript verification: ${redact(JSON.stringify({ status: finalState.status, runtime: finalState.runtime, followUpQueue, steeringQueue }))}`);
  }
  return { conversationId, markers: allMarkers, completedQueueRuns, assistantMarkerOrder, queueEmpty: true, finalStatus: finalState.status };
}

async function runConversationIsolationStress(cdp) {
  await evaluate(cdp, `window.api.setMode ? window.api.setMode('build') : Promise.resolve()`, 30000);
  await waitFor(cdp, `window.api.getState().then(s => s && s.status === 'idle' ? true : false)`, 60000, 'conversation isolation initial idle');
  const convA = 'stress-conversation-a';
  const convB = 'stress-conversation-b';
  const markerA = 'NM_STRESS_CONVERSATION_A_OK';
  const markerB = 'NM_STRESS_CONVERSATION_B_OK';
  const sendA = await evaluate(cdp, `window.api.sendMessage(${jsString(`Reply exactly ${markerA}. No tools.`)}, ${jsString(convA)})`, timeoutMs);
  const textA = JSON.stringify({ tokens: sendA && sendA.tokens, chatMessages: sendA && sendA.chatMessages });
  if (!textA.includes(markerA)) throw new Error(`conversation A missing marker: ${redact(textA).slice(0, 1000)}`);
  if (textA.includes(markerB)) throw new Error(`conversation A response contained B marker: ${redact(textA).slice(0, 1000)}`);
  if ((sendA && sendA.conversationId) !== convA) throw new Error(`conversation A response id mismatch: ${sendA && sendA.conversationId}`);

  const sendB = await evaluate(cdp, `window.api.sendMessage(${jsString(`Reply exactly ${markerB}. No tools.`)}, ${jsString(convB)})`, timeoutMs);
  const textB = JSON.stringify({ tokens: sendB && sendB.tokens, chatMessages: sendB && sendB.chatMessages });
  if (!textB.includes(markerB)) throw new Error(`conversation B missing marker: ${redact(textB).slice(0, 1000)}`);
  if (textB.includes(markerA)) throw new Error(`conversation B response contained A marker: ${redact(textB).slice(0, 1000)}`);
  if ((sendB && sendB.conversationId) !== convB) throw new Error(`conversation B response id mismatch: ${sendB && sendB.conversationId}`);

  await evaluate(cdp, `window.api.setConversation(${jsString(convA)})`, 30000);
  const stateA = await evaluate(cdp, `window.api.getState()`, 30000);
  const stateAText = JSON.stringify((stateA && stateA.chatMessages) || []);
  if (!stateAText.includes(markerA)) throw new Error(`conversation A state missing marker: ${redact(stateAText).slice(0, 1000)}`);
  if (stateAText.includes(markerB)) throw new Error(`conversation A state leaked B marker: ${redact(stateAText).slice(0, 1000)}`);

  await evaluate(cdp, `window.api.setConversation(${jsString(convB)})`, 30000);
  const stateB = await evaluate(cdp, `window.api.getState()`, 30000);
  const stateBText = JSON.stringify((stateB && stateB.chatMessages) || []);
  if (!stateBText.includes(markerB)) throw new Error(`conversation B state missing marker: ${redact(stateBText).slice(0, 1000)}`);
  if (stateBText.includes(markerA)) throw new Error(`conversation B state leaked A marker: ${redact(stateBText).slice(0, 1000)}`);

  return 'conversation histories isolated';
}

async function runConcurrentConversationSwitchStress(cdp) {
  await evaluate(cdp, `window.api.setMode ? window.api.setMode('build') : Promise.resolve()`, 30000);
  await waitFor(cdp, `window.api.getState().then(s => s && s.status === 'idle' ? true : false)`, 60000, 'concurrent conversation initial idle');
  const created = await evaluate(cdp, `(async () => {
    const ids = [];
    for (let i = 0; i < 2; i++) {
      if (typeof window.newConversation !== 'function') throw new Error('newConversation is unavailable');
      await window.newConversation();
      const state = await window.api.getState();
      if (state && state.conversationId) ids.push(String(state.conversationId));
    }
    return ids;
  })()`, 60000);
  const ids = Array.isArray(created) ? [...new Set(created.map(String))] : [];
  if (ids.length !== 2) throw new Error(`could not create two target conversations: ${redact(JSON.stringify(created))}`);
  const [conversationA, conversationB] = ids;
  const titleAssignments = [[conversationA, 'Stress Conversation A'], [conversationB, 'Stress Conversation B']];
  const renamed = await evaluate(cdp, `Promise.all(${JSON.stringify(titleAssignments)}.map(async ([id, title]) => ({ id, ok: await window.api.renameConversation(id, title) })))`, 30000);
  if (!Array.isArray(renamed) || renamed.some(item => !item?.ok)) {
    throw new Error(`could not pre-name conversations before concurrent first responses: ${redact(JSON.stringify(renamed))}`);
  }
  const initialStates = await Promise.all(ids.map(id => evaluate(cdp, `window.api.getState(${jsString(id)})`, 30000)));
  const initialById = new Map(initialStates.map(state => [String(state.conversationId || ''), state]));
  const deploymentProviderIds = [...new Set(initialStates.map(state => String(state?.resolvedDeployment?.providerId || '')).filter(Boolean))];
  if (deploymentProviderIds.length !== 1) {
    throw new Error(`two targets did not resolve to the same single configured provider id: ${redact(JSON.stringify(initialStates.map(state => ({ conversationId: state?.conversationId, deployment: state?.resolvedDeployment }))))}`);
  }
  providerEvidence.resolvedProviderId = deploymentProviderIds[0];
  for (const id of ids) {
    const state = initialById.get(id);
    const deployment = state?.resolvedDeployment;
    if (!state || deployment?.providerId !== providerEvidence.resolvedProviderId || deployment?.modelId !== providerEvidence.expectedModelId) {
      throw new Error(`target ${id} did not resolve to the single configured remote deployment: ${redact(JSON.stringify({ conversationId: id, deployment }))}`);
    }
  }

  async function selectExactTarget(conversationId, label) {
    const selected = await evaluate(cdp, `(() => {
      const rows = typeof currentWorkspaceConversations === 'function' ? currentWorkspaceConversations() : [];
      const index = rows.findIndex(row => String(row && row.id || '') === ${jsString(conversationId)});
      if (index < 0 || typeof window.switchConversation !== 'function') throw new Error('conversation row is unavailable: ' + ${jsString(conversationId)});
      window.switchConversation(index);
      const target = currentConversationTarget();
      return { target, bound: state._promptBoundKey, expected: conversationDraftKey(target), runtimeKey: runtimeKeyFor(target.workspaceId, target.conversationId) };
    })()`, 15000);
    if (selected.target?.conversationId !== conversationId || selected.bound !== selected.expected) {
      throw new Error(`${label} switch target/draft binding mismatch: ${redact(JSON.stringify(selected))}`);
    }
    await waitFor(cdp, `(() => {
      const target = currentConversationTarget();
      return target.conversationId === ${jsString(conversationId)}
        && state._promptBoundKey === conversationDraftKey(target)
        && state.renderedChatTargetKey === runtimeKeyFor(target.workspaceId, target.conversationId);
    })()`, 20000, `${label} renderer target hydration`);
    return selected;
  }

  async function runOverlappingRound(round, markerA, markerB) {
    await selectExactTarget(conversationA, `round ${round} A`);
    const prompts = [
      { conversationId: conversationA, marker: markerA },
      { conversationId: conversationB, marker: markerB },
    ].map(item => ({
      conversationId: item.conversationId,
      marker: item.marker,
      prompt: `Reply with exactly ${item.marker} on one line. Do not use tools.`,
    }));
    await evaluate(cdp, `(() => {
      const prompts = ${JSON.stringify(prompts)};
      window.__newmarkConcurrentConversationPromises = prompts.map(item => window.api.sendMessage(item.prompt, item.conversationId).then(result => ({
        ok: true,
        conversationId: result && result.conversationId,
        hasMarker: JSON.stringify({ chatMessages: result && result.chatMessages, workRuns: result && result.workRuns }).includes(item.marker),
        text: JSON.stringify({ chatMessages: result && result.chatMessages, workRuns: result && result.workRuns }).slice(-5000),
      }), error => ({ ok: false, conversationId: item.conversationId, error: String(error && error.message || error) })));
      return true;
    })()`, 30000);

    let overlap;
    try {
      overlap = await waitFor(cdp, `(async () => {
      await Promise.all([${jsString(conversationA)}, ${jsString(conversationB)}].map(id => window.api.ackTranscript(id, '')));
      const states = await Promise.all([
        window.api.getState(${jsString(conversationA)}),
        window.api.getState(${jsString(conversationB)})
      ]);
      const targets = states.map((state, index) => {
        const expectedId = index === 0 ? ${jsString(conversationA)} : ${jsString(conversationB)};
        const expectedMarker = index === 0 ? ${jsString(markerA)} : ${jsString(markerB)};
        const run = (state?.workRuns || []).find(item => item.runId === state?.runtime?.runId);
        const requestContext = state?.contextWindow?.requestContext;
        const deployment = state?.resolvedDeployment;
        return {
          conversationId: state?.conversationId,
          runId: state?.runtime?.runId,
          running: state?.runtime?.running === true,
          runStatus: run?.status,
          runTarget: run?.target?.conversationId,
          runPromptHasMarker: String(run?.primaryPrompt || '').includes(expectedMarker),
          contextRequestId: requestContext?.requestId || '',
          contextAt: requestContext?.at || '',
          contextRunId: requestContext?.runId || '',
          contextModel: requestContext?.model || '',
          providerId: deployment?.providerId || '',
          modelId: deployment?.modelId || '',
          baselineRequestCount: Number(state?.contextWindow?.providerUsageRequests || 0),
        };
      });
      return targets.every((item, index) => {
        const expectedId = index === 0 ? ${jsString(conversationA)} : ${jsString(conversationB)};
        const expectedModel = ${jsString(providerEvidence.expectedModelId)};
        const expectedProvider = ${jsString(providerEvidence.resolvedProviderId)};
        return item.conversationId === expectedId
          && item.running === true
          && item.runStatus === 'running'
          && item.runTarget === expectedId
          && item.runPromptHasMarker
          && !!item.contextRequestId
          && item.contextRunId === item.runId
          && item.contextModel === expectedModel
          && item.providerId === expectedProvider
          && item.modelId === expectedModel;
      }) ? { observedAtMs: Date.now(), targets } : null;
      })()`,
      Math.min(timeoutMs, 30000), `both conversations running in round ${round}`, 100);
    } catch (error) {
      const diagnostics = await Promise.all(ids.map(async id => evaluate(cdp, `(async () => {
        await window.api.ackTranscript(${jsString(id)}, '');
        const state = await window.api.getState(${jsString(id)});
        return {
          conversationId: state?.conversationId || '',
          status: state?.status || '',
          runtime: state?.runtime ? { running: state.runtime.running, runId: state.runtime.runId } : null,
          providerId: state?.resolvedDeployment?.providerId || '',
          modelId: state?.resolvedDeployment?.modelId || '',
          requestContext: state?.contextWindow?.requestContext ? { requestId: state.contextWindow.requestContext.requestId, runId: state.contextWindow.requestContext.runId, at: state.contextWindow.requestContext.at } : null,
          runs: (state?.workRuns || []).slice(-3).map(run => ({ runId: run.runId, status: run.status, targetConversationId: run.target?.conversationId || '', promptMarker: ['${markerA}', '${markerB}'].find(marker => String(run.primaryPrompt || '').includes(marker)) || '', eventTypes: (run.events || []).slice(-8).map(event => event.type) })),
        };
      })()`, 20000).catch(readError => ({ conversationId: id, readError: readError.message }))));
      const remoteCalls = serializableProviderEvidence().filter(call => call.requestMarker === markerA || call.requestMarker === markerB);
      throw new Error(`${error.message}; overlapState=${redact(JSON.stringify({ diagnostics, remoteCalls }))}`);
    }

    const overlapTargets = overlap.targets || [];
    if (overlapTargets.length !== 2) throw new Error(`round ${round} overlap observation is incomplete`);
    const overlapRunIds = Object.fromEntries(overlapTargets.map(item => [item.conversationId, item.runId]));

    const switches = [];
    for (let index = 0; index < 10; index++) {
      const targetId = index % 2 === 0 ? conversationA : conversationB;
      const startedAt = Date.now();
      const selected = await selectExactTarget(targetId, `round ${round} switch ${index + 1}`);
      switches.push({ conversationId: targetId, elapsedMs: Date.now() - startedAt, runtimeKey: selected.runtimeKey });
      const states = await Promise.all(ids.map(id => evaluate(cdp, `(async () => { await window.api.ackTranscript(${jsString(id)}, ''); return window.api.getState(${jsString(id)}); })()`, 20000)));
      const statesById = new Map(states.map(state => [String(state.conversationId || ''), state]));
      const state = statesById.get(targetId);
      const expectedMarker = targetId === conversationA ? markerA : markerB;
      const forbiddenMarker = targetId === conversationA ? markerB : markerA;
      const serialized = JSON.stringify({ chatMessages: state?.chatMessages || [], workRuns: state?.workRuns || [] });
      if (state?.conversationId !== targetId || !serialized.includes(expectedMarker) || serialized.includes(forbiddenMarker)) {
        const snapshotDiagnostics = ids.map(id => {
          const sampled = statesById.get(id);
          return {
            requestedConversationId: id,
            returnedConversationId: sampled?.conversationId || '',
            workspaceId: sampled?.workspaceId || '',
            runtimeStatus: sampled?.runtimeStatus || '',
            runtimeError: sampled?.runtimeError || '',
            status: sampled?.status || '',
            totalMessages: sampled?.totalMessages,
            chatMessageCount: Array.isArray(sampled?.chatMessages) ? sampled.chatMessages.length : null,
            runtime: sampled?.runtime ? { running: sampled.runtime.running, runId: sampled.runtime.runId } : null,
            workRuns: (sampled?.workRuns || []).slice(-4).map(item => ({
              runId: item.runId,
              status: item.status,
              targetConversationId: item.target?.conversationId || '',
              primaryPrompt: String(item.primaryPrompt || '').slice(0, 180),
            })),
          };
        });
        throw new Error(`round ${round} switch snapshot leaked or missed target ${targetId}: ${redact(JSON.stringify({ snapshot: serialized, diagnostics: snapshotDiagnostics })).slice(-6000)}`);
      }
      for (const run of state.workRuns || []) {
        if (run.target?.conversationId !== targetId) throw new Error(`round ${round} workRun ${run.runId} is bound to ${run.target?.conversationId}, expected ${targetId}`);
      }
      const bothRunning = ids.every(id => {
        const live = statesById.get(id);
        const expectedRunId = overlapRunIds[id];
        return live?.runtime?.running === true
          && live.runtime.runId === expectedRunId
          && live.workRuns?.some(run => run.runId === expectedRunId && run.status === 'running' && run.target?.conversationId === id);
      });
      switches[switches.length - 1].bothOriginalRunsStillRunning = bothRunning;
      switches[switches.length - 1].runIds = overlapRunIds;
      switches[switches.length - 1].attemptContexts = ids.map(id => {
        const sampled = statesById.get(id);
        const requestContext = sampled?.contextWindow?.requestContext;
        return {
          conversationId: id,
          runId: sampled?.runtime?.runId || '',
          requestId: requestContext?.requestId || '',
          at: requestContext?.at || '',
          model: requestContext?.model || '',
          providerId: sampled?.resolvedDeployment?.providerId || '',
          modelId: sampled?.resolvedDeployment?.modelId || '',
          running: sampled?.runtime?.running === true,
          marker: id === conversationA ? markerA : markerB,
        };
      });
    }
    const liveSwitches = switches.filter(item => item.bothOriginalRunsStillRunning).length;
    if (liveSwitches < 6) throw new Error(`round ${round} had only ${liveSwitches}/10 target switches while both exact runs were still active`);

    const settlements = await evaluate(cdp, `Promise.all(window.__newmarkConcurrentConversationPromises)`, timeoutMs);
    if (!Array.isArray(settlements) || settlements.length !== 2) throw new Error(`round ${round} did not settle both target requests`);
    for (let index = 0; index < settlements.length; index++) {
      const expectedId = index === 0 ? conversationA : conversationB;
      const expectedMarker = index === 0 ? markerA : markerB;
      const forbiddenMarker = index === 0 ? markerB : markerA;
      const result = settlements[index];
      if (!result?.ok || result.conversationId !== expectedId || !result.hasMarker || String(result.text || '').includes(forbiddenMarker)) {
        throw new Error(`round ${round} completion target mismatch: ${redact(JSON.stringify(result)).slice(-2400)}`);
      }
    }

    const attempts = [
      ...overlapTargets.map(item => ({
        conversationId: item.conversationId,
        runId: item.runId,
        requestId: item.contextRequestId,
        at: item.contextAt,
        model: item.contextModel,
        providerId: item.providerId,
        modelId: item.modelId,
        running: item.running,
        marker: item.conversationId === conversationA ? markerA : markerB,
      })),
      ...switches.flatMap(item => item.attemptContexts || []),
    ];
    const correlatedCalls = {};
    for (const [targetId, expectedMarker] of [[conversationA, markerA], [conversationB, markerB]]) {
      const targetAttempts = attempts.filter(item => item.conversationId === targetId
        && item.runId === overlapRunIds[targetId]
        && item.marker === expectedMarker
        && item.model === providerEvidence.expectedModelId
        && item.providerId === providerEvidence.resolvedProviderId
        && item.modelId === providerEvidence.expectedModelId
        && item.requestId
        && Date.parse(item.at));
      const usedRequestIds = new Set();
      correlatedCalls[expectedMarker] = providerEvidence.requests
        .filter(call => call.requestMarker === expectedMarker
          && call.statusCode >= 200 && call.statusCode < 300
          && call.elapsedMs !== null
          && call.responseMarkers.has(expectedMarker)
          && call.requestModel === providerEvidence.expectedModelId)
        .map(call => {
          const context = targetAttempts
            .map(item => ({ item, deltaMs: call.startedAtMs - Date.parse(item.at) }))
            .filter(row => row.deltaMs >= 0 && row.deltaMs <= 30000 && !usedRequestIds.has(row.item.requestId))
            .sort((left, right) => left.deltaMs - right.deltaMs)[0];
          if (!context) return null;
          usedRequestIds.add(context.item.requestId);
          return {
            conversationId: targetId,
            workRunId: overlapRunIds[targetId],
            contextRequestId: context.item.requestId,
            contextAt: context.item.at,
            contextToUpstreamMs: context.deltaMs,
            marker: expectedMarker,
            upstreamRequestId: call.requestId,
            providerResponseId: call.responseId,
            upstreamHost: call.upstreamHost,
            requestModel: call.requestModel,
            responseModel: call.responseModel,
            statusCode: call.statusCode,
             startedAtMs: call.startedAtMs,
            completedAtMs: call.completedAtMs,
            elapsedMs: call.elapsedMs,
            upstreamElapsedMs: call.upstreamElapsedMs,
            responseUsage: call.responseUsage,
          };
        })
        .filter(Boolean);
      if (!correlatedCalls[expectedMarker].length) {
        throw new Error(`no same-run requestContext could be time-correlated to a successful remote request for ${expectedMarker}: ${redact(JSON.stringify({ attempts: targetAttempts, calls: serializableProviderEvidence().filter(item => item.requestMarker === expectedMarker) }))}`);
      }
    }
    let overlappingPair = null;
    for (const candidateA of correlatedCalls[markerA]) {
      for (const candidateB of correlatedCalls[markerB]) {
        const completedAtA = Number(candidateA.completedAtMs || candidateA.startedAtMs + candidateA.elapsedMs);
        const completedAtB = Number(candidateB.completedAtMs || candidateB.startedAtMs + candidateB.elapsedMs);
        const overlapped = Math.max(candidateA.startedAtMs, candidateB.startedAtMs)
          < Math.min(completedAtA, completedAtB);
        if (overlapped && candidateA.contextRequestId !== candidateB.contextRequestId) {
          overlappingPair = { [markerA]: candidateA, [markerB]: candidateB };
          break;
        }
      }
      if (overlappingPair) break;
    }
    if (!overlappingPair) {
      const error = new Error(`round ${round} no same-run correlated remote request pair overlapped: ${redact(JSON.stringify(correlatedCalls))}`);
      error.failureClass = 'concurrency-not-observed';
      throw error;
    }

    const finalStates = [];
    for (const [targetId, expectedMarker, forbiddenMarker] of [
      [conversationA, markerA, markerB],
      [conversationB, markerB, markerA],
    ]) {
      await evaluate(cdp, `window.api.ackTranscript(${jsString(targetId)}, '')`, 10000);
      const state = await evaluate(cdp, `window.api.getState(${jsString(targetId)})`, 20000);
      const serialized = JSON.stringify({ chatMessages: state?.chatMessages || [], workRuns: state?.workRuns || [] });
      if (state?.conversationId !== targetId || !serialized.includes(expectedMarker) || serialized.includes(forbiddenMarker)) {
        throw new Error(`round ${round} final persisted state mismatch: ${redact(serialized).slice(-2400)}`);
      }
      for (const run of state.workRuns || []) {
        if (run.target?.conversationId !== targetId) throw new Error(`round ${round} final run ${run.runId} target mismatch`);
      }
      const baselineRequests = Number(initialById.get(targetId)?.contextWindow?.providerUsageRequests || 0);
      const reportedRequests = Number(state.contextWindow?.providerUsageRequests || 0);
      if (reportedRequests <= baselineRequests) throw new Error(`provider request accounting did not advance for ${targetId}: before=${baselineRequests}, after=${reportedRequests}`);
      finalStates.push({ conversationId: targetId, messageCount: state.chatMessages?.length || 0, runIds: (state.workRuns || []).map(run => run.runId), providerUsageRequests: reportedRequests });
    }
    return { markers: [markerA, markerB], overlap, switches, liveSwitches, correlatedProviderCalls: correlatedCalls, overlappingPair, remoteIntervalsOverlapped: true, finalStates };
  }

  await runOverlappingRound(1, 'NM_STRESS_RUNNING_A_1_OK', 'NM_STRESS_RUNNING_B_1_OK');
  await runOverlappingRound(2, 'NM_STRESS_RUNNING_A_2_OK', 'NM_STRESS_RUNNING_B_2_OK');
  return { conversations: [conversationA, conversationB], overlappingRounds: 2, eachRoundSwitches: 10, configuredRemoteDeployment: { providerName: providerEvidence.expectedProviderId, providerId: providerEvidence.resolvedProviderId, modelId: providerEvidence.expectedModelId, upstreamHost: providerEvidence.upstreamHost }, continuationMarkers: ['NM_STRESS_RUNNING_A_2_OK', 'NM_STRESS_RUNNING_B_2_OK'] };
}

async function runLongContextStress(cdp) {
  const conversationId = 'stress-long-context';
  const continuationRounds = 3;
  const payloadUnit = 'Long context stress payload. ';
  await evaluate(cdp, `window.api.setMode ? window.api.setMode('build') : Promise.resolve()`, 30000);
  await waitFor(cdp, stateIdleExpression(), 60000, 'long-context initial idle');
  let currentState = await evaluate(cdp, `window.api.getState(${jsString(conversationId)})`, 30000);
  const initialWindow = currentState?.contextWindow || {};
  const reportedMaxTokens = Number(initialWindow.maxTokens || 0);
  const runtimeMaxTokens = reportedMaxTokens >= 8000 ? reportedMaxTokens : contextMaxTokens;
  const reportedTriggerTokens = Number(initialWindow.longHistoryTriggerTokens || 0);
  const runtimeTriggerTokens = reportedTriggerTokens >= 128 ? reportedTriggerTokens : Math.max(128, Math.floor(runtimeMaxTokens * 0.20));
  const turns = Math.max(12, Math.min(40, longContextTurns));
  const requiredPayloadChars = Math.ceil(runtimeTriggerTokens * 4 * 1.25);
  const payloadCharsPerTurn = Math.max(1200, Math.ceil(requiredPayloadChars / Math.min(turns, 12)));
  const payload = payloadUnit.repeat(Math.ceil(payloadCharsPerTurn / payloadUnit.length));
  const turnMarkers = [];
  const startCompressionAt = currentState?.contextCompression?.at || '';
  let beforeCompressionWindow = currentState?.contextWindow || {};
  let afterCompressionWindow = beforeCompressionWindow;
  let compression = null;
  let compressionRound = 0;
  const compressionEventsByKey = new Map();
  const initialEntries = Number(beforeCompressionWindow.cacheEntries || 0) + Number(beforeCompressionWindow.archiveEntries || 0);
  for (let index = 1; index <= turns; index += 1) {
    const turnMarker = `NM_STRESS_LONG_CONTEXT_TURN_${index}_OK`;
    const previousState = currentState;
    await sendBackendPrompt(cdp, `Reply with this exact marker as the first line: ${turnMarker}\nDo not use tools.\n\n${payload}`, turnMarker, conversationId, timeoutMs);
    currentState = await evaluate(cdp, `(async () => {
      await window.api.ackTranscript(${jsString(conversationId)}, '');
      return window.api.getState(${jsString(conversationId)});
    })()`, 30000);
    if (currentState?.conversationId !== conversationId) throw new Error(`long-context turn ${index} returned a different conversation`);
    const stateText = JSON.stringify({ chatMessages: currentState?.chatMessages || [], workRuns: currentState?.workRuns || [] });
    if (!stateText.includes(turnMarker)) throw new Error(`long-context transcript lost ${turnMarker}: ${redact(stateText).slice(-1200)}`);
    turnMarkers.push(turnMarker);
    const priorWindow = previousState?.contextWindow || {};
    const nextWindow = currentState?.contextWindow || {};
    const priorCompressionAt = previousState?.contextCompression?.at || '';
    const nextCompression = currentState?.contextCompression || null;
    const events = (currentState?.workRuns || []).flatMap(run => run.events || [])
      .filter(event => event?.toolName === 'context_compression' || String(event?.content || '').toLowerCase().includes('context compression completed'))
      .map(event => ({ type: event.type, toolName: event.toolName || '' }));
    for (const event of events) compressionEventsByKey.set(JSON.stringify(event), event);
    const nextEntries = Number(nextWindow.cacheEntries || 0) + Number(nextWindow.archiveEntries || 0);
    const didCompress = !!(nextCompression?.at && nextCompression.at !== startCompressionAt && nextCompression.at !== priorCompressionAt)
      || events.length > 0
      || nextEntries > initialEntries;
    if (didCompress && !compressionRound) {
      compressionRound = index;
      compression = nextCompression;
      beforeCompressionWindow = priorWindow;
      afterCompressionWindow = nextWindow;
    }
  }
  const compressionEvents = [...compressionEventsByKey.values()];
  const entriesBefore = initialEntries;
  const entriesAfter = Number(afterCompressionWindow.cacheEntries || 0) + Number(afterCompressionWindow.archiveEntries || 0);
  const compressionObserved = !!(compression?.at || compressionEvents.length || entriesAfter > entriesBefore);
  const metrics = {
    turns,
    payloadCharsPerTurn: payload.length,
    totalPayloadChars: payload.length * turns,
    compressionEnabled: currentState?.contextWindow?.compressionEnabled,
    runtimeMaxTokens,
    runtimeLongHistoryTriggerTokens: runtimeTriggerTokens,
    before: {
      maxTokens: beforeCompressionWindow.maxTokens,
      estimatedTokens: beforeCompressionWindow.estimatedTokens,
      longHistoryTokens: beforeCompressionWindow.longHistoryTokens,
      longHistoryTriggerTokens: beforeCompressionWindow.longHistoryTriggerTokens,
      thresholdReached: beforeCompressionWindow.thresholdReached,
      cacheEntries: beforeCompressionWindow.cacheEntries,
      archiveEntries: beforeCompressionWindow.archiveEntries,
    },
    after: {
      maxTokens: afterCompressionWindow.maxTokens,
      estimatedTokens: afterCompressionWindow.estimatedTokens,
      longHistoryTokens: afterCompressionWindow.longHistoryTokens,
      longHistoryTriggerTokens: afterCompressionWindow.longHistoryTriggerTokens,
      thresholdReached: afterCompressionWindow.thresholdReached,
      cacheEntries: afterCompressionWindow.cacheEntries,
      archiveEntries: afterCompressionWindow.archiveEntries,
    },
    compressionAt: compression?.at || currentState?.contextCompression?.at || '',
    compressionRound,
    compressionEvents,
  };
  const continuationMarkers = [];
  for (let index = 1; index <= continuationRounds; index += 1) {
    const continuationMarker = `NM_STRESS_LONG_CONTEXT_CONTINUE_${index}_OK`;
    const continuationResult = await sendBackendPrompt(cdp, `Continue this conversation and reply with exactly ${continuationMarker}. Do not use tools.`, continuationMarker, conversationId, timeoutMs);
    const returnedText = JSON.stringify({ chatMessages: continuationResult?.chatMessages || [], workRuns: continuationResult?.workRuns || [] });
    if (!returnedText.includes(continuationMarker)) throw new Error(`post-compression continuation ${index} lost its exact marker: ${redact(returnedText).slice(-900)}`);
    continuationMarkers.push(continuationMarker);
  }
  const finalState = await evaluate(cdp, `(async () => {
    await window.api.ackTranscript(${jsString(conversationId)}, '');
    return window.api.getState(${jsString(conversationId)});
  })()`, 30000);
  const finalTranscript = JSON.stringify(finalState?.chatMessages || []);
  for (const expectedMarker of [...turnMarkers, ...continuationMarkers]) {
    if (!finalTranscript.includes(expectedMarker)) throw new Error(`single conversation transcript lost a post-compression marker ${expectedMarker}`);
  }
  if (!compressionObserved) throw new Error(`long-context compression not observed after ${turns} accumulated turns: ${redact(JSON.stringify(metrics))}`);
  return { ...metrics, compressionObserved, continuationRounds, continuationMarkers, transcriptMessages: finalState?.chatMessages?.length || 0, providerUsageRequests: finalState?.contextWindow?.providerUsageRequests || 0 };
}

function shouldRunScenario(name) {
  return selectedScenarios.size === 0 || selectedScenarios.has(name);
}

function sha256File(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function stopReleaseProcesses(_root = '', processId = activeReleaseProcessId) {
  const pid = Number(processId || 0);
  if (!Number.isInteger(pid) || pid <= 0) return;
  // Terminate only the stress launch's process tree. Never sweep every
  // installed Newmark process: the user may already have their own app open.
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    encoding: 'utf8',
  });
}

function releaseProcessCount(processId = activeReleaseProcessId) {
  const pid = Number(processId || 0);
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  const command = `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 1 } else { 0 }`;
  const running = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ], { encoding: 'utf8', windowsHide: true });
  return Number(String(running.stdout || '').trim() || '0');
}

function writeReport(provider, root, skippedReason = '') {
  const date = new Date().toISOString().slice(0, 10);
  const reportTag = String(process.env.NEWMARK_REAL_STRESS_REPORT_TAG || 'debug')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 80) || 'debug';
  const reportPath = path.join(repoRoot, 'archive', `${date}-real-provider-stress-${reportTag}.md`);
  const evidencePath = reportPath.replace(/\.md$/i, '.json');
  const packagedAppAsarPath = path.join(path.dirname(exePath), 'resources', 'app.asar');
  const artifactIdentity = {
    exePath,
    exeSha256: sha256File(exePath),
    appAsarPath: packagedAppAsarPath,
    appAsarSha256: sha256File(packagedAppAsarPath),
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const failCount = results.filter(r => r.status === 'fail').length;
  const passCount = results.filter(r => r.status === 'pass').length;
  const skipped = skippedReason ? true : false;
  const verdict = skipped
    ? 'release-usable-with-risks'
    : failCount > 0
      ? 'not-release-ready'
      : 'release-usable';
  const scenarioRows = results.length
    ? results.map(r => `| ${r.name} | ${r.status} | ${r.rootCause || ''} | ${r.elapsedMs} | ${String(r.detail || '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').slice(0, 700)} |`).join('\n')
    : '| real-provider-stress | skip | missing-credentials | 0 | 未执行真实重压：缺少凭据 |';
  const providerLine = provider
    ? `source=${provider.source}; protocol=${provider.protocol}; model=${provider.model}; upstreamHost=${providerEvidence.upstreamHost || new URL(provider.baseUrl).host}; forwardingProxy=enabled`
    : 'provider=missing';
  const upstreamRows = serializableProviderEvidence().map(item => `| ${item.requestMarker || ''} | ${item.requestModel || ''} | ${item.statusCode || ''} | ${item.responseId || ''} | ${item.responseModel || ''} | ${item.firstByteMs ?? ''} | ${item.clientFirstByteMs ?? ''} | ${item.elapsedMs ?? ''} | ${item.upstreamElapsedMs ?? ''} | ${item.responseUsage ? `${item.responseUsage.input}/${item.responseUsage.output}` : ''} | ${item.responseMarkers.join(',')} |`).join('\n');
  const content = `# ${date} Real Provider Stress Debug

## Scope

Implemented and/or ran the opt-in real-provider stress harness for the packaged release build. The harness uses an isolated temporary root, writes a minimal provider config, redacts secrets, and exercises the packaged release executable rather than source-only code.

## Design Release Usability

- Proven: packaged CLI/UI startup, provider config loading, key redaction, normal send path, renderer/preload/Agent routing, and release process cleanup are covered by the current release smoke suite.
- Partially proven: real-provider behavior is probabilistic and provider-dependent; this stress harness records failures without treating provider rate limits or balance issues as app passes.
- Not exhaustively proven: arbitrary third-party provider quality, broad model catalog validation, and unbounded long-context behavior.

## Stress Parameters

- packagedExe=${artifactIdentity.exePath} (sha256=${artifactIdentity.exeSha256 || 'missing'})
- packagedAppAsar=${artifactIdentity.appAsarPath} (sha256=${artifactIdentity.appAsarSha256 || 'missing'})
- ${providerLine}
- realUpstreamCalls=${providerEvidence.requests.length}; the local forwarding proxy records sanitized request/response metadata only (no key, prompt body, or raw response).
- scenarios=${selectedScenarios.size ? [...selectedScenarios].join(',') : 'all'}
- cliRounds=${cliRounds}
- uiRounds=${uiRounds}
- goalRounds=${goalRounds}
  - timeoutMs=${timeoutMs}
  - contextMaxTokens=${contextMaxTokens}
  - longContextTurns=${longContextTurns}
  - queueFirstResponseHoldMs=${queueFirstResponseHoldMs}
  - concurrentResponseHoldMs=${concurrentResponseHoldMs}
  - skipped=${skipped}
- tempRoot=${keepRoot ? root : '<removed>'}

## Scenario Results

| Scenario | Status | Root cause | Elapsed ms | Detail |
| --- | --- | --- | ---: | --- |
${scenarioRows}

## Remote Upstream Request Evidence

| Request marker | Requested model | HTTP status | Provider response ID | Returned model | Upstream headers ms | Client first byte ms | Proxy response complete ms | Upstream response complete ms | Reported input/output tokens | Response markers |
| --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
${upstreamRows || '| none | | | | | | | | |'}

## Failure Classification

Failures are classified as conversation-title-failed, provider-limit, provider-http-error, concurrency-not-observed, run-terminal-error, run-interrupted, app-timeout-or-provider-timeout, conversation-leak, encoding-error, process-leak, secret-leak, or app-or-provider-error. A title-gate failure does not establish conversation leakage or identify an upstream HTTP status unless that status was observed separately. UI marker/idle waits stop on a new matching run's terminal error; old runs and other targets cannot trigger this check. Error text is redacted before it is written here.

## Final Verdict

\`${verdict}\`

## Remaining Risk

- Real-provider stress spends provider quota when credentials are present.
- Exact-marker prompts can fail because of model noncompliance even when transport is healthy; such failures remain useful stress evidence.
- If this report was skipped, run \`cd DESKTOP && npm.cmd run release:real-provider-stress\` with \`NEWMARK_REAL_STRESS_*\` or \`ANTHROPIC_*\` credentials to collect live evidence.
`;
  fs.writeFileSync(reportPath, content, 'utf8');
  fs.writeFileSync(evidencePath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    artifact: artifactIdentity,
    provider: provider ? {
      source: provider.source,
      name: provider.name,
      resolvedDeploymentProviderId: providerEvidence.resolvedProviderId || '',
      protocol: provider.protocol,
      model: provider.model,
      upstreamHost: providerEvidence.upstreamHost || new URL(provider.baseUrl).host,
    } : null,
    parameters: {
      scenarios: [...selectedScenarios],
      uiRounds,
      timeoutMs,
      contextMaxTokens,
      longContextTurns,
      queueFirstResponseHoldMs,
      concurrentResponseHoldMs,
    },
    results,
    upstreamRequests: serializableProviderEvidence(),
  }, null, 2), 'utf8');
  log(`report ${reportPath}`);
  log(`evidence ${evidencePath}`);
  return { reportPath, evidencePath, verdict, failCount, passCount, skipped };
}

async function main() {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows real provider stress only runs on win32');
    writeReport(null, '', 'non-win32');
    return;
  }
  if (!fs.existsSync(exePath)) throw new Error(`missing release exe: ${exePath}`);

  const provider = providerFromEnv();
  if (!provider) {
    log('未执行真实重压：缺少凭据');
    writeReport(null, '', 'missing-credentials');
    return;
  }
  activeSecretValues = [provider.apiKey, process.env.NEWMARK_REAL_STRESS_KEY, process.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_API_KEY, process.env.NEWMARK_REAL_API_KEY].filter(Boolean);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkRealProviderStress-'));
  let child;
  let cdp;
  let providerProxy;
  try {
    providerProxy = await createProviderEvidenceProxy(provider);
    writeConfig(root, { ...provider, baseUrl: providerProxy.localBaseUrl });
    if (shouldRunScenario('cli-rounds')) await recordScenario('cli-rounds', () => runCliStress(root, provider));

    const launched = await launchUi(root);
    child = launched.child;
    cdp = launched.cdp;
    if (shouldRunScenario('ui-rounds')) await recordScenario('ui-rounds', () => runUiStress(cdp));
    if (shouldRunScenario('ui-escape-stop')) await recordScenario('ui-escape-stop', () => runUiEscapeStopStress(cdp));
    if (shouldRunScenario('goal-continuation')) await recordScenario('goal-continuation', () => runGoalStress(cdp));
    if (shouldRunScenario('goal-manage-tool')) await recordScenario('goal-manage-tool', () => runGoalManageToolStress(cdp));
    if (shouldRunScenario('conversation-rename-tool')) await recordScenario('conversation-rename-tool', () => runConversationRenameToolStress(cdp));
    if (shouldRunScenario('multi-mode-switch')) await recordScenario('multi-mode-switch', () => runMultiModeSwitchStress(cdp));
    if (shouldRunScenario('web-fetch-reachability')) await recordScenario('web-fetch-reachability', () => runWebFetchReachabilityStress(cdp));
    if (shouldRunScenario('queue-drain')) await recordScenario('queue-drain', () => runQueueStress(cdp));
    if (shouldRunScenario('conversation-isolation')) await recordScenario('conversation-isolation', () => runConversationIsolationStress(cdp));
    if (shouldRunScenario('multi-conversation-running')) await recordScenario('multi-conversation-running', () => runConcurrentConversationSwitchStress(cdp));
    if (shouldRunScenario('long-context')) await recordScenario('long-context', () => runLongContextStress(cdp));
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    try { if (child && !child.killed) child.kill(); } catch {}
    await sleep(1000);
    stopReleaseProcesses(root, child?.pid || activeReleaseProcessId);
    const remaining = releaseProcessCount(child?.pid || activeReleaseProcessId);
    results.push({
      name: 'release-process-cleanup',
      status: remaining === 0 ? 'pass' : 'fail',
      rootCause: remaining === 0 ? '' : 'process-leak',
      elapsedMs: 0,
      detail: `rootPid=${child?.pid || activeReleaseProcessId}; rootProcessRemaining=${remaining}`,
    });
    if (keepRoot) log(`kept root: ${root}`);
    else {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
      catch (error) { log(`warning: could not remove isolated stress root after process cleanup: ${error.message}`); }
    }
    try { await providerProxy?.close(); } catch {}
    const report = writeReport(provider, root);
    if (report.failCount > 0) process.exitCode = 1;
  }
}

module.exports = { classifyFailure, capturePromptAttempt, terminalPromptFailure, assistantMarkerExpression, stateIdleExpression, waitFor, sendUiPrompt };

if (require.main === module) main().catch(error => {
  results.push({
    name: 'real-provider-stress-harness',
    status: 'fail',
    rootCause: classifyFailure(error),
    elapsedMs: 0,
    detail: redact(error && (error.stack || error.message) || error),
  });
  console.error(`[release-real-provider-stress] ${redact(error && (error.stack || error.message) || error)}`);
  try {
    writeReport(providerFromEnv(), '');
  } catch {}
  process.exit(1);
});
