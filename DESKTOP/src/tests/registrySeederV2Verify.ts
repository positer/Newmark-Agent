/**
 * dev-0.3.0 registry seeder verification.
 * Run: npm run build && node dist/tests/registrySeederV2Verify.js
 *
 * The seeder converts the legacy tool definition list produced by
 * ToolExecutor.definitions(mode) (OpenAI function shape or
 * NewmarkToolDefinition shape) into ToolRegistry descriptors +
 * CapabilityCatalog entries without touching the legacy execution path.
 */
import * as assert from 'assert';
import { seedToolchainFromDefinitions, inferDomain, inferRiskLevel } from '../toolchain';

function check(cond: boolean, name: string, detail?: string): void {
  if (cond) console.log(`  [PASS] ${name}`);
  else console.log(`  [FAIL] ${name}${detail ? `: ${detail}` : ''}`);
  assert.ok(cond, name);
}

const LEGACY_DEFINITIONS = [
  { type: 'function', function: { name: 'pwd', description: 'Print working directory', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'read', description: 'Read file contents', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write', description: 'Write/create a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit', description: 'Edit file with find-and-replace', parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'glob', description: 'Find files by glob pattern', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search file content with regex', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern', 'path'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Fetch and extract URL content', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_open', description: 'Open a URL in browser control', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'computer_use', description: 'Native desktop control', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } } },
  { type: 'function', function: { name: 'git_status', description: 'Show git status', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'git_push', description: 'Push commits to the remote', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'memory_lab_read', description: 'Read a memory document', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'memory_lab_save', description: 'Save a memory document', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'automation_trigger', description: 'Trigger an automation job', parameters: { type: 'object', properties: { automation_id: { type: 'string' } }, required: ['automation_id'] } } },
  { type: 'function', function: { name: 'subagent_read', description: 'Read a subagent result', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'subagent_send', description: 'Send a task to a subagent', parameters: { type: 'object', properties: { id: { type: 'string' }, task: { type: 'string' } }, required: ['id', 'task'] } } },
  { type: 'function', function: { name: 'subagent_list', description: 'List active subagents', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'task', description: 'Dispatch a background task', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } } },
  { type: 'function', function: { name: 'question', description: 'Ask the user a question', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } } },
  { type: 'function', function: { name: 'skill', description: 'Load a skill', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'linked_plan', description: 'Read the linked plan', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'build_history_query', description: 'Query build history', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'image_inspect', description: 'Inspect a user-submitted image', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } } },
  { type: 'function', function: { name: 'pdf_read', description: 'Read a PDF', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'ocr_read', description: 'OCR fallback', parameters: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } } },
  { type: 'function', function: { name: 'flow_run', description: 'Run a flow workflow', parameters: { type: 'object', properties: { flow_id: { type: 'string' } }, required: ['flow_id'] } } },
];

const NEWMARK_SHAPED_DEFINITIONS = [
  { name: 'git_force_push', description: 'Force push', annotations: { destructive: true } },
  { name: 'delete_workspace_file', description: 'Delete a file', annotations: { readOnly: false } },
];

