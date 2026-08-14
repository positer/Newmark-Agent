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
    assert.equal(listed[0].enabled, false, 'new and imported MCP definitions are disabled until explicitly enabled');
    assert.deepEqual(listed[0].envKeys, ['MCP_TOKEN'], 'public list exposes only environment key names');
    assert.equal(JSON.stringify(listed).includes('secret-value'), false, 'public list never exposes environment secrets');
    const duplicate = manager.upsert({ name: 'context SERVER', transport: 'stdio', command: 'npx' });
    assert.equal(duplicate.id, stdio.id, 'an identical name/transport/endpoint import is idempotent');
    assert.equal(manager.list().length, 1, 'idempotent imports do not create duplicates');
    manager.upsert({ id: stdio.id, name: 'Context server updated' });
    assert.deepEqual(manager.list()[0].envKeys, ['MCP_TOKEN'], 'omitting env during edit preserves saved secrets');
    assert.equal(fs.readFileSync(path.join(root, 'MCP.json'), 'utf8').includes('secret-value'), true, 'preserved secret remains stored locally');
    manager.upsert({ id: stdio.id, env: {} });
    assert.deepEqual(manager.list()[0].envKeys, [], 'an explicit empty env object clears saved environment entries');
    manager.upsert({ id: stdio.id, transport: 'http', url: 'https://example.test/context', headers: { Authorization: 'Bearer moved-secret' } });
    assert.equal(manager.list()[0].command, undefined, 'switching to HTTP removes stdio-only fields');
    assert.deepEqual(manager.list()[0].envKeys, [], 'switching to HTTP removes stdio secrets');
    manager.upsert({ id: stdio.id, transport: 'stdio', command: 'node', args: ['server.js'], env: { MCP_TOKEN: 'restored' } });
    assert.equal(manager.list()[0].url, undefined, 'switching back to stdio removes HTTP-only fields');
    assert.deepEqual(manager.list()[0].headerKeys, [], 'switching back to stdio removes HTTP header secrets');
    assert.equal(manager.setEnabled(stdio.id, false), true);
    assert.equal(new McpManager(root).list()[0].enabled, false, 'enabled state persists across manager restart');
    manager.upsert({ name: 'Remote MCP', transport: 'http', url: 'https://example.test/mcp?access_token=do-not-render', headers: { Authorization: 'Bearer secret' } });
    assert.equal(JSON.stringify(manager.list()).includes('Bearer secret'), false, 'public list never exposes HTTP header secrets');
    assert.equal(JSON.stringify(manager.list()).includes('do-not-render'), false, 'public list redacts sensitive URL query values');
    assert.throws(() => manager.upsert({ name: 'Broken', transport: 'http', url: 'file:///tmp/mcp' }), /http\(s\) URL/);
    assert.throws(() => manager.upsert({ name: 'Credentials', transport: 'http', url: 'https://user:pass@example.test/mcp' }), /credentials in headers/);
    assert.throws(() => manager.upsert({ name: 'Bad args', transport: 'stdio', command: 'node', args: ['ok', 7] }), /array of strings|at most 100 strings/);
    assert.throws(() => manager.upsert({ name: 'Bad env', transport: 'stdio', command: 'node', env: [] }), /JSON object/);
    assert.throws(() => manager.upsert({ name: 'Bad header', transport: 'http', url: 'https://example.test', headers: { Authorization: 'safe\r\ninjected: true' } }), /invalid value/);
    assert.throws(() => manager.upsert({ name: 'Bad key', transport: 'stdio', command: 'node', env: { ['__proto__']: 'nope' } }), /invalid key/);
    assert.throws(() => manager.upsert({ name: '', transport: 'stdio', command: 'node' }), /name is required/);
    assert.throws(() => manager.upsert({ name: 'Bad transport', transport: 'socket', command: 'node' }), /transport must/);
    assert.equal(manager.remove(stdio.id), true);
    assert.equal(manager.list().length, 1);

    const corruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-mcp-corrupt-'));
    try {
      fs.writeFileSync(path.join(corruptRoot, 'MCP.json'), '{ definitely not JSON', 'utf8');
      const recovered = new McpManager(corruptRoot);
      assert.deepEqual(recovered.list(), [], 'a corrupt registry fails closed to an empty public list');
      recovered.upsert({ name: 'Recovered', transport: 'stdio', command: 'node' });
      assert.equal(fs.readdirSync(corruptRoot).some(name => name.startsWith('MCP.json.corrupt-')), true, 'the corrupt source is preserved before a replacement is saved');
      assert.equal(new McpManager(corruptRoot).list().length, 1, 'the recovered atomic registry survives restart');
    } finally {
      fs.rmSync(corruptRoot, { recursive: true, force: true });
    }
    console.log('MCP manager verification passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
