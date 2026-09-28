import { freemem, totalmem } from 'node:os';

/**
 * dev-0.6.6: per-conversation memory budget for ComputerUse / BrowserControl
 * visual material.
 *
 * Field evidence: a long conversation that repeatedly drove computer_use /
 * browser_control grew the utility host until V8 aborted with
 * `OOM error in V8: CALL_AND_RETRY_LAST Allocation failed` at ~3017 MB heap.
 * Every historic screenshot is stored as a file reference and materialized into
 * a base64 data URL for the provider request, so a late-stage conversation
 * builds a request whose visual payload grows with the number of observations.
 *
 * The budget is derived from the machine's *available* memory (not just its
 * total), so an 8 GB machine that is already busy reclaims much earlier than an
 * idle 32 GB one. Reclaiming only ever drops visual detail that was already
 * sent in an earlier provider round; it never truncates text, tool results,
 * plans or the conversation transcript.
 */

export type VisualMemoryPressure = 'roomy' | 'tight' | 'critical' | 'severe';

export interface VisualMemorySample {
  /** Physical RAM installed. Defaults to `os.totalmem()`. */
  totalBytes?: number;
  /** Free physical RAM right now. Defaults to `os.freemem()`. */
  freeBytes?: number;
  /** Resident set size of the process that owns the conversation, if known. */
  rssBytes?: number;
}

export interface ConversationVisualBudget {
  pressure: VisualMemoryPressure;
  reason: string;
  /** Largest single screenshot accepted into a provider request. */
  maxSingleImageBytes: number;
  /** Total visual bytes one provider request may materialize for the conversation. */
  maxRequestImageBytes: number;
  /** How many historic screenshots may stay in context. */
  maxRetainedImages: number;
  /** Retained visual bytes for the conversation (history plus live captures). */
  maxConversationVisualBytes: number;
  /** Idle hosts above this RSS are recycled instead of being reused. */
  recycleRssBytes: number;
}

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

const TIERS: Record<VisualMemoryPressure, Omit<ConversationVisualBudget, 'pressure' | 'reason'>> = {
  roomy: {
    maxSingleImageBytes: 2 * MIB,
    maxRequestImageBytes: 48 * MIB,
    maxRetainedImages: 12,
    maxConversationVisualBytes: 192 * MIB,
    recycleRssBytes: 1536 * MIB,
  },
  tight: {
    maxSingleImageBytes: 768 * 1024,
    maxRequestImageBytes: 16 * MIB,
    maxRetainedImages: 6,
    maxConversationVisualBytes: 64 * MIB,
    recycleRssBytes: 1024 * MIB,
  },
  critical: {
    maxSingleImageBytes: 320 * 1024,
    maxRequestImageBytes: 6 * MIB,
    maxRetainedImages: 3,
    maxConversationVisualBytes: 24 * MIB,
    recycleRssBytes: 640 * MIB,
  },
  severe: {
    maxSingleImageBytes: 160 * 1024,
    maxRequestImageBytes: 2 * MIB,
    maxRetainedImages: 1,
    maxConversationVisualBytes: 8 * MIB,
    recycleRssBytes: 384 * MIB,
  },
};

/** Pressure tier from available memory, with a total-RAM floor so 4 GB hosts never get a roomy budget. */
export function visualMemoryPressure(sample: VisualMemorySample = {}): { pressure: VisualMemoryPressure; reason: string } {
  const totalBytes = Number.isFinite(sample.totalBytes) ? Number(sample.totalBytes) : totalmem();
  const freeBytes = Number.isFinite(sample.freeBytes) ? Number(sample.freeBytes) : freemem();
  if (Number.isFinite(sample.freeBytes) && Number(sample.freeBytes) <= 0) {
    return { pressure: 'critical', reason: 'available memory is unknown' };
  }
  const available = Math.max(0, freeBytes);
  if (available < 1.2 * GIB) return { pressure: 'severe', reason: `only ${(available / MIB).toFixed(0)} MiB available` };
  if (available < 3 * GIB) return { pressure: 'critical', reason: `${(available / GIB).toFixed(1)} GiB available` };
  if (available < 6 * GIB) return { pressure: 'tight', reason: `${(available / GIB).toFixed(1)} GiB available` };
  // A small machine rarely has 6 GiB free for long; never hand it the roomy caps.
  if (Number.isFinite(totalBytes) && totalBytes > 0 && totalBytes < 8 * GIB) {
    return { pressure: 'tight', reason: `installed RAM is only ${(totalBytes / GIB).toFixed(1)} GiB` };
  }
  return { pressure: 'roomy', reason: `${(available / GIB).toFixed(1)} GiB available` };
}

