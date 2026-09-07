'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const Module = require('node:module'), crypto = require('node:crypto'), ts = require('typescript');
const { Agent } = require('../dist/core/agent');
const { ensureMobileToken } = require('../dist/core/mobilePairing');
async function run(reportPath) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-hosted-command-adapter-'));
  const file = path.resolve(__dirname, '../dist/server.js');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/server.ts'), 'utf8');
  const receipt = { boundary: 'Production HTTP auth/target/dispatch adapter with recording callbacks; not a full GUI or provider execution test.', sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), checks: [] };
  const check = (name, passed, detail) => { receipt.checks.push({ name, passed: !!passed, ...(!passed ? { detail } : {}) }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); };
  const port = await new Promise(resolve => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
  let server;
  const oldBind = process.env.NEWMARK_BIND_HOST;
  try {
    fs.mkdirSync(path.join(root, 'Work'));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ remote: { touch_enabled: true }, workspace: { auto_create_timestamp_workspace: false } }));
    const host = new Agent(root, { agentOnly: true });
    const a = host.workspace.createInternal('adapter-a'), b = host.workspace.createInternal('adapter-b');
    host.selectWorkspaceFromStorage(b.id); host.setConversationFromStorage('default'); host.ensureConversationSnapshot('default');
    host.selectWorkspaceFromStorage(a.id); host.setConversationFromStorage('default'); host.ensureConversationSnapshot('default');
    // Count only Agent construction attempted by the HTTP adapter, while its host is already running.
    let extraAgents = 0, fallbackProcesses = 0;
    host.process = async () => { fallbackProcesses++; return []; };
    const originalRequire = Module.prototype.require;
    const compiled = new Module(file, module); compiled.filename = file; compiled.paths = Module._nodeModulePaths(path.dirname(file));
    compiled.require = function(name) { const value = originalRequire.call(this, name); return name === './core/agent' ? { ...value, Agent: new Proxy(value.Agent, { construct(Type, args) { extraAgents++; return Reflect.construct(Type, args); } }) } : value; };
    const portSource = source.replace('const PORT = 47890;', `const PORT = ${port};`);
    if (source === portSource) throw Error('Isolated port seam missing');
    compiled._compile(ts.transpileModule(portSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, file);
    server = compiled.exports;
    const sends = [], actions = [], snapshots = [];
    process.env.NEWMARK_BIND_HOST = '127.0.0.1';
    server.runServer(root, { agent: host,
      conversationPrompt: async (target, message, options) => { sends.push({ target, message, options }); return { accepted: true }; },
      conversationUiAction: async (target, action, value, input) => { actions.push({ target, action, value, input }); return { accepted: true }; },
      conversationUiState: async target => { snapshots.push(target); return { mode: 'plan', inputMode: 'next', queuePaused: true, queueItems: [{ id: 'shared-state-item' }] }; },
    });
    const token = ensureMobileToken(root);
    const post = async (endpoint, body, bearer = token) => { const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); return { status: r.status, body: await r.json() }; };
    await new Promise(resolve => setTimeout(resolve, 100));
    const target = { workspaceId: b.id, conversationId: 'default' };
    for (const mode of ['build', 'chat', 'plan', 'goal', 'flow']) {
      const payload = { ...target, message: `adapter ${mode}`, requestedMode: mode, inputMode: 'next', goalObjective: mode === 'goal' ? 'same goal' : '', clientMessageId: `adapter-${mode}`, flowName: 'AdapterFlow', flowStart: 2 };
      const response = await post('/api/mobile/send', payload);
      const sent = sends.at(-1);
      check(`${mode}: authenticated send delegates to hosted command`, response.status === 200 && sent?.message === payload.message, response);
      check(`${mode}: identity and mode envelope reaches command unchanged`, sent?.options.clientMessageId === payload.clientMessageId && sent?.options.requestedMode === mode && sent?.options.inputMode === 'next' && sent?.options.goalObjective === payload.goalObjective && sent?.options.flowName === 'AdapterFlow' && sent?.options.flowStart === 2, sent);
    }
    check('hosted cross-workspace dispatch creates no second mobile Agent', extraAgents === 0, { extraAgents });
    const image = { name: 'queue.png', type: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=' };
    for (const text of ['mobile image message', '']) {
      const message = { text, images: [image] };
      const response = await post('/api/mobile/send', { ...target, message, requestedMode: 'plan', inputMode: 'next', clientMessageId: 'mobile-image-' + text.length });
      check(`mobile structured ${text ? 'text and image' : 'image only'} reaches the shared command intact`, response.status === 200 && JSON.stringify(sends.at(-1)?.message) === JSON.stringify(message) && sends.at(-1)?.options.requestedMode === 'plan', sends.at(-1));
    }
    const beforeDefault = sends.length;
    await post('/api/mobile/send', { message: 'default target', clientMessageId: 'default-target' });
    check('omitted target resolves foreground target through the same hosted command', sends.length === beforeDefault + 1 && sends.at(-1)?.target.workspaceId === a.id && fallbackProcesses === 0, { sends: sends.length, fallbackProcesses });
    for (const action of ['mode', 'input_mode', 'queue_enqueue', 'queue_update', 'queue_delete', 'queue_reorder', 'queue_toggle_pause', 'queue_set_pause', 'queue_guide']) {
      const before = actions.length;
      const response = await post('/api/mobile/conversation-ui-action', { ...target, action, value: action === 'mode' ? 'plan' : 'next', id: 'same-id', text: 'edited', paused: true });
      check(`${action}: control reaches the same target action adapter`, response.status === 200 && actions.length === before + 1 && actions.at(-1)?.input.id === 'same-id' && actions.at(-1)?.target.workspaceId === b.id, response);
    }
    const beforeUnauthorized = sends.length;
    const unauthorized = await post('/api/mobile/send', { ...target, message: 'unauthorized' }, 'wrong');
    check('authentication still precedes command dispatch', unauthorized.status === 401 && sends.length === beforeUnauthorized, unauthorized);
    const unknown = await post('/api/mobile/send', { ...target, conversationId: 'not-in-workspace', message: 'unknown' });
    check('unknown target is rejected before command dispatch', unknown.status === 404 && sends.length === beforeUnauthorized, unknown);
    const browserMessage = { text: 'browser input', clientMessageId: 'browser-id', images: [{ id: 'image-preserved' }] };
    const browserResponse = await post('/api/send', { ...target, message: browserMessage, requestedMode: 'goal', goalObjective: 'browser goal', inputMode: 'next', clientMessageId: 'browser-id', flowName: 'BrowserFlow', flowStart: 3 });
    const browserCommand = sends.at(-1);
    check('browser GUI send uses the same target command with structured message', browserResponse.status === 200 && browserCommand?.target.workspaceId === b.id && JSON.stringify(browserCommand.message) === JSON.stringify(browserMessage), browserCommand);
    check('browser GUI command preserves mode, input mode, goal and identity', browserCommand?.options.requestedMode === 'goal' && browserCommand?.options.inputMode === 'next' && browserCommand?.options.goalObjective === 'browser goal' && browserCommand?.options.clientMessageId === 'browser-id' && browserCommand?.options.flowName === 'BrowserFlow' && browserCommand?.options.flowStart === 3, browserCommand);
    await post('/api/mode', { ...target, mode: 'chat' });
    check('browser mode selection reaches the shared target action', actions.at(-1)?.action === 'mode' && actions.at(-1)?.value === 'chat' && actions.at(-1)?.target.workspaceId === b.id, actions.at(-1));
    await post('/api/input-mode', { ...target, inputMode: 'next' });
    check('browser input toggle reaches the shared target action', actions.at(-1)?.action === 'input_mode' && actions.at(-1)?.value === 'next' && actions.at(-1)?.target.workspaceId === b.id, actions.at(-1));
    const browserState = await (await fetch(`http://127.0.0.1:${port}/api/state?` + new URLSearchParams(target))).json();
    check('browser state overlays the exact target queue and selected modes', snapshots.at(-1)?.workspaceId === b.id && browserState.mode === 'plan' && browserState.inputMode === 'next' && browserState.queuePaused && browserState.queueItems[0]?.id === 'shared-state-item', browserState.queueItems);
    for (const [endpoint, action] of [
      ['conversation-branch-inspect', 'conversation_branch_inspect'],
      ['conversation-branch-activate', 'conversation_branch_activate'],
      ['conversation-branch-create', 'conversation_branch_create'],
      ['conversation-archive', 'conversation_archive'],
    ]) {
      const input = { ...target, branchId: 'same-branch', branchGroupId: 'same-group', messageIndex: 0, editedText: 'same-edit', messageId: 'original-message', branchNodePath: ['original-node'] };
      const before = actions.length;
      const response = await post('/api/mobile/' + endpoint, input);
      check(`${endpoint}: remote history uses the existing shared owner without a new Agent`, response.status === 200 && actions.length === before + 1 && actions.at(-1)?.action === action && JSON.stringify(actions.at(-1)?.input) === JSON.stringify(input) && extraAgents === 0 && fallbackProcesses === 0, { response, action: actions.at(-1), extraAgents, fallbackProcesses });
    }
    const beforeEmpty = sends.length;
    for (const message of ['', { text: '', images: [] }, { images: [image] }]) {
      const response = await post('/api/mobile/send', { ...target, message });
      check('invalid empty or malformed prompt is rejected before hosted dispatch', response.status === 400 && sends.length === beforeEmpty, response);
    }
    receipt.passed = receipt.checks.every(c => c.passed);
    receipt.passedCount = receipt.checks.filter(c => c.passed).length;
    receipt.failedCount = receipt.checks.length - receipt.passedCount;
    if (reportPath) { fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(receipt, null, 2) + '\n'); }
    console.log(JSON.stringify({ passed: receipt.passed, passedCount: receipt.passedCount, failedCount: receipt.failedCount }));
    if (!receipt.passed) throw Error('Hosted command transport assertions failed');
    return receipt;
  } finally {
    await server?.stopHostedServer();
    if (oldBind === undefined) delete process.env.NEWMARK_BIND_HOST; else process.env.NEWMARK_BIND_HOST = oldBind;
    const safeRoot = path.resolve(root);
    if (path.dirname(safeRoot) !== path.resolve(os.tmpdir()) || !path.basename(safeRoot).startsWith('newmark-hosted-command-adapter-')) throw Error('Cleanup path guard failed');
    fs.rmSync(safeRoot, { recursive: true, force: true });
  }
}
module.exports = { run };
if (require.main === module) run(process.argv[2]).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
