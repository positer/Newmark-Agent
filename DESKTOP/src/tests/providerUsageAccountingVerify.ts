import * as assert from 'node:assert/strict';
import {
  applyAccountingUsage,
  beginAccountingRequest,
  createAccounting,
  ratioSummary,
  type Counter,
} from '../core/providerUsageAccounting';

const counters = (): Counter => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
let assertions = 0;
function equal(actual: unknown, expected: unknown, message: string): void {
  assert.deepEqual(actual, expected, message);
  assertions++;
}

{
  const accounting = createAccounting();
  const totals = counters();
  equal(ratioSummary(accounting), { totalRatio: null, knownRatio: null, denominator: 0 }, 'an empty conversation has no measured cache ratio');
  const request = beginAccountingRequest(accounting);
  equal(accounting.requests, 1, 'a started request counts even if it produces no usage event');
  equal(accounting.lastInputTokens, null, 'an unreported input count is unknown, not zero');
  equal(ratioSummary(accounting).totalRatio, null, 'a request without usage does not invent zero cache');
  applyAccountingUsage(accounting, totals, request, { input: 100, output: 10 });
  equal(totals, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, 'reported input and output are recorded');
  equal([accounting.inputReportedRequests, accounting.outputReportedRequests, accounting.cacheReportedRequests], [1, 1, 0], 'input reporting does not imply cache reporting');
  equal(ratioSummary(accounting).totalRatio, null, 'a missing cache field prevents a total ratio');
  applyAccountingUsage(accounting, totals, request, { cacheRead: 0 });
  equal(ratioSummary(accounting), { totalRatio: 0, knownRatio: 0, denominator: 100 }, 'an explicitly reported zero cache count is a measured zero percent');
  applyAccountingUsage(accounting, totals, request, { input: 100, output: 10, cacheRead: 0 });
  equal(totals, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, 'duplicate cumulative events never double totals');
  equal([accounting.inputReportedRequests, accounting.outputReportedRequests, accounting.cacheReportedRequests], [1, 1, 1], 'duplicate events never double reporting coverage');
  applyAccountingUsage(accounting, totals, request, { input: 160, output: 12, cacheRead: 80, cacheWrite: 20 });
  equal(totals, { input: 160, output: 12, cacheRead: 80, cacheWrite: 20 }, 'a later cumulative event contributes only its delta');
  equal(ratioSummary(accounting), { totalRatio: 0.5, knownRatio: 0.5, denominator: 160 }, 'cache uses actual eligible input, not input plus output');
  applyAccountingUsage(accounting, totals, request, { output: 18 });
  equal(totals, { input: 160, output: 18, cacheRead: 80, cacheWrite: 20 }, 'partial output events do not erase prior input or cache');
  equal(accounting.lastInputTokens, 160, 'a partial output event preserves the last measured input');
  applyAccountingUsage(accounting, totals, request, { input: 120, output: 11, cacheRead: 30, cacheWrite: 5 });
  equal(totals, { input: 120, output: 11, cacheRead: 30, cacheWrite: 5 }, 'a provider correction may lower earlier cumulative values');
  equal(ratioSummary(accounting), { totalRatio: 0.25, knownRatio: 0.25, denominator: 120 }, 'corrected ratios use corrected counts');
}

{
  const accounting = createAccounting();
  const totals = counters();
  const first = beginAccountingRequest(accounting);
  applyAccountingUsage(accounting, totals, first, { input: 100, cacheRead: 50 });
  const second = beginAccountingRequest(accounting);
  equal(ratioSummary(accounting), { totalRatio: null, knownRatio: 0.5, denominator: 100 }, 'a request without usage leaves a known subset but invalidates the full-conversation ratio');
  applyAccountingUsage(accounting, totals, second, { cacheRead: 20 });
  equal(accounting.cacheReportedRequests, 1, 'a cache count without its input is not a complete pair');
  equal(totals.cacheRead, 70, 'reported cache tokens remain real even before their denominator arrives');
  applyAccountingUsage(accounting, totals, second, { input: 50 });
  equal(ratioSummary(accounting), { totalRatio: 70 / 150, knownRatio: 70 / 150, denominator: 150 }, 'late input completes the same request without duplicate cache');
  equal([accounting.requests, accounting.inputReportedRequests, accounting.cacheReportedRequests], [2, 2, 2], 'per-request coverage becomes complete exactly once');
}

