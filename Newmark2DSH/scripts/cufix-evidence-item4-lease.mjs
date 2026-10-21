#!/usr/bin/env node
/**
 * cufix item 4 evidence: the takeover lease has no time limit.
 *
 * It holds a real lease for longer than the retired 120000 ms TTL with **no stop call**,
 * samples `mode_report` while it holds, and then ends it with an explicit `takeover_stop`.
 * Every number in the emitted JSON was measured by this run.
 *
 * Usage: node Newmark2DSH/scripts/cufix-evidence-item4-lease.mjs <evidenceDir> [holdMs]
 *
 * The overlay this starts is the real screen-wide topmost window, so the run keeps its
 * hold as short as the claim allows and always stops it in a `finally`.
 */
import fs from 'node:fs';
import path from 'node:path';

const evidenceDir = path.resolve(process.argv[2] || '.');
const holdMs = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 135000;
const RETIRED_TTL_MS = 120000;
const READER = new URL('../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href;

const mod = await import(READER);
const { runComputerUse, stopAll } = mod;
const { overlayState } = await import(new URL('../packages/newmark-core/components/computeruse/lib/overlay-win32.js', import.meta.url).href);
const owner = `cufix-item4-${process.pid}`;

const evidence = {
  item: 4,
  claim: 'the takeover lease has no time limit and is released only by an explicit takeover_stop',
  retired_ttl_ms: RETIRED_TTL_MS,
  hold_planned_ms: holdMs,
  owner,
  started_at: new Date().toISOString(),
  samples: [],
};

const call = async (options) => JSON.parse(await runComputerUse(options));

async function main() {
  const started = await call({ action: 'takeover_start', ownerId: owner, mouseMode: 'real' });
  evidence.takeover_start = {
    ok: started.ok,
    takeover: started.takeover,
    mouse_mode: started.mouse_mode,
    lease: started.lease,
    overlay_state_at_return: started.overlay ? started.overlay.state : null,
    overlay_reason_at_return: started.overlay ? started.overlay.reason : null,
  };

  const from = Date.now();
  let sampleIndex = 0;
  while (Date.now() - from < holdMs) {
    const elapsedBefore = Date.now() - from;
    const wait = Math.min(20000, holdMs - elapsedBefore);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    const report = await call({ action: 'mode_report' });
    const overlay = overlayState();
    sampleIndex += 1;
    evidence.samples.push({
      sample: sampleIndex,
      held_for_ms: Date.now() - from,
      past_the_retired_ttl: (Date.now() - from) > RETIRED_TTL_MS,
      lease_held: report.lease.held,
      lease_owner: report.lease.owner_id,
      lease_expiry: report.lease.expiry,
      lease_expires_at: report.lease.expires_at,
      lease_expires_in_ms: report.lease.expires_in_ms,
      lease_ttl_ms: report.lease.ttl_ms,
      lease_released_by: report.lease.released_by,
      lease_last_release_reason: report.lease.last_release_reason,
      mouse_mode: report.mouse_mode,
      overlay_running: overlay.running,
      overlay_process_alive: overlay.process_alive,
      overlay_pid: overlay.pid,
      overlay_reason: overlay.reason,
    });
    console.log(`[item4] held ${Math.round((Date.now() - from) / 1000)}s: lease_held=${report.lease.held} expiry=${report.lease.expiry} overlay_running=${overlay.running}`);
  }
  evidence.held_for_ms = Date.now() - from;

  const beforeStop = await call({ action: 'mode_report' });
  evidence.still_held_after_the_hold = {
    lease_held: beforeStop.lease.held,
    lease_owner: beforeStop.lease.owner_id,
    lease_last_release_reason: beforeStop.lease.last_release_reason,
    overlay_running: overlayState().running,
    overlay_process_alive: overlayState().process_alive,
    overlay_contract_stop_paths: beforeStop.overlay_contract ? beforeStop.overlay_contract.stop_paths : null,
    overlay_contract_explicit_stop_paths: beforeStop.overlay_contract ? beforeStop.overlay_contract.explicit_stop_paths : null,
    overlay_contract_implicit_stop_paths: beforeStop.overlay_contract ? beforeStop.overlay_contract.implicit_stop_paths : null,
    mode_report_constants: beforeStop.constants,
  };

  const stopped = await call({ action: 'takeover_stop', ownerId: owner });
  const stopFrom = Date.now();
  let gone = false;
  while (Date.now() - stopFrom < 30000) {
    await new Promise(resolve => setTimeout(resolve, 300));
    if (overlayState().running === false) { gone = true; break; }
  }
  const afterStop = await call({ action: 'mode_report' });
  evidence.takeover_stop = {
    ok: stopped.ok,
    mouse_mode: stopped.mouse_mode,
    released_owner: stopped.released_owner,
    lease: stopped.lease,
    overlay_gone: gone,
    overlay_gone_after_ms: Date.now() - stopFrom,
    lease_held_after: afterStop.lease.held,
    lease_last_release_reason: afterStop.lease.last_release_reason,
    overlay_running_after: afterStop.overlay.running,
    overlay_last_stop: afterStop.overlay.last_stop || null,
  };
  evidence.ended_at = new Date().toISOString();
  evidence.checks = {
    lease_survived_past_120s_with_no_stop_call: evidence.samples.some(sample => sample.past_the_retired_ttl === true && sample.lease_held === true && sample.overlay_running === true),
    every_duration_field_says_no_expiry: evidence.samples.every(sample => sample.lease_expiry === 'none' && sample.lease_expires_at === null && sample.lease_expires_in_ms === null && sample.lease_ttl_ms === null),
    no_sample_was_released_by_a_clock: evidence.samples.every(sample => sample.lease_last_release_reason === ''),
    overlay_still_running_at_the_end_of_the_hold: evidence.still_held_after_the_hold.overlay_running === true,
    lease_ended_by_takeover_stop_only: evidence.takeover_stop.lease_last_release_reason === 'takeover_stop' && evidence.takeover_stop.overlay_gone === true,
    lease_expiry_is_not_a_stop_path: evidence.still_held_after_the_hold.overlay_contract_stop_paths.includes('lease_expiry') === false,
  };
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
} finally {
  try {
    const stopped = await call({ action: 'takeover_stop', ownerId: owner });
    evidence.final_cleanup = { ok: stopped.ok, released_owner: stopped.released_owner };
  } catch (error) {
    evidence.final_cleanup = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const failedChecks = Object.entries(evidence.checks || {}).filter(([, value]) => value !== true).map(([name]) => name);
evidence.failed_checks = failedChecks;
evidence.outcome = failure ? 'ERROR' : failedChecks.length === 0 ? 'PASS' : 'FAIL';
if (failure) evidence.error = failure;

fs.mkdirSync(evidenceDir, { recursive: true });
const outPath = path.join(evidenceDir, 'cufix-item4-lease-no-expiry.json');
fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`[item4] outcome=${evidence.outcome} failed_checks=${failedChecks.join(',') || 'none'}`);
console.log(`[item4] held_for_ms=${evidence.held_for_ms}`);
console.log(`[item4] wrote ${outPath}`);

stopAll();
process.exit(evidence.outcome === 'PASS' ? 0 : 1);
