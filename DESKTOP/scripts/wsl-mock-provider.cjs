const http = require('http');

const port = Number(process.argv[2] || 61908);
let calls = 0;
http.createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'wsl-agent-test' }] }));
      return;
    }
    calls++;
    const payload = calls === 1
      ? { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'wsl-write-1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'wsl-backend-proof.txt', content: 'WSL_BACKEND_TOOL_OK' }) } }] } }] }
      : { choices: [{ message: { role: 'assistant', content: 'WSL_BACKEND_AGENT_OK' } }] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
}).listen(port, '127.0.0.1', () => process.stdout.write(`READY ${port}\n`));
