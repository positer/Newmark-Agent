import { Agent } from './core/agent';
import * as fs from 'fs';
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
import { markRuntimeLifecycleClean } from './core/runtimeLifecycle';
import { installHostRuntimeHooks } from './core/memoryProbe';
import { WorkEventCoalescer } from './core/workEventCoalescer';

const root = String(process.env.NEWMARK_RUNTIME_ROOT || '');
const expectedRuntimeKey = String(process.env.NEWMARK_RUNTIME_KEY || '');
if (!root) throw new Error('NEWMARK_RUNTIME_ROOT is required');
if (!expectedRuntimeKey) throw new Error('NEWMARK_RUNTIME_KEY is required');
const parentPort = process.parentPort;
if (!parentPort) throw new Error('Electron utility parentPort is unavailable');

const host = new Agent(root, { runtimeLifecycleRole: 'utility' });

/**
 * Diagnostic probe (source-only, env-gated). `memoryProbe.disabled.ts` replaces
 * this module in packaged builds, so no probe code ships in the final artifact.
 */
const hostHooks = installHostRuntimeHooks({ root });

host.tools.setHostProfile({
  kind: 'electron-utility',
  platform: process.platform,
  electronBrowser: true,
  windowsComputerUse: process.platform === 'win32',
});
const kernel = new ConversationKernel(root, host, null);
let activeTarget: NormalizedConversationTarget | null = null;

function post(value: unknown): void {
  hostHooks.countPosted(value);
  try {
    parentPort.postMessage(value);
  } catch { /* the parent may already be gone during shutdown */ }
}

/**
 * dev-0.6.6 long-run stability: coalesce response/thought deltas **inside the
 * host** before they cross the process boundary.
 *
 * Measured defect: the host posted one IPC message per model delta (18,746
 * messages / 722 MiB for ~31 MB of model text — a 23x amplification) and the
 * heap snapshot showed 10,728 retained per-delta strings. The main process
 * already coalesces for the renderer (`main.ts` WorkEventCoalescer) and the
 * renderer expands `coalescedDeltas` back into individual deltas, so batching at
 * the host boundary changes nothing the user or the transcript sees — it only
 * stops the per-delta pile-up. Lifecycle/tool events still flush immediately and
 * keep their ordering.
 */
const hostWorkCoalescer = new WorkEventCoalescer(
  event => post({ event: 'work', data: event }),
  Math.max(4, Number(process.env.NEWMARK_HOST_COALESCE_MS) || 16),
);
function flushHostWorkEvents(): void {
  try { hostWorkCoalescer.flushAll(); } catch { /* shutdown best effort */ }
}
process.on('exit', flushHostWorkEvents);
process.on('beforeExit', flushHostWorkEvents);

kernel.subscribe(event => hostWorkCoalescer.push(event));

function checkedTarget(target: ConversationRuntimeTarget): NormalizedConversationTarget {
  const normalized = normalizeConversationTarget(target);
  if (normalized.runtimeKey !== expectedRuntimeKey) {
    throw new Error(`Utility runtime target mismatch: expected ${expectedRuntimeKey}, received ${normalized.runtimeKey}`);
  }
  activeTarget = normalized;
  return normalized;
}

/**
 * dev-0.6.6 long-run memory reclamation: the transcript part of a snapshot is
 * only sent when the caller cannot already prove it holds that exact revision.
 *
 * Measured before this: RPC responses (mostly snapshots) were **86% of all
 * cross-process bytes** in a 12-round load (24 responses = 329 MiB, single
 * response up to 38 MB) because every poll re-serialized the whole conversation.
 *
 * The handshake is caller-driven: a slim payload is only produced when the
 * caller supplies the revision it currently holds. A caller that holds nothing
 * (or painted another conversation) receives the full transcript; the main
 * process only attaches a revision it received from that same renderer through
 * `conversation:ackTranscript`.
 */
const transcriptRevisions = new Map<string, string>();

interface TranscriptPolicyOptions {
  transcript?: 'auto' | 'force';
  transcriptRevision?: string;
}

