/** Actual Agent / Native Kernel cache continuity on Guide and routing recovery.
 * Providers are deterministic in-process fixtures; no network or cache-hit claim.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../core/agent';
import type { StreamToken } from '../core/types';

type Request = { model: string; system: string; messages: Array<Record<string, unknown>>; tools: Array<Record<string, any>> };
let passed = 0;
let failed = 0;
function check(value: boolean, label: string): void {
  console.log(`  [${value ? 'PASS' : 'FAIL'}] ${label}`);
  if (value) passed++; else failed++;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const names = (request: Request): string[] => request.tools.map(tool => String(tool.function?.name || ''));

function model(name: string, vision = false) {
  return {
    name, display: name, description: 'Local cache retry fixture', max_tokens: 128000,
    vision, image_output: vision, thinking: false, speed_rating: 'fast', capability_rating: 'high',
    validation: { level: 'standard', status: 'verified', checked_at: '2026-09-06T00:00:00.000Z',
      capabilities: { text_input: true, text_output: true, tool_use: true, image_input: vision, image_output: vision } },
    capabilities: ['text_input', 'text_output', 'tool_use', ...(vision ? ['image_input', 'image_output'] : [])],
  };
}

function fixture(root: string, id: string, auto: boolean): Agent {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: { value: [{ id: 'cache-retry', name: 'Cache Retry Fixture', enabled: true,
        base_url: 'https://cache-retry.invalid/v1', api_key: 'fixture-only', protocol: 'openai',
        models: auto ? [model('same-deployment')] : [model('primary-vision', true), model('fallback-text')] }] },
      default_model: { value: auto ? 'auto' : 'primary-vision' },
      auto_switch: { value: auto }, fallback_on_unavailable: { value: true },
      auto_switch_scope: { value: 'provider' }, auto_switch_anchor_provider: { value: 'cache-retry' },
    },
    context: { auto_compress: { value: false } },
    workspace: { auto_create_timestamp_workspace: { value: false } },
  }, null, 2));
  const agent = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: id });
  agent.workspace.current = null;
  agent.config.clearWorkspaceOverrides();
  return agent;
}

async function sameDeployment(root: string, alwaysFail: boolean): Promise<void> {
  const agent = fixture(root, alwaysFail ? 'retry-exhausted' : 'retry-guide', true);
  const calls: Request[] = [];
  const routeKinds: string[] = [];
  const guide = 'Guide: search the web for documentation; preserve the original code task.';
  let guideAccepted = false;
  const provider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 64 }),
    async *chatStreamWithTools(modelName: string, messages: Array<Record<string, unknown>>, system: string,
      _temperature: number, _maxTokens: number, tools: Array<Record<string, any>>): AsyncGenerator<StreamToken> {
      calls.push(copy({ model: modelName, messages, system, tools }));
      routeKinds.push(agent.routeTransitionKind());
      if (calls.length === 1) {
        guideAccepted = agent.queueActiveKernelMessage(guide, 'steer', 'cache-guide', agent.currentWorkRunId());
        yield { type: 'tool_call', text: '', toolCall: {
          id: 'cache-provision', name: 'tool_provision', arguments: JSON.stringify({ names: ['git_status'] }),
        } };
      } else if (calls.length === 2 || alwaysFail) {
        yield { type: 'text', text: '[LLM Error: 503] CACHE_RETRY_UNAVAILABLE' };
      } else {
        yield { type: 'text', text: 'CACHE_RETRY_RECOVERED' };
      }
    },
    async chat(): Promise<string> { return 'Cache retry fixture'; },
  };
  (agent as unknown as { forcedProvider: typeof provider }).forcedProvider = provider;
  let output = '';
  let thrown = '';
  try {
    output = (await agent.process('Fix the code repository without making external changes.')).map(token => token.text || '').join('');
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
    if (!alwaysFail) throw error;
  }
  const label = alwaysFail ? 'exhausted' : 'recovered';
  console.log(`  TRACE ${JSON.stringify({ label, requests: calls.length, routeKinds,
    models: calls.map(call => call.model), routingLines: calls.map(call => call.system.split('\n').find(line => line.startsWith('Capability routing fingerprint:'))),
    schemaCounts: calls.map(call => call.tools.length), guideCounts: calls.map(call => call.messages.filter(message => message.role === 'user' && message.content === guide).length) })}`);
  check(guideAccepted && calls.length >= 2 && calls[1].messages.some(message => message.role === 'user' && message.content === guide), `${label}: real kernel steering delivers Guide before failing request`);
  check(calls.length === 3 && routeKinds[2] === 'retry_same_deployment', `${label}: real Auto router performs exactly one same-deployment retry`);
  check(calls.every(call => call.model === 'same-deployment'), `${label}: retry stays on the initial deployment`);
  check(calls.every(call => call.system === calls[0].system), `${label}: Guide plus retry preserves complete initialized system bytes`);
  check(calls.length >= 3 && JSON.stringify(calls[2].tools) === JSON.stringify(calls[1].tools), `${label}: retry retains provisioned schemas in exact order`);
  check(calls.length >= 2 && names(calls[1]).includes('git_status')
    && JSON.stringify(calls[1].tools.slice(0, calls[0].tools.length)) === JSON.stringify(calls[0].tools), `${label}: provisioning only appends to the previously emitted schema prefix`);
  check(calls.length >= 3 && JSON.stringify(calls[2].messages) === JSON.stringify(calls[1].messages), `${label}: failed assistant is removed without changing the replayed message prefix`);
  check(agent.history.filter(message => message.role === 'user' && message.content === guide).length === 1, `${label}: Guide persists once`);
  check(!JSON.stringify(agent.history).includes('CACHE_RETRY_UNAVAILABLE'), `${label}: failed assistant is absent from durable history`);
  check(alwaysFail ? !output.includes('CACHE_RETRY_RECOVERED') && thrown.includes('CACHE_RETRY_UNAVAILABLE') : !thrown && output.includes('CACHE_RETRY_RECOVERED'), `${label}: success versus exhausted-error result remains explicit`);
}

async function changedDeployment(root: string): Promise<void> {
  const agent = fixture(root, 'retry-changed-capability', false);
  const calls: Request[] = [];
  const provider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 64 }),
    async *chatStreamWithTools(modelName: string, messages: Array<Record<string, unknown>>, system: string,
      _temperature: number, _maxTokens: number, tools: Array<Record<string, any>>): AsyncGenerator<StreamToken> {
      calls.push(copy({ model: modelName, messages, system, tools }));
      yield { type: 'text', text: modelName === 'primary-vision' ? '[LLM Error: 503] CAPABILITY_PRIMARY_UNAVAILABLE' : 'CAPABILITY_FALLBACK_RECOVERED' };
    },
    async chat(): Promise<string> { return 'Cache capability fixture'; },
  };
  (agent as unknown as { forcedProvider: typeof provider }).forcedProvider = provider;
  const output = (await agent.process('Explain the current workspace.')).map(token => token.text || '').join('');
  const first = calls[0], replacement = calls.find(call => call.model === 'fallback-text');
  check(calls.length === 3 && calls[0].model === calls[1].model && !!replacement && output.includes('CAPABILITY_FALLBACK_RECOVERED'), 'capability change: one safe same-model retry precedes the real fixed-model fallback');
  check(!!replacement && replacement.system !== first.system, 'capability change: replacement model gets refreshed system disclosure');
  const broker = (call: Request) => String(call.tools.find(tool => tool.function?.name === 'tool_provision')?.function?.description || '');
  check(broker(first).includes('image_generate:') && !!replacement && !broker(replacement).includes('image_generate:') && broker(replacement).includes('image_inspect:'), 'capability change: image inspection remains available despite vision observations');
  check(!!replacement && !JSON.stringify(replacement.messages).includes('CAPABILITY_PRIMARY_UNAVAILABLE'), 'capability change: failed assistant is removed before fallback');
  check(agent.model === 'fallback-text', 'capability change: actual Agent deployment selection follows fallback');
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-build-cache-retry-'));
  try {
    for (const id of ['recovered', 'exhausted', 'capability']) fs.mkdirSync(path.join(root, id));
    await sameDeployment(path.join(root, 'recovered'), false);
    await sameDeployment(path.join(root, 'exhausted'), true);
    await changedDeployment(path.join(root, 'capability'));
    console.log(`buildCacheRetryVerify: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
