/**
 * Packaged-build replacement for the source-only runtime probe
 * (`src/core/memoryProbe.ts`).
 *
 * `scripts/build-conversation-utility-host.cjs --strip-diagnostics` resolves the
 * probe import to this module, so a shipped bundle contains no sampling, no
 * heap-snapshot capability, no probe file path and no probe naming. Only the
 * neutral no-op hook surface remains, and the probe implementation itself stays
 * in source for diagnostics builds.
 */

export interface HostRuntimeHooksOptions {
  /** Runtime root used when no explicit probe output is configured. */
  root: string;
  intervalMs?: number;
  snapshotRssMiB?: number;
}

export interface HostRuntimeHooks {
  enabled: boolean;
  countPosted(value: unknown): void;
  stop(): void;
}

export function installHostRuntimeHooks(_options: HostRuntimeHooksOptions): HostRuntimeHooks {
  return { enabled: false, countPosted() {}, stop() {} };
}
