/**
 * dev-0.3.0 adaptive tool exposure surface (routeToolSurfaceV2) verification.
 * Run: npm run build && node dist/tests/toolSurfaceV2Verify.js
 *
 * The v2 surface must keep the legacy contract (8-schema preload cap,
 * always-available subagent core, provision notice) while sourcing the
 * intent slice from the ToolExposurePlanner. Destructive tools are never
 * auto-exposed. A null toolchain preloads the full catalog without a notice.
 */
import * as assert from 'assert';
import { seedToolchainFromDefinitions } from '../toolchain';
import { routeToolSurfaceV2 } from '../core/agentKernelRunner';
import type { Agent } from '../core/agent';

function check(cond: boolean, name: string, detail?: string): void {
  if (cond) console.log(`  [PASS] ${name}`);
  else console.log(`  [FAIL] ${name}${detail ? `: ${detail}` : ''}`);
  assert.ok(cond, name);
}

const CORE_TOOL_NAMES = ['task', 'subagent_list', 'subagent_read', 'subagent_send', 'subagent_result', 'subagent_close'];

const DEFINITIONS = [
  ...CORE_TOOL_NAMES.map(name => ({ type: 'function', function: { name, description: `${name} orchestration tool`, parameters: { type: 'object', properties: {}, required: [] } } })),
  { type: 'function', function: { name: 'read', description: 'Read file contents', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write', description: 'Write/create a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'glob', description: 'Find files by glob pattern', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search file content with regex', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern', 'path'] } } },
  { type: 'function', function: { name: 'git_status', description: 'Show git status', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'git_log', description: 'Show git history', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'git_push', description: 'Push commits to the remote', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];

function namesOf(definitions: unknown[]): string[] {
  return definitions.map(definition => {
    const record = definition as { function?: { name?: string }; name?: string };
    return String(record.function?.name || record.name || '');
  });
}

function stubAgent(): Agent {
  return {
    shouldExposeToolInterface: () => true,
    runtimeActorId: 'test-actor',
    activeConversationId: 'conv-1',
    history: [],
  } as unknown as Agent;
}

function main(): void {
  console.log('toolSurfaceV2Verify');
  const agent = stubAgent();
  const { core } = seedToolchainFromDefinitions(DEFINITIONS, { namespace: 'newmark', version: '1.0.0' });

  // -------------------------------------------------------------------------
  // git intent routes through the planner
  // -------------------------------------------------------------------------
  const git = routeToolSurfaceV2(agent, DEFINITIONS, core, 'fix the git commit message and check the diff');
  const gitNames = namesOf(git.definitions);
  check(gitNames.includes('git_status'), 'git intent exposes read-side git tools');
  check(gitNames.includes('git_log'), 'git intent exposes git history tools');
  check(!gitNames.includes('git_push'), 'destructive git_push is never auto-exposed');
  check(CORE_TOOL_NAMES.every(name => gitNames.includes(name)), 'subagent orchestration core is always present');
  check(gitNames.length <= 8 + CORE_TOOL_NAMES.length, 'v2 surface respects the 8-schema preload cap plus core');
  check(git.systemPromptNotice.includes('Adaptive exposure plan'), 'v2 notice carries the exposure plan fingerprint');

  // -------------------------------------------------------------------------
  // web intent exposes the web domain
  // -------------------------------------------------------------------------
  const web = routeToolSurfaceV2(agent, DEFINITIONS, core, 'search the web for recent news');
  const webNames = namesOf(web.definitions);
  check(webNames.includes('web_search'), 'web intent exposes web tools');
  check(CORE_TOOL_NAMES.every(name => webNames.includes(name)), 'core tools present on web surface');

  // -------------------------------------------------------------------------
  // conversational turn keeps core + broker notice
  // -------------------------------------------------------------------------
  const chat = routeToolSurfaceV2(agent, DEFINITIONS, core, 'tell me a story about the sea');
  const chatNames = namesOf(chat.definitions);
  check(chatNames.length === CORE_TOOL_NAMES.length, 'conversational turn preloads no task tools');
  check(CORE_TOOL_NAMES.every(name => chatNames.includes(name)), 'core tools remain on conversational surface');
  check(chat.systemPromptNotice.includes('classified as conversational'), 'conversational notice emitted');

  // -------------------------------------------------------------------------
  // No tool interface: legacy route semantics preserved
  // -------------------------------------------------------------------------
  const noInterfaceAgent = { ...stubAgent(), shouldExposeToolInterface: () => false } as unknown as Agent;
  const none = routeToolSurfaceV2(noInterfaceAgent, DEFINITIONS, core, 'fix the git commit');
  check(none.definitions.length === 0, 'no tool interface yields an empty surface');
  check(none.systemPromptNotice.includes('No tool interface'), 'no tool interface notice preserved');

  // -------------------------------------------------------------------------
  // Null toolchain: full-surface fallback without the planner
  // -------------------------------------------------------------------------
  const fallback = routeToolSurfaceV2(agent, DEFINITIONS, null, 'fix the git commit message');
  check(namesOf(fallback.definitions).length === DEFINITIONS.length && !fallback.systemPromptNotice,
    'null toolchain preloads the full catalog without the exposure notice');

  // -------------------------------------------------------------------------
  // Determinism
  // -------------------------------------------------------------------------
  const again = routeToolSurfaceV2(agent, DEFINITIONS, core, 'fix the git commit message and check the diff');
  check(JSON.stringify(again.definitions) === JSON.stringify(git.definitions), 'v2 surface is deterministic for identical input');
  check(again.systemPromptNotice === git.systemPromptNotice, 'v2 notice is deterministic for identical input');

  console.log('toolSurfaceV2Verify: all assertions passed');
}

main();
