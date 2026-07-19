import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentKernelRunnerInternals } from '../core/agentKernelRunner';
import { ConfigManager } from '../core/config';
import { configureWslHostToolWriter, settleWslHostToolResult } from '../core/wslHostToolBridge';
import { ToolExecutor } from '../tools';
import { computerUseInternals, runComputerUse } from '../tools/computerUse';
import { runPersistentPowerShell, stopComputerUsePowerShellHost } from '../tools/computerUsePowerShellHost';

interface ObservationSample {
  elapsedMs: number;
  textBytes: number;
  imageBytes: number;
  objectCount: number;
  imagePath: string;
  imageWidth: number;
  imageHeight: number;
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
    imageWidth: Number(parsed.image_width || 0),
    imageHeight: Number(parsed.image_height || 0),
  };
}

function currentComputerUseScreenshots(): Set<string> {
  const dir = path.join(os.tmpdir(), 'newmark-computer-use');
  try {
    return new Set(fs.readdirSync(dir).filter(name => /^(observe|app)-.*\.jpg$/i.test(name)));
  } catch {
    return new Set();
  }
}

function verifyCompactedVisionTransport(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-computer-use-compact-'));
  const retainedPath = path.join(directory, 'observe-regression.jpg');
  fs.writeFileSync(retainedPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  try {
    const raw = computerUseInternals.stringifyComputerUseResult({
      ok: true,
      action: 'observe',
      vision_image_path: retainedPath,
      oversized_internal_debug: 'x'.repeat(40 * 1024),
      telemetry: { total_ms: 1 },
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.strictEqual(parsed.vision_image_path, retainedPath, 'compaction preserves the one-use image path for model-input preparation and deletion');
    assert.ok(Buffer.byteLength(raw, 'utf8') <= 32 * 1024, 'compacted internal transport stays within the text budget');

    const visible = agentKernelRunnerInternals.sanitizeVisualToolText('computer_use', raw);
    assert.ok(!visible.includes('vision_image_path') && !visible.includes(retainedPath) && !visible.includes('data:image/'), 'public tool text strips all one-use image transport fields');
    const imagePart = agentKernelRunnerInternals.imagePathToOpenAIContentPart(String(parsed.vision_image_path || ''));
    assert.ok(imagePart && !fs.existsSync(retainedPath), 'the preserved compact-path is consumed once and deleted during model-input preparation');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function verifyWslComputerUseStringTransport(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-computer-use-wsl-transport-'));
  const previousDistro = process.env.NEWMARK_WSL_DISTRO;
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=';
  const transportPath = 'C:\\Users\\tester\\AppData\\Local\\Temp\\newmark-computer-use\\observe-private.jpg';
  const mainResult = JSON.stringify({
    ok: true,
    action: 'observe',
    perception: { ui_automation_text: 'UI Automation: Settings window' },
    vision_image_data_url: dataUrl,
    vision_image_path: transportPath,
  });
  let hostCalls = 0;

  try {
    process.env.NEWMARK_WSL_DISTRO = 'Newmark-Test';
    configureWslHostToolWriter(value => {
      const envelope = value as { event?: string; data?: { requestId?: string } };
      if (envelope.event !== 'host_tool_request' || !envelope.data?.requestId) return;
      hostCalls += 1;
      settleWslHostToolResult({
        requestId: envelope.data.requestId,
        ok: true,
        result: hostCalls === 1 ? mainResult : JSON.stringify({ ok: true, action: 'takeover_stop' }),
      });
    });

    const tools = new ToolExecutor(root, new ConfigManager(root));
    // The Linux runtime itself does not expose native desktop control, but the
    // Windows-to-WSL agent host deliberately provisions Computer Use through
    // the trusted Windows host bridge. Model that production host profile
    // explicitly so this transport test is platform-independent.
    tools.setHostProfile({ kind: 'wsl', platform: 'linux', electronBrowser: false, windowsComputerUse: true });
    const context = {
      workspaceId: 'workspace-wsl-transport',
      conversationId: 'vision',
      runtimeKey: 'workspace:wsl-transport::conversation:vision',
      workspacePath: root,
      actorId: 'root',
      allowEphemeralVisionImage: true,
    };
    const raw = await tools.execute('computer_use', JSON.stringify({ action: 'observe' }), root, context);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.strictEqual(parsed.action, 'observe', 'WSL Computer Use returns the main-process JSON string without double encoding');

    const visionAgent = {
      model: 'vision-test',
      activeModelConfig: () => ({ vision: true }),
      config: { findModel: () => ({ vision: true }) },
    } as any;
    const visionInput = agentKernelRunnerInternals.computerUseVisionImageInput(visionAgent, 'computer_use', raw);
    const visible = agentKernelRunnerInternals.sanitizeVisualToolText('computer_use', raw);
    const providerImageParts = visionInput.image
      ? [{ type: 'image_url', image_url: { url: visionInput.image } }]
      : [];
    assert.strictEqual(providerImageParts.length, 1, 'runner extracts exactly one image_url from the WSL Computer Use result');
    assert.strictEqual(providerImageParts[0]?.image_url.url, dataUrl, 'runner preserves the one-use visual input exactly');
    assert.ok(visible.includes('UI Automation: Settings window'), 'public tool text preserves UI Automation context');
    assert.ok(!visible.includes('vision_image_data_url') && !visible.includes('vision_image_path') && !visible.includes(transportPath) && !visible.includes('data:image/'), 'public tool text strips WSL vision transport fields');

    await tools.execute('computer_use', JSON.stringify({ action: 'takeover_stop' }), root, context);
    assert.strictEqual(hostCalls, 2, 'WSL transport regression releases the Computer Use owner lock');
  } finally {
    configureWslHostToolWriter(null);
    if (previousDistro === undefined) delete process.env.NEWMARK_WSL_DISTRO;
    else process.env.NEWMARK_WSL_DISTRO = previousDistro;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function verifyCrashResidueCleanup(): void {
  const internals = computerUseInternals;
  assert.strictEqual(typeof internals.cleanupStaleScreenshots, 'function', 'Computer Use exposes its stale-frame cleanup for regression testing');
  assert.strictEqual(typeof internals.ephemeralScreenshotPath, 'function', 'Computer Use screenshot names carry an owner marker');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-computer-use-cleanup-'));
  const now = 2_000_000_000_000;
  const activePid = 41_001;
  const deadPid = 41_002;
  const makeFrame = (kind: 'observe' | 'app', pid: number, ageMs: number, suffix: string): string => {
    const filePath = internals.ephemeralScreenshotPath(kind, directory, now - ageMs, pid, suffix);
    fs.writeFileSync(filePath, 'ephemeral-frame');
    return filePath;
  };

  const activeFrame = makeFrame('observe', activePid, 48 * 60 * 60_000, 'a1b2c3d4');
  const deadFrame = makeFrame('app', deadPid, 10 * 60_000, 'b2c3d4e5');
  const freshDeadFrame = makeFrame('observe', deadPid, 5_000, 'c3d4e5f6');
  const legacyFrame = path.join(directory, 'observe-2026-07-01T00-00-00-000Z-deadbeef.jpg');
  const unrelatedFile = path.join(directory, 'user-photo.jpg');
  fs.writeFileSync(legacyFrame, 'legacy-frame');
  fs.writeFileSync(unrelatedFile, 'unrelated');
  const oldSeconds = (now - (25 * 60 * 60_000)) / 1000;
  fs.utimesSync(legacyFrame, oldSeconds, oldSeconds);
  fs.utimesSync(unrelatedFile, oldSeconds, oldSeconds);

  try {
    internals.cleanupStaleScreenshots({
      directory,
      now,
      isProcessAlive: (pid: number) => pid === activePid,
    });
    assert.ok(fs.existsSync(activeFrame), 'cleanup never deletes another live worker\'s retained frame');
    assert.ok(!fs.existsSync(deadFrame), 'cleanup removes a crashed worker\'s frame after the owner-death grace period');
    assert.ok(fs.existsSync(freshDeadFrame), 'cleanup preserves a fresh frame during the process-visibility grace period');
    assert.ok(!fs.existsSync(legacyFrame), 'cleanup removes legacy ownerless residue only after the conservative TTL');
    assert.ok(fs.existsSync(unrelatedFile), 'cleanup ignores unrelated files in the shared temporary directory');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  verifyCompactedVisionTransport();
  await verifyWslComputerUseStringTransport();
  verifyCrashResidueCleanup();
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
    const screenshotsBeforeBoundedCapture = currentComputerUseScreenshots();
    const boundedRaw = await runComputerUse({
      action: 'observe',
      workspacePath: process.cwd(),
      ownerId,
      allowEphemeralVisionImage: false,
      captureMaxWidth: 1,
      captureMaxHeight: 1,
    });
    const bounded = JSON.parse(boundedRaw) as Record<string, any>;
    assert.strictEqual(bounded.ok, true, `bounded observe should succeed: ${boundedRaw.slice(0, 500)}`);
    assert.strictEqual(bounded.capture_max_width, 320, 'capture width is clamped to the safe minimum');
    assert.strictEqual(bounded.capture_max_height, 240, 'capture height is clamped to the safe minimum');
    assert.ok(Number(bounded.image_width) <= 320 && Number(bounded.image_height) <= 240, 'bounded observe preserves the requested maximum box');
    assert.ok(Number(bounded.image_width) <= Number(bounded.width) && Number(bounded.image_height) <= Number(bounded.height), 'bounded observe never enlarges the source');
    assert.strictEqual(bounded.vision_image_path, undefined, 'non-vision observations never expose an internal screenshot path');
    assert.ok(!boundedRaw.includes(path.join(os.tmpdir(), 'newmark-computer-use')) && !boundedRaw.includes('data:image/'), 'public non-vision observation contains neither a local path nor image bytes');
    const leakedBoundedFiles = [...currentComputerUseScreenshots()].filter(name => !screenshotsBeforeBoundedCapture.has(name));
    assert.deepStrictEqual(leakedBoundedFiles, [], 'non-retained bounded observe deletes its temporary screenshot before returning');
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
      assert.ok(sample.imageWidth > 0 && sample.imageWidth <= 1280, `default capture width is out of bounds: ${sample.imageWidth}`);
      assert.ok(sample.imageHeight > 0 && sample.imageHeight <= 960, `default capture height is out of bounds: ${sample.imageHeight}`);
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
