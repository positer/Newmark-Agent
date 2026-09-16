import { totalmem } from 'node:os';

/** Physical RAM policy; never evicts an active run or changes model context. */
export function runtimeMemoryBudget(totalBytes = totalmem()): { maxResidentRuntimes: number; idleTtlMs: number } {
  const constrained = !Number.isFinite(totalBytes) || totalBytes <= 8 * 1024 ** 3;
  return constrained
    ? { maxResidentRuntimes: 2, idleTtlMs: 30_000 }
    : { maxResidentRuntimes: 8, idleTtlMs: 300_000 };
}
