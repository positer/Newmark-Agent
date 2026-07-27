import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Agent } from '../core/agent';
import { AutomationManager, AutomationSchedule } from '../core/automation';
import { ConfigManager } from '../core/config';
import { ConversationKernel } from '../core/conversationKernel';
import { ConversationRuntimeTarget } from '../core/conversationTarget';
import { executeWorkspaceBash, NativeBashSession } from '../core/nativeBash';
import type { StreamToken } from '../core/types';
import { spawnTakeoverPty } from '../tools/terminalTakeover';

interface AutomationReceipt {
  automationId: string;
  workspaceId: string;
  workspacePath: string;
  conversationMode: string;
  conversationId: string;
  runId: string;
  prompt: string;
}

class StressRunner extends Agent {
  constructor(root: string, workspacePath: string) {
    super(root, { agentOnly: true, workspaceRegistryMode: 'detached' });
    this.workspace.current = {
      id: path.basename(workspacePath),
      name: path.basename(workspacePath),
      path: workspacePath,
      isInternal: false,
      kind: 'local',
      hostBinding: '',
      icon: '',
    };
  }

  override async process(input: string | { text: string }): Promise<StreamToken[]> {
    const text = typeof input === 'string' ? input : input.text;
    await new Promise(resolve => setTimeout(resolve, 2 + Math.floor(Math.random() * 5)));
    return [{ type: 'text', text: `stress-ok:${text}` }];
  }
}

