const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const releaseRoot = path.join(repoRoot, 'release', 'win-unpacked');
const exePath = path.resolve(process.env.NEWMARK_CONTEXT_COMPRESS_EXE || path.join(releaseRoot, 'Newmark.exe'));

function assert(condition, message) {
  if (!condition) throw new Error(`context-compress CLI stress failed: ${message}`);
}

function terminateProcessTree(pid) {
  if (!pid || process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
  spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
    shell: false,
    timeout: 15_000,
  });
}

function writeConfig(root, port) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: [{
        name: 'local-compression-mock',
        base_url: `http://127.0.0.1:${port}/v1`,
        api_key: 'fixture-key-not-a-secret',
        protocol: 'openai',
        enabled: true,
        models: ['local-compression-mock'],
      }],
      default_model: 'local-compression-mock',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
    },
    agent: { default_mode: 'build' },
    terminal: { interrupt_timeout_ms: 0 },
  }, null, 2), 'utf8');
}

function requestText(parsed) {
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  return messages
    .filter(message => message?.role === 'user')
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''))
    .join('\n');
}

function hasToolResult(parsed) {
  return (Array.isArray(parsed?.messages) ? parsed.messages : [])
    .some(message => message?.role === 'tool' || message?.role === 'toolResult');
}

function hasNamedToolResult(parsed, toolName) {
  return (Array.isArray(parsed?.messages) ? parsed.messages : [])
    .some(message => (message?.role === 'tool' || message?.role === 'toolResult')
      && String(message?.name || message?.tool_name || '') === toolName);
}

function toolResultTexts(parsed) {
  return (Array.isArray(parsed?.messages) ? parsed.messages : [])
    .filter(message => message?.role === 'tool' || message?.role === 'toolResult')
    .flatMap(message => {
      if (typeof message.content === 'string') return [message.content];
      if (Array.isArray(message.content)) return message.content.map(item => String(item?.text || item || ''));
      return [JSON.stringify(message.content || '')];
    });
}

function writeSse(res, payload) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
}

function writeText(res, text, stream) {
  if (stream) {
    writeSse(res, { choices: [{ delta: { content: text } }] });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
}

function writeToolCall(res, stream, name, args, id) {
  const toolCall = {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
  if (stream) {
    writeSse(res, { choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }] });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [toolCall] } }] }));
}

function startMockServer() {
  const requests = [];
  const requestErrors = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('error', error => { requestErrors.push(error.message); });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      requests.push(parsed);
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'local-compression-mock' }] }));
        return;
      }
      const serialized = JSON.stringify(parsed);
      const isCompressionSummary = parsed.stream !== true
        && /context compression|compress the following conversation segment|omitted transcript/i.test(serialized);
      const prompt = requestText(parsed);
      if (isCompressionSummary) {
        writeText(res, '## Active Or Unfinished Work\nPreserve ACTIVE_CONTEXT_TOOL_REQUEST and the release gate.', false);
      } else if (/ACTIVE_CONTEXT_TOOL_REQUEST/i.test(prompt) && !hasNamedToolResult(parsed, 'context_compress')) {
        const availableToolNames = (Array.isArray(parsed.tools) ? parsed.tools : [])
          .map(tool => String(tool?.function?.name || tool?.name || ''));
        if (availableToolNames.includes('context_compress')) {
          writeToolCall(res, true, 'context_compress', { force: true, keep_recent: 4 }, 'call-active-context-compress');
        } else {
          writeToolCall(res, true, 'tool_provision', { names: ['context_compress'] }, 'provision-active-context-compress');
        }
      } else if (/ACTIVE_CONTEXT_TOOL_REQUEST/i.test(prompt)) {
        writeText(res, 'ACTIVE_CONTEXT_TOOL_OK', true);
      } else {
        writeText(res, 'LOCAL_MOCK_OK', true);
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    port: server.address().port,
    requests,
    requestErrors,
  })));
}

function runCli(root, prompt, conversation) {
  const args = [
    'send',
    prompt,
    '--model',
    'local-compression-mock',
    '--conversation',
    conversation,
    '--root',
    root,
  ];
  if (process.env.NEWMARK_CONTEXT_COMPRESS_AGENT_ONLY === '1') args.splice(2, 0, '--agent-only');
  const timeoutMs = Math.max(1_000, Number(process.env.NEWMARK_CONTEXT_COMPRESS_TIMEOUT_MS || 90_000));
  return new Promise(resolve => {
    const child = spawn(exePath, args, {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, NEWMARK_PROVIDER_DIAGNOSTICS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const finish = (status, signal, error = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status, signal, error, stdout, stderr });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid);
      try { child.kill(); } catch {}
      finish(null, 'SIGTERM', `spawn ${exePath} ETIMEDOUT after ${timeoutMs}ms`);
    }, timeoutMs);
    child.once('error', error => finish(null, null, error.message));
    child.once('close', (status, signal) => {
      finish(status, signal, timedOut ? `spawn ${exePath} ETIMEDOUT after ${timeoutMs}ms` : '');
    });
  });
}