{
  const accounting = createAccounting();
  const totals = counters();
  const request = beginAccountingRequest(accounting);
  applyAccountingUsage(accounting, totals, request, { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reported: { input: true } });
  equal(request.reported, { input: true, output: false, cacheRead: false, cacheWrite: false }, 'explicit reporting metadata overrides filled-in zeros');
  equal(ratioSummary(accounting).totalRatio, null, 'normalizer defaults do not become measured cache hits');
  applyAccountingUsage(accounting, totals, request, { input: 0, output: 4, cacheRead: 25, cacheWrite: 0, reported: { output: true, cacheRead: true } });
  equal(totals, { input: 100, output: 4, cacheRead: 25, cacheWrite: 0 }, 'only fields with explicit true reporting flags may update totals');
  equal(ratioSummary(accounting).totalRatio, 0.25, 'a partial explicit report completes an earlier input');
  applyAccountingUsage(accounting, totals, request, { input: NaN, output: -1, cacheRead: Infinity, cacheWrite: undefined, reported: { input: true, output: true, cacheRead: true, cacheWrite: true } });
  equal(totals, { input: 100, output: 4, cacheRead: 25, cacheWrite: 0 }, 'non-finite, negative and absent values are not measurements');
  equal(request.reported.cacheWrite, false, 'a true flag with no numeric value cannot fabricate reporting coverage');
}

{
  const accounting = createAccounting();
  const totals = counters();
  const request = beginAccountingRequest(accounting);
  applyAccountingUsage(accounting, totals, request, { input: 40, cacheRead: 60 });
  equal(totals, { input: 40, output: 0, cacheRead: 60, cacheWrite: 0 }, 'inconsistent upstream counts remain visible in actual totals');
  equal(ratioSummary(accounting), { totalRatio: null, knownRatio: null, denominator: 0 }, 'cache exceeding input is unknown, never clamped to 100 percent');
  applyAccountingUsage(accounting, totals, request, { input: 80 });
  equal(ratioSummary(accounting), { totalRatio: 0.75, knownRatio: 0.75, denominator: 80 }, 'a corrected input may make the same pair valid');
  applyAccountingUsage(accounting, totals, request, { input: 20 });
  equal([accounting.cacheReportedRequests, accounting.cacheEligibleInputTokens, accounting.cacheReadTokens], [0, 0, 0], 'a later inconsistency removes an earlier eligible pair');
  applyAccountingUsage(accounting, totals, request, { cacheRead: 10 });
  equal(ratioSummary(accounting), { totalRatio: 0.5, knownRatio: 0.5, denominator: 20 }, 'another correction restores coverage without losing the request');
}

{
  const accounting = createAccounting();
  const totals = counters();
  const first = beginAccountingRequest(accounting);
  applyAccountingUsage(accounting, totals, first, { input: 100, cacheRead: 80 });
  const second = beginAccountingRequest(accounting);
  applyAccountingUsage(accounting, totals, second, { input: 100, cacheRead: 120 });
  equal(ratioSummary(accounting), { totalRatio: null, knownRatio: 0.8, denominator: 100 }, 'only complete valid requests contribute to the known subset');
  equal(totals.cacheRead, 200, 'exclusion from a ratio does not silently rewrite server accounting');
  const zero = beginAccountingRequest(accounting);
  applyAccountingUsage(accounting, totals, zero, { input: 0, cacheRead: 0 });
  equal(accounting.cacheReportedRequests, 2, 'an explicitly empty input is reported even though it adds no denominator');
  equal(accounting.lastInputTokens, 0, 'a measured zero replaces the prior last input instead of appearing absent');
}

{
  const accounting = createAccounting(counters());
  const totals = counters();
  const request = beginAccountingRequest(accounting);
  applyAccountingUsage(accounting, totals, request, { input: 80, cacheRead: 40 });
  equal(accounting.hasLegacyTotals, true, 'even existing zero legacy totals have unknown historical coverage');
  equal(ratioSummary(accounting), { totalRatio: null, knownRatio: 0.5, denominator: 80 }, 'new measured requests cannot certify unknown historical usage');
  const restored = JSON.parse(JSON.stringify(accounting));
  equal(ratioSummary(restored), ratioSummary(accounting), 'the aggregate snapshot survives JSON persistence');
}

{
  const accounting = createAccounting();
  const totals = counters();
  const request = beginAccountingRequest(accounting);
  applyAccountingUsage(accounting, totals, request, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  equal([accounting.inputReportedRequests, accounting.outputReportedRequests, accounting.cacheReportedRequests], [1, 1, 1], 'legacy internal callers infer explicit zero fields as reported');
  equal(ratioSummary(accounting), { totalRatio: null, knownRatio: null, denominator: 0 }, 'zero divided by zero has no percentage');
}

console.log(JSON.stringify({ ok: true, assertions }));
