import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function main(): Promise<void> {
  const port = await availablePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-remote-touch-status-'));
  const serverModule = path.join(__dirname, '..', 'server.js');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    remote: { touch_enabled: { value: true } },
    workspace: { auto_create_timestamp_workspace: { value: false } },
    models: { providers: { value: [] }, default_model: { value: '' } },
  }, null, 2));
  const bootstrap = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const Module = require('node:module');",
    `const filename = ${JSON.stringify(serverModule)};`,
    `const root = ${JSON.stringify(root)};`,
    `const port = ${port};`,
    "let source = fs.readFileSync(filename, 'utf8');",
    "source = source.replace('const PORT = 47890;', 'const PORT = ' + port + ';');",
    "if (!source.includes('const PORT = ' + port + ';')) throw new Error('mobile server port seam missing');",
    "const target = new Module(filename, module);",
    "target.filename = filename;",
    "target.paths = Module._nodeModulePaths(path.dirname(filename));",
    "target._compile(source, filename);",
    "(async () => {",
    "  target.exports.configureHostedServer(root, {});",
    "  const cycles = [];",
    "  let previousStartedAt = 0;",
    "  for (let round = 0; round < 10; round += 1) {",
    "    const on = await target.exports.setHostedServerEnabled(true, '127.0.0.1');",
    "    if (!(on.state === 'listening' && on.listening && on.reachable)) throw new Error('on status mismatch: ' + JSON.stringify(on));",
    "    if (!(on.startedAt > previousStartedAt)) throw new Error('service did not restart with a new start time');",
    "    previousStartedAt = on.startedAt;",
    "    const off = await target.exports.setHostedServerEnabled(false, '127.0.0.1');",
    "    if (!(off.state === 'off' && !off.listening && !off.reachable)) throw new Error('off status mismatch: ' + JSON.stringify(off));",
    "    cycles.push({ on, off });",
    "    await new Promise(resolve => setTimeout(resolve, 5));",
    "  }",
    "  console.log('REMOTE_TOUCH_STATUS_RESULT=' + JSON.stringify({ cycles }));",
    "})().then(() => process.exit(0), error => { console.error(error.stack || error.message); process.exit(1); });",
  ].join('\n');
  let output = '';
  const child = spawn(process.execPath, ['-e', bootstrap], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, NEWMARK_BIND_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  try {
    const exitCode = await new Promise<number | null>(resolve => child.once('exit', resolve));
    assert.equal(exitCode, 0, output);
    const marker = output.match(/REMOTE_TOUCH_STATUS_RESULT=(\{.*\})/);
    assert.ok(marker, `missing lifecycle result: ${output}`);
    const result = JSON.parse(marker![1]) as { cycles: Array<{ on: { state: string }; off: { state: string } }> };
    assert.equal(result.cycles.length, 10);
    assert.ok(result.cycles.every(cycle => cycle.on.state === 'listening' && cycle.off.state === 'off'));
    console.log('remote touch server status verification passed: restartCycles=10 pollContractMs=5000');
  } finally {
    try { if (child.exitCode === null) child.kill(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
