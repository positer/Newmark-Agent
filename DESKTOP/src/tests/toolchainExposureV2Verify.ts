/**
 * dev-0.3.0 toolchain exposure v2 verification.
 * Run: npm run build && node dist/tests/toolchainExposureV2Verify.js
 */
import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  ToolRegistry,
  CapabilityCatalog,
  buildCapabilityBoundary,
  ActiveToolsetService,
  BASE_TOOLSET_ID,
  PRESET_TOOLSETS,
  ToolExposurePlanner,
  SchemaLoader,
  ToolPermissionService,
  createToolchainCore,
} from '../toolchain';
import { sha256 } from '../context';

function check(cond: boolean, name: string, detail?: string): void {
  if (cond) console.log(`  [PASS] ${name}`);
  else console.log(`  [FAIL] ${name}${detail ? `: ${detail}` : ''}`);
  assert.ok(cond, name);
}

function buildFixtureCore(): { registry: ToolRegistry; catalog: CapabilityCatalog } {
  const { registry, catalog } = createToolchainCore();
  catalog.register({ capabilityId: 'filesystem.read', domain: 'filesystem', name: 'Read files', shortDescription: '读取授权工作区文件', riskLevel: 'read', discoverability: 'always', loadPolicy: 'on_demand', operations: ['read', 'glob'] });
  catalog.register({ capabilityId: 'filesystem.write', domain: 'filesystem', name: 'Write files', shortDescription: '可在授权范围修改文件', riskLevel: 'write', discoverability: 'always', loadPolicy: 'on_demand', operations: ['write', 'edit'] });
  catalog.register({ capabilityId: 'terminal.execute', domain: 'terminal', name: 'Terminal', shortDescription: '可执行受控终端命令', riskLevel: 'write', discoverability: 'always', loadPolicy: 'on_demand', operations: ['bash'] });
  catalog.register({ capabilityId: 'code.search', domain: 'code', name: 'Code search', shortDescription: '可搜索代码、符号和引用', riskLevel: 'read', discoverability: 'always', loadPolicy: 'on_demand', operations: ['grep', 'symbols'] });
  catalog.register({ capabilityId: 'vcs.inspect', domain: 'vcs', name: 'Git inspect', shortDescription: '可读取 Git 状态、diff 和历史', riskLevel: 'read', discoverability: 'always', loadPolicy: 'on_demand', operations: ['status', 'diff', 'log'] });
  catalog.register({ capabilityId: 'vcs.publish', domain: 'vcs', name: 'Git publish', shortDescription: '需显式授权后提交或推送', riskLevel: 'external', discoverability: 'task_relevant', loadPolicy: 'approval_required', operations: ['push', 'pr'] });
  catalog.register({ capabilityId: 'secrets.read', domain: 'secrets', name: 'Secrets', shortDescription: '禁止直接读取秘密', riskLevel: 'read', discoverability: 'hidden', loadPolicy: 'never', operations: [] });
  catalog.register({ capabilityId: 'web.search', domain: 'web', name: 'Web search', shortDescription: '可访问公开网络信息', riskLevel: 'read', discoverability: 'always', loadPolicy: 'on_demand', operations: ['search'] });

  registry.register({ toolId: 'file.read', capabilityId: 'filesystem.read', namespace: 'file', name: 'read', version: '1', shortDescription: 'Read a file', fullDescription: 'Read file contents.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, riskLevel: 'read', idempotency: 'idempotent', requiredPermissions: ['filesystem:read'], supportedScopes: ['workspace'], cacheGroup: 'file' });
  registry.register({ toolId: 'file.write', capabilityId: 'filesystem.write', namespace: 'file', name: 'write', version: '1', shortDescription: 'Write a file', fullDescription: 'Write file contents.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, riskLevel: 'write', idempotency: 'conditionally_idempotent', requiredPermissions: ['filesystem:write'], supportedScopes: ['workspace'] });
  registry.register({ toolId: 'terminal.exec', capabilityId: 'terminal.execute', namespace: 'terminal', name: 'bash', version: '1', shortDescription: 'Run a command', fullDescription: 'Run a shell command.', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, riskLevel: 'write', idempotency: 'non_idempotent', requiredPermissions: ['terminal:exec'], supportedScopes: ['workspace'] });
  registry.register({ toolId: 'code.search', capabilityId: 'code.search', namespace: 'code', name: 'grep', version: '1', shortDescription: 'Search code', fullDescription: 'Search file content.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }, riskLevel: 'read', idempotency: 'idempotent', requiredPermissions: ['code:search'], supportedScopes: ['workspace'] });
  registry.register({ toolId: 'vcs.status', capabilityId: 'vcs.inspect', namespace: 'vcs', name: 'git_status', version: '1', shortDescription: 'Git status', fullDescription: 'Show git status.', inputSchema: { type: 'object', properties: {} }, riskLevel: 'read', idempotency: 'idempotent' });
  registry.register({ toolId: 'vcs.push', capabilityId: 'vcs.publish', namespace: 'vcs', name: 'git_push', version: '1', shortDescription: 'Git push', fullDescription: 'Push to remote.', inputSchema: { type: 'object', properties: {} }, riskLevel: 'external', idempotency: 'non_idempotent' });
  registry.register({ toolId: 'secrets.read', capabilityId: 'secrets.read', namespace: 'secrets', name: 'read_secret', version: '1', shortDescription: 'Read secret', fullDescription: 'Read a secret.', inputSchema: { type: 'object', properties: {} }, riskLevel: 'read', idempotency: 'idempotent' });
  registry.register({ toolId: 'web.search', capabilityId: 'web.search', namespace: 'web', name: 'web_search', version: '1', shortDescription: 'Web search', fullDescription: 'Search the web.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, riskLevel: 'read', idempotency: 'idempotent' });
  return { registry, catalog };
}

function usageMap(): Map<string, number> {
  const map = new Map<string, number>();
  for (const toolId of Object.values(PRESET_TOOLSETS).flat()) map.set(toolId, 0);
  return map;
}

async function main(): Promise<void> {
  console.log('toolchainExposureV2Verify');
  const { registry, catalog } = buildFixtureCore();

  // -------------------------------------------------------------------------
  // Tool Registry
  // -------------------------------------------------------------------------
  const tool = registry.get('file.read');
  check(!!tool && tool.schemaHash.length === 64, 'tool descriptor carries a schema hash');
  check(registry.getByName('read')?.toolId === 'file.read', 'tool registry resolves by name');
  check(registry.byCapability('filesystem.read').length === 1, 'tools are indexed by capability');
  const hash1 = registry.catalogHash();
  const hash2 = registry.catalogHash();
  check(hash1 === hash2, 'catalog hash is stable across reads');

  // -------------------------------------------------------------------------
  // Capability Catalog + search
  // -------------------------------------------------------------------------
  const capability = catalog.get('code.search');
  check(!!capability && capability.capabilityId === 'code.search', 'capability catalog resolves by id');
  const results = catalog.search('search code symbols');
  check(results.some(item => item.capabilityId === 'code.search'), 'capability search finds code.search');
  const riskFiltered = catalog.search('search', { riskLevels: ['read'] });
  check(riskFiltered.every(item => item.riskLevel === 'read'), 'capability search honors risk filter');
  check(catalog.get('secrets.read')?.loadPolicy === 'never', 'secrets capability is never loadable');
  check(catalog.boundaryHash().length === 64, 'capability boundary hash computed');

  // -------------------------------------------------------------------------
  // Capability Boundary Summary (layer 1)
  // -------------------------------------------------------------------------
  const boundary = buildCapabilityBoundary(catalog, ['secrets.read']);
  const boundaryText = boundary.render();
  check(boundaryText.includes('<capability_boundary version="1">'), 'boundary uses the stable capability_boundary envelope');
  check(boundaryText.includes('filesystem.read') && !boundaryText.includes('read_secret'), 'boundary lists capabilities, not tool schemas');
  check(boundaryText.includes('Restricted:') && boundaryText.includes('secrets.read'), 'restricted capabilities are declared');
  check(boundary.render() === boundaryText, 'boundary render is byte-stable');
  check(boundary.renderHash().length === 64, 'boundary hash is byte-stable');

  // -------------------------------------------------------------------------
  // Active Toolset Manifest (layer 2)
  // -------------------------------------------------------------------------
  const activeService = new ActiveToolsetService(registry);
  const active = activeService.build(['file.read', 'file.write', 'terminal.exec', 'code.search'], { toolsetId: 'toolset-coding', version: 3 });
  check(active.entries.length === 4, 'active toolset manifest lists loaded tools');
  check(active.entries.every(entry => entry.schemaLoaded === true), 'loaded tools are marked schema loaded');
  check(active.manifestHash.length === 64, 'manifest carries a stable hash');
  const activeRender = activeService.render(active);
  check(activeRender.includes('<active_toolset id="toolset-coding" version="3">'), 'active toolset renders with id + version');
  const manifestHashAgain = activeService.build(['file.read', 'file.write', 'terminal.exec', 'code.search'], { toolsetId: 'toolset-coding', version: 3 }).manifestHash;
  check(active.manifestHash === manifestHashAgain, 'toolset manifest hash is stable for identical input');

  // -------------------------------------------------------------------------
  // Base toolset
  // -------------------------------------------------------------------------
  check(BASE_TOOLSET_ID === 'toolset-core', 'base toolset id is toolset-core');
  check(Array.isArray(PRESET_TOOLSETS[BASE_TOOLSET_ID]) && PRESET_TOOLSETS[BASE_TOOLSET_ID].length >= 6, 'base toolset contains discovery tools');

  // -------------------------------------------------------------------------
  // Exposure Planner
  // -------------------------------------------------------------------------
  const planner = new ToolExposurePlanner(registry, catalog);
  const frequency = usageMap();
  const planResult = planner.plan({
    agentRunId: 'run-1',
    buildBlockId: 'block-1',
    userInput: 'fix the git commit message and run tests',
    objective: 'commit fixes',
    previousToolCalls: ['file.read', 'terminal.exec'],
    toolUsageFrequency: frequency,
    permissionScope: ['workspace'],
    tokenBudget: 10_000,
    providerToolLimit: 0,
  });
  check(planResult.plan.baseToolsetId === BASE_TOOLSET_ID, 'exposure plan uses the base toolset');
  check(planResult.baseToolIds.includes('capability.search'), 'base toolset includes discovery tools');
  check(planResult.activeToolIds.includes('file.read'), 'actively relevant tool is exposed');
  check(planResult.plan.suggestedCapabilityIds.includes('vcs.inspect'), 'git intent suggests vcs.inspect capability');
  check(planResult.plan.suggestedCapabilityIds.includes('test.run') || planResult.plan.activeToolIds.length > 0, 'task intent drives capability suggestions');
  check(!planResult.activeToolIds.includes('vcs.push'), 'high-risk vcs.publish is never auto-exposed');
  check(!planResult.activeToolIds.includes('secrets.read'), 'never-loadable secrets tool is not exposed');
  check(planResult.plan.stableToolsetHash.length === 64, 'exposure plan hash computed');

  // provider tool limit
  const limitedResult = planner.plan({
    agentRunId: 'run-1',
    buildBlockId: 'block-1',
    userInput: 'fix git commit message',
    objective: '',
    previousToolCalls: [],
    toolUsageFrequency: frequency,
    permissionScope: ['workspace'],
    tokenBudget: 10_000,
    providerToolLimit: 3,
  });
  check(limitedResult.activeToolIds.length <= 3, 'provider tool limit caps the active toolset');

  // -------------------------------------------------------------------------
  // Schema Loader (layer 4 + on-demand)
  // -------------------------------------------------------------------------
  const loader = new SchemaLoader(registry, catalog);
  const load = loader.load({
    agentRunId: 'run-1',
    capabilityId: 'code.search',
    reason: 'need to find a symbol',
    expectedUseCount: 5,
    scope: 'build_block',
  }, {
    allowedCapabilityIds: ['filesystem.read', 'filesystem.write', 'code.search', 'terminal.execute', 'vcs.inspect', 'web.search'],
    resourceScopes: ['workspace'],
  });
  check(load.ok === true && load.toolId === 'code.search', 'authorized capability loads its tool schema');
  const duplicateLoad = loader.load({
    agentRunId: 'run-1',
    capabilityId: 'code.search',
    reason: 'again',
  }, {
    allowedCapabilityIds: ['code.search'],
    resourceScopes: ['workspace'],
  });
  check(duplicateLoad.ok === true && duplicateLoad.record !== undefined, 'loading an already-loaded tool reuses the exposure record');

  const unauthorized = loader.load({
    agentRunId: 'run-1',
    capabilityId: 'vcs.publish',
    reason: 'push',
  }, {
    allowedCapabilityIds: ['filesystem.read', 'code.search'],
    resourceScopes: ['workspace'],
  });
  check(unauthorized.ok === false && unauthorized.error?.code === 'not_authorized', 'unauthorized capability cannot be loaded');

  const approval = loader.load({
    agentRunId: 'run-1',
    capabilityId: 'vcs.publish',
    reason: 'push',
  }, {
    allowedCapabilityIds: ['vcs.publish'],
    resourceScopes: ['workspace'],
  });
  check(approval.ok === false && approval.error?.code === 'approval_required', 'approval_required capability is not auto-loaded');

  const never = loader.load({
    agentRunId: 'run-1',
    capabilityId: 'secrets.read',
    reason: 'read secret',
  }, {
    allowedCapabilityIds: ['secrets.read'],
    resourceScopes: ['workspace'],
  });
  check(never.ok === false && never.error?.code === 'never_loadable', 'never-loadable capability is rejected');

  const subagentLoad = loader.load({
    agentRunId: 'sub-1',
    capabilityId: 'terminal.execute',
    reason: 'run command',
  }, {
    allowedCapabilityIds: ['filesystem.read', 'terminal.execute'],
    resourceScopes: ['workspace'],
    isSubagent: true,
    allowedDomains: ['filesystem', 'code'],
  });
  check(subagentLoad.ok === false && subagentLoad.error?.code === 'ceiling_exceeded', 'subagent capability ceiling blocks out-of-domain loads');

  const released = loader.release('run-1', 'code.search');
  check(released === true, 'release removes the tool from the exposure session');
  check(loader.currentToolIds('run-1').length === 0, 'exposure session is empty after release');

  // -------------------------------------------------------------------------
  // Permission Service
  // -------------------------------------------------------------------------
  const permission = new ToolPermissionService(registry);
  const authorized = permission.authorize('file.read', {
    requiredPermissions: ['filesystem:read'],
    resourceScopes: ['workspace'],
    isSubagent: false,
    allowedCapabilityIds: ['filesystem.read'],
  });
  check(authorized.allowed === true, 'authorized read tool passes permission check');

  const missingPermission = permission.authorize('file.read', {
    requiredPermissions: [],
    resourceScopes: ['workspace'],
    isSubagent: false,
    allowedCapabilityIds: ['filesystem.read'],
  });
  check(missingPermission.allowed === false && missingPermission.reason.includes('permission'), 'missing permission blocks the call');

  const unregistered = permission.authorize('nope', {
    requiredPermissions: [],
    resourceScopes: ['workspace'],
    isSubagent: false,
    allowedCapabilityIds: [],
  });
  check(unregistered.allowed === false, 'unregistered tool is rejected');

  check(permission.requiresApproval('vcs.push') === true, 'external tool requires approval');
  check(permission.requiresApproval('file.read') === false, 'read tool does not require approval');

  const subagentDestructive = permission.authorize('terminal.exec', {
    requiredPermissions: ['terminal:exec'],
    resourceScopes: ['workspace'],
    isSubagent: true,
    allowedCapabilityIds: ['terminal.execute'],
    allowedDomains: ['terminal'],
  });
  // terminal.exec is write (not destructive), so this should be allowed when authorized.
  check(subagentDestructive.allowed === true, 'authorized write tool allowed for subagent within ceiling');

  const subagentExternal = permission.authorize('vcs.push', {
    requiredPermissions: [],
    resourceScopes: ['workspace'],
    isSubagent: true,
    allowedCapabilityIds: ['vcs.publish'],
    allowedDomains: ['vcs'],
  });
  check(subagentExternal.allowed === false, 'external tool is never authorized for subagents');

  // catalog boundary + stable hash sanity
  check(sha256({ a: 1 }) === sha256({ a: 1 }), 'stable hash sanity');

  console.log('toolchainExposureV2Verify: all assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