function main(): void {
  console.log('registrySeederV2Verify');

  // -------------------------------------------------------------------------
  // Pure inference helpers
  // -------------------------------------------------------------------------
  check(inferDomain('web_search') === 'web', 'web tools map to the web domain');
  check(inferDomain('browser_open') === 'browser', 'browser tools map to the browser domain');
  check(inferDomain('computer_use') === 'computer', 'computer_use maps to the computer domain');
  check(inferDomain('git_status') === 'git', 'git tools map to the git domain');
  check(inferDomain('memory_lab_read') === 'memory', 'memory_lab tools map to the memory domain');
  check(inferDomain('automation_trigger') === 'automation', 'automation tools map to the automation domain');
  check(inferDomain('flow_run') === 'flow', 'flow tools map to the flow domain');
  check(inferDomain('subagent_send') === 'subagent', 'subagent tools map to the subagent domain');
  check(inferDomain('task') === 'subagent', 'task maps to the subagent domain');
  check(inferDomain('question') === 'interaction', 'question maps to the interaction domain');
  check(inferDomain('skill') === 'skills', 'skill maps to the skills domain');
  check(inferDomain('linked_plan') === 'plan', 'linked_plan maps to the plan domain');
  check(inferDomain('image_inspect') === 'media', 'image tools map to the media domain');
  check(inferDomain('read') === 'core', 'core fs tools map to the core domain');

  check(inferRiskLevel('read', 'read files') === 'read', 'read tool infers read risk');
  check(inferRiskLevel('bash', 'run a shell command') === 'write', 'bash infers write risk');
  check(inferRiskLevel('web_search', 'search the web') === 'external', 'web tools infer external risk');
  check(inferRiskLevel('git_push', 'push to remote') === 'destructive', 'git_push infers destructive risk');
  check(inferRiskLevel('git_force_push', 'force push', { destructive: true }) === 'destructive', 'destructive annotation wins');
  check(inferRiskLevel('subagent_read', 'read a result') === 'read', 'subagent_read infers read risk');
  check(inferRiskLevel('subagent_send', 'send a task') === 'write', 'subagent_send infers write risk');

  // -------------------------------------------------------------------------
  // Seeding from legacy OpenAI function definitions
  // -------------------------------------------------------------------------
  const seeded = seedToolchainFromDefinitions(LEGACY_DEFINITIONS, { namespace: 'newmark', version: '1.0.0' });
  const { registry, catalog } = seeded.core;

  check(seeded.toolIds.length === LEGACY_DEFINITIONS.length, 'every legacy definition is registered as a tool');
  check(registry.all().length === LEGACY_DEFINITIONS.length, 'registry holds exactly the seeded tools');

  const gitPush = registry.get('git_push');
  check(!!gitPush && gitPush.riskLevel === 'destructive', 'git_push registered as destructive');
  check(!!gitPush && gitPush.requiredPermissions.includes('destructive'), 'destructive tool requires destructive permission');
  check(!!gitPush && gitPush.capabilityId === 'cap.git', 'git tools attach to the git capability');
  check(!!gitPush && gitPush.schemaHash.length === 64, 'seeded tools carry schema hashes');

  const webSearch = registry.get('web_search');
  check(!!webSearch && webSearch.riskLevel === 'external' && webSearch.requiredPermissions.includes('network'), 'web tool registered as external with network permission');

  const bash = registry.get('bash');
  check(!!bash && bash.riskLevel === 'write' && bash.idempotency === 'non_idempotent', 'bash registered as non-idempotent write');

  const read = registry.get('read');
  check(!!read && read.riskLevel === 'read' && read.idempotency === 'idempotent', 'read tool stays idempotent');
  check(!!read && !!read.fullDescription && read.fullDescription.includes('Read file contents'), 'cordis registration preserves the real tool description in fullDescription');
  check(!!read && !!read.shortDescription && read.shortDescription.length > 0, 'cordis registration derives a readable shortDescription');
  check(!!gitPush && !!gitPush.fullDescription && gitPush.fullDescription.includes('Push commits'), 'git_push keeps its description, not a name(domain) placeholder');
  const write = registry.get('write');
  const edit = registry.get('edit');
  check(!!write && write.riskLevel === 'write' && write.idempotency === 'conditionally_idempotent', 'write tool infers conditionally_idempotent');
  check(!!edit && edit.riskLevel === 'write' && edit.idempotency === 'conditionally_idempotent', 'edit tool infers conditionally_idempotent');
  check(!!write && (write.inputSchema as { properties?: Record<string, unknown> }).properties?.content !== undefined, 'write-family tool keeps its input schema');

  const subagentRead = registry.get('subagent_read');
  const subagentSend = registry.get('subagent_send');
  check(!!subagentRead && subagentRead.riskLevel === 'read' && subagentRead.capabilityId === 'cap.subagent', 'subagent_read is a read tool in the subagent domain');
  check(!!subagentSend && subagentSend.riskLevel === 'write' && subagentSend.capabilityId === 'cap.subagent', 'subagent_send is a write tool in the subagent domain');

  const capabilities = catalog.all();
  check(capabilities.length === new Set(LEGACY_DEFINITIONS.map(d => inferDomain((d as { function: { name: string } }).function.name))).size, 'one capability per inferred domain');
  const gitCapability = catalog.get('cap.git');
  check(!!gitCapability && gitCapability.operations.includes('git_status') && gitCapability.operations.includes('git_push'), 'git capability aggregates its domain tools');
  check(!!gitCapability && gitCapability.riskLevel === 'destructive', 'capability risk is the domain maximum');
  check(!!gitCapability && gitCapability.requiredPermissions.includes('destructive'), 'capability carries destructive permission');
  const mediaCapability = catalog.get('cap.media');
  check(!!mediaCapability && mediaCapability.riskLevel === 'read' && mediaCapability.loadPolicy === 'on_demand', 'read capabilities default to on_demand loading');

  // -------------------------------------------------------------------------
  // NewmarkToolDefinition-shaped inputs
  // -------------------------------------------------------------------------
  const shaped = seedToolchainFromDefinitions(NEWMARK_SHAPED_DEFINITIONS);
  check(shaped.core.registry.get('git_force_push')?.riskLevel === 'destructive', 'NewmarkToolDefinition shape seeds destructive annotation');
  check(shaped.core.registry.get('delete_workspace_file')?.riskLevel === 'destructive', 'destructive keyword in name seeds destructive risk');

  // -------------------------------------------------------------------------
  // Stability
  // -------------------------------------------------------------------------
  const reseeded = seedToolchainFromDefinitions(LEGACY_DEFINITIONS, { namespace: 'newmark', version: '1.0.0' });
  check(reseeded.core.registry.catalogHash() === seeded.core.registry.catalogHash(), 'seeding is deterministic across fresh cores');
  check(reseeded.core.catalog.boundaryHash() === seeded.core.catalog.boundaryHash(), 'capability boundary is deterministic across fresh cores');

  console.log('registrySeederV2Verify: all assertions passed');
}

main();
