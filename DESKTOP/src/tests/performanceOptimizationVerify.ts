import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-performance-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      general: { language: { value: 'en' } },
      agent: { default_mode: { value: 'build' } },
      workspace: { prompt_mode: { value: 'global_only' }, auto_create_timestamp_workspace: { value: false } },
      models: { providers: { value: [] } },
    }));
    fs.writeFileSync(path.join(root, 'agent.md'), 'Performance test prompt.');
    const agent = new Agent(root, { agentOnly: true });
    const firstPrompt = agent.buildSystemPrompt();
    assert.strictEqual(agent.buildSystemPrompt(), firstPrompt, 'stable system prompt is cached');
    const firstTools = agent.cachedToolDefinitions();
    assert.strictEqual(agent.cachedToolDefinitions(), firstTools, 'stable tool catalog is cached');
    agent.setMode('plan');
    assert.notStrictEqual(agent.cachedToolDefinitions(), firstTools, 'mode changes invalidate tool catalog cache');
    console.log(JSON.stringify({ ok: true, assertions: 3 }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
