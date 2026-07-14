export type BrowserControlAction =
  | 'open'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'eval'
  | 'back'
  | 'forward'
  | 'reload'
  | 'cdp'
  | 'use';

export interface BrowserControlRequest {
  action: BrowserControlAction;
  url?: string;
  selector?: string;
  text?: string;
  script?: string;
  method?: string;
  params?: unknown;
  maxChars?: number;
  /** Structured native Browser-Use request. Kept opaque at the legacy control boundary. */
  browserUse?: unknown;
}

export interface BrowserControlResult {
  ok: boolean;
  action: BrowserControlAction;
  source: string;
  url?: string;
  title?: string;
  text?: string;
  data?: unknown;
  error?: string;
}

export interface BrowserControlBackend {
  run(request: BrowserControlRequest, signal?: AbortSignal): Promise<BrowserControlResult>;
}

const SUPPORTED_ACTIONS = new Set<BrowserControlAction>([
  'open',
  'snapshot',
  'click',
  'type',
  'eval',
  'back',
  'forward',
  'reload',
  'cdp',
  'use',
]);

export class BrowserControl {
  private static backend: BrowserControlBackend | null = null;

  static setBackend(backend: BrowserControlBackend | null): void {
    this.backend = backend;
  }

  static hasBackend(): boolean {
    return this.backend !== null;
  }

  static async run(request: BrowserControlRequest, signal?: AbortSignal): Promise<BrowserControlResult> {
    throwIfAborted(signal);
    const normalized = this.normalize(request);
    if (!normalized.ok) return normalized.result;
    if (!this.backend) {
      return {
        ok: false,
        action: normalized.request.action,
        source: 'unavailable',
        error: 'Browser control backend is not connected. Start Newmark Desktop to enable Chromium/CDP browser operations.',
      };
    }
    try {
      const result = await this.backend.run(normalized.request, signal);
      throwIfAborted(signal);
      return result;
    } catch (e) {
      throwIfAborted(signal);
      return {
        ok: false,
        action: normalized.request.action,
        source: 'backend',
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private static normalize(request: BrowserControlRequest): {
    ok: true;
    request: BrowserControlRequest;
  } | {
    ok: false;
    result: BrowserControlResult;
  } {
    const action = request.action;
    if (!SUPPORTED_ACTIONS.has(action)) {
      return {
        ok: false,
        result: {
          ok: false,
          action: action || 'snapshot',
          source: 'validator',
          error: `Unsupported browser action: ${String(action)}`,
        },
      };
    }

    const normalized: BrowserControlRequest = { ...request };
    if (action === 'open') {
      const url = this.normalizeUrl(request.url || '');
      if (!url) {
        return {
          ok: false,
          result: {
            ok: false,
            action,
            source: 'validator',
            error: 'browser_open requires a safe http, https, file, or about:blank URL.',
          },
        };
      }
      normalized.url = url;
    }

    if ((action === 'click' || action === 'type') && !String(request.selector || '').trim()) {
      return {
        ok: false,
        result: {
          ok: false,
          action,
          source: 'validator',
          error: `${action} requires a CSS selector.`,
        },
      };
    }

    if (action === 'eval' && !String(request.script || '').trim()) {
      return {
        ok: false,
        result: {
          ok: false,
          action,
          source: 'validator',
          error: 'browser_eval requires a script.',
        },
      };
    }

    if (action === 'cdp' && !String(request.method || '').trim()) {
      return {
        ok: false,
        result: {
          ok: false,
          action,
          source: 'validator',
          error: 'browser_cdp requires a Chrome DevTools Protocol method.',
        },
      };
    }

    if (action === 'use' && (!request.browserUse || typeof request.browserUse !== 'object' || Array.isArray(request.browserUse))) {
      return {
        ok: false,
        result: {
          ok: false,
          action,
          source: 'validator',
          error: 'browser_use requires a structured Browser-Use request.',
        },
      };
    }

    if (typeof normalized.maxChars !== 'number' || normalized.maxChars <= 0) {
      normalized.maxChars = 12000;
    }
    normalized.maxChars = Math.min(Math.max(Math.floor(normalized.maxChars), 500), 50000);
    return { ok: true, request: normalized };
  }

  private static normalizeUrl(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    if (trimmed === 'about:blank') return trimmed;
    const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const url = new URL(withProtocol);
      const protocol = url.protocol.toLowerCase();
      if (!['http:', 'https:', 'file:'].includes(protocol)) return '';
      return url.toString();
    } catch {
      return '';
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const error = new Error(reason ? String(reason) : 'Browser control aborted');
  error.name = 'AbortError';
  throw error;
}
