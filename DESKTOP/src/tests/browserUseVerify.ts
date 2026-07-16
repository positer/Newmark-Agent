import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { bindBrowserUseRequest, BrowserUse, BrowserUseEngine, BrowserUsePageAdapter, BrowserUseReceipt, BrowserUseRequest } from '../core/browserUse';
import { NativeBrowserUsePageAdapter } from '../core/browserUsePageAdapter';
import { ConfigManager } from '../core/config';
import { createUtilityHostToolHandler } from '../core/utilityHostToolRouter';
import { configureUtilityHostToolBridge, requestUtilityHostTool, settleUtilityHostToolResult } from '../core/utilityHostToolBridge';
import { configureWslHostToolWriter, requestWindowsHostTool, settleWslHostToolResult } from '../core/wslHostToolBridge';
import { ToolExecutor } from '../tools';

let passed = 0;
const temporaryRoots = new Set<string>();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`BROWSER_USE_VERIFY_FAIL: ${message}`);
  passed += 1;
}

function installVisibleInnerText(window: JSDOM['window']): void {
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement): string {
      const rendered = (node: Node): string => {
        if (node.nodeType === window.Node.TEXT_NODE) return node.nodeValue || '';
        if (node.nodeType !== window.Node.ELEMENT_NODE) return '';
        const element = node as HTMLElement;
        if (element.hidden || ['SCRIPT', 'STYLE', 'TEMPLATE'].includes(element.tagName)) return '';
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return '';
        return Array.from(element.childNodes).map(rendered).join(' ');
      };
      return rendered(this).replace(/\s+/g, ' ').trim();
    },
  });
}

