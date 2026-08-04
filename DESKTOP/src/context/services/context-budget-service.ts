import { createHash } from 'crypto';
import { AssembledContext, ContextSection } from './context-orchestrator';
import {
  ContextSectionUsage,
  ContextUsageSnapshot,
  TokenAccuracy,
  TokenizerSource,
} from '../domain/types';
import { sha256, stableStringify } from '../serializers/deterministic';

export interface BudgetPolicy {
  /** Fraction of the model window reserved for output. */
  reservedOutputRatio: number;
  /** Fixed minimum reserved output tokens. */
  reservedOutputMinTokens: number;
  /** Fraction reserved for tool schemas/results. */
  toolReserveRatio: number;
  /** Fraction reserved as safety margin. */
  safetyMarginRatio: number;
  /** Default reserved output when the model window is unknown. */
  defaultReservedOutputTokens: number;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  reservedOutputRatio: 0.15,
  reservedOutputMinTokens: 4096,
  toolReserveRatio: 0.10,
  safetyMarginRatio: 0.05,
  defaultReservedOutputTokens: 4096,
};

export interface ContextBudgetInput {
  conversationId: string;
  branchId: string;
  buildBlockId: string;
  agentId: string;
  agentType: 'main' | 'subagent';
  provider: string;
  model: string;
  modelContextLimit: number;
  assembled: AssembledContext;
  reservedOutputTokens?: number;
  toolReserveTokens?: number;
  safetyMarginTokens?: number;
  tokenizerSource?: TokenizerSource;
  accuracy?: TokenAccuracy;
  calculationRevision?: number;
  /** Total serialized bytes of the tool payload carried in this request. */
  toolPayloadBytes?: number;
}

const CHARACTERS_PER_TOKEN = 4;

function estimateTextTokens(text: string): number {
  return Math.max(0, Math.ceil(String(text || '').length / CHARACTERS_PER_TOKEN));
}

/**
 * Backend-owned context budget service. The frontend never estimates tokens
 * itself; it only renders the snapshot this service produces.
 */
export class ContextBudgetService {
  constructor(private readonly policy: BudgetPolicy = DEFAULT_BUDGET_POLICY) {}

  private sectionUsage(section: ContextSection): ContextSectionUsage {
    return {
      sectionName: section.name,
      order: section.order,
      estimatedTokens: estimateTextTokens(section.content),
      contentHash: sha256(section.content),
    };
  }

  /**
   * Produce a ContextUsageSnapshot for an already-assembled context. The
   * snapshot's contextContentHash MUST equal the assembled context contentHash;
   * the request is only valid when they match.
   */
  snapshot(input: ContextBudgetInput): ContextUsageSnapshot {
    const modelLimit = Math.max(1, input.modelContextLimit || 128000);
    const reservedOutputTokens = Math.max(
      this.policy.reservedOutputMinTokens,
      Math.floor(modelLimit * this.policy.reservedOutputRatio),
    );
    const toolReserveTokens = Math.floor(modelLimit * this.policy.toolReserveRatio);
    const safetyMarginTokens = Math.floor(modelLimit * this.policy.safetyMarginRatio);

    const estimatedInputTokens =
      estimateTextTokens(input.assembled.text) +
      Math.ceil((input.toolPayloadBytes || 0) / CHARACTERS_PER_TOKEN);

    const effectiveContextBudget = modelLimit - reservedOutputTokens - toolReserveTokens - safetyMarginTokens;
    const estimatedTotalTokens = estimatedInputTokens + reservedOutputTokens;
    const remainingInputTokens = Math.max(0, effectiveContextBudget - estimatedInputTokens);
    const usageRatio = modelLimit > 0 ? estimatedInputTokens / modelLimit : 0;

    const sections = input.assembled.sections.map(section => this.sectionUsage(section));

    const snapshot: ContextUsageSnapshot = {
      snapshotId: `snapshot-${createHash('sha256').update(stableStringify({
        conversationId: input.conversationId,
        buildBlockId: input.buildBlockId,
        contextContentHash: input.assembled.contentHash,
        createdAt: Date.now(),
      })).digest('hex').slice(0, 24)}`,
      conversationId: input.conversationId,
      branchId: input.branchId,
      buildBlockId: input.buildBlockId,
      agentId: input.agentId,
      agentType: input.agentType,
      provider: input.provider,
      model: input.model,
      modelContextLimit: modelLimit,
      estimatedInputTokens,
      reservedOutputTokens,
      estimatedTotalTokens,
      effectiveContextBudget,
      remainingInputTokens,
      usageRatio,
      sections,
      tokenizerSource: input.tokenizerSource || 'estimated',
      accuracy: input.accuracy || 'estimated',
      calculationRevision: input.calculationRevision ?? 1,
      contextContentHash: input.assembled.contentHash,
      createdAt: new Date().toISOString(),
    };
    return snapshot;
  }

  /** Returns true only when the snapshot's content hash matches the assembled context. */
  verify(snapshot: ContextUsageSnapshot, assembled: AssembledContext): boolean {
    return snapshot.contextContentHash === assembled.contentHash;
  }
}
