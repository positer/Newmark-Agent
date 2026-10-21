import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRestartController, probeDesktop } from '../packages/newmark-core/lib/core-restart.js';

let passed = 0, version = '0.2.37', time = 100, launches = 0, committed = 0;
const root = 'restart-test-' + crypto.randomUUID();
const dependencies = {
  probe: async () => ({ pid: 12, path: 'fixture', created: 'fixture' }),
  installed: () => version, now: () => time,
  launch: async () => { launches++; return { commit: () => committed++ }; },
};
const controller = createRestartController(root, dependencies);
await assert.rejects(controller.prepare('../bad')); passed++;
await assert.rejects(controller.restart('unissued')); passed++;
const first = await controller.prepare('0.2.38');
await assert.rejects(controller.restart(first.ticket), /安装版本/); passed++;
assert.equal(launches, 0); passed++;
version = '0.2.38';
time += 31 * 60 * 1000;
await assert.rejects(controller.restart(first.ticket), /失效/); passed++;
const next = await controller.prepare('0.2.38');
await assert.rejects(controller.restart(first.ticket)); passed++;
// A plugin re-apply after installation must retain the already confirmed ticket.
const reloaded = createRestartController(root, dependencies);
const helper = await reloaded.restart(next.ticket);
assert.equal(committed, 0); passed++;
helper.commit(); assert.equal(committed, 1); passed++;
helper.commit(); assert.equal(committed, 1); passed++;
assert.equal(launches, 1); passed++;
await assert.rejects(controller.restart(next.ticket)); passed++;
await assert.rejects(controller.prepare('0.2.39')); passed++;
const unavailable = createRestartController(root + '-unsupported', { ...dependencies, probe: async () => { throw Error('unsupported'); } });
await assert.rejects(unavailable.prepare('0.2.38'), /unsupported/); passed++;
const failure = createRestartController(root + '-failure', { ...dependencies, launch: async () => { throw Error('launch failed'); } });
const failed = await failure.prepare('0.2.38');
await assert.rejects(failure.restart(failed.ticket), /launch failed/); passed++;
assert.ok((await failure.prepare('0.2.38')).ticket); passed++;
const cancelled = createRestartController(root + '-cancelled', dependencies);
const cancelTicket = await cancelled.prepare('0.2.38');
const abandoned = await cancelled.restart(cancelTicket.ticket);
abandoned.cancel(); abandoned.commit();
assert.equal(committed, 1); passed++;
assert.ok((await cancelled.prepare('0.2.38')).ticket); passed++;
// This test runner is not a descendant of DSH; native probing must reject it.
await assert.rejects(probeDesktop()); passed++;
console.log(`Core restart: ${passed}/${passed} passed; version gate, expiry, identity boundary, hot reapply, one launch, response-before-commit.`);
