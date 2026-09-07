import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

function uiScriptSource(): string {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'index.html'), 'utf-8');
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  if (!match) throw new Error('UI script was not found');
  return match[1];
}

function assignedFunctionSource(source: string, memberName: string): string {
  const file = ts.createSourceFile('newmark-ui.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = '';
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && node.left.getText(file) === `window.${memberName}`
      && (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right))) {
      found = node.right.getText(file);
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`UI assignment was not found: window.${memberName}`);
  return found;
}

function verifyVisibleBlockAnchoring(source: string): void {
  const ast = ts.createSourceFile('newmark-ui.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const wire = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'wireDirectLiquidMenuInteractionsV2');
  assert.ok(wire && ts.isFunctionDeclaration(wire), 'real liquid selection initializer is available');
  for (const optionClass of ['newmark-select-option', 'model-select-menu-option']) {
    const dom = new JSDOM(`<!doctype html><body><button id="trigger">Open</button><div id="menu" class="liquid-glass-popup"><button class="${optionClass}">One</button><button class="${optionClass} selected">Two</button><button class="${optionClass}">Three</button></div></body>`, { pretendToBeVisual: true });
    const win = dom.window;
    const menu = win.document.getElementById('menu') as HTMLElement & { _liquidColorBlock: HTMLElement; _liquidSyncSelectedBlock(): void };
    const button = win.document.getElementById('trigger') as HTMLElement;
    let visible = false, triggerWidth = 180;
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
    button.getBoundingClientRect = () => rect(130, 110, triggerWidth, 32);
    menu.getClientRects = () => (visible ? [rect(130, 150, triggerWidth, 120)] : []) as unknown as DOMRectList;
    Object.defineProperty(menu, 'scrollHeight', { get: () => visible ? 120 : 0 });
    Object.defineProperty(menu, 'offsetHeight', { get: () => visible ? 120 : 0 });
    const rows = Array.from(menu.querySelectorAll('button'));
    rows.forEach((row, index) => {
      row.getClientRects = () => (visible ? [rect(136, 150 + 8 + index * 38, triggerWidth - 12, 32)] : []) as unknown as DOMRectList;
      const dimensions: Record<string, () => number> = { offsetLeft: () => 6, offsetTop: () => 8 + index * 38, offsetWidth: () => parseFloat(menu.style.width || '0') - 12, offsetHeight: () => 32 };
      for (const [key, value] of Object.entries(dimensions)) {
        Object.defineProperty(row, key, { get: () => visible ? value() : 0 });
      }
    });
    menu.setPointerCapture = () => {};
    menu.releasePointerCapture = () => {};
    const frames: FrameRequestCallback[] = [];
    const timers = new Map<number, {callback: () => void; due: number}>();
    let timerId = 0, clock = 0;
    const advance = (elapsed: number) => {
      clock += elapsed;
      for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); }
    };
    const factory = new Function('window', 'document', 'getComputedStyle', 'requestAnimationFrame', 'setTimeout', 'clearTimeout', `
      function setLiquidPopupPressDeformation() {}
      function setLiquidPopupDeformation() {}
      ${source.match(/var LIQUID_HOLD_DRAG_ACTIVATION_MS = \d+;/)?.[0] || ''}
      ${wire.getText(ast)}
      window.positionSelectPopup = ${assignedFunctionSource(source, 'positionSelectPopup')};
      return wireDirectLiquidMenuInteractionsV2;
    `);
    const initialize = factory(win, win.document, win.getComputedStyle.bind(win), (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }, (callback: () => void, delay: number) => { timers.set(++timerId, {callback, due: clock + Number(delay || 0)}); return timerId; }, (id: number) => timers.delete(id)) as (menu: HTMLElement) => void;
    const position = () => (win as unknown as { positionSelectPopup(button: HTMLElement, menu: HTMLElement): void }).positionSelectPopup(button, menu);
    const geometry = () => [menu._liquidColorBlock.style.left, menu._liquidColorBlock.style.top, menu._liquidColorBlock.style.width, menu._liquidColorBlock.style.height];
    const pointer = (type: string, target: EventTarget) => { const event = new win.MouseEvent(type, { button: 0, clientX: 150, clientY: 240, bubbles: true }); Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: 'mouse' } }); target.dispatchEvent(event); };
    try {
      initialize(menu);
      const block = menu._liquidColorBlock;
      assert.ok(block?.isConnected, `${optionClass}: hidden setup creates one reusable block`);
      assert.equal(block.style.width, '', `${optionClass}: hidden zero geometry is never stored as the source`);
      block.style.transition = 'left 240ms';
      const flushes: string[] = [];
      Object.defineProperty(block, 'offsetWidth', { get: () => { flushes.push(block.style.transition); return parseFloat(block.style.width || '0'); } });
      visible = true;
      position();
      assert.deepEqual(geometry(), ['6px', '46px', '168px', '32px'], `${optionClass}: final visible popup width initializes the selected row source`);
      assert.equal(flushes.at(-1), 'none', `${optionClass}: idle anchor is committed without a fictitious transition`);
      assert.equal(block.style.transition, 'left 240ms', `${optionClass}: initialization restores the existing animation contract`);
      visible = false;
      initialize(menu);
      assert.equal(menu._liquidColorBlock, block, `${optionClass}: a hidden rerender reuses the block`);
      assert.deepEqual(geometry(), ['6px', '46px', '168px', '32px'], `${optionClass}: hidden rerender cannot replace valid geometry with zero`);
      triggerWidth = 220;
      visible = true;
      position();
      assert.deepEqual(geometry(), ['6px', '46px', '208px', '32px'], `${optionClass}: reopening anchors to the newly measured popup width`);
      pointer('pointerdown', rows[2]);
      const beforeHold = geometry();
      advance(79);
      assert.equal(block.classList.contains('liquid-block-lifted'), false, `${optionClass}: 79ms is still the initial press`);
      assert.deepEqual(geometry(), beforeHold, `${optionClass}: the source does not move before activation`);
      advance(1);
      assert.equal(block.classList.contains('liquid-block-lifted'), true, `${optionClass}: the real timer activates pickup at 80ms`);
      pointer('pointercancel', win);
      assert.equal(block.classList.contains('liquid-block-lifted'), false, `${optionClass}: cancellation clears the activated pickup`);
      frames.length = 0; timers.clear();
      pointer('pointerdown', rows[2]);
      advance(79); pointer('pointercancel', win); advance(1);
      assert.equal(block.classList.contains('liquid-block-lifted'), false, `${optionClass}: cancelling before 80ms never activates a late drag`);
      frames.length = 0; timers.clear(); position();
      pointer('pointerdown', rows[2]);
      const duringPointer = geometry();
      triggerWidth = 260;
      position();
      assert.deepEqual(geometry(), duringPointer, `${optionClass}: active pointer owns its geometry during popup positioning`);
      pointer('pointerup', win);
      assert.ok(menu.dataset.liquidPendingCommit, `${optionClass}: the real release path starts the deferred commit flight`);
      while (frames.length) frames.shift()!(0);
      const duringFlight = geometry();
      position();
      assert.deepEqual(geometry(), duringFlight, `${optionClass}: visible layout refresh never reanchors an in-flight block to the old selection`);
      assert.equal(menu.querySelectorAll('.liquid-menu-color-block').length, 1, `${optionClass}: reopen and flight preserve a single material block`);
    } finally {
      timers.clear();
      frames.length = 0;
      dom.window.close();
    }
  }
}

