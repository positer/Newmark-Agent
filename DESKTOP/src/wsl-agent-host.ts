import * as readline from 'readline';
import { Agent } from './core/agent';
import { ConversationKernel } from './core/conversationKernel';
import { WslAgentRequest, WslAgentResponse, WslAgentWorkspace } from './core/wslAgentProtocol';
import { configureWslHostToolWriter, rejectPendingWslHostTools, settleWslHostToolResult } from './core/wslHostToolBridge';
import {
  detachTerminalTakeoverSession,
  onTerminalTakeoverEvent,
  resizeTerminalTakeoverSession,
  shutdownTerminalTakeoverSessions,
  stopTerminalTakeoverSession,
  terminalTakeoverState,
  writeTerminalTakeoverSession,
} from './tools/terminalTakeover';

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

let host = new Agent(root);
let kernel = new ConversationKernel(root, host, null);
let unsubscribeKernel = kernel.subscribe(event => write({ event: 'work', data: event }));
onTerminalTakeoverEvent(event => write({ event: 'terminal', data: event }));

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
configureWslHostToolWriter(write);

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

function resetAgentRuntime(): void {
  unsubscribeKernel();
  host = new Agent(root);
  kernel = new ConversationKernel(root, host, null);
  unsubscribeKernel = kernel.subscribe(event => write({ event: 'work', data: event }));
}

async function handle(request: WslAgentRequest): Promise<unknown> {
  if (request.method === 'ping') return { backend: 'wsl', distro, pid: process.pid, platform: process.platform, root };
  if (request.method === 'shutdown') {
    shutdownTerminalTakeoverSessions('wsl-host-shutdown');
    setTimeout(() => process.exit(0), 10);
    return true;
  }
  if (request.method === 'reset') {
    resetAgentRuntime();
    return true;
  }
  if (request.method === 'host_tool_result') {
    return settleWslHostToolResult(request.params);
  }
  if (request.method === 'terminal_state') {
    return terminalTakeoverState(request.params.owner, request.params.persistenceRoot || root);
  }
  if (request.method === 'terminal_write') {
    return writeTerminalTakeoverSession(request.params.sessionId, request.params.data, request.params.owner);
  }
  if (request.method === 'terminal_resize') {
    return resizeTerminalTakeoverSession(request.params.sessionId, request.params.cols, request.params.rows, request.params.owner);
  }
  if (request.method === 'terminal_stop') {
    return stopTerminalTakeoverSession(request.params.sessionId, request.params.owner, 'remote-stop');
  }
  if (request.method === 'terminal_detach') {
    return detachTerminalTakeoverSession(request.params.sessionId, request.params.owner);
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
input.on('close', () => {
  shutdownTerminalTakeoverSessions('wsl-stdin-closed');
  configureWslHostToolWriter(null);
  rejectPendingWslHostTools('WSL Agent host stdin closed');
  process.exit(0);
});
