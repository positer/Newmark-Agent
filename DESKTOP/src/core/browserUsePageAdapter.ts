import {
  BrowserUseAdapterActionRequest,
  BrowserUseAdapterActionResult,
  BrowserUseAdapterElement,
  BrowserUseAdapterObservation,
  BrowserUseEffects,
  BrowserUsePageAdapter,
  BrowserUseScope,
  isPublicBrowserUseAttribute,
} from './browserUse';

/**
 * Minimal host boundary for fixed Newmark Browser-Use page operations. The Electron main
 * process supplies this interface around a WebContents. No caller-provided JavaScript crosses
 * this boundary; only the fixed scripts generated below are evaluated.
 *
 * Electron documents executeJavaScript, navigation events, and setWindowOpenHandler here:
 * https://www.electronjs.org/docs/latest/api/web-contents
 * Download cancellation is a Session will-download responsibility:
 * https://www.electronjs.org/docs/latest/api/session#event-will-download
 */
export interface BrowserUseHostPage {
  identity(signal?: AbortSignal): Promise<{ pageToken: string; url: string; title: string }>;
  evaluateFixed<T>(script: string, signal?: AbortSignal): Promise<T>;
  clickAt(x: number, y: number, signal?: AbortSignal): Promise<void>;
  replaceFocusedText(text: string, signal?: AbortSignal): Promise<void>;
  pressKey(key: string, signal?: AbortSignal): Promise<void>;
  navigate(url: string, signal?: AbortSignal): Promise<void>;
  waitForReady(signal?: AbortSignal): Promise<void>;
  /** Serializes a complete observe/action transaction with every scope sharing this physical page. */
  serialized?<T>(action: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Optional main-process guard used to deny/record downloads, popups, and unsafe navigation. */
  guarded?<T>(action: string, run: () => Promise<T>, signal?: AbortSignal): Promise<{ value: T; effects?: BrowserUseEffects }>;
}

export type BrowserUseHostPageResolver = (scope: BrowserUseScope) => Promise<BrowserUseHostPage>;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'Browser-Use action aborted'));
}

async function abortableDelay(durationMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason || 'Browser-Use action aborted')));
    };
    const timer = setTimeout(finish, Math.max(0, durationMs));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

