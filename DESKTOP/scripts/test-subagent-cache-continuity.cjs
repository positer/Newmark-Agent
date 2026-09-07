'use strict';

// Actual Agent / native kernel requests, captured by an in-process provider.
// The private bundle avoids overwriting another verification's shared dist/.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Module = require('node:module');
const desktop = path.resolve(__dirname, '..');
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const argv = process.argv.slice(2);
const option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;

async function loadSource(bundleRoot) {
  const filename = path.join(bundleRoot, 'subagent-cache-source.cjs');
  const sourceFiles = [];
  require('esbuild').buildSync({ entryPoints: [require.resolve('typebox/compile')], outfile: path.join(bundleRoot, 'typebox-compile.bundle.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' });
  await require('esbuild').build({
    stdin: { contents: 'export { Agent } from "./src/core/agent"; export { SubagentManager } from "./src/core/subagent"; export { openAIChatMessages } from "./src/providers/chat-messages"; export { LLMProvider } from "./src/llm/provider";', resolveDir: desktop, sourcefile: 'subagent-cache-entry.ts', loader: 'ts' },
    outfile: filename, bundle: true, platform: 'node', format: 'cjs', target: 'node18', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'isolated-source-override', setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]core[\\/](agent|agentKernelRunner|subagent|autoRouter)\.ts$/ }, args => {
        const replacement = option('--source-overrides') && path.join(path.resolve(option('--source-overrides')), path.basename(args.path));
        const source = replacement && fs.existsSync(replacement) ? replacement : args.path;
        const contents = fs.readFileSync(source, 'utf8');
        sourceFiles.push({ path: source, sha256: crypto.createHash('sha256').update(contents).digest('hex') });
        return { contents, loader: 'ts', resolveDir: path.dirname(args.path) };
      });
    } }],
  });
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(desktop);
  compiled._compile(fs.readFileSync(filename, 'utf8'), filename);
  return { ...compiled.exports, sourceFiles };
}

function configuration() {
  return {
    models: {
      providers: { value: [{ id: 'cache-peer-fixture', name: 'Peer cache fixture', enabled: true, base_url: 'https://fixture.invalid/v1', api_key: 'fixture-only', protocol: 'openai', models: [{
        name: 'cache-peer-model', display: 'Peer cache model', enabled: true, max_tokens: 128000, thinking: false,
        speed_rating: 'fast', capability_rating: 'high', capabilities: ['text_input', 'text_output', 'tool_use'],
        validation: { level: 'standard', status: 'verified', checked_at: '2026-09-07T00:00:00.000Z', capabilities: { text_input: true, text_output: true, tool_use: true } },
      }] }] },
      default_model: { value: 'cache-peer-model' }, auto_switch: { value: false }, fallback_on_unavailable: { value: false },
    },
    context: { auto_compress: { value: false } },
    workspace: { auto_create_timestamp_workspace: { value: false } },
  };
}

