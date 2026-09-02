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
  active: boolean;
}

const processStates = new Map<string, RuntimeLifecycleState>();
const preparedPreviousStates = new Map<string, Array<Partial<RuntimeLifecycleState>>>();
const lifecyclePreparations = new Map<string, Promise<Array<Partial<RuntimeLifecycleState>>>>();

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

/** Prepare crash-recovery markers asynchronously after the startup shell is visible. */
export function prepareRuntimeLifecycle(root: string, role: RuntimeLifecycleRole = 'main'): Promise<void> {
  const key = stateKey(root, role);
  if (processStates.has(key) || preparedPreviousStates.has(key)) return Promise.resolve();
  const current = lifecyclePreparations.get(key);
  if (current) return current.then(() => undefined);
  const preparation = (async (): Promise<Array<Partial<RuntimeLifecycleState>>> => {
    const directory = path.join(root, '.newmark-runtime');
    let files: string[];
    try {
      files = (await fs.promises.readdir(directory))
        .filter(file => file.startsWith(`lifecycle-${role}`) && file.endsWith('.json'));
    } catch {
      return [];
    }
    const active: Array<Partial<RuntimeLifecycleState>> = [];
    for (let offset = 0; offset < files.length; offset += 24) {
      const states = await Promise.all(files.slice(offset, offset + 24).map(async file => {
        const filePath = path.join(directory, file);
        try {
          const state = JSON.parse(await fs.promises.readFile(filePath, 'utf-8')) as Partial<RuntimeLifecycleState>;
          if (state?.active === true) return state;
        } catch {
          // A corrupt marker cannot establish a live owner.
        }
        await fs.promises.unlink(filePath).catch(() => undefined);
        return null;
      }));
      for (const state of states) if (state) active.push(state);
    }
    return active;
  })();
  lifecyclePreparations.set(key, preparation);
  return preparation.then(states => {
    preparedPreviousStates.set(key, states);
  }).finally(() => lifecyclePreparations.delete(key));
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
  const previousStates = preparedPreviousStates.get(key) || readActiveStates(root, role);
  preparedPreviousStates.delete(key);
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
    fs.unlinkSync(statePath(root, role, current.ownerId));
  } catch {
    try {
      writeState(root, role, { ...current, active: false, cleanExitAt: new Date().toISOString() });
    } catch {
      // Leaving the marker active is safer than claiming a clean exit after a
      // failed durable write.
    }
  }
}

/** Parent-side fallback for a worker that died before it could clean its own marker. */
export function markRuntimeLifecycleExitedByPid(
  root: string,
  role: RuntimeLifecycleRole,
  pid: number,
  input: { unexpected: boolean; exitCode?: number | null; error?: string } = { unexpected: true },
): void {
  const directory = path.join(root, '.newmark-runtime');
  let files: string[] = [];
  try {
    files = fs.readdirSync(directory).filter(file => file.startsWith(`lifecycle-${role}-`) && file.endsWith('.json'));
  } catch { return; }
  for (const name of files) {
    const file = path.join(directory, name);
    const state = readState(file);
    if (!state || Number(state.pid) !== Math.floor(Number(pid) || 0) || state.active !== true) continue;
    try {
      writeState(root, role, {
        ...state,
        active: false,
        unexpectedExit: input.unexpected,
        exitedAt: new Date().toISOString(),
        exitCode: input.exitCode,
        error: String(input.error || '').slice(-800),
      });
    } catch {}
  }
}

export function runtimeLifecycleState(root: string, role: RuntimeLifecycleRole = 'main'): RuntimeLifecycleState | null {
  return processStates.get(stateKey(root, role)) || null;
}
