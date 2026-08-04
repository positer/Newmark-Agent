import { ToolDescriptor, ToolIdempotency, RiskLevel } from '../../context/domain/types';
import { sha256 } from '../../context/serializers/deterministic';

export interface ToolDescriptorInput {
  toolId: string;
  capabilityId: string;
  namespace: string;
  name: string;
  version: string;
  shortDescription: string;
  fullDescription: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  riskLevel: RiskLevel;
  idempotency?: ToolIdempotency;
  requiredPermissions?: string[];
  supportedScopes?: string[];
  cacheGroup?: string;
  implementationHash?: string;
}

/**
 * Tool Registry: the authoritative set of ToolDescriptors. Schemas are
 * versioned and deterministically serialized (schemaHash). Capability is
 * separated from implementation: one capability may map to many tools.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>();

  register(input: ToolDescriptorInput): ToolDescriptor {
    const descriptor: ToolDescriptor = {
      toolId: input.toolId,
      capabilityId: input.capabilityId,
      namespace: input.namespace,
      name: input.name,
      version: input.version,
      shortDescription: input.shortDescription,
      fullDescription: input.fullDescription,
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      riskLevel: input.riskLevel,
      idempotency: input.idempotency || 'idempotent',
      requiredPermissions: input.requiredPermissions || [],
      supportedScopes: input.supportedScopes || [],
      schemaHash: sha256({ inputSchema: input.inputSchema, outputSchema: input.outputSchema, name: input.name, version: input.version }),
      implementationHash: input.implementationHash,
      cacheGroup: input.cacheGroup || `${input.namespace}.${input.name}`,
      enabled: true,
    };
    this.tools.set(input.toolId, descriptor);
    return descriptor;
  }

  get(toolId: string): ToolDescriptor | null {
    return this.tools.get(toolId) || null;
  }

  getByName(name: string): ToolDescriptor | null {
    for (const tool of this.tools.values()) {
      if (tool.name === name) return tool;
    }
    return null;
  }

  all(): ToolDescriptor[] {
    return [...this.tools.values()].sort((a, b) => a.toolId.localeCompare(b.toolId));
  }

  byCapability(capabilityId: string): ToolDescriptor[] {
    return this.all().filter(tool => tool.capabilityId === capabilityId);
  }

  setEnabled(toolId: string, enabled: boolean): void {
    const tool = this.tools.get(toolId);
    if (tool) this.tools.set(toolId, { ...tool, enabled });
  }

  /** Deterministic full-catalog hash (stable as long as nothing changes). */
  catalogHash(): string {
    return sha256(this.all());
  }
}
