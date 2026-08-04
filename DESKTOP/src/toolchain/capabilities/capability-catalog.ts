import { CapabilityDescriptor, Discoverability, LatencyClass, LoadPolicy, RiskLevel, SideEffectClass } from '../../context/domain/types';
import { sha256 } from '../../context/serializers/deterministic';

export interface CapabilityDescriptorInput {
  capabilityId: string;
  domain: string;
  name: string;
  shortDescription: string;
  detailedDescription?: string;
  operations: string[];
  riskLevel: RiskLevel;
  sideEffectClass?: SideEffectClass;
  requiredPermissions?: string[];
  supportedResourceScopes?: string[];
  discoverability?: Discoverability;
  loadPolicy?: LoadPolicy;
  estimatedSchemaTokens?: number;
  estimatedLatencyClass?: LatencyClass;
  version?: number;
}

/**
 * Capability Catalog: the global directory of capabilities. Capability is
 * separated from concrete tools, so an Agent can express "I need code.search"
 * without knowing whether the implementation is ripgrep, code_index, or
 * workspace.symbol_search.
 */
export class CapabilityCatalog {
  private readonly capabilities = new Map<string, CapabilityDescriptor>();

  register(input: CapabilityDescriptorInput): CapabilityDescriptor {
    const descriptor: CapabilityDescriptor = {
      capabilityId: input.capabilityId,
      domain: input.domain,
      name: input.name,
      shortDescription: input.shortDescription,
      detailedDescription: input.detailedDescription,
      operations: input.operations,
      riskLevel: input.riskLevel,
      sideEffectClass: input.sideEffectClass || (input.riskLevel === 'read' ? 'none' : 'local_reversible'),
      requiredPermissions: input.requiredPermissions || [],
      supportedResourceScopes: input.supportedResourceScopes || [],
      discoverability: input.discoverability || 'task_relevant',
      loadPolicy: input.loadPolicy || (input.riskLevel === 'read' ? 'on_demand' : 'approval_required'),
      estimatedSchemaTokens: input.estimatedSchemaTokens ?? Math.max(120, input.operations.length * 40),
      estimatedLatencyClass: input.estimatedLatencyClass || 'low',
      toolIds: [],
      version: input.version ?? 1,
    };
    this.capabilities.set(input.capabilityId, descriptor);
    return descriptor;
  }

  get(capabilityId: string): CapabilityDescriptor | null {
    return this.capabilities.get(capabilityId) || null;
  }

  all(): CapabilityDescriptor[] {
    return [...this.capabilities.values()].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  }

  byDomain(domain: string): CapabilityDescriptor[] {
    return this.all().filter(capability => capability.domain === domain);
  }

  search(query: string, options?: { riskLevels?: RiskLevel[]; limit?: number }): CapabilityDescriptor[] {
    const text = String(query || '').toLowerCase();
    const terms = [...new Set(text.split(/[^a-z0-9_-]+/).filter(term => term.length > 1))];
    const limit = Math.max(1, options?.limit ?? 8);
    if (!terms.length) return [];
    const scored = this.all()
      .filter(capability => {
        if (options?.riskLevels?.length && !options.riskLevels.includes(capability.riskLevel)) return false;
        return true;
      })
      .map(capability => {
        const name = capability.capabilityId.toLowerCase();
        const short = capability.shortDescription.toLowerCase();
        const detailed = (capability.detailedDescription || '').toLowerCase();
        const score = terms.reduce((sum, term) => sum
          + (name === term ? 16 : name.startsWith(term) ? 10 : name.includes(term) ? 6 : 0)
          + (short.includes(term) ? 3 : 0)
          + (detailed.includes(term) ? 1 : 0), 0);
        return { capability, score };
      })
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.capability.capabilityId.localeCompare(b.capability.capabilityId))
      .slice(0, limit)
      .map(entry => entry.capability);
    return scored;
  }

  /** Byte-stable boundary hash used to prove the boundary prompt did not change. */
  boundaryHash(): string {
    return sha256(this.all());
  }
}
