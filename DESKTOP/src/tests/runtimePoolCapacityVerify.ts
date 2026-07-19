import assert from 'node:assert/strict';
import {
  ElectronTargetRuntimeClient,
  ElectronUtilityRuntimePool,
} from '../core/electronUtilityRuntimePool';
import {
  WslAgentRuntimePool,
  WslTargetRuntimeClient,
} from '../core/wslAgentRuntimePool';
import {
  ConversationRuntimeTarget,
  NormalizedConversationTarget,
  normalizeConversationTarget,
} from '../core/conversationTarget';
import { AgentWorkEvent } from '../core/types';
import { UtilityAgentSnapshotResult } from '../core/utilityAgentProtocol';

function target(id: string): ConversationRuntimeTarget {
  return {
    workspaceId: `workspace-${id}`,
    conversationId: `conversation-${id}`,
    workspace: {
      id: `workspace-${id}`,
      name: `Workspace ${id}`,
      path: `C:\\work\\${id}`,
      isInternal: false,
    },
  };
}

class CapacityTracker {
  resident = 0;
  maxResident = 0;

  created(): void {
    this.resident += 1;
    this.maxResident = Math.max(this.maxResident, this.resident);
  }

  stopped(): void {
    this.resident -= 1;
  }
}

class CapacityElectronClient implements ElectronTargetRuntimeClient {
  readonly listeners = new Set<(event: AgentWorkEvent) => void>();
  running = false;
  stops = 0;
  private connected = true;

  constructor(
    private readonly targetInfo: NormalizedConversationTarget,
    private readonly tracker: CapacityTracker,
  ) {
    tracker.created();
  }

