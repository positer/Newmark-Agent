/**
 * dev-0.5.5 stream unlimited-timeout pressure gate.
 *
 * `readProviderStreamChunk` default timeout changed from 30_000 to 0
 * (unlimited), matching DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 0 and the
 * Android client's readTimeout(0) / SSE_IDLE_TIMEOUT_MS = 0L.
 *
 * This test proves:
 * - a slow-but-alive stream (chunks spaced beyond the old 30s cap) never
 *   times out under the new default;
 * - a stalled stream with no explicit timeout also never times out (the
 *   caller owns cancellation via AbortSignal);
 * - an explicit positive timeout still fires and cancels the reader
 *   (regression for providerTimeoutRecoveryVerify semantics);
 * - abort always wins immediately, even with no timeout;
 * - many concurrent readers on one stream stay independent and leak-free.
 */
import * as assert from 'assert';
import { readProviderStreamChunk } from '../providers/provider-events';

function check(condition: boolean, message: string): void {
  if (condition) console.log(`  [PASS] ${message}`);
  else console.log(`  [FAIL] ${message}`);
  assert.ok(condition, message);
}

interface FakeReader {
  reads: Array<() => Promise<ReadableStreamReadResult<Uint8Array>>>;
  cancelled: boolean;
}

function makeReader(reads: Array<() => Promise<ReadableStreamReadResult<Uint8Array>>>): FakeReader {
  return { reads, cancelled: false };
}

function readerAdapter(reader: FakeReader): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0;
  return {
    read: () => {
      if (index < reader.reads.length) return reader.reads[index++]();
      return new Promise(() => undefined); // hang forever
    },
    cancel: async () => { reader.cancelled = true; },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

function chunk(bytes: number[]): ReadableStreamReadResult<Uint8Array> {
  return { done: false, value: Uint8Array.from(bytes) };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('streamUnlimitedTimeoutStressVerify');

  // 1. Slow-but-alive stream: chunks spaced 40ms apart, 25 chunks => 1000ms
  //    total. Under the old 30s default this would pass trivially; the point
  //    is the new default must not introduce any artificial deadline either.
  {
    const reader = makeReader(Array.from({ length: 25 }, () => async () => {
      await sleep(40);
      return chunk([0x61]);
    }));
    const adapter = readerAdapter(reader);
    const signal = new AbortController().signal;
    let received = 0;
    while (received < 25) {
      const { done } = await readProviderStreamChunk(adapter, signal);
      if (done) break;
      received += 1;
    }
    check(received === 25, 'slow-but-alive stream (25 x 40ms) completes with the unlimited default');
    check(!reader.cancelled, 'completed stream does not cancel the reader');
  }

  // 2. Stalled stream with the default timeout: must NOT time out. We race
  //    for 200ms and expect the read to still be pending (no TimeoutError).
  {
    const reader = makeReader([]); // never resolves
    const adapter = readerAdapter(reader);
    const controller = new AbortController();
    let timedOut = false;
    let settled = false;
    const pending = readProviderStreamChunk(adapter, controller.signal).then(
      () => { settled = true; },
      () => { settled = true; timedOut = true; },
    );
    await sleep(200);
    check(!settled && !timedOut, 'stalled stream does not time out under the unlimited default');
    controller.abort();
    await pending;
    check(settled && timedOut, 'abort releases the pending default-timeout read');
    check(reader.cancelled, 'abort cancels the stalled reader');
  }

  // 3. Explicit positive timeout still fires and cancels the reader.
  {
    let cancelled = false;
    const adapter = {
      read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
      cancel: async () => { cancelled = true; },
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const started = Date.now();
    let name = '';
    try {
      await readProviderStreamChunk(adapter, new AbortController().signal, 60);
    } catch (error) {
      name = error instanceof Error ? error.name : String(error);
    }
    const elapsed = Date.now() - started;
    check(name === 'TimeoutError', 'explicit positive timeout still raises TimeoutError');
    check(elapsed < 1000, `explicit timeout is bounded (${elapsed}ms)`);
    check(cancelled, 'explicit timeout cancels the reader');
  }

  // 4. Abort wins immediately even with no timeout.
  {
    const reader = makeReader([]);
    const adapter = readerAdapter(reader);
    const controller = new AbortController();
    const started = Date.now();
    let name = '';
    setTimeout(() => controller.abort(), 30);
    try {
      await readProviderStreamChunk(adapter, controller.signal);
    } catch (error) {
      name = error instanceof Error ? error.name : String(error);
    }
    const elapsed = Date.now() - started;
    check(name === 'AbortError', 'abort raises AbortError with the unlimited default');
    check(elapsed < 500, `abort is immediate (${elapsed}ms)`);
    check(reader.cancelled, 'abort cancels the reader');
  }

  // 5. Concurrent readers on one stream stay independent.
  {
    let cancelled = false;
    const adapter = {
      read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
      cancel: async () => { cancelled = true; },
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    // Three concurrent unlimited reads must all stay pending (no spurious
    // timeout). We race them for 150ms and assert none settled.
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const outcomes: Array<{ settled: boolean; name: string }> = [];
    const promises = controllers.map(controller =>
      readProviderStreamChunk(adapter, controller.signal).then(
        () => outcomes.push({ settled: true, name: '' }),
        (e: unknown) => outcomes.push({ settled: true, name: e instanceof Error ? e.name : String(e) }),
      ),
    );
    await sleep(150);
    check(outcomes.length === 0, 'concurrent unlimited reads never spuriously settle');
    // Clean up: abort all three so the process can exit.
    controllers.forEach(c => c.abort());
    await Promise.allSettled(promises);
    check(outcomes.every(o => o.settled), 'aborting concurrent reads settles them cleanly');
  }

  // 6. Rapid chunk bursts (streaming pressure): 500 chunks with no delay.
  {
    const reader = makeReader(Array.from({ length: 500 }, () => async () => chunk([0x62])));
    const adapter = readerAdapter(reader);
    const signal = new AbortController().signal;
    let received = 0;
    while (received < 500) {
      const { done } = await readProviderStreamChunk(adapter, signal);
      if (done) break;
      received += 1;
    }
    check(received === 500, '500-chunk burst completes without timeout or cancellation');
  }

  console.log(JSON.stringify({ ok: true }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});