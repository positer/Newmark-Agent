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
    window.closeModelSelectMenu = function() {};
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
  console.log('Newmark select verification passed');
}

main();
