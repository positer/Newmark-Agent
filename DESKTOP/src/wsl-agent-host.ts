import * as readline from 'readline';
import { Agent } from './core/agent';
import { ConversationKernel } from './core/conversationKernel';
import { WslAgentRequest, WslAgentResponse, WslAgentWorkspace } from './core/wslAgentProtocol';

const root = process.env.NEWMARK_WSL_ROOT || '';
const distro = process.env.NEWMARK_WSL_DISTRO || 'WSL';
if (!root) throw new Error('NEWMARK_WSL_ROOT is required');

// Keep stdout reserved for the JSONL protocol even when dependencies log diagnostics.
const diagnostic = (...values: unknown[]): void => {
  process.stderr.write(`${values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}\n`);
};
console.log = diagnostic;
console.info = diagnostic;
console.warn = diagnostic;

const host = new Agent(root);
const kernel = new ConversationKernel(root, host, null);
kernel.subscribe(event => write({ event: 'work', data: event }));

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function applyWorkspace(workspace: WslAgentWorkspace | null): void {
  if (!workspace) {
    host.workspace.current = null;
    host.config.clearWorkspaceOverrides();
    return;
  }
  host.workspace.current = {
    name: workspace.name,
    path: workspace.path,
    isInternal: !!workspace.isInternal,
    hostBinding: '',
    icon: '',
    kind: workspace.kind === 'ssh' ? 'ssh' : 'local',
  };
  host.config.loadWorkspaceConfig(workspace.path);
}

async function handle(request: WslAgentRequest): Promise<unknown> {
  if (request.method === 'ping') return { backend: 'wsl', distro, pid: process.pid, platform: process.platform, root };
  if (request.method === 'shutdown') {
    setTimeout(() => process.exit(0), 10);
    return true;
  }
  if (request.method === 'abort') return kernel.abort(request.params.conversationId);
  if (request.method === 'snapshot') {
    applyWorkspace(request.params.workspace);
    const snapshot = host.getConversationSnapshot(request.params.conversationId);
    return { ...snapshot, queued: kernel.queued(request.params.conversationId), workEvents: kernel.events(request.params.conversationId), backend: 'wsl', distro };
  }
  applyWorkspace(request.params.workspace);
  const target = request.params.conversationId || 'default';
  host.setConversation(target);
  const result = await kernel.prompt(
    request.params.message,
    target,
    request.params.options,
    request.params.queueMode,
  );
  return { ...result, backend: 'wsl', distro };
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let request: WslAgentRequest;
  try {
    request = JSON.parse(line) as WslAgentRequest;
  } catch {
    return;
  }
  void handle(request)
    .then(result => write({ id: request.id, ok: true, result } satisfies WslAgentResponse))
    .catch(error => write({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WslAgentResponse));
});
input.on('close', () => process.exit(0));
