import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type RuntimeLifecycleRole = 'main' | 'utility' | 'wsl';

export interface RuntimeLifecycleState {
  role: RuntimeLifecycleRole;
  ownerId: string;
  pid: number;
  startedAt: string;
  previousOwnerAlive: boolean;
  unexpectedExit: boolean;
  active: true;
}

const processStates = new Map<string, RuntimeLifecycleState>();

function stateKey(root: string, role: RuntimeLifecycleRole): string {
  return `${path.resolve(root)}\u0000${role}`;
}

function statePath(root: string, role: RuntimeLifecycleRole, ownerId = ''): string {
  return path.join(root, '.newmark-runtime', ownerId ? `lifecycle-${role}-${ownerId}.json` : `lifecycle-${role}.json`);
}

function readState(file: string): Partial<RuntimeLifecycleState> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<RuntimeLifecycleState>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function isRuntimeProcessAlive(pid: number): boolean {
  const candidate = Math.floor(Number(pid) || 0);
  if (candidate <= 0) return false;
  try {
    process.kill(candidate, 0);
    return true;
  } catch {
    return false;
  }
}

function writeState(root: string, role: RuntimeLifecycleRole, state: RuntimeLifecycleState | Record<string, unknown>): void {
  const ownerId = typeof state.ownerId === 'string' ? state.ownerId : '';
  const file = statePath(root, role, ownerId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(temporary, file);
}

function readActiveStates(root: string, role: RuntimeLifecycleRole): Array<Partial<RuntimeLifecycleState>> {
  const directory = path.join(root, '.newmark-runtime');
  try {
    const prefix = `lifecycle-${role}`;
    return fs.readdirSync(directory)
      .filter(file => file.startsWith(prefix) && file.endsWith('.json'))
      .map(file => readState(path.join(directory, file)))
      .filter((state): state is Partial<RuntimeLifecycleState> => !!state && state.active === true);
  } catch {
    return [];
  }
}

/**
 * Claim this process/role as the current runtime owner.
 *
 * A frontend cold runner in the same process gets the same in-memory claim and
 * therefore does not look like a restart. A genuinely new process sees the
 * previous active claim and can pause orphaned Goal/Flow state once.
 */
export function beginRuntimeLifecycle(root: string, role: RuntimeLifecycleRole = 'main'): RuntimeLifecycleState {
  const key = stateKey(root, role);
  const existingProcessState = processStates.get(key);
  if (existingProcessState) return existingProcessState;
  const previousStates = readActiveStates(root, role);
  const previousOwnerAlive = previousStates.some(previous => isRuntimeProcessAlive(Number(previous.pid)));
  const state: RuntimeLifecycleState = {
    role,
    ownerId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    previousOwnerAlive,
    unexpectedExit: previousStates.length > 0 && !previousOwnerAlive,
    active: true,
  };
  try {
    writeState(root, role, state);
  } catch {
    // Recovery remains conservative when the marker cannot be written. The
    // persisted WorkRun timestamp still protects a live backend cold read.
  }
  processStates.set(key, state);
  return state;
}

/** Mark only this owner clean; a hard kill leaves the active marker intact. */
export function markRuntimeLifecycleClean(root: string, role: RuntimeLifecycleRole = 'main'): void {
  const key = stateKey(root, role);
  const current = processStates.get(key);
  if (!current) return;
  try {
    writeState(root, role, {
      ...current,
      active: false,
      cleanExitAt: new Date().toISOString(),
    });
  } catch {
    // Leaving the marker active is safer than claiming a clean exit after a
    // failed durable write.
  }
}

export function runtimeLifecycleState(root: string, role: RuntimeLifecycleRole = 'main'): RuntimeLifecycleState | null {
  return processStates.get(stateKey(root, role)) || null;
}