  subscribe(listener: (event: AgentWorkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setHostToolHandler(): void {}
  async prompt(): Promise<never> { throw new Error('unused'); }
  async rewind(): Promise<never> { throw new Error('unused'); }
  async requestStop(): Promise<never> { throw new Error('unused'); }
  async enqueueGuide(): Promise<never> { throw new Error('unused'); }
  async checkpoint(): Promise<Record<string, unknown>> { return {}; }
  async setWorkRunExpanded(): Promise<boolean> { return true; }
  async updateSetting(): Promise<void> {}
  async forceRestart(): Promise<void> {}
  async forceStop(): Promise<void> { await this.stop(); }

  async snapshot(): Promise<UtilityAgentSnapshotResult> {
    return {
      target: this.targetInfo,
      runtime: this.running ? {
        target: this.targetInfo,
        workspaceKey: this.targetInfo.workspaceKey,
        runtimeKey: this.targetInfo.runtimeKey,
        runId: `run-${this.targetInfo.conversationId}`,
        generation: 1,
        running: true,
        stopRequested: false,
        workRuns: [],
      } : null,
      queued: { steering: [], followUp: [] },
      workEvents: [],
    };
  }

  async stop(): Promise<void> {
    this.stops += 1;
    if (this.connected) {
      this.connected = false;
      this.tracker.stopped();
    }
  }

  status(): {
    enabled: true;
    connected: boolean;
    pid: number;
    error: string;
    runtimeKey: string;
  } {
    return {
      enabled: true,
      connected: this.connected,
      pid: this.connected ? 100 : 0,
      error: '',
      runtimeKey: this.targetInfo.runtimeKey,
    };
  }
}

class CapacityWslClient implements WslTargetRuntimeClient {
  readonly listeners = new Set<(event: AgentWorkEvent) => void>();
  running = false;
  stops = 0;
  private connected = true;

  constructor(
    private readonly targetInfo: NormalizedConversationTarget,
    private readonly tracker: CapacityTracker,
  ) {
    tracker.created();
  }

  subscribe(listener: (event: AgentWorkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setHostToolHandler(): void {}
  async prompt(): Promise<never> { throw new Error('unused'); }
  async rewind(): Promise<never> { throw new Error('unused'); }
  async requestStop(): Promise<never> { throw new Error('unused'); }
  async enqueueGuide(): Promise<never> { throw new Error('unused'); }
  async checkpoint(): Promise<Record<string, unknown>> { return {}; }
  async setWorkRunExpanded(): Promise<boolean> { return true; }
  async updateSetting(): Promise<void> {}
  async forceRestartRuntimeGroup(): Promise<void> {}

  async snapshotTarget(): Promise<Record<string, unknown>> {
    return {
      target: this.targetInfo,
      runtime: this.running ? {
        target: this.targetInfo,
        workspaceKey: this.targetInfo.workspaceKey,
        runtimeKey: this.targetInfo.runtimeKey,
        runId: `run-${this.targetInfo.conversationId}`,
        generation: 1,
        running: true,
        stopRequested: false,
        workRuns: [],
      } : null,
      queued: { steering: [], followUp: [] },
      workEvents: [],
    };
  }

  async stop(): Promise<void> {
    this.stops += 1;
    if (this.connected) {
      this.connected = false;
      this.tracker.stopped();
    }
  }

  status(): { enabled: true; connected: boolean; distro: string; pid: number; error: string } {
    return {
      enabled: true,
      connected: this.connected,
      distro: 'Fake',
      pid: this.connected ? 200 : 0,
      error: '',
    };
  }
}

async function verifyElectronCapacity(): Promise<number> {
  let assertions = 0;
  const tracker = new CapacityTracker();
  const clients = new Map<string, CapacityElectronClient>();
  const pool = new ElectronUtilityRuntimePool('C:\\root', 'utility.js', normalized => {
    const client = new CapacityElectronClient(normalized, tracker);
    clients.set(normalized.runtimeKey, client);
    return client;
  }, { idleTtlMs: 600_000 });
  const a = target('electron-a');
  const b = target('electron-b');
  const c = target('electron-c');
  const d = target('electron-d');
  const e = target('electron-e');

  await pool.snapshot(a);
  await pool.snapshot(b);
  await pool.snapshot(b);
  await pool.snapshot(c);
  assert.equal(clients.get(normalizeConversationTarget(a).runtimeKey)?.stops, 1, 'Electron evicts the least-recently-used idle runtime'); assertions++;
  assert.deepEqual(new Set(pool.runtimeKeys()), new Set([
    normalizeConversationTarget(b).runtimeKey,
    normalizeConversationTarget(c).runtimeKey,
  ]), 'Electron keeps the two most recently used runtimes'); assertions++;
  assert.equal(tracker.maxResident, 2, 'Electron never has more than two resident utility runtimes'); assertions++;
  await Promise.all([pool.snapshot(d), pool.snapshot(e)]);
  assert.equal(pool.runtimeKeys().length, 2, 'concurrent Electron acquisitions remain within the two-runtime capacity'); assertions++;
  assert.equal(tracker.maxResident, 2, 'serialized Electron acquisitions never transiently create a third utility process'); assertions++;
  await pool.stopAll();

  const busyTracker = new CapacityTracker();
  const busyClients = new Map<string, CapacityElectronClient>();
  const busyPool = new ElectronUtilityRuntimePool('C:\\root', 'utility.js', normalized => {
    const client = new CapacityElectronClient(normalized, busyTracker);
    client.running = true;
    busyClients.set(normalized.runtimeKey, client);
    return client;
  }, { idleTtlMs: 600_000 });
  await busyPool.snapshot(a);
  await busyPool.snapshot(b);
  assert.deepEqual(busyPool.peek(c), { resident: false, running: false, stopping: false, connected: false }, 'Electron peek observes a cold target without allocating a third runtime'); assertions++;
  await assert.rejects(
    () => busyPool.snapshot(c),
    (error: unknown) => error instanceof Error
      && (error as Error & { code?: string }).code === 'runtime_pool_capacity'
      && /capacity 2/i.test(error.message),
    'Electron rejects a third runtime when both resident runtimes are active',
  ); assertions++;
  assert.equal(busyPool.runtimeKeys().length, 2, 'Electron capacity rejection does not create a third entry'); assertions++;
  assert.equal(Array.from(busyClients.values()).reduce((sum, client) => sum + client.stops, 0), 0, 'Electron never kills an active runtime to make capacity'); assertions++;
  await busyPool.stopAll();
  return assertions;
}

async function verifyWslCapacity(): Promise<number> {
  let assertions = 0;
  const tracker = new CapacityTracker();
  const clients = new Map<string, CapacityWslClient>();
  const pool = new WslAgentRuntimePool('Fake', 'C:\\root', 'host.js', normalized => {
    const client = new CapacityWslClient(normalized, tracker);
    clients.set(normalized.runtimeKey, client);
    return client;
  }, { idleTtlMs: 600_000 });
  const a = target('wsl-a');
  const b = target('wsl-b');
  const c = target('wsl-c');
  const d = target('wsl-d');
  const e = target('wsl-e');

  await pool.snapshot(a);
  await pool.snapshot(b);
  await pool.snapshot(b);
  await pool.snapshot(c);
  assert.equal(clients.get(normalizeConversationTarget(a).runtimeKey)?.stops, 1, 'WSL evicts the least-recently-used idle runtime'); assertions++;
  assert.deepEqual(new Set(pool.runtimeKeys()), new Set([
    normalizeConversationTarget(b).runtimeKey,
    normalizeConversationTarget(c).runtimeKey,
  ]), 'WSL keeps the two most recently used runtimes'); assertions++;
  assert.equal(tracker.maxResident, 2, 'WSL never has more than two resident process groups'); assertions++;
  await Promise.all([pool.snapshot(d), pool.snapshot(e)]);
  assert.equal(pool.runtimeKeys().length, 2, 'concurrent WSL acquisitions remain within the two-runtime capacity'); assertions++;
  assert.equal(tracker.maxResident, 2, 'serialized WSL acquisitions never transiently create a third process group'); assertions++;
  await pool.stopAll();

  const busyTracker = new CapacityTracker();
  const busyClients = new Map<string, CapacityWslClient>();
  const busyPool = new WslAgentRuntimePool('Fake', 'C:\\root', 'host.js', normalized => {
    const client = new CapacityWslClient(normalized, busyTracker);
    client.running = true;
    busyClients.set(normalized.runtimeKey, client);
    return client;
  }, { idleTtlMs: 600_000 });
  await busyPool.snapshot(a);
  await busyPool.snapshot(b);
  assert.deepEqual(busyPool.peek(c), { resident: false, running: false, stopping: false, connected: false }, 'WSL peek observes a cold target without allocating a third process group'); assertions++;
  await assert.rejects(
    () => busyPool.snapshot(c),
    (error: unknown) => error instanceof Error
      && (error as Error & { code?: string }).code === 'runtime_pool_capacity'
      && /capacity 2/i.test(error.message),
    'WSL rejects a third runtime when both resident runtimes are active',
  ); assertions++;
  assert.equal(busyPool.runtimeKeys().length, 2, 'WSL capacity rejection does not create a third entry'); assertions++;
  assert.equal(Array.from(busyClients.values()).reduce((sum, client) => sum + client.stops, 0), 0, 'WSL never kills an active process group to make capacity'); assertions++;
  await busyPool.stopAll();
  return assertions;
}

async function main(): Promise<void> {
  const assertions = await verifyElectronCapacity() + await verifyWslCapacity();
  console.log(JSON.stringify({ ok: true, assertions }));
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
