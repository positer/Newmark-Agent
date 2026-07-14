import type { Event as ElectronEvent, KeyboardInputEvent, Session, WebContents } from 'electron';
import { BrowserUseEffects, BrowserUseScope } from './browserUse';
import { BrowserUseHostPage } from './browserUsePageAdapter';

interface PageState {
  contents: WebContents;
  generation: number;
  guardStack: BrowserUseEffects[];
  actionTail: Promise<void>;
}

export interface ElectronBrowserUseHostOptions {
  resolveContents(scope: BrowserUseScope, boundContentsId?: number): Promise<WebContents>;
  openExternal?(url: string): void | Promise<void>;
  guardSettleMs?: number;
}

const SAFE_NAVIGATION = /^(?:https?:|about:blank|newmark-preview:)/i;
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
      if (mainFrame !== false) state.generation += 1;
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
      if (SAFE_NAVIGATION.test(url)) return;
      const effects = this.activeEffects(state);
      if (effects) effects.navigationBlocked = true;
      event.preventDefault();
    });
  }

  async resolve(scope: BrowserUseScope): Promise<BrowserUseHostPage> {
    const boundId = this.runtimeBindings.get(scope.runtimeKey);
    const contents = await this.options.resolveContents(scope, boundId);
    if (contents.isDestroyed()) throw new Error('Built-in browser page is unavailable.');
    this.attach(contents);
    this.runtimeBindings.set(scope.runtimeKey, contents.id);
    return this.page(contents);
  }

  clear(scope?: BrowserUseScope): void {
    if (scope) this.runtimeBindings.delete(scope.runtimeKey);
    else this.runtimeBindings.clear();
  }

  dispose(): void {
    this.runtimeBindings.clear();
    for (const [browserSession, handler] of this.downloadHandlers) {
      browserSession.removeListener('will-download', handler);
    }
    this.downloadHandlers.clear();
    this.pages.clear();
  }

  private page(contents: WebContents): BrowserUseHostPage {
    const state = this.pages.get(contents.id)!;
    return {
      identity: async signal => {
        throwIfAborted(signal);
        return {
          pageToken: `${contents.id}:${contents.getProcessId()}:${state.generation}`,
          url: contents.getURL(),
          title: contents.getTitle(),
        };
      },
      evaluateFixed: async <T>(script: string, signal?: AbortSignal) => await raceWithAbort(
        contents.executeJavaScriptInIsolatedWorld(BROWSER_USE_WORLD_ID, [{ code: script }], true) as Promise<T>,
        signal,
      ),
      clickAt: async (x: number, y: number, signal?: AbortSignal) => {
        throwIfAborted(signal);
        contents.focus();
        const point = { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
        contents.sendInputEvent({ type: 'mouseMove', ...point });
        contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      },
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
        await raceWithAbort(contents.loadURL(url), signal, () => {
          if (!contents.isDestroyed()) contents.stop();
        });
      },
      waitForReady: async (signal?: AbortSignal) => {
        await abortableDelay(20, signal);
        await waitForPageReady(contents, 15_000, signal);
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

  private installDownloadGuard(browserSession: Session): void {
    if (this.downloadHandlers.has(browserSession)) return;
    const handler = (event: ElectronEvent, _item: Electron.DownloadItem, contents: WebContents) => {
      const effects = this.activeEffects(this.pages.get(contents.id));
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
