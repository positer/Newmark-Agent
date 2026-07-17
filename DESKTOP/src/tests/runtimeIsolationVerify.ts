import * as assert from 'assert';
import {
  ConversationRuntimeTarget,
  conversationRuntimeKey,
  normalizeConversationTarget,
  sameConversationTarget,
} from '../core/conversationTarget';
import { WorkspaceSelectionCoordinator } from '../core/workspaceSelectionCoordinator';
import {
  ConversationKernel,
  ConversationKernelRunOptions,
  ConversationStopResult,
} from '../core/conversationKernel';
import { Agent } from '../core/agent';
import { normalizeHostWorkspacePath } from '../core/workspace';
import { AgentWorkEvent, ConversationInputEnvelope, GuideReceipt, StreamToken } from '../core/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { WslAgentRuntimePool, WslTargetRuntimeClient } from '../core/wslAgentRuntimePool';
import {
  WslAgentClient,
  WslCommandResult,
  WslCommandRunner,
  WslRuntimeIdentity,
} from '../core/wslAgentClient';
import { WslAgentPromptRequest, WslAgentPromptResult, WslAgentStopResult, WslHostToolRequest } from '../core/wslAgentProtocol';
import { ElectronTargetRuntimeClient, ElectronUtilityRuntimePool } from '../core/electronUtilityRuntimePool';
import {
  UtilityAgentPromptResult,
  UtilityAgentSnapshotResult,
  UtilityAgentStopResult,
  UtilityHostToolRequest,
  UtilityPromptRequest,
} from '../core/utilityAgentProtocol';
import { createUtilityHostToolHandler } from '../core/utilityHostToolRouter';
import { terminalTakeoverWorkspaceId } from '../tools/terminalTakeover';
import { SubagentManager, SubagentState } from '../core/subagent';
import { runAsyncProcess } from '../core/asyncProcess';
import {
  activeWindowsProcessHelperPidsForTest,
  drainWindowsProcessHelpers,
  setWindowsProcessQueryAnchorBarrierForTest,
  setWindowsProcessQueryScriptForTest,
  snapshotWindowsProcessTree,
  terminateCapturedWindowsProcessTree,
  terminateWindowsProcessHelperForTest,
  trackWindowsProcessHelperForTest,
} from '../core/electronUtilityAgentClient';
import { runRuntimeShutdownBarrier } from '../core/runtimeShutdown';

function target(workspaceId: string, workspacePath: string, conversationId = 'default'): ConversationRuntimeTarget {
  return {
    workspaceId,
    workspace: {
      id: workspaceId,
      name: workspaceId,
      path: workspacePath,
      isInternal: false,
      kind: 'local',
    },
    conversationId,
  };
}

async function verifyConversationTargets(): Promise<void> {
  const alpha = normalizeConversationTarget(target('alpha', 'C:\\Work\\Alpha', 'same'));
  const alphaAlias = normalizeConversationTarget(target('renamed-alpha', 'c:/work/alpha/', 'same'));
  const beta = normalizeConversationTarget(target('beta', 'C:\\Work\\Beta', 'same'));
  const alphaOtherConversation = normalizeConversationTarget(target('alpha', 'C:\\Work\\Alpha', 'other'));

  assert.equal(alpha.conversationId, 'same');
  assert.equal(alpha.workspaceKey, alphaAlias.workspaceKey, 'workspace identity must survive case, separator, trailing slash, and display-name changes');
  assert.equal(conversationRuntimeKey(alpha), conversationRuntimeKey(alphaAlias), 'runtime identity must be canonical for the same workspace and conversation');
  assert.notEqual(conversationRuntimeKey(alpha), conversationRuntimeKey(beta), 'the same conversation id in different workspaces must never share a runtime');
  assert.notEqual(conversationRuntimeKey(alpha), conversationRuntimeKey(alphaOtherConversation), 'different conversations in one workspace must never share a runtime');
  assert.equal(sameConversationTarget(alpha, alphaAlias), true);
  assert.equal(sameConversationTarget(alpha, beta), false);

  const unsafe = normalizeConversationTarget(target('alpha', 'C:\\Work\\Alpha', 'bad / id'));
  assert.equal(unsafe.conversationId, 'bad___id', 'conversation ids use the persistence-safe normalization already used by Agent');
  assert.ok(!conversationRuntimeKey(unsafe).includes('C:\\Work\\Alpha'), 'runtime keys must not expose raw absolute paths');
}

async function verifyStableWorkspaceIds(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-stable-workspace-id-'));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-same-basename-'));
  try {
    const firstPath = path.join(externalRoot, 'first', 'same-name');
    const secondPath = path.join(externalRoot, 'second', 'same-name');
    fs.mkdirSync(firstPath, { recursive: true });
    fs.mkdirSync(secondPath, { recursive: true });
    const agent = new Agent(root, { agentOnly: true });
    const first = agent.addExternalWorkspace(firstPath);
    const second = agent.addExternalWorkspace(secondPath);
    assert.ok(first?.id && second?.id);
    assert.equal(first?.name, second?.name, 'fixture intentionally uses the same display basename');
    assert.notEqual(first?.id, second?.id, 'stable workspace ids must be path-derived and collision-free for equal basenames');
    assert.equal(agent.selectWorkspace(first!.id!)?.path, path.resolve(firstPath));
    assert.equal(agent.selectWorkspace(second!.id!)?.path, path.resolve(secondPath));
    assert.equal(agent.selectWorkspace('same-name'), null, 'ambiguous legacy display names must fail closed');
    assert.equal(agent.removeWorkspace(first!.id!), true, 'workspace mutation accepts the stable id');
    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'Work', 'External.json'), 'utf8')) as Array<{ id?: string }>;
    assert.ok(persisted.every(item => /^workspace-[a-f0-9]{24}$/.test(String(item.id || ''))));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
}

async function verifyCrossHostWorkspaceRegistryIsolation(): Promise<void> {
  assert.equal(normalizeHostWorkspacePath('/mnt/c/Users/test/.Newmark/Work/Legacy', 'win32'), 'C:\\Users\\test\\.Newmark\\Work\\Legacy');
  const damaged = '/mnt/c/Newmark/C:\\mnt\\c\\Newmark\\release\\C:\\Users\\test\\Projects\\Actual';
  assert.equal(normalizeHostWorkspacePath(damaged, 'win32'), 'C:\\Users\\test\\Projects\\Actual', 'Windows recovers the final absolute path from repeated WSL/Windows concatenation');
  assert.equal(normalizeHostWorkspacePath('C:\\Users\\test\\Projects\\Actual', 'linux'), '/mnt/c/Users/test/Projects/Actual', 'Linux maps a Windows drive path without treating it as a relative filename');

  const detachedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-detached-workspace-'));
  try {
    const work = path.join(detachedRoot, 'Work');
    fs.mkdirSync(work, { recursive: true });
    const localPath = path.join(work, 'Local.json');
    const externalPath = path.join(work, 'External.json');
    const statePath = path.join(work, 'State.json');
    fs.writeFileSync(localPath, '[{"name":"Legacy","path":"C:\\\\Old\\\\Legacy","isInternal":true}]', 'utf8');
    fs.writeFileSync(externalPath, '[{"name":"External","path":"C:\\\\Old\\\\External","isInternal":false}]', 'utf8');
    fs.writeFileSync(statePath, '{"current":{"name":"Legacy","path":"C:\\\\Old\\\\Legacy","isInternal":true}}', 'utf8');
    const before = [localPath, externalPath, statePath].map(file => fs.readFileSync(file, 'utf8'));
    const worker = new Agent(detachedRoot, { agentOnly: true, workspaceRegistryMode: 'detached' });
    assert.equal(worker.workspace.current, null);
    assert.deepEqual(worker.workspace.internal, []);
    assert.deepEqual(worker.workspace.external, []);
    assert.deepEqual([localPath, externalPath, statePath].map(file => fs.readFileSync(file, 'utf8')), before,
      'a detached WSL/utility worker never normalizes or rewrites the main-process workspace registry');
  } finally {
    fs.rmSync(detachedRoot, { recursive: true, force: true });
  }
}

async function verifyWorkspaceSelectionCoordination(): Promise<void> {
  const calls: string[] = [];
  const releases = new Map<string, () => void>();
  const coordinator = new WorkspaceSelectionCoordinator<string, string>({
    keyOf: value => value,
    apply: async value => {
      calls.push(value);
      await new Promise<void>(resolve => releases.set(value, resolve));
      return `selected:${value}`;
    },
    failureThreshold: 2,
    failureWindowMs: 10_000,
    circuitOpenMs: 30_000,
  });

  coordinator.setCurrent('alpha');
  const same = await coordinator.select('alpha');
  assert.equal(same.status, 'noop');
  assert.deepEqual(calls, []);

  const betaA = coordinator.select('beta');
  const betaB = coordinator.select('beta');
  await Promise.resolve();
  assert.deepEqual(calls, ['beta'], 'same in-flight target must share one backend selection');
  releases.get('beta')?.();
  const [betaResultA, betaResultB] = await Promise.all([betaA, betaB]);
  assert.equal(betaResultA.status, 'applied');
  assert.equal(betaResultB.status, 'applied');

  const gamma = coordinator.select('gamma');
  await Promise.resolve();
  const staleDelta = coordinator.select('delta');
  const epsilon = coordinator.select('epsilon');
  const deltaResult = await staleDelta;
  assert.equal(deltaResult.status, 'stale', 'an intermediate queued click must be dropped when a newer target arrives');
  releases.get('gamma')?.();
  await gamma;
  await Promise.resolve();
  assert.deepEqual(calls, ['beta', 'gamma', 'epsilon'], 'latest queued workspace must run after the active selection settles');
  releases.get('epsilon')?.();
  assert.equal((await epsilon).status, 'applied');

  const zetaA = coordinator.select('zeta');
  await Promise.resolve();
  const staleEta = coordinator.select('eta');
  const zetaB = coordinator.select('zeta');
  assert.equal((await staleEta).status, 'stale', 'A -> B -> A must cancel the queued B selection');
  releases.get('zeta')?.();
  const [zetaResultA, zetaResultB] = await Promise.all([zetaA, zetaB]);
  assert.equal(zetaResultA.status, 'applied');
  assert.equal(zetaResultB.status, 'applied');
  await Promise.resolve();
  assert.deepEqual(calls, ['beta', 'gamma', 'epsilon', 'zeta'], 'the stale middle target must never reach the backend');
}

async function verifyWorkspaceSelectionCircuitBreaker(): Promise<void> {
  let now = 1_000;
  let calls = 0;
  const coordinator = new WorkspaceSelectionCoordinator<string, string>({
    keyOf: value => value,
    apply: async () => {
      calls++;
      throw new Error('backend timed out');
    },
    now: () => now,
    failureThreshold: 2,
    failureWindowMs: 10_000,
    circuitOpenMs: 30_000,
  });

  assert.equal((await coordinator.select('broken')).status, 'failed');
  now += 10;
  assert.equal((await coordinator.select('broken')).status, 'failed');
  now += 10;
  const open = await coordinator.select('broken');
  assert.equal(open.status, 'circuit_open');
  assert.equal(calls, 2, 'open circuit must suppress repeated backend requests and error-report storms');
  now += 30_001;
  assert.equal((await coordinator.select('broken')).status, 'failed', 'selection may probe again after the cooldown');
  assert.equal(calls, 3);
}

