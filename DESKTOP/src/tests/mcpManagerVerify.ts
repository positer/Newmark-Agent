import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpManager } from '../core/mcpManager';

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-mcp-manager-'));
  try {
    const manager = new McpManager(root);
    assert.deepEqual(manager.list(), [], 'new MCP registry starts empty');
    const stdio = manager.upsert({
      name: 'Context server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/context-mcp'],
      env: { MCP_TOKEN: 'secret-value' },
    });
    const listed = manager.list();
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].envKeys, ['MCP_TOKEN'], 'public list exposes only environment key names');
    assert.equal(JSON.stringify(listed).includes('secret-value'), false, 'public list never exposes environment secrets');
    assert.equal(manager.setEnabled(stdio.id, false), true);
    assert.equal(new McpManager(root).list()[0].enabled, false, 'enabled state persists across manager restart');
    manager.upsert({ name: 'Remote MCP', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer secret' } });
    assert.equal(JSON.stringify(manager.list()).includes('Bearer secret'), false, 'public list never exposes HTTP header secrets');
    assert.throws(() => manager.upsert({ name: 'Broken', transport: 'http', url: 'file:///tmp/mcp' }), /http\(s\) URL/);
    assert.equal(manager.remove(stdio.id), true);
    assert.equal(manager.list().length, 1);
    console.log('MCP manager verification passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
