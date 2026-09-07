const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Agent } = require('../dist/core/agent');
const checks = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  const agent = Object.create(Agent.prototype);
  agent.activeProcessAbortController = new AbortController();
  agent.lastRouteDecision = { retryBudgetMs: 1500 };
  agent.lastRouteRetryDelayMs = 1200;
  return agent;
}
async function check(name, test) {
  try { await test(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: String(error) }); }
  console.log(`${checks.at(-1).passed ? 'PASS' : 'FAIL'} ${name}`);
}
(async () => {
  for (const explicit of [true, false]) await check(`${explicit ? 'empty-response' : 'planned-route'} backoff aborts promptly`, async () => {
    const agent = fixture();
    let settled = false, outcome;
    const started = Date.now();
    const pending = agent.waitForPlannedRouteRetry(explicit ? 1200 : undefined).then(
      () => { settled = true; outcome = 'resolved'; },
      error => { settled = true; outcome = error.name; });
    await pause(20);
    agent.activeProcessAbortController.abort();
    await Promise.race([pending, pause(180)]);
    const elapsed = Date.now() - started;
    // Let the original bounded timer finish even for the red baseline.
    await pending;
    assert.ok(settled && elapsed < 180 && outcome === 'AbortError', JSON.stringify({ elapsed, outcome }));
    if (!explicit) assert.equal(agent.lastRouteRetryDelayMs, 0);
  });
  await check('an already stopped Build cannot start even a zero-delay retry', async () => {
    const agent = fixture(); agent.activeProcessAbortController.abort();
    await assert.rejects(agent.waitForPlannedRouteRetry(0), { name: 'AbortError' });
  });
  await check('normal wait completes and the next Build has an independent cancellation owner', async () => {
    const agent = fixture(), old = agent.activeProcessAbortController;
    const started = Date.now(); await agent.waitForPlannedRouteRetry(30);
    assert.ok(Date.now() - started >= 20);
    agent.activeProcessAbortController = new AbortController(); old.abort();
    await agent.waitForPlannedRouteRetry(1);
  });
  await check('cancelling an in-flight wait remains bound to its original Build', async () => {
    const agent = fixture(), old = agent.activeProcessAbortController;
    const pending = agent.waitForPlannedRouteRetry(1200);
    agent.activeProcessAbortController = new AbortController();
    old.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(agent.activeProcessSignal().aborted, false);
  });
  const report = { at: new Date().toISOString(), checks, passed: checks.every(c => c.passed) };
  if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(report, null, 2) + '\n');
  console.log(`${checks.filter(c => c.passed).length}/${checks.length} retry cancellation cases passed`);
  if (!report.passed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