function transcriptRevisionOf(snapshot: {
  target?: { workspaceId?: string; conversationId?: string };
  chatMessages?: unknown;
  history?: unknown;
  workRuns?: unknown;
  totalMessages?: unknown;
  windowStart?: unknown;
}): string {
  const messages = Array.isArray(snapshot.chatMessages) ? snapshot.chatMessages as Array<Record<string, unknown>> : [];
  const runs = Array.isArray(snapshot.workRuns) ? snapshot.workRuns as Array<Record<string, unknown>> : [];
  const last = messages.length ? messages[messages.length - 1] : null;
  const lastRun = runs.length ? runs[runs.length - 1] : null;
  // Only what the renderer actually paints takes part in the revision: the
  // visible message window and the work-run summary. `history` deliberately
  // does NOT: it grows on every tool round inside a turn, and folding it in made
  // every mid-turn poll look "changed" (measured: no slim snapshots at all).
  // Anything derived from `history` is only recomputed when the window changes,
  // which is exactly when a full payload is sent anyway.
  return [
    messages.length,
    String(last?.messageId || last?.clientMessageId || last?.timestamp || ''),
    String(typeof last?.content === 'string' ? last.content.length : ''),
    String(snapshot.totalMessages ?? ''),
    String(snapshot.windowStart ?? ''),
    runs.length,
    String(lastRun?.status || ''),
    String(lastRun?.endedAt || ''),
  ].join('|');
}

function applyTranscriptPolicy<T extends {
  target?: { workspaceId?: string; conversationId?: string };
  chatMessages?: unknown;
  history?: unknown;
  workRuns?: unknown;
}>(snapshot: T, options: TranscriptPolicyOptions): T {
  const revision = transcriptRevisionOf(snapshot);
  const key = `${snapshot.target?.workspaceId || ''}::${snapshot.target?.conversationId || ''}`;
  transcriptRevisions.set(key, revision);
  const callerRevision = String(options.transcriptRevision || '');
  const full = options.transcript === 'force' || !callerRevision || callerRevision !== revision;
  if (full) return { ...snapshot, transcriptRevision: revision } as T;
  return {
    ...snapshot,
    chatMessages: undefined,
    history: undefined,
    workRuns: undefined,
    workEvents: undefined,
    transcriptUnchanged: true,
    transcriptRevision: revision,
  } as T;
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
    if (!host.goal || host.goal.paused) markRuntimeLifecycleClean(root, 'utility');
    setTimeout(() => process.exit(0), 10);
    return true;
  }
  if (request.method === 'host_tool_result') return settleUtilityHostToolResult(request.params);
  if (request.method === 'prompt') {
    const target = checkedTarget(request.params.target);
    const result = await kernel.prompt(request.params.message, target, request.params.options, request.params.queueMode);
    return { ...result, backend: 'utility', pid: process.pid };
  }
  if (request.method === 'snapshot') {
    const options = request.params.options || {};
    return applyTranscriptPolicy(kernel.snapshot(checkedTarget(request.params.target), options), options);
  }
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
  if (request.method === 'queue_action') {
    return kernel.queueAction(checkedTarget(request.params.target), request.params.action, request.params.input);
  }
  if (request.method === 'checkpoint') return kernel.checkpoint(checkedTarget(request.params.target));
  if (request.method === 'context_compress') {
    return kernel.compressContext(checkedTarget(request.params.target), request.params.options);
  }
  if (request.method === 'set_work_run_expanded') {
    return kernel.setWorkRunExpanded(checkedTarget(request.params.target), request.params.runId, request.params.expanded);
  }
  if (request.method === 'set_mode') {
    return kernel.setMode(checkedTarget(request.params.target), request.params.mode);
  }
  if (request.method === 'set_model') {
    return kernel.setModel(checkedTarget(request.params.target), request.params.model);
  }
  if (request.method === 'set_input_mode') {
    return kernel.setInputMode(checkedTarget(request.params.target), request.params.mode);
  }
  if (request.method === 'toggle_goal_pause') {
    return kernel.toggleGoalPause(checkedTarget(request.params.target));
  }
  if (request.method === 'clear_goal') {
    return kernel.clearGoal(checkedTarget(request.params.target));
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
