import * as assert from 'assert';
import { evaluateCompressionFidelity } from '../core/compressionFidelity';

function main(): void {
  const original = [
    'Active task: implement request prefix diagnostics.',
    'Required constraint: never persist prompt bodies.',
    'Verification evidence: tool provisioning covers 58 of 58 schemas.',
    'Relevant file: src/core/agentKernelRunner.ts.',
    'Completed background task: redesign the old settings modal.',
    'Superseded instruction: publish dev-0.1.0 again.',
    'x'.repeat(1200),
  ].join('\n');
  const goodSummary = [
    '## Active Or Unfinished Work',
    'Implement request prefix diagnostics.',
    '## Decisions And Constraints',
    'Never persist prompt bodies.',
    '## Tool And Verification Evidence',
    'Tool provisioning covers 58 of 58 schemas.',
    '## Relevant Files',
    'src/core/agentKernelRunner.ts',
  ].join('\n');
  const good = evaluateCompressionFidelity({
    originalText: original,
    summaryText: goodSummary,
    requiredFacts: [
      'implement request prefix diagnostics',
      'never persist prompt bodies',
      '58 of 58 schemas',
      'src/core/agentKernelRunner.ts',
    ],
    forbiddenFacts: ['redesign the old settings modal', 'publish dev-0.1.0 again'],
    maxCompressionRatio: 0.35,
  });
  assert.equal(good.passed, true, 'complete task-aware summary passes deterministic fidelity scoring');
  assert.equal(good.missingRequired.length, 0, 'complete summary retains every required fact');
  assert.equal(good.leakedForbidden.length, 0, 'complete summary excludes completed and superseded work');
  assert.ok(good.compressionRatio < 0.35, 'complete summary remains inside the compression budget');

  const missing = evaluateCompressionFidelity({
    originalText: original,
    summaryText: 'Implement request prefix diagnostics.',
    requiredFacts: ['implement request prefix diagnostics', 'never persist prompt bodies'],
  });
  assert.deepEqual(missing.missingRequired, ['never persist prompt bodies'], 'missing constraints are reported explicitly');
  assert.equal(missing.passed, false, 'a summary with missing required facts fails');

  const leaked = evaluateCompressionFidelity({
    originalText: original,
    summaryText: `${goodSummary}\nPublish dev-0.1.0 again.`,
    requiredFacts: ['implement request prefix diagnostics'],
    forbiddenFacts: ['publish dev-0.1.0 again'],
  });
  assert.deepEqual(leaked.leakedForbidden, ['publish dev-0.1.0 again'], 'superseded work leakage is reported explicitly');
  assert.equal(leaked.passed, false, 'a summary that revives superseded work fails');

  console.log(JSON.stringify({ ok: true, assertions: 8, compressionRatio: good.compressionRatio }));
}

main();
