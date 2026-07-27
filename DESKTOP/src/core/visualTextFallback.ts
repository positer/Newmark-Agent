interface BrowserVisualFallback {
  runtimeKey: string;
  observationId: string;
  dataUrl: string;
  visionPresented: boolean;
  createdAt: number;
}

const browserFallbacks = new Map<string, BrowserVisualFallback>();
const MAX_AGE_MS = 5 * 60 * 1000;

function key(runtimeKey: string, observationId: string): string {
  return `${String(runtimeKey || '').trim()}\u0000${String(observationId || '').trim()}`;
}

function prune(now = Date.now()): void {
  for (const [entryKey, entry] of browserFallbacks) {
    if (now - entry.createdAt > MAX_AGE_MS) browserFallbacks.delete(entryKey);
  }
}

export function registerBrowserVisualFallback(
  runtimeKey: string,
  observationId: string,
  dataUrl: string,
  visionPresented: boolean,
): void {
  prune();
  if (!runtimeKey || !observationId || !/^data:image\/(?:png|jpeg);base64,/i.test(dataUrl)) return;
  browserFallbacks.set(key(runtimeKey, observationId), {
    runtimeKey,
    observationId,
    dataUrl,
    visionPresented,
    createdAt: Date.now(),
  });
}

export function browserVisualFallback(runtimeKey: string, observationId: string): BrowserVisualFallback | null {
  prune();
  return browserFallbacks.get(key(runtimeKey, observationId)) || null;
}

export function clearBrowserVisualFallbacks(runtimeKey?: string): void {
  if (!runtimeKey) {
    browserFallbacks.clear();
    return;
  }
  for (const [entryKey, entry] of browserFallbacks) {
    if (entry.runtimeKey === runtimeKey) browserFallbacks.delete(entryKey);
  }
}
