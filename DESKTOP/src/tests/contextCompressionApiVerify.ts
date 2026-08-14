import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../core/agent';
import { ConversationKernel } from '../core/conversationKernel';

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-context-api-'));
  try {
    const host = new Agent(root);
    const runner = new Agent(root);
    runner.workspace.current = {
      id: 'workspace',
      name: 'workspace',
      path: root,
      isInternal: true,
      hostBinding: '',
      icon: '',
      kind: 'local',
    };
    runner.setConversation('conversation');
    runner.history = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `context entry ${index} `.repeat(20),
    }));
    runner.saveWorkspaceConversationState(true);
    const kernel = new ConversationKernel(root, host, null, { createRunner: () => runner });
    const result = await kernel.compressContext({
      workspaceId: 'workspace',
      conversationId: 'conversation',
      workspace: { id: 'workspace', name: 'workspace', path: root, isInternal: true, kind: 'local' },
    });

    assert.equal(result.ok, true);
    assert.equal((result.displayHistory as { untouched?: boolean }).untouched, true);
    assert.equal(typeof (result.contextWindow as { buildBlockTriggerTokens?: number }).buildBlockTriggerTokens, 'number');
    assert.ok(runner.history.length < 20);

    console.log('Context compression API verification passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

void main();
