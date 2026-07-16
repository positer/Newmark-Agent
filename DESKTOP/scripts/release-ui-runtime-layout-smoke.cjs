const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error(message); };

function getJson(url) {
  return new Promise((resolve, reject) => http.get(url, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  }).on('error', reject));
}

async function target(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (page) return page;
    } catch {}
    await sleep(300);
  }
  fail('CDP target timeout');
}

function connect(page) {
  let nextId = 0;
  const pending = new Map();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result);
    };
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

(async () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const desktopRoot = path.join(repoRoot, 'DESKTOP');
  const electron = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkRuntimeLayout-'));
  const port = 49432 + Math.floor(Math.random() * 200);
  let child;
  let cdp;
  try {
    child = spawn(electron, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, 'ElectronData')}`, '--no-sandbox', '--no-devtools', '--root', root], { cwd: desktopRoot, stdio: 'ignore', windowsHide: true });
    cdp = connect(await target(port));
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(cdp, `typeof window.openSettings === 'function' && !!window.api`)) break;
      await sleep(200);
      if (attempt === 99) fail('renderer initialization timeout');
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(cdp, `!!document.querySelector('#left-ws-list .left-ws-item.active')`)) break;
      await sleep(100);
      if (attempt === 99) fail('deferred workspace list rendering timeout');
    }
    const workspaceFocusMenu = await evaluate(cdp, `(async () => {
      const secondary = document.getElementById('left-secondary');
      const beforeConversationId = typeof activeConversationId === 'function' ? activeConversationId() : '';
      window.setLeftSecondaryOpen(false);
      const activeWorkspace = document.querySelector('#left-ws-list .left-ws-item.active');
      if (activeWorkspace) activeWorkspace.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        activeWorkspaceFound: !!activeWorkspace,
        secondaryOpen: !!secondary?.classList.contains('open'),
        secondaryCollapsed: !!window.state.secondaryCollapsed,
        beforeConversationId,
        afterConversationId: typeof activeConversationId === 'function' ? activeConversationId() : '',
      };
    })()`);
    if (!workspaceFocusMenu.activeWorkspaceFound || !workspaceFocusMenu.secondaryOpen || workspaceFocusMenu.secondaryCollapsed
      || workspaceFocusMenu.beforeConversationId !== workspaceFocusMenu.afterConversationId) {
      fail(`focused workspace did not reopen its conversation menu: ${JSON.stringify(workspaceFocusMenu)}`);
    }
    await cdp.call('Page.enable');
    const focusMenuScreenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(repoRoot, 'archive', '2026-07-14-workspace-focus-menu.png'), Buffer.from(focusMenuScreenshot.data, 'base64'));
    const activeState = await evaluate(cdp, `window.api.getState()`);
    const workspacePath = String(activeState?.workspaces?.current?.path || '');
    if (!workspacePath) fail('runtime layout smoke has no active workspace');
    fs.mkdirSync(path.join(workspacePath, 'lazy-tree'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'lazy-tree', 'child.txt'), 'LAZY_TREE_CHILD_OK', 'utf8');
    fs.writeFileSync(path.join(workspacePath, 'layout-preview.md'), '# Preview\n\nBody', 'utf8');
    const result = await evaluate(cdp, `(async () => {
      window.openSettings('general');
      const state = await window.api.getState();
      const workspacePath = String(state.workspaces?.current?.path || '');
      const tree = await window.api.getFileTree();
      const lazyRoot = (Array.isArray(tree) ? tree : []).find(node => node.name === 'lazy-tree');
      const lazyChildren = lazyRoot ? await window.api.getFileTree(lazyRoot.path) : [];
      const outsideTree = await window.api.getFileTree(workspacePath + '/..');
      const select = document.getElementById('agent-runtime-environment');
      const toolbar = document.getElementById('input-tools');
      const button = document.getElementById('submit-btn');
      const area = document.getElementById('input-area');
      const left = document.getElementById('left');
      const secondary = document.getElementById('left-secondary');
      const right = document.getElementById('right');
      const center = document.getElementById('center-stack');
      const buttonRect = button.getBoundingClientRect();
      const areaRect = area.getBoundingClientRect();
      const rect = element => {
        const value = element.getBoundingClientRect();
        return { left: value.left, right: value.right, width: value.width, display: getComputedStyle(element).display };
      };
      return {
        viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight, devicePixelRatio: window.devicePixelRatio },
        layoutState: { leftCollapsed: window.state.leftCollapsed, secondaryCollapsed: window.state.secondaryCollapsed, rightCollapsed: window.state.rightCollapsed },
        layoutRects: { left: rect(left), secondary: rect(secondary), right: rect(right), center: rect(center) },
        label: select?.closest('.setting-row')?.querySelector('.setting-label')?.textContent?.trim(),
        options: Array.from(select?.options || []).map(option => ({ value: option.value, disabled: option.disabled })),
        toolbarOverflow: getComputedStyle(toolbar).overflow,
        buttonRightClearance: Math.round((areaRect.right - buttonRect.right) * 10) / 10,
        areaRect: { left: areaRect.left, right: areaRect.right, width: areaRect.width },
        toolbarRect: (() => { const rect = toolbar.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width }; })(),
        buttonRect: { left: buttonRect.left, right: buttonRect.right, width: buttonRect.width },
        workspacePath: state.workspaces?.current?.path || '',
        treeNames: (Array.isArray(tree) ? tree : []).map(node => node.name),
        treeHasRecursiveChildren: (Array.isArray(tree) ? tree : []).some(node => Object.prototype.hasOwnProperty.call(node, 'children')),
        lazyChildNames: (Array.isArray(lazyChildren) ? lazyChildren : []).map(node => node.name),
        outsideTreeError: outsideTree?.error || '',
      };
    })()`);
    if (!['Agent runtime environment', 'Agent 运行环境'].includes(result.label)) fail(`unexpected runtime label: ${result.label}`);
    if (result.options.map(option => option.value).join(',') !== 'windows,wsl') fail(`unexpected runtime options: ${JSON.stringify(result.options)}`);
    if (result.toolbarOverflow !== 'visible' || result.buttonRightClearance < 8) fail(`submit clipping risk: ${JSON.stringify(result)}`);
    if (!result.workspacePath || result.treeNames.includes('Roots') || result.treeNames.includes('config.json')) fail(`file tree exposed runtime root: ${JSON.stringify(result)}`);
    if (result.treeHasRecursiveChildren || !result.treeNames.includes('lazy-tree') || !result.lazyChildNames.includes('child.txt')) fail(`file tree lazy loading failed: ${JSON.stringify(result)}`);
    if (!String(result.outsideTreeError).includes('outside the active workspace')) fail(`file tree workspace boundary failed: ${JSON.stringify(result)}`);
    const treeUi = await evaluate(cdp, `(async () => {
      window.closeSubWin();
      window.switchRightTab('file-tree');
      await window.loadFileTree();
      const rootItems = Array.from(document.querySelectorAll('#file-tree-container > .ft-item'));
      const lazyItem = rootItems.find(item => item.querySelector('.ft-name')?.textContent === 'lazy-tree');
      if (!lazyItem) return { error: 'lazy-tree root item missing' };
      const beforeExpand = document.querySelectorAll('#file-tree-container .ft-item').length;
      await lazyItem.onclick();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (lazyItem.nextElementSibling?.getAttribute('data-loaded') === 'true') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const child = Array.from(lazyItem.nextElementSibling?.querySelectorAll('.ft-item') || [])
        .find(item => item.querySelector('.ft-name')?.textContent === 'child.txt');
      if (child) await child.onclick();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (document.getElementById('editor-filename')?.textContent?.includes('child.txt')) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return {
        beforeExpand,
        afterExpand: document.querySelectorAll('#file-tree-container .ft-item').length,
        childVisible: !!child,
        editorFile: document.getElementById('editor-filename')?.textContent || '',
        editorText: document.getElementById('editor-textarea')?.value || '',
      };
    })()`);
    if (treeUi.error || !treeUi.childVisible || treeUi.afterExpand <= treeUi.beforeExpand || !treeUi.editorFile.includes('child.txt') || !treeUi.editorText.includes('LAZY_TREE_CHILD_OK')) fail(`file tree UI expansion failed: ${JSON.stringify(treeUi)}`);
    const editor = await evaluate(cdp, `(async () => {
      await window.openFile('layout-preview.md');
      const button = document.getElementById('editor-md-toggle');
      const icon = button.querySelector('.nm-icon');
      const br = button.getBoundingClientRect();
      const ir = icon.getBoundingClientRect();
      window.requestEditorCompletion = async () => {
        const textarea = document.getElementById('editor-textarea');
        window.state.editorCompletionAnchor = { path: window.state.editorPath, value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd };
        window.state.editorCompletionText = ' predicted';
        window.renderEditorGhostText();
      };
      const textarea = document.getElementById('editor-textarea');
      textarea.setSelectionRange(2, 2);
      window.state.editorCaretSignature = window.editorCaretSignature();
      window.scheduleEditorCompletion();
      await new Promise(resolve => setTimeout(resolve, 650));
      const beforeMove = { text: window.state.editorCompletionText, current: window.editorCompletionAnchorIsCurrent() };
      textarea.setSelectionRange(5, 5);
      window.handleEditorCaretChange();
      return {
        visible: getComputedStyle(button).display !== 'none',
        button: { width: br.width, height: br.height },
        icon: { width: ir.width, height: ir.height, contained: ir.left >= br.left && ir.top >= br.top && ir.right <= br.right && ir.bottom <= br.bottom },
        beforeMove,
        afterMove: { text: window.state.editorCompletionText, anchor: window.state.editorCompletionAnchor, timer: !!window.state.editorCompletionTimer, ghost: document.getElementById('editor-ghost').textContent, ghostDisplay: getComputedStyle(document.getElementById('editor-ghost')).display, highlightVisible: getComputedStyle(document.getElementById('editor-highlight')).display !== 'none' && document.getElementById('editor-highlight').textContent.includes('Preview') },
      };
    })()`);
    if (!editor.visible || editor.button.width !== 30 || editor.button.height !== 30 || editor.icon.width !== 15 || editor.icon.height !== 15 || !editor.icon.contained) fail(`Markdown preview icon placement failed: ${JSON.stringify(editor)}`);
    if (!editor.beforeMove.text || !editor.beforeMove.current || editor.afterMove.text || editor.afterMove.anchor || !editor.afterMove.timer || editor.afterMove.ghost || editor.afterMove.ghostDisplay !== 'none' || !editor.afterMove.highlightVisible) fail(`caret completion invalidation failed: ${JSON.stringify(editor)}`);
    await evaluate(cdp, `window.setTheme('dark')`);
    await sleep(100);
    const darkAppIcon = await evaluate(cdp, `document.getElementById('title-app-icon').currentSrc`);
    await evaluate(cdp, `window.setTheme('light')`);
    await sleep(100);
    const lightAppIcon = await evaluate(cdp, `document.getElementById('title-app-icon').currentSrc`);
    await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await evaluate(cdp, `window.setTheme('system')`);
    await sleep(100);
    const darkSystemIcon = await evaluate(cdp, `document.getElementById('title-app-icon').currentSrc`);
    await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await evaluate(cdp, `window.refreshTitlebarThemeIcon()`);
    await sleep(100);
    const lightSystemIcon = await evaluate(cdp, `document.getElementById('title-app-icon').currentSrc`);
    if (!String(darkAppIcon).includes('app-icon-dark-64.png') || !String(lightAppIcon).includes('app-icon-light-64.png') || !String(darkSystemIcon).includes('app-icon-dark-64.png') || !String(lightSystemIcon).includes('app-icon-light-64.png')) fail(`application theme title icon mismatch: ${JSON.stringify({ darkAppIcon, lightAppIcon, darkSystemIcon, lightSystemIcon })}`);
    async function sampleSettingsControls(theme) {
      const metrics = await evaluate(cdp, `(async () => {
        const theme = '__THEME__';
        window.setTheme(theme);
        window.openSettings('models');
        await new Promise(resolve => setTimeout(resolve, 180));
        const button = document.querySelector('.settings-action-btn');
        if (!button) throw new Error('Model settings action control is missing');
        const parse = value => {
          const values = String(value || '').match(/[\\d.]+/g)?.map(Number) || [];
          return { r: values[0] || 0, g: values[1] || 0, b: values[2] || 0, a: values.length > 3 ? values[3] : 1 };
        };
        const blend = (top, bottom) => {
          const alpha = top.a + bottom.a * (1 - top.a);
          if (!alpha) return { r: 0, g: 0, b: 0, a: 0 };
          return {
            r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / alpha,
            g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / alpha,
            b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / alpha,
            a: alpha,
          };
        };
        const background = element => {
          const layers = [];
          for (let current = element; current; current = current.parentElement) {
            layers.push(parse(getComputedStyle(current).backgroundColor));
          }
          let result = theme === 'dark' ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
          for (let index = layers.length - 1; index >= 0; index -= 1) result = blend(layers[index], result);
          return result;
        };
        const luminance = color => {
          const channel = value => {
            const normalized = value / 255;
            return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
          };
          return channel(color.r) * 0.2126 + channel(color.g) * 0.7152 + channel(color.b) * 0.0722;
        };
        const contrast = (foreground, backgroundColor) => {
          const a = luminance(foreground);
          const b = luminance(backgroundColor);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        const buttonStyle = getComputedStyle(button);
        const buttonRect = button.getBoundingClientRect();
        const buttonMetrics = {
          contrast: contrast(parse(buttonStyle.color), background(button)),
          effectiveBackground: background(button),
          size: { width: buttonRect.width, height: buttonRect.height },
          color: buttonStyle.color,
          background: buttonStyle.backgroundColor,
        };
        window.openSettings('general');
        await new Promise(resolve => setTimeout(resolve, 180));
        const input = document.getElementById('settings-terminal-timeout');
        if (!input) throw new Error('General settings terminal timeout control is missing');
        const inputStyle = getComputedStyle(input);
        const inputRect = input.getBoundingClientRect();
        return {
          theme,
          buttonContrast: buttonMetrics.contrast,
          buttonEffectiveBackground: buttonMetrics.effectiveBackground,
          inputContrast: contrast(parse(inputStyle.color), background(input)),
          inputEffectiveBackground: background(input),
          inputColorScheme: inputStyle.colorScheme,
          buttonSize: buttonMetrics.size,
          inputSize: { width: inputRect.width, height: inputRect.height },
          buttonColor: buttonMetrics.color,
          buttonBackground: buttonMetrics.background,
          inputColor: inputStyle.color,
          inputBackground: inputStyle.backgroundColor,
        };
      })()`.replace('__THEME__', theme));
      const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(repoRoot, 'archive', `2026-07-16-settings-controls-${theme}.png`), Buffer.from(screenshot.data, 'base64'));
      return metrics;
    }
    const controlDark = await sampleSettingsControls('dark');
    const controlLight = await sampleSettingsControls('light');
    for (const sample of [controlDark, controlLight]) {
      if (sample.buttonContrast < 4.5 || sample.inputContrast < 4.5
        || !sample.inputColorScheme.includes(sample.theme)
        || sample.buttonSize.height < 31.5 || Math.abs(sample.inputSize.width - 110) > 0.5 || sample.inputSize.height < 35.5) {
        fail(`settings controls are not readable in ${sample.theme}: ${JSON.stringify(sample)}`);
      }
    }
    async function sampleEditorTheme(theme) {
      const metrics = await evaluate(cdp, `(async () => {
        const theme = '__THEME__';
        window.setTheme(theme);
        window.closeSubWin();
        window.switchRightTab('editor');
        await new Promise(resolve => setTimeout(resolve, 180));
        const editor = document.getElementById('native-editor');
        const highlight = document.getElementById('editor-highlight');
        const gutter = document.getElementById('editor-gutter');
        const textarea = document.getElementById('editor-textarea');
        const ghost = document.getElementById('editor-ghost');
        const completion = document.getElementById('editor-completion');
        if (!editor || !highlight || !gutter || !textarea || !ghost || !completion) throw new Error('Native editor theme surfaces are missing');
        const parse = value => {
          const values = String(value || '').match(/[\\d.]+/g)?.map(Number) || [];
          return { r: values[0] || 0, g: values[1] || 0, b: values[2] || 0, a: values.length > 3 ? values[3] : 1 };
        };
        const luminance = color => {
          const channel = value => {
            const normalized = value / 255;
            return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
          };
          return channel(color.r) * 0.2126 + channel(color.g) * 0.7152 + channel(color.b) * 0.0722;
        };
        const contrast = (foreground, background) => {
          const a = luminance(foreground);
          const b = luminance(background);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        const blend = (top, bottom) => ({
          r: top.r * top.a + bottom.r * (1 - top.a),
          g: top.g * top.a + bottom.g * (1 - top.a),
          b: top.b * top.a + bottom.b * (1 - top.a),
          a: 1,
        });
        const keyword = document.createElement('span');
        keyword.className = 'tok-keyword';
        keyword.textContent = 'const';
        highlight.appendChild(keyword);
        const editorStyle = getComputedStyle(editor);
        const editorBackground = parse(editorStyle.backgroundColor);
        const highlightColor = parse(getComputedStyle(highlight).color);
        const gutterColor = parse(getComputedStyle(gutter).color);
        const keywordColor = parse(getComputedStyle(keyword).color);
        const ghostColor = parse(getComputedStyle(ghost).getPropertyValue('--editor-ghost-text') || getComputedStyle(document.documentElement).getPropertyValue('--editor-ghost-text'));
        const completionStyle = getComputedStyle(completion);
        const completionBackground = blend(parse(completionStyle.backgroundColor), editorBackground);
        const result = {
          theme,
          editorBackground: editorStyle.backgroundColor,
          gutterBackground: getComputedStyle(gutter).backgroundColor,
          ghostBackground: getComputedStyle(ghost).backgroundColor,
          completionBackground: completionStyle.backgroundColor,
          caretColor: getComputedStyle(textarea).caretColor,
          textContrast: contrast(highlightColor, editorBackground),
          gutterContrast: contrast(gutterColor, editorBackground),
          keywordContrast: contrast(keywordColor, editorBackground),
          ghostContrast: contrast(blend(ghostColor, editorBackground), editorBackground),
          completionContrast: contrast(parse(completionStyle.color), completionBackground),
          editorSize: { width: editor.getBoundingClientRect().width, height: editor.getBoundingClientRect().height },
        };
        keyword.remove();
        return result;
      })()`.replace('__THEME__', theme));
      const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(repoRoot, 'archive', `2026-07-16-editor-${theme}.png`), Buffer.from(screenshot.data, 'base64'));
      return metrics;
    }
    const editorDark = await sampleEditorTheme('dark');
    const editorLight = await sampleEditorTheme('light');
    if (editorDark.editorBackground !== 'rgb(11, 13, 20)' || editorDark.caretColor !== 'rgb(255, 255, 255)'
      || editorLight.editorBackground !== 'rgb(247, 248, 252)' || editorLight.caretColor !== 'rgb(23, 32, 51)') {
      fail(`native editor did not switch its base palette with the application theme: ${JSON.stringify({ editorDark, editorLight })}`);
    }
    for (const sample of [editorDark, editorLight]) {
      if (sample.textContrast < 4.5 || sample.gutterContrast < 4.5 || sample.keywordContrast < 4.5
        || sample.ghostContrast < 3 || sample.completionContrast < 4.5
        || sample.editorSize.width < 300 || sample.editorSize.height < 80) {
        fail(`native editor theme is not readable in ${sample.theme}: ${JSON.stringify(sample)}`);
      }
    }
    const appearance = await evaluate(cdp, `(async () => {
      window.setTheme('dark');
      window.setBackgroundColor('#123456');
      window.setFontFamily('Segoe UI');
      await new Promise(resolve => setTimeout(resolve, 250));
      window.openSettings('general');
      const backend = await window.api.getState();
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        theme: window.state.theme,
        background: rootStyle.getPropertyValue('--app-bg').trim(),
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        font: rootStyle.getPropertyValue('--font').trim(),
        backendBackground: backend.backgroundColor,
        backendFont: backend.fontFamily,
        backgroundControl: document.getElementById('settings-background-color')?.value || '',
        fontControl: document.getElementById('settings-font-family')?.value || '',
      };
    })()`);
    if (appearance.theme !== 'dark' || appearance.background.toUpperCase() !== '#123456'
      || appearance.bodyBackground !== 'rgb(18, 52, 86)' || !appearance.font.includes('Segoe UI')
      || appearance.backendBackground !== '#123456' || appearance.backendFont !== 'Segoe UI'
      || appearance.backgroundControl.toUpperCase() !== '#123456' || appearance.fontControl !== 'Segoe UI') {
      fail(`visual preferences were not applied and persisted: ${JSON.stringify(appearance)}`);
    }
    const appearanceScreenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(repoRoot, 'archive', '2026-07-14-visual-preferences.png'), Buffer.from(appearanceScreenshot.data, 'base64'));
    const resetAppearance = await evaluate(cdp, `(async () => {
      window.resetBackgroundColor();
      window.resetFontFamily();
      await new Promise(resolve => setTimeout(resolve, 250));
      const backend = await window.api.getState();
      return {
        background: window.state.backgroundColor,
        font: window.state.fontFamily,
        backendBackground: backend.backgroundColor,
        backendFont: backend.fontFamily,
      };
    })()`);
    if (resetAppearance.background || resetAppearance.font || resetAppearance.backendBackground || resetAppearance.backendFont) fail(`visual preference reset failed: ${JSON.stringify(resetAppearance)}`);
    const durableImageUi = await evaluate(cdp, `(async () => {
      window.closeSubWin();
      await new Promise(resolve => setTimeout(resolve, 250));
      renderChatMessages([{ role: 'user', content: 'A durable submitted diagram\\n\\n[1 image attachment]', mode: 'build', model: 'fixture', timestamp: 'now', attachments: [{
        id: 'user-image-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        origin: 'user',
        name: 'diagram.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII='
      }] }]);
      const card = document.querySelector('.conversation-image-attachment');
      return { cards: document.querySelectorAll('.conversation-image-attachment').length, name: card?.querySelector('span')?.textContent || '', src: card?.querySelector('img')?.getAttribute('src') || '' };
    })()`);
    if (durableImageUi.cards !== 1 || durableImageUi.name !== 'diagram.png' || !durableImageUi.src.startsWith('data:image/png;base64,')) fail(`durable user image UI failed: ${JSON.stringify(durableImageUi)}`);
    const durableImageScreenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(repoRoot, 'archive', '2026-07-14-durable-user-image-ui.png'), Buffer.from(durableImageScreenshot.data, 'base64'));
    console.log(`[release-ui-runtime-layout-smoke] PASS workspaceFocusMenu=${JSON.stringify(workspaceFocusMenu)} layout=${JSON.stringify(result)} editor=${JSON.stringify(editor)} editorThemes=${JSON.stringify({ editorDark, editorLight })} icons=${JSON.stringify({ darkAppIcon, lightAppIcon, darkSystemIcon, lightSystemIcon })} controls=${JSON.stringify({ controlDark, controlLight })} appearance=${JSON.stringify(appearance)} durableImageUi=${JSON.stringify(durableImageUi)}`);
  } finally {
    try { cdp?.ws.close(); } catch {}
    if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process 'Newmark Agent','electron' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*Newmark Agent*DESKTOP*' } | Stop-Process -Force"], { windowsHide: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
