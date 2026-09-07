'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : '';
const target = path.resolve(__dirname, '../dist/providers/provider-headers.js');
let headerModule;
if (option('--source')) {
  const ts = require('typescript'), Module = require('node:module');
  const compiled = new Module(target, module); compiled.filename = target; compiled.paths = Module._nodeModulePaths(path.dirname(target));
  compiled._compile(ts.transpileModule(fs.readFileSync(path.resolve(option('--source')), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, target);
  headerModule = compiled.exports;
} else headerModule = require(target);
const { headerGet, normalizeProviderHeaders, filterRequestHeadersForDiagnostics } = headerModule;
const fixedNow = 1700000000000, originalNow = Date.now;
const checks = [];
const check = (name, fn) => { try { fn(); checks.push({ name, passed: true }); } catch (error) { checks.push({ name, passed: false, error: error.stack || String(error) }); } };
const normalize = normalizeProviderHeaders;
const iso = millis => new Date(millis).toISOString();
try {
  Date.now = () => fixedNow;
  check('record header names are case insensitive', () => assert.equal(headerGet({ 'X-Request-ID': 'request-record' }, 'x-request-id'), 'request-record'));
  check('native Headers are supported', () => assert.equal(normalize(new Headers({ 'X-Request-ID': 'request-native', 'Retry-After': '2' })).retryAfterSeconds, 2));
  check('structural get object is supported without instanceof Headers', () => {
    const values = new Map([['x-request-id', 'request-structural'], ['retry-after', '2.5']]);
    const headers = Object.create({ get(name) { return values.get(name.toLowerCase()) ?? null; } });
    assert.deepEqual(normalize(headers), { requestId: 'request-structural', retryAfterSeconds: 2.5 });
  });
  check('a malformed or throwing structural get does not break metadata parsing', () => assert.equal(headerGet({ get() { throw Error('inaccessible'); }, 'X-Request-ID': 'record-fallback' }, 'x-request-id'), 'record-fallback'));
  check('non-string record values are ignored', () => assert.equal(headerGet({ 'x-request-id': { secret: 'not-a-header' } }, 'x-request-id'), null));
  check('OpenAI request limit and compound relative duration are normalized', () => assert.deepEqual(normalize({ 'X-RateLimit-Limit-Requests': '60', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1m2s' }).rateLimit, { limit: 60, remaining: 0, resetAt: iso(fixedNow + 62000) }));
  check('OpenAI millisecond duration preserves precision', () => assert.equal(normalize({ 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '3', 'x-ratelimit-reset-requests': '1.5s250ms' }).rateLimit.resetAt, iso(fixedNow + 1750)));
  check('OpenAI hour/day durations retain their units', () => assert.equal(normalize({ 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '3', 'x-ratelimit-reset-requests': '1d2h3m4s' }).rateLimit.resetAt, iso(fixedNow + 93784000)));
  check('Anthropic request limits use their own RFC3339 reset', () => assert.deepEqual(normalize({ 'anthropic-ratelimit-requests-limit': '100', 'anthropic-ratelimit-requests-remaining': '20', 'anthropic-ratelimit-requests-reset': '2026-09-06T15:00:00Z' }).rateLimit, { limit: 100, remaining: 20, resetAt: '2026-09-06T15:00:00.000Z' }));
  check('GitHub X-RateLimit-Reset is UTC epoch seconds, not a relative delay', () => assert.equal(normalize({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1700000000' }).rateLimit.resetAt, iso(fixedNow)));
  check('compatible epoch millisecond reset stays an absolute instant', () => assert.equal(normalize({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1700000060000' }).rateLimit.resetAt, iso(fixedNow + 60000)));
  check('unprefixed RateLimit-Reset numeric delta is relative seconds', () => assert.deepEqual(normalize({ 'RateLimit-Limit': '50', 'RateLimit-Remaining': '10', 'RateLimit-Reset': '60' }).rateLimit, { limit: 50, remaining: 10, resetAt: iso(fixedNow + 60000) }));
  check('limit and remaining never mix distinct provider families', () => assert.equal(normalize({ 'x-ratelimit-limit-requests': '60', 'anthropic-ratelimit-requests-remaining': '20' }).rateLimit, undefined));
  check('invalid higher-priority family allows a complete compatible family', () => assert.equal(normalize({ 'x-ratelimit-limit-requests': 'bad', 'x-ratelimit-remaining-requests': '8', 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '10' }).rateLimit.limit, 100));
  check('zero limit and remaining are real values', () => assert.deepEqual(normalize({ 'x-ratelimit-limit': '0', 'x-ratelimit-remaining': '0' }).rateLimit, { limit: 0, remaining: 0, resetAt: '' }));
  check('negative quotas are invalid metadata', () => assert.equal(normalize({ 'x-ratelimit-limit': '-1', 'x-ratelimit-remaining': '5' }).rateLimit, undefined));
  check('invalid reset leaves a known quota with unknown date', () => assert.equal(normalize({ 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': 'not-a-date' }).rateLimit.resetAt, ''));
  check('extreme reset cannot throw RangeError', () => assert.equal(normalize({ 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '999999999999999999999' }).rateLimit.resetAt, ''));
  check('malformed relative duration is rejected in full', () => assert.equal(normalize({ 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-reset-requests': '1m2s junk' }).rateLimit.resetAt, ''));
  check('Retry-After numeric seconds preserve fractional compatibility', () => assert.equal(normalize({ 'Retry-After': ' 1.25 ' }).retryAfterSeconds, 1.25));
  check('Retry-After HTTP date uses the real remaining wait', () => assert.equal(normalize({ 'Retry-After': new Date(fixedNow + 5000).toUTCString() }).retryAfterSeconds, 5));
  check('past Retry-After dates become zero wait', () => assert.equal(normalize({ 'Retry-After': new Date(fixedNow - 5000).toUTCString() }).retryAfterSeconds, 0));
  check('Retry-After-Ms supports subsecond precision', () => assert.equal(normalize({ 'Retry-After-Ms': '125.5' }).retryAfterSeconds, 0.1255));
  check('valid millisecond header has priority over coarse seconds', () => assert.equal(normalize({ 'Retry-After-Ms': '1250', 'Retry-After': '2' }).retryAfterSeconds, 1.25));
  check('zero milliseconds is not mistaken for absent metadata', () => assert.equal(normalize({ 'Retry-After-Ms': '0', 'Retry-After': '2' }).retryAfterSeconds, 0));
  check('invalid milliseconds falls back to a valid standard header', () => assert.equal(normalize({ 'Retry-After-Ms': 'invalid', 'Retry-After': '2' }).retryAfterSeconds, 2));
  check('negative Retry-After is not parsed as an arbitrary calendar date', () => assert.equal(normalize({ 'Retry-After': '-1' }).retryAfterSeconds, undefined));
  check('infinite Retry-After metadata is ignored', () => assert.equal(normalize({ 'Retry-After': '9'.repeat(400) }).retryAfterSeconds, undefined));
  check('HTTP cache hit cannot fabricate LLM cached tokens or a prompt hit rate', () => {
    const result = normalize({ 'CF-Cache-Status': 'HIT', 'x-cache-read-tokens': '9999', 'x-cache-hit-rate': '100%' });
    assert.deepEqual(result, { cacheState: 'hit' });
  });
  check('safe diagnostic allowlist retains supported rate headers and drops secrets', () => {
    const result = filterRequestHeadersForDiagnostics({ 'X-Request-ID': 'r', 'X-RateLimit-Limit-Requests': '60', 'anthropic-ratelimit-requests-reset': '2026-09-06T15:00:00Z', 'Retry-After-Ms': '20', Authorization: 'SECRET', Cookie: 'SECRET', 'Set-Cookie': 'SECRET', 'X-Api-Key': 'SECRET', 'unknown-debug-header': 'SECRET' });
    assert.equal(result['X-RateLimit-Limit-Requests'], '60'); assert.equal(result['Retry-After-Ms'], '20');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  });
  check('structural headers are filtered using only the safe allowlist', () => {
    const values = { authorization: 'SECRET', 'x-request-id': 'r', 'retry-after-ms': '20' };
    assert.deepEqual(filterRequestHeadersForDiagnostics({ get: name => values[name.toLowerCase()] ?? null }), { 'x-request-id': 'r', 'retry-after-ms': '20' });
  });
} finally { Date.now = originalNow; }
const result = { passed: checks.every(check => check.passed), checks, boundary: 'Deterministic header containers and clock, no provider requests; optional source transpilation is explicitly selected.' };
if (option('--output')) fs.writeFileSync(path.resolve(option('--output')), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ passed: result.passed, passedChecks: checks.filter(check => check.passed).length, failedChecks: checks.filter(check => !check.passed).length }));
if (!result.passed) process.exitCode = 1;