async function verifyColdSnapshotBindsTargetWorkspace(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-cold-snapshot-target-'));
  try {
    const alphaPath = path.join(root, 'alpha');
    const betaPath = path.join(root, 'beta');
    fs.mkdirSync(alphaPath, { recursive: true });
    fs.mkdirSync(betaPath, { recursive: true });
    const seed = (workspacePath: string, marker: string): Agent => {
      const seeded = new Agent(root, { agentOnly: true });
      seeded.workspace.current = {
        name: path.basename(workspacePath), path: workspacePath, isInternal: false,
        hostBinding: '', icon: '', kind: 'local',
      };
      seeded.setConversation('default');
      seeded.chatMessages.push({ role: 'user', content: marker, mode: 'Build', model: 'test-model', timestamp: '00:00:00' });
      seeded.saveWorkspaceConversationState();
      return seeded;
    };
    const host = seed(alphaPath, 'ALPHA_COLD_SNAPSHOT_MARKER');
    host.beginConversationWorkRun('alpha-cold-fold-run', {
      workspaceId: 'alpha', conversationId: 'default',
    }, '2026-07-14T00:00:00.000Z');
    host.finishConversationWorkRun('alpha-cold-fold-run', 'completed', '2026-07-14T00:00:01.000Z');
    const betaSeed = seed(betaPath, 'BETA_COLD_SNAPSHOT_MARKER');
    betaSeed.beginConversationWorkRun('beta-cold-fold-run', {
      workspaceId: 'beta', conversationId: 'default',
    }, '2026-07-14T00:00:00.000Z');
    betaSeed.finishConversationWorkRun('beta-cold-fold-run', 'completed', '2026-07-14T00:00:02.000Z');
    const kernel = new ConversationKernel(root, host, null);
    const betaTarget = target('beta', betaPath);
    const betaSnapshot = kernel.snapshot(betaTarget);
    const serialized = JSON.stringify(betaSnapshot);
    assert.match(serialized, /BETA_COLD_SNAPSHOT_MARKER/,
      'a cold target snapshot loads the requested workspace conversation');
    assert.doesNotMatch(serialized, /ALPHA_COLD_SNAPSHOT_MARKER/,
      'a cold target snapshot never inherits the globally selected workspace state');
    assert.equal(kernel.runtimeStates().length, 0, 'cold snapshots do not retain an idle execution runtime');

    assert.equal(kernel.setWorkRunExpanded(betaTarget, 'beta-cold-fold-run', true), true,
      'a completed work run can be expanded without an active execution runtime');
    assert.equal(kernel.runtimeStates().length, 0, 'cold fold updates do not retain an idle execution runtime');
    const reloaded = new ConversationKernel(root, host, null);
    assert.equal(reloaded.snapshot(betaTarget).workRuns.find(run => run.runId === 'beta-cold-fold-run')?.expanded, true,
      'the cold expanded preference survives a kernel/app restart');
    assert.equal(reloaded.snapshot(target('alpha', alphaPath)).workRuns.find(run => run.runId === 'alpha-cold-fold-run')?.expanded, false,
      'updating a cold target never changes another workspace work run');
    assert.equal(reloaded.setWorkRunExpanded(betaTarget, 'beta-cold-fold-run', false), true,
      'the reloaded completed work run can be folded again');
    const foldedReload = new ConversationKernel(root, host, null);
    assert.equal(foldedReload.snapshot(betaTarget).workRuns.find(run => run.runId === 'beta-cold-fold-run')?.expanded, false,
      'the repeated fold preference persists across another restart');
    assert.equal(foldedReload.runtimeStates().length, 0, 'persisted fold reads remain cold and runtime-free');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

class RuntimeProbeAgent extends Agent {
  checkpointCount = 0;
  abortCount = 0;
  readonly processInputs: string[] = [];
  private settle: ((tokens: StreamToken[]) => void) | null = null;
  private queuedKernelMessages: Array<{ content: string; queueMode: 'steer' | 'followUp'; clientMessageId?: string; runId?: string; images?: Array<{ dataUrl: string; name?: string; type?: string }> }> = [];

  override saveWorkspaceConversationState(): void {
    this.checkpointCount++;
    super.saveWorkspaceConversationState();
  }

  override abortActiveKernelRun(): boolean {
    this.abortCount++;
    return true;
  }

  override queueActiveKernelMessage(content: string, queueMode: 'steer' | 'followUp', clientMessageId?: string, runId?: string, images?: Array<{ dataUrl: string; name?: string; type?: string }>): boolean {
    this.queuedKernelMessages.push({ content, queueMode, clientMessageId, runId, images });
    return true;
  }

  override drainAllUnconsumedAgentKernelMessages(): Array<{ content: string; queueMode: 'steer' | 'followUp'; clientMessageId?: string; runId?: string; images?: Array<{ dataUrl: string; name?: string; type?: string }> }> {
    return this.queuedKernelMessages.splice(0);
  }

  override async process(input: string): Promise<StreamToken[]> {
    this.processInputs.push(input);
    return await new Promise<StreamToken[]>(resolve => { this.settle = resolve; });
  }

  finish(text = 'done'): void {
    this.settle?.([{ type: 'text', text }]);
    this.settle = null;
  }
}

function assertWorkRunsBoundToTarget(
  workRuns: Agent['workRuns'],
  expected: ReturnType<typeof normalizeConversationTarget>,
  label: string,
): void {
  assert.ok(workRuns.length > 0, `${label}: fixture must expose at least one work run`);
  for (const run of workRuns) {
    assert.deepEqual(run.target, {
      workspaceId: expected.workspaceId,
      conversationId: expected.conversationId,
    }, `${label}: work-run target is rebound to the requested composite target`);
    assert.equal(run.runtimeKey, expected.runtimeKey, `${label}: work-run runtimeKey is supervisor-owned`);
    for (const event of run.events) {
      assert.equal(event.workspaceId, expected.workspaceId, `${label}: event workspaceId is rebound`);
      assert.equal(event.workspaceKey, expected.workspaceKey, `${label}: event workspaceKey is rebound`);
      assert.equal(event.conversationId, expected.conversationId, `${label}: event conversationId is rebound`);
      assert.equal(event.runtimeKey, expected.runtimeKey, `${label}: event runtimeKey is rebound`);
      if (event.guide) {
        assert.deepEqual(event.guide.target, {
          workspaceId: expected.workspaceId,
          conversationId: expected.conversationId,
        }, `${label}: nested event Guide target is rebound`);
      }
    }
    for (const guide of run.guides) {
      assert.deepEqual(guide.target, {
        workspaceId: expected.workspaceId,
        conversationId: expected.conversationId,
      }, `${label}: persisted Guide target is rebound`);
    }
  }
}

async function verifyKernelPublicWorkRunTargetBinding(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-workrun-target-binding-'));
  try {
    const host = new Agent(root, { agentOnly: true });
    const probes = new Map<string, RuntimeProbeAgent>();
    const kernel = new ConversationKernel(root, host, null, {
      createRunner: normalizedTarget => {
        const probe = new RuntimeProbeAgent(root, { agentOnly: true });
        probes.set(normalizedTarget.runtimeKey, probe);
        return probe;
      },
    });
    const options: ConversationKernelRunOptions = {
      mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'guide', engine: 'builtin',
    };
    const alphaInput = target('alpha-binding', path.join(root, 'alpha'), 'same');
    const betaInput = target('beta-binding', path.join(root, 'beta'), 'same');
    fs.mkdirSync(alphaInput.workspace!.path, { recursive: true });
    fs.mkdirSync(betaInput.workspace!.path, { recursive: true });
    const alpha = normalizeConversationTarget(alphaInput);
    const beta = normalizeConversationTarget(betaInput);

    const alphaPromise = kernel.prompt('alpha binding prompt', alphaInput, options, 'steer');
    const betaPromise = kernel.prompt('beta binding prompt', betaInput, options, 'steer');
    await Promise.resolve();
    const alphaRunner = probes.get(alpha.runtimeKey)!;
    const betaRunner = probes.get(beta.runtimeKey)!;
    const poisonedRun = alphaRunner.workRuns[0];
    assert.ok(poisonedRun, 'alpha runner creates a work run before processing');
    poisonedRun.target = { workspaceId: beta.workspaceId, conversationId: 'poisoned-conversation' };
    poisonedRun.runtimeKey = `${beta.runtimeKey}::poisoned`;
    const poisonedGuide: GuideReceipt = {
      clientMessageId: 'poisoned-guide',
      target: { workspaceId: beta.workspaceId, conversationId: beta.conversationId },
      runId: poisonedRun.runId,
      status: 'accepted',
      content: 'poisoned routing fixture',
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:00.000Z',
    };
    poisonedRun.guides.push(poisonedGuide);
    poisonedRun.events.push({
      id: 'poisoned-work-event',
      workspaceId: beta.workspaceId,
      workspaceKey: beta.workspaceKey,
      conversationId: beta.conversationId,
      runtimeKey: `${beta.runtimeKey}::poisoned`,
      type: 'guide',
      content: 'poisoned routing fixture',
      mode: 'Build',
      model: 'test-model',
      timestamp: '2026-07-15T00:00:00.000Z',
      guide: { ...poisonedGuide },
    });

    const alphaSnapshot = kernel.snapshot(alphaInput);
    assertWorkRunsBoundToTarget(alphaSnapshot.workRuns, alpha, 'snapshot(A)');
    assertWorkRunsBoundToTarget(kernel.runtimeState(alphaInput)!.workRuns, alpha, 'runtimeState(A)');
    assert.equal(alphaRunner.workRuns[0].runtimeKey, `${beta.runtimeKey}::poisoned`,
      'public rebinding does not destructively rewrite the runner persistence model');

    const betaSnapshot = kernel.snapshot(betaInput);
    assertWorkRunsBoundToTarget(betaSnapshot.workRuns, beta, 'snapshot(B)');
    assert.ok(!betaSnapshot.workRuns.some(run => run.events.some(event => event.id === 'poisoned-work-event')),
      'poisoned A work-run records never leak into B');

    alphaRunner.finish('alpha binding done');
    betaRunner.finish('beta binding done');
    const [alphaResult, betaResult] = await Promise.all([alphaPromise, betaPromise]);
    assertWorkRunsBoundToTarget(alphaResult.workRuns, alpha, 'result(A)');
    assertWorkRunsBoundToTarget(betaResult.workRuns, beta, 'result(B)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function verifyKernelCompositeRuntimeAndStop(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-runtime-isolation-'));
  try {
    fs.mkdirSync(path.join(root, 'Work'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Work', 'Local.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(root, 'Work', 'External.json'), '[]', 'utf-8');
    const host = new Agent(root, { agentOnly: true });
    const probes = new Map<string, RuntimeProbeAgent>();
    const kernel = new ConversationKernel(root, host, null, {
      createRunner: normalizedTarget => {
        const probe = new RuntimeProbeAgent(root, { agentOnly: true });
        probes.set(normalizedTarget.runtimeKey, probe);
        return probe;
      },
    });
    const runOptions: ConversationKernelRunOptions = {
      mode: 'build',
      model: 'test-model',
      intelligence: 'medium',
      inputMode: 'guide',
      engine: 'builtin',
    };
    const alphaTarget = target('alpha', path.join(root, 'alpha'), 'same');
    const betaTarget = target('beta', path.join(root, 'beta'), 'same');
    fs.mkdirSync(alphaTarget.workspace!.path, { recursive: true });
    fs.mkdirSync(betaTarget.workspace!.path, { recursive: true });

    const alphaRun = kernel.prompt('alpha prompt', alphaTarget, runOptions, 'steer');
    const betaRun = kernel.prompt('beta prompt', betaTarget, runOptions, 'steer');
    await Promise.resolve();
    const alphaState = kernel.runtimeState(alphaTarget);
    const betaState = kernel.runtimeState(betaTarget);
    assert.ok(alphaState?.runId && betaState?.runId);
    assert.notEqual(alphaState?.runtimeKey, betaState?.runtimeKey);
    assert.equal(alphaState?.generation, 1);
    assert.equal(betaState?.generation, 1);
    assert.equal(kernel.snapshot(alphaTarget).workRuns[0]?.runtimeKey, alphaState?.runtimeKey,
      'persisted work runs must retain the canonical runtime key supplied by the target supervisor');
    assert.equal(kernel.snapshot(betaTarget).workRuns[0]?.runtimeKey, betaState?.runtimeKey,
      'same-named conversations in another workspace must not recompute a divergent work-run key');
    assert.equal(probes.size, 2, 'same conversation id in two workspaces owns two independent runners');

    const events: Array<Record<string, unknown>> = [];
    kernel.subscribe(event => events.push(event as unknown as Record<string, unknown>));
    probes.get(alphaState!.runtimeKey)!.emitWorkEvent({ type: 'status', content: 'alpha event' });
    const decorated = events.at(-1)!;
    assert.equal(decorated.runtimeKey, alphaState!.runtimeKey);
    assert.equal(decorated.workspaceKey, normalizeConversationTarget(alphaTarget).workspaceKey);
    assert.equal(decorated.runId, alphaState!.runId);
    assert.equal(decorated.generation, 1);

    const guide = kernel.enqueueGuide({
      clientMessageId: 'stop-race-guide',
      target: normalizeConversationTarget(alphaTarget),
      runId: alphaState!.runId,
      deliveryMode: 'steer',
      text: 'preserve this guidance',
      images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=', name: 'guide.png', type: 'image/png' }],
      createdAt: new Date().toISOString(),
    });
    assert.equal(guide.status, 'accepted');
    void kernel.prompt('plain Next that must survive stop', alphaTarget, runOptions, 'followUp');
    probes.get(alphaState!.runtimeKey)!.checkpointCount = 0;
    probes.get(alphaState!.runtimeKey)!.abortCount = 0;
    const firstStop: ConversationStopResult = kernel.requestStop(alphaTarget, alphaState!.runId);
    assert.equal(firstStop.action, 'graceful');
    assert.equal(firstStop.checkpointed, true);
    assert.ok(probes.get(alphaState!.runtimeKey)!.checkpointCount >= 1);
    assert.equal(probes.get(alphaState!.runtimeKey)!.abortCount, 1);
    const deferred = kernel.snapshot(alphaTarget).workRuns.flatMap(run => run.guides).find(item => item.clientMessageId === 'stop-race-guide');
    assert.equal(deferred?.status, 'deferred', 'first stop must persist an unapplied accepted Guide as a deferred continuation');
    assert.match(String(deferred?.reason || ''), /retained/);
    const retainedAfterStop = kernel.snapshot(alphaTarget).continuations;
    assert.ok(retainedAfterStop.some(item => item.queueMode === 'followUp' && /plain Next/.test(item.content)),
      'first stop persists an unconsumed ordinary Next continuation before abort clears the kernel queue');

    const secondStop = kernel.requestStop(alphaTarget, alphaState!.runId);
    assert.equal(secondStop.action, 'force');
    assert.equal(secondStop.runId, alphaState!.runId);
    assert.equal(probes.get(alphaState!.runtimeKey)!.abortCount, 1, 'second stop must signal the supervisor instead of retrying broad cooperative abort');
    const rejected = kernel.snapshot(alphaTarget).workRuns.flatMap(run => run.guides).find(item => item.clientMessageId === 'stop-race-guide');
    assert.equal(rejected?.status, 'rejected', 'hard restart must explicitly reject a deferred Guide it cannot retain across process death');
    const retainedAfterForce = kernel.snapshot(alphaTarget).continuations;
    assert.ok(!retainedAfterForce.some(item => item.clientMessageId === 'stop-race-guide'),
      'force rejection removes the persisted Guide so a restarted worker cannot replay it');
    assert.ok(retainedAfterForce.some(item => item.queueMode === 'followUp' && /plain Next/.test(item.content)),
      'ordinary Next remains durable across a target-local force restart');
    assert.equal(kernel.requestStop(betaTarget, alphaState!.runId).action, 'stale', 'a stop carrying another target/run id must be harmless');

    probes.get(alphaState!.runtimeKey)!.finish('alpha done');
    probes.get(betaState!.runtimeKey)!.finish('beta done');
    await Promise.all([alphaRun, betaRun]);
    assert.equal(kernel.runtimeState(alphaTarget)?.running, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function verifyCooperativeStopSettlesInterrupted(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-cooperative-stop-settle-'));
  try {
    fs.mkdirSync(path.join(root, 'Work'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Work', 'Local.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(root, 'Work', 'External.json'), '[]', 'utf-8');
    const workspacePath = path.join(root, 'workspace');
    fs.mkdirSync(workspacePath, { recursive: true });
    const stopTarget = target('cooperative-stop', workspacePath, 'default');
    const host = new Agent(root, { agentOnly: true });
    let runner!: Agent;
    let enteredResolve!: () => void;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const kernel = new ConversationKernel(root, host, null, {
      createRunner: () => {
        runner = new Agent(root, { agentOnly: true });
        (runner as unknown as {
          processOpencode(prompt: string, signal?: AbortSignal): Promise<StreamToken[]>;
        }).processOpencode = async (_prompt: string, signal?: AbortSignal): Promise<StreamToken[]> => {
          enteredResolve();
          return await new Promise<StreamToken[]>((_resolve, reject) => {
            const onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('Agent run aborted'));
            if (!signal) reject(new Error('Missing cooperative AbortSignal'));
            else if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          });
        };
        return runner;
      },
    });
    const events: AgentWorkEvent[] = [];
    kernel.subscribe(event => events.push(event));
    const options: ConversationKernelRunOptions = {
      mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'guide', engine: 'opencode',
    };

    const running = kernel.prompt('abort me cooperatively', stopTarget, options, 'steer');
    await entered;
    const before = kernel.runtimeState(stopTarget);
    assert.ok(before?.runId && before.running);
    assert.equal(kernel.requestStop(stopTarget, before!.runId).action, 'graceful');
    const settled = await running;

    const after = kernel.runtimeState(stopTarget);
    assert.equal(after?.running, false, 'cooperative cancellation clears the active promise');
    assert.equal(after?.stopRequested, false, 'cooperative cancellation clears the stop latch after settlement');
    assert.equal(after?.workRuns.find(run => run.runId === before!.runId)?.status, 'interrupted',
      'cooperative cancellation persists interrupted instead of error');
    assert.equal(settled.workRuns.find(run => run.runId === before!.runId)?.status, 'interrupted',
      'the resolved prompt snapshot is captured after interrupted finalization');
    assert.ok(events.some(event => event.runId === before!.runId && event.status === 'interrupted'));
    assert.ok(!events.some(event => event.runId === before!.runId && event.type === 'error'),
      'cooperative settlement publishes no terminal error event');
    assert.equal(kernel.requestStop(stopTarget, before!.runId).action, 'not_running',
      'a stop after cooperative settlement cannot escalate a completed run');

    const unrelatedAbort = new Agent(root, { agentOnly: true });
    unrelatedAbort.engine = 'opencode';
    unrelatedAbort.setModel('test-model');
    (unrelatedAbort as unknown as {
      processOpencode(prompt: string, signal?: AbortSignal): Promise<StreamToken[]>;
    }).processOpencode = async (): Promise<StreamToken[]> => {
      const error = new Error('provider-side AbortError without a stop request');
      error.name = 'AbortError';
      throw error;
    };
    const unrelatedEvents: AgentWorkEvent[] = [];
    unrelatedAbort.subscribeWorkEvents(event => unrelatedEvents.push(event));
    await assert.rejects(unrelatedAbort.process('fail without cooperative stop'), /provider-side AbortError/);
    assert.equal(unrelatedAbort.status, 'error', 'an AbortError without an aborted run signal remains a real error');
    assert.ok(unrelatedEvents.some(event => event.type === 'error'),
      'an unrelated provider AbortError retains its diagnostic terminal event');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function verifyInputsArrivingAfterStopAreDurable(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-stop-arrival-durable-'));
  try {
    fs.mkdirSync(path.join(root, 'Work'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Work', 'Local.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(root, 'Work', 'External.json'), '[]', 'utf-8');
    const workspacePath = path.join(root, 'late-workspace');
    fs.mkdirSync(workspacePath, { recursive: true });
    const lateTarget = target('late-workspace', workspacePath, 'same');
    const host = new Agent(root, { agentOnly: true });
    let runner!: RuntimeProbeAgent;
    const kernel = new ConversationKernel(root, host, null, {
      createRunner: () => {
        runner = new RuntimeProbeAgent(root, { agentOnly: true });
        return runner;
      },
    });
    const options: ConversationKernelRunOptions = {
      mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'guide', engine: 'builtin',
    };
    const running = kernel.prompt('original prompt', lateTarget, options, 'steer');
    await Promise.resolve();
    const state = kernel.runtimeState(lateTarget);
    assert.ok(state?.runId);
    assert.equal(kernel.requestStop(lateTarget, state!.runId).action, 'graceful');

    const lateGuideEnvelope: ConversationInputEnvelope = {
      clientMessageId: 'guide-arrived-after-stop',
      target: normalizeConversationTarget(lateTarget),
      runId: state!.runId,
      deliveryMode: 'steer',
      text: 'durable Guide after stop',
      images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=', name: 'late.png', type: 'image/png' }],
      createdAt: '2026-07-13T08:30:00.000Z',
    };
    const lateGuide = kernel.enqueueGuide(lateGuideEnvelope);
    assert.equal(lateGuide.status, 'deferred');
    assert.match(String(lateGuide.reason || ''), /stopping.*retained/i);
    assert.equal(kernel.enqueueGuide(lateGuideEnvelope).status, 'deferred', 'replayed Guide returns its existing receipt');
    void kernel.prompt('durable Next after stop', lateTarget, options, 'followUp');

    const retained = kernel.snapshot(lateTarget).continuations;
    assert.equal(retained.filter(item => item.clientMessageId === lateGuideEnvelope.clientMessageId).length, 1,
      'post-stop Guide is retained exactly once before the active promise settles');
    assert.equal(retained.filter(item => item.queueMode === 'followUp' && /durable Next after stop/.test(item.content)).length, 1,
      'post-stop ordinary Next is durably retained before the active promise settles');
    assert.ok(kernel.queued(lateTarget).steering.includes(lateGuideEnvelope.text));

    const stopAfterInterveningInputs = kernel.requestStop(lateTarget, state!.runId);
    assert.equal(stopAfterInterveningInputs.action, 'graceful',
      'a Guide or Next cancels second-click force eligibility, so the next stop is conservative again');
    assert.equal(runner.abortCount, 2, 'the conservative stop is re-armed after intervening input');
    runner.finish('stopped');
    await running;

    const reloaded = new Agent(root, { agentOnly: true });
    reloaded.workspace.current = {
      id: 'late-workspace',
      name: 'late-workspace',
      path: workspacePath,
      isInternal: false,
      hostBinding: '',
      icon: '',
      kind: 'local',
    };
    reloaded.setConversation('same');
    const afterReload = reloaded.getConversationSnapshot('same');
    assert.equal(afterReload.continuations.filter(item => item.clientMessageId === lateGuideEnvelope.clientMessageId).length, 1,
      'post-stop Guide survives a worker-style Agent reload exactly once');
    assert.equal(afterReload.continuations.filter(item => item.queueMode === 'followUp' && /durable Next after stop/.test(item.content)).length, 1,
      'post-stop Next survives a worker-style Agent reload');
    const persistedReceipt = afterReload.workRuns.flatMap(run => run.guides)
      .find(item => item.clientMessageId === lateGuideEnvelope.clientMessageId);
    assert.equal(persistedReceipt?.status, 'deferred');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function verifyRendererReconcilesCompletionAgainstFirstStop(): Promise<void> {
  const uiHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'index.html'), 'utf8');
  const start = uiHtml.indexOf('async function refreshConversationRuntimeAfterStopRace');
  const end = uiHtml.indexOf('window.submitCurrentAction = function()', start);
  assert.ok(start >= 0 && end > start, 'renderer stop reconciliation block is discoverable');

  const target = { workspaceId: 'workspace-stop-race', conversationId: 'default' };
  const keyFor = (value: typeof target) => `${value.workspaceId}::${value.conversationId}`;
  const state: Record<string, any> = {
    runningConversations: {},
    conversationRuntimeStates: {},
    workRunsByTarget: {},
    backendQueue: { steering: [], followUp: [] },
    backendQueuesByTarget: {},
  };
  let stopResult: Record<string, unknown> = {};
  let snapshot: Record<string, any> = {};
  let getStateCalls = 0;
  let buttonMode = 'send';
  let working = false;
  let syncedRuns: unknown[] = [];
  const api = {
    stopConversation: async () => stopResult,
    getState: async (requested: typeof target) => {
      getStateCalls++;
      assert.deepEqual(requested, target, 'stop race refresh remains bound to the requested target');
      return snapshot;
    },
  };
  const setConversationRuntimeState = (runtimeTarget: typeof target, status: string, runId: string, extra?: Record<string, unknown>) => {
    const key = keyFor(runtimeTarget);
    const next = { ...state.conversationRuntimeStates[key], ...extra, target: runtimeTarget, status, runId };
    state.conversationRuntimeStates[key] = next;
    if (['running', 'stopping', 'force_restarting'].includes(status)) state.runningConversations[key] = next;
    else delete state.runningConversations[key];
    return next;
  };
  const windowObject: Record<string, any> = { renderInputStack: () => undefined };
  const run = new Function(
    'window', 'state', 'api', 'activeConversationId', 'runningConversationRecord', 'currentConversationTarget',
    'runtimeKeyFor', 'registerRuntimeKey', 'setBackendQueueForTarget', 'isActiveConversationTarget', 'syncWorkRunsSnapshot', 'setConversationRuntimeState', 'updateSubmitButtonState',
    'renderConversations', 'setWorking', 'showUiNotice',
    uiHtml.slice(start, end),
  );
  run(
    windowObject,
    state,
    api,
    () => target.conversationId,
    () => state.runningConversations[keyFor(target)] || null,
    () => target,
    (workspaceId: string, conversationId: string) => `${workspaceId}::${conversationId}`,
    () => keyFor(target),
    (queue: Record<string, unknown>, runtimeTarget: typeof target) => {
      state.backendQueuesByTarget[keyFor(runtimeTarget)] = queue;
      return queue;
    },
    (runtimeTarget: typeof target) => keyFor(runtimeTarget) === keyFor(target),
    (runs: unknown[]) => { syncedRuns = runs; return runs; },
    setConversationRuntimeState,
    () => { buttonMode = Object.keys(state.runningConversations).length ? 'stop' : 'send'; },
    () => undefined,
    (value: boolean) => { working = value; },
    () => undefined,
  );

  setConversationRuntimeState(target, 'running', 'run-completed-race');
  stopResult = { action: 'not_running', runtimeKey: keyFor(target), checkpointed: false };
  snapshot = {
    target,
    runtime: null,
    status: 'idle',
    workRuns: [{ runId: 'run-completed-race', status: 'completed', events: [], guides: [] }],
    queued: { steering: [], followUp: [] },
  };
  assert.equal(await windowObject.stopCurrentConversation(), true);
  assert.equal(getStateCalls, 1, 'not_running stop result triggers an immediate target snapshot refresh');
  assert.equal(state.conversationRuntimeStates[keyFor(target)].status, 'completed');
  assert.equal(state.runningConversations[keyFor(target)], undefined, 'natural completion clears the optimistic stopping record');
  assert.equal(buttonMode, 'send', 'natural completion restores the Send button instead of Force stop');
  assert.equal(working, false);
  assert.equal(syncedRuns.length, 1);

  setConversationRuntimeState(target, 'running', 'run-old');
  stopResult = { action: 'stale', runtimeKey: keyFor(target), runId: 'run-new', generation: 2, checkpointed: false };
  snapshot = {
    target,
    runtime: {
      target,
      workspaceKey: 'workspace-stop-race',
      runtimeKey: keyFor(target),
      runId: 'run-new',
      generation: 2,
      running: true,
      stopRequested: false,
      workRuns: [],
    },
    status: 'idle',
    workRuns: [],
  };
  assert.equal(await windowObject.stopCurrentConversation(), true);
  assert.equal(getStateCalls, 2, 'stale stop result also refreshes the target snapshot');
  assert.equal(state.conversationRuntimeStates[keyFor(target)].status, 'running');
  assert.equal(state.conversationRuntimeStates[keyFor(target)].runId, 'run-new');
  assert.equal(state.runningConversations[keyFor(target)].runId, 'run-new', 'a newer real run replaces the stale optimistic stop');
  assert.equal(buttonMode, 'stop');
  assert.equal(working, true);
}

class FakeWslTargetClient implements WslTargetRuntimeClient {
  readonly listeners = new Set<(event: AgentWorkEvent) => void>();
  prompts = 0;
  restarts = 0;
  forceStops = 0;
  stops = 0;
  starts = 0;
  stopResults: WslAgentStopResult[] = [];
  settings = 0;
  folds = 0;
  rewindCalls: Array<{ target: ConversationRuntimeTarget; messageIndex: number }> = [];
  stopCalls = 0;
  hangStops = false;
  connected = true;
  quarantined = false;
  error = '';
  restartFailure = '';
  stopFailure = '';

  constructor(private readonly targetInfo: ConversationRuntimeTarget) {}

  subscribe(listener: (event: AgentWorkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setHostToolHandler(): void {}

  async prompt(params: WslAgentPromptRequest): Promise<WslAgentPromptResult> {
    this.prompts++;
    return {
      tokens: [], diffs: [], mode: params.options.mode, model: params.options.model, status: 'idle', goal: null,
      options: [], contextCompression: null, contextWindow: { estimatedTokens: 0, maxTokens: 1, ratio: 0, warning: 'ok', model: 'm' },
      conversationId: params.target!.conversationId, activeConversationId: params.target!.conversationId,
      conversations: [], conversationPlan: { items: [] }, linkedPlan: { markdown: '', revision: 0 }, subagents: [],
      chatMessages: [], historyMessages: 0, conversationLocked: false, queued: { steering: [], followUp: [] },
      target: normalizeConversationTarget(params.target!), workspaceKey: normalizeConversationTarget(params.target!).workspaceKey,
      runtimeKey: conversationRuntimeKey(params.target!), runId: 'fake-run', generation: 1, workRuns: [], backend: 'wsl', distro: 'Fake',
    };
  }

  async snapshotTarget(): Promise<Record<string, unknown>> {
    return { target: normalizeConversationTarget(this.targetInfo), runtime: null, queued: { steering: [], followUp: [] }, workEvents: [] };
  }
  async rewind(target: ConversationRuntimeTarget, messageIndex: number): Promise<any> {
    this.rewindCalls.push({ target, messageIndex });
    return {
      conversationId: target.conversationId,
      conversations: [],
      conversationPlan: { items: [] },
      linkedPlan: { markdown: '', revision: 0 },
      subagents: [],
      chatMessages: [],
      historyMessages: 0,
      workRuns: [],
      continuations: [],
    };
  }
  async enqueueGuide(_target: ConversationRuntimeTarget, envelope: ConversationInputEnvelope): Promise<GuideReceipt> {
    return {
      clientMessageId: envelope.clientMessageId,
      target: envelope.target,
      runId: envelope.runId || 'fake-run',
      status: 'accepted',
      content: envelope.text,
      createdAt: envelope.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  async checkpoint(): Promise<Record<string, unknown>> { return { checkpointed: true }; }
  async setWorkRunExpanded(): Promise<boolean> { this.folds++; return true; }
  async updateSetting(): Promise<void> { this.settings++; }
  async requestStop(): Promise<WslAgentStopResult> {
    this.stopCalls++;
    if (this.hangStops) return await new Promise<WslAgentStopResult>(() => {});
    return this.stopResults.shift() || { action: 'not_running', runtimeKey: '', checkpointed: false, backend: 'wsl', distro: 'Fake' };
  }
  async forceRestartRuntimeGroup(): Promise<void> { this.restarts++; }
  async start(): Promise<void> { this.starts++; }
  async stop(): Promise<void> { this.stops++; }
  status(): { enabled: true; connected: boolean; distro: string; pid: number; error: string } {
    return { enabled: true, connected: true, distro: 'Fake', pid: 1, error: '' };
  }
}

async function verifyWslPerTargetPool(): Promise<void> {
  const clients = new Map<string, FakeWslTargetClient>();
  const pool = new WslAgentRuntimePool('Fake', 'C:\\root', 'host.js', normalized => {
    const client = new FakeWslTargetClient(normalized);
    clients.set(normalized.runtimeKey, client);
    return client;
  });
  const options: ConversationKernelRunOptions = { mode: 'build', model: 'm', intelligence: 'medium', inputMode: 'guide', engine: 'builtin' };
  const alpha = target('alpha', 'C:\\work\\alpha', 'same');
  const beta = target('beta', 'C:\\work\\beta', 'same');
  await pool.prewarm(alpha);
  assert.equal(clients.get(conversationRuntimeKey(alpha))?.starts, 1, 'WSL runtime pool prewarms the target client without prompting');
  await pool.prompt({ message: 'a', target: alpha, conversationId: 'same', options, queueMode: 'steer', workspace: null });
  await pool.prompt({ message: 'a2', target: alpha, conversationId: 'same', options, queueMode: 'steer', workspace: null });
  await pool.prompt({ message: 'b', target: beta, conversationId: 'same', options, queueMode: 'steer', workspace: null });
  assert.equal(clients.size, 2, 'WSL runtime pool must create one independent host process per composite target');
  const alphaClient = clients.get(conversationRuntimeKey(alpha))!;
  const betaClient = clients.get(conversationRuntimeKey(beta))!;
  assert.equal(alphaClient.prompts, 2);
  assert.equal(betaClient.prompts, 1);
  const wslRewound = await pool.rewind(alpha, 2);
  assert.equal(wslRewound.conversationId, 'same');
  assert.equal(alphaClient.rewindCalls.length, 1, 'WSL rewind must execute inside the target runtime client');
  assert.equal(alphaClient.rewindCalls[0].messageIndex, 2);
  assert.equal(normalizeConversationTarget(alphaClient.rewindCalls[0].target).runtimeKey, conversationRuntimeKey(alpha));
  assert.equal(betaClient.rewindCalls.length, 0, 'WSL rewind must not cross the composite target boundary');

  alphaClient.stopResults.push(
    { action: 'graceful', runtimeKey: conversationRuntimeKey(alpha), runId: 'run-a', generation: 1, checkpointed: true, backend: 'wsl', distro: 'Fake' },
    { action: 'graceful', runtimeKey: conversationRuntimeKey(alpha), runId: 'run-a', generation: 1, checkpointed: true, backend: 'wsl', distro: 'Fake' },
  );
  assert.equal((await pool.requestStop(alpha, 'run-a')).action, 'graceful');
  assert.equal(alphaClient.restarts, 0);
  for (const listener of alphaClient.listeners) listener({
    id: 'wsl-bare-abort-error', conversationId: 'same', type: 'error', content: 'This operation was aborted',
    mode: 'Build', model: 'm', timestamp: new Date().toISOString(), runId: 'run-a',
  });
  assert.equal(pool.isStopping(alpha), true,
    'a bare worker error cannot disarm WSL force-stop before an explicit terminal settlement status');
  await pool.enqueueGuide({
    clientMessageId: 'wsl-guide-disarms-force', target: normalizeConversationTarget(alpha), runId: 'run-a',
    deliveryMode: 'steer', text: 'intervening Guide', createdAt: new Date().toISOString(),
  });
  assert.equal(pool.isStopping(alpha), false, 'a new WSL Guide cancels the supervisor force escalation sequence');
  assert.equal((await pool.requestStop(alpha, 'run-a')).action, 'graceful', 'the next WSL stop after Guide is conservative again');
  assert.equal(alphaClient.stopCalls, 2);
  const forced = await pool.requestStop(alpha, 'run-a');
  assert.equal(forced.action, 'force');
  assert.equal(forced.restarted, true);
  assert.equal(alphaClient.restarts, 1);
  assert.equal(betaClient.restarts, 0, 'forcing alpha must never restart beta');
  alphaClient.stopResults.push(
    { action: 'graceful', runtimeKey: conversationRuntimeKey(alpha), runId: 'run-a', generation: 1, checkpointed: true, backend: 'wsl', distro: 'Fake' },
  );
  assert.equal((await pool.requestStop(alpha, 'run-a')).action, 'graceful');
  for (const listener of alphaClient.listeners) listener({
    id: 'wsl-explicit-interrupted', conversationId: 'same', type: 'status', content: 'Interrupted.',
    mode: 'Build', model: 'm', timestamp: new Date().toISOString(), runId: 'run-a', status: 'interrupted',
  });
  assert.equal(pool.isStopping(alpha), false, 'an explicit WSL interrupted status settles supervisor stop intent');
  await pool.updateSetting('agent', 'process_timeout_ms', 1234);
  assert.equal(alphaClient.settings, 1);
  assert.equal(betaClient.settings, 1, 'setting updates broadcast to every live WSL worker');
  await pool.stopAll();
  assert.equal(alphaClient.stops, 1);
  assert.equal(betaClient.stops, 1);

  const hungClients = new Map<string, FakeWslTargetClient>();
  const hungPool = new WslAgentRuntimePool('Fake', 'C:\\root', 'host.js', normalized => {
    const client = new FakeWslTargetClient(normalized);
    hungClients.set(normalized.runtimeKey, client);
    return client;
  }, { stopRequestTimeoutMs: 15 });
  await hungPool.prompt({ message: 'hung', target: alpha, conversationId: 'same', options, queueMode: 'steer', workspace: null });
  const hungClient = hungClients.get(conversationRuntimeKey(alpha))!;
  hungClient.hangStops = true;
  const timedOutFirst = await hungPool.requestStop(alpha, 'run-hung-wsl');
  assert.equal(timedOutFirst.action, 'graceful', 'hung WSL stop acknowledgement remains an explicit supervisor stopping state');
  assert.equal(hungPool.isStopping(alpha), true);
  const stoppingSnapshot = await hungPool.snapshot(alpha);
  assert.equal((stoppingSnapshot.runtime as { stopRequested?: boolean } | undefined)?.stopRequested, true,
    'WSL supervisor snapshot remains responsive while the child event loop is blocked');
  const forcedHung = await Promise.race([
    hungPool.requestStop(alpha, 'run-hung-wsl'),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hung WSL force stop waited on child IPC')), 250)),
  ]);
  assert.equal(forcedHung.action, 'force');
  assert.equal(forcedHung.restarted, true);
  assert.equal(hungClient.stopCalls, 1, 'second WSL stop force-restarts directly without another child stop RPC');
  assert.equal(hungClient.restarts, 1);
  assert.equal(hungPool.isStopping(alpha), false);
  await hungPool.stopAll();
}

function commandResult(overrides: Partial<WslCommandResult> = {}): WslCommandResult {
  return {
    status: 0,
    stdout: 'terminated\n',
    stderr: '',
    aborted: false,
    timedOut: false,
    overflowed: false,
    ...overrides,
  };
}

function seedWslClientRuntime(
  client: WslAgentClient,
  generation: number,
  identity: WslRuntimeIdentity,
): { killed: boolean; kill(): boolean } {
  const child = {
    killed: false,
    kill(): boolean {
      this.killed = true;
      return true;
    },
  };
  Object.assign(client as unknown as Record<string, unknown>, {
    child,
    childGeneration: generation,
    remotePid: identity.pid,
    remotePgid: identity.pgid,
    remoteSessionId: identity.sessionId,
  });
  return child;
}

async function verifyWslAsyncProcessGroupTermination(): Promise<void> {
  const normalized = normalizeConversationTarget(target('wsl-async', 'C:\\work\\wsl-async'));
  let helperTicked = false;
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const asyncRunner: WslCommandRunner = async (args, options) => {
    calls.push({ args: [...args], timeoutMs: options.timeoutMs });
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    assert.equal(helperTicked, true, 'an in-flight WSL kill helper must not freeze the Electron event loop');
    return commandResult();
  };
  const client = new WslAgentClient('Fake', 'C:\\root', 'host.js', normalized, asyncRunner);
  const child = seedWslClientRuntime(client, 7, { pid: 701, pgid: 701, sessionId: 701 });
  const stopPromise = client.forceStopRuntimeGroup();
  setTimeout(() => { helperTicked = true; }, 0);
  await stopPromise;
  assert.equal(child.killed, true, 'the Windows WSL launcher is detached only after Linux confirms the old group is gone');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].timeoutMs >= 5_000, 'the async WSL kill helper budget includes Windows helper startup and Linux PGID verification');
  assert.ok(calls[0].args.includes('Fake'));
  assert.match(calls[0].args.at(-1) || '', /kill -KILL -- "-701"/,
    'the helper targets only the recorded Linux PGID and never terminates the distribution');
  assert.match(calls[0].args.at(-1) || '', /kill -0 -- "-701"/,
    'the helper verifies the old process group no longer exists');
  assert.ok(!calls[0].args.includes('--terminate'));

  for (const failure of [
    commandResult({ status: 73, stderr: 'group still alive' }),
    commandResult({ status: null, timedOut: true, error: 'Timed out after 5500 ms' }),
  ]) {
    let starts = 0;
    const runner: WslCommandRunner = async () => failure;
    const failingClient = new WslAgentClient('Fake', 'C:\\root', 'host.js', normalized, runner);
    const failingChild = seedWslClientRuntime(failingClient, 8, { pid: 801, pgid: 801, sessionId: 801 });
    (failingClient as unknown as { start(): Promise<void> }).start = async () => { starts++; };
    await assert.rejects(failingClient.forceRestartRuntimeGroup(), /process group termination failed/i);
    assert.equal(starts, 0, 'a failed or timed-out kill verification must not start a replacement runtime');
    assert.equal(failingChild.killed, false, 'failure retains the old launcher identity for explicit recovery/error reporting');
  }

  let disposeCalls = 0;
  const disposeRunner: WslCommandRunner = async () => { disposeCalls++; return commandResult(); };
  for (const method of ['stop', 'shutdownNow'] as const) {
    const disposingClient = new WslAgentClient('Fake', 'C:\\root', 'host.js', normalized, disposeRunner);
    const disposingChild = seedWslClientRuntime(disposingClient, 11 + disposeCalls, { pid: 1101 + disposeCalls, pgid: 1101 + disposeCalls, sessionId: 1101 + disposeCalls });
    (disposingClient as unknown as { request(): Promise<boolean> }).request = async () => true;
    await disposingClient[method]();
    assert.equal(disposingChild.killed, true, `${method} detaches the Windows launcher only after PGID verification`);
  }
  assert.equal(disposeCalls, 2, 'normal and fallback disposal both verify the Linux process group is absent');

  let resolveStale!: (result: WslCommandResult) => void;
  const staleRunner: WslCommandRunner = async () => await new Promise<WslCommandResult>(resolve => { resolveStale = resolve; });
  const staleClient = new WslAgentClient('Fake', 'C:\\root', 'host.js', normalized, staleRunner);
  seedWslClientRuntime(staleClient, 9, { pid: 901, pgid: 901, sessionId: 901 });
  let staleStarts = 0;
  (staleClient as unknown as { start(): Promise<void> }).start = async () => { staleStarts++; };
  const staleStop = staleClient.forceRestartRuntimeGroup();
  const replacement = seedWslClientRuntime(staleClient, 10, { pid: 1001, pgid: 1001, sessionId: 1001 });
  resolveStale(commandResult());
  await staleStop;
  assert.equal(replacement.killed, false, 'a late kill result from an old generation cannot detach a replacement runtime');
  assert.equal(staleStarts, 0, 'a stale generation result cannot start another replacement');

  const productionSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'wslAgentClient.js'), 'utf8');
  assert.ok(!productionSource.includes('spawnSync'), 'WSL runtime control production code must not contain synchronous process helpers');
  assert.match(productionSource, /request\('ping', undefined, 30_000\)/,
    'cold WSL startup receives a dedicated 30-second ping budget without widening ordinary request timeouts');
}

async function verifyWslHostToolIdentityBinding(): Promise<void> {
  const trustedTarget = normalizeConversationTarget(target('windows-workspace-id', 'C:\\work\\identity-binding', 'trusted-conversation'));
  const client = new WslAgentClient('Fake', 'C:\\root', 'host.js', trustedTarget);
  const writes: string[] = [];
  const child = {
    killed: false,
    stdin: {
      write(value: string): boolean {
        writes.push(String(value));
        return true;
      },
    },
  };
  Object.assign(client as unknown as Record<string, unknown>, { child, childGeneration: 17 });

  let forwarded: WslHostToolRequest | null = null;
  client.setHostToolHandler(async request => {
    forwarded = request;
    return { accepted: true };
  });
  const workerDerivedRequest: WslHostToolRequest = {
    requestId: 'host-tool-rebind',
    tool: 'computer_use',
    args: { action: 'observe' },
    context: {
      workspaceId: 'workspace-derived-from-mnt-path',
      conversationId: 'forged-conversation',
      actorId: 'root',
      runtimeKey: trustedTarget.runtimeKey,
      allowEphemeralVisionImage: true,
    },
  };
  await (client as unknown as {
    handleHostToolRequest(child: unknown, generation: number, request: WslHostToolRequest): Promise<void>;
  }).handleHostToolRequest(child, 17, workerDerivedRequest);
  assert.ok(forwarded, 'a request carrying the exact trusted runtime key reaches the Windows host handler');
  const delivered = forwarded as unknown as WslHostToolRequest;
  assert.deepEqual({
    workspaceId: delivered.context.workspaceId,
    conversationId: delivered.context.conversationId,
    runtimeKey: delivered.context.runtimeKey,
  }, {
    workspaceId: trustedTarget.workspaceId,
    conversationId: trustedTarget.conversationId,
    runtimeKey: trustedTarget.runtimeKey,
  }, 'path-derived or forged WSL identity fields are rebound to the client runtime target before crossing the trusted host boundary');
  assert.equal(delivered.context.allowEphemeralVisionImage, true, 'trusted per-run vision capability survives identity rebinding');
  const accepted = JSON.parse(writes.at(-1) || '{}').params;
  assert.equal(accepted.ok, true);

  forwarded = null;
  writes.length = 0;
  await (client as unknown as {
    handleHostToolRequest(child: unknown, generation: number, request: WslHostToolRequest): Promise<void>;
  }).handleHostToolRequest(child, 17, {
    ...workerDerivedRequest,
    requestId: 'host-tool-wrong-runtime',
    context: { ...workerDerivedRequest.context, runtimeKey: `${trustedTarget.runtimeKey}-forged` },
  });
  assert.equal(forwarded, null, 'a forged runtime key never reaches the Windows host handler');
  const rejected = JSON.parse(writes.at(-1) || '{}').params;
  assert.equal(rejected.ok, false);
  assert.match(String(rejected.error || ''), /target mismatch/i);
}

async function verifyRealUbuntuProcessGroupTermination(): Promise<void> {
  if (process.platform !== 'win32') return;
  const distro = 'Ubuntu-24.04';
  const listed = await runAsyncProcess('wsl.exe', ['-l', '-q'], { timeoutMs: 5_000 });
  const distroList = `${listed.stdout}\n${listed.stderr}`.split('\0').join('');
  if (listed.status !== 0 || !distroList.split(/\r?\n/).some(line => line.trim() === distro)) return;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-real-wsl-runtime-group-'));
  const hostScript = path.resolve(__dirname, '..', 'wsl-agent-host.bundle.cjs');
  const realTarget = normalizeConversationTarget(target('real-wsl-async', root, 'dispose'));
  const client = new WslAgentClient(distro, root, hostScript, realTarget);
  let pgid = 0;
  try {
    await client.start();
    const marker = client.status();
    pgid = marker.pgid;
    assert.ok(Number.isSafeInteger(marker.pid) && marker.pid > 1);
    assert.equal(marker.pid, marker.pgid, 'real WSL host records a process-group leader marker');
    assert.equal(marker.pgid, marker.sessionId, 'real WSL host records an isolated session leader marker');
    await client.stop();
    assert.equal(client.status().connected, false);
    const verified = await runAsyncProcess('wsl.exe', [
      '-d', distro, '--', 'bash', '-lc', `kill -0 -- -${pgid} 2>/dev/null`,
    ], { timeoutMs: 5_000 });
    assert.notEqual(verified.status, 0, 'the real Ubuntu process group marker is absent after normal client disposal');
  } finally {
    if (client.status().connected) {
      try { await client.shutdownNow(); } catch {}
    }
    if (pgid > 1) {
      await runAsyncProcess('wsl.exe', [
        '-d', distro, '--', 'bash', '-lc', `kill -KILL -- -${pgid} 2>/dev/null || true`,
      ], { timeoutMs: 5_000 });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

class FakeElectronTargetClient implements ElectronTargetRuntimeClient {
  readonly listeners = new Set<(event: AgentWorkEvent) => void>();
  prompts = 0;
  guides = 0;
  checkpoints = 0;
  folds = 0;
  rewindIndices: number[] = [];
  restarts = 0;
  forceStops = 0;
  stops = 0;
  stopResults: UtilityAgentStopResult[] = [];
  settings = 0;
  stopCalls = 0;
  hangStops = false;
  connected = true;
  quarantined = false;
  error = '';
  restartFailure = '';
  stopFailure = '';

  constructor(private readonly targetInfo: ConversationRuntimeTarget) {}

  subscribe(listener: (event: AgentWorkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  setHostToolHandler(): void {}
  async prompt(params: UtilityPromptRequest): Promise<UtilityAgentPromptResult> {
    this.prompts++;
    const target = normalizeConversationTarget(params.target);
    return {
      tokens: [], diffs: [], mode: params.options.mode, model: params.options.model, status: 'idle', goal: null,
      options: [], contextCompression: null, contextWindow: { estimatedTokens: 0, maxTokens: 1, ratio: 0, warning: 'ok', model: 'm' },
      conversationId: target.conversationId, activeConversationId: target.conversationId,
      conversations: [], conversationPlan: { items: [] }, linkedPlan: { markdown: '', revision: 0 }, subagents: [],
      chatMessages: [], historyMessages: 0, conversationLocked: false, queued: { steering: [], followUp: [] },
      target, workspaceKey: target.workspaceKey, runtimeKey: target.runtimeKey, runId: 'fake-run', generation: 1,
      workRuns: [], backend: 'utility', pid: 123,
    };
  }
  async snapshot(): Promise<UtilityAgentSnapshotResult> {
    return { target: normalizeConversationTarget(this.targetInfo), runtime: null, queued: { steering: [], followUp: [] }, workEvents: [] };
  }
  async rewind(messageIndex: number): Promise<any> {
    this.rewindIndices.push(messageIndex);
    return {
      conversationId: this.targetInfo.conversationId,
      conversations: [],
      conversationPlan: { items: [] },
      linkedPlan: { markdown: '', revision: 0 },
      subagents: [],
      chatMessages: [],
      historyMessages: 0,
      workRuns: [],
      continuations: [],
    };
  }
  async requestStop(): Promise<UtilityAgentStopResult> {
    this.stopCalls++;
    if (this.hangStops) return await new Promise<UtilityAgentStopResult>(() => {});
    return this.stopResults.shift() || { action: 'not_running', runtimeKey: '', checkpointed: false, backend: 'utility', pid: 123 };
  }
  async enqueueGuide(envelope: ConversationInputEnvelope): Promise<GuideReceipt> {
    this.guides++;
    return {
      clientMessageId: envelope.clientMessageId, target: envelope.target, runId: envelope.runId || 'fake-run', status: 'accepted',
      content: envelope.text, createdAt: envelope.createdAt, updatedAt: envelope.createdAt,
    };
  }
  async checkpoint(): Promise<Record<string, unknown>> { this.checkpoints++; return { checkpointed: true }; }
  async setWorkRunExpanded(): Promise<boolean> { this.folds++; return true; }
  async updateSetting(): Promise<void> { this.settings++; }
  async forceRestart(): Promise<void> {
    this.restarts++;
    if (this.restartFailure) {
      this.quarantined = true;
      this.error = this.restartFailure;
      throw new Error(this.restartFailure);
    }
  }
  async forceStop(): Promise<void> { this.forceStops++; this.connected = false; }
  async stop(): Promise<void> {
    this.stops++;
    if (this.stopFailure) {
      this.quarantined = true;
      this.error = this.stopFailure;
      throw new Error(this.stopFailure);
    }
    this.connected = false;
  }
  status(): { enabled: true; connected: boolean; pid: number; error: string; runtimeKey: string; quarantined: boolean; generation: number; readyGeneration: number } {
    const target = normalizeConversationTarget(this.targetInfo);
    return {
      enabled: true,
      connected: this.connected,
      pid: this.connected ? 123 : 0,
      error: this.error,
      runtimeKey: target.runtimeKey,
      quarantined: this.quarantined,
      generation: 1,
      readyGeneration: this.connected ? 1 : 0,
    };
  }
}

async function verifyElectronPerTargetPool(): Promise<void> {
  const clients = new Map<string, FakeElectronTargetClient>();
  const pool = new ElectronUtilityRuntimePool('C:\\root', 'utility.js', normalized => {
    const client = new FakeElectronTargetClient(normalized);
    clients.set(normalized.runtimeKey, client);
    return client;
  });
  const options: ConversationKernelRunOptions = { mode: 'build', model: 'm', intelligence: 'medium', inputMode: 'guide', engine: 'builtin' };
  const alpha = target('alpha', 'C:\\work\\alpha', 'same');
  const beta = target('beta', 'C:\\work\\beta', 'same');
  await pool.prompt({ message: 'a', target: alpha, options, queueMode: 'steer' });
  await pool.prompt({ message: 'a2', target: alpha, options, queueMode: 'steer' });
  await pool.prompt({ message: 'b', target: beta, options, queueMode: 'steer' });
  assert.equal(clients.size, 2, 'Native runtime pool must create one real client boundary per composite target');
  const alphaClient = clients.get(conversationRuntimeKey(alpha))!;
  const betaClient = clients.get(conversationRuntimeKey(beta))!;
  assert.equal(alphaClient.prompts, 2);
  assert.equal(betaClient.prompts, 1);
  const utilityRewound = await pool.rewind(alpha, 2);
  assert.equal(utilityRewound.conversationId, 'same');
  assert.deepEqual(alphaClient.rewindIndices, [2], 'Utility rewind must execute inside the target runtime client');
  assert.deepEqual(betaClient.rewindIndices, [], 'Utility rewind must not cross the composite target boundary');

  const now = new Date().toISOString();
  await pool.enqueueGuide({
    clientMessageId: 'guide-alpha', target: { workspaceId: 'alpha', conversationId: 'same' }, runId: 'run-a',
    deliveryMode: 'steer', text: 'keep going', createdAt: now,
  });
  assert.equal(alphaClient.guides, 1, 'public Guide target must resolve to its path-keyed runtime entry');
  await pool.checkpoint(alpha);
  await pool.setWorkRunExpanded(alpha, 'run-a', false);
  assert.equal(alphaClient.checkpoints, 1);
  assert.equal(alphaClient.folds, 1);

  alphaClient.stopResults.push(
    { action: 'graceful', runtimeKey: conversationRuntimeKey(alpha), runId: 'run-a', generation: 1, checkpointed: true, backend: 'utility', pid: 123 },
    { action: 'graceful', runtimeKey: conversationRuntimeKey(alpha), runId: 'run-a', generation: 1, checkpointed: true, backend: 'utility', pid: 123 },
  );
  assert.equal((await pool.requestStop(alpha, 'run-a')).action, 'graceful');
  for (const listener of alphaClient.listeners) listener({
    id: 'utility-bare-abort-error', conversationId: 'same', type: 'error', content: 'This operation was aborted',
    mode: 'Build', model: 'm', timestamp: new Date().toISOString(), runId: 'run-a',
  });
  assert.equal(pool.isStopping(alpha), true,
    'a bare worker error cannot disarm utility force-stop before an explicit terminal settlement status');
  await pool.enqueueGuide({
    clientMessageId: 'utility-guide-disarms-force', target: normalizeConversationTarget(alpha), runId: 'run-a',
    deliveryMode: 'steer', text: 'intervening Guide', createdAt: new Date().toISOString(),
  });
  assert.equal(pool.isStopping(alpha), false, 'a new Electron Guide cancels the supervisor force escalation sequence');
  assert.equal((await pool.requestStop(alpha, 'run-a')).action, 'graceful', 'the next Electron stop after Guide is conservative again');
  assert.equal(alphaClient.stopCalls, 2);
  const forced = await pool.requestStop(alpha, 'run-a');
  assert.equal(forced.action, 'force');
  assert.equal(forced.restarted, true);
  assert.equal(alphaClient.restarts, 1);
  assert.equal(betaClient.restarts, 0, 'forcing one utility runtime must not restart another target');
  alphaClient.stopResults.push(
    { action: 'graceful', runtimeKey: conversationRuntimeKey(alpha), runId: 'run-a', generation: 1, checkpointed: true, backend: 'utility', pid: 123 },
  );
  assert.equal((await pool.requestStop(alpha, 'run-a')).action, 'graceful');
  for (const listener of alphaClient.listeners) listener({
    id: 'utility-explicit-interrupted', conversationId: 'same', type: 'status', content: 'Interrupted.',
    mode: 'Build', model: 'm', timestamp: new Date().toISOString(), runId: 'run-a', status: 'interrupted',
  });
  assert.equal(pool.isStopping(alpha), false, 'an explicit utility interrupted status settles supervisor stop intent');
  await pool.updateSetting('agent', 'process_timeout_ms', 1234);
  assert.equal(alphaClient.settings, 1);
  assert.equal(betaClient.settings, 1, 'setting updates broadcast to every live utility worker');
  await pool.stopAll();
  assert.equal(alphaClient.stops, 1);
  assert.equal(betaClient.stops, 1);

  const hungClients = new Map<string, FakeElectronTargetClient>();
  const hungPool = new ElectronUtilityRuntimePool('C:\\root', 'utility.js', normalized => {
    const client = new FakeElectronTargetClient(normalized);
    hungClients.set(normalized.runtimeKey, client);
    return client;
  }, { stopRequestTimeoutMs: 15 });
  await hungPool.prompt({ message: 'hung', target: alpha, options, queueMode: 'steer' });
  const hungClient = hungClients.get(conversationRuntimeKey(alpha))!;
  hungClient.hangStops = true;
  const timedOutFirst = await hungPool.requestStop(alpha, 'run-hung-utility');
  assert.equal(timedOutFirst.action, 'graceful', 'hung Electron stop acknowledgement remains an explicit supervisor stopping state');
  assert.equal(hungPool.isStopping(alpha), true);
  const stoppingSnapshot = await hungPool.snapshot(alpha);
  assert.equal(stoppingSnapshot.runtime?.stopRequested, true,
    'Electron supervisor snapshot remains responsive while the child event loop is blocked');
  const forcedHung = await Promise.race([
    hungPool.requestStop(alpha, 'run-hung-utility'),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hung Electron force stop waited on child IPC')), 250)),
  ]);
  assert.equal(forcedHung.action, 'force');
  assert.equal(forcedHung.restarted, true);
  assert.equal(hungClient.stopCalls, 1, 'second Electron stop force-restarts directly without another child stop RPC');
  assert.equal(hungClient.restarts, 1);
  assert.equal(hungPool.isStopping(alpha), false);
  await hungPool.stopAll();

  let quarantineFactoryCalls = 0;
  let quarantineClient!: FakeElectronTargetClient;
  const quarantinePool = new ElectronUtilityRuntimePool('C:\\root', 'utility.js', normalized => {
    quarantineFactoryCalls++;
    quarantineClient = new FakeElectronTargetClient(normalized);
    return quarantineClient;
  });
  await quarantinePool.prompt({ message: 'quarantine cleanup', target: alpha, options, queueMode: 'steer' });
  quarantineClient.stopResults.push({
    action: 'graceful', runtimeKey: conversationRuntimeKey(alpha), runId: 'run-quarantine', generation: 1,
    checkpointed: true, backend: 'utility', pid: 123,
  });
  assert.equal((await quarantinePool.requestStop(alpha, 'run-quarantine')).action, 'graceful');
  quarantineClient.restartFailure = 'injected retained-handle restart failure';
  await assert.rejects(
    quarantinePool.requestStop(alpha, 'run-quarantine'),
    /restart recovery failed.*retained-handle/i,
  );
  assert.equal(quarantinePool.status(alpha).quarantined, true);
  quarantineClient.restartFailure = '';
  const cleanupOnly = await quarantinePool.requestStop(alpha, 'run-quarantine');
  assert.equal(cleanupOnly.action, 'force');
  assert.equal(cleanupOnly.restarted, false, 'quarantined retained handles are cleanup-only and never authorize replacement');
  assert.equal(quarantineClient.forceStops, 1);
  assert.equal(quarantineClient.restarts, 1, 'cleanup retry must not invoke forceRestart a second time');
  await quarantinePool.stopTarget(alpha);
  assert.deepEqual(quarantinePool.runtimeKeys(), [], 'confirmed cleanup permits entry eviction');
  await assert.rejects(
    quarantinePool.prompt({ message: 'must never recreate', target: alpha, options, queueMode: 'steer' }),
    /quarantined until the app backend is restarted/i,
  );
  assert.equal(quarantineFactoryCalls, 1, 'pool-lifetime quarantine blocks a fresh client factory after entry eviction');

  let failingStopClient!: FakeElectronTargetClient;
  const failingStopPool = new ElectronUtilityRuntimePool('C:\\root', 'utility.js', normalized => {
    failingStopClient = new FakeElectronTargetClient(normalized);
    return failingStopClient;
  });
  await failingStopPool.prompt({ message: 'stop failure', target: beta, options, queueMode: 'steer' });
  failingStopClient.stopFailure = 'injected stop retained live entry';
  await assert.rejects(failingStopPool.stopAll(), /could not be stopped/i);
  assert.deepEqual(failingStopPool.runtimeKeys(), [conversationRuntimeKey(beta)],
    'stopAll aggregation retains an entry whose live UtilityProcess handle could not be stopped');
  assert.equal(failingStopPool.status(beta).quarantined, true);
  failingStopClient.stopFailure = '';
  await failingStopPool.requestStop(beta, 'cleanup-after-stopAll');
  await failingStopPool.stopTarget(beta);
  assert.deepEqual(failingStopPool.runtimeKeys(), []);

  let directTargetFactoryCalls = 0;
  let directTargetClient!: FakeElectronTargetClient;
  const directTargetPool = new ElectronUtilityRuntimePool('C:\\root', 'utility.js', normalized => {
    directTargetFactoryCalls++;
    directTargetClient = new FakeElectronTargetClient(normalized);
    return directTargetClient;
  });
  await directTargetPool.prompt({ message: 'direct target quarantine', target: alpha, options, queueMode: 'steer' });
  directTargetClient.quarantined = true;
  directTargetClient.error = 'injected connected quarantine before stopTarget';
  await directTargetPool.stopTarget(alpha);
  assert.equal(directTargetClient.forceStops, 1,
    'stopTarget uses cleanup-only forceStop for a connected quarantined runtime');
  assert.equal(directTargetClient.stops, 0, 'stopTarget never uses root-only ordinary stop for connected quarantine');
  assert.deepEqual(directTargetPool.runtimeKeys(), []);
  await assert.rejects(
    directTargetPool.prompt({ message: 'blocked after target cleanup', target: alpha, options, queueMode: 'steer' }),
    /quarantined until the app backend is restarted/i,
  );
  assert.equal(directTargetFactoryCalls, 1);

  let directAllClient!: FakeElectronTargetClient;
  const directAllPool = new ElectronUtilityRuntimePool('C:\\root', 'utility.js', normalized => {
    directAllClient = new FakeElectronTargetClient(normalized);
    return directAllClient;
  });
  await directAllPool.prompt({ message: 'direct all quarantine', target: beta, options, queueMode: 'steer' });
  directAllClient.quarantined = true;
  directAllClient.error = 'injected connected quarantine before stopAll';
  await directAllPool.stopAll();
  assert.equal(directAllClient.forceStops, 1,
    'stopAll routes connected quarantined entries through cleanup-only forceStop');
  assert.equal(directAllClient.stops, 0);
  assert.deepEqual(directAllPool.runtimeKeys(), []);
}

async function verifyRuntimeShutdownOrdering(): Promise<void> {
  const order: string[] = [];
  const startedAt = Date.now();
  const delayedStop = new Promise<void>(resolve => {
    setTimeout(() => {
      order.push('delayed-stop-settled');
      resolve();
    }, 40);
  });
  const rejectedStop = Promise.reject(new Error('injected peer stop failure'));
  await assert.rejects(
    runRuntimeShutdownBarrier({
      operations: [rejectedStop, delayedStop, undefined],
      shutdownHelpers: async () => { order.push('helpers-shutdown'); },
    }),
    /shutdown barrier completed with failures/i,
  );
  assert.ok(Date.now() - startedAt >= 35, 'helper shutdown cannot run on the first rejection while a peer stop is pending');
  assert.deepEqual(order, ['delayed-stop-settled', 'helpers-shutdown'],
    'runtime cleanup allSettled strictly precedes helper subsystem shutdown');
}

async function verifyWindowsHelperRetainedDrain(): Promise<void> {
  if (process.platform !== 'win32') return;
  class FakeWindowsHelper extends EventEmitter {
    constructor(readonly pid: number) { super(); }
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    killCalls = 0;
    allowClose = false;
    kill(): boolean {
      this.killCalls++;
      if (this.allowClose && this.exitCode === null) {
        this.exitCode = 1;
        queueMicrotask(() => this.emit('close', 1, null));
      }
      return true;
    }
  }
  const helper = new FakeWindowsHelper(2_000_000_091);
  const child = helper as unknown as Parameters<typeof trackWindowsProcessHelperForTest>[0];
  trackWindowsProcessHelperForTest(child);
  const closedWithinGrace = await terminateWindowsProcessHelperForTest(child);
  assert.equal(closedWithinGrace, false, 'a helper that ignores the first kill remains retained after close grace');
  assert.deepEqual(activeWindowsProcessHelperPidsForTest(), [helper.pid],
    'close grace expiry retains the original ChildProcess record instead of dropping a PID-only tracker');
  helper.allowClose = true;
  await drainWindowsProcessHelpers(2_000);
  assert.equal(helper.killCalls >= 2, true, 'explicit drain retries termination through the retained ChildProcess handle');
  assert.deepEqual(activeWindowsProcessHelperPidsForTest(), [], 'only the helper close event removes its monotonic record');

  const ownerAHelper = new FakeWindowsHelper(2_000_000_092);
  const ownerBHelper = new FakeWindowsHelper(2_000_000_093);
  ownerAHelper.allowClose = true;
  const ownerAChild = ownerAHelper as unknown as Parameters<typeof trackWindowsProcessHelperForTest>[0];
  const ownerBChild = ownerBHelper as unknown as Parameters<typeof trackWindowsProcessHelperForTest>[0];
  trackWindowsProcessHelperForTest(ownerAChild, 'runtime-a::generation:1');
  trackWindowsProcessHelperForTest(ownerBChild, 'runtime-b::generation:1');
  await drainWindowsProcessHelpers(2_000, 'runtime-a::generation:1');
  assert.equal(ownerAHelper.killCalls >= 1, true);
  assert.equal(ownerBHelper.killCalls, 0,
    'target A cleanup never kills target B creation-identity/tree helper');
  assert.deepEqual(activeWindowsProcessHelperPidsForTest(), [ownerBHelper.pid]);
  ownerBHelper.allowClose = true;
  await drainWindowsProcessHelpers(2_000, 'runtime-b::generation:1');
  assert.deepEqual(activeWindowsProcessHelperPidsForTest(), []);

  let outputLimitError = '';
  setWindowsProcessQueryScriptForTest(`$chunk = 'x' * 8192; while ($true) { Write-Output $chunk }`);
  try {
    await snapshotWindowsProcessTree(process.pid, 5_000);
  } catch (error) {
    outputLimitError = error instanceof Error ? error.message : String(error);
  } finally {
    setWindowsProcessQueryScriptForTest(null);
  }
  await drainWindowsProcessHelpers(2_000);
  assert.match(outputLimitError, /exceeded its output limit/i,
    'snapshot output overflow rejects through the shared kill-and-close lifecycle');
  assert.deepEqual(activeWindowsProcessHelperPidsForTest(), [],
    'output-limit cleanup retains/drains the helper handle instead of finishing directly from the data callback');

  const identityFixture = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      identityFixture.once('spawn', () => resolve());
      identityFixture.once('error', reject);
    });
    const fixturePid = Number(identityFixture.pid || 0);
    const snapshot = await snapshotWindowsProcessTree(fixturePid);
    const root = snapshot.entries.find(entry => entry.pid === fixturePid);
    assert.ok(root?.creationIdentity, 'identity helper fixture root creation identity is captured');
    const mismatchedIdentity = (BigInt(root!.creationIdentity) + 1n).toString();
    const rejectedReusedAnchor = await snapshotWindowsProcessTree(
      fixturePid,
      12_000,
      [fixturePid],
      'runtime-isolation-anchor-mismatch',
      new Map([[fixturePid, mismatchedIdentity]]),
    );
    assert.equal(rejectedReusedAnchor.entries.some(entry => entry.pid === fixturePid), false,
      'identity-bound rescans exclude a live PID when it no longer matches the captured runtime identity');
    const acceptedBoundAnchor = await snapshotWindowsProcessTree(
      fixturePid,
      12_000,
      [fixturePid],
      'runtime-isolation-anchor-match',
      new Map([[fixturePid, root!.creationIdentity]]),
    );
    assert.equal(acceptedBoundAnchor.entries.some(entry => entry.pid === fixturePid
      && entry.creationIdentity === root!.creationIdentity), true,
    'identity-bound rescans retain the original runtime process while its creation identity still matches');
    await terminateCapturedWindowsProcessTree({ rootPid: fixturePid, entries: [root!] });
    await new Promise<void>(resolve => {
      if (identityFixture.exitCode !== null || identityFixture.signalCode !== null) resolve();
      else identityFixture.once('close', () => resolve());
    });
    await drainWindowsProcessHelpers(2_000);
    assert.deepEqual(activeWindowsProcessHelperPidsForTest(), [],
      'real identity-bound termination closes and removes its PowerShell helper record');
  } finally {
    if (identityFixture.exitCode === null && identityFixture.signalCode === null) {
      try { identityFixture.kill(); } catch {}
    }
  }

  const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-anchor-exit-race-'));
  const childPidPath = path.join(barrierDir, 'child.pid');
  const barrierReadyPath = path.join(barrierDir, 'snapshot-ready');
  const barrierContinuePath = path.join(barrierDir, 'snapshot-continue');
  const barrierScript = `
    const fs = require('fs');
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('spawn', () => fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid)));
    setInterval(() => {}, 1000);
  `;
  const barrierRoot = spawn(process.execPath, ['-e', barrierScript], { stdio: 'ignore', windowsHide: true });
  let survivingChildPid = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      barrierRoot.once('spawn', () => resolve());
      barrierRoot.once('error', reject);
    });
    const waitForPath = async (candidate: string, label: string): Promise<void> => {
      const deadline = Date.now() + 8_000;
      while (!fs.existsSync(candidate)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await new Promise<void>(resolve => setTimeout(resolve, 20));
      }
    };
    await waitForPath(childPidPath, 'anchor race child');
    survivingChildPid = Number(fs.readFileSync(childPidPath, 'utf8').trim());
    const rootPid = Number(barrierRoot.pid || 0);
    const initial = await snapshotWindowsProcessTree(rootPid);
    const rootEntry = initial.entries.find(entry => entry.pid === rootPid);
    const childEntry = initial.entries.find(entry => entry.pid === survivingChildPid);
    assert.ok(rootEntry?.creationIdentity && childEntry?.creationIdentity,
      'anchor exit-race fixture captures root and surviving child identities before teardown');

    setWindowsProcessQueryAnchorBarrierForTest({
      readyPath: barrierReadyPath,
      continuePath: barrierContinuePath,
    });
    const rescanPromise = snapshotWindowsProcessTree(
      rootPid,
      12_000,
      [rootPid, survivingChildPid],
      'runtime-isolation-anchor-exit-race',
      new Map([
        [rootPid, rootEntry!.creationIdentity],
        [survivingChildPid, childEntry!.creationIdentity],
      ]),
    );
    await waitForPath(barrierReadyPath, 'post-Toolhelp anchor barrier');
    const rootClosed = new Promise<void>(resolve => {
      if (barrierRoot.exitCode !== null || barrierRoot.signalCode !== null) resolve();
      else barrierRoot.once('close', () => resolve());
    });
    barrierRoot.kill();
    await Promise.race([
      rootClosed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Anchor race root did not exit')), 5_000)),
    ]);
    fs.writeFileSync(barrierContinuePath, 'continue', 'utf8');
    const rescan = await rescanPromise;
    const survivingEntry = rescan.entries.find(entry => entry.pid === survivingChildPid);
    assert.equal(rescan.entries.some(entry => entry.pid === rootPid), false,
      'an anchor that exits after Toolhelp capture remains a parent-only witness and is never emitted as a live row');
    assert.equal(survivingEntry?.creationIdentity, childEntry!.creationIdentity,
      'a same-snapshot surviving child retains its identity while the parent anchor exits during lookup');
    await terminateCapturedWindowsProcessTree({
      rootPid: survivingChildPid,
      entries: [{ ...survivingEntry!, depth: 0 }],
    });
    survivingChildPid = 0;
  } finally {
    try { fs.writeFileSync(barrierContinuePath, 'continue', 'utf8'); } catch {}
    setWindowsProcessQueryAnchorBarrierForTest(null);
    if (barrierRoot.exitCode === null && barrierRoot.signalCode === null) {
      try { barrierRoot.kill(); } catch {}
    }
    if (survivingChildPid > 0) {
      try { process.kill(survivingChildPid); } catch {}
    }
    fs.rmSync(barrierDir, { recursive: true, force: true });
  }
}

async function verifyIdleRuntimeTtlEviction(): Promise<void> {
  const options: ConversationKernelRunOptions = { mode: 'build', model: 'm', intelligence: 'medium', inputMode: 'guide', engine: 'builtin' };
  const idleTarget = target('idle', 'C:\\work\\idle', 'same');
  let electronClient: FakeElectronTargetClient | undefined;
  const electronPool = new ElectronUtilityRuntimePool('C:\\root', 'utility.js', normalized => {
    electronClient = new FakeElectronTargetClient(normalized);
    return electronClient;
  }, { idleTtlMs: 10 });
  await electronPool.prompt({ message: 'done immediately', target: idleTarget, options, queueMode: 'steer' });

  let wslClient: FakeWslTargetClient | undefined;
  const wslPool = new WslAgentRuntimePool('Fake', 'C:\\root', 'host.js', normalized => {
    wslClient = new FakeWslTargetClient(normalized);
    return wslClient;
  }, { idleTtlMs: 10 });
  await wslPool.prompt({ message: 'done immediately', target: idleTarget, conversationId: 'same', options, queueMode: 'steer', workspace: null });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(electronClient?.stops, 1, 'idle utility child is evicted after the configured TTL');
  assert.equal(wslClient?.stops, 1, 'idle WSL process group is evicted after the configured TTL');
  assert.deepEqual(electronPool.runtimeKeys(), []);
  assert.deepEqual(wslPool.runtimeKeys(), []);
  assert.equal(await electronPool.setWorkRunExpanded(idleTarget, 'persisted-run', true), true,
    'folding a completed run recreates an evicted utility worker and persists the preference');
  assert.equal(await wslPool.setWorkRunExpanded(idleTarget, 'persisted-run', true), true,
    'folding a completed run recreates an evicted WSL worker and persists the preference');
  assert.equal(electronClient?.folds, 1);
  assert.equal(wslClient?.folds, 1);
  await electronPool.stopAll();
  await wslPool.stopAll();
}

class DelayedSnapshotElectronClient extends FakeElectronTargetClient {
  readonly snapshotEntered: Promise<void>;
  private enter!: () => void;
  private release!: () => void;
  private readonly gate: Promise<void>;
  constructor(targetInfo: ConversationRuntimeTarget) {
    super(targetInfo);
    this.snapshotEntered = new Promise(resolve => { this.enter = resolve; });
    this.gate = new Promise(resolve => { this.release = resolve; });
  }
  releaseSnapshot(): void { this.release(); }
  override async snapshot(): Promise<UtilityAgentSnapshotResult> {
    this.enter();
    await this.gate;
    return await super.snapshot();
  }
}

class DelayedSnapshotWslClient extends FakeWslTargetClient {
  readonly snapshotEntered: Promise<void>;
  private enter!: () => void;
  private release!: () => void;
  private readonly gate: Promise<void>;
  constructor(targetInfo: ConversationRuntimeTarget) {
    super(targetInfo);
    this.snapshotEntered = new Promise(resolve => { this.enter = resolve; });
    this.gate = new Promise(resolve => { this.release = resolve; });
  }
  releaseSnapshot(): void { this.release(); }
  override async snapshotTarget(): Promise<Record<string, unknown>> {
    this.enter();
    await this.gate;
    return await super.snapshotTarget();
  }
}

async function verifyIdleEvictionCannotRaceNewPrompt(): Promise<void> {
  const options: ConversationKernelRunOptions = { mode: 'build', model: 'm', intelligence: 'medium', inputMode: 'guide', engine: 'builtin' };
  const raceTarget = target('ttl-race', 'C:\\work\\ttl-race', 'same');
  let electronClient!: DelayedSnapshotElectronClient;
  const electronPool = new ElectronUtilityRuntimePool('C:\\root', 'utility.js', normalized => {
    electronClient = new DelayedSnapshotElectronClient(normalized);
    return electronClient;
  }, { idleTtlMs: 30 });

  let wslClient!: DelayedSnapshotWslClient;
  const wslPool = new WslAgentRuntimePool('Fake', 'C:\\root', 'host.js', normalized => {
    wslClient = new DelayedSnapshotWslClient(normalized);
    return wslClient;
  }, { idleTtlMs: 30 });
  await Promise.all([
    electronPool.prompt({ message: 'first', target: raceTarget, options, queueMode: 'steer' }),
    wslPool.prompt({ message: 'first', target: raceTarget, conversationId: 'same', options, queueMode: 'steer', workspace: null }),
  ]);
  // Pool timers are intentionally unref'ed in production. Keep one test-owned
  // timer referenced long enough for both TTL callbacks to enter snapshot().
  await new Promise(resolve => setTimeout(resolve, 40));
  await Promise.all([electronClient.snapshotEntered, wslClient.snapshotEntered]);
  await Promise.all([
    electronPool.prompt({ message: 'new prompt while eviction snapshot waits', target: raceTarget, options, queueMode: 'steer' }),
    wslPool.prompt({ message: 'new prompt while eviction snapshot waits', target: raceTarget, conversationId: 'same', options, queueMode: 'steer', workspace: null }),
  ]);
  electronClient.releaseSnapshot();
  wslClient.releaseSnapshot();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(electronClient.stops, 0, 'stale utility TTL snapshot cannot stop a runtime touched by a concurrent prompt');
  assert.equal(wslClient.stops, 0, 'stale WSL TTL snapshot cannot stop a runtime touched by a concurrent prompt');
  await Promise.all([electronPool.stopAll(), wslPool.stopAll()]);
}

async function verifyUtilityHostToolRouting(): Promise<void> {
  const normalized = normalizeConversationTarget(target('alpha', 'C:\\work\\alpha', 'same'));
  const targetInfo = {
    workspaceId: normalized.workspaceId,
    conversationId: normalized.conversationId,
    runtimeKey: normalized.runtimeKey,
    workspaceKey: normalized.workspaceKey,
    workspacePath: normalized.workspace!.path,
  };
  const rootActor = '00000000-0000-4000-8000-000000000001';
  const context = {
    workspaceId: normalized.workspaceId,
    conversationId: normalized.conversationId,
    actorId: rootActor,
    workspacePath: normalized.workspace!.path,
    backend: 'utility',
    mode: 'build',
  };
  const computerCalls: Array<Record<string, unknown>> = [];
  const terminalCalls: Array<Record<string, unknown>> = [];
  const automationCalls: string[] = [];
  const handler = createUtilityHostToolHandler({
    persistenceRoot: 'C:\\root',
    runBrowser: async request => ({ ok: true, action: request.action, source: 'test' }),
    runComputer: async request => { computerCalls.push(request as unknown as Record<string, unknown>); return 'computer-ok'; },
    runTerminal: request => { terminalCalls.push(request as unknown as Record<string, unknown>); return 'terminal-ok'; },
    runAutomation: (tool) => { automationCalls.push(tool); return 'automation-ok'; },
  });
  const request = <T extends UtilityHostToolRequest>(value: T): T => value;

  assert.equal(await handler(request({
    requestId: 'c1',
    tool: 'computer_use',
    args: {
      action: 'observe',
      capture_max_width: 640,
      capture_max_height: 480,
      allow_ephemeral_vision_image: true,
    },
    target: targetInfo,
    context,
  })), 'computer-ok');
  assert.equal(computerCalls[0].captureMaxWidth, 640, 'utility host forwards bounded capture width requests');
  assert.equal(computerCalls[0].captureMaxHeight, 480, 'utility host forwards bounded capture height requests');
  assert.equal(computerCalls[0].allowEphemeralVisionImage, false, 'model-authored args cannot enable ephemeral screenshot retention');
  const beta = normalizeConversationTarget(target('beta', 'C:\\work\\beta', 'same'));
  const betaTarget = { workspaceId: beta.workspaceId, conversationId: beta.conversationId, runtimeKey: beta.runtimeKey, workspaceKey: beta.workspaceKey, workspacePath: beta.workspace!.path };
  const betaContext = { ...context, workspaceId: beta.workspaceId, conversationId: beta.conversationId, workspacePath: beta.workspace!.path };
  const locked = await handler(request({ requestId: 'c2', tool: 'computer_use', args: { action: 'observe' }, target: betaTarget, context: betaContext }));
  assert.match(String(locked), /already active/, 'main-process Computer Use lock must span all utility runtimes');
  assert.equal(computerCalls.length, 1);
  await handler(request({ requestId: 'c3', tool: 'computer_use', args: { action: 'takeover_stop' }, target: targetInfo, context }));
  const betaVisionContext = { ...betaContext, allowEphemeralVisionImage: true };
  await handler(request({ requestId: 'c4', tool: 'computer_use', args: { action: 'observe' }, target: betaTarget, context: betaVisionContext }));
  assert.equal(computerCalls.length, 3);
  assert.equal(computerCalls[2].allowEphemeralVisionImage, true, 'trusted utility runtime context may enable one-use vision input');
  handler.cancelTarget(beta.runtimeKey);
  await Promise.resolve();
  assert.equal(computerCalls.at(-1)?.action, 'takeover_stop', 'target cancellation revokes its global Computer Use lease');

  const terminalArgs = { action: 'start', name: 'x', cwd: 'C:\\forged', owner: { workspaceId: 'forged' } } as Record<string, unknown>;
  assert.equal(await handler(request({ requestId: 't1', tool: 'terminal_takeover', args: terminalArgs, target: targetInfo, context })), 'terminal-ok');
  assert.equal(terminalCalls[0].cwd, normalized.workspace!.path);
  assert.equal((terminalCalls[0].owner as Record<string, unknown>).workspaceId, terminalTakeoverWorkspaceId(normalized.workspace!.path));

  await assert.rejects(() => handler(request({
    requestId: 'a1', tool: 'automation', args: { tool: 'automation_create', payload: '{"prompt":"x"}' },
    target: targetInfo, context: { ...context, mode: 'plan' },
  })), /Plan mode/);
  assert.equal(automationCalls.length, 0, 'host automation delegate must not bypass ToolPolicy');
  assert.equal(await handler(request({
    requestId: 'a2', tool: 'automation', args: { tool: 'automation_list', payload: '{}' },
    target: targetInfo, context: { ...context, mode: 'plan' },
  })), 'automation-ok');
}

async function verifyStoppedRootPausesQueuedSubagents(): Promise<void> {
  const started: string[] = [];
  const rejectRunning = new Map<string, (error: Error) => void>();
  const persisted: SubagentState[] = [];
  const manager = new SubagentManager({
    conversationId: 'stop-pause',
    concurrency: 4,
    executor: job => {
      started.push(job.record.id);
      return new Promise<string>((_resolve, reject) => { rejectRunning.set(job.record.id, reject); });
    },
    persist: state => { persisted.push(state); },
  });
  const ids = Array.from({ length: 5 }, (_, index) => manager.create(`peer-${index + 1}`, `work-${index + 1}`));
  await Promise.resolve();
  assert.equal(started.length, 4, 'four peer slots start while the fifth remains queued');
  assert.equal(manager.get(ids[4])?.status, 'queued');

  manager.pauseScheduling();
  for (const reject of rejectRunning.values()) reject(new Error('root run stopped'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(started.length, 4, 'settling aborted peers cannot pump the fifth job while root scheduling is paused');
  assert.equal(manager.get(ids[4])?.status, 'queued');
  assert.equal(manager.isSchedulingPaused(), true);
  assert.equal(persisted.at(-1)?.schedulingPaused, true, 'cooperative scheduling pause is persisted in the checkpointable subagent state');

  const checkpoint = manager.serialize();
  const restarted: string[] = [];
  const reloaded = new SubagentManager({
    conversationId: 'stop-pause',
    concurrency: 4,
    state: checkpoint,
    executor: async job => { restarted.push(job.record.id); return 'resumed'; },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(restarted.length, 0, 'reloading a stopped checkpoint does not auto-start its durable queued peer');
  reloaded.resumeScheduling();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(restarted, [ids[4]], 'the next explicit root run resumes and starts the deferred peer exactly once');
}

async function main(): Promise<void> {
  await verifyConversationTargets();
  await verifyStableWorkspaceIds();
  await verifyCrossHostWorkspaceRegistryIsolation();
  await verifyWorkspaceSelectionCoordination();
  await verifyWorkspaceSelectionCircuitBreaker();
  await verifyColdSnapshotBindsTargetWorkspace();
  await verifyKernelPublicWorkRunTargetBinding();
  await verifyKernelCompositeRuntimeAndStop();
  await verifyCooperativeStopSettlesInterrupted();
  await verifyInputsArrivingAfterStopAreDurable();
  await verifyRendererReconcilesCompletionAgainstFirstStop();
  await verifyWslPerTargetPool();
  await verifyWslHostToolIdentityBinding();
  await verifyWslAsyncProcessGroupTermination();
  await verifyRealUbuntuProcessGroupTermination();
  await verifyElectronPerTargetPool();
  await verifyRuntimeShutdownOrdering();
  await verifyWindowsHelperRetainedDrain();
  await verifyIdleRuntimeTtlEviction();
  await verifyIdleEvictionCannotRaceNewPrompt();
  await verifyUtilityHostToolRouting();
  await verifyStoppedRootPausesQueuedSubagents();
  console.log('runtime isolation verification passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
