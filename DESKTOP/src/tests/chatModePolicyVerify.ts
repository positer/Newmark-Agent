import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../core/agent';
import { evaluateToolPolicy } from '../core/toolPolicy';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-chat-mode-'));
try {
  const agent = new Agent(root);
  agent.setMode('chat');

  const names = (agent.cachedToolDefinitions() as any[])
    .map(definition => String(definition?.function?.name || ''))
    .sort();
  assert.deepEqual(names, ['web_fetch', 'web_search']);
  assert.equal(evaluateToolPolicy({ name: 'web_search', mode: 'chat' }).allowed, true);
  assert.equal(evaluateToolPolicy({ name: 'web_fetch', mode: 'chat' }).allowed, true);
  assert.equal(evaluateToolPolicy({ name: 'write', mode: 'chat' }).allowed, false);
  assert.equal(evaluateToolPolicy({ name: 'bash', mode: 'chat' }).allowed, false);

  const prompt = agent.buildSystemPrompt();
  assert.match(prompt, /CHAT MODE\./);
  assert.match(prompt, /only web_search and web_fetch/i);
  assert.match(prompt, /summarize and answer the user as soon as possible/i);

  const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  assert.match(ui, /<option value="chat">Chat<\/option>/);
  assert.match(ui, /chat: t\('mode\.chat'\)/);
  console.log('chatModePolicyVerify: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