function target(workspaceId: string, workspacePath: string, conversationId: string): ConversationRuntimeTarget {
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

async function stressAutomations(root: string): Promise<Record<string, unknown>> {
  const runtimeRoot = path.join(root, 'automation-runtime');
  const workspaceA = path.join(root, 'workspace-a');
  const workspaceB = path.join(root, 'workspace-b');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(workspaceA, { recursive: true });
  fs.mkdirSync(workspaceB, { recursive: true });

  const config = new ConfigManager(runtimeRoot);
  config.set('automation', 'schedules', []);
  config.save();
  const host = new StressRunner(runtimeRoot, workspaceA);
  host.setConversation('default');
  const kernel = new ConversationKernel(runtimeRoot, host, null, {
    createRunner: normalized => new StressRunner(runtimeRoot, normalized.workspace?.path || workspaceA),
  });
  const receipts: AutomationReceipt[] = [];
  const runAutomation = async (prompt: string, _model: string, item: AutomationSchedule): Promise<string> => {
    const workspacePath = item.workspaceId === 'workspace-b' ? workspaceB : workspaceA;
    const conversationId = item.conversationMode === 'existing'
      ? item.conversationId
      : `automation-${item.id}-${randomUUID().slice(0, 12)}`;
    manager.update(item.id, { lastConversationId: conversationId });
    const result = await kernel.prompt(prompt, target(item.workspaceId, workspacePath, conversationId), {
      mode: 'build',
      model: 'stress-model',
      intelligence: 'medium',
      inputMode: 'next',
      engine: 'native',
    });
    receipts.push({
      automationId: item.id,
      workspaceId: item.workspaceId,
      workspacePath,
      conversationMode: item.conversationMode,
      conversationId,
      runId: result.runId,
      prompt,
    });
    return result.tokens.map(token => token.text).join('');
  };
  const manager = new AutomationManager(config, runAutomation, 5);

  const schedules: AutomationSchedule[] = [];
  for (let index = 0; index < 16; index += 1) {
    schedules.push(manager.create({
      prompt: `new-once-${index}`,
      workspaceId: index % 2 === 0 ? 'workspace-a' : 'workspace-b',
      conversationMode: 'new',
      condition: 'once',
      active: true,
    }));
  }
  for (let index = 0; index < 8; index += 1) {
    schedules.push(manager.create({
      prompt: `existing-once-${index}`,
      workspaceId: index % 2 === 0 ? 'workspace-a' : 'workspace-b',
      conversationMode: 'existing',
      conversationId: `existing-${index}`,
      condition: 'once',
      active: true,
    }));
  }
  const loopNew = manager.create({
    prompt: 'loop-new', workspaceId: 'workspace-a', conversationMode: 'new',
    condition: 'loop', intervalSec: 1, active: true,
  });
  const loopExisting = manager.create({
    prompt: 'loop-existing', workspaceId: 'workspace-b', conversationMode: 'existing',
    conversationId: 'existing-loop', condition: 'loop', intervalSec: 1, active: true,
  });

  const base = Date.now() + 10_000;
  await manager.tick(new Date(base));
  for (let cycle = 1; cycle < 12; cycle += 1) {
    await manager.tick(new Date(base + cycle * 1_100));
  }

  const liveTimerStart = receipts.length;
  for (let index = 0; index < 8; index += 1) {
    schedules.push(manager.create({
      prompt: `live-timer-${index}`,
      workspaceId: index % 2 === 0 ? 'workspace-a' : 'workspace-b',
      conversationMode: index % 2 === 0 ? 'new' : 'existing',
      conversationId: index % 2 === 0 ? '' : `existing-live-${index}`,
      condition: 'once',
      active: true,
    }));
  }
  manager.start();
  const liveDeadline = Date.now() + 5_000;
  while (receipts.length < liveTimerStart + 8 && Date.now() < liveDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  manager.stop();
  assert.strictEqual(receipts.length, liveTimerStart + 8, 'real setInterval scheduling executes all due wall-clock tasks');

  assert.strictEqual(receipts.length, 56, '32 once runs plus 12 runs for each loop automation');
  assert.strictEqual(new Set(receipts.map(receipt => receipt.runId)).size, receipts.length, 'every trigger owns a distinct Build run');
  const newReceipts = receipts.filter(receipt => receipt.conversationMode === 'new');
  assert.strictEqual(new Set(newReceipts.map(receipt => receipt.conversationId)).size, newReceipts.length, 'new mode creates a distinct conversation per trigger');
  const existingReceipts = receipts.filter(receipt => receipt.conversationMode === 'existing');
  assert.ok(existingReceipts.every(receipt => receipt.conversationId.startsWith('existing-')), 'existing mode retains the configured conversation');
  assert.ok(receipts.every(receipt => receipt.workspacePath === (receipt.workspaceId === 'workspace-a' ? workspaceA : workspaceB)), 'every run resolves the configured workspace');
  assert.strictEqual(manager.list().find(item => item.id === loopNew.id)?.runCount, 12);
  assert.strictEqual(manager.list().find(item => item.id === loopExisting.id)?.runCount, 12);

  let releaseSlow!: () => void;
  let slowStarts = 0;
  const slowRoot = path.join(root, 'automation-reentry');
  fs.mkdirSync(slowRoot, { recursive: true });
  const slowConfig = new ConfigManager(slowRoot);
  slowConfig.set('automation', 'schedules', []);
  slowConfig.save();
  const slowManager = new AutomationManager(slowConfig, async () => {
    slowStarts += 1;
    await new Promise<void>(resolve => { releaseSlow = resolve; });
    return 'slow-ok';
  }, 1);
  const slow = slowManager.create({
    prompt: 'slow', workspaceId: 'workspace-a', conversationMode: 'new', condition: 'once', active: true,
  });
  const first = slowManager.tick(new Date(base));
  while (slowStarts === 0) await new Promise(resolve => setTimeout(resolve, 1));
  await Promise.all(Array.from({ length: 40 }, () => slowManager.tick(new Date(base + 1))));
  assert.strictEqual(slowStarts, 1, '40 overlapping ticks cannot re-enter one running automation');
  releaseSlow();
  await first;
  assert.strictEqual(slowManager.list().find(item => item.id === slow.id)?.runCount, 1);

  const persistedRuns = [workspaceA, workspaceB].flatMap(workspacePath => {
    const state = JSON.parse(fs.readFileSync(path.join(workspacePath, 'conversations', 'state.json'), 'utf-8')) as {
      conversations?: Record<string, { workRuns?: Array<{ runId: string; status: string }> }>;
    };
    return Object.values(state.conversations || {}).flatMap(conversation => conversation.workRuns || []);
  });
  assert.strictEqual(persistedRuns.length, receipts.length, 'every automation Build is durable in its workspace conversation state');
  assert.strictEqual(new Set(persistedRuns.map(run => run.runId)).size, receipts.length, 'durable Build IDs remain unique');
  assert.ok(persistedRuns.every(run => run.status === 'completed'), 'all durable stress Builds reach completed state');

  return {
    schedules: schedules.length + 2,
    triggers: receipts.length,
    uniqueBuildRuns: new Set(receipts.map(receipt => receipt.runId)).size,
    newConversations: new Set(newReceipts.map(receipt => receipt.conversationId)).size,
    existingTriggers: existingReceipts.length,
    liveTimerTriggers: 8,
    overlappingTicks: 40,
    persistedBuildRuns: persistedRuns.length,
  };
}

async function runPtyRoundTrip(workspace: string, index: number): Promise<void> {
  const marker = `PTY_STRESS_${index}_${randomUUID().slice(0, 8)}`;
  const pty = spawnTakeoverPty(
    { exe: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] },
    workspace,
    { ...process.env, TERM: 'xterm-256color' },
    100,
    24,
  );
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`PTY ${index} timed out: ${output.slice(-500)}`)), 10_000);
    const dataSubscription = pty.onData(data => {
      output += data;
      if (!output.includes(marker)) return;
      clearTimeout(timeout);
      dataSubscription.dispose();
      pty.kill();
      resolve();
    });
    pty.onExit(event => {
      if (!output.includes(marker)) {
        clearTimeout(timeout);
        reject(new Error(`PTY ${index} exited ${event.exitCode} before marker: ${output.slice(-500)}`));
      }
    });
    pty.write(`Write-Output '${marker}'\r`);
  });
}

