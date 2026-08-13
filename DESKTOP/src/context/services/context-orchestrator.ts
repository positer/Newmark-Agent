import { LayeredHashes, hashLayered, sha256, stableStringify } from '../serializers/deterministic';

/**
 * The fixed context section order required by the dev-0.3.0 guide.
 *
 * Every model request must pass through the Context Orchestrator; no other
 * module may concatenate a prompt. The order is byte-stable and each section
 * carries a content hash so the frontend snapshot can be verified against the
 * actual assembled request.
 */
export const CONTEXT_SECTION_ORDER = [
  'general_prompt',
  'response_protocol',
  'base_tool_definitions',
  'workspace_agent_profile',
  'agent_role_and_permissions',
  'capability_boundary_summary',
  'active_toolset_manifest',
  'build_block_startup_input',
  'build_block_metadata',
  // Compatibility slot: linked-plan content is tool-retrieved on demand and
  // should remain empty for ordinary model requests.
  'linked_plan',
  'active_tasks',
  'current_work_set',
  'branch_log_summary',
  'retrieved_old_block_summary',
  'build_history_checkpoint',
  'checkpoint_delta',
  'current_tool_results',
  'current_user_input',
] as const;

export type ContextSectionName = (typeof CONTEXT_SECTION_ORDER)[number];

export interface ContextSection {
  name: ContextSectionName;
  order: number;
  /** Stable across turns for the "stable prefix" region. */
  stable: boolean;
  content: string;
}

export interface AssembledContext {
  sections: ContextSection[];
  /** Concatenated stable prefix (sections up to and including stable boundary). */
  stablePrefix: string;
  /** Concatenated dynamic tail. */
  dynamicTail: string;
  /** Full assembled text. */
  text: string;
  hashes: LayeredHashes;
  contentHash: string;
  createdAt: string;
}

export interface ContextAssemblerInput {
  generalPrompt: string;
  responseProtocol: string;
  baseToolDefinitions: unknown;
  workspaceAgentProfile: string;
  agentRoleAndPermissions: string;
  capabilityBoundarySummary: string;
  activeToolsetManifest: string;
  buildBlockStartupInput: string;
  buildBlockMetadata: string;
  linkedPlan: string;
  activeTasks: string;
  currentWorkSet: string;
  branchLogSummary: string;
  retrievedOldBlockSummary: string;
  buildHistoryCheckpoint: string;
  checkpointDelta: string;
  currentToolResults: string;
  currentUserInput: string;
  /** Last section that is part of the cache-stable prefix. Defaults to active_toolset_manifest. */
  stablePrefixEnd?: ContextSectionName;
}

const DEFAULT_STABLE_END: ContextSectionName = 'active_toolset_manifest';

/**
 * The single entry point for assembling a model request. All callers that send
 * model requests must route through this. It guarantees the fixed order and
 * computes layered hashes so the assembled bytes can be verified against the
 * snapshot shown in the frontend.
 */
export class ContextOrchestrator {
  assemble(input: ContextAssemblerInput): AssembledContext {
    const stableEnd = input.stablePrefixEnd || DEFAULT_STABLE_END;
    const stableEndIndex = CONTEXT_SECTION_ORDER.indexOf(stableEnd);
    const entries: Array<[ContextSectionName, string]> = [
      ['general_prompt', input.generalPrompt],
      ['response_protocol', input.responseProtocol],
      ['base_tool_definitions', this.serializeUnknown(input.baseToolDefinitions)],
      ['workspace_agent_profile', input.workspaceAgentProfile],
      ['agent_role_and_permissions', input.agentRoleAndPermissions],
      ['capability_boundary_summary', input.capabilityBoundarySummary],
      ['active_toolset_manifest', input.activeToolsetManifest],
      ['build_block_startup_input', input.buildBlockStartupInput],
      ['build_block_metadata', input.buildBlockMetadata],
      ['linked_plan', input.linkedPlan],
      ['active_tasks', input.activeTasks],
      ['current_work_set', input.currentWorkSet],
      ['branch_log_summary', input.branchLogSummary],
      ['retrieved_old_block_summary', input.retrievedOldBlockSummary],
      ['build_history_checkpoint', input.buildHistoryCheckpoint],
      ['checkpoint_delta', input.checkpointDelta],
      ['current_tool_results', input.currentToolResults],
      ['current_user_input', input.currentUserInput],
    ];

    const sections: ContextSection[] = entries.map(([name, content], index) => ({
      name,
      order: index,
      stable: index <= stableEndIndex,
      content,
    }));

    const stablePrefix = sections
      .filter(section => section.stable)
      .map(section => section.content)
      .filter(Boolean)
      .join('\n\n');
    const dynamicTail = sections
      .filter(section => !section.stable)
      .map(section => section.content)
      .filter(Boolean)
      .join('\n\n');

    const text = [stablePrefix, dynamicTail].filter(Boolean).join('\n\n');
    const hashes = hashLayered({
      generalPrompt: input.generalPrompt,
      responseProtocol: input.responseProtocol,
      toolDefinitions: input.baseToolDefinitions,
      workspaceProfile: input.workspaceAgentProfile,
      stablePrefix,
      dynamicContext: {
        buildBlockStartupInput: input.buildBlockStartupInput,
        buildBlockMetadata: input.buildBlockMetadata,
        linkedPlan: input.linkedPlan,
        activeTasks: input.activeTasks,
        currentWorkSet: input.currentWorkSet,
        branchLogSummary: input.branchLogSummary,
        retrievedOldBlockSummary: input.retrievedOldBlockSummary,
        buildHistoryCheckpoint: input.buildHistoryCheckpoint,
        checkpointDelta: input.checkpointDelta,
        currentToolResults: input.currentToolResults,
        currentUserInput: input.currentUserInput,
      },
    });

    return {
      sections,
      stablePrefix,
      dynamicTail,
      text,
      hashes,
      contentHash: sha256({ stablePrefixHash: hashes.stablePrefixHash, dynamicContextHash: hashes.dynamicContextHash, text }),
      createdAt: new Date().toISOString(),
    };
  }

  private serializeUnknown(value: unknown): string {
    return value === undefined || value === null ? '' : stableStringify(value);
  }
}
