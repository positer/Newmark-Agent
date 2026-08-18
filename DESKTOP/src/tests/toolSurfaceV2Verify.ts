/**
 * dev-0.3.0 adaptive tool exposure surface (routeToolSurfaceV2) verification.
 * Run: npm run build && node dist/tests/toolSurfaceV2Verify.js
 *
 * The v2 surface exposes only foundational workspace tools initially. Every
 * advanced tool remains discoverable through the compact tool_provision
 * catalog and receives its full schema only after explicit provisioning.
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

const BASIC_TOOL_NAMES = ['bash', 'pwd', 'read', 'write', 'edit', 'delete_file', 'glob', 'grep'];
const ADVANCED_AGENT_TOOL_NAMES = ['task_read', 'task_create', 'SubAgent', 'subagent_list', 'subagent_read', 'subagent_send', 'subagent_result', 'subagent_close'];

const DEFINITIONS = [
  ...ADVANCED_AGENT_TOOL_NAMES.map(name => ({ type: 'function', function: { name, description: `${name} orchestration tool`, parameters: { type: 'object', properties: {}, required: [] } } })),
  { type: 'function', function: { name: 'pwd', description: 'Print working directory', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'read', description: 'Read file contents', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write', description: 'Write/create a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit', description: 'Edit a file', parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'delete_file', description: 'Delete one file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
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
  // Intent never injects advanced schemas directly.
  // -------------------------------------------------------------------------
  const git = routeToolSurfaceV2(agent, DEFINITIONS, core, 'fix the git commit message and check the diff');
  const gitNames = namesOf(git.definitions);
  check(BASIC_TOOL_NAMES.every(name => gitNames.includes(name)), 'git intent retains every foundational workspace tool');
  check(!gitNames.includes('git_status') && !gitNames.includes('git_log') && !gitNames.includes('git_push'), 'git tools remain provision-only regardless of intent or risk');
  check(!gitNames.includes('SubAgent') && !gitNames.includes('task_create'), 'SubAgent and task checklist schemas remain provision-only');
  check(gitNames.length === BASIC_TOOL_NAMES.length, 'initial surface contains exactly the eight foundational schemas');
  check(git.systemPromptNotice.includes('Capability routing fingerprint'), 'v2 notice carries the capability routing fingerprint');

  // -------------------------------------------------------------------------
  // Unrelated intent yields the identical initial surface.
  // -------------------------------------------------------------------------
  const web = routeToolSurfaceV2(agent, DEFINITIONS, core, 'search the web for recent news');
  const webNames = namesOf(web.definitions);
  check(!webNames.includes('web_search'), 'web tools remain provision-only');
  check(JSON.stringify(webNames) === JSON.stringify(gitNames), 'initial schema surface is intent-independent');

  // -------------------------------------------------------------------------
  // Conversational turn keeps the same foundational tools.
  // -------------------------------------------------------------------------
  const chat = routeToolSurfaceV2(agent, DEFINITIONS, core, 'tell me a story about the sea');
  const chatNames = namesOf(chat.definitions);
  check(chatNames.length === BASIC_TOOL_NAMES.length, 'conversational turn preloads foundational tools only');
  check(BASIC_TOOL_NAMES.every(name => chatNames.includes(name)), 'foundational tools remain on conversational surface');
  check(chat.systemPromptNotice.includes('advanced tools are advertised by capability'), 'advanced-tool provision notice emitted');

  // -------------------------------------------------------------------------
  // No tool interface: legacy route semantics preserved
  // -------------------------------------------------------------------------
  const noInterfaceAgent = { ...stubAgent(), shouldExposeToolInterface: () => false } as unknown as Agent;
  const none = routeToolSurfaceV2(noInterfaceAgent, DEFINITIONS, core, 'fix the git commit');
  check(none.definitions.length === 0, 'no tool interface yields an empty surface');
  check(none.systemPromptNotice.includes('No tool interface'), 'no tool interface notice preserved');

  // -------------------------------------------------------------------------
  // Null toolchain does not widen the initial schema boundary.
  // -------------------------------------------------------------------------
  const fallback = routeToolSurfaceV2(agent, DEFINITIONS, null, 'fix the git commit message');
  check(JSON.stringify(namesOf(fallback.definitions).sort()) === JSON.stringify([...BASIC_TOOL_NAMES].sort())
    && fallback.systemPromptNotice.includes('compact catalog remains authoritative'),
  'null toolchain retains the foundational-only surface and authoritative compact catalog');

  // -------------------------------------------------------------------------
  // Determinism
  // -------------------------------------------------------------------------
  const again = routeToolSurfaceV2(agent, DEFINITIONS, core, 'fix the git commit message and check the diff');
  check(JSON.stringify(again.definitions) === JSON.stringify(git.definitions), 'v2 surface is deterministic for identical input');
  check(again.systemPromptNotice === git.systemPromptNotice, 'v2 notice is deterministic for identical input');

  console.log('toolSurfaceV2Verify: all assertions passed');
}

main();
