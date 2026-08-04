/**
 * dev-0.3.0 context system feature flags.
 *
 * Migration starts with every new path disabled so the old behavior remains the
 * default. Flags are rolled out one at a time (P0 -> P3) and each flag offers a
 * rollback path: setting it to false restores the previous code path.
 */
export interface ContextFeatureFlags {
  /** Structured context v2 (orchestrator + fixed order + snapshot). */
  structuredContextV2: boolean;
  /** Build History independent persistence (append-only). */
  buildHistoryPersistence: boolean;
  /** Branch long-log v2 (epoch summaries). */
  branchLogV2: boolean;
  /** Structured Task list with expectedVersion. */
  structuredTasks: boolean;
  /** Structured Linked Plan object. */
  structuredPlans: boolean;
  /** Checkpoint + delta compression. */
  contextCompressionV2: boolean;
  /** Tool result lifecycle (scoped results, on-disk large outputs). */
  scopedToolResults: boolean;
  /** Unified provider adapter layer (chat completions + responses). */
  providerAdaptersV2: boolean;
  /** Agent Run persisted state machine. */
  agentRuntimeV2: boolean;
  /** SubAgent persisted runs + context packages. */
  subagentRuntimeV2: boolean;

  /** Capability catalog v1. */
  capabilityCatalogV1: boolean;
  /** Adaptive tool exposure planner. */
  adaptiveToolExposureV1: boolean;
  /** On-demand tool schema loading. */
  toolSchemaOnDemandV1: boolean;
  /** Capability boundary prompt injection. */
  capabilityBoundaryPromptV1: boolean;
}

export const DEFAULT_CONTEXT_FEATURE_FLAGS: ContextFeatureFlags = {
  structuredContextV2: true,
  buildHistoryPersistence: true,
  branchLogV2: true,
  structuredTasks: true,
  structuredPlans: true,
  contextCompressionV2: true,
  scopedToolResults: true,
  providerAdaptersV2: true,
  agentRuntimeV2: true,
  subagentRuntimeV2: true,

  capabilityCatalogV1: true,
  adaptiveToolExposureV1: true,
  toolSchemaOnDemandV1: true,
  capabilityBoundaryPromptV1: true,
};

export const CONTEXT_FEATURE_FLAG_KEYS = Object.keys(DEFAULT_CONTEXT_FEATURE_FLAGS) as Array<keyof ContextFeatureFlags>;

export function normalizeContextFeatureFlags(value: unknown): ContextFeatureFlags {
  const raw = (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
  const out = { ...DEFAULT_CONTEXT_FEATURE_FLAGS };
  for (const key of CONTEXT_FEATURE_FLAG_KEYS) {
    const v = raw[key];
    if (typeof v === 'boolean') out[key] = v;
    if (v === 'true') out[key] = true;
    if (v === 'false') out[key] = false;
  }
  return out;
}

/** Legacy fallback: any single section key enables the whole system group. */
export function featureFlagsFromConfigSections(sections: Record<string, unknown>): ContextFeatureFlags {
  const raw = sections && typeof sections === 'object'
    ? (sections as Record<string, unknown>).context ?? (sections as Record<string, unknown>).context_flags
    : undefined;
  return normalizeContextFeatureFlags(raw);
}
