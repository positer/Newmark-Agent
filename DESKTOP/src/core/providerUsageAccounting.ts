/** Measured provider counters. Missing values are tracked separately from zero. */
export interface Counter {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Reported {
  input: boolean;
  output: boolean;
  cacheRead: boolean;
  cacheWrite: boolean;
}

export type UsageInput = Partial<Counter> & { reported?: Partial<Reported> };

/** JSON-persistable conversation coverage; totals remain owned by the caller. */
export interface Accounting {
  requests: number;
  inputReportedRequests: number;
  outputReportedRequests: number;
  /** Requests with both input/cache read reported and cache read <= input. */
  cacheReportedRequests: number;
  cacheEligibleInputTokens: number;
  cacheReadTokens: number;
  hasLegacyTotals: boolean;
  lastInputTokens: number | null;
}

/** Retain this handle for all cumulative usage events from one provider request. */
export interface AccountingRequest {
  usage: Counter;
  reported: Reported;
}

const fields: ReadonlyArray<keyof Counter> = ['input', 'output', 'cacheRead', 'cacheWrite'];

export function createAccounting(legacyTotals?: Partial<Counter> | null): Accounting {
  return {
    requests: 0,
    inputReportedRequests: 0,
    outputReportedRequests: 0,
    cacheReportedRequests: 0,
    cacheEligibleInputTokens: 0,
    cacheReadTokens: 0,
    // Old persisted zeros do not establish whether any cache fields were reported.
    hasLegacyTotals: legacyTotals != null,
    lastInputTokens: null,
  };
}

export function beginAccountingRequest(accounting: Accounting): AccountingRequest {
  accounting.requests++;
  return {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reported: { input: false, output: false, cacheRead: false, cacheWrite: false },
  };
}

function validCachePair(request: AccountingRequest): boolean {
  return request.reported.input && request.reported.cacheRead
    && request.usage.cacheRead <= request.usage.input;
}

/**
 * Provider stream usage is cumulative per request, including partial updates.
 * Replacing each reported field contributes only its delta, including negative
 * corrections. Unreported/invalid fields never erase a previous measurement.
 */
export function applyAccountingUsage(
  accounting: Accounting,
  totals: Counter,
  request: AccountingRequest,
  input: UsageInput,
): void {
  const hadInput = request.reported.input;
  const hadOutput = request.reported.output;
  const hadPair = validCachePair(request);
  const previousEligibleInput = hadPair ? request.usage.input : 0;
  const previousEligibleCache = hadPair ? request.usage.cacheRead : 0;

  for (const field of fields) {
    const value = input[field];
    // Older internal callers supply actual numeric fields without metadata.
    // Once metadata exists, only its explicit true flags represent reporting.
    const reported = input.reported === undefined || input.reported[field] === true;
    if (!reported || typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    totals[field] += value - request.usage[field];
    request.usage[field] = value;
    request.reported[field] = true;
    if (field === 'input') accounting.lastInputTokens = value;
  }

  accounting.inputReportedRequests += Number(request.reported.input) - Number(hadInput);
  accounting.outputReportedRequests += Number(request.reported.output) - Number(hadOutput);
  const hasPair = validCachePair(request);
  accounting.cacheReportedRequests += Number(hasPair) - Number(hadPair);
  accounting.cacheEligibleInputTokens += (hasPair ? request.usage.input : 0) - previousEligibleInput;
  accounting.cacheReadTokens += (hasPair ? request.usage.cacheRead : 0) - previousEligibleCache;
}

export function ratioSummary(accounting: Accounting): {
  totalRatio: number | null;
  knownRatio: number | null;
  denominator: number;
} {
  const denominator = accounting.cacheEligibleInputTokens;
  const knownRatio = denominator > 0 ? accounting.cacheReadTokens / denominator : null;
  const complete = !accounting.hasLegacyTotals && accounting.requests > 0
    && accounting.inputReportedRequests === accounting.requests
    && accounting.cacheReportedRequests === accounting.requests;
  return { totalRatio: complete ? knownRatio : null, knownRatio, denominator };
}
