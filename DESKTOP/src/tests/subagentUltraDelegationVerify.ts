/** Real Agent/kernel/tool delegation with deterministic provider fixtures.
 * This proves scheduling, assignment and permission behavior, not LLM planning
 * quality or upstream cache hits. No shared build output or live credentials.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent, type BuildProviderCache } from '../core/agent';
import { LLMProvider } from '../llm/provider';
import { SubagentManager } from '../core/subagent';
import type { StreamToken } from '../core/types';

type Request = { peer: string; model: string; provider: string; system: string; messages: Array<Record<string, unknown>>; tools: unknown[] };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 2));
async function until(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await tick();
  }
}
let assertions = 0;
function check(condition: unknown, label: string): void {
  assert.ok(condition, label);
  assertions++;
  console.log(`PASS: ${label}`);
}
function model(name: string, tools = true) {
  return { name, display: name, max_tokens: 128000, vision: false, thinking: false,
    capabilities: ['text_input', 'text_output', ...(tools ? ['tool_use'] : [])],
    validation: { level: 'standard', status: 'verified', checked_at: new Date().toISOString(),
      capabilities: { text_input: true, text_output: true, tool_use: tools } } };
}
function fixture(root: string, id: string): Agent {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: { value: [
        { id: 'delegate-a', name: 'Delegate A', base_url: 'https://delegate-a.invalid/v1', api_key: 'fixture-a', protocol: 'openai', enabled: true, models: [model('shared-name'), model('chat-only', false)] },
        { id: 'delegate-b', name: 'Delegate B', base_url: 'https://delegate-b.invalid/v1', api_key: 'fixture-b', protocol: 'openai', enabled: true, models: [model('shared-name')] },
      ] }, default_model: { value: 'deployment:delegate-a:shared-name' },
      default_intelligence: { value: 'ultra' }, auto_switch: { value: false },
    },
    context: { auto_compress: { value: false } },
    workspace: { auto_create_timestamp_workspace: { value: false } },
  }));
  const agent = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: id });
  agent.workspace.current = null;
  agent.config.clearWorkspaceOverrides();
  return agent;
}

async function concurrentAdmission(root: string): Promise<void> {
  for (const [tier, capacity] of [['medium', 4], ['ultra', 16]] as const) {
    const agent = fixture(path.join(root, tier), `admission-${tier}`);
    agent.subagents.pauseScheduling();
    agent.setIntelligence(tier);
    const run = `admission-${tier}`;
    agent.beginConversationWorkRun(run);
    const results = await Promise.all(Array.from({ length: 64 }, (_, index) =>
      agent.handleSubagentEnvelope(JSON.stringify({ name: `${tier}-${index}`, prompt: 'Bounded independent task' }), true)));
    check(results.filter(result => result.ok).length === capacity, `${tier}: 64 simultaneous admissions preserve ${capacity} active Build slots`);
    check(results.filter(result => !result.ok && result.metadata?.terminated === true).length === 64 - capacity,
      `${tier}: every excess admission fails before creating a durable peer`);
    check(agent.subagents.listAll().length === capacity, `${tier}: rejected calls leave no hidden queue entries`);
    agent.subagents.close(results.find(result => result.ok)!.data!.id, agent.subagents.rootAgentId);
    const replacement = await agent.handleSubagentEnvelope(JSON.stringify({ name: 'replacement', prompt: 'Replace one closed task' }), true);
    check(replacement.ok && agent.subagents.activeCountForBuild(run) === capacity,
      `${tier}: closing one peer frees exactly one active admission slot`);
    agent.abortActiveKernelRun();
    for (const record of agent.subagents.listAll()) agent.subagents.close(record.id, agent.subagents.rootAgentId);
    agent.releaseConversationRuntimeBindings();
  }
}

async function restoredQueue(): Promise<void> {
  const seed = new SubagentManager({ concurrency: 16, conversationId: 'ultra-restored-fifo' });
  seed.pauseScheduling();
  const ids = Array.from({ length: 96 }, (_, index) => seed.create(`queued-${index}`, `work-${index}`, 'fixture', 'guide', 'build', seed.rootAgentId, '', '', 0, `historical-build-${Math.floor(index / 16)}`, 'ultra'));
  const starts: string[] = [];
  const gates: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const manager = new SubagentManager({ state: seed.serialize(), concurrency: 16, executor: async job => {
    starts.push(job.record.id);
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>(resolve => gates.push(resolve));
    active--;
    return `finished:${job.record.name}`;
  } });
  manager.resumeScheduling();
  await until(() => starts.length === 16, 'sixteen restored jobs started');
  check(manager.listAll().filter(record => record.status === 'queued').length === 80, 'restored work beyond sixteen slots stays durably queued');
  while (manager.hasPendingWork()) {
    gates.splice(0).forEach(release => release());
    await tick();
  }
  check(peak === 16 && active === 0, '96 restored jobs execute at exactly sixteen concurrent slots and fully drain');
  check(JSON.stringify(starts) === JSON.stringify(ids), 'all six restored Build waves start once in FIFO order');
}

async function realPeerRuns(root: string, requests: Request[]): Promise<void> {
  const agent = fixture(root, 'ultra-real-peer-runs');
  agent.subagents.pauseScheduling();
  agent.beginConversationWorkRun('ultra-tools');
  const ids: string[] = [];
  for (let index = 0; index < 16; index++) {
    fs.writeFileSync(path.join(root, `task-${index}.txt`), `OWN_RESULT_${index}`);
    const result = await agent.handleSubagentEnvelope(JSON.stringify({
      name: `worker-${index}`, prompt: `Read only ${path.join(root, `task-${index}.txt`)} and report its contents.`,
      model: `deployment:delegate-${index % 2 ? 'b' : 'a'}:shared-name`,
    }), true);
    assert.equal(result.ok, true);
    ids.push(result.data!.id);
  }
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let atProvider = 0;
  let peak = 0;
  const prior = LLMProvider.prototype.chatStreamWithTools;
  LLMProvider.prototype.chatStreamWithTools = async function* (modelName, messages, system, _temperature, _budget, tools): AsyncGenerator<StreamToken> {
    const peer = String(system || '').match(/You are subagent "([^"]+)"/)?.[1] || '';
    const index = Number(peer.replace('worker-', ''));
    assert.match(peer, /^worker-\d+$/);
    requests.push(copy({ peer, model: modelName, provider: this.baseUrl, system: system || '', messages, tools }));
    const ownToolResult = messages.find(message => message.role === 'tool' && String(message.content).includes(`OWN_RESULT_${index}`));
    if (!ownToolResult) {
      atProvider++;
      peak = Math.max(peak, atProvider);
      try { await gate; } finally { atProvider--; }
      yield { type: 'tool_call', text: '', toolCall: { id: `read-${index}`, name: 'read', arguments: JSON.stringify({ path: path.join(root, `task-${index}.txt`) }) } };
    } else {
      yield { type: 'text', text: `VERIFIED_OWN_RESULT_${index}` };
    }
  };
  try {
    agent.subagents.resumeScheduling();
    await until(() => atProvider === 16 || agent.subagents.listAll().some(record => record.status === 'error'), 'sixteen real child Agent provider requests');
    assert.equal(atProvider, 16, JSON.stringify(agent.subagents.listAll().map(record => ({ name: record.name, status: record.status, error: record.error }))));
    check(peak === 16, 'sixteen real child Agents overlap at their provider request boundary');
    release();
    await until(() => !agent.subagents.hasPendingWork(), 'child file tools and continuations complete');
    check(requests.every(request => request.system.includes('[Ultra Intelligence – Specialist Role]') && !request.system.includes('You are the lead orchestrator.')),
      'actual child requests receive the specialist role without the parent lead-orchestrator instruction');
    for (let index = 0; index < 16; index++) {
      const record = agent.subagents.get(ids[index])!;
      const calls = requests.filter(request => request.peer === `worker-${index}`);
      check(record.status === 'completed' && record.result === `VERIFIED_OWN_RESULT_${index}`, `worker ${index}: real file read and tool continuation complete its own task`);
      check(calls.length === 2 && calls.every(call => call.provider === `https://delegate-${index % 2 ? 'b' : 'a'}.invalid/v1` && call.model === 'shared-name'),
        `worker ${index}: exact provider assignment survives equal model names and tool continuation`);
      check(calls[0].system === calls[1].system && JSON.stringify(calls[0].tools) === JSON.stringify(calls[1].tools),
        `worker ${index}: initialized system and tool schema bytes stay stable across tool continuation`);
      check(record.messages.some(message => message.role === 'tool' && message.tool_call_id === `read-${index}` && message.content.includes(`OWN_RESULT_${index}`)),
        `worker ${index}: durable transcript preserves the corresponding actual tool result`);
    }
  } finally {
    release();
    agent.abortActiveKernelRun();
    await until(() => !agent.subagents.hasPendingWork(), 'peer cancellation cleanup');
    agent.releaseConversationRuntimeBindings();
    LLMProvider.prototype.chatStreamWithTools = prior;
  }
}

async function planBoundary(root: string): Promise<void> {
  const agent = fixture(root, 'ultra-plan-policy');
  agent.setMode('plan');
  agent.subagents.pauseScheduling();
  agent.beginConversationWorkRun('ultra-plan');
  const forbidden = path.join(root, 'must-not-exist.txt');
  const accepted = await agent.handleSubagentEnvelope(JSON.stringify({ name: 'plan-peer', mode: 'build', prompt: 'Investigate only' }), true);
  check(accepted.ok && accepted.data?.agentMode === 'plan', 'Plan parent forces a requested Build child to remain Plan');
  let calls = 0;
  const outputs: string[] = [];
  const prior = LLMProvider.prototype.chatStreamWithTools;
  LLMProvider.prototype.chatStreamWithTools = async function* (_model, messages): AsyncGenerator<StreamToken> {
    calls++;
    if (calls === 1) {
      yield { type: 'tool_call', text: '', toolCall: { id: 'forbidden-write', name: 'write', arguments: JSON.stringify({ path: forbidden, content: 'forbidden' }) } };
    } else {
      outputs.push(...messages.filter(message => message.role === 'tool').map(message => String(message.content || '')));
      yield { type: 'text', text: 'PLAN_BOUNDARY_OBSERVED' };
    }
  };
  try {
    agent.subagents.resumeScheduling();
    await until(() => !agent.subagents.hasPendingWork(), 'Plan permission rejection');
    check(!fs.existsSync(forbidden), 'a real Plan child kernel rejects attempted file mutation');
    check(calls === 2 && outputs.some(output => /permission|not found|unknown|not available|not exposed/i.test(output)), 'rejected hidden write returns an explicit tool error before continuation');
  } finally {
    agent.abortActiveKernelRun();
    agent.releaseConversationRuntimeBindings();
    LLMProvider.prototype.chatStreamWithTools = prior;
  }
}

async function providerLifetimes(root: string): Promise<{ peers: number; requests: number }> {
  const agent = fixture(root, 'ultra-provider-lifetime');
  agent.beginConversationWorkRun('ultra-provider-lifetime');
  const cacheOwner = agent as unknown as { peerProviderCaches: Map<string, BuildProviderCache> };
  const seen = new Map<string, LLMProvider[]>();
  const previous = LLMProvider.prototype.chatStreamWithTools;
  let heldRequestCancelled = false;
  LLMProvider.prototype.chatStreamWithTools = async function* (_model, _messages, system, _temperature, _budget, _tools, signal): AsyncGenerator<StreamToken> {
    const peer = String(system || '').match(/You are subagent "([^"]+)"/)?.[1] || '';
    const instances = seen.get(peer) || [];
    instances.push(this);
    seen.set(peer, instances);
    if (peer === 'close-while-running') {
      await new Promise<void>((_resolve, reject) => {
        const cancelled = () => { heldRequestCancelled = true; reject(signal?.reason || new Error('Cancelled fixture')); };
        if (signal?.aborted) cancelled();
        else signal?.addEventListener('abort', cancelled, { once: true });
      });
    }
    yield { type: 'text', text: `LIFETIME_DONE_${peer}_${instances.length}` };
  };
  const create = async (name: string, selection = 'deployment:delegate-a:shared-name'): Promise<string> => {
    const accepted = await agent.handleSubagentEnvelope(JSON.stringify({ name, prompt: `Complete the bounded ${name} task.`, model: selection }), true);
    assert.equal(accepted.ok, true, accepted.output);
    const id = accepted.data!.id;
    await until(() => agent.subagents.get(id)?.status === 'completed' || agent.subagents.get(id)?.status === 'error', `provider lifetime ${name}`);
    assert.equal(agent.subagents.get(id)?.status, 'completed', agent.subagents.get(id)?.error);
    return id;
  };
  const wake = async (id: string): Promise<LLMProvider> => {
    const peer = agent.subagents.get(id)!.name;
    const before = seen.get(peer)!.length;
    assert.equal(agent.subagents.sendMessage(agent.subagents.rootAgentId, id, `Continue with lifetime step ${before}`, 'directive', {}, true).ok, true);
    await until(() => seen.get(peer)!.length > before && agent.subagents.get(id)?.status === 'completed', `provider lifetime continuation ${peer}`);
    return seen.get(peer)!.at(-1)!;
  };
  const changeProvider = (edit: (provider: Record<string, any>) => void): void => {
    const providers = copy(agent.config.providers());
    edit(providers.find(provider => provider.id === 'delegate-a')!);
    agent.config.set('models', 'providers', providers);
  };
  try {
    const id = await create('retained-peer');
    const original = seen.get('retained-peer')![0];
    check(await wake(id) === original, 'same peer mailbox job reuses its actual provider object across completed child runtimes');
    changeProvider(provider => { provider.api_key = 'rotated-fixture-key'; });
    const rotated = await wake(id);
    check(rotated !== original && rotated.apiKey === 'rotated-fixture-key', 'credential change replaces a retained peer provider before its next actual request');
    check(await wake(id) === rotated, 'the rotated peer provider remains reusable on subsequent mailbox jobs');
    changeProvider(provider => { provider.models.find((item: { name: string }) => item.name === 'shared-name').thinking_tier_map = { high: 'deep' }; });
    const remapped = await wake(id);
    check(remapped !== rotated && remapped.thinkingTierMaps?.['shared-name']?.high === 'deep', 'thinking-map change invalidates the actual retained provider');
    agent.config.set('models', 'openai_api_mode', 'responses');
    const responses = await wake(id);
    check(responses !== remapped, 'API-mode change replaces the provider used by the next mailbox job');
    agent.config.set('proxy', 'enabled', true);
    agent.config.set('proxy', 'url', 'http://127.0.0.1:9');
    const proxied = await wake(id);
    check(proxied !== responses, 'proxy change replaces the provider before the next mailbox job');
    agent.config.set('proxy', 'enabled', false);
    agent.config.set('models', 'openai_api_mode', 'chat_stream');
    changeProvider(provider => { provider.models.push({ ...model('specialist-model'), thinking_tier_map: { high: 'specialist-deep' } }); });
    const specialistId = await create('specialist-peer', 'deployment:delegate-a:specialist-model');
    const specialist = seen.get('specialist-peer')![0];
    check(specialist.thinkingTierMaps?.['specialist-model']?.high === 'specialist-deep'
      && !specialist.thinkingTierMaps?.['shared-name'], 'different model under the same provider receives its own thinking map');
    check(await wake(specialistId) === specialist, 'a specialist deployment keeps its own provider across mailbox continuations');
    const sameModelId = await create('isolated-peer');
    check(seen.get('isolated-peer')![0] !== await wake(id), 'different peer identities never share a provider object even at the same deployment');
    check(agent.handleSubagentCloseEnvelope(JSON.stringify({ id: sameModelId })).ok && !cacheOwner.peerProviderCaches.has(sameModelId), 'closing a completed peer immediately drops its provider cache slot');
    const generated: string[] = [];
    let maximum = cacheOwner.peerProviderCaches.size;
    for (let index = 0; index < 40; index++) {
      generated.push(await create(`bounded-${index}`));
      maximum = Math.max(maximum, cacheOwner.peerProviderCaches.size);
    }
    check(maximum === 32 && cacheOwner.peerProviderCaches.size === 32, 'forty sequential real peers keep the provider cache at its hard 32-slot bound');
    const oldest = generated[0], newest = generated.at(-1)!;
    check(!cacheOwner.peerProviderCaches.has(oldest) && cacheOwner.peerProviderCaches.has(newest), 'provider cache evicts the oldest idle peer while retaining the newest peer');
    const oldProvider = seen.get('bounded-0')![0];
    check(await wake(oldest) !== oldProvider && cacheOwner.peerProviderCaches.size === 32, 'an evicted peer reconstructs a fresh provider and keeps the bound on mailbox resume');
    const held = await agent.handleSubagentEnvelope(JSON.stringify({ name: 'close-while-running', prompt: 'Hold for explicit cancellation' }), true);
    assert.equal(held.ok, true);
    const heldId = held.data!.id;
    await until(() => seen.has('close-while-running'), 'running close fixture entered provider');
    check(cacheOwner.peerProviderCaches.has(heldId) && agent.subagents.get(heldId)?.status === 'working', 'a running peer owns a provider cache slot before close');
    check(agent.handleSubagentCloseEnvelope(JSON.stringify({ id: heldId })).ok && !cacheOwner.peerProviderCaches.has(heldId), 'closing a running peer immediately releases its cached provider');
    await until(() => heldRequestCancelled && !agent.subagents.hasPendingWork(), 'running close cancels provider and settles');
    check(agent.subagents.get(heldId)?.status === 'closed' && !cacheOwner.peerProviderCaches.has(heldId), 'provider cancellation completion preserves closed state without recreating the cache slot');
    const durable = JSON.stringify(agent.subagents.serialize());
    check(!durable.includes('peerProviderCaches') && !durable.includes('rotated-fixture-key') && !durable.includes('delegate-a.invalid'),
      'durable peer state contains neither runtime provider objects nor their credentials/endpoints');
    for (const record of agent.subagents.listAll()) agent.handleSubagentCloseEnvelope(JSON.stringify({ id: record.id }));
    check(cacheOwner.peerProviderCaches.size === 0, 'closing all retained peers releases every provider cache slot');
    return { peers: seen.size, requests: [...seen.values()].reduce((sum, instances) => sum + instances.length, 0) };
  } finally {
    agent.abortActiveKernelRun();
    for (const record of agent.subagents.listAll()) agent.handleSubagentCloseEnvelope(JSON.stringify({ id: record.id }));
    await until(() => !agent.subagents.hasPendingWork(), 'provider lifetime cleanup');
    agent.releaseConversationRuntimeBindings();
    LLMProvider.prototype.chatStreamWithTools = previous;
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-ultra-delegation-'));
  const priorChat = LLMProvider.prototype.chat;
  LLMProvider.prototype.chat = async () => 'Local delegation fixture';
  try {
    await concurrentAdmission(path.join(root, 'admission'));
    await restoredQueue();
    const requests: Request[] = [];
    await realPeerRuns(path.join(root, 'real'), requests);
    await planBoundary(path.join(root, 'plan'));
    const lifetimes = await providerLifetimes(path.join(root, 'provider-lifetimes'));
    console.log(JSON.stringify({ ok: true, suite: 'subagentUltraDelegationVerify', assertions, concurrentChildAgents: 16,
      concurrentChildRequests: requests.length, providerLifecyclePeers: lifetimes.peers, providerLifecycleRequests: lifetimes.requests,
      restoredQueuedPeers: 96, elapsedMs: Date.now() - started,
      boundaries: 'Provider generation is deterministic; no live-model planning quality or upstream cache-hit claim.' }));
  } finally {
    LLMProvider.prototype.chat = priorChat;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
