/**
 * Deterministic legacy decision fixture used only by routing tests.
 * Production JEV decisions come from CurrentModelJevDecisionEngine.
 */
import {
  DEFAULT_JEV_MAX_ALTERNATES,
  JevDecisionError,
  JEV_ROUTE_MODEL_VERSION,
  type JevCandidate,
  type JevDecisionEngine,
  type JevRouteDecision,
  type JevRouteRequest,
} from '../../core/jevDecision';

const VALIDATION_LEVEL_RANK: Record<JevCandidate['validation']['level'], number> = {
  extended: 4,
  standard: 3,
  basic: 2,
  legacy_basic: 1,
  discovered: 0,
};

const VALIDATION_STATUS_RANK: Record<JevCandidate['validation']['status'], number> = {
  verified: 3,
  degraded: 2,
  rate_limited: 1,
  unavailable: 0,
  auth_error: 0,
  invalid_config: 0,
};

function costPerMillion(candidate: JevCandidate, request: JevRouteRequest): number {
  const input = Number(candidate.cost.inputPerM);
  const output = Number(candidate.cost.outputPerM);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return Number.POSITIVE_INFINITY;
  return input * Math.max(0, request.task.estimatedInputTokens) / 1_000_000
    + output * Math.max(0, request.task.expectedOutputTokens) / 1_000_000;
}

function descendingOrdering(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return Number.NEGATIVE_INFINITY;
  return value;
}

function ascendingOrdering(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return value;
}

function orderingKey(candidate: JevCandidate, request: JevRouteRequest): Array<number | string> {
  const circuit = candidate.operational.circuit === 'open' ? 1 : 0;
  const userPreference = descendingOrdering(candidate.userPreference);
  const validationLevel = VALIDATION_LEVEL_RANK[candidate.validation.level] ?? 0;
  const validationStatus = VALIDATION_STATUS_RANK[candidate.validation.status] ?? 0;
  const reliability = descendingOrdering(candidate.operational.reliability);
  const toolRelevant = request.task.taskClasses.some(taskClass => taskClass === 'tool_use' || taskClass === 'computer_use');
  const toolValidity = toolRelevant ? descendingOrdering(candidate.operational.toolValidity ?? candidate.operational.reliability) : 0;
  const cost = ascendingOrdering(costPerMillion(candidate, request));
  const latency = ascendingOrdering(candidate.operational.latencyMs);
  const throughput = -ascendingOrdering(candidate.operational.throughput);

  // A neutral test oracle ranks supplied evidence consistently. Only its
  // tie behavior varies with the qualitative tendency below; production
  // selection is made by the current eligible model, not this comparator.
  return [circuit, -userPreference, -validationLevel, -validationStatus, -reliability, -toolValidity, cost, latency, throughput];
}

function compareOrdering(left: Array<number | string>, right: Array<number | string>): number {
  const length = Math.max(left.length, right.length);
  for (let position = 0; position < length; position += 1) {
    const a = left[position];
    const b = right[position];
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') {
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      return a < b ? -1 : 1;
    }
    return String(a) < String(b) ? -1 : 1;
  }
  return 0;
}

function contextBucket(request: JevRouteRequest): string {
  const total = request.task.estimatedInputTokens + request.task.expectedOutputTokens;
  if (total >= 32_000) return 'long_context';
  if (total >= 8_000) return 'medium_context';
  return 'short_context';
}

/**
 * Kept only so historical decision contract tests can use a stable oracle.
 * It must not be imported by production source or included in the application
 * package.
 */
export class LocalJevDecisionEngine implements JevDecisionEngine {
  private readonly modelVersion: string;

  constructor(private readonly options: { maxAlternates?: number; modelVersion?: string } = {}) {
    const modelVersion = String(options.modelVersion || JEV_ROUTE_MODEL_VERSION).replace(/[\u0000-\u001F\u007F]/g, '').trim();
    this.modelVersion = modelVersion.slice(0, 120) || JEV_ROUTE_MODEL_VERSION;
  }

  async decide(request: JevRouteRequest): Promise<JevRouteDecision> {
    if (!request.candidates.length) {
      throw new JevDecisionError('no_candidates', 'JEV received no eligible candidates');
    }
    const previous = request.previous?.deployment;
    const indexed = request.candidates.map((candidate, index) => ({
      candidate,
      index,
      key: orderingKey(candidate, request),
      continuation: !!previous
        && previous.providerId === candidate.deployment.providerId
        && previous.modelId === candidate.deployment.modelId,
    }));
    indexed.sort((left, right) => {
      const circuit = compareOrdering([left.key[0]], [right.key[0]]);
      if (circuit) return circuit;
      const preference = compareOrdering([left.key[1]], [right.key[1]]);
      if (preference) return preference;
      if (request.objective.tendency === 'conservative' && left.continuation !== right.continuation) {
        return left.continuation ? -1 : 1;
      }
      const evidence = compareOrdering(left.key.slice(2), right.key.slice(2));
      if (evidence) return evidence;
      if (request.objective.tendency !== 'aggressive' && left.continuation !== right.continuation) {
        return left.continuation ? -1 : 1;
      }
      return left.index - right.index;
    });

    const primary = indexed[0];
    const maxAlternates = Math.max(0, this.options.maxAlternates ?? DEFAULT_JEV_MAX_ALTERNATES);
    const alternates = indexed.slice(1, 1 + maxAlternates).map(entry => ({ ...entry.candidate.deployment }));
    const reasonCodes = [
      ...request.task.taskClasses,
      contextBucket(request),
      `tendency:${request.objective.tendency}`,
    ];
    if (primary.candidate.preview) reasonCodes.push('preview_deployment');
    if (primary.candidate.fallbackOnly) reasonCodes.push('fallback_only_recovery');
    if (primary.candidate.operational.circuit === 'open') reasonCodes.push('circuit_open_demoted_but_only_candidate');
    if (primary.continuation) reasonCodes.push('previous_deployment_continuation');
    const userPreference = Number(primary.candidate.userPreference);
    if (Number.isFinite(userPreference) && userPreference !== 0) reasonCodes.push('user_preference_applied');
    for (const capability of request.task.requiredCapabilities) reasonCodes.push(`capability:${capability}`);

    return {
      primary: { ...primary.candidate.deployment },
      alternates,
      reasonCodes,
      modelVersion: this.modelVersion,
    };
  }
}