async function run() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-subagent-cache-'));
  const runtimeRoot = path.join(temporary, 'runtime');
  fs.mkdirSync(runtimeRoot);
  const config = configuration();
  const configFile = path.join(runtimeRoot, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const multilineFile = path.join(runtimeRoot, 'multiline-cache-fixture.txt');
  fs.writeFileSync(multilineFile, 'CACHE_READ_LINE_ONE\r\n缓存第二行\r\n\r\nCACHE_READ_LINE_FOUR\r\n');
  const { Agent, SubagentManager, openAIChatMessages, LLMProvider, sourceFiles } = await loadSource(temporary);
  const checks = [];
  const requests = [];
  const children = [];
  const jobs = [];
  const identities = [];
  const parents = [];
  let phase = '';
  let currentPeer = '';
  let currentParent;
  let jobRound = 0;
  let mailboxId;
  let inflightState;
  let earlyState;
  const originalIdentity = Agent.prototype.peerRequestCacheIdentity;
  if (originalIdentity) Agent.prototype.peerRequestCacheIdentity = function(systemPrompt, catalog) {
    const identity = originalIdentity.call(this, systemPrompt, catalog);
    if (identity) identities.push({ phase, identity, systemPrompt, catalogHash: hash(catalog), modelHash: hash(this.activeModelConfig()), apiMode: this.config.openAIApiMode(), adapters: this.config.contextFlag('provider_adapters_v2'), proxyHash: hash(this.providerProxyConfig()), intelligence: this.intelligence, compression: this.lastCompression?.at || '' });
    return identity;
  };
  const check = (name, fn) => {
    try { fn(); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: error.stack || String(error) }); }
    console.log(`[${checks.at(-1).passed ? 'PASS' : 'FAIL'}] ${name}`);
  };
  const provider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 64 }),
    async chat() { return 'Isolated peer cache fixture'; },
    async *chatStreamWithTools(model, messages, system, _temperature, _maxTokens, tools) {
      jobRound++;
      if (jobRound > 8) throw Error('Fixture request watchdog exceeded');
      const child = currentParent.activePeerAgents.get(currentPeer);
      if (!children.includes(child)) children.push(child);
      requests.push({ phase, round: jobRound, peerId: currentPeer, model, messages: copy(openAIChatMessages(messages)), system, tools: copy(tools), compression: copy(child.lastCompression) });
      // Explicit zero usage must remain zero; fixtures never claim upstream hits.
      yield { type: 'usage', text: '', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } };
      if (phase === 'initial' || phase === 'active-wake-true') {
        if (jobRound === 1) {
          const delivery = currentParent.subagents.sendMessage(currentParent.runtimeActorId, currentPeer, 'ACTIVE_MAILBOX_DELTA_ONLY', 'directive', {}, phase === 'active-wake-true');
          mailboxId = delivery.message?.id;
          assert.equal(delivery.ok, true);
        }
        if (jobRound <= 2) {
          yield { type: 'tool_call', text: '', toolCall: { id: `peer-cache-pwd-${jobRound}`, name: 'pwd', arguments: '{}' } };
          return;
        }
      }
      if (phase === 'schema-initial' && jobRound === 1) {
        yield { type: 'tool_call', text: '', toolCall: { id: 'peer-cache-provision', name: 'tool_provision', arguments: JSON.stringify({ names: ['task_read'] }) } };
        return;
      }
      if (phase === 'schema-initial' && jobRound === 2) {
        yield { type: 'tool_call', text: '', toolCall: { id: 'peer-cache-task-read', name: 'task_read', arguments: '{}' } };
        return;
      }
      if (phase === 'inflight-source' && jobRound === 1) {
        yield { type: 'tool_call', text: '', toolCall: { id: 'peer-cache-inflight-pwd', name: 'pwd', arguments: '{}' } };
        return;
      }
      if (phase === 'inflight-source' && jobRound === 2) inflightState = copy(currentParent.subagents.serialize());
      if (phase === 'early-source' && jobRound === 1) earlyState = copy(currentParent.subagents.serialize());
      if (phase === 'failed-source') {
        yield { type: 'text', text: '[LLM Error: 400] FIXTURE_FAILURE_WITHOUT_TOOL_EXECUTION' };
        return;
      }
      if (phase === 'whitespace-initial' && jobRound === 1) {
        yield { type: 'text', text: ' \nI will read the assigned fixture now.\n\n' };
        yield { type: 'tool_call', text: '', toolCall: { id: 'peer-cache-multiline-read', name: 'read', arguments: JSON.stringify({ path: multilineFile }) } };
        return;
      }
      yield { type: 'text', text: `PEER_CACHE_DONE_${phase}` };
    },
  };
  // A model switch may instantiate a fresh production provider. Keep that path
  // inside the fixture too, so every possible deployment remains network-free.
  Object.assign(LLMProvider.prototype, provider);
  function parent(state) {
    const owner = new Agent(runtimeRoot, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: 'peer-cache-fixture' });
    owner.workspace.current = null;
    owner.config.clearWorkspaceOverrides();
    owner.forcedProvider = provider;
    // Job dispatch is controlled so observations isolate the production job/kernel
    // path. Manager communication, transcript serialization and completion are real.
    owner.subagents = new SubagentManager({ conversationId: 'peer-cache-fixture', rootAgentId: state?.rootAgentId || owner.runtimeActorId, state,
      onMailboxMessage: message => owner.deliverActivePeerMailbox(message.toAgentId, message),
    });
    parents.push(owner);
    return owner;
  }
  async function job(owner, peerId, name, reason, prompt) {
    phase = name; currentParent = owner; currentPeer = peerId; jobRound = 0;
    owner.subagents.markWorking(peerId);
    const start = requests.length;
    const result = await owner.runSubagentJob(peerId, prompt, '', reason);
    owner.subagents.complete(peerId, result);
    jobs.push({ phase: name, requests: requests.length - start, result, metadata: copy(owner.subagents.get(peerId).metadata) });
    return requests.slice(start);
  }
  const prefixEqual = (before, after) => assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);
  const sameSystem = (actual, expected) => {
    if (actual === expected) return;
    let index = 0;
    while (index < actual.length && actual[index] === expected[index]) index++;
    assert.fail(`System differs at ${index}: actual=${JSON.stringify(actual.slice(Math.max(0, index - 90), index + 200))}; expected=${JSON.stringify(expected.slice(Math.max(0, index - 90), index + 200))}`);
  };
  try {
    const firstParent = parent();
    const peer = firstParent.subagents.create('cache analyst', 'Keep working on the isolated cache continuity task.', 'cache-peer-model');
    const initial = await job(firstParent, peer, 'initial', 'spawn', 'Keep working on the isolated cache continuity task.');
    check('active mailbox keeps complete system prefix unchanged', () => {
      assert.ok(initial.length >= 3);
      for (const request of initial.slice(1)) assert.equal(request.system, initial[0].system);
    });
    check('active mailbox keeps prior messages and native schemas unchanged', () => {
      for (let index = 1; index < initial.length; index++) {
        prefixEqual(initial[index - 1], initial[index]);
        assert.deepEqual(initial[index].tools, initial[0].tools);
      }
    });
    check('active mailbox is acknowledged only after one delivered user turn', () => {
      assert.ok(mailboxId);
      assert.ok(firstParent.subagents.serialize().mailbox.find(message => message.id === mailboxId)?.readAt);
      assert.equal(initial.at(-1).messages.filter(message => message.role === 'user' && String(message.content).includes('ACTIVE_MAILBOX_DELTA_ONLY')).length, 1);
      assert.equal(firstParent.subagents.get(peer).messages.filter(message => message.role === 'user' && message.content.includes('ACTIVE_MAILBOX_DELTA_ONLY')).length, 1);
    });
    const next = await job(firstParent, peer, 'continuation', 'mailbox', 'CONTINUATION_DELTA_ONLY');
    check('same peer continuation retains stable system and schemas', () => {
      sameSystem(next[0].system, initial.at(-1).system);
      assert.deepEqual(next[0].tools, initial.at(-1).tools);
    });
    check('same peer continuation preserves complete submitted history prefix', () => prefixEqual(initial.at(-1), next[0]));
    const stateFile = path.join(temporary, 'peer-state.json');
    fs.writeFileSync(stateFile, JSON.stringify(firstParent.subagents.serialize()));
    const coldParent = parent(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    const cold = await job(coldParent, peer, 'cold-resume', 'resume', 'COLD_RESUME_DELTA_ONLY');
    check('serialized peer state restores system, schemas and history after a new runtime owner', () => {
      assert.equal(cold[0].system, next[0].system);
      assert.deepEqual(cold[0].tools, next[0].tools);
      prefixEqual(next[0], cold[0]);
    });
    const compression = { at: '2026-09-07T00:00:00.000Z', originalMessages: 100, compressedMessages: 2, originalChars: 20000, compressedChars: 200, compressedTokens: 60, summary: 'PERSISTED_COMPRESSION_SUMMARY', model: 'cache-peer-model', fallback: true };
    coldParent.subagents.replaceContext(peer, [{ role: 'user', content: 'PERSISTED_COMPRESSION_SUMMARY', hidden_user_input: true }, { role: 'assistant', content: 'COMPRESSED_WORKING_BOUNDARY' }], compression);
    const compressed = await job(coldParent, peer, 'compressed-resume', 'resume', 'CONTINUE_AFTER_COMPRESSION');
    check('resumed peer restores compression metadata before its next request', () => assert.deepEqual(compressed[0].compression, compression));
    check('compression establishes an explicit new request prefix boundary', () => {
      assert.notEqual(compressed[0].system, cold[0].system);
      assert.ok(compressed[0].messages.some(message => String(message.content).includes('PERSISTED_COMPRESSION_SUMMARY')));
    });
    config.agent = { custom_prompt: { value: 'CUSTOM_PROMPT_CACHE_INVALIDATION_MARKER' } };
    fs.writeFileSync(configFile, JSON.stringify(config));
    const changed = await job(coldParent, peer, 'configuration-change', 'mailbox', 'CONTINUE_AFTER_CONFIGURATION_CHANGE');
    check('changed authoritative prompt invalidates a persisted peer prefix', () => {
      assert.notEqual(changed[0].system, compressed[0].system);
      assert.ok(changed[0].system.includes('CUSTOM_PROMPT_CACHE_INVALIDATION_MARKER'));
    });
    const schemaPeer = coldParent.subagents.create('schema analyst', 'Inspect persistent task state using the task_read tool.', 'cache-peer-model');
    const schemaInitial = await job(coldParent, schemaPeer, 'schema-initial', 'spawn', 'Inspect persistent task state using the task_read tool.');
    const schemaNext = await job(coldParent, schemaPeer, 'schema-continuation', 'mailbox', 'Continue with the existing loaded task tools.');
    check('advanced native schema and its sequence persist across peer jobs', () => {
      assert.ok(schemaInitial.at(-1).tools.some(tool => tool.function.name === 'task_read'));
      assert.deepEqual(schemaNext[0].tools, schemaInitial.at(-1).tools);
      assert.equal(schemaNext[0].system, schemaInitial.at(-1).system);
    });
    const schemaStateFile = path.join(temporary, 'schema-peer-state.json');
    fs.writeFileSync(schemaStateFile, JSON.stringify(coldParent.subagents.serialize()));
    const schemaColdParent = parent(JSON.parse(fs.readFileSync(schemaStateFile, 'utf8')));
    const schemaCold = await job(schemaColdParent, schemaPeer, 'schema-cold-resume', 'resume', 'Continue after serialized schema state recovery.');
    check('serialized advanced native schema and sequence survive a new runtime owner', () => {
      assert.deepEqual(schemaCold[0].tools, schemaInitial.at(-1).tools);
      assert.equal(schemaCold[0].system, schemaInitial.at(-1).system);
      prefixEqual(schemaNext[0], schemaCold[0]);
    });
    check('public durable transcript retains actual task result but excludes private broker turns', () => {
      const messages = schemaColdParent.subagents.get(schemaPeer).messages;
      assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === 'peer-cache-task-read'));
      assert.ok(!messages.some(message => message.tool_call_id === 'peer-cache-provision' || message.tool_calls?.some(call => call.id === 'peer-cache-provision')));
    });
    check('broker removal is confined to its explicit first persistence boundary', () => {
      assert.ok(schemaInitial.at(-1).messages.some(message => message.tool_call_id === 'peer-cache-provision'));
      assert.ok(!schemaNext[0].messages.some(message => message.tool_call_id === 'peer-cache-provision'));
      prefixEqual(schemaNext[0], schemaCold[0]);
    });
    const beforePermissionIdentity = schemaColdParent.subagents.get(schemaPeer).metadata?.requestCache?.identity;
    schemaColdParent.subagents.get(schemaPeer).agentMode = 'plan';
    const restricted = await job(schemaColdParent, schemaPeer, 'permission-change', 'mailbox', 'Continue read-only under the new Plan policy.');
    check('narrowed mode invalidates cached schema authority', () => {
      assert.ok(!restricted[0].tools.some(tool => ['write', 'edit', 'delete_file'].includes(tool.function.name)));
      assert.notEqual(schemaColdParent.subagents.get(schemaPeer).metadata?.requestCache?.identity, beforePermissionIdentity);
      assert.ok(restricted[0].system.includes('[Plan Tool Policy]'));
    });
    const updatedProviders = copy(schemaColdParent.config.providers());
    updatedProviders[0].models.push({ ...copy(updatedProviders[0].models[0]), name: 'cache-peer-model-second', display: 'Second cache fixture model' });
    schemaColdParent.config.set('models', 'providers', updatedProviders);
    schemaColdParent.subagents.get(schemaPeer).model = 'deployment:cache-peer-fixture:cache-peer-model-second';
    const beforeModelIdentity = schemaColdParent.subagents.get(schemaPeer).metadata?.requestCache?.identity;
    const redeployed = await job(schemaColdParent, schemaPeer, 'model-change', 'mailbox', 'Continue under the newly assigned model.');
    check('parent-assigned deployment change invalidates cached peer identity', () => {
      assert.equal(redeployed[0].model, 'cache-peer-model-second');
      assert.notEqual(schemaColdParent.subagents.get(schemaPeer).metadata?.requestCache?.identity, beforeModelIdentity);
    });
    // Exercise the actual manager's active-job checkpoint and replay path.
    const inflightOwner = parent();
    phase = 'inflight-source'; currentParent = inflightOwner; jobRound = 0;
    inflightOwner.subagents.bind({ executor: jobInfo => {
      currentPeer = jobInfo.record.id;
      return inflightOwner.runSubagentJob(jobInfo.record.id, jobInfo.prompt, jobInfo.flowName, jobInfo.reason);
    } });
    const inflightPeer = inflightOwner.subagents.create('inflight analyst', 'INITIAL_INFLIGHT_TASK perform one checkpointed read-only step.', 'cache-peer-model');
    await inflightOwner.subagents.waitForSettlement(inflightPeer, 10000);
    assert.ok(inflightState, 'In-flight checkpoint was captured before the final assistant message');
    const inflightFile = path.join(temporary, 'inflight-state.json');
    fs.writeFileSync(inflightFile, JSON.stringify(inflightState));
    const inflightColdOwner = parent(JSON.parse(fs.readFileSync(inflightFile, 'utf8')));
    phase = 'inflight-cold'; currentParent = inflightColdOwner; jobRound = 0;
    inflightColdOwner.subagents.bind({ executor: jobInfo => {
      currentPeer = jobInfo.record.id;
      return inflightColdOwner.runSubagentJob(jobInfo.record.id, jobInfo.prompt, jobInfo.flowName, jobInfo.reason);
    } });
    await inflightColdOwner.subagents.waitForSettlement(inflightPeer, 10000);
    const inflightRequests = requests.filter(request => request.phase === 'inflight-cold');
    check('in-flight disk checkpoint preserves completed tool context and resumes once', () => {
      assert.equal(inflightRequests.length, 1);
      assert.ok(inflightRequests[0].messages.some(message => message.role === 'tool' && message.tool_call_id === 'peer-cache-inflight-pwd'));
      assert.equal(inflightRequests[0].messages.filter(message => message.role === 'user').reduce((sum, message) => sum + (String(message.content).match(/INITIAL_INFLIGHT_TASK/g) || []).length, 0), 1);
    });
    const earlyOwner = parent();
    phase = 'early-source'; currentParent = earlyOwner; jobRound = 0;
    earlyOwner.subagents.bind({ executor: jobInfo => {
      currentPeer = jobInfo.record.id;
      return earlyOwner.runSubagentJob(jobInfo.record.id, jobInfo.prompt, jobInfo.flowName, jobInfo.reason);
    } });
    const earlyPeer = earlyOwner.subagents.create('early checkpoint analyst', 'INITIAL_EARLY_TASK retain this real user instruction before any result.', 'cache-peer-model');
    await earlyOwner.subagents.waitForSettlement(earlyPeer, 10000);
    assert.ok(earlyState, 'Checkpoint captured at the first provider request before any output');
    const earlyFile = path.join(temporary, 'early-state.json');
    fs.writeFileSync(earlyFile, JSON.stringify(earlyState));
    const earlyColdOwner = parent(JSON.parse(fs.readFileSync(earlyFile, 'utf8')));
    phase = 'early-cold'; currentParent = earlyColdOwner; jobRound = 0;
    earlyColdOwner.subagents.bind({ executor: jobInfo => {
      currentPeer = jobInfo.record.id;
      return earlyColdOwner.runSubagentJob(jobInfo.record.id, jobInfo.prompt, jobInfo.flowName, jobInfo.reason);
    } });
    await earlyColdOwner.subagents.waitForSettlement(earlyPeer, 10000);
    const earlyColdRequests = requests.filter(request => request.phase === 'early-cold');
    check('first-request checkpoint retains the committed real user before any assistant or tool output', () => {
      assert.equal(earlyColdRequests.length, 1);
      assert.equal(earlyColdRequests[0].messages.filter(message => message.role === 'user').reduce((sum, message) => sum + (String(message.content).match(/INITIAL_EARLY_TASK/g) || []).length, 0), 1);
    });
    const failedOwner = parent();
    phase = 'failed-source'; currentParent = failedOwner; jobRound = 0;
    failedOwner.subagents.bind({ executor: jobInfo => {
      currentPeer = jobInfo.record.id;
      return failedOwner.runSubagentJob(jobInfo.record.id, jobInfo.prompt, jobInfo.flowName, jobInfo.reason);
    } });
    const failedPeer = failedOwner.subagents.create('failure analyst', 'INITIAL_FAILED_TASK observe the provider without any external action.', 'cache-peer-model');
    const failure = await failedOwner.subagents.waitForSettlement(failedPeer, 10000);
    const failedFile = path.join(temporary, 'failed-state.json');
    fs.writeFileSync(failedFile, JSON.stringify(failedOwner.subagents.serialize()));
    const failedColdOwner = parent(JSON.parse(fs.readFileSync(failedFile, 'utf8')));
    phase = 'failed-cold'; currentParent = failedColdOwner; jobRound = 0;
    failedColdOwner.subagents.bind({ executor: jobInfo => {
      currentPeer = jobInfo.record.id;
      return failedColdOwner.runSubagentJob(jobInfo.record.id, jobInfo.prompt, jobInfo.flowName, jobInfo.reason);
    } });
    const retryAccepted = failedColdOwner.subagents.sendMessage(failedColdOwner.runtimeActorId, failedPeer, 'RECOVER_FAILED_TASK_DELTA', 'directive', {}, true);
    await failedColdOwner.subagents.waitForSettlement(failedPeer, 10000);
    const failedSourceRequests = requests.filter(request => request.phase === 'failed-source');
    const failedColdRequests = requests.filter(request => request.phase === 'failed-cold');
    check('provider failure without tool effects persists truthful error and resumes only the new directive', () => {
      assert.equal(failure.status, 'error');
      assert.equal(retryAccepted.ok, true);
      assert.equal(failedSourceRequests.length, 1);
      assert.ok(!failedSourceRequests[0].messages.some(message => message.role === 'tool'));
      assert.equal(failedColdRequests.length, 1);
      assert.equal(failedColdRequests[0].messages.filter(message => message.role === 'user').reduce((sum, message) => sum + (String(message.content).match(/INITIAL_FAILED_TASK/g) || []).length, 0), 1);
      assert.equal(failedColdRequests[0].messages.filter(message => message.role === 'user').reduce((sum, message) => sum + (String(message.content).match(/RECOVER_FAILED_TASK_DELTA/g) || []).length, 0), 1);
    });
    const whitespaceOwner = parent();
    const whitespacePeer = whitespaceOwner.subagents.create('whitespace analyst', 'Read the assigned multiline fixture and preserve working context.', 'cache-peer-model');
    const whitespaceInitial = await job(whitespaceOwner, whitespacePeer, 'whitespace-initial', 'spawn', 'Read the assigned multiline fixture and preserve working context.');
    const whitespaceNext = await job(whitespaceOwner, whitespacePeer, 'whitespace-continuation', 'mailbox', 'Continue from the existing read result without rereading.');
    check('assistant tool preface whitespace and multiline read result preserve exact serialized message prefix', () => {
      assert.ok(whitespaceInitial.at(-1).messages.some(message => message.role === 'tool' && String(message.content).includes('CACHE_READ_LINE_ONE') && String(message.content).includes('缓存第二行')));
      prefixEqual(whitespaceInitial.at(-1), whitespaceNext[0]);
      assert.equal(JSON.stringify(whitespaceNext[0].messages.slice(0, whitespaceInitial.at(-1).messages.length)), JSON.stringify(whitespaceInitial.at(-1).messages));
    });
    const dormantPeerBefore = JSON.stringify(whitespaceOwner.subagents.get(whitespacePeer));
    const dormantRequestsBefore = requests.length;
    const dormantMail = await whitespaceOwner.handleSubagentContinueEnvelope(JSON.stringify({ id: whitespacePeer, prompt: 'INACTIVE_FALSE_CACHE_DELTA', wakeup: false }));
    await new Promise(resolve => setTimeout(resolve, 20));
    check('inactive wakeup false leaves peer history, request cache, schemas and record byte-identical', () => {
      assert.equal(dormantMail.ok, true);
      assert.equal(JSON.stringify(whitespaceOwner.subagents.get(whitespacePeer)), dormantPeerBefore);
      assert.equal(requests.length, dormantRequestsBefore);
      assert.ok(whitespaceOwner.subagents.serialize().mailbox.some(message => message.toAgentId === whitespacePeer && message.body === 'INACTIVE_FALSE_CACHE_DELTA' && message.wakeup === false && !message.readAt));
    });
    const activeWakePeer = whitespaceOwner.subagents.create('active true analyst', 'Keep the active mailbox cache prefix stable.', 'cache-peer-model');
    const activeWake = await job(whitespaceOwner, activeWakePeer, 'active-wake-true', 'spawn', 'Keep the active mailbox cache prefix stable.');
    check('active wakeup true shares the same append-only prefix and schema behavior as false', () => {
      assert.ok(activeWake.length >= 3);
      for (let index = 1; index < activeWake.length; index++) {
        assert.equal(activeWake[index].system, activeWake[0].system);
        assert.deepEqual(activeWake[index].tools, activeWake[0].tools);
        prefixEqual(activeWake[index - 1], activeWake[index]);
      }
      assert.equal(activeWake.at(-1).messages.filter(message => message.role === 'user' && String(message.content).includes('ACTIVE_MAILBOX_DELTA_ONLY')).length, 1);
    });
    check('zero cache counters remain zero instead of being inferred from stable prefixes', () => {
      assert.ok(children.length >= 1);
      for (const child of children) assert.equal(child.providerUsageTotals.cacheRead, 0);
    });
    const report = {
      at: new Date().toISOString(), node: process.version, sourceFiles, passed: checks.every(item => item.passed), checks,
      boundary: 'Actual source Agent / native kernel with a controlled in-process provider and production Chat message serialization. Most jobs are explicitly scheduled; in-flight checkpoint restoration uses the actual manager pump. Disk JSON plus fresh Agent/manager checks client restoration, not process-crash durability. No paid API, production settings, or upstream cache-hit claim. Private broker history is intentionally absent from public persistence; its first removal is a message-prefix cache boundary even when native schema/system continuity passes.',
      jobs, childInstancesObserved: children.length,
      identities: identities.map(({ systemPrompt, ...entry }) => ({ ...entry, systemHash: hash(systemPrompt), sections: systemPrompt.split('\n').filter(line => /retained|goal|histor|compress|task|tool|latest/i.test(line)) })),
      requests: requests.map(({ messages, system, tools, ...request }) => ({ ...request, messagesHash: hash(messages), systemHash: hash(system), toolsHash: hash(tools), messageCount: messages.length, toolNames: tools.map(tool => tool.function.name) })),
    };
    if (option('--output')) fs.writeFileSync(path.resolve(option('--output')), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failed: checks.filter(item => !item.passed).map(item => item.name), requests: requests.length, childInstancesObserved: children.length }));
    if (!report.passed) process.exitCode = 1;
  } finally {
    for (const owner of [...children, ...parents]) owner?.flushWorkspaceConversationState();
    if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('newmark-subagent-cache-')) throw Error('Refusing cleanup outside owned temporary directory');
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (require.main === module) run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { run };
