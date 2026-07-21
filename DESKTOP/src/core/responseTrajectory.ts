import type { AgentEvent } from './agentKernel/types';
import type { ConversationWorkRun, GuideReceiptStatus } from './types';

export interface KernelTrajectoryAudit {
  toolStarts: number;
  toolEnds: number;
  toolReceipts: number;
  failedToolReceipts: number;
  agentEndCount: number;
  complete: boolean;
}

export interface WorkRunTrajectoryAudit {
  runId: string;
  status: ConversationWorkRun['status'];
  finalResponseCount: number;
  terminalEventCount: number;
  guideStatusCounts: Record<GuideReceiptStatus, number>;
  complete: boolean;
}

export function auditKernelTrajectory(events: AgentEvent[]): KernelTrajectoryAudit {
  const toolStarts = events.filter(event => event.type === 'tool_execution_start').length;
  const toolEnds = events.filter(event => event.type === 'tool_execution_end').length;
  const turnEnds = events.filter((event): event is Extract<AgentEvent, { type: 'turn_end' }> => event.type === 'turn_end');
  const receipts = turnEnds.flatMap(event => event.toolResults).filter(message => message.role === 'toolResult');
  const agentEndCount = events.filter(event => event.type === 'agent_end').length;
  return {
    toolStarts,
    toolEnds,
    toolReceipts: receipts.length,
    failedToolReceipts: receipts.filter(message => message.role === 'toolResult' && message.isError).length,
    agentEndCount,
    complete: toolStarts === toolEnds && toolEnds === receipts.length && agentEndCount === 1,
  };
}
export function auditWorkRunTrajectory(run: ConversationWorkRun): WorkRunTrajectoryAudit {
  const finalResponseCount = run.events.filter(event => event.type === 'final_response').length;
  const terminalEventCount = run.events.filter(event => event.type === 'done' || event.type === 'error'
    || (event.type === 'status' && ['interrupted', 'force_interrupted'].includes(String(event.status || '')))).length;
  const guideStatusCounts: Record<GuideReceiptStatus, number> = { accepted: 0, applied: 0, deferred: 0, rejected: 0 };
  for (const guide of run.guides) guideStatusCounts[guide.status] += 1;
  const normallyCompleted = run.status === 'completed';
  return {
    runId: run.runId,
    status: run.status,
    finalResponseCount,
    terminalEventCount,
    guideStatusCounts,
    complete: terminalEventCount === 1 && (normallyCompleted ? finalResponseCount === 1 : finalResponseCount === 0),
  };
}
