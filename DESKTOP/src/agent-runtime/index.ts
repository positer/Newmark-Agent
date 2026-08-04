export * from './agent-run.service';

import { AgentRunService } from './agent-run.service';

/**
 * Crash recovery scan. On application start, running Agent Runs are either
 * taken over (lease expired) or marked 'recovering' so their owners can resume.
 */
export function recoverRunningAgentRuns(service: AgentRunService, options?: { owner?: string }): string[] {
  const active = service.listActive();
  const recovered: string[] = [];
  for (const run of active) {
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') continue;
    if (run.leaseOwner && run.leaseOwner === options?.owner) {
      service.markRecovering(run.id);
      recovered.push(run.id);
      continue;
    }
    if (!run.leaseOwner || (run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) <= Date.now())) {
      service.markRecovering(run.id);
      recovered.push(run.id);
    }
  }
  return recovered;
}
