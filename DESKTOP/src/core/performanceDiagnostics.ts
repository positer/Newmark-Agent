export type AgentPerformanceStage =
  | 'runtime_acquire'
  | 'context_prepare'
  | 'persistence'
  | 'provider_request'
  | 'first_token'
  | 'tool_execution'
  | 'total';

export interface AgentPerformanceEvent {
  stage: AgentPerformanceStage;
  durationMs: number;
  runtimeKey?: string;
  conversationId?: string;
  detail?: Record<string, string | number | boolean>;
}

let diagnosticSink: ((event: AgentPerformanceEvent) => void) | null = null;

export function setPerformanceDiagnosticSink(sink: ((event: AgentPerformanceEvent) => void) | null): void {
  diagnosticSink = sink;
}

export function performanceDiagnosticsEnabled(): boolean {
  return process.env.NEWMARK_PERFORMANCE_DIAGNOSTICS === '1';
}

export function emitPerformanceEvent(event: AgentPerformanceEvent): void {
  diagnosticSink?.(event);
  if (!performanceDiagnosticsEnabled()) return;
  const safe = {
    type: 'newmark_performance',
    at: new Date().toISOString(),
    ...event,
    durationMs: Math.max(0, Math.round(event.durationMs * 100) / 100),
  };
  console.error(`[NewmarkPerformance] ${JSON.stringify(safe)}`);
}

export function performanceTimer(stage: AgentPerformanceStage, context: Omit<AgentPerformanceEvent, 'stage' | 'durationMs'> = {}): () => number {
  const started = performance.now();
  return () => {
    const durationMs = performance.now() - started;
    emitPerformanceEvent({ stage, durationMs, ...context });
    return durationMs;
  };
}
