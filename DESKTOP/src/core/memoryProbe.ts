import * as fs from 'fs';

/**
 * dev-0.6.6 runtime memory probe (diagnostic only).
 *
 * Kept in source so long-horizon investigations can be re-run, but **replaced
 * by `memoryProbe.disabled.ts` in packaged builds** (see
 * `scripts/build-conversation-utility-host.cjs --strip-diagnostics`), so no
 * probe code, heap-snapshot capability or probe file path ships in the MSI /
 * portable / app.asar artifacts.
 *
 * Enabled only with `NEWMARK_MEMORY_PROBE=1` plus `NEWMARK_MEMORY_PROBE_FILE`.
 */

export interface HostRuntimeHooksOptions {
  /** Runtime root used when no explicit probe file is configured. */
  root: string;
  intervalMs?: number;
  snapshotRssMiB?: number;
}

export interface HostRuntimeHooks {
  enabled: boolean;
  countPosted(value: unknown): void;
  stop(): void;
}

export function installHostRuntimeHooks(options: HostRuntimeHooksOptions): HostRuntimeHooks {
  const file = String(process.env.NEWMARK_MEMORY_PROBE_FILE || '').trim()
    || (process.env.NEWMARK_MEMORY_PROBE === '1' ? `${options.root}/host-memory.jsonl` : '');
  const enabled = process.env.NEWMARK_MEMORY_PROBE === '1' && !!file;
  if (!enabled) return { enabled: false, countPosted() {}, stop() {} };

  const snapshotRssMiB = Math.max(128, Number(process.env.NEWMARK_MEMORY_SNAPSHOT_MB) || options.snapshotRssMiB || 900);
  const intervalMs = Math.max(500, Number(process.env.NEWMARK_MEMORY_PROBE_INTERVAL_MS) || options.intervalMs || 2000);
  let postedEvents = 0;
  let postedBytes = 0;
  let snapshotTaken = false;
  const byType = new Map<string, { count: number; bytes: number; max: number }>();
  const timer = setInterval(() => {
    const usage = process.memoryUsage();
    const row = {
      at: new Date().toISOString(),
      pid: process.pid,
      rssMiB: Math.round(usage.rss / 1024 ** 2 * 10) / 10,
      heapUsedMiB: Math.round(usage.heapUsed / 1024 ** 2 * 10) / 10,
      heapTotalMiB: Math.round(usage.heapTotal / 1024 ** 2 * 10) / 10,
      externalMiB: Math.round(usage.external / 1024 ** 2 * 10) / 10,
      arrayBuffersMiB: Math.round(usage.arrayBuffers / 1024 ** 2 * 10) / 10,
      postedEvents,
      postedMiB: Math.round(postedBytes / 1024 ** 2 * 10) / 10,
      topPostedTypes: Array.from(byType.entries())
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .slice(0, 5)
        .map(([type, stat]) => ({ type, count: stat.count, MiB: Math.round(stat.bytes / 1024 ** 2 * 10) / 10, maxKiB: Math.round(stat.max / 1024) })),
    };
    try { fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf-8'); } catch { /* probe must never break the host */ }
    if (!snapshotTaken && row.rssMiB >= snapshotRssMiB) {
      snapshotTaken = true;
      try {
        const snapshotPath = `${file}.${process.pid}.heapsnapshot`;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const v8 = require('node:v8') as { writeHeapSnapshot(path?: string): string };
        v8.writeHeapSnapshot(snapshotPath);
        fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), snapshot: snapshotPath, rssMiB: row.rssMiB })}\n`, 'utf-8');
      } catch { /* snapshot is best effort */ }
    }
  }, intervalMs);
  timer.unref?.();

  return {
    enabled: true,
    countPosted(value: unknown) {
      postedEvents += 1;
      try {
        const text = JSON.stringify(value);
        const bytes = Buffer.byteLength(text, 'utf8');
        postedBytes += bytes;
        const type = String((value as { data?: { type?: string } })?.data?.type || 'unknown');
        const stat = byType.get(type) || { count: 0, bytes: 0, max: 0 };
        stat.count += 1;
        stat.bytes += bytes;
        stat.max = Math.max(stat.max, bytes);
        byType.set(type, stat);
      } catch { /* probe must never break the host */ }
    },
    stop() { clearInterval(timer); },
  };
}
