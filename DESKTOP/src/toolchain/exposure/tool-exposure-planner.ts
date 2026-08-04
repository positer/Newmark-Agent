import { RiskLevel, ToolExposurePlan } from '../../context/domain/types';
import { ToolRegistry } from '../registry/tool-registry';
import { CapabilityCatalog } from '../capabilities/capability-catalog';
import { BASE_TOOLSET_ID, PRESET_TOOLSETS } from './active-toolset';
import { sha256 } from '../../context/serializers/deterministic';

export interface ExposurePlannerInput {
  agentRunId: string;
  buildBlockId: string;
  userInput: string;
  objective: string;
  previousToolCalls: string[];
  toolUsageFrequency: Map<string, number>;
  permissionScope: string[];
  tokenBudget: number;
  /** provider tool count limit (0 = unlimited). */
  providerToolLimit: number;
}

export interface ExposurePlanResult {
  plan: ToolExposurePlan;
  baseToolIds: string[];
  activeToolIds: string[];
  suggestedCapabilityIds: string[];
}

const RISK_PREFERENCE: Record<RiskLevel, number> = { read: 0, write: 1, external: 2, destructive: 3 };

/**
 * Tool Exposure Planner — decides what is exposed each turn before the model
 * request, without relying on the Agent to ask. Strategy:
 * 1. Always expose the minimal base toolset.
 * 2. Load one stable preset toolset for the detected task domain.
 * 3. Add only highly relevant tools.
 * 4. Never randomly reorder; stable hash.
 * 5. When the token budget is exceeded, release least-used tools first.
 * 6. Write/external/destructive tools default to conservative.
 */
export class ToolExposurePlanner {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly catalog: CapabilityCatalog,
  ) {}

  plan(input: ExposurePlannerInput): ExposurePlanResult {
    const domain = detectDomain(input);
    const preset = PRESET_TOOLSETS[domain] || [];
    const baseToolIds = PRESET_TOOLSETS[BASE_TOOLSET_ID] || [];

    const active = new Set<string>(baseToolIds);
    for (const toolId of preset) {
      if (this.registry.get(toolId)) active.add(toolId);
    }

    // Task-relevant additions: match capability domains present in user input.
    const suggestedCapabilityIds: string[] = [];
    const intent = String(input.userInput || '').toLowerCase();
    const domainSignals: Array<[RegExp, string]> = [
      [/\b(git|commit|push|pull|pr|branch|diff)\b/, 'vcs.inspect'],
      [/\b(search|find|symbol|reference)\b/, 'code.search'],
      [/\b(build|compile|test|run)\b/, 'test.run'],
      [/\b(web|browse|internet|online)\b/, 'web.search'],
      [/\b(automation|schedule)\b/, 'automation.manage'],
      [/\b(workflow|flow)\b/, 'flow.manage'],
    ];
    for (const [regex, capabilityId] of domainSignals) {
      if (regex.test(intent)) suggestedCapabilityIds.push(capabilityId);
    }
    // Add the implementation tools for suggested capabilities.
    for (const capabilityId of suggestedCapabilityIds) {
      for (const tool of this.registry.all()) {
        if (tool.capabilityId === capabilityId && this.registry.get(tool.toolId)?.enabled) {
          active.add(tool.toolId);
        }
      }
    }

    // Explicitly named tools from previous calls are retained (continuity).
    for (const toolId of input.previousToolCalls || []) {
      if (this.registry.get(toolId)?.enabled) active.add(toolId);
    }

    // Track omitted tools and reasons.
    const omittedToolIds: string[] = [];
    const omissionReasons: Record<string, string> = {};
    for (const tool of this.registry.all()) {
      if (!tool.enabled) {
        omittedToolIds.push(tool.toolId);
        omissionReasons[tool.toolId] = 'disabled';
        continue;
      }
      if (active.has(tool.toolId)) continue;
      if (RISK_PREFERENCE[tool.riskLevel] >= 3) {
        omittedToolIds.push(tool.toolId);
        omissionReasons[tool.toolId] = 'high_risk_not_auto_exposed';
        continue;
      }
      omittedToolIds.push(tool.toolId);
      omissionReasons[tool.toolId] = 'not_relevant';
    }

    // Provider tool count limit.
    if (input.providerToolLimit > 0) {
      const ordered = [...active].sort((a, b) => {
        const aFreq = input.toolUsageFrequency.get(a) || 0;
        const bFreq = input.toolUsageFrequency.get(b) || 0;
        return bFreq - aFreq;
      });
      const kept = new Set<string>();
      for (const toolId of ordered) {
        if (kept.size >= input.providerToolLimit) {
          if (!omittedToolIds.includes(toolId)) omittedToolIds.push(toolId);
          omissionReasons[toolId] = 'provider_tool_limit';
        } else {
          kept.add(toolId);
        }
      }
      active.clear();
      for (const toolId of kept) active.add(toolId);
    }

    // Token budget: release least-used tools (never the base core) until under.
    let schemaTokens = this.estimateSchemaTokens([...active]);
    let iteration = 0;
    while (schemaTokens > input.tokenBudget && iteration < 40) {
      iteration += 1;
      const removable = [...active]
        .filter(toolId => !baseToolIds.includes(toolId))
        .sort((a, b) => (input.toolUsageFrequency.get(a) || 0) - (input.toolUsageFrequency.get(b) || 0));
      if (!removable.length) break;
      const toolId = removable[0];
      active.delete(toolId);
      if (!omittedToolIds.includes(toolId)) omittedToolIds.push(toolId);
      omissionReasons[toolId] = 'schema_token_budget';
      schemaTokens = this.estimateSchemaTokens([...active]);
    }

    const activeToolIds = [...active];
    const plan: ToolExposurePlan = {
      planId: `plan-${sha256({ buildBlockId: input.buildBlockId, activeToolIds, suggestedCapabilityIds }).slice(0, 16)}`,
      agentRunId: input.agentRunId,
      buildBlockId: input.buildBlockId,
      baseToolsetId: BASE_TOOLSET_ID,
      activeToolIds,
      suggestedCapabilityIds: [...new Set(suggestedCapabilityIds)],
      omittedToolIds,
      omissionReasons,
      estimatedSchemaTokens: schemaTokens,
      stableToolsetHash: sha256({ activeToolIds, suggestedCapabilityIds }),
      createdAt: new Date().toISOString(),
    };
    return { plan, baseToolIds, activeToolIds, suggestedCapabilityIds: plan.suggestedCapabilityIds };
  }

  private estimateSchemaTokens(toolIds: string[]): number {
    return toolIds.reduce((sum, toolId) => {
      const tool = this.registry.get(toolId);
      return sum + (tool ? Math.ceil(JSON.stringify(tool.inputSchema).length / 4) : 0);
    }, 0);
  }
}

function detectDomain(input: ExposurePlannerInput): string {
  const text = String(input.userInput || input.objective || '').toLowerCase();
  if (/\b(git|github|commit|push|pull|pr|branch|diff)\b/.test(text)) return 'toolset-git-review';
  if (/\b(build|compile|test|run|code|coding)\b/.test(text)) return 'toolset-coding';
  if (/\b(search|research|lookup|web|find online)\b/.test(text)) return 'toolset-research';
  if (/\b(read|edit|write|refactor|change)\b/.test(text)) return 'toolset-file-edit';
  return 'toolset-coding';
}