interface DomProbe {
  ok: boolean;
  error?: string;
  tag?: string;
  role?: string;
  name?: string;
  disabled?: boolean;
  editable?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

interface DomObservation {
  url: string;
  title: string;
  viewport: BrowserUseAdapterObservation['viewport'];
  text: string;
  elements: BrowserUseAdapterElement[];
}

function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/**
 * Fixed page-world helpers for public text extraction. Editable text is user
 * input even when Chromium exposes it through innerText (notably textarea and
 * contenteditable), so it must never enter an observation or extract receipt.
 */
function browserUsePublicTextHelpers(): string {
  return `
    const privateEditableSelector = 'textarea,[contenteditable]:not([contenteditable="false"])';
    const publicRenderedText = (root) => {
      if (!root) return '';
      const rootElement = root.nodeType === 1 ? root : root.parentElement;
      if (rootElement && rootElement.matches && rootElement.matches(privateEditableSelector)) return '';
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const chunks = [];
      let node = null;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest(privateEditableSelector)) continue;
        let current = parent;
        let rendered = true;
        while (current) {
          const style = getComputedStyle(current);
          if (current.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) {
            rendered = false;
            break;
          }
          if (current === rootElement) break;
          current = current.parentElement;
        }
        if (rendered) chunks.push(String(node.nodeValue || ''));
      }
      return chunks.join(' ');
    };
  `;
}

/** Fixed, dependency-free page observation. Ref tokens remain private inside BrowserUseEngine. */
export function browserUseObservationScript(maxChars: number, maxRefs: number): string {
  const boundedChars = Math.max(500, Math.min(50_000, Math.floor(maxChars)));
  const boundedRefs = Math.max(1, Math.min(300, Math.floor(maxRefs)));
  return `(() => {
    const maxChars = ${boundedChars};
    const maxRefs = ${boundedRefs};
    const compact = (value, limit) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
    ${browserUsePublicTextHelpers()}
    const visible = (el) => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
    };
    const renderedText = (el) => publicRenderedText(el);
    const roleOf = (el) => compact(el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox' }[el.tagName] || (el.tagName === 'INPUT' ? (el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox') : '')), 80);
    const nameOf = (el) => {
      const labelledBy = compact(el.getAttribute('aria-labelledby'), 200);
      const labelled = labelledBy ? labelledBy.split(/\\s+/).map(id => renderedText(document.getElementById(id))).join(' ') : '';
      const label = el.labels && el.labels.length ? Array.from(el.labels).map(node => renderedText(node)).join(' ') : '';
      return compact(el.getAttribute('aria-label') || labelled || label || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || renderedText(el), 300);
    };
    const pathOf = (el) => {
      const parts = [];
      let current = el;
      while (current && current.nodeType === 1 && current !== document) {
        const tag = current.localName;
        if (!tag) break;
        const parent = current.parentElement;
        if (!parent) { parts.unshift(tag); break; }
        const sameTag = Array.from(parent.children).filter(child => child.localName === tag);
        const index = sameTag.indexOf(current) + 1;
        parts.unshift(tag + ':nth-of-type(' + Math.max(1, index) + ')');
        current = parent;
        if (current === document.documentElement) { parts.unshift('html'); break; }
      }
      return parts.join(' > ');
    };
    const selector = [
      'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select', 'summary',
      '[contenteditable="true"]', '[role="button"]', '[role="link"]', '[role="textbox"]',
      '[role="checkbox"]', '[role="radio"]', '[role="combobox"]', '[role="menuitem"]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    const seen = new Set();
    const elements = [];
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (elements.length >= maxRefs || seen.has(el) || !visible(el)) continue;
      seen.add(el);
      const token = pathOf(el);
      if (!token) continue;
      const rect = el.getBoundingClientRect();
      const editable = el.matches('input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]),textarea,[contenteditable="true"]');
      const record = {
        token,
        tag: String(el.localName || 'element').toLowerCase(),
        role: roleOf(el) || undefined,
        name: nameOf(el) || undefined,
        text: compact(renderedText(el), 500) || undefined,
        disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        editable,
        selected: el.matches('input[type="checkbox"],input[type="radio"]') ? !!el.checked : undefined,
        options: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 100).map(option => compact(option.label || '', 300)) : undefined,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };
      elements.push(record);
    }
    const bodyText = compact(publicRenderedText(document.body || document.documentElement), maxChars);
    return {
      url: location.href,
      title: document.title || '',
      viewport: {
        width: innerWidth, height: innerHeight, scrollX: window.scrollX, scrollY: window.scrollY,
        pageWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
        pageHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
      },
      text: bodyText,
      elements
    };
  })()`;
}

export function browserUseProbeScript(token: string, scrollIntoView = false): string {
  return `(() => {
    const el = document.querySelector(${json(token)});
    if (!el) return { ok: false, error: 'ref_not_found' };
    if (${scrollIntoView ? 'true' : 'false'} && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    const rect = el.getBoundingClientRect();
    const compact = (value, limit) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
    ${browserUsePublicTextHelpers()}
    const role = compact(el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox' }[el.tagName] || (el.tagName === 'INPUT' ? (el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox') : '')), 80);
    const renderedText = (node) => publicRenderedText(node);
    const labelledBy = compact(el.getAttribute('aria-labelledby'), 200);
    const labelled = labelledBy ? labelledBy.split(/\\s+/).map(id => renderedText(document.getElementById(id))).join(' ') : '';
    const label = el.labels && el.labels.length ? Array.from(el.labels).map(node => renderedText(node)).join(' ') : '';
    const name = compact(el.getAttribute('aria-label') || labelled || label || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || renderedText(el), 300);
    return {
      ok: true,
      tag: String(el.localName || 'element').toLowerCase(), role, name,
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      editable: el.matches('input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]),textarea,[contenteditable="true"]'),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };
  })()`;
}

export function browserUseFocusScript(token: string): string {
  return `(() => { const el = document.querySelector(${json(token)}); if (!el) return false; if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); el.focus({ preventScroll: true }); return document.activeElement === el || el.contains(document.activeElement); })()`;
}

export function browserUseSelectScript(token: string, value: string): string {
  return `(() => {
    const el = document.querySelector(${json(token)});
    if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'select_not_found' };
    const wanted = ${json(value)};
    const option = Array.from(el.options).find(item => String(item.label || '').trim() === wanted);
    if (!option) return { ok: false, error: 'option_not_found' };
    el.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, text: String(option.label || '').trim() };
  })()`;
}

export function browserUseScrollScript(token: string | undefined, deltaX: number, deltaY: number): string {
  return `(() => {
    const el = ${token ? `document.querySelector(${json(token)})` : 'null'};
    const target = el || document.scrollingElement || document.documentElement;
    const before = el ? { x: el.scrollLeft, y: el.scrollTop } : { x: window.scrollX, y: window.scrollY };
    if (el) el.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: 'auto' });
    else window.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: 'auto' });
    const after = el ? { x: el.scrollLeft, y: el.scrollTop } : { x: window.scrollX, y: window.scrollY };
    return { ok: true, before, after, moved: { x: after.x - before.x, y: after.y - before.y } };
  })()`;
}

export function browserUseExtractScript(token: string | undefined, attribute: string | undefined, maxChars: number): string {
  const bounded = Math.max(200, Math.min(50_000, Math.floor(maxChars)));
  const publicAttribute = attribute && isPublicBrowserUseAttribute(attribute) ? attribute.toLowerCase() : '';
  return `(() => {
    const el = ${token ? `document.querySelector(${json(token)})` : '(document.body || document.documentElement)'};
    if (!el) return { ok: false, error: 'ref_not_found' };
    ${browserUsePublicTextHelpers()}
    const attribute = ${json(publicAttribute)};
    const raw = attribute ? el.getAttribute(attribute) : publicRenderedText(el);
    const text = String(raw || '').replace(/\\s+/g, ' ').trim().slice(0, ${bounded});
    return { ok: true, text, attribute: attribute || undefined, truncated: String(raw || '').length > ${bounded} };
  })()`;
}

function sameElement(expected: BrowserUseAdapterElement, probe: DomProbe): boolean {
  if (!probe.ok || !probe.tag || expected.tag.toLowerCase() !== probe.tag.toLowerCase()) return false;
  if (expected.role !== undefined && expected.role !== probe.role) return false;
  if (expected.name !== undefined && expected.name !== probe.name) return false;
  return true;
}

/** Host-agnostic adapter used by Electron main. */
export class NativeBrowserUsePageAdapter implements BrowserUsePageAdapter {
  constructor(private readonly resolvePage: BrowserUseHostPageResolver) {}

