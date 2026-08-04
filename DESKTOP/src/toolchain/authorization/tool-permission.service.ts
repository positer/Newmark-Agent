import { RiskLevel } from '../../context/domain/types';
import { ToolRegistry } from '../registry/tool-registry';

export interface ToolPermissionContext {
  requiredPermissions: string[];
  resourceScopes: string[];
  isSubagent: boolean;
  allowedCapabilityIds: string[];
  allowedDomains?: string[];
}

export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Tool Permission Service — the runtime authorization boundary that runs before
 * every tool invocation, independent of whether the schema was loaded.
 * "Capability visible" never equals "tool callable".
 */
export class ToolPermissionService {
  constructor(private readonly registry: ToolRegistry) {}

  authorize(toolId: string, context: ToolPermissionContext): PermissionDecision {
    const tool = this.registry.get(toolId);
    if (!tool) return { allowed: false, reason: `tool ${toolId} is not registered` };
    if (!tool.enabled) return { allowed: false, reason: `tool ${toolId} is disabled` };
    if (!context.allowedCapabilityIds.includes(tool.capabilityId)) {
      return { allowed: false, reason: `capability ${tool.capabilityId} is not authorized for this agent` };
    }
    if (context.isSubagent && context.allowedDomains?.length) {
      const domain = tool.capabilityId.split('.')[0];
      if (!context.allowedDomains.includes(domain)) {
        return { allowed: false, reason: `capability ${tool.capabilityId} exceeds the subagent capability ceiling` };
      }
    }
    for (const permission of tool.requiredPermissions) {
      if (!context.requiredPermissions.includes(permission)) {
        return { allowed: false, reason: `missing required permission: ${permission}` };
      }
    }
    for (const scope of tool.supportedScopes) {
      if (!context.resourceScopes.includes(scope)) {
        return { allowed: false, reason: `resource scope ${scope} is not granted` };
      }
    }
    if (tool.riskLevel === 'destructive' && context.isSubagent) {
      return { allowed: false, reason: 'destructive tools are never authorized for subagents' };
    }
    if (tool.riskLevel === 'external' && context.isSubagent) {
      return { allowed: false, reason: 'external tools are never authorized for subagents' };
    }
    return { allowed: true };
  }

  /** Risk gating: R3/R4 (external/destructive) always require explicit approval. */
  requiresApproval(toolId: string): boolean {
    const tool = this.registry.get(toolId);
    if (!tool) return false;
    return tool.riskLevel === 'external' || tool.riskLevel === 'destructive';
  }

  riskLevel(toolId: string): RiskLevel | null {
    return this.registry.get(toolId)?.riskLevel ?? null;
  }
}
