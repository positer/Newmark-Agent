import { bindBrowserUseRequest } from '../core/browserUse';
import { normalizeConversationTarget, NormalizedConversationTarget } from '../core/conversationTarget';
import { UtilityAgentRequest, UtilityAgentResponse } from '../core/utilityAgentProtocol';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  configureUtilityHostToolBridge,
  requestUtilityHostTool,
  settleUtilityHostToolResult,
} from '../core/utilityHostToolBridge';

const root = String(process.env.NEWMARK_RUNTIME_ROOT || '');
const expectedRuntimeKey = String(process.env.NEWMARK_RUNTIME_KEY || '');
const parentPort = process.parentPort;
if (!root || !expectedRuntimeKey || !parentPort) throw new Error('Browser-Use utility fixture requires a target-bound Electron utility process');

let activeTarget: NormalizedConversationTarget | null = null;
const post = (value: unknown): void => parentPort.postMessage(value);

configureUtilityHostToolBridge(
  request => post({ event: 'host_tool_request', data: request }),
  () => activeTarget ? {
    workspaceId: activeTarget.workspaceId,
    conversationId: activeTarget.conversationId,
    runtimeKey: activeTarget.runtimeKey,
    workspaceKey: activeTarget.workspaceKey,
    workspacePath: activeTarget.workspace?.path || root,
  } : null,
);

async function handle(request: UtilityAgentRequest): Promise<unknown> {
  if (request.method === 'ping') return { backend: 'utility-fixture', pid: process.pid, runtimeKey: expectedRuntimeKey };
  if (request.method === 'shutdown') {
    configureUtilityHostToolBridge(null);
    setTimeout(() => process.exit(0), 10);
    return true;
  }
  if (request.method === 'host_tool_result') return settleUtilityHostToolResult(request.params);
  if (request.method === 'snapshot') {
    if (fs.existsSync(path.join(root, 'inject-replacement-snapshot-failure'))) {
      throw new Error(`injected replacement target snapshot failure pid=${process.pid}`);
    }
    const target = normalizeConversationTarget(request.params.target);
    if (target.runtimeKey !== expectedRuntimeKey) throw new Error('Utility fixture target mismatch');
    return { target, runtime: null, queued: { steering: [], followUp: [] }, workEvents: [] };
  }
  if (request.method === 'prompt') {
    const target = normalizeConversationTarget(request.params.target);
    if (target.runtimeKey !== expectedRuntimeKey) throw new Error('Utility fixture target mismatch');
    activeTarget = target;
    if (request.params.message === '__hang_prompt__') {
      return await new Promise<never>(() => undefined);
    }
    if (request.params.message === '__spawn_descendant_tree__') {
      const markerDelayMs = 15_000;
      const readyPath = path.join(root, 'utility-descendant-ready.json');
      const markerPath = path.join(root, 'utility-descendant-marker.json');
      const lateTriggerPath = path.join(root, 'utility-descendant-late-trigger');
      const lateReadyPath = path.join(root, 'utility-descendant-late-ready.json');
      const descendant = spawn(process.execPath, [path.join(__dirname, 'utilityProcessDescendantFixture.js')], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          NEWMARK_DESCENDANT_READY: readyPath,
          NEWMARK_DESCENDANT_MARKER: markerPath,
          NEWMARK_DESCENDANT_MARKER_DELAY_MS: String(markerDelayMs),
          NEWMARK_DESCENDANT_LATE_TRIGGER: lateTriggerPath,
          NEWMARK_DESCENDANT_LATE_READY: lateReadyPath,
        },
        stdio: 'ignore',
        windowsHide: true,
      });
      descendant.unref();
      return {
        target,
        backend: 'utility',
        pid: process.pid,
        branchPid: Number(descendant.pid || 0),
        readyPath,
        markerPath,
        lateTriggerPath,
        lateReadyPath,
        markerDelayMs,
      };
    }
    const spoofed = bindBrowserUseRequest({ action: 'observe', actionId: `fixture-${target.workspaceId}` }, {
      runtimeKey: 'spoofed-worker-runtime',
      actorId: 'spoofed-worker-owner',
    });
    const receipt = await requestUtilityHostTool('browser_use', spoofed, {
      conversationId: 'spoofed-conversation',
      workspaceId: 'spoofed-workspace',
      actorId: 'utility-fixture-actor',
      workspacePath: root,
      backend: 'utility',
      mode: 'build',
      runtimeKey: 'spoofed-context-runtime',
    }, 15_000);
    return { receipt, target, backend: 'utility', pid: process.pid };
  }
  throw new Error(`Unsupported Browser-Use utility fixture method: ${(request as { method?: string }).method || 'unknown'}`);
}

parentPort.on('message', event => {
  const request = event.data as UtilityAgentRequest;
  if (!request?.id || !request.method) return;
  void handle(request)
    .then(result => post({ id: request.id, ok: true, result } satisfies UtilityAgentResponse))
    .catch(error => post({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies UtilityAgentResponse));
});