export function conversationVisualBudget(sample: VisualMemorySample = {}): ConversationVisualBudget {
  const totalBytes = Number.isFinite(sample.totalBytes) ? Number(sample.totalBytes) : totalmem();
  const base = visualMemoryPressure(sample);
  const rssBytes = Math.max(0, Number(sample.rssBytes) || 0);
  // V8 aborts on the process's own heap, not on the machine's free memory: the
  // real host died at ~3017 MB while the machine still had memory available. So
  // a process that already approaches its recycle watermark escalates one tier
  // even when the machine looks roomy.
  const escalate: Record<VisualMemoryPressure, VisualMemoryPressure> = {
    roomy: 'tight',
    tight: 'critical',
    critical: 'severe',
    severe: 'severe',
  };
  const approachingProcessLimit = rssBytes > 0 && rssBytes >= TIERS[base.pressure].recycleRssBytes * 0.6;
  const pressure = approachingProcessLimit ? escalate[base.pressure] : base.pressure;
  const reason = approachingProcessLimit
    ? `${base.reason}; this host already uses ${Math.round(rssBytes / MIB)} MiB`
    : base.reason;
  const tier = TIERS[pressure];
  // Clamp by installed RAM as well: an idle 4 GB machine must not accept a
  // budget sized for a workstation.
  const totalClamp = (fraction: number, floorBytes: number) =>
    Number.isFinite(totalBytes) && totalBytes > 0 ? Math.max(floorBytes, Math.floor(totalBytes * fraction)) : Number.POSITIVE_INFINITY;
  return {
    pressure,
    reason,
    maxSingleImageBytes: tier.maxSingleImageBytes,
    maxRequestImageBytes: Math.min(tier.maxRequestImageBytes, totalClamp(1 / 64, 2 * MIB)),
    maxRetainedImages: tier.maxRetainedImages,
    maxConversationVisualBytes: Math.min(tier.maxConversationVisualBytes, totalClamp(1 / 16, 8 * MIB)),
    recycleRssBytes: Math.min(tier.recycleRssBytes, totalClamp(1 / 8, 256 * MIB)),
  };
}

/**
 * Heap cost of a data URL: the base64 payload length. This is what the provider
 * request actually holds (a JS string of that many characters), and it matches
 * the historical `dataUrl.length` cap this budget replaces.
 */
export function visualDataUrlBytes(value: string): number {
  const text = String(value || '');
  const comma = text.indexOf(',');
  if (!text.startsWith('data:') || comma < 0) return text.length;
  return text.length - comma - 1;
}

export interface VisualRetentionEntry {
  key: string;
  bytes: number;
}

/**
 * Choose which visual entries stay materialized, newest first.
 *
 * `entries` must be ordered oldest → newest (the order they appear in the
 * conversation); the plan keeps the newest ones within both the byte budget and
 * the retained-image count, and reports how much was released.
 */
export function planVisualRetention(
  entries: VisualRetentionEntry[],
  budget: ConversationVisualBudget,
): { keep: Set<string>; released: string[]; releasedBytes: number; retainedBytes: number } {
  const keep = new Set<string>();
  const released: string[] = [];
  let releasedBytes = 0;
  let retainedBytes = 0;
  let retainedCount = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const bytes = Math.max(0, Number(entry.bytes) || 0);
    const fitsCount = retainedCount < Math.max(1, budget.maxRetainedImages);
    const fitsBytes = retainedBytes + bytes <= budget.maxRequestImageBytes;
    // The newest observation is always kept while it fits the single-image cap:
    // dropping every screenshot would blind the agent, and the per-image cap
    // already bounds what that one picture can cost.
    const newestWithinSingleCap = index === entries.length - 1 && bytes <= Math.max(1, budget.maxSingleImageBytes);
    if (newestWithinSingleCap || (fitsCount && fitsBytes)) {
      keep.add(entry.key);
      retainedBytes += bytes;
      retainedCount += 1;
      continue;
    }
    released.push(entry.key);
    releasedBytes += bytes;
  }
  return { keep, released, releasedBytes, retainedBytes };
}

/** Should an idle host be recycled instead of reused? */
export function shouldRecycleIdleHost(rssBytes: number, budget: ConversationVisualBudget): boolean {
  const value = Number(rssBytes);
  if (!Number.isFinite(value) || value <= 0) return false;
  return value >= budget.recycleRssBytes;
}

/** Short human-readable summary used in work-status lines. */
export function describeVisualBudget(budget: ConversationVisualBudget): string {
  return `${budget.pressure} (${budget.reason}; single image ≤ ${Math.round(budget.maxSingleImageBytes / 1024)} KiB, `
    + `request visual ≤ ${Math.round(budget.maxRequestImageBytes / MIB)} MiB, keep ≤ ${budget.maxRetainedImages} screenshots, `
    + `recycle host at ${Math.round(budget.recycleRssBytes / MIB)} MiB RSS)`;
}
