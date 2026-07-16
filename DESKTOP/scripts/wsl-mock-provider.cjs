const http = require('http');

const port = Number(process.argv[2] || 61908);
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const stats = {
  models: 0,
  proof: { requests: 0, toolCallIssued: 0, toolResultSeen: 0 },
  vision: { requests: 0, toolCallIssued: 0, toolResultSeen: 0, secondRequest: null },
};

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function containsMarker(value, marker) {
  if (typeof value === 'string') return !value.startsWith('data:image/') && value.includes(marker);
  if (Array.isArray(value)) return value.some(item => containsMarker(item, marker));
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(item => containsMarker(item, marker));
}

function inspectVisionToolRequest(messages) {
  const toolMessages = Array.isArray(messages)
    ? messages.filter(message => message && message.role === 'tool')
    : [];
  let imageUrlDataCount = 0;
  let uiAutomationText = false;
  let leakedTransportKey = false;
  let leakedTempPath = false;
  const textParts = toolMessages.flatMap(message => {
    if (typeof message.content === 'string') return [message.content];
    if (!Array.isArray(message.content)) return [];
    return message.content
      .filter(part => part && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text);
  });
  const walk = (value, key = '') => {
    if (key === 'vision_image_path' || key === 'vision_image_data_url') leakedTransportKey = true;
    if (typeof value === 'string') {
      if (/newmark-computer-use/i.test(value)) leakedTempPath = true;
      if (/vision_image_(?:path|data_url)/i.test(value)) leakedTransportKey = true;
      if (/windows-ui-automation|ui automation|native-screenshot-plus-windows/i.test(value)) uiAutomationText = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.type === 'image_url') {
      const url = value.image_url && typeof value.image_url === 'object' ? String(value.image_url.url || '') : '';
      if (/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/i.test(url)) imageUrlDataCount += 1;
    }
    for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
  };
  walk(toolMessages);
  const combinedText = textParts.join('\n');
  let parsedToolText = null;
  for (const text of textParts) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') { parsedToolText = parsed; break; }
    } catch {}
  }
  return {
    toolMessageCount: toolMessages.length,
    textPartCount: textParts.length,
    textBytes: Buffer.byteLength(combinedText, 'utf8'),
    imageUrlDataCount,
    uiAutomationText,
    leakedTransportKey,
    leakedTempPath,
    toolOk: parsedToolText?.ok === true,
    toolAction: typeof parsedToolText?.action === 'string' ? parsedToolText.action : '',
    toolErrorPresent: parsedToolText?.ok === false || /\[Error\]|error/i.test(combinedText),
    hostToolUnavailable: /host tool|host_tool|unavailable|not available/i.test(combinedText),
    windowsOnly: /windows-only|supports native desktop control on windows/i.test(combinedText),
    captureFailed: /screenshot capture failed|capture failed/i.test(combinedText),
    safeErrorSummary: combinedText
      .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, '[image-data-redacted]')
      .replace(/[A-Za-z]:\\[^\s"']+/g, '[path-redacted]')
      .replace(/\/mnt\/[a-z]\/[^\s"']+/gi, '[path-redacted]')
      .slice(0, 240),
  };
}

function toolCall(id, name, args) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/stats') {
    sendJson(response, 200, stats);
    return;
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    stats.models += 1;
    sendJson(response, 200, { data: [{ id: 'wsl-agent-test' }] });
    return;
  }
  if (request.method !== 'POST' || !String(request.url || '').startsWith('/v1/')) {
    request.resume();
    sendJson(response, 404, { error: 'not found' });
    return;
  }

  let body = '';
  let tooLarge = false;
  request.on('data', chunk => {
    if (tooLarge) return;
    body += String(chunk);
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      tooLarge = true;
      body = '';
    }
  });
  request.on('end', () => {
    if (tooLarge) {
      sendJson(response, 413, { error: 'request too large' });
      return;
    }
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch {
      sendJson(response, 400, { error: 'invalid json' });
      return;
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const isVision = containsMarker(messages, 'WSL_VISION_SMOKE') || containsMarker(messages, 'wsl-computer-use-1');
    if (isVision) {
      stats.vision.requests += 1;
      const hasToolResult = messages.some(message => message?.role === 'tool' && message?.tool_call_id === 'wsl-computer-use-1');
      if (!hasToolResult) {
        stats.vision.toolCallIssued += 1;
        sendJson(response, 200, toolCall('wsl-computer-use-1', 'computer_use', {
          action: 'observe',
          capture_max_width: 640,
          capture_max_height: 480,
        }));
        return;
      }
      stats.vision.toolResultSeen += 1;
      stats.vision.secondRequest = inspectVisionToolRequest(messages);
      sendJson(response, 200, { choices: [{ message: { role: 'assistant', content: 'WSL_VISION_AGENT_OK' } }] });
      return;
    }

    stats.proof.requests += 1;
    const hasToolResult = messages.some(message => message?.role === 'tool' && message?.tool_call_id === 'wsl-write-1');
    if (!hasToolResult) {
      stats.proof.toolCallIssued += 1;
      sendJson(response, 200, toolCall('wsl-write-1', 'write', {
        path: 'wsl-backend-proof.txt',
        content: 'WSL_BACKEND_TOOL_OK',
      }));
      return;
    }
    stats.proof.toolResultSeen += 1;
    sendJson(response, 200, { choices: [{ message: { role: 'assistant', content: 'WSL_BACKEND_AGENT_OK' } }] });
  });
}).listen(port, '127.0.0.1', () => process.stdout.write(`READY ${port}\n`));
