import { BrowserWindow, nativeImage } from 'electron';
import { readBrowserPdf } from './browserPdf';
import { readFile, stat } from 'fs/promises';
import { fileURLToPath } from 'url';
import type { Event as ElectronEvent, KeyboardInputEvent, Session, WebContents } from 'electron';
import { BrowserUseEffects, BrowserUseScope } from './browserUse';
import { browserUseClickScript, BrowserUseHostPage } from './browserUsePageAdapter';

interface PageState {
  contents: WebContents;
  generation: number;
  guardStack: BrowserUseEffects[];
  actionTail: Promise<void>;
  viewport?: { width: number; height: number };
  surface?: { width: number; height: number };
  viewportScale?: number;
  pdfUrl?: string;
}

export interface ElectronBrowserUseHostOptions {
  resizeContents?(contents: WebContents, viewport: { width: number; height: number }): Promise<void>;
  resolveContents(scope: BrowserUseScope, boundContentsId?: number): Promise<WebContents>;
  openExternal?(url: string): void | Promise<void>;
  guardSettleMs?: number;
  releaseContents?(scope: BrowserUseScope, contents: WebContents): void;
}

const SAFE_NAVIGATION = /^(?:https?:|file:|about:blank|newmark-preview:)/i;
const BROWSER_USE_WORLD_ID = 999;

/**
 * Electron-owned Browser-Use page host. All model-independent DOM programs live in
 * NativeBrowserUsePageAdapter; this class provides trusted WebContents input, document
 * generations, and persistent popup/download/navigation guards.
 */
export class ElectronBrowserUseHost {
  private readonly pages = new Map<number, PageState>();
  private readonly runtimeBindings = new Map<string, number>();
  private readonly downloadHandlers = new Map<Session, (event: ElectronEvent, item: Electron.DownloadItem, contents: WebContents) => void>();
  private readonly guardSettleMs: number;

  constructor(private readonly options: ElectronBrowserUseHostOptions) {
    this.guardSettleMs = Math.max(0, Math.min(1_000, Math.floor(options.guardSettleMs ?? 75)));
  }