function main(): void {
  const source = uiScriptSource();
  const names = ['closeNewmarkSelect', 'positionSelectPopup', 'positionNewmarkSelectMenu', 'selectReadableControlWidth', 'syncNewmarkSelectWidth', 'syncNewmarkSelect', 'enhanceNewmarkSelect', 'enhanceNewmarkSelects'];
  const assignments = names.map(name => `window.${name} = ${assignedFunctionSource(source, name)};`).join('\n');
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="input-tools"><label for="mode-select">Mode</label><select id="mode-select"><option value="build">Build</option><option value="plan">Plan</option></select></div>
    <div id="dynamic"></div>
  </body></html>`, { pretendToBeVisual: true });
  const { window } = dom;
  const document = window.document;
  const factory = new Function('window', 'document', 'MutationObserver', 'CSS', 'Event', 'requestAnimationFrame', `
    function esc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function escAttr(value) { return esc(value).replace(/"/g, '&quot;'); }
    function iconSvg() { return '<svg></svg>'; }
    function wireLiquidMenuInteractions(menu) { if (menu) menu.dataset.liquidInteractions = 'true'; }
    function wireDirectLiquidMenuInteractionsV2(menu) { if (menu) menu.dataset.liquidDirectOptions = 'true'; }
    window.closeModelSelectMenu = function() {};
    window.setLiquidSidebarGestureLock = function() {};
    ${assignments}
  `);
  factory(window, document, window.MutationObserver, window.CSS || { escape: (value: string) => value }, window.Event, (callback: FrameRequestCallback) => { callback(0); return 1; });

  const api = window as unknown as { enhanceNewmarkSelects(root: Document | Element): void };
  const nativeMode = document.getElementById('mode-select') as HTMLSelectElement;
  nativeMode.getBoundingClientRect = () => ({ left: 140, right: 212, top: 700, bottom: 740, width: 72, height: 40, x: 140, y: 700, toJSON() {} });
  api.enhanceNewmarkSelects(document);
  const mode = document.getElementById('mode-select') as HTMLSelectElement;
  const shell = mode.parentElement!;
  const button = shell.querySelector('.newmark-select-button') as HTMLButtonElement;
  assert.ok(shell.classList.contains('newmark-select-shell'), 'static select is enhanced');
  assert.ok(button.classList.contains('tool-select') && button.classList.contains('model-select-button'), 'generic closed control reuses the model selector glass button classes');
  assert.ok(parseFloat(shell.style.width) >= 80, 'toolbar enhancement widens short native controls enough to show their option text');
  assert.equal(shell.style.flex, `0 0 ${shell.style.width}`, 'toolbar enhancement preserves a fixed non-expanding readable layout slot');
  assert.equal(button.getAttribute('aria-label'), 'Mode', 'visible label becomes the custom button accessible name');
  assert.equal(button.querySelector('.newmark-select-button-label')?.textContent, 'Build');

  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  button.getBoundingClientRect = () => ({ left: 140, right: 272, top: 700, bottom: 740, width: 132, height: 40, x: 140, y: 700, toJSON() {} });
  const menu = shell.querySelector('.newmark-select-menu') as HTMLElement;
  Object.defineProperty(menu, 'scrollWidth', { configurable: true, value: 920 });
  Object.defineProperty(menu, 'scrollHeight', { configurable: true, value: 180 });
  Object.defineProperty(menu, 'offsetHeight', { configurable: true, value: 180 });
  (window as unknown as { positionNewmarkSelectMenu(shell: Element): void }).positionNewmarkSelectMenu(shell);
  assert.equal(menu.style.width, '132px', 'popup keeps a wide trigger width even when hidden scrollWidth is large');
  assert.equal(menu.style.left, '140px', 'floating popup keeps the trigger left edge without layout adaptation');
  assert.equal(menu.style.top, '512px', 'toolbar popup is a fixed overlay directly above the trigger');
  assert.equal(menu.dataset.popupDirection, 'up', 'shared popup positioning chooses the side with enough space');

  button.getBoundingClientRect = () => ({ left: 140, right: 272, top: 80, bottom: 120, width: 132, height: 40, x: 140, y: 80, toJSON() {} });
  (window as unknown as { positionNewmarkSelectMenu(shell: Element): void }).positionNewmarkSelectMenu(shell);
  assert.equal(menu.style.top, '128px', 'shared popup positioning opens below when lower space is available');
  assert.equal(menu.dataset.popupDirection, 'down', 'shared popup direction is exposed for regression checks');

  button.getBoundingClientRect = () => ({ left: 140, right: 209, top: 700, bottom: 740, width: 69, height: 40, x: 140, y: 700, toJSON() {} });
  (window as unknown as { positionNewmarkSelectMenu(shell: Element): void }).positionNewmarkSelectMenu(shell);
  assert.equal(menu.style.width, '112px', 'short triggers receive a readable popup width without resizing the trigger');

  button.click();
  assert.ok(shell.classList.contains('open'), 'first trigger click opens the popup');
  button.click();
  assert.ok(!shell.classList.contains('open'), 'second trigger click closes the popup');

  let changes = 0;
  mode.addEventListener('change', () => changes += 1);
  button.click();
  (shell.querySelector('[data-value="plan"]') as HTMLButtonElement).click();
  assert.equal(mode.value, 'plan', 'custom option updates the native value');
  assert.equal(changes, 1, 'custom option preserves the native change contract');
  assert.equal(button.querySelector('.newmark-select-button-label')?.textContent, 'Plan');

  const dynamic = document.getElementById('dynamic')!;
  const compactHost = document.createElement('div');
  compactHost.className = 'flow-comp-row';
  compactHost.innerHTML = '<select id="flow-type" style="flex:0.3"><option value="dialog">\u5bf9\u8bdd</option><option value="logic">\u903b\u8f91</option></select>';
  dynamic.appendChild(compactHost);
  const flowType = document.getElementById('flow-type') as HTMLSelectElement;
  flowType.getBoundingClientRect = () => ({ left: 20, right: 72, top: 20, bottom: 50, width: 52, height: 30, x: 20, y: 20, toJSON() {} });
  api.enhanceNewmarkSelects(compactHost);
  const flowShell = flowType.parentElement!;
  assert.ok(parseFloat(flowShell.style.minWidth) >= 80, 'compact Chinese dynamic select keeps enough width for the complete label and chevron');
  const flowButton = flowShell.querySelector('.newmark-select-button') as HTMLButtonElement;
  flowButton.click();
  flowButton.click();
  assert.ok(!flowShell.classList.contains('open'), 'dynamic select also closes on a repeated trigger click');

  dynamic.innerHTML = '<select id="workspace-select"><option value="a">Workspace A</option><option value="b">Workspace B</option></select>';
  api.enhanceNewmarkSelects(dynamic);
  assert.ok(document.getElementById('workspace-select')?.parentElement?.classList.contains('newmark-select-shell'), 'dynamic dialog select is enhanced');
  dom.window.close();
  verifyVisibleBlockAnchoring(source);
  console.log('Newmark select verification passed');
}

main();
