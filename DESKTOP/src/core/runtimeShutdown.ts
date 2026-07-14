export interface RuntimeShutdownBarrierOptions {
  operations: Array<Promise<unknown> | undefined>;
  shutdownHelpers: () => Promise<unknown>;
}

export interface RuntimeShutdownBarrierResult {
  operationResults: PromiseSettledResult<unknown>[];
}

/**
 * Wait for every bounded runtime cleanup to settle. Helper shutdown never
 * races an uncancelled runtime operation that could create another helper.
 */
export async function runRuntimeShutdownBarrier(
  options: RuntimeShutdownBarrierOptions,
): Promise<RuntimeShutdownBarrierResult> {
  const operations = options.operations.map(operation => operation || Promise.resolve());
  const operationResults = await Promise.allSettled(operations);
  const failures: Error[] = [];
  for (const result of operationResults) {
    if (result.status === 'rejected') {
      failures.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
    }
  }

  try {
    await options.shutdownHelpers();
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  }

  if (failures.length) throw new AggregateError(failures, 'Runtime shutdown barrier completed with failures');
  return { operationResults };
}