async function stressBash(root: string): Promise<Record<string, unknown>> {
  const workspace = path.join(root, 'bash-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const sessions = Array.from({ length: 16 }, () => new NativeBashSession(workspace, 10_000));
  await Promise.all(sessions.map(async (session, sessionIndex) => {
    const init = await session.execute(`mkdir -p session-${sessionIndex}; cd session-${sessionIndex}`);
    assert.strictEqual(init.exitCode, 0);
    for (let commandIndex = 0; commandIndex < 20; commandIndex += 1) {
      const result = await session.execute(`printf '%s\\n' '${sessionIndex}:${commandIndex}' >> log.txt; tail -n 1 log.txt`);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout.trim(), `${sessionIndex}:${commandIndex}`);
    }
    assert.strictEqual(session.getCwd(), `/session-${sessionIndex}`);
  }));
  for (let index = 0; index < sessions.length; index += 1) {
    const lines = fs.readFileSync(path.join(workspace, `session-${index}`, 'log.txt'), 'utf-8').trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 20);
  }

  const oneShotResults = await Promise.all(Array.from({ length: 64 }, async (_, index) => {
    return executeWorkspaceBash(`printf '%s' '${index}' > oneshot-${index}.txt; cat oneshot-${index}.txt`, workspace, {
      allowHostFallback: false,
      timeoutMs: 10_000,
    });
  }));
  assert.ok(oneShotResults.every((result, index) => result.exitCode === 0 && result.stdout === String(index)));

  const cancellations = await Promise.all(Array.from({ length: 12 }, async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15).unref();
    return executeWorkspaceBash('sleep 2; echo late', workspace, {
      allowHostFallback: false,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
  }));
  assert.ok(cancellations.every(result => result.aborted && !result.stdout.includes('late')));

  const fallback = await executeWorkspaceBash('git --version', workspace, { allowHostFallback: true, timeoutMs: 10_000 });
  assert.strictEqual(fallback.engine, 'host-shell');
  assert.strictEqual(fallback.exitCode, 0);
  assert.match(fallback.output, /git version/i);

  await Promise.all(Array.from({ length: 4 }, (_, index) => runPtyRoundTrip(workspace, index)));

  return {
    nativeSessions: sessions.length,
    sessionCommands: sessions.length * 20,
    parallelOneShots: oneShotResults.length,
    cancellations: cancellations.length,
    hostFallback: fallback.engine,
    realPtySessions: 4,
  };
}

