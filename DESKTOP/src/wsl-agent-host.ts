import * as readline from 'readline';
import * as fs from 'fs';
import { Agent } from './core/agent';
import { ConversationKernel } from './core/conversationKernel';
import { WslAgentRequest, WslAgentResponse, WslAgentWorkspace } from './core/wslAgentProtocol';
import { ConversationRuntimeTarget, normalizeConversationTarget } from './core/conversationTarget';
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

function configureWslToolHost(agent: Agent): void {
  agent.tools.setHostProfile({
    kind: 'wsl',
    platform: 'linux',
    // This process is Electron-managed and can route Browser-Use back to the
    // owning window, but it must never advertise Windows desktop control.
    electronBrowser: true,
    windowsComputerUse: false,
  });
}

function createWslAgent(actorId?: string): Agent {
  const agent = new Agent(root, {
    agentOnly: true,
    workspaceRegistryMode: 'detached',
    actorId,
  });
  configureWslToolHost(agent);
  return agent;
}

function createWslKernel(agent: Agent): ConversationKernel {
  return new ConversationKernel(root, agent, null, {
    createRunner: () => createWslAgent(agent.runtimeActorId),
  });
}

let host = createWslAgent();
let kernel = createWslKernel(host);
let unsubscribeKernel = kernel.subscribe(event => write({ event: 'work', data: event }));
onTerminalTakeoverEvent(event => write({ event: 'terminal', data: event }));

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
configureWslHostToolWriter(write);

function runtimeIdentity(): { pid: number; pgid: number; sessionId: number } {
  const pid = process.pid;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) throw new Error(`Unable to read WSL runtime identity for pid ${pid}`);
  // /proc/<pid>/stat fields following comm: state, ppid, pgrp, session, ...
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const pgid = Number(fields[2] || 0);
  const sessionId = Number(fields[3] || 0);
  if (![pid, pgid, sessionId].every(value => Number.isSafeInteger(value) && value > 1)) {
    throw new Error(`Invalid WSL runtime identity: pid=${pid} pgid=${pgid} session=${sessionId}`);
  }
  return { pid, pgid, sessionId };
}

function applyWorkspace(workspace: WslAgentWorkspace | null): void {
  if (!workspace) {
    host.workspace.current = null;
    host.config.clearWorkspaceOverrides();
    return;
  }
  host.workspace.current = {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    isInternal: !!workspace.isInternal,
    hostBinding: '',
    icon: '',
    kind: workspace.kind === 'ssh' ? 'ssh' : 'local',
  };
  host.config.loadWorkspaceConfig(workspace.path);
}

function requestTarget(input: { target?: ConversationRuntimeTarget; conversationId?: string; workspace?: WslAgentWorkspace | null }): ConversationRuntimeTarget {
  if (input.target) return normalizeConversationTarget(input.target);
  const workspace = input.workspace || null;
  return normalizeConversationTarget({
    workspaceId: String(workspace?.id || workspace?.name || workspace?.path || 'none'),
    conversationId: String(input.conversationId || 'default'),
    workspace: workspace ? {
      id: String(workspace.id || workspace.name || workspace.path),
      name: workspace.name,
      path: workspace.path,
      isInternal: !!workspace.isInternal,
      kind: workspace.kind,
    } : null,
  });
}

function resetAgentRuntime(): void {
  unsubscribeKernel();
  host = createWslAgent();
  kernel = createWslKernel(host);
  unsubscribeKernel = kernel.subscribe(event => write({ event: 'work', data: event }));
}

async function handle(request: WslAgentRequest): Promise<unknown> {
  if (request.method === 'ping') return { backend: 'wsl', distro, ...runtimeIdentity(), platform: process.platform, root };
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
  if (request.method === 'abort') return kernel.abort(requestTarget(request.params));
  if (request.method === 'stop') {
    return { ...kernel.requestStop(requestTarget(request.params), request.params.runId), backend: 'wsl', distro };
  }
  if (request.method === 'snapshot') {
    const target = requestTarget(request.params);
    return { ...kernel.snapshot(target), backend: 'wsl', distro };
  }
  if (request.method === 'rewind') {
    return kernel.rewind(requestTarget(request.params), request.params.messageIndex);
  }
  if (request.method === 'guide') {
    const target = requestTarget(request.params);
    return kernel.enqueueGuide({
      ...request.params.envelope,
      target,
    });
  }
  if (request.method === 'checkpoint') return kernel.checkpoint(requestTarget(request.params));
  if (request.method === 'rate_auto_route') {
    return kernel.rateAutoRoute(
      requestTarget(request.params),
      request.params.score,
      request.params.routeId,
    );
  }
  if (request.method === 'set_work_run_expanded') {
    return kernel.setWorkRunExpanded(requestTarget(request.params), request.params.runId, request.params.expanded);
  }
  if (request.method === 'update_setting') {
    host.config.set(request.params.section, request.params.key, request.params.value);
    kernel.updateSetting(request.params.section, request.params.key, request.params.value);
    return true;
  }
  if (request.method === 'prompt') {
    const target = requestTarget(request.params);
    const result = await kernel.prompt(
      request.params.message,
      target,
      request.params.options,
      request.params.queueMode,
    );
    return { ...result, backend: 'wsl', distro };
  }
  throw new Error(`Unsupported WSL Agent method: ${(request as { method?: string }).method || 'unknown'}`);
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