  attach(contents: WebContents): void {
    if (contents.isDestroyed() || this.pages.has(contents.id)) return;
    const state: PageState = { contents, generation: 1, guardStack: [], actionTail: Promise.resolve() };
    this.pages.set(contents.id, state);
    this.installDownloadGuard(contents.session);

    contents.on('did-start-navigation', (details, _url, _isInPlace, isMainFrame) => {
      const mainFrame = typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : isMainFrame;
      if (mainFrame !== false) { state.generation += 1; state.pdfUrl = undefined; }
    });
    contents.on('render-process-gone', () => { state.generation += 1; });
    contents.once('destroyed', () => {
      this.pages.delete(contents.id);
      for (const [runtimeKey, id] of this.runtimeBindings) {
        if (id === contents.id) this.runtimeBindings.delete(runtimeKey);
      }
    });

    contents.setWindowOpenHandler(details => {
      const effects = this.activeEffects(state);
      if (effects) effects.popupBlocked = true;
      if (effects || this.isRuntimeBound(contents.id)) {
        return { action: 'deny' };
      }
      if (/^https?:/i.test(details.url)) void this.options.openExternal?.(details.url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      const localFromWeb = /^file:/i.test(url) && !/^file:/i.test(contents.getURL());
      if (SAFE_NAVIGATION.test(url) && !localFromWeb) return;
      const effects = this.activeEffects(state);
      if (effects) effects.navigationBlocked = true;
      event.preventDefault();
    });
  }

  async resolve(scope: BrowserUseScope): Promise<BrowserUseHostPage> {
    const bindingKey = this.bindingKey(scope);
    const boundId = this.runtimeBindings.get(bindingKey);
    const contents = await this.options.resolveContents(scope, boundId);
    if (contents.isDestroyed()) throw new Error('Built-in browser page is unavailable.');
    this.attach(contents);
    this.runtimeBindings.set(bindingKey, contents.id);
    return this.page(contents);
  }

  clear(scope?: BrowserUseScope): void {
    if (!scope) {
      for (const [bindingKey, contentsId] of this.runtimeBindings) this.releaseBinding(bindingKey, contentsId);
      this.runtimeBindings.clear();
      return;
    }
    for (const [bindingKey, contentsId] of this.runtimeBindings) {
      if (!this.bindingMatchesScope(bindingKey, scope)) continue;
      this.releaseBinding(bindingKey, contentsId, scope);
      this.runtimeBindings.delete(bindingKey);
    }
  }

  dispose(): void {
    this.clear();
    for (const [browserSession, handler] of this.downloadHandlers) {
      browserSession.removeListener('will-download', handler);
    }
    this.downloadHandlers.clear();
    this.pages.clear();
  }

  private page(contents: WebContents): BrowserUseHostPage {
    const state = this.pages.get(contents.id)!;
    return {
      pdfTarget: () => state.pdfUrl,
      identity: async signal => {
        throwIfAborted(signal);
        return {
          pageToken: `${contents.id}:${contents.getProcessId()}:${state.generation}`,
          url: state.pdfUrl || contents.getURL(),
          title: contents.getTitle(),
        };
      },
      evaluateFixed: async <T>(script: string, signal?: AbortSignal) => await raceWithAbort(
        contents.executeJavaScriptInIsolatedWorld(BROWSER_USE_WORLD_ID, [{ code: script }], true) as Promise<T>,
        signal,
      ),
      clickAt: async (x: number, y: number, signal?: AbortSignal) => {
        throwIfAborted(signal);
        // A webview guest can retain the DOM focus while its embedder is still
        // committing a workspace/tab transition. Focus both sides and yield
        // between native input events so Chromium receives a real click rather
        // than a synchronously queued sequence that can be dropped by the guest.
        contents.hostWebContents?.focus();
        contents.focus();
        await abortableDelay(10, signal);
        const scale = state.viewportScale || 1;
        const point = { x: Math.max(0, Math.round(x * scale)), y: Math.max(0, Math.round(y * scale)) };
        contents.sendInputEvent({ type: 'mouseMove', ...point });
        await abortableDelay(10, signal);
        contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        await abortableDelay(10, signal);
        contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
        await abortableDelay(10, signal);
      },
      clickElement: contents.getType() === 'webview' ? async (token: string, signal?: AbortSignal) => {
        throwIfAborted(signal);
        const result = await raceWithAbort(
          contents.executeJavaScriptInIsolatedWorld(BROWSER_USE_WORLD_ID, [{ code: browserUseClickScript(token) }], true) as Promise<{ clicked?: boolean; error?: string }>,
          signal,
        );
        if (!result?.clicked) throw new Error(result?.error || 'Unable to click the observed Browser-Use element.');
      } : undefined,
      replaceFocusedText: async (text: string, signal?: AbortSignal) => {
        throwIfAborted(signal);
        contents.focus();
        const modifiers: NonNullable<KeyboardInputEvent['modifiers']> = [process.platform === 'darwin' ? 'meta' : 'control'];
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers });
        await abortableDelay(10, signal);
        await raceWithAbort(contents.insertText(text), signal);
        await abortableDelay(10, signal);
      },
      pressKey: async (key: string, signal?: AbortSignal) => {
        throwIfAborted(signal);
        contents.focus();
        const input = keyboardInput(key);
        contents.sendInputEvent({ type: 'keyDown', keyCode: input.keyCode, modifiers: input.modifiers });
        contents.sendInputEvent({ type: 'keyUp', keyCode: input.keyCode, modifiers: input.modifiers });
      },
      navigate: async (url: string, signal?: AbortSignal) => {
        try {
          await raceWithAbort(contents.loadURL(url), signal, () => {
            if (!contents.isDestroyed()) contents.stop();
          });
        } catch (error) {
          if (signal?.aborted || !state.pdfUrl) throw error;
          // Chromium reports ERR_ABORTED for attachment PDFs; their captured URL is read as binary.
        }
      },
      waitForReady: async (signal?: AbortSignal) => {
        await abortableDelay(20, signal);
        await waitForPageReady(contents, 15_000, signal);
      },
      waitForStable: async (maxWaitMs: number, signal?: AbortSignal) => await waitForDomStable(contents, maxWaitMs, signal),
      readPdf: async (maxChars, forceVision, signal, pdfPage) => {
        const url = state.pdfUrl || contents.getURL();
        let bytes: Uint8Array;
        if (url.startsWith('file:')) {
          const file = fileURLToPath(new URL(url));
          if ((await stat(file)).size > 250 * 1024 * 1024) throw new Error('PDF too large');
          bytes = new Uint8Array(await readFile(file));
        } else {
          const response = await contents.session.fetch(url, { signal });
          if (!response.ok) throw new Error('PDF HTTP ' + response.status);
          const reader = response.body?.getReader();
          if (!reader) throw new Error('PDF response is empty');
          const chunks: Uint8Array[] = []; let length = 0;
          try {
            for (;;) {
              const next = await reader.read(); if (next.done) break;
              length += next.value.length;
              if (length > 250 * 1024 * 1024) throw new Error('PDF too large');
              chunks.push(next.value);
            }
          } finally { await reader.cancel(); }
          bytes = new Uint8Array(Buffer.concat(chunks));
        }
        return await readBrowserPdf(bytes, maxChars, forceVision, signal, pdfPage);
      },
      setViewport: async (viewport, signal) => {
        throwIfAborted(signal);
        if (state.viewport?.width === viewport.width && state.viewport?.height === viewport.height) return;
        if (this.options.resizeContents) await this.options.resizeContents(contents, viewport);
        else {
          const window = BrowserWindow.fromWebContents(contents);
          if (!window) throw new Error('Browser viewport host unavailable');
          window.setContentSize(viewport.width, viewport.height);
        }
        contents.enableDeviceEmulation({ screenPosition: 'desktop', viewPosition: { x: 0, y: 0 }, screenSize: viewport, viewSize: viewport, deviceScaleFactor: 1, scale: 1 });
        state.viewportScale = 1;
        state.viewport = { ...viewport };
        state.generation += 1;
        await abortableDelay(100, signal);
      },
      captureVisibleScreenshot: async (signal?: AbortSignal) => {
        throwIfAborted(signal);
        const scale = state.viewportScale || 1;
        const rect = state.viewport ? { x: 0, y: 0, width: Math.floor(state.viewport.width * scale), height: Math.floor(state.viewport.height * scale) } : undefined;
        const captured = await raceWithAbort(contents.capturePage(rect, { stayHidden: true }), signal);
        const size = captured.getSize();
        const targetWidth = state.viewport ? Math.min(1200, state.viewport.width) : Math.min(1200, size.width);
        const normalized = state.viewport
          ? captured.resize({ width: targetWidth, height: Math.round(targetWidth * state.viewport.height / state.viewport.width), quality: 'good' })
          : size.width > 1200 ? captured.resize({ width: 1200, quality: 'good' }) : captured;
        // Embedded guests may return transparent page backgrounds. JPEG must retain readable dark text.
        const pixels = normalized.toBitmap();
        for (let offset = 0; offset < pixels.length; offset += 4) {
          const white = 255 - pixels[offset + 3];
          if (white) {
            pixels[offset] = Math.min(255, pixels[offset] + white);
            pixels[offset + 1] = Math.min(255, pixels[offset + 1] + white);
            pixels[offset + 2] = Math.min(255, pixels[offset + 2] + white);
            pixels[offset + 3] = 255;
          }
        }
        const jpeg = nativeImage.createFromBitmap(pixels, normalized.getSize()).toJPEG(82);
        if (!jpeg.length || jpeg.length > 1_400_000) return '';
        return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
      },
      serialized: async <T>(_action: string, run: () => Promise<T>, signal?: AbortSignal) => {
        const task = state.actionTail.then(async () => {
          throwIfAborted(signal);
          return await run();
        });
        state.actionTail = task.then(() => undefined, () => undefined);
        return await raceWithAbort(task, signal);
      },
      guarded: async <T>(_action: string, run: () => Promise<T>, signal?: AbortSignal) => {
        throwIfAborted(signal);
        const effects: BrowserUseEffects = {};
        state.guardStack.push(effects);
        try {
          const value = await run();
          throwIfAborted(signal);
          if (this.guardSettleMs) await abortableDelay(this.guardSettleMs, signal);
          return { value, effects };
        } finally {
          const index = state.guardStack.lastIndexOf(effects);
          if (index >= 0) state.guardStack.splice(index, 1);
        }
      },
    };
  }

  private activeEffects(state: PageState | undefined): BrowserUseEffects | undefined {
    return state?.guardStack[state.guardStack.length - 1];
  }

  private isRuntimeBound(contentsId: number): boolean {
    for (const id of this.runtimeBindings.values()) {
      if (id === contentsId) return true;
    }
    return false;
  }

  private bindingKey(scope: BrowserUseScope): string {
    return `${scope.runtimeKey}\u0000${scope.visible === false ? 'background' : 'visible'}`;
  }

  private bindingMatchesScope(bindingKey: string, scope: BrowserUseScope): boolean {
    const prefix = `${scope.runtimeKey}\u0000`;
    return bindingKey.startsWith(prefix)
      && (scope.visible === undefined || bindingKey === this.bindingKey({ ...scope, visible: scope.visible !== false }));
  }

  private releaseBinding(bindingKey: string, contentsId: number, scope?: BrowserUseScope): void {
    const contents = this.pages.get(contentsId)?.contents;
    if (!contents || contents.isDestroyed()) return;
    const separator = bindingKey.lastIndexOf('\u0000');
    const runtimeKey = separator >= 0 ? bindingKey.slice(0, separator) : bindingKey;
    const visible = separator < 0 || bindingKey.slice(separator + 1) !== 'background';
    this.options.releaseContents?.({ owner: scope?.owner || '', runtimeKey, visible }, contents);
  }

  private installDownloadGuard(browserSession: Session): void {
    if (this.downloadHandlers.has(browserSession)) return;
    const handler = (event: ElectronEvent, _item: Electron.DownloadItem, contents: WebContents) => {
      const state = this.pages.get(contents.id);
      const effects = this.activeEffects(state);
      if (state && _item.getMimeType().split(';')[0] === 'application/pdf') {
        state.pdfUrl = _item.getURL();
        state.generation += 1;
      }
      if (effects) effects.downloadBlocked = true;
      if (!effects && !this.isRuntimeBound(contents.id)) return;
      event.preventDefault();
    };
    this.downloadHandlers.set(browserSession, handler);
    browserSession.on('will-download', handler);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason || 'Browser-Use action aborted'));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => {
      try { onAbort?.(); } catch {}
      reject(abortError(signal));
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

async function abortableDelay(durationMs: number, signal?: AbortSignal): Promise<void> {
  await raceWithAbort(new Promise<void>(resolve => setTimeout(resolve, Math.max(0, durationMs))), signal);
}

function keyboardInput(raw: string): Pick<KeyboardInputEvent, 'keyCode' | 'modifiers'> {
  const parts = String(raw || '').split('+').map(part => part.trim()).filter(Boolean);
  const keyCode = parts.pop() || '';
  const modifiers: NonNullable<KeyboardInputEvent['modifiers']> = [];
  for (const part of parts) {
    const normalized = part.toLowerCase();
    const modifier = normalized === 'ctrl' || normalized === 'control'
      ? 'control'
      : normalized === 'cmd' || normalized === 'command' || normalized === 'meta'
        ? 'meta'
        : normalized === 'alt'
          ? 'alt'
          : normalized === 'shift'
            ? 'shift'
            : '';
    if (modifier && !modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return { keyCode, modifiers };
}

async function waitForPageReady(contents: WebContents, timeoutMs = 15_000, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (contents.isDestroyed() || !contents.isLoadingMainFrame()) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      contents.removeListener('did-finish-load', finish);
      contents.removeListener('did-fail-load', finish);
      signal?.removeEventListener('abort', abort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal ? abortError(signal) : new Error('Browser-Use action aborted'));
    };
    const timer = setTimeout(finish, timeoutMs);
    contents.once('did-finish-load', finish);
    contents.once('did-fail-load', finish);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function waitForDomStable(contents: WebContents, maxWaitMs: number, signal?: AbortSignal): Promise<{ waitedMs: number; stable: boolean; polls: number; readyState?: string }> {
  const startedAt = Date.now();
  const budget = Math.max(0, Math.min(10_000, Math.floor(maxWaitMs)));
  let previous = '';
  let stablePolls = 0;
  let polls = 0;
  let readyState = '';
  do {
    throwIfAborted(signal);
    const snapshot = await raceWithAbort(contents.executeJavaScriptInIsolatedWorld(BROWSER_USE_WORLD_ID, [{ code: `(() => ({
      readyState: document.readyState,
      bodyChildren: document.body ? document.body.childElementCount : 0,
      textLength: document.body ? String(document.body.innerText || '').length : 0,
      pageWidth: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0),
      pageHeight: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0)
    }))()` }], true) as Promise<Record<string, unknown>>, signal);
    polls += 1;
    readyState = String(snapshot?.readyState || '');
    const fingerprint = JSON.stringify(snapshot);
    stablePolls = fingerprint === previous && (readyState === 'interactive' || readyState === 'complete') ? stablePolls + 1 : 0;
    previous = fingerprint;
    if (stablePolls >= 2 || Date.now() - startedAt >= budget) break;
    await abortableDelay(Math.min(100, Math.max(20, budget - (Date.now() - startedAt))), signal);
  } while (Date.now() - startedAt < budget);
  return { waitedMs: Date.now() - startedAt, stable: stablePolls >= 2, polls, readyState };
}