function describeCliResult(label, result, requestCount) {
  console.log(`[context-compress-cli-stress] ${label} status=${result.status} signal=${result.signal || ''} error=${result.error || ''} requests=${requestCount} stdout=${JSON.stringify(result.stdout.slice(0, 800))} stderr=${JSON.stringify(result.stderr.slice(0, 1200))}`);
}

function cleanupTempRoot(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    return true;
  } catch (error) {
    console.warn(`[context-compress-cli-stress] warning: could not remove temp root ${root}: ${error.message}`);
    return false;
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('context-compress CLI stress skipped: Windows packaged executable gate');
    return;
  }
  assert(fs.existsSync(exePath), `missing packaged CLI: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-context-compress-cli-'));
  const mock = await startMockServer();
  try {
    writeConfig(root, mock.port);
    let seed = { status: 0, signal: null, error: '', stdout: '', stderr: '' };
    if (process.env.NEWMARK_CONTEXT_COMPRESS_SKIP_SEED !== '1') {
      const seedTurns = Math.max(1, Number(process.env.NEWMARK_CONTEXT_COMPRESS_SEED_TURNS || 6));
      for (let index = 0; index < seedTurns; index++) {
        seed = await runCli(root, `Seed a normal local mock turn #${index + 1}.`, 'active-compression-cli');
        describeCliResult(`seed-${index + 1}/${seedTurns}`, seed, mock.requests.length);
        assert(seed.status === 0, `seed-${index + 1} exit=${seed.status}; stdout=${seed.stdout.slice(0, 500)}; stderr=${seed.stderr.slice(0, 500)}`);
        assert(seed.stdout.includes('LOCAL_MOCK_OK'), `seed-${index + 1} response missing; stdout=${seed.stdout.slice(0, 500)}`);
      }
    } else {
      console.log('[context-compress-cli-stress] seed skipped by diagnostic environment');
    }
    const activePrompt = process.env.NEWMARK_CONTEXT_COMPRESS_ACTIVE_PROMPT || 'ACTIVE_CONTEXT_TOOL_REQUEST: call context_compress now.';
    const activeConversation = process.env.NEWMARK_CONTEXT_COMPRESS_ACTIVE_CONVERSATION || 'active-compression-cli';
    const active = await runCli(root, activePrompt, activeConversation);
    describeCliResult('active', active, mock.requests.length);
    const observedToolResults = mock.requests.flatMap(toolResultTexts);
    console.log(`[context-compress-cli-stress] toolResults=${JSON.stringify(observedToolResults.slice(-4))}`);
    assert(active.status === 0, `active exit=${active.status}; signal=${active.signal}; error=${active.error}; stdoutLen=${active.stdout.length}; stderr=${active.stderr.slice(0, 1000)}`);
    const expectsToolCall = /ACTIVE_CONTEXT_TOOL_REQUEST/i.test(activePrompt);
    assert(active.stdout.includes(expectsToolCall ? 'ACTIVE_CONTEXT_TOOL_OK' : 'LOCAL_MOCK_OK'), `active response missing; stdout=${active.stdout.slice(0, 1000)}`);
    if (expectsToolCall) {
      assert(mock.requests.some(request => /ACTIVE_CONTEXT_TOOL_REQUEST/i.test(requestText(request)) && Array.isArray(request.tools)), 'mock observed the active tool-call request with a tool schema surface');
      assert(mock.requests.some(request => hasToolResult(request)), 'mock observed a tool result continuation after context_compress');
      assert(observedToolResults.some(result => /"ok"\s*:\s*true/i.test(result) && /"compressed"\s*:\s*true/i.test(result)), 'context_compress tool result reported a successful compression');
      if (process.env.NEWMARK_CONTEXT_COMPRESS_AGENT_ONLY !== '1') {
        assert(observedToolResults.some(result => /"fallback"\s*:\s*false/i.test(result) && /"originalMessages"\s*:\s*\d+/i.test(result)), 'context_compress used the configured model summary path instead of a local fallback');
        assert(mock.requests.some(request => request.stream !== true && /context compression|compress the following conversation segment|omitted transcript/i.test(JSON.stringify(request))), 'mock observed the non-streaming model request used to build the compression summary');
      }
    }
    console.log(`CONTEXT_COMPRESS_CLI_STRESS_PASS requests=${mock.requests.length} seedExit=${seed.status} activeExit=${active.status} requestErrors=${mock.requestErrors.length}`);
  } finally {
    await new Promise(resolve => mock.server.close(resolve));
    if (process.env.NEWMARK_CONTEXT_COMPRESS_KEEP_ROOT === '1') {
      console.log(`[context-compress-cli-stress] kept temp root ${root}`);
    } else {
      cleanupTempRoot(root);
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
