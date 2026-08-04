import { ContextFeatureFlags, DEFAULT_CONTEXT_FEATURE_FLAGS, normalizeContextFeatureFlags } from '../feature-flags';

export interface ContextFlagSource {
  contextFlag(flag: string): boolean;
}

/**
 * Resolves feature flags from a config-like source. Unknown flags resolve to
 * the default (disabled). This keeps the new modules independent of the
 * ConfigManager import cycle.
 */
export function resolveContextFeatureFlags(source?: ContextFlagSource | null): ContextFeatureFlags {
  if (!source) return { ...DEFAULT_CONTEXT_FEATURE_FLAGS };
  const keys: Array<keyof ContextFeatureFlags> = [
    'structuredContextV2',
    'buildHistoryPersistence',
    'branchLogV2',
    'structuredTasks',
    'structuredPlans',
    'contextCompressionV2',
    'scopedToolResults',
    'providerAdaptersV2',
    'agentRuntimeV2',
    'subagentRuntimeV2',
    'capabilityCatalogV1',
    'adaptiveToolExposureV1',
    'toolSchemaOnDemandV1',
    'capabilityBoundaryPromptV1',
  ];
  const configKeyByFlag: Record<keyof ContextFeatureFlags, string> = {
    structuredContextV2: 'structured_context_v2',
    buildHistoryPersistence: 'build_history_persistence',
    branchLogV2: 'branch_log_v2',
    structuredTasks: 'structured_tasks',
    structuredPlans: 'structured_plans',
    contextCompressionV2: 'context_compression_v2',
    scopedToolResults: 'scoped_tool_results',
    providerAdaptersV2: 'provider_adapters_v2',
    agentRuntimeV2: 'agent_runtime_v2',
    subagentRuntimeV2: 'subagent_runtime_v2',
    capabilityCatalogV1: 'capability_catalog_v1',
    adaptiveToolExposureV1: 'adaptive_tool_exposure_v1',
    toolSchemaOnDemandV1: 'tool_schema_on_demand_v1',
    capabilityBoundaryPromptV1: 'capability_boundary_prompt_v1',
  };
  const raw: Record<string, boolean> = {};
  for (const key of keys) {
    try {
      raw[key as string] = !!source.contextFlag(configKeyByFlag[key]);
    } catch {
      raw[key as string] = false;
    }
  }
  return normalizeContextFeatureFlags(raw);
}
