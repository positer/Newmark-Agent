'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const Module = require('node:module'), crypto = require('node:crypto'), ts = require('typescript');
const vm = require('node:vm');
const { Agent } = require('../dist/core/agent');
const { ensureMobileToken } = require('../dist/core/mobilePairing');

async function run(reportPath) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-list-events-'));
  const source = fs.readFileSync(path.resolve(__dirname, '../src/server.ts'), 'utf8');
  const receipt = { boundary: 'Real authenticated localhost HTTP mutations, real Agent storage and two independent SSE connections; main IPC sink observes the same transport event. No renderer or external model is mocked as passed.', sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), checks: [], events: [] };
  const check = (name, passed, detail) => { receipt.checks.push({ name, passed: !!passed, ...(!passed ? { detail } : {}) }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); };
  const port = await new Promise(resolve => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
  const controllers = [], readers = [];
  const oldBind = process.env.NEWMARK_BIND_HOST;
  let server;
  try {
    fs.mkdirSync(path.join(root, 'Work'));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ remote: { touch_enabled: true }, workspace: { auto_create_timestamp_workspace: false } }));
    const host = new Agent(root, { agentOnly: true });
    const a = host.workspace.createInternal('list-a'), b = host.workspace.createInternal('list-b');
    host.selectWorkspaceFromStorage(b.id); host.setConversationFromStorage('default'); host.ensureConversationSnapshot('default');
    host.flushConversationState();
    host.selectWorkspaceFromStorage(a.id); host.setConversationFromStorage('default'); host.ensureConversationSnapshot('default');
    host.flushConversationState();
    const file = path.resolve(__dirname, '../dist/server.js');
    const compiled = new Module(file, module); compiled.filename = file; compiled.paths = Module._nodeModulePaths(path.dirname(file));
    const originalRequire = compiled.require.bind(compiled);
    compiled.require = name => {
      if (name !== './core/conversationListEvent') return originalRequire(name);
      const helperFile = path.resolve(__dirname, '../dist/core/conversationListEvent.js');
      const helper = new Module(helperFile, module); helper.filename = helperFile; helper.paths = Module._nodeModulePaths(path.dirname(helperFile));
      helper._compile(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/core/conversationListEvent.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, helperFile);
      return helper.exports;
    };
    const portSource = source.replace('const PORT = 47890;', `const PORT = ${port};`);
    if (source === portSource) throw Error('Isolated port seam missing');
    compiled._compile(ts.transpileModule(portSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, file);
    server = compiled.exports;
    const ipcEvents = [];
    process.env.NEWMARK_BIND_HOST = '127.0.0.1';
    server.runServer(root, { agent: host, onWorkEvent: event => ipcEvents.push(structuredClone(event)) });
    const token = ensureMobileToken(root);
    const post = async (endpoint, body, bearer = token) => { const r = await fetch(`http://127.0.0.1:${port}/api/mobile/${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); return { status: r.status, body: await r.json() }; };
    const streams = [];
    for (let i = 0; i < 2; i++) {
      const controller = new AbortController(); controllers.push(controller);
      const response = await fetch(`http://127.0.0.1:${port}/api/mobile/events`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
      if (response.status !== 200) throw Error(`SSE connection failed: ${response.status}`);
      const events = []; streams.push(events);
      const reader = response.body.getReader(); readers.push(reader);
      void (async () => { let pending = ''; const decoder = new TextDecoder(); try { while (true) { const item = await reader.read(); if (item.done) break; pending += decoder.decode(item.value, { stream: true }); let end; while ((end = pending.indexOf('\n\n')) >= 0) { const packet = pending.slice(0, end); pending = pending.slice(end + 2); const data = packet.split('\n').find(line => line.startsWith('data: ')); if (data) events.push(JSON.parse(data.slice(6))); } } } catch (error) { if (!controller.signal.aborted) throw error; } })();
    }
    const mutate = async (name, endpoint, body, predicate) => {
      const counts = [...streams.map(events => events.length), ipcEvents.length];
      const response = await post(endpoint, body);
      const deadline = Date.now() + 300;
      while (Date.now() < deadline && streams.some((events, i) => events.length === counts[i])) await new Promise(resolve => setTimeout(resolve, 5));
      const events = [...streams.map((items, i) => items.slice(counts[i])), ipcEvents.slice(counts[2])];
      receipt.events.push({ name, response, events });
      check(`${name}: mutation succeeds in actual stored workspace`, response.status === 200 && response.body.ok, response);
      check(`${name}: both SSE peers and PC sink receive exactly one matching directory event`, events.every(items => items.length === 1 && items[0].type === 'conversation_list' && items[0].stateScope === 'workspace' && items[0].workspaceId === body.workspaceId && predicate(items[0].conversations, response)), events);
      check(`${name}: event carries no selected conversation or turn identity`, events.every(items => items.length === 1 && !('activeConversationId' in items[0]) && !items[0].runId && !items[0].runtimeKey), events);
      return response;
    };
    const created = await mutate('remote create', 'conversation-create', { workspaceId: b.id, title: 'remote B' }, (rows, response) => rows.some(row => row.id === response.body.conversation.id && row.title === 'remote B'));
    const id = created.body.conversation.id;
    check('cross-workspace creation preserves host foreground workspace and conversation', host.workspace.current.id === a.id && host.activeConversationId === 'default');
    await mutate('remote rename', 'conversation-rename', { workspaceId: b.id, conversationId: id, title: 'renamed B' }, rows => rows.some(row => row.id === id && row.title === 'renamed B'));
    await mutate('remote pin', 'conversation-pin', { workspaceId: b.id, conversationId: id, pinned: true }, rows => rows[0]?.id === id && rows[0].pinned);
    await mutate('remote unpin', 'conversation-pin', { workspaceId: b.id, conversationId: id, pinned: false }, rows => rows.some(row => row.id === id && !row.pinned));
    await mutate('remote reorder', 'conversation-reorder', { workspaceId: b.id, conversationIds: ['default', id] }, rows => rows.map(row => row.id).join(',') === `default,${id}`);
    const beforeInvalid = ipcEvents.length;
    const invalid = await post('conversation-rename', { workspaceId: b.id, conversationId: 'missing', title: 'invalid' });
    const unauthorized = await post('conversation-create', { workspaceId: b.id }, 'wrong');
    check('rejected mutation and invalid authentication emit no directory change', invalid.status === 404 && unauthorized.status === 401 && ipcEvents.length === beforeInvalid);
    await mutate('standalone archive deletion', 'conversation-archive', { workspaceId: b.id, conversationId: id }, rows => rows.every(row => row.id !== id));
    // Execute the actual main IPC callbacks with the real storage owner. Only
    // the runtime snapshot boundary is replaced by its real Agent equivalent;
    // no Electron window or utility child is needed for directory mutations.
    const mainSource = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');
    receipt.mainSha256 = crypto.createHash('sha256').update(mainSource).digest('hex');
    const ast = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true);
    const ipcNames = { 'agent:activateConversation': 'activate', 'agent:ensureConversation': 'ensure', 'agent:renameConversation': 'rename', 'agent:setConversationPinned': 'pin', 'agent:reorderConversations': 'reorder', 'agent:restoreArchive': 'restore' };
    const declarations = [];
    function visit(node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'publishConversationList') declarations.push(node.getText(ast));
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle' && ipcNames[node.arguments[0]?.text]) declarations.push(`const ${ipcNames[node.arguments[0].text]} = ${node.arguments[1].getText(ast)};`);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    const mainEvents = [];
    const context = { agent: host, conversationListEvent: compiled.require('./core/conversationListEvent').conversationListEvent, broadcastAgentWorkEvent: event => mainEvents.push(event),
      conversationRuntimeTarget: target => ({ ...target, workspace: host.workspace.current }),
      peekTargetRuntime: () => ({ resident: false }),
      localConversationSnapshotForStartup: target => { const snapshot = host.ensureConversationSnapshot(target.conversationId); host.flushConversationState(); return snapshot; },
      runtimeSnapshotForTarget: async target => { const snapshot = host.ensureConversationSnapshot(target.conversationId); host.flushConversationState(); return snapshot; },
    };
    vm.createContext(context);
    vm.runInContext(ts.transpileModule(declarations.join('\n') + `\nglobalThis.ipc = {${Object.values(ipcNames).join(',')}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
    const runIpc = async (name, action, args, predicate) => { const before = mainEvents.length; const result = await context.ipc[action](null, ...args); const event = mainEvents.at(-1); check(`${name}: main IPC publishes exactly one authoritative workspace list`, mainEvents.length === before + 1 && event?.stateScope === 'workspace' && event.workspaceId === a.id && !('activeConversationId' in event) && predicate(event.conversations, result), { result, event }); };
    await runIpc('PC new conversation', 'activate', [{ workspaceId: a.id, conversationId: 'pc-new' }], rows => rows.some(row => row.id === 'pc-new'));
    const beforeSelection = mainEvents.length;
    await context.ipc.activate(null, { workspaceId: a.id, conversationId: 'default' });
    check('selecting an existing PC conversation does not emit a directory change or switch peers', mainEvents.length === beforeSelection);
    await runIpc('PC ensure new conversation fallback', 'ensure', [{ workspaceId: a.id, conversationId: 'pc-ensure' }], rows => rows.some(row => row.id === 'pc-ensure'));
    await runIpc('PC rename', 'rename', ['pc-new', 'PC renamed'], rows => rows.some(row => row.id === 'pc-new' && row.title === 'PC renamed'));
    await runIpc('PC pin', 'pin', ['pc-new', true], rows => rows.some(row => row.id === 'pc-new' && row.pinned));
    await runIpc('PC unpin', 'pin', ['pc-new', false], rows => rows.some(row => row.id === 'pc-new' && !row.pinned));
    await runIpc('PC reorder', 'reorder', [['pc-new', 'pc-ensure', 'default']], rows => rows[0]?.id === 'pc-new');
    const archive = await host.archiveConversationAsync('pc-new');
    await runIpc('PC restore archive', 'restore', [archive], rows => rows.some(row => row.title === 'PC renamed'));
    receipt.passedCount = receipt.checks.filter(c => c.passed).length;
    receipt.failedCount = receipt.checks.length - receipt.passedCount;
    receipt.passed = receipt.failedCount === 0;
    if (reportPath) { fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(receipt, null, 2) + '\n'); }
    console.log(JSON.stringify({ passed: receipt.passed, passedCount: receipt.passedCount, failedCount: receipt.failedCount }));
    if (!receipt.passed) throw Error('Conversation directory notifications failed');
    return receipt;
  } finally {
    controllers.forEach(controller => controller.abort());
    await Promise.allSettled(readers.map(reader => reader.cancel()));
    await server?.stopHostedServer();
    if (oldBind === undefined) delete process.env.NEWMARK_BIND_HOST; else process.env.NEWMARK_BIND_HOST = oldBind;
    const safeRoot = path.resolve(root);
    if (path.dirname(safeRoot) !== path.resolve(os.tmpdir()) || !path.basename(safeRoot).startsWith('newmark-list-events-')) throw Error('Cleanup path guard failed');
    fs.rmSync(safeRoot, { recursive: true, force: true });
  }
}
module.exports = { run };
if (require.main === module) run(process.argv[2]).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
