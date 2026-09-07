const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const harness = require('./release-real-provider-stress.cjs');

// Importing the harness must not launch Electron, read credentials, or make a
// provider request. All CDP calls below execute its real expressions in this VM.
async function verifyRealProviderStressHarness() {
  const checks = [];
  const check = (name, fn) => { fn(); checks.push({ name, pass: true }); };
  const target = { workspaceId: 'workspace-fixture', conversationId: 'conversation-fixture' };
  const marker = 'NM_STRESS_FIXTURE_OK';
  const prompt = `Reply with this exact marker as the first line: ${marker}\nNo tools.`;
  const titleError = 'Conversation title generation failed; the first Agent request was not started. Retry the first input.';
  const oldRun = { runId: 'old', target, status: 'error', primaryPrompt: prompt, events: [{ type: 'error', content: titleError }] };
  const before = { target, conversationId: target.conversationId, status: 'error', workRuns: [oldRun], chatMessages: [], runtime: { running: false, runId: 'old' } };
  const attempt = harness.capturePromptAttempt(before, target, prompt);
  const state = (changes = {}) => ({
    target, conversationId: target.conversationId, status: 'error',
    workRuns: [oldRun, { ...oldRun, runId: 'new' }],
    chatMessages: [{ role: 'user', runId: 'new', content: prompt }],
    runtime: { running: false, runId: 'new' }, ...changes,
  });
  const classificationCases = [
    ['CLI title failure is not conversation leakage', new Error(`CLI round 1 failed: ${titleError}`), 'conversation-title-failed'],
    ['title gate does not infer the hidden HTTP status', new Error(titleError), 'conversation-title-failed'],
    ['diagnostic title HTTP 503 retains the title phase classification', new Error('Conversation title generation failed; HTTP 503 (get_channel_failed): no provider channel available. The first Agent request was not started. Retry the first input.'), 'conversation-title-failed'],
    ['observed HTTP 503 is a provider HTTP failure', new Error('HTTP 503 Service Unavailable'), 'provider-http-error'],
    ['rate limit remains provider-limit', new Error('HTTP 429 too many requests'), 'provider-limit'],
    ['actual cross-conversation response marker remains leak', new Error('conversation A response contained B marker: NM_STRESS_CONVERSATION_B_OK'), 'conversation-leak'],
    ['actual cross-conversation state marker remains leak', new Error('conversation B state leaked A marker: marker'), 'conversation-leak'],
    ['actual conversation identity mismatch remains leak', new Error('backend send conversation mismatch: B'), 'conversation-leak'],
    ['missing conversation marker does not establish leakage', new Error('conversation A missing marker: empty'), 'app-or-provider-error'],
    ['secret leak is not captured by the word leak', new Error('renderer state leaked API key'), 'secret-leak'],
    ['plain Chinese marker is not an encoding failure', new Error('missing marker 真实_STRESS_CLI_2_OK'), 'app-or-provider-error'],
    ['actual UTF-8 problem keeps its category', new Error('invalid UTF-8 encoding'), 'encoding-error'],
    ['ordinary running text is not a process leak', new Error('run is no longer running'), 'app-or-provider-error'],
    ['actual timeout keeps its category', new Error('Timed out waiting for assistant marker'), 'app-timeout-or-provider-timeout'],
  ];
  for (const [name, error, expected] of classificationCases) check(name, () => assert.equal(harness.classifyFailure(error), expected));
  check('capture excludes prior work and runtime IDs', () => assert.deepEqual(attempt.previousRunIds, ['old']));
  check('old same-prompt error is ignored', () => assert.equal(harness.terminalPromptFailure(before, attempt), null));
  check('new matching title failure is identified', () => assert.equal(harness.terminalPromptFailure(state(), attempt).runId, 'new'));
  check('different conversation is ignored', () => assert.equal(harness.terminalPromptFailure(state({ conversationId: 'other' }), attempt), null));
  check('different workspace is ignored', () => assert.equal(harness.terminalPromptFailure(state({ target: { ...target, workspaceId: 'other' } }), attempt), null));
  check('wrong run target is ignored', () => assert.equal(harness.terminalPromptFailure(state({ workRuns: [{ ...oldRun, runId: 'new', target: { ...target, workspaceId: 'other' } }] }), attempt), null));
  check('old runtime ID cannot terminate a new run', () => assert.equal(harness.terminalPromptFailure(state({ runtime: { running: false, runId: 'old' } }), attempt), null));
  check('running request is not terminal', () => assert.equal(harness.terminalPromptFailure(state({ runtime: { running: true, runId: 'new' } }), attempt), null));
  check('unrelated new prompt is ignored', () => assert.equal(harness.terminalPromptFailure(state({ workRuns: [{ ...oldRun, runId: 'new', primaryPrompt: 'another request' }], chatMessages: [] }), attempt), null));
  check('completed noncompliant response is not mislabeled error', () => assert.equal(harness.terminalPromptFailure(state({ workRuns: [{ ...oldRun, runId: 'new', status: 'completed' }] }), attempt), null));
  check('same-run user message can identify a normalized primary prompt', () => assert.equal(harness.terminalPromptFailure(state({ workRuns: [{ ...oldRun, runId: 'new', primaryPrompt: '' }] }), attempt).runId, 'new'));

  function fixture(snapshots, renderedText = '') {
    let calls = 0, reads = 0, sends = 0;
    const queriedTargets = [];
    const input = { value: '', focus() {}, dispatchEvent() {} };
    const document = {
      querySelector: selector => selector === '#prompt' ? input : null,
      querySelectorAll: () => renderedText ? [{ innerText: renderedText }] : [],
    };
    const context = vm.createContext({
      document, Event: class Event {}, currentConversationTarget: () => target,
      window: { state: {}, sendMessage() { sends++; }, api: {
        async getState(requestedTarget) {
          queriedTargets.push(requestedTarget);
          const snapshot = snapshots[Math.min(reads++, snapshots.length - 1)];
          return structuredClone(snapshot);
        },
      } },
    });
    const cdp = { async call(method, params) {
      assert.equal(method, 'Runtime.evaluate'); calls++;
      return { result: { value: await vm.runInContext(params.expression, context) } };
    } };
    return { cdp, stats: () => ({ calls, reads, sends, queriedTargets }) };
  }

  const startedAt = Date.now();
  const terminalFixture = fixture([before, before, state()]);
  await assert.rejects(harness.sendUiPrompt(terminalFixture.cdp, prompt, marker, 180000), error => {
    assert.equal(error.failureClass, 'conversation-title-failed');
    assert.equal(error.terminalRun.runId, 'new');
    assert.match(error.message, /uiDebug=/);
    assert.doesNotMatch(error.message, /Timed out waiting/);
    return true;
  });
  const failureElapsedMs = Date.now() - startedAt;
  assert.ok(failureElapsedMs < 5000, `failure took ${failureElapsedMs}ms`);
  assert.equal(terminalFixture.stats().sends, 1);
  checks.push({ name: 'actual send/marker wait ignores old failure then fails immediately on tested new title error', pass: true, elapsedMs: failureElapsedMs });
  check('actual marker reads use the captured target', () => {
    for (const request of terminalFixture.stats().queriedTargets) assert.deepEqual(JSON.parse(JSON.stringify(request)), target);
  });

  const idleFixture = fixture([before, state({ status: 'working', runtime: { running: true, runId: 'new' } }), state()], prompt);
  await assert.rejects(harness.sendUiPrompt(idleFixture.cdp, prompt, marker, 180000), error => {
    assert.equal(error.failureClass, 'conversation-title-failed');
    assert.match(error.message, /idle after/);
    return true;
  });
  checks.push({ name: 'rendered prompt marker cannot hide the terminal error during idle wait', pass: true });

  const done = state({ status: 'idle', workRuns: [{ ...oldRun, runId: 'new', status: 'completed', events: [] }], chatMessages: [{ role: 'assistant', runId: 'new', content: marker }] });
  const successFixture = fixture([before, done, done]);
  const success = await harness.sendUiPrompt(successFixture.cdp, prompt, marker, 1000);
  assert.equal(success.status, 'idle');
  assert.equal(success.chatMessages[0].content, marker);
  checks.push({ name: 'existing persisted assistant marker and idle success remain accepted', pass: true });

  for (const [status, message, expected] of [
    ['error', 'HTTP 503 Service Unavailable', 'provider-http-error'],
    ['error', 'Transport ended unexpectedly', 'run-terminal-error'],
    ['interrupted', '', 'run-interrupted'],
    ['force_interrupted', '', 'run-interrupted'],
  ]) {
    const failureState = state({ workRuns: [{ ...oldRun, runId: 'new', status, events: message ? [{ type: 'error', content: message }] : [] }] });
    const current = fixture([failureState]);
    await assert.rejects(harness.waitFor(current.cdp, harness.assistantMarkerExpression(marker, '', attempt), 180000, marker, 10), error => error.failureClass === expected);
    assert.equal(current.stats().calls, 1);
    checks.push({ name: `terminal ${status} ${expected} fails on first poll`, pass: true });
  }

  let transientCalls = 0;
  const transient = { async call() { if (++transientCalls === 1) throw new Error('temporary CDP disconnect'); return { result: { value: true } }; } };
  assert.equal(await harness.waitFor(transient, 'fixture', 1000, 'transient CDP recovery', 10), true);
  assert.equal(transientCalls, 2);
  checks.push({ name: 'transient CDP exceptions still retry', pass: true });
  const script = path.join(__dirname, 'release-real-provider-stress.cjs');
  return { success: true, checks, checksPassed: checks.length, realApiCalls: 0, guiLaunches: 0, harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex'), failureElapsedMs };
}

module.exports = { verifyRealProviderStressHarness };
if (require.main === module) verifyRealProviderStressHarness().then(result => {
  const outputFlag = process.argv.indexOf('--out');
  if (outputFlag !== -1 && process.argv[outputFlag + 1]) {
    const output = path.resolve(process.argv[outputFlag + 1]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
}).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
