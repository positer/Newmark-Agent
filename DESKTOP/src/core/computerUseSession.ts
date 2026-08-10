/**
 * Process-wide Computer-Use session state.
 *
 * The state is keyed by conversation runtime, not by Build/run id. A Build may finish
 * or be interrupted/replaced while the conversation keeps its
 * Computer-Use switch and lease. Only an explicit stop/toggle-off or runtime
 * teardown releases it.
 */
export interface ComputerUseSessionScope {
  runtimeKey: string;
  ownerLabel: string;
  workspacePath?: string;
}

export interface ComputerUseSessionState {
  runtimeKey: string;
  enabled: boolean;
  occupied: boolean;
  ownerLabel?: string;
  updatedAt?: number;
}

interface ComputerUseLease extends ComputerUseSessionScope {
  updatedAt: number;
}

export const COMPUTER_USE_OCCUPIED_MARKER = 'computerUse occupied';
export const COMPUTER_USE_LOCK_TTL_MS = 10 * 60 * 1000;

export class ComputerUseSessionRegistry {
  private readonly enabledByRuntime = new Map<string, boolean>();
  private activeLease: ComputerUseLease | null = null;

  constructor(private readonly ttlMs = COMPUTER_USE_LOCK_TTL_MS) {}

  authorize(action: string, scope: ComputerUseSessionScope, dryRun = false): string | null {
    const normalizedAction = String(action || '').trim().toLowerCase();
    const runtimeKey = String(scope.runtimeKey || '').trim() || 'conversation:default';
    const now = Date.now();
    this.clearExpired(now);
    if (this.activeLease && this.activeLease.runtimeKey !== runtimeKey) {
      return this.occupiedError(normalizedAction, scope.ownerLabel, this.activeLease.ownerLabel);
    }
    if (normalizedAction === 'takeover_stop') return null;
    const enabled = this.enabledByRuntime.get(runtimeKey) !== false;
    const readOnly = normalizedAction === 'observe' || normalizedAction === 'app_list' || normalizedAction === 'app_observe' || normalizedAction === 'wait';
    if (!enabled && !readOnly && !dryRun && normalizedAction !== 'takeover_start') {
      return JSON.stringify({
        ok: false,
        action: normalizedAction,
        error: `ComputerUse is disabled for ${scope.ownerLabel}. Enable ComputerUse for this conversation before sending desktop operations.`,
        computer_use_enabled: false,
        requested_owner: scope.ownerLabel,
      }, null, 2);
    }
    if (normalizedAction === 'takeover_start') this.enabledByRuntime.set(runtimeKey, true);
    if (!this.activeLease) {
      this.activeLease = { ...scope, runtimeKey, updatedAt: now };
    } else {
      this.activeLease.updatedAt = now;
    }
    return null;
  }

  complete(action: string, scope: ComputerUseSessionScope): void {
    const normalizedAction = String(action || '').trim().toLowerCase();
    const runtimeKey = String(scope.runtimeKey || '').trim() || 'conversation:default';
    if (normalizedAction === 'takeover_stop') {
      if (!this.activeLease || this.activeLease.runtimeKey === runtimeKey) this.activeLease = null;
      this.enabledByRuntime.set(runtimeKey, false);
      return;
    }
    if (this.activeLease?.runtimeKey === runtimeKey) this.activeLease.updatedAt = Date.now();
  }

  setEnabled(scope: ComputerUseSessionScope, enabled: boolean): { ok: true; state: ComputerUseSessionState } | { ok: false; error: string; state: ComputerUseSessionState } {
    const runtimeKey = String(scope.runtimeKey || '').trim() || 'conversation:default';
    this.clearExpired();
    if (this.activeLease && this.activeLease.runtimeKey !== runtimeKey) {
      return { ok: false, error: this.occupiedError('toggle', scope.ownerLabel, this.activeLease.ownerLabel), state: this.state(runtimeKey) };
    }
    this.enabledByRuntime.set(runtimeKey, enabled !== false);
    if (enabled === false && this.activeLease?.runtimeKey === runtimeKey) this.activeLease = null;
    return { ok: true, state: this.state(runtimeKey) };
  }

  state(runtimeKey: string): ComputerUseSessionState {
    const key = String(runtimeKey || '').trim() || 'conversation:default';
    this.clearExpired();
    const lease = this.activeLease;
    return {
      runtimeKey: key,
      enabled: this.enabledByRuntime.get(key) !== false,
      occupied: !!lease,
      ...(lease ? { ownerLabel: lease.ownerLabel, updatedAt: lease.updatedAt } : {}),
    };
  }

  cancelTarget(runtimeKey: string): boolean {
    const key = String(runtimeKey || '').trim();
    if (!key) return false;
    const hadActiveLease = this.activeLease?.runtimeKey === key;
    if (hadActiveLease) this.activeLease = null;
    this.enabledByRuntime.set(key, false);
    return hadActiveLease;
  }

  private clearExpired(now = Date.now()): void {
    if (this.activeLease && now - this.activeLease.updatedAt > this.ttlMs) {
      this.activeLease = null;
    }
  }

  private occupiedError(action: string, requestedOwner: string, activeOwner: string): string {
    return JSON.stringify({
      ok: false,
      action,
      error: `${COMPUTER_USE_OCCUPIED_MARKER}: ComputerUse is already active in ${activeOwner}. Stop it with computer_use takeover_stop or wait before another conversation takes control.`,
      lock_owner: activeOwner,
      requested_owner: requestedOwner,
    }, null, 2);
  }
}

export const defaultComputerUseSessionRegistry = new ComputerUseSessionRegistry();
