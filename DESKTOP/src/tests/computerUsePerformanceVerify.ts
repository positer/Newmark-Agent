import * as assert from 'assert';
import * as fs from 'fs';
import { runComputerUse } from '../tools/computerUse';
import { runPersistentPowerShell, stopComputerUsePowerShellHost } from '../tools/computerUsePowerShellHost';

interface ObservationSample {
  elapsedMs: number;
  textBytes: number;
  imageBytes: number;
  objectCount: number;
  imagePath: string;
}

function percentile95(values: number[]): number {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] || 0;
}

async function observe(ownerId: string, action: 'observe' | 'app_observe', windowHandle = ''): Promise<ObservationSample> {
  const startedAt = Date.now();
  const raw = await runComputerUse({
    action,
    workspacePath: process.cwd(),
    ownerId,
    allowEphemeralVisionImage: true,
    windowHandle: windowHandle || undefined,
  });
  const elapsedMs = Date.now() - startedAt;
  const parsed = JSON.parse(raw) as Record<string, any>;
  assert.strictEqual(parsed.ok, true, `${action} should succeed: ${raw.slice(0, 500)}`);
  const imagePath = String(parsed.vision_image_path || '');
  const imageBytes = imagePath && fs.existsSync(imagePath) ? fs.statSync(imagePath).size : 0;
  return {
    elapsedMs,
    textBytes: Buffer.byteLength(raw, 'utf8'),
    imageBytes,
    objectCount: Array.isArray(parsed.perception?.objects) ? parsed.perception.objects.length : 0,
    imagePath,
  };
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log('computer_use performance checks skipped outside Windows');
    return;
  }

  const ownerId = `performance-${process.pid}`;
  const images = new Set<string>();
  let maxEventLoopGapMs = 0;
  let measureEventLoop = false;
  let previousTick = Date.now();
  const eventLoopProbe = setInterval(() => {
    const current = Date.now();
    if (measureEventLoop) maxEventLoopGapMs = Math.max(maxEventLoopGapMs, current - previousTick - 5);
    previousTick = current;
  }, 5);

  try {
    await runPersistentPowerShell('Write-Output "warm"', 5000, 'action');
    const dispatchSamples: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await runPersistentPowerShell('Write-Output "ok"', 5000, 'action');
      assert.strictEqual(result.ok, true);
      dispatchSamples.push(result.elapsedMs);
    }

    await runComputerUse({ action: 'app_list', workspacePath: process.cwd(), ownerId });
    await runComputerUse({ action: 'observe', workspacePath: process.cwd(), ownerId, allowEphemeralVisionImage: false });
    const appList = JSON.parse(await runComputerUse({ action: 'app_list', workspacePath: process.cwd(), ownerId })) as Record<string, any>;
    assert.strictEqual(appList.ok, true);
    assert.ok(Array.isArray(appList.applications) && appList.applications.length > 0, 'app_list should return visible Windows applications');
    // Keep the performance fixture independent from whichever heavyweight app
    // happens to be foreground (Chromium UIA trees vary by page and machine).
    // Program Manager is the stable Windows shell surface; fall back only when
    // a nonstandard shell does not expose it. Warm the app-scoped lane once,
    // matching the existing desktop-lane warm-up before collecting samples.
    const app = appList.applications.find((item: Record<string, unknown>) => String(item.class_name || '') === 'Progman')
      || appList.applications.find((item: Record<string, unknown>) => String(item.title || '').trim())
      || appList.applications[0];
    await runComputerUse({
      action: 'app_observe',
      workspacePath: process.cwd(),
      ownerId,
      allowEphemeralVisionImage: false,
      windowHandle: String(app.handle || ''),
    });
    previousTick = Date.now();
    maxEventLoopGapMs = 0;
    measureEventLoop = true;

    const desktopSamples: ObservationSample[] = [];
    for (let index = 0; index < 3; index += 1) desktopSamples.push(await observe(ownerId, 'observe'));
    const appSamples: ObservationSample[] = [];
    for (let index = 0; index < 3; index += 1) appSamples.push(await observe(ownerId, 'app_observe', String(app.handle || '')));
    for (const sample of [...desktopSamples, ...appSamples]) {
      if (sample.imagePath) images.add(sample.imagePath);
      assert.ok(sample.textBytes <= 32 * 1024, `computer_use text result exceeds 32 KiB: ${sample.textBytes}`);
      assert.ok(sample.imageBytes > 0 && sample.imageBytes <= 1024 * 1024, `computer_use image exceeds 1 MiB or is missing: ${sample.imageBytes}`);
      assert.ok(sample.objectCount <= 48, `semantic object result should be compact: ${sample.objectCount}`);
    }

    const sequence = JSON.parse(await runComputerUse({
      action: 'sequence',
      workspacePath: process.cwd(),
      ownerId,
      dryRun: true,
      steps: [
        { action: 'wait', durationMs: 1 },
        { action: 'scroll', x: 1, y: 1, scrollY: 1 },
        { action: 'move', x: 1, y: 1 },
      ],
    })) as Record<string, any>;
    assert.strictEqual(sequence.ok, true);
    assert.strictEqual(sequence.completed?.length, 3, 'sequence should execute at most three stable low-risk dry-run steps');

    assert.ok(percentile95(dispatchSamples) <= 300, `warm action dispatch p95 exceeded 300 ms: ${dispatchSamples.join(', ')}`);
    assert.ok(percentile95(desktopSamples.map(sample => sample.elapsedMs)) <= 2500, `warm desktop observe p95 exceeded 2.5 s: ${desktopSamples.map(sample => sample.elapsedMs).join(', ')}`);
    assert.ok(percentile95(appSamples.map(sample => sample.elapsedMs)) <= 1500, `warm app observe p95 exceeded 1.5 s: ${appSamples.map(sample => sample.elapsedMs).join(', ')}`);
    assert.ok(maxEventLoopGapMs <= 50, `main event loop stalled for ${maxEventLoopGapMs} ms`);

    console.log(JSON.stringify({
      actionDispatchMs: dispatchSamples,
      desktopObserveMs: desktopSamples.map(sample => sample.elapsedMs),
      appObserveMs: appSamples.map(sample => sample.elapsedMs),
      maxEventLoopGapMs,
      maxTextBytes: Math.max(...desktopSamples.concat(appSamples).map(sample => sample.textBytes)),
      maxImageBytes: Math.max(...desktopSamples.concat(appSamples).map(sample => sample.imageBytes)),
      visibleApplications: appList.applications.length,
    }));
  } finally {
    clearInterval(eventLoopProbe);
    for (const imagePath of images) {
      try { fs.unlinkSync(imagePath); } catch {}
    }
    stopComputerUsePowerShellHost();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
