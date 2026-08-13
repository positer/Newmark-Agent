import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';

type KernelStub = {
  steer(message: unknown): boolean;
  followUp(message: unknown): boolean;
  abort(): void;
};

function writeRoot(root: string): void {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    workspace: { auto_create_timestamp_workspace: { value: false } },
    models: { providers: { value: [] }, default_model: { value: '' } },
  }), 'utf8');
  fs.writeFileSync(path.join(root, 'agent.md'), 'TUI stop handoff regression.', 'utf8');
}

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-tui-stop-race-'));
  try {
    writeRoot(root);
    const agent = new Agent(root, { agentOnly: true, conversationId: 'tui-stop-race' });
    let abortCalls = 0;
    const kernel: KernelStub = {
      steer: () => true,
      followUp: () => true,
      abort: () => { abortCalls += 1; },
    };
    const controller = new AbortController();
    (agent as unknown as { activeProcessAbortController: AbortController }).activeProcessAbortController = controller;
    assert.strictEqual(agent.abortActiveKernelRun(), true, 'stopping before Native Kernel attach aborts the outer process signal');
    agent.attachAgentKernelRuntime(kernel);
    assert.strictEqual(abortCalls, 1, 'a Native Kernel attaching after the stop inherits the already-aborted signal');
    agent.attachAgentKernelRuntime(null);
    console.log(JSON.stringify({ ok: true, assertions: 2 }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
