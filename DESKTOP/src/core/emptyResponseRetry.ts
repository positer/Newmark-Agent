export const EMPTY_RESPONSE_RETRY_DELAYS_MS = [200, 800, 2_000, 10_000, 60_000] as const;

/**
 * A retry is scheduled only after an explicit provider empty-response
 * failure. The initial failed request is not called a retry, so five retries
 * means six consecutive explicit failures before termination.
 */
export const MAX_EMPTY_RESPONSE_RETRIES = EMPTY_RESPONSE_RETRY_DELAYS_MS.length;
export const MAX_CONSECUTIVE_EMPTY_RESPONSES = MAX_EMPTY_RESPONSE_RETRIES + 1;

export function emptyResponseRetryDelayMs(consecutiveEmptyResponses: number): number {
  return EMPTY_RESPONSE_RETRY_DELAYS_MS[Math.max(0, consecutiveEmptyResponses - 1)] ?? 0;
}

export interface EmptyResponseRetryState {
  consecutiveEmptyResponses: number;
  retry: boolean;
  terminate: boolean;
}

export function observeEmptyResponseOutcome(
  consecutiveEmptyResponses: number,
  emptyResponse: boolean,
): EmptyResponseRetryState {
  const nextCount = emptyResponse ? consecutiveEmptyResponses + 1 : 0;
  return {
    consecutiveEmptyResponses: nextCount,
    retry: emptyResponse && nextCount <= MAX_EMPTY_RESPONSE_RETRIES,
    terminate: emptyResponse && nextCount > MAX_EMPTY_RESPONSE_RETRIES,
  };
}
