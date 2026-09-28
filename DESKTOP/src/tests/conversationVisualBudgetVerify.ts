/**
 * dev-0.6.6 regression: ComputerUse/BrowserControl memory budget.
 *
 * Field evidence: a single late-stage conversation that repeatedly observed the
 * desktop/browser grew the utility host to a V8 abort
 * (`OOM error in V8: CALL_AND_RETRY_LAST Allocation failed`, ~3017 MB heap),
 * because every historic screenshot is materialized back into a base64 data URL
 * for each provider request. These checks pin the memory-driven budget and the
 * reclamation that keeps vision working without unbounded growth.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import {
  conversationVisualBudget,
  describeVisualBudget,
  planVisualRetention,
  shouldRecycleIdleHost,
  visualDataUrlBytes,
  visualMemoryPressure,
} from '../core/conversationVisualBudget';
import { downscaleDataUrlToBytes } from '../core/visualDownscale';
import { agentKernelRunnerInternals } from '../core/agentKernelRunner';
import type { Agent } from '../core/agent';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const checks: Array<[boolean, string]> = [];
const check = (condition: boolean, message: string) => {
  checks.push([condition, message]);
  assert.ok(condition, message);
};

/** Deterministic gradient PNG so encoding size is stable across runs. */
function makePngDataUrl(width: number, height: number): string {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      png.data[offset] = (x * 7 + y * 3) % 256;
      png.data[offset + 1] = (x * 3 + y * 11) % 256;
      png.data[offset + 2] = (x * 5 + y * 5) % 256;
      png.data[offset + 3] = 255;
    }
  }
  return `data:image/png;base64,${PNG.sync.write(png, { deflateLevel: 6 }).toString('base64')}`;
}

