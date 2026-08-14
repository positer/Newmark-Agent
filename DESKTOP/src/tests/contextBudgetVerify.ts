import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../core/agent';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-context-budget-'));

try {
  const agent = new Agent(root);
  agent.history = [
    { role: 'system', content: 'Stable instructions.' },
    { role: 'user', content: 'Historical task '.repeat(200) },
    { role: 'assistant', content: 'Historical result '.repeat(200) },
  ];

  const window = agent.contextWindow();
  assert.equal(typeof window.buildBlockTokens, 'number');
  assert.equal(typeof window.longHistoryTokens, 'number');
  assert.equal(typeof window.buildBlockTriggerTokens, 'number');
  assert.equal(typeof window.longHistoryTriggerTokens, 'number');
  assert.equal(typeof window.buildBlockRetentionTokens, 'number');
  assert.equal(typeof window.longHistoryRetentionTokens, 'number');
  assert.equal(typeof window.thresholdReached, 'boolean');
  assert.equal(typeof window.compressionEnabled, 'boolean');
  assert.equal(typeof window.cacheEntries, 'number');
  assert.equal(typeof window.archiveEntries, 'number');
  assert.ok(Number(window.longHistoryTriggerTokens) < Number(window.buildBlockTriggerTokens));

  console.log('Context budget verification passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
