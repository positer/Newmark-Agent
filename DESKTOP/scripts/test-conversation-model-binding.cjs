'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const { Agent } = require('../dist/core/agent');
const { ConversationKernel } = require('../dist/core/conversationKernel');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-deployment-roundtrip-'));
const requests = [], sockets = new Set();
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  requests.push({ path: req.url, auth: req.headers.authorization, model: body.model });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'DEPLOYMENT_BINDING_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
});
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
const select = id => `deployment:${id}:${encodeURIComponent('shared:vision/exp')}`;
const checks = [];
function check(name, fn) { fn(); checks.push(name); console.log('PASS ' + name); }
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const providers = ['one', 'two'].map(id => ({ id, name: id, protocol: 'openai', base_url: `http://127.0.0.1:${server.address().port}/${id}/v1`, api_key: id + '-fixture', enabled: true,
    models: [{ name: 'shared:vision/exp', max_tokens: 128000, enabled: true, validation: { level: 'discovered', status: 'degraded', checked_at: '', capabilities: {} } }] }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ models: { providers, default_model: select('two'), auto_switch: false, fallback_on_unavailable: false }, context: { compression_auto: false } }));
  const agent = new Agent(root, { agentOnly: true });
  const workspace = agent.createInternalWorkspace('binding-fixture');
  agent.setModel(select('two'), true);
  const kernel = new ConversationKernel(root, agent, null, { createRunner: () => agent });
  const target = { workspaceId: workspace.id, conversationId: agent.activeConversationId };
  const options = model => ({ model, mode: 'build', intelligence: 'low', inputMode: 'guide', engine: 'builtin' });
  let snapshot = kernel.snapshot(target);
  check('snapshot retains provider identity and encoded model ID', () => assert.equal(snapshot.model, select('two')));
  check('ambiguous naked lookup remains fail closed', () => assert.equal(agent.config.findModel('shared:vision/exp'), undefined));
  const result = await kernel.prompt('Reply DEPLOYMENT_BINDING_OK without using tools.', target, options(snapshot.model), 'steer');
  check('snapshot -> actual process -> HTTP succeeds', () => assert.ok(result.tokens.some(t => t.type === 'text' && t.text.includes('DEPLOYMENT_BINDING_OK')), JSON.stringify(result.tokens)));
  check('title and response stay on selected provider credentials', () => { assert.ok(requests.length >= 2); assert.ok(requests.every(r => r.path.startsWith('/two/') && r.auth === 'Bearer two-fixture' && r.model === 'shared:vision/exp')); });
  check('result retains qualified selection', () => assert.equal(result.model, select('two')));
  check('idle switch returns exact new provider selection', () => assert.equal(kernel.setModel(target, select('one')), select('one')));
  const start = requests.length;
  snapshot = kernel.snapshot(target);
  const switched = await kernel.prompt('Reply DEPLOYMENT_BINDING_OK again.', target, options(snapshot.model), 'steer');
  check('second send uses newly selected same-name deployment', () => { assert.equal(switched.model, select('one')); assert.ok(requests.length > start); assert.ok(requests.slice(start).every(r => r.path.startsWith('/one/') && r.auth === 'Bearer one-fixture')); });
  check('idle switch cannot revert at dequeue', () => assert.equal(kernel.conversationOwner(target).activeDeployment().providerId, 'one'));
  const cold = new Agent(root, { agentOnly: true });
  cold.selectWorkspaceFromStorage(workspace.id);
  cold.setConversationFromStorage(target.conversationId);
  const saved = cold.getConversationSnapshot().modelSelection;
  check('manual switch persists provider identity', () => assert.deepEqual(JSON.parse(JSON.stringify(saved)), { kind: 'deployment', providerId: 'one', modelId: 'shared:vision/exp' }));
  // A legacy snapshot echo must preserve a known binding at the run boundary.
  kernel.applyOptions(agent, options('shared:vision/exp'));
  check('legacy bare-name echo preserves restored exact deployment', () => assert.equal(agent.activeDeployment().providerId, 'one'));
  agent.setModel('missing');
  kernel.applyOptions(agent, options('shared:vision/exp'));
  check('unbound ambiguous selection is still rejected', () => assert.equal(agent.activeModelConfig(), undefined));
  cold.abortActiveKernelRun('test complete');
  console.log(JSON.stringify({ passed: checks.length, requests: requests.length }));
  for (const s of sockets) s.destroy(); server.close();
  process.exit(0);
})().catch(error => { console.error(error); for (const s of sockets) s.destroy(); server.close(); process.exit(1); });
