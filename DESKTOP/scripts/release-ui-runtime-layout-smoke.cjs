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
    child = spawn(electron, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, 'ElectronData')}`, '--no-sandbox', '--root', root], { cwd: desktopRoot, stdio: 'ignore', windowsHide: true });
    cdp = connect(await target(port));
    await cdp.ready;
    await cdp.call('Runtime.enable');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(cdp, `typeof window.openSettings === 'function' && !!window.api`)) break;
      await sleep(200);
      if (attempt === 99) fail('renderer initialization timeout');
    }
    const result = await evaluate(cdp, `(async () => {
      window.openSettings('general');
      const state = await window.api.getState();
      const tree = await window.api.getFileTree();
      const select = document.getElementById('agent-runtime-environment');
      const toolbar = document.getElementById('input-tools');
      const button = document.getElementById('submit-btn');
      const area = document.getElementById('input-area');
      const buttonRect = button.getBoundingClientRect();
      const areaRect = area.getBoundingClientRect();
      return {
        label: select?.closest('.setting-row')?.querySelector('.setting-label')?.textContent?.trim(),
        options: Array.from(select?.options || []).map(option => ({ value: option.value, disabled: option.disabled })),
        toolbarOverflow: getComputedStyle(toolbar).overflow,
        buttonRightClearance: Math.round((areaRect.right - buttonRect.right) * 10) / 10,
        areaRect: { left: areaRect.left, right: areaRect.right, width: areaRect.width },
        toolbarRect: (() => { const rect = toolbar.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width }; })(),
        buttonRect: { left: buttonRect.left, right: buttonRect.right, width: buttonRect.width },
        workspacePath: state.workspaces?.current?.path || '',
        treeNames: (Array.isArray(tree) ? tree : []).map(node => node.name),
      };
    })()`);
    if (!['Agent runtime environment', 'Agent 运行环境'].includes(result.label)) fail(`unexpected runtime label: ${result.label}`);
    if (result.options.map(option => option.value).join(',') !== 'windows,wsl') fail(`unexpected runtime options: ${JSON.stringify(result.options)}`);
    if (result.toolbarOverflow !== 'visible' || result.buttonRightClearance < 8) fail(`submit clipping risk: ${JSON.stringify(result)}`);
    if (!result.workspacePath || result.treeNames.includes('Roots') || result.treeNames.includes('config.json')) fail(`file tree exposed runtime root: ${JSON.stringify(result)}`);
    const editor = await evaluate(cdp, `(async () => {
      await window.api.saveFile('layout-preview.md', '# Preview\\n\\nBody');
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
        afterMove: { text: window.state.editorCompletionText, anchor: window.state.editorCompletionAnchor, timer: !!window.state.editorCompletionTimer, ghost: document.getElementById('editor-ghost').textContent },
      };
    })()`);
    if (!editor.visible || editor.button.width !== 30 || editor.button.height !== 30 || editor.icon.width !== 15 || editor.icon.height !== 15 || !editor.icon.contained) fail(`Markdown preview icon placement failed: ${JSON.stringify(editor)}`);
    if (!editor.beforeMove.text || !editor.beforeMove.current || editor.afterMove.text || editor.afterMove.anchor || !editor.afterMove.timer || editor.afterMove.ghost) fail(`caret completion invalidation failed: ${JSON.stringify(editor)}`);
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
    if (!String(darkAppIcon).includes('app-icon-light.png') || !String(lightAppIcon).includes('app-icon-dark.png') || !String(darkSystemIcon).includes('app-icon-light.png') || !String(lightSystemIcon).includes('app-icon-dark.png')) fail(`application theme title icon mismatch: ${JSON.stringify({ darkAppIcon, lightAppIcon, darkSystemIcon, lightSystemIcon })}`);
    console.log(`[release-ui-runtime-layout-smoke] PASS layout=${JSON.stringify(result)} editor=${JSON.stringify(editor)} icons=${JSON.stringify({ darkAppIcon, lightAppIcon, darkSystemIcon, lightSystemIcon })}`);
  } finally {
    try { cdp?.ws.close(); } catch {}
    if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process 'Newmark Agent','electron' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*Newmark Agent*DESKTOP*' } | Stop-Process -Force"], { windowsHide: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
