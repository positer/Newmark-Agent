import assert from 'node:assert/strict';
import { runtimeMemoryBudget } from '../core/runtimeMemoryBudget';

for (const gib of [2, 4, 7.8, 8]) {
  assert.deepEqual(runtimeMemoryBudget(gib * 1024 ** 3), { maxResidentRuntimes: 2, idleTtlMs: 30_000 });
}
for (const gib of [12, 16, 32]) {
  assert.deepEqual(runtimeMemoryBudget(gib * 1024 ** 3), { maxResidentRuntimes: 8, idleTtlMs: 300_000 });
}
assert.equal(runtimeMemoryBudget(NaN).maxResidentRuntimes, 2);
console.log('Runtime memory budget: 8 boundary cases passed.');
