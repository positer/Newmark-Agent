import { Agent } from './core/agent';
import { BrowserControl, BrowserControlResult } from './core/browserControl';
import { ConversationKernel } from './core/conversationKernel';
import { ConversationRuntimeTarget, NormalizedConversationTarget, normalizeConversationTarget } from './core/conversationTarget';
import {
  UtilityAgentRequest,
  UtilityAgentResponse,
} from './core/utilityAgentProtocol';
import {
  configureUtilityHostToolBridge,
  requestUtilityHostTool,
  settleUtilityHostToolResult,
} from './core/utilityHostToolBridge';
import { shutdownTerminalTakeoverSessions } from './tools/terminalTakeover';

const root = String(process.env.NEWMARK_RUNTIME_ROOT || '');
const expectedRuntimeKey = String(process.env.NEWMARK_RUNTIME_KEY || '');
if (!root) throw new Error('NEWMARK_RUNTIME_ROOT is required');
if (!expectedRuntimeKey) throw new Error('NEWMARK_RUNTIME_KEY is required');
const parentPort = process.parentPort;
if (!parentPort) throw new Error('Electron utility parentPort is unavailable');

const host = new Agent(root);
host.tools.setHostProfile({
  kind: 'electron-utility',
  platform: process.platform,
  electronBrowser: true,
  windowsComputerUse: process.platform === 'win32',
});
const kernel = new ConversationKernel(root, host, null);
let activeTarget: NormalizedConversationTarget | null = null;

function post(value: unknown): void {
  parentPort.postMessage(value);
}

kernel.subscribe(event => post({ event: 'work', data: event }));

function checkedTarget(target: ConversationRuntimeTarget): NormalizedConversationTarget {
  const normalized = normalizeConversationTarget(target);
  if (normalized.runtimeKey !== expectedRuntimeKey) {
    throw new Error(`Utility runtime target mismatch: expected ${expectedRuntimeKey}, received ${normalized.runtimeKey}`);
  }
  activeTarget = normalized;
  return normalized;
}

configureUtilityHostToolBridge(
  request => post({ event: 'host_tool_request', data: request }),
  () => activeTarget ? {
    workspaceId: activeTarget.workspaceId,
    conversationId: activeTarget.conversationId,
    runtimeKey: activeTarget.runtimeKey,
    workspaceKey: activeTarget.workspaceKey,
    workspacePath: activeTarget.workspace?.path || root,
  } : null,
  requestId => post({ event: 'host_tool_cancel', data: { requestId } }),
);
BrowserControl.setBackend({
  run: async (request, signal) => await requestUtilityHostTool('browser_control', request, undefined, 30_000, signal) as BrowserControlResult,
});

async function handle(request: UtilityAgentRequest): Promise<unknown> {
  if (request.method === 'ping') return { backend: 'utility', pid: process.pid, runtimeKey: expectedRuntimeKey };
  if (request.method === 'shutdown') {
    shutdownTerminalTakeoverSessions('utility-runtime-shutdown');
    setTimeout(() => process.exit(0), 10);
    return true;
  }
  if (request.method === 'host_tool_result') return settleUtilityHostToolResult(request.params);
  if (request.method === 'prompt') {
    const target = checkedTarget(request.params.target);
    const result = await kernel.prompt(request.params.message, target, request.params.options, request.params.queueMode);
    return { ...result, backend: 'utility', pid: process.pid };
  }
  if (request.method === 'snapshot') return kernel.snapshot(checkedTarget(request.params.target));
  if (request.method === 'rewind') {
    return kernel.rewind(checkedTarget(request.params.target), request.params.messageIndex);
  }
  if (request.method === 'stop') {
    return { ...kernel.requestStop(checkedTarget(request.params.target), request.params.runId), backend: 'utility', pid: process.pid };
  }
  if (request.method === 'guide') {
    const target = checkedTarget(request.params.target);
    return kernel.enqueueGuide({
      ...request.params.envelope,
      target,
    });
  }
  if (request.method === 'checkpoint') return kernel.checkpoint(checkedTarget(request.params.target));
  if (request.method === 'rate_auto_route') {
    return kernel.rateAutoRoute(
      checkedTarget(request.params.target),
      request.params.score,
      request.params.routeId,
    );
  }
  if (request.method === 'set_work_run_expanded') {
    return kernel.setWorkRunExpanded(checkedTarget(request.params.target), request.params.runId, request.params.expanded);
  }
  if (request.method === 'set_input_mode') {
    return kernel.setInputMode(checkedTarget(request.params.target), request.params.mode);
  }
  if (request.method === 'update_setting') {
    host.config.set(request.params.section, request.params.key, request.params.value);
    kernel.updateSetting(request.params.section, request.params.key, request.params.value);
    host.invalidateSystemPrompt();
    return true;
  }
  throw new Error(`Unsupported utility Agent method: ${(request as { method?: string }).method || 'unknown'}`);
}

parentPort.on('message', event => {
  const request = event.data as UtilityAgentRequest;
  if (!request?.id || !request.method) return;
  void handle(request)
    .then(result => post({ id: request.id, ok: true, result } satisfies UtilityAgentResponse))
    .catch(error => post({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies UtilityAgentResponse));
});

process.on('exit', () => {
  BrowserControl.setBackend(null);
  configureUtilityHostToolBridge(null);
});
