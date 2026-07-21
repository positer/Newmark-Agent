export interface CompressionFidelityCase {
  originalText: string;
  summaryText: string;
  requiredFacts: string[];
  forbiddenFacts?: string[];
  maxCompressionRatio?: number;
}

export interface CompressionFidelityResult {
  passed: boolean;
  retainedRequired: string[];
  missingRequired: string[];
  excludedForbidden: string[];
  leakedForbidden: string[];
  compressionRatio: number;
}

export function evaluateCompressionFidelity(input: CompressionFidelityCase): CompressionFidelityResult {
  const original = normalize(input.originalText);
  const summary = normalize(input.summaryText);
  const retainedRequired = input.requiredFacts.filter(fact => includesFact(summary, fact));
  const missingRequired = input.requiredFacts.filter(fact => !includesFact(summary, fact));
  const forbidden = input.forbiddenFacts || [];
  const leakedForbidden = forbidden.filter(fact => includesFact(summary, fact));
  const excludedForbidden = forbidden.filter(fact => !includesFact(summary, fact));
  const compressionRatio = original.length > 0 ? summary.length / original.length : 0;
  const ratioLimit = Number.isFinite(input.maxCompressionRatio) ? Math.max(0, Number(input.maxCompressionRatio)) : 1;
  return {
    passed: missingRequired.length === 0 && leakedForbidden.length === 0 && compressionRatio <= ratioLimit,
    retainedRequired,
    missingRequired,
    excludedForbidden,
    leakedForbidden,
    compressionRatio,
  };
}

function includesFact(text: string, fact: string): boolean {
  const normalizedFact = normalize(fact);
  return !!normalizedFact && text.includes(normalizedFact);
}

function normalize(value: string): string {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