async function stressContextModelSwitches(root: string): Promise<Record<string, unknown>> {
  const runtimeRoot = path.join(root, 'context-switch-runtime');
  const workspacePath = path.join(root, 'context-switch-workspace');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  const agent = new Agent(runtimeRoot, { agentOnly: true, workspaceRegistryMode: 'detached' });
  agent.workspace.current = {
    id: 'context-switch-workspace', name: 'context-switch-workspace', path: workspacePath,
    isInternal: false, kind: 'local', hostBinding: '', icon: '',
  };
  agent.setConversation('context-switch-stress');
  agent.config.set('context', 'auto_compress', true);
  agent.config.set('context', 'keep_recent_messages', 10);
  agent.config.upsertProvider('context-switch-provider', 'https://context-switch.invalid/v1', 'stress-key');
  const windows = [64_000, 8_000, 4_000, 2_000, 1_200];
  windows.forEach(size => {
    const name = `context-${size}`;
    agent.config.addModelToProvider('context-switch-provider', name, name, `Stress context ${size}`);
    agent.config.updateModel('context-switch-provider', name, { max_tokens: size });
  });
  agent.config.save();

  let providerCalls = 0;
  const stressProvider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 256 }),
    chat: async () => {
      providerCalls += 1;
      if (providerCalls % 7 === 0) return '[LLM Error: 503] injected segmented compression failure';
      return `## Active Or Unfinished Work\nContext switch segment ${providerCalls}; preserve the latest task.\n${'c'.repeat(700)}`;
    },
  };
  (agent as unknown as { forcedProvider: unknown }).forcedProvider = stressProvider;

  let totalRounds = 0;
  let totalSegments = 0;
  let totalDropped = 0;
  let compressedSwitches = 0;
  let concurrentRequests = 0;
  let finalTargetWindow = 0;
  for (let cycle = 0; cycle < 18; cycle += 1) {
    agent.setModel('context-64000');
    const marker = `LATEST_CONTEXT_SWITCH_TASK_${cycle}`;
    agent.history = Array.from({ length: 36 + (cycle % 5) * 6 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${index === 34 ? marker : `cycle-${cycle}-history-${index}`} ${'h'.repeat(900 + (index % 4) * 230)}`,
    }));
    agent.history.push({ role: 'user', content: `${marker} final authoritative instruction` });
    const targetWindow = windows[1 + (cycle % (windows.length - 1))];
    finalTargetWindow = targetWindow;
    agent.setModel(`context-${targetWindow}`);
    const parallel = Array.from({ length: 6 }, () => agent.compressForModelSwitch());
    concurrentRequests += parallel.length;
    const results = await Promise.all(parallel);
    const result = results[0];
    assert.ok(results.every(item => JSON.stringify(item) === JSON.stringify(result)), 'concurrent switch requests share one compression result');
    assert.ok(result.estimatedTokens <= Math.floor(targetWindow * 0.7), 'short-model history converges below the safe target budget');
    assert.ok(JSON.stringify(agent.history).includes(marker), 'latest user instruction survives every long-to-short switch');
    assert.ok(result.rounds <= 8, 'segmented compression terminates within the bounded merge rounds');
    if (result.compressed) compressedSwitches += 1;
    totalRounds += result.rounds;
    totalSegments += result.segments;
    totalDropped += result.droppedMessages;
    agent.flushConversationState();
  }

  const statePath = path.join(workspacePath, 'conversations', 'state.json');
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
    conversations?: Record<string, { history?: Array<Record<string, unknown>> }>;
  };
  const entry = Object.values(persisted.conversations || {}).find(item => Array.isArray(item.history) && item.history.length > 0);
  const persistedTokens = agent.estimateContextTokens(entry?.history || []);
  assert.ok(entry, 'context-switch stress persists the compressed conversation');
  assert.ok(persistedTokens > 0 && persistedTokens <= Math.floor(finalTargetWindow * 0.7), 'persisted final short-model history remains inside its 70% budget');
  assert.ok(JSON.stringify(entry?.history || []).includes('LATEST_CONTEXT_SWITCH_TASK_17'), 'persisted recovery state retains the latest authoritative instruction');

  return {
    cycles: 18,
    windowSizes: windows,
    concurrentRequests,
    compressedSwitches,
    providerCalls,
    injectedFailures: Math.floor(providerCalls / 7),
    totalRounds,
    totalSegments,
    droppedMessages: totalDropped,
    finalTargetWindow,
    persistedTokens,
  };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-automation-bash-stress-'));
  const startedAt = Date.now();
  try {
    const automation = await stressAutomations(root);
    const contextSwitch = await stressContextModelSwitches(root);
    const bash = await stressBash(root);
    const report = {
      ok: true,
      tempRoot: root,
      durationMs: Date.now() - startedAt,
      automation,
      contextSwitch,
      bash,
    };
    fs.writeFileSync(path.join(root, 'stress-report.json'), JSON.stringify(report, null, 2), 'utf-8');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`Stress artifacts retained at: ${root}`);
    throw error;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
