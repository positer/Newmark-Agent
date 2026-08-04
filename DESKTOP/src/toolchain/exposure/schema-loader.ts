import * as crypto from 'crypto';
import { ToolExposureRecord, ToolExposureScope } from '../../context/domain/types';
import { ToolRegistry } from '../registry/tool-registry';
import { CapabilityCatalog } from '../capabilities/capability-catalog';

export interface LoadSchemaInput {
  agentRunId: string;
  capabilityId: string;
  preferredToolId?: string;
  reason: string;
  expectedUseCount?: number;
  scope?: ToolExposureScope;
  requiredPermissions?: string[];
}

export interface LoadSchemaResult {
  ok: boolean;
  toolId?: string;
  error?: { code: string; message: string };
  record?: ToolExposureRecord;
}

export interface SchemaLoaderOptions {
  /** Capability IDs the current agent is allowed to load. */
  allowedCapabilityIds: string[];
  /** Maximum active exposure records. */
  maxActive?: number;
  /** Maximum estimated schema tokens for a single load. */
  maxSchemaTokens?: number;
  /** Resource scope the agent may access. */
  resourceScopes: string[];
  isSubagent?: boolean;
  /** Capability ceiling for subagents (domain prefixes allowed). */
  allowedDomains?: string[];
}

/**
 * On-demand tool schema loader — layer 4. Only loads a concrete tool schema
 * when the Agent explicitly needs the capability and is authorized. Loaded
 * tools enter an Exposure Session and stay stable until the block completes,
 * the tool expires, permission is revoked, or context pressure grows.
 */
export class SchemaLoader {
  private readonly exposures = new Map<string, ToolExposureRecord>();
  private readonly schemaSizes = new Map<string, number>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly catalog: CapabilityCatalog,
  ) {}

  activeRecords(): ToolExposureRecord[] {
    return [...this.exposures.values()];
  }

  load(input: LoadSchemaInput, options: SchemaLoaderOptions): LoadSchemaResult {
    const capability = this.catalog.get(input.capabilityId);
    if (!capability) {
      return { ok: false, error: { code: 'unknown_capability', message: `Capability ${input.capabilityId} does not exist in the catalog.` } };
    }
    if (!options.allowedCapabilityIds.includes(input.capabilityId)) {
      return { ok: false, error: { code: 'not_authorized', message: `Capability ${input.capabilityId} is not authorized for this agent.` } };
    }
    if (options.isSubagent && options.allowedDomains?.length) {
      const domain = input.capabilityId.split('.')[0];
      if (!options.allowedDomains.includes(domain)) {
        return { ok: false, error: { code: 'ceiling_exceeded', message: `Capability ${input.capabilityId} exceeds the subagent capability ceiling.` } };
      }
    }
    if (capability.loadPolicy === 'never') {
      return { ok: false, error: { code: 'never_loadable', message: `Capability ${input.capabilityId} is never loadable.` } };
    }
    if (capability.loadPolicy === 'approval_required') {
      return { ok: false, error: { code: 'approval_required', message: `Capability ${input.capabilityId} requires explicit authorization to load.` } };
    }

    let toolId = input.preferredToolId || '';
    if (toolId && !this.registry.get(toolId)) toolId = '';
    if (!toolId) {
      const candidates = this.registry.byCapability(input.capabilityId).filter(tool => tool.enabled);
      if (!candidates.length) {
        return { ok: false, error: { code: 'no_implementation', message: `Capability ${input.capabilityId} has no enabled tool implementation.` } };
      }
      toolId = candidates[0].toolId;
    }

    const tool = this.registry.get(toolId)!;
    const schemaTokens = Math.ceil(JSON.stringify(tool.inputSchema).length / 4);
    if (options.maxSchemaTokens && schemaTokens > options.maxSchemaTokens) {
      return { ok: false, error: { code: 'schema_too_large', message: `Tool ${toolId} schema (${schemaTokens} tokens) exceeds the load limit.` } };
    }
    if (options.maxActive !== undefined && this.exposures.size >= options.maxActive) {
      return { ok: false, error: { code: 'exposure_limit', message: `Active exposure limit (${options.maxActive}) reached. Release tools first.` } };
    }

    const existing = this.findLoaded(toolId, input.agentRunId);
    if (existing) return { ok: true, toolId, record: existing };

    const now = new Date();
    const scope = input.scope || (tool.riskLevel === 'read' ? 'build_block' : 'single_turn');
    const expiresAt = scope === 'single_turn'
      ? new Date(now.getTime() + 10 * 60 * 1000).toISOString()
      : scope === 'build_block'
        ? new Date(now.getTime() + 60 * 60 * 1000).toISOString()
        : scope === 'agent_run'
          ? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
          : undefined;

    const record: ToolExposureRecord = {
      exposureId: crypto.randomUUID(),
      agentRunId: input.agentRunId,
      toolId,
      scope,
      reason: input.reason,
      loadedAt: now.toISOString(),
      expiresAt,
      schemaHash: tool.schemaHash,
    };
    this.exposures.set(record.exposureId, record);
    this.schemaSizes.set(toolId, schemaTokens);
    return { ok: true, toolId, record };
  }

  release(agentRunId: string, toolId: string): boolean {
    let released = false;
    for (const [exposureId, record] of this.exposures) {
      if (record.agentRunId === agentRunId && record.toolId === toolId) {
        this.exposures.delete(exposureId);
        released = true;
      }
    }
    return released;
  }

  releaseScope(agentRunId: string, scope: ToolExposureScope): number {
    let count = 0;
    for (const [exposureId, record] of this.exposures) {
      if (record.agentRunId === agentRunId && record.scope === scope) {
        this.exposures.delete(exposureId);
        count += 1;
      }
    }
    return count;
  }

  /** Prune expired exposures and evict largest schemas when over budget. */
  prune(maxActive = 16): number {
    const now = Date.now();
    let pruned = 0;
    for (const [exposureId, record] of this.exposures) {
      if (record.expiresAt && Date.parse(record.expiresAt) <= now) {
        this.exposures.delete(exposureId);
        pruned += 1;
      }
    }
    while (this.exposures.size > maxActive) {
      const largest = [...this.exposures.values()].sort((a, b) =>
        (this.schemaSizes.get(b.toolId) || 0) - (this.schemaSizes.get(a.toolId) || 0))[0];
      if (!largest) break;
      this.exposures.delete(largest.exposureId);
      pruned += 1;
    }
    return pruned;
  }

  currentToolIds(agentRunId: string): string[] {
    return [...this.exposures.values()]
      .filter(record => record.agentRunId === agentRunId)
      .map(record => record.toolId);
  }

  private findLoaded(toolId: string, agentRunId: string): ToolExposureRecord | undefined {
    for (const record of this.exposures.values()) {
      if (record.agentRunId === agentRunId && record.toolId === toolId) return record;
    }
    return undefined;
  }
}
