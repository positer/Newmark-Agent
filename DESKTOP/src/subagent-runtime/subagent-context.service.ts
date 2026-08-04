import * as fs from 'fs';
import * as path from 'path';
import { RiskLevel } from '../context/domain/types';
import { SubAgentContextPackage, SubAgentDelta } from '../context/domain/types';
import { sha256, stableStringify } from '../context/serializers/deterministic';

export interface SubAgentCeiling {
  allowedCapabilityDomains: string[];
  forbiddenCapabilityIds: string[];
  allowedToolIds: string[];
  resourceScopes: string[];
  riskCeiling: RiskLevel;
}

const RISK_ORDER: Record<RiskLevel, number> = { read: 0, write: 1, external: 2, destructive: 3 };

export interface CreateSubAgentContextInput {
  runId: string;
  parentRunId: string;
  task: string;
  ceiling: SubAgentCeiling;
  discoverableCapabilityIds: string[];
}

export interface SubAgentContextStore {
  createPackage(input: CreateSubAgentContextInput): SubAgentContextPackage;
  readPackage(runId: string): SubAgentContextPackage | null;
  appendDelta(runId: string, content: string): SubAgentDelta;
  readDeltas(runId: string): SubAgentDelta[];
  /** Whether loading this capability is allowed given the ceiling. */
  capabilityAllowed(runId: string, capabilityId: string, riskLevel: RiskLevel): { allowed: boolean; reason?: string };
}

/**
 * SubAgent context package + delta + capability ceiling enforcement.
 *
 * The initial Context Package is immutable (hash-bound). Deltas are appended,
 * never merged back into the package. Capability ceiling cannot be exceeded
 * even when the catalog lists a discoverable capability.
 */
export class SubAgentContextService implements SubAgentContextStore {
  constructor(private readonly root: string) {}

  private packagePath(runId: string): string {
    return path.join(this.root, 'subagent-runs', runId, 'context-package.json');
  }

  private deltaPath(runId: string): string {
    return path.join(this.root, 'subagent-runs', runId, 'deltas.jsonl');
  }

  createPackage(input: CreateSubAgentContextInput): SubAgentContextPackage {
    const pkg: SubAgentContextPackage = {
      runId: input.runId,
      parentRunId: input.parentRunId,
      task: input.task,
      allowedCapabilityDomains: input.ceiling.allowedCapabilityDomains,
      loadedToolIds: input.ceiling.allowedToolIds,
      discoverableCapabilityIds: input.discoverableCapabilityIds,
      forbiddenCapabilityIds: input.ceiling.forbiddenCapabilityIds,
      resourceScopes: input.ceiling.resourceScopes,
      riskCeiling: input.ceiling.riskCeiling,
      immutableContextHash: sha256({
        runId: input.runId,
        parentRunId: input.parentRunId,
        task: input.task,
        ceiling: input.ceiling,
      }),
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(this.packagePath(input.runId)), { recursive: true });
    fs.writeFileSync(this.packagePath(input.runId), JSON.stringify(pkg, null, 2), 'utf-8');
    return pkg;
  }

  readPackage(runId: string): SubAgentContextPackage | null {
    const file = this.packagePath(runId);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as SubAgentContextPackage;
    } catch {
      return null;
    }
  }

  /** Immutability check: a mutated package hash no longer matches the stored one. */
  verifyImmutable(runId: string): boolean {
    const pkg = this.readPackage(runId);
    if (!pkg) return false;
    const recomputed = sha256({
      runId: pkg.runId,
      parentRunId: pkg.parentRunId,
      task: pkg.task,
      ceiling: {
        allowedCapabilityDomains: pkg.allowedCapabilityDomains,
        forbiddenCapabilityIds: pkg.forbiddenCapabilityIds,
        allowedToolIds: pkg.loadedToolIds,
        resourceScopes: pkg.resourceScopes,
        riskCeiling: pkg.riskCeiling,
      },
    });
    return recomputed === pkg.immutableContextHash;
  }

  appendDelta(runId: string, content: string): SubAgentDelta {
    const existing = this.readDeltas(runId);
    const delta: SubAgentDelta = {
      runId,
      appendedAt: new Date().toISOString(),
      content,
      sequence: existing.length + 1,
    };
    fs.mkdirSync(path.dirname(this.deltaPath(runId)), { recursive: true });
    fs.appendFileSync(this.deltaPath(runId), `${JSON.stringify(delta)}\n`, 'utf-8');
    return delta;
  }

  readDeltas(runId: string): SubAgentDelta[] {
    const file = this.deltaPath(runId);
    if (!fs.existsSync(file)) return [];
    const out: SubAgentDelta[] = [];
    for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SubAgentDelta);
      } catch {
        // retain as an opaque marker
      }
    }
    return out;
  }

  capabilityAllowed(runId: string, capabilityId: string, riskLevel: RiskLevel): { allowed: boolean; reason?: string } {
    const pkg = this.readPackage(runId);
    if (!pkg) return { allowed: false, reason: 'context_package_missing' };
    if (pkg.forbiddenCapabilityIds.includes(capabilityId)) {
      return { allowed: false, reason: `capability ${capabilityId} is explicitly forbidden by the parent ceiling` };
    }
    if (RISK_ORDER[riskLevel] > RISK_ORDER[pkg.riskCeiling]) {
      return { allowed: false, reason: `risk ${riskLevel} exceeds ceiling ${pkg.riskCeiling}` };
    }
    const domain = pkg.allowedCapabilityDomains.find(domain => capabilityId.startsWith(`${domain}.`));
    if (!domain) {
      return { allowed: false, reason: `capability ${capabilityId} is outside the allowed capability domains` };
    }
    return { allowed: true };
  }

  /**
   * Combine the immutable package + its deltas into a context text for the
   * SubAgent's own run. The package is never rebuilt per turn; deltas are the
   * only changing part.
   */
  buildContextText(runId: string): string {
    const pkg = this.readPackage(runId);
    if (!pkg) return '';
    const deltas = this.readDeltas(runId);
    return [
      '## SubAgent Context Package (immutable)',
      stableStringify(pkg),
      '## SubAgent Context Deltas',
      deltas.map(delta => `[${delta.sequence}] ${delta.content}`).join('\n'),
    ].join('\n\n');
  }
}