function main(): void {
  // ---- pressure follows *available* memory ----
  check(visualMemoryPressure({ totalBytes: 16 * GIB, freeBytes: 10 * GIB }).pressure === 'roomy',
    'available 10 GiB on a 16 GiB machine is roomy');
  check(visualMemoryPressure({ totalBytes: 16 * GIB, freeBytes: 4 * GIB }).pressure === 'tight',
    'available 4 GiB is tight');
  check(visualMemoryPressure({ totalBytes: 16 * GIB, freeBytes: 2 * GIB }).pressure === 'critical',
    'available 2 GiB is critical');
  check(visualMemoryPressure({ totalBytes: 16 * GIB, freeBytes: 900 * MIB }).pressure === 'severe',
    'available 900 MiB is severe');
  check(visualMemoryPressure({ totalBytes: 6 * GIB, freeBytes: 5 * GIB }).pressure === 'tight',
    'a 6 GiB machine never gets the roomy budget even when idle');
  check(visualMemoryPressure({ totalBytes: 16 * GIB, freeBytes: 0 }).pressure === 'critical',
    'an unusable available-memory reading fails closed to critical');
  check(visualMemoryPressure({ totalBytes: 16 * GIB, freeBytes: Number.NaN }).pressure === visualMemoryPressure({ totalBytes: 16 * GIB }).pressure,
    'a missing sample falls back to the live OS reading instead of guessing');

  const roomy = conversationVisualBudget({ totalBytes: 16 * GIB, freeBytes: 10 * GIB });
  const tight = conversationVisualBudget({ totalBytes: 16 * GIB, freeBytes: 4 * GIB });
  const critical = conversationVisualBudget({ totalBytes: 16 * GIB, freeBytes: 2 * GIB });
  check(roomy.maxSingleImageBytes > tight.maxSingleImageBytes && tight.maxSingleImageBytes > critical.maxSingleImageBytes,
    'the single-image cap shrinks as memory gets tighter');
  check(roomy.maxRequestImageBytes > tight.maxRequestImageBytes && tight.maxRequestImageBytes > critical.maxRequestImageBytes,
    'the per-request visual budget shrinks as memory gets tighter');
  check(roomy.maxRetainedImages > tight.maxRetainedImages && tight.maxRetainedImages > critical.maxRetainedImages,
    'fewer screenshots stay in context as memory gets tighter');
  check(critical.recycleRssBytes < tight.recycleRssBytes && tight.recycleRssBytes < roomy.recycleRssBytes,
    'the idle-host recycle watermark scales with pressure');
  check(roomy.maxSingleImageBytes <= 2 * MIB,
    'even the roomy tier stays at or below the previous fixed 2 MiB cap');

  const smallMachine = conversationVisualBudget({ totalBytes: 4 * GIB, freeBytes: 3.5 * GIB });
  check(smallMachine.maxConversationVisualBytes <= 4 * GIB / 16,
    'the conversation budget is clamped by installed RAM, not only by free memory');
  check(describeVisualBudget(tight).includes('tight'), 'the budget summary is human-readable');

  // ---- the process's own growth escalates the budget ----
  // Real host: V8 aborted at ~3017 MB while the machine still had free memory,
  // so a host approaching its recycle watermark must tighten before that.
  const escalated = conversationVisualBudget({ totalBytes: 32 * GIB, freeBytes: 13 * GIB, rssBytes: 1100 * MIB });
  check(escalated.pressure === 'tight' && escalated.reason.includes('already uses'),
    'a host approaching its watermark escalates one tier even when the machine looks roomy');
  const calm = conversationVisualBudget({ totalBytes: 32 * GIB, freeBytes: 13 * GIB, rssBytes: 200 * MIB });
  check(calm.pressure === 'roomy', 'a small host keeps the machine-derived tier');
  check(escalated.maxSingleImageBytes < calm.maxSingleImageBytes,
    'escalation actually tightens the image cap');

  // ---- retention keeps the newest screenshots within the budget ----
  const entries = Array.from({ length: 20 }, (_, index) => ({ key: `s${index}`, bytes: 6 * MIB }));
  const plan = planVisualRetention(entries, { ...tight, maxRequestImageBytes: 18 * MIB, maxRetainedImages: 2 });
  check(plan.keep.size === 2 && plan.keep.has('s19') && plan.keep.has('s18'),
    'retention keeps the newest screenshots, not the oldest');
  check(plan.released.length === 18 && plan.releasedBytes === 18 * 6 * MIB,
    'retention reports exactly what was released');
  const countLimited = planVisualRetention(entries, { ...roomy, maxRequestImageBytes: 4096 * MIB, maxRetainedImages: 3 });
  check(countLimited.keep.size === 3, 'the retained-image count cap is enforced independently of bytes');
  check(shouldRecycleIdleHost(tight.recycleRssBytes + 1, tight) && !shouldRecycleIdleHost(tight.recycleRssBytes - 1, tight),
    'the idle-host recycle decision uses the derived watermark');

  // ---- real data URL accounting and downscaling ----
  const large = makePngDataUrl(900, 700);
  check(visualDataUrlBytes(large) > 256 * 1024, `the test screenshot is genuinely large (${Math.round(visualDataUrlBytes(large) / 1024)} KiB)`);
  const downscaled = downscaleDataUrlToBytes(large, 96 * 1024);
  check(!!downscaled && visualDataUrlBytes(downscaled) <= 96 * 1024,
    `an oversized screenshot is downscaled into the cap (${downscaled ? Math.round(visualDataUrlBytes(downscaled) / 1024) : 0} KiB)`);
  check(!!downscaled && /^data:image\/(?:png|jpeg);base64,/.test(downscaled),
    'the downscaled image stays a valid image data URL');
  check(downscaleDataUrlToBytes(large, 32 * 1024) !== null, 'a severe budget still yields a usable image');
  check(downscaleDataUrlToBytes(`data:image/png;base64,${'A'.repeat(8192)}`, 1024) === null,
    'an oversized undecodable payload is reported instead of being trusted');
  check(downscaleDataUrlToBytes('data:image/png;base64,AAAA', 1024) === 'data:image/png;base64,AAAA',
    'a payload that already fits is returned untouched');

  // ---- the provider projection applies the budget to a long conversation ----
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-visual-budget-'));
  try {
    const screenshot = makePngDataUrl(320, 240);
    const messages: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 12; index += 1) {
      const file = path.join(workspace, `observe-${index}.png`);
      fs.writeFileSync(file, Buffer.from(screenshot.slice('data:image/png;base64,'.length), 'base64'));
      messages.push({ role: 'user', content: `step ${index}` });
      messages.push({
        role: 'toolResult', toolCallId: `call-${index}`, toolName: 'computer_use', isError: false, timestamp: Date.now(),
        content: [{ type: 'text', text: `observation ${index}` }, { type: 'image', imagePath: file, mimeType: 'image/png' }],
      });
    }
    const staleBudget = {
      ...critical,
      maxRequestImageBytes: 2 * visualDataUrlBytes(screenshot) + 256,
      maxRetainedImages: 2,
      maxSingleImageBytes: 512 * 1024,
    };
    let releaseInfo: { releasedImages: number; releasedBytes: number } | null = null;
    const projected = agentKernelRunnerInternals.fromKernelMessages(messages as never, true, staleBudget, info => {
      releaseInfo = { releasedImages: info.releasedImages, releasedBytes: info.releasedBytes };
    });
    const visualParts = projected.filter(message => Array.isArray(message.content))
      .flatMap(message => (message.content as Array<Record<string, unknown>>).filter(part => part?.type === 'image_url'));
    const releaseNotes = JSON.stringify(projected).match(/\[visual_memory_budget\]/g) || [];
    check(visualParts.length === 2,
      `only the newest screenshots are materialized for the request (${visualParts.length} images)`);
    check(releaseNotes.length === 10,
      `the released screenshots are announced to the model (${releaseNotes.length} notes)`);
    check(!!releaseInfo && (releaseInfo as { releasedImages: number }).releasedImages === 10,
      'the runner reports how many screenshots it released');
    check(projected.every(message => JSON.stringify(message).length < 3 * MIB),
      'no projected message carries an unbounded payload');
    const textOnly = agentKernelRunnerInternals.fromKernelMessages(messages as never, true, {
      ...staleBudget, maxSingleImageBytes: 1, maxRequestImageBytes: 0,
    });
    check(!JSON.stringify(textOnly).includes('image_url'),
      'a zero visual budget degrades to text only, never to a crash');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  // ---- vision still works when memory is tight: the image is shrunk, not dropped ----
  const fakeAgent = {
    activeModelConfig: () => ({}),
  } as unknown as Agent;
  const oversized = makePngDataUrl(700, 500);
  const fallback = agentKernelRunnerInternals.visualFallbackImageInput(
    fakeAgent,
    'computer_use',
    JSON.stringify({ action: 'observe', vision_image_data_url: oversized }),
  );
  const budgetForNow = conversationVisualBudget();
  check(!!fallback.image && visualDataUrlBytes(String(fallback.image)) <= budgetForNow.maxSingleImageBytes,
    `a fresh observe result is fitted to the current single-image cap (${fallback.image ? Math.round(visualDataUrlBytes(String(fallback.image)) / 1024) : 0} KiB ≤ ${Math.round(budgetForNow.maxSingleImageBytes / 1024)} KiB)`);

  console.log(`conversationVisualBudgetVerify: ${checks.length} checks passed (pressure=${budgetForNow.pressure})`);
}

main();
