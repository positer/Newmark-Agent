import * as path from 'path';
import { ContextFeatureFlags } from '../feature-flags';
import { resolveContextFeatureFlags } from '../services/flag-resolver';
import { BuildHistoryRepository } from '../repositories/build-history-repository';
import { PlanTaskRepository } from '../repositories/plan-task-repository';
import { ToolResultService } from '../services/tool-result-service';
import { ContextOrchestrator } from '../services/context-orchestrator';
import { ContextBudgetService } from '../services/context-budget-service';
import { ContextUsageSnapshot } from '../domain/types';

/**
 * Facade that wires the dev-0.3.0 context modules to the Agent. The Agent
 * holds one instance and consults it only when the corresponding feature flag
 * is enabled; otherwise the old paths remain authoritative.
 */
export class AgentContextManager {
  readonly flags: ContextFeatureFlags;
  readonly buildHistory: BuildHistoryRepository;
  readonly plans: PlanTaskRepository;
  readonly toolResults: ToolResultService;
  readonly orchestrator: ContextOrchestrator;
  readonly budget: ContextBudgetService;

  constructor(root: string, flagSource?: { contextFlag(flag: string): boolean }) {
    this.flags = resolveContextFeatureFlags(flagSource);
    const contextRoot = path.join(root, '.newmark-context-v2');
    this.buildHistory = new BuildHistoryRepository(contextRoot);
    this.plans = new PlanTaskRepository(contextRoot);
    this.toolResults = new ToolResultService(contextRoot);
    this.orchestrator = new ContextOrchestrator();
    this.budget = new ContextBudgetService();
  }

  /** Produce a snapshot for a pre-assembled context (backend single source of truth). */
  snapshot(input: {
    conversationId: string;
    branchId: string;
    buildBlockId: string;
    agentId: string;
    agentType: 'main' | 'subagent';
    provider: string;
    model: string;
    modelContextLimit: number;
    assembledText: string;
    sections: Array<{ name: string; order: number; content: string }>;
    toolPayloadBytes?: number;
    contextContentHash: string;
  }): ContextUsageSnapshot {
    const assembled = {
      sections: input.sections.map(section => ({ name: section.name as never, order: section.order, stable: section.order <= 7, content: section.content })),
      stablePrefix: '',
      dynamicTail: '',
      text: input.assembledText,
      contentHash: input.contextContentHash,
    } as unknown as ReturnType<ContextOrchestrator['assemble']>;
    return this.budget.snapshot({
      conversationId: input.conversationId,
      branchId: input.branchId,
      buildBlockId: input.buildBlockId,
      agentId: input.agentId,
      agentType: input.agentType,
      provider: input.provider,
      model: input.model,
      modelContextLimit: input.modelContextLimit,
      assembled,
      toolPayloadBytes: input.toolPayloadBytes,
    });
  }
}