async function main(): Promise<void> {
  const calls: Array<{ action: string; scope: string; ref?: string }> = [];
  let pageToken = 'page-a';
  const adapter: BrowserUsePageAdapter = {
    async observe(scope) {
      calls.push({ action: 'observe', scope: `${scope.owner}/${scope.runtimeKey}` });
      return {
        pageToken,
        url: 'https://example.test/form',
        title: 'Example form',
        viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 10, pageWidth: 1280, pageHeight: 1600 },
        text: 'Example form Submit Country',
        elements: [
          { token: '#name', tag: 'input', role: 'textbox', name: 'Name', editable: true, rect: { x: 20, y: 50, width: 300, height: 32 } },
          { token: '#country', tag: 'select', role: 'combobox', name: 'Country', options: ['CN', 'US'] },
          { token: '#submit', tag: 'button', role: 'button', name: 'Submit' },
        ],
      };
    },
    async act(scope, request) {
      calls.push({ action: request.action, scope: `${scope.owner}/${scope.runtimeKey}`, ref: request.element?.token });
      if (request.expectedPageToken !== pageToken) {
        return { ok: false, code: 'stale_page', error: 'Document changed', retryable: true, pageToken };
      }
      if (request.action === 'navigate') {
        pageToken = 'page-b';
        return { ok: true, pageToken, pageChanged: true, url: request.url, data: { navigated: true } };
      }
      if (request.action === 'extract') {
        return {
          ok: true,
          pageToken,
          data: {
            text: 'Public result',
            reasoning_content: 'never expose',
            nested: { thinking_delta: 'never expose either', selector: '#private', backendNodeId: 17, objectId: 'remote-1', value: 7 },
          },
        };
      }
      return { ok: true, pageToken, data: { action: request.action, token: request.element?.token, value: request.text || request.value || request.key } };
    },
  };

  const engine = new BrowserUseEngine(adapter, { now: (() => { let now = 1_000; return () => ++now; })() });
  const scopeA = { owner: 'conversation:alpha:root', runtimeKey: 'workspace:a::conversation:default' };
  const scopeB = { owner: 'conversation:beta:root', runtimeKey: 'workspace:b::conversation:default' };

  const observation = await engine.run({ ...scopeA, action: 'observe', actionId: 'observe-a' });
  assert(observation.ok && observation.action === 'observe', 'observe returns a successful structured receipt');
  assert(observation.pageGeneration === 1 && observation.sequence === 1, 'first observation assigns deterministic generation and sequence');
  assert(!!observation.observationId && observation.observationId.startsWith('observation-1-'), 'observe returns an opaque observation capability id');
  assert(observation.observation?.refs.map(ref => ref.ref).join(',') === 'r1,r2,r3', 'observe returns compact opaque refs');
  assert(observation.observation?.refs[0].editable === true && observation.observation?.refs[1].options?.length === 2, 'observe preserves safe interaction metadata');
  assert(!JSON.stringify(observation).includes('#submit'), 'observe never exposes adapter selectors or internal tokens');

  const click = await engine.run({ ...scopeA, action: 'click', actionId: 'click-a', pageGeneration: 1, observationId: observation.observationId, ref: 'r3' });
  assert(click.ok && click.action === 'click' && click.ref === 'r3', 'click resolves an observed ref');
  assert(calls.at(-1)?.ref === '#submit', 'engine resolves opaque ref to the adapter-only token');

  const duplicateClick = await engine.run({ ...scopeA, action: 'click', actionId: 'click-a', pageGeneration: 1, observationId: observation.observationId, ref: 'r3' });
  assert(duplicateClick === click, 'same action id returns the original receipt exactly once');
  assert(calls.filter(call => call.action === 'click').length === 1, 'idempotent replay does not execute click twice');

  let concurrentActive = 0;
  let maxConcurrentActive = 0;
  let concurrentClicks = 0;
  const concurrentOrder: string[] = [];
  const concurrencyAdapter: BrowserUsePageAdapter = {
    async observe() {
      concurrentActive += 1;
      maxConcurrentActive = Math.max(maxConcurrentActive, concurrentActive);
      concurrentOrder.push('observe');
      await new Promise<void>(resolve => setTimeout(resolve, 15));
      concurrentActive -= 1;
      return { pageToken: 'concurrent-page', url: 'https://concurrent.test/', title: 'Concurrent', text: 'Run', elements: [{ token: '#run', tag: 'button', role: 'button', name: 'Run' }] };
    },
    async act(_scope, request) {
      concurrentActive += 1;
      maxConcurrentActive = Math.max(maxConcurrentActive, concurrentActive);
      concurrentOrder.push(request.action);
      if (request.action === 'click') concurrentClicks += 1;
      await new Promise<void>(resolve => setTimeout(resolve, 15));
      concurrentActive -= 1;
      return { ok: true, pageToken: 'concurrent-page', data: { action: request.action } };
    },
  };
  const concurrencyEngine = new BrowserUseEngine(concurrencyAdapter);
  const concurrencyScope = { owner: 'concurrent-owner', runtimeKey: 'concurrent-runtime' };
  const concurrencyObservation = await concurrencyEngine.run({ ...concurrencyScope, action: 'observe', actionId: 'concurrent-observe' });
  const concurrentAction = { ...concurrencyScope, action: 'click' as const, actionId: 'concurrent-click', pageGeneration: concurrencyObservation.pageGeneration, observationId: concurrencyObservation.observationId, ref: 'r1' };
  const [concurrentFirst, concurrentSecond] = await Promise.all([
    concurrencyEngine.run(concurrentAction),
    concurrencyEngine.run(concurrentAction),
  ]);
  assert(concurrentFirst === concurrentSecond && concurrentClicks === 1, 'concurrent duplicate actionId shares one in-flight receipt and clicks exactly once');
  const orderStart = concurrentOrder.length;
  const queuedClick = concurrencyEngine.run({ ...concurrentAction, actionId: 'queued-click' });
  const queuedObserve = concurrencyEngine.run({ ...concurrencyScope, action: 'observe', actionId: 'queued-observe' });
  const [queuedClickReceipt, queuedObserveReceipt] = await Promise.all([queuedClick, queuedObserve]);
  assert(queuedClickReceipt.ok && queuedObserveReceipt.ok, 'per-scope action and observation queue both settle');
  assert(concurrentOrder.slice(orderStart).join(',') === 'click,observe', 'per-scope queue preserves arrival order across action and observe');
  assert(maxConcurrentActive === 1, 'page adapter is never entered concurrently for one owner/runtime scope');

  let cancellationObserved = false;
  let blockCancellationAction = true;
  let markCancellationStarted: (() => void) | null = null;
  const cancellationStarted = new Promise<void>(resolve => { markCancellationStarted = resolve; });
  const cancellationAdapter: BrowserUsePageAdapter = {
    async observe() {
      return { pageToken: 'cancel-page', url: 'https://cancel.test/', title: 'Cancel', text: '', elements: [] };
    },
    async act(_scope, request, signal) {
      if (!blockCancellationAction) return { ok: true, pageToken: request.action === 'navigate' ? 'cancel-page-2' : 'cancel-page' };
      markCancellationStarted?.();
      return await new Promise<never>((_resolve, reject) => {
        if (!signal) return reject(new Error('missing Browser-Use abort signal'));
        const abort = () => {
          cancellationObserved = true;
          reject(signal.reason instanceof Error ? signal.reason : new Error('Browser-Use action aborted'));
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
  };
  const cancellationEngine = new BrowserUseEngine(cancellationAdapter);
  const cancellationScope = { owner: 'cancel-owner', runtimeKey: 'cancel-runtime' };
  const cancelledAction = cancellationEngine.run({ ...cancellationScope, action: 'navigate', actionId: 'cancel-action', url: 'https://cancel.test/slow' });
  await cancellationStarted;
  cancellationEngine.clearRuntime(cancellationScope.runtimeKey);
  let cancelledActionRejected = false;
  try { await cancelledAction; } catch { cancelledActionRejected = true; }
  assert(cancelledActionRejected && cancellationObserved, 'clearRuntime aborts an in-flight adapter action instead of only discarding its result');
  blockCancellationAction = false;
  const retriedAfterCancellation = await cancellationEngine.run({ ...cancellationScope, action: 'navigate', actionId: 'cancel-action', url: 'https://cancel.test/retry' });
  assert(retriedAfterCancellation.ok, 'aborted action ids are not cached and can run in a fresh target session');

  const wrongScope = await engine.run({ ...scopeB, action: 'click', actionId: 'click-b', pageGeneration: 1, observationId: observation.observationId, ref: 'r3' });
  assert(!wrongScope.ok && wrongScope.code === 'observation_required', 'refs are owner and runtimeKey scoped');
  assert(calls.filter(call => call.action === 'click').length === 1, 'scope rejection occurs before adapter execution');

  const secondObservation = await engine.run({ ...scopeA, action: 'observe', actionId: 'observe-a2' });
  assert(secondObservation.ok && secondObservation.pageGeneration === 2, 'a fresh observation rotates the ref generation');
  const stale = await engine.run({ ...scopeA, action: 'type', actionId: 'stale-type', pageGeneration: 1, observationId: observation.observationId, ref: 'r1', text: 'Ada' });
  assert(!stale.ok && stale.code === 'stale_generation' && stale.retryable && stale.nextAction === 'observe', 'stale generation is rejected with recovery guidance');
  assert(calls.filter(call => call.action === 'type').length === 0, 'stale action never reaches the page adapter');
  const staleObservation = await engine.run({ ...scopeA, action: 'type', actionId: 'stale-observation', pageGeneration: 2, observationId: observation.observationId, ref: 'r1', text: 'Ada' });
  assert(!staleObservation.ok && staleObservation.code === 'stale_observation' && staleObservation.nextAction === 'observe', 'matching generation still requires the latest opaque observation id');

  const observationId2 = secondObservation.observationId;
  const type = await engine.run({ ...scopeA, action: 'type', actionId: 'type-a', pageGeneration: 2, observationId: observationId2, ref: 'r1', text: 'Ada' });
  const select = await engine.run({ ...scopeA, action: 'select', actionId: 'select-a', pageGeneration: 2, observationId: observationId2, ref: 'r2', value: 'CN' });
  const scroll = await engine.run({ ...scopeA, action: 'scroll', actionId: 'scroll-a', pageGeneration: 2, observationId: observationId2, deltaY: 640 });
  const key = await engine.run({ ...scopeA, action: 'key', actionId: 'key-a', pageGeneration: 2, observationId: observationId2, key: 'Enter' });
  const wait = await engine.run({ ...scopeA, action: 'wait', actionId: 'wait-a', pageGeneration: 2, observationId: observationId2, durationMs: 250 });
  assert([type, select, scroll, key, wait].every(receipt => receipt.ok), 'type/select/scroll/key/wait actions execute through the protocol');

  const extract = await engine.run({ ...scopeA, action: 'extract', actionId: 'extract-a', pageGeneration: 2, observationId: observationId2, ref: 'r3', maxChars: 2000 });
  const extractJson = JSON.stringify(extract);
  assert(extract.ok && extract.data && extractJson.includes('Public result'), 'extract returns structured public data');
  assert(!extractJson.includes('reasoning_content') && !extractJson.includes('thinking_delta') && !extractJson.includes('never expose'), 'receipts strip hidden-reasoning fields recursively');
  assert(!extractJson.includes('#private') && !extractJson.includes('backendNodeId') && !extractJson.includes('objectId'), 'receipts strip internal page locators recursively');

  const unsafeNavigate = await engine.run({ ...scopeA, action: 'navigate', actionId: 'nav-unsafe', url: 'javascript:alert(1)' });
  assert(!unsafeNavigate.ok && unsafeNavigate.code === 'unsafe_navigation', 'navigate rejects executable URL schemes');
  const safeNavigate = await engine.run({ ...scopeA, action: 'navigate', actionId: 'nav-safe', url: 'example.test/next' });
  assert(safeNavigate.ok && safeNavigate.url === 'https://example.test/next' && safeNavigate.pageGeneration === 3, 'safe navigation normalizes URL and invalidates old refs');
  const afterNavigate = await engine.run({ ...scopeA, action: 'click', actionId: 'after-nav', pageGeneration: 2, observationId: observationId2, ref: 'r3' });
  assert(!afterNavigate.ok && afterNavigate.code === 'observation_required', 'navigation requires a new observation before ref actions');

  const missingRef = await engine.run({ ...scopeA, action: 'click', actionId: 'missing-ref', pageGeneration: 3, observationId: observationId2, ref: 'r99' });
  assert(!missingRef.ok && missingRef.code === 'observation_required', 'no ref action runs until the new page is observed');

  const observedNewPage = await engine.run({ ...scopeA, action: 'observe', actionId: 'observe-b' });
  assert(observedNewPage.ok && observedNewPage.pageGeneration === 4, 'post-navigation observation issues a new capability generation');
  const invalidType = await engine.run({ ...scopeA, action: 'type', actionId: 'invalid-type', pageGeneration: 4, observationId: observedNewPage.observationId, ref: 'r3', text: 'x' });
  assert(!invalidType.ok && invalidType.code === 'invalid_ref_role', 'type rejects a non-editable ref before page execution');
  pageToken = 'page-c';
  const documentChanged = await engine.run({ ...scopeA, action: 'click', actionId: 'doc-changed', pageGeneration: 4, observationId: observedNewPage.observationId, ref: 'r3' });
  assert(!documentChanged.ok && documentChanged.code === 'stale_page' && documentChanged.nextAction === 'observe', 'adapter page-token mismatch is returned as recoverable stale page');

  const observedForWait = await engine.run({ ...scopeA, action: 'observe', actionId: 'observe-c' });
  const boundedWait = await engine.run({ ...scopeA, action: 'wait', actionId: 'bad-wait', pageGeneration: observedForWait.pageGeneration, observationId: observedForWait.observationId, durationMs: 60_000 });
  assert(!boundedWait.ok && boundedWait.code === 'invalid_request', 'wait duration is bounded');

  assert(observation.startedAt <= observation.finishedAt && observation.durationMs >= 0, 'receipts include timing metadata');
  assert(observation.owner === scopeA.owner && observation.runtimeKey === scopeA.runtimeKey, 'receipts retain their explicit scope');

  const dom = new JSDOM(`<!doctype html><html><body>
    <label for="native-name">Name</label><input id="native-name" aria-label="Name" placeholder="Name" data-secret="DATA_ATTRIBUTE_SECRET" onclick="window.__secret = true" style="color:red">
    <select id="native-country"><option value="OPTION_VALUE_SECRET_CN">China</option><option value="OPTION_VALUE_SECRET_US">United States</option></select>
    <button id="native-submit" aria-label="Submit" data-secret="DATA_ATTRIBUTE_SECRET" onclick="window.__secret = true" style="color:red">Submit<span style="display:none">HIDDEN_CHILD_SECRET</span></button>
    <input id="native-password" type="password" aria-label="Password" value="PASSWORD_VALUE_SECRET">
    <textarea id="native-private-notes" aria-label="Private notes">TEXTAREA_VALUE_SECRET</textarea>
    <div id="native-private-editor" contenteditable="true" aria-label="Private editor">CONTENTEDITABLE_VALUE_SECRET</div>
    <p id="native-result">Public DOM result<span hidden>HIDDEN_RESULT_SECRET</span></p>
    <div hidden>HIDDEN_BODY_SECRET</div>
    <script>globalThis.__pageSecret = 'SCRIPT_BODY_SECRET'</script>
  </body></html>`, { url: 'https://native.test/form', runScripts: 'outside-only', pretendToBeVisual: true });
  installVisibleInnerText(dom.window);
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 768 });
  for (const [index, element] of Array.from(dom.window.document.querySelectorAll('input,select,button,textarea,[contenteditable]')).entries()) {
    (element as HTMLElement).getBoundingClientRect = () => ({ x: 20, y: 20 + index * 50, width: 240, height: 32, top: 20 + index * 50, right: 260, bottom: 52 + index * 50, left: 20, toJSON: () => ({}) });
  }
  let nativePageGeneration = 1;
  let nativeClicks = 0;
  let nativeKeys = 0;
  let nativeSerializedTransactions = 0;
  const nativeAdapter = new NativeBrowserUsePageAdapter(async () => ({
    identity: async () => ({ pageToken: `native:${nativePageGeneration}`, url: dom.window.location.href, title: dom.window.document.title || 'Native' }),
    evaluateFixed: async <T>(script: string): Promise<T> => dom.window.eval(script) as T,
    clickAt: async () => { nativeClicks += 1; },
    replaceFocusedText: async text => {
      const active = dom.window.document.activeElement as HTMLInputElement | null;
      if (active && 'value' in active) active.value = text;
    },
    pressKey: async () => { nativeKeys += 1; },
    navigate: async url => { dom.reconfigure({ url }); nativePageGeneration += 1; },
    waitForReady: async () => undefined,
    serialized: async (_action, run) => {
      nativeSerializedTransactions += 1;
      return await run();
    },
    guarded: async (_action, run) => ({ value: await run(), effects: { popupBlocked: true, downloadBlocked: true } }),
  }));
  const nativeObservation = await nativeAdapter.observe(scopeA, { maxChars: 2000, maxRefs: 20 });
  assert(nativeObservation.pageToken === 'native:1' && nativeObservation.elements.length === 6, 'native fixed-script adapter observes visible interactive DOM elements without dropping private editable controls');
  const publicObservationJson = JSON.stringify(nativeObservation);
  assert(!/OPTION_VALUE_SECRET|DATA_ATTRIBUTE_SECRET|PASSWORD_VALUE_SECRET|TEXTAREA_VALUE_SECRET|CONTENTEDITABLE_VALUE_SECRET|HIDDEN_(?:CHILD|RESULT|BODY)_SECRET|SCRIPT_BODY_SECRET/.test(publicObservationJson), 'native observation exposes only rendered text and visible select labels, never hidden DOM text or editable/form values');
  assert(nativeSerializedTransactions === 1, 'native adapter serializes the complete observation transaction at the physical-page boundary');
  assert(nativeObservation.elements.every(element => element.token.includes(':nth-of-type(')), 'native adapter uses private deterministic DOM paths as internal tokens');
  const nativeClick = await nativeAdapter.act(scopeA, { action: 'click', expectedPageToken: 'native:1', element: nativeObservation.elements[2] });
  assert(nativeClick.ok && nativeClicks === 1 && nativeClick.effects?.popupBlocked === true, 'native adapter performs guarded coordinate click and reports blocked side effects');
  assert(Number(nativeSerializedTransactions) === 2, 'native adapter serializes identity, probe, input, and final identity as one physical-page action transaction');
  const originalButton = dom.window.document.getElementById('native-submit')!;
  const replacementButton = dom.window.document.createElement('button');
  replacementButton.id = 'native-submit';
  replacementButton.getBoundingClientRect = originalButton.getBoundingClientRect.bind(originalButton);
  originalButton.replaceWith(replacementButton);
  const replacedRef = await nativeAdapter.act(scopeA, { action: 'click', expectedPageToken: 'native:1', element: nativeObservation.elements[2] });
  assert(!replacedRef.ok && replacedRef.code === 'ref_not_found' && nativeClicks === 1, 'same DOM path and tag with a missing observed name is rejected before click');
  const nativeType = await nativeAdapter.act(scopeA, { action: 'type', expectedPageToken: 'native:1', element: nativeObservation.elements[0], text: 'Grace' });
  assert(nativeType.ok && (dom.window.document.getElementById('native-name') as HTMLInputElement).value === 'Grace', 'native adapter focuses the observed ref before trusted host text replacement');
  const nativeSelect = await nativeAdapter.act(scopeA, { action: 'select', expectedPageToken: 'native:1', element: nativeObservation.elements[1], value: 'United States' });
  assert(nativeSelect.ok && (dom.window.document.getElementById('native-country') as HTMLSelectElement).value === 'OPTION_VALUE_SECRET_US' && !JSON.stringify(nativeSelect).includes('OPTION_VALUE_SECRET'), 'native adapter selects by visible option label without returning its internal value');
  const nativeExtract = await nativeAdapter.act(scopeA, { action: 'extract', expectedPageToken: 'native:1', maxChars: 2000 });
  assert(nativeExtract.ok && JSON.stringify(nativeExtract.data).includes('Public DOM result'), 'native adapter extracts bounded visible page text without caller script');
  assert(!/HIDDEN_(?:CHILD|RESULT|BODY)_SECRET|SCRIPT_BODY_SECRET|PASSWORD_VALUE_SECRET|TEXTAREA_VALUE_SECRET|CONTENTEDITABLE_VALUE_SECRET/.test(JSON.stringify(nativeExtract)), 'whole-page extraction excludes hidden, script, child-hidden, password, textarea, and contenteditable values');
  const nativeEngine = new BrowserUseEngine(nativeAdapter);
  const publicCapability = await nativeEngine.run({ ...scopeA, action: 'observe', actionId: 'native-public-observe' });
  const nameRef = publicCapability.observation?.refs.find(item => item.name === 'Name')?.ref || '';
  const passwordRef = publicCapability.observation?.refs.find(item => item.name === 'Password')?.ref || '';
  const privateNotesRef = publicCapability.observation?.refs.find(item => item.name === 'Private notes')?.ref || '';
  const privateEditorRef = publicCapability.observation?.refs.find(item => item.name === 'Private editor')?.ref || '';
  assert(privateNotesRef && privateEditorRef, 'private textarea and contenteditable controls remain addressable through opaque refs and public labels');
  const privateEditableExtracts = await Promise.all([privateNotesRef, privateEditorRef].map(async (ref, index) => await nativeEngine.run({
    ...scopeA,
    action: 'extract',
    actionId: `native-private-editable-${index}`,
    pageGeneration: publicCapability.pageGeneration,
    observationId: publicCapability.observationId,
    ref,
  })));
  assert(privateEditableExtracts.every(receipt => receipt.ok && !/TEXTAREA_VALUE_SECRET|CONTENTEDITABLE_VALUE_SECRET/.test(JSON.stringify(receipt))), 'extracting a private editable ref returns no textarea/contenteditable value');
  const rejectedAttributes = await Promise.all(['data-secret', 'onclick', 'style', 'value'].map(async attribute => await nativeEngine.run({
    ...scopeA,
    action: 'extract',
    actionId: `native-private-${attribute}`,
    pageGeneration: publicCapability.pageGeneration,
    observationId: publicCapability.observationId,
    ref: attribute === 'value' ? passwordRef : nameRef,
    attribute,
  })));
  assert(rejectedAttributes.every(receipt => !receipt.ok && receipt.code === 'invalid_request'), 'extract rejects data, event, style, and value attributes before page execution');
  const publicAria = await nativeEngine.run({
    ...scopeA,
    action: 'extract',
    actionId: 'native-public-aria',
    pageGeneration: publicCapability.pageGeneration,
    observationId: publicCapability.observationId,
    ref: nameRef,
    attribute: 'aria-label',
  });
  assert(publicAria.ok && (publicAria.data as { text?: string })?.text === 'Name', 'extract permits a strict public accessibility attribute');
  const nativeKey = await nativeAdapter.act(scopeA, { action: 'key', expectedPageToken: 'native:1', key: 'Enter' });
  assert(nativeKey.ok && nativeKeys === 1, 'native adapter delegates key injection to the host boundary');
  const nativeNavigate = await nativeAdapter.act(scopeA, { action: 'navigate', expectedPageToken: 'native:1', url: 'https://native.test/next' });
  assert(nativeNavigate.ok && nativeNavigate.pageChanged && nativeNavigate.pageToken === 'native:2', 'native adapter reports a new document token after navigation');
  const nativeStale = await nativeAdapter.act(scopeA, { action: 'click', expectedPageToken: 'native:1', element: nativeObservation.elements[2] });
  assert(!nativeStale.ok && nativeStale.code === 'stale_page' && nativeClicks === 1, 'native adapter rejects stale documents before input injection');

  const toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-browser-use-tool-'));
  temporaryRoots.add(toolRoot);
  const config = new ConfigManager(toolRoot);
  const tools = new ToolExecutor(toolRoot, config);
  const definition = tools.definitions().find((item: any) => item.function?.name === 'browser_use') as any;
  assert(!!definition && definition.function.parameters.required.includes('action'), 'ToolExecutor exposes browser_use with an action schema');
  assert(!Object.prototype.hasOwnProperty.call(definition.function.parameters.properties, 'owner') && !Object.prototype.hasOwnProperty.call(definition.function.parameters.properties, 'runtime_key'), 'model schema cannot supply owner or runtimeKey');
  const planDefinition = tools.definitions('plan').find((item: any) => item.function?.name === 'browser_use') as any;
  assert(JSON.stringify(planDefinition.function.parameters.properties.action.enum) === JSON.stringify(['observe', 'navigate', 'wait', 'extract']), 'Plan mode only exposes read-only Browser-Use actions');

  const capturedRequests: BrowserUseRequest[] = [];
  BrowserUse.setBackend({
    async run(request): Promise<BrowserUseReceipt> {
      capturedRequests.push(request);
      const now = Date.now();
      return {
        ok: true,
        action: request.action,
        actionId: request.actionId || 'tool-action',
        owner: request.owner,
        runtimeKey: request.runtimeKey,
        sequence: 1,
        pageGeneration: 1,
        observationId: 'tool-observation',
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        observation: { url: 'https://tool.test/', title: 'Tool', text: 'tool text', refs: [], truncated: false },
      };
    },
  });
  const toolOutput = await tools.execute('browser_use', JSON.stringify({
    action: 'observe',
    action_id: 'tool-observe',
  }), toolRoot, {
    workspaceId: 'workspace-alpha',
    conversationId: 'default',
    actorId: 'root',
    runtimeKey: 'workspace:trusted::conversation:default',
    workspacePath: toolRoot,
  });
  assert(toolOutput.includes('tool-observation') && capturedRequests.at(-1)?.action === 'observe', 'ToolExecutor routes browser_use and formats its structured receipt');
  assert(capturedRequests.at(-1)?.runtimeKey === 'workspace:trusted::conversation:default' && capturedRequests.at(-1)?.owner === 'browser-use:workspace:trusted::conversation:default:actor:root', 'ToolExecutor derives scope only from trusted execution context');
  const callsBeforeBlockedPlan = capturedRequests.length;
  const blockedPlan = await tools.execute('browser_use', JSON.stringify({ action: 'click', page_generation: 1, observation_id: 'x', ref: 'r1' }), toolRoot, { mode: 'plan', runtimeKey: 'plan-runtime', conversationId: 'default' });
  assert(blockedPlan.includes('Plan mode only allows Browser-Use') && capturedRequests.length === callsBeforeBlockedPlan, `runtime policy blocks hidden mutating Browser-Use calls in Plan mode: ${blockedPlan}`);
  const allowedPlan = await tools.execute('browser_use', JSON.stringify({ action: 'observe' }), toolRoot, { mode: 'plan', runtimeKey: 'plan-runtime', conversationId: 'default' });
  assert(allowedPlan.includes('tool-observation') && capturedRequests.at(-1)?.runtimeKey === 'plan-runtime', 'Plan mode can execute Browser-Use observe');
  BrowserUse.setBackend(null);

  let wslEnvelope: any = null;
  configureWslHostToolWriter(value => { wslEnvelope = value; });
  const wslBound = bindBrowserUseRequest({ action: 'observe', owner: 'spoof', runtimeKey: 'spoof' }, {
    runtimeKey: 'workspace:wsl::conversation:default',
    actorId: 'wsl-root',
  });
  const wslPromise = requestWindowsHostTool('browser_use', wslBound, {
    conversationId: 'default',
    workspaceId: 'Workspace WSL',
    actorId: 'wsl-root',
    runtimeKey: wslBound.runtimeKey,
    mode: 'plan',
  });
  assert(wslEnvelope?.event === 'host_tool_request' && wslEnvelope.data?.tool === 'browser_use', 'WSL bridge emits a dedicated Browser-Use host-tool request');
  assert(wslEnvelope.data.context.runtimeKey === wslBound.runtimeKey && wslEnvelope.data.context.mode === 'plan' && wslEnvelope.data.args.owner === wslBound.owner, 'WSL Browser-Use request carries trusted target, actor scope, and execution mode');
  const wslNow = Date.now();
  const wslReceipt: BrowserUseReceipt = {
    ok: true,
    action: 'observe',
    actionId: wslBound.actionId || 'wsl-observe',
    owner: wslBound.owner,
    runtimeKey: wslBound.runtimeKey,
    sequence: 1,
    pageGeneration: 1,
    startedAt: wslNow,
    finishedAt: wslNow,
    durationMs: 0,
  };
  assert(settleWslHostToolResult({ requestId: wslEnvelope.data.requestId, ok: true, result: wslReceipt }), 'WSL Browser-Use host receipt settles the pending bridge request');
  assert((await wslPromise as BrowserUseReceipt).runtimeKey === wslBound.runtimeKey, 'WSL bridge returns the target-bound structured receipt');
  const wslCancelEvents: any[] = [];
  configureWslHostToolWriter(value => { wslCancelEvents.push(value); });
  const wslAbortController = new AbortController();
  const wslAbortPromise = requestWindowsHostTool('browser_use', wslBound, {
    conversationId: 'default', workspaceId: 'Workspace WSL', actorId: 'wsl-root', runtimeKey: wslBound.runtimeKey, mode: 'build',
  }, 30_000, wslAbortController.signal).then(() => false, () => true);
  const wslAbortRequestId = wslCancelEvents[0]?.data?.requestId;
  wslAbortController.abort(new Error('wsl browser abort test'));
  assert(await wslAbortPromise && wslCancelEvents.at(-1)?.event === 'host_tool_cancel' && wslCancelEvents.at(-1)?.data?.requestId === wslAbortRequestId, 'WSL bridge rejects graceful abort and asks the Windows host to cancel the exact pending Browser-Use call');
  const wslTimeoutPromise = requestWindowsHostTool('browser_use', wslBound, {
    conversationId: 'default', workspaceId: 'Workspace WSL', actorId: 'wsl-root', runtimeKey: wslBound.runtimeKey, mode: 'build',
  }, 15).then(() => false, () => true);
  const wslTimeoutRequestId = wslCancelEvents.at(-1)?.data?.requestId;
  assert(await wslTimeoutPromise && wslCancelEvents.at(-1)?.event === 'host_tool_cancel' && wslCancelEvents.at(-1)?.data?.requestId === wslTimeoutRequestId, 'WSL bridge timeout cancels the exact host operation instead of only deleting local pending state');
  configureWslHostToolWriter(null);

  const routedBrowserUse: BrowserUseRequest[] = [];
  const routedBrowserSignals: Array<AbortSignal | undefined> = [];
  const cancelledBrowserTargets: string[] = [];
  const toolEnableChecks: string[] = [];
  let browserUseEnabled = false;
  const utilityHandler = createUtilityHostToolHandler({
    persistenceRoot: toolRoot,
    runAutomation: async () => '',
    isToolEnabled: toolName => {
      toolEnableChecks.push(toolName);
      return toolName !== 'browser_use' || browserUseEnabled;
    },
    runBrowserUse: async (request, signal) => {
      routedBrowserUse.push(request);
      routedBrowserSignals.push(signal);
      const now = Date.now();
      return {
        ok: true,
        action: request.action,
        actionId: request.actionId || 'utility-action',
        owner: request.owner,
        runtimeKey: request.runtimeKey,
        sequence: 1,
        pageGeneration: 1,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
      };
    },
    cancelBrowserUseTarget: runtimeKey => { cancelledBrowserTargets.push(runtimeKey); },
  });
  const alphaTarget = { workspaceId: 'Alpha', conversationId: 'default', runtimeKey: 'workspace:alpha::conversation:default', workspaceKey: 'workspace:alpha', workspacePath: 'C:\\alpha' };
  const betaTarget = { workspaceId: 'Beta', conversationId: 'default', runtimeKey: 'workspace:beta::conversation:default', workspaceKey: 'workspace:beta', workspacePath: 'C:\\beta' };
  const utilityContext = (target: typeof alphaTarget, mode = 'build') => ({
    conversationId: target.conversationId,
    workspaceId: target.workspaceId,
    actorId: 'actor-background',
    workspacePath: target.workspacePath,
    backend: 'utility',
    mode,
    runtimeKey: target.runtimeKey,
  });
  let rejectedDisabledBrowserUse = false;
  try {
    await utilityHandler({ requestId: 'utility-disabled', tool: 'browser_use', args: { ...wslBound, action: 'observe' }, target: alphaTarget, context: utilityContext(alphaTarget) });
  } catch { rejectedDisabledBrowserUse = true; }
  assert(rejectedDisabledBrowserUse && routedBrowserUse.length === 0 && toolEnableChecks.at(-1) === 'browser_use',
    'host router rechecks the live native-tool setting before Browser-Use reaches the main-process engine');
  browserUseEnabled = true;
  const utilityAbortController = new AbortController();
  await utilityHandler({ requestId: 'utility-alpha', tool: 'browser_use', args: { ...wslBound, runtimeKey: 'model-spoof', owner: 'model-spoof', action: 'observe' }, target: alphaTarget, context: utilityContext(alphaTarget) }, utilityAbortController.signal);
  await utilityHandler({ requestId: 'utility-beta', tool: 'browser_use', args: { ...wslBound, runtimeKey: alphaTarget.runtimeKey, owner: 'cross-target-spoof', action: 'observe' }, target: betaTarget, context: utilityContext(betaTarget) });
  assert(routedBrowserUse[0].runtimeKey === alphaTarget.runtimeKey && routedBrowserUse[1].runtimeKey === betaTarget.runtimeKey, 'utility router binds two background default conversations to their verified workspace runtime keys');
  assert(routedBrowserUse[0].owner.includes(':actor:actor-background') && routedBrowserUse[0].owner !== routedBrowserUse[1].owner, 'utility router derives actor owners and prevents cross-workspace owner reuse');
  assert(routedBrowserSignals[0] === utilityAbortController.signal, 'utility router forwards its worker-generation abort signal into the Browser-Use engine');
  let rejectedPlanMutation = false;
  try {
    await utilityHandler({ requestId: 'utility-plan-click', tool: 'browser_use', args: { ...wslBound, action: 'click', ref: 'r1' }, target: alphaTarget, context: utilityContext(alphaTarget, 'plan') });
  } catch { rejectedPlanMutation = true; }
  assert(rejectedPlanMutation && Number(routedBrowserUse.length) === 2, 'host router rejects a forged mutating Browser-Use RPC from a Plan worker');
  await utilityHandler({ requestId: 'utility-plan-observe', tool: 'browser_use', args: { ...wslBound, action: 'observe' }, target: alphaTarget, context: utilityContext(alphaTarget, 'plan') });
  assert(Number(routedBrowserUse.length) === 3 && routedBrowserUse.at(-1)?.action === 'observe', 'host router allows a read-only Browser-Use observe RPC in Plan mode');
  let rejectedUtilityMismatch = false;
  try {
    await utilityHandler({ requestId: 'utility-mismatch', tool: 'browser_use', args: wslBound, target: alphaTarget, context: { ...utilityContext(alphaTarget), runtimeKey: betaTarget.runtimeKey } });
  } catch { rejectedUtilityMismatch = true; }
  assert(rejectedUtilityMismatch && Number(routedBrowserUse.length) === 3, 'utility router rejects a runtime context mismatch before the Browser-Use engine');
  utilityHandler.cancelTarget(alphaTarget.runtimeKey);
  assert(cancelledBrowserTargets[0] === alphaTarget.runtimeKey, 'utility force-restart cleanup clears only the target Browser-Use runtime');

  let utilityEnvelope: any = null;
  const utilityCancelIds: string[] = [];
  configureUtilityHostToolBridge(value => { utilityEnvelope = value; }, () => alphaTarget, requestId => { utilityCancelIds.push(requestId); });
  const utilityBridgePromise = requestUtilityHostTool('browser_use', wslBound, { ...utilityContext(betaTarget), actorId: 'bridge-actor' });
  assert(utilityEnvelope.target.runtimeKey === alphaTarget.runtimeKey && utilityEnvelope.context.runtimeKey === alphaTarget.runtimeKey, 'utility bridge overwrites stale caller target context from its trusted target provider');
  assert(utilityEnvelope.context.workspaceId === alphaTarget.workspaceId && utilityEnvelope.context.conversationId === alphaTarget.conversationId, 'utility bridge binds workspace and conversation identity before IPC');
  settleUtilityHostToolResult({ requestId: utilityEnvelope.requestId, ok: true, result: wslReceipt });
  await utilityBridgePromise;
  const utilityBridgeAbortController = new AbortController();
  const utilityAbortPromise = requestUtilityHostTool('browser_use', wslBound, { ...utilityContext(alphaTarget), actorId: 'bridge-actor' }, 30_000, utilityBridgeAbortController.signal).then(() => false, () => true);
  const utilityAbortRequestId = utilityEnvelope.requestId;
  utilityBridgeAbortController.abort(new Error('utility browser abort test'));
  assert(await utilityAbortPromise && utilityCancelIds.at(-1) === utilityAbortRequestId, 'utility bridge rejects graceful abort and asks Electron main to cancel the exact pending Browser-Use call');
  const utilityTimeoutPromise = requestUtilityHostTool('browser_use', wslBound, { ...utilityContext(alphaTarget), actorId: 'bridge-actor' }, 1_000).then(() => false, () => true);
  const utilityTimeoutRequestId = utilityEnvelope.requestId;
  assert(await utilityTimeoutPromise && utilityCancelIds.at(-1) === utilityTimeoutRequestId, 'utility bridge timeout cancels the exact main-process host operation instead of orphaning it');
  configureUtilityHostToolBridge(null);

  console.log(`BROWSER_USE_VERIFY_OK assertions=${passed}`);
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    BrowserUse.setBackend(null);
    configureUtilityHostToolBridge(null);
    configureWslHostToolWriter(null);
    for (const root of temporaryRoots) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (error) {
        console.error(`BROWSER_USE_VERIFY_CLEANUP_FAIL ${root}: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    }
    temporaryRoots.clear();
  });