  async observe(scope: BrowserUseScope, options: { maxChars: number; maxRefs: number }, signal?: AbortSignal): Promise<BrowserUseAdapterObservation> {
    throwIfAborted(signal);
    const page = await this.resolvePage(scope);
    throwIfAborted(signal);
    const observe = async (): Promise<BrowserUseAdapterObservation> => {
      const before = await page.identity(signal);
      const dom = await page.evaluateFixed<DomObservation>(browserUseObservationScript(options.maxChars, options.maxRefs), signal);
      const after = await page.identity(signal);
      if (!before.pageToken || before.pageToken !== after.pageToken) throw new Error('Page changed during observation; observe again.');
      return {
        pageToken: after.pageToken,
        url: dom.url || after.url,
        title: dom.title || after.title,
        viewport: dom.viewport,
        text: dom.text,
        elements: Array.isArray(dom.elements) ? dom.elements : [],
      };
    };
    return page.serialized ? await page.serialized('observe', observe, signal) : await observe();
  }

  async act(scope: BrowserUseScope, request: BrowserUseAdapterActionRequest, signal?: AbortSignal): Promise<BrowserUseAdapterActionResult> {
    throwIfAborted(signal);
    const page = await this.resolvePage(scope);
    throwIfAborted(signal);
    const act = async (): Promise<BrowserUseAdapterActionResult> => {
      const before = await page.identity(signal);
      if (request.expectedPageToken && before.pageToken !== request.expectedPageToken) {
        return { ok: false, code: 'stale_page', error: 'The page document changed after observation.', retryable: true, pageToken: before.pageToken, url: before.url, title: before.title };
      }
      const run = async (): Promise<unknown> => {
        if (request.action === 'navigate') {
          await page.navigate(request.url || 'about:blank', signal);
          await page.waitForReady(signal);
          return { navigated: true };
        }
        if (request.element) {
          const probe = await page.evaluateFixed<DomProbe>(browserUseProbeScript(request.element.token, request.action === 'click' || request.action === 'type'), signal);
          if (!sameElement(request.element, probe)) {
            const error = new Error('Observed ref no longer resolves to the same element.') as Error & { code?: string };
            error.code = 'ref_not_found';
            throw error;
          }
          if (probe.disabled && ['click', 'type', 'select'].includes(request.action)) {
            const error = new Error('Observed element is disabled.') as Error & { code?: string };
            error.code = 'invalid_ref_role';
            throw error;
          }
          if (request.action === 'click') {
            const rect = probe.rect!;
            await page.clickAt(rect.x + rect.width / 2, rect.y + rect.height / 2, signal);
            await page.waitForReady(signal);
            return { clicked: true };
          }
          if (request.action === 'type') {
            const focused = await page.evaluateFixed<boolean>(browserUseFocusScript(request.element.token), signal);
            if (!focused) throw new Error('Unable to focus observed element.');
            await page.replaceFocusedText(request.text || '', signal);
            return { typed: true, length: String(request.text || '').length };
          }
          if (request.action === 'select') {
            const selected = await page.evaluateFixed<{ ok: boolean; error?: string; value?: string; text?: string }>(browserUseSelectScript(request.element.token, request.value || ''), signal);
            if (!selected.ok) {
              const error = new Error(selected.error || 'Unable to select option.') as Error & { code?: string };
              error.code = selected.error === 'option_not_found' ? 'invalid_request' : 'ref_not_found';
              throw error;
            }
            return selected;
          }
        }
        if (request.action === 'scroll') {
          return await page.evaluateFixed(browserUseScrollScript(request.element?.token, request.deltaX || 0, request.deltaY || 0), signal);
        }
        if (request.action === 'key') {
          await page.pressKey(request.key || '', signal);
          await page.waitForReady(signal);
          return { pressed: request.key };
        }
        if (request.action === 'wait') {
          await abortableDelay(request.durationMs || 0, signal);
          await page.waitForReady(signal);
          return { waitedMs: request.durationMs || 0 };
        }
        if (request.action === 'extract') {
          return await page.evaluateFixed(browserUseExtractScript(request.element?.token, request.attribute, request.maxChars || 12_000), signal);
        }
        throw new Error(`Unsupported page adapter action: ${request.action}`);
      };

      try {
        const guarded = page.guarded ? await page.guarded(request.action, run, signal) : { value: await run(), effects: undefined };
        throwIfAborted(signal);
        const after = await page.identity(signal);
        const pageChanged = before.pageToken !== after.pageToken;
        return {
          ok: true,
          pageToken: after.pageToken,
          pageChanged,
          url: after.url,
          title: after.title,
          data: guarded.value,
          effects: { ...guarded.effects, ...(pageChanged ? { pageChanged: true } : {}) },
        };
      } catch (error) {
        throwIfAborted(signal);
        const after = await page.identity(signal).catch(() => before);
        const code = String((error as Error & { code?: string })?.code || 'action_failed');
        return {
          ok: false,
          code,
          error: error instanceof Error ? error.message : String(error),
          retryable: code === 'ref_not_found' || code === 'stale_page',
          pageToken: after.pageToken,
          pageChanged: before.pageToken !== after.pageToken,
          url: after.url,
          title: after.title,
        };
      }
    };
    return page.serialized ? await page.serialized(request.action, act, signal) : await act();
  }
}
