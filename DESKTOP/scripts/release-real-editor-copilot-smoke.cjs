const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const exePath = process.env.NEWMARK_TEST_EXE
  ? path.resolve(process.env.NEWMARK_TEST_EXE)
  : path.resolve(__dirname, '..', '..', 'release', 'win-unpacked', 'Newmark Agent.exe');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(message) { throw new Error(message); }

function getJson(url) {
  return new Promise((resolve, reject) => http.get(url, response => {
    let data = '';
    response.on('data', chunk => { data += chunk; });
    response.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
    });
  }).on('error', reject));
}

async function waitTarget(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = list.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(500);
  }
  fail('CDP target timeout');
}

function connect(target) {
  let id = 1;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    };
  });
  const call = (method, params = {}, timeout = 45000) => new Promise((resolve, reject) => {
    const current = id++;
    pending.set(current, { resolve, reject });
    ws.send(JSON.stringify({ id: current, method, params }));
    setTimeout(() => {
      if (pending.delete(current)) reject(new Error(`timeout ${method}`));
    }, timeout);
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, 120000);
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

(async () => {
  if (process.platform !== 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkRealCopilotEditor-'));
  const userRoot = path.join(os.homedir(), '.Newmark');
  for (const name of ['config.json', 'config.user.json']) {
    const source = path.join(userRoot, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(root, name));
  }

  const port = 49383;
  const editorWorkspace = path.join(root, 'Work', 'real-copilot-editor');
  fs.mkdirSync(editorWorkspace, { recursive: true });
  fs.writeFileSync(path.join(editorWorkspace, 'prediction.ts'), 'function add(a: number, b: number) {\n  ', 'utf8');
  let child;
  let cdp;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const target = await waitTarget(port);
    cdp = connect(target);
    await cdp.ready;
    await cdp.call('Runtime.enable');

    const result = await evaluate(cdp, `(async () => {
      for (let i = 0; i < 80; i++) {
        const candidate = await window.api.getState();
        if (candidate && candidate.models && candidate.models.length) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const backendState = await window.api.getState();
      const providers = Array.isArray(backendState.providers) ? backendState.providers : [];
      const copilot = providers.find(provider => provider && provider.name === 'GitHub Copilot');
      const model = copilot && Array.isArray(copilot.models)
        ? copilot.models.find(item => !item.validation_status || item.validation_status === 'available' || item.validation_status === 'unvalidated')
        : null;
      if (!model) return { ok: false, error: 'No selectable GitHub Copilot model', providers: providers.map(provider => ({ name: provider.name, count: (provider.models || []).length })) };

      const modelId = typeof model === 'string' ? model : (model.id || model.name);
      const modelValue = 'GitHub Copilot/' + modelId;
      await window.api.setModel(modelValue);
      const selectedState = await window.api.getState();
      if (selectedState.model !== modelValue) return { ok: false, error: 'Copilot model selection did not persist', requested: modelValue, selected: selectedState.model };
      const created = await window.api.createWorkspace('real-copilot-editor');
      if (!created || created.error) return { ok: false, error: 'workspace: ' + JSON.stringify(created) };
      await window.api.selectWorkspace(created.id || created.name);
      await window.openFile('prediction.ts');
      const textarea = document.querySelector('#editor-textarea');
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      await window.requestEditorCompletion();
      const ghost = document.querySelector('#editor-ghost .editor-ghost-text');
      const completion = ghost ? ghost.textContent : '';
      const beforeTab = textarea.value;
      const color = ghost ? getComputedStyle(ghost).color : '';
      const popup = document.querySelector('#editor-completion').classList.contains('open');
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      await window.saveEditor();
      const saved = await window.api.openWorkspaceFile('prediction.ts');
      return {
        ok: !!completion && !!ghost && !popup && textarea.value !== beforeTab && saved.kind === 'editor' && saved.content === textarea.value,
        model: modelValue,
        completion,
        color,
        popup,
        saved: saved.content,
      };
    })()`);

    if (!result || !result.ok || !String(result.completion || '').trim()) {
      fail(`real Copilot UI completion failed: ${JSON.stringify(result)}`);
    }
    if (!String(result.color).includes('0.48')) fail(`real Copilot ghost color mismatch: ${result.color}`);
    console.log(`[release-real-editor-copilot-smoke] ok model=${result.model} chars=${String(result.completion).length} color=${result.color} tabSaved=true`);
  } finally {
    try { cdp?.ws.close(); } catch {}
    try { child?.kill(); } catch {}
    await sleep(500);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
