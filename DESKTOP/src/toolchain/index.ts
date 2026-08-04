export * from './registry/tool-registry';
export type { ToolDescriptorInput } from './registry/tool-registry';
export * from './capabilities/capability-catalog';
export type { CapabilityDescriptorInput } from './capabilities/capability-catalog';
export * from './capabilities/capability-boundary';
export * from './exposure/active-toolset';
export * from './exposure/tool-exposure-planner';
export type { ExposurePlannerInput, ExposurePlanResult } from './exposure/tool-exposure-planner';
export * from './exposure/schema-loader';
export type { LoadSchemaInput, LoadSchemaResult, SchemaLoaderOptions } from './exposure/schema-loader';
export * from './authorization/tool-permission.service';
export type { ToolPermissionContext, PermissionDecision } from './authorization/tool-permission.service';
export * from './registry-seeder';
export type { SeededToolchain, SeededToolDefinition, RegistrySeedOptions, ToolAnnotations } from './registry-seeder';

import { ToolRegistry } from './registry/tool-registry';
import { CapabilityCatalog } from './capabilities/capability-catalog';

export interface ToolchainCore {
  registry: ToolRegistry;
  catalog: CapabilityCatalog;
}

export function createToolchainCore(): ToolchainCore {
  return { registry: new ToolRegistry(), catalog: new CapabilityCatalog() };
}
